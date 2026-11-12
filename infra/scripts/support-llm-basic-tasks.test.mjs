import assert from 'node:assert/strict';
import test from 'node:test';
import { knowledge, classifySupportRequest, selectKnowledge } from './support-llm-client.mjs';

const user = (text) => ({ role: 'user', text });
const assistant = (text) => ({ role: 'assistant', text });
const ids = (text, history = []) => selectKnowledge(text, history).map(({ id }) => id);

test('ordinary bot removal selects membership help rather than onboarding or message deletion', () => {
  for (const text of [
    'А как удалить бота?',
    'Как убрать Майора из чата?',
    'Я админ. Как выгнать Публика из группы?',
    'Бота можно удалить как обычного участника?',
    'Удалить бота через участников можно?',
    'Как удалить Ластика из группы?',
  ]) {
    assert.equal(classifySupportRequest(text).requiredReply, true, text);
    assert.equal(ids(text)[0], 'max-remove-bot-group', text);
    for (const unrelated of ['connect', 'max-bot-token-and-ownership', 'announcement-removal'])
      assert.ok(!ids(text).includes(unrelated), `${text}: ${unrelated}`);
  }
});

test('removing the bot is a new task and short followups keep its membership context', () => {
  const setup = [user('Как подключить Майора?'), assistant('Добавьте бота администратором.')];
  assert.equal(ids('Как удалить его?', setup)[0], 'max-remove-bot-group');
  const removal = [user('Как удалить бота из группы?'), assistant('Найдите бота в участниках.')];
  assert.equal(ids('Нет кнопки удалить', removal)[0], 'max-remove-bot-group');
  assert.equal(
    ids('Как убрать бота из группы?', [
      user('Как настроить антимат?'),
      assistant('Откройте фильтр.'),
    ])[0],
    'max-remove-bot-group',
  );
  assert.notEqual(ids('Как удалить его?', [user('Как удалить пост?')])[0], 'max-remove-bot-group');
  assert.notEqual(
    ids('Нет кнопки удалить', [...removal, user('Всё получилось, спасибо')])[0],
    'max-remove-bot-group',
  );
});

test('private bot stop, restoration and adjacent product tasks retain separate instructions', () => {
  assert.equal(ids('Как удалить личный чат с ботом у себя?')[0], 'max-stop-private-bot');
  assert.equal(ids('Как запретить боту писать мне в личку?')[0], 'max-stop-private-bot');
  assert.equal(
    ids(
      'Своего бота на платформе я удалять НЕ хочу. Хочу только остановить его сообщения лично мне. Как отключить личку?',
    )[0],
    'max-stop-private-bot',
  );
  assert.equal(
    ids(
      'Я владелец группы, Максимов у меня администратор. Надо полностью исключить его из этой группы, а не просто лишить прав. Подскажите порядок.',
    )[0],
    'max-remove-bot-group',
  );
  const recovery = 'Случайно удалила бота из группы, как вернуть и подключить?';
  assert.ok(ids(recovery).includes('connect'));
  assert.ok(!ids(recovery).includes('max-remove-bot-group'));
  for (const [text, fact] of [
    ['Как выгонять других ботов из группы?', 'service-messages-and-bots'],
    ['Бот может убирать свои сообщения через время?', 'service-messages-and-bots'],
    ['Как отключить удаление старых сообщений Ластиком?', 'message-retention'],
    ['Как сменить модератора чата?', 'choose-moderator'],
    ['Как поменять никнейм собственного бота?', 'max-bot-token-and-ownership'],
  ]) {
    assert.ok(ids(text).includes(fact), text);
    assert.ok(!ids(text).includes('max-remove-bot-group'), text);
  }
  assert.equal(
    classifySupportRequest('Удалите бота как обычного участника', [], { replyToOther: true })
      .eligible,
    false,
  );
});

