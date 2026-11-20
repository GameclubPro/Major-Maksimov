import assert from 'node:assert/strict';
import test from 'node:test';
import { publicationDetailsSchema } from '@maxim/contracts/publication';
import {
  buildUpdatePublicationRequest,
  canPreservePublicationSchedule,
  createPublicationDraftFromDetails,
  getPublicationTimingIssue,
  type PublicationDraft,
  type PublicationEditorContext,
} from '../src/features/publications/publication-model';
import { buildPublicationSaveRequestKey } from '../src/features/publications/publication-request-identity';
import { formatDraftTiming } from '../src/features/publications/publication-page-formatters';

const nowMs = Date.parse('2030-01-01T10:00:00Z');
const context: PublicationEditorContext = {
  kind: 'edit',
  publicationId: 'saved-publication',
  expectedRevision: 4,
  editScope: 'future',
};

function savedDraft(schedule: Record<string, unknown>): PublicationDraft {
  return createPublicationDraftFromDetails(
    publicationDetailsSchema.parse({
      id: 'saved-publication',
      title: 'Сохраненный пост',
      lifecycle: 'ACTIVE',
      version: 4,
      contentPreview: 'Текст',
      targetCount: 1,
      targetPreviews: [],
      targetOverflowCount: 0,
      audienceSelection: 'SELECTED',
      audienceMode: 'SNAPSHOT',
      mediaCount: 0,
      hasVideo: false,
      schedule: {
        ...schedule,
        timezone: 'UTC',
        status: 'ACTIVE',
        revision: 2,
        nextOccurrenceAt: '2030-01-01T10:01:00Z',
        lastError: null,
      },
      delivery: { total: 0, pending: 0, sent: 0, failed: 0, ambiguous: 0, canceled: 0 },
      createdAt: '2029-12-01T10:00:00Z',
      updatedAt: '2029-12-01T10:00:00Z',
      content: { revision: 4, text: 'Текст', textFormat: 'plain', buttons: [], media: [] },
      targets: [{ chatId: 'target-1', entityType: 'channel', title: 'Канал' }],
      occurrences: [],
    }),
    nowMs,
  );
}

test('content edits preserve persisted slots while the editor hides past dates', () => {
  for (const slots of [
    ['2029-12-31T10:00:00Z', '2030-01-01T10:01:00Z', '2030-01-02T10:00:00Z'],
    ['2029-12-31T10:00:00Z', '2030-01-01T10:01:00Z'],
  ]) {
    const baseline = savedDraft({ mode: 'slots', slots });
    assert.equal(baseline.scheduledSlots.includes('2030-01-01T10:01:00Z'), true);
    assert.equal(baseline.scheduledSlots.includes('2029-12-31T10:00:00Z'), false);
    const changed = { ...baseline, text: 'Исправленный текст' };
    const contentOnly = canPreservePublicationSchedule(context, baseline, changed);
    assert.equal(contentOnly, true);
    const request = buildUpdatePublicationRequest(changed, 4, 'request_id', false, contentOnly);
    assert.equal('schedule' in request, false);
    assert.equal('audience' in request, false);
    assert.equal('intent' in request, false);
    assert.equal(request.content?.text, 'Исправленный текст');
    const key = buildPublicationSaveRequestKey(changed, { ...context, contentOnly }, false);
    assert.deepEqual((key as { payload: unknown }).payload, {
      expectedRevision: request.expectedRevision,
      title: request.title,
      content: request.content,
    });
  }
});

test('an imminent saved slot remains visible instead of showing an empty schedule', () => {
  const draft = savedDraft({ mode: 'slots', slots: ['2030-01-01T10:01:00Z'] });
  assert.match(formatDraftTiming(draft), /10:01/u);
  assert.equal(getPublicationTimingIssue(draft, nowMs)?.field, 'schedule');
  assert.equal(canPreservePublicationSchedule(context, draft, draft), true);
});

test('unchanged imminent once timing can be preserved while new timing still fails the margin', () => {
  const baseline = savedDraft({ mode: 'once', at: '2030-01-01T10:01:00Z' });
  const changed = { ...baseline, title: 'Новое название' };
  assert.equal(canPreservePublicationSchedule(context, baseline, changed), true);
  assert.equal(getPublicationTimingIssue(changed, nowMs)?.field, 'time');
  const changedTime = { ...changed, onceTime: '10:00', onceAt: '2030-01-01T10:00:00Z' };
  assert.equal(canPreservePublicationSchedule(context, baseline, changedTime), false);
  assert.equal(getPublicationTimingIssue(changedTime, nowMs)?.field, 'time');
});

test('audience and actual scheduling changes require a full validated update', () => {
  const baseline = savedDraft({ mode: 'slots', slots: ['2030-01-01T10:01:00Z'] });
  for (const changed of [
    { ...baseline, targets: [] },
    { ...baseline, targets: [{ ...baseline.targets[0]!, id: 'target-2' }] },
    { ...baseline, timingMode: 'now' as const },
    { ...baseline, scheduleTimezone: 'Europe/Moscow' },
    { ...baseline, scheduledSlots: ['2030-01-01T10:02:00Z'] },
    {
      ...baseline,
      latePolicy: { mode: 'recover' as const, maxDelayMinutes: 60, catchUp: 'latest' as const },
    },
  ]) {
    assert.equal(canPreservePublicationSchedule(context, baseline, changed), false);
  }
});

test('recurrence content changes preserve its anchor and limit while recurrence edits do not', () => {
  const baseline = savedDraft({
    mode: 'recurrence',
    frequency: 'daily',
    interval: 2,
    times: ['10:00'],
    startsAt: '2029-12-01T00:00:00Z',
    maxOccurrences: 12,
  });
  assert.equal(
    canPreservePublicationSchedule(context, baseline, { ...baseline, text: 'Правка' }),
    true,
  );
  assert.equal(
    canPreservePublicationSchedule(context, baseline, {
      ...baseline,
      recurrence: { ...baseline.recurrence, maxOccurrences: 13 },
    }),
    false,
  );
});

test('drafts, imports, new posts and explicit schedule repairs retain scheduling validation', () => {
  const baseline = savedDraft({ mode: 'once', at: '2030-01-01T10:01:00Z' });
  for (const other of [
    null,
    { kind: 'create' },
    { kind: 'duplicate' },
    { kind: 'draft', publicationId: 'saved-publication', expectedRevision: 4 },
    { kind: 'import', publicationId: 'saved-publication', expectedRevision: 4, sessionId: null },
    { ...context, editScope: 'schedule' },
  ] satisfies (PublicationEditorContext | null)[]) {
    assert.equal(canPreservePublicationSchedule(other, baseline, baseline), false);
  }
  assert.equal(canPreservePublicationSchedule(context, null, baseline), false);
});
