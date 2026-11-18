import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { randomUUID } from 'node:crypto';
import {
  activityReleaseReceiptKey,
  HIGHER_PRIORITY_ACTIVITY_ACQUIRE_SCRIPT,
  HIGHER_PRIORITY_ACTIVITY_KEY,
  HIGHER_PRIORITY_ACTIVITY_LEASE_MS,
  HIGHER_PRIORITY_ACTIVITY_RENEW_MS,
  HIGHER_PRIORITY_ACTIVITY_RENEW_SCRIPT,
  HIGHER_PRIORITY_ACTIVITY_UNAVAILABLE_KEY,
  RETENTION_PRIORITY_TRAFFIC_KEY_PREFIX,
  RETENTION_PRIORITY_TRAFFIC_TTL_SEC,
  settleHigherPriorityActivity,
} from '../max/retention-priority-admission';
import type { AdminAccessEpochMutationMetric } from '../chat-context/chat-context-cache.service';
import {
  MAX_WEBHOOK_ROUTE_OUTCOMES,
  type MaxWebhookRouteOutcome,
  type MaxWebhookRouteOutcomeMetric,
} from '../webhook/webhook-route-outcome';

export type WebhookIngressBotMetrics = {
  attemptedReceipts: number;
  persistedReceipts: number;
  failedReceipts: number;
  rejectedReceipts: number;
};

export type WebhookIngressMetricsSnapshot = {
  available: boolean;
  targetMs: number;
  attemptedReceipts: number;
  persistedReceipts: number;
  failedReceipts: number;
  rejectedReceipts: number;
  sampledReceipts: number;
  p95LatencyMs: number | null;
  p99LatencyMs: number | null;
  underTargetRatio: number | null;
  bots: Record<string, WebhookIngressBotMetrics>;
  route: WebhookRouteMetrics;
  membershipCache: WebhookMembershipCacheMetrics;
  membershipTransition: WebhookMembershipTransitionMetrics;
};

export type WebhookRouteOutcomeCounts = Record<MaxWebhookRouteOutcome, number>;

export type WebhookRouteBotMetrics = {
  attemptedRequests: number;
  outcomes: WebhookRouteOutcomeCounts;
};

export type WebhookRouteMetrics = {
  attemptedRequests: number;
  outcomes: WebhookRouteOutcomeCounts;
  bots: Record<string, WebhookRouteBotMetrics>;
};

export type WebhookReceiptPersistenceMetric = {
  botId: string;
  outcome: 'persisted' | 'failed' | 'rejected';
  latencyMs: number;
};

export type WebhookMembershipCacheTimingMetrics = {
  sampled: number;
  p95DurationMs: number | null;
  p99DurationMs: number | null;
  overflowSamples: number;
};

export type WebhookMembershipCacheMetrics = {
  precheck: {
    hit: number;
    miss: number;
    failOpen: number;
    timing: WebhookMembershipCacheTimingMetrics;
  };
  lua: {
    applied: number;
    superseded: number;
    conflict: number;
    retry: number;
    exhausted: number;
    failed: number;
    timing: WebhookMembershipCacheTimingMetrics;
  };
  budget: {
    completed: number;
    timeout: number;
    timing: WebhookMembershipCacheTimingMetrics;
  };
  detached: {
    completed: number;
    timeout: number;
    failure: number;
    peakInFlight: number;
    rejected: number;
  };
};

export type WebhookMembershipCacheBudgetMetric = {
  outcome: 'completed' | 'timeout';
  durationMs: number;
};

export type WebhookMembershipCacheDetachedWorkMetric = {
  outcome: 'completed' | 'timeout' | 'failure' | 'rejected' | null;
  inFlight: number;
  count?: number;
};

export type WebhookMembershipTransitionMetrics = {
  edgeAdvance: {
    calls: number;
    affectedRows: number;
    noOpCalls: number;
    timing: WebhookMembershipCacheTimingMetrics;
  };
};

export type WebhookMembershipAccessEdgeAdvanceMetric = {
  durationMs: number;
  affectedRows: number;
};

