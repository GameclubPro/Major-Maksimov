import {
  AUXILIARY_QUEUE_NAMES,
  RETENTION_PRIORITY_ADDITIONAL_QUEUE_NAMES,
  type AuxiliaryQueueName,
} from '../runtime/runtime-queue-inventory';
export { AUXILIARY_QUEUE_NAMES, type AuxiliaryQueueName } from '../runtime/runtime-queue-inventory';
import { InjectQueue, getQueueToken } from '@nestjs/bullmq';
import { Injectable, Optional } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { Prisma, WebhookStatus } from '../prisma/prisma-client';
import type { Queue } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service';
import {
  MAX_ACTION_ALL_QUEUE_NAMES,
  MAX_ACTION_LEGACY_QUEUE,
  type MaxActionQueueName,
} from '../max/max-action.queue';
import { MaxBotRegistryService } from '../max/max-bot-registry.service';
import { GLOBAL_SPAMMER_DENORM_QUEUE } from '../moderation/global-spammer-denorm.queue';
import { MESSAGE_DUPLICATE_QUEUE } from '../moderation/message-duplicate/message-duplicate.queue';
import {
  DEFAULT_WEBHOOK_WORKER_GROUP_NAMES,
  getDefaultWebhookHomeOwnerByQueue,
  getDefaultWebhookWorkerGroupQueues,
  type DefaultWebhookWorkerGroupName,
} from '../runtime/moderation-runtime';
import type { DefaultWebhookLeaseSummary } from '../runtime/default-webhook-dynamic-leases';
import { ActionHealthService, type ActionHealthSnapshot } from './action-health.service';
import { MaxActionLedgerWatchdogService } from './max-action-ledger-watchdog.service';
import { WebhookDynamicLeaseStatusService } from './webhook-dynamic-lease-status.service';
import {
  buildOldestPendingWebhookQuery,
  buildQuarantinedWebhookSampleQuery,
  type OldestPendingWebhook,
} from './webhook-oldest-pending';
import {
  buildWebhookOperationalLagQuery,
  resolveWebhookOperationalLag,
  type WebhookOperationalLagHead,
} from './webhook-operational-lag';
import {
  DEFAULT_WEBHOOK_QUEUE_NAMES,
  type DefaultWebhookQueueName,
  JOIN_WEBHOOK_QUEUE_NAMES,
  type JoinWebhookQueueName,
  LEGACY_WEBHOOK_QUEUE,
  WEBHOOK_QUEUE_BACKGROUND,
  WEBHOOK_QUEUE_CRITICAL,
} from '../webhook/webhook-queues';

export type QueueCounters = {
  waiting: number;
  prioritized: number;
  active: number;
  delayed: number;
  failed: number;
  completed: number;
};

export type OverviewQueueCounters = QueueCounters & {
  name: string;
  family: 'webhook' | 'actions' | 'auxiliary';
};

export type OverviewCounterRedis = {
  eval(script: string, numKeys: number, ...keys: string[]): Promise<unknown>;
};
export const READ_OVERVIEW_QUEUE_COUNTERS_LUA = `
local result = {}
local function waiting(key)
  local count = redis.call('LLEN', key)
  local marker = redis.call('LINDEX', key, -1)
  if marker and string.sub(marker, 1, 2) == '0:' then count = math.max(0, count - 1) end
  return count
end
for _, prefix in ipairs(KEYS) do
  result[#result + 1] = {
    waiting(prefix .. 'wait') + waiting(prefix .. 'paused'),
    redis.call('ZCARD', prefix .. 'prioritized'), redis.call('LLEN', prefix .. 'active'),
    redis.call('ZCARD', prefix .. 'delayed'), redis.call('ZCARD', prefix .. 'failed'),
    redis.call('ZCARD', prefix .. 'completed')
  }
end
return result
`;

export type WebhookStatusMetrics = {
  count: number;
  oldestEventId: string | null;
  oldestCreatedAt: string | null;
  oldestLagSec: number;
  activeCount?: number;
  staleCount?: number;
  activeWindowSec?: number;
};

export type WebhookDefaultWorkerGroupMetrics = {
  queues: DefaultWebhookQueueName[];
  counters: QueueCounters;
};

export type WebhookDynamicLeaseQueueMetrics = {
  homeOwner: DefaultWebhookWorkerGroupName;
  actualOwner: DefaultWebhookWorkerGroupName;
  desiredOwner: DefaultWebhookWorkerGroupName;
  eligibleForDynamicLeases: boolean;
  handoffPending: boolean;
  activeJobs: number;
  pressure: number;
  reason: string;
  claimFencingToken: number | null;
  claimLeaseUntil: string | null;
  lastHandoffAt: string | null;
};

export type WebhookDynamicLeaseMetricsSnapshot = {
  mode: DefaultWebhookLeaseSummary['mode'];
  generatedAt: string;
  liveWorkerGroups: DefaultWebhookWorkerGroupName[];
  queues: Record<DefaultWebhookQueueName, WebhookDynamicLeaseQueueMetrics>;
};

export type BotQueueMetricsSnapshot = {
  webhookEvents: {
    received: WebhookStatusMetrics;
    queued: WebhookStatusMetrics;
    failed: WebhookStatusMetrics;
  };
  userFacingWebhookEvents: {
    received: WebhookStatusMetrics;
    queued: WebhookStatusMetrics;
    failed: WebhookStatusMetrics;
  };
  queuedByQueue: Record<string, number>;
  actionHealth: ActionHealthSnapshot;
  oldestQueuedEventId: string | null;
  oldestQueuedCreatedAt: string | null;
  oldestQueuedLagSec: number;
  oldestReceivedEventId: string | null;
  oldestReceivedCreatedAt: string | null;
  oldestReceivedLagSec: number;
  effectiveLagSec: number;
  userFacingOldestQueuedEventId: string | null;
  userFacingOldestQueuedCreatedAt: string | null;
  userFacingOldestQueuedLagSec: number;
  userFacingOldestReceivedEventId: string | null;
  userFacingOldestReceivedCreatedAt: string | null;
  userFacingOldestReceivedLagSec: number;
  userFacingEffectiveLagSec: number;
};

