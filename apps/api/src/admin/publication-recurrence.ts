import type {
  PublicationScheduleInput,
  PublicationSchedulePreviewResponse,
} from '@maxim/contracts/publication';
import { DateTime, IANAZone } from 'luxon';

export const PUBLICATION_RECURRENCE_HORIZON_MS = 14 * 24 * 60 * 60_000;
const PUBLICATION_RECURRENCE_LOOKAHEAD_MS = 450 * 24 * 60 * 60_000;
const PUBLICATION_PREVIEW_MAX_CANDIDATES = 4_096;
const PUBLICATION_PREVIEW_LAST_TIMESTAMP = Date.parse('9999-12-31T23:59:59.999Z');
type Recurrence = Extract<PublicationScheduleInput, { mode: 'recurrence' }>;

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

  const result: Date[] = [];
  const seen = new Set<number>();
  for (const candidate of recurrenceCandidates(
    schedule,
    startsAtMs,
    effectiveFromMs,
    effectiveToMs,
    1,
  )) {
    if (candidate === null || seen.has(candidate)) continue;
    seen.add(candidate);
    result.push(new Date(candidate));
    if (result.length >= remainingOccurrences) break;
  }
  return result;
}

function* recurrenceCandidates(
  schedule: Recurrence,
  startsAtMs: number,
  effectiveFromMs: number,
  effectiveToMs: number,
  direction: 1 | -1,
): Generator<number | null> {
  if (effectiveFromMs > effectiveToMs) return;
  const { timezone } = schedule;
  const anchor = DateTime.fromMillis(startsAtMs, { zone: timezone });
  const localDay = (ms: number) =>
    DateTime.fromMillis(ms, { zone: timezone }).startOf('day').setZone('UTC', {
      keepLocalTime: true,
    });
  const firstDay = localDay(effectiveFromMs);
  const lastDay = localDay(effectiveToMs);
  const times = [...new Set(schedule.times)]
    .map(parseLocalTime)
    .sort((left, right) => compareLocalTimes(left, right) * direction);
  for (const day of recurrenceDays(schedule, firstDay, lastDay, anchor, direction)) {
    for (const time of times) {
      const candidate = resolveLocalDateTime(day, time.hour, time.minute, timezone)?.toMillis();
      yield candidate !== undefined && candidate >= effectiveFromMs && candidate <= effectiveToMs
        ? candidate
        : null;
    }
  }
}

function* recurrenceDays(
  schedule: Extract<PublicationScheduleInput, { mode: 'recurrence' }>,
  firstDay: DateTime,
  lastDay: DateTime,
  anchor: DateTime,
  direction: 1 | -1,
): Generator<DateTime> {
  const fromDay = direction === 1 ? firstDay : lastDay;
  const toDay = direction === 1 ? lastDay : firstDay;
  const within = (day: DateTime) =>
    (localDateOrdinal(day) - localDateOrdinal(toDay)) * direction <= 0;
  const offsetToMatch = (elapsed: number) => {
    const position = ((elapsed % schedule.interval) + schedule.interval) % schedule.interval;
    if (position === 0) return 0;
    return direction === 1 ? schedule.interval - position : -position;
  };
  if (schedule.frequency === 'daily') {
    const elapsed = localDateOrdinal(fromDay) - localDateOrdinal(anchor);
    for (
      let day = fromDay.plus({ days: offsetToMatch(elapsed) });
      within(day);
      day = day.plus({ days: schedule.interval * direction })
    ) {
      yield day;
    }
    return;
  }
  const fromWeek = fromDay.startOf('week');
  const toWeek = toDay.startOf('week');
  const elapsed = (localDateOrdinal(fromWeek) - localDateOrdinal(anchor.startOf('week'))) / 7;
  const weekdays = [...new Set(schedule.weekdays)].sort(
    (left, right) => (left - right) * direction,
  );
  for (
    let week = fromWeek.plus({ weeks: offsetToMatch(elapsed) });
    (localDateOrdinal(week) - localDateOrdinal(toWeek)) * direction <= 0;
    week = week.plus({ weeks: schedule.interval * direction })
  ) {
    for (const weekday of weekdays) {
      const day = week.plus({ days: weekday - 1 });
      if (localDayIsOnOrBefore(firstDay, day) && localDayIsOnOrBefore(day, lastDay)) yield day;
    }
  }
}

