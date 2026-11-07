import type { ChatSettings } from '@maxim/contracts';
import type { BotSpeechMediaFieldKey } from '@maxim/contracts/bot-speech';
import { normalizeDuplicateFlowSettings } from './settings/settings-duplicate-flow';

export type ApplySectionKey =
  | 'reports'
  | 'links'
  | 'greeting'
  | 'profanityFilter'
  | 'commercialFilter'
  | 'duplicates'
  | 'limits'
  | 'stopWords'
  | 'phones'
  | 'night'
  | 'requiredSubscription'
  | 'invitationAccess'
  | 'commands'
  | 'storefront'
  | 'extra';

export type SanctionPresetGroup =
  | 'duplicate'
  | 'invitationAccess'
  | 'link'
  | 'messageLimits'
  | 'profanity'
  | 'requiredSubscription'
  | 'textFilters';

type SanctionStageEnabledKey =
  | 'duplicateBotMessageEnabled'
  | 'duplicateMuteEnabled'
  | 'duplicateWarnEnabled'
  | 'invitationAccessBotMessageEnabled'
  | 'invitationAccessMuteEnabled'
  | 'invitationAccessWarnEnabled'
  | 'linkBotMessageEnabled'
  | 'linkMuteEnabled'
  | 'linkWarnEnabled'
  | 'messageLimitsBotMessageEnabled'
  | 'messageLimitsMuteEnabled'
  | 'messageLimitsWarnEnabled'
  | 'profanityBotMessageEnabled'
  | 'profanityMuteEnabled'
  | 'profanityWarnEnabled'
  | 'requiredSubscriptionBotMessageEnabled'
  | 'requiredSubscriptionMuteEnabled'
  | 'requiredSubscriptionWarnEnabled'
  | 'textFiltersBotMessageEnabled'
  | 'textFiltersMuteEnabled'
  | 'textFiltersWarnEnabled';

const DEFAULT_SANCTION_STAGE_KEYS: Record<
  SanctionPresetGroup,
  readonly [SanctionStageEnabledKey, SanctionStageEnabledKey, SanctionStageEnabledKey]
> = {
  duplicate: ['duplicateBotMessageEnabled', 'duplicateWarnEnabled', 'duplicateMuteEnabled'],
  invitationAccess: [
    'invitationAccessBotMessageEnabled',
    'invitationAccessWarnEnabled',
    'invitationAccessMuteEnabled',
  ],
  link: ['linkBotMessageEnabled', 'linkWarnEnabled', 'linkMuteEnabled'],
  messageLimits: [
    'messageLimitsBotMessageEnabled',
    'messageLimitsWarnEnabled',
    'messageLimitsMuteEnabled',
  ],
  profanity: ['profanityBotMessageEnabled', 'profanityWarnEnabled', 'profanityMuteEnabled'],
  requiredSubscription: [
    'requiredSubscriptionBotMessageEnabled',
    'requiredSubscriptionWarnEnabled',
    'requiredSubscriptionMuteEnabled',
  ],
  textFilters: ['textFiltersBotMessageEnabled', 'textFiltersWarnEnabled', 'textFiltersMuteEnabled'],
};

export function applyDefaultSanctionStages(
  settings: ChatSettings,
  group: SanctionPresetGroup,
): ChatSettings {
  const nextSettings = { ...settings };
  const nextRecord = nextSettings as Record<keyof ChatSettings, unknown>;

  for (const key of DEFAULT_SANCTION_STAGE_KEYS[group]) {
    nextRecord[key] = true;
  }

  return nextSettings;
}

export function enableDefaultSanctionStages(
  setFieldValue: (key: SanctionStageEnabledKey, value: true) => void,
  group: SanctionPresetGroup,
): void {
  for (const key of DEFAULT_SANCTION_STAGE_KEYS[group]) {
    setFieldValue(key, true);
  }
}

