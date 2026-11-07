import { ServiceUnavailableException, type Logger } from '@nestjs/common';
import {
  ChatEntityType,
  ManagedEntityAccessRole,
  ManagedEntityAccessState,
  ManagedBroadcastStatus,
  ManagedBroadcastDeliveryStatus,
  PublicationDispatchProfile,
  Prisma,
  type ManagedBroadcastDelivery,
} from '../prisma/prisma-client';
import {
  classifyPublisherFailure,
  type PublisherFailureClassification,
} from '../publisher/publisher-dispatch-health.service';
import type { AdminManagedBroadcastRuntimeContext } from './admin-managed-broadcast-runtime-context';
import {
  PUBLISHER_ACTOR_ACCESS_BLOCKER_CODE,
  PUBLISHER_MISSED_WINDOW_BLOCKER_CODE,
  PUBLISHER_EXPLICIT_RETRY_CODE,
  PUBLISHER_PUBLICATION_BLOCKED_RETRY_MS as PUBLISHER_BLOCKED_RETRY_MS,
} from './publication-dispatch-issue';
import { publisherConnectedBindingWhere } from '../publisher/publisher-entity-connection.util';
import { isTransientPublicationPrismaError } from './publication-prisma-retry';
import {
  recordPublicationDispatchOutcome,
  measurePublicationStage,
} from './publication-delivery-timing';
import {
  buildClearResolvedPublisherRecipientBlockerQuery,
  publisherPublicationRecipientRetryAt,
} from './publisher-publication-recipient-admission';
import { PUBLICATION_DELIVERY_ROUTE_QUARANTINED_ERROR_CODE } from './publication-delivery-verification-state';

import { preparePendingPublicationContext } from './publication-target-preparation';
import {
  PUBLISHER_TARGET_CANCELED,
  untouchedPublicationTargetDeliveryWhere,
} from './publication-target-cancellation';
import {
  resolvePublicationExecutionIntent,
  type PublisherDeliveryAuthority,
} from './publication-execution-authority';

const PUBLISHER_RUNTIME_BLOCKER = 'PUBLISHER_RUNTIME_UNAVAILABLE';

type PublisherBroadcastRow = {
  id: string;
  publicationOccurrenceId: string | null;
  requiredBotId: string | null;
};

type PublisherDeliveryRow = {
  id: string;
  targetChatId: string;
  contentRevisionId: string | null;
  dialogBotId: string | null;
  publisherDialogContext?: Prisma.JsonValue;
};

type PublisherBroadcastLease = {
  lockedAt: Date;
  lockToken: string;
};

export type PublisherGuardResult =
  | { ready: true }
  | { ready: false; retryAt: Date }
  | { ready: false; leaseLost: true; retryAt: null };

export class PublisherDeliveryDeferredError extends Error {
  constructor(readonly blockerCode: string) {
    super(`Publik delivery is blocked: ${blockerCode}`);
    this.name = 'PublisherDeliveryDeferredError';
  }
}

export class PublisherManagedBroadcastDispatch {
  constructor(
    private readonly context: AdminManagedBroadcastRuntimeContext,
    private readonly logger: Logger,
  ) {}

  async ensureRuntimeBoundary(
    row: PublisherBroadcastRow,
    occurrenceIndex: number,
    lease: PublisherBroadcastLease,
  ): Promise<PublisherGuardResult> {
    try {
      if (!this.context.publisherRuntimeBoundaryService) {
        throw new Error('Publisher runtime boundary is unavailable');
      }
      this.context.publisherRuntimeBoundaryService.assertDispatchEnabled();
    } catch (error: unknown) {
      return this.deferRuntime(row, occurrenceIndex, lease, error);
    }

    const cleared = await this.clearExactBlocker(
      row,
      occurrenceIndex,
      lease,
      PUBLISHER_RUNTIME_BLOCKER,
    );
    if (!cleared) {
      return { ready: false, leaseLost: true, retryAt: null };
    }
    return { ready: true };
  }

  async assertDeliveryReady(
    chatId: string,
    requiredBotId: string,
    authority: PublisherDeliveryAuthority,
  ): Promise<void> {
    return measurePublicationStage(this.logger, 'delivery_readiness', () =>
      this.assertDeliveryReadyInternal(chatId, requiredBotId, authority),
    );
  }

