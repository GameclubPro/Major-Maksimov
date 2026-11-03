import assert from 'node:assert/strict';
import test from 'node:test';
import {
  clearAutoReplyDraft,
  getAutoReplyDraftStorageKey,
  loadAutoReplyDraft,
  loadAutoReplyDraftState,
  resolveAutoReplyDraftLoadState,
  saveAutoReplyDraft,
} from '../src/lib/auto-reply-draft';
import { buildPublisherAutoRepliesRoute } from '../src/pages/publisher-entity-modules-page-model';
import {
  AUTO_REPLY_FUZZY_MIN_ALNUM_COUNT,
  AUTO_REPLY_MAX_PHRASES,
  AUTO_REPLY_MAX_BUTTONS,
  AUTO_REPLY_PHRASE_MAX_LENGTH,
  createEmptyAutoReplyDraft,
  getAutoReplyConflictKind,
  getAutoReplyAuthoringStateLabel,
  getAutoReplyMatchModeLabel,
  getAutoReplyPhraseCountLabel,
  isActiveAutoReplyAuthoringState,
  mergeAutoReplyPhrases,
  normalizeAutoReplyPhrase,
  normalizeAutoReplyPhrases,
  splitAutoReplyPhrasePaste,
  validateAutoReplyDraft,
} from '../src/pages/publisher-auto-replies-page-model';
import { ApiRequestError } from '../src/lib/api-request-error';

test('auto-reply phrases preserve display case while normalizing unicode whitespace', () => {
  assert.equal(normalizeAutoReplyPhrase('  ПРАЙС\n\tдля  VIP  '), 'ПРАЙС для VIP');
  assert.equal(normalizeAutoReplyPhrase('ＰＲＩＣＥ'), 'PRICE');
  assert.equal(AUTO_REPLY_PHRASE_MAX_LENGTH, 80);
  assert.equal(AUTO_REPLY_MAX_PHRASES, 10);
  assert.equal(AUTO_REPLY_MAX_BUTTONS, 8);
  assert.deepEqual(normalizeAutoReplyPhrases([' Прайс ', 'прайс', 'Доставка']), [
    'Прайс',
    'Доставка',
  ]);
});

test('auto-reply phrases merge as OR alternatives and newline paste does not split commas', () => {
  assert.deepEqual(splitAutoReplyPhrasePaste('Прайс, пожалуйста\nСколько стоит\r\nцена'), [
    'Прайс, пожалуйста',
    'Сколько стоит',
    'цена',
  ]);
  assert.deepEqual(mergeAutoReplyPhrases(['Прайс'], ['Доставка']), {
    phrases: ['Прайс', 'Доставка'],
  });
  assert.equal(mergeAutoReplyPhrases(['Прайс'], ['прайс']).issue, 'Такая фраза уже добавлена.');
  assert.match(mergeAutoReplyPhrases([], ['İ'.repeat(80)]).issue ?? '', /80/u);
  const bounded = Array.from({ length: 5 }, (_, index) => `${index}${'а'.repeat(79)}`);
  assert.match(mergeAutoReplyPhrases(bounded, [`5${'б'.repeat(79)}`]).issue ?? '', /Суммарно/u);
});

test('auto-reply draft requires phrases and content and validates fuzzy phrase safety', () => {
  const empty = createEmptyAutoReplyDraft();
  assert.deepEqual(validateAutoReplyDraft(empty), {
    phrases: 'Добавьте хотя бы одну фразу.',
    content: 'Добавьте текст или хотя бы одно фото.',
  });

  assert.deepEqual(
    validateAutoReplyDraft({ ...empty, phrases: ['Прайс', 'Стоимость'], text: '**Ответ**' }),
    {},
  );
  assert.deepEqual(
    validateAutoReplyDraft({ ...empty, phrases: ['Цена'], fuzzyMatch: true, text: 'Ответ' }),
    {
      fuzzyMatch: `Чтобы учитывать опечатки, в каждой фразе нужно минимум ${AUTO_REPLY_FUZZY_MIN_ALNUM_COUNT} букв или цифр.`,
    },
  );
  assert.deepEqual(
    validateAutoReplyDraft({ ...empty, phrases: ['Прайс'], fuzzyMatch: true, text: 'Ответ' }),
    {},
  );
  assert.deepEqual(
    validateAutoReplyDraft({
      ...empty,
      phrases: ['a\u0338b\u0338c'],
      fuzzyMatch: true,
      text: 'Ответ',
    }),
    {},
  );
  assert.match(
    validateAutoReplyDraft({ ...empty, phrases: ['İ'.repeat(80)], text: 'Ответ' }).phrases ?? '',
    /80/u,
  );
  assert.deepEqual(
    validateAutoReplyDraft({
      ...empty,
      phrases: ['Каталог'],
      text: 'Выберите раздел',
      buttons: [{ text: 'Открыть', url: 'https://max.ru/catalog' }],
    }),
    {},
  );
  assert.deepEqual(
    validateAutoReplyDraft({
      ...empty,
      phrases: ['Фото'],
      retainedAssets: [{ id: 'asset-1', mimeType: 'image/jpeg', fileName: 'photo.jpg' }],
    }),
    {},
  );

  assert.deepEqual(
    validateAutoReplyDraft({
      ...empty,
      phrases: ['Каталог'],
      text: 'Выберите раздел',
      buttons: [{ text: '', url: 'not-a-link' }],
    }),
    { buttons: 'Проверьте названия и ссылки кнопок.' },
  );
});

