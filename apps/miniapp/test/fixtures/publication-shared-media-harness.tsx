import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { publicationDetailsSchema } from '@maxim/contracts/publication';
import { ToastProvider } from '../../src/components/ui/toast';
import { usePublicationEditorSession } from '../../src/features/publications/use-publication-editor-session';
import { usePublicationAssetPreviews } from '../../src/features/publications/use-publication-asset-previews';
import {
  buildTestPublicationRequest,
  type PublicationRetainedAsset,
} from '../../src/features/publications/publication-model';
import { testPublication } from '../../src/lib/api/publication-client';
import type { ApiTransport } from '../../src/lib/api/transport';

const api: ApiTransport = {
  async request(path, init) {
    const response = await fetch('/api' + path, init);
    if (!response.ok) {
      const error = await response.json();
      throw Object.assign(new Error(error.message), { status: response.status });
    }
    return init?.responseType === 'blob' ? response.blob() : response.json();
  },
  requestKeepalive() {},
};
const kind = new URLSearchParams(location.search).get('kind') === 'video' ? 'video' : 'image';
const target = { chatId: 'shared-chat', entityType: 'chat', title: 'Общий чат' };
const delivery = { total: 0, pending: 0, sent: 0, failed: 0, ambiguous: 0, canceled: 0 };
const details = publicationDetailsSchema.parse({
  id: `shared-source-${kind}`,
  title: 'Общий пост',
  lifecycle: 'ACTIVE',
  version: 4,
  access: { canManageAllTargets: false },
  contentPreview: 'Общее медиа',
  targetCount: 2,
  targetPreviews: [target],
  targetOverflowCount: 1,
  audienceSelection: 'SELECTED',
  audienceMode: 'SNAPSHOT',
  mediaCount: 1,
  hasVideo: kind === 'video',
  schedule: null,
  delivery,
  createdAt: '2026-11-01T10:00:00Z',
  updatedAt: '2026-11-01T10:00:00Z',
  content: {
    revision: 3,
    text: 'Общее медиа',
    textFormat: 'plain',
    buttons: [],
    media: [
      {
        id: `shared-${kind}`,
        type: kind,
        mimeType: kind === 'video' ? 'video/mp4' : 'image/png',
        fileName: kind === 'video' ? 'clip.mp4' : 'photo.png',
        sizeBytes: 128,
      },
    ],
  },
  targets: [target],
  occurrences: [],
});

function AssetPreviews({
  publicationId,
  assets,
}: {
  publicationId: string | null;
  assets: readonly PublicationRetainedAsset[];
}) {
  const previews = usePublicationAssetPreviews(api, publicationId, assets);
  return <output data-testid="previews">{JSON.stringify(previews)}</output>;
}

function Harness() {
  const [previewGeneration, setPreviewGeneration] = useState(0);
  const [testing, setTesting] = useState(false);
  const [testSequence, setTestSequence] = useState(0);
  const [actionError, setActionError] = useState('');
  const session = usePublicationEditorSession({
    api,
    userId: `shared-media-${kind}`,
    isPublisherProfile: true,
    mediaPreparing: false,
    videoPreparing: false,
    onOpen() {},
  });
  async function sendTest() {
    setTesting(true);
    setActionError('');
    setTestSequence((current) => current + 1);
    try {
      await testPublication(
        api,
        buildTestPublicationRequest(session.draft, `shared_media_test_${testSequence + 1}`),
      );
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      setTesting(false);
    }
  }
  return (
    <main>
      <button
        disabled={!session.hydrated || session.openPublicationMutation.isPending}
        onClick={() => session.openPublicationEditor(details, 'duplicate')}
      >
        Создать копию
      </button>
      <h1 ref={session.editorTitleRef} tabIndex={-1}>
        Копия публикации
      </h1>
      <button
        onClick={() => {
          setActionError('');
          void session.cloudDraft.flush().catch((error: unknown) => {
            setActionError(error instanceof Error ? error.message : String(error));
          });
        }}
      >
        Сохранить черновик
      </button>
      <button disabled={testing} onClick={() => void sendTest()}>
        Отправить тест
      </button>
      <button onClick={() => setPreviewGeneration((current) => current + 1)}>
        Обновить предпросмотр
      </button>
      <AssetPreviews
        key={previewGeneration}
        publicationId={session.draft.cloudDraft?.id ?? null}
        assets={session.draft.retainedAssets}
      />
      <output data-testid="state">
        {JSON.stringify({
          response: details,
          hydrated: session.hydrated,
          context: session.editorContext,
          cloud: session.draft.cloudDraft ?? null,
          retainedAssets: session.draft.retainedAssets,
          saveStatus: session.cloudDraft.status,
          testing,
          actionError,
        })}
      </output>
    </main>
  );
}

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
        <Harness />
      </BrowserRouter>
    </ToastProvider>
  </QueryClientProvider>,
);
