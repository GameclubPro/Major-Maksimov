import { normalizeMaxInlineKeyboardButtons } from './max-inline-keyboard-layout';

describe('compact link rows', () => {
  const link = (text: string) => ({
    type: 'link',
    text,
    url: `https://example.com/${encodeURIComponent(text)}`,
  });

  it('pairs short links while keeping long labels and an odd final link readable', () => {
    const labels = [
      'Тест',
      'Тест2',
      'Третий',
      'Открыть свою витрину 🏪',
      'Каталог',
      'Контакты',
      'Отзывы',
    ];
    expect(
      normalizeMaxInlineKeyboardButtons([labels.map(link)])?.map((row) =>
        row.map((button) => button.text),
      ),
    ).toEqual([
      ['Тест', 'Тест2'],
      ['Третий'],
      ['Открыть свою витрину 🏪'],
      ['Каталог', 'Контакты'],
      ['Отзывы'],
    ]);
  });

  it('never merges explicit source rows', () => {
    const rows = [[link('Тест')], [link('Тест2')]];
    expect(normalizeMaxInlineKeyboardButtons(rows)).toEqual(rows);
  });

  it('keeps callback and app actions out of compact link pairs', () => {
    const callback = { type: 'callback', text: 'Да', payload: 'yes' };
    const app = { type: 'open_app', text: 'App', web_app: 'https://example.com/app' };
    expect(
      normalizeMaxInlineKeyboardButtons([
        [link('Тест'), callback, link('Тест2'), app, link('Тест3')],
      ]),
    ).toEqual([[link('Тест')], [callback], [link('Тест2')], [app], [link('Тест3')]]);
  });
});

describe('clipboard payload for native suggestion editing', () => {
  it('copies exactly the original whitespace and paragraphs', () => {
    const payload = '  😀 текст\n\n\tотступ  \n';
    expect(
      normalizeMaxInlineKeyboardButtons([[{ type: 'clipboard', text: 'Скопировать', payload }]]),
    ).toEqual([[{ type: 'clipboard', text: 'Скопировать', payload }]]);
  });
  it('omits an oversized clipboard button without truncating a post', () => {
    expect(
      normalizeMaxInlineKeyboardButtons([
        [{ type: 'clipboard', text: 'Скопировать', payload: 'я'.repeat(1025) }],
      ]),
    ).toBeNull();
  });
});

describe('channel keyboard capacity', () => {
  it('refuses overflow before replacing a keyboard when all actions must be retained', () => {
    const rows = Array.from({ length: 31 }, (_, i) => [
      { type: 'link', text: `Button ${i}`, url: `https://example.com/${i}` },
    ]);
    expect(() => normalizeMaxInlineKeyboardButtons(rows, { rejectOnTrim: true })).toThrow('лимит');
    expect(
      normalizeMaxInlineKeyboardButtons(rows.slice(0, 30), { rejectOnTrim: true }),
    ).toHaveLength(30);
  });
});
