import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Config } from '../src/config.js';
import { HttpAdmissionDeferred, type HttpLimiter } from '../src/limiter.js';
import { MaxClient, MaxError } from '../src/max.js';
import { HTTP_PURPOSES, HttpTelemetry } from '../src/telemetry.js';

const settings: Config = {
  databaseUrl: 'postgresql://unused/test',
  redisUrl: 'redis://unused',
  controlToken: 'private-control-token',
  webhookSecret: 'private-webhook-secret',
  botToken: 'private-bot-token',
  botId: '1',
  apiBaseUrl: 'https://example.invalid',
  port: 3000,
  enabled: true,
  maxRps: 20,
  commitSha: 'test',
  webhookUrl: null,
};
const admitted: Pick<HttpLimiter, 'acquire' | 'cooldownUntil'> = {
  acquire: async () => {},
  cooldownUntil: async () => {},
};
const guarded = async () => {};

test('local cooldown, unavailable admission and final guard refusal make no HTTP attempt', async () => {
  let refusal: 'cooldown' | 'unavailable' | null = 'cooldown';
  const client = new MaxClient(
    settings,
    {
      ...admitted,
      acquire: async () => {
        if (refusal === 'cooldown') throw new HttpAdmissionDeferred(Date.now() + 60_000);
        if (refusal === 'unavailable') throw new Error('private Redis connection string');
      },
    },
    async () => assert.fail('Admission refusal must not call MAX'),
  );
  await assert.rejects(client.remove('-1', 'private-message-id', guarded), MaxError);
  refusal = 'unavailable';
  await assert.rejects(client.remove('-1', 'private-message-id', guarded));
  refusal = null;
  await assert.rejects(
    client.remove('-1', 'private-message-id', async () => {
      throw new Error('private policy failure');
    }),
  );
  const metrics = client.metrics();
  assert.equal(metrics.cooldownDeferrals, 1);
  assert.equal(metrics.admissionUnavailable, 1);
  assert.equal(metrics.guardRejected, 1);
  assert.equal(
    metrics.requests.reduce((sum, row) => sum + row.attempts, 0),
    0,
  );
  assert.ok(metrics.observedCooldownUntil);
  assert.doesNotMatch(JSON.stringify(metrics), /private/);
});

test('actual MAX 429 remains distinct from a local deferral even if cooldown persistence fails', async () => {
  let sent = false;
  const client = new MaxClient(
    settings,
    {
      ...admitted,
      cooldownUntil: async () => {
        throw new Error('private store error');
      },
    },
    async () => {
      assert.equal(sent, true, 'Final callback runs before the counted HTTP attempt');
      return Response.json(
        { code: 'rate_limited' },
        { status: 429, headers: { 'retry-after': '60' } },
      );
    },
  );
  await assert.rejects(
    client.remove('-1', 'private-message-id', async () => {
      sent = true;
    }),
    (error) => error instanceof MaxError && error.status === 429 && !error.attempted,
  );
  const metrics = client.metrics();
  assert.deepEqual(
    metrics.requests.find((row) => row.purpose === 'delete'),
    {
      purpose: 'delete',
      attempts: 1,
      responses: 1,
      httpSuccesses: 0,
      rateLimited: 1,
      transportErrors: 0,
    },
  );
  assert.equal(metrics.cooldownDeferrals, 0);
  assert.equal(metrics.deleteAcknowledged, 0);
  assert.ok(metrics.observedCooldownUntil);
});

test('HTTP success, transport failure and a positive DELETE acknowledgement have distinct evidence', async () => {
  const responses: Array<() => Response> = [
    () => Response.json({ success: false }),
    () => new Response('not-json'),
    () => {
      throw new Error('private request failure');
    },
    () => Response.json({ success: true }),
  ];
  const client = new MaxClient(settings, admitted, async () => responses.shift()!());
  for (let index = 0; index < 3; index++)
    await assert.rejects(client.remove('-1', 'private-message-id', guarded));
  await client.remove('-1', 'private-message-id', guarded);
  const metrics = client.metrics();
  assert.deepEqual(
    metrics.requests.find((row) => row.purpose === 'delete'),
    {
      purpose: 'delete',
      attempts: 4,
      responses: 3,
      httpSuccesses: 3,
      rateLimited: 0,
      transportErrors: 1,
    },
  );
  assert.equal(metrics.deleteAcknowledged, 1);
});

test('ordinary, safety and operator reads use fixed purpose counters without retaining private input', async () => {
  const client = new MaxClient(settings, admitted, async (input) => {
    const path = new URL(String(input)).pathname;
    if (path.endsWith('/members/me')) return Response.json({ user_id: '1', is_owner: true });
    if (path.endsWith('/members'))
      return Response.json({ members: [{ user_id: '2', is_bot: false, is_owner: true }] });
    if (path.endsWith('/pin')) return Response.json({});
    if (path === '/messages') return Response.json({ messages: [] });
    if (path.startsWith('/messages/')) return Response.json({}, { status: 404 });
    assert.fail('Unexpected path');
  });
  await client.rights('-1');
  await client.actorRights('-1', '2');
  await client.pin('-1');
  await client.page('-1', 1000);
  await client.page('-1', 1000, 0);
  await client.rights('-1', undefined, 'safety');
  await client.page('-1', 1000, 0, 'safety');
  assert.equal(await client.presence('-1', 'private-message-id'), 'unknown');
  const metrics = client.metrics();
  assert.equal(metrics.requests.length, HTTP_PURPOSES.length);
  for (const row of metrics.requests)
    assert.equal(
      row.attempts,
      ['identity', 'subscriptions', 'delete'].includes(row.purpose) ? 0 : 1,
    );
  assert.doesNotMatch(JSON.stringify(metrics), /private|example\.invalid/);
});

test('process reset and returned snapshot changes cannot masquerade as durable lifetime counters', () => {
  let now = Date.parse('2026-10-29T00:00:00Z');
  const first = new HttpTelemetry(() => now);
  first.attempt('delete');
  first.acknowledgeDelete();
  const snapshot = first.snapshot();
  snapshot.requests[0]!.attempts = 100;
  assert.equal(first.snapshot().requests[0]!.attempts, 0);
  now += 1000;
  const restarted = new HttpTelemetry(() => now).snapshot();
  assert.equal(restarted.scope, 'process');
  assert.notEqual(restarted.since, snapshot.since);
  assert.equal(restarted.deleteAcknowledged, 0);
  assert.equal(
    restarted.requests.reduce((sum, row) => sum + row.attempts, 0),
    0,
  );
});
