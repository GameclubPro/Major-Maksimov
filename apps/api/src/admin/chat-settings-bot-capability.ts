import type { ChatSettings } from '@maxim/contracts';
import type { BotCapabilityPermission } from './bot-capability-required.error';

export type ChatSettingsBotCapabilityRequirement = {
  permission: Extract<BotCapabilityPermission, 'write' | 'add_remove_members'>;
  featureKeys: string[];
};

const WRITE_ENABLE_KEYS = [
  'reportsEnabled',
  'antiDuplicateEnabled',
  'duplicatePhotoEnabled',
  'greetingEnabled',
  'requiredSubscriptionEnabled',
  'invitationAccessEnabled',
  'deleteBotMessagesEnabled',
  'antiSpamEnabled',
  'slowModeEnabled',
  'mediaMessageCooldownEnabled',
  'messageCountLimitEnabled',
  'maxMessageLengthEnabled',
  'photoMessageCooldownEnabled',
  'stickerMessageCooldownEnabled',
  'russianProfanityFilterEnabled',
  'commercialAdsFilterEnabled',
  'messageLimitsImageTextScanEnabled',
  'nightModeEnabled',
  'nightModeForceCloseEnabled',
] as const satisfies readonly (keyof ChatSettings)[];

const WRITE_DISABLE_KEYS = [
  'stickerMessagesEnabled',
  'photoMessagesEnabled',
  'videoMessagesEnabled',
  'fileMessagesEnabled',
  'voiceMessagesEnabled',
  'forwardedMessagesEnabled',
  'phoneNumbersEnabled',
] as const satisfies readonly (keyof ChatSettings)[];

const MEMBER_MANAGEMENT_ENABLE_KEYS = [
  'antiSpamEnabled',
  'removeBotsFromGroupEnabled',
  'deleteSpammersEnabled',
] as const satisfies readonly (keyof ChatSettings)[];

type EffectiveParent = (settings: ChatSettings) => boolean;

const linkModerationActive: EffectiveParent = (settings) => settings.linkPolicy !== 'ALERT_ONLY';
const duplicateModerationActive: EffectiveParent = (settings) =>
  settings.antiDuplicateEnabled || settings.duplicatePhotoEnabled;
const messageLimitsModerationActive: EffectiveParent = (settings) =>
  settings.antiSpamEnabled ||
  settings.messageCountLimitEnabled ||
  settings.maxMessageLengthEnabled ||
  settings.photoMessageCooldownEnabled ||
  settings.stickerMessageCooldownEnabled ||
  !settings.photoMessagesEnabled ||
  !settings.videoMessagesEnabled ||
  !settings.fileMessagesEnabled ||
  !settings.voiceMessagesEnabled ||
  !settings.forwardedMessagesEnabled ||
  settings.messageLimitsBlockedWords.length > 0 ||
  settings.messageLimitsBlockedDomains.length > 0;

