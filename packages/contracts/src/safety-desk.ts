import { z } from 'zod';
import {
  commercialReviewSemanticAnnotationRequestSchema,
  commercialReviewSemanticAnnotationSchema,
} from './commercial-review-semantics.js';
export {
  commercialReviewSemanticCohortSchema,
  commercialReviewSemanticAnnotationRequestSchema,
  commercialReviewSemanticAnnotationSchema,
  resolveCommercialLabelAuthority,
  resolveCommercialSemanticReview,
  type CommercialReviewSemanticCohort,
  type CommercialReviewSemanticAnnotationRequest,
} from './commercial-review-semantics.js';
export {
  commercialAiPoolDiagnosticsSchema,
  safetyDeskCommercialAiPoolResponseSchema,
  type CommercialAiPoolDiagnostics,
  type SafetyDeskCommercialAiPoolResponse,
} from './safety-desk-commercial-ai-pool.js';
export {
  safetyDeskCommercialAiResponseSchema,
  type SafetyDeskCommercialAiResponse,
} from './safety-desk-commercial-ai.js';
export {
  safetyDeskDeleteCohortResponseSchema,
  safetyDeskDeleteCohortRowSchema,
  safetyDeskDeleteCohortStatusSchema,
  safetyDeskDeleteCohortOutcomeSchema,
  type SafetyDeskDeleteCohortResponse,
  type SafetyDeskDeleteCohortRow,
} from './safety-desk-delete-cohort.js';
export {
  safetyDeskPublicationDeliveryCohortResponseSchema,
  type SafetyDeskPublicationDeliveryCohortResponse,
} from './safety-desk-publication-delivery-cohort.js';
export {
  safetyDeskPublicationDeliveryEvidenceResponseSchema,
  safetyDeskPublicationDeliveryContextSchema,
  safetyDeskPublicationDeliveryStatusSchema,
  safetyDeskPublicationDeliveryReceiptSchema,
  safetyDeskPublicationDeliveryVerificationSchema,
  safetyDeskPublicationDeliveryWaitReasonSchema,
  safetyDeskPublicationDeliveryWaitingSchema,
  type SafetyDeskPublicationDeliveryEvidenceResponse,
  type SafetyDeskPublicationDeliveryWaiting,
  type SafetyDeskPublicationDeliveryWaitReason,
} from './safety-desk-publication-delivery-evidence.js';
import { broadcastTextFormatSchema } from './broadcast-common.js';
import {
  messageRetentionHoursSchema,
  messageRetentionSummarySchema,
} from './message-retention-summary.js';
import { VK_PARSING_MAX_VIDEOS } from './vk-parsing-common.js';
import {
  messageRetentionCoverageSchema,
  messageRetentionProgressSchema,
} from './message-retention.js';

export {
  safetyDeskWebhookStatusSchema,
  safetyDeskWebhookCohortRowSchema,
  safetyDeskWebhookCohortResponseSchema,
  type SafetyDeskWebhookCohortResponse,
  type SafetyDeskWebhookCohortRow,
} from './safety-desk-observability.js';
export {
  safetyDeskPublicationCohortStatusSchema,
  safetyDeskPublicationCohortRowSchema,
  safetyDeskPublicationCohortResponseSchema,
  type SafetyDeskPublicationCohortResponse,
  type SafetyDeskPublicationCohortRow,
} from './safety-desk-publication-cohort.js';

export const commercialReviewLabelSchema = z.enum(['COMMERCIAL', 'NOT_COMMERCIAL', 'UNSURE']);
export type CommercialReviewLabel = z.infer<typeof commercialReviewLabelSchema>;
export const commercialReviewDispositionSchema = z.enum(['KEEP', 'DELETE']);
export const commercialReviewDecisionSnapshotSchema = z.object({
  hasDetection: z.boolean().nullable().default(null),
  actionable: z.boolean().nullable().default(null),
  deleteEligible: z.boolean().nullable().default(null),
  score: z.number().min(0).max(100),
  actionBand: z.string().max(120),
  messageDisposition: commercialReviewDispositionSchema,
  detectorVersion: z.string().max(120),
  decisionFingerprint: z.string().max(120),
  reasons: z.array(z.string().max(120)).max(32),
  requiredPolicyCohorts: z.array(z.string().max(120)).max(32),
});
export const commercialReviewEvidenceMetadataSchema = z.object({
  schemaVersion: z.literal(2),
  samplingProbability: z.number().min(0).max(1).nullable(),
  randomEvaluationIncluded: z.boolean().nullable().default(null),
  evaluationSamplingProbability: z.number().min(0).max(1).nullable().default(null),
  samplingStratum: z.enum(['HIT', 'REVIEW', 'NO_HIT', 'TECHNICAL', 'UNKNOWN']),
  logicalMessageKey: z.string().max(120).nullable(),
  authorGroupId: z.string().max(120).nullable(),
  campaignGroupId: z.string().max(120).nullable(),
  campaignGroupIds: z.array(z.string().max(120)).max(32).default([]),
  campaignGroupingComplete: z.boolean().nullable().default(null),
  sourceSnapshotSha256: z
    .string()
    .regex(/^[a-f0-9]{64}$/u)
    .nullable(),
  pseudonymizationKeyId: z
    .string()
    .regex(/^[a-f0-9]{64}$/u)
    .nullable()
    .default(null),
  imageReviewRequired: z.boolean(),
  sourceExcerptComplete: z.boolean().nullable(),
  messageCreatedAt: z.string().datetime().nullable(),
  settingsProfileDigest: z
    .string()
    .regex(/^[a-f0-9]{64}$/u)
    .nullable(),
  detectorSourceSha256: z
    .string()
    .regex(/^[a-f0-9]{64}$/u)
    .nullable(),
  hasDetection: z.boolean().nullable(),
  decisionOutcome: commercialReviewDispositionSchema.nullable(),
  deleteEligible: z.boolean().nullable(),
  executionOutcome: z.enum([
    'UNKNOWN',
    'PENDING',
    'CONFIRMED_DELETE',
    'ALREADY_ABSENT',
    'NOT_REQUESTED',
  ]),
  analysisOutcome: z.enum(['COMPLETE', 'TECHNICAL_INCOMPLETE', 'NOT_APPLICABLE', 'UNKNOWN']),
  candidateDecision: commercialReviewDecisionSnapshotSchema.nullable(),
});
export type CommercialReviewEvidenceMetadata = z.infer<
  typeof commercialReviewEvidenceMetadataSchema
