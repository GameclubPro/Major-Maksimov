import type { CommercialOcrBoundingBox } from './native-tesseract-ocr.types';
import type { ChatSettings } from '../../prisma/prisma-client';
import {
  CommercialAdDetector,
  type CommercialDetection,
} from '../commercial/commercial-ad.detector';
import { collectCommercialSignals } from '../commercial/commercial-features';
import {
  normalizeCommercialRawText,
  normalizeCommercialText,
} from '../commercial/commercial-normalization';
import {
  deriveCommercialSafeContextBucket,
  type CommercialSafeContextBucket,
} from '../commercial/commercial-safe-context';
import { resolveCommercialThresholds } from '../rule-engine-commercial-thresholds';
import {
  classifyCommercialOcrLetterScript,
  type CommercialOcrLetterScript,
} from './commercial-ocr-letter-script';

export const COMMERCIAL_OCR_DECISION_POLICY_VERSION = 'commercial-ocr-delete-policy-v2';

export const COMMERCIAL_OCR_DELETE_GATE = {
  minDetectorScore: 90,
  minActionScore: 90,
  maxPolicyFpRisk: 20,
  minTextLength: 20,
  minWordCount: 4,
  minAggregateConfidencePermille: 900,
  minCriticalConfidencePermille: 850,
} as const;

export const COMMERCIAL_OCR_MIN_CYRILLIC_ENFORCEMENT_LETTERS_PER_PASS = 4;

export type CommercialOcrCriticalEvidenceKind =
  | 'commercial_anchor'
  | 'contact'
  | 'deal_channel'
  | 'price'
  | 'transaction';

export type CommercialOcrCriticalEvidence = {
  kind: CommercialOcrCriticalEvidenceKind;
  semanticKey: string;
  confidencePermille: number;
};

export type CommercialOcrPass = {
  status: 'recognized' | 'no_text' | 'failed';
  text: string;
  confidencePermille: number;
  words?: readonly CommercialOcrPassWord[];
  rasterSize?: { width: number; height: number };
  criticalEvidence?: readonly CommercialOcrCriticalEvidence[];
};

export type CommercialOcrPassWord = Readonly<{
  text: string;
  start: number;
  end: number;
  confidencePermille: number;
  boundingBox?: CommercialOcrBoundingBox;
}>;

export type CommercialOcrImageDecisionInput = {
  imageIndex: number;
  source: 'direct' | 'forward';
  primary: CommercialOcrPass;
  verification?: CommercialOcrPass | null;
};

export type CommercialOcrDetector = Pick<CommercialAdDetector, 'detect'>;

export type CommercialOcrPassRejectionReason =
  | 'ocr-pass-not-recognized'
  | 'ocr-text-too-short'
  | 'ocr-word-count-too-low'
  | 'ocr-confidence-too-low'
  | 'ocr-critical-evidence-missing'
  | 'ocr-critical-confidence-too-low'
  | 'detector-no-hit'
  | 'detector-action-not-delete'
  | 'detector-score-too-low'
  | 'detector-action-score-too-low'
  | 'detector-evidence-not-direct'
  | 'detector-fp-risk-too-high'
  | 'detector-review-required'
  | 'detector-delete-suppressed'
  | 'detector-safe-context'
  | 'detector-subtype-excluded'
  | 'detector-not-actionable'
  | 'detector-missing-anchor';

export type CommercialOcrPassAnalysis = {
  detection: CommercialDetection | null;
  deleteEligible: boolean;
  rejectionReasons: CommercialOcrPassRejectionReason[];
  criticalSignature: string[];
  letterScript: CommercialOcrLetterScript;
  cyrillicLetterCount: number;
  latinLetterCount: number;
};

export type CommercialOcrImageRejectionReason =
  | 'primary-pass-not-delete-eligible'
  | 'verification-pass-missing'
  | 'verification-pass-not-delete-eligible'
  | 'detector-subtype-disagreement'
  | 'critical-evidence-disagreement';

