import { useLayoutEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ChatSanctionItem, MembershipActivityPage } from '@maxim/contracts';
import { EventsPage } from '../../src/pages/events-page';
import { ChannelStatsPage } from '../../src/pages/channel-stats-page';
import { ChatSanctionsWorkspace } from '../../src/components/dashboard/chat-sanctions-workspace';
import { ToastProvider } from '../../src/components/ui/toast';
import { ManagedEntityNavigationProvider } from '../../src/lib/managed-entity-navigation';
import { createPreviewApiTransport } from '../../src/lib/api/preview-transport';
import type { ApiTransport } from '../../src/lib/api/transport';
import '../../src/styles.css';

const preview = createPreviewApiTransport();
const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
});
const state = {
  failDashboard: false,
  holdMutations: false,
  channelHistory: false,
  localBanReleased: false,
  calls: [] as Array<{ path: string; method: string; body?: unknown }>,
  pending: [] as Array<() => void>,
  navigate: (_path: string) => {},
  expiresAt: 0,
};
const api: ApiTransport = {
  async request(path, init) {
    const method = init?.method ?? 'GET';
    const url = new URL(path, 'https://preview.local');
    state.calls.push({
      path,
      method,
      ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
    });
    if (method !== 'GET' && state.holdMutations)
      await new Promise<void>((resolve) => state.pending.push(resolve));
    if (
      state.failDashboard &&
      /\/(activity-dashboard|moderation-dashboard|stats)$/.test(url.pathname)
    )
      throw new Error('Нет соединения. Повторите.');
    if (
      url.pathname === '/chats/local-ban/members/local-user/moderation-action' &&
      method === 'POST'
    ) {
      state.localBanReleased = true;
      return {
        ok: true,
        action: 'UNBAN',
        userId: 'local-user',
        muteDurationHours: null,
        muteExpiresAt: null,
        message: 'Бан снят.',
      };
    }
    if (url.pathname === '/chats/local-ban/sanctions') {
      const item: ChatSanctionItem = {
        id: 'local-ban-event',
        userId: 'local-user',
        userDisplayName: 'Ушедший участник',
        action: 'BAN',
        status: 'active',
        permanent: true,
        createdAt: new Date(Date.now() - 60_000).toISOString(),
        expiresAt: null,
        endedAt: null,
        operator: 'ADMIN',
        actorDisplayName: 'Администратор',
        ruleCode: 'MANUAL_BAN',
        reason: null,
        avatarUrl: null,
        profileHandoffUrl: null,
        releaseAction: 'UNBAN',
        banOnRejoin: true,
      };
      return {
        items: state.localBanReleased ? [] : [item],
        serverTime: new Date().toISOString(),
        hasMore: false,
        nextCursor: null,
      };
    }
    if (url.pathname.endsWith('/sanctions') && url.pathname.includes('/expiry/')) {
      state.expiresAt ||= Date.now() + 2000;
      const item: ChatSanctionItem = {
        id: 'expiry-event',
        userId: 'expiry-user',
        userDisplayName: 'Участник с коротким сроком',
        action: 'MUTE',
        status: 'active',
        permanent: false,
        createdAt: new Date(state.expiresAt - 60_000).toISOString(),
        expiresAt: new Date(state.expiresAt).toISOString(),
        endedAt: null,
        operator: 'ADMIN',
        actorDisplayName: 'Администратор',
        ruleCode: 'MANUAL_MUTE',
        reason: 'Проверка срока',
        avatarUrl: null,
        profileHandoffUrl: null,
        releaseAction: 'UNMUTE',
      };
      return {
        items: [item],
        serverTime: new Date().toISOString(),
        hasMore: false,
        nextCursor: null,
      };
    }
    const result = await preview.request(path, init);
    if (
      state.channelHistory &&
      url.pathname.startsWith('/channels/') &&
      url.pathname.endsWith('/activity-feed')
    ) {
      const page = result as MembershipActivityPage;
      const member = page.items.find((item) => item.type === 'joined')!;
      const start = url.searchParams.has('cursor') ? 50 : 0;
      return {
        items: Array.from({ length: start ? 25 : 50 }, (_, offset) => ({
          ...member,
          id: `event-${start + offset}`,
        })),
        hasMore: start === 0,
        nextCursor: start === 0 ? 'more' : null,
      };
    }
    if (url.pathname.endsWith('/header'))
      return { ...(result as object), title: 'Свежий заголовок' };
    return result;
  },
  requestKeepalive() {},
};

function Workspace() {
  const navigate = useNavigate();
  useLayoutEffect(() => {
    state.navigate = (path) => navigate(path);
  }, [navigate]);
  return (
    <ManagedEntityNavigationProvider>
      <Routes>
        <Route path="/chat/:chatId/events" element={<EventsPage api={api} />} />
        <Route path="/channel/:chatId/stats" element={<ChannelStatsPage api={api} />} />
        <Route
          path="/expiry"
          element={
            <ChatSanctionsWorkspace
              api={api}
              chatId="expiry"
              chatTitle="Проверка"
              onProfileActivate={() => {}}
              onChanged={() => {}}
              onRelease={async () => {
                state.calls.push({ path: 'release', method: 'POST' });
                return 'Снято';
              }}
              describeReason={(item) => item.reason ?? item.ruleCode}
            />
          }
        />
      </Routes>
    </ManagedEntityNavigationProvider>
  );
}

document.body.dataset.miniappProfile = 'moderation';
Object.assign(window, { statisticsTest: state });
createRoot(document.getElementById('root')!).render(
  <QueryClientProvider client={queryClient}>
    <ToastProvider>
      <MemoryRouter
        initialEntries={['/chat/preview-chat/events?section=moderation&moderationView=history']}
      >
        <Workspace />
      </MemoryRouter>
    </ToastProvider>
  </QueryClientProvider>,
);
