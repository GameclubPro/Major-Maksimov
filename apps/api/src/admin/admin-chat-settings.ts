import {
  assertFixedModeratorCapabilitiesForSettings,
  chatSettingsCapabilityPurposes,
} from '../max/fixed-moderator-capabilities';
import {
  ADMIN_BAN_ALL_COMMAND_NAME_DEFAULT,
  ADMIN_BAN_COMMAND_NAME_DEFAULT,
  ADMIN_MUTE_COMMAND_NAME_DEFAULT,
  ADMIN_OPEN_CHAT_COMMAND_NAME_DEFAULT,
  ADMIN_PERMANENT_MUTE_COMMAND_NAME_DEFAULT,
  ADMIN_RULES_COMMAND_NAME_DEFAULT,
  ADMIN_SILENCE_COMMAND_NAME_DEFAULT,
  botSpeechMediaSchema,
  chatSettingsSchema,
  DUPLICATE_WINDOW_MAX_SEC,
  DUPLICATE_WINDOW_SETTING_KEYS,
  INVITATION_ACCESS_REQUIRED_COUNT_MAX,
  INVITATION_ACCESS_REQUIRED_COUNT_MIN,
  normalizeHttpButtonUrl,
  normalizeMessageLimitsBlockedDomainCandidate,
  normalizeMessageLimitsBlockedWordCandidate,
  REQUIRED_SUBSCRIPTION_DURATION_DAYS_MAX,
  REQUIRED_SUBSCRIPTION_DURATION_DAYS_MIN,
  updateSettingsRequestSchema,
  type BroadcastLinkButton,
  type BotSpeechMedia,
  type ChatSettings,
} from '@maxim/contracts';
import {
  stopWordsMediaSchema,
  stopWordsPolicySchema,
  type StopWordsStorageStatus,
} from '@maxim/contracts/settings';
import { BadRequestException, ConflictException, type Logger } from '@nestjs/common';
import { isDeepStrictEqual } from 'node:util';
import type { NetworkSettingsWriteOptions } from './network-settings-write';
import {
  assertLegacyStopWordsWrite,
  omitLegacyStopWordsSettings,
  omitStopWordsPolicy,
} from './stop-words-settings-ownership';
import {
  migrateStopWordsPolicy,
  readStopWordsPolicy,
} from '../moderation/stop-words/stop-words.policy';
import { readStopWordsStorageStatus } from '../moderation/stop-words/stop-words-storage-status';
import type { ChatContextCacheService } from '../chat-context/chat-context-cache.service';
import {
  ChatCatalogKind,
  ChatEntityType,
  type ChatSettings as StoredChatSettings,
} from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import {
  CHAT_SETTINGS_BUTTON_GROUPS,
  DEFAULT_CHAT_SETTINGS,
  REQUIRED_SUBSCRIPTION_SETTING_KEYS,
  type AdminActionSource,
} from './admin.service.support';
import { buildStoredLinkButtonState } from './admin-chat-rules';
import {
  DEFAULT_PUBLISHER_OWNED_CHAT_SETTINGS,
  omitPublisherOwnedChatSettings,
} from './publisher-owned-chat-settings';
import {
  CHAT_SETTINGS_BOT_CAPABILITY_SELECT,
  resolveChatSettingsBotCapabilityRequirements,
  type ChatSettingsBotCapabilityRequirement,
} from './chat-settings-bot-capability';
import { assertReportsActivationAvailable } from './report-settings-availability';
import { advanceChatMutationOrder } from '../common/group-command-authority.service';

function readLegacyPrimaryAdminCommandName(value: unknown, fallback: string): string {
  if (typeof value !== 'string') {
    return fallback;
  }
  return (
    value
      .split(',')
      .map((item) => item.trim().replace(/\s+/g, ' '))
      .find((item) => item.length > 0) ?? fallback
  );
}

export type ChatSettingsCurrentState = Pick<
  ChatSettings,
  | 'nightModeForceCloseEnabled'
  | 'nightModeForceCloseForever'
  | 'nightModeForceCloseHours'
  | 'nightModeForceCloseDays'
  | 'nightModeForceCloseUntil'
>;

// Compatibility data for Chat create branches; existing routes are owned by MaxBotLinkService.
export type ResolvedBotAssignmentData = {
  botId?: string;
  primaryBotId?: string;
};

export const UPDATE_SETTINGS_AUDIT_PAYLOAD_MAX_SERIALIZED_BYTES = 16 * 1024;

type UpdateSettingsAuditMediaEntry = {
  key: string;
  mimeType: string | null;
  byteCount: number;
};

export type UpdateSettingsAuditPayload = {
  source: AdminActionSource;
  settingKeys: Array<keyof ChatSettings>;
  botSpeechMedia?: UpdateSettingsAuditMediaEntry[];
};

const CHAT_SETTINGS_ADMIN_CONTACT_BUTTON_GROUPS = [
  {
    enabled: 'requiredSubscriptionAdminContactButtonEnabled',
    url: 'requiredSubscriptionAdminContactButtonUrl',
  },
  {
    enabled: 'invitationAccessAdminContactButtonEnabled',
    url: 'invitationAccessAdminContactButtonUrl',
  },
  {
    enabled: 'messageLimitsAdminContactButtonEnabled',
    url: 'messageLimitsAdminContactButtonUrl',
  },
  {
    enabled: 'phoneNumbersAdminContactButtonEnabled',
    url: 'phoneNumbersAdminContactButtonUrl',
  },
  {
    enabled: 'profanityAdminContactButtonEnabled',
    url: 'profanityAdminContactButtonUrl',
  },
  {
    enabled: 'textFiltersAdminContactButtonEnabled',
    url: 'textFiltersAdminContactButtonUrl',
  },
  {
    enabled: 'linkAdminContactButtonEnabled',
    url: 'linkAdminContactButtonUrl',
  },
  {
    enabled: 'duplicateAdminContactButtonEnabled',
    url: 'duplicateAdminContactButtonUrl',
  },
] as const;

