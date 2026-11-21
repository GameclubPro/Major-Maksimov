import {
  COMMERCIAL_OCR_CACHE_SCHEMA_VERSION,
  type CommercialOcrCachedWord,
  type CommercialOcrCacheValue,
  validateCommercialOcrCacheValue,
} from './commercial-ocr-cache.store';
import type { CommercialOcrPass } from './commercial-ocr-decision-policy';
import { deriveCommercialOcrCriticalEvidence } from './commercial-ocr-evidence';

export type CommercialOcrNativePayload = Readonly<{
  status?: unknown;
  text: unknown;
  aggregateConfidence: unknown;
  words: unknown;
  truncated: unknown;
}>;

export type CommercialOcrNativeConversionResult =
  | Readonly<{
      kind: 'ready';
      value: CommercialOcrCacheValue;
      pass: CommercialOcrPass;
    }>
  | Readonly<{
      kind: 'rejected';
      reason: 'truncated' | 'invalid';
    }>;

/** Converts untrusted native output into the exact bounded representation used by runtime policy. */
export function convertCommercialOcrNativePayload(
  payload: CommercialOcrNativePayload,
  rasterSize?: CommercialOcrCacheValue['rasterSize'],
): CommercialOcrNativeConversionResult {
  if (payload.truncated === true) {
    return { kind: 'rejected', reason: 'truncated' };
  }
  if (
    payload.truncated !== false ||
    typeof payload.text !== 'string' ||
    !Array.isArray(payload.words)
  ) {
    return { kind: 'rejected', reason: 'invalid' };
  }

  const status = payload.text.length > 0 ? 'recognized' : 'no_text';
  if (payload.status !== undefined && payload.status !== status) {
    return { kind: 'rejected', reason: 'invalid' };
  }

  let value: CommercialOcrCacheValue;
  if (status === 'no_text') {
    if (payload.aggregateConfidence !== null || payload.words.length !== 0) {
      return { kind: 'rejected', reason: 'invalid' };
    }
    value = {
      schemaVersion: COMMERCIAL_OCR_CACHE_SCHEMA_VERSION,
      status,
      text: '',
      confidencePermille: 0,
      words: [],
    };
  } else {
    if (!isNativeConfidence(payload.aggregateConfidence)) {
      return { kind: 'rejected', reason: 'invalid' };
    }
    const words: CommercialOcrCachedWord[] = [];
    for (const candidate of payload.words) {
      const word = convertNativeWord(candidate, rasterSize);
      if (!word) {
        return { kind: 'rejected', reason: 'invalid' };
      }
      words.push(word);
    }
    value = {
      schemaVersion: COMMERCIAL_OCR_CACHE_SCHEMA_VERSION,
      status,
      text: payload.text,
      confidencePermille: toPermille(payload.aggregateConfidence),
      words,
      ...(rasterSize ? { rasterSize } : {}),
    };
  }

  try {
    const validated = validateCommercialOcrCacheValue(value);
    return {
      kind: 'ready',
      value: validated,
      pass: commercialOcrCacheValueToDecisionPass(validated),
    };
  } catch {
    return { kind: 'rejected', reason: 'invalid' };
  }
}

export function commercialOcrCacheValueToDecisionPass(
  value: CommercialOcrCacheValue,
): CommercialOcrPass {
  return {
    status: value.status,
    text: value.text,
    confidencePermille: value.confidencePermille,
    words: value.words,
    ...(value.rasterSize ? { rasterSize: value.rasterSize } : {}),
    criticalEvidence:
      value.status === 'recognized'
        ? deriveCommercialOcrCriticalEvidence({ text: value.text, words: value.words })
        : [],
  };
}

function convertNativeWord(
  value: unknown,
  rasterSize: CommercialOcrCacheValue['rasterSize'],
): CommercialOcrCachedWord | null {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.text !== 'string' ||
    typeof candidate.start !== 'number' ||
    typeof candidate.end !== 'number' ||
    !isNativeConfidence(candidate.confidence)
  ) {
    return null;
  }
  return {
    text: candidate.text,
    start: candidate.start,
    end: candidate.end,
    confidencePermille: toPermille(candidate.confidence),
    ...(rasterSize && candidate.boundingBox && typeof candidate.boundingBox === 'object'
      ? {
          boundingBox: candidate.boundingBox as NonNullable<CommercialOcrCachedWord['boundingBox']>,
        }
      : {}),
  };
}

function toPermille(confidence: number): number {
  return Math.max(0, Math.min(1_000, Math.round(confidence * 10)));
}

function isNativeConfidence(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100;
}
