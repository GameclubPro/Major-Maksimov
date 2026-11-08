import { z } from 'zod';
import { managedEntityBotCapabilitySchema } from './managed-entities.js';

export const queueCountersSchema = z.object({
  waiting: z.number().int().min(0),
  prioritized: z.number().int().min(0).optional(),
  active: z.number().int().min(0),
  delayed: z.number().int().min(0),
  failed: z.number().int().min(0),
  completed: z.number().int().min(0),
});
export type QueueCounters = z.infer<typeof queueCountersSchema>;

export const webhookStatusMetricsSchema = z.object({
  count: z.number().int().min(0),
  oldestEventId: z.string().nullable(),
  oldestCreatedAt: z.string().datetime().nullable(),
  oldestLagSec: z.number().min(0),
  activeCount: z.number().int().min(0).optional(),
  staleCount: z.number().int().min(0).optional(),
  activeWindowSec: z.number().int().min(0).optional(),
});
export type WebhookStatusMetrics = z.infer<typeof webhookStatusMetricsSchema>;

export const actionHealthSnapshotSchema = z.object({
  windowSec: z.number().int().min(1),
  total: z.number().int().min(0),
  success: z.number().int().min(0),
  failure: z.number().int().min(0),
  critical: z.number().int().min(0),
  errorRate: z.number().min(0),
  criticalRate: z.number().min(0),
});
export type ActionHealthSnapshot = z.infer<typeof actionHealthSnapshotSchema>;

const emptyWebhookStatusMetrics = {
  count: 0,
  oldestEventId: null,
  oldestCreatedAt: null,
  oldestLagSec: 0,
};

export const botQueueMetricsSnapshotSchema = z.object({
  webhookEvents: z.object({
    received: webhookStatusMetricsSchema,
    queued: webhookStatusMetricsSchema,
    failed: webhookStatusMetricsSchema,
  }),
  userFacingWebhookEvents: z
    .object({
      received: webhookStatusMetricsSchema,
      queued: webhookStatusMetricsSchema,
      failed: webhookStatusMetricsSchema,
    })
    .optional()
    .default({
      received: emptyWebhookStatusMetrics,
      queued: emptyWebhookStatusMetrics,
      failed: emptyWebhookStatusMetrics,
    }),
  queuedByQueue: z.record(z.string(), z.number().int().min(0)),
  actionHealth: actionHealthSnapshotSchema,
  oldestQueuedEventId: z.string().nullable(),
  oldestQueuedCreatedAt: z.string().datetime().nullable(),
  oldestQueuedLagSec: z.number().min(0),
  oldestReceivedEventId: z.string().nullable(),
  oldestReceivedCreatedAt: z.string().datetime().nullable(),
  oldestReceivedLagSec: z.number().min(0),
  effectiveLagSec: z.number().min(0),
  userFacingOldestQueuedEventId: z.string().nullable().optional().default(null),
  userFacingOldestQueuedCreatedAt: z.string().datetime().nullable().optional().default(null),
  userFacingOldestQueuedLagSec: z.number().min(0).optional().default(0),
  userFacingOldestReceivedEventId: z.string().nullable().optional().default(null),
  userFacingOldestReceivedCreatedAt: z.string().datetime().nullable().optional().default(null),
  userFacingOldestReceivedLagSec: z.number().min(0).optional().default(0),
  userFacingEffectiveLagSec: z.number().min(0).optional().default(0),
});
export type BotQueueMetricsSnapshot = z.infer<typeof botQueueMetricsSnapshotSchema>;

export const maxActionLedgerWatchdogSnapshotSchema = z.object({
  enabled: z.boolean(),
  activeOnThisRole: z.boolean(),
  mode: z.enum(['off', 'shadow', 'canary', 'on']).optional().default('shadow'),
  canaryPercent: z.number().min(0).max(100).optional().default(1),
  canaryEntityIds: z.array(z.string()).optional().default([]),
  staleAfterSec: z.number().int().positive(),
  intervalSec: z.number().int().positive(),
  lastRunAt: z.string().datetime().nullable(),
  lastSuccessAt: z.string().datetime().nullable(),
  lastError: z.string().nullable(),
  lastRunReason: z.enum(['startup', 'scheduled', 'manual']).nullable(),
  staleCount: z.number().int().min(0),
  staleEnqueuedCount: z.number().int().min(0),
  staleInProgressCount: z.number().int().min(0),
  staleRetryableCount: z.number().int().min(0).optional().default(0),
  oldestStaleAgeSec: z.number().min(0),
  lastScannedCount: z.number().int().min(0),
  lastReconciledCount: z.number().int().min(0),
  lastQuarantinedCount: z.number().int().min(0),
  lastTerminalFailedCount: z.number().int().min(0),
  lastRecoveredSucceededCount: z.number().int().min(0),
  lastRequeuedCount: z.number().int().min(0).optional().default(0),
  lastRetryOrphanTerminalizedCount: z.number().int().min(0).optional().default(0),
  lastDeferredCount: z.number().int().min(0),
  lastConflictCount: z.number().int().min(0),
  lastShadowClassifiedCount: z.number().int().min(0).optional().default(0),
  lastWouldQuarantineCount: z.number().int().min(0).optional().default(0),
  lastWouldTerminalFailCount: z.number().int().min(0).optional().default(0),
  lastWouldRecoverSucceededCount: z.number().int().min(0).optional().default(0),
  lastWouldRequeueCount: z.number().int().min(0).optional().default(0),
  lastScanTruncated: z.boolean(),
  generatedAt: z.string().datetime(),
});
export type MaxActionLedgerWatchdogSnapshot = z.infer<typeof maxActionLedgerWatchdogSnapshotSchema>;

export const systemModeSchema = z.enum(['normal', 'degrade']);
export type SystemMode = z.infer<typeof systemModeSchema>;

export const systemModeSourceSchema = z.enum(['auto', 'manual']);
export type SystemModeSource = z.infer<typeof systemModeSourceSchema>;

export const systemModeConditionSchema = z.enum([
  'healthy',
  'queue_backlog',
  'max_api',
  'mixed',
  'stabilizing',
  'manual',
  'unknown',
]);
export type SystemModeCondition = z.infer<typeof systemModeConditionSchema>;

export const systemModeSnapshotSchema = z.object({
  mode: systemModeSchema,
  source: systemModeSourceSchema,
  condition: systemModeConditionSchema.optional().default('unknown'),
  reason: z.string(),
  updatedAt: z.string().datetime(),
  manualMode: systemModeSchema.nullable(),
  queueLagSec: z.number().min(0),
  action: actionHealthSnapshotSchema,
});
export type SystemModeSnapshot = z.infer<typeof systemModeSnapshotSchema>;

export const queueMetricsSnapshotSchema = z.object({
  moderation: queueCountersSchema,
  webhookCritical: queueCountersSchema,
  webhookJoin: queueCountersSchema.optional().default({
    waiting: 0,
    active: 0,
    delayed: 0,
    failed: 0,
    completed: 0,
  }),
  webhookJoinShards: z.record(z.string(), queueCountersSchema).optional().default({}),
  webhookDefault: queueCountersSchema,
  webhookDefaultShards: z.record(z.string(), queueCountersSchema).optional().default({}),
  webhookDefaultWorkerGroups: z
    .record(
      z.string(),
      z.object({
        queues: z.array(z.string()),
        counters: queueCountersSchema,
      }),
    )
    .optional()
    .default({}),
  webhookBackground: queueCountersSchema,
  webhookLegacy: queueCountersSchema,
  actions: queueCountersSchema,
  actionQueues: z.record(z.string(), queueCountersSchema).optional().default({}),
  globalSpammerDenorm: queueCountersSchema.optional().default({
    waiting: 0,
    active: 0,
    delayed: 0,
    failed: 0,
    completed: 0,
  }),
  auxiliaryQueues: z.record(z.string(), queueCountersSchema).optional().default({}),
  webhookEvents: z.object({
    received: webhookStatusMetricsSchema,
    queued: webhookStatusMetricsSchema,
    failed: webhookStatusMetricsSchema,
  }),
  userFacingWebhookEvents: z
    .object({
      received: webhookStatusMetricsSchema,
      queued: webhookStatusMetricsSchema,
      failed: webhookStatusMetricsSchema,
    })
    .optional()
    .default({
      received: emptyWebhookStatusMetrics,
      queued: emptyWebhookStatusMetrics,
      failed: emptyWebhookStatusMetrics,
    }),
  actionHealth: actionHealthSnapshotSchema,
  actionLedgerWatchdog: maxActionLedgerWatchdogSnapshotSchema.nullable().optional().default(null),
  webhookDynamicLeases: z.unknown().nullable().optional().default(null),
  bots: z.record(z.string(), botQueueMetricsSnapshotSchema),
  oldestQueuedEventId: z.string().nullable(),
  oldestQueuedCreatedAt: z.string().datetime().nullable(),
  oldestQueuedLagSec: z.number().min(0),
  oldestReceivedEventId: z.string().nullable(),
  oldestReceivedCreatedAt: z.string().datetime().nullable(),
  oldestReceivedLagSec: z.number().min(0),
  effectiveLagSec: z.number().min(0),
  userFacingOldestQueuedEventId: z.string().nullable().optional().default(null),
  userFacingOldestQueuedCreatedAt: z.string().datetime().nullable().optional().default(null),
  userFacingOldestQueuedLagSec: z.number().min(0).optional().default(0),
  userFacingOldestReceivedEventId: z.string().nullable().optional().default(null),
  userFacingOldestReceivedCreatedAt: z.string().datetime().nullable().optional().default(null),
  userFacingOldestReceivedLagSec: z.number().min(0).optional().default(0),
  userFacingEffectiveLagSec: z.number().min(0).optional().default(0),
  generatedAt: z.string().datetime(),
});
export type QueueMetricsSnapshot = z.infer<typeof queueMetricsSnapshotSchema>;

export const systemDashboardStatusSchema = z.enum(['healthy', 'warning', 'critical']);
export type SystemDashboardStatus = z.infer<typeof systemDashboardStatusSchema>;

export const systemDashboardAlertLevelSchema = z.enum(['info', 'warning', 'critical']);
export type SystemDashboardAlertLevel = z.infer<typeof systemDashboardAlertLevelSchema>;

