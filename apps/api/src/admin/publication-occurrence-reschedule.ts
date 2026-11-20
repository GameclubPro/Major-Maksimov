import {
  MAX_PUBLICATION_MEDIA,
  MAX_PUBLICATION_RECURRENCE_OCCURRENCES,
  publicationOccurrenceRescheduleRequestSchema,
  publicationScheduleInputSchema,
  type PublicationDetails,
  type PublicationOccurrenceRescheduleRequest,
  type PublicationOccurrenceRescheduleResponse,
  type PublicationScheduleInput,
  type PublicationTargetInput,
} from '@maxim/contracts/publication';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { AuthUser } from '../common/decorators/current-user.decorator';
import { Prisma } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import { isPrismaKnownError } from './admin-legacy-utils';
import {
  assertProjectedPublicationSlotsAvailable,
  assertPublicationCalendarReplacementConfirmation,
  findPublicationCalendarConflicts,
} from './publication-calendar-conflicts';
import {
  countableCalendarOccurrenceWhere,
  getPublicationCalendarCheckSlots,
  lockPublicationCalendar,
  persistedPublicationScheduleRule,
  PUBLICATION_CALENDAR_SLOT_OCCUPIED,
  PUBLICATION_CALENDAR_SLOT_SKIPPED,
} from './publication-calendar-projection';
import { snapshotPublicationDeliveryDeadline } from './publication-late-policy';
import type { PublicationPublisherRoutingService } from './publication-publisher-routing.service';
import {
  expandInitialPublicationSchedule,
  findNextPublicationRecurrenceSlot,
  PUBLICATION_RECURRENCE_HORIZON_MS,
} from './publication-recurrence';
import { normalizePublicationSchedule } from './publication-schedule-normalization';
import {
  PUBLICATION_UPLOADED_VIDEO_FIELD,
  readPublicationUploadedVideo,
} from './publication-video-media';

type Recurrence = Extract<PublicationScheduleInput, { mode: 'recurrence' }>;
type RescheduleContext = {
  prisma: PrismaService;
  routing: Pick<
    PublicationPublisherRoutingService,
    'requireNewRoute' | 'resolvePersistedTargets' | 'assertTargetsReady'
  >;
  access: Prisma.PublicationWhereInput;
  read: (id: string) => Promise<PublicationDetails>;
  wake: (id: string, requestId: string) => Promise<void>;
};

export async function reschedulePublicationOccurrence(
  { prisma, routing, access, read, wake }: RescheduleContext,
  publicationId: string,
  occurrenceId: string,
  user: AuthUser,
  body: unknown,
): Promise<PublicationOccurrenceRescheduleResponse> {
  const parsed = publicationOccurrenceRescheduleRequestSchema.safeParse(body);
  if (!parsed.success) throw new BadRequestException(parsed.error.format());
  const request = parsed.data;
  const route = routing.requireNewRoute();
  const sourceWhere: Prisma.PublicationWhereInput = {
    AND: [
      access,
      { id: publicationId, dispatchProfile: 'PUBLIK_V1', requiredBotId: route.requiredBotId },
    ],
  };
  const source = await prisma.publication.findFirst({
    where: sourceWhere,
    select: {
      id: true,
      version: true,
      targets: { where: { canceledAt: null }, orderBy: { position: 'asc' } },
    },
  });
  if (!source) throw new NotFoundException('Публикация не найдена.');
  const requestHash = hashRescheduleRequest(publicationId, occurrenceId, request);
  const replay = async () => {
    const record = await prisma.publicationMutationRecord.findUnique({
      where: { actorUserId_requestId: { actorUserId: user.userId, requestId: request.requestId } },
      select: { publicationId: true, requestHash: true },
    });
    if (record && record.requestHash !== requestHash) {
      throw new BadRequestException('Ключ повтора уже использован для другого изменения.');
    }
    return record?.publicationId;
  };
  let replacementId = await replay();
  if (!replacementId) {
    if (source.version !== request.expectedRevision) throwRevisionConflict();
    const readinessTargets = await routing.resolvePersistedTargets(
      user,
      source.targets,
      'PUBLIK_V1',
    );
    await routing.assertTargetsReady(readinessTargets, route.requiredBotId);
    try {
      replacementId = await prisma.$transaction((tx) =>
        commitReschedule(tx, {
          sourceWhere,
          publicationId,
          occurrenceId,
          user,
          request,
          requestHash,
          botId: route.requiredBotId,
        }),
      );
    } catch (error: unknown) {
      if (!(error instanceof ConflictException) && !isPrismaKnownError(error, 'P2002')) throw error;
      replacementId = await replay();
      if (!replacementId) throw error;
    }
  }
  // FLAG: A replay returns its original result only while the editor still manages both sides.
  const accessible = await prisma.publication.count({
    where: {
      AND: [
        access,
        {
          id: { in: [publicationId, replacementId] },
          dispatchProfile: 'PUBLIK_V1',
          requiredBotId: route.requiredBotId,
        },
      ],
    },
  });
  if (accessible !== 2) throw new NotFoundException('Публикация не найдена.');
  const [updatedSource, replacement] = await Promise.all([
    read(publicationId),
    read(replacementId),
  ]);
  await wake(replacementId, request.requestId);
  return { source: updatedSource, publication: replacement };
}

