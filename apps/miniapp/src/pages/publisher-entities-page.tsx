import { AppIcon as IconoirSprite } from '../components/ui/app-icon';
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import type { PublisherEntitiesSummary, PublisherEntity } from '@maxim/contracts/publisher';

import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type UIEvent,
} from 'react';
import { Link, useSearchParams } from 'react-router';
import { EntityAvatar } from '../components/ui/entity-avatar';
import { useToast } from '../components/ui/toast';
import { formatRussianCountLabel } from '../lib/broadcast-audience';
import { cn } from '../lib/cn';
import { PUBLIK_BRAND } from '../lib/bot-brand';
import {
  getPublisherEntity,
  listPublisherEntities,
  refreshPublisherEntities,
  refreshPublisherEntity,
} from '../lib/api/publisher-client';
import type { ApiTransport } from '../lib/api/transport';
import { openMaxBotLinkAndClose } from '../lib/max-bridge';
import {
  getPublisherReadinessPollingInterval,
  getPublisherReadinessPresentation,
} from '../lib/publisher-readiness';
import { describeUserFacingError } from '../lib/user-facing-error';
import { resolveVirtualListRange } from '../lib/virtual-list';
import {
  buildPublisherEntityViewRoute,
  fingerprintPublisherEntities,
  normalizePublisherEntityView,
  observePublisherHomeAccessRefresh,
  pollPublisherEntityRefresh,
  PUBLISHER_ENTITY_REFRESH_POLL_DELAYS_MS,
  resolvePublisherHomeView,
  retryPublisherEntitiesNextPage,
  shouldLoadPublisherEntitiesNextPage,
  shouldOfferPublisherRecheck,
  waitForPublisherRefresh,
  type PublisherEntityReadinessFilter,
} from './publisher-entities-page-model';
import { buildPublisherEntityModulesRoute } from './publisher-entity-modules-page-model';
import './publisher-entities-page.css';
import '../styles/publisher-catalog-workspace.css';

const PUBLISHER_ENTITIES_QUERY_ROOT = ['publications', 'sources', 'publisher'] as const;
const PUBLISHER_ENTITY_PAGE_SIZE = 30;
const PUBLISHER_ENTITY_ROW_HEIGHT = 120;
const PUBLISHER_ENTITY_ROW_REM = PUBLISHER_ENTITY_ROW_HEIGHT / 16;
const PUBLISHER_ENTITY_LIST_INITIAL_HEIGHT = 680;
const PUBLISHER_ENTITY_VIRTUALIZATION_THRESHOLD = 60;
const PUBLISHER_ENTITY_LIST_OVERSCAN = 4;
const PUBLISHER_ENTITY_SEARCH_DEBOUNCE_MS = 250;
const PUBLISHER_BULK_REFRESH_POLL_DELAYS_MS = [1_200, 2_400, 4_200, 7_200] as const;

type PublisherEntityRefreshState = {
  entityKey: string;
  phase: 'enqueueing' | 'polling';
};

type PublisherBulkRefreshState = {
  phase: 'enqueueing' | 'polling';
  queuedCount: number;
};

const EMPTY_PUBLISHER_SUMMARY: PublisherEntitiesSummary = {
  total: 0,
  chat: 0,
  channel: 0,
  ready: 0,
  attention: 0,
};

const READINESS_FILTERS: Array<{
  value: PublisherEntityReadinessFilter;
  label: string;
}> = [
  { value: 'all', label: 'Все' },
  { value: 'ready', label: 'Готовы' },
  { value: 'attention', label: 'Внимание' },
];

function formatEntityListStatus(
  visibleCount: number,
  totalCount: number,
  loading: boolean,
): string {
  if (loading) {
    return 'Загружаю список';
  }
  if (visibleCount === totalCount) {
    return formatRussianCountLabel(totalCount, 'получатель', 'получателя', 'получателей');
  }
  return `${visibleCount} из ${totalCount}`;
}

