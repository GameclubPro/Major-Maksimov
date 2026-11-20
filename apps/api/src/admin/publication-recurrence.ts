import type { PublicationScheduleInput } from '@maxim/contracts/publication';
import { DateTime, IANAZone } from 'luxon';

export const PUBLICATION_RECURRENCE_LOOKAHEAD_MS = 450 * 24 * 60 * 60_000;

export interface ExpandPublicationScheduleOptions {
  from: Date;
  to: Date;
  existingCount?: number;
  now?: Date;
  maxResults?: number;
}

export function isValidPublicationTimezone(timezone: string): boolean {
  return timezone.length > 0 && IANAZone.isValidZone(timezone);
}

export function assertPublicationTimezone(timezone: string): void {
  if (!isValidPublicationTimezone(timezone)) {
    throw new RangeError(`Invalid IANA timezone: ${timezone}`);
  }
}

export function expandPublicationSchedule(
  schedule: PublicationScheduleInput,
  options: ExpandPublicationScheduleOptions,
): Date[] {
  assertPublicationTimezone(schedule.timezone);

  const fromMs = readDate(options.from, 'from');
  const toMs = readDate(options.to, 'to');
  if (toMs < fromMs) {
    throw new RangeError('Publication schedule window must end at or after it starts.');
  }

  if (
    options.maxResults !== undefined &&
    (!Number.isSafeInteger(options.maxResults) || options.maxResults < 1)
  ) {
    throw new RangeError('maxResults must be a positive integer.');
  }
  const existingCount = options.existingCount ?? 0;
  if (!Number.isInteger(existingCount) || existingCount < 0) {
    throw new RangeError('existingCount must be a non-negative integer.');
  }

  if (schedule.mode === 'now') {
    const now = options.now ?? options.from;
    readDate(now, 'now');
    return uniqueSortedDates([now], fromMs, toMs);
  }

  if (schedule.mode === 'once') {
    return uniqueSortedDates([parseScheduleDate(schedule.at, 'at')], fromMs, toMs);
  }

  if (schedule.mode === 'slots') {
    return uniqueSortedDates(
      schedule.slots.map((slot) => parseScheduleDate(slot, 'slot')),
      fromMs,
      toMs,
    );
  }

  return expandRecurrenceSchedule(schedule, {
    fromMs,
    toMs,
    existingCount,
    maxResults: options.maxResults,
  });
}

function expandRecurrenceSchedule(
  schedule: Extract<PublicationScheduleInput, { mode: 'recurrence' }>,
  window: {
    fromMs: number;
    toMs: number;
    existingCount: number;
    maxResults?: number;
  },
): Date[] {
  assertRecurrenceShape(schedule);

  const startsAt = schedule.startsAt ? parseScheduleDate(schedule.startsAt, 'startsAt') : null;
  const endsAt = schedule.endsAt ? parseScheduleDate(schedule.endsAt, 'endsAt') : null;
  const startsAtMs = startsAt?.getTime() ?? window.fromMs;
  const endsAtMs = endsAt?.getTime() ?? window.toMs;

  if (endsAt && endsAtMs < startsAtMs) {
    throw new RangeError('Publication recurrence must end after it starts.');
  }

  const effectiveFromMs = Math.max(window.fromMs, startsAtMs);
  const effectiveToMs = Math.min(window.toMs, endsAtMs);
  if (effectiveToMs < effectiveFromMs) {
    return [];
  }

  const remainingOccurrences = Math.min(
    window.maxResults ?? Number.POSITIVE_INFINITY,
    schedule.maxOccurrences === null
      ? Number.POSITIVE_INFINITY
      : Math.max(0, schedule.maxOccurrences - window.existingCount),
  );
  if (remainingOccurrences === 0) {
    return [];
  }

  const timezone = schedule.timezone;
  const anchor = DateTime.fromMillis(startsAtMs, { zone: timezone });
  const localDay = (ms: number) =>
    DateTime.fromMillis(ms, { zone: timezone }).startOf('day').setZone('UTC', {
      keepLocalTime: true,
    });
  const firstDay = localDay(effectiveFromMs);
  const lastDay = localDay(effectiveToMs);
  const times = schedule.times.map(parseLocalTime).sort(compareLocalTimes);
  const result: Date[] = [];
  const seen = new Set<number>();

  for (const day of recurrenceDays(schedule, firstDay, lastDay, anchor)) {
    for (const time of times) {
      const candidate = resolveLocalDateTime(day, time.hour, time.minute, timezone);
      if (!candidate) {
        continue;
      }

      const candidateMs = candidate.toMillis();
      if (candidateMs < effectiveFromMs || candidateMs > effectiveToMs || seen.has(candidateMs)) {
        continue;
      }

      seen.add(candidateMs);
      result.push(candidate.toJSDate());
      if (result.length >= remainingOccurrences) {
        return result;
      }
    }
  }

  return result;
}

