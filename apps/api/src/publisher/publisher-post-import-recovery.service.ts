import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { PublisherPostImportStatus } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import { PublisherBackgroundWorkCoordinatorService } from './publisher-background-work-coordinator.service';
import {
  type PublisherPostImportNotification,
  PublisherPostImportQueueService,
} from './publisher-post-import.queue';
import {
  PUBLISHER_POST_IMPORT_RESULT_TTL_MS,
  PUBLISHER_POST_IMPORT_SECOND_FORWARD_GUARD_MS,
} from './publisher-post-import.service';
import { PublisherRuntimeBoundaryService } from './publisher-runtime-boundary.service';

const RECOVERY_INTERVAL_MS = 30_000;
const RECOVERY_STARTUP_DELAY_MS = 10_000;
const RECOVERY_BATCH_SIZE = 25;
const PROCESSING_LEASE_MS = 2 * 60_000;

@Injectable()
export class PublisherPostImportRecoveryService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PublisherPostImportRecoveryService.name);
  private startupTimer: NodeJS.Timeout | null = null;
  private intervalTimer: NodeJS.Timeout | null = null;
  private inFlight: Promise<void> | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: PublisherPostImportQueueService,
    private readonly backgroundWork: PublisherBackgroundWorkCoordinatorService,
    private readonly runtimeBoundary: PublisherRuntimeBoundaryService,
  ) {}

  onModuleInit(): void {
    if (!this.runtimeBoundary.dispatchEnabled) {
      return;
    }
    this.startupTimer = setTimeout(() => this.trigger(), RECOVERY_STARTUP_DELAY_MS);
    this.startupTimer.unref();
    this.intervalTimer = setInterval(() => this.trigger(), RECOVERY_INTERVAL_MS);
    this.intervalTimer.unref();
  }

  onModuleDestroy(): void {
    if (this.startupTimer) {
      clearTimeout(this.startupTimer);
      this.startupTimer = null;
    }
    if (this.intervalTimer) {
      clearInterval(this.intervalTimer);
      this.intervalTimer = null;
    }
  }

  async recoverOnce(now = new Date()): Promise<void> {
    await this.backgroundWork.runExclusive('post_import_recovery', async () => {
      const expiredWaiting = await this.prisma.publisherPostImportSession.findMany({
        where: { status: PublisherPostImportStatus.WAITING, expiresAt: { lte: now } },
        orderBy: [{ expiresAt: 'asc' }, { id: 'asc' }],
        take: RECOVERY_BATCH_SIZE,
        select: { id: true },
      });
      if (expiredWaiting.length > 0) {
        await this.prisma.publisherPostImportSession.updateMany({
          where: {
            id: { in: expiredWaiting.map((row) => row.id) },
            status: PublisherPostImportStatus.WAITING,
            expiresAt: { lte: now },
          },
          data: {
            status: PublisherPostImportStatus.EXPIRED,
            notificationKind: null,
            notificationPending: false,
            notificationLockedAt: null,
            notificationLockToken: null,
            notificationDispatchStartedAt: null,
            expiresAt: new Date(now.getTime() + PUBLISHER_POST_IMPORT_RESULT_TTL_MS),
          },
        });
      }

      const retainedTerminal = await this.prisma.publisherPostImportSession.findMany({
        where: {
          status: {
            in: [
              PublisherPostImportStatus.READY,
              PublisherPostImportStatus.FAILED,
              PublisherPostImportStatus.CANCELED,
              PublisherPostImportStatus.EXPIRED,
            ],
          },
          expiresAt: { lte: now },
        },
        orderBy: [{ expiresAt: 'asc' }, { id: 'asc' }],
        take: RECOVERY_BATCH_SIZE,
        select: { id: true },
      });
      if (retainedTerminal.length > 0) {
        await this.prisma.publisherPostImportSession.deleteMany({
          where: {
            id: { in: retainedTerminal.map((row) => row.id) },
            status: {
              in: [
                PublisherPostImportStatus.READY,
                PublisherPostImportStatus.FAILED,
                PublisherPostImportStatus.CANCELED,
                PublisherPostImportStatus.EXPIRED,
              ],
            },
            expiresAt: { lte: now },
          },
        });
      }

      const timedOut = await this.prisma.publisherPostImportSession.findMany({
        where: { status: PublisherPostImportStatus.PROCESSING, expiresAt: { lte: now } },
        orderBy: [{ expiresAt: 'asc' }, { id: 'asc' }],
        take: RECOVERY_BATCH_SIZE,
        select: { id: true },
      });
      for (const row of timedOut) {
        const failed = await this.prisma.publisherPostImportSession.updateMany({
          where: {
            id: row.id,
            status: PublisherPostImportStatus.PROCESSING,
            expiresAt: { lte: now },
          },
          data: {
            status: PublisherPostImportStatus.FAILED,
            failureCode: 'processing_timeout',
            notificationKind: 'failed',
            notificationPending: true,
            notificationLockedAt: null,
            notificationLockToken: null,
            notificationDispatchStartedAt: null,
            captureGuardUntil: new Date(
              now.getTime() + PUBLISHER_POST_IMPORT_SECOND_FORWARD_GUARD_MS,
            ),
            lockedAt: null,
            lockToken: null,
            expiresAt: new Date(now.getTime() + PUBLISHER_POST_IMPORT_RESULT_TTL_MS),
          },
        });
        if (failed.count > 0) {
          await this.queue.enqueueNotification({
            sessionId: row.id,
            notification: 'failed',
            dedupeKey: 'processing-timeout',
          });
        }
      }

      const recoverable = await this.prisma.publisherPostImportSession.findMany({
        where: {
          status: PublisherPostImportStatus.PROCESSING,
          expiresAt: { gt: now },
          OR: [
            { lockedAt: null },
            { lockedAt: { lt: new Date(now.getTime() - PROCESSING_LEASE_MS) } },
          ],
        },
        orderBy: [{ updatedAt: 'asc' }, { id: 'asc' }],
        take: RECOVERY_BATCH_SIZE,
        select: { id: true },
      });
      for (const row of recoverable) {
        await this.queue.enqueueProcess(row.id, now);
      }

      const notificationCandidates = await this.prisma.publisherPostImportSession.findMany({
        where: {
          notificationPending: true,
          notificationKind: { not: null },
          notificationDispatchStartedAt: null,
          OR: [
            { notificationLockedAt: null },
            {
              notificationLockedAt: {
                lt: new Date(now.getTime() - RECOVERY_INTERVAL_MS),
              },
            },
          ],
          privateChatId: { not: null },
          expiresAt: { gt: now },
        },
        orderBy: [{ updatedAt: 'asc' }, { id: 'asc' }],
        take: RECOVERY_BATCH_SIZE,
        select: {
          id: true,
          status: true,
          privateChatId: true,
          callbackId: true,
          notificationKind: true,
        },
      });
      for (const row of notificationCandidates) {
        const notification = this.toNotification(row.notificationKind);
        if (!notification) {
          continue;
        }
        await this.queue.enqueueNotification({
          sessionId: row.id,
          notification,
          privateChatId: row.privateChatId,
          callbackId: row.callbackId,
          dedupeKey: `recovery-${notification}-${Math.floor(now.getTime() / RECOVERY_INTERVAL_MS)}`,
          requestedAt: now,
        });
      }
    });
  }

  private toNotification(value: string | null): PublisherPostImportNotification | null {
    switch (value) {
      case 'prompt':
      case 'need_forward':
      case 'collecting':
      case 'collected':
      case 'processing':
      case 'ready':
      case 'failed':
      case 'canceled':
        return value;
    }
    return null;
  }

  private trigger(): void {
    if (this.inFlight) {
      return;
    }
    const run = this.recoverOnce();
    this.inFlight = run;
    void run
      .catch((error: unknown) => {
        this.logger.warn(
          { err: error instanceof Error ? error.message : String(error) },
          'Publisher post import recovery failed',
        );
      })
      .finally(() => {
        if (this.inFlight === run) {
          this.inFlight = null;
        }
      });
  }
}
