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
