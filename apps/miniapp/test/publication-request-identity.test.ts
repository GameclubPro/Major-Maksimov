import assert from 'node:assert/strict';
import test from 'node:test';
import { createEmptyPublicationDraft } from '../src/features/publications/publication-model';
import {
  PUBLICATION_TEST_RESULT_PENDING_FEEDBACK,
  arePublicationRequestKeysEqual,
  buildPublicationActionRequestKey,
  buildPublicationAmbiguousRequestKey,
  buildPublicationRetryRequestKey,
  buildPublicationSaveRequestKey,
  buildPublicationTestRequestKey,
  fingerprintPublicationRequestKey,
  isPublicationTestResultPendingError,
  resolvePublicationCreateRequestIdentity,
  resolvePublicationRequestIdentity,
  type PublicationRequestIdentity,
  type PublicationRequestKey,
} from '../src/features/publications/publication-request-identity';
import {
  preparePublicationSave,
  resolvePublicationSaveRequestContext,
} from '../src/features/publications/publication-save-request';
import type { ApiTransport } from '../src/lib/api/transport';

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
  channelOverview: null,
};

function createIdentityResolver() {
  let sequence = 0;
  return (
    current: PublicationRequestIdentity | null,
    key: PublicationRequestKey,
  ): PublicationRequestIdentity =>
    resolvePublicationRequestIdentity(current, key, () => `request-id-${++sequence}`);
}

test('save context retains cloud identity and only enables a partial request for an existing edit', () => {
  const draft = createEmptyPublicationDraft([chatTarget]);
  const edit = {
    kind: 'edit' as const,
    publicationId: 'saved-post',
    expectedRevision: 4,
    editScope: 'future' as const,
  };
  assert.deepEqual(resolvePublicationSaveRequestContext(draft, null, true), { kind: 'create' });
  assert.deepEqual(resolvePublicationSaveRequestContext(draft, edit, true), {
    ...edit,
    contentOnly: true,
  });
  const imported = {
    kind: 'import' as const,
    publicationId: 'imported',
    expectedRevision: 3,
    sessionId: 'session',
  };
  assert.deepEqual(resolvePublicationSaveRequestContext(draft, imported, true), imported);
  assert.deepEqual(
    resolvePublicationSaveRequestContext(
      { ...draft, cloudDraft: { id: 'cloud-draft', revision: 7 } },
      { kind: 'duplicate' },
      true,
    ),
    { kind: 'draft', publicationId: 'cloud-draft', expectedRevision: 7 },
  );
});

test('a prepared save retains its exact partial payload across access refresh retries', async () => {
  const draft = createEmptyPublicationDraft([chatTarget]);
  draft.text = 'Исходный текст';
  const context = {
    kind: 'edit' as const,
    publicationId: 'saved-post',
    expectedRevision: 4,
    editScope: 'future' as const,
    contentOnly: true,
  };
  const calls: { path: string; body: unknown }[] = [];
  const api: ApiTransport = {
    request: async (path, init) => {
      calls.push({ path, body: JSON.parse(String(init?.body)) });
      throw new Error('transport unavailable');
    },
    requestKeepalive() {},
  };
  const save = preparePublicationSave(api, draft, context, 'stable_request', false);
  draft.text = 'Другой текст';
  await assert.rejects(save(), /transport unavailable/u);
  await assert.rejects(save(), /transport unavailable/u);
  assert.deepEqual(calls[0], calls[1]);
  assert.equal(calls[0]?.path, '/publications/saved-post');
  assert.equal((calls[0]?.body as { content: { text: string } }).content.text, 'Исходный текст');
  assert.equal('schedule' in (calls[0]?.body as object), false);
});

