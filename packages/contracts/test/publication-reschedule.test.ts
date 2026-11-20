import { describe, expect, it } from 'vitest';
import { publicationOccurrenceRescheduleRequestSchema } from '../src/publication';

const action = { requestId: 'move-release-01', expectedRevision: 3 };
const at = '2027-01-04T07:00:00.000Z';
const schedule = {
  mode: 'recurrence',
  timezone: 'Europe/Moscow',
  frequency: 'weekly',
  interval: 2,
  weekdays: [1, 3],
  times: ['10:00', '14:00'],
  startsAt: at,
};

describe('rescheduling a publication occurrence', () => {
  it('keeps a time for an individual move and requires a complete recurrence for a continuation', () => {
    const occurrence = { ...action, scope: 'occurrence', at };
    expect(publicationOccurrenceRescheduleRequestSchema.parse(occurrence)).toEqual(occurrence);
    expect(
      publicationOccurrenceRescheduleRequestSchema.safeParse({
        ...action,
        scope: 'following',
        at,
      }).success,
    ).toBe(false);
    expect(
      publicationOccurrenceRescheduleRequestSchema.parse({
        ...action,
        scope: 'following',
        schedule,
      }),
    ).toMatchObject({ schedule: { ...schedule, replaceConflicts: false } });
  });

  it('does not accept replacement authority for a reschedule', () => {
    expect(
      publicationOccurrenceRescheduleRequestSchema.safeParse({
        ...action,
        scope: 'following',
        schedule: { ...schedule, replaceConflicts: true },
      }).success,
    ).toBe(false);
  });
});