test('auto-reply match summaries cover all independent toggle combinations', () => {
  assert.equal(
    getAutoReplyMatchModeLabel({ matchInContext: false, fuzzyMatch: false }),
    'Точное сообщение',
  );
  assert.equal(
    getAutoReplyMatchModeLabel({ matchInContext: true, fuzzyMatch: false }),
    'Внутри сообщения',
  );
  assert.equal(
    getAutoReplyMatchModeLabel({ matchInContext: false, fuzzyMatch: true }),
    'Сообщение целиком · с опечатками',
  );
  assert.equal(
    getAutoReplyMatchModeLabel({ matchInContext: true, fuzzyMatch: true }),
    'Внутри сообщения · с опечатками',
  );
  assert.equal(getAutoReplyPhraseCountLabel(1), '1 фраза');
  assert.equal(getAutoReplyPhraseCountLabel(3), '3 фразы');
  assert.equal(getAutoReplyPhraseCountLabel(10), '10 фраз');
});

test('auto-reply conflicts distinguish versions, phrases, and stale clients', () => {
  const conflict = (code: string) => new ApiRequestError(409, JSON.stringify({ code }), 'conflict');
  assert.equal(
    getAutoReplyConflictKind(conflict('PUBLISHER_AUTO_REPLY_VERSION_CONFLICT')),
    'version_conflict',
  );
  assert.equal(
    getAutoReplyConflictKind(conflict('PUBLISHER_AUTO_REPLY_PHRASE_CONFLICT')),
    'phrase_conflict',
  );
  assert.equal(
    getAutoReplyConflictKind(conflict('PUBLISHER_AUTO_REPLY_CLIENT_UPGRADE_REQUIRED')),
    'client_upgrade_required',
  );
  assert.equal(getAutoReplyConflictKind(new ApiRequestError(409, '', 'conflict')), null);
});

test('auto-reply routes and draft keys remain scoped and encoded', () => {
  assert.equal(
    buildPublisherAutoRepliesRoute('chat/with?symbols'),
    '/publisher/chat/chat%2Fwith%3Fsymbols/auto-replies',
  );
  assert.notEqual(
    getAutoReplyDraftStorageKey('user-1', 'chat-1', 'rule-1'),
    getAutoReplyDraftStorageKey('user-1', 'chat-1', 'rule-2'),
  );
  assert.notEqual(
    getAutoReplyDraftStorageKey('user-1', 'chat-1', null),
    getAutoReplyDraftStorageKey('user-1', 'chat-2', null),
  );
  assert.notEqual(
    getAutoReplyDraftStorageKey('user-1', 'chat-1', null),
    getAutoReplyDraftStorageKey('user-2', 'chat-1', null),
  );
});

