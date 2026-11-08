import assert from 'node:assert/strict';
import test from 'node:test';
import { chatSettingsSchema, type ChatSettings } from '@maxim/contracts';
import { stopWordsPolicySchema } from '@maxim/contracts/settings';
import {
  BOT_SPEECH_SYNC_SETTING_KEYS,
  NIGHT_SECTION_SETTING_KEYS,
  SECTION_SETTING_KEYS,
  applyDefaultSanctionStages,
  applyNightModeBotMessageEnabledChange,
  applyNightModeEnabledChange,
  applyRequiredSubscriptionChannelAddition,
  hasSectionBotSpeechMediaChanges,
  hasSectionSettingChanges,
  mergeBotSpeechStyleSettings,
  rebaseSettingsAfterBotSpeechStyleSave,
  mergeNightSectionSettings,
  mergeSectionSettings,
  mergeSectionSettingsAfterSave,
  normalizeSectionDraftSettings,
  serializeChatSettingsDraft,
  shouldHydrateSettingsDraftFromServer,
} from '../src/pages/settings-page-state';

function createSettings(overrides: Partial<ChatSettings> = {}): ChatSettings {
  return {
    ...chatSettingsSchema.parse({}),
    ...overrides,
  };
}

test('phone section saves the same actions as Limits and leaves retired fields untouched', () => {
  const saved = createSettings({ phoneNumbersBotMessageEnabled: false });
  const draft = createSettings({
    phoneNumbersEnabled: false,
    messageLimitsBotMessageEnabled: true,
    messageLimitsWarnEnabled: true,
    messageLimitsBotMessageText: 'Общее объяснение',
  });
  assert.equal(hasSectionSettingChanges(draft, saved, 'phones'), true);
  const merged = mergeSectionSettings(saved, draft, 'phones');
  assert.equal(merged.phoneNumbersEnabled, false);
  assert.equal(merged.messageLimitsBotMessageEnabled, true);
  assert.equal(merged.messageLimitsWarnEnabled, true);
  assert.equal(merged.messageLimitsBotMessageText, 'Общее объяснение');
  assert.equal(merged.phoneNumbersBotMessageEnabled, false);
});

test('retired message comparison mode does not dirty or overwrite the duplicate section', () => {
  const saved = createSettings({ duplicateCompareMode: 'MESSAGE' });
  const draft = createSettings({ duplicateCompareMode: 'TEXT' });
  assert.equal(hasSectionSettingChanges(draft, saved, 'duplicates'), false);
  assert.equal(mergeSectionSettings(saved, draft, 'duplicates').duplicateCompareMode, 'MESSAGE');
  assert.equal(mergeSectionSettings(saved, draft, 'links').duplicateCompareMode, 'MESSAGE');
});

test('settings polling preserves a locally edited draft', () => {
  const previousServerDraft = createSettings({ antiDuplicateEnabled: false });
  const currentDraft = createSettings({ antiDuplicateEnabled: true });
  const nextServerDraft = createSettings({ antiSpamEnabled: true });

  assert.equal(
    shouldHydrateSettingsDraftFromServer(
      serializeChatSettingsDraft(currentDraft),
      serializeChatSettingsDraft(previousServerDraft),
      serializeChatSettingsDraft(nextServerDraft),
    ),
    false,
  );
});

test('revision metadata does not dirty settings and a section save retains its returned write fence', () => {
  const original = createSettings({ settingsRevision: '2026-10-01T09:00:00.000Z' });
  const saved = createSettings({ settingsRevision: '2026-10-01T10:00:00.000Z' });
  assert.equal(serializeChatSettingsDraft(original), serializeChatSettingsDraft(saved));
  assert.equal(hasSectionSettingChanges(original, saved, 'commercialFilter'), false);
  assert.equal(
    mergeSectionSettings(original, saved, 'commercialFilter').settingsRevision,
    saved.settingsRevision,
  );
});

test('resolving a commercial conflict retains the original revision of other dirty sections', () => {
  const draft = createSettings({
    settingsRevision: '2026-10-01T09:00:00.000Z',
    commercialAdsFilterEnabled: true,
    russianProfanityFilterEnabled: true,
  });
  const saved = createSettings({
    settingsRevision: '2026-10-01T10:01:00.000Z',
    commercialAdsFilterEnabled: true,
    russianProfanityFilterEnabled: false,
  });
  const next = mergeSectionSettingsAfterSave(
    draft,
    saved,
    'commercialFilter',
    '2026-10-01T10:00:00.000Z',
  );
  assert.equal(next.russianProfanityFilterEnabled, true);
  assert.equal(next.settingsRevision, draft.settingsRevision);
  assert.equal(
    mergeSectionSettingsAfterSave(draft, saved, 'commercialFilter', draft.settingsRevision)
      .settingsRevision,
    saved.settingsRevision,
  );
});

