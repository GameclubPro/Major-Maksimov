import assert from 'node:assert/strict';
import test from 'node:test';
import type { PublicationTarget } from '../src/features/publications/publication-model';
import { buildPublicationReviewButtonRows } from '../src/features/publications/publication-review-buttons';

test('publication review follows the target keyboard layout and drops duplicate links', () => {
  const channel: PublicationTarget = {
    id: 'channel',
    title: 'Город рядом',
    entityType: 'channel',
    avatarUrl: null,
    channelOverview: null,
    publisherChannelCommentsEnabled: true,
    publisherChannelPostSignature: {
      enabled: false,
      presentation: 'signature',
      text: 'Подписаться',
      url: '',
      customButtonsEnabled: true,
      customButtons: [
        {
          id: '9e21b054-22a8-409b-bb21-623d40ef6e4e',
          text: 'О нас',
          url: 'https://about.example.org/',
        },
        {
          id: 'ce82fc60-a592-41e2-865d-200ba9dcfbfe',
          text: 'Карта',
          url: 'https://map.example.org/',
        },
      ],
    },
  };
  const draft = {
    buttonEnabled: true,
    buttons: [
      { text: 'Контакты', url: 'https://about.example.org' },
      { text: 'Купить', url: 'https://tickets.example.org/' },
    ],
  };
  const labels = (target: PublicationTarget) =>
    buildPublicationReviewButtonRows(target, draft).map((row) => row.map((button) => button.text));
  assert.deepEqual(labels(channel), [['💬 Комментарии · 0'], ['О нас', 'Карта'], ['Купить']]);
  assert.deepEqual(
    labels({
      ...channel,
      id: 'other',
      publisherChannelCommentsEnabled: false,
      publisherChannelPostSignature: null,
    }),
    [['Контакты'], ['Купить']],
  );
});
