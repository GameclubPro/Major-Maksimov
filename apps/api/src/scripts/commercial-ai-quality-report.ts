import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  commercialAiQualityProjectionSchema,
  commercialAiQualityResultSchema,
  commercialAiReviewExportResponseSchema,
  type CommercialAiQualityAttempt,
  type CommercialAiQualityResult,
  type CommercialAiReviewExportResponse,
} from '@maxim/contracts/commercial-ai-quality';
import {
  commercialReviewEvidenceMetadataSchema,
  commercialReviewSamplingFrameResponseSchema,
} from '@maxim/contracts/safety-desk';
import {
  commercialLlmPoolEnforcementIdentity,
  COMMERCIAL_LLM_EFFECT_MAX_AGE_MS,
} from '../moderation/commercial/commercial-llm-enforcement.protocol';
import { COMMERCIAL_LLM_POOL_PROFILES } from '../moderation/commercial/commercial-llm-pool.protocol';
import { COMMERCIAL_LLM_POLICY_VERSION } from '../moderation/commercial/commercial-llm.protocol';
import { COMMERCIAL_QUALITY_EVALUATION_PROBABILITY } from '../moderation/commercial/commercial-quality-sampling';
import { commercialWilson95 } from './commercial-text-holdout-artifact';

const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const iso = z.string().datetime();
const policy = z.enum(['confirm-positive', 'direct-4b']);
const replay = z.object({ hit: z.boolean(), deleteEligible: z.boolean() }).strict();
const page = z
  .object({ cursor: z.string().nullable(), response: commercialAiReviewExportResponseSchema })
  .strict();
const framePage = z
  .object({ cursor: z.string().nullable(), response: commercialReviewSamplingFrameResponseSchema })
  .strict();

export const commercialAiQualityCaptureSchema = z
  .object({
    captureKey: digest,
    sourceSnapshotSha256: digest.nullable().default(null),
    metadata: commercialReviewEvidenceMetadataSchema.nullable().default(null),
    llmEnforcement: commercialAiQualityProjectionSchema.nullable().default(null),
    diagnosticResult: commercialAiQualityResultSchema.nullable().default(null),
    diagnosticStatus: z
      .enum(['COMPLETE', 'TECHNICAL_INCOMPLETE', 'NOT_OBSERVED'])
      .default('NOT_OBSERVED'),
    diagnosticOutcome: z
      .enum([
        'COMPLETE',
        'NO_CAPACITY',
        'PRIVACY_UNAVAILABLE',
        'UNSUPPORTED_INPUT',
        'UNAVAILABLE_PRECHECK',
        'UNKNOWN_ADMISSION',
        'UNKNOWN_COMPUTATION',
        'INVALID_OBSERVATION',
        'NOT_ATTEMPTED',
      ])
      .optional(),
    deterministicReplay: z.object({ original: replay, sanitized: replay }).strict().optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.diagnosticStatus === 'COMPLETE') !== (value.diagnosticResult !== null))
      context.addIssue({
        code: 'custom',
        message: 'Diagnostic completion requires its model result.',
      });
    if (
      value.diagnosticOutcome !== undefined &&
      (value.diagnosticOutcome === 'COMPLETE') !== (value.diagnosticStatus === 'COMPLETE')
    )
      context.addIssue({
        code: 'custom',
        message: 'Diagnostic outcome must match its completion state.',
      });
  });
export type CommercialAiQualityCapture = z.infer<typeof commercialAiQualityCaptureSchema>;

export const commercialAiQualityEvidenceSchema = z
  .object({
    schemaVersion: z.literal('commercial-ai-quality-evidence/v1'),
    mode: z.enum(['CAPTURE_DIAGNOSTIC', 'AI_REFERENCE', 'INDEPENDENT_REVIEW']),
    evaluatedAt: iso,
    manifest: z
      .object({
        policy,
        classifierIdentitySha256: digest,
        profilesSha256: digest,
        criteriaVersion: z.literal('commercial-ai-policy-quality/v1'),
        policyFrozenAt: iso,
        developmentFrameSha256: digest,
        holdoutFrameSha256: digest,
        requiredProtectedCohorts: z
          .array(z.string().regex(/^[a-z0-9_.:-]{1,120}$/iu))
          .min(1)
          .max(32),
      })
      .strict()
      .nullable()
      .default(null),
    manifestSha256: digest.nullable().default(null),
    captures: z.array(commercialAiQualityCaptureSchema).max(100_000).default([]),
    aiReferences: z
      .array(
        z
          .object({
            captureKey: digest,
            label: z.enum(['COMMERCIAL', 'PROTECTED', 'UNKNOWN']),
          })
          .strict(),
      )
      .max(100_000)
      .default([]),
    development: z.array(page).max(200).default([]),
    holdout: z.array(page).max(200).default([]),
    developmentFrame: z.array(framePage).max(200).default([]),
    holdoutFrame: z.array(framePage).max(200).default([]),
  })
  .strict();
export type CommercialAiQualityEvidence = z.infer<typeof commercialAiQualityEvidenceSchema>;
type Item = CommercialAiReviewExportResponse['items'][number];
type Classification = CommercialAiQualityResult['classification'];
type ReviewedCapture = CommercialAiQualityCapture & { reviewedTextExcerptSha256?: string };
const DAY = 86_400_000;

