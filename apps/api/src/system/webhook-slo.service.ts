import { Injectable, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, WebhookStatus } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import {
  WebhookIngressMetricsService,
  type WebhookIngressMetricsSnapshot,
  type WebhookMembershipCacheMetrics,
} from './webhook-ingress-metrics.service';

export type WebhookSloSnapshot = {
  status: 'healthy' | 'warning' | 'critical';
  windowSec: number;
  targetProcessingMs: number;
  totalEvents: number;
  processedEvents: number;
  failedEvents: number;
  sampleLimit: number;
  sampledProcessedEvents: number;
  processedSampleTruncated: boolean;
  processedSampledFrom: string | null;
  p95ProcessingMs: number | null;
  p99ProcessingMs: number | null;
  underTargetRatio: number | null;
  oldestUnprocessedLagSec: number;
  oldestUnprocessedEventId: string | null;
  lastProcessedAt: string | null;
  ingress: WebhookIngressMetricsSnapshot;
  membershipCache: WebhookMembershipCacheSloSnapshot;
  enqueue: WebhookEnqueueSloSnapshot;
  canonicalExecution: WebhookCanonicalExecutionSloSnapshot;
  generatedAt: string;
};

export type WebhookMembershipCacheAlertSignal = {
  sampled: number;
  affected: number;
  ratio: number | null;
};

export type WebhookMembershipCacheSloSnapshot = {
  status: 'healthy' | 'warning' | 'critical';
  precheckFailOpen: WebhookMembershipCacheAlertSignal;
  luaConflict: WebhookMembershipCacheAlertSignal;
  luaTerminalFailure: WebhookMembershipCacheAlertSignal;
  budgetTimeout: WebhookMembershipCacheAlertSignal;
  detachedFailure: WebhookMembershipCacheAlertSignal;
  thresholds: {
    warning: WebhookMembershipCacheAlertThreshold;
    critical: WebhookMembershipCacheAlertThreshold;
  };
};

export type WebhookMembershipCacheAlertThreshold = {
  minimumSamples: number;
  minimumAffected: number;
  ratio: number;
};

export type WebhookCanonicalExecutionSloSnapshot = {
  receipts: number;
  executionClaims: number;
  claimsPerReceiptRatio: number | null;
};

export type WebhookEnqueueSloSnapshot = {
  targetMs: number;
  sampledEvents: number;
  sampleTruncated: boolean;
  sampledFrom: string | null;
  p95LatencyMs: number | null;
  p99LatencyMs: number | null;
  underTargetRatio: number | null;
  oldestPendingLagSec: number;
  oldestPendingEventId: string | null;
  lastQueuedAt: string | null;
};

const DEFAULT_WEBHOOK_SLO_WINDOW_SEC = 15 * 60;
const DEFAULT_WEBHOOK_SLO_TARGET_MS = 400;
const DEFAULT_WEBHOOK_ENQUEUE_SLO_TARGET_MS = 1_000;
const DEFAULT_WEBHOOK_SLO_SAMPLE_LIMIT = 5_000;
const MAX_WEBHOOK_SLO_SAMPLE_LIMIT = 5_000;
const WARNING_UNDER_TARGET_RATIO = 0.95;
const CRITICAL_UNDER_TARGET_RATIO = 0.85;
const WARNING_UNPROCESSED_LAG_SEC = 5;
const CRITICAL_UNPROCESSED_LAG_SEC = 15;
const WARNING_INGRESS_UNDER_TARGET_RATIO = 0.99;
const CRITICAL_INGRESS_FAILURE_COUNT = 5;
const MEMBERSHIP_CACHE_ALERT_THRESHOLDS = {
  warning: {
    minimumSamples: 20,
    minimumAffected: 3,
    ratio: 0.1,
  },
  critical: {
    minimumSamples: 50,
    minimumAffected: 10,
    ratio: 0.3,
  },
} as const satisfies WebhookMembershipCacheSloSnapshot['thresholds'];
const SERVICE_ROUTE_FAILURE_OUTCOMES = [
  'admission_rejected',
  'invalid_json',
  'invalid_payload',
  'payload_too_large',
  'timed_out',
  'failed',
] as const;

