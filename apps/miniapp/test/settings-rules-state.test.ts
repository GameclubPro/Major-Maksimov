import duplicateRulesCases from '../../../packages/contracts/test/fixtures/duplicate-rules.json';
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MAX_CHAT_RULES_TEXT_LENGTH,
  chatRulesSchema,
  chatSettingsScreenResponseSchema,
  chatSettingsSchema,
  duplicatePhotoModerationModeSchema,
  type ChatRules,
  type ChatSettingsScreenResponse,
} from '@maxim/contracts';
import {
  getRulesPublicationFeedback,
  mergeSavedRulesIntoSettingsScreen,
  mergeRulesPublicationIntoDraft,
  runRulesSaveAttempt,
  serializeRulesDraftPayload,
  shouldHydrateRulesDraftFromServer,
} from '../src/pages/settings-rules-state';
import { buildRulesTextFromSettingsScreen } from '../src/pages/settings-rules-text';

test('publication feedback never describes an existing-post edit as a new publication', () => {
  assert.deepEqual(getRulesPublicationFeedback({ operation: 'updated', messageId: 'old' }, 'old'), {
    title: 'Прежний пост правил обновлён',
    description: 'Изменён прежний пост. Новое сообщение в чат не отправлялось.',
  });
  assert.equal(
    getRulesPublicationFeedback({ operation: 'created', messageId: 'new' }, 'old').title,
    'Новый пост правил опубликован',
  );
  assert.equal(
    getRulesPublicationFeedback({ messageId: 'old' }, 'old').title,
    'Прежний пост правил обновлён',
  );
  assert.equal(
    getRulesPublicationFeedback({ messageId: 'new' }, 'old').title,
    'Новый пост правил опубликован',
  );
});

function createRules(overrides: Partial<ChatRules> = {}): ChatRules {
  return chatRulesSchema.parse({
    ...chatRulesSchema.parse({}),
    ...overrides,
  });
}

function createScreen(
  overrides: Partial<ChatSettingsScreenResponse> = {},
): ChatSettingsScreenResponse {
  return chatSettingsScreenResponseSchema.parse({
    settings: chatSettingsSchema.parse({}),
    rules: createRules(),
    header: {
      id: 'chat-1',
      title: 'Chat 1',
      entityType: 'chat',
      link: null,
      participantsCount: null,
    },
    requiredSubscriptionChannels: [],
    domains: [],
    managedBroadcasts: [],
    ...overrides,
  });
}

test('serializeRulesDraftPayload uses a stable field order for retry snapshots', () => {
  const payload = {
    autoTextEnabled: true,
    text: 'Правила',
    textFormat: 'plain' as const,
    imageBase64: '',
    imageMimeType: '',
    imageFileName: '',
    buttonEnabled: false,
    buttonUrl: '',
    buttonText: 'Открыть',
  };

  assert.equal(
    serializeRulesDraftPayload(payload),
    JSON.stringify({
      text: 'Правила',
      textFormat: 'plain',
      imageBase64: '',
      imageMimeType: '',
      imageFileName: '',
      autoTextEnabled: true,
      buttonEnabled: false,
      buttonUrl: '',
      buttonText: 'Открыть',
    }),
  );
});

test('shouldHydrateRulesDraftFromServer preserves newer local edits during refetch', () => {
  const previousServerDraft = createRules({ text: 'Старый серверный черновик' });
  const currentDraft = createRules({ text: 'Новый локальный черновик' });
  const nextServerDraft = createRules({ text: 'Сервер после прошлого autosave' });

  assert.equal(
    shouldHydrateRulesDraftFromServer({
      currentDraft,
      previousServerSnapshot: serializeRulesDraftPayload(previousServerDraft),
      nextServerDraft,
    }),
    false,
  );
});

test('shouldHydrateRulesDraftFromServer accepts fresh server state when draft was not edited locally', () => {
  const previousServerDraft = createRules({ text: 'Серверный черновик' });
  const nextServerDraft = createRules({ text: 'Серверный черновик после сохранения' });

  assert.equal(
    shouldHydrateRulesDraftFromServer({
      currentDraft: previousServerDraft,
      previousServerSnapshot: serializeRulesDraftPayload(previousServerDraft),
      nextServerDraft,
    }),
    true,
  );
});

