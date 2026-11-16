import { BadRequestException } from '@nestjs/common';
import { readChannelSuggestionTextMarkup } from './admin-channel-dialog-values';
import { resolveMaxUserMentionHref, type MaxTextMarkup } from '../common/max-text-markup.util';

function invalidMarkup(): never {
  throw new BadRequestException(
    'Не удалось безопасно прочитать оформление. Исходный пост сохранён без изменений.',
  );
}

// FLAG: Validate the original UTF-16 offsets before the tolerant legacy reader can coerce them.
// Preserve stored content; resolve MAX mention aliases only in the editable representation.
export function readSuggestionReviewMarkup(text: string, raw: unknown): MaxTextMarkup[] {
  if (raw == null) return [];
  if (!Array.isArray(raw)) return invalidMarkup();
  for (const value of raw) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return invalidMarkup();
    const row = value as Record<string, unknown>;
    const from = row.from;
    const length = row.length;
    if (
      typeof from !== 'number' ||
      typeof length !== 'number' ||
      !Number.isSafeInteger(from) ||
      !Number.isSafeInteger(length) ||
      from < 0 ||
      length <= 0 ||
      from + length > text.length ||
      splitsSurrogate(text, from) ||
      splitsSurrogate(text, from + length)
    )
      return invalidMarkup();
    for (const key of ['url', 'userLink', 'user_link']) {
      if (typeof row[key] === 'string' && hasControl(row[key])) return invalidMarkup();
    }
  }
  const markup = readChannelSuggestionTextMarkup(raw);
  if (markup.length !== raw.length) return invalidMarkup();
  return markup.map((item) => {
    if (item.type === 'link' && !safeEditorUrl(item.url)) return invalidMarkup();
    if (item.type !== 'user_mention') return item;
    const source = item.userLink;
    // Explicit foreign schemes must not become innocent-looking relative MAX profile paths.
    if (source && /^[a-z][a-z0-9+.-]*:/iu.test(source) && !safeEditorUrl(source))
      return invalidMarkup();
    const userLink = resolveMaxUserMentionHref(source);
    if (!safeEditorUrl(userLink)) return invalidMarkup();
    return { ...item, userLink };
  });
}

function splitsSurrogate(text: string, offset: number): boolean {
  const left = text.charCodeAt(offset - 1);
  const right = text.charCodeAt(offset);
  return left >= 0xd800 && left <= 0xdbff && right >= 0xdc00 && right <= 0xdfff;
}

function hasControl(value: string): boolean {
  return [...value].some((char) => char.charCodeAt(0) <= 0x1f || char.charCodeAt(0) === 0x7f);
}

function safeEditorUrl(value: string | null): boolean {
  if (!value || hasControl(value)) return false;
  try {
    const url = new URL(value);
    if (url.username || url.password) return false;
    if (url.protocol === 'https:') return Boolean(url.hostname);
    // FLAG: Match the mini app's exact user-link shape, including opaque MAX identifiers.
    return (
      url.protocol === 'max:' &&
      url.hostname === 'user' &&
      url.pathname.startsWith('/') &&
      url.pathname.length > 1 &&
      !url.pathname.slice(1).includes('/') &&
      !url.port &&
      !url.search &&
      !url.hash
    );
  } catch {
    return false;
  }
}
