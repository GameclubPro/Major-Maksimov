import { measurePublicationStage } from './publication-delivery-timing';
import { publicationButtonSchema, publicationEntityTypeSchema } from '@maxim/contracts/publication';
import type { BroadcastLinkButton, ManagedEntityType } from '@maxim/contracts';
import { ServiceUnavailableException } from '@nestjs/common';
import { Prisma } from '../prisma/prisma-client';
import type { AdminManagedBroadcastRuntimeContext } from './admin-managed-broadcast-runtime-context';
import { readPublisherPreparedDialogContext } from './publisher-dialog-context.service';

export const PUBLISHER_PUBLICATION_REPREPARATION_VERSION = 2;

export function createRepreparedPublicationContext(
  target: { chatId: string; entityType: ManagedEntityType },
  requiredBotId: string,
  customButtons: readonly BroadcastLinkButton[],
  contentRevisionId: string,
  retry?: { authorizedAt: Date; expiresAt: Date },
): Prisma.InputJsonObject {
  return {
    ...createPendingPublicationContext(target, requiredBotId, customButtons),
    customButtons: customButtons.map((button) => ({ ...button })),
    preparationRevision: PUBLISHER_PUBLICATION_REPREPARATION_VERSION,
    contentRevisionId,
    ...(retry
      ? {
          retryAuthorizedAtMs: retry.authorizedAt.getTime(),
          retryExpiresAtMs: retry.expiresAt.getTime(),
        }
      : {}),
  };
}

export function createPendingPublicationContext(
  target: { chatId: string; entityType: ManagedEntityType },
  requiredBotId: string,
  customButtons: readonly BroadcastLinkButton[],
): Prisma.InputJsonObject {
  return {
    version: 0,
    preparation: 'pending',
    chatId: target.chatId,
    entityType: target.entityType,
    dialogBotId: requiredBotId,
    customButtons: customButtons.map(({ text, url }) => ({ text, url })),
  };
}

export function preparePendingPublicationContext(
  context: Pick<AdminManagedBroadcastRuntimeContext, 'prisma' | 'publisherDialogContextService'> &
    Partial<Pick<AdminManagedBroadcastRuntimeContext, 'logger'>>,
  delivery: {
    id: string;
    targetChatId: string;
    contentRevisionId: string | null;
    publisherDialogContext?: Prisma.JsonValue;
  },
  requiredBotId: string,
): Promise<void> {
  return measurePublicationStage(context.logger, 'target_preparation', () =>
    preparePendingPublicationContextInternal(context, delivery, requiredBotId),
  );
}

