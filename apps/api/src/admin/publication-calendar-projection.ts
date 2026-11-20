import {
  MAX_PUBLICATION_CALENDAR_WINDOW_DAYS,
  MAX_PUBLICATION_RECURRENCE_OCCURRENCES,
  publicationScheduleInputSchema,
  type PublicationScheduleInput,
  type PublicationTargetInput,
} from '@maxim/contracts/publication';
import { BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import { ChatEntityType, Prisma, PublicationOccurrenceStatus } from '../prisma/prisma-client';
import {
  readPublicationLatePolicy,
  resolvePublicationRecurrenceFrom,
} from './publication-late-policy';
import { expandPublicationSchedule } from './publication-recurrence';

export const PUBLICATION_CALENDAR_SLOT_OCCUPIED = 'PUBLICATION_CALENDAR_SLOT_OCCUPIED';
export const PUBLICATION_CALENDAR_SLOT_SKIPPED = 'PUBLICATION_CALENDAR_SLOT_SKIPPED';
const CALENDAR_SERIES_LIMIT = 250;

type CalendarTarget = { entityType: ChatEntityType; targetChatId: string };
type CalendarSeries = {
  rule: Prisma.JsonValue;
  createdAt: Date;
  lastMaterializedAt: Date | null;
  latest: Date | null;
  occurrenceCount: number;
  targets: CalendarTarget[];
};

export type ProjectedPublicationConflict = CalendarTarget & { scheduledAt: Date };

export async function projectPublicationCalendar(
  client: Pick<Prisma.TransactionClient, '$queryRaw'>,
  options: {
    targets: readonly PublicationTargetInput[];
    from: Date;
    to: Date;
    now: Date;
    points?: readonly Date[];
    excludePublicationId?: string;
  },
): Promise<ProjectedPublicationConflict[]> {
  const { targets, from, to, now, points, excludePublicationId } = options;
  if (targets.length === 0 || to < now) return [];
  const targetRows = Prisma.join(
    targets.map(
      ({ chatId, entityType }) =>
        Prisma.sql`(${chatId}, ${entityType === 'chat' ? 'CHAT' : 'CHANNEL'}::"ChatEntityType")`,
    ),
  );
  const series = await client.$queryRaw<CalendarSeries[]>(Prisma.sql`
    WITH requested(target_chat_id, entity_type) AS (VALUES ${targetRows}),
    calendars AS MATERIALIZED (
      SELECT schedule."id", schedule."revision", schedule."rule", schedule."publication_id",
             schedule."created_at", schedule."last_materialized_at",
             jsonb_agg(jsonb_build_object('targetChatId', target."target_chat_id",
                                          'entityType', target."entity_type")) AS targets
      FROM requested
      JOIN "publication_targets" AS target USING ("target_chat_id", "entity_type")
      JOIN "publications" AS publication ON publication."id" = target."publication_id"
      JOIN "publication_schedules" AS schedule ON schedule."publication_id" = publication."id"
      WHERE target."canceled_at" IS NULL
        AND publication."dispatch_profile" = 'PUBLIK_V1'::"PublicationDispatchProfile"
        AND publication."lifecycle" = 'ACTIVE'::"PublicationLifecycle"
        AND schedule."mode" = 'RECURRENCE'::"PublicationScheduleMode"
        AND schedule."status" = 'ACTIVE'::"PublicationScheduleStatus"
        AND schedule."next_materialize_at" IS NOT NULL
        ${excludePublicationId ? Prisma.sql`AND publication."id" <> ${excludePublicationId}` : Prisma.empty}
      GROUP BY schedule."id"
      LIMIT ${CALENDAR_SERIES_LIMIT + 1}
    )
    SELECT calendars."rule", calendars."targets", calendars."created_at" AS "createdAt",
           calendars."last_materialized_at" AS "lastMaterializedAt",
           (
             SELECT occurrence."scheduled_at"
             FROM "publication_occurrences" AS occurrence
             WHERE occurrence."publication_id" = calendars."publication_id"
               AND occurrence."schedule_id" = calendars."id"
               AND occurrence."schedule_revision" = calendars."revision"
               AND ${countableCalendarOccurrenceSql()}
             ORDER BY occurrence."scheduled_at" DESC
             LIMIT 1
           ) AS latest,
           CASE WHEN jsonb_typeof(calendars."rule"->'maxOccurrences') = 'number' THEN (
             SELECT count(*)::int FROM (
               SELECT 1
               FROM "publication_occurrences" AS occurrence
               WHERE occurrence."publication_id" = calendars."publication_id"
                 AND occurrence."schedule_id" = calendars."id"
                 AND occurrence."schedule_revision" = calendars."revision"
                 AND ${countableCalendarOccurrenceSql()}
               LIMIT ${MAX_PUBLICATION_RECURRENCE_OCCURRENCES}
             ) AS consumed
           ) ELSE 0 END AS "occurrenceCount"
    FROM calendars
  `);
  if (series.length > CALENDAR_SERIES_LIMIT) {
    throw new ServiceUnavailableException(
      'Слишком много активных серий. Проверьте меньше получателей за раз.',
    );
  }

  const pointSet = points && new Set(points.map((point) => point.getTime()));
  const projected: ProjectedPublicationConflict[] = [];
  for (const row of series) {
    const parsed = publicationScheduleInputSchema.safeParse(row.rule);
    if (!parsed.success || parsed.data.mode !== 'recurrence') continue;
    const rule = parsed.data;
    const cursor = resolvePublicationRecurrenceFrom(
      rule,
      row,
      row.latest ? { scheduledAt: row.latest } : null,
      now,
    );
    if (cursor > to) continue;
    if (rule.maxOccurrences !== null) {
      // Count from the cursor even when the visible range starts far away.
      for (const slot of expandPublicationSchedule(rule, {
        from: cursor,
        to,
        existingCount: row.occurrenceCount,
      })) {
        if (slot >= now && slot >= from && (!pointSet || pointSet.has(slot.getTime()))) {
          for (const target of row.targets) projected.push({ ...target, scheduledAt: slot });
        }
      }
    } else if (points) {
      // A list of explicit dates can span years. Probe each minute without expanding the gaps.
      for (const slot of points) {
        if (slot < cursor || slot < now) continue;
        const anchored = rule.startsAt ? rule : { ...rule, startsAt: cursor.toISOString() };
        if (expandPublicationSchedule(anchored, { from: slot, to: slot }).length) {
          for (const target of row.targets) projected.push({ ...target, scheduledAt: slot });
        }
      }
    } else {
      const anchored = rule.startsAt ? rule : { ...rule, startsAt: cursor.toISOString() };
      for (const slot of expandPublicationSchedule(anchored, {
        from: new Date(Math.max(cursor.getTime(), from.getTime(), now.getTime())),
        to,
      })) {
        for (const target of row.targets) projected.push({ ...target, scheduledAt: slot });
      }
    }
  }
  return projected;
}

export function getPublicationCalendarCheckSlots(
  schedule: PublicationScheduleInput,
  slots: Date[],
  now = new Date(),
): Date[] {
  if (schedule.mode !== 'recurrence') return slots;
  const start = schedule.startsAt ? new Date(schedule.startsAt) : now;
  const from = start > now ? start : now;
  const to = new Date(from.getTime() + MAX_PUBLICATION_CALENDAR_WINDOW_DAYS * 86_400_000);
  const projected = expandPublicationSchedule(schedule, { from, to });
  return [...new Set([...slots, ...projected].map((slot) => slot.getTime()))].map(
    (value) => new Date(value),
  );
}

export function countableCalendarOccurrenceWhere(
  rule: unknown,
): Prisma.PublicationOccurrenceWhereInput {
  return readPublicationLatePolicy(rule)
    ? {}
    : {
        OR: [
          { status: { not: PublicationOccurrenceStatus.CANCELED } },
          {
            dispatchBlockerCode: {
              in: [PUBLICATION_CALENDAR_SLOT_OCCUPIED, PUBLICATION_CALENDAR_SLOT_SKIPPED],
            },
          },
        ],
      };
}

export async function planAudienceOnlyPublicationRebuild(
  tx: Pick<Prisma.TransactionClient, 'publicationOccurrence'>,
  schedule: { id: string; revision: number },
  rule: Extract<PublicationScheduleInput, { mode: 'recurrence' }>,
  now: Date,
) {
  const skippedSlotWhere = {
    dispatchBlockerCode: {
      in: [PUBLICATION_CALENDAR_SLOT_OCCUPIED, PUBLICATION_CALENDAR_SLOT_SKIPPED],
    },
  };
  const currentRevision = { scheduleId: schedule.id, scheduleRevision: schedule.revision };
  const skipped = await tx.publicationOccurrence.findMany({
    where: { ...currentRevision, ...skippedSlotWhere, scheduledAt: { gte: now } },
    select: { scheduledAt: true, dispatchBlockerCode: true, dispatchBlockedAt: true },
  });
  const consumed =
    rule.maxOccurrences === null
      ? 0
      : await tx.publicationOccurrence.count({
          where: consumeAudienceRebuildWhere(schedule, now),
        });
  const remaining = rule.maxOccurrences === null ? null : rule.maxOccurrences - consumed;
  if (remaining !== null && remaining < 1) {
    throw new BadRequestException('В серии больше нет запланированных выпусков.');
  }
  return {
    rule: { ...rule, maxOccurrences: remaining },
    skippedByAt: new Map(
      skipped.map(({ scheduledAt, ...marker }) => [
        scheduledAt.getTime(),
        { ...marker, status: PublicationOccurrenceStatus.CANCELED },
      ]),
    ),
  };
}

function consumeAudienceRebuildWhere(
  schedule: { id: string; revision: number },
  now: Date,
): Prisma.PublicationOccurrenceWhereInput {
  return {
    scheduleId: schedule.id,
    scheduleRevision: schedule.revision,
    OR: [
      {
        status: {
          in: [
            PublicationOccurrenceStatus.SENT,
            PublicationOccurrenceStatus.PARTIAL,
            PublicationOccurrenceStatus.FAILED,
            PublicationOccurrenceStatus.AMBIGUOUS,
          ],
        },
      },
      { status: PublicationOccurrenceStatus.IN_PROGRESS, scheduledAt: { lt: now } },
      {
        dispatchBlockerCode: {
          in: [PUBLICATION_CALENDAR_SLOT_OCCUPIED, PUBLICATION_CALENDAR_SLOT_SKIPPED],
        },
        scheduledAt: { lt: now },
      },
    ],
  };
}

function countableCalendarOccurrenceSql(): Prisma.Sql {
  return Prisma.sql`(
    jsonb_typeof(calendars."rule"->'latePolicy') = 'object'
    OR occurrence."status" <> 'CANCELED'::"PublicationOccurrenceStatus"
    OR occurrence."dispatch_blocker_code" IN (
      ${PUBLICATION_CALENDAR_SLOT_OCCUPIED}, ${PUBLICATION_CALENDAR_SLOT_SKIPPED}
    )
  )`;
}

export function persistedPublicationScheduleRule(
  schedule: PublicationScheduleInput,
): Prisma.InputJsonValue {
  if (schedule.mode === 'now') return schedule;
  const rule = { ...schedule, replaceConflicts: false };
  delete rule.conflictConfirmation;
  return rule;
}

export async function lockPublicationCalendar(
  tx: Pick<Prisma.TransactionClient, '$executeRaw'>,
): Promise<void> {
  await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtext('publication-calendar'))`);
}
