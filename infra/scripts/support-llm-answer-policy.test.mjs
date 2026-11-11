import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import {
  answerSupport,
  classifySupportRequest,
  knowledge,
  selectKnowledge,
  validateSupportAnswer,
} from './support-llm-client.mjs';
import { SUPPORT_MODEL } from './support-llm-profile.mjs';

const selected = knowledge.entries.filter((entry) => ['bots', 'operator'].includes(entry.id));

test('visible AI identity cannot be contradicted by a human claim before the footer', () => {
  for (const text of [
    'Ответ подготовлен живым сотрудником, а не ИИ.',
    'Я настоящий человек.',
    'Я — оператор.',
    'Я ваш оператор поддержки.',
    'С вами живой сотрудник поддержки.',
    'Мы сотрудники поддержки.',
    'Я не ИИ, сейчас всё проверю.',
    'Этот текст написан чел**ов**еком.',
  ])
    assert.throws(
      () => validateSupportAnswer({ action: 'reply', text, sourceIds: ['operator'] }, selected),
      /support_response_identity/u,
      text,
    );
  for (const text of [
    'Я ИИ-помощник «Майор Максимов».',
    'Я не живой сотрудник. Оператор может уточнить условия здесь.',
    'Обратитесь к администраторам именно той группы.',
  ])
    assert.equal(
      validateSupportAnswer({ action: 'reply', text, sourceIds: ['operator'] }, selected).action,
      'reply',
    );
});

test('internal source metadata never becomes a public answer', () => {
  for (const text of [
    'Откройте бота. sourceIds: ["operator"]',
    'Источники: [bots, operator]',
    'Источник: operator',
  ])
    assert.throws(
      () => validateSupportAnswer({ action: 'reply', text, sourceIds: ['operator'] }, selected),
      /support_response_internal/u,
    );
  assert.equal(
    validateSupportAnswer(
      {
        action: 'reply',
        text: 'Оператор этого чата может уточнить условия.',
        sourceIds: ['operator'],
      },
      selected,
    ).action,
    'reply',
  );
});

test('one context decision controls eligibility, role and the required-reply schema', async (t) => {
  let request;
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const input = JSON.parse(raw);
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/tokenize') return res.end(JSON.stringify({ tokens: [1] }));
    request = input;
    res.end(
      JSON.stringify({
        model: SUPPORT_MODEL.alias,
        choices: [
          {
            finish_reason: 'stop',
            message: { content: JSON.stringify({ action: 'skip', text: '', sourceIds: [] }) },
          },
        ],
      }),
    );
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  const history = [
    { role: 'user', text: 'Как включить защиту участника от удалений Майора?' },
    { role: 'assistant', text: 'Включите «Защиту» в карточке участника.' },
  ];
  const text = 'Тогда включите её за меня.';
  const decision = classifySupportRequest(text, history);
  assert.equal(decision.eligible, true);
  assert.equal(decision.requiredReply, true);
  await assert.rejects(
    answerSupport({
      text,
      history,
      key: 'fixture',
      endpoint: `http://127.0.0.1:${server.address().port}`,
    }),
    /support_response_required/u,
  );
  assert.deepEqual(request.response_format.json_schema.schema.properties.action.enum, ['reply']);
  assert.equal(JSON.parse(request.messages[1].content).role, decision.role);
  for (const [question, expectedSources] of [
    [
      'Я администратор. У ИИ-модерации рекламы стоит «Тест». И ещё как запретить ссылки в нашем чате?',
      ['commercial-ai-observation', 'links-policy'],
    ],
    [
      'Где чувствительность ИИ-модерации рекламы и как включить ночное расписание?',
      ['commercial-ai-sensitivity', 'night'],
    ],
    [
      'Я участник. Как разместить объявление в группе? И какие сейчас тарифы у ваших ботов?',
      ['support-room', 'prices-and-free-claims'],
    ],
  ]) {
    request = null;
    await assert.rejects(
      answerSupport({
        text: question,
        key: 'fixture',
        endpoint: `http://127.0.0.1:${server.address().port}`,
      }),
      /support_response_required/u,
    );
    assert.ok(request, 'mixed requests must reach inference');
    const facts = [
      ...JSON.parse(request.messages[0].content.split('\n').at(-1)).baselineFacts,
      ...JSON.parse(request.messages[1].content).verifiedKnowledge,
    ];
    for (const id of expectedSources)
      assert.ok(
        facts.some((fact) => fact.id === id),
        id,
      );
  }
});

test('unknown roles stay distinct from explicit members and later role changes win', () => {
  const unknown = classifySupportRequest('Как разместить объявление в группе?');
  assert.equal(unknown.role, 'unknown');
  assert.equal(unknown.participantAdvertisement, false);
  assert.equal(unknown.requiredReply, true);
  for (const text of [
    'Друзья админа удалили объявление. Как его вернуть?',
    'Хочу выложить объявления администратора группы',
    'У меня админ спрашивает, как разместить пост',
  ])
    assert.equal(classifySupportRequest(text).role, 'unknown', text);
  const member = classifySupportRequest('Я участник, как разместить объявление?');
  assert.equal(member.role, 'member');
  assert.equal(member.participantAdvertisement, true);
  const admin = classifySupportRequest('Теперь я администратор. Где настроить удаление постов?', [
    { role: 'user', text: 'Я участник группы.' },
    { role: 'assistant', text: 'За размещением обратитесь к администрации этой группы.' },
  ]);
  assert.equal(admin.role, 'admin');
  assert.equal(admin.participantAdvertisement, false);
});

