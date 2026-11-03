import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Job, Queue } from 'bullmq';
import { createHash } from 'node:crypto';
import {
  getAppRole,
  roleRunsEnqueue,
  roleRunsIngress,
  roleRunsPublisher,
} from '../runtime/app-role';
import { buildPublisherBotDescriptor } from './publisher-bot-descriptor';
import {
  PublisherAutoReplyBacklogQuota,
  PublisherAutoReplyBacklogQuotaError,
  type PublisherAutoReplyBacklogClaim,
} from './publisher-auto-reply-backlog-quota';
import {
  PUBLISHER_AUTO_REPLY_FLOOD_GATE_BOUNDS,
  PUBLISHER_AUTO_REPLY_FLOOD_GATE_DEFAULTS,
} from './publisher-auto-reply-flood-gate.config';
import { PublisherRuntimeHeartbeatReaderService } from './publisher-runtime-heartbeat.service';

export const PUBLISHER_AUTO_REPLY_QUEUE = 'publisher-auto-replies';
const HEARTBEAT_RECHECK_DELAY_MS = 150;
const BACKLOG_RELEASE_LOG_INTERVAL_MS = 10_000;

export type PublisherAutoReplyAdmissionFailureReason =
  | 'dispatch_disabled'
  | 'backlog_limit'
  | 'backlog_unavailable';

export class PublisherAutoReplyAdmissionError extends Error {
  constructor(readonly reason: PublisherAutoReplyAdmissionFailureReason = 'dispatch_disabled') {
    super(`Publisher auto-reply admission failed: ${reason}`);
    this.name = 'PublisherAutoReplyAdmissionError';
  }
}

export type PublisherAutoReplyJob = {
  version: 1;
  kind: 'deliver';
  retryPolicyName: 'publisher-auto-reply';
  deliveryId: string;
};

export type PublisherAutoReplyJobEnsureResult =
  | { outcome: 'already_live' }
  | { outcome: 'add_acknowledged' };

export function buildPublisherAutoReplyJobId(deliveryId: string): string {
  const digest = createHash('sha256').update(deliveryId.trim()).digest('hex').slice(0, 32);
  return `publisher-auto-reply-${digest}`;
}

@Injectable()
export class PublisherAutoReplyQueueService implements OnModuleDestroy {
  private readonly logger = new Logger(PublisherAutoReplyQueueService.name);
  private readonly publisherBotId: string;
  private readonly backlogLimit: number;
  private readonly backlogQuota: PublisherAutoReplyBacklogQuota;
  private lastBacklogReleaseLogAtMs = 0;