test('antiduplicate periods are available from everyday descriptions and keep night closure separate', () => {
  for (const text of [
    'Как сделать, чтобы антидубль работал с открытия группы до закрытия?',
    'В антидубле есть По времени?',
    'Можно разрешить повторы ночью, а днем удалять?',
    'Антидубль на 16 часов — это с начала календарного дня?',
  ]) {
    assert.equal(classifySupportRequest(text).requiredReply, true, text);
    assert.ok(ids(text).includes('duplicates-period'), text);
    assert.ok(!ids(text).includes('night'), text);
  }
  const mixed = ids('Как включить антидубль по расписанию и закрывать чат на ночь?');
  assert.ok(mixed.includes('duplicates-period'));
  assert.ok(mixed.includes('night'));
});

test('saved draft deletion, editor clearing and copying a post have their actual procedures', () => {
  for (const [text, expected] of [
    ['Как почистить черновики в публике постов?', 'publisher-draft-delete'],
    [
      'В Публике накопились ненужные заготовки постов. Как убрать одну из списка черновиков?',
      'publisher-draft-delete',
    ],
    ['Как черновик убрать из сохраненных?', 'publisher-draft-delete'],
    ['Как удалить сохраненный черновик?', 'publisher-draft-delete'],
    ['Как очистить открытый черновик в редакторе Публика?', 'publisher-draft-clear'],
    [
      'В Публике уже открыт черновик. Запись из списка НЕ удаляйте: надо очистить только его текст и вложения и начать заново. Что выбрать?',
      'publisher-draft-clear',
    ],
    ['Как дублировать пост чтобы настроить заново время?', 'publisher-copy'],
  ]) {
    assert.equal(classifySupportRequest(text).requiredReply, true, text);
    assert.equal(ids(text)[0], expected, text);
    assert.ok(!ids(text).includes('duplicates'), text);
    assert.ok(!ids(text).includes('publisher-delivery-status'), text);
  }
  const mixed = ids(
    'Не могу отправить копию поста, результат отправки неизвестен. Как удалить черновик?',
  );
  assert.ok(mixed.includes('publisher-delivery-status'));
  assert.ok(mixed.includes('publisher-draft-delete'));
});

test('procedural advice stays silent while personal or addressed bot-removal requests receive help', () => {
  const advice = 'Удалите бота из участников как обычного человека, сначала снимите админа.';
  assert.equal(classifySupportRequest(advice).eligible, false);
  for (const text of [
    'Мне нужно удалить бота из участников, сначала снимите админа.',
    'Удалите бота из участников, сначала снимите админа — как это сделать?',
    'Как убрать бота из группы?',
  ])
    assert.equal(classifySupportRequest(text).requiredReply, true, text);
  assert.equal(
    classifySupportRequest(advice, [], { addressedToSupport: true }).requiredReply,
    true,
  );
});

test('reviewed basic procedures retain prerequisites and scopes', () => {
  const fact = (id) => knowledge.entries.find((entry) => entry.id === id)?.answer ?? '';
  assert.match(fact('max-remove-bot-group'), /администратор|владелец/iu);
  assert.match(
    fact('max-remove-bot-group'),
    /участник.*Android.*Удалить участника.*Web.*Удалить.*iOS/su,
  );
  assert.match(fact('max-stop-private-bot'), /«Ещё».*«Удалить и остановить»/su);
  assert.match(fact('duplicates-period'), /«По времени».*«С».*«По».*«Часовой пояс»/su);
  assert.match(fact('duplicates-period'), /от 1 до 48.*первого/iu);
  assert.match(fact('publisher-draft-delete'), /всех устройствах/iu);
  assert.match(fact('publisher-copy'), /расписание.*заново.*не публикует/isu);
});