  private async assertDeliveryReadyInternal(
    chatId: string,
    requiredBotId: string,
    authority: PublisherDeliveryAuthority,
  ): Promise<void> {
    try {
      const boundary = this.context.publisherRuntimeBoundaryService;
      const readiness = this.context.publisherReadinessService;
      const health = this.context.publisherDispatchHealthService;
      if (!boundary || !readiness || !health) {
        throw new Error('Publisher delivery guards are unavailable');
      }
      boundary.assertDispatchEnabled();
      await health.assertDispatchAllowed();
      const route = await readiness.assertEntityReady(chatId, 'publication');
      if (route.requiredBotId !== requiredBotId) {
        throw new PublisherDeliveryDeferredError('PUBLISHER_BOT_CHANGED');
      }
      if (route.entityType !== authority.entityType) {
        throw new PublisherDeliveryDeferredError('bot_not_connected');
      }
      if (await this.requiresLegacyActorAuthority(authority, requiredBotId, chatId)) {
        await this.assertActorAdminAccess({
          targetChatIds: [chatId],
          actorUserId: authority.actorUserId,
          entityType: route.entityType,
          requiredBotId,
        });
      }
    } catch (error: unknown) {
      if (error instanceof PublisherDeliveryDeferredError) {
        throw error;
      }
      if (isTransientPublicationPrismaError(error)) {
        throw error;
      }
      const blockerCode =
        typeof (error as { blockerCode?: unknown } | null)?.blockerCode === 'string'
          ? String((error as { blockerCode: string }).blockerCode)
          : (error as { code?: unknown } | null)?.code === 'PUBLISHER_DISPATCH_PAUSED'
            ? 'PUBLISHER_AUTH_PAUSED'
            : PUBLISHER_RUNTIME_BLOCKER;
      throw new PublisherDeliveryDeferredError(blockerCode.slice(0, 96));
    }
  }

  private async requiresLegacyActorAuthority(
    authority: PublisherDeliveryAuthority,
    requiredBotId: string,
    chatId: string,
  ): Promise<boolean> {
    if (authority.kind === 'legacy_actor') return true;
    if (!authority.occurrenceId || !authority.contentRevisionId)
      throw new PublisherDeliveryDeferredError(PUBLISHER_RUNTIME_BLOCKER);
    const occurrence = await this.context.prisma.publicationOccurrence.findUnique({
      where: { id: authority.occurrenceId },
      select: {
        contentRevisionId: true,
        dispatchProfile: true,
        requiredBotId: true,
        status: true,
        scheduleRevision: true,
        deliveryDeadlineAt: true,
        retryAuthorizedAt: true,
        retryExpiresAt: true,
        dispatchBlockerCode: true,
        dispatchBlockedAt: true,
        publication: {
          select: {
            lifecycle: true,
            dispatchProfile: true,
            requiredBotId: true,
            targets: {
              where: {
                targetChatId: chatId,
                entityType: authority.entityType === 'channel' ? 'CHANNEL' : 'CHAT',
              },
              select: { canceledAt: true },
            },
          },
        },
        schedule: { select: { status: true, revision: true } },
      },
    });
    // FLAG: Accepted entity intent is exact to the content, schedule and Publisher route.
    // Losing this proof never falls back to an author grant or clears a recipient fence.
    if (
      !occurrence ||
      occurrence.contentRevisionId !== authority.contentRevisionId ||
      occurrence.dispatchProfile !== PublicationDispatchProfile.PUBLIK_V1 ||
      occurrence.requiredBotId !== requiredBotId ||
      !['SCHEDULED', 'IN_PROGRESS'].includes(occurrence.status) ||
      occurrence.publication.lifecycle !== 'ACTIVE' ||
      occurrence.publication.dispatchProfile !== PublicationDispatchProfile.PUBLIK_V1 ||
      occurrence.publication.requiredBotId !== requiredBotId ||
      occurrence.schedule.status !== 'ACTIVE' ||
      occurrence.schedule.revision !== occurrence.scheduleRevision
    )
      throw new PublisherDeliveryDeferredError(PUBLISHER_RUNTIME_BLOCKER);
    // FLAG: Legacy envelopes can predate saved targets. Only a durable cancellation
    // stops their accepted recipient; the intent and author fences below still apply.
    if (occurrence.publication.targets.some((target) => target.canceledAt)) {
      throw new PublisherDeliveryDeferredError(PUBLISHER_TARGET_CANCELED);
    }
    const intent = resolvePublicationExecutionIntent(occurrence);
    if (intent.kind === 'invalid')
      throw new PublisherDeliveryDeferredError(PUBLISHER_RUNTIME_BLOCKER);
    if (intent.kind === 'legacy_actor') return true;
    if (intent.deadlineAt.getTime() < Date.now())
      throw new PublisherDeliveryDeferredError(PUBLISHER_MISSED_WINDOW_BLOCKER_CODE);
    return false;
  }