test('settings polling hydrates the first or locally clean server snapshot', () => {
  const previousServerDraft = createSettings({ antiDuplicateEnabled: false });
  const nextServerDraft = createSettings({ antiDuplicateEnabled: true });

  assert.equal(
    shouldHydrateSettingsDraftFromServer(
      serializeChatSettingsDraft(previousServerDraft),
      serializeChatSettingsDraft(previousServerDraft),
      serializeChatSettingsDraft(nextServerDraft),
    ),
    true,
  );
  assert.equal(
    shouldHydrateSettingsDraftFromServer(
      serializeChatSettingsDraft(createSettings({ antiSpamEnabled: true })),
      '',
      serializeChatSettingsDraft(nextServerDraft),
    ),
    true,
  );
});

test('applyNightModeEnabledChange enables bot notice and clears dependent toggles on disable', () => {
  const enabled = applyNightModeEnabledChange(createSettings(), true);
  assert.equal(enabled.nightModeEnabled, true);
  assert.equal(enabled.nightModeBotMessageEnabled, true);

  const disabled = applyNightModeEnabledChange(
    createSettings({
      nightModeEnabled: true,
      nightModeBotMessageEnabled: true,
      nightModeCommentsEnabled: true,
      nightModeBotButtonEnabled: true,
      nightModeRulesButtonEnabled: true,
    }),
    false,
  );
  assert.equal(disabled.nightModeEnabled, false);
  assert.equal(disabled.nightModeBotMessageEnabled, false);
  assert.equal(disabled.nightModeCommentsEnabled, false);
  assert.equal(disabled.nightModeBotButtonEnabled, false);
  assert.equal(disabled.nightModeRulesButtonEnabled, false);
});

test('applyNightModeBotMessageEnabledChange clears dependent toggles when bot notice is disabled', () => {
  const next = applyNightModeBotMessageEnabledChange(
    createSettings({
      nightModeBotMessageEnabled: true,
      nightModeCommentsEnabled: true,
      nightModeBotButtonEnabled: true,
      nightModeRulesButtonEnabled: true,
    }),
    false,
  );

  assert.equal(next.nightModeBotMessageEnabled, false);
  assert.equal(next.nightModeCommentsEnabled, false);
  assert.equal(next.nightModeBotButtonEnabled, false);
  assert.equal(next.nightModeRulesButtonEnabled, false);
});

test('applyDefaultSanctionStages enables explanation, warning, and mute without enabling ban', () => {
  const cases = [
    {
      group: 'duplicate' as const,
      keys: ['duplicateBotMessageEnabled', 'duplicateWarnEnabled', 'duplicateMuteEnabled'] as const,
      banKey: 'duplicateBanEnabled' as const,
    },
    {
      group: 'invitationAccess' as const,
      keys: [
        'invitationAccessBotMessageEnabled',
        'invitationAccessWarnEnabled',
        'invitationAccessMuteEnabled',
      ] as const,
      banKey: 'invitationAccessBanEnabled' as const,
    },
    {
      group: 'link' as const,
      keys: ['linkBotMessageEnabled', 'linkWarnEnabled', 'linkMuteEnabled'] as const,
      banKey: 'linkBanEnabled' as const,
    },
    {
      group: 'messageLimits' as const,
      keys: [
        'messageLimitsBotMessageEnabled',
        'messageLimitsWarnEnabled',
        'messageLimitsMuteEnabled',
      ] as const,
      banKey: 'messageLimitsBanEnabled' as const,
    },
    {
      group: 'profanity' as const,
      keys: ['profanityBotMessageEnabled', 'profanityWarnEnabled', 'profanityMuteEnabled'] as const,
      banKey: 'profanityBanEnabled' as const,
    },
    {
      group: 'requiredSubscription' as const,
      keys: [
        'requiredSubscriptionBotMessageEnabled',
        'requiredSubscriptionWarnEnabled',
        'requiredSubscriptionMuteEnabled',
      ] as const,
      banKey: 'requiredSubscriptionBanEnabled' as const,
    },
    {
      group: 'textFilters' as const,
      keys: [
        'textFiltersBotMessageEnabled',
        'textFiltersWarnEnabled',
        'textFiltersMuteEnabled',
      ] as const,
      banKey: 'textFiltersBanEnabled' as const,
    },
  ];

  for (const { banKey, group, keys } of cases) {
    const next = applyDefaultSanctionStages(createSettings(), group);
    for (const key of keys) {
      assert.equal(next[key], true);
    }
    assert.equal(next[banKey], false);
  }
});

