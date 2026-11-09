import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classifySupportRequest, knowledge } from './support-llm-client.mjs';
import { selectSupportOnboardingGuide } from './support-llm-guides.mjs';

function select(text, { history = [], interaction, catalog = knowledge } = {}) {
  return selectSupportOnboardingGuide({
    text,
    request: classifySupportRequest(text, history, interaction),
    knowledge: catalog,
  });
}

test('current named group setup requests select the matching reviewed card pack', () => {
  for (const [id, texts] of [
    [
      'moderator-group',
      [
        'Как подключить Майора к группе?',
        'Пришли инструкцию по подключению Максимова к группе.',
        'Как подключить Максимову к группе?',
        'Я администратор. Как добавить Рэкса в группу?',
      ],
    ],
    [
      'publisher-group',
      [
        'Как подключить Публика к группе?',
        'Пришли инструкцию по подключению Публика.',
        'Пришли картинки с инструкцией по подключению Публика к группе.',
        'Я администратор. Как добавить Публика в чат?',
      ],
    ],
  ])
    for (const text of texts) assert.equal(select(text)?.id, id, text);
});

test('card requests preserve quiet routing and current product boundaries', () => {
  for (const scenario of [
    { text: 'Ирина, как подключить Майора к группе?' },
    { text: 'Как подключить Публика к группе?', interaction: { replyToOther: true } },
    { text: 'Обсуждали, как подключить Майора к группе, сегодня всё получилось.' },
    { text: 'Как подключить бота в группу?' },
    { text: 'Как подключить Майора?' },
    { text: 'Как подключить Майора к каналу?' },
    { text: 'Как подключить Публика к каналу? Пришли картинки.' },
    { text: 'Пришли инструкцию подключения Майора и Публика к группе.' },
    { text: 'Пришли инструкцию подключения Ластика к группе.' },
    { text: 'Пришли инструкцию по подключению Каравана к группе.' },
    { text: 'Как подключить Публика к группе через API?' },
    { text: 'Как подключить Майора к группе и настроить антимат?' },
    { text: 'Пришли инструкцию по подключению Майора к группе и расскажи прогноз погоды.' },
    { text: 'Подключи Майора к группе.' },
    { text: 'Как подключить Публика к группе? Только текстом, без картинок.' },
    { text: 'Как подключить Публика к группе? Без карточек, пожалуйста.' },
    { text: 'Как подключить Публика к группе? Не скидывай картинки.' },
    { text: 'Как подключить Майора к группе? Без пачки изображений.' },
    { text: 'Как подключить Майора к группе? Не кидайте карточки.' },
    { text: 'Как подключить Майора к группе? Не присылай картинки.' },
    { text: 'Я уже подключил Публика к группе, как создать пост?' },
    { text: 'Публик подключён к группе. Пришли инструкцию по подключению.' },
    { text: 'Как повторно подключить Майора к группе?' },
    { text: 'Не могу подключить Публика к группе. Пришли картинки.' },
    { text: 'Майор уже добавлен в группу, почему молчит?' },
    {
      text: 'Пришли карточки, пожалуйста.',
      history: [{ role: 'user', text: 'Как подключить Публика к группе?' }],
      interaction: { replyToAssistant: true },
    },
  ])
    assert.equal(select(scenario.text, scenario), null, scenario.text);
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
