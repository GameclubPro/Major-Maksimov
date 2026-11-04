import assert from 'node:assert/strict';
import test from 'node:test';
import { SafetyDeskApiClient } from '../src/safety-desk-api-client';
import { createAdminApiTransport } from '../src/admin-request';

test('cohort read uses the closed authenticated GET and rejects missing coverage', async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const client = new SafetyDeskApiClient(
    createAdminApiTransport(async (url, init) => {
      calls.push({ url: String(url), init });
      return new Response(
        JSON.stringify({ sampleComplete: true, totalCountLowerBound: 0, rows: [] }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      );
    }),
  );
  await assert.rejects(() => client.fetchWebhookCohort());
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, '/api/v1/safety-desk/runtime/webhook-cohort');
  assert.equal(calls[0]!.init?.credentials, 'same-origin');
  assert.equal(calls[0]!.init?.method ?? 'GET', 'GET');
  assert.equal(
    (calls[0]!.init?.headers as Record<string, string>)['X-Admin-Access-Code'],
    undefined,
  );
  assert.equal(calls[0]!.init?.body, undefined);
});
