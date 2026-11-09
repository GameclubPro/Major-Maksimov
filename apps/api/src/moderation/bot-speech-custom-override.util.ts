import {
  hasCustomBotSpeechText,
  type BotSpeechPersona,
  type BotSpeechStyle,
} from '@maxim/contracts/bot-speech';
import type { ChatSettings } from '@maxim/contracts/settings';
import {
  buildMessageLimitsBlockedReason,
  isMessageLimitsBlockedListRuleCode,
} from './message-limits-blocked-reason.util';
import {
  ANTI_SPAM_BURST_LIMIT,
  ANTI_SPAM_BURST_WINDOW_SEC,
} from './rule-engine-message-limits.detector';

const LEGACY_MESSAGE_STATUS = { deleted: 'снято с линии', kept: 'не по форме' } as const;
const LEGACY_DUPLICATE_CONTEXT = {
  deleted: 'снято с линии как дубль',
  kept: 'идёт повтором',
} as const;

export function hasCustomBotSpeechTemplate(value: string | null | undefined): boolean {
  return hasCustomBotSpeechText(value);
}

export function resolveBotSpeechPlaceholder(
  templateText: string | null | undefined,
  legacyCustomValue: string,
  inheritedValue: string,
): string {
  return hasCustomBotSpeechTemplate(templateText) ? legacyCustomValue : inheritedValue;
}

export function resolveBotSpeechMessageStatus(
  templateText: string | null | undefined,
  messageDeleted: boolean,
): string {
  return resolveBotSpeechPlaceholder(
    templateText,
    messageDeleted ? LEGACY_MESSAGE_STATUS.deleted : LEGACY_MESSAGE_STATUS.kept,
    messageDeleted ? 'удалено' : 'не удалено',
  );
}

export function resolveBotSpeechDuplicateContext(
  templateText: string | null | undefined,
  messageDeleted: boolean,
): string {
  return resolveBotSpeechPlaceholder(
    templateText,
    messageDeleted ? LEGACY_DUPLICATE_CONTEXT.deleted : LEGACY_DUPLICATE_CONTEXT.kept,
    messageDeleted ? 'удалено как повтор' : 'отмечено как повтор',
  );
}

export function resolveTextFilterExplanationReason(
  ruleCode: string,
  templateText: string | null | undefined,
): string {
  if (ruleCode === 'PROFANITY') return 'грубая лексика запрещена правилами чата';
  return resolveBotSpeechPlaceholder(
    templateText,
    'коммерческая реклама в этом чате запрещена',
    'коммерческая реклама запрещена правилами чата',
  );
}

export function buildLegacyDuplicateSanctionLabel(params: {
  style: BotSpeechStyle | null;
  persona: BotSpeechPersona;
  action: string;
  muteDurationLabel: string;
}): string {
  const { style, persona, action, muteDurationLabel } = params;
  if (style === 'POLICE' || style === null) {
    if (action === 'WARN') {
      return selectPersonaText(persona, {
        male: 'Взял на карандаш 📝.',
        female: 'Взяла на карандаш 📝.',
        neutral: 'Предупреждение за повтор зафиксировано 📝.',
      });
    }
    if (action === 'MUTE') return `Включаю тихий режим на ${muteDurationLabel} 🔒.`;
    return 'Тут уже шлагбаум ⛔ До ручного разбана.';
  }
  if (style === 'ROBOT') {
    if (action === 'WARN') return '⚠️ Предупреждение записано.';
    if (action === 'MUTE') return `🔒 Включен мут на ${muteDurationLabel}.`;
    return '⛔ Включен бан до ручного снятия.';
  }
  if (style === 'FRIENDLY') {
    if (action === 'WARN') return '⚠️ Это уже предупреждение.';
    if (action === 'MUTE') {
      return selectPersonaText(persona, {
        male: `🔒 Включил мут на ${muteDurationLabel}.`,
        female: `🔒 Включила мут на ${muteDurationLabel}.`,
        neutral: `🔒 Мут включён на ${muteDurationLabel}.`,
      });
    }
    return '⛔ Пришлось выдать бан до ручного разбана.';
  }
  if (action === 'WARN') return '⚠️ Это уже предупреждение. Повтор не сделал мысль сильнее.';
  if (action === 'MUTE') return `🔒 Мут на ${muteDurationLabel}. Со второго дубля лучше не стало.`;
  return '⛔ Дальше уже только ручной разбан.';
}

export function buildLegacyDuplicatePassiveSanctionLabel(params: {
  style: BotSpeechStyle | null;
  persona: BotSpeechPersona;
  messageDeleted: boolean;
}): string {
  return params.messageDeleted ? 'Повтор удалён.' : 'Повтор обнаружен.';
}

function selectPersonaText(
  persona: BotSpeechPersona,
  variants: Record<BotSpeechPersona, string>,
): string {
  return variants[persona];
}

