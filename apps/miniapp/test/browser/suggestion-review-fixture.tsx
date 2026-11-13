import '../../src/styles.css';
import { createRoot } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SuggestionReviewPage } from '../../src/pages/suggestion-review-page';
import type { ApiTransport } from '../../src/lib/api/transport';
import type { SuggestionReviewDetail } from '@maxim/contracts/publisher';
const params = new URLSearchParams(location.search);
const profile = params.get('profile') === 'publisher' ? 'publisher' : 'moderation';
document.body.dataset.miniappProfile = profile;
document.documentElement.dataset.maxTheme = params.get('theme') ?? 'light';
const text = params.get('value') ?? '  **Цена** 300 ₽\n\n[Описание](https://example.test/)\n\n';
let current: SuggestionReviewDetail = {
  id: 'suggestion-1',
  profile,
  channelId: 'channel-1',
  channelTitle: 'Городские объявления',
  revision: params.has('stale') ? 1 : 0,
  text,
  originalText: text,
  status: 'pending',
  author: { userId: '42', name: 'Анна Смирнова', url: 'https://max.ru/anna' },
  previewText: `От подписчика [Анна Смирнова](https://max.ru/anna)\n\n${text}`,
  previewFormat: 'markdown',
  media: [],
  notification: 'none',
  rejectionText: null,
  contactUrl: '',
};
let failOnce = params.has('error');
const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
Object.assign(window, { reviewCalls: calls });
const api = {
  request: async (path: string, options?: { body?: string; method?: string }) => {
    if (failOnce) {
      failOnce = false;
      throw new Error('Temporary network error');
    }
    if (!options?.body) return structuredClone(current);
    const body = JSON.parse(options.body) as Record<string, unknown>;
    calls.push({ path, body });
    if (path.endsWith('/preview'))
      return {
        text: `От подписчика [Анна Смирнова](https://max.ru/anna)\n\n${body.text}`,
        textFormat: 'markdown',
      };
    if (path.endsWith('/reject'))
      current = {
        ...current,
        status: 'cancelled',
        revision: current.revision + 1,
        notification: body.notifyAuthor ? 'pending' : 'none',
        rejectionText: body.notifyAuthor ? 'Размещение такого объявления платное.' : null,
      };
    else
      current = {
        ...current,
        text: String(body.text),
        revision: current.revision + 1,
        status: path.endsWith('/publish') ? 'publishing' : 'pending',
      };
    return structuredClone(current);
  },
} as unknown as ApiTransport;
if (params.has('stale'))
  localStorage.setItem(
    `suggestion-review-v1:${profile}:101:suggestion-1`,
    JSON.stringify({ revision: 0, text: 'Мой старый черновик', savedAt: Date.now() }),
  );
createRoot(document.getElementById('root')!).render(
  <QueryClientProvider client={new QueryClient()}>
    <MemoryRouter initialEntries={[`/suggestions/suggestion-1/${params.get('mode') ?? 'edit'}`]}>
      <Routes>
        <Route
          path="/suggestions/:suggestionId/:mode"
          element={<SuggestionReviewPage api={api} profile={profile} userId="101" />}
        />
      </Routes>
    </MemoryRouter>
  </QueryClientProvider>,
);
