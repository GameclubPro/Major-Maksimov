import { z } from 'zod';
import { commercialReviewExportResponseSchema, commercialReviewItemSchema } from './safety-desk.js';

const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const token = z.string().regex(/^[a-z0-9_.:-]{1,120}$/iu);
const clock = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const duration = z.number().int().min(0).max(90_000);
export const COMMERCIAL_AI_QUALITY_MAX_ATTEMPTS = 8;
export const COMMERCIAL_AI_QUALITY_MAX_ENVELOPE_BYTES = 128 * 1024;
const classification = z.enum(['COMMERCIAL', 'NOT_COMMERCIAL', 'UNSURE']);
const node = z.enum(['server-9b', 'pc-a-4b', 'pc-b-9b']);
const reason = z.enum([
  'COMMERCIAL_OFFER',
  'CUSTOMER_ACQUISITION',
  'COMMERCIAL_COMMUNITY',
  'PERSONAL_SALE',
  'BUYER_REQUEST',
  'ORDINARY_DISCUSSION',
  'QUOTED_DISCUSSION',
  'SERVICE_ANNOUNCEMENT',
  'NONCOMMERCIAL_HELP',
  'INSUFFICIENT_CONTEXT',
]);

export const commercialAiQualityResultSchema = z
  .object({
    classification,
    reasonCodes: z.array(reason).min(1).max(3),
    modelAlias: token,
    modelSha256: digest,
    promptSha256: digest,
    runtimeVersion: token,
    runtimeImageSha256: digest.optional(),
    runtimeArtifactSha256: digest.optional(),
    runtimeSupportSha256: digest.optional(),
    chatTemplateSha256: digest,
    policyVersion: token,
    durationMs: duration,
    pool: z
      .object({
        version: z.literal('commercial-pool-v2'),
        nodeId: node,
        route: z.enum(['direct', 'consulted']),
        policy: z.enum(['confirm-positive', 'direct-4b']),
        attempts: z.union([z.literal(1), z.literal(2)]),
        primaryNodeId: z.literal('pc-a-4b').optional(),
        primaryClassification: classification.optional(),
        primaryDurationMs: duration.optional(),
        consultationDurationMs: duration.optional(),
        consultationOutcome: z.enum(['completed', 'no_capacity', 'budget_exhausted']).optional(),
      })
      .strict()
      .optional(),
    cascade: z
      .object({
        version: token,
        route: token,
        primaryClassification: classification.optional(),
        primaryModelSha256: digest,
        primaryDurationMs: duration.optional(),
        secondaryDurationMs: duration.optional(),
        auditOutcome: z.literal('capacity_skipped').optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const allowed =
      value.classification === 'COMMERCIAL'
        ? ['COMMERCIAL_OFFER', 'CUSTOMER_ACQUISITION', 'COMMERCIAL_COMMUNITY']
        : value.classification === 'UNSURE'
          ? ['INSUFFICIENT_CONTEXT']
          : [
              'PERSONAL_SALE',
              'BUYER_REQUEST',
              'ORDINARY_DISCUSSION',
              'QUOTED_DISCUSSION',
              'SERVICE_ANNOUNCEMENT',
              'NONCOMMERCIAL_HELP',
            ];
    if (
      new Set(value.reasonCodes).size !== value.reasonCodes.length ||
      value.reasonCodes.some((code) => !allowed.includes(code)) ||
      (!value.runtimeImageSha256 && !value.runtimeArtifactSha256) ||
      (value.pool !== undefined && value.cascade !== undefined)
    )
      context.addIssue({ code: 'custom', message: 'Invalid bounded classifier observation.' });
    const pool = value.pool;
    if (pool) {
      const consulted = pool.route === 'consulted';
      const unresolved =
        pool.consultationOutcome === 'no_capacity' ||
        pool.consultationOutcome === 'budget_exhausted';
      const hasPrimary =
        pool.primaryNodeId !== undefined ||
        pool.primaryClassification !== undefined ||
        pool.primaryDurationMs !== undefined;
      if (
        (consulted &&
          (pool.nodeId === 'pc-a-4b' ||
            pool.primaryNodeId !== 'pc-a-4b' ||
            pool.consultationOutcome !== 'completed' ||
            pool.primaryClassification === undefined ||
            pool.primaryDurationMs === undefined ||
            pool.consultationDurationMs === undefined)) ||
        (unresolved &&
          (pool.route !== 'direct' ||
            pool.nodeId !== 'pc-a-4b' ||
            pool.primaryNodeId !== 'pc-a-4b' ||
            pool.primaryClassification === undefined ||
            pool.primaryDurationMs === undefined ||
            value.classification !== 'UNSURE' ||
            pool.consultationDurationMs !== undefined)) ||
        (!consulted &&
          !unresolved &&
          (hasPrimary ||
            pool.consultationOutcome !== undefined ||
            pool.consultationDurationMs !== undefined)) ||
        ((consulted || unresolved) &&
          pool.primaryClassification !== 'UNSURE' &&
          !(pool.policy === 'confirm-positive' && pool.primaryClassification === 'COMMERCIAL'))
      )
        context.addIssue({ code: 'custom', message: 'Contradictory pool observation route.' });
    }
  });
export type CommercialAiQualityResult = z.infer<typeof commercialAiQualityResultSchema>;

export const commercialAiQualitySourceBindingSchema = z
  .object({
    source: z.literal('TEXT'),
    evidenceHash: digest,
    logicalMessageKey: digest,
    sourceSnapshotSha256: digest,
    excerptSha256: digest,
    messageCreatedAt: z.string().datetime(),
    sourceExcerptComplete: z.literal(true),
  })
  .strict();
export type CommercialAiQualitySourceBinding = z.infer<
  typeof commercialAiQualitySourceBindingSchema
>;

const decision = z
  .object({
    hasDetection: z.boolean().nullable(),
    actionable: z.boolean().nullable(),
    deleteEligible: z.boolean().nullable(),
    score: z.number().min(0).max(100),
    actionBand: token,
    messageDisposition: z.enum(['KEEP', 'DELETE']),
    detectorVersion: token,
    decisionFingerprint: token,
    reasons: z.array(token).max(32),
    requiredPolicyCohorts: z.array(token).max(32),
  })
  .strict();

export const commercialAiQualityAdmissionSchema = z
  .object({
    state: z.enum(['NOT_OBSERVED', 'ACCEPTED', 'REJECTED']),
    reason: z
      .enum([
        'NOT_ENABLED',
        'PRESSURE',
        'BUSY',
        'STALE_SOURCE',
        'INVALID_SOURCE',
        'DEPENDENCY_UNAVAILABLE',
        'NOT_ADMITTED',
        'UNKNOWN',
      ])
      .nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.state === 'REJECTED') !== (value.reason !== null))
      context.addIssue({ code: 'custom', message: 'Rejected admission needs an observed reason.' });
  });
