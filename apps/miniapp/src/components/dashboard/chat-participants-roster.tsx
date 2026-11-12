import { AppIcon as IconoirSprite } from '../ui/app-icon';
import type {
  ChatParticipantItem,
  ChatParticipantRoleFilter,
  ChatParticipantActivityFilter,
} from '@maxim/contracts';

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { describeParticipantViolations } from '../../lib/chat-participants-feed';
import {
  PARTICIPANT_ACTIVITY_OPTIONS,
  describeParticipantActivity,
} from '../../lib/participant-activity';
import { useNativeBackHandler } from '../../lib/native-back';
import { PersonAvatar } from '../ui/person-avatar';
import { Spinner } from '../ui/spinner';
import './chat-participants-roster.css';
import './chat-participants-roster-theme.css';

type ImmunityMode = 'limited' | 'always';
type ChatParticipantImmunityView = Omit<
  NonNullable<ChatParticipantItem['immunity']>,
  'dailyViolationLimit' | 'remainingViolatingMessagesToday'
> & {
  mode?: ImmunityMode | null;
  dailyViolationLimit?: number | null;
  remainingViolatingMessagesToday?: number | null;
};

type ChatParticipantsRosterProps = {
  resetKey?: string;
  items: ChatParticipantItem[];
  search: string;
  rangeLabel: string;
  roleFilter: ChatParticipantRoleFilter;
  activityFilter?: ChatParticipantActivityFilter;
  onActivityFilterChange?: (value: ChatParticipantActivityFilter) => void;
  hasMore: boolean;
  isReloading: boolean;
  isLoadingMore: boolean;
  isSearchPending: boolean;
  updatedAt: number | null;
  onRefresh: () => void;
  error: string | null;
  onSearchChange: (value: string) => void;
  onRoleFilterChange: (value: ChatParticipantRoleFilter) => void;
  onLoadMore: () => void;
  onRetry: () => void;
  onParticipantActivate?: ((item: ChatParticipantItem) => void) | null;
  onCleanupUnavailable?: (() => void) | null;
  isCleanupUnavailableBusy?: boolean;
};

function resolveDisplayName(item: ChatParticipantItem): string {
  const name = item.userDisplayName.trim();
  if (name) {
    return name;
  }

  const username = item.username?.trim() ?? '';
  if (username) {
    return `@${username.replace(/^@+/u, '')}`;
  }

  return item.isBot ? 'Бот MAX' : 'Участник';
}

function resolveInitial(name: string): string {
  const matched = name.match(/[A-Za-zА-Яа-яЁё0-9]/u);
  return matched ? matched[0]!.toUpperCase() : '•';
}

function resolveRoleLabel(item: ChatParticipantItem): string | null {
  if (item.role === 'owner') {
    return 'Владелец';
  }

  if (item.role === 'admin') {
    return 'Админ';
  }

  return null;
}

function resolveRoleTone(item: ChatParticipantItem): 'owner' | 'admin' | 'member' {
  if (item.role === 'owner') {
    return 'owner';
  }

  if (item.role === 'admin') {
    return 'admin';
  }

  return 'member';
}

function resolveRosterHeading(roleFilter: ChatParticipantRoleFilter): string {
  if (roleFilter === 'admins') {
    return 'Администраторы';
  }

  if (roleFilter === 'members') {
    return 'Участники';
  }

  if (roleFilter === 'bots') {
    return 'Боты';
  }

  return 'Все участники';
}

function resolveViolationTone(count: number): 'low' | 'medium' | 'high' {
  if (count >= 4) {
    return 'high';
  }

  if (count >= 2) {
    return 'medium';
  }

  return 'low';
}

function formatViolationCount(count: number): string {
  if (count > 99) {
    return '99+';
  }

  return String(Math.max(0, Math.trunc(count)));
}

function resolveImmunity(item: ChatParticipantItem): ChatParticipantImmunityView | null {
  return item.immunity ? (item.immunity as ChatParticipantImmunityView) : null;
}

