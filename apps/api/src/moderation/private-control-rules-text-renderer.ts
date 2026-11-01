import {
  buildDuplicateRulesTextItems,
  type ChatSettings,
  type ChatSettingsScreenResponse,
} from '@maxim/contracts';
import { formatPrivateControlTime } from './private-control-setting-format';
import { resolvePublishedProfanityRuleText } from './profanity/profanity-copy';

export function buildPrivateRulesTextItems(
  screen: Pick<
    ChatSettingsScreenResponse,
    'settings' | 'requiredSubscriptionChannels' | 'domains' | 'duplicatePhotoModerationMode'
  >,
): string[] {
  const { settings, requiredSubscriptionChannels, domains } = screen;
  const items: string[] = [];

  if (settings.linkPolicy === 'BLOCKLIST_ONLY') {
    items.push('Пожалуйста, не отправляйте ссылки: бот их удаляет.');
  } else if (settings.linkPolicy === 'ALLOWLIST_ONLY') {
    items.push(
      domains.length > 0
        ? 'Можно отправлять только ссылки из разрешённого списка.'
        : 'Ссылки здесь ограничены: если нужно, сначала согласуйте их с администраторами.',
    );
  } else if (settings.linkPolicy === 'ALERT_ONLY') {
    items.push('Ссылки бот проверяет, но не удаляет автоматически.');
  }

  if (isRequiredSubscriptionCurrentlyActive(settings)) {
    const channelTitles = requiredSubscriptionChannels
      .map((channel) => channel.title.trim())
      .filter(Boolean);
    items.push(
      channelTitles.length > 0
        ? `Чтобы писать в чат, сначала подпишитесь на: ${formatRulesPreviewList(channelTitles, 3)}.`
        : 'Чтобы писать в чат, сначала подпишитесь на обязательные чаты или каналы.',
    );
  }

  if (settings.russianProfanityFilterEnabled) {
    items.push(resolvePublishedProfanityRuleText(settings.profanitySensitivity));
  }

  if (settings.commercialAdsFilterEnabled) {
    items.push('Коммерческую рекламу публикуйте только по согласованию с администраторами.');
  }

  items.push(...buildDuplicateRulesTextItems(settings, screen.duplicatePhotoModerationMode));

  if (settings.antiSpamEnabled) {
    items.push('Пожалуйста, не флудите и не спамьте.');
  }

  if (settings.slowModeEnabled)
    items.push(`Интервал между сообщениями: ${settings.slowModeIntervalSeconds} сек.`);
  if (settings.mediaMessageCooldownEnabled)
    items.push(`Интервал между медиа: ${settings.mediaMessageCooldownSeconds} сек.`);
  if (settings.stickerMessagesEnabled === false) items.push('Стикеры сюда отправлять нельзя.');

  if (settings.messageCountLimitEnabled) {
    items.push(
      `Пожалуйста, не отправляйте больше ${settings.messageCountLimitMessages} сообщений за ${settings.messageCountLimitWindowHours} ${formatRulesHoursLabel(settings.messageCountLimitWindowHours)}.`,
    );
  }

  if (settings.maxMessageLengthEnabled) {
    items.push(
      `Старайтесь писать короче: до ${settings.maxMessageLength} символов в одном сообщении.`,
    );
  }

  if (settings.photoMessageCooldownEnabled) {
    items.push(
      `Фото можно отправлять не чаще одного раза в ${settings.photoMessageCooldownHours} ${formatRulesHoursLabel(settings.photoMessageCooldownHours)}.`,
    );
  }

  if (settings.stickerMessageCooldownEnabled && settings.stickerMessagesEnabled !== false) {
    items.push(
      `Стикеры можно отправлять не чаще одного раза в ${settings.stickerMessageCooldownMinutes} ${formatRulesMinutesLabel(settings.stickerMessageCooldownMinutes)}.`,
    );
  }

  if (!settings.photoMessagesEnabled) {
    items.push('Фото сюда отправлять нельзя.');
  }

  if (!settings.videoMessagesEnabled) {
    items.push('Видео сюда отправлять нельзя.');
  }

  if (!settings.fileMessagesEnabled) {
    items.push('Файлы сюда отправлять нельзя.');
  }

  if (!settings.voiceMessagesEnabled) {
    items.push('Голосовые сообщения сюда отправлять нельзя.');
  }

  if (!settings.forwardedMessagesEnabled) {
    items.push('Пересланные сообщения сюда отправлять нельзя.');
  }

  if (!settings.phoneNumbersEnabled) {
    items.push('Телефонные номера в сообщениях запрещены.');
  }

  if (settings.nightModeEnabled) {
    items.push(
      `Ночью чат работает тише: ограничения действуют с ${formatPrivateControlTime(settings.nightModeStartTimeMinutes)} до ${formatPrivateControlTime(settings.nightModeEndTimeMinutes)}.`,
    );
  }

  const sanctionsSummary = buildRulesSanctionsSummary(
    isRequiredSubscriptionCurrentlyActive(settings)
      ? settings
      : {
          ...settings,
          requiredSubscriptionWarnEnabled: false,
          requiredSubscriptionMuteEnabled: false,
          requiredSubscriptionBanEnabled: false,
        },
  );
  if (sanctionsSummary) {
    items.push(sanctionsSummary);
  }

  return items;
}

