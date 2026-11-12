const mandatoryIds = new Set(['support-room', 'operator']);
const calendarMonth = String.raw`(?:январ|феврал|март|апрел|ма[йя]|июн|июл|август|сентябр|октябр|ноябр|декабр)\p{L}*`;
const calendarDay = String.raw`\d{1,2}(?:-?(?:го|е|ое))?`;
const calendarDates = new RegExp(
  `${calendarDay}(?:\\s*[,и]\\s*${calendarDay})+\\s+${calendarMonth}|${calendarDay}\\s+${calendarMonth}[^.!?\\n]{0,20}${calendarDay}\\s+${calendarMonth}`,
  'iu',
);
const recurringFrequency =
  /раз(?:а)?\s+(?:в|за)\s+(?:день|недел|сутк)|по (?:понедельник|вторник|сред|четверг|пятниц|суббот|воскресень)|в какие дни.{0,45}(?:публиков|отправ)/iu;
const recurringSchedule = (text) =>
  (recurringFrequency.test(text) ||
    /ежеднев|еженедель|регулярн.{0,15}пост|кажд.{0,12}(?:день|недел)|повтор|без лимита|сохранить расписание/iu.test(
      text,
    )) &&
  !/не повтор|без повтор|не.{0,10}кажд|кажд.{0,15}не надо/iu.test(text) &&
  !/один раз(?!\s+(?:в|за|кажд))/iu.test(text);
const normalize = (value) =>
  String(value ?? '')
    .toLowerCase()
    .replaceAll('ё', 'е')
    .replace(/(?<![\p{L}\p{N}_])ссылок(?![\p{L}\p{N}_])/gu, 'ссылк')
    .replace(/обьяв|обяв/gu, 'объяв')
    .replace(/стоп[\s-]*слов/gu, 'стоп слов')
    .replace(/анти[\s-]*дубл/gu, 'антидубл');
const domain =
  /(?<![\p{L}\p{N}_])бот(?:ы|а|у|ом|е|ов|ам|ами|ах)?(?![\p{L}\p{N}_])|максимов|майор|рэкс|публик|(?<![\p{L}\p{N}_])ластик(?:а|у|ом|е)?(?![\p{L}\p{N}_])|модерац|антидубл|антимат|антиспам|ночн.{0,8}режим|стоп слов|предложк|автопост|автоответ|помощник|\b(?:max|vk|api)\b|(?:^|\s)(?:вк|макс)(?:\s|[.!?,]|$)/iu;
const publisherName = /публик(?:а|у|ом|е)?(?![\p{L}])|\bpublik\b/iu;
const eraserName = /(?<![\p{L}\p{N}_])ластик(?:а|у|ом|е)?(?![\p{L}\p{N}_])/iu;
const moderatorName = /максимов|майор|р[эе]кс/iu;
function moderatorFailure(ctx, state) {
  if (
    state.publisherRequest ||
    state.eraserRequest ||
    state.developer ||
    state.botCatalogRequest ||
    state.botDirectory ||
    moderatorSwitchRequest(ctx.current)
  )
    return false;
  const symptoms = [
    /не\s+(?:удаляет|удаляют|чистит|убирает)|перестал\p{L}*\s+удалять/iu,
    /не\s+(?:отвечает|реагирует)\p{L}*.{0,30}команд|команд\p{L}*.{0,20}не\s+работа/iu,
    /не\s+(?:банит|блокирует)/iu,
  ].filter((pattern) => pattern.test(ctx.current)).length;
  const knownModerator = moderatorName.test(ctx.focus) || /модератор/iu.test(ctx.focus);
  return (
    symptoms >= 2 ||
    (knownModerator &&
      /не\s+работает|перестал\p{L}*\s+работать|молчит|не\s+реагирует/iu.test(ctx.current))
  );
}
const moderatorSwitchRequest = (text) =>
  [
    ...text.matchAll(
      /(?<![\p{L}])(?:переключ(?:и(?:те)?|ить)|поменя(?:й(?:те)?|ть)|замени(?:те)?|смен(?:и(?:те)?|ить))(?![\p{L}])([^.!?\n]{0,90}?)\sна\s+(?:резервн\p{L}*\s+)?(?:максимов\p{L}*|майор\p{L}*|р[эе]кс\p{L}*)(?![\p{L}])/giu,
    ),
  ].some(([, object]) => !/ссылк|профил|аватар|фото|логотип|назван|(?<![\p{L}])имя/iu.test(object));
const botProfileRequest = (text) =>
  (moderatorName.test(text) || publisherName.test(text) || eraserName.test(text)) &&
  /профил|(?<![\p{L}])(?:имя|имена)(?![\p{L}])|какой.{0,20}бот|разные боты|перепут|разниц|разные помощник|(?:дай|пришл|покаж|нужн|перейт|поменя|замен|смен).{0,40}(?<![\p{L}])ссылк|(?<![\p{L}])ссылк.{0,15}(?:на бота|профил)/iu.test(
    text,
  );
const reserveComparison = (text) =>
  moderatorName.test(text) &&
  /резерв|запасн|двойк/iu.test(text) &&
  /(?:это|он|они).{0,20}(?:запасн|резерв)|сильнее|мощнее|лучше|отлич|разниц/iu.test(text);
const reportedPublisherReady = (text, publisherRequest) =>
  Boolean(
    publisherRequest &&
    // FLAG: A setup noun such as «подключению Публика» is not a reported ready state.
    /карточк\p{L}*\s+подключ\p{L}*.{0,25}(?:готов|подключен(?:а|о|ы)?(?![\p{L}]))|публик\p{L}*\s+(?:уже\s+)?подключен(?![\p{L}])|(?:уже\s+)?подключен(?:а|о|ы)?(?![\p{L}]).{0,20}публик/iu.test(
      text,
    ) &&
    !/не\s+(?:готов|подключен)/iu.test(text) &&
    !/подключ\p{L}*.{0,40}(?:слетел|сброс|пропал|ошиб|утер|потер|разор|отвал)|(?:слетел|сброс|пропал|ошиб|утер|потер|разор|отвал).{0,40}подключ/iu.test(
      text,
    ) &&
    !/(?<![\p{L}])(?:еще|друг|втор|нов)\p{L}*(?:\s+\p{L}+){0,3}\s+(?:групп|чат|канал)|(?:групп|чат|канал).{0,30}(?:его|публик\p{L}*).{0,15}(?:нет|не подключ)/iu.test(
      text,
    ) &&
    !/подключ(?:ить|и(?:те)?)(?![\p{L}])|(?:как|хочу|нужно|надо).{0,30}подключ|(?:что|где|порядок|шаг).{0,60}подключени|подключени.{0,35}(?<![\p{L}])(?:еще|друг|втор|нов)|(?:как|куда|хочу|нужно|надо).{0,25}добав.{0,35}(?:чат|групп|канал)/iu.test(
      text,
    ),
  );
const publisherTask =
  /автоответ|автопост|предложк|согласован.{0,15}личк|\bvk\b|(?:^|\s)вк(?:\s|[.!?,]|$)|импорт.{0,20}пост|пост.{0,20}импорт|отложенн.{0,20}пост|пост.{0,20}отлож|регулярн.{0,20}пост|переехал.{0,20}публикац|майор.{0,35}пост|пост.{0,35}майор/iu;
