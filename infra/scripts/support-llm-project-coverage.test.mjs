import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createSupportRouter } from './support-llm-routing.mjs';

const knowledge = JSON.parse(
  readFileSync(new URL('./support-llm-knowledge.json', import.meta.url)),
);
const router = createSupportRouter(knowledge);
const ids = (text, history = []) => router.selectKnowledge(text, history).map((entry) => entry.id);
const source = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');

for (const module of knowledge.moduleCoverage ?? [])
  test(`catalog module: ${module.id}`, () => {
    const { text, requiredIds } = module.probe;
    assert.equal(router.classify(text).requiredReply, true, text);
    for (const id of requiredIds)
      assert.ok(ids(text).includes(id), `${id}: ${ids(text).join(', ')}`);
    for (const id of module.factIds) {
      const fact = knowledge.entries.find((entry) => entry.id === id);
      assert.ok(fact, id);
      for (const path of fact.sources.filter((path) => !path.startsWith('https://')))
        assert.ok(source(path).length, path);
    }
  });

test('network guidance uses the existing home category editor', () => {
  for (const id of ['networks-management', 'networks-compose']) {
    const fact = knowledge.entries.find((entry) => entry.id === id);
    assert.match(fact.answer, /«Изменить состав»/u);
    assert.match(fact.answer, /на главной/u);
    assert.match(fact.answer, /«Готово»/u);
    assert.doesNotMatch(fact.answer, /«В сетке»|«Сохранить состав»|раздел «Состав»/u);
    assert.ok(fact.sources.includes('apps/miniapp/src/pages/chats-page.tsx'));
  }
  assert.match(source('apps/miniapp/src/pages/networks-page.tsx'), /&editCategory=/u);
  assert.match(source('apps/miniapp/src/pages/chats-page.tsx'), /Готово/u);
});

test('the module inventory covers every shared chat and channel settings section', () => {
  const registry = source('apps/miniapp/src/pages/settings/settings-workspace-sections.ts');
  for (const [kind, constant] of [
    ['chat', 'CHAT'],
    ['channel', 'CHANNEL'],
  ]) {
    const block = registry
      .split(`export const NETWORK_${constant}_SETTINGS_SECTIONS = [`)[1]
      .split('] as const')[0];
    const actual = [...block.matchAll(/section: '(\w+)'/gu)].map((match) => match[1]).sort();
    const mapped = knowledge.moduleCoverage.flatMap((module) => module[`${kind}Sections`]).sort();
    assert.deepEqual(mapped, actual, kind);
  }
  const reviewed = knowledge.projectReview.source;
  assert.match(reviewed, /^[a-f0-9]{40}$/u);
  assert.equal(
    new Set(knowledge.moduleCoverage.map((module) => module.id)).size,
    knowledge.moduleCoverage.length,
  );
});

test('poll and giveaway limits and controls are grounded in the product contracts', () => {
  const fact = (id) => knowledge.entries.find((entry) => entry.id === id).answer;
  const poll = source('packages/contracts/src/poll.ts');
  for (const [constant, value] of [
    ['MIN_OPTIONS', '2'],
    ['MAX_OPTIONS', '6'],
    ['QUESTION_MAX_LENGTH', '2_000'],
    ['OPTION_MAX_LENGTH', '80'],
  ])
    assert.ok(poll.includes(`MANAGED_POLL_${constant} = ${value};`));
  assert.match(fact('poll-create'), /от 2 до 6.*2000.*80/u);
  assert.match(fact('poll-create'), /«Опросы» → «Новый»/u);
  assert.match(source('apps/miniapp/src/components/managed-poll-workspace.tsx'), />\s*Новый\s*</u);
  assert.match(fact('poll-voting'), /в том числе от администратора/u);
  assert.match(fact('poll-recovery'), /может создать дубль/u);
  assert.match(source('packages/contracts/src/giveaway.ts'), /MAX_PRIZES = 10/u);
  assert.match(fact('giveaway-create'), /от 1 до 10 мест и до 10 дополнительных каналов/u);
  assert.match(
    fact('giveaway-participation'),
    /заявка и подтверждённый допуск — разные состояния/u,
  );
  assert.match(fact('giveaway-results'), /от 1 до 336 часов/u);
});

