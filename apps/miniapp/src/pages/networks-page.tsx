import { Suspense, lazy, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useLocation, useNavigate } from 'react-router';
import type { ManagedEntityNetworkCard, ManagedEntityType } from '@maxim/contracts';
import type { ApiTransport } from '../lib/api/transport';
import { AppIcon } from '../components/ui/app-icon';
import { SegmentedControl } from '../components/ui/segmented-control';
import { Spinner } from '../components/ui/spinner';
import { EntityAvatar } from '../components/ui/entity-avatar';
import { SearchField } from '../components/ui/search-field';
import { useHomeEntityFavorites } from '../lib/home-entity-favorites-context';
import { useHomeEntityNetworkCatalogue } from '../lib/home-entity-networks-context';
import { useNativeBackHandler } from '../lib/native-back';
import {
  createManagedEntityWorkspaceState,
  buildManagedEntityStatisticsRoute,
} from '../lib/managed-entity-workspace';
import {
  networkStatisticsQueryKey,
  useNetworkStatistics,
} from '../features/networks/network-statistics';
import {
  NETWORK_ENTITY_SEARCH_MAX_LENGTH,
  useNetworkEntries,
} from '../features/networks/network-community-list';
import {
  buildNetworkRoute,
  captureNetworkListPosition,
  readNetworkListPosition,
  readNetworkRoute,
  saveNetworkListPosition,
  readNetworkViewPreference,
  saveNetworkViewPreference,
  type NetworkRouteState,
} from '../features/networks/network-route-state';
import {
  NetworkWorkspaceHeader,
  NetworkWorkspaceTabs,
} from '../features/networks/network-workspace-header';
import { NetworkCategoryIcon } from '../features/networks/network-identity';
import '../styles/moderation-catalogue-palette.css';
import '../styles/moderation-catalogue-steel.css';
import './networks-page.css';