test('membership scopes cannot replace post deletion, selected profiles or retained membership', () => {
  for (const text of [
    'Как удалить публикацию?',
    'Как удалить публикацию Публика?',
    'Как удалить последнее сообщение бота?',
    'Как убрать ответ бота?',
    'Как удалить в группе все сообщения бота?',
    'Как убрать бота из админов, оставив в участниках?',
  ]) {
    for (const id of ['max-remove-bot-group', 'max-delete-owned-bot'])
      assert.ok(!ids(text).includes(id), `${text}: ${id}`);
  }
  for (const text of [
    'Как удалить своего бота из группы?',
    'Как удалить собственного бота только из этой группы?',
    'Как убрать бота из моей группы, он пишет мне в личку?',
    'Как убрать бота с правами администратора?',
    'Как удалить бота без удаления его на платформе?',
    'Как удалить бота, но не на платформе?',
    'Как удалить собственного бота?',
  ])
    assert.equal(ids(text)[0], 'max-remove-bot-group', text);
  for (const name of ['Публика', 'Ластика', 'Рэкса 2'])
    assert.ok(!ids(`Дайте ссылку на бота ${name}`).includes('moderator-profile'), name);
  for (const [text, id] of [
    ['Случайно удалил Публика из группы, как вернуть?', 'publik'],
    ['Случайно удалила Ластика, как подключить обратно?', 'lastik-connect'],
  ]) {
    assert.ok(ids(text).includes(id));
    assert.ok(!ids(text).includes('moderator-profile'));
    assert.ok(!ids(text).includes('connect'));
  }
  assert.equal(ids('Как удалить собственного бота из канала?')[0], 'max-remove-bot-channel');
  assert.ok(!ids('Как удалить собственного бота из канала?').includes('max-delete-owned-bot'));
});

test('independent requests survive a bot lifecycle question', () => {
  for (const [text, expected] of [
    ['Как удалить бота из группы и где найти мут?', 'participant-mute'],
    ['Как удалить бота из группы? Еще как настроить антимат?', 'profanity-sensitivity'],
    ['Как убрать бота и удалить старые сообщения?', 'message-retention'],
  ]) {
    assert.ok(ids(text).includes('max-remove-bot-group'), text);
    assert.ok(ids(text).includes(expected), `${text}: ${ids(text)}`);
  }
  const periods = ids('Как антидубль настроить днем, а группу закрывать ночью?');
  assert.ok(periods.includes('duplicates-period'));
  assert.ok(periods.includes('night'));
  const drafts = ids('Как очистить открытый черновик и удалить сохраненный черновик?');
  assert.ok(drafts.includes('publisher-draft-clear'));
  assert.ok(drafts.includes('publisher-draft-delete'));
  assert.ok(
    ids(
      'Как убрать бота из группы и удалить уже отправленный пост с неизвестным результатом?',
    ).includes('publisher-delivery-status'),
  );
  assert.equal(ids('Бота удалять не хочу. Как очистить черновик?')[0], 'publisher-draft-clear');
  assert.ok(
    !ids('Как настроить Публика, чтобы повторы выходили каждый день?').includes(
      'duplicates-period',
    ),
  );
  assert.equal(classifySupportRequest('Я удалил бота. Спасибо, всё получилось.').eligible, false);
});

test('an unidentified media editor gets clarification without fabricated Publisher limits', () => {
  const text = 'Загружаю фото, а отправляются не все и ещё перевёрнутые, что делать?';
  assert.equal(classifySupportRequest(text).requiredReply, true);
  assert.deepEqual(ids(text), ['support-dialogue', 'support-room', 'operator']);
  assert.ok(
    ids('В Публике загружаю фото, отправляются не все. Почему?').includes('publisher-post-media'),
  );
});

test('basic message and repeating-post requests cannot fall back to unrelated products', () => {
  assert.deepEqual(ids('Как убрать ответ бота?'), ['support-dialogue', 'support-room', 'operator']);
  assert.ok(
    ids('Как настроить повторы постов каждый день?').includes('publisher-schedule-recurrence'),
  );
  assert.ok(!ids('Как настроить повторы постов каждый день?').includes('duplicates-period'));
});