export function previewPublicationRecurrence(
  schedule: Recurrence,
  options: {
    from: Date;
    now: Date;
    existingCount?: number;
    firstMaterialized?: Date;
    lastMaterialized?: Date;
    skippedAt?: ReadonlySet<number>;
  },
): PublicationSchedulePreviewResponse {
  const { timezone, maxOccurrences } = schedule;
  const { from, now, existingCount = 0, firstMaterialized, lastMaterialized, skippedAt } = options;
  const unavailable = {
    state: 'unavailable',
    timezone,
    firstOccurrenceAt: null,
    lastOccurrenceAt: null,
  } as const;
  if (!isValidPublicationTimezone(timezone)) return { ...unavailable, timezone: null };
  assertRecurrenceShape(schedule);
  const startsAtMs = schedule.startsAt
    ? parseScheduleDate(schedule.startsAt, 'startsAt').getTime()
    : from.getTime();
  const lower = Math.max(startsAtMs, from.getTime());
  const upper = schedule.endsAt
    ? parseScheduleDate(schedule.endsAt, 'endsAt').getTime()
    : PUBLICATION_PREVIEW_LAST_TIMESTAMP;
  const upcomingAfter = now.getTime();
  const remaining = maxOccurrences === null ? null : Math.max(0, maxOccurrences - existingCount);
  let first = firstMaterialized?.getTime();
  let last = lastMaterialized?.getTime();
  let inspected = 0;

  const include = (candidate: number) => {
    if (candidate < upcomingAfter || skippedAt?.has(candidate)) return;
    first = first === undefined ? candidate : Math.min(first, candidate);
    last = last === undefined ? candidate : Math.max(last, candidate);
  };
  if (remaining !== null && remaining > 0) {
    let consumed = 0;
    for (const candidate of recurrenceCandidates(schedule, startsAtMs, lower, upper, 1)) {
      if (++inspected > PUBLICATION_PREVIEW_MAX_CANDIDATES) return unavailable;
      if (candidate === null) continue;
      include(candidate);
      if (++consumed >= remaining) break;
    }
    if (consumed < remaining && schedule.endsAt === null) return unavailable;
  } else if (remaining === null) {
    const firstUnmaterialized = Math.max(lower, upcomingAfter);
    if (first === undefined) {
      for (const candidate of recurrenceCandidates(
        schedule,
        startsAtMs,
        firstUnmaterialized,
        upper,
        1,
      )) {
        if (++inspected > PUBLICATION_PREVIEW_MAX_CANDIDATES) return unavailable;
        if (candidate === null || skippedAt?.has(candidate)) continue;
        include(candidate);
        break;
      }
    }
    if (first !== undefined && schedule.endsAt !== null) {
      for (const candidate of recurrenceCandidates(
        schedule,
        startsAtMs,
        firstUnmaterialized,
        upper,
        -1,
      )) {
        if (++inspected > PUBLICATION_PREVIEW_MAX_CANDIDATES) return unavailable;
        if (candidate === null || skippedAt?.has(candidate)) continue;
        include(candidate);
        break;
      }
    }
    if (schedule.endsAt === null) {
      return first === undefined
        ? unavailable
        : {
            state: 'unbounded',
            timezone,
            firstOccurrenceAt: new Date(first).toISOString(),
            lastOccurrenceAt: null,
          };
    }
  }

  if (first === undefined || last === undefined) {
    return { state: 'empty', timezone, firstOccurrenceAt: null, lastOccurrenceAt: null };
  }
  return {
    state: 'finite',
    timezone,
    firstOccurrenceAt: new Date(first).toISOString(),
    lastOccurrenceAt: new Date(last).toISOString(),
  };
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

export function expandInitialPublicationSchedule(
  schedule: PublicationScheduleInput,
  now: Date,
): Date[] {
  if (schedule.mode === 'once') {
    return [new Date(schedule.at)];
  }
  if (schedule.mode === 'slots') {
    return [...new Set(schedule.slots.map((slot) => new Date(slot).getTime()))]
      .sort((left, right) => left - right)
      .map((timestamp) => new Date(timestamp));
  }
  if (schedule.mode === 'now') {
    return [now];
  }
  return expandPublicationSchedule(schedule, {
    from: now,
    to: new Date(now.getTime() + PUBLICATION_RECURRENCE_HORIZON_MS),
    existingCount: 0,
    now,
  });
}
