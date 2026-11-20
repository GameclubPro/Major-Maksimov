import assert from 'node:assert/strict';
import test from 'node:test';
import { Settings } from 'luxon';
import { parsePublicationScheduleField } from '../src/features/publications/publication-schedule-fields';
import {
  formatPublicationScheduleField,
  getNextPublicationRecurrenceTime,
} from '../src/features/publications/publication-time-presentation';
import {
  buildPublicationSchedule,
  createEmptyPublicationDraft,
  getPublicationTimingIssue,
} from '../src/features/publications/publication-model';
import {
  formatDraftTiming,
  formatPublicationSchedule,
} from '../src/features/publications/publication-page-formatters';
import type { PublicationSummary } from '@maxim/contracts/publication';

test('one-time validation identifies the missing field and explains the scheduling margin', () => {
  const draft = createEmptyPublicationDraft();
  draft.timingMode = 'once';
  draft.scheduleTimezone = 'Europe/Moscow';
  const now = Date.parse('2030-01-01T06:00:00Z');
  draft.onceTime = '09:17';
  assert.deepEqual(getPublicationTimingIssue(draft, now), {
    field: 'date',
    label: 'Дата',
    message: 'Выберите дату публикации.',
  });
  draft.onceDate = '2030-01-01';
  draft.onceTime = '';
  assert.equal(getPublicationTimingIssue(draft, now)?.message, 'Выберите время публикации.');
  for (const time of ['08:59', '09:00', '09:01']) {
    draft.onceTime = time;
    draft.onceAt = parsePublicationScheduleField(`2030-01-01T${time}`, draft.scheduleTimezone);
    assert.equal(
      getPublicationTimingIssue(draft, now)?.message,
      'Выберите время минимум на 2 минуты позже текущего.',
    );
  }
  draft.onceTime = '09:02';
  draft.onceAt = '2030-01-01T06:02:00.000Z';
  assert.equal(getPublicationTimingIssue(draft, now), null);
  assert.equal(getPublicationTimingIssue(draft, now + 1)?.field, 'time');
});

test('one-time payload and review reject calendar slots that disagree with visible fields', () => {
  const draft = createEmptyPublicationDraft();
  draft.timingMode = 'once';
  draft.scheduleTimezone = 'Asia/Kathmandu';
  draft.onceDate = '2030-01-01';
  draft.onceTime = '23:59';
  draft.onceAt = '2030-02-02T06:00:00.000Z';
  assert.equal((buildPublicationSchedule(draft) as { at: string }).at, '');
  assert.equal(formatDraftTiming(draft), 'Время не выбрано');
  draft.onceAt = '2030-01-01T18:14:00.000Z';
  assert.deepEqual(buildPublicationSchedule(draft), {
    mode: 'once',
    timezone: 'Asia/Kathmandu',
    at: '2030-01-01T18:14:00.000Z',
    replaceConflicts: false,
    latePolicy: { mode: 'recover', maxDelayMinutes: 1440, catchUp: 'latest' },
  });
  assert.match(formatDraftTiming(draft), /1 янв., 23:59/u);
  draft.onceDate = '';
  assert.equal((buildPublicationSchedule(draft) as { at: string }).at, '');
  assert.equal(formatDraftTiming(draft), 'Время не выбрано');
});

test('one-time validation rejects a nonexistent time without sending a cached slot', () => {
  const draft = createEmptyPublicationDraft();
  draft.timingMode = 'once';
  draft.scheduleTimezone = 'Europe/Berlin';
  draft.onceDate = '2030-03-31';
  draft.onceTime = '02:30';
  draft.onceAt = '2030-03-31T02:30:00.000Z';
  assert.match(
    getPublicationTimingIssue(draft, Date.parse('2030-01-01'))!.message,
    /Заново выберите дату и время/u,
  );
  assert.equal((buildPublicationSchedule(draft) as { at: string }).at, '');
});

