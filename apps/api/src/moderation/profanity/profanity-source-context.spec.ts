import {
  excludeProtectedProfanitySpans,
  getMeasurementLiteralContext,
  isLiteralLatinProfanityException,
  prepareProfanitySource,
  tokenizeProfanityContext,
  type ProfanitySourceCandidate,
} from './profanity-source-context';

describe('profanity source boundaries', () => {
  it('treats URLs and email addresses as barriers without altering neighboring text', () => {
    expect(prepareProfanitySource('До hue@example.com после https://example.org/path конец')).toBe(
      'До \0 после \0 конец',
    );
    expect(prepareProfanitySource('pizd@')).toBe('pizd@');
    expect(prepareProfanitySource('б\0лять hue@example.com')).toBe('блять \0');
  });

  it('keeps literal financial and color terms distinct from altered words and mat', () => {
    for (const value of ['EBITDA', 'hue', 'ebitda-2026.xlsx']) {
      expect(isLiteralLatinProfanityException({ value, joined: false })).toBe(true);
    }
    for (const value of ['zaebal', 'ebitdaблять', 'h.u.e', 'pohuy']) {
      expect(isLiteralLatinProfanityException({ value, joined: false })).toBe(false);
    }
    expect(isLiteralLatinProfanityException({ value: 'hue', joined: true })).toBe(false);
  });

  it('retains sentence boundaries and allows punctuation after a standalone direct address', () => {
    const markers = new Set(['ты', 'вы']);
    expect(tokenizeProfanityContext('дауна. вы можете помочь', markers)).toEqual([
      'дауна',
      '.',
      'вы',
      'можете',
      'помочь',
    ]);
    expect(tokenizeProfanityContext('ты - петух', markers)).toEqual(['ты', 'петух']);
    expect(tokenizeProfanityContext('ты... петух', markers)).toEqual(['ты', 'петух']);
  });

  it('does not mistake masked numeric lists for a standalone volume', () => {
    expect(
      getMeasurementLiteralContext(
        '36.37.36л',
        {
          value: '36л',
          joined: false,
          rawValue: '36л',
          rawIndex: 6,
          rawEnd: 9,
        },
        'ебл',
      ),
    ).toBeNull();
    expect(
      getMeasurementLiteralContext(
        '36л',
        {
          value: '36л',
          joined: false,
          rawIndex: 0,
          rawEnd: 3,
        },
        'ебл',
      ),
    ).toEqual({ text: ' ебл ', unambiguousUnit: false });
  });

  it.each([
    ['Группа 3-6 л. для детей', '3-6 л.'],
    ['Вы записали ребенка на 3–6л?', '3–6л'],
    ['Возраст 3-6лет', '3-6лет'],
    ['Бак 3,6–6,5 л воды', '3,6–6,5 л'],
    ['ЧЕТВЕРГ: 16:00 - гр. 3-6 л.', '3-6 л.'],
    ['ЧЕТВЕРГ: 16:00 - гр.3-6л.', '3-6л.'],
    ['3-6 л., группа рисования', '3-6 л.'],
    ['Отдам (3-6 л) за сладость, Новотроицк.', '3-6 л'],
    ['Горшки 3-6л, отдам за сладость) Новотроицк.', '3-6л'],
    ['Кашпо 36 л', '36 л'],
    ['Продаём (3–6 л), самовывоз', '3–6 л'],
  ])('recognizes the complete local range in %s', (source, literal) => {
    const rawIndex = source.indexOf(literal);
    expect(
      getMeasurementLiteralContext(
        source,
        { value: literal, joined: true, rawIndex, rawEnd: rawIndex + literal.length },
        'ебл',
      ),
    ).not.toBeNull();
  });

  it.each([
    'Ты 3-6 л',
    'Для детей. 3-6 л',
    'Гр.\n3-6 л',
    'Бак 3-6лать',
    'Возраст 3-6летблять',
    'Отдам горшки. 3-6 л',
    'Отдам\n3-6 л',
    'Отдам\0 3-6 л',
    'Отдам, 3-6 л',
    'неотдам 3-6 л',
    'Отдам 3-6лать',
  ])('does not protect ambiguous or incomplete literals in %s', (source) => {
    const rawIndex = source.indexOf('3');
    const value = source.slice(rawIndex);
    expect(
      getMeasurementLiteralContext(
        source,
        { value, joined: true, rawIndex, rawEnd: source.length },
        'ебл',
      ),
    ).toBeNull();
  });

  it('removes overlapping measurement joins but keeps independent candidates', () => {
    const candidate = (start: number, end: number): ProfanitySourceCandidate => ({
      value: 'candidate',
      joined: false,
      rawIndex: start,
      rawEnd: end,
    });
    const protectedCandidates = [candidate(12, 17), candidate(3, 8), candidate(5, 10)];
    const candidates = Array.from({ length: 20 }, (_, start) => candidate(start, start + 2));
    const expected = candidates.filter(
      (item) =>
        !protectedCandidates.some(
          (range) => item.rawIndex! < range.rawEnd! && range.rawIndex! < item.rawEnd!,
        ),
    );
    expect(excludeProtectedProfanitySpans(candidates, protectedCandidates)).toEqual(expected);
    expect(excludeProtectedProfanitySpans(candidates, [])).toBe(candidates);
  });
});
