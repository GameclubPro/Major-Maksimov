import {
  mergeSuggestionNativeContent,
  nativeSuggestionMarkdown,
  readMarkdownNativeContent,
  readSuggestionNativeContent,
  type NativeSuggestionContent,
} from './suggestion-native-content';
import {
  parseSuggestionNativeCallback,
  suggestionNativeButtons,
} from './suggestion-native-protocol';
const mark = (
  type: NativeSuggestionContent['markup'][number]['type'],
  from: number,
  length: number,
  url: string | null = null,
) => ({ type, from, length, url, userLink: null });

describe('native suggestion content', () => {
  it('round-trips actual whitespace, paragraphs, emoji and hidden links', () => {
    const markdown = '  **😀 Заголовок**\n\n\t[Профиль](https://max.ru/person)  \n';
    const content = readMarkdownNativeContent(markdown);
    expect(content.text).toBe('  😀 Заголовок\n\n\tПрофиль  \n');
    expect(content.markup).toEqual(
      expect.arrayContaining([mark('strong', 2, 12), mark('link', 17, 7, 'https://max.ru/person')]),
    );
    expect(readMarkdownNativeContent(nativeSuggestionMarkdown(content))).toEqual(content);
  });
  it('retains native UTF-16 offsets without trimming', () => {
    const content = { text: '  😀 жирный\n\n', markup: [mark('strong', 5, 6)] };
    expect(readSuggestionNativeContent({ text: content.text, textMarkup: content.markup })).toEqual(
      content,
    );
  });
  it('shifts an untouched profile link and preserves indentation after a prefix edit', () => {
    const before = {
      text: 'Сегодня: автор\n\n  текст',
      markup: [mark('link', 9, 5, 'https://max.ru/person')],
    };
    const result = mergeSuggestionNativeContent(before, {
      text: 'Уже сегодня: автор\n\n  текст',
      markup: [],
    });
    expect(result.warnings).toEqual([]);
    expect(result.markup).toEqual([mark('link', 13, 5, 'https://max.ru/person')]);
    expect(result.text.endsWith('\n\n  текст')).toBe(true);
  });
  it('inherits style for a typo inside a bold word', () => {
    const result = mergeSuggestionNativeContent(
      { text: 'Куплю кат', markup: [mark('strong', 6, 3)] },
      { text: 'Куплю кот', markup: [] },
    );
    expect(result).toMatchObject({ warnings: [], markup: [mark('strong', 6, 3)] });
  });
  it('accepts explicit new formatting in place of a changed hidden link', () => {
    const incoming = { text: 'Новое имя', markup: [mark('link', 0, 9, 'https://max.ru/new')] };
    expect(
      mergeSuggestionNativeContent(
        { text: 'Старое имя', markup: [mark('link', 0, 10, 'https://max.ru/old')] },
        incoming,
      ),
    ).toEqual({ ...incoming, warnings: [] });
  });
  it('requires a choice when the label of a hidden link was changed without its markup', () => {
    const result = mergeSuggestionNativeContent(
      { text: 'Мой профиль', markup: [mark('link', 4, 7, 'https://max.ru/me')] },
      { text: 'Мой аккаунт', markup: [] },
    );
    expect(result.warnings).toEqual(['Ссылка: «профиль»']);
    expect(result.markup).toEqual([]);
  });
  it('does not reattach the URL of a removed link to another equal label', () => {
    const result = mergeSuggestionNativeContent(
      {
        text: 'сайт и сайт',
        markup: [
          mark('link', 0, 4, 'https://max.ru/one'),
          mark('link', 7, 4, 'https://max.ru/two'),
        ],
      },
      { text: 'сайт', markup: [] },
    );
    expect(result.markup).toEqual([]);
    expect(result.warnings).toEqual(['Ссылка: «сайт»']);
  });
  it('preserves headings, quotes, code and empty lines in source conversion', () => {
    const content = readMarkdownNativeContent('  # Заголовок\n\n> цитата\n\n```\na\n  b\n```\n');
    expect(content.text).toBe('  Заголовок\n\nцитата\n\na\n  b\n');
    expect(content.markup.map((m) => m.type)).toEqual(['heading', 'quote', 'monospaced']);
  });
  it('does not interpret plain punctuation as Markdown', () => {
    expect(nativeSuggestionMarkdown({ text: 'a_b * 2 [x]', markup: [] })).toBe(
      'a\\_b \\* 2 \\[x\\]',
    );
  });
  it('retains a full long body and reports a large ambiguous rewrite', () => {
    const result = mergeSuggestionNativeContent(
      { text: 'а'.repeat(3000), markup: [mark('strong', 50, 100)] },
      { text: 'б'.repeat(3000), markup: [] },
    );
    expect(result.text).toHaveLength(3000);
    expect(result.warnings).toHaveLength(1);
  });
  it('rejects broken ranges and unsafe links instead of dropping them', () => {
    expect(() => nativeSuggestionMarkdown({ text: 'x', markup: [mark('strong', 0, 2)] })).toThrow();
    expect(() =>
      nativeSuggestionMarkdown({ text: 'x', markup: [mark('link', 0, 1, 'javascript:alert(1)')] }),
    ).toThrow();
  });
});

describe('native review buttons', () => {
  it('uses bounded revisioned callbacks without miniapp links', () => {
    for (const button of suggestionNativeButtons('suggestion-1', 4, 9).flat()) {
      expect(button.type).toBe('callback');
      if (button.type !== 'callback') throw new Error('callback expected');
      expect(parseSuggestionNativeCallback(button.payload)).toMatchObject({
        id: 'suggestion-1',
        revision: 4,
        version: 9,
      });
    }
  });
  it.each(['sr1|publish|x|-1|0', 'sr1|unknown|x|0|0', 'sr1|publish|../x|0|0'])(
    'rejects invalid payload %s',
    (value) => expect(parseSuggestionNativeCallback(value)).toBeNull(),
  );
});
