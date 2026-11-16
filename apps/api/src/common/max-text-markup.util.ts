export const MAX_TEXT_MARKUP_TYPES = [
  'emphasized',
  'heading',
  'highlighted',
  'link',
  'monospaced',
  'quote',
  'strikethrough',
  'strong',
  'underline',
  'user_mention',
] as const;

export type MaxTextMarkupType = (typeof MAX_TEXT_MARKUP_TYPES)[number];

export type MaxTextMarkup = {
  from: number;
  length: number;
  type: MaxTextMarkupType;
  url: string | null;
  userLink: string | null;
};

const MAX_TEXT_MARKUP_TYPE_SET = new Set<string>(MAX_TEXT_MARKUP_TYPES);

export function isMaxTextMarkupType(value: string): value is MaxTextMarkupType {
  return MAX_TEXT_MARKUP_TYPE_SET.has(value);
}

export function normalizeMaxUserMentionLink(userLink: unknown, userId: unknown): string | null {
  if (typeof userLink === 'string' && userLink.trim()) {
    return userLink.trim();
  }

  let normalizedUserId: string | null = null;
  if (typeof userId === 'number' && Number.isSafeInteger(userId) && userId > 0) {
    normalizedUserId = String(userId);
  } else if (typeof userId === 'bigint' && userId > 0n) {
    normalizedUserId = userId.toString();
  } else if (typeof userId === 'string') {
    const candidate = userId.trim();
    if (/^\d{1,32}$/u.test(candidate) && !/^0+$/u.test(candidate)) {
      normalizedUserId = candidate.replace(/^0+(?=\d)/u, '');
    }
  }

  return normalizedUserId ? `max://user/${normalizedUserId}` : null;
}

export function renderMaxTextMarkupAsHtml(text: string, markup: MaxTextMarkup[]): string | null {
  if (markup.length === 0) {
    return null;
  }

  const ranges: Array<{
    start: number;
    end: number;
    open: string;
    close: string;
    priority: number;
  }> = [];
  const boundaries = new Set<number>([0, text.length]);

  for (const item of markup) {
    const start = item.from;
    const end = item.from + item.length;

    if (start < 0 || end <= start || end > text.length) {
      continue;
    }

    for (const segment of splitMarkupRangeByLines(text, start, end)) {
      const tag = resolveMarkupHtmlTags(item, text.slice(segment.start, segment.end));
      if (!tag) {
        continue;
      }
      ranges.push({
        start: segment.start,
        end: segment.end,
        open: tag.open,
        close: tag.close,
        priority: tag.priority,
      });
      boundaries.add(segment.start);
      boundaries.add(segment.end);
    }
  }

  if (ranges.length === 0) {
    return null;
  }

  let html = '';
  let previousActive: typeof ranges = [];
  const sortedBoundaries = Array.from(boundaries).sort((left, right) => left - right);
  for (let index = 0; index < sortedBoundaries.length - 1; index += 1) {
    const start = sortedBoundaries[index] ?? 0;
    const end = sortedBoundaries[index + 1] ?? start;
    if (end <= start) {
      continue;
    }
    const active = canonicalizeActiveMarkupRanges(
      ranges.filter((range) => range.start <= start && range.end >= end),
    );
    let sharedPrefixLength = 0;
    while (
      sharedPrefixLength < previousActive.length &&
      sharedPrefixLength < active.length &&
      hasSameMarkupDelimiters(previousActive[sharedPrefixLength], active[sharedPrefixLength])
    ) {
      sharedPrefixLength += 1;
    }
    html += previousActive
      .slice(sharedPrefixLength)
      .reverse()
      .map((range) => range.close)
      .join('');
    html += active
      .slice(sharedPrefixLength)
      .map((range) => range.open)
      .join('');
    const visible = escapeHtmlPreservingWhitespace(text.slice(start, end));
    html += visible;
    previousActive = active;
  }
  html += previousActive
    .slice()
    .reverse()
    .map((range) => range.close)
    .join('');

  return html;
}

function hasSameMarkupDelimiters(
  left: { open: string; close: string; priority: number } | undefined,
  right: { open: string; close: string; priority: number } | undefined,
): boolean {
  return Boolean(
    left &&
      right &&
      left.open === right.open &&
      left.close === right.close &&
      left.priority === right.priority,
  );
}

