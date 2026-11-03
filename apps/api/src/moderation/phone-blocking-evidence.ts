import { getUrlTextRanges } from '../common/url-text.util';

type TextRange = { start: number; end: number };

const PHONE_CANDIDATE_PATTERN = /(?:\+|\(\s*)?\d[\d\s().-]*\d|\+?\d/gu;
const PHONE_CONTEXT_WORD_PATTERN =
  /(?:тел|телефон|номер|звон|звонить|связь|связаться|whatsapp|ватсап|wa|вайбер|viber|личк|лс)/iu;
const URI_PATTERN = /(?<![\p{L}\p{N}_.+-])[a-z][a-z\d+.\p{Cf}-]*:[^\s<>"'`[\]{}]+/giu;
const IDENTIFIER_PATTERN =
  /(?<![\p{L}\p{N}_])(?:инн|и\.н\.н\.?|артикул(?:а|ы|ов)?|арт(?:ик)?\.?)[\s\p{Cf}:№#=«"'([\]-]+([+\p{L}\p{N}][\p{L}\p{N}\p{Cf}._/+-]*)/giu;

export function extractBlockedPhoneNumbers(text: string): string[] {
  const excluded = collectExcludedRanges(text);
  const phones = new Set<string>();
  let cursor = 0;
  for (const range of [...excluded, { start: text.length, end: text.length }]) {
    if (range.start > cursor) {
      for (const match of text.slice(cursor, range.start).matchAll(PHONE_CANDIDATE_PATTERN)) {
        const start = cursor + match.index;
        for (const candidate of splitPhoneCandidates(match[0], text, start)) {
          phones.add(normalizePhoneNumber(candidate));
        }
      }
    }
    cursor = Math.max(cursor, range.end);
  }
  return [...phones];
}

function collectExcludedRanges(text: string): TextRange[] {
  const ranges = getUrlTextRanges(text).map((range) => extendBalancedUrlRange(text, range));
  // FLAG: Phone blocking exempts all URL values, including contact/custom schemes.
  // Keep this supplement local: link policy and duplicate identity have separate contracts.
  if (text.includes(':')) {
    for (const match of text.matchAll(URI_PATTERN)) {
      // FLAG: The shared matcher owns HTTP sentence boundaries. A generic scheme
      // match must not swallow an independent phone after its attached sentence.
      if (/^https?:\/\//iu.test(match[0].replace(/\p{Cf}/gu, ''))) continue;
      let end = match[0].length;
      let parentheses = 0;
      for (let index = 0; index < end; index++) {
        if (match[0][index] === '(') parentheses++;
        if (match[0][index] === ')' && --parentheses < 0) end = index;
      }
      ranges.push({ start: match.index, end: match.index + end });
    }
  }
  for (const match of text.matchAll(IDENTIFIER_PATTERN)) {
    const value = match[1];
    if (value && /\d/u.test(value)) {
      const end = match.index + match[0].length;
      const start = end - value.length;
      ranges.push({
        start,
        end: extendGroupedIdentifier(text, start, value, /^и/iu.test(match[0])),
      });
    }
  }
  ranges.sort((left, right) => left.start - right.start || left.end - right.end);
  return ranges;
}

function extendBalancedUrlRange(source: string, range: TextRange): TextRange {
  if (source[range.end] !== '(') return range;
  const token = /^[^\s<>"'`[\]{}]+/u.exec(source.slice(range.start))?.[0];
  if (!token) return range;
  const masked = token.split('');
  const opening: number[] = [];
  let end = token.length;
  for (let index = 0; index < end; index++) {
    if (token[index] === '(') opening.push(index);
    if (token[index] === ')') {
      const start = opening.pop();
      if (start === undefined) end = index;
      else {
        masked[start] = '_';
        masked[index] = '_';
      }
    }
  }
  // FLAG: Mask only balanced URL parentheses at equal UTF-16 length, then let the
  // shared recognizer retain sentence boundaries and original source positions.
  const extended = getUrlTextRanges(masked.slice(0, end).join('')).find(
    (candidate) => candidate.start === 0,
  );
  return extended ? { start: range.start, end: range.start + extended.end } : range;
}

function extendGroupedIdentifier(
  source: string,
  start: number,
  value: string,
  inn: boolean,
): number {
  const tokenEnd = start + value.length;
  if (!/^\+?\d[\d.-]*$/u.test(value) || value.replace(/\D/gu, '').length >= 10) return tokenEnd;
  const numeric = /^\+?\d[\d\s().-]*\d|^\+?\d/u.exec(source.slice(start))?.[0];
  if (!numeric) return tokenEnd;
  // FLAG: An identifier may use phone-style grouping, but extending its span must
  // leave only complete independent phones. Never consume a prefix of the next phone.
  const firstPhone = splitPhoneCandidates(numeric, source, start)[0];
  if (firstPhone) return Math.max(tokenEnd, start + firstPhone.length);
  if (!inn) return tokenEnd;
  let digits = 0;
  for (let index = 0; index < numeric.length; index++) {
    if (!/\d/u.test(numeric[index]!)) continue;
    digits++;
    if (digits > 12) break;
    if (digits !== 10 && digits !== 12) continue;
    const end = index + 1;
    if (end < numeric.length && !/\s/u.test(numeric[end]!)) continue;
    const prefix = numeric.slice(0, end);
    if (!/^\d+(?:[\s.-]+\d+)+$/u.test(prefix)) continue;
    const remainder = numeric.slice(end).trimStart();
    if (
      !remainder ||
      splitPhoneCandidates(remainder, source, start + numeric.length - remainder.length).length
    ) {
      return Math.max(tokenEnd, start + end);
    }
  }
  return tokenEnd;
}

function splitPhoneCandidates(candidate: string, source: string, sourceStart: number): string[] {
  const digitOffsets = Array.from(candidate.matchAll(/\d/gu), (match) => match.index);
  if (digitOffsets.length <= 15) {
    return isPhoneCandidate(candidate, source, sourceStart) ? [candidate] : [];
  }

  // FLAG: Split only at whitespace between complete phone candidates. Never split a
  // continuous digit run or accept a phone-shaped prefix of an unrecognized long value.
  const boundaries = new Map([
    [0, 0],
    [digitOffsets.length, candidate.length],
  ]);
  for (let index = 1; index < digitOffsets.length; index++) {
    const gap = candidate.slice(digitOffsets[index - 1]! + 1, digitOffsets[index]);
    const boundary = /^\)?\s+(\(\s*)?$/u.exec(gap);
    if (boundary) boundaries.set(index, digitOffsets[index]! - (boundary[1]?.length ?? 0));
  }
  const next = new Map<number, number>();
  next.set(digitOffsets.length, digitOffsets.length);
  for (let start = digitOffsets.length - 10; start >= 0; start--) {
    if (!boundaries.has(start)) continue;
    for (let count = 10; count <= 15; count++) {
      const end = start + count;
      if (!next.has(end)) continue;
      const begin = boundaries.get(start)!;
      const value = candidate.slice(begin, digitOffsets[end - 1]! + 1);
      if (isPhoneCandidate(value, source, sourceStart + begin)) {
        next.set(start, end);
        break;
      }
    }
  }
  if (!next.has(0)) return [];
  const result: string[] = [];
  for (let start = 0; start < digitOffsets.length; ) {
    const end = next.get(start)!;
    result.push(candidate.slice(boundaries.get(start)!, digitOffsets[end - 1]! + 1));
    start = end;
  }
  return result;
}

function isPhoneCandidate(candidate: string, source: string, sourceStart: number): boolean {
  const digits = candidate.replace(/\D/gu, '');
  if (digits.length < 10 || digits.length > 15 || isLikelyDateOrNumberRange(candidate)) {
    return false;
  }
  if (candidate.startsWith('+')) return true;
  if (digits.length === 11 && /^[78]/u.test(digits)) return true;
  if (digits.length !== 10) return false;
  if (digits.startsWith('9')) return true;
  return (
    /\(\s*\d{3}\s*\)|\d{3}[\s.-]+\d{3}[\s.-]+\d{2}[\s.-]+\d{2}/u.test(candidate) ||
    PHONE_CONTEXT_WORD_PATTERN.test(source.slice(Math.max(0, sourceStart - 40), sourceStart + 80))
  );
}

function normalizePhoneNumber(candidate: string): string {
  const digits = candidate.replace(/\D/gu, '');
  if (digits.length === 11 && digits.startsWith('8')) return `7${digits.slice(1)}`;
  if (digits.length === 10 && digits.startsWith('9')) return `7${digits}`;
  return digits;
}

function isLikelyDateOrNumberRange(candidate: string): boolean {
  if (
    candidate.startsWith('+') ||
    /\(\s*\d{3}\s*\)/u.test(candidate) ||
    /(?:^|\D)(?:\d[\s-]*)?\d{3}[\s.-]+\d{3}[\s.-]+\d{2}[\s.-]+\d{2}(?:\D|$)/u.test(candidate)
  ) {
    return false;
  }
  if (/\d{1,2}[./-]\d{1,2}[./-]\d{2,4}/u.test(candidate)) return true;
  return /^\d{1,4}(?:[.,]\d+)?(?:\s*[-–]\s*\d{1,4}(?:[.,]\d+)?){2,}$/u.test(candidate);
}
