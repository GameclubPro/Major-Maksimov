import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '../prisma/prisma-client';
import { isManagedEntityHandshakeStartCommand } from '../common/managed-entity-handshake-command.util';
import { PrismaService } from '../prisma/prisma.service';
import {
  getDefaultWebhookWorkerGroupQueues,
  type DefaultWebhookWorkerGroupName,
} from '../runtime/moderation-runtime';
import {
  QueueMetricsService,
  type WebhookDefaultShardSnapshot,
} from '../system/queue-metrics.service';
import {
  DEFAULT_WEBHOOK_QUEUE_NAMES,
  type ActiveWebhookQueueName,
  type DefaultWebhookQueueName,
  extractWebhookChatId,
  extractWebhookType,
  JOIN_WEBHOOK_QUEUE_NAMES,
  resolveJoinWebhookQueueNameForChatId,
  resolveDefaultWebhookQueueIndexForChatId,
  resolveDefaultWebhookQueueNameForChatId,
  WEBHOOK_QUEUE_BACKGROUND,
  WEBHOOK_QUEUE_CRITICAL,
} from './webhook-queues';
import { WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINE_PREFIX } from './webhook-timeout-quarantine';
import { AssignmentExpiryIndex } from './assignment-expiry-index';

type ChatQueueAssignment = {
  queueName: DefaultWebhookQueueName;
  assignedAtMs: number;
  expiresAtMs: number;
};

type OutstandingMessageQueueWork = {
  hasPending: boolean;
  queueName: DefaultWebhookQueueName | null;
};

type QueuePressure = {
  queueName: DefaultWebhookQueueName;
  queuePressureScore: number;
  workerPressureScore: number;
  queuePressure: number;
  workerPressure: number;
  leasedChats: number;
  workerLeasedChats: number;
  tieOrder: number;
};

type AssignmentCounts = {
  byQueue: Map<DefaultWebhookQueueName, number>;
  byWorker: Map<DefaultWebhookWorkerGroupName, number>;
};

const DEFAULT_MAX_CHAT_ASSIGNMENTS = 50_000;
const EXPIRY_MAINTENANCE_BUDGET = 256;
const DEFAULT_CHAT_ASSIGNMENT_TTL_SEC = 90;
const DEFAULT_QUEUE_SNAPSHOT_MAX_AGE_MS = 1_000;
const ACTIVE_QUEUE_PRESSURE_WEIGHT = 4;
const ACTIVE_WORKER_PRESSURE_WEIGHT = 6;
const ADAPTIVE_TTL_HOT_QUEUE_MS = 30_000;
const DEFAULT_HOT_WORKER_REBALANCE_MIN_AGE_MS = 12_000;
const DEFAULT_HOT_WORKER_REBALANCE_PRESSURE_SHARE = 0.7;
const DEFAULT_HOT_WORKER_REBALANCE_PRESSURE_MIN = 4;
const WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINE_MARKER = `${WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINE_PREFIX}:`;
const WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINE_MARKER_LENGTH_SQL = Prisma.raw(
  String(WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINE_MARKER.length),
);
const WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINE_MARKER_SQL = Prisma.raw(
  `'${WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINE_MARKER.replaceAll("'", "''")}'`,
);

@Injectable()
export class WebhookRoutingService {
  private readonly chatAssignmentTtlMs: number;
  private readonly queueSnapshotMaxAgeMs: number;
  private readonly hotWorkerRebalanceMinAgeMs: number;
  private readonly hotWorkerRebalancePressureShare: number;
  private readonly hotWorkerRebalancePressureMin: number;
  private readonly chatAssignments = new Map<string, ChatQueueAssignment>();
  private readonly maxChatAssignments: number;
  private readonly expiryIndex = new AssignmentExpiryIndex();
  private readonly assignmentCounts = new Map<DefaultWebhookQueueName, number>();
  private readonly assignmentRefreshes = new Map<string, Promise<DefaultWebhookQueueName>>();
  private workerGroupByQueue = this.buildWorkerGroupByQueue();