test('auto-reply storage is user-scoped and never migrates an unscoped draft', async () => {
  const store = new Map<string, string>();
  const previousWindow = globalThis.window;
  const localStorage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, value);
    },
    removeItem: (key: string) => {
      store.delete(key);
    },
  };

  Object.defineProperty(globalThis, 'window', {
    value: { localStorage },
    configurable: true,
  });

  try {
    const userId = 'user-with-draft';
    const chatId = 'chat-with-buttons';
    const ruleId = 'rule-with-buttons';
    const key = getAutoReplyDraftStorageKey(userId, chatId, ruleId);
    const legacyKey = `maxim:publisher-auto-reply:${chatId}:${ruleId}`;
    store.set(
      key,
      JSON.stringify({
        version: 1,
        savedAt: '2026-08-29T12:00:00.000Z',
        draft: {
          ...createEmptyAutoReplyDraft(),
          phrase: 'Старый черновик',
          text: 'Не должен заменить свежий ответ с сервера',
          buttons: undefined,
        },
      }),
    );

    assert.equal(await loadAutoReplyDraft(userId, chatId, ruleId), null);

    store.set(
      legacyKey,
      JSON.stringify({
        version: 2,
        savedAt: '2026-08-30T12:00:00.000Z',
        draft: {
          phrase: '  Старый   прайс ',
          text: 'Сохранённый ответ',
          images: [],
          retainedAssets: [],
          buttons: [{ text: 'Открыть', url: 'https://max.ru/catalog' }],
          cooldownSeconds: 60,
          enabled: false,
        },
      }),
    );
    assert.equal(await loadAutoReplyDraft(userId, chatId, ruleId), null);
    assert.equal(store.has(legacyKey), false);

    store.set(
      key,
      JSON.stringify({
        version: 2,
        savedAt: '2026-08-30T12:00:00.000Z',
        draft: {
          phrase: '  Старый   прайс ',
          text: 'Сохранённый ответ',
          images: [],
          retainedAssets: [],
          buttons: [{ text: 'Открыть', url: 'https://max.ru/catalog' }],
          cooldownSeconds: 60,
          enabled: false,
        },
      }),
    );
    assert.deepEqual(await loadAutoReplyDraft(userId, chatId, ruleId), {
      ...createEmptyAutoReplyDraft(),
      phrases: ['Старый прайс'],
      text: 'Сохранённый ответ',
      buttons: [{ text: 'Открыть', url: 'https://max.ru/catalog' }],
      cooldownSeconds: 60,
      enabled: false,
    });

    const currentDraft = {
      ...createEmptyAutoReplyDraft(),
      phrases: ['Каталог', 'Прайс'],
      matchInContext: true,
      text: 'Откройте нужный раздел',
      buttons: [{ text: 'Открыть', url: 'https://max.ru/catalog' }],
    };
    await saveAutoReplyDraft(userId, chatId, ruleId, currentDraft);
    assert.deepEqual(await loadAutoReplyDraft(userId, chatId, ruleId), currentDraft);
    assert.equal(await loadAutoReplyDraft('another-user', chatId, ruleId), null);

    await clearAutoReplyDraft(userId, chatId, ruleId);
    assert.equal(await loadAutoReplyDraft(userId, chatId, ruleId), null);
  } finally {
    Object.defineProperty(globalThis, 'window', {
      value: previousWindow,
      configurable: true,
    });
  }
});

test('auto-reply draft resolution selects the newest source and a newer tombstone', () => {
  const baseDraft = {
    ...createEmptyAutoReplyDraft(),
    phrases: ['Прайс'],
    text: 'Ответ',
  };
  const indexedEnvelope = {
    version: 3,
    savedAt: '2026-09-02T08:00:00.000Z',
    draft: { ...baseDraft, text: 'Устаревший ответ' },
  };
  const localEnvelope = {
    version: 3,
    savedAt: '2026-09-02T08:01:00.000Z',
    draft: baseDraft,
  };

  assert.deepEqual(
    resolveAutoReplyDraftLoadState({
      indexedEnvelope,
      localEnvelope,
      nativeEnvelope: null,
      nowMs: Date.parse('2026-09-02T09:00:00.000Z'),
    }),
    {
      draft: baseDraft,
      deleted: false,
      source: 'local',
      savedAt: '2026-09-02T08:01:00.000Z',
      imagesComplete: false,
      missingImageCount: 1,
      replicasToRepair: ['indexed', 'native'],
    },
  );
  assert.deepEqual(
    resolveAutoReplyDraftLoadState({
      indexedEnvelope,
      localEnvelope,
      nativeEnvelope: {
        version: 3,
        savedAt: '2026-09-02T08:02:00.000Z',
        deleted: true,
      },
      nowMs: Date.parse('2026-09-02T09:00:00.000Z'),
    }),
    {
      draft: null,
      deleted: true,
      source: 'native',
      savedAt: '2026-09-02T08:02:00.000Z',
      imagesComplete: true,
      missingImageCount: 0,
      replicasToRepair: ['indexed', 'local'],
    },
  );
});

