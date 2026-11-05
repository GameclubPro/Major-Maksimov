import { describe, expect, it } from 'vitest';

import {
  applySettingsSectionSchema,
  broadcastHandoffRequestSchema,
  channelSettingsSchema,
  chatRulesSchema,
  MAX_BOT_SPEECH_TEXT_LENGTH,
  MAX_CHAT_RULES_TEXT_LENGTH,
  chatSettingsScreenResponseSchema,
  chatSettingsSchema,
  duplicatePhotoEffectivePolicySchema,
  normalizeHttpButtonUrl,
  sendBroadcastRequestSchema,
  updateChatRulesRequestSchema,
  updateSettingsRequestSchema,
} from '@maxim/contracts';
import { MAX_PUBLICATION_TEXT_LENGTH } from '@maxim/contracts/publication';

describe('message duplicate comparison settings', () => {
  it('defaults to whole-message comparison and accepts explicit caption-only mode', () => {
    expect(chatSettingsSchema.parse({}).duplicateCompareMode).toBe('MESSAGE');
    expect(
      updateSettingsRequestSchema.parse({ duplicateCompareMode: 'TEXT' }).duplicateCompareMode,
    ).toBe('TEXT');
    expect(chatSettingsSchema.safeParse({ duplicateCompareMode: 'ANYTHING' }).success).toBe(false);
  });
});

describe('duplicate daily schedule settings', () => {
  it('preserves interval defaults and accepts daily and overnight periods', () => {
    expect(chatSettingsSchema.parse({})).toMatchObject({
      duplicateWindowMode: 'INTERVAL',
      duplicateStartTimeMinutes: 540,
      duplicateEndTimeMinutes: 1080,
      duplicateTimezone: 'Europe/Moscow',
    });
    for (const [start, end] of [
      [540, 1080],
      [1320, 480],
      [0, 1],
    ]) {
      expect(
        updateSettingsRequestSchema.safeParse({
          duplicateWindowMode: 'DAILY',
          duplicateStartTimeMinutes: start,
          duplicateEndTimeMinutes: end,
        }).success,
      ).toBe(true);
    }
  });
  it.each([
    { duplicateWindowMode: 'OTHER' },
    { duplicateWindowMode: 'DAILY', duplicateStartTimeMinutes: 1080 },
    { duplicateStartTimeMinutes: -1 },
    { duplicateEndTimeMinutes: 1440 },
    { duplicateStartTimeMinutes: 12.5 },
    { duplicateTimezone: 'invalid/zone' },
  ])('rejects ambiguous or invalid time settings %j', (input) => {
    expect(updateSettingsRequestSchema.safeParse(input).success).toBe(false);
  });
});

describe('night mode settings update validation', () => {
  it('keeps opening notice cleanup opt-in and preserves explicit updates', () => {
    expect(chatSettingsSchema.parse({}).nightModeOpenMessageDeleteOnFirstMessageEnabled).toBe(
      false,
    );
    expect(
      updateSettingsRequestSchema.parse({}).nightModeOpenMessageDeleteOnFirstMessageEnabled,
    ).toBe(false);
    for (const enabled of [true, false]) {
      expect(
        updateSettingsRequestSchema.parse({
          nightModeOpenMessageDeleteOnFirstMessageEnabled: enabled,
        }),
      ).toMatchObject({ nightModeOpenMessageDeleteOnFirstMessageEnabled: enabled });
    }
    expect(
      updateSettingsRequestSchema.safeParse({
        nightModeOpenMessageDeleteOnFirstMessageEnabled: 'true',
      }).success,
    ).toBe(false);
  });

  it.each(['nightModeBotMessageEnabled', 'nightModeOpenMessageEnabled'] as const)(
    'keeps an equal-time legacy row readable but rejects saving it with %s',
    (noticeField) => {
      const legacySettings = {
        nightModeEnabled: true,
        nightModeStartTimeMinutes: 23 * 60,
        nightModeEndTimeMinutes: 23 * 60,
        [noticeField]: true,
      };

      expect(chatSettingsSchema.safeParse(legacySettings).success).toBe(true);

      const update = updateSettingsRequestSchema.safeParse(legacySettings);
      expect(update.success).toBe(false);
      if (update.success) {
        throw new Error('Expected equal night mode times with notices to be rejected');
      }
      expect(update.error.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: ['nightModeEndTimeMinutes'],
            message:
              'Для сообщений ночного режима время открытия должно отличаться от времени закрытия.',
          }),
        ]),
      );
    },
  );

  it('allows equal times without boundary notices and distinct times with notices', () => {
    expect(
      updateSettingsRequestSchema.safeParse({
        nightModeEnabled: true,
        nightModeStartTimeMinutes: 8 * 60,
        nightModeEndTimeMinutes: 8 * 60,
      }).success,
    ).toBe(true);
    expect(
      updateSettingsRequestSchema.safeParse({
        nightModeEnabled: true,
        nightModeStartTimeMinutes: 23 * 60,
        nightModeEndTimeMinutes: 8 * 60,
        nightModeBotMessageEnabled: true,
        nightModeOpenMessageEnabled: true,
      }).success,
    ).toBe(true);
  });
});

