import { replaceUrlsInText } from '../common/url-text.util';
import { parseCommercialPhones } from '../moderation/commercial/commercial-phone';

// FLAG: Financial redaction cannot concatenate a phone and a price from another assertion.
const NUMBER_SEPARATOR_CHARS = String.raw`\p{Zs}\t()./\\‐‑‒–—―-`;
const EMAIL_ATOM_CHARS = String.raw`\p{L}\p{N}!#$%&'*+/=?^_\x60{|}~\x2d`;
const EMAIL_PATTERN = new RegExp(
  String.raw`(?<![${EMAIL_ATOM_CHARS}.])[${EMAIL_ATOM_CHARS}]+(?:\.[${EMAIL_ATOM_CHARS}]+)*@(?:[\p{L}\p{N}](?:[\p{L}\p{N}-]{0,61}[\p{L}\p{N}])?\.)+(?:xn--[a-z0-9-]{2,59}|\p{L}{2,63})(?![\p{L}\p{N}-])`,
  'giu',
);
const BANK_ACCOUNT_CANDIDATE_PATTERN = new RegExp(
  String.raw`(?<!\d)\d(?:[${NUMBER_SEPARATOR_CHARS}]*\d){19}(?![${NUMBER_SEPARATOR_CHARS}]*\d)`,
  'gu',
);
const PAYMENT_CARD_CANDIDATE_PATTERN = new RegExp(
  String.raw`(?<!\d)\d(?:[${NUMBER_SEPARATOR_CHARS}]*\d){12,18}(?![${NUMBER_SEPARATOR_CHARS}]*\d)`,
  'gu',
);
const MAX_DEEP_LINK_PATTERN = /max:\/\/[^\s<>'"`()[\]{}]+/giu;
const HANDLE_PATTERN = /@[a-z0-9_]{4,32}/giu;
const FINANCIAL_CONTEXT_TERM = String.raw`(?:р\s*[/.\\-]\s*с|расч[её]тн\p{L}*\s+сч[её]т\p{L}*|банковск\p{L}*\s+сч[её]т\p{L}*|корр?(?:еспондентск\p{L}*)?\.?\s*сч[её]т\p{L}*|сч[её]т\s+(?:получателя|банка)|номер\s+сч[её]та|карт(?:а|ы|у|е|ой)|card|pan|сч[её]т)`;
const ADJACENT_CONTEXT_SEPARATOR = String.raw`[\s:;,#№()./\\‐‑‒–—―-]`;
const FINANCIAL_CONTEXT_BEFORE_PATTERN = new RegExp(
  String.raw`(?:^|[^\p{L}\p{N}_])${FINANCIAL_CONTEXT_TERM}(?![\p{L}\p{N}_])${ADJACENT_CONTEXT_SEPARATOR}{0,12}$`,
  'iu',
);
const FINANCIAL_CONTEXT_AFTER_PATTERN = new RegExp(
  String.raw`^${ADJACENT_CONTEXT_SEPARATOR}{0,12}${FINANCIAL_CONTEXT_TERM}(?![\p{L}\p{N}_])`,
  'iu',
);
const PRIVACY_PHONE_SEPARATOR = String.raw`(?:[\p{Zs}\t()./\\‐‑‒–—―•|-]|\p{Extended_Pictographic}\uFE0F?|\uFE0F|\u20E3)`;
const PRIVACY_PHONE_DIGIT = String.raw`\d(?:\uFE0F?\u20E3)?`;
const ORDINAL_LIST_GAP_PATTERN = new RegExp(String.raw`^${PRIVACY_PHONE_SEPARATOR}+$`, 'u');
const NUMERIC_ISLAND_GAP_PATTERN = new RegExp(
  String.raw`^(?:${PRIVACY_PHONE_SEPARATOR}|\+)*$`,
  'u',
);
const PHONE_ASSERTION_MARKER_PATTERN =
  /[+\u260E\u{1F4DE}\u{1F4F1}\u{1F4F2}]|(?:^|[^\p{L}\p{N}_])(?:телефон[а-яё-]*|тел\.?|контакт[а-яё-]*|связь|для\s+(?:связи|заказа))(?![\p{L}\p{N}_])/iu;
const PRIVACY_RUSSIAN_PHONE_PATTERN = new RegExp(
  String.raw`(?<![\d+])\+?[78](?:\uFE0F?\u20E3)?(?:${PRIVACY_PHONE_SEPARATOR}*${PRIVACY_PHONE_DIGIT}){10}(?!\d)`,
  'gu',
);
const PRIVACY_INTERNATIONAL_PHONE_PATTERN = new RegExp(
  String.raw`(?<![\d+])\+[1-9](?:\uFE0F?\u20E3)?(?:${PRIVACY_PHONE_SEPARATOR}*${PRIVACY_PHONE_DIGIT}){6,14}(?!${PRIVACY_PHONE_SEPARATOR}*\d)`,
  'gu',
);
const ISO_DATE_TIME_PATTERN =
  /\b\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])(?:[T ](?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2})?)?\b(?![-/\d])/gu;