export const systemDashboardAlertSchema = z.object({
  code: z.string(),
  level: systemDashboardAlertLevelSchema,
  title: z.string(),
  detail: z.string(),
  recommendedAction: z.string(),
});
export type SystemDashboardAlert = z.infer<typeof systemDashboardAlertSchema>;

export const webhookSubscriptionSnapshotStatusSchema = z.enum([
  'healthy',
  'warning',
  'critical',
  'disabled',
]);
export type WebhookSubscriptionSnapshotStatus = z.infer<
  typeof webhookSubscriptionSnapshotStatusSchema
>;

export const botWebhookOperationalIssueSchema = z.enum([
  'no-active-memberships',
  'no-incoming-webhooks',
]);
export type BotWebhookOperationalIssue = z.infer<typeof botWebhookOperationalIssueSchema>;

export const botWebhookOperationalDiagnosticsSchema = z.object({
  lifecycleState: z.string(),
  activeMemberships: z.number().int().min(0),
  hasCurrentSubscription: z.boolean(),
  lastIncomingWebhookAt: z.string().datetime().nullable(),
  lastMembershipWebhookAt: z.string().datetime().nullable(),
  issueCodes: z.array(botWebhookOperationalIssueSchema),
});
export type BotWebhookOperationalDiagnostics = z.infer<
  typeof botWebhookOperationalDiagnosticsSchema
>;

export const botWebhookSubscriptionSnapshotSchema = z.object({
  botId: z.string(),
  status: webhookSubscriptionSnapshotStatusSchema,
  configured: z.boolean(),
  url: z.string().nullable(),
  checkedAt: z.string().datetime().nullable(),
  reconciledAt: z.string().datetime().nullable(),
  requiredUpdateTypes: z.array(z.string()),
  actualUpdateTypes: z.array(z.string()),
  missingUpdateTypes: z.array(z.string()),
  extraUpdateTypes: z.array(z.string()),
  otherSubscriptionsCount: z.number().int().min(0),
  lastError: z.string().nullable(),
  note: z.string().nullable(),
  operationalDiagnostics: botWebhookOperationalDiagnosticsSchema.optional(),
});
export type BotWebhookSubscriptionSnapshot = z.infer<typeof botWebhookSubscriptionSnapshotSchema>;

export const webhookSubscriptionOperationalDiagnosticsSchema = z.object({
  warningBotCount: z.number().int().min(0),
  warningBotIds: z.array(z.string()),
  noActiveMembershipBotIds: z.array(z.string()),
  noIncomingWebhookBotIds: z.array(z.string()),
});
export type WebhookSubscriptionOperationalDiagnostics = z.infer<
  typeof webhookSubscriptionOperationalDiagnosticsSchema
>;

export const webhookSubscriptionSnapshotSchema = z.object({
  status: webhookSubscriptionSnapshotStatusSchema,
  configured: z.boolean(),
  url: z.string().nullable(),
  checkedAt: z.string().datetime().nullable(),
  reconciledAt: z.string().datetime().nullable(),
  requiredUpdateTypes: z.array(z.string()),
  actualUpdateTypes: z.array(z.string()),
  missingUpdateTypes: z.array(z.string()),
  extraUpdateTypes: z.array(z.string()),
  otherSubscriptionsCount: z.number().int().min(0),
  lastError: z.string().nullable(),
  note: z.string().nullable(),
  botCount: z.number().int().min(0),
  bots: z.record(z.string(), botWebhookSubscriptionSnapshotSchema),
  operationalDiagnostics: webhookSubscriptionOperationalDiagnosticsSchema.optional(),
});
export type WebhookSubscriptionSnapshot = z.infer<typeof webhookSubscriptionSnapshotSchema>;

export const systemBotLifecycleStateSchema = z.enum(['active', 'draining', 'dormant', 'disabled']);
export type SystemBotLifecycleState = z.infer<typeof systemBotLifecycleStateSchema>;

export const systemBotEntityTypeSchema = z.enum(['chat', 'channel']);
export type SystemBotEntityType = z.infer<typeof systemBotEntityTypeSchema>;

export const systemBotMembershipRoleSchema = z.enum(['primary', 'standby']);
export type SystemBotMembershipRole = z.infer<typeof systemBotMembershipRoleSchema>;

export const systemBotMembershipStatusSchema = z.enum(['active', 'removed']);
export type SystemBotMembershipStatus = z.infer<typeof systemBotMembershipStatusSchema>;

export const systemBotAccessStateSchema = z.enum([
  'unknown',
  'confirmed_owner',
  'confirmed_admin',
  'confirmed_member',
  'denied',
  'lost',
  'stale',
]);
export type SystemBotAccessState = z.infer<typeof systemBotAccessStateSchema>;

export const systemBotEntityCountSchema = z.object({
  total: z.number().int().min(0),
  chats: z.number().int().min(0),
  channels: z.number().int().min(0),
});
export type SystemBotEntityCount = z.infer<typeof systemBotEntityCountSchema>;

export const systemBotManagedEntityStatsSchema = z.object({
  primary: systemBotEntityCountSchema,
  standby: systemBotEntityCountSchema,
  assist: systemBotEntityCountSchema,
});
export type SystemBotManagedEntityStats = z.infer<typeof systemBotManagedEntityStatsSchema>;

export const systemBotAccessStatsSchema = z.object({
  lost: z.number().int().min(0),
  stale: z.number().int().min(0),
  denied: z.number().int().min(0),
  unknown: z.number().int().min(0),
  removedAfterLoss: z.number().int().min(0),
});
export type SystemBotAccessStats = z.infer<typeof systemBotAccessStatsSchema>;

export const systemBotMaxApiLoadSchema = z.object({
  windowSec: z.number().int().min(1),
  totalRequests: z.number().int().min(0),
  avgRps: z.number().min(0),
  peakRps: z.number().int().min(0),
  avgLoad: z.number().min(0).max(1),
  peakLoad: z.number().min(0).max(1),
  smoothedLoad: z.number().min(0).max(1),
  background: z.object({
    totalRequests: z.number().int().min(0),
    avgRps: z.number().min(0),
    peakRps: z.number().int().min(0),
  }),
});
export type SystemBotMaxApiLoad = z.infer<typeof systemBotMaxApiLoadSchema>;

export const systemBotProblemKindSchema = z.enum([
  'lost-access',
  'stale-access',
  'denied-access',
  'removed-after-loss',
]);
export type SystemBotProblemKind = z.infer<typeof systemBotProblemKindSchema>;

export const systemBotProblemSampleSchema = z.object({
  chatId: z.string(),
  title: z.string(),
  entityType: systemBotEntityTypeSchema,
  kind: systemBotProblemKindSchema,
  botRole: systemBotMembershipRoleSchema,
  membershipStatus: systemBotMembershipStatusSchema,
  botAccessState: systemBotAccessStateSchema,
  primaryBotId: z.string().nullable(),
  checkedAt: z.string().datetime().nullable(),
  lastSeenAt: z.string().datetime().nullable(),
  lastWebhookAt: z.string().datetime().nullable(),
  updatedAt: z.string().datetime(),
});
export type SystemBotProblemSample = z.infer<typeof systemBotProblemSampleSchema>;

export const systemBotSummarySchema = z.object({
  botId: z.string(),
  label: z.string(),
  characterName: z.string(),
  lifecycleState: systemBotLifecycleStateSchema,
  adminVisible: z.boolean(),
  isDefault: z.boolean(),
  contactId: z.string().nullable(),
  webhook: botWebhookSubscriptionSnapshotSchema.nullable(),
  operationalDiagnostics: botWebhookOperationalDiagnosticsSchema.nullable(),
  queue: botQueueMetricsSnapshotSchema.nullable(),
  maxApiLoad: systemBotMaxApiLoadSchema,
  entities: systemBotManagedEntityStatsSchema,
  access: systemBotAccessStatsSchema,
  problemSamples: z.array(systemBotProblemSampleSchema),
});
export type SystemBotSummary = z.infer<typeof systemBotSummarySchema>;

export const systemBotFleetSummarySchema = z.object({
  total: z.number().int().min(0),
  adminVisible: z.number().int().min(0),
  active: z.number().int().min(0),
  draining: z.number().int().min(0),
  dormant: z.number().int().min(0),
  disabled: z.number().int().min(0),
  webhookWarningBotCount: z.number().int().min(0),
  problemBotCount: z.number().int().min(0),
  primaryEntities: systemBotEntityCountSchema,
  standbyEntities: systemBotEntityCountSchema,
  assistEntities: systemBotEntityCountSchema,
  lostAccess: z.number().int().min(0),
  staleAccess: z.number().int().min(0),
  deniedAccess: z.number().int().min(0),
});
export type SystemBotFleetSummary = z.infer<typeof systemBotFleetSummarySchema>;

export const systemBotsSnapshotSchema = z.object({
  generatedAt: z.string().datetime(),
  summary: systemBotFleetSummarySchema,
  bots: z.array(systemBotSummarySchema),
});
export type SystemBotsSnapshot = z.infer<typeof systemBotsSnapshotSchema>;

export const systemBotRoutePurposeSchema = z.enum([
  'default',
  'read',
  'send_message',
  'member_access',
  'moderation_action',
  'capability',
]);
export type SystemBotRoutePurpose = z.infer<typeof systemBotRoutePurposeSchema>;

export const systemBotRouteModerationActionSchema = z.enum(['delete_message', 'moderate_member']);
export type SystemBotRouteModerationAction = z.infer<typeof systemBotRouteModerationActionSchema>;

export const systemBotRouteReasonSchema = z.enum([
  'explicit',
  'chat_cache',
  'chat_primary',
  'context',
  'default',
  'primary_confirmed',
  'alternate_confirmed',
  'primary_soft',
  'alternate_soft',
  'primary_fallback',
  'alternate_fallback',
]);
export type SystemBotRouteReason = z.infer<typeof systemBotRouteReasonSchema>;

export const systemBotRouteBotSchema = z.object({
  botId: z.string(),
  label: z.string(),
  lifecycleState: systemBotLifecycleStateSchema,
  adminVisible: z.boolean(),
  isDefault: z.boolean(),
});
export type SystemBotRouteBot = z.infer<typeof systemBotRouteBotSchema>;

