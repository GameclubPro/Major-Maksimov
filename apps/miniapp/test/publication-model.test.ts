import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildCreatePublicationRequest,
  buildPublicationContent,
  buildPublicationSaveFeedback,
  buildPublicationSystemButtons,
  buildTestPublicationRequest,
  buildUpdatePublicationRequest,
  canResumePublication,
  canReviewPublicationScheduleDecision,
  createEmptyPublicationDraft,
  createPublicationDuplicateDraft,
  filterFuturePublicationSlots,
  getPublicationActionCapabilities,
  getPublicationActionableDelivery,
  getPublicationReviewCount,
  getPublicationDispatchPendingCount,
  getPublicationDetailsPollingInterval,
  getPublicationDispatchIssuePresentation,
  getPublicationExplicitSlotsLimitFeedback,
  getPublicationFeedStatusLabel,
  getPublicationScheduleErrorPresentation,
  getPublicationListPollingInterval,
  getPublicationPrimaryActionLabel,
  getPublicationRecurrenceIntervalNotice,
  getPublicationTargetTitle,
  hasSamePublicationTargetMetadata,
  hasPublicationDraftChanges,
  inferPublicationVideoMimeType,
  isIsolatedPublicationEditor,
  isPublicationOccurrenceContentStale,
  isPublicationRevisionConflictError,
  isPublicationScheduleConflictError,
  isPublicationScheduleConflictMessage,
  normalizePublicationEntityFilter,
  normalizePublicationQuery,
  normalizePublicationStatusFilter,
  normalizePublicationView,
  publicationDraftNeedsVideoReselection,
  rebasePublicationDraft,
  resolvePublicationDetailsDispatchIssue,
  shouldReviewPublicationScheduleConflict,
  shouldPollPublicationDeliveries,
  shouldPersistPublicationDraft,
  toPublicationTarget,
} from '../src/features/publications/publication-model';
import { getPublicationDeliveryPresentation } from '../src/features/publications/publication-delivery-presentation';
import {
  formatPublicationSchedule,
  getLifecycleTone,
} from '../src/features/publications/publication-page-formatters';
import {
  buildPublicationDraftStorageKey,
  parsePublicationDraftEnvelope,
  preparePublicationDraftForPersistence,
} from '../src/features/publications/publication-draft-storage';
import {
  PUBLICATION_MEDIA_MUTATION_TIMEOUT_MS,
  createPublication,
  getPublicationCalendarAvailability,
  retryPublicationOccurrence,
  testPublication,
  updatePublication,
} from '../src/lib/api/publication-client';
import type { ApiRequestInit, ApiTransport } from '../src/lib/api/transport';
import { publisherEntityToPublicationTarget } from '../src/features/publications/use-publication-target-sources';

const chatTarget = {
  id: 'chat-1',
  entityType: 'chat' as const,
  title: 'Чат',
  avatarUrl: null,
  channelOverview: null,
};
const channelTarget = {
  id: 'channel-1',
  entityType: 'channel' as const,
  title: 'Канал',
  avatarUrl: null,
  channelOverview: {
    commentsEnabled: false,
    postSuggestionsEnabled: false,
  },
};

test('isolates server, edit, and duplicate drafts from the persisted create draft', () => {
  assert.equal(shouldPersistPublicationDraft(null), true);
  assert.equal(shouldPersistPublicationDraft('create'), true);
  assert.equal(shouldPersistPublicationDraft('edit'), false);
  assert.equal(shouldPersistPublicationDraft('duplicate'), false);
  assert.equal(shouldPersistPublicationDraft('import'), false);
  assert.equal(isIsolatedPublicationEditor('edit'), true);
  assert.equal(isIsolatedPublicationEditor('duplicate'), true);
  assert.equal(isIsolatedPublicationEditor('import'), true);
});

test('reports the explicit schedule limit only after 300 unique sends', () => {
  const draft = createEmptyPublicationDraft([chatTarget]);
  draft.timingMode = 'schedule';
  draft.scheduleKind = 'slots';
  draft.scheduledSlots = Array.from({ length: 300 }, (_, index) =>
    new Date(Date.UTC(2030, 0, 1, index)).toISOString(),
  );

  assert.equal(getPublicationExplicitSlotsLimitFeedback(draft), null);

  draft.scheduledSlots.push(new Date(Date.UTC(2030, 0, 1, 300)).toISOString());
  assert.deepEqual(getPublicationExplicitSlotsLimitFeedback(draft), {
    tone: 'danger',
    title: 'Можно запланировать не более 300 отправок.',
    notification: 'error',
  });
});

test('labels publisher actions from validation and timing state', () => {
  assert.equal(
    getPublicationPrimaryActionLabel({
      hasValidationIssues: true,
      editing: false,
      timingMode: 'now',
    }),
    'Проверить',
  );
  assert.equal(
    getPublicationPrimaryActionLabel({
      hasValidationIssues: false,
      editing: true,
      timingMode: 'schedule',
    }),
    'Сохранить',
  );
  assert.equal(
    getPublicationPrimaryActionLabel({
      hasValidationIssues: false,
      editing: false,
      timingMode: 'once',
    }),
    'Запланировать',
  );
  assert.equal(
    getPublicationPrimaryActionLabel({
      hasValidationIssues: false,
      editing: false,
      timingMode: 'schedule',
    }),
    'Сохранить расписание',
  );
});

test('presents deferred publisher access without internal blocker copy', () => {
  assert.deepEqual(getPublicationDispatchIssuePresentation('actor_access_required'), {
    canRecheck: true,
    description: 'Проверьте права администратора.',
    label: 'Ожидает доступа',
    title: 'Нужен доступ',
  });
  assert.deepEqual(getPublicationDispatchIssuePresentation('temporarily_unavailable'), {
    canRecheck: false,
    description: 'Повторим автоматически.',
    label: 'Ожидает отправки',
    title: 'Отправка временно приостановлена',
  });
  assert.deepEqual(getPublicationDispatchIssuePresentation('target_setup_required'), {
    canRecheck: true,
    description: 'Проверьте подключение Публика.',
    label: 'Нужна настройка',
    title: 'Нужна настройка',
  });

  const publication = {
    lifecycle: 'ACTIVE',
    dispatchIssue: 'actor_access_required',
    delivery: { total: 1, pending: 1, sent: 0, failed: 0, ambiguous: 0, canceled: 0 },
  } as Parameters<typeof getPublicationFeedStatusLabel>[0];
  assert.equal(getPublicationFeedStatusLabel(publication), 'Ожидает доступа');
  assert.equal(
    getPublicationFeedStatusLabel({ ...publication, lifecycle: 'CANCELED' }),
    'Отменено',
  );
  assert.equal(getLifecycleTone({ ...publication, lifecycle: 'CANCELED' }), 'muted');
  assert.equal(getPublicationFeedStatusLabel({ ...publication, lifecycle: 'PAUSED' }), 'Пауза');
  assert.equal(getPublicationDispatchIssuePresentation(null), null);
  assert.equal(
    resolvePublicationDetailsDispatchIssue(
      { dispatchIssue: null },
      { dispatchIssue: 'actor_access_required' },
    ),
    null,
  );
  assert.equal(
    resolvePublicationDetailsDispatchIssue(undefined, {
      dispatchIssue: 'actor_access_required',
    }),
    'actor_access_required',
  );
});

test('explains that a 31-day recurrence is not a calendar month', () => {
  assert.deepEqual(getPublicationRecurrenceIntervalNotice('daily', 31), {
    title: 'Каждые 31 день',
    description: 'Число месяца будет меняться.',
  });
});