const METRICS_KEY_PREFIX = 'system:webhook-ingress:metrics:v1';
const METRICS_BUCKET_SEC = 10;
const DEFAULT_INGRESS_TARGET_MS = 2_000;
const DEFAULT_SLO_WINDOW_SEC = 15 * 60;
const MAX_SLO_WINDOW_SEC = 24 * 60 * 60;
const REDIS_COMMAND_TIMEOUT_MS = 100;
const ROUTE_METRICS_FLUSH_INTERVAL_MS = 1_000;
const MIN_RETENTION_SEC = 60 * 60;
const MAX_RETENTION_SEC = 24 * 60 * 60;
const METRICS_FAILURE_LOG_INTERVAL_MS = 30_000;
const LATENCY_BUCKET_UPPER_BOUNDS_MS = [
  25, 50, 100, 200, 400, 750, 1_000, 1_500, 2_000, 3_000, 5_000, 10_000, 20_000, 30_000,
] as const;
const MEMBERSHIP_CACHE_TIMING_STAGES = ['precheck', 'lua', 'budget'] as const;
type MembershipCacheTimingStage = (typeof MEMBERSHIP_CACHE_TIMING_STAGES)[number];
const MEMBERSHIP_CACHE_DURATION_BUCKET_UPPER_BOUNDS_MS = [
  1, 2, 5, 10, 20, 35, 50, 75, 100, 150, 250, 500, 1_000, 2_500, 5_000, 10_000, 30_000,
] as const;

const RECORD_RECEIPT_LUA = `
local key = KEYS[1]
local outcome = ARGV[1]
local bot = ARGV[2]
local latencyBucket = ARGV[3]
local latencyMs = tonumber(ARGV[4]) or 0
local underTarget = ARGV[5]
local ttlSec = tonumber(ARGV[6]) or 3600

-- FLAG: The fixed minute arrival counter shares the existing receipt observation.
-- Missing telemetry is never manufactured into an observed quiet minute.
local time = redis.call('TIME')
local minute = math.floor(tonumber(time[1]) / 60) * 60
local trafficKey = KEYS[2] .. ':' .. tostring(minute)
redis.call('HINCRBY', trafficKey, 'arrivals', 1)
redis.call('EXPIRE', trafficKey, tonumber(ARGV[7]))

redis.call('HINCRBY', key, 'attempted', 1)
redis.call('HINCRBY', key, 'bot:' .. bot .. ':attempted', 1)

if outcome == 'persisted' then
  redis.call('HINCRBY', key, 'persisted', 1)
  redis.call('HINCRBY', key, 'latency:' .. latencyBucket, 1)
  redis.call('HINCRBY', key, 'bot:' .. bot .. ':persisted', 1)
  if underTarget == '1' then
    redis.call('HINCRBY', key, 'under_target', 1)
  end
  local currentMax = tonumber(redis.call('HGET', key, 'max_latency_ms') or '0')
  if latencyMs > currentMax then
    redis.call('HSET', key, 'max_latency_ms', tostring(latencyMs))
  end
elseif outcome == 'failed' then
  redis.call('HINCRBY', key, 'failed', 1)
  redis.call('HINCRBY', key, 'bot:' .. bot .. ':failed', 1)
else
  redis.call('HINCRBY', key, 'rejected', 1)
  redis.call('HINCRBY', key, 'bot:' .. bot .. ':rejected', 1)
end

redis.call('EXPIRE', key, ttlSec)
return 1
`;

const RECORD_ROUTE_OUTCOMES_LUA = `
-- MAXIM_WEBHOOK_ROUTE_OUTCOMES_V1
local key = KEYS[1]
local ttlSec = tonumber(ARGV[1]) or 3600
for index = 2, #ARGV, 2 do
  local field = ARGV[index]
  local count = tonumber(ARGV[index + 1]) or 0
  if count > 0 then
    redis.call('HINCRBY', key, field, count)
  end
end
redis.call('EXPIRE', key, ttlSec)
return 1
`;

@Injectable()
export class WebhookIngressMetricsService implements OnModuleDestroy {
  private readonly logger = new Logger(WebhookIngressMetricsService.name);
  private readonly redis: Redis;
  private readonly targetMs: number;
  private readonly retentionSec: number;
  private readonly pendingRouteFieldsByKey = new Map<string, Map<string, number>>();
  private routeFlushTimer: NodeJS.Timeout | null = null;
  private routeFlushInFlight: Promise<void> | null = null;
  private destroying = false;
  private lastWriteFailureLogAtMs = 0;
  private lastReadFailureLogAtMs = 0;
  private readonly receiptObservationSettlements = new Set<Promise<void>>();

  constructor(configService: ConfigService) {
    this.redis = new Redis(configService.getOrThrow<string>('REDIS_URL'), {
      commandTimeout: REDIS_COMMAND_TIMEOUT_MS,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
    });
    this.targetMs = this.readPositiveInt(
      configService.get('SYSTEM_WEBHOOK_INGRESS_SLO_TARGET_MS'),
      DEFAULT_INGRESS_TARGET_MS,
    );
    const sloWindowSec = this.normalizeWindowSec(
      configService.get('SYSTEM_WEBHOOK_SLO_WINDOW_SEC'),
      DEFAULT_SLO_WINDOW_SEC,
    );
    this.retentionSec = Math.min(MAX_RETENTION_SEC, Math.max(MIN_RETENTION_SEC, sloWindowSec * 2));
  }

