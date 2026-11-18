import { replaceUrlsInText } from '../../common/url-text.util';

export type ProfanitySourceCandidate = {
  value: string;
  joined: boolean;
  rawValue?: string;
  rawIndex?: number;
  rawEnd?: number;
};

export function getProfanityCandidateContext(
  source: string,
  candidate: ProfanitySourceCandidate,
  canonicalToken: string,
  normalize: (text: string) => string,
): string {
  if (candidate.rawIndex === undefined || candidate.rawEnd === undefined) return normalize(source);
  const raw = source.slice(candidate.rawIndex, candidate.rawEnd);
  const leading = raw.match(/^[^\p{L}\p{N}]*/u)?.[0] ?? '';
  const trailing = raw.match(/[^\p{L}\p{N}]*$/u)?.[0] ?? '';
  // FLAG: Address evidence belongs to the original occurrence. Replace only its spelling,
  // retaining sentence boundaries; dots inside a split insult are not sentence boundaries.
  return [
    normalize(source.slice(0, candidate.rawIndex) + leading),
    canonicalToken,
    normalize(trailing + source.slice(candidate.rawEnd)),
  ].join(' ');
}

export function isEmbeddedShortProfanityFragment(
  source: string,
  candidate: ProfanitySourceCandidate,
): boolean {
  if (!candidate.joined || candidate.rawIndex === undefined || candidate.rawEnd === undefined) {
    return false;
  }
  const before = source
    .slice(0, candidate.rawIndex)
    .match(/(?:^|[^\p{L}\p{N}])(\p{L})[\s._*-]+$/u)?.[1];
  const after = source.slice(candidate.rawEnd).match(/^[\s._*-]+(\p{L})(?![\p{L}\p{N}])/u)?.[1];
  // FLAG: Short forms must not match inside «х л е б у» / «т р е б у е т с я».
  // Ordinary one-letter words still delimit «я е б у» and «е б у я».
  return [before, after].some((letter) => letter && !/^[яиавксоуiavksou]$/iu.test(letter));
}

const EMAIL_PATTERN =
  /(?<![\p{L}\p{N}._%+-])[a-z0-9._%+-]{1,64}@(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}(?![\p{L}\p{N}-])/giu;
const LITERAL_LATIN_TERM =
  /^(?:ebit(?:da)?|hues?|huygens)(?:[-_]\d{2,4})?(?:\.(?:csv|xlsx?|pdf|docx?|txt|json))?$/iu;
const MEASUREMENT_LITERAL =
  /^(?:(?:на|по|до|за)\s*)?[+-]?\d{1,6}(?:[.,]\d{1,3})?(?:\s*[-–—]\s*\d{1,6}(?:[.,]\d{1,3})?)?\s*[-–—]?\s*(л(?:итр(?:а|ов)?)?|l(?:it(?:er|re)s?)?|л\.?\s*с\.?|лет(?:н(?:ий|яя|ее|ие|его|ему|ей|их|ими|им|ем|юю))?)$/iu;
const VOLUME_CONTEXT =
  /(?:об[ъь]?ем|емкост|ёмкост|бак|канистр|вод[аыу]|топлив|бензин|дизел|масл|аквариум|рюкзак|кастрюл|ведр|бутыл|бочк|горш(?:ок|к)|кашпо|фляг|краск|молок|литр|volume|tank|water|fuel|capacity|backpack)/iu;
const QUANTITY_VERB_BEFORE =
  /(?:^|[^\p{L}\p{N}])(?:отдам|отдадим|отдаю|отда[её]м|продам|продадим|продаю|прода[её]м|прода[её]тся|продаются|обменяю|меняю|куплю|возьму|заберу|принесу|привезу)[ \t]*(?:\([ \t]*)?$/iu;
const QUANTITY_PREDICATE_AFTER =
  /^[ \t]*\)?[ \t]*(?:хватит|достаточно|мало|много|есть)(?![\p{L}\p{N}])/iu;
