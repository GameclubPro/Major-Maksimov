import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { Injectable } from '@nestjs/common';
import {
  COMMERCIAL_AI_QUALITY_MAX_ATTEMPTS,
  COMMERCIAL_AI_QUALITY_MAX_ENVELOPE_BYTES,
  commercialAiQualityAttemptSchema,
  commercialAiQualityEnvelopeSchema,
  type CommercialAiQualityAttempt,
  type CommercialAiQualityEnvelope,
} from '@maxim/contracts/commercial-ai-quality';
import {
  commercialReviewDecisionSnapshotSchema,
  commercialReviewEvidenceMetadataSchema,
} from '@maxim/contracts/safety-desk';
import { PrismaService } from '../../prisma/prisma.service';
import { Prisma, type CommercialReviewSample } from '../../prisma/prisma-client';
import {
  hasResidualCommercialContactCandidate,
  sanitizeCommercialCorpusText,
} from '../../scripts/commercial-corpus-sanitization.util';
import { commercialReviewEvidenceHash, type Candidate } from './commercial-review.service';
import { fingerprintCommercialDeleteText } from './commercial-delete-binding';
import {
  commercialLlmMayDelete,
  commercialLlmSourceCurrent,
  commercialLlmSourceKey,
  commercialLlmSourceSchema,
  type CommercialLlmRequest,
  type CommercialLlmSource,
} from './commercial-llm-enforcement.protocol';

export const COMMERCIAL_AI_OBSERVATION_TTL_MS = 14 * 86400_000;
const digest = /^[a-f0-9]{64}$/u;
const code = /^[a-z0-9_.:-]{1,120}$/iu;
const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), 'utf8');
type Transaction = Prisma.TransactionClient;
export type CommercialAiObservationWriteStatus =
  | 'written'
  | 'unchanged'
  | 'missing'
  | 'expired'
  | 'conflict'
  | 'overflow'
  | 'invalid'
  | 'unavailable';
export type CommercialAiObservationSeed = {
  candidate: Candidate;
  request: Pick<CommercialLlmRequest, 'source' | 'excerpt' | 'submittedAtMs'>;
  detectorBaseline: CommercialAiQualityAttempt['detectorBaseline'];
  actualSynchronousDecision: CommercialAiQualityAttempt['actualSynchronousDecision'];
  activeAuthority: CommercialAiQualityAttempt['activeAuthority'];
};
export type CommercialAiObservationUpdate = {
  source: CommercialLlmSource;
  inputSha256: string;
} & Partial<
  Pick<CommercialAiQualityAttempt, 'admission' | 'analysis' | 'registration' | 'execution'>
>;

// FLAG: This lookup groups exact source revisions across mirrors. Full origin and nonce
// remain in each attempt's exact sourceKey; lookup equality never grants effect authority.
export function commercialAiObservationEvidenceHash(source: CommercialLlmSource): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        'active-ai-capture/v1',
        source.version,
        source.chatId,
        source.messageId,
        source.userId,
        source.eventAtMs,
        source.sourceSha256,
        source.settingsSha256,
        source.classifierSha256,
      ]),
    )
    .digest('hex');
}
export function commercialAiObservationInputSha256(excerpt: string): string {
  return createHash('sha256').update(excerpt, 'utf8').digest('hex');
}

