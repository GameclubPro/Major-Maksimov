import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, ServiceUnavailableException, type OnModuleDestroy } from '@nestjs/common';
import { QueueEvents, type Queue } from 'bullmq';
import { createHash, randomUUID } from 'node:crypto';
import type { VkBotReviewJob } from './publisher-vk-bot-review.queue';

export const PUBLISHER_SUGGESTION_ADMIN_QUEUE = 'publisher-suggestion-admin';
export const PUBLISHER_SUGGESTION_ADMIN_CALLBACK_PREFIX = 'psa:v1:';

export type PublisherSuggestionAdminReviewAction = 'publish' | 'cancel';
export type PublisherSuggestionAdminReviewStatus = 'published' | 'drafted' | 'cancelled';

export type PublisherSuggestionAdminReviewActor = {
  userId: string;
  username: string | null;
  displayName: string | null;
  avatarUrl: string | null;
  profileUrl: string | null;
};

export type PublisherSuggestionAdminJob =
  | {
      version: 1;
      kind: 'review-effect';
      effectId: string;
      requiredBotId: string;
      requestedAt: string;
    }
  | VkBotReviewJob
  | {
      version: 1;
      kind: 'subscription';
      chatId: string;
      userId: string;
      requiredBotId: string;
      requestedAt: string;
    }
  | {
      version: 1;
      kind: 'deliver';
      suggestionId: string;
      requiredBotId: string;
      requestedAt: string;
    }
  | {
      version: 1;
      kind: 'review';
      suggestionId: string;
      requiredBotId: string;
      action: PublisherSuggestionAdminReviewAction;
      actor: PublisherSuggestionAdminReviewActor;
      callbackId: string;
      privateChatId: string;
      messageId: string;
      webhookEventId: string | null;
      updateId: string;
      requestedAt: string;
    }
  | {
      version: 1;
      kind: 'sync';
      suggestionId: string;
      requiredBotId: string;
      reviewStatus: PublisherSuggestionAdminReviewStatus;
      requestedAt: string;
    };

function digestJobIdentity(...parts: string[]): string {
  return createHash('sha256').update(parts.join('\0')).digest('hex').slice(0, 32);
}

export function buildPublisherSuggestionAdminDeliveryJobId(
  requiredBotId: string,
  suggestionId: string,
): string {
  return `publisher-suggestion-admin-deliver-${digestJobIdentity(
    requiredBotId.trim(),
    suggestionId.trim(),
  )}`;
}

export function buildPublisherSuggestionAdminReviewJobId(
  requiredBotId: string,
  dedupeKey: string,
): string {
  return `publisher-suggestion-admin-review-${digestJobIdentity(
    requiredBotId.trim(),
    dedupeKey.trim(),
  )}`;
}

export function buildPublisherSuggestionAdminSyncJobId(
  requiredBotId: string,
  suggestionId: string,
  reviewStatus: PublisherSuggestionAdminReviewStatus,
): string {
  return `publisher-suggestion-admin-sync-${digestJobIdentity(
    requiredBotId.trim(),
    suggestionId.trim(),
    reviewStatus,
  )}`;
}

export function buildPublisherSuggestionAdminSyncMarker(
  requiredBotId: string,
  reviewStatus: PublisherSuggestionAdminReviewStatus,
): string {
  return `v1:${digestJobIdentity(requiredBotId.trim(), reviewStatus)}`;
}

export function buildPublisherSuggestionAdminReviewCallbackPayload(
  action: PublisherSuggestionAdminReviewAction,
  suggestionId: string,
): string {
  return `${PUBLISHER_SUGGESTION_ADMIN_CALLBACK_PREFIX}${action}:${suggestionId.trim()}`;
}

export type PublisherSuggestionEnqueueOutcome =
  | 'enqueue_requested'
  | 'retried'
  | 'existing'
  | 'invalid';

@Injectable()
export class PublisherSuggestionAdminQueueService implements OnModuleDestroy {
  private failedSyncScanOffset = 0;
  private events: QueueEvents | null = null;

