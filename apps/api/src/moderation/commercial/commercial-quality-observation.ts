import { createHash } from 'node:crypto';
import type { ChatSettings } from '../../prisma/prisma-client';
import type { RuleViolation } from '../rule-engine.contract';
import type { CommercialCampaignContext } from '../commercial-campaign.util';
import { createRuleDetectionContext } from '../rule-engine-detection-context';
import { COMMERCIAL_OCR_DETECTOR_SOURCE_SHA256 } from '../commercial-ocr/commercial-ocr-detector-source.generated';
import { CommercialAdDetector } from './commercial-ad.detector';
import { COMMERCIAL_INTENT_QUALITY_DECISION_VERSION } from './commercial-policy-cohorts';
import { COMMERCIAL_ENGINE_CONFIG } from './commercial-config';
import { isCommercialMessageDeleteEligible } from './commercial-action-policy';
import { fingerprintCommercialTextSettingsProfile } from './commercial-text-runtime-policy.service';
import { buildCommercialQualitySample } from './commercial-quality-sampling';
import type { Candidate } from './commercial-review.service';

const shadowDetector = new CommercialAdDetector();
const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];

// FLAG: This observation never selects a violation or authorizes an action. Candidate
// output is evaluated only for the selected sample and stored beside the real decision.
// Keep the original source revision in the returned value for all execution enrichment.
export function buildCommercialTextQualityObservation(input: {
  secret: string | undefined;
  chatId: string;
  userId: string;
  messageId: string;
  text: string;
  messageCreatedAt: string | null;
  settings: ChatSettings;
  violation: RuleViolation | undefined;
  activeAiEnforcement?: boolean;
  commercialCampaignContext?: CommercialCampaignContext | null;
}): Candidate | null {
  const activeAi = input.activeAiEnforcement === true;
  const metadata = activeAi ? {} : (input.violation?.metadata ?? {});
  const hasDetection = !activeAi && Boolean(input.violation);
  const sample = buildCommercialQualitySample({
    ...input,
    source: 'TEXT',
    hasDetection,
    reviewRecommended: metadata.reviewRecommended === true || metadata.actionBand === 'REVIEW_ONLY',
  });
  if (!sample) return null;
  const actionBand = activeAi
    ? 'NOT_EVALUATED'
    : typeof metadata.actionBand === 'string'
      ? metadata.actionBand
      : 'ALLOW';
  const deleteEligible = isCommercialMessageDeleteEligible(
    actionBand,
    metadata.actionable === true,
    metadata.messageDisposition,
  );
  const context = createRuleDetectionContext(input);
  const candidate = shadowDetector.detectExperimental({
    ...context,
    settings: input.settings,
    commercialCampaignContext: input.commercialCampaignContext,
  });
  // FLAG: Synchronous capture cannot observe the asynchronous model's result or grant permission.
  // A separate identity prevents these sources being certified as completed deterministic KEEP.
  const version = activeAi
    ? 'commercial-ai-asynchronous-v1'
    : typeof metadata.decisionVersion === 'string'
      ? metadata.decisionVersion
      : COMMERCIAL_ENGINE_CONFIG.decisionVersion;
  const disposition = deleteEligible ? 'DELETE' : 'KEEP';
  return {
    ...sample,
    chatId: input.chatId,
    userId: input.userId,
    messageId: input.messageId,
    text: input.text,
    source: 'TEXT',
    score: (activeAi ? 0 : (input.violation?.score ?? 0)) * 100,
    actionBand,
    messageDisposition: disposition,
    detectorVersion: version,
    detectorSourceSha256: COMMERCIAL_OCR_DETECTOR_SOURCE_SHA256,
    settingsProfileDigest: fingerprintCommercialTextSettingsProfile(input.settings),
    hasDetection,
    deleteEligible: activeAi ? null : deleteEligible,
    decisionOutcome: activeAi ? null : disposition,
    executionOutcome: activeAi || deleteEligible ? 'UNKNOWN' : 'NOT_REQUESTED',
    analysisOutcome: activeAi ? 'NOT_APPLICABLE' : 'COMPLETE',
    imageReviewRequired: false,
    sourceExcerptComplete: true,
    requiredPolicyCohorts: strings(metadata.requiredPolicyCohorts),
    reasons: strings(metadata.reasonCodes),
    decisionFingerprint: createHash('sha256')
      .update(
        JSON.stringify([
          sample.sourceSnapshotSha256,
          version,
          metadata.commercialTextRuntimeRevision ?? null,
          actionBand,
          disposition,
        ]),
      )
      .digest('hex'),
    candidateDecision: {
      hasDetection: Boolean(candidate),
      actionable: candidate?.actionable === true,
      deleteEligible: isCommercialMessageDeleteEligible(
        candidate?.actionBand ?? 'ALLOW',
        candidate?.actionable === true,
        candidate?.messageDisposition ?? 'KEEP',
      ),
      score: candidate?.confidenceScore ?? 0,
      actionBand: candidate?.actionBand ?? 'ALLOW',
      messageDisposition: candidate?.messageDisposition ?? 'KEEP',
      detectorVersion: candidate?.decisionVersion ?? COMMERCIAL_INTENT_QUALITY_DECISION_VERSION,
      decisionFingerprint: createHash('sha256')
        .update(
          JSON.stringify([
            sample.sourceSnapshotSha256,
            candidate?.decisionVersion ?? COMMERCIAL_INTENT_QUALITY_DECISION_VERSION,
            candidate?.actionBand ?? 'ALLOW',
            candidate?.messageDisposition ?? 'KEEP',
          ]),
        )
        .digest('hex'),
      reasons: candidate?.reasonCodes ?? [],
      requiredPolicyCohorts: candidate?.requiredPolicyCohorts ?? [],
    },
  };
}
