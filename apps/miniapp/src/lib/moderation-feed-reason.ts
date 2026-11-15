import { COMMERCIAL_CATEGORY_LABELS } from './commercial-ads-category-labels';
import type { LogsDashboardViolation } from '@maxim/contracts';
import { formatTimezoneLabel } from './timezone-label';

type ModerationReasonSource = Pick<LogsDashboardViolation, 'ruleCode' | 'metadata'>;

export const trafficModerationLabels: Record<string, string> = {
  SLOW_MODE: 'Медленный режим',
  MEDIA_RATE_LIMIT: 'Интервал для вложений',
  STICKER_BLOCKED: 'Стикеры запрещены',
};

const commercialSubtypeLabels: Record<string, string> = {
  CHANNEL_PLACEMENT: 'размещение в канале',
  PROPERTY_AGENT: 'риелторские услуги',
  PROPERTY_COMMERCIAL: 'коммерческая недвижимость',
  RECRUITMENT: 'найм или вакансия',
  INFO_PRODUCT: 'инфопродукт',
  BUYOUT: 'выкуп или скупка',
  SERVICES: 'услуги',
  GOODS_RETAIL: 'розничные товары',
  GOODS: 'товары',
  GROUP_PROMOTION: 'продвижение группы',
  GENERIC: 'рекламное предложение',
};

const profanityCategoryLabels: Record<string, string> = {
  CORE_MAT: 'Нецензурная лексика.',
  SEVERE_ABUSE: 'Грубое оскорбление.',
  MILD_INSULT: 'Оскорбление по строгому режиму.',
};

const standaloneDeleteRuleCodes = new Set([
  'BOT_MESSAGE_AUTO_DELETE',
  'MANUAL_GROUP_CLOSE_DELETE',
  'MUTE_ACTIVE_DELETE',
  'NIGHT_MODE_DELETE',
]);

export function resolveModerationFeedReason(violation: ModerationReasonSource): string {
  const metadata = readRecord(violation.metadata);
  const imageTextRuleCode = readString(metadata?.matchedRuleCode);
  if (
    violation.ruleCode.trim().toUpperCase() === 'COMMERCIAL_OCR_DELETE' &&
    metadata?.source === 'image_text_ocr' &&
    (imageTextRuleCode === 'MESSAGE_BLOCKED_WORD' || imageTextRuleCode === 'MESSAGE_BLOCKED_DOMAIN')
  ) {
    const imageTextReason = resolveStructuredReason(imageTextRuleCode, metadata);
    if (imageTextReason) {
      return imageTextReason;
    }
  }

  if (
    violation.ruleCode.trim().toUpperCase() === 'COMMERCIAL_OCR_DELETE' &&
    metadata?.source === 'image_text_ocr' &&
    imageTextRuleCode &&
    imageTextRuleCode !== 'COMMERCIAL_AD'
  )
    return 'Правило для текста на изображении.';

  const sourceRule = violation.ruleCode.trim().toUpperCase();
  if (sourceRule === 'COMMERCIAL_LLM_DELETE' || sourceRule === 'COMMERCIAL_OCR_DELETE') {
    const aiDecision = readRecord(metadata?.commercialAdsDecision);
    const saved = readStringArray(
      metadata?.commercialAdsCategories ??
        aiDecision?.categories ??
        metadata?.commercialCategories ??
        metadata?.categories,
    );
    const categories = Object.keys(COMMERCIAL_CATEGORY_LABELS).filter((key) =>
      saved.includes(key),
    ) as Array<keyof typeof COMMERCIAL_CATEGORY_LABELS>;
    if (categories.length)
      return `Запрещённая реклама: ${categories.map((category) => COMMERCIAL_CATEGORY_LABELS[category].toLowerCase()).join(', ')}.`;
    return sourceRule === 'COMMERCIAL_OCR_DELETE'
      ? 'Реклама на изображении.'
      : 'Реклама запрещена правилами чата.';
  }

  const ruleCode = normalizeModerationRuleCode(violation.ruleCode);

  const structuredReason = resolveStructuredReason(ruleCode, metadata);
  if (structuredReason) {
    return structuredReason;
  }

  const rawReason = readString(metadata?.reason);
  const normalizedRawReason = normalizeRawModerationReason(rawReason);
  if (normalizedRawReason) {
    return normalizedRawReason;
  }

  return resolveFallbackReason(ruleCode);
}