  async onModuleDestroy(): Promise<void> {
    this.destroying = true;
    if (this.routeFlushTimer) {
      clearTimeout(this.routeFlushTimer);
      this.routeFlushTimer = null;
    }
    await this.routeFlushInFlight;
    await this.flushRouteOutcomes();
    await Promise.allSettled([...this.receiptObservationSettlements]);
    await this.redis.quit();
  }

  async recordReceiptPersistence(metric: WebhookReceiptPersistenceMetric): Promise<void> {
    const botId = metric.botId.trim();
    if (!botId) {
      return;
    }

    const nowMs = Date.now();
    const latencyMs = this.normalizeLatency(metric.latencyMs);
    const latencyBucket = this.resolveLatencyBucketIndex(latencyMs);
    const key = this.buildBucketKey(nowMs);
    try {
      await this.redis.eval(
        RECORD_RECEIPT_LUA,
        2,
        key,
        RETENTION_PRIORITY_TRAFFIC_KEY_PREFIX,
        metric.outcome,
        Buffer.from(botId, 'utf8').toString('base64url'),
        String(latencyBucket),
        String(latencyMs),
        latencyMs <= this.targetMs ? '1' : '0',
        String(this.retentionSec),
        String(RETENTION_PRIORITY_TRAFFIC_TTL_SEC),
      );
    } catch {
      await this.redis
        .set(HIGHER_PRIORITY_ACTIVITY_UNAVAILABLE_KEY, 'receipt_counter_unknown', 'NX')
        .catch(() => undefined);
      this.logWriteFailure();
    }
  }

  async observeReceiptWork<T>(operation: () => Promise<T>): Promise<T> {
    const operationId = `receipt:${randomUUID()}`;
    let acquired = false;
    const unavailable = async () => {
      await this.redis
        .set(HIGHER_PRIORITY_ACTIVITY_UNAVAILABLE_KEY, 'receipt_observation_unknown', 'NX')
        .catch(() => undefined);
    };
    try {
      acquired =
        (await this.redis.eval(
          HIGHER_PRIORITY_ACTIVITY_ACQUIRE_SCRIPT,
          2,
          HIGHER_PRIORITY_ACTIVITY_KEY,
          HIGHER_PRIORITY_ACTIVITY_UNAVAILABLE_KEY,
          operationId,
          String(HIGHER_PRIORITY_ACTIVITY_LEASE_MS),
        )) === 1;
      if (!acquired) await unavailable();
    } catch {
      await unavailable();
    }
    let renewing: Promise<void> | null = null;
    const timer = acquired
      ? setInterval(() => {
          if (renewing) return;
          renewing = this.redis
            .eval(
              HIGHER_PRIORITY_ACTIVITY_RENEW_SCRIPT,
              3,
              HIGHER_PRIORITY_ACTIVITY_KEY,
              HIGHER_PRIORITY_ACTIVITY_UNAVAILABLE_KEY,
              activityReleaseReceiptKey(operationId),
              operationId,
              String(HIGHER_PRIORITY_ACTIVITY_LEASE_MS),
            )
            .then(async (result) => {
              if (result !== 1) await unavailable();
            })
            .catch(unavailable)
            .finally(() => {
              renewing = null;
            });
        }, HIGHER_PRIORITY_ACTIVITY_RENEW_MS)
      : null;
    timer?.unref();
    try {
      // FLAG: The caller's ACK timeout does not own this observation. Its exact
      // lease follows the actual SQL operation until that operation settles.
      return await operation();
    } finally {
      if (timer) clearInterval(timer);
      if (acquired) {
        // FLAG: SQL completion owns the ACK result. Observation settlement stays
        // tracked independently; its marker remains until Redis confirms release.
        const settlement: Promise<void> = (async () => {
          await renewing;
          await settleHigherPriorityActivity(this.redis, operationId);
        })()
          .catch(unavailable)
          .finally(() => this.receiptObservationSettlements.delete(settlement));
        this.receiptObservationSettlements.add(settlement);
      }
    }
  }

