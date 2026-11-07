import { InjectQueue } from '@nestjs/bullmq';
import { BadRequestException, Injectable, Logger, OnModuleDestroy, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Queue } from 'bullmq';
import { createHash, randomUUID } from 'node:crypto';
import {
  COMMERCIAL_CAMPAIGN_WINDOW_SEC,
  type CommercialCampaignContext,
} from './commercial-campaign.util';
import { Prisma } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import { WebhookLegacyHoldService } from '../webhook/webhook-legacy-hold.service';
import { type RuleViolation } from './rule-engine.contract';
import { maskText } from './text-mask.util';
import { MaxBotRegistryService } from '../max/max-bot-registry.service';
import {
  RuntimeDiagnosticsService,
  type SpammerReadModelEvent,
} from '../system/runtime-diagnostics.service';
import { RedisCounterService } from './redis-counter.service';
import {
  buildGlobalSpammerDenormDeduplicationId,
  GLOBAL_SPAMMER_DENORM_JOB_ATTEMPTS,
  GLOBAL_SPAMMER_DENORM_JOB_BACKOFF_MS,
  GLOBAL_SPAMMER_DENORM_JOB_NAME,
  GLOBAL_SPAMMER_DENORM_QUEUE,
  type GlobalSpammerDenormJob,
} from './global-spammer-denorm.queue';

export const GLOBAL_SPAMMER_OBSERVATION_SOURCES = [
  'FANOUT_HIGH',
  'FANOUT_REPEAT',
  'COMMERCIAL_AD',
  'COMMERCIAL_CAMPAIGN',
  'REPEATED_LINK',
  'REPEATED_PHONE',
  'GRAPH_DOMAIN',
  'GRAPH_PHONE',
  'GRAPH_TEXT',
  'GRAPH_CAMPAIGN',
  'GRAPH_FANOUT_PATTERN',
  'SANCTION_BAN',
  'MANUAL_BAN',
  'DEVELOPER_FORCED',
  'LOCAL_ADMIN_BLOCK',
  'LOCAL_ADMIN_ALLOW',
  'REVIEW_APPROVED',
] as const;

export type GlobalSpammerObservationSource = (typeof GLOBAL_SPAMMER_OBSERVATION_SOURCES)[number];
export type GlobalSpammerConfidenceLevel = 'LOW' | 'MEDIUM' | 'HIGH';
export type GlobalSpammerCandidateStatus = 'PENDING' | 'AUTO_APPROVED' | 'APPROVED' | 'SUPPRESSED';

export type GlobalSpammerObservationInput = {
  userId: string;
  source: GlobalSpammerObservationSource;
  score: number;
  reason: string;
  chatId?: string | null;
  messageId?: string | null;
  userLabel?: string | null;
  evidence?: Prisma.InputJsonValue;
  evidenceHash?: string | null;
  observedAt?: Date;
  ttlDays?: number;
  registryTtlDays?: number | null;
  forceRegistry?: boolean;
};

export type GlobalSpammerSuppressionInput = {
  userId: string;
  source: 'MANUAL_UNBAN' | 'ADMIN_EXEMPTION' | 'REVIEW_SUPPRESSION';
  reason: string;
  adminUserId?: string | null;
  sourceChatId?: string | null;
  ttlDays?: number;
  evidence?: Prisma.InputJsonValue;
  falsePositive?: boolean;
};

export type GlobalSpammerObservationDecision = {
  outcome: 'ignored' | 'observed' | 'candidate' | 'registry' | 'suppressed';
  userId: string;
  aggregateScore: number;
  confidenceLevel: GlobalSpammerConfidenceLevel;
  sourceBreakdown: Prisma.InputJsonValue;
  evidenceHash?: string;
  suppressedUntil?: string | null;
};

export type GlobalSpammerArchiveExpiredResult = {
  ok: true;
  dryRun: boolean;
  cutoff: string;
  scanned: number;
  archived: number;
  deleted: number;
  remainingExpired: number | null;
};

export type GlobalSpammerPrivacyPruneResult = {
  ok: true;
  cutoff: string;
  scanned: number;
  pruned: number;
  failed?: number;
  failedIds?: string[];
};

type ActiveObservationRow = {
  id?: string;
  userId?: string;
  source: string;
  score: number;
  reason: string;
  chatId?: string | null;
  messageId?: string | null;
  evidenceHash?: string;
  evidence?: Prisma.JsonValue | null;
  observedAt: Date;
  expiresAt: Date;
};

type AggregateSource = {
  source: string;
  score: number;
  rawScore: number;
  reputationWeight: number;
  falsePositiveRate: number;
  count: number;
  latestAt: string;
  reasons: string[];
  mitigating: boolean;
};

type AggregateResult = {
  score: number;
  confidenceLevel: GlobalSpammerConfidenceLevel;
  sources: AggregateSource[];
  sourceBreakdown: Prisma.InputJsonObject;
};

type CandidateReviewAction = 'APPROVE' | 'SUPPRESS';
export type LocalAdminSpammerDecision = 'ALLOW' | 'BLOCK' | 'REVIEW';
type GlobalSpammerRegistryStatus =
  | 'NONE'
  | 'ACTIVE_CONFIRMED'
  | 'LOCAL_BLOCKED'
  | 'MEDIUM_REVIEW'
  | 'SUPPRESSED'
  | 'EXPIRED'
  | 'ADMIN_EXEMPT';
type GlobalSpammerPolicyAction = 'NONE' | 'DELETE_AND_KICK' | 'SHADOW_DELETE_AND_KICK';
type GlobalSpammerEnforcementMode = 'enforce' | 'shadow';
type GlobalSpammerReviewMetricsMode = 'summary' | 'full';
type SpammerGraphSignalType = 'DOMAIN' | 'PHONE' | 'TEXT' | 'CAMPAIGN' | 'FANOUT_PATTERN';
type GlobalSpammerPolicyBand = 'LOW' | 'MEDIUM' | 'HIGH' | 'VERY_HIGH' | 'CONFIRMED';
type SpammerPrivacyClass = 'STANDARD' | 'SENSITIVE_TEXT' | 'HIGH_SENSITIVITY' | 'MINIMIZED';
type SpammerCampaignSignalType =
  | 'DOMAIN'
  | 'PHONE'
  | 'URL'
  | 'TEXT_SIGNATURE'
  | 'MEDIA_SIGNATURE'
  | 'CAMPAIGN'
  | 'FANOUT_PATTERN';

export type GlobalSpammerPolicyDecision = {
  userId: string;
  chatId: string | null;
  trigger: string;
  registryStatus: GlobalSpammerRegistryStatus;
  action: GlobalSpammerPolicyAction;
  enforcementMode: GlobalSpammerEnforcementMode;
  policyBand: GlobalSpammerPolicyBand;
  deleteSpammersEnabled: boolean;
  adminExempt: boolean;
  shadow: boolean;
  wouldEnforce: boolean;
  enforced: boolean;
  confidenceScore: number | null;
  shadowScore: number | null;
  reason: string;
  expiresAt: string | null;
  sourceBreakdown: Prisma.InputJsonValue | null;
  campaignBreakdown: Prisma.InputJsonValue | null;
};

export type GlobalSpammerUserDiagnostics = {
  userId: string;
  chatId: string | null;
  policy: GlobalSpammerPolicyDecision;
  registry: {
    active: boolean;
    expired: boolean;
    confidenceScore: number | null;
    confirmedAt: string | null;
    confirmedByUserId: string | null;
    reason: string | null;
    expiresAt: string | null;
    sourceBreakdown: Prisma.JsonValue | null;
  };
  candidate: {
    status: string;
    confidenceScore: number;
    lastReason: string;
    reviewedAt: string | null;
    reviewedByUserId: string | null;
    reviewReason: string | null;
    falsePositive: boolean;
  } | null;
  activeSuppression: {
    source: string;
    reason: string;
    adminUserId: string | null;
    suppressedUntil: string;
  } | null;
  observations: Array<{
    id: string;
    source: string;
    score: number;
    confidenceLevel: string;
    reason: string;
    chatId: string | null;
    observedAt: string;
    expiresAt: string;
    suppressedAt: string | null;
  }>;
  graphSignals: Array<{
    signalType: string;
    source: string;
    score: number;
    chatId: string | null;
    observedAt: string;
    expiresAt: string;
  }>;
  sourceReputation: Array<{
    source: string;
    weight: number;
    falsePositiveRate: number;
    observations: number;
    suppressed: number;
  }>;
  campaigns: Array<{
    clusterId: string;
    signalType: string;
    status: string;
    confidenceScore: number;
    distinctUsersCount: number;
    distinctChatsCount: number;
    observationsCount: number;
    userObservationsCount: number | null;
    lastSeenAt: string;
    preview: string | null;
  }>;
  latestShadowScore: {
    currentScore: number;
    v2Score: number;
    scoreDelta: number;
    currentBand: string;
    v2Band: string;
    wouldPromote: boolean;
    wouldSuppress: boolean;
    createdAt: string;
  } | null;
  localAdminDecision: {
    decision: LocalAdminSpammerDecision;
    reason: string;
    sourceChatId: string | null;
    decidedByUserIds: string[];
    updatedAt: string;
  } | null;
  reputationSummary: {
    naturalBanSignals: number;
    localBlockSignals: number;
    localAllowSignals: number;
    onlyReputationSignals: boolean;
    note: string;
  };
};

export type GlobalSpammerUserDiagnosticsOptions = {
  includeObservations?: boolean;
  includeGraphSignals?: boolean;
  includeReputation?: boolean;
  includeCampaigns?: boolean;
  includeShadow?: boolean;
};

export type GlobalSpammerLocalProfile = {
  userId: string;
  displayName: string | null;
};

type SourceReputation = {
  source: string;
  weight: number;
  falsePositiveRate: number;
  observations: number;
  suppressed: number;
};

type ExtractedGraphSignal = {
  signalType: SpammerGraphSignalType;
  source: GlobalSpammerObservationSource;
  value: string;
  reason: string;
  score: number;
  evidence: Prisma.InputJsonObject;
};

type ObservationLedgerMetadata = {
  normalizedFeatures: Prisma.InputJsonObject;
  explainReason: string;
  privacyClass: SpammerPrivacyClass;
  rawEvidenceExpiresAt: Date | null;
};

type ExtractedCampaignSignal = {
  signalType: SpammerCampaignSignalType;
  value: string;
  preview: string | null;
  source: GlobalSpammerObservationSource;
  reason: string;
  score: number;
  evidence: Prisma.InputJsonObject;
};

type CampaignClusterSummary = {
  clusterId: string;
  clusterKey: string;
  signalType: SpammerCampaignSignalType;
  signalHash: string;
  status: string;
  confidenceScore: number;
  distinctUsersCount: number;
  distinctChatsCount: number;
  observationsCount: number;
  scoreContribution: number;
  reason: string;
  preview: string | null;
};

type ShadowScoreSummary = {
  currentScore: number;
  v2Score: number;
  scoreDelta: number;
  currentBand: GlobalSpammerPolicyBand;
  v2Band: GlobalSpammerPolicyBand;
  wouldPromote: boolean;
  wouldSuppress: boolean;
  campaignBreakdown: Prisma.InputJsonObject;
};

type PolicyDecisionRiskContext = {
  shadowScore: number | null;
  campaignBreakdown: Prisma.InputJsonValue | null;
};
type PolicyDecisionRiskContextMode = 'light' | 'full';

type GlobalSpammerRow = Prisma.GlobalSpammerGetPayload<Record<string, never>>;
type GlobalSpammerCandidateRow = Prisma.GlobalSpammerCandidateGetPayload<Record<string, never>>;
type GlobalSpammerSuppressionRow = Prisma.GlobalSpammerSuppressionGetPayload<Record<string, never>>;
type GlobalSpammerRuntimeProfileRow = Prisma.GlobalSpammerRuntimeProfileGetPayload<
  Record<string, never>
>;

type PolicyDecisionLookupContext = {
  now?: Date;
  registry?: GlobalSpammerRow | null;
  candidate?: GlobalSpammerCandidateRow | null;
  activeSuppression?: GlobalSpammerSuppressionRow | null;
};

type SpammerObservationLedgerResult = {
  userId: string;
  input: GlobalSpammerObservationInput;
  score: number;
  ttlDays: number;
  observedAt: Date;
  expiresAt: Date;
  evidenceHash: string;
  confidenceLevel: GlobalSpammerConfidenceLevel;
  activeSuppression: GlobalSpammerSuppressionRow | null;
  observationId: string;
};

type DenormObservationSnapshot = {
  id: string;
  userId: string;
  source: string;
  score: number;
  reason: string;
  chatId: string | null;
  messageId: string | null;
  evidenceHash: string;
  evidence: Prisma.JsonValue | null;
  normalizedFeatures: Prisma.JsonValue;
  observedAt: Date;
  suppressedAt: Date | null;
  suppressionReason: string | null;
};

type ReviewQueueCandidateIdRow = {
  userId: string;
};

type ReviewMetricsCountRow = {
  pending: unknown;
  approved: unknown;
  suppressed: unknown;
  reviewed: unknown;
  falsePositiveCount: unknown;
  newCandidates24h: unknown;
  autoApproved24h: unknown;
  suppressed24h: unknown;
};

type ReviewMetricsObservationRow = {
  source: string;
  observedCount: unknown;
  suppressedCount: unknown;
};

type ReviewRegistryMetrics = {
  activeRegistry: number;
  expiredRegistry: number;
  archivedExpired: number;
  shadowWouldEnforceCount: number;
};

type ReviewRegistryMetricsRow = {
  activeRegistry: unknown;
  expiredRegistry: unknown;
  archivedExpired: unknown;
  shadowWouldEnforceCount: unknown;
};

type SourceReputationRow = {
  source: string;
  observedCount: unknown;
  suppressedCount: unknown;
};

type TopCampaignRow = {
  id: string;
  signalType: string;
  status: string;
  confidenceScore: number;
  distinctUsersCount: number;
  distinctChatsCount: number;
  observationsCount: number;
  lastSeenAt: Date;
  signalValuePreview: string | null;
};

type ReviewQueueObservationRow = {
  id: string;
  userId: string;
  source: string;
  score: number;
  confidenceLevel: string;
  reason: string;
  chatId: string | null;
  messageId: string | null;
  evidenceHash: string;
  evidence: Prisma.JsonValue | null;
  observedAt: Date;
  expiresAt: Date;
  suppressedAt: Date | null;
  suppressionReason: string | null;
};

type RuntimeProfileSnapshot = {
  userId: string;
  registryStatus: GlobalSpammerRegistryStatus;
  action: GlobalSpammerPolicyAction;
  confidenceScore: number | null;
  shadowScore: number | null;
  policyBand: GlobalSpammerPolicyBand;
  reason: string;
  expiresAt: string | null;
  suppressedUntil: string | null;
  sourceBreakdown: Prisma.InputJsonValue | null;
  campaignBreakdown: Prisma.InputJsonValue | null;
  sourceVersion: number;
  staleAfter: string | null;
  updatedAt: string;
};

type LocalAdminDecisionRow = {
  adminUserId: string;
  userId: string;
  sourceChatId: string | null;
  decision?: string | null;
  reason: string;
  updatedAt: Date;
};

type ResolvedLocalAdminDecision = {
  decision: LocalAdminSpammerDecision;
  reason: string;
  sourceChatId: string | null;
  decidedByUserIds: string[];
  updatedAt: Date;
} | null;

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_OBSERVATION_TTL_DAYS = 14;
const DEFAULT_SUPPRESSION_TTL_DAYS = 30;
const DEVELOPER_FORCED_REGISTRY_TTL_DAYS = 3650;
const OBSERVATION_HALF_LIFE_DAYS = 7;
const MEDIUM_CONFIDENCE_THRESHOLD = 0.55;
const HIGH_CONFIDENCE_THRESHOLD = 0.86;
const HIGH_REVIEW_THRESHOLD = 0.74;
const VERY_HIGH_CONFIDENCE_THRESHOLD = 0.92;
const CONFIRMED_CONFIDENCE_THRESHOLD = 0.97;
const RAW_EVIDENCE_RETENTION_DAYS = 14;
const REPUTATION_POSITIVE_SCORE_CAP = 0.34;
const REPUTATION_ONLY_SCORE_CAP = 0.72;
const MITIGATING_SCORE_CAP = 0.18;

const SOURCE_DEFAULT_TTL_DAYS: Partial<Record<GlobalSpammerObservationSource, number>> = {
  FANOUT_HIGH: 21,
  FANOUT_REPEAT: 14,
  COMMERCIAL_AD: 10,
  COMMERCIAL_CAMPAIGN: 14,
  REPEATED_LINK: 10,
  REPEATED_PHONE: 14,
  GRAPH_DOMAIN: 14,
  GRAPH_PHONE: 14,
  GRAPH_TEXT: 10,
  GRAPH_CAMPAIGN: 21,
  GRAPH_FANOUT_PATTERN: 7,
  SANCTION_BAN: 21,
  MANUAL_BAN: 30,
  DEVELOPER_FORCED: DEVELOPER_FORCED_REGISTRY_TTL_DAYS,
  LOCAL_ADMIN_BLOCK: 30,
  LOCAL_ADMIN_ALLOW: 30,
  REVIEW_APPROVED: 90,
};

const SOURCE_BASE_REPUTATION_WEIGHTS: Record<GlobalSpammerObservationSource, number> = {
  FANOUT_HIGH: 1,
  FANOUT_REPEAT: 0.82,
  COMMERCIAL_AD: 0.45,
  COMMERCIAL_CAMPAIGN: 0.58,
  REPEATED_LINK: 0.62,
  REPEATED_PHONE: 0.64,
  GRAPH_DOMAIN: 0.48,
  GRAPH_PHONE: 0.58,
  GRAPH_TEXT: 0.44,
  GRAPH_CAMPAIGN: 0.62,
  GRAPH_FANOUT_PATTERN: 0.52,
  SANCTION_BAN: 0.38,
  MANUAL_BAN: 0.36,
  DEVELOPER_FORCED: 1,
  LOCAL_ADMIN_BLOCK: 0.32,
  LOCAL_ADMIN_ALLOW: 0.36,
  REVIEW_APPROVED: 1,
};

const SOURCE_REPUTATION_WINDOW_DAYS = 30;
const SOURCE_REPUTATION_CACHE_TTL_MS = 30_000;
const RUNTIME_PROFILE_SOURCE_VERSION = 2;
const RUNTIME_PROFILE_L1_TTL_MS = 5_000;
const RUNTIME_PROFILE_L1_MAX_ENTRIES = 10_000;
const RUNTIME_PROFILE_L1_SWEEP_INTERVAL_MS = 5_000;
const RUNTIME_PROFILE_L1_SWEEP_BATCH_SIZE = 256;
const RUNTIME_PROFILE_REDIS_TTL_SEC = 60;
const RUNTIME_PROFILE_REDIS_NEGATIVE_TTL_SEC = 120;
const RUNTIME_PROFILE_DEFAULT_STALE_MS = 5 * 60 * 1000;
const RAW_EVIDENCE_PRUNE_TRANSACTION_CHUNK_SIZE = 100;
const RECENT_SUPPRESSION_MEMORY_DAYS = 30;
const GRAPH_SIGNAL_TTL_DAYS = 14;
const GRAPH_OBSERVATION_TTL_DAYS = 14;
const MITIGATING_OBSERVATION_SOURCES = new Set<GlobalSpammerObservationSource>([
  'LOCAL_ADMIN_ALLOW',
]);
const REPUTATION_OBSERVATION_SOURCES = new Set<GlobalSpammerObservationSource>([
  'SANCTION_BAN',
  'MANUAL_BAN',
  'LOCAL_ADMIN_BLOCK',
  'LOCAL_ADMIN_ALLOW',
]);
const PROMOTION_FANOUT_REASONS = new Set(['FANOUT_EPISODE_CONFIRMED', 'FANOUT_EPISODE_CRITICAL']);
const PROMOTION_BEHAVIOR_SOURCES = new Set<GlobalSpammerObservationSource>([
  'FANOUT_HIGH',
  'FANOUT_REPEAT',
  'REPEATED_LINK',
  'REPEATED_PHONE',
  'GRAPH_CAMPAIGN',
  'GRAPH_FANOUT_PATTERN',
  'REVIEW_APPROVED',
]);
const OBSERVATION_FAST_PATH_SOURCES = new Set<GlobalSpammerObservationSource>([
  'FANOUT_HIGH',
  'FANOUT_REPEAT',
  'COMMERCIAL_AD',
  'COMMERCIAL_CAMPAIGN',
  'REPEATED_LINK',
  'REPEATED_PHONE',
  'SANCTION_BAN',
]);

@Injectable()
export class GlobalSpammerIntelligenceService implements OnModuleDestroy {
  private readonly logger = new Logger(GlobalSpammerIntelligenceService.name);
  private readonly defaultEnforcementMode: GlobalSpammerEnforcementMode;
  private readonly runtimeProfileCacheEnabled: boolean;
  private readonly runtimeProfileShadowEnabled: boolean;
  private readonly runtimeProfileShadowSampleRate: number;
  private readonly runtimeProfileReadModelEnabled: boolean;
  private readonly runtimeProfileAsyncWriteEnabled: boolean;
  private readonly observationDenormQueueEnabled: boolean;
  private readonly observationFastPathEnabled: boolean;
  private readonly observationFastPathSources: ReadonlySet<GlobalSpammerObservationSource>;
  private readonly runtimeProfileL1Cache = new Map<
    string,
    { snapshot: RuntimeProfileSnapshot | null; expiresAtMs: number }
  >();
  private runtimeProfileL1SweepIterator: IterableIterator<
    [string, { snapshot: RuntimeProfileSnapshot | null; expiresAtMs: number }]
  > | null = null;
  private runtimeProfileL1SweepRemaining = 0;
  private runtimeProfileL1SweepTimer: NodeJS.Timeout | null = null;
  private runtimeProfileL1Stopped = false;
  private sourceReputationCache: {
    expiresAtMs: number;
    rows: SourceReputation[];
  } | null = null;

  constructor(
    private readonly prisma: PrismaService,
    @Optional() configService?: ConfigService,
    @Optional() private readonly maxBotRegistry?: MaxBotRegistryService,
    @Optional() private readonly redisCounter?: RedisCounterService,
    @Optional()
    @InjectQueue(GLOBAL_SPAMMER_DENORM_QUEUE)
    private readonly observationDenormQueue?: Queue<GlobalSpammerDenormJob>,
    @Optional() private readonly runtimeDiagnostics?: RuntimeDiagnosticsService,
    @Optional() private readonly legacyHolds?: WebhookLegacyHoldService,
  ) {
    this.defaultEnforcementMode = this.resolveDefaultEnforcementMode(configService);
    this.runtimeProfileCacheEnabled = this.readBooleanConfig(
      configService?.get<boolean | string>('SPAMMER_PROFILE_CACHE_ENABLED'),
      false,
    );
    this.runtimeProfileShadowEnabled = this.readBooleanConfig(
      configService?.get<boolean | string>('SPAMMER_READ_MODEL_SHADOW_ENABLED'),
      false,
    );
    this.runtimeProfileShadowSampleRate = this.readSampleRateConfig(
      configService?.get<number | string>('SPAMMER_READ_MODEL_SHADOW_SAMPLE_RATE'),
      1,
    );
    this.runtimeProfileReadModelEnabled = this.readBooleanConfig(
      configService?.get<boolean | string>('SPAMMER_READ_MODEL_ENFORCEMENT_ENABLED'),
      false,
    );
    this.runtimeProfileAsyncWriteEnabled = this.readBooleanConfig(
      configService?.get<boolean | string>('SPAMMER_DENORM_ASYNC_ENABLED'),
      true,
    );
    this.observationDenormQueueEnabled = this.readBooleanConfig(
      configService?.get<boolean | string>('SPAMMER_OBSERVATION_DENORM_QUEUE_ENABLED'),
      false,
    );
    this.observationFastPathEnabled = this.readBooleanConfig(
      configService?.get<boolean | string>('SPAMMER_OBSERVATION_FAST_PATH_ENABLED'),
      false,
    );
    this.observationFastPathSources = this.readObservationFastPathSourcesConfig(
      configService?.get<string>('SPAMMER_OBSERVATION_FAST_PATH_SOURCES'),
    );
  }

  onModuleDestroy(): void {
    this.runtimeProfileL1Stopped = true;
    if (this.runtimeProfileL1SweepTimer) {
      clearTimeout(this.runtimeProfileL1SweepTimer);
      this.runtimeProfileL1SweepTimer = null;
    }
    this.runtimeProfileL1SweepIterator = null;
    this.runtimeProfileL1SweepRemaining = 0;
    this.runtimeProfileL1Cache.clear();
  }

  private scheduleRuntimeProfileL1Sweep(delayMs: number): void {
    if (
      this.runtimeProfileL1Stopped ||
      this.runtimeProfileL1SweepTimer ||
      this.runtimeProfileL1Cache.size === 0
    ) {
      return;
    }
    this.runtimeProfileL1SweepTimer = setTimeout(() => {
      this.runtimeProfileL1SweepTimer = null;
      this.sweepRuntimeProfileL1();
      this.scheduleRuntimeProfileL1Sweep(
        this.runtimeProfileL1SweepIterator ? 1 : RUNTIME_PROFILE_L1_SWEEP_INTERVAL_MS,
      );
    }, delayMs);
    this.runtimeProfileL1SweepTimer.unref();
  }

  private sweepRuntimeProfileL1(): void {
    if (!this.runtimeProfileL1SweepIterator) {
      this.runtimeProfileL1SweepIterator = this.runtimeProfileL1Cache.entries();
      this.runtimeProfileL1SweepRemaining = this.runtimeProfileL1Cache.size;
    }
    const now = Date.now();
    // FLAG: Only disposable L1 data expires here. A fixed pass budget prevents continuously
    // appended users from trapping the live Map iterator in one sweep forever.
    for (
      let inspected = 0;
      inspected < RUNTIME_PROFILE_L1_SWEEP_BATCH_SIZE && this.runtimeProfileL1SweepRemaining > 0;
      inspected++
    ) {
      const next = this.runtimeProfileL1SweepIterator.next();
      if (next.done) {
        this.runtimeProfileL1SweepRemaining = 0;
        break;
      }
      this.runtimeProfileL1SweepRemaining--;
      if (next.value[1].expiresAtMs <= now) {
        this.runtimeProfileL1Cache.delete(next.value[0]);
      }
    }
    if (this.runtimeProfileL1SweepRemaining === 0) {
      this.runtimeProfileL1SweepIterator = null;
    }
  }

