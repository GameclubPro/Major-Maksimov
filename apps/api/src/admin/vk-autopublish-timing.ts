import {
  resolveVkParsingSourceSpacingMinutes,
  VK_PARSING_MIN_SOURCE_SPACING_MINUTES,
} from '@maxim/contracts/vk-parsing';
import { DateTime, IANAZone } from 'luxon';

export const VK_AUTOPUBLISH_DEFAULT_TIMEZONE = 'Europe/Moscow';
export const VK_AUTOPUBLISH_MIN_SOURCE_SPACING_MS = VK_PARSING_MIN_SOURCE_SPACING_MINUTES * 60_000;
export const VK_AUTOPUBLISH_CHAT_SLOT_CLEARANCE_MS = 60_000;

const DEFAULT_DAILY_LIMIT = 3;
const DEFAULT_WORK_HOURS_START = '09:00';
const DEFAULT_WORK_HOURS_END = '22:00';
const ALLOWED_SLOT_LOOKAHEAD_MINUTES = 8 * 24 * 60;

export type VkAutoPublishTimingSettings = {
  schedulerTimezone?: string | null;
  workHoursStart?: string | null;
  workHoursEnd?: string | null;
  quietHoursStart?: string | null;
  quietHoursEnd?: string | null;
  distributeEvenlyEnabled: boolean;
  roundRobinEnabled: boolean;
};

export type VkAutoPublishTimingSource = {
  publishIntervalMinutes?: number | null;
  dailyLimit?: number | null;
  minPublishIntervalMinutes?: number | null;
  quietHoursStart?: string | null;
  quietHoursEnd?: string | null;
};

export type VkAutoPublishLocalDayRange = {
  timezone: string;
  start: Date;
  end: Date;
};

export type PlanVkAutoPublishSourceSlotsOptions = {
  count: number;
  now: Date;
  lastSourceAt?: Date | null;
  existingChatSlots?: readonly Date[];
  existingSourceQuotaSlots?: readonly Date[];
  currentLocalDayPublishedCount?: number;
  currentLocalDayPublishedAt?: Date;
  settings: VkAutoPublishTimingSettings;
  source: VkAutoPublishTimingSource;
  chatSlotClearanceMs?: number;
  sourceSpacingMsOverride?: number;
};

export type ProjectVkAutoPublishSourceQuotaSlotsOptions = Omit<
  PlanVkAutoPublishSourceSlotsOptions,
  'count' | 'existingChatSlots' | 'existingSourceQuotaSlots' | 'chatSlotClearanceMs'
> & {
  slots: readonly Date[];
};

type ParsedDailyRange = {
  startMinute: number;
  endMinute: number;
};

export function isValidVkAutoPublishTimezone(value: unknown): value is string {
  return typeof value === 'string' && IANAZone.isValidZone(value.trim());
}

export function normalizeVkAutoPublishTimezone(
  value: unknown,
  fallback: string = VK_AUTOPUBLISH_DEFAULT_TIMEZONE,
): string {
  const normalizedFallback = isValidVkAutoPublishTimezone(fallback)
    ? fallback.trim()
    : VK_AUTOPUBLISH_DEFAULT_TIMEZONE;
  return isValidVkAutoPublishTimezone(value) ? value.trim() : normalizedFallback;
}

export function getVkAutoPublishLocalDayRange(
  at: Date,
  timezone: unknown,
): VkAutoPublishLocalDayRange {
  const timestamp = readDate(at, 'at');
  const normalizedTimezone = normalizeVkAutoPublishTimezone(timezone);
  const start = DateTime.fromMillis(timestamp, { zone: normalizedTimezone }).startOf('day');

  return {
    timezone: normalizedTimezone,
    start: start.toJSDate(),
    end: start.plus({ days: 1 }).toJSDate(),
  };
}

export function resolveVkAutoPublishSourceSpacingMs(
  settings: Pick<VkAutoPublishTimingSettings, 'distributeEvenlyEnabled'>,
  source: Pick<VkAutoPublishTimingSource, 'publishIntervalMinutes' | 'minPublishIntervalMinutes'>,
): number {
  return resolveVkParsingSourceSpacingMinutes(settings.distributeEvenlyEnabled, source) * 60_000;
}

