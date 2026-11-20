import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { PublicationsPage } from '../../src/pages/publications-page';
import { ToastProvider } from '../../src/components/ui/toast';
import { createPreviewApiTransport } from '../../src/lib/api/preview-transport';
import type { ApiTransport } from '../../src/lib/api/transport';
import '../../src/styles.css';
import '../../src/styles/publisher-workspace.css';

const preview = createPreviewApiTransport({
  search: '?preview=1&profile=publisher',
  clock: { now: () => new Date() },
});
const api: ApiTransport = {
  async request(path, init) {
    if (!path.startsWith('/publications')) return preview.request(path, init);
    const response = await fetch(`/api${path}`, init);
    const data = await response.json();
    if (!response.ok) throw Object.assign(new Error(data.message), { status: response.status });
    return data;
  },
  requestKeepalive() {},
};
document.body.dataset.miniappProfile = 'publisher';
createRoot(document.getElementById('root')!).render(
  <QueryClientProvider
    client={
      new QueryClient({
        defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
      })
    }
  >
    <ToastProvider>
      <BrowserRouter>
        <PublicationsPage api={api} profile="publisher" userId="schedule-edit-test" />
      </BrowserRouter>
    </ToastProvider>
  </QueryClientProvider>,
);