type PrivacyReplacement = { start: number; end: number; replacement: string };

// FLAG: Normalize only a privacy scan copy; replacements retain original UTF-16 source spans.
function privacyScan(value: string): { text: string; starts: number[]; ends: number[] } {
  let text = '';
  const starts: number[] = [];
  const ends: number[] = [];
  let offset = 0;
  for (const character of value) {
    const width = character.length;
    if (!/\p{Cf}/u.test(character)) {
      if (/\p{Nd}/u.test(character) && !/[0-9]/u.test(character)) {
        const point = character.codePointAt(0)!;
        let zero = point;
        // Unicode decimal digits form contiguous sets of ten (some sets are adjacent).
        while (zero > 0 && /\p{Nd}/u.test(String.fromCodePoint(zero - 1))) zero--;
        text += String((point - zero) % 10);
        starts.push(offset);
        ends.push(offset + width);
      } else {
        text += character;
        for (let unit = 0; unit < width; unit++) {
          starts.push(offset + unit);
          ends.push(offset + unit + 1);
        }
      }
    }
    offset += width;
  }
  return { text, starts, ends };
}

function replacePrivacySpans(value: string, replacements: PrivacyReplacement[]): string {
  let cursor = 0;
  const parts: string[] = [];
  for (const span of replacements.sort((a, b) => a.start - b.start || b.end - a.end)) {
    if (span.start < cursor) continue;
    parts.push(value.slice(cursor, span.start), span.replacement);
    cursor = span.end;
  }
  parts.push(value.slice(cursor));
  return parts.join('');
}

function replacePrivacyPattern(
  value: string,
  pattern: RegExp,
  replacement: string,
  accept: (text: string, start: number, source: string) => boolean = () => true,
): string {
  const scan = privacyScan(value);
  pattern.lastIndex = 0;
  const spans: PrivacyReplacement[] = [];
  for (const match of scan.text.matchAll(pattern)) {
    if (accept(match[0], match.index, scan.text)) {
      spans.push({
        start: scan.starts[match.index],
        end: scan.ends[match.index + match[0].length - 1],
        replacement,
      });
    }
  }
  return replacePrivacySpans(value, spans);
}

// FLAG: Only a complete 1..10 ordinal run separates assertions; ambiguous numeric islands stay private.
// Work is linear in the scan text; maximal digit tokens keep keycaps and whole contacts indivisible.
function phoneScanWithoutOrdinalLists(value: string): string {
  const parts: string[] = [];
  let cursor = 0;
  let start = 0;
  let end = 0;
  let expected = 1;
  let phoneAssertion = false;
  const finish = () => {
    if (expected > 10) {
      parts.push(value.slice(cursor, start), 'x'.repeat(end - start));
      cursor = end;
    }
  };
  for (const match of value.matchAll(/(?:\d(?:\uFE0F?\u20E3)?)+/gu)) {
    const digits = match[0].replace(/\D/gu, '');
    const gap = value.slice(end, match.index);
    phoneAssertion =
      (phoneAssertion && NUMERIC_ISLAND_GAP_PATTERN.test(gap)) ||
      PHONE_ASSERTION_MARKER_PATTERN.test(gap);
    if (
      expected > 1 &&
      digits === String(expected) &&
      ORDINAL_LIST_GAP_PATTERN.test(gap) &&
      !phoneAssertion
    ) {
      end = match.index + match[0].length;
      expected++;
      continue;
    }
    finish();
    expected = digits === '1' && !phoneAssertion ? 2 : 1;
    start = match.index;
    end = match.index + match[0].length;
  }
  finish();
  return cursor === 0 ? value : parts.join('') + value.slice(cursor);
}