test('mergeSavedRulesIntoSettingsScreen makes a successful save the new server snapshot', () => {
  const current = createScreen({ rules: createRules({ text: 'Старый черновик' }) });
  const saved = createRules({ text: 'Сохранённый черновик' });

  const next = mergeSavedRulesIntoSettingsScreen(current, saved);

  assert.equal(next?.rules.text, 'Сохранённый черновик');
  assert.equal(next?.settings, current.settings);
  assert.equal(mergeSavedRulesIntoSettingsScreen(undefined, saved), undefined);
});

test('publication readback preserves dirty text and advances only a receipt-only revision', () => {
  const base = createRules({ text: 'Сохранённый текст', revision: '2026-11-10T06:00:00.000Z' });
  const dirty = { ...base, text: 'Новая редакция', publishedMessageId: 'old-post' };
  const removed = {
    ...base,
    revision: '2026-11-10T06:01:00.000Z',
    publishedMessageId: null,
    publishedUrl: null,
    publishedAt: null,
  };
  const merged = mergeRulesPublicationIntoDraft(dirty, removed, serializeRulesDraftPayload(base));
  assert.equal(merged.text, 'Новая редакция');
  assert.equal(merged.revision, removed.revision);
  assert.equal(merged.publishedMessageId, null);

  const conflicting = { ...removed, text: 'Правка другого администратора' };
  const conflict = mergeRulesPublicationIntoDraft(
    dirty,
    conflicting,
    serializeRulesDraftPayload(base),
  );
  assert.equal(conflict.text, 'Новая редакция');
  assert.equal(conflict.revision, base.revision);
  assert.equal(conflict.publishedMessageId, null);
  assert.equal(mergeRulesPublicationIntoDraft(null, removed, ''), removed);
});

test('runRulesSaveAttempt detects edits made while a save is in flight', async () => {
  const submittedDraft = createRules({ text: 'Версия A' });
  const savedDraft = createRules({ text: 'Версия A' });
  let currentDraft = submittedDraft;
  let resolveSave: (saved: ChatRules) => void = () => undefined;
  const save = new Promise<ChatRules>((resolve) => {
    resolveSave = resolve;
  });

  const attemptPromise = runRulesSaveAttempt({
    submittedDraft,
    save: () => save,
    getCurrentDraft: () => currentDraft,
  });
  currentDraft = createRules({ text: 'Версия B' });
  resolveSave(savedDraft);

  await assert.doesNotReject(attemptPromise);
  assert.equal((await attemptPromise)?.isCurrent, false);
});

test('runRulesSaveAttempt accepts the submitted or normalized saved draft', async () => {
  const submittedDraft = {
    ...createRules({ text: 'Версия A' }),
    buttonText: ' Кнопка ',
  };
  const savedDraft = createRules({ text: 'Версия A', buttonText: 'Кнопка' });

  for (const currentDraft of [submittedDraft, savedDraft]) {
    const result = await runRulesSaveAttempt({
      submittedDraft,
      save: async () => savedDraft,
      getCurrentDraft: () => currentDraft,
    });
    assert.equal(result?.isCurrent, true);
  }
});