export type CommercialAiQualityAdmission = z.infer<typeof commercialAiQualityAdmissionSchema>;
export const commercialAiQualityAnalysisSchema = z
  .object({
    state: z.enum(['NOT_STARTED', 'COMPLETE', 'TECHNICAL_FAILURE', 'EXPIRED_WITHOUT_RESULT']),
    classificationOrigin: z.enum(['MODEL', 'POLICY_ABSTENTION']).nullable(),
    result: commercialAiQualityResultSchema.nullable(),
    policyDeleteEligible: z.boolean().nullable(),
    observedAt: z.string().datetime().nullable(),
    reason: z
      .enum([
        'TIMEOUT',
        'ABORTED',
        'INVALID_RESPONSE',
        'HTTP_ERROR',
        'UNAVAILABLE',
        'SOURCE_EXPIRED',
        'NO_CAPACITY',
        'BUDGET_EXHAUSTED',
        'UNKNOWN',
      ])
      .nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      (value.state === 'COMPLETE') !== (value.result !== null) ||
      (value.result === null &&
        (value.classificationOrigin !== null || value.policyDeleteEligible !== null)) ||
      (value.result !== null && value.classificationOrigin === null) ||
      (value.state === 'NOT_STARTED') !== (value.observedAt === null) ||
      (value.state === 'NOT_STARTED' && value.reason !== null) ||
      (['TECHNICAL_FAILURE', 'EXPIRED_WITHOUT_RESULT'].includes(value.state) &&
        value.reason === null) ||
      (value.classificationOrigin === 'MODEL' && value.reason !== null) ||
      (value.classificationOrigin === 'POLICY_ABSTENTION' &&
        (value.result?.classification !== 'UNSURE' ||
          value.policyDeleteEligible !== false ||
          value.reason !==
            (value.result?.pool?.consultationOutcome === 'no_capacity'
              ? 'NO_CAPACITY'
              : 'BUDGET_EXHAUSTED') ||
          !['no_capacity', 'budget_exhausted'].includes(
            value.result.pool?.consultationOutcome ?? '',
          ))) ||
      (value.classificationOrigin === 'MODEL' &&
        ['no_capacity', 'budget_exhausted'].includes(
          value.result?.pool?.consultationOutcome ?? '',
        )) ||
      (value.policyDeleteEligible === true &&
        (value.result?.classification !== 'COMMERCIAL' ||
          (!value.result.pool && !value.result.cascade) ||
          (value.result.pool?.nodeId === 'pc-a-4b' && value.result.pool.policy !== 'direct-4b') ||
          (value.result.cascade !== undefined &&
            (!value.result.cascade.route.startsWith('secondary_') ||
              value.result.cascade.primaryClassification === 'NOT_COMMERCIAL'))))
    )
      context.addIssue({ code: 'custom', message: 'Missing classifications remain unevaluated.' });
  });