test('reuses a save request ID until payload, context, or replacement intent changes', () => {
  const draft = createEmptyPublicationDraft([chatTarget]);
  draft.title = 'План';
  draft.text = 'Текст';
  draft.timingMode = 'once';
  draft.scheduledSlots = ['2026-08-01T10:00:00.000Z'];
  const resolveIdentity = createIdentityResolver();

  const initialKey = buildPublicationSaveRequestKey(draft, { kind: 'create' }, false);
  const initial = resolveIdentity(null, initialKey);
  const unchanged = resolveIdentity(
    initial,
    buildPublicationSaveRequestKey(draft, { kind: 'create' }, false),
  );
  assert.equal(unchanged.requestId, initial.requestId);

  draft.title = '  План  ';
  const normalizedTitle = resolveIdentity(
    unchanged,
    buildPublicationSaveRequestKey(draft, { kind: 'create' }, false),
  );
  assert.equal(normalizedTitle.requestId, initial.requestId);

  const replacement = resolveIdentity(
    normalizedTitle,
    buildPublicationSaveRequestKey(draft, { kind: 'create' }, true),
  );
  assert.notEqual(replacement.requestId, initial.requestId);

  const duplicateContext = resolveIdentity(
    replacement,
    buildPublicationSaveRequestKey(draft, { kind: 'duplicate' }, true),
  );
  assert.notEqual(duplicateContext.requestId, replacement.requestId);

  draft.text = 'Новая версия';
  const changedPayload = resolveIdentity(
    duplicateContext,
    buildPublicationSaveRequestKey(draft, { kind: 'duplicate' }, true),
  );
  assert.notEqual(changedPayload.requestId, duplicateContext.requestId);

  const changedEndpoint = resolveIdentity(
    changedPayload,
    buildPublicationSaveRequestKey(
      draft,
      { kind: 'edit', publicationId: 'publication-1', expectedRevision: 2 },
      true,
    ),
  );
  assert.notEqual(changedEndpoint.requestId, changedPayload.requestId);

  const importedDraftKey = buildPublicationSaveRequestKey(
    draft,
    {
      kind: 'import',
      publicationId: 'publication-imported',
      expectedRevision: 1,
      sessionId: 'session-1',
    },
    false,
  );
  assert.match(JSON.stringify(importedDraftKey), /"operation":"update"/u);
});

test('rotates the request ID after a confirmed success clears the current identity', () => {
  const draft = createEmptyPublicationDraft([chatTarget]);
  draft.text = 'Текст';
  const resolveIdentity = createIdentityResolver();
  const key = buildPublicationSaveRequestKey(draft, { kind: 'create' }, false);

  const beforeSuccess = resolveIdentity(null, key);
  const afterSuccess = resolveIdentity(null, key);

  assert.notEqual(afterSuccess.requestId, beforeSuccess.requestId);
});

test('save identity distinguishes a retry version from an explicit schedule repair', () => {
  const draft = createEmptyPublicationDraft([chatTarget]);
  draft.text = 'Исправленный текст';
  const context = { kind: 'edit' as const, publicationId: 'publication-1', expectedRevision: 2 };
  const retryKey = buildPublicationSaveRequestKey(draft, { ...context, editScope: 'retry' }, false);
  const repairKey = buildPublicationSaveRequestKey(
    draft,
    { ...context, editScope: 'schedule' },
    false,
  );
  assert.equal(JSON.stringify(retryKey).includes('"schedule":'), false);
  assert.equal(JSON.stringify(repairKey).includes('"schedule":'), true);
  assert.equal(arePublicationRequestKeysEqual(retryKey, repairKey), false);
});

test('a single scheduled retry save preserves the existing audience and send intent', () => {
  const draft = createEmptyPublicationDraft([chatTarget]);
  draft.text = 'Исправленный текст';
  draft.timingMode = 'once';
  draft.scheduledSlots = ['2026-09-01T16:30:00.000Z'];
  const key = buildPublicationSaveRequestKey(
    draft,
    {
      kind: 'edit',
      publicationId: 'publication-live-all',
      expectedRevision: 2,
      editScope: 'retry',
    },
    false,
  );
  const payload = (key as { payload: Record<string, unknown> }).payload;
  assert.equal('audience' in payload, false);
  assert.equal('schedule' in payload, false);
  assert.equal('intent' in payload, false);
  assert.equal(payload.expectedRevision, 2);
});

