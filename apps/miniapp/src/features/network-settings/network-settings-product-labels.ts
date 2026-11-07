import type {
  NetworkSettingsChange,
  NetworkSettingsField,
} from '@maxim/contracts/network-settings';
import { formatTimezoneLabel } from '../../lib/timezone-label';
const LABELS: Record<string, string> = {
  botSpeechStyle: 'Стиль речи',
  rulesAttachViolationsEnabled: 'Кнопка правил в сообщениях о нарушениях',
  'rules.text': 'Правила · Текст',
  'rules.textFormat': 'Правила · Формат текста',
  'rules.autoTextEnabled': 'Правила · Составлять текст из настроек',
  'rules.imageBase64': 'Правила · Изображение',
  'rules.imageMimeType': 'Правила · Формат изображения',
  'rules.imageFileName': 'Правила · Название изображения',
  'rules.buttons': 'Правила · Кнопки',
  'rules.buttonEnabled': 'Правила · Добавить кнопки',
  'rules.adminContactButtonEnabled': 'Правила · Связь с админом',
  'rules.adminContactButtonUrl': 'Правила · Адрес администратора',
  'messageRetention.enabled': 'Удалять старые сообщения',
  'messageRetention.hours': 'Удалять сообщения старше',
  'advertising.enabled': 'Рекламная площадка',
  postSuggestionsEnabled: 'Принимать предложения',
  postSuggestionsRequireSubscription: 'Предложения · Требовать подписку',
  postSuggestionsDeleteOnUnsubscribe: 'Предложения · Удалять посты после отписки',
  postSuggestionsEntryMode: 'Предложения · Способ отправки',
  postSuggestionsButtonText: 'Предложения · Текст кнопки',
  postSuggestionsText: 'Предложения · Что нужно прислать',
  engagementMessageText: 'Предложения · Текст перед кнопками',
  postSuggestionsDailyLimit: 'Предложения · Лимит в сутки',
  reportsEnabled: 'Жалобы участников',
  reportsThreshold: 'Порог жалоб',
  reportsDeleteMode: 'Удаление сообщения',
  reportsMuteEnabled: 'Ограничить автора сообщения',
  reportsMuteDurationHours: 'Срок ограничения, ч',
  linkPolicy: 'Режим проверки ссылок',
  linkRulesPolicy: 'Правила ссылок',
  greetingEnabled: 'Приветствовать новых участников',
  greetingRulesButtonEnabled: 'Добавить кнопку правил',
  greetingDeleteBotMessageEnabled: 'Удалять приветствие бота',
  greetingDeleteBotMessageDelayMinutes: 'Приветствие · Задержка удаления, мин',
  russianProfanityFilterEnabled: 'Фильтр мата',
  profanitySensitivity: 'Чувствительность',
  commercialAdsFilterEnabled: 'Фильтр рекламы',
  commercialAdsPolicy: 'Правила рекламы',
  commercialAdsSensitivity: 'Чувствительность распознавания',
  commercialAdsWarnThreshold: 'Порог предупреждения',
  commercialAdsDeleteThreshold: 'Порог удаления',
  antiDuplicateEnabled: 'Проверять повторы сообщений',
  duplicateDetectionPreset: 'Режим поиска повторов',
  duplicateCompareMode: 'Что сравнивать',
  duplicateIgnoreLinksEnabled: 'Не учитывать ссылки',
  duplicateIgnorePhonesEnabled: 'Не учитывать телефоны',
  duplicateNearMatchEnabled: 'Учитывать похожие тексты',
  duplicateWindowMode: 'Время работы защиты от повторов',
  duplicateStartTimeMinutes: 'Начало защиты от повторов',
  duplicateEndTimeMinutes: 'Конец защиты от повторов',
  duplicateTimezone: 'Часовой пояс повторов',
  duplicateWarnWindowSec: 'Период предупреждений, сек',
  duplicateMuteWindowSec: 'Период ограничений, сек',
  duplicateBanWindowSec: 'Период блокировок, сек',
  duplicateWarnMaxCount: 'Повторов до предупреждения',
  duplicateMuteMaxCount: 'Повторов до ограничения',
  duplicateBanMaxCount: 'Повторов до блокировки',
  duplicatePhotoEnabled: 'Проверять повторы фото',
  duplicatePhotoMatchPreset: 'Сходство фото',
  duplicatePhotoScope: 'Где искать повторы',
  slowModeEnabled: 'Медленный режим',
  slowModeIntervalSeconds: 'Интервал сообщений, сек',
  mediaMessageCooldownEnabled: 'Интервал медиасообщений',
  mediaMessageCooldownSeconds: 'Интервал медиа, сек',
  antiSpamEnabled: 'Защита от спама',
  deleteSpammersEnabled: 'Удалять спамеров',
  messageCountLimitEnabled: 'Ограничить число сообщений',
  messageCountLimitMessages: 'Сообщений за период',
  messageCountLimitWindowHours: 'Период, ч',
  maxMessageLengthEnabled: 'Ограничить длину сообщения',
  maxMessageLength: 'Максимум символов',
  photoMessageCooldownEnabled: 'Ограничить отправку фото по времени',
  photoMessageCooldownHours: 'Интервал фото, ч',
  stickerMessageCooldownEnabled: 'Ограничить отправку стикеров по времени',
  stickerMessageCooldownMinutes: 'Интервал стикеров, мин',
  stickerMessagesEnabled: 'Разрешить стикеры',
  photoMessagesEnabled: 'Разрешить фото',
  videoMessagesEnabled: 'Разрешить видео',
  fileMessagesEnabled: 'Разрешить файлы',
  voiceMessagesEnabled: 'Разрешить голосовые',
  forwardedMessagesEnabled: 'Разрешить пересланные сообщения',
  phoneNumbersEnabled: 'Разрешить номера телефонов',
  'stopWordsPolicy.enabled': 'Включить стоп-слова',
  'stopWordsPolicy.imageScanEnabled': 'Проверять текст на изображениях',
  'stopWordsPolicy.sanctions.botMessageEnabled': 'Сообщение от бота',
  'stopWordsPolicy.sanctions.warnEnabled': 'Предупреждение',
  'stopWordsPolicy.sanctions.muteEnabled': 'Ограничение',
  'stopWordsPolicy.sanctions.muteDurationHours': 'Срок ограничения, ч',
  'stopWordsPolicy.sanctions.banEnabled': 'Блокировка',
  'stopWordsPolicy.sanctions.rulesButtonEnabled': 'Добавить кнопку правил',
  'stopWordsPolicy.sanctions.adminContactButtonEnabled': 'Добавить связь с админом',
  'stopWordsPolicy.sanctions.adminContactButtonUrl': 'Ссылка для связи с админом',
  nightModeEnabled: 'Закрывать чат по расписанию',
  nightModeStartTimeMinutes: 'Закрыть чат в',
  nightModeEndTimeMinutes: 'Открыть чат в',
  nightModeTimezone: 'Часовой пояс ночного режима',
  nightModeBotMessageEnabled: 'Сообщение о закрытии',
  nightModeCommentsEnabled: 'Комментарии к сообщению о закрытии',
  nightModeOpenMessageEnabled: 'Сообщение об открытии',
  nightModeOpenMessageDeleteOnFirstMessageEnabled:
    'Удалять сообщение об открытии после первого сообщения',
  nightModeOpenMessageText: 'Ночной режим · Текст сообщения об открытии',
  nightModeRulesButtonEnabled: 'Добавить кнопку правил',
  nightModeForceCloseEnabled: 'Закрыть чат сейчас',
  nightModeForceCloseForever: 'Без срока',
  nightModeForceCloseDays: 'Дней',
  nightModeForceCloseHours: 'Часов',
  requiredSubscriptionButtonText: 'Текст кнопки подписки',
  invitationAccessEnabled: 'Включить доступ за приглашения',
  invitationAccessRequiredCount: 'Сколько участников пригласить',
  adminBanCommandName: 'Заблокировать',
  adminBanAllCommandName: 'Заблокировать во всех чатах',
  adminMuteCommandName: 'Ограничить',
  adminPermanentMuteCommandName: 'Ограничить навсегда',
  adminRulesCommandName: 'Правила',
  adminSilenceCommandName: 'Закрыть чат',
  adminOpenChatCommandName: 'Открыть чат',
  karavanStorefrontEnabled: 'Включить витрину',
  karavanStorefrontAdminsOnly: 'Только для администраторов',
  karavanStorefrontMessageText: 'Сообщение витрины',
  karavanStorefrontOpenButtonText: 'Кнопка открытия',
  karavanStorefrontCatalogButtonText: 'Кнопка каталога',
  karavanStorefrontCreateButtonText: 'Кнопка создания витрины',
  deleteBotMessagesEnabled: 'Удалять сообщения бота',
  deleteBotMessagesDelayMinutes: 'Сообщения бота · Задержка удаления, мин',
  removeBotsFromGroupEnabled: 'Удалять других ботов',
  quickButtonsEnabled: 'Быстрые кнопки',
  commentsEnabled: 'Комментарии',
  commentsModerationEnabled: 'Модерация комментариев',
  commentsBlockLinksEnabled: 'Блокировать ссылки в комментариях',
  commentsAntiSpamEnabled: 'Защита комментариев от спама',
  commentsLimitTwoInRowEnabled: 'Ограничение двух комментариев подряд',
  commentsMessageText: 'Сообщение о комментариях',
  enabled: 'Действие под публикацией',
  presentation: 'Вид действия под публикацией',
  text: 'Текст действия под публикацией',
  url: 'Ссылка действия под публикацией',
  requiredSubscriptionChannelIds: 'Каналы обязательной подписки',
  reportsAliases: 'Слова для жалоб',
  duplicateAllowedMessages: 'Допустимое количество повторов',
};
const PREFIX: Record<string, string> = {
  link: 'Ссылки',
  profanity: 'Мат и оскорбления',
  textFilters: 'Реклама',
  duplicate: 'Повторы',
  messageLimits: 'Ограничения',
  phoneNumbers: 'Номера телефонов',
  requiredSubscription: 'Обязательная подписка',
  invitationAccess: 'Приглашения',
  nightMode: 'Ночной режим',
  greeting: 'Приветствие',
};
const SUFFIX: Record<string, string> = {
  BotMessageEnabled: 'Сообщение бота',
  BotMessageText: 'Текст сообщения бота',
  WarnEnabled: 'Предупреждение',
  WarnMessageText: 'Текст предупреждения',
  MuteEnabled: 'Ограничение участника',
  MuteDurationHours: 'Срок ограничения, ч',
  BanEnabled: 'Блокировка',
  BotButtons: 'Кнопки сообщения',
  BotButtonEnabled: 'Кнопки сообщения включены',
  AdminContactButtonEnabled: 'Кнопка связи с администратором',
  AdminContactButtonUrl: 'Ссылка для связи с администратором',
  EscalationWindowHours: 'Период учёта нарушений, ч',
  WarnMaxCount: 'Нарушений до предупреждения',
  MuteMaxCount: 'Нарушений до ограничения',
  BanMaxCount: 'Нарушений до блокировки',
  WarnWindowSec: 'Период предупреждений, сек',
  MuteWindowSec: 'Период ограничений, сек',
  BanWindowSec: 'Период блокировок, сек',
  RulesButtonEnabled: 'Кнопка правил',
};
const STOP: Record<string, string> = {
  enabled: 'Стоп-лист включён',
  rules: 'Правила стоп-листа',
  domains: 'Домены стоп-листа',
  imageScanEnabled: 'Проверка текста на изображениях',
  botMessageEnabled: 'Сообщение бота',
  botMessageText: 'Текст сообщения бота',
  warnEnabled: 'Предупреждение',
  warnMessageText: 'Текст предупреждения',
  muteEnabled: 'Ограничение участника',
  muteDurationHours: 'Срок ограничения, ч',
  banEnabled: 'Блокировка',
  botButtonEnabled: 'Кнопки сообщения включены',
  botButtons: 'Кнопки сообщения',
  adminContactButtonEnabled: 'Кнопка связи с администратором',
  adminContactButtonUrl: 'Ссылка для связи с администратором',
  rulesButtonEnabled: 'Кнопка правил',
  explanation: 'Изображение пояснения',
  warning: 'Изображение предупреждения',
};
export function networkSettingsFieldLabel(path: string): string {
  if (path.startsWith('botSpeechMedia.'))
    return 'Изображение · ' + networkSettingsFieldLabel(path.slice('botSpeechMedia.'.length));
  if (path.startsWith('stopWordsPolicy.'))
    return 'Стоп-лист · ' + (STOP[path.split('.').at(-1)!] ?? 'Параметр санкций');
  if (LABELS[path]) return LABELS[path];
  for (const [prefix, title] of Object.entries(PREFIX))
    if (path.startsWith(prefix) && SUFFIX[path.slice(prefix.length)])
      return title + ' · ' + SUFFIX[path.slice(prefix.length)];
  return 'Параметр настроек';
}
const ENUM_VALUES: Record<string, Record<string, string>> = {
  botSpeechStyle: {
    ROBOT: 'Робот',
    FRIENDLY: 'Дружелюбный',
    POLICE: 'Полицейский',
    IRONIC: 'Ироничный',
  },
  postSuggestionsEntryMode: { MINIAPP: 'В приложении', BOT: 'В боте' },
  'rules.textFormat': { markdown: 'Markdown', html: 'HTML' },
  reportsDeleteMode: {
    MESSAGE: 'Только сообщение',
    HISTORY_24H: 'Сообщения автора за последние 24 часа',
  },
  linkPolicy: {
    ALLOWLIST_ONLY: 'Только разрешённые ссылки',
    BLOCKLIST_ONLY: 'Удалять все',
    ALERT_ONLY: 'Разрешать все',
  },
  profanitySensitivity: { CORE_ONLY: 'Мягкая', BALANCED: 'Обычная', STRICT: 'Строгая' },
  commercialAdsSensitivity: { BALANCED: 'Обычная', STRICT: 'Строгая' },
  duplicateDetectionPreset: { STANDARD: 'Стандартный', STRICT: 'Строгий', CUSTOM: 'Свой' },
  duplicateWindowMode: { INTERVAL: 'За выбранный период', DAILY: 'Каждый день по расписанию' },
  duplicateCompareMode: { MESSAGE: 'Сообщение целиком', TEXT: 'Только текст' },
  duplicatePhotoMatchPreset: {
    SAME_IMAGE: 'То же изображение',
    MINOR_EDITS: 'С небольшими изменениями',
  },
  duplicatePhotoScope: { SAME_AUTHOR: 'У того же автора', CHAT: 'Во всём чате' },
  presentation: { signature: 'Ссылка в тексте', button: 'Кнопка' },
};
export function networkSettingsValueLabel(value: unknown, path?: string): string {
  if (path === 'rules.imageBase64') return value ? 'Изображение' : 'Без изображения';
  if (typeof value === 'boolean') return value ? 'Включено' : 'Выключено';
  if (value === null || value === undefined || value === '') return 'Не задано';
  if (typeof value === 'string') {
    if (path === 'duplicateTimezone' || path === 'nightModeTimezone')
      return formatTimezoneLabel(value);
    return (path ? ENUM_VALUES[path]?.[value] : undefined) ?? value;
  }
  if (typeof value === 'number') {
    if (path === 'messageRetention.hours') {
      if (value === 24) return '24 часа';
      if (value === 48) return '48 часов';
      if (value === 168) return '1 неделя';
    }
    if (path?.endsWith('TimeMinutes'))
      return `${String(Math.floor(value / 60)).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`;
    return String(value);
  }
  if (Array.isArray(value))
    return value.length
      ? value.map((item) => networkSettingsValueLabel(item, path)).join('; ')
      : 'Пустой список';
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if (path === 'linkRulesPolicy') {
      const modes: Record<string, string> = {
        ALLOW_ALL: 'Разрешать все',
        DENY_SELECTED: 'Запрещать по списку',
        ALLOW_SELECTED: 'Разрешать по списку',
        DENY_ALL: 'Удалять все',
      };
      const rules = Array.isArray(record.rules) ? record.rules : [];
      return `${modes[String(record.mode)] ?? 'Правила ссылок'} · правил: ${rules.length}`;
    }
    if (path === 'commercialAdsPolicy') return 'Правила и исключения рекламы';
    if ('base64' in record)
      return 'Изображение' + (record.fileName ? ' · ' + String(record.fileName) : '');
    if ('text' in record && 'url' in record)
      return String(record.text) + ' · ' + String(record.url);
    if (path === 'stopWordsPolicy.rules')
      return [
        record.kind === 'PHRASE' ? 'Фраза' : 'Слово',
        String(record.value),
        record.enabled === false ? 'Выключено' : 'Включено',
        record.matchMode === 'MASKED' ? 'С учётом маскировки' : 'Точное совпадение',
      ].join(' · ');
    if ('value' in record) return networkSettingsValueLabel(record.value, path);
    return Object.values(record)
      .map((item) => networkSettingsValueLabel(item))
      .join(' · ');
  }
  return String(value);
}
export function networkSettingsChangeLabels(
  change: NetworkSettingsChange,
  field?: NetworkSettingsField,
) {
  return {
    title: networkSettingsFieldLabel(change.path),
    before:
      field?.kind === 'common'
        ? networkSettingsValueLabel(field.value, change.path)
        : field?.kind === 'mixed'
          ? 'Разные значения'
          : 'Значение недоступно',
    after:
      change.op === 'clear'
        ? 'Изображение будет удалено'
        : networkSettingsValueLabel(change.value, change.path),
    replacement: change.op === 'replace',
  };
}