export type QueueMetricsSnapshot = {
  moderation: QueueCounters;
  webhookCritical: QueueCounters;
  webhookJoin: QueueCounters;
  webhookJoinShards: Record<JoinWebhookQueueName, QueueCounters>;
  webhookDefault: QueueCounters;
  webhookDefaultShards: Record<DefaultWebhookQueueName, QueueCounters>;
  webhookDefaultWorkerGroups: Record<
    DefaultWebhookWorkerGroupName,
    WebhookDefaultWorkerGroupMetrics
  >;
  webhookBackground: QueueCounters;
  webhookLegacy: QueueCounters;
  actions: QueueCounters;
  actionQueues: Record<MaxActionQueueName, QueueCounters>;
  globalSpammerDenorm: QueueCounters;
  auxiliaryQueues: Record<AuxiliaryQueueName, QueueCounters>;
  webhookEvents: {
    received: WebhookStatusMetrics;
    queued: WebhookStatusMetrics;
    failed: WebhookStatusMetrics;
  };
  userFacingWebhookEvents: {
    received: WebhookStatusMetrics;
    queued: WebhookStatusMetrics;
    failed: WebhookStatusMetrics;
  };
  actionHealth: ActionHealthSnapshot;
  actionLedgerWatchdog: Awaited<ReturnType<MaxActionLedgerWatchdogService['getSnapshot']>> | null;
  webhookDynamicLeases: WebhookDynamicLeaseMetricsSnapshot | null;
  bots: Record<string, BotQueueMetricsSnapshot>;
  oldestQueuedEventId: string | null;
  oldestQueuedCreatedAt: string | null;
  oldestQueuedLagSec: number;
  oldestReceivedEventId: string | null;
  oldestReceivedCreatedAt: string | null;
  oldestReceivedLagSec: number;
  effectiveLagSec: number;
  userFacingOldestQueuedEventId: string | null;
  userFacingOldestQueuedCreatedAt: string | null;
  userFacingOldestQueuedLagSec: number;
  userFacingOldestReceivedEventId: string | null;
  userFacingOldestReceivedCreatedAt: string | null;
  userFacingOldestReceivedLagSec: number;
  userFacingEffectiveLagSec: number;
  generatedAt: string;
};

export type QueueLagSnapshot = {
  oldestQueuedEventId: string | null;
  oldestQueuedCreatedAt: string | null;
  oldestQueuedLagSec: number;
  oldestReceivedEventId: string | null;
  oldestReceivedCreatedAt: string | null;
  oldestReceivedLagSec: number;
  effectiveLagSec: number;
  operationalLagSec?: number;
  readinessWaitingCount?: number;
  readinessHeadLimitReached?: boolean;
  quarantinedCountLowerBound?: number;
  quarantineSampleLimitReached?: boolean;
  oldestQuarantinedAgeSec?: number;
  generatedAt: string;
};

export type OperationalQueueMetricsSnapshot = QueueLagSnapshot & {
  webhookDefaultShards: Record<DefaultWebhookQueueName, QueueCounters>;
  webhookDefaultWorkerGroups: Record<
    DefaultWebhookWorkerGroupName,
    WebhookDefaultWorkerGroupMetrics
  >;
  actions: QueueCounters;
  actionQueues: Record<MaxActionQueueName, QueueCounters>;
};

export type WebhookDefaultShardSnapshot = {
  webhookDefaultShards: Record<DefaultWebhookQueueName, QueueCounters>;
  webhookDefaultWorkerGroups: Record<
    DefaultWebhookWorkerGroupName,
    WebhookDefaultWorkerGroupMetrics
  >;
  generatedAt: string;
};

type QueueMetricsSnapshotOptions = {
  maxAgeMs?: number;
};

const EMPTY_COUNTERS: QueueCounters = {
  waiting: 0,
  prioritized: 0,
  active: 0,
  delayed: 0,
  failed: 0,
  completed: 0,
};

const EMPTY_WEBHOOK_STATUS_METRICS: WebhookStatusMetrics = {
  count: 0,
  oldestEventId: null,
  oldestCreatedAt: null,
  oldestLagSec: 0,
};
const ACTIVE_FAILED_WEBHOOK_WINDOW_SEC = 6 * 60 * 60;
export const USER_FACING_WEBHOOK_UPDATE_TYPES = [
  'message_created',
  'message_edited',
  'message_callback',
  'user_added',
  'bot_added',
  'bot_started',
] as const;

@Injectable()
export class QueueMetricsService {
  private snapshotCache: QueueMetricsSnapshot | null = null;
  private snapshotCacheAtMs = 0;
  private snapshotPromise: Promise<QueueMetricsSnapshot> | null = null;
  private operationalSnapshotCache: OperationalQueueMetricsSnapshot | null = null;
  private operationalSnapshotCacheAtMs = 0;
  private operationalSnapshotPromise: Promise<OperationalQueueMetricsSnapshot> | null = null;
  private lagSnapshotCache: QueueLagSnapshot | null = null;
  private lagSnapshotCacheAtMs = 0;
  private lagSnapshotPromise: Promise<QueueLagSnapshot> | null = null;
  private defaultShardSnapshotCache: WebhookDefaultShardSnapshot | null = null;
  private defaultShardSnapshotCacheAtMs = 0;
  private defaultShardSnapshotPromise: Promise<WebhookDefaultShardSnapshot> | null = null;
  private readonly webhookJoinQueuesByName: Record<JoinWebhookQueueName, Queue | undefined>;
  private readonly webhookDefaultQueuesByName: Record<DefaultWebhookQueueName, Queue | undefined>;
  private readonly auxiliaryQueuesByName: Record<AuxiliaryQueueName, Queue | undefined>;
  private readonly actionQueuesByName: Record<MaxActionQueueName, Queue | undefined>;

