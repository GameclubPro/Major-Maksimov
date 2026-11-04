import assert from 'node:assert/strict';
import test from 'node:test';
import type {
  SafetyDeskDeleteIntentItem,
  SafetyDeskRetentionPreviewItem,
} from '@maxim/contracts/safety-desk';
import { createAdminApiTransport } from '../src/admin-request';
import { AdminApiError, readJsonResponse } from '../src/api-response';
import { SafetyDeskApiClient } from '../src/safety-desk-api-client';
import { buildRetentionRetryRequest, canRetryDeleteIntent } from '../src/safety-desk-model';

const date = '2026-10-01T10:00:00.000Z';
const candidate: SafetyDeskRetentionPreviewItem = {
  messageId: 'message/1',
  authorId: 'user-1',
  sourceAt: date,
  dueAt: date,
  status: 'terminal_review',
  outcomeCode: 'worker_error',
  intentId: 'intent-1',
  intentStatus: 'FAILED_TERMINAL',
  intentUpdatedAt: date,
  intentAttemptCount: 3,
  reconcileAfter: null,
  retryAllowed: true,
};
const preview = { chatId: 'chat/1', revision: 7, activationId: 'activation-1', items: [candidate] };

test('ordinary retry requires server permission and excludes retention ownership', () => {
  const item = {
    status: 'FAILED_TERMINAL',
    retentionOwned: false,
    retryAllowed: true,
  } as SafetyDeskDeleteIntentItem;
  assert.equal(canRetryDeleteIntent(item), true);
  assert.equal(canRetryDeleteIntent({ ...item, retryAllowed: false }), false);
  assert.equal(canRetryDeleteIntent({ ...item, retentionOwned: true }), false);
  assert.equal(canRetryDeleteIntent({ ...item, status: 'AMBIGUOUS' }), false);
  assert.equal(
    canRetryDeleteIntent({
      ...item,
      retryAllowed: undefined,
    } as unknown as SafetyDeskDeleteIntentItem),
    false,
  );
});

test('retention retry requires authoritative permission and all optimistic versions', () => {
  assert.deepEqual(buildRetentionRetryRequest(preview, candidate), {
    messageId: candidate.messageId,
    activationId: preview.activationId,
    expectedRevision: 7,
    intentId: 'intent-1',
    expectedIntentUpdatedAt: date,
    expectedAttemptCount: 3,
  });
  assert.equal(buildRetentionRetryRequest(preview, { ...candidate, retryAllowed: false }), null);
  assert.equal(buildRetentionRetryRequest(preview, { ...candidate, intentId: null }), null);
  assert.equal(buildRetentionRetryRequest(preview, { ...candidate, intentUpdatedAt: null }), null);
  assert.equal(
    buildRetentionRetryRequest(preview, { ...candidate, intentAttemptCount: null }),
    null,
  );
  assert.equal(
    buildRetentionRetryRequest(preview, { ...candidate, intentAttemptCount: 0 })
      ?.expectedAttemptCount,
    0,
  );
});

test('retention API encodes chat/cursor and sends an exact POST snapshot without credentials in the body', async () => {
  const calls: Array<{ path: string; init?: RequestInit }> = [];
  const client = new SafetyDeskApiClient(
    createAdminApiTransport(async (path, init) => {
      calls.push({ path: String(path), init });
      const payload =
        String(path).includes('/preview') || init?.method === 'POST'
          ? preview
          : { generatedAt: date, mode: 'on', nextAfter: null, quotas: [], items: [] };
      return new Response(JSON.stringify(payload), {
        headers: { 'Content-Type': 'application/json' },
      });
    }),
  );
  await client.fetchRetentionRuntime('chat/1?after=other');
  await client.fetchRetentionPreview('chat/1', 'opaque/+?cursor=1');
  const request = buildRetentionRetryRequest(preview, candidate);
  assert.ok(request);
  await client.retryRetention('chat/1', request);
  assert.deepEqual(
    calls.map((call) => call.path),
    [
      '/api/v1/safety-desk/runtime/retention?after=chat%2F1%3Fafter%3Dother',
      '/api/v1/safety-desk/runtime/retention/chat%2F1/preview?after=opaque%2F%2B%3Fcursor%3D1',
      '/api/v1/safety-desk/runtime/retention/chat%2F1/retry',
    ],
  );
  assert.equal(calls[2]?.init?.method, 'POST');
  assert.deepEqual(JSON.parse(String(calls[2]?.init?.body)), request);
  assert.equal(String(calls[2]?.init?.body).includes('unit-access'), false);
  assert.equal(new Headers(calls[2]?.init?.headers).get('X-Admin-Access-Code'), null);
});

test('review metadata never enters the exact retry body and microseconds remain unchanged', () => {
  const item = { ...candidate, intentUpdatedAt: '2026-10-29T01:02:03.123456Z' };
  assert.deepEqual(
    buildRetentionRetryRequest(
      {
        ...preview,
        source: 'eraser',
        sourceStatus: 'available',
        nextAfter: 'opaque',
        incomplete: true,
      },
      item,
    ),
    {
      messageId: item.messageId,
      activationId: preview.activationId,
      expectedRevision: 7,
      intentId: 'intent-1',
      expectedIntentUpdatedAt: item.intentUpdatedAt,
      expectedAttemptCount: 3,
    },
  );
});

test('retention API rejects an oversized diagnostics response', async () => {
  const client = new SafetyDeskApiClient(
    createAdminApiTransport(
      async () =>
        new Response(JSON.stringify({ ...preview, items: Array(21).fill(candidate) }), {
          headers: { 'Content-Type': 'application/json' },
        }),
    ),
  );
  await assert.rejects(() => client.fetchRetentionPreview('chat-1'));
});

test('API conflicts preserve HTTP status for explicit reload behavior', async () => {
  await assert.rejects(
    () =>
      readJsonResponse(
        new Response(JSON.stringify({ message: 'Изменилось' }), {
          status: 409,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    (error: unknown) =>
      error instanceof AdminApiError && error.status === 409 && error.message === 'Изменилось',
  );
});
