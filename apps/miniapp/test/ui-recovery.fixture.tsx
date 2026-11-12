import '../src/styles.css';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router';
import { ToastProvider } from '../src/components/ui/toast';
import { PublicationsPage } from '../src/pages/publications-page';
import { ChannelDialogPage } from '../src/pages/channel-dialog-page';
import { ChannelSuggestDialogPage } from '../src/pages/channel-suggest-dialog-page';
import { createPreviewApiTransport } from '../src/lib/api/preview-transport';
import { syncMaxNativeEnvironment } from '../src/lib/max-bridge';
import type { ApiTransport } from '../src/lib/api/transport';

const params = new URLSearchParams(location.search);
const surface = params.get('surface') ?? 'publications';
const preview = createPreviewApiTransport();
const client = new QueryClient({ defaultOptions: { queries: { retry: false, retryDelay: 10 } } });
let failure = params.get('failure') ?? '';
const reads: string[] = [];
const writes: string[] = [];
const isSelectedRead = (path: string) =>
  surface === 'picker'
    ? path.startsWith('/publisher/entities?')
    : surface === 'publications'
      ? path.startsWith('/publications?')
      : path.startsWith(`/channels/preview-channel/dialog/${surface}?`);
const api: ApiTransport = {
  ...preview,
  async request(path, init = {}) {
    if ((!init.method || init.method === 'GET') && isSelectedRead(path)) {
      reads.push(path);
      if (failure) throw new Error(failure);
    }
    if (init.method && init.method !== 'GET') {
      writes.push(path);
      throw new Error('Writes are disabled in the recovery fixture');
    }
    return preview.request(path, init);
  },
};
Object.assign(window, {
  recoveryTest: {
    reads,
    writes,
    setFailure(message: string) {
      failure = message;
    },
    async refresh() {
      await client.invalidateQueries();
    },
  },
});
const isPublications = surface === 'picker' || surface === 'publications';
const path = isPublications
  ? `/publications${surface === 'picker' ? '?compose=1' : ''}`
  : `/channel/preview-channel/dialog/${surface}?token=preview-${surface}-token-0001`;
syncMaxNativeEnvironment();
document.body.dataset.miniappProfile = 'publisher';
createRoot(document.getElementById('root')!).render(
  <QueryClientProvider client={client}>
    <ToastProvider>
      <MemoryRouter initialEntries={[path]}>
        <div
          className={`app-shell app-shell--no-topbar app-shell--immersive ${surface === 'suggest' ? 'app-shell--suggest-dialog' : ''}`}
        >
          <div className="shell-content">
            <Routes>
              <Route
                path="/publications"
                element={<PublicationsPage api={api} profile="publisher" userId="preview-admin" />}
              />
              <Route
                path="/channel/:chatId/dialog/comments"
                element={<ChannelDialogPage api={api} profile="publisher" userId="preview-admin" />}
              />
              <Route
                path="/channel/:chatId/dialog/suggest"
                element={
                  <ChannelSuggestDialogPage api={api} profile="publisher" userId="preview-admin" />
                }
              />
            </Routes>
          </div>
        </div>
      </MemoryRouter>
    </ToastProvider>
  </QueryClientProvider>,
);
