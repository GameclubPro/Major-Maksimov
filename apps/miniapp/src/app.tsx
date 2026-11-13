import { QueryClientProvider } from '@tanstack/react-query';
import type { Me } from '@maxim/contracts';
import type { MiniappProfile } from '@maxim/contracts/publisher';
import {
  Suspense,
  lazy,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
  type RefObject,
  type ReactNode,
} from 'react';
import {
  BrowserRouter as Router,
  HashRouter,
  Navigate,
  Route,
  Routes,
  useLocation,
  useNavigate,
} from 'react-router';
import { Shell } from './components/shell';
import { Spinner } from './components/ui/spinner';
import { ToastProvider } from './components/ui/toast';
import { createApiTransport, createLazyMiniappServerSessionManager } from './lib/api/transport';
import { createAuthQueryClient, useAuthQueryPrincipalKey } from './lib/auth-query-session';
import { createAuthSessionCoordinator } from './lib/auth-session-coordinator';
import { traceMiniappBoot, traceMiniappLaunchRoute } from './lib/boot-trace';
import { getPreviewBootstrap } from './lib/design-preview';
import { migrateHashRouterLegacyPathFromWindow } from './lib/hash-router-legacy-path';
import { getInitData, waitForInitData } from './lib/init-data';
import { createLaunchRouteResolver } from './lib/launch-route';
import {
  installMaxNativeInteractionFeedback,
  readyMaxMiniApp,
  syncMaxNativeEnvironment,
} from './lib/max-bridge';
import { PUBLIC_ROUTER_BASENAME } from './lib/public-config';
import { isPublicLegalPathnameFromWindow } from './lib/public-legal-route';
import { isRetiredPublishingSettingsRoute } from './lib/retired-publishing-route';
import {
  LazyChannelDialogPage,
  LazyChannelSuggestDialogPage,
  LazyChannelSettingsPage,
  LazyChannelStatsPage,
  LazyChatsPage,
  LazyEventsPage,
  LazyGiveawayPage,
  LazyLegalAgreementPage,
  LazyPrivacyPolicyPage,
  LazySettingsPage,
} from './pages/lazy-pages';

const LazyPublicationsPage = lazy(async () => {
  const module = await import('./pages/publications-page');
  return { default: module.PublicationsPage };
});

const LazyPublisherEntitiesPage = lazy(async () => {
  const module = await import('./pages/publisher-entities-page');
  return { default: module.PublisherEntitiesPage };
});

const LazyPublisherEntityModulesPage = lazy(async () => {
  const module = await import('./pages/publisher-entity-modules-page');
  return { default: module.PublisherEntityModulesPage };
});

const LazyPublisherAutoRepliesPage = lazy(async () => {
  const module = await import('./pages/publisher-auto-replies-page');
  return { default: module.PublisherAutoRepliesPage };
});

const LazyManagedEntityNavigationProvider = lazy(async () => {
  const module = await import('./lib/managed-entity-navigation');
  return { default: module.ManagedEntityNavigationProvider };
});

const LazyHomeEntityFavoritesProvider = lazy(async () => {
  const module = await import('./lib/home-entity-favorites-context');
  return { default: module.HomeEntityFavoritesProvider };
});
const LazyNetworksPage = lazy(async () => {
  const module = await import('./pages/networks-page');
  return { default: module.NetworksPage };
});
const LazyNetworkSettingsRoute = lazy(async () => {
  const module = await import('./pages/network-settings-route');
  return { default: module.NetworkSettingsRoute };
});

const LazyAppStartupState = lazy(async () => {
  const module = await import('./components/app-startup-state');
  return { default: module.AppStartupState };
});

const LazyPublikHandoff = lazy(async () => {
  const module = await import('./components/publik-handoff');
  return { default: module.PublikHandoff };
});

function MajorSettingsRoute({ children }: { children: ReactNode }) {
  const location = useLocation();
  return isRetiredPublishingSettingsRoute(location.search) ? <LazyPublikHandoff /> : children;
}

function ProfileHomeRedirect({ homeRoute }: Pick<Me, 'homeRoute'>) {
  const location = useLocation();
  return <Navigate to={`${homeRoute}${location.search}`} replace />;
}