test('buildRulesTextFromSettingsScreen assembles a publishable draft from active settings', () => {
  const screen = createScreen({
    settings: chatSettingsSchema.parse({
      linkPolicy: 'ALLOWLIST_ONLY',
      requiredSubscriptionEnabled: true,
      requiredSubscriptionChannelIds: ['channel-1', 'channel-2'],
      russianProfanityFilterEnabled: true,
      antiSpamEnabled: true,
      photoMessagesEnabled: false,
      forwardedMessagesEnabled: false,
      nightModeEnabled: true,
      nightModeStartTimeMinutes: 1380,
      nightModeEndTimeMinutes: 420,
    }),
    domains: [
      {
        domain: 'docs.max.ru',
        normalizedValue: 'docs.max.ru',
        matchType: 'DOMAIN',
        removeAfterAt: null,
      },
    ],
    requiredSubscriptionChannels: [
      {
        id: 'channel-1',
        title: 'Новости проекта',
        entityType: 'channel',
        link: null,
        participantsCount: null,
      },
      {
        id: 'channel-2',
        title: 'Объявления',
        entityType: 'channel',
        link: null,
        participantsCount: null,
      },
    ],
  });

  const text = buildRulesTextFromSettingsScreen(screen);
  assert.match(text, /^Правила чата:\n\n1\./);
  assert.match(text, /Можно отправлять только ссылки из разрешённого списка\./);
  assert.match(text, /Чтобы писать в чат, сначала подпишитесь на: Новости проекта, Объявления\./);
  assert.match(text, /Пожалуйста, без мата и грубой лексики\./);
  assert.match(text, /Пожалуйста, не флудите и не спамьте\./);
  assert.match(text, /Фото сюда отправлять нельзя\./);
  assert.match(text, /Пересланные сообщения сюда отправлять нельзя\./);
  assert.match(text, /Ночью чат работает тише: ограничения действуют с 23:00 до 07:00\./);
});

test('buildRulesTextFromSettingsScreen uses the full shared rules limit', () => {
  const channelIds = ['channel-1', 'channel-2', 'channel-3'];
  const screen = createScreen({
    settings: chatSettingsSchema.parse({
      linkPolicy: 'ALERT_ONLY',
      requiredSubscriptionEnabled: true,
      requiredSubscriptionChannelIds: channelIds,
      russianProfanityFilterEnabled: true,
      commercialAdsFilterEnabled: true,
      antiDuplicateEnabled: true,
      antiSpamEnabled: true,
      messageCountLimitEnabled: true,
      maxMessageLengthEnabled: true,
      photoMessageCooldownEnabled: true,
      stickerMessageCooldownEnabled: true,
      photoMessagesEnabled: false,
      videoMessagesEnabled: false,
      fileMessagesEnabled: false,
      voiceMessagesEnabled: false,
      forwardedMessagesEnabled: false,
      phoneNumbersEnabled: false,
      nightModeEnabled: true,
      linkWarnEnabled: true,
      textFiltersMuteEnabled: true,
      duplicateBanEnabled: true,
    }),
    requiredSubscriptionChannels: channelIds.map((id, index) => ({
      id,
      title: String.fromCharCode(1040 + index).repeat(520),
      entityType: 'channel' as const,
      link: null,
      participantsCount: null,
    })),
  });

  const text = buildRulesTextFromSettingsScreen(screen);
  assert.ok(text.length > 2_000);
  assert.ok(text.length <= MAX_CHAT_RULES_TEXT_LENGTH);
  assert.match(text, /За повторные нарушения бот может/);
});

test('buildRulesTextFromSettingsScreen describes the selected profanity sensitivity', () => {
  const expectedBySensitivity = {
    CORE_ONLY: 'Пожалуйста, без мата.',
    BALANCED: 'Пожалуйста, без мата и грубой лексики.',
    STRICT: 'Пожалуйста, без мата, грубой лексики и оскорблений.',
  } as const;

  for (const [profanitySensitivity, expected] of Object.entries(expectedBySensitivity)) {
    const text = buildRulesTextFromSettingsScreen(
      createScreen({
        settings: chatSettingsSchema.parse({
          russianProfanityFilterEnabled: true,
          profanitySensitivity,
        }),
      }),
    );

    assert.ok(text.includes(expected));
  }
});

test('buildRulesTextFromSettingsScreen mentions photos only for enforcing rollout modes', () => {
  const settings = chatSettingsSchema.parse({
    antiDuplicateEnabled: true,
    duplicatePhotoEnabled: true,
  });

  for (const mode of ['OFF', 'OBSERVE', 'DELETE_ONLY'] as const) {
    const text = buildRulesTextFromSettingsScreen(
      createScreen({ settings, duplicatePhotoModerationMode: mode }),
    );
    assert.match(text, /Не отправляйте одинаковые и похожие сообщения/);
    assert.doesNotMatch(text, /[Оо]динаковые картинки/u);
  }

  for (const mode of ['FULL'] as const) {
    const text = buildRulesTextFromSettingsScreen(
      createScreen({ settings, duplicatePhotoModerationMode: mode }),
    );
    assert.match(text, /[Оо]динаковые картинки/u);
  }
});