function readTrimmedString(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeAdminContactButtonUrl(value: unknown): string {
  const trimmed = readTrimmedString(value);
  return trimmed ? (normalizeHttpButtonUrl(trimmed) ?? '') : '';
}

export function areBroadcastButtonsEqual(
  left: readonly BroadcastLinkButton[],
  right: unknown,
): boolean {
  if (!Array.isArray(right)) {
    return left.length === 0;
  }

  if (left.length !== right.length) {
    return false;
  }

  return left.every((button, index) => {
    const candidate = right[index];
    if (!candidate || typeof candidate !== 'object') {
      return false;
    }

    const row = candidate as { text?: unknown; url?: unknown };
    return row.text === button.text && row.url === button.url;
  });
}

export function isRequiredSubscriptionCurrentlyActive(
  settings: Pick<ChatSettings, 'requiredSubscriptionEnabled' | 'requiredSubscriptionChannelIds'>,
): boolean {
  return settings.requiredSubscriptionEnabled && settings.requiredSubscriptionChannelIds.length > 0;
}

function normalizeRequiredSubscriptionSettings(settings: ChatSettings): ChatSettings {
  const requiredSubscriptionChannelIds = Array.from(
    new Set(
      settings.requiredSubscriptionChannelIds
        .map((item) => item.trim())
        .filter((item) => item.length > 0),
    ),
  );
  const requiredSubscriptionDurationDays = Math.min(
    REQUIRED_SUBSCRIPTION_DURATION_DAYS_MAX,
    Math.max(
      REQUIRED_SUBSCRIPTION_DURATION_DAYS_MIN,
      Math.round(Number(settings.requiredSubscriptionDurationDays)),
    ),
  );
  const requiredSubscriptionEnabled = requiredSubscriptionChannelIds.length > 0;

  return {
    ...settings,
    requiredSubscriptionEnabled,
    requiredSubscriptionChannelIds,
    requiredSubscriptionBotMessageEnabled: requiredSubscriptionEnabled,
    requiredSubscriptionDurationDays,
    requiredSubscriptionExpiresAt: '',
  };
}

function normalizeInvitationAccessSettings(settings: ChatSettings): ChatSettings {
  const invitationAccessRequiredCount = Math.min(
    INVITATION_ACCESS_REQUIRED_COUNT_MAX,
    Math.max(
      INVITATION_ACCESS_REQUIRED_COUNT_MIN,
      Math.round(Number(settings.invitationAccessRequiredCount)),
    ),
  );

  return { ...settings, invitationAccessEnabled: false, invitationAccessRequiredCount };
}

function normalizeMessageLimitsBlockedLists(settings: ChatSettings): ChatSettings {
  const messageLimitsBlockedWords = Array.from(
    new Set(
      settings.messageLimitsBlockedWords.flatMap(
        (item) => normalizeMessageLimitsBlockedWordCandidate(item) ?? [],
      ),
    ),
  );
  const messageLimitsBlockedDomains = Array.from(
    new Set(
      settings.messageLimitsBlockedDomains.flatMap(
        (item) => normalizeMessageLimitsBlockedDomainCandidate(item) ?? [],
      ),
    ),
  );
  return {
    ...settings,
    messageLimitsBlockedWords,
    messageLimitsBlockedDomains,
  };
}

function areBotSpeechMediaEqual(left: unknown, right: unknown): boolean {
  // FLAG: JSONB property order must not cause a media repair or duplicate TOAST rewrite.
  return isDeepStrictEqual(left ?? {}, right ?? {});
}

function readBotSpeechMediaRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readAuditMediaEntry(value: unknown): { base64: string; mimeType: string } | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  const media = value as Record<string, unknown>;
  return {
    base64: typeof media.base64 === 'string' ? media.base64 : '',
    mimeType: typeof media.mimeType === 'string' ? media.mimeType : '',
  };
}

export function buildUpdateSettingsAuditPayload(params: {
  requestedSettings: unknown;
  normalizedSettings: ChatSettings;
  source: AdminActionSource;
}): UpdateSettingsAuditPayload {
  const requested =
    params.requestedSettings &&
    typeof params.requestedSettings === 'object' &&
    !Array.isArray(params.requestedSettings)
      ? (params.requestedSettings as Record<string, unknown>)
      : {};
  const normalizedKeySet = new Set(Object.keys(params.normalizedSettings));
  const settingKeys = (Object.keys(requested) as Array<keyof ChatSettings>)
    .filter((key) => normalizedKeySet.has(key))
    .sort();
  const payload: UpdateSettingsAuditPayload = {
    source: params.source,
    settingKeys,
  };

  if (!settingKeys.includes('botSpeechMedia')) {
    return payload;
  }

  const requestedMedia = readBotSpeechMediaRecord(requested.botSpeechMedia);
  const nextMedia = readBotSpeechMediaRecord(params.normalizedSettings.botSpeechMedia);
  const mediaKeys = Object.keys(requestedMedia)
    .filter((key) => Object.hasOwn(nextMedia, key))
    .sort();
  payload.botSpeechMedia = mediaKeys.map((key) => {
    const media = readAuditMediaEntry(nextMedia[key]);
    return {
      key,
      mimeType: media?.mimeType || null,
      byteCount: media ? Buffer.byteLength(media.base64, 'base64') : 0,
    };
  });

  return payload;
}

function normalizeBotSpeechMedia(settings: ChatSettings): ChatSettings {
  const parsed = botSpeechMediaSchema.safeParse(settings.botSpeechMedia);
  const botSpeechMedia: BotSpeechMedia = parsed.success ? parsed.data : {};
  return areBotSpeechMediaEqual(settings.botSpeechMedia, botSpeechMedia)
    ? settings
    : {
        ...settings,
        botSpeechMedia,
      };
}

function isFutureIsoTimestamp(value: string): boolean {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && timestamp > Date.now();
}

function normalizeNightModeForceCloseSettings(
  settings: ChatSettings,
  currentState?: Pick<
    ChatSettings,
    | 'nightModeForceCloseEnabled'
    | 'nightModeForceCloseForever'
    | 'nightModeForceCloseHours'
    | 'nightModeForceCloseDays'
    | 'nightModeForceCloseUntil'
  > | null,
): ChatSettings {
  if (!settings.nightModeForceCloseEnabled) {
    return settings.nightModeForceCloseUntil
      ? {
          ...settings,
          nightModeForceCloseUntil: '',
        }
      : settings;
  }

  if (settings.nightModeForceCloseForever) {
    return settings.nightModeForceCloseUntil
      ? {
          ...settings,
          nightModeForceCloseUntil: '',
        }
      : settings;
  }

  const totalHours = settings.nightModeForceCloseDays * 24 + settings.nightModeForceCloseHours;
  if (totalHours <= 0) {
    return {
      ...settings,
      nightModeForceCloseEnabled: false,
      nightModeForceCloseUntil: '',
    };
  }

  if (!currentState) {
    return isFutureIsoTimestamp(settings.nightModeForceCloseUntil)
      ? settings
      : {
          ...settings,
          nightModeForceCloseEnabled: false,
          nightModeForceCloseUntil: '',
        };
  }

  const currentUntil = currentState?.nightModeForceCloseUntil ?? '';
  const shouldRefreshUntil =
    !currentState?.nightModeForceCloseEnabled ||
    currentState.nightModeForceCloseForever ||
    currentState.nightModeForceCloseHours !== settings.nightModeForceCloseHours ||
    currentState.nightModeForceCloseDays !== settings.nightModeForceCloseDays ||
    !isFutureIsoTimestamp(currentUntil);

  const nextUntil = shouldRefreshUntil
    ? new Date(Date.now() + totalHours * 60 * 60 * 1_000).toISOString()
    : currentUntil;

  return {
    ...settings,
    nightModeForceCloseUntil: nextUntil,
  };
}

function normalizeNightModeSettings(
  settings: ChatSettings,
  currentState?: Pick<
    ChatSettings,
    | 'nightModeForceCloseEnabled'
    | 'nightModeForceCloseForever'
    | 'nightModeForceCloseHours'
    | 'nightModeForceCloseDays'
    | 'nightModeForceCloseUntil'
  > | null,
): ChatSettings {
  let normalized = settings;

  if (!normalized.nightModeEnabled) {
    normalized = {
      ...normalized,
      nightModeBotMessageEnabled: false,
      nightModeCommentsEnabled: false,
      nightModeBotButtonEnabled: false,
      nightModeRulesButtonEnabled: false,
    };
  } else if (!normalized.nightModeBotMessageEnabled) {
    normalized = {
      ...normalized,
      nightModeCommentsEnabled: false,
      nightModeBotButtonEnabled: false,
      nightModeRulesButtonEnabled: false,
    };
  }

  return normalizeNightModeForceCloseSettings(normalized, currentState);
}

