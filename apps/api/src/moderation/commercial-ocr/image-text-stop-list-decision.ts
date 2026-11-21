import type { ChatSettings } from '../../prisma/prisma-client';
import { StopWordsMatcher } from '../stop-words/stop-words.matcher';
import { readStopWordsPolicy } from '../stop-words/stop-words.policy';
import { MessageLimitsBlockedDomainDetector } from '../rule-engine-blocked-domains.detector';
import { MessageLimitsBlockedWordDetector } from '../rule-engine-blocked-words.detector';
import type { CommercialOcrPass } from './commercial-ocr-decision-policy';
import { readCommercialOcrCrop } from './commercial-ocr-preprocess-config';
import type { CommercialOcrBoundingBox } from './native-tesseract-ocr.types';

export const IMAGE_TEXT_STOP_LIST_MIN_CONFIDENCE_PERMILLE = 900;
export const IMAGE_TEXT_STOP_LIST_LEGACY_POLICY_VERSION = 'image-text-stop-list-v1';
export const IMAGE_TEXT_STOP_LIST_POLICY_VERSION = 'image-text-stop-list-v2';

export type ImageTextStopListSettings = Pick<
  ChatSettings,
  'messageLimitsBlockedWords' | 'messageLimitsBlockedDomains'
> & { stopWordsPolicy?: unknown };

export type ImageTextStopListPasses = Readonly<{
  imageIndex: number;
  primary: CommercialOcrPass;
  confirmation?: CommercialOcrPass | null;
}>;

export type ImageTextStopListDecision =
  | Readonly<{ kind: 'no_action' }>
  | Readonly<{
      kind: 'match';
      ruleCode: 'MESSAGE_BLOCKED_WORD' | 'MESSAGE_BLOCKED_DOMAIN';
      value: string;
      ruleId?: string;
      imageIndex: number;
      policyVersion?: typeof IMAGE_TEXT_STOP_LIST_POLICY_VERSION;
      primaryConfidencePermille: number;
      confirmationConfidencePermille: number;
    }>;

type ImageTextStopListPassMatch = Pick<
  Extract<ImageTextStopListDecision, { kind: 'match' }>,
  'ruleCode' | 'value' | 'ruleId'
>;
type ConfidentImageTextStopListPassMatch = ImageTextStopListPassMatch & {
  confidencePermille: number;
  exactSpan?: { start: number; end: number };
};

const blockedWordDetector = new MessageLimitsBlockedWordDetector();
const stopWordsMatcher = new StopWordsMatcher();
const blockedDomainDetector = new MessageLimitsBlockedDomainDetector();

/**
 * Requires two independent OCR passes to agree on the same configured stop-list value.
 * Recognized source text deliberately never leaves this decision boundary.
 */
export function evaluateImageTextStopListDecision(params: {
  settings: ImageTextStopListSettings;
  images: readonly ImageTextStopListPasses[];
  isLinkAllowlisted?: (link: string) => boolean;
  exactWordsOnly?: boolean;
  exactRuleId?: string;
}): ImageTextStopListDecision {
  for (const image of params.images) {
    const confirmation = image.confirmation;
    if (!confirmation) {
      continue;
    }

    const primaryMatches = resolveEligiblePassMatches(
      image.primary,
      params.settings,
      params.isLinkAllowlisted,
      params.exactWordsOnly,
    );
    if (primaryMatches.length === 0) {
      continue;
    }

    const confirmationMatches = resolveEligiblePassMatches(
      confirmation,
      params.settings,
      params.isLinkAllowlisted,
      params.exactWordsOnly,
    );
    const confirmationByKey = new Map(
      confirmationMatches
        .filter((match) => !params.exactRuleId || match.ruleId === params.exactRuleId)
        .map((match) => [matchKey(match), match]),
    );
    const agreedMatch = primaryMatches.find((match) => confirmationByKey.has(matchKey(match)));
    const confirmed = agreedMatch && confirmationByKey.get(matchKey(agreedMatch));
    if (!agreedMatch || !confirmed) continue;

    return {
      kind: 'match',
      ruleCode: agreedMatch.ruleCode,
      value: agreedMatch.value,
      ...(agreedMatch.ruleId ? { ruleId: agreedMatch.ruleId } : {}),
      imageIndex: image.imageIndex,
      ...(agreedMatch.exactSpan ? { policyVersion: IMAGE_TEXT_STOP_LIST_POLICY_VERSION } : {}),
      primaryConfidencePermille: agreedMatch.confidencePermille,
      confirmationConfidencePermille: confirmed.confidencePermille,
    };
  }

  return { kind: 'no_action' };
}

