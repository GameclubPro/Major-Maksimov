import { createHash } from 'node:crypto';
import {
  commercialReviewDecisionRequestSchema,
  commercialReviewSemanticAnnotationSchema,
  resolveCommercialSemanticReview,
  resolveCommercialLabelAuthority,
  commercialReviewDecisionSnapshotSchema,
  commercialReviewEvidenceMetadataSchema,
  commercialReviewExportQuerySchema,
  commercialReviewItemSchema,
  commercialReviewQueueQuerySchema,
  commercialReviewSamplingFrameQuerySchema,
  type CommercialReviewEvidenceMetadata,
  type CommercialReviewExportResponse,
  type CommercialReviewItem,
  type CommercialReviewLabel,
  type CommercialReviewQueueResponse,
  type CommercialReviewSamplingFrameResponse,
} from '@maxim/contracts/safety-desk';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { Prisma } from '../../prisma/prisma-client';
import {
  sanitizeCommercialCorpusText,
  hasResidualCommercialContactCandidate,
} from '../../scripts/commercial-corpus-sanitization.util';
import { COMMERCIAL_INTENT_QUALITY_DECISION_VERSION } from './commercial-policy-cohorts';
import {
  COMMERCIAL_AI_QUALITY_MAX_ENVELOPE_BYTES,
  commercialAiReviewExportQuerySchema,
  type CommercialAiReviewExportResponse,
} from '@maxim/contracts/commercial-ai-quality';
import {
  projectCommercialAiReviewedExport,
  type CommercialAiReviewedExportRow,
} from './commercial-ai-reviewed-export';

const REVIEW_TTL_DAYS = 14;
export type Candidate = {
  chatId: string;
  userId: string;
  messageId: string;
  // FLAG: For OCR this is the original caption only, never recognized image text.
  text: string;
  score: number;
  actionBand: string;
  source: 'TEXT' | 'OCR';
  decisionFingerprint: string;
  detectorVersion: string;
  messageDisposition: 'KEEP' | 'DELETE';
  requiredPolicyCohorts: readonly string[];
  reviewPriority?: number;
  reasons?: readonly string[];
  samplingProbability?: number;
  randomEvaluationIncluded?: boolean;
  evaluationSamplingProbability?: number;
  samplingStratum?: 'HIT' | 'REVIEW' | 'NO_HIT' | 'TECHNICAL';
  logicalMessageKey?: string;
  authorGroupId?: string;
  campaignGroupId?: string;
  campaignGroupIds?: readonly string[];
  campaignGroupingComplete?: boolean;
  sourceSnapshotSha256?: string;
  pseudonymizationKeyId?: string;
  imageReviewRequired?: boolean;
  sourceExcerptComplete?: boolean;
  messageCreatedAt?: string | Date;
  settingsProfileDigest?: string;
  detectorSourceSha256?: string;
  hasDetection?: boolean;
  decisionOutcome?: 'KEEP' | 'DELETE' | null;
  deleteEligible?: boolean | null;
  executionOutcome?: CommercialReviewEvidenceMetadata['executionOutcome'];
  analysisOutcome?: Exclude<CommercialReviewEvidenceMetadata['analysisOutcome'], 'UNKNOWN'>;
  candidateDecision?: unknown;
};
type ReviewRow = Prisma.CommercialReviewSampleGetPayload<{
  include: { chat: { select: { title: true } }; ratings: true };
}>;
type ReviewRating = ReviewRow['ratings'][number];

export type CommercialReviewExecutionBinding = {
  schemaVersion: 1;
  evidenceHash: string;
  source: 'TEXT';
  sourceSnapshotSha256: string;
  detectorSourceSha256: string;
  detectorVersion: string;
};

export function commercialReviewEvidenceHash(input: Candidate): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        input.chatId,
        input.messageId,
        input.source,
        digest(input.logicalMessageKey),
        digest(input.sourceSnapshotSha256) ?? createHash('sha256').update(input.text).digest('hex'),
        input.detectorVersion,
        digest(input.detectorSourceSha256),
      ]),
    )
    .digest('hex');
}

export function buildCommercialReviewExecutionBinding(
  input: Candidate,
): CommercialReviewExecutionBinding | null {
  const sourceSnapshotSha256 = digest(input.sourceSnapshotSha256);
  const detectorSourceSha256 = digest(input.detectorSourceSha256);
  if (
    input.source !== 'TEXT' ||
    !sourceSnapshotSha256 ||
    !detectorSourceSha256 ||
    !/^[a-z0-9_.:-]{1,120}$/iu.test(input.detectorVersion)
  )
    return null;
  return {
    schemaVersion: 1,
    evidenceHash: commercialReviewEvidenceHash(input),
    source: 'TEXT',
    sourceSnapshotSha256,
    detectorSourceSha256,
    detectorVersion: input.detectorVersion,
  };
}

export function readCommercialReviewExecutionBinding(
  value: unknown,
): CommercialReviewExecutionBinding | null {
  const binding = object(object(value).commercialReviewBinding);
  if (
    binding.schemaVersion !== 1 ||
    binding.source !== 'TEXT' ||
    typeof binding.detectorVersion !== 'string' ||
    !/^[a-z0-9_.:-]{1,120}$/iu.test(binding.detectorVersion) ||
    !digest(typeof binding.evidenceHash === 'string' ? binding.evidenceHash : undefined) ||
    !digest(
      typeof binding.sourceSnapshotSha256 === 'string' ? binding.sourceSnapshotSha256 : undefined,
    ) ||
    !digest(
      typeof binding.detectorSourceSha256 === 'string' ? binding.detectorSourceSha256 : undefined,
    )
  )
    return null;
  return {
    schemaVersion: 1,
    source: 'TEXT',
    evidenceHash: binding.evidenceHash as string,
    sourceSnapshotSha256: binding.sourceSnapshotSha256 as string,
    detectorSourceSha256: binding.detectorSourceSha256 as string,
    detectorVersion: binding.detectorVersion,
  };
}

