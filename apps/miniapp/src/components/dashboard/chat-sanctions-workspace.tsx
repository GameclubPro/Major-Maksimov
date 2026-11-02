import { AppIcon as IconoirSprite } from '../ui/app-icon';
import type { ChatSanctionItem, ChatSanctionsQuery } from '@maxim/contracts';
import { isMaxMemberRestoreAvailable } from '@maxim/contracts/max-capabilities';
import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useEffectEvent, useMemo, useRef, useState } from 'react';

import type { ApiTransport } from '../../lib/api/transport';
import { getChatSanctions } from '../../lib/api/chat-sanctions-client';
import { describeUserFacingError } from '../../lib/user-facing-error';
import {
  formatSanctionRemaining,
  sanctionTimeProgress,
  SANCTION_STATUS_LABELS,
  createSanctionClock,
  readSanctionClock,
  sanctionStatusAt,
  nextSanctionExpiry,
} from '../../lib/sanction-display';
import { ActionConfirmSheet } from '../ui/action-confirm-sheet';
import { SettingsDrilldownPanel } from '../ui/settings-drilldown-panel';
import { PersonAvatar } from '../ui/person-avatar';
import { Spinner } from '../ui/spinner';
import { Skeleton } from '../ui/skeleton';
import { useToast } from '../ui/toast';
import './chat-sanctions-workspace.css';
import '../../pages/statistics-sanctions-steel.css';

type Props = {
  api: ApiTransport;
  chatId: string;
  chatTitle: string;
  initialUserId?: string | null;
  lockedUserId?: string;
  onParticipantActivate?: (item: ChatSanctionItem) => void;
  onProfileActivate: (userId: string, displayName: string) => void;
  onChanged: () => void;
  onRelease: (item: ChatSanctionItem) => Promise<string>;
  describeReason: (item: ChatSanctionItem) => string;
  isOpeningProfile?: boolean;
};

const viewTitles: Record<ChatSanctionsQuery['status'], string> = {
  active: 'Действующие',
  archive: 'Архив',
  review: 'На проверке',
  all: 'Все ограничения',
};

function formatDate(value: string): string {
  return new Date(value).toLocaleString('ru-RU', { dateStyle: 'medium', timeStyle: 'short' });
}