  constructor(
    private readonly prisma: PrismaService,
    private readonly queueMetricsService: QueueMetricsService,
    configService: ConfigService,
  ) {
    this.maxChatAssignments = this.readConfigInt(
      configService.get('WEBHOOK_ROUTING_CHAT_ASSIGNMENT_CAPACITY'),
      DEFAULT_MAX_CHAT_ASSIGNMENTS,
    );
    this.chatAssignmentTtlMs =
      this.readConfigInt(
        configService.get('WEBHOOK_ROUTING_CHAT_ASSIGNMENT_TTL_SEC'),
        DEFAULT_CHAT_ASSIGNMENT_TTL_SEC,
      ) * 1_000;
    this.queueSnapshotMaxAgeMs = this.readConfigInt(
      configService.get('WEBHOOK_ROUTING_QUEUE_SNAPSHOT_MAX_AGE_MS'),
      DEFAULT_QUEUE_SNAPSHOT_MAX_AGE_MS,
      50,
    );
    this.hotWorkerRebalanceMinAgeMs = this.readConfigInt(
      configService.get('WEBHOOK_ROUTING_HOT_WORKER_REBALANCE_MIN_AGE_MS'),
      DEFAULT_HOT_WORKER_REBALANCE_MIN_AGE_MS,
      1_000,
    );
    this.hotWorkerRebalancePressureShare = this.readFractionConfig(
      configService.get('WEBHOOK_ROUTING_HOT_WORKER_REBALANCE_PRESSURE_SHARE'),
      DEFAULT_HOT_WORKER_REBALANCE_PRESSURE_SHARE,
    );
    this.hotWorkerRebalancePressureMin = this.readConfigInt(
      configService.get('WEBHOOK_ROUTING_HOT_WORKER_REBALANCE_PRESSURE_MIN'),
      DEFAULT_HOT_WORKER_REBALANCE_PRESSURE_MIN,
      1,
    );
  }

  async resolveQueueName(
    webhookEventId: string,
    payload: unknown,
  ): Promise<ActiveWebhookQueueName> {
    switch (extractWebhookType(payload)) {
      case 'message_callback':
      case 'bot_added':
      case 'bot_started':
        return WEBHOOK_QUEUE_CRITICAL;
      case 'user_added': {
        const chatId = extractWebhookChatId(payload);
        return chatId ? resolveJoinWebhookQueueNameForChatId(chatId) : JOIN_WEBHOOK_QUEUE_NAMES[0];
      }
      case 'user_removed':
      case 'bot_removed':
      case 'bot_stopped':
      case 'dialog_removed':
      case 'message_removed':
        return WEBHOOK_QUEUE_BACKGROUND;
      case 'message_created':
        if (isManagedEntityHandshakeStartCommand(payload)) {
          return WEBHOOK_QUEUE_CRITICAL;
        }
        return this.resolveDefaultQueueName(webhookEventId, payload);
      case 'message_edited':
      default:
        return this.resolveDefaultQueueName(webhookEventId, payload);
    }
  }

  private async resolveDefaultQueueName(
    webhookEventId: string,
    payload: unknown,
  ): Promise<DefaultWebhookQueueName> {
    const chatId = extractWebhookChatId(payload);
    if (!chatId) {
      return DEFAULT_WEBHOOK_QUEUE_NAMES[0];
    }

    const assignmentKey = this.buildAssignmentKey(chatId);

    const now = Date.now();
    const currentAssignment = this.readFreshAssignment(assignmentKey, now);
    if (currentAssignment) {
      const hotAssignmentSnapshot = await this.readHotWorkerSnapshotForAssignment(
        currentAssignment,
        now,
      );
      if (!hotAssignmentSnapshot) {
        return currentAssignment.queueName;
      }

      const refresh = this.assignmentRefreshes.get(assignmentKey);
      if (refresh) {
        return refresh;
      }

      const refreshPromise = this.refreshChatAssignment(
        assignmentKey,
        chatId,
        webhookEventId,
        now,
        hotAssignmentSnapshot,
      ).finally(() => {
        if (this.assignmentRefreshes.get(assignmentKey) === refreshPromise) {
          this.assignmentRefreshes.delete(assignmentKey);
        }
      });
      this.assignmentRefreshes.set(assignmentKey, refreshPromise);
      return refreshPromise;
    }

    const refresh = this.assignmentRefreshes.get(assignmentKey);
    if (refresh) {
      return refresh;
    }

    const refreshPromise = this.refreshChatAssignment(
      assignmentKey,
      chatId,
      webhookEventId,
      now,
    ).finally(() => {
      if (this.assignmentRefreshes.get(assignmentKey) === refreshPromise) {
        this.assignmentRefreshes.delete(assignmentKey);
      }
    });
    this.assignmentRefreshes.set(assignmentKey, refreshPromise);
    return refreshPromise;
  }

