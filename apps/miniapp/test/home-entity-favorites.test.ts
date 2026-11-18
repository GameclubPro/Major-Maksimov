import assert from 'node:assert/strict';
import test from 'node:test';
import { ApiRequestError } from '../src/lib/api-request-error';
import { markPreviewApiPrincipal } from '../src/lib/api/preview-principal';
import {
  FavoriteLabelConflictError,
  FavoriteLabelDuplicateError,
} from '../src/lib/home-entity-favorites-types';
import { createPreviewApiTransport } from '../src/lib/api/preview-transport';
import {
  mergeHomeEntityFavoriteLabelEdits,
  migrateHomeEntityFavoriteLabelsAfterNativeStorage,
  planHomeEntityFavoriteLabelsSync,
  saveHomeEntityFavoriteLabelEditsWithConflictRetry,
} from '../src/lib/home-entity-favorite-label-sync';
import {
  createEmptyHomeEntityFavorites,
  createEmptyHomeEntityFavoritesByType,
  getHomeEntityFavoriteTypes,
  HOME_ENTITY_FAVORITE_LABEL_MAX_LENGTH,
  HOME_ENTITY_FAVORITE_LABELS,
  mergeHomeEntityFavoriteLabels,
  mergeHomeEntityFavorites,
  orderHomeEntitiesByFavorites,
  reconcileHomeEntityFavoritesFromEntities,
  resolveHomeEntityFavoriteLabels,
  sanitizeHomeEntityFavoriteLabels,
  sanitizeHomeEntityFavorites,
  toggleHomeEntityFavoriteType,
} from '../src/lib/home-entity-favorites';
import { synchronizeAuthenticatedHomeEntityFavoriteLabels } from '../src/lib/home-entity-favorites-runtime';

test('sanitizes favorite ids per entity type and favorite type', () => {
  const favorites = sanitizeHomeEntityFavorites({
    chat: {
      important: [' 1 ', '1', '', 2, '2'],
      watch: ['watch-1', '1'],
    },
    channel: {
      broadcast: ['a', ' b ', 'a'],
    },
  });

  assert.deepEqual(favorites.chat.important, ['1', '2']);
  assert.deepEqual(favorites.chat.watch, ['watch-1']);
  assert.deepEqual(favorites.channel.broadcast, ['a', 'b']);
  assert.deepEqual(favorites.channel.important, []);
});

test('keeps production identity matching strict while allowing an explicit preview principal', async () => {
  const productionPaths: string[] = [];
  const productionApi = {
    async request(path: string) {
      productionPaths.push(path);
      if (path === '/me') {
        return {
          userId: 'server-admin',
          username: null,
          displayName: null,
          avatarUrl: null,
          profileUrl: null,
          profileHandoffUrl: null,
          botDialogUrl: null,
          canAccessSystem: false,
        };
      }
      throw new Error(`Unexpected production request: ${path}`);
    },
    requestKeepalive() {},
  };

  const productionReady = await synchronizeAuthenticatedHomeEntityFavoriteLabels(
    productionApi,
    'bridge-admin',
    new AbortController().signal,
    () => undefined,
    () => undefined,
  );
  assert.equal(productionReady, false);
  assert.deepEqual(productionPaths, ['/me']);

  productionPaths.length = 0;
  const wrongPreviewPrincipalReady = await synchronizeAuthenticatedHomeEntityFavoriteLabels(
    markPreviewApiPrincipal(productionApi, 'other-preview-admin'),
    'bridge-admin',
    new AbortController().signal,
    () => undefined,
    () => undefined,
  );
  assert.equal(wrongPreviewPrincipalReady, false);
  assert.deepEqual(productionPaths, ['/me']);

  const previewApi = createPreviewApiTransport();
  let previewUserId: string | null = null;
  let previewLabels: Record<string, string> | null = null;
  const previewReady = await synchronizeAuthenticatedHomeEntityFavoriteLabels(
    previewApi,
    'bridge-admin',
    new AbortController().signal,
    (userId) => {
      previewUserId = userId;
    },
    (labels) => {
      previewLabels = labels;
    },
  );
  assert.equal(previewReady, true);
  assert.equal(previewUserId, 'preview-admin');
  assert.deepEqual(previewLabels, {});
});