export function applyRequiredSubscriptionChannelAddition(
  settings: ChatSettings,
  channelId: string,
  maxChannels: number,
): ChatSettings {
  if (
    settings.requiredSubscriptionChannelIds.includes(channelId) ||
    settings.requiredSubscriptionChannelIds.length >= maxChannels
  ) {
    return settings;
  }

  const nextSettings =
    settings.requiredSubscriptionChannelIds.length === 0
      ? applyDefaultSanctionStages(settings, 'requiredSubscription')
      : settings;
  return {
    ...nextSettings,
    requiredSubscriptionEnabled: true,
    requiredSubscriptionChannelIds: [...settings.requiredSubscriptionChannelIds, channelId],
    requiredSubscriptionExpiresAt: '',
  };
}

export function normalizeRequiredSubscriptionDraftSettings(settings: ChatSettings): ChatSettings {
  const requiredSubscriptionChannelIds = Array.from(
    new Set(
      settings.requiredSubscriptionChannelIds
        .map((item) => item.trim())
        .filter((item) => item.length > 0),
    ),
  );

  return {
    ...settings,
    requiredSubscriptionEnabled: requiredSubscriptionChannelIds.length > 0,
    requiredSubscriptionChannelIds,
    requiredSubscriptionBotMessageEnabled: requiredSubscriptionChannelIds.length > 0,
    requiredSubscriptionExpiresAt: '',
  };
}

export function normalizeSectionDraftSettings(
  settings: ChatSettings,
  section: ApplySectionKey,
): ChatSettings {
  if (section === 'requiredSubscription') {
    return normalizeRequiredSubscriptionDraftSettings(settings);
  }
  if (section === 'duplicates') {
    return normalizeDuplicateFlowSettings(settings);
  }
  return settings;
}

export function serializeChatSettingsDraft(settings: ChatSettings): string {
  return JSON.stringify({
    ...settings,
    settingsRevision: undefined,
    linkRulesLegacySnapshot: undefined,
    linkRulesStorageStatus: undefined,
  });
}

export function shouldHydrateSettingsDraftFromServer(
  currentSnapshot: string,
  previousServerSnapshot: string,
  nextServerSnapshot: string,
): boolean {
  return (
    !currentSnapshot ||
    !previousServerSnapshot ||
    currentSnapshot === previousServerSnapshot ||
    currentSnapshot === nextServerSnapshot
  );
}

export const BOT_SPEECH_SYNC_SETTING_KEYS = ['botSpeechStyle'] as const satisfies ReadonlyArray<
  keyof ChatSettings
>;

export const NIGHT_SECTION_SETTING_KEYS = [
  'nightModeEnabled',
  'nightModeStartTimeMinutes',
  'nightModeEndTimeMinutes',
  'nightModeTimezone',
  'nightModeBotMessageEnabled',
  'nightModeBotMessageText',
  'nightModeCommentsEnabled',
  'nightModeOpenMessageEnabled',
  'nightModeOpenMessageDeleteOnFirstMessageEnabled',
  'nightModeOpenMessageText',
  'nightModeBotButtons',
  'nightModeBotButtonEnabled',
  'nightModeBotButtonUrl',
  'nightModeBotButtonText',
  'nightModeRulesButtonEnabled',
  'nightModeForceCloseEnabled',
  'nightModeForceCloseForever',
  'nightModeForceCloseHours',
  'nightModeForceCloseDays',
  'nightModeForceCloseUntil',
] as const satisfies ReadonlyArray<keyof ChatSettings>;