  async recordCommercialObservations(params: {
    chatId: string;
    userId: string;
    messageId: string;
    text: string;
    userLabel?: string | null;
    topViolation: RuleViolation;
    commercialCampaignContext: CommercialCampaignContext | null;
  }): Promise<GlobalSpammerObservationDecision[]> {
    const { chatId, userId, messageId, text, userLabel, topViolation, commercialCampaignContext } =
      params;
    const metadata = this.asRecord(topViolation.metadata);
    const metadataCampaignContext = this.asRecord(metadata?.campaignContext);
    const repeatedLinkDistinctChatCount =
      this.readNumber(metadataCampaignContext?.repeatedLinkDistinctChatCount) ??
      commercialCampaignContext?.repeatedLinkDistinctChatCount ??
      0;
    const repeatedPhoneDistinctChatCount =
      this.readNumber(metadataCampaignContext?.repeatedPhoneDistinctChatCount) ??
      commercialCampaignContext?.repeatedPhoneDistinctChatCount ??
      0;
    const observations: Array<{
      source: GlobalSpammerObservationSource;
      score: number;
      reason: string;
      evidence: Prisma.InputJsonValue;
      ttlDays?: number;
    }> = [];

    if (topViolation.ruleCode === 'COMMERCIAL_AD') {
      const confidenceScore =
        typeof metadata?.confidenceScore === 'number'
          ? Math.max(0, Math.min(1, metadata.confidenceScore / 100))
          : topViolation.score;
      const actionBand = this.normalizeText(
        typeof metadata?.actionBand === 'string' ? metadata.actionBand : null,
      );
      const campaignContext = metadataCampaignContext ?? commercialCampaignContext;
      const source: GlobalSpammerObservationSource = campaignContext
        ? 'COMMERCIAL_CAMPAIGN'
        : 'COMMERCIAL_AD';
      const score =
        actionBand === 'DELETE_AND_ESCALATE'
          ? Math.max(confidenceScore, 0.82)
          : campaignContext
            ? Math.max(confidenceScore, 0.72)
            : Math.max(confidenceScore, 0.58);
      observations.push({
        source,
        score,
        reason: 'COMMERCIAL_AD_DETECTED',
        evidence: {
          ruleCode: topViolation.ruleCode,
          violationScore: topViolation.score,
          actionBand: actionBand || null,
          campaignContext: campaignContext ? JSON.parse(JSON.stringify(campaignContext)) : null,
          metadata: metadata ? JSON.parse(JSON.stringify(metadata)) : null,
          excerpt: maskText(text),
        } as Prisma.InputJsonValue,
      });
    }

    if (metadataCampaignContext || commercialCampaignContext) {
      if (repeatedLinkDistinctChatCount >= 2) {
        observations.push({
          source: 'REPEATED_LINK',
          score: repeatedLinkDistinctChatCount >= 3 ? 0.68 : 0.58,
          reason: 'REPEATED_LINK_CROSS_CHAT',
          evidence: {
            repeatedLinkDistinctChatCount,
            windowSec: COMMERCIAL_CAMPAIGN_WINDOW_SEC,
            excerpt: maskText(text),
          },
        });
      }
      if (repeatedPhoneDistinctChatCount >= 2) {
        observations.push({
          source: 'REPEATED_PHONE',
          score: repeatedPhoneDistinctChatCount >= 3 ? 0.7 : 0.6,
          reason: 'REPEATED_PHONE_CROSS_CHAT',
          evidence: {
            repeatedPhoneDistinctChatCount,
            windowSec: COMMERCIAL_CAMPAIGN_WINDOW_SEC,
            excerpt: maskText(text),
          },
        });
      }
    }

    const decisions: GlobalSpammerObservationDecision[] = [];
    for (const observation of observations) {
      decisions.push(
        await this.recordObservation({
          userId,
          chatId,
          messageId,
          source: observation.source,
          score: observation.score,
          reason: observation.reason,
          userLabel,
          evidence: observation.evidence,
          ttlDays: observation.ttlDays,
        }),
      );
    }
    return decisions;
  }

  async recordManualBanObservation(params: {
    chatId: string;
    targetUserId: string;
    actorUserId: string;
    source: string;
    executionMode: string;
  }): Promise<GlobalSpammerObservationDecision> {
    return this.recordObservation({
      userId: params.targetUserId,
      source: 'MANUAL_BAN',
      score: params.source === 'miniapp' ? 0.62 : 0.7,
      reason: 'MANUAL_BAN',
      chatId: params.chatId,
      evidence: {
        actorUserId: params.actorUserId,
        source: params.source,
        executionMode: params.executionMode,
      },
      ttlDays: 30,
    });
  }

  async recordDeveloperForcedGlobalBlacklist(params: {
    userId: string;
    actorUserId: string;
    chatId?: string | null;
    messageId?: string | null;
    userLabel?: string | null;
    reason?: string | null;
    ttlDays?: number | null;
  }): Promise<GlobalSpammerObservationDecision> {
    const userId = this.normalizeUserId(params.userId);
    const actorUserId = this.normalizeUserId(params.actorUserId);
    if (!userId || !actorUserId) {
      return this.emptyDecision('ignored', userId);
    }
    if (this.isKnownRuntimeBotUserId(userId)) {
      return this.emptyDecision('ignored', userId);
    }

    const reason =
      this.normalizeText(params.reason) || 'По решению разработчика бота за нарушение правил';
    const ttlDays = Math.max(1, Math.trunc(params.ttlDays ?? DEVELOPER_FORCED_REGISTRY_TTL_DAYS));

    return this.recordObservation({
      userId,
      source: 'DEVELOPER_FORCED',
      score: 1,
      reason,
      chatId: params.chatId ?? null,
      messageId: params.messageId ?? null,
      userLabel: params.userLabel ?? null,
      evidenceHash: `developer-forced:${userId}`,
      evidence: {
        actorUserId,
        sourceChatId: params.chatId ?? null,
        messageId: params.messageId ?? null,
        reason,
      },
      ttlDays,
      registryTtlDays: ttlDays,
      forceRegistry: true,
    });
  }

  async recordLocalAdminDecision(params: {
    chatId: string;
    userId: string;
    reviewerUserId: string;
    decision: LocalAdminSpammerDecision;
    reason?: string | null;
  }): Promise<{ ok: true; decision: LocalAdminSpammerDecision; userId: string }> {
    const userId = this.normalizeUserId(params.userId);
    const adminUserId = this.normalizeUserId(params.reviewerUserId);
    if (!userId || !adminUserId) {
      throw new Error('User ID and reviewer ID are required');
    }

    const decision = this.normalizeLocalAdminDecision(params.decision) ?? 'REVIEW';
    if (decision !== 'ALLOW' && this.isKnownRuntimeBotUserId(userId)) {
      throw new BadRequestException('Configured MAX bots cannot be marked as spammers.');
    }
    const reason =
      this.normalizeText(params.reason) ||
      (decision === 'BLOCK'
        ? 'LOCAL_ADMIN_BLOCK'
        : decision === 'ALLOW'
          ? 'LOCAL_ADMIN_ALLOW'
          : 'LOCAL_ADMIN_REVIEW');

    await this.prisma.adminGlobalSpammerExemption.upsert({
      where: {
        adminUserId_userId: {
          adminUserId,
          userId,
        },
      },
      create: {
        adminUserId,
        userId,
        sourceChatId: params.chatId,
        decision,
        reason,
      },
      update: {
        sourceChatId: params.chatId,
        decision,
        reason,
      },
    });
    await this.invalidateRuntimeProfileCaches(userId);

    if (decision === 'BLOCK' || decision === 'ALLOW') {
      await this.recordObservation({
        userId,
        source: decision === 'BLOCK' ? 'LOCAL_ADMIN_BLOCK' : 'LOCAL_ADMIN_ALLOW',
        score: 0.34,
        reason,
        chatId: params.chatId,
        evidence: {
          reviewerUserId: adminUserId,
          sourceChatId: params.chatId,
          localDecision: decision,
        },
        ttlDays:
          SOURCE_DEFAULT_TTL_DAYS[decision === 'BLOCK' ? 'LOCAL_ADMIN_BLOCK' : 'LOCAL_ADMIN_ALLOW'],
      });
    }

    return { ok: true, decision, userId };
  }

  async recordObservation(
    input: GlobalSpammerObservationInput,
  ): Promise<GlobalSpammerObservationDecision> {
    const userId = this.normalizeUserId(input.userId);
    if (!userId) {
      return this.emptyDecision('ignored', '');
    }
    if (await this.legacyHolds?.isGlobalUserHeld(userId))
      return this.emptyDecision('ignored', userId);
    if (await this.isAbandonedSourceObservation(input))
      return this.emptyDecision('ignored', userId);
    if (this.isKnownRuntimeBotUserId(userId)) {
      return this.emptyDecision('ignored', userId);
    }

    const ledger = await this.recordObservationLedger(userId, input);
    if (this.shouldUseObservationFastPath(input, ledger.activeSuppression)) {
      const enqueued = await this.enqueueObservationDenormJob({
        userId,
        chatId: input.chatId ?? null,
        observationId: ledger.observationId,
        source: input.source,
        reason: input.reason,
        userLabel: input.userLabel ?? null,
        observedAt: ledger.observedAt,
        fastPath: true,
      });
      if (!enqueued) {
        this.recordSpammerReadModelEvent('denorm_fast_path_fallback');
        return this.recordObservationDenormSync(ledger, { enqueueDenormJob: false });
      }
      return {
        outcome: ledger.activeSuppression ? 'suppressed' : 'observed',
        userId,
        aggregateScore: ledger.score,
        confidenceLevel: ledger.confidenceLevel,
        sourceBreakdown: {
          [input.source]: {
            score: this.roundScore(ledger.score),
            rawScore: this.roundScore(ledger.score),
            count: 1,
            latestAt: ledger.observedAt.toISOString(),
            reasons: [input.reason],
          },
        },
        evidenceHash: ledger.evidenceHash,
        suppressedUntil: ledger.activeSuppression?.suppressedUntil.toISOString() ?? null,
      };
    }

    return this.recordObservationDenormSync(ledger);
  }

  private async recordObservationLedger(
    userId: string,
    input: GlobalSpammerObservationInput,
  ): Promise<SpammerObservationLedgerResult> {
    const now = input.observedAt ?? new Date();
    const score = this.clampScore(input.score);
    const ttlDays =
      input.ttlDays ?? SOURCE_DEFAULT_TTL_DAYS[input.source] ?? DEFAULT_OBSERVATION_TTL_DAYS;
    const expiresAt = new Date(now.getTime() + Math.max(1, ttlDays) * DAY_MS);
    const evidenceHash =
      this.normalizeText(input.evidenceHash) ||
      this.buildEvidenceHash({
        userId,
        source: input.source,
        chatId: input.chatId ?? null,
        messageId: input.messageId ?? null,
        evidence: input.evidence ?? Prisma.JsonNull,
      });
    const allowActiveSuppression = input.source !== 'DEVELOPER_FORCED';
    const activeSuppression = allowActiveSuppression
      ? await this.findActiveSuppression(userId, now)
      : null;
    const confidenceLevel = this.resolveConfidenceLevel(score);
    const ledgerMetadata = this.buildObservationLedgerMetadata({
      input,
      score,
      confidenceLevel,
      ttlDays,
      observedAt: now,
      expiresAt,
      evidenceHash,
    });
    const normalizedUserLabel = this.normalizeUserFacingName(input.userLabel ?? null, userId);
    if (normalizedUserLabel) {
      ledgerMetadata.normalizedFeatures = {
        ...ledgerMetadata.normalizedFeatures,
        userLabel: normalizedUserLabel,
      };
    }

    const observationRow = await this.prisma.spammerObservation.upsert({
      where: {
        userId_source_evidenceHash: {
          userId,
          source: input.source,
          evidenceHash,
        },
      },
      create: {
        userId,
        source: input.source,
        score,
        confidenceLevel,
        reason: input.reason,
        chatId: input.chatId ?? null,
        messageId: input.messageId ?? null,
        evidenceHash,
        evidence: input.evidence ?? Prisma.JsonNull,
        normalizedFeatures: ledgerMetadata.normalizedFeatures,
        ttlDays,
        explainReason: ledgerMetadata.explainReason,
        privacyClass: ledgerMetadata.privacyClass,
        rawEvidenceExpiresAt: ledgerMetadata.rawEvidenceExpiresAt,
        observedAt: now,
        expiresAt,
        suppressedAt: activeSuppression ? now : null,
        suppressionReason: activeSuppression?.reason ?? null,
      },
      update: {
        score,
        confidenceLevel,
        reason: input.reason,
        chatId: input.chatId ?? null,
        messageId: input.messageId ?? null,
        evidence: input.evidence ?? Prisma.JsonNull,
        normalizedFeatures: ledgerMetadata.normalizedFeatures,
        ttlDays,
        explainReason: ledgerMetadata.explainReason,
        privacyClass: ledgerMetadata.privacyClass,
        rawEvidenceExpiresAt: ledgerMetadata.rawEvidenceExpiresAt,
        observedAt: now,
        expiresAt,
        suppressedAt: activeSuppression ? now : null,
        suppressionReason: activeSuppression?.reason ?? null,
      },
    });
    await this.invalidateRuntimeProfileCaches(userId);

    return {
      userId,
      input,
      score,
      ttlDays,
      observedAt: now,
      expiresAt,
      evidenceHash,
      confidenceLevel,
      activeSuppression,
      observationId: observationRow.id,
    };
  }

  private shouldUseObservationFastPath(
    input: GlobalSpammerObservationInput,
    _activeSuppression: GlobalSpammerSuppressionRow | null,
  ): boolean {
    if (!this.observationFastPathEnabled || !this.observationDenormQueueEnabled) {
      return false;
    }
    if (input.forceRegistry || input.registryTtlDays) {
      return false;
    }
    return this.observationFastPathSources.has(input.source);
  }

  private async recordObservationDenormSync(
    ledger: SpammerObservationLedgerResult,
    options: { enqueueDenormJob?: boolean } = {},
  ): Promise<GlobalSpammerObservationDecision> {
    const {
      userId,
      input,
      score,
      observedAt: now,
      evidenceHash,
      activeSuppression,
      observationId,
    } = ledger;
    if (await this.legacyHolds?.isGlobalUserHeld(userId))
      return this.emptyDecision('ignored', userId);
    if (await this.isAbandonedSourceObservation({ ...input, id: observationId }))
      return this.emptyDecision('ignored', userId);
    const finish = <TDecision extends GlobalSpammerObservationDecision>(
      decision: TDecision,
      params: {
        userId: string;
        chatId: string | null;
        observationId: string;
        source: GlobalSpammerObservationSource;
        reason: string;
        observedAt: Date;
      },
    ): Promise<TDecision> =>
      options.enqueueDenormJob === false
        ? Promise.resolve(decision)
        : this.finishObservationDecision(decision, params);
    const campaignSummaries = await this.recordCampaignClustersForObservation({
      userId,
      input,
      observationId,
      observedAt: now,
      score,
    });

    if (!this.isGraphObservationSource(input.source)) {
      await this.recordGraphSignalsForObservation({
        userId,
        input,
        observedAt: now,
        activeSuppression,
      });
    }

    const aggregate = await this.computeAggregateForUser(userId, now);
    const sourceBreakdown = aggregate.sourceBreakdown;
    await this.recordShadowScoreForObservation({
      userId,
      input,
      observationId,
      aggregate,
      campaignSummaries,
      activeSuppression: Boolean(activeSuppression),
    });

    if (activeSuppression) {
      await this.upsertCandidate({
        userId,
        status: 'SUPPRESSED',
        reason: input.reason,
        chatId: input.chatId ?? null,
        messageId: input.messageId ?? null,
        userLabel: input.userLabel ?? null,
        evidence: this.buildCandidateEvidence(input, aggregate, evidenceHash),
        aggregate,
        suppressedUntil: activeSuppression.suppressedUntil,
        reviewedByUserId: activeSuppression.adminUserId ?? null,
        reviewReason: activeSuppression.reason,
        falsePositive: true,
      });
      await this.scheduleRuntimeProfileRefresh(userId, input.chatId ?? null, 'record-observation');

      return finish(
        {
          outcome: 'suppressed',
          userId,
          aggregateScore: aggregate.score,
          confidenceLevel: aggregate.confidenceLevel,
          sourceBreakdown,
          evidenceHash,
          suppressedUntil: activeSuppression.suppressedUntil.toISOString(),
        },
        {
          userId,
          chatId: input.chatId ?? null,
          observationId,
          source: input.source,
          reason: input.reason,
          observedAt: now,
        },
      );
    }

    const thresholdAdjustment = await this.resolveRecentSuppressionThresholdAdjustment(userId, now);
    const highConfidenceThreshold = HIGH_CONFIDENCE_THRESHOLD + thresholdAdjustment;
    const mediumConfidenceThreshold = MEDIUM_CONFIDENCE_THRESHOLD + thresholdAdjustment;

    const canPromoteToRegistry = this.canPromoteToRegistry(input, aggregate);
    if (
      (input.forceRegistry || aggregate.score >= highConfidenceThreshold) &&
      canPromoteToRegistry
    ) {
      await this.promoteToRegistry({
        userId,
        sourceChatId: input.chatId ?? null,
        reason: input.reason,
        evidence: this.buildCandidateEvidence(input, aggregate, evidenceHash),
        aggregate,
        status: input.source === 'REVIEW_APPROVED' ? 'APPROVED' : 'AUTO_APPROVED',
        reviewedByUserId: null,
        reviewReason: null,
        registryTtlDays: input.registryTtlDays ?? null,
      });
      await this.scheduleRuntimeProfileRefresh(userId, input.chatId ?? null, 'record-observation');
      return finish(
        {
          outcome: 'registry',
          userId,
          aggregateScore: aggregate.score,
          confidenceLevel: aggregate.confidenceLevel,
          sourceBreakdown,
          evidenceHash,
        },
        {
          userId,
          chatId: input.chatId ?? null,
          observationId,
          source: input.source,
          reason: input.reason,
          observedAt: now,
        },
      );
    }

    if (aggregate.score >= mediumConfidenceThreshold) {
      await this.upsertCandidate({
        userId,
        status: 'PENDING',
        reason: input.reason,
        chatId: input.chatId ?? null,
        messageId: input.messageId ?? null,
        userLabel: input.userLabel ?? null,
        evidence: this.buildCandidateEvidence(input, aggregate, evidenceHash),
        aggregate,
        suppressedUntil: null,
        reviewedByUserId: null,
        reviewReason: null,
        falsePositive: false,
      });
      await this.scheduleRuntimeProfileRefresh(userId, input.chatId ?? null, 'record-observation');
      return finish(
        {
          outcome: 'candidate',
          userId,
          aggregateScore: aggregate.score,
          confidenceLevel: aggregate.confidenceLevel,
          sourceBreakdown,
          evidenceHash,
        },
        {
          userId,
          chatId: input.chatId ?? null,
          observationId,
          source: input.source,
          reason: input.reason,
          observedAt: now,
        },
      );
    }

    return finish(
      {
        outcome: 'observed',
        userId,
        aggregateScore: aggregate.score,
        confidenceLevel: aggregate.confidenceLevel,
        sourceBreakdown,
        evidenceHash,
      },
      {
        userId,
        chatId: input.chatId ?? null,
        observationId,
        source: input.source,
        reason: input.reason,
        observedAt: now,
      },
    );
  }

  async processObservationDenormJob(job: GlobalSpammerDenormJob): Promise<void> {
    const userId = this.normalizeUserId(job.userId);
    if (!userId || this.isKnownRuntimeBotUserId(userId)) {
      return;
    }
    if (await this.legacyHolds?.isGlobalUserHeld(userId)) return;
    // FLAG: Old exact observation work cannot recreate descendants after source
    // abandonment. Future observations from this participant remain independent.
    if (
      job.observationId &&
      (await this.legacyHolds?.isSourceChildHeld?.('SPAMMER_OBSERVATION', job.observationId))
    )
      return;
    const sourceForHold = this.normalizeObservationSource(job.source);
    if (sourceForHold && this.shouldProcessObservationFastDenormJob(sourceForHold)) {
      const snapshot = await this.resolveDenormObservationSnapshot({
        userId,
        observationId: job.observationId ?? null,
      });
      if (snapshot && (await this.isAbandonedSourceObservation(snapshot))) return;
    }

    const startedAtMs = Date.now();
    try {
      await this.invalidateRuntimeProfileCaches(userId);
      const now = new Date();
      const chatId = this.normalizeText(job.chatId ?? null) || null;
      const jobSource = this.normalizeObservationSource(job.source);
      if (jobSource && this.shouldProcessObservationFastDenormJob(jobSource)) {
        await this.recomputeObservationDenormForUser({
          userId,
          chatId,
          source: jobSource,
          reason: this.normalizeText(job.reason ?? null),
          userLabel: this.normalizeText(job.userLabel ?? null) || null,
          observationId: this.normalizeText(job.observationId ?? null) || null,
          fastPath: job.fastPath === true,
          now,
        });
      }
      const [registry, candidate, activeSuppression, riskContext] = await Promise.all([
        this.prisma.globalSpammer.findUnique({ where: { userId } }),
        this.prisma.globalSpammerCandidate.findUnique({ where: { userId } }),
        this.findActiveSuppression(userId, now),
        this.buildPolicyDecisionRiskContext(userId, { allowCampaignFallback: false }),
      ]);
      const decision = await this.evaluatePolicy({
        chatId,
        userId,
        trigger: 'runtime-profile:observation-denorm-job',
        deleteSpammersEnabled: true,
        enforcementMode: 'enforce',
        recordDecision: false,
        riskContext,
        skipRuntimeProfileWrite: true,
        lookupContext: {
          now,
          registry,
          candidate,
          activeSuppression,
        },
      });
      await this.writeRuntimeProfileFromDecision({
        decision,
        activeSuppression,
        registry,
        candidate,
        now,
        source: 'observation-denorm-job',
        lookupContextProvided: true,
      });
      this.recordSpammerReadModelEvent('denorm_job_processed', {
        jobAgeMs: this.resolveDenormJobAgeMs(job),
      });
      this.logSpammerIntelligenceTiming('processObservationDenormJob', {
        userId,
        chatId: job.chatId ?? null,
        source: job.source,
        observationId: job.observationId ?? null,
        totalMs: Date.now() - startedAtMs,
      });
    } catch (error: unknown) {
      this.recordSpammerReadModelEvent('denorm_job_failed', {
        jobAgeMs: this.resolveDenormJobAgeMs(job),
      });
      throw error;
    }
  }

  private async recomputeObservationDenormForUser(params: {
    userId: string;
    chatId: string | null;
    source: GlobalSpammerObservationSource;
    reason: string;
    userLabel: string | null;
    observationId: string | null;
    fastPath: boolean;
    now: Date;
  }): Promise<void> {
    const latest = await this.resolveDenormObservationSnapshot({
      userId: params.userId,
      observationId: params.observationId,
    });
    if (!latest) {
      if (params.fastPath) {
        this.recordSpammerReadModelEvent('denorm_fast_path_replay_missing');
      }
      return;
    }

    if (await this.isAbandonedSourceObservation(latest)) return;

    const source = this.normalizeObservationSource(latest.source) ?? null;
    const latestInput: GlobalSpammerObservationInput = {
      userId: params.userId,
      source: source ?? 'FANOUT_REPEAT',
      score: latest.score,
      reason: latest.reason,
      chatId: latest.chatId,
      messageId: latest.messageId,
      evidence: this.toNullableInputJsonValue(latest.evidence) ?? undefined,
      evidenceHash: latest.evidenceHash,
      observedAt: latest.observedAt,
    };
    if (params.fastPath) {
      await this.replayObservationSideEffects({
        userId: params.userId,
        input: latestInput,
        observationId: latest.id,
        observedAt: latest.observedAt,
        score: latest.score,
        activeSuppression: this.buildDenormActiveSuppressionSnapshot(latest),
      });
      this.recordSpammerReadModelEvent('denorm_fast_path_replayed');
    }
    const [aggregate, activeSuppression] = await Promise.all([
      this.computeAggregateForUser(params.userId, params.now),
      this.findActiveSuppression(params.userId, params.now),
    ]);
    const reason = params.reason || latest.reason;
    const chatId = params.chatId ?? latest.chatId ?? null;
    const userLabel = this.resolveDenormUserLabel(latest, params.userLabel, params.userId);
    const evidence = this.buildCandidateEvidence(latestInput, aggregate, latest.evidenceHash);

    if (activeSuppression) {
      await this.syncDenormCandidate({
        userId: params.userId,
        status: 'SUPPRESSED',
        reason,
        chatId,
        messageId: latest.messageId,
        userLabel,
        evidence,
        aggregate,
        suppressedUntil: activeSuppression.suppressedUntil,
        reviewedByUserId: activeSuppression.adminUserId ?? null,
        reviewReason: activeSuppression.reason,
        falsePositive: true,
        detectedAt: latest.observedAt,
      });
      return;
    }

    const thresholdAdjustment = await this.resolveRecentSuppressionThresholdAdjustment(
      params.userId,
      params.now,
    );
    const highConfidenceThreshold = HIGH_CONFIDENCE_THRESHOLD + thresholdAdjustment;
    const mediumConfidenceThreshold = MEDIUM_CONFIDENCE_THRESHOLD + thresholdAdjustment;
    const canPromoteToRegistry = source && this.canPromoteToRegistry(latestInput, aggregate);

    if (aggregate.score >= highConfidenceThreshold && canPromoteToRegistry) {
      await this.syncDenormRegistry({
        userId: params.userId,
        sourceChatId: chatId,
        reason,
        evidence,
        aggregate,
        status: 'AUTO_APPROVED',
        reviewedByUserId: null,
        reviewReason: null,
        detectedAt: latest.observedAt,
      });
      return;
    }

    if (aggregate.score >= mediumConfidenceThreshold) {
      await this.syncDenormCandidate({
        userId: params.userId,
        status: 'PENDING',
        reason,
        chatId,
        messageId: latest.messageId,
        userLabel,
        evidence,
        aggregate,
        suppressedUntil: null,
        reviewedByUserId: null,
        reviewReason: null,
        falsePositive: false,
        detectedAt: latest.observedAt,
      });
    }
  }

  private async isAbandonedSourceObservation(input: {
    id?: string | null;
    chatId?: string | null;
    messageId?: string | null;
  }): Promise<boolean> {
    if (input.id && (await this.legacyHolds?.isSourceChildHeld?.('SPAMMER_OBSERVATION', input.id)))
      return true;
    return Boolean(
      input.chatId &&
      input.messageId &&
      (await this.legacyHolds?.isSourceAbandoned?.(input.chatId, input.messageId)),
    );
  }

  private async resolveDenormObservationSnapshot(params: {
    userId: string;
    observationId: string | null;
  }): Promise<DenormObservationSnapshot | null> {
    const select = {
      id: true,
      userId: true,
      source: true,
      score: true,
      reason: true,
      chatId: true,
      messageId: true,
      evidenceHash: true,
      evidence: true,
      normalizedFeatures: true,
      observedAt: true,
      suppressedAt: true,
      suppressionReason: true,
    } satisfies Prisma.SpammerObservationSelect;
    if (params.observationId) {
      const rows = await this.prisma.spammerObservation.findMany({
        where: {
          userId: params.userId,
          id: params.observationId,
        },
        select,
        take: 1,
      });
      const row = rows[0] ?? null;
      if (row) {
        return row;
      }
    }

    const rows = await this.prisma.spammerObservation.findMany({
      where: {
        userId: params.userId,
      },
      select,
      orderBy: {
        observedAt: 'desc',
      },
      take: 1,
    });
    return rows[0] ?? null;
  }