export function normalizeChatSettingsButtonUrls(settings: ChatSettings): ChatSettings {
  let normalizedSettings = settings;

  for (const group of CHAT_SETTINGS_BUTTON_GROUPS) {
    const buttonState = buildStoredLinkButtonState(normalizedSettings[group.buttons], {
      buttonUrl: normalizedSettings[group.url],
      buttonText: normalizedSettings[group.text],
    });
    const shouldDisableButton =
      buttonState.buttons.length === 0 && normalizedSettings[group.enabled];
    if (
      !areBroadcastButtonsEqual(buttonState.buttons, normalizedSettings[group.buttons]) ||
      buttonState.buttonUrl !== normalizedSettings[group.url] ||
      buttonState.buttonText !== normalizedSettings[group.text] ||
      shouldDisableButton
    ) {
      normalizedSettings = {
        ...normalizedSettings,
        [group.buttons]: buttonState.buttons,
        [group.url]: buttonState.buttonUrl,
        [group.text]: buttonState.buttonText,
        ...(shouldDisableButton ? { [group.enabled]: false } : {}),
      };
    }
  }

  for (const group of CHAT_SETTINGS_ADMIN_CONTACT_BUTTON_GROUPS) {
    const currentUrl = normalizedSettings[group.url];
    const normalizedUrl = normalizeAdminContactButtonUrl(currentUrl);
    const shouldDisableButton =
      normalizedSettings[group.enabled] === true && normalizedUrl.length === 0;
    if (currentUrl !== normalizedUrl || shouldDisableButton) {
      normalizedSettings = {
        ...normalizedSettings,
        [group.url]: normalizedUrl,
        ...(shouldDisableButton ? { [group.enabled]: false } : {}),
      };
    }
  }

  return normalizedSettings;
}

export function normalizeChatSettings(
  settings: ChatSettings,
  currentState?: ChatSettingsCurrentState | null,
  chatId?: string,
): ChatSettings {
  const normalized = normalizeNightModeSettings(
    normalizeBotSpeechMedia(
      normalizeInvitationAccessSettings(
        normalizeMessageLimitsBlockedLists(normalizeRequiredSubscriptionSettings(settings)),
      ),
    ),
    currentState,
  );

  return chatId ? normalizeChatSettingsButtonUrls(normalized) : normalized;
}

export function sanitizeStoredChatSettings(settings: unknown): unknown {
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
    return settings;
  }

  let normalizedSettings = settings as Record<string, unknown>;
  // FLAG: Normalize only legacy window values before parsing. Otherwise one old seven-day
  // value would reset all unrelated settings to defaults. Persist through the existing CAS.
  for (const key of DUPLICATE_WINDOW_SETTING_KEYS) {
    const seconds = normalizedSettings[key];
    if (
      typeof seconds === 'number' &&
      Number.isSafeInteger(seconds) &&
      seconds > DUPLICATE_WINDOW_MAX_SEC
    ) {
      normalizedSettings = { ...normalizedSettings, [key]: DUPLICATE_WINDOW_MAX_SEC };
    }
  }
  if (normalizedSettings.stopWordsPolicy != null) {
    // FLAG: An unsupported stop-list policy or media cannot reset unrelated settings or be
    // repaired by a GET. Disable only the returned copy; replacement requires the revision API.
    const storedStopWords = {
      stopWordsPolicy: normalizedSettings.stopWordsPolicy,
      stopWordsMedia: normalizedSettings.stopWordsMedia,
    };
    normalizedSettings = {
      ...normalizedSettings,
      stopWordsPolicy:
        readStopWordsStorageStatus(storedStopWords) === 'invalid'
          ? stopWordsPolicySchema.parse({})
          : readStopWordsPolicy(storedStopWords),
    };
  }
  if (
    normalizedSettings.stopWordsMedia != null &&
    !stopWordsMediaSchema.safeParse(normalizedSettings.stopWordsMedia).success
  ) {
    normalizedSettings = { ...normalizedSettings, stopWordsMedia: {} };
  }

  if (typeof normalizedSettings.adminBanCommandName !== 'string') {
    normalizedSettings = {
      ...normalizedSettings,
      adminBanCommandName: ADMIN_BAN_COMMAND_NAME_DEFAULT,
    };
  }
  if (typeof normalizedSettings.adminBanAllCommandName !== 'string') {
    normalizedSettings = {
      ...normalizedSettings,
      adminBanAllCommandName: ADMIN_BAN_ALL_COMMAND_NAME_DEFAULT,
    };
  }
  if (typeof normalizedSettings.adminMuteCommandName !== 'string') {
    normalizedSettings = {
      ...normalizedSettings,
      adminMuteCommandName: readLegacyPrimaryAdminCommandName(
        normalizedSettings.adminMuteCommandAliases,
        ADMIN_MUTE_COMMAND_NAME_DEFAULT,
      ),
    };
  }
  if (typeof normalizedSettings.adminPermanentMuteCommandName !== 'string') {
    normalizedSettings = {
      ...normalizedSettings,
      adminPermanentMuteCommandName: ADMIN_PERMANENT_MUTE_COMMAND_NAME_DEFAULT,
    };
  }
  if (typeof normalizedSettings.adminRulesCommandName !== 'string') {
    normalizedSettings = {
      ...normalizedSettings,
      adminRulesCommandName: readLegacyPrimaryAdminCommandName(
        normalizedSettings.adminRulesCommandAliases,
        ADMIN_RULES_COMMAND_NAME_DEFAULT,
      ),
    };
  }
  if (typeof normalizedSettings.adminSilenceCommandName !== 'string') {
    normalizedSettings = {
      ...normalizedSettings,
      adminSilenceCommandName: ADMIN_SILENCE_COMMAND_NAME_DEFAULT,
    };
  }
  if (typeof normalizedSettings.adminOpenChatCommandName !== 'string') {
    normalizedSettings = {
      ...normalizedSettings,
      adminOpenChatCommandName: ADMIN_OPEN_CHAT_COMMAND_NAME_DEFAULT,
    };
  }

  for (const group of CHAT_SETTINGS_BUTTON_GROUPS) {
    const buttonState = buildStoredLinkButtonState(normalizedSettings[group.buttons], {
      buttonUrl: normalizedSettings[group.url] as string | null | undefined,
      buttonText: normalizedSettings[group.text] as string | null | undefined,
    });
    const enabled = normalizedSettings[group.enabled] === true;
    const shouldDisableButton = enabled && buttonState.buttons.length === 0;
    const currentUrl = normalizedSettings[group.url];
    const currentText = normalizedSettings[group.text];
    const currentButtons = normalizedSettings[group.buttons];

    if (
      !areBroadcastButtonsEqual(buttonState.buttons, currentButtons) ||
      currentUrl !== buttonState.buttonUrl ||
      currentText !== buttonState.buttonText ||
      shouldDisableButton
    ) {
      normalizedSettings = {
        ...normalizedSettings,
        [group.buttons]: buttonState.buttons,
        [group.url]: buttonState.buttonUrl,
        [group.text]: buttonState.buttonText,
        ...(shouldDisableButton ? { [group.enabled]: false } : {}),
      };
    }
  }

  for (const group of CHAT_SETTINGS_ADMIN_CONTACT_BUTTON_GROUPS) {
    const currentUrl = normalizedSettings[group.url];
    const normalizedUrl = normalizeAdminContactButtonUrl(currentUrl);
    const shouldDisableButton =
      normalizedSettings[group.enabled] === true && normalizedUrl.length === 0;
    if (currentUrl !== normalizedUrl || shouldDisableButton) {
      normalizedSettings = {
        ...normalizedSettings,
        [group.url]: normalizedUrl,
        ...(shouldDisableButton ? { [group.enabled]: false } : {}),
      };
    }
  }

  return normalizedSettings;
}