export const SECTION_SETTING_KEYS: Record<ApplySectionKey, readonly (keyof ChatSettings)[]> = {
  reports: [
    'reportsEnabled',
    'reportsThreshold',
    'reportsAliases',
    'reportsDeleteMode',
    'reportsMuteEnabled',
    'reportsMuteDurationHours',
  ],
  links: [
    'linkRulesPolicy',
    'linkRulesLegacySnapshot',
    'linkRulesReplaceInvalidStorage',
    'linkPolicy',
    'linkEscalationWindowHours',
    'linkWarnMaxCount',
    'linkMuteMaxCount',
    'linkBanMaxCount',
    'linkBotMessageEnabled',
    'linkBotMessageText',
    'linkWarnEnabled',
    'linkWarnMessageText',
    'linkMuteEnabled',
    'linkMuteDurationHours',
    'linkBanEnabled',
    'linkBotButtons',
    'linkBotButtonEnabled',
    'linkBotButtonUrl',
    'linkBotButtonText',
    'linkAdminContactButtonEnabled',
    'linkAdminContactButtonUrl',
  ],
  greeting: [
    'greetingEnabled',
    'greetingBotMessageEnabled',
    'greetingDeleteBotMessageEnabled',
    'greetingDeleteBotMessageDelayMinutes',
    'greetingBotMessageText',
    'greetingBotButtons',
    'greetingBotButtonEnabled',
    'greetingBotButtonUrl',
    'greetingBotButtonText',
    'greetingRulesButtonEnabled',
  ],
  profanityFilter: [
    'russianProfanityFilterEnabled',
    'profanitySensitivity',
    'profanityBotMessageEnabled',
    'profanityBotMessageText',
    'profanityWarnEnabled',
    'profanityWarnMessageText',
    'profanityMuteEnabled',
    'profanityMuteDurationHours',
    'profanityBanEnabled',
    'profanityAdminContactButtonEnabled',
    'profanityAdminContactButtonUrl',
  ],
  commercialFilter: [
    'commercialAdsFilterEnabled',
    'commercialAdsPolicy',
    'commercialAdsSensitivity',
    'commercialAdsWarnThreshold',
    'commercialAdsDeleteThreshold',
    'textFiltersBotMessageEnabled',
    'textFiltersBotMessageText',
    'textFiltersWarnEnabled',
    'textFiltersWarnMessageText',
    'textFiltersMuteEnabled',
    'textFiltersMuteDurationHours',
    'textFiltersBanEnabled',
    'textFiltersBotButtons',
    'textFiltersBotButtonEnabled',
    'textFiltersBotButtonUrl',
    'textFiltersBotButtonText',
    'textFiltersAdminContactButtonEnabled',
    'textFiltersAdminContactButtonUrl',
  ],
  duplicates: [
    'antiDuplicateEnabled',
    'duplicateWindowMode',
    'duplicateStartTimeMinutes',
    'duplicateEndTimeMinutes',
    'duplicateTimezone',
    'duplicateDetectionPreset',
    'duplicatePhotoScope',
    'duplicateIgnoreLinksEnabled',
    'duplicateIgnorePhonesEnabled',
    'duplicateNearMatchEnabled',
    'duplicateWarnEnabled',
    'duplicateMuteEnabled',
    'duplicateBanEnabled',
    'duplicateWarnWindowSec',
    'duplicateWarnMaxCount',
    'duplicateMuteWindowSec',
    'duplicateMuteMaxCount',
    'duplicateMuteDurationHours',
    'duplicateBanWindowSec',
    'duplicateBanMaxCount',
    'duplicateBotMessageEnabled',
    'duplicateBotMessageText',
    'duplicateBotButtons',
    'duplicateBotButtonEnabled',
    'duplicateBotButtonUrl',
    'duplicateBotButtonText',
    'duplicateAdminContactButtonEnabled',
    'duplicateAdminContactButtonUrl',
  ],
  limits: [
    'slowModeEnabled',
    'slowModeIntervalSeconds',
    'mediaMessageCooldownEnabled',
    'mediaMessageCooldownSeconds',
    'stickerMessagesEnabled',
    'antiSpamEnabled',
    'deleteSpammersEnabled',
    'messageCountLimitEnabled',
    'messageCountLimitMessages',
    'messageCountLimitWindowHours',
    'maxMessageLengthEnabled',
    'maxMessageLength',
    'photoMessageCooldownEnabled',
    'photoMessageCooldownHours',
    'stickerMessageCooldownEnabled',
    'stickerMessageCooldownMinutes',
    'photoMessagesEnabled',
    'videoMessagesEnabled',
    'fileMessagesEnabled',
    'voiceMessagesEnabled',
    'forwardedMessagesEnabled',
    'messageLimitsBotMessageEnabled',
    'messageLimitsBotMessageText',
    'messageLimitsWarnEnabled',
    'messageLimitsWarnMessageText',
    'messageLimitsBanEnabled',
    'messageLimitsMuteEnabled',
    'messageLimitsMuteDurationHours',
    'messageLimitsBotButtons',
    'messageLimitsBotButtonEnabled',
    'messageLimitsBotButtonUrl',
    'messageLimitsBotButtonText',
    'messageLimitsAdminContactButtonEnabled',
    'messageLimitsAdminContactButtonUrl',
    'phoneNumbersEnabled',
  ],
  stopWords: ['stopWordsPolicy', 'stopWordsRevision'],
  phones: [
    'phoneNumbersEnabled',
    'phoneNumbersBotMessageEnabled',
    'phoneNumbersBotMessageText',
    'phoneNumbersWarnEnabled',
    'phoneNumbersMuteEnabled',
    'phoneNumbersMuteDurationHours',
    'phoneNumbersBanEnabled',
    'phoneNumbersEscalationWindowHours',
    'phoneNumbersWarnMaxCount',
    'phoneNumbersMuteMaxCount',
    'phoneNumbersBanMaxCount',
    'phoneNumbersAdminContactButtonEnabled',
    'phoneNumbersAdminContactButtonUrl',
  ],
  night: [...NIGHT_SECTION_SETTING_KEYS],
  requiredSubscription: [
    'requiredSubscriptionEnabled',
    'requiredSubscriptionChannelIds',
    'requiredSubscriptionBotMessageEnabled',
    'requiredSubscriptionBotMessageText',
    'requiredSubscriptionButtonText',
    'requiredSubscriptionAdminContactButtonEnabled',
    'requiredSubscriptionAdminContactButtonUrl',
    'requiredSubscriptionWarnEnabled',
    'requiredSubscriptionWarnMessageText',
    'requiredSubscriptionMuteEnabled',
    'requiredSubscriptionMuteDurationHours',
    'requiredSubscriptionBanEnabled',
  ],
  invitationAccess: [
    'invitationAccessEnabled',
    'invitationAccessRequiredCount',
    'invitationAccessBotMessageEnabled',
    'invitationAccessBotMessageText',
    'invitationAccessAdminContactButtonEnabled',
    'invitationAccessAdminContactButtonUrl',
    'invitationAccessWarnEnabled',
    'invitationAccessWarnMessageText',
    'invitationAccessMuteEnabled',
    'invitationAccessMuteDurationHours',
    'invitationAccessBanEnabled',
  ],
  commands: [
    'adminBanCommandName',
    'adminBanAllCommandName',
    'adminMuteCommandName',
    'adminPermanentMuteCommandName',
    'adminRulesCommandName',
    'adminSilenceCommandName',
    'adminOpenChatCommandName',
  ],
  storefront: [
    'karavanStorefrontEnabled',
    'karavanStorefrontAdminsOnly',
    'karavanStorefrontMessageText',
    'karavanStorefrontOpenButtonText',
    'karavanStorefrontCatalogButtonText',
    'karavanStorefrontCreateButtonText',
  ],
  extra: [
    'deleteBotMessagesEnabled',
    'deleteBotMessagesDelayMinutes',
    'removeBotsFromGroupEnabled',
  ],
};