  async assertActorAdminAccess(params: {
    targetChatIds: readonly string[];
    actorUserId: string;
    entityType: 'chat' | 'channel';
    requiredBotId: string;
  }): Promise<void> {
    return measurePublicationStage(this.logger, 'actor_authority', () =>
      this.assertActorAdminAccessInternal(params),
    );
  }

  private async assertActorAdminAccessInternal(params: {
    targetChatIds: readonly string[];
    actorUserId: string;
    entityType: 'chat' | 'channel';
    requiredBotId: string;
  }): Promise<void> {
    const targetChatIds = [...new Set(params.targetChatIds.map((chatId) => chatId.trim()))].filter(
      Boolean,
    );
    const actorUserId = params.actorUserId.trim();
    const requiredBotId = params.requiredBotId.trim();
    if (targetChatIds.length === 0 || !actorUserId || !requiredBotId) {
      throw new PublisherDeliveryDeferredError(PUBLISHER_ACTOR_ACCESS_BLOCKER_CODE);
    }

    const entityType =
      params.entityType === 'channel' ? ChatEntityType.CHANNEL : ChatEntityType.CHAT;
    const edges = await this.context.prisma.managedEntityAccessEdge.findMany({
      where: {
        chatId: { in: targetChatIds },
        userId: actorUserId,
        botId: requiredBotId,
        entityType,
        state: ManagedEntityAccessState.GRANTED,
        userRole: { in: [ManagedEntityAccessRole.OWNER, ManagedEntityAccessRole.ADMIN] },
        // FLAG: Exact Publisher grants persist until explicit revocation; TTL is not denial.
        chat: {
          entityType,
          OR: [
            { publicationPolicy: { is: null } },
            { publicationPolicy: { is: { publikEnabled: true } } },
          ],
          publisherBinding: { is: publisherConnectedBindingWhere(requiredBotId) },
        },
      },
      select: { chatId: true },
    });
    const authorizedChatIds = new Set(edges.map((edge) => edge.chatId));
    const missingChatIds = targetChatIds.filter((chatId) => !authorizedChatIds.has(chatId));
    if (missingChatIds.length > 0) {
      await this.context.publisherReadinessService?.requestActorAccessRefresh(
        missingChatIds.map((chatId) => ({ chatId, entityType: params.entityType })),
        actorUserId,
        requiredBotId,
      );
      throw new PublisherDeliveryDeferredError(PUBLISHER_ACTOR_ACCESS_BLOCKER_CODE);
    }
  }

  async ensureActorAdminAccess(params: {
    row: PublisherBroadcastRow;
    occurrenceIndex: number;
    lease: PublisherBroadcastLease;
    targetChatIds: readonly string[];
    actorUserId: string;
    entityType: 'chat' | 'channel';
    requiredBotId: string;
  }): Promise<PublisherGuardResult> {
    try {
      await this.assertActorAdminAccess(params);
      const cleared = await this.clearExactBlocker(
        params.row,
        params.occurrenceIndex,
        params.lease,
        PUBLISHER_ACTOR_ACCESS_BLOCKER_CODE,
      );
      if (!cleared) {
        return { ready: false, leaseLost: true, retryAt: null };
      }
      return { ready: true };
    } catch (error: unknown) {
      if (!(error instanceof PublisherDeliveryDeferredError)) {
        throw error;
      }
      return this.deferBlocked(
        params.row,
        params.occurrenceIndex,
        params.lease,
        error.blockerCode,
        error,
      );
    }
  }

