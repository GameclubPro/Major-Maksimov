export type InlineToken =
  | { type: 'text'; content: string }
  | { type: 'bold' | 'italic' | 'underline' | 'strike' | 'highlight'; children: InlineToken[] }
  | { type: 'code'; content: string }
  | { type: 'link'; href: string; children: InlineToken[] };

type RenderMarkdownOptions = {
  linkMode?: 'anchor' | 'underline';
  blockMode?: 'paragraphs' | 'raw';
};

export const MAX_MESSAGE_TEXT_LENGTH = 4_000;

export type PreparedMaxMarkdownText = {
  text: string;
  textFormat: 'html' | 'markdown';
};

const SAFE_LINK_PATTERN = /^(https?:\/\/|max:\/\/)/iu;
const HEADING_LINE_PATTERN = /^(#{1,6})[ \t]+(.+)$/u;
const QUOTE_LINE_PATTERN = /^>[ \t]+(.+)$/u;
const SUPPORTED_MARKDOWN_PATTERN =
  /(?:^#{1,6}\s+\S.*$|^>\s+\S.*$|```[\s\S]+?```|\*\*\*[^*\n]+?\*\*\*|___[^_\n]+?___|\*\*[^*\n]+?\*\*|__[^_\n]+?__|\*[^*\n]+?\*|_[^_\n]+?_|~~[^~\n]+?~~|\+\+[^+\n]+?\+\+|\^\^[^^\n]+?\^\^|`[^`\n]+`|\[[^\]\n]+\]\((?:https?:\/\/|max:\/\/)[^)]+\))/mu;
const ESCAPABLE_MARKDOWN_CHARACTERS = new Set([
  '\\',
  '`',
  '*',
  '_',
  '[',
  ']',
  '(',
  ')',
  '~',
  '+',
  '#',
  '^',
  '>',
]);
const MULTILINE_INLINE_MARKERS = ['***', '___', '**', '__', '++', '~~', '^^', '*', '_'] as const;

type MultilineInlineMarker = (typeof MULTILINE_INLINE_MARKERS)[number];

type MultilineInlineSpan = {
  openStart: number;
  openEnd: number;
  closeStart: number;
  closeEnd: number;
  open: string;
  close: string;
};

export function containsSupportedMarkdownSyntax(source: string): boolean {
  const normalized = normalizeMultilineStrongMarkdown(source.replace(/\r/g, '').trim());
  return (
    SUPPORTED_MARKDOWN_PATTERN.test(normalized) ||
    extractSupportedMarkdownLinks(normalized).length > 0
  );
}

export function renderSupportedMarkdownAsHtml(
  source: string,
  options: RenderMarkdownOptions = {},
): string {
  const normalized = normalizeMultilineStrongMarkdown(source.replace(/\r/g, ''));
  if (!normalized.trim()) {
    return '';
  }

  if (options.blockMode === 'raw') {
    const renderedLines: string[] = [];
    const lines = normalized.split('\n');

    for (let index = 0; index < lines.length; index += 1) {
      const fencedCodeBlock = readFencedCodeBlock(lines, index);
      if (fencedCodeBlock) {
        renderedLines.push(renderCodeBlockHtml(fencedCodeBlock.content));
        index = fencedCodeBlock.nextIndex - 1;
        continue;
      }

      const rawLine = lines[index] ?? '';
      const trimmedLine = rawLine.trim();
      if (!trimmedLine) {
        renderedLines.push(escapeHtmlPreservingWhitespace(rawLine));
        continue;
      }

      const headingMatch = HEADING_LINE_PATTERN.exec(rawLine.trimStart());
      if (headingMatch) {
        const content = renderInlineTokens(parseInlineTokens(headingMatch[2] ?? ''), options);
        renderedLines.push(
          escapeHtmlPreservingWhitespace(
            rawLine.slice(0, rawLine.length - rawLine.trimStart().length),
          ) + renderHeadingHtml(content, headingMatch[1] ?? '#'),
        );
        continue;
      }

      const quoteMatch = QUOTE_LINE_PATTERN.exec(rawLine.trimStart());
      if (quoteMatch) {
        const content = renderInlineTokens(parseInlineTokens(quoteMatch[1] ?? ''), options);
        renderedLines.push(
          escapeHtmlPreservingWhitespace(
            rawLine.slice(0, rawLine.length - rawLine.trimStart().length),
          ) + renderQuoteHtml(content),
        );
        continue;
      }

      renderedLines.push(renderInlineTokens(parseInlineTokens(rawLine), options));
    }

    return renderedLines.join('\n');
  }

  const blocks: string[] = [];
  let paragraphLines: string[] = [];
  const lines = normalized.split('\n');

  const flushParagraph = () => {
    if (paragraphLines.length === 0) {
      return;
    }

    const renderedLines = paragraphLines.map((line) =>
      renderInlineTokens(parseInlineTokens(line), options),
    );
    blocks.push(`<p>${renderedLines.join('<br>')}</p>`);
    paragraphLines = [];
  };

  for (let index = 0; index < lines.length; index += 1) {
    const fencedCodeBlock = readFencedCodeBlock(lines, index);
    if (fencedCodeBlock) {
      flushParagraph();
      blocks.push(renderCodeBlockHtml(fencedCodeBlock.content));
      index = fencedCodeBlock.nextIndex - 1;
      continue;
    }

    const rawLine = lines[index] ?? '';
    const line = rawLine.trimEnd();
    const trimmedLine = line.trim();
    if (!trimmedLine) {
      flushParagraph();
      continue;
    }

    const headingMatch = HEADING_LINE_PATTERN.exec(trimmedLine);
    if (headingMatch) {
      flushParagraph();
      const content = renderInlineTokens(parseInlineTokens(headingMatch[2] ?? ''), options);
      blocks.push(renderHeadingHtml(content, headingMatch[1] ?? '#'));
      continue;
    }

    const quoteMatch = QUOTE_LINE_PATTERN.exec(trimmedLine);
    if (quoteMatch) {
      flushParagraph();
      const content = renderInlineTokens(parseInlineTokens(quoteMatch[1] ?? ''), options);
      blocks.push(renderQuoteHtml(content));
      continue;
    }

    paragraphLines.push(line);
  }

  flushParagraph();

  return blocks.join('');
}

export function prepareMarkdownForMaxDelivery(
  source: string,
  maxLength = MAX_MESSAGE_TEXT_LENGTH,
): PreparedMaxMarkdownText | null {
  const html = renderSupportedMarkdownAsHtml(source, { blockMode: 'raw' });
  if (html.length <= maxLength) {
    return { text: html, textFormat: 'html' };
  }

  return source.length <= maxLength ? { text: source, textFormat: 'markdown' } : null;
}

export function prepareFormattedTextForMaxDelivery(
  source: string,
  textFormat: PreparedMaxMarkdownText['textFormat'],
  maxLength = MAX_MESSAGE_TEXT_LENGTH,
): PreparedMaxMarkdownText | null {
  if (textFormat === 'markdown') {
    return prepareMarkdownForMaxDelivery(source, maxLength);
  }

  return source.length <= maxLength ? { text: source, textFormat } : null;
}

export function stripSupportedMarkdownToPlainText(source: string): string {
  const normalized = normalizeMultilineStrongMarkdown(source.replace(/\r/g, '').trim());
  if (!normalized) {
    return '';
  }

  const blocks: string[] = [];
  let paragraphLines: string[] = [];
  const lines = normalized.split('\n');

  const flushParagraph = () => {
    if (paragraphLines.length === 0) {
      return;
    }

    blocks.push(
      paragraphLines
        .map((line) => renderInlineTokensAsPlainText(parseInlineTokens(line)))
        .join('\n'),
    );
    paragraphLines = [];
  };

  for (let index = 0; index < lines.length; index += 1) {
    const fencedCodeBlock = readFencedCodeBlock(lines, index);
    if (fencedCodeBlock) {
      flushParagraph();
      blocks.push(fencedCodeBlock.content);
      index = fencedCodeBlock.nextIndex - 1;
      continue;
    }

    const rawLine = lines[index] ?? '';
    const line = rawLine.trimEnd();
    const trimmedLine = line.trim();
    if (!trimmedLine) {
      flushParagraph();
      continue;
    }

    const headingMatch = HEADING_LINE_PATTERN.exec(trimmedLine);
    if (headingMatch) {
      flushParagraph();
      blocks.push(renderInlineTokensAsPlainText(parseInlineTokens(headingMatch[2] ?? '')));
      continue;
    }

    const quoteMatch = QUOTE_LINE_PATTERN.exec(trimmedLine);
    if (quoteMatch) {
      flushParagraph();
      blocks.push(renderInlineTokensAsPlainText(parseInlineTokens(quoteMatch[1] ?? '')));
      continue;
    }

    paragraphLines.push(line);
  }

  flushParagraph();

  return blocks.join('\n\n');
}

export function extractSupportedMarkdownLinks(source: string): string[] {
  const links = new Set<string>();
  const lines = normalizeMultilineStrongMarkdown(source.replace(/\r/g, '')).split('\n');

  for (let index = 0; index < lines.length; index += 1) {
    const fencedCodeBlock = readFencedCodeBlock(lines, index);
    if (fencedCodeBlock) {
      index = fencedCodeBlock.nextIndex - 1;
      continue;
    }

    collectInlineTokenLinks(parseInlineTokens(lines[index] ?? ''), links);
  }

  return [...links];
}

export function containsSupportedMarkdownUrl(source: string, url: string): boolean {
  if (!url) {
    return false;
  }
  return (
    extractSupportedMarkdownLinks(source).includes(url) ||
    stripSupportedMarkdownToPlainText(source).includes(url)
  );
}

function collectInlineTokenLinks(tokens: InlineToken[], links: Set<string>): void {
  for (const token of tokens) {
    if (token.type === 'link') {
      links.add(token.href);
      collectInlineTokenLinks(token.children, links);
      continue;
    }
    if ('children' in token) {
      collectInlineTokenLinks(token.children, links);
    }
  }
}

/**
 * The rich editor can serialize one inline entity across several paragraphs.
 * Pair delimiters in one bounded scan, then close and reopen active entities at
 * line boundaries so MAX never receives raw generated markers.
 */
export function normalizeMultilineStrongMarkdown(source: string): string {
  if (!source.includes('\n')) {
    return source;
  }
  const context = buildMultilineScanContext(source);
  const spans = collectMultilineInlineSpans(source, context);
  return spans.length > 0 ? renderLineBoundedMarkdown(source, spans, context) : source;
}

type MultilineScanContext = {
  escaped: Uint8Array;
  protected: Uint8Array;
  fenced: Uint8Array;
  url: Uint8Array;
  lineStart: Int32Array;
  lineEnd: Int32Array;
  newlinePrefix: Int32Array;
};

type PendingInlineFrame = {
  openStart: number;
  openEnd: number;
  open: string;
  marker: MultilineInlineMarker | null;
  invalid: boolean;
};

function buildMultilineScanContext(source: string): MultilineScanContext {
  const escaped = new Uint8Array(source.length);
  const protectedMask = new Uint8Array(source.length);
  const fencedMask = new Uint8Array(source.length);
  const url = new Uint8Array(source.length);
  const lineStart = new Int32Array(source.length);
  const lineEnd = new Int32Array(source.length);
  const newlinePrefix = new Int32Array(source.length + 1);

  let backslashRun = 0;
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] === '\\') {
      backslashRun += 1;
    } else {
      if (backslashRun % 2 === 1) {
        escaped[index] = 1;
      }
      backslashRun = 0;
    }
    newlinePrefix[index + 1] = newlinePrefix[index] + (source[index] === '\n' ? 1 : 0);
  }

  let cursor = 0;
  let fenced = false;
  while (cursor <= source.length) {
    const newline = source.indexOf('\n', cursor);
    const end = newline === -1 ? source.length : newline;
    const line = source.slice(cursor, end);
    const fenceLine = line.trim().startsWith('```');
    const protectLine = fenced || fenceLine;
    for (let index = cursor; index < end; index += 1) {
      lineStart[index] = cursor;
      lineEnd[index] = end;
      if (protectLine) {
        protectedMask[index] = 1;
        fencedMask[index] = 1;
      }
    }
    if (newline !== -1) {
      lineStart[newline] = cursor;
      lineEnd[newline] = end;
      if (protectLine) {
        protectedMask[newline] = 1;
        fencedMask[newline] = 1;
      }
    }
    if (fenceLine) fenced = !fenced;
    if (newline === -1) break;
    cursor = newline + 1;
  }

  const urlPattern = /(?:https?:\/\/|max:\/\/)[^\s<>()\]["'`{}]+/giu;
  for (const match of source.matchAll(urlPattern)) {
    const start = match.index;
    const end = start + match[0].length;
    url.fill(1, start, end);
  }

  for (let index = 0; index < source.length; index += 1) {
    if (protectedMask[index] || source[index] !== '`' || escaped[index]) continue;
    const end = source.indexOf('`', index + 1);
    const boundedEnd = end === -1 || end > lineEnd[index] ? lineEnd[index] : end;
    protectedMask.fill(1, index, Math.min(source.length, boundedEnd + 1));
    index = boundedEnd;
  }

  return {
    escaped,
    protected: protectedMask,
    fenced: fencedMask,
    url,
    lineStart,
    lineEnd,
    newlinePrefix,
  };
}