export const systemBotPermissionsSummarySchema = z.object({
  checkedAt: z.string().datetime().nullable(),
  isAdmin: z.boolean(),
  isOwner: z.boolean(),
  permissions: z.array(z.string()),
});
export type SystemBotPermissionsSummary = z.infer<typeof systemBotPermissionsSummarySchema>;

export const systemBotRouteMembershipSchema = z.object({
  botId: z.string(),
  label: z.string().nullable(),
  configured: z.boolean(),
  lifecycleState: systemBotLifecycleStateSchema.nullable(),
  operational: z.boolean(),
  discoverable: z.boolean(),
  executable: z.boolean(),
  role: systemBotMembershipRoleSchema,
  status: systemBotMembershipStatusSchema,
  botAccessState: systemBotAccessStateSchema,
  capabilities: z.array(managedEntityBotCapabilitySchema),
  permissionsSummary: systemBotPermissionsSummarySchema.nullable(),
  botAccessCheckedAt: z.string().datetime().nullable(),
  botAccessExpiresAt: z.string().datetime().nullable(),
  botAccessSource: z.string().nullable(),
  botAccessLastErrorCode: z.string().nullable(),
  lastSeenAt: z.string().datetime().nullable(),
  lastWebhookAt: z.string().datetime().nullable(),
  issues: z.array(z.string()),
});
export type SystemBotRouteMembership = z.infer<typeof systemBotRouteMembershipSchema>;

export const systemBotRoutePreviewRouteSchema = z.object({
  purpose: systemBotRoutePurposeSchema,
  action: systemBotRouteModerationActionSchema.nullable(),
  capability: managedEntityBotCapabilitySchema.nullable(),
  chatId: z.string().nullable(),
  primaryBotId: z.string().nullable(),
  botId: z.string().nullable(),
  candidateBotIds: z.array(z.string()),
  reason: systemBotRouteReasonSchema.nullable(),
  selectedBot: systemBotRouteBotSchema.nullable(),
  candidateBots: z.array(systemBotRouteBotSchema),
});
export type SystemBotRoutePreviewRoute = z.infer<typeof systemBotRoutePreviewRouteSchema>;

export const systemBotRoutePreviewResponseSchema = z.object({
  generatedAt: z.string().datetime(),
  query: z.object({
    chatId: z.string(),
    purpose: z.union([z.literal('all'), systemBotRoutePurposeSchema]),
    action: systemBotRouteModerationActionSchema.nullable(),
    capability: managedEntityBotCapabilitySchema.nullable(),
    fallbackToPrimary: z.boolean(),
    botId: z.string().nullable(),
  }),
  chat: z.object({
    exists: z.boolean(),
    chatId: z.string(),
    title: z.string().nullable(),
    entityType: systemBotEntityTypeSchema.nullable(),
    catalogKind: z.string().nullable(),
    storedPrimaryBotId: z.string().nullable(),
    legacyBotId: z.string().nullable(),
  }),
  routes: z.array(systemBotRoutePreviewRouteSchema),
  memberships: z.array(systemBotRouteMembershipSchema),
  warnings: z.array(z.string()),
});
export type SystemBotRoutePreviewResponse = z.infer<typeof systemBotRoutePreviewResponseSchema>;

export const systemBotRouteAuditClassificationSchema = z.enum([
  'selected-primary',
  'covered-by-alternate',
  'empty-candidates',
  'no-active-executable-bot',
]);
export type SystemBotRouteAuditClassification = z.infer<
  typeof systemBotRouteAuditClassificationSchema
>;

export const systemBotRouteAuditSeveritySchema = z.enum(['info', 'warning', 'critical']);
export type SystemBotRouteAuditSeverity = z.infer<typeof systemBotRouteAuditSeveritySchema>;

export const systemBotRouteAuditActionSummarySchema = z.object({
  action: systemBotRouteModerationActionSchema,
  auditedRoutes: z.number().int().min(0),
  routesWithCandidate: z.number().int().min(0),
  selectedPrimary: z.number().int().min(0),
  coveredByAlternate: z.number().int().min(0),
  emptyCandidates: z.number().int().min(0),
  noActiveExecutableBot: z.number().int().min(0),
});
export type SystemBotRouteAuditActionSummary = z.infer<
  typeof systemBotRouteAuditActionSummarySchema
>;

export const systemBotRouteAuditSummarySchema = z.object({
  auditedEntities: z.number().int().min(0),
  auditedRoutes: z.number().int().min(0),
  routesWithCandidate: z.number().int().min(0),
  selectedPrimary: z.number().int().min(0),
  coveredByAlternate: z.number().int().min(0),
  emptyCandidates: z.number().int().min(0),
  noActiveExecutableBot: z.number().int().min(0),
  warningCount: z.number().int().min(0),
  criticalCount: z.number().int().min(0),
  byAction: z.array(systemBotRouteAuditActionSummarySchema),
});
export type SystemBotRouteAuditSummary = z.infer<typeof systemBotRouteAuditSummarySchema>;

export const systemBotRouteAuditSampleSchema = z.object({
  severity: systemBotRouteAuditSeveritySchema,
  classification: systemBotRouteAuditClassificationSchema,
  chatId: z.string(),
  title: z.string(),
  entityType: systemBotEntityTypeSchema,
  catalogKind: z.string(),
  action: systemBotRouteModerationActionSchema,
  primaryBotId: z.string().nullable(),
  selectedBotId: z.string().nullable(),
  candidateBotIds: z.array(z.string()),
  activeExecutableBotIds: z.array(z.string()),
  deniedOrLostBotIds: z.array(z.string()),
  deniedPermissionsBotIds: z.array(z.string()),
  stalePermissionsBotIds: z.array(z.string()),
  missingPermissionsBotIds: z.array(z.string()),
  reason: z.string(),
});
export type SystemBotRouteAuditSample = z.infer<typeof systemBotRouteAuditSampleSchema>;

export const systemBotRouteAuditSchema = z.object({
  generatedAt: z.string().datetime(),
  config: z.object({
    sampleLimit: z.number().int().min(1),
    includeCovered: z.boolean(),
  }),
  summary: systemBotRouteAuditSummarySchema,
  samples: z.array(systemBotRouteAuditSampleSchema),
});
export type SystemBotRouteAudit = z.infer<typeof systemBotRouteAuditSchema>;

export const systemBotMembershipAuditKindSchema = z.enum([
  'denied-active-primary',
  'stored-primary-denied-alternate-eligible',
  'stale-permissions-snapshot',
  'capabilities-on-denied-bot',
  'type-mismatch',
  'suspicious-row',
]);
export type SystemBotMembershipAuditKind = z.infer<typeof systemBotMembershipAuditKindSchema>;

export const systemBotMembershipAuditSeveritySchema = z.enum(['info', 'warning', 'critical']);
export type SystemBotMembershipAuditSeverity = z.infer<
  typeof systemBotMembershipAuditSeveritySchema
>;

export const systemBotMembershipAuditSummarySchema = z.object({
  auditedEntities: z.number().int().min(0),
  activeMemberships: z.number().int().min(0),
  deniedActivePrimary: z.number().int().min(0),
  storedPrimaryDeniedAlternateEligible: z.number().int().min(0),
  stalePermissionsSnapshot: z.number().int().min(0),
  capabilitiesOnDeniedBot: z.number().int().min(0),
  typeMismatch: z.number().int().min(0),
  suspiciousRows: z.number().int().min(0),
  warningCount: z.number().int().min(0),
  criticalCount: z.number().int().min(0),
});
export type SystemBotMembershipAuditSummary = z.infer<typeof systemBotMembershipAuditSummarySchema>;

export const systemBotMembershipAuditBotSummarySchema = z.object({
  botId: z.string(),
  label: z.string().nullable(),
  deniedPrimary: z.number().int().min(0),
  staleSnapshots: z.number().int().min(0),
  deniedCapabilities: z.number().int().min(0),
  alternateEligibleFor: z.number().int().min(0),
});
export type SystemBotMembershipAuditBotSummary = z.infer<
  typeof systemBotMembershipAuditBotSummarySchema
>;

export const systemBotMembershipAuditSampleSchema = z.object({
  kind: systemBotMembershipAuditKindSchema,
  severity: systemBotMembershipAuditSeveritySchema,
  chatId: z.string(),
  title: z.string(),
  entityType: systemBotEntityTypeSchema,
  catalogKind: z.string(),
  botId: z.string().nullable(),
  botLabel: z.string().nullable(),
  primaryBotId: z.string().nullable(),
  suggestedPrimaryBotId: z.string().nullable(),
  alternateBotIds: z.array(z.string()),
  membershipRole: systemBotMembershipRoleSchema.nullable(),
  membershipStatus: systemBotMembershipStatusSchema.nullable(),
  botAccessState: systemBotAccessStateSchema.nullable(),
  permissionsState: z.enum(['missing', 'fresh', 'stale', 'denied']),
  permissionsCheckedAt: z.string().datetime().nullable(),
  botAccessCheckedAt: z.string().datetime().nullable(),
  botAccessExpiresAt: z.string().datetime().nullable(),
  botAccessSource: z.string().nullable(),
  botAccessLastErrorCode: z.string().nullable(),
  capabilities: z.array(managedEntityBotCapabilitySchema),
  evidenceFresh: z.boolean(),
  reason: z.string(),
});
export type SystemBotMembershipAuditSample = z.infer<typeof systemBotMembershipAuditSampleSchema>;

export const systemBotMembershipAuditSchema = z.object({
  generatedAt: z.string().datetime(),
  config: z.object({
    snapshotFreshMs: z.number().int().min(0),
    sampleLimit: z.number().int().min(1),
  }),
  summary: systemBotMembershipAuditSummarySchema,
  byBot: z.array(systemBotMembershipAuditBotSummarySchema),
  samples: z.array(systemBotMembershipAuditSampleSchema),
});
export type SystemBotMembershipAudit = z.infer<typeof systemBotMembershipAuditSchema>;

export const systemDashboardSummarySchema = z.object({
  status: systemDashboardStatusSchema,
  title: z.string(),
  detail: z.string(),
  generatedAt: z.string().datetime(),
  stabilizing: z.boolean(),
});
export type SystemDashboardSummary = z.infer<typeof systemDashboardSummarySchema>;