export function renderMaxTextMarkupAsMarkdown(
  text: string,
  markup: MaxTextMarkup[],
): string | null {
  if (markup.length === 0) {
    return null;
  }

  const ranges: Array<{
    start: number;
    end: number;
    open: string;
    close: string;
    priority: number;
    monospaced: boolean;
  }> = [];
  const boundaries = new Set<number>([0, text.length]);

  for (const item of markup) {
    const start = item.from;
    const end = item.from + item.length;
    if (start < 0 || end <= start || end > text.length) {
      continue;
    }
    for (const segment of splitMarkupRangeByLines(text, start, end)) {
      const visibleText = text.slice(segment.start, segment.end);
      if (item.type === 'link' && item.url && isRedundantAutoLink(visibleText, item.url)) {
        continue;
      }
      const delimiters = resolveMarkupMarkdownDelimiters(
        item,
        visibleText,
      );
      if (!delimiters) {
        continue;
      }
      ranges.push({
        start: segment.start,
        end: segment.end,
        ...delimiters,
        monospaced: item.type === 'monospaced',
      });
      boundaries.add(segment.start);
      boundaries.add(segment.end);
    }
  }

  if (ranges.length === 0) {
    return null;
  }

  let markdown = '';
  let previousActive: typeof ranges = [];
  const sortedBoundaries = [...boundaries].sort((left, right) => left - right);
  for (let index = 0; index < sortedBoundaries.length - 1; index += 1) {
    const start = sortedBoundaries[index] ?? 0;
    const end = sortedBoundaries[index + 1] ?? start;
    if (end <= start) {
      continue;
    }
    const active = canonicalizeActiveMarkupRanges(
      ranges.filter((range) => range.start <= start && range.end >= end),
    );
    let sharedPrefixLength = 0;
    while (
      sharedPrefixLength < previousActive.length &&
      sharedPrefixLength < active.length &&
      hasSameMarkdownDelimiters(
        previousActive[sharedPrefixLength],
        active[sharedPrefixLength],
      )
    ) {
      sharedPrefixLength += 1;
    }
    markdown += previousActive
      .slice(sharedPrefixLength)
      .reverse()
      .map((range) => range.close)
      .join('');
    markdown += active
      .slice(sharedPrefixLength)
      .map((range) => range.open)
      .join('');
    const visible = text.slice(start, end);
    markdown += active.some((range) => range.monospaced)
      ? visible
      : escapeMarkdownText(visible);
    previousActive = active;
  }
  markdown += previousActive
    .slice()
    .reverse()
    .map((range) => range.close)
    .join('');
  return markdown;
}

function hasSameMarkdownDelimiters(
  left:
    | { open: string; close: string; priority: number; monospaced: boolean }
    | undefined,
  right:
    | { open: string; close: string; priority: number; monospaced: boolean }
    | undefined,
): boolean {
  return Boolean(
    left &&
      right &&
      left.open === right.open &&
      left.close === right.close &&
      left.priority === right.priority &&
      left.monospaced === right.monospaced,
  );
}

function canonicalizeActiveMarkupRanges<
  T extends {
    start: number;
    end: number;
    open: string;
    close: string;
    priority: number;
  },
>(ranges: T[]): T[] {
  const deduplicated = new Map<string, T>();
  for (const range of ranges) {
    const key = `${range.priority}\0${range.open}\0${range.close}`;
    const current = deduplicated.get(key);
    if (
      !current ||
      range.end - range.start < current.end - current.start ||
      (range.end - range.start === current.end - current.start && range.start > current.start)
    ) {
      deduplicated.set(key, range);
    }
  }
  const unique = [...deduplicated.values()];
  const anchors = unique
    .filter((range) => range.open.startsWith('<a ') || range.open === '[')
    .sort(
      (left, right) =>
        left.end - left.start - (right.end - right.start) ||
        right.start - left.start ||
        left.open.localeCompare(right.open),
    );
  const selectedAnchor = anchors[0] ?? null;
  return unique
    .filter(
      (range) =>
        (!range.open.startsWith('<a ') && range.open !== '[') || range === selectedAnchor,
    )
    .sort(
      (left, right) =>
        left.priority - right.priority ||
        right.end - right.start - (left.end - left.start) ||
        left.start - right.start ||
        left.open.localeCompare(right.open),
    );
}

function splitMarkupRangeByLines(
  text: string,
  start: number,
  end: number,
): Array<{ start: number; end: number }> {
  const segments: Array<{ start: number; end: number }> = [];
  let segmentStart = start;

  for (let index = start; index < end; index += 1) {
    const character = text[index];
    if (character !== '\n' && character !== '\r') {
      continue;
    }
    if (segmentStart < index && text.slice(segmentStart, index).trim().length > 0) {
      segments.push({ start: segmentStart, end: index });
    }
    if (character === '\r' && text[index + 1] === '\n' && index + 1 < end) {
      index += 1;
    }
    segmentStart = index + 1;
  }

  if (segmentStart < end && text.slice(segmentStart, end).trim().length > 0) {
    segments.push({ start: segmentStart, end });
  }
  return segments;
}

function resolveMarkupMarkdownDelimiters(
  markup: MaxTextMarkup,
  visibleText: string,
): { open: string; close: string; priority: number } | null {
  switch (markup.type) {
    case 'strong':
      return { open: '**', close: '**', priority: 20 };
    case 'heading':
      return { open: '# ', close: '', priority: 5 };
    case 'highlighted':
      return { open: '^^', close: '^^', priority: 25 };
    case 'quote':
      return { open: '> ', close: '', priority: 4 };
    case 'emphasized':
      return { open: '_', close: '_', priority: 30 };
    case 'underline':
      return { open: '++', close: '++', priority: 40 };
    case 'strikethrough':
      return { open: '~~', close: '~~', priority: 50 };
    case 'monospaced':
      return visibleText.includes('\n') || visibleText.includes('`')
        ? null
        : { open: '`', close: '`', priority: 60 };
    case 'link':
      return markup.url ? resolveMarkdownLinkDelimiters(markup.url) : null;
    case 'user_mention': {
      const mentionTarget = resolveMaxUserMentionHref(markup.userLink);
      return mentionTarget ? resolveMarkdownLinkDelimiters(mentionTarget) : null;
    }
    default:
      return null;
  }
}