>;
export const commercialReviewOwnReviewSchema = z.object({
  label: commercialReviewLabelSchema,
  expectedDisposition: commercialReviewDispositionSchema.nullable(),
  reason: z.string().max(500),
  reviewedAt: z.string().datetime(),
  kind: z.enum(['INDEPENDENT', 'ADJUDICATION', 'SEMANTIC_ADJUDICATION']),
  evidenceKind: z.enum(['TEXT', 'CAPTION_ONLY', 'PRIVATE_SOURCE_IMAGE']),
  semanticAnnotation: commercialReviewSemanticAnnotationSchema.nullable().optional(),
});
export const commercialReviewItemSchema = z
  .object({
    id: z.string(),
    chatId: z.string().nullable(),
    chatTitle: z.string(),
    source: z.enum(['TEXT', 'OCR']),
    excerpt: z.string().max(2500),
    score: z.number().min(0).max(100).nullable(),
    actionBand: z.string().nullable(),
    messageDisposition: commercialReviewDispositionSchema.nullable(),
    requiredPolicyCohorts: z.array(z.string()).max(32),
    detectorVersion: z.string(),
    decisionFingerprint: z.string(),
    reviewPriority: z.number().int().min(0).max(100).nullable(),
    reasons: z.array(z.string()).max(32),
    label: commercialReviewLabelSchema.nullable(),
    reviewReason: z.string().max(500),
    reviewedAt: z.string().datetime().nullable(),
    ownReview: commercialReviewOwnReviewSchema.nullable(),
    historicalLabel: commercialReviewLabelSchema.nullable(),
    reviewState: z.enum(['UNREVIEWED', 'AWAITING_SECOND', 'DISAGREEMENT', 'RESOLVED']),
    independentReviewCount: z.number().int().min(0).max(2),
    decisionVisible: z.boolean(),
    canReview: z.boolean(),
    canAdjudicate: z.boolean(),
    imageEvidenceAvailable: z.boolean(),
    semanticAnnotationAllowed: z.boolean().default(false),
    sourceExcerptComplete: z.boolean().nullable(),
    evidenceMetadata: commercialReviewEvidenceMetadataSchema.nullable(),
    observedAt: z.string().datetime(),
    expiresAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .superRefine((item, context) => {
    if (
      !item.decisionVisible &&
      (item.score !== null ||
        item.actionBand !== null ||
        item.messageDisposition !== null ||
        item.reviewPriority !== null ||
        item.reasons.length ||
        item.requiredPolicyCohorts.length ||
        item.detectorVersion !== 'unknown' ||
        item.decisionFingerprint !== 'unknown' ||
        item.evidenceMetadata !== null ||
        item.label !== null ||
        item.historicalLabel !== null ||
        item.reviewReason !== '' ||
        item.reviewedAt !== null ||
        item.ownReview !== null)
    )
      context.addIssue({
        code: 'custom',
        message: 'Blind review must not expose decision evidence.',
      });
  });
export type CommercialReviewItem = z.infer<typeof commercialReviewItemSchema>;
export const commercialReviewQueueQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().max(500).optional(),
  status: z.enum(['PENDING', 'REVIEWED', 'ALL']).default('PENDING'),
});
export const commercialReviewQueueResponseSchema = z.object({
  generatedAt: z.string().datetime(),
  items: z.array(commercialReviewItemSchema),
  nextCursor: z.string().nullable(),
});
export type CommercialReviewQueueResponse = z.infer<typeof commercialReviewQueueResponseSchema>;
export const commercialReviewDecisionRequestSchema = z
  .object({
    expectedUpdatedAt: z.string().datetime(),
    label: commercialReviewLabelSchema,
    expectedDisposition: commercialReviewDispositionSchema.nullable().optional(),
    reason: z.string().trim().max(500).default(''),
    semanticAnnotation: commercialReviewSemanticAnnotationRequestSchema.optional(),
  })
  .strict()
  .superRefine((review, context) => {
    if (review.label === 'NOT_COMMERCIAL' && review.expectedDisposition === 'DELETE')
      context.addIssue({
        code: 'custom',
        path: ['expectedDisposition'],
        message: 'Protected messages must be kept.',
      });
    if (review.label === 'UNSURE' && review.expectedDisposition != null)
      context.addIssue({
        code: 'custom',
        path: ['expectedDisposition'],
        message: 'An uncertain review cannot authorize a disposition.',
      });
  });