function* recurrenceDays(
  schedule: Extract<PublicationScheduleInput, { mode: 'recurrence' }>,
  firstDay: DateTime,
  lastDay: DateTime,
  anchor: DateTime,
): Generator<DateTime> {
  if (schedule.frequency === 'daily') {
    const elapsed = localDateOrdinal(firstDay) - localDateOrdinal(anchor);
    const daysUntilMatch = (schedule.interval - (elapsed % schedule.interval)) % schedule.interval;
    for (
      let day = firstDay.plus({ days: daysUntilMatch });
      localDayIsOnOrBefore(day, lastDay);
      day = day.plus({ days: schedule.interval })
    ) {
      yield day;
    }
    return;
  }
  const firstWeek = firstDay.startOf('week');
  const elapsed = (localDateOrdinal(firstWeek) - localDateOrdinal(anchor.startOf('week'))) / 7;
  const weeksUntilMatch = (schedule.interval - (elapsed % schedule.interval)) % schedule.interval;
  const weekdays = [...new Set(schedule.weekdays)].sort((left, right) => left - right);
  for (
    let week = firstWeek.plus({ weeks: weeksUntilMatch });
    localDayIsOnOrBefore(week, lastDay);
    week = week.plus({ weeks: schedule.interval })
  ) {
    for (const weekday of weekdays) {
      const day = week.plus({ days: weekday - 1 });
      if (localDayIsOnOrBefore(firstDay, day) && localDayIsOnOrBefore(day, lastDay)) yield day;
    }
  }
}

export function findNextPublicationRecurrenceSlot(
  schedule: Extract<PublicationScheduleInput, { mode: 'recurrence' }>,
  from: Date,
  existingCount = 0,
): Date | null {
  const startsAt = schedule.startsAt ? new Date(schedule.startsAt) : from;
  const searchFrom = startsAt > from ? startsAt : from;
  const lookaheadEnd = new Date(searchFrom.getTime() + PUBLICATION_RECURRENCE_LOOKAHEAD_MS);
  const endsAt = schedule.endsAt ? new Date(schedule.endsAt) : null;
  const searchTo = endsAt && endsAt < lookaheadEnd ? endsAt : lookaheadEnd;
  if (searchTo < searchFrom) return null;
  return (
    expandPublicationSchedule(schedule, {
      from: searchFrom,
      to: searchTo,
      existingCount,
      maxResults: 1,
    })[0] ?? null
  );
}

function assertRecurrenceShape(
  schedule: Extract<PublicationScheduleInput, { mode: 'recurrence' }>,
): void {
  if (!Number.isInteger(schedule.interval) || schedule.interval < 1) {
    throw new RangeError('Publication recurrence interval must be a positive integer.');
  }
  if (schedule.times.length === 0) {
    throw new RangeError('Publication recurrence must contain at least one local time.');
  }
  if (
    schedule.frequency === 'weekly' &&
    (schedule.weekdays.length === 0 ||
      schedule.weekdays.some((weekday) => !Number.isInteger(weekday) || weekday < 1 || weekday > 7))
  ) {
    throw new RangeError('Weekly publication recurrence must contain ISO weekdays from 1 to 7.');
  }
  if (
    schedule.maxOccurrences !== null &&
    (!Number.isInteger(schedule.maxOccurrences) || schedule.maxOccurrences < 1)
  ) {
    throw new RangeError('maxOccurrences must be a positive integer or null.');
  }
}

function resolveLocalDateTime(
  day: DateTime,
  hour: number,
  minute: number,
  timezone: string,
): DateTime | null {
  const candidate = DateTime.fromObject(
    {
      year: day.year,
      month: day.month,
      day: day.day,
      hour,
      minute,
      second: 0,
      millisecond: 0,
    },
    { zone: timezone },
  );

  // Luxon advances nonexistent spring-forward wall times. They are skipped instead.
  if (
    !candidate.isValid ||
    candidate.year !== day.year ||
    candidate.month !== day.month ||
    candidate.day !== day.day ||
    candidate.hour !== hour ||
    candidate.minute !== minute
  ) {
    return null;
  }

  // A repeated fall-back wall time represents one publication, at the earlier UTC instant.
  return candidate
    .getPossibleOffsets()
    .reduce((earliest, possible) =>
      possible.toMillis() < earliest.toMillis() ? possible : earliest,
    );
}

function parseLocalTime(value: string): { hour: number; minute: number } {
  const match = /^(?:([01]\d|2[0-3])):([0-5]\d)$/u.exec(value);
  if (!match) {
    throw new RangeError(`Invalid publication local time: ${value}`);
  }
  return {
    hour: Number(match[1]),
    minute: Number(match[2]),
  };
}

function compareLocalTimes(
  left: { hour: number; minute: number },
  right: { hour: number; minute: number },
): number {
  return left.hour * 60 + left.minute - (right.hour * 60 + right.minute);
}

function parseScheduleDate(value: string, field: string): Date {
  const parsed = DateTime.fromISO(value, { setZone: true });
  if (!parsed.isValid) {
    throw new RangeError(`Invalid publication schedule ${field}: ${value}`);
  }
  return parsed.toJSDate();
}

function readDate(value: Date, field: string): number {
  const timestamp = value instanceof Date ? value.getTime() : Number.NaN;
  if (!Number.isFinite(timestamp)) {
    throw new RangeError(`Invalid publication schedule ${field}.`);
  }
  return timestamp;
}

function uniqueSortedDates(values: readonly Date[], fromMs: number, toMs: number): Date[] {
  const timestamps = new Set<number>();
  for (const value of values) {
    const timestamp = readDate(value, 'date');
    if (timestamp >= fromMs && timestamp <= toMs) {
      timestamps.add(timestamp);
    }
  }
  return [...timestamps]
    .sort((left, right) => left - right)
    .map((timestamp) => new Date(timestamp));
}

function localDateOrdinal(value: DateTime): number {
  return Math.floor(Date.UTC(value.year, value.month - 1, value.day) / 86_400_000);
}

function localDayIsOnOrBefore(left: DateTime, right: DateTime): boolean {
  return localDateOrdinal(left) <= localDateOrdinal(right);
}