test('content-only future edits fingerprint the exact partial update separately from schedule changes', () => {
  const draft = createEmptyPublicationDraft([chatTarget]);
  draft.text = 'Исправленный текст';
  draft.timingMode = 'once';
  draft.onceDate = '2030-01-01';
  draft.onceTime = '13:00';
  draft.scheduledSlots = ['2030-01-01T10:00:00Z'];
  draft.scheduleTimezone = 'Europe/Moscow';
  const context = {
    kind: 'edit' as const,
    publicationId: 'publication-live',
    expectedRevision: 2,
    editScope: 'future' as const,
  };
  const partial = buildPublicationSaveRequestKey(draft, { ...context, contentOnly: true }, false);
  const full = buildPublicationSaveRequestKey(draft, { ...context, contentOnly: false }, false);
  const payload = (partial as { payload: Record<string, unknown> }).payload;
  assert.equal('audience' in payload, false);
  assert.equal('schedule' in payload, false);
  assert.equal('intent' in payload, false);
  assert.equal(arePublicationRequestKeysEqual(partial, full), false);
});

test('restores a lost pending create across reload without persisting payload content', () => {
  const draft = createEmptyPublicationDraft([chatTarget]);
  draft.title = 'Закрытый план';
  draft.text = 'Секретный текст публикации';
  draft.buttonEnabled = true;
  draft.buttons = [{ text: 'Открыть', url: 'https://internal.example/private' }];
  draft.images = [{ base64: 'c2VjcmV0LWltYWdl', mimeType: 'image/jpeg', fileName: 'private.jpg' }];
  const initialKey = buildPublicationSaveRequestKey(draft, { kind: 'create' }, false);
  let sequence = 0;
  const createRequestId = () => `persisted-request-${++sequence}`;

  const firstAttempt = resolvePublicationCreateRequestIdentity(
    null,
    initialKey,
    null,
    createRequestId,
  );
  const storedValue = JSON.stringify(firstAttempt.record);
  assert.deepEqual(Object.keys(firstAttempt.record).sort(), ['fingerprint', 'requestId']);
  assert.equal(storedValue.includes(draft.text), false);
  assert.equal(storedValue.includes(draft.images[0]?.base64 ?? ''), false);
  assert.equal(storedValue.includes(draft.buttons[0]?.url ?? ''), false);

  const afterReload = resolvePublicationCreateRequestIdentity(
    null,
    buildPublicationSaveRequestKey(draft, { kind: 'create' }, false),
    firstAttempt.record,
    createRequestId,
  );
  assert.equal(afterReload.identity.requestId, firstAttempt.identity.requestId);
  assert.equal(sequence, 1);

  const storageFailureFallback = resolvePublicationCreateRequestIdentity(
    firstAttempt.identity,
    initialKey,
    null,
    createRequestId,
  );
  assert.equal(storageFailureFallback.identity.requestId, firstAttempt.identity.requestId);
  assert.equal(sequence, 1);

  const unrelatedSave = resolvePublicationRequestIdentity(
    null,
    buildPublicationSaveRequestKey(draft, { kind: 'duplicate' }, false),
    createRequestId,
  );
  const restoredAfterOtherSave = resolvePublicationCreateRequestIdentity(
    unrelatedSave,
    initialKey,
    firstAttempt.record,
    createRequestId,
  );
  assert.equal(restoredAfterOtherSave.identity.requestId, firstAttempt.identity.requestId);

  draft.text = 'Фактически другой текст';
  const changedPayload = resolvePublicationCreateRequestIdentity(
    null,
    buildPublicationSaveRequestKey(draft, { kind: 'create' }, false),
    firstAttempt.record,
    createRequestId,
  );
  assert.notEqual(changedPayload.identity.requestId, firstAttempt.identity.requestId);
  assert.notEqual(changedPayload.record.fingerprint, firstAttempt.record.fingerprint);
});