  private async replayObservationSideEffects(params: {
    userId: string;
    input: GlobalSpammerObservationInput;
    observationId: string;
    observedAt: Date;
    score: number;
    activeSuppression: { reason: string } | null;
  }): Promise<void> {
    const campaignSummaries = await this.recordCampaignClustersForObservation({
      userId: params.userId,
      input: params.input,
      observationId: params.observationId,
      observedAt: params.observedAt,
      score: params.score,
      incrementExisting: false,
    });

    if (!this.isGraphObservationSource(params.input.source)) {
      await this.recordGraphSignalsForObservation({
        userId: params.userId,
        input: params.input,
        observedAt: params.observedAt,
        activeSuppression: params.activeSuppression,
      });
    }

    const aggregate = await this.computeAggregateForUser(params.userId, params.observedAt);
    await this.recordShadowScoreForObservation({
      userId: params.userId,
      input: params.input,
      observationId: params.observationId,
      aggregate,
      campaignSummaries,
      activeSuppression: Boolean(params.activeSuppression),
      skipExistingObservation: true,
    });
  }

  private buildDenormActiveSuppressionSnapshot(
    observation: DenormObservationSnapshot,
  ): { reason: string } | null {
    return observation.suppressedAt
      ? { reason: observation.suppressionReason || 'ACTIVE_SUPPRESSION' }
      : null;
  }

  private resolveDenormUserLabel(
    observation: DenormObservationSnapshot,
    jobUserLabel: string | null,
    userId: string,
  ): string | null {
    return (
      this.normalizeUserFacingName(jobUserLabel, userId) ||
      this.normalizeUserFacingName(
        this.readString(this.asRecord(observation.normalizedFeatures)?.userLabel),
        userId,
      ) ||
      null
    );
  }

  private shouldProcessObservationFastDenormJob(source: GlobalSpammerObservationSource): boolean {
    return this.observationFastPathEnabled && this.observationFastPathSources.has(source);
  }

  async recordSuppression(input: GlobalSpammerSuppressionInput): Promise<{ ok: true }> {
    const userId = this.normalizeUserId(input.userId);
    if (!userId) {
      return { ok: true };
    }

    const now = new Date();
    const suppressedUntil = new Date(
      now.getTime() + Math.max(1, input.ttlDays ?? DEFAULT_SUPPRESSION_TTL_DAYS) * DAY_MS,
    );
    await this.prisma.$transaction([
      this.prisma.globalSpammerSuppression.create({
        data: {
          userId,
          source: input.source,
          reason: input.reason,
          adminUserId: this.normalizeUserId(input.adminUserId ?? '') || null,
          sourceChatId: input.sourceChatId ?? null,
          suppressedUntil,
          evidence: input.evidence ?? Prisma.JsonNull,
        },
      }),
      this.prisma.globalSpammer.deleteMany({
        where: {
          userId,
        },
      }),
      this.prisma.globalSpammerCandidate.upsert({
        where: {
          userId,
        },
        create: {
          userId,
          status: 'SUPPRESSED',
          lastReason: input.reason,
          lastChatId: input.sourceChatId ?? null,
          lastEvidence: input.evidence ?? Prisma.JsonNull,
          confidenceScore: 0,
          sourceBreakdown: {},
          suppressedUntil,
          reviewedAt: now,
          reviewedByUserId: this.normalizeUserId(input.adminUserId ?? '') || null,
          reviewReason: input.reason,
          falsePositive: input.falsePositive ?? true,
        },
        update: {
          status: 'SUPPRESSED',
          lastReason: input.reason,
          lastChatId: input.sourceChatId ?? null,
          lastEvidence: input.evidence ?? Prisma.JsonNull,
          confidenceScore: 0,
          suppressedUntil,
          reviewedAt: now,
          reviewedByUserId: this.normalizeUserId(input.adminUserId ?? '') || null,
          reviewReason: input.reason,
          falsePositive: input.falsePositive ?? true,
        },
      }),
      this.prisma.spammerObservation.updateMany({
        where: {
          userId,
          expiresAt: {
            gt: now,
          },
          suppressedAt: null,
        },
        data: {
          suppressedAt: now,
          suppressionReason: input.reason,
        },
      }),
    ]);
    this.invalidateSourceReputationCache();
    await this.invalidateRuntimeProfileCaches(userId);
    await this.scheduleRuntimeProfileRefresh(
      userId,
      input.sourceChatId ?? null,
      'record-suppression',
    );

    return { ok: true };
  }

  async reviewCandidate(params: {
    chatId: string;
    userId: string;
    reviewerUserId: string;
    action: CandidateReviewAction;
    reason?: string | null;
  }): Promise<{ ok: true; status: GlobalSpammerCandidateStatus; userId: string }> {
    const userId = this.normalizeUserId(params.userId);
    if (!userId) {
      throw new Error('User ID is required');
    }

    const reason =
      this.normalizeText(params.reason) ||
      (params.action === 'APPROVE' ? 'REVIEW_APPROVED' : 'REVIEW_SUPPRESSED');
    const candidateBefore = await this.prisma.globalSpammerCandidate.findUnique({
      where: {
        userId,
      },
    });
    const campaignBreakdown = await this.buildCampaignBreakdownForUser(userId);
    await this.recordReviewFeedback({
      userId,
      chatId: params.chatId,
      reviewerUserId: params.reviewerUserId,
      action: params.action,
      reason,
      candidateBefore,
      campaignBreakdown,
    });

    if (params.action === 'SUPPRESS') {
      await this.recordLocalAdminDecision({
        chatId: params.chatId,
        userId,
        reviewerUserId: params.reviewerUserId,
        decision: 'ALLOW',
        reason,
      });
      const candidateUpdate = await this.prisma.globalSpammerCandidate.updateMany({
        where: { userId },
        data: {
          status: 'SUPPRESSED',
          reviewedAt: new Date(),
          reviewedByUserId: params.reviewerUserId,
          reviewReason: reason,
          falsePositive: true,
        },
      });
      this.logMissingCandidateReviewUpdate(candidateUpdate.count, userId, params.action);
      await this.markShadowScoresReviewed({
        userId,
        action: params.action,
        reviewerUserId: params.reviewerUserId,
      });
      await this.invalidateRuntimeProfileCaches(userId);
      await this.scheduleRuntimeProfileRefresh(userId, params.chatId, 'review-candidate');
      return { ok: true, status: 'SUPPRESSED', userId };
    }

    await this.recordLocalAdminDecision({
      chatId: params.chatId,
      reason,
      userId,
      reviewerUserId: params.reviewerUserId,
      decision: 'BLOCK',
    });
    const candidateUpdate = await this.prisma.globalSpammerCandidate.updateMany({
      where: { userId },
      data: {
        status: 'APPROVED',
        reviewedAt: new Date(),
        reviewedByUserId: params.reviewerUserId,
        reviewReason: reason,
        falsePositive: false,
      },
    });
    this.logMissingCandidateReviewUpdate(candidateUpdate.count, userId, params.action);
    await this.markShadowScoresReviewed({
      userId,
      action: params.action,
      reviewerUserId: params.reviewerUserId,
    });
    await this.invalidateRuntimeProfileCaches(userId);
    await this.scheduleRuntimeProfileRefresh(userId, params.chatId, 'review-candidate');

    return { ok: true, status: 'APPROVED', userId };
  }

  private logMissingCandidateReviewUpdate(
    updatedCount: number,
    userId: string,
    action: CandidateReviewAction,
  ) {
    if (updatedCount > 0) {
      return;
    }

    this.logger.warn(
      { userId, action },
      'Global spammer candidate disappeared before review status update',
    );
  }

  async listReviewQueue(params: {
    chatId: string;
    status?: GlobalSpammerCandidateStatus | 'ALL';
    limit?: number;
    includeObservations?: boolean;
    includeLocalProfiles?: boolean;
  }) {
    const startedAtMs = Date.now();
    const timings: Record<string, number> = {};
    const limit = Math.max(1, Math.min(params.limit ?? 50, 100));
    const status = params.status && params.status !== 'ALL' ? params.status : undefined;
    const includeObservations = params.includeObservations ?? true;
    const candidateIds = await this.timeSpammerStage(timings, 'candidateIdQueryMs', () =>
      this.listReviewQueueCandidateIds({
        chatId: params.chatId,
        status,
        limit,
      }),
    );
    const loadedCandidates = await this.timeSpammerStage(timings, 'candidateQueryMs', () =>
      this.loadReviewQueueCandidatesByIds(candidateIds),
    );
    const candidatesByUserId = new Map(
      loadedCandidates.map((candidate) => [candidate.userId, candidate]),
    );
    const candidates = candidateIds
      .map((userId) => candidatesByUserId.get(userId))
      .filter((candidate): candidate is NonNullable<typeof candidate> => Boolean(candidate));
    const localProfilesByUserId =
      params.includeLocalProfiles === false
        ? new Map<string, GlobalSpammerLocalProfile>()
        : await this.timeSpammerStage(timings, 'localProfileQueryMs', () =>
            this.resolveLocalReviewProfiles({
              chatId: params.chatId,
              userIds: candidateIds,
              candidates,
            }),
          );
    const userIds = candidates.map((candidate) => candidate.userId);
    const observations =
      !includeObservations || userIds.length === 0
        ? []
        : await this.timeSpammerStage(timings, 'observationsQueryMs', () =>
            this.listReviewQueueObservations(userIds, 6),
          );
    const observationsByUserId = new Map<string, typeof observations>();
    for (const observation of observations) {
      const rows = observationsByUserId.get(observation.userId) ?? [];
      rows.push(observation);
      observationsByUserId.set(observation.userId, rows);
    }

    const result = {
      items: candidates.map((candidate) => ({
        userId: candidate.userId,
        displayName: localProfilesByUserId.get(candidate.userId)?.displayName ?? null,
        status: candidate.status,
        confidenceScore: this.clampScore(candidate.confidenceScore),
        sourceBreakdown: candidate.sourceBreakdown,
        lastReason: candidate.lastReason,
        lastChatId: candidate.lastChatId,
        lastEvidence: candidate.lastEvidence,
        lastUserLabel: candidate.lastUserLabel,
        suppressedUntil: candidate.suppressedUntil?.toISOString() ?? null,
        reviewedAt: candidate.reviewedAt?.toISOString() ?? null,
        reviewedByUserId: candidate.reviewedByUserId,
        reviewReason: candidate.reviewReason,
        falsePositive: candidate.falsePositive,
        chats: candidate.chats.map((chat) => ({
          chatId: chat.chatId,
          detectionsCount: chat.detectionsCount,
          lastMessageId: chat.lastMessageId,
          lastExcerpt: chat.lastExcerpt,
          lastUserLabel: chat.lastUserLabel,
          lastDetectedAt: chat.lastDetectedAt.toISOString(),
        })),
        observations: (observationsByUserId.get(candidate.userId) ?? []).slice(0, 6).map((row) => ({
          id: row.id,
          source: row.source,
          score: this.clampScore(row.score),
          confidenceLevel: this.normalizeConfidenceLevel(row.confidenceLevel, row.score),
          reason: row.reason,
          chatId: row.chatId,
          messageId: row.messageId,
          evidenceHash: row.evidenceHash,
          evidence: row.evidence,
          observedAt: row.observedAt.toISOString(),
          expiresAt: row.expiresAt.toISOString(),
          suppressedAt: row.suppressedAt?.toISOString() ?? null,
          suppressionReason: row.suppressionReason,
        })),
      })),
      limit,
    };
    this.logSpammerIntelligenceTiming('listReviewQueue', {
      chatId: params.chatId,
      status: status ?? 'ALL',
      limit,
      includeObservations,
      includeLocalProfiles: params.includeLocalProfiles !== false,
      itemCount: result.items.length,
      candidateCount: candidateIds.length,
      observationCount: observations.length,
      ...timings,
      totalMs: Date.now() - startedAtMs,
    });
    return result;
  }

  async getReviewMetrics(
    params: { chatId?: string | null; mode?: GlobalSpammerReviewMetricsMode } = {},
  ) {
    const startedAtMs = Date.now();
    const timings: Record<string, number> = {};
    const now = new Date();
    const since = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const mode = params.mode ?? 'summary';
    const includeHeavy = mode === 'full';
    const emptyRegistryMetrics: ReviewRegistryMetrics = {
      activeRegistry: 0,
      expiredRegistry: 0,
      archivedExpired: 0,
      shadowWouldEnforceCount: 0,
    };

    const [candidateMetrics, observationMetrics, registryMetrics, sourceReputation, topCampaigns] =
      await Promise.all([
        this.timeSpammerStage(timings, 'candidateMetricsMs', () =>
          this.getReviewCandidateMetrics({ chatId: params.chatId ?? null, since }),
        ),
        this.timeSpammerStage(timings, 'observationMetricsMs', () =>
          this.getReviewObservationMetrics({ chatId: params.chatId ?? null, since }),
        ),
        includeHeavy
          ? this.timeSpammerStage(timings, 'registryMetricsMs', () =>
              this.getReviewRegistryMetrics({
                now,
                since,
                chatId: params.chatId ?? null,
              }),
            )
          : Promise.resolve(emptyRegistryMetrics),
        includeHeavy
          ? this.timeSpammerStage(timings, 'sourceReputationMs', () =>
              this.getSourceReputation(now),
            )
          : Promise.resolve([] as SourceReputation[]),
        includeHeavy
          ? this.timeSpammerStage(timings, 'topCampaignsMs', () =>
              this.listTopCampaigns({ since, chatId: params.chatId ?? null, limit: 5 }),
            )
          : Promise.resolve([]),
      ]);
    const pending = candidateMetrics.pending;
    const approved = candidateMetrics.approved;
    const suppressed = candidateMetrics.suppressed;
    const reviewed = candidateMetrics.reviewed;
    const falsePositiveCount = candidateMetrics.falsePositiveCount;
    const newCandidates24h = candidateMetrics.newCandidates24h;
    const autoApproved24h = candidateMetrics.autoApproved24h;
    const suppressed24h = candidateMetrics.suppressed24h;
    const recentObservations = observationMetrics.map((row) => ({
      source: row.source,
      count: row.observedCount,
    }));
    const suppressedObservations = observationMetrics
      .filter((row) => row.suppressedCount > 0)
      .map((row) => ({
        source: row.source,
        count: row.suppressedCount,
      }));

    const sourceAlerts = this.buildSourceAlerts({
      recentObservations,
      suppressedObservations,
    });

    const result = {
      pending,
      approved,
      suppressed,
      reviewed,
      activeRegistry: registryMetrics.activeRegistry,
      expiredRegistry: registryMetrics.expiredRegistry,
      archivedExpired: registryMetrics.archivedExpired,
      newCandidates24h,
      autoApproved24h,
      suppressed24h,
      shadowWouldEnforceCount: registryMetrics.shadowWouldEnforceCount,
      topCampaigns,
      enforcementMode: this.defaultEnforcementMode,
      falsePositiveCount,
      falsePositiveRate: reviewed > 0 ? this.roundScore(falsePositiveCount / reviewed) : 0,
      recentObservations,
      suppressedObservations,
      sourceAlerts,
      sourceReputation,
    };
    this.logSpammerIntelligenceTiming('getReviewMetrics', {
      chatId: params.chatId ?? null,
      mode,
      ...timings,
      totalMs: Date.now() - startedAtMs,
    });
    return result;
  }

  async archiveExpiredRegistryEntries(
    params: {
      limit?: number;
      dryRun?: boolean;
      now?: Date;
      countRemainingExpired?: boolean;
    } = {},
  ): Promise<GlobalSpammerArchiveExpiredResult> {
    const now = params.now ?? new Date();
    const limit = Math.max(1, Math.min(params.limit ?? 1000, 5000));
    const expiredWhere = this.buildExpiredRegistryWhere(now);
    const expiredRows = await this.prisma.globalSpammer.findMany({
      where: expiredWhere,
      orderBy: [{ expiresAt: 'asc' }, { lastDetectedAt: 'asc' }],
      take: limit,
    });

    if (params.dryRun || expiredRows.length === 0) {
      const remainingExpired =
        params.countRemainingExpired === false
          ? null
          : await this.prisma.globalSpammer.count({ where: expiredWhere });
      return {
        ok: true,
        dryRun: Boolean(params.dryRun),
        cutoff: now.toISOString(),
        scanned: expiredRows.length,
        archived: 0,
        deleted: 0,
        remainingExpired,
      };
    }

    const userIds = expiredRows.map((row) => row.userId);
    const [archiveResult, deleteResult] = await this.prisma.$transaction([
      this.prisma.globalSpammerArchive.createMany({
        data: expiredRows.map((row) => ({
          id: randomUUID(),
          userId: row.userId,
          firstDetectedAt: row.firstDetectedAt,
          lastDetectedAt: row.lastDetectedAt,
          detectionsCount: row.detectionsCount,
          lastReason: row.lastReason,
          lastChatId: row.lastChatId,
          lastEvidence: row.lastEvidence ?? Prisma.JsonNull,
          confidenceScore: row.confidenceScore,
          confirmedAt: row.confirmedAt,
          expiredAt: row.expiresAt,
          sourceBreakdown: row.sourceBreakdown ?? {},
          archiveReason: 'EXPIRED',
        })),
        skipDuplicates: true,
      }),
      this.prisma.globalSpammer.deleteMany({
        where: {
          userId: {
            in: userIds,
          },
          ...expiredWhere,
        },
      }),
    ]);
    const remainingExpired =
      params.countRemainingExpired === false
        ? null
        : await this.prisma.globalSpammer.count({ where: expiredWhere });

    return {
      ok: true,
      dryRun: false,
      cutoff: now.toISOString(),
      scanned: expiredRows.length,
      archived: archiveResult.count,
      deleted: deleteResult.count,
      remainingExpired,
    };
  }

  async pruneExpiredRawEvidence(
    params: { limit?: number; now?: Date } = {},
  ): Promise<GlobalSpammerPrivacyPruneResult> {
    const now = params.now ?? new Date();
    const limit = Math.max(1, Math.min(params.limit ?? 1000, 5000));
    const rows = await this.prisma.spammerObservation.findMany({
      where: {
        rawEvidenceExpiresAt: {
          lte: now,
        },
        privacyClass: {
          not: 'MINIMIZED',
        },
      },
      orderBy: [{ rawEvidenceExpiresAt: 'asc' }, { observedAt: 'asc' }],
      take: limit,
    });

    if (rows.length === 0) {
      return {
        ok: true,
        cutoff: now.toISOString(),
        scanned: 0,
        pruned: 0,
      };
    }

    let pruned = 0;
    const failedIds: string[] = [];
    for (let index = 0; index < rows.length; index += RAW_EVIDENCE_PRUNE_TRANSACTION_CHUNK_SIZE) {
      const chunk = rows.slice(index, index + RAW_EVIDENCE_PRUNE_TRANSACTION_CHUNK_SIZE);
      const updates = chunk.map((row) => this.buildRawEvidencePruneUpdate(row, now));
      try {
        const result = await this.prisma.$transaction(updates);
        pruned += result.length;
        continue;
      } catch (error: unknown) {
        this.logger.warn(
          {
            scanned: chunk.length,
            error: error instanceof Error ? error.message : String(error),
          },
          'Batch global spammer raw evidence prune failed; retrying rows individually',
        );
      }
      for (const row of chunk) {
        try {
          await this.buildRawEvidencePruneUpdate(row, now);
          pruned += 1;
        } catch (rowError: unknown) {
          failedIds.push(row.id);
          this.logger.warn(
            {
              observationId: row.id,
              error: rowError instanceof Error ? rowError.message : String(rowError),
            },
            'Skipped global spammer raw evidence prune row',
          );
        }
      }
    }

    return {
      ok: true,
      cutoff: now.toISOString(),
      scanned: rows.length,
      pruned,
      ...(failedIds.length > 0
        ? {
            failed: failedIds.length,
            failedIds: failedIds.slice(0, 20),
          }
        : {}),
    };
  }

  private buildRawEvidencePruneUpdate(
    row: {
      id: string;
      evidence: Prisma.JsonValue | null;
      normalizedFeatures: Prisma.JsonValue | null;
    },
    now: Date,
  ) {
    return this.prisma.spammerObservation.update({
      where: {
        id: row.id,
      },
      data: {
        evidence: this.buildMinimizedEvidence(row.evidence, row.normalizedFeatures, now),
        privacyClass: 'MINIMIZED',
        rawEvidenceExpiresAt: null,
      },
    });
  }

  private buildMinimizedEvidence(
    evidence: Prisma.JsonValue | null,
    normalizedFeatures: Prisma.JsonValue | null,
    now: Date,
  ): Prisma.InputJsonObject {
    const evidenceRecord = this.asRecord(evidence);
    const featureRecord = this.asRecord(normalizedFeatures);
    const rawText =
      this.readString(evidenceRecord?.excerpt) ||
      this.readString(evidenceRecord?.text) ||
      this.readString(evidenceRecord?.messageText) ||
      this.readString(this.asRecord(evidenceRecord?.evidence)?.excerpt) ||
      '';

    const fanout = this.asRecord(featureRecord?.fanout);

    return {
      minimizedAt: now.toISOString(),
      rawEvidencePruned: true,
      excerpt: rawText ? maskText(rawText) : null,
      evidenceHash: this.readString(featureRecord?.evidenceHash),
      domains: this.asJsonArray(featureRecord?.domains).slice(0, 10),
      urls: this.asJsonArray(featureRecord?.urls).slice(0, 10),
      phoneHashes: this.asJsonArray(featureRecord?.phoneHashes).slice(0, 10),
      textSignature: this.readString(featureRecord?.textSignature),
      campaignHash: this.readString(featureRecord?.campaignHash),
      mediaSignatures: this.asJsonArray(featureRecord?.mediaSignatures).slice(0, 10),
      fanout: fanout ? this.toInputJsonObject(fanout) : {},
    };
  }

  buildSourceAlerts(params: {
    recentObservations: Array<{ source: string; count: number }>;
    suppressedObservations: Array<{ source: string; count: number }>;
  }): Array<{ source: string; level: 'warning' | 'critical'; reason: string }> {
    const totalRecent = params.recentObservations.reduce((sum, row) => sum + row.count, 0);
    const suppressedBySource = new Map(
      params.suppressedObservations.map((row) => [row.source, row.count]),
    );
    const alerts: Array<{ source: string; level: 'warning' | 'critical'; reason: string }> = [];

    for (const row of params.recentObservations) {
      const share = totalRecent > 0 ? row.count / totalRecent : 0;
      const suppressed = suppressedBySource.get(row.source) ?? 0;
      const suppressedRate = row.count > 0 ? suppressed / row.count : 0;
      if (row.count >= 50 && share >= 0.75) {
        alerts.push({
          source: row.source,
          level: share >= 0.9 ? 'critical' : 'warning',
          reason: `source dominates recent observations (${Math.round(share * 100)}%)`,
        });
      } else if (row.count >= 10 && suppressedRate >= 0.35) {
        alerts.push({
          source: row.source,
          level: suppressedRate >= 0.6 ? 'critical' : 'warning',
          reason: `source has high suppression rate (${Math.round(suppressedRate * 100)}%)`,
        });
      }
    }

    return alerts;
  }