const NetworkOperationHistory = lazy(async () => ({
  default: (await import('../features/networks/network-operation-history')).NetworkOperationHistory,
}));
const NetworkStatisticsView = lazy(async () => ({
  default: (await import('../features/networks/network-statistics-view')).NetworkStatisticsView,
}));
const NetworkCompositionSheet = lazy(async () => ({
  default: (await import('../features/networks/network-composition-sheet')).NetworkCompositionSheet,
}));
const compactNumber = new Intl.NumberFormat('ru-RU', {
  notation: 'compact',
  maximumFractionDigits: 1,
});
const fullNumber = new Intl.NumberFormat('ru-RU');
const countForms = new Intl.PluralRules('ru-RU');
function formatEntityCount(count: number, type: ManagedEntityType): string {
  const form = countForms.select(count);
  const noun =
    type === 'chat'
      ? form === 'one'
        ? 'чат'
        : form === 'few'
          ? 'чата'
          : 'чатов'
      : form === 'one'
        ? 'канал'
        : form === 'few'
          ? 'канала'
          : 'каналов';
  return `${fullNumber.format(count)} ${noun}`;
}
function Metric({
  label,
  value,
  growth = false,
}: {
  label: string;
  value: number | null | undefined;
  growth?: boolean;
}) {
  const formatted =
    value == null ? '—' : `${growth && value > 0 ? '+' : ''}${compactNumber.format(value)}`;
  return (
    <div className="network-card-metric">
      <span>{label}</span>
      <strong
        className={
          growth && value != null && value !== 0
            ? value > 0
              ? 'is-positive'
              : 'is-negative'
            : undefined
        }
        title={value == null ? 'Нет подтверждённых данных' : fullNumber.format(value)}
      >
        {formatted}
      </strong>
    </div>
  );
}
function SummaryCard({
  api,
  scopeKey,
  type,
  card,
  range,
  stale,
  onOpen,
  onSettings,
  onRefresh,
}: {
  api: ApiTransport;
  scopeKey: string;
  type: ManagedEntityType;
  card: ManagedEntityNetworkCard;
  range: NetworkRouteState['range'];
  stale: boolean;
  onOpen: () => void;
  onSettings: () => void;
  onRefresh: () => Promise<void>;
}) {
  const cardRef = useRef<HTMLElement>(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (!cardRef.current) return;
    if (typeof IntersectionObserver === 'undefined') {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting), {
      rootMargin: '100px',
    });
    observer.observe(cardRef.current);
    return () => observer.disconnect();
  }, []);
  const stats = useNetworkStatistics({
    api,
    scopeKey,
    entityType: type,
    favoriteType: card.favoriteType,
    range,
    compositionVersion: card.compositionVersion,
    enabled: visible && !stale && card.entityCount > 0,
    onScopeInvalidated: () => {
      void onRefresh().catch(() => undefined);
    },
  });
  return (
    <article
      ref={cardRef}
      className="network-summary-card"
      data-network-category={card.favoriteType}
    >
      <div className="network-summary-card__body">
        <div className="network-summary-card__head">
          <h2>
            <button type="button" className="network-card-title-button" onClick={onOpen}>
              <span className="network-category-icon">
                <NetworkCategoryIcon favoriteType={card.favoriteType} />
              </span>
              <span className="network-summary-card__identity">
                <strong>{card.label}</strong>
                <small>{formatEntityCount(card.entityCount, type)}</small>
              </span>
              <AppIcon icon="NavArrowRight" className="network-card-chevron" />
            </button>
          </h2>
        </div>
        <div className="network-summary-card__metrics">
          <Metric
            label={type === 'chat' ? 'Участники' : 'Подписчики'}
            value={stale ? null : stats.data?.audience.value}
          />
          <Metric
            label={`Прирост · ${range === '7d' ? 7 : 30} дн.`}
            value={stale ? null : stats.data?.netGrowth.value}
            growth
          />
        </div>
        {stats.phase !== 'settled' ||
        stats.data?.audience.coverage.status !== 'ready' ||
        stats.data?.netGrowth.coverage.status !== 'ready' ? (
          <p className="network-summary-card__status" role="status">
            {stale
              ? 'Состав сетки нужно обновить'
              : stats.phase === 'checking'
                ? 'Проверяем доступ…'
                : stats.phase === 'loading' || stats.phase === 'idle'
                  ? 'Загружаем данные…'
                  : stats.phase === 'error' || stats.phase === 'stale'
                    ? (stats.error?.message ?? 'Не удалось загрузить статистику')
                    : stats.data?.audience.coverage.status !== 'ready' ||
                        stats.data?.netGrowth.coverage.status !== 'ready'
                      ? stats.data?.audience.coverage.includedEntities !== card.entityCount
                        ? `Аудитория по ${stats.data?.audience.coverage.includedEntities ?? 0} из ${card.entityCount}`
                        : 'История прироста может быть неполной'
                      : null}
          </p>
        ) : null}
      </div>
      <div className="network-summary-card__actions">
        <button type="button" className="networks-secondary" disabled={stale} onClick={onSettings}>
          <AppIcon icon="Settings" />
          Настройки
        </button>
        <button
          type="button"
          className="networks-secondary network-summary-card__open"
          onClick={onOpen}
        >
          <AppIcon icon="StatsUpSquare" />
          Статистика
        </button>
      </div>
      {(stats.phase === 'error' || stats.phase === 'stale') && stats.error?.retryable !== false ? (
        <button type="button" className="networks-text-button" onClick={stats.refresh}>
          Обновить сводку
        </button>
      ) : null}
    </article>
  );
}