function prepareSeed(input: CommercialAiObservationSeed) {
  const source = commercialLlmSourceSchema.parse(input.request.source);
  const candidate = input.candidate;
  if (typeof candidate.text !== 'string' || candidate.text.length > 2500) return null;
  const excerpt = sanitizeCommercialCorpusText(candidate.text);
  const groups = candidate.campaignGroupIds;
  if (
    !commercialLlmSourceCurrent(source) ||
    candidate.source !== 'TEXT' ||
    candidate.chatId !== source.chatId ||
    candidate.messageId !== source.messageId ||
    candidate.userId !== source.userId ||
    fingerprintCommercialDeleteText(candidate.text) !== source.sourceSha256 ||
    candidate.sourceExcerptComplete !== true ||
    !excerpt.trim() ||
    excerpt.length > 2500 ||
    hasResidualCommercialContactCandidate(excerpt) ||
    excerpt !== input.request.excerpt ||
    !candidate.messageCreatedAt ||
    !Number.isFinite(new Date(candidate.messageCreatedAt).getTime()) ||
    ![
      candidate.logicalMessageKey,
      candidate.authorGroupId,
      candidate.campaignGroupId,
      candidate.sourceSnapshotSha256,
      candidate.pseudonymizationKeyId,
      candidate.settingsProfileDigest,
      candidate.detectorSourceSha256,
    ].every((value) => typeof value === 'string' && digest.test(value)) ||
    !groups?.length ||
    groups.length > 32 ||
    groups.some((value) => !digest.test(value)) ||
    new Set(groups).size !== groups.length ||
    !(candidate.samplingProbability! > 0 && candidate.samplingProbability! <= 1) ||
    !(
      candidate.evaluationSamplingProbability! > 0 && candidate.evaluationSamplingProbability! <= 1
    ) ||
    typeof candidate.randomEvaluationIncluded !== 'boolean' ||
    typeof candidate.campaignGroupingComplete !== 'boolean' ||
    !['HIT', 'REVIEW', 'NO_HIT', 'TECHNICAL'].includes(candidate.samplingStratum ?? '') ||
    !code.test(candidate.detectorVersion) ||
    !code.test(candidate.decisionFingerprint) ||
    !code.test(candidate.actionBand) ||
    !Number.isFinite(candidate.score) ||
    candidate.score < 0 ||
    candidate.score > 100 ||
    [...candidate.requiredPolicyCohorts, ...(candidate.reasons ?? [])].some(
      (value) => !code.test(value),
    ) ||
    candidate.requiredPolicyCohorts.length > 32 ||
    (candidate.reasons?.length ?? 0) > 32 ||
    (input.detectorBaseline !== null &&
      input.detectorBaseline.detectorSourceSha256 !== candidate.detectorSourceSha256)
  )
    return null;
  const snapshot = commercialReviewDecisionSnapshotSchema.safeParse(candidate.candidateDecision);
  const qualityMetadata = commercialReviewEvidenceMetadataSchema.parse({
    ...candidate,
    schemaVersion: 2,
    messageCreatedAt: new Date(candidate.messageCreatedAt).toISOString(),
    imageReviewRequired: false,
    hasDetection: candidate.hasDetection ?? null,
    decisionOutcome: candidate.decisionOutcome ?? null,
    deleteEligible: candidate.deleteEligible ?? null,
    executionOutcome: candidate.executionOutcome ?? 'UNKNOWN',
    analysisOutcome: candidate.analysisOutcome ?? 'UNKNOWN',
    candidateDecision: snapshot.success ? snapshot.data : null,
  });
  const evidenceHash = commercialAiObservationEvidenceHash(source);
  const inputSha256 = commercialAiObservationInputSha256(excerpt);
  const sourceBinding = {
    source: 'TEXT' as const,
    evidenceHash,
    logicalMessageKey: candidate.logicalMessageKey!,
    sourceSnapshotSha256: candidate.sourceSnapshotSha256!,
    excerptSha256: inputSha256,
    messageCreatedAt: qualityMetadata.messageCreatedAt!,
    sourceExcerptComplete: true as const,
  };
  const attempt = commercialAiQualityAttemptSchema.parse({
    sourceKey: commercialLlmSourceKey(source),
    inputSha256,
    nonce: source.nonce,
    sourceVersion: source.version,
    sourceSha256: source.sourceSha256,
    settingsSha256: source.settingsSha256,
    settingsProfileDigest: candidate.settingsProfileDigest,
    classifierIdentitySha256: source.classifierSha256,
    submittedAtMs: input.request.submittedAtMs,
    eventAtMs: source.eventAtMs,
    deadlineAtMs: source.deadlineAtMs,
    activeAuthority: input.activeAuthority,
    detectorBaseline: input.detectorBaseline,
    actualSynchronousDecision: input.actualSynchronousDecision,
    admission: { state: 'NOT_OBSERVED', reason: null },
    analysis: {
      state: 'NOT_STARTED',
      classificationOrigin: null,
      result: null,
      policyDeleteEligible: null,
      observedAt: null,
      reason: null,
    },
    registration: { state: 'NOT_REQUESTED', intentIdSha256: null, reason: null },
    execution: { state: 'NOT_REQUESTED', receiptSha256: null, observedAt: null },
  });
  const evidence = {
    source: 'TEXT',
    excerpt,
    score: candidate.score,
    actionBand: candidate.actionBand,
    messageDisposition: candidate.messageDisposition,
    requiredPolicyCohorts: [...candidate.requiredPolicyCohorts],
    detectorVersion: candidate.detectorVersion,
    decisionFingerprint: candidate.decisionFingerprint,
    reviewPriority: Number.isFinite(candidate.reviewPriority)
      ? Math.max(0, Math.min(100, Math.round(candidate.reviewPriority!)))
      : 50,
    reasons: [...(candidate.reasons ?? [])],
    label: null,
    reviewReason: '',
    reviewedAt: null,
    evidenceMetadata: qualityMetadata,
  };
  return {
    source,
    score: candidate.score,
    campaignGroupingComplete: candidate.campaignGroupingComplete,
    evidenceHash,
    humanReviewEvidenceHash: commercialReviewEvidenceHash(candidate),
    inputSha256,
    sourceBinding,
    attempt,
    evidence,
    qualityMetadata,
  };
}

