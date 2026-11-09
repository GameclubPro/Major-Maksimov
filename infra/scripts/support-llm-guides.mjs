const guideIdByProduct = Object.freeze({
  moderator: 'moderator-group',
  publisher: 'publisher-group',
});
const allowedFacts = Object.freeze({
  moderator: new Set(['connect', 'bots', 'max-add-existing-bot-group', 'max-delete-rights']),
  publisher: new Set([
    'publik',
    'connect',
    'bots',
    'publisher-post-targets',
    'max-add-existing-bot-group',
  ]),
});
const setupAction =
  /(?<![\p{L}])(?:пере)?подключ(?:ить|ать|и(?:те)?|ай(?:те)?|а(?:ют|ется|ются)|ени\p{L}*)(?![\p{L}])|(?<![\p{L}])(?:добав(?:ить|лять|ь(?:те)?|лени\p{L}*)|приглас(?:ить|и(?:те)?)|назнач(?:ить|ь(?:те)?))(?![\p{L}])/giu;
const otherObject =
  /^\s*(?:(?:нов\p{L}*|ещ[её]|один|одну|эту|этот)\s+)*(?:пост|фото|получател|картин|изображ|ссылк|строк|кнопк|сообщен|расписан|комментар|автоответ|автопост|(?:групп|канал)\p{L}*\s+vk)/iu;
const normalize = (text) =>
  String(text ?? '')
    .normalize('NFKC')
    .toLocaleLowerCase('ru');
const escaped = (text) => text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');

function imageOptOut(text) {
  return /только\s+(?:текст|словами)|без\s+(?:фото|картин|изображ|карточ|пачк|скриншот)|не\s+(?:присыла|отправля|показыва|скидыва|кидай|прикрепля)|не\s+(?:нужно|надо)\s+(?:присылать|отправлять|прикреплять|скидывать|показывать)\s+(?:картин|изображ|карточ|фото|скриншот)|(?:картин|изображ|карточ|скриншот)\p{L}*\s+не\s+нуж/iu.test(
    text,
  );
}

function imageRequest(text) {
  return (
    text.length <= 240 &&
    /картин|карточ|скриншот|изображен|пачк/iu.test(text) &&
    /где|пришл|скин|покаж|дай|отправ|прикреп|можешь|можете|можно/iu.test(text)
  );
}

function imageOnlyRequest(text) {
  return /^(?:а\s+)?(?:где(?:\s+же)?|пришли(?:те)?|скинь(?:те)?|покажи(?:те)?|дай(?:те)?|отправь(?:те)?|прикрепи(?:те)?|(?:можешь|можете|можно)\s+(?:прислать|отправить|показать|прикрепить))\s+(?:(?:эти|все|готовые)\s+)?(?:картинк[иу]|карточк[иу]|скриншоты?|изображени[ея]|пачку(?:\s+(?:картинок|карточек))?)(?:\s+для\s+подключения)?(?:,?\s+пожалуйста)?[.!?\s]*$/iu.test(
    text.trim(),
  );
}

function botMentions(text, knowledge) {
  const mentions = [];
  for (const bot of knowledge?.botCatalog ?? []) {
    const product =
      bot.kind === 'publisher' ? 'publisher' : bot.kind === 'eraser' ? 'eraser' : 'moderator';
    const handle = bot.url?.split('/').at(-1);
    const names = [...new Set([bot.name, ...(bot.aliases ?? []), bot.url, handle].filter(Boolean))];
    const pattern = new RegExp(
      `(?<![\\p{L}\\p{N}_])(?:${names
        .sort((a, b) => b.length - a.length)
        .map(escaped)
        .join('|')})(?![\\p{L}\\p{N}_])`,
      'giu',
    );
    for (const match of text.matchAll(pattern))
      mentions.push({ product, index: match.index, end: match.index + match[0].length });
  }
  for (const match of text.matchAll(
    /(?<![\p{L}\p{N}_])(?:бот(?:а|у|ом|е|ов|ы)?|модератор\p{L}*|майор\p{L}*)(?![\p{L}\p{N}_])/giu,
  ))
    mentions.push({
      product: 'moderator',
      generic: true,
      index: match.index,
      end: match.index + match[0].length,
    });
  return mentions.sort((a, b) => a.index - b.index || b.end - a.end);
}