export type MessageCountLimitSpeechContext = Pick<
  ChatSettings,
  'messageCountLimitMessages' | 'messageCountLimitWindowHours'
>;

type MessageLimitsContextParams = MessageCountLimitSpeechContext & {
  templateText?: string | null;
  ruleCode: string;
  messageDeleted: boolean;
  photoCooldownHours: number;
  stickerCooldownMinutes: number;
  messageLength?: number;
  maxMessageLength?: number;
  blockedWord?: string | null;
};

export function buildMessageLimitsExplanationReplacements(
  params: MessageLimitsContextParams,
): Record<string, string> {
  const context = buildMessageLimitsReasonContext(params);
  return {
    message_status: resolveBotSpeechMessageStatus(params.templateText, params.messageDeleted),
    reason: resolveBotSpeechPlaceholder(
      params.templateText,
      context.legacyReason,
      context.inheritedReason,
    ),
    ...context.replacements,
  };
}

function buildMessageLimitsReasonContext(params: MessageLimitsContextParams): {
  legacyReason: string;
  inheritedReason: string;
  replacements?: Record<string, string>;
} {
  if (isMessageLimitsBlockedListRuleCode(params.ruleCode)) {
    return {
      legacyReason: 'такие сообщения запрещены в чате',
      inheritedReason: buildMessageLimitsBlockedReason(params.ruleCode, params.blockedWord),
    };
  }
  if (params.ruleCode === 'PHONE_NUMBER_BLOCKED') {
    return {
      legacyReason: 'телефонные номера в этом чате запрещены',
      inheritedReason: 'номера телефонов в сообщениях запрещены',
    };
  }
  if (params.ruleCode === 'MESSAGE_TOO_LONG') {
    const actual = normalizePositiveNumber(params.messageLength);
    const maximum = normalizePositiveNumber(params.maxMessageLength);
    return {
      legacyReason:
        actual !== null && maximum !== null
          ? `слишком длинное сообщение: ${actual} символов при лимите ${maximum}`
          : 'слишком длинное сообщение',
      inheritedReason:
        actual !== null && maximum !== null
          ? `длина сообщения ${formatMessageCharacterCount(actual)} при лимите ${maximum}`
          : 'сообщение превышает допустимую длину',
      replacements: {
        actual_length: actual !== null ? String(actual) : '',
        max_length: maximum !== null ? String(maximum) : '',
      },
    };
  }
  if (params.ruleCode === 'MESSAGE_RATE_LIMIT') {
    return {
      legacyReason: `слишком частая отправка сообщений или стикеров: не более ${ANTI_SPAM_BURST_LIMIT} за ${ANTI_SPAM_BURST_WINDOW_SEC}с`,
      inheritedReason: `за ${ANTI_SPAM_BURST_WINDOW_SEC} секунд отправлено больше ${ANTI_SPAM_BURST_LIMIT} сообщений или стикеров`,
      replacements: {
        message_limit_count: String(ANTI_SPAM_BURST_LIMIT),
        message_limit_window_seconds: String(ANTI_SPAM_BURST_WINDOW_SEC),
      },
    };
  }
  if (params.ruleCode === 'MESSAGE_COUNT_LIMIT') {
    return buildMessageCountLimitReasonContext(params);
  }
  const blockedMediaReason = resolveBlockedMediaReason(params.ruleCode);
  if (blockedMediaReason) return blockedMediaReason;
  if (params.ruleCode === 'STICKER_RATE_LIMIT') {
    const minutes = normalizeIntegerInRange(params.stickerCooldownMinutes, 1, 60, 5);
    return {
      legacyReason: `слишком частая отправка стикеров: не чаще одного раза в ${minutes} мин`,
      inheritedReason: `между стикерами должно пройти не менее ${minutes} мин`,
    };
  }
  const hours = normalizeIntegerInRange(params.photoCooldownHours, 1, 24, 1);
  return {
    legacyReason: `слишком частая отправка фото: не чаще одного раза в ${hours}ч. Если фото несколько, лучше собрать их в альбом или коллаж`,
    inheritedReason: `между отправками фото должно пройти не менее ${hours} ч`,
    replacements: { photo_cooldown_hours: String(hours) },
  };
}

function buildMessageCountLimitReasonContext(params: MessageCountLimitSpeechContext) {
  const count = normalizeIntegerInRange(params.messageCountLimitMessages, 1, 10, 5);
  const hours = normalizeIntegerInRange(params.messageCountLimitWindowHours, 1, 24, 1);
  return {
    legacyReason: `слишком частая отправка сообщений: не более ${count} за ${hours}ч`,
    inheritedReason: `превышен лимит сообщений: ${count} за ${hours} ч`,
    replacements: {
      message_limit_count: String(count),
      message_limit_window_hours: String(hours),
    },
  };
}