test('toggles favorite types with the newest favorite first', () => {
  const initial = createEmptyHomeEntityFavorites();
  const first = toggleHomeEntityFavoriteType(initial, 'chat', 'chat-1', 'important').favorites;
  const second = toggleHomeEntityFavoriteType(first, 'chat', 'chat-2', 'important').favorites;
  const removed = toggleHomeEntityFavoriteType(second, 'chat', 'chat-1', 'important');

  assert.deepEqual(second.chat.important, ['chat-2', 'chat-1']);
  assert.deepEqual(removed.favoriteTypes, []);
  assert.deepEqual(removed.favorites.chat.important, ['chat-2']);
});

test('selects one favorite category per entity', () => {
  const initial = createEmptyHomeEntityFavorites();
  const important = toggleHomeEntityFavoriteType(initial, 'chat', 'chat-1', 'important');
  const watch = toggleHomeEntityFavoriteType(important.favorites, 'chat', 'chat-1', 'watch');

  assert.deepEqual(watch.favoriteTypes, ['watch']);
  assert.deepEqual(watch.favorites.chat.important, []);
  assert.deepEqual(watch.favorites.chat.watch, ['chat-1']);
});

test('orders visible entities by favorite order without dropping the rest', () => {
  const entities = [
    { id: '1', title: 'One' },
    { id: '2', title: 'Two' },
    { id: '3', title: 'Three' },
  ];
  const favorites = createEmptyHomeEntityFavoritesByType();
  favorites.important = ['3', 'missing', '1'];

  assert.deepEqual(orderHomeEntitiesByFavorites(entities, favorites), [
    { id: '3', title: 'Three' },
    { id: '1', title: 'One' },
    { id: '2', title: 'Two' },
  ]);
});

test('merges migrated device favorites behind stored user favorites', () => {
  const userFavorites = createEmptyHomeEntityFavorites();
  userFavorites.chat.important = ['user-1', 'shared'];
  userFavorites.channel.important = ['channel-1'];
  const deviceFavorites = createEmptyHomeEntityFavorites();
  deviceFavorites.chat.important = ['shared', 'device-1'];
  deviceFavorites.channel.important = ['channel-2'];

  const merged = mergeHomeEntityFavorites(userFavorites, deviceFavorites);

  assert.deepEqual(merged.chat.important, ['user-1', 'shared', 'device-1']);
  assert.deepEqual(merged.channel.important, ['channel-1', 'channel-2']);
});

test('reconciles loaded favorites with the server while preserving unloaded entities', () => {
  const current = createEmptyHomeEntityFavorites();
  current.chat.important = ['chat-1', 'chat-unloaded'];
  current.chat.watch = ['chat-2'];
  current.channel.service = ['channel-unloaded'];

  const reconciled = reconcileHomeEntityFavoritesFromEntities(current, {
    chats: [
      { id: 'chat-1', title: 'One', favoriteTypes: [] },
      { id: 'chat-2', title: 'Two', favoriteTypes: ['broadcast'] },
    ],
  });

  assert.deepEqual(reconciled.chat.important, ['chat-unloaded']);
  assert.deepEqual(reconciled.chat.watch, []);
  assert.deepEqual(reconciled.chat.broadcast, ['chat-2']);
  assert.deepEqual(reconciled.channel.service, ['channel-unloaded']);
});

test('reads the selected favorite type for one entity', () => {
  const favorites = createEmptyHomeEntityFavorites();
  favorites.chat.service = ['chat-1'];
  favorites.chat.important = ['chat-1'];

  assert.deepEqual(getHomeEntityFavoriteTypes(favorites, 'chat', 'chat-1'), ['important']);
});

