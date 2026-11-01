import { getUrlTextRanges } from '../../common/url-text.util';
import {
  hasDuplicateQuantityUnitPrefix,
  hasDuplicateQuantityUnitSuffix,
} from '../duplicate-semantic-text';

// FLAG: A new assertion cannot extend a number; horizontal Unicode spaces retain phone formatting.
const NUMBER_SEPARATOR_CHARS = String.raw`\p{Zs}\t()./\\‐‑‒–—―-`;
const KEYCAP_MARK_PATTERN = String.raw`\uFE0F?\u20E3`;
const EMOJI_PHONE_SEPARATOR_PATTERN = String.raw`\p{Extended_Pictographic}\uFE0F?`;
const OBFUSCATED_PHONE_SEPARATOR_PATTERN = String.raw`(?:${KEYCAP_MARK_PATTERN}|[•|]|${EMOJI_PHONE_SEPARATOR_PATTERN})`;
const PHONE_SEPARATOR_PATTERN = String.raw`(?:[${NUMBER_SEPARATOR_CHARS}]|[•|]|${EMOJI_PHONE_SEPARATOR_PATTERN})*`;
const PHONE_DIGIT_PATTERN = String.raw`\d(?:${KEYCAP_MARK_PATTERN})?`;
// FLAG: A new line or phone label separates contacts, not digits of one identifier.
const ADJACENT_DIGIT_SEPARATOR_PATTERN = String.raw`(?:(?![\r\n\u260E\u{1F4DE}\u{1F4F1}\u{1F4F2}])(?:[${NUMBER_SEPARATOR_CHARS}]|[•|]|${EMOJI_PHONE_SEPARATOR_PATTERN}))*`;
const INLINE_NUMBER_SEPARATOR_PATTERN = String.raw`(?:(?![\r\n])[${NUMBER_SEPARATOR_CHARS}])*`;
const PHONE_CONTEXT_TERM = String.raw`(?:телефон(?:а|у|ом|ы)?|тел\.?|номер\s+телефона|(?:пишите?|звоните?|обращайтесь)\s+по\s+номер[у]?|звон(?:ить|ите|ок|ки)|контакт(?:ы|ный\s+номер)?|связь|для\s+связи|ватсап|whats?app|viber|[\u260E\u{1F4DE}\u{1F4F1}\u{1F4F2}]\uFE0F?)`;
const NON_PHONE_IDENTIFIER_CONTEXT_TERM = String.raw`(?:заказ(?:а|у|ом|е|ы)?|код(?:а|у|ом|е|ы)?(?:\s+телефон(?:а|ов)?)?|номер\s+заказа|маркировк\p{L}*|парти\p{L}*|артикул(?:а|у|ом|е|ы)?|идентификатор(?:а|у|ом|е|ы)?|инн|огрн|снилс|sku|imei|ean|gtin|order|invoice|account|identifier|id)`;
const PHONE_ADJACENT_CONTEXT_SEPARATOR = String.raw`(?:[\s:;,#№()./\\‐‑‒–—―-]|[•|]|${EMOJI_PHONE_SEPARATOR_PATTERN})`;
const VALUE_CONTEXT_SEPARATOR = String.raw`[\s:;,#№()/\\\[\]{}«»"'“‘”’‐‑‒–—―-]`;
const QUANTITY_CONTEXT_TERM = String.raw`(?:цен\p{L}*|стоимост\p{L}*|сумм\p{L}*|бюджет\p{L}*|оплат\p{L}*|баланс\p{L}*|остат[оа]к\p{L}*|температур\p{L}*|вес|масс\p{L}*|длин\p{L}*|площад\p{L}*|объ[её]м\p{L}*|размер\p{L}*|количеств\p{L}*|price|cost|total|amount|balance|weight|length|temperature|volume)`;
const QUANTITY_CONTEXT_BEFORE_PATTERN = new RegExp(
  String.raw`(?:^|[^\p{L}\p{N}_])${QUANTITY_CONTEXT_TERM}${VALUE_CONTEXT_SEPARATOR}{0,12}$`,
  'iu',
);
const QUANTITY_SUFFIX_PATTERN =
  /^[\s\p{Cf})\]}»"'”’]*(?:\p{Sc}|%|руб\p{L}*|р\.?|коп\p{L}*|usd|eur|rub|тыс\.?|тысяч\p{L}*|млн|миллион\p{L}*|млрд|миллиард\p{L}*|грамм\p{L}*|тонн\p{L}*|метр\p{L}*|литр\p{L}*|градус\p{L}*|ватт\p{L}*|час\p{L}*|минут\p{L}*|секунд\p{L}*|штук\p{L}*|человек\p{L}*|людей|байт\p{L}*|бит\p{L}*)(?![\p{L}\p{N}_])/iu;
