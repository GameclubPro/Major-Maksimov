import {
  broadcastScheduleTimezoneSchema,
  isValidIanaTimeZone,
  broadcastDateTimeSchema,
  inferBroadcastScheduleMode,
} from './broadcast-schedule-fields.js';
import { broadcastLinkButtonSchema, type BroadcastLinkButton } from './broadcast-buttons.js';
import {
  managedBroadcastTargetPreviewSchema,
  managedBroadcastStatusSchema,
  managedBroadcastFailureBreakdownSchema,
  managedBroadcastSummarySchema,
} from './managed-broadcast-summary.js';
export {
  managedBroadcastTargetPreviewSchema,
  type ManagedBroadcastTargetPreview,
  managedBroadcastStatusSchema,
  type ManagedBroadcastStatus,
  managedBroadcastFailureBreakdownSchema,
  type ManagedBroadcastFailureBreakdown,
  managedBroadcastSummarySchema,
  type ManagedBroadcastSummary,
} from './managed-broadcast-summary.js';
export {
  channelSettingsScreenResponseSchema,
  type ChannelSettingsScreenResponse,
} from './channel-settings.js';
export {
  channelSettingsSchema,
  channelSuggestionEntryModeSchema,
  type ChannelSettings,
  type ChannelSuggestionEntryMode,
} from './channel-settings-field-schemas.js';
export { broadcastLinkButtonSchema, type BroadcastLinkButton } from './broadcast-buttons.js';
import {
  chatSettingsFieldsSchema,
  botButtonUrlSchema,
  botButtonTextSchema,
  isValidBotButtonUrl,
  parseHttpButtonUrl,
  isValidBotButtonText,
} from './settings-field-schemas.js';
export {
  chatSettingsFieldsSchema,
  linkPolicySchema,
  botSpeechMediaSchema,
  BOT_SPEECH_MEDIA_IMAGE_BASE64_MAX_LENGTH,
  MAX_BOT_SPEECH_TEXT_LENGTH,
  REQUIRED_SUBSCRIPTION_MAX_CHANNELS,
  REQUIRED_SUBSCRIPTION_DURATION_DAYS_MIN,
  REQUIRED_SUBSCRIPTION_DURATION_DAYS_MAX,
  REQUIRED_SUBSCRIPTION_DURATION_DAYS_DEFAULT,
  INVITATION_ACCESS_REQUIRED_COUNT_MIN,
  INVITATION_ACCESS_REQUIRED_COUNT_MAX,
  MAX_MESSAGE_LENGTH_MIN,
  MAX_MESSAGE_LENGTH_MAX,
  MAX_MESSAGE_LENGTH_DEFAULT,
  MESSAGE_LIMITS_BLOCKED_WORDS_MAX,
  MESSAGE_LIMITS_BLOCKED_DOMAINS_MAX,
  profanitySensitivitySchema,
  commercialAdsSensitivitySchema,
  ADMIN_COMMAND_NAME_MAX_LENGTH,
  ADMIN_BAN_COMMAND_NAME_DEFAULT,
  ADMIN_BAN_ALL_COMMAND_NAME_DEFAULT,
  ADMIN_MUTE_COMMAND_NAME_DEFAULT,
  ADMIN_PERMANENT_MUTE_COMMAND_NAME_DEFAULT,
  ADMIN_RULES_COMMAND_NAME_DEFAULT,
  ADMIN_SILENCE_COMMAND_NAME_DEFAULT,
  ADMIN_OPEN_CHAT_COMMAND_NAME_DEFAULT,
  ADMIN_COMMAND_ALIASES_MAX,
  ADMIN_COMMAND_ALIAS_MAX_LENGTH,
  ADMIN_MUTE_COMMAND_ALIASES_DEFAULT,
  ADMIN_RULES_COMMAND_ALIASES_DEFAULT,
  type ProfanitySensitivity,
  type BotSpeechMedia,
  type BotSpeechMediaImage,
} from './settings-field-schemas.js';
import { applySettingsSectionSchema } from './settings-sections.js';
export { applySettingsSectionSchema, type ApplySettingsSection } from './settings-sections.js';
import { chatClosureStatusSchema } from './chat-closure-status.js';
import { chatRulesFieldsSchema } from './chat-rules-field-schemas.js';
export { chatRulesFieldsSchema, MAX_CHAT_RULES_TEXT_LENGTH } from './chat-rules-field-schemas.js';
import { z } from 'zod';
import * as sectionApply from './settings-apply-error.js';
import { addReportCommandIssues } from './report-settings.js';
export * from './bot-speech.js';
export * from './broadcast-common.js';
export * from './chat-rules-publication.js';
export * from './channel-stats.js';
export * from './channel-dialog.js';
export * from './giveaway.js';
export * from './managed-entities.js';
export { logsDashboardRangeSchema, type LogsDashboardRange } from './dashboard-common.js';
export * from './membership-activity.js';
import { botSpeechPreviewProfileSchema } from './bot-speech.js';
import {
  DEFAULT_BROADCAST_BUTTON_TEXT,
  MAX_BROADCAST_IMAGES,
  MAX_BROADCAST_IMAGES_TOTAL_BASE64,
  MAX_BROADCAST_IMAGE_BASE64_LENGTH,
  MAX_BROADCAST_LINK_BUTTONS,
  broadcastImageSchema,
  broadcastMediaTypeSchema,
  broadcastScheduleModeSchema,
  broadcastTargetModeSchema,
  broadcastTextFormatSchema,
  type BroadcastImage,
  type BroadcastMediaType,
} from './broadcast-common.js';
import { booleanQueryFlagSchema, logsDashboardRangeSchema } from './dashboard-common.js';
import * as dupe from './duplicate-settings.js';
import { messageRetentionSummarySchema } from './message-retention-summary.js';
import {
  normalizeMessageLimitsBlockedWordCandidate,
  normalizeMessageLimitsBlockedDomainCandidate,
} from './stop-words-legacy.js';
export {
  normalizeMessageLimitsBlockedWordCandidate,
  normalizeMessageLimitsBlockedDomainCandidate,
} from './stop-words-legacy.js';
export * from './stop-words.js';
import {
  addBroadcastAudienceIssues,
  addBroadcastScheduleIssues,
  buildBroadcastAudienceState,
  buildBroadcastScheduleState,
  normalizeBroadcastScheduledSlots,
} from './broadcast-request-utils.js';
import { membershipActivityPageSchema } from './membership-activity.js';
import { domainAllowlistEntrySchema } from './navigation-allowlist.js';
import {
  chatSummarySchema,
  managedEntityFavoriteTypeSchema,
  managedEntityHeaderSchema,
  managedEntityTypeSchema,
} from './managed-entities.js';
export { meSchema, type Me } from './miniapp-session.js';
export * from './navigation-allowlist.js';
export * from './settings-utils.js';
export * from './vk-parsing.js';

export const sanctionActionSchema = z.enum([
  'NONE',
  'WARN',
  'DELETE_MESSAGE',
  'MUTE',
  'KICK',
  'BAN',
]);
export type SanctionAction = z.infer<typeof sanctionActionSchema>;
const RESERVED_ADMIN_COMMAND_NAMES = new Set(['супер бан', 'супер-бан', 'super ban', 'super-ban']);
const BROADCAST_CYCLE_MAX_WINDOW_HOURS = 31 * 24;
function buildAdminCommandRuntimeVariants(commandName: string): string[] {
  if (/[.!]$/u.test(commandName)) {
    return [commandName];
  }

  return [commandName, `${commandName}!`, `${commandName}.`];
}
function isReservedAdminCommandName(commandName: string): boolean {
  const normalized = commandName.replace(/[.!]$/u, '');
  return RESERVED_ADMIN_COMMAND_NAMES.has(normalized);
}
function isRecordPayload(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readBroadcastImagePayload(value: unknown): BroadcastImage | null {
  if (!isRecordPayload(value)) {
    return null;
  }

  const base64 = typeof value.base64 === 'string' ? value.base64.trim() : '';
  if (!base64) {
    return null;
  }

  return {
    base64,
    mimeType: typeof value.mimeType === 'string' ? value.mimeType.trim() : '',
    fileName: typeof value.fileName === 'string' ? value.fileName.trim() : '',
  };
}

function dedupeBroadcastImages(images: BroadcastImage[]): BroadcastImage[] {
  const normalized: BroadcastImage[] = [];
  const seenBase64 = new Set<string>();

  for (const image of images) {
    const base64 = image.base64.trim();
    if (!base64 || seenBase64.has(base64)) {
      continue;
    }

    normalized.push({
      base64,
      mimeType: image.mimeType.trim(),
      fileName: image.fileName.trim(),
    });
    seenBase64.add(base64);
    if (normalized.length >= MAX_BROADCAST_IMAGES) {
      break;
    }
  }

  return normalized;
}

function readBroadcastMediaPayloadImages(value: unknown): BroadcastImage[] {
  if (!isRecordPayload(value) || !Array.isArray(value.images)) {
    return [];
  }

  return dedupeBroadcastImages(
    value.images
      .map((item) => readBroadcastImagePayload(item))
      .filter((image): image is BroadcastImage => image !== null),
  );
}

function normalizeBroadcastVideoPayload(value: unknown): Record<string, unknown> | null {
  if (!isRecordPayload(value) || typeof value.token !== 'string') {
    return null;
  }
  const token = value.token.trim();
  if (!token) return null;

  return { ...value, token };
}

function normalizeBroadcastImages(value: {
  images?: BroadcastImage[];
  imageBase64?: string;
  imageMimeType?: string;
  imageFileName?: string;
  mediaType?: BroadcastMediaType | null;
  mediaPayload?: Record<string, unknown> | null;
}): BroadcastImage[] {
  const explicitImages = Array.isArray(value.images)
    ? dedupeBroadcastImages(value.images.filter((image) => image.base64.trim().length > 0))
    : [];
  if (explicitImages.length > 0) {
    return explicitImages;
  }

  const payloadImages =
    value.mediaType === 'image' ? readBroadcastMediaPayloadImages(value.mediaPayload) : [];
  if (payloadImages.length > 0) {
    return payloadImages;
  }

  const imageBase64 = value.imageBase64?.trim() ?? '';
  if (!imageBase64) {
    return [];
  }

  return dedupeBroadcastImages([
    {
      base64: imageBase64,
      mimeType: value.imageMimeType?.trim() ?? '',
      fileName: value.imageFileName?.trim() ?? '',
    },
  ]);
}

function getBroadcastImagesTotalBase64Length(images: BroadcastImage[]): number {
  return images.reduce((total, image) => total + image.base64.trim().length, 0);
}

function normalizeStoredLinkButtons(values: BroadcastLinkButton[]): BroadcastLinkButton[] {
  return values.map((value) => ({
    text: value.text.trim() || DEFAULT_BROADCAST_BUTTON_TEXT,
    url: value.url.trim(),
  }));
}

function resolveStoredLinkButtons(value: {
  buttons?: BroadcastLinkButton[];
  buttonUrl?: string;
  buttonText?: string;
}): BroadcastLinkButton[] {
  if (Array.isArray(value.buttons) && value.buttons.length > 0) {
    return normalizeStoredLinkButtons(value.buttons);
  }

  const legacyUrl = value.buttonUrl?.trim() ?? '';
  if (!legacyUrl) {
    return [];
  }

  return normalizeStoredLinkButtons([
    {
      text: value.buttonText ?? DEFAULT_BROADCAST_BUTTON_TEXT,
      url: legacyUrl,
    },
  ]);
}

function buildStoredLinkButtonState(value: {
  buttons?: BroadcastLinkButton[];
  buttonEnabled?: boolean;
  buttonUrl?: string;
  buttonText?: string;
}): {
  buttons: BroadcastLinkButton[];
  buttonEnabled: boolean;
  buttonUrl: string;
  buttonText: string;
} {
  const buttons = resolveStoredLinkButtons(value);
  const primaryButton = buttons[0];

  return {
    buttons,
    buttonEnabled: value.buttonEnabled === true,
    buttonUrl: primaryButton?.url ?? value.buttonUrl?.trim() ?? '',
    buttonText: primaryButton?.text ?? (value.buttonText?.trim() || DEFAULT_BROADCAST_BUTTON_TEXT),
  };
}

function addStoredLinkButtonIssues(
  buttons: BroadcastLinkButton[],
  ctx: z.RefinementCtx,
  path: [string],
): void {
  buttons.forEach((button, index) => {
    if (!isValidBotButtonUrl(button.url)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [...path, index, 'url'],
        message: 'Укажите корректную ссылку для кнопки (http/https).',
      });
    }

    if (!isValidBotButtonText(button.text)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [...path, index, 'text'],
        message: 'Введите название кнопки.',
      });
    }
  });
}