export function mergeBotSpeechMediaForKeys(
  targetMedia: ChatSettings['botSpeechMedia'],
  sourceMedia: ChatSettings['botSpeechMedia'],
  settingKeys: readonly (keyof ChatSettings)[],
): ChatSettings['botSpeechMedia'] {
  const nextMedia = { ...targetMedia };
  for (const key of settingKeys) {
    const mediaKey = key as BotSpeechMediaFieldKey;
    const sourceImage = sourceMedia[mediaKey];
    if (sourceImage?.base64) {
      nextMedia[mediaKey] = sourceImage;
    } else {
      delete nextMedia[mediaKey];
    }
  }
  return nextMedia;
}

function areBotSpeechMediaImagesEqual(
  left: ChatSettings['botSpeechMedia'][BotSpeechMediaFieldKey] | undefined,
  right: ChatSettings['botSpeechMedia'][BotSpeechMediaFieldKey] | undefined,
): boolean {
  return (
    (left?.base64 ?? '') === (right?.base64 ?? '') &&
    (left?.mimeType ?? '') === (right?.mimeType ?? '') &&
    (left?.fileName ?? '') === (right?.fileName ?? '')
  );
}

export function hasSectionBotSpeechMediaChanges(
  draft: ChatSettings,
  saved: ChatSettings,
  section: ApplySectionKey,
): boolean {
  return SECTION_SETTING_KEYS[section].some((key) => {
    const mediaKey = key as BotSpeechMediaFieldKey;
    return !areBotSpeechMediaImagesEqual(
      draft.botSpeechMedia[mediaKey],
      saved.botSpeechMedia[mediaKey],
    );
  });
}

