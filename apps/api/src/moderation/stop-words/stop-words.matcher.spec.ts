import { stopWordsPolicySchema, type StopWordsRule } from '@maxim/contracts/settings';
import { StopWordsMatcher } from './stop-words.matcher';

const matcher = new StopWordsMatcher();
function detect(value: string, text: string, matchMode: StopWordsRule['matchMode'] = 'EXACT') {
  const policy = stopWordsPolicySchema.parse({
    enabled: true,
    rules: [{ id: 'rule', kind: value.includes(' ') ? 'PHRASE' : 'WORD', value, matchMode }],
  });
  return matcher.detect({ policy, text });
}

describe('StopWordsMatcher', () => {
  it.each(['EXACT', 'MASKED'] as const)('ignores Cyrillic, Latin and Greek case in %s', (mode) => {
    for (const [value, text] of [
      ['КАЗИНО', 'КаЗиНо'],
      ['ДоХоД бЕз ВлОжЕнИй', 'ДОХОД БЕЗ ВЛОЖЕНИЙ'],
      ['CASINO', 'casino'],
      ['ΟΣ', 'ος'],
      ['οσ', 'ΟΣ'],
    ]) {
      expect(detect(value, text, mode)).toEqual([
        expect.objectContaining({
          value,
          fragment: text,
          matchKind: 'exact',
          start: 0,
          end: text.length,
        }),
      ]);
    }
  });
  it.each(['EXACT', 'MASKED'] as const)(
    'preserves Unicode line and paragraph boundaries in %s',
    (mode) => {
      for (const separator of ['\u2028', '\v', '\r\n', '\r', '\n', '\u00a0']) {
        const text = `доход${separator}без вложений`;
        expect(detect('доход без вложений', text, mode)[0]).toMatchObject({ fragment: text });
      }
      for (const separator of ['\u2029', '\f', '\n\n', '\r\n \r\n', '\u2028\t\u2028', '\r\r']) {
        expect(detect('доход без вложений', `доход${separator}без вложений`, mode)).toEqual([]);
      }
    },
  );
  it.each(['EXACT', 'MASKED'] as const)(
    'does not create boundaries at a removed URL in %s mode',
    (mode) => {
      expect(detect('доход', 'доходhttps://example.com', mode)).toEqual([]);
    },
  );
  it.each(["'casino'", '‘casino’', '"casino"'])('matches a complete quoted word: %s', (text) => {
    expect(detect('casino', text)[0]).toMatchObject({ value: 'casino', fragment: 'casino' });
  });
  it('handles a cold maximum-size dictionary without compiling one regex per exact entry', () => {
    const policy = stopWordsPolicySchema.parse({
      enabled: true,
      rules: Array.from({ length: 999 }, (_, index) => ({
        id: 'rule-' + index,
        kind: 'WORD',
        value: 'маркер' + index,
      })),
    });
    const detector = new StopWordsMatcher();
    expect(detector.detect({ policy, text: 'Нейтральное сообщение. '.repeat(150) })).toEqual([]);
    expect(detector.detect({ policy, text: 'маркер998' })[0]).toMatchObject({ ruleId: 'rule-998' });
  });
  it.each(['\u200bказино\u200b', 'ка\ufe0fзино'])(
    'recognizes invisible masking without losing source offsets: %s',
    (text) => {
      expect(detect('казино', text, 'MASKED')[0]).toMatchObject({
        value: 'казино',
        matchKind: 'masked',
      });
      expect(detect('казино', text)).toEqual([]);
    },
  );
  it('does not create a word boundary by stripping invisible characters', () => {
    expect(detect('казино', 'анти\u200bказино', 'MASKED')).toEqual([]);
  });
  it('preserves authored rule values separately from normalized matches', () => {
    expect(detect('Ёлка', 'ЕЛКА')[0]).toMatchObject({
      value: 'Ёлка',
      fragment: 'ЕЛКА',
      matchKind: 'exact',
    });
  });
  it.each(['casino_code', 'casino-code', "casino's", 'casino’s'])(
    'does not match part of an identifier or compound: %s',
    (text) => {
      expect(detect('casino', text)).toEqual([]);
    },
  );
  it.each([
    ['casino', 'CASINO'],
    ['1xbet', '1XBET'],
    ['ёлка', 'ЕЛКА'],
    ['casino', 'ＣＡＳＩＮＯ'],
    ['доход без вложений', 'Доход\tбез вложений'],
    ['café', 'cafe\u0301'],
  ])('matches %s in %s without changing rule identity', (value, text) => {
    expect(detect(value, text)).toHaveLength(1);
    expect(detect(value, text)[0]).toMatchObject({ ruleId: 'rule', fragment: text });
  });
  it.each([
    ['доход', 'до https://example.com ход'],
    ['доход', 'до ход'],
    ['банк', 'банка'],
    ['карта', 'карте'],
    ['казино', 'казиношка'],
    ['casino', 'casinos'],
    ['world', 'ворлд'],
    ['доход без вложений', 'доход. Без вложений'],
    ['доход без вложений', 'доход\n\nбез вложений'],
    ['казино', 'kазино'],
    ['казино', 'к.а.з.и.н.о'],
    ['казино', 'ка\u200bзино'],
  ])('does not broaden %s to %s', (value, text) => expect(detect(value, text)).toEqual([]));
  it.each(['kазино', 'к.а.з.и.н.о', 'к а з и н о', 'ка\u200bзино'])(
    'matches explicitly enabled masking in %s',
    (text) => {
      expect(detect('казино', text, 'MASKED')[0]).toMatchObject({
        value: 'казино',
        matchKind: 'masked',
      });
    },
  );
  it.each(['до ход', 'до. Ход', 'до https://example.com ход'])(
    'does not join normal fragments in masked mode: %s',
    (text) => {
      expect(detect('доход', text, 'MASKED')).toEqual([]);
    },
  );
  it('keeps independent forwarded content out of phrase matches', () => {
    const policy = stopWordsPolicySchema.parse({
      enabled: true,
      rules: [{ id: 'rule', kind: 'PHRASE', value: 'доход без вложений' }],
    });
    expect(
      matcher.detect({
        policy,
        text: 'доход без вложений',
        textSegments: ['доход', 'без вложений'],
      }),
    ).toEqual([]);
  });
  it('checks declared hidden links and exact allowlist exceptions', () => {
    const policy = stopWordsPolicySchema.parse({ enabled: true, domains: ['casino.example'] });
    const navigationTargets = [
      {
        kind: 'external_url' as const,
        target: 'https://promo.casino.example/page',
        normalizedTarget: 'https://promo.casino.example/page',
        enforceable: true,
        origins: [],
      },
    ];
    expect(matcher.detect({ policy, text: 'Сайт', navigationTargets })[0]).toMatchObject({
      kind: 'DOMAIN',
      value: 'casino.example',
    });
    expect(
      matcher.detect({ policy, text: 'Сайт', navigationTargets, isLinkAllowlisted: () => true }),
    ).toEqual([]);
    expect(matcher.detect({ policy, text: 'https://notcasino.example' })).toEqual([]);
    expect(
      matcher.detect({
        policy,
        text: 'Сайт',
        navigationTargets: [{ ...navigationTargets[0], enforceable: false }],
      }),
    ).toEqual([]);
  });
  it('honors module and rule switches', () => {
    const policy = stopWordsPolicySchema.parse({
      enabled: true,
      rules: [{ id: 'rule', kind: 'WORD', value: 'казино', enabled: false }],
    });
    expect(matcher.detect({ policy, text: 'казино' })).toEqual([]);
    policy.rules[0]!.enabled = true;
    policy.enabled = false;
    expect(matcher.detect({ policy, text: 'казино' })).toEqual([]);
  });
});
