import { Injectable, Logger, Optional } from '@nestjs/common';
import { buildPublicationRouteAdvisoryLockKey } from '../admin/publication-delivery-verification-state';
import { releasePublicationRouteQuarantineBacklog } from '../admin/publication-route-quarantine-backlog';
import { buildNightModeNoticeIdempotencyKey } from '../max/max-action-idempotency.util';
import { MAX_API_SOURCE_TAGS, MaxClientService } from '../max/max-client.service';
import { MaxActionLedgerService } from '../max/max-action-ledger.service';
import {
  MAX_SEND_ROUTE_DISAPPEARANCE_FAILURE_CODE,
  MAX_SEND_ROUTE_QUARANTINE_MS,
} from '../max/max-send-route-health';
import { ChatBotMembershipStatus, Prisma } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import { NightModeTransitionSchedulerService } from './night-mode-transition-scheduler.service';
import { NIGHT_MODE_CLOSE_NOTICE_CLEANUP_RULE_CODE } from './night-mode-close-notice-cleanup-binding';
import { resolveNightModeTransitionSessionOpenAt } from './night-mode-transition-time.util';
import type {
  NightModeRouteVerification,
  NightModeRouteVerificationProof,
} from './night-mode-transition.queue';

const STABILITY_WINDOW_MS = 5 * 60_000;
const VERIFICATION_TIMEOUT_MS = 5_000;
const MAX_RECORDED_VERIFICATION_ATTEMPTS = 6;
const REQUIRED_PRESENT_OBSERVATIONS = 2;
const REQUIRED_ABSENT_OBSERVATIONS = 3;
const RETRY_DELAYS_MS = [30_000, 2 * 60_000, 10 * 60_000, 30 * 60_000, 2 * 60 * 60_000] as const;

export type NightModeRouteVerificationResult =
  | { kind: 'complete'; routeHealthChanged: boolean }
  | { kind: 'retry'; retryAtMs: number; verification: NightModeRouteVerification }
  | { kind: 'terminal'; reason: 'absent' | 'invalid_proof' };

@Injectable()
export class NightModeRouteVerificationService {
  private readonly logger = new Logger(NightModeRouteVerificationService.name);

  constructor(
    private readonly maxClient: MaxClientService,
    private readonly prisma: PrismaService,
    private readonly maxActionLedgerService: MaxActionLedgerService,
    @Optional() private readonly scheduler?: NightModeTransitionSchedulerService,
  ) {}

  isSchedulingAvailable(): boolean {
    return this.scheduler?.isRouteVerificationSchedulingAvailable() === true;
  }

  async schedule(proof: NightModeRouteVerificationProof): Promise<void> {
    if (!this.scheduler) {
      throw new Error('Night mode route verification queue is unavailable');
    }
    await this.scheduler.scheduleRouteVerification(proof);
  }