  constructor(
    private readonly prisma: PrismaService,
    private readonly actionHealthService: ActionHealthService,
    private readonly moduleRef: ModuleRef,
    private readonly maxBotRegistry: MaxBotRegistryService,
    @Optional()
    private readonly webhookDynamicLeaseStatusService?: WebhookDynamicLeaseStatusService,
    @Optional() @InjectQueue(WEBHOOK_QUEUE_CRITICAL) private readonly webhookCriticalQueue?: Queue,
    @Optional()
    @InjectQueue(WEBHOOK_QUEUE_BACKGROUND)
    private readonly webhookBackgroundQueue?: Queue,
    @Optional() @InjectQueue(LEGACY_WEBHOOK_QUEUE) private readonly webhookLegacyQueue?: Queue,
    @Optional() @InjectQueue(MAX_ACTION_LEGACY_QUEUE) private readonly actionQueue?: Queue,
    @Optional()
    @InjectQueue(GLOBAL_SPAMMER_DENORM_QUEUE)
    private readonly globalSpammerDenormQueue?: Queue,
    @Optional()
    private readonly actionLedgerWatchdogService?: MaxActionLedgerWatchdogService,
  ) {
    this.webhookJoinQueuesByName = Object.fromEntries(
      JOIN_WEBHOOK_QUEUE_NAMES.map((queueName) => [
        queueName,
        this.resolveOptionalQueue(queueName),
      ]),
    ) as Record<JoinWebhookQueueName, Queue | undefined>;
    this.webhookDefaultQueuesByName = Object.fromEntries(
      DEFAULT_WEBHOOK_QUEUE_NAMES.map((queueName) => [
        queueName,
        this.resolveOptionalQueue(queueName),
      ]),
    ) as Record<DefaultWebhookQueueName, Queue | undefined>;
    this.auxiliaryQueuesByName = Object.fromEntries(
      AUXILIARY_QUEUE_NAMES.map((queueName) => [queueName, this.resolveOptionalQueue(queueName)]),
    ) as Record<AuxiliaryQueueName, Queue | undefined>;
    this.actionQueuesByName = Object.fromEntries(
      MAX_ACTION_ALL_QUEUE_NAMES.map((queueName) => [
        queueName,
        queueName === MAX_ACTION_LEGACY_QUEUE
          ? (this.actionQueue ?? this.resolveOptionalQueue(queueName))
          : this.resolveOptionalQueue(queueName),
      ]),
    ) as Record<MaxActionQueueName, Queue | undefined>;
  }

  private resolveOptionalQueue(queueName: string): Queue | undefined {
    try {
      return this.moduleRef.get<Queue>(getQueueToken(queueName), { strict: false });
    } catch {
      return undefined;
    }
  }

  async getOverviewCounters(
    redis: OverviewCounterRedis,
  ): Promise<{ observedAt: string; rows: OverviewQueueCounters[] }> {
    const inventory: Array<{
      name: string;
      family: OverviewQueueCounters['family'];
      queue: Queue | undefined;
    }> = [
      { name: WEBHOOK_QUEUE_CRITICAL, family: 'webhook', queue: this.webhookCriticalQueue },
      { name: WEBHOOK_QUEUE_BACKGROUND, family: 'webhook', queue: this.webhookBackgroundQueue },
      { name: LEGACY_WEBHOOK_QUEUE, family: 'webhook', queue: this.webhookLegacyQueue },
      ...Object.entries(this.webhookJoinQueuesByName).map(([name, queue]) => ({
        name,
        family: 'webhook' as const,
        queue,
      })),
      ...Object.entries(this.webhookDefaultQueuesByName).map(([name, queue]) => ({
        name,
        family: 'webhook' as const,
        queue,
      })),
      ...Object.entries(this.actionQueuesByName).map(([name, queue]) => ({
        name,
        family: 'actions' as const,
        queue,
      })),
      ...Object.entries(this.auxiliaryQueuesByName).map(([name, queue]) => ({
        name,
        family: 'auxiliary' as const,
        queue,
      })),
      ...RETENTION_PRIORITY_ADDITIONAL_QUEUE_NAMES.map((name) => ({
        name,
        family: 'auxiliary' as const,
        queue: this.resolveOptionalQueue(name),
      })),
      {
        name: GLOBAL_SPAMMER_DENORM_QUEUE,
        family: 'auxiliary',
        queue: this.globalSpammerDenormQueue,
      },
    ];
    // FLAG: Missing providers and Redis failures are missing evidence, never idle queues.
    // Only fixed counters are read here; per-bot retained-history queries are forbidden.
    const observedAt = new Date().toISOString();
    const keys = inventory.map(({ queue }) => {
      if (!queue) throw new Error('Overview queue counters unavailable');
      return queue.toKey('');
    });
    // FLAG: BullMQ getJobCounts can mutate deprecated markers and wait indefinitely.
    // This fixed Lua read uses the collector's fail-fast connection and never removes work.
    const counts = await redis.eval(READ_OVERVIEW_QUEUE_COUNTERS_LUA, keys.length, ...keys);
    if (!Array.isArray(counts) || counts.length !== inventory.length)
      throw new Error('Invalid overview queue counters');
    const rows = inventory.map(({ name, family }, index) => {
      const values: unknown = counts[index];
      if (
        !Array.isArray(values) ||
        values.length !== 6 ||
        values.some(
          (value: unknown) =>
            typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0,
        )
      ) {
        throw new Error('Invalid overview queue counters');
      }
      return {
        name,
        family,
        waiting: values[0] as number,
        prioritized: values[1] as number,
        active: values[2] as number,
        delayed: values[3] as number,
        failed: values[4] as number,
        completed: values[5] as number,
      };
    });
    return { observedAt, rows };
  }

  async getSnapshot(options: QueueMetricsSnapshotOptions = {}): Promise<QueueMetricsSnapshot> {
    const maxAgeMs = options.maxAgeMs ?? 0;
    const cachedSnapshot = this.getCachedSnapshot(maxAgeMs);
    if (cachedSnapshot) {
      return cachedSnapshot;
    }

    if (this.snapshotPromise) {
      return this.snapshotPromise;
    }

    this.snapshotPromise = this.buildSnapshot();

    try {
      const snapshot = await this.snapshotPromise;
      this.snapshotCache = snapshot;
      this.snapshotCacheAtMs = Date.now();
      return snapshot;
    } finally {
      this.snapshotPromise = null;
    }
  }

  async getLagSnapshot(options: QueueMetricsSnapshotOptions = {}): Promise<QueueLagSnapshot> {
    const maxAgeMs = options.maxAgeMs ?? 0;
    const cachedSnapshot = this.getCachedLagSnapshot(maxAgeMs);
    if (cachedSnapshot) {
      return cachedSnapshot;
    }

    if (this.lagSnapshotPromise) {
      return this.lagSnapshotPromise;
    }

    this.lagSnapshotPromise = this.buildLagSnapshot();

    try {
      const snapshot = await this.lagSnapshotPromise;
      this.lagSnapshotCache = snapshot;
      this.lagSnapshotCacheAtMs = Date.now();
      return snapshot;
    } finally {
      this.lagSnapshotPromise = null;
    }
  }