describe('chatSettingsSchema duplicate flow validation', () => {
  it('normalizes strict HTTP button urls without accepting malformed nested paths', () => {
    expect(normalizeHttpButtonUrl('  https://example.test/open  ')).toBe(
      'https://example.test/open',
    );
    expect(normalizeHttpButtonUrl('HTTPS://EXAMPLE.TEST/a/../open?x=1')).toBe(
      'https://example.test/open?x=1',
    );
    expect(
      normalizeHttpButtonUrl(
        'https://example.test/redirect?next=https%3A%2F%2Fnested.example.test',
      ),
    ).toBe('https://example.test/redirect?next=https%3A%2F%2Fnested.example.test');

    expect(
      normalizeHttpButtonUrl('https://example.test/path https://nested.example.test'),
    ).toBeNull();
    expect(
      normalizeHttpButtonUrl('https://max.ru/chat/example/https://nested.example.test'),
    ).toBeNull();
    expect(
      normalizeHttpButtonUrl('https://max.ru/chat/example/https%3A%2F%2Fnested.example.test'),
    ).toBeNull();
    expect(normalizeHttpButtonUrl(`https://example.test/${'a/../'.repeat(500)}open`)).toBeNull();
    expect(normalizeHttpButtonUrl(`https://example.test/${'я'.repeat(400)}`)).toBeNull();
  });

  it('keeps new chats passive while enabling the Karavan storefront by default', () => {
    const settings = chatSettingsSchema.parse({});
    const enabledBooleanKeys = Object.entries(settings)
      .filter(([, value]) => value === true)
      .map(([key]) => key)
      .sort();

    expect(settings.linkPolicy).toBe('ALERT_ONLY');
    expect(enabledBooleanKeys).toEqual([
      'fileMessagesEnabled',
      'forwardedMessagesEnabled',
      'karavanStorefrontEnabled',
      'phoneNumbersEnabled',
      'photoMessagesEnabled',
      'stickerMessagesEnabled',
      'videoMessagesEnabled',
      'voiceMessagesEnabled',
    ]);
    expect(settings.duplicateDetectionPreset).toBe('STRICT');
    expect(settings.duplicatePhotoEnabled).toBe(false);
    expect(settings.duplicatePhotoMatchPreset).toBe('SAME_IMAGE');
    expect(settings.duplicatePhotoScope).toBe('SAME_AUTHOR');
    expect(settings.messageLimitsImageTextScanEnabled).toBe(false);
    expect(settings.karavanStorefrontEnabled).toBe(true);
    expect(settings.profanitySensitivity).toBe('BALANCED');
  });

  it('accepts an explicit opt-in to scan image text against blocked rules', () => {
    expect(
      chatSettingsSchema.parse({ messageLimitsImageTextScanEnabled: true })
        .messageLimitsImageTextScanEnabled,
    ).toBe(true);
  });

  it('accepts supported profanity sensitivity levels and rejects unknown values', () => {
    for (const profanitySensitivity of ['CORE_ONLY', 'BALANCED', 'STRICT'] as const) {
      expect(chatSettingsSchema.parse({ profanitySensitivity }).profanitySensitivity).toBe(
        profanitySensitivity,
      );
    }

    expect(chatSettingsSchema.safeParse({ profanitySensitivity: 'DISABLED' }).success).toBe(false);
  });

  it('enforces the exported bot-speech text limit', () => {
    expect(
      chatSettingsSchema.safeParse({
        greetingBotMessageText: 'A'.repeat(MAX_BOT_SPEECH_TEXT_LENGTH),
      }).success,
    ).toBe(true);
    expect(
      chatSettingsSchema.safeParse({
        greetingBotMessageText: 'A'.repeat(MAX_BOT_SPEECH_TEXT_LENGTH + 1),
      }).success,
    ).toBe(false);
  });

  it('accepts supported photo duplicate settings and rejects unknown enum values', () => {
    expect(
      chatSettingsSchema.parse({
        duplicatePhotoEnabled: true,
        duplicatePhotoMatchPreset: 'MINOR_EDITS',
        duplicatePhotoScope: 'CHAT',
      }),
    ).toEqual(
      expect.objectContaining({
        duplicatePhotoEnabled: true,
        duplicatePhotoMatchPreset: 'MINOR_EDITS',
        duplicatePhotoScope: 'CHAT',
      }),
    );
    expect(
      chatSettingsSchema.safeParse({ duplicatePhotoMatchPreset: 'CONTENT_SIMILARITY' }).success,
    ).toBe(false);
    expect(chatSettingsSchema.safeParse({ duplicatePhotoScope: 'GLOBAL' }).success).toBe(false);
  });

  it('defaults the public photo moderation mode safely and validates every mode', () => {
    const screen = {
      settings: chatSettingsSchema.parse({}),
      rules: chatRulesSchema.parse({}),
      header: {
        id: 'chat-1',
        title: 'Chat 1',
        entityType: 'chat',
        link: null,
        participantsCount: null,
      },
      domains: [],
    };

    expect(chatSettingsScreenResponseSchema.parse(screen).duplicatePhotoModerationMode).toBe(
      'OBSERVE',
    );
    expect(
      chatSettingsScreenResponseSchema.parse(screen).duplicatePhotoPolicyMatrix,
    ).toBeUndefined();
    for (const mode of ['OFF', 'OBSERVE', 'DELETE_ONLY', 'FULL'] as const) {
      expect(
        chatSettingsScreenResponseSchema.parse({
          ...screen,
          duplicatePhotoModerationMode: mode,
        }).duplicatePhotoModerationMode,
      ).toBe(mode);
    }
    expect(
      chatSettingsScreenResponseSchema.safeParse({
        ...screen,
        duplicatePhotoModerationMode: 'ENFORCE',
      }).success,
    ).toBe(false);

    const policyMatrix = {
      base: {
        moderationMode: 'DELETE_ONLY' as const,
        actionCeiling: 'DELETE_MESSAGE' as const,
        allowedMatchKinds: ['canonical_sha256' as const],
      },
      advanced: {
        moderationMode: 'FULL' as const,
        actionCeiling: 'MUTE' as const,
        allowedMatchKinds: ['canonical_sha256' as const, 'pdq' as const],
      },
    };
    expect(
      chatSettingsScreenResponseSchema.parse({
        ...screen,
        duplicatePhotoPolicyMatrix: policyMatrix,
      }).duplicatePhotoPolicyMatrix,
    ).toEqual(policyMatrix);
    expect(
      chatSettingsScreenResponseSchema.safeParse({
        ...screen,
        duplicatePhotoPolicyMatrix: {
          ...policyMatrix,
          advanced: { ...policyMatrix.advanced, actionCeiling: 'KICK' },
        },
      }).success,
    ).toBe(false);
    for (const invalidPolicy of [
      {
        moderationMode: 'FULL',
        actionCeiling: 'DELETE_MESSAGE',
        allowedMatchKinds: ['canonical_sha256'],
      },
      {
        moderationMode: 'DELETE_ONLY',
        actionCeiling: 'DELETE_MESSAGE',
        allowedMatchKinds: [],
      },
      {
        moderationMode: 'DELETE_ONLY',
        actionCeiling: 'DELETE_MESSAGE',
        allowedMatchKinds: ['platform_id'],
      },
      {
        moderationMode: 'FULL',
        actionCeiling: 'BAN',
        allowedMatchKinds: ['platform_id'],
      },
      {
        moderationMode: 'FULL',
        actionCeiling: 'MUTE',
        allowedMatchKinds: ['canonical_sha256', 'canonical_sha256'],
      },
    ]) {
      expect(
        chatSettingsScreenResponseSchema.safeParse({
          ...screen,
          duplicatePhotoPolicyMatrix: {
            ...policyMatrix,
            advanced: invalidPolicy,
          },
        }).success,
      ).toBe(false);
    }

    expect(
      duplicatePhotoEffectivePolicySchema.parse({
        moderationMode: 'OBSERVE',
        actionCeiling: 'BAN',
        allowedMatchKinds: ['platform_id'],
      }),
    ).toEqual({
      moderationMode: 'OBSERVE',
      actionCeiling: 'BAN',
      allowedMatchKinds: ['platform_id'],
    });
    for (const allowedMatchKinds of [
      ['canonical_sha256'],
      ['pdq'],
      ['platform_id', 'canonical_sha256'],
    ] as const) {
      expect(
        duplicatePhotoEffectivePolicySchema.safeParse({
          moderationMode: 'DELETE_ONLY',
          actionCeiling: 'DELETE_MESSAGE',
          allowedMatchKinds,
        }).success,
      ).toBe(true);
    }
  });

  it('keeps every channel automation toggle disabled by default', () => {
    const settings = channelSettingsSchema.parse({});
    const enabledBooleanKeys = Object.entries(settings)
      .filter(([, value]) => value === true)
      .map(([key]) => key);

    expect(enabledBooleanKeys).toEqual([]);
  });

  it('strips the retired channel button mode while preserving feature toggles', () => {
    const settings = channelSettingsSchema.parse({
      autoPostButtonsMode: 'OFF',
      commentsEnabled: true,
      postSuggestionsEnabled: false,
    }) as Record<string, unknown>;

    expect(settings).not.toHaveProperty('autoPostButtonsMode');
    expect(settings.commentsEnabled).toBe(true);
    expect(settings.postSuggestionsEnabled).toBe(false);
  });

  it('strips retired thematic settings and rejects their apply section', () => {
    const settings = chatSettingsSchema.parse({
      thematicCodewordEnabled: true,
      thematicCodeword: 'legacy',
      thematicFiltersWarnEnabled: true,
    }) as Record<string, unknown>;

    expect(settings).not.toHaveProperty('thematicCodewordEnabled');
    expect(settings).not.toHaveProperty('thematicCodeword');
    expect(settings).not.toHaveProperty('thematicFiltersWarnEnabled');
    expect(applySettingsSectionSchema.safeParse('thematicFilters').success).toBe(false);
  });

  it('supports the Karavan storefront setting and section', () => {
    expect(chatSettingsSchema.parse({ karavanStorefrontEnabled: true })).toEqual(
      expect.objectContaining({ karavanStorefrontEnabled: true }),
    );
    expect(applySettingsSectionSchema.safeParse('storefront').success).toBe(true);
  });

  it('allows duplicate thresholds to start from the first duplicate', () => {
    const result = chatSettingsSchema.safeParse({
      antiDuplicateEnabled: true,
      duplicateBotMessageEnabled: false,
      duplicateWarnEnabled: true,
      duplicateWarnMaxCount: 1,
      duplicateMuteEnabled: true,
      duplicateMuteMaxCount: 2,
      duplicateBanEnabled: true,
      duplicateBanMaxCount: 3,
    });

    expect(result.success).toBe(true);
  });

  it('does not require BAN thresholds to stay above MUTE thresholds', () => {
    const result = chatSettingsSchema.safeParse({
      antiDuplicateEnabled: true,
      duplicateWarnEnabled: false,
      duplicateMuteEnabled: true,
      duplicateBanEnabled: true,
      duplicateMuteWindowSec: 48 * 60 * 60,
      duplicateMuteMaxCount: 6,
      duplicateBanWindowSec: 24 * 60 * 60,
      duplicateBanMaxCount: 4,
    });

    expect(result.success).toBe(true);
  });

  it('normalizes stored multi-button arrays and syncs the legacy greeting fields', () => {
    const result = chatSettingsSchema.parse({
      greetingEnabled: true,
      greetingBotMessageEnabled: true,
      greetingBotButtonEnabled: true,
      greetingBotButtons: [
        {
          text: ' Открыть канал ',
          url: 'https://max.ru/channel/maxim ',
        },
        {
          text: 'Профиль',
          url: 'https://max.ru/profile/maxim',
        },
      ],
    });

    expect(result.greetingBotButtons).toEqual([
      { text: 'Открыть канал', url: 'https://max.ru/channel/maxim' },
      { text: 'Профиль', url: 'https://max.ru/profile/maxim' },
    ]);
    expect(result.greetingBotButtonUrl).toBe('https://max.ru/channel/maxim');
    expect(result.greetingBotButtonText).toBe('Открыть канал');
  });

  it('keeps legacy button fields compatible when the stored array is empty', () => {
    const result = chatSettingsSchema.parse({
      textFiltersBotMessageEnabled: true,
      textFiltersBotButtonEnabled: true,
      textFiltersBotButtonUrl: ' https://max.ru/channel/rules ',
      textFiltersBotButtonText: ' Правила ',
      textFiltersBotButtons: [],
    });

    expect(result.textFiltersBotButtons).toEqual([
      { text: 'Правила', url: 'https://max.ru/channel/rules' },
    ]);
    expect(result.textFiltersBotButtonUrl).toBe('https://max.ru/channel/rules');
    expect(result.textFiltersBotButtonText).toBe('Правила');
  });

  it.each([
    'https://max.ru/id613002203036_bot?start=pmh-chat-user',
    'https://max.ru/id613002203036_bot?start=pm2_chat-1_h_admin-1_abcdef0123456789',
  ])(
    'allows profile handoff links only for the dedicated admin contact button: %s',
    (profileHandoffUrl) => {
      const adminContactSettings = chatSettingsSchema.parse({
        linkAdminContactButtonEnabled: true,
        linkAdminContactButtonUrl: profileHandoffUrl,
      });

      expect(adminContactSettings.linkAdminContactButtonUrl).toBe(profileHandoffUrl);

      const genericButtonResult = chatSettingsSchema.safeParse({
        linkBotMessageEnabled: true,
        linkBotButtonEnabled: true,
        linkBotButtonUrl: profileHandoffUrl,
        linkBotButtonText: 'Связь с админом',
      });

      expect(genericButtonResult.success).toBe(false);
    },
  );

  it('keeps bot speech media as a per-message image map', () => {
    const result = chatSettingsSchema.parse({
      botSpeechMedia: {
        messageLimitsBotMessageText: {
          base64: ' YQ== ',
          mimeType: ' image/png ',
          fileName: ' warning.png ',
        },
      },
    });

    expect(result.botSpeechMedia).toEqual({
      messageLimitsBotMessageText: {
        base64: 'YQ==',
        mimeType: 'image/png',
        fileName: 'warning.png',
      },
    });
  });

  it('normalizes required subscription state from selected sources', () => {
    const enabled = chatSettingsSchema.parse({
      requiredSubscriptionEnabled: false,
      requiredSubscriptionChannelIds: [' channel-1 ', 'channel-1'],
      requiredSubscriptionExpiresAt: '2026-03-16T09:00:00.000Z',
    });
    const disabled = chatSettingsSchema.parse({
      requiredSubscriptionEnabled: true,
      requiredSubscriptionChannelIds: [],
      requiredSubscriptionExpiresAt: '2026-03-16T09:00:00.000Z',
    });

    expect(enabled.requiredSubscriptionEnabled).toBe(true);
    expect(enabled.requiredSubscriptionChannelIds).toEqual(['channel-1']);
    expect(enabled.requiredSubscriptionExpiresAt).toBe('');
    expect(disabled.requiredSubscriptionEnabled).toBe(false);
    expect(disabled.requiredSubscriptionChannelIds).toEqual([]);
    expect(disabled.requiredSubscriptionExpiresAt).toBe('');
  });

  it('keeps per-chat admin command names normalized', () => {
    const defaults = chatSettingsSchema.parse({});
    const customized = chatSettingsSchema.parse({
      adminBanCommandName: ' бан ',
      adminBanAllCommandName: ' Бан! ',
      adminMuteCommandName: ' тихий   час ',
      adminPermanentMuteCommandName: ' мут   навсегда ',
      adminRulesCommandName: ' регламент ',
      adminSilenceCommandName: ' режим   тишины ',
      adminOpenChatCommandName: ' открыть   чат ',
    });

    expect(defaults.adminBanCommandName).toBe('бан');
    expect(defaults.adminBanAllCommandName).toBe('Бан!');
    expect(defaults.adminMuteCommandName).toBe('мут');
    expect(defaults.adminPermanentMuteCommandName).toBe('мут 88');
    expect(defaults.adminRulesCommandName).toBe('правило');
    expect(defaults.adminSilenceCommandName).toBe('тишина');
    expect(defaults.adminOpenChatCommandName).toBe('тишина выкл');
    expect(customized.adminBanCommandName).toBe('бан');
    expect(customized.adminBanAllCommandName).toBe('Бан!');
    expect(customized.adminMuteCommandName).toBe('тихий час');
    expect(customized.adminPermanentMuteCommandName).toBe('мут навсегда');
    expect(customized.adminRulesCommandName).toBe('регламент');
    expect(customized.adminSilenceCommandName).toBe('режим тишины');
    expect(customized.adminOpenChatCommandName).toBe('открыть чат');
  });

  it('rejects duplicate per-chat admin command names', () => {
    const result = chatSettingsSchema.safeParse({
      adminBanCommandName: 'мера',
      adminOpenChatCommandName: ' мера ',
    });

    expect(result.success).toBe(false);
  });

  it('rejects per-chat admin command names that only differ by case', () => {
    const result = chatSettingsSchema.safeParse({
      adminBanCommandName: 'бан',
      adminBanAllCommandName: 'БАН',
    });

    expect(result.success).toBe(false);
  });

  it('rejects case-only duplicates for case-insensitive admin commands', () => {
    const result = chatSettingsSchema.safeParse({
      adminBanCommandName: 'мут',
      adminMuteCommandName: 'МУТ',
    });

    expect(result.success).toBe(false);
  });

  it('allows local and all-chat ban commands to differ by an exclamation mark', () => {
    const result = chatSettingsSchema.safeParse({
      adminBanCommandName: 'мера',
      adminBanAllCommandName: 'мера!',
    });

    expect(result.success).toBe(true);
  });

  it('rejects hidden per-chat admin command conflicts with punctuation shortcuts', () => {
    const result = chatSettingsSchema.safeParse({
      adminMuteCommandName: 'мера',
      adminRulesCommandName: 'мера!',
    });

    expect(result.success).toBe(false);
  });

  it('rejects admin command names reserved by hardcoded bot commands', () => {
    const result = chatSettingsSchema.safeParse({
      adminBanCommandName: 'супер бан',
    });

    expect(result.success).toBe(false);
  });

  it('rejects bot speech media with non-image mime type', () => {
    const result = chatSettingsSchema.safeParse({
      botSpeechMedia: {
        messageLimitsWarnMessageText: {
          base64: 'YQ==',
          mimeType: 'application/pdf',
          fileName: 'notice.pdf',
        },
      },
    });

    expect(result.success).toBe(false);
  });
});