test('missed runs remain reviewable without delivery rows and do not mark a future send as missed', () => {
  const publication = {
    lifecycle: 'ACTIVE',
    requiresScheduleDecision: true,
    dispatchIssue: 'target_setup_required',
    delivery: { total: 0, pending: 0, sent: 0, failed: 0, ambiguous: 0, canceled: 0 },
    schedule: { mode: 'once', nextOccurrenceAt: null },
  } as Parameters<typeof getPublicationFeedStatusLabel>[0];
  assert.equal(getPublicationFeedStatusLabel(publication), 'Пропущено время');
  assert.equal(canReviewPublicationScheduleDecision(publication), true);
  assert.equal(getPublicationActionCapabilities(publication).canRetry, false);
  const withFuture = {
    ...publication,
    schedule: { ...publication.schedule!, nextOccurrenceAt: '2030-10-01T16:30:00.000Z' },
  };
  assert.equal(getPublicationFeedStatusLabel(withFuture), 'Есть пропущенные отправки');
  assert.equal(
    getPublicationFeedStatusLabel({ ...withFuture, lifecycle: 'ERROR' }),
    'Есть пропущенные отправки',
  );
  assert.equal(
    getPublicationDispatchIssuePresentation('target_setup_required', true)?.canRecheck,
    false,
  );
  for (const lifecycle of ['COMPLETED', 'CANCELED', 'PAUSED', 'DRAFT'] as const) {
    assert.equal(canReviewPublicationScheduleDecision({ ...publication, lifecycle }), false);
  }
  assert.equal(
    canReviewPublicationScheduleDecision({ ...publication, requiresScheduleDecision: false }),
    false,
  );
  assert.equal(
    getPublicationFeedStatusLabel({
      ...publication,
      delivery: { ...publication.delivery, total: 1, ambiguous: 1 },
    }),
    'Нужно проверить',
  );
});

test('an active publication exposes an errored recurrence without retrying an untouched old run', () => {
  const publication = {
    lifecycle: 'ACTIVE',
    requiresScheduleDecision: false,
    dispatchIssue: null,
    delivery: { total: 0, pending: 0, sent: 0, failed: 0, ambiguous: 0, canceled: 0 },
    schedule: {
      mode: 'recurrence',
      status: 'ERROR',
      frequency: 'daily',
      interval: 1,
      times: ['19:30'],
      timezone: 'Europe/Moscow',
      nextOccurrenceAt: '2026-09-01T16:30:00.000Z',
      lastError: 'Нет доступного времени для следующей отправки.',
    },
  } as Parameters<typeof getPublicationFeedStatusLabel>[0];
  assert.equal(getPublicationFeedStatusLabel(publication), 'Ошибка расписания');
  assert.equal(getLifecycleTone(publication), 'danger');
  assert.equal(formatPublicationSchedule(publication), 'По плану · 01 сент., 19:30');
  const capabilities = getPublicationActionCapabilities(publication);
  assert.equal(capabilities.canEdit, true);
  assert.equal(capabilities.editScope, 'schedule');
  assert.equal(capabilities.canRetry, false);
  assert.equal(capabilities.canResume, false);
  assert.equal(capabilities.canPause, false);
  assert.deepEqual(getPublicationScheduleErrorPresentation(publication), {
    canRecheck: false,
    description: 'Нет доступного времени для следующей отправки.',
    label: 'Ошибка расписания',
    title: 'Расписание остановлено',
  });
  assert.equal(getPublicationListPollingInterval('schedules', [publication]), false);
  assert.equal(getPublicationDetailsPollingInterval(publication, publication.delivery), false);
  for (const lifecycle of ['COMPLETED', 'CANCELED', 'PAUSED', 'DRAFT'] as const) {
    assert.equal(getPublicationScheduleErrorPresentation({ ...publication, lifecycle }), null);
    assert.notEqual(
      getPublicationFeedStatusLabel({ ...publication, lifecycle }),
      'Ошибка расписания',
    );
  }
  assert.equal(
    getPublicationFeedStatusLabel({ ...publication, requiresScheduleDecision: true }),
    'Есть пропущенные отправки',
  );
  assert.equal(
    getPublicationFeedStatusLabel({
      ...publication,
      delivery: { ...publication.delivery, total: 1, ambiguous: 1 },
    }),
    'Нужно проверить',
  );
});

test('schedule error presentation hides technical and sensitive diagnostics', () => {
  for (const lastError of [
    null,
    'PUBLISHER_RUNTIME_UNAVAILABLE',
    'Проверка не выполнена: token=private-value',
    'Ошибка запроса https://example.com/private',
    '{"secret":"private-value"}',
  ]) {
    const publication = {
      lifecycle: 'ACTIVE',
      schedule: { status: 'ERROR', lastError },
    } as Parameters<typeof getPublicationScheduleErrorPresentation>[0];
    assert.equal(
      getPublicationScheduleErrorPresentation(publication)?.description,
      'Отправки по этому расписанию остановлены.',
    );
  }
});

test('retry content saves omit a new send while an explicit schedule repair retains publish intent', async () => {
  const draft = { ...createEmptyPublicationDraft([chatTarget]), text: 'Исправленный текст' };
  const calls: Array<{ path: string; init?: ApiRequestInit }> = [];
  const api: ApiTransport = {
    request: async (path, init) => {
      calls.push({ path, init });
      throw new Error('stop');
    },
    requestKeepalive: () => undefined,
  };
  for (const timingMode of ['now', 'once'] as const) {
    const contentOnly = buildUpdatePublicationRequest(
      { ...draft, timingMode, scheduledSlots: ['2026-09-01T16:30:00.000Z'] },
      2,
      'retry-version-save',
      false,
      true,
    );
    assert.deepEqual(Object.keys(contentOnly).sort(), [
      'content',
      'expectedRevision',
      'requestId',
      'title',
    ]);
    assert.equal(contentOnly.content?.text, 'Исправленный текст');
    await assert.rejects(updatePublication(api, 'publication-live-all', contentOnly), /stop/u);
    const sent = JSON.parse(calls.at(-1)?.init?.body ?? '{}') as Record<string, unknown>;
    assert.deepEqual(Object.keys(sent).sort(), Object.keys(contentOnly).sort());
  }
  const publishNowDraft = buildUpdatePublicationRequest(draft, 2, 'draft-publish');
  assert.equal(publishNowDraft.schedule?.mode, 'now');
  draft.timingMode = 'schedule';
  draft.scheduleKind = 'recurrence';
  draft.recurrence = {
    ...draft.recurrence,
    frequency: 'daily',
    times: ['19:30'],
    startsAt: '2030-10-01T00:00:00.000Z',
  };
  const repair = buildUpdatePublicationRequest(draft, 2, 'schedule-repair');
  assert.equal(repair.intent, 'publish');
  assert.equal(repair.schedule?.mode, 'recurrence');
});

test('failed and ambiguous single sends only edit their content version while untouched errors can be rescheduled', () => {
  const emptyDelivery = {
    total: 0,
    pending: 0,
    sent: 0,
    failed: 0,
    ambiguous: 0,
    canceled: 0,
  };
  for (const mode of ['now', 'once'] as const) {
    const publication = {
      lifecycle: 'ERROR',
      delivery: emptyDelivery,
      schedule: {
        mode,
        status: 'ERROR',
        nextOccurrenceAt: '2026-09-01T16:30:00.000Z',
      },
    } as Parameters<typeof getPublicationActionCapabilities>[0];
    const untouched = getPublicationActionCapabilities(publication);
    assert.equal(untouched.editScope, 'schedule');
    assert.equal(untouched.canRetry, false);
    for (const result of ['failed', 'ambiguous'] as const) {
      const unresolved = getPublicationActionCapabilities({
        ...publication,
        actionableDelivery: { ...emptyDelivery, total: 1, [result]: 1 },
      });
      assert.equal(unresolved.editScope, 'retry');
      assert.equal(unresolved.canRetry, result === 'failed');
      assert.equal(unresolved.canPause, false);
      assert.equal(unresolved.canResume, false);
    }
  }
});

test('previews other large recurrence intervals without warning for routine intervals', () => {
  assert.equal(getPublicationRecurrenceIntervalNotice('daily', 27), null);
  assert.equal(getPublicationRecurrenceIntervalNotice('weekly', 3), null);
  assert.equal(getPublicationRecurrenceIntervalNotice('daily', 1.5), null);

  assert.deepEqual(getPublicationRecurrenceIntervalNotice('daily', 30), {
    title: 'Каждые 30 дней',
    description: 'Число месяца может меняться.',
  });
  assert.deepEqual(getPublicationRecurrenceIntervalNotice('weekly', 4), {
    title: '28 дней между публикациями',
    description: 'От даты начала расписания.',
  });
  assert.equal(
    getPublicationRecurrenceIntervalNotice('weekly', 21)?.title,
    '147 дней между публикациями',
  );
});