export type CommercialOcrImageAnalysis = {
  imageIndex: number;
  source: 'direct' | 'forward';
  primary: CommercialOcrPassAnalysis;
  verification: CommercialOcrPassAnalysis | null;
  deleteEligible: boolean;
  rejectionReasons: CommercialOcrImageRejectionReason[];
};

export type CommercialOcrCaptionAnalysis = {
  detection: CommercialDetection | null;
  safeContextBucket: CommercialSafeContextBucket;
  deleteEligible: boolean;
  rejectionReasons: CommercialOcrPassRejectionReason[];
};

export type CommercialOcrDecision = {
  policyVersion: typeof COMMERCIAL_OCR_DECISION_POLICY_VERSION;
  action: 'DELETE' | 'NO_ACTION';
  deleteSource: { kind: 'image'; imageIndex: number; source: 'direct' | 'forward' } | null;
  caption: CommercialOcrCaptionAnalysis;
  images: CommercialOcrImageAnalysis[];
  reasonCodes: string[];
};

export function evaluateCommercialOcrDecision(params: {
  caption: string;
  expectedImageCount: number;
  images: readonly CommercialOcrImageDecisionInput[];
  settings: ChatSettings;
  detector?: CommercialOcrDetector;
}): CommercialOcrDecision {
  const detector = params.detector ?? new CommercialAdDetector();
  const caption = analyzeCaption(params.caption, params.settings, detector);
  const images = params.images.map((image) => analyzeImage(image, params.settings, detector));
  const imageSetComplete = isCompleteImageSet(params.expectedImageCount, params.images);

  if (caption.safeContextBucket !== 'none') {
    return buildNoActionDecision({
      caption,
      images,
      reasonCodes: [`caption-safe-context:${caption.safeContextBucket}`],
    });
  }

  const imageSafeContext = images.flatMap((image) =>
    [image.primary, image.verification].flatMap((pass) => {
      const bucket = pass?.detection?.safeContextBucket;
      return bucket && bucket !== 'none' ? [{ imageIndex: image.imageIndex, bucket }] : [];
    }),
  )[0];
  if (imageSafeContext) {
    return buildNoActionDecision({
      caption,
      images,
      reasonCodes: [`image-safe-context:${imageSafeContext.imageIndex}:${imageSafeContext.bucket}`],
    });
  }

  if (!imageSetComplete) {
    return buildNoActionDecision({
      caption,
      images,
      reasonCodes: ['image-set-incomplete'],
    });
  }

  const imageCandidate = images
    .filter((image) => image.deleteEligible)
    .sort((left, right) => left.imageIndex - right.imageIndex)[0];
  if (!imageCandidate) {
    return buildNoActionDecision({
      caption,
      images,
      reasonCodes: ['no-independent-delete-source'],
    });
  }

  return {
    policyVersion: COMMERCIAL_OCR_DECISION_POLICY_VERSION,
    action: 'DELETE',
    deleteSource: {
      kind: 'image',
      imageIndex: imageCandidate.imageIndex,
      source: imageCandidate.source,
    },
    caption,
    images,
    reasonCodes: ['image-independent-two-pass-delete'],
  };
}

function analyzeCaption(
  caption: string,
  settings: ChatSettings,
  detector: CommercialOcrDetector,
): CommercialOcrCaptionAnalysis {
  const text = caption.trim();
  const detection = text ? detectCommercialText(text, settings, detector) : null;
  const safeContextBucket = deriveCaptionSafeContext(text, settings, detection);
  const detectorGate = evaluateDetectorGate(detection);
  const rejectionReasons = [...detectorGate.rejectionReasons];
  if (safeContextBucket !== 'none' && !rejectionReasons.includes('detector-safe-context')) {
    rejectionReasons.push('detector-safe-context');
  }

  return {
    detection,
    safeContextBucket,
    deleteEligible: detectorGate.deleteEligible && safeContextBucket === 'none',
    rejectionReasons,
  };
}

