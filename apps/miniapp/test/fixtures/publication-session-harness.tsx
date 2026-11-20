import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { publicationDetailsSchema } from '@maxim/contracts/publication';
import { usePublicationEditorSession } from '../../src/features/publications/use-publication-editor-session';
import { createEmptyPublicationDraft } from '../../src/features/publications/publication-model';
import { ToastProvider } from '../../src/components/ui/toast';
import type { ApiTransport } from '../../src/lib/api/transport';
const api: ApiTransport = {
  async request(path, init) {
    const r = await fetch('/api' + path, init);
    const data = await r.json();
    if (!r.ok) throw Object.assign(new Error(data.message), { status: r.status, code: data.code });
    return data;
  },
  requestKeepalive() {},
};
const details = publicationDetailsSchema.parse({
  id: 'publication-a',
  title: 'Проверка действий',
  lifecycle: 'ACTIVE',
  version: 4,
  contentPreview: 'Текст',
  targetCount: 0,
  targetPreviews: [],
  targetOverflowCount: 0,
  audienceSelection: 'SELECTED',
  audienceMode: 'SNAPSHOT',
  mediaCount: 0,
  hasVideo: false,
  schedule: null,
  delivery: { total: 1, pending: 0, sent: 0, failed: 1, ambiguous: 0, canceled: 0 },
  createdAt: '2026-10-01T10:00:00Z',
  updatedAt: '2026-10-01T10:00:00Z',
  content: { revision: 3, text: 'Текст', textFormat: 'plain', buttons: [], media: [] },
  targets: [],
  occurrences: [
    {
      id: 'occurrence-a',
      scheduledAt: '2026-10-01T10:00:00Z',
      status: 'FAILED',
      canRetry: true,
      contentRevision: 1,
      delivery: { total: 1, pending: 0, sent: 0, failed: 1, ambiguous: 0, canceled: 0 },
    },
  ],
});

function Harness() {
  const session = usePublicationEditorSession({
    api,
    userId: 'session-test',
    isPublisherProfile: true,
    mediaPreparing: false,
    videoPreparing: false,
    onOpen() {},
  });
  return (
    <main>
      <button
        disabled={!session.hydrated}
        onClick={() =>
          session.replaceDraft({ ...createEmptyPublicationDraft(), text: 'Локальный черновик' }, 2)
        }
      >
        Исходный черновик
      </button>
      <button onClick={() => session.openPublicationEditor(details, 'edit')}>
        Править публикацию
      </button>
      <button onClick={() => session.openCreateEditor()}>Создать</button>
      <h1 ref={session.editorTitleRef} tabIndex={-1}>
        Редактор
      </h1>
      <label>
        Текст
        <input
          value={session.draft.text}
          onChange={(e) => session.setDraft((current) => ({ ...current, text: e.target.value }))}
        />
      </label>
      <button onClick={() => session.requestCloseEditor(true, false)}>Назад</button>
      <button onClick={() => session.requestCloseEditor(true, true)}>Занятый редактор</button>
      <button onClick={() => session.setPendingEditorClose(false)}>Остаться</button>
      <button onClick={() => session.restoreCreateDraftAndClose()}>Закрыть без сохранения</button>
      <button onClick={() => session.refreshEditedPublicationMutation.mutate(details.id)}>
        Обновить версию
      </button>
      <button onClick={() => session.discardMissingImages()}>Без фото</button>
      <output data-testid="state">
        {JSON.stringify({
          context: session.editorContext,
          text: session.draft.text,
          missing: session.missingImageCount,
          confirm: session.pendingEditorClose,
          closeSaveFailed: session.editorCloseSaveFailed,
          deviceCopyIsCurrent: session.deviceCopyIsCurrent,
          opening: session.openPublicationMutation.isPending,
          refreshing: session.refreshEditedPublicationMutation.isPending,
          closing: session.editorClosePending,
          hydrated: session.hydrated,
          response: details,
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
