import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import {
  PublisherAutoReplyAuthoringState,
  PublisherPrivateFlowType,
} from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import { PublisherBackgroundWorkCoordinatorService } from './publisher-background-work-coordinator.service';
import {
  type PublisherAutoReplyAuthoringNotification,
  PublisherAutoReplyAuthoringQueueService,
} from './publisher-auto-reply-authoring.queue';
import { PublisherPrivateFlowLeaseService } from './publisher-private-flow-lease.service';
import { PublisherRuntimeBoundaryService } from './publisher-runtime-boundary.service';

const RECOVERY_STARTUP_DELAY_MS = 12_000;
const RECOVERY_INTERVAL_MS = 30_000;
const RECOVERY_BATCH_SIZE = 25;
const PROCESSING_LEASE_MS = 2 * 60_000;
const AMBIGUOUS_NOTIFICATION_STALE_MS = 60_000;
const RESULT_TTL_MS = 24 * 60 * 60_000;

const WAITING_STATES = [
  PublisherAutoReplyAuthoringState.AWAITING_START,
  PublisherAutoReplyAuthoringState.AWAITING_PHRASE,
  PublisherAutoReplyAuthoringState.AWAITING_CONTENT,
  PublisherAutoReplyAuthoringState.REVIEW,
] as const;

const TERMINAL_STATES = [
  PublisherAutoReplyAuthoringState.COMPLETED,
  PublisherAutoReplyAuthoringState.CANCELED,
  PublisherAutoReplyAuthoringState.FAILED,
  PublisherAutoReplyAuthoringState.EXPIRED,
] as const;