function collectMultilineInlineSpans(
  source: string,
  context: MultilineScanContext,
): MultilineInlineSpan[] {
  const frames = new Map<string, PendingInlineFrame>();
  const spans: MultilineInlineSpan[] = [];

  for (let index = 0; index < source.length; index += 1) {
    if (context.fenced[index]) {
      frames.clear();
      continue;
    }
    if (context.protected[index]) continue;

    const linkClose = readLinkCloseAt(source, index, context);
    if (linkClose) {
      const frame = frames.get('link');
      if (frame) {
        frames.delete('link');
        if (!frame.invalid && context.newlinePrefix[index] > context.newlinePrefix[frame.openEnd]) {
          spans.push({
            openStart: frame.openStart,
            openEnd: frame.openEnd,
            closeStart: index,
            closeEnd: linkClose.closeEnd,
            open: '[',
            close: source.slice(index, linkClose.closeEnd),
          });
        }
        index = linkClose.closeEnd - 1;
        continue;
      }
    }

    if (
      source[index] === '[' &&
      !context.escaped[index] &&
      !context.url[index] &&
      !/\s/u.test(source[index + 1] ?? '')
    ) {
      const current = frames.get('link');
      if (current) current.invalid = true;
      else
        frames.set('link', {
          openStart: index,
          openEnd: index + 1,
          open: '[',
          marker: null,
          invalid: false,
        });
      continue;
    }

    const marker = MULTILINE_INLINE_MARKERS.find((candidate) =>
      isMarkerAt(source, index, candidate, context),
    );
    if (!marker) continue;
    const canClose =
      isLikelyMarkerClose(source, index, marker, context) ||
      isStandaloneMarkerLine(source, index, marker, context);
    const frame = frames.get(marker);
    if (canClose && frame) {
      frames.delete(marker);
      if (!frame.invalid && context.newlinePrefix[index] > context.newlinePrefix[frame.openEnd]) {
        spans.push({
          openStart: frame.openStart,
          openEnd: frame.openEnd,
          closeStart: index,
          closeEnd: index + marker.length,
          open: marker,
          close: marker,
        });
      }
      index += marker.length - 1;
      continue;
    }
    if (isLikelyMarkerOpen(source, index, marker, context)) {
      if (frame) frame.invalid = true;
      else
        frames.set(marker, {
          openStart: index,
          openEnd: index + marker.length,
          open: marker,
          marker,
          invalid: false,
        });
      index += marker.length - 1;
    }
  }

  return discardCrossingSpans(spans);
}