function fingerprintPublisherEntityPage(
  entities: readonly PublisherEntity[],
  summary: PublisherEntitiesSummary,
): string {
  return `${summary.chat}:${summary.channel}:${summary.ready}:${summary.attention}\n${fingerprintPublisherEntities(
    entities,
  )}`;
}

export function PublisherEntitiesPage({
  api,
  botDialogUrl = null,
}: {
  api: ApiTransport;
  botDialogUrl?: string | null;
}) {
  const { pushToast } = useToast();
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const [query, setQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [readinessFilter, setReadinessFilter] = useState<PublisherEntityReadinessFilter>('all');
  const [listScrollTop, setListScrollTop] = useState(0);
  const [entityRowHeight, setEntityRowHeight] = useState(PUBLISHER_ENTITY_ROW_HEIGHT);
  const [listViewportHeight, setListViewportHeight] = useState(
    PUBLISHER_ENTITY_LIST_INITIAL_HEIGHT,
  );
  const [entityRefresh, setEntityRefresh] = useState<PublisherEntityRefreshState | null>(null);
  const [bulkRefresh, setBulkRefresh] = useState<PublisherBulkRefreshState | null>(null);
  const [openingBotDialog, setOpeningBotDialog] = useState(false);
  const [lastSummary, setLastSummary] = useState<PublisherEntitiesSummary | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const rowScaleRef = useRef<HTMLSpanElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const autoLoadArmedRef = useRef(true);
  const nextPageRequestRef = useRef(false);
  const mountedRef = useRef(true);
  const refreshAbortRef = useRef<AbortController | null>(null);
  const bulkRefreshAbortRef = useRef<AbortController | null>(null);
  const requestedView = searchParams.get('view');
  const view = normalizePublisherEntityView(requestedView);
  const readiness = readinessFilter === 'all' ? undefined : readinessFilter;
  const searchSettling = query.trim() !== debouncedQuery;
  const entitiesQueryKey = useMemo(
    () =>
      [
        ...PUBLISHER_ENTITIES_QUERY_ROOT,
        'cursor',
        { query: debouncedQuery, entityType: view, readiness: readiness ?? null },
      ] as const,
    [debouncedQuery, readiness, view],
  );
  const entitiesQuery = useInfiniteQuery({
    queryKey: entitiesQueryKey,
    queryFn: ({ pageParam, signal }) =>
      listPublisherEntities(api, {
        pagination: 'cursor',
        limit: PUBLISHER_ENTITY_PAGE_SIZE,
        query: debouncedQuery,
        entityType: view,
        readiness,
        cursor: pageParam,
        signal,
      }),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    staleTime: 15_000,
    refetchOnWindowFocus: false,
    refetchInterval: (query) => {
      if (query.state.data?.pages.some((page) => page.accessVerificationPending)) return 1500;
      const intervals =
        query.state.data?.pages.flatMap((page) =>
          page.items
            .map((entity) => getPublisherReadinessPollingInterval(entity.readiness))
            .filter((interval): interval is number => interval !== false),
        ) ?? [];
      return intervals.length > 0 ? Math.min(...intervals) : false;
    },
  });
  const entities = useMemo(
    () => entitiesQuery.data?.pages.flatMap((page) => page.items) ?? [],
    [entitiesQuery.data?.pages],
  );
  const currentSummary = entitiesQuery.data?.pages[0]?.summary;
  const summary = currentSummary ?? lastSummary ?? EMPTY_PUBLISHER_SUMMARY;
  const filteredTotal = entitiesQuery.data?.pages[0]?.filteredTotal ?? 0;
  const homeViewResolution = resolvePublisherHomeView(requestedView, summary);
  const shouldAutoOpenChannels =
    entitiesQuery.data !== undefined && homeViewResolution.shouldReplace;
  const activeTypeCount = summary[view];
  const otherView = view === 'channel' ? 'chat' : 'channel';
  const otherTypeCount = summary[otherView];
  const hasCatalogControls =
    summary.total > 0 || query.trim().length > 0 || readinessFilter !== 'all';
  const showCatalogStatus =
    filteredTotal > PUBLISHER_ENTITY_PAGE_SIZE ||
    searchSettling ||
    debouncedQuery.length > 0 ||
    readinessFilter !== 'all' ||
    entities.length < filteredTotal;
  const shouldVirtualize = entities.length > PUBLISHER_ENTITY_VIRTUALIZATION_THRESHOLD;
  const virtualRange = useMemo(
    () =>
      resolveVirtualListRange({
        itemCount: entities.length,
        scrollTop: listScrollTop,
        viewportHeight: listViewportHeight,
        rowHeight: entityRowHeight,
        overscan: PUBLISHER_ENTITY_LIST_OVERSCAN,
      }),
    [entities.length, entityRowHeight, listScrollTop, listViewportHeight],
  );
  const renderedEntities = shouldVirtualize
    ? entities.slice(virtualRange.startIndex, virtualRange.endIndex)
    : entities;
  const renderedOffset = virtualRange.startIndex * entityRowHeight;

  useEffect(() => {
    if (currentSummary) setLastSummary(currentSummary);
  }, [currentSummary]);

  useEffect(() => {
    autoLoadArmedRef.current = true;
  }, [entities.length]);

  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const measure = () => {
      setListScrollTop(list.scrollTop);
      setListViewportHeight(list.clientHeight);
      const rootFontSize = Number.parseFloat(getComputedStyle(document.documentElement).fontSize);
      setEntityRowHeight(
        Math.max(PUBLISHER_ENTITY_ROW_HEIGHT, rootFontSize * PUBLISHER_ENTITY_ROW_REM),
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(list);
    observer.observe(document.documentElement);
    if (rowScaleRef.current) observer.observe(rowScaleRef.current);
    window.addEventListener('resize', measure);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [entities.length, searchSettling, shouldVirtualize]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      refreshAbortRef.current?.abort();
      bulkRefreshAbortRef.current?.abort();
    };
  }, []);

  useEffect(() => {
    let observation: AbortController | null = null;
    const observe = () => {
      observation?.abort();
      observation = null;
      if (document.visibilityState !== 'visible') return;
      observation = new AbortController();
      void observePublisherHomeAccessRefresh({
        signal: observation.signal,
        refresh: () => queryClient.invalidateQueries({ queryKey: PUBLISHER_ENTITIES_QUERY_ROOT }),
      });
    };
    observe();
    document.addEventListener('visibilitychange', observe);
    return () => {
      observation?.abort();
      document.removeEventListener('visibilitychange', observe);
    };
  }, [api, queryClient]);

  useEffect(() => {
    const timeoutId = window.setTimeout(
      () => setDebouncedQuery(query.trim()),
      PUBLISHER_ENTITY_SEARCH_DEBOUNCE_MS,
    );
    return () => window.clearTimeout(timeoutId);
  }, [query]);

  useEffect(() => {
    autoLoadArmedRef.current = true;
    setListScrollTop(0);
    listRef.current?.scrollTo({ top: 0 });
  }, [debouncedQuery, readinessFilter, view]);

  useEffect(() => {
    if (!shouldAutoOpenChannels) {
      return;
    }
    const next = new URLSearchParams(searchParams);
    next.set('view', homeViewResolution.view);
    setSearchParams(next, { replace: true });
  }, [homeViewResolution.view, searchParams, setSearchParams, shouldAutoOpenChannels]);

  useEffect(() => {
    const now = Date.now();
    const nextRetryAt = entities.reduce<number | null>((earliest, entity) => {
      if (entity.readiness.blockerCode === 'bot_access_expired') return earliest;
      const retryAt = Date.parse(entity.readiness.retryAt ?? '');
      if (!Number.isFinite(retryAt) || retryAt <= now) {
        return earliest;
      }
      return earliest === null ? retryAt : Math.min(earliest, retryAt);
    }, null);
    if (nextRetryAt === null) {
      return undefined;
    }

    const timeoutId = window.setTimeout(
      () => void queryClient.invalidateQueries({ queryKey: entitiesQueryKey, exact: true }),
      Math.min(nextRetryAt - now + 250, 2_147_000_000),
    );
    return () => window.clearTimeout(timeoutId);
  }, [entities, entitiesQueryKey, queryClient]);

  async function handleRefreshEntities(): Promise<void> {
    if (bulkRefresh || bulkRefreshAbortRef.current) {
      return;
    }
    const abortController = new AbortController();
    bulkRefreshAbortRef.current = abortController;
    setBulkRefresh({ phase: 'enqueueing', queuedCount: 0 });
    const initialFingerprint = fingerprintPublisherEntityPage(entities, summary);

    try {
      const refresh = await refreshPublisherEntities(api);
      if (abortController.signal.aborted) {
        return;
      }
      if (refresh.queuedCount === 0) {
        await queryClient.invalidateQueries({ queryKey: PUBLISHER_ENTITIES_QUERY_ROOT });
        if (abortController.signal.aborted) {
          return;
        }
        pushToast({
          tone: 'info',
          title: 'Подключения актуальны',
        });
        return;
      }

      setBulkRefresh({ phase: 'polling', queuedCount: refresh.queuedCount });

      let consecutiveReadFailures = 0;
      for (const delayMs of PUBLISHER_BULK_REFRESH_POLL_DELAYS_MS) {
        await waitForPublisherRefresh(delayMs, abortController.signal);
        if (abortController.signal.aborted) {
          return;
        }
        const result = await entitiesQuery.refetch();
        if (abortController.signal.aborted) {
          return;
        }
        if (result.isError || !result.data) {
          consecutiveReadFailures += 1;
          if (consecutiveReadFailures >= 2) {
            break;
          }
          continue;
        }
        consecutiveReadFailures = 0;
        const nextEntities = result.data.pages.flatMap((page) => page.items);
        const nextSummary = result.data.pages[0]?.summary ?? EMPTY_PUBLISHER_SUMMARY;
        if (fingerprintPublisherEntityPage(nextEntities, nextSummary) !== initialFingerprint) {
          await queryClient.invalidateQueries({ queryKey: PUBLISHER_ENTITIES_QUERY_ROOT });
          if (abortController.signal.aborted) {
            return;
          }
          pushToast({
            tone: 'success',
            title: 'Подключения обновлены',
          });
          return;
        }
      }

      await queryClient.invalidateQueries({ queryKey: PUBLISHER_ENTITIES_QUERY_ROOT });
      if (abortController.signal.aborted) {
        return;
      }
      pushToast({
        tone: consecutiveReadFailures >= 2 ? 'danger' : 'info',
        title:
          consecutiveReadFailures >= 2 ? 'Не удалось обновить список' : 'Проверка продолжается',
        description:
          consecutiveReadFailures >= 2 ? 'Повторите позже.' : 'Обновите список через минуту.',
      });
    } catch (error: unknown) {
      if (!abortController.signal.aborted) {
        pushToast({
          tone: 'danger',
          title: 'Не удалось проверить подключения',
          description: describeUserFacingError(error, 'Повторите позже.'),
        });
      }
    } finally {
      if (bulkRefreshAbortRef.current === abortController) {
        bulkRefreshAbortRef.current = null;
      }
      if (mountedRef.current) {
        setBulkRefresh(null);
      }
    }
  }

  function handleOpenBotDialog(): void {
    if (!botDialogUrl) {
      pushToast({
        tone: 'danger',
        title: 'Диалог Публика недоступен',
        description: 'Закройте мини-приложение и откройте диалог с ботом вручную.',
      });
      return;
    }
    setOpeningBotDialog(true);
    if (!openMaxBotLinkAndClose(botDialogUrl)) {
      setOpeningBotDialog(false);
      pushToast({ tone: 'danger', title: 'Не удалось открыть диалог Публика' });
    }
  }

  async function handleRefreshEntity(entity: PublisherEntity): Promise<void> {
    const entityKey = `${entity.entityType}:${entity.id}`;
    if (entityRefresh || refreshAbortRef.current || bulkRefresh) {
      return;
    }
    const abortController = new AbortController();
    refreshAbortRef.current = abortController;
    setEntityRefresh({ entityKey, phase: 'enqueueing' });

    try {
      try {
        await refreshPublisherEntity(api, entity.entityType, entity.id);
      } catch (error: unknown) {
        if (!abortController.signal.aborted) {
          pushToast({
            tone: 'danger',
            title: 'Не удалось проверить подключение',
            description: describeUserFacingError(error, 'Повторите позже.'),
          });
        }
        return;
      }
      if (abortController.signal.aborted) {
        return;
      }
      setEntityRefresh({ entityKey, phase: 'polling' });

      const result = await pollPublisherEntityRefresh({
        initialEntity: entity,
        delaysMs: PUBLISHER_ENTITY_REFRESH_POLL_DELAYS_MS,
        wait: (delayMs) => waitForPublisherRefresh(delayMs, abortController.signal),
        readEntity: () =>
          getPublisherEntity(api, entity.entityType, entity.id, {
            signal: abortController.signal,
          }),
        isCancelled: () => abortController.signal.aborted,
      });
      if (abortController.signal.aborted || result.status === 'cancelled') {
        return;
      }
      if (result.status === 'updated') {
        await queryClient.invalidateQueries({ queryKey: PUBLISHER_ENTITIES_QUERY_ROOT });
        if (abortController.signal.aborted) {
          return;
        }
        const presentation = getPublisherReadinessPresentation(result.entity.readiness);
        pushToast({
          tone: result.entity.readiness.canPublish ? 'success' : 'info',
          title: result.entity.readiness.canPublish ? 'Подключение готово' : 'Проверка завершена',
          description: result.entity.readiness.canPublish ? undefined : presentation.detail,
        });
        return;
      }
      if (result.status === 'read_failed') {
        pushToast({
          tone: 'danger',
          title: 'Не удалось обновить статус',
          description: describeUserFacingError(result.error, 'Повторите позже.'),
        });
        return;
      }
      pushToast({
        tone: 'info',
        title: 'Проверка продолжается',
        description: 'Обновите статус через минуту.',
      });
    } catch (error: unknown) {
      if (!abortController.signal.aborted) {
        pushToast({
          tone: 'danger',
          title: 'Не удалось обновить статус',
          description: describeUserFacingError(error, 'Повторите позже.'),
        });
      }
    } finally {
      if (refreshAbortRef.current === abortController) {
        refreshAbortRef.current = null;
      }
      if (mountedRef.current) {
        setEntityRefresh((current) => (current?.entityKey === entityKey ? null : current));
      }
    }
  }

  async function handleLoadMoreEntities(): Promise<void> {
    if (
      nextPageRequestRef.current ||
      searchSettling ||
      !entitiesQuery.hasNextPage ||
      entitiesQuery.isFetchingNextPage
    ) {
      return;
    }

    nextPageRequestRef.current = true;
    try {
      await retryPublisherEntitiesNextPage({
        fetchNextPage: () => entitiesQuery.fetchNextPage(),
        resetInvalidCursor: () =>
          queryClient.resetQueries({ queryKey: entitiesQueryKey, exact: true }),
      });
    } finally {
      nextPageRequestRef.current = false;
    }
  }

  function handleEntityListScroll(event: UIEvent<HTMLDivElement>): void {
    const list = event.currentTarget;
    setListScrollTop(list.scrollTop);
    setListViewportHeight(list.clientHeight);

    const nearEnd = shouldLoadPublisherEntitiesNextPage({
      scrollTop: list.scrollTop,
      scrollHeight: list.scrollHeight,
      clientHeight: list.clientHeight,
      threshold: entityRowHeight * 2,
    });
    if (!nearEnd) {
      autoLoadArmedRef.current = true;
      return;
    }
    if (autoLoadArmedRef.current) {
      autoLoadArmedRef.current = false;
      void handleLoadMoreEntities();
    }
  }

  function renderEntity(entity: PublisherEntity, renderedIndex: number) {
    const presentation = getPublisherReadinessPresentation(entity.readiness);
    const entityKey = `${entity.entityType}:${entity.id}`;
    const refreshPhase = entityRefresh?.entityKey === entityKey ? entityRefresh.phase : null;
    const refreshing = refreshPhase !== null;
    const absoluteIndex = shouldVirtualize
      ? virtualRange.startIndex + renderedIndex
      : renderedIndex;
    const canRecheck = shouldOfferPublisherRecheck(entity);

    return (
      <article
        key={entityKey}
        className={cn('publisher-entity-row', `is-${presentation.tone}`)}
        role="listitem"
        aria-busy={refreshing || undefined}
        aria-posinset={absoluteIndex + 1}
        aria-setsize={filteredTotal}
      >
        <Link
          to={buildPublisherEntityModulesRoute(entity)}
          className="publisher-entity-row__main"
          aria-label={`Открыть разделы для ${
            entity.title || (entity.entityType === 'channel' ? 'канала' : 'чата')
          }`}
        >
          <EntityAvatar
            title={entity.title}
            entityType={entity.entityType}
            avatarUrl={entity.avatarUrl}
            className="publisher-entity-row__avatar"
          />
          <span className="publisher-entity-row__copy">
            <span className="publisher-entity-row__title">
              <strong title={entity.title}>
                {entity.title.trim() || (entity.entityType === 'channel' ? 'Канал' : 'Чат')}
              </strong>
            </span>
            <span
              className="publisher-entity-row__status"
              title={entity.readiness.canPublish ? undefined : presentation.detail}
              aria-live={refreshPhase ? 'polite' : undefined}
            >
              {entity.readiness.canPublish ? (
                <IconoirSprite variant="iconoir" icon="CheckCircle" aria-hidden />
              ) : (
                <IconoirSprite variant="iconoir" icon="WarningCircle" aria-hidden />
              )}
              <span>{refreshPhase ? 'Проверяем подключение' : presentation.label}</span>
            </span>
          </span>
          <IconoirSprite
            variant="iconoir"
            icon="NavArrowRight"
            className="publisher-entity-row__arrow"
            aria-hidden
          />
        </Link>
        {canRecheck ? (
          <button
            type="button"
            className={cn('publisher-entity-row__refresh', refreshing && 'is-refreshing')}
            aria-label={
              refreshing
                ? `Проверяется доступ для ${entity.title || entity.id}`
                : `Обновить доступ для ${entity.title || entity.id}`
            }
            title={refreshing ? 'Проверяю доступ' : 'Обновить доступ'}
            disabled={Boolean(entityRefresh || bulkRefresh)}
            onClick={() => void handleRefreshEntity(entity)}
          >
            <IconoirSprite variant="iconoir" icon="Refresh" aria-hidden />
          </button>
        ) : null}
      </article>
    );
  }

  return (
    <section
      className="publisher-entities-page"
      aria-labelledby="publisher-catalog-title"
      aria-busy={
        searchSettling ||
        entitiesQuery.isLoading ||
        entitiesQuery.isFetching ||
        Boolean(entityRefresh) ||
        Boolean(bulkRefresh)
      }
    >
      <header className="publisher-entities-page__header">
        <div className="publisher-entities-page__brand">
          <EntityAvatar
            className="publisher-entities-page__avatar"
            title={PUBLIK_BRAND.name}
            avatarUrl={PUBLIK_BRAND.avatarUrl}
            entityType="chat"
          />
          <div className="publisher-entities-page__identity">
            <h1 id="publisher-catalog-title">Публик</h1>
            <small>
              {view === 'channel' ? 'Каналы' : 'Чаты'}
              {currentSummary || lastSummary ? ` · ${summary[view]}` : ''}
            </small>
          </div>
          <button
            type="button"
            className={cn('publisher-entities-page__refresh', bulkRefresh && 'is-refreshing')}
            aria-label={
              bulkRefresh?.phase === 'polling'
                ? 'Проверяются подключения в MAX'
                : 'Перепроверить подключения в MAX'
            }
            title={bulkRefresh ? 'Проверяю подключения' : 'Перепроверить подключения'}
            disabled={Boolean(bulkRefresh || entityRefresh)}
            onClick={() => void handleRefreshEntities()}
          >
            <IconoirSprite variant="iconoir" icon="Refresh" aria-hidden />
          </button>
        </div>
      </header>

      {bulkRefresh ? (
        <div className="publisher-entities-page__refresh-status" role="status" aria-live="polite">
          <IconoirSprite variant="iconoir" icon="Refresh" className="is-refreshing" aria-hidden />
          <span>
            {bulkRefresh.phase === 'enqueueing'
              ? 'Запускаем проверку подключений'
              : `Проверяю подключения · ${bulkRefresh.queuedCount}`}
          </span>
        </div>
      ) : null}

      {hasCatalogControls ? (
        <>
          <div className="publisher-entities-page__search">
            <IconoirSprite variant="iconoir" icon="Search" aria-hidden />
            <input
              ref={searchRef}
              type="search"
              value={query}
              maxLength={120}
              enterKeyHint="search"
              placeholder={view === 'channel' ? 'Найти канал' : 'Найти чат'}
              aria-label={view === 'channel' ? 'Найти канал' : 'Найти чат'}
              onChange={(event) => setQuery(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') event.currentTarget.blur();
              }}
            />
            {query ? (
              <button
                type="button"
                onClick={() => {
                  setQuery('');
                  searchRef.current?.focus();
                }}
                aria-label="Очистить поиск"
                title="Очистить поиск"
              >
                <IconoirSprite variant="iconoir" icon="Xmark" aria-hidden />
              </button>
            ) : null}
          </div>

          <div className="publisher-entities-page__filter-row">
            <div className="publisher-entities-page__filters" role="group" aria-label="Готовность">
              {READINESS_FILTERS.map((filter) => (
                <button
                  key={filter.value}
                  type="button"
                  className={cn(readinessFilter === filter.value && 'is-active')}
                  aria-pressed={readinessFilter === filter.value}
                  onClick={() => setReadinessFilter(filter.value)}
                >
                  {filter.label}
                </button>
              ))}
            </div>
            {showCatalogStatus ? (
              <span role="status">
                {formatEntityListStatus(
                  entities.length,
                  filteredTotal,
                  entitiesQuery.isLoading || searchSettling,
                )}
              </span>
            ) : null}
          </div>
        </>
      ) : null}

      {!searchSettling && entitiesQuery.isError && entities.length > 0 ? (
        <div className="publisher-entities-page__inline-error" role="alert">
          <span>Не удалось обновить список. Показаны последние данные.</span>
          <button
            type="button"
            onClick={() =>
              void queryClient.resetQueries({ queryKey: entitiesQueryKey, exact: true })
            }
          >
            Повторить
          </button>
        </div>
      ) : null}

      {searchSettling ? (
        <div className="publisher-entities-page__state" role="status">
          <IconoirSprite variant="iconoir" icon="Search" aria-hidden />
          <strong>Ищу получателей</strong>
        </div>
      ) : entitiesQuery.isLoading && entities.length === 0 ? (
        <div className="publisher-entities-page__state" role="status">
          <IconoirSprite variant="iconoir" icon="Refresh" className="is-refreshing" aria-hidden />
          <strong>Загружаю {view === 'channel' ? 'каналы' : 'чаты'}</strong>
        </div>
      ) : entitiesQuery.isError && entities.length === 0 ? (
        <div className="publisher-entities-page__state has-error" role="alert">
          <IconoirSprite variant="iconoir" icon="WarningCircle" aria-hidden />
          <strong>Не удалось загрузить получателей</strong>
          <span>Проверьте соединение и повторите запрос.</span>
          <button
            type="button"
            onClick={() =>
              void queryClient.resetQueries({ queryKey: entitiesQueryKey, exact: true })
            }
          >
            <IconoirSprite variant="iconoir" icon="Refresh" aria-hidden />
            <span>Повторить</span>
          </button>
        </div>
      ) : entities.length === 0 &&
        entitiesQuery.data?.pages.some((page) => page.accessVerificationPending) ? (
        <div className="publisher-entities-page__state" role="status">
          <IconoirSprite variant="iconoir" icon="Refresh" className="is-refreshing" aria-hidden />
          <strong>Проверяю ваши права</strong>
          <span>Чаты и каналы появятся по мере подтверждения.</span>
        </div>
      ) : shouldAutoOpenChannels ? (
        <div className="publisher-entities-page__state" role="status">
          <IconoirSprite variant="iconoir" icon="Refresh" className="is-refreshing" aria-hidden />
          <strong>Открываю каналы</strong>
        </div>
      ) : activeTypeCount === 0 && otherTypeCount > 0 ? (
        <div className="publisher-entities-page__state" role="status">
          <strong>{view === 'channel' ? 'Каналов пока нет' : 'Чатов пока нет'}</strong>
          <span>
            В соседнем разделе:{' '}
            {formatRussianCountLabel(
              otherTypeCount,
              view === 'channel' ? 'чат' : 'канал',
              view === 'channel' ? 'чата' : 'канала',
              view === 'channel' ? 'чатов' : 'каналов',
            )}
            .
          </span>
          <Link to={buildPublisherEntityViewRoute(otherView, searchParams.toString())}>
            {view === 'channel' ? 'Открыть чаты' : 'Открыть каналы'}
            <IconoirSprite variant="iconoir" icon="NavArrowRight" aria-hidden />
          </Link>
        </div>
      ) : activeTypeCount === 0 ? (
        <div className="publisher-entities-page__state is-onboarding" role="status">
          <strong>Подключите первый чат или канал</strong>
          <span>
            Добавьте Публика администратором, затем перешлите ему сообщение или пост из нужного чата
            или канала.
          </span>
          <button type="button" disabled={openingBotDialog} onClick={handleOpenBotDialog}>
            <span>{openingBotDialog ? 'Открываю...' : 'Открыть диалог Публика'}</span>
            <IconoirSprite variant="iconoir" icon="NavArrowRight" aria-hidden />
          </button>
        </div>
      ) : entities.length === 0 ? (
        <div className="publisher-entities-page__state" role="status">
          <IconoirSprite variant="iconoir" icon="Search" aria-hidden />
          <strong>Ничего не найдено</strong>
          <button
            type="button"
            onClick={() => {
              setQuery('');
              setReadinessFilter('all');
            }}
          >
            Сбросить фильтры
          </button>
        </div>
      ) : (
        <div
          ref={listRef}
          className={cn('publisher-entities-page__list', shouldVirtualize && 'is-virtual')}
          role="list"
          aria-label={view === 'channel' ? 'Каналы Публика' : 'Чаты Публика'}
          style={{ '--publisher-entity-row-height': `${entityRowHeight}px` } as CSSProperties}
          onScroll={handleEntityListScroll}
        >
          <span
            ref={rowScaleRef}
            className="publisher-entities-page__row-scale"
            style={{ width: `${PUBLISHER_ENTITY_ROW_REM}rem` }}
            aria-hidden="true"
          />
          {shouldVirtualize ? (
            <div
              className="publisher-entities-page__virtual-spacer"
              style={{ height: `${virtualRange.totalHeight}px` } as CSSProperties}
            >
              <div
                className="publisher-entities-page__virtual-window"
                style={{ transform: `translateY(${renderedOffset}px)` }}
              >
                {renderedEntities.map(renderEntity)}
              </div>
            </div>
          ) : (
            renderedEntities.map(renderEntity)
          )}
          {!searchSettling && entitiesQuery.hasNextPage ? (
            <div className="publisher-entities-page__pagination">
              <button
                type="button"
                className="publisher-entities-page__load-more"
                onClick={() => void handleLoadMoreEntities()}
                disabled={entitiesQuery.isFetchingNextPage}
              >
                {entitiesQuery.isFetchingNextPage
                  ? 'Загрузка...'
                  : entitiesQuery.isFetchNextPageError
                    ? 'Повторить'
                    : 'Показать ещё'}
              </button>
            </div>
          ) : null}
        </div>
      )}
    </section>
  );
}