test('applyRequiredSubscriptionChannelAddition applies the sanction preset to the first source', () => {
  const next = applyRequiredSubscriptionChannelAddition(createSettings(), 'channel-1', 10);

  assert.deepEqual(next.requiredSubscriptionChannelIds, ['channel-1']);
  assert.equal(next.requiredSubscriptionEnabled, true);
  assert.equal(next.requiredSubscriptionBotMessageEnabled, true);
  assert.equal(next.requiredSubscriptionWarnEnabled, true);
  assert.equal(next.requiredSubscriptionMuteEnabled, true);
  assert.equal(next.requiredSubscriptionBanEnabled, false);

  assert.equal(applyRequiredSubscriptionChannelAddition(next, 'channel-1', 10), next);
  assert.equal(applyRequiredSubscriptionChannelAddition(next, 'channel-2', 1), next);
});

test('mergeBotSpeechStyleSettings changes only the inherited base style', () => {
  assert.deepEqual(BOT_SPEECH_SYNC_SETTING_KEYS, ['botSpeechStyle']);
  const current = createSettings({
    botSpeechStyle: 'POLICE',
    linkBotMessageText: '  Свой текст.\n',
    messageLimitsWarnMessageText: '   ',
    botSpeechMedia: {
      linkBotMessageText: {
        base64: 'custom-image',
        mimeType: 'image/jpeg',
        fileName: 'custom.jpg',
      },
    },
  });
  const saved = createSettings({
    botSpeechStyle: 'FRIENDLY',
    linkBotMessageText: 'Текст из ответа',
    messageLimitsWarnMessageText: 'Другой текст из ответа',
    botSpeechMedia: {},
  });

  const merged = mergeBotSpeechStyleSettings(current, saved);

  assert.equal(merged.botSpeechStyle, 'FRIENDLY');
  assert.equal(merged.linkBotMessageText, '  Свой текст.\n');
  assert.equal(merged.messageLimitsWarnMessageText, '   ');
  assert.deepEqual(merged.botSpeechMedia, current.botSpeechMedia);
});

test('a style receipt preserves all draft bytes without promoting an incomplete baseline revision', () => {
  const current = createSettings({
    settingsRevision: '2026-10-04T09:00:00.000Z',
    greetingBotMessageText: '  **Свой текст** {user}\r\n ',
    linkWarnMessageText: '   ',
  });
  const receipt = {
    botSpeechStyle: 'IRONIC' as const,
    settingsRevision: '2026-10-04T10:00:00.000Z',
  };
  assert.deepEqual(mergeBotSpeechStyleSettings(current, receipt), {
    ...current,
    botSpeechStyle: receipt.botSpeechStyle,
  });
});

test('style refresh rebases remote edits while preserving local text, image and unrelated drafts', () => {
  const baseline = createSettings({ settingsRevision: '2026-10-04T09:00:00.000Z' });
  const image = { base64: 'local-image', mimeType: 'image/jpeg' as const, fileName: 'mine.jpg' };
  const current = {
    ...baseline,
    greetingBotMessageText: '  **Локальный** {user}\r\n ',
    nightModeStartTimeMinutes: 600,
    botSpeechMedia: { greetingBotMessageText: image },
  };
  const fresh = {
    ...baseline,
    botSpeechStyle: 'IRONIC' as const,
    linkBotMessageText: '  Изменение другого администратора\n',
    settingsRevision: '2026-10-04T10:00:00.000Z',
  };
  const rebased = rebaseSettingsAfterBotSpeechStyleSave(current, baseline, fresh);
  assert.equal(rebased.greetingBotMessageText, current.greetingBotMessageText);
  assert.equal(rebased.botSpeechMedia.greetingBotMessageText, image);
  assert.equal(rebased.nightModeStartTimeMinutes, 600);
  assert.equal(rebased.linkBotMessageText, fresh.linkBotMessageText);
  assert.equal(rebased.botSpeechStyle, fresh.botSpeechStyle);
  assert.equal(rebased.settingsRevision, fresh.settingsRevision);
});

test('style refresh cannot bless a conflicting custom message or image with the new revision', () => {
  const baseline = createSettings({ settingsRevision: '2026-10-04T09:00:00.000Z' });
  for (const key of ['greetingBotMessageText', 'botSpeechMedia'] as const) {
    const localValue =
      key === 'botSpeechMedia'
        ? { greetingBotMessageText: { base64: 'local', mimeType: 'image/jpeg' as const } }
        : '  Свой текст\n';
    const remoteValue =
      key === 'botSpeechMedia'
        ? { greetingBotMessageText: { base64: 'remote', mimeType: 'image/jpeg' as const } }
        : 'Чужое изменение';
    const current = createSettings({ ...baseline, [key]: localValue });
    const fresh = createSettings({
      ...baseline,
      [key]: remoteValue,
      settingsRevision: '2026-10-04T10:00:00.000Z',
    });
    const rebased = rebaseSettingsAfterBotSpeechStyleSave(current, baseline, fresh);
    assert.deepEqual(rebased[key], current[key]);
    assert.equal(rebased.settingsRevision, baseline.settingsRevision);
  }
});

