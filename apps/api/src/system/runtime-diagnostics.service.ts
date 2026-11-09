import { Injectable, Logger, OnModuleDestroy, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { QueueMetricsSnapshot } from './queue-metrics.service';
import type { SystemModeSnapshot } from './system-mode.service';
import Redis from 'ioredis';
import { StorageRuntimeMetricsService } from './storage-runtime-metrics.service';

type HotPathStageSummary = {
  stage: string;
  count: number;
  slowCount: number;
  timeoutCount: number;
  skipCount: number;
  failOpenCount: number;
  avgElapsedMs: number;
  maxElapsedMs: number;
  lastObservedAt: string | null;
};

type HotChatSummary = {
  chatId: string;
  messageCreatedCount: number;
  messageEditedCount?: number;
  deliveryCount?: number;
  executionCount?: number;
  mirrorCount?: number;
  botsSeen: number;
  lastSeenAt: string;
};

type BackgroundPauseReasonSummary = {
  component: string;
  sourceTag: string;
  action: 'run' | 'slow' | 'pause';
  reason: string;
  count: number;
  lastObservedAt: string | null;
};

type MembershipLookupSample = {
  chatId: string;
  policyName: string;
  lastObservedAt: string;
  retryAfterMs: number | null;
};

type MembershipLookupIssueSample = MembershipLookupSample & {
  kind: 'transient' | 'terminal';
};

type ProblemChatSeverity = 'info' | 'warning' | 'critical';

type ProblemChatSummary = {
  chatId: string;
  botId: string | null;
  category: string;
  severity: ProblemChatSeverity;
  action: string | null;
  statusCode: number | null;
  reason: string;
  count: number;
  lastObservedAt: string;
};

type SpammerSurfaceTimingSample = {
  surface: string;
  stage: string;
  elapsedMs: number;
};

type SpammerSurfaceTimingSummary = {
  surface: string;
  stage: string;
  count: number;
  avgMs: number;
  p95Ms: number;
  p99Ms: number;
  maxMs: number;
  lastObservedAt: string | null;
};

export type SpammerReadModelEvent =
  | 'profile_read_hit'
  | 'profile_read_miss'
  | 'profile_read_stale'
  | 'fallback_after_profile_miss'
  | 'shadow_compared'
  | 'shadow_matched'
  | 'shadow_mismatched'
  | 'shadow_score_drift'
  | 'profile_write_success'
  | 'profile_write_failure'
  | 'denorm_job_enqueued'
  | 'denorm_job_enqueue_failed'
  | 'denorm_fast_path_enqueued'
  | 'denorm_fast_path_fallback'
  | 'denorm_fast_path_replayed'
  | 'denorm_fast_path_replay_missing'
  | 'denorm_job_processed'
  | 'denorm_job_failed';

type SpammerReadModelSummary = {
  windowSec: number;
  profileReads: {
    hits: number;
    misses: number;
    stale: number;
    fallbacks: number;
    hitRate: number;
  };
  shadow: {
    compared: number;
    matched: number;
    mismatched: number;
    scoreDrift: number;
    scoreDriftRate: number;
    mismatchRate: number;
  };
  profileWrites: {
    success: number;
    failure: number;
  };
  denormJobs: {
    enqueued: number;
    enqueueFailed: number;
    fastPathEnqueued: number;
    fastPathFallbacks: number;
    fastPathReplayed: number;
    fastPathReplayMissing: number;
    processed: number;
    failed: number;
    avgAgeMs: number;
    maxAgeMs: number;
    lastSuccessAt: string | null;
    lastFailureAt: string | null;
  };
};

export type RuntimeDiagnosticsDashboardSnapshot = {
  burst: {
    active: boolean;
    peakLagSec: number;
    peakBotId: string | null;
    startedAt: string | null;
    lastRecoveredAt: string | null;
    sampleAgeMs: number;
  };
  hotPath: {
    windowSec: number;
    failOpenCount: number;
    stages: HotPathStageSummary[];
  };
  hotChats: {
    windowSec: number;
    items: HotChatSummary[];
  };
  membershipLookup: {
    windowSec: number;
    hotChannels: number;
    backoffActiveChats: number;
    transientIssues: number;
    terminalIssues: number;
    hotChannelsSample: MembershipLookupSample[];
    backoffSample: MembershipLookupSample[];
    issueSample: MembershipLookupIssueSample[];
  };
  problemChats: {
    windowSec: number;
    items: ProblemChatSummary[];
  };
  spammerSurfaces: {
    windowSec: number;
    timings: SpammerSurfaceTimingSummary[];
  };
  spammerReadModel: SpammerReadModelSummary;
};

export type RuntimeDiagnosticsReadinessSnapshot = Pick<
  RuntimeDiagnosticsDashboardSnapshot,
  'burst'
>;

const HOT_PATH_BUCKET_PREFIX = 'runtime:diag:hot-path:v1';
const HOT_CHAT_COUNT_BUCKET_PREFIX = 'runtime:diag:hot-chat:count:v1';
const HOT_CHAT_LAST_BUCKET_PREFIX = 'runtime:diag:hot-chat:last:v1';
const HOT_CHAT_BOT_BUCKET_PREFIX = 'runtime:diag:hot-chat:bot:v1';
const HOT_CHAT_ACTIVITY_BUCKET_PREFIX = 'runtime:diag:hot-chat:activity:v2';
const BACKGROUND_REASON_COUNT_BUCKET_PREFIX = 'runtime:diag:bg:reason:count:v1';
const BACKGROUND_REASON_LAST_BUCKET_PREFIX = 'runtime:diag:bg:reason:last:v1';
const MEMBERSHIP_HOT_PREFIX = 'runtime:diag:membership:hot:v1';
const MEMBERSHIP_BACKOFF_PREFIX = 'runtime:diag:membership:backoff:v1';
const MEMBERSHIP_ISSUE_PREFIX = 'runtime:diag:membership:issue:v1';
const PROBLEM_CHAT_COUNT_BUCKET_PREFIX = 'runtime:diag:problem-chat:count:v1';
const PROBLEM_CHAT_LAST_BUCKET_PREFIX = 'runtime:diag:problem-chat:last:v1';
const SPAMMER_SURFACE_BUCKET_PREFIX = 'runtime:diag:spammer-surface:v1';
const SPAMMER_READ_MODEL_BUCKET_PREFIX = 'runtime:diag:spammer-read-model:v1';
const BURST_STATE_KEY = 'runtime:diag:burst-state:v1';

const BUCKET_SPAN_SEC = 60;
const SPAMMER_SURFACE_LATENCY_BUCKETS_MS = [
  25, 50, 100, 150, 200, 300, 500, 750, 1_000, 1_500, 2_000, 3_000, 5_000, 10_000, 30_000,
] as const;
const HOT_PATH_SLOW_ELAPSED_MS = 1_500;
const DEFAULT_HOT_PATH_WINDOW_SEC = 15 * 60;
const DEFAULT_HOT_CHAT_WINDOW_SEC = 30 * 60;
const DEFAULT_BACKGROUND_REASON_WINDOW_SEC = 15 * 60;
const DEFAULT_MEMBERSHIP_WINDOW_SEC = 15 * 60;
const DEFAULT_PROBLEM_CHAT_WINDOW_SEC = 60 * 60;
const DEFAULT_SPAMMER_SURFACE_WINDOW_SEC = 15 * 60;
const DEFAULT_SPAMMER_READ_MODEL_WINDOW_SEC = 15 * 60;
const DEFAULT_BURST_LAG_THRESHOLD_SEC = 2;
const DEFAULT_REDIS_SCAN_COUNT = 250;
const PROBLEM_CHAT_REASON_MAX_LENGTH = 180;

@Injectable()
export class RuntimeDiagnosticsService implements OnModuleDestroy {
  private readonly logger = new Logger(RuntimeDiagnosticsService.name);
  private readonly redis: Redis;
  private readonly hotPathWindowSec: number;
  private readonly hotChatWindowSec: number;
  private readonly backgroundReasonWindowSec: number;
  private readonly membershipWindowSec: number;
  private readonly problemChatWindowSec: number;
  private readonly spammerSurfaceWindowSec: number;
  private readonly spammerReadModelWindowSec: number;
  private readonly burstLagThresholdSec: number;
  private readonly redisScanCount: number;

  constructor(
    configService: ConfigService,
    @Optional() private readonly storageRuntimeMetrics?: StorageRuntimeMetricsService,
  ) {
    this.redis = new Redis(configService.getOrThrow<string>('REDIS_URL'));
    this.hotPathWindowSec = this.readPositiveInt(
      configService.get('SYSTEM_RUNTIME_DIAGNOSTICS_HOT_PATH_WINDOW_SEC'),
      DEFAULT_HOT_PATH_WINDOW_SEC,
    );
    this.hotChatWindowSec = this.readPositiveInt(
      configService.get('SYSTEM_RUNTIME_DIAGNOSTICS_HOT_CHAT_WINDOW_SEC'),
      DEFAULT_HOT_CHAT_WINDOW_SEC,
    );
    this.backgroundReasonWindowSec = this.readPositiveInt(
      configService.get('SYSTEM_RUNTIME_DIAGNOSTICS_BACKGROUND_WINDOW_SEC'),
      DEFAULT_BACKGROUND_REASON_WINDOW_SEC,
    );
    this.membershipWindowSec = this.readPositiveInt(
      configService.get('SYSTEM_RUNTIME_DIAGNOSTICS_MEMBERSHIP_WINDOW_SEC'),
      DEFAULT_MEMBERSHIP_WINDOW_SEC,
    );
    this.problemChatWindowSec = this.readPositiveInt(
      configService.get('SYSTEM_RUNTIME_DIAGNOSTICS_PROBLEM_CHAT_WINDOW_SEC'),
      DEFAULT_PROBLEM_CHAT_WINDOW_SEC,
    );
    this.spammerSurfaceWindowSec = this.readPositiveInt(
      configService.get('SYSTEM_RUNTIME_DIAGNOSTICS_SPAMMER_SURFACE_WINDOW_SEC'),
      DEFAULT_SPAMMER_SURFACE_WINDOW_SEC,
    );
    this.spammerReadModelWindowSec = this.readPositiveInt(
      configService.get('SYSTEM_RUNTIME_DIAGNOSTICS_SPAMMER_READ_MODEL_WINDOW_SEC'),
      DEFAULT_SPAMMER_READ_MODEL_WINDOW_SEC,
    );
    this.burstLagThresholdSec = this.readPositiveNumber(
      configService.get('SYSTEM_RUNTIME_DIAGNOSTICS_BURST_LAG_SEC'),
      DEFAULT_BURST_LAG_THRESHOLD_SEC,
    );
    this.redisScanCount = this.readPositiveInt(
      configService.get('SYSTEM_RUNTIME_DIAGNOSTICS_SCAN_COUNT'),
      DEFAULT_REDIS_SCAN_COUNT,
    );
  }

  async onModuleDestroy(): Promise<void> {
    await this.redis.quit();
  }

  async recordHotPathProfile(params: {
    snapshot: Record<string, unknown> | null | undefined;
    stagePrefix?: string;
  }): Promise<void> {
    const stageDurations = this.readNumericRecord(params.snapshot?.stageDurations);
    // FLAG: Observe only fixed rule phases and per-detect coverage, before Redis I/O.
    // This adds no per-event network operation and cannot turn a failed diagnostics
    // write into execution authority.
    if (!params.stagePrefix) {
      this.storageRuntimeMetrics?.optimization.ruleCoverage(params.snapshot?.ruleCoverage);
      for (const [stage, elapsedMs] of Object.entries(stageDurations)) {
        if (stage.startsWith('rule-engine.')) {
          this.storageRuntimeMetrics?.optimization.ruleStage(
            stage.slice('rule-engine.'.length),
            elapsedMs,
          );
        }
      }
    }
    const now = Date.now();
    const bucketKey = this.buildBucketKey(HOT_PATH_BUCKET_PREFIX, now);
    const ttlSec = this.resolveBucketTtlSec(this.hotPathWindowSec);
    const stagePrefix = params.stagePrefix?.trim() ?? '';
    let touched = false;
    const normalizedEntries = Object.entries(stageDurations)
      .map(([rawStage, rawElapsedMs]) => ({
        stage: stagePrefix ? `${stagePrefix}${rawStage}` : rawStage,
        elapsedMs: Math.max(0, Math.trunc(rawElapsedMs)),
      }))
      .filter((entry) => entry.stage.length > 0);
    if (normalizedEntries.length === 0) {
      return;
    }

    const maxElapsedFields = normalizedEntries.map((entry) => `${entry.stage}|maxElapsedMs`);
    const existingMaxElapsedValues = await this.redis.hmget(bucketKey, ...maxElapsedFields);
    const pipeline = this.redis.pipeline();

    normalizedEntries.forEach((entry, index) => {
      const { stage, elapsedMs } = entry;
      const existingMaxElapsedMs = this.parseNonNegativeInt(
        existingMaxElapsedValues[index] ?? null,
      );
      pipeline.hincrby(bucketKey, `${stage}|count`, 1);
      pipeline.hincrby(bucketKey, `${stage}|elapsedTotalMs`, elapsedMs);
      pipeline.hset(bucketKey, `${stage}|lastObservedAtMs`, String(now));
      if (elapsedMs >= existingMaxElapsedMs) {
        pipeline.hset(bucketKey, `${stage}|maxElapsedMs`, String(elapsedMs));
      }
      if (elapsedMs >= HOT_PATH_SLOW_ELAPSED_MS) {
        pipeline.hincrby(bucketKey, `${stage}|slowCount`, 1);
      }
      touched = true;
    });

    if (!touched) {
      return;
    }

    pipeline.expire(bucketKey, ttlSec);
    await this.execPipeline(pipeline, 'recordHotPathProfile');
  }

  async recordHotPathStageOutcome(params: {
    stage: string;
    outcome: 'timeout' | 'skip';
    failOpen?: boolean;
  }): Promise<void> {
    const stage = params.stage.trim();
    if (!stage) {
      return;
    }

    const now = Date.now();
    const bucketKey = this.buildBucketKey(HOT_PATH_BUCKET_PREFIX, now);
    const ttlSec = this.resolveBucketTtlSec(this.hotPathWindowSec);
    const fieldName = `${stage}|${params.outcome === 'timeout' ? 'timeoutCount' : 'skipCount'}`;
    const pipeline = this.redis.pipeline();
    pipeline.hincrby(bucketKey, fieldName, 1);
    if (params.failOpen) {
      pipeline.hincrby(bucketKey, `${stage}|failOpenCount`, 1);
    }
    pipeline.hset(bucketKey, `${stage}|lastObservedAtMs`, String(now));
    pipeline.expire(bucketKey, ttlSec);
    await this.execPipeline(pipeline, 'recordHotPathStageOutcome');
  }

  async recordHotChatMessage(params: {
    chatId: string;
    botId?: string | null;
    eventType?: string;
  }): Promise<void> {
    return this.recordHotChatActivity({ ...params, stage: 'EXECUTION' });
  }

  async recordHotChatActivity(params: {
    chatId: string;
    botId?: string | null;
    eventType?: string;
    stage: 'RECEIPT' | 'EXECUTION' | 'MIRROR';
  }): Promise<void> {
    if (
      params.eventType &&
      params.eventType !== 'message_created' &&
      params.eventType !== 'message_edited'
    )
      return;
    const chatId = params.chatId.trim();
    if (!chatId) {
      return;
    }

    const now = Date.now();
    const countBucketKey = this.buildBucketKey(HOT_CHAT_COUNT_BUCKET_PREFIX, now);
    const lastBucketKey = this.buildBucketKey(HOT_CHAT_LAST_BUCKET_PREFIX, now);
    const botBucketKey = this.buildBucketKey(HOT_CHAT_BOT_BUCKET_PREFIX, now);
    const ttlSec = this.resolveBucketTtlSec(this.hotChatWindowSec);
    const pipeline = this.redis.pipeline();
    const activityKey = this.buildBucketKey(HOT_CHAT_ACTIVITY_BUCKET_PREFIX, now);
    const type = params.eventType === 'message_edited' ? 'edit' : 'create';
    pipeline.hincrby(activityKey, `${chatId}\t${params.stage}\t${type}`, 1);
    pipeline.expire(activityKey, ttlSec);
    if (params.stage === 'EXECUTION' && type === 'create')
      pipeline.hincrby(countBucketKey, chatId, 1);
    pipeline.hset(lastBucketKey, chatId, String(now));
    pipeline.expire(countBucketKey, ttlSec);
    pipeline.expire(lastBucketKey, ttlSec);
    const botId = typeof params.botId === 'string' ? params.botId.trim() : '';
    if (botId) {
      pipeline.hincrby(botBucketKey, `${chatId}\t${botId}`, 1);
      pipeline.expire(botBucketKey, ttlSec);
    }
    await this.execPipeline(pipeline, 'recordHotChatMessage');
  }

  async recordBackgroundDecision(params: {
    component: string;
    sourceTag: string;
    action: 'run' | 'slow' | 'pause';
    reason: string;
  }): Promise<void> {
    const component = params.component.trim();
    const sourceTag = params.sourceTag.trim();
    const reason = params.reason.trim();
    if (!component || !sourceTag || !reason) {
      return;
    }

    const now = Date.now();
    const countBucketKey = this.buildBucketKey(BACKGROUND_REASON_COUNT_BUCKET_PREFIX, now);
    const lastBucketKey = this.buildBucketKey(BACKGROUND_REASON_LAST_BUCKET_PREFIX, now);
    const ttlSec = this.resolveBucketTtlSec(this.backgroundReasonWindowSec);
    const field = JSON.stringify({
      component,
      sourceTag,
      action: params.action,
      reason,
    });
    const pipeline = this.redis.pipeline();
    pipeline.hincrby(countBucketKey, field, 1);
    pipeline.hset(lastBucketKey, field, String(now));
    pipeline.expire(countBucketKey, ttlSec);
    pipeline.expire(lastBucketKey, ttlSec);
    await this.execPipeline(pipeline, 'recordBackgroundDecision');
  }

  async recordMembershipHotChannel(params: {
    chatId: string;
    policyName: string;
    hotDurationMs: number;
  }): Promise<void> {
    const key = this.buildMembershipKey(MEMBERSHIP_HOT_PREFIX, params.policyName, params.chatId);
    if (!key) {
      return;
    }
    await this.setEphemeralMembershipEntry(key, {
      observedAtMs: Date.now(),
      retryAfterMs: Math.max(0, Math.ceil(params.hotDurationMs)),
    });
  }

  async recordMembershipBackoff(params: {
    chatId: string;
    policyName: string;
    retryAfterMs: number;
  }): Promise<void> {
    const key = this.buildMembershipKey(
      MEMBERSHIP_BACKOFF_PREFIX,
      params.policyName,
      params.chatId,
    );
    if (!key) {
      return;
    }
    await this.setEphemeralMembershipEntry(key, {
      observedAtMs: Date.now(),
      retryAfterMs: Math.max(0, Math.ceil(params.retryAfterMs)),
    });
  }

  async recordMembershipIssue(params: {
    chatId: string;
    policyName: string;
    kind: 'transient' | 'terminal';
    retryAfterMs: number;
  }): Promise<void> {
    const key = this.buildMembershipKey(
      `${MEMBERSHIP_ISSUE_PREFIX}:${params.kind}`,
      params.policyName,
      params.chatId,
    );
    if (!key) {
      return;
    }
    await this.setEphemeralMembershipEntry(key, {
      observedAtMs: Date.now(),
      retryAfterMs: Math.max(0, Math.ceil(params.retryAfterMs)),
    });
  }

  async recordProblemChat(params: {
    chatId: string;
    botId?: string | null;
    category: string;
    severity: ProblemChatSeverity;
    action?: string | null;
    statusCode?: number | null;
    reason: string;
  }): Promise<void> {
    const descriptor = this.normalizeProblemChatDescriptor(params);
    if (!descriptor) {
      return;
    }

    const now = Date.now();
    const countBucketKey = this.buildBucketKey(PROBLEM_CHAT_COUNT_BUCKET_PREFIX, now);
    const lastBucketKey = this.buildBucketKey(PROBLEM_CHAT_LAST_BUCKET_PREFIX, now);
    const ttlSec = this.resolveBucketTtlSec(this.problemChatWindowSec);
    const field = JSON.stringify(descriptor);
    const pipeline = this.redis.pipeline();
    pipeline.hincrby(countBucketKey, field, 1);
    pipeline.hset(lastBucketKey, field, String(now));
    pipeline.expire(countBucketKey, ttlSec);
    pipeline.expire(lastBucketKey, ttlSec);
    await this.execPipeline(pipeline, 'recordProblemChat');
  }

  async recordQueueLagSnapshot(params: {
    queues: Pick<
      QueueMetricsSnapshot,
      'effectiveLagSec' | 'userFacingEffectiveLagSec' | 'generatedAt' | 'bots'
    >;
    mode: Pick<SystemModeSnapshot, 'mode' | 'reason'>;
  }): Promise<void> {
    const lagSec = params.queues.userFacingEffectiveLagSec ?? params.queues.effectiveLagSec ?? 0;
    const now = Date.now();
    const current = await this.readBurstState();
    const peakBotId = this.resolvePeakLagBotId(params.queues.bots);
    const shouldTreatAsBurst =
      params.mode.mode === 'degrade' || lagSec >= this.burstLagThresholdSec;

    const nextState = current ?? {
      active: false,
      peakLagSec: 0,
      peakBotId: null,
      startedAtMs: null,
      lastRecoveredAtMs: null,
      updatedAtMs: 0,
    };

    if (shouldTreatAsBurst) {
      if (!nextState.active) {
        nextState.startedAtMs = now;
        nextState.peakLagSec = lagSec;
        nextState.peakBotId = peakBotId;
      } else if (lagSec >= nextState.peakLagSec) {
        nextState.peakLagSec = lagSec;
        nextState.peakBotId = peakBotId;
      }
      nextState.active = true;
    } else if (nextState.active) {
      nextState.active = false;
      nextState.lastRecoveredAtMs = now;
    }

    nextState.updatedAtMs = now;
    await this.redis.set(
      BURST_STATE_KEY,
      JSON.stringify(nextState),
      'EX',
      Math.max(60, Math.ceil(this.resolveBucketTtlSec(this.hotPathWindowSec))),
    );
  }

  async recordSpammerReadModelEvent(params: {
    event: SpammerReadModelEvent;
    jobAgeMs?: number | null;
  }): Promise<void> {
    await this.recordSpammerReadModelEvents({
      events: [params.event],
      jobAgeMs: params.jobAgeMs,
    });
  }

  async recordSpammerReadModelEvents(params: {
    events: readonly SpammerReadModelEvent[];
    jobAgeMs?: number | null;
  }): Promise<void> {
    if (params.events.length === 0) {
      return;
    }

    const now = Date.now();
    const bucketKey = this.buildBucketKey(SPAMMER_READ_MODEL_BUCKET_PREFIX, now);
    const ttlSec = this.resolveBucketTtlSec(this.spammerReadModelWindowSec);
    const pipeline = this.redis.pipeline();
    params.events.forEach((event) => {
      pipeline.hincrby(bucketKey, event, 1);
      pipeline.hset(bucketKey, `${event}|lastObservedAtMs`, String(now));
    });
    if (typeof params.jobAgeMs === 'number' && Number.isFinite(params.jobAgeMs)) {
      const ageMs = Math.max(0, Math.trunc(params.jobAgeMs));
      pipeline.hincrby(bucketKey, 'denorm_job_age_total_ms', ageMs);
      pipeline.hincrby(bucketKey, 'denorm_job_age_count', 1);
      const existingMaxAge = this.parseNonNegativeInt(
        await this.redis.hget(bucketKey, 'denorm_job_age_max_ms'),
      );
      if (ageMs >= existingMaxAge) {
        pipeline.hset(bucketKey, 'denorm_job_age_max_ms', String(ageMs));
      }
    }
    pipeline.expire(bucketKey, ttlSec);
    await this.execPipeline(pipeline, 'recordSpammerReadModelEvents');
  }

  async recordSpammerSurfaceTiming(params: {
    surface: string;
    timings: Record<string, number | null | undefined>;
  }): Promise<void> {
    const surface = this.normalizeMetricSegment(params.surface);
    if (!surface) {
      return;
    }

    const samples = Object.entries(params.timings)
      .map(([stage, elapsedMs]) => {
        const normalizedStage = this.normalizeMetricSegment(stage);
        if (!normalizedStage || typeof elapsedMs !== 'number' || !Number.isFinite(elapsedMs)) {
          return null;
        }
        return {
          surface,
          stage: normalizedStage,
          elapsedMs: Math.max(0, Math.trunc(elapsedMs)),
        };
      })
      .filter((sample): sample is SpammerSurfaceTimingSample => sample !== null);
    if (samples.length === 0) {
      return;
    }

    const now = Date.now();
    const bucketKey = this.buildBucketKey(SPAMMER_SURFACE_BUCKET_PREFIX, now);
    const ttlSec = this.resolveBucketTtlSec(this.spammerSurfaceWindowSec);
    const maxFields = samples.map((sample) => this.buildSpammerSurfaceField(sample, 'max'));
    const existingMaxValues = await this.redis.hmget(bucketKey, ...maxFields);
    const pipeline = this.redis.pipeline();

    samples.forEach((sample, index) => {
      const bucket = this.resolveLatencyBucket(sample.elapsedMs);
      const countField = this.buildSpammerSurfaceField(sample, `bucket:${bucket}`);
      pipeline.hincrby(bucketKey, countField, 1);
      pipeline.hincrby(bucketKey, this.buildSpammerSurfaceField(sample, 'count'), 1);
      pipeline.hincrby(bucketKey, this.buildSpammerSurfaceField(sample, 'total'), sample.elapsedMs);
      pipeline.hset(
        bucketKey,
        this.buildSpammerSurfaceField(sample, 'lastObservedAtMs'),
        String(now),
      );
      const existingMaxMs = this.parseNonNegativeInt(existingMaxValues[index] ?? null);
      if (sample.elapsedMs >= existingMaxMs) {
        pipeline.hset(bucketKey, maxFields[index], String(sample.elapsedMs));
      }
    });

    pipeline.expire(bucketKey, ttlSec);
    await this.execPipeline(pipeline, 'recordSpammerSurfaceTiming');
  }

  async getDashboardSnapshot(): Promise<RuntimeDiagnosticsDashboardSnapshot> {
    const [
      burst,
      hotPath,
      hotChats,
      membershipLookup,
      problemChats,
      spammerSurfaces,
      spammerReadModel,
    ] = await Promise.all([
      this.getBurstSnapshot(),
      this.getHotPathSummary(),
      this.getHotChatsSummary(),
      this.getMembershipLookupSummary(),
      this.getProblemChatsSummary(),
      this.getSpammerSurfaceSummary(),
      this.getSpammerReadModelSummary(),
    ]);

    return {
      burst,
      hotPath,
      hotChats,
      membershipLookup,
      problemChats,
      spammerSurfaces,
      spammerReadModel,
    };
  }

  // FLAG: Readiness is polled frequently; keep this path O(1) and free of keyspace scans.
  async getReadinessSnapshot(): Promise<RuntimeDiagnosticsReadinessSnapshot> {
    return {
      burst: await this.getBurstSnapshot(),
    };
  }

  async getBackgroundDecisionSummary(): Promise<{
    windowSec: number;
    pauseReasons: BackgroundPauseReasonSummary[];
  }> {
    const bucketKeys = this.buildWindowBucketKeys(
      BACKGROUND_REASON_COUNT_BUCKET_PREFIX,
      this.backgroundReasonWindowSec,
    );
    const lastBucketKeys = this.buildWindowBucketKeys(
      BACKGROUND_REASON_LAST_BUCKET_PREFIX,
      this.backgroundReasonWindowSec,
    );
    const [countHashes, lastHashes] = await Promise.all([
      this.readHashes(bucketKeys),
      this.readHashes(lastBucketKeys),
    ]);
    const aggregate = new Map<
      string,
      {
        descriptor: BackgroundPauseReasonSummary;
        lastObservedAtMs: number;
      }
    >();

    for (let index = 0; index < countHashes.length; index += 1) {
      const countHash = countHashes[index] ?? {};
      const lastHash = lastHashes[index] ?? {};
      for (const [field, rawCount] of Object.entries(countHash)) {
        const parsed = this.parseBackgroundDecisionField(field);
        if (!parsed) {
          continue;
        }
        const count = this.parseNonNegativeInt(rawCount);
        const lastObservedAtMs = this.parseNonNegativeInt(lastHash[field]);
        const key = `${parsed.component}\u0000${parsed.sourceTag}\u0000${parsed.action}\u0000${parsed.reason}`;
        const existing = aggregate.get(key);
        if (existing) {
          existing.descriptor.count += count;
          existing.lastObservedAtMs = Math.max(existing.lastObservedAtMs, lastObservedAtMs);
          continue;
        }
        aggregate.set(key, {
          descriptor: {
            ...parsed,
            count,
            lastObservedAt: null,
          },
          lastObservedAtMs,
        });
      }
    }

    const pauseReasons = [...aggregate.values()]
      .map((entry) => ({
        ...entry.descriptor,
        lastObservedAt:
          entry.lastObservedAtMs > 0 ? new Date(entry.lastObservedAtMs).toISOString() : null,
      }))
      .sort(
        (left, right) =>
          right.count - left.count ||
          Date.parse(right.lastObservedAt ?? '') - Date.parse(left.lastObservedAt ?? ''),
      )
      .slice(0, 8);

    return {
      windowSec: this.backgroundReasonWindowSec,
      pauseReasons,
    };
  }

  private async getBurstSnapshot(): Promise<RuntimeDiagnosticsDashboardSnapshot['burst']> {
    const state = await this.readBurstState();
    if (!state) {
      return {
        active: false,
        peakLagSec: 0,
        peakBotId: null,
        startedAt: null,
        lastRecoveredAt: null,
        sampleAgeMs: 0,
      };
    }

    return {
      active: state.active,
      peakLagSec: Number(state.peakLagSec.toFixed(3)),
      peakBotId: state.peakBotId,
      startedAt: state.startedAtMs ? new Date(state.startedAtMs).toISOString() : null,
      lastRecoveredAt: state.lastRecoveredAtMs
        ? new Date(state.lastRecoveredAtMs).toISOString()
        : null,
      sampleAgeMs: Math.max(0, Date.now() - state.updatedAtMs),
    };
  }

  private async getHotPathSummary(): Promise<RuntimeDiagnosticsDashboardSnapshot['hotPath']> {
    const bucketKeys = this.buildWindowBucketKeys(HOT_PATH_BUCKET_PREFIX, this.hotPathWindowSec);
    const hashes = await this.readHashes(bucketKeys);
    const stages = new Map<
      string,
      {
        count: number;
        slowCount: number;
        timeoutCount: number;
        skipCount: number;
        failOpenCount: number;
        elapsedTotalMs: number;
        maxElapsedMs: number;
        lastObservedAtMs: number;
      }
    >();

    for (const hash of hashes) {
      for (const [field, rawValue] of Object.entries(hash)) {
        const separatorIndex = field.lastIndexOf('|');
        if (separatorIndex <= 0) {
          continue;
        }
        const stage = field.slice(0, separatorIndex);
        const metric = field.slice(separatorIndex + 1);
        const numericValue = this.parseNonNegativeInt(rawValue);
        const bucket = stages.get(stage) ?? {
          count: 0,
          slowCount: 0,
          timeoutCount: 0,
          skipCount: 0,
          failOpenCount: 0,
          elapsedTotalMs: 0,
          maxElapsedMs: 0,
          lastObservedAtMs: 0,
        };
        if (metric === 'count') {
          bucket.count += numericValue;
        } else if (metric === 'slowCount') {
          bucket.slowCount += numericValue;
        } else if (metric === 'timeoutCount') {
          bucket.timeoutCount += numericValue;
        } else if (metric === 'skipCount') {
          bucket.skipCount += numericValue;
        } else if (metric === 'failOpenCount') {
          bucket.failOpenCount += numericValue;
        } else if (metric === 'elapsedTotalMs') {
          bucket.elapsedTotalMs += numericValue;
        } else if (metric === 'lastObservedAtMs') {
          bucket.lastObservedAtMs = Math.max(bucket.lastObservedAtMs, numericValue);
        } else if (metric === 'maxElapsedMs') {
          bucket.maxElapsedMs = Math.max(bucket.maxElapsedMs, numericValue);
        }
        stages.set(stage, bucket);
      }
    }

    const allNormalizedStages: HotPathStageSummary[] = [...stages.entries()]
      .map(([stage, value]) => ({
        stage,
        count: value.count,
        slowCount: value.slowCount,
        timeoutCount: value.timeoutCount,
        skipCount: value.skipCount,
        failOpenCount: value.failOpenCount,
        avgElapsedMs: value.count > 0 ? Number((value.elapsedTotalMs / value.count).toFixed(1)) : 0,
        maxElapsedMs: value.maxElapsedMs,
        lastObservedAt:
          value.lastObservedAtMs > 0 ? new Date(value.lastObservedAtMs).toISOString() : null,
      }))
      .sort(
        (left, right) =>
          right.timeoutCount - left.timeoutCount ||
          right.slowCount - left.slowCount ||
          right.skipCount - left.skipCount ||
          right.maxElapsedMs - left.maxElapsedMs ||
          right.count - left.count,
      );
    const normalizedStages = allNormalizedStages.slice(0, 12);

    return {
      windowSec: this.hotPathWindowSec,
      failOpenCount: allNormalizedStages.reduce((sum, item) => sum + item.failOpenCount, 0),
      stages: normalizedStages,
    };
  }

  private async getHotChatsSummary(): Promise<RuntimeDiagnosticsDashboardSnapshot['hotChats']> {
    const countHashes = await this.readHashes(
      this.buildWindowBucketKeys(HOT_CHAT_COUNT_BUCKET_PREFIX, this.hotChatWindowSec),
    );
    const lastHashes = await this.readHashes(
      this.buildWindowBucketKeys(HOT_CHAT_LAST_BUCKET_PREFIX, this.hotChatWindowSec),
    );
    const botHashes = await this.readHashes(
      this.buildWindowBucketKeys(HOT_CHAT_BOT_BUCKET_PREFIX, this.hotChatWindowSec),
    );
    const activityHashes = await this.readHashes(
      this.buildWindowBucketKeys(HOT_CHAT_ACTIVITY_BUCKET_PREFIX, this.hotChatWindowSec),
    );
    const activity = new Map<
      string,
      {
        messageEditedCount: number;
        deliveryCount: number;
        executionCount: number;
        mirrorCount: number;
      }
    >();
    for (const hash of activityHashes)
      for (const [field, raw] of Object.entries(hash)) {
        const [chatId, stage, type] = field.split('\t');
        if (!chatId) continue;
        const entry = activity.get(chatId) ?? {
          messageEditedCount: 0,
          deliveryCount: 0,
          executionCount: 0,
          mirrorCount: 0,
        };
        const count = this.parseNonNegativeInt(raw);
        if (stage === 'RECEIPT') entry.deliveryCount += count;
        if (stage === 'MIRROR') entry.mirrorCount += count;
        if (stage === 'EXECUTION') {
          entry.executionCount += count;
          if (type === 'edit') entry.messageEditedCount += count;
        }
        activity.set(chatId, entry);
      }

    const aggregate = new Map<
      string,
      {
        count: number;
        lastObservedAtMs: number;
        botIds: Set<string>;
      }
    >();

    for (const hash of countHashes) {
      for (const [chatId, rawCount] of Object.entries(hash)) {
        const entry = aggregate.get(chatId) ?? {
          count: 0,
          lastObservedAtMs: 0,
          botIds: new Set<string>(),
        };
        entry.count += this.parseNonNegativeInt(rawCount);
        aggregate.set(chatId, entry);
      }
    }

    for (const hash of lastHashes) {
      for (const [chatId, rawLastObservedAtMs] of Object.entries(hash)) {
        const entry = aggregate.get(chatId) ?? {
          count: 0,
          lastObservedAtMs: 0,
          botIds: new Set<string>(),
        };
        entry.lastObservedAtMs = Math.max(
          entry.lastObservedAtMs,
          this.parseNonNegativeInt(rawLastObservedAtMs),
        );
        aggregate.set(chatId, entry);
      }
    }

    for (const hash of botHashes) {
      for (const field of Object.keys(hash)) {
        const separatorIndex = field.indexOf('\t');
        if (separatorIndex <= 0) {
          continue;
        }
        const chatId = field.slice(0, separatorIndex);
        const botId = field.slice(separatorIndex + 1);
        const entry = aggregate.get(chatId) ?? {
          count: 0,
          lastObservedAtMs: 0,
          botIds: new Set<string>(),
        };
        if (botId) {
          entry.botIds.add(botId);
        }
        aggregate.set(chatId, entry);
      }
    }

    const items = [...aggregate.entries()]
      .map(([chatId, entry]) => ({
        chatId,
        messageCreatedCount: entry.count,
        ...activity.get(chatId),
        botsSeen: Math.max(1, entry.botIds.size || 0),
        lastSeenAt: new Date(entry.lastObservedAtMs || Date.now()).toISOString(),
      }))
      .sort(
        (left, right) =>
          right.messageCreatedCount - left.messageCreatedCount ||
          Date.parse(right.lastSeenAt) - Date.parse(left.lastSeenAt),
      )
      .slice(0, 12);

    return {
      windowSec: this.hotChatWindowSec,
      items,
    };
  }

  private async getMembershipLookupSummary(): Promise<
    RuntimeDiagnosticsDashboardSnapshot['membershipLookup']
  > {
    const [hotChannels, backoffKeys, transientKeys, terminalKeys] = await Promise.all([
      this.scanKeys(`${MEMBERSHIP_HOT_PREFIX}:*`),
      this.scanKeys(`${MEMBERSHIP_BACKOFF_PREFIX}:*`),
      this.scanKeys(`${MEMBERSHIP_ISSUE_PREFIX}:transient:*`),
      this.scanKeys(`${MEMBERSHIP_ISSUE_PREFIX}:terminal:*`),
    ]);

    const [hotChannelSamples, backoffSample, transientIssues, terminalIssues] = await Promise.all([
      this.readMembershipSamples(hotChannels, 'sample'),
      this.readMembershipSamples(backoffKeys, 'sample'),
      this.readMembershipIssueSamples(transientKeys, 'transient'),
      this.readMembershipIssueSamples(terminalKeys, 'terminal'),
    ]);

    return {
      windowSec: this.membershipWindowSec,
      hotChannels: hotChannels.length,
      backoffActiveChats: backoffKeys.length,
      transientIssues: transientIssues.length,
      terminalIssues: terminalIssues.length,
      hotChannelsSample: hotChannelSamples.slice(0, 6),
      backoffSample: backoffSample.slice(0, 6),
      issueSample: [...transientIssues, ...terminalIssues]
        .sort((left, right) => Date.parse(right.lastObservedAt) - Date.parse(left.lastObservedAt))
        .slice(0, 8),
    };
  }

  private async getProblemChatsSummary(): Promise<
    RuntimeDiagnosticsDashboardSnapshot['problemChats']
  > {
    const [countHashes, lastHashes] = await Promise.all([
      this.readHashes(
        this.buildWindowBucketKeys(PROBLEM_CHAT_COUNT_BUCKET_PREFIX, this.problemChatWindowSec),
      ),
      this.readHashes(
        this.buildWindowBucketKeys(PROBLEM_CHAT_LAST_BUCKET_PREFIX, this.problemChatWindowSec),
      ),
    ]);
    const aggregate = new Map<
      string,
      {
        descriptor: Omit<ProblemChatSummary, 'count' | 'lastObservedAt'>;
        count: number;
        lastObservedAtMs: number;
      }
    >();

    for (let index = 0; index < countHashes.length; index += 1) {
      const countHash = countHashes[index] ?? {};
      const lastHash = lastHashes[index] ?? {};
      for (const [field, rawCount] of Object.entries(countHash)) {
        const descriptor = this.parseProblemChatDescriptor(field);
        if (!descriptor) {
          continue;
        }
        const existing = aggregate.get(field) ?? {
          descriptor,
          count: 0,
          lastObservedAtMs: 0,
        };
        existing.count += this.parseNonNegativeInt(rawCount);
        existing.lastObservedAtMs = Math.max(
          existing.lastObservedAtMs,
          this.parseNonNegativeInt(lastHash[field]),
        );
        aggregate.set(field, existing);
      }
    }

    const items = [...aggregate.values()]
      .map((entry) => ({
        ...entry.descriptor,
        count: entry.count,
        lastObservedAt: new Date(entry.lastObservedAtMs || Date.now()).toISOString(),
      }))
      .sort(
        (left, right) =>
          this.problemSeverityRank(right.severity) - this.problemSeverityRank(left.severity) ||
          right.count - left.count ||
          Date.parse(right.lastObservedAt) - Date.parse(left.lastObservedAt),
      )
      .slice(0, 16);

    return {
      windowSec: this.problemChatWindowSec,
      items,
    };
  }

  private async getSpammerSurfaceSummary(): Promise<
    RuntimeDiagnosticsDashboardSnapshot['spammerSurfaces']
  > {
    const hashes = await this.readHashes(
      this.buildWindowBucketKeys(SPAMMER_SURFACE_BUCKET_PREFIX, this.spammerSurfaceWindowSec),
    );
    const aggregate = new Map<
      string,
      {
        surface: string;
        stage: string;
        count: number;
        totalMs: number;
        maxMs: number;
        lastObservedAtMs: number;
        buckets: Map<number, number>;
      }
    >();

    for (const hash of hashes) {
      for (const [field, rawValue] of Object.entries(hash)) {
        const parsed = this.parseSpammerSurfaceField(field);
        if (!parsed) {
          continue;
        }
        const key = `${parsed.surface}\u0000${parsed.stage}`;
        const value = this.parseNonNegativeInt(rawValue);
        const entry = aggregate.get(key) ?? {
          surface: parsed.surface,
          stage: parsed.stage,
          count: 0,
          totalMs: 0,
          maxMs: 0,
          lastObservedAtMs: 0,
          buckets: new Map<number, number>(),
        };

        if (parsed.metric === 'count') {
          entry.count += value;
        } else if (parsed.metric === 'total') {
          entry.totalMs += value;
        } else if (parsed.metric === 'max') {
          entry.maxMs = Math.max(entry.maxMs, value);
        } else if (parsed.metric === 'lastObservedAtMs') {
          entry.lastObservedAtMs = Math.max(entry.lastObservedAtMs, value);
        } else if (parsed.metric.startsWith('bucket:')) {
          const bucket = Number(parsed.metric.slice('bucket:'.length));
          if (Number.isFinite(bucket)) {
            entry.buckets.set(bucket, (entry.buckets.get(bucket) ?? 0) + value);
          }
        }

        aggregate.set(key, entry);
      }
    }

    const timings = [...aggregate.values()]
      .filter((entry) => entry.count > 0)
      .map((entry) => ({
        surface: entry.surface,
        stage: entry.stage,
        count: entry.count,
        avgMs: Number((entry.totalMs / entry.count).toFixed(1)),
        p95Ms: this.estimateLatencyPercentile(entry.buckets, entry.count, 0.95),
        p99Ms: this.estimateLatencyPercentile(entry.buckets, entry.count, 0.99),
        maxMs: entry.maxMs,
        lastObservedAt:
          entry.lastObservedAtMs > 0 ? new Date(entry.lastObservedAtMs).toISOString() : null,
      }))
      .sort(
        (left, right) =>
          right.p95Ms - left.p95Ms ||
          right.maxMs - left.maxMs ||
          right.count - left.count ||
          left.surface.localeCompare(right.surface) ||
          left.stage.localeCompare(right.stage),
      )
      .slice(0, 24);

    return {
      windowSec: this.spammerSurfaceWindowSec,
      timings,
    };
  }

  private async getSpammerReadModelSummary(): Promise<
    RuntimeDiagnosticsDashboardSnapshot['spammerReadModel']
  > {
    const hashes = await this.readHashes(
      this.buildWindowBucketKeys(SPAMMER_READ_MODEL_BUCKET_PREFIX, this.spammerReadModelWindowSec),
    );
    const counters = new Map<string, number>();
    let lastSuccessAtMs = 0;
    let lastFailureAtMs = 0;

    for (const hash of hashes) {
      for (const [field, rawValue] of Object.entries(hash)) {
        const value = this.parseNonNegativeInt(rawValue);
        if (field === 'denorm_job_processed|lastObservedAtMs') {
          lastSuccessAtMs = Math.max(lastSuccessAtMs, value);
          continue;
        }
        if (field === 'denorm_job_failed|lastObservedAtMs') {
          lastFailureAtMs = Math.max(lastFailureAtMs, value);
          continue;
        }
        if (field.includes('|lastObservedAtMs')) {
          continue;
        }
        if (field === 'denorm_job_age_max_ms') {
          counters.set(field, Math.max(counters.get(field) ?? 0, value));
          continue;
        }
        counters.set(field, (counters.get(field) ?? 0) + value);
      }
    }

    const hits = counters.get('profile_read_hit') ?? 0;
    const misses = counters.get('profile_read_miss') ?? 0;
    const stale = counters.get('profile_read_stale') ?? 0;
    const fallbacks = counters.get('fallback_after_profile_miss') ?? 0;
    const compared = counters.get('shadow_compared') ?? 0;
    const matched = counters.get('shadow_matched') ?? 0;
    const mismatched = counters.get('shadow_mismatched') ?? 0;
    const scoreDrift = counters.get('shadow_score_drift') ?? 0;
    const enqueued = counters.get('denorm_job_enqueued') ?? 0;
    const enqueueFailed = counters.get('denorm_job_enqueue_failed') ?? 0;
    const fastPathEnqueued = counters.get('denorm_fast_path_enqueued') ?? 0;
    const fastPathFallbacks = counters.get('denorm_fast_path_fallback') ?? 0;
    const fastPathReplayed = counters.get('denorm_fast_path_replayed') ?? 0;
    const fastPathReplayMissing = counters.get('denorm_fast_path_replay_missing') ?? 0;
    const processed = counters.get('denorm_job_processed') ?? 0;
    const failed = counters.get('denorm_job_failed') ?? 0;
    const totalReads = hits + misses + stale;
    const totalAgeMs = counters.get('denorm_job_age_total_ms') ?? 0;
    const totalAgeCount = counters.get('denorm_job_age_count') ?? 0;

    return {
      windowSec: this.spammerReadModelWindowSec,
      profileReads: {
        hits,
        misses,
        stale,
        fallbacks,
        hitRate: totalReads > 0 ? Number((hits / totalReads).toFixed(4)) : 0,
      },
      shadow: {
        compared,
        matched,
        mismatched,
        scoreDrift,
        scoreDriftRate: compared > 0 ? Number((scoreDrift / compared).toFixed(4)) : 0,
        mismatchRate: compared > 0 ? Number((mismatched / compared).toFixed(4)) : 0,
      },
      profileWrites: {
        success: counters.get('profile_write_success') ?? 0,
        failure: counters.get('profile_write_failure') ?? 0,
      },
      denormJobs: {
        enqueued,
        enqueueFailed,
        fastPathEnqueued,
        fastPathFallbacks,
        fastPathReplayed,
        fastPathReplayMissing,
        processed,
        failed,
        avgAgeMs: totalAgeCount > 0 ? Number((totalAgeMs / totalAgeCount).toFixed(1)) : 0,
        maxAgeMs: counters.get('denorm_job_age_max_ms') ?? 0,
        lastSuccessAt: lastSuccessAtMs > 0 ? new Date(lastSuccessAtMs).toISOString() : null,
        lastFailureAt: lastFailureAtMs > 0 ? new Date(lastFailureAtMs).toISOString() : null,
      },
    };
  }

  private async readMembershipSamples(
    keys: readonly string[],
    _kind: 'sample',
  ): Promise<MembershipLookupSample[]> {
    const values = await this.readStrings(keys);
    return keys
      .map((key, index) => {
        const parsedKey = this.parseMembershipKey(key);
        const parsedValue = this.parseMembershipValue(values[index] ?? null);
        if (!parsedKey || !parsedValue) {
          return null;
        }
        return {
          chatId: parsedKey.chatId,
          policyName: parsedKey.policyName,
          lastObservedAt: new Date(parsedValue.observedAtMs).toISOString(),
          retryAfterMs: parsedValue.retryAfterMs,
        };
      })
      .filter((item): item is MembershipLookupSample => item !== null)
      .sort((left, right) => Date.parse(right.lastObservedAt) - Date.parse(left.lastObservedAt));
  }

  private async readMembershipIssueSamples(
    keys: readonly string[],
    kind: 'transient' | 'terminal',
  ): Promise<MembershipLookupIssueSample[]> {
    const values = await this.readStrings(keys);
    return keys
      .map((key, index) => {
        const parsedKey = this.parseMembershipKey(key);
        const parsedValue = this.parseMembershipValue(values[index] ?? null);
        if (!parsedKey || !parsedValue) {
          return null;
        }
        return {
          chatId: parsedKey.chatId,
          policyName: parsedKey.policyName,
          kind,
          lastObservedAt: new Date(parsedValue.observedAtMs).toISOString(),
          retryAfterMs: parsedValue.retryAfterMs,
        };
      })
      .filter((item): item is MembershipLookupIssueSample => item !== null)
      .sort((left, right) => Date.parse(right.lastObservedAt) - Date.parse(left.lastObservedAt));
  }

  private resolvePeakLagBotId(
    bots:
      | Record<
          string,
          {
            effectiveLagSec?: number;
            userFacingEffectiveLagSec?: number;
          }
        >
      | null
      | undefined,
  ): string | null {
    let bestBotId: string | null = null;
    let bestLag = Number.NEGATIVE_INFINITY;
    for (const [botId, metrics] of Object.entries(bots ?? {})) {
      const lag =
        typeof metrics.userFacingEffectiveLagSec === 'number'
          ? metrics.userFacingEffectiveLagSec
          : typeof metrics.effectiveLagSec === 'number'
            ? metrics.effectiveLagSec
            : Number.NEGATIVE_INFINITY;
      if (lag > bestLag) {
        bestLag = lag;
        bestBotId = botId;
      }
    }
    return bestBotId;
  }

  private async readBurstState(): Promise<{
    active: boolean;
    peakLagSec: number;
    peakBotId: string | null;
    startedAtMs: number | null;
    lastRecoveredAtMs: number | null;
    updatedAtMs: number;
  } | null> {
    const raw = await this.redis.get(BURST_STATE_KEY);
    if (!raw) {
      return null;
    }

    try {
      const parsed = JSON.parse(raw) as {
        active?: unknown;
        peakLagSec?: unknown;
        peakBotId?: unknown;
        startedAtMs?: unknown;
        lastRecoveredAtMs?: unknown;
        updatedAtMs?: unknown;
      };
      if (
        typeof parsed.active !== 'boolean' ||
        typeof parsed.peakLagSec !== 'number' ||
        typeof parsed.updatedAtMs !== 'number'
      ) {
        return null;
      }
      return {
        active: parsed.active,
        peakLagSec: parsed.peakLagSec,
        peakBotId: typeof parsed.peakBotId === 'string' ? parsed.peakBotId : null,
        startedAtMs: typeof parsed.startedAtMs === 'number' ? parsed.startedAtMs : null,
        lastRecoveredAtMs:
          typeof parsed.lastRecoveredAtMs === 'number' ? parsed.lastRecoveredAtMs : null,
        updatedAtMs: parsed.updatedAtMs,
      };
    } catch {
      return null;
    }
  }

  private buildWindowBucketKeys(prefix: string, windowSec: number): string[] {
    const nowMs = Date.now();
    const windowBucketCount = Math.max(1, Math.ceil(windowSec / BUCKET_SPAN_SEC));
    const keys: string[] = [];
    for (let index = 0; index < windowBucketCount; index += 1) {
      keys.push(this.buildBucketKey(prefix, nowMs - index * BUCKET_SPAN_SEC * 1_000));
    }
    return keys;
  }

  private buildBucketKey(prefix: string, nowMs: number): string {
    const bucketStartSec = Math.floor(nowMs / (BUCKET_SPAN_SEC * 1_000)) * BUCKET_SPAN_SEC;
    return `${prefix}:${bucketStartSec}`;
  }

  private resolveBucketTtlSec(windowSec: number): number {
    return Math.max(windowSec + BUCKET_SPAN_SEC * 2, BUCKET_SPAN_SEC * 4);
  }

  private async readHashes(keys: readonly string[]): Promise<Array<Record<string, string>>> {
    if (keys.length === 0) {
      return [];
    }
    const pipeline = this.redis.pipeline();
    keys.forEach((key) => pipeline.hgetall(key));
    const results = await pipeline.exec();
    if (!results) {
      return keys.map(() => ({}));
    }
    return results.map((entry) => {
      const [, value] = entry;
      return this.isStringRecord(value) ? value : {};
    });
  }

  private async readStrings(keys: readonly string[]): Promise<Array<string | null>> {
    if (keys.length === 0) {
      return [];
    }

    const values = await this.redis.mget(...keys);
    return values.map((value) => (typeof value === 'string' ? value : null));
  }

  private parseBackgroundDecisionField(
    value: string,
  ): Omit<BackgroundPauseReasonSummary, 'count' | 'lastObservedAt'> | null {
    try {
      const parsed = JSON.parse(value) as {
        component?: unknown;
        sourceTag?: unknown;
        action?: unknown;
        reason?: unknown;
      };
      if (
        typeof parsed.component !== 'string' ||
        typeof parsed.sourceTag !== 'string' ||
        (parsed.action !== 'run' && parsed.action !== 'slow' && parsed.action !== 'pause') ||
        typeof parsed.reason !== 'string'
      ) {
        return null;
      }
      return {
        component: parsed.component,
        sourceTag: parsed.sourceTag,
        action: parsed.action,
        reason: parsed.reason,
      };
    } catch {
      return null;
    }
  }

  private async setEphemeralMembershipEntry(
    key: string,
    value: {
      observedAtMs: number;
      retryAfterMs: number | null;
    },
  ): Promise<void> {
    const retryAfterMs = Math.max(1_000, Math.ceil(value.retryAfterMs ?? 0));
    await this.redis.set(
      key,
      JSON.stringify({
        observedAtMs: value.observedAtMs,
        retryAfterMs: value.retryAfterMs,
      }),
      'PX',
      retryAfterMs,
    );
  }

  private buildMembershipKey(prefix: string, policyName: string, chatId: string): string | null {
    const normalizedPolicy = policyName.trim();
    const normalizedChatId = chatId.trim();
    if (!normalizedPolicy || !normalizedChatId) {
      return null;
    }
    return `${prefix}:${normalizedPolicy}:${normalizedChatId}`;
  }

  private parseMembershipKey(key: string): { policyName: string; chatId: string } | null {
    const parts = key.split(':');
    if (parts.length < 2) {
      return null;
    }
    const chatId = parts.at(-1)?.trim() ?? '';
    const policyName = parts.at(-2)?.trim() ?? '';
    if (!chatId || !policyName) {
      return null;
    }
    return {
      policyName,
      chatId,
    };
  }

  private parseMembershipValue(
    raw: string | null,
  ): { observedAtMs: number; retryAfterMs: number | null } | null {
    if (!raw) {
      return null;
    }
    try {
      const parsed = JSON.parse(raw) as {
        observedAtMs?: unknown;
        retryAfterMs?: unknown;
      };
      if (typeof parsed.observedAtMs !== 'number') {
        return null;
      }
      return {
        observedAtMs: parsed.observedAtMs,
        retryAfterMs:
          typeof parsed.retryAfterMs === 'number'
            ? Math.max(0, Math.ceil(parsed.retryAfterMs))
            : null,
      };
    } catch {
      return null;
    }
  }

  private normalizeProblemChatDescriptor(params: {
    chatId: string;
    botId?: string | null;
    category: string;
    severity: ProblemChatSeverity;
    action?: string | null;
    statusCode?: number | null;
    reason: string;
  }): Omit<ProblemChatSummary, 'count' | 'lastObservedAt'> | null {
    const chatId = params.chatId.trim();
    const category = this.normalizeProblemField(params.category, 'unknown');
    const action = this.normalizeNullableProblemField(params.action);
    const reason = this.truncateProblemReason(params.reason);
    if (!chatId || !reason) {
      return null;
    }

    const statusCode =
      typeof params.statusCode === 'number' &&
      Number.isInteger(params.statusCode) &&
      params.statusCode > 0
        ? params.statusCode
        : null;

    return {
      chatId,
      botId: this.normalizeNullableProblemField(params.botId),
      category,
      severity: params.severity,
      action,
      statusCode,
      reason,
    };
  }

  private parseProblemChatDescriptor(
    raw: string,
  ): Omit<ProblemChatSummary, 'count' | 'lastObservedAt'> | null {
    try {
      const parsed = JSON.parse(raw) as {
        chatId?: unknown;
        botId?: unknown;
        category?: unknown;
        severity?: unknown;
        action?: unknown;
        statusCode?: unknown;
        reason?: unknown;
      };
      if (
        typeof parsed.chatId !== 'string' ||
        typeof parsed.category !== 'string' ||
        (parsed.severity !== 'info' &&
          parsed.severity !== 'warning' &&
          parsed.severity !== 'critical') ||
        typeof parsed.reason !== 'string'
      ) {
        return null;
      }
      return {
        chatId: parsed.chatId,
        botId: typeof parsed.botId === 'string' ? parsed.botId : null,
        category: parsed.category,
        severity: parsed.severity,
        action: typeof parsed.action === 'string' ? parsed.action : null,
        statusCode:
          typeof parsed.statusCode === 'number' &&
          Number.isInteger(parsed.statusCode) &&
          parsed.statusCode > 0
            ? parsed.statusCode
            : null,
        reason: parsed.reason,
      };
    } catch {
      return null;
    }
  }

  private normalizeProblemField(value: string, fallback: string): string {
    const normalized = value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_.-]+/gu, '_');
    return normalized || fallback;
  }

  private normalizeNullableProblemField(value: string | null | undefined): string | null {
    if (typeof value !== 'string') {
      return null;
    }
    const normalized = this.normalizeProblemField(value, '');
    return normalized || null;
  }

  private truncateProblemReason(value: string): string {
    const normalized = value.trim().replace(/\s+/gu, ' ');
    if (normalized.length <= PROBLEM_CHAT_REASON_MAX_LENGTH) {
      return normalized;
    }
    return `${normalized.slice(0, PROBLEM_CHAT_REASON_MAX_LENGTH - 3)}...`;
  }

  private normalizeMetricSegment(value: string): string {
    return value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_.-]+/gu, '_')
      .slice(0, 80);
  }

  private buildSpammerSurfaceField(
    sample: Pick<SpammerSurfaceTimingSample, 'surface' | 'stage'>,
    metric: string,
  ): string {
    return `${sample.surface}|${sample.stage}|${metric}`;
  }

  private parseSpammerSurfaceField(
    value: string,
  ): { surface: string; stage: string; metric: string } | null {
    const [surface, stage, ...metricParts] = value.split('|');
    const metric = metricParts.join('|');
    if (!surface || !stage || !metric) {
      return null;
    }
    return { surface, stage, metric };
  }

  private resolveLatencyBucket(elapsedMs: number): number {
    for (const bucket of SPAMMER_SURFACE_LATENCY_BUCKETS_MS) {
      if (elapsedMs <= bucket) {
        return bucket;
      }
    }
    return SPAMMER_SURFACE_LATENCY_BUCKETS_MS[SPAMMER_SURFACE_LATENCY_BUCKETS_MS.length - 1];
  }

  private estimateLatencyPercentile(
    buckets: ReadonlyMap<number, number>,
    totalCount: number,
    percentile: number,
  ): number {
    if (totalCount <= 0) {
      return 0;
    }
    const target = Math.max(1, Math.ceil(totalCount * percentile));
    let cumulative = 0;
    for (const [bucket, count] of [...buckets.entries()].sort(
      (left, right) => left[0] - right[0],
    )) {
      cumulative += count;
      if (cumulative >= target) {
        return bucket;
      }
    }
    return 0;
  }

  private problemSeverityRank(severity: ProblemChatSeverity): number {
    switch (severity) {
      case 'critical':
        return 3;
      case 'warning':
        return 2;
      case 'info':
      default:
        return 1;
    }
  }

  private async scanKeys(pattern: string): Promise<string[]> {
    const keys: string[] = [];
    let cursor = '0';
    do {
      const [nextCursor, chunk] = await this.redis.scan(
        cursor,
        'MATCH',
        pattern,
        'COUNT',
        String(this.redisScanCount),
      );
      cursor = nextCursor;
      if (Array.isArray(chunk) && chunk.length > 0) {
        keys.push(...chunk);
      }
    } while (cursor !== '0');
    return keys;
  }

  private readNumericRecord(value: unknown): Record<string, number> {
    if (!this.isNumberRecord(value)) {
      return {};
    }

    return Object.fromEntries(
      Object.entries(value)
        .filter((entry): entry is [string, number] => Number.isFinite(entry[1]))
        .map(([key, numericValue]) => [key, numericValue]),
    );
  }

  private isStringRecord(value: unknown): value is Record<string, string> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }

  private isNumberRecord(value: unknown): value is Record<string, number> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }

  private parseNonNegativeInt(value: unknown): number {
    const numericValue =
      typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN;
    if (!Number.isFinite(numericValue) || numericValue < 0) {
      return 0;
    }
    return Math.trunc(numericValue);
  }

  private async execPipeline(
    pipeline: ReturnType<Redis['pipeline']>,
    context: string,
  ): Promise<void> {
    try {
      await pipeline.exec();
    } catch (error: unknown) {
      this.logger.debug(
        { context, err: error instanceof Error ? error.message : String(error) },
        'Runtime diagnostics write failed',
      );
    }
  }

  private readPositiveInt(value: unknown, fallback: number): number {
    const numericValue = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(numericValue) || numericValue <= 0) {
      return fallback;
    }
    return Math.max(1, Math.trunc(numericValue));
  }

  private readPositiveNumber(value: unknown, fallback: number): number {
    const numericValue = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(numericValue) || numericValue <= 0) {
      return fallback;
    }
    return numericValue;
  }
}