export type CommercialAiQualityAnalysis = z.infer<typeof commercialAiQualityAnalysisSchema>;
export const commercialAiQualityRegistrationSchema = z
  .object({
    state: z.enum(['NOT_REQUESTED', 'REGISTERED', 'REJECTED', 'UNKNOWN']),
    intentIdSha256: digest.nullable(),
    reason: z
      .enum([
        'NOT_ELIGIBLE',
        'SOURCE_EXPIRED',
        'GUARD_REJECTED',
        'DEPENDENCY_UNAVAILABLE',
        'UNKNOWN',
      ])
      .nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      (value.state === 'REGISTERED') !== (value.intentIdSha256 !== null) ||
      (['NOT_REQUESTED', 'REGISTERED'].includes(value.state) && value.reason !== null) ||
      (value.state === 'REJECTED' && value.reason === null)
    )
      context.addIssue({ code: 'custom', message: 'Registration needs its exact intent binding.' });
  });
export type CommercialAiQualityRegistration = z.infer<typeof commercialAiQualityRegistrationSchema>;
export const commercialAiQualityExecutionSchema = z
  .object({
    state: z.enum([
      'NOT_REQUESTED',
      'PENDING',
      'CONFIRMED_DELETE',
      'ALREADY_ABSENT',
      'GUARD_REJECTED',
      'UNKNOWN',
    ]),
    receiptSha256: digest.nullable(),
    observedAt: z.string().datetime().nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      ['CONFIRMED_DELETE', 'ALREADY_ABSENT'].includes(value.state) !==
        (value.receiptSha256 !== null) ||
      (value.state === 'NOT_REQUESTED') !== (value.observedAt === null)
    )
      context.addIssue({
        code: 'custom',
        message: 'Confirmed execution needs an exact durable receipt.',
      });
  });
export type CommercialAiQualityExecution = z.infer<typeof commercialAiQualityExecutionSchema>;

export const commercialAiQualityAttemptSchema = z
  .object({
    sourceKey: digest,
    inputSha256: digest,
    nonce: z.string().uuid(),
    sourceVersion: z.union([z.literal(1), z.literal(2)]),
    sourceSha256: digest,
    settingsSha256: digest,
    settingsProfileDigest: digest,
    classifierIdentitySha256: digest,
    submittedAtMs: clock,
    eventAtMs: clock,
    deadlineAtMs: clock,
    activeAuthority: z.enum(['DETERMINISTIC', 'AI_DELETE_ONLY', 'OBSERVE', 'UNKNOWN']),
    actualSynchronousDecision: z
      .object({
        semantics: z.literal('actual_post_routing_v1'),
        decision: decision.nullable(),
      })
      .strict(),
    detectorBaseline: z
      .object({
        semantics: z.literal('counterfactual_pre_routing_v1'),
        detectorSourceSha256: digest,
        decision,
      })
      .strict()
      .nullable(),
    admission: commercialAiQualityAdmissionSchema,
    analysis: commercialAiQualityAnalysisSchema,
    registration: commercialAiQualityRegistrationSchema,
    execution: commercialAiQualityExecutionSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.deadlineAtMs <= value.eventAtMs ||
      value.deadlineAtMs - value.eventAtMs > 60_000 ||
      value.submittedAtMs < value.eventAtMs ||
      value.submittedAtMs >= value.deadlineAtMs ||
      (value.analysis.state !== 'NOT_STARTED' && value.admission.state !== 'ACCEPTED') ||
      (value.analysis.observedAt !== null &&
        Date.parse(value.analysis.observedAt) < value.submittedAtMs) ||
      (value.registration.state === 'REGISTERED' && value.analysis.policyDeleteEligible !== true) ||
      (['CONFIRMED_DELETE', 'ALREADY_ABSENT', 'PENDING'].includes(value.execution.state) &&
        value.registration.state !== 'REGISTERED')
    )
      context.addIssue({ code: 'custom', message: 'Contradictory observation lifecycle.' });
  });
