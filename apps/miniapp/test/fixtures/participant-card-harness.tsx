import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ChatParticipantCard } from '../../src/components/dashboard/chat-participant-card';
import { ToastProvider } from '../../src/components/ui/toast';
import type { ApiTransport } from '../../src/lib/api/transport';
import type { ParticipantCardTarget } from '../../src/lib/participant-card';
import { runNativeBackHandlers } from '../../src/lib/native-back';
import '../../src/styles.css';
import '../../src/styles/settings-drilldown-core.css';
import '../../src/styles/settings-experience.css';
import '../../src/styles/moderation-workspace.css';

const pending = new Map<
  string,
  { resolve: (value: unknown) => void; reject: (error: Error) => void }
>();
const requests: string[] = [];
const aborted: string[] = [];
const actions: Array<{
  chatId: string;
  userId: string;
  action: 'MUTE' | 'BAN';
  durationHours?: number;
  banOnRejoin?: boolean;
}> = [];
const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
const api: ApiTransport = {
  requestKeepalive: () => {},
  request: async (path, init) => {
    requests.push(path);
    if (path.includes('/sanctions?'))
      return { items: [], hasMore: false, nextCursor: null, serverTime: new Date().toISOString() };
    init?.signal?.addEventListener('abort', () => aborted.push(path), { once: true });
    return new Promise((resolve, reject) => pending.set(path, { resolve, reject }));
  },
};
const root = createRoot(document.getElementById('root')!);
const show = (chatId: string, userId: string) => {
  const target: ParticipantCardTarget = {
    chatId,
    userId,
    userDisplayName: 'Алексей',
    origin: { title: `Событие ${userId}` },
  };
  root.render(
    createElement(
      QueryClientProvider,
      { client },
      createElement(
        ToastProvider,
        null,
        createElement(ChatParticipantCard, {
          key: `${chatId}:${userId}`,
          api,
          target,
          range: '7d',
          rangeLabel: 'за 7 дней',
          chatTitle: chatId,
          open: true,
          isApplyingModeration: false,
          isOpeningProfile: false,
          onClose: () => root.render(null),
          onProfileActivate: () => {},
          onSpammerDiagnostics: () => {},
          onMute: (durationHours) =>
            actions.push({ chatId, userId, action: 'MUTE', durationHours }),
          onBan: (banOnRejoin) => actions.push({ chatId, userId, action: 'BAN', banOnRejoin }),
          onRelease: async () => 'ok',
          describeReason: () => '',
        }),
      ),
    ),
  );
};
const resolve = (chatId: string, userId: string, extra: Record<string, unknown> = {}) => {
  pending.get(`/chats/${chatId}/members/${userId}?range=7d`)?.resolve({
    userId,
    userDisplayName: 'Алексей',
    username: userId,
    role: 'member',
    membershipStatus: 'member',
    canManage: true,
    ...extra,
  });
};
const fail = (chatId: string, userId: string) =>
  pending.get(`/chats/${chatId}/members/${userId}?range=7d`)?.reject(new Error('Сеть недоступна'));
document.body.dataset.miniappProfile = 'moderation';
Object.assign(window, {
  participantCardTest: {
    show,
    resolve,
    fail,
    requests,
    aborted,
    actions,
    back: runNativeBackHandlers,
  },
});
show('chat-1', 'one');
