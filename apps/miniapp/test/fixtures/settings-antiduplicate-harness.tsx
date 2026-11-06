import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Link, MemoryRouter, Route, Routes } from 'react-router';
import { chatSettingsSchema, type ChatSettingsScreenResponse } from '@maxim/contracts/settings';
import { SettingsPage } from '../../src/pages/settings-page';
import { ToastProvider } from '../../src/components/ui/toast';
import { createPreviewApiTransport } from '../../src/lib/api/preview-transport';
import type { ApiTransport } from '../../src/lib/api/transport';
import { ApiRequestError } from '../../src/lib/api-request-error';
import { runNativeBackHandlers } from '../../src/lib/native-back';
import { ManagedEntityNavigationProvider } from '../../src/lib/managed-entity-navigation';
import { HomeEntityFavoritesProvider } from '../../src/lib/home-entity-favorites-context';
import { getPreviewApiPrincipalUserId } from '../../src/lib/api/preview-principal';
import '../../src/styles.css';
import '../../src/styles/moderation-workspace.css';

const preview = createPreviewApiTransport();
const verifiedUserId = getPreviewApiPrincipalUserId(preview)!;
const screen = (await preview.request(
  '/chats/chat-a/settings-screen',
)) as ChatSettingsScreenResponse;
screen.settings = chatSettingsSchema.parse({
  settingsRevision: '2026-10-04T00:00:00.000Z',
  antiDuplicateEnabled: true,
  duplicateCompareMode: 'TEXT',
  duplicateWindowMode: 'INTERVAL',
  duplicateStartTimeMinutes: 540,
  duplicateEndTimeMinutes: 1080,
  duplicateTimezone: 'Europe/Moscow',
});
screen.rules = {
  ...screen.rules,
  text: 'Авторские правила — сохранить дословно.',
  autoTextEnabled: false,
  publishedMessageId: null,
  publishedUrl: null,
  publishedAt: null,
};
// Read-only response data: browser tests supply network responses, never mutate page state.
Object.defineProperty(window, '__ANTIDUPLICATE_SCREEN__', { value: screen });
document.body.dataset.miniappProfile = 'moderation';
window.WebApp?.BackButton?.onClick(() => runNativeBackHandlers());
const api: ApiTransport = {
  async request(path, init) {
    if (
      /\/(?:settings-screen|duplicate-diagnostics)(?:\?|$)/u.test(path) ||
      (init?.method && init.method !== 'GET')
    ) {
      const response = await fetch(`/api${path}`, init);
      const body = await response.text();
      if (!response.ok) throw new ApiRequestError(response.status, body, 'Не удалось сохранить');
      return JSON.parse(body);
    }
    return preview.request(path, init);
  },
  requestKeepalive() {},
};
createRoot(document.getElementById('root')!).render(
  <QueryClientProvider
    client={
      new QueryClient({
        defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
      })
    }
  >
    <HomeEntityFavoritesProvider api={api} verifiedUserId={verifiedUserId}>
      <ToastProvider>
        <MemoryRouter initialEntries={['/chat/chat-a/settings']}>
          {/* Host route changes may arrive while the workspace's own navigation is guarded. */}
          <nav
            aria-label="Тестовая навигация между чатами"
            style={{ position: 'fixed', top: 0, right: 0, zIndex: 10000, background: 'white' }}
          >
            <Link to="/chat/chat-a/settings">Чат A</Link>{' '}
            <Link to="/chat/chat-b/settings">Чат B</Link>
          </nav>
          <ManagedEntityNavigationProvider>
            <Routes>
              <Route path="/chat/:chatId/settings" element={<SettingsPage api={api} />} />
            </Routes>
          </ManagedEntityNavigationProvider>
        </MemoryRouter>
      </ToastProvider>
    </HomeEntityFavoritesProvider>
  </QueryClientProvider>,
);