  private async refreshChatAssignment(
    assignmentKey: string,
    chatId: string,
    webhookEventId: string,
    now: number,
    preloadedSnapshot?: Awaited<ReturnType<QueueMetricsService['getWebhookDefaultShardSnapshot']>>,
  ): Promise<DefaultWebhookQueueName> {
    const previousAssignment = this.chatAssignments.get(assignmentKey);
    const fallbackQueue =
      previousAssignment?.queueName ?? resolveDefaultWebhookQueueNameForChatId(chatId);

    const outstandingWork = await this.findOutstandingMessageQueueWork(chatId, webhookEventId);
    if (outstandingWork.hasPending) {
      return this.storeAssignment(assignmentKey, outstandingWork.queueName ?? fallbackQueue, now);
    }

    const snapshot =
      preloadedSnapshot ??
      (await this.queueMetricsService.getWebhookDefaultShardSnapshot({
        maxAgeMs: this.queueSnapshotMaxAgeMs,
      }));
    this.updateWorkerGroupByQueue(snapshot);
    const nextQueue = this.selectLeastPressuredQueue(chatId, snapshot, fallbackQueue, now);
    return this.storeAssignment(assignmentKey, nextQueue, now);
  }

  private selectLeastPressuredQueue(
    chatId: string,
    snapshot: Awaited<ReturnType<QueueMetricsService['getWebhookDefaultShardSnapshot']>>,
    currentQueueName: DefaultWebhookQueueName,
    now: number,
  ): DefaultWebhookQueueName {
    const assignments = this.countActiveAssignments(now);
    const rotatedQueueNames = this.rotateQueueNames(chatId);
    const candidates = rotatedQueueNames.map((queueName, tieOrder) =>
      this.buildQueuePressureCandidate(queueName, tieOrder, snapshot, assignments),
    );
    const bestCandidate = candidates.reduce((best, current) =>
      this.compareQueuePressure(current, best) < 0 ? current : best,
    );
    const currentCandidate = candidates.find(
      (candidate) => candidate.queueName === currentQueueName,
    );
    if (!currentCandidate) {
      return bestCandidate.queueName;
    }

    const queuePressureGap = currentCandidate.queuePressure - bestCandidate.queuePressure;
    const workerPressureGap = currentCandidate.workerPressure - bestCandidate.workerPressure;
    const leasedChatsGap = currentCandidate.leasedChats - bestCandidate.leasedChats;
    const workerLeasedChatsGap =
      currentCandidate.workerLeasedChats - bestCandidate.workerLeasedChats;
    const queuePressureScoreGap =
      currentCandidate.queuePressureScore - bestCandidate.queuePressureScore;
    const workerPressureScoreGap =
      currentCandidate.workerPressureScore - bestCandidate.workerPressureScore;
    const keepCurrentQueue =
      this.compareQueuePressure(currentCandidate, bestCandidate) <= 0 ||
      (queuePressureGap <= 1 &&
        workerPressureGap <= 1 &&
        queuePressureScoreGap <= 2 &&
        workerPressureScoreGap <= 3 &&
        leasedChatsGap <= 1 &&
        workerLeasedChatsGap <= 1);

    return keepCurrentQueue ? currentQueueName : bestCandidate.queueName;
  }