  async deferUnreadyBeforeClaim(
    row: PublisherBroadcastRow,
    delivery: PublisherDeliveryRow,
    requiredBotId: string,
    authority: PublisherDeliveryAuthority,
  ): Promise<Date | null> {
    try {
      await this.assertDeliveryReady(delivery.targetChatId, requiredBotId, authority);
      await preparePendingPublicationContext(this.context, delivery, requiredBotId);
      await this.context.prisma.managedBroadcastDelivery.updateMany({
        where: {
          id: delivery.id,
          status: ManagedBroadcastDeliveryStatus.PENDING,
          dispatchProfile: PublicationDispatchProfile.PUBLIK_V1,
          requiredBotId,
        },
        data: { dispatchBlockerCode: null, dispatchBlockedAt: null },
      });
      return null;
    } catch (error: unknown) {
      if (isTransientPublicationPrismaError(error)) {
        throw error;
      }
      const blockerCode =
        error instanceof PublisherDeliveryDeferredError
          ? error.blockerCode
          : PUBLISHER_RUNTIME_BLOCKER;
      const blockedAt = new Date();
      const retryAt = new Date(blockedAt.getTime() + PUBLISHER_BLOCKED_RETRY_MS);
      if (blockerCode === PUBLISHER_TARGET_CANCELED) {
        // FLAG: A materializer may have loaded its audience before cancellation.
        // Retire only that late untouched recipient; attempted effects keep their fences.
        const canceled = await this.context.prisma.managedBroadcastDelivery.updateMany({
          where: { id: delivery.id, ...untouchedPublicationTargetDeliveryWhere() },
          data: { status: ManagedBroadcastDeliveryStatus.CANCELED },
        });
        if (canceled.count === 1) {
          await this.context.prisma.managedBroadcastCalendarReservation.deleteMany({
            where: { broadcastId: row.id, occurrenceIndex: 1, targetChatId: delivery.targetChatId },
          });
        }
        return retryAt;
      }
      await this.context.prisma.managedBroadcastDelivery.updateMany({
        where: {
          id: delivery.id,
          status: ManagedBroadcastDeliveryStatus.PENDING,
          dispatchProfile: PublicationDispatchProfile.PUBLIK_V1,
          requiredBotId,
        },
        data: { dispatchBlockerCode: blockerCode, dispatchBlockedAt: blockedAt },
      });
      if (row.publicationOccurrenceId) {
        await this.updateOccurrenceBlocker(
          this.context.prisma,
          row.publicationOccurrenceId,
          blockerCode,
          blockedAt,
        );
      }
      return retryAt;
    }
  }

  async deferClaimed(params: {
    row: PublisherBroadcastRow;
    delivery: PublisherDeliveryRow;
    deliveryLockToken: string;
    blockerCode: string;
    sendAttemptStarted?: boolean;
  }): Promise<Date> {
    const blockedAt = new Date();
    const retryAt = new Date(blockedAt.getTime() + PUBLISHER_BLOCKED_RETRY_MS);
    await this.context.prisma.managedBroadcastDelivery.updateMany({
      where: {
        id: params.delivery.id,
        status: ManagedBroadcastDeliveryStatus.SENDING,
        lockToken: params.deliveryLockToken,
        ...(params.sendAttemptStarted === false ? { attemptCount: { gt: 0 } } : {}),
        dispatchProfile: PublicationDispatchProfile.PUBLIK_V1,
        requiredBotId: params.row.requiredBotId,
      },
      data: {
        status: ManagedBroadcastDeliveryStatus.PENDING,
        // FLAG: Only proven pre-dispatch deferral undoes the claim's increment. Keep real
        // HTTP rejections and all prior attempts attributable to the original execution.
        ...(params.sendAttemptStarted === false ? { attemptCount: { decrement: 1 } } : {}),
        lockedAt: null,
        lockToken: null,
        lastErrorCode: null,
        dispatchBlockerCode: params.blockerCode.slice(0, 96),
        dispatchBlockedAt: blockedAt,
      },
    });
    if (params.row.publicationOccurrenceId) {
      await this.updateOccurrenceBlocker(
        this.context.prisma,
        params.row.publicationOccurrenceId,
        params.blockerCode.slice(0, 96),
        blockedAt,
      );
    }
    return retryAt;
  }

  async resolveDialogBotId(
    delivery: PublisherDeliveryRow,
    deliveryLockToken: string,
    requiredBotId: string,
  ): Promise<string> {
    const persisted = delivery.dialogBotId?.trim();
    if (persisted) {
      return persisted;
    }
    const dialogBotId = requiredBotId.trim();
    if (!dialogBotId) {
      throw new ServiceUnavailableException({
        code: 'PUBLISHER_SETUP_REQUIRED',
        message: 'Для публикации не найден бот Публик.',
        chatId: delivery.targetChatId,
      });
    }
    const updated = await this.context.prisma.managedBroadcastDelivery.updateMany({
      where: {
        id: delivery.id,
        status: ManagedBroadcastDeliveryStatus.SENDING,
        lockToken: deliveryLockToken,
        dialogBotId: null,
      },
      data: { dialogBotId },
    });
    if (updated.count !== 1) {
      throw new ServiceUnavailableException(
        'Publisher delivery lock was lost while repairing dialog attribution',
      );
    }
    return dialogBotId;
  }

