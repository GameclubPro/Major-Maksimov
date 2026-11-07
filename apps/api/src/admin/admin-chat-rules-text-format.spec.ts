import duplicateRulesCases from '../../../../packages/contracts/test/fixtures/duplicate-rules.json';
import {
  MAX_CHAT_RULES_TEXT_LENGTH,
  chatSettingsSchema,
  duplicatePhotoModerationModeSchema,
  managedEntityHeaderSchema,
} from '@maxim/contracts';
import {
  buildRulesTextFromSettings,
  buildRulesTextItemsFromSettings,
  buildRulesSanctionsSummary,
  formatRulesConjunctionList,
  formatRulesDuplicateAllowanceLabel,
  formatRulesHoursLabel,
  formatRulesMinutesLabel,
  formatRulesPreviewList,
  formatRulesTime,
  resolveRulesDuplicateAllowedCount,
} from './admin-chat-rules-text-format';

describe('admin chat rules text format helpers', () => {
  it.each([
    ['ALLOW_ALL', undefined],
    ['DENY_SELECTED', 'Не публикуйте ссылки из запрещённого списка.'],
    ['ALLOW_SELECTED', 'Можно отправлять только ссылки из разрешённого списка.'],
    ['DENY_ALL', 'Пожалуйста, не отправляйте ссылки: бот их удаляет.'],
  ] as const)(
    'describes the authored %s link mode without exposing configured targets',
    (mode, expected) => {
      const settings = chatSettingsSchema.parse({
        linkPolicy: 'BLOCKLIST_ONLY',
        linkRulesPolicy: {
          version: 1,
          mode,
          rules: [
            {
              id: 'blocked',
              kind: 'WEB_EXACT',
              effect: 'DENY',
              target: 'https://example.com/offer',
            },
          ],
        },
      });
      expect(
        buildRulesTextItemsFromSettings({
          settings,
          domains: [],
          requiredSubscriptionChannels: [],
        })[0],
      ).toBe(expected);
    },
  );
  it('builds autofilled rules text from active settings', () => {
    const settings = chatSettingsSchema.parse({
      linkPolicy: 'ALLOWLIST_ONLY',
      requiredSubscriptionChannelIds: ['channel-1', 'channel-2'],
      russianProfanityFilterEnabled: true,
      antiSpamEnabled: true,
      antiDuplicateEnabled: true,
      duplicateWarnEnabled: true,
      messageCountLimitEnabled: true,
      messageCountLimitMessages: 3,
      messageCountLimitWindowHours: 2,
      nightModeEnabled: true,
      nightModeStartTimeMinutes: 23 * 60,
      nightModeEndTimeMinutes: 7 * 60 + 30,
      linkWarnEnabled: true,
      duplicateMuteEnabled: true,
      duplicateBanEnabled: true,
    });
    const input = {
      settings,
      domains: [
        {
          domain: 'example.com',
          normalizedValue: 'example.com',
          matchType: 'DOMAIN' as const,
          removeAfterAt: null,
        },
      ],
      requiredSubscriptionChannels: [
        managedEntityHeaderSchema.parse({
          id: 'channel-1',
          title: 'Новости',
          entityType: 'channel',
          link: null,
          participantsCount: null,
        }),
        managedEntityHeaderSchema.parse({
          id: 'channel-2',
          title: 'Анонсы',
          entityType: 'channel',
          link: null,
          participantsCount: null,
        }),
      ],
    };

    expect(buildRulesTextItemsFromSettings(input)).toEqual([
      'Можно отправлять только ссылки из разрешённого списка.',
      'Чтобы писать в чат, сначала подпишитесь на: Новости, Анонсы.',
      'Пожалуйста, без мата и грубой лексики.',
      'Повторы учитываются в течение 12 ч с принятого оригинала. Удалённые повторы не продлевают этот срок.',
      'Не отправляйте одинаковые и похожие сообщения: бот среагирует после 1 дубля.',
      'Пожалуйста, не флудите и не спамьте.',
      'Пожалуйста, не отправляйте больше 3 сообщений за 2 часа.',
      'Ночью чат работает тише: ограничения действуют с 23:00 до 07:30.',
      'За повторные нарушения бот может предупредить, временно ограничить сообщения и заблокировать.',
    ]);
    expect(buildRulesTextFromSettings(input)).toBe(
      [
        'Правила чата:',
        '',
        '1. Можно отправлять только ссылки из разрешённого списка.',
        '2. Чтобы писать в чат, сначала подпишитесь на: Новости, Анонсы.',
        '3. Пожалуйста, без мата и грубой лексики.',
        '4. Повторы учитываются в течение 12 ч с принятого оригинала. Удалённые повторы не продлевают этот срок.',
        '5. Не отправляйте одинаковые и похожие сообщения: бот среагирует после 1 дубля.',
        '6. Пожалуйста, не флудите и не спамьте.',
        '7. Пожалуйста, не отправляйте больше 3 сообщений за 2 часа.',
        '8. Ночью чат работает тише: ограничения действуют с 23:00 до 07:30.',
        '9. За повторные нарушения бот может предупредить, временно ограничить сообщения и заблокировать.',
      ].join('\n'),
    );
  });

  it('uses the full shared rules limit for autofilled text', () => {
    const channelIds = ['channel-1', 'channel-2', 'channel-3'];
    const settings = chatSettingsSchema.parse({
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
      phoneNumbersEnabled: false,
      nightModeEnabled: true,
      linkWarnEnabled: true,
      textFiltersMuteEnabled: true,
      duplicateBanEnabled: true,
    });
    const text = buildRulesTextFromSettings({
      settings,
      domains: [],
      requiredSubscriptionChannels: channelIds.map((id, index) =>
        managedEntityHeaderSchema.parse({
          id,
          title: String.fromCharCode(1040 + index).repeat(520),
          entityType: 'channel',
          link: null,
          participantsCount: null,
        }),
      ),
    });

    expect(text.length).toBeGreaterThan(2_000);
    expect(text.length).toBeLessThanOrEqual(MAX_CHAT_RULES_TEXT_LENGTH);
    expect(text).toContain('За повторные нарушения бот может');
  });

  it.each([
    ['CORE_ONLY', 'Пожалуйста, без мата.'],
    ['BALANCED', 'Пожалуйста, без мата и грубой лексики.'],
    ['STRICT', 'Пожалуйста, без мата, грубой лексики и оскорблений.'],
  ] as const)('describes %s profanity sensitivity in published rules', (sensitivity, expected) => {
    const settings = chatSettingsSchema.parse({
      russianProfanityFilterEnabled: true,
      profanitySensitivity: sensitivity,
    });

    expect(
      buildRulesTextItemsFromSettings({
        settings,
        domains: [],
        requiredSubscriptionChannels: [],
      }),
    ).toContain(expected);
  });

  it('includes the forwarded-message prohibition in published rules', () => {
    const settings = chatSettingsSchema.parse({ forwardedMessagesEnabled: false });

    const text = buildRulesTextFromSettings({
      settings,
      domains: [],
      requiredSubscriptionChannels: [],
    });

    expect(text).toContain('Пересланные сообщения сюда отправлять нельзя.');
  });

  it('mentions repeated photos only when photo duplicate enforcement is active', () => {
    const baseSettings = chatSettingsSchema.parse({
      linkPolicy: 'ALERT_ONLY',
      antiDuplicateEnabled: true,
      duplicateWarnEnabled: true,
    });
    const input = {
      domains: [],
      requiredSubscriptionChannels: [],
    };

    expect(
      buildRulesTextItemsFromSettings({
        ...input,
        settings: { ...baseSettings, duplicatePhotoEnabled: false },
      }),
    ).toContain('Не отправляйте одинаковые и похожие сообщения: бот среагирует после 1 дубля.');
    expect(
      buildRulesTextItemsFromSettings({
        ...input,
        settings: { ...baseSettings, duplicatePhotoEnabled: true },
        duplicatePhotoModerationMode: 'FULL',
      }),
    ).toContain(
      'Одинаковые картинки одного участника считаются повтором независимо от подписи. Действует общая цепочка антидубля.',
    );
    expect(
      buildRulesTextItemsFromSettings({
        ...input,
        settings: { ...baseSettings, duplicatePhotoEnabled: true },
        duplicatePhotoModerationMode: 'OBSERVE',
      }),
    ).toContain('Не отправляйте одинаковые и похожие сообщения: бот среагирует после 1 дубля.');
  });

  it.each([
    [
      {
        duplicateDetectionPreset: 'STANDARD' as const,
      },
      'Не отправляйте одинаковые сообщения: бот среагирует после 1 дубля.',
    ],
    [
      {
        duplicateDetectionPreset: 'STRICT' as const,
      },
      'Не отправляйте одинаковые и похожие сообщения: бот среагирует после 1 дубля.',
    ],
    [
      {
        duplicateDetectionPreset: 'CUSTOM' as const,
        duplicateIgnoreLinksEnabled: true,
        duplicateIgnorePhonesEnabled: true,
      },
      'Не отправляйте одинаковые сообщения, одни и те же ссылки и одни и те же номера телефонов: бот среагирует после 1 дубля.',
    ],
  ])(
    'describes the effective duplicate preset in published rules for %#',
    (overrides, expected) => {
      const settings = chatSettingsSchema.parse({
        antiDuplicateEnabled: true,
        duplicateWarnEnabled: true,
        ...overrides,
      });

      expect(
        buildRulesTextItemsFromSettings({
          settings,
          domains: [],
          requiredSubscriptionChannels: [],
        }),
      ).toContain(expected);
    },
  );

  it('uses a fallback allowlist rule when allowed domains are empty', () => {
    const parsedSettings = chatSettingsSchema.parse({
      linkPolicy: 'ALLOWLIST_ONLY',
      antiSpamEnabled: false,
      antiDuplicateEnabled: false,
      duplicateWarnEnabled: false,
      duplicateMuteEnabled: false,
      duplicateBanEnabled: false,
      russianProfanityFilterEnabled: false,
      linkWarnEnabled: false,
      linkMuteEnabled: false,
      linkBanEnabled: false,
      textFiltersWarnEnabled: false,
      textFiltersMuteEnabled: false,
      textFiltersBanEnabled: false,
      photoMessagesEnabled: true,
      videoMessagesEnabled: true,
      fileMessagesEnabled: true,
      voiceMessagesEnabled: true,
      phoneNumbersEnabled: true,
    });
    const settings = {
      ...parsedSettings,
      thematicCodewordEnabled: true,
      thematicCodeword: 'Секрет',
      thematicFiltersWarnEnabled: true,
      thematicFiltersMuteEnabled: true,
      thematicFiltersBanEnabled: true,
    };

    expect(
      buildRulesTextFromSettings({
        settings,
        domains: [],
        requiredSubscriptionChannels: [],
      }),
    ).toBe(
      [
        'Правила чата:',
        '',
        '1. Ссылки здесь ограничены: если нужно, сначала согласуйте их с администраторами.',
      ].join('\n'),
    );
  });

  it('formats Russian duration labels for rules text', () => {
    expect(formatRulesHoursLabel(1)).toBe('час');
    expect(formatRulesHoursLabel(2)).toBe('часа');
    expect(formatRulesHoursLabel(5)).toBe('часов');
    expect(formatRulesHoursLabel(11)).toBe('часов');
    expect(formatRulesHoursLabel(21)).toBe('час');

    expect(formatRulesMinutesLabel(1)).toBe('минуту');
    expect(formatRulesMinutesLabel(2)).toBe('минуты');
    expect(formatRulesMinutesLabel(5)).toBe('минут');
    expect(formatRulesMinutesLabel(11)).toBe('минут');
    expect(formatRulesMinutesLabel(21)).toBe('минуту');
  });

  it('formats list previews, conjunctions, duplicate labels, and clock time', () => {
    expect(formatRulesPreviewList([' Канал ', 'Канал', '', 'Чат', 'Новости'], 2)).toBe(
      'Канал, Чат и ещё 1',
    );
    expect(formatRulesConjunctionList([])).toBe('');
    expect(formatRulesConjunctionList(['предупредить'])).toBe('предупредить');
    expect(formatRulesConjunctionList(['предупредить', 'заблокировать'])).toBe(
      'предупредить и заблокировать',
    );
    expect(formatRulesConjunctionList(['предупредить', 'ограничить', 'заблокировать'])).toBe(
      'предупредить, ограничить и заблокировать',
    );
    expect(formatRulesDuplicateAllowanceLabel(0)).toBe('с первого дубля');
    expect(formatRulesDuplicateAllowanceLabel(1)).toBe('после 1 дубля');
    expect(formatRulesDuplicateAllowanceLabel(3)).toBe('после 3 дублей');
    expect(formatRulesTime(-10)).toBe('00:00');
    expect(formatRulesTime(9 * 60 + 4)).toBe('09:04');
    expect(formatRulesTime(24 * 60)).toBe('23:59');
  });

  it('resolves duplicate allowance from the first enabled duplicate sanction', () => {
    expect(
      resolveRulesDuplicateAllowedCount({
        duplicateBotMessageEnabled: false,
        duplicateWarnEnabled: true,
        duplicateMuteEnabled: true,
        duplicateBanEnabled: true,
        duplicateWarnMaxCount: 4,
        duplicateMuteMaxCount: 8,
        duplicateBanMaxCount: 12,
      }),
    ).toBe(3);

    expect(
      resolveRulesDuplicateAllowedCount({
        duplicateBotMessageEnabled: true,
        duplicateWarnEnabled: false,
        duplicateMuteEnabled: true,
        duplicateBanEnabled: true,
        duplicateWarnMaxCount: 4,
        duplicateMuteMaxCount: 8,
        duplicateBanMaxCount: 12,
      }),
    ).toBe(6);
  });

  it.each([
    ['no actions', false, false, false, false, 20, 20, 20, 19],
    ['no actions', true, false, false, false, 20, 20, 20, 18],
    ['WARN only', false, true, false, false, 20, 20, 20, 19],
    ['WARN only', true, true, false, false, 20, 20, 20, 18],
    ['WARN and BAN', false, true, false, true, 19, 20, 20, 18],
    ['WARN and BAN', true, true, false, true, 19, 20, 20, 17],
    ['MUTE and BAN', false, false, true, true, 19, 19, 20, 18],
    ['MUTE and BAN', true, false, true, true, 19, 19, 20, 17],
    ['full ladder', false, true, true, true, 18, 19, 20, 17],
    ['full ladder', true, true, true, true, 18, 19, 20, 16],
  ] as const)(
    'keeps %s allowance aligned with bot message %s',
    (
      _name,
      duplicateBotMessageEnabled,
      duplicateWarnEnabled,
      duplicateMuteEnabled,
      duplicateBanEnabled,
      duplicateWarnMaxCount,
      duplicateMuteMaxCount,
      duplicateBanMaxCount,
      expected,
    ) => {
      expect(
        resolveRulesDuplicateAllowedCount({
          duplicateBotMessageEnabled,
          duplicateWarnEnabled,
          duplicateMuteEnabled,
          duplicateBanEnabled,
          duplicateWarnMaxCount,
          duplicateMuteMaxCount,
          duplicateBanMaxCount,
        }),
      ).toBe(expected);
    },
  );

  it('summarizes enabled sanctions in rules text order', () => {
    const emptySanctions = {
      linkWarnEnabled: false,
      requiredSubscriptionWarnEnabled: false,
      textFiltersWarnEnabled: false,
      messageLimitsWarnEnabled: false,
      antiDuplicateEnabled: false,
      duplicateWarnEnabled: false,
      linkMuteEnabled: false,
      requiredSubscriptionMuteEnabled: false,
      textFiltersMuteEnabled: false,
      messageLimitsMuteEnabled: false,
      duplicateMuteEnabled: false,
      linkBanEnabled: false,
      requiredSubscriptionBanEnabled: false,
      textFiltersBanEnabled: false,
      messageLimitsBanEnabled: false,
      duplicateBanEnabled: false,
    };

    expect(buildRulesSanctionsSummary(emptySanctions)).toBeNull();
    expect(
      buildRulesSanctionsSummary({
        ...emptySanctions,
        antiDuplicateEnabled: true,
        linkWarnEnabled: true,
        duplicateMuteEnabled: true,
        textFiltersBanEnabled: true,
      }),
    ).toBe(
      'За повторные нарушения бот может предупредить, временно ограничить сообщения и заблокировать.',
    );
    expect(
      buildRulesSanctionsSummary({
        ...emptySanctions,
        duplicateWarnEnabled: true,
        duplicateMuteEnabled: true,
        duplicateBanEnabled: true,
      }),
    ).toBeNull();
  });
});

describe('shared anti-duplicate rules parity', () => {
  it.each(duplicateRulesCases)('$name', (fixture) => {
    const items = buildRulesTextItemsFromSettings({
      settings: chatSettingsSchema.parse(fixture.settings),
      domains: [],
      requiredSubscriptionChannels: [],
      duplicatePhotoModerationMode: duplicatePhotoModerationModeSchema.parse(fixture.photoMode),
    });
    expect(
      items.filter((line) =>
        /^(Антидубль |Повторы учитываются |Не отправляйте |Одинаковые картинки)/u.test(line),
      ),
    ).toEqual(fixture.expected);
  });
});
