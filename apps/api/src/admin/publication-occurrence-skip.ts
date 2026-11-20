import { ConflictException } from '@nestjs/common';
import type { PublicationActionRequest } from '@maxim/contracts/publication';
import {
  Prisma,
  PublicationDispatchProfile,
  PublicationLifecycle,
  PublicationOccurrenceStatus,
  PublicationScheduleMode,
  PublicationScheduleStatus,
} from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import { isPrismaKnownError } from './admin-legacy-utils';

export async function executePublicationOccurrenceSkip(
  prisma: PrismaService,
  input: {
    lock: (tx: Prisma.TransactionClient) => Promise<void>;
    publicationId: string;
    occurrenceId: string;
    access: Prisma.PublicationWhereInput;
    actorUserId: string;
    profile: PublicationDispatchProfile;
    request: PublicationActionRequest;
    hash: string;
    replay: () => Promise<boolean>;
  },
): Promise<void> {
  if (await input.replay()) return;
  try {
    await prisma.$transaction((tx) =>
      skipScheduledPublicationOccurrence(tx, { ...input, lock: () => input.lock(tx) }),
    );
  } catch (error: unknown) {
    if (
      !(error instanceof ConflictException || isPrismaKnownError(error, 'P2002')) ||
      !(await input.replay())
    )
      throw error;
  }
}

export async function skipScheduledPublicationOccurrence(
  tx: Prisma.TransactionClient,
  input: {
    lock: () => Promise<void>;
    publicationId: string;
    occurrenceId: string;
    access: Prisma.PublicationWhereInput;
    actorUserId: string;
    profile: PublicationDispatchProfile;
    request: PublicationActionRequest;
    hash: string;
  },
): Promise<void> {
  await input.lock();
  const parent = await tx.publication.updateMany({
    where: {
      AND: [
        input.access,
        {
          id: input.publicationId,
          dispatchProfile: input.profile,
          version: input.request.expectedRevision,
          lifecycle: PublicationLifecycle.ACTIVE,
          schedule: {
            is: {
              mode: PublicationScheduleMode.RECURRENCE,
              status: PublicationScheduleStatus.ACTIVE,
            },
          },
        },
      ],
    },
    data: { version: { increment: 1 } },
  });
  if (!parent.count) {
    throw new ConflictException({
      code: 'PUBLICATION_REVISION_CONFLICT',
      message: 'Расписание изменилось. Откройте его заново.',
    });
  }
  const schedule = await tx.publicationSchedule.findUniqueOrThrow({
    where: { publicationId: input.publicationId },
    select: { id: true, revision: true },
  });
  // FLAG: An occurrence with an execution envelope or delivery already needs the ordinary
  // delivery-resolution flow. Its result cannot be overwritten by a calendar action.
  const now = new Date();
  const skipped = await tx.publicationOccurrence.updateMany({
    where: {
      id: input.occurrenceId,
      publicationId: input.publicationId,
      scheduleId: schedule.id,
      scheduleRevision: schedule.revision,
      status: PublicationOccurrenceStatus.SCHEDULED,
      scheduledAt: { gt: now },
      legacyBroadcastId: null,
      legacyBroadcasts: { none: {} },
      deliveries: { none: {} },
    },
    data: {
      status: PublicationOccurrenceStatus.CANCELED,
      dispatchBlockerCode: 'PUBLICATION_CALENDAR_SLOT_SKIPPED',
      dispatchBlockedAt: now,
    },
  });
  if (!skipped.count) {
    throw new ConflictException('Этот выпуск уже изменился или начал отправляться.');
  }
  await tx.publicationMutationRecord.create({
    data: {
      actorUserId: input.actorUserId,
      requestId: input.request.requestId,
      requestHash: input.hash,
      publicationId: input.publicationId,
      resultingVersion: input.request.expectedRevision + 1,
    },
  });
}