const WRITE_SUBFEATURES = [
  ['linkBotMessageEnabled', linkModerationActive],
  ['linkWarnEnabled', linkModerationActive],
  ['linkMuteEnabled', linkModerationActive],
  ['greetingBotMessageEnabled', (settings: ChatSettings) => settings.greetingEnabled],
  [
    'greetingDeleteBotMessageEnabled',
    (settings: ChatSettings) => settings.greetingEnabled && settings.greetingBotMessageEnabled,
  ],
  [
    'profanityBotMessageEnabled',
    (settings: ChatSettings) => settings.russianProfanityFilterEnabled,
  ],
  ['profanityWarnEnabled', (settings: ChatSettings) => settings.russianProfanityFilterEnabled],
  ['profanityMuteEnabled', (settings: ChatSettings) => settings.russianProfanityFilterEnabled],
  ['textFiltersBotMessageEnabled', (settings: ChatSettings) => settings.commercialAdsFilterEnabled],
  ['textFiltersWarnEnabled', (settings: ChatSettings) => settings.commercialAdsFilterEnabled],
  ['textFiltersMuteEnabled', (settings: ChatSettings) => settings.commercialAdsFilterEnabled],
  ['duplicateBotMessageEnabled', duplicateModerationActive],
  ['duplicateWarnEnabled', duplicateModerationActive],
  ['duplicateMuteEnabled', duplicateModerationActive],
  ['messageLimitsBotMessageEnabled', messageLimitsModerationActive],
  ['messageLimitsWarnEnabled', messageLimitsModerationActive],
  ['messageLimitsMuteEnabled', messageLimitsModerationActive],
  ['phoneNumbersBotMessageEnabled', (settings: ChatSettings) => !settings.phoneNumbersEnabled],
  ['phoneNumbersWarnEnabled', (settings: ChatSettings) => !settings.phoneNumbersEnabled],
  ['phoneNumbersMuteEnabled', (settings: ChatSettings) => !settings.phoneNumbersEnabled],
  ['nightModeBotMessageEnabled', (settings: ChatSettings) => settings.nightModeEnabled],
  ['nightModeOpenMessageEnabled', (settings: ChatSettings) => settings.nightModeEnabled],
  [
    'requiredSubscriptionBotMessageEnabled',
    (settings: ChatSettings) => settings.requiredSubscriptionEnabled,
  ],
  [
    'requiredSubscriptionWarnEnabled',
    (settings: ChatSettings) => settings.requiredSubscriptionEnabled,
  ],
  [
    'requiredSubscriptionMuteEnabled',
    (settings: ChatSettings) => settings.requiredSubscriptionEnabled,
  ],
  [
    'invitationAccessBotMessageEnabled',
    (settings: ChatSettings) => settings.invitationAccessEnabled,
  ],
  ['invitationAccessWarnEnabled', (settings: ChatSettings) => settings.invitationAccessEnabled],
  ['invitationAccessMuteEnabled', (settings: ChatSettings) => settings.invitationAccessEnabled],
] as const satisfies readonly [keyof ChatSettings, EffectiveParent][];

const MEMBER_MANAGEMENT_SUBFEATURES = [
  ['linkBanEnabled', linkModerationActive],
  ['profanityBanEnabled', (settings: ChatSettings) => settings.russianProfanityFilterEnabled],
  ['textFiltersBanEnabled', (settings: ChatSettings) => settings.commercialAdsFilterEnabled],
  ['duplicateBanEnabled', duplicateModerationActive],
  ['messageLimitsBanEnabled', messageLimitsModerationActive],
  ['phoneNumbersBanEnabled', (settings: ChatSettings) => !settings.phoneNumbersEnabled],
  [
    'requiredSubscriptionBanEnabled',
    (settings: ChatSettings) => settings.requiredSubscriptionEnabled,
  ],
  ['invitationAccessBanEnabled', (settings: ChatSettings) => settings.invitationAccessEnabled],
] as const satisfies readonly [keyof ChatSettings, EffectiveParent][];

const DUPLICATE_PARENT_FEATURE_KEYS = [
  'antiDuplicateEnabled',
  'duplicatePhotoEnabled',
] as const satisfies readonly (keyof ChatSettings)[];
const MESSAGE_LIMITS_PARENT_FEATURE_KEYS = [
  'antiSpamEnabled',
  'messageCountLimitEnabled',
  'maxMessageLengthEnabled',
  'photoMessageCooldownEnabled',
  'stickerMessageCooldownEnabled',
  'photoMessagesEnabled',
  'videoMessagesEnabled',
  'fileMessagesEnabled',
  'voiceMessagesEnabled',
  'forwardedMessagesEnabled',
  'messageLimitsBlockedWords',
  'messageLimitsBlockedDomains',
] as const satisfies readonly (keyof ChatSettings)[];

