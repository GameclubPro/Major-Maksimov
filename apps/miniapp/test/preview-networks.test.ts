import assert from 'node:assert/strict';
import test from 'node:test';
import { createPreviewApiTransport } from '../src/lib/api/preview-transport';
import {
  getManagedEntityNetworkEntries,
  getManagedEntityNetworks,
  updateManagedEntityNetworkComposition,
} from '../src/lib/api/managed-entity-networks-client';
import { ApiRequestError } from '../src/lib/api-request-error';

test('preview network catalogue is separate by type and includes server membership beyond home pages', async () => {
  const api = createPreviewApiTransport({ search: '?networks=1' });
  const chats = await getManagedEntityNetworks(api, 'chat');
  const channels = await getManagedEntityNetworks(api, 'channel');
  assert.equal(chats.items.length, 6);
  assert.equal(channels.items.length, 6);
  assert.notEqual(chats.compositionVersion, channels.compositionVersion);
  const important = chats.items.find((item) => item.favoriteType === 'important')!;
  assert.ok(important.entityCount > 50);
  const category = await getManagedEntityNetworkEntries(api, 'chat', {
    favoriteType: 'important',
    limit: 1,
  });
  assert.equal(category.compositionVersion, important.compositionVersion);

  assert.notEqual(important.compositionVersion, chats.compositionVersion);
  const first = await getManagedEntityNetworkEntries(api, 'chat', {
    favoriteType: 'important',
    limit: 50,
  });
  assert.equal(first.items.length, 50);
  assert.ok(first.nextCursor);
  const rest = await getManagedEntityNetworkEntries(api, 'chat', {
    favoriteType: 'important',
    limit: 50,
    cursor: first.nextCursor!,
  });
  assert.equal(first.items.length + rest.items.length, important.entityCount);
  assert.equal(rest.nextCursor, null);
});
test('composition conflicts preserve all unrelated and earlier touched assignments atomically', async () => {
  const api = createPreviewApiTransport({ search: '?networks=1' });
  const before = await getManagedEntityNetworkEntries(api, 'chat', {
    favoriteType: 'important',
    limit: 2,
  });
  const [a, b] = before.items;
  await updateManagedEntityNetworkComposition(api, 'chat', [
    { entityId: b.id, expectedFavoriteType: 'important', favoriteType: 'watch' },
  ]);
  await assert.rejects(
    updateManagedEntityNetworkComposition(api, 'chat', [
      { entityId: a.id, expectedFavoriteType: 'important', favoriteType: null },
      { entityId: b.id, expectedFavoriteType: 'important', favoriteType: 'partner' },
    ]),
    (error: unknown) => error instanceof ApiRequestError && error.status === 409,
  );
  const after = await getManagedEntityNetworkEntries(api, 'chat', { limit: 100 });
  assert.equal(after.items.find((row) => row.id === a.id)?.favoriteType, 'important');
  assert.equal(after.items.find((row) => row.id === b.id)?.favoriteType, 'watch');
  await assert.rejects(
    getManagedEntityNetworkEntries(api, 'chat', {
      favoriteType: 'important',
      cursor: before.nextCursor!,
      limit: 2,
    }),
    (error: unknown) => error instanceof ApiRequestError && error.status === 409,
  );
});
test('whole-category fixture exceeds the explicit selected-target ceiling', async () => {
  const api = createPreviewApiTransport({ search: '?networks=1&networksScenario=large' });
  const catalogue = await getManagedEntityNetworks(api, 'chat');
  assert.ok(catalogue.items.find((card) => card.favoriteType === 'important')!.entityCount > 500);
});
