import { BadRequestException } from '@nestjs/common';
import {
  ManagedBroadcastDeliveryStatus,
  ManagedBroadcastStatus,
  type ManagedBroadcast,
  type ManagedBroadcastDelivery,
} from '../prisma/prisma-client';
import type { AdminManagedBroadcastRuntimeContext } from './admin-managed-broadcast-runtime-context';
import type {
  AdminManagedBroadcastPublicationVerification,
  ManagedBroadcastPublicationVerificationBudget,
} from './admin-managed-broadcast-publication-verification';
import {
  buildManagedBroadcastTransientQuarantineMessage,
  isManagedBroadcastPermanentTargetDeliveryFailure,
  isManagedBroadcastTransientDeliveryFailureMessage,
  resolveManagedBroadcastFatalProcessingFailureMessage,
  shouldAutoRetryManagedBroadcastDeliveryFailure,
} from './admin-managed-broadcast-reconciliation';
import { cancelManagedBroadcastTargetDeliveries } from './admin-managed-broadcast-target-failure';
import { failManagedBroadcastAfterFatalProcessingError } from './admin-managed-broadcast-terminal-failure';
import {
  MANAGED_BROADCAST_TARGET_QUARANTINE_ATTEMPTS,
  MANAGED_BROADCAST_TARGET_QUARANTINE_FAILURE_OCCURRENCES,
  type BroadcastOccurrenceResult,
  type ManagedBroadcastMaxApiOptions,
} from './admin.service.support';
import { hasPublicationDeliveryAutomatedVerificationState } from './publication-delivery-verification-state';

type AutomaticExecutionReason = 'startup' | 'scheduled' | 'manual_retry' | 'immediate' | 'deadline';

type ManagedBroadcastLease = {
  lockedAt: Date;
  lockToken: string;
};

export type ManagedBroadcastAutomaticPreparation =
  | { continueExecution: true; deliveries: ManagedBroadcastDelivery[] }
  | { continueExecution: false; result: BroadcastOccurrenceResult };