  async getOperationalSnapshot(
    options: QueueMetricsSnapshotOptions = {},
  ): Promise<OperationalQueueMetricsSnapshot> {
    const maxAgeMs = options.maxAgeMs ?? 0;
    const cachedSnapshot = this.getCachedOperationalSnapshot(maxAgeMs);
    if (cachedSnapshot) {
      return cachedSnapshot;
    }

    if (this.operationalSnapshotPromise) {
      return this.operationalSnapshotPromise;
    }

    this.operationalSnapshotPromise = this.buildOperationalSnapshot();

    try {
      const snapshot = await this.operationalSnapshotPromise;
      this.operationalSnapshotCache = snapshot;
      this.operationalSnapshotCacheAtMs = Date.now();
      return snapshot;
    } finally {
      this.operationalSnapshotPromise = null;
    }
  }

  peekCachedSnapshot(maxAgeMs = Number.POSITIVE_INFINITY): QueueMetricsSnapshot | null {
    return this.getCachedSnapshot(maxAgeMs);
  }

  peekCachedLagSnapshot(maxAgeMs = Number.POSITIVE_INFINITY): QueueLagSnapshot | null {
    return this.getCachedLagSnapshot(maxAgeMs);
  }

  async getWebhookDefaultShardSnapshot(
    options: QueueMetricsSnapshotOptions = {},
  ): Promise<WebhookDefaultShardSnapshot> {
    const maxAgeMs = options.maxAgeMs ?? 0;
    const cachedSnapshot = this.getCachedDefaultShardSnapshot(maxAgeMs);
    if (cachedSnapshot) {
      return cachedSnapshot;
    }

    if (this.defaultShardSnapshotPromise) {
      return this.defaultShardSnapshotPromise;
    }

    this.defaultShardSnapshotPromise = this.buildWebhookDefaultShardSnapshot();

    try {
      const snapshot = await this.defaultShardSnapshotPromise;
      this.setDefaultShardSnapshotCache(snapshot);
      return snapshot;
    } finally {
      this.defaultShardSnapshotPromise = null;
    }
  }

  private getCachedSnapshot(maxAgeMs: number): QueueMetricsSnapshot | null {
    if (!this.snapshotCache || maxAgeMs <= 0) {
      return null;
    }

    if (Date.now() - this.snapshotCacheAtMs > maxAgeMs) {
      return null;
    }

    return this.snapshotCache;
  }

  private getCachedLagSnapshot(maxAgeMs: number): QueueLagSnapshot | null {
    if (!this.lagSnapshotCache || maxAgeMs <= 0) {
      return null;
    }

    if (Date.now() - this.lagSnapshotCacheAtMs > maxAgeMs) {
      return null;
    }

    return this.lagSnapshotCache;
  }

  private getCachedOperationalSnapshot(maxAgeMs: number): OperationalQueueMetricsSnapshot | null {
    if (!this.operationalSnapshotCache || maxAgeMs <= 0) {
      return null;
    }

    if (Date.now() - this.operationalSnapshotCacheAtMs > maxAgeMs) {
      return null;
    }

    return this.operationalSnapshotCache;
  }

  private getCachedDefaultShardSnapshot(maxAgeMs: number): WebhookDefaultShardSnapshot | null {
    if (!this.defaultShardSnapshotCache || maxAgeMs <= 0) {
      return null;
    }

    if (Date.now() - this.defaultShardSnapshotCacheAtMs > maxAgeMs) {
      return null;
    }

    return this.defaultShardSnapshotCache;
  }

  private setDefaultShardSnapshotCache(snapshot: WebhookDefaultShardSnapshot): void {
    this.defaultShardSnapshotCache = snapshot;
    this.defaultShardSnapshotCacheAtMs = Date.now();
  }

  private async buildOperationalSnapshot(): Promise<OperationalQueueMetricsSnapshot> {
    const [lagSnapshot, defaultShardSnapshot, actionQueueSnapshots] = await Promise.all([
      this.getLagSnapshot(),
      this.getWebhookDefaultShardSnapshot(),
      Promise.all(
        MAX_ACTION_ALL_QUEUE_NAMES.map((queueName) =>
          this.readQueueCounters(this.actionQueuesByName[queueName]),
        ),
      ),
    ]);
    const actionQueues = Object.fromEntries(
      MAX_ACTION_ALL_QUEUE_NAMES.map((queueName, index) => [
        queueName,
        actionQueueSnapshots[index] ?? { ...EMPTY_COUNTERS },
      ]),
    ) as Record<MaxActionQueueName, QueueCounters>;

    return {
      ...lagSnapshot,
      webhookDefaultShards: defaultShardSnapshot.webhookDefaultShards,
      webhookDefaultWorkerGroups: defaultShardSnapshot.webhookDefaultWorkerGroups,
      actions: this.sumQueueCounters(...Object.values(actionQueues)),
      actionQueues,
      generatedAt: new Date().toISOString(),
    };
  }