function resolveBlockedMediaReason(ruleCode: string): {
  legacyReason: string;
  inheritedReason: string;
} | null {
  const reasons: Record<string, [string, string]> = {
    PHOTO_BLOCKED: ['фото в этом чате отключены', 'отправка фото в этом чате отключена'],
    VIDEO_BLOCKED: ['видео в этом чате отключены', 'отправка видео в этом чате отключена'],
    FILE_BLOCKED: ['файлы в этом чате отключены', 'отправка файлов в этом чате отключена'],
    VOICE_BLOCKED: [
      'голосовые сообщения в этом чате отключены',
      'отправка голосовых сообщений в этом чате отключена',
    ],
    FORWARDED_MESSAGE_BLOCKED: [
      'пересланные сообщения в этом чате запрещены',
      'отправка пересланных сообщений в этом чате запрещена',
    ],
  };
  const reason = reasons[ruleCode];
  return reason ? { legacyReason: reason[0], inheritedReason: reason[1] } : null;
}

export function resolveMessageLimitsSanctionReason(
  ruleCode: string,
  blockedWord?: string | null,
  templateText?: string | null,
  quota?: MessageCountLimitSpeechContext,
): string {
  if (ruleCode === 'MESSAGE_COUNT_LIMIT' && quota) {
    const context = buildMessageCountLimitReasonContext(quota);
    return resolveBotSpeechPlaceholder(templateText, context.legacyReason, context.inheritedReason);
  }
  const legacyReasons: Record<string, string> = {
    PHOTO_RATE_LIMIT: 'слишком частая отправка фото',
    PHOTO_BLOCKED: 'фото в этом чате отключены',
    STICKER_RATE_LIMIT: 'слишком частая отправка стикеров',
    MESSAGE_RATE_LIMIT: 'слишком частая отправка сообщений или стикеров',
    MESSAGE_COUNT_LIMIT: 'слишком частая отправка сообщений',
    MESSAGE_TOO_LONG: 'слишком длинное сообщение',
    PHONE_NUMBER_BLOCKED: 'телефонные номера запрещены',
    VIDEO_BLOCKED: 'видео в этом чате отключены',
    FILE_BLOCKED: 'файлы в этом чате отключены',
    VOICE_BLOCKED: 'голосовые сообщения в этом чате отключены',
    FORWARDED_MESSAGE_BLOCKED: 'пересланные сообщения в этом чате запрещены',
  };
  const inheritedReasons: Record<string, string> = {
    PHOTO_RATE_LIMIT: 'фото отправляются чаще, чем разрешено в чате',
    PHOTO_BLOCKED: 'отправка фото в этом чате отключена',
    STICKER_RATE_LIMIT: 'стикеры отправляются чаще, чем разрешено в чате',
    MESSAGE_RATE_LIMIT: 'за короткое время отправлено слишком много сообщений или стикеров',
    MESSAGE_COUNT_LIMIT: 'лимит сообщений за выбранный период превышен',
    MESSAGE_TOO_LONG: 'сообщение превышает допустимую длину',
    PHONE_NUMBER_BLOCKED: 'номера телефонов в сообщениях запрещены',
    VIDEO_BLOCKED: 'отправка видео в этом чате отключена',
    FILE_BLOCKED: 'отправка файлов в этом чате отключена',
    VOICE_BLOCKED: 'отправка голосовых сообщений в этом чате отключена',
    FORWARDED_MESSAGE_BLOCKED: 'отправка пересланных сообщений в этом чате запрещена',
  };
  const legacyReason = isMessageLimitsBlockedListRuleCode(ruleCode)
    ? 'такие сообщения запрещены в чате'
    : (legacyReasons[ruleCode] ?? 'нарушение ограничений сообщений');
  const inheritedReason = isMessageLimitsBlockedListRuleCode(ruleCode)
    ? buildMessageLimitsBlockedReason(ruleCode, blockedWord)
    : (inheritedReasons[ruleCode] ?? 'нарушено ограничение на отправку сообщений');
  return resolveBotSpeechPlaceholder(templateText, legacyReason, inheritedReason);
}

function formatMessageCharacterCount(count: number): string {
  const lastTwo = count % 100;
  const last = count % 10;
  const unit =
    lastTwo >= 11 && lastTwo <= 14
      ? 'символов'
      : last === 1
        ? 'символ'
        : last >= 2 && last <= 4
          ? 'символа'
          : 'символов';
  return `${count} ${unit}`;
}

function normalizePositiveNumber(value: number | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.round(value)
    : null;
}

function normalizeIntegerInRange(
  value: number,
  minimum: number,
  maximum: number,
  fallback: number,
): number {
  return Number.isInteger(value) && value >= minimum && value <= maximum ? value : fallback;
}