export function hasSectionSettingChanges(
  draft: ChatSettings,
  saved: ChatSettings,
  section: ApplySectionKey,
): boolean {
  return SECTION_SETTING_KEYS[section].some(
    (key) =>
      key !== 'linkRulesLegacySnapshot' &&
      JSON.stringify(draft[key]) !== JSON.stringify(saved[key]),
  );
}

export const COMMENTS_SETTING_KEYS = [
  'commentsEnabled',
  'commentsAdminsEnabled',
  'commentsChatBroadcastsEnabled',
] as const satisfies ReadonlyArray<keyof ChatSettings>;

export function applyNightModeEnabledChange(
  settings: ChatSettings,
  enabled: boolean,
): ChatSettings {
  if (enabled) {
    return {
      ...settings,
      nightModeEnabled: true,
      nightModeBotMessageEnabled: true,
    };
  }

  return {
    ...settings,
    nightModeEnabled: false,
    nightModeBotMessageEnabled: false,
    nightModeCommentsEnabled: false,
    nightModeBotButtonEnabled: false,
    nightModeRulesButtonEnabled: false,
  };
}

export function applyNightModeBotMessageEnabledChange(
  settings: ChatSettings,
  enabled: boolean,
): ChatSettings {
  if (enabled) {
    return {
      ...settings,
      nightModeBotMessageEnabled: true,
    };
  }

  return {
    ...settings,
    nightModeBotMessageEnabled: false,
    nightModeCommentsEnabled: false,
    nightModeBotButtonEnabled: false,
    nightModeRulesButtonEnabled: false,
  };
}

export function mergeNightSectionSettings(
  targetSettings: ChatSettings,
  sourceSettings: ChatSettings,
): ChatSettings {
  const nextSettings = { ...targetSettings } as ChatSettings;
  nextSettings.settingsRevision =
    sourceSettings.settingsRevision ?? targetSettings.settingsRevision;
  const nextRecord = nextSettings as Record<keyof ChatSettings, unknown>;
  const sourceRecord = sourceSettings as Record<keyof ChatSettings, unknown>;

  for (const key of NIGHT_SECTION_SETTING_KEYS) {
    nextRecord[key] = sourceRecord[key];
  }
  nextSettings.botSpeechMedia = mergeBotSpeechMediaForKeys(
    targetSettings.botSpeechMedia,
    sourceSettings.botSpeechMedia,
    NIGHT_SECTION_SETTING_KEYS,
  );

  return nextSettings;
}

export function mergeSectionSettings(
  targetSettings: ChatSettings,
  sourceSettings: ChatSettings,
  section: ApplySectionKey,
): ChatSettings {
  if (section === 'night') {
    return mergeNightSectionSettings(targetSettings, sourceSettings);
  }

  const nextSettings = { ...targetSettings } as ChatSettings;
  const nextRecord = nextSettings as Record<keyof ChatSettings, unknown>;
  const sourceRecord = sourceSettings as Record<keyof ChatSettings, unknown>;

  for (const key of SECTION_SETTING_KEYS[section]) {
    nextRecord[key] = sourceRecord[key];
  }
  nextSettings.settingsRevision =
    sourceSettings.settingsRevision ?? targetSettings.settingsRevision;
  nextSettings.botSpeechMedia = mergeBotSpeechMediaForKeys(
    targetSettings.botSpeechMedia,
    sourceSettings.botSpeechMedia,
    SECTION_SETTING_KEYS[section],
  );

  return nextSettings;
}