export type CommercialReviewDecisionRequest = z.infer<typeof commercialReviewDecisionRequestSchema>;
export const commercialReviewAdjudicationRequestSchema = commercialReviewDecisionRequestSchema;
export const commercialReviewExportQuerySchema = z
  .object({
    since: z.string().datetime(),
    until: z.string().datetime(),
    limit: z.coerce.number().int().min(1).max(500).default(100),
    cursor: z.string().max(500).optional(),
  })
  .strict()
  .refine(
    (query) => Date.parse(query.since) < Date.parse(query.until),
    'The export window must be ordered.',
  )
  .refine(
    (query) => Date.parse(query.until) - Date.parse(query.since) <= 14 * 86_400_000,
    'The export window cannot exceed the fourteen-day retention period.',
  );
export const commercialReviewExportResponseSchema = z.object({
  generatedAt: z.string().datetime(),
  scope: z.literal('OWN_REVIEWED'),
  populationCoverageAvailable: z.literal(false),
  since: z.string().datetime(),
  until: z.string().datetime(),
  items: z
    .array(
      z.object({
        sample: commercialReviewItemSchema,
        ratings: z
          .array(
            commercialReviewOwnReviewSchema.extend({
              reviewerKey: z.string().regex(/^[a-f0-9]{64}$/u),
              sourceEvidenceDigest: z
                .string()
                .regex(/^[a-f0-9]{64}$/u)
                .nullable(),
            }),
          )
          .max(3),
        eligibleForIndependentCorpus: z.boolean(),
      }),
    )
    .max(500),
  nextCursor: z.string().nullable(),
  complete: z.boolean(),
});
export type CommercialReviewExportResponse = z.infer<typeof commercialReviewExportResponseSchema>;
export const commercialReviewSamplingFrameQuerySchema = commercialReviewExportQuerySchema;
export const commercialReviewSamplingFrameItemSchema = z
  .object({
    source: z.enum(['TEXT', 'OCR']),
    observedAt: z.string().datetime(),
    sourceSnapshotSha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/u)
      .nullable(),
    logicalMessageKey: z
      .string()
      .regex(/^[a-f0-9]{64}$/u)
      .nullable(),
    pseudonymizationKeyId: z
      .string()
      .regex(/^[a-f0-9]{64}$/u)
      .nullable(),
    settingsProfileDigest: z
      .string()
      .regex(/^[a-f0-9]{64}$/u)
      .nullable(),
    campaignGroupingComplete: z.boolean().nullable(),
    messageCreatedAt: z.string().datetime().nullable(),
    evaluationSamplingProbability: z.number().min(0).max(1).nullable(),
  })
  .strict();
export const commercialReviewSamplingFrameResponseSchema = z
  .object({
    schemaVersion: z.literal(1),
    generatedAt: z.string().datetime(),
    scope: z.literal('RANDOM_EVALUATION_FRAME'),
    // The frame covers retained capture rows; ingress capture is best-effort.
    populationCoverageAvailable: z.literal(false),
    since: z.string().datetime(),
    until: z.string().datetime(),
    scannedCaptureRows: z.number().int().min(0).max(500),
    samplingUnavailableRows: z.number().int().min(0).max(500),
    items: z.array(commercialReviewSamplingFrameItemSchema).max(500),
    nextCursor: z.string().nullable(),
    complete: z.boolean(),
  })
  .strict();
export type CommercialReviewSamplingFrameResponse = z.infer<
  typeof commercialReviewSamplingFrameResponseSchema
>;

export const safetyDeskReviewStatusSchema = z.enum(['REVIEW', 'APPROVED', 'REJECTED', 'BLOCKED']);
export type SafetyDeskReviewStatus = z.infer<typeof safetyDeskReviewStatusSchema>;

export const safetyDeskRiskLevelSchema = z.enum(['LOW', 'MEDIUM', 'HIGH', 'BLOCKED']);
export type SafetyDeskRiskLevel = z.infer<typeof safetyDeskRiskLevelSchema>;

export const safetyDeskQueueSourceSchema = z.enum(['VK_REVIEW']);
export type SafetyDeskQueueSource = z.infer<typeof safetyDeskQueueSourceSchema>;

export const safetyDeskCheckSchema = z.object({
  label: z.string(),
  state: z.enum(['PASSED', 'WARNING', 'BLOCKED']),
});
export type SafetyDeskCheck = z.infer<typeof safetyDeskCheckSchema>;