export type PublicChatCommentSettings = Pick<
  ChatSettings,
  | 'commentsEnabled'
  | 'commentsAdminsEnabled'
  | 'commentsAllEnabled'
  | 'commentsChatBroadcastsEnabled'
>;

export async function readPublicChatCommentSettings(
  prisma: PrismaService,
  chatId: string,
): Promise<PublicChatCommentSettings> {
  const settings = await prisma.chatSettings.findUnique({ where: { chatId } });
  const parsed = settings
    ? chatSettingsSchema.safeParse(sanitizeStoredChatSettings(settings))
    : null;
  const normalized = parsed?.success
    ? normalizeChatSettings(parsed.data, undefined, chatId)
    : DEFAULT_CHAT_SETTINGS;
  return {
    commentsEnabled: normalized.commentsEnabled,
    commentsAdminsEnabled: normalized.commentsAdminsEnabled,
    commentsAllEnabled: normalized.commentsAllEnabled,
    commentsChatBroadcastsEnabled: normalized.commentsChatBroadcastsEnabled,
  };
}

export function getChatSettingsNormalizationChanges(
  current: ChatSettings,
  normalized: ChatSettings,
): Partial<ChatSettings> {
  const changes: Partial<ChatSettings> = {};

  for (const group of CHAT_SETTINGS_BUTTON_GROUPS) {
    if (!areBroadcastButtonsEqual(normalized[group.buttons], current[group.buttons])) {
      changes[group.buttons] = normalized[group.buttons];
    }
    if (current[group.url] !== normalized[group.url]) {
      changes[group.url] = normalized[group.url];
    }
    if (current[group.text] !== normalized[group.text]) {
      changes[group.text] = normalized[group.text];
    }
    if (current[group.enabled] !== normalized[group.enabled]) {
      changes[group.enabled] = normalized[group.enabled];
    }
  }

  if (current.nightModeBotMessageEnabled !== normalized.nightModeBotMessageEnabled) {
    changes.nightModeBotMessageEnabled = normalized.nightModeBotMessageEnabled;
  }
  if (current.nightModeCommentsEnabled !== normalized.nightModeCommentsEnabled) {
    changes.nightModeCommentsEnabled = normalized.nightModeCommentsEnabled;
  }
  if (current.nightModeBotButtonEnabled !== normalized.nightModeBotButtonEnabled) {
    changes.nightModeBotButtonEnabled = normalized.nightModeBotButtonEnabled;
  }
  if (current.nightModeRulesButtonEnabled !== normalized.nightModeRulesButtonEnabled) {
    changes.nightModeRulesButtonEnabled = normalized.nightModeRulesButtonEnabled;
  }
  if (current.nightModeForceCloseEnabled !== normalized.nightModeForceCloseEnabled) {
    changes.nightModeForceCloseEnabled = normalized.nightModeForceCloseEnabled;
  }
  if (current.nightModeForceCloseUntil !== normalized.nightModeForceCloseUntil) {
    changes.nightModeForceCloseUntil = normalized.nightModeForceCloseUntil;
  }
  if (
    current.requiredSubscriptionBotMessageEnabled !==
    normalized.requiredSubscriptionBotMessageEnabled
  ) {
    changes.requiredSubscriptionBotMessageEnabled =
      normalized.requiredSubscriptionBotMessageEnabled;
  }
  if (!areBotSpeechMediaEqual(current.botSpeechMedia, normalized.botSpeechMedia)) {
    changes.botSpeechMedia = normalized.botSpeechMedia;
  }

  return changes;
}

export function getStoredChatSettingsSanitizationChanges(
  current: unknown,
  sanitized: ChatSettings,
): Partial<ChatSettings> {
  if (!current || typeof current !== 'object' || Array.isArray(current)) {
    return {};
  }

  const currentSettings = current as Record<string, unknown>;
  const changes: Partial<ChatSettings> = {};
  for (const key of DUPLICATE_WINDOW_SETTING_KEYS) {
    if (currentSettings[key] !== sanitized[key]) changes[key] = sanitized[key];
  }
  if (!areBotSpeechMediaEqual(currentSettings.botSpeechMedia, sanitized.botSpeechMedia)) {
    changes.botSpeechMedia = sanitized.botSpeechMedia;
  }

  for (const group of CHAT_SETTINGS_BUTTON_GROUPS) {
    if (!areBroadcastButtonsEqual(sanitized[group.buttons], currentSettings[group.buttons])) {
      changes[group.buttons] = sanitized[group.buttons];
    }

    const currentUrl = readTrimmedString(currentSettings[group.url]) ?? '';
    if (currentUrl !== sanitized[group.url]) {
      changes[group.url] = sanitized[group.url];
    }

    const currentText = readTrimmedString(currentSettings[group.text]) ?? '';
    if (currentText !== sanitized[group.text]) {
      changes[group.text] = sanitized[group.text];
    }

    const currentEnabled = currentSettings[group.enabled] === true;
    if (currentEnabled !== sanitized[group.enabled]) {
      changes[group.enabled] = sanitized[group.enabled];
    }
  }

  for (const group of CHAT_SETTINGS_ADMIN_CONTACT_BUTTON_GROUPS) {
    const currentUrl = readTrimmedString(currentSettings[group.url]) ?? '';
    if (currentUrl !== sanitized[group.url]) {
      changes[group.url] = sanitized[group.url];
    }

    const currentEnabled = currentSettings[group.enabled] === true;
    if (currentEnabled !== sanitized[group.enabled]) {
      changes[group.enabled] = sanitized[group.enabled];
    }
  }

  return changes;
}

export type ChatSettingsReadSnapshot = {
  settings: ChatSettings;
  stopWordsStorageStatus: StopWordsStorageStatus;
};

type ChatSettingsReadRepair = Partial<ChatSettings> &
  Partial<Pick<StoredChatSettings, 'stopWordsMedia'>>;

const STOP_WORDS_READ_PRESERVED_SETTING_KEYS = [
  'stopWordsPolicy',
  'stopWordsMedia',
  'stopWordsRevision',
  'messageLimitsBlockedWords',
  'messageLimitsBlockedDomains',
  'messageLimitsImageTextScanEnabled',
  'messageLimitsBotMessageEnabled',
  'messageLimitsBotMessageText',
  'messageLimitsWarnEnabled',
  'messageLimitsWarnMessageText',
  'messageLimitsMuteEnabled',
  'messageLimitsMuteDurationHours',
  'messageLimitsBanEnabled',
  'messageLimitsBotButtonEnabled',
  'messageLimitsBotButtons',
  'messageLimitsBotButtonUrl',
  'messageLimitsBotButtonText',
  'messageLimitsAdminContactButtonEnabled',
  'messageLimitsAdminContactButtonUrl',
  'messageLimitsRulesButtonEnabled',
  'rulesAttachViolationsEnabled',
] as const satisfies readonly (keyof ChatSettingsReadRepair)[];