function addStoredBotButtonGroupIssues(
  value: {
    enabled: boolean;
    buttons: BroadcastLinkButton[];
    buttonsPath: string;
    buttonUrl: string;
    buttonText: string;
    buttonUrlPath: string;
    buttonTextPath: string;
  },
  ctx: z.RefinementCtx,
): void {
  if (!value.enabled) {
    return;
  }

  if (value.buttons.length > 0) {
    addStoredLinkButtonIssues(value.buttons, ctx, [value.buttonsPath]);
    return;
  }

  if (!isValidBotButtonUrl(value.buttonUrl)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: [value.buttonUrlPath],
      message: 'Укажите корректную ссылку для кнопки (http/https).',
    });
  }

  if (!isValidBotButtonText(value.buttonText)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: [value.buttonTextPath],
      message: 'Введите название кнопки.',
    });
  }
}
function isValidAdminContactButtonUrl(value: string): boolean {
  return parseHttpButtonUrl(value) !== null;
}

const CHAT_ADMIN_CONTACT_BUTTON_GROUPS = [
  ['requiredSubscriptionAdminContactButtonEnabled', 'requiredSubscriptionAdminContactButtonUrl'],
  ['invitationAccessAdminContactButtonEnabled', 'invitationAccessAdminContactButtonUrl'],
  ['messageLimitsAdminContactButtonEnabled', 'messageLimitsAdminContactButtonUrl'],
  ['phoneNumbersAdminContactButtonEnabled', 'phoneNumbersAdminContactButtonUrl'],
  ['profanityAdminContactButtonEnabled', 'profanityAdminContactButtonUrl'],
  ['textFiltersAdminContactButtonEnabled', 'textFiltersAdminContactButtonUrl'],
  ['linkAdminContactButtonEnabled', 'linkAdminContactButtonUrl'],
  ['duplicateAdminContactButtonEnabled', 'duplicateAdminContactButtonUrl'],
] as const;

const AUTO_MUTE_DURATION_FIELD_KEYS = [
  'duplicateMuteDurationHours',
  'linkMuteDurationHours',
  'messageLimitsMuteDurationHours',
  'phoneNumbersMuteDurationHours',
  'profanityMuteDurationHours',
  'requiredSubscriptionMuteDurationHours',
  'invitationAccessMuteDurationHours',
  'textFiltersMuteDurationHours',
] as const;