export async function prepareManagedBroadcastAutomaticExecution(options: {
  context: Pick<AdminManagedBroadcastRuntimeContext, 'prisma' | 'logger'>;
  verification: AdminManagedBroadcastPublicationVerification;
  row: ManagedBroadcast;
  occurrenceIndex: number;
  reason: AutomaticExecutionReason;
  maxApiOptions: ManagedBroadcastMaxApiOptions;
  verificationBudget?: ManagedBroadcastPublicationVerificationBudget;
  lease: ManagedBroadcastLease;
  heartbeat(): Promise<void>;
  finalize(): Promise<BroadcastOccurrenceResult>;
  readResult(params: {
    sentChatIds: string[];
    failedChatIds: string[];
    pendingChatIds: string[];
    canRetryOverride: true;
  }): Promise<BroadcastOccurrenceResult>;
}): Promise<ManagedBroadcastAutomaticPreparation> {
  const readDeliveries = () =>
    options.context.prisma.managedBroadcastDelivery.findMany({
      where: {
        broadcastId: options.row.id,
        occurrenceIndex: options.occurrenceIndex,
      },
      orderBy: [{ targetChatId: 'asc' as const }],
    });
  let deliveries = await readDeliveries();
  const automaticVerificationOnly =
    Boolean(options.row.publicationOccurrenceId) &&
    options.row.status !== ManagedBroadcastStatus.ACTIVE &&
    options.reason !== 'manual_retry';
  if (!automaticVerificationOnly && ['startup', 'scheduled'].includes(options.reason)) {
    deliveries = await recoverManagedBroadcastDeliveriesForAutomaticRun({
      context: options.context,
      broadcastId: options.row.id,
      occurrenceIndex: options.occurrenceIndex,
      deliveries,
    });
  }

  const recoveredUnconfirmedChatIds = await options.verification.verifyAfterSend(
    options.row,
    options.occurrenceIndex,
    options.maxApiOptions,
    options.heartbeat,
    options.verificationBudget,
  );
  if (automaticVerificationOnly || recoveredUnconfirmedChatIds.size > 0) {
    deliveries = await readDeliveries();
  }

  const fatalRecoveredDelivery = deliveries.find(
    (delivery) =>
      delivery.status === ManagedBroadcastDeliveryStatus.FAILED &&
      resolveManagedBroadcastFatalProcessingFailureMessage(delivery.lastError) !== null,
  );
  if (fatalRecoveredDelivery) {
    const failureMessage =
      resolveManagedBroadcastFatalProcessingFailureMessage(fatalRecoveredDelivery.lastError) ??
      'Не удалось обработать автопостинг.';
    await failManagedBroadcastAfterFatalProcessingError({
      prisma: options.context.prisma,
      logger: options.context.logger,
      row: options.row,
      occurrenceIndex: options.occurrenceIndex,
      failureMessage,
      lease: options.lease,
    });
    return {
      continueExecution: false,
      result: {
        status: ManagedBroadcastStatus.FAILED,
        currentOccurrence: options.occurrenceIndex,
        sentChatIds: [],
        failedChatIds: [fatalRecoveredDelivery.targetChatId],
        pendingChatIds: [],
        canRetry: true,
        firstSendError: new BadRequestException(failureMessage),
        nextSendAt: null,
      },
    };
  }

  if (!automaticVerificationOnly) {
    return { continueExecution: true, deliveries };
  }

  const unfinishedDeliveries = deliveries.filter(
    (delivery) =>
      delivery.status === ManagedBroadcastDeliveryStatus.PENDING ||
      delivery.status === ManagedBroadcastDeliveryStatus.SENDING,
  );
  const armedDeliveries = deliveries.filter(
    (delivery) =>
      delivery.status === ManagedBroadcastDeliveryStatus.SENT &&
      delivery.remoteMessageId !== null &&
      delivery.remoteMessageVerifiedAt === null &&
      hasPublicationDeliveryAutomatedVerificationState(delivery),
  );
  if (deliveries.length > 0 && unfinishedDeliveries.length === 0 && armedDeliveries.length === 0) {
    return { continueExecution: false, result: await options.finalize() };
  }

  // FLAG: Automatic verification may inspect a stopped envelope, but only an explicit manual
  // retry may claim its remaining PENDING deliveries or make the envelope ACTIVE again.
  await options.context.prisma.managedBroadcast.updateMany({
    where: {
      id: options.row.id,
      lockedAt: options.lease.lockedAt,
      lockToken: options.lease.lockToken,
      status: {
        in: [
          ManagedBroadcastStatus.ACTIVE,
          ManagedBroadcastStatus.PARTIAL,
          ManagedBroadcastStatus.FAILED,
        ],
      },
    },
    data: { lockedAt: null, lockToken: null },
  });
  return {
    continueExecution: false,
    result: await options.readResult({
      sentChatIds: deliveries
        .filter((delivery) => delivery.status === ManagedBroadcastDeliveryStatus.SENT)
        .map((delivery) => delivery.targetChatId),
      failedChatIds: deliveries
        .filter(
          (delivery) =>
            delivery.status === ManagedBroadcastDeliveryStatus.FAILED ||
            delivery.status === ManagedBroadcastDeliveryStatus.AMBIGUOUS ||
            delivery.status === ManagedBroadcastDeliveryStatus.CANCELED,
        )
        .map((delivery) => delivery.targetChatId),
      pendingChatIds: unfinishedDeliveries.map((delivery) => delivery.targetChatId),
      canRetryOverride: true,
    }),
  };
}

