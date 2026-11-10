import '../../src/styles.css';
import '../../src/styles/moderation-workspace.css';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router';
import type { ChatSettingsScreenResponse } from '@maxim/contracts/settings';
import { SettingsPage } from '../../src/pages/settings-page';
import { ToastProvider } from '../../src/components/ui/toast';
import { createPreviewApiTransport } from '../../src/lib/api/preview-transport';
import type { ApiTransport } from '../../src/lib/api/transport';
import { ApiRequestError } from '../../src/lib/api-request-error';
import { ManagedEntityNavigationProvider } from '../../src/lib/managed-entity-navigation';
import { HomeEntityFavoritesProvider } from '../../src/lib/home-entity-favorites-context';
import { getPreviewApiPrincipalUserId } from '../../src/lib/api/preview-principal';
import { syncMaxNativeEnvironment } from '../../src/lib/max-bridge';

const preview = createPreviewApiTransport();
const verifiedUserId = getPreviewApiPrincipalUserId(preview)!;
const screen = (await preview.request(
  '/chats/chat-a/settings-screen',
)) as ChatSettingsScreenResponse;
screen.rules = {
  ...screen.rules,
  revision: '2026-11-10T06:00:00.000Z',
  text: 'Правила чата: уважайте участников и соблюдайте порядок.',
  autoTextEnabled: false,
  publishedMessageId: 'old-post',
  publishedUrl: 'https://max.ru/old-post',
  publishedAt: '2026-11-10T06:00:00.000Z',
};
Object.defineProperty(window, '__RULES_SCREEN__', { value: screen });
document.body.dataset.miniappProfile = 'moderation';
syncMaxNativeEnvironment();
const api: ApiTransport = {
  async request(path, init) {
    if (/\/(?:settings-screen|rules)(?:\/|\?|$)/u.test(path)) {
      const response = await fetch(`/api${path}`, init);
      const body = await response.text();
      if (!response.ok) {
        const parsed = JSON.parse(body) as { message: string };
        throw new ApiRequestError(response.status, body, parsed.message);
      }
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
        <MemoryRouter initialEntries={['/chat/chat-a/settings?focus=rules']}>
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