test('favorite reconciliation preserves local positions across tab refreshes for both entity types', () => {
  const current = createEmptyHomeEntityFavorites();
  current.chat.important = ['2', '1'];
  current.channel.important = ['2', '1'];
  const entities = [
    { id: '1', title: 'One', favoriteTypes: ['important'] as const },
    { id: '2', title: 'Two', favoriteTypes: ['important'] as const },
    { id: '3', title: 'Three', favoriteTypes: ['important'] as const },
  ].map((entity) => ({ ...entity, favoriteTypes: [...entity.favoriteTypes] }));
  const next = reconcileHomeEntityFavoritesFromEntities(current, {
    chats: entities,
    channels: [...entities].reverse(),
  });

  assert.deepEqual(next.chat.important, ['2', '1', '3']);
  assert.deepEqual(next.channel.important, ['2', '1', '3']);
  assert.deepEqual(
    reconcileHomeEntityFavoritesFromEntities(next, { chats: [...entities].reverse() }),
    next,
  );
  assert.deepEqual(current.chat.important, ['2', '1']);
});

test('sanitizes custom favorite category labels', () => {
  const longLabel = 'Очень длинное название категории избранного';
  const labels = sanitizeHomeEntityFavoriteLabels({
    important: ' VIP\u0000   чаты ',
    watch: longLabel,
    broadcast: HOME_ENTITY_FAVORITE_LABELS.broadcast,
    service: 42,
  });

  assert.deepEqual(labels, {
    important: 'VIP чаты',
    watch: Array.from(longLabel).slice(0, HOME_ENTITY_FAVORITE_LABEL_MAX_LENGTH).join(''),
  });
});

test('retries one structured revision conflict and merges onto the refreshed server profile', async () => {
  const serverSnapshots = [
    {
      initialized: true as const,
      labels: { important: 'Другое окно', watch: 'Старый контроль' },
      revision: 4,
    },
    {
      initialized: true as const,
      labels: { important: 'Новее другого окна', watch: 'Старый контроль', test: 'QA' },
      revision: 5,
    },
  ];
  const replacements: Array<{ labels: Record<string, string>; expectedRevision: number | null }> =
    [];
  let loadCalls = 0;

  const saved = await saveHomeEntityFavoriteLabelEditsWithConflictRetry(
    { important: 'VIP', watch: 'Старый контроль' },
    { important: 'VIP', watch: 'Новый контроль' },
    async () => serverSnapshots[loadCalls++]!,
    async (labels, expectedRevision) => {
      replacements.push({ labels, expectedRevision });
      if (replacements.length === 1) {
        throw new ApiRequestError(
          409,
          '{"code":"MANAGED_ENTITY_FAVORITE_LABELS_REVISION_CONFLICT"}',
          'Названия категорий уже изменились.',
        );
      }
      return { initialized: true, labels, revision: 6 };
    },
  );

  assert.equal(loadCalls, 2);
  assert.deepEqual(replacements, [
    {
      labels: { important: 'Другое окно', watch: 'Новый контроль' },
      expectedRevision: 4,
    },
    {
      labels: { important: 'Новее другого окна', watch: 'Новый контроль', test: 'QA' },
      expectedRevision: 5,
    },
  ]);
  assert.deepEqual(saved, {
    initialized: true,
    labels: { important: 'Новее другого окна', watch: 'Новый контроль', test: 'QA' },
    revision: 6,
  });
});