export async function recoverManagedBroadcastDeliveriesForAutomaticRun(options: {
  context: Pick<AdminManagedBroadcastRuntimeContext, 'prisma' | 'logger'>;
  broadcastId: string;
  occurrenceIndex: number;
  deliveries: ManagedBroadcastDelivery[];
}): Promise<ManagedBroadcastDelivery[]> {
  let mutated = false;

  for (const delivery of options.deliveries) {
    // FLAG: Publication FAILED rows require explicit retry authority. Historical free
    // text cannot authorize cancellation, quarantine or replay of an accepted effect.
    if (delivery.publicationOccurrenceId) continue;
    if (delivery.status !== ManagedBroadcastDeliveryStatus.FAILED) {
      continue;
    }

    const failureMessage = delivery.lastError?.trim() ?? '';
    if (isManagedBroadcastPermanentTargetDeliveryFailure(null, failureMessage)) {
      await cancelManagedBroadcastTargetDeliveries(
        options.context.prisma,
        options.broadcastId,
        options.occurrenceIndex,
        {
          targetChatId: delivery.targetChatId,
          currentDeliveryId: delivery.id,
          lastError:
            failureMessage || 'Чат больше недоступен для бота, дальнейшие доставки пропущены.',
        },
      );
      mutated = true;
      continue;
    }
    const transientQuarantineMessage = await resolveManagedBroadcastTransientQuarantineMessage({
      prisma: options.context.prisma,
      broadcastId: options.broadcastId,
      occurrenceIndex: options.occurrenceIndex,
      targetChatId: delivery.targetChatId,
      currentAttemptCount: delivery.attemptCount,
      failureMessage,
    });
    if (transientQuarantineMessage) {
      await cancelManagedBroadcastTargetDeliveries(
        options.context.prisma,
        options.broadcastId,
        options.occurrenceIndex,
        {
          targetChatId: delivery.targetChatId,
          currentDeliveryId: delivery.id,
          lastError: transientQuarantineMessage,
        },
      );
      options.context.logger.warn(
        {
          broadcastId: options.broadcastId,
          targetChatId: delivery.targetChatId,
          occurrenceIndex: options.occurrenceIndex,
          attempts: delivery.attemptCount,
          err: failureMessage,
        },
        'Managed broadcast target was quarantined during automatic recovery after repeated transient failures',
      );
      mutated = true;
      continue;
    }

    if (!shouldAutoRetryManagedBroadcastDeliveryFailure(delivery)) {
      continue;
    }

    const resetResult = await options.context.prisma.managedBroadcastDelivery.updateMany({
      where: {
        id: delivery.id,
        status: ManagedBroadcastDeliveryStatus.FAILED,
      },
      data: {
        status: ManagedBroadcastDeliveryStatus.PENDING,
        lockedAt: null,
        lockToken: null,
        lastErrorCode: null,
        lastError: null,
      },
    });
    mutated ||= resetResult.count > 0;
  }

  if (!mutated) {
    return options.deliveries;
  }

  return options.context.prisma.managedBroadcastDelivery.findMany({
    where: {
      broadcastId: options.broadcastId,
      occurrenceIndex: options.occurrenceIndex,
    },
    orderBy: [{ targetChatId: 'asc' }],
  });
}

export async function resolveManagedBroadcastTransientQuarantineMessage(options: {
  prisma: AdminManagedBroadcastRuntimeContext['prisma'];
  broadcastId: string;
  occurrenceIndex: number;
  targetChatId: string;
  currentAttemptCount: number;
  failureMessage: string;
}): Promise<string | null> {
  if (!isManagedBroadcastTransientDeliveryFailureMessage(options.failureMessage)) {
    return null;
  }

  if (
    options.currentAttemptCount < MANAGED_BROADCAST_TARGET_QUARANTINE_ATTEMPTS &&
    options.occurrenceIndex < MANAGED_BROADCAST_TARGET_QUARANTINE_FAILURE_OCCURRENCES
  ) {
    return null;
  }

  const history = await options.prisma.managedBroadcastDelivery.findMany({
    where: {
      broadcastId: options.broadcastId,
      targetChatId: options.targetChatId,
      occurrenceIndex: { lte: options.occurrenceIndex },
    },
    orderBy: [{ occurrenceIndex: 'asc' }],
  });

  let transientFailureAttempts = 0;
  const transientFailureOccurrences = new Set<number>();
  for (const delivery of history) {
    const isCurrentOccurrence = delivery.occurrenceIndex === options.occurrenceIndex;
    const effectiveFailureMessage = isCurrentOccurrence
      ? options.failureMessage
      : (delivery.lastError ?? '').trim();
    if (!isManagedBroadcastTransientDeliveryFailureMessage(effectiveFailureMessage)) {
      continue;
    }

    transientFailureOccurrences.add(delivery.occurrenceIndex);
    transientFailureAttempts += isCurrentOccurrence
      ? Math.max(1, options.currentAttemptCount)
      : Math.max(1, delivery.attemptCount);
  }

  if (
    transientFailureAttempts < MANAGED_BROADCAST_TARGET_QUARANTINE_ATTEMPTS &&
    transientFailureOccurrences.size < MANAGED_BROADCAST_TARGET_QUARANTINE_FAILURE_OCCURRENCES
  ) {
    return null;
  }

  return buildManagedBroadcastTransientQuarantineMessage(
    transientFailureAttempts,
    transientFailureOccurrences.size,
    options.failureMessage,
  );
}