test('describes a new NOW publication as starting while delivery is still queued', () => {
  const feedback = buildPublicationSaveFeedback(
    {
      delivery: {
        total: 0,
        pending: 0,
        sent: 0,
        failed: 0,
        ambiguous: 0,
        canceled: 0,
      },
    },
    { editorKind: 'create', timingMode: 'now' },
  );

  assert.equal(feedback.tone, 'info');
  assert.equal(feedback.title, 'Начинаем отправку');
});

test('confirms a new NOW publication only when every delivery is sent', () => {
  const feedback = buildPublicationSaveFeedback(
    {
      delivery: {
        total: 2,
        pending: 0,
        sent: 2,
        failed: 0,
        ambiguous: 0,
        canceled: 0,
      },
    },
    { editorKind: 'create', timingMode: 'now' },
  );

  assert.equal(feedback.tone, 'success');
  assert.equal(feedback.title, 'Публикация отправлена');
});

test('does not hide an ambiguous NOW delivery behind a success confirmation', () => {
  const feedback = buildPublicationSaveFeedback(
    {
      delivery: {
        total: 1,
        pending: 0,
        sent: 0,
        failed: 0,
        ambiguous: 1,
        canceled: 0,
      },
    },
    { editorKind: 'create', timingMode: 'now' },
  );

  assert.equal(feedback.tone, 'info');
  assert.equal(feedback.notification, 'warning');
  assert.equal(feedback.title, 'Отправка требует проверки');
});

test('treats canceled NOW targets as undelivered instead of queued', () => {
  const feedback = buildPublicationSaveFeedback(
    {
      delivery: {
        total: 1,
        pending: 0,
        sent: 0,
        failed: 0,
        ambiguous: 0,
        canceled: 1,
      },
    },
    { editorKind: 'create', timingMode: 'now' },
  );

  assert.equal(feedback.tone, 'danger');
  assert.equal(feedback.title, 'Не все сообщения отправлены');
});

test('keeps edit feedback focused on saving the publication', () => {
  const feedback = buildPublicationSaveFeedback(
    {
      delivery: {
        total: 1,
        pending: 0,
        sent: 0,
        failed: 1,
        ambiguous: 0,
        canceled: 0,
      },
    },
    { editorKind: 'edit', editScope: 'retry', timingMode: 'now' },
  );

  assert.equal(feedback.tone, 'success');
  assert.equal(feedback.title, 'Версия для повтора сохранена');
});

test('keeps publication actions aligned with lifecycle and actual future sends', () => {
  const emptyDelivery = {
    total: 0,
    pending: 0,
    sent: 0,
    failed: 0,
    ambiguous: 0,
    canceled: 0,
  };
  const base = {
    lifecycle: 'ACTIVE' as const,
    delivery: emptyDelivery,
    schedule: {
      mode: 'now' as const,
      timezone: 'Europe/Moscow',
      status: 'ACTIVE' as const,
      revision: 1,
      nextOccurrenceAt: null,
      lastError: null,
    },
  };

  assert.deepEqual(getPublicationActionCapabilities(base), {
    canCancel: true,
    canEdit: false,
    canPause: false,
    canResume: false,
    canRetry: false,
    editScope: null,
    hasFutureSends: false,
  });
  assert.deepEqual(
    getPublicationActionCapabilities({
      ...base,
      lifecycle: 'ERROR',
      access: { canManageAllTargets: false },
      actionableDelivery: { ...emptyDelivery, total: 1, failed: 1 },
    }),
    {
      canCancel: true,
      canEdit: false,
      canPause: false,
      canResume: false,
      canRetry: false,
      editScope: null,
      hasFutureSends: false,
    },
  );

  assert.deepEqual(
    getPublicationActionCapabilities({
      ...base,
      lifecycle: 'ERROR',
      actionableDelivery: { ...emptyDelivery, total: 1, failed: 1 },
    }),
    {
      canCancel: true,
      canEdit: true,
      canPause: false,
      canResume: false,
      canRetry: true,
      editScope: 'retry',
      hasFutureSends: false,
    },
  );

  assert.deepEqual(
    getPublicationActionCapabilities({
      ...base,
      schedule: {
        mode: 'recurrence',
        timezone: 'Europe/Moscow',
        frequency: 'daily',
        interval: 1,
        weekdays: [],
        times: ['09:00'],
        startsAt: null,
        endsAt: null,
        maxOccurrences: null,
        replaceConflicts: false,
        status: 'ACTIVE',
        revision: 1,
        nextOccurrenceAt: '2026-07-19T06:00:00.000Z',
        lastError: null,
      },
    }),
    {
      canCancel: true,
      canEdit: true,
      canPause: true,
      canResume: false,
      canRetry: false,
      editScope: 'future',
      hasFutureSends: true,
    },
  );

  assert.deepEqual(getPublicationActionCapabilities({ ...base, lifecycle: 'COMPLETED' }), {
    canCancel: false,
    canEdit: false,
    canPause: false,
    canResume: false,
    canRetry: false,
    editScope: null,
    hasFutureSends: false,
  });
});

test('normalizes publication hub route state and maps the legacy plan view to current', () => {
  assert.equal(normalizePublicationView(null), 'current');
  assert.equal(normalizePublicationView('current'), 'current');
  assert.equal(normalizePublicationView('plan'), 'current');
  assert.equal(normalizePublicationView('schedules'), 'schedules');
  assert.equal(normalizePublicationQuery('  поиск  '), '  поиск  ');
  assert.equal(normalizePublicationQuery('x'.repeat(140)).length, 120);
  assert.equal(normalizePublicationEntityFilter('channel'), 'channel');
  assert.equal(normalizePublicationEntityFilter('unknown'), 'all');
  assert.equal(normalizePublicationStatusFilter('failed', 'current'), 'failed');
  assert.equal(normalizePublicationStatusFilter('completed', 'current'), 'all');
  assert.equal(normalizePublicationStatusFilter('completed', 'history'), 'completed');
});

test('uses actionable delivery stats for list decisions without changing lifetime totals', () => {
  const lifetime = { total: 20, pending: 0, sent: 18, failed: 2, ambiguous: 0, canceled: 0 };
  const actionable = { total: 2, pending: 0, sent: 2, failed: 0, ambiguous: 0, canceled: 0 };

  assert.equal(
    getPublicationActionableDelivery({ delivery: lifetime, actionableDelivery: actionable }),
    actionable,
  );
  assert.equal(getPublicationActionableDelivery({ delivery: lifetime }), lifetime);
});

test('reviews uncertainty from old schedule revisions without granting retry authority', () => {
  const publication = {
    lifecycle: 'ACTIVE' as const,
    delivery: { total: 1, pending: 0, sent: 0, failed: 0, ambiguous: 1, canceled: 0 },
    actionableDelivery: {
      total: 0,
      pending: 0,
      sent: 0,
      failed: 0,
      ambiguous: 0,
      canceled: 0,
      dispatchPending: 0,
    },
    schedule: null,
  } as Parameters<typeof getPublicationFeedStatusLabel>[0];
  assert.equal(getPublicationReviewCount(publication), 1);
  assert.equal(getPublicationFeedStatusLabel(publication), 'Нужно проверить');
  assert.equal(getLifecycleTone(publication), 'danger');
  assert.equal(getPublicationActionCapabilities(publication).canRetry, false);
  assert.equal(getPublicationActionCapabilities(publication).editScope, null);
});