  async process(
    chatId: string,
    verification: NightModeRouteVerification,
    now = new Date(),
  ): Promise<NightModeRouteVerificationResult> {
    const sentAt = new Date(verification.sentAt);
    const nextAttemptCount = verification.attemptCount + 1;
    const stableAtMs = sentAt.getTime() + STABILITY_WINDOW_MS;
    const ledgerProof =
      await this.maxActionLedgerService.getExactCompletedNightModeCloseNoticeDispatch({
        chatId,
        sessionKey: verification.sessionKey,
        messageId: verification.messageId,
        dispatchBotId: verification.botId,
      });
    if (
      !ledgerProof ||
      ledgerProof.jobId !==
        buildNightModeNoticeIdempotencyKey('close', chatId, verification.sessionKey) ||
      ledgerProof.remoteMessageId !== verification.messageId ||
      ledgerProof.dispatchBotId !== verification.botId ||
      !(ledgerProof.completedAt instanceof Date) ||
      !Number.isFinite(ledgerProof.completedAt.getTime()) ||
      ledgerProof.completedAt.getTime() !== sentAt.getTime() ||
      ledgerProof.routeHalfOpenProbe !== true
    ) {
      return { kind: 'terminal', reason: 'invalid_proof' };
    }
    const pendingClaim = await this.readPendingRouteClaim({
      chatId,
      botId: verification.botId,
      sentAt,
      allowStickyRoute: ledgerProof.stickyRouteHalfOpenProbe,
    });
    if (!pendingClaim) {
      return { kind: 'complete', routeHealthChanged: false };
    }
    let presence: 'present' | 'absent';
    try {
      presence = await this.maxClient.getExactMessagePresence(chatId, verification.messageId, {
        botId: verification.botId,
        bypassCache: true,
        trafficClass: 'background',
        actionHealthLane: 'background',
        sourceTag: MAX_API_SOURCE_TAGS.NIGHT_MODE_TRANSITION,
        timeoutMs: VERIFICATION_TIMEOUT_MS,
        ignoreFailureMetricStatuses: [404],
      });
    } catch (error: unknown) {
      if (nextAttemptCount === MAX_RECORDED_VERIFICATION_ATTEMPTS) {
        this.logger.warn(
          {
            chatId,
            botId: verification.botId,
            messageId: verification.messageId,
            attemptCount: nextAttemptCount,
            error: error instanceof Error ? error.message : String(error),
          },
          'Night mode close notice route verification remained inconclusive',
        );
      }
      return this.buildRetry(verification, nextAttemptCount, now);
    }

    if (presence === 'present') {
      const presentCount = Math.min(REQUIRED_PRESENT_OBSERVATIONS, verification.presentCount + 1);
      if (presentCount >= REQUIRED_PRESENT_OBSERVATIONS && now.getTime() >= stableAtMs) {
        const routeHealthChanged = await this.recordStableRouteAndWakeBacklog({
          chatId,
          botId: verification.botId,
          sentAt,
          observedAt: now,
          claimedUntil: pendingClaim.claimedUntil,
          allowStickyRoute: ledgerProof.stickyRouteHalfOpenProbe,
        });
        return { kind: 'complete', routeHealthChanged };
      }
      return this.buildRetry(
        { ...verification, presentCount, absentCount: 0 },
        nextAttemptCount,
        now,
        stableAtMs,
      );
    }

    const absentCount = Math.min(REQUIRED_ABSENT_OBSERVATIONS, verification.absentCount + 1);
    if (absentCount >= REQUIRED_ABSENT_OBSERVATIONS && now.getTime() >= stableAtMs) {
      const route = await this.recordDisappearedRoute({
        chatId,
        botId: verification.botId,
        messageId: verification.messageId,
        sessionKey: verification.sessionKey,
        sentAt,
        observedAt: now,
        claimedUntil: pendingClaim.claimedUntil,
        allowStickyRoute: ledgerProof.stickyRouteHalfOpenProbe,
      });
      if (!route) return { kind: 'complete', routeHealthChanged: false };
      this.logger.warn(
        {
          chatId,
          botId: verification.botId,
          messageId: verification.messageId,
          attemptCount: nextAttemptCount,
        },
        'Night mode close notice disappeared after an accepted half-open send',
      );
      return { kind: 'terminal', reason: 'absent' };
    }
    return this.buildRetry(
      { ...verification, presentCount: 0, absentCount },
      nextAttemptCount,
      now,
      absentCount >= REQUIRED_ABSENT_OBSERVATIONS ? stableAtMs : undefined,
    );
  }

  private buildRetry(
    verification: NightModeRouteVerification,
    attemptCount: number,
    now: Date,
    minimumRetryAtMs = 0,
  ): NightModeRouteVerificationResult {
    const boundedAttemptCount = Math.min(attemptCount, MAX_RECORDED_VERIFICATION_ATTEMPTS);
    const delayIndex = Math.min(boundedAttemptCount - 1, RETRY_DELAYS_MS.length - 1);
    return {
      kind: 'retry',
      retryAtMs: Math.max(now.getTime() + RETRY_DELAYS_MS[delayIndex]!, minimumRetryAtMs),
      verification: { ...verification, attemptCount: boundedAttemptCount },
    };
  }

