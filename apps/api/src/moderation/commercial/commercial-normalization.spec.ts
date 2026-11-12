import {
  normalizeCommercialRawText,
  normalizeCommercialConfusables,
  normalizeCommercialText,
  normalizePreparedCommercialText,
} from './commercial-normalization';

describe('normalizeCommercialText', () => {
  it.each(['\u2061', '\u2062', '\u2063', '\u2064', '\u00ad'])(
    'removes invisible format controls inside commercial words: %j',
    (separator) => {
      const plain = 'Ремонтируем стиральные машины. Выезд мастера 1000 рублей.';
      const obfuscated = plain.replace(/(?<=[а-яё])(?=[а-яё])/giu, separator);
      expect(normalizeCommercialRawText(obfuscated)).toBe(normalizeCommercialRawText(plain));
      expect(normalizeCommercialText(obfuscated)).toBe(normalizeCommercialText(plain));
    },
  );

  it('preserves regional letters, combining accents and emoji variation', () => {
    expect(normalizeCommercialRawText('Өң, үү, ң; а\u0301; ❤️')).toBe('өң, үү, ң; а\u0301; ❤️');
  });

  it.each([
    'П Р О Д А Е М мебель',
    'hxxps://max dot ru/join/sale',
    'Услуги +7 9О0 123 45 67',
    'Л𝐎𝐓 𝐂 П𝐎𝐁𝐓𝐎𝐏𝐎𝐌',
    'п\u200bр\u200bо\u200bд\u200bа\u200bм',
  ])('reuses prepared raw text without changing normalization: %s', (text) => {
    expect(normalizePreparedCommercialText(normalizeCommercialRawText(text))).toBe(
      normalizeCommercialText(text),
    );
  });

  it('collapses intentionally spaced commercial words', () => {
    expect(normalizeCommercialText('П Р О Д А Е М мебель')).toContain('продаем мебель');
    expect(normalizeCommercialText('П.Р.О.Д.А.Е.М мебель')).toContain('продаем мебель');
  });

  it('keeps regular words around obfuscated tokens readable', () => {
    expect(normalizeCommercialText('Сдам офис в центре')).toBe('сдам офис в центре');
    expect(normalizeCommercialText('Подскажите, где офис?')).toBe('подскажите, где офис?');
  });

  it('normalizes common visual Latin confusables in commercial spam words', () => {
    expect(normalizeCommercialConfusables('Дeньги дo зapплaты oнлaйн')).toBe(
      'деньги до зарплаты онлайн',
    );
  });

  it('distinguishes lowercase b from uppercase visual B in mixed Cyrillic words', () => {
    expect(normalizeCommercialRawText('Подраbотка')).toBe('подработка');
    expect(normalizeCommercialText('Подраbотка')).toBe('подработка');
  });

  it('normalizes mathematical and full-width compatibility letters', () => {
    expect(normalizeCommercialRawText('П𝐎𝐁𝐓𝐎𝐏𝐎𝐌')).toBe('повтором');
    expect(normalizeCommercialText('Л𝐎𝐓 𝐂 П𝐎𝐁𝐓𝐎𝐏𝐎𝐌')).toContain('лот с повтором');
    expect(normalizeCommercialRawText('ＷＨＡＴＳＡＰＰ')).toBe('whatsapp');
  });

  it('restores obfuscated commercial links before rule matching', () => {
    expect(normalizeCommercialRawText('hxxps://max dot ru/join/sale')).toBe(
      'https://max.ru/join/sale',
    );
    expect(normalizeCommercialRawText('hxxp://credit точка ru')).toBe('http://credit.ru');
  });

  it('strips zero-width separators from obfuscated commercial words', () => {
    expect(normalizeCommercialRawText('п\u200bр\u200bо\u200bд\u200bа\u200bм')).toBe('продам');
  });
});
