import {
  checkPublisherCommentReadiness,
  PublisherCommentSetupBlockedError,
} from './publisher-comment-readiness';
import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { UnrecoverableError } from 'bullmq';
import { MAX_API_SOURCE_TAGS, MaxClientService } from '../max/max-client.service';
import { isAmbiguousMaxSendError } from '../max/max-send-ambiguity.util';
import type {
  PublisherCommentNotificationEvent,
  PublisherCommentNotificationDelivery,
} from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import { getAppRole, roleRunsPublisher } from '../runtime/app-role';
import { PublisherBackgroundWorkCoordinatorService } from './publisher-background-work-coordinator.service';
import {
  PublisherChatCommentQueueService,
  type PublisherCommentNotificationJob,
} from './publisher-chat-comment.queue';
import {
  PublisherCommentNotificationService,
  readPublisherNotificationComment,
  type PublisherCommentScope,
} from './publisher-comment-notification.service';
import { PublisherDialogLinkService } from './publisher-dialog-link.service';
import {
  PublisherDispatchHealthService,
  extractPublisherMaxStatusCode,
} from './publisher-dispatch-health.service';
import { PublisherIdentityAttestationService } from './publisher-identity-attestation.service';
import { PublisherReadinessService } from './publisher-readiness.service';
import { PublisherRuntimeBoundaryService } from './publisher-runtime-boundary.service';

const LEASE_MS = 60_000;
const RECOVERY_MS = 30_000;
const SETUP_RECHECK_MS = 15 * 60_000;
const CONFIRMED_RECEIPT_WRITE_ATTEMPTS = 3;
const FANOUT_BATCH = 100;
const SEND_BATCH = 10;
class NotificationCancelled extends Error {}
class NotificationLeaseLost extends Error {}

export function publisherNotificationFailure(
  error: unknown,
  attempted: boolean,
): 'PENDING' | 'FAILED' | 'UNKNOWN' {
  const status = extractPublisherMaxStatusCode(error);
  if (attempted && (isAmbiguousMaxSendError(error) || !status)) return 'UNKNOWN';
  if (status && status >= 400 && status < 500 && status !== 408 && status !== 429) return 'FAILED';
  return 'PENDING';
}

