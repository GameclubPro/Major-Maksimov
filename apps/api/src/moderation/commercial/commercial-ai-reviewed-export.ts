import { createHash } from 'node:crypto';
import {
  COMMERCIAL_AI_QUALITY_MAX_ENVELOPE_BYTES,
  commercialAiQualityEnvelopeSchema,
  type CommercialAiQualityProjection,
} from '@maxim/contracts/commercial-ai-quality';
import {
  commercialReviewEvidenceMetadataSchema,
  type CommercialReviewExportResponse,
} from '@maxim/contracts/safety-desk';
import { isCommercialCorpusTextSanitized } from '../../scripts/commercial-corpus-sanitization.util';

export type CommercialAiReviewedExportRow = {
  humanReviewEvidenceHash: string | null;
  source: string;
  evidenceHash: string;
  expiresAt: Date;
  excerpt: string | null;
  qualityMetadata: unknown;
  llmEnforcement: unknown;
  payloadOversized: boolean;
};

const digest = /^[a-f0-9]{64}$/u;
const MAX_METADATA_BYTES = 32 * 1024;
const provenanceKeys = [
  'logicalMessageKey',
  'sourceSnapshotSha256',
  'messageCreatedAt',
  'settingsProfileDigest',
  'pseudonymizationKeyId',
  'authorGroupId',
  'campaignGroupId',
  'campaignGroupingComplete',
  'detectorSourceSha256',
  'samplingProbability',
  'randomEvaluationIncluded',
  'evaluationSamplingProbability',
  'samplingStratum',
] as const;

function bounded(value: unknown, maxBytes: number): boolean {
  try {
    const serialized = JSON.stringify(value);
    return typeof serialized === 'string' && Buffer.byteLength(serialized, 'utf8') <= maxBytes;
  } catch {
    return false;
  }
}

const invalid = (): CommercialAiQualityProjection => ({
  schemaVersion: 1,
  captureState: 'INVALID',
  coverageIncomplete: true,
});

// FLAG: The caller reads at most two rows from the exact human-evidence index before
// JSON/expiry filtering. Ambiguity remains a gap; never choose a convenient model result.
export function projectCommercialAiReviewedExport(
  item: CommercialReviewExportResponse['items'][number],
  humanReviewEvidenceHash: string,
  candidates: readonly CommercialAiReviewedExportRow[],
  now = Date.now(),
): CommercialAiQualityProjection | null {
  const sample = item.sample;
  // FLAG: Presence and predictions remain private until this actor's own review.
  if (
    !sample.decisionVisible ||
    !sample.ownReview ||
    !Number.isFinite(now) ||
    !Number.isFinite(Date.parse(sample.expiresAt)) ||
    Date.parse(sample.expiresAt) <= now ||
    candidates.length === 0
  )
    return null;
  if (candidates.length !== 1 || !digest.test(humanReviewEvidenceHash)) return invalid();
  const row = candidates[0]!;
  if (!Number.isFinite(row.expiresAt.getTime()) || row.expiresAt.getTime() <= now) return null;
  if (
    sample.source !== 'TEXT' ||
    sample.sourceExcerptComplete !== true ||
    row.source !== 'TEXT' ||
    row.humanReviewEvidenceHash !== humanReviewEvidenceHash ||
    !digest.test(row.evidenceHash) ||
    row.payloadOversized ||
    !bounded(sample.evidenceMetadata, MAX_METADATA_BYTES) ||
    !bounded(row.qualityMetadata, MAX_METADATA_BYTES) ||
    !bounded(row.llmEnforcement, COMMERCIAL_AI_QUALITY_MAX_ENVELOPE_BYTES) ||
    !row.excerpt?.trim() ||
    row.excerpt.length > 2500 ||
    row.excerpt !== sample.excerpt ||
    !isCommercialCorpusTextSanitized(row.excerpt)
  )
    return invalid();
  const reviewed = commercialReviewEvidenceMetadataSchema.safeParse(sample.evidenceMetadata);
  const observed = commercialReviewEvidenceMetadataSchema.safeParse(row.qualityMetadata);
  const parsed = commercialAiQualityEnvelopeSchema.safeParse(row.llmEnforcement);
  if (!reviewed.success || !observed.success || !parsed.success) return invalid();
  const metadata = reviewed.data;
  if (
    metadata.sourceExcerptComplete !== true ||
    observed.data.sourceExcerptComplete !== true ||
    metadata.imageReviewRequired ||
    observed.data.imageReviewRequired ||
    ![
      metadata.logicalMessageKey,
      metadata.sourceSnapshotSha256,
      metadata.settingsProfileDigest,
      metadata.pseudonymizationKeyId,
      metadata.authorGroupId,
      metadata.campaignGroupId,
      metadata.detectorSourceSha256,
    ].every((value) => typeof value === 'string' && digest.test(value)) ||
    metadata.campaignGroupIds.some((value) => !digest.test(value)) ||
    new Set(metadata.campaignGroupIds).size !== metadata.campaignGroupIds.length ||
    typeof metadata.campaignGroupingComplete !== 'boolean' ||
    typeof metadata.randomEvaluationIncluded !== 'boolean' ||
    !(metadata.samplingProbability !== null && metadata.samplingProbability > 0) ||
    !(
      metadata.evaluationSamplingProbability !== null && metadata.evaluationSamplingProbability > 0
    ) ||
    provenanceKeys.some((key) => metadata[key] !== observed.data[key]) ||
    JSON.stringify(metadata.campaignGroupIds) !== JSON.stringify(observed.data.campaignGroupIds)
  )
    return invalid();
  const envelope = parsed.data;
  const excerptSha256 = createHash('sha256').update(row.excerpt, 'utf8').digest('hex');
  if (
    envelope.source.evidenceHash !== row.evidenceHash ||
    envelope.source.logicalMessageKey !== metadata.logicalMessageKey ||
    envelope.source.sourceSnapshotSha256 !== metadata.sourceSnapshotSha256 ||
    envelope.source.messageCreatedAt !== metadata.messageCreatedAt ||
    envelope.source.excerptSha256 !== excerptSha256 ||
    envelope.attempts.some(
      (attempt) =>
        attempt.inputSha256 !== excerptSha256 ||
        attempt.settingsProfileDigest !== metadata.settingsProfileDigest,
    )
  )
    return invalid();
  // FLAG: Retained history is exported as observed, without renewing source authority,
  // interpreting a missing result as KEEP, or promoting a model/permission/receipt.
  return envelope;
}