  private buildQueuePressureCandidate(
    queueName: DefaultWebhookQueueName,
    tieOrder: number,
    snapshot: Awaited<ReturnType<QueueMetricsService['getWebhookDefaultShardSnapshot']>>,
    assignments: AssignmentCounts,
  ): QueuePressure {
    const queueCounters = snapshot.webhookDefaultShards[queueName];
    const queuePressure =
      (queueCounters?.waiting ?? 0) +
      (queueCounters?.prioritized ?? 0) +
      (queueCounters?.active ?? 0) +
      (queueCounters?.delayed ?? 0);
    const queuePressureScore =
      (queueCounters?.waiting ?? 0) +
      (queueCounters?.prioritized ?? 0) +
      (queueCounters?.active ?? 0) * ACTIVE_QUEUE_PRESSURE_WEIGHT +
      (queueCounters?.delayed ?? 0);
    const workerGroupName = this.workerGroupByQueue[queueName];
    const workerCounters = workerGroupName
      ? snapshot.webhookDefaultWorkerGroups[workerGroupName]?.counters
      : null;
    const workerPressure = workerCounters
      ? workerCounters.waiting + workerCounters.prioritized + workerCounters.active
      : queuePressure;
    const workerPressureScore = workerCounters
      ? workerCounters.waiting +
        workerCounters.prioritized +
        workerCounters.active * ACTIVE_WORKER_PRESSURE_WEIGHT
      : queuePressureScore;

    const leasedChats = assignments.byQueue.get(queueName) ?? 0;
    const workerLeasedChats = workerGroupName
      ? (assignments.byWorker.get(workerGroupName) ?? 0)
      : 0;

    return {
      queueName,
      queuePressureScore,
      workerPressureScore,
      queuePressure,
      workerPressure,
      leasedChats,
      workerLeasedChats,
      tieOrder,
    };
  }

  private countActiveAssignments(now: number): AssignmentCounts {
    for (const key of this.expiryIndex.takeExpired(now, EXPIRY_MAINTENANCE_BUDGET)) {
      this.removeAssignment(key);
    }
    const byWorker = new Map<DefaultWebhookWorkerGroupName, number>();
    for (const [queueName, count] of this.assignmentCounts) {
      const worker = this.workerGroupByQueue[queueName];
      if (worker) byWorker.set(worker, (byWorker.get(worker) ?? 0) + count);
    }
    return { byQueue: this.assignmentCounts, byWorker };
  }

  private adjustAssignmentCounts(queueName: DefaultWebhookQueueName, delta: number): void {
    this.assignmentCounts.set(queueName, (this.assignmentCounts.get(queueName) ?? 0) + delta);
  }

  private removeAssignment(key: string): void {
    const assignment = this.chatAssignments.get(key);
    if (!assignment) return;
    this.adjustAssignmentCounts(assignment.queueName, -1);
    this.chatAssignments.delete(key);
    this.expiryIndex.delete(key);
  }

  private compareQueuePressure(left: QueuePressure, right: QueuePressure): number {
    if (left.workerPressureScore !== right.workerPressureScore) {
      return left.workerPressureScore - right.workerPressureScore;
    }
    if (left.queuePressureScore !== right.queuePressureScore) {
      return left.queuePressureScore - right.queuePressureScore;
    }
    if (left.queuePressure !== right.queuePressure) {
      return left.queuePressure - right.queuePressure;
    }
    if (left.workerPressure !== right.workerPressure) {
      return left.workerPressure - right.workerPressure;
    }
    if (left.workerLeasedChats !== right.workerLeasedChats) {
      return left.workerLeasedChats - right.workerLeasedChats;
    }
    if (left.leasedChats !== right.leasedChats) {
      return left.leasedChats - right.leasedChats;
    }
    return left.tieOrder - right.tieOrder;
  }

  private rotateQueueNames(chatId: string): DefaultWebhookQueueName[] {
    const startIndex = resolveDefaultWebhookQueueIndexForChatId(chatId);
    return DEFAULT_WEBHOOK_QUEUE_NAMES.map(
      (_, offset) =>
        DEFAULT_WEBHOOK_QUEUE_NAMES[(startIndex + offset) % DEFAULT_WEBHOOK_QUEUE_NAMES.length]!,
    );
  }