export const botOwnershipCoverageSchema = z.object({
  total: z.number().int().min(0),
  withPrimary: z.number().int().min(0),
  withoutPrimary: z.number().int().min(0),
  coverageRatio: z.number().min(0).max(1),
});
export type BotOwnershipCoverage = z.infer<typeof botOwnershipCoverageSchema>;

export const botOwnershipLifecycleStatsSchema = z.object({
  configured: z.number().int().min(0),
  adminVisible: z.number().int().min(0),
  active: z.number().int().min(0),
  dormant: z.number().int().min(0),
  draining: z.number().int().min(0),
  disabled: z.number().int().min(0),
});
export type BotOwnershipLifecycleStats = z.infer<typeof botOwnershipLifecycleStatsSchema>;

export const botOwnershipAnomaliesSchema = z.object({
  noPrimary: z.number().int().min(0),
  recoverableLegacyOnly: z.number().int().min(0),
  recoverableFromMemberships: z.number().int().min(0),
  noEligibleBot: z.number().int().min(0),
  unbound: z.number().int().min(0),
  primaryBotUnknown: z.number().int().min(0),
  legacyBotUnknown: z.number().int().min(0),
  activeMembershipBotUnknown: z.number().int().min(0),
  primaryWithoutActiveMembership: z.number().int().min(0),
  primaryWithoutAdminAccess: z.number().int().min(0),
  sharedChats: z.number().int().min(0),
});
export type BotOwnershipAnomalies = z.infer<typeof botOwnershipAnomaliesSchema>;

export const chatRoutingStateSchema = z.enum(['READY', 'NO_ELIGIBLE_BOT']);
export type ChatRoutingState = z.infer<typeof chatRoutingStateSchema>;

export const botOwnershipRoutingStatesSchema = z.object({
  ready: z.number().int().min(0),
  noEligibleBot: z.number().int().min(0),
});
export type BotOwnershipRoutingStates = z.infer<typeof botOwnershipRoutingStatesSchema>;

export const botOwnershipRepairSnapshotSchema = z.object({
  enabled: z.boolean(),
  activeOnThisRole: z.boolean(),
  intervalMs: z.number().int().positive(),
  rebalanceMode: z.enum(['off', 'shadow', 'canary', 'on']),
  rebalanceCanaryPercent: z.number().min(0).max(100),
  rebalanceMaxMovesPerRun: z.number().int().positive(),
  recommendedMoves: z.number().int().min(0),
  lastAppliedMoves: z.number().int().min(0),
  lastRunAt: z.string().datetime().nullable(),
  lastSuccessAt: z.string().datetime().nullable(),
  lastError: z.string().nullable(),
  lastAppliedChanges: z.number().int().min(0),
  totalAppliedChanges: z.number().int().min(0),
});
export type BotOwnershipRepairSnapshot = z.infer<typeof botOwnershipRepairSnapshotSchema>;

export const botOwnershipFoundationSnapshotSchema = z.object({
  generatedAt: z.string().datetime(),
  bots: botOwnershipLifecycleStatsSchema,
  entities: z.object({
    total: botOwnershipCoverageSchema,
    chats: botOwnershipCoverageSchema,
    channels: botOwnershipCoverageSchema,
  }),
  routingStates: botOwnershipRoutingStatesSchema.optional(),
  anomalies: botOwnershipAnomaliesSchema,
  repair: botOwnershipRepairSnapshotSchema,
});
export type BotOwnershipFoundationSnapshot = z.infer<typeof botOwnershipFoundationSnapshotSchema>;

export const systemDashboardBurstSchema = z.object({
  active: z.boolean(),
  peakLagSec: z.number().min(0),
  peakBotId: z.string().nullable(),
  startedAt: z.string().datetime().nullable(),
  lastRecoveredAt: z.string().datetime().nullable(),
  sampleAgeMs: z.number().int().min(0),
});
export type SystemDashboardBurst = z.infer<typeof systemDashboardBurstSchema>;

export const systemDashboardHotPathStageSchema = z.object({
  stage: z.string(),
  count: z.number().int().min(0),
  slowCount: z.number().int().min(0),
  timeoutCount: z.number().int().min(0),
  skipCount: z.number().int().min(0),
  failOpenCount: z.number().int().min(0),
  avgElapsedMs: z.number().min(0),
  maxElapsedMs: z.number().int().min(0),
  lastObservedAt: z.string().datetime().nullable(),
});
export type SystemDashboardHotPathStage = z.infer<typeof systemDashboardHotPathStageSchema>;

export const systemDashboardHotPathSchema = z.object({
  windowSec: z.number().int().positive(),
  failOpenCount: z.number().int().min(0),
  stages: z.array(systemDashboardHotPathStageSchema),
});
export type SystemDashboardHotPath = z.infer<typeof systemDashboardHotPathSchema>;

export const systemDashboardHotChatSchema = z.object({
  chatId: z.string(),
  messageCreatedCount: z.number().int().min(0),
  messageEditedCount: z.number().int().min(0).optional(),
  deliveryCount: z.number().int().min(0).optional(),
  executionCount: z.number().int().min(0).optional(),
  mirrorCount: z.number().int().min(0).optional(),
  botsSeen: z.number().int().min(0),
  lastSeenAt: z.string().datetime(),
});
export type SystemDashboardHotChat = z.infer<typeof systemDashboardHotChatSchema>;

export const systemDashboardHotChatsSchema = z.object({
  windowSec: z.number().int().positive(),
  items: z.array(systemDashboardHotChatSchema),
});
export type SystemDashboardHotChats = z.infer<typeof systemDashboardHotChatsSchema>;

export const systemDashboardBackgroundBudgetSourceSchema = z.object({
  sourceTag: z.string(),
  totalRequests: z.number().int().min(0),
  avgRps: z.number().min(0),
  peakRps: z.number().int().min(0),
});
export type SystemDashboardBackgroundBudgetSource = z.infer<
  typeof systemDashboardBackgroundBudgetSourceSchema
>;

export const systemDashboardBackgroundBudgetPauseReasonSchema = z.object({
  component: z.string(),
  sourceTag: z.string(),
  action: z.enum(['run', 'slow', 'pause']),
  reason: z.string(),
  count: z.number().int().min(0),
  lastObservedAt: z.string().datetime().nullable(),
});
export type SystemDashboardBackgroundBudgetPauseReason = z.infer<
  typeof systemDashboardBackgroundBudgetPauseReasonSchema
>;

export const systemDashboardBackgroundBudgetBotLoadSchema = z.object({
  maxSmoothedLoad: z.number().min(0),
  maxPeakLoad: z.number().min(0),
  slowThreshold: z.number().min(0).max(1),
  pauseThreshold: z.number().min(0).max(1),
  topBots: z.array(
    z.object({
      botId: z.string(),
      smoothedLoad: z.number().min(0),
      peakLoad: z.number().min(0),
      avgLoad: z.number().min(0),
    }),
  ),
});
export type SystemDashboardBackgroundBudgetBotLoad = z.infer<
  typeof systemDashboardBackgroundBudgetBotLoadSchema
>;

export const systemDashboardBackgroundBudgetStackLoadSchema = z.object({
  windowSec: z.number().int().positive(),
  smoothedLoad: z.number().min(0),
  peakLoad: z.number().min(0),
  avgLoad: z.number().min(0),
  slowThreshold: z.number().min(0).max(1),
  pauseThreshold: z.number().min(0).max(1),
});
export type SystemDashboardBackgroundBudgetStackLoad = z.infer<
  typeof systemDashboardBackgroundBudgetStackLoadSchema
>;

export const systemDashboardBackgroundBudgetSchema = z.object({
  windowSec: z.number().int().positive(),
  backgroundShare: z.number().min(0).max(1),
  topSources: z.array(systemDashboardBackgroundBudgetSourceSchema),
  pauseReasons: z.array(systemDashboardBackgroundBudgetPauseReasonSchema),
  stackLoad: systemDashboardBackgroundBudgetStackLoadSchema.optional(),
  botLoad: systemDashboardBackgroundBudgetBotLoadSchema.optional(),
});
export type SystemDashboardBackgroundBudget = z.infer<typeof systemDashboardBackgroundBudgetSchema>;

export const systemDashboardMembershipLookupSampleSchema = z.object({
  chatId: z.string(),
  policyName: z.string(),
  lastObservedAt: z.string().datetime(),
  retryAfterMs: z.number().int().min(0).nullable(),
});
export type SystemDashboardMembershipLookupSample = z.infer<
  typeof systemDashboardMembershipLookupSampleSchema
>;

export const systemDashboardMembershipLookupIssueSampleSchema =
  systemDashboardMembershipLookupSampleSchema.extend({
    kind: z.enum(['transient', 'terminal']),
  });
export type SystemDashboardMembershipLookupIssueSample = z.infer<
  typeof systemDashboardMembershipLookupIssueSampleSchema
>;

export const systemDashboardMembershipLookupSchema = z.object({
  windowSec: z.number().int().positive(),
  hotChannels: z.number().int().min(0),
  backoffActiveChats: z.number().int().min(0),
  transientIssues: z.number().int().min(0),
  terminalIssues: z.number().int().min(0),
  hotChannelsSample: z.array(systemDashboardMembershipLookupSampleSchema),
  backoffSample: z.array(systemDashboardMembershipLookupSampleSchema),
  issueSample: z.array(systemDashboardMembershipLookupIssueSampleSchema),
});
export type SystemDashboardMembershipLookup = z.infer<typeof systemDashboardMembershipLookupSchema>;

export const systemDashboardProblemChatSeveritySchema = z.enum(['info', 'warning', 'critical']);
export type SystemDashboardProblemChatSeverity = z.infer<
  typeof systemDashboardProblemChatSeveritySchema
>;

export const systemDashboardProblemChatSchema = z.object({
  chatId: z.string(),
  botId: z.string().nullable(),
  category: z.string(),
  severity: systemDashboardProblemChatSeveritySchema,
  action: z.string().nullable(),
  statusCode: z.number().int().positive().nullable(),
  reason: z.string(),
  count: z.number().int().min(0),
  lastObservedAt: z.string().datetime(),
});
export type SystemDashboardProblemChat = z.infer<typeof systemDashboardProblemChatSchema>;