// FLAG: Resolving one stale section must not rebase other unsaved sections onto a newer fence.
export function mergeSectionSettingsAfterSave(
  target: ChatSettings,
  saved: ChatSettings,
  section: ApplySectionKey,
  expectedRevision = target.settingsRevision,
  submitted?: ChatSettings,
): ChatSettings {
  const next = mergeSectionSettings(target, saved, section);
  const hasOtherChanges = (Object.keys(SECTION_SETTING_KEYS) as ApplySectionKey[]).some(
    (other) =>
      other !== section &&
      (hasSectionSettingChanges(target, saved, other) ||
        hasSectionBotSpeechMediaChanges(target, saved, other)),
  );
  if (target.settingsRevision !== expectedRevision && hasOtherChanges)
    next.settingsRevision = target.settingsRevision;
  // FLAG: Edits made while a bulk save is in flight remain an unsaved draft.
  if (
    submitted &&
    (hasSectionSettingChanges(target, submitted, section) ||
      hasSectionBotSpeechMediaChanges(target, submitted, section))
  ) {
    const preserved = mergeSectionSettings(next, target, section);
    preserved.settingsRevision = next.settingsRevision;
    return preserved;
  }
  return next;
}

export function mergeCommentsSettings(
  targetSettings: ChatSettings,
  sourceSettings: ChatSettings,
): ChatSettings {
  const nextSettings = { ...targetSettings } as ChatSettings;
  const nextRecord = nextSettings as Record<keyof ChatSettings, unknown>;
  const sourceRecord = sourceSettings as Record<keyof ChatSettings, unknown>;

  for (const key of COMMENTS_SETTING_KEYS) {
    nextRecord[key] = sourceRecord[key];
  }

  nextSettings.commentsAllEnabled = false;

  return nextSettings;
}

export function mergeBotSpeechStyleSettings(
  targetSettings: ChatSettings,
  sourceSettings: Pick<ChatSettings, 'botSpeechStyle'>,
): ChatSettings {
  return {
    ...targetSettings,
    botSpeechStyle: sourceSettings.botSpeechStyle,
  };
}

export function rebaseSettingsAfterBotSpeechStyleSave(
  current: ChatSettings,
  baseline: ChatSettings,
  fresh: ChatSettings,
): ChatSettings {
  const next = { ...fresh };
  const nextRecord = next as Record<keyof ChatSettings, unknown>;
  const equal = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
  let hasConflict = false;

  for (const key of Object.keys(current) as Array<keyof ChatSettings>) {
    if (key === 'settingsRevision' || key === 'botSpeechStyle' || key === 'botSpeechMedia')
      continue;
    if (equal(current[key], baseline[key])) continue;
    nextRecord[key] = current[key];
    if (!equal(fresh[key], baseline[key]) && !equal(fresh[key], current[key])) hasConflict = true;
  }

  next.botSpeechMedia = { ...fresh.botSpeechMedia };
  for (const key of new Set([
    ...Object.keys(baseline.botSpeechMedia),
    ...Object.keys(current.botSpeechMedia),
  ]) as Set<BotSpeechMediaFieldKey>) {
    if (equal(current.botSpeechMedia[key], baseline.botSpeechMedia[key])) continue;
    if (current.botSpeechMedia[key]) next.botSpeechMedia[key] = current.botSpeechMedia[key];
    else delete next.botSpeechMedia[key];
    if (
      !equal(fresh.botSpeechMedia[key], baseline.botSpeechMedia[key]) &&
      !equal(fresh.botSpeechMedia[key], current.botSpeechMedia[key])
    )
      hasConflict = true;
  }

  // FLAG: A style receipt cannot authorize overwriting concurrent edits to custom messages.
  if (hasConflict || current.settingsRevision !== baseline.settingsRevision) {
    next.settingsRevision = current.settingsRevision;
  }
  return next;
}