export function isVkAutoPublishTimeAllowed(
  at: Date,
  settings: Pick<
    VkAutoPublishTimingSettings,
    'schedulerTimezone' | 'workHoursStart' | 'workHoursEnd' | 'quietHoursStart' | 'quietHoursEnd'
  >,
  source: Pick<VkAutoPublishTimingSource, 'quietHoursStart' | 'quietHoursEnd'>,
): boolean {
  const timestamp = readDate(at, 'at');
  const timezone = normalizeVkAutoPublishTimezone(settings.schedulerTimezone);
  const local = DateTime.fromMillis(timestamp, { zone: timezone });
  const minute = local.hour * 60 + local.minute;
  const windows = parseScheduleWindows(settings, source);

  return isMinuteAllowed(minute, windows);
}

export function resolveNextAllowedVkAutoPublishAt(
  candidate: Date,
  settings: Pick<
    VkAutoPublishTimingSettings,
    'schedulerTimezone' | 'workHoursStart' | 'workHoursEnd' | 'quietHoursStart' | 'quietHoursEnd'
  >,
  source: Pick<VkAutoPublishTimingSource, 'quietHoursStart' | 'quietHoursEnd'>,
): Date | null {
  const candidateMs = readDate(candidate, 'candidate');
  const timezone = normalizeVkAutoPublishTimezone(settings.schedulerTimezone);
  const windows = parseScheduleWindows(settings, source);
  const initial = DateTime.fromMillis(candidateMs, { zone: timezone });

  if (isMinuteAllowed(initial.hour * 60 + initial.minute, windows)) {
    return new Date(candidateMs);
  }
  if (!hasAnyAllowedMinute(windows)) {
    return null;
  }

  let cursor = initial.startOf('minute');
  if (cursor.toMillis() < candidateMs) {
    cursor = cursor.plus({ minutes: 1 });
  }

  for (let index = 0; index <= ALLOWED_SLOT_LOOKAHEAD_MINUTES; index += 1) {
    if (isMinuteAllowed(cursor.hour * 60 + cursor.minute, windows)) {
      return cursor.toJSDate();
    }
    cursor = cursor.plus({ minutes: 1 });
  }

  return null;
}

export function planVkAutoPublishSourceSlots(options: PlanVkAutoPublishSourceSlotsOptions): Date[] {
  if (!Number.isInteger(options.count) || options.count < 0) {
    throw new RangeError('VK autopublish slot count must be a non-negative integer.');
  }
  if (options.count === 0) {
    return [];
  }

  const nowMs = readDate(options.now, 'now');
  const lastSourceMs = options.lastSourceAt ? readDate(options.lastSourceAt, 'lastSourceAt') : null;
  const spacingMs =
    options.sourceSpacingMsOverride === undefined
      ? resolveVkAutoPublishSourceSpacingMs(options.settings, options.source)
      : readNonNegativeNumber(options.sourceSpacingMsOverride, 'sourceSpacingMsOverride');
  const clearanceMs = readClearance(options.chatSlotClearanceMs);
  const timezone = normalizeVkAutoPublishTimezone(options.settings.schedulerTimezone);
  const dailyLimit = readPositiveInteger(options.source.dailyLimit, DEFAULT_DAILY_LIMIT);
  const quotaUsage = buildQuotaUsage(
    nowMs,
    timezone,
    options.currentLocalDayPublishedCount,
    options.currentLocalDayPublishedAt,
    options.existingSourceQuotaSlots ?? [],
  );
  const occupiedMs = options.settings.roundRobinEnabled
    ? readDates(options.existingChatSlots ?? [], 'existingChatSlots').sort(
        (left, right) => left - right,
      )
    : [];
  const slots: Date[] = [];
  let earliestMs = lastSourceMs === null ? nowMs : Math.max(nowMs, lastSourceMs + spacingMs);

  for (let index = 0; index < options.count; index += 1) {
    const slot = resolveCollisionFreeAllowedSlot(
      earliestMs,
      occupiedMs,
      clearanceMs,
      options.settings,
      options.source,
      { dailyLimit, timezone, usage: quotaUsage },
    );
    if (!slot) {
      throw new RangeError('VK autopublish timing rules do not contain an available slot.');
    }

    slots.push(slot);
    if (options.settings.roundRobinEnabled) {
      insertSortedNumber(occupiedMs, slot.getTime());
    }
    incrementQuotaUsage(quotaUsage, resolveLocalDayKey(slot.getTime(), timezone));
    earliestMs = slot.getTime() + spacingMs;
  }

  return slots;
}