export const CHAT_SETTINGS_BOT_CAPABILITY_SELECT = {
  reportsEnabled: true,
  reportsThreshold: true,
  reportsAliases: true,
  reportsDeleteMode: true,
  reportsMuteEnabled: true,
  reportsMuteDurationHours: true,
  antiDuplicateEnabled: true,
  duplicatePhotoEnabled: true,
  greetingEnabled: true,
  requiredSubscriptionEnabled: true,
  invitationAccessEnabled: true,
  deleteBotMessagesEnabled: true,
  antiSpamEnabled: true,
  slowModeEnabled: true,
  slowModeIntervalSeconds: true,
  mediaMessageCooldownEnabled: true,
  mediaMessageCooldownSeconds: true,
  stickerMessagesEnabled: true,
  messageCountLimitEnabled: true,
  maxMessageLengthEnabled: true,
  photoMessageCooldownEnabled: true,
  stickerMessageCooldownEnabled: true,
  russianProfanityFilterEnabled: true,
  commercialAdsFilterEnabled: true,
  nightModeEnabled: true,
  nightModeForceCloseEnabled: true,
  linkPolicy: true,
  photoMessagesEnabled: true,
  videoMessagesEnabled: true,
  fileMessagesEnabled: true,
  voiceMessagesEnabled: true,
  forwardedMessagesEnabled: true,
  phoneNumbersEnabled: true,
  removeBotsFromGroupEnabled: true,
  deleteSpammersEnabled: true,
  messageLimitsBlockedWords: true,
  messageLimitsBlockedDomains: true,
  messageLimitsImageTextScanEnabled: true,
  linkBotMessageEnabled: true,
  linkWarnEnabled: true,
  linkMuteEnabled: true,
  greetingBotMessageEnabled: true,
  greetingDeleteBotMessageEnabled: true,
  profanityBotMessageEnabled: true,
  profanityWarnEnabled: true,
  profanityMuteEnabled: true,
  textFiltersBotMessageEnabled: true,
  textFiltersWarnEnabled: true,
  textFiltersMuteEnabled: true,
  duplicateBotMessageEnabled: true,
  duplicateWarnEnabled: true,
  duplicateMuteEnabled: true,
  messageLimitsBotMessageEnabled: true,
  messageLimitsWarnEnabled: true,
  messageLimitsMuteEnabled: true,
  phoneNumbersBotMessageEnabled: true,
  phoneNumbersWarnEnabled: true,
  phoneNumbersMuteEnabled: true,
  nightModeBotMessageEnabled: true,
  nightModeOpenMessageEnabled: true,
  requiredSubscriptionBotMessageEnabled: true,
  requiredSubscriptionWarnEnabled: true,
  requiredSubscriptionMuteEnabled: true,
  invitationAccessBotMessageEnabled: true,
  invitationAccessWarnEnabled: true,
  invitationAccessMuteEnabled: true,
  linkBanEnabled: true,
  profanityBanEnabled: true,
  textFiltersBanEnabled: true,
  duplicateBanEnabled: true,
  messageLimitsBanEnabled: true,
  phoneNumbersBanEnabled: true,
  requiredSubscriptionBanEnabled: true,
  invitationAccessBanEnabled: true,
} as const satisfies Partial<Record<keyof ChatSettings, true>>;

function hasOwnSetting(value: unknown, key: keyof ChatSettings): boolean {
  return Boolean(
    value && typeof value === 'object' && !Array.isArray(value) && Object.hasOwn(value, key),
  );
}

function transitionedBoolean(params: {
  current: ChatSettings;
  next: ChatSettings;
  requestedSettings: unknown;
  key: keyof ChatSettings;
  from: boolean;
  to: boolean;
}): boolean {
  return (
    hasOwnSetting(params.requestedSettings, params.key) &&
    params.current[params.key] === params.from &&
    params.next[params.key] === params.to
  );
}