  constructor(
    @InjectQueue(PUBLISHER_SUGGESTION_ADMIN_QUEUE)
    private readonly queue: Queue<PublisherSuggestionAdminJob>,
  ) {}

  async onModuleDestroy(): Promise<void> {
    await this.events?.close();
  }

  async checkSubscription(chatId: string, userId: string, requiredBotId: string): Promise<boolean> {
    const counts = await this.queue.getJobCounts(
      'wait',
      'active',
      'delayed',
      'prioritized',
      'paused',
    );
    if (Object.values(counts).reduce((sum, value) => sum + value, 0) >= 100) {
      throw new ServiceUnavailableException('Проверка подписки занята. Повторите отправку позже.');
    }
    this.events ??= new QueueEvents(this.queue.name, {
      connection: this.queue.opts.connection,
      prefix: this.queue.opts.prefix,
    });
    const job = await this.queue.add(
      'subscription',
      {
        version: 1,
        kind: 'subscription',
        chatId,
        userId,
        requiredBotId,
        requestedAt: new Date().toISOString(),
      },
      {
        jobId: `suggestion-subscription-${randomUUID()}`,
        priority: 1,
        attempts: 1,
        removeOnComplete: { age: 30, count: 100 },
        removeOnFail: { age: 30, count: 100 },
      },
    );
    try {
      const result: unknown = await job.waitUntilFinished(this.events, 8_000);
      if (typeof result !== 'boolean') throw new Error('Missing subscription verdict');
      return result;
    } catch {
      throw new ServiceUnavailableException(
        'Не удалось проверить подписку. Повторите отправку позже.',
      );
    }
  }

  async enqueueDelivery(params: {
    suggestionId: string;
    requiredBotId: string;
    requestedAt?: Date;
    recoverExisting?: boolean;
  }): Promise<PublisherSuggestionEnqueueOutcome> {
    const suggestionId = params.suggestionId.trim();
    const requiredBotId = params.requiredBotId.trim();
    if (!suggestionId || !requiredBotId) return 'invalid';
    const requestedAt = params.requestedAt ?? new Date();
    const jobId = buildPublisherSuggestionAdminDeliveryJobId(requiredBotId, suggestionId);
    if (params.recoverExisting) {
      const outcome = await this.retryExistingJob(jobId);
      if (outcome) return outcome;
    }

    await this.queue.add(
      'deliver',
      {
        version: 1,
        kind: 'deliver',
        suggestionId,
        requiredBotId,
        requestedAt: requestedAt.toISOString(),
      },
      {
        jobId,
        priority: 2,
        attempts: 8,
        backoff: { type: 'exponential', delay: 5_000 },
        removeOnComplete: true,
        removeOnFail: { age: 24 * 60 * 60, count: 5_000 },
      },
    );
    // Queue.add can race with another producer; acceptance does not prove creation or delivery.
    return 'enqueue_requested';
  }

  private async retryExistingJob(jobId: string): Promise<'existing' | 'retried' | null> {
    const existing = await this.queue.getJob(jobId);
    if (!existing) return null;
    const state = await existing.getState();
    if (state === 'failed' || state === 'completed') {
      await existing.retry(state, {
        resetAttemptsMade: true,
        resetAttemptsStarted: true,
      });
      return 'retried';
    }
    return 'existing';
  }