function redactPrivacyPhones(value: string): string {
  const scan = privacyScan(value);
  const phoneText = phoneScanWithoutOrdinalLists(scan.text);
  const dates = [...scan.text.matchAll(ISO_DATE_TIME_PATTERN)].map((match) => ({
    start: match.index,
    end: match.index + match[0].length,
  }));
  const spans: { start: number; end: number }[] = [];
  const add = (start: number, end: number) => {
    if (
      dates.some((date) => start < date.end && end > date.start) ||
      spans.some((span) => start < span.end && end > span.start)
    )
      return;
    spans.push({ start, end });
  };
  // FLAG: Privacy masks phone-shaped identifiers conservatively; detector evidence stays unchanged.
  // Full Russian contacts take priority over a following price in a longer numeric sequence.
  for (const match of phoneText.matchAll(PRIVACY_RUSSIAN_PHONE_PATTERN)) {
    add(match.index, match.index + match[0].length);
  }
  for (const contact of parseCommercialPhones(phoneText)) add(contact.start, contact.end);
  for (const match of phoneText.matchAll(PRIVACY_INTERNATIONAL_PHONE_PATTERN)) {
    add(match.index, match.index + match[0].length);
  }
  return replacePrivacySpans(
    value,
    spans.map((span) => ({
      start: scan.starts[span.start],
      end: scan.ends[span.end - 1],
      replacement: '[phone]',
    })),
  );
}

function hasFinancialContext(source: string, start: number, matchLength: number): boolean {
  const before = source.slice(Math.max(0, start - 80), start);
  const after = source.slice(start + matchLength, start + matchLength + 80);
  return (
    FINANCIAL_CONTEXT_BEFORE_PATTERN.test(before) || FINANCIAL_CONTEXT_AFTER_PATTERN.test(after)
  );
}

function passesLuhnCheck(value: string): boolean {
  const digits = value.replace(/\D/gu, '');
  if (digits.length < 13 || digits.length > 19 || /^(\d)\1+$/u.test(digits)) {
    return false;
  }

  let sum = 0;
  let doubleDigit = false;
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    let digit = Number(digits[index]);
    if (doubleDigit) {
      digit *= 2;
      if (digit > 9) {
        digit -= 9;
      }
    }
    sum += digit;
    doubleDigit = !doubleDigit;
  }
  return sum % 10 === 0;
}

function redactFinancialNumbers(value: string, requireContext = false): string {
  const withoutAccounts = replacePrivacyPattern(
    value,
    BANK_ACCOUNT_CANDIDATE_PATTERN,
    '[account]',
    (match, offset, input) => hasFinancialContext(input, offset, match.length),
  );
  return replacePrivacyPattern(
    withoutAccounts,
    PAYMENT_CARD_CANDIDATE_PATTERN,
    '[card]',
    (match, offset, input) =>
      hasFinancialContext(input, offset, match.length) ||
      (!requireContext && passesLuhnCheck(match)),
  );
}

export function sanitizeCommercialCorpusText(
  value: string,
  options: { preserveLayout?: boolean } = {},
): string {
  const withoutEmails = replacePrivacyPattern(value, EMAIL_PATTERN, '[email]');
  const withoutWebUrls = replaceUrlsInText(withoutEmails, '[url]');
  const withoutUrls = replacePrivacyPattern(withoutWebUrls, MAX_DEEP_LINK_PATTERN, '[url]');
  // FLAG: Explicit account/card spans precede phones; an unlabelled Luhn match cannot eat a price.
  const withoutExplicitFinancials = redactFinancialNumbers(withoutUrls, true);
  const sanitized = replacePrivacyPattern(
    redactFinancialNumbers(redactPrivacyPhones(withoutExplicitFinancials)),
    HANDLE_PATTERN,
    '@[handle]',
  );
  return (options.preserveLayout ? sanitized : sanitized.replace(/\s+/gu, ' ')).trim();
}

export function isCommercialCorpusTextSanitized(value: string): boolean {
  return (
    sanitizeCommercialCorpusText(value, { preserveLayout: true }) === value &&
    !hasResidualCommercialContactCandidate(value)
  );
}

// FLAG: Independent conservative privacy check, not evidence for a moderation decision.
export function hasResidualCommercialContactCandidate(value: string): boolean {
  const scan = privacyScan(value).text;
  const phoneText = phoneScanWithoutOrdinalLists(scan);
  return (
    new RegExp(String.raw`(?<!\d)\+?[78](?:${PRIVACY_PHONE_SEPARATOR}*\d){10}(?!\d)`, 'u').test(
      phoneText,
    ) ||
    new RegExp(
      String.raw`(?<![\d+])\+[1-9](?:${PRIVACY_PHONE_SEPARATOR}*\d){6,14}(?!\d)`,
      'u',
    ).test(phoneText) ||
    /(?:телефон[а-яё-]*|тел\.?|контакт[а-яё-]*|для\s+связи|[\u260E\u{1F4DE}\u{1F4F1}\u{1F4F2}]\uFE0F?)[^\p{L}\p{N}]{0,24}\d(?:[\p{Zs}\t().\u2010-\u2015/•|-]*\d){9}(?!\d)/iu.test(
      phoneText,
    ) ||
    /(?:https?:\/\/|max:\/\/|[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.[\p{L}]{2,})/iu.test(scan)
  );
}