const missingModuleCases = [
  ['Что вообще умеет Майор, какие есть модули?', 'project-modules'],
  [
    'Я админ. Как создать один магазин Каравана на несколько моих чатов?',
    'karavan-chat-marketplace',
  ],
  [
    'Караван: подключение магазина не подтвердилось. Создавать второй магазин?',
    'karavan-setup-recovery',
  ],
  [
    'В Караване выбор витрины сохранён, но $ ничего не опубликовал. Что делать?',
    'karavan-storefront-publishing',
  ],
  ['Ластик: «Ожидают, не менее 1000» — это точное число?', 'lastik-diagnostics'],
  [
    'У Ластика «Результат не подтверждён». Значит, сообщение точно не удалено?',
    'lastik-diagnostics',
  ],
  [
    'Ластик пишет «Часть истории ещё не проверена», хотя последний полный обход был. Это нормально?',
    'lastik-diagnostics',
  ],
  ['Как запретить номера телефонов в моём чате?', 'phone-numbers'],
  ['Как включить доступ за приглашения?', 'invitation-access'],
  ['Бот может убирать свои сообщения через время?', 'service-messages-and-bots'],
  ['Как выгонять других ботов из группы?', 'service-messages-and-bots'],
  ['Антидубль: одинаковые картинки от разных людей тоже считает?', 'duplicates-photo'],
  ['Как запретить голосовые и пересылки в моём чате?', 'limits-attachments'],
  ['Жалобы: как удалить историю за 24 часа и ограничить автора?', 'reports-outcomes'],
  ['Где найти карточку участника моего чата?', 'participants'],
  ['Как оставить человека в чате, но на время без сообщений?', 'participant-mute'],
  ['Где посмотреть действующие ограничения и снять бан?', 'sanction-history'],
  ['В базе спама кнопка «Подтвердить спам» сразу удалит человека?', 'spammer-review'],
  ['Как посмотреть статистику моего чата за месяц?', 'chat-statistics'],
  ['Где посмотреть журнал удалений моего чата?', 'chat-events'],
  ['Как создать опрос с шестью вариантами?', 'poll-create'],
  ['В анонимном опросе видно, кто как проголосовал?', 'poll-voting'],
  ['Опрос завис: «Нужна проверка». Жать опубликовать заново?', 'poll-recovery'],
  ['Как создать розыгрыш на десять призовых мест?', 'giveaway-create'],
  [
    'Подписался, но розыгрыш пишет, что допуск не подтверждён. Что делать?',
    'giveaway-participation',
  ],
  ['Победитель розыгрыша не забрал приз. Как выбрать другого?', 'giveaway-results'],
  ['Как сделать кнопку под каждой публикацией канала?', 'channel-post-action'],
  ['Быстрые кнопки: что писать в строке нового поста?', 'channel-quick-buttons'],
  [
    'Предложения в канале: как выбрать отправку в боте и суточный лимит?',
    'channel-suggestions-entry',
  ],
  ['Мини-приложение пишет «Срок входа истёк», что делать?', 'miniapp-relaunch'],
  [
    'Хочу закрыть голосовухи и пересланные посты, а текст оставить. Где выключить?',
    'limits-attachments',
  ],
  ['В рекламе вижу ИИ, хочу сделать его помягче. Куда нажать?', 'commercial-ai-sensitivity'],
  [
    'Мне нужно, чтобы человек пригласил друзей, иначе писать нельзя. Эта функция уже включается?',
    'invitation-access',
  ],
  [
    'Участники хотят пожаловаться на пост. Что им написать боту, чтобы голос учёлся?',
    'community-reports',
  ],
  [
    'Модератор засоряет чат своими ответами. Можно чтоб они через время исчезали?',
    'service-messages-and-bots',
  ],
  [
    'В своём чате не нахожу человека. Где поиск по участникам и как открыть его настройки?',
    'participants',
  ],
  [
    'В ограничениях вижу «Проверить снятие в MAX». Эта кнопка сама разбанит человека?',
    'sanction-history',
  ],
  [
    'Подтвердил спам в очереди. Значит бот уже выгнал этого человека из всех моих чатов?',
    'spammer-review',
  ],
  ['Мне нужна сводка по группе за последние тридцать дней, где её смотреть?', 'chat-statistics'],
  [
    'Как понять по журналу, почему бот удалил конкретный пост? А если журнала вообще не вижу?',
    'chat-events',
  ],
  [
    'Надо, чтобы опубликованный через Публика пост сам удалился позже. Где это задаётся?',
    'publisher-after-publish',
  ],
  ['Есть готовый пост в MAX, как забрать его в редактор Публика?', 'publisher-import-max'],
  [
    'В Публике хочу ответ на ключевую фразу, но чтобы он не спамил каждым совпадением. Что настроить?',
    'publisher-auto-replies-matching',
  ],
  ['Посты VK хочу сначала себе на одобрение, а не сразу в канал. Как включить?', 'vk-review'],
];

