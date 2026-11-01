import {
  normalizeStopWordsDomain,
  normalizeStopWordsValue,
  type StopWordsPolicy,
  type StopWordsPreview,
  type StopWordsRule,
} from './stop-words.js';
import { extractUrlsFromText, getUrlTextRanges } from './url-text.js';

type Match = StopWordsPreview['matches'][number];
type TextView = { text: string; starts: number[]; ends: number[] };
type CompiledRule = {
  rule: StopWordsRule;
  normalizedValue: string;
  prefilter: string;
  pattern: RegExp | null;
};
const graphemes = new Intl.Segmenter('ru', { granularity: 'grapheme' });
const VISUAL_EQUIVALENTS: Readonly<Record<string, string>> = {
  а: 'a',
  е: 'e',
  о: 'o',
  р: 'p',
  с: 'c',
  у: 'y',
  х: 'x',
  к: 'k',
  м: 'm',
  т: 't',
};
const visualGroups = Object.entries(VISUAL_EQUIVALENTS).flatMap(([left, right]) => [
  [left, left + right],
  [right, left + right],
]);
const visualMap = new Map(visualGroups as [string, string][]);
const WORD_BOUNDARY = String.raw`[\p{L}\p{N}\p{M}\p{Cf}\p{Pc}]`;
const WORD_CONNECTOR = "['’-]";
const INVISIBLE_CHARACTER = /[\p{Cf}\p{Default_Ignorable_Code_Point}]/u;
// FLAG: Quotes delimit words; apostrophes and hyphens join only adjacent word parts.
const LEFT_WORD_BOUNDARY = new RegExp(
  `(?:${WORD_BOUNDARY}|${WORD_BOUNDARY}${WORD_CONNECTOR})$`,
  'u',
);
const RIGHT_WORD_BOUNDARY = new RegExp(
  `^(?:${WORD_BOUNDARY}|${WORD_CONNECTOR}${WORD_BOUNDARY})`,
  'u',
);
const WORD_TOKENS = new RegExp(`${WORD_BOUNDARY}+(?:${WORD_CONNECTOR}${WORD_BOUNDARY}+)*`, 'gu');