function discardCrossingSpans(spans: MultilineInlineSpan[]): MultilineInlineSpan[] {
  const sorted = spans
    .slice()
    .sort((left, right) => left.openStart - right.openStart || right.closeEnd - left.closeEnd);
  const accepted: MultilineInlineSpan[] = [];
  const stack: MultilineInlineSpan[] = [];
  for (const span of sorted) {
    while (stack.length > 0 && (stack.at(-1)?.closeEnd ?? 0) <= span.openStart) stack.pop();
    const parent = stack.at(-1);
    if (parent && span.closeEnd > parent.closeStart) continue;
    accepted.push(span);
    stack.push(span);
  }
  return accepted;
}

function renderLineBoundedMarkdown(
  source: string,
  spans: MultilineInlineSpan[],
  context: MultilineScanContext,
): string {
  const opening = new Map(spans.map((span) => [span.openStart, span]));
  const closing = new Map(spans.map((span) => [span.closeStart, span]));
  const active: MultilineInlineSpan[] = [];
  let pending: MultilineInlineSpan[] | null = null;
  let output = '';
  let suppressLineBreak = false;

  for (let index = 0; index < source.length; ) {
    const lineEnd = context.lineEnd[index] ?? source.length;
    if (pending?.length && index === (context.lineStart[index] ?? index)) {
      suppressLineBreak = lineContainsOnlyPendingClosers(source, index, lineEnd, pending, closing);
      if (!suppressLineBreak) {
        if (source.slice(index, lineEnd).trim()) {
          output += pending.map((span) => span.open).join('');
          pending = null;
        }
      }
    }

    const openSpan = opening.get(index);
    if (openSpan) {
      output += source.slice(openSpan.openStart, openSpan.openEnd);
      active.push(openSpan);
      index = openSpan.openEnd;
      continue;
    }
    const closeSpan = closing.get(index);
    if (closeSpan) {
      const physicallyClosed = Boolean(pending?.includes(closeSpan));
      if (!physicallyClosed) output += source.slice(closeSpan.closeStart, closeSpan.closeEnd);
      const activeIndex = active.lastIndexOf(closeSpan);
      if (activeIndex >= 0) active.splice(activeIndex, 1);
      if (pending) {
        pending = pending.filter((span) => span !== closeSpan);
        if (pending.length === 0) pending = null;
      }
      index = closeSpan.closeEnd;
      continue;
    }
    if (source[index] === '\n') {
      if (!pending && active.length > 0) {
        output += active
          .slice()
          .reverse()
          .map((span) => span.close)
          .join('');
        pending = active.slice();
      }
      if (!suppressLineBreak) output += '\n';
      suppressLineBreak = false;
      index += 1;
      continue;
    }

    const ambiguous = active
      .slice()
      .reverse()
      .find(
        (span) =>
          span.open === span.close &&
          source.startsWith(span.open, index) &&
          isAmbiguousMarkerPosition(source, index, span.open as MultilineInlineMarker, context),
      );
    if (ambiguous) {
      output += [...ambiguous.open].map((character) => `\\${character}`).join('');
      index += ambiguous.open.length;
      continue;
    }
    output += source[index] ?? '';
    index += 1;
  }
  return output;
}

