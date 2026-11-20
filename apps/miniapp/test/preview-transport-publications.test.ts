import assert from 'node:assert/strict';
import test from 'node:test';
import { createPreviewApiTransport } from '../src/lib/api/preview-transport';
import { ApiRequestError } from '../src/lib/api-request-error';
import {
  buildPublicationContent,
  createPublicationDraftFromDetails,
} from '../src/features/publications/publication-model';
import {
  cancelPublication,
  createPublication,
  getPublication,
  listLegacyPublications,
  listPublicationDeliveries,
  listPublications,
  pausePublication,
  refreshPublicationTargets,
  resolvePublicationAmbiguousDelivery,
  reschedulePublicationOccurrence,
  resumePublication,
  retryPublicationOccurrence,
  testPublication,
  updatePublication,
} from '../src/lib/api/publication-client';
import { getPublicationSchedulePreview } from '../src/lib/api/publication-schedule-preview-client';

test('preview moves a single release once and creates a distinct continuation with its remaining count', async () => {
  const api = createPreviewApiTransport({
    search: '?profile=publisher',
    clock: { now: () => new Date('2030-01-01T00:00:00.000Z') },
  });
  const source = await getPublication(api, 'publication-neighborhood-digest');
  const [first, second, third] = source.occurrences;
  assert.ok(first && second && third && source.schedule?.mode === 'recurrence');
  const move = {
    scope: 'occurrence' as const,
    at: new Date(Date.parse(first.scheduledAt) + 60_000).toISOString(),
    expectedRevision: source.version,
    requestId: 'preview-single-move',
  };
  const single = await reschedulePublicationOccurrence(api, source.id, first.id, move);
  assert.equal(single.publication.schedule?.mode, 'once');
  assert.equal(single.publication.schedule.nextOccurrenceAt, move.at);
  assert.equal(single.source.occurrences.find(({ id }) => id === first.id)?.status, 'CANCELED');
  assert.equal(single.source.occurrences.find(({ id }) => id === second.id)?.status, 'SCHEDULED');
  assert.deepEqual(await reschedulePublicationOccurrence(api, source.id, first.id, move), single);

  const continuation = await reschedulePublicationOccurrence(api, source.id, third.id, {
    scope: 'following',
    schedule: {
      ...source.schedule,
      startsAt: new Date(Date.parse(third.scheduledAt) + 86_400_000).toISOString(),
      times: ['13:37'],
    },
    expectedRevision: single.source.version,
    requestId: 'preview-series-split',
  });
  assert.equal(continuation.publication.schedule?.mode, 'recurrence');
  assert.equal(
    continuation.publication.schedule.maxOccurrences,
    source.schedule.maxOccurrences! - 2,
  );
  assert.equal(
    continuation.source.occurrences.find(({ id }) => id === second.id)?.status,
    'SCHEDULED',
  );
  assert.equal(
    continuation.source.occurrences.find(({ id }) => id === third.id)?.status,
    'CANCELED',
  );
});

test('preview transport does not present its sample recurrence dates as the series bounds', async () => {
  const api = createPreviewApiTransport({ search: '?profile=publisher' });
  const source = await getPublication(api, 'publication-neighborhood-digest');
  const result = await getPublicationSchedulePreview(
    api,
    { editing: { publicationId: source.id, expectedRevision: source.version } },
    new AbortController().signal,
  );
  assert.deepEqual(result, {
    state: 'unavailable',
    firstOccurrenceAt: null,
    lastOccurrenceAt: null,
    timezone: source.schedule?.timezone,
  });
});