test('polls publication lists only while delivery or an active schedule can change', () => {
  const nowMs = Date.parse('2026-07-18T10:00:00.000Z');
  const emptyDelivery = {
    total: 0,
    pending: 0,
    sent: 0,
    failed: 0,
    ambiguous: 0,
    canceled: 0,
  };
  const pendingDelivery = { ...emptyDelivery, total: 1, pending: 1 };
  const activeSchedule = {
    lifecycle: 'ACTIVE' as const,
    delivery: emptyDelivery,
    schedule: {
      mode: 'recurrence' as const,
      nextOccurrenceAt: '2026-07-18T11:00:00.000Z',
    },
  };

  assert.equal(getPublicationListPollingInterval('history', [activeSchedule], nowMs), false);
  assert.equal(
    getPublicationListPollingInterval(
      'current',
      [{ ...activeSchedule, dispatchIssue: 'actor_access_required' }],
      nowMs,
    ),
    30_000,
  );
  assert.equal(
    getPublicationListPollingInterval(
      'current',
      [
        { ...activeSchedule, dispatchIssue: 'actor_access_required' },
        {
          ...activeSchedule,
          delivery: { ...activeSchedule.delivery, total: 1, pending: 1 },
        },
      ],
      nowMs,
    ),
    5_000,
  );
  assert.equal(
    getPublicationListPollingInterval(
      'current',
      [
        {
          ...activeSchedule,
          dispatchIssue: 'actor_access_required',
          delivery: { ...activeSchedule.delivery, total: 1, pending: 1 },
        },
      ],
      nowMs,
    ),
    30_000,
  );
  assert.equal(
    getPublicationListPollingInterval(
      'schedules',
      [{ ...activeSchedule, lifecycle: 'PAUSED' }],
      nowMs,
    ),
    false,
  );
  assert.equal(
    getPublicationListPollingInterval(
      'schedules',
      [{ ...activeSchedule, actionableDelivery: pendingDelivery }],
      nowMs,
    ),
    5_000,
  );
  assert.equal(getPublicationListPollingInterval('schedules', [activeSchedule], nowMs), 900_000);
  assert.equal(
    getPublicationListPollingInterval(
      'schedules',
      [
        {
          ...activeSchedule,
          schedule: {
            ...activeSchedule.schedule,
            nextOccurrenceAt: '2026-07-18T10:01:00.000Z',
          },
        },
      ],
      nowMs,
    ),
    10_000,
  );
  assert.equal(
    getPublicationListPollingInterval(
      'current',
      [
        {
          lifecycle: 'ACTIVE',
          delivery: emptyDelivery,
          schedule: { mode: 'now', nextOccurrenceAt: null },
        },
      ],
      nowMs,
    ),
    5_000,
  );
});

test('stopped dispatch uses authoritative zero while legacy counts keep polling', () => {
  const delivery = { total: 2, pending: 2, sent: 0, failed: 0, ambiguous: 0, canceled: 0 };
  const stopped = { ...delivery, dispatchPending: 0 };
  const publication = {
    lifecycle: 'ACTIVE' as const,
    dispatchIssue: null,
    delivery,
    actionableDelivery: stopped,
    schedule: { mode: 'once' as const, status: 'ACTIVE' as const, nextOccurrenceAt: null },
  };
  assert.equal(getPublicationDispatchPendingCount(delivery), 2);
  assert.equal(getPublicationDispatchPendingCount(stopped), 0);
  assert.equal(shouldPollPublicationDeliveries(publication, stopped), false);
  assert.equal(getPublicationDetailsPollingInterval(publication, stopped), 30_000);
  assert.equal(getPublicationListPollingInterval('current', [publication]), false);
  assert.equal(getPublicationListPollingInterval('schedules', [publication]), false);
  assert.equal(shouldPollPublicationDeliveries(publication, delivery), true);
  assert.equal(getPublicationDetailsPollingInterval(publication, delivery), 5_000);
  assert.equal(
    getPublicationListPollingInterval('current', [
      { ...publication, actionableDelivery: delivery },
    ]),
    5_000,
  );
  assert.equal(
    getPublicationListPollingInterval('current', [
      publication,
      { ...publication, actionableDelivery: { ...stopped, dispatchPending: 1 } },
    ]),
    5_000,
  );
});

test('stopped delivery copy preserves uncertainty and suppresses future send promises', () => {
  assert.deepEqual(
    getPublicationDeliveryPresentation({ status: 'PENDING', dispatchStopped: true }),
    {
      label: 'Отправка остановлена',
      showPendingTiming: false,
      stopNotice: null,
    },
  );
  assert.deepEqual(
    getPublicationDeliveryPresentation({ status: 'SENDING', dispatchStopped: true }),
    {
      label: 'Результат начатой попытки уточняется',
      showPendingTiming: false,
      stopNotice: 'Дальнейшая отправка остановлена',
    },
  );
  assert.equal(
    getPublicationDeliveryPresentation({ status: 'AMBIGUOUS', dispatchStopped: true }).label,
    'Нужно проверить',
  );
  assert.equal(
    getPublicationDeliveryPresentation({ status: 'AMBIGUOUS', dispatchStopped: true }).stopNotice,
    'Дальнейшая отправка остановлена',
  );
  assert.equal(
    getPublicationDeliveryPresentation({ status: 'SENT', dispatchStopped: true }).label,
    'Опубликовано',
  );
  for (const dispatchStopped of [false, undefined]) {
    assert.deepEqual(getPublicationDeliveryPresentation({ status: 'PENDING', dispatchStopped }), {
      label: 'В очереди',
      showPendingTiming: true,
      stopNotice: null,
    });
  }
});

test('keeps mixed Publisher delivery rows fresh while an issue is unresolved', () => {
  const delivery = {
    total: 1,
    pending: 1,
    sent: 0,
    failed: 0,
    ambiguous: 0,
    canceled: 0,
  };
  const publication = {
    dispatchIssue: 'actor_access_required',
    lifecycle: 'ACTIVE',
    schedule: { mode: 'now' },
  } as Parameters<typeof shouldPollPublicationDeliveries>[0];

  assert.equal(shouldPollPublicationDeliveries(publication, delivery), true);
  assert.equal(getPublicationDetailsPollingInterval(publication, delivery), 30_000);
  assert.equal(
    shouldPollPublicationDeliveries(publication, { ...delivery, total: 0, pending: 0 }),
    false,
  );
  assert.equal(
    getPublicationDetailsPollingInterval(publication, { ...delivery, total: 0, pending: 0 }),
    30_000,
  );
  assert.equal(
    shouldPollPublicationDeliveries({ ...publication, dispatchIssue: null }, delivery),
    true,
  );
  assert.equal(
    getPublicationDetailsPollingInterval({ ...publication, dispatchIssue: null }, delivery),
    5_000,
  );
});

test('scheduled details refresh before and after preparation without a recipient counter', () => {
  const now = Date.parse('2026-10-20T00:00:00Z');
  const delivery = { total: 0, pending: 0, sent: 0, failed: 0, ambiguous: 0, canceled: 0 };
  const publication = {
    lifecycle: 'ACTIVE',
    dispatchIssue: null,
    schedule: { mode: 'slots', nextOccurrenceAt: new Date(now + 60_000).toISOString() },
  } as Parameters<typeof getPublicationDetailsPollingInterval>[0];
  assert.equal(getPublicationDetailsPollingInterval(publication, delivery, now), 5_000);
  assert.equal(getPublicationDetailsPollingInterval(publication, delivery, now + 120_000), 5_000);
  assert.equal(
    getPublicationDetailsPollingInterval(
      { ...publication, schedule: { ...publication.schedule!, nextOccurrenceAt: null } },
      delivery,
      now,
    ),
    30_000,
  );
  assert.equal(
    getPublicationDetailsPollingInterval({ ...publication, lifecycle: 'PAUSED' }, delivery, now),
    false,
  );
});

test('terminal publications stop aggregate polling despite cached blockers or pending counters', () => {
  const delivery = { total: 1, pending: 1, sent: 0, failed: 0, ambiguous: 0, canceled: 0 };
  for (const lifecycle of ['COMPLETED', 'CANCELED'] as const) {
    for (const dispatchIssue of [null, 'temporarily_unavailable'] as const) {
      const publication = {
        lifecycle,
        dispatchIssue,
        delivery,
        schedule: { mode: 'now' as const, nextOccurrenceAt: null },
      };
      assert.equal(shouldPollPublicationDeliveries(publication, delivery), false);
      assert.equal(getPublicationDetailsPollingInterval(publication, delivery), false);
      assert.equal(getPublicationListPollingInterval('current', [publication]), false);
      assert.equal(getPublicationListPollingInterval('schedules', [publication]), false);
    }
  }
});

