import { createRoot } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ApiTransport } from '../../src/lib/api/transport';
import { ApiRequestError } from '../../src/lib/api-request-error';
import { createPreviewApiTransport } from '../../src/lib/api/preview-transport';
import { getPreviewApiPrincipalUserId } from '../../src/lib/api/preview-principal';
import { HomeEntityFavoritesProvider } from '../../src/lib/home-entity-favorites-context';
import { ManagedEntityNavigationProvider } from '../../src/lib/managed-entity-navigation';
import { ToastProvider } from '../../src/components/ui/toast';
import { SettingsPage } from '../../src/pages/settings-page';
import '../../src/styles.css';
import '../../src/styles/moderation-workspace.css';

const preview = createPreviewApiTransport();
const api: ApiTransport = {
  async request(path, init) {
    if (
      !path.startsWith('/chats/chat-a/settings-screen') &&
      !path.startsWith('/chats/chat-a/settings/section')
    )
      return preview.request(path, init);
    const response = await fetch(`/api${path}`, init);
    const body = await response.text();
    if (!response.ok) throw new ApiRequestError(response.status, body, 'Ошибка запроса');
    return JSON.parse(body);
  },
  requestKeepalive: preview.requestKeepalive,
};
document.body.dataset.miniappProfile = 'moderation';
window.__MAXIM_FORCE_NATIVE_VISUAL_MODE__ = true;
createRoot(document.getElementById('root')!).render(
  <QueryClientProvider
    client={
      new QueryClient({
        defaultOptions: {
          queries: { retry: false, refetchOnWindowFocus: false },
          mutations: { retry: false },
        },
      })
    }
  >
    <HomeEntityFavoritesProvider api={api} verifiedUserId={getPreviewApiPrincipalUserId(preview)!}>
      <ToastProvider>
        <MemoryRouter initialEntries={['/chats/chat-a/settings']}>
          <ManagedEntityNavigationProvider>
            <Routes>
              <Route path="/chats/:chatId/settings" element={<SettingsPage api={api} />} />
            </Routes>
          </ManagedEntityNavigationProvider>
        </MemoryRouter>
      </ToastProvider>
    </HomeEntityFavoritesProvider>
  </QueryClientProvider>,
);
