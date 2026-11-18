import { AppIcon } from './ui/app-icon';
import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate, useParams } from 'react-router';
import { cn } from '../lib/cn';
import { saveChatTitle } from '../lib/chat-titles';
import {
  bindMaxBackButton,
  closeMaxMiniApp,
  maxImpact,
  setMaxBackButtonVisible,
} from '../lib/max-bridge';
import {
  buildManagedEntitiesRoute,
  hydrateLastEntityState,
  isManagedEntityWorkspacePath,
  normalizeEntityType,
  readLastEntityType,
  saveLastEntityId,
  saveLastEntityType,
  type LastEntityType,
} from '../lib/last-chat';
import { useOptionalManagedEntityNavigation } from '../lib/managed-entity-navigation-context';
import { runNativeBackHandlers, useNativeBackHandlersAvailable } from '../lib/native-back';
import { useKeyboardOpen } from '../lib/use-keyboard-open';
import type { MiniappProfile } from '@maxim/contracts/publisher';
import { openPublikBot, PUBLIK_BOT_URL } from '../lib/publik-bot';
import '../styles/moderation-workspace.css';
import '../styles/publisher-workspace.css';

export function Shell({
  profile = 'moderation',
  networksEnabled = false,
}: {
  profile?: MiniappProfile;
  networksEnabled?: boolean;
}) {
  useEffect(() => {
    document.body.dataset.miniappProfile = profile;
    return () => {
      delete document.body.dataset.miniappProfile;
    };
  }, [profile]);
  const { chatId = '', entityId = '' } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const managedEntityNavigation = useOptionalManagedEntityNavigation();
  const [lastEntityType, setLastEntityType] = useState<LastEntityType>(() => readLastEntityType());
  const isKeyboardOpen = useKeyboardOpen();
  const hasNativeBackHandlers = useNativeBackHandlersAvailable();
  const isChatsRoute = location.pathname === '/';
  const isNetworksRoute =
    profile === 'moderation' && networksEnabled && location.pathname === '/networks';
  const isNetworkSettingsRoute =
    profile === 'moderation' && location.pathname.startsWith('/networks/');
  const isNetworkSettingsHub =
    isNetworkSettingsRoute && /^\/networks\/(chat|channel)\/settings\/?$/u.test(location.pathname);
  const isPublicationsRoute =
    location.pathname === '/publications' || location.pathname === '/autoposts';
  const isProfileHomeRoute = isChatsRoute;
  const selectedRootEntityType = useMemo(
    () =>
      normalizeEntityType(
        new URLSearchParams(location.search).get('view'),
        profile === 'publisher' ? 'chat' : lastEntityType,
      ),
    [lastEntityType, location.search, profile],
  );
  const routeEntityType: LastEntityType = location.pathname.includes('/channel/')
    ? 'channel'
    : 'chat';
  const routeChatTitle =
    typeof location.state === 'object' &&
    location.state &&
    'chatTitle' in location.state &&
    typeof location.state.chatTitle === 'string'
      ? location.state.chatTitle.trim()
      : '';
  const isPublisherAutoRepliesRoute =
    profile === 'publisher' &&
    /^\/publisher\/chat\/[^/]+\/auto-replies\/?$/u.test(location.pathname);
  const isManagedEntityRoute = isManagedEntityWorkspacePath(location.pathname);
  const isManagedEntityWorkspaceRoute = isManagedEntityRoute || isPublisherAutoRepliesRoute;

  useEffect(() => {
    if (!chatId || !isManagedEntityRoute) {
      return;
    }

    saveLastEntityId(routeEntityType, chatId);
    setLastEntityType(routeEntityType);

    if (!routeChatTitle) {
      return;
    }

    saveChatTitle(chatId, routeChatTitle);
  }, [chatId, isManagedEntityRoute, routeChatTitle, routeEntityType]);

  useEffect(() => {
    let cancelled = false;

    void hydrateLastEntityState().then((state) => {
      if (cancelled) {
        return;
      }

      if (!chatId) {
        setLastEntityType(state.entityType);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [chatId]);

  useEffect(() => {
    if (!isChatsRoute || profile !== 'moderation') {
      return;
    }

    saveLastEntityType(selectedRootEntityType);
    setLastEntityType(selectedRootEntityType);
  }, [isChatsRoute, profile, selectedRootEntityType]);

  const resolvedEntityType: LastEntityType = isChatsRoute
    ? selectedRootEntityType
    : isManagedEntityWorkspaceRoute
      ? routeEntityType
      : lastEntityType;
  const homeRoute = profile === 'publisher' ? '/' : buildManagedEntitiesRoute(resolvedEntityType);
  const managedEntityBackRoute = isPublisherAutoRepliesRoute
    ? `/publisher/chat/${encodeURIComponent(entityId)}`
    : homeRoute;
  const networksEntityType = isNetworksRoute
    ? normalizeEntityType(new URLSearchParams(location.search).get('type'), resolvedEntityType)
    : isNetworkSettingsRoute
      ? routeEntityType
      : resolvedEntityType;

  const isGiveawayRoute = location.pathname.includes('/giveaways/');
  const isLegalRoute = location.pathname.startsWith('/legal/');
  const isSuggestionReviewRoute =
    /^\/suggestions\/[A-Za-z0-9_-]{1,160}\/(edit|reject|publish)\/?$/u.test(location.pathname);
  const isDialogRoute =
    isSuggestionReviewRoute ||
    (location.pathname.includes('/dialog/') &&
      (location.pathname.includes('/channel/') || location.pathname.includes('/chat/')));
  const isCommentsDialogRoute = isDialogRoute && location.pathname.includes('/dialog/comments');
  const isSuggestDialogRoute = isDialogRoute && location.pathname.includes('/dialog/suggest');
  const shouldCloseDialogOnBack = isDialogRoute;
  const shouldCloseMiniAppOnBack = shouldCloseDialogOnBack || isGiveawayRoute;
  const isSettingsRoute = location.pathname.includes('/settings');
  const isEventsRoute = location.pathname.includes('/events');
  const isChannelStatsRoute =
    location.pathname.includes('/channel/') && location.pathname.includes('/stats');
  const isPublisherEntityModulesRoute =
    profile === 'publisher' && /^\/publisher\/(?:chat|channel)\/[^/]+\/?$/u.test(location.pathname);
  const shouldShowBottomNav =
    isChatsRoute || isPublicationsRoute || isNetworksRoute || isNetworkSettingsHub;
  const hasTopbar =
    !isChatsRoute &&
    !isPublicationsRoute &&
    !isNetworksRoute &&
    !isNetworkSettingsRoute &&
    !isSettingsRoute &&
    !isEventsRoute &&
    !isDialogRoute &&
    !isChannelStatsRoute &&
    !isPublisherEntityModulesRoute &&
    !isPublisherAutoRepliesRoute &&
    !isGiveawayRoute &&
    !isLegalRoute;

  useEffect(() => {
    const shouldShowNativeBack = !isProfileHomeRoute || hasNativeBackHandlers;
    setMaxBackButtonVisible(shouldShowNativeBack);

    if (!shouldShowNativeBack) {
      return () => {
        setMaxBackButtonVisible(false);
      };
    }

    const cleanup = bindMaxBackButton(() => {
      maxImpact('light');
      if (runNativeBackHandlers()) {
        return;
      }

      if (shouldCloseMiniAppOnBack) {
        closeMaxMiniApp(() => {
          navigate(homeRoute, { replace: true });
        });
        return;
      }

      if (isManagedEntityRoute) {
        if (managedEntityNavigation) {
          managedEntityNavigation.requestBack(homeRoute);
        } else {
          navigate(homeRoute, { replace: true });
        }
        return;
      }

      if (isPublisherAutoRepliesRoute) {
        if (managedEntityNavigation) {
          managedEntityNavigation.requestBack(managedEntityBackRoute);
        } else {
          navigate(managedEntityBackRoute, { replace: true });
        }
        return;
      }

      navigate(homeRoute, { replace: true });
    });

    return () => {
      cleanup();
      setMaxBackButtonVisible(false);
    };
  }, [
    hasNativeBackHandlers,
    homeRoute,
    isProfileHomeRoute,
    isManagedEntityRoute,
    isPublisherAutoRepliesRoute,
    managedEntityNavigation,
    managedEntityBackRoute,
    navigate,
    shouldCloseMiniAppOnBack,
  ]);

  return (
    <div
      className={cn(
        'app-shell',
        !hasTopbar && 'app-shell--no-topbar',
        profile === 'publisher' && isChatsRoute && 'app-shell--publisher-catalog',
        (isDialogRoute || isGiveawayRoute) && 'app-shell--immersive',
        isCommentsDialogRoute && 'app-shell--comments-dialog',
        isSuggestDialogRoute && 'app-shell--suggest-dialog',
      )}
      style={
        shouldShowBottomNav
          ? undefined
          : ({ '--bottom-nav-height': '0px', '--bottom-nav-offset': '0px' } as CSSProperties)
      }
    >
      {hasTopbar ? (
        <header className="shell-topbar glass-card glass-card--sm">
          <div className="shell-topbar__brand-row">
            <Link to={homeRoute} className="shell-brand">
              {profile === 'publisher' ? 'Публик' : 'Панель'}
            </Link>
            <span className="shell-chip">{profile === 'publisher' ? 'Кабинет' : 'Панель'}</span>
          </div>
          <div className="shell-topbar__content">
            <h2>Панель</h2>
          </div>
        </header>
      ) : null}

      <main className="shell-content">
        <Outlet />
      </main>

      {shouldShowBottomNav ? (
        <nav
          className={cn(
            'bottom-nav bottom-nav--primary glass-card',
            profile === 'moderation' && networksEnabled && 'bottom-nav--four',
            isKeyboardOpen && 'is-keyboard-open',
          )}
          inert={isKeyboardOpen}
          aria-hidden={isKeyboardOpen || undefined}
          aria-label={profile === 'publisher' ? 'Навигация Публика' : 'Навигация Майора'}
        >
          <Link
            to={buildManagedEntitiesRoute('chat')}
            className={cn(
              'bottom-nav__item',
              isChatsRoute && selectedRootEntityType === 'chat' && 'is-active',
            )}
            aria-current={isChatsRoute && selectedRootEntityType === 'chat' ? 'page' : undefined}
          >
            <span className="bottom-nav__icon" aria-hidden>
              <AppIcon icon="ChatLines" className="bottom-nav__icon-svg" />
            </span>
            <span className="bottom-nav__label">Чаты</span>
          </Link>

          <Link
            to={buildManagedEntitiesRoute('channel')}
            className={cn(
              'bottom-nav__item',
              isChatsRoute && selectedRootEntityType === 'channel' && 'is-active',
            )}
            aria-current={isChatsRoute && selectedRootEntityType === 'channel' ? 'page' : undefined}
          >
            <span className="bottom-nav__icon" aria-hidden>
              <AppIcon icon="Megaphone" className="bottom-nav__icon-svg" />
            </span>
            <span className="bottom-nav__label">Каналы</span>
          </Link>

          {profile === 'moderation' && networksEnabled ? (
            <Link
              to={`/networks?type=${networksEntityType}`}
              className={cn(
                'bottom-nav__item',
                (isNetworksRoute || isNetworkSettingsHub) && 'is-active',
              )}
              aria-current={isNetworksRoute || isNetworkSettingsHub ? 'page' : undefined}
            >
              <span className="bottom-nav__icon" aria-hidden>
                <AppIcon icon="Community" className="bottom-nav__icon-svg" />
              </span>
              <span className="bottom-nav__label">Сетки</span>
            </Link>
          ) : null}

          {profile === 'publisher' ? (
            <NavLink
              to="/publications"
              className={({ isActive }) => cn('bottom-nav__item', isActive && 'is-active')}
            >
              <span className="bottom-nav__icon" aria-hidden>
                <AppIcon icon="SendDiagonal" className="bottom-nav__icon-svg" />
              </span>
              <span className="bottom-nav__label">Посты</span>
            </NavLink>
          ) : (
            <a
              className="bottom-nav__item"
              href={PUBLIK_BOT_URL}
              onClick={openPublikBot}
              aria-label="Открыть бота Публик"
              title="Открыть бота Публик"
            >
              <span className="bottom-nav__icon" aria-hidden>
                <AppIcon icon="SendDiagonal" className="bottom-nav__icon-svg" />
              </span>
              <span className="bottom-nav__label">Публик</span>
            </a>
          )}
        </nav>
      ) : null}
    </div>
  );
}