function isAlwaysImmunity(immunity: ChatParticipantImmunityView | null): boolean {
  return immunity?.mode === 'always';
}

function parsePositiveInteger(value: number | null | undefined): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return null;
  }

  return Math.max(1, Math.trunc(value));
}

function parseNonNegativeInteger(value: number | null | undefined): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return null;
  }

  return Math.max(0, Math.trunc(value));
}

function formatImmunityValue(immunity: ChatParticipantImmunityView | null): string | null {
  if (!immunity) {
    return null;
  }

  if (isAlwaysImmunity(immunity)) {
    return '∞';
  }

  const remaining = parseNonNegativeInteger(immunity.remainingViolatingMessagesToday);
  const limit = parsePositiveInteger(immunity.dailyViolationLimit);
  if (remaining !== null && limit !== null) {
    return `${formatViolationCount(remaining)}/${formatViolationCount(limit)}`;
  }

  if (limit !== null) {
    return `${formatViolationCount(limit)}/д`;
  }

  return 'Лимит';
}

function describeImmunity(immunity: ChatParticipantImmunityView | null): string | null {
  if (!immunity) {
    return null;
  }

  if (isAlwaysImmunity(immunity)) {
    return 'Защита всегда: без срока и дневного лимита';
  }

  const remaining = parseNonNegativeInteger(immunity.remainingViolatingMessagesToday);
  const limit = parsePositiveInteger(immunity.dailyViolationLimit);
  if (remaining !== null && limit !== null) {
    return `Защита: ${remaining} из ${limit} сообщений с нарушениями осталось на сегодня`;
  }

  if (limit !== null) {
    return `Защита: лимит ${limit} сообщений с нарушениями в день`;
  }

  return 'Защита с дневным лимитом';
}