test('mergeNightSectionSettings syncs nightModeRulesButtonEnabled as part of section save', () => {
  assert.ok(NIGHT_SECTION_SETTING_KEYS.includes('nightModeRulesButtonEnabled'));
  assert.ok(NIGHT_SECTION_SETTING_KEYS.includes('nightModeBotButtons'));
  assert.ok(NIGHT_SECTION_SETTING_KEYS.includes('nightModeOpenMessageDeleteOnFirstMessageEnabled'));

  const current = createSettings({
    linkPolicy: 'BLOCKLIST_ONLY',
    nightModeBotMessageEnabled: true,
    nightModeRulesButtonEnabled: false,
  });
  const saved = createSettings({
    linkPolicy: 'ALLOWLIST_ONLY',
    nightModeBotMessageEnabled: true,
    nightModeBotButtons: [
      { text: 'Кнопка 1', url: 'https://max.ru/channel/night-1' },
      { text: 'Кнопка 2', url: 'https://max.ru/channel/night-2' },
    ],
    nightModeRulesButtonEnabled: true,
    nightModeOpenMessageDeleteOnFirstMessageEnabled: true,
  });

  const merged = mergeNightSectionSettings(current, saved);
  assert.deepEqual(merged.nightModeBotButtons, saved.nightModeBotButtons);
  assert.equal(merged.nightModeRulesButtonEnabled, true);
  assert.equal(merged.nightModeOpenMessageDeleteOnFirstMessageEnabled, true);
  assert.equal(merged.nightModeBotMessageEnabled, true);
  assert.equal(merged.linkPolicy, 'BLOCKLIST_ONLY');
});

test('SECTION_SETTING_KEYS includes button arrays for every multi-button section', () => {
  assert.ok(SECTION_SETTING_KEYS.links.includes('linkBotButtons'));
  assert.ok(SECTION_SETTING_KEYS.greeting.includes('greetingBotButtons'));
  assert.ok(SECTION_SETTING_KEYS.commercialFilter.includes('textFiltersBotButtons'));
  assert.ok(SECTION_SETTING_KEYS.duplicates.includes('duplicateBotButtons'));
  assert.ok(SECTION_SETTING_KEYS.limits.includes('photoMessagesEnabled'));
  assert.ok(SECTION_SETTING_KEYS.limits.includes('forwardedMessagesEnabled'));
  assert.ok(SECTION_SETTING_KEYS.limits.includes('messageLimitsBotButtons'));
  assert.deepEqual(SECTION_SETTING_KEYS.stopWords, ['stopWordsPolicy', 'stopWordsRevision']);
  assert.ok(!SECTION_SETTING_KEYS.limits.includes('messageLimitsBlockedWords'));
  assert.ok(!SECTION_SETTING_KEYS.limits.includes('messageLimitsBlockedDomains'));
  assert.ok(!SECTION_SETTING_KEYS.limits.includes('messageLimitsImageTextScanEnabled'));
  assert.ok(SECTION_SETTING_KEYS.night.includes('nightModeBotButtons'));
});

test('SECTION_SETTING_KEYS includes advanced tuning for links and duplicates plus phone allow toggle', () => {
  assert.ok(SECTION_SETTING_KEYS.links.includes('linkEscalationWindowHours'));
  assert.ok(SECTION_SETTING_KEYS.links.includes('linkWarnMaxCount'));
  assert.ok(SECTION_SETTING_KEYS.links.includes('linkMuteMaxCount'));
  assert.ok(SECTION_SETTING_KEYS.links.includes('linkBanMaxCount'));
  assert.ok(SECTION_SETTING_KEYS.duplicates.includes('duplicateDetectionPreset'));
  assert.ok(!SECTION_SETTING_KEYS.duplicates.includes('duplicatePhotoEnabled'));
  assert.ok(!SECTION_SETTING_KEYS.duplicates.includes('duplicatePhotoMatchPreset'));
  assert.ok(SECTION_SETTING_KEYS.duplicates.includes('duplicatePhotoScope'));
  assert.ok(SECTION_SETTING_KEYS.duplicates.includes('duplicateIgnoreLinksEnabled'));
  assert.ok(SECTION_SETTING_KEYS.duplicates.includes('duplicateIgnorePhonesEnabled'));
  assert.ok(SECTION_SETTING_KEYS.duplicates.includes('duplicateNearMatchEnabled'));
  assert.ok(SECTION_SETTING_KEYS.limits.includes('deleteSpammersEnabled'));
  assert.ok(SECTION_SETTING_KEYS.limits.includes('phoneNumbersEnabled'));
  assert.ok(!SECTION_SETTING_KEYS.limits.includes('phoneNumbersEscalationWindowHours'));
});