  private async buildSnapshot(): Promise<QueueMetricsSnapshot> {
    const botIds = (
      typeof this.maxBotRegistry.getOperationalBots === 'function'
        ? this.maxBotRegistry.getOperationalBots()
        : typeof this.maxBotRegistry.getAllBots === 'function'
          ? this.maxBotRegistry.getAllBots()
          : []
    ).map((bot) => bot.id);
    await this.actionHealthService.refreshSnapshots(60, botIds);
    const dynamicLeaseSummary = this.webhookDynamicLeaseStatusService
      ? await this.webhookDynamicLeaseStatusService.getSummary(2_000)
      : null;
    const defaultShardSnapshot = await this.buildWebhookDefaultShardSnapshot(dynamicLeaseSummary);
    this.setDefaultShardSnapshotCache(defaultShardSnapshot);

    const queueSnapshots = await Promise.all([
      this.readQueueCounters(this.webhookCriticalQueue),
      ...JOIN_WEBHOOK_QUEUE_NAMES.map((queueName) =>
        this.readQueueCounters(this.webhookJoinQueuesByName[queueName]),
      ),
      this.readQueueCounters(this.webhookBackgroundQueue),
      this.readQueueCounters(this.webhookLegacyQueue),
      this.readQueueCounters(this.globalSpammerDenormQueue),
      ...AUXILIARY_QUEUE_NAMES.map((queueName) => this.readAuxiliaryQueueCounters(queueName)),
    ]);
    const actionQueueSnapshots = await Promise.all(
      MAX_ACTION_ALL_QUEUE_NAMES.map((queueName) =>
        this.readQueueCounters(this.actionQueuesByName[queueName]),
      ),
    );
    const [received, queued, failed, userFacingReceived, userFacingQueued, userFacingFailed] =
      await Promise.all([
        this.readWebhookStatusMetrics(WebhookStatus.RECEIVED),
        this.readWebhookStatusMetrics(WebhookStatus.QUEUED),
        this.readWebhookStatusMetrics(WebhookStatus.FAILED),
        this.readWebhookStatusMetricsByTypes(
          WebhookStatus.RECEIVED,
          USER_FACING_WEBHOOK_UPDATE_TYPES,
        ),
        this.readWebhookStatusMetricsByTypes(
          WebhookStatus.QUEUED,
          USER_FACING_WEBHOOK_UPDATE_TYPES,
        ),
        this.readWebhookStatusMetricsByTypes(
          WebhookStatus.FAILED,
          USER_FACING_WEBHOOK_UPDATE_TYPES,
        ),
      ]);
    const bots = await this.buildPerBotSnapshots(botIds);
    const actionLedgerWatchdog = this.actionLedgerWatchdogService
      ? await this.actionLedgerWatchdogService.getSnapshot().catch(() => null)
      : null;

    const [webhookCritical, ...restSnapshots] = queueSnapshots;
    const webhookJoinShardSnapshots = restSnapshots.slice(0, JOIN_WEBHOOK_QUEUE_NAMES.length);
    const webhookJoinShards = Object.fromEntries(
      JOIN_WEBHOOK_QUEUE_NAMES.map((queueName, index) => [
        queueName,
        webhookJoinShardSnapshots[index] ?? { ...EMPTY_COUNTERS },
      ]),
    ) as Record<JoinWebhookQueueName, QueueCounters>;
    const webhookJoin = this.sumQueueCounters(...Object.values(webhookJoinShards));
    const defaultSnapshotOffset = JOIN_WEBHOOK_QUEUE_NAMES.length;
    const webhookBackground = restSnapshots[defaultSnapshotOffset] ?? EMPTY_COUNTERS;
    const webhookLegacy = restSnapshots[defaultSnapshotOffset + 1] ?? EMPTY_COUNTERS;
    const globalSpammerDenorm = restSnapshots[defaultSnapshotOffset + 2] ?? EMPTY_COUNTERS;
    const auxiliaryQueueSnapshotOffset = defaultSnapshotOffset + 3;
    const auxiliaryQueues = Object.fromEntries(
      AUXILIARY_QUEUE_NAMES.map((queueName, index) => [
        queueName,
        restSnapshots[auxiliaryQueueSnapshotOffset + index] ?? { ...EMPTY_COUNTERS },
      ]),
    ) as Record<AuxiliaryQueueName, QueueCounters>;
    const actionQueues = Object.fromEntries(
      MAX_ACTION_ALL_QUEUE_NAMES.map((queueName, index) => [
        queueName,
        actionQueueSnapshots[index] ?? { ...EMPTY_COUNTERS },
      ]),
    ) as Record<MaxActionQueueName, QueueCounters>;
    const actions = this.sumQueueCounters(...Object.values(actionQueues));
    const webhookDefaultShards = defaultShardSnapshot.webhookDefaultShards;
    const webhookDefault = this.sumQueueCounters(...Object.values(webhookDefaultShards));
    const webhookDefaultWorkerGroups = defaultShardSnapshot.webhookDefaultWorkerGroups;

    const actionHealth = this.actionHealthService.getSnapshot(60);
    const oldestQueuedLagSec = queued.oldestLagSec;
    const oldestReceivedLagSec = received.oldestLagSec;
    const effectiveLagSec = Math.max(oldestQueuedLagSec, oldestReceivedLagSec);
    const userFacingOldestQueuedLagSec = userFacingQueued.oldestLagSec;
    const userFacingOldestReceivedLagSec = userFacingReceived.oldestLagSec;
    const userFacingEffectiveLagSec = Math.max(
      userFacingOldestQueuedLagSec,
      userFacingOldestReceivedLagSec,
    );
    const moderation = this.sumQueueCounters(
      webhookCritical,
      webhookJoin,
      webhookDefault,
      webhookBackground,
      webhookLegacy,
    );

    return {
      moderation,
      webhookCritical,
      webhookJoin,
      webhookJoinShards,
      webhookDefault,
      webhookDefaultShards,
      webhookDefaultWorkerGroups,
      webhookBackground,
      webhookLegacy,
      actions,
      actionQueues,
      globalSpammerDenorm,
      auxiliaryQueues,
      webhookEvents: {
        received,
        queued,
        failed,
      },
      userFacingWebhookEvents: {
        received: userFacingReceived,
        queued: userFacingQueued,
        failed: userFacingFailed,
      },
      actionHealth,
      actionLedgerWatchdog,
      webhookDynamicLeases: dynamicLeaseSummary
        ? {
            mode: dynamicLeaseSummary.mode,
            generatedAt: dynamicLeaseSummary.generatedAt,
            liveWorkerGroups: [...dynamicLeaseSummary.liveWorkerGroups],
            queues: dynamicLeaseSummary.queues,
          }
        : null,
      bots,
      oldestQueuedEventId: queued.oldestEventId,
      oldestQueuedCreatedAt: queued.oldestCreatedAt,
      oldestQueuedLagSec,
      oldestReceivedEventId: received.oldestEventId,
      oldestReceivedCreatedAt: received.oldestCreatedAt,
      oldestReceivedLagSec,
      effectiveLagSec,
      userFacingOldestQueuedEventId: userFacingQueued.oldestEventId,
      userFacingOldestQueuedCreatedAt: userFacingQueued.oldestCreatedAt,
      userFacingOldestQueuedLagSec,
      userFacingOldestReceivedEventId: userFacingReceived.oldestEventId,
      userFacingOldestReceivedCreatedAt: userFacingReceived.oldestCreatedAt,
      userFacingOldestReceivedLagSec,
      userFacingEffectiveLagSec,
      generatedAt: new Date().toISOString(),
    };
  }

