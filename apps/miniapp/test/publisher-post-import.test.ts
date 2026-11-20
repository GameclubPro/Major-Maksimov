import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { publisherPostImportSessionSchema } from '@maxim/contracts/publisher';
import { resolvePublisherPostImportPresentation } from '../src/features/publications/publisher-post-import-model';
import {
  resolvePublisherPostImportRouteCleanup,
  STALE_IMPORT_ROUTE_KEYS,
} from '../src/features/publications/publisher-post-import-route';
import { getPublication, listPublications } from '../src/lib/api/publication-client';
import { createPreviewApiTransport } from '../src/lib/api/preview-transport';
import {
  cancelPublisherPostImport,
  createPublisherPostImport,
  getActivePublisherPostImport,
  getPublisherPostImportByToken,
  getPublisherPostImportAsset,
} from '../src/lib/api/publisher-post-import-client';
import {
  createApiTransport,
  type ApiRequestInit,
  type ApiTransport,
} from '../src/lib/api/transport';

const sessionSource = readFileSync(
  new URL('../src/features/publications/use-publication-editor-session.ts', import.meta.url),
  'utf8',
);
const pageSource = readFileSync(
  new URL('../src/pages/publications-page.tsx', import.meta.url),
  'utf8',
);
const contentEditorSource = readFileSync(
  new URL('../src/features/publications/publication-content-editor-section.tsx', import.meta.url),
  'utf8',
);
const createSheetSource = readFileSync(
  new URL('../src/features/publications/publication-create-sheet.tsx', import.meta.url),
  'utf8',
);
const controllerSource = readFileSync(
  new URL('../src/features/publications/use-publisher-post-import-controller.ts', import.meta.url),
  'utf8',
);
const importButtonsNoticeSource = readFileSync(
  new URL('../src/features/publications/publication-import-buttons-notice.tsx', import.meta.url),
  'utf8',
);
const assetPreviewsSource = readFileSync(
  new URL(
    '../src/features/publications/use-publisher-post-import-asset-previews.ts',
    import.meta.url,
  ),
  'utf8',
);
const statusCss = readFileSync(
  new URL('../src/features/publications/publisher-post-import-status.css', import.meta.url),
  'utf8',
);

function importSession(
  status: 'waiting' | 'processing' | 'ready' | 'failed' | 'canceled' | 'expired',
) {
  return publisherPostImportSessionSchema.parse({
    id: 'session-1',
    status,
    expiresAt: '2026-08-28T14:00:00.000Z',
    publicationId: status === 'ready' ? 'publication-1' : null,
    botUrl: status === 'waiting' ? 'https://max.ru/se14088825_bot?start=pi_token' : null,
    failureCode: status === 'failed' ? 'unsupported_content' : null,
    omissions: status === 'ready' ? ['buttons_not_imported'] : [],
  });
}

test('post import states keep hub copy short and actionable', () => {
  assert.deepEqual(resolvePublisherPostImportPresentation(importSession('waiting')), {
    title: 'Жду пост',
    detail: null,
    tone: 'neutral',
    action: 'open-bot',
  });
  assert.deepEqual(resolvePublisherPostImportPresentation(importSession('processing')), {
    title: 'Готовлю черновик',
    detail: null,
    tone: 'neutral',
    action: null,
  });
  assert.deepEqual(resolvePublisherPostImportPresentation(importSession('ready')), {
    title: 'Черновик готов',
    detail: 'Кнопки не перенесены',
    tone: 'ready',
    action: 'open-draft',
  });
  assert.equal(
    resolvePublisherPostImportPresentation(importSession('failed'))?.title,
    'Этот формат не поддерживается',
  );
  assert.equal(resolvePublisherPostImportPresentation(importSession('canceled')), null);
});

test('post import route cleanup distinguishes invalid, missing, and stale sessions', () => {
  assert.deepEqual(
    resolvePublisherPostImportRouteCleanup({
      importToken: 'bad',
      draftId: 'draft-1',
      exactQueryResolved: false,
      hasExactSession: false,
    }),
    ['draft', 'import'],
  );
  assert.deepEqual(
    resolvePublisherPostImportRouteCleanup({
      importToken: 'import_token_1234567890',
      draftId: null,
      exactQueryResolved: true,
      hasExactSession: false,
    }),
    ['import'],
  );
  assert.deepEqual(
    resolvePublisherPostImportRouteCleanup({
      importToken: 'import_token_1234567890',
      draftId: 'draft-1',
      exactQueryResolved: true,
      hasExactSession: false,
    }),
    [],
  );
  assert.deepEqual(STALE_IMPORT_ROUTE_KEYS, ['compose', 'draft', 'import']);
});

test('publisher import client validates payloads and uses the active-session endpoints', async () => {
  const calls: Array<[string, ApiRequestInit | undefined]> = [];
  const ready = importSession('ready');
  const api: ApiTransport = {
    async request(path, init) {
      calls.push([path, init]);
      if (init?.responseType === 'blob') {
        return new Blob(['image'], { type: 'image/png' });
      }
      if (path.split('?')[0]?.endsWith('/active') || path.includes('/by-token/')) {
        return { session: ready };
      }
      return ready;
    },
    requestKeepalive() {},
  };

  await createPublisherPostImport(api, { requestId: 'request_12345678' });
  assert.equal(
    await getActivePublisherPostImport(api).then((result) => result.session?.id),
    ready.id,
  );
  assert.equal(
    await getPublisherPostImportByToken(api, 'token/12345678').then((result) => result.session?.id),
    ready.id,
  );
  await cancelPublisherPostImport(api);
  const asset = await getPublisherPostImportAsset(api, ready.id, 'asset/1');
  assert.equal(asset.type, 'image/png');
  assert.deepEqual(
    calls.map(([path, init]) => [path, init?.method ?? 'GET', init?.responseType ?? 'json']),
    [
      ['/publisher/post-imports?contractVersion=2', 'POST', 'json'],
      ['/publisher/post-imports/active?contractVersion=2', 'GET', 'json'],
      ['/publisher/post-imports/by-token/token%2F12345678?contractVersion=2', 'GET', 'json'],
      ['/publisher/post-imports?contractVersion=2', 'DELETE', 'json'],
      ['/publisher/post-imports/session-1/assets/asset%2F1', 'GET', 'blob'],
    ],
  );
});

