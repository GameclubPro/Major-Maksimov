import { storedLinkButtonDraftSchema } from './broadcast-buttons.js';
export { chatRulesFieldsSchema, MAX_CHAT_RULES_TEXT_LENGTH } from './chat-rules-field-schemas.js';
export { messageRetentionHoursSchema } from './message-retention-summary.js';
import { broadcastScheduleTimezoneSchema } from './broadcast-schedule-fields.js';
export {
  broadcastLinkButtonSchema,
  storedLinkButtonDraftSchema,
  type BroadcastLinkButton,
} from './broadcast-buttons.js';
export {
  isValidIanaTimeZone,
  broadcastScheduleTimezoneSchema,
} from './broadcast-schedule-fields.js';
import { z } from 'zod';
import {
  botButtonUrlSchema,
  botButtonTextSchema,
  botMessageTextSchema,
} from './settings-message-field-schemas.js';
export {
  botButtonUrlSchema,
  botButtonTextSchema,
  MAX_BOT_SPEECH_TEXT_LENGTH,
  parseHttpButtonUrl,
  isValidBotButtonUrl,
  isValidBotButtonText,
} from './settings-message-field-schemas.js';
export {
  channelSettingsSchema,
  channelSuggestionEntryModeSchema,
  type ChannelSettings,
  type ChannelSuggestionEntryMode,
} from './channel-settings-field-schemas.js';
import { reportSettingsShape } from './report-settings.js';
import { karavanStorefrontTextSettingsShape } from './karavan-storefront-texts.js';
import { BOT_SPEECH_EDITABLE_FIELD_KEYS, botSpeechStyleSchema } from './bot-speech-fields.js';
import {
  MAX_BROADCAST_IMAGE_BASE64_LENGTH,
  MAX_BROADCAST_LINK_BUTTONS,
} from './broadcast-common.js';
import * as dupe from './duplicate-settings.js';
import { stopWordsPolicySchema } from './stop-words.js';
import { commercialAdsPolicySchema } from './commercial-policy.js';
import {
  DELETE_BOT_MESSAGES_DELAY_DEFAULT_MINUTES,
  DELETE_BOT_MESSAGES_DELAY_MAX_MINUTES,
  DELETE_BOT_MESSAGES_DELAY_MIN_MINUTES,
  isValidDeleteBotMessagesDelayMinutes,
} from './settings-utils.js';

export const linkPolicySchema = z.enum(['ALLOWLIST_ONLY', 'BLOCKLIST_ONLY', 'ALERT_ONLY']);

export const profanitySensitivitySchema = z.enum(['CORE_ONLY', 'BALANCED', 'STRICT']);

export type ProfanitySensitivity = z.infer<typeof profanitySensitivitySchema>;

export const commercialAdsSensitivitySchema = z.enum(['BALANCED', 'STRICT']);

export const REQUIRED_SUBSCRIPTION_MAX_CHANNELS = 10;

export const REQUIRED_SUBSCRIPTION_DURATION_DAYS_MIN = 1;

export const REQUIRED_SUBSCRIPTION_DURATION_DAYS_MAX = 14;

export const REQUIRED_SUBSCRIPTION_DURATION_DAYS_DEFAULT = 7;

export const INVITATION_ACCESS_REQUIRED_COUNT_MIN = 1;

export const INVITATION_ACCESS_REQUIRED_COUNT_MAX = 10;

export const MESSAGE_LIMITS_BLOCKED_WORDS_MAX = 999;

export const MESSAGE_LIMITS_BLOCKED_DOMAINS_MAX = 300;

export const ADMIN_COMMAND_ALIASES_MAX = 8;

export const ADMIN_COMMAND_ALIAS_MAX_LENGTH = 32;

export const ADMIN_MUTE_COMMAND_ALIASES_DEFAULT = 'мут, мьют, мью, mute';

export const ADMIN_RULES_COMMAND_ALIASES_DEFAULT = 'правило, правила, rule, rules';