const HASH_ROUTER_ENABLED =
  typeof __MAXIM_ROUTER_MODE__ === 'string' && __MAXIM_ROUTER_MODE__ === 'hash';
const AppRouter = HASH_ROUTER_ENABLED ? HashRouter : Router;
const ROUTER_BASENAME = HASH_ROUTER_ENABLED ? '' : PUBLIC_ROUTER_BASENAME;
const NATIVE_ENVIRONMENT_SYNC_POLL_INTERVAL_MS = 150;
const NATIVE_ENVIRONMENT_SYNC_POLL_DURATION_MS = 8_000;

migrateHashRouterLegacyPathFromWindow();

function parseRoute(route: string): URL | null {
  try {
    return new URL(route, 'https://miniapp.local');
  } catch {
    return null;
  }
}

function mergeRouteSearch(currentSearch: string, targetSearch: string): string {
  const merged = new URLSearchParams(currentSearch);
  const target = new URLSearchParams(targetSearch);

  for (const key of new Set(target.keys())) {
    merged.delete(key);
  }

  for (const [key, value] of target.entries()) {
    merged.append(key, value);
  }

  const serialized = merged.toString();
  return serialized ? `?${serialized}` : '';
}

function isLaunchRouteApplied(
  currentPathname: string,
  currentSearch: string,
  targetRoute: string,
): boolean {
  const parsedTarget = parseRoute(targetRoute);
  if (!parsedTarget) {
    return true;
  }

  if (currentPathname !== parsedTarget.pathname) {
    return false;
  }

  const current = new URLSearchParams(currentSearch);
  for (const [key, value] of parsedTarget.searchParams.entries()) {
    if (current.get(key) !== value) {
      return false;
    }
  }

  return true;
}

function buildMergedLaunchRoute(targetRoute: string, currentSearch: string): string {
  const parsedTarget = parseRoute(targetRoute);
  if (!parsedTarget) {
    return targetRoute;
  }

  return `${parsedTarget.pathname}${mergeRouteSearch(currentSearch, parsedTarget.search)}`;
}

function getManagedEntityType(route: string): 'chat' | 'channel' | null {
  const parsedRoute = parseRoute(route);
  const match = parsedRoute?.pathname.match(
    /^\/(chat|channel)\/[^/]+\/(settings|events|stats)\/?$/iu,
  );
  if (!match) {
    return null;
  }

  const entityType = match[1]?.toLowerCase() === 'channel' ? 'channel' : 'chat';
  const screen = match[2]?.toLowerCase();
  if (
    (entityType === 'chat' && screen === 'stats') ||
    (entityType === 'channel' && screen === 'events')
  ) {
    return null;
  }

  return entityType;
}

function isManagedEntityDetailRoute(route: string): boolean {
  return getManagedEntityType(route) !== null;
}

function buildWindowPathForRoute(pathname: string): string {
  if (HASH_ROUTER_ENABLED) {
    return pathname;
  }

  if (!PUBLIC_ROUTER_BASENAME) {
    return pathname;
  }

  return pathname === '/' ? `${PUBLIC_ROUTER_BASENAME}/` : `${PUBLIC_ROUTER_BASENAME}${pathname}`;
}

