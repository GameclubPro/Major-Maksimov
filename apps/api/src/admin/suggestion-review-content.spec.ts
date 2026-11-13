import {
  suggestionContentPatch,
  suggestionEditorText,
  suggestionRevision,
} from './suggestion-review-content';
import { buildPublisherSuggestionPublicationText } from './publisher-suggestion-content';

const requestId = 'b4dc924e-2b2f-41d4-a585-43c2b56b5735';
describe('suggestion review content', () => {
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