describe('updateChatRulesRequestSchema button normalization', () => {
  it('tracks the plain or markdown source format like Publik', () => {
    expect(chatRulesSchema.parse({ text: '**legacy markdown**' }).textFormat).toBe('markdown');
    expect(
      updateChatRulesRequestSchema.parse({
        text: '**literal plain text**',
        textFormat: 'plain',
      }).textFormat,
    ).toBe('plain');
  });

  it('accepts rules up to the same text limit as Publik', () => {
    expect(MAX_CHAT_RULES_TEXT_LENGTH).toBe(MAX_PUBLICATION_TEXT_LENGTH);
    expect(
      updateChatRulesRequestSchema.safeParse({
        text: 'A'.repeat(MAX_CHAT_RULES_TEXT_LENGTH),
      }).success,
    ).toBe(true);
    expect(
      updateChatRulesRequestSchema.safeParse({
        text: 'A'.repeat(MAX_CHAT_RULES_TEXT_LENGTH + 1),
      }).success,
    ).toBe(false);
  });

  it('normalizes multi-button rules payloads and keeps legacy fields in sync', () => {
    const result = updateChatRulesRequestSchema.parse({
      text: 'Правила чата',
      autoTextEnabled: false,
      imageBase64: '',
      imageMimeType: '',
      imageFileName: '',
      buttonEnabled: true,
      buttons: [
        { text: ' Открыть чат ', url: 'https://max.ru/channel/team ' },
        { text: 'MAX', url: 'https://max.ru/' },
      ],
    });

    expect(result.buttons).toEqual([
      { text: 'Открыть чат', url: 'https://max.ru/channel/team' },
      { text: 'MAX', url: 'https://max.ru/' },
    ]);
    expect(result.buttonUrl).toBe('https://max.ru/channel/team');
    expect(result.buttonText).toBe('Открыть чат');
  });

  it.each([
    'https://max.ru/id613002203036_bot?start=pmh-chat-user',
    'https://max.ru/id613002203036_bot?start=pm2_chat-1_h_admin-1_abcdef0123456789',
  ])(
    'allows profile handoff links for the dedicated rules admin contact button: %s',
    (profileHandoffUrl) => {
      const result = updateChatRulesRequestSchema.parse({
        text: 'Правила чата',
        adminContactButtonEnabled: true,
        adminContactButtonUrl: profileHandoffUrl,
      });

      expect(result.adminContactButtonUrl).toBe(profileHandoffUrl);

      const genericButtonResult = updateChatRulesRequestSchema.safeParse({
        text: 'Правила чата',
        buttonEnabled: true,
        buttonUrl: profileHandoffUrl,
        buttonText: 'Связь с админом',
      });

      expect(genericButtonResult.success).toBe(false);
    },
  );
});

