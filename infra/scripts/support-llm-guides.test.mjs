import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classifySupportRequest, knowledge } from './support-llm-client.mjs';
import { selectSupportOnboardingGuide } from './support-llm-guides.mjs';

function select(text, { history = [], interaction, catalog = knowledge } = {}) {
  return selectSupportOnboardingGuide({
    text,
    history,
    request: classifySupportRequest(text, history, interaction),
    knowledge: catalog,
  });
}

test('every explicit bot setup or addition selects the matching reviewed card pack', () => {
  for (const [id, texts] of [
    [
      'moderator-group',
      [
        'Как подключить бота?',
        'Как подключается бот?',
        'Можно ли добавить бота в чат?',
        'Что нужно для подключения бота?',
        'Как пригласить бота?',
        'Где инструкция добавления бота?',
        'Как добавить бота в группу?',
        'Как подключить Майора?',
        'Пришли инструкцию по подключению Максимова к группе.',
        'Я администратор. Как добавить Рэкса в группу?',
        'Как подключить Майора к каналу?',
        'Не могу добавить бота в группу: MAX запрещает добавление.',
        'Как подключить Майора к группе и настроить антимат?',
        'Подключи бота к группе.',
        'Как подключить Ластика?',
        'Как подключить бота Ластика?',
        'Публик уже работает; как подключить Ластика?',
        'Чем Публик отличается от Ластика и как подключить Ластика?',
      ],
    ],
    [
      'publisher-group',
      [
        'Как подключить Публика к группе?',
        'Как подключается Публик?',
        'Как подключают Публика?',
        'Как подключить бота Публика?',
        'Как добавить бота se14088825_bot?',
        'Пришли инструкцию по подключению Публика.',
        'Я администратор. Как добавить Публика в чат?',
        'Как подключить Публика к каналу?',
        'Не могу подключить Публика к группе. Пришли картинки.',
        'Как подключить Публика и настроить расписание публикаций?',
        'Как подключить se14088825_bot к группе?',
        'Как добавить https://max.ru/se14088825_bot в чат?',
        'Майор уже подключён, как добавить Публика?',
      ],
    ],
  ])
    for (const text of texts) assert.equal(select(text)?.id, id, text);
});

test('explicit image followups use the latest confirmed setup pair, including the actual incident', () => {
  for (const [question, id] of [
    ['Как подключить бота?', 'moderator-group'],
    ['Как подключить Публика к группе?', 'publisher-group'],
  ]) {
    const history = [
      { role: 'user', text: question },
      {
        role: 'assistant',
        text: 'Если у вас есть права администратора, подключите бота по шагам. Для канала перешлите пост.',
      },
    ];
    for (const text of [
      'А где картинки?',
      'Можешь прикрепить карточки?',
      'Пришли картинки, пожалуйста.',
    ])
      assert.equal(
        select(text, { history, interaction: { addressedToSupport: true } })?.id,
        id,
        text,
      );
  }
});

test('packs preserve opt-outs, human addressing and the object of the requested action', () => {
  const setup = [
    { role: 'user', text: 'Как подключить бота?' },
    { role: 'assistant', text: 'Добавьте модератора администратором.' },
  ];
  for (const scenario of [
    { text: 'Ирина, как подключить Майора к группе?', interaction: { replyToOther: true } },
    { text: 'Как подключить Публика к группе?', interaction: { replyToOther: true } },
    { text: 'А где картинки?', history: setup, interaction: { replyToOther: true } },
    { text: 'Обсуждали, как подключить Майора к группе, сегодня всё получилось.' },
    { text: 'Как в Публике добавить фото в пост?' },
    { text: 'Как добавить в Публик фото?' },
    { text: 'Как добавить в пост Публика фото?' },
    { text: 'Как добавить получателя в пост Публика?' },
    { text: 'Как подключить группу VK в Публике?' },
    { text: 'Я уже подключил Публика к группе, как создать пост?' },
    { text: 'Как сменить выбранного модератора на Рэкса?' },
    { text: 'Как подключить бота? Только текстом, без картинок.' },
    { text: 'Как подключить Публика к группе? Без карточек, пожалуйста.' },
    { text: 'Как подключить Публика к группе? Не скидывай картинки.' },
    { text: 'Как подключить Майора к группе? Без пачки изображений.' },
    { text: 'Как подключить Майора к группе? Не кидайте карточки.' },
    { text: 'Как подключить бота? Не нужно присылать картинки.' },
    { text: 'Как подключить бота? Картинки не нужны.' },
    { text: 'А где картинки? Нет, только текстом.', history: setup },
    { text: 'А где картинки?' },
    {
      text: 'А где картинки?',
      history: setup.slice(0, 1),
      interaction: { addressedToSupport: true },
    },
    {
      text: 'А где картинки?',
      history: [
        { role: 'user', text: 'Как создать пост в Публике?' },
        { role: 'assistant', text: 'Для подключения бота есть карточки.' },
      ],
      interaction: { addressedToSupport: true },
    },
    {
      text: 'А где картинки?',
      history: [
        ...setup,
        { role: 'user', text: 'Как изменить расписание ночного режима?' },
        { role: 'assistant', text: 'Откройте ночной режим.' },
      ],
      interaction: { addressedToSupport: true },
    },
  ])
    assert.equal(select(scenario.text, scenario), null, scenario.text);
});

