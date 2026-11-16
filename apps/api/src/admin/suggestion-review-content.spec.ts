import {
  suggestionContentPatch,
  suggestionEditorText,
  suggestionRevision,
} from './suggestion-review-content';
import { buildPublisherSuggestionPublicationText } from './publisher-suggestion-content';
import { readMarkdownNativeContent } from './suggestion-native-content';

const requestId = 'b4dc924e-2b2f-41d4-a585-43c2b56b5735';
describe('suggestion review content', () => {
  it.each([
    ['user/67123224', 'max://user/67123224'],
    ['/user/67123224', 'max://user/67123224'],
    ['anna', 'https://max.ru/anna'],
    ['max://user/opaque-profile-id', 'max://user/opaque-profile-id'],
    ['https://max.ru/anna', 'https://max.ru/anna'],
  ])('opens a stored MAX mention %s without changing its destination', (userLink, target) => {
    const payload = {
      text: '  😀 Анна: цена 300 ₽\n\n',
      textMarkup: [{ type: 'user_mention', from: 5, length: 4, user_link: userLink }],
    };
    const markdown = suggestionEditorText(payload);
    expect(markdown).toBe(`  😀 [Анна](${target}): цена 300 ₽\n\n`);
    expect(
      suggestionContentPatch(payload, { requestId, expectedRevision: 0, text: markdown }, '101'),
    ).toEqual({});
    expect(buildPublisherSuggestionPublicationText('42', payload)).toContain(markdown);
  });

  it('keeps literal punctuation when MAX supplied only a redundant automatic link', () => {
    const text = '**это не жирный** [пример] _имя_ https://example.test/\n\n';
    const markdown = suggestionEditorText({
      text,
      textMarkup: [
        { type: 'link', from: text.indexOf('https:'), length: 21, url: 'https://example.test/' },
      ],
    });
    expect(readMarkdownNativeContent(markdown)).toEqual({ text, markup: [] });
  });

  it.each([
    { type: 'strong', from: -1, length: 2 },
    { type: 'strong', from: 0.5, length: 2 },
    { type: 'strong', from: 0, length: 1.5 },
    { type: 'strong', length: 2 },
    { type: 'strong', from: 'no offset', length: 2 },
    { type: 'strong', from: 1, length: 1 },
    { type: 'user_mention', from: 3, length: 4, userLink: 'javascript:alert(1)' },
    { type: 'user_mention', from: 3, length: 4, userLink: 'max://user/42?start=unsafe' },
    { type: 'user_mention', from: 3, length: 4, userLink: 'max://user/one/two' },
    { type: 'link', from: 3, length: 4, url: 'https://example.test/\npath' },
    { type: 'link', from: 3, length: 4, url: 'http://example.test/' },
    { type: 'link', from: 3, length: 4, url: 'https://user:secret@example.test/' },
  ])('refuses malformed or unsafe stored markup: %j', (entity) => {
    expect(() => suggestionEditorText({ text: '😀 Анна', textMarkup: [entity] })).toThrow(
      'оформление',
    );
  });

  it('opens native markup using original UTF-16 offsets and preserves blank lines', () => {
    const text = '  📣 Сайт\n\n\nЦена 300 ₽\n\n';
    expect(
      suggestionEditorText({
        text,
        textMarkup: [
          { type: 'link', from: text.indexOf('Сайт'), length: 4, url: 'https://example.test/' },
        ],
      }),
    ).toBe('  📣 [Сайт](https://example.test/)\n\n\nЦена 300 ₽\n\n');
  });
  it('keeps the original and author identity when an administrator corrects the price', () => {
    const payload = {
      text: '  **Цена** 300 ₽\n\n',
      textFormat: 'markdown',
      authorDisplayName: 'Анна',
      authorProfileUrl: 'https://max.ru/anna',
      actorUserId: '42',
    };
    const patch = suggestionContentPatch(
      payload,
      { requestId, expectedRevision: 0, text: '  **Цена** 350 ₽\n\n' },
      'editor',
    );
    const next = { ...payload, ...patch };
    expect(patch.reviewOriginalContent).toEqual({
      text: payload.text,
      textFormat: 'markdown',
      textMarkup: [],
    });
    expect(patch).not.toHaveProperty('actorUserId');
    expect(patch).not.toHaveProperty('authorProfileUrl');
    expect(buildPublisherSuggestionPublicationText('42', next)).toBe(
      'От подписчика [Анна](https://max.ru/anna)\n\n  **Цена** 350 ₽\n\n',
    );
    expect(payload.text).toBe('  **Цена** 300 ₽\n\n');
    expect(suggestionRevision(next)).toBe(1);
  });
  it('refuses malformed formatting instead of silently stripping it', () => {
    for (const textMarkup of [
      [{ type: 'unknown', from: 0, length: 4 }],
      [{ type: 'strong', from: 3, length: 5 }],
      [{ type: 'link', from: 0, length: 4, url: 'javascript:alert(1)' }],
    ])
      expect(() => suggestionEditorText({ text: 'Пост', textMarkup })).toThrow('оформление');
  });

  it('does not rewrite unchanged markup and rejects stale editors', () => {
    const payload = {
      text: 'ссылка',
      textMarkup: [{ type: 'link', from: 0, length: 6, url: 'https://example.test' }],
      reviewContentRevision: 3,
    };
    expect(
      suggestionContentPatch(
        payload,
        { requestId, expectedRevision: 3, text: suggestionEditorText(payload) },
        'editor',
      ),
    ).toEqual({});
    expect(() =>
      suggestionContentPatch(
        payload,
        { requestId, expectedRevision: 2, text: 'устаревшая правка' },
        'editor',
      ),
    ).toThrow('уже изменили');
  });
});