export const safetyDeskQueueItemSchema = z.object({
  id: z.string(),
  source: safetyDeskQueueSourceSchema,
  sourceId: z.string(),
  chatId: z.string(),
  entityTitle: z.string(),
  sourceTitle: z.string(),
  author: z.string(),
  status: safetyDeskReviewStatusSchema,
  risk: safetyDeskRiskLevelSchema,
  title: z.string(),
  text: z.string(),
  textFormat: broadcastTextFormatSchema.default('plain'),
  previewHtml: z.string().default(''),
  domains: z.array(z.string()).default([]),
  photoUrls: z.array(z.string().url()).default([]),
  videoUrls: z.array(z.string().url()).max(VK_PARSING_MAX_VIDEOS).default([]),
  linkUrls: z.array(z.string().url()).default([]),
  originalUrl: z.string().url().nullable().default(null),
  scheduledAt: z.string().datetime().nullable().default(null),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  reasons: z.array(z.string()).default([]),
  checks: z.array(safetyDeskCheckSchema).default([]),
});
export type SafetyDeskQueueItem = z.infer<typeof safetyDeskQueueItemSchema>;

export const safetyDeskAuditEntrySchema = z.object({
  id: z.string(),
  itemId: z.string().nullable().default(null),
  action: z.string(),
  title: z.string(),
  createdAt: z.string().datetime(),
});
export type SafetyDeskAuditEntry = z.infer<typeof safetyDeskAuditEntrySchema>;

export const safetyDeskSummarySchema = z.object({
  review: z.number().int().min(0).default(0),
  approved: z.number().int().min(0).default(0),
  rejected: z.number().int().min(0).default(0),
  blocked: z.number().int().min(0).default(0),
  servicePosts: z.number().int().min(0).default(0),
});
export type SafetyDeskSummary = z.infer<typeof safetyDeskSummarySchema>;

export const safetyDeskQueueResponseSchema = z.object({
  generatedAt: z.string().datetime(),
  items: z.array(safetyDeskQueueItemSchema).default([]),
  summary: safetyDeskSummarySchema,
  audit: z.array(safetyDeskAuditEntrySchema).default([]),
});
export type SafetyDeskQueueResponse = z.infer<typeof safetyDeskQueueResponseSchema>;

export const safetyDeskDecisionRequestSchema = z.object({
  reason: z.string().trim().max(500).optional(),
});
export type SafetyDeskDecisionRequest = z.infer<typeof safetyDeskDecisionRequestSchema>;

export const safetyDeskApproveAllRequestSchema = z.object({
  itemIds: z.array(z.string().trim().min(1)).min(1).max(100),
  reason: z.string().trim().max(500).optional(),
});
export type SafetyDeskApproveAllRequest = z.infer<typeof safetyDeskApproveAllRequestSchema>;

export const safetyDeskDecisionResponseSchema = z.object({
  item: safetyDeskQueueItemSchema.nullable().default(null),
  queue: safetyDeskQueueResponseSchema,
  message: z.string(),
});
export type SafetyDeskDecisionResponse = z.infer<typeof safetyDeskDecisionResponseSchema>;

export const safetyDeskDeleteIntentStatusSchema = z.enum([
  'OBSERVED',
  'PENDING',
  'IN_PROGRESS',
  'RETRYABLE',
  'WAITING_CAPABILITY',
  'AMBIGUOUS',
  'SUCCEEDED',
  'ALREADY_ABSENT',
  'EXPIRED',
  'FAILED_TERMINAL',
]);
export type SafetyDeskDeleteIntentStatus = z.infer<typeof safetyDeskDeleteIntentStatusSchema>;

export const safetyDeskDeleteIntentStatusCountsSchema = z.object({
  OBSERVED: z.number().int().nonnegative(),
  PENDING: z.number().int().nonnegative(),
  IN_PROGRESS: z.number().int().nonnegative(),
  RETRYABLE: z.number().int().nonnegative(),
  WAITING_CAPABILITY: z.number().int().nonnegative(),
  AMBIGUOUS: z.number().int().nonnegative(),
  SUCCEEDED: z.number().int().nonnegative(),
  ALREADY_ABSENT: z.number().int().nonnegative(),
  EXPIRED: z.number().int().nonnegative(),
  FAILED_TERMINAL: z.number().int().nonnegative(),
});
export type SafetyDeskDeleteIntentStatusCounts = z.infer<
  typeof safetyDeskDeleteIntentStatusCountsSchema
>;

export const safetyDeskDeleteCapabilityStateSchema = z.enum([
  'confirmed_capable',
  'stale_or_unknown',
  'explicitly_incapable',
]);
export type SafetyDeskDeleteCapabilityState = z.infer<typeof safetyDeskDeleteCapabilityStateSchema>;

export const safetyDeskDeleteCapabilityReasonSchema = z.enum([
  'confirmed',
  'snapshot_missing',
  'snapshot_stale',
  'access_denied',
  'access_state_unconfirmed',
  'bot_not_actionable',
  'not_admin_or_owner',
  'entity_type_unknown',
  'missing_chat_delete_permission',
  'missing_channel_delete_permission',
]);
export type SafetyDeskDeleteCapabilityReason = z.infer<
  typeof safetyDeskDeleteCapabilityReasonSchema
>;