  async evaluatePolicy(params: {
    chatId?: string | null;
    userId: string;
    messageId?: string | null;
    trigger: string;
    deleteSpammersEnabled: boolean;
    adminExempt?: boolean;
    enforcementMode?: GlobalSpammerEnforcementMode;
    recordDecision?: boolean;
    enforced?: boolean;
    riskContext?: PolicyDecisionRiskContext | null;
    riskContextMode?: PolicyDecisionRiskContextMode;
    lookupContext?: PolicyDecisionLookupContext;
    skipRuntimeProfileWrite?: boolean;
  }): Promise<GlobalSpammerPolicyDecision> {
    const userId = this.normalizeUserId(params.userId);
    const chatId = this.normalizeText(params.chatId ?? '') || null;
    const now = params.lookupContext?.now ?? new Date();
    const enforcementMode = params.enforcementMode ?? this.defaultEnforcementMode;
    const adminExempt = Boolean(params.adminExempt);

    // FLAG: Unverified historical reputation remains evidence, never new enforcement
    // authority in another chat. Check SQL before every cached/read-model policy path.
    if (userId && (await this.legacyHolds?.isGlobalUserHeld(userId))) {
      return this.buildPolicyDecision({
        userId,
        chatId,
        trigger: params.trigger,
        registryStatus: 'NONE',
        action: 'NONE',
        enforcementMode,
        deleteSpammersEnabled: params.deleteSpammersEnabled,
        adminExempt,
        confidenceScore: null,
        reason: 'LEGACY_USER_EFFECT_HELD',
        expiresAt: null,
        sourceBreakdown: null,
        enforced: false,
      });
    }

    if (!userId) {
      return this.buildPolicyDecision({
        userId,
        chatId,
        trigger: params.trigger,
        registryStatus: 'NONE',
        action: 'NONE',
        enforcementMode,
        deleteSpammersEnabled: params.deleteSpammersEnabled,
        adminExempt,
        confidenceScore: null,
        reason: 'USER_ID_REQUIRED',
        expiresAt: null,
        sourceBreakdown: null,
        enforced: false,
      });
    }

    if (this.isKnownRuntimeBotUserId(userId)) {
      return this.buildPolicyDecision({
        userId,
        chatId,
        trigger: params.trigger,
        registryStatus: 'NONE',
        action: 'NONE',
        enforcementMode,
        deleteSpammersEnabled: params.deleteSpammersEnabled,
        adminExempt,
        confidenceScore: null,
        reason: 'KNOWN_RUNTIME_BOT',
        expiresAt: null,
        sourceBreakdown: null,
        enforced: false,
      });
    }

    const shouldCompareRuntimeProfile =
      this.runtimeProfileShadowEnabled &&
      !this.runtimeProfileReadModelEnabled &&
      this.shouldSampleRuntimeProfileShadow(userId) &&
      params.lookupContext === undefined;
    const runtimeProfileShadowDecisionPromise = shouldCompareRuntimeProfile
      ? this.buildPolicyDecisionFromRuntimeProfile({
          chatId,
          userId,
          trigger: params.trigger,
          deleteSpammersEnabled: params.deleteSpammersEnabled,
          adminExempt,
          enforcementMode,
          recordDecision: false,
          messageId: null,
          enforced: params.enforced,
          now,
        })
      : null;

    const runtimeProfileDecision = await this.evaluatePolicyFromRuntimeProfile({
      chatId,
      userId,
      trigger: params.trigger,
      deleteSpammersEnabled: params.deleteSpammersEnabled,
      adminExempt,
      enforcementMode,
      recordDecision: Boolean(params.recordDecision),
      messageId: params.messageId ?? null,
      enforced: params.enforced,
      now,
      lookupContextProvided: params.lookupContext !== undefined,
    });
    if (runtimeProfileDecision) {
      return runtimeProfileDecision;
    }

    const activeSuppression =
      params.lookupContext?.activeSuppression !== undefined
        ? params.lookupContext.activeSuppression
        : await this.findActiveSuppression(userId, now);
    let decision: GlobalSpammerPolicyDecision;
    let candidate: GlobalSpammerCandidateRow | null = null;
    const registry =
      params.lookupContext?.registry !== undefined
        ? params.lookupContext.registry
        : await this.prisma.globalSpammer.findUnique({
            where: {
              userId,
            },
          });
    const developerForcedRegistryActive =
      Boolean(registry?.expiresAt && registry.expiresAt > now) &&
      this.hasDeveloperForcedSource(registry?.sourceBreakdown);

    if (developerForcedRegistryActive && registry) {
      const action = enforcementMode === 'shadow' ? 'SHADOW_DELETE_AND_KICK' : 'DELETE_AND_KICK';
      decision = this.buildPolicyDecision({
        userId,
        chatId,
        trigger: params.trigger,
        registryStatus: 'ACTIVE_CONFIRMED',
        action,
        enforcementMode,
        deleteSpammersEnabled: params.deleteSpammersEnabled,
        adminExempt,
        confidenceScore: registry.confidenceScore,
        reason: registry.lastReason,
        expiresAt: registry.expiresAt?.toISOString() ?? null,
        sourceBreakdown: registry.sourceBreakdown,
        enforced: Boolean(
          (params.enforced ?? params.recordDecision) && action === 'DELETE_AND_KICK',
        ),
      });
    } else if (adminExempt) {
      decision = this.buildPolicyDecision({
        userId,
        chatId,
        trigger: params.trigger,
        registryStatus: 'ADMIN_EXEMPT',
        action: 'NONE',
        enforcementMode,
        deleteSpammersEnabled: params.deleteSpammersEnabled,
        adminExempt,
        confidenceScore: null,
        reason: 'ADMIN_EXEMPT',
        expiresAt: null,
        sourceBreakdown: null,
        enforced: false,
      });
    } else if (activeSuppression) {
      decision = this.buildPolicyDecision({
        userId,
        chatId,
        trigger: params.trigger,
        registryStatus: 'SUPPRESSED',
        action: 'NONE',
        enforcementMode,
        deleteSpammersEnabled: params.deleteSpammersEnabled,
        adminExempt,
        confidenceScore: null,
        reason: activeSuppression.reason,
        expiresAt: activeSuppression.suppressedUntil.toISOString(),
        sourceBreakdown: null,
        enforced: false,
      });
    } else {
      if (registry?.expiresAt && registry.expiresAt > now) {
        const action = !params.deleteSpammersEnabled
          ? 'NONE'
          : enforcementMode === 'shadow'
            ? 'SHADOW_DELETE_AND_KICK'
            : 'DELETE_AND_KICK';
        decision = this.buildPolicyDecision({
          userId,
          chatId,
          trigger: params.trigger,
          registryStatus: 'ACTIVE_CONFIRMED',
          action,
          enforcementMode,
          deleteSpammersEnabled: params.deleteSpammersEnabled,
          adminExempt,
          confidenceScore: registry.confidenceScore,
          reason: registry.lastReason,
          expiresAt: registry.expiresAt.toISOString(),
          sourceBreakdown: registry.sourceBreakdown,
          enforced: Boolean(
            (params.enforced ?? params.recordDecision) && action === 'DELETE_AND_KICK',
          ),
        });
      } else if (registry) {
        decision = this.buildPolicyDecision({
          userId,
          chatId,
          trigger: params.trigger,
          registryStatus: 'EXPIRED',
          action: 'NONE',
          enforcementMode,
          deleteSpammersEnabled: params.deleteSpammersEnabled,
          adminExempt,
          confidenceScore: registry.confidenceScore,
          reason: registry.lastReason,
          expiresAt: registry.expiresAt?.toISOString() ?? null,
          sourceBreakdown: registry.sourceBreakdown,
          enforced: false,
        });
      } else {
        candidate =
          params.lookupContext?.candidate !== undefined
            ? params.lookupContext.candidate
            : await this.prisma.globalSpammerCandidate.findUnique({
                where: {
                  userId,
                },
              });
        decision = this.buildPolicyDecision({
          userId,
          chatId,
          trigger: params.trigger,
          registryStatus:
            candidate?.status === 'PENDING' &&
            candidate.confidenceScore >= MEDIUM_CONFIDENCE_THRESHOLD
              ? 'MEDIUM_REVIEW'
              : 'NONE',
          action: 'NONE',
          enforcementMode,
          deleteSpammersEnabled: params.deleteSpammersEnabled,
          adminExempt,
          confidenceScore: candidate?.confidenceScore ?? null,
          reason: candidate?.lastReason ?? 'NO_ACTIVE_REGISTRY_ENTRY',
          expiresAt: candidate?.suppressedUntil?.toISOString() ?? null,
          sourceBreakdown: candidate?.sourceBreakdown ?? null,
          enforced: false,
        });
      }
    }

    const riskContext =
      params.riskContext ??
      (userId && params.recordDecision && params.riskContextMode === 'full'
        ? await this.buildPolicyDecisionRiskContext(userId)
        : null);
    if (riskContext) {
      decision = this.attachPolicyRiskContext(decision, riskContext);
    }

    if (params.recordDecision) {
      await this.recordPolicyDecision({
        decision,
        messageId: params.messageId ?? null,
      });
    }
    if (!params.skipRuntimeProfileWrite) {
      await this.scheduleRuntimeProfileWriteFromDecision({
        decision,
        activeSuppression,
        registry,
        candidate,
        now,
        source: 'evaluate-policy-fallback',
        lookupContextProvided: params.lookupContext !== undefined,
      });
    }
    if (shouldCompareRuntimeProfile) {
      this.scheduleRuntimeProfileShadowComparison({
        runtimeDecisionPromise: runtimeProfileShadowDecisionPromise,
        fallbackDecision: decision,
        userId,
        chatId,
        trigger: params.trigger,
      });
    }
    return decision;
  }

  async getUserDiagnostics(params: {
    chatId?: string | null;
    userId: string;
    deleteSpammersEnabled?: boolean;
    adminExempt?: boolean;
    enforcementMode?: GlobalSpammerEnforcementMode;
    options?: GlobalSpammerUserDiagnosticsOptions;
  }): Promise<GlobalSpammerUserDiagnostics> {
    const startedAtMs = Date.now();
    const timings: Record<string, number> = {};
    const userId = this.normalizeUserId(params.userId);
    if (!userId) {
      throw new Error('User ID is required');
    }
    const chatId = this.normalizeText(params.chatId ?? '') || null;
    const now = new Date();
    const options = {
      includeObservations: params.options?.includeObservations ?? true,
      includeGraphSignals: params.options?.includeGraphSignals ?? true,
      includeReputation: params.options?.includeReputation ?? true,
      includeCampaigns: params.options?.includeCampaigns ?? true,
      includeShadow: params.options?.includeShadow ?? true,
    };
    const [
      resolvedDeleteSpammersEnabled,
      localAdminDecision,
      registry,
      candidate,
      activeSuppression,
      observations,
      graphSignals,
      reputation,
      campaigns,
      latestShadowScore,
    ] = await Promise.all([
      params.deleteSpammersEnabled ??
        this.timeSpammerStage(timings, 'deleteSpammersSettingMs', () =>
          this.resolveDeleteSpammersEnabled(chatId),
        ),
      this.timeSpammerStage(timings, 'localAdminDecisionMs', () =>
        this.resolveLocalAdminDecision(userId, chatId),
      ),
      this.timeSpammerStage(timings, 'registryQueryMs', () =>
        this.prisma.globalSpammer.findUnique({ where: { userId } }),
      ),
      this.timeSpammerStage(timings, 'candidateQueryMs', () =>
        this.prisma.globalSpammerCandidate.findUnique({ where: { userId } }),
      ),
      this.timeSpammerStage(timings, 'suppressionQueryMs', () =>
        this.findActiveSuppression(userId, now),
      ),
      options.includeObservations
        ? this.timeSpammerStage(timings, 'observationsQueryMs', () =>
            this.prisma.spammerObservation.findMany({
              where: { userId },
              orderBy: { observedAt: 'desc' },
              take: 20,
              select: {
                id: true,
                source: true,
                score: true,
                confidenceLevel: true,
                reason: true,
                chatId: true,
                observedAt: true,
                expiresAt: true,
                suppressedAt: true,
              },
            }),
          )
        : Promise.resolve([]),
      options.includeGraphSignals
        ? this.timeSpammerStage(timings, 'graphSignalsQueryMs', () =>
            this.prisma.spammerGraphSignal.findMany({
              where: {
                userId,
                expiresAt: { gt: now },
              },
              orderBy: { observedAt: 'desc' },
              take: 20,
              select: {
                signalType: true,
                source: true,
                score: true,
                chatId: true,
                observedAt: true,
                expiresAt: true,
              },
            }),
          )
        : Promise.resolve([]),
      options.includeReputation
        ? this.timeSpammerStage(timings, 'sourceReputationMs', () => this.getSourceReputation(now))
        : Promise.resolve([]),
      options.includeCampaigns
        ? this.timeSpammerStage(timings, 'campaignsQueryMs', () =>
            this.listUserCampaignDiagnostics(userId),
          )
        : Promise.resolve([]),
      options.includeShadow
        ? this.timeSpammerStage(timings, 'shadowScoreQueryMs', () =>
            this.getLatestShadowScoreDiagnostics(userId),
          )
        : Promise.resolve(null),
    ]);
    const resolvedAdminExempt = params.adminExempt ?? localAdminDecision?.decision === 'ALLOW';
    const riskContext = this.buildPolicyRiskContextFromDiagnostics({
      campaigns,
      latestShadowScore,
    });
    const enforcementMode = params.enforcementMode ?? this.defaultEnforcementMode;
    let policy = await this.evaluatePolicy({
      chatId,
      userId,
      trigger: 'diagnostics',
      deleteSpammersEnabled: resolvedDeleteSpammersEnabled,
      adminExempt: resolvedAdminExempt,
      enforcementMode,
      riskContext,
      lookupContext: {
        now,
        registry,
        candidate,
        activeSuppression,
      },
    });
    if (localAdminDecision?.decision === 'BLOCK') {
      const action = !resolvedDeleteSpammersEnabled
        ? 'NONE'
        : enforcementMode === 'shadow'
          ? 'SHADOW_DELETE_AND_KICK'
          : 'DELETE_AND_KICK';
      policy = this.attachPolicyRiskContext(
        this.buildPolicyDecision({
          userId,
          chatId,
          trigger: 'diagnostics',
          registryStatus: 'LOCAL_BLOCKED',
          action,
          enforcementMode,
          deleteSpammersEnabled: resolvedDeleteSpammersEnabled,
          adminExempt: false,
          confidenceScore: policy.confidenceScore,
          reason: localAdminDecision.reason || 'LOCAL_ADMIN_BLOCK',
          expiresAt: null,
          sourceBreakdown: policy.sourceBreakdown,
          enforced: false,
        }),
        riskContext,
      );
    }

    const result = {
      userId,
      chatId,
      policy,
      registry: {
        active: Boolean(registry?.expiresAt && registry.expiresAt > now),
        expired: Boolean(registry && (!registry.expiresAt || registry.expiresAt <= now)),
        confidenceScore: registry?.confidenceScore ?? null,
        confirmedAt: registry?.confirmedAt?.toISOString() ?? null,
        confirmedByUserId: candidate?.reviewedByUserId ?? null,
        reason: registry?.lastReason ?? null,
        expiresAt: registry?.expiresAt?.toISOString() ?? null,
        sourceBreakdown: registry?.sourceBreakdown ?? null,
      },
      candidate: candidate
        ? {
            status: candidate.status,
            confidenceScore: this.clampScore(candidate.confidenceScore),
            lastReason: candidate.lastReason,
            reviewedAt: candidate.reviewedAt?.toISOString() ?? null,
            reviewedByUserId: candidate.reviewedByUserId,
            reviewReason: candidate.reviewReason,
            falsePositive: candidate.falsePositive,
          }
        : null,
      activeSuppression: activeSuppression
        ? {
            source: activeSuppression.source,
            reason: activeSuppression.reason,
            adminUserId: activeSuppression.adminUserId,
            suppressedUntil: activeSuppression.suppressedUntil.toISOString(),
          }
        : null,
      observations: observations.map((row) => ({
        id: row.id,
        source: row.source,
        score: this.clampScore(row.score),
        confidenceLevel: this.normalizeConfidenceLevel(row.confidenceLevel, row.score),
        reason: row.reason,
        chatId: row.chatId,
        observedAt: row.observedAt.toISOString(),
        expiresAt: row.expiresAt.toISOString(),
        suppressedAt: row.suppressedAt?.toISOString() ?? null,
      })),
      graphSignals: graphSignals.map((row) => ({
        signalType: row.signalType,
        source: row.source,
        score: this.clampScore(row.score),
        chatId: row.chatId,
        observedAt: row.observedAt.toISOString(),
        expiresAt: row.expiresAt.toISOString(),
      })),
      sourceReputation: reputation,
      campaigns,
      latestShadowScore,
      localAdminDecision: localAdminDecision
        ? {
            decision: localAdminDecision.decision,
            reason: localAdminDecision.reason,
            sourceChatId: localAdminDecision.sourceChatId,
            decidedByUserIds: localAdminDecision.decidedByUserIds,
            updatedAt: localAdminDecision.updatedAt.toISOString(),
          }
        : null,
      reputationSummary: this.buildReputationSummary(observations, now),
    };
    this.logSpammerIntelligenceTiming('getUserDiagnostics', {
      chatId,
      userId,
      ...options,
      ...timings,
      totalMs: Date.now() - startedAtMs,
    });
    return result;
  }

  private async resolveDeleteSpammersEnabled(chatId: string | null): Promise<boolean> {
    if (!chatId) {
      return false;
    }
    const chat = await this.prisma.chat.findUnique({
      where: { id: chatId },
      select: {
        settings: {
          select: {
            deleteSpammersEnabled: true,
          },
        },
      },
    });
    return Boolean(chat?.settings?.deleteSpammersEnabled);
  }

  private async listReviewQueueCandidateIds(params: {
    chatId: string;
    status?: GlobalSpammerCandidateStatus;
    limit: number;
  }): Promise<string[]> {
    const statusFilter = params.status ? Prisma.sql`AND c.status = ${params.status}` : Prisma.empty;
    const rows = await this.prisma.$queryRaw<ReviewQueueCandidateIdRow[]>(Prisma.sql`
      WITH scoped_candidates AS (
        SELECT
          c.user_id,
          c.confidence_score,
          GREATEST(edge.last_detected_at, c.last_detected_at) AS rank_detected_at,
          c.last_detected_at
        FROM global_spammer_candidate_chats edge
        INNER JOIN global_spammer_candidates c ON c.user_id = edge.candidate_user_id
        WHERE edge.chat_id = ${params.chatId}
          ${statusFilter}

        UNION ALL

        SELECT
          c.user_id,
          c.confidence_score,
          c.last_detected_at AS rank_detected_at,
          c.last_detected_at
        FROM global_spammer_candidates c
        WHERE c.last_chat_id = ${params.chatId}
          ${statusFilter}
      ),
      ranked_candidates AS (
        SELECT DISTINCT ON (user_id)
          user_id,
          confidence_score,
          rank_detected_at,
          last_detected_at
        FROM scoped_candidates
        ORDER BY user_id, confidence_score DESC, rank_detected_at DESC, last_detected_at DESC
      )
      SELECT user_id AS "userId"
      FROM ranked_candidates
      ORDER BY confidence_score DESC, rank_detected_at DESC, last_detected_at DESC
      LIMIT ${params.limit}
    `);
    return rows.map((row) => row.userId).filter(Boolean);
  }

  private async loadReviewQueueCandidatesByIds(userIds: readonly string[]) {
    if (userIds.length === 0) {
      return [];
    }
    return this.prisma.globalSpammerCandidate.findMany({
      where: {
        userId: {
          in: [...userIds],
        },
      },
      include: {
        chats: {
          orderBy: {
            lastDetectedAt: 'desc',
          },
          take: 10,
        },
      },
    });
  }

  private async listReviewQueueObservations(
    userIds: readonly string[],
    perUserLimit: number,
  ): Promise<ReviewQueueObservationRow[]> {
    const normalizedUserIds = [...new Set(userIds.map((item) => item.trim()).filter(Boolean))];
    if (normalizedUserIds.length === 0) {
      return [];
    }
    const take = Math.max(1, Math.min(Math.trunc(perUserLimit), 20));
    return this.prisma.$queryRaw<ReviewQueueObservationRow[]>(Prisma.sql`
      SELECT
        observation.id,
        observation.user_id AS "userId",
        observation.source,
        observation.score,
        observation.confidence_level AS "confidenceLevel",
        observation.reason,
        observation.chat_id AS "chatId",
        observation.message_id AS "messageId",
        observation.evidence_hash AS "evidenceHash",
        observation.evidence,
        observation.observed_at AS "observedAt",
        observation.expires_at AS "expiresAt",
        observation.suppressed_at AS "suppressedAt",
        observation.suppression_reason AS "suppressionReason"
      FROM unnest(ARRAY[${Prisma.join(normalizedUserIds)}]::text[]) AS selected(user_id)
      JOIN LATERAL (
        SELECT
          id,
          user_id,
          source,
          score,
          confidence_level,
          reason,
          chat_id,
          message_id,
          evidence_hash,
          evidence,
          observed_at,
          expires_at,
          suppressed_at,
          suppression_reason
        FROM spammer_observations
        WHERE user_id = selected.user_id
        ORDER BY observed_at DESC
        LIMIT ${take}
      ) observation ON TRUE
      ORDER BY selected.user_id, observation.observed_at DESC
    `);
  }

  async resolveLocalReviewProfiles(params: {
    chatId: string;
    userIds: readonly string[];
    candidates?: ReadonlyArray<{
      userId: string;
      lastUserLabel?: string | null;
      chats?: ReadonlyArray<{
        chatId: string;
        lastUserLabel?: string | null;
        lastDetectedAt?: Date | string | null;
      }>;
    }>;
  }): Promise<Map<string, GlobalSpammerLocalProfile>> {
    const normalizedUserIds = [
      ...new Set(params.userIds.map((item) => item.trim()).filter(Boolean)),
    ];
    const profiles = new Map<string, GlobalSpammerLocalProfile>();
    if (normalizedUserIds.length === 0) {
      return profiles;
    }

    const candidateByUserId = new Map(
      (params.candidates ?? []).map((candidate) => [candidate.userId.trim(), candidate]),
    );
    for (const userId of normalizedUserIds) {
      const candidate = candidateByUserId.get(userId);
      const chatLabel = candidate?.chats
        ?.filter((chat) => chat.chatId === params.chatId)
        .sort(
          (left, right) =>
            this.readTimestampMs(right.lastDetectedAt) - this.readTimestampMs(left.lastDetectedAt),
        )
        .map((chat) => this.normalizeUserFacingName(chat.lastUserLabel, userId))
        .find((label) => label.length > 0);
      const candidateLabel = this.normalizeUserFacingName(candidate?.lastUserLabel, userId);
      const displayName = chatLabel || candidateLabel || null;
      if (displayName) {
        profiles.set(userId, { userId, displayName });
      }
    }

    const missingUserIds = normalizedUserIds.filter((userId) => !profiles.has(userId));
    if (missingUserIds.length === 0) {
      return profiles;
    }

    const rows = await this.prisma.$queryRaw<
      Array<{ user_id: string | null; user_display_name: string | null }>
    >(Prisma.sql`
      SELECT DISTINCT ON (user_id)
        user_id,
        user_display_name
      FROM chat_moderation_feed_items
      WHERE chat_id = ${params.chatId}
        AND user_id IN (${Prisma.join(missingUserIds)})
        AND COALESCE(BTRIM(user_display_name), '') <> ''
      ORDER BY user_id, created_at DESC
    `);

    for (const row of Array.isArray(rows) ? rows : []) {
      const userId = this.normalizeText(row.user_id);
      const displayName = this.normalizeUserFacingName(row.user_display_name, userId);
      if (!userId || !displayName || profiles.has(userId)) {
        continue;
      }
      profiles.set(userId, { userId, displayName });
    }

    return profiles;
  }

  private async getReviewCandidateMetrics(params: {
    chatId?: string | null;
    since: Date;
  }): Promise<{
    pending: number;
    approved: number;
    suppressed: number;
    reviewed: number;
    falsePositiveCount: number;
    newCandidates24h: number;
    autoApproved24h: number;
    suppressed24h: number;
  }> {
    const chatScopedCandidates = params.chatId
      ? Prisma.sql`
          SELECT DISTINCT ON (user_id)
            user_id,
            status,
            first_detected_at,
            reviewed_at,
            false_positive
          FROM (
            SELECT
              c.user_id,
              c.status,
              c.first_detected_at,
              c.reviewed_at,
              c.false_positive
            FROM global_spammer_candidate_chats edge
            INNER JOIN global_spammer_candidates c ON c.user_id = edge.candidate_user_id
            WHERE edge.chat_id = ${params.chatId}

            UNION ALL

            SELECT
              c.user_id,
              c.status,
              c.first_detected_at,
              c.reviewed_at,
              c.false_positive
            FROM global_spammer_candidates c
            WHERE c.last_chat_id = ${params.chatId}
          ) scoped
          ORDER BY user_id
        `
      : Prisma.sql`
          SELECT
            c.user_id,
            c.status,
            c.first_detected_at,
            c.reviewed_at,
            c.false_positive
          FROM global_spammer_candidates c
        `;
    const rows = await this.prisma.$queryRaw<ReviewMetricsCountRow[]>(Prisma.sql`
      WITH scoped_candidates AS (
        ${chatScopedCandidates}
      )
      SELECT
        COUNT(*) FILTER (WHERE status = 'PENDING')::bigint AS "pending",
        COUNT(*) FILTER (WHERE status IN ('APPROVED', 'AUTO_APPROVED'))::bigint AS "approved",
        COUNT(*) FILTER (WHERE status = 'SUPPRESSED')::bigint AS "suppressed",
        COUNT(*) FILTER (WHERE status IN ('APPROVED', 'SUPPRESSED'))::bigint AS "reviewed",
        COUNT(*) FILTER (WHERE false_positive = true)::bigint AS "falsePositiveCount",
        COUNT(*) FILTER (WHERE first_detected_at >= ${params.since})::bigint AS "newCandidates24h",
        COUNT(*) FILTER (
          WHERE status = 'AUTO_APPROVED' AND reviewed_at >= ${params.since}
        )::bigint AS "autoApproved24h",
        COUNT(*) FILTER (
          WHERE status = 'SUPPRESSED' AND reviewed_at >= ${params.since}
        )::bigint AS "suppressed24h"
      FROM scoped_candidates
    `);
    const row = rows[0];
    return {
      pending: this.readSqlCount(row?.pending),
      approved: this.readSqlCount(row?.approved),
      suppressed: this.readSqlCount(row?.suppressed),
      reviewed: this.readSqlCount(row?.reviewed),
      falsePositiveCount: this.readSqlCount(row?.falsePositiveCount),
      newCandidates24h: this.readSqlCount(row?.newCandidates24h),
      autoApproved24h: this.readSqlCount(row?.autoApproved24h),
      suppressed24h: this.readSqlCount(row?.suppressed24h),
    };
  }

  private async getReviewObservationMetrics(params: {
    chatId?: string | null;
    since: Date;
  }): Promise<Array<{ source: string; observedCount: number; suppressedCount: number }>> {
    const chatFilter = params.chatId ? Prisma.sql`AND chat_id = ${params.chatId}` : Prisma.empty;
    const rows = await this.prisma.$queryRaw<ReviewMetricsObservationRow[]>(Prisma.sql`
      SELECT
        source,
        SUM("observedCount")::bigint AS "observedCount",
        SUM("suppressedCount")::bigint AS "suppressedCount"
      FROM (
        SELECT
          source,
          COUNT(*)::bigint AS "observedCount",
          0::bigint AS "suppressedCount"
        FROM spammer_observations
        WHERE observed_at >= ${params.since}
          ${chatFilter}
        GROUP BY source

        UNION ALL

        SELECT
          source,
          0::bigint AS "observedCount",
          COUNT(*)::bigint AS "suppressedCount"
        FROM spammer_observations
        WHERE suppressed_at >= ${params.since}
          ${chatFilter}
        GROUP BY source
      ) metrics
      GROUP BY source
      ORDER BY source ASC
    `);
    return rows.map((row) => ({
      source: row.source,
      observedCount: this.readSqlCount(row.observedCount),
      suppressedCount: this.readSqlCount(row.suppressedCount),
    }));
  }

  private async getReviewRegistryMetrics(params: {
    now: Date;
    since: Date;
    chatId?: string | null;
  }): Promise<ReviewRegistryMetrics> {
    const shadowChatFilter = params.chatId
      ? Prisma.sql`AND chat_id = ${params.chatId}`
      : Prisma.empty;
    const rows = await this.prisma.$queryRaw<ReviewRegistryMetricsRow[]>(Prisma.sql`
      SELECT
        (
          SELECT COUNT(*)
          FROM global_spammers
          WHERE expires_at > ${params.now}
        )::bigint AS "activeRegistry",
        (
          SELECT COUNT(*)
          FROM global_spammers
          WHERE expires_at IS NULL OR expires_at <= ${params.now}
        )::bigint AS "expiredRegistry",
        (
          SELECT COUNT(*)
          FROM global_spammer_archives
        )::bigint AS "archivedExpired",
        (
          SELECT COUNT(*)
          FROM global_spammer_shadow_scores
          WHERE created_at >= ${params.since}
            AND would_promote = true
            ${shadowChatFilter}
        )::bigint AS "shadowWouldEnforceCount"
    `);
    const row = rows[0];
    return {
      activeRegistry: this.readSqlCount(row?.activeRegistry),
      expiredRegistry: this.readSqlCount(row?.expiredRegistry),
      archivedExpired: this.readSqlCount(row?.archivedExpired),
      shadowWouldEnforceCount: this.readSqlCount(row?.shadowWouldEnforceCount),
    };
  }

  private async timeSpammerStage<T>(
    timings: Record<string, number>,
    stage: string,
    task: () => Promise<T>,
  ): Promise<T> {
    const startedAtMs = Date.now();
    try {
      return await task();
    } finally {
      timings[stage] = Date.now() - startedAtMs;
    }
  }

  private readSqlCount(value: unknown): number {
    if (typeof value === 'bigint') {
      return Number(value);
    }
    if (typeof value === 'number' && Number.isFinite(value)) {
      return Math.max(0, Math.trunc(value));
    }
    if (typeof value === 'string') {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? Math.max(0, Math.trunc(parsed)) : 0;
    }
    return 0;
  }

  private logSpammerIntelligenceTiming(operation: string, details: Record<string, unknown>): void {
    this.logger.debug({
      event: 'global_spammer_intelligence_timing',
      operation,
      ...details,
    });
  }

  private buildExpiredRegistryWhere(now: Date): Prisma.GlobalSpammerWhereInput {
    return {
      OR: [
        {
          expiresAt: null,
        },
        {
          expiresAt: {
            lte: now,
          },
        },
      ],
    };
  }

  private async resolveAnyAdminExemption(userId: string, chatId: string | null): Promise<boolean> {
    const localDecision = await this.resolveLocalAdminDecision(userId, chatId);
    return localDecision?.decision === 'ALLOW';
  }