export const systemDashboardProblemChatsSchema = z.object({
  windowSec: z.number().int().positive(),
  items: z.array(systemDashboardProblemChatSchema),
});
export type SystemDashboardProblemChats = z.infer<typeof systemDashboardProblemChatsSchema>;

export const systemDashboardSpammerSurfaceTimingSchema = z.object({
  surface: z.string(),
  stage: z.string(),
  count: z.number().int().min(0),
  avgMs: z.number().min(0),
  p95Ms: z.number().min(0),
  p99Ms: z.number().min(0),
  maxMs: z.number().int().min(0),
  lastObservedAt: z.string().datetime().nullable(),
});
export type SystemDashboardSpammerSurfaceTiming = z.infer<
  typeof systemDashboardSpammerSurfaceTimingSchema
>;

export const systemDashboardSpammerSurfacesSchema = z.object({
  windowSec: z.number().int().positive(),
  timings: z.array(systemDashboardSpammerSurfaceTimingSchema),
});
export type SystemDashboardSpammerSurfaces = z.infer<typeof systemDashboardSpammerSurfacesSchema>;

export const systemDashboardSpammerReadModelSchema = z.object({
  windowSec: z.number().int().positive(),
  profileReads: z.object({
    hits: z.number().int().min(0),
    misses: z.number().int().min(0),
    stale: z.number().int().min(0),
    fallbacks: z.number().int().min(0),
    hitRate: z.number().min(0).max(1),
  }),
  shadow: z.object({
    compared: z.number().int().min(0),
    matched: z.number().int().min(0),
    mismatched: z.number().int().min(0),
    scoreDrift: z.number().int().min(0),
    scoreDriftRate: z.number().min(0).max(1),
    mismatchRate: z.number().min(0).max(1),
  }),
  profileWrites: z.object({
    success: z.number().int().min(0),
    failure: z.number().int().min(0),
  }),
  denormJobs: z.object({
    enqueued: z.number().int().min(0),
    enqueueFailed: z.number().int().min(0),
    fastPathEnqueued: z.number().int().min(0),
    fastPathFallbacks: z.number().int().min(0),
    fastPathReplayed: z.number().int().min(0),
    fastPathReplayMissing: z.number().int().min(0),
    processed: z.number().int().min(0),
    failed: z.number().int().min(0),
    avgAgeMs: z.number().min(0),
    maxAgeMs: z.number().int().min(0),
    lastSuccessAt: z.string().datetime().nullable(),
    lastFailureAt: z.string().datetime().nullable(),
  }),
});
export type SystemDashboardSpammerReadModel = z.infer<typeof systemDashboardSpammerReadModelSchema>;

export const systemDashboardWebhookSloStatusSchema = z.enum(['healthy', 'warning', 'critical']);
export type SystemDashboardWebhookSloStatus = z.infer<typeof systemDashboardWebhookSloStatusSchema>;

export const systemDashboardWebhookEnqueueSloSchema = z.object({
  targetMs: z.number().int().positive(),
  sampledEvents: z.number().int().min(0),
  sampleTruncated: z.boolean().optional(),
  sampledFrom: z.string().datetime().nullable().optional(),
  p95LatencyMs: z.number().min(0).nullable(),
  p99LatencyMs: z.number().min(0).nullable(),
  underTargetRatio: z.number().min(0).max(1).nullable(),
  oldestPendingLagSec: z.number().min(0),
  oldestPendingEventId: z.string().nullable(),
  lastQueuedAt: z.string().datetime().nullable(),
});
export type SystemDashboardWebhookEnqueueSlo = z.infer<
  typeof systemDashboardWebhookEnqueueSloSchema
>;

export const systemDashboardWebhookIngressBotMetricsSchema = z.object({
  attemptedReceipts: z.number().int().min(0),
  persistedReceipts: z.number().int().min(0),
  failedReceipts: z.number().int().min(0),
  rejectedReceipts: z.number().int().min(0).default(0),
});
export type SystemDashboardWebhookIngressBotMetrics = z.infer<
  typeof systemDashboardWebhookIngressBotMetricsSchema
>;

export const systemDashboardWebhookRouteOutcomeCountsSchema = z.object({
  accepted: z.number().int().min(0),
  authentication_rejected: z.number().int().min(0),
  admission_rejected: z.number().int().min(0),
  invalid_json: z.number().int().min(0),
  invalid_payload: z.number().int().min(0),
  payload_too_large: z.number().int().min(0),
  timed_out: z.number().int().min(0),
  failed: z.number().int().min(0),
});
export type SystemDashboardWebhookRouteOutcomeCounts = z.infer<
  typeof systemDashboardWebhookRouteOutcomeCountsSchema
>;

function validateWebhookRouteOutcomeTotal(
  value: {
    attemptedRequests: number;
    outcomes: SystemDashboardWebhookRouteOutcomeCounts;
  },
  context: z.RefinementCtx,
): void {
  const outcomeTotal = Object.values(value.outcomes).reduce((total, count) => total + count, 0);
  if (outcomeTotal !== value.attemptedRequests) {
    context.addIssue({
      code: 'custom',
      message: 'Webhook route outcome counts must equal attempted requests',
      path: ['attemptedRequests'],
    });
  }
}

export const systemDashboardWebhookRouteBotMetricsSchema = z
  .object({
    attemptedRequests: z.number().int().min(0),
    outcomes: systemDashboardWebhookRouteOutcomeCountsSchema,
  })
  .superRefine(validateWebhookRouteOutcomeTotal);
export type SystemDashboardWebhookRouteBotMetrics = z.infer<
  typeof systemDashboardWebhookRouteBotMetricsSchema
>;

export const systemDashboardWebhookRouteMetricsSchema = z
  .object({
    attemptedRequests: z.number().int().min(0),
    outcomes: systemDashboardWebhookRouteOutcomeCountsSchema,
    bots: z.record(z.string().min(1), systemDashboardWebhookRouteBotMetricsSchema),
  })
  .superRefine(validateWebhookRouteOutcomeTotal);
export type SystemDashboardWebhookRouteMetrics = z.infer<
  typeof systemDashboardWebhookRouteMetricsSchema
>;

function createEmptyWebhookRouteMetrics(): SystemDashboardWebhookRouteMetrics {
  return {
    attemptedRequests: 0,
    outcomes: {
      accepted: 0,
      authentication_rejected: 0,
      admission_rejected: 0,
      invalid_json: 0,
      invalid_payload: 0,
      payload_too_large: 0,
      timed_out: 0,
      failed: 0,
    },
    bots: {},
  };
}

export const systemDashboardWebhookMembershipCacheTimingSchema = z
  .object({
    sampled: z.number().int().min(0),
    p95DurationMs: z.number().min(0).nullable(),
    p99DurationMs: z.number().min(0).nullable(),
    overflowSamples: z.number().int().min(0),
  })
  .superRefine((value, context) => {
    const percentilesMissing = value.p95DurationMs === null || value.p99DurationMs === null;
    if (value.overflowSamples > value.sampled) {
      context.addIssue({
        code: 'custom',
        path: ['overflowSamples'],
        message: 'Overflow samples cannot exceed the timing sample count.',
      });
    }
    if (value.sampled === 0 && (!percentilesMissing || value.overflowSamples !== 0)) {
      context.addIssue({
        code: 'custom',
        path: ['sampled'],
        message: 'Empty timing samples require null percentiles and zero overflow.',
      });
    }
    if (value.sampled > 0 && percentilesMissing) {
      context.addIssue({
        code: 'custom',
        path: ['p95DurationMs'],
        message: 'Non-empty timing samples require both percentiles.',
      });
    }
    if (
      value.p95DurationMs !== null &&
      value.p99DurationMs !== null &&
      value.p95DurationMs > value.p99DurationMs
    ) {
      context.addIssue({
        code: 'custom',
        path: ['p99DurationMs'],
        message: 'The p99 duration cannot be below p95.',
      });
    }
  });
export type SystemDashboardWebhookMembershipCacheTiming = z.infer<
  typeof systemDashboardWebhookMembershipCacheTimingSchema
>;

export const systemDashboardWebhookMembershipCacheMetricsSchema = z
  .object({
    precheck: z.object({
      hit: z.number().int().min(0),
      miss: z.number().int().min(0),
      failOpen: z.number().int().min(0),
      timing: systemDashboardWebhookMembershipCacheTimingSchema,
    }),
    lua: z.object({
      applied: z.number().int().min(0),
      superseded: z.number().int().min(0),
      conflict: z.number().int().min(0),
      retry: z.number().int().min(0),
      exhausted: z.number().int().min(0),
      failed: z.number().int().min(0),
      timing: systemDashboardWebhookMembershipCacheTimingSchema,
    }),
    budget: z.object({
      completed: z.number().int().min(0),
      timeout: z.number().int().min(0),
      timing: systemDashboardWebhookMembershipCacheTimingSchema,
    }),
    detached: z
      .object({
        completed: z.number().int().min(0).default(0),
        timeout: z.number().int().min(0).default(0),
        failure: z.number().int().min(0).default(0),
        peakInFlight: z.number().int().min(0).max(1_024).default(0),
        rejected: z.number().int().min(0).default(0),
      })
      .optional()
      .default({
        completed: 0,
        timeout: 0,
        failure: 0,
        peakInFlight: 0,
        rejected: 0,
      }),
  })
  .superRefine((value, context) => {
    const precheckSamples = value.precheck.hit + value.precheck.miss + value.precheck.failOpen;
    const luaSamples =
      value.lua.applied + value.lua.superseded + value.lua.conflict + value.lua.failed;
    const budgetSamples = value.budget.completed + value.budget.timeout;
    for (const [path, actual, expected] of [
      ['precheck', value.precheck.timing.sampled, precheckSamples],
      ['lua', value.lua.timing.sampled, luaSamples],
      ['budget', value.budget.timing.sampled, budgetSamples],
    ] as const) {
      if (actual !== expected) {
        context.addIssue({
          code: 'custom',
          path: [path, 'timing', 'sampled'],
          message: 'Timing samples must match the outcomes that record durations.',
        });
      }
    }
  });