function analyzeImage(
  image: CommercialOcrImageDecisionInput,
  settings: ChatSettings,
  detector: CommercialOcrDetector,
): CommercialOcrImageAnalysis {
  const primary = analyzeOcrPass(image.primary, settings, detector);
  const verification = image.verification
    ? analyzeOcrPass(image.verification, settings, detector)
    : null;
  const rejectionReasons: CommercialOcrImageRejectionReason[] = [];

  if (!primary.deleteEligible) {
    rejectionReasons.push('primary-pass-not-delete-eligible');
  }
  if (!verification) {
    rejectionReasons.push('verification-pass-missing');
  } else if (!verification.deleteEligible) {
    rejectionReasons.push('verification-pass-not-delete-eligible');
  }

  if (
    primary.deleteEligible &&
    verification?.deleteEligible &&
    primary.detection?.primarySubtype !== verification.detection?.primarySubtype
  ) {
    rejectionReasons.push('detector-subtype-disagreement');
  }
  if (
    primary.deleteEligible &&
    verification?.deleteEligible &&
    !sameStringArray(primary.criticalSignature, verification.criticalSignature)
  ) {
    rejectionReasons.push('critical-evidence-disagreement');
  }

  return {
    imageIndex: image.imageIndex,
    source: image.source,
    primary,
    verification,
    deleteEligible: rejectionReasons.length === 0,
    rejectionReasons,
  };
}

function analyzeOcrPass(
  pass: CommercialOcrPass,
  settings: ChatSettings,
  detector: CommercialOcrDetector,
): CommercialOcrPassAnalysis {
  const rejectionReasons: CommercialOcrPassRejectionReason[] = [];
  const text = pass.text.trim();
  const criticalEvidence = pass.criticalEvidence ?? [];
  const criticalSignature = buildCriticalSignature(criticalEvidence);

  if (pass.status !== 'recognized') {
    rejectionReasons.push('ocr-pass-not-recognized');
  }
  if (text.length < COMMERCIAL_OCR_DELETE_GATE.minTextLength) {
    rejectionReasons.push('ocr-text-too-short');
  }
  const wordCount = text.match(/[\p{L}\p{N}]+/gu)?.length ?? 0;
  if (wordCount < COMMERCIAL_OCR_DELETE_GATE.minWordCount) {
    rejectionReasons.push('ocr-word-count-too-low');
  }
  if (
    !isPermille(pass.confidencePermille) ||
    pass.confidencePermille < COMMERCIAL_OCR_DELETE_GATE.minAggregateConfidencePermille
  ) {
    rejectionReasons.push('ocr-confidence-too-low');
  }
  if (!hasRequiredCriticalEvidence(criticalEvidence)) {
    rejectionReasons.push('ocr-critical-evidence-missing');
  }
  if (
    criticalEvidence.some(
      (evidence) =>
        !isPermille(evidence.confidencePermille) ||
        evidence.confidencePermille < COMMERCIAL_OCR_DELETE_GATE.minCriticalConfidencePermille,
    )
  ) {
    rejectionReasons.push('ocr-critical-confidence-too-low');
  }

  const detection =
    pass.status === 'recognized' && text ? detectCommercialText(text, settings, detector) : null;
  const detectorGate = evaluateDetectorGate(detection);
  rejectionReasons.push(...detectorGate.rejectionReasons);
  const scriptEvidence = classifyCommercialOcrLetterScript(text);

  return {
    detection,
    deleteEligible: rejectionReasons.length === 0,
    rejectionReasons: [...new Set(rejectionReasons)],
    criticalSignature,
    letterScript: scriptEvidence.letterScript,
    cyrillicLetterCount: scriptEvidence.cyrillicLetterCount,
    latinLetterCount: scriptEvidence.latinLetterCount,
  };
}

