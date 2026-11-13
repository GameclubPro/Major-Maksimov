type InlineToken =
  | { type: 'text'; content: string }
  | { type: 'placeholder'; key: string; raw: string }
  | { type: 'bold' | 'italic' | 'underline' | 'strike' | 'highlight'; children: InlineToken[] }
  | { type: 'code'; content: string }
  | { type: 'link'; href: string; children: InlineToken[] };

type RenderMarkdownOptions = {
  resolveLinkHref?: (value: string) => string | null;
  linkMode?: 'anchor' | 'underline';
  blockMode?: 'paragraphs' | 'raw' | 'inline' | 'editor';
  preserveWhitespace?: boolean;
  preserveCurlyBracePlaceholders?: boolean;
  curlyBracePlaceholderLabels?: Readonly<Record<string, string>>;
};

type MultilineInlineMarker = '***' | '___' | '**' | '__' | '++' | '~~' | '^^' | '*' | '_';

const SAFE_LINK_PATTERN = /^(https?:\/\/|max:\/\/)/iu;
const HEADING_LINE_PATTERN = /^(#{1,6})[ \t]+(.+)$/u;
const QUOTE_LINE_PATTERN = /^>[ \t]+(.+)$/u;
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
const CURLY_BRACE_PLACEHOLDER_PATTERN = /^\{[A-Za-z0-9_]+\}/u;

export function needsLegacyMultilineMarkdownNormalization(source: string): boolean {
  return source.includes('\n') && /[*_+~^[\]]/u.test(source);
}

function isEscapedMarkdownPosition(source: string, index: number): boolean {
  let precedingBackslashes = 0;
  for (let cursor = index - 1; cursor >= 0 && source[cursor] === '\\'; cursor -= 1) {
    precedingBackslashes += 1;
  }
  return precedingBackslashes % 2 === 1;
}

export function stripSupportedMarkdownToPlainText(source: string): string {
  const normalized = source.replace(/\r/g, '').trim();
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
  const lines = source.replace(/\r/g, '').split('\n');

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

export function formatSupportedMarkdownPreview(source: string, maxLength: number): string {
  const normalized = stripSupportedMarkdownToPlainText(source).replace(/\s+/gu, ' ').trim();
  if (!normalized) {
    return '';
  }

  return normalized.length > maxLength
    ? `${normalized.slice(0, maxLength).trimEnd()}…`
    : normalized;
}

export function renderSupportedMarkdownAsHtml(
  source: string,
  options: RenderMarkdownOptions = {},
): string {
  const normalized = source.replace(/\r/g, '');
  if (!normalized.trim()) {
    return '';
  }

  if (options.blockMode === 'editor' && options.preserveWhitespace) {
    const lines = normalized.split('\n');
    const output: string[] = [];
    for (let index = 0; index < lines.length; index += 1) {
      const fenced = readFencedCodeBlock(lines, index);
      if (fenced) {
        output.push(renderCodeBlockHtml(fenced.content));
        index = fenced.nextIndex - 1;
        continue;
      }
      const line = lines[index] ?? '';
      const heading = HEADING_LINE_PATTERN.exec(line);
      const quote = QUOTE_LINE_PATTERN.exec(line);
      const html = renderInlineTokens(
        parseInlineTokens(heading?.[2] ?? quote?.[1] ?? line, options),
        options,
      );
      output.push(
        heading
          ? renderHeadingHtml(html, heading[1] ?? '#')
          : quote
            ? renderQuoteHtml(html)
            : `<div data-max-preserved-line="true">${html || '<br>'}</div>`,
      );
    }
    return output.join('');
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
        renderedLines.push('');
        continue;
      }

      const headingMatch = HEADING_LINE_PATTERN.exec(trimmedLine);
      if (headingMatch) {
        const content = renderInlineTokens(
          parseInlineTokens(headingMatch[2] ?? '', options),
          options,
        );
        renderedLines.push(renderHeadingHtml(content, headingMatch[1] ?? '#'));
        continue;
      }

      const quoteMatch = QUOTE_LINE_PATTERN.exec(trimmedLine);
      if (quoteMatch) {
        const content = renderInlineTokens(
          parseInlineTokens(quoteMatch[1] ?? '', options),
          options,
        );
        renderedLines.push(renderQuoteHtml(content));
        continue;
      }

      renderedLines.push(renderInlineTokens(parseInlineTokens(rawLine, options), options));
    }

    return renderedLines.join('\n');
  }

  if (options.blockMode === 'inline' || options.blockMode === 'editor') {
    const inlineSafe = options.blockMode === 'inline';
    const lines: string[] = [];
    const rawLines = normalized.split('\n');
    let lastContentLineIndex = rawLines.length - 1;
    while (lastContentLineIndex >= 0 && !rawLines[lastContentLineIndex]?.trim()) {
      lastContentLineIndex -= 1;
    }
    let previousWasGap = false;
    let previousWasBlock = false;

    for (let index = 0; index < rawLines.length; index += 1) {
      const fencedCodeBlock = readFencedCodeBlock(rawLines, index);
      if (fencedCodeBlock) {
        if (lines.length > 0 && !previousWasGap && (inlineSafe || !previousWasBlock)) {
          lines.push('<br>');
        }
        lines.push(
          inlineSafe
            ? renderInlineCodeBlockHtml(fencedCodeBlock.content)
            : renderCodeBlockHtml(fencedCodeBlock.content),
        );
        previousWasGap = false;
        previousWasBlock = !inlineSafe;
        index = fencedCodeBlock.nextIndex - 1;
        continue;
      }

      const rawLine = rawLines[index] ?? '';
      const line = rawLine.trimEnd();
      const trimmedLine = line.trim();

      if (!trimmedLine) {
        if (lines.length > 0 && (!previousWasGap || index < lastContentLineIndex)) {
          lines.push(previousWasGap ? '<br>' : '<br><br>');
          previousWasGap = true;
          previousWasBlock = false;
        }
        continue;
      }

      const headingMatch = HEADING_LINE_PATTERN.exec(trimmedLine);
      const quoteMatch = QUOTE_LINE_PATTERN.exec(trimmedLine);
      const currentIsBlock = !inlineSafe && Boolean(headingMatch || quoteMatch);
      const content = headingMatch
        ? (inlineSafe ? renderInlineHeadingHtml : renderHeadingHtml)(
            renderInlineTokens(parseInlineTokens(headingMatch[2] ?? '', options), options),
            headingMatch[1] ?? '#',
          )
        : quoteMatch
          ? (inlineSafe ? renderInlineQuoteHtml : renderQuoteHtml)(
              renderInlineTokens(parseInlineTokens(quoteMatch[1] ?? '', options), options),
            )
          : renderInlineTokens(parseInlineTokens(line, options), options);

      if (lines.length > 0 && !previousWasGap && (inlineSafe || !previousWasBlock)) {
        lines.push('<br>');
      }
      lines.push(content);
      previousWasGap = false;
      previousWasBlock = currentIsBlock;
    }

    return lines.join('');
  }

  const blocks: string[] = [];
  let paragraphLines: string[] = [];
  const lines = normalized.split('\n');

  const flushParagraph = () => {
    if (paragraphLines.length === 0) {
      return;
    }

    const renderedLines = paragraphLines.map((line) =>
      renderInlineTokens(parseInlineTokens(line, options), options),
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
      const content = renderInlineTokens(
        parseInlineTokens(headingMatch[2] ?? '', options),
        options,
      );
      blocks.push(renderHeadingHtml(content, headingMatch[1] ?? '#'));
      continue;
    }

    const quoteMatch = QUOTE_LINE_PATTERN.exec(trimmedLine);
    if (quoteMatch) {
      flushParagraph();
      const content = renderInlineTokens(parseInlineTokens(quoteMatch[1] ?? '', options), options);
      blocks.push(renderQuoteHtml(content));
      continue;
    }

    paragraphLines.push(line);
  }

  flushParagraph();

  return blocks.join('');
}