function incomplete(attempt: CommercialAiQualityAttempt): boolean {
  return (
    attempt.detectorBaseline === null ||
    attempt.actualSynchronousDecision.decision === null ||
    attempt.activeAuthority === 'UNKNOWN'
  );
}
function bound(
  row: CommercialReviewSample,
  source: CommercialLlmSource,
  envelope: CommercialAiQualityEnvelope,
): boolean {
  const metadata = commercialReviewEvidenceMetadataSchema.safeParse(row.qualityMetadata);
  const excerpt = object(row.evidence).excerpt;
  return (
    row.source === 'TEXT' &&
    row.chatId === source.chatId &&
    row.userId === source.userId &&
    row.messageId === source.messageId &&
    row.evidenceHash === commercialAiObservationEvidenceHash(source) &&
    envelope.source.evidenceHash === row.evidenceHash &&
    metadata.success &&
    metadata.data.logicalMessageKey === envelope.source.logicalMessageKey &&
    metadata.data.sourceSnapshotSha256 === envelope.source.sourceSnapshotSha256 &&
    metadata.data.messageCreatedAt === envelope.source.messageCreatedAt &&
    metadata.data.sourceExcerptComplete === true &&
    metadata.data.imageReviewRequired === false &&
    typeof excerpt === 'string' &&
    commercialAiObservationInputSha256(excerpt) === envelope.source.excerptSha256 &&
    envelope.attempts.every(
      (attempt) =>
        attempt.inputSha256 === envelope.source.excerptSha256 &&
        attempt.settingsProfileDigest === metadata.data.settingsProfileDigest,
    )
  );
}
function sameAttempt(
  attempt: CommercialAiQualityAttempt,
  source: CommercialLlmSource,
  inputSha256: string,
): boolean {
  return (
    attempt.sourceKey === commercialLlmSourceKey(source) &&
    attempt.inputSha256 === inputSha256 &&
    attempt.nonce === source.nonce &&
    attempt.sourceVersion === source.version &&
    attempt.sourceSha256 === source.sourceSha256 &&
    attempt.settingsSha256 === source.settingsSha256 &&
    attempt.classifierIdentitySha256 === source.classifierSha256 &&
    attempt.eventAtMs === source.eventAtMs &&
    attempt.deadlineAtMs === source.deadlineAtMs
  );
}
function mergeAttempt(
  current: CommercialAiQualityAttempt,
  patch: CommercialAiObservationUpdate,
): CommercialAiQualityAttempt | null {
  const next = { ...current };
  const accepted = patch.analysis?.state !== undefined && patch.analysis.state !== 'NOT_STARTED';
  if (patch.admission) {
    if (current.admission.state === 'NOT_OBSERVED' || patch.admission.state === 'ACCEPTED')
      next.admission = patch.admission;
  }
  // FLAG: An actual runner result proves admission for this pre-seeded source only.
  // A late producer admission write cannot downgrade accepted or completed observations.
  if (accepted) next.admission = { state: 'ACCEPTED', reason: null };
  if (patch.analysis) {
    if (
      current.analysis.state === 'NOT_STARTED' ||
      (patch.analysis.state === 'COMPLETE' && current.analysis.state !== 'COMPLETE')
    )
      next.analysis = patch.analysis;
    else if (
      patch.analysis.state === current.analysis.state &&
      !isDeepStrictEqual(
        { ...patch.analysis, observedAt: current.analysis.observedAt },
        current.analysis,
      )
    )
      return null;
  }
  if (patch.registration) {
    const rank = { NOT_REQUESTED: 0, UNKNOWN: 1, REJECTED: 2, REGISTERED: 3 };
    if (rank[patch.registration.state] > rank[current.registration.state])
      next.registration = patch.registration;
    else if (
      patch.registration.state === 'REGISTERED' &&
      !isDeepStrictEqual(patch.registration, current.registration)
    )
      return null;
  }
  if (patch.execution) {
    const rank = {
      NOT_REQUESTED: 0,
      UNKNOWN: 1,
      PENDING: 2,
      GUARD_REJECTED: 3,
      CONFIRMED_DELETE: 4,
      ALREADY_ABSENT: 4,
    };
    const terminal = rank[current.execution.state] === 4;
    if (rank[patch.execution.state] > rank[current.execution.state])
      next.execution = patch.execution;
    else if (
      terminal &&
      ['CONFIRMED_DELETE', 'ALREADY_ABSENT'].includes(patch.execution.state) &&
      !isDeepStrictEqual(
        { ...patch.execution, observedAt: current.execution.observedAt },
        current.execution,
      )
    )
      return null;
  }
  return next;
}