@Injectable()
export class PublisherCommentNotificationDeliveryService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PublisherCommentNotificationDeliveryService.name);
  private timer: NodeJS.Timeout | null = null;
  private retentionAfter: { expiresAt: Date; id: string } | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly preferences: PublisherCommentNotificationService,
    private readonly queue: PublisherChatCommentQueueService,
    private readonly maxClient: MaxClientService,
    private readonly links: PublisherDialogLinkService,
    private readonly readiness: PublisherReadinessService,
    private readonly boundary: PublisherRuntimeBoundaryService,
    private readonly identity: PublisherIdentityAttestationService,
    private readonly health: PublisherDispatchHealthService,
    private readonly background: PublisherBackgroundWorkCoordinatorService,
  ) {}

  onModuleInit(): void {
    this.assertRole();
    this.timer = setInterval(() => {
      void this.background
        .runExclusive('comment_notification_recovery', () => this.recoverOnce())
        .catch(() => this.logger.warn('Publisher comment notification recovery deferred'));
    }, RECOVERY_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async recoverOnce(): Promise<void> {
    this.assertRole();
    if (!this.boundary.dispatchEnabled) return;
    const now = new Date();
    const events = await this.prisma.publisherCommentNotificationEvent.findMany({
      where: { botId: this.preferences.botId, completed: false, availableAt: { lte: now } },
      orderBy: [{ availableAt: 'asc' }, { id: 'asc' }],
      take: 20,
    });
    for (const event of events) {
      if (event.lockedUntil && event.lockedUntil > now) continue;
      // Reserve the next recovery slot before enqueue; Redis failure is retried by the next scan.
      const reserved = await this.prisma.publisherCommentNotificationEvent.updateMany({
        where: { id: event.id, completed: false, availableAt: event.availableAt },
        data: { availableAt: new Date(now.getTime() + RECOVERY_MS) },
      });
      if (!reserved.count) continue;
      if (event.expiresAt <= now) {
        await this.prisma.publisherCommentNotificationEvent.updateMany({
          where: {
            id: event.id,
            completed: false,
            OR: [{ lockedUntil: null }, { lockedUntil: { lte: now } }],
          },
          data: { completed: true, lockToken: null, lockedUntil: null },
        });
      } else {
        await this.queue.enqueueNotification(event.id);
      }
    }
    // Bounded retention, including recipient rows, without a large cascading delete.
    const expired = await this.prisma.publisherCommentNotificationEvent.findMany({
      where: {
        botId: this.preferences.botId,
        completed: true,
        expiresAt: { lt: new Date(now.getTime() - 7 * 24 * 60 * 60_000) },
        ...(this.retentionAfter
          ? {
              OR: [
                { expiresAt: { gt: this.retentionAfter.expiresAt } },
                { expiresAt: this.retentionAfter.expiresAt, id: { gt: this.retentionAfter.id } },
              ],
            }
          : {}),
      },
      orderBy: [{ expiresAt: 'asc' }, { id: 'asc' }],
      take: 5,
      select: { id: true, expiresAt: true },
    });
    this.retentionAfter = expired.at(-1) ?? null;
    for (const event of expired) {
      const rows = await this.prisma.publisherCommentNotificationDelivery.findMany({
        where: { eventId: event.id, status: { notIn: ['SENDING', 'UNKNOWN'] } },
        orderBy: { id: 'asc' },
        take: 100,
        select: { id: true },
      });
      if (rows.length)
        await this.prisma.publisherCommentNotificationDelivery.deleteMany({
          where: {
            id: { in: rows.map((row) => row.id) },
            status: { notIn: ['SENDING', 'UNKNOWN'] },
          },
        });
      if (rows.length < 100)
        await this.prisma.publisherCommentNotificationEvent.deleteMany({
          // FLAG: Never cascade-delete uncertainty. Advance the bounded retention
          // cursor past retained evidence so it cannot starve cleanup of other events.
          where: { id: event.id, completed: true, deliveries: { none: {} } },
        });
    }
  }

  async process(job: PublisherCommentNotificationJob): Promise<void> {
    this.assertRole();
    if (
      job.requiredBotId !== this.preferences.botId ||
      this.links.getBotId() !== job.requiredBotId
    ) {
      throw new UnrecoverableError('Publisher notification bot mismatch');
    }
    const now = new Date();
    const lockToken = randomUUID();
    const claim = await this.prisma.publisherCommentNotificationEvent.updateMany({
      where: {
        id: job.eventId,
        botId: job.requiredBotId,
        completed: false,
        OR: [{ lockedUntil: null }, { lockedUntil: { lte: now } }],
      },
      data: { lockToken, lockedUntil: new Date(now.getTime() + LEASE_MS) },
    });
    if (!claim.count) return;
    let completed = false;
    let continueNow = false;
    let setupRetryAt: Date | null = null;
    let expiresAt: Date | null = null;
    try {
      const event = await this.prisma.publisherCommentNotificationEvent.findUniqueOrThrow({
        where: { id: job.eventId },
      });
      expiresAt = event.expiresAt;
      const target = this.target(event);
      const comment = await readPublisherNotificationComment(this.prisma, target, event.id);
      if (!comment || event.expiresAt <= new Date()) {
        completed = true;
        return;
      }
      await this.assertReady(event);
      // FLAG: A crashed sender may have reached MAX. Never reclaim SENDING for another send.
      await this.prisma.publisherCommentNotificationDelivery.updateMany({
        where: { eventId: event.id, status: 'SENDING' },
        data: { status: 'UNKNOWN', errorCode: 'worker_interrupted' },
      });
      if (!event.expanded) await this.expand(event, lockToken);
      const deliveries = await this.prisma.publisherCommentNotificationDelivery.findMany({
        where: { eventId: event.id, status: 'PENDING', availableAt: { lte: new Date() } },
        orderBy: [{ availableAt: 'asc' }, { id: 'asc' }],
        take: SEND_BATCH,
      });
      const deadline = Date.now() + 20_000;
      for (const delivery of deliveries) {
        if (Date.now() >= deadline) break;
        await this.deliver(event, delivery, lockToken);
      }
      const pending = await this.prisma.publisherCommentNotificationDelivery.findFirst({
        where: { eventId: event.id, status: 'PENDING' },
        orderBy: [{ availableAt: 'asc' }, { id: 'asc' }],
        select: { availableAt: true },
      });
      const refreshed = await this.prisma.publisherCommentNotificationEvent.findUniqueOrThrow({
        where: { id: event.id },
        select: { expanded: true },
      });
      completed = refreshed.expanded && !pending;
      continueNow = !refreshed.expanded || Boolean(pending && pending.availableAt <= new Date());
    } catch (error: unknown) {
      // FLAG: A persistent pre-send blocker delays the event without changing any recipient receipt.
      if (!expiresAt || !(error instanceof PublisherCommentSetupBlockedError)) throw error;
      setupRetryAt = new Date(Math.min(expiresAt.getTime(), Date.now() + SETUP_RECHECK_MS));
    } finally {
      await this.prisma.publisherCommentNotificationEvent.updateMany({
        where: { id: job.eventId, lockToken },
        data: {
          completed,
          lockToken: null,
          // FLAG: Retain the retry time for both the outbox scanner and previously queued jobs.
          lockedUntil: setupRetryAt,
          availableAt: setupRetryAt ?? new Date(Date.now() + RECOVERY_MS),
        },
      });
    }
    if (!completed && continueNow) await this.preferences.enqueue(job.eventId);
  }

  private async expand(event: PublisherCommentNotificationEvent, lockToken: string): Promise<void> {
    const target = this.target(event);
    const reply = event.replyToId
      ? await readPublisherNotificationComment(this.prisma, target, event.replyToId)
      : null;
    const rows = await this.prisma.publisherCommentNotificationPreference.findMany({
      where: {
        ...this.preferences.preferenceWhere(target),
        AND: [{ OR: [{ mode: 'ALL' }, ...(reply ? [{ userId: reply.actorUserId }] : [])] }],
        createdAt: { lte: event.createdAt },
        ...(event.cursor ? { id: { gt: event.cursor } } : {}),
      },
      orderBy: { id: 'asc' },
      take: FANOUT_BATCH,
      select: { id: true, userId: true },
    });
    await this.prisma.$transaction(async (tx) => {
      const owned = await tx.publisherCommentNotificationEvent.updateMany({
        where: { id: event.id, lockToken, lockedUntil: { gt: new Date() } },
        data: {
          cursor: rows.at(-1)?.id ?? event.cursor,
          expanded: rows.length < FANOUT_BATCH,
          lockedUntil: new Date(Date.now() + LEASE_MS),
        },
      });
      if (!owned.count) throw new NotificationLeaseLost();
      await tx.publisherCommentNotificationDelivery.createMany({
        data: [...new Set(rows.map((row) => row.userId))]
          .filter((userId) => userId !== event.authorUserId)
          .map((userId) => ({ eventId: event.id, userId })),
        skipDuplicates: true,
      });
    });
  }

  private async deliver(
    event: PublisherCommentNotificationEvent,
    delivery: PublisherCommentNotificationDelivery,
    lockToken: string,
  ): Promise<void> {
    const target = this.target(event);
    const reply = event.replyToId
      ? await readPublisherNotificationComment(this.prisma, target, event.replyToId)
      : null;
    const isReply = reply?.actorUserId === delivery.userId;
    const comment = await readPublisherNotificationComment(this.prisma, target, event.id);
    if (!comment || !(await this.preferences.canReceive(target, delivery.userId, isReply))) {
      await this.finish(delivery.id, 'SKIPPED');
      return;
    }
    const name =
      typeof comment.payload.authorDisplayName === 'string'
        ? comment.payload.authorDisplayName.trim().slice(0, 100)
        : '';
    const text =
      typeof comment.payload.text === 'string' ? comment.payload.text.trim().slice(0, 600) : '';
    const title = isReply ? 'Ответ на ваш комментарий' : 'Новый комментарий';
    const body = `${title}\n\n${name || 'Участник'}: ${text || 'Комментарий'}`;
    const button =
      target.entityType === 'channel'
        ? this.links.buildChannelDialogButton(
            target.chatId,
            'comments',
            target.threadId,
            'Открыть комментарии',
          )
        : this.links.buildChatDialogButton(
            target.chatId,
            'comments',
            target.threadId,
            'Открыть комментарии',
          );
    let sendStartedAt: Date | null = null;
    let receipt: { messageId: string };
    try {
      receipt = await this.maxClient.sendMessageImmediateToUser(
        delivery.userId,
        body,
        {
          buttons: [[button]],
          beforeSend: async () => {
            await this.assertReady(event);
            if (
              !(await readPublisherNotificationComment(this.prisma, target, event.id)) ||
              !(await this.preferences.canReceive(target, delivery.userId, isReply))
            )
              throw new NotificationCancelled();
            // FLAG: Lease and recipient CAS must commit before POST /messages, with no network in SQL.
            const started = new Date();
            await this.prisma.$transaction(async (tx) => {
              const lease = await tx.publisherCommentNotificationEvent.updateMany({
                where: {
                  id: event.id,
                  lockToken,
                  lockedUntil: { gt: new Date() },
                  completed: false,
                  expiresAt: { gt: new Date() },
                },
                data: { lockedUntil: new Date(Date.now() + LEASE_MS) },
              });
              if (!lease.count) throw new NotificationLeaseLost();
              const result = await tx.publisherCommentNotificationDelivery.updateMany({
                where: { id: delivery.id, status: 'PENDING' },
                data: { status: 'SENDING', sendStartedAt: started, attempts: { increment: 1 } },
              });
              if (!result.count) throw new NotificationLeaseLost();
            });
            sendStartedAt = started;
          },
        },
        {
          botId: event.botId,
          trafficClass: 'background',
          sourceTag: MAX_API_SOURCE_TAGS.COMMENT_NOTIFICATION,
          timeoutMs: 5_000,
          ignoreFailureMetricStatuses: [403, 404],
        },
      );
    } catch (error: unknown) {
      const claimed = sendStartedAt !== null;
      if (
        error instanceof NotificationLeaseLost ||
        (!claimed && error instanceof PublisherCommentSetupBlockedError)
      )
        throw error;
      const status =
        error instanceof NotificationCancelled
          ? 'SKIPPED'
          : publisherNotificationFailure(error, claimed);
      const terminalStatus = status === 'PENDING' && delivery.attempts >= 11 ? 'FAILED' : status;
      await this.prisma.publisherCommentNotificationDelivery.updateMany({
        where: { id: delivery.id, status: claimed ? 'SENDING' : 'PENDING' },
        data: {
          status: terminalStatus,
          errorCode:
            error instanceof NotificationCancelled
              ? 'cancelled'
              : `max_${extractPublisherMaxStatusCode(error) ?? 'transport'}`,
          availableAt: new Date(
            Date.now() + Math.min(15 * 60_000, 30_000 * 2 ** Math.min(delivery.attempts, 5)),
          ),
          ...(!claimed ? { attempts: { increment: 1 } } : {}),
        },
      });
      if (terminalStatus === 'UNKNOWN' || terminalStatus === 'FAILED') {
        this.logger.warn(
          { eventId: event.id, deliveryId: delivery.id, status: terminalStatus },
          'Publisher comment notification delivery stopped',
        );
      }
      return;
    }
    // FLAG: A failed receipt write must leave SENDING fenced, never reset it to PENDING.
    if (!sendStartedAt) throw new Error('Publisher notification receipt has no send fence');
    for (let attempt = 1; attempt <= CONFIRMED_RECEIPT_WRITE_ATTEMPTS; attempt++) {
      try {
        const persisted = await this.prisma.publisherCommentNotificationDelivery.updateMany({
          where: {
            id: delivery.id,
            sendStartedAt,
            OR: [
              { status: { in: ['SENDING', 'UNKNOWN'] }, messageId: null },
              { status: 'SENT', messageId: receipt.messageId },
            ],
          },
          data: { status: 'SENT', messageId: receipt.messageId, errorCode: null },
        });
        if (persisted.count !== 1)
          throw new Error('Could not confirm Publisher notification receipt');
        return;
      } catch (error: unknown) {
        if (attempt === CONFIRMED_RECEIPT_WRITE_ATTEMPTS) throw error;
      }
    }
  }

  private async finish(id: string, status: 'SKIPPED'): Promise<void> {
    await this.prisma.publisherCommentNotificationDelivery.updateMany({
      where: { id, status: 'PENDING' },
      data: { status },
    });
  }

  private async assertReady(event: PublisherCommentNotificationEvent): Promise<void> {
    this.boundary.assertDispatchEnabled();
    await this.identity.assertAttested();
    await this.health.assertDispatchAllowed();
    const route = await checkPublisherCommentReadiness(() =>
      this.readiness.assertEntityReady(event.chatId, 'publication'),
    );
    if (route.requiredBotId !== event.botId || route.entityType !== this.target(event).entityType)
      throw new UnrecoverableError('Publisher notification route mismatch');
  }

  private target(event: PublisherCommentNotificationEvent): PublisherCommentScope {
    return {
      chatId: event.chatId,
      threadId: event.threadId,
      entityType: event.entityType === 'CHANNEL' ? 'channel' : 'chat',
    };
  }

  private assertRole(): void {
    if (!roleRunsPublisher(getAppRole()) || process.env.APP_SERVICE_NAME !== 'api-publisher')
      throw new Error('Publisher notifications require api-publisher');
  }
}