export const chatSettingsSchema = z
  .preprocess((input) => {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      return input;
    }

    const value = input as Record<string, unknown>;
    const legacyMuteDurationHours =
      typeof value.muteDurationHours === 'number' && Number.isFinite(value.muteDurationHours)
        ? value.muteDurationHours
        : null;

    if (legacyMuteDurationHours === null) {
      return value;
    }

    const nextValue = { ...value };
    for (const key of AUTO_MUTE_DURATION_FIELD_KEYS) {
      if (nextValue[key] === undefined) {
        nextValue[key] = legacyMuteDurationHours;
      }
    }

    return nextValue;
  }, chatSettingsFieldsSchema)
  .superRefine((value, ctx) => {
    const linkBotButtons = resolveStoredLinkButtons({
      buttons: value.linkBotButtons,
      buttonUrl: value.linkBotButtonUrl,
      buttonText: value.linkBotButtonText,
    });
    addStoredBotButtonGroupIssues(
      {
        enabled: value.linkBotMessageEnabled && value.linkBotButtonEnabled,
        buttons: linkBotButtons,
        buttonsPath: 'linkBotButtons',
        buttonUrl: value.linkBotButtonUrl,
        buttonText: value.linkBotButtonText,
        buttonUrlPath: 'linkBotButtonUrl',
        buttonTextPath: 'linkBotButtonText',
      },
      ctx,
    );

    const greetingBotButtons = resolveStoredLinkButtons({
      buttons: value.greetingBotButtons,
      buttonUrl: value.greetingBotButtonUrl,
      buttonText: value.greetingBotButtonText,
    });
    addStoredBotButtonGroupIssues(
      {
        enabled:
          value.greetingEnabled &&
          value.greetingBotMessageEnabled &&
          value.greetingBotButtonEnabled,
        buttons: greetingBotButtons,
        buttonsPath: 'greetingBotButtons',
        buttonUrl: value.greetingBotButtonUrl,
        buttonText: value.greetingBotButtonText,
        buttonUrlPath: 'greetingBotButtonUrl',
        buttonTextPath: 'greetingBotButtonText',
      },
      ctx,
    );

    for (const [enabledKey, urlKey] of CHAT_ADMIN_CONTACT_BUTTON_GROUPS) {
      if (value[enabledKey] && !isValidAdminContactButtonUrl(value[urlKey])) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [urlKey],
          message: 'Не удалось сохранить ссылку на администратора.',
        });
      }
    }

    const adminCommandEntries = [
      ['adminBanCommandName', value.adminBanCommandName],
      ['adminBanAllCommandName', value.adminBanAllCommandName],
      ['adminMuteCommandName', value.adminMuteCommandName],
      ['adminPermanentMuteCommandName', value.adminPermanentMuteCommandName],
      ['adminRulesCommandName', value.adminRulesCommandName],
      ['adminSilenceCommandName', value.adminSilenceCommandName],
      ['adminOpenChatCommandName', value.adminOpenChatCommandName],
    ] as const;
    for (const [key, commandName] of adminCommandEntries) {
      if (isReservedAdminCommandName(commandName.toLowerCase())) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [key],
          message: 'Эта команда зарезервирована ботом.',
        });
      }
    }
    for (let index = 0; index < adminCommandEntries.length; index += 1) {
      const [key, commandName] = adminCommandEntries[index];
      for (const [, otherCommandName] of adminCommandEntries.slice(0, index)) {
        if (commandName.toLowerCase() === otherCommandName.toLowerCase()) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [key],
            message: 'Такая команда уже используется в этом блоке.',
          });
          break;
        }
      }
    }
    const adminCommandRuntimeVariants = new Map<string, (typeof adminCommandEntries)[number][0]>();
    for (const [key, commandName] of adminCommandEntries) {
      const normalizedCommandName = commandName.toLowerCase();
      for (const variant of buildAdminCommandRuntimeVariants(normalizedCommandName)) {
        const existingKey = adminCommandRuntimeVariants.get(variant);
        if (!existingKey) {
          adminCommandRuntimeVariants.set(variant, key);
          continue;
        }

        const allowedBanPair =
          existingKey === 'adminBanCommandName' &&
          key === 'adminBanAllCommandName' &&
          normalizedCommandName === `${value.adminBanCommandName.toLowerCase()}!`;
        if (!allowedBanPair) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [key],
            message: 'Такая команда пересекается с другой командой с учетом ! или .',
          });
          break;
        }
      }
    }

    const duplicateBotButtons = resolveStoredLinkButtons({
      buttons: value.duplicateBotButtons,
      buttonUrl: value.duplicateBotButtonUrl,
      buttonText: value.duplicateBotButtonText,
    });
    addStoredBotButtonGroupIssues(
      {
        enabled: value.duplicateBotMessageEnabled && value.duplicateBotButtonEnabled,
        buttons: duplicateBotButtons,
        buttonsPath: 'duplicateBotButtons',
        buttonUrl: value.duplicateBotButtonUrl,
        buttonText: value.duplicateBotButtonText,
        buttonUrlPath: 'duplicateBotButtonUrl',
        buttonTextPath: 'duplicateBotButtonText',
      },
      ctx,
    );

    const messageLimitsBotButtons = resolveStoredLinkButtons({
      buttons: value.messageLimitsBotButtons,
      buttonUrl: value.messageLimitsBotButtonUrl,
      buttonText: value.messageLimitsBotButtonText,
    });
    addStoredBotButtonGroupIssues(
      {
        enabled: value.messageLimitsBotMessageEnabled && value.messageLimitsBotButtonEnabled,
        buttons: messageLimitsBotButtons,
        buttonsPath: 'messageLimitsBotButtons',
        buttonUrl: value.messageLimitsBotButtonUrl,
        buttonText: value.messageLimitsBotButtonText,
        buttonUrlPath: 'messageLimitsBotButtonUrl',
        buttonTextPath: 'messageLimitsBotButtonText',
      },
      ctx,
    );

    const normalizedMessageLimitsBlockedWords = new Set<string>();
    for (const rawWord of value.messageLimitsBlockedWords) {
      const normalizedWord = normalizeMessageLimitsBlockedWordCandidate(rawWord);
      if (!normalizedWord || normalizedWord.length < 2 || normalizedWord.length > 32) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['messageLimitsBlockedWords'],
          message: 'Нужно одно слово без пробелов, от 2 до 32 символов.',
        });
        break;
      }

      if (normalizedMessageLimitsBlockedWords.has(normalizedWord)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['messageLimitsBlockedWords'],
          message: 'Это слово уже есть в списке.',
        });
        break;
      }

      normalizedMessageLimitsBlockedWords.add(normalizedWord);
    }

    const normalizedMessageLimitsBlockedDomains = new Set<string>();
    for (const rawDomain of value.messageLimitsBlockedDomains) {
      const normalizedDomain = normalizeMessageLimitsBlockedDomainCandidate(rawDomain);
      if (!normalizedDomain) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['messageLimitsBlockedDomains'],
          message: 'Укажите домен или ссылку.',
        });
        break;
      }

      if (normalizedMessageLimitsBlockedDomains.has(normalizedDomain)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['messageLimitsBlockedDomains'],
          message: 'Этот домен уже есть в списке.',
        });
        break;
      }

      normalizedMessageLimitsBlockedDomains.add(normalizedDomain);
    }

    const textFiltersBotButtons = resolveStoredLinkButtons({
      buttons: value.textFiltersBotButtons,
      buttonUrl: value.textFiltersBotButtonUrl,
      buttonText: value.textFiltersBotButtonText,
    });
    addStoredBotButtonGroupIssues(
      {
        enabled: value.textFiltersBotMessageEnabled && value.textFiltersBotButtonEnabled,
        buttons: textFiltersBotButtons,
        buttonsPath: 'textFiltersBotButtons',
        buttonUrl: value.textFiltersBotButtonUrl,
        buttonText: value.textFiltersBotButtonText,
        buttonUrlPath: 'textFiltersBotButtonUrl',
        buttonTextPath: 'textFiltersBotButtonText',
      },
      ctx,
    );

    if (!isValidIanaTimeZone(value.nightModeTimezone)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['nightModeTimezone'],
        message: 'Укажите корректный часовой пояс.',
      });
    }

    dupe.addDuplicateScheduleIssues(value, ctx);

    if (value.commercialAdsDeleteThreshold <= value.commercialAdsWarnThreshold) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['commercialAdsDeleteThreshold'],
        message: 'Порог удаления должен быть выше порога предупреждения.',
      });
    }

    const nightModeBotButtons = resolveStoredLinkButtons({
      buttons: value.nightModeBotButtons,
      buttonUrl: value.nightModeBotButtonUrl,
      buttonText: value.nightModeBotButtonText,
    });
    addStoredBotButtonGroupIssues(
      {
        enabled: value.nightModeBotMessageEnabled && value.nightModeBotButtonEnabled,
        buttons: nightModeBotButtons,
        buttonsPath: 'nightModeBotButtons',
        buttonUrl: value.nightModeBotButtonUrl,
        buttonText: value.nightModeBotButtonText,
        buttonUrlPath: 'nightModeBotButtonUrl',
        buttonTextPath: 'nightModeBotButtonText',
      },
      ctx,
    );

    if (
      value.nightModeForceCloseEnabled &&
      !value.nightModeForceCloseForever &&
      value.nightModeForceCloseHours === 0 &&
      value.nightModeForceCloseDays === 0
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['nightModeForceCloseHours'],
        message: 'Укажите длительность хотя бы на 1 час или 1 день.',
      });
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['nightModeForceCloseDays'],
        message: 'Укажите длительность хотя бы на 1 час или 1 день.',
      });
    }
  })
  .transform((value) => {
    const requiredSubscriptionChannelIds = Array.from(
      new Set(value.requiredSubscriptionChannelIds.map((item) => item.trim()).filter(Boolean)),
    );
    const greetingBotButtonState = buildStoredLinkButtonState({
      buttons: value.greetingBotButtons,
      buttonEnabled: value.greetingBotButtonEnabled,
      buttonUrl: value.greetingBotButtonUrl,
      buttonText: value.greetingBotButtonText,
    });
    const messageLimitsBotButtonState = buildStoredLinkButtonState({
      buttons: value.messageLimitsBotButtons,
      buttonEnabled: value.messageLimitsBotButtonEnabled,
      buttonUrl: value.messageLimitsBotButtonUrl,
      buttonText: value.messageLimitsBotButtonText,
    });
    const textFiltersBotButtonState = buildStoredLinkButtonState({
      buttons: value.textFiltersBotButtons,
      buttonEnabled: value.textFiltersBotButtonEnabled,
      buttonUrl: value.textFiltersBotButtonUrl,
      buttonText: value.textFiltersBotButtonText,
    });
    const nightModeBotButtonState = buildStoredLinkButtonState({
      buttons: value.nightModeBotButtons,
      buttonEnabled: value.nightModeBotButtonEnabled,
      buttonUrl: value.nightModeBotButtonUrl,
      buttonText: value.nightModeBotButtonText,
    });
    const linkBotButtonState = buildStoredLinkButtonState({
      buttons: value.linkBotButtons,
      buttonEnabled: value.linkBotButtonEnabled,
      buttonUrl: value.linkBotButtonUrl,
      buttonText: value.linkBotButtonText,
    });
    const duplicateBotButtonState = buildStoredLinkButtonState({
      buttons: value.duplicateBotButtons,
      buttonEnabled: value.duplicateBotButtonEnabled,
      buttonUrl: value.duplicateBotButtonUrl,
      buttonText: value.duplicateBotButtonText,
    });

    return {
      ...value,
      requiredSubscriptionEnabled: requiredSubscriptionChannelIds.length > 0,
      requiredSubscriptionChannelIds,
      requiredSubscriptionExpiresAt: '',
      greetingBotButtons: greetingBotButtonState.buttons,
      greetingBotButtonEnabled: greetingBotButtonState.buttonEnabled,
      greetingBotButtonUrl: greetingBotButtonState.buttonUrl,
      greetingBotButtonText: greetingBotButtonState.buttonText,
      messageLimitsBotButtons: messageLimitsBotButtonState.buttons,
      messageLimitsBotButtonEnabled: messageLimitsBotButtonState.buttonEnabled,
      messageLimitsBotButtonUrl: messageLimitsBotButtonState.buttonUrl,
      messageLimitsBotButtonText: messageLimitsBotButtonState.buttonText,
      textFiltersBotButtons: textFiltersBotButtonState.buttons,
      textFiltersBotButtonEnabled: textFiltersBotButtonState.buttonEnabled,
      textFiltersBotButtonUrl: textFiltersBotButtonState.buttonUrl,
      textFiltersBotButtonText: textFiltersBotButtonState.buttonText,
      nightModeBotButtons: nightModeBotButtonState.buttons,
      nightModeBotButtonEnabled: nightModeBotButtonState.buttonEnabled,
      nightModeBotButtonUrl: nightModeBotButtonState.buttonUrl,
      nightModeBotButtonText: nightModeBotButtonState.buttonText,
      linkBotButtons: linkBotButtonState.buttons,
      linkBotButtonEnabled: linkBotButtonState.buttonEnabled,
      linkBotButtonUrl: linkBotButtonState.buttonUrl,
      linkBotButtonText: linkBotButtonState.buttonText,
      duplicateBotButtons: duplicateBotButtonState.buttons,
      duplicateBotButtonEnabled: duplicateBotButtonState.buttonEnabled,
      duplicateBotButtonUrl: duplicateBotButtonState.buttonUrl,
      duplicateBotButtonText: duplicateBotButtonState.buttonText,
    };
  });
export type ChatSettings = z.infer<typeof chatSettingsSchema>;

const chatRulesObjectSchema = chatRulesFieldsSchema;

function addChatRulesDraftIssues(
  value: Pick<
    z.infer<typeof chatRulesObjectSchema>,
    | 'imageBase64'
    | 'imageMimeType'
    | 'buttons'
    | 'buttonEnabled'
    | 'buttonUrl'
    | 'buttonText'
    | 'adminContactButtonEnabled'
    | 'adminContactButtonUrl'
  > & { publishedUrl?: string | null },
  ctx: z.RefinementCtx,
) {
  const buttons = resolveStoredLinkButtons(value);
  if (value.imageBase64 && !value.imageMimeType.trim().toLowerCase().startsWith('image/')) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['imageMimeType'],
      message: 'Неверный формат фото.',
    });
  }
  if (value.buttonEnabled && buttons.length > 0) {
    addStoredLinkButtonIssues(buttons, ctx, ['buttons']);
  } else if (
    value.buttonEnabled &&
    value.buttons.length === 0 &&
    !isValidBotButtonUrl(value.buttonUrl)
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['buttonUrl'],
      message: 'Укажите корректную ссылку для кнопки (http/https).',
    });
  }
  if (
    !(value.buttonEnabled && buttons.length > 0) &&
    value.buttonEnabled &&
    value.buttons.length === 0 &&
    !isValidBotButtonText(value.buttonText)
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['buttonText'],
      message: 'Введите название кнопки.',
    });
  }
  if (
    value.adminContactButtonEnabled &&
    !isValidAdminContactButtonUrl(value.adminContactButtonUrl)
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['adminContactButtonUrl'],
      message: 'Ссылка на админа недоступна.',
    });
  }
  if (value.publishedUrl && !isValidBotButtonUrl(value.publishedUrl)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['publishedUrl'],
      message: 'Сохранена некорректная ссылка на пост правил.',
    });
  }
}