export function projectVkAutoPublishSourceQuotaSlots(
  options: ProjectVkAutoPublishSourceQuotaSlotsOptions,
): Date[] {
  if (options.slots.length === 0) {
    return [];
  }

  const nowMs = readDate(options.now, 'now');
  const timezone = normalizeVkAutoPublishTimezone(options.settings.schedulerTimezone);
  const dailyLimit = readPositiveInteger(options.source.dailyLimit, DEFAULT_DAILY_LIMIT);
  const spacingMs =
    options.sourceSpacingMsOverride === undefined
      ? resolveVkAutoPublishSourceSpacingMs(options.settings, options.source)
      : readNonNegativeNumber(options.sourceSpacingMsOverride, 'sourceSpacingMsOverride');
  const quotaUsage = buildQuotaUsage(
    nowMs,
    timezone,
    options.currentLocalDayPublishedCount,
    options.currentLocalDayPublishedAt,
    [],
  );
  const sourceSlots = readDates(options.slots, 'slots').sort((left, right) => left - right);
  const projected: Date[] = [];
  let previousMs = options.lastSourceAt ? readDate(options.lastSourceAt, 'lastSourceAt') : null;

  for (const sourceSlotMs of sourceSlots) {
    const earliestMs = Math.max(
      nowMs,
      sourceSlotMs,
      previousMs === null ? Number.NEGATIVE_INFINITY : previousMs + spacingMs,
    );
    const slot = resolveCollisionFreeAllowedSlot(
      earliestMs,
      [],
      0,
      options.settings,
      options.source,
      { dailyLimit, timezone, usage: quotaUsage },
    );
    if (!slot) {
      throw new RangeError('VK autopublish timing rules do not contain an available quota slot.');
    }

    projected.push(slot);
    incrementQuotaUsage(quotaUsage, resolveLocalDayKey(slot.getTime(), timezone));
    previousMs = slot.getTime();
  }

  return projected;
}

function resolveCollisionFreeAllowedSlot(
  earliestMs: number,
  occupiedMs: readonly number[],
  clearanceMs: number,
  settings: PlanVkAutoPublishSourceSlotsOptions['settings'],
  source: PlanVkAutoPublishSourceSlotsOptions['source'],
  quota: { dailyLimit: number; timezone: string; usage: Map<string, number> },
): Date | null {
  let candidateMs = earliestMs;
  const attemptLimit = occupiedMs.length + quota.usage.size + 2;

  for (let attempt = 0; attempt <= attemptLimit; attempt += 1) {
    const allowed = resolveNextAllowedVkAutoPublishAt(new Date(candidateMs), settings, source);
    if (!allowed) {
      return null;
    }
    const quotaDayKey = resolveLocalDayKey(allowed.getTime(), quota.timezone);
    if ((quota.usage.get(quotaDayKey) ?? 0) >= quota.dailyLimit) {
      candidateMs = resolveNextLocalDayStartMs(allowed.getTime(), quota.timezone);
      continue;
    }

    const nextCollisionFreeMs = advancePastChatSlotCollisions(
      allowed.getTime(),
      occupiedMs,
      clearanceMs,
    );
    if (nextCollisionFreeMs === allowed.getTime()) {
      return allowed;
    }
    candidateMs = nextCollisionFreeMs;
  }

  return null;
}

function buildQuotaUsage(
  nowMs: number,
  timezone: string,
  currentLocalDayPublishedCount: number | undefined,
  currentLocalDayPublishedAt: Date | undefined,
  existingSourceQuotaSlots: readonly Date[],
): Map<string, number> {
  const usage = new Map<string, number>();
  const publishedCount = readNonNegativeInteger(
    currentLocalDayPublishedCount,
    'currentLocalDayPublishedCount',
  );
  if (publishedCount > 0) {
    const publishedDayMs = currentLocalDayPublishedAt
      ? readDate(currentLocalDayPublishedAt, 'currentLocalDayPublishedAt')
      : nowMs;
    usage.set(resolveLocalDayKey(publishedDayMs, timezone), publishedCount);
  }
  for (const slotMs of readDates(existingSourceQuotaSlots, 'existingSourceQuotaSlots')) {
    incrementQuotaUsage(usage, resolveLocalDayKey(slotMs, timezone));
  }
  return usage;
}

function incrementQuotaUsage(usage: Map<string, number>, dayKey: string): void {
  usage.set(dayKey, (usage.get(dayKey) ?? 0) + 1);
}

function resolveLocalDayKey(timestamp: number, timezone: string): string {
  return DateTime.fromMillis(timestamp, { zone: timezone }).toISODate()!;
}

function resolveNextLocalDayStartMs(timestamp: number, timezone: string): number {
  return DateTime.fromMillis(timestamp, { zone: timezone })
    .startOf('day')
    .plus({ days: 1 })
    .toMillis();
}