function hashRescheduleRequest(
  publicationId: string,
  occurrenceId: string,
  request: PublicationOccurrenceRescheduleRequest,
): string {
  const plan =
    request.scope === 'occurrence'
      ? new Date(request.at).toISOString()
      : [
          request.schedule.timezone,
          request.schedule.frequency,
          request.schedule.interval,
          [...request.schedule.times].sort(),
          [...request.schedule.weekdays].sort((left, right) => left - right),
          request.schedule.startsAt ? new Date(request.schedule.startsAt).toISOString() : null,
          request.schedule.endsAt ? new Date(request.schedule.endsAt).toISOString() : null,
        ];
  return createHash('sha256')
    .update(
      JSON.stringify([
        'reschedule-occurrence-v1',
        publicationId,
        occurrenceId,
        request.expectedRevision,
        request.scope,
        plan,
      ]),
    )
    .digest('hex');
}

function throwRevisionConflict(): never {
  throw new ConflictException({
    code: 'PUBLICATION_REVISION_CONFLICT',
    message: 'Расписание изменилось. Откройте его заново.',
  });
}

function throwStartedOccurrence(): never {
  throw new ConflictException({
    code: 'PUBLICATION_CONFLICT_REQUIRES_MANUAL_REVIEW',
    message: 'Выпуск уже изменился или начал отправляться. Проверьте расписание.',
  });
}

type RescheduleCommit = {
  sourceWhere: Prisma.PublicationWhereInput;
  publicationId: string;
  occurrenceId: string;
  user: AuthUser;
  request: PublicationOccurrenceRescheduleRequest;
  requestHash: string;
  botId: string;
};

// FLAG: Once a worker has created an execution envelope, the saved delivery remains authoritative.
const untouchedOccurrence = {
  status: 'SCHEDULED',
  legacyBroadcastId: null,
  legacyBroadcasts: { none: {} },
  deliveries: { none: {} },
} as const satisfies Prisma.PublicationOccurrenceWhereInput;