  async getSourceReputation(now = new Date()): Promise<SourceReputation[]> {
    const cacheNowMs = Date.now();
    if (this.sourceReputationCache && this.sourceReputationCache.expiresAtMs > cacheNowMs) {
      return this.sourceReputationCache.rows.map((row) => ({ ...row }));
    }

    const since = new Date(now.getTime() - SOURCE_REPUTATION_WINDOW_DAYS * DAY_MS);
    const reputationRows = await this.prisma.$queryRaw<SourceReputationRow[]>(Prisma.sql`
      SELECT
        source,
        SUM("observedCount")::bigint AS "observedCount",
        SUM("suppressedCount")::bigint AS "suppressedCount"
      FROM (
        SELECT
          source,
          COUNT(*)::bigint AS "observedCount",
          0::bigint AS "suppressedCount"
        FROM spammer_observations
        WHERE observed_at >= ${since}
        GROUP BY source

        UNION ALL

        SELECT
          source,
          0::bigint AS "observedCount",
          COUNT(*)::bigint AS "suppressedCount"
        FROM spammer_observations
        WHERE suppressed_at >= ${since}
        GROUP BY source
      ) reputation
      GROUP BY source
      HAVING SUM("observedCount") > 0
      ORDER BY source ASC
    `);
    const rows = reputationRows
      .map((row) => {
        const observations = this.readSqlCount(row.observedCount);
        const suppressedCount = this.readSqlCount(row.suppressedCount);
        const falsePositiveRate = observations > 0 ? suppressedCount / observations : 0;
        const weight = this.resolveSourceReputationWeight(
          row.source,
          observations,
          falsePositiveRate,
        );
        return {
          source: row.source,
          weight,
          falsePositiveRate: this.roundScore(falsePositiveRate),
          observations,
          suppressed: suppressedCount,
        };
      })
      .sort((left, right) => left.source.localeCompare(right.source));
    this.sourceReputationCache = {
      expiresAtMs: cacheNowMs + SOURCE_REPUTATION_CACHE_TTL_MS,
      rows,
    };
    return rows.map((row) => ({ ...row }));
  }

  private invalidateSourceReputationCache(): void {
    this.sourceReputationCache = null;
  }

  private async getSourceReputationMap(now: Date): Promise<Map<string, SourceReputation>> {
    const rows = await this.getSourceReputation(now);
    return new Map(rows.map((row) => [row.source, row]));
  }

  private resolveSourceReputationWeight(
    source: string,
    observations: number,
    falsePositiveRate: number,
  ): number {
    const baseWeight = this.resolveSourceBaseWeight(source);
    let qualityWeight = 1;
    if (observations >= 10 && falsePositiveRate >= 0.6) {
      qualityWeight = 0.5;
    } else if (observations >= 10 && falsePositiveRate >= 0.35) {
      qualityWeight = 0.65;
    } else if (observations >= 10 && falsePositiveRate >= 0.2) {
      qualityWeight = 0.8;
    }
    return this.roundScore(baseWeight * qualityWeight);
  }

  private resolveSourceBaseWeight(source: string): number {
    return SOURCE_BASE_REPUTATION_WEIGHTS[source as GlobalSpammerObservationSource] ?? 1;
  }

  private resolveDefaultEnforcementMode(
    configService?: ConfigService,
  ): GlobalSpammerEnforcementMode {
    const configuredMode = this.normalizeText(
      configService?.get<string>('GLOBAL_SPAMMER_ENFORCEMENT_MODE'),
    ).toLowerCase();
    if (configuredMode === 'shadow') {
      return 'shadow';
    }
    if (configuredMode === 'enforce') {
      return 'enforce';
    }

    const shadowFlag = this.normalizeText(
      configService?.get<string>('GLOBAL_SPAMMER_SHADOW_MODE'),
    ).toLowerCase();
    return ['1', 'true', 'yes', 'on'].includes(shadowFlag) ? 'shadow' : 'enforce';
  }

  private buildPolicyDecision(params: {
    userId: string;
    chatId: string | null;
    trigger: string;
    registryStatus: GlobalSpammerRegistryStatus;
    action: GlobalSpammerPolicyAction;
    enforcementMode: GlobalSpammerEnforcementMode;
    deleteSpammersEnabled: boolean;
    adminExempt: boolean;
    confidenceScore: number | null;
    reason: string;
    expiresAt: string | null;
    sourceBreakdown: Prisma.InputJsonValue | null;
    enforced: boolean;
    shadowScore?: number | null;
    campaignBreakdown?: Prisma.InputJsonValue | null;
  }): GlobalSpammerPolicyDecision {
    const wouldEnforce = params.registryStatus === 'ACTIVE_CONFIRMED';
    const confidenceScore =
      typeof params.confidenceScore === 'number' ? this.roundScore(params.confidenceScore) : null;
    const shadowScore =
      typeof params.shadowScore === 'number' ? this.roundScore(params.shadowScore) : null;
    return {
      userId: params.userId,
      chatId: params.chatId,
      trigger: params.trigger,
      registryStatus: params.registryStatus,
      action: params.action,
      enforcementMode: params.enforcementMode,
      policyBand: this.resolveDecisionPolicyBand(
        params.registryStatus,
        confidenceScore,
        shadowScore,
      ),
      deleteSpammersEnabled: params.deleteSpammersEnabled,
      adminExempt: params.adminExempt,
      shadow: params.action === 'SHADOW_DELETE_AND_KICK',
      wouldEnforce,
      enforced: params.enforced,
      confidenceScore,
      shadowScore,
      reason: params.reason,
      expiresAt: params.expiresAt,
      sourceBreakdown: params.sourceBreakdown,
      campaignBreakdown: params.campaignBreakdown ?? null,
    };
  }

  private attachPolicyRiskContext(
    decision: GlobalSpammerPolicyDecision,
    riskContext: PolicyDecisionRiskContext,
  ): GlobalSpammerPolicyDecision {
    const shadowScore =
      typeof riskContext.shadowScore === 'number' ? this.roundScore(riskContext.shadowScore) : null;
    return {
      ...decision,
      policyBand: this.resolveDecisionPolicyBand(
        decision.registryStatus,
        decision.confidenceScore,
        shadowScore,
      ),
      shadowScore,
      campaignBreakdown: riskContext.campaignBreakdown ?? decision.campaignBreakdown,
    };
  }

  private async evaluatePolicyFromRuntimeProfile(params: {
    chatId: string | null;
    userId: string;
    trigger: string;
    deleteSpammersEnabled: boolean;
    adminExempt: boolean;
    enforcementMode: GlobalSpammerEnforcementMode;
    recordDecision: boolean;
    messageId: string | null;
    enforced?: boolean;
    now: Date;
    lookupContextProvided: boolean;
  }): Promise<GlobalSpammerPolicyDecision | null> {
    if (
      !this.runtimeProfileCacheEnabled ||
      !this.runtimeProfileReadModelEnabled ||
      params.lookupContextProvided
    ) {
      return null;
    }

    const decision = await this.buildPolicyDecisionFromRuntimeProfile(params);
    if (!decision) {
      this.recordSpammerReadModelEvent('fallback_after_profile_miss');
      return null;
    }

    if (params.recordDecision) {
      await this.recordPolicyDecision({
        decision,
        messageId: params.messageId,
      });
    }

    this.logSpammerIntelligenceTiming('evaluatePolicyRuntimeProfileHit', {
      userId: params.userId,
      chatId: params.chatId,
      registryStatus: decision.registryStatus,
      action: decision.action,
    });
    return decision;
  }

  private async buildPolicyDecisionFromRuntimeProfile(params: {
    chatId: string | null;
    userId: string;
    trigger: string;
    deleteSpammersEnabled: boolean;
    adminExempt: boolean;
    enforcementMode: GlobalSpammerEnforcementMode;
    recordDecision: boolean;
    messageId: string | null;
    enforced?: boolean;
    now: Date;
  }): Promise<GlobalSpammerPolicyDecision | null> {
    if (!this.runtimeProfileCacheEnabled) {
      return null;
    }

    const snapshot = await this.readRuntimeProfileSnapshot(params.userId, params.now);
    if (!snapshot) {
      return null;
    }

    const developerForcedProfileActive =
      snapshot.registryStatus === 'ACTIVE_CONFIRMED' &&
      this.hasDeveloperForcedSource(snapshot.sourceBreakdown);
    const adminExempt = params.adminExempt && !developerForcedProfileActive;
    const baseAction = this.resolveRuntimeProfileAction({
      snapshot,
      deleteSpammersEnabled: params.deleteSpammersEnabled,
      enforcementMode: params.enforcementMode,
      developerForced: developerForcedProfileActive,
    });
    const decision = this.attachPolicyRiskContext(
      this.buildPolicyDecision({
        userId: params.userId,
        chatId: params.chatId,
        trigger: params.trigger,
        registryStatus: adminExempt ? 'ADMIN_EXEMPT' : snapshot.registryStatus,
        action: adminExempt ? 'NONE' : baseAction,
        enforcementMode: params.enforcementMode,
        deleteSpammersEnabled: params.deleteSpammersEnabled,
        adminExempt: params.adminExempt,
        confidenceScore: snapshot.confidenceScore,
        reason: adminExempt ? 'ADMIN_EXEMPT' : snapshot.reason,
        expiresAt: adminExempt ? null : (snapshot.expiresAt ?? snapshot.suppressedUntil),
        sourceBreakdown: adminExempt ? null : snapshot.sourceBreakdown,
        enforced: Boolean(
          (params.enforced ?? params.recordDecision) &&
          !adminExempt &&
          baseAction === 'DELETE_AND_KICK',
        ),
      }),
      {
        shadowScore: snapshot.shadowScore,
        campaignBreakdown: snapshot.campaignBreakdown,
      },
    );
    return decision;
  }

  private logRuntimeProfileShadowComparison(params: {
    runtimeDecision: GlobalSpammerPolicyDecision;
    fallbackDecision: GlobalSpammerPolicyDecision;
  }): void {
    const comparedFields: Array<keyof GlobalSpammerPolicyDecision> = [
      'registryStatus',
      'action',
      'policyBand',
      'expiresAt',
    ];
    const mismatches = comparedFields.filter(
      (field) => params.runtimeDecision[field] !== params.fallbackDecision[field],
    );
    const confidenceDelta = this.roundScore(
      Math.abs(
        (params.runtimeDecision.confidenceScore ?? 0) -
          (params.fallbackDecision.confidenceScore ?? 0),
      ),
    );
    const shadowScoreDelta = this.roundScore(
      Math.abs(
        (params.runtimeDecision.shadowScore ?? 0) - (params.fallbackDecision.shadowScore ?? 0),
      ),
    );
    const scoreDrift = confidenceDelta >= 0.001 || shadowScoreDelta >= 0.001;
    const matched = mismatches.length === 0;

    const payload = {
      event: 'global_spammer_read_model_shadow_compare',
      matched,
      scoreDrift,
      userId: params.fallbackDecision.userId,
      chatId: params.fallbackDecision.chatId,
      trigger: params.fallbackDecision.trigger,
      mismatches,
      confidenceDelta,
      shadowScoreDelta,
      runtime: {
        registryStatus: params.runtimeDecision.registryStatus,
        action: params.runtimeDecision.action,
        policyBand: params.runtimeDecision.policyBand,
        confidenceScore: params.runtimeDecision.confidenceScore,
        shadowScore: params.runtimeDecision.shadowScore,
        expiresAt: params.runtimeDecision.expiresAt,
      },
      fallback: {
        registryStatus: params.fallbackDecision.registryStatus,
        action: params.fallbackDecision.action,
        policyBand: params.fallbackDecision.policyBand,
        confidenceScore: params.fallbackDecision.confidenceScore,
        shadowScore: params.fallbackDecision.shadowScore,
        expiresAt: params.fallbackDecision.expiresAt,
      },
    };

    if (matched) {
      this.recordSpammerReadModelEvents([
        'shadow_compared',
        'shadow_matched',
        ...(scoreDrift ? (['shadow_score_drift'] as const) : []),
      ]);
      this.logger.debug(payload);
      return;
    }
    this.recordSpammerReadModelEvents([
      'shadow_compared',
      'shadow_mismatched',
      ...(scoreDrift ? (['shadow_score_drift'] as const) : []),
    ]);
    this.logger.warn(payload);
  }

  private scheduleRuntimeProfileShadowComparison(params: {
    runtimeDecisionPromise: Promise<GlobalSpammerPolicyDecision | null> | null;
    fallbackDecision: GlobalSpammerPolicyDecision;
    userId: string;
    chatId: string | null;
    trigger: string;
  }): void {
    if (!params.runtimeDecisionPromise) {
      return;
    }

    void params.runtimeDecisionPromise
      .then((runtimeDecision) => {
        if (!runtimeDecision) {
          return;
        }
        this.logRuntimeProfileShadowComparison({
          runtimeDecision,
          fallbackDecision: params.fallbackDecision,
        });
      })
      .catch((error: unknown) => {
        this.logger.debug(
          {
            event: 'global_spammer_read_model_shadow_compare_failed',
            userId: params.userId,
            chatId: params.chatId,
            trigger: params.trigger,
            error: error instanceof Error ? error.message : String(error),
          },
          'Failed to compare spammer runtime profile shadow decision',
        );
      });
  }

  private shouldSampleRuntimeProfileShadow(userId: string): boolean {
    if (this.runtimeProfileShadowSampleRate >= 1) {
      return true;
    }
    if (this.runtimeProfileShadowSampleRate <= 0) {
      return false;
    }
    const hashPrefix = createHash('sha256').update(userId).digest('hex').slice(0, 8);
    const bucket = Number.parseInt(hashPrefix, 16) / 0xffffffff;
    return bucket < this.runtimeProfileShadowSampleRate;
  }

  private resolveRuntimeProfileAction(params: {
    snapshot: RuntimeProfileSnapshot;
    deleteSpammersEnabled: boolean;
    enforcementMode: GlobalSpammerEnforcementMode;
    developerForced: boolean;
  }): GlobalSpammerPolicyAction {
    if (
      params.snapshot.registryStatus !== 'ACTIVE_CONFIRMED' ||
      params.snapshot.action === 'NONE' ||
      (!params.deleteSpammersEnabled && !params.developerForced)
    ) {
      return 'NONE';
    }
    return params.enforcementMode === 'shadow' ? 'SHADOW_DELETE_AND_KICK' : 'DELETE_AND_KICK';
  }

  private async readRuntimeProfileSnapshot(
    userId: string,
    now: Date,
  ): Promise<RuntimeProfileSnapshot | null> {
    const cached = this.readRuntimeProfileFromL1(userId);
    if (cached !== undefined) {
      const fresh = this.isFreshRuntimeProfileSnapshot(cached, now);
      this.recordSpammerReadModelEvent(
        fresh ? 'profile_read_hit' : cached ? 'profile_read_stale' : 'profile_read_miss',
      );
      return fresh ? cached : null;
    }

    const redisSnapshot = await this.readRuntimeProfileFromRedis(userId);
    if (redisSnapshot !== undefined) {
      this.writeRuntimeProfileToL1(userId, redisSnapshot);
      const fresh = this.isFreshRuntimeProfileSnapshot(redisSnapshot, now);
      this.recordSpammerReadModelEvent(
        fresh ? 'profile_read_hit' : redisSnapshot ? 'profile_read_stale' : 'profile_read_miss',
      );
      return fresh ? redisSnapshot : null;
    }

    const row = await this.prisma.globalSpammerRuntimeProfile.findUnique({
      where: {
        userId,
      },
    });
    const snapshot = row ? this.runtimeProfileRowToSnapshot(row) : null;
    await this.writeRuntimeProfileToCaches(userId, snapshot);
    const fresh = this.isFreshRuntimeProfileSnapshot(snapshot, now);
    this.recordSpammerReadModelEvent(
      fresh ? 'profile_read_hit' : snapshot ? 'profile_read_stale' : 'profile_read_miss',
    );
    return fresh ? snapshot : null;
  }

  private readRuntimeProfileFromL1(userId: string): RuntimeProfileSnapshot | null | undefined {
    const entry = this.runtimeProfileL1Cache.get(userId);
    if (!entry) {
      return undefined;
    }
    if (entry.expiresAtMs <= Date.now()) {
      this.runtimeProfileL1Cache.delete(userId);
      return undefined;
    }
    return entry.snapshot ? { ...entry.snapshot } : null;
  }

  private writeRuntimeProfileToL1(
    userId: string,
    snapshot: RuntimeProfileSnapshot | null,
    ttlMs = RUNTIME_PROFILE_L1_TTL_MS,
  ): void {
    if (this.runtimeProfileL1Stopped) {
      return;
    }
    // FLAG: Capacity applies only to reconstructible snapshots, including negative entries;
    // Redis TTLs and authoritative DB profiles are unchanged. Promote refreshed entries.
    this.runtimeProfileL1Cache.delete(userId);
    this.runtimeProfileL1Cache.set(userId, {
      snapshot: snapshot ? { ...snapshot } : null,
      expiresAtMs: Date.now() + Math.max(1, ttlMs),
    });
    while (this.runtimeProfileL1Cache.size > RUNTIME_PROFILE_L1_MAX_ENTRIES) {
      const oldestUserId = this.runtimeProfileL1Cache.keys().next().value;
      if (oldestUserId === undefined) break;
      this.runtimeProfileL1Cache.delete(oldestUserId);
    }
    this.scheduleRuntimeProfileL1Sweep(RUNTIME_PROFILE_L1_SWEEP_INTERVAL_MS);
  }

  private async readRuntimeProfileFromRedis(
    userId: string,
  ): Promise<RuntimeProfileSnapshot | null | undefined> {
    if (!this.redisCounter) {
      return undefined;
    }
    try {
      const value = await this.redisCounter.getString(this.buildRuntimeProfileCacheKey(userId));
      if (value === null) {
        return undefined;
      }
      if (value === 'null') {
        return null;
      }
      return this.parseRuntimeProfileSnapshot(value);
    } catch (error: unknown) {
      this.logger.debug(
        {
          userId,
          error: error instanceof Error ? error.message : String(error),
        },
        'Failed to read spammer runtime profile cache',
      );
      return undefined;
    }
  }

  private async writeRuntimeProfileToCaches(
    userId: string,
    snapshot: RuntimeProfileSnapshot | null,
  ): Promise<void> {
    this.writeRuntimeProfileToL1(userId, snapshot);
    if (!this.redisCounter) {
      return;
    }
    try {
      await this.redisCounter.setStringWithTtl(
        this.buildRuntimeProfileCacheKey(userId),
        snapshot ? JSON.stringify(snapshot) : 'null',
        snapshot ? RUNTIME_PROFILE_REDIS_TTL_SEC : RUNTIME_PROFILE_REDIS_NEGATIVE_TTL_SEC,
      );
    } catch (error: unknown) {
      this.logger.debug(
        {
          userId,
          error: error instanceof Error ? error.message : String(error),
        },
        'Failed to write spammer runtime profile cache',
      );
    }
  }

  private async invalidateRuntimeProfileCaches(userId: string): Promise<void> {
    if (!this.runtimeProfileCacheEnabled) {
      return;
    }
    this.runtimeProfileL1Cache.delete(userId);
    if (!this.redisCounter) {
      return;
    }
    try {
      await this.redisCounter.deleteKey(this.buildRuntimeProfileCacheKey(userId));
    } catch (error: unknown) {
      this.logger.debug(
        {
          userId,
          error: error instanceof Error ? error.message : String(error),
        },
        'Failed to invalidate spammer runtime profile cache',
      );
    }
  }

  private buildRuntimeProfileCacheKey(userId: string): string {
    return `spammer:profile:v2:${userId}`;
  }

  private recordSpammerReadModelEvent(
    event: SpammerReadModelEvent,
    params: { jobAgeMs?: number | null } = {},
  ): void {
    this.recordSpammerReadModelEvents([event], params);
  }

  private recordSpammerReadModelEvents(
    events: readonly SpammerReadModelEvent[],
    params: { jobAgeMs?: number | null } = {},
  ): void {
    void this.runtimeDiagnostics
      ?.recordSpammerReadModelEvents({
        events,
        jobAgeMs: params.jobAgeMs,
      })
      .catch((error: unknown) => {
        this.logger.debug(
          {
            events,
            error: error instanceof Error ? error.message : String(error),
          },
          'Failed to record spammer read model diagnostics',
        );
      });
  }

  private resolveDenormJobAgeMs(job: GlobalSpammerDenormJob): number | null {
    const createdAtMs = this.readTimestampMs(job.createdAt);
    if (createdAtMs <= 0) {
      return null;
    }
    return Math.max(0, Date.now() - createdAtMs);
  }

  private isFreshRuntimeProfileSnapshot(
    snapshot: RuntimeProfileSnapshot | null,
    now: Date,
  ): snapshot is RuntimeProfileSnapshot {
    if (!snapshot || snapshot.sourceVersion !== RUNTIME_PROFILE_SOURCE_VERSION) {
      return false;
    }
    if (snapshot.staleAfter && new Date(snapshot.staleAfter) <= now) {
      return false;
    }
    if (
      snapshot.registryStatus === 'ACTIVE_CONFIRMED' &&
      (!snapshot.expiresAt || new Date(snapshot.expiresAt) <= now)
    ) {
      return false;
    }
    if (
      snapshot.registryStatus === 'SUPPRESSED' &&
      snapshot.suppressedUntil &&
      new Date(snapshot.suppressedUntil) <= now
    ) {
      return false;
    }
    return true;
  }

  private parseRuntimeProfileSnapshot(value: string): RuntimeProfileSnapshot | null | undefined {
    try {
      const parsed = JSON.parse(value) as Partial<RuntimeProfileSnapshot>;
      if (
        !parsed ||
        typeof parsed.userId !== 'string' ||
        typeof parsed.registryStatus !== 'string' ||
        typeof parsed.action !== 'string' ||
        typeof parsed.reason !== 'string' ||
        typeof parsed.sourceVersion !== 'number'
      ) {
        return undefined;
      }
      return {
        userId: parsed.userId,
        registryStatus: this.normalizeRegistryStatus(parsed.registryStatus),
        action: this.normalizePolicyAction(parsed.action),
        confidenceScore: this.readOptionalScore(parsed.confidenceScore),
        shadowScore: this.readOptionalScore(parsed.shadowScore),
        policyBand: this.normalizePolicyBand(parsed.policyBand),
        reason: parsed.reason,
        expiresAt: typeof parsed.expiresAt === 'string' ? parsed.expiresAt : null,
        suppressedUntil: typeof parsed.suppressedUntil === 'string' ? parsed.suppressedUntil : null,
        sourceBreakdown: this.toNullableInputJsonValue(parsed.sourceBreakdown),
        campaignBreakdown: this.toNullableInputJsonValue(parsed.campaignBreakdown),
        sourceVersion: parsed.sourceVersion,
        staleAfter: typeof parsed.staleAfter === 'string' ? parsed.staleAfter : null,
        updatedAt:
          typeof parsed.updatedAt === 'string' ? parsed.updatedAt : new Date().toISOString(),
      };
    } catch {
      return undefined;
    }
  }

