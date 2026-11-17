import '../../src/styles.css';

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
import '../../src/styles/moderation-workspace.css';

const preview = createPreviewApiTransport();
const control = {
  failSave: false,
  requests: [] as Array<{ path: string; method: string; body: unknown }>,
};
const api: ApiTransport = {
  async request(path, init) {
    const method = init?.method ?? 'GET';
    if (method !== 'GET') {
      control.requests.push({
        path,
        method,
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : null,
      });
      if (control.failSave && path.endsWith('/settings/section'))
        throw new ApiRequestError(
          503,
          JSON.stringify({ message: 'Сохранение временно недоступно' }),
          'Не удалось сохранить',
        );
    }
    return preview.request(path, init);
  },
  requestKeepalive: preview.requestKeepalive,
};
Object.assign(window, { directSaveTest: control });
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
        <MemoryRouter initialEntries={['/chats/preview-chat/settings']}>
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