export const chatRulesSchema = chatRulesObjectSchema
  .superRefine(addChatRulesDraftIssues)
  .transform((value) => {
    const buttonState = buildStoredLinkButtonState(value);

    return {
      ...value,
      buttons: buttonState.buttons,
      buttonEnabled: buttonState.buttonEnabled,
      buttonUrl: buttonState.buttonUrl,
      buttonText: buttonState.buttonText,
    };
  });
export type ChatRules = z.infer<typeof chatRulesSchema>;

export const updateChatRulesRequestSchema = chatRulesObjectSchema
  .pick({
    text: true,
    textFormat: true,
    imageBase64: true,
    imageMimeType: true,
    imageFileName: true,
    autoTextEnabled: true,
    buttons: true,
    buttonEnabled: true,
    buttonUrl: true,
    buttonText: true,
    adminContactButtonEnabled: true,
    adminContactButtonUrl: true,
  })
  .extend({ expectedRevision: z.string().datetime().nullable().optional() })
  .superRefine(addChatRulesDraftIssues)
  .transform((value) => {
    const buttonState = buildStoredLinkButtonState(value);

    return {
      ...value,
      buttons: buttonState.buttons,
      buttonEnabled: buttonState.buttonEnabled,
      buttonUrl: buttonState.buttonUrl,
      buttonText: buttonState.buttonText,
    };
  });
export type UpdateChatRulesRequest = z.infer<typeof updateChatRulesRequestSchema>;

export const publishChatRulesResultSchema = z.object({
  operation: z.enum(['created', 'updated']).optional(),
  chatId: z.string().trim().min(1),
  messageId: z.string().trim().min(1),
  url: z
    .string()
    .trim()
    .min(1)
    .max(2_048)
    .refine((value) => isValidBotButtonUrl(value), {
      message: 'Укажите корректную ссылку на опубликованные правила.',
    })
    .nullable(),
  publishedAt: z.string().datetime(),
});
export type PublishChatRulesResult = z.infer<typeof publishChatRulesResultSchema>;

export const moderationEventSchema = z.object({
  id: z.string(),
  chatId: z.string(),
  userId: z.string(),
  eventType: z.enum(['MESSAGE', 'MEMBER_ACTION', 'SYSTEM']),
  ruleCode: z.string(),
  action: sanctionActionSchema,
  maskedExcerpt: z.string().nullable(),
  score: z.number(),
  metadata: z.record(z.string(), z.unknown()).nullable().optional(),
  createdAt: z.string().datetime(),
  operator: z.enum(['BOT', 'ADMIN']),
});
export type ModerationEvent = z.infer<typeof moderationEventSchema>;

export const resolveRequiredSubscriptionChannelRequestSchema = z.object({
  value: z.string().trim().min(1).max(2048),
});
export type ResolveRequiredSubscriptionChannelRequest = z.infer<
  typeof resolveRequiredSubscriptionChannelRequestSchema
>;

export const resolveRequiredSubscriptionChannelResponseSchema = z.object({
  channel: managedEntityHeaderSchema,
});
export type ResolveRequiredSubscriptionChannelResponse = z.infer<
  typeof resolveRequiredSubscriptionChannelResponseSchema
>;

export const applySettingsTargetModeSchema = z.enum([
  'all',
  'allFavorites',
  'favoriteTypes',
  'selectedChats',
  'current',
]);
export type ApplySettingsTargetMode = z.infer<typeof applySettingsTargetModeSchema>;

export const applySettingsTargetSchema = z
  .object({
    mode: applySettingsTargetModeSchema.default('current'),
    favoriteTypes: z.array(managedEntityFavoriteTypeSchema).max(6).default([]),
    chatIds: z.array(z.string().trim().min(1)).max(500).default([]),
  })
  .superRefine((value, ctx) => {
    if (value.mode === 'favoriteTypes' && value.favoriteTypes.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['favoriteTypes'],
        message: 'Выберите хотя бы один тип избранного.',
      });
    }

    if (value.mode === 'selectedChats' && value.chatIds.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['chatIds'],
        message: 'Выберите хотя бы один чат.',
      });
    }
  })
  .transform((value) => ({
    mode: value.mode,
    favoriteTypes: Array.from(new Set(value.favoriteTypes)),
    chatIds: Array.from(new Set(value.chatIds)),
  }));
export type ApplySettingsTarget = z.infer<typeof applySettingsTargetSchema>;

export const applySectionToAllRequestSchema = z
  .object({
    section: applySettingsSectionSchema,
    ...sectionApply.settingsSectionApplyRevisionShape,
    target: applySettingsTargetSchema
      .optional()
      .default({ mode: 'current', favoriteTypes: [], chatIds: [] }),
  })
  .superRefine(sectionApply.addSettingsSectionApplyIssues);
export type ApplySectionToAllRequest = z.infer<typeof applySectionToAllRequestSchema>;

export const applySectionToAllResponseSchema = z.object({
  section: applySettingsSectionSchema,
  sourceChatId: z.string(),
  updatedChats: z.number().int().min(0),
  appliedChatIds: z.array(z.string()),
  sourceSettingsRevision: z.string().datetime().optional(),
  targetMode: applySettingsTargetModeSchema.optional().default('current'),
  favoriteTypes: z.array(managedEntityFavoriteTypeSchema).optional().default([]),
});
export type ApplySectionToAllResponse = z.infer<typeof applySectionToAllResponseSchema>;

export {
  settingsApplyPartialErrorSchema,
  type SettingsApplyPartialError,
} from './settings-apply-error.js';

export const applySectionTargetPreviewRequestSchema = z.object({
  target: applySettingsTargetSchema
    .optional()
    .default({ mode: 'current', favoriteTypes: [], chatIds: [] }),
});
export type ApplySectionTargetPreviewRequest = z.infer<
  typeof applySectionTargetPreviewRequestSchema
>;

export const applySectionTargetPreviewResponseSchema = z.object({
  sourceChatId: z.string(),
  targetMode: applySettingsTargetModeSchema,
  favoriteTypes: z.array(managedEntityFavoriteTypeSchema).default([]),
  updatedChats: z.number().int().min(0),
  appliedChatIds: z.array(z.string()),
  sampleChats: z.array(chatSummarySchema).default([]),
});
export type ApplySectionTargetPreviewResponse = z.infer<
  typeof applySectionTargetPreviewResponseSchema
>;