  recordRouteOutcome(metric: MaxWebhookRouteOutcomeMetric): void {
    if (this.destroying || !this.isRouteOutcome(metric.outcome)) {
      return;
    }

    const key = this.buildBucketKey(Date.now());
    this.incrementPendingRouteField(key, 'route:attempted');
    this.incrementPendingRouteField(key, `route:outcome:${metric.outcome}`);
    const botId = metric.botId?.trim() ?? '';
    if (botId) {
      const encodedBotId = Buffer.from(botId, 'utf8').toString('base64url');
      this.incrementPendingRouteField(key, `route:bot:${encodedBotId}:attempted`);
      this.incrementPendingRouteField(key, `route:bot:${encodedBotId}:outcome:${metric.outcome}`);
    }
    this.scheduleRouteOutcomeFlush();
  }

  recordMembershipCacheMutation(metric: AdminAccessEpochMutationMetric): void {
    if (metric.phase === 'precheck') {
      if (metric.outcome !== 'hit' && metric.outcome !== 'miss' && metric.outcome !== 'fail_open') {
        return;
      }
      this.recordMembershipCacheMetric('precheck', metric.outcome, metric.durationMs);
      return;
    }

    if (
      metric.outcome !== 'applied' &&
      metric.outcome !== 'superseded' &&
      metric.outcome !== 'conflict' &&
      metric.outcome !== 'retry' &&
      metric.outcome !== 'exhausted' &&
      metric.outcome !== 'failed'
    ) {
      return;
    }
    this.recordMembershipCacheMetric('lua', metric.outcome, metric.durationMs);
  }

  recordMembershipCacheBudget(metric: WebhookMembershipCacheBudgetMetric): void {
    if (metric.outcome !== 'completed' && metric.outcome !== 'timeout') {
      return;
    }
    this.recordMembershipCacheMetric('budget', metric.outcome, metric.durationMs);
  }

  recordMembershipCacheDetachedWork(metric: WebhookMembershipCacheDetachedWorkMetric): void {
    if (this.destroying) {
      return;
    }
    const key = this.buildBucketKey(Date.now());
    const inFlight = Number.isFinite(metric.inFlight)
      ? Math.min(1_024, Math.max(0, Math.trunc(metric.inFlight)))
      : 0;
    this.incrementPendingRouteField(key, `membership_cache:detached:in_flight:${inFlight}`);
    if (metric.outcome) {
      this.incrementPendingRouteField(
        key,
        `membership_cache:detached:${metric.outcome}`,
        metric.count,
      );
    }
    this.scheduleRouteOutcomeFlush();
  }

  recordMembershipAccessEdgeAdvance(metric: WebhookMembershipAccessEdgeAdvanceMetric): void {
    if (this.destroying) {
      return;
    }
    const affectedRows = Number.isFinite(metric.affectedRows)
      ? Math.max(0, Math.trunc(metric.affectedRows))
      : 0;
    const durationMs = this.normalizeLatency(metric.durationMs);
    const key = this.buildBucketKey(Date.now());
    this.incrementPendingRouteField(key, 'membership_transition:edge_advance:calls');
    this.incrementPendingRouteField(
      key,
      'membership_transition:edge_advance:affected_rows',
      affectedRows,
    );
    if (affectedRows === 0) {
      this.incrementPendingRouteField(key, 'membership_transition:edge_advance:no_op_calls');
    }
    const bucket = this.resolveBucketIndex(
      durationMs,
      MEMBERSHIP_CACHE_DURATION_BUCKET_UPPER_BOUNDS_MS,
    );
    this.incrementPendingRouteField(key, `membership_transition:edge_advance:duration:${bucket}`);
    this.scheduleRouteOutcomeFlush();
  }

  async getSnapshot(options: { windowSec: number }): Promise<WebhookIngressMetricsSnapshot> {
    await this.flushRouteOutcomes();
    const windowSec = this.normalizeWindowSec(options.windowSec, DEFAULT_SLO_WINDOW_SEC);
    const nowMs = Date.now();
    const keys = this.buildWindowKeys(nowMs, windowSec);
    try {
      const pipeline = this.redis.pipeline();
      for (const key of keys) {
        pipeline.hgetall(key);
      }
      const results = await pipeline.exec();
      if (!results) {
        throw new Error('Redis ingress metrics pipeline returned no result');
      }

      const rows = results.map(([error, value]) => {
        if (error) {
          throw error;
        }
        return this.isStringRecord(value) ? value : {};
      });
      return this.aggregateRows(rows);
    } catch {
      this.logReadFailure();
      return this.emptySnapshot(false);
    }
  }