function lineContainsOnlyPendingClosers(
  source: string,
  start: number,
  end: number,
  pending: MultilineInlineSpan[],
  closing: Map<number, MultilineInlineSpan>,
): boolean {
  let cursor = start;
  let found = false;
  while (cursor < end) {
    if (/\s/u.test(source[cursor] ?? '')) {
      cursor += 1;
      continue;
    }
    const span = closing.get(cursor);
    if (!span || !pending.includes(span)) return false;
    found = true;
    cursor = span.closeEnd;
  }
  return found;
}

function isMarkerAt(
  source: string,
  index: number,
  marker: MultilineInlineMarker,
  context: MultilineScanContext,
): boolean {
  if (!source.startsWith(marker, index) || context.escaped[index] || context.protected[index]) {
    return false;
  }
  const character = marker[0];
  return source[index - 1] !== character && source[index + marker.length] !== character;
}

function isLikelyMarkerOpen(
  source: string,
  index: number,
  marker: MultilineInlineMarker,
  context: MultilineScanContext,
): boolean {
  const previous = source[index - 1] ?? '';
  const next = source[index + marker.length] ?? '';
  return (
    next.length > 0 && !/\s/u.test(next) && !/[\p{L}\p{N}]/u.test(previous) && !context.url[index]
  );
}

