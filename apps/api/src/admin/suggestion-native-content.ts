import { BadRequestException } from '@nestjs/common';
import { z } from 'zod';
import {
  normalizeMultilineStrongMarkdown,
  parseInlineTokens,
  readFencedCodeBlock,
  type InlineToken,
} from '../common/max-markdown.util';
import {
  MAX_TEXT_MARKUP_TYPES,
  renderMaxTextMarkupAsMarkdown,
  type MaxTextMarkup,
} from '../common/max-text-markup.util';
import { readChannelSuggestionTextMarkup } from './admin-channel-dialog-values';
import { suggestionEditorText } from './suggestion-review-content';

const markupSchema = z.object({
  type: z.enum(MAX_TEXT_MARKUP_TYPES),
  from: z.number().int().nonnegative(),
  length: z.number().int().positive(),
  url: z.string().nullable(),
  userLink: z.string().nullable(),
});
export const nativeContentSchema = z.object({
  text: z.string().max(4000),
  markup: z.array(markupSchema).max(400),
});
export type NativeSuggestionContent = z.infer<typeof nativeContentSchema>;
export type NativeSuggestionDraft = NativeSuggestionContent & { warnings: string[] };

export function readSuggestionNativeContent(
  payload: Record<string, unknown>,
): NativeSuggestionContent {
  suggestionEditorText(payload); // Validate stored ranges and destinations before editing.
  const text = typeof payload.text === 'string' ? payload.text : '';
  const markup = readChannelSuggestionTextMarkup(payload.textMarkup);
  if (markup.length || payload.textFormat !== 'markdown') return { text, markup };
  return readMarkdownNativeContent(text);
}