test('SECTION_SETTING_KEYS includes admin contact toggles for sanction sections', () => {
  assert.ok(SECTION_SETTING_KEYS.links.includes('linkAdminContactButtonEnabled'));
  assert.ok(SECTION_SETTING_KEYS.profanityFilter.includes('profanityAdminContactButtonEnabled'));
  assert.ok(SECTION_SETTING_KEYS.commercialFilter.includes('textFiltersAdminContactButtonEnabled'));
  assert.ok(SECTION_SETTING_KEYS.duplicates.includes('duplicateAdminContactButtonEnabled'));
  assert.ok(SECTION_SETTING_KEYS.limits.includes('messageLimitsAdminContactButtonEnabled'));
  assert.ok(
    SECTION_SETTING_KEYS.requiredSubscription.includes(
      'requiredSubscriptionAdminContactButtonEnabled',
    ),
  );
  assert.ok(
    SECTION_SETTING_KEYS.invitationAccess.includes('invitationAccessAdminContactButtonEnabled'),
  );
});

test('profanity section saves and applies sensitivity with the rest of the filter', () => {
  assert.ok(SECTION_SETTING_KEYS.profanityFilter.includes('profanitySensitivity'));

  const current = createSettings({
    profanitySensitivity: 'BALANCED',
    commercialAdsSensitivity: 'BALANCED',
  });
  const saved = createSettings({
    profanitySensitivity: 'STRICT',
    commercialAdsSensitivity: 'STRICT',
  });
  const merged = mergeSectionSettings(current, saved, 'profanityFilter');

  assert.equal(merged.profanitySensitivity, 'STRICT');
  assert.equal(merged.commercialAdsSensitivity, 'BALANCED');
});

test('required subscription section keeps expiry and duration out of scoped saves', () => {
  assert.ok(SECTION_SETTING_KEYS.requiredSubscription.includes('requiredSubscriptionEnabled'));
  assert.ok(SECTION_SETTING_KEYS.requiredSubscription.includes('requiredSubscriptionChannelIds'));
  assert.ok(SECTION_SETTING_KEYS.requiredSubscription.includes('requiredSubscriptionButtonText'));
  assert.ok(
    !SECTION_SETTING_KEYS.requiredSubscription.includes('requiredSubscriptionDurationDays'),
  );
  assert.ok(!SECTION_SETTING_KEYS.requiredSubscription.includes('requiredSubscriptionExpiresAt'));
});

test('commands section keeps admin command names scoped', () => {
  assert.deepEqual(SECTION_SETTING_KEYS.commands, [
    'adminBanCommandName',
    'adminBanAllCommandName',
    'adminMuteCommandName',
    'adminPermanentMuteCommandName',
    'adminRulesCommandName',
    'adminSilenceCommandName',
    'adminOpenChatCommandName',
  ]);

  const current = createSettings({
    adminBanCommandName: 'бан',
    adminBanAllCommandName: 'Бан!',
    adminMuteCommandName: 'мут',
    adminPermanentMuteCommandName: 'мут 88',
    adminRulesCommandName: 'правило',
    adminSilenceCommandName: 'тишина',
    adminOpenChatCommandName: 'тишина выкл',
    linkPolicy: 'ALLOWLIST_ONLY',
  });
  const saved = createSettings({
    adminBanCommandName: 'заблокировать',
    adminBanAllCommandName: 'ЗАБЛОКИРОВАТЬ',
    adminMuteCommandName: 'тихо',
    adminPermanentMuteCommandName: 'тихо навсегда',
    adminRulesCommandName: 'регламент',
    adminSilenceCommandName: 'закрыть',
    adminOpenChatCommandName: 'открыть',
    linkPolicy: 'BLOCKLIST_ONLY',
  });

  const merged = mergeSectionSettings(current, saved, 'commands');
  assert.equal(merged.adminBanCommandName, 'заблокировать');
  assert.equal(merged.adminBanAllCommandName, 'ЗАБЛОКИРОВАТЬ');
  assert.equal(merged.adminMuteCommandName, 'тихо');
  assert.equal(merged.adminPermanentMuteCommandName, 'тихо навсегда');
  assert.equal(merged.adminRulesCommandName, 'регламент');
  assert.equal(merged.adminSilenceCommandName, 'закрыть');
  assert.equal(merged.adminOpenChatCommandName, 'открыть');
  assert.equal(merged.linkPolicy, 'ALLOWLIST_ONLY');
});