async function commitReschedule(
  tx: Prisma.TransactionClient,
  input: RescheduleCommit,
): Promise<string> {
  await lockPublicationCalendar(tx);
  const now = new Date();
  const { sourceWhere, publicationId, occurrenceId, request, user, botId } = input;
  const source = await tx.publication.findFirst({
    where: { AND: [sourceWhere, { version: request.expectedRevision, lifecycle: 'ACTIVE' }] },
    select: {
      title: true,
      canonicalContentRevisionId: true,
      targets: {
        where: { canceledAt: null },
        orderBy: { position: 'asc' },
        select: { targetChatId: true, entityType: true },
      },
      schedule: true,
    },
  });
  if (
    !source?.schedule ||
    source.schedule.status !== 'ACTIVE' ||
    source.schedule.mode !== 'RECURRENCE'
  )
    throwRevisionConflict();
  if (!source.targets.length) throw new BadRequestException('Выберите хотя бы один чат или канал.');
  const old = publicationScheduleInputSchema.parse(source.schedule.rule);
  if (old.mode !== 'recurrence') throwRevisionConflict();
  const currentRevision = {
    publicationId,
    scheduleId: source.schedule.id,
    scheduleRevision: source.schedule.revision,
  };
  const selected = await tx.publicationOccurrence.findFirst({
    where: {
      ...currentRevision,
      id: occurrenceId,
      scheduledAt: { gt: now },
      ...untouchedOccurrence,
    },
    select: { scheduledAt: true, contentRevisionId: true },
  });
  if (!selected) throwStartedOccurrence();

  const contentRevisionId =
    request.scope === 'occurrence' ? selected.contentRevisionId : source.canonicalContentRevisionId;
  const content = contentRevisionId
    ? await tx.publicationContentRevision.findFirst({
        where: { id: contentRevisionId, publicationId },
        select: {
          text: true,
          textFormat: true,
          buttons: true,
          postPublish: true,
          assets: {
            orderBy: { position: 'asc' },
            take: MAX_PUBLICATION_MEDIA + 1,
            select: {
              assetId: true,
              position: true,
              asset: { select: { durablePayload: true } },
            },
          },
        },
      })
    : null;
  if (!content || content.assets.length > MAX_PUBLICATION_MEDIA) {
    throw new BadRequestException('Содержимое публикации недоступно.');
  }
  const uploadedVideoMismatch = content.assets.some(({ asset }) => {
    const payload = asset.durablePayload;
    return (
      payload !== null &&
      typeof payload === 'object' &&
      !Array.isArray(payload) &&
      Object.hasOwn(payload, PUBLICATION_UPLOADED_VIDEO_FIELD) &&
      !readPublicationUploadedVideo(payload, botId)
    );
  });
  if (uploadedVideoMismatch) {
    throw new BadRequestException('Видео недоступно. Откройте публикацию и добавьте его снова.');
  }

  const servingTargets: PublicationTargetInput[] = source.targets.map(
    ({ targetChatId, entityType }) => ({
      chatId: targetChatId,
      entityType: entityType === 'CHAT' ? 'chat' : 'channel',
    }),
  );
  const schedule =
    request.scope === 'occurrence'
      ? buildSingleSchedule(request.at, selected.scheduledAt, old, now)
      : await splitFutureSchedule(
          tx,
          currentRevision,
          old,
          request.schedule,
          selected.scheduledAt,
          now,
        );
  if (request.scope === 'occurrence') {
    const canceled = await tx.publicationOccurrence.updateMany({
      where: {
        ...currentRevision,
        id: occurrenceId,
        scheduledAt: selected.scheduledAt,
        ...untouchedOccurrence,
      },
      data: {
        status: 'CANCELED',
        dispatchBlockerCode: PUBLICATION_CALENDAR_SLOT_SKIPPED,
        dispatchBlockedAt: now,
      },
    });
    if (canceled.count !== 1) throwStartedOccurrence();
  }

  const plan = makeInitialOccurrencePlan(schedule, now);
  const checkSlots = getPublicationCalendarCheckSlots(schedule, plan.slots, undefined, now);
  // The original publication is deliberately included, so a retained sibling still occupies its date.
  await assertProjectedPublicationSlotsAvailable(tx, servingTargets, checkSlots);
  const conflicts = await findPublicationCalendarConflicts(tx, servingTargets, checkSlots);
  assertPublicationCalendarReplacementConfirmation(schedule, conflicts, servingTargets);

  const sourceVersion = await tx.publication.updateMany({
    where: { AND: [sourceWhere, { version: request.expectedRevision }] },
    data: { version: { increment: 1 } },
  });
  if (sourceVersion.count !== 1) throwRevisionConflict();
  const created = await tx.publication.create({
    data: {
      actorUserId: user.userId,
      requestId: request.requestId,
      title: source.title,
      lifecycle: 'ACTIVE',
      audienceSelection: 'SELECTED',
      audienceMode: 'SNAPSHOT',
      dispatchProfile: 'PUBLIK_V1',
      requiredBotId: botId,
      targets: { create: source.targets.map((target, position) => ({ ...target, position })) },
    },
    select: { id: true },
  });
  const copiedContent = await tx.publicationContentRevision.create({
    data: {
      publicationId: created.id,
      revision: 1,
      text: content.text,
      textFormat: content.textFormat,
      buttons: content.buttons as Prisma.InputJsonValue,
      postPublish: content.postPublish as Prisma.InputJsonValue,
      assets: {
        createMany: {
          data: content.assets.map(({ assetId, position }) => ({ assetId, position })),
        },
      },
    },
    select: { id: true },
  });
  await tx.publication.update({
    where: { id: created.id },
    data: { canonicalContentRevisionId: copiedContent.id },
  });
  const saved = await tx.publicationSchedule.create({
    data: {
      publicationId: created.id,
      mode: schedule.mode === 'once' ? 'ONCE' : 'RECURRENCE',
      timezone: schedule.timezone,
      rule: persistedPublicationScheduleRule(schedule),
      status: 'ACTIVE',
      lastMaterializedAt: now,
      nextMaterializeAt: plan.nextMaterializeAt,
    },
    select: { id: true, revision: true },
  });
  if (plan.slots.length) {
    await tx.publicationOccurrence.createMany({
      data: plan.slots.map((scheduledAt) => ({
        publicationId: created.id,
        scheduleId: saved.id,
        scheduleRevision: saved.revision,
        contentRevisionId: copiedContent.id,
        scheduledAt,
        deliveryDeadlineAt: snapshotPublicationDeliveryDeadline(scheduledAt, schedule),
        dispatchProfile: 'PUBLIK_V1',
        requiredBotId: botId,
      })),
    });
  }
  await tx.publicationMutationRecord.create({
    data: {
      actorUserId: user.userId,
      requestId: request.requestId,
      requestHash: input.requestHash,
      publicationId: created.id,
      resultingVersion: 1,
    },
  });
  return created.id;
}