  private runtimeProfileRowToSnapshot(row: GlobalSpammerRuntimeProfileRow): RuntimeProfileSnapshot {
    return {
      userId: row.userId,
      registryStatus: this.normalizeRegistryStatus(row.registryStatus),
      action: this.normalizePolicyAction(row.action),
      confidenceScore: this.readOptionalScore(row.confidenceScore),
      shadowScore: this.readOptionalScore(row.shadowScore),
      policyBand: this.normalizePolicyBand(row.policyBand),
      reason: row.reason,
      expiresAt: row.expiresAt?.toISOString() ?? null,
      suppressedUntil: row.suppressedUntil?.toISOString() ?? null,
      sourceBreakdown: this.toNullableInputJsonValue(row.sourceBreakdown),
      campaignBreakdown: this.toNullableInputJsonValue(row.campaignBreakdown),
      sourceVersion: row.sourceVersion,
      staleAfter: row.staleAfter?.toISOString() ?? null,
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  private async buildPolicyDecisionRiskContext(
    userId: string,
    options: { allowCampaignFallback?: boolean } = {},
  ): Promise<PolicyDecisionRiskContext> {
    const latestShadowScore = await this.prisma.globalSpammerShadowScore.findFirst({
      where: {
        userId,
      },
      orderBy: {
        createdAt: 'desc',
      },
    });
    if (!latestShadowScore) {
      return {
        shadowScore: null,
        campaignBreakdown: null,
      };
    }

    const shadowCampaignBreakdown = this.asRecord(latestShadowScore?.campaignBreakdown);
    const campaignBreakdown =
      shadowCampaignBreakdown && Object.keys(shadowCampaignBreakdown).length > 0
        ? this.toInputJsonObject(shadowCampaignBreakdown)
        : options.allowCampaignFallback === false
          ? null
          : await this.buildCampaignBreakdownForUser(userId);

    return {
      shadowScore:
        typeof latestShadowScore?.v2Score === 'number'
          ? this.roundScore(latestShadowScore.v2Score)
          : null,
      campaignBreakdown,
    };
  }

  private async scheduleRuntimeProfileWriteFromDecision(params: {
    decision: GlobalSpammerPolicyDecision;
    activeSuppression?: GlobalSpammerSuppressionRow | null;
    registry?: GlobalSpammerRow | null;
    candidate?: GlobalSpammerCandidateRow | null;
    now: Date;
    source: string;
    lookupContextProvided: boolean;
  }): Promise<void> {
    if (!this.runtimeProfileCacheEnabled) {
      return;
    }
    if (this.runtimeProfileAsyncWriteEnabled) {
      void this.writeRuntimeProfileFromDecision(params).catch((error: unknown) => {
        this.logger.debug(
          {
            userId: params.decision.userId,
            source: params.source,
            error: error instanceof Error ? error.message : String(error),
          },
          'Failed to refresh spammer runtime profile asynchronously',
        );
      });
      return;
    }
    await this.writeRuntimeProfileFromDecision(params);
  }

  private async writeRuntimeProfileFromDecision(params: {
    decision: GlobalSpammerPolicyDecision;
    activeSuppression?: GlobalSpammerSuppressionRow | null;
    registry?: GlobalSpammerRow | null;
    candidate?: GlobalSpammerCandidateRow | null;
    now: Date;
    source: string;
    lookupContextProvided: boolean;
  }): Promise<void> {
    if (await this.legacyHolds?.isGlobalUserHeld(params.decision.userId)) return;
    const snapshot = this.buildRuntimeProfileSnapshotFromDecision(params);
    const staleAfter = snapshot.staleAfter ? new Date(snapshot.staleAfter) : null;
    try {
      await this.prisma.globalSpammerRuntimeProfile.upsert({
        where: {
          userId: snapshot.userId,
        },
        create: {
          userId: snapshot.userId,
          registryStatus: snapshot.registryStatus,
          action: snapshot.action,
          confidenceScore: snapshot.confidenceScore,
          shadowScore: snapshot.shadowScore,
          policyBand: snapshot.policyBand,
          reason: snapshot.reason,
          expiresAt: snapshot.expiresAt ? new Date(snapshot.expiresAt) : null,
          suppressedUntil: snapshot.suppressedUntil ? new Date(snapshot.suppressedUntil) : null,
          sourceBreakdown: snapshot.sourceBreakdown ?? Prisma.JsonNull,
          campaignBreakdown: snapshot.campaignBreakdown ?? Prisma.JsonNull,
          sourceVersion: RUNTIME_PROFILE_SOURCE_VERSION,
          staleAfter,
        },
        update: {
          registryStatus: snapshot.registryStatus,
          action: snapshot.action,
          confidenceScore: snapshot.confidenceScore,
          shadowScore: snapshot.shadowScore,
          policyBand: snapshot.policyBand,
          reason: snapshot.reason,
          expiresAt: snapshot.expiresAt ? new Date(snapshot.expiresAt) : null,
          suppressedUntil: snapshot.suppressedUntil ? new Date(snapshot.suppressedUntil) : null,
          sourceBreakdown: snapshot.sourceBreakdown ?? Prisma.JsonNull,
          campaignBreakdown: snapshot.campaignBreakdown ?? Prisma.JsonNull,
          sourceVersion: RUNTIME_PROFILE_SOURCE_VERSION,
          staleAfter,
        },
      });
      await this.writeRuntimeProfileToCaches(snapshot.userId, snapshot);
      this.recordSpammerReadModelEvent('profile_write_success');
    } catch (error: unknown) {
      this.recordSpammerReadModelEvent('profile_write_failure');
      throw error;
    }
  }

  private async scheduleRuntimeProfileRefresh(
    userId: string,
    chatId: string | null,
    source: string,
  ): Promise<void> {
    if (!this.runtimeProfileCacheEnabled) {
      return;
    }
    const task = async () => {
      const now = new Date();
      const [registry, candidate, activeSuppression, riskContext] = await Promise.all([
        this.prisma.globalSpammer.findUnique({ where: { userId } }),
        this.prisma.globalSpammerCandidate.findUnique({ where: { userId } }),
        this.findActiveSuppression(userId, now),
        this.buildPolicyDecisionRiskContext(userId, { allowCampaignFallback: false }),
      ]);
      const decision = await this.evaluatePolicy({
        chatId,
        userId,
        trigger: `runtime-profile:${source}`,
        deleteSpammersEnabled: true,
        enforcementMode: 'enforce',
        recordDecision: false,
        riskContext,
        skipRuntimeProfileWrite: true,
        lookupContext: {
          now,
          registry,
          candidate,
          activeSuppression,
        },
      });
      await this.writeRuntimeProfileFromDecision({
        decision,
        activeSuppression,
        registry,
        candidate,
        now,
        source,
        lookupContextProvided: true,
      });
    };

    if (this.runtimeProfileAsyncWriteEnabled) {
      void task().catch((error: unknown) => {
        this.logger.debug(
          {
            userId,
            source,
            error: error instanceof Error ? error.message : String(error),
          },
          'Failed to refresh spammer runtime profile',
        );
      });
      return;
    }
    await task();
  }

  private async finishObservationDecision<TDecision extends GlobalSpammerObservationDecision>(
    decision: TDecision,
    params: {
      userId: string;
      chatId: string | null;
      observationId: string;
      source: GlobalSpammerObservationSource;
      reason: string;
      observedAt: Date;
    },
  ): Promise<TDecision> {
    await this.enqueueObservationDenormJob(params);
    return decision;
  }

  private async enqueueObservationDenormJob(params: {
    userId: string;
    chatId: string | null;
    observationId: string;
    source: GlobalSpammerObservationSource;
    reason: string;
    userLabel?: string | null;
    observedAt: Date;
    fastPath?: boolean;
  }): Promise<boolean> {
    if (!this.observationDenormQueueEnabled || !this.observationDenormQueue) {
      return false;
    }

    const payload: GlobalSpammerDenormJob = {
      userId: params.userId,
      chatId: params.chatId,
      observationId: params.observationId,
      source: params.source,
      reason: params.reason,
      userLabel: params.userLabel ?? null,
      observedAt: params.observedAt.toISOString(),
      fastPath: params.fastPath === true,
      createdAt: new Date().toISOString(),
    };
    const deduplicationId = buildGlobalSpammerDenormDeduplicationId(params.userId);

    try {
      await this.observationDenormQueue.add(GLOBAL_SPAMMER_DENORM_JOB_NAME, payload, {
        attempts: GLOBAL_SPAMMER_DENORM_JOB_ATTEMPTS,
        backoff: {
          type: 'fixed',
          delay: GLOBAL_SPAMMER_DENORM_JOB_BACKOFF_MS,
        },
        deduplication: {
          id: deduplicationId,
          keepLastIfActive: true,
        },
        removeOnComplete: true,
        removeOnFail: 1_000,
      });
      this.recordSpammerReadModelEvent(
        params.fastPath === true ? 'denorm_fast_path_enqueued' : 'denorm_job_enqueued',
      );
      return true;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.toLowerCase().includes('job') && message.toLowerCase().includes('exists')) {
        this.recordSpammerReadModelEvent(
          params.fastPath === true ? 'denorm_fast_path_enqueued' : 'denorm_job_enqueued',
        );
        return true;
      }
      this.recordSpammerReadModelEvent('denorm_job_enqueue_failed');
      this.logger.warn(
        {
          userId: params.userId,
          chatId: params.chatId,
          source: params.source,
          error: message,
        },
        'Failed to enqueue global spammer denorm job',
      );
      return false;
    }
  }

  private buildRuntimeProfileSnapshotFromDecision(params: {
    decision: GlobalSpammerPolicyDecision;
    activeSuppression?: GlobalSpammerSuppressionRow | null;
    registry?: GlobalSpammerRow | null;
    candidate?: GlobalSpammerCandidateRow | null;
    now: Date;
  }): RuntimeProfileSnapshot {
    const decision = params.decision;
    const expiresAt =
      decision.registryStatus === 'ACTIVE_CONFIRMED'
        ? (params.registry?.expiresAt?.toISOString() ?? decision.expiresAt)
        : decision.registryStatus === 'EXPIRED'
          ? (params.registry?.expiresAt?.toISOString() ?? decision.expiresAt)
          : null;
    const suppressedUntil =
      decision.registryStatus === 'SUPPRESSED'
        ? (params.activeSuppression?.suppressedUntil.toISOString() ?? decision.expiresAt)
        : (params.candidate?.suppressedUntil?.toISOString() ?? null);
    const staleAfter = this.resolveRuntimeProfileStaleAfter({
      status: decision.registryStatus,
      expiresAt,
      suppressedUntil,
      now: params.now,
    });
    return {
      userId: decision.userId,
      registryStatus: decision.registryStatus,
      action: decision.registryStatus === 'ACTIVE_CONFIRMED' ? 'DELETE_AND_KICK' : 'NONE',
      confidenceScore: decision.confidenceScore,
      shadowScore: decision.shadowScore,
      policyBand: decision.policyBand,
      reason: decision.reason,
      expiresAt,
      suppressedUntil,
      sourceBreakdown: decision.sourceBreakdown,
      campaignBreakdown: decision.campaignBreakdown,
      sourceVersion: RUNTIME_PROFILE_SOURCE_VERSION,
      staleAfter: staleAfter.toISOString(),
      updatedAt: params.now.toISOString(),
    };
  }

  private resolveRuntimeProfileStaleAfter(params: {
    status: GlobalSpammerRegistryStatus;
    expiresAt: string | null;
    suppressedUntil: string | null;
    now: Date;
  }): Date {
    const statusDeadline =
      params.status === 'ACTIVE_CONFIRMED'
        ? params.expiresAt
        : params.status === 'SUPPRESSED'
          ? params.suppressedUntil
          : null;
    if (statusDeadline) {
      const parsed = new Date(statusDeadline);
      if (Number.isFinite(parsed.getTime()) && parsed > params.now) {
        return parsed;
      }
    }
    return new Date(params.now.getTime() + RUNTIME_PROFILE_DEFAULT_STALE_MS);
  }

  private buildPolicyRiskContextFromDiagnostics(params: {
    campaigns: GlobalSpammerUserDiagnostics['campaigns'];
    latestShadowScore: GlobalSpammerUserDiagnostics['latestShadowScore'];
  }): PolicyDecisionRiskContext {
    return {
      shadowScore:
        typeof params.latestShadowScore?.v2Score === 'number'
          ? this.roundScore(params.latestShadowScore.v2Score)
          : null,
      campaignBreakdown: this.buildCampaignBreakdownObject(params.campaigns),
    };
  }

  private resolveDecisionPolicyBand(
    registryStatus: GlobalSpammerRegistryStatus,
    confidenceScore: number | null,
    shadowScore: number | null,
  ): GlobalSpammerPolicyBand {
    if (registryStatus === 'ACTIVE_CONFIRMED') {
      return 'CONFIRMED';
    }
    if (
      registryStatus === 'ADMIN_EXEMPT' ||
      registryStatus === 'SUPPRESSED' ||
      registryStatus === 'EXPIRED'
    ) {
      return 'LOW';
    }
    return this.resolvePolicyBand(Math.max(confidenceScore ?? 0, shadowScore ?? 0));
  }

  private async recordPolicyDecision(params: {
    decision: GlobalSpammerPolicyDecision;
    messageId: string | null;
  }): Promise<void> {
    const decision = params.decision;
    await this.prisma.globalSpammerEnforcementDecision.create({
      data: {
        userId: decision.userId,
        chatId: decision.chatId,
        messageId: params.messageId,
        trigger: decision.trigger,
        registryStatus: decision.registryStatus,
        decision: decision.action,
        enforcementMode: decision.enforcementMode,
        policyBand: decision.policyBand,
        deleteSpammersEnabled: decision.deleteSpammersEnabled,
        adminExempt: decision.adminExempt,
        shadow: decision.shadow,
        wouldEnforce: decision.wouldEnforce,
        enforced: decision.enforced,
        confidenceScore: decision.confidenceScore,
        shadowScore: decision.shadowScore,
        reason: decision.reason,
        expiresAt: decision.expiresAt ? new Date(decision.expiresAt) : null,
        sourceBreakdown: decision.sourceBreakdown ?? Prisma.JsonNull,
        campaignBreakdown: decision.campaignBreakdown ?? Prisma.JsonNull,
      },
    });
  }

  private async resolveRecentSuppressionThresholdAdjustment(
    userId: string,
    now: Date,
  ): Promise<number> {
    const recentSuppression = await this.prisma.globalSpammerSuppression.findFirst({
      where: {
        userId,
        suppressedUntil: {
          gte: new Date(now.getTime() - RECENT_SUPPRESSION_MEMORY_DAYS * DAY_MS),
        },
      },
      orderBy: {
        suppressedUntil: 'desc',
      },
    });
    return recentSuppression ? 0.08 : 0;
  }

  private buildObservationLedgerMetadata(params: {
    input: GlobalSpammerObservationInput;
    score: number;
    confidenceLevel: GlobalSpammerConfidenceLevel;
    ttlDays: number;
    observedAt: Date;
    expiresAt: Date;
    evidenceHash: string;
  }): ObservationLedgerMetadata {
    const evidence = this.asRecord(params.input.evidence);
    const flattenedValues = this.collectEvidenceStrings(params.input.evidence);
    const domains = new Set<string>();
    const urls = new Set<string>();
    const phoneHashes = new Set<string>();
    for (const value of flattenedValues) {
      for (const domain of this.extractDomains(value)) {
        domains.add(domain);
      }
      for (const url of this.extractUrls(value)) {
        urls.add(url);
      }
      for (const phone of this.extractPhones(value)) {
        phoneHashes.add(this.buildEvidenceHash(phone));
      }
    }

    const text =
      this.readString(evidence?.excerpt) ||
      this.readString(evidence?.text) ||
      this.readString(evidence?.messageText);
    const normalizedText = text ? this.normalizeGraphText(text) : null;
    const campaignValue =
      this.readString(evidence?.campaignId) ||
      this.readString(evidence?.campaignKey) ||
      this.readString(evidence?.campaignHash) ||
      this.readString(this.asRecord(evidence?.campaignContext)?.campaignKey) ||
      this.readString(this.asRecord(evidence?.campaignContext)?.signature);
    const uniqueChats = this.readNumber(evidence?.uniqueChats);
    const windowSec = this.readNumber(evidence?.windowSec);
    const repeatedLinkDistinctChatCount = this.readNumber(evidence?.repeatedLinkDistinctChatCount);
    const repeatedPhoneDistinctChatCount = this.readNumber(
      evidence?.repeatedPhoneDistinctChatCount,
    );
    const mediaSignatures = this.extractMediaSignatures(params.input.evidence);
    const privacyClass: SpammerPrivacyClass =
      phoneHashes.size > 0 || mediaSignatures.length > 0
        ? 'HIGH_SENSITIVITY'
        : normalizedText
          ? 'SENSITIVE_TEXT'
          : 'STANDARD';
    const rawEvidenceExpiresAt =
      privacyClass === 'STANDARD'
        ? null
        : new Date(params.observedAt.getTime() + RAW_EVIDENCE_RETENTION_DAYS * DAY_MS);
    const normalizedFeatures: Prisma.InputJsonObject = {
      source: params.input.source,
      reason: params.input.reason,
      score: this.roundScore(params.score),
      confidenceLevel: params.confidenceLevel,
      evidenceHash: params.evidenceHash,
      ttlDays: params.ttlDays,
      observedAt: params.observedAt.toISOString(),
      expiresAt: params.expiresAt.toISOString(),
      domains: [...domains].slice(0, 10),
      urls: [...urls].slice(0, 10),
      phoneHashes: [...phoneHashes].slice(0, 10),
      textSignature: normalizedText ? this.buildEvidenceHash(normalizedText) : null,
      campaignHash: campaignValue ? this.buildEvidenceHash(campaignValue) : null,
      mediaSignatures,
      fanout: {
        uniqueChats: uniqueChats ?? null,
        windowSec: windowSec ?? null,
        repeatedLinkDistinctChatCount: repeatedLinkDistinctChatCount ?? null,
        repeatedPhoneDistinctChatCount: repeatedPhoneDistinctChatCount ?? null,
      },
    };

    return {
      normalizedFeatures,
      explainReason: this.buildObservationExplainReason({
        input: params.input,
        confidenceLevel: params.confidenceLevel,
        domainsCount: domains.size,
        urlsCount: urls.size,
        phonesCount: phoneHashes.size,
        hasTextSignature: Boolean(normalizedText),
        hasCampaign: Boolean(campaignValue),
        mediaCount: mediaSignatures.length,
      }),
      privacyClass,
      rawEvidenceExpiresAt,
    };
  }

  private buildObservationExplainReason(params: {
    input: GlobalSpammerObservationInput;
    confidenceLevel: GlobalSpammerConfidenceLevel;
    domainsCount: number;
    urlsCount: number;
    phonesCount: number;
    hasTextSignature: boolean;
    hasCampaign: boolean;
    mediaCount: number;
  }): string {
    const features = [
      params.domainsCount > 0 ? `${params.domainsCount} domain` : null,
      params.urlsCount > 0 ? `${params.urlsCount} url` : null,
      params.phonesCount > 0 ? `${params.phonesCount} phone` : null,
      params.hasTextSignature ? 'text signature' : null,
      params.hasCampaign ? 'campaign key' : null,
      params.mediaCount > 0 ? `${params.mediaCount} media signature` : null,
    ].filter((value): value is string => Boolean(value));
    const featureText = features.length > 0 ? `; features=${features.join(', ')}` : '';
    return `${params.input.source}:${params.input.reason}; confidence=${params.confidenceLevel}${featureText}`;
  }

  private async recordCampaignClustersForObservation(params: {
    userId: string;
    input: GlobalSpammerObservationInput;
    observationId: string;
    observedAt: Date;
    score: number;
    incrementExisting?: boolean;
  }): Promise<CampaignClusterSummary[]> {
    const signals = this.extractCampaignSignals(params.input);
    if (signals.length === 0) {
      return [];
    }

    const summaries: CampaignClusterSummary[] = [];
    for (const signal of signals) {
      try {
        const summary = await this.recordCampaignClusterSignal({
          ...params,
          signal,
        });
        if (summary) {
          summaries.push(summary);
        }
      } catch (error: unknown) {
        this.logger.warn(
          {
            userId: params.userId,
            signalType: signal.signalType,
            error: error instanceof Error ? error.message : String(error),
          },
          'Failed to record spammer campaign cluster signal',
        );
      }
    }
    return summaries;
  }

  private async recordCampaignClusterSignal(params: {
    userId: string;
    input: GlobalSpammerObservationInput;
    observationId: string;
    observedAt: Date;
    score: number;
    signal: ExtractedCampaignSignal;
    incrementExisting?: boolean;
  }): Promise<CampaignClusterSummary | null> {
    const signalHash = this.buildEvidenceHash({
      type: params.signal.signalType,
      value: params.signal.value,
    });
    const clusterKey = `${params.signal.signalType}:${signalHash}`;
    const expiresAt = new Date(params.observedAt.getTime() + GRAPH_SIGNAL_TTL_DAYS * DAY_MS);
    const initialScore = this.resolveCampaignClusterScore({
      signalScore: params.signal.score,
      distinctUsers: 1,
      distinctChats: params.input.chatId ? 1 : 0,
      observationsCount: 1,
    });
    const sourceBreakdown = {
      [params.signal.source]: {
        score: this.roundScore(params.signal.score),
        latestAt: params.observedAt.toISOString(),
        reasons: [params.signal.reason],
      },
    } satisfies Prisma.InputJsonObject;
    const incrementExisting = params.incrementExisting !== false;
    const cluster = await this.prisma.spammerCampaignCluster.upsert({
      where: {
        clusterKey,
      },
      create: {
        clusterKey,
        signalType: params.signal.signalType,
        signalHash,
        signalValuePreview: params.signal.preview,
        status: this.resolveCampaignClusterStatus(initialScore, 1, params.input.chatId ? 1 : 0),
        confidenceScore: initialScore,
        firstSeenAt: params.observedAt,
        lastSeenAt: params.observedAt,
        lastObservationId: params.observationId,
        distinctUsersCount: 1,
        distinctChatsCount: params.input.chatId ? 1 : 0,
        observationsCount: 1,
        sourceBreakdown,
        expiresAt,
      },
      update: {
        signalValuePreview: params.signal.preview,
        lastSeenAt: params.observedAt,
        lastObservationId: params.observationId,
        ...(incrementExisting ? { observationsCount: { increment: 1 } } : {}),
        expiresAt,
      },
    });

    await this.prisma.spammerCampaignClusterMember.upsert({
      where: {
        clusterId_userId: {
          clusterId: cluster.id,
          userId: params.userId,
        },
      },
      create: {
        clusterId: cluster.id,
        userId: params.userId,
        chatId: params.input.chatId ?? null,
        firstSeenAt: params.observedAt,
        lastSeenAt: params.observedAt,
        lastObservationId: params.observationId,
        lastSource: params.signal.source,
        lastReason: params.signal.reason,
        lastScore: this.roundScore(params.score),
        memberScore: this.roundScore(params.signal.score),
        observationsCount: 1,
      },
      update: {
        chatId: params.input.chatId ?? null,
        lastSeenAt: params.observedAt,
        ...(incrementExisting ? { observationsCount: { increment: 1 } } : {}),
        lastObservationId: params.observationId,
        lastSource: params.signal.source,
        lastReason: params.signal.reason,
        lastScore: this.roundScore(params.score),
        memberScore: this.roundScore(params.signal.score),
      },
    });

    const members = await this.prisma.spammerCampaignClusterMember.findMany({
      where: {
        clusterId: cluster.id,
      },
      select: {
        userId: true,
        chatId: true,
      },
      take: 500,
    });
    const distinctUsers = new Set(members.map((member) => member.userId)).size;
    const distinctChats = new Set(
      members.map((member) => member.chatId).filter((value): value is string => Boolean(value)),
    ).size;
    const observationsCount = Math.max(cluster.observationsCount ?? 1, members.length);
    const confidenceScore = this.resolveCampaignClusterScore({
      signalScore: params.signal.score,
      distinctUsers,
      distinctChats,
      observationsCount,
    });
    const status = this.resolveCampaignClusterStatus(confidenceScore, distinctUsers, distinctChats);
    const updatedCluster = await this.prisma.spammerCampaignCluster.update({
      where: {
        id: cluster.id,
      },
      data: {
        confidenceScore,
        status,
        lastSeenAt: params.observedAt,
        distinctUsersCount: distinctUsers,
        distinctChatsCount: distinctChats,
        sourceBreakdown,
      },
    });

    return {
      clusterId: updatedCluster.id,
      clusterKey,
      signalType: params.signal.signalType,
      signalHash,
      status: updatedCluster.status,
      confidenceScore: this.roundScore(updatedCluster.confidenceScore),
      distinctUsersCount: updatedCluster.distinctUsersCount,
      distinctChatsCount: updatedCluster.distinctChatsCount,
      observationsCount: updatedCluster.observationsCount,
      scoreContribution: this.resolveCampaignScoreContribution({
        confidenceScore: updatedCluster.confidenceScore,
        status: updatedCluster.status,
        distinctUsersCount: updatedCluster.distinctUsersCount,
        distinctChatsCount: updatedCluster.distinctChatsCount,
        observationsCount: updatedCluster.observationsCount,
      }),
      reason: params.signal.reason,
      preview: updatedCluster.signalValuePreview,
    };
  }

  private resolveCampaignClusterScore(params: {
    signalScore: number;
    distinctUsers: number;
    distinctChats: number;
    observationsCount: number;
  }): number {
    const spread = Math.max(params.distinctUsers, params.distinctChats, params.observationsCount);
    const lift = Math.min(0.28, Math.max(0, spread - 1) * 0.045);
    return this.roundScore(params.signalScore + lift);
  }

  private resolveCampaignClusterStatus(
    confidenceScore: number,
    distinctUsers: number,
    distinctChats: number,
  ): string {
    if (
      confidenceScore >= HIGH_CONFIDENCE_THRESHOLD &&
      (distinctUsers >= 3 || distinctChats >= 3)
    ) {
      return 'CONFIRMED';
    }
    if (distinctUsers >= 2 || distinctChats >= 2 || confidenceScore >= HIGH_REVIEW_THRESHOLD) {
      return 'ACTIVE';
    }
    return 'SUSPECTED';
  }

  private resolveCampaignScoreContribution(params: {
    confidenceScore: number;
    status: string;
    distinctUsersCount: number;
    distinctChatsCount: number;
    observationsCount: number;
  }): number {
    const linkedScope = Math.max(params.distinctUsersCount, params.distinctChatsCount);
    if (linkedScope < 2) {
      return params.observationsCount >= 3 && params.confidenceScore >= HIGH_REVIEW_THRESHOLD
        ? 0.02
        : 0;
    }
    if (params.status === 'CONFIRMED' || params.confidenceScore >= HIGH_CONFIDENCE_THRESHOLD) {
      return 0.12;
    }
    if (params.status === 'ACTIVE' || params.confidenceScore >= HIGH_REVIEW_THRESHOLD) {
      return 0.08;
    }
    if (params.confidenceScore >= MEDIUM_CONFIDENCE_THRESHOLD) {
      return 0.04;
    }
    return 0.02;
  }

  private async recordShadowScoreForObservation(params: {
    userId: string;
    input: GlobalSpammerObservationInput;
    observationId: string;
    aggregate: AggregateResult;
    campaignSummaries: readonly CampaignClusterSummary[];
    activeSuppression: boolean;
    skipExistingObservation?: boolean;
  }): Promise<ShadowScoreSummary | null> {
    try {
      const summary = this.buildShadowScoreSummary(params.aggregate, params.campaignSummaries, {
        activeSuppression: params.activeSuppression,
      });
      if (params.skipExistingObservation) {
        const existing = await this.prisma.globalSpammerShadowScore.findFirst({
          where: {
            userId: params.userId,
            observationId: params.observationId,
          },
          orderBy: {
            createdAt: 'desc',
          },
        });
        if (existing) {
          return summary;
        }
      }
      await this.prisma.globalSpammerShadowScore.create({
        data: {
          userId: params.userId,
          chatId: params.input.chatId ?? null,
          messageId: params.input.messageId ?? null,
          observationId: params.observationId,
          trigger: params.input.source,
          currentScore: summary.currentScore,
          v2Score: summary.v2Score,
          scoreDelta: summary.scoreDelta,
          currentBand: summary.currentBand,
          v2Band: summary.v2Band,
          wouldPromote: summary.wouldPromote,
          wouldSuppress: summary.wouldSuppress,
          sourceBreakdown: params.aggregate.sourceBreakdown,
          campaignBreakdown: summary.campaignBreakdown,
        },
      });
      return summary;
    } catch (error: unknown) {
      this.logger.warn(
        {
          userId: params.userId,
          error: error instanceof Error ? error.message : String(error),
        },
        'Failed to record global spammer shadow score',
      );
      return null;
    }
  }

  private buildShadowScoreSummary(
    aggregate: AggregateResult,
    campaignSummaries: readonly CampaignClusterSummary[],
    options: { activeSuppression: boolean } = { activeSuppression: false },
  ): ShadowScoreSummary {
    const campaignBoost = Math.min(
      0.16,
      campaignSummaries.reduce((sum, campaign) => sum + campaign.scoreContribution, 0),
    );
    const v2Score = this.roundScore(aggregate.score + campaignBoost);
    const currentBand = this.resolvePolicyBand(aggregate.score);
    const v2Band = this.resolvePolicyBand(v2Score);
    const campaignBreakdown: Record<string, Prisma.InputJsonValue> = {};
    for (const campaign of campaignSummaries.slice(0, 8)) {
      campaignBreakdown[campaign.clusterId] = {
        clusterKey: campaign.clusterKey,
        signalType: campaign.signalType,
        status: campaign.status,
        confidenceScore: campaign.confidenceScore,
        distinctUsersCount: campaign.distinctUsersCount,
        distinctChatsCount: campaign.distinctChatsCount,
        observationsCount: campaign.observationsCount,
        scoreContribution: campaign.scoreContribution,
        reason: campaign.reason,
        preview: campaign.preview,
      };
    }

    return {
      currentScore: aggregate.score,
      v2Score,
      scoreDelta: this.roundScore(v2Score - aggregate.score),
      currentBand,
      v2Band,
      wouldPromote:
        aggregate.score < HIGH_CONFIDENCE_THRESHOLD &&
        v2Score >= HIGH_CONFIDENCE_THRESHOLD &&
        !options.activeSuppression,
      wouldSuppress:
        options.activeSuppression ||
        (aggregate.score >= MEDIUM_CONFIDENCE_THRESHOLD && v2Score < MEDIUM_CONFIDENCE_THRESHOLD),
      campaignBreakdown: campaignBreakdown as Prisma.InputJsonObject,
    };
  }

  private resolvePolicyBand(score: number): GlobalSpammerPolicyBand {
    if (score >= CONFIRMED_CONFIDENCE_THRESHOLD) {
      return 'CONFIRMED';
    }
    if (score >= VERY_HIGH_CONFIDENCE_THRESHOLD) {
      return 'VERY_HIGH';
    }
    if (score >= HIGH_REVIEW_THRESHOLD) {
      return 'HIGH';
    }
    if (score >= MEDIUM_CONFIDENCE_THRESHOLD) {
      return 'MEDIUM';
    }
    return 'LOW';
  }

  private extractCampaignSignals(input: GlobalSpammerObservationInput): ExtractedCampaignSignal[] {
    const evidence = this.asRecord(input.evidence);
    const flattenedValues = this.collectEvidenceStrings(input.evidence);
    const signals: ExtractedCampaignSignal[] = [];
    const domains = new Set<string>();
    const urls = new Set<string>();
    const phones = new Set<string>();
    for (const value of flattenedValues) {
      for (const domain of this.extractDomains(value)) {
        domains.add(domain);
      }
      for (const url of this.extractUrls(value)) {
        urls.add(url);
      }
      for (const phone of this.extractPhones(value)) {
        phones.add(phone);
      }
    }
    for (const domain of domains) {
      signals.push({
        signalType: 'DOMAIN',
        source: 'GRAPH_DOMAIN',
        value: domain,
        preview: domain,
        reason: 'CAMPAIGN_DOMAIN_REUSE',
        score: 0.58,
        evidence: { domain },
      });
    }
    for (const url of urls) {
      signals.push({
        signalType: 'URL',
        source: 'GRAPH_DOMAIN',
        value: url,
        preview: url,
        reason: 'CAMPAIGN_URL_REUSE',
        score: 0.62,
        evidence: { url },
      });
    }
    for (const phone of phones) {
      const phoneHash = this.buildEvidenceHash(phone);
      signals.push({
        signalType: 'PHONE',
        source: 'GRAPH_PHONE',
        value: phoneHash,
        preview: phoneHash,
        reason: 'CAMPAIGN_PHONE_REUSE',
        score: 0.68,
        evidence: { phoneHash },
      });
    }

    const text = this.normalizeGraphText(
      this.readString(evidence?.excerpt) ||
        this.readString(evidence?.text) ||
        this.readString(evidence?.messageText) ||
        '',
    );
    if (text) {
      const textSignature = this.buildEvidenceHash(text);
      signals.push({
        signalType: 'TEXT_SIGNATURE',
        source: 'GRAPH_TEXT',
        value: textSignature,
        preview: null,
        reason: 'CAMPAIGN_TEXT_SIGNATURE_REUSE',
        score: 0.58,
        evidence: { textSignature },
      });
    }

    const campaignValue =
      this.readString(evidence?.campaignId) ||
      this.readString(evidence?.campaignKey) ||
      this.readString(evidence?.campaignHash) ||
      this.readString(this.asRecord(evidence?.campaignContext)?.campaignKey) ||
      this.readString(this.asRecord(evidence?.campaignContext)?.signature);
    if (campaignValue) {
      const campaignHash = this.buildEvidenceHash(campaignValue);
      signals.push({
        signalType: 'CAMPAIGN',
        source: 'GRAPH_CAMPAIGN',
        value: campaignHash,
        preview: campaignHash,
        reason: 'CAMPAIGN_KEY_REUSE',
        score: 0.72,
        evidence: { campaignHash },
      });
    }

    for (const mediaSignature of this.extractMediaSignatures(input.evidence)) {
      signals.push({
        signalType: 'MEDIA_SIGNATURE',
        source: 'GRAPH_CAMPAIGN',
        value: mediaSignature,
        preview: mediaSignature,
        reason: 'CAMPAIGN_MEDIA_SIGNATURE_REUSE',
        score: 0.64,
        evidence: { mediaSignature },
      });
    }

    const uniqueChats = this.readNumber(evidence?.uniqueChats);
    const windowSec = this.readNumber(evidence?.windowSec);
    if (input.source.startsWith('FANOUT_') && uniqueChats && windowSec) {
      signals.push({
        signalType: 'FANOUT_PATTERN',
        source: 'GRAPH_FANOUT_PATTERN',
        value: `${input.reason}:${Math.floor(uniqueChats)}:${Math.floor(windowSec)}`,
        preview: `${Math.floor(uniqueChats)} chats/${Math.floor(windowSec)}s`,
        reason: 'CAMPAIGN_FANOUT_PATTERN_REUSE',
        score: 0.56,
        evidence: { uniqueChats, windowSec, source: input.source },
      });
    }

    return signals.slice(0, 12);
  }

  private async listTopCampaigns(params: {
    since: Date;
    chatId?: string | null;
    limit: number;
  }): Promise<
    Array<{
      clusterId: string;
      signalType: string;
      status: string;
      confidenceScore: number;
      distinctUsersCount: number;
      distinctChatsCount: number;
      observationsCount: number;
      userObservationsCount: number | null;
      lastSeenAt: string;
      preview: string | null;
    }>
  > {
    const limit = Math.max(1, Math.min(params.limit, 20));
    const rows = params.chatId
      ? await this.listTopCampaignsForChat({
          chatId: params.chatId,
          since: params.since,
          limit,
        })
      : await this.prisma.spammerCampaignCluster.findMany({
          where: {
            lastSeenAt: {
              gte: params.since,
            },
          },
          orderBy: [
            { confidenceScore: 'desc' },
            { observationsCount: 'desc' },
            { lastSeenAt: 'desc' },
          ],
          take: limit,
        });
    return rows.map((row) => ({
      clusterId: row.id,
      signalType: row.signalType,
      status: row.status,
      confidenceScore: this.roundScore(row.confidenceScore),
      distinctUsersCount: row.distinctUsersCount,
      distinctChatsCount: row.distinctChatsCount,
      observationsCount: row.observationsCount,
      userObservationsCount: null,
      lastSeenAt: row.lastSeenAt.toISOString(),
      preview: row.signalValuePreview,
    }));
  }

  private async listTopCampaignsForChat(params: {
    chatId: string;
    since: Date;
    limit: number;
  }): Promise<TopCampaignRow[]> {
    return this.prisma.$queryRaw<TopCampaignRow[]>(Prisma.sql`
      SELECT
        cluster.id,
        cluster.signal_type AS "signalType",
        cluster.status,
        cluster.confidence_score AS "confidenceScore",
        cluster.distinct_users_count AS "distinctUsersCount",
        cluster.distinct_chats_count AS "distinctChatsCount",
        cluster.observations_count AS "observationsCount",
        cluster.last_seen_at AS "lastSeenAt",
        cluster.signal_value_preview AS "signalValuePreview"
      FROM (
        SELECT DISTINCT member.cluster_id
        FROM spammer_campaign_cluster_members member
        WHERE member.chat_id = ${params.chatId}
          AND member.last_seen_at >= ${params.since}
      ) scoped_campaigns
      INNER JOIN spammer_campaign_clusters cluster ON cluster.id = scoped_campaigns.cluster_id
      WHERE cluster.last_seen_at >= ${params.since}
      ORDER BY
        cluster.confidence_score DESC,
        cluster.observations_count DESC,
        cluster.last_seen_at DESC
      LIMIT ${params.limit}
    `);
  }

  private async listUserCampaignDiagnostics(userId: string): Promise<
    Array<{
      clusterId: string;
      signalType: string;
      status: string;
      confidenceScore: number;
      distinctUsersCount: number;
      distinctChatsCount: number;
      observationsCount: number;
      userObservationsCount: number | null;
      lastSeenAt: string;
      preview: string | null;
    }>
  > {
    const rows = await this.prisma.spammerCampaignClusterMember.findMany({
      where: {
        userId,
      },
      orderBy: {
        lastSeenAt: 'desc',
      },
      take: 10,
      include: {
        cluster: true,
      },
    });
    return rows.map((row) => ({
      clusterId: row.cluster.id,
      signalType: row.cluster.signalType,
      status: row.cluster.status,
      confidenceScore: this.roundScore(row.cluster.confidenceScore),
      distinctUsersCount: row.cluster.distinctUsersCount,
      distinctChatsCount: row.cluster.distinctChatsCount,
      observationsCount: row.cluster.observationsCount,
      userObservationsCount: Math.max(1, row.observationsCount ?? 1),
      lastSeenAt: row.cluster.lastSeenAt.toISOString(),
      preview: row.cluster.signalValuePreview,
    }));
  }

  private async getLatestShadowScoreDiagnostics(
    userId: string,
  ): Promise<GlobalSpammerUserDiagnostics['latestShadowScore']> {
    const row = await this.prisma.globalSpammerShadowScore.findFirst({
      where: {
        userId,
      },
      orderBy: {
        createdAt: 'desc',
      },
    });
    if (!row) {
      return null;
    }
    return {
      currentScore: this.roundScore(row.currentScore),
      v2Score: this.roundScore(row.v2Score),
      scoreDelta: this.roundScore(row.scoreDelta),
      currentBand: row.currentBand,
      v2Band: row.v2Band,
      wouldPromote: row.wouldPromote,
      wouldSuppress: row.wouldSuppress,
      createdAt: row.createdAt.toISOString(),
    };
  }

  private async buildCampaignBreakdownForUser(userId: string): Promise<Prisma.InputJsonObject> {
    const campaigns = await this.listUserCampaignDiagnostics(userId);
    return this.buildCampaignBreakdownObject(campaigns);
  }

  private buildCampaignBreakdownObject(
    campaigns: GlobalSpammerUserDiagnostics['campaigns'],
  ): Prisma.InputJsonObject {
    const breakdown: Record<string, Prisma.InputJsonValue> = {};
    for (const campaign of campaigns) {
      breakdown[campaign.clusterId] = campaign;
    }
    return breakdown as Prisma.InputJsonObject;
  }

  private async recordReviewFeedback(params: {
    userId: string;
    chatId: string;
    reviewerUserId: string;
    action: CandidateReviewAction;
    reason: string;
    candidateBefore: {
      status?: string | null;
      confidenceScore?: number | null;
      sourceBreakdown?: Prisma.JsonValue | null;
    } | null;
    campaignBreakdown: Prisma.InputJsonObject;
  }): Promise<void> {
    await this.prisma.globalSpammerReviewFeedback.create({
      data: {
        userId: params.userId,
        chatId: params.chatId,
        reviewerUserId: params.reviewerUserId,
        action: params.action,
        reason: params.reason,
        candidateStatusBefore: params.candidateBefore?.status ?? null,
        confidenceScoreBefore:
          typeof params.candidateBefore?.confidenceScore === 'number'
            ? this.roundScore(params.candidateBefore.confidenceScore)
            : null,
        sourceBreakdown: params.candidateBefore?.sourceBreakdown ?? {},
        campaignBreakdown: params.campaignBreakdown,
      },
    });
  }

  private async markShadowScoresReviewed(params: {
    userId: string;
    action: CandidateReviewAction;
    reviewerUserId: string;
  }): Promise<void> {
    await this.prisma.globalSpammerShadowScore.updateMany({
      where: {
        userId: params.userId,
        humanReviewOutcome: null,
      },
      data: {
        humanReviewOutcome: params.action,
        reviewedAt: new Date(),
        reviewedByUserId: params.reviewerUserId,
      },
    });
  }

  private isGraphObservationSource(source: GlobalSpammerObservationSource): boolean {
    return source.startsWith('GRAPH_');
  }

  private async recordGraphSignalsForObservation(params: {
    userId: string;
    input: GlobalSpammerObservationInput;
    observedAt: Date;
    activeSuppression: { reason: string } | null;
  }): Promise<void> {
    const graphSignals = this.extractGraphSignals(params.input);
    if (graphSignals.length === 0) {
      return;
    }

    for (const signal of graphSignals) {
      await this.recordGraphSignal({
        userId: params.userId,
        input: params.input,
        signal,
        observedAt: params.observedAt,
        activeSuppression: params.activeSuppression,
      });
    }
  }

  private async recordGraphSignal(params: {
    userId: string;
    input: GlobalSpammerObservationInput;
    signal: ExtractedGraphSignal;
    observedAt: Date;
    activeSuppression: { reason: string } | null;
  }): Promise<void> {
    const signalHash = this.buildEvidenceHash({
      type: params.signal.signalType,
      value: params.signal.value,
    });
    const chatId = params.input.chatId ?? null;
    const signalKey = `${params.userId}:${chatId ?? 'global'}:${params.signal.signalType}:${signalHash}`;
    const expiresAt = new Date(params.observedAt.getTime() + GRAPH_SIGNAL_TTL_DAYS * DAY_MS);
    await this.prisma.spammerGraphSignal.upsert({
      where: {
        signalKey,
      },
      create: {
        signalKey,
        userId: params.userId,
        chatId,
        messageId: params.input.messageId ?? null,
        signalType: params.signal.signalType,
        signalHash,
        source: params.signal.source,
        score: params.signal.score,
        evidence: params.signal.evidence,
        observedAt: params.observedAt,
        expiresAt,
      },
      update: {
        messageId: params.input.messageId ?? null,
        source: params.signal.source,
        score: params.signal.score,
        evidence: params.signal.evidence,
        observedAt: params.observedAt,
        expiresAt,
      },
    });

    const activeSignals = await this.prisma.spammerGraphSignal.findMany({
      where: {
        signalType: params.signal.signalType,
        signalHash,
        expiresAt: {
          gt: params.observedAt,
        },
      },
      select: {
        userId: true,
        chatId: true,
      },
      take: 200,
    });
    const distinctUsers = new Set(activeSignals.map((row) => row.userId)).size;
    const distinctChats = new Set(
      activeSignals.map((row) => row.chatId).filter((value): value is string => Boolean(value)),
    ).size;
    const shouldCreateObservation =
      distinctUsers >= 2 || distinctChats >= 2 || activeSignals.length >= 3;
    if (!shouldCreateObservation) {
      return;
    }

    const graphScore = this.resolveGraphObservationScore({
      signal: params.signal,
      distinctUsers,
      distinctChats,
      hits: activeSignals.length,
    });
    const graphEvidenceHash = `graph:${params.signal.signalType.toLowerCase()}:${signalHash}`;
    const graphEvidence: Prisma.InputJsonObject = {
      ...params.signal.evidence,
      distinctUsers,
      distinctChats,
      hits: activeSignals.length,
    };
    const graphExpiresAt = new Date(
      params.observedAt.getTime() + GRAPH_OBSERVATION_TTL_DAYS * DAY_MS,
    );
    const graphConfidenceLevel = this.resolveConfidenceLevel(graphScore);
    const graphLedgerMetadata = this.buildObservationLedgerMetadata({
      input: {
        userId: params.userId,
        source: params.signal.source,
        score: graphScore,
        reason: params.signal.reason,
        chatId,
        messageId: params.input.messageId ?? null,
        evidence: graphEvidence,
        evidenceHash: graphEvidenceHash,
        observedAt: params.observedAt,
        ttlDays: GRAPH_OBSERVATION_TTL_DAYS,
      },
      score: graphScore,
      confidenceLevel: graphConfidenceLevel,
      ttlDays: GRAPH_OBSERVATION_TTL_DAYS,
      observedAt: params.observedAt,
      expiresAt: graphExpiresAt,
      evidenceHash: graphEvidenceHash,
    });
    const suppressedAt = params.activeSuppression ? params.observedAt : null;
    const suppressionReason = params.activeSuppression?.reason ?? null;
    await this.prisma.spammerObservation.upsert({
      where: {
        userId_source_evidenceHash: {
          userId: params.userId,
          source: params.signal.source,
          evidenceHash: graphEvidenceHash,
        },
      },
      create: {
        userId: params.userId,
        source: params.signal.source,
        score: graphScore,
        confidenceLevel: graphConfidenceLevel,
        reason: params.signal.reason,
        chatId,
        messageId: params.input.messageId ?? null,
        evidenceHash: graphEvidenceHash,
        evidence: graphEvidence,
        normalizedFeatures: graphLedgerMetadata.normalizedFeatures,
        ttlDays: GRAPH_OBSERVATION_TTL_DAYS,
        explainReason: graphLedgerMetadata.explainReason,
        privacyClass: graphLedgerMetadata.privacyClass,
        rawEvidenceExpiresAt: graphLedgerMetadata.rawEvidenceExpiresAt,
        observedAt: params.observedAt,
        expiresAt: graphExpiresAt,
        suppressedAt,
        suppressionReason,
      },
      update: {
        score: graphScore,
        confidenceLevel: graphConfidenceLevel,
        reason: params.signal.reason,
        chatId,
        messageId: params.input.messageId ?? null,
        evidence: graphEvidence,
        normalizedFeatures: graphLedgerMetadata.normalizedFeatures,
        ttlDays: GRAPH_OBSERVATION_TTL_DAYS,
        explainReason: graphLedgerMetadata.explainReason,
        privacyClass: graphLedgerMetadata.privacyClass,
        rawEvidenceExpiresAt: graphLedgerMetadata.rawEvidenceExpiresAt,
        observedAt: params.observedAt,
        expiresAt: graphExpiresAt,
        suppressedAt,
        suppressionReason,
      },
    });
  }

  private resolveGraphObservationScore(params: {
    signal: ExtractedGraphSignal;
    distinctUsers: number;
    distinctChats: number;
    hits: number;
  }): number {
    const lift = Math.min(
      0.14,
      Math.max(params.distinctUsers, params.distinctChats, params.hits) * 0.025,
    );
    return this.roundScore(params.signal.score + lift);
  }

  private extractGraphSignals(input: GlobalSpammerObservationInput): ExtractedGraphSignal[] {
    const evidence = this.asRecord(input.evidence);
    const flattenedValues = this.collectEvidenceStrings(input.evidence);
    const signals: ExtractedGraphSignal[] = [];
    const domains = new Set<string>();
    const phones = new Set<string>();

    for (const value of flattenedValues) {
      for (const domain of this.extractDomains(value)) {
        domains.add(domain);
      }
      for (const phone of this.extractPhones(value)) {
        phones.add(phone);
      }
    }

    for (const domain of domains) {
      signals.push({
        signalType: 'DOMAIN',
        source: 'GRAPH_DOMAIN',
        value: domain,
        reason: 'GRAPH_DOMAIN_REUSE',
        score: 0.58,
        evidence: { domain },
      });
    }
    for (const phone of phones) {
      signals.push({
        signalType: 'PHONE',
        source: 'GRAPH_PHONE',
        value: phone,
        reason: 'GRAPH_PHONE_REUSE',
        score: 0.64,
        evidence: { phoneHash: this.buildEvidenceHash(phone) },
      });
    }

    const text = this.normalizeGraphText(
      this.readString(evidence?.excerpt) ||
        this.readString(evidence?.text) ||
        this.readString(evidence?.messageText) ||
        '',
    );
    if (text) {
      signals.push({
        signalType: 'TEXT',
        source: 'GRAPH_TEXT',
        value: text,
        reason: 'GRAPH_TEXT_REUSE',
        score: 0.54,
        evidence: { textHash: this.buildEvidenceHash(text) },
      });
    }

    const campaignValue =
      this.readString(evidence?.campaignId) ||
      this.readString(evidence?.campaignKey) ||
      this.readString(evidence?.campaignHash) ||
      this.readString(this.asRecord(evidence?.campaignContext)?.campaignKey) ||
      this.readString(this.asRecord(evidence?.campaignContext)?.signature);
    if (campaignValue) {
      signals.push({
        signalType: 'CAMPAIGN',
        source: 'GRAPH_CAMPAIGN',
        value: campaignValue,
        reason: 'GRAPH_CAMPAIGN_REUSE',
        score: 0.7,
        evidence: { campaignHash: this.buildEvidenceHash(campaignValue) },
      });
    }

    const uniqueChats = this.readNumber(evidence?.uniqueChats);
    const windowSec = this.readNumber(evidence?.windowSec);
    if (input.source.startsWith('FANOUT_') && uniqueChats && windowSec) {
      signals.push({
        signalType: 'FANOUT_PATTERN',
        source: 'GRAPH_FANOUT_PATTERN',
        value: `${input.reason}:${Math.floor(uniqueChats)}:${Math.floor(windowSec)}`,
        reason: 'GRAPH_FANOUT_PATTERN_REUSE',
        score: 0.56,
        evidence: { uniqueChats, windowSec, source: input.source },
      });
    }

    return signals.slice(0, 8);
  }

  private collectEvidenceStrings(value: unknown, depth = 0): string[] {
    if (depth > 4 || value === null || value === undefined) {
      return [];
    }
    if (typeof value === 'string') {
      return [value];
    }
    if (typeof value === 'number' || typeof value === 'boolean') {
      return [];
    }
    if (Array.isArray(value)) {
      return value.flatMap((item) => this.collectEvidenceStrings(item, depth + 1));
    }
    if (typeof value === 'object') {
      return Object.values(value as Record<string, unknown>).flatMap((item) =>
        this.collectEvidenceStrings(item, depth + 1),
      );
    }
    return [];
  }

  private extractDomains(value: string): string[] {
    const domains = new Set<string>();
    const urlMatches = value.matchAll(/https?:\/\/([a-z0-9.-]+\.[a-z]{2,})(?:[/:?#]|$)/giu);
    for (const match of urlMatches) {
      const domain = this.normalizeDomain(match[1] ?? '');
      if (domain) {
        domains.add(domain);
      }
    }
    const bareMatches = value.matchAll(
      /\b([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9-]{2,})+)\b/giu,
    );
    for (const match of bareMatches) {
      const domain = this.normalizeDomain(match[1] ?? '');
      if (domain) {
        domains.add(domain);
      }
    }
    return [...domains].slice(0, 5);
  }

  private extractUrls(value: string): string[] {
    const urls = new Set<string>();
    const matches = value.matchAll(/https?:\/\/[^\s<>"')\]]+/giu);
    for (const match of matches) {
      const normalized = this.normalizeUrl(match[0] ?? '');
      if (normalized) {
        urls.add(normalized);
      }
    }
    return [...urls].slice(0, 5);
  }

  private normalizeUrl(value: string): string | null {
    try {
      const parsed = new URL(value.trim());
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return null;
      }
      parsed.hash = '';
      parsed.username = '';
      parsed.password = '';
      parsed.hostname = parsed.hostname.toLowerCase().replace(/^www\./u, '');
      return parsed.toString().slice(0, 512);
    } catch {
      return null;
    }
  }

  private normalizeDomain(value: string): string | null {
    const normalized = value
      .trim()
      .toLowerCase()
      .replace(/^www\./u, '');
    if (!/^[a-z0-9.-]+\.[a-z]{2,}$/u.test(normalized)) {
      return null;
    }
    return normalized;
  }

  private extractPhones(value: string): string[] {
    const phones = new Set<string>();
    const matches = value.matchAll(/(?:\+?\d[\s().-]*){10,15}/gu);
    for (const match of matches) {
      const digits = (match[0] ?? '').replace(/\D/gu, '');
      if (digits.length >= 10 && digits.length <= 15) {
        phones.add(digits);
      }
    }
    return [...phones].slice(0, 5);
  }

  private extractMediaSignatures(value: unknown): string[] {
    const signatures = new Set<string>();
    const visit = (node: unknown, depth = 0): void => {
      if (depth > 5 || node === null || node === undefined) {
        return;
      }
      if (typeof node === 'string') {
        const normalized = node.trim();
        if (
          /(?:media|photo|image|video|file|attachment|upload|hash|sha|md5|cdn)/iu.test(
            normalized,
          ) &&
          normalized.length >= 8
        ) {
          signatures.add(this.buildEvidenceHash(normalized));
        }
        return;
      }
      if (typeof node !== 'object') {
        return;
      }
      if (Array.isArray(node)) {
        for (const item of node) {
          visit(item, depth + 1);
        }
        return;
      }
      for (const [key, item] of Object.entries(node as Record<string, unknown>)) {
        if (
          /(?:media|photo|image|video|file|attachment|upload|hash|sha|md5|cdn)/iu.test(key) &&
          (typeof item === 'string' || typeof item === 'number')
        ) {
          signatures.add(this.buildEvidenceHash(String(item)));
        }
        visit(item, depth + 1);
      }
    };
    visit(value);
    return [...signatures].slice(0, 8);
  }

  private normalizeGraphText(value: string): string | null {
    const normalized = value.trim().toLowerCase().replace(/\s+/gu, ' ');
    if (normalized.length < 24) {
      return null;
    }
    return normalized.slice(0, 500);
  }

  private async findActiveSuppression(userId: string, now: Date) {
    return this.prisma.globalSpammerSuppression.findFirst({
      where: {
        userId,
        suppressedUntil: {
          gt: now,
        },
      },
      orderBy: {
        suppressedUntil: 'desc',
      },
    });
  }

  private async computeAggregateForUser(userId: string, now: Date): Promise<AggregateResult> {
    const rows = await this.prisma.spammerObservation.findMany({
      where: {
        userId,
        expiresAt: {
          gt: now,
        },
        suppressedAt: null,
      },
      orderBy: {
        observedAt: 'desc',
      },
      take: 100,
      select: {
        source: true,
        score: true,
        reason: true,
        observedAt: true,
        expiresAt: true,
      },
    });

    const sourceReputation = await this.getSourceReputationMap(now);
    return this.computeAggregate(rows, now, sourceReputation);
  }

  computeAggregate(
    rows: readonly ActiveObservationRow[],
    now: Date,
    sourceReputation: ReadonlyMap<string, SourceReputation> = new Map(),
  ): AggregateResult {
    const sourceMap = new Map<string, AggregateSource>();
    for (const row of rows) {
      if (row.expiresAt <= now) {
        continue;
      }
      const reputation = sourceReputation.get(row.source);
      const reputationWeight = reputation?.weight ?? this.resolveSourceBaseWeight(row.source);
      const falsePositiveRate = reputation?.falsePositiveRate ?? 0;
      const source = row.source as GlobalSpammerObservationSource;
      const mitigating = MITIGATING_OBSERVATION_SOURCES.has(source);
      const decayedScore = this.calculateDecayedScore(row.score, row.observedAt, now);
      const adjustedScore = this.clampScore(decayedScore * reputationWeight);
      const existing = sourceMap.get(row.source);
      const latestAt =
        existing && Date.parse(existing.latestAt) > row.observedAt.getTime()
          ? existing.latestAt
          : row.observedAt.toISOString();
      const reasons = new Set(existing?.reasons ?? []);
      reasons.add(row.reason);
      sourceMap.set(row.source, {
        source: row.source,
        score: Math.max(existing?.score ?? 0, adjustedScore),
        rawScore: Math.max(existing?.rawScore ?? 0, row.score),
        reputationWeight,
        falsePositiveRate,
        count: (existing?.count ?? 0) + 1,
        latestAt,
        reasons: [...reasons].slice(0, 5),
        mitigating,
      });
    }

    const sources = [...sourceMap.values()]
      .map((source) => this.applyAggregateSourceCaps(source))
      .sort((a, b) => b.score - a.score);
    const positiveSources = sources.filter((source) => !source.mitigating);
    const mitigatingSources = sources.filter((source) => source.mitigating);
    const sourceWeights = [1, 0.22, 0.12, 0.08, 0.05];
    const weightedPositiveScore = positiveSources.reduce(
      (sum, source, index) => sum + source.score * (sourceWeights[index] ?? 0.03),
      0,
    );
    const weightedMitigatingScore = mitigatingSources.reduce(
      (sum, source, index) => sum + source.score * (sourceWeights[index] ?? 0.03),
      0,
    );
    const multiSourceBonus =
      positiveSources.length >= 3 ? 0.07 : positiveSources.length >= 2 ? 0.04 : 0;
    const onlyReputationSources =
      positiveSources.length > 0 &&
      positiveSources.every((source) =>
        REPUTATION_OBSERVATION_SOURCES.has(source.source as GlobalSpammerObservationSource),
      );
    const positiveScore = onlyReputationSources
      ? Math.min(REPUTATION_ONLY_SCORE_CAP, weightedPositiveScore + multiSourceBonus)
      : weightedPositiveScore + multiSourceBonus;
    const score = this.clampScore(
      positiveScore - Math.min(MITIGATING_SCORE_CAP, weightedMitigatingScore),
    );
    const sourceBreakdown: Record<string, Prisma.InputJsonValue> = {};
    for (const source of sources) {
      sourceBreakdown[source.source] = {
        score: this.roundScore(source.score),
        rawScore: this.roundScore(source.rawScore),
        reputationWeight: this.roundScore(source.reputationWeight),
        falsePositiveRate: this.roundScore(source.falsePositiveRate),
        count: source.count,
        latestAt: source.latestAt,
        reasons: source.reasons,
        effect: source.mitigating ? 'mitigating' : 'risk',
        mitigating: source.mitigating,
      };
    }

    return {
      score: this.roundScore(score),
      confidenceLevel: this.resolveConfidenceLevel(score),
      sources,
      sourceBreakdown: sourceBreakdown as Prisma.InputJsonObject,
    };
  }

  private applyAggregateSourceCaps(source: AggregateSource): AggregateSource {
    const typedSource = source.source as GlobalSpammerObservationSource;
    const repeatedSignalLift = Math.min(0.12, Math.max(0, source.count - 1) * 0.035);
    let score = source.score + repeatedSignalLift;
    if (source.mitigating) {
      score = Math.min(MITIGATING_SCORE_CAP, score);
    } else if (REPUTATION_OBSERVATION_SOURCES.has(typedSource)) {
      score = Math.min(REPUTATION_POSITIVE_SCORE_CAP, score);
    }
    return {
      ...source,
      score: this.roundScore(score),
    };
  }

  private canPromoteToRegistry(
    input: GlobalSpammerObservationInput,
    aggregate: AggregateResult,
  ): boolean {
    if (input.forceRegistry) {
      return (
        input.source === 'DEVELOPER_FORCED' ||
        (input.source === 'FANOUT_HIGH' && PROMOTION_FANOUT_REASONS.has(input.reason)) ||
        input.source === 'REVIEW_APPROVED'
      );
    }

    const positiveSources = aggregate.sources.filter((source) => !source.mitigating);
    if (
      positiveSources.length === 0 ||
      positiveSources.every((source) =>
        REPUTATION_OBSERVATION_SOURCES.has(source.source as GlobalSpammerObservationSource),
      )
    ) {
      return false;
    }

    if (
      positiveSources.some(
        (source) =>
          source.source === 'REVIEW_APPROVED' ||
          (source.source === 'FANOUT_HIGH' &&
            source.reasons.some((reason) => PROMOTION_FANOUT_REASONS.has(reason))),
      )
    ) {
      return true;
    }

    const independentBehaviorSources = positiveSources.filter((source) =>
      PROMOTION_BEHAVIOR_SOURCES.has(source.source as GlobalSpammerObservationSource),
    );
    const hasFanoutOnlyBehavior = independentBehaviorSources.every(
      (source) => source.source === 'FANOUT_HIGH' || source.source === 'FANOUT_REPEAT',
    );
    return independentBehaviorSources.length >= 2 && !hasFanoutOnlyBehavior;
  }

  private hasDeveloperForcedSource(sourceBreakdown: unknown): boolean {
    const source = this.asRecord(sourceBreakdown);
    return Boolean(source?.DEVELOPER_FORCED);
  }

  private async resolveLocalAdminDecision(
    userId: string,
    chatId: string | null,
  ): Promise<ResolvedLocalAdminDecision> {
    const userVariants = [...this.buildUserIdVariants(userId)];
    if (!chatId || userVariants.length === 0) {
      return null;
    }

    const adminRows = await this.prisma.chatAdminAllowlist.findMany({
      where: {
        chatId,
      },
      select: {
        userId: true,
      },
    });
    const adminUserVariants = new Set<string>();
    for (const row of adminRows) {
      for (const variant of this.buildUserIdVariants(row.userId)) {
        adminUserVariants.add(variant);
      }
    }
    if (adminUserVariants.size === 0) {
      return null;
    }

    const rows: LocalAdminDecisionRow[] = await this.prisma.adminGlobalSpammerExemption.findMany({
      where: {
        adminUserId: {
          in: [...adminUserVariants],
        },
        userId: {
          in: userVariants,
        },
      },
      select: {
        adminUserId: true,
        userId: true,
        sourceChatId: true,
        decision: true,
        reason: true,
        updatedAt: true,
      },
      orderBy: {
        updatedAt: 'desc',
      },
      take: 50,
    });
    if (rows.length === 0) {
      return null;
    }

    let resolvedDecision: LocalAdminSpammerDecision | null = null;
    let representativeRow: LocalAdminDecisionRow | null = null;
    const decidedByUserIds = new Set<string>();
    for (const row of rows) {
      const decision = this.normalizeLocalAdminDecision(row.decision) ?? 'ALLOW';
      decidedByUserIds.add(row.adminUserId);
      const nextDecision = this.resolveLocalAdminDecisionPrecedence(
        resolvedDecision ?? undefined,
        decision,
      );
      if (nextDecision !== resolvedDecision) {
        resolvedDecision = nextDecision;
        representativeRow = row;
      } else if (
        decision === resolvedDecision &&
        (!representativeRow || row.updatedAt > representativeRow.updatedAt)
      ) {
        representativeRow = row;
      }
    }

    return resolvedDecision && representativeRow
      ? {
          decision: resolvedDecision,
          reason: representativeRow.reason,
          sourceChatId: representativeRow.sourceChatId,
          updatedAt: representativeRow.updatedAt,
          decidedByUserIds: [...decidedByUserIds],
        }
      : null;
  }

  private buildUserIdVariants(value: string | null | undefined): Set<string> {
    if (typeof value !== 'string') {
      return new Set<string>();
    }

    const normalized = value.trim().toLowerCase();
    if (!normalized) {
      return new Set<string>();
    }

    const variants = new Set<string>([normalized]);
    if (normalized.startsWith('id') && normalized.length > 2) {
      variants.add(normalized.slice(2));
    } else {
      variants.add(`id${normalized}`);
    }
    return variants;
  }

  private normalizeLocalAdminDecision(
    value: string | null | undefined,
  ): LocalAdminSpammerDecision | null {
    const normalized = value?.trim().toUpperCase();
    if (normalized === 'ALLOW' || normalized === 'BLOCK' || normalized === 'REVIEW') {
      return normalized;
    }
    return null;
  }

  private resolveLocalAdminDecisionPrecedence(
    current: LocalAdminSpammerDecision | undefined,
    next: LocalAdminSpammerDecision,
  ): LocalAdminSpammerDecision {
    if (!current || current === 'REVIEW') {
      return next;
    }
    if (current === 'ALLOW' || next === 'ALLOW') {
      return 'ALLOW';
    }
    return 'BLOCK';
  }

  private buildReputationSummary(
    observations: ReadonlyArray<{ source: string; expiresAt: Date }>,
    now: Date,
  ): GlobalSpammerUserDiagnostics['reputationSummary'] {
    const activeObservations = observations.filter((row) => row.expiresAt > now);
    const naturalBanSignals = activeObservations.filter(
      (row) => row.source === 'SANCTION_BAN' || row.source === 'MANUAL_BAN',
    ).length;
    const localBlockSignals = activeObservations.filter(
      (row) => row.source === 'LOCAL_ADMIN_BLOCK',
    ).length;
    const localAllowSignals = activeObservations.filter(
      (row) => row.source === 'LOCAL_ADMIN_ALLOW',
    ).length;
    const onlyReputationSignals =
      activeObservations.length > 0 &&
      activeObservations.every((row) =>
        REPUTATION_OBSERVATION_SOURCES.has(row.source as GlobalSpammerObservationSource),
      );
    const note = onlyReputationSignals
      ? 'Есть репутационные сигналы, но сами по себе они не отправляют пользователя в глобальную базу.'
      : localAllowSignals > 0
        ? 'Есть локальное исключение от админа, оно снижает риск и помогает от ложных срабатываний.'
        : 'Репутационные сигналы учитываются как фон, а не как приговор.';

    return {
      naturalBanSignals,
      localBlockSignals,
      localAllowSignals,
      onlyReputationSignals,
      note,
    };
  }

  private calculateDecayedScore(score: number, observedAt: Date, now: Date): number {
    const ageDays = Math.max(0, now.getTime() - observedAt.getTime()) / DAY_MS;
    const decay = Math.pow(0.5, ageDays / OBSERVATION_HALF_LIFE_DAYS);
    return this.clampScore(score * decay);
  }

  private async promoteToRegistry(params: {
    userId: string;
    sourceChatId: string | null;
    reason: string;
    evidence: Prisma.InputJsonValue;
    aggregate: AggregateResult;
    status: GlobalSpammerCandidateStatus;
    reviewedByUserId: string | null;
    reviewReason: string | null;
    registryTtlDays?: number | null;
  }): Promise<void> {
    const now = new Date();
    const ttlDays = Math.max(1, Math.trunc(params.registryTtlDays ?? 30));
    const expiresAt = new Date(now.getTime() + ttlDays * DAY_MS);
    await this.prisma.$transaction([
      this.prisma.globalSpammer.upsert({
        where: {
          userId: params.userId,
        },
        create: {
          userId: params.userId,
          lastReason: params.reason,
          lastChatId: params.sourceChatId,
          lastEvidence: params.evidence,
          confidenceScore: params.aggregate.score,
          confirmedAt: now,
          expiresAt,
          sourceBreakdown: params.aggregate.sourceBreakdown,
        },
        update: {
          detectionsCount: {
            increment: 1,
          },
          lastReason: params.reason,
          lastChatId: params.sourceChatId,
          lastEvidence: params.evidence,
          confidenceScore: params.aggregate.score,
          confirmedAt: now,
          expiresAt,
          sourceBreakdown: params.aggregate.sourceBreakdown,
        },
      }),
      this.prisma.globalSpammerCandidate.upsert({
        where: {
          userId: params.userId,
        },
        create: {
          userId: params.userId,
          status: params.status,
          lastReason: params.reason,
          lastChatId: params.sourceChatId,
          lastEvidence: params.evidence,
          confidenceScore: params.aggregate.score,
          sourceBreakdown: params.aggregate.sourceBreakdown,
          reviewedAt: now,
          reviewedByUserId: params.reviewedByUserId,
          reviewReason: params.reviewReason,
          falsePositive: false,
        },
        update: {
          status: params.status,
          detectionsCount: {
            increment: 1,
          },
          lastReason: params.reason,
          lastChatId: params.sourceChatId,
          lastEvidence: params.evidence,
          confidenceScore: params.aggregate.score,
          sourceBreakdown: params.aggregate.sourceBreakdown,
          reviewedAt: now,
          reviewedByUserId: params.reviewedByUserId,
          reviewReason: params.reviewReason,
          falsePositive: false,
        },
      }),
    ]);
  }

  private async syncDenormRegistry(params: {
    userId: string;
    sourceChatId: string | null;
    reason: string;
    evidence: Prisma.InputJsonValue;
    aggregate: AggregateResult;
    status: GlobalSpammerCandidateStatus;
    reviewedByUserId: string | null;
    reviewReason: string | null;
    detectedAt: Date;
  }): Promise<void> {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 30 * DAY_MS);
    const detectionsCount = this.resolveDenormDetectionCount(params.aggregate);
    await this.prisma.$transaction([
      this.prisma.globalSpammer.upsert({
        where: {
          userId: params.userId,
        },
        create: {
          userId: params.userId,
          firstDetectedAt: params.detectedAt,
          lastReason: params.reason,
          lastChatId: params.sourceChatId,
          lastEvidence: params.evidence,
          confidenceScore: params.aggregate.score,
          detectionsCount,
          confirmedAt: now,
          expiresAt,
          sourceBreakdown: params.aggregate.sourceBreakdown,
        },
        update: {
          lastReason: params.reason,
          lastChatId: params.sourceChatId,
          lastEvidence: params.evidence,
          confidenceScore: params.aggregate.score,
          detectionsCount,
          confirmedAt: now,
          expiresAt,
          sourceBreakdown: params.aggregate.sourceBreakdown,
        },
      }),
      this.prisma.globalSpammerCandidate.upsert({
        where: {
          userId: params.userId,
        },
        create: {
          userId: params.userId,
          status: params.status,
          firstDetectedAt: params.detectedAt,
          lastReason: params.reason,
          lastChatId: params.sourceChatId,
          lastEvidence: params.evidence,
          confidenceScore: params.aggregate.score,
          detectionsCount,
          sourceBreakdown: params.aggregate.sourceBreakdown,
          reviewedAt: now,
          reviewedByUserId: params.reviewedByUserId,
          reviewReason: params.reviewReason,
          falsePositive: false,
        },
        update: {
          status: params.status,
          lastReason: params.reason,
          lastChatId: params.sourceChatId,
          lastEvidence: params.evidence,
          confidenceScore: params.aggregate.score,
          detectionsCount,
          sourceBreakdown: params.aggregate.sourceBreakdown,
          reviewedAt: now,
          reviewedByUserId: params.reviewedByUserId,
          reviewReason: params.reviewReason,
          falsePositive: false,
        },
      }),
    ]);
  }

  private async upsertCandidate(params: {
    userId: string;
    status: GlobalSpammerCandidateStatus;
    reason: string;
    chatId: string | null;
    messageId: string | null;
    userLabel: string | null;
    evidence: Prisma.InputJsonValue;
    aggregate: AggregateResult;
    suppressedUntil: Date | null;
    reviewedByUserId: string | null;
    reviewReason: string | null;
    falsePositive: boolean;
  }): Promise<void> {
    const now = new Date();
    await this.prisma.globalSpammerCandidate.upsert({
      where: {
        userId: params.userId,
      },
      create: {
        userId: params.userId,
        status: params.status,
        lastReason: params.reason,
        lastChatId: params.chatId,
        lastEvidence: params.evidence,
        lastUserLabel: params.userLabel,
        confidenceScore: params.aggregate.score,
        sourceBreakdown: params.aggregate.sourceBreakdown,
        suppressedUntil: params.suppressedUntil,
        reviewedAt: params.status === 'PENDING' ? null : now,
        reviewedByUserId: params.reviewedByUserId,
        reviewReason: params.reviewReason,
        falsePositive: params.falsePositive,
      },
      update: {
        status: params.status,
        detectionsCount: {
          increment: 1,
        },
        lastReason: params.reason,
        lastChatId: params.chatId,
        lastEvidence: params.evidence,
        lastUserLabel: params.userLabel,
        confidenceScore: params.aggregate.score,
        sourceBreakdown: params.aggregate.sourceBreakdown,
        suppressedUntil: params.suppressedUntil,
        reviewedAt: params.status === 'PENDING' ? null : now,
        reviewedByUserId: params.reviewedByUserId,
        reviewReason: params.reviewReason,
        falsePositive: params.falsePositive,
      },
    });

    if (!params.chatId) {
      return;
    }

    await this.prisma.globalSpammerCandidateChat.upsert({
      where: {
        candidateUserId_chatId: {
          candidateUserId: params.userId,
          chatId: params.chatId,
        },
      },
      create: {
        candidateUserId: params.userId,
        chatId: params.chatId,
        lastMessageId: params.messageId,
        lastExcerpt: this.extractEvidenceExcerpt(params.evidence),
        lastUserLabel: params.userLabel,
        lastEvidence: params.evidence,
      },
      update: {
        detectionsCount: {
          increment: 1,
        },
        lastMessageId: params.messageId,
        lastExcerpt: this.extractEvidenceExcerpt(params.evidence),
        lastUserLabel: params.userLabel,
        lastEvidence: params.evidence,
      },
    });
  }

  private async syncDenormCandidate(params: {
    userId: string;
    status: GlobalSpammerCandidateStatus;
    reason: string;
    chatId: string | null;
    messageId: string | null;
    userLabel: string | null;
    evidence: Prisma.InputJsonValue;
    aggregate: AggregateResult;
    suppressedUntil: Date | null;
    reviewedByUserId: string | null;
    reviewReason: string | null;
    falsePositive: boolean;
    detectedAt: Date;
  }): Promise<void> {
    const now = new Date();
    const detectionsCount = this.resolveDenormDetectionCount(params.aggregate);
    await this.prisma.globalSpammerCandidate.upsert({
      where: {
        userId: params.userId,
      },
      create: {
        userId: params.userId,
        status: params.status,
        firstDetectedAt: params.detectedAt,
        detectionsCount,
        lastReason: params.reason,
        lastChatId: params.chatId,
        lastEvidence: params.evidence,
        lastUserLabel: params.userLabel,
        confidenceScore: params.aggregate.score,
        sourceBreakdown: params.aggregate.sourceBreakdown,
        suppressedUntil: params.suppressedUntil,
        reviewedAt: params.status === 'PENDING' ? null : now,
        reviewedByUserId: params.reviewedByUserId,
        reviewReason: params.reviewReason,
        falsePositive: params.falsePositive,
      },
      update: {
        status: params.status,
        detectionsCount,
        lastReason: params.reason,
        lastChatId: params.chatId,
        lastEvidence: params.evidence,
        lastUserLabel: params.userLabel,
        confidenceScore: params.aggregate.score,
        sourceBreakdown: params.aggregate.sourceBreakdown,
        suppressedUntil: params.suppressedUntil,
        reviewedAt: params.status === 'PENDING' ? null : now,
        reviewedByUserId: params.reviewedByUserId,
        reviewReason: params.reviewReason,
        falsePositive: params.falsePositive,
      },
    });

    if (!params.chatId) {
      return;
    }

    const chatDetectionsCount = await this.resolveDenormChatDetectionCount({
      userId: params.userId,
      chatId: params.chatId,
      fallbackCount: detectionsCount,
    });
    await this.prisma.globalSpammerCandidateChat.upsert({
      where: {
        candidateUserId_chatId: {
          candidateUserId: params.userId,
          chatId: params.chatId,
        },
      },
      create: {
        candidateUserId: params.userId,
        chatId: params.chatId,
        firstDetectedAt: params.detectedAt,
        detectionsCount: chatDetectionsCount,
        lastMessageId: params.messageId,
        lastExcerpt: this.extractEvidenceExcerpt(params.evidence),
        lastUserLabel: params.userLabel,
        lastEvidence: params.evidence,
      },
      update: {
        detectionsCount: chatDetectionsCount,
        lastMessageId: params.messageId,
        lastExcerpt: this.extractEvidenceExcerpt(params.evidence),
        lastUserLabel: params.userLabel,
        lastEvidence: params.evidence,
      },
    });
  }

  private resolveDenormDetectionCount(aggregate: AggregateResult): number {
    return Math.max(
      1,
      aggregate.sources.reduce((sum, source) => sum + Math.max(0, source.count), 0),
    );
  }

  private async resolveDenormChatDetectionCount(params: {
    userId: string;
    chatId: string;
    fallbackCount: number;
  }): Promise<number> {
    try {
      const now = new Date();
      const count = await this.prisma.spammerObservation.count({
        where: {
          userId: params.userId,
          chatId: params.chatId,
          expiresAt: {
            gt: now,
          },
          suppressedAt: null,
        },
      });
      return Math.max(1, count);
    } catch (error: unknown) {
      this.logger.debug(
        {
          userId: params.userId,
          chatId: params.chatId,
          error: error instanceof Error ? error.message : String(error),
        },
        'Failed to count chat-scoped spammer observations for denorm sync',
      );
      return Math.max(1, params.fallbackCount);
    }
  }

  private buildCandidateEvidence(
    input: GlobalSpammerObservationInput,
    aggregate: AggregateResult,
    evidenceHash: string,
  ): Prisma.InputJsonValue {
    return {
      source: input.source,
      reason: input.reason,
      evidenceHash,
      score: this.roundScore(input.score),
      aggregateScore: aggregate.score,
      confidenceLevel: aggregate.confidenceLevel,
      sourceBreakdown: aggregate.sourceBreakdown,
      evidence: input.evidence ?? null,
    };
  }

  private buildEvidenceHash(value: unknown): string {
    return createHash('sha256').update(this.stableStringify(value)).digest('hex').slice(0, 32);
  }

  private stableStringify(value: unknown): string {
    if (value === null || value === undefined) {
      return 'null';
    }
    if (typeof value !== 'object') {
      return JSON.stringify(value);
    }
    if (Array.isArray(value)) {
      return `[${value.map((item) => this.stableStringify(item)).join(',')}]`;
    }
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${this.stableStringify(item)}`)
      .join(',')}}`;
  }

  private extractEvidenceExcerpt(evidence: Prisma.InputJsonValue): string | null {
    if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) {
      return null;
    }
    const direct = (evidence as Record<string, unknown>).excerpt;
    if (typeof direct === 'string' && direct.trim()) {
      return direct.trim().slice(0, 240);
    }
    const nested = (evidence as Record<string, unknown>).evidence;
    if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
      const nestedExcerpt = (nested as Record<string, unknown>).excerpt;
      if (typeof nestedExcerpt === 'string' && nestedExcerpt.trim()) {
        return nestedExcerpt.trim().slice(0, 240);
      }
    }
    return null;
  }

  private resolveConfidenceLevel(score: number): GlobalSpammerConfidenceLevel {
    if (score >= HIGH_CONFIDENCE_THRESHOLD) {
      return 'HIGH';
    }
    if (score >= MEDIUM_CONFIDENCE_THRESHOLD) {
      return 'MEDIUM';
    }
    return 'LOW';
  }

  private normalizeConfidenceLevel(
    value: string | null | undefined,
    score: number,
  ): GlobalSpammerConfidenceLevel {
    const normalized = value?.trim().toUpperCase();
    if (normalized === 'LOW' || normalized === 'MEDIUM' || normalized === 'HIGH') {
      return normalized;
    }
    return this.resolveConfidenceLevel(this.clampScore(score));
  }

  private emptyDecision(
    outcome: GlobalSpammerObservationDecision['outcome'],
    userId: string,
  ): GlobalSpammerObservationDecision {
    return {
      outcome,
      userId,
      aggregateScore: 0,
      confidenceLevel: 'LOW',
      sourceBreakdown: {},
    };
  }

  private clampScore(value: number): number {
    if (!Number.isFinite(value)) {
      return 0;
    }
    return Math.max(0, Math.min(1, value));
  }

  private roundScore(value: number): number {
    return Math.round(this.clampScore(value) * 1000) / 1000;
  }

  private normalizeUserId(value: string | null | undefined): string {
    return typeof value === 'string' ? value.trim().toLowerCase() : '';
  }

  private isKnownRuntimeBotUserId(userId: string | null | undefined): boolean {
    return this.maxBotRegistry?.isKnownBotUserId(userId) === true;
  }

  private readBooleanConfig(
    value: boolean | string | null | undefined,
    defaultValue: boolean,
  ): boolean {
    if (typeof value === 'boolean') {
      return value;
    }
    if (typeof value !== 'string') {
      return defaultValue;
    }
    const normalized = value.trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(normalized)) {
      return true;
    }
    if (['0', 'false', 'no', 'off'].includes(normalized)) {
      return false;
    }
    return defaultValue;
  }