test('buildRulesTextFromSettingsScreen describes the effective duplicate preset', () => {
  const cases = [
    {
      overrides: { duplicateDetectionPreset: 'STANDARD' as const },
      expected: 'Не отправляйте одинаковые сообщения: бот среагирует после 1 дубля.',
    },
    {
      overrides: { duplicateDetectionPreset: 'STRICT' as const },
      expected: 'Не отправляйте одинаковые и похожие сообщения: бот среагирует после 1 дубля.',
    },
    {
      overrides: {
        duplicateDetectionPreset: 'CUSTOM' as const,
        duplicateIgnoreLinksEnabled: true,
        duplicateIgnorePhonesEnabled: true,
      },
      expected:
        'Не отправляйте одинаковые сообщения, одни и те же ссылки и одни и те же номера телефонов: бот среагирует после 1 дубля.',
    },
  ];

  for (const { expected, overrides } of cases) {
    const text = buildRulesTextFromSettingsScreen(
      createScreen({
        settings: chatSettingsSchema.parse({
          antiDuplicateEnabled: true,
          duplicateWarnEnabled: true,
          ...overrides,
        }),
      }),
    );
    assert.match(text, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'));
  }
});

test('buildRulesTextFromSettingsScreen ignores duplicate sanctions while master is off', () => {
  const text = buildRulesTextFromSettingsScreen(
    createScreen({
      settings: chatSettingsSchema.parse({
        antiDuplicateEnabled: false,
        duplicateWarnEnabled: true,
        duplicateMuteEnabled: true,
        duplicateBanEnabled: true,
      }),
    }),
  );

  assert.doesNotMatch(text, /За повторные нарушения бот может/u);
});

test('buildRulesTextFromSettingsScreen treats legacy required subscription expiry as indefinite', () => {
  const screen = createScreen({
    settings: chatSettingsSchema.parse({
      requiredSubscriptionEnabled: true,
      requiredSubscriptionChannelIds: ['channel-1'],
      requiredSubscriptionExpiresAt: '2026-04-01T00:00:00.000Z',
      antiSpamEnabled: true,
    }),
    requiredSubscriptionChannels: [
      {
        id: 'channel-1',
        title: 'Новости проекта',
        entityType: 'channel',
        link: null,
        participantsCount: null,
      },
    ],
  });

  const text = buildRulesTextFromSettingsScreen(screen);
  assert.match(text, /Чтобы писать в чат, сначала подпишитесь на: Новости проекта\./);
  assert.match(text, /Пожалуйста, не флудите и не спамьте\./);
});

test('buildRulesTextFromSettingsScreen does not inspect retired code-word settings', () => {
  const screen = createScreen();
  const retiredPrefix = ['thema', 'tic'].join('');
  const guardedSettings = new Proxy(screen.settings, {
    get(target, property, receiver) {
      if (typeof property === 'string' && property.startsWith(retiredPrefix)) {
        throw new Error(`Retired setting accessed: ${property}`);
      }
      return Reflect.get(target, property, receiver);
    },
  });

  assert.doesNotThrow(() =>
    buildRulesTextFromSettingsScreen({
      ...screen,
      settings: guardedSettings,
    }),
  );
});

for (const fixture of duplicateRulesCases) {
  test(`shared anti-duplicate rules parity: ${fixture.name}`, () => {
    const text = buildRulesTextFromSettingsScreen(
      createScreen({
        settings: chatSettingsSchema.parse(fixture.settings),
        duplicatePhotoModerationMode: duplicatePhotoModerationModeSchema.parse(fixture.photoMode),
      }),
    );
    assert.deepEqual(
      text
        .split('\n')
        .map((line) => line.replace(/^\d+\. /u, ''))
        .filter((line) =>
          /^(Антидубль |Повторы учитываются |Не отправляйте |Одинаковые картинки)/u.test(line),
        ),
      fixture.expected,
    );
  });
}