export const dateRangeQuerySchema = z.object({
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export const logsDashboardQuerySchema = z.object({
  range: logsDashboardRangeSchema.default('7d'),
  includeActivityPreview: booleanQueryFlagSchema.default(true),
  includeModerationPreview: booleanQueryFlagSchema.default(true),
});
export type LogsDashboardQuery = z.infer<typeof logsDashboardQuerySchema>;

export const moderationFeedFilterSchema = z.enum([
  'ALL',
  'COMMERCIAL',
  'WARN',
  'DELETE_MESSAGE',
  'MUTE',
  'BAN',
  'UNMUTE',
  'UNBAN',
]);
export type ModerationFeedFilter = z.infer<typeof moderationFeedFilterSchema>;

export const moderationFeedQuerySchema = z.object({
  range: logsDashboardRangeSchema.default('7d'),
  filter: moderationFeedFilterSchema.default('ALL'),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().trim().min(1).optional(),
});
export type ModerationFeedQuery = z.infer<typeof moderationFeedQuerySchema>;

export const logsDashboardViolationSchema = z.object({
  id: z.string(),
  action: sanctionActionSchema,
  ruleCode: z.string(),
  userId: z.string(),
  userDisplayName: z.string().nullable(),
  avatarUrl: z.string().trim().url().nullable().default(null),
  profileUrl: z.string().trim().url().nullable().default(null),
  profileHandoffUrl: z.string().trim().url().nullable().default(null),
  createdAt: z.string().datetime(),
  maskedExcerpt: z.string().nullable(),
  metadata: z.record(z.string(), z.unknown()).nullable().optional(),
});
export type LogsDashboardViolation = z.infer<typeof logsDashboardViolationSchema>;

export const moderationFeedPageSchema = z.object({
  items: z.array(logsDashboardViolationSchema),
  hasMore: z.boolean(),
  nextCursor: z.string().nullable(),
});
export type ModerationFeedPage = z.infer<typeof moderationFeedPageSchema>;

export const logsDashboardResponseSchema = z.object({
  chat: z.object({
    id: z.string(),
    title: z.string(),
    participantsCount: z.number().int().min(0).nullable(),
    avatarUrl: z.string().trim().url().nullable().optional(),
  }),
  period: z.object({
    range: logsDashboardRangeSchema,
    from: z.string().datetime(),
    to: z.string().datetime(),
  }),
  membership: z.object({
    joinedUsers: z.number().int().min(0),
    leftUsers: z.number().int().min(0),
    netUsers: z.number().int(),
  }),
  violationsSummary: z.object({
    warn: z.number().int().min(0),
    deleteMessage: z.number().int().min(0),
    mute: z.number().int().min(0),
    ban: z.number().int().min(0),
    unmute: z.number().int().min(0),
    unban: z.number().int().min(0),
    affectedUsers: z.number().int().min(0),
    total: z.number().int().min(0),
  }),
  violations: z.array(logsDashboardViolationSchema),
  moderationFeed: moderationFeedPageSchema,
  activityFeed: membershipActivityPageSchema,
});
export type LogsDashboardResponse = z.infer<typeof logsDashboardResponseSchema>;

export const globalSpammerCandidateStatusSchema = z.enum([
  'PENDING',
  'AUTO_APPROVED',
  'APPROVED',
  'SUPPRESSED',
]);
export type GlobalSpammerCandidateStatus = z.infer<typeof globalSpammerCandidateStatusSchema>;

export const globalSpammerReviewActionSchema = z.enum(['APPROVE', 'SUPPRESS']);
export type GlobalSpammerReviewAction = z.infer<typeof globalSpammerReviewActionSchema>;

export const globalSpammerConfidenceLevelSchema = z.enum(['LOW', 'MEDIUM', 'HIGH']);
export type GlobalSpammerConfidenceLevel = z.infer<typeof globalSpammerConfidenceLevelSchema>;

export const globalSpammerReviewRequestSchema = z.object({
  action: globalSpammerReviewActionSchema,
  reason: z.string().trim().min(1).max(500).optional(),
});
export type GlobalSpammerReviewRequest = z.infer<typeof globalSpammerReviewRequestSchema>;

export const globalSpammerReviewResultSchema = z.object({
  ok: z.literal(true),
  status: globalSpammerCandidateStatusSchema,
  userId: z.string(),
});
export type GlobalSpammerReviewResult = z.infer<typeof globalSpammerReviewResultSchema>;

export const globalSpammerCandidateChatSchema = z.object({
  chatId: z.string(),
  detectionsCount: z.number().int().min(0),
  lastMessageId: z.string().nullable(),
  lastExcerpt: z.string().nullable(),
  lastUserLabel: z.string().nullable(),
  lastDetectedAt: z.string().datetime(),
});
export type GlobalSpammerCandidateChat = z.infer<typeof globalSpammerCandidateChatSchema>;

export const globalSpammerObservationSchema = z.object({
  id: z.string(),
  source: z.string(),
  score: z.number().min(0).max(1),
  confidenceLevel: globalSpammerConfidenceLevelSchema,
  reason: z.string(),
  chatId: z.string().nullable(),
  messageId: z.string().nullable(),
  evidenceHash: z.string(),
  evidence: z.unknown().nullable(),
  observedAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
  suppressedAt: z.string().datetime().nullable(),
  suppressionReason: z.string().nullable(),
});
export type GlobalSpammerObservation = z.infer<typeof globalSpammerObservationSchema>;

export const globalSpammerReviewCandidateSchema = z.object({
  userId: z.string(),
  displayName: z.string().trim().nullable().optional().default(null),
  avatarUrl: z.string().trim().url().nullable().optional().default(null),
  profileUrl: z.string().trim().url().nullable().optional().default(null),
  profileHandoffUrl: z.string().trim().url().nullable().optional().default(null),
  status: globalSpammerCandidateStatusSchema,
  confidenceScore: z.number().min(0).max(1),
  sourceBreakdown: z.unknown(),
  lastReason: z.string(),
  lastChatId: z.string().nullable(),
  lastEvidence: z.unknown().nullable(),
  lastUserLabel: z.string().nullable(),
  suppressedUntil: z.string().datetime().nullable(),
  reviewedAt: z.string().datetime().nullable(),
  reviewedByUserId: z.string().nullable(),
  reviewReason: z.string().nullable(),
  falsePositive: z.boolean(),
  chats: z.array(globalSpammerCandidateChatSchema),
  observations: z.array(globalSpammerObservationSchema),
});
export type GlobalSpammerReviewCandidate = z.infer<typeof globalSpammerReviewCandidateSchema>;

export const globalSpammerReviewQueueSchema = z.object({
  items: z.array(globalSpammerReviewCandidateSchema),
  limit: z.number().int().min(1).max(100),
});
export type GlobalSpammerReviewQueue = z.infer<typeof globalSpammerReviewQueueSchema>;

export const globalSpammerCampaignSummarySchema = z.object({
  clusterId: z.string(),
  signalType: z.string(),
  status: z.string(),
  confidenceScore: z.number().min(0).max(1),
  distinctUsersCount: z.number().int().min(0),
  distinctChatsCount: z.number().int().min(0),
  observationsCount: z.number().int().min(0),
  userObservationsCount: z.number().int().min(0).nullable().default(null),
  lastSeenAt: z.string().datetime(),
  preview: z.string().nullable(),
});
export type GlobalSpammerCampaignSummary = z.infer<typeof globalSpammerCampaignSummarySchema>;

export const globalSpammerShadowScoreSummarySchema = z.object({
  currentScore: z.number().min(0).max(1),
  v2Score: z.number().min(0).max(1),
  scoreDelta: z.number().min(-1).max(1),
  currentBand: z.string(),
  v2Band: z.string(),
  wouldPromote: z.boolean(),
  wouldSuppress: z.boolean(),
  createdAt: z.string().datetime(),
});
export type GlobalSpammerShadowScoreSummary = z.infer<typeof globalSpammerShadowScoreSummarySchema>;

export const globalSpammerReviewMetricsSchema = z.object({
  pending: z.number().int().min(0),
  approved: z.number().int().min(0),
  suppressed: z.number().int().min(0),
  reviewed: z.number().int().min(0),
  activeRegistry: z.number().int().min(0).default(0),
  expiredRegistry: z.number().int().min(0).default(0),
  archivedExpired: z.number().int().min(0).default(0),
  newCandidates24h: z.number().int().min(0).default(0),
  autoApproved24h: z.number().int().min(0).default(0),
  suppressed24h: z.number().int().min(0).default(0),
  shadowWouldEnforceCount: z.number().int().min(0).default(0),
  topCampaigns: z.array(globalSpammerCampaignSummarySchema).default([]),
  enforcementMode: z.enum(['enforce', 'shadow']).default('enforce'),
  falsePositiveCount: z.number().int().min(0),
  falsePositiveRate: z.number().min(0).max(1),
  recentObservations: z.array(
    z.object({
      source: z.string(),
      count: z.number().int().min(0),
    }),
  ),
  suppressedObservations: z.array(
    z.object({
      source: z.string(),
      count: z.number().int().min(0),
    }),
  ),
  sourceAlerts: z.array(
    z.object({
      source: z.string(),
      level: z.enum(['warning', 'critical']),
      reason: z.string(),
    }),
  ),
  sourceReputation: z
    .array(
      z.object({
        source: z.string(),
        weight: z.number().min(0).max(1),
        falsePositiveRate: z.number().min(0).max(1),
        observations: z.number().int().min(0),
        suppressed: z.number().int().min(0),
      }),
    )
    .default([]),
});
export type GlobalSpammerReviewMetrics = z.infer<typeof globalSpammerReviewMetricsSchema>;

export const globalSpammerRegistryStatusSchema = z.enum([
  'NONE',
  'ACTIVE_CONFIRMED',
  'LOCAL_BLOCKED',
  'MEDIUM_REVIEW',
  'SUPPRESSED',
  'EXPIRED',
  'ADMIN_EXEMPT',
]);
export type GlobalSpammerRegistryStatus = z.infer<typeof globalSpammerRegistryStatusSchema>;

export const globalSpammerPolicyActionSchema = z.enum([
  'NONE',
  'DELETE_AND_KICK',
  'SHADOW_DELETE_AND_KICK',
]);
export type GlobalSpammerPolicyAction = z.infer<typeof globalSpammerPolicyActionSchema>;

export const globalSpammerPolicyDecisionSchema = z.object({
  userId: z.string(),
  chatId: z.string().nullable(),
  trigger: z.string(),
  registryStatus: globalSpammerRegistryStatusSchema,
  action: globalSpammerPolicyActionSchema,
  enforcementMode: z.enum(['enforce', 'shadow']),
  policyBand: z.enum(['LOW', 'MEDIUM', 'HIGH', 'VERY_HIGH', 'CONFIRMED']).default('LOW'),
  deleteSpammersEnabled: z.boolean(),
  adminExempt: z.boolean(),
  shadow: z.boolean(),
  wouldEnforce: z.boolean(),
  enforced: z.boolean(),
  confidenceScore: z.number().min(0).max(1).nullable(),
  shadowScore: z.number().min(0).max(1).nullable().default(null),
  reason: z.string(),
  expiresAt: z.string().datetime().nullable(),
  sourceBreakdown: z.unknown().nullable(),
  campaignBreakdown: z.unknown().nullable().default(null),
});
export type GlobalSpammerPolicyDecision = z.infer<typeof globalSpammerPolicyDecisionSchema>;

export const localAdminSpammerDecisionSchema = z.enum(['ALLOW', 'BLOCK', 'REVIEW']);
export type LocalAdminSpammerDecision = z.infer<typeof localAdminSpammerDecisionSchema>;

export const globalSpammerUserDiagnosticsSchema = z.object({
  userId: z.string(),
  chatId: z.string().nullable(),
  displayName: z.string().trim().nullable().optional().default(null),
  avatarUrl: z.string().trim().url().nullable().optional().default(null),
  profileUrl: z.string().trim().url().nullable().optional().default(null),
  profileHandoffUrl: z.string().trim().url().nullable().optional().default(null),
  policy: globalSpammerPolicyDecisionSchema,
  registry: z.object({
    active: z.boolean(),
    expired: z.boolean(),
    confidenceScore: z.number().min(0).max(1).nullable(),
    confirmedAt: z.string().datetime().nullable(),
    confirmedByUserId: z.string().nullable(),
    reason: z.string().nullable(),
    expiresAt: z.string().datetime().nullable(),
    sourceBreakdown: z.unknown().nullable(),
  }),
  candidate: z
    .object({
      status: z.string(),
      confidenceScore: z.number().min(0).max(1),
      lastReason: z.string(),
      reviewedAt: z.string().datetime().nullable(),
      reviewedByUserId: z.string().nullable(),
      reviewReason: z.string().nullable(),
      falsePositive: z.boolean(),
    })
    .nullable(),
  activeSuppression: z
    .object({
      source: z.string(),
      reason: z.string(),
      adminUserId: z.string().nullable(),
      suppressedUntil: z.string().datetime(),
    })
    .nullable(),
  observations: z.array(
    z.object({
      id: z.string(),
      source: z.string(),
      score: z.number().min(0).max(1),
      confidenceLevel: z.string(),
      reason: z.string(),
      chatId: z.string().nullable(),
      observedAt: z.string().datetime(),
      expiresAt: z.string().datetime(),
      suppressedAt: z.string().datetime().nullable(),
    }),
  ),
  graphSignals: z.array(
    z.object({
      signalType: z.string(),
      source: z.string(),
      score: z.number().min(0).max(1),
      chatId: z.string().nullable(),
      observedAt: z.string().datetime(),
      expiresAt: z.string().datetime(),
    }),
  ),
  sourceReputation: z.array(
    z.object({
      source: z.string(),
      weight: z.number().min(0).max(1),
      falsePositiveRate: z.number().min(0).max(1),
      observations: z.number().int().min(0),
      suppressed: z.number().int().min(0),
    }),
  ),
  campaigns: z.array(globalSpammerCampaignSummarySchema).default([]),
  latestShadowScore: globalSpammerShadowScoreSummarySchema.nullable().default(null),
  localAdminDecision: z
    .object({
      decision: localAdminSpammerDecisionSchema,
      reason: z.string(),
      sourceChatId: z.string().nullable(),
      decidedByUserIds: z.array(z.string()).default([]),
      updatedAt: z.string().datetime(),
    })
    .nullable()
    .default(null),
  reputationSummary: z
    .object({
      naturalBanSignals: z.number().int().min(0).default(0),
      localBlockSignals: z.number().int().min(0).default(0),
      localAllowSignals: z.number().int().min(0).default(0),
      onlyReputationSignals: z.boolean().default(false),
      note: z.string().default('Репутационные сигналы учитываются как фон, а не как приговор.'),
    })
    .default({
      naturalBanSignals: 0,
      localBlockSignals: 0,
      localAllowSignals: 0,
      onlyReputationSignals: false,
      note: 'Репутационные сигналы учитываются как фон, а не как приговор.',
    }),
});
export type GlobalSpammerUserDiagnostics = z.infer<typeof globalSpammerUserDiagnosticsSchema>;

export const updateSettingsRequestSchema = chatSettingsSchema.superRefine((settings, context) => {
  addReportCommandIssues(settings, context);
  if (
    settings.nightModeEnabled &&
    (settings.nightModeBotMessageEnabled || settings.nightModeOpenMessageEnabled) &&
    settings.nightModeStartTimeMinutes === settings.nightModeEndTimeMinutes
  ) {
    context.addIssue({
      code: 'custom',
      path: ['nightModeEndTimeMinutes'],
      message: 'Для сообщений ночного режима время открытия должно отличаться от времени закрытия.',
    });
  }
});

export const patchSettingsSectionRequestSchema = z
  .object({
    section: applySettingsSectionSchema,
    expectedRevision: z.string().datetime(),
    changes: z.record(z.string(), z.unknown()),
  })
  .strict();
export type PatchSettingsSectionRequest = z.infer<typeof patchSettingsSectionRequestSchema>;

export const addAdminRequestSchema = z.object({
  userId: z.string(),
});

const MAX_BROADCAST_CALENDAR_SLOTS = 186;

function normalizeBroadcastLinkButtons(values: BroadcastLinkButton[]): BroadcastLinkButton[] {
  return values.map((value) => ({
    text: value.text.trim() || DEFAULT_BROADCAST_BUTTON_TEXT,
    url: value.url.trim(),
  }));
}

function resolveBroadcastLinkButtons(value: {
  buttons?: BroadcastLinkButton[];
  buttonEnabled?: boolean;
  buttonUrl?: string;
  buttonText?: string;
}): BroadcastLinkButton[] {
  if (Array.isArray(value.buttons) && value.buttons.length > 0) {
    return normalizeBroadcastLinkButtons(value.buttons);
  }

  if (!value.buttonEnabled) {
    return [];
  }

  return normalizeBroadcastLinkButtons([
    {
      text: value.buttonText ?? DEFAULT_BROADCAST_BUTTON_TEXT,
      url: value.buttonUrl ?? '',
    },
  ]);
}

function addBroadcastButtonIssues(
  value: {
    buttons?: BroadcastLinkButton[];
    buttonEnabled?: boolean;
    buttonUrl?: string;
    buttonText?: string;
  },
  ctx: z.RefinementCtx,
): void {
  if ((value.buttons?.length ?? 0) > 0 || !value.buttonEnabled) {
    return;
  }

  if (!isValidBotButtonUrl(value.buttonUrl ?? '')) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['buttonUrl'],
      message: 'Укажите корректную ссылку для кнопки (http/https).',
    });
  }

  if (!isValidBotButtonText(value.buttonText ?? '')) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['buttonText'],
      message: 'Введите название кнопки.',
    });
  }
}