test('auto-reply draft resolution quarantines future replicas before arbitration', () => {
  const nowMs = Date.parse('2026-09-02T08:00:00.000Z');
  const currentTombstone = {
    version: 3,
    savedAt: '2026-09-02T08:00:00.000Z',
    deleted: true,
  };
  const futureDraft = {
    version: 3,
    savedAt: '2099-01-01T00:00:00.000Z',
    draft: {
      ...createEmptyAutoReplyDraft(),
      phrases: ['Прайс'],
      text: 'Не должен воскреснуть',
    },
  };

  assert.deepEqual(
    resolveAutoReplyDraftLoadState({
      indexedEnvelope: futureDraft,
      localEnvelope: currentTombstone,
      nativeEnvelope: null,
      nowMs,
    }),
    {
      draft: null,
      deleted: true,
      source: 'local',
      savedAt: currentTombstone.savedAt,
      imagesComplete: true,
      missingImageCount: 0,
      replicasToRepair: ['indexed', 'native'],
    },
  );
});

test('auto-reply load heals stale native replicas so a removed local winner cannot resurrect data', async () => {
  const localValues = new Map<string, string>();
  const nativeValues = new Map<string, string>();
  const previousWindow = globalThis.window;
  const localStorage = {
    getItem: (key: string) => localValues.get(key) ?? null,
    setItem: (key: string, value: string) => {
      localValues.set(key, value);
    },
    removeItem: (key: string) => {
      localValues.delete(key);
    },
  };
  const deviceStorage = {
    getItem: async (key: string) => ({ key, value: nativeValues.get(key) ?? null }),
    setItem: async (key: string, value: string) => {
      nativeValues.set(key, value);
      return { key, value };
    },
    removeItem: async (key: string) => {
      nativeValues.delete(key);
      return { key, value: null };
    },
  };
  Object.defineProperty(globalThis, 'window', {
    value: {
      localStorage,
      indexedDB: undefined,
      MAX: { WebApp: { initData: 'signed-preview', DeviceStorage: deviceStorage } },
    },
    configurable: true,
  });

  try {
    const userId = 'user-heal';
    const chatId = 'chat-heal';
    const ruleId = 'rule-heal';
    const key = getAutoReplyDraftStorageKey(userId, chatId, ruleId);
    const olderDraft = {
      ...createEmptyAutoReplyDraft(),
      phrases: ['Старый'],
      text: 'Старый ответ',
    };
    const newerDraft = {
      ...createEmptyAutoReplyDraft(),
      phrases: ['Новый'],
      text: 'Новый ответ',
    };
    const olderEnvelope = JSON.stringify({
      version: 3,
      savedAt: new Date(Date.now() - 2_000).toISOString(),
      draft: olderDraft,
    });
    const newerEnvelope = JSON.stringify({
      version: 3,
      savedAt: new Date(Date.now() + 60_000).toISOString(),
      draft: newerDraft,
    });
    nativeValues.set(key, olderEnvelope);
    localValues.set(key, newerEnvelope);

    assert.deepEqual(await loadAutoReplyDraft(userId, chatId, ruleId), newerDraft);
    localValues.delete(key);
    assert.deepEqual(await loadAutoReplyDraft(userId, chatId, ruleId), newerDraft);

    const latestDraft = { ...newerDraft, text: 'Последняя локальная правка' };
    await saveAutoReplyDraft(userId, chatId, ruleId, latestDraft);
    assert.deepEqual(await loadAutoReplyDraft(userId, chatId, ruleId), latestDraft);

    await clearAutoReplyDraft(userId, chatId, ruleId);
    nativeValues.set(key, olderEnvelope);
    assert.equal(await loadAutoReplyDraft(userId, chatId, ruleId), null);
    localValues.delete(key);
    assert.equal(await loadAutoReplyDraft(userId, chatId, ruleId), null);
  } finally {
    Object.defineProperty(globalThis, 'window', {
      value: previousWindow,
      configurable: true,
    });
  }
});

test('auto-reply load falls back when IndexedDB access throws synchronously', async () => {
  const values = new Map<string, string>();
  const previousWindow = globalThis.window;
  const localStorage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
  };
  const restrictedWindow = { localStorage } as Window & typeof globalThis;
  Object.defineProperty(restrictedWindow, 'indexedDB', {
    get: () => {
      throw new DOMException('IndexedDB is blocked', 'SecurityError');
    },
  });
  Object.defineProperty(globalThis, 'window', { value: restrictedWindow, configurable: true });

  try {
    const userId = 'user-restricted';
    const chatId = 'chat-restricted';
    const key = getAutoReplyDraftStorageKey(userId, chatId, null);
    const draft = {
      ...createEmptyAutoReplyDraft(),
      phrases: ['Прайс'],
      text: 'Ответ из local storage',
    };
    values.set(key, JSON.stringify({ version: 3, savedAt: new Date().toISOString(), draft }));

    assert.deepEqual(await loadAutoReplyDraft(userId, chatId, null), draft);
  } finally {
    Object.defineProperty(globalThis, 'window', {
      value: previousWindow,
      configurable: true,
    });
  }
});