@Injectable()
export class CommercialAiObservationService {
  constructor(private readonly prisma: PrismaService) {}

  // FLAG: Only the producer seeds sampled, original evidence before an admission outcome.
  // Results never create a row/attempt, renew retention or alter labels/baselines.
  async seed(input: CommercialAiObservationSeed): Promise<CommercialAiObservationWriteStatus> {
    let prepared: ReturnType<typeof prepareSeed>;
    try {
      prepared = prepareSeed(input);
    } catch {
      return 'invalid';
    }
    if (!prepared) return 'invalid';
    const seed = prepared;
    try {
      return await this.transaction<CommercialAiObservationWriteStatus>(async (tx) => {
        const now = new Date();
        const envelope: CommercialAiQualityEnvelope = commercialAiQualityEnvelopeSchema.parse({
          schemaVersion: 1,
          captureState: 'OBSERVED',
          source: seed.sourceBinding,
          attempts: [seed.attempt],
          overflowWriteCount: 0,
          lastOverflowAt: null,
          coverageIncomplete: incomplete(seed.attempt) || seed.campaignGroupingComplete !== true,
        });
        // The unique index serializes concurrent first seeds, without a read/create race.
        const inserted = await tx.$executeRaw`
          INSERT INTO commercial_review_samples
            (id,chat_id,user_id,message_id,source,evidence_hash,score,evidence,quality_metadata,
             llm_enforcement,human_review_evidence_hash,review_priority,observed_at,expires_at,updated_at)
          VALUES (${randomUUID()},${seed.source.chatId},${seed.source.userId},${seed.source.messageId},
            'TEXT',${seed.evidenceHash},${seed.score / 100},${JSON.stringify(seed.evidence)}::jsonb,
            ${JSON.stringify(seed.qualityMetadata)}::jsonb,${JSON.stringify(envelope)}::jsonb,
            ${seed.humanReviewEvidenceHash},
            ${seed.evidence.reviewPriority},${now},${new Date(now.getTime() + COMMERCIAL_AI_OBSERVATION_TTL_MS)},${now})
          ON CONFLICT (evidence_hash) DO NOTHING`;
        if (inserted === 1) return 'written';
        const row = await this.locked(tx, seed.evidenceHash);
        if (!row) return 'missing';
        if (row.expiresAt.getTime() <= Date.now()) return 'expired';
        const parsed = commercialAiQualityEnvelopeSchema.safeParse(row.llmEnforcement);
        if (!parsed.success) return 'invalid';
        if (
          !bound(row, seed.source, parsed.data) ||
          !isDeepStrictEqual(parsed.data.source, seed.sourceBinding) ||
          !isDeepStrictEqual(row.qualityMetadata, seed.qualityMetadata)
        )
          return 'conflict';
        const previousEvidence = object(row.evidence);
        if (
          Object.entries(seed.evidence).some(
            ([key, value]) =>
              !['label', 'reviewReason', 'reviewedAt', 'evidenceMetadata'].includes(key) &&
              !isDeepStrictEqual(previousEvidence[key], value),
          )
        )
          return 'conflict';
        const existing = parsed.data.attempts.find(
          (attempt) => attempt.sourceKey === seed.attempt.sourceKey,
        );
        if (existing) {
          return sameAttempt(existing, seed.source, seed.inputSha256) &&
            existing.submittedAtMs === seed.attempt.submittedAtMs &&
            existing.settingsProfileDigest === seed.attempt.settingsProfileDigest &&
            existing.activeAuthority === seed.attempt.activeAuthority &&
            isDeepStrictEqual(existing.detectorBaseline, seed.attempt.detectorBaseline) &&
            isDeepStrictEqual(
              existing.actualSynchronousDecision,
              seed.attempt.actualSynchronousDecision,
            )
            ? 'unchanged'
            : 'conflict';
        }
        if (parsed.data.attempts.length >= COMMERCIAL_AI_QUALITY_MAX_ATTEMPTS)
          return this.overflow(tx, row, parsed.data);
        const next = {
          ...parsed.data,
          attempts: [...parsed.data.attempts, seed.attempt],
          coverageIncomplete: parsed.data.coverageIncomplete || incomplete(seed.attempt),
        };
        if (bytes(next) > COMMERCIAL_AI_QUALITY_MAX_ENVELOPE_BYTES - 512)
          return this.overflow(tx, row, parsed.data);
        return (await this.write(tx, row, commercialAiQualityEnvelopeSchema.parse(next)))
          ? 'written'
          : 'expired';
      });
    } catch {
      return 'unavailable';
    }
  }