function buildBroadcastButtonState(value: {
  buttons?: BroadcastLinkButton[];
  buttonEnabled?: boolean;
  buttonUrl?: string;
  buttonText?: string;
}): {
  buttons: BroadcastLinkButton[];
  buttonEnabled: boolean;
  buttonUrl: string;
  buttonText: string;
} {
  const buttons = resolveBroadcastLinkButtons(value);
  const primaryButton = buttons[0];

  return {
    buttons,
    buttonEnabled: buttons.length > 0,
    buttonUrl: primaryButton?.url ?? '',
    buttonText: primaryButton?.text ?? DEFAULT_BROADCAST_BUTTON_TEXT,
  };
}

export const sendBroadcastRequestSchema = z
  .object({
    requestId: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9_-]{8,128}$/u)
      .optional(),
    text: z
      .string()
      .max(2_000, 'Текст автопостинга слишком длинный. Максимум 2000 символов.')
      .default(''),
    textFormat: broadcastTextFormatSchema.default('plain'),
    targetMode: broadcastTargetModeSchema.optional(),
    targetChatIds: z.array(z.string().trim().min(1)).default([]),
    applyToAllChats: z.boolean().default(false),
    buttons: z.array(broadcastLinkButtonSchema).max(MAX_BROADCAST_LINK_BUTTONS).default([]),
    buttonEnabled: z.boolean().default(false),
    buttonUrl: botButtonUrlSchema,
    buttonText: botButtonTextSchema,
    imageEnabled: z.boolean().default(false),
    imageBase64: z.string().trim().max(MAX_BROADCAST_IMAGE_BASE64_LENGTH).default(''),
    imageMimeType: z.string().trim().max(128).default(''),
    imageFileName: z.string().trim().max(128).default(''),
    images: z.array(broadcastImageSchema).max(MAX_BROADCAST_IMAGES).default([]),
    mediaType: broadcastMediaTypeSchema.nullable().default(null),
    mediaPayload: z.record(z.string(), z.unknown()).nullable().default(null),
    mediaMimeType: z.string().trim().max(128).default(''),
    mediaFileName: z.string().trim().max(128).default(''),
    scheduleMode: broadcastScheduleModeSchema.optional(),
    scheduleTimezone: broadcastScheduleTimezoneSchema,
    scheduledSlots: z.array(broadcastDateTimeSchema).max(MAX_BROADCAST_CALENDAR_SLOTS).default([]),
    replaceConflictingSlots: z.boolean().default(false),
    sendAt: broadcastDateTimeSchema.nullable().default(null),
    cycleEnabled: z.boolean().default(false),
    cycleEveryHours: z.number().int().min(1).max(BROADCAST_CYCLE_MAX_WINDOW_HOURS).optional(),
    cycleEveryDays: z.number().int().min(1).max(31).optional(),
    cycleCount: z.number().int().min(1).max(100).default(1),
  })
  .superRefine((value, ctx) => {
    addBroadcastAudienceIssues(value, ctx);

    const images = normalizeBroadcastImages(value);
    const hasImages = images.length > 0;
    const hasVideoPayload =
      value.mediaType === 'video' && normalizeBroadcastVideoPayload(value.mediaPayload) !== null;
    const hasImagePayload =
      value.mediaType === 'image' &&
      value.mediaPayload !== null &&
      readBroadcastMediaPayloadImages(value.mediaPayload).length > 0;
    const hasMediaPayload =
      hasVideoPayload || hasImagePayload || (value.mediaType === 'image' && hasImages);

    if (value.text.trim().length === 0 && !hasImages && !hasVideoPayload) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['text'],
        message: 'Введите текст, добавьте фото или видео.',
      });
    }

    if (hasImages && hasVideoPayload) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['mediaType'],
        message: 'В одном автопостинге можно добавить либо фото, либо видео.',
      });
    }

    if ((value.mediaType && !hasMediaPayload) || (!value.mediaType && value.mediaPayload)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['mediaPayload'],
        message: 'Медиа автопостинга не загружено.',
      });
    }

    addBroadcastButtonIssues(value, ctx);

    if (value.imageEnabled && !hasImages) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['imageBase64'],
        message: 'Добавьте фото для автопостинга.',
      });
    }

    images.forEach((image, index) => {
      if (!image.base64.trim()) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['images', index, 'base64'],
          message: 'Добавьте фото.',
        });
      }

      if (!image.mimeType.trim() || !image.mimeType.toLowerCase().startsWith('image/')) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['images', index, 'mimeType'],
          message: 'Неверный формат фото.',
        });
      }
    });

    if (getBroadcastImagesTotalBase64Length(images) > MAX_BROADCAST_IMAGES_TOTAL_BASE64) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['images'],
        message: 'Суммарный размер фото слишком большой.',
      });
    }

    addBroadcastScheduleIssues(value, ctx);
  })
  .transform((value) => {
    const audienceState = buildBroadcastAudienceState(value);
    const buttonState = buildBroadcastButtonState(value);
    const scheduleState = buildBroadcastScheduleState(value);
    const images = normalizeBroadcastImages(value);
    const videoPayload =
      value.mediaType === 'video' ? normalizeBroadcastVideoPayload(value.mediaPayload) : null;
    const hasVideoPayload = videoPayload !== null;
    const hasImageGallery = !hasVideoPayload && images.length > 1;
    const firstImage = !hasVideoPayload ? images[0] : undefined;

    return {
      ...value,
      ...(value.requestId?.trim() ? { requestId: value.requestId.trim() } : {}),
      targetMode: audienceState.targetMode,
      targetChatIds: audienceState.targetChatIds,
      applyToAllChats: audienceState.applyToAllChats,
      buttons: buttonState.buttons,
      buttonEnabled: buttonState.buttonEnabled,
      buttonUrl: buttonState.buttonUrl,
      buttonText: buttonState.buttonText,
      imageEnabled: Boolean(firstImage),
      imageBase64: firstImage?.base64 ?? '',
      imageMimeType: firstImage?.mimeType ?? '',
      imageFileName: firstImage?.fileName ?? '',
      images: hasVideoPayload ? [] : images,
      mediaType: hasVideoPayload ? 'video' : hasImageGallery ? 'image' : null,
      mediaPayload: hasVideoPayload ? videoPayload : hasImageGallery ? { images } : null,
      mediaMimeType: hasVideoPayload ? value.mediaMimeType.trim() : '',
      mediaFileName: hasVideoPayload ? value.mediaFileName.trim() : '',
      scheduleMode: scheduleState.scheduledSlots.length > 0 ? 'calendar' : 'legacy',
      replaceConflictingSlots: scheduleState.replaceConflictingSlots,
      sendAt: scheduleState.sendAt,
      cycleEnabled: scheduleState.cycleEnabled,
      cycleEveryHours: scheduleState.cycleEveryHours,
      cycleCount: scheduleState.cycleCount,
      scheduledSlots: scheduleState.scheduledSlots,
    };
  });