function advancePastChatSlotCollisions(
  candidateMs: number,
  occupiedMs: readonly number[],
  clearanceMs: number,
): number {
  let resultMs = candidateMs;

  for (const occupiedAtMs of occupiedMs) {
    if (occupiedAtMs <= resultMs - clearanceMs) {
      continue;
    }
    if (occupiedAtMs >= resultMs + clearanceMs) {
      break;
    }
    resultMs = occupiedAtMs + clearanceMs;
  }

  return resultMs;
}

function insertSortedNumber(values: number[], value: number): void {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (values[middle]! <= value) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  values.splice(low, 0, value);
}

function parseScheduleWindows(
  settings: Pick<
    VkAutoPublishTimingSettings,
    'workHoursStart' | 'workHoursEnd' | 'quietHoursStart' | 'quietHoursEnd'
  >,
  source: Pick<VkAutoPublishTimingSource, 'quietHoursStart' | 'quietHoursEnd'>,
): {
  work: ParsedDailyRange;
  globalQuiet: ParsedDailyRange | null;
  sourceQuiet: ParsedDailyRange | null;
} {
  const workStartMinute = parseTimeOfDay(settings.workHoursStart);
  const workEndMinute = parseTimeOfDay(settings.workHoursEnd);
  return {
    work:
      workStartMinute === null || workEndMinute === null
        ? {
            startMinute: parseTimeOfDay(DEFAULT_WORK_HOURS_START)!,
            endMinute: parseTimeOfDay(DEFAULT_WORK_HOURS_END)!,
          }
        : { startMinute: workStartMinute, endMinute: workEndMinute },
    globalQuiet: parseOptionalDailyRange(settings.quietHoursStart, settings.quietHoursEnd),
    sourceQuiet: parseOptionalDailyRange(source.quietHoursStart, source.quietHoursEnd),
  };
}

function parseOptionalDailyRange(
  start: string | null | undefined,
  end: string | null | undefined,
): ParsedDailyRange | null {
  const startMinute = parseTimeOfDay(start);
  const endMinute = parseTimeOfDay(end);
  return startMinute === null || endMinute === null ? null : { startMinute, endMinute };
}

function parseTimeOfDay(value: string | null | undefined): number | null {
  if (typeof value !== 'string') {
    return null;
  }
  const match = /^(?:([01]\d|2[0-3])):([0-5]\d)$/u.exec(value.trim());
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

function isMinuteAllowed(
  minute: number,
  windows: {
    work: ParsedDailyRange;
    globalQuiet: ParsedDailyRange | null;
    sourceQuiet: ParsedDailyRange | null;
  },
): boolean {
  return (
    isMinuteInRange(minute, windows.work) &&
    !(windows.globalQuiet && isMinuteInRange(minute, windows.globalQuiet)) &&
    !(windows.sourceQuiet && isMinuteInRange(minute, windows.sourceQuiet))
  );
}

function hasAnyAllowedMinute(windows: {
  work: ParsedDailyRange;
  globalQuiet: ParsedDailyRange | null;
  sourceQuiet: ParsedDailyRange | null;
}): boolean {
  for (let minute = 0; minute < 24 * 60; minute += 1) {
    if (isMinuteAllowed(minute, windows)) {
      return true;
    }
  }
  return false;
}

function isMinuteInRange(minute: number, range: ParsedDailyRange): boolean {
  if (range.startMinute === range.endMinute) {
    return true;
  }
  if (range.startMinute < range.endMinute) {
    return minute >= range.startMinute && minute < range.endMinute;
  }
  return minute >= range.startMinute || minute < range.endMinute;
}

function readPositiveInteger(value: number | null | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function readNonNegativeInteger(value: number | undefined, field: string): number {
  if (value === undefined) {
    return 0;
  }
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`VK autopublish ${field} must be a non-negative integer.`);
  }
  return value;
}

function readNonNegativeNumber(value: number, field: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`VK autopublish ${field} must be non-negative.`);
  }
  return value;
}

function readDate(value: Date, field: string): number {
  const timestamp = value instanceof Date ? value.getTime() : Number.NaN;
  if (!Number.isFinite(timestamp)) {
    throw new RangeError(`Invalid VK autopublish ${field} date.`);
  }
  return timestamp;
}

function readDates(values: readonly Date[], field: string): number[] {
  return values.map((value, index) => readDate(value, `${field}[${index}]`));
}

function readClearance(value: number | undefined): number {
  if (value === undefined) {
    return VK_AUTOPUBLISH_CHAT_SLOT_CLEARANCE_MS;
  }
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError('VK autopublish chat slot clearance must be non-negative.');
  }
  return value;
}
