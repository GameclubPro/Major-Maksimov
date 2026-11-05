import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router';
import {
  QueryClient,
  QueryClientProvider,
  notifyManager,
  type InfiniteData,
} from '@tanstack/react-query';
import { usePublicationList } from '../../src/features/publications/use-publication-list';
import { usePublicationCalendar } from '../../src/features/publications/use-publication-calendar';
import { createEmptyPublicationDraft } from '../../src/features/publications/publication-model';
import type { ApiTransport } from '../../src/lib/api/transport';
declare global {
  interface Window {
    readPublicationListHarness: () => {
      pendingNotifications: number;
      queries: Array<{
        key: readonly unknown[];
        status: string;
        fetchStatus: string;
        marker: string | null;
      }>;
    };
  }
}
const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
let pendingNotifications = 0;
// FLAG: Delay only this fixture's notifications beyond the old 50 ms response sleep.
// Browser assertions must observe the committed state and drain pending notifications.
notifyManager.setScheduler((callback) => {
  pendingNotifications += 1;
  window.setTimeout(() => {
    try {
      callback();
    } finally {
      pendingNotifications -= 1;
    }
  }, 100);
});
window.readPublicationListHarness = () => ({
  pendingNotifications,
  queries: queryClient
    .getQueryCache()
    .getAll()
    .filter((query) => query.queryKey[0] === 'publications' && query.queryKey[1] === 'list')
    .map((query) => ({
      key: query.queryKey,
      status: query.state.status,
      fetchStatus: query.state.fetchStatus,
      marker:
        queryClient
          .getQueryData<InfiniteData<{ nextCursor: string | null }>>(query.queryKey)
          ?.pages.at(-1)?.nextCursor ?? null,
    })),
});
const api: ApiTransport = {
  async request(path, init) {
    const response = await fetch(`/api${path}`, init);
    if (!response.ok) throw Error('Ошибка списка');
    return response.json();
  },
  requestKeepalive() {},
};
const initial = createEmptyPublicationDraft([
  { id: 'target-a', entityType: 'channel', title: 'Канал', avatarUrl: null, channelOverview: null },
]);
function Harness() {
  const [editor, setEditor] = useState(false);
  const state = usePublicationList(api, true, editor);
  const calendar = usePublicationCalendar(
    api,
    editor,
    { ...initial, timingMode: 'schedule' },
    { kind: 'edit', publicationId: 'publication-a', expectedRevision: 1, editScope: null },
  );
  return (
    <main>
      <label>
        Поиск
        <input
          value={state.query}
          onChange={(event) => {
            state.setQuery(event.target.value);
            state.setPublicationHubRoute({ query: event.target.value });
          }}
        />
      </label>
      <button
        onClick={() => {
          state.setEntityFilter('channel');
          state.setPublicationHubRoute({ entity: 'channel' });
        }}
      >
        Каналы
      </button>
      <button onClick={() => state.changeView('history')}>История</button>
      <button onClick={() => setEditor((value) => !value)}>Редактор</button>
      <button
        disabled={!state.currentListQuery.hasNextPage}
        onClick={() => void state.currentListQuery.fetchNextPage()}
      >
        Ещё
      </button>
      <output data-testid="state">
        {JSON.stringify({
          view: state.view,
          query: state.query,
          entity: state.entityFilter,
          pages: state.currentListQuery.data?.pages.length ?? 0,
          marker: state.currentListQuery.data?.pages.at(-1)?.nextCursor ?? null,
          calendar: calendar.data,
          editor,
        })}
      </output>
    </main>
  );
}
createRoot(document.getElementById('root')!).render(
  <QueryClientProvider client={queryClient}>
    <BrowserRouter>
      <Harness />
    </BrowserRouter>
  </QueryClientProvider>,
);