export type SendBroadcastRequest = z.infer<typeof sendBroadcastRequestSchema>;

export const broadcastHandoffRequestSchema = z
  .object({
    targetMode: broadcastTargetModeSchema.optional(),
    targetChatIds: z.array(z.string().trim().min(1)).default([]),
    applyToAllChats: z.boolean().default(false),
    buttons: z.array(broadcastLinkButtonSchema).max(MAX_BROADCAST_LINK_BUTTONS).default([]),
    buttonEnabled: z.boolean().default(false),
    buttonUrl: botButtonUrlSchema,
    buttonText: botButtonTextSchema,
    scheduleMode: broadcastScheduleModeSchema.optional(),
    scheduleTimezone: broadcastScheduleTimezoneSchema,
    scheduledSlots: z.array(broadcastDateTimeSchema).max(MAX_BROADCAST_CALENDAR_SLOTS).default([]),
    replaceConflictingSlots: z.boolean().default(false),
    sendAt: broadcastDateTimeSchema.nullable().default(null),
    cycleEnabled: z.boolean().default(false),
    cycleEveryHours: z.number().int().min(1).max(BROADCAST_CYCLE_MAX_WINDOW_HOURS).optional(),
    cycleEveryDays: z.number().int().min(1).max(31).optional(),
    cycleCount: z.number().int().min(1).max(100).default(1),
  })
  .superRefine((value, ctx) => {
    addBroadcastAudienceIssues(value, ctx);
    addBroadcastButtonIssues(value, ctx);
    addBroadcastScheduleIssues(value, ctx);
  })
  .transform((value) => {
    const audienceState = buildBroadcastAudienceState(value);
    const buttonState = buildBroadcastButtonState(value);
    const scheduleState = buildBroadcastScheduleState(value);

    return {
      ...value,
      targetMode: audienceState.targetMode,
      targetChatIds: audienceState.targetChatIds,
      applyToAllChats: audienceState.applyToAllChats,
      buttons: buttonState.buttons,
      buttonEnabled: buttonState.buttonEnabled,
      buttonUrl: buttonState.buttonUrl,
      buttonText: buttonState.buttonText,
      scheduleMode: scheduleState.scheduledSlots.length > 0 ? 'calendar' : 'legacy',
      replaceConflictingSlots: scheduleState.replaceConflictingSlots,
      sendAt: scheduleState.sendAt,
      cycleEnabled: scheduleState.cycleEnabled,
      cycleEveryHours: scheduleState.cycleEveryHours,
      cycleCount: scheduleState.cycleCount,
      scheduledSlots: scheduleState.scheduledSlots,
    };
  });
export type BroadcastHandoffRequest = z.infer<typeof broadcastHandoffRequestSchema>;

export const broadcastHandoffResponseSchema = z.object({
  botUrl: z.string().url(),
});
export type BroadcastHandoffResponse = z.infer<typeof broadcastHandoffResponseSchema>;

export const profileMentionHandoffRequestSchema = z.object({
  displayName: z.string().trim().min(1).max(128),
});
export type ProfileMentionHandoffRequest = z.infer<typeof profileMentionHandoffRequestSchema>;

export const broadcastHandoffStateSchema = z
  .object({
    targetMode: broadcastTargetModeSchema.default('current'),
    targetChatIds: z.array(z.string().trim().min(1)).default([]),
    applyToAllChats: z.boolean().default(false),
    buttons: z.array(broadcastLinkButtonSchema).max(MAX_BROADCAST_LINK_BUTTONS).default([]),
    buttonEnabled: z.boolean().default(false),
    buttonUrl: botButtonUrlSchema,
    buttonText: botButtonTextSchema,
    scheduleMode: broadcastScheduleModeSchema.default('legacy'),
    scheduleTimezone: broadcastScheduleTimezoneSchema.default('Europe/Moscow'),
    scheduledSlots: z.array(broadcastDateTimeSchema).default([]),
    replaceConflictingSlots: z.boolean().default(false),
    sendAt: broadcastDateTimeSchema.nullable().default(null),
    cycleEnabled: z.boolean().default(false),
    cycleEveryHours: z.number().int().min(1).default(1),
    cycleCount: z.number().int().min(1).default(1),
    hasContent: z.boolean().default(false),
  })
  .transform((value) => ({
    ...value,
    scheduleMode: inferBroadcastScheduleMode(value),
  }));
export type BroadcastHandoffState = z.infer<typeof broadcastHandoffStateSchema>;

export const sendBroadcastResultSchema = z
  .object({
    sourceChatId: z.string(),
    targetChats: z.number().int().min(1),
    sentChats: z.number().int().min(0),
    failedChats: z.number().int().min(0),
    sentChatIds: z.array(z.string()),
    failedChatIds: z.array(z.string()),
    sentChatPreviews: z.array(managedBroadcastTargetPreviewSchema).default([]),
    failedChatPreviews: z.array(managedBroadcastTargetPreviewSchema).default([]),
    sentChatOverflowCount: z.number().int().min(0).default(0),
    failedChatOverflowCount: z.number().int().min(0).default(0),
    scheduleMode: broadcastScheduleModeSchema.default('legacy'),
    scheduleTimezone: broadcastScheduleTimezoneSchema.default('Europe/Moscow'),
    scheduledSlots: z.array(broadcastDateTimeSchema).default([]),
    sendAt: broadcastDateTimeSchema.nullable().default(null),
    nextSendAt: broadcastDateTimeSchema.nullable().default(null),
    cycleEnabled: z.boolean().default(false),
    cycleEveryHours: z.number().int().min(1).default(1),
    cycleEveryDays: z.number().int().min(1).optional(),
    cycleCount: z.number().int().min(1).default(1),
    scheduleId: z.string().nullable().default(null),
    scheduledOccurrences: z.number().int().min(0).default(0),
  })
  .transform((value) => ({
    ...value,
    scheduleMode: inferBroadcastScheduleMode(value),
  }));
export type SendBroadcastResult = z.infer<typeof sendBroadcastResultSchema>;

export const sendBroadcastTestResultSchema = z.object({
  delivered: z.boolean(),
  messageId: z.string().nullable(),
  chatId: z.string().nullable(),
  url: z.string().url().nullable(),
});
export type SendBroadcastTestResult = z.infer<typeof sendBroadcastTestResultSchema>;

export const managedBroadcastDetailsSchema = z
  .object({
    id: z.string(),
    autopostRuleId: z.string().nullable().default(null),
    status: managedBroadcastStatusSchema,
    text: z.string(),
    textFormat: broadcastTextFormatSchema,
    targetMode: broadcastTargetModeSchema.default('current'),
    applyToAllChats: z.boolean(),
    targetChatIds: z.array(z.string()),
    targetPreviews: z.array(managedBroadcastTargetPreviewSchema).default([]),
    targetOverflowCount: z.number().int().min(0).default(0),
    buttons: z.array(broadcastLinkButtonSchema).max(MAX_BROADCAST_LINK_BUTTONS).default([]),
    buttonEnabled: z.boolean(),
    buttonUrl: botButtonUrlSchema,
    buttonText: botButtonTextSchema,
    imageEnabled: z.boolean(),
    imageBase64: z.string(),
    imageMimeType: z.string(),
    imageFileName: z.string(),
    images: z.array(broadcastImageSchema).max(MAX_BROADCAST_IMAGES).default([]),
    mediaType: broadcastMediaTypeSchema.nullable().default(null),
    mediaPayload: z.record(z.string(), z.unknown()).nullable().default(null),
    mediaMimeType: z.string().default(''),
    mediaFileName: z.string().default(''),
    scheduleMode: broadcastScheduleModeSchema.default('legacy'),
    scheduleTimezone: broadcastScheduleTimezoneSchema,
    scheduledSlots: z.array(broadcastDateTimeSchema).default([]),
    nextSendAt: broadcastDateTimeSchema.nullable(),
    cycleEnabled: z.boolean(),
    cycleEveryHours: z.number().int().min(1),
    cycleCount: z.number().int().min(1),
    sentCount: z.number().int().min(0),
    currentOccurrence: z.number().int().min(1),
    deliveredChats: z.number().int().min(0),
    failedChats: z.number().int().min(0),
    pendingChats: z.number().int().min(0),
    blockedChats: z.number().int().min(0),
    failureBreakdown: managedBroadcastFailureBreakdownSchema,
    canRetry: z.boolean(),
    remainingCount: z.number().int().min(0),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    lastError: z.string().nullable(),
  })
  .transform((value) => ({
    ...value,
    scheduleMode: inferBroadcastScheduleMode(value),
  }));
export type ManagedBroadcastDetails = z.infer<typeof managedBroadcastDetailsSchema>;

