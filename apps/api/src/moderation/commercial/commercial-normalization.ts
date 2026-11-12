import { normalizeForDetection } from '../rule-engine-normalization';
import { normalizeCommercialPhoneConfusables } from './commercial-phone';

const SPACED_LETTER_SEQUENCE_PATTERN =
  /(?:^|(?<=[\s.,:;!?/+-]))\p{L}(?:[\s.,:;!?/+-]+\p{L}){2,}(?=$|[\s.,:;!?/+-])/gu;
// FLAG: Normalize a detection copy only; preserve combining marks and regional letters.
const ZERO_WIDTH_PATTERN = /[\u00AD\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]/gu;
const ZERO_WIDTH_TEST_PATTERN = /[\u00AD\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]/u;
const COMPATIBILITY_FORM_PATTERN = /[\u{1D400}-\u{1D7FF}\uFF01-\uFF5E]/u;
const COMMERCIAL_LATIN_PATTERN = /[a-z]/iu;
const COMMERCIAL_CYRILLIC_PATTERN = /[а-яё]/iu;
const COMMERCIAL_OBFUSCATED_URL_HINT_PATTERN =
  /(?:h\s*x|hxxp|https?\s*(?:[:：]|[\\/])|dot|точка)/iu;
const COMMERCIAL_MIXED_TOKEN_PATTERN = /[\p{L}\p{N}_-]+/gu;
const COMMERCIAL_LATIN_CONFUSABLES: Readonly<Record<string, string>> = {
  a: 'а',
  b: 'б',
  c: 'с',
  d: 'д',
  e: 'е',
  h: 'н',
  i: 'и',
  j: 'й',
  k: 'к',
  l: 'л',
  m: 'м',
  n: 'н',
  o: 'о',
  p: 'р',
  r: 'р',
  s: 'с',
  t: 'т',
  u: 'и',
  v: 'в',
  w: 'в',
  x: 'х',
  y: 'у',
  z: 'з',
};
const COMMERCIAL_UPPERCASE_LATIN_CONFUSABLES: Readonly<Record<string, string>> = {
  B: 'в',
};

export function normalizeCommercialText(value: string): string {
  return normalizePreparedCommercialText(normalizeCommercialRawText(value));
}

export function normalizePreparedCommercialText(rawLoweredText: string): string {
  const normalized = normalizeForDetection(rawLoweredText);
  if (!normalized) {
    return '';
  }

  return normalized.replace(SPACED_LETTER_SEQUENCE_PATTERN, (sequence) =>
    sequence.replace(/[\s.,:;!?/+-]+/gu, ''),
  );
}

export function normalizeCommercialConfusables(value: string): string {
  const lowered = normalizeCommercialRawText(value);
  if (!COMMERCIAL_LATIN_PATTERN.test(lowered) || !COMMERCIAL_CYRILLIC_PATTERN.test(lowered)) {
    return lowered;
  }

  return lowered.replace(COMMERCIAL_MIXED_TOKEN_PATTERN, (token) => {
    if (!COMMERCIAL_LATIN_PATTERN.test(token) || !COMMERCIAL_CYRILLIC_PATTERN.test(token)) {
      return token;
    }

    let normalizedToken = '';
    for (const char of token) {
      normalizedToken += COMMERCIAL_LATIN_CONFUSABLES[char] ?? char;
    }
    return normalizedToken;
  });
}

export function normalizeCommercialRawText(value: string): string {
  if (!value) {
    return '';
  }

  let normalized = COMPATIBILITY_FORM_PATTERN.test(value) ? value.normalize('NFKC') : value;
  if (ZERO_WIDTH_TEST_PATTERN.test(normalized)) {
    normalized = normalized.replace(ZERO_WIDTH_PATTERN, '');
  }
  normalized = normalizeCommercialPhoneConfusables(normalized);
  if (COMMERCIAL_OBFUSCATED_URL_HINT_PATTERN.test(normalized)) {
    normalized = normalizeObfuscatedUrls(normalized);
  }
  if (COMMERCIAL_LATIN_PATTERN.test(normalized) && COMMERCIAL_CYRILLIC_PATTERN.test(normalized)) {
    normalized = normalized.replace(COMMERCIAL_MIXED_TOKEN_PATTERN, normalizeMixedCommercialToken);
  }
  return normalized.toLowerCase();
}

function normalizeObfuscatedUrls(value: string): string {
  return value
    .replace(/\bh\s*x\s*x\s*p\s*s?\s*(?=[:：]|\/|\\)/giu, (match) =>
      /s/iu.test(match) ? 'https' : 'http',
    )
    .replace(/\b(hxxps?|https?)\s*(?:[:：]\s*)?(?:[\\/]\s*){2}/giu, (_match, scheme: string) => {
      const normalizedScheme = scheme.toLowerCase().startsWith('hxxp')
        ? scheme.toLowerCase().replace('hxxp', 'http')
        : scheme.toLowerCase();
      return `${normalizedScheme}://`;
    })
    .replace(/([a-z0-9а-яё-])\s+(?:dot|точка)\s+([a-zа-яё]{2,})(?=$|[^\p{L}\p{N}_-])/giu, '$1.$2');
}

function normalizeMixedCommercialToken(token: string): string {
  if (!COMMERCIAL_LATIN_PATTERN.test(token) || !COMMERCIAL_CYRILLIC_PATTERN.test(token)) {
    return token;
  }

  let normalizedToken = '';
  for (const char of token) {
    normalizedToken +=
      COMMERCIAL_UPPERCASE_LATIN_CONFUSABLES[char] ??
      COMMERCIAL_LATIN_CONFUSABLES[char.toLowerCase()] ??
      char;
  }
  return normalizedToken;
}
