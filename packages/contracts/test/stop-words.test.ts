import { describe, expect, it } from 'vitest';
import { StopWordsMatcher } from '../src/stop-words-matcher.js';
import {
  normalizeStopWordsDomain,
  stopWordsPolicySchema,
  stopWordsRuleSchema,
  updateStopWordsRequestSchema,
  stopWordsStateSchema,
  stopWordsStatusSchema,
} from '../src/stop-words.js';

describe('stop-word policy contract', () => {
  it('defaults to disabled exact rules without participant sanctions', () => {
    const policy = stopWordsPolicySchema.parse({
      rules: [{ id: 'one', kind: 'WORD', value: 'Ёлка' }],
    });
    expect(policy.enabled).toBe(false);
    expect(policy.imageScanEnabled).toBe(false);
    expect(policy.rules[0]).toMatchObject({ value: 'Ёлка', matchMode: 'EXACT', enabled: true });
    expect(policy.sanctions).toMatchObject({
      warnEnabled: false,
      muteEnabled: false,
      banEnabled: false,
    });
  });
  it('keeps a phrase as one rule and preserves its authored spelling', () => {
    expect(
      stopWordsRuleSchema.parse({ id: 'one', kind: 'PHRASE', value: 'Доход  без вложений' }).value,
    ).toBe('Доход без вложений');
    expect(
      stopWordsRuleSchema.parse({ id: 'two', kind: 'WORD', value: 'ＣＡＳＩＮＯ' }).value,
    ).toBe('ＣＡＳＩＮＯ');
  });
  it.each([
    '',
    'x',
    'a'.repeat(161),
    'word '.repeat(17).trim(),
    'и/в',
    'casino.example',
    'foo\u200bbar',
  ])('rejects invalid rule %s', (value) => {
    expect(
      stopWordsRuleSchema.safeParse({
        id: 'one',
        kind: value.includes(' ') ? 'PHRASE' : 'WORD',
        value,
      }).success,
    ).toBe(false);
  });
  it('rejects duplicate normalized values and IDs', () => {
    for (const rules of [
      [
        { id: 'one', kind: 'WORD', value: 'Ёлка' },
        { id: 'two', kind: 'WORD', value: 'елка' },
      ],
      [
        { id: 'one', kind: 'WORD', value: 'один' },
        { id: 'one', kind: 'WORD', value: 'два' },
      ],
    ])
      expect(stopWordsPolicySchema.safeParse({ rules }).success).toBe(false);
  });
  it('normalizes domains without broadening a configured www host', () => {
    expect(normalizeStopWordsDomain('https://www.example.com/page')).toBe('www.example.com');
    expect(normalizeStopWordsDomain('https://пример.рф')).toBe('xn--e1afmkfd.xn--p1ai');
    expect(normalizeStopWordsDomain('bad_domain.example')).toBe(null);
  });
  it('requires a revision on every scoped write', () => {
    expect(updateStopWordsRequestSchema.safeParse({ policy: {} }).success).toBe(false);
  });
  it('keeps replacement intent optional and accepts only actual booleans', () => {
    const original = { policy: {}, expectedRevision: 3 };
    expect(updateStopWordsRequestSchema.parse(original)).not.toHaveProperty(
      'replaceInvalidStorage',
    );
    for (const replaceInvalidStorage of [true, false])
      expect(
        updateStopWordsRequestSchema.parse({ ...original, replaceInvalidStorage })
          .replaceInvalidStorage,
      ).toBe(replaceInvalidStorage);
    for (const replaceInvalidStorage of ['true', 1, {}, null])
      expect(
        updateStopWordsRequestSchema.safeParse({ ...original, replaceInvalidStorage }).success,
      ).toBe(false);
  });
  it('adds optional storage health only to the full response', () => {
    const response = { policy: {}, revision: 3, imageScanStatus: 'unavailable' };
    expect(stopWordsStateSchema.parse(response).storageStatus).toBeUndefined();
    expect(
      stopWordsStateSchema.parse({ ...response, settingsRevision: '2026-10-29T16:00:00.000Z' })
        .settingsRevision,
    ).toBe('2026-10-29T16:00:00.000Z');
    for (const storageStatus of ['valid', 'legacy', 'invalid']) {
      expect(stopWordsStateSchema.parse({ ...response, storageStatus }).storageStatus).toBe(
        storageStatus,
      );
      expect(
        stopWordsStatusSchema.parse({
          ...response,
          storageStatus,
          settingsRevision: '2026-10-29T16:00:00.000Z',
        }),
      ).toEqual({
        revision: 3,
        imageScanStatus: 'unavailable',
      });
    }
    expect(stopWordsStateSchema.safeParse({ ...response, storageStatus: 'unknown' }).success).toBe(
      false,
    );
  });
});

describe('stop-word case matching', () => {
  it.each(['EXACT', 'MASKED'] as const)('ignores rule and message case in %s mode', (matchMode) => {
    const matcher = new StopWordsMatcher();
    for (const variants of [
      ['казино', 'КАЗИНО', 'КаЗиНо'],
      ['доход без вложений', 'ДОХОД БЕЗ ВЛОЖЕНИЙ', 'ДоХоД БеЗ вЛоЖеНиЙ'],
      ['casino', 'CASINO', 'CaSiNo'],
      ['ος', 'ΟΣ', 'οσ'],
    ]) {
      for (const value of variants) {
        const policy = stopWordsPolicySchema.parse({
          enabled: true,
          rules: [
            { id: 'case-rule', kind: value.includes(' ') ? 'PHRASE' : 'WORD', value, matchMode },
          ],
        });
        for (const fragment of variants) {
          const text = `🙂 «${fragment}»!`;
          const start = text.indexOf(fragment);
          expect(matcher.detect({ policy, text })).toEqual([
            {
              ruleId: 'case-rule',
              value,
              kind: policy.rules[0].kind,
              matchKind: 'exact',
              fragment,
              start,
              end: start + fragment.length,
            },
          ]);
          expect(matcher.detect({ policy, text: `анти${fragment}шка` })).toEqual([]);
        }
      }
    }
  });

  it('keeps existing policies with both sigma spellings valid and each rule identifiable', () => {
    const policy = stopWordsPolicySchema.parse({
      enabled: true,
      rules: [
        { id: 'final-sigma', kind: 'WORD', value: 'ος' },
        { id: 'sigma', kind: 'WORD', value: 'οσ' },
      ],
    });
    expect(
      new StopWordsMatcher().detect({ policy, text: 'ΟΣ' }).map((match) => match.ruleId),
    ).toEqual(['final-sigma', 'sigma']);
  });
});