function NetworkDetail({
  api,
  state,
  card,
  stale,
  onRoute,
  refresh,
  onSettings,
}: {
  api: ApiTransport;
  state: NetworkRouteState;
  card: ManagedEntityNetworkCard;
  stale: boolean;
  onRoute: (next: NetworkRouteState) => void;
  refresh: () => Promise<void>;
  onSettings: (pageCount: number) => void;
}) {
  const { snapshot } = useHomeEntityFavorites();
  const navigate = useNavigate();
  const location = useLocation();
  const [compositionOpen, setCompositionOpen] = useState<'members' | 'add' | null>(null);
  const searchKey = `members:${state.entityType}:${state.favoriteType}`;
  const [memberQuery, setMemberQuery] = useState(() =>
    readNetworkViewPreference(snapshot.actor.scope, searchKey).slice(
      0,
      NETWORK_ENTITY_SEARCH_MAX_LENGTH,
    ),
  );
  const [memberSearch, setMemberSearch] = useState(memberQuery);
  useEffect(
    () => saveNetworkViewPreference(snapshot.actor.scope, searchKey, memberQuery),
    [snapshot.actor.scope, searchKey, memberQuery],
  );
  useEffect(() => {
    const timer = setTimeout(() => setMemberSearch(memberQuery.trim()), 220);
    return () => clearTimeout(timer);
  }, [memberQuery]);
  const [notice, setNotice] = useState<string | null>(null);
  const compositionEpoch = snapshot.byType[state.entityType].compositionEpoch;
  const initialPosition = useRef(readNetworkListPosition(snapshot.actor.scope, state));
  const entries = useNetworkEntries({
    api,
    scopeKey: snapshot.actor.scope,
    entityType: state.entityType,
    favoriteType: card.favoriteType,
    compositionEpoch,
    search: memberSearch,
    enabled: state.tab === 'communities',
    initialPageCount: initialPosition.current.loadedPageCount,
  });
  const latest = useRef({ state, pageCount: entries.pageCount });
  latest.current = { state, pageCount: entries.pageCount };
  const stats = useNetworkStatistics({
    api,
    scopeKey: snapshot.actor.scope,
    entityType: state.entityType,
    favoriteType: card.favoriteType,
    range: state.range,
    compositionVersion: card.compositionVersion,
    enabled: !stale && card.entityCount > 0 && state.tab === 'overview',
    onScopeInvalidated: (reason) => {
      setNotice(
        reason === 'access' ? 'Доступ к сообществам изменился.' : 'Состав сетки изменился.',
      );
      void refresh().catch(() => setNotice('Состав изменился. Обновите сетку.'));
    },
  });
  const savePosition = () =>
    saveNetworkListPosition(
      snapshot.actor.scope,
      latest.current.state,
      captureNetworkListPosition(Math.max(1, latest.current.pageCount)),
    );
  useLayoutEffect(
    () => () => {
      saveNetworkListPosition(
        snapshot.actor.scope,
        latest.current.state,
        captureNetworkListPosition(Math.max(1, latest.current.pageCount)),
      );
    },
    [snapshot.actor.scope],
  );
  const restored = useRef(false);
  useLayoutEffect(() => {
    if (
      restored.current ||
      (state.tab === 'communities'
        ? entries.loading ||
          entries.error ||
          entries.pageCount === 0 ||
          (entries.pageCount < initialPosition.current.loadedPageCount && entries.nextCursor)
        : !stats.data)
    )
      return;
    restored.current = true;
    const position = initialPosition.current;
    const frame = window.requestAnimationFrame(() => {
      const row = position.anchor
        ? [...document.querySelectorAll<HTMLElement>('[data-network-entity-id]')].find(
            (node) => node.dataset.networkEntityId === position.anchor?.entityId,
          )
        : null;
      window.scrollTo({
        top:
          row && position.anchor
            ? window.scrollY + row.getBoundingClientRect().top - position.anchor.offset
            : position.scrollY,
        behavior: 'instant',
      });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [
    entries.error,
    entries.loading,
    entries.nextCursor,
    entries.pageCount,
    state.tab,
    stats.data,
  ]);
  useNativeBackHandler(
    () => {
      savePosition();
      onRoute({ ...state, favoriteType: null, tab: 'overview' });
      return true;
    },
    { enabled: !compositionOpen, priority: 100 },
  );
  const route = (next: NetworkRouteState) => {
    savePosition();
    onRoute(next);
  };
  const openSettings = () => {
    savePosition();
    onSettings(Math.max(1, entries.pageCount));
  };
  return (
    <>
      <NetworkWorkspaceTabs
        value={state.tab}
        settingsDisabled={stale || card.entityCount === 0}
        onChange={(tab) => (tab === 'settings' ? openSettings() : route({ ...state, tab }))}
      />
      {state.tab === 'overview' && card.entityCount > 0 ? (
        <div className="network-detail-navigation">
          <span className="networks-caption">Период статистики</span>
          <SegmentedControl
            value={state.range}
            options={[
              { value: '7d', label: '7 дней' },
              { value: '30d', label: '30 дней' },
            ]}
            onChange={(range) => route({ ...state, range })}
            ariaLabel="Период статистики"
            className="network-range"
          />
        </div>
      ) : null}
      {notice ? (
        <div className="networks-notice" role="status">
          {notice}
        </div>
      ) : null}
      {stale ? (
        <div className="networks-notice" role="status">
          <span>Состав сетки нужно обновить.</span>
          <button
            type="button"
            onClick={() =>
              void refresh().catch(() => setNotice('Обновить состав пока не удалось.'))
            }
          >
            Обновить
          </button>
        </div>
      ) : null}
      {state.tab === 'overview' && card.entityCount === 0 ? (
        <div className="networks-empty network-empty-start">
          <span className="network-empty-start__icon" aria-hidden>
            <NetworkCategoryIcon favoriteType={card.favoriteType} />
          </span>
          <h2>В сетке пока пусто</h2>
          <button
            type="button"
            className="networks-primary"
            onClick={() => setCompositionOpen('add')}
          >
            <AppIcon icon="Plus" />
            {state.entityType === 'chat' ? 'Добавить чаты' : 'Добавить каналы'}
          </button>
        </div>
      ) : state.tab === 'overview' ? (
        <Suspense
          fallback={
            <div className="networks-loading">
              <Spinner />
              Открываем сводку…
            </div>
          }
        >
          <NetworkStatisticsView
            state={stats}
            entityType={state.entityType}
            range={state.range}
            viewKey={`${snapshot.actor.scope}:${state.entityType}:${card.favoriteType}:${state.range}`}
            onOpenCommunity={(entityId) => {
              savePosition();
              navigate(
                buildManagedEntityStatisticsRoute(state.entityType, entityId, {
                  range: state.range,
                }),
                {
                  state: {
                    chatTitle: stats.data?.items.find((item) => item.entityId === entityId)?.title,
                    managedEntityWorkspace: createManagedEntityWorkspaceState({
                      entityType: state.entityType,
                      entityId,
                      origin: {
                        locationKey: location.key,
                        historyIndex: window.history.state?.idx,
                      },
                      statsPreference: { range: state.range },
                    }),
                  },
                },
              );
            }}
          />
        </Suspense>
      ) : (
        <>
          <div className="network-community-heading">
            <h2>Состав сетки</h2>
            <span className="networks-caption">
              {formatEntityCount(card.entityCount, state.entityType)}
            </span>
          </div>
          <div className="network-community-actions">
            <button
              type="button"
              className="networks-secondary"
              onClick={() => setCompositionOpen('members')}
            >
              <AppIcon icon="Group" />
              Изменить состав
            </button>
            <button
              type="button"
              className="networks-primary"
              onClick={() => setCompositionOpen('add')}
            >
              <AppIcon icon="Plus" />
              Добавить
            </button>
          </div>
          <SearchField
            className="network-search-field"
            label="Поиск в составе"
            placeholder="Найти сообщество"
            value={memberQuery}
            onChange={setMemberQuery}
            inputProps={{ maxLength: NETWORK_ENTITY_SEARCH_MAX_LENGTH }}
          />
          <div className="network-community-list" aria-busy={entries.loading}>
            {entries.items.map((item) => (
              <button
                type="button"
                className="network-community-row"
                key={item.id}
                data-network-entity-id={item.id}
                onClick={() => {
                  savePosition();
                  navigate(
                    buildManagedEntityStatisticsRoute(state.entityType, item.id, {
                      range: state.range,
                    }),
                    {
                      state: {
                        chatTitle: item.title,
                        managedEntityWorkspace: createManagedEntityWorkspaceState({
                          entityType: state.entityType,
                          entityId: item.id,
                          origin: {
                            locationKey: location.key,
                            historyIndex: window.history.state?.idx,
                          },
                          statsPreference: { range: state.range },
                        }),
                      },
                    },
                  );
                }}
              >
                <EntityAvatar
                  title={item.title}
                  entityId={item.id}
                  entityType={item.entityType}
                  avatarUrl={item.avatarUrl}
                />
                <span className="network-community-row__text">
                  <strong>{item.title}</strong>
                </span>
                <AppIcon icon="NavArrowRight" />
              </button>
            ))}
            {!entries.loading && !entries.error && entries.items.length === 0 ? (
              <div className="networks-empty">
                <strong>{memberSearch ? 'Ничего не найдено' : 'В сетке пока пусто'}</strong>
                {memberSearch ? (
                  <button
                    type="button"
                    className="networks-text-button"
                    onClick={() => setMemberQuery('')}
                  >
                    Сбросить поиск
                  </button>
                ) : null}
              </div>
            ) : null}
            {entries.loading ? (
              <div className="networks-loading" role="status">
                <Spinner />
                Загружаем состав…
              </div>
            ) : null}
            {entries.error ? (
              <div className="networks-notice" role="alert">
                <p>{entries.error}</p>
                <button type="button" onClick={entries.refresh}>
                  Обновить список
                </button>
              </div>
            ) : null}
            {entries.nextCursor && !entries.loading && !entries.error ? (
              <button type="button" className="networks-more" onClick={entries.loadMore}>
                Показать ещё
              </button>
            ) : null}
          </div>
        </>
      )}
      {compositionOpen ? (
        <Suspense
          fallback={
            <div className="networks-loading" role="status">
              Открываем состав…
            </div>
          }
        >
          <NetworkCompositionSheet
            api={api}
            entityType={state.entityType}
            favoriteType={card.favoriteType}
            initialMode={compositionOpen}
            onClose={() => setCompositionOpen(null)}
          />
        </Suspense>
      ) : null}
    </>
  );
}

export function NetworksPage({ api, userId }: { api: ApiTransport; userId: string }) {
  const location = useLocation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { snapshot } = useHomeEntityFavorites();
  useEffect(() => {
    document.body.classList.add('networks-page-open');
    return () => document.body.classList.remove('networks-page-open');
  }, []);
  const state = useMemo(
    () =>
      readNetworkRoute(location.search, readNetworkViewPreference(snapshot.actor.scope, 'range')),
    [location.search, snapshot.actor.scope],
  );
  useEffect(
    () => saveNetworkViewPreference(snapshot.actor.scope, 'range', state.range),
    [snapshot.actor.scope, state.range],
  );
  const catalogue = useHomeEntityNetworkCatalogue(state.entityType);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [refreshes, setRefreshes] = useState<Record<ManagedEntityType, boolean>>({
    chat: false,
    channel: false,
  });
  const refreshing = refreshes[state.entityType];
  const onRoute = (next: NetworkRouteState) => navigate(buildNetworkRoute(next));
  const selectedCard = catalogue.cards.find((card) => card.favoriteType === state.favoriteType);
  useNativeBackHandler(
    () => {
      navigate(`/?view=${state.entityType}`, { replace: true });
      return true;
    },
    { enabled: !state.favoriteType, priority: 50 },
  );
  const populated = catalogue.cards.filter((card) => card.entityCount > 0);
  const emptyCards = catalogue.cards.filter((card) => card.entityCount === 0);
  const refreshCatalogue = async () => {
    const entityType = state.entityType;
    if (refreshes[entityType]) return;
    setRefreshes((current) => ({ ...current, [entityType]: true }));
    try {
      await catalogue.refresh();
      for (const card of catalogue.cards) {
        void queryClient.invalidateQueries({
          queryKey: networkStatisticsQueryKey({
            api,
            scopeKey: snapshot.actor.scope,
            entityType,
            favoriteType: card.favoriteType,
            range: state.range,
            compositionVersion: card.compositionVersion,
          }),
          exact: true,
        });
      }
    } finally {
      setRefreshes((current) => ({ ...current, [entityType]: false }));
    }
  };
  const openSettings = async (
    card: ManagedEntityNetworkCard,
    returnState: NetworkRouteState,
    pageCount = 1,
  ) => {
    if (catalogue.stale || card.entityCount === 0) return;
    setSettingsError(null);
    try {
      const { createNetworkSettingsScope } =
        await import('../lib/network-settings-workspace-state');
      const target = { mode: 'category' as const, favoriteType: card.favoriteType };
      const scope =
        state.entityType === 'chat'
          ? { entityType: 'chat' as const, target, initialSection: 'links' as const }
          : { entityType: 'channel' as const, target, initialSection: 'quickButtons' as const };
      const stored = createNetworkSettingsScope({
        userId,
        scope,
        title: card.label,
        returnTo: buildNetworkRoute({ ...returnState, favoriteType: card.favoriteType }),
        origin: {
          locationKey: location.key,
          historyIndex:
            typeof window.history.state?.idx === 'number' ? window.history.state.idx : null,
          ...captureNetworkListPosition(pageCount),
        },
      });
      navigate(
        `/networks/${scope.entityType}/settings?${new URLSearchParams({ scope: stored.scopeId })}`,
      );
    } catch {
      setSettingsError('Не удалось открыть настройки сетки. Повторите попытку.');
    }
  };
  return (
    <section className="networks-page">
      {selectedCard ? (
        <NetworkWorkspaceHeader
          title={selectedCard.label}
          entityType={state.entityType}
          favoriteType={selectedCard.favoriteType}
          count={selectedCard.entityCount}
          onBack={() => onRoute({ ...state, favoriteType: null, tab: 'overview' })}
          onPick={(entityType, favoriteType) => onRoute({ ...state, entityType, favoriteType })}
        />
      ) : (
        <header className="networks-heading">
          <span className="catalogue-heading-mark" aria-hidden />
          <div className="networks-heading__brand">
            <h1>Сетки</h1>
            {catalogue.cards.length > 0 ? (
              <span
                className="networks-heading__count"
                aria-label={`Сеток с сообществами: ${populated.length}`}
              >
                {populated.length}
              </span>
            ) : null}
          </div>
          <button
            type="button"
            className="networks-heading__refresh"
            aria-label="Обновить сетки"
            aria-busy={refreshing}
            disabled={refreshing || catalogue.status === 'loading'}
            onClick={() => void refreshCatalogue().catch(() => undefined)}
          >
            {refreshing ? <Spinner /> : <AppIcon icon="RefreshDouble" />}
          </button>
          <span className="networks-heading__icon" aria-hidden>
            <AppIcon icon="Community" />
          </span>
        </header>
      )}
      {!selectedCard ? (
        <div className="networks-controls">
          <div className="networks-control">
            <span className="networks-caption" aria-hidden>
              Сообщества
            </span>
            <SegmentedControl
              value={state.entityType}
              options={[
                { value: 'chat', label: 'Чаты' },
                { value: 'channel', label: 'Каналы' },
              ]}
              onChange={(entityType) =>
                onRoute({ ...state, entityType, favoriteType: null, tab: 'overview' })
              }
              ariaLabel="Тип сообществ"
            />
          </div>
          <div className="networks-control">
            <span className="networks-caption" aria-hidden>
              Период статистики
            </span>
            <SegmentedControl
              value={state.range}
              options={[
                { value: '7d', label: '7 дней' },
                { value: '30d', label: '30 дней' },
              ]}
              onChange={(range) => onRoute({ ...state, range })}
              ariaLabel="Период статистики"
            />
          </div>
        </div>
      ) : null}
      {settingsError ? (
        <p className="networks-notice" role="alert">
          {settingsError}
        </p>
      ) : null}
      {catalogue.status === 'loading' && catalogue.cards.length === 0 ? (
        <div className="networks-loading" role="status">
          <Spinner />
          <span>Загружаем сетки…</span>
        </div>
      ) : null}
      {catalogue.error ? (
        <div className="networks-notice" role="alert">
          <p>Не удалось обновить сетки. Сохранённые данные могут быть неактуальны.</p>
          <button type="button" onClick={() => void catalogue.refresh().catch(() => undefined)}>
            Повторить
          </button>
        </div>
      ) : null}
      {state.favoriteType && selectedCard ? (
        <NetworkDetail
          key={`${snapshot.actor.scope}:${state.entityType}:${state.favoriteType}:${state.tab}`}
          api={api}
          state={state}
          card={selectedCard}
          stale={catalogue.stale}
          onRoute={onRoute}
          refresh={catalogue.refresh}
          onSettings={(pageCount) => void openSettings(selectedCard, state, pageCount)}
        />
      ) : !state.favoriteType ? (
        <>
          <Suspense fallback={null}>
            <NetworkOperationHistory key={userId} api={api} userId={userId} />
          </Suspense>
          <div className="networks-catalogue">
            {populated.map((card) => (
              <SummaryCard
                key={`${state.entityType}:${card.favoriteType}`}
                api={api}
                scopeKey={snapshot.actor.scope}
                type={state.entityType}
                card={card}
                range={state.range}
                stale={catalogue.stale}
                onRefresh={catalogue.refresh}
                onSettings={() => void openSettings(card, state)}
                onOpen={() =>
                  onRoute({ ...state, favoriteType: card.favoriteType, tab: 'overview' })
                }
              />
            ))}
          </div>
          {emptyCards.length ? (
            <details className="networks-empty-categories" open={!populated.length}>
              <summary>{populated.length ? 'Другие сетки' : 'Выберите сетку'}</summary>
              <div>
                {emptyCards.map((card) => (
                  <button
                    type="button"
                    key={card.favoriteType}
                    data-network-category={card.favoriteType}
                    onClick={() =>
                      onRoute({ ...state, favoriteType: card.favoriteType, tab: 'communities' })
                    }
                  >
                    <NetworkCategoryIcon favoriteType={card.favoriteType} />
                    <span>{card.label}</span>
                  </button>
                ))}
              </div>
              <button
                type="button"
                className="networks-text-button"
                onClick={() => navigate(`/?view=${state.entityType}`)}
              >
                <AppIcon icon="Star" />К избранному на главной
              </button>
            </details>
          ) : null}
        </>
      ) : catalogue.status !== 'loading' ? (
        <div className="networks-notice">
          <p>Сетка пока недоступна.</p>
          <button type="button" onClick={() => onRoute({ ...state, favoriteType: null })}>
            Все сетки
          </button>
        </div>
      ) : null}
    </section>
  );
}