  private readFreshAssignment(assignmentKey: string, now: number): ChatQueueAssignment | null {
    const assignment = this.chatAssignments.get(assignmentKey);
    if (!assignment) {
      return null;
    }

    if (assignment.expiresAtMs <= now) {
      return null;
    }

    return assignment;
  }

  private storeAssignment(
    assignmentKey: string,
    queueName: DefaultWebhookQueueName,
    now: number,
  ): DefaultWebhookQueueName {
    const cachedAssignment = this.chatAssignments.get(assignmentKey);
    const assignment: ChatQueueAssignment = {
      queueName,
      assignedAtMs: now,
      expiresAtMs:
        now +
        (cachedAssignment?.queueName === queueName
          ? this.chatAssignmentTtlMs
          : this.resolveAdaptiveTtlMs(queueName)),
    };
    // FLAG: Eviction is only a cache miss. A subsequent refresh must still read outstanding work.
    this.removeAssignment(assignmentKey);
    this.chatAssignments.set(assignmentKey, assignment);
    this.expiryIndex.set(assignmentKey, assignment.expiresAtMs);
    this.adjustAssignmentCounts(queueName, 1);
    while (this.chatAssignments.size > this.maxChatAssignments) {
      const oldestKey = this.chatAssignments.keys().next().value;
      if (oldestKey === undefined) break;
      this.removeAssignment(oldestKey);
    }
    return queueName;
  }

  private async readHotWorkerSnapshotForAssignment(
    assignment: ChatQueueAssignment,
    now: number,
  ): Promise<Awaited<ReturnType<QueueMetricsService['getWebhookDefaultShardSnapshot']>> | null> {
    if (now - assignment.assignedAtMs < this.hotWorkerRebalanceMinAgeMs) {
      return null;
    }

    const snapshot = await this.queueMetricsService.getWebhookDefaultShardSnapshot({
      maxAgeMs: this.queueSnapshotMaxAgeMs,
    });
    this.updateWorkerGroupByQueue(snapshot);
    const workerGroupName = this.workerGroupByQueue[assignment.queueName];
    if (!workerGroupName) {
      return null;
    }
    const workerGroups = Object.values(snapshot.webhookDefaultWorkerGroups);
    const totalPressure = workerGroups.reduce(
      (sum, metrics) =>
        sum +
        metrics.counters.waiting +
        metrics.counters.prioritized +
        metrics.counters.active * ACTIVE_WORKER_PRESSURE_WEIGHT,
      0,
    );
    if (totalPressure < this.hotWorkerRebalancePressureMin) {
      return null;
    }

    const currentWorker = snapshot.webhookDefaultWorkerGroups[workerGroupName];
    if (!currentWorker) {
      return null;
    }

    const currentPressure =
      currentWorker.counters.waiting +
      currentWorker.counters.prioritized +
      currentWorker.counters.active * ACTIVE_WORKER_PRESSURE_WEIGHT;
    const workerPressureShare = currentPressure / totalPressure;
    return workerPressureShare >= this.hotWorkerRebalancePressureShare ? snapshot : null;
  }

  private resolveAdaptiveTtlMs(queueName: DefaultWebhookQueueName): number {
    const workerGroupName = this.workerGroupByQueue[queueName];
    if (!workerGroupName) {
      return this.chatAssignmentTtlMs;
    }

    const workerLeasedChats =
      this.countActiveAssignments(Date.now()).byWorker.get(workerGroupName) ?? 0;

    return workerLeasedChats >= Math.max(4, DEFAULT_WEBHOOK_QUEUE_NAMES.length / 2)
      ? Math.min(this.chatAssignmentTtlMs, ADAPTIVE_TTL_HOT_QUEUE_MS)
      : this.chatAssignmentTtlMs;
  }