test('detects stale occurrence content from explicit and revision-based projections', () => {
  assert.equal(
    isPublicationOccurrenceContentStale({ contentRevision: 2, usesLatestContent: false }, 3),
    true,
  );
  assert.equal(
    isPublicationOccurrenceContentStale({ contentRevision: 3, usesLatestContent: true }, 3),
    false,
  );
  assert.equal(isPublicationOccurrenceContentStale({ contentRevision: 2 }, 3), true);
  assert.equal(isPublicationOccurrenceContentStale({}, 3), false);
});

test('starts a new publication without a recipient or a publishable schedule', () => {
  const draft = createEmptyPublicationDraft();

  assert.deepEqual(draft.targets, []);
  assert.equal(draft.textFormat, 'markdown');
  assert.deepEqual(draft.scheduledSlots, []);
  assert.equal(draft.onceDate, '');
  assert.equal(draft.onceTime, '');
  assert.deepEqual(draft.recurrence, {
    frequency: 'weekly',
    interval: 1,
    weekdays: [],
    times: [],
    startsAt: null,
    endsAt: null,
    maxOccurrences: null,
  });
});

test('uses a stable fallback when a persisted publication target has no title', () => {
  assert.equal(getPublicationTargetTitle({ entityType: 'chat', title: '  ' }), 'Чат');
  assert.equal(getPublicationTargetTitle({ entityType: 'channel', title: '' }), 'Канал');
  assert.equal(getPublicationTargetTitle({ entityType: 'chat', title: '  Новости  ' }), 'Новости');
});

test('preserves channel engagement toggles and previews their system buttons', () => {
  const target = toPublicationTarget({
    id: 'channel-2',
    entityType: 'channel',
    title: 'Новости',
    avatarUrl: null,
    channelOverview: {
      enabledScenariosCount: 2,
      commentsEnabled: true,
      postSuggestionsEnabled: true,
      commentsModerationEnabled: false,
    },
  } as never);

  assert.deepEqual(target.channelOverview, {
    commentsEnabled: true,
    postSuggestionsEnabled: true,
  });
  assert.deepEqual(buildPublicationSystemButtons([target]), [
    { kind: 'comments', text: '💬 Комментарии' },
    { kind: 'suggest', text: '📰 Предложить пост' },
  ]);
});

test('compares refreshed publication target engagement metadata', () => {
  assert.equal(hasSamePublicationTargetMetadata(channelTarget, { ...channelTarget }), true);
  assert.equal(
    hasSamePublicationTargetMetadata(chatTarget, {
      ...chatTarget,
      publisherChatCommentsEnabled: true,
    }),
    false,
  );
  assert.equal(
    hasSamePublicationTargetMetadata(channelTarget, {
      ...channelTarget,
      channelOverview: { commentsEnabled: true, postSuggestionsEnabled: false },
    }),
    false,
  );
  assert.equal(
    hasSamePublicationTargetMetadata(channelTarget, {
      ...channelTarget,
      publisherChannelSuggestionsEnabled: true,
    }),
    false,
  );
  assert.equal(
    hasSamePublicationTargetMetadata(
      { ...channelTarget, readiness: null },
      {
        ...channelTarget,
        readiness: {
          state: 'ready',
          canPublish: true,
          canUseChatComments: false,
          canPublishSuggestions: false,
          blockerCode: null,
          checkedAt: '2026-08-27T10:00:00.000Z',
          retryAt: null,
        },
      },
    ),
    false,
  );
});

test('previews Publisher-owned chat comments without importing Major channel modules', () => {
  assert.deepEqual(
    buildPublicationSystemButtons([
      { ...chatTarget, channelOverview: null, publisherChatCommentsEnabled: true },
    ]),
    [{ kind: 'comments', text: '💬 Комментарии' }],
  );
});

test('previews Publisher-owned channel suggestions without importing Major channel modules', () => {
  const target = publisherEntityToPublicationTarget({
    id: 'publisher-channel-1',
    entityType: 'channel',
    title: 'Публик: новости',
    avatarUrl: null,
    moduleSettings: {
      revision: 3,
      chatComments: null,
      autoRepliesEnabled: null,
      channelCommentsEnabled: true,
      channelSuggestionsEnabled: true,
    },
    channelPostSignature: {
      enabled: true,
      presentation: 'button',
      text: '📞 Заказать рекламу',
      url: 'https://example.test/ads',
    },
    readiness: {
      state: 'ready',
      canPublish: true,
      canUseChatComments: false,
      canUseChannelComments: true,
      canPublishSuggestions: true,
      blockerCode: null,
      checkedAt: '2026-08-27T10:00:00.000Z',
      retryAt: null,
    },
  } as never);

  assert.equal(target.channelOverview, null);
  assert.equal(target.publisherChannelCommentsEnabled, true);
  assert.equal(target.publisherChannelSuggestionsEnabled, true);
  assert.deepEqual(buildPublicationSystemButtons([target]), [
    { kind: 'comments', text: '💬 Комментарии' },
    { kind: 'suggest', text: '✍️ Предложить объявление' },
    { kind: 'cta', text: '📞 Заказать рекламу' },
  ]);
});

test('does not merge incompatible system button previews across targets', () => {
  assert.deepEqual(
    buildPublicationSystemButtons([
      chatTarget,
      {
        ...channelTarget,
        channelOverview: { commentsEnabled: true, postSuggestionsEnabled: false },
      },
      {
        ...channelTarget,
        id: 'channel-2',
        channelOverview: { commentsEnabled: false, postSuggestionsEnabled: true },
      },
    ]),
    [],
  );
});

test('keeps an exact shared system button preview for matching targets', () => {
  assert.deepEqual(
    buildPublicationSystemButtons([
      {
        ...channelTarget,
        channelOverview: { commentsEnabled: true, postSuggestionsEnabled: true },
      },
      {
        ...channelTarget,
        id: 'channel-2',
        channelOverview: { commentsEnabled: true, postSuggestionsEnabled: true },
      },
    ]),
    [
      { kind: 'comments', text: '💬 Комментарии' },
      { kind: 'suggest', text: '📰 Предложить пост' },
    ],
  );
});

test('duplicates content and recipients but requires a new schedule choice', () => {
  const source = createEmptyPublicationDraft([chatTarget, channelTarget]);
  source.title = 'Утренний дайджест';
  source.text = 'Доброе утро';
  source.timingMode = 'schedule';
  source.scheduleKind = 'recurrence';
  source.scheduledSlots = ['2026-08-01T07:00:00.000Z'];
  source.onceDate = '2026-08-01';
  source.onceTime = '10:00';
  source.recurrence = {
    frequency: 'weekly',
    interval: 1,
    weekdays: [1, 3],
    times: ['10:00'],
    startsAt: '2026-08-01T00:00:00.000Z',
    endsAt: null,
    maxOccurrences: 30,
  };

  const duplicate = createPublicationDuplicateDraft(source);

  assert.equal(duplicate.title, source.title);
  assert.equal(duplicate.text, source.text);
  assert.equal(duplicate.textFormat, source.textFormat);
  assert.deepEqual(duplicate.targets, source.targets);
  assert.equal(duplicate.timingMode, 'schedule');
  assert.equal(duplicate.scheduleKind, 'slots');
  assert.deepEqual(duplicate.scheduledSlots, []);
  assert.equal(duplicate.onceDate, '');
  assert.equal(duplicate.onceTime, '');
  assert.deepEqual(duplicate.recurrence.weekdays, []);
  assert.deepEqual(duplicate.recurrence.times, []);
  assert.equal(duplicate.recurrence.startsAt, null);
});