export const ADMIN_COMMAND_NAME_MAX_LENGTH = 32;

export const ADMIN_BAN_COMMAND_NAME_DEFAULT = 'бан';

export const ADMIN_BAN_ALL_COMMAND_NAME_DEFAULT = 'Бан!';

export const ADMIN_MUTE_COMMAND_NAME_DEFAULT = 'мут';

export const ADMIN_PERMANENT_MUTE_COMMAND_NAME_DEFAULT = 'мут 88';

export const ADMIN_RULES_COMMAND_NAME_DEFAULT = 'правило';

export const ADMIN_SILENCE_COMMAND_NAME_DEFAULT = 'тишина';

export const ADMIN_OPEN_CHAT_COMMAND_NAME_DEFAULT = 'тишина выкл';

export const MAX_MESSAGE_LENGTH_MIN = 50;

export const MAX_MESSAGE_LENGTH_MAX = 1500;

export const MAX_MESSAGE_LENGTH_DEFAULT = MAX_MESSAGE_LENGTH_MAX;

export const BOT_SPEECH_MEDIA_IMAGE_BASE64_MAX_LENGTH = MAX_BROADCAST_IMAGE_BASE64_LENGTH;

const duplicateWindowSecSchema = dupe.duplicateWindowSecSchema;

const duplicateMaxCountSchema = z.number().int().min(1).max(dupe.DUPLICATE_THRESHOLD_MAX);

const escalationWindowHoursSchema = z.number().int().min(1).max(168);

const escalationMaxCountSchema = z.number().int().min(1).max(20);

const autoMuteDurationHoursSchema = z.number().int().min(1).max(168).default(6);

const requiredSubscriptionMuteDurationHoursSchema = z.number().int().min(1).max(336).default(6);

const requiredSubscriptionDurationDaysSchema = z
  .number()
  .int()
  .min(REQUIRED_SUBSCRIPTION_DURATION_DAYS_MIN)
  .max(REQUIRED_SUBSCRIPTION_DURATION_DAYS_MAX)
  .default(REQUIRED_SUBSCRIPTION_DURATION_DAYS_DEFAULT);

const requiredSubscriptionExpiresAtSchema = z.string().trim().max(64).default('');

const invitationAccessRequiredCountSchema = z
  .number()
  .int()
  .min(INVITATION_ACCESS_REQUIRED_COUNT_MIN)
  .max(INVITATION_ACCESS_REQUIRED_COUNT_MAX)
  .default(INVITATION_ACCESS_REQUIRED_COUNT_MIN);

const deleteBotMessagesDelayMinutesSchema = z
  .number()
  .min(DELETE_BOT_MESSAGES_DELAY_MIN_MINUTES)
  .max(DELETE_BOT_MESSAGES_DELAY_MAX_MINUTES)
  .refine(isValidDeleteBotMessagesDelayMinutes, {
    message: 'Допустимо 30 сек или целое число минут от 1 до 60.',
  })
  .default(DELETE_BOT_MESSAGES_DELAY_DEFAULT_MINUTES);

const adminCommandNameSchema = z
  .string()
  .trim()
  .min(1, { message: 'Введите название команды.' })
  .max(ADMIN_COMMAND_NAME_MAX_LENGTH, {
    message: `Команда должна быть не длиннее ${ADMIN_COMMAND_NAME_MAX_LENGTH} символов.`,
  })
  .transform((value) => value.replace(/\s+/g, ' '));