export function readMarkdownNativeContent(source: string): NativeSuggestionContent {
  let text = '';
  const markup: MaxTextMarkup[] = [];
  const types = {
    bold: 'strong',
    italic: 'emphasized',
    underline: 'underline',
    strike: 'strikethrough',
    highlight: 'highlighted',
    code: 'monospaced',
    link: 'link',
  } as const;
  const append = (tokens: InlineToken[]) => {
    for (const token of tokens) {
      const from = text.length;
      if (token.type === 'text' || token.type === 'code') text += token.content;
      else append(token.children);
      if (token.type !== 'text' && text.length > from) {
        const mention = token.type === 'link' && token.href.startsWith('max://user/');
        markup.push({
          from,
          length: text.length - from,
          type: mention ? 'user_mention' : types[token.type],
          url: token.type === 'link' && !mention ? token.href : null,
          userLink: token.type === 'link' && mention ? token.href : null,
        });
      }
    }
  };
  const lines = normalizeMultilineStrongMarkdown(source).split('\n');
  for (let index = 0; index < lines.length; index++) {
    const code = readFencedCodeBlock(lines, index);
    if (code) {
      if (code.content)
        markup.push({
          type: 'monospaced',
          from: text.length,
          length: code.content.length,
          url: null,
          userLink: null,
        });
      text += code.content;
      index = code.nextIndex - 1;
    } else {
      const line = lines[index]!;
      const block = /^(\s*)(#{1,6}|>)[ \t]+(.*)$/u.exec(line);
      if (block) {
        text += block[1];
        const from = text.length;
        append(parseInlineTokens(block[3]!));
        if (text.length > from)
          markup.push({
            type: block[2] === '>' ? 'quote' : 'heading',
            from,
            length: text.length - from,
            url: null,
            userLink: null,
          });
      } else append(parseInlineTokens(line));
    }
    if (index < lines.length - 1) text += '\n';
  }
  return { text, markup };
}

export function nativeSuggestionMarkdown(content: NativeSuggestionContent): string {
  validateContent(content);
  return (
    renderMaxTextMarkupAsMarkdown(content.text, content.markup) ??
    content.text.replace(/([\\`*_[\]()~+#^>])/gu, '\\$1')
  );
}

function validateContent(content: NativeSuggestionContent) {
  if (!nativeContentSchema.safeParse(content).success)
    throw new BadRequestException('Текст должен быть не длиннее 4000 символов.');
  for (const mark of content.markup) {
    if (mark.from + mark.length > content.text.length)
      throw new BadRequestException('Не удалось прочитать оформление сообщения.');
  }
  suggestionEditorText({ text: content.text, textMarkup: content.markup });
}

type Change = { from: number; to: number; nextFrom: number; nextTo: number };
// FLAG: Bounded UTF-16 diff. Ambiguous link labels never acquire another occurrence's URL.
function textChanges(before: string, after: string): Change[] {
  let prefix = 0;
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix])
    prefix++;
  let suffix = 0;
  while (
    suffix < before.length - prefix &&
    suffix < after.length - prefix &&
    before[before.length - suffix - 1] === after[after.length - suffix - 1]
  )
    suffix++;
  const a = before.slice(prefix, before.length - suffix),
    b = after.slice(prefix, after.length - suffix);
  if (!a && !b) return [];
  // Large rewrites have no reliable style correspondence; the UI asks for an explicit choice.
  if (a.length * b.length > 1_000_000)
    return [
      { from: prefix, to: before.length - suffix, nextFrom: prefix, nextTo: after.length - suffix },
    ];
  const width = b.length + 1;
  const table = new Uint16Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--) {
      table[i * width + j] =
        a[i] === b[j]
          ? 1 + table[(i + 1) * width + j + 1]!
          : Math.max(table[(i + 1) * width + j]!, table[i * width + j + 1]!);
    }
  const changes: Change[] = [];
  let i = 0,
    j = 0,
    current: Change | null = null;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      if (current) {
        changes.push(current);
        current = null;
      }
      i++;
      j++;
    } else {
      current ??= { from: prefix + i, to: prefix + i, nextFrom: prefix + j, nextTo: prefix + j };
      if (
        i < a.length &&
        (j === b.length || table[(i + 1) * width + j]! >= table[i * width + j + 1]!)
      )
        i++;
      else j++;
      current.to = prefix + i;
      current.nextTo = prefix + j;
    }
  }
  if (current) changes.push(current);
  return changes;
}

export function mergeSuggestionNativeContent(
  before: NativeSuggestionContent,
  incoming: NativeSuggestionContent,
): NativeSuggestionDraft {
  validateContent(before);
  validateContent(incoming);
  const changes = textChanges(before.text, incoming.text);
  const result = [...incoming.markup];
  const warnings: string[] = [];
  for (const mark of before.markup) {
    const end = mark.from + mark.length;
    const touching = changes.filter(
      (c) =>
        (c.from < end && c.to > mark.from) ||
        (c.from === c.to && c.from > mark.from && c.from < end),
    );
    const label = before.text.slice(mark.from, end);
    const link = mark.type === 'link' || mark.type === 'user_mention';
    const crossing = touching.some((c) => c.from < mark.from || c.to > end);
    const deleted = touching.some(
      (c) => c.from <= mark.from && c.to >= end && c.nextFrom === c.nextTo,
    );
    if (deleted) continue;
    const offset = changes
      .filter((c) => c.to <= mark.from)
      .reduce((sum, c) => sum + c.nextTo - c.nextFrom - (c.to - c.from), 0);
    const size = touching.reduce(
      (sum, c) => sum + c.nextTo - c.nextFrom - (c.to - c.from),
      mark.length,
    );
    const from = mark.from + offset;
    const explicit = result.some(
      (m) => m.type === mark.type && m.from <= from && m.from + m.length >= from + size,
    );
    if (explicit) continue;
    const repeatedLink =
      changes.length > 0 &&
      link &&
      before.text.indexOf(label) !== before.text.lastIndexOf(label) &&
      (touching.length > 0 ||
        before.text.split(label).length !== incoming.text.split(label).length);
    if (
      crossing ||
      repeatedLink ||
      (link && touching.length > 0) ||
      size <= 0 ||
      from < 0 ||
      from + size > incoming.text.length
    ) {
      warnings.push(`${link ? 'Ссылка' : 'Оформление'}: «${label.slice(0, 60)}»`);
      continue;
    }
    result.push({ ...mark, from, length: size });
  }
  return { text: incoming.text, markup: result, warnings: [...new Set(warnings)] };
}
