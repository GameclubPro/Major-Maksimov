import assert from 'node:assert/strict';
import test from 'node:test';
import {
  parseExactTimePart,
  shiftExactTimePart,
} from '../src/components/ui/time-field-exact-model';
import {
  normalizeBroadcastPlannerTimeMinutes,
  getCommonSelectedMinutesForDays,
} from '../src/lib/broadcast-planner-time';
import { buildBroadcastScheduleSlotIso } from '../src/lib/broadcast-schedule';
import { parsePublicationScheduleField } from '../src/features/publications/publication-schedule-fields';
import {
  buildPublicationSchedule,
  createEmptyPublicationDraft,
} from '../src/features/publications/publication-model';

test('exact time input accepts every minute without rounding or coercing invalid text', () => {
  for (let value = 0; value < 60; value++) {
    assert.equal(parseExactTimePart(String(value).padStart(2, '0'), 59), value);
    assert.equal(parseExactTimePart(String(value), 23), value < 24 ? value : null);
  }
  for (const value of ['', ' ', '-1', '1.5', '1e1', ' 9', '60', '100', 'NaN']) {
    assert.equal(parseExactTimePart(value, 59), null);
  }
});

test('time steppers wrap inside their own part and never replace an invalid draft', () => {
  assert.equal(shiftExactTimePart('23', 1, 23), '00');
  assert.equal(shiftExactTimePart('00', -1, 23), '23');
  assert.equal(shiftExactTimePart('59', 1, 59), '00');
  assert.equal(shiftExactTimePart('', 1, 59), null);
});

test('Publisher calendar preserves exact minutes while legacy callers retain their half-hour grid', () => {
  assert.equal(normalizeBroadcastPlannerTimeMinutes(557, 1), 557);
  assert.equal(normalizeBroadcastPlannerTimeMinutes(1439, 1), 1439);
  assert.equal(normalizeBroadcastPlannerTimeMinutes(557), 570);
  const days = ['2030-01-01', '2030-01-02'];
  const slots = days.flatMap((day) =>
    [557, 1439].map((minute) => buildBroadcastScheduleSlotIso(day, minute)),
  );
  assert.deepEqual(getCommonSelectedMinutesForDays(days, slots, 1), [557, 1439]);
  assert.deepEqual(getCommonSelectedMinutesForDays(days, slots), [570, 1410]);
});

test('exact publication input round-trips in the saved timezone', () => {
  assert.equal(
    parsePublicationScheduleField('2030-01-01T09:17', 'Europe/Moscow'),
    '2030-01-01T06:17:00.000Z',
  );
  assert.equal(
    parsePublicationScheduleField('2030-01-01T23:59', 'Asia/Kathmandu'),
    '2030-01-01T18:14:00.000Z',
  );
});

test('all Publisher schedule payloads preserve exact user-selected minutes', () => {
  const draft = createEmptyPublicationDraft();
  const at = '2030-01-01T06:17:00.000Z';
  draft.timingMode = 'once';
  draft.scheduleTimezone = 'Europe/Moscow';
  draft.onceDate = '2030-01-01';
  draft.onceTime = '09:17';
  draft.onceAt = at;
  const calendarSlot = '2030-01-01T06:19:00.000Z';
  draft.scheduledSlots = [calendarSlot];
  assert.equal((buildPublicationSchedule(draft) as { at: string }).at, at);
  draft.timingMode = 'schedule';
  draft.scheduleKind = 'slots';
  assert.deepEqual((buildPublicationSchedule(draft) as { slots: string[] }).slots, [calendarSlot]);
  draft.scheduleKind = 'recurrence';
  draft.recurrence.times = ['09:17', '23:59'];
  assert.deepEqual((buildPublicationSchedule(draft) as { times: string[] }).times, [
    '09:17',
    '23:59',
  ]);
});