function boundedCodes(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => /^[a-z0-9_.:-]{1,120}$/iu.test(value)))].slice(0, 32);
}
function digest(value: string | undefined): string | null {
  return value && /^[a-f0-9]{64}$/u.test(value) ? value : null;
}
function redact(value: string, limit: number): string {
  const sanitized = sanitizeCommercialCorpusText(value);
  return hasResidualCommercialContactCandidate(sanitized)
    ? '[контактные данные скрыты]'
    : sanitized.slice(0, limit).replace(/[\uD800-\uDBFF]$/u, '');
}
function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function metadata(value: unknown): CommercialReviewEvidenceMetadata | null {
  const parsed = commercialReviewEvidenceMetadataSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
function reviewerKey(actor: string | null): { actor: string; key: string } {
  if (
    typeof actor !== 'string' ||
    !actor.trim() ||
    actor.trim().length > 200 ||
    /\p{Cc}/u.test(actor)
  )
    throw new ForbiddenException(
      'Для независимой оценки нужна отдельная учётная запись проверяющего.',
    );
  const normalized = actor.trim();
  return {
    actor: normalized,
    key: createHash('sha256').update(`commercial-reviewer-v1\0${normalized}`).digest('hex'),
  };
}
function makeMetadata(input: Candidate): CommercialReviewEvidenceMetadata {
  const sourceDate = input.messageCreatedAt ? new Date(input.messageCreatedAt) : null;
  const rawSnapshot = object(input.candidateDecision);
  const snapshot = commercialReviewDecisionSnapshotSchema.safeParse({
    hasDetection: rawSnapshot.hasDetection ?? null,
    actionable: rawSnapshot.actionable ?? null,
    deleteEligible: rawSnapshot.deleteEligible ?? null,
    score: rawSnapshot.score,
    actionBand:
      typeof rawSnapshot.actionBand === 'string'
        ? boundedCodes([rawSnapshot.actionBand])[0]
        : undefined,
    messageDisposition: rawSnapshot.messageDisposition,
    detectorVersion:
      typeof rawSnapshot.detectorVersion === 'string'
        ? boundedCodes([rawSnapshot.detectorVersion])[0]
        : undefined,
    decisionFingerprint:
      typeof rawSnapshot.decisionFingerprint === 'string'
        ? boundedCodes([rawSnapshot.decisionFingerprint])[0]
        : undefined,
    reasons: Array.isArray(rawSnapshot.reasons)
      ? boundedCodes(
          rawSnapshot.reasons.filter((value): value is string => typeof value === 'string'),
        )
      : [],
    requiredPolicyCohorts: Array.isArray(rawSnapshot.requiredPolicyCohorts)
      ? boundedCodes(
          rawSnapshot.requiredPolicyCohorts.filter(
            (value): value is string => typeof value === 'string',
          ),
        )
      : [],
  });
  return commercialReviewEvidenceMetadataSchema.parse({
    schemaVersion: 2,
    samplingProbability:
      Number.isFinite(input.samplingProbability) &&
      input.samplingProbability! >= 0 &&
      input.samplingProbability! <= 1
        ? input.samplingProbability
        : null,
    samplingStratum: input.samplingStratum ?? 'UNKNOWN',
    randomEvaluationIncluded: input.randomEvaluationIncluded ?? null,
    evaluationSamplingProbability:
      Number.isFinite(input.evaluationSamplingProbability) &&
      input.evaluationSamplingProbability! >= 0 &&
      input.evaluationSamplingProbability! <= 1
        ? input.evaluationSamplingProbability
        : null,
    logicalMessageKey: digest(input.logicalMessageKey),
    authorGroupId: digest(input.authorGroupId),
    campaignGroupId: digest(input.campaignGroupId),
    campaignGroupIds: [
      ...new Set(
        (input.campaignGroupIds ?? [])
          .map(digest)
          .filter((value): value is string => value !== null),
      ),
    ].slice(0, 32),
    campaignGroupingComplete: input.campaignGroupingComplete ?? null,
    sourceSnapshotSha256: digest(input.sourceSnapshotSha256),
    pseudonymizationKeyId: digest(input.pseudonymizationKeyId),
    imageReviewRequired: input.source === 'OCR' || input.imageReviewRequired === true,
    sourceExcerptComplete:
      input.sourceExcerptComplete === false ||
      sanitizeCommercialCorpusText(input.text).length > 2500 ||
      hasResidualCommercialContactCandidate(sanitizeCommercialCorpusText(input.text))
        ? false
        : (input.sourceExcerptComplete ?? null),
    messageCreatedAt:
      sourceDate && Number.isFinite(sourceDate.getTime()) ? sourceDate.toISOString() : null,
    settingsProfileDigest: digest(input.settingsProfileDigest),
    detectorSourceSha256: digest(input.detectorSourceSha256),
    hasDetection: input.hasDetection ?? null,
    decisionOutcome: input.decisionOutcome ?? null,
    deleteEligible: input.deleteEligible ?? null,
    executionOutcome: input.executionOutcome ?? 'UNKNOWN',
    analysisOutcome: input.analysisOutcome ?? 'UNKNOWN',
    candidateDecision: snapshot.success ? snapshot.data : null,
  });
}
function mergeMetadata(
  previous: CommercialReviewEvidenceMetadata,
  incoming: CommercialReviewEvidenceMetadata,
): CommercialReviewEvidenceMetadata {
  const finalExecution = ['CONFIRMED_DELETE', 'ALREADY_ABSENT', 'NOT_REQUESTED'].includes(
    previous.executionOutcome,
  );
  return {
    ...previous,
    decisionOutcome: incoming.decisionOutcome ?? previous.decisionOutcome,
    deleteEligible: incoming.deleteEligible ?? previous.deleteEligible,
    hasDetection: incoming.hasDetection ?? previous.hasDetection,
    executionOutcome:
      incoming.executionOutcome === 'UNKNOWN' ||
      (finalExecution && incoming.executionOutcome !== 'CONFIRMED_DELETE')
        ? previous.executionOutcome
        : incoming.executionOutcome,
    analysisOutcome:
      previous.analysisOutcome === 'COMPLETE' || incoming.analysisOutcome === 'UNKNOWN'
        ? previous.analysisOutcome
        : incoming.analysisOutcome,
    candidateDecision: incoming.candidateDecision ?? previous.candidateDecision,
  };
}

function semanticBinding(row: Pick<ReviewRow, 'source' | 'qualityMetadata' | 'evidence'>) {
  const evidence = object(row.evidence);
  const quality = metadata(row.qualityMetadata) ?? metadata(evidence.evidenceMetadata);
  if (
    row.source !== 'TEXT' ||
    quality?.sourceExcerptComplete !== true ||
    !quality.sourceSnapshotSha256 ||
    typeof evidence.excerpt !== 'string'
  )
    return null;
  return {
    sourceSnapshotSha256: quality.sourceSnapshotSha256,
    excerptSha256: createHash('sha256')
      .update(redact(evidence.excerpt, 2500), 'utf8')
      .digest('hex'),
  };
}
function semanticDisagreement(row: ReviewRow): boolean {
  const binding = semanticBinding(row);
  return (
    binding !== null &&
    resolveCommercialSemanticReview(row.ratings, binding).state === 'DISAGREEMENT'
  );
}
function annotation(value: unknown) {
  const parsed = commercialReviewSemanticAnnotationSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function confirmedFalseDeletionStop(
  row: Pick<ReviewRow, 'source' | 'evidence' | 'reviewState' | 'independentLabel' | 'ratings'>,
  quality: CommercialReviewEvidenceMetadata | null,
): { detectorSourceSha256: string; decisionVersion: string } | null {
  // FLAG: Only the actual experimental execution plus a resolved independent KEEP label revokes it.
  // Shadow candidates, legacy labels, unsure votes and incomplete source evidence cannot trigger a stop.
  if (
    row.reviewState !== 'RESOLVED' ||
    row.independentLabel === null ||
    row.independentLabel === 'UNSURE' ||
    quality?.executionOutcome !== 'CONFIRMED_DELETE' ||
    !quality.detectorSourceSha256 ||
    object(row.evidence).detectorVersion !== COMMERCIAL_INTENT_QUALITY_DECISION_VERSION
  )
    return null;
  const independent = row.ratings.filter((rating) => rating.kind === 'INDEPENDENT');
  const { finalRating: final } = resolveCommercialLabelAuthority(row.ratings);
  if (
    independent.length !== 2 ||
    final?.label !== row.independentLabel ||
    final.expectedDisposition !== 'KEEP' ||
    (!row.ratings.some((rating) => rating.kind === 'ADJUDICATION') &&
      !independent.every(
        (rating) => rating.label === final.label && rating.expectedDisposition === 'KEEP',
      )) ||
    !row.ratings.every((rating) =>
      row.source === 'OCR'
        ? rating.evidenceKind === 'PRIVATE_SOURCE_IMAGE' &&
          digest(rating.sourceEvidenceDigest ?? undefined) !== null
        : rating.evidenceKind === 'TEXT' && quality.sourceExcerptComplete === true,
    )
  )
    return null;
  return {
    detectorSourceSha256: quality.detectorSourceSha256,
    decisionVersion: COMMERCIAL_INTENT_QUALITY_DECISION_VERSION,
  };
}

async function persistPolicyStop(
  tx: Pick<Prisma.TransactionClient, 'commercialQualityPolicyStop'>,
  stop: { detectorSourceSha256: string; decisionVersion: string } | null,
): Promise<void> {
  if (!stop) return;
  await tx.commercialQualityPolicyStop.upsert({
    where: { detectorSourceSha256_decisionVersion: stop },
    create: stop,
    update: {},
  });
}

@Injectable()
export class CommercialReviewService {
  private readonly logger = new Logger(CommercialReviewService.name);
  constructor(private readonly prisma: PrismaService) {}

  // FLAG: Feedback samples never enter reputation aggregation or change sanctions.
  // Capture is best-effort; neither persistence failures nor review labels authorize a MAX call.
  async recordCandidate(input: Candidate): Promise<void> {
    try {
      if (!input.chatId || !input.userId || !input.messageId) return;
      const now = new Date();
      const qualityMetadata = makeMetadata(input);
      const evidence = {
        source: input.source,
        excerpt: redact(input.text, 2500),
        score: Number.isFinite(input.score) ? Math.max(0, Math.min(100, input.score)) : 0,
        actionBand: boundedCodes([input.actionBand])[0] ?? 'UNKNOWN',
        messageDisposition: input.messageDisposition,
        requiredPolicyCohorts: boundedCodes(input.requiredPolicyCohorts),
        detectorVersion: boundedCodes([input.detectorVersion])[0] ?? 'unknown',
        decisionFingerprint: boundedCodes([input.decisionFingerprint])[0] ?? 'unknown',
        reviewPriority: Number.isFinite(input.reviewPriority)
          ? Math.max(0, Math.min(100, Math.round(input.reviewPriority!)))
          : input.messageDisposition === 'DELETE'
            ? 90
            : 50,
        reasons: boundedCodes(input.reasons ?? []),
        label: null,
        reviewReason: '',
        reviewedAt: null,
        evidenceMetadata: qualityMetadata,
      };
      // FLAG: Decisions and execution receipts are outcomes, never part of logical sample identity.
      const evidenceHash = commercialReviewEvidenceHash(input);
      const row = await this.prisma.commercialReviewSample
        .upsert({
          where: { evidenceHash },
          create: {
            userId: input.userId,
            chatId: input.chatId,
            messageId: input.messageId,
            source: input.source,
            score: evidence.score / 100,
            evidenceHash,
            evidence: evidence as Prisma.InputJsonValue,
            qualityMetadata: qualityMetadata as Prisma.InputJsonValue,
            reviewPriority: evidence.reviewPriority,
            observedAt: now,
            expiresAt: new Date(now.getTime() + REVIEW_TTL_DAYS * 86400_000),
          },
          update: {},
          include: { ratings: true },
        })
        .catch(async (error: unknown) => {
          // FLAG: A concurrent insert may win Prisma's read/create upsert. Recover only
          // its exact evidence row, then merge through the existing revision/expiry fence.
          if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002')
            throw error;
          const winner = await this.prisma.commercialReviewSample.findUnique({
            where: { evidenceHash },
            include: { ratings: true },
          });
          if (!winner) throw error;
          return winner;
        });
      // Retries/confirmed execution enrich the same row without touching historical or independent labels.
      let current = row;
      for (let attempt = 0; attempt < 3 && current; attempt += 1) {
        const oldEvidence = object(current.evidence);
        const previous =
          metadata(current.qualityMetadata) ?? metadata(oldEvidence.evidenceMetadata);
        if (!previous) break;
        const merged = mergeMetadata(previous, qualityMetadata);
        if (JSON.stringify(merged) === JSON.stringify(previous)) {
          await persistPolicyStop(this.prisma, confirmedFalseDeletionStop(current, previous));
          break;
        }
        const completed =
          previous.analysisOutcome !== 'COMPLETE' && merged.analysisOutcome === 'COMPLETE';
        const changedAt = new Date(Math.max(Date.now(), current.updatedAt.getTime() + 1));
        const changed = await this.prisma.$transaction(async (tx) => {
          const change = await tx.commercialReviewSample.updateMany({
            where: { id: current.id, updatedAt: current.updatedAt, expiresAt: { gt: changedAt } },
            data: {
              qualityMetadata: merged as Prisma.InputJsonValue,
              evidence: {
                ...(completed ? evidence : oldEvidence),
                label: oldEvidence.label ?? null,
                reviewReason: oldEvidence.reviewReason ?? '',
                reviewedAt: oldEvidence.reviewedAt ?? null,
                evidenceMetadata: merged,
              } as Prisma.InputJsonValue,
              ...(completed ? { score: evidence.score / 100 } : {}),
              updatedAt: changedAt,
            },
          });
          if (change.count === 1)
            await persistPolicyStop(
              tx,
              confirmedFalseDeletionStop(
                {
                  ...current,
                  evidence: (completed ? evidence : oldEvidence) as Prisma.JsonObject,
                },
                merged,
              ),
            );
          return change;
        });
        if (changed.count === 1) break;
        current = (await this.prisma.commercialReviewSample.findUnique({
          where: { evidenceHash },
          include: { ratings: true },
        }))!;
      }
    } catch {
      this.logger.warn(
        { stage: 'commercial-review-record' },
        'Commercial review capture unavailable',
      );
    }
  }

  // FLAG: Receipt attribution comes only from the guarded intent executor, never a review label.
  // With a transaction, failures leave the durable remote receipt eligible for DB-only recovery.
  async recordExecution(
    input: {
      chatId: string;
      messageId: string;
      binding: CommercialReviewExecutionBinding;
      executionOutcome: 'CONFIRMED_DELETE' | 'ALREADY_ABSENT';
    },
    transaction?: Prisma.TransactionClient,
  ): Promise<'RECORDED' | 'SOURCE_UNAVAILABLE' | 'SOURCE_MISMATCH'> {
    const run = async (tx: Prisma.TransactionClient) => {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const current = await tx.commercialReviewSample.findUnique({
          where: { evidenceHash: input.binding.evidenceHash },
          include: { ratings: true },
        });
        const previous = current && metadata(current.qualityMetadata);
        if (!current || !previous || current.expiresAt.getTime() <= Date.now()) {
          this.logger.warn(
            { stage: 'commercial-review-execution', outcome: 'source_unavailable' },
            'Commercial receipt observation source unavailable',
          );
          return 'SOURCE_UNAVAILABLE' as const;
        }
        if (
          current.chatId !== input.chatId ||
          current.messageId !== input.messageId ||
          current.source !== input.binding.source ||
          previous.sourceSnapshotSha256 !== input.binding.sourceSnapshotSha256 ||
          previous.detectorSourceSha256 !== input.binding.detectorSourceSha256 ||
          object(current.evidence).detectorVersion !== input.binding.detectorVersion
        ) {
          this.logger.warn(
            { stage: 'commercial-review-execution', outcome: 'source_mismatch' },
            'Commercial receipt observation source mismatch',
          );
          return 'SOURCE_MISMATCH' as const;
        }
        const merged = {
          ...previous,
          executionOutcome:
            previous.executionOutcome === 'CONFIRMED_DELETE'
              ? ('CONFIRMED_DELETE' as const)
              : input.executionOutcome,
        };
        if (JSON.stringify(merged) !== JSON.stringify(previous)) {
          const changedAt = new Date(Math.max(Date.now(), current.updatedAt.getTime() + 1));
          const changed = await tx.commercialReviewSample.updateMany({
            where: { id: current.id, updatedAt: current.updatedAt, expiresAt: { gt: changedAt } },
            data: {
              qualityMetadata: merged as Prisma.InputJsonValue,
              evidence: {
                ...object(current.evidence),
                evidenceMetadata: merged,
              } as Prisma.InputJsonObject,
              updatedAt: changedAt,
            },
          });
          if (changed.count !== 1) continue;
        }
        await persistPolicyStop(tx, confirmedFalseDeletionStop(current, merged));
        return 'RECORDED' as const;
      }
      throw new ConflictException('Commercial receipt observation changed during finalization');
    };
    return transaction ? run(transaction) : this.prisma.$transaction(run);
  }

  async pruneExpired(limit = 1000): Promise<number> {
    const boundedLimit = Number.isFinite(limit)
      ? Math.max(1, Math.min(5000, Math.floor(limit)))
      : 1000;
    const now = new Date();
    const expired = await this.prisma.commercialReviewSample.findMany({
      where: { expiresAt: { lte: now } },
      orderBy: [{ expiresAt: 'asc' }, { id: 'asc' }],
      take: boundedLimit,
      select: { id: true },
    });
    if (!expired.length) return 0;
    const deleted = await this.prisma.commercialReviewSample.deleteMany({
      where: { id: { in: expired.map((row) => row.id) }, expiresAt: { lte: now } },
    });
    return deleted.count;
  }

  async getQueue(query: unknown, actor: string | null): Promise<CommercialReviewQueueResponse> {
    const viewer = reviewerKey(actor);
    const parsed = commercialReviewQueueQuerySchema.safeParse(query);
    if (!parsed.success) throw new BadRequestException('Некорректные параметры очереди.');
    const { limit, cursor, status } = parsed.data;
    let after: { observedAt: Date; id: string } | undefined;
    if (cursor) {
      try {
        const decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as {
          observedAt: unknown;
          id: unknown;
        };
        if (
          typeof decoded.observedAt !== 'string' ||
          typeof decoded.id !== 'string' ||
          !/^[a-z0-9_-]{1,100}$/iu.test(decoded.id) ||
          !Number.isFinite(Date.parse(decoded.observedAt))
        )
          throw new Error();
        after = { observedAt: new Date(decoded.observedAt), id: decoded.id };
      } catch {
        throw new BadRequestException('Некорректная страница очереди.');
      }
    }
    const rows = await this.prisma.commercialReviewSample.findMany({
      where: {
        // FLAG: Dedicated AI attempts are private diagnostics, not additional human-frame samples.
        llmEnforcement: { equals: Prisma.DbNull },
        expiresAt: { gt: new Date() },
        AND: [
          ...(status === 'PENDING'
            ? [
                {
                  ratings: { none: { reviewerKey: viewer.key } },
                  OR: [
                    { independentReviewCount: { lt: 2 } },
                    { reviewState: 'DISAGREEMENT' },
                    { semanticReviewState: 'DISAGREEMENT' },
                  ],
                },
              ]
            : status === 'REVIEWED'
              ? [{ ratings: { some: { reviewerKey: viewer.key } } }]
              : []),
          ...(after
            ? [
                {
                  OR: [
                    { observedAt: { lt: after.observedAt } },
                    { observedAt: after.observedAt, id: { lt: after.id } },
                  ],
                },
              ]
            : []),
        ],
      },
      include: { chat: { select: { title: true } }, ratings: true },
      // FLAG: Score-derived priorities must not leak through list order or pagination cursors.
      orderBy: [{ observedAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      generatedAt: new Date().toISOString(),
      items: page.flatMap((row) => {
        const item = this.mapItem(row, viewer.key);
        return item ? [item] : [];
      }),
      nextCursor:
        rows.length > limit && last
          ? Buffer.from(
              JSON.stringify({ observedAt: last.observedAt.toISOString(), id: last.id }),
            ).toString('base64url')
          : null,
    };
  }

  async labelItem(id: string, actor: string | null, body: unknown): Promise<CommercialReviewItem> {
    return this.saveReview(id, actor, body, 'INDEPENDENT');
  }

  async adjudicateItem(
    id: string,
    actor: string | null,
    body: unknown,
  ): Promise<CommercialReviewItem> {
    return this.saveReview(id, actor, body, 'ADJUDICATION');
  }

  async exportIndependentEvidence(
    query: unknown,
    actor: string | null,
  ): Promise<CommercialReviewExportResponse> {
    const viewer = reviewerKey(actor);
    const parsed = commercialReviewExportQuerySchema.safeParse(query);
    if (!parsed.success)
      throw new BadRequestException('Укажите ограниченное окно экспорта и лимит до 500.');
    const { since, until, limit, cursor } = parsed.data;
    let after: { observedAt: Date; id: string } | null = null;
    if (cursor) {
      try {
        const decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as {
          observedAt: unknown;
          id: unknown;
        };
        if (
          typeof decoded.observedAt !== 'string' ||
          !Number.isFinite(Date.parse(decoded.observedAt)) ||
          typeof decoded.id !== 'string' ||
          !/^[a-z0-9_-]{1,100}$/iu.test(decoded.id)
        )
          throw new Error();
        after = { observedAt: new Date(decoded.observedAt), id: decoded.id };
      } catch {
        throw new BadRequestException('Некорректная страница экспорта.');
      }
    }
    // FLAG: Export must not bypass blindness for an actor who has not supplied their own review.
    const rows = await this.prisma.commercialReviewSample.findMany({
      where: {
        // FLAG: Dedicated AI attempts are private diagnostics, not additional human-frame samples.
        llmEnforcement: { equals: Prisma.DbNull },
        expiresAt: { gt: new Date() },
        observedAt: { gte: new Date(since), lt: new Date(until) },
        ratings: { some: { reviewerKey: viewer.key } },
        ...(after
          ? {
              OR: [
                { observedAt: { lt: after.observedAt } },
                { observedAt: after.observedAt, id: { lt: after.id } },
              ],
            }
          : {}),
      },
      include: { chat: { select: { title: true } }, ratings: true },
      orderBy: [{ observedAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    const nextCursor =
      rows.length > limit && last
        ? Buffer.from(
            JSON.stringify({ observedAt: last.observedAt.toISOString(), id: last.id }),
          ).toString('base64url')
        : null;
    return {
      generatedAt: new Date().toISOString(),
      scope: 'OWN_REVIEWED',
      populationCoverageAvailable: false,
      since,
      until,
      nextCursor,
      complete: nextCursor === null,
      items: page.flatMap((row) => {
        const sample = this.mapItem(row, viewer.key);
        if (!sample || !sample.decisionVisible) return [];
        const quality = sample.evidenceMetadata;
        const independent = row.ratings.filter((rating) => rating.kind === 'INDEPENDENT');
        const { finalRating: final, labelRatings } = resolveCommercialLabelAuthority(row.ratings);
        const adjudication = row.ratings.filter((rating) => rating.kind === 'ADJUDICATION');
        const independentAgreement =
          independent.length === 2 &&
          independent.every(
            (rating) =>
              rating.label === independent[0]?.label &&
              rating.expectedDisposition === independent[0]?.expectedDisposition,
          );
        const covered = (rating: ReviewRating) =>
          row.source === 'OCR'
            ? rating.evidenceKind === 'PRIVATE_SOURCE_IMAGE' &&
              digest(rating.sourceEvidenceDigest ?? undefined) !== null
            : rating.evidenceKind === 'TEXT' && quality?.sourceExcerptComplete === true;
        const eligible =
          row.reviewState === 'RESOLVED' &&
          independent.length === 2 &&
          (independentAgreement || adjudication.length === 1) &&
          final?.label === row.independentLabel &&
          final?.label !== 'UNSURE' &&
          final?.expectedDisposition != null &&
          row.ratings.every(covered) &&
          labelRatings.every((rating) => rating.expectedDisposition !== null) &&
          quality?.campaignGroupingComplete === true &&
          quality?.samplingProbability != null &&
          quality.samplingProbability > 0 &&
          Boolean(
            quality?.sourceSnapshotSha256 &&
            quality.pseudonymizationKeyId &&
            quality.randomEvaluationIncluded !== null &&
            quality.detectorSourceSha256 &&
            quality.settingsProfileDigest &&
            quality.authorGroupId &&
            quality.logicalMessageKey &&
            quality.messageCreatedAt,
          );
        return [
          {
            sample,
            eligibleForIndependentCorpus: eligible,
            ratings: row.ratings.map((rating) => ({
              reviewerKey: rating.reviewerKey,
              label: rating.label as CommercialReviewLabel,
              expectedDisposition: rating.expectedDisposition as 'KEEP' | 'DELETE' | null,
              reason: redact(rating.reason, 500),
              reviewedAt: rating.createdAt.toISOString(),
              kind: rating.kind as 'INDEPENDENT' | 'ADJUDICATION' | 'SEMANTIC_ADJUDICATION',
              evidenceKind: rating.evidenceKind as 'TEXT' | 'CAPTION_ONLY' | 'PRIVATE_SOURCE_IMAGE',
              sourceEvidenceDigest: digest(rating.sourceEvidenceDigest ?? undefined),
              semanticAnnotation: annotation(rating.semanticAnnotation),
            })),
          },
        ];
      }),
    };
  }

  async exportAiIndependentEvidence(
    query: unknown,
    actor: string | null,
  ): Promise<CommercialAiReviewExportResponse> {
    const parsed = commercialAiReviewExportQuerySchema.safeParse(query);
    if (!parsed.success) throw new BadRequestException('Укажите окно экспорта ИИ и лимит до 50.');
    const exported = await this.exportIndependentEvidence(parsed.data, actor);
    const items: CommercialAiReviewExportResponse['items'] = [];
    for (const item of exported.items) {
      // FLAG: Re-read the exact human revision; a stale page cannot join a newer source/review.
      const human = await this.prisma.commercialReviewSample.findUnique({
        where: { id: item.sample.id },
        select: { evidenceHash: true, updatedAt: true, expiresAt: true },
      });
      if (
        !human ||
        human.expiresAt <= new Date() ||
        human.updatedAt.toISOString() !== item.sample.updatedAt
      )
        throw new ConflictException('Материал изменился. Повторите экспорт.');
      // FLAG: Limit an indexed exact linkage seek BEFORE expiry/JSON eligibility checks.
      // Multiple retained generations remain ambiguous, including an expired generation.
      const linked = await this.prisma.$queryRaw<CommercialAiReviewedExportRow[]>(Prisma.sql`
        WITH linked AS MATERIALIZED (
          SELECT id, human_review_evidence_hash, source, evidence_hash, expires_at,
            evidence, quality_metadata, llm_enforcement
          FROM commercial_review_samples
          WHERE human_review_evidence_hash = ${human.evidenceHash}
          ORDER BY observed_at DESC, id DESC LIMIT 2
        ) SELECT human_review_evidence_hash AS "humanReviewEvidenceHash", source,
          evidence_hash AS "evidenceHash", expires_at AS "expiresAt",
          CASE WHEN octet_length(evidence ->> 'excerpt') <= 10000
            THEN evidence ->> 'excerpt' ELSE NULL END AS excerpt,
          CASE WHEN octet_length(quality_metadata::text) <= 32768
            THEN quality_metadata ELSE NULL END AS "qualityMetadata",
          CASE WHEN octet_length(llm_enforcement::text) <= ${COMMERCIAL_AI_QUALITY_MAX_ENVELOPE_BYTES}
            THEN llm_enforcement ELSE NULL END AS "llmEnforcement",
          COALESCE(octet_length(evidence ->> 'excerpt') > 10000, false)
            OR COALESCE(octet_length(quality_metadata::text) > 32768, false)
            OR COALESCE(octet_length(llm_enforcement::text) > ${COMMERCIAL_AI_QUALITY_MAX_ENVELOPE_BYTES}, false)
            AS "payloadOversized"
        FROM linked`);
      items.push({
        ...item,
        sample: {
          ...item.sample,
          llmEnforcement: projectCommercialAiReviewedExport(item, human.evidenceHash, linked),
        },
      });
    }
    return { ...exported, items };
  }

  async exportSamplingFrame(
    query: unknown,
    actor: string | null,
  ): Promise<CommercialReviewSamplingFrameResponse> {
    reviewerKey(actor);
    const parsed = commercialReviewSamplingFrameQuerySchema.safeParse(query);
    if (!parsed.success) throw new BadRequestException('Укажите окно до 14 дней и лимит до 500.');
    const { since, until, limit, cursor } = parsed.data;
    let after: { observedAt: Date; id: string } | null = null;
    if (cursor) {
      try {
        const decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as {
          observedAt: unknown;
          id: unknown;
        };
        if (
          typeof decoded.observedAt !== 'string' ||
          !Number.isFinite(Date.parse(decoded.observedAt)) ||
          Date.parse(decoded.observedAt) < Date.parse(since) ||
          Date.parse(decoded.observedAt) >= Date.parse(until) ||
          typeof decoded.id !== 'string' ||
          !/^[a-z0-9_-]{1,100}$/iu.test(decoded.id)
        )
          throw new Error();
        after = { observedAt: new Date(decoded.observedAt), id: decoded.id };
      } catch {
        throw new BadRequestException('Некорректная страница случайной выборки.');
      }
    }
    // FLAG: Walk all retained capture rows by the neutral index before JSON filtering.
    // Completeness covers this bounded captured frame, never uncaptured ingress or expired history.
    const rows = await this.prisma.commercialReviewSample.findMany({
      where: {
        observedAt: { gte: new Date(since), lt: new Date(until) },
        ...(after
          ? {
              OR: [
                { observedAt: { lt: after.observedAt } },
                { observedAt: after.observedAt, id: { lt: after.id } },
              ],
            }
          : {}),
      },
      select: {
        id: true,
        source: true,
        observedAt: true,
        qualityMetadata: true,
        llmEnforcement: true,
      },
      orderBy: [{ observedAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    const nextCursor =
      rows.length > limit && last
        ? Buffer.from(
            JSON.stringify({ observedAt: last.observedAt.toISOString(), id: last.id }),
          ).toString('base64url')
        : null;
    return {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      scope: 'RANDOM_EVALUATION_FRAME',
      populationCoverageAvailable: false,
      since,
      until,
      scannedCaptureRows: page.length,
      samplingUnavailableRows: page.filter(
        (row) =>
          metadata(row.qualityMetadata)?.randomEvaluationIncluded == null ||
          (row.source !== 'TEXT' && row.source !== 'OCR'),
      ).length,
      nextCursor,
      complete: nextCursor === null,
      items: page.flatMap((row) => {
        const quality = metadata(row.qualityMetadata);
        if (
          row.llmEnforcement != null ||
          quality?.randomEvaluationIncluded !== true ||
          (row.source !== 'TEXT' && row.source !== 'OCR')
        )
          return [];
        return [
          {
            source: row.source,
            observedAt: row.observedAt.toISOString(),
            sourceSnapshotSha256: quality.sourceSnapshotSha256,
            logicalMessageKey: digest(quality.logicalMessageKey ?? undefined),
            pseudonymizationKeyId: quality.pseudonymizationKeyId,
            settingsProfileDigest: quality.settingsProfileDigest,
            campaignGroupingComplete: quality.campaignGroupingComplete,
            messageCreatedAt: quality.messageCreatedAt,
            evaluationSamplingProbability: quality.evaluationSamplingProbability,
          },
        ];
      }),
    };
  }

  private async saveReview(
    id: string,
    actor: string | null,
    body: unknown,
    kind: 'INDEPENDENT' | 'ADJUDICATION',
  ): Promise<CommercialReviewItem> {
    const viewer = reviewerKey(actor);
    const parsed = commercialReviewDecisionRequestSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException('Некорректная оценка.');
    const current = await this.prisma.commercialReviewSample.findUnique({
      where: { id },
      include: { chat: { select: { title: true } }, ratings: true },
    });
    if (
      !current ||
      current.llmEnforcement != null ||
      current.expiresAt <= new Date() ||
      !this.mapItem(current, viewer.key)
    )
      throw new NotFoundException('Материал недоступен.');
    const expected = new Date(parsed.data.expectedUpdatedAt);
    if (current.updatedAt.getTime() !== expected.getTime())
      throw new ConflictException('Оценка уже изменена. Обновите очередь.');
    const ratings = current.ratings;
    if (ratings.some((rating) => rating.reviewerKey === viewer.key))
      throw new ConflictException(
        'Ваша независимая оценка уже сохранена и не может быть перезаписана.',
      );
    const independent = ratings.filter((rating) => rating.kind === 'INDEPENDENT');
    if (kind === 'ADJUDICATION') {
      if (
        (current.reviewState !== 'DISAGREEMENT' && !semanticDisagreement(current)) ||
        independent.length !== 2 ||
        ratings.some((rating) => ['ADJUDICATION', 'SEMANTIC_ADJUDICATION'].includes(rating.kind))
      )
        throw new ConflictException('Материал не ожидает разрешения разногласия.');
    } else if (independent.length >= 2)
      throw new ConflictException(
        'Две оценки уже сохранены. Разногласие разрешает третий проверяющий.',
      );
    // FLAG: A caption-only card cannot provide an independent label for unseen image content.
    if (current.source === 'OCR' && parsed.data.label !== 'UNSURE')
      throw new BadRequestException(
        'Для оценки фотографии нужен исходный снимок в частном наборе проверки. Здесь доступна только подпись.',
      );
    const quality =
      metadata(current.qualityMetadata) ?? metadata(object(current.evidence).evidenceMetadata);
    if (quality?.sourceExcerptComplete === false && parsed.data.label !== 'UNSURE')
      throw new BadRequestException(
        'Текст представлен не полностью. Для независимой оценки нужен полный исходный материал.',
      );
    if (quality && parsed.data.label !== 'UNSURE' && parsed.data.expectedDisposition == null)
      throw new BadRequestException('Укажите ожидаемое решение: сохранить или удалить.');
    const binding = semanticBinding(current);
    if (parsed.data.semanticAnnotation && !binding)
      throw new BadRequestException(
        'Для смысловой разметки нужен полный текст с подтверждённым источником.',
      );
    const semanticAnnotation =
      parsed.data.semanticAnnotation && binding
        ? { ...parsed.data.semanticAnnotation, ...binding }
        : null;
    // FLAG: Never compare a blind third opinion with hidden agreed labels: that creates an oracle.
    // Semantic-only votes retain the actor's actual opinion but cannot reopen the agreed label pair.
    // Their distinct kind also preserves old late-receipt KEEP-stop readers during rollback.
    const semanticOnly = kind === 'ADJUDICATION' && current.reviewState === 'RESOLVED';
    if (semanticOnly && !semanticAnnotation)
      throw new BadRequestException('Уточните смысловые категории сообщения.');
    const storedKind = semanticOnly ? 'SEMANTIC_ADJUDICATION' : kind;
    const reviewedAt = new Date(Math.max(Date.now(), expected.getTime() + 1));
    const expectedDisposition = parsed.data.expectedDisposition ?? null;
    const reason = redact(parsed.data.reason, 500);
    const first = independent[0];
    const agreement =
      first?.label === parsed.data.label && first.expectedDisposition === expectedDisposition;
    const state =
      kind === 'ADJUDICATION' || (independent.length === 1 && agreement)
        ? 'RESOLVED'
        : independent.length === 1
          ? 'DISAGREEMENT'
          : 'AWAITING_SECOND';
    const finalLabel =
      state === 'RESOLVED' ? (semanticOnly ? current.independentLabel : parsed.data.label) : null;
    const semanticReviewState = binding
      ? resolveCommercialSemanticReview(
          [...ratings, { kind: storedKind, reviewerKey: viewer.key, semanticAnnotation }],
          binding,
        ).state
      : 'MISSING';
    let rating: ReviewRating;
    try {
      rating = await this.prisma.$transaction(async (tx) => {
        const changed = await tx.commercialReviewSample.updateMany({
          where: { id, updatedAt: expected, expiresAt: { gt: reviewedAt } },
          data: {
            reviewState: state,
            semanticReviewState,
            independentReviewCount: kind === 'INDEPENDENT' ? independent.length + 1 : 2,
            independentLabel: finalLabel,
            updatedAt: reviewedAt,
          },
        });
        if (changed.count !== 1)
          throw new ConflictException('Оценка уже изменена. Обновите очередь.');
        const created = await tx.commercialReviewRating.create({
          data: {
            sampleId: id,
            reviewerKey: viewer.key,
            kind: storedKind,
            label: parsed.data.label,
            expectedDisposition,
            evidenceKind: current.source === 'OCR' ? 'CAPTION_ONLY' : 'TEXT',
            ...(semanticAnnotation ? { semanticAnnotation } : {}),
            reason,
            createdAt: reviewedAt,
          },
        });
        await persistPolicyStop(
          tx,
          confirmedFalseDeletionStop(
            {
              ...current,
              reviewState: state,
              independentLabel: finalLabel,
              ratings: [...ratings, created],
            },
            quality,
          ),
        );
        await tx.auditLog.create({
          data: {
            chatId: current.chatId,
            actorUserId: viewer.actor,
            action:
              kind === 'ADJUDICATION'
                ? 'SAFETY_DESK_COMMERCIAL_ADJUDICATION'
                : 'SAFETY_DESK_COMMERCIAL_INDEPENDENT_LABEL',
            payload: {
              observationId: id,
              label: parsed.data.label,
              expectedDisposition,
              reason,
              reviewState: state,
              reviewKind: storedKind,
              semanticAnnotation,
            },
          },
        });
        return created;
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002')
        throw new ConflictException('Оценка уже сохранена. Обновите очередь.');
      throw error;
    }
    const item = this.mapItem(
      {
        ...current,
        reviewState: state,
        semanticReviewState,
        independentReviewCount: kind === 'INDEPENDENT' ? independent.length + 1 : 2,
        independentLabel: finalLabel,
        updatedAt: reviewedAt,
        ratings: [...ratings, rating],
      },
      viewer.key,
    );
    if (!item) throw new NotFoundException('Материал недоступен.');
    return item;
  }

  private mapItem(row: ReviewRow, viewerKey: string): CommercialReviewItem | null {
    const evidence = object(row.evidence);
    const own = row.ratings.find((rating) => rating.reviewerKey === viewerKey);
    const visible = Boolean(own);
    const independentCount = row.ratings.filter((rating) => rating.kind === 'INDEPENDENT').length;
    const canAct = !own && row.expiresAt > new Date();
    const parsed = commercialReviewItemSchema.safeParse({
      ...evidence,
      score: visible ? evidence.score : null,
      actionBand: visible ? evidence.actionBand : null,
      messageDisposition: visible ? evidence.messageDisposition : null,
      requiredPolicyCohorts: visible ? evidence.requiredPolicyCohorts : [],
      detectorVersion: visible ? evidence.detectorVersion : 'unknown',
      decisionFingerprint: visible ? evidence.decisionFingerprint : 'unknown',
      reviewPriority: visible ? row.reviewPriority : null,
      reasons: visible ? evidence.reasons : [],
      label: visible ? row.independentLabel : null,
      historicalLabel: visible ? row.label : null,
      reviewReason: own?.reason ?? '',
      reviewedAt: own?.createdAt.toISOString() ?? null,
      ownReview: own
        ? {
            label: own.label,
            expectedDisposition: own.expectedDisposition,
            reason: redact(own.reason, 500),
            reviewedAt: own.createdAt.toISOString(),
            kind: own.kind,
            evidenceKind: own.evidenceKind,
            semanticAnnotation: annotation(own.semanticAnnotation),
          }
        : null,
      reviewState: row.reviewState,
      independentReviewCount: independentCount,
      decisionVisible: visible,
      canReview: canAct && independentCount < 2,
      canAdjudicate:
        canAct &&
        independentCount === 2 &&
        !row.ratings.some((rating) =>
          ['ADJUDICATION', 'SEMANTIC_ADJUDICATION'].includes(rating.kind),
        ) &&
        (row.reviewState === 'DISAGREEMENT' || semanticDisagreement(row)),
      imageEvidenceAvailable: false,
      semanticAnnotationAllowed: semanticBinding(row) !== null,
      sourceExcerptComplete:
        metadata(row.qualityMetadata)?.sourceExcerptComplete ??
        metadata(evidence.evidenceMetadata)?.sourceExcerptComplete ??
        null,
      evidenceMetadata: visible
        ? (metadata(row.qualityMetadata) ?? metadata(evidence.evidenceMetadata))
        : null,
      id: row.id,
      chatId: row.chatId,
      chatTitle: row.chat?.title ?? 'Чат недоступен',
      observedAt: row.observedAt.toISOString(),
      expiresAt: row.expiresAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    });
    return parsed.success
      ? {
          ...parsed.data,
          excerpt: redact(parsed.data.excerpt, 2500),
          reviewReason: redact(parsed.data.reviewReason, 500),
        }
      : null;
  }
}