// FLAG: Retained legacy sanctions have no effects in AI delete-only mode. Never
// rewrite stored policy or waive another rule's current capability requirements.
function inactiveCommercialFeature(key: keyof ChatSettings, commercialAiDeleteOnly?: boolean) {
  return commercialAiDeleteOnly === true && key.startsWith('textFilters');
}

export function resolveChatSettingsBotCapabilityRequirements(params: {
  current: ChatSettings;
  next: ChatSettings;
  requestedSettings: unknown;
  commercialAiDeleteOnly?: boolean;
}): ChatSettingsBotCapabilityRequirement[] {
  const writeFeatureKeys = new Set<string>();
  const memberManagementFeatureKeys = new Set<string>();

  for (const key of WRITE_ENABLE_KEYS) {
    if (transitionedBoolean({ ...params, key, from: false, to: true })) {
      writeFeatureKeys.add(key);
    }
  }
  if (
    !params.current.requiredSubscriptionEnabled &&
    params.next.requiredSubscriptionEnabled &&
    hasOwnSetting(params.requestedSettings, 'requiredSubscriptionChannelIds')
  ) {
    writeFeatureKeys.add('requiredSubscriptionEnabled');
    writeFeatureKeys.add('requiredSubscriptionChannelIds');
  }
  for (const key of WRITE_DISABLE_KEYS) {
    if (transitionedBoolean({ ...params, key, from: true, to: false })) {
      writeFeatureKeys.add(key);
    }
  }
  if (
    hasOwnSetting(params.requestedSettings, 'linkPolicy') &&
    params.current.linkPolicy === 'ALERT_ONLY' &&
    params.next.linkPolicy !== 'ALERT_ONLY'
  ) {
    writeFeatureKeys.add('linkPolicy');
  }
  for (const key of [
    'messageLimitsBlockedWords',
    'messageLimitsBlockedDomains',
  ] as const satisfies readonly (keyof ChatSettings)[]) {
    if (
      hasOwnSetting(params.requestedSettings, key) &&
      params.current[key].length === 0 &&
      params.next[key].length > 0
    ) {
      writeFeatureKeys.add(key);
    }
  }

  for (const [key, parentActive] of WRITE_SUBFEATURES) {
    if (
      !inactiveCommercialFeature(key, params.commercialAiDeleteOnly) &&
      parentActive(params.next) &&
      transitionedBoolean({ ...params, key, from: false, to: true })
    ) {
      writeFeatureKeys.add(key);
    }
  }

  for (const key of MEMBER_MANAGEMENT_ENABLE_KEYS) {
    if (!transitionedBoolean({ ...params, key, from: false, to: true })) {
      continue;
    }
    memberManagementFeatureKeys.add(key);
    writeFeatureKeys.add(key);
  }
  for (const [key, parentActive] of MEMBER_MANAGEMENT_SUBFEATURES) {
    if (
      inactiveCommercialFeature(key, params.commercialAiDeleteOnly) ||
      !parentActive(params.next) ||
      !transitionedBoolean({ ...params, key, from: false, to: true })
    ) {
      continue;
    }
    memberManagementFeatureKeys.add(key);
    writeFeatureKeys.add(key);
  }

  const addActivatedParentMemberRequirements = (
    activated: boolean,
    banEnabled: boolean,
    parentFeatureKeys: readonly (keyof ChatSettings)[],
  ) => {
    if (!activated || !banEnabled) {
      return;
    }
    for (const featureKey of parentFeatureKeys) {
      if (writeFeatureKeys.has(featureKey)) {
        memberManagementFeatureKeys.add(featureKey);
      }
    }
  };
  addActivatedParentMemberRequirements(
    params.current.linkPolicy === 'ALERT_ONLY' && params.next.linkPolicy !== 'ALERT_ONLY',
    params.next.linkBanEnabled,
    ['linkPolicy'],
  );
  addActivatedParentMemberRequirements(
    !params.current.russianProfanityFilterEnabled && params.next.russianProfanityFilterEnabled,
    params.next.profanityBanEnabled,
    ['russianProfanityFilterEnabled'],
  );
  addActivatedParentMemberRequirements(
    !params.current.commercialAdsFilterEnabled && params.next.commercialAdsFilterEnabled,
    params.commercialAiDeleteOnly !== true && params.next.textFiltersBanEnabled,
    ['commercialAdsFilterEnabled'],
  );
  addActivatedParentMemberRequirements(
    !duplicateModerationActive(params.current) && duplicateModerationActive(params.next),
    params.next.duplicateBanEnabled,
    DUPLICATE_PARENT_FEATURE_KEYS,
  );
  addActivatedParentMemberRequirements(
    !messageLimitsModerationActive(params.current) && messageLimitsModerationActive(params.next),
    params.next.messageLimitsBanEnabled,
    MESSAGE_LIMITS_PARENT_FEATURE_KEYS,
  );
  addActivatedParentMemberRequirements(
    params.current.phoneNumbersEnabled && !params.next.phoneNumbersEnabled,
    params.next.phoneNumbersBanEnabled,
    ['phoneNumbersEnabled'],
  );
  addActivatedParentMemberRequirements(
    !params.current.requiredSubscriptionEnabled && params.next.requiredSubscriptionEnabled,
    params.next.requiredSubscriptionBanEnabled,
    ['requiredSubscriptionEnabled', 'requiredSubscriptionChannelIds'],
  );
  addActivatedParentMemberRequirements(
    !params.current.invitationAccessEnabled && params.next.invitationAccessEnabled,
    params.next.invitationAccessBanEnabled,
    ['invitationAccessEnabled'],
  );

  const requirements: ChatSettingsBotCapabilityRequirement[] = [];
  if (writeFeatureKeys.size > 0) {
    requirements.push({ permission: 'write', featureKeys: [...writeFeatureKeys] });
  }
  if (memberManagementFeatureKeys.size > 0) {
    requirements.push({
      permission: 'add_remove_members',
      featureKeys: [...memberManagementFeatureKeys],
    });
  }
  return requirements;
}