test('storefront section saves its toggles and copy without changing other sections', () => {
  assert.deepEqual(SECTION_SETTING_KEYS.storefront, [
    'karavanStorefrontEnabled',
    'karavanStorefrontAdminsOnly',
    'karavanStorefrontMessageText',
    'karavanStorefrontOpenButtonText',
    'karavanStorefrontCatalogButtonText',
    'karavanStorefrontCreateButtonText',
  ]);

  const current = createSettings({
    karavanStorefrontEnabled: false,
    karavanStorefrontAdminsOnly: false,
    deleteBotMessagesEnabled: true,
  });
  const saved = createSettings({
    karavanStorefrontEnabled: true,
    karavanStorefrontAdminsOnly: true,
    karavanStorefrontMessageText: 'Товары продавца',
    karavanStorefrontOpenButtonText: 'К продавцу',
    karavanStorefrontCatalogButtonText: 'Все витрины',
    karavanStorefrontCreateButtonText: 'Создать витрину',
    deleteBotMessagesEnabled: false,
  });
  const merged = mergeSectionSettings(current, saved, 'storefront');

  assert.equal(merged.karavanStorefrontEnabled, true);
  assert.equal(merged.karavanStorefrontAdminsOnly, true);
  assert.equal(merged.karavanStorefrontMessageText, 'Товары продавца');
  assert.equal(merged.karavanStorefrontOpenButtonText, 'К продавцу');
  assert.equal(merged.karavanStorefrontCatalogButtonText, 'Все витрины');
  assert.equal(merged.karavanStorefrontCreateButtonText, 'Создать витрину');
  assert.equal(merged.deleteBotMessagesEnabled, true);
});

test('mergeSectionSettings preserves multi-button arrays when saving a section', () => {
  const current = createSettings({
    deleteSpammersEnabled: true,
    linkBotButtons: [{ text: 'Старая', url: 'https://max.ru/channel/old' }],
  });
  const saved = createSettings({
    deleteSpammersEnabled: false,
    linkBotButtons: [
      { text: 'Первая', url: 'https://max.ru/channel/first' },
      { text: 'Вторая', url: 'https://max.ru/channel/second' },
    ],
    linkBotButtonEnabled: true,
    linkBotButtonUrl: 'https://max.ru/channel/first',
    linkBotButtonText: 'Первая',
  });

  const merged = mergeSectionSettings(current, saved, 'links');
  assert.deepEqual(merged.linkBotButtons, saved.linkBotButtons);
  assert.equal(merged.linkBotButtonEnabled, true);
  assert.equal(merged.deleteSpammersEnabled, true);
});

test('section dirty comparison treats equal duplicate button arrays as unchanged after refetch', () => {
  const draft = createSettings({
    duplicateBotButtons: [{ text: 'Открыть', url: 'https://max.ru/channel/example' }],
  });
  const refetched = createSettings({
    duplicateBotButtons: [{ text: 'Открыть', url: 'https://max.ru/channel/example' }],
  });

  assert.notEqual(draft.duplicateBotButtons, refetched.duplicateBotButtons);
  assert.equal(hasSectionSettingChanges(draft, refetched, 'duplicates'), false);

  refetched.duplicateBotButtons = [{ text: 'Другой чат', url: 'https://max.ru/channel/another' }];
  assert.equal(hasSectionSettingChanges(draft, refetched, 'duplicates'), true);
});

test('duplicate section normalization prevents a legacy server shape from looking dirty', () => {
  const saved = createSettings({
    duplicateWarnEnabled: true,
    duplicateMuteEnabled: true,
    duplicateBanEnabled: true,
    duplicateWarnWindowSec: 43_200,
    duplicateMuteWindowSec: 86_400,
    duplicateBanWindowSec: 172_800,
  });
  const draft = normalizeSectionDraftSettings(saved, 'duplicates');
  const comparableSaved = normalizeSectionDraftSettings(saved, 'duplicates');

  assert.equal(hasSectionSettingChanges(draft, comparableSaved, 'duplicates'), false);
});

test('discarding duplicate changes restores normalized server values', () => {
  const saved = createSettings({
    duplicateWarnEnabled: true,
    duplicateMuteEnabled: true,
    duplicateBanEnabled: true,
    duplicateWarnWindowSec: 43_200,
    duplicateMuteWindowSec: 86_400,
    duplicateBanWindowSec: 172_800,
  });
  const current = createSettings({
    antiSpamEnabled: true,
    duplicateWarnWindowSec: 172_800,
    duplicateMuteWindowSec: 172_800,
    duplicateBanWindowSec: 172_800,
  });
  const restored = mergeSectionSettings(
    current,
    normalizeSectionDraftSettings(saved, 'duplicates'),
    'duplicates',
  );

  assert.equal(restored.duplicateWarnWindowSec, 43_200);
  assert.equal(restored.duplicateMuteWindowSec, 43_200);
  assert.equal(restored.duplicateBanWindowSec, 43_200);
  assert.equal(restored.antiSpamEnabled, true);
});