test('auto-reply load retries a transient read before healing an older replica', async () => {
  const localValues = new Map<string, string>();
  const nativeValues = new Map<string, string>();
  const previousWindow = globalThis.window;
  let failNativeRead = true;
  let nativeWriteCount = 0;
  const localStorage = {
    getItem: (key: string) => localValues.get(key) ?? null,
    setItem: (key: string, value: string) => {
      localValues.set(key, value);
    },
    removeItem: (key: string) => {
      localValues.delete(key);
    },
  };
  const deviceStorage = {
    getItem: async (key: string) => {
      if (failNativeRead) {
        failNativeRead = false;
        throw new Error('transient native read failure');
      }
      return { key, value: nativeValues.get(key) ?? null };
    },
    setItem: async (key: string, value: string) => {
      nativeWriteCount += 1;
      nativeValues.set(key, value);
      return { key, value };
    },
  };
  Object.defineProperty(globalThis, 'window', {
    value: {
      localStorage,
      indexedDB: undefined,
      MAX: { WebApp: { initData: 'signed-preview', DeviceStorage: deviceStorage } },
    },
    configurable: true,
  });

  try {
    const userId = 'user-read-error';
    const chatId = 'chat-read-error';
    const key = getAutoReplyDraftStorageKey(userId, chatId, null);
    const staleDraft = {
      ...createEmptyAutoReplyDraft(),
      phrases: ['Старый'],
      text: 'Старый ответ',
    };
    localValues.set(
      key,
      JSON.stringify({
        version: 3,
        savedAt: new Date(Date.now() - 1_000).toISOString(),
        imagesComplete: true,
        draft: staleDraft,
      }),
    );
    nativeValues.set(
      key,
      JSON.stringify({
        version: 3,
        savedAt: new Date().toISOString(),
        imagesComplete: true,
        deleted: true,
      }),
    );

    assert.equal(await loadAutoReplyDraft(userId, chatId, null), null);
    assert.equal(nativeWriteCount, 0);
    localValues.delete(key);
    assert.equal(await loadAutoReplyDraft(userId, chatId, null), null);
  } finally {
    Object.defineProperty(globalThis, 'window', {
      value: previousWindow,
      configurable: true,
    });
  }
});

test('auto-reply load fails closed while a replica remains unreadable', async () => {
  const localValues = new Map<string, string>();
  const previousWindow = globalThis.window;
  let nativeWriteCount = 0;
  const localStorage = {
    getItem: (key: string) => localValues.get(key) ?? null,
    setItem: (key: string, value: string) => {
      localValues.set(key, value);
    },
    removeItem: (key: string) => {
      localValues.delete(key);
    },
  };
  const deviceStorage = {
    getItem: async () => {
      throw new Error('persistent native read failure');
    },
    setItem: async (key: string, value: string) => {
      nativeWriteCount += 1;
      return { key, value };
    },
  };
  Object.defineProperty(globalThis, 'window', {
    value: {
      localStorage,
      indexedDB: undefined,
      MAX: { WebApp: { initData: 'signed-preview', DeviceStorage: deviceStorage } },
    },
    configurable: true,
  });

  try {
    const userId = 'user-persistent-read-error';
    const chatId = 'chat-persistent-read-error';
    const key = getAutoReplyDraftStorageKey(userId, chatId, null);
    localValues.set(
      key,
      JSON.stringify({
        version: 3,
        savedAt: new Date().toISOString(),
        imagesComplete: true,
        imageCount: 0,
        draft: {
          ...createEmptyAutoReplyDraft(),
          phrases: ['Старый'],
          text: 'Нельзя автоматически восстанавливать',
        },
      }),
    );

    await assert.rejects(loadAutoReplyDraft(userId, chatId, null), /could not be read safely/u);
    assert.equal(nativeWriteCount, 0);
    assert.equal(localValues.has(key), true);
  } finally {
    Object.defineProperty(globalThis, 'window', {
      value: previousWindow,
      configurable: true,
    });
  }
});

