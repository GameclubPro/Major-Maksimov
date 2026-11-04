import assert from 'node:assert/strict';
import test from 'node:test';
import type { SafetyDeskPublicationDeliveryEvidenceResponse } from '@maxim/contracts/safety-desk';
import { SafetyDeskApiClient } from '../src/safety-desk-api-client';
import { createAdminApiTransport } from '../src/admin-request';

function snapshot(deliveryId: string): SafetyDeskPublicationDeliveryEvidenceResponse {
  return {
    schemaVersion: 1,
    deliveryId,
    observedAt: '2026-10-16T18:15:30.000Z',
    storedStatus: 'AMBIGUOUS',
    effectiveStatus: 'AMBIGUOUS',
    acceptedAt: '2026-10-16T18:00:00.000Z',
    completionTimingEvidence: 'not_recorded',
    binding: 'exact',
    action: {
      keyBasis: 'current',
      state: 'unknown',
      dispatchStartedAt: '2026-10-16T18:01:00.000Z',
      journalCompletedAt: null,
    },
    recipient: { state: 'missing', savedSendAt: null, agreesWithAction: null },
    verification: { state: 'not_recorded', observedAt: null },
    waiting: {
      reasons: ['effect_unknown'],
      reasonsOverlap: true,
      deadline: 'expired',
      nextAttemptAt: null,
      firstDeferredAt: null,
      lastDeferredAt: null,
      ageSinceFirstDeferralMs: null,
      recipientBlocker: null,
      parentBlocker: null,
      postActions: { pin: 'NONE', deletion: 'NONE', nextAt: null },
    },
    clientVisibility: 'not_observed',
    automaticRetryAllowed: false,
  };
}

test('recipient evidence keeps an exact encoded authenticated GET without effects', async () => {
  const id = 'delivery/with?symbols';
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const client = new SafetyDeskApiClient(
    createAdminApiTransport(async (url, init) => {
      calls.push({ url: String(url), init });
      return Response.json(snapshot(id));
    }),
  );
  const result = await client.fetchPublicationDeliveryEvidence(id);
  assert.equal(result.action.state, 'unknown');
  assert.equal(result.automaticRetryAllowed, false);
  assert.equal(calls.length, 1);
  assert.equal(
    calls[0]!.url,
    '/api/v1/safety-desk/runtime/publication-deliveries/delivery%2Fwith%3Fsymbols/evidence',
  );
  assert.equal(calls[0]!.init?.method ?? 'GET', 'GET');
  assert.equal(calls[0]!.init?.body, undefined);
  assert.equal(calls[0]!.init?.credentials, 'same-origin');
  assert.equal(
    (calls[0]!.init?.headers as Record<string, string>)['X-Admin-Access-Code'],
    undefined,
  );
});

test('another recipient, missing uncertainty or invented retry permission fails closed', async () => {
  for (const payload of [
    snapshot('other'),
    { ...snapshot('selected'), automaticRetryAllowed: undefined },
    { ...snapshot('selected'), automaticRetryAllowed: true },
  ]) {
    let requests = 0;
    const client = new SafetyDeskApiClient(
      createAdminApiTransport(async () => {
        requests += 1;
        return Response.json(payload);
      }),
    );
    await assert.rejects(() => client.fetchPublicationDeliveryEvidence('selected'));
    assert.equal(requests, 1);
  }
});

test('new cohorts reject a partial success envelope and make no fallback request', async () => {
  const calls: string[] = [];
  const client = new SafetyDeskApiClient(
    createAdminApiTransport(async (url) => {
      calls.push(String(url));
      return Response.json({ sampleComplete: true, totalCountLowerBound: 0, rows: [] });
    }),
  );
  await assert.rejects(() => client.fetchDeleteCohort());
  await assert.rejects(() => client.fetchPublicationDeliveryCohort());
  assert.deepEqual(calls, [
    '/api/v1/safety-desk/runtime/delete-cohort',
    '/api/v1/safety-desk/runtime/publication-delivery-cohort',
  ]);
});