test('preserves another editor’s name until it is explicitly replaced', async () => {
  const server = { initialized: true as const, labels: { important: 'Новости' }, revision: 4 };
  const draft = { important: 'Медиа' };
  let replaced = false;
  const replace = async (labels: typeof server.labels, expectedRevision: number | null) => {
    replaced = true;
    assert.equal(expectedRevision, server.revision);
    return { ...server, labels, revision: 5 };
  };
  const load = async () => server;
  const attempt = () =>
    saveHomeEntityFavoriteLabelEditsWithConflictRetry({}, draft, load, async (labels, revision) => {
      assert.ok(labels.important);
      return replace({ important: labels.important }, revision);
    });
  await assert.rejects(
    attempt,
    (error) => error instanceof FavoriteLabelConflictError && error.currentLabel === 'Новости',
  );
  assert.equal(replaced, false);
  const result = await saveHomeEntityFavoriteLabelEditsWithConflictRetry(
    server.labels,
    draft,
    load,
    async (labels, revision) => {
      assert.ok(labels.important);
      return replace({ important: labels.important }, revision);
    },
  );
  assert.deepEqual(result.labels, draft);
});

test('rejects a new duplicate of a standard name without blocking unrelated legacy edits', () => {
  assert.throws(
    () => mergeHomeEntityFavoriteLabelEdits({}, { test: 'ВАЖНЫЕ' }, {}),
    FavoriteLabelDuplicateError,
  );
  const legacy = { test: 'Важные' };
  assert.deepEqual(
    mergeHomeEntityFavoriteLabelEdits(legacy, { ...legacy, watch: 'Медиа' }, legacy),
    { ...legacy, watch: 'Медиа' },
  );
});

test('preserves the complete local draft when the server profile is still uninitialized', async () => {
  const replacements: Array<{
    labels: Record<string, string>;
    expectedRevision: number | null;
  }> = [];

  await saveHomeEntityFavoriteLabelEditsWithConflictRetry(
    { important: 'VIP', watch: '24/7' },
    { important: 'Особые', watch: '24/7' },
    async () => ({ initialized: false, labels: {}, revision: null }),
    async (labels, expectedRevision) => {
      replacements.push({ labels, expectedRevision });
      return { initialized: true, labels, revision: 1 };
    },
  );

  assert.deepEqual(replacements, [
    {
      labels: { important: 'Особые', watch: '24/7' },
      expectedRevision: null,
    },
  ]);
});

test('does not retry text-shaped or non-conflict save failures', async () => {
  const failures = [
    new Error('API request failed: 409 Conflict'),
    new ApiRequestError(409, '{"code":"UNRELATED_CONFLICT"}', 'Другой конфликт.'),
    new ApiRequestError(500, '{}', 'Внутренняя ошибка.'),
  ];

  for (const failure of failures) {
    let loadCalls = 0;
    let replaceCalls = 0;
    await assert.rejects(
      () =>
        saveHomeEntityFavoriteLabelEditsWithConflictRetry(
          {},
          { important: 'VIP' },
          async () => {
            loadCalls += 1;
            return { initialized: true, labels: {}, revision: 1 };
          },
          async () => {
            replaceCalls += 1;
            throw failure;
          },
        ),
      (error: unknown) => error === failure,
    );
    assert.equal(loadCalls, 1);
    assert.equal(replaceCalls, 1);
  }
});

test('surfaces a second revision conflict without discarding the draft', async () => {
  let loadCalls = 0;
  let replaceCalls = 0;
  const conflict = new ApiRequestError(
    409,
    '{"code":"MANAGED_ENTITY_FAVORITE_LABELS_REVISION_CONFLICT"}',
    'Названия категорий уже изменились.',
  );

  await assert.rejects(
    () =>
      saveHomeEntityFavoriteLabelEditsWithConflictRetry(
        {},
        { important: 'VIP' },
        async () => {
          loadCalls += 1;
          return { initialized: true, labels: {}, revision: loadCalls };
        },
        async () => {
          replaceCalls += 1;
          throw conflict;
        },
      ),
    (error: unknown) => error === conflict,
  );
  assert.equal(loadCalls, 2);
  assert.equal(replaceCalls, 2);
});