  private async findOutstandingMessageQueueWork(
    chatId: string,
    webhookEventId: string,
  ): Promise<OutstandingMessageQueueWork> {
    const rows = await this.prisma.$queryRaw<
      Array<{ has_pending?: boolean; queue_name?: string | null }>
    >(
      Prisma.sql`
        WITH outstanding AS MATERIALIZED (
          SELECT queue_name, created_at, id
          FROM webhook_events
          WHERE id <> ${webhookEventId}
            AND (
              status = ANY(ARRAY['RECEIVED', 'QUEUED']::"WebhookStatus"[])
              OR (
                status = 'FAILED'::"WebhookStatus"
                AND (
                  next_enqueue_at IS NOT NULL
                  OR LEFT(COALESCE(error_message, ''), ${WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINE_MARKER_LENGTH_SQL}) = ${WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINE_MARKER_SQL}
                )
              )
            )
            AND LOWER(
              COALESCE(
                NULLIF(BTRIM(normalized_payload->>'type'), ''),
                NULLIF(BTRIM(normalized_payload->>'update_type'), '')
              )
            ) = ANY(ARRAY['message_created', 'message_edited'])
            AND COALESCE(
              NULLIF(BTRIM(normalized_payload->'message'->>'chatId'), ''),
              NULLIF(BTRIM(normalized_payload->>'chatId'), '')
            ) = ${chatId}
        )
        SELECT
          EXISTS (SELECT 1 FROM outstanding LIMIT 1) AS has_pending,
          (
            SELECT queue_name
            FROM outstanding
            WHERE queue_name IN (${Prisma.join(DEFAULT_WEBHOOK_QUEUE_NAMES)})
            ORDER BY created_at ASC, id ASC
            LIMIT 1
          ) AS queue_name
      `,
    );
    const queueName = rows[0]?.queue_name;
    return {
      hasPending: rows[0]?.has_pending === true,
      queueName:
        typeof queueName === 'string' &&
        DEFAULT_WEBHOOK_QUEUE_NAMES.some((candidate) => candidate === queueName)
          ? (queueName as DefaultWebhookQueueName)
          : null,
    };
  }

  private buildAssignmentKey(chatId: string): string {
    return `chat:${chatId}`;
  }

  private buildWorkerGroupByQueue(): Record<
    DefaultWebhookQueueName,
    DefaultWebhookWorkerGroupName | undefined
  > {
    const workerGroups = getDefaultWebhookWorkerGroupQueues();
    const workerGroupByQueue = Object.fromEntries(
      DEFAULT_WEBHOOK_QUEUE_NAMES.map((queueName) => [queueName, undefined]),
    ) as Record<DefaultWebhookQueueName, DefaultWebhookWorkerGroupName | undefined>;

    for (const [groupName, queues] of Object.entries(workerGroups) as Array<
      [DefaultWebhookWorkerGroupName, readonly DefaultWebhookQueueName[]]
    >) {
      for (const queueName of queues) {
        workerGroupByQueue[queueName] = groupName;
      }
    }

    return workerGroupByQueue;
  }

  private updateWorkerGroupByQueue(snapshot: WebhookDefaultShardSnapshot): void {
    const owners = this.buildWorkerGroupByQueue();
    for (const [groupName, group] of Object.entries(snapshot.webhookDefaultWorkerGroups) as Array<
      [
        DefaultWebhookWorkerGroupName,
        WebhookDefaultShardSnapshot['webhookDefaultWorkerGroups'][DefaultWebhookWorkerGroupName],
      ]
    >) {
      for (const queueName of group.queues) owners[queueName] = groupName;
    }
    this.workerGroupByQueue = owners;
  }

  private readConfigInt(value: unknown, fallback: number, min = 1): number {
    const numericValue =
      typeof value === 'number'
        ? value
        : typeof value === 'string' && value.trim().length > 0
          ? Number(value)
          : Number.NaN;
    if (Number.isFinite(numericValue) && numericValue >= min) {
      return Math.trunc(numericValue);
    }

    return fallback;
  }

  private readFractionConfig(value: unknown, fallback: number): number {
    const numericValue =
      typeof value === 'number'
        ? value
        : typeof value === 'string' && value.trim().length > 0
          ? Number(value)
          : Number.NaN;
    if (Number.isFinite(numericValue) && numericValue > 0 && numericValue <= 1) {
      return numericValue;
    }

    return fallback;
  }
}