function isLikelyMarkerClose(
  source: string,
  index: number,
  marker: MultilineInlineMarker,
  context: MultilineScanContext,
): boolean {
  const previous = source[index - 1] ?? '';
  const next = source[index + marker.length] ?? '';
  return (
    previous.length > 0 &&
    !/\s/u.test(previous) &&
    !(/[\p{L}\p{N}]/u.test(previous) && /[\p{L}\p{N}]/u.test(next)) &&
    (!context.url[index] || !context.url[index + marker.length])
  );
}

function isStandaloneMarkerLine(
  source: string,
  index: number,
  marker: MultilineInlineMarker,
  context: MultilineScanContext,
): boolean {
  return source.slice(context.lineStart[index], context.lineEnd[index]).trim() === marker;
}

function isAmbiguousMarkerPosition(
  source: string,
  index: number,
  marker: MultilineInlineMarker,
  context: MultilineScanContext,
): boolean {
  if (!isMarkerAt(source, index, marker, context)) return false;
  const previous = source[index - 1] ?? '';
  const next = source[index + marker.length] ?? '';
  return context.url[index] === 1 || (/[\p{L}\p{N}]/u.test(previous) && /[\p{L}\p{N}]/u.test(next));
}

function readLinkCloseAt(
  source: string,
  index: number,
  context: MultilineScanContext,
): { closeEnd: number } | null {
  if (
    source[index] !== ']' ||
    source[index + 1] !== '(' ||
    context.escaped[index] ||
    context.protected[index]
  ) {
    return null;
  }
  const destinationEnd = source.indexOf(')', index + 2);
  if (destinationEnd === -1) return null;
  const destination = source.slice(index + 2, destinationEnd);
  return destination && !/\s/u.test(destination) && SAFE_LINK_PATTERN.test(destination)
    ? { closeEnd: destinationEnd + 1 }
    : null;
}