test('resolves and merges favorite category labels with standard fallbacks', () => {
  const merged = mergeHomeEntityFavoriteLabels(
    { important: 'Первый экран' },
    { important: 'Старое', partner: 'Партнерки' },
  );
  const resolved = resolveHomeEntityFavoriteLabels(merged);

  assert.equal(resolved.important, 'Первый экран');
  assert.equal(resolved.partner, 'Партнерки');
  assert.equal(resolved.broadcast, 'Автопостинг');
});

test('keeps initialized server labels authoritative over a stale device cache', () => {
  assert.deepEqual(
    planHomeEntityFavoriteLabelsSync(
      { important: 'Старое локальное', watch: 'Локальный контроль' },
      { initialized: true, labels: { important: 'Серверное название' }, revision: 2 },
    ),
    {
      labels: { important: 'Серверное название' },
      initializeServer: false,
    },
  );
  assert.deepEqual(
    planHomeEntityFavoriteLabelsSync(
      { important: 'Не воскрешать после сброса' },
      { initialized: true, labels: {}, revision: 3 },
    ),
    {
      labels: {},
      initializeServer: false,
    },
  );
});

test('imports legacy cached labels only when the server profile is absent', () => {
  assert.deepEqual(
    planHomeEntityFavoriteLabelsSync(
      { important: 'VIP', watch: '24/7' },
      { initialized: false, labels: {}, revision: null },
    ),
    {
      labels: { important: 'VIP', watch: '24/7' },
      initializeServer: true,
    },
  );
  assert.deepEqual(
    planHomeEntityFavoriteLabelsSync({}, { initialized: false, labels: {}, revision: null }),
    {
      labels: {},
      initializeServer: false,
    },
  );
});

test('merges only edited labels onto the latest server profile', () => {
  assert.deepEqual(
    mergeHomeEntityFavoriteLabelEdits(
      { important: 'VIP', watch: 'Старый контроль' },
      { important: 'VIP', watch: 'Новый контроль' },
      { important: 'Обновлено в другом окне', watch: 'Старый контроль', test: 'QA' },
    ),
    {
      important: 'Обновлено в другом окне',
      watch: 'Новый контроль',
      test: 'QA',
    },
  );
  assert.deepEqual(
    mergeHomeEntityFavoriteLabelEdits(
      { watch: 'Новый контроль' },
      {},
      { important: 'VIP', watch: 'Новый контроль' },
    ),
    { important: 'VIP' },
  );
});

test('waits for late native labels before initializing the server profile', async () => {
  let releaseNativeLabels!: (labels: { important: string }) => void;
  const nativeLabels = new Promise<{ important: string }>((resolve) => {
    releaseNativeLabels = resolve;
  });
  const initializedWith: Array<{ important?: string }> = [];

  const migration = migrateHomeEntityFavoriteLabelsAfterNativeStorage(
    { initialized: false, labels: {}, revision: null },
    () => nativeLabels,
    async (labels) => {
      initializedWith.push(labels);
      return { initialized: true, labels, revision: 1 };
    },
    () => undefined,
  );

  await Promise.resolve();
  assert.equal(initializedWith.length, 0);
  releaseNativeLabels({ important: 'VIP' });
  assert.deepEqual(await migration, { important: 'VIP' });
  assert.deepEqual(initializedWith, [{ important: 'VIP' }]);
});

test('keeps late native labels in the draft when server initialization fails', async () => {
  const failure = new Error('Server unavailable');
  const candidates: Array<Record<string, string>> = [];

  await assert.rejects(
    () =>
      migrateHomeEntityFavoriteLabelsAfterNativeStorage(
        { initialized: false, labels: {}, revision: null },
        async () => ({ important: 'VIP', watch: '24/7' }),
        async () => {
          throw failure;
        },
        (labels) => candidates.push(labels),
      ),
    (error: unknown) => error === failure,
  );

  assert.deepEqual(candidates, [{ important: 'VIP', watch: '24/7' }]);
});