const adminCommandAliasesTextSchema = z
  .string()
  .trim()
  .max(256)
  .refine(
    (value) => {
      const aliases = value
        .split(',')
        .map((item) => item.trim())
        .filter((item) => item.length > 0);
      return aliases.length > 0 && aliases.length <= ADMIN_COMMAND_ALIASES_MAX;
    },
    {
      message: `Укажите от 1 до ${ADMIN_COMMAND_ALIASES_MAX} команд через запятую.`,
    },
  )
  .refine(
    (value) =>
      value
        .split(',')
        .map((item) => item.trim())
        .filter((item) => item.length > 0)
        .every((item) => item.length <= ADMIN_COMMAND_ALIAS_MAX_LENGTH),
    {
      message: `Каждая команда должна быть не длиннее ${ADMIN_COMMAND_ALIAS_MAX_LENGTH} символов.`,
    },
  )
  .transform((value) => {
    const aliases = Array.from(
      new Set(
        value
          .split(',')
          .map((item) => item.trim().replace(/\s+/g, ' '))
          .filter((item) => item.length > 0),
      ),
    );
    return aliases.join(', ');
  });

const botSpeechMediaFieldKeySchema = z.enum(BOT_SPEECH_EDITABLE_FIELD_KEYS);

const botSpeechMediaImageSchema = z
  .object({
    base64: z.string().trim().max(BOT_SPEECH_MEDIA_IMAGE_BASE64_MAX_LENGTH).default(''),
    mimeType: z.string().trim().max(128).default(''),
    fileName: z.string().trim().max(128).default(''),
  })
  .superRefine((value, ctx) => {
    const hasImage = value.base64.trim().length > 0;
    if (!hasImage) {
      return;
    }

    if (!value.mimeType.trim().toLowerCase().startsWith('image/')) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['mimeType'],
        message: 'Неверный формат фото.',
      });
    }
  })
  .transform((value) =>
    value.base64.trim()
      ? {
          base64: value.base64.trim(),
          mimeType: value.mimeType.trim(),
          fileName: value.fileName.trim(),
        }
      : {
          base64: '',
          mimeType: '',
          fileName: '',
        },
  );

export const botSpeechMediaSchema = z
  .partialRecord(botSpeechMediaFieldKeySchema, botSpeechMediaImageSchema)
  .default({});

export type BotSpeechMedia = z.infer<typeof botSpeechMediaSchema>;

export type BotSpeechMediaImage = z.infer<typeof botSpeechMediaImageSchema>;

const messageLimitsBlockedWordSchema = z.string().trim().max(32);

const messageLimitsBlockedWordsSchema = z
  .array(messageLimitsBlockedWordSchema)
  .max(MESSAGE_LIMITS_BLOCKED_WORDS_MAX, `До ${MESSAGE_LIMITS_BLOCKED_WORDS_MAX} слов.`)
  .default([]);

const messageLimitsBlockedDomainSchema = z.string().trim().max(253);

const messageLimitsBlockedDomainsSchema = z
  .array(messageLimitsBlockedDomainSchema)
  .max(MESSAGE_LIMITS_BLOCKED_DOMAINS_MAX, `До ${MESSAGE_LIMITS_BLOCKED_DOMAINS_MAX} доменов.`)
  .default([]);

const nightModeForceCloseUntilSchema = z.string().trim().max(64).default('');

const requiredSubscriptionChannelIdsSchema = z
  .array(z.string().trim().min(1).max(128))
  .max(REQUIRED_SUBSCRIPTION_MAX_CHANNELS)
  .default([]);

