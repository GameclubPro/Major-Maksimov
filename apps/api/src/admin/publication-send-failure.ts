import { ManagedBroadcastDeliveryStatus } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import { resolveExplicitMembershipAccessDenial } from '../max/max-membership-access-error';
import { isAmbiguousManagedBroadcastSendError } from './admin-managed-broadcast-reconciliation';

export type PublicationSendFailure = 'ambiguous' | 'target_denied' | 'failed';

export function classifyPublicationSendFailure(error: unknown): PublicationSendFailure {
  // FLAG: Once SEND may have reached MAX, neither access-like text nor retry history
  // proves its absence. Classify the effect before applying any recipient policy.
  if (isAmbiguousManagedBroadcastSendError(error)) return 'ambiguous';
  if (resolveExplicitMembershipAccessDenial(error)) return 'target_denied';
  return 'failed';
}

export async function persistPublicationSendFailure(options: {
  prisma: Pick<PrismaService, 'managedBroadcastDelivery'>;
  deliveryId: string;
  lockToken: string;
  botId: string | null;
  failure: Exclude<PublicationSendFailure, 'target_denied'>;
  lastError: string;
  lastErrorCode?: string | null;
}): Promise<boolean> {
  const changed = await options.prisma.managedBroadcastDelivery.updateMany({
    where: {
      id: options.deliveryId,
      status: ManagedBroadcastDeliveryStatus.SENDING,
      lockToken: options.lockToken,
      remoteMessageId: null,
      sentAt: null,
      legacySentWithoutRemoteId: false,
    },
    data: {
      status:
        options.failure === 'ambiguous'
          ? ManagedBroadcastDeliveryStatus.AMBIGUOUS
          : ManagedBroadcastDeliveryStatus.FAILED,
      botId: options.botId,
      lockedAt: null,
      lockToken: null,
      lastErrorCode: options.lastErrorCode ?? null,
      lastError: options.lastError,
    },
  });
  return changed.count === 1;
}