test('preview publications support list, CRUD, actions, and delivery review', async () => {
  const api = createPreviewApiTransport();
  const current = await listPublications(api, { view: 'current', limit: 100 });
  const plan = await listPublications(api, { view: 'plan', limit: 100 });
  const schedules = await listPublications(api, { view: 'schedules', limit: 100 });
  const history = await listPublications(api, { view: 'history', limit: 100 });
  const channelSchedules = await listPublications(api, {
    view: 'schedules',
    entityType: 'channel',
    limit: 100,
  });
  const failed = await listPublications(api, { view: 'plan', status: 'failed', limit: 100 });
  const firstPlanPage = await listPublications(api, { view: 'plan', limit: 1 });

  assert.ok(current.items.length > 0);
  assert.equal(
    current.items.every((publication) => publication.schedule?.mode === 'now'),
    true,
  );
  assert.equal(
    plan.items.some((publication) => publication.lifecycle === 'ACTIVE'),
    true,
  );
  assert.equal(
    plan.items.some((publication) => publication.lifecycle === 'PAUSED'),
    true,
  );
  assert.equal(
    history.items.some((publication) => publication.lifecycle === 'COMPLETED'),
    true,
  );
  assert.ok(schedules.items.length > 0);
  assert.equal(
    schedules.items.every(
      (publication) =>
        publication.schedule?.mode === 'once' ||
        publication.schedule?.mode === 'slots' ||
        publication.schedule?.mode === 'recurrence',
    ),
    true,
  );
  assert.ok(channelSchedules.items.length > 0);
  assert.equal(
    channelSchedules.items.every(
      (publication) =>
        publication.audienceSelection === 'ALL_MANAGED' ||
        publication.audienceSelection === 'ALL_CHANNELS' ||
        publication.targetPreviews.some((target) => target.entityType === 'channel'),
    ),
    true,
  );
  assert.ok(failed.items.length > 0);
  assert.equal(
    failed.items.every(
      (publication) =>
        publication.lifecycle === 'ERROR' ||
        publication.delivery.failed > 0 ||
        publication.delivery.ambiguous > 0,
    ),
    true,
  );
  assert.equal(typeof firstPlanPage.nextCursor, 'string');
  const secondPlanPage = await listPublications(api, {
    view: 'plan',
    limit: 1,
    cursor: firstPlanPage.nextCursor ?? undefined,
  });
  assert.notEqual(secondPlanPage.items[0]?.id, firstPlanPage.items[0]?.id);

  const review = await getPublication(api, 'publication-delivery-review');
  const plainDraft = createPublicationDraftFromDetails({
    ...review,
    content: { ...review.content, text: '**literal**', textFormat: 'plain' },
  });
  const markdownDraft = createPublicationDraftFromDetails({
    ...review,
    content: { ...review.content, text: '**rich**', textFormat: 'markdown' },
  });
  assert.equal(plainDraft.textFormat, 'plain');
  assert.equal(markdownDraft.textFormat, 'markdown');
  assert.equal(buildPublicationContent(plainDraft).textFormat, 'plain');
  assert.equal(buildPublicationContent(markdownDraft).textFormat, 'markdown');
  const ambiguousDeliveries = await listPublicationDeliveries(api, review.id, {
    status: 'AMBIGUOUS',
    limit: 1,
  });
  assert.equal(
    ambiguousDeliveries.items.every((delivery) => delivery.status === 'AMBIGUOUS'),
    true,
  );
  const regularDeliveries = await listPublicationDeliveries(api, review.id, {
    excludeStatus: 'AMBIGUOUS',
    limit: 100,
  });
  assert.equal(
    regularDeliveries.items.every((delivery) => delivery.status !== 'AMBIGUOUS'),
    true,
  );
  const ambiguous = ambiguousDeliveries.items[0];
  assert.ok(ambiguous);

  const resolved = await resolvePublicationAmbiguousDelivery(
    api,
    review.id,
    ambiguous.occurrenceId,
    {
      requestId: 'resolve_request_001',
      deliveryId: ambiguous.id,
      resolution: 'mark_failed',
    },
  );
  assert.equal(resolved.occurrences[0]?.canRetry, true);

  const retried = await retryPublicationOccurrence(api, review.id, ambiguous.occurrenceId, {
    requestId: 'retry_request_001',
    contentMode: 'latest',
    expectedPublicationVersion: resolved.version,
    expectedContentRevision: resolved.content.revision,
  });
  assert.equal(retried.delivery.failed, 0);
  assert.equal(retried.delivery.sent > 0, true);
  assert.equal(retried.occurrences[0]?.usesLatestContent, true);
  assert.equal(retried.occurrences[0]?.contentRevision, retried.content.revision);
  const retriedDeliveries = await listPublicationDeliveries(api, review.id, {
    occurrenceId: ambiguous.occurrenceId,
    limit: 100,
  });
  assert.equal(retriedDeliveries.items[0]?.usesLatestContent, true);
  assert.equal(retriedDeliveries.items[0]?.contentRevision, retried.content.revision);

  await testPublication(api, {
    requestId: 'test_request_001',
    content: {
      text: 'Тестовая отправка',
      textFormat: 'markdown',
      buttons: [],
      media: [],
    },
    sourceTarget: { chatId: 'preview-chat', entityType: 'chat' },
  });

  const created = await createPublication(api, {
    requestId: 'create_request_001',
    title: 'Новая публикация',
    content: {
      text: 'Один пост для чата и канала',
      textFormat: 'markdown',
      buttons: [],
      media: [],
    },
    audience: {
      selection: 'SELECTED',
      mode: 'SNAPSHOT',
      targets: [
        { chatId: 'preview-chat', entityType: 'chat' },
        { chatId: 'preview-channel', entityType: 'channel' },
      ],
    },
    schedule: {
      mode: 'once',
      timezone: 'Europe/Moscow',
      at: '2027-01-01T09:00:00.000Z',
      replaceConflicts: false,
    },
    intent: 'publish',
  });
  assert.equal(created.targetCount, 2);
  assert.equal(created.contentPreviewFormat, 'plain');
  const schedulesWithCreated = await listPublications(api, { view: 'schedules', limit: 100 });
  assert.equal(
    schedulesWithCreated.items.some((publication) => publication.id === created.id),
    true,
  );

  const updated = await updatePublication(api, created.id, {
    expectedRevision: created.version,
    requestId: 'update_request_001',
    title: 'Обновлённая публикация',
  });
  assert.equal(updated.title, 'Обновлённая публикация');

  const paused = await pausePublication(api, updated.id, {
    expectedRevision: updated.version,
    requestId: 'pause_request_001',
  });
  assert.equal(paused.lifecycle, 'PAUSED');
  const resumed = await resumePublication(api, paused.id, {
    expectedRevision: paused.version,
    requestId: 'resume_request_001',
  });
  assert.equal(resumed.lifecycle, 'ACTIVE');
  const canceled = await cancelPublication(api, resumed.id, {
    expectedRevision: resumed.version,
    requestId: 'cancel_request_001',
  });
  assert.equal(canceled.lifecycle, 'CANCELED');
});