function preserveStopWordsOnSettingsRead(
  changes: ChatSettingsReadRepair,
  storedSettings: StoredChatSettings,
): Partial<ChatSettings> {
  // FLAG: Read repairs own unrelated settings only. Legacy rules and sanctions, like typed
  // policies, are normalized on copies until an administrator explicitly replaces the policy.
  const repair = { ...changes };
  for (const key of STOP_WORDS_READ_PRESERVED_SETTING_KEYS) delete repair[key];
  const media = storedSettings.botSpeechMedia;
  if (
    media &&
    typeof media === 'object' &&
    (Object.hasOwn(media, 'messageLimitsBotMessageText') ||
      Object.hasOwn(media, 'messageLimitsWarnMessageText'))
  ) {
    delete repair.botSpeechMedia;
  }
  return repair;
}

export async function readChatSettings(
  params: Parameters<typeof readChatSettingsSnapshot>[0],
): Promise<ChatSettings> {
  return (await readChatSettingsSnapshot(params)).settings;
}

function buildChatSettingsReadSnapshot(params: {
  normalizedSettings: ChatSettings;
  storedSettings: StoredChatSettings;
  logger: Pick<Logger, 'warn'>;
  chatId: string;
}): ChatSettingsReadSnapshot {
  const stopWordsStorageStatus = readStopWordsStorageStatus(params.storedSettings);
  let stopWordsPolicy =
    stopWordsStorageStatus === 'invalid'
      ? stopWordsPolicySchema.parse({})
      : params.normalizedSettings.stopWordsPolicy;
  if (stopWordsStorageStatus !== 'invalid') {
    try {
      stopWordsPolicy = migrateStopWordsPolicy(
        sanitizeStoredChatSettings({ ...params.storedSettings }) as StoredChatSettings,
      );
    } catch {
      params.logger.warn({ chatId: params.chatId }, 'Legacy stop-word policy requires review');
    }
  }
  return {
    settings: {
      ...params.normalizedSettings,
      settingsRevision: params.storedSettings.updatedAt?.toISOString(),
      stopWordsPolicy,
      stopWordsRevision: params.storedSettings.stopWordsRevision,
    },
    stopWordsStorageStatus,
  };
}

export async function readChatSettingsSnapshot(params: {
  prisma: PrismaService;
  chatContextCache: Pick<ChatContextCacheService, 'invalidate'>;
  logger: Pick<Logger, 'warn'>;
  chatId: string;
  botAssignmentData?: ResolvedBotAssignmentData;
}): Promise<ChatSettingsReadSnapshot> {
  const chat = await params.prisma.chat.upsert({
    where: { id: params.chatId },
    create: {
      id: params.chatId,
      title: `Chat ${params.chatId}`,
      entityType: ChatEntityType.CHAT,
      catalogKind: ChatCatalogKind.MANAGED,
      ...params.botAssignmentData,
      settings: {
        create: {},
      },
    },
    update: {
      catalogKind: ChatCatalogKind.MANAGED,
      settings: {
        upsert: {
          update: {},
          create: {},
        },
      },
    },
    include: { settings: true },
  });

  if (!chat.settings) {
    throw new Error('Chat settings missing after upsert');
  }

  const sanitizedStoredSettings = sanitizeStoredChatSettings(chat.settings);
  const parsed = chatSettingsSchema.safeParse(sanitizedStoredSettings);
  if (parsed.success) {
    let normalizedSettings = normalizeChatSettings(parsed.data, undefined, params.chatId);
    let responseStoredSettings = chat.settings;
    const normalizationChanges = preserveStopWordsOnSettingsRead(
      {
        ...getStoredChatSettingsSanitizationChanges(chat.settings, parsed.data),
        ...getChatSettingsNormalizationChanges(parsed.data, normalizedSettings),
      },
      chat.settings,
    );
    if (Object.keys(normalizationChanges).length > 0) {
      const repaired = await params.prisma.chatSettings.updateMany({
        where: { chatId: params.chatId, updatedAt: chat.settings.updatedAt },
        data: normalizationChanges,
      });
      if (repaired.count > 0) {
        await params.chatContextCache.invalidate(params.chatId);
      }
      // FLAG: A repair advances updatedAt. Refresh values and revision together, including a
      // concurrent winner, so an old settings snapshot never receives a newer write fence.
      const refreshed = await params.prisma.chatSettings.findUnique({
        where: { chatId: params.chatId },
      });
      if (refreshed) {
        const refreshedParsed = chatSettingsSchema.safeParse(sanitizeStoredChatSettings(refreshed));
        if (refreshedParsed.success) {
          responseStoredSettings = refreshed;
          normalizedSettings = normalizeChatSettings(
            refreshedParsed.data,
            undefined,
            params.chatId,
          );
        }
      }
    }

    return buildChatSettingsReadSnapshot({
      normalizedSettings,
      storedSettings: responseStoredSettings,
      logger: params.logger,
      chatId: params.chatId,
    });
  }

  params.logger.warn(
    {
      chatId: params.chatId,
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })),
    },
    'Invalid chat settings found in DB, applying defaults',
  );

  const fallback = DEFAULT_CHAT_SETTINGS;
  const fallbackRepair = preserveStopWordsOnSettingsRead(fallback, chat.settings);
  const repaired = await params.prisma.chatSettings.updateMany({
    where: { chatId: params.chatId, updatedAt: chat.settings.updatedAt },
    data: fallbackRepair,
  });
  if (repaired.count > 0) {
    await params.chatContextCache.invalidate(params.chatId);
  }

  const refreshed = await params.prisma.chatSettings.findUnique({
    where: { chatId: params.chatId },
  });
  const refreshedParsed =
    refreshed && chatSettingsSchema.safeParse(sanitizeStoredChatSettings(refreshed));
  if (refreshedParsed?.success) {
    return buildChatSettingsReadSnapshot({
      normalizedSettings: normalizeChatSettings(refreshedParsed.data, undefined, params.chatId),
      storedSettings: refreshed!,
      logger: params.logger,
      chatId: params.chatId,
    });
  }
  return buildChatSettingsReadSnapshot({
    normalizedSettings: fallback,
    storedSettings: refreshed ?? chat.settings,
    logger: params.logger,
    chatId: params.chatId,
  });
}