test('pending create fingerprint covers replacement intent and full media payload', () => {
  const draft = createEmptyPublicationDraft([chatTarget]);
  draft.text = 'Публикация';
  draft.timingMode = 'once';
  draft.scheduledSlots = ['2026-08-01T10:00:00.000Z'];
  draft.images = [{ base64: 'aW1hZ2UtMQ==', mimeType: 'image/jpeg', fileName: 'one.jpg' }];
  const ordinaryKey = buildPublicationSaveRequestKey(draft, { kind: 'create' }, false);
  const replacementKey = buildPublicationSaveRequestKey(draft, { kind: 'create' }, true);
  assert.notEqual(
    fingerprintPublicationRequestKey(ordinaryKey),
    fingerprintPublicationRequestKey(replacementKey),
  );

  draft.images[0] = { ...draft.images[0]!, base64: 'aW1hZ2UtMg==' };
  assert.notEqual(
    fingerprintPublicationRequestKey(ordinaryKey),
    fingerprintPublicationRequestKey(
      buildPublicationSaveRequestKey(draft, { kind: 'create' }, false),
    ),
  );
});

test('test request identity ignores fields that the test endpoint does not receive', () => {
  const draft = createEmptyPublicationDraft([chatTarget, channelTarget]);
  draft.title = 'Заголовок';
  draft.text = 'Тест';
  draft.timingMode = 'schedule';
  draft.scheduleKind = 'slots';
  draft.scheduledSlots = ['2026-08-01T10:00:00.000Z'];
  const initialKey = buildPublicationTestRequestKey(draft);

  draft.title = 'Другой заголовок';
  draft.scheduleKind = 'recurrence';
  draft.recurrence.times = ['18:30'];
  draft.targets[1] = { ...channelTarget, id: 'channel-2' };
  const irrelevantChangesKey = buildPublicationTestRequestKey(draft);

  assert.equal(arePublicationRequestKeysEqual(initialKey, irrelevantChangesKey), true);

  draft.targets[0] = { ...chatTarget, id: 'chat-2' };
  const changedPrimaryTargetKey = buildPublicationTestRequestKey(draft);
  assert.equal(arePublicationRequestKeysEqual(initialKey, changedPrimaryTargetKey), false);

  draft.targets[0] = chatTarget;
  draft.text = 'Изменённый тест';
  const changedContentKey = buildPublicationTestRequestKey(draft);
  assert.equal(arePublicationRequestKeysEqual(initialKey, changedContentKey), false);
});

test('action request identity includes operation, publication, and expected revision', () => {
  const resolveIdentity = createIdentityResolver();
  const initial = resolveIdentity(
    null,
    buildPublicationActionRequestKey('publication-1', 'pause', 4),
  );
  const unchanged = resolveIdentity(
    initial,
    buildPublicationActionRequestKey('publication-1', 'pause', 4),
  );
  assert.equal(unchanged.requestId, initial.requestId);

  const changedAction = resolveIdentity(
    unchanged,
    buildPublicationActionRequestKey('publication-1', 'cancel', 4),
  );
  const changedRevision = resolveIdentity(
    changedAction,
    buildPublicationActionRequestKey('publication-1', 'cancel', 5),
  );
  const changedPublication = resolveIdentity(
    changedRevision,
    buildPublicationActionRequestKey('publication-2', 'cancel', 5),
  );
  assert.notEqual(changedAction.requestId, unchanged.requestId);
  assert.notEqual(changedRevision.requestId, changedAction.requestId);
  assert.notEqual(changedPublication.requestId, changedRevision.requestId);
});