  private readSampleRateConfig(
    value: number | string | null | undefined,
    defaultValue: number,
  ): number {
    const parsed =
      typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
    if (!Number.isFinite(parsed)) {
      return this.clampScore(defaultValue);
    }
    return this.clampScore(parsed);
  }

  private readObservationFastPathSourcesConfig(
    value: string | null | undefined,
  ): ReadonlySet<GlobalSpammerObservationSource> {
    if (typeof value !== 'string' || value.trim().length === 0) {
      return OBSERVATION_FAST_PATH_SOURCES;
    }
    const sources = new Set<GlobalSpammerObservationSource>();
    for (const token of value.split(',')) {
      const source = this.normalizeObservationSource(token);
      if (source && OBSERVATION_FAST_PATH_SOURCES.has(source)) {
        sources.add(source);
      }
    }
    return sources;
  }

  private normalizeRegistryStatus(value: string | null | undefined): GlobalSpammerRegistryStatus {
    const normalized = value?.trim().toUpperCase();
    switch (normalized) {
      case 'ACTIVE_CONFIRMED':
      case 'LOCAL_BLOCKED':
      case 'MEDIUM_REVIEW':
      case 'SUPPRESSED':
      case 'EXPIRED':
      case 'ADMIN_EXEMPT':
        return normalized;
      default:
        return 'NONE';
    }
  }