  async clearResolvedRecipientBlocker(
    row: PublisherBroadcastRow,
    lease: PublisherBroadcastLease,
  ): Promise<boolean> {
    if (!row.publicationOccurrenceId) return true;
    return this.context.prisma.$transaction(async (tx) => {
      if (!(await this.lockOwnedBroadcastLease(tx, row.id, lease))) return false;
      await tx.$executeRaw(
        buildClearResolvedPublisherRecipientBlockerQuery(row.publicationOccurrenceId!, new Date()),
      );
      return true;
    });
  }

  async prepareRecipientFinalization(
    row: PublisherBroadcastRow & { dispatchProfile?: PublicationDispatchProfile },
    lease: PublisherBroadcastLease | undefined,
    pending: readonly Pick<
      ManagedBroadcastDelivery,
      'lastErrorCode' | 'dispatchBlockerCode' | 'dispatchBlockedAt' | 'nextAttemptAt'
    >[],
  ): Promise<{ leaseOwned: boolean; hasImmediatelyReadyPendingDelivery: boolean }> {
    const isPublisher = row.dispatchProfile === PublicationDispatchProfile.PUBLIK_V1;
    const leaseOwned =
      !isPublisher || !lease || (await this.clearResolvedRecipientBlocker(row, lease));
    const now = new Date();
    return {
      leaseOwned,
      hasImmediatelyReadyPendingDelivery: pending.some(
        (delivery) =>
          delivery.lastErrorCode !== PUBLICATION_DELIVERY_ROUTE_QUARANTINED_ERROR_CODE &&
          (isPublisher
            ? !publisherPublicationRecipientRetryAt(delivery, now)
            : !delivery.dispatchBlockerCode),
      ),
    };
  }

  async recordFailure(
    chatId: string,
    error: unknown,
    observedAt: Date,
  ): Promise<PublisherFailureClassification> {
    const classification = classifyPublisherFailure(error);
    try {
      await this.context.publisherDispatchHealthService?.recordSendFailure(
        chatId,
        error,
        observedAt,
      );
    } catch (healthError: unknown) {
      this.logger.warn(
        {
          chatId,
          classification,
          err: healthError instanceof Error ? healthError.message : String(healthError),
        },
        'Failed to persist Publik delivery health failure',
      );
    }
    return classification;
  }

  async recordSuccess(chatId: string, attemptedAt: Date): Promise<void> {
    try {
      await this.context.publisherDispatchHealthService?.recordSendSuccess(chatId, attemptedAt);
    } catch (error: unknown) {
      this.logger.warn(
        { chatId, err: error instanceof Error ? error.message : String(error) },
        'Publik send succeeded but health persistence failed',
      );
    }
  }

  private async deferRuntime(
    row: PublisherBroadcastRow,
    occurrenceIndex: number,
    lease: PublisherBroadcastLease,
    error: unknown,
  ): Promise<PublisherGuardResult> {
    return this.deferBlocked(row, occurrenceIndex, lease, PUBLISHER_RUNTIME_BLOCKER, error);
  }

  private async clearExactBlocker(
    row: PublisherBroadcastRow,
    occurrenceIndex: number,
    lease: PublisherBroadcastLease,
    blockerCode: string,
  ): Promise<boolean> {
    return this.context.prisma.$transaction(async (tx) => {
      if (!(await this.lockOwnedBroadcastLease(tx, row.id, lease))) return false;
      if (row.publicationOccurrenceId) {
        await this.updateOccurrenceBlocker(
          tx,
          row.publicationOccurrenceId,
          null,
          null,
          blockerCode,
        );
      }
      await tx.managedBroadcastDelivery.updateMany({
        where: {
          broadcastId: row.id,
          occurrenceIndex,
          dispatchProfile: PublicationDispatchProfile.PUBLIK_V1,
          status: ManagedBroadcastDeliveryStatus.PENDING,
          dispatchBlockerCode: blockerCode,
        },
        data: { dispatchBlockerCode: null, dispatchBlockedAt: null },
      });
      return true;
    });
  }