function autoReplyRequest(text) {
  if (/автоответ|автоматическ.{0,8}ответ|ответ.{0,20}ключев/iu.test(text)) return true;
  // FLAG: A word alone is not an auto-reply: require a reply intent, preserving moderation/chatter.
  if (
    /через\s+ии|генерир|каждый раз.{0,20}(?:нов|разн)|(?:текущ|актуальн).{0,25}(?:курс|данн|погод)|не\s+(?:заранее|готов|подготовлен|задан)/iu.test(
      text,
    )
  )
    return false;
  const response =
    /(?:бот\p{L}*|(?<![\p{L}])он)\s+.{0,25}(?:присыл|пришл|отправ|выда|выдал|отвеч|ответ)|(?:ему|человеку|участнику)\s+(?:приход|приш|отправ|присыл)|(?:получа|получил)\p{L}*.{0,20}(?:ответ|список|текст|ссылк)|(?:в\s+ответ|ответ\p{L}*).{0,20}(?:текст|список|ссылк|фото)/iu.test(
      text,
    ) ||
    (publisherName.test(text) && /триггер/iu.test(text) && /присыл|отправ|выда|ответ/iu.test(text));
  const phrase =
    /ключев\p{L}*\s+(?:слов|фраз)|привяз\p{L}*.{0,25}(?:слов|фраз)|(?:по|на)\s+(?:слов|фраз)|(?:пиш|напис|введ|отправ)\p{L}*.{0,25}(?:слов|фраз|[«"„])/iu.test(
      text,
    ) ||
    (/заранее|сохраненн|подготовлен|готов\p{L}*\s+текст/iu.test(text) &&
      /(?:пиш|напис|введ)\p{L}*\s+\p{L}+.{0,25}(?:\sи\s|\sа\s|чтобы|чтоб)/iu.test(text));
  const trigger = /(?<![\p{L}])триггер\p{L}*(?![\p{L}])/iu.test(text);
  return (
    response &&
    (phrase || trigger) &&
    !(/стоп[\s-]*слов/iu.test(text) && !/подготов|заранее|моим?\s+текст|список/iu.test(text))
  );
}
const isPublisherTask = (text) => publisherTask.test(text) || autoReplyRequest(text);
const eraserTask =
  /стар.{0,15}(?:сообщен|переписк)|очист.{0,15}(?:истор|переписк)|удаление по срок/iu;
const correspondenceClosure = /(?:выключ|отключ|останов|огранич)\p{L}*[^.!?\n]{0,30}переписк/iu;
const chatClosure = new RegExp(
  String.raw`закр[ыо]\p{L}*[^.!?\n]{0,65}(?:чат|групп)|(?:чат|групп)[^.!?\n]{0,65}закр[ыо]|(?:чат|групп)[^.!?\n]{0,90}(?:${correspondenceClosure.source})|(?:${correspondenceClosure.source})[^.!?\n]{0,65}(?:чат|групп)`,
  'iu',
);
const nightTopic = new RegExp(
  `${chatClosure.source}|ночн|тишин|ручн.{0,20}(?:закр[ыо]|откр)|(?:закр[ыо]|откр).{0,20}ручн`,
  'iu',
);
const closeAction = /(?<![\p{L}])(?:закры(?:ть|вать)|закрой(?:те)?|закрывай(?:те)?)(?![\p{L}])/giu;
const groupEntry = /вступ|присоедин|приватн|приглаш|вход|заход/iu;
const recurringClosure =
  /кажд|ежеднев|еженедел|по\s+(?:будн|выходн|понедельник|вторник|сред|четверг|пятниц|суббот|воскресень)|на\s+ночь|по\s+времени/iu;
const liveAction =
  /(?<![\p{L}])(?:закрой(?:те)?|закрывай(?:те)?|открой(?:те)?|включи(?:те)?|выключи(?:те)?|отключи(?:те)?|подключи(?:те)?|настрой(?:те)?|поставь(?:те)?|сохрани(?:те)?|запусти(?:те)?|опубликуй(?:те)?)(?![\p{L}])/giu;
const lastikConnectionRecovery =
  /(?:время\s+)?ожидани\p{L}*\s+истек|отмен(?:ил[аи]?|или|ено|ен[ао]?)\s+(?:(?:его|это)\s+)?подключ|подключ\p{L}*\s+(?:было\s+)?отмен/iu;
const lastikSettingsConflict =
  /настройки\s+(?:уже\s+)?изменились|конфликт.{0,20}(?:настро|сохран)/iu;
const retentionHistoryPattern =
  /истори|переписк|(?:до|раньше).{0,25}(?:добав|подкл|включ)|стар\p{L}*.{0,20}сообщ/iu;
const individualRetentionQuestion = (text) =>
  /сообщен|пост|текст/iu.test(text) &&
  (/редакт|поправ|правк|исправ|создан|давност|возраст/iu.test(text) ||
    (/удал|убер|сотр|стер/iu.test(text) &&
      /сообщени[ею](?![\p{L}])|(?:мо[ейяию]|это|конкретн)\p{L}*.{0,25}(?:сообщен|пост|текст)/iu.test(
        text,
      )));
const negatedAt = (text, index) =>
  /(?<![\p{L}])не\s+(?:(?:нужно|надо|следует|хочу|хотим|хотел[аи]?|хотели|собираюсь|собираемся|буду|будем|планирую|планируем)\s+)?(?:(?:вообще|полностью|больше)\s+)?$/iu.test(
    text.slice(0, index),
  );
const moderatorForwardingRequest = (text) =>
  !publisherName.test(text) &&
  !eraserName.test(text) &&
  !botProfileRequest(text) &&
  !/(?:вам|тебе|оператору|поддержке).{0,25}(?:переслать|пересылать)|(?:переслать|пересылать).{0,15}(?:вам|тебе|оператору|поддержке)|для\s+разбора/iu.test(
    text,
  ) &&
  (moderatorName.test(text) || /(?<![\p{L}])бот(?:а|у|ом|е)?(?![\p{L}])|модератор/iu.test(text)) &&
  /максимову|максимовой|майору|р[эе]ксу|(?<![\p{L}])боту(?![\p{L}])|модератору|добавил|добавлен|назначил|подключить/iu.test(
    text,
  ) &&
  /(?:что|куда|кому|как).{0,55}(?:переслать|пересылать|перешлю|перешлите|пересылаю)|(?:переслать|пересылать|перешлю|перешлите|пересылаю).{0,45}(?:куда|кому|чтобы|чтоб)/iu.test(
    text,
  );
function productOf(text) {
  const transition = text.match(/(?:^|[,!.]\s*|\s+)(?:а\s+)?теперь\s+(.+)$/iu);
  if (transition) {
    const nextProduct = productOf(transition[1]);
    if (nextProduct) return nextProduct;
  }
  text = text.replace(/^.*?(?:разобрал[аи]?сь|разобрал[аи]?ся|закончил[аи]?|готово)[.!]\s*/iu, '');
  const publisher = publisherName.test(text.replace(/(?:не|без)\s+публик\p{L}*/giu, ''));
  const eraser = eraserName.test(text);
  if (publisher && eraser) return 'mixed';
  if (eraser) return 'eraser';
  if (publisher) return 'publisher';
  if (isPublisherTask(text)) return 'publisher';
  if (eraserTask.test(text)) return 'eraser';
  if (moderatorName.test(text) && moderatorForwardingRequest(text)) return 'major';
  if (moderatorName.test(text) && /резерв|выбран|модерац/iu.test(text)) return 'major';
  if (/(?:в|через|у)\s+майор/iu.test(text)) return 'major';
  return null;
}
const advert =
  /объяв|объяву|размещени|публикаци|запост|пост(?:ы|а|у|е|ов|ом|ами|ах)?(?![\p{L}])|реклам/iu;
const placement =
  /опубликов|публиков|(?:о)?публику|вылож|размест|запост|напис.{0,15}пост|созда.{0,15}пост/iu;
const removal = /удал|снес|снос|исчез|пропал|заблок|верн.{0,20}(?:пост|объяв)|восстанов/iu;
const help =
  /\?|(?:^|\s)(?:как|почему|где|зачем|какой|какие|что|можно|сколько|вопрос|подскаж\p{L}*|помог\p{L}*|объясн\p{L}*|хочу|нужно|надо|нужен|нужна)(?:\s|$)|не\s+(?:работа|открыва|пуска|получа|приход|могу|вижу|размещ|включ|сохраня|добавля|отправля|публику|загружа)|удал|снес|снос|исчез|пропал|заблок|недоступ|ошибк|слетел|(?:нет|не видно).{0,30}(?:чат|канал|доступ|кноп|модул)/iu;
const actionRequest =
  /(?:^|[\s,.!])(?:закрой(?:те)?|закрывай(?:те)?|открой(?:те)?|включи(?:те)?|выключи(?:те)?|отключи(?:те)?|подключи(?:те)?|настрой(?:те)?|выставь(?:те)?|поставь(?:те)?|проверь(?:те)?|исправь(?:те)?|подтверди(?:те)?|покажи(?:те)?|расскаж(?:и|ите)|объясни(?:те)?|подскаж\p{L}*|дай(?:те)?|сделай(?:те)?|верни(?:те)?|найди(?:те)?|пришли(?:те)?|напиши(?:те)?|прими(?:те)?|поменяй(?:те)?|смени(?:те)?|замени(?:те)?|выгрузи(?:те)?|скачай(?:те)?|пригласи(?:те)?|удали(?:те)?|обнови(?:те)?|запусти(?:те)?|(?:о)?публикуй(?:те)?)(?![\p{L}])/iu;
const unresolvedHelp =
  /не\s+(?:работа|заработ|открыва|пуска|получа|приход|могу|вижу|размещ|включ|сохраня|добавля|отправля|публику|загружа|появ|получил)|(?:все еще|по-прежнему|снова|опять|все равно).{0,30}(?:ошибк|сбо|удал|пропал|молчит)|(?:проблем|ошибк).{0,15}(?:остал|сохрани|не исчез)|недоступ|слетел/iu;
const supportFollowup =
  /по\s+шагам|пошагов|попроще|понятнее|подробнее|не\s+помогло|так\s+и\s+не\s+получилось/iu;
const supportQuestion =
  /\?|нужна помощь|(?:^|\s)(?:как|почему|где|куда|зачем|какой|какие|что|можно|сколько|вопрос|подскаж\p{L}*|помог\p{L}*|объясн\p{L}*)(?:\s|$)/iu;
const supportIncident =
  /удаля(?:ет|ют|ется|ются)|удалили|удален|снес(?:ли|ен)|снос|исчез|пропал|заблок|ошибк|слетел|отказ.{0,25}(?:провер|доступ)|дублиру|повторя|(?:нет|не видно).{0,30}(?:чат|канал|доступ|кноп|модул)/iu;
const configurationIntent =
  /(?:хочу|нужно|надо|нужен|нужна).{0,45}(?:включить|выключить|отключить|настроить|запре(?:тить|щать)|разреш(?:ить|ать)|подключить|добавить|удал(?:ить|ять)|очистить|опубликовать|разместить|запостить|создать|сохранить|закры(?:ть|вать)|открыть|изменить|обновить|оставить)/iu;
const configurationSubject =
  /настройк|прав[аоу]|доступ|кнопк|видео|фото|изображен|сообщен|чат|канал|профил|приложен/iu;
const configurationAction =
  /включ|выключ|отключ|настро|запрет|разреш|подключ|огранич|сохран|измен|откр[оы]|закр[оы]/iu;
const projectSubject =
  /приветстви|стиль речи|команд.{0,20}(?:бан|мут)|(?:запретить|ограничить).{0,20}участник.{0,20}писать|снять.{0,25}блокировк|(?:статистик|сводк).{0,25}(?:чат|групп|участник)|мини[\s-]?приложен|(?:оператор|разбор|раздел).{0,40}событи|меня заблокировали в группе|текстовые правила|публичн.{0,20}канал/iu;
const supportOpener = (text) =>
  /^(?:нужна\s+помощь(?:\s+с\s+ботом)?|(?:вы\s+)?(?:можете|можешь)\s+помочь|помоги(?:те)?(?:,?\s+пожалуйста)?|подскажи(?:те)?|не\s+(?:работает|открывается))[.!?\s]*$/iu.test(
    text.replace(/^(?:здравствуйте|здравствуй|привет)[,!\s]*(?:бот[,!\s]*)?/iu, ''),
  );
const platformUpdates = (text) =>
  /\bmax\b|(?<![\p{L}])макс(?:а|е|у|ом)?(?![\p{L}])/iu.test(text) &&
  /(?:что|какие).{0,20}(?:нов|измен|обнов)|последн.{0,15}(?:новост|обновлен|изменени)|актуальн.{0,20}(?:данн|справк|информац)/iu.test(
    text,
  );
const storefrontPattern =
  /караван|интернет.?витрин|магазин.{0,12}чат|витрин|ответ.{0,15}\$|\$.{0,25}(?:кнопк|продав|участник)|кнопк.{0,15}магазин/iu;
const developerPattern =
  /\bapi\b|\bnotify\b|разработ|webhook|longpoll|uploads|platform-api|\b(?:get|post|put|delete|patch)\s+\/|\/(?:chats|messages|uploads)(?:\/|\?|\b)/iu;
const commercialPattern =
  /(?<![\p{L}])ии(?![\p{L}])[\s-]*(?:модерац|анализ|реклам)|(?:реклам|объяв).{0,70}(?:(?<![\p{L}])ии(?![\p{L}])|искусственн)|(?:(?<![\p{L}])ии(?![\p{L}])|искусственн).{0,35}(?:реклам|модерир|фильтр|наблюдени)|наблюдени.{0,35}(?<![\p{L}])ии(?![\p{L}])|удалять рекламу|двойн.{0,6}проверк/iu;
const subscriptionPattern =
  /подписк|подписан|подписал|подписать|подписаться|подписыва|подпиш(?!и)|подпиши(?:те|сь|тесь)?\s+(?:(?:меня|нас|аккаунт|участник\p{L}*)\s+)?на\s+(?:(?:нужн\p{L}*|все|выбранн\p{L}*)\s+)?(?:канал|источник|групп)/iu;
const topicPatterns = [
  ['polls', /(?<![\p{L}])опрос\p{L}*|голосован|проголосова/iu],
  ['giveaways', /розыгрыш|розыграш|конкурс|призов.{0,8}мест/iu],
  [
    'participants',
    /карточк.{0,15}участник|список участников|поиск.{0,12}участник|без сообщений|баз.{0,8}спам/iu,
  ],
  ['channel-buttons', /быстр.{0,8}кноп|действие под публикац|подпис.{0,15}под пост/iu],
  ['service', /сообщения и боты|свои.{0,12}сообщен|собственн.{0,12}сообщен|других ботов/iu],
  [
    'invitations',
    /доступ за приглаш|сколько.{0,15}пригласить|приглас\p{L}*.{0,15}(?:участник|друз)/iu,
  ],
  ['night', nightTopic],
  [
    'duplicates',
    /антидубл|дублиру.{0,20}сообщен|дословн.{0,15}повтор|повтор.{0,20}(?:текст|подпис|сообщени)/iu,
  ],
  ['profanity', /антимат|\bмат\b|мата|оскорблен|бытов.{0,15}(?:руг|обзыв)/iu],
  ['stop-words', /стоп слов|стоп[- ]?(?:спис|лист)|запрещенн.{0,10}фраз/iu],
  ['subscription', subscriptionPattern],
  [
    'rules',
    /(?<![\p{L}])правил.{0,30}(?:черновик|опубликов|публикац|пост|сохран|обнов|фото|кнопк)|(?:опубликов|публикац|черновик|собрат).{0,25}(?<![\p{L}])правил|текст\s+правил|[«"]правила[х»"]|раздел.{0,8}(?<![\p{L}])правил/iu,
  ],
  ['protection', /защит[ауые]|иммунитет/iu],
  ['links', /(?<![\p{L}])ссылк|домен|allowlist|whitelist/iu],
  [
    'limits',
    /ограничен|длин.{0,15}сообщен|частот|флуд|антиспам|стикер|аудио|войс|медленн.{0,8}режим/iu,
  ],
  ['reports', /жалоб|пожалова|жаловаться|\breport\b/iu],
  [
    'retention',
    /(?<![\p{L}\p{N}_])ластик(?:а|у|ом|е)?(?![\p{L}\p{N}_])|стар.{0,15}сообщен|очист.{0,15}истор|удаление по срок/iu,
  ],
  ['networks', /сетк|избранн|категори/iu],
  [
    'delivery',
    /[«"„]нужно проверить[»"“]|статус.{0,20}нужно проверить|отправ\p{L}*[^.!?\n]{0,35}(?:сеть|связь|интернет)[^.!?\n]{0,20}(?:отвал|оборвал|пропал)|результат.{0,20}(?:отправ|неизвест)|достав|(?:отправ|публиков).{0,25}(?:еще раз|повтор|заново)|(?:повтор|заново).{0,25}(?:отправ|публиков)/iu,
  ],
  ['auto-replies', { test: autoReplyRequest }],
  ['vk', /\bvk\b|(?:^|\s)вк(?:\s|[.!?,]|$)|вконтакт|согласован.{0,15}личк/iu],
  [
    'suggestions',
    /предложк|[«"]?предложения[»"]?|при[её]м.{0,15}предлож|предложенн.{0,10}пост|предложить пост/iu,
  ],
  ['notifications', /уведомлен|пуш|\bpush\b/iu],
  ['comments', /комментари|обсужден/iu],
  [
    'schedule',
    /отложенн|расписан|ежеднев|еженедель|кажд.{0,8}(?:день|недел)|по понедельник|по вторник/iu,
  ],
  ['commercial', commercialPattern],
  ['price', /цен[аыуе]|тариф|стоимост|платн|бесплат|оплат|сколько стоит/iu],
  ['developer', developerPattern],
  ['max-updates', { test: platformUpdates }],
  ['storefront', storefrontPattern],
];
const topics = (text) =>
  topicPatterns.filter(([, pattern]) => pattern.test(text)).map(([id]) => id);
const words = (text) =>
  (normalize(text).match(/[а-яa-z0-9_]{3,}/gu) ?? [])
    .filter(
      (word) =>
        !/^(?:как|какой|какие|почему|где|что|сколько|это|чтобы|для|или|при|про|есть|мне|меня|мой|мои|ваш|ваши|наш|наши|нужно|надо|можно|будет|уже|еще|включить|выключить|отключить|настроить|сделать|вижу|открыть|посмотреть|изменить|сохранить|найти|применить|проверить|админ|администратор|участник|владелец)$/u.test(
          word,
        ),
    )
    .map((word) =>
      word
        .replace(
          /(?:иями|ями|ами|ией|ов|ев|ом|ам|ах|ях|ий|ый|ой|ая|ое|ые|ие|ую|юю|ы|и|а|я|у|ю|е|о)$/u,
          '',
        )
        .slice(0, 8),
    )
    .filter((word) => word.length >= 3);

function ordinaryConversation(text) {
  if (/^(?:этот\s+)?бот\s+заказал.{0,70}(?:яхт|эскорт|проститут|шлюх)/iu.test(text)) return true;
  if (
    /^(?:все[,!.\s]*)?(?:всем\s+)?(?:спасибо|благодарю|доброе утро|добрый вечер|спокойной ночи|хорошего.{0,12}дня|понял[аи]?|разобрал[аи]?ся|получилось|договорились|наконец-то)(?:[^?]*)$/iu.test(
      text,
    ) &&
    !actionRequest.test(text) &&
    !unresolvedHelp.test(text) &&
    !/(?:а\s+)?(?:как|почему|где|можно)\s/iu.test(text)
  )
    return true;
  if (
    /^(?:привет|здравствуй(?:те)?)[,!\s]*(?:бот[!,\s]*)?(?:как\s+(?:дела|ты|жизнь))?[.!?\s]*$/iu.test(
      text,
    )
  )
    return true;
  if (
    !help.test(text) &&
    !actionRequest.test(text) &&
    /все спокойно|работает.{0,12}недел|красавчик|молодец|называется|вовремя|ура[!.\s]*$/iu.test(
      text,
    )
  )
    return true;
  return (
    !domain.test(text) &&
    (/погод|футбол|борщ|рецепт|как у тебя работа|умножить|разделить|\d\s*[+*/=]\s*\d/iu.test(
      text,
    ) ||
      /^(?:продам|куплю|сдам|сниму)\s/iu.test(text))
  );
}

function namedSupportProduct(text) {
  return (
    publisherName.test(text) ||
    eraserName.test(text) ||
    moderatorName.test(text) ||
    autoReplyRequest(text)
  );
}

function supportAssistantRequest(text, recent = []) {
  const explicit =
    /(?<![\p{L}])(?:ии|llm)(?![\p{L}])|интеллектуальн|как\s+(?:вы|ты).{0,20}(?:отвеча|понима)|помощник\p{L}*\s+как\s+(?:ты|вы)/iu.test(
      text,
    );
  if (namedSupportProduct(text) && !explicit) return false;
  const direct =
    /(?:такого|такой|этого|этот|ии|интеллектуальн)\p{L}*\s+(?:ии[ -]?)?помощник|как\s+(?:вы|ты).{0,20}(?:отвеча|понима)|(?:фраз|ответ).{0,25}из контекст|контекст.{0,25}(?:фраз|ответ)|(?<![\p{L}])llm(?![\p{L}])/iu.test(
      text,
    );
  if (explicit && direct) return true;
  const previous = recent.findLast(
    (item) =>
      item.role === 'user' &&
      (namedSupportProduct(item.text) || supportAssistantRequest(item.text)),
  );
  if (previous && namedSupportProduct(previous.text) && !supportAssistantRequest(previous.text))
    return false;
  return (
    direct ||
    Boolean(
      previous &&
      supportAssistantRequest(previous.text) &&
      /^(?:а\s+)?(?:он|этот\s+помощник).{0,50}(?:заточен|поддержк|умеет|отвеча)/iu.test(text),
    )
  );
}

function peerAdvice(text, original) {
  if (botProfileRequest(text)) return false;
  if (
    /(?:^|\s)(?:мне|меня|мо[йяеию]|мое(?:го|му|м|й|ю)?|моих|моими|нам|наш\p{L}*|хочу|хотим|сам|сами|помогите|подскажите)(?![\p{L}])/iu.test(
      text,
    )
  )
    return false;
  if (
    /(?:^|[.!]\s*)(?:а\s+)?(?:вы|вам).{0,65}(?:включите|откройте|нажмите|попробуйте|мешает)|^(?:установите|добавьте|назначьте).{0,100}(?:дайте|напишите|нажмите|откройте)/iu.test(
      text,
    )
  )
    return true;
  if (unresolvedHelp.test(text) && !/(?:^|[\s,.])если(?![\p{L}])/iu.test(text)) return false;
  // FLAG: Embedded question words in standalone advice do not address the assistant.
  // Preserve personal/information requests before recognizing procedural or declarative advice.
  if (
    /\?|(?:^|\s)(?:помоги\p{L}*|подскажи\p{L}*|объясни\p{L}*|расскажи\p{L}*|скажите|пришлите|покажите)(?![\p{L}])/iu.test(
      text,
    )
  )
    return false;
  const imperatives = [
    ...text.matchAll(
      /(?<![\p{L}])(?:откройте|укажите|выберите|настройте|включите|отключите|добавьте|дайте|нажмите|отметьте|разместите|выставьте|попробуйте|проверьте|перешлите|публикуйте|сохраните|создайте|поставьте|назначьте|зайдите)(?![\p{L}])/giu,
    ),
  ];
  const addressee =
    typeof original === 'string'
      ? /^\s*([\p{Lu}][\p{Ll}]{1,30}(?:[ -][\p{Lu}][\p{Ll}]{1,30})?),\s/u.exec(original)?.[1]
      : null;
  if (
    addressee &&
    imperatives.length >= 2 &&
    !namedSupportProduct(addressee) &&
    !help.test(addressee) &&
    !actionRequest.test(addressee) &&
    !/^(?:здравствуйте|здравствуй|привет|пожалуйста|бот|помощник|поддержка|оператор)$/iu.test(
      addressee,
    )
  )
    return true;
  if (/^(?:а\s+)?(?:как|почему|где|куда|зачем|(?:вы\s+)?можете)(?![\p{L}])/iu.test(text))
    return false;
  if (/^(?:а\s+)?можно(?![\p{L}])/iu.test(text) && !(imperatives.length && /:/u.test(text)))
    return false;
  const thirdPerson =
    /(?:^|\s)(?:его|ее|их|ему|ей|им|этого\s+участника|этой\s+участницы|участнику|человеку|рекламодателю)(?![\p{L}])/iu.test(
      text,
    );
  return (
    /^(?:я|мы)\s+(?:обычно|всегда|тоже).{0,45}(?:делаю|делаем|настраива|публику)/iu.test(text) ||
    (thirdPerson &&
      (imperatives.length > 0 || /(?:^|\s)(?:можете|можно)(?![\p{L}])/iu.test(text))) ||
    /(?:бот\p{L}*|публик\p{L}*|майор\p{L}*)\s+(?:позволяет|умеет|поддерживает)(?![\p{L}])/iu.test(
      text,
    ) ||
    /(?:^|\s)(?:в|через)\s+публик\p{L}*\s+(?:можно\s+(?:задать|выбрать|настроить)|выберите|укажите|настройте)/iu.test(
      text,
    )
  );
}

function conversation(text, history) {
  const prior = (Array.isArray(history) ? history : [])
    .filter((item) => ['user', 'assistant'].includes(item?.role) && typeof item.text === 'string')
    .slice(-8)
    .map(({ role, text: value }) => ({ role, text: normalize(value.slice(0, 1200)) }));
  const current = normalize(text).replace(
    /^.*?(?:разобрал(?:ся|ась|ись)|закончил[аи]?|готово)[.!]\s*(?:а\s+)?теперь\s+/iu,
    '',
  );
  // FLAG: Unrelated turns end topical inheritance; they must not revive an old support question.
  const boundary = prior.findLastIndex(
    (item) => item.role === 'user' && ordinaryConversation(item.text),
  );
  const recent = prior.slice(boundary + 1);
  const specific = topics(current).filter((id) => !['price', 'links', 'limits'].includes(id));
  let scoped = specific.length
    ? recent.filter((item) => topics(item.text).some((id) => specific.includes(id)))
    : recent;
  const currentProduct =
    productOf(current) ||
    recent
      .filter((item) => item.role === 'user')
      .map((item) => productOf(item.text))
      .findLast(Boolean);
  if (currentProduct && currentProduct !== 'mixed')
    scoped = scoped.filter(
      (item) => !productOf(item.text) || productOf(item.text) === currentProduct,
    );
  return {
    current,
    prior,
    recent,
    focus: [...scoped.map((item) => item.text), current].join('\n'),
  };
}

const admin = String.raw`(?:админ(?:истратор)?(?:ом|ы|ами|у|а)?|владел(?:ец|ьцем|ьцы|ьцами)|владелиц(?:а|ей|ы|ами))`;
const member = String.raw`(?:участник(?:ом|и|ами)?|участниц(?:а|ей|ы|ами)|подписчик(?:ом|и|ами)?|подписчиц(?:а|ей|ы|ами)|пользовател(?:ь|ем|и|ями))`;
const self = String.raw`(?<![\p{L}\p{N}_])(?:я|мы)\s*(?:[—–-]\s*)?(?:(?:теперь|сейчас|уже|тут|здесь|сам|сама|сами|его|ее|являюсь|являемся|обычный|обычная|обычные|простой|простая|простые)\s+)*`;
const end = String.raw`(?![\p{L}\p{N}_])`;
const rolePatterns = [
  [
    'admin',
    new RegExp(`${self}${admin}${end}|^${admin}[.!?\\s]*$|(?<![\\p{L}])админю(?![\\p{L}])`, 'giu'),
  ],
  [
    'member',
    new RegExp(
      `${self}(?:не\\s+${admin}|${member})${end}|^(?:не\\s+${admin}|${member})[.!?\\s]*$`,
      'giu',
    ),
  ],
  ['admin', new RegExp(`(?:назнач\\p{L}*\\s+меня|меня\\s+назнач\\p{L}*)\\s+${admin}${end}`, 'giu')],
  [
    'member',
    /(?:у меня|мне).{0,15}(?:забрали|сняли|отозвали).{0,12}прав|(?:я|сам).{0,10}прав.{0,8}не имею/giu,
  ],
];
function roleOf(current, recent) {
  let role = 'unknown';
  const turns = [...recent, { role: 'user', text: current }];
  for (const [index, item] of turns.entries()) {
    if (item.role !== 'user') continue;
    const found = rolePatterns.flatMap(([value, pattern]) =>
      [...item.text.matchAll(pattern)].map((match) => ({
        value,
        index: match.index,
        length: match[0].length,
      })),
    );
    found.sort((a, b) => a.index - b.index || a.length - b.length);
    if (found.length) role = found.at(-1).value;
    else {
      const preceding = turns[index - 1];
      if (
        /^(?:да|нет)[.!\s]*$/iu.test(item.text) &&
        preceding?.role === 'assistant' &&
        /вы.{0,12}админ/iu.test(preceding.text) &&
        !/или|участник/iu.test(preceding.text)
      )
        role = /^да/iu.test(item.text) ? 'admin' : 'member';
    }
  }
  return role;
}

function subscriptionIntent(ctx) {
  if (!subscriptionPattern.test(ctx.focus)) return null;
  const setup =
    /(?:добав|убра|удал|выб|смен|измен)\p{L}*\s+(?:(?:нов\p{L}*|обязательн\p{L}*|выбранн\p{L}*|эт\p{L}*|друг\p{L}*|сво\p{L}*|наш\p{L}*|нужн\p{L}*)\s+){0,2}(?:источник|канал|требован)|(?:источник|канал|требован)\p{L}*\s+(?:как\s+)?(?:добав|убра|удал|выб|смен|измен)|настро.{0,20}(?:подписк|источник)|(?:подписк|источник).{0,20}настро|сохран.{0,15}(?:источник|подписк)/iu;
  const membership =
    /(?<![\p{L}])(?:я|мы).{0,35}(?:подписан|подписал)|(?:мо[яюией]|наш[ауеи]).{0,12}(?:подписк|аккаунт)|(?:провер|исправ|обнов).{0,25}(?:подписк|аккаунт)|(?:подписк|подписан).{0,40}(?:не пуска|не дает|удаля|пишет|провер)|(?:не пуска|не дает|удаля|пишет|говорит|считает).{0,40}(?:подписк|подписан)/iu;
  const participation =
    /(?:как|где|куда|на что|на какие).{0,30}подписаться|(?:сам|сами|руками|автомат).{0,20}(?:подпиш|подпис(?:ать|аться|ыва)|запиш)|(?:подписаться|подпиш|запиш).{0,30}(?:сам|сами|руками|автомат|за меня)|помощник.{0,20}подписаться/iu;
  // FLAG: Only user requests select the workflow; a prior assistant suggestion cannot turn membership into admin setup.
  for (const item of [
    { text: ctx.current },
    ...ctx.recent.filter((item) => item.role === 'user').reverse(),
  ]) {
    const config = setup.test(item.text);
    const ownAccount = membership.test(item.text);
    const participant = participation.test(item.text);
    if (config && (ownAccount || participant)) return 'mixed';
    if (config) return 'setup';
    if (participant) return 'participation';
    if (ownAccount) return 'membership';
  }
  return null;
}

function reviewedIntents(ctx) {
  const publicChannel = /публичн.{0,25}канал|обычн.{0,20}канал|channel_/iu.test(ctx.focus);
  const mediaSubject = /видео|фото|медиа|мб|гб|байт|символ|вложен|файл/iu.test(ctx.current);
  const creationSubject =
    /(?:созда|откр|заве|сдела).{0,35}(?:канал|обычн|публичн|channel_)|(?:канал|channel_).{0,35}(?:созда|откр|заве)/iu.test(
      ctx.current,
    );
  const ownershipSubject =
    /(?:собственн|своих|моих).{0,25}(?:канал|публичн)|(?:сколько|количеств).{0,30}(?:канал|публичн)|(?:пять|шест|5)\s+(?:(?:собственн|моих|своих|публичн|обычн)\p{L}*\s+){0,3}канал|каналов.{0,15}(?:пять|шест|5)|четыре.{0,45}один|(?<!\d)4.{0,45}(?:1(?!\d)|один)/iu.test(
      ctx.current,
    );
  const conditionsSubject =
    /(?:услови|требован).{0,50}(?:публичн|обычн|канал)|(?:публичн|обычн|канал).{0,50}(?:услови|требован)|лимит\s+(?:количества\s+|числа\s+)?(?:(?:собственн|публичн|обычн)\p{L}*\s+){0,3}каналов/iu.test(
      ctx.current,
    );
  const eligibility =
    publicChannel &&
    !mediaSubject &&
    (creationSubject || ownershipSubject || conditionsSubject) &&
    /услови|требован|лимит|сколько\s+(?:(?:своих|собственных|публичных)\s+){0,2}канал|сколько\s+(?:нужно|должно быть).{0,20}(?:канал|подписчик)|пять|шест|(?<![\p{L}\d])5(?![\p{L}\d])|четыре.{0,45}один|(?<!\d)4.{0,45}(?:1(?!\d)|один)|менее.{0,10}пят/iu.test(
      ctx.current,
    );
  const incident = /разбор|оператор|поддержк|событи|журнал|удал|ошибк|проблем|сбой/iu.test(
    ctx.focus,
  );
  const evidence =
    incident &&
    /(?:какие|что|куда|как).{0,35}(?:данн|присл|переда|описать|сообщить|подгот|прилож|написать)|(?:что|какие).{0,25}(?:дать|отправить).{0,35}(?:разбор|оператор|поддержк)|(?:токен|парол|код вход).{0,20}нуж/iu.test(
      ctx.current,
    );
  return { eligibility, evidence };
}

function mixedRequests(ctx, state) {
  if (/(?<![\p{L}])(?:а|и)\s+(?:объясни|подскажи|расскажи|покажи|поясни)/iu.test(ctx.current))
    return true;
  if (state.lastikWaitingOnly || state.lastikSetupOnly) return false;
  if (
    (state.publisherRequest || state.eraserRequest) &&
    ctx.current.includes('?') &&
    /[\p{L}]/u.test(ctx.current.slice(ctx.current.indexOf('?') + 1))
  )
    return true;
  if (state.subscriptionIntent === 'mixed') return true;
  if (
    state.publisherRequest &&
    eraserName.test(ctx.current) &&
    productOf(ctx.current) === 'mixed' &&
    (placement.test(ctx.current) || isPublisherTask(ctx.current))
  )
    return true;
  if (
    state.reviewedIntents.eligibility &&
    /(?<![\p{L}])(?:как|где)(?![\p{L}]).{0,25}(?:созда|откр)|пошаг/iu.test(ctx.current)
  )
    return true;
  const currentTopics = new Set(topics(ctx.current));
  if (state.reviewedIntents.eligibility) currentTopics.add('public-channel');
  if (state.reviewedIntents.evidence) currentTopics.add('incident-evidence');
  if (
    state.commercialAi &&
    state.reviewedIntents.evidence &&
    /наблюда|наблюдени|ии[\s-]*анализ|без автоматических удалений|(?<![\p{L}])тест(?![\p{L}])/iu.test(
      ctx.current,
    )
  )
    return true;
  if (placement.test(ctx.current)) currentTopics.add('publication');
  if (state.publisherRequest && /[«"„]нужно проверить[»"“]/iu.test(ctx.current))
    currentTopics.add('delivery');
  if (/подкл[юу]ч|подклюить/iu.test(ctx.current)) currentTopics.add('connection');
  const secondTask =
    /(?<![\p{L}])(?:и|а)\s+(?:еще|также|заодно|как|где|почему|сколько|какие|можно|настрой|включ|выключ|подключ|добав|провер|расскаж|объясни|переключ|смен|замен|помен|запрет|разреш)|кроме того|а также|;|[.!?]\s*(?:а\s+|и\s+)?(?:как|где|почему|что|сколько|какие|можно|нужно|настрой|включ|выключ|подключ|добав|провер|переключ|смен|замен|помен|запрет|разреш)/iu.test(
      ctx.current.replace(/^(?:а|и)\s+/iu, ''),
    );
  if ((state.botDirectory || state.botCatalogRequest) && secondTask) return true;
  if (secondTask && currentTopics.size > 1) return true;
  return Boolean(state.commercialAi && topics(ctx.current).some((topic) => topic !== 'commercial'));
}

function lastikConnectionIntent(ctx, state, primaryIds) {
  if (
    !state.eligible ||
    !primaryIds.some((id) => ['lastik-connect', 'lastik-permissions'].includes(id))
  )
    return null;
  const detect = (value) => {
    if (lastikConnectionRecovery.test(value)) return 'restart';
    const submitted = [
      ...value.matchAll(
        /(?<![\p{L}])(?:нажал[аи]?|нажали|запросил[аи]?|запустил[аи]?|отправил[аи]?|подтвердил[аи]?|подтвердили).{0,45}(?:подключ|проверить и включить)/giu,
      ),
    ].some((match) => !negatedAt(value, match.index));
    const submittedRequest = [
      ...value.matchAll(
        /(?:запрос|подключ\p{L}*)[^.!?\n]{0,65}(?<action>отправил[аи]?|отправили|подал[аи]?|подали|запустил[аи]?|запустили)(?![\p{L}])/giu,
      ),
    ].some((match) => !negatedAt(value, match.index + match[0].lastIndexOf(match.groups.action)));
    if (
      submitted ||
      submittedRequest ||
      /статус.{0,20}[«"'„]?(?:ожидани)|(?:подключение|запрос|в (?:мини-)?приложении).{0,25}(?:ожида|в процессе)|(?:жду|ожидаю).{0,40}подключ/iu.test(
        value,
      )
    )
      return 'waiting';
    if (
      /подключ(?:ить|и(?:те)?)(?![\p{L}])|переподключ|(?<![\p{L}])(?:для|порядок|шаги)\s+подключени/iu.test(
        value,
      )
    )
      return 'setup';
    return null;
  };
  // FLAG: These are user-described question topics, never observed live connection states.
  const current = detect(ctx.current);
  if (current) return current;
  const waitingFollowup = /молч|ждать|ожида|(?:опять|снова|еще раз).{0,25}подкл/iu.test(
    ctx.current,
  );
  if (
    /уже подключ|подключился|подключилась/iu.test(ctx.current) ||
    (!waitingFollowup &&
      /прогресс|числ|подробност|срок|недел|месяц|закреп|исключ|сохран|настрой|истори|стар.{0,15}сообщен/iu.test(
        ctx.current,
      ))
  )
    return null;
  for (const item of ctx.recent.filter((turn) => turn.role === 'user').reverse()) {
    const intent = detect(item.text);
    if (intent) return intent;
  }
  return null;
}

function atomicLastikWaiting(ctx, state) {
  const waitingQuestion = ctx.current.replace(
    /(?:чтобы|чтоб)\s+(?:очистка|удаление)\s+(?:пошл[ао]|начал[ао]сь|включил[ао]сь|запустил[ао]сь|заработал[ао])/giu,
    '',
  );
  const explicitNightTask =
    chatClosure.test(waitingQuestion) ||
    /ночн|закрыв.{0,20}чат|закры.{0,20}(?:чат|расписан)|чат.{0,20}закры|(?:включ|выключ|настро|команд|режим).{0,25}тишин|тишина\s+(?:вкл|выкл)/iu.test(
      waitingQuestion,
    );
  if (
    !state.eraserRequest ||
    state.publisherRequest ||
    state.botDirectory ||
    state.botCatalogRequest ||
    lastikConnectionIntent(ctx, state, ['lastik-connect']) !== 'waiting' ||
    topics(ctx.current).some(
      (topic) => topic !== 'retention' && (topic !== 'night' || explicitNightTask),
    )
  )
    return false;
  if (
    /прогресс|числ|подробност|счетчик|срок|хран|сут|недел|месяц|(?:24|48)\s*час|сто(?:ит|ят|имост)|плат|цен|тариф|сообщен|канал|закреп|исключ|сохран|настрой|истори|останов|отключ|выключ|пауз|вернуть(?!ся)|восстанов|отмен|истек|(?:как|какие|где|нужно).{0,35}(?:дать|выдать|назначить|права)|удал|очист|чист|уме|работ/iu.test(
      waitingQuestion,
    )
  )
    return false;
  // FLAG: A waiting report alone must not swallow a second unrecognised question.
  return waitingQuestion
    .split(
      /[.!?;\n]+|(?<![\p{L}])(?:а|и)\s+(?=(?:еще\s+)?(?:как|где|почему|что|сколько|какие|можно))/u,
    )
    .filter((part) => part.trim())
    .every((part) =>
      /подкл|ожидан|жд(?:у|ать|ем)|молч|ни слова|старт|в приложение|мини-прилож|вернуться|прав[ао]|админ|провер|что.{0,12}(?:делать|дальше)|минут|час/iu.test(
        part,
      ),
    );
}

function reviewedTaskCovered(text, topic, generic = /(?!)$/u, allowedInfinitives = null) {
  // FLAG: Recognized facts alone cannot prove that every requested task is covered.
  // Split independent questions, including unknown topics, before allowing a reviewed reply.
  return text
    .split(
      /(?<=[.!?;])\s*|\n|(?<![\p{L}])(?:а|и)\s+(?=(?:(?:еще|также|заодно)\s+)?(?:как|где|почему|что|сколько|какие|можно|помен|смен|замен|выгруз|скача|приглас|удал|обнов|включ|выключ|отключ|подключ|настро|добав|убра|объясни|подскажи|расскажи|покажи|поясни|\p{L}{2,}(?:ть|ти|чь)(?:ся)?(?![\p{L}])))|(?<![\p{L}])(?:а|и)\s+(?:еще|также|заодно)\s+/u,
    )
    .map((part) => part.trim())
    .filter(Boolean)
    .every(
      (part) =>
        (!allowedInfinitives ||
          [...part.matchAll(/(?<![\p{L}])\p{L}{2,}(?:ть|ти|чь)(?:ся)?(?![\p{L}])/gu)].every(
            (match) =>
              /^(?:опять|пять)$|ости$/u.test(match[0]) || allowedInfinitives.test(match[0]),
          )) &&
        (!(
          help.test(part) ||
          actionRequest.test(part) ||
          /^(?:еще|также|заодно|помен|включ|выключ|отключ|подключ|настро|добав|убра|замен|смен|выгруз|скача|приглас|удал|обнов)/iu.test(
            part,
          ) ||
          /^\p{L}{2,}(?:ть|ти|чь)(?:ся)?(?![\p{L}])/u.test(part)
        ) ||
          topic.test(part) ||
          generic.test(part)),
    );
}

function reviewedAtomicIntents(ctx, state, primaryIds) {
  const only = (allowed) => primaryIds.every((id) => allowed.includes(id));
  const conflict = state.eraserRequest && lastikSettingsConflict.test(ctx.focus);
  const savedChoice = [
    ...ctx.current.matchAll(
      /загрузить\s+сохраненн|(?:остав|прин|сохрани)\p{L}*[^.!?\n]{0,35}(?:настройк\p{L}*\s+коллег|его\s+настройк|(?:текущ|уже\s+сохраненн)\p{L}*\s+настройк)|(?:свои|мои)\s+(?:чернов\p{L}*|изменени\p{L}*|настройк\p{L}*)\s+не\s+примен/giu,
    ),
  ].some(
    (match) =>
      !negatedAt(ctx.current, match.index) &&
      !(/^(?:остав|прин|сохрани)/iu.test(match[0]) && /(?<![\p{L}])не(?![\p{L}])/iu.test(match[0])),
  );
  const mineChoice = [
    ...ctx.current.matchAll(
      /(?:примен|сохран)\p{L}*[^.!?;:\n]{0,25}(?:мой|свой)\s+вариант|(?:нужен|нужны)\s+(?:мой\s+вариант|мои\s+настройки)/giu,
    ),
  ].some((match) => !negatedAt(ctx.current, match.index));
  const conflictingMine =
    mineChoice && /не\s+перезапис\p{L}*[^.!?\n]{0,25}(?:коллег|его|чуж)/iu.test(ctx.current);
  const conflictCovered =
    conflict &&
    !state.mixedTopics &&
    only(['lastik-save-recovery', 'message-retention', 'settings']) &&
    reviewedTaskCovered(
      ctx.current,
      /настройки\s+(?:уже\s+)?изменились|(?:остав|прин|примен|сохран|загруз|нужен).{0,40}(?:настройк|вариант|чернов)|(?:свои|мои).{0,25}не\s+примен/iu,
      /^(?:а\s+)?(?:как(?:ую)?\s+(?:из\s+)?(?:этих\s+)?кноп(?:к|ок)\p{L}*\s+(?:выбрать|нажать)|что\s+(?:мне\s+)?нажать)[?!.\s]*$/iu,
    );
  const lastikConflictIntent =
    conflictCovered && savedChoice !== mineChoice && !conflictingMine
      ? savedChoice
        ? 'saved'
        : 'mine'
      : null;
  const closing = [...ctx.current.matchAll(closeAction)].some(
    (match) => !negatedAt(ctx.current, match.index),
  );
  const opening = [
    ...ctx.current.matchAll(
      /откры(?:ть|вать)|открой(?:те)?|(?:выключ|отключ|отмен)(?:ить|и(?:те)?)/giu,
    ),
  ].some((match) => !negatedAt(ctx.current, match.index));
  const manualContext = /ручн|тишин/iu.test(ctx.current);
  const silenceOn = [
    ...ctx.current.matchAll(/(?:включ\p{L}*.{0,20}тишин|тишин\p{L}*\s+вкл)/giu),
  ].some((match) => !negatedAt(ctx.current, match.index));
  const silenceOff = /тишин\p{L}*\s+выкл/iu.test(ctx.current);
  const nightManualIntent =
    closing || (silenceOn && !opening)
      ? 'close'
      : (opening && manualContext) || silenceOff
        ? 'open'
        : null;
  const nightManualOnly =
    primaryIds[0] === 'night-manual' &&
    !state.publisherRequest &&
    !state.eraserRequest &&
    ![
      ...ctx.current.matchAll(
        /(?:установ|измен|созда|настро|включ|выключ|добав|постав|задать|отмен)\p{L}*.{0,40}расписан/giu,
      ),
    ].some((match) => !negatedAt(ctx.current, match.index)) &&
    only(['night-manual', 'night-permissions', 'night', 'settings', 'admin-commands', 'bots']) &&
    !groupEntry.test(ctx.current) &&
    !recurringClosure.test(ctx.current) &&
    !/закры(?:ть|вать)\s+(?:(?:чат|группу|его|ее)\s+)?не\s+(?:хочу|надо|нужно|буду)/iu.test(
      ctx.current,
    ) &&
    Boolean(nightManualIntent) &&
    reviewedTaskCovered(
      ctx.current,
      /закры(?:ть|вать)|закрой|закрывай|откр(?:ыть|ывать|ой|ывай)|тишин|(?:не\s+менять|остав|сохран).{0,30}расписан|расписан.{0,30}(?:остав|сохран)|админ\p{L}*.{0,40}писать/iu,
      /^(?:а\s+)?как\s+(?:это\s+)?(?:сделать|включить|выключить|убрать|отменить)(?:\s+и\s+(?:потом\s+)?(?:включить|выключить|убрать|отменить))?[?!.\s]*$/iu,
    );
  const publisherDeliveryOnly =
    state.publisherRequest &&
    primaryIds[0] === 'publisher-delivery-status' &&
    !/(?<![\p{L}])подключ(?:ить|ать|и(?:те)?|ай(?:те)?)(?![\p{L}])|(?:для|порядок|шаг\p{L}*|инструкц\p{L}*)\s+подключени|(?:как|где|хочу|нужно|надо|проверь).{0,30}(?:подключение|добавить\s+бота)/iu.test(
      ctx.current,
    ) &&
    only([
      'publisher-delivery-status',
      'publisher-post-targets',
      'publisher-post-create',
      'publik',
      'max-add-existing-bot-group',
      'max-add-bot-channel',
    ]) &&
    reviewedTaskCovered(
      ctx.current,
      /нужно\s+проверить|результат|достав|повтор\p{L}*.{0,25}(?:отправ|публиков)|(?:отправ|публиков).{0,25}(?:еще\s+раз|повтор|заново)|пост.{0,35}(?:вижу|не\s+появ|дошел)|провер\p{L}*.{0,20}(?:публикац|отправ|получател)/iu,
      /^(?:а\s+)?(?:можно\s+)?(?:повторить|как\s+проверить)[?!.\s]*$/iu,
      /^(?:проверить|перепроверить|убедиться|сверить|сопоставить|повторить|отправить|переотправить|жать|нажать|посмотреть|открыть|понять|узнать|выяснить|описать|передать|сообщить|написать|обратиться)$/u,
    );
  const aiObservationHandoffOnly = Boolean(
    state.commercialAi &&
    state.reviewedIntents.evidence &&
    state.aiIntents.includes('observation') &&
    only([
      'support-incident-evidence',
      'commercial-ai-observation',
      'commercial-ai-evidence',
      'commercial-ai-mode',
      'announcement-removal',
    ]) &&
    reviewedTaskCovered(
      ctx.current,
      /(?:что|какие|как|куда).{0,45}(?:оператор|разбор|данн|присл|переда|написать|описать)|(?:удал|исчез|пропал|наблюда|тест|без\s+автоматических\s+удалений)|событи.{0,30}(?:нет|не\s+вижу|не\s+открыва|недоступ)/iu,
    ),
  );
  const publisherConnectOnly =
    state.publisherRequest &&
    !state.publisherConnectionReady &&
    !/(?<![\p{L}])не\s+подкл|подкл\p{L}*\s+не\s+(?:нужно|надо)|отключ|отсоедин/iu.test(
      ctx.current,
    ) &&
    !state.eraserRequest &&
    !state.botDirectory &&
    primaryIds.includes('publik') &&
    only([
      'publik',
      'publisher-post-targets',
      'choose-moderator',
      'max-add-bot-channel',
      'max-add-existing-bot-group',
    ]) &&
    /подкл|получател.{0,20}(?:пуст|нет)|(?:пуст|нет).{0,20}получател/iu.test(ctx.current) &&
    !moderatorSwitchRequest(ctx.current) &&
    !/(?:как|хочу|нужно|надо).{0,25}выбрать.{0,15}модератор/iu.test(ctx.current) &&
    reviewedTaskCovered(
      ctx.current,
      /(?<![\p{L}])подключ(?:ить|ать|и(?:те)?|ай(?:те)?)(?![\p{L}])[^.!?\n]{0,35}(?:публик|чат|канал|групп)|(?:публик|чат|канал|групп)[^.!?\n]{0,35}(?<![\p{L}])подключ(?:ить|ать|и(?:те)?|ай(?:те)?)(?![\p{L}])|(?:спис|получател).{0,20}(?:пуст|нет)|выбрать.{0,25}публик.{0,35}ботах/iu,
      /^(?:(?:а|и)\s+)?(?:что|кого)\s+(?:(?:именно|надо|нужно)\s+)*подключить[?!.\s]*$/iu,
    );
  const lastikHistoryOnly =
    state.eraserRequest &&
    !state.publisherRequest &&
    retentionHistoryPattern.test(ctx.current) &&
    primaryIds.includes('message-retention') &&
    primaryIds.includes('lastik-exclusions') &&
    only(['message-retention', 'lastik-exclusions', 'lastik-connect', 'settings']) &&
    !/канал|подключить|переподкл|настро|сохран|помен|измен|выбрать.{0,20}срок|включ|запустить|запускать|активир|(?:как|хочу|нужно|надо).{0,20}запуск|выключ|останов|почему|ошиб|ожидан|прогресс|сколько.{0,15}(?:врем|ждать)/iu.test(
      ctx.current.replace(
        /(?:до|раньше)\s+(?:(?:его|их)\s+|того\s+как\s+(?:(?:его|их)\s+)?)?включ\p{L}*/giu,
        '',
      ),
    ) &&
    reviewedTaskCovered(
      ctx.current,
      /(?:удал|стира|сотр|стер|очист|добер|затрон).{0,60}(?:истори|переписк|сообщ)|(?:истори|переписк|сообщ).{0,60}(?:удал|стира|сотр|стер|очист|добер|затрон)|закреп.{0,40}(?:сним|сохра|защит|трог|удал)|(?:сним|трог|удал).{0,35}закреп|исключ.{0,35}(?:кого|какие|сохра|защит)/iu,
    );
  // FLAG: Retry plus archive scope is one covered composition. A second settings,
  // export or product task must retain inference even when its topic has no fact ID.
  const lastikRestartOnly =
    state.eraserRequest &&
    !state.publisherRequest &&
    !state.botDirectory &&
    lastikConnectionIntent(ctx, state, primaryIds) === 'restart' &&
    only([
      'lastik-permissions',
      'lastik-connect',
      'message-retention',
      'lastik-exclusions',
      'bots',
      'settings',
    ]) &&
    !/сетк|канал|помен|измен|настро|выбрать\s+срок|сохран\p{L}*.{0,20}настрой/iu.test(
      ctx.current,
    ) &&
    reviewedTaskCovered(
      ctx.current,
      /ожидан\p{L}*.{0,20}истек|отмен\p{L}*.{0,20}подключ|подключ\p{L}*.{0,20}отмен|запус|подключ|запрос|профил|провер|прав|админ|истори|переписк|сообщ|закреп|исключ/iu,
      /^(?:(?:а|и)\s+)?(?:(?:что|куда)\s+(?:дальше\s+)?(?:мне\s+)?нажать|как\s+(?:начать|запустить|повторить)\s+(?:снова|заново))[?!.\s]*$/iu,
      /^(?:проверить|включить|подключить|переподключить|запустить|повторить|дождаться|ждать|вернуться|открыть|нажать|сделать|удалить|почистить|очистить|очищаться|снимать|снять|читать)$/u,
    );
  const publisherDatesOnly =
    state.publisherRequest &&
    !state.eraserRequest &&
    !state.botDirectory &&
    primaryIds.includes('publisher-schedule-dates') &&
    only([
      'publisher-schedule-dates',
      'publisher-schedule-timezone',
      'publisher-drafts-history',
      'publik',
    ]) &&
    reviewedTaskCovered(
      ctx.current,
      /дат|числ|расписан|пост|анонс|чернов|врем|пояс|москв|телефон|поездк/iu,
      /^(?:(?:а|и)\s+)?(?:как|где)\s+(?:это\s+)?(?:выбрать|задать|указать|сохранить)[?!.\s]*$/iu,
      /^(?:выбрать|задать|поставить|запланировать|назначить|указать|добавить|настроить|проверить|сохранить|соотнести|попасть|промахнуться|ошибиться|выйти|повторять)$/u,
    );
  // FLAG: Waiting plus archive/edit scope is covered only as an explanation. Rights
  // checks, settings changes and independent tasks must keep their inference path.
  const lastikWaitingHistoryOnly =
    state.eraserRequest &&
    !state.publisherRequest &&
    !state.botDirectory &&
    !state.botCatalogRequest &&
    !moderatorName.test(ctx.current) &&
    !actionRequest.test(
      ctx.current.replace(
        /(?<![\p{L}])(?:подскаж\p{L}*|расскаж(?:и|ите)|объясни(?:те)?)(?![\p{L}])/giu,
        '',
      ),
    ) &&
    lastikConnectionIntent(ctx, state, primaryIds) === 'waiting' &&
    (retentionHistoryPattern.test(ctx.current) || individualRetentionQuestion(ctx.current)) &&
    ['lastik-connect', 'message-retention', 'lastik-exclusions'].every((id) =>
      primaryIds.includes(id),
    ) &&
    only([
      'lastik-connect',
      'message-retention',
      'lastik-exclusions',
      'settings',
      'announcement-removal',
    ]) &&
    !/сетк|канал|прогресс|счетчик|подробност|тариф|стоимост|цен|настрой|сохран|выключ|отключ|останов|отмен|восстанов|вернуть(?!ся)|почему|(?:помен|измен|выбра|выбери|смен).{0,20}(?:срок|прав)|(?:как|где|какие).{0,30}(?:провер\p{L}*\s+прав|дать\s+прав|назнач\p{L}*\s+прав)|(?:провер\p{L}*|дать|выдать)\s+(?:(?:мои|свои|его|ее|боту|ластику)\s+)?права/iu.test(
      ctx.current,
    ) &&
    reviewedTaskCovered(
      ctx.current,
      /подкл|ожидан|жд(?:у|ать|ем)|молч|ни слова|старт|мини-прилож|вернуться|(?<![\p{L}])(?:минут|час)|истори|переписк|сообщ|закреп|исключ|редакт|правк|исправ|убер|удал/iu,
      /^(?:(?:а|и)\s+)?(?:что\s+(?:мне\s+)?делать|(?:это\s+)?нормально)[?!.\s]*$/iu,
      /^(?:подключиться|подключаться|подключить|переподключить|повторить|ждать|дождаться|вернуться|возвращаться|открыть|нажать|жать|писать|сделать|удалить|почистить|очистить|очищаться|снимать|снять)$/u,
    );
  let lastikRetentionHours = null;
  // FLAG: Only user reports can supply a selected period. A conflicting current
  // report stays ambiguous instead of falling back to an older or assistant value.
  const retentionReports = [];
  let reportProduct = null;
  for (const item of ctx.recent.filter((turn) => turn.role === 'user')) {
    reportProduct = productOf(item.text) ?? reportProduct;
    if (reportProduct === 'eraser') retentionReports.push(item.text);
  }
  for (const value of [ctx.current, ...retentionReports.reverse()]) {
    if (!/срок|выбра|ставил|поставил|ластик\p{L}*\s+на/iu.test(value)) continue;
    const periods = new Set(
      [
        ...value.matchAll(
          /(?<!\d)((?:24|48|168)(?:\s*(?:или|и|,|\/)\s*(?:24|48|168))*)\s*час\p{L}*(?![\p{L}])|(?<![\p{L}])(?:1|одну)\s+недел\p{L}*/giu,
        ),
      ].flatMap((match) => (match[1] ? match[1].match(/\d+/gu).map(Number) : [168])),
    );
    if (!periods.size) continue;
    if (periods.size === 1) lastikRetentionHours = [...periods][0];
    break;
  }
  return {
    lastikConflictIntent,
    nightManualOnly,
    nightManualIntent,
    publisherDeliveryOnly,
    aiObservationHandoffOnly,
    publisherConnectOnly,
    lastikHistoryOnly,
    lastikRestartOnly,
    lastikRestartHistory: lastikRestartOnly && retentionHistoryPattern.test(ctx.current),
    lastikWaitingHistoryOnly,
    lastikRetentionHours,
    individualRetentionQuestion: state.eraserRequest && individualRetentionQuestion(ctx.current),
    publisherDatesOnly,
    publisherDatesTimezone:
      publisherDatesOnly &&
      /пояс|москв|московск|врем.{0,20}телефон|телефон.{0,30}врем/iu.test(ctx.current),
  };
}

function atomicLastikSetup(ctx, state) {
  if (
    !state.eraserRequest ||
    state.publisherRequest ||
    state.botDirectory ||
    state.botCatalogRequest ||
    lastikConnectionIntent(ctx, state, ['lastik-connect']) !== 'setup' ||
    topics(ctx.current).some((topic) => topic !== 'retention') ||
    /истори|прогресс|закреп|исключ|розыгрыш|восстанов|вернуть(?!ся)|останов|отключ|выключ|пауз|отмен|истек|почему|зачем|не удаля|снес|исчез|пропал|месяц|год|сетк|канал|разрешени|участник/iu.test(
      ctx.current,
    )
  )
    return false;
  return ctx.current
    .split(/[.!?;\n]+/u)
    .filter((part) => part.trim())
    .every((part) =>
      /подкл|админ|владел|права|перв|(?:24|48)\s*час|недел|выбрать\s+срок|вернуться|возвращ|заходить.{0,25}(?:прилож|назад)/iu.test(
        part,
      ),
    );
}

function linkPolicyIntent(ctx, state, primaryIds) {
  if (!state.eligible || !primaryIds.includes('links-policy')) return null;
  const detect = (value) => {
    if (/по списку|разрешенн\p{L}*\s+домен/iu.test(value)) return 'inspect';
    const candidates = [];
    for (const [intent, pattern] of [
      [
        'allow',
        /(?:отключ|выключ|убра|сня|сним|отмен)\p{L}*.{0,35}(?:фильтр|удален|запрет|блокиров)|разреш(?:ить|и(?:те)?|ать)\s+(?:(?:любые|все)\s+)?ссылк|не\s+(?:запрещать|удалять)\s+(?:(?:любые|все)\s+)?ссылк/giu,
      ],
      [
        'block',
        /(?:запрет|запрещ)\p{L}*.{0,25}ссылк|(?:удаля|блокир)\p{L}*.{0,20}(?:все|любые)\s+ссылк|не\s+разрешать\s+(?:(?:любые|все)\s+)?ссылк/giu,
      ],
    ])
      for (const match of value.matchAll(pattern)) {
        const reported =
          /(?:выбрал[аи]?|выбрали|установил[аи]?|стоит|включил[аи]?|поставил[аи]?|выбран\p{L}*)\s*(?:режим\s*)?[«"„]?\s*$/iu.test(
            value.slice(0, match.index),
          ) ||
          /^(?:отключил|выключил|убрал|снял|снимал|отменил|запретил|запрещал|удалял|блокировал)[аи]?(?![\p{L}])/iu.test(
            match[0],
          );
        candidates.push({
          intent,
          index: match.index,
          end: match.index + match[0].length,
          requested: !reported && !negatedAt(value, match.index),
        });
      }
    const independent = candidates.filter(
      (item) =>
        item.requested &&
        !candidates.some((other) => other.index < item.index && other.end > item.index),
    );
    if (independent.length) return independent.sort((a, b) => b.index - a.index)[0].intent;
    if (/провер|режим|оставля|пропуска|не\s+удаля|почему|как.{0,15}работ/iu.test(value))
      return 'inspect';
    return candidates.length ? 'inspect' : null;
  };
  const current = detect(ctx.current);
  if (current) return current;
  for (const item of ctx.recent.filter((turn) => turn.role === 'user').reverse()) {
    const intent = detect(item.text);
    if (intent) return intent;
  }
  return 'inspect';
}

function nightSources(ctx, role) {
  const relevant = (text) => nightTopic.test(text);
  if (!relevant(ctx.focus)) return [];
  const detect = (text) => {
    const result = [];
    if (
      /(?:кто|кому|админ\p{L}*|администратор\p{L}*|участник\p{L}*).{0,60}(?:писать|пиш|напис|пост|сообщен)|(?:писать|пиш|пост|сообщен).{0,45}(?:админ|участник)/iu.test(
        text,
      ) ||
      (role === 'admin' && /(?:мой|мое|мои).{0,12}(?:пост|сообщен)/iu.test(text))
    )
      result.push('night-permissions');
    if (
      /ручн.{0,20}(?:закр[ыо]|откр)|(?:закр[ыо]|откр).{0,20}ручн|команд.{0,20}тишин|тишина\s+(?:вкл|выкл)|закр[ыо].{0,65}(?:сейчас|без срока|до\s+(?:(?:моего|своего)\s+)?решения)|(?:прямо\s+)?сейчас.{0,65}закр[ыо]|(?<![\p{L}])(?:закрой|закрывай)(?:те)?(?![\p{L}])/iu.test(
        text,
      ) ||
      (/тишин/iu.test(text) && !/расписан|кажд.{0,8}ноч/iu.test(text))
    )
      result.push('night-manual');
    if (
      recurringClosure.test(text) ||
      /расписан|часов.{0,10}пояс|закрывать с|открывать в|(?:с|до)\s+\d{1,2}(?::\d{2})?|(?:включ|настро|выключ|отключ).{0,30}ночн|ночн.{0,30}(?:включ|настро|выключ|отключ)/iu.test(
        text,
      )
    )
      result.push('night');
    // FLAG: A direct closing question without a schedule asks for manual controls.
    // Group/chat synonyms must select the same procedure without widening human conversation.
    if (
      chatClosure.test(text) &&
      !result.includes('night') &&
      !result.includes('night-manual') &&
      ([...text.matchAll(closeAction)].some((match) => !negatedAt(text, match.index)) ||
        correspondenceClosure.test(text))
    )
      result.push('night-manual');
    return result;
  };
  const current = detect(ctx.current);
  if (current.length) return current;
  for (const item of ctx.recent.filter((item) => item.role === 'user').reverse()) {
    if (!relevant(item.text)) continue;
    const found = detect(item.text);
    if (found.length) return found;
  }
  return ['night'];
}

function commercialIntents(current, focus) {
  if (!commercialPattern.test(focus)) return [];
  const probe =
    commercialPattern.test(current) || topics(current).length ? current : `${focus}\n${current}`;
  const intents = [];
  const observationCorrected =
    /не\s+(?:в\s+)?(?:режим\p{L}*\s+)?[«"„]?тест|(?:тест|наблюдени).{0,25}(?:заверш|законч|отключ|выключ)|(?:автоматическ\p{L}*\s+)?удалени\p{L}*\s+(?:уже\s+)?включ|теперь.{0,12}(?:есть|включен).{0,20}автоматическ.{0,15}удал/iu.test(
      current,
    );
  if (/изображ|картин|фото|\bocr\b/iu.test(current)) intents.push('images');
  if (/чувствительн|строго|мягко|мягче|строже|баланс/iu.test(probe)) intents.push('sensitivity');
  if (/переключ|смен.{0,12}режим|обратно.{0,15}текстов|перейти.{0,70}текстов/iu.test(current))
    intents.push('switch-mode');
  if (/предупрежден|наказан|санкци|лестниц|мут|бан(?:ить|ил|а|ов)?(?![\p{L}])/iu.test(current))
    intents.push('sanctions');
  if (
    !observationCorrected &&
    /наблюда|наблюдени|ии[\s-]*анализ|без автоматических удалений|(?:^|[^\p{L}])тест(?:$|[^\p{L}])/iu.test(
      `${probe}\n${/удал|исчез|пропал|оператор|разбор|событи/iu.test(current) ? focus : ''}`,
    )
  )
    intents.push('observation');
  if (/двойн.{0,6}проверк|дважды/iu.test(current)) intents.push('double-check');
  if (/модел[ьиь]|модель|помощнее/iu.test(current)) intents.push('model');
  if (/занят|недоступ|сбо[ийя]|не работа/iu.test(current)) intents.push('availability');
  if (
    /доказ|подтверд.{0,30}(?:удал|именно)|вчера|конкретн.{0,15}(?:сообщен|удален)|виноват|почему.{0,70}(?:удал|исчез)|(?:исчез|удал|пропал).{0,60}(?:точно|значит|почему|что проверить)|(?:точно|значит).{0,60}(?:исчез|удал|пропал)/iu.test(
      current,
    )
  )
    intents.push('evidence');
  if (
    /(?:как|чтобы).{0,35}(?:включ|заработ)|что.{0,12}включить|где.{0,15}включ/iu.test(current) &&
    !/включ.{0,20}(?:ночн|стоп|антимат|ссылк|подписк|защит|автоответ|уведомлен)/iu.test(current)
  )
    intents.push('enable');
  return intents;
}
function commercialIntent(current, focus, intents) {
  if (!commercialPattern.test(focus)) return null;
  if (['publisher', 'eraser'].includes(productOf(current)) && !commercialPattern.test(current))
    return null;
  return intents.length === 1 &&
    !/в одном.{0,100}в другом|сравни|одноврем|и.{0,10}модель/iu.test(current)
    ? intents[0]
    : 'general';
}

function semanticFacts(text, state) {
  const facts = [];
  const add = (id, priority = 50) => facts.push({ id, priority });
  const { publisherRequest: publ, developer, commercialAi, mixedTopics } = state;
  const test = (pattern) => pattern.test(text);
  if (supportAssistantRequest(state.current, state.recent)) {
    add('support-assistant-capabilities', 170);
  }
  if (state.supportDialogue && !facts.length) return [{ id: 'support-dialogue', priority: 160 }];
  if (state.moderatorTroubleshooting) {
    add('max-delete-rights', 200);
    add('connect', 195);
  }
  if (platformUpdates(text))
    add(developer ? 'max-recent-api-changes' : 'max-platform-updates', 160);
  if (
    test(/(?:что|какие).{0,35}(?:умеет|возможност|модули|функци)|обзор.{0,15}(?:проект|модул)/iu) &&
    test(/майор|проект|все.{0,10}модул|какие есть модули/iu)
  )
    add('project-modules', 125);
  if (test(/номера?\s+телефон|телефонн.{0,8}номер|(?:разреш|запрет|удал).{0,15}телефон/iu))
    add('phone-numbers', 115);
  if (test(/доступ за приглаш|сколько.{0,15}пригласить|приглас\p{L}*.{0,15}(?:участник|друз)/iu))
    add('invitation-access', 115);
  if (
    test(
      /сообщения и боты|других ботов|(?:боты|ботов).{0,40}(?:скидыва|присыла|спам|реклам)|(?:защит|от).{0,20}ботов/iu,
    ) ||
    (test(/бот|модератор|майор|рэкс/iu) &&
      test(/(?:сво\p{L}*|собственн\p{L}*).{0,12}(?:сообщен|ответ)/iu))
  )
    add('service-messages-and-bots', 115);
  if (
    test(/антидубл|одинаков.{0,15}(?:картин|фото)|повтор.{0,15}(?:картин|фото)/iu) &&
    test(/картин|фото/iu)
  )
    add('duplicates-photo', 120);
  if (
    test(
      /голосов|аудио|войс|пересыл|переслан|тип.{0,10}(?:сообщен|вложен)|запрет.{0,15}(?:видео|файл|фото|стикер)/iu,
    ) &&
    test(/запрет|разреш|огранич|закрыть|выключ|отключ|тип.{0,10}(?:сообщен|вложен)/iu)
  )
    add('limits-attachments', 115);
  if (
    test(/проверить сообщение/iu) ||
    (test(/реклам|коммерческ|разов.{0,15}продаж/iu) &&
      test(
        /провер.{0,60}(?:пример|посчитает|считается|сочтет|без удал)|(?:пример|сообщени).{0,35}проверить/iu,
      ))
  )
    add('commercial-message-preview', 155);
  if (test(/жалоб/iu) && test(/истори|24 часа|меры|огранич|результат|журнал|отклон/iu))
    add('reports-outcomes', 120);
  if (test(/карточк.{0,15}участник|список участников|поиск.{0,12}участник|найти.{0,15}участник/iu))
    add('participants', 105);
  if (
    test(
      /без сообщений|(?:временно|на время|срок|участник|ему).{0,25}(?:запретить(?: ему)? писать|ограничить сообщен)|(?:оставить|остался).{0,35}(?:писать|сообщен)/iu,
    )
  )
    add('participant-mute', 120);
  if (
    test(
      /сня(?:ть|тие).{0,15}(?:бан|блокиров|огранич|в max)|разблокир|разбан|действующ.{0,15}огранич|истори.{0,15}(?:санкц|огранич)|архив.{0,15}огранич/iu,
    )
  )
    add('sanction-history', 115);
  if (test(/баз.{0,8}спам|(?<![\p{L}])не спам(?![\p{L}])|подтверд\p{L}*\s+спам(?![\p{L}])/iu))
    add('spammer-review', 125);
  if (
    test(/статистик|прирост|сводк.{0,20}(?:групп|чат)|баланс.{0,15}(?:вход|выход)/iu) &&
    !test(/сетк|избранн|категори/iu)
  )
    add('chat-statistics', 105);
  if (
    test(
      /по журналу|журнал.{0,15}(?:удален|модерац)|(?:где|как).{0,25}(?:посмотреть|найти).{0,15}(?:событи|журнал)|вход.{0,10}выход/iu,
    )
  )
    add('chat-events', 150);
  if (test(/(?<![\p{L}])опрос\p{L}*/iu)) {
    add('poll-create', 90);
    if (
      test(
        /аноним|имена|кто.{0,15}(?:голос|увид)|голосова|голос|заверш|закрыть|изменить.{0,12}(?:вопрос|вариант)/iu,
      )
    )
      add('poll-voting', 125);
    if (test(/проверк|завис|публикуется|заново|повтор|не (?:появ|обнов|опубликов)|черновики/iu))
      add('poll-recovery', 130);
  }
  if (
    test(/розыгрыш|розыграш|конкурс|призов.{0,8}мест/iu) &&
    (!state.eraserRequest || test(/созда|запуст|организ|участв|выбрать победител/iu))
  ) {
    add('giveaway-create', 90);
    if (test(/участв|заявк|допуск|подпис|выигрыш|(?:я|мне).{0,15}(?:побед|приз)/iu))
      add('giveaway-participation', 140);
    if (test(/итог|победител|выдач|выдан|забрал|подтвержден|завершить/iu))
      add('giveaway-results', 120);
  }
  if (test(/быстр.{0,8}кноп/iu)) add('channel-quick-buttons', 125);
  if (
    test(
      /действие под публикац|(?:постоянн|кажд).{0,25}(?:кноп|подпис)|(?:кноп|подпис|ссылк).{0,25}(?:кажд|публикац|под пост)/iu,
    ) &&
    test(/канал|действие под публикац/iu)
  )
    add('channel-post-action', 120);
  if (
    test(
      /предложк|предложения|прием.{0,15}предлож|предложить.{0,20}(?:запись|пост|объяв)|(?:запись|пост|объяв).{0,20}предложить|(?:читател|подписчик).{0,40}(?:присылать|отправлять|прислать).{0,20}(?:материал|запис|пост)|при[её]м\s+материал/iu,
    )
  )
    add(
      publisherName.test(state.focus) ? 'publisher-suggestions-entry' : 'channel-suggestions-entry',
      130,
    );
  if (
    test(
      /(?:участник|человек).{0,30}(?:вышел|выход|покинул)|(?:уход|выход).{0,20}(?:участник|человек)/iu,
    ) &&
    test(/оповест|уведом|сообщить|писал.{0,15}(?:об этом|остальн)/iu)
  )
    add('membership-leave-notifications', 135);
  if (
    !state.reviewedIntents.evidence &&
    test(
      /(?:нет доступа|не (?:вижу|могу|открыва)|недоступ).{0,30}(?:журнал|событи)|(?:журнал|событи).{0,25}(?:нет|не вижу|недоступ|не открыва)/iu,
    )
  )
    add('community-access', 135);
  if (
    test(
      /срок входа[^.!?\n]{0,40}истек|нужно открыть приложение заново|мини.?приложен.{0,30}(?:вход|открыть заново)|настройки.{0,20}не загружа|(?:нет доступа|недоступ|не могу открыть).{0,25}настройк/iu,
    )
  )
    add('miniapp-relaunch', 120);
  if (state.reviewedIntents.eligibility) add('max-public-channel-eligibility', 140);
  if (state.reviewedIntents.evidence) add('support-incident-evidence', 140);
  if (commercialAi) {
    add(
      commercialAi === 'sanctions'
        ? 'commercial-sanctions'
        : commercialAi === 'images'
          ? 'image-text-versus-commercial'
          : `commercial-ai-${commercialAi}`,
      110,
    );
    if (commercialAi === 'general')
      for (const intent of state.aiIntents)
        add(
          intent === 'sanctions'
            ? 'commercial-sanctions'
            : intent === 'images'
              ? 'image-text-versus-commercial'
              : `commercial-ai-${intent}`,
          110,
        );
    add('commercial-ai-mode', 85);
    if (commercialAi === 'availability' || state.aiIntents.includes('availability'))
      add('commercial-ai-double-check', 105);
    if (test(/изображ|картин|фото|\bocr\b/iu)) add('image-text-versus-commercial', 105);
    if (commercialAi === 'general' && test(/объяснен|предупрежден|наказан|санкци|нарушен/iu))
      add('commercial-sanctions', 95);
    if (
      commercialAi === 'general' &&
      test(/в одном.{0,100}в другом|текстов.{0,10}(?:правил|режим|фильтр)/iu)
    )
      add('commercial-text-filter', 90);
  }
  if (
    developer &&
    test(/\/chats\/[^\s]*members|добав.{0,20}(?:участник|подписчик)|метод.{0,30}подписчик/iu)
  )
    add('max-members-api-limits', 120);
  if (
    developer &&
    (test(/\bnotify\b/iu) ||
      (test(/отправ|редактир|\b(?:post|put)\b/iu) && test(/уведомлен|пуш|\bpush\b|тих/iu)))
  )
    add('max-api-message-notifications', 150);
  if (developer && test(/редактир|\bput\b|чуж.{0,12}(?:сообщен|пост)/iu))
    add('max-message-edit-scope', 115);
  if (developer && test(/изменени|changelog|webhook|longpoll|platform-api|\bget\s+\/chats/iu))
    add('max-recent-api-changes', 110);
  if (developer && test(/загруз|uploads|размер|медиа|мб|гб/iu)) add('max-media-api-limits', 105);
  if (
    test(
      /(?:созда|регистрац).{0,35}(?:сво|собственн).{0,20}бот|сво.{0,12}бот.{0,30}(?:созда|модерац)|профил.{0,20}(?:самозанят|организац)/iu,
    )
  )
    add('max-own-bot-creation', 105);
  if (
    test(
      /(?:ник|никнейм|переимен|владельц|владение).{0,30}бот|бот.{0,30}(?:ник|переимен|передать)|токен|парол|код вход|компрометац/iu,
    )
  )
    add('max-bot-token-and-ownership', 105);
  if (
    test(
      /(?:созда|сдела|откр).{0,25}(?:публичн|обычн|бизнес).{0,15}канал|channel_|цифров.{0,5}id|а\+|бизнес.{0,8}канал/iu,
    )
  )
    add(
      test(/бизнес|самозанят|юрлиц|организац|\bип\b/iu) && !test(/обычн|channel_|цифров/iu)
        ? 'max-create-business-channel'
        : 'max-create-public-channel',
      105,
    );
  if (test(/официальн.{0,15}(?:реклам|продвиж)|vk реклам|рекламн.{0,10}кабинет.{0,15}max/iu))
    add('max-platform-advertising', 105);
  if (test(/массов.{0,10}сбой|у всех.{0,35}(?:max|бот)|max.{0,20}(?:массов|сломал)/iu))
    add('max-business-support', 100);
  if (test(/мини.{0,3}прилож/iu)) {
    add(
      test(/одноврем|два|несколько|друг друга|втор/iu)
        ? 'max-miniapp-one-at-time'
        : test(/поделиться|компьютер|desktop|десктоп|камера|микрофон|android|ios/iu)
          ? 'max-miniapp-platform-differences'
          : 'max-miniapp-basics',
      80,
    );
  }
  if (
    test(
      /стандартн.{0,15}команд|команд.{0,15}по умолчанию|старт.{0,15}все.{0,10}бот|(?:любого|всех).{0,15}бот.{0,15}(?:общая|команд)/iu,
    )
  )
    add('max-platform-default-commands', 105);
  const reportedConnectionReady =
    reportedPublisherReady(state.current, publ) || reportedPublisherReady(state.focus, publ);
  const editorPlacement =
    publ &&
    test(
      /(?:постав|добав)\p{L}*[^.!?\n]{0,30}(?:в|через)\s+публик\p{L}*[^.!?\n]{0,35}(?:пост|публикац|анонс|расписан)/iu,
    );
  const connectionRequested =
    !reportedConnectionReady &&
    (moderatorForwardingRequest(state.current) ||
      test(/подкл[юу]ч|подклюить|(?:бот|майор).{0,20}добавлен.{0,10}участник/iu) ||
      (!editorPlacement && test(/(?:постав|добав).{0,25}(?:майор|рэкс|публик|готов.{0,10}бот)/iu)));
  const otherBotConnection = test(
    /(?:подкл[юу]ч\p{L}*|добав\p{L}*|постав\p{L}*)\s+(?:(?:еще|также|отдельно)\s+)?(?:публик|майор|рэкс|модератор)|(?:публик|майор|рэкс|модератор)\p{L}*\s+(?:подкл[юу]ч|добав|постав)|ластик(?:а|у|ом|е)?[»"]?\s*(?:,?\s+и|,\s*а\s+также)\s+(?:публик|майор|рэкс|модератор)/iu,
  );
  const connecting =
    connectionRequested && (!(state.eraserRequest || eraserName.test(text)) || otherBotConnection);
  const connectingPublisher = publ || (publisherName.test(text) && otherBotConnection);
  if (connecting) {
    // FLAG: Publisher onboarding has its own UI. Moderator-only controls must not
    // become its instructions merely because the question mentions an existing Major chat.
    const moderatorConnection =
      !connectingPublisher ||
      moderatorForwardingRequest(state.current) ||
      [
        ...state.current.matchAll(
          /подключ(?:ить|ать|и(?:те)?|ай(?:те)?)(?![\p{L}])[^.!?,;\n]{0,35}(?:майор|модератор|рэкс)|(?:майор|модератор|рэкс)\p{L}*[^.!?,;\n]{0,25}подключ(?:ить|ать|и(?:те)?|ай(?:те)?)(?![\p{L}])/giu,
        ),
      ].some(
        (match) =>
          !negatedAt(state.current, match.index) &&
          !negatedAt(state.current, match.index + match[0].search(/подключ/iu)) &&
          !/^\s+не\s+(?:нужно|надо|хочу|буду)/iu.test(
            state.current.slice(match.index + match[0].length),
          ),
      );
    if (moderatorConnection) add('connect', 90);
    add(test(/канал/iu) ? 'max-add-bot-channel' : 'max-add-existing-bot-group', 70);
    if (test(/модерац|участник|спам|удал/iu)) add('max-delete-rights', 75);
  }
  if (
    test(
      /(?:нельзя|не могу|запрет).{0,20}добав.{0,15}(?:групп|бот)|бот.{0,30}нельзя добавить|добав.{0,20}групп.{0,20}бот/iu,
    )
  )
    add('max-add-existing-bot-group', 100);
  if (
    test(
      /(?:добав|назнач|сдела).{0,25}(?:бот|майор|рэкс).{0,25}админ|(?:бот|майор|рэкс).{0,30}(?:добав|назнач|сдела).{0,15}админ|(?:добав|назнач).{0,15}бот.{0,15}(?:канал|групп)/iu,
    )
  )
    add(test(/канал/iu) ? 'max-add-bot-channel' : 'max-add-existing-bot-group', 100);
  const missingCommunity = test(
    /(?:нет|не вид|не нахож|пропал|не появ|исчез).{0,25}(?:чат|канал|получател|спис|доступ)|(?:чат|канал).{0,25}(?:не вид|пропал|не появ)|нет доступа|(?:прав.{0,15}(?:вернул|забрал|снял)|(?:вернул|забрал|снял).{0,15}прав)|обновить.{0,15}(?:доступ|спис)|потеряли.{0,20}(?:три|чат|групп)|(?:в|у)\s+публик.{0,12}нет/iu,
  );
  if (missingCommunity) add('community-access', 95);
  if (
    !publ &&
    !state.eraserRequest &&
    !developer &&
    test(/бот|майор|максимов|модератор|рэкс/iu) &&
    test(
      /(?:не\s+(?:удаляет|удаляют|чистит)|перестал\p{L}*\s+удалять|пропуска\p{L}*).{0,35}(?:ссылк|спам)|(?:ссылк|спам).{0,35}(?:пропуска|перестал)/iu,
    )
  ) {
    add('max-delete-rights', 90);
    add('community-access', 85);
  }
  // FLAG: A recipient picker cannot onboard a community; preserve the separate Publik connection procedure.
  if (connectingPublisher && (connecting || missingCommunity)) add('publik', 120);
  const switchingModerator = moderatorSwitchRequest(state.current);
  if (
    switchingModerator ||
    state.reserveHandoff ||
    test(
      /бот[ыа] (?:чата|канала)|(?:смен|выб(?:рать|ери|ерите|ирать|ор)(?![\p{L}])).{0,25}(?:модератор|бот|майор|рэкс|максимов)|ответ о смене|список изменил|кто.{0,25}выбран|где выбрать его|вместо нынешн/iu,
    )
  )
    add('choose-moderator', switchingModerator ? 150 : 105);
  if (switchingModerator || state.reserveHandoff) add('bots', 120);
  if (
    test(
      /(?<![\p{L}])прав(?:а|о|ами|ам|ах|у)?(?![\p{L}]).{0,35}(?:удал|спам|чтен|модерац)|(?:может|можно)\s+(?:(?:бот(?:у)?|майор(?:у)?)\s+)?удал|удал.{0,20}(?:чуж|личн)|читать.{0,15}удал|(?:удал|спам|модерац).{0,40}(?<![\p{L}])прав(?:а|о|ами|ам|ах|у)?(?![\p{L}])|админом не делал/iu,
    )
  )
    add('max-delete-rights', 95);
  if (
    !state.lastikWaitingOnly &&
    (!commercialAi || mixedTopics) &&
    state.nightSources.length > 0 &&
    !test(/не.{0,8}про.{0,15}(?:ночн|закрыт)/iu)
  ) {
    for (const id of state.nightSources) add(id, id === 'night-manual' ? 115 : 105);
    if (test(/ручн|команд|тишин/iu)) add('admin-commands', 75);
  }
  if (
    test(/антидубл/iu) ||
    (!publ && test(/дубл|дословн.{0,15}повтор|повтор.{0,20}(?:текст|подпис|сообщени)/iu))
  )
    add('duplicates', 100);
  if (test(/антимат|(?<![\p{L}])мат(?![\p{L}])|мата|оскорблен|бытов.{0,15}(?:руг|обзыв)/iu))
    add('profanity-sensitivity', 100);
  if (
    test(
      /стоп слов|стоп[- ]?(?:спис|лист)|запрещенн.{0,10}фраз|(?:запрет|удал|блокир)\p{L}*.{0,30}(?:конкретн|определенн|заданн|любое|это|нужн)\p{L}*.{0,15}(?:слов|фраз)|(?:слов|фраз).{0,35}(?:запрет|удалять|блокир)/iu,
    )
  )
    add('stop-words', 125);
  // FLAG: Answer-format preferences must not become image-filter questions.
  const imageComparisonText = text.replace(
    /(?<![\p{L}])только\s+(?:текстом|словами)(?:\s*,?\s*без\s+(?:картинок|фото|изображений|карточек|скриншотов))?(?![\p{L}])/giu,
    ' ',
  );
  if (
    /(?:текст|провер|стоп слов|реклам).{0,25}(?:изображ|картин|фото)|(?:изображ|картин|фото).{0,25}(?:текст|реклам)|\bocr\b/iu.test(
      imageComparisonText,
    ) &&
    (!publ || /стоп слов|реклам|\bocr\b/iu.test(imageComparisonText))
  )
    add('image-text-versus-commercial', 105);
  const explicitLinkFilter = test(
    /фильтр.{0,12}ссылк|ссылк.{0,12}фильтр|(?:запрет|разреш).{0,15}ссылк|ссылк.{0,15}(?:запрет|разреш)|разрешенн.{0,12}домен|allowlist|whitelist/iu,
  );
  const profileRequested = botProfileRequest(text);
  const answerLinkInstruction = test(
    /(?:встав|добав|включ|укаж|напиш|привед|прилож).{0,25}(?:в|к)\s+(?:сво[йе]\s+)?ответ.{0,30}ссылк|ссылк.{0,30}(?:в|к)\s+(?:сво[йе]\s+)?ответ/iu,
  );
  const offeredCommunityLink =
    advert.test(state.current) &&
    /ссылк\p{L}*\s+на\s+(?:(?:эту|ту|нужную|районную)\s+)?(?:групп|чат|канал)/iu.test(
      state.current,
    );
  if (profileRequested) add('bots', 145);
  if (moderatorName.test(text) && test(/резерв|в запас/iu)) add('bots', 120);
  if (
    (test(/домен|allowlist|whitelist/iu) ||
      (!answerLinkInstruction && !offeredCommunityLink && test(/(?<![\p{L}])ссылк/iu)) ||
      explicitLinkFilter) &&
    ((!publ &&
      !profileRequested &&
      !state.botDirectory &&
      !/подписк|источник|созда.{0,12}канал/iu.test(state.focus)) ||
      explicitLinkFilter)
  )
    add('links-policy', 90);
  if (test(subscriptionPattern) && !test(/предложк|предложенн|прием.{0,12}предлож/iu)) {
    if (!['membership', 'participation'].includes(state.subscriptionIntent))
      add('subscription', 95);
    if (['membership', 'mixed'].includes(state.subscriptionIntent))
      add('subscription-membership', 130);
    if (state.subscriptionIntent === 'participation') add('subscription-participant', 110);
  }
  if (test(topicPatterns.find(([id]) => id === 'rules')[1])) add('chat-rules', 110);
  const advertiserException =
    advert.test(text) &&
    !developer &&
    /договоренност|спонсор|рекламодател|исключени|(?:разреш|пропуска)\p{L}*.{0,35}(?:определенн|конкретн|одн)\p{L}*.{0,15}(?:участник|человек)/iu.test(
      text,
    ) &&
    !publisherName.test(text) &&
    !isPublisherTask(text);
  if (advertiserException && state.role !== 'member') {
    add('participant-protection', 155);
    add('participants', 95);
  } else if (test(/защит[ауые]|иммунитет/iu)) add('participant-protection', 100);
  if (test(/команд|мут 88|бан!|тишина выкл/iu) && !developer) add('admin-commands', 90);
  if (
    test(
      /запрет.{0,12}писать|заблокир|разблокир|ручн.{0,15}(?:бан|огранич)|мут|бан(?:$|[^\p{L}])/iu,
    ) &&
    !commercialAi
  )
    add('sanctions', 80);
  if (
    test(
      /систем.{0,10}жалоб|жалоб.{0,30}(?:голос|порог|команд)|(?:отправ|подать).{0,15}жалоб|(?:пожалова|жаловаться).{0,25}(?:пост|сообщен)|\breport\b/iu,
    )
  )
    add('community-reports', 100);
  if (
    (state.eraserRequest ||
      ((!publ || mixedTopics) && (eraserName.test(text) || eraserTask.test(text)))) &&
    (!state.botDirectory ||
      eraserTask.test(state.current) ||
      (eraserName.test(state.current) &&
        /(?<![\p{L}])(?:как|почему|когда)(?![\p{L}])|хран|срок|подкл|удаля|проверить/iu.test(
          state.current,
        )))
  ) {
    add('message-retention', 110);
    const connecting =
      state.lastikWaitingOnly ||
      test(
        /подкл[юу]ч|добав|назнач|начать|запуст|активир|включ(?:ить|и(?:те)?|ай(?:те)?|ать|ают|аем|ает)(?![\p{L}])/iu,
      ) ||
      test(/(?:как|для|порядок|шаги).{0,25}включени/iu);
    if (connecting || test(/канал|какому.{0,15}бот/iu)) add('lastik-connect', 135);
    if (
      !state.lastikWaitingOnly &&
      (test(/переподключ|снят|вернул|потерял|не админ|нет доступа|нужны права|проверить права/iu) ||
        test(lastikConnectionRecovery) ||
        (!connecting && test(/прав[ао]|правам|правами/iu)))
    )
      add('lastik-permissions', 140);
    const partialDiagnostics = test(
      /ожидают.{0,8}не менее|(?:сч[её]тчик|количеств|числ).{0,20}не менее|результат(?: удаления)? не подтвержд|не подтвержд[её]н результат(?: удаления)?|истори.{0,20}ещ[её] не провер|последн.{0,15}полн.{0,15}обход|неопредел[её]н.{0,15}результат/iu,
    );
    if (
      !state.lastikWaitingOnly &&
      (partialDiagnostics ||
        test(
          /прогресс|сколько.{0,20}(?:удал|обработ|остал|очищ)|статус|проверена|подробности|счетчик|числа|постепенн|очеред|завис|не удаля|не чист|остал/iu,
        ))
    )
      add('lastik-progress', 145);
    if (!state.lastikWaitingOnly && partialDiagnostics) add('lastik-diagnostics', 150);
    const exclusionQuestion = test(
      /исключ|закреп|(?<![\p{L}])правил|розыгрыш|защищ|сообщен.{0,20}(?:админ|бот)|мои.{0,15}сообщен|(?:какие|каких).{0,50}не (?:удаля|трога|чист)|что.{0,25}не (?:удаля|трога|чист)/iu,
    );
    if (
      retentionHistoryPattern.test(state.current) ||
      individualRetentionQuestion(state.current) ||
      exclusionQuestion
    )
      add('lastik-exclusions', exclusionQuestion ? 125 : 100);
    if (
      test(/сохранен|не удалось сохранить|ошибк|неизвестн.{0,15}результат|повтор.{0,15}нажа/iu) ||
      test(lastikSettingsConflict)
    )
      add('lastik-save-recovery', test(lastikSettingsConflict) ? 155 : 135);
    if (test(/останов|отключ|выключ|пауз|вернуть(?!ся)|восстанов|отменить/iu))
      add('lastik-stop-restore', 140);
  }
  if (state.botDirectory) add('bots', 150);
  if (test(/приветств|стиль речи/iu)) add('greeting-and-speech', 100);
  if (
    test(
      /флуд|антиспам|длин.{0,15}(?:сообщен|объяв)|частот.{0,20}сообщен|количеств.{0,15}сообщен|медленн.{0,8}режим|интервал.{0,20}(?:стикер|фото|медиа)|огранич.{0,20}(?:вложен|голосов|файл|длин)/iu,
    )
  ) {
    add('message-limits', 100);
    add('settings', 55);
  }
  if (test(/сетк|избранн|категори|массов.{0,15}настрой|общие настройки.{0,20}чат/iu)) {
    const audience = test(/статистик|аудитори|прирост|за месяц|за недел|7.{0,8}30/iu);
    const operation = test(
      /настрой|примен|ошиб|откат|провери.{0,12}изменени|результат.{0,20}операци/iu,
    );
    if (audience) add('networks-audience-statistics', 105);
    if (operation) add('networks-settings-statistics', 105);
    if (!audience && !operation) add('networks-compose', 105);
    add('networks-management', 55);
  }
  if (
    !commercialAi &&
    test(
      /(?:фильтр|коммерческ|включ|выключ|отключ|настро).{0,25}реклам|(?:реклам|объяв).{0,25}(?:фильтр|чувствительн|разов|частн|личн)|личн.{0,10}продаж|нормальн.{0,10}продаж/iu,
    )
  ) {
    add('commercial-text-filter', 100);
    add('settings', 55);
  }
  if (
    !commercialAi &&
    test(
      /реклам.{0,35}(?:нарушен|повтор|предупрежден|наказан)|повторн.{0,15}нарушен.{0,25}реклам/iu,
    )
  )
    add('commercial-sanctions', 105);
  if (test(/(?:цен[аыуе]|тариф|стоимост|платн|бесплат|оплат|сколько стоит|деньги|перевод)/iu))
    add('prices-and-free-claims', 115);
  const unverifiedContact = test(
    /от имени|сотрудник|незнаком|неизвестн.{0,15}(?:контакт|человек|пользовател|отправител)|(?:перевод|оплат).{0,20}разблокир|(?:прислал|написал|отправил).{0,30}(?:карт|реквизит)/iu,
  );
  const financialContext = test(/оплат|перевод|деньг|разблокир|карт|реквизит/iu);
  const contactedIdentityCheck =
    test(/написал|написали|прислал|обратил|связал/iu) &&
    test(/подтверд|провер.{0,20}(?:личност|контакт|отправител)|довер|это.{0,20}ваш/iu);
  if (unverifiedContact && (financialContext || contactedIdentityCheck))
    add('payment-contact-verification', 120);
  if (test(/площадк|связк|бирж|взаимопиар/iu))
    add(test(/профил|скрыть/iu) ? 'marketplace-profile' : 'advertising-capability', 100);
  if (publ) {
    add('publik', 40);
    if (autoReplyRequest(text)) {
      add(
        test(
          /опечат|не срабатыв|совпад|целое|внутри|пауз|частот|повторен|слишком часто|отдельное слово|галочк|контекст|точечн|точн.{0,15}фраз/iu,
        )
          ? 'publisher-auto-replies-matching'
          : 'publisher-auto-replies-create',
        140,
      );
      add('publisher-auto-replies-create', 60);
    }
    if (test(/предложк|предложенн|прием.{0,15}предлож|присылать пост|предложить пост/iu)) {
      add('publisher-suggestions', 110);
      if (test(/сам.{0,10}подпиш|автомат.{0,15}подпис/iu)) add('subscription-participant', 70);
    }
    if (test(/уведомлен|только ответы|остальные события/iu)) add('notifications', 110);
    else if (test(/комментари|обсужден/iu))
      add(test(/канал|под пост/iu) ? 'publisher-comments-channel' : 'comments', 100);
    const vkContext = test(
      /\bvk\b|вконтакт|(?:^|\s)вк(?:\s|[.!?,]|$)|согласован.{0,15}личк|публиковать по очереди/iu,
    );
    const vkAutoDelete =
      vkContext &&
      test(/авто.?удал|(?:удал|убира).{0,35}(?:через|после|срок)|(?:срок|время).{0,20}удален/iu);
    if (vkContext) {
      if (
        test(
          /первоисточник|сво[яю]\s+ссылк|ссылк.{0,15}источник|(?:оставить|сохранить|добавить|включить).{0,30}(?:источник|ссылк.{0,15}источник)/iu,
        )
      )
        add('publisher-vk-source-link', 155);
      if (vkAutoDelete) add('publisher-vk-auto-delete', 155);
      add(
        test(/согласован|личк|получатель:|получать посты мне|присылать посты|одобр/iu)
          ? 'vk-review'
          : test(/авто|сразу|частот|очеред|пауз|фильтр/iu) && !test(/без автомат|не авториз/iu)
            ? 'publisher-vk-automation'
            : 'publisher-vk-connect',
        110,
      );
      add('publisher-vk-connect', 60);
      if (test(/авто|сразу|очеред/iu)) add('publisher-vk-automation', 65);
    }
    if (
      test(/пересыл|пересл|импорт|пост из max/iu) ||
      (test(/\bmax\b/iu) && test(/(?:забрать|перенести|скопир).{0,35}(?:редактор|публик)/iu))
    ) {
      add('publisher-import-max', 105);
      add('publisher-post-media', 60);
      add('publisher-post-create', 65);
    }
    if (
      test(
        /опозд|задерж|не успе|восстановлен|простой|простоя|поздн.{0,15}отправ|не вышел вовремя/iu,
      )
    )
      add('publisher-late-policy', 105);
    const missingSendResult = (value) =>
      /не (?:нашел|нахожу|вижу|появил)|(?:в ленте|в канале|в чате)[^.!?\n]{0,25}нет|нет[^.!?\n]{0,15}(?:пост|публикац)/iu.test(
        value,
      );
    const repeatSendAttempt = (value) =>
      /(?:отправ|публиков)[^.!?\n]{0,20}(?:еще раз|повтор|заново)|(?:повтор|заново)[^.!?\n]{0,20}(?:отправ|публиков)/iu.test(
        value,
      );
    const interruptedSendIn = (value) =>
      /нажа\p{L}*[^.!?\n]{0,25}(?:опубликовать|отправить)|после[^.!?\n]{0,25}(?:опубликовать|отправк)|(?:отправил|отправлял|опубликовал|публиковал)/iu.test(
        value,
      ) &&
      /(?:связь|соединен\p{L}*|интернет|сеть)[^.!?\n]{0,25}(?:оборвал|пропал|отвал|прерва)|(?:оборвал|пропал|отвал|прерва)\p{L}*[^.!?\n]{0,25}(?:связь|соединен|интернет|сеть)/iu.test(
        value,
      ) &&
      (missingSendResult(value) || repeatSendAttempt(value));
    const unknownDeliveryLabel =
      /нужно проверить|не уверен|результат.{0,20}(?:неизвест|не пришел|нет)|неизвестн.{0,10}результат/iu;
    const contextualDeliveryUncertain =
      interruptedSendIn(state.focus) || unknownDeliveryLabel.test(state.focus);
    const explicitCurrentSchedule =
      calendarDates.test(state.current) ||
      recurringFrequency.test(state.current) ||
      /отложенн|завтра|(?<![\p{L}])дат(?:[аеуы]|ам|ами|ах)?(?![\p{L}])|расписан|ежеднев|еженедель|регулярн|кажд.{0,12}(?:день|недел)|(?:\d{1,2}\s*[,и]\s*){2}\d{1,2}/iu.test(
        state.current,
      );
    const currentMissingResult = missingSendResult(state.current);
    const currentResultConfirmed =
      /(?:пост|публикация|сообщение)\s+(?:уже\s+)?появил(?:ся|ась|ось)(?![\p{L}])/iu.test(
        state.current,
      );
    const currentUnknownSend =
      contextualDeliveryUncertain &&
      (/[«"„]нужно проверить[»"“]/iu.test(state.current) ||
        currentMissingResult ||
        (repeatSendAttempt(state.current) && !explicitCurrentSchedule && !currentResultConfirmed));
    const deliveryUncertain =
      (interruptedSendIn(text) &&
        (text !== state.current || !currentResultConfirmed || currentMissingResult)) ||
      unknownDeliveryLabel.test(text) ||
      (text === state.current && currentUnknownSend);
    if (
      deliveryUncertain ||
      test(
        /подтвержден|результат.{0,20}пришел|отправил.{0,20}один|в одну секунду|достав|разослал/iu,
      )
    )
      add('publisher-delivery-status', currentUnknownSend ? 135 : 110);
    const selectedDates =
      test(
        /конкретн.{0,10}дат|три выбранн|именно эти|нескольк.{0,10}дат|выбранн.{0,15}(?:дат|дн)|(?:\d{1,2}\s*[,и]\s*){2}\d{1,2}/iu,
      ) || test(calendarDates);
    if (
      (selectedDates ||
        recurringSchedule(text) ||
        test(
          /отложенн|завтра|(?<![\p{L}])дат(?:[аеуы]|ам|ами|ах)?(?![\p{L}])|расписан|заплан|регулярн.{0,15}пост|кажд.{0,12}(?:день|недел)|ежеднев|еженедель|по понедельник|повтор/iu,
        )) &&
      (!contextualDeliveryUncertain || explicitCurrentSchedule) &&
      (!test(/автоответ/iu) || selectedDates)
    ) {
      add(
        selectedDates
          ? 'publisher-schedule-dates'
          : recurringSchedule(text)
            ? 'publisher-schedule-recurrence'
            : 'publisher-schedule-once',
        100,
      );
      add('publisher-schedule-timezone', 70);
    }
    if (test(/часов.{0,8}пояс|московск|время телефон/iu)) add('publisher-schedule-timezone', 110);
    if (
      (!vkAutoDelete || test(/обычн.{0,20}пост|ручн.{0,20}пост|написать пост/iu)) &&
      test(
        /закреп|автоудал|автоматическ.{0,15}удален|удали.{0,15}автомат|сам[аио]?\s+удал|после публикац|удал.{0,80}после.{0,20}(?:выход|отправ|публикац)/iu,
      )
    )
      add('publisher-after-publish', 100);
    if (test(/дублирова|отмен|останов|пауз.{0,20}(?:пост|расписан)|запуст/iu))
      add('publisher-post-control', 105);
    if (
      test(/черновик|истори.{0,15}публикац|продолжить|незаконченн|старые отправки|в [«"]текущих/iu)
    )
      add('publisher-drafts-history', 100);
    if (
      test(
        /модуль выключен|недоступ|не публику|не отправ|не вышел|прав.{0,20}админ|не админ|серый|не появился|убрать.{0,20}из администратор/iu,
      )
    )
      add('publisher-readiness', 100);
    if (
      test(
        /получател|рассылк|нескольк.{0,15}(?:чат|канал)|трех.{0,10}чат|не вижу.{0,15}(?:чат|канал)|канал серый/iu,
      )
    )
      add('publisher-post-targets', 95);
    if (
      test(
        /фото|фотк|видео|символ|знаков|знака|знаки|мб|мегабайт|вложен|кнопк|ссылк|предпросмотр|(?:лимит|предел|огранич).{0,25}(?:текст|редактор)|(?:текст|редактор).{0,25}(?:не (?:берет|влез)|слишком длин)/iu,
      )
    ) {
      add('publisher-post-media', 95);
      add('publisher-post-create', 60);
    }
    if (
      placement.test(text) ||
      test(
        /редактор|проверить пост|создать|предпросмотр|публикаци|(?:как|куда|не понял).{0,20}отправ/iu,
      )
    )
      add('publisher-post-create', 80);
  }
  if (test(/комментари/iu) && test(/майор/iu) && publ) add('channel-settings', 90);
  if (
    test(/(?:разниц|отлича|сравни|вместо него|тоже модератор|разные боты)/iu) &&
    !test(
      /часов\p{L}*\s+пояс\p{L}*[^.!?\n]{0,25}отлич|отлич\p{L}*[^.!?\n]{0,25}часов\p{L}*\s+пояс/iu,
    ) &&
    (moderatorName.test(text) || publisherName.test(text) || eraserName.test(text))
  ) {
    add('bots', 120);
    if (publisherName.test(text)) add('publik', 100);
  }
  if (
    test(
      /(?:можно|где|про что|о чем).{0,40}(?:спрашива|задавать вопрос)|чат.{0,20}(?:только для|для админ|для разработчик)/iu,
    )
  )
    add('bots', 100);
  if (test(/ночн/iu) && test(/публик/iu)) add('bots', 60);
  if (test(/комментари/iu) && !publ)
    add(test(/max|нативн/iu) ? 'max-native-channel-comments' : 'channel-settings', 100);
  if (storefrontPattern.test(text)) {
    add('karavan-storefront', 110);
    const setupRecovery = test(
      /не подтверд|неизвестн|частичн|неопредел[её]н|продолжить подключ|неясн|завис|непонятно.{0,30}(?:подключ|созда|законч)/iu,
    );
    if (setupRecovery) add('karavan-setup-recovery', 145);
    if (
      (!setupRecovery || test(/(?:как|хочу|нужно).{0,15}создать/iu)) &&
      test(/подключ|созда|черновик|правил|общ.{0,12}магазин|один.{0,12}магазин/iu)
    )
      add('karavan-chat-marketplace', 135);
    if (test(/\$|публикац|ссылк|выбор|выбра|выбрат|витрин.{0,15}нескольк/iu))
      add('karavan-storefront-publishing', 130);
  }
  if (test(/настрой|област|нескольк.{0,12}чат|во всех.{0,12}(?:чат|групп|сообществ)/iu))
    add('settings', 65);
  if (
    !publ &&
    (!state.eraserRequest || mixedTopics) &&
    test(
      /(?:удал|стира|исчез|пропал).{0,50}(?:сообщен|фраз|пост|объяв)|(?:сообщен|фраз|пост|объяв).{0,50}(?:удал|стира|исчез|пропал)|(?:бот|майор|рэкс).{0,50}(?:удал|стира|снес)/iu,
    )
  )
    add('announcement-removal', 45);
  if (
    (advert.test(text) || placement.test(text)) &&
    (!facts.length || !publ) &&
    (!state.eraserRequest || mixedTopics)
  ) {
    if (removal.test(text)) add('announcement-removal', commercialAi ? 100 : 45);
    else if (!commercialAi) add('announcement-placement', 45);
  }
  return facts;
}

/** Local, deterministic routing. Role declarations guide explanations, never access control. */
export function createSupportRouter(knowledge) {
  const entries = knowledge.entries;
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const terms = new Map(entries.map((entry) => [entry.id, new Set(words(entry.keywords))]));
  // FLAG: Only exact identities from the reviewed catalog can supply a bot name.
  // Eligibility still uses the original text type/length and the human reply target.
  const catalogIdentities = (knowledge.botCatalog ?? []).flatMap((bot) => {
    const handle = /^https:\/\/max\.ru\/([a-z0-9_]+)$/iu.exec(bot.url ?? '')?.[1];
    if (!handle || typeof bot.name !== 'string') return [];
    const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
    return [
      {
        name: bot.name,
        pattern: new RegExp(
          `(?<![\\p{L}\\p{N}_@./?=&-])(?:${escape(bot.url)}|@?${escape(handle)})(?![\\p{L}\\p{N}_/=&-]|\\?[\\p{L}\\p{N}_%])`,
          'giu',
        ),
      },
    ];
  });
  const catalogText = (value) =>
    typeof value === 'string'
      ? catalogIdentities.reduce((text, { pattern, name }) => text.replace(pattern, name), value)
      : value;
  const conversationFor = (text, history) =>
    conversation(
      catalogText(text),
      Array.isArray(history)
        ? history.map((item) =>
            item && typeof item.text === 'string'
              ? { ...item, text: catalogText(item.text) }
              : item,
          )
        : history,
    );
  const factsFor = (state) => {
    const all = semanticFacts(state.focus, state);
    const direct = semanticFacts(state.current, state);
    const scores = new Map();
    for (const { id, priority } of all)
      if (byId.has(id)) scores.set(id, Math.max(scores.get(id) ?? 0, priority));
    for (const { id, priority } of direct)
      if (byId.has(id)) scores.set(id, Math.max(scores.get(id) ?? 0, priority + 15));
    return [...scores].sort((a, b) => b[1] - a[1]).map(([id]) => id);
  };
  function classify(text, history = [], interaction = {}) {
    const ctx = conversationFor(text, history);
    const assistantTopic =
      supportAssistantRequest(ctx.current, ctx.recent) && !namedSupportProduct(ctx.current);
    if (assistantTopic) ctx.focus = ctx.current;
    const role = roleOf(ctx.current, ctx.recent);
    const openerContext = ctx.recent.some(
      (item) => item.role === 'user' && supportOpener(item.text),
    );
    const topicContext = ctx.recent.some(
      (item) =>
        (item.role === 'user' || !openerContext) &&
        (domain.test(item.text) || topics(item.text).length || advert.test(item.text)),
    );
    const hasContext = topicContext || openerContext;
    const freshClarification =
      ctx.recent.at(-1)?.role === 'assistant' &&
      /\?|(?:^|\s)(?:уточните|выберите|подскажите)(?![\p{L}])/iu.test(ctx.recent.at(-1).text) &&
      hasContext;
    const clarificationAnswer =
      ctx.current.length <= 160 &&
      (/^(?:я\s+(?:админ|участ|владел)|админ|участ|владел|да(?![\p{L}])|нет(?![\p{L}])|в\s|во\s|на\s|у меня\s|мне\s|только\s|одному\s|здесь\s|два\s|две\s|три\s|один\s|одна\s|\d)/iu.test(
        ctx.current,
      ) ||
        (ctx.current.split(/\s+/u).length <= 6 &&
          (domain.test(ctx.current) || topics(ctx.current).length > 0)));
    let supportDialogue =
      (!hasContext && supportOpener(ctx.current)) ||
      (openerContext &&
        freshClarification &&
        clarificationAnswer &&
        !domain.test(ctx.current) &&
        !topics(ctx.current).length &&
        !advert.test(ctx.current) &&
        !topicContext);
    const roleOnly =
      /^(?:(?:да|нет)[,.!\s]*)?(?:(?:я|мы|в|это|канал|чат)\s+)?(?:админ(?:истратор)?|владелец|участник|своем канале|моем чате|чужой группе|да|нет)[.!\s]*$/iu.test(
        ctx.current,
      );
    const botCatalogContext = ctx.recent.some((item) =>
      /(?:восемь|8)\s+бот|(?:шесть|6)\s+модератор|(?:список|каталог|названия|перечисл\p{L}*)\s+(?:(?:всех|ваших|наших)\s+)*(?:бот|модератор)|помощник.{0,40}(?:пута|много)/iu.test(
        item.text,
      ),
    );
    const contextualBotDirectory =
      botCatalogContext &&
      /(?:перечисл\p{L}*|назов\p{L}*|дай\p{L}*|пришл\p{L}*|кинь\p{L}*)\s+(?:их\s+)?(?:всех(?=\s*(?:[,.;!?]|$|поимен|по именам|со? ссылк|и\s+кто))|поименно|по именам)/iu.test(
        ctx.current,
      );
    const botDirectory =
      contextualBotDirectory ||
      (/(?:бот|модератор|помощник)/iu.test(ctx.current) &&
        /(?:всех|все)\s+(?:восьми|восемь|восьмерых|8)(?![\p{L}\d])/iu.test(ctx.current)) ||
      /какие\s+(?:вообще\s+)?боты(?:\s+у\s+вас)?(?:\s+есть)?[?!.\s]*$/iu.test(ctx.current) ||
      /(?:перечисл\p{L}*|спис(?:ок|ком)|названия|каталог)\s+(?:(?:всех|ваших|наших|восьми|восьмерых|8|основных|резервных)\s+)*(?:ботов|модераторов)(?![\p{L}])|какие\s+у\s+вас\s+(?:есть\s+)?боты|сколько\s+(?:всего\s+)?(?:у\s+вас\s+|в\s+проекте\s+)?ботов(?:\s+(?:есть|всего|у\s+вас|в\s+проекте))?[?!.\s]*$|(?:какие|кто).{0,15}(?:основн|резервн).{0,15}(?:бот|модератор)|ссылк\p{L}*.{0,15}(?:всех|восьми|8).{0,10}бот/iu.test(
        ctx.current,
      );
    const switchingModerator = moderatorSwitchRequest(ctx.current);
    const request =
      supportQuestion.test(ctx.current) ||
      supportIncident.test(ctx.current) ||
      (domain.test(ctx.current) &&
        /(?:удалил[ао]?|снес|перестал)(?![\p{L}])/iu.test(ctx.current)) ||
      /(?:^|\s)нуж(?:на|ен|ны)\s/iu.test(ctx.current) ||
      configurationIntent.test(ctx.current) ||
      /(?:^|\s)хочу[\s,]/iu.test(ctx.current) ||
      unresolvedHelp.test(ctx.current) ||
      actionRequest.test(ctx.current) ||
      switchingModerator ||
      /дублиру|повторя|скоро|неизвестн.{0,15}(?:функц|возможност)/iu.test(ctx.current) ||
      botDirectory ||
      (hasContext && supportFollowup.test(ctx.current)) ||
      supportDialogue;
    const settingObservation =
      hasContext &&
      freshClarification &&
      /^(?:стоит|выбран|включен|режим|поставил|сохранил)[а-я\s«»'"-]{0,90}$/iu.test(ctx.current) &&
      /ссылк|фильтр|режим|настройк/iu.test(ctx.focus);
    const removalFollowup =
      hasContext &&
      advert.test(ctx.focus) &&
      /^(?:а\s+)?(?:удалить|удалят|удалится|удалятся)(?:\s+(?:будет|можно|получится|да|нет)){1,3}[?!.\s]*$/iu.test(
        ctx.current,
      );
    const contextualReply =
      hasContext &&
      (settingObservation ||
        removalFollowup ||
        supportFollowup.test(ctx.current) ||
        unresolvedHelp.test(ctx.current) ||
        (request &&
          (/(?:^|\s)(?:это|этот|эта|эти|этого|этом|так|там|тут|туда|он|его|ее|их|ему|теперь|тем же)(?![\p{L}])/iu.test(
            ctx.current,
          ) ||
            /^(?:а\s+)?(?:что дальше|можно повторить|как проверить результат|можно выбрать другую модель)|^а\s+(?:если|.*(?:как|где|что|можно|кто увидит))(?![\p{L}])/iu.test(
              ctx.current,
            ))) ||
        (freshClarification && !request && clarificationAnswer));
    const addressed = interaction?.addressedToSupport === true;
    if (
      addressed &&
      request &&
      !hasContext &&
      !supportAssistantRequest(ctx.current, ctx.recent) &&
      !domain.test(ctx.current) &&
      !topics(ctx.current).length
    )
      supportDialogue = true;
    const configurationHelp =
      configurationSubject.test(ctx.current) &&
      (unresolvedHelp.test(ctx.current) ||
        supportIncident.test(ctx.current) ||
        configurationAction.test(ctx.current));
    // FLAG: A reply/mention to somebody else never inherits our support context or keyword match.
    const eligible =
      typeof text === 'string' &&
      Boolean(text.trim()) &&
      text.length <= 1200 &&
      !(interaction?.replyToOther === true && !addressed) &&
      !ordinaryConversation(ctx.current) &&
      (addressed || !peerAdvice(ctx.current, text)) &&
      (!roleOnly || freshClarification) &&
      ((request &&
        (domain.test(ctx.current) ||
          /модератор/iu.test(ctx.current) ||
          advert.test(ctx.current) ||
          topics(ctx.current).length ||
          supportAssistantRequest(ctx.current, ctx.recent) ||
          projectSubject.test(ctx.current) ||
          switchingModerator)) ||
        (request && configurationHelp) ||
        (addressed && request) ||
        contextualReply ||
        supportDialogue ||
        /^(?:цена|тарифы?|платно|бесплатно|не работает|не открывается|помогите|подскажите)[.!?\s]*$/iu.test(
          ctx.current,
        ));
    const latestProduct = [
      ...ctx.recent.filter((item) => item.role === 'user'),
      { text: ctx.current },
    ]
      .map((item) => ({ ...item, product: productOf(item.text) }))
      .findLast((item) => item.product);
    const eraserOnly = latestProduct?.product === 'eraser';
    const publishingMigration =
      /переехал.{0,20}публикац|раньше.{0,20}пост|(?:где|куда).{0,20}(?:переехал|делись).{0,20}(?:пост|публикац)/iu.test(
        ctx.current,
      );
    const majorOnly =
      /(?:в|через|у)\s+майор/iu.test(ctx.current) &&
      !publisherName.test(ctx.current) &&
      !autoReplyRequest(ctx.current) &&
      !/автопост/iu.test(ctx.current) &&
      !publishingMigration;
    const publisherRequest =
      !assistantTopic &&
      !majorOnly &&
      !eraserOnly &&
      Boolean(
        isPublisherTask(ctx.focus) ||
        latestProduct?.product === 'publisher' ||
        (latestProduct?.product === 'mixed' &&
          publisherName.test(ctx.current) &&
          placement.test(ctx.current)) ||
        (((role === 'admin' && placement.test(ctx.focus)) ||
          /получател|редактор|черновик/iu.test(ctx.focus)) &&
          !topics(ctx.focus).includes('rules')),
      );
    const eraserRequest = Boolean(
      !assistantTopic &&
      eraserOnly &&
      (eraserName.test(ctx.current) ||
        !topics(ctx.current).length ||
        topics(ctx.current).includes('retention')),
    );
    const developer = developerPattern.test(ctx.focus);
    const profilesRequested = botProfileRequest(ctx.current) || reserveComparison(ctx.current);
    const reserveHandoff =
      (botDirectory || botCatalogContext || moderatorName.test(ctx.current)) &&
      /резерв|двойк|в запас|запасн/iu.test(ctx.current) &&
      /подхват|перехват|переключ|выбран|выбрать/iu.test(ctx.current);
    const botCatalogRequest =
      reserveHandoff ||
      profilesRequested ||
      (moderatorName.test(ctx.current) &&
        /резерв|в запас/iu.test(ctx.current) &&
        /переключ|перехват|выбран|выбрать/iu.test(ctx.current));
    const aiIntents = commercialIntents(ctx.current, ctx.focus);
    const commercialAi = commercialIntent(ctx.current, ctx.focus, aiIntents);
    const state = {
      ...ctx,
      role,
      eligible,
      publisherRequest,
      publisherConnectionReady:
        reportedPublisherReady(ctx.current, publisherRequest) ||
        reportedPublisherReady(ctx.focus, publisherRequest),
      eraserRequest,
      developer,
      commercialAi,
      supportDialogue,
      aiIntents,
      botDirectory,
      botCatalogRequest,
      reserveHandoff,
      subscriptionIntent: subscriptionIntent(ctx),
      nightSources: nightSources(ctx, role),
      reviewedIntents: reviewedIntents(ctx),
    };
    state.moderatorTroubleshooting = moderatorFailure(ctx, state);
    state.lastikWaitingOnly = atomicLastikWaiting(ctx, state);
    state.lastikSetupOnly = atomicLastikSetup(ctx, state);
    const mixedTopics = mixedRequests(ctx, state);
    state.mixedTopics = mixedTopics;
    const primaryIds = factsFor(state);
    const productHelp = primaryIds.some(
      (id) =>
        ![
          'announcement-removal',
          'announcement-placement',
          'prices-and-free-claims',
          'max-delete-rights',
          'sanctions',
          'bots',
          'publik',
        ].includes(id),
    );
    const advertisementRequest =
      (advert.test(ctx.focus) || placement.test(ctx.current)) &&
      (request || freshClarification || removal.test(ctx.current));
    // FLAG: Unknown is not a participant; only an explicit member may take the member policy route.
    const participantAdvertisement =
      eligible && role === 'member' && advertisementRequest && !productHelp && !publisherRequest;
    return {
      role,
      eligible: Boolean(eligible),
      requiredReply: Boolean(eligible && (request || contextualReply || primaryIds.length)),
      participantAdvertisement: Boolean(participantAdvertisement),
      advertisementRequest: Boolean(advertisementRequest),
      commercialAi,
      mixedTopics,
      publisherRequest,
      publisherConnectionReady: state.publisherConnectionReady,
      eraserRequest,
      developer,
      moderatorTroubleshooting: state.moderatorTroubleshooting,
      connectionTroubleshooting:
        /не получается|не могу|ошибк|отказ|не подключ/iu.test(ctx.current) &&
        /подключ|пересыл/iu.test(ctx.current) &&
        /бот|чат|групп|сообществ|пересыл/iu.test(ctx.current) &&
        !/\bvk\b|(?<![\p{L}])вк(?![\p{L}])|токен|аккаунт/iu.test(ctx.current),
      accessTroubleshooting:
        /(?:нет доступа|не (?:вижу|могу|получается|открыва)|недоступ|не появ|не подключ|не получается подключить).{0,45}(?:настройк|чат|канал|журнал|событи)|(?:журнал|событи|настройк).{0,30}(?:недоступ|не открыва|не вижу)/iu.test(
          ctx.current,
        ),
      botDirectory,
      botCatalogRequest,
      primaryIds,
      ...reviewedAtomicIntents(ctx, state, primaryIds),
      lastikWaitingOnly: state.lastikWaitingOnly,
      lastikSetupOnly: state.lastikSetupOnly,
      lastikConnectionIntent: lastikConnectionIntent(ctx, state, primaryIds),
      liveActionRequested: [...ctx.current.matchAll(liveAction)].some(
        (match) => !negatedAt(ctx.current, match.index),
      ),
      linkPolicyIntent: linkPolicyIntent(ctx, state, primaryIds),
      botProfilesRequested: profilesRequested,
      reasons: [
        freshClarification && 'recent-support-clarification',
        hasContext && 'recent-support-topic',
        role !== 'unknown' && `explicit-role:${role}`,
        commercialAi && `commercial-ai:${commercialAi}`,
      ].filter(Boolean),
    };
  }
  function selectKnowledge(text, history = [], interaction = {}) {
    const state = classify(text, history, interaction);
    const selected = state.primaryIds
      .filter((id) => byId.get(id)?.audience !== 'developer' || state.developer)
      .slice(0, 5);
    if (!selected.length) {
      const query = new Set(words(text));
      const context = new Set(words(conversationFor(text, history).focus));
      const ranked = entries
        .filter(
          (entry) =>
            !mandatoryIds.has(entry.id) &&
            entry.delivery !== 'reviewed' &&
            (entry.audience !== 'developer' || state.developer),
        )
        .map((entry) => ({
          id: entry.id,
          score: [...terms.get(entry.id)].reduce(
            (score, term) => score + (query.has(term) ? 3 : context.has(term) ? 1 : 0),
            0,
          ),
        }))
        .filter(({ score }) => score > 0)
        .sort((a, b) => b.score - a.score);
      for (const item of ranked)
        if (selected.length < 3 && item.score >= ranked[0].score * 0.6) selected.push(item.id);
    }
    if (!selected.length && byId.has('bots')) selected.push('bots');
    return [...new Set([...selected, ...mandatoryIds])].map((id) => byId.get(id)).filter(Boolean);
  }
  return {
    classify,
    eligibleQuestion: (text, history = [], interaction = {}) =>
      classify(text, history, interaction).eligible,
    selectKnowledge,
  };
}