for (const [text, expected] of missingModuleCases)
  test(`project module retrieval: ${expected}: ${text}`, () => {
    const route = router.classify(text);
    assert.equal(route.eligible, true);
    assert.equal(route.requiredReply, true);
    assert.ok(ids(text).includes(expected), `${expected}: ${ids(text).join(', ')}`);
  });

test('short followups retain the module, but completed tasks and ordinary conversation do not', () => {
  for (const [question, followup, expected] of [
    ['Как создать опрос?', 'А имена кто увидит?', 'poll-voting'],
    ['Как запустить розыгрыш?', 'А победителя можно заменить?', 'giveaway-results'],
    ['Где карточка участника?', 'А как временно запретить ему писать?', 'participant-mute'],
    ['Как включить быстрые кнопки?', 'А что писать в строке?', 'channel-quick-buttons'],
  ]) {
    const history = [{ role: 'user', text: question }];
    assert.equal(router.classify(followup, history).requiredReply, true, followup);
    assert.ok(ids(followup, history).includes(expected), followup);
  }
  const history = [{ role: 'user', text: 'Как запустить розыгрыш?' }];
  assert.ok(
    !ids('С розыгрышем разобрался. Теперь как создать опрос?', history).includes('giveaway-create'),
  );
  assert.equal(router.classify('Спасибо, получилось!', history).eligible, false);
});

test('described word-to-response requests retrieve Publik auto-replies without a feature name', () => {
  for (const text of [
    'Здравствуйте . подскажите можно ли в данном боте сделать к примеру привязку к слово к примеру человек пишет слова группы и ему приходит список групп который к примеру админ сделал',
    'Можно привязать к слову «группы», чтобы человеку приходил список ссылок, который я написал?',
    'Хочу, чтобы человек пишет «прайс», а бот присылает мой текст с ценами',
    'Как сделать триггер на слово, чтобы бот ответил списком ссылок?',
    'В боте как сделать чтоб написали адрес и он выдал мой текст с адресом офиса, который я сам заранее добавлю?',
    'Как в Публике завести триггер «каталог», чтобы отправлял мой готовый текст и фотографию?',
    'В Майоре можно сделать ответ по слову «правила», чтобы бот отправлял мой текст?',
    'Как привязать к слову «группы», чтобы бот отправлял список, но не удалял сообщения?',
    'Как сделать, чтобы бот на слово «правила» отвечал моим текстом, и как удалять сообщения со спамом?',
  ]) {
    const route = router.classify(text);
    assert.equal(route.requiredReply, true, text);
    assert.equal(route.publisherRequest, true, text);
    assert.equal(ids(text)[0], 'publisher-auto-replies-create', text);
    assert.equal(ids(text).includes('networks-compose'), false, text);
    assert.equal(router.classify(text, [], { replyToOther: true }).eligible, false, text);
  }
  const history = [
    { role: 'user', text: 'Как сделать триггер: слово «группы» — бот присылает список?' },
  ];
  assert.ok(
    ids('А если слово внутри длинного сообщения?', history).includes(
      'publisher-auto-replies-matching',
    ),
  );
  const followup = 'А если отвечать только когда сообщение целиком «меню», какую галочку убрать?';
  assert.equal(router.classify(followup, history).requiredReply, true);
  assert.ok(ids(followup, history).includes('publisher-auto-replies-matching'));
  assert.equal(router.classify('Спасибо, получилось!', history).eligible, false);
});

