import '../src/styles.css';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router';
import { ToastProvider } from '../src/components/ui/toast';
import { ChannelSuggestDialogPage } from '../src/pages/channel-suggest-dialog-page';
import { createPreviewApiTransport } from '../src/lib/api/preview-transport';
import { syncMaxNativeEnvironment } from '../src/lib/max-bridge';
import type { ChannelDialogResponse } from '@maxim/contracts/channel-dialog';
import type { ApiTransport } from '../src/lib/api/transport';

const preview = createPreviewApiTransport();
const route = '/channels/preview-channel/dialog/suggest';
const token = 'preview-suggest-token-0001';
const initial = await preview.request<ChannelDialogResponse>(`${route}?token=${token}`);
const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
let data: ChannelDialogResponse = {
  ...initial,
  hasMoreMessages: true,
  messages: Array.from({ length: 80 }, (_, index) => ({
    ...initial.messages[0]!,
    id: `suggestion-${index}`,
    text: `Предложение ${index + 1}`,
    publishedUrl: 'https://max.ru/synthetic_channel/post-1',
  })),
};
const sendRequests: unknown[] = [];
const api: ApiTransport = {
  ...preview,
  async request(path, init = {}) {
    if (path.startsWith(route) && (!init.method || init.method === 'GET')) {
      return structuredClone(data) as never;
    }
    if (path.endsWith('/messages') && init.method === 'POST') {
      sendRequests.push(init.body);
      throw new Error('Sending is disabled in the mobile layout fixture');
    }
    return preview.request(path, init);
  },
};
Object.assign(window, {
  suggestionLayoutTest: {
    sendRequests,
    async setTruncated(hasMoreMessages: boolean) {
      data = { ...data, hasMoreMessages };
      await client.invalidateQueries();
    },
  },
});
syncMaxNativeEnvironment();
createRoot(document.getElementById('root')!).render(
  <QueryClientProvider client={client}>
    <ToastProvider>
      <MemoryRouter initialEntries={[`/channel/preview-channel/dialog/suggest?token=${token}`]}>
        <div className="app-shell app-shell--no-topbar app-shell--immersive app-shell--suggest-dialog">
          <div className="shell-content">
            <Routes>
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