export function commercialAiQualityDigest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export function commercialAiQualityExpectedIdentity(selectedPolicy: z.infer<typeof policy>) {
  return {
    policy: selectedPolicy,
    classifierIdentitySha256: commercialLlmPoolEnforcementIdentity(selectedPolicy),
    profilesSha256: commercialAiQualityDigest(COMMERCIAL_LLM_POOL_PROFILES),
    criteriaVersion: 'commercial-ai-policy-quality/v1' as const,
  };
}

function resultIdentityValid(result: CommercialAiQualityResult): boolean {
  const profiles = result.pool
    ? [COMMERCIAL_LLM_POOL_PROFILES[result.pool.nodeId]]
    : Object.values(COMMERCIAL_LLM_POOL_PROFILES);
  return (
    result.policyVersion === COMMERCIAL_LLM_POLICY_VERSION &&
    profiles.some((profile) =>
      (
        [
          'modelAlias',
          'modelSha256',
          'promptSha256',
          'chatTemplateSha256',
          'runtimeVersion',
          'runtimeImageSha256',
          'runtimeArtifactSha256',
          'runtimeSupportSha256',
        ] as const
      ).every((key) => result[key] === profile.identity[key]),
    )
  );
}

function policyEligibility(
  attempt: CommercialAiQualityAttempt,
  selectedPolicy: z.infer<typeof policy>,
): boolean {
  const result = attempt.analysis.result;
  const pool = result?.pool;
  if (
    !result ||
    !pool ||
    !resultIdentityValid(result) ||
    result.classification !== 'COMMERCIAL' ||
    attempt.sourceVersion !== 2 ||
    pool.policy !== selectedPolicy ||
    attempt.classifierIdentitySha256 !== commercialLlmPoolEnforcementIdentity(selectedPolicy)
  )
    return false;
  if (pool.route === 'direct')
    return (
      pool.primaryNodeId === undefined &&
      pool.primaryClassification === undefined &&
      pool.consultationOutcome === undefined &&
      (COMMERCIAL_LLM_POOL_PROFILES[pool.nodeId].model === '9b' || selectedPolicy === 'direct-4b')
    );
  return (
    COMMERCIAL_LLM_POOL_PROFILES[pool.nodeId].model === '9b' &&
    pool.primaryNodeId === 'pc-a-4b' &&
    pool.consultationOutcome === 'completed' &&
    (pool.primaryClassification === 'UNSURE' ||
      (selectedPolicy === 'confirm-positive' && pool.primaryClassification === 'COMMERCIAL'))
  );
}

function selectedAttempt(capture: CommercialAiQualityCapture) {
  const envelope = capture.llmEnforcement;
  if (envelope?.captureState !== 'OBSERVED') return null;
  // FLAG: Fixed before inspecting truth: choose the earliest accepted attempt, never the best result.
  const accepted = envelope.attempts.filter((attempt) => attempt.admission.state === 'ACCEPTED');
  return (
    [...(accepted.length ? accepted : envelope.attempts)].sort(
      (a, b) => a.submittedAtMs - b.submittedAtMs || a.sourceKey.localeCompare(b.sourceKey),
    )[0] ?? null
  );
}

function finalRating(row: Item) {
  return (
    row.ratings.find((rating) => rating.kind === 'ADJUDICATION') ??
    row.ratings.find((rating) => rating.kind === 'INDEPENDENT')
  );
}
function groupKeys(row: Item): string[] {
  const metadata = row.sample.evidenceMetadata;
  if (!metadata?.authorGroupId || !metadata.campaignGroupId) return [];
  return [
    `author:${metadata.authorGroupId}`,
    ...new Set(
      [metadata.campaignGroupId, ...metadata.campaignGroupIds].map((key) => `campaign:${key}`),
    ),
  ];
}
function independent(row: Item): boolean {
  const metadata = row.sample.evidenceMetadata;
  const reviewers = row.ratings.filter((rating) => rating.kind === 'INDEPENDENT');
  const adjudicators = row.ratings.filter((rating) => rating.kind === 'ADJUDICATION');
  const final = finalRating(row);
  return (
    row.sample.source === 'TEXT' &&
    row.eligibleForIndependentCorpus &&
    row.sample.reviewState === 'RESOLVED' &&
    reviewers.length === 2 &&
    adjudicators.length <= 1 &&
    new Set(row.ratings.map((rating) => rating.reviewerKey)).size === row.ratings.length &&
    !!metadata?.sourceSnapshotSha256 &&
    !!metadata.logicalMessageKey &&
    groupKeys(row).length >= 2 &&
    metadata.campaignGroupingComplete === true &&
    metadata.sourceExcerptComplete === true &&
    metadata.randomEvaluationIncluded === true &&
    metadata.evaluationSamplingProbability === COMMERCIAL_QUALITY_EVALUATION_PROBABILITY &&
    !!metadata.messageCreatedAt &&
    !!final &&
    final.label !== 'UNSURE' &&
    final.expectedDisposition !== null &&
    row.sample.label === final.label &&
    (adjudicators.length === 1 ||
      reviewers.every(
        (rating) =>
          rating.label === final.label && rating.expectedDisposition === final.expectedDisposition,
      )) &&
    row.ratings.every(
      (rating) =>
        rating.label !== 'UNSURE' &&
        rating.evidenceKind === 'TEXT' &&
        Date.parse(rating.reviewedAt) >= Date.parse(metadata.messageCreatedAt!),
    )
  );
}

