import { InjectQueue } from '@nestjs/bullmq';
import { BadRequestException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import type { MaxUpdate } from '@maxim/contracts';
import type { Queue } from 'bullmq';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { isPrivateDirectChatId } from '../common/chat-id.util';
import { isValidMaxBotStartPayload } from '../max/max-deep-link.util';
import { MaxBotRegistryService } from '../max/max-bot-registry.service';
import { readWebhookEventTimestamp } from '../webhook/webhook-semantic-event-key';
import { PublisherDialogSigningKeyService } from './publisher-dialog-signing-key.service';
import { readPublisherPrivateStartPayload } from './publisher-private-flow-update-reader';
import {
  PUBLISHER_START_QUEUE,
  type PublisherCommentProfileStartJob,
  type PublisherStartJob,
} from './publisher-start.queue';

const START_PREFIX = 'pcp1';
const HANDOFF_LIFETIME_MS = 5 * 60_000;
const EVENT_CLOCK_SKEW_MS = 60_000;
const COMMENT_ID = /^[A-Za-z0-9-]{1,64}$/u;
const USER_ID = /^[1-9][0-9]{0,19}$/u;
const EXPIRY = /^[0-9a-z]{1,9}$/u;
const SIGNATURE = /^[0-9a-f]{32}$/u;

@Injectable()
export class PublisherCommentProfileService {
  private readonly botId: string;

  constructor(
    @InjectQueue(PUBLISHER_START_QUEUE) private readonly queue: Queue<PublisherStartJob>,
    botRegistry: MaxBotRegistryService,
    private readonly signingKeys: PublisherDialogSigningKeyService,
  ) {
    this.botId = botRegistry.getPublisherBotDescriptor().id;
  }

  buildStartUrl(params: { actorUserId: string; commentId: string }): string {
    const { actorUserId, commentId } = params;
    if (!USER_ID.test(actorUserId) || !COMMENT_ID.test(commentId)) {
      throw new BadRequestException('Не удалось открыть профиль автора комментария.');
    }
    const key = this.signingKeys.getSigningKeys()[0];
    if (!key) {
      throw new ServiceUnavailableException('Ссылка на профиль временно недоступна.');
    }
    const expiresAt = Math.floor((Date.now() + HANDOFF_LIFETIME_MS) / 1_000).toString(36);
    const content = [START_PREFIX, actorUserId, commentId, expiresAt].join('_');
    const payload = `${content}_${this.sign(content, key).toString('hex')}`;
    if (!isValidMaxBotStartPayload(payload)) {
      throw new BadRequestException('Не удалось открыть профиль автора комментария.');
    }
    // FLAG: The shared admin runtime does not carry the Publisher action bot. Its ordinary bot
    // link helper can fall back to Major, so the configured Publisher identity owns this link.
    return `https://max.ru/${encodeURIComponent(this.botId)}?start=${payload}`;
  }

  async observeWebhook(update: MaxUpdate): Promise<boolean> {
    if (update.botId !== this.botId) return false;
    const payload = readPublisherPrivateStartPayload(update);
    if (!payload?.startsWith(`${START_PREFIX}_`)) return false;

    const actorUserId = update.message?.senderId;
    const privateChatId = update.message?.chatId;
    if (
      !actorUserId ||
      !USER_ID.test(actorUserId) ||
      !privateChatId ||
      !isPrivateDirectChatId(privateChatId) ||
      update.message?.entityType === 'channel'
    ) {
      return true;
    }

    // FLAG: Ingress and enqueue roles do not have Publisher signing keys. Check the
    // envelope here. Only the Publisher worker verifies the signature and resolves the comment.
    const handoff = parseStartPayload(payload, actorUserId);
    const requestedAt = readWebhookEventTimestamp(update);
    if (!handoff || !requestedAt) return true;
    if (!isFreshHandoff(handoff.expiresAtMs, requestedAt.getTime())) {
      return true;
    }

    // FLAG: A single signed URL has one delivery identity across duplicate MAX events and job
    // retries. The worker also requires the matching owner and an unexpired source.
    await this.queue.add(
      'comment-author-profile',
      {
        version: 4,
        publisherBotId: this.botId,
        privateChatId,
        requestedAt: requestedAt.toISOString(),
        actorUserId,
        signedStartPayload: payload,
      },
      {
        jobId: this.buildJobId(payload),
        attempts: 3,
        backoff: { type: 'exponential', delay: 1_000 },
        removeOnComplete: { age: 2 * 24 * 60 * 60 },
        removeOnFail: { age: 2 * 24 * 60 * 60 },
      },
    );
    return true;
  }

  verifyQueuedStart(job: PublisherCommentProfileStartJob, jobId: string) {
    const { actorUserId, requestedAt, signedStartPayload, publisherBotId } = job;
    if (
      publisherBotId !== this.botId ||
      typeof signedStartPayload !== 'string' ||
      jobId !== this.buildJobId(signedStartPayload)
    ) {
      return null;
    }

    const handoff = parseStartPayload(signedStartPayload, actorUserId);
    if (!handoff || !isFreshHandoff(handoff.expiresAtMs, Date.parse(requestedAt))) return null;
    if (
      !this.signingKeys
        .getSigningKeys()
        .some((key) => timingSafeEqual(this.sign(handoff.content, key), handoff.signature))
    ) {
      return null;
    }
    return { commentId: handoff.commentId, expiresAtMs: handoff.expiresAtMs };
  }

  private buildJobId(payload: string): string {
    const identity = createHash('sha256')
      .update(this.botId)
      .update('\0')
      .update(payload)
      .digest('hex');
    return `publisher-comment-profile-${identity}`;
  }

  private sign(content: string, key: string): Buffer {
    return createHmac('sha256', key)
      .update(`publisher-comment-author-profile:${this.botId}:${content}`)
      .digest()
      .subarray(0, 16);
  }
}

function parseStartPayload(payload: string, actorUserId: string) {
  if (!isValidMaxBotStartPayload(payload)) return null;
  const [prefix, actor, commentId, expiresAt, signature, ...extra] = payload.split('_');
  if (
    prefix !== START_PREFIX ||
    actor !== actorUserId ||
    !actor ||
    !USER_ID.test(actor) ||
    !commentId ||
    !COMMENT_ID.test(commentId) ||
    !expiresAt ||
    !EXPIRY.test(expiresAt) ||
    !signature ||
    !SIGNATURE.test(signature) ||
    extra.length
  ) {
    return null;
  }

  const expiresAtMs = Number.parseInt(expiresAt, 36) * 1_000;
  if (!Number.isSafeInteger(expiresAtMs)) return null;

  return {
    commentId,
    expiresAtMs,
    content: [prefix, actor, commentId, expiresAt].join('_'),
    signature: Buffer.from(signature, 'hex'),
  };
}

function isFreshHandoff(expiresAtMs: number, eventTime: number): boolean {
  const now = Date.now();
  return (
    Number.isFinite(eventTime) &&
    expiresAtMs > now &&
    expiresAtMs <= now + HANDOFF_LIFETIME_MS &&
    eventTime >= expiresAtMs - HANDOFF_LIFETIME_MS - EVENT_CLOCK_SKEW_MS &&
    eventTime < expiresAtMs &&
    eventTime <= now + EVENT_CLOCK_SKEW_MS
  );
}
