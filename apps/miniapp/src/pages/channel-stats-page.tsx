import { AppIcon as IconoirSprite } from '../components/ui/app-icon';
import type { MembershipActivityItem, MembershipActivityPage } from '@maxim/contracts';
import type { ChannelStatsRange, ChannelStatsResponse } from '@maxim/contracts/channel-stats';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import '../styles/channel-stats.css';
import '../styles/channel-stats-route-polish.css';
import '../styles/channel-stats-executive.css';
import '../styles/channel-stats-experience.css';
import './channel-stats-steel.css';
import type { ComponentProps } from 'react';
import {
  Suspense,
  startTransition,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router';
import { MembershipActivityFeed } from '../components/dashboard/membership-activity-feed';
import type { ChannelMemberBanSheet as ChannelMemberBanSheetComponent } from '../components/dashboard/channel-member-ban-sheet';
import { GlassCard } from '../components/ui/glass-card';
import { ManagedEntityWorkspaceHeader } from '../components/ui/managed-entity-workspace-header';
import { SegmentedControl } from '../components/ui/segmented-control';
import { SkeletonCard } from '../components/ui/skeleton';
import { StatusState } from '../components/ui/status-state';
import { useToast } from '../components/ui/toast';
import {
  getChannelActivityFeed,
  getChannelStats,
  handoffChannelMemberProfile,
} from '../lib/api/channel-stats-client';
import type { ApiTransport } from '../lib/api/transport';
import { readChatTitle, saveChatTitle } from '../lib/chat-titles';
import { buildManagedEntitiesRoute, saveLastEntityId } from '../lib/last-chat';
import {
  buildManagedEntitySettingsRoute,
  createManagedEntityWorkspaceState,
  getManagedEntitySessionStorage,
  hasManagedEntityStatsPreference,
  mergeManagedEntityStatsPreference,
  mergeManagedEntityWorkspaceRouteState,
  readManagedEntityWorkspaceState,
  saveManagedEntityStatsPreferenceForWorkspace,
} from '../lib/managed-entity-workspace';
import {
  buildMembershipActivitySnapshotParts,
  isMembershipActivityPage,
} from '../lib/logs-dashboard-cache';
import { openMaxBotLinkAndClose } from '../lib/max-bridge';
import { queryKeys } from '../lib/query-keys';
import {
  readStatsSnapshot,
  readStatsSnapshotMirror,
  saveStatsSnapshot,
} from '../lib/stats-snapshot-cache';
import { isChannelStatsResponseForRange } from '../lib/channel-stats-chart';
import { resolveStatisticsTitle } from '../lib/statistics-display';
import {
  buildStatisticsRouteSearch,
  parseChannelStatisticsRouteQuery,
} from '../lib/statistics-route-query';
import { useMembershipActivityFeed } from '../lib/use-membership-activity-feed';
import { useEventFeedRefresh } from '../lib/use-event-feed-refresh';
import { recoverableLazyNamedComponent } from '../lib/recoverable-lazy';
import { describeUserFacingError } from '../lib/user-facing-error';
import { formatCount, formatPeriodRange, periodOptions } from '../lib/channel-stats-format';
import type { ChannelStatsOverview as ChannelStatsOverviewComponent } from '../components/dashboard/channel-stats-overview';
const ChannelStatsOverview = recoverableLazyNamedComponent<
  ComponentProps<typeof ChannelStatsOverviewComponent>
>(() => import('../components/dashboard/channel-stats-overview'), 'ChannelStatsOverview');

const ChannelMemberBanSheet = recoverableLazyNamedComponent<
  ComponentProps<typeof ChannelMemberBanSheetComponent>
>(() => import('../components/dashboard/channel-member-ban-sheet'), 'ChannelMemberBanSheet');

type ChannelStatsRouteState = {
  chatTitle: string;
  avatarUrl: string | null;
};

type ChannelStatsSection = 'overview' | 'events';

const sectionOptions: Array<{ value: ChannelStatsSection; label: string }> = [
  { value: 'overview', label: 'Обзор' },
  { value: 'events', label: 'События' },
];

function getRouteState(state: unknown): ChannelStatsRouteState {
  if (!state || typeof state !== 'object') {
    return {
      chatTitle: '',
      avatarUrl: null,
    };
  }

  const row = state as Record<string, unknown>;
  return {
    chatTitle:
      typeof row.chatTitle === 'string' && row.chatTitle.trim() ? row.chatTitle.trim() : '',
    avatarUrl:
      typeof row.avatarUrl === 'string' && row.avatarUrl.trim() ? row.avatarUrl.trim() : null,
  };
}

function buildChannelStatsRouteState(
  routeState: unknown,
  chatId: string,
  preference: { section?: ChannelStatsSection; range?: ChannelStatsRange },
): Record<string, unknown> {
  const currentWorkspace = readManagedEntityWorkspaceState(routeState);
  const matchingWorkspace =
    currentWorkspace?.entityType === 'channel' && currentWorkspace.entityId === chatId
      ? currentWorkspace
      : null;
  const workspace = createManagedEntityWorkspaceState({
    entityType: 'channel',
    entityId: chatId,
    origin: matchingWorkspace?.origin,
    homeSnapshot: matchingWorkspace?.homeSnapshot,
    statsPreference: mergeManagedEntityStatsPreference(
      'channel',
      matchingWorkspace?.statsPreference,
      preference,
    ),
  });

  return mergeManagedEntityWorkspaceRouteState(routeState, workspace);
}

function saveChannelStatsPreference(
  routeState: unknown,
  chatId: string,
  preference: { section?: ChannelStatsSection; range?: ChannelStatsRange },
): void {
  saveManagedEntityStatsPreferenceForWorkspace(getManagedEntitySessionStorage(), routeState, {
    entityType: 'channel',
    entityId: chatId,
    preference,
  });
}

export function ChannelStatsPage({ api }: { api: ApiTransport }) {
  const { chatId } = useParams();
  return <ChannelStatsWorkspace key={chatId ?? ''} api={api} />;
}

function ChannelStatsWorkspace({ api }: { api: ApiTransport }) {
  const { chatId = '' } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { pushToast } = useToast();
  const workspaceRef = useRef<HTMLDivElement>(null);
  const activeView = useRef(true);
  const profileLock = useRef(false);
  const [banTarget, setBanTarget] = useState<{
    chatId: string;
    item: MembershipActivityItem;
  } | null>(null);
  const routeState = getRouteState(location.state);
  const [range, setRange] = useState<ChannelStatsRange>(
    () => parseChannelStatisticsRouteQuery(location.search).range,
  );
  const [section, setSection] = useState<ChannelStatsSection>(
    () => parseChannelStatisticsRouteQuery(location.search).section,
  );
  useLayoutEffect(() => {
    const workspace = workspaceRef.current;
    if (!workspace) return;

    // Stack sticky controls using their rendered heights, including enlarged mobile text.
    const measurements = [
      ['.channel-insights__section-tabs', '--channel-section-tabs-height'],
      ['.membership-feed__toolbar', '--channel-event-filters-height'],
    ] as const;
    const measure = () => {
      for (const [selector, property] of measurements) {
        const element = workspace.querySelector(selector);
        if (element) {
          workspace.style.setProperty(property, `${element.getBoundingClientRect().height}px`);
        }
      }
    };
    const observer = new ResizeObserver(measure);
    for (const [selector] of measurements) {
      const element = workspace.querySelector(selector);
      if (element) observer.observe(element);
    }
    measure();
    return () => {
      observer.disconnect();
      for (const [, property] of measurements) workspace.style.removeProperty(property);
    };
  }, [section]);
  useEffect(() => setBanTarget(null), [chatId, section]);
  const routeQuery = useMemo(
    () => parseChannelStatisticsRouteQuery(location.search),
    [location.search],
  );
  const initialStatsSnapshot = useMemo(() => {
    if (!chatId) {
      return null;
    }

    const snapshot = readStatsSnapshotMirror<ChannelStatsResponse>('channel', [
      chatId,
      range,
      'full',
    ]);
    return isChannelStatsResponseForRange(snapshot, chatId, range) ? snapshot : null;
  }, [chatId, range]);
  const initialActivityPageSnapshot = useMemo(() => {
    if (!chatId || section !== 'events') {
      return null;
    }

    const snapshot = readStatsSnapshotMirror<MembershipActivityPage>(
      'membership-activity-feed',
      buildMembershipActivitySnapshotParts('channel', chatId, range, 'all'),
    );
    return isMembershipActivityPage(snapshot) ? snapshot : null;
  }, [chatId, range, section]);
  const statsQuery = useQuery({
    queryKey: queryKeys.channelStats(chatId, range, 'full'),
    queryFn: ({ signal }) =>
      getChannelStats(
        api,
        chatId,
        range,
        { signal },
        {
          includeActivityPreview: false,
          mode: 'full',
        },
      ),
    enabled: Boolean(chatId),
    staleTime: 30_000,
    initialData: initialStatsSnapshot ?? undefined,
    initialDataUpdatedAt: initialStatsSnapshot ? 0 : undefined,
    placeholderData: (previousData) => previousData,
    refetchInterval: (query) =>
      query.state.error ? false : query.state.data?.meta.refreshQueued ? 5_000 : 60_000,
    refetchOnWindowFocus: false,
  });
  const activityFeed = useMembershipActivityFeed({
    entityId: chatId,
    enabled: Boolean(chatId) && section === 'events',
    range,
    initialPage: initialActivityPageSnapshot,
    loadPage: (query, request) => getChannelActivityFeed(api, chatId, query, request),
  });
  useEventFeedRefresh({
    enabled: section === 'events' && !banTarget,
    scopeKey: `${chatId}:${range}:${activityFeed.filter}`,
    feed: activityFeed,
  });

  useEffect(() => {
    startTransition(() => {
      setSection(routeQuery.section);
      setRange(routeQuery.range);
    });
    if (chatId) {
      saveChannelStatsPreference(location.state, chatId, routeQuery);
    }

    const nextSearch = buildStatisticsRouteSearch(location.search, routeQuery);
    const routeStateHasCurrentStatsPreference = chatId
      ? hasManagedEntityStatsPreference(location.state, {
          entityType: 'channel',
          entityId: chatId,
          preference: routeQuery,
        })
      : true;
    if (nextSearch === location.search && routeStateHasCurrentStatsPreference) {
      return;
    }

    navigate(
      {
        pathname: location.pathname,
        search: nextSearch,
        hash: location.hash,
      },
      {
        replace: true,
        state: chatId
          ? buildChannelStatsRouteState(location.state, chatId, routeQuery)
          : location.state,
      },
    );
  }, [
    chatId,
    location.hash,
    location.pathname,
    location.search,
    location.state,
    navigate,
    routeQuery,
  ]);

  useEffect(() => {
    if (!chatId) {
      return undefined;
    }

    let cancelled = false;
    void readStatsSnapshot<ChannelStatsResponse>('channel', [chatId, range, 'full']).then(
      (snapshot) => {
        if (cancelled || !isChannelStatsResponseForRange(snapshot, chatId, range)) {
          return;
        }

        const queryKey = queryKeys.channelStats(chatId, range, 'full');
        if (!queryClient.getQueryData(queryKey)) {
          queryClient.setQueryData(queryKey, snapshot);
        }
      },
    );

    return () => {
      cancelled = true;
    };
  }, [chatId, queryClient, range]);

  useEffect(() => {
    if (!isChannelStatsResponseForRange(statsQuery.data, chatId, range)) {
      return;
    }

    saveStatsSnapshot('channel', [chatId, range, 'full'], statsQuery.data);
  }, [chatId, range, statsQuery.data]);

  useEffect(() => {
    if (!chatId || section !== 'events' || activityFeed.filter !== 'all') {
      return;
    }
    if (!activityFeed.firstPage) {
      return;
    }

    saveStatsSnapshot(
      'membership-activity-feed',
      buildMembershipActivitySnapshotParts('channel', chatId, range, 'all'),
      activityFeed.firstPage,
    );
  }, [activityFeed.filter, activityFeed.firstPage, chatId, range, section]);

  useEffect(() => {
    activeView.current = true;
    document.body.classList.add('channel-stats-page-open');

    return () => {
      activeView.current = false;
      document.body.classList.remove('channel-stats-page-open');
    };
  }, []);

  useEffect(() => {
    if (!chatId) {
      return;
    }

    saveLastEntityId('channel', chatId);
  }, [chatId]);

  const stats = isChannelStatsResponseForRange(statsQuery.data, chatId, range)
    ? statsQuery.data
    : null;
  const currentStatsIdentity = stats && !statsQuery.isPlaceholderData ? stats : null;
  const resolvedTitleResolution = useMemo(
    () =>
      resolveStatisticsTitle({
        remoteTitle: currentStatsIdentity?.channel.title,
        remoteFallbackTitles: [
          'Чат без названия',
          `Чат ${chatId}`,
          `Chat ${chatId}`,
          `Канал ${chatId}`,
          `Channel ${chatId}`,
        ],
        routeTitle: routeState.chatTitle,
        storedTitle: chatId ? readChatTitle(chatId) : null,
        fallback: 'Канал',
      }),
    [chatId, currentStatsIdentity?.channel.title, routeState.chatTitle],
  );
  const resolvedTitle = resolvedTitleResolution.title;
  const authoritativeStatsIdentity =
    currentStatsIdentity &&
    statsQuery.isSuccess &&
    !statsQuery.isFetching &&
    !statsQuery.isPlaceholderData &&
    !statsQuery.isRefetchError &&
    statsQuery.dataUpdatedAt > 0
      ? currentStatsIdentity.channel
      : null;
  const remoteAvatarUrl = currentStatsIdentity?.channel.avatarUrl;
  const resolvedAvatarUrl =
    typeof remoteAvatarUrl === 'string' && remoteAvatarUrl.trim()
      ? remoteAvatarUrl.trim()
      : authoritativeStatsIdentity
        ? null
        : routeState.avatarUrl;

  useEffect(() => {
    if (!chatId || !resolvedTitle || resolvedTitleResolution.source === 'fallback') {
      return;
    }

    if (
      resolvedTitleResolution.source === 'remote' &&
      (!statsQuery.isSuccess ||
        statsQuery.isFetching ||
        statsQuery.isPlaceholderData ||
        statsQuery.isRefetchError ||
        statsQuery.dataUpdatedAt <= 0)
    ) {
      return;
    }

    saveChatTitle(chatId, resolvedTitle);
  }, [
    chatId,
    resolvedTitle,
    resolvedTitleResolution.source,
    statsQuery.dataUpdatedAt,
    statsQuery.isFetching,
    statsQuery.isPlaceholderData,
    statsQuery.isRefetchError,
    statsQuery.isSuccess,
  ]);

  const activitySummary = useMemo(() => {
    if (!stats || !stats.meta.churnAvailable) {
      return null;
    }

    const joined = stats.official.audience.joined;
    const left = stats.official.audience.left;

    return {
      joined,
      left,
      total: left === null ? null : joined + left,
    };
  }, [stats]);

  const isActivitySummaryLoading = !stats && statsQuery.isFetching;
  const profileHandoffMutation = useMutation({
    mutationFn: ({ userId, displayName }: { userId: string; displayName: string }) =>
      handoffChannelMemberProfile(api, chatId, userId, { displayName }),
    onSuccess: (result) => {
      if (!activeView.current) return;
      if (!openMaxBotLinkAndClose(result.botUrl)) {
        pushToast({
          tone: 'danger',
          title: 'Не удалось открыть бота',
        });
      }
    },
    onError: () => {
      pushToast({
        tone: 'danger',
        title: 'Не удалось открыть профиль',
        description: 'Попробуйте ещё раз.',
      });
    },
    onSettled: () => {
      profileLock.current = false;
    },
  });

  const activateChannelProfile = (item: MembershipActivityItem) => {
    const normalizedUserId = item.userId.trim();
    if (!normalizedUserId || !chatId || profileLock.current || profileHandoffMutation.isPending) {
      return;
    }

    const displayName = item.userDisplayName.trim() || 'Участник';
    profileLock.current = true;
    // FLAG: Persist the name before opening MAX; bot_started can otherwise win this race.
    profileHandoffMutation.mutate({
      userId: normalizedUserId,
      displayName,
    });
  };

  if (!chatId) {
    return (
      <div className="channel-insights page-stack page-enter" data-managed-entity-workspace>
        <ManagedEntityWorkspaceHeader
          entityType="channel"
          screen="stats"
          title={resolvedTitle}
          avatarUrl={routeState.avatarUrl}
          backTo={buildManagedEntitiesRoute('channel')}
          counterpartTo={buildManagedEntitiesRoute('channel')}
          counterpartHidden
          className="channel-insights__sticky-header"
        />
        <GlassCard>
          <StatusState
            tone="warning"
            title="Канал не выбран"
            description="Откройте канал из списка на главном экране."
            action={
              <Link to={buildManagedEntitiesRoute('channel')} className="button button--accent">
                К списку
              </Link>
            }
          />
        </GlassCard>
      </div>
    );
  }

  const handleSectionChange = (nextSection: ChannelStatsSection) => {
    if (nextSection === section) {
      return;
    }

    startTransition(() => {
      setSection(nextSection);
    });
    saveChannelStatsPreference(location.state, chatId, { section: nextSection, range });
    navigate(
      {
        pathname: location.pathname,
        search: buildStatisticsRouteSearch(location.search, { section: nextSection, range }),
        hash: location.hash,
      },
      {
        replace: true,
        state: buildChannelStatsRouteState(location.state, chatId, {
          section: nextSection,
          range,
        }),
      },
    );
  };
  const handleRangeChange = (nextRange: ChannelStatsRange) => {
    if (nextRange === range) {
      return;
    }

    startTransition(() => {
      setRange(nextRange);
    });
    saveChannelStatsPreference(location.state, chatId, { section, range: nextRange });
    navigate(
      {
        pathname: location.pathname,
        search: buildStatisticsRouteSearch(location.search, { section, range: nextRange }),
        hash: location.hash,
      },
      {
        replace: true,
        state: buildChannelStatsRouteState(location.state, chatId, {
          section,
          range: nextRange,
        }),
      },
    );
  };
  const handleActivityFilterChange = (nextFilter: Parameters<typeof activityFeed.setFilter>[0]) => {
    if (nextFilter === activityFeed.filter) {
      return;
    }

    startTransition(() => {
      activityFeed.setFilter(nextFilter);
    });
  };
  const isBusy =
    statsQuery.isFetching ||
    (section === 'events' &&
      (activityFeed.isReloading || activityFeed.isRefreshing || activityFeed.isLoadingMore));

  const refreshCurrentSection = () => {
    if (isBusy) return;
    void statsQuery.refetch();
    if (section === 'events') void activityFeed.retry();
  };

  return (
    <div ref={workspaceRef} className="channel-insights page-enter" data-managed-entity-workspace>
      <ManagedEntityWorkspaceHeader
        entityType="channel"
        screen="stats"
        title={resolvedTitle}
        avatarUrl={resolvedAvatarUrl}
        authoritativeIdentity={
          authoritativeStatsIdentity
            ? {
                title:
                  resolvedTitleResolution.source === 'remote'
                    ? authoritativeStatsIdentity.title
                    : null,
                avatarUrl: authoritativeStatsIdentity.avatarUrl ?? null,
              }
            : undefined
        }
        backTo={buildManagedEntitiesRoute('channel')}
        counterpartTo={buildManagedEntitySettingsRoute('channel', chatId)}
        compact
        busy={isBusy}
        status={
          <button
            type="button"
            className="managed-entity-workspace-header__counterpart"
            aria-label={section === 'events' ? 'Обновить события' : 'Обновить статистику'}
            title={section === 'events' ? 'Обновить события' : 'Обновить статистику'}
            disabled={isBusy}
            onClick={refreshCurrentSection}
          >
            <IconoirSprite
              variant="iconoir"
              icon="Refresh"
              width={20}
              height={20}
              aria-hidden="true"
            />
          </button>
        }
        className="channel-insights__sticky-header"
      />

      <div className="channel-insights__body">
        {/* Product rule: factual analytics only, no smart advice or "what to do next" copy. */}
        <SegmentedControl
          value={section}
          options={sectionOptions}
          onChange={(next) => handleSectionChange(next as ChannelStatsSection)}
          className="channel-insights__section-tabs"
          ariaLabel="Раздел статистики канала"
        />

        {stats && statsQuery.error ? (
          <div className="channel-insights__refresh-error" role="status">
            <span>
              {describeUserFacingError(
                statsQuery.error,
                'Не удалось обновить статистику. Показаны сохранённые данные.',
              )}
            </span>
            <button
              type="button"
              className="button button--ghost"
              disabled={statsQuery.isFetching}
              onClick={() => void statsQuery.refetch()}
            >
              Повторить
            </button>
          </div>
        ) : null}

        {section === 'events' ? (
          <section className="channel-events-section" aria-label="События канала">
            <div className="channel-events-section__head channel-events-section__head--period">
              <div className="channel-events-section__period-copy">
                <strong>Период</strong>
                {stats ? (
                  <span>
                    {stats.meta.churnAvailable
                      ? formatPeriodRange(stats.period.from, stats.period.to)
                      : 'Неполные данные'}
                  </span>
                ) : null}
              </div>

              <SegmentedControl
                value={range}
                options={periodOptions}
                onChange={(next) => handleRangeChange(next as ChannelStatsRange)}
                className="channel-insights__range"
                ariaLabel="Период статистики событий"
              />
            </div>

            <div
              className="channel-events-section__metrics"
              aria-label="Сводка событий за выбранный период"
              aria-busy={isActivitySummaryLoading}
            >
              <span className="channel-events-section__metric channel-events-section__metric--total">
                <span className="channel-events-section__metric-icon" aria-hidden="true">
                  <IconoirSprite
                    variant="iconoir"
                    icon="Activity"
                    width={17}
                    height={17}
                    strokeWidth={2.05}
                  />
                </span>
                <small>Событий</small>
                <strong>{formatCount(activitySummary?.total ?? null)}</strong>
              </span>
              <span className="channel-events-section__metric channel-events-section__metric--joined">
                <span className="channel-events-section__metric-icon" aria-hidden="true">
                  <IconoirSprite
                    variant="iconoir"
                    icon="UserPlus"
                    width={17}
                    height={17}
                    strokeWidth={2.05}
                  />
                </span>
                <small>Вошли</small>
                <strong>{formatCount(activitySummary?.joined ?? null)}</strong>
              </span>
              <span className="channel-events-section__metric channel-events-section__metric--left">
                <span className="channel-events-section__metric-icon" aria-hidden="true">
                  <IconoirSprite
                    variant="iconoir"
                    icon="UserXmark"
                    width={17}
                    height={17}
                    strokeWidth={2.05}
                  />
                </span>
                <small>Вышли</small>
                <strong>{formatCount(activitySummary?.left ?? null)}</strong>
              </span>
            </div>

            {statsQuery.error && !stats ? (
              <GlassCard className="channel-insights__inline-state">
                <StatusState
                  tone="warning"
                  title="Итоги временно недоступны"
                  description={(statsQuery.error as Error).message}
                  action={
                    <button
                      type="button"
                      className="button button--ghost"
                      onClick={() => void statsQuery.refetch()}
                    >
                      Повторить
                    </button>
                  }
                />
              </GlassCard>
            ) : null}

            <MembershipActivityFeed
              joinedLabel="каналу"
              leftLabel="канал"
              resetKey={`${chatId}:${range}`}
              variant="immersive"
              filter={activityFeed.filter}
              onFilterChange={handleActivityFilterChange}
              items={activityFeed.items}
              hasMore={activityFeed.hasMore}
              isReloading={activityFeed.isReloading}
              isLoadingMore={activityFeed.isLoadingMore}
              error={activityFeed.error}
              onLoadMore={() => void activityFeed.loadMore()}
              onRetry={() => void activityFeed.retryFailed()}
              onProfileActivate={activateChannelProfile}
              renderMemberAction={(item) =>
                item.userId.trim() ? (
                  <button
                    type="button"
                    className="channel-member-ban"
                    aria-label={`Заблокировать ${item.userDisplayName.trim() || 'участника'}`}
                    title="Заблокировать в канале"
                    onClick={() => setBanTarget({ chatId, item })}
                  >
                    <IconoirSprite
                      variant="iconoir"
                      icon="Prohibition"
                      width={20}
                      height={20}
                      aria-hidden="true"
                    />
                  </button>
                ) : null
              }
            />
          </section>
        ) : stats ? (
          <Suspense fallback={<SkeletonCard lines={8} />}>
            <ChannelStatsOverview stats={stats} range={range} onRangeChange={handleRangeChange} />
          </Suspense>
        ) : statsQuery.error ? (
          <GlassCard className="channel-insights__inline-state">
            <StatusState
              tone="danger"
              title="Не удалось загрузить статистику"
              description={(statsQuery.error as Error).message}
              action={
                <button
                  type="button"
                  className="button button--danger"
                  onClick={() => void statsQuery.refetch()}
                >
                  Повторить
                </button>
              }
            />
          </GlassCard>
        ) : (
          <GlassCard className="channel-insights__inline-state" aria-busy="true">
            <SkeletonCard lines={8} />
          </GlassCard>
        )}
      </div>
      {banTarget?.chatId === chatId && section === 'events' ? (
        <Suspense fallback={null}>
          <ChannelMemberBanSheet
            key={`${chatId}:${banTarget.item.userId}`}
            api={api}
            chatId={chatId}
            channelTitle={resolvedTitle}
            target={banTarget.item}
            onApplied={() => void activityFeed.refresh()}
            onRefresh={() => void activityFeed.retry()}
            onClose={() => setBanTarget((current) => (current === banTarget ? null : current))}
          />
        </Suspense>
      ) : null}
    </div>
  );
}