  private async lockOwnedBroadcastLease(
    tx: Pick<Prisma.TransactionClient, '$queryRaw'>,
    broadcastId: string,
    lease: PublisherBroadcastLease,
  ): Promise<boolean> {
    // FLAG: Hold the exact envelope lease before occurrence/delivery writes. The no-key
    // row lock matches the former non-key UPDATE without rewriting the heap or updatedAt.
    // The transaction must retain this lock until all dependent cleanup writes finish.
    const rows = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      /* storage:publisher_envelope_lease_check */
      SELECT "id"
      FROM "managed_broadcasts"
      WHERE "id" = ${broadcastId}
        AND "dispatch_profile" = 'PUBLIK_V1'::"PublicationDispatchProfile"
        AND "status" IN (
          'ACTIVE'::"ManagedBroadcastStatus",
          'PARTIAL'::"ManagedBroadcastStatus",
          'FAILED'::"ManagedBroadcastStatus"
        )
        AND "locked_at" = ${lease.lockedAt}
        AND "lock_token" = ${lease.lockToken}
      FOR NO KEY UPDATE
    `);
    return rows.length === 1;
  }

  private async deferBlocked(
    row: PublisherBroadcastRow,
    occurrenceIndex: number,
    lease: PublisherBroadcastLease,
    blockerCode: string,
    error: unknown,
  ): Promise<PublisherGuardResult> {
    const blockedAt = new Date();
    const retryAt = new Date(blockedAt.getTime() + PUBLISHER_BLOCKED_RETRY_MS);
    const deferred = await this.context.prisma.$transaction(async (tx) => {
      const leaseClaim = await tx.managedBroadcast.updateMany({
        where: {
          id: row.id,
          dispatchProfile: PublicationDispatchProfile.PUBLIK_V1,
          status: {
            in: [
              ManagedBroadcastStatus.ACTIVE,
              ManagedBroadcastStatus.PARTIAL,
              ManagedBroadcastStatus.FAILED,
            ],
          },
          lockedAt: lease.lockedAt,
          lockToken: lease.lockToken,
        },
        data: { nextSendAt: retryAt, lockedAt: null, lockToken: null },
      });
      if (leaseClaim.count !== 1) {
        return false;
      }
      if (row.publicationOccurrenceId) {
        await this.updateOccurrenceBlocker(tx, row.publicationOccurrenceId, blockerCode, blockedAt);
      }
      await tx.managedBroadcastDelivery.updateMany({
        where: {
          broadcastId: row.id,
          occurrenceIndex,
          dispatchProfile: PublicationDispatchProfile.PUBLIK_V1,
          status: ManagedBroadcastDeliveryStatus.PENDING,
        },
        data: {
          dispatchBlockerCode: blockerCode,
          dispatchBlockedAt: blockedAt,
        },
      });
      return true;
    });
    if (!deferred) {
      return { ready: false, leaseLost: true, retryAt: null };
    }
    recordPublicationDispatchOutcome(this.logger, {
      scope: 'deferral',
      outcome: 'blocked',
      reason: blockerCode,
    });
    this.logger.warn(
      {
        broadcastId: row.id,
        occurrenceIndex,
        err: error instanceof Error ? error.message : String(error),
      },
      'Deferred Publik publication because a Publisher-owned guard is unavailable',
    );
    return { ready: false, retryAt };
  }

  private updateOccurrenceBlocker(
    client: Pick<Prisma.TransactionClient, '$executeRaw'>,
    occurrenceId: string,
    blockerCode: string | null,
    blockedAt: Date | null,
    expectedBlockerCode?: string,
  ): Promise<number> {
    // FLAG: Promote the original legacy author proof atomically before overwriting its
    // shared marker. Deferrals must never reset or extend the five-minute authorization.
    return client.$executeRaw(Prisma.sql`
      UPDATE "publication_occurrences"
      SET "retry_authorized_at" = COALESCE("retry_authorized_at",
            CASE WHEN "dispatch_blocker_code" = ${PUBLISHER_EXPLICIT_RETRY_CODE}
                 THEN "dispatch_blocked_at" ELSE NULL END),
          "dispatch_blocker_code" = ${blockerCode}, "dispatch_blocked_at" = ${blockedAt},
          "updated_at" = ${new Date()}
      WHERE "id" = ${occurrenceId} AND "dispatch_profile" = 'PUBLIK_V1'
        ${expectedBlockerCode === undefined ? Prisma.empty : Prisma.sql`AND "dispatch_blocker_code" = ${expectedBlockerCode}`}
    `);
  }
}