export function renderPlainTextAsEditorHtml(source: string): string {
  return source
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/\r?\n/gu, '<br>');
}

function renderHeadingHtml(content: string, marker: string): string {
  const level = Math.min(6, Math.max(1, marker.length));
  return `<h${level}>${content}</h${level}>`;
}

function renderQuoteHtml(content: string): string {
  return `<blockquote>${content}</blockquote>`;
}

function renderInlineHeadingHtml(content: string, marker: string): string {
  const level = Math.min(6, Math.max(1, marker.length));
  return `<strong data-max-block="heading" data-max-heading-level="${level}">${content}</strong>`;
}

function renderInlineQuoteHtml(content: string): string {
  return `<span data-max-block="quote">${content}</span>`;
}

function renderInlineCodeBlockHtml(content: string): string {
  return `<code data-max-block="code">${escapeHtmlPreservingWhitespace(content)}</code>`;
}

function renderCodeBlockHtml(content: string): string {
  return `<pre>${escapeHtmlPreservingWhitespace(content)}</pre>`;
}

function readFencedCodeBlock(
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

function parseInlineTokens(source: string, options: RenderMarkdownOptions = {}): InlineToken[] {
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
    if (options.preserveCurlyBracePlaceholders) {
      const placeholderMatch = CURLY_BRACE_PLACEHOLDER_PATTERN.exec(source.slice(cursor));
      if (placeholderMatch) {
        const raw = placeholderMatch[0];
        flushPlainText();
        tokens.push({
          type: 'placeholder',
          key: raw.slice(1, -1),
          raw,
        });
        cursor += raw.length;
        continue;
      }
    }

    if (
      source[cursor] === '\\' &&
      cursor + 1 < source.length &&
      ESCAPABLE_MARKDOWN_CHARACTERS.has(source[cursor + 1] ?? '')
    ) {
      plainText += source[cursor + 1];
      cursor += 2;
      continue;
    }

    const token = matchToken(source.slice(cursor), options);
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

function matchToken(
  value: string,
  options: RenderMarkdownOptions,
): {
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
        children: parseInlineTokens(linkMatch.label, options),
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
            children: parseInlineTokens(boldItalicMatch.content, options),
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
        children: parseInlineTokens(boldMatch.content, options),
      },
    };
  }

  const underlineMatch = matchDelimitedInlineContent(value, '++');
  if (underlineMatch) {
    return {
      rawLength: underlineMatch.rawLength,
      node: {
        type: 'underline',
        children: parseInlineTokens(underlineMatch.content, options),
      },
    };
  }

  const strikeMatch = matchDelimitedInlineContent(value, '~~');
  if (strikeMatch) {
    return {
      rawLength: strikeMatch.rawLength,
      node: {
        type: 'strike',
        children: parseInlineTokens(strikeMatch.content, options),
      },
    };
  }

  const highlightMatch = matchDelimitedInlineContent(value, '^^');
  if (highlightMatch) {
    return {
      rawLength: highlightMatch.rawLength,
      node: {
        type: 'highlight',
        children: parseInlineTokens(highlightMatch.content, options),
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
        children: parseInlineTokens(content, options),
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

function renderInlineTokensAsPlainText(tokens: InlineToken[]): string {
  return tokens
    .map((token) => {
      switch (token.type) {
        case 'text':
          return token.content;
        case 'placeholder':
          return token.raw;
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

function renderInlineTokens(tokens: InlineToken[], options: RenderMarkdownOptions): string {
  return tokens
    .map((token) => {
      switch (token.type) {
        case 'text':
          return escapeHtmlPreservingWhitespace(token.content);
        case 'placeholder': {
          const label = options.curlyBracePlaceholderLabels?.[token.key];
          return label
            ? `<span class="max-rich-text-editor__placeholder-token" data-max-placeholder="${escapeAttribute(token.key)}" contenteditable="false">${escapeHtml(label)}</span>`
            : escapeHtml(token.raw);
        }
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

  const href = options.resolveLinkHref ? options.resolveLinkHref(token.href) : token.href;
  return href ? `<a href="${escapeAttribute(href)}">${labelHtml}</a>` : labelHtml;
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