export function ChatParticipantsRoster({
  resetKey,
  items,
  hasMore,
  isReloading,
  isLoadingMore,
  isSearchPending,
  updatedAt,
  error,
  search,
  rangeLabel,
  roleFilter,
  activityFilter = 'all',
  onActivityFilterChange,
  onSearchChange,
  onRoleFilterChange,
  onLoadMore,
  onRetry,
  onRefresh,
  onParticipantActivate = null,
  onCleanupUnavailable = null,
  isCleanupUnavailableBusy = false,
}: ChatParticipantsRosterProps) {
  const searchId = useId();
  const searchRef = useRef<HTMLInputElement | null>(null);
  const menuRef = useRef<HTMLDetailsElement | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [autoLoadCount, setAutoLoadCount] = useState(0);
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const autoLoadLockRef = useRef(false);
  const isSearching = search.trim().length > 0;
  const isBusy = isReloading || isLoadingMore || isSearchPending;
  const visibleError = isSearchPending ? null : error;
  const isScanning =
    !visibleError && items.length === 0 && (isBusy || (hasMore && autoLoadCount < 3));
  const isEmpty = !visibleError && !isBusy && !hasMore && items.length === 0;
  const hasFilters = isSearching || roleFilter !== 'all' || activityFilter !== 'all';

  const closeMenu = useCallback((restoreFocus = false) => {
    if (menuRef.current) menuRef.current.open = false;
    setMenuOpen(false);
    if (restoreFocus) menuRef.current?.querySelector('summary')?.focus();
  }, []);
  useNativeBackHandler(
    () => {
      closeMenu(true);
      return true;
    },
    { enabled: menuOpen, priority: 620 },
  );
  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      if (
        menuRef.current?.open &&
        event.target instanceof Node &&
        !menuRef.current.contains(event.target)
      )
        closeMenu();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && menuRef.current?.open) {
        event.preventDefault();
        closeMenu(true);
      }
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [closeMenu]);

  useEffect(() => {
    setAutoLoadCount(0);
  }, [search, roleFilter, activityFilter, resetKey]);

  useEffect(() => {
    if (!isLoadingMore) autoLoadLockRef.current = false;
  }, [isLoadingMore, isReloading, search, roleFilter, activityFilter]);

  useEffect(() => {
    if (
      !hasMore ||
      isBusy ||
      visibleError ||
      autoLoadCount >= 3 ||
      typeof IntersectionObserver === 'undefined'
    )
      return;
    const node = sentinelRef.current;
    if (!node) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting) || autoLoadLockRef.current) return;
        autoLoadLockRef.current = true;
        setAutoLoadCount((count) => count + 1);
        onLoadMore();
      },
      { rootMargin: '240px 0px' },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [hasMore, isBusy, visibleError, autoLoadCount, onLoadMore]);

  const roleOptions: Array<{ value: ChatParticipantRoleFilter; label: string }> = [
    { value: 'all', label: 'Все' },
    { value: 'admins', label: 'Админы' },
    { value: 'members', label: 'Участники' },
    { value: 'bots', label: 'Боты' },
  ];
  const clearSearch = () => {
    onSearchChange('');
    searchRef.current?.focus();
  };
  const resetFilters = () => {
    onSearchChange('');
    onRoleFilterChange('all');
    onActivityFilterChange?.('all');
  };
  const resultLabel = isSearchPending
    ? 'Ищем участников...'
    : isReloading
      ? 'Обновляем список...'
      : isLoadingMore
        ? hasFilters
          ? 'Поиск продолжается...'
          : 'Загружаем участников...'
        : `${hasFilters ? 'Найдено' : 'В списке'}: ${items.length}${hasMore ? '+' : ''}`;

  return (
    <section className="participants-roster" aria-label="Список участников">
      <div className="participants-roster__toolbar">
        <div className={`participants-roster__search ${isBusy ? 'is-busy' : ''}`}>
          <label
            htmlFor={searchId}
            className="participants-roster__search-icon"
            title="Поиск участника"
            aria-label="Поиск участника"
          >
            <IconoirSprite variant="iconoir" icon="Search" width={18} height={18} aria-hidden />
          </label>
          <input
            ref={searchRef}
            id={searchId}
            type="text"
            role="searchbox"
            inputMode="search"
            value={search}
            onChange={(event) => onSearchChange(event.target.value)}
            placeholder="Имя или ID"
            aria-label="Поиск участника"
            maxLength={100}
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            enterKeyHint="search"
            onKeyDown={(event) => {
              if (event.key === 'Enter') event.currentTarget.blur();
            }}
          />
          <div className="participants-roster__search-end">
            {search ? (
              <button
                type="button"
                className="participants-roster__icon-button"
                onClick={clearSearch}
                aria-label="Очистить поиск"
                title="Очистить поиск"
              >
                <IconoirSprite variant="iconoir" icon="Xmark" width={18} height={18} aria-hidden />
              </button>
            ) : isBusy ? (
              <Spinner size="sm" label="Загружаем участников" />
            ) : null}
          </div>
        </div>
        <button
          type="button"
          className="participants-roster__icon-button participants-roster__refresh"
          onClick={onRefresh}
          disabled={isBusy}
          aria-label="Обновить участников"
          title="Обновить участников"
        >
          <IconoirSprite variant="iconoir" icon="Refresh" width={20} height={20} aria-hidden />
        </button>
        {onCleanupUnavailable ? (
          <details
            ref={menuRef}
            className="participants-roster__manage"
            onToggle={(event) => setMenuOpen(event.currentTarget.open)}
          >
            <summary aria-label="Управление участниками" title="Управление участниками">
              <IconoirSprite
                variant="iconoir"
                icon="MoreHoriz"
                width={20}
                height={20}
                aria-hidden
              />
            </summary>
            <div className="participants-roster__manage-menu">
              <button
                type="button"
                className="participants-roster__cleanup-button"
                onClick={() => {
                  closeMenu(true);
                  onCleanupUnavailable();
                }}
                disabled={isCleanupUnavailableBusy || isBusy}
              >
                <IconoirSprite
                  variant="iconoir"
                  icon="UserXmark"
                  width={18}
                  height={18}
                  aria-hidden
                />
                <span>{isCleanupUnavailableBusy ? 'Проверяем...' : 'Удалить заблокированных'}</span>
              </button>
            </div>
          </details>
        ) : null}
      </div>

      <div className="participants-roster__scope">
        <div className="participants-roster__filters">
          <label className="participants-roster__role-filter">
            <span>Роль участника</span>
            <select
              aria-label="Роль участника"
              value={roleFilter}
              onChange={(event) =>
                onRoleFilterChange(event.target.value as ChatParticipantRoleFilter)
              }
            >
              {roleOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.value === 'all' ? 'Все роли' : option.label}
                </option>
              ))}
            </select>
          </label>
          {onActivityFilterChange ? (
            <label className="participants-roster__activity-filter">
              <span>Активность в MAX</span>
              <select
                aria-label="Активность в MAX"
                value={activityFilter}
                onChange={(event) =>
                  onActivityFilterChange(event.target.value as ChatParticipantActivityFilter)
                }
              >
                {PARTICIPANT_ACTIVITY_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
        </div>
        <div className="participants-roster__scope-heading">
          <h2>{resolveRosterHeading(roleFilter)}</h2>
          <p>Нарушения {rangeLabel}</p>
        </div>
        <div
          className="participants-roster__results"
          role="status"
          aria-live="polite"
          aria-atomic="true"
        >
          <span>
            {visibleError
              ? items.length
                ? 'Список не обновлён'
                : 'Список недоступен'
              : resultLabel}
          </span>
          {updatedAt && !isBusy && !visibleError ? (
            <time dateTime={new Date(updatedAt).toISOString()}>
              Обновлено{' '}
              {new Date(updatedAt).toLocaleTimeString('ru-RU', {
                hour: '2-digit',
                minute: '2-digit',
              })}
            </time>
          ) : null}
        </div>
      </div>

      {visibleError ? (
        <div
          className="participants-roster__status participants-roster__status--error"
          role="alert"
        >
          <IconoirSprite
            variant="iconoir"
            icon="WarningCircle"
            width={22}
            height={22}
            aria-hidden
          />
          <div>
            <strong>Не удалось загрузить участников</strong>
            <p>{visibleError}</p>
          </div>
          <button
            type="button"
            className="button button--ghost"
            onClick={onRetry}
            disabled={isBusy}
          >
            <IconoirSprite variant="iconoir" icon="Refresh" width={18} height={18} aria-hidden />{' '}
            Повторить
          </button>
        </div>
      ) : null}

      {isScanning ? (
        <div
          className="participants-roster__status participants-roster__status--search"
          role="status"
        >
          <Spinner size="sm" label={hasFilters ? 'Ищем участников' : 'Загружаем участников'} />
          <p>{hasFilters ? 'Ищем участников...' : 'Загружаем участников...'}</p>
        </div>
      ) : null}

      {isEmpty ? (
        <div className="participants-roster__status participants-roster__status--empty">
          <IconoirSprite variant="iconoir" icon="Search" width={28} height={28} aria-hidden />
          <strong>{hasFilters ? 'Участники не найдены' : 'Нет доступных участников'}</strong>
          {isSearching ? <p>По запросу «{search.trim()}»</p> : null}
          {hasFilters ? (
            <button type="button" className="button button--ghost" onClick={resetFilters}>
              <IconoirSprite variant="iconoir" icon="Xmark" width={18} height={18} aria-hidden />{' '}
              Сбросить фильтры
            </button>
          ) : null}
        </div>
      ) : null}

      {items.length > 0 ? (
        <div className="participants-roster__list" aria-busy={isReloading || isSearchPending}>
          {items.map((item) => {
            const displayName = resolveDisplayName(item);
            const username = item.username?.replace(/^@+/u, '').trim() ?? '';
            const canOpenDetails =
              item.userId.trim().length > 0 && typeof onParticipantActivate === 'function';
            const roleLabel = resolveRoleLabel(item);
            const violationCount = Number.isFinite(item.violationCount)
              ? Math.max(0, Math.trunc(item.violationCount))
              : 0;
            const immunity = resolveImmunity(item);
            const immunityValue = formatImmunityValue(immunity);
            const immunityDescription = describeImmunity(immunity);
            const activity = describeParticipantActivity(item);
            const itemBody = (
              <>
                <div
                  className={`participants-roster__avatar-shell ${immunity ? 'participants-roster__avatar-shell--immune' : ''}`}
                >
                  <PersonAvatar
                    avatarUrl={item.avatarUrl?.trim() || null}
                    fallback={resolveInitial(displayName)}
                    className="participants-roster__avatar"
                  />
                </div>
                <div className="participants-roster__content">
                  <div className="participants-roster__identity">
                    <strong>{displayName}</strong>
                    <span>{username ? `@${username}` : `ID ${item.userId}`}</span>
                  </div>
                  <div className="participants-roster__meta">
                    {!item.isBot ? (
                      <span
                        className={`participants-roster__activity participants-roster__activity--${activity.tone}`}
                        title={activity.detail}
                        aria-label={activity.detail}
                      >
                        <IconoirSprite
                          variant="iconoir"
                          icon="Clock"
                          width={13}
                          height={13}
                          aria-hidden
                        />
                        {activity.label}
                      </span>
                    ) : null}
                    {roleLabel ? (
                      <span
                        className={`participants-roster__pill participants-roster__pill--${resolveRoleTone(item)}`}
                      >
                        {roleLabel}
                      </span>
                    ) : null}
                    {item.isBot ? (
                      <span className="participants-roster__pill participants-roster__pill--bot">
                        Бот
                      </span>
                    ) : null}
                    {immunity && immunityValue ? (
                      <span
                        className={`participants-roster__immunity ${isAlwaysImmunity(immunity) ? 'participants-roster__immunity--always' : ''}`}
                        role="img"
                        aria-label={immunityDescription ?? undefined}
                        title={immunityDescription ?? undefined}
                      >
                        <IconoirSprite
                          variant="iconoir"
                          icon="ShieldCheck"
                          width={14}
                          height={14}
                          aria-hidden
                        />
                        <span aria-hidden="true">
                          {isAlwaysImmunity(immunity) ? 'Всегда' : immunityValue}
                        </span>
                      </span>
                    ) : null}
                  </div>
                </div>
                <div className="participants-roster__aside">
                  <span
                    className={`participants-roster__violations participants-roster__violations--${violationCount ? resolveViolationTone(violationCount) : 'none'}`}
                    role="img"
                    aria-label={describeParticipantViolations(violationCount)}
                    title={describeParticipantViolations(violationCount)}
                  >
                    <span aria-hidden="true">{formatViolationCount(violationCount)}</span>
                  </span>
                  {canOpenDetails ? (
                    <IconoirSprite
                      variant="iconoir"
                      icon="NavArrowRight"
                      className="participants-roster__chevron"
                      width={16}
                      height={16}
                      aria-hidden
                    />
                  ) : null}
                </div>
              </>
            );
            return canOpenDetails ? (
              <button
                key={item.userId}
                type="button"
                className="participants-roster__item participants-roster__item--interactive"
                disabled={isSearchPending || isReloading}
                onClick={() => onParticipantActivate?.(item)}
              >
                {itemBody}
              </button>
            ) : (
              <article key={item.userId} className="participants-roster__item">
                {itemBody}
              </article>
            );
          })}
        </div>
      ) : null}

      <div ref={sentinelRef} className="participants-roster__sentinel" aria-hidden="true" />
      {hasMore && !visibleError ? (
        <button
          type="button"
          className="button button--ghost participants-roster__load-more"
          onClick={() => {
            setAutoLoadCount(0);
            onLoadMore();
          }}
          disabled={isBusy}
        >
          {isLoadingMore ? 'Загружаем...' : hasFilters ? 'Продолжить поиск' : 'Показать ещё'}
        </button>
      ) : null}
    </section>
  );
}