// Field schemas validate explicit values without constructing a settings snapshot.
export const chatSettingsFieldsSchema = z.object({
  duplicateWarnEnabled: z.boolean().default(false),
  duplicateMuteEnabled: z.boolean().default(false),
  duplicateBanEnabled: z.boolean().default(false),
  antiDuplicateEnabled: z.boolean().default(false),
  duplicatePhotoEnabled: z.boolean().default(false),
  duplicatePhotoMatchPreset: dupe.duplicatePhotoMatchPresetSchema.default('SAME_IMAGE'),
  duplicatePhotoScope: dupe.duplicatePhotoScopeSchema.default('SAME_AUTHOR'),
  duplicateDetectionPreset: dupe.duplicateDetectionPresetSchema.default('STRICT'),
  duplicateCompareMode: dupe.duplicateCompareModeSchema.default('MESSAGE'),
  ...dupe.duplicateScheduleSettingsShape,
  duplicateTimezone: broadcastScheduleTimezoneSchema,
  duplicateIgnoreLinksEnabled: z.boolean().default(false),
  duplicateIgnorePhonesEnabled: z.boolean().default(false),
  duplicateNearMatchEnabled: z.boolean().default(false),
  duplicateWarnWindowSec: duplicateWindowSecSchema.default(43_200),
  duplicateWarnMaxCount: duplicateMaxCountSchema.default(2),
  duplicateMuteWindowSec: duplicateWindowSecSchema.default(86_400),
  duplicateMuteMaxCount: duplicateMaxCountSchema.default(3),
  duplicateMuteDurationHours: autoMuteDurationHoursSchema,
  duplicateBanWindowSec: duplicateWindowSecSchema.default(172_800),
  duplicateBanMaxCount: duplicateMaxCountSchema.default(4),
  linkPolicy: linkPolicySchema.default('ALERT_ONLY'),
  linkEscalationWindowHours: escalationWindowHoursSchema.default(24),
  linkWarnMaxCount: escalationMaxCountSchema.default(2),
  linkMuteMaxCount: escalationMaxCountSchema.default(3),
  linkBanMaxCount: escalationMaxCountSchema.default(4),
  botSpeechStyle: botSpeechStyleSchema.nullable().default('FRIENDLY'),
  botSpeechMedia: botSpeechMediaSchema,
  greetingEnabled: z.boolean().default(false),
  greetingBotMessageEnabled: z.boolean().default(false),
  greetingDeleteBotMessageEnabled: z.boolean().default(false),
  greetingDeleteBotMessageDelayMinutes: deleteBotMessagesDelayMinutesSchema,
  greetingBotMessageText: botMessageTextSchema,
  greetingBotButtonEnabled: z.boolean().default(false),
  greetingBotButtonUrl: botButtonUrlSchema,
  greetingBotButtonText: botButtonTextSchema,
  greetingBotButtons: z
    .array(storedLinkButtonDraftSchema)
    .max(MAX_BROADCAST_LINK_BUTTONS)
    .default([]),
  greetingRulesButtonEnabled: z.boolean().default(false),
  requiredSubscriptionEnabled: z.boolean().default(false),
  requiredSubscriptionChannelIds: requiredSubscriptionChannelIdsSchema,
  requiredSubscriptionDurationDays: requiredSubscriptionDurationDaysSchema,
  requiredSubscriptionExpiresAt: requiredSubscriptionExpiresAtSchema,
  requiredSubscriptionBotMessageEnabled: z.boolean().default(false),
  requiredSubscriptionBotMessageText: botMessageTextSchema,
  requiredSubscriptionButtonText: z.string().trim().max(32).default(''),
  requiredSubscriptionAdminContactButtonEnabled: z.boolean().default(false),
  requiredSubscriptionAdminContactButtonUrl: botButtonUrlSchema,
  requiredSubscriptionWarnEnabled: z.boolean().default(false),
  requiredSubscriptionWarnMessageText: botMessageTextSchema,
  requiredSubscriptionBanEnabled: z.boolean().default(false),
  requiredSubscriptionMuteEnabled: z.boolean().default(false),
  requiredSubscriptionMuteDurationHours: requiredSubscriptionMuteDurationHoursSchema,
  invitationAccessEnabled: z.boolean().default(false),
  invitationAccessRequiredCount: invitationAccessRequiredCountSchema,
  invitationAccessBotMessageEnabled: z.boolean().default(false),
  invitationAccessBotMessageText: botMessageTextSchema,
  invitationAccessAdminContactButtonEnabled: z.boolean().default(false),
  invitationAccessAdminContactButtonUrl: botButtonUrlSchema,
  invitationAccessWarnEnabled: z.boolean().default(false),
  invitationAccessWarnMessageText: botMessageTextSchema,
  invitationAccessBanEnabled: z.boolean().default(false),
  invitationAccessMuteEnabled: z.boolean().default(false),
  invitationAccessMuteDurationHours: autoMuteDurationHoursSchema,
  commentsEnabled: z.boolean().default(false),
  commentsAdminsEnabled: z.boolean().default(false),
  commentsAllEnabled: z.boolean().default(false),
  commentsChatBroadcastsEnabled: z.boolean().default(false),
  karavanStorefrontEnabled: z.boolean().default(true),
  karavanStorefrontAdminsOnly: z.boolean().default(false),
  ...karavanStorefrontTextSettingsShape,
  deleteBotMessagesEnabled: z.boolean().default(false),
  deleteBotMessagesDelayMinutes: deleteBotMessagesDelayMinutesSchema,
  removeBotsFromGroupEnabled: z.boolean().default(false),
  deleteSpammersEnabled: z.boolean().default(false),
  ...reportSettingsShape,
  antiSpamEnabled: z.boolean().default(false),
  slowModeEnabled: z.boolean().default(false),
  slowModeIntervalSeconds: z.number().int().min(10).max(86400).default(30),
  mediaMessageCooldownEnabled: z.boolean().default(false),
  mediaMessageCooldownSeconds: z.number().int().min(10).max(86400).default(30),
  stickerMessagesEnabled: z.boolean().default(true),
  messageCountLimitEnabled: z.boolean().default(false),
  messageCountLimitMessages: z.number().int().min(1).max(10).default(5),
  messageCountLimitWindowHours: z.number().int().min(1).max(24).default(1),
  maxMessageLengthEnabled: z.boolean().default(false),
  maxMessageLength: z
    .number()
    .int()
    .min(MAX_MESSAGE_LENGTH_MIN)
    .max(MAX_MESSAGE_LENGTH_MAX)
    .default(MAX_MESSAGE_LENGTH_DEFAULT),
  photoMessageCooldownEnabled: z.boolean().default(false),
  photoMessageCooldownHours: z.number().int().min(1).max(24).default(1),
  stickerMessageCooldownEnabled: z.boolean().default(false),
  stickerMessageCooldownMinutes: z.number().int().min(1).max(60).default(5),
  photoMessagesEnabled: z.boolean().default(true),
  videoMessagesEnabled: z.boolean().default(true),
  fileMessagesEnabled: z.boolean().default(true),
  voiceMessagesEnabled: z.boolean().default(true),
  forwardedMessagesEnabled: z.boolean().default(true),
  phoneNumbersEnabled: z.boolean().default(true),
  phoneNumbersBotMessageEnabled: z.boolean().default(false),
  phoneNumbersBotMessageText: botMessageTextSchema,
  phoneNumbersWarnEnabled: z.boolean().default(false),
  phoneNumbersMuteEnabled: z.boolean().default(false),
  phoneNumbersMuteDurationHours: autoMuteDurationHoursSchema,
  phoneNumbersBanEnabled: z.boolean().default(false),
  phoneNumbersEscalationWindowHours: escalationWindowHoursSchema.default(12),
  phoneNumbersWarnMaxCount: escalationMaxCountSchema.default(2),
  phoneNumbersMuteMaxCount: escalationMaxCountSchema.default(3),
  phoneNumbersBanMaxCount: escalationMaxCountSchema.default(4),
  phoneNumbersAdminContactButtonEnabled: z.boolean().default(false),
  phoneNumbersAdminContactButtonUrl: botButtonUrlSchema,
  messageLimitsBlockedWords: messageLimitsBlockedWordsSchema,
  stopWordsPolicy: z.preprocess((value) => value ?? undefined, stopWordsPolicySchema.optional()),
  stopWordsRevision: z.number().int().nonnegative().optional(),
  messageLimitsBlockedDomains: messageLimitsBlockedDomainsSchema,
  messageLimitsImageTextScanEnabled: z.boolean().default(false),
  messageLimitsBotMessageEnabled: z.boolean().default(false),
  messageLimitsBotMessageText: botMessageTextSchema,
  messageLimitsWarnEnabled: z.boolean().default(false),
  messageLimitsWarnMessageText: botMessageTextSchema,
  messageLimitsBanEnabled: z.boolean().default(false),
  messageLimitsMuteEnabled: z.boolean().default(false),
  messageLimitsMuteDurationHours: autoMuteDurationHoursSchema,
  messageLimitsAdminContactButtonEnabled: z.boolean().default(false),
  messageLimitsAdminContactButtonUrl: botButtonUrlSchema,
  messageLimitsBotButtonEnabled: z.boolean().default(false),
  messageLimitsBotButtonUrl: botButtonUrlSchema,
  messageLimitsBotButtonText: botButtonTextSchema,
  messageLimitsBotButtons: z
    .array(storedLinkButtonDraftSchema)
    .max(MAX_BROADCAST_LINK_BUTTONS)
    .default([]),
  russianProfanityFilterEnabled: z.boolean().default(false),
  profanitySensitivity: profanitySensitivitySchema.default('BALANCED'),
  commercialAdsFilterEnabled: z.boolean().default(false),
  commercialAdsSensitivity: commercialAdsSensitivitySchema.default('BALANCED'),
  commercialAdsWarnThreshold: z.number().int().min(10).max(90).default(45),
  commercialAdsDeleteThreshold: z.number().int().min(20).max(100).default(65),
  commercialAdsPolicy: commercialAdsPolicySchema.nullable().default(null),
  settingsRevision: z.string().datetime().optional(),
  profanityBotMessageEnabled: z.boolean().default(false),
  profanityBotMessageText: botMessageTextSchema,
  profanityWarnEnabled: z.boolean().default(false),
  profanityWarnMessageText: botMessageTextSchema,
  profanityBanEnabled: z.boolean().default(false),
  profanityMuteEnabled: z.boolean().default(false),
  profanityMuteDurationHours: autoMuteDurationHoursSchema,
  profanityAdminContactButtonEnabled: z.boolean().default(false),
  profanityAdminContactButtonUrl: botButtonUrlSchema,
  textFiltersBotMessageEnabled: z.boolean().default(false),
  textFiltersBotMessageText: botMessageTextSchema,
  textFiltersWarnEnabled: z.boolean().default(false),
  textFiltersWarnMessageText: botMessageTextSchema,
  textFiltersBanEnabled: z.boolean().default(false),
  textFiltersMuteEnabled: z.boolean().default(false),
  textFiltersMuteDurationHours: autoMuteDurationHoursSchema,
  textFiltersAdminContactButtonEnabled: z.boolean().default(false),
  textFiltersAdminContactButtonUrl: botButtonUrlSchema,
  textFiltersBotButtonEnabled: z.boolean().default(false),
  textFiltersBotButtonUrl: botButtonUrlSchema,
  textFiltersBotButtonText: botButtonTextSchema,
  textFiltersBotButtons: z
    .array(storedLinkButtonDraftSchema)
    .max(MAX_BROADCAST_LINK_BUTTONS)
    .default([]),
  textFiltersRulesButtonEnabled: z.boolean().default(false),
  nightModeEnabled: z.boolean().default(false),
  nightModeStartTimeMinutes: z
    .number()
    .int()
    .min(0)
    .max(1_439)
    .default(23 * 60),
  nightModeEndTimeMinutes: z
    .number()
    .int()
    .min(0)
    .max(1_439)
    .default(8 * 60),
  nightModeTimezone: z.string().trim().min(1).max(64).default('Europe/Moscow'),
  nightModeBotMessageEnabled: z.boolean().default(false),
  nightModeBotMessageText: botMessageTextSchema,
  nightModeCommentsEnabled: z.boolean().default(false),
  nightModeOpenMessageEnabled: z.boolean().default(false),
  nightModeOpenMessageText: botMessageTextSchema,
  nightModeBotButtonEnabled: z.boolean().default(false),
  nightModeBotButtonUrl: botButtonUrlSchema,
  nightModeBotButtonText: botButtonTextSchema,
  nightModeBotButtons: z
    .array(storedLinkButtonDraftSchema)
    .max(MAX_BROADCAST_LINK_BUTTONS)
    .default([]),
  nightModeRulesButtonEnabled: z.boolean().default(false),
  nightModeForceCloseEnabled: z.boolean().default(false),
  nightModeForceCloseForever: z.boolean().default(false),
  nightModeForceCloseHours: z.number().int().min(0).max(23).default(8),
  nightModeForceCloseDays: z.number().int().min(0).max(30).default(0),
  nightModeForceCloseUntil: nightModeForceCloseUntilSchema,
  linkBotMessageEnabled: z.boolean().default(false),
  linkBotMessageText: botMessageTextSchema,
  linkWarnEnabled: z.boolean().default(false),
  linkWarnMessageText: botMessageTextSchema,
  linkBanEnabled: z.boolean().default(false),
  linkMuteEnabled: z.boolean().default(false),
  linkMuteDurationHours: autoMuteDurationHoursSchema,
  linkAdminContactButtonEnabled: z.boolean().default(false),
  linkAdminContactButtonUrl: botButtonUrlSchema,
  linkBotButtonEnabled: z.boolean().default(false),
  linkBotButtonUrl: botButtonUrlSchema,
  linkBotButtonText: botButtonTextSchema,
  linkBotButtons: z.array(storedLinkButtonDraftSchema).max(MAX_BROADCAST_LINK_BUTTONS).default([]),
  linkRulesButtonEnabled: z.boolean().default(false),
  duplicateBotMessageEnabled: z.boolean().default(false),
  duplicateBotMessageText: botMessageTextSchema,
  duplicateAdminContactButtonEnabled: z.boolean().default(false),
  duplicateAdminContactButtonUrl: botButtonUrlSchema,
  duplicateBotButtonEnabled: z.boolean().default(false),
  duplicateBotButtonUrl: botButtonUrlSchema,
  duplicateBotButtonText: botButtonTextSchema,
  duplicateBotButtons: z
    .array(storedLinkButtonDraftSchema)
    .max(MAX_BROADCAST_LINK_BUTTONS)
    .default([]),
  duplicateRulesButtonEnabled: z.boolean().default(false),
  messageLimitsRulesButtonEnabled: z.boolean().default(false),
  rulesAttachViolationsEnabled: z.boolean().default(false),
  adminBanCommandName: adminCommandNameSchema.default(ADMIN_BAN_COMMAND_NAME_DEFAULT),
  adminBanAllCommandName: adminCommandNameSchema.default(ADMIN_BAN_ALL_COMMAND_NAME_DEFAULT),
  adminMuteCommandName: adminCommandNameSchema.default(ADMIN_MUTE_COMMAND_NAME_DEFAULT),
  adminPermanentMuteCommandName: adminCommandNameSchema.default(
    ADMIN_PERMANENT_MUTE_COMMAND_NAME_DEFAULT,
  ),
  adminRulesCommandName: adminCommandNameSchema.default(ADMIN_RULES_COMMAND_NAME_DEFAULT),
  adminSilenceCommandName: adminCommandNameSchema.default(ADMIN_SILENCE_COMMAND_NAME_DEFAULT),
  adminOpenChatCommandName: adminCommandNameSchema.default(ADMIN_OPEN_CHAT_COMMAND_NAME_DEFAULT),
  adminMuteCommandAliases: adminCommandAliasesTextSchema.default(
    ADMIN_MUTE_COMMAND_ALIASES_DEFAULT,
  ),
  adminRulesCommandAliases: adminCommandAliasesTextSchema.default(
    ADMIN_RULES_COMMAND_ALIASES_DEFAULT,
  ),
  muteDurationHours: autoMuteDurationHoursSchema,
  warnThreshold: z.number().int().min(1).max(10).default(3),
});

export { stopWordsPolicySchema } from './stop-words.js';