test('auto-reply mirror reports images that must be selected again', async () => {
  const values = new Map<string, string>();
  const previousWindow = globalThis.window;
  const localStorage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
  };
  Object.defineProperty(globalThis, 'window', {
    value: { localStorage, indexedDB: undefined },
    configurable: true,
  });

  try {
    const userId = 'user-missing-image';
    const chatId = 'chat-missing-image';
    await saveAutoReplyDraft(userId, chatId, null, {
      ...createEmptyAutoReplyDraft(),
      phrases: ['Фото'],
      text: 'Черновик с фото',
      images: [{ base64: 'AA==', mimeType: 'image/png', fileName: 'draft.png' }],
    });

    const restored = await loadAutoReplyDraftState(userId, chatId, null);
    assert.equal(restored.imagesComplete, false);
    assert.equal(restored.missingImageCount, 1);
    assert.deepEqual(restored.draft?.images, []);
  } finally {
    Object.defineProperty(globalThis, 'window', {
      value: previousWindow,
      configurable: true,
    });
  }
});

test('auto-reply mutation clock recovers after a device clock rollback', async () => {
  const values = new Map<string, string>();
  const previousWindow = globalThis.window;
  const originalDateNow = Date.now;
  const localStorage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
  };
  Object.defineProperty(globalThis, 'window', {
    value: { localStorage, indexedDB: undefined },
    configurable: true,
  });

  try {
    const userId = 'user-clock';
    const chatId = 'chat-clock';
    const futureDraft = {
      ...createEmptyAutoReplyDraft(),
      phrases: ['Будущее'],
      text: 'Старое время устройства',
    };
    const currentDraft = { ...futureDraft, text: 'Актуальная правка' };
    Date.now = () => Date.parse('2099-01-01T00:00:00.000Z');
    await saveAutoReplyDraft(userId, chatId, null, futureDraft);
    Date.now = originalDateNow;
    await saveAutoReplyDraft(userId, chatId, null, currentDraft);

    assert.deepEqual(await loadAutoReplyDraft(userId, chatId, null), currentDraft);
  } finally {
    Date.now = originalDateNow;
    Object.defineProperty(globalThis, 'window', {
      value: previousWindow,
      configurable: true,
    });
  }
});

test('bot authoring polls only active states and presents the next expected step', () => {
  assert.equal(isActiveAutoReplyAuthoringState('awaiting_phrase'), true);
  assert.equal(isActiveAutoReplyAuthoringState('review'), true);
  assert.equal(isActiveAutoReplyAuthoringState('completed'), false);
  assert.equal(isActiveAutoReplyAuthoringState('canceled'), false);
  assert.equal(getAutoReplyAuthoringStateLabel('awaiting_content'), 'Публик ждёт текст или фото');
});

test('auto-reply close can only acknowledge a durable complete draft', async () => {
  const previousWindow = globalThis.window;
  const local = new Map<string, string>();
  const native = new Map<string, string>();
  let localWritable = false;
  let nativeWritable = false;
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      indexedDB: undefined,
      localStorage: {
        getItem: (key: string) => local.get(key) ?? null,
        setItem: (key: string, value: string) => {
          if (!localWritable) throw new Error('Quota exceeded');
          local.set(key, value);
        },
      },
      MAX: {
        WebApp: {
          platform: 'android',
          initData: 'synthetic',
          DeviceStorage: {
            getItem: async (key: string) => ({ value: native.get(key) ?? null }),
            setItem: async (key: string, value: string) => {
              if (!nativeWritable) throw new Error('Storage unavailable');
              native.set(key, value);
            },
          },
        },
      },
    },
  });
  const draft = { ...createEmptyAutoReplyDraft(), phrases: ['Каталог'], text: 'Ответ' };
  try {
    assert.equal(await saveAutoReplyDraft('save-proof', 'chat', null, draft), false);
    localWritable = true;
    assert.equal(await saveAutoReplyDraft('save-proof', 'chat', null, draft), true);
    localWritable = false;
    nativeWritable = true;
    assert.equal(
      await saveAutoReplyDraft('save-proof', 'chat', null, { ...draft, text: 'Новый ответ' }),
      true,
    );
    assert.equal(
      await saveAutoReplyDraft('save-proof', 'chat', null, {
        ...draft,
        images: [{ base64: 'AA==', mimeType: 'image/png', fileName: 'photo.png' }],
      }),
      false,
      'text mirrors cannot confirm that image bytes were saved',
    );
  } finally {
    Object.defineProperty(globalThis, 'window', { value: previousWindow, configurable: true });
  }
});