function setupContext(text, knowledge, request = {}, confirmed = false) {
  if (
    !confirmed &&
    !/\?|^(?:а\s+)?(?:как|где|куда|почему|что|чем|можно|не\s+могу|хочу|нужн|мне\s+нуж|пришл|скин|покаж|дай|отправ|подключи|добавь|пригласи|назначь|я\s+(?:админ|владел))/iu.test(
      text,
    )
  )
    return null;
  const mentions = botMentions(text, knowledge);
  for (const action of [...text.matchAll(setupAction)].reverse()) {
    const after = action.index + action[0].length;
    const location =
      /^\s+(?:в|через|из)\s+(?:(?:мини[-\s]?приложени\p{L}*\s+)?публик\p{L}*|(?:(?:нов\p{L}*|этот)\s+)?(?:пост|редактор)\p{L}*(?:\s+публик\p{L}*)?)\s+/iu.exec(
        text.slice(after),
      );
    const objectStart = after + (location?.[0].length ?? 0);
    if (otherObject.test(text.slice(objectStart))) continue;
    let next = mentions.find(
      (mention) =>
        mention.index >= objectStart &&
        mention.index - objectStart <= 80 &&
        !/[!?;\n]/u.test(text.slice(objectStart, mention.index)),
    );
    if (next?.generic)
      next =
        mentions.find(
          (mention) =>
            !mention.generic &&
            mention.index >= next.end &&
            mention.index - next.end <= 30 &&
            /^\s*(?:по\s+имени\s+)?[@«"-]?\s*$/u.test(text.slice(next.end, mention.index)),
        ) ?? next;
    const prior = mentions.findLast(
      (mention) =>
        mention.end <= action.index &&
        action.index - mention.end <= 55 &&
        !/[.!?;\n]/u.test(text.slice(mention.end, action.index)),
    );
    const target = next ?? prior;
    if (target) return { product: target.product, text };
  }
  if (
    request.primaryIds?.includes('connect') &&
    /пересла|пересыл|куда|старт/iu.test(text) &&
    mentions.length
  )
    return { product: mentions.at(-1).product, text };
  return null;
}

function atomicSetup(text, request, product) {
  if (
    request.mixedTopics ||
    request.developer ||
    request.botDirectory ||
    request.botCatalogRequest ||
    text.length > 500 ||
    /канал|ластик|не\s+(?:работ|могу|получ|подключ|добав|вижу|уверен|знаю)|ошиб|молчит|пропал|почему|сбой|снова|повтор|возможн|после\s+подключ|уже\s+(?:подключ|добав|назнач)|подключ[её]н(?:а|о|ы)?(?![\p{L}])|добавлен|отключ|отсоедин|отмен|игнорир|[{}]/iu.test(
      text,
    )
  )
    return false;
  if (request.primaryIds?.some((id) => !allowedFacts[product].has(id))) return false;
  return text
    .split(
      /(?<=[.!?;])\s*|\n|(?<![\p{L}])(?:а|и)\s+(?=(?:(?:ещ[её]|также|заодно)\s+)?(?:как|где|почему|что|сколько|какие|можно|расскажи|объясни|поясни|покажи|выгрузи|скачай|настро|включ|\p{L}{2,}(?:ть|ти|чь)(?:ся)?(?![\p{L}])))/u,
    )
    .every(
      (part) =>
        !/\?|^(?:(?:ещ[её]|также|заодно)\s+)?(?:как|где|почему|что|сколько|какие|можно|расскажи|объясни|поясни|покажи|выгрузи|скачай|настро|включ)/u.test(
          part.trim(),
        ) || /подключ|добавить|пригласить|инструкц|картин|карточ|памятк|пошаг/u.test(part),
    );
}

export function selectSupportOnboardingGuide({ text, request, knowledge, history = [] }) {
  // FLAG: Only the application chooses reviewed media. A current request or an explicit
  // image followup can select it; unrelated history and assistant claims cannot select a bot.
  if (
    !request?.eligible ||
    request.participantAdvertisement ||
    typeof text !== 'string' ||
    text.length > 1200 ||
    !Array.isArray(request.primaryIds)
  )
    return null;
  const current = normalize(text);
  if (imageOptOut(current)) return null;
  let setup = setupContext(current, knowledge, request);
  let followup = false;
  if (!setup && imageRequest(current)) {
    const [previous, answer] = history.slice(-2);
    if (
      previous?.role !== 'user' ||
      answer?.role !== 'assistant' ||
      typeof previous.text !== 'string' ||
      typeof answer.text !== 'string' ||
      !answer.text.trim()
    )
      return null;
    setup = setupContext(normalize(previous.text), knowledge, {}, true);
    followup = Boolean(setup);
  }
  if (!setup) return null;
  const product = setup.product === 'publisher' ? 'publisher' : 'moderator';
  const sourceId = product === 'publisher' ? 'publik' : 'connect';
  const guide = knowledge?.onboardingGuides?.find(
    (entry) => entry.id === guideIdByProduct[product],
  );
  if (
    !guide ||
    typeof guide.caption !== 'string' ||
    !guide.caption.trim() ||
    guide.caption.length > 600 ||
    !Array.isArray(guide.sourceIds) ||
    guide.sourceIds.length !== 1 ||
    guide.sourceIds[0] !== sourceId
  )
    return null;
  const lastik = setup.product === 'eraser';
  const channel = /канал/iu.test(setup.text);
  return {
    ...guide,
    setupText: setup.text,
    followup,
    imageOnly: followup && imageOnlyRequest(current),
    lastik,
    channel,
    atomic:
      !lastik &&
      !channel &&
      (!followup || imageOnlyRequest(current)) &&
      atomicSetup(setup.text, followup ? { primaryIds: [] } : request, product),
  };
}