export function shouldConfirmImageTextStopListPass(
  pass: CommercialOcrPass,
  settings: ImageTextStopListSettings,
  isLinkAllowlisted?: (link: string) => boolean,
  exactWordsOnly?: boolean,
): boolean {
  return resolveEligiblePassMatches(pass, settings, isLinkAllowlisted, exactWordsOnly).length > 0;
}

export function resolveImageTextStopListConfirmationCrop(
  pass: CommercialOcrPass,
  settings: ImageTextStopListSettings,
): { crop: CommercialOcrBoundingBox; ruleId: string } | null {
  const { words, rasterSize } = pass;
  if (!words || !rasterSize) return null;
  for (const { exactSpan, ruleId } of resolveEligiblePassMatches(pass, settings, undefined, true)) {
    if (
      !exactSpan ||
      !ruleId ||
      /[\r\n\v\f\u2028\u2029]/u.test(pass.text.slice(exactSpan.start, exactSpan.end))
    )
      continue;
    const lineStart = pass.text.lastIndexOf('\n', exactSpan.start - 1) + 1;
    const lineBreak = pass.text.indexOf('\n', exactSpan.end);
    const lineEnd = lineBreak < 0 ? pass.text.length : lineBreak;
    // FLAG: Include every word on the source OCR line. Clipping another word
    // could give a compound or a link an artificial boundary during confirmation.
    const lineWords = words.filter((word) => word.start >= lineStart && word.end <= lineEnd);
    const boxes = lineWords.map((word) => word.boundingBox);
    if (boxes.length === 0 || !boxes.every((box) => box !== undefined)) continue;

    const leftEdge = Math.min(...boxes.map((box) => box.left));
    const topEdge = Math.min(...boxes.map((box) => box.top));
    const rightEdge = Math.max(...boxes.map((box) => box.left + box.width));
    const bottomEdge = Math.max(...boxes.map((box) => box.top + box.height));
    const padding = Math.min(48, Math.max(12, Math.ceil((bottomEdge - topEdge) * 0.2)));
    const left = Math.max(0, leftEdge - padding);
    const right = Math.min(rasterSize.width, rightEdge + padding);
    const top = Math.max(0, topEdge - padding);
    const bottom = Math.min(rasterSize.height, bottomEdge + padding);
    const crop = readCommercialOcrCrop({ left, top, width: right - left, height: bottom - top });
    if (crop) return { crop, ruleId };
  }
  return null;
}

function isEligiblePass(pass: CommercialOcrPass): boolean {
  return (
    pass.status === 'recognized' &&
    pass.text.trim().length > 0 &&
    Number.isSafeInteger(pass.confidencePermille) &&
    pass.confidencePermille >= 0 &&
    pass.confidencePermille <= 1_000
  );
}

function resolveEligiblePassMatches(
  pass: CommercialOcrPass,
  settings: ImageTextStopListSettings,
  isLinkAllowlisted?: (link: string) => boolean,
  exactWordsOnly = false,
): ConfidentImageTextStopListPassMatch[] {
  if (!isEligiblePass(pass)) return [];
  const words = pass.words;
  if (!Array.isArray(words)) return [];
  const confidenceByOffset = validateWordSpans(pass.text, words);
  if (!confidenceByOffset) return [];

  const policy = readStopWordsPolicy(settings);
  const exactRules = policy?.rules.filter((rule) => rule.enabled && rule.matchMode === 'EXACT');
  const exactMatches: ConfidentImageTextStopListPassMatch[] = [];
  if (policy && exactRules?.length) {
    // FLAG: Match on unmodified text so low-confidence neighbors cannot create a word
    // boundary or turn part of a URL into a word. Both passes must trust the entire match.
    const confidence = (start: number, end: number): number =>
      readMatchConfidence(pass.text, confidenceByOffset, start, end);
    for (const match of stopWordsMatcher.detect({
      text: pass.text,
      policy: { ...policy, rules: exactRules, domains: [] },
      acceptExactMatch: ({ start, end }) =>
        confidence(start, end) >= IMAGE_TEXT_STOP_LIST_MIN_CONFIDENCE_PERMILLE,
      limit: 1_299,
    })) {
      exactMatches.push({
        ruleCode: 'MESSAGE_BLOCKED_WORD',
        value: match.value,
        ruleId: match.ruleId,
        confidencePermille: confidence(match.start, match.end),
        exactSpan: { start: match.start, end: match.end },
      });
    }
  }

  if (exactWordsOnly || pass.confidencePermille < IMAGE_TEXT_STOP_LIST_MIN_CONFIDENCE_PERMILLE) {
    return exactMatches;
  }
  const legacyOrMaskedMatches = buildHighConfidenceTextSegments(pass.text, words)
    .flatMap((text) => detectPassMatches(text, settings, policy, isLinkAllowlisted))
    .map((match) => ({ ...match, confidencePermille: pass.confidencePermille }));
  return [
    ...exactMatches,
    ...new Map(legacyOrMaskedMatches.map((match) => [matchKey(match), match])).values(),
  ];
}