@Injectable()
export class WebhookSloService {
  private readonly windowSec: number;
  private readonly targetProcessingMs: number;
  private readonly targetEnqueueMs: number;
  private readonly sampleLimit: number;

  constructor(
    private readonly prisma: PrismaService,
    configService: ConfigService,
    @Optional() private readonly webhookIngressMetricsService?: WebhookIngressMetricsService,
  ) {
    this.windowSec = this.readPositiveInt(
      configService.get('SYSTEM_WEBHOOK_SLO_WINDOW_SEC'),
      DEFAULT_WEBHOOK_SLO_WINDOW_SEC,
    );
    this.targetProcessingMs = this.readPositiveInt(
      configService.get('SYSTEM_WEBHOOK_SLO_TARGET_MS'),
      DEFAULT_WEBHOOK_SLO_TARGET_MS,
    );
    this.targetEnqueueMs = this.readPositiveInt(
      configService.get('SYSTEM_WEBHOOK_ENQUEUE_SLO_TARGET_MS'),
      DEFAULT_WEBHOOK_ENQUEUE_SLO_TARGET_MS,
    );
    this.sampleLimit = Math.min(
      MAX_WEBHOOK_SLO_SAMPLE_LIMIT,
      this.readPositiveInt(
        configService.get('SYSTEM_WEBHOOK_SLO_SAMPLE_LIMIT'),
        DEFAULT_WEBHOOK_SLO_SAMPLE_LIMIT,
      ),
    );
  }