const NON_PHONE_URI_PATTERN = /(?<![\p{L}\p{N}_])[a-z][a-z0-9+.-]*:[^\s<>"'`()[\]{}]+/giu;
const PHONE_URI_SCHEME_PATTERN = /^(?:tel|sms|callto):/iu;
const CONTACT_TOKEN_PATTERN = /[^\s<>"'`()[\]{}]+/gu;

const PHONE_LIKE_CONFUSABLE_SPAN_PATTERN =
  /(?:^|[^\p{L}\p{N}])(?:(?:\+\s*[1-9])(?:[\s().‐‑‒–—―•·|/:+-]*[\dOoОо]){6,14}|[78](?:[\s().‐‑‒–—―•·|/:+-]*[\dOoОо]){10})(?=$|[^\p{L}\p{N}])/gu;
const INTERNATIONAL_PHONE_PATTERN = new RegExp(
  String.raw`(?<![\d+])\+\d(?:[${NUMBER_SEPARATOR_CHARS}]*\d){6,14}(?![${NUMBER_SEPARATOR_CHARS}]*\d)`,
  'gu',
);
const CONTEXTUAL_OBFUSCATED_INTERNATIONAL_PHONE_PATTERN = new RegExp(
  String.raw`(?<![\d+])\+[1-9](?:${KEYCAP_MARK_PATTERN})?(?:${PHONE_SEPARATOR_PATTERN}${PHONE_DIGIT_PATTERN}){6,14}(?!${PHONE_SEPARATOR_PATTERN}${PHONE_DIGIT_PATTERN})`,
  'gu',
);
const RUSSIAN_PHONE_CANDIDATE_PATTERN = new RegExp(
  String.raw`(?<![\d+])\+?[78](?:${KEYCAP_MARK_PATTERN})?(?:${PHONE_SEPARATOR_PATTERN}${PHONE_DIGIT_PATTERN}){10}(?!${INLINE_NUMBER_SEPARATOR_PATTERN}\d)`,
  'gu',
);
const LOCAL_PHONE_CANDIDATE_PATTERN = new RegExp(
  String.raw`(?<!\d)\d(?:[${NUMBER_SEPARATOR_CHARS}]*\d){9}(?!${INLINE_NUMBER_SEPARATOR_PATTERN}\d)`,
  'gu',
);
const ADJACENT_NUMERIC_SEQUENCE_BEFORE_PATTERN = new RegExp(
  String.raw`\d${ADJACENT_DIGIT_SEPARATOR_PATTERN}$`,
  'u',
);
const ADJACENT_NUMERIC_SEQUENCE_AFTER_PATTERN = new RegExp(
  String.raw`^${ADJACENT_DIGIT_SEPARATOR_PATTERN}\d`,
  'u',
);
const SHORT_LOCAL_PHONE_CANDIDATE_PATTERN =
  /(?<!\d)\d{2}[\u2010-\u2015-]\d{2}[\u2010-\u2015-]\d{2}(?!\d)/gu;
const HAS_OBFUSCATED_PHONE_SEPARATOR_PATTERN = new RegExp(OBFUSCATED_PHONE_SEPARATOR_PATTERN, 'u');
const PHONE_CONTEXT_BEFORE_PATTERN = new RegExp(
  String.raw`(?:^|[^\p{L}\p{N}_])${PHONE_CONTEXT_TERM}(?![\p{L}\p{N}_])${PHONE_ADJACENT_CONTEXT_SEPARATOR}{0,12}$`,
  'iu',
);
const PHONE_CONTEXT_AFTER_PATTERN = new RegExp(
  String.raw`^${PHONE_ADJACENT_CONTEXT_SEPARATOR}{0,12}${PHONE_CONTEXT_TERM}(?![\p{L}\p{N}_])`,
  'iu',
);
const PHONE_PREPOSITION_CONTEXT_BEFORE_PATTERN = new RegExp(
  String.raw`(?:^|[^\p{L}\p{N}_])(?:${PHONE_CONTEXT_TERM}|перевод(?:а|ы|ите)?|перевести|перечисл\p{L}*|связаться|свяжитесь)[\p{Zs}\t:]+(?:на|с|в|к)[\p{Zs}\t]*$`,
  'iu',
);
const PHONE_PREPOSITION_CONTEXT_AFTER_PATTERN =
  /^[\p{Zs}\t]*(?:в[\p{Zs}\t]+(?:whats?app|ватсап|viber|telegram|телеграм\p{L}*|max|макс|личк\p{L}*)|с[\p{Zs}\t]+\d{1,2}(?::\d{2})?[\p{Zs}\t]+до[\p{Zs}\t]+\d{1,2})(?![\p{L}\p{N}_])/iu;
const NON_PHONE_IDENTIFIER_CONTEXT_BEFORE_PATTERN = new RegExp(
  String.raw`(?:^|[^\p{L}\p{N}_])${NON_PHONE_IDENTIFIER_CONTEXT_TERM}(?![\p{L}\p{N}_])${VALUE_CONTEXT_SEPARATOR}{0,12}$`,
  'iu',
);
const NON_PHONE_IDENTIFIER_CONTEXT_AFTER_PATTERN = new RegExp(
  String.raw`^${VALUE_CONTEXT_SEPARATOR}{0,12}${NON_PHONE_IDENTIFIER_CONTEXT_TERM}(?![\p{L}\p{N}_])`,
  'iu',
);
const COMPLETE_RUSSIAN_PHONE_SOURCE = String.raw`\+?[78](?:${KEYCAP_MARK_PATTERN})?(?:${PHONE_SEPARATOR_PATTERN}${PHONE_DIGIT_PATTERN}){10}`;
const COMPLETE_LOCAL_PHONE_SOURCE = String.raw`\d(?:[${NUMBER_SEPARATOR_CHARS}]*\d){9}`;
const CONTACT_PAIR_SEPARATOR_PATTERN = new RegExp(
  String.raw`(?<![\d+])((?:${COMPLETE_RUSSIAN_PHONE_SOURCE}|${COMPLETE_LOCAL_PHONE_SOURCE}))([ \t]*/[ \t]*)(?=(?:${COMPLETE_RUSSIAN_PHONE_SOURCE}|${COMPLETE_LOCAL_PHONE_SOURCE})(?!\d))`,
  'gu',
);
const SCHEDULE_CONTACT_SEPARATOR_PATTERN = new RegExp(
  String.raw`((?:^|[^\p{L}\p{N}_])24\s*(?:на|/)\s*7)([ \t]+)(?=${COMPLETE_RUSSIAN_PHONE_SOURCE}(?!\d))`,
  'giu',
);

export type CommercialPhoneContact = {
  start: number;
  end: number;
  normalizedNumber: string;
};

export function normalizeCommercialPhoneConfusables(value: string): string {
  return value.replace(PHONE_LIKE_CONFUSABLE_SPAN_PATTERN, (phoneLikeSpan) =>
    phoneLikeSpan.replace(/[OoОо]/gu, '0'),
  );
}

export function hasCommercialPhoneLikeText(value: string): boolean {
  return collectCommercialPhones(value, true).length > 0;
}

export function parseCommercialPhones(value: string): CommercialPhoneContact[] {
  return collectCommercialPhones(value, false);
}

function collectCommercialPhones(value: string, firstOnly: boolean): CommercialPhoneContact[] {
  if (!/\d/u.test(value)) return [];
  const normalized = normalizeCommercialPhoneConfusables(value);
  // FLAG: Change only delimiter characters in the scan copy; spans retain original UTF-16 offsets.
  const scanText = normalized
    .replace(
      CONTACT_PAIR_SEPARATOR_PATTERN,
      (_match, phone: string, separator: string) => phone + separator.replace('/', ','),
    )
    .replace(
      SCHEDULE_CONTACT_SEPARATOR_PATTERN,
      (_match, schedule: string, separator: string) => schedule + ',' + separator.slice(1),
    );
  const contacts: CommercialPhoneContact[] = [];
  const excludedRanges = collectNonPhoneRanges(value);
  for (const pattern of [
    INTERNATIONAL_PHONE_PATTERN,
    CONTEXTUAL_OBFUSCATED_INTERNATIONAL_PHONE_PATTERN,
    RUSSIAN_PHONE_CANDIDATE_PATTERN,
    LOCAL_PHONE_CANDIDATE_PATTERN,
    SHORT_LOCAL_PHONE_CANDIDATE_PATTERN,
  ]) {
    let excludedIndex = 0;
    pattern.lastIndex = 0;
    for (const match of scanText.matchAll(pattern)) {
      const start = match.index;
      const text = match[0];
      const end = start + text.length;
      // FLAG: URL/email/opaque URI digits are never independent phone evidence. Ranges and
      // candidate streams retain original offsets; explicit tel/sms/callto contacts remain eligible.
      while (excludedIndex < excludedRanges.length && excludedRanges[excludedIndex]!.end <= start)
        excludedIndex += 1;
      if (excludedIndex < excludedRanges.length && excludedRanges[excludedIndex]!.start < end)
        continue;
      if (contacts.some((contact) => start < contact.end && end > contact.start)) continue;
      // FLAG: A '+' or phone label cannot turn an identifier, amount or measurement into
      // a contact. Privacy masking independently retains its broader phone-shaped matches.
      if (hasNonPhoneValueContext(scanText, normalized, start, text.length)) continue;
      const hasContext =
        hasAdjacentPhoneContext(scanText, start, text.length) ||
        contacts.some(
          (contact) =>
            contact.end <= start &&
            start - contact.end <= 16 &&
            /^[\p{Zs}\t]*[,/;\r\n][\p{Zs}\t\r\n]*$/u.test(scanText.slice(contact.end, start)),
        );
      let accepted: boolean;
      if (pattern === INTERNATIONAL_PHONE_PATTERN) {
        accepted = true;
      } else if (pattern === CONTEXTUAL_OBFUSCATED_INTERNATIONAL_PHONE_PATTERN) {
        accepted = hasObfuscatedPhoneSeparator(text) && hasContext;
      } else if (pattern === SHORT_LOCAL_PHONE_CANDIDATE_PATTERN) {
        accepted = hasContext;
      } else {
        accepted =
          !isEmbeddedInLongerNumericSequence(scanText, start, text.length) &&
          (pattern === RUSSIAN_PHONE_CANDIDATE_PATTERN
            ? hasObfuscatedPhoneSeparator(text) ||
              looksLikeStructuredPhone(text) ||
              hasContext ||
              looksLikeBareRussianPhone(text)
            : looksLikeStructuredPhone(text) || hasContext);
      }
      if (!accepted) continue;
      const digits = text.replace(/\D/gu, '');
      contacts.push({
        start,
        end,
        normalizedNumber:
          digits.length === 11 && digits.startsWith('8') ? `7${digits.slice(1)}` : digits,
      });
      if (firstOnly) return contacts;
    }
  }
  return contacts.sort((left, right) => left.start - right.start);
}

export function replaceCommercialPhoneLikeText(value: string, replacement = '[phone]'): string {
  const normalized = normalizeCommercialPhoneConfusables(value);
  const contacts = parseCommercialPhones(normalized);
  let end = 0;
  const parts: string[] = [];
  for (const contact of contacts) {
    parts.push(normalized.slice(end, contact.start), replacement);
    end = contact.end;
  }
  parts.push(normalized.slice(end));
  return parts.join('');
}

function hasAdjacentPhoneContext(source: string, start: number, matchLength: number): boolean {
  const before = source.slice(Math.max(0, start - 80), start);
  const after = source.slice(start + matchLength, start + matchLength + 80);
  return PHONE_CONTEXT_BEFORE_PATTERN.test(before) || PHONE_CONTEXT_AFTER_PATTERN.test(after);
}

function collectNonPhoneRanges(value: string): { start: number; end: number }[] {
  const ranges = getUrlTextRanges(value);
  if (value.includes(':')) {
    for (const match of value.matchAll(NON_PHONE_URI_PATTERN)) {
      if (PHONE_URI_SCHEME_PATTERN.test(match[0])) continue;
      ranges.push({ start: match.index, end: match.index + match[0].length });
    }
  }
  // FLAG: Scan each token once, including malformed email-like values. Repeated greedy
  // searches for a missing '@' suffix must not make a long non-contact token quadratic.
  if (value.includes('@')) {
    for (const match of value.matchAll(CONTACT_TOKEN_PATTERN)) {
      if (!match[0].includes('@')) continue;
      ranges.push({ start: match.index, end: match.index + match[0].length });
    }
  }
  return ranges.sort((left, right) => left.start - right.start || right.end - left.end);
}

function hasNonPhoneValueContext(
  source: string,
  originalSource: string,
  start: number,
  matchLength: number,
): boolean {
  const before = source.slice(Math.max(0, start - 80), start).replace(/\p{Cf}/gu, '');
  // FLAG: A following assertion is not a suffix of this phone or identifier.
  const rawAfter = source
    .slice(start + matchLength, start + matchLength + 80)
    .replace(/\p{Cf}/gu, '');
  // FLAG: Scan-copy commas may represent slash-separated contacts, never a decimal tail.
  const originalAfter = originalSource
    .slice(start + matchLength, start + matchLength + 80)
    .replace(/\p{Cf}/gu, '');
  const after = rawAfter.split(/[,.!?;\r\n\u2028\u2029]/u, 1)[0]!;
  const phoneLabel = PHONE_CONTEXT_BEFORE_PATTERN.exec(before);
  return (
    /[\p{L}\p{M}\p{N}_@]$/u.test(before) ||
    /^[\p{L}\p{M}\p{N}_@]/u.test(after) ||
    /^[,.]\d/u.test(originalAfter) ||
    NON_PHONE_IDENTIFIER_CONTEXT_BEFORE_PATTERN.test(before) ||
    NON_PHONE_IDENTIFIER_CONTEXT_AFTER_PATTERN.test(after) ||
    QUANTITY_CONTEXT_BEFORE_PATTERN.test(before) ||
    /\p{Sc}[\s([{«"'“‘]*$/u.test(before) ||
    QUANTITY_SUFFIX_PATTERN.test(after) ||
    // FLAG: Case-folded unit tokens also spell Russian contact prepositions (на/с/в).
    // Only explicit contact/transfer phrases or labeled contact hours disambiguate them.
    (hasDuplicateQuantityUnitSuffix(after) &&
      !(phoneLabel !== null && PHONE_PREPOSITION_CONTEXT_AFTER_PATTERN.test(after))) ||
    (hasDuplicateQuantityUnitPrefix(before) &&
      !PHONE_PREPOSITION_CONTEXT_BEFORE_PATTERN.test(before)) ||
    (phoneLabel !== null && hasDuplicateQuantityUnitPrefix(before.slice(0, phoneLabel.index)))
  );
}

function isEmbeddedInLongerNumericSequence(
  source: string,
  start: number,
  matchLength: number,
): boolean {
  const before = source.slice(Math.max(0, start - 32), start);
  const after = source.slice(start + matchLength, start + matchLength + 32);
  return (
    ADJACENT_NUMERIC_SEQUENCE_BEFORE_PATTERN.test(before) ||
    ADJACENT_NUMERIC_SEQUENCE_AFTER_PATTERN.test(after)
  );
}

function looksLikeStructuredPhone(value: string): boolean {
  if (/[()]/u.test(value)) {
    return true;
  }
  if (!/[\s\u2010-\u2015-]/u.test(value) || /^\d{3}(?:\.\d{2,3}){3}$/u.test(value)) {
    return false;
  }
  return value.replace(/\D/gu, '').length >= 10;
}

function looksLikeBareRussianPhone(value: string): boolean {
  return /^[78]\d{10}$/u.test(value);
}

function hasObfuscatedPhoneSeparator(value: string): boolean {
  return HAS_OBFUSCATED_PHONE_SEPARATOR_PATTERN.test(value);
}