  private aggregateRows(
    rows: ReadonlyArray<Record<string, string>>,
  ): WebhookIngressMetricsSnapshot {
    let attemptedReceipts = 0;
    let persistedReceipts = 0;
    let failedReceipts = 0;
    let rejectedReceipts = 0;
    let underTargetReceipts = 0;
    let maxLatencyMs = 0;
    const latencyBuckets = LATENCY_BUCKET_UPPER_BOUNDS_MS.map(() => 0).concat(0);
    const bots = new Map<string, WebhookIngressBotMetrics>();
    const route = this.emptyRouteMetrics();
    const routeBots = new Map<string, WebhookRouteBotMetrics>();

    for (const row of rows) {
      attemptedReceipts += this.readCounter(row.attempted);
      persistedReceipts += this.readCounter(row.persisted);
      failedReceipts += this.readCounter(row.failed);
      rejectedReceipts += this.readCounter(row.rejected);
      underTargetReceipts += this.readCounter(row.under_target);
      maxLatencyMs = Math.max(maxLatencyMs, this.readCounter(row.max_latency_ms));
      route.attemptedRequests += this.readCounter(row['route:attempted']);
      for (const outcome of MAX_WEBHOOK_ROUTE_OUTCOMES) {
        route.outcomes[outcome] += this.readCounter(row[`route:outcome:${outcome}`]);
      }

      for (let index = 0; index < latencyBuckets.length; index += 1) {
        latencyBuckets[index] =
          (latencyBuckets[index] ?? 0) + this.readCounter(row[`latency:${index}`]);
      }

      for (const [field, rawCount] of Object.entries(row)) {
        const match = /^bot:([^:]+):(attempted|persisted|failed|rejected)$/u.exec(field);
        if (!match) {
          continue;
        }
        const botId = this.decodeBotId(match[1] ?? '');
        if (!botId) {
          continue;
        }
        const counters = bots.get(botId) ?? {
          attemptedReceipts: 0,
          persistedReceipts: 0,
          failedReceipts: 0,
          rejectedReceipts: 0,
        };
        const count = this.readCounter(rawCount);
        if (match[2] === 'attempted') {
          counters.attemptedReceipts += count;
        } else if (match[2] === 'persisted') {
          counters.persistedReceipts += count;
        } else if (match[2] === 'failed') {
          counters.failedReceipts += count;
        } else {
          counters.rejectedReceipts += count;
        }
        bots.set(botId, counters);
      }

      for (const [field, rawCount] of Object.entries(row)) {
        const match = /^route:bot:([^:]+):(attempted|outcome:([a-z_]+))$/u.exec(field);
        if (!match) {
          continue;
        }
        const botId = this.decodeBotId(match[1] ?? '');
        if (!botId) {
          continue;
        }
        const counters = routeBots.get(botId) ?? {
          attemptedRequests: 0,
          outcomes: this.emptyRouteOutcomeCounts(),
        };
        const count = this.readCounter(rawCount);
        if (match[2] === 'attempted') {
          counters.attemptedRequests += count;
        } else {
          const outcome = match[3];
          if (this.isRouteOutcome(outcome)) {
            counters.outcomes[outcome] += count;
          }
        }
        routeBots.set(botId, counters);
      }
    }

    route.bots = Object.fromEntries(
      [...routeBots.entries()].sort(([left], [right]) => left.localeCompare(right)),
    );

    const sampledReceipts = latencyBuckets.reduce((sum, count) => sum + count, 0);
    return {
      available: true,
      targetMs: this.targetMs,
      attemptedReceipts,
      persistedReceipts,
      failedReceipts,
      rejectedReceipts,
      sampledReceipts,
      p95LatencyMs: this.percentile(latencyBuckets, sampledReceipts, 0.95, maxLatencyMs),
      p99LatencyMs: this.percentile(latencyBuckets, sampledReceipts, 0.99, maxLatencyMs),
      underTargetRatio:
        sampledReceipts > 0
          ? Number((Math.min(sampledReceipts, underTargetReceipts) / sampledReceipts).toFixed(3))
          : null,
      bots: Object.fromEntries(
        [...bots.entries()].sort(([left], [right]) => left.localeCompare(right)),
      ),
      route,
      membershipCache: this.aggregateMembershipCacheMetrics(rows),
      membershipTransition: this.aggregateMembershipTransitionMetrics(rows),
    };
  }

  private recordMembershipCacheMetric(
    stage: MembershipCacheTimingStage,
    outcome: string,
    durationMs?: number,
  ): void {
    if (this.destroying) {
      return;
    }
    const key = this.buildBucketKey(Date.now());
    this.incrementPendingRouteField(key, `membership_cache:${stage}:${outcome}`);
    if (durationMs !== undefined) {
      const normalizedDurationMs = this.normalizeLatency(durationMs);
      const bucket = this.resolveBucketIndex(
        normalizedDurationMs,
        MEMBERSHIP_CACHE_DURATION_BUCKET_UPPER_BOUNDS_MS,
      );
      this.incrementPendingRouteField(key, `membership_cache:duration:${stage}:${bucket}`);
    }
    this.scheduleRouteOutcomeFlush();
  }