function isRedundantAutoLink(visibleText: string, targetUrl: string): boolean {
  const normalizedVisibleText = visibleText.trim();
  const normalizedTargetUrl = normalizeSafeMarkupUrl(targetUrl);
  return (
    Boolean(normalizedVisibleText && normalizedTargetUrl) &&
    /^(https?:\/\/|max:\/\/)\S+$/iu.test(normalizedVisibleText) &&
    normalizeComparableUrl(normalizedVisibleText) ===
      normalizeComparableUrl(normalizedTargetUrl ?? '')
  );
}

function normalizeComparableUrl(value: string): string {
  return (normalizeSafeMarkupUrl(value) ?? value.trim()).replace(/\/+$/u, '');
}

function escapeMarkdownText(value: string): string {
  return value.replace(/([\\`#^>*_[\]()~+])/gu, '\\$1');
}

function resolveMarkdownLinkDelimiters(
  value: string,
): { open: string; close: string; priority: number } | null {
  const destination = serializeMarkdownDestination(value);
  return destination ? { open: '[', close: `](${destination})`, priority: 10 } : null;
}

function serializeMarkdownDestination(value: string): string | null {
  const safeUrl = normalizeSafeMarkupUrl(value);
  return safeUrl
    ? safeUrl.replaceAll('\\', '%5C').replaceAll('(', '%28').replaceAll(')', '%29')
    : null;
}

function normalizeSafeMarkupUrl(value: string | null): string | null {
  const candidate = value?.trim() ?? '';
  if (!candidate) {
    return null;
  }
  try {
    const parsed = new URL(candidate);
    if (
      (parsed.protocol !== 'http:' && parsed.protocol !== 'https:' && parsed.protocol !== 'max:') ||
      parsed.username ||
      parsed.password
    ) {
      return null;
    }
    return parsed.toString().replaceAll('\\', '%5C');
  } catch {
    return null;
  }
}

export function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

export function escapeHtmlAttribute(value: string): string {
  return escapeHtml(value).replaceAll("'", '&#39;');
}

export function escapeHtmlPreservingWhitespace(value: string): string {
  return escapeHtml(value)
    .replace(/\t/g, '&nbsp;&nbsp;&nbsp;&nbsp;')
    .replace(/ {2,}/g, (match) => '&nbsp;'.repeat(match.length));
}

function resolveMarkupHtmlTags(
  markup: MaxTextMarkup,
  visibleText: string,
): { open: string; close: string; priority: number } | null {
  switch (markup.type) {
    case 'strong':
      return { open: '<strong>', close: '</strong>', priority: 20 };
    case 'heading':
      return { open: '<h3>', close: '</h3>', priority: 5 };
    case 'highlighted':
      return { open: '<mark>', close: '</mark>', priority: 25 };
    case 'quote':
      return { open: '<blockquote>', close: '</blockquote>', priority: 4 };
    case 'emphasized':
      return { open: '<em>', close: '</em>', priority: 30 };
    case 'underline':
      return { open: '<u>', close: '</u>', priority: 40 };
    case 'strikethrough':
      return { open: '<del>', close: '</del>', priority: 50 };
    case 'monospaced':
      return visibleText.includes('\n')
        ? { open: '<pre>', close: '</pre>', priority: 60 }
        : { open: '<code>', close: '</code>', priority: 60 };
    case 'link': {
      const target = normalizeSafeMarkupUrl(markup.url);
      return target
        ? {
            open: `<a href="${escapeHtmlAttribute(target)}">`,
            close: '</a>',
            priority: 10,
          }
        : null;
    }
    case 'user_mention': {
      const mentionTarget = resolveMaxUserMentionHref(markup.userLink);
      return mentionTarget
        ? {
            open: `<a href="${escapeHtmlAttribute(mentionTarget)}">`,
            close: '</a>',
            priority: 10,
          }
        : null;
    }
    default:
      return null;
  }
}

export function resolveMaxUserMentionHref(value: string | null): string | null {
  if (!value) {
    return null;
  }

  const normalized = value.trim();
  if (!normalized) {
    return null;
  }

  const trimmed = normalized.replace(/^\/+/u, '');
  const candidate = /^(?:max:\/\/|https?:\/\/)/iu.test(normalized)
    ? normalized
    : trimmed.startsWith('user/')
      ? `max://${trimmed}`
      : `https://max.ru/${trimmed}`;
  return normalizeSafeMarkupUrl(candidate);
}
