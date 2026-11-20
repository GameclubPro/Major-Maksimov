import {
  publicationScheduleInputSchema,
  publicationSchedulePreviewRequestSchema,
  type PublicationSchedulePreviewResponse,
  type UpdatePublicationRequest,
} from '@maxim/contracts/publication';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import {
  Prisma,
  PublicationDispatchProfile,
  PublicationLifecycle,
  PublicationOccurrenceStatus,
  PublicationScheduleStatus,
} from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import {
  countableCalendarOccurrenceWhere,
  planAudienceOnlyPublicationRebuild,
} from './publication-calendar-projection';
import {
  resolvePublicationRecurrenceFrom,
  withDefaultPublicationLatePolicy,
} from './publication-late-policy';
import { previewPublicationRecurrence } from './publication-recurrence';
import {
  arePublicationSchedulesEquivalent,
  normalizePublicationSchedule,
  resolvePublicationScheduleUpdate,
} from './publication-schedule-normalization';

type PreviewSelection = Prisma.PublicationGetPayload<{ select: typeof previewSelect }>;
type PreviewArgs = Parameters<typeof previewPublicationRecurrence>;
type PreviewPreparation =
  | { result: PublicationSchedulePreviewResponse }
  | { rule: PreviewArgs[0]; options: PreviewArgs[1] };

const previewSelect = {
  version: true,
  lifecycle: true,
  audienceMode: true,
  audienceSelection: true,
  targets: { select: { targetChatId: true, entityType: true } },
  schedule: true,
} satisfies Prisma.PublicationSelect;

export async function previewPublicationSchedule({
  prisma,
  body,
  access,
  isAudienceEquivalent,
  pastGraceMs,
  now = new Date(),
}: {
  prisma: Pick<PrismaService, '$transaction'>;
  body: unknown;
  access: () => Prisma.PublicationWhereInput;
  isAudienceEquivalent: (
    audience: NonNullable<UpdatePublicationRequest['audience']>,
    existing: PreviewSelection,
  ) => boolean;
  pastGraceMs: number;
  now?: Date;
}): Promise<PublicationSchedulePreviewResponse> {
  const parsed = publicationSchedulePreviewRequestSchema.safeParse(body);
  if (!parsed.success) throw new BadRequestException(parsed.error.format());
  const { editing, audience, schedule: input } = parsed.data;
  if (!editing) {
    if (!input) return missingPreview('empty');
    const rule = normalizePublicationSchedule(
      withDefaultPublicationLatePolicy(input),
      now,
      pastGraceMs,
    );
    return rule.mode === 'recurrence'
      ? previewPublicationRecurrence(rule, { from: now, now })
      : missingPreview('empty');
  }

  const prepared = await prisma.$transaction<PreviewPreparation>(
    async (tx) => {
      const existing = await tx.publication.findFirst({
        where: {
          id: editing.publicationId,
          ...access(),
          dispatchProfile: PublicationDispatchProfile.PUBLIK_V1,
        },
        select: previewSelect,
      });
      if (!existing) throw new NotFoundException('Публикация не найдена.');
      if (existing.version !== editing.expectedRevision) {
        throw new ConflictException({
          code: 'PUBLICATION_REVISION_CONFLICT',
          message: 'Публикация уже изменена. Обновите экран и повторите правку.',
          currentRevision: existing.version,
        });
      }
      if (
        existing.lifecycle === PublicationLifecycle.CANCELED ||
        existing.lifecycle === PublicationLifecycle.COMPLETED
      ) {
        throw new ConflictException('Завершённую публикацию нельзя изменить. Создайте копию.');
      }

      const saved = existing.schedule;
      if (
        saved &&
        saved.status !== PublicationScheduleStatus.DRAFT &&
        !publicationScheduleInputSchema.safeParse(saved.rule).success
      ) {
        return { result: missingPreview('unavailable') };
      }
      const { existingSchedule, schedule: rule } = resolvePublicationScheduleUpdate(
        saved,
        input,
        now,
        pastGraceMs,
      );
      if (rule?.mode !== 'recurrence') return { result: missingPreview('empty') };
      if (existing.lifecycle === PublicationLifecycle.PAUSED) {
        return { result: missingPreview('unavailable', rule.timezone) };
      }

      const changed =
        input !== undefined && !arePublicationSchedulesEquivalent(existingSchedule, rule);
      if (!changed && saved && audience && !isAudienceEquivalent(audience, existing)) {
        try {
          const plan = await planAudienceOnlyPublicationRebuild(tx, saved, rule, now);
          return {
            rule: plan.rule,
            options: { from: now, now, skippedAt: new Set(plan.skippedByAt.keys()) },
          };
        } catch (error) {
          if (error instanceof BadRequestException)
            return { result: missingPreview('empty', rule.timezone) };
          throw error;
        }
      }
      if (changed || !saved) return { rule, options: { from: now, now } };

      if (saved.status === PublicationScheduleStatus.ERROR) {
        // Publishing unchanged once more repairs an unbounded series from the current time.
        if (input !== undefined && rule.maxOccurrences === null)
          return { rule, options: { from: now, now } };
        return { result: missingPreview('unavailable', rule.timezone) };
      }
      if (saved.status !== PublicationScheduleStatus.ACTIVE || !rule.startsAt) {
        return { result: missingPreview('unavailable', rule.timezone) };
      }
      return { rule, options: await readCurrentRecurrence(tx, saved, rule, now) };
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
  );
  return 'result' in prepared
    ? prepared.result
    : previewPublicationRecurrence(prepared.rule, prepared.options);
}

async function readCurrentRecurrence(
  client: Pick<Prisma.TransactionClient, 'publicationOccurrence'>,
  schedule: NonNullable<PreviewSelection['schedule']>,
  rule: PreviewArgs[0],
  now: Date,
): Promise<PreviewArgs[1]> {
  const current = {
    publicationId: schedule.publicationId,
    scheduleId: schedule.id,
    scheduleRevision: schedule.revision,
  };
  const consumed = { ...current, ...countableCalendarOccurrenceWhere(rule) };
  const active: Prisma.PublicationOccurrenceWhereInput = {
    ...current,
    scheduledAt: { gte: now },
    status: {
      in: [PublicationOccurrenceStatus.SCHEDULED, PublicationOccurrenceStatus.IN_PROGRESS],
    },
  };
  const select = { scheduledAt: true } as const;
  const last = await client.publicationOccurrence.findFirst({
    where: consumed,
    select,
    orderBy: { scheduledAt: 'desc' },
  });
  const existingCount =
    rule.maxOccurrences === null
      ? 0
      : await client.publicationOccurrence.count({ where: consumed });
  const firstMaterialized = await client.publicationOccurrence.findFirst({
    where: active,
    select,
    orderBy: { scheduledAt: 'asc' },
  });
  const lastMaterialized = firstMaterialized
    ? await client.publicationOccurrence.findFirst({
        where: active,
        select,
        orderBy: { scheduledAt: 'desc' },
      })
    : null;
  return {
    now,
    from: resolvePublicationRecurrenceFrom(rule, schedule, last, now),
    existingCount,
    firstMaterialized: firstMaterialized?.scheduledAt,
    lastMaterialized: lastMaterialized?.scheduledAt,
  };
}

function missingPreview(
  state: 'empty' | 'unavailable',
  timezone: string | null = null,
): PublicationSchedulePreviewResponse {
  return { state, timezone, firstOccurrenceAt: null, lastOccurrenceAt: null };
}