export const safetyDeskDeleteMembershipCapabilitySchema = z.object({
  botId: z.string(),
  role: z.enum(['PRIMARY', 'STANDBY']),
  accessState: z.enum([
    'UNKNOWN',
    'CONFIRMED_OWNER',
    'CONFIRMED_ADMIN',
    'CONFIRMED_MEMBER',
    'DENIED',
    'LOST',
    'STALE',
  ]),
  botRuntimeState: z.enum(['active', 'draining', 'dormant', 'disabled', 'unconfigured']),
  state: safetyDeskDeleteCapabilityStateSchema,
  reason: safetyDeskDeleteCapabilityReasonSchema,
  checkedAt: z.string().datetime().nullable(),
  expiresAt: z.string().datetime().nullable(),
  snapshotCheckedAt: z.string().datetime().nullable(),
  isAdmin: z.boolean(),
  isOwner: z.boolean(),
  permissions: z.array(z.string()).default([]),
});
export type SafetyDeskDeleteMembershipCapability = z.infer<
  typeof safetyDeskDeleteMembershipCapabilitySchema
>;

export const safetyDeskDeleteIntentReasonSchema = z.object({
  reasonKey: z.string(),
  ruleCode: z.string(),
  userId: z.string().nullable(),
  score: z.number(),
  createdAt: z.string().datetime(),
});
export type SafetyDeskDeleteIntentReason = z.infer<typeof safetyDeskDeleteIntentReasonSchema>;

export const safetyDeskDeleteIntentItemSchema = z.object({
  id: z.string(),
  chatId: z.string(),
  chatTitle: z.string(),
  messageId: z.string(),
  subjectUserId: z.string().nullable(),
  entityType: z.enum(['CHAT', 'CHANNEL']).nullable(),
  originBotId: z.string().nullable(),
  routingPolicy: z.enum(['delete_capable', 'origin_first', 'origin_only']),
  effectiveRoutingPolicy: z.enum(['delete_capable', 'origin_first', 'origin_only']),
  crossBotEnabled: z.boolean(),
  routingState: z.enum(['READY', 'NO_ELIGIBLE_BOT']),
  rollout: z.enum(['off', 'observed', 'execute']),
  retentionOwned: z.boolean().default(false),
  retryAllowed: z.boolean().default(false),
  status: safetyDeskDeleteIntentStatusSchema,
  ageMs: z.number().int().nonnegative(),
  attemptCount: z.number().int().nonnegative(),
  executeAt: z.string().datetime(),
  nextAttemptAt: z.string().datetime(),
  retryUntilAt: z.string().datetime(),
  firstAttemptAt: z.string().datetime().nullable(),
  lastAttemptAt: z.string().datetime().nullable(),
  completedAt: z.string().datetime().nullable(),
  leaseExpiresAt: z.string().datetime().nullable(),
  deleteDispatchStartedAt: z.string().datetime().nullable(),
  deleteDispatchStartedBotId: z.string().nullable(),
  remoteDeleteSucceededAt: z.string().datetime().nullable(),
  remoteDeleteSucceededBotId: z.string().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  lastBotId: z.string().nullable(),
  succeededBotId: z.string().nullable(),
  lastStatusCode: z.number().int().nullable(),
  lastErrorCode: z.string().nullable(),
  lastError: z.string().nullable(),
  capability: z.object({
    confirmed: z.boolean(),
    activeMembershipCount: z.number().int().nonnegative(),
    confirmedBotIds: z.array(z.string()).default([]),
    memberships: z.array(safetyDeskDeleteMembershipCapabilitySchema).default([]),
  }),
  reasons: z.array(safetyDeskDeleteIntentReasonSchema).default([]),
});
export type SafetyDeskDeleteIntentItem = z.infer<typeof safetyDeskDeleteIntentItemSchema>;

export const safetyDeskAmbiguousSendItemSchema = z.object({
  id: z.string(),
  source: z.enum(['channel_auto_post', 'chat_auto_comment', 'chat_rules']),
  chatId: z.string(),
  chatTitle: z.string(),
  messageId: z.string().nullable(),
  botId: z.string().nullable(),
  startedAt: z.string().datetime(),
  detectedAt: z.string().datetime(),
  lastError: z.string(),
});
export type SafetyDeskAmbiguousSendItem = z.infer<typeof safetyDeskAmbiguousSendItemSchema>;

export const safetyDeskGiveawayWinnerNotificationDeadEndStatusSchema = z.enum([
  'AMBIGUOUS',
  'FAILED_TERMINAL',
]);
export type SafetyDeskGiveawayWinnerNotificationDeadEndStatus = z.infer<
  typeof safetyDeskGiveawayWinnerNotificationDeadEndStatusSchema
>;