function isEscapedMarkdownPosition(source: string, index: number): boolean {
  let precedingBackslashes = 0;
  for (let cursor = index - 1; cursor >= 0 && source[cursor] === '\\'; cursor -= 1) {
    precedingBackslashes += 1;
  }
  return precedingBackslashes % 2 === 1;
}

function renderHeadingHtml(content: string, marker: string): string {
  const level = Math.min(6, Math.max(1, marker.length));
  return `<h${level}>${content}</h${level}>`;
}

function renderQuoteHtml(content: string): string {
  return `<blockquote>${content}</blockquote>`;
}

function renderCodeBlockHtml(content: string): string {
  return `<pre>${escapeHtmlPreservingWhitespace(content)}</pre>`;
}

export function readFencedCodeBlock(
  lines: string[],
  startIndex: number,
): { content: string; nextIndex: number } | null {
  const openingLine = lines[startIndex]?.trim();
  if (!openingLine?.startsWith('```')) {
    return null;
  }

  const codeLines: string[] = [];
  for (let index = startIndex + 1; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    if (line.trim().startsWith('```')) {
      return {
        content: codeLines.join('\n'),
        nextIndex: index + 1,
      };
    }

    codeLines.push(line);
  }

  return {
    content: codeLines.join('\n'),
    nextIndex: lines.length,
  };
}