function buildSingleSchedule(at: string, oldAt: Date, old: Recurrence, now: Date) {
  const nextAt = new Date(at);
  if (nextAt <= now || nextAt.getTime() === oldAt.getTime()) {
    throw new BadRequestException('Выберите другое будущее время.');
  }
  const rule = {
    mode: 'once' as const,
    timezone: old.timezone,
    at: nextAt.toISOString(),
    latePolicy: old.latePolicy,
    replaceConflicts: false,
  };
  normalizePublicationSchedule(rule, now, 0);
  return rule;
}

async function splitFutureSchedule(
  tx: Prisma.TransactionClient,
  revision: { publicationId: string; scheduleId: string; scheduleRevision: number },
  old: Recurrence,
  next: Recurrence,
  cutoff: Date,
  now: Date,
): Promise<Recurrence> {
  const counted = countableCalendarOccurrenceWhere(old);
  const prefix = await tx.publicationOccurrence.findFirst({
    where: { ...revision, ...counted, scheduledAt: { lt: cutoff } },
    orderBy: { scheduledAt: 'desc' },
    select: { scheduledAt: true },
  });
  const keptByCap =
    old.maxOccurrences === null
      ? 0
      : await tx.publicationOccurrence.count({
          where: {
            ...revision,
            AND: [
              counted,
              {
                OR: [
                  { scheduledAt: { lt: cutoff } },
                  {
                    scheduledAt: { gte: cutoff },
                    status: 'CANCELED',
                    dispatchBlockerCode: {
                      in: [PUBLICATION_CALENDAR_SLOT_OCCUPIED, PUBLICATION_CALENDAR_SLOT_SKIPPED],
                    },
                  },
                ],
              },
            ],
          },
        });
  const remaining = old.maxOccurrences === null ? null : old.maxOccurrences - keptByCap;
  if (remaining !== null && remaining < 1) {
    throw new BadRequestException('В серии больше нет выпусков для переноса.');
  }
  const endsAt =
    old.endsAt && (!next.endsAt || Date.parse(old.endsAt) < Date.parse(next.endsAt))
      ? old.endsAt
      : next.endsAt;
  const startsAt = next.startsAt ? new Date(next.startsAt) : cutoff;
  const newRule: Recurrence = {
    ...next,
    startsAt: startsAt.toISOString(),
    endsAt,
    maxOccurrences: remaining,
    latePolicy: old.latePolicy,
    replaceConflicts: false,
  };
  if (endsAt && Date.parse(endsAt) <= startsAt.getTime()) {
    throw new BadRequestException('Дата окончания серии уже прошла для выбранного расписания.');
  }
  normalizePublicationSchedule(newRule, now, 0);
  const first = findNextPublicationRecurrenceSlot(newRule, startsAt);
  if (!first || first <= now || (prefix && first <= prefix.scheduledAt)) {
    throw new BadRequestException('Выберите время после предыдущего выпуска.');
  }

  const tail = {
    ...revision,
    scheduledAt: { gte: cutoff },
    status: { not: 'CANCELED' },
  } satisfies Prisma.PublicationOccurrenceWhereInput;
  const candidates = await tx.publicationOccurrence.findMany({
    where: tail,
    select: { id: true },
    take: MAX_PUBLICATION_RECURRENCE_OCCURRENCES + 1,
  });
  if (!candidates.length || candidates.length > MAX_PUBLICATION_RECURRENCE_OCCURRENCES)
    throwStartedOccurrence();
  const canceled = await tx.publicationOccurrence.updateMany({
    where: { ...tail, ...untouchedOccurrence, id: { in: candidates.map(({ id }) => id) } },
    data: { status: 'CANCELED' },
  });
  if (canceled.count !== candidates.length) throwStartedOccurrence();

  const oldEnd = new Date(cutoff.getTime() - 1).toISOString();
  if (prefix && (!old.startsAt || Date.parse(oldEnd) > Date.parse(old.startsAt))) {
    await tx.publicationSchedule.update({
      where: { id: revision.scheduleId },
      data: {
        rule: persistedPublicationScheduleRule({ ...old, endsAt: oldEnd }),
        nextMaterializeAt: null,
        lastError: null,
      },
    });
  } else {
    await tx.publicationSchedule.update({
      where: { id: revision.scheduleId },
      data: { status: 'CANCELED', nextMaterializeAt: null, lastError: null },
    });
    await tx.publication.update({
      where: { id: revision.publicationId },
      data: { lifecycle: 'CANCELED' },
    });
  }
  return newRule;
}

function makeInitialOccurrencePlan(
  schedule: Exclude<PublicationScheduleInput, { mode: 'now' | 'slots' }>,
  now: Date,
) {
  if (schedule.mode === 'once') return { slots: [new Date(schedule.at)], nextMaterializeAt: null };
  const slots = expandInitialPublicationSchedule(schedule, now);
  const last = slots.at(-1);
  const next = findNextPublicationRecurrenceSlot(
    schedule,
    last ? new Date(last.getTime() + 1) : now,
    slots.length,
  );
  return {
    slots,
    nextMaterializeAt: next
      ? new Date(Math.max(now.getTime(), next.getTime() - PUBLICATION_RECURRENCE_HORIZON_MS))
      : null,
  };
}