test('retry request identity includes occurrence, content mode, and optimistic revisions', () => {
  const resolveIdentity = createIdentityResolver();
  const originalInput = {
    publicationId: 'publication-1',
    occurrenceId: 'occurrence-1',
    contentMode: 'original' as const,
  };
  const initial = resolveIdentity(null, buildPublicationRetryRequestKey(originalInput));
  const unchanged = resolveIdentity(initial, buildPublicationRetryRequestKey(originalInput));
  assert.equal(unchanged.requestId, initial.requestId);

  const latestInput = {
    ...originalInput,
    contentMode: 'latest' as const,
    expectedPublicationVersion: 7,
    expectedContentRevision: 3,
  };
  const latest = resolveIdentity(unchanged, buildPublicationRetryRequestKey(latestInput));
  const changedRevision = resolveIdentity(
    latest,
    buildPublicationRetryRequestKey({ ...latestInput, expectedContentRevision: 4 }),
  );
  const changedOccurrence = resolveIdentity(
    changedRevision,
    buildPublicationRetryRequestKey({ ...latestInput, occurrenceId: 'occurrence-2' }),
  );
  assert.notEqual(latest.requestId, unchanged.requestId);
  assert.notEqual(changedRevision.requestId, latest.requestId);
  assert.notEqual(changedOccurrence.requestId, changedRevision.requestId);
});

test('ambiguous resolution identity distinguishes delivery and selected outcome', () => {
  const resolveIdentity = createIdentityResolver();
  const input = {
    publicationId: 'publication-1',
    occurrenceId: 'occurrence-1',
    deliveryId: 'delivery-1',
    resolution: 'mark_sent' as const,
  };
  const initial = resolveIdentity(null, buildPublicationAmbiguousRequestKey(input));
  const unchanged = resolveIdentity(initial, buildPublicationAmbiguousRequestKey(input));
  assert.equal(unchanged.requestId, initial.requestId);

  const changedOutcome = resolveIdentity(
    unchanged,
    buildPublicationAmbiguousRequestKey({ ...input, resolution: 'mark_failed' }),
  );
  const changedDelivery = resolveIdentity(
    changedOutcome,
    buildPublicationAmbiguousRequestKey({ ...input, deliveryId: 'delivery-2' }),
  );
  assert.notEqual(changedOutcome.requestId, unchanged.requestId);
  assert.notEqual(changedDelivery.requestId, changedOutcome.requestId);
});

test('recognizes an ambiguous test result and provides actionable copy', () => {
  assert.equal(
    isPublicationTestResultPendingError({ code: 'BROADCAST_TEST_RESULT_PENDING' }),
    true,
  );
  assert.equal(isPublicationTestResultPendingError(new Error('timeout')), false);
  assert.deepEqual(PUBLICATION_TEST_RESULT_PENDING_FEEDBACK, {
    tone: 'info',
    title: 'Тест мог быть отправлен',
    description: 'Проверьте личный диалог с ботом перед повтором.',
    durationMs: 6_000,
  });
});

test('shared media source participates in both save and private-test request identity', () => {
  const resolve = createIdentityResolver();
  const draft = {
    ...createEmptyPublicationDraft([chatTarget]),
    text: 'copy',
    retainedAssets: [
      {
        id: 'asset',
        type: 'image' as const,
        mimeType: 'image/png',
        fileName: 'shared.png',
        sizeBytes: 10,
        sourcePublicationId: 'source-a',
      },
    ],
  };
  const changed = {
    ...draft,
    retainedAssets: draft.retainedAssets.map((asset) => ({
      ...asset,
      sourcePublicationId: 'source-b',
    })),
  };
  for (const key of [
    (value: typeof draft) => buildPublicationSaveRequestKey(value, { kind: 'duplicate' }, false),
    (value: typeof draft) => buildPublicationTestRequestKey(value),
  ]) {
    const first = resolve(null, key(draft));
    assert.equal(resolve(first, key(draft)).requestId, first.requestId);
    assert.notEqual(resolve(first, key(changed)).requestId, first.requestId);
  }
});
