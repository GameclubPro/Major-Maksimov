const guideIdByProduct = Object.freeze({
  moderator: 'moderator-group',
  publisher: 'publisher-group',
});

const allowedFacts = Object.freeze({
  moderator: new Set(['connect', 'bots', 'max-add-existing-bot-group', 'max-delete-rights']),
  publisher: new Set(['publik', 'publisher-post-targets', 'max-add-existing-bot-group']),
});

export function selectSupportOnboardingGuide({ text, request, knowledge }) {
  // FLAG: A guide is a reviewed answer to a current setup request. Existing support
  // eligibility still owns human addressing; history alone cannot select an image pack.
  if (
    !request?.eligible ||
    request.mixedTopics ||
    request.liveActionRequested ||
    request.developer ||
    request.eraserRequest ||
    request.botDirectory ||
    request.participantAdvertisement ||
    request.publisherConnectionReady ||
    !Array.isArray(request.primaryIds) ||
    typeof text !== 'string' ||
    text.length > 500
  )
    return null;

  const current = text.normalize('NFKC').toLocaleLowerCase('ru');
  if (
    /канал|ластик|караван|(?:^|[^\p{L}])vk(?:$|[^\p{L}])|вконтакте|магазин|сетк|автоответ|автопост|тариф|цен[аыу]|стоимост/iu.test(
      current,
    ) ||
    /не\s+(?:работ|могу|получ|подключ|добав|вижу)|не\p{L}*\s+подключ|ошиб|молчит|пропал|почему|сбой|снова|повторно|после\s+подключ|уже\s+(?:подключ|добав|назнач)|подключ[её]н(?:а|о|ы)?(?![\p{L}])|добавлен|отключ|отсоедин|отмен|не\s+(?:надо|нужно)|только\s+текст|без\s+(?:фото|картин|изображ|карточ|пачк)|не\s+(?:присыла|отправля|показыва|скидыва|кидай)/iu.test(
      current,
    )
  )
    return null;

  const requests = current.split(
    /(?<=[.!?;])\s*|\n|(?<![\p{L}])(?:а|и)\s+(?=(?:(?:ещ[её]|также|заодно)\s+)?(?:как|где|куда|почему|что|сколько|какие|можно|расскажи|объясни|поясни|покажи|пришли|выгрузи|скачай|\p{L}{2,}(?:ть|ти|чь)(?:ся)?(?![\p{L}])))/u,
  );
  if (
    requests.some(
      (part) =>
        /\?|^(?:(?:ещ[её]|также|заодно)\s+)?(?:как|где|куда|почему|что|сколько|какие|можно|расскажи|объясни|поясни|покажи|пришли|выгрузи|скачай|\p{L}{2,}(?:ть|ти|чь)(?:ся)?)(?![\p{L}])/u.test(
          part.trim(),
        ) &&
        !/подключ|добавить|пригласить|инструкц|картин|карточ|памятк|пошаг/u.test(part) &&
        !/^(?:(?:кратко|коротко)\s+)?(?:поясни(?:те)?|объясни(?:те)?)(?:\s+(?:кратко|коротко))?[.!?\s]*$/u.test(
          part.trim(),
        ),
    )
  )
    return null;

  const publisher = /публик|publik/iu.test(current);
  const moderator =
    /(?<![\p{L}\p{N}_])(?:майор\p{L}*|максимов\p{L}*|р[эе]кс\p{L}*|модератор\p{L}*)(?![\p{L}\p{N}_])/iu.test(
      current,
    );
  if (publisher === moderator) return null;
  const product = publisher ? 'publisher' : 'moderator';
  const sourceId = publisher ? 'publik' : 'connect';
  if (
    !request.primaryIds.includes(sourceId) ||
    request.primaryIds.some((id) => !allowedFacts[product].has(id))
  )
    return null;

  const guideRequest =
    /(?:^|[.!?\n]\s*)(?:пришли(?:те)?|скинь(?:те)?|покажи(?:те)?|дай(?:те)?|отправь(?:те)?|нужна|нужны|где\s+(?:взять|найти|посмотреть)).{0,90}(?:инструкц|картин|карточ|памятк|пошаг)|(?:^|[.!?\n]\s*)(?:инструкц|картин|карточ|памятк).{0,65}(?:пришли(?:те)?|скинь(?:те)?|покажи(?:те)?|дай(?:те)?|отправь(?:те)?)/iu.test(
      current,
    );
  const setupQuestion =
    /(?:^|[.!?\n]\s*)(?:(?:подскажи(?:те)?|объясни(?:те)?),?\s+)?(?:как|помоги(?:те)?).{0,65}(?:подключ|добавить|пригласить)|(?:^|[.!?\n]\s*)(?:подключ|добавить|пригласить).{0,65}(?:как|пошагово)/iu.test(
      current,
    );
  if (!guideRequest && !(setupQuestion && /групп|чат/iu.test(current))) return null;

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
  return guide;
}