test('mergeSectionSettings does not copy legacy required subscription expiry fields', () => {
  const current = createSettings({
    requiredSubscriptionEnabled: false,
    requiredSubscriptionChannelIds: [],
    requiredSubscriptionDurationDays: 7,
    requiredSubscriptionExpiresAt: '2026-04-01T00:00:00.000Z',
  });
  const saved = createSettings({
    requiredSubscriptionEnabled: true,
    requiredSubscriptionChannelIds: ['channel-1'],
    requiredSubscriptionButtonText: 'Подписаться',
    requiredSubscriptionDurationDays: 14,
    requiredSubscriptionExpiresAt: '',
  });

  const merged = mergeSectionSettings(current, saved, 'requiredSubscription');
  assert.equal(merged.requiredSubscriptionEnabled, true);
  assert.deepEqual(merged.requiredSubscriptionChannelIds, ['channel-1']);
  assert.equal(merged.requiredSubscriptionButtonText, 'Подписаться');
  assert.equal(merged.requiredSubscriptionDurationDays, 7);
  assert.equal(merged.requiredSubscriptionExpiresAt, '2026-04-01T00:00:00.000Z');
});

test('mergeSectionSettings preserves advanced tuning and syncs limit allow toggles', () => {
  const current = createSettings({
    duplicateDetectionPreset: 'STANDARD',
    duplicatePhotoEnabled: false,
    duplicatePhotoMatchPreset: 'SAME_IMAGE',
    duplicatePhotoScope: 'SAME_AUTHOR',
    duplicateIgnoreLinksEnabled: false,
    duplicateIgnorePhonesEnabled: false,
    duplicateNearMatchEnabled: false,
    linkEscalationWindowHours: 24,
    linkWarnMaxCount: 2,
    linkMuteMaxCount: 3,
    linkBanMaxCount: 4,
    forwardedMessagesEnabled: true,
    phoneNumbersEnabled: true,
    phoneNumbersEscalationWindowHours: 12,
  });
  const saved = createSettings({
    duplicateDetectionPreset: 'CUSTOM',
    duplicatePhotoEnabled: true,
    duplicatePhotoMatchPreset: 'MINOR_EDITS',
    duplicatePhotoScope: 'CHAT',
    duplicateIgnoreLinksEnabled: true,
    duplicateIgnorePhonesEnabled: true,
    duplicateNearMatchEnabled: true,
    linkEscalationWindowHours: 48,
    linkWarnMaxCount: 1,
    linkMuteMaxCount: 2,
    linkBanMaxCount: 3,
    forwardedMessagesEnabled: false,
    phoneNumbersEnabled: false,
    phoneNumbersEscalationWindowHours: 72,
  });

  const duplicateMerged = mergeSectionSettings(current, saved, 'duplicates');
  assert.equal(duplicateMerged.duplicateDetectionPreset, 'CUSTOM');
  assert.equal(duplicateMerged.duplicatePhotoEnabled, false);
  assert.equal(duplicateMerged.duplicatePhotoMatchPreset, 'SAME_IMAGE');
  assert.equal(duplicateMerged.duplicatePhotoScope, 'CHAT');
  assert.equal(duplicateMerged.duplicateIgnoreLinksEnabled, true);
  assert.equal(duplicateMerged.duplicateIgnorePhonesEnabled, true);
  assert.equal(duplicateMerged.duplicateNearMatchEnabled, true);
  assert.equal(duplicateMerged.linkEscalationWindowHours, 24);

  const linkMerged = mergeSectionSettings(current, saved, 'links');
  assert.equal(linkMerged.linkEscalationWindowHours, 48);
  assert.equal(linkMerged.linkWarnMaxCount, 1);
  assert.equal(linkMerged.linkMuteMaxCount, 2);
  assert.equal(linkMerged.linkBanMaxCount, 3);
  assert.equal(linkMerged.phoneNumbersEscalationWindowHours, 12);

  const limitsMerged = mergeSectionSettings(current, saved, 'limits');
  assert.equal(limitsMerged.forwardedMessagesEnabled, false);
  assert.equal(limitsMerged.phoneNumbersEnabled, false);
  assert.equal(limitsMerged.phoneNumbersEscalationWindowHours, 12);
});