test('browser API transport preserves authenticated image bytes as a Blob', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(Uint8Array.from([137, 80, 78, 71]), {
      status: 200,
      headers: { 'content-type': 'image/png' },
    })) as typeof fetch;
  try {
    const api = createApiTransport('', {
      apiBases: ['https://preview.local/api/v1'],
      durableSession: false,
    });
    const payload = await api.request('/publisher/post-imports/session/assets/asset', {
      responseType: 'blob',
    });
    assert.ok(payload instanceof Blob);
    assert.equal(payload.type, 'image/png');
    assert.deepEqual([...new Uint8Array(await payload.arrayBuffer())], [137, 80, 78, 71]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('preview transport exposes a ready import, durable draft, and private image bytes', async () => {
  const api = createPreviewApiTransport({
    search: '?profile=publisher&publisherImport=ready',
  });
  const active = await getActivePublisherPostImport(api);
  assert.equal(active.session?.status, 'ready');
  assert.equal(active.session?.publicationId, 'publication-imported-draft');
  const exact = await getPublisherPostImportByToken(api, 'preview_import_token_123456');
  assert.equal(exact.session?.publicationId, 'publication-imported-draft');

  const drafts = await listPublications(api, { view: 'drafts', limit: 4 });
  assert.deepEqual(
    drafts.items.map((item) => item.id),
    ['publication-imported-draft'],
  );
  const details = await getPublication(api, 'publication-imported-draft');
  assert.equal(details.content.textFormat, 'plain');
  assert.doesNotMatch(details.content.text, /\*\*|__/u);
  const assetId = drafts.items[0] ? 'publication-imported-draft-asset-1' : '';
  const image = await getPublisherPostImportAsset(api, active.session?.id ?? '', assetId);
  assert.equal(image.type, 'image/png');
});

test('publication import stays isolated and reloadable without replacing the manual draft', () => {
  assert.match(createSheetSource, /aria-label="Написать"/u);
  assert.match(createSheetSource, /aria-label="Перенести из MAX"/u);
  assert.doesNotMatch(createSheetSource, />Вставить</u);
  assert.match(
    pageSource,
    /editorContext\?\.kind === 'edit' \|\| editorContext\?\.kind === 'import'/u,
  );
  assert.match(sessionSource, /savedCreateDraftRef\.current = \{ draft, missingImageCount \}/u);
  assert.match(sessionSource, /replaceDraft\(isolatedDraft\)/u);
  assert.match(
    sessionSource,
    /replaceDraft\([\s\S]*?savedCreateDraft\?\.draft[\s\S]*?savedCreateDraft\?\.missingImageCount/u,
  );
  assert.match(sessionSource, /mode === 'import'[\s\S]*?expectedRevision: details\.version/u);
  assert.match(sessionSource, /setComposeRoute\(true,[\s\S]*?importDraftId/u);
  assert.match(controllerSource, /getPublisherPostImportByToken\(api, validRouteToken/u);
  assert.match(controllerSource, /enabled: enabled && !editorOpen && routeToken === null/u);
  assert.match(
    controllerSource,
    /searchParams\.get\('create'\) === '1'[\s\S]*?setCreateSheetOpen\(true\)/u,
  );
  assert.match(sessionSource, /function setComposeRoute[\s\S]*?next\.delete\('create'\)/u);
  assert.match(controllerSource, /function closeCreateSheet[\s\S]*?clearCreateRoute\(\)/u);
  assert.match(controllerSource, /function startImport[\s\S]*?clearCreateRoute\(\)/u);
  assert.match(controllerSource, /session\.omissions/u);
  assert.match(controllerSource, /routeToken === null && activeImportQuery\.isPending/u);
  assert.match(
    controllerSource,
    /resolvePublisherPostImportDraftContext\(session, publicationId\)/u,
  );
  assert.match(contentEditorSource, /PublicationImportButtonsNotice/u);
  assert.match(importButtonsNoticeSource, /publication-import-buttons-notice/u);
  assert.match(importButtonsNoticeSource, /shouldOfferPublisherButtonRecovery\(omissions/u);
  assert.match(pageSource, /restoreCreateDraftAndClose/u);
  assert.match(assetPreviewsSource, /Math\.min\(3, imageAssetIds\.length\)/u);
  assert.match(assetPreviewsSource, /loaded\[index\] = \{ assetId, url \}/u);
  assert.match(
    statusCss,
    /publisher-post-import-status__cancel \{[\s\S]*?grid-column: 3;[\s\S]*?grid-row: 1;/u,
  );
  assert.match(
    statusCss,
    /publisher-post-import-status__action \{[\s\S]*?grid-column: 2 \/ -1;[\s\S]*?grid-row: 2;/u,
  );
});