/** Current duties, including inherited defaults, when choosing a different moderator. */
export function currentChatSettingsBotCapabilityRequirements(
  settings: ChatSettings,
  commercialAiDeleteOnly = false,
): ChatSettingsBotCapabilityRequirement[] {
  const write = new Set<string>();
  const member = new Set<string>();
  for (const key of WRITE_ENABLE_KEYS) if (settings[key]) write.add(key);
  for (const key of WRITE_DISABLE_KEYS) if (!settings[key]) write.add(key);
  if (linkModerationActive(settings)) write.add('linkPolicy');
  for (const key of ['messageLimitsBlockedWords', 'messageLimitsBlockedDomains'] as const)
    if (settings[key].length > 0) write.add(key);
  for (const [key, active] of WRITE_SUBFEATURES)
    if (
      !inactiveCommercialFeature(key, commercialAiDeleteOnly) &&
      active(settings) &&
      settings[key]
    )
      write.add(key);
  for (const key of MEMBER_MANAGEMENT_ENABLE_KEYS) if (settings[key]) member.add(key);
  for (const [key, active] of MEMBER_MANAGEMENT_SUBFEATURES)
    if (
      !inactiveCommercialFeature(key, commercialAiDeleteOnly) &&
      active(settings) &&
      settings[key]
    )
      member.add(key);
  if (settings.stopWordsPolicy?.enabled) {
    write.add('stopWordsPolicy');
    if (
      settings.stopWordsPolicy.sanctions.muteEnabled ||
      settings.stopWordsPolicy.sanctions.banEnabled
    )
      member.add('stopWordsPolicy');
  }
  for (const key of member) write.add(key);
  return [
    ...(write.size ? [{ permission: 'write' as const, featureKeys: [...write] }] : []),
    ...(member.size
      ? [{ permission: 'add_remove_members' as const, featureKeys: [...member] }]
      : []),
  ];
}