test('keeps each retained media source in copies and private test requests before cloud save', () => {
  for (const type of ['image', 'video'] as const) {
    const source = createEmptyPublicationDraft([chatTarget]);
    source.text = 'Общая публикация';
    source.retainedAssets = [
      {
        id: 'shared-media',
        type,
        mimeType: type === 'image' ? 'image/jpeg' : 'video/mp4',
        fileName: type === 'image' ? 'photo.jpg' : 'video.mp4',
        sizeBytes: 1024,
        sourcePublicationId: 'source-publication',
      },
    ];
    const copy = createPublicationDuplicateDraft(source);
    assert.equal(copy.cloudDraft, undefined);
    const expected = [
      {
        type: type === 'image' ? 'image-ref' : 'video-ref',
        assetId: 'shared-media',
        sourcePublicationId: 'source-publication',
      },
    ];
    assert.deepEqual(buildPublicationContent(copy).media, expected);
    assert.deepEqual(buildTestPublicationRequest(copy, 'private-test').content.media, expected);
    assert.equal(
      hasPublicationDraftChanges(copy, {
        ...copy,
        retainedAssets: [{ ...copy.retainedAssets[0]!, sourcePublicationId: 'new-cloud-copy' }],
      }),
      true,
    );
  }
});

test('detects unsaved edit changes without treating refreshed target metadata as content', () => {
  const initial = createEmptyPublicationDraft([channelTarget]);
  initial.text = 'Исходный текст';
  const refreshedMetadata = {
    ...initial,
    targets: [
      {
        ...channelTarget,
        title: 'Новое название',
        avatarUrl: 'https://example.com/avatar',
        channelOverview: { commentsEnabled: true, postSuggestionsEnabled: true },
      },
    ],
  };

  assert.equal(hasPublicationDraftChanges(initial, refreshedMetadata), false);
  assert.equal(
    hasPublicationDraftChanges(initial, { ...refreshedMetadata, text: 'Изменённый текст' }),
    true,
  );
  assert.equal(
    hasPublicationDraftChanges(initial, { ...refreshedMetadata, textFormat: 'plain' }),
    true,
  );
  assert.equal(
    hasPublicationDraftChanges(initial, {
      ...refreshedMetadata,
      targets: [refreshedMetadata.targets[0]!, channelTarget],
    }),
    true,
  );
});

test('rebases local edit groups onto a newer publication without dropping user changes', () => {
  const baseline = createEmptyPublicationDraft([chatTarget]);
  baseline.title = 'Старое название';
  baseline.text = 'Старый текст';
  baseline.buttonEnabled = true;
  baseline.buttons = [{ text: 'Открыть', url: 'https://max.ru/old' }];

  const local = structuredClone(baseline);
  local.text = 'Мой новый текст';
  local.textFormat = 'plain';
  local.buttons = [{ text: 'Подробнее', url: 'https://max.ru/local' }];

  const latest = structuredClone(baseline);
  latest.title = 'Название с сервера';
  latest.text = 'Чужое изменение текста';
  latest.timingMode = 'once';
  latest.scheduledSlots = ['2027-01-01T09:00:00.000Z'];

  const rebased = rebasePublicationDraft(baseline, local, latest);

  assert.equal(rebased.title, 'Название с сервера');
  assert.equal(rebased.text, 'Мой новый текст');
  assert.equal(rebased.textFormat, 'plain');
  assert.deepEqual(rebased.buttons, local.buttons);
  assert.equal(rebased.timingMode, 'once');
  assert.deepEqual(rebased.scheduledSlots, latest.scheduledSlots);
});

test('scopes publication drafts by MAX user id', () => {
  assert.equal(buildPublicationDraftStorageKey('1001'), 'maxim:publications-composer:v1:1001');
  assert.equal(buildPublicationDraftStorageKey('1002'), 'maxim:publications-composer:v1:1002');
  assert.notEqual(buildPublicationDraftStorageKey('1001'), buildPublicationDraftStorageKey('1002'));
  assert.equal(buildPublicationDraftStorageKey(null), 'maxim:publications-composer:v1:anonymous');
});

test('keeps intentional schedules when migrating a legacy publication draft', () => {
  const slotsDraft = parsePublicationDraftEnvelope({
    version: 1,
    savedAt: '2026-07-11T09:00:00.000Z',
    draft: {
      timingMode: 'schedule',
      scheduleKind: 'slots',
      scheduledSlots: ['2026-08-01T09:00:00.000Z'],
      recurrence: { weekdays: [1], times: ['09:00'] },
    },
  });
  const recurrenceDraft = parsePublicationDraftEnvelope({
    version: 1,
    savedAt: '2026-07-11T09:00:00.000Z',
    draft: {
      timingMode: 'schedule',
      scheduleKind: 'recurrence',
      scheduledSlots: ['2026-08-01T09:00:00.000Z'],
      recurrence: {
        frequency: 'weekly',
        interval: 2,
        weekdays: [1, 4],
        times: ['09:00'],
        startsAt: null,
        maxOccurrences: 12,
      },
    },
  });
  const nowDraft = parsePublicationDraftEnvelope({
    version: 1,
    savedAt: '2026-07-11T09:00:00.000Z',
    draft: {
      timingMode: 'now',
      scheduledSlots: ['2026-08-01T09:00:00.000Z'],
      recurrence: { weekdays: [1], times: ['09:00'] },
    },
  });

  assert.deepEqual(slotsDraft?.scheduledSlots, ['2026-08-01T09:00:00.000Z']);
  assert.deepEqual(recurrenceDraft?.scheduledSlots, []);
  assert.deepEqual(recurrenceDraft?.recurrence.weekdays, [1, 4]);
  assert.deepEqual(recurrenceDraft?.recurrence.times, ['09:00']);
  assert.equal(recurrenceDraft?.recurrence.startsAt, null);
  assert.equal(recurrenceDraft?.recurrence.maxOccurrences, 12);
  assert.deepEqual(nowDraft?.scheduledSlots, []);
  assert.deepEqual(nowDraft?.recurrence.weekdays, []);
  assert.deepEqual(nowDraft?.recurrence.times, []);
  assert.equal(nowDraft?.textFormat, 'markdown');
});

test('restores and persists publication source text format', () => {
  const plain = parsePublicationDraftEnvelope({
    version: 1,
    savedAt: '2026-08-27T10:00:00.000Z',
    draft: { text: '**literal**', textFormat: 'plain' },
  });
  const markdown = parsePublicationDraftEnvelope({
    version: 1,
    savedAt: '2026-08-27T10:00:00.000Z',
    draft: { text: '**rich**', textFormat: 'markdown' },
  });

  assert.equal(plain?.textFormat, 'plain');
  assert.equal(markdown?.textFormat, 'markdown');
  assert.equal(buildPublicationContent(plain!).textFormat, 'plain');
  assert.equal(buildPublicationContent(markdown!).textFormat, 'markdown');
});

test('omits session video bytes while preserving the rest of an autosaved publication draft', () => {
  const draft = createEmptyPublicationDraft([chatTarget]);
  draft.title = 'Видеоанонс';
  draft.text = 'Текст остаётся';
  draft.buttons = [{ text: 'Открыть', url: 'https://max.ru/' }];
  draft.buttonEnabled = true;
  draft.timingMode = 'once';
  draft.scheduledSlots = ['2027-01-01T09:00:00.000Z'];
  draft.mediaType = 'video';
  draft.mediaBase64 = 'dmlkZW8=';
  draft.mediaMimeType = 'video/mp4';
  draft.mediaFileName = 'clip.mp4';

  const persisted = preparePublicationDraftForPersistence(draft);

  assert.equal(persisted.title, draft.title);
  assert.equal(persisted.text, draft.text);
  assert.deepEqual(persisted.targets, draft.targets);
  assert.deepEqual(persisted.buttons, draft.buttons);
  assert.deepEqual(persisted.scheduledSlots, draft.scheduledSlots);
  assert.equal(persisted.mediaType, 'video');
  assert.equal(persisted.mediaBase64, '');
  assert.equal(persisted.mediaMimeType, 'video/mp4');
  assert.equal(persisted.mediaFileName, 'clip.mp4');
  assert.equal(publicationDraftNeedsVideoReselection(persisted), true);
  const restored = parsePublicationDraftEnvelope({
    version: 1,
    savedAt: '2026-07-18T10:00:00.000Z',
    draft: persisted,
  });
  assert.equal(restored?.mediaType, 'video');
  assert.equal(restored?.mediaFileName, 'clip.mp4');
  assert.equal(restored ? publicationDraftNeedsVideoReselection(restored) : false, true);
  assert.equal(draft.mediaBase64, 'dmlkZW8=');
});