function resolveStructuredReason(
  ruleCode: string,
  metadata: Record<string, unknown> | null,
): string | null {
  if (ruleCode === 'PROFANITY') {
    const category = readString(metadata?.category);
    return category ? (profanityCategoryLabels[category] ?? null) : null;
  }

  if (ruleCode === 'COMMERCIAL_AD') {
    return resolveCommercialReason(metadata);
  }

  if (ruleCode === 'TOPIC_FILTER_MISMATCH' || ruleCode === 'THEMATIC_FILTER') {
    const requiredCodeword = readString(metadata?.requiredCodeword);
    return requiredCodeword
      ? `Сообщение должно начинаться с кодового слова "${requiredCodeword}".`
      : 'Сообщение не прошло тематический фильтр.';
  }

  if (ruleCode === 'MESSAGE_BLOCKED_WORD') {
    const blockedWord = readString(metadata?.blockedWord);
    return blockedWord ? `Стоп-слово: ${blockedWord}.` : 'Сообщение содержит слово из стоп-листа.';
  }

  if (ruleCode === 'MESSAGE_BLOCKED_DOMAIN') {
    const blockedDomain =
      readString(metadata?.blockedDomain) ?? readString(metadata?.matchedDomain);
    return blockedDomain
      ? `Запрещённый домен: ${blockedDomain}.`
      : 'Сообщение содержит домен из стоп-листа.';
  }

  if (ruleCode === 'REQUIRED_SUBSCRIPTION') {
    const missingChannels = readStringArray(metadata?.missingChannelTitles);
    return missingChannels.length > 0
      ? `Нет подписки на обязательные чаты или каналы: ${formatShortList(missingChannels)}.`
      : 'Для сообщений нужна подписка на обязательные чаты или каналы.';
  }

  if (ruleCode === 'INVITATION_ACCESS') {
    const invitedCount = readFiniteNumber(metadata?.invitedCount);
    const requiredCount = readFiniteNumber(metadata?.requiredCount);
    if (invitedCount !== null && requiredCount !== null) {
      return `Недостаточно приглашений: ${Math.max(0, invitedCount)}/${Math.max(
        0,
        requiredCount,
      )}.`;
    }
    return 'Для доступа нужно пригласить участников по правилу чата.';
  }

  if (ruleCode.startsWith('DUPLICATE_')) {
    const fingerprintType = readString(metadata?.fingerprintType);
    const duplicateLabel =
      fingerprintType === 'image'
        ? 'Повтор фото'
        : fingerprintType === 'image_set'
          ? 'Повтор альбома'
          : 'Повтор сообщения';
    const count = readFiniteNumber(metadata?.count);
    const threshold = readFiniteNumber(metadata?.threshold);
    const windowSec = readFiniteNumber(metadata?.windowSec);
    const windowLabel = windowSec !== null ? ` за ${formatDurationSeconds(windowSec)}` : '';
    if (count !== null && threshold !== null) {
      return `${duplicateLabel}: ${Math.max(0, count)}/${Math.max(0, threshold)}${windowLabel}.`;
    }
    return `${duplicateLabel}${windowLabel}.`;
  }

  if (ruleCode === 'MESSAGE_RATE_LIMIT') {
    const maxMessages = readFiniteNumber(metadata?.maxMessages);
    const windowSec = readFiniteNumber(metadata?.windowSec);
    if (maxMessages !== null && windowSec !== null) {
      return `Слишком частая отправка: не более ${Math.max(
        0,
        maxMessages,
      )} сообщений за ${formatDurationSeconds(windowSec)}.`;
    }
  }

  if (ruleCode === 'MUTE_ACTIVE_DELETE') {
    return 'На момент отправки участнику было запрещено писать.';
  }

  if (ruleCode === 'NIGHT_MODE_DELETE') {
    const startTime = readString(metadata?.nightModeStartTime);
    const endTime = readString(metadata?.nightModeEndTime);
    const timezone = readString(metadata?.nightModeTimezone);
    if (startTime && endTime) {
      return `Чат закрыт на ночь: ${startTime}–${endTime}${
        timezone ? ` (${formatTimezoneLabel(timezone)})` : ''
      }.`;
    }
    return 'Чат закрыт на ночь.';
  }

  if (ruleCode === 'MANUAL_GROUP_CLOSE_DELETE') {
    return 'Группа закрыта вручную, новые сообщения временно удаляются.';
  }

  if (ruleCode === 'BOT_MESSAGE_AUTO_DELETE') {
    const delayMinutes = readFiniteNumber(metadata?.delayMinutes);
    return delayMinutes !== null && delayMinutes > 0
      ? `Сообщение бота удалено по настройкам автоочистки через ${formatDelayMinutes(
          delayMinutes,
        )}.`
      : 'Сообщение бота удалено по настройкам автоочистки.';
  }

  return null;
}

