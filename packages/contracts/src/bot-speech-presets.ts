import {
  resolveBotSpeechStyle,
  type BotSpeechStyle,
  type BotSpeechPersona,
  type BotSpeechEditableFieldKey,
  type BotSpeechSystemTemplateKey,
} from './bot-speech-core.js';

type BotSpeechPreset = {
  editable: Record<BotSpeechEditableFieldKey, string>;
  system: Record<BotSpeechSystemTemplateKey, string>;
};

// FLAG: Duplicate templates also wrap bans; keep jokes in non-ban sanction fragments.
export const BOT_SPEECH_PRESETS: Record<BotSpeechStyle, BotSpeechPreset> = {
  ROBOT: {
    editable: {
      greetingBotMessageText:
        'Здравствуйте, {user}. Я {bot_character_name}. Перед общением ознакомьтесь с правилами чата.',
      linkBotMessageText: '{user}, сообщение {message_status}. Причина: {reason}.',
      linkWarnMessageText: '{user}, предупреждение: {reason}.',
      requiredSubscriptionBotMessageText: '{user}, чтобы писать в чат, подпишитесь на {channels}.',
      requiredSubscriptionWarnMessageText:
        '{user}, предупреждение: {reason}. Подпишитесь на {channels}.',
      invitationAccessBotMessageText:
        '{user}, сообщение {message_status}. Чтобы писать в чат, осталось пригласить {remaining_invites}. Засчитано {invited_count} из {required_invites_count}.',
      invitationAccessWarnMessageText:
        '{user}, предупреждение: {reason}. Засчитано приглашений: {invited_count} из {required_invites_count}.',
      textFiltersBotMessageText: '{user}, сообщение {message_status}. Причина: {reason}.',
      textFiltersWarnMessageText: '{user}, предупреждение: {reason}.',
      profanityBotMessageText: '{user}, сообщение {message_status}. Причина: {reason}.',
      profanityWarnMessageText: '{user}, предупреждение: {reason}.',
      duplicateBotMessageText: '{user}, обнаружен повтор сообщения. {sanction}',
      messageLimitsBotMessageText: '{user}, сообщение {message_status}. Причина: {reason}.',
      messageLimitsWarnMessageText: '{user}, предупреждение: {reason}.',
      phoneNumbersBotMessageText:
        '{user}, сообщение {message_status}. Причина: {reason}. Отправьте текст без номера телефона.',
      nightModeBotMessageText:
        '🌙 Перерыв в общении: {night_window} ({night_timezone}). {night_status}',
      nightModeOpenMessageText: '{opening_status}',
    },
    system: {
      linkEdited: '{user}, сообщение после редактирования {message_status}. Причина: {reason}.',
      linkEditedWarn: '{user}, предупреждение: {reason}.',
      linkMute: '{user}, действует мут за запрещённую ссылку.',
      requiredSubscriptionMute:
        '{user}, за сообщения без подписки действует мут на {mute_duration}. До его окончания новые сообщения будут удаляться. Подпишитесь на {channels}, чтобы участвовать после окончания мута.',
      requiredSubscriptionBan:
        '{user}, доступ к чату закрыт: требуется подписка на {channels}. Снять бан может администратор.',
      invitationAccessMute:
        '{user}, действует мут: условие по приглашениям не выполнено. Осталось пригласить {remaining_invites}.',
      invitationAccessBan:
        '{user}, доступ к чату закрыт: условие по приглашениям не выполнено. Снять бан может администратор.',
      textFiltersMuteCommercial: '{user}, действует мут за повторную коммерческую рекламу.',
      textFiltersMuteProfanity: '{user}, действует мут за повторную грубую лексику.',
      textFiltersMuteGeneric: '{user}, действует мут за повторные нарушения правил чата.',
      muteNotice:
        '{user}, действует мут на {mute_duration}. До его окончания новые сообщения будут удаляться.',
      permanentBanNotice: '{user}, доступ к чату закрыт. Снять бан может администратор.',
      messageLimitsWarn: '{user}, предупреждение: {reason}.',
      messageLimitsMute: '{user}, действует мут. Причина: {reason}.',
      messageLimitsBan:
        '{user}, доступ к чату закрыт. Причина: {reason}. Снять бан может администратор.',
      duplicatePhoto: '{user}, обнаружен повтор фотографии. {sanction}',
      duplicateAlbum: '{user}, обнаружен повтор альбома. {sanction}',
      duplicateWarn: 'Вынесено предупреждение.',
      duplicateMute: 'Мут на {mute_duration}.',
      duplicateBan: 'Доступ к чату закрыт. Снять бан может администратор.',
      duplicatePassiveDeleted: 'Повтор удалён.',
      duplicatePassiveKept: 'Сообщение не удалено.',
    },
  },
  FRIENDLY: {
    editable: {
      greetingBotMessageText:
        'Добро пожаловать, {user}! 👋 Я {bot_character_name}. Загляните в правила и присоединяйтесь к общению.',
      linkBotMessageText:
        '{user}, сообщение {message_status}. Причина: {reason}. Пожалуйста, отправьте текст без этой ссылки.',
      linkWarnMessageText: '{user}, предупреждение: {reason}.',
      requiredSubscriptionBotMessageText: '{user}, чтобы писать в чат, подпишитесь на {channels}.',
      requiredSubscriptionWarnMessageText:
        '{user}, предупреждение: {reason}. Пожалуйста, подпишитесь на {channels}, чтобы продолжить общение.',
      invitationAccessBotMessageText:
        '{user}, сообщение {message_status}. Чтобы писать в чат, осталось пригласить {remaining_invites}. Уже засчитано {invited_count} из {required_invites_count}.',
      invitationAccessWarnMessageText:
        '{user}, предупреждение: {reason}. Уже засчитано приглашений: {invited_count} из {required_invites_count}.',
      textFiltersBotMessageText: '{user}, сообщение {message_status}. Причина: {reason}.',
      textFiltersWarnMessageText: '{user}, предупреждение: {reason}.',
      profanityBotMessageText:
        '{user}, сообщение {message_status}. Причина: {reason}. Пожалуйста, замените грубые выражения.',
      profanityWarnMessageText: '{user}, предупреждение: {reason}.',
      duplicateBotMessageText: '{user}, такое сообщение уже отправляли. {sanction}',
      messageLimitsBotMessageText: '{user}, сообщение {message_status}. Причина: {reason}.',
      messageLimitsWarnMessageText: '{user}, предупреждение: {reason}.',
      phoneNumbersBotMessageText:
        '{user}, сообщение {message_status}. Причина: {reason}. Пожалуйста, отправьте текст без номера телефона.',
      nightModeBotMessageText:
        '🌙 В чате перерыв: {night_window} ({night_timezone}). {night_status} До встречи!',
      nightModeOpenMessageText: '{opening_status} Хорошего общения!',
    },
    system: {
      linkEdited:
        '{user}, сообщение {message_status}. Причина: {reason}. Пожалуйста, отправьте текст без этой ссылки.',
      linkEditedWarn: '{user}, предупреждение: {reason}. Пожалуйста, уберите эту ссылку.',
      linkMute: '{user}, действует мут за запрещённую ссылку.',
      requiredSubscriptionMute:
        '{user}, за сообщения без подписки действует мут на {mute_duration}. Пока он действует, новые сообщения будут удаляться. Подпишитесь на {channels}, чтобы продолжить общение после окончания мута.',
      requiredSubscriptionBan:
        '{user}, доступ к чату закрыт из-за отсутствия подписки на {channels}. Для снятия бана обратитесь к администратору.',
      invitationAccessMute:
        '{user}, действует мут: приглашений пока недостаточно. Осталось пригласить {remaining_invites}.',
      invitationAccessBan:
        '{user}, доступ к чату закрыт: не выполнено условие по приглашениям. Для снятия бана обратитесь к администратору.',
      textFiltersMuteCommercial: '{user}, действует мут из-за повторной рекламы.',
      textFiltersMuteProfanity: '{user}, действует мут из-за повторной грубой лексики.',
      textFiltersMuteGeneric: '{user}, действует мут из-за повторных нарушений правил чата.',
      muteNotice:
        '{user}, действует мут на {mute_duration}. В это время новые сообщения будут удаляться.',
      permanentBanNotice:
        '{user}, доступ к чату закрыт. Для снятия бана обратитесь к администратору.',
      messageLimitsWarn: '{user}, предупреждение: {reason}.',
      messageLimitsMute: '{user}, действует мут. Причина: {reason}.',
      messageLimitsBan:
        '{user}, доступ к чату закрыт: {reason}. Для снятия бана обратитесь к администратору.',
      duplicatePhoto: '{user}, такое фото уже отправляли. {sanction}',
      duplicateAlbum: '{user}, такой альбом уже отправляли. {sanction}',
      duplicateWarn: 'Это предупреждение.',
      duplicateMute: 'Мут на {mute_duration}.',
      duplicateBan: 'Доступ к чату закрыт. Снять бан может администратор.',
      duplicatePassiveDeleted: 'Повтор удалён.',
      duplicatePassiveKept: 'Сообщение не удалено.',
    },
  },
  POLICE: {
    editable: {
      greetingBotMessageText:
        'Приветствую, {user}! На связи {bot_character_name}. Располагайтесь — паспорт и прописка не понадобятся.',
      linkBotMessageText:
        '{user}, сообщение {message_status}. Причина: {reason}. Отправьте текст без этой ссылки.',
      linkWarnMessageText:
        '{user}, предупреждение: {reason}. Следующее сообщение — без этой ссылки.',
      requiredSubscriptionBotMessageText: '{user}, чтобы писать в чате, подпишитесь на {channels}.',
      requiredSubscriptionWarnMessageText:
        '{user}, предупреждение: {reason}. Подпишитесь на {channels} перед следующим сообщением.',
      invitationAccessBotMessageText:
        '{user}, сообщение {message_status}. Для участия осталось пригласить {remaining_invites}.',
      invitationAccessWarnMessageText:
        '{user}, предупреждение: {reason}. Для участия нужно пригласить {required_invites}.',
      textFiltersBotMessageText:
        '{user}, сообщение {message_status}. Причина: {reason}. Рекламу здесь не размещаем.',
      textFiltersWarnMessageText:
        '{user}, предупреждение: {reason}. Следующие сообщения — без рекламы.',
      profanityBotMessageText:
        '{user}, сообщение {message_status}. Причина: {reason}. Продолжим без крепких выражений. Они ещё пригодятся в пробках.',
      profanityWarnMessageText: '{user}, предупреждение: {reason}. Дальше — без грубых слов.',
      duplicateBotMessageText: '{user}, зафиксирован повтор сообщения. {sanction}',
      messageLimitsBotMessageText:
        '{user}, сообщение {message_status}. Ограничение чата: {reason}.',
      messageLimitsWarnMessageText: '{user}, предупреждение по правилам чата: {reason}.',
      phoneNumbersBotMessageText:
        '{user}, сообщение {message_status}. Причина: {reason}. Уберите номер телефона перед повторной отправкой.',
      nightModeBotMessageText:
        '🌙 Перерыв: {night_window} ({night_timezone}). {night_status} Дежурство продолжается, переклички не будет.',
      nightModeOpenMessageText: '{opening_status} Можно общаться — строиться не обязательно.',
    },
    system: {
      linkEdited:
        '{user}, после редактирования сообщение {message_status}. Причина: {reason}. Отправьте текст без этой ссылки.',
      linkEditedWarn: '{user}, предупреждение: {reason}. Уберите эту ссылку.',
      linkMute: '{user}, действует мут за запрещённую ссылку.',
      requiredSubscriptionMute:
        '{user}, действует мут на {mute_duration} за сообщения без подписки. До его окончания новые сообщения будут удаляться. Подпишитесь на {channels}; это не сокращает срок мута.',
      requiredSubscriptionBan:
        '{user}, доступ к чату закрыт: нет подписки на {channels}. Снять бан может администратор.',
      invitationAccessMute:
        '{user}, действует мут: не выполнено условие по приглашениям. Для участия осталось пригласить {remaining_invites}.',
      invitationAccessBan:
        '{user}, доступ к чату закрыт: не выполнено условие по приглашениям. Снять бан может администратор.',
      textFiltersMuteCommercial: '{user}, действует мут за повторную рекламу.',
      textFiltersMuteProfanity: '{user}, действует мут за повторное использование грубой лексики.',
      textFiltersMuteGeneric: '{user}, действует мут за повторные нарушения правил текста.',
      muteNotice:
        '{user}, действует мут на {mute_duration}. До его окончания новые сообщения будут удаляться.',
      permanentBanNotice: '{user}, доступ к чату закрыт. Снять бан может администратор.',
      messageLimitsWarn: '{user}, предупреждение по правилам чата: {reason}.',
      messageLimitsMute: '{user}, действует мут. Причина: {reason}.',
      messageLimitsBan:
        '{user}, доступ к чату закрыт. Причина: {reason}. Снять бан может администратор.',
      duplicatePhoto: '{user}, зафиксирован повтор фото. {sanction}',
      duplicateAlbum: '{user}, зафиксирован повтор альбома. {sanction}',
      duplicateWarn: 'Вынесено предупреждение. Копию в трёх экземплярах здесь не требуют.',
      duplicateMute: 'Назначен мут на {mute_duration}.',
      duplicateBan: 'Доступ к чату закрыт. Снять бан может администратор.',
      duplicatePassiveDeleted: 'Копия удалена. Для протокола достаточно одного экземпляра.',
      duplicatePassiveKept: 'Сообщение осталось в чате.',
    },
  },
  IRONIC: {
    editable: {
      greetingBotMessageText:
        'Привет, {user}! На связи {bot_character_name}. Располагайтесь — знакомиться можно без презентации на сорок слайдов.',
      linkBotMessageText:
        '{user}, сообщение {message_status}. Причина: {reason}. Отправьте текст без этой ссылки.',
      linkWarnMessageText:
        '{user}, предупреждение: {reason}. Пожалуйста, больше не отправляйте эту ссылку.',
      requiredSubscriptionBotMessageText:
        '{user}, чтобы писать в чате, подпишитесь на {channels}. Здесь «я только посмотреть» работает только на чтение.',
      requiredSubscriptionWarnMessageText:
        '{user}, предупреждение: {reason}. Подпишитесь на {channels} перед следующим сообщением.',
      invitationAccessBotMessageText:
        '{user}, сообщение {message_status}. Чтобы участвовать в чате, осталось пригласить {remaining_invites}.',
      invitationAccessWarnMessageText:
        '{user}, предупреждение: {reason}. Для участия нужно пригласить {required_invites}.',
      textFiltersBotMessageText:
        '{user}, сообщение {message_status}. Причина: {reason}. Здесь общаются без рекламы — редкая роскошь по нынешним временам.',
      textFiltersWarnMessageText:
        '{user}, предупреждение: {reason}. Дальше — без рекламы. У неё и без нашего чата всё неплохо.',
      profanityBotMessageText:
        '{user}, сообщение {message_status}. Причина: {reason}. Дальше — без грубых слов. Прибережём их для сборки мебели.',
      profanityWarnMessageText:
        '{user}, предупреждение: {reason}. Пожалуйста, без грубых слов. Русский язык справится.',
      duplicateBotMessageText: '{user}, это сообщение уже отправляли. {sanction}',
      messageLimitsBotMessageText:
        '{user}, сообщение {message_status}. Ограничение чата: {reason}.',
      messageLimitsWarnMessageText: '{user}, предупреждение по правилам чата: {reason}.',
      phoneNumbersBotMessageText:
        '{user}, сообщение {message_status}. Причина: {reason}. Номер лучше оставить для личной переписки — звонков «из банка» и так хватает.',
      nightModeBotMessageText:
        '🌙 Перерыв: {night_window} ({night_timezone}). {night_status} Редкий случай, когда «давайте завтра» предусмотрено правилами.',
      nightModeOpenMessageText: '{opening_status} Совещание по итогам тишины отменяется.',
    },
    system: {
      linkEdited:
        '{user}, после редактирования сообщение {message_status}. Причина: {reason}. Отправьте текст без этой ссылки.',
      linkEditedWarn: '{user}, предупреждение: {reason}. Уберите эту ссылку.',
      linkMute: '{user}, действует мут за запрещённую ссылку.',
      requiredSubscriptionMute:
        '{user}, действует мут на {mute_duration} за сообщения без подписки. До его окончания новые сообщения будут удаляться. Подпишитесь на {channels}; это не сокращает срок мута.',
      requiredSubscriptionBan:
        '{user}, доступ к чату закрыт: нужна подписка на {channels}. Снять бан может администратор.',
      invitationAccessMute:
        '{user}, действует мут: не выполнено условие по приглашениям. Для участия осталось пригласить {remaining_invites}.',
      invitationAccessBan:
        '{user}, доступ к чату закрыт: не выполнено условие по приглашениям. Снять бан может администратор.',
      textFiltersMuteCommercial:
        '{user}, действует мут за повторную рекламу. Наконец-то пауза без рекламы.',
      textFiltersMuteProfanity:
        '{user}, действует мут за повторную грубую лексику. Перерыв на подбор синонимов.',
      textFiltersMuteGeneric: '{user}, действует мут за повторное нарушение правил текста.',
      muteNotice:
        '{user}, действует мут на {mute_duration}. До его окончания новые сообщения будут удаляться.',
      permanentBanNotice: '{user}, доступ к чату закрыт. Снять бан может администратор.',
      messageLimitsWarn: '{user}, предупреждение по правилам чата: {reason}.',
      messageLimitsMute: '{user}, действует мут. Причина: {reason}.',
      messageLimitsBan:
        '{user}, доступ к чату закрыт. Причина: {reason}. Снять бан может администратор.',
      duplicatePhoto: '{user}, это фото уже отправляли. {sanction}',
      duplicateAlbum: '{user}, этот альбом уже отправляли. {sanction}',
      duplicateWarn: 'Вынесено предупреждение.',
      duplicateMute: 'Действует мут на {mute_duration}.',
      duplicateBan: 'Доступ к чату закрыт. Снять бан может администратор.',
      duplicatePassiveDeleted: 'Копия удалена. Повторный показ отменяется.',
      duplicatePassiveKept: 'Сообщение осталось в чате.',
    },
  },
};

function resolveBotSpeechPreset(
  style: BotSpeechStyle | null | undefined,
  _persona: BotSpeechPersona | null | undefined,
): BotSpeechPreset {
  return BOT_SPEECH_PRESETS[resolveBotSpeechStyle(style)];
}

export function getBotSpeechEditableTemplate(
  style: BotSpeechStyle | null | undefined,
  fieldKey: BotSpeechEditableFieldKey,
  persona?: BotSpeechPersona | null,
): string {
  return resolveBotSpeechPreset(style, persona).editable[fieldKey];
}

export function getBotSpeechSystemTemplate(
  style: BotSpeechStyle | null | undefined,
  templateKey: BotSpeechSystemTemplateKey,
  persona?: BotSpeechPersona | null,
): string {
  return resolveBotSpeechPreset(style, persona).system[templateKey];
}