  private async buildLagSnapshot(): Promise<QueueLagSnapshot> {
    const [received, queued, quarantined] = await Promise.all([
      this.readOldestWebhookEvent(WebhookStatus.RECEIVED),
      this.readOldestWebhookEvent(WebhookStatus.QUEUED),
      // FLAG: Parked work remains visible without becoming active lag. A covered,
      // bounded status index read reports a lower bound, never a misleading total.
      this.prisma.$queryRaw<Array<{ createdAt: Date }>>(buildQuarantinedWebhookSampleQuery()),
    ]);
    // FLAG: Preparation and execution can both persist an unstarted readiness wait.
    // Inspect each status independently; an unrelated/raw head must retain its pressure.
    const [receivedHeads, queuedHeads] = await Promise.all(
      ([WebhookStatus.RECEIVED, WebhookStatus.QUEUED] as const).map((status, index) => {
        const oldest = index === 0 ? received : queued;
        return oldest?.nextEnqueueAt && oldest.executionDeadlineAt
          ? this.prisma.$queryRaw<WebhookOperationalLagHead[]>(
              buildWebhookOperationalLagQuery(status),
            )
          : null;
      }),
    );
    const now = new Date();
    const operationalReceivedLag = receivedHeads
      ? resolveWebhookOperationalLag(receivedHeads, now)
      : null;
    const operationalQueuedLag = queuedHeads
      ? resolveWebhookOperationalLag(queuedHeads, now)
      : null;
    const oldestReceivedLagSec = received
      ? Math.max(0, (now.getTime() - received.createdAt.getTime()) / 1_000)
      : 0;
    const oldestQueuedLagSec = queued
      ? Math.max(0, (now.getTime() - queued.createdAt.getTime()) / 1_000)
      : 0;

    return {
      oldestQueuedEventId: queued?.id ?? null,
      oldestQueuedCreatedAt: queued?.createdAt.toISOString() ?? null,
      oldestQueuedLagSec,
      oldestReceivedEventId: received?.id ?? null,
      oldestReceivedCreatedAt: received?.createdAt.toISOString() ?? null,
      oldestReceivedLagSec,
      effectiveLagSec: Math.max(oldestQueuedLagSec, oldestReceivedLagSec),
      operationalLagSec: Math.max(
        operationalQueuedLag?.lagSec ?? oldestQueuedLagSec,
        operationalReceivedLag?.lagSec ?? oldestReceivedLagSec,
      ),
      quarantinedCountLowerBound: quarantined.length,
      quarantineSampleLimitReached: quarantined.length === 65,
      oldestQuarantinedAgeSec:
        quarantined[0]?.createdAt instanceof Date
          ? Math.max(0, (now.getTime() - quarantined[0].createdAt.getTime()) / 1_000)
          : 0,
      readinessWaitingCount:
        (operationalReceivedLag?.readinessWaitingCount ?? 0) +
        (operationalQueuedLag?.readinessWaitingCount ?? 0),
      readinessHeadLimitReached:
        (operationalReceivedLag?.readinessHeadLimitReached ?? false) ||
        (operationalQueuedLag?.readinessHeadLimitReached ?? false),
      generatedAt: now.toISOString(),
    };
  }

  private async readOldestWebhookEvent(
    status: typeof WebhookStatus.RECEIVED | typeof WebhookStatus.QUEUED,
  ): Promise<OldestPendingWebhook | null> {
    const rows = await this.prisma.$queryRaw<OldestPendingWebhook[]>(
      buildOldestPendingWebhookQuery(status),
    );
    return rows[0] ?? null;
  }

  private async buildWebhookDefaultShardSnapshot(
    dynamicLeaseSummary?: DefaultWebhookLeaseSummary | null,
  ): Promise<WebhookDefaultShardSnapshot> {
    const resolvedDynamicLeaseSummary =
      dynamicLeaseSummary !== undefined
        ? dynamicLeaseSummary
        : this.webhookDynamicLeaseStatusService
          ? await this.webhookDynamicLeaseStatusService.getSummary(2_000)
          : null;
    const webhookDefaultShardSnapshots = await Promise.all(
      DEFAULT_WEBHOOK_QUEUE_NAMES.map((queueName) =>
        this.readQueueCounters(this.webhookDefaultQueuesByName[queueName]),
      ),
    );
    const webhookDefaultShards = Object.fromEntries(
      DEFAULT_WEBHOOK_QUEUE_NAMES.map((queueName, index) => [
        queueName,
        webhookDefaultShardSnapshots[index] ?? { ...EMPTY_COUNTERS },
      ]),
    ) as Record<DefaultWebhookQueueName, QueueCounters>;

    return {
      webhookDefaultShards,
      webhookDefaultWorkerGroups: this.buildWebhookDefaultWorkerGroups(
        webhookDefaultShards,
        resolvedDynamicLeaseSummary ?? null,
      ),
      generatedAt: new Date().toISOString(),
    };
  }

  private async readAuxiliaryQueueCounters(queueName: AuxiliaryQueueName): Promise<QueueCounters> {
    const queue = this.auxiliaryQueuesByName[queueName];
    if (queueName === MESSAGE_DUPLICATE_QUEUE && !queue) {
      throw new Error('Message duplicate queue metrics unavailable');
    }
    return this.readQueueCounters(queue);
  }

  private async readQueueCounters(queue?: Queue): Promise<QueueCounters> {
    if (!queue) {
      return EMPTY_COUNTERS;
    }

    const counts = await queue.getJobCounts(
      'waiting',
      'paused',
      'prioritized',
      'active',
      'delayed',
      'failed',
      'completed',
    );

    return {
      waiting: (counts.waiting ?? 0) + (counts.paused ?? 0),
      prioritized: counts.prioritized ?? 0,
      active: counts.active ?? 0,
      delayed: counts.delayed ?? 0,
      failed: counts.failed ?? 0,
      completed: counts.completed ?? 0,
    };
  }

