import type {
  PublicationScheduleInput,
  PublicationTargetInput,
} from '@maxim/contracts/publication';
import { ConflictException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import {
  ChatEntityType,
  Prisma,
  PublicationDispatchProfile,
  PublicationLifecycle,
  PublicationOccurrenceStatus,
  PublicationScheduleStatus,
} from '../prisma/prisma-client';
import { buildPublicationCalendarTargetPredicates } from './publication-calendar';
import {
  projectPublicationCalendar,
  type ProjectedPublicationConflict,
} from './publication-calendar-projection';
import {
  buildUnsafePublicationExecutionDeliveryWhere,
  throwPublicationExecutionRequiresManualReview,
} from './publication-execution-safety';

export type PublicationCalendarConflictOccurrence = {
  id: string;
  publicationId: string;
  scheduleId: string;
  scheduleRevision: number;
  scheduledAt: Date;
  schedule: {
    revision: number;
  };
  publication: {
    actorUserId: string;
    targets: Array<{
      targetChatId: string;
      entityType: ChatEntityType;
    }>;
  };
};

export type PublicationCalendarConflicts = {
  reservations: Array<{
    broadcastId: string;
    entityType: ChatEntityType;
    targetChatId: string;
    scheduledAt: Date;
  }>;
  occurrences: PublicationCalendarConflictOccurrence[];
};

function calendarTargetKey(entityType: ChatEntityType, chatId: string): string {
  return `${entityType}:${chatId}`;
}

export async function assertProjectedPublicationSlotsAvailable(
  client: Pick<Prisma.TransactionClient, '$queryRaw'>,
  targets: readonly PublicationTargetInput[],
  slots: Date[],
  excludePublicationId?: string,
): Promise<void> {
  if (!slots.length) return;
  const times = slots.map((slot) => slot.getTime());
  const projected = await projectPublicationCalendar(client, {
    targets,
    from: new Date(Math.min(...times)),
    to: new Date(Math.max(...times)),
    points: slots,
    excludePublicationId,
    now: new Date(),
  });
  if (projected.length) {
    throw new ConflictException({
      code: 'PUBLICATION_CONFLICT_REQUIRES_MANUAL_REVIEW',
      message: 'Это время занято серией. Измените её отдельно или выберите другое время.',
      ...describePublicationCalendarConflict(
        { reservations: [], occurrences: [] },
        targets,
        projected,
      ),
    });
  }
}

export function describePublicationCalendarConflict(
  conflicts: PublicationCalendarConflicts,
  targets: readonly PublicationTargetInput[],
  projected: ProjectedPublicationConflict[] = [],
) {
  const requestedTargets = new Set(
    targets.map((target) =>
      calendarTargetKey(
        target.entityType === 'channel' ? ChatEntityType.CHANNEL : ChatEntityType.CHAT,
        target.chatId,
      ),
    ),
  );
  const slots = new Map<string, { chatId: string; scheduledAt: string }>();
  const addSlot = (chatId: string, scheduledAt: Date) => {
    slots.set(JSON.stringify([chatId, scheduledAt.toISOString()]), {
      chatId,
      scheduledAt: scheduledAt.toISOString(),
    });
  };
  for (const row of [...conflicts.reservations, ...projected]) {
    addSlot(row.targetChatId, row.scheduledAt);
  }
  for (const occurrence of conflicts.occurrences) {
    for (const target of occurrence.publication.targets) {
      if (requestedTargets.has(calendarTargetKey(target.entityType, target.targetChatId))) {
        addSlot(target.targetChatId, occurrence.scheduledAt);
      }
    }
  }
  const details = [...slots.keys()].sort().map((key) => slots.get(key)!);
  const identities = [
    ...conflicts.reservations.map((row) =>
      JSON.stringify([
        'reservation',
        row.broadcastId,
        row.entityType,
        row.targetChatId,
        row.scheduledAt.toISOString(),
      ]),
    ),
    ...conflicts.occurrences.map((row) =>
      JSON.stringify([
        'occurrence',
        row.id,
        row.scheduleRevision,
        row.scheduledAt.toISOString(),
        row.publication.targets
          .map((target) => calendarTargetKey(target.entityType, target.targetChatId))
          .sort(),
      ]),
    ),
  ].sort();
  return {
    conflicts: details.slice(0, 20),
    conflictCount: details.length,
    ...(projected.length === 0
      ? {
          conflictConfirmation: createHash('sha256')
            .update(JSON.stringify(identities))
            .digest('hex'),
        }
      : {}),
  };
}

export function assertPublicationCalendarReplacementConfirmation(
  schedule: Exclude<PublicationScheduleInput, { mode: 'now' }>,
  conflicts: PublicationCalendarConflicts,
  targets: readonly PublicationTargetInput[],
): void {
  const hasConflicts = conflicts.reservations.length > 0 || conflicts.occurrences.length > 0;
  if (!hasConflicts && !schedule.conflictConfirmation) return;
  const details = describePublicationCalendarConflict(conflicts, targets);
  if (
    !schedule.replaceConflicts ||
    (schedule.conflictConfirmation &&
      schedule.conflictConfirmation !== details.conflictConfirmation)
  ) {
    throw new ConflictException({
      code: 'PUBLICATION_SCHEDULE_CONFLICT',
      message: hasConflicts
        ? 'В выбранное время уже запланирована публикация.'
        : 'Расписание изменилось. Проверьте время перед сохранением.',
      ...details,
    });
  }
}

export async function findPublicationCalendarConflicts(
  client: Pick<
    Prisma.TransactionClient,
    'managedBroadcastCalendarReservation' | 'publicationOccurrence'
  >,
  targets: readonly PublicationTargetInput[],
  slots: Date[],
  excludePublicationId?: string,
): Promise<PublicationCalendarConflicts> {
  const targetPredicates = buildPublicationCalendarTargetPredicates(targets);
  const unsafeDelivery = {
    OR: [
      ...buildUnsafePublicationExecutionDeliveryWhere().OR,
      { lockToken: { not: null } },
      { remoteMessageId: { not: null } },
      { sentAt: { not: null } },
      { legacySentWithoutRemoteId: true },
    ],
  };
  const unsafeEnvelope = {
    OR: [
      { lockedAt: { not: null } },
      { lockToken: { not: null } },
      { sentCount: { gt: 0 } },
      { deliveries: { some: unsafeDelivery } },
    ],
  };
  const activeOccurrence = {
    status: {
      in: [PublicationOccurrenceStatus.SCHEDULED, PublicationOccurrenceStatus.IN_PROGRESS],
    },
    schedule: {
      is: {
        status: { in: [PublicationScheduleStatus.ACTIVE, PublicationScheduleStatus.ERROR] },
      },
    },
    publication: {
      is: {
        lifecycle: { in: [PublicationLifecycle.ACTIVE, PublicationLifecycle.ERROR] },
        targets: { some: { OR: targetPredicates, canceledAt: null } },
      },
    },
  };
  const [reservations, occurrenceCandidates] = await Promise.all([
    client.managedBroadcastCalendarReservation.findMany({
      where: {
        scheduledAt: { in: slots },
        OR: targetPredicates,
        broadcast: {
          is: {
            dispatchProfile: PublicationDispatchProfile.PUBLIK_V1,
            // FLAG: Exclude only this parent's untouched reservations. A started or leased
            // envelope remains a conflict even when the caller authorizes replacing slots.
            ...(excludePublicationId
              ? {
                  OR: [
                    { publicationOccurrenceId: null },
                    {
                      publicationOccurrence: {
                        is: { publicationId: { not: excludePublicationId } },
                      },
                    },
                    unsafeEnvelope,
                  ],
                }
              : {}),
          },
        },
      },
      orderBy: { scheduledAt: 'asc' },
      select: {
        broadcastId: true,
        entityType: true,
        targetChatId: true,
        scheduledAt: true,
      },
    }),
    client.publicationOccurrence.findMany({
      where: {
        ...(excludePublicationId
          ? {
              OR: [
                { publicationId: { not: excludePublicationId }, ...activeOccurrence },
                {
                  publicationId: excludePublicationId,
                  OR: [
                    { deliveries: { some: unsafeDelivery } },
                    { legacyBroadcasts: { some: unsafeEnvelope } },
                  ],
                },
              ],
            }
          : activeOccurrence),
        scheduledAt: { in: slots },
        publication: {
          is: {
            dispatchProfile: PublicationDispatchProfile.PUBLIK_V1,
            ...(!excludePublicationId ? activeOccurrence.publication.is : {}),
          },
        },
      },
      orderBy: { scheduledAt: 'asc' },
      select: {
        id: true,
        publicationId: true,
        scheduleId: true,
        scheduleRevision: true,
        scheduledAt: true,
        schedule: { select: { revision: true } },
        publication: {
          select: {
            actorUserId: true,
            targets: {
              orderBy: { position: 'asc' },
              select: { targetChatId: true, entityType: true },
            },
          },
        },
      },
    }),
  ]);
  // FLAG: A new schedule revision must never mint a second SEND identity for an already
  // attempted slot. Check retained receipts even after their calendar reservation is gone.
  if (
    excludePublicationId &&
    occurrenceCandidates.some(
      (occurrence: PublicationCalendarConflictOccurrence) =>
        occurrence.publicationId === excludePublicationId,
    )
  ) {
    throwPublicationExecutionRequiresManualReview(
      'Этот запуск уже начал отправку. Выберите другое время и проверьте его доставки.',
    );
  }
  return {
    reservations,
    occurrences: occurrenceCandidates.filter(
      (occurrence: PublicationCalendarConflictOccurrence) =>
        occurrence.scheduleRevision === occurrence.schedule.revision,
    ),
  };
}