async function preparePendingPublicationContextInternal(
  context: Pick<AdminManagedBroadcastRuntimeContext, 'prisma' | 'publisherDialogContextService'>,
  delivery: {
    id: string;
    targetChatId: string;
    contentRevisionId: string | null;
    publisherDialogContext?: Prisma.JsonValue;
  },
  requiredBotId: string,
): Promise<void> {
  const marker = delivery.publisherDialogContext;
  if (
    !marker ||
    typeof marker !== 'object' ||
    Array.isArray(marker) ||
    marker.version !== 0 ||
    marker.preparation !== 'pending'
  )
    return;
  const entityType = publicationEntityTypeSchema.safeParse(marker.entityType);
  const buttons = publicationButtonSchema.array().max(8).safeParse(marker.customButtons);
  if (
    marker.chatId !== delivery.targetChatId ||
    marker.dialogBotId !== requiredBotId ||
    !delivery.contentRevisionId ||
    !entityType.success ||
    !buttons.success ||
    !context.publisherDialogContextService
  )
    throw new ServiceUnavailableException('Publication target preparation unavailable');

  let fence: Prisma.ManagedBroadcastDeliveryWhereInput = {
    id: delivery.id,
    targetChatId: delivery.targetChatId,
    status: 'PENDING',
    attemptCount: 0,
    contentRevisionId: delivery.contentRevisionId,
    dispatchProfile: 'PUBLIK_V1',
    requiredBotId,
    dialogBotId: requiredBotId,
    publicationOccurrenceId: { not: null },
    publisherDialogContext: { equals: marker },
  };
  if (marker.preparationRevision !== undefined) {
    if (
      marker.preparationRevision !== PUBLISHER_PUBLICATION_REPREPARATION_VERSION ||
      typeof marker.contentRevisionId !== 'string' ||
      marker.contentRevisionId !== delivery.contentRevisionId
    )
      throw new ServiceUnavailableException('Publication preparation revision unavailable');
    const hasRetry =
      marker.retryAuthorizedAtMs !== undefined || marker.retryExpiresAtMs !== undefined;
    const authorizedAtMs = marker.retryAuthorizedAtMs;
    const expiresAtMs = marker.retryExpiresAtMs;
    if (
      hasRetry &&
      (typeof authorizedAtMs !== 'number' ||
        !Number.isSafeInteger(authorizedAtMs) ||
        typeof expiresAtMs !== 'number' ||
        !Number.isSafeInteger(expiresAtMs) ||
        authorizedAtMs <= 0 ||
        authorizedAtMs > Date.now() ||
        expiresAtMs <= Date.now() ||
        expiresAtMs <= authorizedAtMs)
    )
      throw new ServiceUnavailableException('Publication retry preparation expired');
    // FLAG: Repreparation never erases an attempt. Only the exact newly accepted content
    // and finite explicit retry may prepare an attempted recipient; receipts stay fenced.
    fence = {
      ...fence,
      attemptCount: hasRetry ? { gte: 0 } : 0,
      contentRevisionId: marker.contentRevisionId,
      lockedAt: null,
      lockToken: null,
      remoteMessageId: null,
      sentAt: null,
      legacySentWithoutRemoteId: false,
      remoteMessageVerifiedAt: null,
      remoteMessageVerificationAttemptedAt: null,
      remoteMessageVerificationAttemptCount: 0,
      remoteMessageVerificationAbsentCount: 0,
      remoteMessageVerificationPresentCount: 0,
      remoteMessageVerificationNextAt: null,
      remoteMessageVerificationSource: null,
      remoteMessageVerificationLastError: null,
      postActionsToken: null,
    };
    const current = await context.prisma.managedBroadcastDelivery.findFirst({
      where: fence,
      select: {
        attemptCount: true,
        publicationOccurrenceId: true,
        publicationOccurrence: {
          select: {
            contentRevisionId: true,
            dispatchProfile: true,
            requiredBotId: true,
            status: true,
            scheduleRevision: true,
            retryAuthorizedAt: true,
            retryExpiresAt: true,
            schedule: { select: { status: true, revision: true } },
            publication: {
              select: { lifecycle: true, requiredBotId: true, dispatchProfile: true },
            },
          },
        },
      },
    });
    const occurrence = current?.publicationOccurrence;
    if (
      !current ||
      !occurrence ||
      occurrence.contentRevisionId !== marker.contentRevisionId ||
      occurrence.dispatchProfile !== 'PUBLIK_V1' ||
      occurrence.requiredBotId !== requiredBotId ||
      !['SCHEDULED', 'IN_PROGRESS'].includes(occurrence.status) ||
      occurrence.schedule.status !== 'ACTIVE' ||
      occurrence.schedule.revision !== occurrence.scheduleRevision ||
      occurrence.publication.lifecycle !== 'ACTIVE' ||
      occurrence.publication.requiredBotId !== requiredBotId ||
      occurrence.publication.dispatchProfile !== 'PUBLIK_V1' ||
      (hasRetry &&
        (occurrence.retryAuthorizedAt?.getTime() !== authorizedAtMs ||
          occurrence.retryExpiresAt?.getTime() !== expiresAtMs))
    )
      throw new ServiceUnavailableException('Publication preparation fence changed');
    fence = {
      ...fence,
      attemptCount: current.attemptCount,
      publicationOccurrenceId: current.publicationOccurrenceId,
      publicationOccurrence: {
        is: {
          contentRevisionId: marker.contentRevisionId,
          dispatchProfile: 'PUBLIK_V1',
          requiredBotId,
          status: { in: ['SCHEDULED', 'IN_PROGRESS'] },
          scheduleRevision: occurrence.scheduleRevision,
          ...(hasRetry
            ? {
                retryAuthorizedAt: new Date(authorizedAtMs as number),
                retryExpiresAt: new Date(expiresAtMs as number),
              }
            : {}),
          schedule: { is: { status: 'ACTIVE', revision: occurrence.scheduleRevision } },
          publication: { is: { lifecycle: 'ACTIVE', requiredBotId, dispatchProfile: 'PUBLIK_V1' } },
        },
      },
    };
  }
  const prepared = await context.publisherDialogContextService.prepare({
    chatId: delivery.targetChatId,
    entityType: entityType.data,
    dialogBotId: requiredBotId,
    customButtons: buttons.data,
    includeManagedDialogs: true,
  });
  if (typeof marker.retryExpiresAtMs === 'number' && marker.retryExpiresAtMs <= Date.now())
    throw new ServiceUnavailableException('Publication retry preparation expired');
  // FLAG: Preparation reads metadata without SEND. Only its exact pending content/retry marker may
  // change; a concurrent revision, cancellation or attempt wins the CAS. The final
  // content/schedule and actor/bot guards remain mandatory before HTTP dispatch.
  const persisted = await context.prisma.managedBroadcastDelivery.updateMany({
    where: fence,
    data: { publisherDialogContext: prepared as unknown as Prisma.InputJsonValue },
  });
  if (persisted.count !== 1) {
    // FLAG: The content snapshot also fences legacy v0 markers. An old worker must
    // never reuse a winner prepared for a concurrently accepted content revision.
    const winner = await context.prisma.managedBroadcastDelivery.findFirst({
      where: { ...fence, publisherDialogContext: undefined },
      select: { publisherDialogContext: true },
    });
    if (
      !winner ||
      !readPublisherPreparedDialogContext(winner.publisherDialogContext, requiredBotId)
    )
      throw new ServiceUnavailableException('Publication preparation fence changed');
    delivery.publisherDialogContext = winner.publisherDialogContext;
    return;
  }
  delivery.publisherDialogContext = prepared as unknown as Prisma.JsonValue;
}
