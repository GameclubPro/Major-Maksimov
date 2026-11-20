import assert from 'node:assert/strict';
import test from 'node:test';
import {
  addAlbumAsset,
  moveAlbumItem,
  publicationAlbum,
  removeAlbumItem,
  replaceAlbumItem,
  restoreImportAsset,
  withAlbumPhotos,
} from '../src/features/publications/publication-album';
import {
  buildPublicationContent,
  createEmptyPublicationDraft,
} from '../src/features/publications/publication-model';
import {
  serverDraftRequest,
  withSavedPublicationMedia,
} from '../src/features/publications/publication-cloud-draft-model';
import {
  candidateImportText,
  reviewNeedsChoice,
} from '../src/features/publications/publication-import-review-model';
import type { PublisherPostImportWarning } from '@maxim/contracts/publisher';

const asset = (id: string, type: 'image' | 'video') => ({
  id,
  type,
  fileName: id,
  sizeBytes: 100,
  mimeType: type + '/test',
});
const photo = (name: string) => ({ fileName: name, base64: name, mimeType: 'image/png' });

test('mixed album preserves interleaved uploads across reorder, replace, save and server reconciliation', () => {
  let draft = createEmptyPublicationDraft([]);
  draft = withAlbumPhotos(draft, [photo('first')]);
  draft = addAlbumAsset(draft, asset('video-1', 'video'));
  draft = withAlbumPhotos(draft, [...draft.images, photo('second')]);
  draft = addAlbumAsset(draft, asset('video-2', 'video'));
  assert.deepEqual(
    publicationAlbum(draft).map((item) => item.name),
    ['first', 'video-1', 'second', 'video-2'],
  );
  draft = moveAlbumItem(draft, 'asset:video-2', -1);
  draft = replaceAlbumItem(draft, 'image:0', { photo: photo('replaced') });
  draft = removeAlbumItem(draft, 'asset:video-1');
  const request = serverDraftRequest(draft, 'request-mixed');
  assert.deepEqual(
    request.content.media.map((item) => ('assetId' in item ? item.assetId : item.fileName)),
    ['replaced', 'video-2', 'second'],
  );
  const server = withSavedPublicationMedia(draft, [
    asset('saved-first', 'image'),
    asset('video-2', 'video'),
    asset('saved-last', 'image'),
  ]);
  assert.deepEqual(
    buildPublicationContent(server).media.map((item) => item.type),
    ['image-ref', 'video-ref', 'image-ref'],
  );
  assert.deepEqual(
    publicationAlbum(server).map((item) => item.key),
    ['asset:saved-first', 'asset:video-2', 'asset:saved-last'],
  );
});

test('restores multiple missing assets in original positions even when the author restores the later one first', () => {
  let draft = createEmptyPublicationDraft([]);
  draft.retainedAssets = [
    asset('first', 'image'),
    asset('third', 'image'),
    asset('fifth', 'image'),
  ];
  draft.importReview = {
    omissions: [],
    warnings: [1, 3].map((mediaPosition) => ({
      messageIndex: 1,
      itemIndex: mediaPosition + 1,
      mediaPosition,
      kind: 'video',
      reason: 'unavailable',
    })),
    resolved: [],
  };
  draft = restoreImportAsset(draft, 1, { asset: asset('fourth', 'video') });
  assert(reviewNeedsChoice(draft.importReview));
  draft = restoreImportAsset(draft, 0, { asset: asset('second', 'video') });
  assert(!reviewNeedsChoice(draft.importReview));
  assert.deepEqual(
    publicationAlbum(draft).map((item) => item.name),
    ['first', 'second', 'third', 'fourth', 'fifth'],
  );
  assert.deepEqual(
    serverDraftRequest(draft, 'request-review').state.importReview?.restored,
    [1, 0],
  );
});

test('allows a source link only by explicit selection and within the text budget', () => {
  const warning: PublisherPostImportWarning = {
    messageIndex: 1,
    kind: 'link',
    reason: 'optional_link',
    value: 'https://example.org/a',
  };
  assert.equal(candidateImportText('Текст', warning), 'Текст\n\nhttps://example.org/a');
  assert.equal(candidateImportText('x'.repeat(4000), warning), null);
  assert.equal(
    candidateImportText('', { ...warning, value: 'https://name:password@example.org' }),
    null,
  );
});