function evaluateDetectorGate(detection: CommercialDetection | null): {
  deleteEligible: boolean;
  rejectionReasons: CommercialOcrPassRejectionReason[];
} {
  if (!detection) {
    return { deleteEligible: false, rejectionReasons: ['detector-no-hit'] };
  }

  const rejectionReasons: CommercialOcrPassRejectionReason[] = [];
  const escalationDeleteEligible = isEscalationDeleteEligible(detection);
  if (detection.actionBand !== 'DELETE' && !escalationDeleteEligible) {
    rejectionReasons.push('detector-action-not-delete');
  }
  if (detection.confidenceScore < COMMERCIAL_OCR_DELETE_GATE.minDetectorScore) {
    rejectionReasons.push('detector-score-too-low');
  }
  if (
    typeof detection.actionScore !== 'number' ||
    detection.actionScore < COMMERCIAL_OCR_DELETE_GATE.minActionScore
  ) {
    rejectionReasons.push('detector-action-score-too-low');
  }
  if (detection.evidenceTier !== 'DIRECT' && !escalationDeleteEligible) {
    rejectionReasons.push('detector-evidence-not-direct');
  }
  if (
    typeof detection.policyFpRisk !== 'number' ||
    detection.policyFpRisk > COMMERCIAL_OCR_DELETE_GATE.maxPolicyFpRisk
  ) {
    rejectionReasons.push('detector-fp-risk-too-high');
  }
  if (detection.reviewRecommended || detection.reviewReasons.length > 0) {
    rejectionReasons.push('detector-review-required');
  }
  if (detection.deleteSuppressed || (detection.suppressionReasons?.length ?? 0) > 0) {
    rejectionReasons.push('detector-delete-suppressed');
  }
  if (detection.safeContextBucket !== 'none') {
    rejectionReasons.push('detector-safe-context');
  }
  if (
    detection.primarySubtype === 'GENERIC' ||
    (detection.primarySubtype === 'GOODS' && !escalationDeleteEligible)
  ) {
    rejectionReasons.push('detector-subtype-excluded');
  }
  if (detection.actionable !== true || detection.recordable !== true) {
    rejectionReasons.push('detector-not-actionable');
  }
  if (detection.reasonCodes?.some((reason) => reason.startsWith('missing-anchor:'))) {
    rejectionReasons.push('detector-missing-anchor');
  }

  return {
    deleteEligible: rejectionReasons.length === 0,
    rejectionReasons,
  };
}

function isEscalationDeleteEligible(detection: CommercialDetection): boolean {
  return (
    detection.actionBand === 'DELETE_AND_ESCALATE' &&
    detection.evidenceTier === 'HIGH_RISK' &&
    detection.hasEscalationRiskEvidence === true &&
    detection.reasonCodes?.includes('risk:escalation-grade') === true
  );
}

function detectCommercialText(
  text: string,
  settings: ChatSettings,
  detector: CommercialOcrDetector,
): CommercialDetection | null {
  const rawLoweredText = normalizeCommercialRawText(text);
  return detector.detect({
    normalizedText: normalizeCommercialText(rawLoweredText),
    rawLoweredText,
    settings,
    commercialCampaignContext: null,
  });
}

function deriveCaptionSafeContext(
  text: string,
  settings: ChatSettings,
  detection: CommercialDetection | null,
): CommercialSafeContextBucket {
  if (!text) {
    return 'none';
  }
  if (detection?.safeContextBucket && detection.safeContextBucket !== 'none') {
    return detection.safeContextBucket as CommercialSafeContextBucket;
  }

  const rawLoweredText = normalizeCommercialRawText(text);
  const state = collectCommercialSignals({
    normalizedText: normalizeCommercialText(rawLoweredText),
    rawLoweredText,
    profile: resolveCommercialThresholds(settings),
    commercialCampaignContext: null,
  });
  return deriveCommercialSafeContextBucket({
    text,
    matchedSignals: state.matchedSignals,
    negativeSignals: state.negativeSignals,
    hasCommercialHit: detection !== null,
  });
}