function readPages(pages: CommercialAiQualityEvidence['holdout'], name: string, errors: string[]) {
  if (!pages.length) {
    errors.push(`${name}_pages_missing`);
    return [];
  }
  const first = pages[0]!.response;
  let cursor: string | null = null;
  const cursors = new Set<string | null>();
  const rows: Item[] = [];
  for (const entry of pages) {
    if (
      cursors.has(entry.cursor) ||
      entry.cursor !== cursor ||
      entry.response.since !== first.since ||
      entry.response.until !== first.until ||
      entry.response.complete !== (entry.response.nextCursor === null)
    )
      errors.push(`${name}_pagination_incomplete`);
    cursors.add(entry.cursor);
    cursor = entry.response.nextCursor;
    rows.push(...entry.response.items);
    if (Date.parse(entry.response.since) >= Date.parse(entry.response.until))
      errors.push(`${name}_window_invalid`);
    if (Date.parse(entry.response.generatedAt) < Date.parse(entry.response.until))
      errors.push(`${name}_export_before_window_closed`);
  }
  if (cursor !== null) errors.push(`${name}_pagination_truncated`);
  return rows;
}

function reconcileFrame(
  pages: CommercialAiQualityEvidence['holdoutFrame'],
  rows: Item[],
  name: string,
  errors: string[],
  expectedWindow?: { since: string; until: string },
) {
  if (!pages.length) {
    errors.push(`${name}_frame_missing`);
    return { complete: false, selected: 0, missingIndependentReviews: 0 };
  }
  const first = pages[0]!.response;
  if (
    !expectedWindow ||
    first.since !== expectedWindow.since ||
    first.until !== expectedWindow.until
  )
    errors.push(`${name}_frame_window_mismatch`);
  const frame = new Map<string, (typeof first.items)[number]>();
  let cursor: string | null = null;
  const seen = new Set<string | null>();
  for (const entry of pages) {
    if (
      seen.has(entry.cursor) ||
      entry.cursor !== cursor ||
      entry.response.since !== first.since ||
      entry.response.until !== first.until ||
      entry.response.complete !== (entry.response.nextCursor === null)
    )
      errors.push(`${name}_frame_pagination_incomplete`);
    seen.add(entry.cursor);
    cursor = entry.response.nextCursor;
    if (entry.response.samplingUnavailableRows !== 0) errors.push(`${name}_frame_sampling_unknown`);
    for (const item of entry.response.items.filter((item) => item.source === 'TEXT')) {
      if (
        Date.parse(item.observedAt) < Date.parse(first.since) ||
        Date.parse(item.observedAt) >= Date.parse(first.until)
      )
        errors.push(`${name}_frame_row_outside_window`);
      if (
        !item.sourceSnapshotSha256 ||
        !item.logicalMessageKey ||
        !item.pseudonymizationKeyId ||
        !item.settingsProfileDigest ||
        !item.messageCreatedAt ||
        item.campaignGroupingComplete !== true ||
        item.evaluationSamplingProbability !== COMMERCIAL_QUALITY_EVALUATION_PROBABILITY
      )
        errors.push(`${name}_frame_metadata_incomplete`);
      const key = item.sourceSnapshotSha256 ?? '';
      if (frame.has(key)) errors.push(`${name}_frame_duplicate_revision`);
      frame.set(key, item);
    }
  }
  if (cursor !== null) errors.push(`${name}_frame_truncated`);
  const reviewed = new Set<string>();
  for (const row of rows.filter((row) => row.sample.source === 'TEXT')) {
    const metadata = row.sample.evidenceMetadata;
    const entry = metadata?.sourceSnapshotSha256
      ? frame.get(metadata.sourceSnapshotSha256)
      : undefined;
    if (
      !entry ||
      !metadata ||
      entry.logicalMessageKey !== metadata.logicalMessageKey ||
      entry.pseudonymizationKeyId !== metadata.pseudonymizationKeyId ||
      entry.settingsProfileDigest !== metadata.settingsProfileDigest ||
      entry.messageCreatedAt !== metadata.messageCreatedAt ||
      Date.parse(row.sample.observedAt) < Date.parse(first.since) ||
      Date.parse(row.sample.observedAt) >= Date.parse(first.until)
    )
      errors.push(`${name}_review_outside_frame`);
    if (entry && independent(row)) reviewed.add(entry.sourceSnapshotSha256!);
  }
  const missing = [...frame.keys()].filter((key) => !reviewed.has(key)).length;
  if (missing) errors.push(`${name}_independent_reviews_missing`);
  if (!frame.size) errors.push(`${name}_frame_empty`);
  return {
    complete: cursor === null && missing === 0 && frame.size > 0,
    selected: frame.size,
    missingIndependentReviews: missing,
  };
}

