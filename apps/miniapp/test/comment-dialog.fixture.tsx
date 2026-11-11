import '../src/styles.css';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router';
import { ToastProvider } from '../src/components/ui/toast';
import { ChannelDialogPage } from '../src/pages/channel-dialog-page';
import { createPreviewApiTransport } from '../src/lib/api/preview-transport';
import { bindMaxBackButton, syncMaxNativeEnvironment } from '../src/lib/max-bridge';
import { runNativeBackHandlers } from '../src/lib/native-back';
import type {
  ChannelDialogMessage,
  ChannelDialogResponse,
  DeleteChannelDialogMessageResponse,
  ToggleChannelDialogReactionResponse,
} from '@maxim/contracts/channel-dialog';
import type { ApiTransport } from '../src/lib/api/transport';

const preview = createPreviewApiTransport();
const route = '/channels/preview-channel/dialog/comments';
const token = 'preview-comments-token-0001';
const initial = await preview.request<ChannelDialogResponse>(`${route}?token=${token}`);
const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
let sequence = 0;
const message = (
  text = 'Комментарий для проверки прокрутки. Весь текст должен быть доступен. https://example.org/info',
) => ({
  ...initial.messages[0]!,
  id: `scroll-comment-${++sequence}`,
  createdAt: new Date(2026, 8, 13, 12, sequence).toISOString(),
  authorUserId: 'preview-admin',
  authorDisplayName: 'Алексей',
  canEdit: true,
  canDelete: true,
  attachments: [],
  text,
});
let data = { ...initial, messages: Array.from({ length: 24 }, () => message()) };
let pendingSend: { resolve: () => void; reject: (error: Error) => void } | null = null;
let holdSend = false;
let holdDelete = false;
let pendingDelete: { resolve: () => void; reject: (error: Error) => void } | null = null;
const profileRequests: string[] = [];
const deleteRequests: { id: string; token: string | null }[] = [];
let failNotificationSave = false;
const profile =
  new URLSearchParams(location.search).get('profile') === 'publisher' ? 'publisher' : 'moderation';
const api: ApiTransport = {
  ...preview,
  async request(path, init = {}) {
    if (path.startsWith(route) && (!init.method || init.method === 'GET')) {
      return structuredClone(data) as never;
    }
    const payload = JSON.parse(String(init.body ?? '{}'));
    if (path.endsWith('/profile/handoff') && init.method === 'POST') {
      profileRequests.push(path);
      return { botUrl: 'https://max.ru/synthetic_profile_bot?start=profile' } as never;
    }
    if (path.endsWith('/notifications') && init.method === 'PUT') {
      if (failNotificationSave) {
        failNotificationSave = false;
        throw new Error('Не удалось сохранить уведомления');
      }
      const settings = { ...data.notificationSettings };
      const key =
        payload.scope === 'thread'
          ? 'thread'
          : payload.scope === 'channel'
            ? 'channel'
            : 'allChannels';
      settings[key] = { mode: payload.mode, explicit: true };
      settings.scope = settings.thread.explicit
        ? 'thread'
        : settings.channel.explicit
          ? 'channel'
          : settings.allChannels.explicit
            ? 'all_channels'
            : 'thread';
      settings.mode =
        settings.scope === 'thread'
          ? settings.thread.mode
          : settings.scope === 'channel'
            ? settings.channel.mode
            : settings.allChannels.mode;
      data = { ...data, notificationSettings: settings };
      return { ok: true, notificationSettings: settings } as never;
    }
    if (path.endsWith('/messages') && init.method === 'POST') {
      if (holdSend) {
        await new Promise<void>((resolve, reject) => {
          pendingSend = { resolve, reject };
        });
      }
      const next = message(payload.text);
      data = { ...data, messages: [...data.messages, next] };
      return { ok: true, message: next } as never;
    }
    if (init.method === 'DELETE' && path.includes('/messages/')) {
      const url = new URL(path, 'http://fixture.invalid');
      const id = decodeURIComponent(url.pathname.split('/').at(-1)!);
      deleteRequests.push({ id, token: payload.token ?? url.searchParams.get('token') });
      if (holdDelete)
        await new Promise<void>((resolve, reject) => {
          pendingDelete = { resolve, reject };
        });
      const selected = data.messages.find((item) => item.id === id);
      if (!selected || (!selected.canDelete && !selected.canDeleteAsAdmin))
        throw new Error('Комментарий недоступен');
      data = { ...data, messages: data.messages.filter((item) => item.id !== id) };
      const response: DeleteChannelDialogMessageResponse = { ok: true, deletedMessageId: id };
      return response as never;
    }
    if (init.method === 'POST' && path.includes('/reactions')) {
      const id = decodeURIComponent(path.split('/').at(-2)!);
      const selected = data.messages.find((item) => item.id === id)!;
      const reaction = selected.reactionGroups.find((item) => item.emoji === payload.emoji);
      const next = {
        ...selected,
        reactionGroups: reaction
          ? selected.reactionGroups.map((item) =>
              item.emoji === payload.emoji
                ? {
                    ...item,
                    reactedByMe: !item.reactedByMe,
                    count: item.count + (item.reactedByMe ? -1 : 1),
                  }
                : item,
            )
          : [...selected.reactionGroups, { emoji: payload.emoji, count: 1, reactedByMe: true }],
      };
      data = { ...data, messages: data.messages.map((item) => (item.id === id ? next : item)) };
      const response: ToggleChannelDialogReactionResponse = { ok: true, message: next };
      return response as never;
    }
    if (init.method === 'PATCH' && path.includes('/messages/')) {
      const id = path.split('/').at(-1);
      const next = { ...data.messages.find((item) => item.id === id)!, text: payload.text };
      data = { ...data, messages: data.messages.map((item) => (item.id === id ? next : item)) };
      return { ok: true, message: next } as never;
    }
    return preview.request(path, init);
  },
};