function resolveCommercialReason(metadata: Record<string, unknown> | null): string {
  const subtype =
    readString(metadata?.primarySubtype) ??
    readString(metadata?.subtype) ??
    readString(metadata?.decisionBand);
  const subtypeLabel = subtype ? commercialSubtypeLabels[subtype] : null;
  const featureVector = readRecord(metadata?.featureVector);
  const evidence: string[] = [];

  if (
    isPositiveFeature(featureVector?.contactEvidence) &&
    isPositiveFeature(featureVector?.priceStructure)
  ) {
    evidence.push('есть контакт и цена');
  } else if (isPositiveFeature(featureVector?.contactEvidence)) {
    evidence.push('есть контакт для сделки');
  } else if (isPositiveFeature(featureVector?.priceStructure)) {
    evidence.push('есть цена или условия сделки');
  }

  if (isPositiveFeature(featureVector?.massDistribution)) {
    evidence.push('признаки массового размещения');
  }

  if (isPositiveFeature(featureVector?.highRisk)) {
    evidence.push('высокорисковый рекламный сигнал');
  }

  const details = [subtypeLabel, ...evidence].filter((value): value is string => Boolean(value));
  return details.length > 0
    ? `Коммерческая реклама запрещена: ${details.join(', ')}.`
    : 'Коммерческая реклама запрещена в этом чате.';
}

