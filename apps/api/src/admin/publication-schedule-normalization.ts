import {
  publicationScheduleInputSchema,
  type PublicationScheduleInput,
} from '@maxim/contracts/publication';
import { BadRequestException } from '@nestjs/common';
import { PublicationScheduleStatus } from '../prisma/prisma-client';
import { withPreservedPublicationLatePolicy } from './publication-late-policy';
import {
  assertPublicationTimezone,
  findNextPublicationRecurrenceSlot,
} from './publication-recurrence';

export function normalizePublicationSchedule(
  schedule: PublicationScheduleInput,
  now: Date,
  pastGraceMs: number,
): PublicationScheduleInput {
  try {
    assertPublicationTimezone(schedule.timezone);
  } catch (error: unknown) {
    if (error instanceof RangeError) {
      throw new BadRequestException('Выберите корректный часовой пояс.');
    }
    throw error;
  }
  const normalized =
    schedule.mode === 'recurrence' && schedule.startsAt === null
      ? { ...schedule, startsAt: now.toISOString() }
      : schedule;
  const datedSlots =
    normalized.mode === 'once'
      ? [new Date(normalized.at)]
      : normalized.mode === 'slots'
        ? normalized.slots.map((slot) => new Date(slot))
        : [];
  if (datedSlots.some((slot) => slot.getUTCSeconds() !== 0 || slot.getUTCMilliseconds() !== 0)) {
    throw new BadRequestException('Укажите время с точностью до минуты, без секунд.');
  }
  if (datedSlots.some((slot) => slot.getTime() < now.getTime() - pastGraceMs)) {
    throw new BadRequestException('Время публикации уже прошло.');
  }
  return normalized;
}

export function assertPublishableSchedule(
  schedule: PublicationScheduleInput | null,
  initialSlots: Date[],
  now: Date,
): void {
  if (
    schedule?.mode !== 'recurrence' ||
    initialSlots.length > 0 ||
    schedule.endsAt === null ||
    findNextPublicationRecurrenceSlot(schedule, now, 0)
  ) {
    return;
  }

  throw new BadRequestException({
    code: 'PUBLICATION_SCHEDULE_EMPTY',
    message: 'Расписание не содержит ни одного будущего запуска.',
  });
}

export function arePublicationSchedulesEquivalent(
  left: PublicationScheduleInput | null,
  right: PublicationScheduleInput | null,
  ignoreLatePolicy = false,
): boolean {
  if (left === null || right === null) {
    return left === right;
  }
  return (
    stableStringifyPublicationValue(canonicalizePublicationSchedule(left, ignoreLatePolicy)) ===
    stableStringifyPublicationValue(canonicalizePublicationSchedule(right, ignoreLatePolicy))
  );
}

function canonicalizePublicationSchedule(
  schedule: PublicationScheduleInput,
  ignoreLatePolicy = false,
): unknown {
  if (schedule.mode === 'now') {
    return { mode: schedule.mode, timezone: schedule.timezone };
  }
  if (schedule.mode === 'once') {
    return {
      mode: schedule.mode,
      timezone: schedule.timezone,
      ...(!ignoreLatePolicy && 'latePolicy' in schedule ? { latePolicy: schedule.latePolicy } : {}),
      at: new Date(schedule.at).toISOString(),
    };
  }
  if (schedule.mode === 'slots') {
    return {
      mode: schedule.mode,
      timezone: schedule.timezone,
      ...(!ignoreLatePolicy && 'latePolicy' in schedule ? { latePolicy: schedule.latePolicy } : {}),
      slots: [...new Set(schedule.slots.map((slot) => new Date(slot).getTime()))]
        .sort((left, right) => left - right)
        .map((slot) => new Date(slot).toISOString()),
    };
  }
  return {
    mode: schedule.mode,
    timezone: schedule.timezone,
    ...(!ignoreLatePolicy && 'latePolicy' in schedule ? { latePolicy: schedule.latePolicy } : {}),
    frequency: schedule.frequency,
    interval: schedule.interval,
    weekdays: schedule.frequency === 'weekly' ? [...schedule.weekdays].sort((a, b) => a - b) : [],
    times: [...schedule.times].sort(),
    startsAt: schedule.startsAt ? new Date(schedule.startsAt).toISOString() : null,
    endsAt: schedule.endsAt ? new Date(schedule.endsAt).toISOString() : null,
    maxOccurrences: schedule.maxOccurrences,
  };
}

export function stableStringifyPublicationValue(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringifyPublicationValue(item)).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableStringifyPublicationValue(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export function resolvePublicationScheduleUpdate(
  existing: { status: PublicationScheduleStatus; rule: unknown } | null,
  input: PublicationScheduleInput | null | undefined,
  now: Date,
  pastGraceMs: number,
) {
  const existingSchedule =
    existing && existing.status !== PublicationScheduleStatus.DRAFT
      ? publicationScheduleInputSchema.parse(existing.rule)
      : null;
  const previousPolicy =
    existingSchedule ??
    (existing?.status === PublicationScheduleStatus.DRAFT
      ? (publicationScheduleInputSchema.safeParse(existing.rule).data ?? null)
      : null);
  const schedule =
    input === undefined
      ? existingSchedule
      : input === null
        ? null
        : withPreservedPublicationLatePolicy(
            normalizePublicationSchedule(input, now, pastGraceMs),
            previousPolicy,
            existingSchedule !== null,
            (previous, next) => arePublicationSchedulesEquivalent(previous, next, true),
          );
  return { existingSchedule, schedule };
}