export async function saveChatSettings(params: {
  prisma: PrismaService;
  chatContextCache: Pick<ChatContextCacheService, 'invalidate'>;
  chatId: string;
  actorUserId: string;
  body: unknown;
  source: AdminActionSource;
  resolveBotAssignmentData: () => Promise<ResolvedBotAssignmentData> | ResolvedBotAssignmentData;
  assertRequiredSubscriptionSettings: (settings: ChatSettings) => Promise<ChatSettings | void>;
  reportsAvailable?: (chatId: string) => boolean;
  commercialAiDeleteOnly?: boolean;
  assertBotCapabilities: (
    requirements: readonly ChatSettingsBotCapabilityRequirement[],
  ) => Promise<void>;
  refreshExecutionReadiness: (
    settings: ChatSettings,
    options?: { skipManagedEntityBotRefresh?: boolean },
  ) => Promise<void>;
  networkWrite?: NetworkSettingsWriteOptions;
}): Promise<ChatSettings> {
  const parsed = updateSettingsRequestSchema.safeParse(params.body);
  if (!parsed.success) {
    throw new BadRequestException(parsed.error.format());
  }

  const currentSettings = await params.prisma.chatSettings.findUnique({
    where: { chatId: params.chatId },
    select: {
      ...CHAT_SETTINGS_BOT_CAPABILITY_SELECT,
      requiredSubscriptionChannelIds: true,
      requiredSubscriptionDurationDays: true,
      requiredSubscriptionExpiresAt: true,
      requiredSubscriptionBotMessageText: true,
      requiredSubscriptionWarnMessageText: true,
      requiredSubscriptionMuteDurationHours: true,
      requiredSubscriptionButtonText: true,
      requiredSubscriptionAdminContactButtonEnabled: true,
      requiredSubscriptionAdminContactButtonUrl: true,
      botSpeechMedia: true,
      stopWordsPolicy: true,
      stopWordsRevision: true,
      messageLimitsBlockedWords: true,
      messageLimitsBlockedDomains: true,
      duplicatePhotoMatchPreset: true,
      duplicatePhotoScope: true,
      duplicateDetectionPreset: true,
      duplicateCompareMode: true,
      duplicateWindowMode: true,
      duplicateStartTimeMinutes: true,
      duplicateEndTimeMinutes: true,
      duplicateTimezone: true,
      duplicateIgnoreLinksEnabled: true,
      duplicateIgnorePhonesEnabled: true,
      duplicateNearMatchEnabled: true,
      profanitySensitivity: true,
      nightModeForceCloseForever: true,
      nightModeForceCloseHours: true,
      nightModeForceCloseDays: true,
      nightModeForceCloseUntil: true,
      karavanStorefrontEnabled: true,
      karavanStorefrontAdminsOnly: true,
      karavanStorefrontMessageText: true,
      karavanStorefrontOpenButtonText: true,
      karavanStorefrontCatalogButtonText: true,
      karavanStorefrontCreateButtonText: true,
      forwardedMessagesEnabled: true,
      updatedAt: true,
      profanityBotMessageText: true,
      profanityWarnMessageText: true,
    },
  });
  // FLAG: Compare the revision observed by the caller, not just the server read during this save.
  // Internal callers may omit it; public mutation routes require a precondition.
  if (
    parsed.data.settingsRevision !== undefined &&
    parsed.data.settingsRevision !== currentSettings?.updatedAt?.toISOString()
  )
    throw chatSettingsRevisionConflict();
  const settingsInput = {
    ...parsed.data,
    profanityBotMessageText: hasOwnSetting(params.body, 'profanityBotMessageText')
      ? parsed.data.profanityBotMessageText
      : (currentSettings?.profanityBotMessageText ?? ''),
    profanityWarnMessageText: hasOwnSetting(params.body, 'profanityWarnMessageText')
      ? parsed.data.profanityWarnMessageText
      : (currentSettings?.profanityWarnMessageText ?? ''),
    slowModeEnabled: hasOwnSetting(params.body, 'slowModeEnabled')
      ? parsed.data.slowModeEnabled
      : (currentSettings?.slowModeEnabled ?? parsed.data.slowModeEnabled),
    slowModeIntervalSeconds: hasOwnSetting(params.body, 'slowModeIntervalSeconds')
      ? parsed.data.slowModeIntervalSeconds
      : (currentSettings?.slowModeIntervalSeconds ?? parsed.data.slowModeIntervalSeconds),
    mediaMessageCooldownEnabled: hasOwnSetting(params.body, 'mediaMessageCooldownEnabled')
      ? parsed.data.mediaMessageCooldownEnabled
      : (currentSettings?.mediaMessageCooldownEnabled ?? parsed.data.mediaMessageCooldownEnabled),
    mediaMessageCooldownSeconds: hasOwnSetting(params.body, 'mediaMessageCooldownSeconds')
      ? parsed.data.mediaMessageCooldownSeconds
      : (currentSettings?.mediaMessageCooldownSeconds ?? parsed.data.mediaMessageCooldownSeconds),
    stickerMessagesEnabled: hasOwnSetting(params.body, 'stickerMessagesEnabled')
      ? parsed.data.stickerMessagesEnabled
      : (currentSettings?.stickerMessagesEnabled ?? parsed.data.stickerMessagesEnabled),
    duplicatePhotoEnabled: hasOwnSetting(params.body, 'duplicatePhotoEnabled')
      ? parsed.data.duplicatePhotoEnabled
      : (currentSettings?.duplicatePhotoEnabled ?? parsed.data.duplicatePhotoEnabled),
    duplicatePhotoMatchPreset: hasOwnSetting(params.body, 'duplicatePhotoMatchPreset')
      ? parsed.data.duplicatePhotoMatchPreset
      : (currentSettings?.duplicatePhotoMatchPreset ?? parsed.data.duplicatePhotoMatchPreset),
    duplicatePhotoScope: hasOwnSetting(params.body, 'duplicatePhotoScope')
      ? parsed.data.duplicatePhotoScope
      : (currentSettings?.duplicatePhotoScope ?? parsed.data.duplicatePhotoScope),
    duplicateDetectionPreset: hasOwnSetting(params.body, 'duplicateDetectionPreset')
      ? parsed.data.duplicateDetectionPreset
      : (currentSettings?.duplicateDetectionPreset ?? parsed.data.duplicateDetectionPreset),
    duplicateCompareMode: hasOwnSetting(params.body, 'duplicateCompareMode')
      ? parsed.data.duplicateCompareMode
      : currentSettings?.duplicateCompareMode === 'TEXT'
        ? ('TEXT' as const)
        : ('MESSAGE' as const),
    duplicateWindowMode: hasOwnSetting(params.body, 'duplicateWindowMode')
      ? parsed.data.duplicateWindowMode
      : (currentSettings?.duplicateWindowMode ?? parsed.data.duplicateWindowMode),
    duplicateStartTimeMinutes: hasOwnSetting(params.body, 'duplicateStartTimeMinutes')
      ? parsed.data.duplicateStartTimeMinutes
      : (currentSettings?.duplicateStartTimeMinutes ?? parsed.data.duplicateStartTimeMinutes),
    duplicateEndTimeMinutes: hasOwnSetting(params.body, 'duplicateEndTimeMinutes')
      ? parsed.data.duplicateEndTimeMinutes
      : (currentSettings?.duplicateEndTimeMinutes ?? parsed.data.duplicateEndTimeMinutes),
    duplicateTimezone: hasOwnSetting(params.body, 'duplicateTimezone')
      ? parsed.data.duplicateTimezone
      : (currentSettings?.duplicateTimezone ?? parsed.data.duplicateTimezone),
    duplicateIgnoreLinksEnabled: hasOwnSetting(params.body, 'duplicateIgnoreLinksEnabled')
      ? parsed.data.duplicateIgnoreLinksEnabled
      : (currentSettings?.duplicateIgnoreLinksEnabled ?? parsed.data.duplicateIgnoreLinksEnabled),
    duplicateIgnorePhonesEnabled: hasOwnSetting(params.body, 'duplicateIgnorePhonesEnabled')
      ? parsed.data.duplicateIgnorePhonesEnabled
      : (currentSettings?.duplicateIgnorePhonesEnabled ?? parsed.data.duplicateIgnorePhonesEnabled),
    duplicateNearMatchEnabled: hasOwnSetting(params.body, 'duplicateNearMatchEnabled')
      ? parsed.data.duplicateNearMatchEnabled
      : (currentSettings?.duplicateNearMatchEnabled ?? parsed.data.duplicateNearMatchEnabled),
    // Older clients omit settings introduced after their bundled contract.
    profanitySensitivity: hasOwnSetting(params.body, 'profanitySensitivity')
      ? parsed.data.profanitySensitivity
      : (currentSettings?.profanitySensitivity ?? parsed.data.profanitySensitivity),
    karavanStorefrontEnabled: hasOwnSetting(params.body, 'karavanStorefrontEnabled')
      ? parsed.data.karavanStorefrontEnabled
      : (currentSettings?.karavanStorefrontEnabled ?? parsed.data.karavanStorefrontEnabled),
    karavanStorefrontAdminsOnly: hasOwnSetting(params.body, 'karavanStorefrontAdminsOnly')
      ? parsed.data.karavanStorefrontAdminsOnly
      : (currentSettings?.karavanStorefrontAdminsOnly ?? parsed.data.karavanStorefrontAdminsOnly),
    karavanStorefrontMessageText: hasOwnSetting(params.body, 'karavanStorefrontMessageText')
      ? parsed.data.karavanStorefrontMessageText
      : (currentSettings?.karavanStorefrontMessageText ?? parsed.data.karavanStorefrontMessageText),
    karavanStorefrontOpenButtonText: hasOwnSetting(params.body, 'karavanStorefrontOpenButtonText')
      ? parsed.data.karavanStorefrontOpenButtonText
      : (currentSettings?.karavanStorefrontOpenButtonText ??
        parsed.data.karavanStorefrontOpenButtonText),
    karavanStorefrontCatalogButtonText: hasOwnSetting(
      params.body,
      'karavanStorefrontCatalogButtonText',
    )
      ? parsed.data.karavanStorefrontCatalogButtonText
      : (currentSettings?.karavanStorefrontCatalogButtonText ??
        parsed.data.karavanStorefrontCatalogButtonText),
    karavanStorefrontCreateButtonText: hasOwnSetting(
      params.body,
      'karavanStorefrontCreateButtonText',
    )
      ? parsed.data.karavanStorefrontCreateButtonText
      : (currentSettings?.karavanStorefrontCreateButtonText ??
        parsed.data.karavanStorefrontCreateButtonText),
    forwardedMessagesEnabled: hasOwnSetting(params.body, 'forwardedMessagesEnabled')
      ? parsed.data.forwardedMessagesEnabled
      : (currentSettings?.forwardedMessagesEnabled ?? parsed.data.forwardedMessagesEnabled),
    messageLimitsImageTextScanEnabled: hasOwnSetting(
      params.body,
      'messageLimitsImageTextScanEnabled',
    )
      ? parsed.data.messageLimitsImageTextScanEnabled
      : (currentSettings?.messageLimitsImageTextScanEnabled ??
        parsed.data.messageLimitsImageTextScanEnabled),
  };
  assertLegacyStopWordsWrite(currentSettings ?? {}, params.body);
  // FLAG: Omitted subscription fields preserve the saved policy, including during unrelated saves.
  for (const key of REQUIRED_SUBSCRIPTION_SETTING_KEYS) {
    if (currentSettings && !hasOwnSetting(params.body, key) && key in currentSettings)
      Object.assign(settingsInput, { [key]: currentSettings[key as keyof typeof currentSettings] });
  }
  // FLAG: Older clients must not reset a report policy they do not yet understand.
  for (const key of [
    'reportsEnabled',
    'reportsThreshold',
    'reportsAliases',
    'reportsDeleteMode',
    'reportsMuteEnabled',
    'reportsMuteDurationHours',
  ] as const) {
    if (currentSettings && !hasOwnSetting(params.body, key))
      Object.assign(settingsInput, { [key]: currentSettings[key] });
  }
  const reportCompatibleInput = updateSettingsRequestSchema.safeParse(settingsInput);
  if (!reportCompatibleInput.success)
    throw new BadRequestException(reportCompatibleInput.error.format());
  const normalizedSettings = normalizeChatSettings(
    reportCompatibleInput.data,
    {
      nightModeForceCloseEnabled: currentSettings?.nightModeForceCloseEnabled ?? false,
      nightModeForceCloseForever: currentSettings?.nightModeForceCloseForever ?? false,
      nightModeForceCloseHours: currentSettings?.nightModeForceCloseHours ?? 0,
      nightModeForceCloseDays: currentSettings?.nightModeForceCloseDays ?? 0,
      nightModeForceCloseUntil: currentSettings?.nightModeForceCloseUntil ?? '',
    },
    params.chatId,
  );
  if (params.networkWrite?.authoredKeys) {
    for (const key of params.networkWrite.authoredKeys) {
      if (
        key === 'requiredSubscriptionBotMessageEnabled' ||
        key === 'requiredSubscriptionExpiresAt'
      )
        continue;
      // FLAG: Group mode cannot silently report an authored value that a domain invariant
      // discarded. The actor must explicitly supply a compatible set of dirty fields.
      if (!isDeepStrictEqual(parsed.data[key], normalizedSettings[key]))
        throw new BadRequestException(
          'Выбранное значение несовместимо с настройками одного из получателей.',
        );
    }
  }
  const savedSubscriptionIds = new Set(
    Array.isArray(currentSettings?.requiredSubscriptionChannelIds)
      ? currentSettings.requiredSubscriptionChannelIds
          .filter((id): id is string => typeof id === 'string')
          .map((id) => id.trim())
      : [],
  );
  const addedSubscriptionIds = normalizedSettings.requiredSubscriptionChannelIds.filter(
    (id) => !savedSubscriptionIds.has(id),
  );
  if (addedSubscriptionIds.length > 0) {
    // FLAG: Validation never rewrites the user's policy. Failure rejects the whole CAS save.
    await params.assertRequiredSubscriptionSettings({
      ...normalizedSettings,
      requiredSubscriptionChannelIds: addedSubscriptionIds,
    });
  }
  assertReportsActivationAvailable(
    currentSettings,
    normalizedSettings,
    params.reportsAvailable?.(params.chatId) ?? false,
  );
  const capabilityRequirements = resolveChatSettingsBotCapabilityRequirements({
    commercialAiDeleteOnly: params.commercialAiDeleteOnly,
    current: {
      ...DEFAULT_CHAT_SETTINGS,
      ...(currentSettings ?? {}),
      requiredSubscriptionChannelIds: [...savedSubscriptionIds],
      // FLAG: Raw media is only the write-comparison baseline; capability checks
      // retain their previous typed default and never receive unsanitized JSONB.
      botSpeechMedia: DEFAULT_CHAT_SETTINGS.botSpeechMedia,
      reportsDeleteMode:
        currentSettings?.reportsDeleteMode === 'HISTORY_24H' ? 'HISTORY_24H' : 'MESSAGE',
      stopWordsPolicy: currentSettings
        ? (readStopWordsPolicy(currentSettings) ?? undefined)
        : undefined,
      duplicateCompareMode: currentSettings?.duplicateCompareMode === 'TEXT' ? 'TEXT' : 'MESSAGE',
      duplicateWindowMode: currentSettings?.duplicateWindowMode === 'DAILY' ? 'DAILY' : 'INTERVAL',
    },
    next: normalizedSettings,
    requestedSettings: params.networkWrite?.authoredKeys
      ? Object.fromEntries(params.networkWrite.authoredKeys.map((key) => [key, parsed.data[key]]))
      : params.body,
  });
  if (capabilityRequirements.length > 0) {
    await params.assertBotCapabilities(capabilityRequirements);
  }
  if (params.networkWrite?.validateOnly) {
    const chat = await params.prisma.chat.findUniqueOrThrow({ where: { id: params.chatId } });
    await assertFixedModeratorCapabilitiesForSettings(
      params.prisma,
      chat,
      chatSettingsCapabilityPurposes(capabilityRequirements),
    );
    return normalizedSettings;
  }
  const botAssignmentData = await params.resolveBotAssignmentData();
  // FLAG: Major never includes Publisher-owned comment fields in UPDATE, so concurrent Publisher
  // writes cannot be overwritten by a stale read-modify-write cycle.
  const majorOwnedSettings = omitLegacyStopWordsSettings(
    omitStopWordsPolicy(omitPublisherOwnedChatSettings(normalizedSettings)),
  );
  delete majorOwnedSettings.settingsRevision;
  if (params.networkWrite?.authoredKeys) {
    const authored = new Set(params.networkWrite.authoredKeys);
    if (
      params.networkWrite.authoredKeys.some((key) =>
        [
          'nightModeForceCloseEnabled',
          'nightModeForceCloseForever',
          'nightModeForceCloseHours',
          'nightModeForceCloseDays',
        ].includes(key),
      )
    )
      authored.add('nightModeForceCloseUntil');
    // FLAG: Group patches may normalize their own requested fields, but never persist another
    // target field merely because it shares the settings object or the same editor section.
    for (const key of Object.keys(majorOwnedSettings) as Array<keyof typeof majorOwnedSettings>)
      if (!authored.has(key)) delete majorOwnedSettings[key];
  }
  const createSettings = {
    ...majorOwnedSettings,
    ...DEFAULT_PUBLISHER_OWNED_CHAT_SETTINGS,
  };
  const { botSpeechMedia, ...majorOwnedSettingsWithoutMedia } = majorOwnedSettings;
  // FLAG: Compare the raw media at the same updatedAt used by the write CAS;
  // malformed stored media must still be normalized and explicit clears must persist.
  const updateSettings =
    currentSettings && areBotSpeechMediaEqual(currentSettings.botSpeechMedia, botSpeechMedia)
      ? majorOwnedSettingsWithoutMedia
      : majorOwnedSettings;

  let savedRevision: string | undefined;
  try {
    await params.prisma.$transaction(async (tx) => {
      if (params.networkWrite?.beforeWrite) {
        await tx.$queryRaw`SELECT id FROM chats WHERE id=${params.chatId} FOR UPDATE`;
        await params.networkWrite.beforeWrite(tx);
      }
      const lockedChat = await tx.chat.upsert({
        where: { id: params.chatId },
        create: {
          id: params.chatId,
          title: `Chat ${params.chatId}`,
          entityType: ChatEntityType.CHAT,
          catalogKind: ChatCatalogKind.MANAGED,
          ...botAssignmentData,
        },
        update: { catalogKind: ChatCatalogKind.MANAGED },
      });
      await assertFixedModeratorCapabilitiesForSettings(
        tx,
        lockedChat,
        chatSettingsCapabilityPurposes(capabilityRequirements),
      );
      if (
        [
          // FLAG: Restoring an earlier schedule must not revive deletes prepared
          // before a later disable/open/schedule change.
          'nightModeEnabled',
          'nightModeStartTimeMinutes',
          'nightModeEndTimeMinutes',
          'nightModeTimezone',
          'nightModeForceCloseEnabled',
          'nightModeForceCloseForever',
          'nightModeForceCloseHours',
          'nightModeForceCloseDays',
          'nightModeForceCloseUntil',
        ].some((key) =>
          params.networkWrite?.authoredKeys
            ? params.networkWrite.authoredKeys.includes(key as keyof ChatSettings)
            : hasOwnSetting(params.body, key as keyof ChatSettings),
        )
      ) {
        await advanceChatMutationOrder(tx, params.chatId, 'CHAT_CONTROL');
      }
      if (
        params.networkWrite?.authoredKeys
          ? params.networkWrite.authoredKeys.includes('rulesAttachViolationsEnabled')
          : hasOwnSetting(params.body, 'rulesAttachViolationsEnabled')
      ) {
        await advanceChatMutationOrder(tx, params.chatId, 'RULES');
      }
      if (currentSettings) {
        const changed = await tx.chatSettings.updateMany({
          where: { chatId: params.chatId, updatedAt: currentSettings.updatedAt },
          data: updateSettings,
        });
        if (changed.count !== 1) {
          throw chatSettingsRevisionConflict();
        }
      } else {
        await tx.chatSettings.create({
          data: { chatId: params.chatId, ...createSettings },
        });
      }
      await tx.auditLog.create({
        data: {
          chatId: params.chatId,
          actorUserId: params.actorUserId,
          action: 'UPDATE_SETTINGS',
          payload: buildUpdateSettingsAuditPayload({
            requestedSettings: params.networkWrite?.authoredKeys
              ? Object.fromEntries(
                  params.networkWrite.authoredKeys.map((key) => [key, normalizedSettings[key]]),
                )
              : params.body,
            normalizedSettings,
            source: params.source,
          }),
        },
      });
      // FLAG: Capture our committed snapshot while the UPDATE lock is held. A later read may
      // observe another writer and must never lend that newer revision to our older values.
      const written = await tx.chatSettings.findUnique({
        where: { chatId: params.chatId },
        select: { updatedAt: true },
      });
      savedRevision = written?.updatedAt?.toISOString();
      if (params.networkWrite?.onCommitted) {
        if (!savedRevision) throw chatSettingsRevisionConflict();
        await params.networkWrite.onCommitted(tx, savedRevision);
      }
    });
  } catch (error: unknown) {
    if ((error as { code?: unknown })?.code === 'P2002') {
      throw chatSettingsRevisionConflict();
    }
    throw error;
  }
  const publisherOwnedSettings = await params.prisma.chatSettings.findUnique({
    where: { chatId: params.chatId },
    select: {
      commentsEnabled: true,
      commentsAdminsEnabled: true,
      commentsAllEnabled: true,
      commentsChatBroadcastsEnabled: true,
    },
  });
  const resultingSettings = {
    ...normalizedSettings,
    settingsRevision: savedRevision,
    commentsEnabled:
      publisherOwnedSettings?.commentsEnabled ??
      DEFAULT_PUBLISHER_OWNED_CHAT_SETTINGS.commentsEnabled,
    commentsAdminsEnabled:
      publisherOwnedSettings?.commentsAdminsEnabled ??
      DEFAULT_PUBLISHER_OWNED_CHAT_SETTINGS.commentsAdminsEnabled,
    commentsAllEnabled:
      publisherOwnedSettings?.commentsAllEnabled ??
      DEFAULT_PUBLISHER_OWNED_CHAT_SETTINGS.commentsAllEnabled,
    commentsChatBroadcastsEnabled:
      publisherOwnedSettings?.commentsChatBroadcastsEnabled ??
      DEFAULT_PUBLISHER_OWNED_CHAT_SETTINGS.commentsChatBroadcastsEnabled,
  };
  if (params.networkWrite?.deferFollowup) return resultingSettings;
  await params.chatContextCache.invalidate(params.chatId);
  if (capabilityRequirements.length > 0) {
    await params.refreshExecutionReadiness(resultingSettings, {
      skipManagedEntityBotRefresh: true,
    });
  } else {
    await params.refreshExecutionReadiness(resultingSettings);
  }

  return resultingSettings;
}

function chatSettingsRevisionConflict(): ConflictException {
  return new ConflictException({
    code: 'CHAT_SETTINGS_CONCURRENT_UPDATE',
    message: 'Настройки чата изменились параллельно. Обновите экран и повторите попытку.',
  });
}

function hasOwnSetting(body: unknown, key: string): boolean {
  return (
    body !== null &&
    typeof body === 'object' &&
    !Array.isArray(body) &&
    Object.prototype.hasOwnProperty.call(body, key)
  );
}