export type SystemDashboardWebhookMembershipCacheMetrics = z.infer<
  typeof systemDashboardWebhookMembershipCacheMetricsSchema
>;

export const systemDashboardWebhookMembershipTransitionMetricsSchema = z
  .object({
    edgeAdvance: z.object({
      calls: z.number().int().min(0),
      affectedRows: z.number().int().min(0),
      noOpCalls: z.number().int().min(0),
      timing: systemDashboardWebhookMembershipCacheTimingSchema,
    }),
  })
  .superRefine((value, context) => {
    if (value.edgeAdvance.noOpCalls > value.edgeAdvance.calls) {
      context.addIssue({
        code: 'custom',
        path: ['edgeAdvance', 'noOpCalls'],
        message: 'No-op edge advances cannot exceed total calls.',
      });
    }
    if (value.edgeAdvance.timing.sampled !== value.edgeAdvance.calls) {
      context.addIssue({
        code: 'custom',
        path: ['edgeAdvance', 'timing', 'sampled'],
        message: 'Every edge-advance call must have one timing sample.',
      });
    }
  });
export type SystemDashboardWebhookMembershipTransitionMetrics = z.infer<
  typeof systemDashboardWebhookMembershipTransitionMetricsSchema
>;

export const systemDashboardWebhookMembershipCacheAlertSignalSchema = z
  .object({
    sampled: z.number().int().min(0),
    affected: z.number().int().min(0),
    ratio: z.number().min(0).max(1).nullable(),
  })
  .superRefine((value, context) => {
    if (value.affected > value.sampled) {
      context.addIssue({
        code: 'custom',
        path: ['affected'],
        message: 'Affected samples cannot exceed total samples.',
      });
    }
    if (value.sampled === 0 && value.ratio !== null) {
      context.addIssue({
        code: 'custom',
        path: ['ratio'],
        message: 'An empty signal must have a null ratio.',
      });
    }
    if (value.sampled > 0) {
      const expectedRatio = value.affected / value.sampled;
      if (value.ratio === null || Math.abs(value.ratio - expectedRatio) > 1e-12) {
        context.addIssue({
          code: 'custom',
          path: ['ratio'],
          message: 'Signal ratio must match affected divided by sampled.',
        });
      }
    }
  });
export type SystemDashboardWebhookMembershipCacheAlertSignal = z.infer<
  typeof systemDashboardWebhookMembershipCacheAlertSignalSchema
>;

export const systemDashboardWebhookMembershipCacheAlertThresholdSchema = z.object({
  minimumSamples: z.number().int().positive(),
  minimumAffected: z.number().int().positive(),
  ratio: z.number().positive().max(1),
});
export type SystemDashboardWebhookMembershipCacheAlertThreshold = z.infer<
  typeof systemDashboardWebhookMembershipCacheAlertThresholdSchema
>;

export const systemDashboardWebhookMembershipCacheSloSchema = z
  .object({
    status: systemDashboardWebhookSloStatusSchema,
    precheckFailOpen: systemDashboardWebhookMembershipCacheAlertSignalSchema,
    luaConflict: systemDashboardWebhookMembershipCacheAlertSignalSchema,
    luaTerminalFailure: systemDashboardWebhookMembershipCacheAlertSignalSchema,
    budgetTimeout: systemDashboardWebhookMembershipCacheAlertSignalSchema,
    detachedFailure: systemDashboardWebhookMembershipCacheAlertSignalSchema.optional().default({
      sampled: 0,
      affected: 0,
      ratio: null,
    }),
    thresholds: z.object({
      warning: systemDashboardWebhookMembershipCacheAlertThresholdSchema,
      critical: systemDashboardWebhookMembershipCacheAlertThresholdSchema,
    }),
  })
  .superRefine((value, context) => {
    const { warning, critical } = value.thresholds;
    if (
      critical.minimumSamples < warning.minimumSamples ||
      critical.minimumAffected < warning.minimumAffected ||
      critical.ratio < warning.ratio
    ) {
      context.addIssue({
        code: 'custom',
        path: ['thresholds', 'critical'],
        message: 'Critical thresholds cannot be weaker than warning thresholds.',
      });
    }
    for (const [name, threshold] of Object.entries(value.thresholds)) {
      if (threshold.minimumAffected > threshold.minimumSamples) {
        context.addIssue({
          code: 'custom',
          path: ['thresholds', name, 'minimumAffected'],
          message: 'Minimum affected samples cannot exceed minimum total samples.',
        });
      }
    }
    const signals = [
      value.precheckFailOpen,
      value.luaConflict,
      value.luaTerminalFailure,
      value.budgetTimeout,
      value.detachedFailure,
    ];
    const exceeds = (
      signal: SystemDashboardWebhookMembershipCacheAlertSignal,
      threshold: SystemDashboardWebhookMembershipCacheAlertThreshold,
    ) =>
      signal.sampled >= threshold.minimumSamples &&
      signal.affected >= threshold.minimumAffected &&
      signal.ratio !== null &&
      signal.ratio >= threshold.ratio;
    const expectedStatus = signals.some((signal) => exceeds(signal, critical))
      ? 'critical'
      : signals.some((signal) => exceeds(signal, warning))
        ? 'warning'
        : 'healthy';
    if (value.status !== expectedStatus) {
      context.addIssue({
        code: 'custom',
        path: ['status'],
        message: 'Membership-cache status must match its alert signals and thresholds.',
      });
    }
  });
export type SystemDashboardWebhookMembershipCacheSlo = z.infer<
  typeof systemDashboardWebhookMembershipCacheSloSchema
>;

export const systemDashboardWebhookIngressSloSchema = z.object({
  available: z.boolean(),
  targetMs: z.number().int().positive(),
  attemptedReceipts: z.number().int().min(0),
  persistedReceipts: z.number().int().min(0),
  failedReceipts: z.number().int().min(0),
  rejectedReceipts: z.number().int().min(0).default(0),
  sampledReceipts: z.number().int().min(0),
  p95LatencyMs: z.number().min(0).nullable(),
  p99LatencyMs: z.number().min(0).nullable(),
  underTargetRatio: z.number().min(0).max(1).nullable(),
  bots: z.record(z.string(), systemDashboardWebhookIngressBotMetricsSchema),
  route: systemDashboardWebhookRouteMetricsSchema.default(createEmptyWebhookRouteMetrics),
  membershipCache: systemDashboardWebhookMembershipCacheMetricsSchema.optional(),
  membershipTransition: systemDashboardWebhookMembershipTransitionMetricsSchema.optional(),
});
export type SystemDashboardWebhookIngressSlo = z.infer<
  typeof systemDashboardWebhookIngressSloSchema
>;

export const systemDashboardWebhookCanonicalExecutionSloSchema = z.object({
  receipts: z.number().int().min(0),
  executionClaims: z.number().int().min(0),
  claimsPerReceiptRatio: z.number().min(0).nullable(),
});
export type SystemDashboardWebhookCanonicalExecutionSlo = z.infer<
  typeof systemDashboardWebhookCanonicalExecutionSloSchema
>;

function validateWebhookSloSampleMetadata(
  context: z.RefinementCtx,
  input: {
    sampleCount: number;
    sampleLimit: number | undefined;
    sampleTruncated: boolean | undefined;
    sampledFrom: string | null | undefined;
    countPath: readonly (string | number)[];
    truncatedPath: readonly (string | number)[];
    sampledFromPath: readonly (string | number)[];
  },
): void {
  if (input.sampleLimit !== undefined && input.sampleCount > input.sampleLimit) {
    context.addIssue({
      code: 'custom',
      message: 'Webhook SLO sample count cannot exceed the configured sample limit',
      path: [...input.countPath],
    });
  }
  if (
    input.sampleTruncated === true &&
    (input.sampleLimit === undefined || input.sampleCount !== input.sampleLimit)
  ) {
    context.addIssue({
      code: 'custom',
      message: 'A truncated webhook SLO sample must fill the configured sample limit',
      path: [...input.truncatedPath],
    });
  }
  if (
    input.sampledFrom !== undefined &&
    (input.sampleCount === 0) !== (input.sampledFrom === null)
  ) {
    context.addIssue({
      code: 'custom',
      message: 'Webhook SLO sampled-from timestamp must match sample availability',
      path: [...input.sampledFromPath],
    });
  }
}

export const systemDashboardWebhookSloSchema = z
  .object({
    status: systemDashboardWebhookSloStatusSchema,
    windowSec: z.number().int().positive(),
    targetProcessingMs: z.number().int().positive(),
    totalEvents: z.number().int().min(0),
    processedEvents: z.number().int().min(0),
    failedEvents: z.number().int().min(0),
    sampleLimit: z.number().int().positive().optional(),
    sampledProcessedEvents: z.number().int().min(0),
    processedSampleTruncated: z.boolean().optional(),
    processedSampledFrom: z.string().datetime().nullable().optional(),
    p95ProcessingMs: z.number().min(0).nullable(),
    p99ProcessingMs: z.number().min(0).nullable(),
    underTargetRatio: z.number().min(0).max(1).nullable(),
    oldestUnprocessedLagSec: z.number().min(0),
    oldestUnprocessedEventId: z.string().nullable(),
    lastProcessedAt: z.string().datetime().nullable(),
    ingress: systemDashboardWebhookIngressSloSchema.optional(),
    membershipCache: systemDashboardWebhookMembershipCacheSloSchema.optional(),
    enqueue: systemDashboardWebhookEnqueueSloSchema.optional(),
    canonicalExecution: systemDashboardWebhookCanonicalExecutionSloSchema.optional(),
    generatedAt: z.string().datetime(),
  })
  .superRefine((value, context) => {
    validateWebhookSloSampleMetadata(context, {
      sampleCount: value.sampledProcessedEvents,
      sampleLimit: value.sampleLimit,
      sampleTruncated: value.processedSampleTruncated,
      sampledFrom: value.processedSampledFrom,
      countPath: ['sampledProcessedEvents'],
      truncatedPath: ['processedSampleTruncated'],
      sampledFromPath: ['processedSampledFrom'],
    });
    if (value.enqueue) {
      validateWebhookSloSampleMetadata(context, {
        sampleCount: value.enqueue.sampledEvents,
        sampleLimit: value.sampleLimit,
        sampleTruncated: value.enqueue.sampleTruncated,
        sampledFrom: value.enqueue.sampledFrom,
        countPath: ['enqueue', 'sampledEvents'],
        truncatedPath: ['enqueue', 'sampleTruncated'],
        sampledFromPath: ['enqueue', 'sampledFrom'],
      });
    }
  });
