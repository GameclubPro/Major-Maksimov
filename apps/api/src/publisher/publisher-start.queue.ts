import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import type { MaxUpdate } from '@maxim/contracts';
import type { Queue } from 'bullmq';
import { createHash } from 'node:crypto';
import { isPrivateDirectChatId } from '../common/chat-id.util';
import { isManagedEntityForwardedRecoveryMessage } from '../common/managed-entity-forwarded-recovery.util';
import { MaxBotRegistryService } from '../max/max-bot-registry.service';
import { readWebhookEventTimestamp } from '../webhook/webhook-semantic-event-key';
import { PrismaService } from '../prisma/prisma.service';
import { PUBLISHER_COMMENT_ACTION } from './publisher-comment-notification.service';

export const PUBLISHER_START_QUEUE = 'publisher-start';
export const PUBLISHER_START_MAX_AGE_MS = 24 * 60 * 60_000;

export function isFreshPublisherStart(requestedAt: string): boolean {
  const age = Date.now() - Date.parse(requestedAt);
  return Number.isFinite(age) && age >= -60_000 && age <= PUBLISHER_START_MAX_AGE_MS;
}

type PublisherStartTarget = {
  publisherBotId: string;
  privateChatId: string;
  requestedAt: string;
  dispatchStarted?: boolean;
};

export type PublisherCommentProfileStartJob = PublisherStartTarget & {
  version: 4;
  actorUserId: string;
  signedStartPayload: string;
};

export type PublisherStartJob =
  | (PublisherStartTarget & { version: 1 | 2 | 3 })
  | PublisherCommentProfileStartJob;

@Injectable()
export class PublisherStartQueueService {
  private readonly publisherBotId: string;

  constructor(
    @InjectQueue(PUBLISHER_START_QUEUE) private readonly queue: Queue<PublisherStartJob>,
    botRegistry: MaxBotRegistryService,
    private readonly prisma: PrismaService,
  ) {
    this.publisherBotId = botRegistry.getPublisherBotDescriptor().id;
  }

  async observeWebhook(update: MaxUpdate): Promise<boolean> {
    if (update.botId?.trim() !== this.publisherBotId) return false;
    const type = update.type.trim().toLowerCase();
    const privateChatId = update.message?.chatId?.trim() ?? '';
    if (!isPrivateDirectChatId(privateChatId) || update.message?.entityType === 'channel') {
      return false;
    }
    // FLAG: Normalized text includes forwarded content. A source post saying Start
    // remains an entity-connection candidate, never an instruction to greet its forwarder.
    if (isManagedEntityForwardedRecoveryMessage(update, { allowOfficialForwardContent: true }))
      return false;
    if (type === 'bot_started') {
      const raw = asRecord(update.raw);
      const data = asRecord(raw?.data);
      const event = asRecord(raw?.event);
      const nodes = [
        raw,
        data,
        event,
        asRecord(raw?.bot_started),
        asRecord(data?.bot_started),
        asRecord(event?.bot_started),
      ];
      if (
        nodes.some((node) =>
          [node?.payload, node?.start_payload, node?.startPayload].some(
            (value) => value !== undefined && value !== null && value !== '',
          ),
        )
      )
        return false;
    } else if (
      type !== 'message_created' ||
      !['/start', 'старт'].includes(update.message?.text?.trim().toLowerCase() ?? '')
    ) {
      return false;
    }

    const requestedAt = readWebhookEventTimestamp(update);
    if (!requestedAt || !isFreshPublisherStart(requestedAt.toISOString())) {
      return true;
    }
    const identity = createHash('sha256')
      .update(`${this.publisherBotId}\0${privateChatId}\0${update.updateId}`)
      .digest('hex');
    const id = `publisher-start-${identity}`;
    // FLAG: Commit before acknowledging the source event or touching Redis. Re-observation
    // preserves the original deadline and any already recorded dispatch attempt.
    const intent = await this.prisma.publisherStartIntent.upsert({
      where: { id },
      update: {},
      create: {
        id,
        publisherBotId: this.publisherBotId,
        privateChatId,
        requestedAt,
        expiresAt: new Date(requestedAt.getTime() + PUBLISHER_START_MAX_AGE_MS),
      },
    });
    if (intent.status === 'PENDING') await this.enqueueIntent(intent);
    return true;
  }

  async enqueueIntent(intent: {
    id: string;
    publisherBotId: string;
    privateChatId: string;
    requestedAt: Date;
  }): Promise<void> {
    const job = await this.queue.add(
      'greet',
      {
        version: 3,
        publisherBotId: intent.publisherBotId,
        privateChatId: intent.privateChatId,
        requestedAt: intent.requestedAt.toISOString(),
      },
      {
        jobId: intent.id,
        attempts: 3,
        backoff: { type: 'exponential', delay: 1_000 },
        // FLAG: Retain the dispatch fence longer than the accepted event age, including failures.
        removeOnComplete: { age: 2 * 24 * 60 * 60 },
        removeOnFail: { age: 2 * 24 * 60 * 60 },
      },
    );
    // FLAG: A terminal job may have exhausted retries before entering the durable
    // dispatch fence. Retry the same identity only while SQL still says PENDING.
    if (job?.getState && (await job.getState()) === 'failed') {
      const pending = await this.prisma.publisherStartIntent.findFirst({
        where: { id: intent.id, status: 'PENDING', expiresAt: { gt: new Date() } },
        select: { id: true },
      });
      if (pending) await job.retry('failed');
    }
    await this.prisma.publisherStartIntent.updateMany({
      where: { id: intent.id, status: 'PENDING' },
      data: { nextEnqueueAt: new Date(Date.now() + 60_000) },
    });
  }

  async claimDurableDispatch(id: string, data: PublisherStartJob): Promise<boolean> {
    const claimed = await this.prisma.publisherStartIntent.updateMany({
      where: {
        id,
        status: 'PENDING',
        publisherBotId: data.publisherBotId,
        privateChatId: data.privateChatId,
        requestedAt: new Date(data.requestedAt),
        expiresAt: { gt: new Date() },
      },
      data: { status: 'ATTEMPTED' },
    });
    return claimed.count === 1;
  }

  async findProfileComment(commentId: string) {
    return this.prisma.auditLog.findUnique({
      where: { id: commentId, action: PUBLISHER_COMMENT_ACTION },
      select: { actorUserId: true, payload: true },
    });
  }

  async completeIntent(id: string, status: 'SENT' | 'UNKNOWN'): Promise<void> {
    await this.prisma.publisherStartIntent.updateMany({
      where: { id, status: 'ATTEMPTED' },
      data: { status },
    });
  }

  async claimDispatch(jobId: string): Promise<boolean> {
    const client = await this.queue.client;
    client.defineCommand('claimPublisherStartDispatch', {
      numberOfKeys: 1,
      lua: "return redis.call('SET', KEYS[1], '1', 'PX', ARGV[1], 'NX')",
    });
    return (
      (await client.runCommand('claimPublisherStartDispatch', [
        this.queue.toKey(`dispatch-${jobId}`),
        2 * PUBLISHER_START_MAX_AGE_MS,
      ])) === 'OK'
    );
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