  async update(input: CommercialAiObservationUpdate): Promise<CommercialAiObservationWriteStatus> {
    const parsedSource = commercialLlmSourceSchema.safeParse(input.source);
    if (
      !parsedSource.success ||
      !digest.test(input.inputSha256) ||
      input.analysis?.state === 'EXPIRED_WITHOUT_RESULT'
    )
      return 'invalid';
    const source = parsedSource.data;
    try {
      return await this.transaction<CommercialAiObservationWriteStatus>(async (tx) => {
        const row = await this.locked(tx, commercialAiObservationEvidenceHash(source));
        if (!row) return 'missing';
        if (row.expiresAt.getTime() <= Date.now()) return 'expired';
        const parsed = commercialAiQualityEnvelopeSchema.safeParse(row.llmEnforcement);
        if (!parsed.success) return 'invalid';
        if (!bound(row, source, parsed.data)) return 'conflict';
        const index = parsed.data.attempts.findIndex((attempt) =>
          sameAttempt(attempt, source, input.inputSha256),
        );
        if (index < 0) return 'missing';
        const attempt = mergeAttempt(parsed.data.attempts[index]!, input);
        if (!attempt) return 'conflict';
        const valid = commercialAiQualityAttemptSchema.safeParse(attempt);
        if (!valid.success) return 'invalid';
        if (
          valid.data.analysis.result &&
          valid.data.analysis.policyDeleteEligible !==
            commercialLlmMayDelete(valid.data.analysis.result, source)
        )
          return 'conflict';
        const next = { ...parsed.data, attempts: [...parsed.data.attempts] };
        next.attempts[index] = valid.data;
        if (isDeepStrictEqual(next, parsed.data)) return 'unchanged';
        if (bytes(next) > COMMERCIAL_AI_QUALITY_MAX_ENVELOPE_BYTES - 512)
          return this.overflow(tx, row, parsed.data);
        return (await this.write(tx, row, commercialAiQualityEnvelopeSchema.parse(next)))
          ? 'written'
          : 'expired';
      });
    } catch {
      return 'unavailable';
    }
  }

  private transaction<T>(work: (tx: Transaction) => Promise<T>): Promise<T> {
    return this.prisma.$transaction(
      async (tx) => {
        await tx.$executeRawUnsafe("SET LOCAL lock_timeout = '50ms'");
        await tx.$executeRawUnsafe("SET LOCAL statement_timeout = '500ms'");
        return work(tx);
      },
      { maxWait: 100, timeout: 1500 },
    );
  }

  private async locked(
    tx: Transaction,
    evidenceHash: string,
  ): Promise<CommercialReviewSample | null> {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM commercial_review_samples WHERE evidence_hash = ${evidenceHash} FOR UPDATE`;
    return rows[0] ? tx.commercialReviewSample.findUnique({ where: { id: rows[0].id } }) : null;
  }

  private write(
    tx: Transaction,
    row: CommercialReviewSample,
    next: CommercialAiQualityEnvelope,
  ): Promise<number> {
    // FLAG: The locked indexed row and exact JSON CAS preserve concurrent reviews/shadow.
    // Only this column changes; DB clock checks expiry after the lock and never renews it.
    return tx.$executeRaw`
      UPDATE commercial_review_samples SET llm_enforcement = ${JSON.stringify(next)}::jsonb
      WHERE id = ${row.id} AND expires_at > clock_timestamp()
        AND llm_enforcement IS NOT DISTINCT FROM ${JSON.stringify(row.llmEnforcement)}::jsonb`;
  }

  private async overflow(
    tx: Transaction,
    row: CommercialReviewSample,
    envelope: CommercialAiQualityEnvelope,
  ): Promise<CommercialAiObservationWriteStatus> {
    const next = commercialAiQualityEnvelopeSchema.safeParse({
      ...envelope,
      overflowWriteCount: Math.min(2_147_483_647, envelope.overflowWriteCount + 1),
      lastOverflowAt: new Date().toISOString(),
      coverageIncomplete: true,
    });
    if (!next.success) return 'invalid';
    return (await this.write(tx, row, next.data)) ? 'overflow' : 'expired';
  }
}