  async getSnapshot(): Promise<WebhookSloSnapshot> {
    const nowMs = Date.now();
    const generatedAt = new Date(nowMs);
    const from = new Date(nowMs - this.windowSec * 1_000);
    const createdAtWindow = { gte: from, lte: generatedAt };
    const ingressPromise = this.webhookIngressMetricsService
      ? this.webhookIngressMetricsService.getSnapshot({ windowSec: this.windowSec })
      : Promise.resolve(this.emptyIngressSnapshot());
    const databaseSnapshotPromise = this.prisma.$transaction(
      [
        this.prisma.webhookEvent.count({
          where: {
            createdAt: createdAtWindow,
          },
        }),
        this.prisma.webhookEvent.count({
          where: {
            createdAt: createdAtWindow,
            status: WebhookStatus.PROCESSED,
            processedAt: { not: null, lte: generatedAt },
          },
        }),
        this.prisma.webhookEvent.count({
          where: {
            createdAt: createdAtWindow,
            status: WebhookStatus.FAILED,
          },
        }),
        this.prisma.webhookEvent.findMany({
          where: {
            createdAt: createdAtWindow,
            status: WebhookStatus.PROCESSED,
            processedAt: { not: null, lte: generatedAt },
          },
          select: {
            createdAt: true,
            processedAt: true,
          },
          orderBy: {
            processedAt: 'desc',
          },
          take: this.sampleLimit + 1,
        }),
        this.prisma.webhookEvent.findMany({
          where: {
            createdAt: createdAtWindow,
            queuedAt: { not: null, lte: generatedAt },
          },
          select: {
            createdAt: true,
            queuedAt: true,
          },
          orderBy: {
            queuedAt: 'desc',
          },
          take: this.sampleLimit + 1,
        }),
        // FLAG: Backlog is not a receipt-window metric. Separate exact-status reads use
        // the status/created_at index and must retain old or previously enqueued receipts.
        this.prisma.webhookEvent.findFirst({
          where: { status: WebhookStatus.RECEIVED },
          select: {
            id: true,
            createdAt: true,
          },
          orderBy: {
            createdAt: 'asc',
          },
        }),
        this.prisma.webhookEvent.findFirst({
          where: { status: WebhookStatus.QUEUED },
          select: {
            id: true,
            createdAt: true,
          },
          orderBy: {
            createdAt: 'asc',
          },
        }),
        this.prisma.webhookEvent.findFirst({
          where: {
            createdAt: createdAtWindow,
            status: WebhookStatus.PROCESSED,
            processedAt: { not: null, lte: generatedAt },
          },
          select: {
            processedAt: true,
          },
          orderBy: {
            processedAt: 'desc',
          },
        }),
        this.prisma.webhookEvent.findFirst({
          where: {
            createdAt: createdAtWindow,
            queuedAt: { not: null, lte: generatedAt },
          },
          select: {
            queuedAt: true,
          },
          orderBy: {
            queuedAt: 'desc',
          },
        }),
        this.prisma.webhookExecutionClaim.count({
          where: {
            kind: 'EXECUTION',
            createdAt: createdAtWindow,
          },
        }),
      ],
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
    const [
      [
        totalEvents,
        processedEvents,
        failedEvents,
        loadedProcessedSample,
        loadedEnqueueSample,
        oldestPendingEnqueue,
        oldestQueued,
        lastProcessed,
        lastQueued,
        executionClaims,
      ],
      ingress,
    ] = await Promise.all([databaseSnapshotPromise, ingressPromise]);

    const oldestUnprocessed =
      oldestPendingEnqueue && oldestQueued
        ? oldestPendingEnqueue.createdAt <= oldestQueued.createdAt
          ? oldestPendingEnqueue
          : oldestQueued
        : (oldestPendingEnqueue ?? oldestQueued);
    const processedSampleTruncated = loadedProcessedSample.length > this.sampleLimit;
    const enqueueSampleTruncated = loadedEnqueueSample.length > this.sampleLimit;
    const processedSample = loadedProcessedSample.slice(0, this.sampleLimit);
    const enqueueSample = loadedEnqueueSample.slice(0, this.sampleLimit);
    const durations = processedSample
      .map((event) => {
        if (!event.processedAt) {
          return null;
        }
        return event.processedAt.getTime() - event.createdAt.getTime();
      })
      .filter(
        (value): value is number =>
          typeof value === 'number' && Number.isFinite(value) && value >= 0,
      )
      .sort((left, right) => left - right);
    const p95ProcessingMs = this.percentile(durations, 0.95);
    const p99ProcessingMs = this.percentile(durations, 0.99);
    const underTargetRatio =
      durations.length > 0
        ? Number(
            (
              durations.filter((durationMs) => durationMs <= this.targetProcessingMs).length /
              durations.length
            ).toFixed(3),
          )
        : null;
    const enqueueDurations = enqueueSample
      .map((event) => {
        if (!event.queuedAt) {
          return null;
        }
        return event.queuedAt.getTime() - event.createdAt.getTime();
      })
      .filter(
        (value): value is number =>
          typeof value === 'number' && Number.isFinite(value) && value >= 0,
      )
      .sort((left, right) => left - right);
    const enqueueUnderTargetRatio =
      enqueueDurations.length > 0
        ? Number(
            (
              enqueueDurations.filter((durationMs) => durationMs <= this.targetEnqueueMs).length /
              enqueueDurations.length
            ).toFixed(3),
          )
        : null;
    const oldestUnprocessedLagSec = oldestUnprocessed
      ? Number(Math.max(0, (nowMs - oldestUnprocessed.createdAt.getTime()) / 1_000).toFixed(3))
      : 0;
    const oldestPendingEnqueueLagSec = oldestPendingEnqueue
      ? Number(Math.max(0, (nowMs - oldestPendingEnqueue.createdAt.getTime()) / 1_000).toFixed(3))
      : 0;
    const membershipCache = this.buildMembershipCacheSloSnapshot(ingress);
    const status = this.resolveStatus({
      failedEvents,
      underTargetRatio,
      oldestUnprocessedLagSec,
      p95ProcessingMs,
      p99ProcessingMs,
      ingress,
      membershipCache,
    });

    return {
      status,
      windowSec: this.windowSec,
      targetProcessingMs: this.targetProcessingMs,
      totalEvents,
      processedEvents,
      failedEvents,
      sampleLimit: this.sampleLimit,
      // FLAG: The limit and truncation describe selected rows. Latency excludes invalid clocks.
      sampledProcessedEvents: processedSample.length,
      processedSampleTruncated,
      processedSampledFrom: this.readOldestSampleTimestamp(
        processedSample,
        (event) => event.processedAt,
      ),
      p95ProcessingMs,
      p99ProcessingMs,
      underTargetRatio,
      oldestUnprocessedLagSec,
      oldestUnprocessedEventId: oldestUnprocessed?.id ?? null,
      lastProcessedAt: lastProcessed?.processedAt?.toISOString() ?? null,
      ingress,
      membershipCache,
      enqueue: {
        targetMs: this.targetEnqueueMs,
        sampledEvents: enqueueSample.length,
        sampleTruncated: enqueueSampleTruncated,
        sampledFrom: this.readOldestSampleTimestamp(enqueueSample, (event) => event.queuedAt),
        p95LatencyMs: this.percentile(enqueueDurations, 0.95),
        p99LatencyMs: this.percentile(enqueueDurations, 0.99),
        underTargetRatio: enqueueUnderTargetRatio,
        oldestPendingLagSec: oldestPendingEnqueueLagSec,
        oldestPendingEventId: oldestPendingEnqueue?.id ?? null,
        lastQueuedAt: lastQueued?.queuedAt?.toISOString() ?? null,
      },
      canonicalExecution: {
        receipts: totalEvents,
        executionClaims,
        claimsPerReceiptRatio:
          totalEvents > 0 ? Number((executionClaims / totalEvents).toFixed(3)) : null,
      },
      generatedAt: generatedAt.toISOString(),
    };
  }

  private resolveStatus(params: {
    failedEvents: number;
    underTargetRatio: number | null;
    oldestUnprocessedLagSec: number;
    p95ProcessingMs: number | null;
    p99ProcessingMs: number | null;
    ingress: WebhookIngressMetricsSnapshot;
    membershipCache?: WebhookMembershipCacheSloSnapshot;
  }): WebhookSloSnapshot['status'] {
    const receiptFailureCount = params.ingress.failedReceipts + params.ingress.rejectedReceipts;
    const routeFailureCount = this.countServiceRouteFailures(params.ingress);
    const membershipCache =
      params.membershipCache ?? this.buildMembershipCacheSloSnapshot(params.ingress);
    if (
      params.oldestUnprocessedLagSec >= CRITICAL_UNPROCESSED_LAG_SEC ||
      (params.underTargetRatio !== null && params.underTargetRatio < CRITICAL_UNDER_TARGET_RATIO) ||
      (params.p99ProcessingMs !== null && params.p99ProcessingMs > 1_000) ||
      receiptFailureCount >= CRITICAL_INGRESS_FAILURE_COUNT ||
      routeFailureCount >= CRITICAL_INGRESS_FAILURE_COUNT ||
      membershipCache.status === 'critical' ||
      (params.ingress.p99LatencyMs !== null &&
        params.ingress.p99LatencyMs > params.ingress.targetMs)
    ) {
      return 'critical';
    }

    if (
      params.failedEvents > 0 ||
      params.oldestUnprocessedLagSec >= WARNING_UNPROCESSED_LAG_SEC ||
      (params.underTargetRatio !== null && params.underTargetRatio < WARNING_UNDER_TARGET_RATIO) ||
      (params.p95ProcessingMs !== null && params.p95ProcessingMs > this.targetProcessingMs) ||
      !params.ingress.available ||
      params.ingress.failedReceipts > 0 ||
      params.ingress.rejectedReceipts > 0 ||
      routeFailureCount > 0 ||
      membershipCache.status === 'warning' ||
      (params.ingress.underTargetRatio !== null &&
        params.ingress.underTargetRatio < WARNING_INGRESS_UNDER_TARGET_RATIO) ||
      (params.ingress.p95LatencyMs !== null &&
        params.ingress.p95LatencyMs > params.ingress.targetMs)
    ) {
      return 'warning';
    }

    return 'healthy';
  }

  private buildMembershipCacheSloSnapshot(
    ingress: WebhookIngressMetricsSnapshot,
  ): WebhookMembershipCacheSloSnapshot {
    const metrics = ingress.membershipCache ?? this.emptyMembershipCacheMetrics();
    const precheckFailOpen = this.buildMembershipCacheAlertSignal(
      metrics.precheck.hit + metrics.precheck.miss + metrics.precheck.failOpen,
      metrics.precheck.failOpen,
    );
    const luaConflict = this.buildMembershipCacheAlertSignal(
      metrics.lua.applied + metrics.lua.superseded + metrics.lua.conflict + metrics.lua.failed,
      metrics.lua.conflict,
    );
    const luaTerminalFailure = this.buildMembershipCacheAlertSignal(
      metrics.lua.applied + metrics.lua.superseded + metrics.lua.exhausted + metrics.lua.failed,
      metrics.lua.exhausted + metrics.lua.failed,
    );
    const budgetTimeout = this.buildMembershipCacheAlertSignal(
      metrics.budget.completed + metrics.budget.timeout,
      metrics.budget.timeout,
    );
    const detached = metrics.detached ?? {
      completed: 0,
      timeout: 0,
      failure: 0,
      peakInFlight: 0,
      rejected: 0,
    };
    const detachedFailure = this.buildMembershipCacheAlertSignal(
      detached.completed + detached.failure + detached.rejected,
      detached.failure + detached.rejected,
    );
    const signals = [
      precheckFailOpen,
      luaConflict,
      luaTerminalFailure,
      budgetTimeout,
      detachedFailure,
    ];
    const status = signals.some((signal) =>
      this.membershipCacheSignalExceeds(signal, MEMBERSHIP_CACHE_ALERT_THRESHOLDS.critical),
    )
      ? 'critical'
      : signals.some((signal) =>
            this.membershipCacheSignalExceeds(signal, MEMBERSHIP_CACHE_ALERT_THRESHOLDS.warning),
          )
        ? 'warning'
        : 'healthy';

    return {
      status,
      precheckFailOpen,
      luaConflict,
      luaTerminalFailure,
      budgetTimeout,
      detachedFailure,
      thresholds: MEMBERSHIP_CACHE_ALERT_THRESHOLDS,
    };
  }

  private buildMembershipCacheAlertSignal(
    sampled: number,
    affected: number,
  ): WebhookMembershipCacheAlertSignal {
    const boundedAffected = Math.min(sampled, affected);
    return {
      sampled,
      affected,
      ratio: sampled > 0 ? boundedAffected / sampled : null,
    };
  }

  private membershipCacheSignalExceeds(
    signal: WebhookMembershipCacheAlertSignal,
    threshold: WebhookMembershipCacheAlertThreshold,
  ): boolean {
    return (
      signal.sampled >= threshold.minimumSamples &&
      signal.affected >= threshold.minimumAffected &&
      signal.sampled > 0 &&
      Math.min(signal.sampled, signal.affected) / signal.sampled >= threshold.ratio
    );
  }

  private countServiceRouteFailures(ingress: WebhookIngressMetricsSnapshot): number {
    const outcomes = ingress.route?.outcomes;
    if (!outcomes) {
      return 0;
    }
    return SERVICE_ROUTE_FAILURE_OUTCOMES.reduce((total, outcome) => total + outcomes[outcome], 0);
  }

  private percentile(values: readonly number[], percentile: number): number | null {
    if (values.length === 0) {
      return null;
    }
    const index = Math.min(
      values.length - 1,
      Math.max(0, Math.ceil(values.length * percentile) - 1),
    );
    return Math.trunc(values[index] ?? 0);
  }

  private readOldestSampleTimestamp<Row>(
    rows: readonly Row[],
    readTimestamp: (row: Row) => Date | null,
  ): string | null {
    let oldest: Date | null = null;
    for (const row of rows) {
      const timestamp = readTimestamp(row);
      if (timestamp && Number.isFinite(timestamp.getTime()) && (!oldest || timestamp < oldest)) {
        oldest = timestamp;
      }
    }
    return oldest?.toISOString() ?? null;
  }

  private readPositiveInt(value: unknown, fallback: number): number {
    const numericValue = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(numericValue) || numericValue <= 0) {
      return fallback;
    }
    return Math.max(1, Math.trunc(numericValue));
  }

  private emptyIngressSnapshot(): WebhookIngressMetricsSnapshot {
    return {
      available: true,
      targetMs: 2_000,
      attemptedReceipts: 0,
      persistedReceipts: 0,
      failedReceipts: 0,
      rejectedReceipts: 0,
      sampledReceipts: 0,
      p95LatencyMs: null,
      p99LatencyMs: null,
      underTargetRatio: null,
      bots: {},
      route: {
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
      },
      membershipCache: this.emptyMembershipCacheMetrics(),
      membershipTransition: {
        edgeAdvance: {
          calls: 0,
          affectedRows: 0,
          noOpCalls: 0,
          timing: this.emptyMembershipCacheTimingMetrics(),
        },
      },
    };
  }

  private emptyMembershipCacheTimingMetrics() {
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
}