function normalizeRawModerationReason(reason: string | null): string | null {
  if (!reason) {
    return null;
  }

  if (/[А-Яа-яЁё]/u.test(reason)) {
    return ensureSentence(reason);
  }

  const linkAllowlistMatch = reason.match(/^Link\s+(.+)\s+is not in allowlist$/u);
  if (linkAllowlistMatch?.[1]) {
    return `Ссылка ${linkAllowlistMatch[1]} не входит в разрешённый список.`;
  }

  const messageLengthMatch = reason.match(/^Message length\s+(\d+)\s+exceeds limit\s+(\d+)$/u);
  if (messageLengthMatch?.[1] && messageLengthMatch[2]) {
    return `Сообщение длиннее лимита: ${messageLengthMatch[1]} из ${messageLengthMatch[2]} символов.`;
  }

  const messageCountMatch = reason.match(/^Messages are limited to\s+(\d+)\s+per\s+(\d+)h$/u);
  if (messageCountMatch?.[1] && messageCountMatch[2]) {
    return `Слишком частая отправка: не более ${messageCountMatch[1]} сообщений за ${messageCountMatch[2]}ч.`;
  }

  const burstMatch = reason.match(/^Messages are limited to\s+(\d+)\s+per\s+(\d+)s$/u);
  if (burstMatch?.[1] && burstMatch[2]) {
    return `Слишком частая отправка: не более ${burstMatch[1]} сообщений за ${burstMatch[2]}с.`;
  }

  const photoCooldownMatch = reason.match(
    /^Messages with photos are limited to one per\s+(\d+)h$/u,
  );
  if (photoCooldownMatch?.[1]) {
    return `Слишком частая отправка фото: не чаще одного раза в ${photoCooldownMatch[1]}ч.`;
  }

  const stickerCooldownMatch = reason.match(/^Stickers are limited to one per\s+(\d+)m$/u);
  if (stickerCooldownMatch?.[1]) {
    return `Слишком частая отправка стикеров: не чаще одного раза в ${stickerCooldownMatch[1]} мин.`;
  }

  const blockedWordMatch = reason.match(/^Blocked word detected:\s+(.+)$/u);
  if (blockedWordMatch?.[1]) {
    return `Стоп-слово: ${blockedWordMatch[1]}.`;
  }

  const blockedDomainMatch = reason.match(/^Blocked domain detected:\s+(.+)$/u);
  if (blockedDomainMatch?.[1]) {
    return `Запрещённый домен: ${blockedDomainMatch[1]}.`;
  }

  const labels: Record<string, string> = {
    'Detected profanity or abusive language pattern': 'Грубая лексика запрещена правилами чата.',
    'Detected Russian commercial ad pattern': 'Коммерческая реклама запрещена в этом чате.',
    'Message without required thematic markers': 'Сообщение не прошло тематический фильтр.',
    'Links are not allowed by policy': 'Ссылки запрещены настройками чата.',
    'Phone numbers are disabled by chat settings': 'Телефонные номера запрещены в этом чате.',
    'Photo messages are disabled by chat settings': 'Фото в этом чате отключены.',
    'Video messages are disabled by chat settings': 'Видео в этом чате отключены.',
    'File messages are disabled by chat settings': 'Файлы в этом чате отключены.',
    'Voice messages are disabled by chat settings': 'Голосовые сообщения в этом чате отключены.',
    'Forwarded messages are disabled by chat settings':
      'Пересланные сообщения в этом чате запрещены.',
    'Duplicate message removed': 'Повтор сообщения удалён.',
    'Message removed during active mute window':
      'На момент отправки участнику было запрещено писать.',
    'Message removed while chat is closed for the night': 'Чат закрыт на ночь.',
    'Message removed while group is manually closed':
      'Группа закрыта вручную, новые сообщения временно удаляются.',
    'Bot account removed because bot accounts are disallowed by chat settings':
      'Бот-аккаунты запрещены настройками чата.',
    'Bot account removed from service event because bot accounts are disallowed by chat settings':
      'Бот-аккаунты запрещены настройками чата.',
    'Bot-authored message scheduled for delayed auto-delete':
      'Сообщение бота запланировано на автоудаление.',
  };

  return labels[reason] ?? null;
}