function readMatchConfidence(
  text: string,
  confidenceByOffset: Uint16Array,
  start: number,
  end: number,
): number {
  let confidence = 1_000;
  for (let offset = start; offset < end; offset += 1) {
    if (/\s/u.test(text[offset])) continue;
    confidence = Math.min(confidence, confidenceByOffset[offset] - 1);
  }
  return confidence;
}

function validateWordSpans(
  text: string,
  words: NonNullable<CommercialOcrPass['words']>,
): Uint16Array | null {
  if (words.length === 0 || words.length > 1_024) return null;
  const confidenceByOffset = new Uint16Array(text.length);
  let previousEnd = 0;
  for (const word of words) {
    if (
      !word ||
      typeof word.text !== 'string' ||
      word.text.length === 0 ||
      word.text.length > 256 ||
      !Number.isSafeInteger(word.start) ||
      !Number.isSafeInteger(word.end) ||
      word.start < previousEnd ||
      word.end <= word.start ||
      word.end > text.length ||
      text.slice(word.start, word.end) !== word.text ||
      !Number.isSafeInteger(word.confidencePermille) ||
      word.confidencePermille < 0 ||
      word.confidencePermille > 1_000
    ) {
      return null;
    }
    confidenceByOffset.fill(word.confidencePermille + 1, word.start, word.end);
    previousEnd = word.end;
  }
  // Tesseract offsets use UTF-16 units. Every alphanumeric token must be backed by a word span.
  for (const match of text.matchAll(/[\p{L}\p{N}]+/gu)) {
    const start = match.index ?? 0;
    const end = start + match[0].length;
    for (let index = start; index < end; index += 1) {
      if (confidenceByOffset[index] === 0) return null;
    }
  }
  return confidenceByOffset;
}

function buildHighConfidenceTextSegments(
  text: string,
  words: NonNullable<CommercialOcrPass['words']>,
): string[] {
  const segments: string[] = [];
  let segmentStart = 0;
  for (const word of words) {
    if (word.confidencePermille >= IMAGE_TEXT_STOP_LIST_MIN_CONFIDENCE_PERMILLE) continue;
    const segment = text.slice(segmentStart, word.start).trim();
    if (segment) segments.push(segment);
    segmentStart = word.end;
  }
  const finalSegment = text.slice(segmentStart).trim();
  if (finalSegment) segments.push(finalSegment);
  return segments;
}

function detectPassMatches(
  text: string,
  settings: ImageTextStopListSettings,
  policy: ReturnType<typeof readStopWordsPolicy>,
  isLinkAllowlisted?: (link: string) => boolean,
): ImageTextStopListPassMatch[] {
  if (policy)
    return stopWordsMatcher
      .detect({
        text,
        policy: { ...policy, rules: policy.rules.filter((rule) => rule.matchMode === 'MASKED') },
        isLinkAllowlisted,
        limit: 1_299,
      })
      .map((match) => ({
        ruleCode: match.kind === 'DOMAIN' ? 'MESSAGE_BLOCKED_DOMAIN' : 'MESSAGE_BLOCKED_WORD',
        value: match.value,
        ruleId: match.ruleId,
      }));
  return [
    ...blockedWordDetector.detectAll(text, settings.messageLimitsBlockedWords).map((match) => ({
      ruleCode: 'MESSAGE_BLOCKED_WORD' as const,
      value: match.blockedWord,
    })),
    ...blockedDomainDetector
      .detectAll(
        text,
        settings.messageLimitsBlockedDomains,
        isLinkAllowlisted ? { isLinkAllowlisted } : {},
      )
      .map((match) => ({
        ruleCode: 'MESSAGE_BLOCKED_DOMAIN' as const,
        value: match.blockedDomain,
      })),
  ];
}

function matchKey(match: ImageTextStopListPassMatch): string {
  return `${match.ruleCode}\0${match.ruleId ?? ''}\0${match.value}`;
}