  private aggregateMembershipCacheMetrics(
    rows: ReadonlyArray<Record<string, string>>,
  ): WebhookMembershipCacheMetrics {
    const metrics = this.emptyMembershipCacheMetrics();
    const timingBuckets = Object.fromEntries(
      MEMBERSHIP_CACHE_TIMING_STAGES.map((stage) => [
        stage,
        MEMBERSHIP_CACHE_DURATION_BUCKET_UPPER_BOUNDS_MS.map(() => 0).concat(0),
      ]),
    ) as Record<MembershipCacheTimingStage, number[]>;

    for (const row of rows) {
      metrics.precheck.hit += this.readCounter(row['membership_cache:precheck:hit']);
      metrics.precheck.miss += this.readCounter(row['membership_cache:precheck:miss']);
      metrics.precheck.failOpen += this.readCounter(row['membership_cache:precheck:fail_open']);
      metrics.lua.applied += this.readCounter(row['membership_cache:lua:applied']);
      metrics.lua.superseded += this.readCounter(row['membership_cache:lua:superseded']);
      metrics.lua.conflict += this.readCounter(row['membership_cache:lua:conflict']);
      metrics.lua.retry += this.readCounter(row['membership_cache:lua:retry']);
      metrics.lua.exhausted += this.readCounter(row['membership_cache:lua:exhausted']);
      metrics.lua.failed += this.readCounter(row['membership_cache:lua:failed']);
      metrics.budget.completed += this.readCounter(row['membership_cache:budget:completed']);
      metrics.budget.timeout += this.readCounter(row['membership_cache:budget:timeout']);
      if (metrics.detached) {
        metrics.detached.completed += this.readCounter(row['membership_cache:detached:completed']);
        metrics.detached.timeout += this.readCounter(row['membership_cache:detached:timeout']);
        metrics.detached.failure += this.readCounter(row['membership_cache:detached:failure']);
        metrics.detached.rejected += this.readCounter(row['membership_cache:detached:rejected']);
        for (const [field, rawCount] of Object.entries(row)) {
          const match = /^membership_cache:detached:in_flight:(\d+)$/u.exec(field);
          if (match && this.readCounter(rawCount) > 0) {
            metrics.detached.peakInFlight = Math.max(
              metrics.detached.peakInFlight,
              Math.min(1_024, Number(match[1])),
            );
          }
        }
      }

      for (const stage of MEMBERSHIP_CACHE_TIMING_STAGES) {
        for (let index = 0; index < timingBuckets[stage].length; index += 1) {
          timingBuckets[stage][index] =
            (timingBuckets[stage][index] ?? 0) +
            this.readCounter(row[`membership_cache:duration:${stage}:${index}`]);
        }
      }
    }

    metrics.precheck.timing = this.buildMembershipCacheTimingMetrics(timingBuckets.precheck);
    metrics.lua.timing = this.buildMembershipCacheTimingMetrics(timingBuckets.lua);
    metrics.budget.timing = this.buildMembershipCacheTimingMetrics(timingBuckets.budget);
    return metrics;
  }

  private buildMembershipCacheTimingMetrics(
    buckets: readonly number[],
  ): WebhookMembershipCacheTimingMetrics {
    const sampled = buckets.reduce((sum, count) => sum + count, 0);
    const overflowSamples = buckets.at(-1) ?? 0;
    const overflowBoundMs =
      MEMBERSHIP_CACHE_DURATION_BUCKET_UPPER_BOUNDS_MS[
        MEMBERSHIP_CACHE_DURATION_BUCKET_UPPER_BOUNDS_MS.length - 1
      ] ?? 0;
    return {
      sampled,
      p95DurationMs: this.percentile(
        buckets,
        sampled,
        0.95,
        overflowBoundMs,
        MEMBERSHIP_CACHE_DURATION_BUCKET_UPPER_BOUNDS_MS,
      ),
      p99DurationMs: this.percentile(
        buckets,
        sampled,
        0.99,
        overflowBoundMs,
        MEMBERSHIP_CACHE_DURATION_BUCKET_UPPER_BOUNDS_MS,
      ),
      overflowSamples,
    };
  }