function resolveFallbackReason(ruleCode: string): string {
  const labels: Record<string, string> = {
    ...trafficModerationLabels,
    PARTICIPANT_REPORT: 'Достигнут порог жалоб участников на сообщение.',
    PARTICIPANT_REPORT_DELETE: 'Удаление по жалобам участников.',
    PARTICIPANT_REPORT_COMMAND_CLEANUP: 'Удаление принятой команды жалобы.',
    PARTICIPANT_REPORT_COUNTER_CLEANUP: 'Удаление завершённого счётчика жалоб.',
    LINK_BLOCKED: 'Ссылка запрещена настройками чата.',
    PROFANITY: 'Грубая лексика запрещена правилами чата.',
    COMMERCIAL_AD: 'Коммерческая реклама запрещена в этом чате.',
    MESSAGE_TOO_LONG: 'Сообщение длиннее разрешённого лимита.',
    MESSAGE_RATE_LIMIT: 'Слишком частая отправка сообщений или стикеров.',
    MESSAGE_COUNT_LIMIT: 'Превышен лимит сообщений за выбранный период.',
    PHOTO_BLOCKED: 'Фото в этом чате отключены.',
    VIDEO_BLOCKED: 'Видео в этом чате отключены.',
    FILE_BLOCKED: 'Файлы в этом чате отключены.',
    VOICE_BLOCKED: 'Голосовые сообщения в этом чате отключены.',
    FORWARDED_MESSAGE_BLOCKED: 'Пересланные сообщения в этом чате запрещены.',
    PHOTO_RATE_LIMIT: 'Слишком частая отправка фото.',
    STICKER_RATE_LIMIT: 'Слишком частая отправка стикеров.',
    PHONE_NUMBER_BLOCKED: 'Телефонные номера запрещены в этом чате.',
    TOPIC_FILTER_MISMATCH: 'Сообщение не прошло тематический фильтр.',
    THEMATIC_FILTER: 'Сообщение не прошло тематический фильтр.',
    GLOBAL_CROSS_CHAT_SPAM: 'Обнаружена массовая рассылка по чатам.',
    GLOBAL_SPAMMER_BAN: 'Участник есть в подтверждённой базе спама.',
    GLOBAL_SPAMMER_KICK: 'Участник есть в подтверждённой базе спама.',
    GLOBAL_USER_BLACKLIST_KICK: 'Участник есть в базе запретов.',
    BOT_ACCOUNT_KICK: 'Бот-аккаунты запрещены настройками чата.',
    BOT_MESSAGE_AUTO_DELETE: 'Сообщение бота удаляется по настройкам автоочистки.',
    MANUAL_MUTE: 'Модератор запретил участнику отправлять сообщения.',
    MANUAL_BAN: 'Модератор заблокировал участника.',
    MANUAL_UNMUTE: 'Модератор снял запрет на сообщения.',
    MANUAL_UNBAN: 'Модератор разблокировал участника.',
  };

  return labels[ruleCode] ?? 'Причина не сохранена.';
}

function normalizeModerationRuleCode(ruleCode: string): string {
  const normalized = ruleCode.trim().toUpperCase();
  if (normalized.startsWith('DUPLICATE_') || standaloneDeleteRuleCodes.has(normalized)) {
    return normalized;
  }
  if (normalized.endsWith('_DELETE')) {
    return normalized.replace(/_DELETE$/u, '');
  }
  return normalized;
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    : [];
}

function readFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function isPositiveFeature(value: unknown): boolean {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function formatShortList(values: readonly string[]): string {
  const uniqueValues = Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
  const visible = uniqueValues.slice(0, 3);
  const remaining = uniqueValues.length - visible.length;
  return remaining > 0 ? `${visible.join(', ')} и еще ${remaining}` : visible.join(', ');
}

function formatDurationSeconds(seconds: number): string {
  const normalized = Math.max(1, Math.trunc(seconds));
  if (normalized % 3600 === 0) {
    return `${normalized / 3600}ч`;
  }
  if (normalized % 60 === 0) {
    return `${normalized / 60}мин`;
  }
  return `${normalized}с`;
}

function formatDelayMinutes(minutes: number): string {
  const seconds = Math.max(1, Math.round(minutes * 60));
  if (seconds < 60) {
    return `${seconds} сек`;
  }
  if (seconds % 60 === 0) {
    return `${seconds / 60} мин`;
  }
  return `${Math.floor(seconds / 60)} мин ${seconds % 60} сек`;
}

function ensureSentence(value: string): string {
  const normalized = value.trim();
  return /[.!?]$/u.test(normalized) ? normalized : `${normalized}.`;
}