export const managedBroadcastCalendarSlotSchema = z.object({
  broadcastId: z.string(),
  autopostRuleId: z.string().nullable().default(null),
  sourceChatId: z.string(),
  scheduledAt: broadcastDateTimeSchema,
  status: managedBroadcastStatusSchema,
  textPreview: z.string(),
  targetMode: broadcastTargetModeSchema.default('current'),
  targetChatIds: z.array(z.string()).default([]),
  targetChats: z.number().int().min(1),
  targetPreviews: z.array(managedBroadcastTargetPreviewSchema).default([]),
  targetOverflowCount: z.number().int().min(0).default(0),
  overlapChatIds: z.array(z.string()).default([]),
  overlapPreviews: z.array(managedBroadcastTargetPreviewSchema).default([]),
  overlapOverflowCount: z.number().int().min(0).default(0),
  hasTargetOverlap: z.boolean().default(false),
});
export type ManagedBroadcastCalendarSlot = z.infer<typeof managedBroadcastCalendarSlotSchema>;

export const managedBroadcastCalendarResponseSchema = z.object({
  sourceChatId: z.string(),
  entityType: managedEntityTypeSchema,
  from: broadcastDateTimeSchema,
  to: broadcastDateTimeSchema,
  targetChatIds: z.array(z.string()).default([]),
  slots: z.array(managedBroadcastCalendarSlotSchema).default([]),
});
export type ManagedBroadcastCalendarResponse = z.infer<
  typeof managedBroadcastCalendarResponseSchema
>;

export const managedAutopostRuleStatusSchema = z.enum([
  'ACTIVE',
  'PAUSED',
  'COMPLETED',
  'ERROR',
  'DISABLED',
]);
export type ManagedAutopostRuleStatus = z.infer<typeof managedAutopostRuleStatusSchema>;

export const managedAutopostRuleUpdateStatusSchema = z.enum(['ACTIVE', 'PAUSED']);
export type ManagedAutopostRuleUpdateStatus = z.infer<typeof managedAutopostRuleUpdateStatusSchema>;

export const managedAutopostPayloadSchema = sendBroadcastRequestSchema
  .superRefine((value, ctx) => {
    if (value.scheduleMode !== 'calendar') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['scheduleMode'],
        message: 'Выберите расписание.',
      });
    }
    if (value.scheduledSlots.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['scheduledSlots'],
        message: 'Добавьте время.',
      });
    }
    if (value.cycleEnabled || value.sendAt) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['cycleEnabled'],
        message: 'Для автопоста используйте расписание.',
      });
    }
  })
  .transform((value) => ({
    text: value.text,
    textFormat: value.textFormat,
    targetMode: value.targetMode,
    targetChatIds: value.targetChatIds,
    applyToAllChats: value.applyToAllChats,
    buttons: value.buttons,
    buttonEnabled: value.buttonEnabled,
    buttonUrl: value.buttonUrl,
    buttonText: value.buttonText,
    imageEnabled: value.imageEnabled,
    imageBase64: value.imageBase64,
    imageMimeType: value.imageMimeType,
    imageFileName: value.imageFileName,
    images: value.images,
    mediaType: value.mediaType,
    mediaPayload: value.mediaPayload,
    mediaMimeType: value.mediaMimeType,
    mediaFileName: value.mediaFileName,
    scheduleMode: 'calendar' as const,
    scheduleTimezone: value.scheduleTimezone,
    sendAt: null,
    cycleEnabled: false,
    cycleEveryHours: 1,
    cycleCount: 1,
    scheduledSlots: normalizeBroadcastScheduledSlots(value.scheduledSlots),
  }));
export type ManagedAutopostPayload = z.infer<typeof managedAutopostPayloadSchema>;

export const createManagedAutopostRuleRequestSchema = z.object({
  title: z.string().trim().max(120).default(''),
  payload: managedAutopostPayloadSchema,
});
export type CreateManagedAutopostRuleRequest = z.infer<
  typeof createManagedAutopostRuleRequestSchema
>;

export const updateManagedAutopostRuleRequestSchema = z
  .object({
    title: z.string().trim().max(120).optional(),
    status: managedAutopostRuleUpdateStatusSchema.optional(),
    payload: managedAutopostPayloadSchema.optional(),
  })
  .superRefine((value, ctx) => {
    if (value.title === undefined && value.status === undefined && value.payload === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Нет изменений.',
      });
    }
  });
export type UpdateManagedAutopostRuleRequest = z.infer<
  typeof updateManagedAutopostRuleRequestSchema
>;

export const managedAutopostRuleSummarySchema = z.object({
  id: z.string(),
  sourceChatId: z.string(),
  entityType: managedEntityTypeSchema,
  status: managedAutopostRuleStatusSchema,
  title: z.string(),
  textPreview: z.string(),
  textLength: z.number().int().min(0),
  targetMode: broadcastTargetModeSchema.default('current'),
  applyToAllChats: z.boolean(),
  targetChatIds: z.array(z.string()).default([]),
  targetChats: z.number().int().min(1),
  hasImage: z.boolean(),
  imageCount: z.number().int().min(0).default(0),
  hasVideo: z.boolean().default(false),
  buttons: z.array(broadcastLinkButtonSchema).max(MAX_BROADCAST_LINK_BUTTONS).default([]),
  scheduleTimezone: broadcastScheduleTimezoneSchema,
  scheduledSlots: z.array(broadcastDateTimeSchema).default([]),
  nextSendAt: broadcastDateTimeSchema.nullable(),
  materializedCount: z.number().int().min(0),
  revision: z.number().int().min(1),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  lastError: z.string().nullable(),
});
export type ManagedAutopostRuleSummary = z.infer<typeof managedAutopostRuleSummarySchema>;

export const managedAutopostRuleDetailsSchema = managedAutopostRuleSummarySchema.extend({
  payload: managedAutopostPayloadSchema,
});
export type ManagedAutopostRuleDetails = z.infer<typeof managedAutopostRuleDetailsSchema>;

export const managedAutopostHubEntityTypeSchema = z.enum(['all', 'chat', 'channel']).default('all');
export type ManagedAutopostHubEntityType = z.infer<typeof managedAutopostHubEntityTypeSchema>;

export const listManagedAutopostHubRulesQuerySchema = z.object({
  entityType: managedAutopostHubEntityTypeSchema.optional(),
  status: managedAutopostRuleStatusSchema.optional(),
  sourceChatId: z.string().trim().min(1).optional(),
});
export type ListManagedAutopostHubRulesQuery = z.infer<
  typeof listManagedAutopostHubRulesQuerySchema
>;

export const createManagedAutopostHubRuleRequestSchema = z.object({
  sourceChatId: z.string().trim().min(1),
  entityType: managedEntityTypeSchema,
  title: z.string().trim().max(120).default(''),
  payload: managedAutopostPayloadSchema,
});
export type CreateManagedAutopostHubRuleRequest = z.infer<
  typeof createManagedAutopostHubRuleRequestSchema
>;

export const managedAutopostHubRuleSummarySchema = managedAutopostRuleSummarySchema.extend({
  sourcePreview: managedBroadcastTargetPreviewSchema,
  targetPreviews: z.array(managedBroadcastTargetPreviewSchema).default([]),
  targetOverflowCount: z.number().int().min(0).default(0),
});
export type ManagedAutopostHubRuleSummary = z.infer<typeof managedAutopostHubRuleSummarySchema>;

export const managedAutopostHubRuleDetailsSchema = managedAutopostHubRuleSummarySchema.extend({
  payload: managedAutopostPayloadSchema,
});
export type ManagedAutopostHubRuleDetails = z.infer<typeof managedAutopostHubRuleDetailsSchema>;

export const chatSettingsScreenResponseSchema = z.object({
  closure: chatClosureStatusSchema.optional(),
  messageRetention: messageRetentionSummarySchema.optional(),
  settings: chatSettingsSchema,
  stopWordsStorageStatus: z.enum(['valid', 'legacy', 'invalid']).optional(),
  reportsAvailable: z.boolean().default(false),
  commercialPhotoModerationMode: z.enum(['OFF', 'OBSERVE', 'FULL', 'UNKNOWN']).default('UNKNOWN'),
  commercialAiModerationMode: z.enum(['OFF', 'OBSERVE', 'DELETE_ONLY']).optional(),
  duplicatePhotoModerationMode: dupe.duplicatePhotoModerationModeSchema.default('OBSERVE'),
  duplicateMessageModerationMode: z.enum(['OFF', 'OBSERVE', 'DELETE_ONLY', 'FULL']).default('OFF'),
  duplicatePhotoPolicyMatrix: dupe.duplicatePhotoPolicyMatrixSchema.optional(),
  rules: chatRulesSchema,
  header: managedEntityHeaderSchema,
  botSpeechPreviewProfile: botSpeechPreviewProfileSchema.nullable().default(null),
  requiredSubscriptionChannels: z.array(managedEntityHeaderSchema).default([]),
  domains: z.array(domainAllowlistEntrySchema),
  managedBroadcasts: z.array(managedBroadcastSummarySchema).default([]),
});
export type ChatSettingsScreenResponse = z.infer<typeof chatSettingsScreenResponseSchema>;

export const maxMessagePayloadSchema = z.object({
  messageId: z.string(),
  postId: z.string().optional(),
  chatId: z.string(),
  chatTitle: z.string().optional(),
  entityType: z.enum(['chat', 'channel']).optional(),
  senderId: z.string(),
  senderName: z.string().optional(),
  text: z.string().default(''),
  createdAt: z.string().datetime(),
});

export const maxMembershipChangeSchema = z.object({
  action: z.enum(['added', 'removed']),
  memberUserIds: z.array(z.string()).min(1),
  inviterId: z.string().optional(),
});

export const maxUpdateSchema = z.object({
  updateId: z.string(),
  botId: z.string().optional(),
  executionOwnerBotId: z.string().optional(),
  eventTimestampSource: z.enum(['payload', 'ingress']).optional(),
  type: z.string(),
  message: maxMessagePayloadSchema.optional(),
  membership: maxMembershipChangeSchema.optional(),
  raw: z.record(z.string(), z.any()).optional(),
});

export type MaxUpdate = z.infer<typeof maxUpdateSchema>;
