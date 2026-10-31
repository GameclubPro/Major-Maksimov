import { mergeEntityPresentation } from '../lib/entity-presentation';
import type { ManagedEntityPresentation } from '@maxim/contracts';
import { displayChatTitle } from '../lib/chat-titles';
import { useQueryClient } from '@tanstack/react-query';
import {
  Suspense,
  lazy,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router';
import type { ChatSummary, ManagedEntityFavoriteType } from '@maxim/contracts';
import { EntityAvatar } from '../components/ui/entity-avatar';
import { GlassCard } from '../components/ui/glass-card';
import {
  FilterGlyph,
  HOME_ENTITY_FAVORITE_ICONS,
  PlusCircleGlyph,
  RefreshGlyph,
  SearchGlyph,
  SettingsGlyph,
  StarGlyph,
  StatisticsGlyph,
  XmarkGlyph,
} from '../components/ui/compact-icons';
import { BackChevronIcon } from '../components/ui/entity-header-icons';
import { Skeleton, SkeletonCard } from '../components/ui/skeleton';
import { StatusState } from '../components/ui/status-state';
import { useToast } from '../components/ui/toast';
import type { ApiTransport } from '../lib/api/transport';
import { ApiRequestError } from '../lib/api-request-error';
import { saveChatTitle, saveChatTitles } from '../lib/chat-titles';
import { cn } from '../lib/cn';
import {
  HOME_ENTITY_FAVORITE_TYPES,
  getHomeEntityFavoriteTypes,
  isHomeEntityFavorite,
  orderHomeEntitiesByFavorites,
} from '../lib/home-entity-favorites';
import { useHomeEntityFavorites } from '../lib/home-entity-favorites-context';
import {
  buildManagedEntityHomeSnapshotStorageKey,
  buildManagedEntitySettingsRoute,
  buildManagedEntityStatsPreferenceStorageKey,
  buildManagedEntityStatisticsRoute,
  createManagedEntityWorkspaceState,
  getManagedEntitySessionStorage,
  mergeManagedEntityStatsPreference,
  mergeManagedEntityWorkspaceRouteState,
  preserveManagedEntityRouteContext,
  readManagedEntityHomeSnapshot,
  readManagedEntityStatsPreference,
  readManagedEntityWorkspaceState,
  resolveManagedEntityHomeAnchor,
  saveManagedEntityHomeSnapshot,
  type ManagedEntityHomeFocusTarget,
  type ManagedEntityHomeSnapshot,
  type ManagedEntityStatsPreference,
} from '../lib/managed-entity-workspace';
import {
  buildHomeView,
  normalizeEntityType,
  readLastEntityType,
  saveLastEntityId,
  saveLastEntityType,
} from '../lib/last-chat';
import { useNativeBackHandler } from '../lib/native-back';
import { channelStatsQueryKey, logsDashboardQueryKey } from '../lib/query-key-builders';
import { useManagedEntitiesSync } from '../lib/use-managed-entities-sync';
import {
  MANAGED_ENTITIES_VISIBILITY_REFRESH_MIN_HIDDEN_MS,
  buildManagedEntitiesSettledMarker,
  useManagedEntitiesVisibilityRefresh,
} from '../lib/use-managed-entities-visibility-refresh';
import {
  preloadChannelSettingsPage,
  preloadChannelStatsPage,
  preloadEventsPage,
  preloadSettingsPage,
} from './page-preloads';
import {
  createHomeRefreshCooldownDeadline,
  getHomeRefreshCooldownRemainingSec,
} from './home-refresh-cooldown';
import './chats-page.css';
import './chats-page-native.css';
import '../styles/moderation-catalogue-palette.css';
import '../styles/moderation-catalogue-steel.css';
import './chats-page-signal.css';

type ManagedTab = 'chat' | 'channel';
type HomeSyncTone = 'ready' | 'syncing' | 'error';
type ManagedHomeEntity = ChatSummary;
type ManagedEntitiesReloadRequest = {
  nonce: number;
  behavior: 'default' | 'manual' | 'recovery';
};
type PendingHomeSnapshotRestore = {
  restoreKey: string;
  snapshot: ManagedEntityHomeSnapshot;
};
type WindowWithIdleCallback = {
  requestIdleCallback?: (callback: () => void, options?: { timeout?: number }) => number;
  cancelIdleCallback?: (handle: number) => void;
};

const CHAT_CARD_STAGGER_STEP_MS = 45;
const CHAT_CARD_STAGGER_LIMIT = 10;
const CHAT_CARD_STAGGER_THRESHOLD = 24;
const DEFAULT_DASHBOARD_RANGE = '24h';
const DEFAULT_CHANNEL_STATS_RANGE = '7d';
const HOME_MANAGED_ENTITIES_VISIBILITY_REFRESH_MIN_INTERVAL_MS = 2_000;
const CHAT_LIST_VIRTUALIZATION_THRESHOLD = 80;
const CHAT_LIST_VIRTUAL_OVERSCAN = 6;
const CHAT_LIST_ROW_HEIGHT = 132;
const CHAT_LIST_VIRTUAL_ROW_PITCH = CHAT_LIST_ROW_HEIGHT + 8;
const CHAT_LIST_VIRTUAL_WINDOW_SIZE = 20;
const FAVORITE_FILTER_ALL = 'all';

async function describeChatsError(error: unknown, fallback: string): Promise<string> {
  try {
    const { describeUserFacingError } = await import('../lib/user-facing-error');
    return describeUserFacingError(error, fallback);
  } catch {
    return fallback;
  }
}

const LazyChatOnboardingSection = lazy(async () => {
  const module = await import('../components/chat-onboarding-section');
  return { default: module.ChatOnboardingSection };
});

const LazyPublikHandoff = lazy(async () => {
  const module = await import('../components/publik-handoff');
  return { default: module.PublikHandoff };
});

let homeEntitySheetsPromise: Promise<typeof import('./home-entity-sheets')> | null = null;
function preloadHomeEntitySheets() {
  homeEntitySheetsPromise ??= import('./home-entity-sheets').catch((error: unknown) => {
    homeEntitySheetsPromise = null;
    throw error;
  });
  // Preloading may be interrupted by leaving the WebView; explicit opens still receive rejection.
  void homeEntitySheetsPromise.catch(() => undefined);
  return homeEntitySheetsPromise;
}
const LazyHomeEntitySheets = lazy(preloadHomeEntitySheets);
const LazyEntityPresentationLoader = lazy(() => import('../lib/entity-presentation-loader'));
const LazyHomeListStatus = lazy(() =>
  import('./home-list-status').catch(() => ({
    default: () => (
      <StatusState
        tone="warning"
        title="Не удалось загрузить состояние списка"
        action={
          <button
            type="button"
            className="button button--ghost"
            onClick={() => window.location.reload()}
          >
            Обновить
          </button>
        }
      />
    ),
  })),
);

function getEntitiesKey(tab: ManagedTab): 'chats' | 'channels' {
  return tab === 'chat' ? 'chats' : 'channels';
}

function shouldPrefetchFromPointerEvent(event: ReactPointerEvent<HTMLElement>): boolean {
  return event.pointerType === 'mouse';
}

function shouldPrefetchFromPressEvent(event: ReactPointerEvent<HTMLElement>): boolean {
  return event.pointerType !== 'mouse';
}

function buildHomeSyncStatus(options: {
  isLoading: boolean;
  isRefreshing: boolean;
  hasError: boolean;
  isBackoffActive: boolean;
  hasLoadedFromServer: boolean;
}): { label: string; tone: HomeSyncTone } {
  if (options.isLoading || options.isRefreshing) {
    return { label: 'Обновляем список', tone: 'syncing' };
  }

  if (options.hasError) {
    return { label: 'Не удалось обновить список', tone: 'error' };
  }

  if (options.isBackoffActive) {
    return { label: 'Обновление продолжится автоматически', tone: 'syncing' };
  }

  if (!options.hasLoadedFromServer) {
    return { label: 'Обновляем список', tone: 'syncing' };
  }

  return { label: 'Список обновлён', tone: 'ready' };
}

function buildEntityRouteState(entityType: ManagedTab, entity: ManagedHomeEntity) {
  if (entityType === 'channel') {
    return {
      chatTitle: entity.title,
      chatLink: entity.link ?? '',
      avatarUrl: entity.avatarUrl ?? null,
    };
  }

  return {
    chatTitle: entity.title,
    avatarUrl: entity.avatarUrl ?? null,
  };
}

function readCurrentHistoryIndex(): number | null {
  const historyIndex = (window.history.state as { idx?: unknown } | null)?.idx;
  return typeof historyIndex === 'number' && Number.isSafeInteger(historyIndex) && historyIndex >= 0
    ? historyIndex
    : null;
}

function replaceCurrentRouterState(routeState: Record<string, unknown>): void {
  const currentHistoryState =
    typeof window.history.state === 'object' && window.history.state !== null
      ? window.history.state
      : {};
  window.history.replaceState({ ...currentHistoryState, usr: routeState }, '');
}

function shouldHandleEntityLinkClick(event: ReactMouseEvent<HTMLAnchorElement>): boolean {
  return (
    event.button === 0 &&
    !event.defaultPrevented &&
    !event.metaKey &&
    !event.ctrlKey &&
    !event.shiftKey &&
    !event.altKey
  );
}

function readHomeSnapshotFromRouteState(
  routeState: unknown,
  entityType: ManagedTab,
): ManagedEntityHomeSnapshot | null {
  const workspace = readManagedEntityWorkspaceState(routeState);
  return workspace?.entityType === entityType ? (workspace.homeSnapshot ?? null) : null;
}

export function ChatsPage({ api }: { api: ApiTransport; botUrl: string | null }) {
  const queryClient = useQueryClient();
  const { pushToast } = useToast();
  const location = useLocation();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const activeTab = normalizeEntityType(
    searchParams.get('view'),
    readLastEntityType(),
  ) as ManagedTab;
  const initialHomeSnapshot = readHomeSnapshotFromRouteState(location.state, activeTab);
  const [query, setQuery] = useState(() => initialHomeSnapshot?.query ?? '');
  const { snapshot: favoritesSnapshot, actions: favoritesActions } = useHomeEntityFavorites();
  const currentUserId = favoritesSnapshot.actor.userId;
  const homeRootRef = useRef<HTMLDivElement | null>(null);
  const virtualListViewportRef = useRef<HTMLElement | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const homeOverlayTriggerRef = useRef<HTMLElement | null>(null);
  const categoryEditDoneRef = useRef<HTMLButtonElement | null>(null);
  const favoriteFilterTriggerRef = useRef<HTMLButtonElement | null>(null);
  const pendingHomeSnapshotRestoreRef = useRef<PendingHomeSnapshotRestore | null>(null);
  const homeSnapshotRestoreAttemptRef = useRef<string | null>(null);
  const entityNavigationPendingRef = useRef(false);
  const [virtualListScrollTop, setVirtualListScrollTop] = useState(0);
  const favoriteStorageScope = favoritesSnapshot.actor.scope;
  const homeEntityFavorites = favoritesSnapshot.assignments;
  const homeEntityFavoriteLabels = favoritesSnapshot.labels.overrides;
  const favoriteLabels = favoritesSnapshot.labels.resolved;
  const favoriteLabelsStatus =
    favoritesSnapshot.labels.status === 'ready'
      ? 'ready'
      : favoritesSnapshot.labels.status === 'error'
        ? 'api'
        : 'loading';
  const [favoriteFilter, setFavoriteFilter] = useState<
    ManagedEntityFavoriteType | typeof FAVORITE_FILTER_ALL
  >(() => initialHomeSnapshot?.filter ?? FAVORITE_FILTER_ALL);
  const [favoritePicker, setFavoritePicker] = useState<{
    entityType: ManagedTab;
    entity: ManagedHomeEntity;
  } | null>(null);
  const [favoriteFilterPickerOpen, setFavoriteFilterPickerOpen] = useState(false);
  const [favoriteLabelsEditorOpen, setFavoriteLabelsEditorOpen] = useState(false);
  const [connectSheetOpen, setConnectSheetOpen] = useState(false);
  const [categoryEditMode, setCategoryEditMode] = useState(false);
  const [savingFavoriteEntityKey, setSavingFavoriteEntityKey] = useState<string | null>(null);
  const homeOverlayOpen =
    connectSheetOpen ||
    Boolean(favoritePicker) ||
    favoriteFilterPickerOpen ||
    favoriteLabelsEditorOpen;

  useEffect(() => {
    setFavoriteLabelsEditorOpen(false);
  }, [api, favoriteStorageScope]);
  const [refreshRequestByTab, setRefreshRequestByTab] = useState<
    Record<ManagedTab, ManagedEntitiesReloadRequest>
  >({
    chat: { nonce: 0, behavior: 'default' },
    channel: { nonce: 0, behavior: 'default' },
  });
  const homeSnapshotRestoreKey = `${location.key}:${activeTab}`;

  useEffect(() => {
    if (homeSnapshotRestoreAttemptRef.current === homeSnapshotRestoreKey) {
      return;
    }

    let snapshot = readHomeSnapshotFromRouteState(location.state, activeTab);

    if (!snapshot && currentUserId) {
      const storage = getManagedEntitySessionStorage();
      const storageKey = buildManagedEntityHomeSnapshotStorageKey({
        userId: currentUserId,
        locationKey: location.key,
        entityType: activeTab,
      });
      snapshot = storage ? readManagedEntityHomeSnapshot(storage, storageKey) : null;
    }

    if (!snapshot && !currentUserId) {
      return;
    }

    homeSnapshotRestoreAttemptRef.current = homeSnapshotRestoreKey;
    if (!snapshot) {
      pendingHomeSnapshotRestoreRef.current = null;
      return;
    }

    pendingHomeSnapshotRestoreRef.current = {
      restoreKey: homeSnapshotRestoreKey,
      snapshot,
    };
    setQuery(snapshot.query);
    setFavoriteFilter(snapshot.filter);
  }, [activeTab, currentUserId, homeSnapshotRestoreKey, location.key, location.state]);

  useNativeBackHandler(
    () => {
      if (connectSheetOpen) {
        closeHomeEntitySheet();
      } else if (favoriteLabelsEditorOpen) {
        return true;
      } else if (favoritePicker) {
        setFavoritePicker(null);
      } else {
        setFavoriteFilterPickerOpen(false);
      }
      return true;
    },
    { enabled: homeOverlayOpen, priority: 650 },
  );

  useNativeBackHandler(
    () => {
      exitCategoryEditMode();
      return true;
    },
    { enabled: categoryEditMode && !homeOverlayOpen, priority: 600 },
  );

  const activeEntitiesKey = getEntitiesKey(activeTab);
  const chatsState = useManagedEntitiesSync({
    api,
    entityType: 'chat',
    enabled: activeTab === 'chat',
    reloadNonce: refreshRequestByTab.chat.nonce,
    reloadBehavior: refreshRequestByTab.chat.behavior,
    resumeOnVisibilityReturn: true,
    backgroundRefreshOnFirstLoad: true,
    freshOnBackgroundRefresh: false,
    freshOnManualReload: false,
    persistLocalCache: true,
    localCacheScope: 'home',
    keepVisibleOnSameSnapshotVersion: true,
    treatUserVisibleCompleteAsSettled: false,
  });
  const channelsState = useManagedEntitiesSync({
    api,
    entityType: 'channel',
    enabled: activeTab === 'channel',
    reloadNonce: refreshRequestByTab.channel.nonce,
    reloadBehavior: refreshRequestByTab.channel.behavior,
    resumeOnVisibilityReturn: true,
    backgroundRefreshOnFirstLoad: true,
    freshOnBackgroundRefresh: false,
    freshOnManualReload: false,
    persistLocalCache: true,
    localCacheScope: 'home',
    keepVisibleOnSameSnapshotVersion: true,
    treatUserVisibleCompleteAsSettled: false,
  });
  const authoritativeFavoriteEntitiesRef = useRef<{
    chats?: readonly ChatSummary[];
    channels?: readonly ChatSummary[];
  }>({});
  authoritativeFavoriteEntitiesRef.current = {
    chats: chatsState.hasLoadedFromServer ? (chatsState.data ?? []) : undefined,
    channels: channelsState.hasLoadedFromServer ? (channelsState.data ?? []) : undefined,
  };

  const activeEntities = useMemo(() => {
    return activeEntitiesKey === 'chats' ? chatsState.data : channelsState.data;
  }, [activeEntitiesKey, channelsState.data, chatsState.data]);

  const activeEntitiesState = activeTab === 'chat' ? chatsState : channelsState;
  const isLoading = activeEntitiesState.isLoading;
  const isFetching = activeEntitiesState.isRefreshing;
  const queryError = activeEntitiesState.error;
  const [queryErrorPresentation, setQueryErrorPresentation] = useState<{
    error: unknown;
    description: string;
  } | null>(null);
  useEffect(() => {
    let cancelled = false;
    if (!queryError) {
      setQueryErrorPresentation(null);
      return;
    }
    void describeChatsError(queryError, 'Попробуйте ещё раз.').then((description) => {
      if (!cancelled) setQueryErrorPresentation({ error: queryError, description });
    });
    return () => {
      cancelled = true;
    };
  }, [queryError]);
  const refreshState = activeEntitiesState.refreshState;
  const manualRefreshBlockedReason = refreshState?.manualRefreshBlockedReason ?? null;
  const [manualRefreshClockMs, setManualRefreshClockMs] = useState(() => Date.now());
  const chatsManualRefreshCooldown = useMemo(() => {
    const observedAtMs = Date.now();
    return {
      observedAtMs,
      deadlineAtMs: createHomeRefreshCooldownDeadline(
        chatsState.refreshState?.manualRefreshRetryAfterMs,
        observedAtMs,
      ),
    };
  }, [chatsState.refreshState]);
  const channelsManualRefreshCooldown = useMemo(() => {
    const observedAtMs = Date.now();
    return {
      observedAtMs,
      deadlineAtMs: createHomeRefreshCooldownDeadline(
        channelsState.refreshState?.manualRefreshRetryAfterMs,
        observedAtMs,
      ),
    };
  }, [channelsState.refreshState]);
  const manualRefreshCooldown =
    activeTab === 'chat' ? chatsManualRefreshCooldown : channelsManualRefreshCooldown;
  const manualRefreshRetryAfterSec = getHomeRefreshCooldownRemainingSec(
    manualRefreshCooldown.deadlineAtMs,
    Math.max(manualRefreshClockMs, manualRefreshCooldown.observedAtMs),
  );
  const isUserVisibleSyncSettled =
    activeEntitiesState.isSyncComplete ||
    activeEntitiesState.isUserVisibleComplete ||
    activeEntitiesState.isBackoffActive;
  const isSyncSettled = isUserVisibleSyncSettled;
  const isSyncPending = !isLoading && !queryError && !isSyncSettled;
  const isRefreshTemporarilyBlocked =
    manualRefreshBlockedReason === 'backoff' && (manualRefreshRetryAfterSec ?? 0) > 0;
  const isManualRefreshCoolingDown =
    manualRefreshBlockedReason === 'recent_sync' && (manualRefreshRetryAfterSec ?? 0) > 0;
  const isManualRefreshInProgressByState =
    manualRefreshBlockedReason === 'in_progress' &&
    !activeEntitiesState.isRefreshing &&
    !activeEntitiesState.isUserVisibleComplete;
  const isManualRefreshBlocked =
    isRefreshTemporarilyBlocked || isManualRefreshCoolingDown || isManualRefreshInProgressByState;
  const isForegroundSyncing = activeEntitiesState.isRefreshing && !isUserVisibleSyncSettled;
  const homeSyncStatus = buildHomeSyncStatus({
    isLoading,
    isRefreshing: isFetching || isManualRefreshInProgressByState,
    hasError: Boolean(queryError),
    isBackoffActive: activeEntitiesState.isBackoffActive,
    hasLoadedFromServer: activeEntitiesState.hasLoadedFromServer,
  });
  const homeSyncAccessibleLabel = `Статус списка: ${homeSyncStatus.label}`;
  const refreshProgressPercent =
    !activeEntitiesState.isUserVisibleComplete &&
    !activeEntitiesState.isBackoffActive &&
    typeof refreshState?.progressPercent === 'number'
      ? Math.max(0, Math.min(100, refreshState.progressPercent))
      : null;

  const hasNoActiveEntities =
    !isLoading && !queryError && Array.isArray(activeEntities) && activeEntities.length === 0;
  const showTransientEmptyState = hasNoActiveEntities && activeEntitiesState.isBackoffActive;
  const isNoEntitiesForTab = hasNoActiveEntities && isSyncSettled && !showTransientEmptyState;

  const filteredEntities = useMemo(() => {
    const [matchingEntities] = buildHomeView({
      entities: activeEntities,
      query,
    });
    if (categoryEditMode) {
      return matchingEntities;
    }

    const filteredByFavorite =
      favoriteFilter === FAVORITE_FILTER_ALL
        ? matchingEntities
        : matchingEntities.filter((entity) =>
            isHomeEntityFavorite(homeEntityFavorites, activeTab, entity.id, favoriteFilter),
          );

    return orderHomeEntitiesByFavorites(
      filteredByFavorite,
      homeEntityFavorites[activeTab],
      favoriteFilter === FAVORITE_FILTER_ALL ? HOME_ENTITY_FAVORITE_TYPES : [favoriteFilter],
    );
  }, [activeEntities, activeTab, categoryEditMode, favoriteFilter, homeEntityFavorites, query]);
  const favoriteCounts = useMemo(() => {
    if (!Array.isArray(activeEntities) || activeEntities.length === 0) {
      return HOME_ENTITY_FAVORITE_TYPES.reduce(
        (acc, favoriteType) => ({
          ...acc,
          [favoriteType]: 0,
        }),
        {} as Record<ManagedEntityFavoriteType, number>,
      );
    }

    return HOME_ENTITY_FAVORITE_TYPES.reduce(
      (acc, favoriteType) => {
        acc[favoriteType] = activeEntities.filter((entity) =>
          isHomeEntityFavorite(homeEntityFavorites, activeTab, entity.id, favoriteType),
        ).length;
        return acc;
      },
      {} as Record<ManagedEntityFavoriteType, number>,
    );
  }, [activeEntities, activeTab, homeEntityFavorites]);
  const hasSearchQuery = query.trim().length > 0;
  const showEmptyState = isNoEntitiesForTab;
  const limitedStagger =
    filteredEntities.length > CHAT_CARD_STAGGER_THRESHOLD ? CHAT_CARD_STAGGER_LIMIT : null;
  const virtualizationContextKey = JSON.stringify([
    activeTab,
    query,
    favoriteFilter,
    categoryEditMode,
  ]);
  const virtualizationCanInitialize =
    filteredEntities.length > 0 || isSyncSettled || Boolean(queryError);
  const [virtualizationDecision, setVirtualizationDecision] = useState(() => ({
    contextKey: virtualizationContextKey,
    initialized: virtualizationCanInitialize,
    enabled: filteredEntities.length > CHAT_LIST_VIRTUALIZATION_THRESHOLD,
  }));
  const shouldVirtualizeEntities =
    virtualizationDecision.contextKey === virtualizationContextKey &&
    virtualizationDecision.initialized
      ? virtualizationDecision.enabled
      : virtualizationCanInitialize && filteredEntities.length > CHAT_LIST_VIRTUALIZATION_THRESHOLD;

  useEffect(() => {
    setVirtualizationDecision((current) => {
      if (current.contextKey === virtualizationContextKey && current.initialized) {
        return current;
      }

      const next = {
        contextKey: virtualizationContextKey,
        initialized: virtualizationCanInitialize,
        enabled: filteredEntities.length > CHAT_LIST_VIRTUALIZATION_THRESHOLD,
      };
      return JSON.stringify(current) === JSON.stringify(next) ? current : next;
    });
  }, [filteredEntities.length, virtualizationCanInitialize, virtualizationContextKey]);
  const virtualStartIndex = shouldVirtualizeEntities
    ? Math.max(
        0,
        Math.floor(virtualListScrollTop / CHAT_LIST_VIRTUAL_ROW_PITCH) - CHAT_LIST_VIRTUAL_OVERSCAN,
      )
    : 0;
  const virtualEndIndex = shouldVirtualizeEntities
    ? Math.min(filteredEntities.length, virtualStartIndex + CHAT_LIST_VIRTUAL_WINDOW_SIZE)
    : filteredEntities.length;
  const renderedEntities = shouldVirtualizeEntities
    ? filteredEntities.slice(virtualStartIndex, virtualEndIndex)
    : filteredEntities;
  const presentationScope = `${favoriteStorageScope}:${activeTab}`;
  const [presentationState, setPresentationState] = useState<{
    scope: string;
    items: Record<string, ManagedEntityPresentation>;
  }>({ scope: presentationScope, items: {} });
  const entityPresentations =
    presentationState.scope === presentationScope ? presentationState.items : {};
  const settledRefreshMarker = useMemo(
    () =>
      buildManagedEntitiesSettledMarker({
        scopeKey: activeTab,
        hasLoadedFromServer: activeEntitiesState.hasLoadedFromServer,
        isSyncComplete:
          activeEntitiesState.isSyncComplete || activeEntitiesState.isUserVisibleComplete,
        isBackoffActive: activeEntitiesState.isBackoffActive,
        snapshotVersion: activeEntitiesState.snapshot?.version,
        snapshotBuiltAt: activeEntitiesState.snapshot?.builtAt,
        lastSyncedAt: activeEntitiesState.refreshState?.lastSyncedAt,
      }),
    [
      activeEntitiesState.hasLoadedFromServer,
      activeEntitiesState.isBackoffActive,
      activeEntitiesState.isSyncComplete,
      activeEntitiesState.isUserVisibleComplete,
      activeEntitiesState.refreshState?.lastSyncedAt,
      activeEntitiesState.snapshot?.builtAt,
      activeEntitiesState.snapshot?.version,
      activeTab,
    ],
  );
  const { noteRefreshRequested } = useManagedEntitiesVisibilityRefresh({
    enabled: true,
    hasLoadedFromServer: activeEntitiesState.hasLoadedFromServer,
    isLoading: activeEntitiesState.isLoading,
    isRefreshing: activeEntitiesState.isRefreshing,
    isSyncComplete: activeEntitiesState.isSyncComplete || activeEntitiesState.isUserVisibleComplete,
    snapshotStale: activeEntitiesState.snapshot?.stale ?? null,
    settledMarker: settledRefreshMarker,
    minIntervalMs: HOME_MANAGED_ENTITIES_VISIBILITY_REFRESH_MIN_INTERVAL_MS,
    minHiddenDurationMs: MANAGED_ENTITIES_VISIBILITY_REFRESH_MIN_HIDDEN_MS,
    onVisibilityReturnRefresh: () => {
      handleRefresh(activeTab, 'recovery');
    },
  });

  useEffect(() => {
    const deadlineAtMs = manualRefreshCooldown.deadlineAtMs;
    if (deadlineAtMs === null) {
      return undefined;
    }

    const remainingMs = deadlineAtMs - Date.now();
    if (remainingMs <= 0) {
      if (manualRefreshClockMs < deadlineAtMs) {
        setManualRefreshClockMs(Date.now());
      }
      return undefined;
    }

    const timeoutId = window.setTimeout(
      () => setManualRefreshClockMs(Date.now()),
      Math.min(1_000, remainingMs),
    );
    return () => window.clearTimeout(timeoutId);
  }, [manualRefreshClockMs, manualRefreshCooldown.deadlineAtMs]);

  useEffect(() => {
    const updateClockWhenVisible = () => {
      if (document.visibilityState === 'visible') {
        setManualRefreshClockMs(Date.now());
      }
    };

    document.addEventListener('visibilitychange', updateClockWhenVisible);
    return () => document.removeEventListener('visibilitychange', updateClockWhenVisible);
  }, []);

  function queueRefresh(tab: ManagedTab, behavior: ManagedEntitiesReloadRequest['behavior']) {
    noteRefreshRequested();
    setRefreshRequestByTab((current) => ({
      ...current,
      [tab]: {
        nonce: current[tab].nonce + 1,
        behavior,
      },
    }));
  }

  function handleRefresh(
    tab: ManagedTab = activeTab,
    behavior: ManagedEntitiesReloadRequest['behavior'] = 'default',
  ) {
    if (isFetching) {
      return;
    }
    if (behavior !== 'recovery' && isManualRefreshBlocked) {
      if (isManualRefreshCoolingDown) {
        pushToast({
          tone: 'info',
          title: 'Список уже обновлён',
          description: manualRefreshRetryAfterSec
            ? `Повторить можно через ${manualRefreshRetryAfterSec} с.`
            : undefined,
        });
      } else if (isRefreshTemporarilyBlocked) {
        pushToast({
          tone: 'info',
          title: 'Обновление уже запланировано',
          description: manualRefreshRetryAfterSec
            ? `Повторим автоматически через ${manualRefreshRetryAfterSec} с.`
            : 'Повторим автоматически.',
        });
      }
      return;
    }

    queueRefresh(tab, behavior);
  }

  useEffect(() => {
    const allEntities = [...(chatsState.data ?? []), ...(channelsState.data ?? [])];
    if (allEntities.length === 0) {
      return;
    }

    saveChatTitles(allEntities);
  }, [channelsState.data, chatsState.data]);

  useEffect(() => {
    favoritesActions.reconcileLoadedEntities(authoritativeFavoriteEntitiesRef.current);
  }, [
    favoritesActions,
    channelsState.data,
    channelsState.hasLoadedFromServer,
    chatsState.data,
    chatsState.hasLoadedFromServer,
  ]);

  useEffect(() => {
    const controller = new AbortController();
    void favoritesActions.refreshAssignments(activeTab, controller.signal).catch(() => undefined);
    return () => controller.abort();
  }, [favoritesActions, activeTab, refreshRequestByTab[activeTab].nonce]);

  useEffect(() => {
    saveLastEntityType(activeTab);
  }, [activeTab]);

  useEffect(() => {
    setCategoryEditMode(false);
    setFavoritePicker(null);
  }, [activeTab]);

  useEffect(() => {
    if (pendingHomeSnapshotRestoreRef.current?.restoreKey === homeSnapshotRestoreKey) {
      return;
    }

    setVirtualListScrollTop(0);
    if (virtualListViewportRef.current) {
      virtualListViewportRef.current.scrollTop = 0;
    }
  }, [
    activeTab,
    categoryEditMode,
    favoriteFilter,
    homeSnapshotRestoreKey,
    query,
    shouldVirtualizeEntities,
  ]);

  useEffect(() => {
    const pendingRestore = pendingHomeSnapshotRestoreRef.current;
    if (
      pendingRestore?.restoreKey !== homeSnapshotRestoreKey ||
      isLoading ||
      queryError ||
      !isSyncSettled
    ) {
      return undefined;
    }

    const resolution = resolveManagedEntityHomeAnchor(
      pendingRestore.snapshot,
      filteredEntities.map((entity) => entity.id),
    );
    let firstAnimationFrame = 0;
    let secondAnimationFrame = 0;

    if (resolution.kind === 'entity' && shouldVirtualizeEntities) {
      const targetScrollTop = Math.max(
        0,
        resolution.index * CHAT_LIST_VIRTUAL_ROW_PITCH - resolution.offset,
      );
      setVirtualListScrollTop(targetScrollTop);
      if (virtualListViewportRef.current) {
        virtualListViewportRef.current.scrollTop = targetScrollTop;
      }
    }

    firstAnimationFrame = window.requestAnimationFrame(() => {
      secondAnimationFrame = window.requestAnimationFrame(() => {
        const root = homeRootRef.current;
        const entityCard =
          resolution.kind === 'entity'
            ? (Array.from(root?.querySelectorAll<HTMLElement>('[data-entity-id]') ?? []).find(
                (element) => element.dataset.entityId === resolution.id,
              ) ?? null)
            : null;

        if (resolution.kind === 'entity' && entityCard && !shouldVirtualizeEntities) {
          const targetScrollTop = Math.max(
            0,
            window.scrollY + entityCard.getBoundingClientRect().top - resolution.offset,
          );
          window.scrollTo({ top: targetScrollTop, left: 0, behavior: 'auto' });
        } else if (resolution.kind === 'search-heading') {
          window.scrollTo({ top: 0, left: 0, behavior: 'auto' });
        }

        const action =
          resolution.kind === 'entity' && resolution.focusTarget === 'statistics'
            ? 'statistics'
            : 'settings';
        const focusTarget =
          entityCard?.querySelector<HTMLElement>(`[data-action="${action}"]`) ??
          searchInputRef.current;
        focusTarget?.focus({ preventScroll: true });
        pendingHomeSnapshotRestoreRef.current = null;
      });
    });

    return () => {
      window.cancelAnimationFrame(firstAnimationFrame);
      window.cancelAnimationFrame(secondAnimationFrame);
    };
  }, [
    filteredEntities,
    homeSnapshotRestoreKey,
    isLoading,
    isSyncSettled,
    queryError,
    shouldVirtualizeEntities,
  ]);

  useEffect(() => {
    document.body.classList.add('chats-home-page-open');

    return () => {
      document.body.classList.remove('chats-home-page-open');
    };
  }, []);

  useEffect(() => {
    if (!homeOverlayOpen) {
      return undefined;
    }

    const { body, documentElement } = document;
    const homeRoot = homeRootRef.current;
    const bottomNav = homeRoot
      ?.closest('.app-shell')
      ?.querySelector<HTMLElement>(':scope > .bottom-nav');
    const previousBodyOverflow = body.style.overflow;
    const previousDocumentOverflow = documentElement.style.overflow;
    const previousHomeInert = homeRoot?.inert ?? false;
    const previousBottomNavInert = bottomNav?.inert ?? false;

    body.classList.add('favorite-picker-open');
    body.style.overflow = 'hidden';
    documentElement.style.overflow = 'hidden';
    if (homeRoot) {
      homeRoot.inert = true;
    }
    if (bottomNav) {
      bottomNav.inert = true;
    }

    return () => {
      body.classList.remove('favorite-picker-open');
      body.style.overflow = previousBodyOverflow;
      documentElement.style.overflow = previousDocumentOverflow;
      if (homeRoot) {
        homeRoot.inert = previousHomeInert;
      }
      if (bottomNav) {
        bottomNav.inert = previousBottomNavInert;
      }
      const restoreTarget = homeOverlayTriggerRef.current;
      homeOverlayTriggerRef.current = null;
      if (restoreTarget?.isConnected) {
        window.requestAnimationFrame(() => restoreTarget.focus());
      }
    };
  }, [homeOverlayOpen]);

  useEffect(() => {
    if (!homeOverlayOpen) {
      return undefined;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') {
        return;
      }
      if (favoriteLabelsEditorOpen) {
        return;
      }

      event.preventDefault();
      event.stopImmediatePropagation();
      if (connectSheetOpen) {
        closeHomeEntitySheet();
        return;
      }
      if (favoritePicker) {
        setFavoritePicker(null);
        return;
      }
      setFavoriteFilterPickerOpen(false);
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [connectSheetOpen, favoriteLabelsEditorOpen, favoritePicker, homeOverlayOpen]);

  useEffect(() => {
    if (!categoryEditMode || homeOverlayOpen) {
      return undefined;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') {
        return;
      }
      event.preventDefault();
      exitCategoryEditMode();
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [categoryEditMode, homeOverlayOpen]);

  useEffect(() => {
    if (showEmptyState) {
      void preloadHomeEntitySheets();
    }
  }, [showEmptyState]);

  function prefetchChatSettings(chatId: string) {
    void chatId;
    void preloadSettingsPage().catch(() => undefined);
  }

  function prefetchChatEvents(chatId: string, preference: ManagedEntityStatsPreference) {
    void preloadEventsPage().catch(() => undefined);
    if (preference.section === 'participants') {
      return;
    }

    const range = preference.range ?? DEFAULT_DASHBOARD_RANGE;
    const includeModerationPreview = preference.section === 'moderation';
    const includeActivityPreview = !includeModerationPreview;
    void queryClient
      .prefetchQuery({
        queryKey: logsDashboardQueryKey(
          chatId,
          range,
          includeActivityPreview,
          includeModerationPreview,
        ),
        queryFn: async ({ signal }) => {
          const client = await import('../lib/api/events-client');
          return includeModerationPreview
            ? client.getChatModerationDashboard(api, chatId, range, { signal })
            : client.getChatActivityDashboard(api, chatId, range, { signal });
        },
      })
      .catch(() => undefined);
  }

  function prefetchChannelSettings(chatId: string) {
    void chatId;
    void preloadChannelSettingsPage().catch(() => undefined);
  }

  function rememberEntity(entityType: ManagedTab, entity: ManagedHomeEntity) {
    saveLastEntityId(entityType, entity.id);
    saveChatTitle(entity.id, entity.title);
  }

  function createHomeSnapshot(
    entity: ManagedHomeEntity,
    index: number,
    focusTarget: ManagedEntityHomeFocusTarget,
    trigger: HTMLAnchorElement,
  ): ManagedEntityHomeSnapshot {
    const entityCard = trigger.closest<HTMLElement>('[data-entity-id]');
    const scrollMode = shouldVirtualizeEntities ? 'virtual' : 'document';
    const viewportTop =
      scrollMode === 'virtual'
        ? (virtualListViewportRef.current?.getBoundingClientRect().top ?? 0)
        : 0;
    const offset = Math.max(
      0,
      (entityCard?.getBoundingClientRect().top ?? viewportTop) - viewportTop,
    );

    return {
      query,
      filter: favoriteFilter,
      anchor: {
        id: entity.id,
        index,
        offset,
      },
      focusTarget,
      scrollMode,
    };
  }

  function readEntityStatsPreference(entityId: string) {
    const currentWorkspace = readManagedEntityWorkspaceState(location.state);
    const matchingWorkspace =
      currentWorkspace?.entityType === activeTab && currentWorkspace.entityId === entityId
        ? currentWorkspace
        : null;
    const sessionStorage = getManagedEntitySessionStorage();
    const persistedStatsPreference = sessionStorage
      ? readManagedEntityStatsPreference(
          sessionStorage,
          buildManagedEntityStatsPreferenceStorageKey({
            locationKey: location.key,
            entityType: activeTab,
            entityId,
          }),
          activeTab,
        )
      : {};

    return mergeManagedEntityStatsPreference(
      activeTab,
      matchingWorkspace?.statsPreference,
      persistedStatsPreference,
    );
  }

  function handleEntityNavigation(
    event: ReactMouseEvent<HTMLAnchorElement>,
    entity: ManagedHomeEntity,
    index: number,
    focusTarget: ManagedEntityHomeFocusTarget,
    targetRoute: string,
  ) {
    if (!shouldHandleEntityLinkClick(event)) {
      return;
    }

    event.preventDefault();
    if (entityNavigationPendingRef.current) {
      return;
    }
    entityNavigationPendingRef.current = true;

    const homeSnapshot = createHomeSnapshot(entity, index, focusTarget, event.currentTarget);
    const historyIndex = readCurrentHistoryIndex();
    const sessionStorage = getManagedEntitySessionStorage();
    const statsPreference = readEntityStatsPreference(entity.id);
    const workspace = createManagedEntityWorkspaceState({
      entityType: activeTab,
      entityId: entity.id,
      origin:
        historyIndex === null
          ? null
          : {
              locationKey: location.key,
              historyIndex,
            },
      homeSnapshot,
      statsPreference,
    });
    const homeRouteState = mergeManagedEntityWorkspaceRouteState(location.state, workspace);
    const identityState = buildEntityRouteState(activeTab, entity);
    const detailRouteState = mergeManagedEntityWorkspaceRouteState(
      {
        ...(typeof location.state === 'object' && location.state !== null ? location.state : {}),
        ...identityState,
      },
      workspace,
    );

    replaceCurrentRouterState(homeRouteState);
    if (currentUserId && sessionStorage) {
      saveManagedEntityHomeSnapshot(
        sessionStorage,
        buildManagedEntityHomeSnapshotStorageKey({
          userId: currentUserId,
          locationKey: location.key,
          entityType: activeTab,
        }),
        homeSnapshot,
      );
    }
    const resolvedTargetRoute =
      focusTarget === 'statistics'
        ? preserveManagedEntityRouteContext(
            buildManagedEntityStatisticsRoute(activeTab, entity.id, statsPreference),
            location.search,
            location.hash,
          )
        : targetRoute;
    navigate(resolvedTargetRoute, { state: detailRouteState });
  }

  function prefetchEntitySettings(entityType: ManagedTab, entityId: string) {
    if (entityType === 'channel') {
      prefetchChannelSettings(entityId);
      return;
    }

    prefetchChatSettings(entityId);
  }

  function prefetchEntityActivity(
    entityType: ManagedTab,
    entityId: string,
    preference: ManagedEntityStatsPreference,
  ) {
    if (entityType === 'channel') {
      prefetchChannelStats(entityId, preference);
      return;
    }

    prefetchChatEvents(entityId, preference);
  }

  function buildFavoriteEntityKey(entityType: ManagedTab, entityId: string) {
    return `${entityType}:${entityId}`;
  }

  function openFavoriteLabelsEditor(trigger?: HTMLElement) {
    if (favoriteLabelsStatus !== 'ready') {
      void favoritesActions.refreshLabels().catch(() => undefined);
      return;
    }
    if (trigger) {
      homeOverlayTriggerRef.current = trigger;
    }
    setFavoriteFilterPickerOpen(false);
    setFavoritePicker(null);
    setFavoriteLabelsEditorOpen(true);
  }

  function openFavoriteFilterPicker(trigger: HTMLElement) {
    homeOverlayTriggerRef.current = trigger;
    setFavoriteLabelsEditorOpen(false);
    setFavoritePicker(null);
    setFavoriteFilterPickerOpen(true);
  }

  function enterCategoryEditMode() {
    closeHomeEntitySheet();
    setCategoryEditMode(true);
    window.requestAnimationFrame(() => categoryEditDoneRef.current?.focus());
  }

  function exitCategoryEditMode() {
    setFavoritePicker(null);
    setCategoryEditMode(false);
    window.requestAnimationFrame(() => favoriteFilterTriggerRef.current?.focus());
  }

  function closeHomeEntitySheet() {
    setFavoriteLabelsEditorOpen(false);
    setFavoriteFilterPickerOpen(false);
    setFavoritePicker(null);
    setConnectSheetOpen(false);
  }

  async function openConnectSheet(trigger: HTMLElement) {
    homeOverlayTriggerRef.current = trigger;
    try {
      await preloadHomeEntitySheets();
    } catch {
      pushToast({
        title: 'Не удалось открыть подключение',
        description: 'Попробуйте ещё раз.',
        tone: 'danger',
      });
      return;
    }
    if (!trigger.isConnected) {
      return;
    }
    setFavoriteLabelsEditorOpen(false);
    setFavoriteFilterPickerOpen(false);
    setFavoritePicker(null);
    setConnectSheetOpen(true);
  }

  async function handleSetHomeEntityFavoriteType(
    entityType: ManagedTab,
    entityId: string,
    favoriteType: ManagedEntityFavoriteType | null,
  ) {
    if (savingFavoriteEntityKey !== null) {
      return;
    }

    const expectedFavoriteType =
      getHomeEntityFavoriteTypes(homeEntityFavorites, entityType, entityId)[0] ?? null;
    setSavingFavoriteEntityKey(buildFavoriteEntityKey(entityType, entityId));
    try {
      const result = await favoritesActions.setFavorite({
        entityType,
        entityId,
        expectedFavoriteType,
        favoriteType,
      });
      setFavoritePicker((current) =>
        current?.entityType === entityType && current.entity.id === entityId ? null : current,
      );
      if (result.refresh === 'pending')
        pushToast({
          title: 'Категория сохранена',
          description: 'Обновите список, чтобы увидеть актуальный состав.',
          tone: 'info',
        });
    } catch (error) {
      pushToast({
        title:
          error instanceof ApiRequestError && error.status === 409
            ? 'Состав избранного изменился'
            : 'Проверьте сохранение категории',
        description: 'Обновите состав перед следующим сохранением.',
        tone: 'danger',
      });
    } finally {
      setSavingFavoriteEntityKey((current) =>
        current === buildFavoriteEntityKey(entityType, entityId) ? null : current,
      );
    }
  }

  function prefetchChannelStats(chatId: string, preference: ManagedEntityStatsPreference) {
    void preloadChannelStatsPage().catch(() => undefined);
    const range = preference.range ?? DEFAULT_CHANNEL_STATS_RANGE;
    void queryClient
      .prefetchQuery({
        queryKey: channelStatsQueryKey(chatId, range, 'overview'),
        queryFn: async ({ signal }) => {
          const { getChannelStats } = await import('../lib/api/channel-stats-client');
          return getChannelStats(
            api,
            chatId,
            range,
            { signal },
            {
              includeActivityPreview: false,
              mode: 'overview',
            },
          );
        },
      })
      .catch(() => undefined);
  }

  useEffect(() => {
    if (filteredEntities.length === 0) {
      return undefined;
    }

    let cancelled = false;
    const run = () => {
      if (cancelled) {
        return;
      }

      void preloadHomeEntitySheets();
      // FLAG: Idle work may preload code, never settings or MAX checks for unopened chats.
    };
    const idleWindow = window as unknown as WindowWithIdleCallback;
    const idleHandle = idleWindow.requestIdleCallback
      ? idleWindow.requestIdleCallback(run, { timeout: 1_200 })
      : window.setTimeout(run, 450);

    return () => {
      cancelled = true;
      if (idleWindow.cancelIdleCallback && idleWindow.requestIdleCallback) {
        idleWindow.cancelIdleCallback(idleHandle);
      } else {
        window.clearTimeout(idleHandle);
      }
    };
  }, [activeTab, filteredEntities]);

  const tabLabel = activeTab === 'chat' ? 'Чаты' : 'Каналы';
  const searchLabel = activeTab === 'chat' ? 'Поиск по чатам' : 'Поиск по каналам';
  const searchPlaceholder = 'Поиск';
  const refreshButtonLabel =
    isFetching || isManualRefreshInProgressByState
      ? 'Обновляем список'
      : homeSyncStatus.tone === 'error'
        ? 'Повторить обновление списка'
        : 'Обновить список';
  const activeFavoriteFilterLabel =
    favoriteFilter === FAVORITE_FILTER_ALL ? null : favoriteLabels[favoriteFilter];
  const favoriteFilterButtonLabel = activeFavoriteFilterLabel
    ? `Фильтр: ${activeFavoriteFilterLabel}`
    : 'Фильтр категорий';
  const homeResultStatus = queryError
    ? ''
    : isLoading
      ? `Загружаем ${tabLabel.toLowerCase()}.`
      : `${tabLabel}: ${filteredEntities.length} из ${activeEntities?.length ?? 0}.`;

  function renderEntityCard(original: ManagedHomeEntity, index: number) {
    const entity = mergeEntityPresentation(original, entityPresentations[original.id]);
    const title = displayChatTitle(entity.id, entity.title, activeTab);
    const favorite = isHomeEntityFavorite(homeEntityFavorites, activeTab, entity.id);
    const favoriteTypes = getHomeEntityFavoriteTypes(homeEntityFavorites, activeTab, entity.id);
    const staggerIndex = limitedStagger === null ? index : index < limitedStagger ? index : null;
    const className = cn(
      'chat-card',
      favorite && 'is-favorite',
      favoriteTypes[0] && `is-${favoriteTypes[0]}`,
      categoryEditMode && 'chat-card--category-editing',
      staggerIndex !== null && 'stagger-in',
    );
    let style: CSSProperties | undefined;
    if (shouldVirtualizeEntities) {
      style = {
        top: index * CHAT_LIST_VIRTUAL_ROW_PITCH,
        height: CHAT_LIST_ROW_HEIGHT,
      };
      if (staggerIndex !== null) {
        style.animationDelay = `${staggerIndex * CHAT_CARD_STAGGER_STEP_MS}ms`;
      }
    } else if (staggerIndex !== null) {
      style = { animationDelay: `${staggerIndex * CHAT_CARD_STAGGER_STEP_MS}ms` };
    }

    const settingsRoute = preserveManagedEntityRouteContext(
      buildManagedEntitySettingsRoute(activeTab, entity.id),
      location.search,
      location.hash,
    );
    const statsPreference = readEntityStatsPreference(entity.id);
    const statisticsRoute = preserveManagedEntityRouteContext(
      buildManagedEntityStatisticsRoute(activeTab, entity.id, statsPreference),
      location.search,
      location.hash,
    );
    const routeState = buildEntityRouteState(activeTab, entity);
    const primaryFavoriteType = favoriteTypes[0] ?? null;
    const CategoryIcon = primaryFavoriteType
      ? HOME_ENTITY_FAVORITE_ICONS[primaryFavoriteType]
      : PlusCircleGlyph;
    const categoryLabel = primaryFavoriteType
      ? favoriteLabels[primaryFavoriteType]
      : 'Без категории';
    const pickerOpen =
      favoritePicker?.entityType === activeTab && favoritePicker.entity.id === entity.id;

    return (
      <GlassCard
        as="article"
        key={entity.id}
        className={className}
        style={style}
        role="listitem"
        aria-posinset={index + 1}
        aria-setsize={filteredEntities.length}
        data-entity-id={entity.id}
      >
        {categoryEditMode ? (
          <button
            type="button"
            className="chat-card__primary-link chat-card__category-editor"
            aria-label={`Выбрать категорию: ${title}. Сейчас: ${categoryLabel}`}
            aria-haspopup="dialog"
            aria-controls="home-sheet-favorite"
            aria-expanded={pickerOpen}
            disabled={savingFavoriteEntityKey !== null}
            onPointerEnter={() => void preloadHomeEntitySheets()}
            onPointerDown={() => void preloadHomeEntitySheets()}
            onClick={(event) => {
              if (savingFavoriteEntityKey !== null) {
                return;
              }
              homeOverlayTriggerRef.current = event.currentTarget;
              setFavoritePicker({ entityType: activeTab, entity });
            }}
          >
            <EntityAvatar
              entityId={entity.id}
              retryKey={`${entityPresentations[entity.id]?.observedAt ?? ''}:${refreshRequestByTab[activeTab].nonce}`}
              title={title}
              entityType={activeTab}
              avatarUrl={entity.avatarUrl ?? null}
              className="chat-card__avatar"
            />
            <span className="chat-card__title-wrap">
              <h3>{title}</h3>
              <span className={cn('chat-card__category-value', primaryFavoriteType && 'is-active')}>
                <CategoryIcon aria-hidden focusable="false" />
                <span>{categoryLabel}</span>
              </span>
            </span>
            <span className="chat-card__chevron" aria-hidden>
              <BackChevronIcon />
            </span>
          </button>
        ) : (
          <Link
            to={settingsRoute}
            className="chat-card__primary-link"
            state={routeState}
            data-action="settings"
            onClick={(event) => {
              rememberEntity(activeTab, entity);
              prefetchEntitySettings(activeTab, entity.id);
              handleEntityNavigation(event, entity, index, 'settings', settingsRoute);
            }}
            onPointerEnter={(event) => {
              if (shouldPrefetchFromPointerEvent(event)) {
                prefetchEntitySettings(activeTab, entity.id);
              }
            }}
            onPointerDown={(event) => {
              if (shouldPrefetchFromPressEvent(event)) {
                prefetchEntitySettings(activeTab, entity.id);
              }
            }}
            aria-label={`Открыть настройки: ${title}${
              primaryFavoriteType ? `. Категория: ${categoryLabel}` : ''
            }`}
          >
            <EntityAvatar
              entityId={entity.id}
              retryKey={`${entityPresentations[entity.id]?.observedAt ?? ''}:${refreshRequestByTab[activeTab].nonce}`}
              title={title}
              entityType={activeTab}
              avatarUrl={entity.avatarUrl ?? null}
              className="chat-card__avatar"
            />
            <span className="chat-card__title-wrap">
              <h3>{title}</h3>
            </span>
            <span className="chat-card__chevron" aria-hidden>
              <BackChevronIcon />
            </span>
          </Link>
        )}

        {!categoryEditMode ? (
          <>
            <button
              type="button"
              className={cn(
                'chat-card__action',
                'chat-card__action--favorite',
                primaryFavoriteType && 'is-active',
              )}
              aria-label={
                primaryFavoriteType
                  ? `Изменить категорию избранного: ${title}. Сейчас: ${categoryLabel}`
                  : `Добавить в избранное: ${title}`
              }
              title={primaryFavoriteType ? `Избранное: ${categoryLabel}` : 'Добавить в избранное'}
              aria-haspopup="dialog"
              aria-controls="home-sheet-favorite"
              aria-expanded={pickerOpen}
              disabled={savingFavoriteEntityKey !== null}
              onPointerEnter={() => void preloadHomeEntitySheets()}
              onPointerDown={() => void preloadHomeEntitySheets()}
              onFocus={() => void preloadHomeEntitySheets()}
              onClick={(event) => {
                if (savingFavoriteEntityKey !== null) {
                  return;
                }
                homeOverlayTriggerRef.current = event.currentTarget;
                setFavoritePicker({ entityType: activeTab, entity });
              }}
            >
              <span className="chat-card__favorite-mark" aria-hidden>
                {primaryFavoriteType ? (
                  <CategoryIcon className="chat-card__favorite-symbol" focusable="false" />
                ) : (
                  <StarGlyph className="chat-card__favorite-symbol" focusable="false" />
                )}
              </span>
            </button>
            <div className="chat-card__row-actions">
              <Link
                to={settingsRoute}
                className="chat-card__action chat-card__action--settings"
                state={routeState}
                data-action="settings"
                aria-label={`Открыть настройки: ${title}`}
                onClick={(event) => {
                  rememberEntity(activeTab, entity);
                  prefetchEntitySettings(activeTab, entity.id);
                  handleEntityNavigation(event, entity, index, 'settings', settingsRoute);
                }}
                onPointerEnter={(event) => {
                  if (shouldPrefetchFromPointerEvent(event)) {
                    prefetchEntitySettings(activeTab, entity.id);
                  }
                }}
                onPointerDown={(event) => {
                  if (shouldPrefetchFromPressEvent(event)) {
                    prefetchEntitySettings(activeTab, entity.id);
                  }
                }}
              >
                <SettingsGlyph aria-hidden focusable="false" />
                <span>Настройки</span>
              </Link>
              <Link
                to={statisticsRoute}
                className="chat-card__action chat-card__action--statistics"
                state={routeState}
                aria-label={`Открыть статистику: ${title}`}
                title="Статистика"
                data-action="statistics"
                onClick={(event) => {
                  rememberEntity(activeTab, entity);
                  prefetchEntityActivity(activeTab, entity.id, statsPreference);
                  handleEntityNavigation(event, entity, index, 'statistics', statisticsRoute);
                }}
                onPointerEnter={(event) => {
                  if (shouldPrefetchFromPointerEvent(event)) {
                    prefetchEntityActivity(activeTab, entity.id, statsPreference);
                  }
                }}
                onPointerDown={(event) => {
                  if (shouldPrefetchFromPressEvent(event)) {
                    prefetchEntityActivity(activeTab, entity.id, statsPreference);
                  }
                }}
              >
                <StatisticsGlyph aria-hidden focusable="false" />
                <span>Статистика</span>
              </Link>
            </div>
          </>
        ) : null}
      </GlassCard>
    );
  }

  const selectedSheetFavoriteType = favoritePicker
    ? (getHomeEntityFavoriteTypes(
        homeEntityFavorites,
        favoritePicker.entityType,
        favoritePicker.entity.id,
      )[0] ?? null)
    : null;
  const sheetFavoriteSaving = favoritePicker
    ? savingFavoriteEntityKey ===
      buildFavoriteEntityKey(favoritePicker.entityType, favoritePicker.entity.id)
    : false;
  const hasAppliedFavoriteFilter = !categoryEditMode && favoriteFilter !== FAVORITE_FILTER_ALL;

  return (
    <div
      ref={homeRootRef}
      className={cn(
        'page-stack page-enter chats-home',
        `chats-home--${activeTab}`,
        categoryEditMode && 'is-category-editing',
      )}
      data-design-variant={
        searchParams.get('preview') === '1' && searchParams.get('design') === 'editorial'
          ? 'editorial'
          : 'signal'
      }
    >
      <Suspense fallback={null}>
        <LazyEntityPresentationLoader
          api={api}
          root={homeRootRef}
          entityType={activeTab}
          entities={isLoading || queryError ? [] : renderedEntities}
          scope={favoriteStorageScope}
          reloadNonce={refreshRequestByTab[activeTab].nonce}
          onChange={setPresentationState}
        />
      </Suspense>
      {homeOverlayOpen ? (
        <Suspense fallback={null}>
          <LazyHomeEntitySheets
            api={api}
            connectOpen={connectSheetOpen}
            favoriteTarget={favoritePicker}
            filterPickerOpen={favoriteFilterPickerOpen}
            filterValue={favoriteFilter}
            labelsEditorOpen={favoriteLabelsEditorOpen}
            favoriteLabels={favoriteLabels}
            favoriteLabelOverrides={homeEntityFavoriteLabels}
            favoriteStorageScope={favoriteStorageScope}
            favoriteCounts={favoriteCounts}
            selectedFavoriteType={selectedSheetFavoriteType}
            favoriteSaving={sheetFavoriteSaving}
            favoriteLabelsStatus={favoriteLabelsStatus}
            onClose={closeHomeEntitySheet}
            onFilterChange={(nextFilter) => {
              setFavoriteFilter(nextFilter);
              setFavoriteFilterPickerOpen(false);
            }}
            onStartCategoryEdit={enterCategoryEditMode}
            onOpenLabelsEditor={() => openFavoriteLabelsEditor()}
            onFavoriteChange={(favoriteType) => {
              if (favoritePicker) {
                void handleSetHomeEntityFavoriteType(
                  favoritePicker.entityType,
                  favoritePicker.entity.id,
                  favoriteType,
                );
              }
            }}
            onFavoriteLabelsSaved={() => {
              setFavoriteLabelsEditorOpen(false);
            }}
          />
        </Suspense>
      ) : null}

      <GlassCard
        className={cn(
          'chats-command',
          isForegroundSyncing && 'is-syncing',
          categoryEditMode && 'is-category-editing',
        )}
        padding="sm"
        elevated
      >
        <div className="chats-command__identity">
          <span className="chats-command__mark catalogue-heading-mark" aria-hidden />
          <div className="chats-command__brand">
            <h1>{tabLabel}</h1>
            {!isLoading && activeEntities ? (
              <span className="chats-command__count">{activeEntities.length}</span>
            ) : null}
          </div>
          {!categoryEditMode ? (
            <button
              type="button"
              className={cn(
                'chats-command__icon-button',
                'chats-command__refresh',
                `is-${homeSyncStatus.tone}`,
              )}
              onClick={() => handleRefresh(activeTab, 'manual')}
              disabled={isFetching || isManualRefreshInProgressByState}
              aria-label={refreshButtonLabel}
              title={refreshButtonLabel}
            >
              {homeSyncStatus.tone === 'syncing' ? (
                <span className="chats-command__sync-ring" aria-hidden />
              ) : homeSyncStatus.tone === 'error' ? (
                <XmarkGlyph aria-hidden />
              ) : (
                <RefreshGlyph aria-hidden />
              )}
            </button>
          ) : null}
          {!categoryEditMode ? (
            <button
              type="button"
              className="chats-command__connect"
              aria-label="Подключить чат или канал"
              aria-haspopup="dialog"
              aria-controls="home-sheet-connect"
              aria-expanded={connectSheetOpen}
              title="Подключить чат или канал"
              onPointerEnter={() => void preloadHomeEntitySheets()}
              onPointerDown={() => void preloadHomeEntitySheets()}
              onFocus={() => void preloadHomeEntitySheets()}
              onClick={(event) => void openConnectSheet(event.currentTarget)}
            >
              <PlusCircleGlyph aria-hidden focusable="false" />
            </button>
          ) : null}
        </div>
        <output className="chats-command__sr" aria-live="polite" aria-atomic="true">
          {homeResultStatus}
        </output>

        {refreshProgressPercent !== null ? (
          <div
            className="chats-command__progress"
            aria-label={`Обновляем список: ${refreshProgressPercent}%`}
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={refreshProgressPercent}
            style={
              {
                '--chats-sync-progress': `${refreshProgressPercent}%`,
              } as CSSProperties
            }
          >
            <span className="chats-command__sr">Обновлено {refreshProgressPercent}%</span>
          </div>
        ) : null}

        <div className="chats-command__tools">
          <span className="chats-command__sr" role="status" aria-live="polite" aria-atomic="true">
            {homeSyncAccessibleLabel}
          </span>
          <label
            className={cn(
              'field field--search chats-command__field',
              hasSearchQuery && 'has-query',
            )}
            htmlFor="chat-search"
          >
            <span>{searchLabel}</span>
            <div className="chats-command__field-shell">
              <SearchGlyph aria-hidden className="chats-command__search-icon" />
              <input
                ref={searchInputRef}
                id="chat-search"
                type="search"
                inputMode="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={searchPlaceholder}
              />
              {hasSearchQuery ? (
                <button
                  type="button"
                  className="chats-command__clear"
                  onClick={() => setQuery('')}
                  aria-label="Очистить поиск"
                  title="Очистить поиск"
                >
                  <XmarkGlyph aria-hidden />
                </button>
              ) : null}
            </div>
          </label>
          {categoryEditMode ? (
            <button
              ref={categoryEditDoneRef}
              type="button"
              className="chats-command__done"
              onClick={exitCategoryEditMode}
            >
              Готово
            </button>
          ) : (
            <div className="chats-command__actions" role="group" aria-label="Действия со списком">
              <button
                ref={favoriteFilterTriggerRef}
                type="button"
                className={cn(
                  'favorite-filter__trigger',
                  favoriteFilter !== FAVORITE_FILTER_ALL && 'is-active',
                  favoriteFilter !== FAVORITE_FILTER_ALL && `is-${favoriteFilter}`,
                )}
                aria-label={favoriteFilterButtonLabel}
                aria-haspopup="dialog"
                aria-controls="home-sheet-filter"
                aria-expanded={favoriteFilterPickerOpen}
                title={favoriteFilterButtonLabel}
                onPointerEnter={() => void preloadHomeEntitySheets()}
                onPointerDown={() => void preloadHomeEntitySheets()}
                onClick={(event) => openFavoriteFilterPicker(event.currentTarget)}
              >
                <FilterGlyph aria-hidden focusable="false" />
              </button>
            </div>
          )}
        </div>
        {savingFavoriteEntityKey !== null && !favoritePicker ? (
          <p className="chats-command__saving" role="status">
            Сохраняем категорию… Подождите перед следующим изменением.
          </p>
        ) : null}
        {!categoryEditMode ? (
          <div className="home-category-chips" role="group" aria-label="Категории">
            <button
              type="button"
              className="home-category-chip"
              aria-pressed={favoriteFilter === FAVORITE_FILTER_ALL}
              onClick={() => setFavoriteFilter(FAVORITE_FILTER_ALL)}
            >
              Все
            </button>
            {HOME_ENTITY_FAVORITE_TYPES.filter(
              (type) => favoriteCounts[type] > 0 || favoriteFilter === type,
            ).map((type) => {
              const Icon = HOME_ENTITY_FAVORITE_ICONS[type];
              return (
                <button
                  key={type}
                  type="button"
                  className={cn('home-category-chip', `is-${type}`)}
                  aria-pressed={favoriteFilter === type}
                  onClick={() => setFavoriteFilter(type)}
                >
                  <Icon aria-hidden focusable="false" />
                  <span>{favoriteLabels[type]}</span>
                </button>
              );
            })}
          </div>
        ) : null}
      </GlassCard>

      {showTransientEmptyState ? (
        <div className="chats-route-state chats-transient-state">
          <StatusState
            tone="warning"
            title="Пока не удалось обновить список"
            description={
              manualRefreshRetryAfterSec
                ? `Повторим автоматически через ${manualRefreshRetryAfterSec} с.`
                : 'Повторим автоматически.'
            }
          />
        </div>
      ) : null}

      {isLoading ? (
        <section
          className="chat-grid chat-grid--skeleton"
          aria-label="Загрузка"
          role="status"
          aria-busy="true"
        >
          {Array.from({ length: 4 }).map((_, index) => (
            <GlassCard key={index} as="article" className="chat-card chat-card--skeleton">
              <div className="chat-card__skeleton-main" aria-hidden>
                <Skeleton className="chat-card__skeleton-avatar" />
                <Skeleton className="chat-card__skeleton-title" />
                <Skeleton className="chat-card__skeleton-chevron" />
              </div>
              <Skeleton className="chat-card__skeleton-action chat-card__skeleton-action--favorite" />
              <div className="chat-card__row-actions" aria-hidden>
                <Skeleton className="chat-card__skeleton-action" />
                <Skeleton className="chat-card__skeleton-action" />
              </div>
            </GlassCard>
          ))}
        </section>
      ) : null}

      {queryError ? (
        <div className="chats-route-state">
          <StatusState
            tone="danger"
            title="Не удалось загрузить список"
            description={
              queryErrorPresentation?.error === queryError
                ? queryErrorPresentation.description
                : 'Попробуйте ещё раз.'
            }
            action={
              <button
                type="button"
                className="button button--danger"
                onClick={() => handleRefresh(activeTab, 'manual')}
              >
                Повторить
              </button>
            }
          />
        </div>
      ) : null}

      {isSyncPending && Array.isArray(activeEntities) && activeEntities.length === 0 ? (
        <Suspense fallback={null}>
          <LazyHomeListStatus
            kind="discovery"
            tab={activeTab}
            refreshState={refreshState}
            hasLoadedFromServer={activeEntitiesState.hasLoadedFromServer}
          />
        </Suspense>
      ) : null}

      {showEmptyState ? (
        <Suspense
          fallback={
            <GlassCard>
              <div role="status" aria-label="Загрузка подключения" aria-busy="true">
                <SkeletonCard lines={2} />
              </div>
            </GlassCard>
          }
        >
          <LazyChatOnboardingSection
            entityType={activeTab}
            isFetching={isFetching}
            isRefreshBlocked={isManualRefreshBlocked}
            onConnect={(trigger) => void openConnectSheet(trigger)}
            onRefresh={() => handleRefresh(activeTab, 'manual')}
          />
        </Suspense>
      ) : null}

      {!isLoading &&
      !queryError &&
      !showEmptyState &&
      Array.isArray(activeEntities) &&
      activeEntities.length > 0 &&
      filteredEntities.length === 0 ? (
        <Suspense fallback={null}>
          <LazyHomeListStatus
            kind="no-results"
            tab={activeTab}
            hasSearchQuery={hasSearchQuery}
            hasAppliedFavoriteFilter={hasAppliedFavoriteFilter}
            onReset={() => {
              setQuery('');
              if (hasAppliedFavoriteFilter) {
                setFavoriteFilter(FAVORITE_FILTER_ALL);
              }
            }}
          />
        </Suspense>
      ) : null}

      {!isLoading && !queryError && !showEmptyState && filteredEntities.length > 0 ? (
        <section
          className={cn('chat-grid', shouldVirtualizeEntities && 'chat-grid--virtual')}
          role="list"
          aria-label={`${tabLabel}: ${filteredEntities.length}`}
          aria-busy={isForegroundSyncing || undefined}
          ref={shouldVirtualizeEntities ? virtualListViewportRef : undefined}
          onScroll={
            shouldVirtualizeEntities
              ? (event) => setVirtualListScrollTop(event.currentTarget.scrollTop)
              : undefined
          }
          tabIndex={shouldVirtualizeEntities ? 0 : undefined}
        >
          {shouldVirtualizeEntities ? (
            <div
              className="chat-grid__virtual-spacer"
              style={{ height: filteredEntities.length * CHAT_LIST_VIRTUAL_ROW_PITCH }}
            >
              {renderedEntities.map((entity, index) =>
                renderEntityCard(entity, virtualStartIndex + index),
              )}
            </div>
          ) : (
            filteredEntities.map((entity, index) => renderEntityCard(entity, index))
          )}
        </section>
      ) : null}
      {!categoryEditMode ? (
        <div className="chats-home__publik">
          <Suspense fallback={null}>
            <LazyPublikHandoff compact />
          </Suspense>
        </div>
      ) : null}
    </div>
  );
}
