export type MaxActionScheduleClock = {
  scheduleClockState: 'UNSCHEDULED' | 'VALID' | 'INVALID';
  scheduledForAt: Date | null;
};

// FLAG: This is observational schedule admission, never permission to execute.
// Reject calendar normalization and non-UTC input rather than invent readiness.
export function parseMaxActionScheduleUtc(value: unknown): Date | null {
  if (typeof value !== 'string' || value.length > 80) return null;
  const match =
    /^(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])T([01]\d|2[0-3]):([0-5]\d):([0-5]\d)(?:\.(\d{1,3}))?Z$/.exec(
      value,
    );
  if (!match || match[0] !== value || match[1] === '0000') return null;
  const canonical = `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}.${(match[7] ?? '').padEnd(3, '0')}Z`;
  const parsed = new Date(canonical);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === canonical ? parsed : null;
}

export function readMaxActionScheduleClock(value: unknown): MaxActionScheduleClock {
  if (value == null) return { scheduleClockState: 'UNSCHEDULED', scheduledForAt: null };
  const scheduledForAt = parseMaxActionScheduleUtc(value);
  return { scheduleClockState: scheduledForAt ? 'VALID' : 'INVALID', scheduledForAt };
}