@Injectable()
export class PublisherAutoReplyAuthoringRecoveryService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PublisherAutoReplyAuthoringRecoveryService.name);
  private startupTimer: NodeJS.Timeout | null = null;
  private intervalTimer: NodeJS.Timeout | null = null;
  private inFlight: Promise<void> | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: PublisherAutoReplyAuthoringQueueService,
    private readonly privateFlows: PublisherPrivateFlowLeaseService,
    private readonly backgroundWork: PublisherBackgroundWorkCoordinatorService,
    private readonly runtimeBoundary: PublisherRuntimeBoundaryService,
  ) {}

  onModuleInit(): void {
    if (!this.runtimeBoundary.dispatchEnabled) return;
    this.startupTimer = setTimeout(() => this.trigger(), RECOVERY_STARTUP_DELAY_MS);
    this.startupTimer.unref();
    this.intervalTimer = setInterval(() => this.trigger(), RECOVERY_INTERVAL_MS);
    this.intervalTimer.unref();
  }

  onModuleDestroy(): void {
    if (this.startupTimer) clearTimeout(this.startupTimer);
    if (this.intervalTimer) clearInterval(this.intervalTimer);
    this.startupTimer = null;
    this.intervalTimer = null;
  }

  async recoverOnce(now = new Date()): Promise<void> {
    await this.backgroundWork.runExclusive('auto_reply_authoring_recovery', async () => {
      await this.expireWaiting(now);
      await this.failTimedOutWork(now);
      await this.recoverWork(now);
      await this.reconcileAmbiguousNotifications(now);
      await this.recoverNotifications(now);
      await this.deleteExpiredResults(now);
      await this.privateFlows.releaseExpired(now);
    });
  }

  private async expireWaiting(now: Date): Promise<void> {
    const rows = await this.prisma.publisherAutoReplyAuthoringSession.findMany({
      where: { state: { in: [...WAITING_STATES] }, expiresAt: { lte: now } },
      orderBy: [{ expiresAt: 'asc' }, { id: 'asc' }],
      take: RECOVERY_BATCH_SIZE,
      select: { id: true, state: true, publisherBotId: true, actorUserId: true },
    });
    for (const row of rows) {
      const expired = await this.prisma.publisherAutoReplyAuthoringSession.updateMany({
        where: { id: row.id, state: row.state, expiresAt: { lte: now } },
        data: {
          state: PublisherAutoReplyAuthoringState.EXPIRED,
          stageRevision: { increment: 1 },
          notificationKind: null,
          notificationPending: false,
          notificationRevision: { increment: 1 },
          lockedAt: null,
          lockToken: null,
          captureGuardUntil: null,
          expiresAt: new Date(now.getTime() + RESULT_TTL_MS),
        },
      });
      if (expired.count === 1) await this.releaseLease(row);
    }
  }

  private async failTimedOutWork(now: Date): Promise<void> {
    const rows = await this.prisma.publisherAutoReplyAuthoringSession.findMany({
      where: {
        state: {
          in: [
            PublisherAutoReplyAuthoringState.PROCESSING,
            PublisherAutoReplyAuthoringState.SAVING,
          ],
        },
        expiresAt: { lte: now },
      },
      orderBy: [{ expiresAt: 'asc' }, { id: 'asc' }],
      take: RECOVERY_BATCH_SIZE,
      select: { id: true, state: true, publisherBotId: true, actorUserId: true },
    });
    for (const row of rows) {
      const failed = await this.prisma.publisherAutoReplyAuthoringSession.updateMany({
        where: { id: row.id, state: row.state, expiresAt: { lte: now } },
        data: {
          state: PublisherAutoReplyAuthoringState.FAILED,
          stageRevision: { increment: 1 },
          failureCode:
            row.state === PublisherAutoReplyAuthoringState.PROCESSING
              ? 'processing_timeout'
              : 'saving_timeout',
          notificationKind: 'failed',
          notificationPending: true,
          notificationRevision: { increment: 1 },
          lockedAt: null,
          lockToken: null,
          captureGuardUntil: null,
          expiresAt: new Date(now.getTime() + RESULT_TTL_MS),
        },
      });
      if (failed.count !== 1) continue;
      await this.releaseLease(row);
      await this.queue.enqueueNotification({
        sessionId: row.id,
        notification: 'failed',
        dedupeKey: `${row.state.toLowerCase()}-timeout`,
        requestedAt: now,
      });
    }
  }

  private async recoverWork(now: Date): Promise<void> {
    const staleBefore = new Date(now.getTime() - PROCESSING_LEASE_MS);
    const processing = await this.prisma.publisherAutoReplyAuthoringSession.findMany({
      where: {
        state: PublisherAutoReplyAuthoringState.PROCESSING,
        expiresAt: { gt: now },
        OR: [{ lockedAt: null }, { lockedAt: { lte: staleBefore } }],
      },
      orderBy: [{ updatedAt: 'asc' }, { id: 'asc' }],
      take: RECOVERY_BATCH_SIZE,
      select: { id: true },
    });
    for (const row of processing) {
      await this.queue.enqueueProcessContent(row.id, now);
    }

    const saving = await this.prisma.publisherAutoReplyAuthoringSession.findMany({
      where: { state: PublisherAutoReplyAuthoringState.SAVING, expiresAt: { gt: now } },
      orderBy: [{ updatedAt: 'asc' }, { id: 'asc' }],
      take: RECOVERY_BATCH_SIZE,
      select: { id: true, callbackId: true },
    });
    for (const row of saving) {
      await this.queue.enqueueActivation({
        sessionId: row.id,
        callbackId: row.callbackId,
        requestedAt: now,
      });
    }
  }

  private async recoverNotifications(now: Date): Promise<void> {
    const rows = await this.prisma.publisherAutoReplyAuthoringSession.findMany({
      where: {
        notificationPending: true,
        notificationKind: { not: null },
        notificationDispatchStartedAt: null,
        privateChatId: { not: null },
        expiresAt: { gt: now },
        OR: [
          { notificationLockedAt: null },
          { notificationLockedAt: { lte: new Date(now.getTime() - RECOVERY_INTERVAL_MS) } },
        ],
      },
      orderBy: [{ updatedAt: 'asc' }, { id: 'asc' }],
      take: RECOVERY_BATCH_SIZE,
      select: { id: true, notificationKind: true, callbackId: true },
    });
    for (const row of rows) {
      const notification = this.toNotification(row.notificationKind);
      if (!notification) continue;
      await this.queue.enqueueNotification({
        sessionId: row.id,
        notification,
        callbackId: row.callbackId,
        dedupeKey: `recovery-${notification}-${Math.floor(now.getTime() / RECOVERY_INTERVAL_MS)}`,
        requestedAt: now,
      });
    }
  }

  private async reconcileAmbiguousNotifications(now: Date): Promise<void> {
    const rows = await this.prisma.publisherAutoReplyAuthoringSession.findMany({
      where: {
        notificationDispatchStartedAt: {
          lte: new Date(now.getTime() - AMBIGUOUS_NOTIFICATION_STALE_MS),
        },
        notificationClaimRevision: { not: null },
      },
      orderBy: [{ notificationDispatchStartedAt: 'asc' }, { id: 'asc' }],
      take: RECOVERY_BATCH_SIZE,
      select: {
        id: true,
        notificationRevision: true,
        notificationClaimRevision: true,
        notificationLockToken: true,
      },
    });
    for (const row of rows) {
      const claimRevision = row.notificationClaimRevision;
      if (claimRevision === null) continue;
      const current = claimRevision === row.notificationRevision;
      await this.prisma.publisherAutoReplyAuthoringSession.updateMany({
        where: {
          id: row.id,
          // FLAG: Authoring can advance after this read without replacing the old claim.
          // Settle only the observed revision; a fresh pass preserves its successor.
          notificationRevision: row.notificationRevision,
          notificationClaimRevision: claimRevision,
          notificationLockToken: row.notificationLockToken,
          notificationDispatchStartedAt: { not: null },
        },
        data: {
          ...(current ? { notificationPending: false, notificationKind: null } : {}),
          notificationLockedAt: null,
          notificationLockToken: null,
          notificationClaimRevision: null,
          notificationDispatchStartedAt: null,
          notificationLastAmbiguousRevision: claimRevision,
        },
      });
    }
  }

  private async deleteExpiredResults(now: Date): Promise<void> {
    const rows = await this.prisma.publisherAutoReplyAuthoringSession.findMany({
      where: { state: { in: [...TERMINAL_STATES] }, expiresAt: { lte: now } },
      orderBy: [{ expiresAt: 'asc' }, { id: 'asc' }],
      take: RECOVERY_BATCH_SIZE,
      select: { id: true },
    });
    if (rows.length === 0) return;
    const sessionIds = rows.map((row) => row.id);
    const drafts = await this.prisma.publisherAutoReplyRule.findMany({
      where: {
        authoringSessionId: { in: sessionIds },
        archivedAt: { not: null },
        enabled: false,
      },
      select: {
        id: true,
        contentRevisions: {
          select: { assets: { select: { assetId: true } } },
        },
      },
    });
    const draftIds = drafts.map((draft) => draft.id);
    const assetIds = [
      ...new Set(
        drafts.flatMap((draft) =>
          draft.contentRevisions.flatMap((revision) =>
            revision.assets.map((asset) => asset.assetId),
          ),
        ),
      ),
    ];
    await this.prisma.$transaction(async (tx) => {
      if (draftIds.length > 0) {
        await tx.publisherAutoReplyRule.deleteMany({
          where: {
            id: { in: draftIds },
            authoringSessionId: { in: sessionIds },
            archivedAt: { not: null },
            enabled: false,
          },
        });
      }
      if (assetIds.length > 0) {
        await tx.publisherAutoReplyAsset.deleteMany({
          where: { id: { in: assetIds }, contentLinks: { none: {} } },
        });
      }
      await tx.publisherAutoReplyAuthoringSession.deleteMany({
        where: { id: { in: sessionIds }, state: { in: [...TERMINAL_STATES] } },
      });
    });
  }

  private releaseLease(row: {
    id: string;
    publisherBotId: string;
    actorUserId: string;
  }): Promise<boolean> {
    return this.privateFlows.release({
      publisherBotId: row.publisherBotId,
      actorUserId: row.actorUserId,
      flowType: PublisherPrivateFlowType.AUTO_REPLY_AUTHORING,
      flowId: row.id,
      leaseToken: row.id,
    });
  }

  private toNotification(value: string | null): PublisherAutoReplyAuthoringNotification | null {
    switch (value) {
      case 'prompt_phrase':
      case 'prompt_content':
      case 'processing':
      case 'ready':
      case 'conflict':
      case 'activated':
      case 'failed':
      case 'canceled':
        return value;
      default:
        return null;
    }
  }

  private trigger(): void {
    if (this.inFlight) return;
    const run = this.recoverOnce();
    this.inFlight = run;
    void run
      .catch((error: unknown) => {
        this.logger.warn(
          { err: error instanceof Error ? error.message : String(error) },
          'Publisher auto-reply authoring recovery failed',
        );
      })
      .finally(() => {
        if (this.inFlight === run) this.inFlight = null;
      });
  }
}
