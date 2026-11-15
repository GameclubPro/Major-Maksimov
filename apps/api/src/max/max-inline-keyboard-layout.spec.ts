import { normalizeMaxInlineKeyboardButtons } from './max-inline-keyboard-layout';

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