  private normalizePolicyAction(value: string | null | undefined): GlobalSpammerPolicyAction {
    const normalized = value?.trim().toUpperCase();
    if (normalized === 'DELETE_AND_KICK' || normalized === 'SHADOW_DELETE_AND_KICK') {
      return normalized;
    }
    return 'NONE';
  }

  private normalizePolicyBand(value: string | null | undefined): GlobalSpammerPolicyBand {
    const normalized = value?.trim().toUpperCase();
    switch (normalized) {
      case 'CONFIRMED':
      case 'VERY_HIGH':
      case 'HIGH':
      case 'MEDIUM':
        return normalized;
      default:
        return 'LOW';
    }
  }

  private readOptionalScore(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? this.roundScore(value) : null;
  }

  private normalizeText(value: string | null | undefined): string {
    return typeof value === 'string' ? value.trim() : '';
  }

  private normalizeUserFacingName(
    value: string | null | undefined,
    userId: string | null | undefined,
  ): string {
    const normalizedUserId = this.normalizeText(userId);
    let normalized = this.normalizeText(value);
    const mentionMatch = normalized.match(
      /^\[([^\]]+)\]\((?:max:\/\/user\/|https?:\/\/max\.ru\/)[^)]+\)$/u,
    );
    if (mentionMatch?.[1]) {
      normalized = mentionMatch[1].trim();
    }
    if (!normalized) {
      return '';
    }
    if (normalizedUserId && normalized === normalizedUserId) {
      return '';
    }
    if (/^(?:id)?\d{5,}$/iu.test(normalized)) {
      return '';
    }
    return normalized;
  }

  private readTimestampMs(value: Date | string | null | undefined): number {
    if (value instanceof Date) {
      return Number.isFinite(value.getTime()) ? value.getTime() : 0;
    }
    if (typeof value === 'string') {
      const timestamp = Date.parse(value);
      return Number.isFinite(timestamp) ? timestamp : 0;
    }
    return 0;
  }

  private normalizeObservationSource(
    value: string | null | undefined,
  ): GlobalSpammerObservationSource | null {
    const normalized = this.normalizeText(value);
    return GLOBAL_SPAMMER_OBSERVATION_SOURCES.includes(normalized as GlobalSpammerObservationSource)
      ? (normalized as GlobalSpammerObservationSource)
      : null;
  }

  private asRecord(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  }

  private asJsonArray(value: unknown): Prisma.InputJsonArray {
    if (!Array.isArray(value)) {
      return [];
    }
    return value
      .map((item) => this.toInputJsonValue(item))
      .filter((item): item is Prisma.InputJsonValue => item !== null);
  }

  private toInputJsonObject(value: Record<string, unknown>): Prisma.InputJsonObject {
    const result: Record<string, Prisma.InputJsonValue | null> = {};
    for (const [key, item] of Object.entries(value)) {
      if (item === undefined) {
        continue;
      }
      result[key] = this.toInputJsonValue(item);
    }
    return result;
  }

  private toInputJsonValue(value: unknown): Prisma.InputJsonValue | null {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') {
      return value;
    }
    if (typeof value === 'number') {
      return Number.isFinite(value) ? value : null;
    }
    if (value instanceof Date) {
      return value.toISOString();
    }
    if (Array.isArray(value)) {
      return value
        .filter((item) => item !== undefined)
        .map((item) => this.toInputJsonValue(item)) as Prisma.InputJsonArray;
    }
    if (typeof value === 'object') {
      return this.toInputJsonObject(value as Record<string, unknown>);
    }
    return null;
  }

  private toNullableInputJsonValue(value: unknown): Prisma.InputJsonValue | null {
    if (value === null || value === undefined || value === Prisma.JsonNull) {
      return null;
    }
    return this.toInputJsonValue(value);
  }

  private readNumber(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
  }

  private readString(value: unknown): string | null {
    return typeof value === 'string' && value.trim() ? value.trim() : null;
  }
}