  constructor(
    @InjectQueue(PUBLISHER_AUTO_REPLY_QUEUE)
    private readonly queue: Queue<PublisherAutoReplyJob>,
    configService: ConfigService,
    private readonly runtimeHeartbeat: PublisherRuntimeHeartbeatReaderService,
  ) {
    this.publisherBotId = buildPublisherBotDescriptor({
      id: configService.get<string>('MAX_PUBLISHER_BOT_ID'),
    }).id;
    const backlogLimit = configService.get<number>(
      'PUBLISHER_AUTO_REPLY_QUEUE_BACKLOG_LIMIT',
      PUBLISHER_AUTO_REPLY_FLOOD_GATE_DEFAULTS.queueBacklogLimit,
    );
    const bounds = PUBLISHER_AUTO_REPLY_FLOOD_GATE_BOUNDS.queueBacklogLimit;
    if (
      !Number.isSafeInteger(backlogLimit) ||
      backlogLimit < bounds.min ||
      backlogLimit > bounds.max
    ) {
      throw new Error(
        `PUBLISHER_AUTO_REPLY_QUEUE_BACKLOG_LIMIT must be an integer between ${bounds.min} and ${bounds.max}`,
      );
    }
    this.backlogLimit = backlogLimit;
    const role = getAppRole();
    const ownsAdmission = roleRunsIngress(role) || roleRunsEnqueue(role) || roleRunsPublisher(role);
    const redisUrl = ownsAdmission ? configService.get<string>('REDIS_URL')?.trim() : undefined;
    this.backlogQuota = new PublisherAutoReplyBacklogQuota(this.queue, this.backlogLimit, {
      ...(redisUrl ? { redisUrl } : {}),
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.backlogQuota.close();
  }

  async assertAdmissionEnabled(): Promise<void> {
    let heartbeat = await this.runtimeHeartbeat.read(this.publisherBotId);
    if (!heartbeat) {
      await new Promise<void>((resolve) => setTimeout(resolve, HEARTBEAT_RECHECK_DELAY_MS));
      heartbeat = await this.runtimeHeartbeat.read(this.publisherBotId);
    }
    if (heartbeat && !heartbeat.dispatchEnabled && heartbeat.blocker === 'runtime_disabled') {
      throw new PublisherAutoReplyAdmissionError();
    }
  }

  async assertNewDeliveryAdmissionEnabled(): Promise<void> {
    await this.assertAdmissionEnabled();
    try {
      await this.backlogQuota.assertAvailable();
    } catch (error: unknown) {
      throw this.mapBacklogQuotaError(error);
    }
  }

  async ensureDeliveryJob(
    deliveryId: string,
    availableAt?: Date | null,
  ): Promise<PublisherAutoReplyJobEnsureResult> {
    const normalizedDeliveryId = deliveryId.trim();
    if (!normalizedDeliveryId) {
      throw new Error('Publisher auto-reply deliveryId is required');
    }
    await this.assertAdmissionEnabled();
    const jobId = buildPublisherAutoReplyJobId(normalizedDeliveryId);
    const existing = await this.queue.getJob(jobId);
    if (existing && (await this.isLiveJob(existing))) {
      return { outcome: 'already_live' };
    }
    if (existing) {
      await this.removeReplaceableJob(existing);
    }

    let backlogClaim: PublisherAutoReplyBacklogClaim;
    try {
      backlogClaim = await this.backlogQuota.claimInflight(jobId);
    } catch (error: unknown) {
      throw this.mapBacklogQuotaError(error);
    }

    try {
      const delay = availableAt
        ? Math.max(0, Math.min(availableAt.getTime() - Date.now(), 15 * 60_000))
        : 0;
      await this.queue.add(
        'deliver',
        {
          version: 1,
          kind: 'deliver',
          retryPolicyName: 'publisher-auto-reply',
          deliveryId: normalizedDeliveryId,
        },
        {
          jobId,
          priority: 3,
          ...(delay > 0 ? { delay } : {}),
          attempts: 7,
          backoff: { type: 'exponential', delay: 2_000 },
          removeOnComplete: { age: 60 * 60, count: 10_000 },
          removeOnFail: { age: 7 * 24 * 60 * 60, count: 10_000 },
        },
      );
    } finally {
      await this.releaseBacklogClaim(backlogClaim);
    }
    // FLAG: BullMQ also acknowledges a competing add of the same job ID; this is not
    // proof that this call created a new job or that the delivery has executed.
    return { outcome: 'add_acknowledged' };
  }

  private async isLiveJob(job: Job<PublisherAutoReplyJob>): Promise<boolean> {
    const state = await job.getState();
    return (
      state === 'active' || state === 'waiting' || state === 'delayed' || state === 'prioritized'
    );
  }

  private async removeReplaceableJob(job: Job<PublisherAutoReplyJob>): Promise<void> {
    const state = await job.getState();
    if (state === 'completed' || state === 'failed') {
      await job.remove();
    }
  }

  private mapBacklogQuotaError(error: unknown): PublisherAutoReplyAdmissionError {
    return new PublisherAutoReplyAdmissionError(
      error instanceof PublisherAutoReplyBacklogQuotaError && error.reason === 'limit'
        ? 'backlog_limit'
        : 'backlog_unavailable',
    );
  }

  private async releaseBacklogClaim(claim: PublisherAutoReplyBacklogClaim): Promise<void> {
    try {
      await this.backlogQuota.release(claim);
    } catch (error: unknown) {
      const nowMs = Date.now();
      if (nowMs - this.lastBacklogReleaseLogAtMs >= BACKLOG_RELEASE_LOG_INTERVAL_MS) {
        this.lastBacklogReleaseLogAtMs = nowMs;
        const code = (error as { code?: unknown } | null)?.code;
        this.logger.warn(
          { code: typeof code === 'string' && code.trim() ? code.trim().slice(0, 80) : 'UNKNOWN' },
          'Publisher auto-reply backlog lease release failed; TTL recovery remains active',
        );
      }
    }
  }
}