const QUANTITY_RECIPIENT_BEFORE = /(?:^|[^\p{L}\p{N}])(?:тебе|вам)[ \t]*$/iu;
const QUANTITY_POSSESSION_BEFORE = /(?:^|[^\p{L}\p{N}])у[ \t]+(?:вас|тебя)[ \t]*$/iu;
const QUANTITY_AVAILABILITY_QUESTION_AFTER = /^[ \t]*есть[ \t]*\?/iu;
const FIRST_PERSON_CLAUSE_AFTER =
  /^[ \t]*\)?[ \t]*(?:[,;.!?:\r\n–—-][ \t\r\n]*)?я(?:[ \t]*,[ \t]*|[ \t]+)(?:[авикосу][ \t]+)*(?![дт]ь|(?:да[ \t]+)?(?:ты|вы)(?![\p{L}\p{N}]))[а-яё]{2,}(?![\p{L}\p{N}])/iu;
const SPLIT_MAT_AFTER_SIX_LITRES =
  /^[\s.,_*–—-]+я[\s.,_*–—-]+[дт][\s._*–—-]*ь(?:ся|сь)?(?![\p{L}\p{N}])/iu;
const SPLIT_MAT_BEFORE_SIX_LITRES = /(?:^|[^\p{L}\p{N}])[её][\s._*–—-]+$/iu;
const SPLIT_MAT_END_AFTER_SIX_LITRES = /^[\s._*–—-]+ан(?![\p{L}\p{N}])/iu;
const AGE_CONTEXT =
  /(?:возраст|дет(?:и|ей|ям|ск)|реб[её]н|ребят|малыш|дошколь|школьни|групп|заняти|студи|круж|секци)/iu;

export function prepareProfanitySource(text: string): string {
  // FLAG: Non-linguistic spans are barriers, not joinable gaps. All candidate offsets refer
  // to this same prepared source; link and stop-word policies still inspect their own input.
  // FLAG: Only the parser may create barriers; user-supplied nulls remain ordinary obfuscation.
  return replaceUrlsInText(text.replace(/\0/gu, ''), '\0').replace(EMAIL_PATTERN, '\0');
}

export function isLiteralLatinProfanityException(candidate: ProfanitySourceCandidate): boolean {
  if (candidate.joined) return false;
  const literal = (candidate.rawValue ?? candidate.value).replace(
    /^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu,
    '',
  );
  return LITERAL_LATIN_TERM.test(literal);
}