test('restores publisher readiness with an autosaved off-page target', () => {
  const readiness = {
    state: 'ready' as const,
    canPublish: true,
    canUseChatComments: true,
    canUseChannelComments: false,
    canPublishSuggestions: false,
    blockerCode: null,
    checkedAt: '2026-08-27T10:00:00.000Z',
    retryAt: null,
  };
  const draft = createEmptyPublicationDraft([{ ...chatTarget, readiness }]);

  const restored = parsePublicationDraftEnvelope({
    version: 1,
    savedAt: '2026-08-27T10:01:00.000Z',
    draft: preparePublicationDraftForPersistence(draft),
  });

  assert.deepEqual(restored?.targets[0]?.readiness, readiness);
});

test('restores per-target Publisher system button metadata from an autosaved draft', () => {
  const draft = createEmptyPublicationDraft([
    { ...chatTarget, publisherChatCommentsEnabled: true },
    {
      ...channelTarget,
      channelOverview: null,
      publisherChannelCommentsEnabled: true,
      publisherChannelSuggestionsEnabled: true,
    },
  ]);

  const restored = parsePublicationDraftEnvelope({
    version: 1,
    savedAt: '2026-08-27T10:01:00.000Z',
    draft: preparePublicationDraftForPersistence(draft),
  });

  assert.equal(restored?.targets[0]?.publisherChatCommentsEnabled, true);
  assert.equal(restored?.targets[1]?.publisherChannelCommentsEnabled, true);
  assert.equal(restored?.targets[1]?.publisherChannelSuggestionsEnabled, true);
  assert.deepEqual(buildPublicationSystemButtons(restored?.targets ?? []), []);
  assert.deepEqual(buildPublicationSystemButtons(restored?.targets.slice(0, 1) ?? []), [
    { kind: 'comments', text: '💬 Комментарии' },
  ]);
  assert.deepEqual(buildPublicationSystemButtons(restored?.targets.slice(1, 2) ?? []), [
    { kind: 'comments', text: '💬 Комментарии' },
    { kind: 'suggest', text: '✍️ Предложить объявление' },
  ]);
});

test('recognizes publication revision conflicts without matching unrelated failures', () => {
  assert.equal(isPublicationRevisionConflictError({ code: 'PUBLICATION_REVISION_CONFLICT' }), true);
  assert.equal(
    isPublicationRevisionConflictError({ code: 'PUBLICATION_SCHEDULE_CONFLICT' }),
    false,
  );
  assert.equal(isPublicationRevisionConflictError(new Error('Failed to fetch')), false);
});

test('recognizes current publication calendar conflict copy', () => {
  assert.equal(
    isPublicationScheduleConflictMessage('В выбранное время уже запланирована публикация.'),
    true,
  );
  assert.equal(isPublicationScheduleConflictMessage('Сервис временно недоступен.'), false);
  assert.equal(
    isPublicationScheduleConflictMessage(
      'Конфликтующая публикация включает другие чаты или каналы. Измените её отдельно.',
    ),
    false,
  );
  assert.equal(
    isPublicationScheduleConflictError(
      Object.assign(new Error('Любой текст'), { code: 'PUBLICATION_SCHEDULE_CONFLICT' }),
    ),
    true,
  );
  assert.equal(
    isPublicationScheduleConflictError(
      Object.assign(new Error('Конфликт'), {
        code: 'PUBLICATION_CONFLICT_REQUIRES_MANUAL_REVIEW',
      }),
    ),
    false,
  );
});

test('reviews replaceable conflicts once for every scheduled mode', () => {
  const conflict = Object.assign(new Error('Это время уже занято другой публикацией.'), {
    code: 'PUBLICATION_SCHEDULE_CONFLICT',
  });
  const draft = createEmptyPublicationDraft([chatTarget]);

  draft.timingMode = 'once';
  assert.equal(shouldReviewPublicationScheduleConflict(conflict, draft, false), true);

  draft.timingMode = 'schedule';
  draft.scheduleKind = 'slots';
  assert.equal(shouldReviewPublicationScheduleConflict(conflict, draft, false), true);

  draft.scheduleKind = 'recurrence';
  assert.equal(shouldReviewPublicationScheduleConflict(conflict, draft, false), true);
  assert.equal(shouldReviewPublicationScheduleConflict(conflict, draft, true), false);

  draft.timingMode = 'now';
  assert.equal(shouldReviewPublicationScheduleConflict(conflict, draft, false), false);
});

test('only paused publications expose resume', () => {
  assert.equal(canResumePublication('PAUSED'), true);
  assert.equal(canResumePublication('ERROR'), false);
  assert.equal(canResumePublication('ACTIVE'), false);
});

test('infers safe video MIME types when Android omits file.type', () => {
  assert.equal(inferPublicationVideoMimeType('clip.mp4', ''), 'video/mp4');
  assert.equal(inferPublicationVideoMimeType('clip.MOV', ''), 'video/quicktime');
  assert.equal(inferPublicationVideoMimeType('clip.webm', ''), 'video/webm');
  assert.equal(inferPublicationVideoMimeType('clip.mkv', ''), 'video/x-matroska');
  assert.equal(inferPublicationVideoMimeType('clip.mkv', 'video/matroska'), 'video/x-matroska');
  assert.equal(
    inferPublicationVideoMimeType('clip.MKV', 'application/octet-stream'),
    'video/x-matroska',
  );
  assert.equal(inferPublicationVideoMimeType('clip.mp4', 'video/mp4'), 'video/mp4');
  assert.equal(inferPublicationVideoMimeType('clip.m4v', ''), null);
  assert.equal(inferPublicationVideoMimeType('clip.avi', 'video/x-msvideo'), null);
  assert.equal(inferPublicationVideoMimeType('clip.qt', 'video/quicktime'), 'video/quicktime');
  assert.equal(inferPublicationVideoMimeType('clip.bin', ''), null);
  for (const [fileName, expected] of [
    ['clip.mp4', 'video/mp4'],
    ['clip.MOV', 'video/quicktime'],
    ['clip.webm', 'video/webm'],
  ]) {
    assert.equal(inferPublicationVideoMimeType(fileName, 'application/octet-stream'), expected);
  }
  assert.equal(inferPublicationVideoMimeType('clip.bin', 'application/octet-stream'), null);
  assert.equal(inferPublicationVideoMimeType('clip.constructor', ''), null);
  assert.equal(inferPublicationVideoMimeType('clip.constructor', 'application/octet-stream'), null);
  assert.equal(inferPublicationVideoMimeType('clip.mp4', 'text/plain'), null);
});

test('filters new slots with the default margin and lets saved schedules retain imminent times', () => {
  const nowMs = Date.parse('2026-08-01T08:00:00.000Z');
  assert.deepEqual(
    filterFuturePublicationSlots(
      [
        '2026-08-01T07:00:00.000Z',
        '2026-08-01T08:01:00.000Z',
        '2026-08-01T08:30:00.000Z',
        '2026-08-02T08:30:00.000Z',
      ],
      nowMs,
    ),
    ['2026-08-01T08:30:00.000Z', '2026-08-02T08:30:00.000Z'],
  );
  assert.deepEqual(
    filterFuturePublicationSlots(
      ['2026-08-01T07:00:00.000Z', '2026-08-01T08:00:00.000Z', '2026-08-01T08:01:00.000Z'],
      nowMs,
      0,
    ),
    ['2026-08-01T08:00:00.000Z', '2026-08-01T08:01:00.000Z'],
  );
});