function hasRequiredCriticalEvidence(evidence: readonly CommercialOcrCriticalEvidence[]): boolean {
  const kinds = new Set(evidence.map((item) => item.kind));
  const hasDealEvidence = ['contact', 'deal_channel', 'price', 'transaction'].some((kind) =>
    kinds.has(kind as CommercialOcrCriticalEvidenceKind),
  );
  return (
    kinds.has('commercial_anchor') &&
    hasDealEvidence &&
    buildCriticalSignature(evidence).length >= 2
  );
}

function buildCriticalSignature(evidence: readonly CommercialOcrCriticalEvidence[]): string[] {
  return [
    ...new Set(
      evidence.flatMap((item) => {
        const semanticKey = item.semanticKey.trim().toLowerCase();
        return semanticKey ? [`${item.kind}:${semanticKey}`] : [];
      }),
    ),
  ].sort();
}

export function hasCommercialOcrPrimaryDeleteCandidate(decision: CommercialOcrDecision): boolean {
  return decision.images.some(
    (image) =>
      image.primary.deleteEligible &&
      image.primary.criticalSignature.length >= 2 &&
      image.primary.detection !== null,
  );
}

/**
 * The first enforcement cohort is intentionally narrower than recognition. Tesseract may use
 * rus+eng for quality, but a DELETE is eligible only when both independent source passes are
 * unambiguously Cyrillic and no recognized album pass contains Latin letters. Unknown and mixed
 * results remain report-only.
 */
export function isCommercialOcrCyrillicOnlyDeleteDecision(
  decision: CommercialOcrDecision,
): boolean {
  if (decision.action !== 'DELETE' || !decision.deleteSource) {
    return false;
  }
  const candidates = decision.images.filter(
    (image) =>
      image.imageIndex === decision.deleteSource?.imageIndex &&
      image.source === decision.deleteSource.source,
  );
  if (candidates.length !== 1) {
    return false;
  }
  const candidate = candidates[0]!;
  return (
    candidate.primary.letterScript === 'cyrillic_only' &&
    candidate.primary.cyrillicLetterCount >=
      COMMERCIAL_OCR_MIN_CYRILLIC_ENFORCEMENT_LETTERS_PER_PASS &&
    candidate.primary.latinLetterCount === 0 &&
    candidate.verification !== null &&
    candidate.verification.letterScript === 'cyrillic_only' &&
    candidate.verification.cyrillicLetterCount >=
      COMMERCIAL_OCR_MIN_CYRILLIC_ENFORCEMENT_LETTERS_PER_PASS &&
    candidate.verification.latinLetterCount === 0 &&
    decision.images.every((image) =>
      [image.primary, image.verification].every(
        (pass) => pass === null || pass.latinLetterCount === 0,
      ),
    )
  );
}

function isPermille(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0 && value <= 1_000;
}

function sameStringArray(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function isCompleteImageSet(
  expectedImageCount: number,
  images: readonly CommercialOcrImageDecisionInput[],
): boolean {
  if (
    !Number.isSafeInteger(expectedImageCount) ||
    expectedImageCount < 0 ||
    images.length !== expectedImageCount
  ) {
    return false;
  }
  const indexes = new Set(images.map((image) => image.imageIndex));
  return (
    indexes.size === expectedImageCount &&
    images.every(
      (image) =>
        Number.isSafeInteger(image.imageIndex) &&
        image.imageIndex >= 0 &&
        image.imageIndex < expectedImageCount &&
        image.primary.status !== 'failed',
    )
  );
}

function buildNoActionDecision(params: {
  caption: CommercialOcrCaptionAnalysis;
  images: CommercialOcrImageAnalysis[];
  reasonCodes: string[];
}): CommercialOcrDecision {
  return {
    policyVersion: COMMERCIAL_OCR_DECISION_POLICY_VERSION,
    action: 'NO_ACTION',
    deleteSource: null,
    caption: params.caption,
    images: params.images,
    reasonCodes: params.reasonCodes,
  };
}