  private sumQueueCounters(...counters: QueueCounters[]): QueueCounters {
    return counters.reduce<QueueCounters>(
      (total, current) => ({
        waiting: total.waiting + current.waiting,
        prioritized: total.prioritized + current.prioritized,
        active: total.active + current.active,
        delayed: total.delayed + current.delayed,
        failed: total.failed + current.failed,
        completed: total.completed + current.completed,
      }),
      { ...EMPTY_COUNTERS },
    );
  }

  private buildWebhookDefaultWorkerGroups(
    webhookDefaultShards: Record<DefaultWebhookQueueName, QueueCounters>,
    dynamicLeaseSummary: DefaultWebhookLeaseSummary | null,
  ): Record<DefaultWebhookWorkerGroupName, WebhookDefaultWorkerGroupMetrics> {
    const workerGroupQueues = dynamicLeaseSummary
      ? this.buildWorkerGroupQueuesFromLeaseSummary(dynamicLeaseSummary)
      : getDefaultWebhookWorkerGroupQueues();

    return Object.fromEntries(
      DEFAULT_WEBHOOK_WORKER_GROUP_NAMES.map((groupName) => {
        const queues = [...workerGroupQueues[groupName]];
        return [
          groupName,
          {
            queues,
            counters: this.sumQueueCounters(
              ...queues.map(
                (queueName) => webhookDefaultShards[queueName] ?? { ...EMPTY_COUNTERS },
              ),
            ),
          },
        ];
      }),
    ) as Record<DefaultWebhookWorkerGroupName, WebhookDefaultWorkerGroupMetrics>;
  }

  private buildWorkerGroupQueuesFromLeaseSummary(
    dynamicLeaseSummary: DefaultWebhookLeaseSummary,
  ): Record<DefaultWebhookWorkerGroupName, DefaultWebhookQueueName[]> {
    const queuesByGroup = Object.fromEntries(
      DEFAULT_WEBHOOK_WORKER_GROUP_NAMES.map((groupName) => [
        groupName,
        [] as DefaultWebhookQueueName[],
      ]),
    ) as Record<DefaultWebhookWorkerGroupName, DefaultWebhookQueueName[]>;
    const homeOwnerByQueue = getDefaultWebhookHomeOwnerByQueue();

    for (const queueName of DEFAULT_WEBHOOK_QUEUE_NAMES) {
      const entry = dynamicLeaseSummary.queues[queueName];
      const owner = entry?.actualOwner ?? homeOwnerByQueue[queueName];
      queuesByGroup[owner].push(queueName);
    }

    return queuesByGroup;
  }

  private async readWebhookStatusMetrics(status: WebhookStatus): Promise<WebhookStatusMetrics> {
    return this.readWebhookStatusMetricsForBot(status, null);
  }

  private async readWebhookStatusMetricsByTypes(
    status: WebhookStatus,
    types: readonly string[],
    botId: string | null = null,
  ): Promise<WebhookStatusMetrics> {
    if (types.length === 0) {
      return { ...EMPTY_WEBHOOK_STATUS_METRICS };
    }

    if (typeof this.prisma.$queryRaw !== 'function') {
      return this.readWebhookStatusMetricsForBot(status, botId);
    }

    const normalizedBotId = typeof botId === 'string' ? botId.trim() : '';
    const activeFailedCutoff = new Date(Date.now() - ACTIVE_FAILED_WEBHOOK_WINDOW_SEC * 1_000);
    const statusCondition = Prisma.raw(`'${status}'::"WebhookStatus"`);
    const conditions: Prisma.Sql[] = [Prisma.sql`"status" = ${statusCondition}`];
    if (normalizedBotId) {
      if (normalizedBotId === this.maxBotRegistry.getDefaultBot().id) {
        conditions.push(Prisma.sql`("bot_id" = ${normalizedBotId} OR "bot_id" IS NULL)`);
      } else {
        conditions.push(Prisma.sql`"bot_id" = ${normalizedBotId}`);
      }
    }
    conditions.push(
      Prisma.sql`COALESCE("normalized_payload"->>'type', '') IN (${Prisma.join(types)})`,
    );

    const rows = await this.prisma.$queryRaw<
      Array<{
        count: bigint | number;
        activeCount?: bigint | number;
        oldestEventId: string | null;
        oldestCreatedAt: Date | null;
      }>
    >(Prisma.sql`
      WITH filtered AS (
        SELECT id, created_at
        FROM webhook_events
        WHERE ${Prisma.join(conditions, ' AND ')}
      )
      SELECT
        COUNT(*)::bigint AS count,
        ${
          status === WebhookStatus.FAILED
            ? Prisma.sql`COUNT(*) FILTER (WHERE created_at >= ${activeFailedCutoff})::bigint AS "activeCount",`
            : Prisma.sql``
        }
        (
          SELECT id
          FROM filtered
          ORDER BY created_at ASC
          LIMIT 1
        ) AS "oldestEventId",
        (
          SELECT created_at
          FROM filtered
          ORDER BY created_at ASC
          LIMIT 1
        ) AS "oldestCreatedAt"
      FROM filtered
    `);
    const row = rows[0];
    const count =
      typeof row?.count === 'bigint'
        ? Number(row.count)
        : typeof row?.count === 'number'
          ? row.count
          : 0;
    const activeCount =
      status === WebhookStatus.FAILED
        ? typeof row?.activeCount === 'bigint'
          ? Number(row.activeCount)
          : typeof row?.activeCount === 'number'
            ? row.activeCount
            : 0
        : undefined;

    if (!row?.oldestCreatedAt) {
      const metrics: WebhookStatusMetrics = {
        ...EMPTY_WEBHOOK_STATUS_METRICS,
        count,
      };
      return status === WebhookStatus.FAILED
        ? this.decorateFailedWebhookMetrics(metrics, activeCount ?? 0)
        : metrics;
    }

    const metrics: WebhookStatusMetrics = {
      count,
      oldestEventId: row.oldestEventId ?? null,
      oldestCreatedAt: row.oldestCreatedAt.toISOString(),
      oldestLagSec: Math.max(0, (Date.now() - row.oldestCreatedAt.getTime()) / 1_000),
    };
    return status === WebhookStatus.FAILED
      ? this.decorateFailedWebhookMetrics(metrics, activeCount ?? 0)
      : metrics;
  }