  private async recordStableRouteAndWakeBacklog(params: {
    chatId: string;
    botId: string;
    sentAt: Date;
    observedAt: Date;
    claimedUntil: Date;
    allowStickyRoute: boolean;
  }): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw(
        Prisma.sql`SELECT pg_advisory_xact_lock(hashtext(${buildPublicationRouteAdvisoryLockKey(params.chatId)}))`,
      );
      const updated = await tx.chatBotMembership.updateMany({
        where: {
          chatId: params.chatId,
          botId: params.botId,
          status: ChatBotMembershipStatus.ACTIVE,
          sendRouteFailureCount: params.allowStickyRoute ? { gte: 1 } : 1,
          sendRouteLastFailureCode: MAX_SEND_ROUTE_DISAPPEARANCE_FAILURE_CODE,
          sendRouteQuarantinedUntil: params.claimedUntil,
          sendRouteLastFailureAt: { lt: params.sentAt },
          OR: [{ sendRouteLastSuccessAt: null }, { sendRouteLastSuccessAt: { lt: params.sentAt } }],
        },
        data: {
          sendRouteFailureCount: 0,
          sendRouteQuarantinedUntil: null,
          sendRouteLastFailureCode: null,
          sendRouteLastSuccessAt: params.sentAt,
        },
      });
      const routeHealthChanged = updated.count > 0;
      if (routeHealthChanged) {
        await releasePublicationRouteQuarantineBacklog(tx, params.chatId, params.observedAt);
      }
      return routeHealthChanged;
    });
  }

  private async recordDisappearedRoute(params: {
    chatId: string;
    botId: string;
    messageId: string;
    sessionKey: string;
    sentAt: Date;
    observedAt: Date;
    claimedUntil: Date;
    allowStickyRoute: boolean;
  }): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw(
        Prisma.sql`SELECT pg_advisory_xact_lock(hashtext(${buildPublicationRouteAdvisoryLockKey(params.chatId)}))`,
      );
      // FLAG: Deletion or a probe carried past normal opening makes absence inconclusive.
      // The time boundary also covers legacy/shadow cleanup without a durable DELETE receipt.
      const opensAt = resolveNightModeTransitionSessionOpenAt(params.sessionKey);
      if (opensAt && params.observedAt >= opensAt) return false;
      const cleanup = await tx.moderationDeleteIntent.findFirst({
        where: {
          chatId: params.chatId,
          messageId: params.messageId,
          originBotId: params.botId,
          reasons: {
            some: {
              ruleCode: NIGHT_MODE_CLOSE_NOTICE_CLEANUP_RULE_CODE,
              metadata: {
                path: ['nightModeCloseNoticeCleanup', 'sessionKey'],
                equals: params.sessionKey,
              },
            },
          },
          OR: [
            {
              deleteDispatchStartedBotId: params.botId,
              deleteDispatchStartedAt: { gte: params.sentAt },
            },
            {
              remoteDeleteSucceededBotId: params.botId,
              remoteDeleteSucceededAt: { gte: params.sentAt },
            },
            {
              succeededBotId: params.botId,
              status: 'SUCCEEDED',
              completedAt: { gte: params.sentAt },
            },
          ],
        },
        select: { id: true },
      });
      if (cleanup) return false;
      const updated = await tx.chatBotMembership.updateMany({
        where: {
          chatId: params.chatId,
          botId: params.botId,
          status: ChatBotMembershipStatus.ACTIVE,
          sendRouteFailureCount: params.allowStickyRoute ? { gte: 1 } : 1,
          sendRouteLastFailureCode: MAX_SEND_ROUTE_DISAPPEARANCE_FAILURE_CODE,
          sendRouteQuarantinedUntil: params.claimedUntil,
          sendRouteLastFailureAt: { lt: params.sentAt },
          OR: [{ sendRouteLastSuccessAt: null }, { sendRouteLastSuccessAt: { lt: params.sentAt } }],
        },
        data: {
          sendRouteFailureCount: { increment: 1 },
          sendRouteQuarantinedUntil: new Date(
            params.observedAt.getTime() + MAX_SEND_ROUTE_QUARANTINE_MS,
          ),
          sendRouteLastFailureAt: params.sentAt,
          sendRouteLastFailureCode: MAX_SEND_ROUTE_DISAPPEARANCE_FAILURE_CODE,
        },
      });
      return updated.count > 0;
    });
  }

  private async readPendingRouteClaim(params: {
    chatId: string;
    botId: string;
    sentAt: Date;
    allowStickyRoute: boolean;
  }): Promise<{ claimedUntil: Date } | null> {
    const membership = await this.prisma.chatBotMembership.findFirst({
      where: {
        chatId: params.chatId,
        botId: params.botId,
        status: ChatBotMembershipStatus.ACTIVE,
        sendRouteFailureCount: params.allowStickyRoute ? { gte: 1 } : 1,
        sendRouteLastFailureCode: MAX_SEND_ROUTE_DISAPPEARANCE_FAILURE_CODE,
        sendRouteLastFailureAt: { lt: params.sentAt },
        sendRouteQuarantinedUntil: {
          gte: params.sentAt,
          lte: new Date(params.sentAt.getTime() + MAX_SEND_ROUTE_QUARANTINE_MS),
        },
      },
      select: { sendRouteQuarantinedUntil: true },
    });
    return membership?.sendRouteQuarantinedUntil instanceof Date
      ? { claimedUntil: membership.sendRouteQuarantinedUntil }
      : null;
  }
}