test('support audit retains a colloquial member role and meaningful removal followups', () => {
  const history = [
    { role: 'user', text: 'Нет я подписчики просто, хочу все свои объявления удалить' },
    { role: 'assistant', text: 'Обратитесь к администраторам группы, где разместили объявления.' },
  ];
  for (const text of ['Как у меня не получается удалить свои объявления', 'Удалить будет да']) {
    const result = classifySupportRequest(text, history);
    assert.equal(result.eligible, true, text);
    assert.equal(result.role, 'member', text);
    assert.equal(result.participantAdvertisement, true, text);
  }
});

test('access symptoms select prerequisites instead of a premature operator handoff', () => {
  for (const text of [
    'Не вижу журнал своего чата',
    'Нет доступа к настройкам',
    'События недоступны, что делать?',
  ]) {
    const result = classifySupportRequest(text);
    assert.equal(result.eligible, true, text);
    assert.ok(!result.primaryIds.includes('support-incident-evidence'), text);
    const ids = selectKnowledge(text).map((x) => x.id);
    assert.ok(ids.includes('community-access') || ids.includes('miniapp-relaunch'), text);
  }
  assert.equal(
    classifySupportRequest('Какие данные прислать оператору для разбора ошибки?').primaryIds[0],
    'support-incident-evidence',
  );
});

test('unaddressed peer advice stays silent while personal and addressed requests remain eligible', async () => {
  for (const text of [
    'Установите бота, дайте нужные права в админах, напишите старт в группе и уже в настройках запретите ссылку на впн',
    'А вы в комментариях включите От имени бота',
    'А вам кто-то мешает писать через бот Публик?',
  ]) {
    assert.equal(classifySupportRequest(text).eligible, false, text);
    assert.equal((await answerSupport({ text, endpoint: 'http://127.0.0.1:1' })).action, 'skip');
    assert.equal(
      classifySupportRequest(text, [], { addressedToSupport: true }).eligible,
      true,
      text,
    );
  }
  for (const text of [
    'Включите мне ночной режим',
    'Как мне включить комментарии в Публике?',
    'Проверьте права моего бота',
  ])
    assert.equal(classifySupportRequest(text).eligible, true, text);
});

test('support paraphrases retrieve the actual feature and relevant failure prerequisites', () => {
  for (const [text, id] of [
    ['Как запретить конкретное слово в сообщениях?', 'stop-words'],
    ['Через Публика как человеку предложить запись в мой канал?', 'publisher-suggestions-entry'],
    ['Бот пропускает ссылки, хотя раньше удалял', 'max-delete-rights'],
  ])
    assert.ok(
      selectKnowledge(text).some((x) => x.id === id),
      text,
    );
  assert.ok(
    !selectKnowledge('Через Публика как человеку предложить запись в мой канал?').some(
      (x) => x.id === 'channel-suggestions-entry',
    ),
  );
});

test('support audit boundaries preserve direct help and new unrelated subjects', () => {
  for (const text of [
    'Вы можете помочь?',
    'Вы можете проверить, почему бот не работает?',
    'Как подключить бота в чат яхт-клуба?',
    'Как запретить в чате фразу «заказал эскорт»?',
  ])
    assert.equal(classifySupportRequest(text).eligible, true, text);
  const history = [
    { role: 'user', text: 'Я участник группы, хочу удалить своё объявление.' },
    { role: 'assistant', text: 'Попросите администрацию группы.' },
  ];
  for (const text of [
    'Можно удалить пятно с пальто?',
    'Как удалить файлы с компьютера?',
    'Удалить будет да',
  ])
    assert.equal(classifySupportRequest(text, history).eligible, text === 'Удалить будет да', text);
  assert.equal(
    classifySupportRequest('Бот заказал шлюх на мою яхту что мне делать').eligible,
    false,
  );
  for (const text of ['Мои подписчики ищут объявления', 'Я подписчиков ищу'])
    assert.equal(classifySupportRequest(text).role, 'unknown');
});

test('addressed contextual observations keep the actual task instead of generic help', () => {
  const history = [
    { role: 'user', text: 'Я владелица канала, включила приём материалов у Публика.' },
    { role: 'assistant', text: 'Под публикацией Публика доступна кнопка отправки предложений.' },
  ];
  const text = 'Теперь для каждого читателя надо отдельно выкладывать новую запись с этой кнопкой?';
  assert.equal(classifySupportRequest(text, history, { addressedToSupport: true }).eligible, true);
  assert.equal(
    selectKnowledge(text, history, { addressedToSupport: true })[0].id,
    'publisher-suggestions-entry',
  );
  const failure = 'Дошёл до пересылки, получил отказ проверки доступа. Команда в группе уже была.';
  assert.equal(
    classifySupportRequest(
      failure,
      [{ role: 'user', text: 'Как подключить Максимова к моей группе?' }],
      { addressedToSupport: true },
    ).eligible,
    true,
  );
});

test('confirmed yes/no role answers remain meaningful on later troubleshooting turns', () => {
  const history = [
    { role: 'user', text: 'Бот не удаляет спам' },
    { role: 'assistant', text: 'Вы администратор группы?' },
    { role: 'user', text: 'Да' },
    { role: 'assistant', text: 'Проверьте права бота.' },
  ];
  assert.equal(classifySupportRequest('Не помогло', history).role, 'admin');
  assert.equal(classifySupportRequest('Теперь я участник', history).role, 'member');
  assert.ok(
    selectKnowledge('Здравствуйте можно бот поставить от ботов которые скидывают впн?').some(
      (x) => x.id === 'service-messages-and-bots',
    ),
  );
});