function captureFromItem(row: Item): ReviewedCapture {
  const metadata = row.sample.evidenceMetadata;
  return {
    captureKey: commercialAiQualityDigest(row.sample.id),
    sourceSnapshotSha256: metadata?.sourceSnapshotSha256 ?? null,
    metadata,
    llmEnforcement: row.sample.llmEnforcement ?? null,
    diagnosticResult: null,
    diagnosticStatus: 'NOT_OBSERVED',
    // FLAG: Hash the exact reviewed UTF-8 bytes; declared hashes alone cannot bind human text to AI input.
    reviewedTextExcerptSha256:
      row.sample.source === 'TEXT' &&
      row.sample.sourceExcerptComplete &&
      metadata?.sourceExcerptComplete === true
        ? createHash('sha256').update(row.sample.excerpt, 'utf8').digest('hex')
        : undefined,
  };
}

function sourceEvidenceValid(
  capture: ReviewedCapture,
  selectedPolicy: z.infer<typeof policy>,
  evaluatedAt: number,
  candidate?: CommercialAiQualityAttempt,
): boolean {
  const envelope = capture.llmEnforcement;
  const metadata = capture.metadata;
  const attempt = candidate ?? selectedAttempt(capture);
  if (
    envelope?.captureState !== 'OBSERVED' ||
    envelope.coverageIncomplete ||
    !metadata ||
    !attempt ||
    envelope.source.sourceSnapshotSha256 !== capture.sourceSnapshotSha256 ||
    envelope.source.sourceSnapshotSha256 !== metadata.sourceSnapshotSha256 ||
    envelope.source.logicalMessageKey !== metadata.logicalMessageKey ||
    envelope.source.messageCreatedAt !== metadata.messageCreatedAt ||
    !capture.reviewedTextExcerptSha256 ||
    attempt.inputSha256 !== capture.reviewedTextExcerptSha256 ||
    attempt.inputSha256 !== envelope.source.excerptSha256 ||
    attempt.settingsProfileDigest !== metadata.settingsProfileDigest ||
    attempt.activeAuthority !== 'AI_DELETE_ONLY' ||
    attempt.sourceVersion !== 2 ||
    attempt.deadlineAtMs !== attempt.eventAtMs + COMMERCIAL_LLM_EFFECT_MAX_AGE_MS ||
    attempt.classifierIdentitySha256 !== commercialLlmPoolEnforcementIdentity(selectedPolicy) ||
    attempt.submittedAtMs > evaluatedAt ||
    attempt.deadlineAtMs > evaluatedAt ||
    attempt.admission.state === 'NOT_OBSERVED'
  )
    return false;
  if (attempt.admission.state === 'ACCEPTED' && attempt.analysis.state === 'NOT_STARTED')
    return false;
  if (
    attempt.analysis.observedAt !== null &&
    (Date.parse(attempt.analysis.observedAt) > evaluatedAt ||
      Date.parse(attempt.analysis.observedAt) < attempt.submittedAtMs)
  )
    return false;
  if (
    attempt.analysis.state === 'COMPLETE' &&
    Date.parse(attempt.analysis.observedAt!) >= attempt.deadlineAtMs
  )
    return false;
  if (
    attempt.execution.observedAt !== null &&
    (Date.parse(attempt.execution.observedAt) > evaluatedAt ||
      Date.parse(attempt.execution.observedAt) < Date.parse(attempt.analysis.observedAt ?? ''))
  )
    return false;
  const result = attempt.analysis.result;
  return (
    result === null ||
    (resultIdentityValid(result) &&
      result.pool?.policy === selectedPolicy &&
      attempt.analysis.policyDeleteEligible === policyEligibility(attempt, selectedPolicy))
  );
}

function count(values: string[]) {
  const result: Record<string, number> = {};
  for (const value of values) result[value] = (result[value] ?? 0) + 1;
  return result;
}
function classificationOf(capture: CommercialAiQualityCapture): Classification | null {
  const attempt = selectedAttempt(capture);
  const result = attempt?.analysis.result ?? capture.diagnosticResult;
  return result && resultIdentityValid(result) ? result.classification : null;
}