export const safetyDeskGiveawayWinnerNotificationDeadEndItemSchema = z.object({
  notificationId: z.string(),
  giveawayId: z.string(),
  giveawayTitle: z.string(),
  sourceChatId: z.string(),
  winnerId: z.string(),
  userId: z.string(),
  botId: z.string().nullable(),
  status: safetyDeskGiveawayWinnerNotificationDeadEndStatusSchema,
  attemptCount: z.number().int().nonnegative(),
  lastError: z.string().max(1_000).nullable(),
  nextAttemptAt: z.string().datetime(),
  lockedAt: z.string().datetime().nullable(),
  dispatchedAt: z.string().datetime().nullable(),
  ambiguousAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type SafetyDeskGiveawayWinnerNotificationDeadEndItem = z.infer<
  typeof safetyDeskGiveawayWinnerNotificationDeadEndItemSchema
>;

const safetyDeskDeleteRuntimeWindowSchema = z.object({
  count: z.number().int().nonnegative(),
  oldestAt: z.string().datetime().nullable(),
});

export const safetyDeskDeleteRuntimeResponseSchema = z.object({
  generatedAt: z.string().datetime(),
  rolloutMode: z.enum(['off', 'shadow', 'canary', 'on']),
  replacementCleanupEnabled: z.boolean().default(false),
  summary: z.object({
    total: z.number().int().nonnegative(),
    open: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    statusCounts: safetyDeskDeleteIntentStatusCountsSchema,
    due: safetyDeskDeleteRuntimeWindowSchema,
    staleLeases: safetyDeskDeleteRuntimeWindowSchema,
    ambiguousSends: safetyDeskDeleteRuntimeWindowSchema,
    giveawayWinnerNotificationDeadEnds: z.object({
      count: z.number().int().nonnegative(),
      ambiguous: z.number().int().nonnegative(),
      failedTerminal: z.number().int().nonnegative(),
      oldestAt: z.string().datetime().nullable(),
    }),
    oldestOpen: z.object({
      createdAt: z.string().datetime().nullable(),
      ageMs: z.number().int().nonnegative().nullable(),
    }),
  }),
  items: z.array(safetyDeskDeleteIntentItemSchema).default([]),
  ambiguousSends: z.array(safetyDeskAmbiguousSendItemSchema).default([]),
  giveawayWinnerNotificationDeadEnds: z
    .array(safetyDeskGiveawayWinnerNotificationDeadEndItemSchema)
    .max(50)
    .default([]),
});
export type SafetyDeskDeleteRuntimeResponse = z.infer<typeof safetyDeskDeleteRuntimeResponseSchema>;

export const safetyDeskAllowAmbiguousSendRetryRequestSchema = z
  .object({
    expectedOperationId: z.string().trim().min(1),
    expectedStartedAt: z.string().datetime(),
  })
  .strict();
export type SafetyDeskAllowAmbiguousSendRetryRequest = z.infer<
  typeof safetyDeskAllowAmbiguousSendRetryRequestSchema
>;

export const safetyDeskRetryDeleteIntentRequestSchema = z
  .object({
    expectedStatus: z.enum(['EXPIRED', 'FAILED_TERMINAL']),
    expectedUpdatedAt: z.string().datetime(),
    expectedAttemptCount: z.number().int().nonnegative(),
  })
  .strict();
export type SafetyDeskRetryDeleteIntentRequest = z.infer<
  typeof safetyDeskRetryDeleteIntentRequestSchema
>;

export const safetyDeskRetentionDiagnosticsSchema = z.object({
  // FLAG: Runtime errors may contain upstream text; only known reasons cross the owner API.
  lastError: z
    .enum([
      'bot_removed',
      'eraser_rights_missing',
      'membership_unknown',
      'queue_unavailable',
      'worker_error',
      'transport_unknown',
      'malformed_response',
      'pin_unknown',
      'history_unknown',
      'history_boundary_unknown',
      'history_duplicate',
      'delete_unconfirmed',
      'unknown',
    ])
    .nullable()
    .catch('unknown'),
  historyBoundaryBlocked: z.boolean(),
  awaitingCurrentProtection: z.boolean(),
  awaitingHistoricalProtection: z.boolean(),
});

export const safetyDeskRetentionConnectionRequestSchema = z.object({
  status: z.enum(['pending', 'expired', 'cancelled', 'activated']),
  operationId: z.string().uuid(),
  actorUserId: z.string().min(1),
  policyRevision: z.number().int().nonnegative(),
  expiresAt: z.string().datetime(),
  nextAttemptAt: z.string().datetime().nullable(),
  updatedAt: z.string().datetime(),
  lastError: z
    .enum([
      'bot_removed',
      'eraser_rights_missing',
      'membership_unknown',
      'actor_rights_missing',
      'queue_race',
      'queue_unavailable',
      'connection_proof_stale',
      'connection_guard_changed',
      'connection_check_failed',
      'ERASER_CONNECTION_STOPPED',
      'transport_unknown',
      'malformed_response',
      'unknown',
    ])
    .nullable()
    .catch('unknown'),
});

const retentionSourceSchema = z.enum(['eraser', 'legacy']);

export const safetyDeskRetentionRuntimeItemSchema = z.object({
  chatId: z.string().min(1),
  chatTitle: z.string(),
  enabled: z.boolean(),
  hours: messageRetentionHoursSchema,
  revision: z.number().int().nonnegative(),
  activationId: z.string().min(1),
  pendingCount: z.number().int().nonnegative(),
  deletedCount: z.number().int().nonnegative(),
  skippedCount: z.number().int().nonnegative(),
  status: messageRetentionSummarySchema.shape.status,
  oldestDueAt: z.string().datetime().nullable(),
  source: retentionSourceSchema.optional(),
  sourceStatus: z.literal('available').optional(),
  progress: messageRetentionProgressSchema.optional(),
  coverage: messageRetentionCoverageSchema.optional(),
  connectionRequest: safetyDeskRetentionConnectionRequestSchema.nullable().optional(),
  confirmationCounts: z
    .object({
      historicalUnknown: z.number().int().nonnegative(),
      deleteAcknowledged: z.number().int().nonnegative(),
      removalReceipt: z.number().int().nonnegative(),
    })
    .optional(),
  nextRunAt: z.string().datetime().nullable(),
  hasTerminalReview: z.boolean(),
  hasUnresolvedReceipt: z.boolean(),
  connectionStatus: z.enum(['connected', 'missing', 'no_access', 'unknown']).optional(),
  historyStatus: z.enum(['pending', 'running', 'complete', 'blocked', 'off']).optional(),
  historyScannedCount: z.number().int().nonnegative().optional(),
  diagnostics: safetyDeskRetentionDiagnosticsSchema.optional(),
  captureAfter: z.string().datetime().nullable().optional(),
  pausedAt: z.string().datetime().nullable().optional(),
  updatedAt: z.string().datetime().optional(),
});
export type SafetyDeskRetentionRuntimeItem = z.infer<typeof safetyDeskRetentionRuntimeItemSchema>;

const retentionWorkerHealthSchema = z.object({
  healthy: z.boolean(),
  ready: z.boolean(),
  running: z.boolean(),
  sampledAt: z.string().datetime().nullable(),
  occupiedSlots: z.number().int().nonnegative(),
  oldestOccupiedAt: z.string().datetime().nullable(),
  lastCompletedAt: z.string().datetime().nullable(),
  lastErrorAt: z.string().datetime().nullable(),
  lastErrorCode: z
    .enum(['worker_error', 'job_failed', 'job_stalled', 'worker_closed', 'unknown'])
    .nullable()
    .catch('unknown'),
  progressOverdue: z.boolean(),
});

export const safetyDeskRetentionTransportMetricsSchema = z.object({
  scope: z.literal('process'),
  since: z.string().datetime(),
  observedAt: z.string().datetime(),
  requests: z
    .array(
      z.object({
        purpose: z.enum([
          'bot_rights',
          'actor_rights',
          'pin',
          'live_scan',
          'history_scan',
          'safety_rights',
          'safety_scan',
          'delete',
          'presence',
          'identity',
          'subscriptions',
        ]),
        attempts: z.number().int().nonnegative(),
        responses: z.number().int().nonnegative(),
        httpSuccesses: z.number().int().nonnegative(),
        rateLimited: z.number().int().nonnegative(),
        transportErrors: z.number().int().nonnegative(),
      }),
    )
    .max(11),
  cooldownDeferrals: z.number().int().nonnegative(),
  admissionUnavailable: z.number().int().nonnegative(),
  guardRejected: z.number().int().nonnegative(),
  deleteAcknowledged: z.number().int().nonnegative(),
  observedCooldownUntil: z.string().datetime().nullable(),
});

export const safetyDeskRetentionRuntimeResponseSchema = z.object({
  generatedAt: z.string().datetime(),
  mode: z.enum(['off', 'shadow', 'canary', 'on']),
  nextAfter: z.string().min(1).nullable(),
  incomplete: z.boolean().optional(),
  transportMetrics: safetyDeskRetentionTransportMetricsSchema.optional(),
  cooldown: z.object({ durableUntil: z.string().datetime().nullable() }).optional(),
  health: z
    .object({
      schedulerLastSuccessfulAt: z.string().datetime().nullable(),
      schedulerHealthy: z.boolean(),
      connectionSchedulerLastSuccessfulAt: z.string().datetime().nullable().optional(),
      connectionSchedulerHealthy: z.boolean().optional(),
      workers: z
        .object({ cleanup: retentionWorkerHealthSchema, connection: retentionWorkerHealthSchema })
        .optional(),
    })
    .optional(),
  unavailableSources: z
    .array(
      z.object({
        chatId: z.string().min(1),
        chatTitle: z.string(),
        source: retentionSourceSchema,
        reason: z.enum(['unavailable', 'not_initialized', 'invalid_response']),
      }),
    )
    .max(50)
    .optional(),
  quotas: z
    .array(
      z.object({
        shard: z.number().int().nonnegative(),
        pendingCount: z.number().int().nonnegative(),
        cap: z.number().int().positive(),
      }),
    )
    .max(32),
  items: z.array(safetyDeskRetentionRuntimeItemSchema).max(50),
});
export type SafetyDeskRetentionRuntimeResponse = z.infer<
  typeof safetyDeskRetentionRuntimeResponseSchema
>;

export const safetyDeskRetentionPreviewItemSchema = z.object({
  messageId: z.string().min(1),
  authorId: z.string(),
  sourceAt: z.string().datetime(),
  dueAt: z.string().datetime(),
  status: z.string().min(1),
  outcomeCode: z.string().nullable(),
  intentId: z.string().nullable(),
  intentStatus: safetyDeskDeleteIntentStatusSchema.nullable(),
  intentUpdatedAt: z.string().datetime().nullable(),
  intentAttemptCount: z.number().int().nonnegative().nullable(),
  reconcileAfter: z.string().datetime().nullable(),
  retryAllowed: z.boolean(),
});
export type SafetyDeskRetentionPreviewItem = z.infer<typeof safetyDeskRetentionPreviewItemSchema>;

export const retentionProtectionEvidenceSchema = z.object({
  version: z.literal(1),
  source: z.literal('ownership_capture_v1'),
  chatId: z.string().regex(/^-[1-9]\d*$/),
  sourceRevision: z.number().int().nonnegative(),
  completeFrom: z.string().datetime(),
  completeThrough: z.string().datetime(),
  catalogDigest: z.string().regex(/^[a-f0-9]{64}$/),
  referenceCount: z.number().int().nonnegative(),
  checksum: z.string().regex(/^[a-f0-9]{64}$/),
});
export const retentionProtectionReportSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('unavailable') }),
  z.object({
    status: z.literal('available'),
    sourceRevision: z.number().int().nonnegative(),
    deliveredRevision: z.number().int().min(-1),
    historicalGapBefore: z.string().datetime(),
    imports: z.object({
      giveawayEntities: z.boolean(),
      rulesAudit: z.boolean(),
      giveawayAudit: z.boolean(),
      legacyHolds: z.boolean(),
      sourceHolds: z.boolean(),
    }),
    catalog: z.object({ ready: z.boolean(), referencesHashed: z.number().int().nonnegative() }),
    deliveredEvidence: retentionProtectionEvidenceSchema.nullable(),
    legacyRetirement: z
      .object({
        scanComplete: z.boolean(),
        retiredCount: z.number().int().nonnegative(),
        reconciliationCount: z.number().int().nonnegative(),
        retainedAtScan: z.number().int().nonnegative(),
      })
      .nullable(),
  }),
]);
export type RetentionProtectionReport = z.infer<typeof retentionProtectionReportSchema>;