test('single calendar slot keeps the saved zone in the final review', () => {
  const draft = createEmptyPublicationDraft();
  draft.timingMode = 'schedule';
  draft.scheduleKind = 'slots';
  draft.scheduleTimezone = 'Asia/Vladivostok';
  draft.scheduledSlots = ['2030-01-01T10:00:00.000Z'];
  assert.match(formatDraftTiming(draft), /20:00/u);
});

test('immediate history shows an honestly labeled creation date instead of now', () => {
  const publication = {
    lifecycle: 'COMPLETED',
    createdAt: '2030-01-01T10:00:00.000Z',
    schedule: { mode: 'now', timezone: 'Asia/Vladivostok' },
  } as PublicationSummary;
  assert.match(formatPublicationSchedule(publication), /^Создано .*20:00/u);
});

test('publication date input round-trips in its saved zone instead of the device zone', () => {
  const local = formatPublicationScheduleField('2026-09-08T21:00:00Z', 'Asia/Vladivostok');
  assert.equal(local, '2026-09-09T07:00');
  assert.equal(
    parsePublicationScheduleField(local, 'Asia/Vladivostok'),
    '2026-09-08T21:00:00.000Z',
  );
  assert.equal(
    parsePublicationScheduleField('2026-09-09T00:00', 'Asia/Vladivostok'),
    '2026-09-08T14:00:00.000Z',
  );
});

test('publication schedule rejects malformed dates and DST gaps', () => {
  for (const value of ['', '2026-02-30T09:00', '2026-03-29T02:30']) {
    assert.equal(parsePublicationScheduleField(value, 'Europe/Berlin'), null);
  }
  assert.equal(formatPublicationScheduleField('invalid', 'UTC'), '');
  assert.equal(parsePublicationScheduleField('2026-09-08T09:00', 'Invalid/Zone'), null);
});

test('one-time DST overlap chooses the earlier instant regardless of the current season', () => {
  const originalNow = Settings.now;
  try {
    for (const now of ['2026-07-01T00:00:00Z', '2026-12-01T00:00:00Z']) {
      Settings.now = () => Date.parse(now);
      assert.equal(
        parsePublicationScheduleField('2030-10-27T02:30', 'Europe/Berlin'),
        '2030-10-27T00:30:00.000Z',
      );
    }
  } finally {
    Settings.now = originalNow;
  }
});

test('adding recurrence times skips duplicates and wraps around midnight', () => {
  assert.equal(getNextPublicationRecurrenceTime(['09:17']), '10:17');
  assert.equal(getNextPublicationRecurrenceTime(['09:17', '10:32']), '11:47');
  assert.equal(getNextPublicationRecurrenceTime(['23:17', '00:47']), '02:17');
  assert.equal(getNextPublicationRecurrenceTime(['00:00', '12:00']), '13:00');
  assert.equal(getNextPublicationRecurrenceTime(['17:30', '18:00']), '18:30');
  assert.equal(getNextPublicationRecurrenceTime(['00:00', '23:30']), '00:30');
  let times = ['09:00'];
  for (let index = 1; index < 12; index += 1)
    times = [...times, getNextPublicationRecurrenceTime(times)];
  assert.equal(new Set(times).size, 12);
});

test('weekly schedule summary includes selected weekdays, sorted times and the occurrence limit', () => {
  const draft = createEmptyPublicationDraft();
  draft.timingMode = 'schedule';
  draft.scheduleKind = 'recurrence';
  draft.recurrence = {
    frequency: 'weekly',
    interval: 2,
    weekdays: [1, 5],
    times: ['18:00', '09:00'],
    startsAt: '2026-09-01T00:00:00Z',
    endsAt: null,
    maxOccurrences: 12,
  };
  assert.match(formatDraftTiming(draft), /Пн, Пт/u);
  assert.match(formatDraftTiming(draft), /09:00, 18:00/u);
  assert.match(formatDraftTiming(draft), /12 запусков/u);
});