function escapePattern(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function foldFinalSigma(value: string): string {
  // FLAG: Fold only for matching; changing stored rule identity could invalidate existing lists.
  return value.replace(/ς/gu, 'σ');
}

function tokenPattern(token: string, masked: boolean): string {
  if (!masked) return escapePattern(token);
  const characters = [...token].map((char) =>
    visualMap.has(char) ? `[${visualMap.get(char)}]` : escapePattern(char),
  );
  const invisible = characters.join(String.raw`\p{Cf}{0,4}`);
  // FLAG: Visible separators are allowed only between every individual letter. Never join
  // ordinary words or sentence fragments to synthesize a configured word.
  const spelled =
    characters.length >= 4 && /^[\p{L}\p{N}]+$/u.test(token)
      ? characters.join(String.raw`[\p{Zs}\t._*\-]{1,3}`)
      : null;
  return spelled ? `(?:${invisible}|${spelled})` : invisible;
}

function compileRule(rule: StopWordsRule): CompiledRule {
  const normalizedValue = foldFinalSigma(normalizeStopWordsValue(rule.value));
  return {
    rule,
    normalizedValue,
    prefilter: rule.matchMode === 'MASKED' ? compactMaskedText(normalizedValue) : normalizedValue,
    pattern: null,
  };
}

function buildRulePattern(rule: StopWordsRule, normalizedValue: string): RegExp {
  const pattern = normalizedValue
    .split(' ')
    .map((token) => tokenPattern(token, rule.matchMode === 'MASKED'))
    .join(String.raw`[\p{Zs}\t\r\n\v\u2028]+`);
  return new RegExp(
    `(?<!${WORD_BOUNDARY})(?<!${WORD_BOUNDARY}${WORD_CONNECTOR})${pattern}(?!${WORD_BOUNDARY})(?!${WORD_CONNECTOR}${WORD_BOUNDARY})`,
    'gu',
  );
}

function compactMaskedText(text: string): string {
  return [...text]
    .map((char) => visualMap.get(char)?.[0] ?? char)
    .join('')
    .replace(/[\p{Cf}\p{Zs}\t\r\n\v\u2028._*-]+/gu, '');
}

function removeInvisibleCharacters(view: TextView): TextView {
  const result: TextView = { text: '', starts: [], ends: [] };
  for (let index = 0; index < view.text.length; ) {
    const char = String.fromCodePoint(view.text.codePointAt(index)!);
    if (!INVISIBLE_CHARACTER.test(char)) {
      result.text += char;
      for (let offset = 0; offset < char.length; offset += 1) {
        result.starts.push(view.starts[index + offset]);
        result.ends.push(view.ends[index + offset]);
      }
    }
    index += char.length;
  }
  return result;
}

function collapseWhitespace(view: TextView): TextView {
  const result: TextView = { text: '', starts: [], ends: [] };
  for (const match of view.text.matchAll(
    /[\p{Zs}\t\r\n\v\f\u2028\u2029]+|[^\p{Zs}\t\r\n\v\f\u2028\u2029]/gu,
  )) {
    const whitespace = /^[\p{Zs}\t\r\n\v\f\u2028\u2029]/u.test(match[0]);
    const value = whitespace ? (hasParagraphBoundary(match[0]) ? '\0' : ' ') : match[0];
    result.text += value;
    for (let index = 0; index < value.length; index += 1) {
      result.starts.push(view.starts[match.index + (whitespace ? 0 : index)]);
      result.ends.push(view.ends[match.index + (whitespace ? match[0].length - 1 : index)]);
    }
  }
  return result;
}

function hasParagraphBoundary(value: string): boolean {
  // FLAG: A line separator may continue a phrase; paragraphs, pages and empty lines never do.
  return (
    /[\f\u2029]/u.test(value) || /\n[\p{Zs}\t]*\n/u.test(value.replace(/\r\n|\r|\v|\u2028/gu, '\n'))
  );
}

function hasSourceBoundary(text: string, start: number, end: number, masked = false): boolean {
  const before = masked
    ? text.slice(0, start).replace(/[\p{Cf}\p{Default_Ignorable_Code_Point}]/gu, '')
    : text.slice(Math.max(0, start - 3), start);
  const after = masked
    ? text.slice(end).replace(/[\p{Cf}\p{Default_Ignorable_Code_Point}]/gu, '')
    : text.slice(end, end + 3);
  return !LEFT_WORD_BOUNDARY.test(before.slice(-3)) && !RIGHT_WORD_BOUNDARY.test(after.slice(0, 3));
}

function findLiteral(
  view: TextView,
  value: string,
  source: string,
): { start: number; end: number } | null {
  let index = view.text.indexOf(value);
  while (index !== -1) {
    const end = index + value.length;
    if (
      !LEFT_WORD_BOUNDARY.test(view.text.slice(Math.max(0, index - 3), index)) &&
      !RIGHT_WORD_BOUNDARY.test(view.text.slice(end, end + 3)) &&
      hasSourceBoundary(source, view.starts[index], view.ends[end - 1])
    ) {
      return { start: view.starts[index], end: view.ends[end - 1] };
    }
    index = view.text.indexOf(value, index + 1);
  }
  return null;
}

function normalizeText(text: string): TextView {
  const view: TextView = { text: '', starts: [], ends: [] };
  const ranges = getUrlTextRanges(text);
  let rangeIndex = 0;
  for (const segment of graphemes.segment(text)) {
    while (ranges[rangeIndex] && ranges[rangeIndex].end <= segment.index) rangeIndex += 1;
    const range = ranges[rangeIndex];
    const excluded = range && segment.index >= range.start && segment.index < range.end;
    const normalized = excluded
      ? '\0'
      : foldFinalSigma(segment.segment.normalize('NFKC').toLowerCase().replace(/ё/gu, 'е'));
    view.text += normalized;
    for (let index = 0; index < normalized.length; index += 1) {
      view.starts.push(segment.index);
      view.ends.push(segment.index + segment.segment.length);
    }
  }
  return view;
}

export class StopWordsMatcher {
  private readonly cache = new Map<string, CompiledRule[]>();

  detect(params: {
    text: string;
    policy: StopWordsPolicy;
    textSegments?: readonly string[];
    navigationTargets?: readonly { kind: string; target: string; enforceable: boolean }[];
    isLinkAllowlisted?: (link: string) => boolean;
    limit?: number;
  }): Match[] {
    if (!params.policy.enabled) return [];
    const limit = Math.min(1_299, Math.max(1, params.limit ?? 100));
    const matches: Match[] = [];
    const seen = new Set<string>();
    const compiled = this.compile(params.policy.rules);
    for (const text of params.textSegments ?? [params.text]) {
      if (!text || compiled.length === 0) continue;
      const view = normalizeText(text);
      const exactView = collapseWhitespace(view);
      const exactTokens = new Set(exactView.text.match(WORD_TOKENS) ?? []);
      const maskedView = compiled.some((entry) => entry.rule.matchMode === 'MASKED')
        ? removeInvisibleCharacters(view)
        : null;
      const maskedPrefilter = maskedView ? compactMaskedText(maskedView.text) : '';
      for (const entry of compiled) {
        const { rule, normalizedValue } = entry;
        if (seen.has(rule.id)) continue;
        if (rule.matchMode === 'EXACT') {
          if (!normalizedValue.split(' ').every((token) => exactTokens.has(token))) continue;
          const match = findLiteral(exactView, normalizedValue, text);
          if (match) {
            matches.push({
              ruleId: rule.id,
              value: rule.value,
              kind: rule.kind,
              matchKind: 'exact',
              fragment: text.slice(match.start, match.end),
              ...match,
            });
            seen.add(rule.id);
          }
          if (matches.length >= limit) return matches;
          continue;
        }
        if (!maskedPrefilter.includes(entry.prefilter)) continue;
        // Compile only candidates which survived the literal prefilter, including cold lists.
        const pattern = (entry.pattern ??= buildRulePattern(rule, normalizedValue));
        const matchingView = rule.matchMode === 'MASKED' ? maskedView! : view;
        pattern.lastIndex = 0;
        for (const match of matchingView.text.matchAll(pattern)) {
          if (hasParagraphBoundary(match[0])) continue;
          const start = matchingView.starts[match.index] ?? 0;
          const end = matchingView.ends[match.index + match[0].length - 1] ?? start;
          if (!hasSourceBoundary(text, start, end, true)) continue;
          const exact =
            foldFinalSigma(normalizeStopWordsValue(text.slice(start, end))) === normalizedValue &&
            hasSourceBoundary(text, start, end);
          matches.push({
            ruleId: rule.id,
            value: rule.value,
            kind: rule.kind,
            matchKind: exact ? 'exact' : 'masked',
            fragment: text.slice(start, end),
            start,
            end,
          });
          seen.add(rule.id);
          break;
        }
        if (matches.length >= limit) return matches;
      }
    }
    const links = new Set([
      ...extractUrlsFromText(params.text),
      ...(params.navigationTargets ?? [])
        .filter((target) => target.enforceable && target.kind !== 'profile_mention')
        .map((target) => target.target),
    ]);
    for (const link of links) {
      const host = normalizeStopWordsDomain(link);
      if (!host || params.isLinkAllowlisted?.(link)) continue;
      for (const domain of params.policy.domains) {
        const ruleId = `domain:${domain}`;
        if (seen.has(ruleId) || (host !== domain && !host.endsWith(`.${domain}`))) continue;
        const start = Math.max(0, params.text.indexOf(link));
        matches.push({
          ruleId,
          value: domain,
          kind: 'DOMAIN',
          matchKind: 'domain',
          fragment: link,
          start,
          end: start + link.length,
        });
        seen.add(ruleId);
        if (matches.length >= limit) return matches;
      }
    }
    return matches;
  }

  private compile(rules: readonly StopWordsRule[]): CompiledRule[] {
    const key = JSON.stringify(rules);
    const cached = this.cache.get(key);
    if (cached) return cached;
    const compiled = rules.filter((rule) => rule.enabled).map(compileRule);
    this.cache.set(key, compiled);
    if (this.cache.size > 64) this.cache.delete(this.cache.keys().next().value!);
    return compiled;
  }
}