test('publisher preview exposes and clears the access-required publication state', async () => {
  const api = createPreviewApiTransport({ search: '?profile=publisher' });
  const before = await getPublication(api, 'publication-access-required');

  assert.equal(before.dispatchIssue, 'actor_access_required');
  assert.equal(before.occurrences[0]?.dispatchIssue, 'actor_access_required');
  assert.equal(before.occurrences[0]?.status, 'IN_PROGRESS');
  assert.equal(before.delivery.total, 0);
  assert.equal(before.occurrences[0]?.delivery.total, 0);

  const refresh = await refreshPublicationTargets(api, before.id);
  assert.equal(refresh.accepted, true);
  assert.equal(refresh.queuedCount, 1);
  assert.ok(refresh.operationId);
  const after = await getPublication(api, before.id);
  assert.equal(after.dispatchIssue, null);
  assert.equal(after.occurrences[0]?.dispatchIssue, null);
});

for (const [window, status] of [
  ['stopped-pending', 'PENDING'],
  ['stopped-sending', 'SENDING'],
  ['stopped-ambiguous', 'AMBIGUOUS'],
] as const) {
  test(`publisher preview preserves stopped ${status} evidence and raw counters`, async () => {
    const api = createPreviewApiTransport({
      search: `?profile=publisher&publicationWindow=${window}`,
    });
    for (let refresh = 0; refresh < 2; refresh += 1) {
      const publication = await getPublication(api, 'publication-access-required');
      const deliveries = await listPublicationDeliveries(api, publication.id, { limit: 100 });
      assert.equal(publication.lifecycle, 'ACTIVE');
      assert.equal(publication.dispatchIssue, null);
      assert.equal(publication.occurrences[0]?.status, 'CANCELED');
      assert.equal(publication.occurrences[0]?.canRetry, false);
      assert.equal(publication.delivery.total, 1);
      assert.equal(publication.delivery.pending, status === 'AMBIGUOUS' ? 0 : 1);
      assert.equal(publication.delivery.ambiguous, status === 'AMBIGUOUS' ? 1 : 0);
      assert.equal(publication.delivery.dispatchPending, undefined);
      assert.equal(publication.actionableDelivery?.dispatchPending, 0);
      assert.equal(deliveries.items.length, 1);
      assert.equal(deliveries.items[0]?.status, status);
      assert.equal(deliveries.items[0]?.dispatchStopped, true);
      assert.equal(deliveries.items[0]?.attemptCount, 1);
      assert.equal(deliveries.items[0]?.waitReason, 'max_rate_limit');
      assert.ok(deliveries.items[0]?.nextAttemptAt);
      assert.ok(deliveries.items[0]?.deadlineAt);
    }
  });
}