  private async buildPerBotSnapshots(
    botIds: readonly string[],
  ): Promise<Record<string, BotQueueMetricsSnapshot>> {
    const snapshots = await Promise.all(
      botIds.map(async (botId) => {
        const [
          received,
          queued,
          failed,
          userFacingReceived,
          userFacingQueued,
          userFacingFailed,
          queuedByQueue,
        ] = await Promise.all([
          this.readWebhookStatusMetricsForBot(WebhookStatus.RECEIVED, botId),
          this.readWebhookStatusMetricsForBot(WebhookStatus.QUEUED, botId),
          this.readWebhookStatusMetricsForBot(WebhookStatus.FAILED, botId),
          this.readWebhookStatusMetricsByTypes(
            WebhookStatus.RECEIVED,
            USER_FACING_WEBHOOK_UPDATE_TYPES,
            botId,
          ),
          this.readWebhookStatusMetricsByTypes(
            WebhookStatus.QUEUED,
            USER_FACING_WEBHOOK_UPDATE_TYPES,
            botId,
          ),
          this.readWebhookStatusMetricsByTypes(
            WebhookStatus.FAILED,
            USER_FACING_WEBHOOK_UPDATE_TYPES,
            botId,
          ),
          this.readQueuedByQueue(botId),
        ]);
        const oldestQueuedLagSec = queued.oldestLagSec;
        const oldestReceivedLagSec = received.oldestLagSec;
        const userFacingOldestQueuedLagSec = userFacingQueued.oldestLagSec;
        const userFacingOldestReceivedLagSec = userFacingReceived.oldestLagSec;
        const actionHealth =
          typeof this.actionHealthService.getCombinedSnapshot === 'function'
            ? this.actionHealthService.getCombinedSnapshot(60, ['critical', 'interactive'], botId)
            : this.actionHealthService.getSnapshot(60, botId);

        return [
          botId,
          {
            webhookEvents: {
              received,
              queued,
              failed,
            },
            userFacingWebhookEvents: {
              received: userFacingReceived,
              queued: userFacingQueued,
              failed: userFacingFailed,
            },
            queuedByQueue,
            actionHealth,
            oldestQueuedEventId: queued.oldestEventId,
            oldestQueuedCreatedAt: queued.oldestCreatedAt,
            oldestQueuedLagSec,
            oldestReceivedEventId: received.oldestEventId,
            oldestReceivedCreatedAt: received.oldestCreatedAt,
            oldestReceivedLagSec,
            effectiveLagSec: Math.max(oldestQueuedLagSec, oldestReceivedLagSec),
            userFacingOldestQueuedEventId: userFacingQueued.oldestEventId,
            userFacingOldestQueuedCreatedAt: userFacingQueued.oldestCreatedAt,
            userFacingOldestQueuedLagSec,
            userFacingOldestReceivedEventId: userFacingReceived.oldestEventId,
            userFacingOldestReceivedCreatedAt: userFacingReceived.oldestCreatedAt,
            userFacingOldestReceivedLagSec,
            userFacingEffectiveLagSec: Math.max(
              userFacingOldestQueuedLagSec,
              userFacingOldestReceivedLagSec,
            ),
          } satisfies BotQueueMetricsSnapshot,
        ] as const;
      }),
    );

    return Object.fromEntries(snapshots);
  }

  private async readWebhookStatusMetricsForBot(
    status: WebhookStatus,
    botId: string | null,
  ): Promise<WebhookStatusMetrics> {
    const where = this.buildWebhookStatusWhere(status, botId);
    const activeFailedCutoff = new Date(Date.now() - ACTIVE_FAILED_WEBHOOK_WINDOW_SEC * 1_000);
    const [count, oldestEvent, activeCount] = await Promise.all([
      this.prisma.webhookEvent.count({
        where,
      }),
      this.prisma.webhookEvent.findFirst({
        where,
        orderBy: { createdAt: 'asc' },
        select: { id: true, createdAt: true },
      }),
      status === WebhookStatus.FAILED
        ? this.prisma.webhookEvent.count({
            where: {
              ...where,
              createdAt: {
                gte: activeFailedCutoff,
              },
            },
          })
        : Promise.resolve(undefined),
    ]);

    if (!oldestEvent) {
      const metrics: WebhookStatusMetrics = {
        ...EMPTY_WEBHOOK_STATUS_METRICS,
        count,
      };
      return status === WebhookStatus.FAILED
        ? this.decorateFailedWebhookMetrics(metrics, activeCount ?? 0)
        : metrics;
    }

    const oldestLagSec = Math.max(0, (Date.now() - oldestEvent.createdAt.getTime()) / 1_000);
    const metrics: WebhookStatusMetrics = {
      count,
      oldestEventId: oldestEvent.id,
      oldestCreatedAt: oldestEvent.createdAt.toISOString(),
      oldestLagSec,
    };
    return status === WebhookStatus.FAILED
      ? this.decorateFailedWebhookMetrics(metrics, activeCount ?? 0)
      : metrics;
  }

  private decorateFailedWebhookMetrics(
    metrics: WebhookStatusMetrics,
    activeCount: number,
  ): WebhookStatusMetrics {
    return {
      ...metrics,
      activeCount,
      activeWindowSec: ACTIVE_FAILED_WEBHOOK_WINDOW_SEC,
      ...(metrics.count > activeCount
        ? {
            staleCount: Math.max(0, metrics.count - activeCount),
          }
        : {}),
    };
  }

  private async readQueuedByQueue(botId: string): Promise<Record<string, number>> {
    const rows = await this.prisma.webhookEvent.groupBy({
      by: ['queueName'],
      where: {
        ...this.buildWebhookStatusWhere(WebhookStatus.QUEUED, botId),
        queueName: {
          not: null,
        },
      },
      _count: {
        _all: true,
      },
    });

    return Object.fromEntries(
      rows
        .map((row) => [row.queueName, row._count._all] as const)
        .filter((entry): entry is [string, number] => typeof entry[0] === 'string'),
    );
  }

  private buildWebhookStatusWhere(status: WebhookStatus, botId: string | null) {
    if (!botId) {
      return { status };
    }

    if (botId === this.maxBotRegistry.getDefaultBot().id) {
      return {
        status,
        OR: [{ botId }, { botId: null }],
      };
    }

    return {
      status,
      botId,
    };
  }
}