  private aggregateMembershipTransitionMetrics(
    rows: ReadonlyArray<Record<string, string>>,
  ): WebhookMembershipTransitionMetrics {
    const metrics = this.emptyMembershipTransitionMetrics();
    const timingBuckets = MEMBERSHIP_CACHE_DURATION_BUCKET_UPPER_BOUNDS_MS.map(() => 0).concat(0);
    for (const row of rows) {
      metrics.edgeAdvance.calls += this.readCounter(
        row['membership_transition:edge_advance:calls'],
      );
      metrics.edgeAdvance.affectedRows += this.readCounter(
        row['membership_transition:edge_advance:affected_rows'],
      );
      metrics.edgeAdvance.noOpCalls += this.readCounter(
        row['membership_transition:edge_advance:no_op_calls'],
      );
      for (let index = 0; index < timingBuckets.length; index += 1) {
        timingBuckets[index] =
          (timingBuckets[index] ?? 0) +
          this.readCounter(row[`membership_transition:edge_advance:duration:${index}`]);
      }
    }
    metrics.edgeAdvance.timing = this.buildMembershipCacheTimingMetrics(timingBuckets);
    return metrics;
  }

  private incrementPendingRouteField(key: string, field: string, amount = 1): void {
    const normalizedAmount = Number.isFinite(amount) ? Math.max(0, Math.trunc(amount)) : 0;
    if (normalizedAmount === 0) {
      return;
    }
    const fields = this.pendingRouteFieldsByKey.get(key) ?? new Map<string, number>();
    fields.set(field, (fields.get(field) ?? 0) + normalizedAmount);
    this.pendingRouteFieldsByKey.set(key, fields);
  }

  private scheduleRouteOutcomeFlush(): void {
    if (this.routeFlushTimer || this.destroying) {
      return;
    }
    this.routeFlushTimer = setTimeout(() => {
      this.routeFlushTimer = null;
      void this.flushRouteOutcomes();
    }, ROUTE_METRICS_FLUSH_INTERVAL_MS);
    this.routeFlushTimer.unref();
  }

  private flushRouteOutcomes(): Promise<void> {
    if (this.routeFlushInFlight) {
      return this.routeFlushInFlight;
    }
    if (this.pendingRouteFieldsByKey.size === 0) {
      return Promise.resolve();
    }

    const batches = [...this.pendingRouteFieldsByKey.entries()];
    this.pendingRouteFieldsByKey.clear();
    const flush = Promise.all(
      batches.map(([key, fields]) =>
        this.redis.eval(
          RECORD_ROUTE_OUTCOMES_LUA,
          1,
          key,
          String(this.retentionSec),
          ...[...fields.entries()].flatMap(([field, count]) => [field, String(count)]),
        ),
      ),
    )
      .then(() => undefined)
      .catch(() => {
        this.logWriteFailure();
      })
      .finally(() => {
        this.routeFlushInFlight = null;
        if (this.pendingRouteFieldsByKey.size > 0 && !this.destroying) {
          this.scheduleRouteOutcomeFlush();
        }
      });
    this.routeFlushInFlight = flush;
    return flush;
  }

  private percentile(
    buckets: readonly number[],
    total: number,
    percentile: number,
    maxLatencyMs: number,
    upperBoundsMs: readonly number[] = LATENCY_BUCKET_UPPER_BOUNDS_MS,
  ): number | null {
    if (total <= 0) {
      return null;
    }
    const rank = Math.max(1, Math.ceil(total * percentile));
    let cumulative = 0;
    for (let index = 0; index < buckets.length; index += 1) {
      cumulative += buckets[index] ?? 0;
      if (cumulative < rank) {
        continue;
      }
      return index < upperBoundsMs.length
        ? (upperBoundsMs[index] ?? maxLatencyMs)
        : Math.max(maxLatencyMs, upperBoundsMs[upperBoundsMs.length - 1] ?? 0);
    }
    return maxLatencyMs;
  }

  private buildWindowKeys(nowMs: number, windowSec: number): string[] {
    const nowBucket = Math.floor(nowMs / (METRICS_BUCKET_SEC * 1_000));
    const firstBucket = Math.floor((nowMs - windowSec * 1_000) / (METRICS_BUCKET_SEC * 1_000));
    const keys: string[] = [];
    for (let bucket = firstBucket; bucket <= nowBucket; bucket += 1) {
      keys.push(`${METRICS_KEY_PREFIX}:${this.targetMs}:${bucket}`);
    }
    return keys;
  }

  private buildBucketKey(nowMs: number): string {
    return `${METRICS_KEY_PREFIX}:${this.targetMs}:${Math.floor(
      nowMs / (METRICS_BUCKET_SEC * 1_000),
    )}`;
  }

