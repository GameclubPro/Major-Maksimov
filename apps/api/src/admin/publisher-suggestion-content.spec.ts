import { buildPublisherSuggestionPublicationText } from './publisher-suggestion-content';

describe('Publisher suggestion publication content', () => {
  it.each([
    { text: '', textFormat: 'plain', expected: '' },
    { text: '**Объявление**', textFormat: 'markdown', expected: '\n\n**Объявление**' },
    {
      text: '[текст](https://example.test)',
      textFormat: 'plain',
      expected: '\n\n\\[текст\\]\\(https://example.test\\)',
    },
  ])(
    'adds a full-name mention to $textFormat text or captionless media',
    ({ text, textFormat, expected }) => {
      expect(
        buildPublisherSuggestionPublicationText('42', {
          authorDisplayName: 'Анна Каренина',
          text,
          textFormat,
        }),
      ).toBe(`От подписчика [Анна Каренина](max://user/42)${expected}`);
    },
  );

  it('prefers a stored public profile URL, then a username, over a mention', () => {
    const payload = {
      authorDisplayName: 'Анна',
      authorUsername: 'anna',
      authorProfileUrl: 'https://max.ru/u/profile',
    };
    expect(buildPublisherSuggestionPublicationText('42', payload)).toBe(
      'От подписчика [Анна](https://max.ru/u/profile)',
    );
    expect(
      buildPublisherSuggestionPublicationText('42', { ...payload, authorProfileUrl: null }),
    ).toBe('От подписчика [Анна](https://max.ru/anna)');
  });

  it('preserves native links and contact mentions with original UTF-16 offsets', () => {
    const text = '  📣 Сайт и Анна';
    expect(
      buildPublisherSuggestionPublicationText('42', {
        authorDisplayName: 'Автор',
        text,
        textMarkup: [
          {
            type: 'link',
            from: text.indexOf('Сайт'),
            length: 4,
            url: 'https://example.test/reviews',
          },
          {
            type: 'user_mention',
            from: text.indexOf('Анна'),
            length: 4,
            userLink: 'max://user/123',
          },
          { type: 'link', from: -1, length: 500, url: 'https://invalid.test' },
        ],
      }),
    ).toBe(
      'От подписчика [Автор](max://user/42)\n\n  📣 [Сайт](https://example.test/reviews) и [Анна](max://user/123)',
    );
  });

  it('never attributes the audit author to a mismatched stored profile', () => {
    expect(
      buildPublisherSuggestionPublicationText('42', {
        actorUserId: '999',
        authorDisplayName: 'Другой',
        authorProfileUrl: 'https://max.ru/other',
        text: 'Пост',
      }),
    ).toBe('От подписчика 42\n\nПост');
  });

  it('does not invent a contact when only an ID is known', () => {
    expect(buildPublisherSuggestionPublicationText('123456', { authorDisplayName: '123456' })).toBe(
      'От подписчика 123456',
    );
  });
});