export type SystemDashboardWebhookSlo = z.infer<typeof systemDashboardWebhookSloSchema>;

export const systemDashboardLatencyPercentilesSchema = z
  .object({
    sampleCount: z.number().int().min(0).max(5_000),
    excludedCount: z.number().int().min(0).max(5_000).optional(),
    p50Ms: z.number().int().min(0).nullable(),
    p95Ms: z.number().int().min(0).nullable(),
    p99Ms: z.number().int().min(0).nullable(),
  })
  .superRefine((value, context) => {
    const percentiles = [value.p50Ms, value.p95Ms, value.p99Ms];
    if (value.sampleCount === 0 && percentiles.some((item) => item !== null)) {
      context.addIssue({
        code: 'custom',
        message: 'Empty latency samples must have null percentiles',
      });
      return;
    }
    if (value.sampleCount > 0 && percentiles.some((item) => item === null)) {
      context.addIssue({
        code: 'custom',
        message: 'Non-empty latency samples must have populated percentiles',
      });
      return;
    }
    if (
      value.p50Ms !== null &&
      value.p95Ms !== null &&
      value.p99Ms !== null &&
      (value.p50Ms > value.p95Ms || value.p95Ms > value.p99Ms)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Latency percentiles must be monotonic',
      });
    }
  });
export type SystemDashboardLatencyPercentiles = z.infer<
  typeof systemDashboardLatencyPercentilesSchema
>;

export const systemDashboardActionLatencyMetricsSchema = z.object({
  effectiveReadyToLastAttempt: systemDashboardLatencyPercentilesSchema,
  lastAttemptToTerminal: systemDashboardLatencyPercentilesSchema,
  effectiveReadyToTerminal: systemDashboardLatencyPercentilesSchema,
});
export type SystemDashboardActionLatencyMetrics = z.infer<
  typeof systemDashboardActionLatencyMetricsSchema
>;

export const systemDashboardActionLatencyGroupSchema = systemDashboardActionLatencyMetricsSchema
  .extend({
    key: z.string().trim().min(1).max(256),
    rowCount: z.number().int().min(1).max(5_000),
  })
  .superRefine((value, context) => {
    for (const metric of [
      'effectiveReadyToLastAttempt',
      'lastAttemptToTerminal',
      'effectiveReadyToTerminal',
    ] as const) {
      if (
        value[metric].excludedCount !== undefined &&
        value[metric].sampleCount + value[metric].excludedCount !== value.rowCount
      ) {
        context.addIssue({
          code: 'custom',
          message: 'Latency coverage must match its row count',
          path: [metric, 'excludedCount'],
        });
      }
      if (value[metric].sampleCount > value.rowCount) {
        context.addIssue({
          code: 'custom',
          message: 'Latency sample count cannot exceed its group row count',
          path: [metric, 'sampleCount'],
        });
      }
    }
  });
export type SystemDashboardActionLatencyGroup = z.infer<
  typeof systemDashboardActionLatencyGroupSchema
>;

export const systemDashboardDeleteLatencyMetricsSchema = z.object({
  messageToFirstAttempt: systemDashboardLatencyPercentilesSchema,
  firstAttemptToTerminal: systemDashboardLatencyPercentilesSchema,
  messageToTerminal: systemDashboardLatencyPercentilesSchema,
});
export type SystemDashboardDeleteLatencyMetrics = z.infer<
  typeof systemDashboardDeleteLatencyMetricsSchema
>;

export const systemDashboardDeleteLatencyGroupSchema = systemDashboardDeleteLatencyMetricsSchema
  .extend({
    key: z.string().trim().min(1).max(256),
    rowCount: z.number().int().min(1).max(5_000),
  })
  .superRefine((value, context) => {
    for (const metric of [
      'messageToFirstAttempt',
      'firstAttemptToTerminal',
      'messageToTerminal',
    ] as const) {
      if (
        value[metric].excludedCount !== undefined &&
        value[metric].sampleCount + value[metric].excludedCount !== value.rowCount
      ) {
        context.addIssue({
          code: 'custom',
          message: 'Latency coverage must match its row count',
          path: [metric, 'excludedCount'],
        });
      }
      if (value[metric].sampleCount > value.rowCount) {
        context.addIssue({
          code: 'custom',
          message: 'Latency sample count cannot exceed its group row count',
          path: [metric, 'sampleCount'],
        });
      }
    }
  });
export type SystemDashboardDeleteLatencyGroup = z.infer<
  typeof systemDashboardDeleteLatencyGroupSchema
>;

function validateLatencyGroupRows(
  context: z.RefinementCtx,
  path: readonly string[],
  groups: ReadonlyArray<{ key: string; rowCount: number }>,
  expectedRowCount: number,
): void {
  const keys = new Set<string>();
  let rowCount = 0;
  for (const [index, group] of groups.entries()) {
    rowCount += group.rowCount;
    if (keys.has(group.key)) {
      context.addIssue({
        code: 'custom',
        message: 'Latency group keys must be unique within a dimension',
        path: [...path, index, 'key'],
      });
    }
    keys.add(group.key);
  }
  if (rowCount !== expectedRowCount) {
    context.addIssue({
      code: 'custom',
      message: 'Latency group row counts must cover the complete sample',
      path: [...path],
    });
  }
}

export const systemDashboardActionLatencySchema = z
  .object({
    basis: z.literal('terminal_outcomes'),
    windowBasis: z.literal('completed_at'),
    actionStartBasis: z.literal('max_enqueued_at_scheduled_for'),
    windowSec: z.number().int().positive(),
    windowStartedAt: z.string().datetime(),
    sampleLimit: z.number().int().positive().max(5_000),
    actionSampleCount: z.number().int().min(0).max(5_000),
    actionSampleTruncated: z.boolean(),
    actionSampledFrom: z.string().datetime().nullable(),
    readiness: z
      .array(
        z.object({
          state: z.enum([
            'KNOWN',
            'UNKNOWN_METADATA',
            'INVALID_SCHEDULE',
            'MISSING_READY_CLOCK',
            'INVALID_READY_CLOCK',
          ]),
          count: z.number().int().min(0).max(5_000),
        }),
      )
      .max(5)
      .optional(),
    scheduleClockBasis: z.literal('scalar_with_bounded_legacy_fallback').optional(),
    enqueueClockBasis: z.literal('latest_accepted_queue_or_direct_invocation').optional(),
    overall: systemDashboardActionLatencyMetricsSchema,
    byAction: z.array(systemDashboardActionLatencyGroupSchema).max(5_000),
    byOutcome: z.array(systemDashboardActionLatencyGroupSchema).max(5_000),
    bySource: z.array(systemDashboardActionLatencyGroupSchema).max(5_000),
    byBot: z.array(systemDashboardActionLatencyGroupSchema).max(5_000),
    byTrafficClass: z.array(systemDashboardActionLatencyGroupSchema).max(5_000),
    moderationDelete: z.object({
      sampleCount: z.number().int().min(0).max(5_000),
      sampleTruncated: z.boolean(),
      sampledFrom: z.string().datetime().nullable(),
      overall: systemDashboardDeleteLatencyMetricsSchema,
      byOutcome: z.array(systemDashboardDeleteLatencyGroupSchema).max(5_000),
    }),
    generatedAt: z.string().datetime(),
  })
  .superRefine((value, context) => {
    if (
      value.readiness &&
      (new Set(value.readiness.map((item) => item.state)).size !== value.readiness.length ||
        value.readiness.reduce((total, item) => total + item.count, 0) !== value.actionSampleCount)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Readiness coverage must cover the action sample exactly once',
        path: ['readiness'],
      });
    }
    if (value.actionSampleCount > value.sampleLimit) {
      context.addIssue({
        code: 'custom',
        message: 'Action sample count cannot exceed the configured sample limit',
        path: ['actionSampleCount'],
      });
    }
    if (value.moderationDelete.sampleCount > value.sampleLimit) {
      context.addIssue({
        code: 'custom',
        message: 'Delete sample count cannot exceed the configured sample limit',
        path: ['moderationDelete', 'sampleCount'],
      });
    }
    if (value.actionSampleTruncated && value.actionSampleCount !== value.sampleLimit) {
      context.addIssue({
        code: 'custom',
        message: 'A truncated action sample must fill the configured sample limit',
        path: ['actionSampleTruncated'],
      });
    }
    if (
      value.moderationDelete.sampleTruncated &&
      value.moderationDelete.sampleCount !== value.sampleLimit
    ) {
      context.addIssue({
        code: 'custom',
        message: 'A truncated delete sample must fill the configured sample limit',
        path: ['moderationDelete', 'sampleTruncated'],
      });
    }
    if ((value.actionSampleCount === 0) !== (value.actionSampledFrom === null)) {
      context.addIssue({
        code: 'custom',
        message: 'Action sampled-from timestamp must match sample availability',
        path: ['actionSampledFrom'],
      });
    }
    if (
      (value.moderationDelete.sampleCount === 0) !==
      (value.moderationDelete.sampledFrom === null)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Delete sampled-from timestamp must match sample availability',
        path: ['moderationDelete', 'sampledFrom'],
      });
    }
    for (const metric of [
      'effectiveReadyToLastAttempt',
      'lastAttemptToTerminal',
      'effectiveReadyToTerminal',
    ] as const) {
      if (
        value.overall[metric].excludedCount !== undefined &&
        value.overall[metric].sampleCount + value.overall[metric].excludedCount !==
          value.actionSampleCount
      ) {
        context.addIssue({
          code: 'custom',
          message: 'Latency coverage must match the action row count',
          path: ['overall', metric, 'excludedCount'],
        });
      }
      if (value.overall[metric].sampleCount > value.actionSampleCount) {
        context.addIssue({
          code: 'custom',
          message: 'Latency sample count cannot exceed the action row count',
          path: ['overall', metric, 'sampleCount'],
        });
      }
    }
    for (const metric of [
      'messageToFirstAttempt',
      'firstAttemptToTerminal',
      'messageToTerminal',
    ] as const) {
      if (
        value.moderationDelete.overall[metric].excludedCount !== undefined &&
        value.moderationDelete.overall[metric].sampleCount +
          value.moderationDelete.overall[metric].excludedCount !==
          value.moderationDelete.sampleCount
      ) {
        context.addIssue({
          code: 'custom',
          message: 'Latency coverage must match the delete row count',
          path: ['moderationDelete', 'overall', metric, 'excludedCount'],
        });
      }
      if (value.moderationDelete.overall[metric].sampleCount > value.moderationDelete.sampleCount) {
        context.addIssue({
          code: 'custom',
          message: 'Latency sample count cannot exceed the delete row count',
          path: ['moderationDelete', 'overall', metric, 'sampleCount'],
        });
      }
    }

    const generatedAtMs = Date.parse(value.generatedAt);
    const windowStartedAtMs = Date.parse(value.windowStartedAt);
    if (windowStartedAtMs > generatedAtMs) {
      context.addIssue({
        code: 'custom',
        message: 'Latency window cannot start after the snapshot was generated',
        path: ['windowStartedAt'],
      });
    }
    if (generatedAtMs - windowStartedAtMs !== value.windowSec * 1_000) {
      context.addIssue({
        code: 'custom',
        message: 'Latency window timestamps must match the declared window length',
        path: ['windowSec'],
      });
    }
    for (const [sampledFrom, path] of [
      [value.actionSampledFrom, ['actionSampledFrom']],
      [value.moderationDelete.sampledFrom, ['moderationDelete', 'sampledFrom']],
    ] as const) {
      if (sampledFrom === null) {
        continue;
      }
      const sampledFromMs = Date.parse(sampledFrom);
      if (sampledFromMs < windowStartedAtMs || sampledFromMs > generatedAtMs) {
        context.addIssue({
          code: 'custom',
          message: 'Sampled-from timestamp must fall inside the latency window',
          path: [...path],
        });
      }
    }

    const actionDimensions = [
      ['byAction', value.byAction],
      ['byOutcome', value.byOutcome],
      ['bySource', value.bySource],
      ['byBot', value.byBot],
      ['byTrafficClass', value.byTrafficClass],
    ] as const;
    const actionMetrics = [
      'effectiveReadyToLastAttempt',
      'lastAttemptToTerminal',
      'effectiveReadyToTerminal',
    ] as const;
    for (const [dimension, groups] of actionDimensions) {
      validateLatencyGroupRows(context, [dimension], groups, value.actionSampleCount);
      for (const metric of actionMetrics) {
        const groupedSampleCount = groups.reduce(
          (total, group) => total + group[metric].sampleCount,
          0,
        );
        if (groupedSampleCount !== value.overall[metric].sampleCount) {
          context.addIssue({
            code: 'custom',
            message: 'Grouped latency sample counts must match the overall metric sample',
            path: [dimension],
          });
        }
      }
    }

    validateLatencyGroupRows(
      context,
      ['moderationDelete', 'byOutcome'],
      value.moderationDelete.byOutcome,
      value.moderationDelete.sampleCount,
    );
    for (const metric of [
      'messageToFirstAttempt',
      'firstAttemptToTerminal',
      'messageToTerminal',
    ] as const) {
      const groupedSampleCount = value.moderationDelete.byOutcome.reduce(
        (total, group) => total + group[metric].sampleCount,
        0,
      );
      if (groupedSampleCount !== value.moderationDelete.overall[metric].sampleCount) {
        context.addIssue({
          code: 'custom',
          message: 'Grouped delete latency sample counts must match the overall metric sample',
          path: ['moderationDelete', 'byOutcome'],
        });
      }
    }
  });