export function parseInlineTokens(source: string): InlineToken[] {
  const tokens: InlineToken[] = [];
  let cursor = 0;
  let plainText = '';

  const flushPlainText = () => {
    if (!plainText) {
      return;
    }

    tokens.push({ type: 'text', content: plainText });
    plainText = '';
  };

  while (cursor < source.length) {
    if (
      source[cursor] === '\\' &&
      cursor + 1 < source.length &&
      ESCAPABLE_MARKDOWN_CHARACTERS.has(source[cursor + 1] ?? '')
    ) {
      plainText += source[cursor + 1];
      cursor += 2;
      continue;
    }

    const token = matchToken(source.slice(cursor));
    if (!token) {
      plainText += source[cursor];
      cursor += 1;
      continue;
    }

    flushPlainText();
    tokens.push(token.node);
    cursor += token.rawLength;
  }

  flushPlainText();
  return tokens;
}

function matchToken(value: string): {
  rawLength: number;
  node: InlineToken;
} | null {
  const linkMatch = matchLinkToken(value);
  if (linkMatch) {
    return {
      rawLength: linkMatch.rawLength,
      node: {
        type: 'link',
        href: linkMatch.href,
        children: parseInlineTokens(linkMatch.label),
      },
    };
  }

  const codeMatch = /^`([^`\n]+)`/u.exec(value);
  if (codeMatch) {
    return {
      rawLength: codeMatch[0].length,
      node: {
        type: 'code',
        content: codeMatch[1] ?? '',
      },
    };
  }

  const boldItalicMatch =
    matchDelimitedInlineContent(value, '***') ?? matchDelimitedInlineContent(value, '___');
  if (boldItalicMatch) {
    return {
      rawLength: boldItalicMatch.rawLength,
      node: {
        type: 'bold',
        children: [
          {
            type: 'italic',
            children: parseInlineTokens(boldItalicMatch.content),
          },
        ],
      },
    };
  }

  const boldMatch =
    matchDelimitedInlineContent(value, '**') ?? matchDelimitedInlineContent(value, '__');
  if (boldMatch) {
    return {
      rawLength: boldMatch.rawLength,
      node: {
        type: 'bold',
        children: parseInlineTokens(boldMatch.content),
      },
    };
  }

  const underlineMatch = matchDelimitedInlineContent(value, '++');
  if (underlineMatch) {
    return {
      rawLength: underlineMatch.rawLength,
      node: {
        type: 'underline',
        children: parseInlineTokens(underlineMatch.content),
      },
    };
  }

  const strikeMatch = matchDelimitedInlineContent(value, '~~');
  if (strikeMatch) {
    return {
      rawLength: strikeMatch.rawLength,
      node: {
        type: 'strike',
        children: parseInlineTokens(strikeMatch.content),
      },
    };
  }

  const highlightMatch = matchDelimitedInlineContent(value, '^^');
  if (highlightMatch) {
    return {
      rawLength: highlightMatch.rawLength,
      node: {
        type: 'highlight',
        children: parseInlineTokens(highlightMatch.content),
      },
    };
  }

  const italicMatch =
    matchDelimitedInlineContent(value, '*') ?? matchDelimitedInlineContent(value, '_');
  if (italicMatch) {
    const content = italicMatch.content;
    if (/^[*_]+$/u.test(content)) {
      return null;
    }
    return {
      rawLength: italicMatch.rawLength,
      node: {
        type: 'italic',
        children: parseInlineTokens(content),
      },
    };
  }

  return null;
}

function matchLinkToken(value: string): { label: string; href: string; rawLength: number } | null {
  if (value[0] !== '[') {
    return null;
  }

  let backslashRun = 0;
  for (let index = 1; index < value.length; index += 1) {
    const character = value[index] ?? '';
    if (character === '\n') {
      return null;
    }
    if (character === '\\') {
      backslashRun += 1;
      continue;
    }
    const escaped = backslashRun % 2 === 1;
    backslashRun = 0;
    if (character !== ']' || escaped || value[index + 1] !== '(' || index === 1) {
      continue;
    }

    const destinationStart = index + 2;
    let destinationEnd = destinationStart;
    while (destinationEnd < value.length && value[destinationEnd] !== ')') {
      if (/\s/u.test(value[destinationEnd] ?? '')) {
        return null;
      }
      destinationEnd += 1;
    }
    if (destinationEnd >= value.length) {
      return null;
    }
    const href = value.slice(destinationStart, destinationEnd);
    if (!href || !SAFE_LINK_PATTERN.test(href)) {
      return null;
    }
    return {
      label: value.slice(1, index),
      href,
      rawLength: destinationEnd + 1,
    };
  }
  return null;
}

function matchDelimitedInlineContent(
  value: string,
  marker: MultilineInlineMarker,
): { content: string; rawLength: number } | null {
  if (!value.startsWith(marker)) {
    return null;
  }
  for (let index = marker.length; index <= value.length - marker.length; index += 1) {
    if (value[index] === '\n') {
      return null;
    }
    if (!value.startsWith(marker, index) || isEscapedMarkdownPosition(value, index)) {
      continue;
    }
    const content = value.slice(marker.length, index);
    if (!content) {
      continue;
    }
    return { content, rawLength: index + marker.length };
  }
  return null;
}

function renderInlineTokens(tokens: InlineToken[], options: RenderMarkdownOptions): string {
  return tokens
    .map((token) => {
      switch (token.type) {
        case 'text':
          return escapeHtmlPreservingWhitespace(token.content);
        case 'code':
          return `<code>${escapeHtmlPreservingWhitespace(token.content)}</code>`;
        case 'bold':
          return `<strong>${renderInlineTokens(token.children, options)}</strong>`;
        case 'italic':
          return `<em>${renderInlineTokens(token.children, options)}</em>`;
        case 'underline':
          return `<u>${renderInlineTokens(token.children, options)}</u>`;
        case 'strike':
          return `<s>${renderInlineTokens(token.children, options)}</s>`;
        case 'highlight':
          return `<mark>${renderInlineTokens(token.children, options)}</mark>`;
        case 'link':
          return renderLinkHtml(token, options);
      }
    })
    .join('');
}

function renderLinkHtml(
  token: Extract<InlineToken, { type: 'link' }>,
  options: RenderMarkdownOptions,
): string {
  const labelHtml = renderLinkLabelHtml(token, options);
  if (options.linkMode === 'underline') {
    return `<u>${labelHtml}</u>`;
  }

  return `<a href="${escapeAttribute(token.href)}">${labelHtml}</a>`;
}

function renderLinkLabelHtml(
  token: Extract<InlineToken, { type: 'link' }>,
  options: RenderMarkdownOptions,
): string {
  const plainLabel = renderInlineTokensAsPlainText(token.children).trim();
  if (!plainLabel) {
    return escapeHtml(token.href);
  }

  if (looksLikeUrlLabel(plainLabel, token.href)) {
    return escapeHtml(insertSoftBreaks(plainLabel));
  }

  return renderInlineTokens(token.children, options);
}

function looksLikeUrlLabel(label: string, href: string): boolean {
  if (!SAFE_LINK_PATTERN.test(label)) {
    return false;
  }

  return normalizeComparableUrl(label) === normalizeComparableUrl(href);
}

function normalizeComparableUrl(value: string): string {
  return value.trim().replace(/\/+$/u, '').toLowerCase();
}

function insertSoftBreaks(value: string): string {
  return value.replace(/([/.:?&=#_-])/g, '$1\u200B');
}

function renderInlineTokensAsPlainText(tokens: InlineToken[]): string {
  return tokens
    .map((token) => {
      switch (token.type) {
        case 'text':
          return token.content;
        case 'code':
          return token.content;
        case 'bold':
        case 'italic':
        case 'underline':
        case 'strike':
        case 'highlight':
        case 'link':
          return renderInlineTokensAsPlainText(token.children);
      }
    })
    .join('');
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeHtmlPreservingWhitespace(value: string): string {
  return escapeHtml(value)
    .replace(/\t/g, '&nbsp;&nbsp;&nbsp;&nbsp;')
    .replace(/ {2,}/g, (match) => '&nbsp;'.repeat(match.length));
}

function escapeAttribute(value: string): string {
  return escapeHtml(value);
}