const root = createRoot(document.getElementById('root')!);

Object.assign(window, {
  commentTest: {
    deleteRequests,
    profileRequests,
    holdDelete() {
      holdDelete = true;
    },
    finishDelete(fail = false) {
      if (!pendingDelete) throw new Error('No pending delete');
      if (fail) pendingDelete.reject(new Error('Не удалось удалить комментарий'));
      else pendingDelete.resolve();
      holdDelete = false;
      pendingDelete = null;
    },
    async updateMessage(id: string, change: Partial<ChannelDialogMessage> | null) {
      data = {
        ...data,
        messages: data.messages.flatMap((item) =>
          item.id !== id ? [item] : change ? [{ ...item, ...change }] : [],
        ),
      };
      await client.invalidateQueries();
    },
    setUserId(userId: string) {
      renderFixture(userId);
    },
    failNotificationSave() {
      failNotificationSave = true;
    },
    async refresh() {
      await client.invalidateQueries();
    },
    async setTruncated(hasMoreMessages: boolean) {
      data = { ...data, hasMoreMessages };
      await client.invalidateQueries();
    },
    async append(text: string) {
      data = { ...data, messages: [...data.messages, message(text)] };
      await client.invalidateQueries();
    },
    holdSend() {
      holdSend = true;
    },
    finishSend(fail = false) {
      if (!pendingSend) throw new Error('No pending send');
      if (fail) pendingSend.reject(new Error('Не удалось отправить комментарий'));
      else pendingSend.resolve();
      holdSend = false;
      pendingSend = null;
    },
    async empty() {
      data = { ...data, messages: [] };
      await client.invalidateQueries();
    },
  },
});

function renderFixture(userId = 'preview-admin') {
  root.render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <MemoryRouter initialEntries={[`/channel/preview-channel/dialog/comments?token=${token}`]}>
          <div className="app-shell app-shell--no-topbar app-shell--immersive app-shell--comments-dialog">
            <div className="shell-content">
              <Routes>
                <Route
                  path="/channel/:chatId/dialog/comments"
                  element={<ChannelDialogPage api={api} profile={profile} userId={userId} />}
                />
              </Routes>
            </div>
          </div>
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

syncMaxNativeEnvironment();
const unbindBack = bindMaxBackButton(runNativeBackHandlers);
window.addEventListener('pagehide', unbindBack, { once: true });
renderFixture();
