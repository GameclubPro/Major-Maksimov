import assert from 'node:assert/strict';
import test from 'node:test';
import { SafetyDeskApiClient } from '../src/safety-desk-api-client';
import { createAdminApiTransport } from '../src/admin-request';
import { AdminApiError } from '../src/api-response';
import { deleteEvidenceErrorMessage } from '../src/delete-evidence';

function snapshot(intentId: string) {
  return {
    version: 1,
    observedAt: '2026-10-16T18:00:00.000Z',
    intentId,
    webhookLink: 'not_recorded',
    deletion: {
      status: 'AMBIGUOUS',
      outcome: 'unknown',
      createdAt: '2026-10-16T17:59:00.000Z',
      sourceMessageAt: null,
      firstAttemptAt: null,
      dispatchStartedAt: null,
      acknowledgedAt: null,
      completedAt: null,
    },
    reasons: { sampleComplete: true, items: [] },
    followups: { sampleComplete: true, items: [] },
  };
}

test('delete evidence reads only an exact encoded intent through authenticated GET', async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const intentId = 'intent/with?symbols';
  const client = new SafetyDeskApiClient(
    createAdminApiTransport(async (url, init) => {
      calls.push({ url: String(url), init });
      return Response.json(snapshot(intentId));
    }),
  );
  const result = await client.fetchDeleteEvidence(intentId);
  assert.equal(result.deletion.outcome, 'unknown');
  assert.equal(calls.length, 1);
  assert.equal(
    calls[0]!.url,
    '/api/v1/safety-desk/runtime/deletes/intent%2Fwith%3Fsymbols/evidence',
  );
  assert.equal(calls[0]!.init?.method ?? 'GET', 'GET');
  assert.equal(calls[0]!.init?.credentials, 'same-origin');
  assert.equal(
    (calls[0]!.init?.headers as Record<string, string>)['X-Admin-Access-Code'],
    undefined,
  );
  assert.equal(calls[0]!.init?.body, undefined);
  assert.equal(calls[0]!.url.includes('private-code'), false);
});

test('delete evidence refuses another intent or missing uncertainty metadata', async () => {
  for (const payload of [snapshot('other'), { ...snapshot('selected'), webhookLink: undefined }]) {
    const client = new SafetyDeskApiClient(
      createAdminApiTransport(async () => Response.json(payload)),
    );
    await assert.rejects(() => client.fetchDeleteEvidence('selected'));
  }
});

test('evidence UI errors distinguish denied and missing records without rendering server messages', () => {
  assert.equal(
    deleteEvidenceErrorMessage(new AdminApiError('private-code', 403)),
    'Нет доступа к подтверждениям удаления.',
  );
  assert.equal(
    deleteEvidenceErrorMessage(new AdminApiError('private-code', 404)),
    'Запись удаления не найдена.',
  );
  for (const error of [new Error('private-code'), new AdminApiError('private-code', 503)]) {
    assert.equal(deleteEvidenceErrorMessage(error).includes('private-code'), false);
  }
});