export const safetyDeskRetentionPreviewResponseSchema = z.object({
  chatId: z.string().min(1),
  revision: z.number().int().nonnegative(),
  activationId: z.string().min(1),
  source: retentionSourceSchema.optional(),
  sourceStatus: z.literal('available').optional(),
  nextAfter: z.string().min(1).nullable().optional(),
  incomplete: z.boolean().optional(),
  protection: retentionProtectionReportSchema.optional(),
  protectionEvidence: retentionProtectionEvidenceSchema.nullable().optional(),
  items: z.array(safetyDeskRetentionPreviewItemSchema).max(20),
});
export type SafetyDeskRetentionPreviewResponse = z.infer<
  typeof safetyDeskRetentionPreviewResponseSchema
>;

export const safetyDeskRetryRetentionRequestSchema = z
  .object({
    messageId: z.string().trim().min(1),
    activationId: z.string().trim().min(1),
    expectedRevision: z.number().int().nonnegative(),
    intentId: z.string().trim().min(1),
    expectedIntentUpdatedAt: z.string().datetime(),
    expectedAttemptCount: z.number().int().nonnegative(),
  })
  .strict();
export type SafetyDeskRetryRetentionRequest = z.infer<typeof safetyDeskRetryRetentionRequestSchema>;

export const safetyDeskNoticeEvidenceSchema = z.object({
  state: z.enum(['confirmed', 'unknown', 'pending', 'stopped', 'not_recorded', 'invalid_evidence']),
  completedAt: z.string().datetime().nullable(),
  remoteMessageId: z.string().max(256).nullable(),
});

