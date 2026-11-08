import { readMaxActionScheduleClock } from './max-action-schedule-clock';

describe('observational action schedule admission', () => {
  it.each([
    '2026-02-30T00:00:00.000Z',
    '2025-02-29T00:00:00.000Z',
    '0000-01-01T00:00:00.000Z',
    '2026-11-08T24:00:00.000Z',
    '2026-11-08T00:00:60.000Z',
    '2026-11-08T00:00:00+01:00',
    '2026-11-08',
    'infinity',
    '2026-11-08T00:00:00.000Z\n',
    '2026-11-08T00:00:00.000Z\r',
    '',
    '2'.repeat(81),
    42,
    {},
    [],
  ])('keeps malformed schedule %p unknown instead of treating it as unscheduled', (value) => {
    expect(readMaxActionScheduleClock(value)).toEqual({
      scheduleClockState: 'INVALID',
      scheduledForAt: null,
    });
  });
  it.each([undefined, null])('admits absent %p as unscheduled', (value) => {
    expect(readMaxActionScheduleClock(value)).toEqual({
      scheduleClockState: 'UNSCHEDULED',
      scheduledForAt: null,
    });
  });
  it.each([
    ['2024-02-29T00:00:00Z', '2024-02-29T00:00:00.000Z'],
    ['2026-11-08T19:00:00.1Z', '2026-11-08T19:00:00.100Z'],
    ['0001-01-01T00:00:00.001Z', '0001-01-01T00:00:00.001Z'],
  ])('admits strict UTC calendar %s', (value, canonical) => {
    expect(readMaxActionScheduleClock(value)).toEqual({
      scheduleClockState: 'VALID',
      scheduledForAt: new Date(canonical),
    });
  });
});