// FLAG: Declared private evidence can be validated; this function cannot establish human truth.
// Diagnostic AI references, synthetic fixtures, missing frames and absent model results never certify a policy.
export function analyzeCommercialAiQualityEvidence(
  input: CommercialAiQualityEvidence,
  options: { now?: number } = {},
) {
  const parsed = commercialAiQualityEvidenceSchema.safeParse(input);
  if (!parsed.success) throw new Error('Commercial AI evidence schema is invalid');
  const bundle = parsed.data;
  const errors: string[] = [];
  const evaluatedAt = Date.parse(bundle.evaluatedAt);
  const now = options.now ?? Date.now();
  if (evaluatedAt > now) errors.push('evaluation_in_future');
  const development = readPages(bundle.development, 'development', errors);
  const holdout = readPages(bundle.holdout, 'holdout', errors);
  if (development.length + holdout.length + bundle.captures.length > 100_000)
    errors.push('record_limit_exceeded');
  const developmentFrame = reconcileFrame(
    bundle.developmentFrame,
    development,
    'development',
    errors,
    bundle.development[0]?.response,
  );
  const holdoutFrame = reconcileFrame(
    bundle.holdoutFrame,
    holdout,
    'holdout',
    errors,
    bundle.holdout[0]?.response,
  );
  const manifest = bundle.manifest;
  if (!manifest || bundle.manifestSha256 !== commercialAiQualityDigest(manifest))
    errors.push('frozen_manifest_missing_or_mismatched');
  if (manifest) {
    const identity = commercialAiQualityExpectedIdentity(manifest.policy);
    if (
      identity.classifierIdentitySha256 !== manifest.classifierIdentitySha256 ||
      identity.profilesSha256 !== manifest.profilesSha256
    )
      errors.push('stale_ai_identity');
    if (
      manifest.developmentFrameSha256 !== commercialAiQualityDigest(bundle.developmentFrame) ||
      manifest.holdoutFrameSha256 !== commercialAiQualityDigest(bundle.holdoutFrame)
    )
      errors.push('frozen_frame_digest_mismatch');
  }
  const frozenAt = Date.parse(manifest?.policyFrozenAt ?? '');
  if (!Number.isFinite(frozenAt) || frozenAt >= evaluatedAt) errors.push('policy_freeze_invalid');
  if (bundle.developmentFrame.some((entry) => Date.parse(entry.response.generatedAt) > frozenAt))
    errors.push('development_frame_after_freeze');
  const sourceTimes = (rows: Item[]) =>
    rows
      .filter((row) => row.sample.source === 'TEXT')
      .map((row) => Date.parse(row.sample.evidenceMetadata?.messageCreatedAt ?? ''));
  const devTimes = sourceTimes(development);
  const holdTimes = sourceTimes(holdout);
  const extrema = (times: number[]) =>
    times.reduce(
      (value, time) => ({ min: Math.min(value.min, time), max: Math.max(value.max, time) }),
      { min: Infinity, max: -Infinity },
    );
  const devSpan = extrema(devTimes);
  const holdSpan = extrema(holdTimes);
  const completeTimes = (times: number[]) => times.length > 0 && times.every(Number.isFinite);
  if (
    !completeTimes(devTimes) ||
    !Number.isFinite(frozenAt) ||
    devSpan.max > frozenAt ||
    devSpan.max - devSpan.min < 7 * DAY
  )
    errors.push('development_temporal_evidence_incomplete');
  if (
    !completeTimes(holdTimes) ||
    !Number.isFinite(frozenAt) ||
    holdSpan.min < frozenAt + DAY ||
    holdSpan.max - holdSpan.min < 7 * DAY
  )
    errors.push('holdout_temporal_evidence_incomplete');
  const allRows = [...development, ...holdout].filter((row) => row.sample.source === 'TEXT');
  if (allRows.some((row) => !independent(row)))
    errors.push('independent_human_review_evidence_missing');
  if (
    development.some((row) =>
      row.ratings.some((rating) => Date.parse(rating.reviewedAt) > frozenAt),
    )
  )
    errors.push('development_review_after_freeze');
  if (
    allRows.some(
      (row) =>
        Date.parse(row.sample.evidenceMetadata?.messageCreatedAt ?? '') > evaluatedAt ||
        row.ratings.some((rating) => Date.parse(rating.reviewedAt) > evaluatedAt),
    )
  )
    errors.push('source_or_review_after_evaluation');
  if (
    [
      ...bundle.development,
      ...bundle.holdout,
      ...bundle.developmentFrame,
      ...bundle.holdoutFrame,
    ].some((entry) => Date.parse(entry.response.generatedAt) > evaluatedAt)
  )
    errors.push('export_after_evaluation');
  const devGroups = new Set(development.flatMap(groupKeys));
  const devSources = new Set(
    development.flatMap((row) => [
      row.sample.evidenceMetadata?.logicalMessageKey,
      row.sample.evidenceMetadata?.sourceSnapshotSha256,
    ]),
  );
  const seenSources = new Set<string>();
  const devRevisions = development.map((row) => row.sample.evidenceMetadata?.sourceSnapshotSha256);
  if (new Set(devRevisions).size !== devRevisions.length)
    errors.push('duplicate_development_revision');
  for (const row of holdout) {
    const metadata = row.sample.evidenceMetadata;
    if (groupKeys(row).some((key) => devGroups.has(key))) errors.push('author_or_campaign_overlap');
    if (
      metadata &&
      [metadata.logicalMessageKey, metadata.sourceSnapshotSha256].some(
        (key) => !!key && devSources.has(key),
      )
    )
      errors.push('development_holdout_source_overlap');
    const key = metadata?.sourceSnapshotSha256;
    if (!key || seenSources.has(key)) errors.push('missing_or_duplicate_holdout_revision');
    if (key) seenSources.add(key);
  }
  const keys = new Set(allRows.map((row) => row.sample.evidenceMetadata?.pseudonymizationKeyId));
  if (keys.size !== 1 || keys.has(null) || keys.has(undefined))
    errors.push('pseudonym_key_missing_or_rotated');
  if (bundle.mode !== 'INDEPENDENT_REVIEW') errors.push('independent_review_mode_required');
  if (bundle.mode === 'INDEPENDENT_REVIEW' && bundle.aiReferences.length)
    errors.push('ai_references_are_not_independent_labels');
  const captures = bundle.captures.length ? bundle.captures : holdout.map(captureFromItem);
  if (new Set(captures.map((capture) => capture.captureKey)).size !== captures.length)
    errors.push('duplicate_capture_key');
  if (
    new Set(bundle.aiReferences.map((reference) => reference.captureKey)).size !==
    bundle.aiReferences.length
  )
    errors.push('duplicate_ai_reference');
  const attempts = captures.flatMap((capture) =>
    capture.llmEnforcement?.captureState === 'OBSERVED' ? capture.llmEnforcement.attempts : [],
  );
  const selected = captures.map(selectedAttempt);
  const strictCaptures = holdout.filter((row) => row.sample.source === 'TEXT').map(captureFromItem);
  const invalidStrictSources = strictCaptures.filter(
    (capture) => !manifest || !sourceEvidenceValid(capture, manifest.policy, evaluatedAt),
  ).length;
  if (invalidStrictSources || !strictCaptures.length)
    errors.push('source_bound_ai_evidence_incomplete');

  const parents = new Map<string, string>();
  const find = (key: string): string => {
    if (!parents.has(key)) parents.set(key, key);
    let root = key;
    while (parents.get(root) !== root) root = parents.get(root)!;
    let current = key;
    while (parents.get(current) !== root) {
      const next = parents.get(current)!;
      parents.set(current, root);
      current = next;
    }
    return root;
  };
  for (const row of holdout) {
    const group = groupKeys(row);
    for (const key of group.slice(1)) parents.set(find(key), find(group[0]!));
  }
  const units = new Map<
    string,
    { protected: boolean; unsafe: boolean; offer: boolean; missed: boolean }
  >();
  for (const row of holdout.filter(independent)) {
    const capture = captureFromItem(row);
    const attempt = selectedAttempt(capture);
    const allowed =
      !!manifest &&
      sourceEvidenceValid(capture, manifest.policy, evaluatedAt) &&
      attempt?.analysis.policyDeleteEligible === true;
    const key = find(groupKeys(row)[0]!);
    const unit = units.get(key) ?? { protected: false, unsafe: false, offer: false, missed: false };
    if (finalRating(row)?.expectedDisposition === 'KEEP') {
      unit.protected = true;
      unit.unsafe ||= allowed;
    } else {
      unit.offer = true;
      unit.missed ||= !allowed;
    }
    units.set(key, unit);
  }
  const protectedUnits = [...units.values()].filter((unit) => unit.protected);
  const offerUnits = [...units.values()].filter((unit) => unit.offer);
  const unsafe = protectedUnits.filter((unit) => unit.unsafe).length;
  const cleaned = offerUnits.filter((unit) => !unit.missed).length;
  const unsafeUpper95 = commercialWilson95(unsafe, protectedUnits.length)?.upper ?? null;
  const recallLower95 = commercialWilson95(cleaned, offerUnits.length)?.lower ?? null;
  const requiredProtectedCohorts = (manifest?.requiredProtectedCohorts ?? []).map((cohort) => {
    const grouped = new Map<string, boolean>();
    for (const row of holdout.filter(
      (row) =>
        independent(row) &&
        finalRating(row)?.expectedDisposition === 'KEEP' &&
        row.sample.requiredPolicyCohorts.includes(cohort),
    )) {
      const capture = captureFromItem(row);
      const allowed =
        !!manifest &&
        sourceEvidenceValid(capture, manifest.policy, evaluatedAt) &&
        selectedAttempt(capture)?.analysis.policyDeleteEligible === true;
      const key = find(groupKeys(row)[0]!);
      grouped.set(key, (grouped.get(key) ?? false) || allowed);
    }
    const unsafePermissions = [...grouped.values()].filter(Boolean).length;
    const upper95 = commercialWilson95(unsafePermissions, grouped.size)?.upper ?? null;
    return {
      cohort,
      protectedUnits: grouped.size,
      unsafePermissions,
      unsafePermissionUpper95: upper95,
      criteriaPass: grouped.size >= 4000 && upper95 !== null && upper95 <= 0.001,
    };
  });
  if (
    !requiredProtectedCohorts.length ||
    requiredProtectedCohorts.some((cohort) => !cohort.protectedUnits)
  )
    errors.push('required_protected_cohort_evidence_missing');
  const manifestIdentity = manifest ? commercialAiQualityExpectedIdentity(manifest.policy) : null;
  const validManifest =
    manifest !== null &&
    manifestIdentity !== null &&
    bundle.manifestSha256 === commercialAiQualityDigest(manifest) &&
    manifest.classifierIdentitySha256 === manifestIdentity.classifierIdentitySha256 &&
    manifest.profilesSha256 === manifestIdentity.profilesSha256;
  const boundAttempts = validManifest
    ? captures.flatMap((capture) =>
        capture.llmEnforcement?.captureState === 'OBSERVED'
          ? capture.llmEnforcement.attempts.filter((attempt) =>
              sourceEvidenceValid(capture, manifest!.policy, evaluatedAt, attempt),
            )
          : [],
      )
    : [];
  const boundAttemptSet = new Set(boundAttempts);
  const receipts = new Map<
    string,
    { bindings: Set<string>; states: Set<string>; observations: number }
  >();
  for (const capture of captures) {
    const envelope = capture.llmEnforcement;
    if (envelope?.captureState !== 'OBSERVED') continue;
    for (const attempt of envelope.attempts) {
      const receipt = attempt.execution.receiptSha256;
      if (!receipt || !boundAttemptSet.has(attempt)) continue;
      const entry = receipts.get(receipt) ?? {
        bindings: new Set<string>(),
        states: new Set<string>(),
        observations: 0,
      };
      entry.bindings.add(
        commercialAiQualityDigest({
          source: envelope.source,
          inputSha256: attempt.inputSha256,
          settingsProfileDigest: attempt.settingsProfileDigest,
          intentIdSha256: attempt.registration.intentIdSha256,
        }),
      );
      entry.states.add(attempt.execution.state);
      entry.observations += 1;
      receipts.set(receipt, entry);
    }
  }
  const conflictingReceipts = [...receipts.values()].filter(
    (entry) => entry.bindings.size !== 1 || entry.states.size !== 1,
  );
  if (conflictingReceipts.length) errors.push('conflicting_exact_receipt_binding');
  // FLAG: One exact physical receipt counts once; a conflicting source/state claim counts no effect.
  const unambiguousReceipts = [...receipts.values()].filter(
    (entry) => entry.bindings.size === 1 && entry.states.size === 1,
  );
  const provenanceErrors = [...new Set(errors)].sort();
  const evidenceSufficient =
    provenanceErrors.length === 0 && developmentFrame.complete && holdoutFrame.complete;
  const referenceMap = new Map(
    bundle.aiReferences.map((reference) => [reference.captureKey, reference.label]),
  );
  const independentlyReviewedSnapshots = new Set(
    allRows.filter(independent).map((row) => row.sample.evidenceMetadata!.sourceSnapshotSha256),
  );
  const confusion: Record<string, Record<string, number>> = {
    COMMERCIAL: {},
    PROTECTED: {},
    UNKNOWN: {},
  };
  if (bundle.mode === 'AI_REFERENCE')
    for (const capture of captures) {
      const label = referenceMap.get(capture.captureKey) ?? 'UNKNOWN';
      const prediction = classificationOf(capture) ?? 'NOT_OBSERVED_OR_INVALID';
      confusion[label]![prediction] = (confusion[label]![prediction] ?? 0) + 1;
    }
  const diagnosticResults = captures.filter((capture) => capture.diagnosticResult !== null);
  const validResults = captures
    .map((capture) => selectedAttempt(capture)?.analysis.result ?? capture.diagnosticResult)
    .filter(
      (result): result is CommercialAiQualityResult => !!result && resultIdentityValid(result),
    );
  const humanClassification: Record<string, Record<string, number>> = {
    COMMERCIAL: {},
    NOT_COMMERCIAL: {},
  };
  for (const row of holdout.filter(independent)) {
    const capture = captureFromItem(row);
    const label = finalRating(row)!.label;
    const predicted =
      manifest && sourceEvidenceValid(capture, manifest.policy, evaluatedAt)
        ? (classificationOf(capture) ?? 'NO_VALID_RESULT')
        : 'NO_VALID_RESULT';
    humanClassification[label]![predicted] = (humanClassification[label]![predicted] ?? 0) + 1;
  }
  return {
    schemaVersion: 'commercial-ai-quality-report/v1',
    inputSha256: commercialAiQualityDigest(bundle),
    mode: bundle.mode,
    evaluatedAt: bundle.evaluatedAt,
    scope: 'provided_private_captures_and_review_exports',
    populationCoverageAvailable: false,
    humanTruthEstablishedByTool: false,
    promotionAuthorized: false,
    evidenceSufficient,
    provenanceErrors,
    frames: { development: developmentFrame, holdout: holdoutFrame },
    coverage: {
      suppliedCaptures: captures.length,
      independentlyReviewedHoldoutRows: holdout.filter(independent).length,
      missingIndependentReviews: holdoutFrame.missingIndependentReviews,
      suppliedCapturesWithoutIndependentLabels: captures.filter(
        (capture) =>
          !capture.sourceSnapshotSha256 ||
          !independentlyReviewedSnapshots.has(capture.sourceSnapshotSha256),
      ).length,
      noAiObservation: captures.filter((capture) => !capture.llmEnforcement).length,
      invalidStoredObservation: captures.filter(
        (capture) => capture.llmEnforcement?.captureState === 'INVALID',
      ).length,
      incompleteObservation: captures.filter(
        (capture) => capture.llmEnforcement?.coverageIncomplete,
      ).length,
      sourceBoundEvidenceMissingOrInvalid: invalidStrictSources,
      selectedAttempts: selected.filter(Boolean).length,
      allObservedAttempts: attempts.length,
      admission: count(attempts.map((attempt) => attempt.admission.state)),
      admissionReasons: count(
        attempts.flatMap((attempt) => (attempt.admission.reason ? [attempt.admission.reason] : [])),
      ),
      analysis: count(attempts.map((attempt) => attempt.analysis.state)),
      analysisReasons: count(
        attempts.flatMap((attempt) => (attempt.analysis.reason ? [attempt.analysis.reason] : [])),
      ),
      policyAbstentions: attempts.filter(
        (attempt) => attempt.analysis.classificationOrigin === 'POLICY_ABSTENTION',
      ).length,
      policyDeleteEligible: selected.filter(
        (attempt) => attempt?.analysis.policyDeleteEligible === true,
      ).length,
      diagnosticOnlyModelResults: diagnosticResults.length,
      diagnosticStatus: count(captures.map((capture) => capture.diagnosticStatus)),
      diagnosticOutcome: count(
        captures.map((capture) => capture.diagnosticOutcome ?? 'NOT_RECORDED'),
      ),
      invalidResultIdentity: captures.filter((capture) => {
        const result = selectedAttempt(capture)?.analysis.result ?? capture.diagnosticResult;
        return !!result && !resultIdentityValid(result);
      }).length,
    },
    classification: {
      validFinalResultDistribution: count(validResults.map((result) => result.classification)),
      unsure: validResults.filter((result) => result.classification === 'UNSURE').length,
      missingOrInvalid: captures.length - validResults.length,
      identityCohorts: count(
        validResults.map((result) =>
          commercialAiQualityDigest({
            model: result.modelSha256,
            prompt: result.promptSha256,
            template: result.chatTemplateSha256,
            runtime: result.runtimeImageSha256 ?? result.runtimeArtifactSha256,
            support: result.runtimeSupportSha256,
            policy: result.policyVersion,
            route: result.pool?.route ?? result.cascade?.route ?? 'diagnostic',
          }),
        ),
      ),
    },
    aiReferenceDiagnostic: {
      evaluated: bundle.mode === 'AI_REFERENCE',
      labelSource: 'AI_REFERENCE',
      counts: bundle.mode === 'AI_REFERENCE' ? confusion : null,
      independentHumanEvidence: false,
      unknownLabelsAreFalsePositives: false,
      qualityCertification: false,
    },
    independentPolicyQuality: {
      evaluated: evidenceSufficient,
      protectedUnits: protectedUnits.length,
      offerUnits: offerUnits.length,
      unsafeDeletePermissions: unsafe,
      eligibleOfferUnits: cleaned,
      unsafePermissionUpper95: unsafeUpper95,
      offerEligibilityRecallLower95: recallLower95,
      criteriaVersion: 'commercial-ai-policy-quality/v1',
      requiredProtectedCohorts,
      criteriaPass:
        evidenceSufficient &&
        protectedUnits.length >= 4000 &&
        offerUnits.length >= 500 &&
        unsafeUpper95 !== null &&
        unsafeUpper95 <= 0.001 &&
        recallLower95 !== null &&
        recallLower95 >= 0.95 &&
        requiredProtectedCohorts.length > 0 &&
        requiredProtectedCohorts.every((cohort) => cohort.criteriaPass),
    },
    independentClassification: {
      evaluated: evidenceSufficient,
      finalClassificationCountsByDeclaredHumanLabel: humanClassification,
      rowCountsAreIndependentStatisticalUnits: false,
      semanticLabelAndExpectedDispositionAreSeparate: true,
    },
    effects: {
      attributionScope: 'recorded_exact_source_bound_receipts_only',
      registration: count(attempts.map((attempt) => attempt.registration.state)),
      execution: count(attempts.map((attempt) => attempt.execution.state)),
      confirmedDelete: unambiguousReceipts.filter((entry) => entry.states.has('CONFIRMED_DELETE'))
        .length,
      alreadyAbsent: unambiguousReceipts.filter((entry) => entry.states.has('ALREADY_ABSENT'))
        .length,
      rawBoundReceiptObservations: [...receipts.values()].reduce(
        (sum, entry) => sum + entry.observations,
        0,
      ),
      conflictingReceiptClaims: conflictingReceipts.reduce(
        (sum, entry) => sum + entry.observations,
        0,
      ),
      unboundReceiptClaims:
        attempts.filter((attempt) =>
          ['CONFIRMED_DELETE', 'ALREADY_ABSENT'].includes(attempt.execution.state),
        ).length -
        boundAttempts.filter((attempt) =>
          ['CONFIRMED_DELETE', 'ALREADY_ABSENT'].includes(attempt.execution.state),
        ).length,
      unknownOrPending: attempts.filter((attempt) =>
        ['PENDING', 'UNKNOWN'].includes(attempt.execution.state),
      ).length,
      diagnosticModelResultsProveDeletion: false,
    },
    deterministicReplayDiagnostic: {
      observations: captures.filter((capture) => capture.deterministicReplay).length,
      originalDeleteEligible: captures.filter(
        (capture) => capture.deterministicReplay?.original.deleteEligible,
      ).length,
      sanitizedDeleteEligible: captures.filter(
        (capture) => capture.deterministicReplay?.sanitized.deleteEligible,
      ).length,
      actualAiOrExecutedDeletion: false,
    },
  };
}
