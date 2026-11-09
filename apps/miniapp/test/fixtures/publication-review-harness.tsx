import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { publicationDeliverySchema, publicationDetailsSchema } from '@maxim/contracts/publication';
import { PublicationDetailsSheet } from '../../src/features/publications/publication-details-sheet';
import { PublicationDeliveryActionSheets } from '../../src/features/publications/publication-action-sheets';
import { usePublicationActions } from '../../src/features/publications/use-publication-actions';
import { usePublicationRequestIds } from '../../src/features/publications/use-publication-request-ids';
import { ToastProvider } from '../../src/components/ui/toast';
import type { ApiTransport } from '../../src/lib/api/transport';
import '../../src/styles.css';
import '../../src/styles/publications-page.css';
import '../../src/styles/publisher-publications-workspace.css';

const empty = { total: 0, pending: 0, sent: 0, failed: 0, ambiguous: 0, canceled: 0 };
const staleCount = new URLSearchParams(location.search).has('stale-count');
const targets = ['a', 'b'].map((id) => ({
  chatId: `chat-${id}`,
  entityType: 'chat',
  title: `Старая доставка ${id}`,
  avatarUrl: null,
  link: null,
}));
const details = publicationDetailsSchema.parse({
  id: 'publication-review',
  title: 'Изменённое расписание',
  lifecycle: 'ACTIVE',
  version: 4,
  contentPreview: 'Новая версия',
  targetCount: 2,
  targetPreviews: targets,
  targetOverflowCount: 0,
  audienceSelection: 'SELECTED',
  audienceMode: 'SNAPSHOT',
  mediaCount: 0,
  hasVideo: false,
  schedule: null,
  delivery: { ...empty, total: 2, ambiguous: staleCount ? 0 : 2 },
  actionableDelivery: empty,
  createdAt: '2026-11-01T10:00:00Z',
  updatedAt: '2026-11-09T10:00:00Z',
  content: { revision: 2, text: 'Новая версия', textFormat: 'plain', buttons: [], media: [] },
  targets,
  occurrences: [
    {
      id: 'old-occurrence',
      scheduledAt: '2026-11-08T16:00:00Z',
      status: 'AMBIGUOUS',
      contentRevision: 1,
      canRetry: false,
      delivery: { ...empty, total: 2, ambiguous: 2 },
    },
  ],
});
const deliveries = targets.map((target, index) =>
  publicationDeliverySchema.parse({
    id: `delivery-${index === 0 ? 'a' : 'b'}`,
    occurrenceId: 'old-occurrence',
    target,
    status: 'AMBIGUOUS',
    contentRevision: 1,
    attemptCount: 1,
    remoteMessageId: null,
    lastError: null,
    sentAt: null,
  }),
);
const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
});
const api: ApiTransport = {
  async request(path, init) {
    const response = await fetch(`/review-api${path}`, init);
    if (!response.ok) throw new Error('Review fixture request failed');
    return response.json();
  },
  requestKeepalive() {},
};
Object.assign(window, {
  publicationReviewFixture: { details, deliveries },
  refetchPublicationReview() {
    void Promise.all([
      queryClient.refetchQueries({ queryKey: ['publications', 'details', details.id] }),
      queryClient.refetchQueries({ queryKey: ['publications', 'deliveries', details.id] }),
    ]);
  },
  publicationReviewCache() {
    return queryClient
      .getQueryCache()
      .getAll()
      .map((query) => ({
        key: query.queryKey,
        fetchStatus: query.state.fetchStatus,
        data: query.state.data,
      }));
  },
});

function Harness() {
  const actions = usePublicationActions(api, usePublicationRequestIds());
  return (
    <>
      <PublicationDetailsSheet
        api={api}
        publication={details}
        busy={actions.resolveAmbiguousMutation.isPending}
        covered={actions.ambiguousTarget !== null}
        onClose={() => {}}
        onCancel={() => {}}
        onEdit={() => {}}
        onRetry={() => {
          throw new Error('Old revision must not gain retry authority');
        }}
        onResolveAmbiguous={(publicationId, occurrenceId, deliveryId, resolution) =>
          actions.setAmbiguousTarget({ publicationId, occurrenceId, deliveryId, resolution })
        }
      />
      <PublicationDeliveryActionSheets actions={actions} />
    </>
  );
}
document.body.dataset.miniappProfile = 'publisher';
createRoot(document.getElementById('root')!).render(
  <QueryClientProvider client={queryClient}>
    <ToastProvider>
      <Harness />
    </ToastProvider>
  </QueryClientProvider>,
);