test('preview legacy publications support bound cursors, filters, and history', async () => {
  const api = createPreviewApiTransport();
  const active = await listLegacyPublications(api, { view: 'active', limit: 30 });

  assert.equal(active.totalCount, 4);
  assert.equal(active.items.length, 4);
  assert.equal(
    active.items.every((item) =>
      item.kind === 'autopost'
        ? item.status === 'ACTIVE' || item.status === 'PAUSED' || item.status === 'ERROR'
        : item.status === 'ACTIVE' || item.status === 'PARTIAL' || item.status === 'FAILED',
    ),
    true,
  );
  assert.equal(
    active.items.every((item) => item.source.title.length > 0),
    true,
  );

  const autoposts = await listLegacyPublications(api, {
    view: 'active',
    kind: 'autopost',
    limit: 30,
  });
  assert.equal(autoposts.totalCount, 2);
  assert.equal(
    autoposts.items.every((item) => item.kind === 'autopost'),
    true,
  );

  const channels = await listLegacyPublications(api, {
    view: 'active',
    entityType: 'channel',
    limit: 30,
  });
  assert.equal(channels.totalCount, 2);
  assert.equal(
    channels.items.every((item) => item.source.entityType === 'channel'),
    true,
  );

  const searched = await listLegacyPublications(api, {
    view: 'active',
    query: 'грунты',
    limit: 30,
  });
  assert.deepEqual(
    searched.items.map((item) => `${item.kind}:${item.id}`),
    ['autopost:autopost-preview-soil'],
  );

  const history = await listLegacyPublications(api, { view: 'history', limit: 30 });
  assert.equal(history.totalCount, 2);
  assert.equal(
    history.items.every((item) =>
      item.kind === 'autopost'
        ? item.status === 'COMPLETED'
        : item.status === 'COMPLETED' || item.status === 'CANCELED',
    ),
    true,
  );

  const firstPage = await listLegacyPublications(api, { view: 'active', limit: 1 });
  assert.equal(firstPage.items.length, 1);
  assert.equal(typeof firstPage.nextCursor, 'string');
  const secondPage = await listLegacyPublications(api, {
    view: 'active',
    limit: 1,
    cursor: firstPage.nextCursor ?? undefined,
  });
  assert.notEqual(
    `${secondPage.items[0]?.kind}:${secondPage.items[0]?.id}`,
    `${firstPage.items[0]?.kind}:${firstPage.items[0]?.id}`,
  );

  await assert.rejects(
    listLegacyPublications(api, {
      view: 'active',
      kind: 'broadcast',
      limit: 1,
      cursor: firstPage.nextCursor ?? undefined,
    }),
    /cursor is invalid/u,
  );
});

test('preview publications expose schedule conflicts and allow explicit replacement', async () => {
  const api = createPreviewApiTransport();
  const occupiedAt = '2034-11-15T15:30:00.000Z';
  const request = {
    requestId: 'conflict_request_001',
    title: 'Конфликт',
    content: {
      text: 'Проверка конфликта',
      textFormat: 'markdown' as const,
      buttons: [],
      media: [],
    },
    audience: {
      selection: 'SELECTED' as const,
      mode: 'SNAPSHOT' as const,
      targets: [{ chatId: 'preview-chat', entityType: 'chat' as const }],
    },
    schedule: {
      mode: 'once' as const,
      timezone: 'Europe/Moscow',
      at: occupiedAt,
      replaceConflicts: false,
    },
    intent: 'publish' as const,
  };
  const existing = await createPublication(api, { ...request, requestId: 'conflict_existing_001' });

  let confirmation: string | undefined;
  await assert.rejects(createPublication(api, request), (error: unknown) => {
    assert.ok(error instanceof ApiRequestError);
    assert.equal(error.code, 'PUBLICATION_SCHEDULE_CONFLICT');
    assert.deepEqual(error.payload?.conflicts, [
      { chatId: 'preview-chat', scheduledAt: occupiedAt },
    ]);
    assert.equal(error.payload?.conflictCount, 1);
    assert.equal(typeof error.payload?.conflictConfirmation, 'string');
    confirmation = error.payload?.conflictConfirmation as string;
    return true;
  });

  await assert.rejects(
    createPublication(api, {
      ...request,
      requestId: 'conflict_bad_confirmation',
      schedule: {
        ...request.schedule,
        replaceConflicts: true,
        conflictConfirmation: '1'.repeat(64),
      },
    }),
    { code: 'PUBLICATION_SCHEDULE_CONFLICT' },
  );

  const replaced = await createPublication(api, {
    ...request,
    requestId: 'conflict_request_002',
    schedule: { ...request.schedule, replaceConflicts: true, conflictConfirmation: confirmation },
  });
  assert.equal(replaced.lifecycle, 'ACTIVE');
  assert.equal((await getPublication(api, existing.id)).occurrences[0]?.status, 'CANCELED');
  assert.ok(!replaced.schedule || !('conflictConfirmation' in replaced.schedule));
});
