import {
  MessageLimitsBlockedWordDetector,
  normalizeLegacyStopWordIdentity,
} from './rule-engine-blocked-words.detector';

describe('legacy stop-word case matching', () => {
  const detector = new MessageLimitsBlockedWordDetector();

  it.each(['1xbet', '1XBET', '1XbEt'])(
    'detects explicitly configured alphanumeric words regardless of case: %s',
    (value) => {
      for (const text of ['1xbet', '1XBET', '1XbEt']) {
        const expected = expect.objectContaining({
          blockedWord: normalizeLegacyStopWordIdentity(value),
        });
        expect(detector.detect(text, [value])).toEqual(expected);
        expect(detector.detectAll(text, [value])).toEqual([expected]);
      }
    },
  );

  it.each(['CASINO-2026', 'casino-2026', 'CaSiNo-2026', 'STAVKA-XL', 'stavka-xl', 'StAvKa-Xl'])(
    'keeps partial product-code matches excluded in every case: %s',
    (text) => {
      expect(detector.detect(text, ['казино', 'ставка'])).toBeNull();
      expect(detector.detectAll(text, ['казино', 'ставка'])).toEqual([]);
    },
  );

  it('retains URL exclusions and does not let a cached exact rule broaden a shorter rule', () => {
    expect(detector.detect('1XBET', ['1xbet'])).not.toBeNull();
    expect(detector.detect('1XBET', ['xbet'])).toBeNull();
    expect(detector.detectAll('https://example.com/1XBET', ['1xbet'])).toEqual([]);
    expect(detector.detect('1XBET', ['1xbet'])).not.toBeNull();
  });
});