  private resolveLatencyBucketIndex(latencyMs: number): number {
    return this.resolveBucketIndex(latencyMs, LATENCY_BUCKET_UPPER_BOUNDS_MS);
  }

  private resolveBucketIndex(value: number, upperBounds: readonly number[]): number {
    const index = upperBounds.findIndex((upperBound) => value <= upperBound);
    return index >= 0 ? index : upperBounds.length;
  }

  private normalizeLatency(value: number): number {
    return Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
  }

  private decodeBotId(value: string): string | null {
    try {
      const decoded = Buffer.from(value, 'base64url').toString('utf8').trim();
      return decoded.length > 0 ? decoded : null;
    } catch {
      return null;
    }
  }

  private readCounter(value: string | undefined): number {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : 0;
  }

  private readPositiveInt(value: unknown, fallback: number): number {
    const parsed = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? Math.max(1, Math.trunc(parsed)) : fallback;
  }

  private normalizeWindowSec(value: unknown, fallback: number): number {
    return Math.min(MAX_SLO_WINDOW_SEC, this.readPositiveInt(value, fallback));
  }

  private isRouteOutcome(value: unknown): value is MaxWebhookRouteOutcome {
    return MAX_WEBHOOK_ROUTE_OUTCOMES.some((outcome) => outcome === value);
  }

  private emptyRouteOutcomeCounts(): WebhookRouteOutcomeCounts {
    return {
      accepted: 0,
      authentication_rejected: 0,
      admission_rejected: 0,
      invalid_json: 0,
      invalid_payload: 0,
      payload_too_large: 0,
      timed_out: 0,
      failed: 0,
    };
  }

  private emptyRouteMetrics(): WebhookRouteMetrics {
    return {
      attemptedRequests: 0,
      outcomes: this.emptyRouteOutcomeCounts(),
      bots: {},
    };
  }

  private emptyMembershipCacheTimingMetrics(): WebhookMembershipCacheTimingMetrics {
    return {
      sampled: 0,
      p95DurationMs: null,
      p99DurationMs: null,
      overflowSamples: 0,
    };
  }

  private emptyMembershipCacheMetrics(): WebhookMembershipCacheMetrics {
    return {
      precheck: {
        hit: 0,
        miss: 0,
        failOpen: 0,
        timing: this.emptyMembershipCacheTimingMetrics(),
      },
      lua: {
        applied: 0,
        superseded: 0,
        conflict: 0,
        retry: 0,
        exhausted: 0,
        failed: 0,
        timing: this.emptyMembershipCacheTimingMetrics(),
      },
      budget: {
        completed: 0,
        timeout: 0,
        timing: this.emptyMembershipCacheTimingMetrics(),
      },
      detached: {
        completed: 0,
        timeout: 0,
        failure: 0,
        peakInFlight: 0,
        rejected: 0,
      },
    };
  }

  private emptyMembershipTransitionMetrics(): WebhookMembershipTransitionMetrics {
    return {
      edgeAdvance: {
        calls: 0,
        affectedRows: 0,
        noOpCalls: 0,
        timing: this.emptyMembershipCacheTimingMetrics(),
      },
    };
  }

  private isStringRecord(value: unknown): value is Record<string, string> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }

  private emptySnapshot(available: boolean): WebhookIngressMetricsSnapshot {
    return {
      available,
      targetMs: this.targetMs,
      attemptedReceipts: 0,
      persistedReceipts: 0,
      failedReceipts: 0,
      rejectedReceipts: 0,
      sampledReceipts: 0,
      p95LatencyMs: null,
      p99LatencyMs: null,
      underTargetRatio: null,
      bots: {},
      route: this.emptyRouteMetrics(),
      membershipCache: this.emptyMembershipCacheMetrics(),
      membershipTransition: this.emptyMembershipTransitionMetrics(),
    };
  }

  private logWriteFailure(): void {
    const nowMs = Date.now();
    if (nowMs - this.lastWriteFailureLogAtMs < METRICS_FAILURE_LOG_INTERVAL_MS) {
      return;
    }
    this.lastWriteFailureLogAtMs = nowMs;
    this.logger.warn('Webhook ingress metrics write failed; webhook ACK was not affected');
  }

  private logReadFailure(): void {
    const nowMs = Date.now();
    if (nowMs - this.lastReadFailureLogAtMs < METRICS_FAILURE_LOG_INTERVAL_MS) {
      return;
    }
    this.lastReadFailureLogAtMs = nowMs;
    this.logger.warn('Webhook ingress metrics snapshot is temporarily unavailable');
  }
}