export type SystemDashboardActionLatency = z.infer<typeof systemDashboardActionLatencySchema>;

export const systemRuntimeRoleSchema = z.enum([
  'message-retention',
  'all',
  'ingress',
  'admin',
  'enqueue',
  'moderation',
  'action',
  'publisher',
]);
export type SystemRuntimeRole = z.infer<typeof systemRuntimeRoleSchema>;

export const systemRuntimeTopologySourceSchema = z.enum([
  'declared-service',
  'role-inference',
  'queue-inference',
  'fallback',
]);
export type SystemRuntimeTopologySource = z.infer<typeof systemRuntimeTopologySourceSchema>;

export const systemRuntimeQueuePrioritySchema = z.enum([
  'all',
  'http-ingress',
  'admin-heavy-read',
  'webhook-enqueue',
  'user-facing-critical',
  'user-facing-realtime',
  'background',
  'action-dispatch',
  'publisher-dispatch',
]);
export type SystemRuntimeQueuePriority = z.infer<typeof systemRuntimeQueuePrioritySchema>;

export const systemDynamicLeasesModeSchema = z.enum(['off', 'shadow', 'canary', 'on']);
export type SystemDynamicLeasesMode = z.infer<typeof systemDynamicLeasesModeSchema>;

export const systemRuntimeProfileSchema = z.object({
  appRole: systemRuntimeRoleSchema,
  serviceName: z.string().optional(),
  serviceTitle: z.string().optional(),
  queueProfile: z.string().optional(),
  queuePriority: systemRuntimeQueuePrioritySchema.optional(),
  topologySource: systemRuntimeTopologySourceSchema.optional(),
  httpEnabled: z.boolean(),
  ingressEnabled: z.boolean(),
  adminEnabled: z.boolean(),
  enqueueEnabled: z.boolean(),
  moderationEnabled: z.boolean(),
  actionEnabled: z.boolean(),
  publisherEnabled: z.boolean().optional().default(false),
  enabledQueues: z.array(z.string()),
  dynamicLeasesMode: systemDynamicLeasesModeSchema,
  dynamicLeasesWorkerGroup: z.string().nullable(),
  canaryShardIds: z.array(z.string()),
  targetWebhookP95Ms: z.number().int().positive(),
  generatedAt: z.string().datetime(),
});
export type SystemRuntimeProfile = z.infer<typeof systemRuntimeProfileSchema>;

export const systemCanaryStateStatusSchema = z.enum([
  'disabled',
  'shadow',
  'canary',
  'active',
  'degraded',
]);
export type SystemCanaryStateStatus = z.infer<typeof systemCanaryStateStatusSchema>;

export const systemCanaryRecommendationSchema = z.enum(['observe', 'expand', 'hold', 'rollback']);
export type SystemCanaryRecommendation = z.infer<typeof systemCanaryRecommendationSchema>;

export const systemCanaryStateSchema = z.object({
  enabled: z.boolean(),
  mode: systemDynamicLeasesModeSchema,
  status: systemCanaryStateStatusSchema,
  recommendation: systemCanaryRecommendationSchema,
  workerGroup: z.string().nullable(),
  canaryShardIds: z.array(z.string()),
  liveWorkerGroups: z.array(z.string()),
  handoffPendingQueues: z.array(z.string()),
  unhealthyQueues: z.array(z.string()),
  reason: z.string(),
});
export type SystemCanaryState = z.infer<typeof systemCanaryStateSchema>;

export const systemRollbackReadinessStatusSchema = z.enum([
  'ready',
  'blocked',
  'rollback-recommended',
]);
export type SystemRollbackReadinessStatus = z.infer<typeof systemRollbackReadinessStatusSchema>;

export const systemRollbackReadinessSchema = z.object({
  status: systemRollbackReadinessStatusSchema,
  canRollbackRuntime: z.boolean(),
  liveOk: z.boolean(),
  readyOk: z.boolean(),
  webhookSloOk: z.boolean(),
  queueLagOk: z.boolean(),
  failedWebhookOk: z.boolean(),
  reasons: z.array(z.string()),
  command: z.string(),
});
export type SystemRollbackReadiness = z.infer<typeof systemRollbackReadinessSchema>;

export const systemQueueGroupStatusSchema = z.enum(['healthy', 'warning', 'critical']);
export type SystemQueueGroupStatus = z.infer<typeof systemQueueGroupStatusSchema>;

export const systemQueueGroupSchema = z.object({
  name: z.string(),
  queues: z.array(z.string()),
  waiting: z.number().int().min(0),
  active: z.number().int().min(0),
  delayed: z.number().int().min(0),
  failed: z.number().int().min(0),
  completed: z.number().int().min(0),
  pressure: z.number().int().min(0),
  status: systemQueueGroupStatusSchema,
});
export type SystemQueueGroup = z.infer<typeof systemQueueGroupSchema>;

export const systemQueueGroupHealthSchema = z.object({
  status: systemQueueGroupStatusSchema,
  groups: z.array(systemQueueGroupSchema),
  generatedAt: z.string().datetime(),
});
export type SystemQueueGroupHealth = z.infer<typeof systemQueueGroupHealthSchema>;

export const systemDashboardResponseSchema = z.object({
  summary: systemDashboardSummarySchema,
  alerts: z.array(systemDashboardAlertSchema),
  queues: queueMetricsSnapshotSchema,
  mode: systemModeSnapshotSchema,
  webhookSubscription: webhookSubscriptionSnapshotSchema,
  ownership: botOwnershipFoundationSnapshotSchema,
  burst: systemDashboardBurstSchema.optional(),
  hotPath: systemDashboardHotPathSchema.optional(),
  hotChats: systemDashboardHotChatsSchema.optional(),
  backgroundBudget: systemDashboardBackgroundBudgetSchema.optional(),
  membershipLookup: systemDashboardMembershipLookupSchema.optional(),
  problemChats: systemDashboardProblemChatsSchema.optional(),
  spammerSurfaces: systemDashboardSpammerSurfacesSchema.optional(),
  spammerReadModel: systemDashboardSpammerReadModelSchema.optional(),
  webhookSlo: systemDashboardWebhookSloSchema.optional(),
  slo: systemDashboardWebhookSloSchema.optional(),
  actionLatency: systemDashboardActionLatencySchema.optional(),
  runtimeProfile: systemRuntimeProfileSchema.optional(),
  canaryState: systemCanaryStateSchema.optional(),
  rollbackReadiness: systemRollbackReadinessSchema.optional(),
  queueGroupHealth: systemQueueGroupHealthSchema.optional(),
});
export type SystemDashboardResponse = z.infer<typeof systemDashboardResponseSchema>;