describe('broadcast request schema normalization', () => {
  it('keeps audience, buttons, and legacy cycle fields aligned for send and handoff payloads', () => {
    const sendPayload = sendBroadcastRequestSchema.parse({
      text: 'Анонс',
      targetChatIds: [' chat-2 ', 'chat-1', 'chat-2'],
      buttonEnabled: true,
      buttonUrl: ' https://max.ru/channel/maxim ',
      buttonText: ' Читать ',
      cycleEnabled: true,
      cycleEveryDays: 2,
      cycleCount: 3,
    });
    const handoffPayload = broadcastHandoffRequestSchema.parse({
      targetChatIds: [' chat-2 ', 'chat-1', 'chat-2'],
      buttonEnabled: true,
      buttonUrl: ' https://max.ru/channel/maxim ',
      buttonText: ' Читать ',
      cycleEnabled: true,
      cycleEveryDays: 2,
      cycleCount: 3,
    });

    for (const payload of [sendPayload, handoffPayload]) {
      expect(payload.targetMode).toBe('selected');
      expect(payload.targetChatIds).toEqual(['chat-2', 'chat-1']);
      expect(payload.applyToAllChats).toBe(false);
      expect(payload.buttons).toEqual([{ text: 'Читать', url: 'https://max.ru/channel/maxim' }]);
      expect(payload.buttonEnabled).toBe(true);
      expect(payload.buttonUrl).toBe('https://max.ru/channel/maxim');
      expect(payload.buttonText).toBe('Читать');
      expect(payload.cycleEveryHours).toBe(48);
    }
  });

  it('canonicalizes calendar slots and preserves handoff conflict replacement flag', () => {
    const sendPayload = sendBroadcastRequestSchema.parse({
      text: 'Анонс',
      scheduleMode: 'calendar',
      scheduleTimezone: 'Europe/Moscow',
      scheduledSlots: [
        '2026-03-03T12:00:00.000Z',
        '2026-03-03T12:00:00Z',
        '2026-03-03T13:00:00.000Z',
      ],
    });
    const handoffPayload = broadcastHandoffRequestSchema.parse({
      scheduleMode: 'calendar',
      scheduleTimezone: 'Europe/Moscow',
      scheduledSlots: ['2026-03-03T12:00:00Z', '2026-03-03T12:00:00.000Z'],
      replaceConflictingSlots: true,
    });

    expect(sendPayload.scheduledSlots).toEqual([
      '2026-03-03T12:00:00.000Z',
      '2026-03-03T13:00:00.000Z',
    ]);
    expect(handoffPayload.scheduledSlots).toEqual(['2026-03-03T12:00:00.000Z']);
    expect(handoffPayload.replaceConflictingSlots).toBe(true);
  });

  it('accepts ISO datetimes with offsets and rejects ambiguous dates', () => {
    const offsetPayload = sendBroadcastRequestSchema.parse({
      text: 'Анонс',
      scheduleMode: 'calendar',
      scheduledSlots: ['2026-03-03T15:00:00+03:00'],
    });

    expect(offsetPayload.scheduledSlots).toEqual(['2026-03-03T12:00:00.000Z']);
    expect(
      sendBroadcastRequestSchema.safeParse({
        text: 'Анонс',
        sendAt: '2026-03-03',
      }).success,
    ).toBe(false);
  });

  it('clears inactive schedule fields for every broadcast schedule mode', () => {
    const legacyPayload = sendBroadcastRequestSchema.parse({
      text: 'Анонс',
      scheduleMode: 'legacy',
      scheduledSlots: ['2026-03-03T12:00:00.000Z'],
      replaceConflictingSlots: true,
      sendAt: '2026-03-03T11:00:00.000Z',
      cycleEnabled: false,
      cycleEveryHours: 4,
      cycleCount: 5,
    });
    const calendarPayload = sendBroadcastRequestSchema.parse({
      text: 'Анонс',
      scheduleMode: 'calendar',
      scheduledSlots: ['2026-03-03T12:00:00.000Z'],
      replaceConflictingSlots: true,
      sendAt: '2026-03-03T11:00:00.000Z',
      cycleEnabled: true,
      cycleEveryHours: 4,
      cycleCount: 5,
    });
    const cyclePayload = sendBroadcastRequestSchema.parse({
      text: 'Анонс',
      scheduleMode: 'legacy',
      scheduledSlots: ['2026-03-03T12:00:00.000Z'],
      replaceConflictingSlots: true,
      sendAt: '2026-03-03T11:00:00.000Z',
      cycleEnabled: true,
      cycleEveryHours: 4,
      cycleCount: 5,
    });

    expect(legacyPayload).toEqual(
      expect.objectContaining({
        sendAt: '2026-03-03T11:00:00.000Z',
        scheduledSlots: [],
        replaceConflictingSlots: false,
        cycleEnabled: false,
        cycleEveryHours: 1,
        cycleCount: 1,
      }),
    );
    expect(calendarPayload).toEqual(
      expect.objectContaining({
        sendAt: null,
        scheduledSlots: ['2026-03-03T12:00:00.000Z'],
        replaceConflictingSlots: true,
        cycleEnabled: false,
        cycleEveryHours: 1,
        cycleCount: 1,
      }),
    );
    expect(cyclePayload).toEqual(
      expect.objectContaining({
        sendAt: '2026-03-03T11:00:00.000Z',
        scheduledSlots: [],
        replaceConflictingSlots: false,
        cycleEnabled: true,
        cycleEveryHours: 4,
        cycleCount: 5,
      }),
    );
  });

  it('infers calendar mode from legacy payloads that contain scheduled slots', () => {
    const sendPayload = sendBroadcastRequestSchema.parse({
      text: 'Анонс',
      scheduledSlots: ['2026-03-03T12:00:00.000Z'],
      sendAt: '2026-03-03T11:00:00.000Z',
      cycleEnabled: true,
      cycleEveryHours: 4,
      cycleCount: 5,
    });
    const explicitLegacyPayload = sendBroadcastRequestSchema.parse({
      text: 'Анонс',
      scheduleMode: 'legacy',
      scheduledSlots: ['2026-03-03T12:00:00.000Z'],
      sendAt: '2026-03-03T11:00:00.000Z',
    });

    expect(sendPayload).toEqual(
      expect.objectContaining({
        scheduleMode: 'calendar',
        sendAt: null,
        scheduledSlots: ['2026-03-03T12:00:00.000Z'],
        cycleEnabled: false,
        cycleEveryHours: 1,
        cycleCount: 1,
      }),
    );
    expect(explicitLegacyPayload).toEqual(
      expect.objectContaining({
        scheduleMode: 'legacy',
        sendAt: '2026-03-03T11:00:00.000Z',
        scheduledSlots: [],
      }),
    );
  });

  it('rejects cycles outside the shared 31-day schedule window', () => {
    const result = sendBroadcastRequestSchema.safeParse({
      text: 'Анонс',
      cycleEnabled: true,
      cycleEveryHours: 24,
      cycleCount: 33,
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map((issue) => issue.path.join('.'))).toContain('cycleCount');
    }
  });

  it('rejects invalid broadcast schedule timezones', () => {
    for (const schema of [sendBroadcastRequestSchema, broadcastHandoffRequestSchema]) {
      const result = schema.safeParse({
        text: 'Анонс',
        scheduleMode: 'calendar',
        scheduleTimezone: 'Mars/Olympus',
        scheduledSlots: ['2026-03-03T12:00:00.000Z'],
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues.map((issue) => issue.path.join('.'))).toContain(
          'scheduleTimezone',
        );
      }
    }
  });

  it('requires a MAX attachment token for video payloads', () => {
    expect(
      sendBroadcastRequestSchema.safeParse({
        text: '',
        mediaType: 'video',
        mediaPayload: { foo: 'bar' },
      }).success,
    ).toBe(false);

    const result = sendBroadcastRequestSchema.parse({
      text: '',
      mediaType: 'video',
      mediaPayload: { token: ' video-token-1 ' },
      mediaMimeType: 'video/mp4',
      mediaFileName: 'clip.mp4',
    });

    expect(result.mediaType).toBe('video');
    expect(result.mediaPayload).toEqual({ token: 'video-token-1' });
    expect(result.images).toEqual([]);
  });

  it('deduplicates repeated broadcast images before storing media payloads', () => {
    const singleImage = {
      base64: 'photo-1',
      mimeType: ' image/jpeg ',
      fileName: ' one.jpg ',
    };
    const singleResult = sendBroadcastRequestSchema.parse({
      text: '',
      images: [singleImage, { ...singleImage, fileName: 'copy.jpg' }],
    });

    expect(singleResult.imageEnabled).toBe(true);
    expect(singleResult.images).toEqual([
      { base64: 'photo-1', mimeType: 'image/jpeg', fileName: 'one.jpg' },
    ]);
    expect(singleResult.mediaType).toBeNull();
    expect(singleResult.mediaPayload).toBeNull();

    const galleryResult = sendBroadcastRequestSchema.parse({
      text: '',
      images: [
        singleImage,
        { base64: 'photo-2', mimeType: 'image/jpeg', fileName: 'two.jpg' },
        { ...singleImage, fileName: 'copy.jpg' },
      ],
    });

    expect(galleryResult.images).toEqual([
      { base64: 'photo-1', mimeType: 'image/jpeg', fileName: 'one.jpg' },
      { base64: 'photo-2', mimeType: 'image/jpeg', fileName: 'two.jpg' },
    ]);
    expect(galleryResult.mediaType).toBe('image');
    expect(galleryResult.mediaPayload).toEqual({ images: galleryResult.images });
  });

  it('uses shared validation for selected audience and calendar slots', () => {
    for (const schema of [sendBroadcastRequestSchema, broadcastHandoffRequestSchema]) {
      const result = schema.safeParse({
        text: 'Анонс',
        targetMode: 'selected',
        targetChatIds: [],
        scheduleMode: 'calendar',
        scheduledSlots: [],
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues.map((issue) => issue.path.join('.'))).toEqual(
          expect.arrayContaining(['targetChatIds', 'scheduledSlots']),
        );
      }
    }
  });
});