test('image-only shortcuts require a complete positive image request', () => {
  const history = [
    { role: 'user', text: 'Как подключить бота?' },
    { role: 'assistant', text: 'Добавьте модератора администратором.' },
  ];
  for (const text of [
    'Пришли картинки и отключи антимат',
    'А где картинки? И как выключить антимат?',
  ]) {
    const guide = select(text, { history, interaction: { addressedToSupport: true } });
    assert.equal(guide?.id, 'moderator-group', text);
    assert.equal(guide?.imageOnly, false, text);
    assert.equal(guide?.atomic, false, text);
  }
});

test('a named Lastik object preserves its scope after generic bot wording and other product names', () => {
  for (const text of [
    'Как подключить бота Ластика?',
    'Публик уже работает; как подключить Ластика?',
    'Чем Публик отличается от Ластика и как подключить Ластика?',
  ]) {
    const guide = select(text);
    assert.equal(guide?.id, 'moderator-group', text);
    assert.equal(guide?.lastik, true, text);
    assert.equal(guide?.atomic, false, text);
  }
});

test('guide selection fails closed when reviewed caption or fact identity is missing', () => {
  const original = knowledge.onboardingGuides.find((guide) => guide.id === 'publisher-group');
  for (const entry of [
    undefined,
    { ...original, caption: '' },
    { ...original, caption: 'я'.repeat(601) },
    { ...original, sourceIds: ['connect'] },
    { ...original, sourceIds: ['publik', 'operator'] },
  ])
    assert.equal(
      select('Как подключить Публика к группе?', {
        catalog: { onboardingGuides: entry ? [entry] : [] },
      }),
      null,
    );
});

test('reviewed packs pin eleven ordered photos without exporting attachment credentials', () => {
  assert.equal(knowledge.onboardingGuides.length, 2);
  assert.deepEqual(knowledge.onboardingGuides.map(({ id }) => id).sort(), [
    'moderator-group',
    'publisher-group',
  ]);
  const photoIds = new Set();
  for (const guide of knowledge.onboardingGuides) {
    assert.equal(guide.sourceBotId, 'id613070470872_9_bot');
    assert.equal(guide.sourceChatId, '-78271094414679');
    assert.deepEqual(guide.sourceIds, [guide.id === 'moderator-group' ? 'connect' : 'publik']);
    assert.ok(guide.caption.length <= 600);
    assert.match(guide.caption, /11 карточек по порядку/u);
    assert.match(guide.caption, /администратор/u);
    assert.match(guide.caption, /«Старт».*(?:личк|пересыл)/iu);
    assert.match(guide.caption, /провер/iu);
    assert.deepEqual(
      guide.sourceMessages.map(({ photos }) => photos.length),
      [10, 1],
    );
    for (const message of guide.sourceMessages) {
      assert.deepEqual(Object.keys(message).sort(), ['forwardedMessageId', 'messageId', 'photos']);
      assert.match(message.messageId, /^mid\.[a-f\d]{32}$/u);
      assert.match(message.forwardedMessageId, /^mid\.[a-f\d]{32}$/u);
      for (const photo of message.photos) {
        assert.deepEqual(Object.keys(photo).sort(), ['photoId', 'sha256']);
        assert.match(photo.photoId, /^\d+$/u);
        assert.match(photo.sha256, /^[a-f\d]{64}$/u);
        assert.equal(photoIds.has(photo.photoId), false);
        photoIds.add(photo.photoId);
      }
    }
  }
  assert.equal(photoIds.size, 22);
});