test('auto-reply descriptions preserve moderation, other modules and human conversations', () => {
  for (const [text, expected] of [
    ['Как сделать триггер стоп-слова, чтобы бот удалял сообщение?', 'stop-words'],
    ['Быстрые кнопки: что писать в строке нового поста?', 'channel-quick-buttons'],
    ['В сетке где статистика аудитории всех групп?', 'networks-audience-statistics'],
    ['Как настроить обязательную подписку на канал?', 'subscription'],
  ]) {
    assert.ok(ids(text).includes(expected), `${text}: ${ids(text).join(', ')}`);
    assert.equal(
      ids(text).some((id) => id.startsWith('publisher-auto-replies-')),
      false,
      text,
    );
  }
  for (const text of [
    'Меня это триггерит',
    'Лена, ты пишешь слово, а я присылаю список, договорились?',
  ])
    assert.equal(router.classify(text).eligible, false, text);
  for (const text of [
    'Можно сделать, чтобы бот на слово «вопрос» отвечал сам через ИИ, каждый раз новым текстом?',
    'Как сделать чтобы бот по слову «курс» отправлял текущий курс доллара из интернета?',
    'Как сделать, чтобы бот на стоп-слова отвечал предупреждением и удалял сообщение?',
  ])
    assert.equal(router.classify(text).publisherRequest, false, text);
});

test('module context does not replace an independent question or the support role boundary', () => {
  const combined = ids('Я админ: как создать опрос и подключить Ластика для старых сообщений?');
  assert.ok(combined.includes('poll-create'));
  assert.ok(combined.includes('lastik-connect'));
  for (const text of [
    'Я участник, куда выложить объявление?',
    'Почему снесли мою объяву в чужой группе?',
  ]) {
    assert.ok(
      !ids(text).some((id) => /^(?:poll|giveaway|participant-mute|project-modules)/u.test(id)),
    );
  }
  assert.equal(router.classify('Как приготовить борщ?').eligible, false);
  assert.ok(!ids('В Публике хочу автоответ, но чтобы не спамил.').includes('spammer-review'));
  assert.ok(!ids('Ластик сохраняет объявления розыгрышей?').includes('giveaway-create'));
  for (const text of [
    'Ластик: сохранение пока не подтверждено. Где нажать проверить сохранение?',
    'Ластик: результат сохранения не подтверждён. Нужно нажать проверить сохранение?',
    'Ластик должен хранить сообщения не менее 48 часов. Как это настроить?',
  ])
    assert.ok(!ids(text).includes('lastik-diagnostics'), text);
  assert.ok(
    !ids('Караван: подключение магазина не подтвердилось. Создавать второй магазин?').includes(
      'karavan-chat-marketplace',
    ),
  );
  const createAndRecover = ids(
    'Я админ. Как создать магазин Каравана и что делать при частичном подключении чатов?',
  );
  assert.ok(createAndRecover.includes('karavan-chat-marketplace'));
  assert.ok(createAndRecover.includes('karavan-setup-recovery'));
});