test('builds a publication with mixed chat and channel targets and finite slots', () => {
  const draft = createEmptyPublicationDraft([chatTarget, channelTarget]);
  draft.text = 'Плановый пост';
  draft.timingMode = 'schedule';
  draft.scheduleKind = 'slots';
  draft.scheduledSlots = ['2026-08-01T07:00:00.000Z', '2026-08-02T07:00:00.000Z'];

  const request = buildCreatePublicationRequest(draft, 'request_slots_001');

  assert.deepEqual(request.audience.targets, [
    { chatId: 'chat-1', entityType: 'chat' },
    { chatId: 'channel-1', entityType: 'channel' },
  ]);
  assert.deepEqual(request.schedule, {
    mode: 'slots',
    timezone: draft.scheduleTimezone,
    slots: draft.scheduledSlots,
    replaceConflicts: false,
    latePolicy: { mode: 'recover', maxDelayMinutes: 1440, catchUp: 'latest' },
  });
});

test('builds daily and weekly recurrence requests with conflict replacement', () => {
  const draft = createEmptyPublicationDraft([channelTarget]);
  draft.text = 'Регулярный пост';
  draft.timingMode = 'schedule';
  draft.scheduleKind = 'recurrence';
  draft.recurrence = {
    frequency: 'weekly',
    interval: 2,
    weekdays: [1, 5],
    times: ['09:00', '18:30'],
    startsAt: '2026-08-01T00:00:00.000Z',
    endsAt: null,
    maxOccurrences: 20,
  };

  const request = buildCreatePublicationRequest(draft, 'request_cycle_001', {
    replaceConflicts: true,
  });

  assert.deepEqual(request.schedule, {
    mode: 'recurrence',
    timezone: draft.scheduleTimezone,
    frequency: 'weekly',
    interval: 2,
    weekdays: [1, 5],
    times: ['09:00', '18:30'],
    startsAt: '2026-08-01T00:00:00.000Z',
    endsAt: null,
    maxOccurrences: 20,
    replaceConflicts: true,
    latePolicy: { mode: 'recover', maxDelayMinutes: 1440, catchUp: 'latest' },
  });
});

test('keeps retained asset references and builds a real video payload', () => {
  const retainedDraft = createEmptyPublicationDraft([chatTarget]);
  retainedDraft.text = 'Фото остаётся';
  retainedDraft.retainedAssets = [
    {
      id: 'asset-image-1',
      type: 'image',
      mimeType: 'image/jpeg',
      fileName: 'photo.jpg',
      sizeBytes: 120,
    },
    {
      id: 'asset-image-2',
      type: 'image',
      mimeType: 'image/png',
      fileName: 'second.png',
      sizeBytes: 90,
    },
  ];
  retainedDraft.images = [{ base64: 'bmV3LWltYWdl', mimeType: 'image/jpeg', fileName: 'new.jpg' }];
  assert.deepEqual(buildPublicationContent(retainedDraft).media, [
    { type: 'image-ref', assetId: 'asset-image-1' },
    { type: 'image-ref', assetId: 'asset-image-2' },
    {
      type: 'image',
      base64: 'bmV3LWltYWdl',
      mimeType: 'image/jpeg',
      fileName: 'new.jpg',
    },
  ]);

  const videoDraft = createEmptyPublicationDraft([channelTarget]);
  videoDraft.mediaType = 'video';
  videoDraft.mediaBase64 = 'dmlkZW8=';
  videoDraft.mediaMimeType = 'video/mp4';
  videoDraft.mediaFileName = 'clip.mp4';
  assert.deepEqual(buildPublicationContent(videoDraft).media, [
    {
      type: 'video',
      payload: null,
      base64: 'dmlkZW8=',
      mimeType: 'video/mp4',
      fileName: 'clip.mp4',
    },
  ]);
});

test('test publication request contains content and source target without a schedule', () => {
  const draft = createEmptyPublicationDraft([chatTarget]);
  draft.text = 'Тест';
  draft.timingMode = 'schedule';

  const request = buildTestPublicationRequest(draft, 'request_test_001');

  assert.equal('schedule' in request, false);
  assert.deepEqual(request.sourceTarget, { chatId: 'chat-1', entityType: 'chat' });
});

test('publication media mutations reserve enough time for mobile uploads', async () => {
  const calls: Array<{ path: string; init?: ApiRequestInit }> = [];
  const api: ApiTransport = {
    request: async (path, init) => {
      calls.push({ path, init });
      throw new Error('stop');
    },
    requestKeepalive: () => undefined,
  };
  const draft = createEmptyPublicationDraft([chatTarget, channelTarget]);
  draft.text = 'Проверка маршрута';
  draft.mediaType = 'video';
  draft.mediaBase64 = 'dmlkZW8=';
  draft.mediaMimeType = 'video/mp4';
  draft.mediaFileName = 'clip.mp4';

  await assert.rejects(
    createPublication(api, buildCreatePublicationRequest(draft, 'request_create_001')),
    /stop/u,
  );
  await assert.rejects(
    testPublication(api, buildTestPublicationRequest(draft, 'request_test_002')),
    /stop/u,
  );
  await assert.rejects(
    updatePublication(api, 'publication-1', {
      expectedRevision: 1,
      requestId: 'request_update_003',
      content: buildPublicationContent(draft),
    }),
    /stop/u,
  );
  const textOnlyDraft = createEmptyPublicationDraft([chatTarget]);
  textOnlyDraft.text = 'Только текст';
  await assert.rejects(
    createPublication(api, buildCreatePublicationRequest(textOnlyDraft, 'request_create_004')),
    /stop/u,
  );

  assert.deepEqual(
    calls.map((call) => [call.path, call.init?.method, call.init?.timeoutMs]),
    [
      ['/publications', 'POST', PUBLICATION_MEDIA_MUTATION_TIMEOUT_MS],
      ['/publications/test', 'POST', PUBLICATION_MEDIA_MUTATION_TIMEOUT_MS],
      ['/publications/publication-1', 'PUT', PUBLICATION_MEDIA_MUTATION_TIMEOUT_MS],
      ['/publications', 'POST', undefined],
    ],
  );
});

test('publication client sends optimistic revisions for a latest-content retry', async () => {
  const calls: Array<{ path: string; init?: ApiRequestInit }> = [];
  const api: ApiTransport = {
    request: async (path, init) => {
      calls.push({ path, init });
      throw new Error('stop');
    },
    requestKeepalive: () => undefined,
  };

  await assert.rejects(
    retryPublicationOccurrence(api, 'publication-1', 'occurrence-1', {
      requestId: 'retry_latest_001',
      contentMode: 'latest',
      expectedPublicationVersion: 7,
      expectedContentRevision: 4,
    }),
    /stop/u,
  );

  assert.equal(calls[0]?.path, '/publications/publication-1/occurrences/occurrence-1/retry');
  assert.deepEqual(JSON.parse(String(calls[0]?.init?.body)), {
    requestId: 'retry_latest_001',
    contentMode: 'latest',
    expectedPublicationVersion: 7,
    expectedContentRevision: 4,
  });
});

test('publication client requests target-aware calendar availability', async () => {
  const calls: Array<{ path: string; init?: ApiRequestInit }> = [];
  const api: ApiTransport = {
    request: async (path, init) => {
      calls.push({ path, init });
      return {
        from: '2026-08-01T00:00:00.000Z',
        to: '2026-08-31T23:59:59.999Z',
        slots: [{ scheduledAt: '2026-08-01T09:00:00.000Z', targetCount: 1 }],
      };
    },
    requestKeepalive: () => undefined,
  };

  const result = await getPublicationCalendarAvailability(api, {
    audience: {
      selection: 'SELECTED',
      mode: 'SNAPSHOT',
      targets: [{ chatId: chatTarget.id, entityType: chatTarget.entityType }],
    },
    from: '2026-08-01T00:00:00.000Z',
    to: '2026-08-31T23:59:59.999Z',
  });

  assert.deepEqual(result.slots, [{ scheduledAt: '2026-08-01T09:00:00.000Z', targetCount: 1 }]);
  assert.deepEqual(
    calls.map((call) => [call.path, call.init?.method]),
    [['/publications/calendar-availability', 'POST']],
  );
});