export const safetyDeskDeleteEvidenceResponseSchema = z.object({
  version: z.literal(1),
  observedAt: z.string().datetime(),
  intentId: z.string().min(1).max(128),
  webhookLink: z.literal('not_recorded'),
  originCoverage: z.enum(['partial', 'not_recorded']).optional(),
  deletion: z.object({
    status: safetyDeskDeleteIntentStatusSchema,
    outcome: z.enum([
      'confirmed',
      'acknowledged',
      'already_absent',
      'unknown',
      'pending',
      'stopped',
      'observed',
    ]),
    createdAt: z.string().datetime(),
    sourceMessageAt: z.string().datetime().nullable(),
    firstAttemptAt: z.string().datetime().nullable(),
    dispatchStartedAt: z.string().datetime().nullable(),
    acknowledgedAt: z.string().datetime().nullable(),
    completedAt: z.string().datetime().nullable(),
  }),
  reasons: z.object({
    sampleComplete: z.boolean(),
    items: z
      .array(
        z.object({
          reasonKey: z.string().max(256),
          ruleCode: z.string().max(120),
          moderationEventId: z.string().max(128).nullable(),
          decisionRecorded: z.boolean(),
          origin: z
            .object({
              state: z.enum(['linked', 'not_recorded', 'source_unavailable', 'invalid_evidence']),
              webhookEventId: z.string().max(128).nullable(),
              receivingBotId: z.string().max(512).nullable(),
              executionBotId: z.string().max(512).nullable(),
              eventAt: z.string().datetime().nullable(),
              acceptedAt: z.string().datetime().nullable(),
              recordedAt: z.string().datetime().nullable(),
              evidenceVersion: z.literal(1).nullable(),
            })
            .optional(),
        }),
      )
      .max(32),
  }),
  followups: z.object({
    sampleComplete: z.boolean(),
    items: z
      .array(
        z.object({
          id: z.string().min(1).max(128),
          ruleCode: z.string().max(120),
          status: z.string().max(64),
          sourceAt: z.string().datetime(),
          deadlineAt: z.string().datetime(),
          completedAt: z.string().datetime().nullable(),
          decisionRecorded: z.boolean(),
          explanation: safetyDeskNoticeEvidenceSchema,
          sanctionNotice: safetyDeskNoticeEvidenceSchema,
        }),
      )
      .max(32),
  }),
});
export type SafetyDeskDeleteEvidenceResponse = z.infer<
  typeof safetyDeskDeleteEvidenceResponseSchema
>;