export function ChatSanctionsWorkspace({
  api,
  chatId,
  chatTitle,
  initialUserId,
  lockedUserId,
  onParticipantActivate,
  onProfileActivate,
  onChanged,
  onRelease,
  describeReason,
  isOpeningProfile = false,
}: Props) {
  const queryClient = useQueryClient();
  const { pushToast } = useToast();
  const [status, setStatus] = useState<ChatSanctionsQuery['status']>(
    initialUserId ? 'all' : 'active',
  );
  const [action, setAction] = useState<ChatSanctionsQuery['action']>('all');
  const [userId, setUserId] = useState(initialUserId ?? '');
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [selected, setSelected] = useState<ChatSanctionItem | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [clock, setClock] = useState(performance.now());
  const [refreshedThrough, setRefreshedThrough] = useState(0);
  const releaseLock = useRef(false);
  const pendingSearch = search.trim() !== debouncedSearch;
  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedSearch(search.trim()), 350);
    return () => window.clearTimeout(timer);
  }, [search]);
  const feed = useInfiniteQuery({
    queryKey: ['chat-sanctions', chatId, status, action, debouncedSearch, lockedUserId ?? userId],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) =>
      getChatSanctions(
        api,
        chatId,
        {
          status,
          action,
          search: debouncedSearch || undefined,
          userId: lockedUserId ?? (userId || undefined),
          limit: 30,
          cursor: pageParam,
        },
        signal,
      ),
    getNextPageParam: (page) => (page.hasMore ? (page.nextCursor ?? undefined) : undefined),
    staleTime: 15_000,
    refetchOnWindowFocus: true,
    refetchOnMount: 'always',
  });
  const items = useMemo(
    () => [
      ...new Map(
        (feed.data?.pages.flatMap((page) => page.items) ?? []).map((item) => [item.id, item]),
      ).values(),
    ],
    [feed.data],
  );
  const lastPage = feed.data?.pages.at(-1);
  const clockSource = useMemo(
    () =>
      createSanctionClock(lastPage?.serverTime, feed.dataUpdatedAt, Date.now(), performance.now()),
    [lastPage?.serverTime, feed.dataUpdatedAt],
  );
  const nowMs = readSanctionClock(clockSource, clock);
  const refresh = useEffectEvent(() => {
    void feed.refetch();
  });
  useEffect(() => {
    const tick = () => {
      if (document.visibilityState !== 'hidden') setClock(performance.now());
    };
    const visible = () => {
      if (document.visibilityState !== 'hidden') {
        tick();
        refresh();
      }
    };
    const interval = window.setInterval(tick, 1000);
    document.addEventListener('visibilitychange', visible);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener('visibilitychange', visible);
    };
  }, []);
  useEffect(() => {
    if (
      !feed.isFetching &&
      !feed.error &&
      items.length === 0 &&
      feed.hasNextPage &&
      (feed.data?.pages.length ?? 0) < 3
    )
      void feed.fetchNextPage();
  }, [
    feed.isFetching,
    feed.error,
    feed.hasNextPage,
    feed.data?.pages.length,
    items.length,
    feed.fetchNextPage,
  ]);
  const nextExpiry = useMemo(
    () => nextSanctionExpiry(items, refreshedThrough),
    [items, refreshedThrough],
  );
  useEffect(() => {
    if (!nextExpiry) return;
    const timer = window.setTimeout(
      () => {
        setRefreshedThrough(
          Math.max(nextExpiry, readSanctionClock(clockSource, performance.now())),
        );
        if (document.visibilityState !== 'hidden') refresh();
      },
      Math.min(
        2_147_483_647,
        Math.max(0, nextExpiry - readSanctionClock(clockSource, performance.now())) + 100,
      ),
    );
    return () => window.clearTimeout(timer);
  }, [nextExpiry, clockSource]);

  const release = useMutation({
    retry: false,
    mutationFn: async (item: ChatSanctionItem) => {
      if (!item.releaseAction)
        throw new Error('Состояние ограничения изменилось. Обновите список.');
      return onRelease(item);
    },
    onSuccess: (result) => {
      setConfirmOpen(false);
      setSelected(null);
      pushToast({ tone: 'success', title: result });
      void queryClient.invalidateQueries({ queryKey: ['chat-sanctions', chatId] });
      onChanged();
    },
    onSettled: () => {
      releaseLock.current = false;
    },
  });
  const busy = feed.isFetching || pendingSearch;
  const hasFilters = Boolean(search || userId || action !== 'all' || status !== 'active');
  const resetFilters = () => {
    setSearch('');
    setUserId('');
    setAction('all');
    setStatus('active');
  };
  const selectedProgress = selected ? sanctionTimeProgress(selected, nowMs) : null;
  const selectedStatus = selected ? sanctionStatusAt(selected, nowMs) : null;
  const releaseAvailable = Boolean(
    selected?.releaseAction &&
    selected.status === 'active' &&
    (selected.permanent || (selected.expiresAt && Date.parse(selected.expiresAt) > nowMs)),
  );
  const selectedNeedsMaxCheck =
    selected?.action === 'BAN' && !selected.banOnRejoin && !isMaxMemberRestoreAvailable();
  const closeDetails = () => {
    if (!release.isPending && !confirmOpen && !isOpeningProfile) setSelected(null);
  };
  const detailActions = selected ? (
    <div className="sanction-details__actions">
      <div className="sanction-details__secondary-actions">
        <button
          type="button"
          className="button button--ghost"
          disabled={release.isPending || isOpeningProfile}
          onClick={() =>
            onParticipantActivate
              ? onParticipantActivate(selected)
              : onProfileActivate(selected.userId, selected.userDisplayName)
          }
        >
          {isOpeningProfile ? (
            <Spinner size="sm" label={null} />
          ) : (
            <IconoirSprite variant="iconoir" icon="UserCircle" width={20} height={20} aria-hidden />
          )}
          {isOpeningProfile ? 'Открываем...' : onParticipantActivate ? 'Участник' : 'Профиль в MAX'}
        </button>
        <button
          type="button"
          className="button button--ghost"
          aria-label="История участника"
          disabled={release.isPending || isOpeningProfile}
          onClick={() => {
            setUserId(selected.userId);
            setSearch('');
            setStatus('all');
            setSelected(null);
          }}
        >
          <IconoirSprite variant="iconoir" icon="Clock" width={20} height={20} aria-hidden />
          История
        </button>
      </div>
      {releaseAvailable ? (
        <button
          type="button"
          className="button button--accent"
          disabled={release.isPending || isOpeningProfile}
          onClick={() => {
            release.reset();
            setConfirmOpen(true);
          }}
        >
          <IconoirSprite variant="iconoir" icon="ShieldCheck" width={20} height={20} aria-hidden />
          {selected.action === 'BAN'
            ? selected.banOnRejoin || isMaxMemberRestoreAvailable()
              ? 'Снять бан'
              : 'Проверить снятие в MAX'
            : 'Снять мут'}
        </button>
      ) : null}
    </div>
  ) : undefined;

  return (
    <section className="sanctions-workspace" aria-label="Ограничения участников">
      <div className="sanctions-workspace__toolbar">
        <label className="sanctions-workspace__search">
          <IconoirSprite variant="iconoir" icon="Search" width={19} height={19} aria-hidden />
          <input
            aria-label="Поиск ограничений"
            type="search"
            placeholder="Имя или ID"
            maxLength={100}
            enterKeyHint="search"
            onKeyDown={(event) => {
              if (event.key === 'Enter') event.currentTarget.blur();
            }}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
          {search ? (
            <button
              type="button"
              title="Очистить поиск"
              aria-label="Очистить поиск"
              onClick={() => setSearch('')}
            >
              <IconoirSprite variant="iconoir" icon="Xmark" width={20} height={20} aria-hidden />
            </button>
          ) : null}
        </label>
        <button
          className="sanctions-workspace__icon-button"
          type="button"
          title="Обновить ограничения"
          aria-label="Обновить ограничения"
          disabled={busy}
          onClick={() => void feed.refetch()}
        >
          <IconoirSprite variant="iconoir" icon="Refresh" width={21} height={21} aria-hidden />
        </button>
      </div>
      <div className="sanctions-workspace__filters">
        <label>
          <span>Состояние</span>
          <select
            aria-label="Состояние ограничения"
            value={status}
            onChange={(event) => setStatus(event.target.value as ChatSanctionsQuery['status'])}
          >
            <option value="active">Действуют</option>
            <option value="archive">Архив</option>
            <option value="review">Проверка</option>
            <option value="all">Все</option>
          </select>
        </label>
        <label>
          <span>Тип</span>
          <select
            aria-label="Тип ограничения"
            value={action}
            onChange={(event) => setAction(event.target.value as ChatSanctionsQuery['action'])}
          >
            <option value="all">Все типы</option>
            <option value="MUTE">Мут</option>
            <option value="BAN">Бан</option>
          </select>
        </label>
      </div>
      {userId && !lockedUserId ? (
        <div className="sanctions-workspace__user-filter">
          <span>ID {userId}</span>
          <button
            type="button"
            title="Все участники"
            aria-label="Все участники"
            onClick={() => setUserId('')}
          >
            <IconoirSprite variant="iconoir" icon="Xmark" width={20} height={20} aria-hidden />
          </button>
        </div>
      ) : null}
      <div className="sanctions-workspace__heading">
        <div>
          <h2>{search.trim() ? 'Результаты' : userId ? 'История' : viewTitles[status]}</h2>
          <span
            className="sanctions-workspace__count"
            role="status"
            aria-label={
              feed.isPending || pendingSearch
                ? 'Загружаем ограничения'
                : `В списке: ${items.length}${feed.hasNextPage ? '+' : ''}`
            }
          >
            {feed.isPending || pendingSearch
              ? '...'
              : `${items.length}${feed.hasNextPage ? '+' : ''}`}
          </span>
        </div>
        {lastPage && !busy ? (
          <time dateTime={lastPage.serverTime} title="Последнее обновление">
            {new Date(lastPage.serverTime).toLocaleTimeString('ru-RU', {
              hour: '2-digit',
              minute: '2-digit',
            })}
          </time>
        ) : null}
      </div>
      {feed.error ? (
        <div className="sanctions-workspace__notice" role="alert">
          <p>{describeUserFacingError(feed.error, 'Не удалось загрузить ограничения.')}</p>
          <button
            type="button"
            className="button button--ghost"
            onClick={() => void (feed.isFetchNextPageError ? feed.fetchNextPage() : feed.refetch())}
            disabled={busy}
          >
            <IconoirSprite variant="iconoir" icon="Refresh" width={18} height={18} aria-hidden />
            Повторить
          </button>
        </div>
      ) : null}
      {feed.isPending || pendingSearch ? (
        <div
          className="sanctions-workspace__loading"
          role="status"
          aria-label="Загружаем ограничения"
        >
          {[0, 1, 2].map((index) => (
            <div key={index} className="sanctions-workspace__skeleton">
              <Skeleton className="sanctions-workspace__skeleton-avatar" />
              <div>
                <Skeleton />
                <Skeleton />
                <Skeleton />
              </div>
            </div>
          ))}
        </div>
      ) : null}
      {!feed.isPending && !pendingSearch && !feed.error && items.length === 0 ? (
        <div className="sanctions-workspace__empty">
          <span className="sanctions-workspace__empty-icon">
            {hasFilters ? (
              <IconoirSprite variant="iconoir" icon="Search" width={28} height={28} aria-hidden />
            ) : (
              <IconoirSprite
                variant="iconoir"
                icon="ShieldCheck"
                width={28}
                height={28}
                aria-hidden
              />
            )}
          </span>
          <strong>
            {feed.hasNextPage
              ? 'Поиск по истории продолжается'
              : hasFilters
                ? 'Ограничений не найдено'
                : 'Действующих ограничений нет'}
          </strong>
          {hasFilters && !feed.hasNextPage ? (
            <button type="button" className="button button--ghost" onClick={resetFilters}>
              <IconoirSprite variant="iconoir" icon="Xmark" width={18} height={18} aria-hidden />
              Сбросить фильтры
            </button>
          ) : null}
        </div>
      ) : null}
      {!pendingSearch ? (
        <div className="sanctions-workspace__list" aria-busy={feed.isFetching}>
          {items.map((item) => (
            <article
              key={item.id}
              className="sanctions-workspace__row"
              data-status={sanctionStatusAt(item, nowMs)}
            >
              <button
                type="button"
                className="sanctions-workspace__person"
                aria-label={
                  onParticipantActivate
                    ? `Открыть участника ${item.userDisplayName}`
                    : `Открыть ограничение ${item.userDisplayName}`
                }
                disabled={feed.isRefetching}
                onClick={() => {
                  if (onParticipantActivate) onParticipantActivate(item);
                  else {
                    release.reset();
                    setSelected(item);
                  }
                }}
              >
                <PersonAvatar
                  avatarUrl={item.avatarUrl}
                  fallback={item.userDisplayName.slice(0, 1)}
                  className="sanctions-workspace__avatar"
                />
                <span className="sanctions-workspace__identity">
                  <strong>{item.userDisplayName}</strong>
                  <span>{describeReason(item)}</span>
                  <small>
                    {item.operator === 'ADMIN' ? 'Админ' : 'Бот'} ·{' '}
                    {new Date(item.createdAt).toLocaleDateString('ru-RU')}
                  </small>
                </span>
              </button>
              <button
                type="button"
                className="sanctions-workspace__details-trigger"
                aria-label={`Открыть ограничение ${item.userDisplayName}`}
                disabled={feed.isRefetching}
                onClick={() => {
                  release.reset();
                  setSelected(item);
                }}
              >
                <span
                  className={`sanctions-workspace__state sanctions-workspace__state--${item.action === 'BAN' ? 'ban' : 'mute'}`}
                >
                  <span>
                    {item.action === 'BAN' ? (
                      <IconoirSprite
                        variant="iconoir"
                        icon="Prohibition"
                        width={15}
                        height={15}
                        aria-hidden
                      />
                    ) : (
                      <IconoirSprite
                        variant="iconoir"
                        icon="SoundOff"
                        width={15}
                        height={15}
                        aria-hidden
                      />
                    )}
                    {item.action === 'BAN' ? 'Бан' : 'Мут'}
                  </span>
                  <strong className="sanctions-workspace__timer">
                    {formatSanctionRemaining(item, nowMs)}
                  </strong>
                  {item.status === 'active' && !item.permanent && item.expiresAt ? (
                    <progress
                      className="sanctions-workspace__progress"
                      max={1}
                      value={sanctionTimeProgress(item, nowMs) ?? 0}
                      aria-hidden
                    />
                  ) : null}
                </span>
                <IconoirSprite
                  variant="iconoir"
                  icon="NavArrowRight"
                  className="sanctions-workspace__arrow"
                  width={18}
                  height={18}
                  aria-hidden
                />
              </button>
            </article>
          ))}
        </div>
      ) : null}
      {feed.hasNextPage && !pendingSearch ? (
        <button
          type="button"
          className="button button--ghost sanctions-workspace__more"
          onClick={() => void feed.fetchNextPage()}
          disabled={feed.isFetching}
        >
          {feed.isFetchingNextPage
            ? 'Загружаем...'
            : items.length
              ? 'Показать ещё'
              : 'Продолжить поиск'}
        </button>
      ) : null}

      <SettingsDrilldownPanel
        id="sanction-details"
        open={Boolean(selected)}
        title={selected?.userDisplayName ?? 'Ограничение'}
        summary={chatTitle}
        onClose={closeDetails}
        className="sanction-details"
        footer={detailActions}
        keepFooterVisibleWhenKeyboardOpen
      >
        {selected ? (
          <>
            <div
              className={`sanction-details__status sanction-details__status--${selected.action === 'BAN' ? 'ban' : 'mute'}`}
            >
              <div className="sanction-details__identity">
                <PersonAvatar
                  avatarUrl={selected.avatarUrl}
                  fallback={selected.userDisplayName.slice(0, 1)}
                  className="sanction-details__avatar"
                />
                <div>
                  <span>{selected.action === 'BAN' ? 'Бан' : 'Мут'}</span>
                  <small>
                    {selectedStatus === 'active'
                      ? selected.permanent
                        ? 'Срок'
                        : 'Осталось'
                      : 'Состояние'}
                  </small>
                </div>
              </div>
              <strong>{formatSanctionRemaining(selected, nowMs)}</strong>
              {selectedProgress !== null ? (
                <progress
                  max={1}
                  value={selectedProgress}
                  aria-label="Оставшийся срок ограничения"
                />
              ) : null}
            </div>
            <h3 className="sanction-details__label">Причина</h3>
            <p className="sanction-details__reason">{describeReason(selected)}</p>
            <dl className="sanction-details__facts">
              <div>
                <dt>Состояние</dt>
                <dd>{SANCTION_STATUS_LABELS[selectedStatus ?? selected.status]}</dd>
              </div>
              <div>
                <dt>Назначено</dt>
                <dd>{formatDate(selected.createdAt)}</dd>
              </div>
              {selected.expiresAt ? (
                <div>
                  <dt>Окончание</dt>
                  <dd>{formatDate(selected.expiresAt)}</dd>
                </div>
              ) : null}
              {selected.endedAt ? (
                <div>
                  <dt>Завершено</dt>
                  <dd>{formatDate(selected.endedAt)}</dd>
                </div>
              ) : null}
              <div>
                <dt>Инициатор</dt>
                <dd>
                  {selected.actorDisplayName ??
                    (selected.operator === 'ADMIN' ? 'Администратор' : 'Автомодерация')}
                </dd>
              </div>
              <div>
                <dt>Участник</dt>
                <dd>ID {selected.userId}</dd>
              </div>
            </dl>
          </>
        ) : null}
      </SettingsDrilldownPanel>
      <ActionConfirmSheet
        id="sanction-release"
        open={confirmOpen && Boolean(selected)}
        title={
          selected?.action === 'BAN'
            ? !selectedNeedsMaxCheck
              ? 'Снять бан?'
              : 'Проверить снятие в MAX?'
            : 'Снять мут?'
        }
        summary={selected?.userDisplayName}
        previewTitle={chatTitle}
        previewMeta={
          release.error ? (
            <span role="alert">
              {describeUserFacingError(release.error, 'Не удалось снять ограничение.')}
            </span>
          ) : selectedNeedsMaxCheck ? (
            'Снимите блокировку вручную в MAX. Проверка подтвердит возвращение участника в чат.'
          ) : selected ? (
            `Назначено ${formatDate(selected.createdAt)}`
          ) : undefined
        }
        confirmLabel={
          selectedNeedsMaxCheck
            ? 'Проверить'
            : selected?.action === 'BAN'
              ? 'Снять бан'
              : 'Снять мут'
        }
        confirmDisabled={!releaseAvailable}
        confirmBusyLabel={selectedNeedsMaxCheck ? 'Проверяем...' : 'Снимаем...'}
        tone="accent"
        isBusy={release.isPending}
        onClose={() => {
          if (!release.isPending) setConfirmOpen(false);
        }}
        onConfirm={() => {
          if (selected && releaseAvailable && !releaseLock.current && !release.isPending) {
            releaseLock.current = true;
            release.mutate(selected);
          }
        }}
      />
    </section>
  );
}