export type CommercialAiQualityAttempt = z.infer<typeof commercialAiQualityAttemptSchema>;

// FLAG: This envelope is observational and bounded; it grants no model, review or effect authority.
export const commercialAiQualityEnvelopeSchema = z
  .object({
    schemaVersion: z.literal(1),
    captureState: z.literal('OBSERVED'),
    source: commercialAiQualitySourceBindingSchema,
    attempts: z
      .array(commercialAiQualityAttemptSchema)
      .min(1)
      .max(COMMERCIAL_AI_QUALITY_MAX_ATTEMPTS),
    overflowWriteCount: z.number().int().min(0).max(2_147_483_647),
    lastOverflowAt: z.string().datetime().nullable(),
    coverageIncomplete: z.boolean(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      new Set(value.attempts.map((attempt) => attempt.sourceKey)).size !== value.attempts.length ||
      value.overflowWriteCount > 0 !== (value.lastOverflowAt !== null) ||
      (value.overflowWriteCount > 0 && !value.coverageIncomplete) ||
      (value.attempts.some(
        (attempt) =>
          attempt.detectorBaseline === null ||
          attempt.actualSynchronousDecision.decision === null ||
          attempt.activeAuthority === 'UNKNOWN',
      ) &&
        !value.coverageIncomplete) ||
      new TextEncoder().encode(JSON.stringify(value)).byteLength >
        COMMERCIAL_AI_QUALITY_MAX_ENVELOPE_BYTES
    )
      context.addIssue({ code: 'custom', message: 'Incomplete attempt accounting.' });
  });
export type CommercialAiQualityEnvelope = z.infer<typeof commercialAiQualityEnvelopeSchema>;
export const commercialAiQualityProjectionSchema = z.union([
  commercialAiQualityEnvelopeSchema,
  z
    .object({
      schemaVersion: z.literal(1),
      captureState: z.literal('INVALID'),
      coverageIncomplete: z.literal(true),
    })
    .strict(),
]);
export type CommercialAiQualityProjection = z.infer<typeof commercialAiQualityProjectionSchema>;

// FLAG: Detailed AI evidence is private export data; generic Safety Desk lists never import this tree.
export const commercialAiReviewItemSchema = commercialReviewItemSchema
  .safeExtend({ llmEnforcement: commercialAiQualityProjectionSchema.nullable().optional() })
  .strict()
  .superRefine((item, context) => {
    if (!item.decisionVisible && item.llmEnforcement != null)
      context.addIssue({
        code: 'custom',
        message: 'AI evidence remains hidden before own review.',
      });
  });
export type CommercialAiReviewItem = z.infer<typeof commercialAiReviewItemSchema>;

export const commercialAiReviewExportItemSchema =
  commercialReviewExportResponseSchema.shape.items.element
    .safeExtend({ sample: commercialAiReviewItemSchema })
    .strict();
export type CommercialAiReviewExportItem = z.infer<typeof commercialAiReviewExportItemSchema>;

export const commercialAiReviewExportResponseSchema = commercialReviewExportResponseSchema
  .safeExtend({ items: z.array(commercialAiReviewExportItemSchema).max(500) })
  .strict();
export type CommercialAiReviewExportResponse = z.infer<
  typeof commercialAiReviewExportResponseSchema
>;