function hasManagedEntityDirectEntryFromWindow(): boolean {
  if (typeof window === 'undefined') {
    return false;
  }

  const parsedRoute = HASH_ROUTER_ENABLED
    ? parseRoute(window.location.hash.replace(/^#/u, '') || '/')
    : new URL(window.location.href);
  if (!parsedRoute) {
    return false;
  }

  const pathname = HASH_ROUTER_ENABLED
    ? parsedRoute.pathname
    : PUBLIC_ROUTER_BASENAME && parsedRoute.pathname.startsWith(PUBLIC_ROUTER_BASENAME)
      ? parsedRoute.pathname.slice(PUBLIC_ROUTER_BASENAME.length) || '/'
      : parsedRoute.pathname;
  return /^\/(?:chat\/[^/]+\/(?:settings|events)|channel\/[^/]+\/(?:settings|stats))\/?$/iu.test(
    pathname,
  );
}

type AppMaxWebAppBridge = NonNullable<Window['MAX']>['WebApp'];

function readBridgeRuntimeSignature(bridge: AppMaxWebAppBridge | undefined): string {
  if (!bridge) {
    return 'none';
  }

  const unsafeKeys = [
    ...Object.keys(bridge.initDataUnsafe ?? {}),
    ...Object.keys(bridge.init_data_unsafe ?? {}),
  ]
    .sort()
    .join(',');

  return [
    'bridge',
    typeof bridge.version === 'string' ? bridge.version : '',
    typeof bridge.platform === 'string' ? bridge.platform : '',
    typeof bridge.initData === 'string' && bridge.initData.trim() ? 'initData' : '',
    typeof bridge.init_data === 'string' && bridge.init_data.trim() ? 'init_data' : '',
    unsafeKeys,
  ].join('|');
}

function readMaxNativeEnvironmentSignature(initData: string | null): string {
  if (typeof window === 'undefined') {
    return initData ? 'init' : 'empty';
  }

  const maxBridge = window.MAX?.WebApp;
  const legacyBridge = window.WebApp;
  const bridgeKind = maxBridge ? 'max' : legacyBridge ? 'legacy' : 'none';
  const bridgeSignature = readBridgeRuntimeSignature(maxBridge ?? legacyBridge);
  const hasInitData = Boolean((initData ?? '').trim() || getInitData());

  return `${bridgeKind}|${bridgeSignature}|${hasInitData ? 'init' : 'empty'}`;
}

function applyInitialLaunchRoute(targetRoute: string): void {
  if (typeof window === 'undefined') {
    return;
  }

  const parsedTarget = parseRoute(targetRoute);
  if (!parsedTarget) {
    return;
  }

  const nextPathname = buildWindowPathForRoute(parsedTarget.pathname);
  const nextSearch = mergeRouteSearch(window.location.search, parsedTarget.search);
  if (HASH_ROUTER_ENABLED) {
    const currentHashRoute = parseRoute(window.location.hash.replace(/^#/u, '') || '/');
    const currentHashPathname = currentHashRoute?.pathname || '/';
    const currentHashSearch = currentHashRoute?.search || '';
    const nextHashSearch = mergeRouteSearch(currentHashSearch, parsedTarget.search);
    if (currentHashPathname === parsedTarget.pathname && currentHashSearch === nextHashSearch) {
      return;
    }

    const nextUrl = `${window.location.pathname}${window.location.search}#${parsedTarget.pathname}${nextHashSearch}`;
    window.history.replaceState(window.history.state, '', nextUrl);
    return;
  }

  if (window.location.pathname === nextPathname && window.location.search === nextSearch) {
    return;
  }

  const nextUrl = `${nextPathname}${nextSearch}${window.location.hash}`;
  window.history.replaceState(window.history.state, '', nextUrl);
}

function LaunchRouteSync({
  launchInitData,
  appliedRouteRef,
  launchRouteResolver,
}: {
  launchInitData: string;
  appliedRouteRef: RefObject<string | null>;
  launchRouteResolver: (initData: string) => string | null;
}) {
  const location = useLocation();
  const navigate = useNavigate();

  useEffect(() => {
    let cancelled = false;
    const targetRoute = launchRouteResolver(launchInitData);
    traceMiniappLaunchRoute(targetRoute, 'router-sync');
    if (!targetRoute || appliedRouteRef.current === targetRoute) {
      return undefined;
    }

    if (isLaunchRouteApplied(location.pathname, location.search, targetRoute)) {
      appliedRouteRef.current = targetRoute;
      return undefined;
    }

    const mergedTargetRoute = buildMergedLaunchRoute(targetRoute, location.search);
    const managedEntityType = getManagedEntityType(targetRoute);
    if (managedEntityType && location.pathname !== '/') {
      const homeRoute = `/?view=${managedEntityType}`;
      if (!isManagedEntityDetailRoute(location.pathname)) {
        navigate(homeRoute, { replace: true });
        return undefined;
      }

      const currentHistoryIndex =
        typeof window.history.state?.idx === 'number' &&
        Number.isSafeInteger(window.history.state.idx)
          ? window.history.state.idx
          : 0;
      void import('./lib/managed-entity-direct-entry')
        .then((module) =>
          module.canReturnToManagedEntityHome({
            currentRouteState: location.state,
            currentLocationKey: location.key,
            currentHistoryIndex,
          }),
        )
        .then((canReturnToHome) => {
          if (cancelled) {
            return;
          }
          if (canReturnToHome) {
            navigate(-1);
          } else {
            navigate(homeRoute, { replace: true });
          }
        })
        .catch(() => {
          if (!cancelled) {
            navigate(homeRoute, { replace: true });
          }
        });
    } else if (location.pathname === '/' && managedEntityType) {
      const currentHistoryIndex =
        typeof window.history.state?.idx === 'number' &&
        Number.isSafeInteger(window.history.state.idx)
          ? window.history.state.idx
          : 0;
      void import('./lib/managed-entity-direct-entry')
        .then((module) => {
          if (cancelled) {
            return;
          }

          const homeStep = module.resolveManagedEntityLaunchHomeStep({
            targetEntityType: managedEntityType,
            currentSearch: location.search,
          });
          if (homeStep.kind === 'normalize-home') {
            navigate(homeStep.route, { replace: true });
            return;
          }

          const routeState = module.buildManagedEntityLaunchRouteState({
            targetRoute,
            currentRouteState: location.state,
            currentLocationKey: location.key,
            currentHistoryIndex,
          });
          appliedRouteRef.current = targetRoute;
          navigate(mergedTargetRoute, routeState ? { state: routeState } : { replace: true });
        })
        .catch(() => {
          if (!cancelled) {
            appliedRouteRef.current = targetRoute;
            navigate(mergedTargetRoute, { replace: true });
          }
        });
    } else {
      appliedRouteRef.current = targetRoute;
      navigate(mergedTargetRoute, { replace: true });
    }

    return () => {
      cancelled = true;
    };
  }, [
    launchInitData,
    launchRouteResolver,
    location.key,
    location.pathname,
    location.search,
    location.state,
    navigate,
  ]);

  return null;
}

type PreviewRuntime = {
  DesignPreviewScaffold: ComponentType<{
    children: ReactNode;
    initialDevice: ReturnType<typeof getPreviewBootstrap>['device'];
  }>;
  createPreviewApiTransport: () => ReturnType<typeof createApiTransport>;
};

function RouteLoadingFallback() {
  return (
    <main className="route-loading" aria-busy="true">
      <div className="route-loading__content" role="status" aria-live="polite">
        <Spinner label={null} />
        <span>Загружаю экран</span>
      </div>
    </main>
  );
}

function KeyedChannelSuggestDialogPage({
  api,
  profile,
  userId,
}: {
  api: ReturnType<typeof createApiTransport>;
  profile: MiniappProfile;
  userId: string;
}) {
  const location = useLocation();
  return (
    <LazyChannelSuggestDialogPage
      key={JSON.stringify([userId, profile, location.pathname, location.search])}
      api={api}
      profile={profile}
      userId={userId}
    />
  );
}

function AppRouteShell({
  launchInitData,
  launchRouteAppliedRef,
  launchRouteResolver,
  managedEntityWorkspace = false,
  profile,
  networksEnabled = false,
}: {
  launchInitData: string | null;
  launchRouteAppliedRef: RefObject<string | null>;
  launchRouteResolver: (initData: string) => string | null;
  managedEntityWorkspace?: boolean;
  profile: MiniappProfile;
  networksEnabled?: boolean;
}) {
  const content = (
    <>
      {launchInitData ? (
        <LaunchRouteSync
          launchInitData={launchInitData}
          appliedRouteRef={launchRouteAppliedRef}
          launchRouteResolver={launchRouteResolver}
        />
      ) : null}
      <Shell profile={profile} networksEnabled={networksEnabled} />
    </>
  );

  return managedEntityWorkspace ? (
    <LazyManagedEntityNavigationProvider>{content}</LazyManagedEntityNavigationProvider>
  ) : (
    content
  );
}

function AppRoutes({
  apiClient,
  launchInitData,
  launchRouteAppliedRef,
  launchRouteResolver,
  me,
}: {
  apiClient: ReturnType<typeof createApiTransport>;
  launchInitData: string | null;
  launchRouteAppliedRef: RefObject<string | null>;
  launchRouteResolver: (initData: string) => string | null;
  me: Me;
}) {
  useEffect(() => {
    traceMiniappBoot('first_render', undefined, { once: true });
  }, []);

  const moderationProfile = me.profile === 'moderation';
  const profileHomeRoute = me.homeRoute;

  return (
    <Suspense fallback={<RouteLoadingFallback />}>
      <Routes>
        <Route path="/publik" element={<ProfileHomeRedirect homeRoute={profileHomeRoute} />} />
        <Route
          element={
            <AppRouteShell
              launchInitData={launchInitData}
              launchRouteAppliedRef={launchRouteAppliedRef}
              launchRouteResolver={launchRouteResolver}
              profile={me.profile}
              networksEnabled={moderationProfile && me.networksEnabled}
            />
          }
        >
          {moderationProfile ? (
            <Route path="/" element={<LazyChatsPage api={apiClient} botUrl={me.botDialogUrl} />} />
          ) : (
            <Route
              path="/"
              element={<LazyPublisherEntitiesPage api={apiClient} botDialogUrl={me.botDialogUrl} />}
            />
          )}
          {moderationProfile ? (
            <Route path="/publications" element={<LazyPublikHandoff />} />
          ) : (
            <Route
              path="/publications"
              element={
                <LazyPublicationsPage api={apiClient} profile="publisher" userId={me.userId} />
              }
            />
          )}
          {moderationProfile ? <Route path="/autoposts" element={<LazyPublikHandoff />} /> : null}
          {!moderationProfile ? (
            <Route
              path="/publisher/:entityType/:entityId"
              element={<LazyPublisherEntityModulesPage api={apiClient} />}
            />
          ) : null}
          <Route
            path="/channel/:chatId/dialog/comments"
            element={
              <LazyChannelDialogPage api={apiClient} profile={me.profile} userId={me.userId} />
            }
          />
          <Route
            path="/chat/:chatId/dialog/comments"
            element={
              <LazyChannelDialogPage api={apiClient} profile={me.profile} userId={me.userId} />
            }
          />
          <Route
            path="/channel/:chatId/dialog/suggest"
            element={
              <KeyedChannelSuggestDialogPage
                api={apiClient}
                profile={me.profile}
                userId={me.userId}
              />
            }
          />
          {moderationProfile ? (
            <Route path="/giveaways/:giveawayId" element={<LazyGiveawayPage api={apiClient} />} />
          ) : null}
          <Route path="/legal/agreement" element={<LazyLegalAgreementPage />} />
          <Route path="/legal/privacy" element={<LazyPrivacyPolicyPage />} />
          <Route path="*" element={<Navigate to={profileHomeRoute} replace />} />
        </Route>
        {moderationProfile ? (
          <Route
            element={
              <AppRouteShell
                launchInitData={launchInitData}
                launchRouteAppliedRef={launchRouteAppliedRef}
                launchRouteResolver={launchRouteResolver}
                managedEntityWorkspace
                profile="moderation"
                networksEnabled={me.networksEnabled}
              />
            }
          >
            {me.networksEnabled ? (
              <>
                <Route
                  path="/networks"
                  element={<LazyNetworksPage api={apiClient} userId={me.userId} />}
                />
                <Route
                  path="/networks/:type/settings/:section?"
                  element={<LazyNetworkSettingsRoute api={apiClient} userId={me.userId} />}
                />
              </>
            ) : null}
            <Route
              path="/chat/:chatId/settings"
              element={
                <MajorSettingsRoute>
                  <LazySettingsPage api={apiClient} />
                </MajorSettingsRoute>
              }
            />
            <Route
              path="/channel/:chatId/settings"
              element={
                <MajorSettingsRoute>
                  <LazyChannelSettingsPage api={apiClient} />
                </MajorSettingsRoute>
              }
            />
            <Route
              path="/channel/:chatId/stats"
              element={<LazyChannelStatsPage api={apiClient} />}
            />
            <Route path="/chat/:chatId/events" element={<LazyEventsPage api={apiClient} />} />
          </Route>
        ) : null}
        {!moderationProfile ? (
          <Route
            element={
              <AppRouteShell
                launchInitData={launchInitData}
                launchRouteAppliedRef={launchRouteAppliedRef}
                launchRouteResolver={launchRouteResolver}
                managedEntityWorkspace
                profile="publisher"
              />
            }
          >
            <Route
              path="/publisher/chat/:entityId/auto-replies"
              element={<LazyPublisherAutoRepliesPage api={apiClient} userId={me.userId} />}
            />
          </Route>
        ) : null}
      </Routes>
    </Suspense>
  );
}

function ProfiledAppRoutes({
  apiClient,
  launchInitData,
  launchRouteResolver,
  queryClient,
}: {
  apiClient: ReturnType<typeof createApiTransport>;
  launchInitData: string | null;
  launchRouteResolver: (initData: string) => string | null;
  queryClient: ReturnType<typeof createAuthQueryClient>;
}) {
  const [me, setMe] = useState<Me | null>();
  const location = useLocation();
  // FLAG: Route-specific providers can remount AppRoutes. Keep the consumed launcher
  // in the authenticated session so ordinary navigation cannot replay its old target.
  const launchRouteAppliedRef = useRef<string | null>(null);

  useEffect(() => {
    if (!/^\/(chat|channel)\/[^/]+\/dialog\/comments\/?$/u.test(location.pathname)) return;
    let active = true;
    let cleanup: (() => void) | undefined;
    void import('./lib/comment-dialog-startup')
      .then((module) => {
        if (active) {
          cleanup = module.prepareCommentDialogStartup(
            queryClient,
            apiClient,
            location.pathname,
            location.search,
          );
        }
      })
      .catch(() => undefined);
    return () => {
      active = false;
      cleanup?.();
    };
  }, [apiClient, queryClient, location.pathname, location.search]);

  useEffect(() => {
    let active = true;
    const queryKey = ['miniapp-profile'] as const;
    setMe(undefined);

    void queryClient
      .fetchQuery({
        queryKey,
        queryFn: async ({ signal }) => {
          const { getMe } = await import('./lib/api/me-client');
          return getMe(apiClient, { signal });
        },
        staleTime: Number.POSITIVE_INFINITY,
      })
      .then(
        (nextMe) => {
          if (active) {
            setMe(nextMe);
          }
        },
        () => {
          if (active) {
            setMe(null);
          }
        },
      );

    return () => {
      active = false;
      void queryClient.cancelQueries({ queryKey, exact: true });
    };
  }, [apiClient, queryClient]);

  if (me === undefined) {
    return <RouteLoadingFallback />;
  }
  if (!me) {
    return (
      <Suspense fallback={<RouteLoadingFallback />}>
        <LazyAppStartupState kind="profile-error" />
      </Suspense>
    );
  }
  const routes = (
    <AppRoutes
      apiClient={apiClient}
      launchInitData={launchInitData}
      launchRouteAppliedRef={launchRouteAppliedRef}
      launchRouteResolver={launchRouteResolver}
      me={me}
    />
  );
  const needsFavorites =
    location.pathname === '/' ||
    location.pathname === '/networks' ||
    location.pathname.startsWith('/networks/') ||
    /^\/(?:chat|channel)\/[^/]+\/settings\/?$/u.test(location.pathname);
  return me.profile === 'moderation' && needsFavorites ? (
    <Suspense fallback={<RouteLoadingFallback />}>
      <LazyHomeEntityFavoritesProvider api={apiClient} verifiedUserId={me.userId}>
        {routes}
      </LazyHomeEntityFavoritesProvider>
    </Suspense>
  ) : (
    routes
  );
}

function PublicLegalRoutes() {
  return (
    <AppRouter basename={ROUTER_BASENAME}>
      <Suspense fallback={<RouteLoadingFallback />}>
        <Routes>
          <Route path="/legal/agreement" element={<LazyLegalAgreementPage />} />
          <Route path="/legal/privacy" element={<LazyPrivacyPolicyPage />} />
          <Route path="*" element={<Navigate to="/legal/agreement" replace />} />
        </Routes>
      </Suspense>
    </AppRouter>
  );
}

export function App() {
  const [initData, setInitData] = useState(() => getInitData());
  const launchRouteResolver = useMemo(() => createLaunchRouteResolver(), []);
  const preview = getPreviewBootstrap(initData);
  const previewApiRef = useRef<ReturnType<typeof createApiTransport> | null>(null);
  const [previewRuntime, setPreviewRuntime] = useState<PreviewRuntime | null>(null);
  const authenticatedRouterPreparedRef = useRef(false);
  const initialLaunchRoutePreparedRef = useRef(false);
  const directEntryPreparationRef = useRef<Promise<void> | null>(null);
  const [, setRouterPreparationRevision] = useState(0);
  const nativeReadyCalledRef = useRef(false);
  const [nativeEnvironmentSignature, setNativeEnvironmentSignature] = useState(() =>
    readMaxNativeEnvironmentSignature(getInitData()),
  );

  useEffect(() => {
    if (initData) {
      traceMiniappBoot('init_data_found', undefined, { once: true });
      return;
    }

    traceMiniappBoot('init_data_waiting', undefined, { once: true });
    return waitForInitData((nextInitData) => {
      setInitData(nextInitData);
      setNativeEnvironmentSignature(readMaxNativeEnvironmentSignature(nextInitData));
    });
  }, [initData]);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return undefined;
    }

    let stopped = false;
    let pollIntervalId: ReturnType<typeof window.setInterval> | null = null;
    let pollTimeoutId: ReturnType<typeof window.setTimeout> | null = null;

    const stopPolling = () => {
      if (pollIntervalId !== null) {
        window.clearInterval(pollIntervalId);
        pollIntervalId = null;
      }
      if (pollTimeoutId !== null) {
        window.clearTimeout(pollTimeoutId);
        pollTimeoutId = null;
      }
    };

    const refreshNativeEnvironmentSignature = () => {
      if (stopped) {
        return;
      }

      const discoveredInitData = getInitData();
      if (discoveredInitData) {
        setInitData((currentInitData) =>
          currentInitData === discoveredInitData ? currentInitData : discoveredInitData,
        );
      }

      setNativeEnvironmentSignature((currentSignature) => {
        const nextSignature = readMaxNativeEnvironmentSignature(discoveredInitData || initData);
        return nextSignature === currentSignature ? currentSignature : nextSignature;
      });
    };

    refreshNativeEnvironmentSignature();
    pollIntervalId = window.setInterval(
      refreshNativeEnvironmentSignature,
      NATIVE_ENVIRONMENT_SYNC_POLL_INTERVAL_MS,
    );
    pollTimeoutId = window.setTimeout(stopPolling, NATIVE_ENVIRONMENT_SYNC_POLL_DURATION_MS);
    window.addEventListener('load', refreshNativeEnvironmentSignature, { passive: true });
    window.addEventListener('hashchange', refreshNativeEnvironmentSignature, { passive: true });
    document.addEventListener('visibilitychange', refreshNativeEnvironmentSignature);
    const maxBridgeScript = document.querySelector<HTMLScriptElement>(
      'script[src*="st.max.ru/js/max-web-app.js"]',
    );
    maxBridgeScript?.addEventListener('load', refreshNativeEnvironmentSignature);

    return () => {
      stopped = true;
      stopPolling();
      window.removeEventListener('load', refreshNativeEnvironmentSignature);
      window.removeEventListener('hashchange', refreshNativeEnvironmentSignature);
      document.removeEventListener('visibilitychange', refreshNativeEnvironmentSignature);
      maxBridgeScript?.removeEventListener('load', refreshNativeEnvironmentSignature);
    };
  }, [initData]);

  useEffect(() => {
    const cleanup = syncMaxNativeEnvironment({
      previewDevice: preview.enabled ? preview.device : null,
    });
    if (!nativeReadyCalledRef.current && readyMaxMiniApp()) {
      nativeReadyCalledRef.current = true;
    }
    traceMiniappBoot(
      'bridge_ready',
      {
        preview: preview.enabled,
        platform: document.documentElement.dataset.maxPlatform ?? null,
        client: document.documentElement.dataset.maxClient ?? null,
      },
      { once: true },
    );
    return cleanup;
  }, [nativeEnvironmentSignature, preview.device, preview.enabled]);

  useEffect(() => {
    if (!initData) {
      return;
    }

    if (!nativeReadyCalledRef.current && readyMaxMiniApp()) {
      nativeReadyCalledRef.current = true;
    }
  }, [initData]);

  useEffect(() => installMaxNativeInteractionFeedback(), []);

  useEffect(() => {
    if (!preview.enabled || previewRuntime) {
      return;
    }

    let cancelled = false;

    void import('./preview-runtime').then((module) => {
      if (cancelled) {
        return;
      }

      setPreviewRuntime({
        DesignPreviewScaffold: module.DesignPreviewScaffold,
        createPreviewApiTransport: module.createPreviewApiTransport,
      });
    });

    return () => {
      cancelled = true;
    };
  }, [preview.enabled, previewRuntime]);

  if (preview.enabled && previewRuntime && previewApiRef.current === null) {
    previewApiRef.current = previewRuntime.createPreviewApiTransport();
  }

  const PreviewScaffold = previewRuntime?.DesignPreviewScaffold ?? null;
  const authQueryPrincipalKey = useAuthQueryPrincipalKey(initData, preview.enabled);
  const serverSession = useMemo(
    () => createLazyMiniappServerSessionManager(typeof document !== 'undefined'),
    [],
  );
  const authSession = useMemo(
    () => createAuthSessionCoordinator(initData),
    [authQueryPrincipalKey],
  );
  const queryClient = useMemo(
    () => createAuthQueryClient(preview.enabled ? undefined : authSession),
    [authQueryPrincipalKey, authSession, preview.enabled],
  );
  const hasAuthenticatedInitData = Boolean(initData);
  const authenticatedApiClient = useMemo(
    () =>
      hasAuthenticatedInitData
        ? createApiTransport(getInitData, { authSession, serverSession })
        : null,
    [authQueryPrincipalKey, authSession, hasAuthenticatedInitData, serverSession],
  );

  useEffect(() => {
    if (!preview.enabled && initData) {
      authSession.observeInitData(initData);
    }
  }, [authSession, initData, preview.enabled]);

  useEffect(
    () => () => {
      queryClient.clear();
    },
    [queryClient],
  );

  if (preview.enabled && !previewRuntime) {
    return (
      <Suspense fallback={<RouteLoadingFallback />}>
        <LazyAppStartupState kind="preview-loading" />
      </Suspense>
    );
  }

  const apiClient = preview.enabled ? previewApiRef.current : authenticatedApiClient;

  if (apiClient && !authenticatedRouterPreparedRef.current) {
    if (!initialLaunchRoutePreparedRef.current && !preview.enabled && initData) {
      const initialLaunchRoute = launchRouteResolver(initData);
      traceMiniappLaunchRoute(initialLaunchRoute, 'initial');
      if (initialLaunchRoute) {
        applyInitialLaunchRoute(initialLaunchRoute);
      }
      initialLaunchRoutePreparedRef.current = true;
    }

    if (hasManagedEntityDirectEntryFromWindow()) {
      if (!directEntryPreparationRef.current) {
        directEntryPreparationRef.current = import('./lib/managed-entity-direct-entry')
          .then((module) => {
            module.prepareManagedEntityDirectEntry({
              hashRouterEnabled: HASH_ROUTER_ENABLED,
              publicRouterBasename: PUBLIC_ROUTER_BASENAME,
            });
          })
          .catch(() => undefined)
          .then(() => {
            authenticatedRouterPreparedRef.current = true;
            setRouterPreparationRevision((revision) => revision + 1);
          });
      }
    } else {
      authenticatedRouterPreparedRef.current = true;
    }
  }

  if (!apiClient && isPublicLegalPathnameFromWindow(HASH_ROUTER_ENABLED ? 'hash' : 'browser')) {
    return <PublicLegalRoutes />;
  }

  if (!apiClient) {
    return (
      <Suspense fallback={<RouteLoadingFallback />}>
        <LazyAppStartupState kind="init-missing" />
      </Suspense>
    );
  }

  if (!authenticatedRouterPreparedRef.current) {
    return <RouteLoadingFallback />;
  }

  return (
    <QueryClientProvider key={authQueryPrincipalKey} client={queryClient}>
      <ToastProvider>
        <AppRouter basename={ROUTER_BASENAME}>
          {preview.enabled && PreviewScaffold ? (
            <PreviewScaffold initialDevice={preview.device}>
              <ProfiledAppRoutes
                apiClient={apiClient}
                launchInitData={null}
                launchRouteResolver={launchRouteResolver}
                queryClient={queryClient}
              />
            </PreviewScaffold>
          ) : (
            <ProfiledAppRoutes
              apiClient={apiClient}
              launchInitData={initData}
              launchRouteResolver={launchRouteResolver}
              queryClient={queryClient}
            />
          )}
        </AppRouter>
      </ToastProvider>
    </QueryClientProvider>
  );
}