  async enqueueReview(params: {
    suggestionId: string;
    requiredBotId: string;
    action: PublisherSuggestionAdminReviewAction;
    actor: PublisherSuggestionAdminReviewActor;
    callbackId: string;
    privateChatId: string;
    messageId: string;
    webhookEventId?: string | null;
    updateId: string;
    dedupeKey?: string;
    requestedAt?: Date;
  }): Promise<void> {
    const suggestionId = params.suggestionId.trim();
    const requiredBotId = params.requiredBotId.trim();
    const callbackId = params.callbackId.trim();
    const privateChatId = params.privateChatId.trim();
    const messageId = params.messageId.trim();
    const updateId = params.updateId.trim();
    const dedupeKey = params.dedupeKey?.trim() || callbackId || updateId;
    if (
      !suggestionId ||
      !requiredBotId ||
      !params.actor.userId.trim() ||
      !callbackId ||
      !privateChatId ||
      !messageId ||
      !updateId ||
      !dedupeKey
    ) {
      return;
    }
    const requestedAt = params.requestedAt ?? new Date();

    await this.queue.add(
      'review',
      {
        version: 1,
        kind: 'review',
        suggestionId,
        requiredBotId,
        action: params.action,
        actor: {
          userId: params.actor.userId.trim(),
          username: normalizeOptionalString(params.actor.username),
          displayName: normalizeOptionalString(params.actor.displayName),
          avatarUrl: normalizeOptionalString(params.actor.avatarUrl),
          profileUrl: normalizeOptionalString(params.actor.profileUrl),
        },
        callbackId,
        privateChatId,
        messageId,
        webhookEventId: normalizeOptionalString(params.webhookEventId),
        updateId,
        requestedAt: requestedAt.toISOString(),
      },
      {
        jobId: buildPublisherSuggestionAdminReviewJobId(requiredBotId, dedupeKey),
        priority: 1,
        attempts: 5,
        backoff: { type: 'exponential', delay: 1_000 },
        removeOnComplete: { age: 60 * 60, count: 5_000 },
        removeOnFail: { age: 24 * 60 * 60, count: 5_000 },
      },
    );
  }

  async enqueueSync(params: {
    suggestionId: string;
    requiredBotId: string;
    reviewStatus: PublisherSuggestionAdminReviewStatus;
    requestedAt?: Date;
    recoverExisting?: boolean;
  }): Promise<PublisherSuggestionEnqueueOutcome> {
    const suggestionId = params.suggestionId.trim();
    const requiredBotId = params.requiredBotId.trim();
    if (!suggestionId || !requiredBotId) return 'invalid';
    const requestedAt = params.requestedAt ?? new Date();
    const jobId = buildPublisherSuggestionAdminSyncJobId(
      requiredBotId,
      suggestionId,
      params.reviewStatus,
    );
    if (params.recoverExisting) {
      const outcome = await this.retryExistingJob(jobId);
      if (outcome) return outcome;
    }

    await this.queue.add(
      'sync',
      {
        version: 1,
        kind: 'sync',
        suggestionId,
        requiredBotId,
        reviewStatus: params.reviewStatus,
        requestedAt: requestedAt.toISOString(),
      },
      {
        jobId,
        priority: 1,
        attempts: 5,
        backoff: { type: 'exponential', delay: 1_000 },
        removeOnComplete: { age: 60 * 60, count: 5_000 },
        removeOnFail: { age: 30 * 24 * 60 * 60, count: 5_000 },
      },
    );
    // Queue.add can race with another producer; acceptance does not prove creation or delivery.
    return 'enqueue_requested';
  }

  async recoverFailedSyncJobs(requiredBotId: string, limit = 25): Promise<number> {
    const normalizedBotId = requiredBotId.trim();
    if (!normalizedBotId) return 0;
    const boundedLimit = Math.max(
      1,
      Math.min(100, Number.isFinite(limit) ? Math.trunc(limit) : 25),
    );
    const scanLimit = Math.min(400, boundedLimit * 4);
    const scanStart = this.failedSyncScanOffset;
    const jobs = await this.queue.getJobs(['failed'], scanStart, scanStart + scanLimit - 1, true);
    this.failedSyncScanOffset = jobs.length < scanLimit ? 0 : scanStart + scanLimit;
    let recovered = 0;
    for (const job of jobs) {
      if (recovered >= boundedLimit) break;
      if (job.data.kind !== 'sync' || job.data.requiredBotId !== normalizedBotId) continue;
      try {
        await job.retry('failed', {
          resetAttemptsMade: true,
          resetAttemptsStarted: true,
        });
        recovered += 1;
      } catch {
        // Another recovery/worker may have moved the job after the bounded failed snapshot.
      }
    }
    return recovered;
  }
}

function normalizeOptionalString(value: string | null | undefined): string | null {
  const normalized = value?.trim() ?? '';
  return normalized || null;
}