test('mergeSectionSettings syncs stop words without copying limit sanctions', () => {
  const current = createSettings({
    antiSpamEnabled: true,
    messageLimitsBlockedWords: ['старое'],
    messageLimitsBlockedDomains: ['old.example'],
    messageLimitsImageTextScanEnabled: false,
    messageLimitsBotMessageEnabled: false,
  });
  const saved = createSettings({
    antiSpamEnabled: false,
    stopWordsRevision: 3,
    stopWordsPolicy: stopWordsPolicySchema.parse({
      enabled: true,
      imageScanEnabled: true,
      domains: ['casino.example'],
      rules: [{ id: 'one', kind: 'WORD', value: 'казино' }],
      sanctions: { warnEnabled: true },
    }),
    messageLimitsBlockedWords: ['казино', 'ставки'],
    messageLimitsBlockedDomains: ['casino.example'],
    messageLimitsImageTextScanEnabled: true,
    messageLimitsBotMessageEnabled: true,
  });

  const merged = mergeSectionSettings(current, saved, 'stopWords');
  assert.deepEqual(merged.stopWordsPolicy, saved.stopWordsPolicy);
  assert.equal(merged.stopWordsRevision, 3);
  assert.deepEqual(merged.messageLimitsBlockedWords, ['старое']);
  assert.deepEqual(merged.messageLimitsBlockedDomains, ['old.example']);
  assert.equal(merged.messageLimitsImageTextScanEnabled, false);
  assert.equal(merged.messageLimitsBotMessageEnabled, false);
  assert.equal(merged.antiSpamEnabled, true);
});

test('mergeSectionSettings scopes bot speech media to the saved section', () => {
  const current = createSettings({
    botSpeechMedia: {
      linkBotMessageText: {
        base64: 'old-link',
        mimeType: 'image/jpeg',
        fileName: 'old-link.jpg',
      },
      greetingBotMessageText: {
        base64: 'current-greeting',
        mimeType: 'image/png',
        fileName: 'current-greeting.png',
      },
    },
  });
  const saved = createSettings({
    botSpeechMedia: {
      linkBotMessageText: {
        base64: 'new-link',
        mimeType: 'image/jpeg',
        fileName: 'new-link.jpg',
      },
      greetingBotMessageText: {
        base64: 'saved-greeting',
        mimeType: 'image/png',
        fileName: 'saved-greeting.png',
      },
    },
  });

  const merged = mergeSectionSettings(current, saved, 'links');
  assert.deepEqual(
    merged.botSpeechMedia.linkBotMessageText,
    saved.botSpeechMedia.linkBotMessageText,
  );
  assert.deepEqual(
    merged.botSpeechMedia.greetingBotMessageText,
    current.botSpeechMedia.greetingBotMessageText,
  );
});

test('mergeSectionSettings removes bot speech media for a saved section when cleared', () => {
  const current = createSettings({
    botSpeechMedia: {
      linkWarnMessageText: {
        base64: 'old-warning',
        mimeType: 'image/jpeg',
        fileName: 'old-warning.jpg',
      },
    },
  });
  const saved = createSettings({ botSpeechMedia: {} });

  const merged = mergeSectionSettings(current, saved, 'links');
  assert.equal(merged.botSpeechMedia.linkWarnMessageText, undefined);
});

test('hasSectionBotSpeechMediaChanges detects scoped media changes', () => {
  const saved = createSettings();
  const draft = createSettings({
    botSpeechMedia: {
      requiredSubscriptionWarnMessageText: {
        base64: 'subscription-warning',
        mimeType: 'image/jpeg',
        fileName: 'subscription-warning.jpg',
      },
    },
  });

  assert.equal(hasSectionBotSpeechMediaChanges(draft, saved, 'requiredSubscription'), true);
  assert.equal(hasSectionBotSpeechMediaChanges(draft, saved, 'links'), false);
});

test('edits made during a bulk save stay unsaved while the confirmed revision is retained', () => {
  const submitted = createSettings({
    settingsRevision: '2026-10-01T09:00:00.000Z',
    reportsThreshold: 3,
  });
  const current = { ...submitted, reportsThreshold: 6, greetingEnabled: true };
  const saved = { ...submitted, settingsRevision: '2026-10-01T10:00:00.000Z' };
  const merged = mergeSectionSettingsAfterSave(
    current,
    saved,
    'reports',
    submitted.settingsRevision,
    submitted,
  );
  assert.equal(merged.reportsThreshold, 6);
  assert.equal(merged.greetingEnabled, true);
  assert.equal(merged.settingsRevision, saved.settingsRevision);
  assert.equal(hasSectionSettingChanges(merged, saved, 'reports'), true);
});