export function getMeasurementLiteralContext(
  source: string,
  candidate: ProfanitySourceCandidate,
  canonicalToken: string,
): { text: string; unambiguousUnit: boolean } | null {
  if (candidate.rawIndex === undefined) return null;
  const literal = (candidate.rawValue ?? candidate.value).replace(
    /^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu,
    '',
  );
  const match = MEASUREMENT_LITERAL.exec(literal);
  const unit = match?.[1];
  if (!unit) return null;
  const unambiguousUnit = !/^[лl]$/iu.test(unit);
  const start = candidate.rawIndex;
  const end = candidate.rawEnd ?? start + (candidate.rawValue ?? candidate.value).length;
  const beforeWindow = source.slice(Math.max(0, start - 120), start);
  const afterWindow = source.slice(end, end + 120);
  // FLAG: A one-digit volume look-alike cannot mask a complete split word. These
  // adjacent fragments revoke only the literal exception; the normal detector still scores it.
  if (
    /^6\s*[лl]$/iu.test(literal) &&
    (SPLIT_MAT_AFTER_SIX_LITRES.test(afterWindow) ||
      (SPLIT_MAT_BEFORE_SIX_LITRES.test(beforeWindow) &&
        SPLIT_MAT_END_AFTER_SIX_LITRES.test(afterWindow)))
  ) {
    return null;
  }
  const before = beforeWindow.split(/[,.;!?\r\n\0]/u).at(-1) ?? '';
  const after = afterWindow.split(/[,.;!?\r\n\0]/u)[0] ?? '';
  const standalone = !/[\p{L}\p{N}]/u.test(source.slice(0, start) + source.slice(end));
  const localContext = `${before} ${after}`;
  // FLAG: A period in a directly adjacent age label is an abbreviation, not a sentence
  // boundary. Do not borrow age context across arbitrary completed sentences or URLs.
  const adjacentAgeLabel =
    /(?:^|[^\p{L}\p{N}])(?:гр|возр)\.[ \t]*$/iu.test(beforeWindow) ||
    /^[ \t]*\.?[ \t]*,?[ \t]*(?:гр\.|групп[аы]|дет(?:и|ей)|возраст)(?![\p{L}\p{N}])/iu.test(
      afterWindow,
    );
  // FLAG: Quantity verbs and predicates supply literal context even without an item name.
  // A following first-person clause also keeps its «я» separate from the unit «л».
  // Use bounded adjacency and keep the explicit target check for the matched quantity.
  const firstPersonClause = FIRST_PERSON_CLAUSE_AFTER.test(afterWindow);
  const adjacentQuantityContext =
    QUANTITY_VERB_BEFORE.test(before) ||
    QUANTITY_PREDICATE_AFTER.test(afterWindow) ||
    firstPersonClause;
  if (
    !unambiguousUnit &&
    !standalone &&
    !VOLUME_CONTEXT.test(localContext) &&
    !adjacentQuantityContext &&
    !(unit.toLowerCase() === 'л' && (AGE_CONTEXT.test(localContext) || adjacentAgeLabel))
  ) {
    return null;
  }
  // A pronoun can describe possession or the recipient of a quantity. Remove only
  // that construction from the target check and keep all other address evidence.
  let targetBefore = before;
  if (QUANTITY_AVAILABILITY_QUESTION_AFTER.test(afterWindow)) {
    targetBefore = targetBefore.replace(QUANTITY_POSSESSION_BEFORE, ' ');
  }
  if (firstPersonClause) {
    targetBefore = targetBefore.replace(QUANTITY_RECIPIENT_BEFORE, ' ');
  }
  return { text: `${targetBefore} ${canonicalToken} ${after}`, unambiguousUnit };
}

export function tokenizeProfanityContext(
  text: string,
  directAddressMarkers: ReadonlySet<string>,
): string[] {
  const tokens = text.match(/[\p{L}\p{N}]+(?:-[\p{L}\p{N}]+)*|[.!?;\r\n\0]+/gu) ?? [];
  return tokens.filter((token, index) => {
    if (!/^[.!?;\r\n\0]+$/u.test(token)) return true;
    // A standalone pronoun is not a completed sentence: keep "ty... <insult>" detectable.
    return !directAddressMarkers.has(tokens[index - 1] ?? '') && !/^\.{2,}$/u.test(token);
  });
}

export function excludeProtectedProfanitySpans(
  candidates: ProfanitySourceCandidate[],
  protectedCandidates: ProfanitySourceCandidate[],
): ProfanitySourceCandidate[] {
  const ranges: Array<{ start: number; end: number }> = [];
  const ordered = protectedCandidates
    .filter((candidate) => candidate.rawIndex !== undefined && candidate.rawEnd !== undefined)
    .map((candidate) => ({ start: candidate.rawIndex!, end: candidate.rawEnd! }))
    .sort((left, right) => left.start - right.start);
  for (const range of ordered) {
    const last = ranges.at(-1);
    if (last && range.start <= last.end) last.end = Math.max(last.end, range.end);
    else ranges.push(range);
  }
  if (ranges.length === 0) return candidates;

  // Measurements can repeat throughout a long listing; avoid comparing every candidate pair.
  return candidates.filter((candidate) => {
    if (candidate.rawIndex === undefined || candidate.rawEnd === undefined) return true;
    let left = 0;
    let right = ranges.length;
    while (left < right) {
      const middle = Math.floor((left + right) / 2);
      if (ranges[middle].end <= candidate.rawIndex) left = middle + 1;
      else right = middle;
    }
    return left === ranges.length || ranges[left].start >= candidate.rawEnd;
  });
}
