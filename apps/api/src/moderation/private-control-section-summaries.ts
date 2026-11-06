import { formatDeleteBotMessagesDelayLabel, type ChatSettings } from '@maxim/contracts';
import {
  formatPrivateControlEnumValue,
  formatPrivateControlTime,
} from './private-control-setting-format';
import {
  resolvePrivateDuplicateAllowedCount,
  resolvePrivateDuplicateSharedWindowSec,
} from './private-control-duplicate-flow';
import type { PrivateSectionKey, PrivateSectionView } from './private-control.types';

export function buildPrivateSectionSummaryLines(
  section: PrivateSectionKey,
  settings: ChatSettings,
  view: PrivateSectionView,
  format: {
    boolean: (value: boolean) => string;
    linkPolicy: (value: ChatSettings['linkPolicy']) => string;
  },
): string[] {
  switch (section) {
    case 'links':
      return [
        `Политика: ${format.linkPolicy(settings.linkPolicy)}`,
        `Санкции: WARN ${format.boolean(settings.linkWarnEnabled)} • MUTE ${format.boolean(settings.linkMuteEnabled)} (${settings.linkMuteDurationHours}ч) • BAN ${format.boolean(settings.linkBanEnabled)}`,
        `Сообщение бота: ${format.boolean(settings.linkBotMessageEnabled)} • кнопка ${format.boolean(settings.linkBotButtonEnabled)}`,
        ...(view === 'advanced'
          ? ['Allowlist и тексты предупреждений доступны в расширенном режиме ниже.']
          : []),
      ];
    case 'greeting':
      return [
        `Приветствие: ${format.boolean(settings.greetingEnabled)}`,
        `Сообщение: ${format.boolean(settings.greetingBotMessageEnabled)} • автоудаление ${format.boolean(settings.greetingDeleteBotMessageEnabled)}${settings.greetingDeleteBotMessageEnabled ? ` (${formatDeleteBotMessagesDelayLabel(settings.greetingDeleteBotMessageDelayMinutes)})` : ''} • кнопка ${format.boolean(settings.greetingBotButtonEnabled)} • правила ${format.boolean(settings.greetingRulesButtonEnabled)}`,
      ];
    case 'profanityFilter':
      return [
        `Фильтр: ${format.boolean(settings.russianProfanityFilterEnabled)} • чувствительность ${formatPrivateControlEnumValue(settings.profanitySensitivity)}`,
        `Санкции: WARN ${format.boolean(settings.profanityWarnEnabled)} • MUTE ${format.boolean(settings.profanityMuteEnabled)} (${settings.profanityMuteDurationHours}ч) • BAN ${format.boolean(settings.profanityBanEnabled)}`,
        `Сообщение бота: ${format.boolean(settings.profanityBotMessageEnabled)}`,
      ];
    case 'commercialFilter':
      return [
        `Фильтр: ${format.boolean(settings.commercialAdsFilterEnabled)} • строгость ${formatPrivateControlEnumValue(settings.commercialAdsSensitivity)}`,
        `Пороги: WARN ${settings.commercialAdsWarnThreshold} • DELETE ${settings.commercialAdsDeleteThreshold}`,
        `Санкции: WARN ${format.boolean(settings.textFiltersWarnEnabled)} • MUTE ${format.boolean(settings.textFiltersMuteEnabled)} (${settings.textFiltersMuteDurationHours}ч) • BAN ${format.boolean(settings.textFiltersBanEnabled)}`,
        `Сообщение: ${format.boolean(settings.textFiltersBotMessageEnabled)} • кнопка ${format.boolean(settings.textFiltersBotButtonEnabled)}`,
      ];
    case 'duplicates': {
      const duplicateWindowSec = resolvePrivateDuplicateSharedWindowSec(settings);
      const duplicateAllowedCount = resolvePrivateDuplicateAllowedCount(settings);
      const period =
        settings.duplicateWindowMode === 'DAILY'
          ? `ежедневно ${formatPrivateControlTime(settings.duplicateStartTimeMinutes)}–${formatPrivateControlTime(settings.duplicateEndTimeMinutes)} (${settings.duplicateTimezone})`
          : `окно ${duplicateWindowSec}с`;
      return [
        `Антидубли: ${format.boolean(settings.antiDuplicateEnabled)} • ${duplicateAllowedCount === 0 ? 'с первого дубля' : `после ${duplicateAllowedCount} дубл.`} • ${period}`,
        `Чьи картинки сравнивать: ${formatPrivateControlEnumValue(settings.duplicatePhotoScope)}`,
        `Этапы: объяснение ${format.boolean(settings.duplicateBotMessageEnabled)} • WARN ${format.boolean(settings.duplicateWarnEnabled)} • MUTE ${format.boolean(settings.duplicateMuteEnabled)} (${settings.duplicateMuteDurationHours}ч) • BAN ${format.boolean(settings.duplicateBanEnabled)}`,
        `Кнопка: ${format.boolean(settings.duplicateBotButtonEnabled)}`,
      ];
    }
    case 'limits':
      return [
        `Медленный режим: ${settings.slowModeEnabled ? `${settings.slowModeIntervalSeconds} сек` : 'выкл'} • медиа ${settings.mediaMessageCooldownEnabled ? `${settings.mediaMessageCooldownSeconds} сек` : 'без интервала'} • стикеры ${format.boolean(settings.stickerMessagesEnabled)}`,
        `Антиспам: ${format.boolean(settings.antiSpamEnabled)} • макс. длина ${settings.maxMessageLengthEnabled ? settings.maxMessageLength : 'выкл'}`,
        `Лимит сообщений: ${settings.messageCountLimitEnabled ? `${settings.messageCountLimitMessages} за ${settings.messageCountLimitWindowHours}ч` : 'выкл'}`,
        `Контент: фото ${format.boolean(settings.photoMessagesEnabled)} • видео ${format.boolean(settings.videoMessagesEnabled)} • файлы ${format.boolean(settings.fileMessagesEnabled)} • голосовые ${format.boolean(settings.voiceMessagesEnabled)} • пересылки ${format.boolean(settings.forwardedMessagesEnabled)} • телефоны ${format.boolean(settings.phoneNumbersEnabled)}`,
        `Санкции: WARN ${format.boolean(settings.messageLimitsWarnEnabled)} • MUTE ${format.boolean(settings.messageLimitsMuteEnabled)} (${settings.messageLimitsMuteDurationHours}ч) • BAN ${format.boolean(settings.messageLimitsBanEnabled)}`,
        `Сообщение: ${format.boolean(settings.messageLimitsBotMessageEnabled)} • кнопка ${format.boolean(settings.messageLimitsBotButtonEnabled)}`,
      ];
    case 'night':
      return [
        `Ночной режим: ${format.boolean(settings.nightModeEnabled)}`,
        `Окно: ${formatPrivateControlTime(settings.nightModeStartTimeMinutes)}-${formatPrivateControlTime(settings.nightModeEndTimeMinutes)} • ${settings.nightModeTimezone || 'не задан'}`,
        `Сообщение: ${format.boolean(settings.nightModeBotMessageEnabled)} • кнопка ${format.boolean(settings.nightModeBotButtonEnabled)}`,
        `Ручное закрытие: ${format.boolean(settings.nightModeForceCloseEnabled)}${settings.nightModeForceCloseEnabled ? ` • ${settings.nightModeForceCloseForever ? 'бессрочно' : `${settings.nightModeForceCloseDays}д ${settings.nightModeForceCloseHours}ч`}` : ''}`,
      ];
    case 'storefront':
      return [
        `Кнопка Караван: ${format.boolean(settings.karavanStorefrontEnabled)}`,
        `Только администраторы и разрешённые: ${format.boolean(settings.karavanStorefrontAdminsOnly)}`,
      ];
    case 'extra':
      return [
        `Удаление спамеров: ${format.boolean(settings.deleteSpammersEnabled)}`,
        `Сообщения бота: ${format.boolean(settings.deleteBotMessagesEnabled)} • задержка ${formatDeleteBotMessagesDelayLabel(settings.deleteBotMessagesDelayMinutes)}`,
        `Удаление ботов: ${format.boolean(settings.removeBotsFromGroupEnabled)}`,
      ];
  }
}