function isRequiredSubscriptionCurrentlyActive(
  settings: Pick<ChatSettings, 'requiredSubscriptionEnabled' | 'requiredSubscriptionChannelIds'>,
): boolean {
  if (!settings.requiredSubscriptionEnabled) {
    return false;
  }

  return settings.requiredSubscriptionChannelIds.length > 0;
}

function buildRulesSanctionsSummary(
  settings: Pick<
    ChatSettings,
    | 'linkWarnEnabled'
    | 'requiredSubscriptionWarnEnabled'
    | 'textFiltersWarnEnabled'
    | 'messageLimitsWarnEnabled'
    | 'antiDuplicateEnabled'
    | 'duplicateWarnEnabled'
    | 'linkMuteEnabled'
    | 'requiredSubscriptionMuteEnabled'
    | 'textFiltersMuteEnabled'
    | 'messageLimitsMuteEnabled'
    | 'duplicateMuteEnabled'
    | 'linkBanEnabled'
    | 'requiredSubscriptionBanEnabled'
    | 'textFiltersBanEnabled'
    | 'messageLimitsBanEnabled'
    | 'duplicateBanEnabled'
  >,
): string | null {
  const sanctions = new Set<string>();

  if (
    settings.linkWarnEnabled ||
    settings.requiredSubscriptionWarnEnabled ||
    settings.textFiltersWarnEnabled ||
    settings.messageLimitsWarnEnabled ||
    (settings.antiDuplicateEnabled && settings.duplicateWarnEnabled)
  ) {
    sanctions.add('предупредить');
  }

  if (
    settings.linkMuteEnabled ||
    settings.requiredSubscriptionMuteEnabled ||
    settings.textFiltersMuteEnabled ||
    settings.messageLimitsMuteEnabled ||
    (settings.antiDuplicateEnabled && settings.duplicateMuteEnabled)
  ) {
    sanctions.add('временно ограничить сообщения');
  }

  if (
    settings.linkBanEnabled ||
    settings.requiredSubscriptionBanEnabled ||
    settings.textFiltersBanEnabled ||
    settings.messageLimitsBanEnabled ||
    (settings.antiDuplicateEnabled && settings.duplicateBanEnabled)
  ) {
    sanctions.add('заблокировать');
  }

  if (sanctions.size === 0) {
    return null;
  }

  return `За повторные нарушения бот может ${formatRulesConjunctionList([...sanctions])}.`;
}

function formatRulesPreviewList(values: readonly string[], limit: number): string {
  const uniqueValues = Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
  const visible = uniqueValues.slice(0, limit);
  const remaining = uniqueValues.length - visible.length;
  if (remaining <= 0) {
    return visible.join(', ');
  }

  return `${visible.join(', ')} и ещё ${remaining}`;
}

function formatRulesConjunctionList(values: readonly string[]): string {
  if (values.length <= 1) {
    return values[0] ?? '';
  }

  if (values.length === 2) {
    return `${values[0]} и ${values[1]}`;
  }

  return `${values.slice(0, -1).join(', ')} и ${values[values.length - 1]}`;
}

function formatRulesHoursLabel(value: number): string {
  const normalized = Math.abs(Math.trunc(value));
  const mod10 = normalized % 10;
  const mod100 = normalized % 100;

  if (mod10 === 1 && mod100 !== 11) {
    return 'час';
  }

  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) {
    return 'часа';
  }

  return 'часов';
}

function formatRulesMinutesLabel(value: number): string {
  const normalized = Math.abs(Math.trunc(value));
  const mod10 = normalized % 10;
  const mod100 = normalized % 100;

  if (mod10 === 1 && mod100 !== 11) {
    return 'минуту';
  }

  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) {
    return 'минуты';
  }

  return 'минут';
}
