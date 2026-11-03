import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, beforeEach, test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import pg from 'pg';
import { Redis } from 'ioredis';
import { Queue } from 'bullmq';
import { createHttpServer } from '../src/http.js';
import type { Config } from '../src/config.js';
import { MaxClient, MaxError, type MaxTransport } from '../src/max.js';
import { HttpLimiter } from '../src/limiter.js';
import { migrate } from '../src/migrate.js';
import { CleanupRuntime, MAX_CONNECTION_WAKEUPS, MAX_WAKEUPS } from '../src/runtime.js';
import { Store } from '../src/store.js';
import { connectionProof } from './support/policy-proof.js';
import type { Protection, UpdatePolicy } from '../src/types.js';

const databaseUrl = process.env.MAXIM_TEST_POSTGRES_URL;
const redisUrl = process.env.MAXIM_TEST_REDIS_URL;
if (!databaseUrl || !redisUrl)
  throw new Error('Native connection tests require the public with-test-stores wrapper.');
const schema = `eraser_connect_${randomUUID().replaceAll('-', '')}`;
const admin = new pg.Pool({ connectionString: databaseUrl, max: 1 });
const pool = new pg.Pool({
  connectionString: databaseUrl,
  max: 4,
  application_name: schema,
  options: `-c search_path=${schema} -c timezone=UTC`,
});
const redis = new Redis(redisUrl, { maxRetriesPerRequest: 1 });
const prefix = `eraser:connection:test:${randomUUID()}`;
const store = new Store(pool, true);
const settings: Config = {
  databaseUrl,
  redisUrl,
  controlToken: 'a'.repeat(32),
  webhookSecret: 'b'.repeat(32),
  botToken: 'private',
  botId: '123',
  apiBaseUrl: 'https://platform-api2.max.ru',
  port: 3000,
  enabled: true,
  maxRps: 20,
  commitSha: 'native-connect',
  webhookUrl: null,
};
const protection = (): Protection => ({
  sourceRevision: 1,
  protectedMessageIds: ['rules'],
  protectedBotIds: [],
  holdMessageIds: ['old-uncertain'],
  completeThrough: new Date().toISOString(),
});
function requestInput(patch: Partial<UpdatePolicy> = {}): UpdatePolicy {
  return {
    enabled: true,
    hours: 48,
    expectedRevision: 0,
    operationId: randomUUID(),
    actorUserId: '5',
    connectWhenReady: true,
    ...patch,
  };
}
async function request(chatId = '-1', input = requestInput()) {
  await store.bootstrap(chatId, input.hours, protection());
  return { input, state: await store.update(chatId, input) };
}
function connection(state: Record<string, unknown>) {
  assert.ok(state.connectionRequest && typeof state.connectionRequest === 'object');
  return state.connectionRequest as {
    status: 'pending' | 'expired' | 'cancelled';
    expiresAt: string;
  };
}
async function reserve() {
  const rows = await store.reserveConnections(1);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.chatId, '-1');
  return rows[0]!;
}
function transport(overrides: Partial<MaxTransport> = {}): MaxTransport {
  return {
    rights: async () => {},
    actorRights: async () => {},
    pin: async () => null,
    page: async () => [],
    presence: async () => 'unknown',
    remove: async (_chat, _mid, before) => {
      await before();
    },
    ...overrides,
  };
}
function runtime(overrides: Partial<MaxTransport> = {}, ownStore = store) {
  return new CleanupRuntime(ownStore, transport(overrides), settings);
}
async function makeDue() {
  await pool.query(
    "UPDATE eraser_connection_requests SET next_attempt_at=clock_timestamp() WHERE chat_id='-1'",
  );
}
async function waitForActivationLock() {
  for (let attempt = 0; attempt < 100; attempt++) {
    const waiting = (
      await pool.query<{ waiting: boolean }>(
        "SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock') AS waiting",
        [schema],
      )
    ).rows[0]!.waiting;
    if (waiting) return;
    await delay(10);
  }
  assert.fail('activation must already be waiting in its transaction');
}

before(async () => {
  await admin.query(`CREATE SCHEMA ${schema}`);
  await migrate(pool);
  await redis.ping();
});
after(async () => {
  await pool.end();
  await admin.query(`DROP SCHEMA ${schema} CASCADE`);
  await admin.end();
  const keys = await redis.keys(`${prefix}*`);
  if (keys.length) await redis.del(...keys);
  await redis.quit();
});
beforeEach(async () => {
  await pool.query(
    'TRUNCATE eraser_policies,eraser_global_held_authors,eraser_global_message_holds,eraser_webhook_receipts CASCADE',
  );
});

test('connection request saves disabled desired policy and one database-clock hour without retry extension', async () => {
  const { input, state } = await request();
  assert.equal(state.enabled, false);
  assert.equal(state.hours, 48);
  assert.equal(state.revision, 1);
  assert.equal(state.lastOperationId, input.operationId);
  assert.equal(connection(state).status, 'pending');
  const first = connection(state).expiresAt;
  const remaining = (
    await pool.query<{ ms: number }>(
      "SELECT (EXTRACT(EPOCH FROM(expires_at-clock_timestamp()))*1000)::float8 AS ms FROM eraser_connection_requests WHERE chat_id='-1'",
    )
  ).rows[0]!.ms;
  assert.ok(remaining > 3_590_000 && remaining <= 3_600_000);
  assert.deepEqual(await store.update('-1', input), state);
  assert.equal(connection(await store.snapshot('-1')).expiresAt, first);
  await assert.rejects(store.update('-1', { ...input, connectWhenReady: false }), {
    code: 'ERASER_OPERATION_CONFLICT',
  });
});

test('concurrent explicit connection requests have one CAS winner and one request identity', async () => {
  await store.bootstrap('-1', 48, protection());
  const inputs = [requestInput(), requestInput({ hours: 168 })];
  const values = await Promise.allSettled(inputs.map((input) => store.update('-1', input)));
  assert.equal(values.filter((value) => value.status === 'fulfilled').length, 1);
  assert.equal((await store.policy('-1'))?.enabled, false);
  assert.equal((await store.policy('-1'))?.revision, 1);
  assert.equal((await pool.query('SELECT * FROM eraser_connection_requests')).rowCount, 1);
});

for (const expired of [false, true]) {
  test(`an ordinary unchanged disabled write cancels the ${expired ? 'expired' : 'pending'} connection request`, async () => {
    const { state } = await request();
    const expiresAt = connection(state).expiresAt;
    if (expired)
      await pool.query(
        "UPDATE eraser_connection_requests SET expires_at=clock_timestamp()-INTERVAL '1 second' WHERE chat_id='-1'",
      );
    const before = connection(await store.snapshot('-1')).expiresAt;
    const saved = await store.update('-1', {
      enabled: false,
      hours: 48,
      expectedRevision: 1,
      operationId: randomUUID(),
      actorUserId: '5',
    });
    assert.equal(saved.enabled, false);
    assert.equal(saved.revision, 2);
    assert.equal(connection(saved).status, 'cancelled');
    assert.equal(connection(saved).expiresAt, expired ? before : expiresAt);
    assert.deepEqual(await store.reserveConnections(16), []);
  });
}

test('database deadline stops checks until a fresh explicit operation creates a new hour', async () => {
  await request();
  await pool.query(
    "UPDATE eraser_connection_requests SET expires_at=clock_timestamp() WHERE chat_id='-1'",
  );
  let probes = 0;
  const worker = runtime({
    rights: async () => {
      probes++;
    },
  });
  assert.deepEqual(await store.reserveConnections(16), []);
  assert.equal(connection(await store.snapshot('-1')).status, 'expired');
  await store.ingest({ update_type: 'bot_added', chat_id: -1 }, 'late-added');
  assert.deepEqual(await store.reserveConnections(16), []);
  assert.equal(probes, 0);
  const renewed = await store.update('-1', requestInput({ expectedRevision: 1 }));
  assert.equal(connection(renewed).status, 'pending');
  await worker.connect(await reserve());
  assert.equal(probes, 1);
  assert.equal((await store.snapshot('-1')).enabled, true);
});

test('request lease and final activation survive a service restart without moderator applications', async () => {
  const { input } = await request('-1', requestInput({ hours: 168 }));
  const abandoned = await reserve();
  assert.deepEqual(await store.reserveConnections(16), []);
  await pool.query(
    "UPDATE eraser_connection_requests SET lease_until=clock_timestamp()-INTERVAL '1 second' WHERE chat_id='-1'",
  );
  const replacementStore = new Store(pool, true);
  const replacement = (await replacementStore.reserveConnections(1))[0]!;
  assert.ok(replacement);
  assert.notEqual(replacement.leaseToken, abandoned.leaseToken);
  assert.equal(
    await replacementStore.activateConnection(
      '-1',
      abandoned.leaseToken,
      await connectionProof(replacementStore, '-1'),
    ),
    false,
  );
  const proofs: string[] = [];
  await runtime(
    {
      rights: async (chat) => {
        proofs.push(`bot:${chat}`);
      },
      actorRights: async (chat, actor) => {
        proofs.push(`human:${chat}:${actor}`);
      },
    },
    replacementStore,
  ).connect(replacement);
  assert.deepEqual(proofs.sort(), ['bot:-1', 'human:-1:5']);
  const state = await store.snapshot('-1');
  assert.equal(state.enabled, true);
  assert.equal(state.hours, 168);
  assert.equal(state.revision, 2);
  assert.equal(state.lastOperationId, input.operationId);
  assert.equal(state.connectionRequest, null);
  assert.equal(state.connectionStatus, 'connected');
});

for (const change of ['cancel', 'hours', 'expiry', 'lease'] as const) {
  test(`final activation refuses ${change} while rights requests are in flight`, async () => {
    await request();
    const wakeup = await reserve();
    await runtime({
      actorRights: async () => {
        if (change === 'cancel' || change === 'hours')
          await store.update('-1', {
            enabled: false,
            hours: change === 'hours' ? 24 : 48,
            expectedRevision: 1,
            operationId: randomUUID(),
            actorUserId: '5',
          });
        else
          await pool.query(
            `UPDATE eraser_connection_requests SET ${change === 'expiry' ? 'expires_at' : 'lease_until'}=clock_timestamp() WHERE chat_id='-1'`,
          );
      },
    }).connect(wakeup);
    assert.equal((await store.snapshot('-1')).enabled, false);
  });
}

test('activation cannot use transaction-start time after waiting across the database deadline', async () => {
  await request();
  const wakeup = await reserve();
  const blocker = await pool.connect();
  let activating: Promise<boolean> | undefined;
  try {
    await blocker.query('BEGIN');
    await blocker.query("SELECT chat_id FROM eraser_policies WHERE chat_id='-1' FOR UPDATE");
    activating = store.activateConnection(
      '-1',
      wakeup.leaseToken,
      await connectionProof(store, '-1'),
    );
    await waitForActivationLock();
    await pool.query(
      "UPDATE eraser_connection_requests SET expires_at=clock_timestamp()+INTERVAL '100 milliseconds' WHERE chat_id='-1'",
    );
    await delay(150);
    await blocker.query('COMMIT');
    assert.equal(await activating, false);
    assert.equal((await store.policy('-1'))?.enabled, false);
  } finally {
    await blocker.query('ROLLBACK');
    blocker.release();
    await activating?.catch(() => {});
  }
});

test('fresh rights proof expires during a policy lock wait while the request and lease remain valid', async () => {
  await request();
  const wakeup = await reserve();
  const blocker = await pool.connect();
  let activating: Promise<boolean> | undefined;
  try {
    await blocker.query('BEGIN');
    await blocker.query("SELECT chat_id FROM eraser_policies WHERE chat_id='-1' FOR UPDATE");
    const proofExpiresAt = new Date(Date.now() + 1000);
    activating = store.activateConnection(
      '-1',
      wakeup.leaseToken,
      await connectionProof(store, '-1', proofExpiresAt),
    );
    await waitForActivationLock();
    await delay(Math.max(1, proofExpiresAt.getTime() - Date.now() + 100));
    const clocks = (
      await pool.query<{ proof_expired: boolean; request_valid: boolean; lease_valid: boolean }>(
        "SELECT clock_timestamp()>$1 AS proof_expired,expires_at>clock_timestamp() AS request_valid,lease_until>clock_timestamp() AS lease_valid FROM eraser_connection_requests WHERE chat_id='-1'",
        [proofExpiresAt],
      )
    ).rows[0]!;
    assert.deepEqual(clocks, { proof_expired: true, request_valid: true, lease_valid: true });
    await blocker.query('COMMIT');
    assert.equal(await activating, false);
    assert.equal((await store.policy('-1'))?.enabled, false);
  } finally {
    await blocker.query('ROLLBACK');
    blocker.release();
    await activating?.catch(() => {});
  }
});

test('a queued connection wakeup after expiry never probes MAX or enables cleanup', async () => {
  await request();
  const wakeup = await reserve();
  await pool.query(
    "UPDATE eraser_connection_requests SET expires_at=clock_timestamp() WHERE chat_id='-1'",
  );
  const probes: string[] = [];
  await runtime({
    rights: async () => {
      probes.push('bot');
    },
    actorRights: async () => {
      probes.push('human');
    },
  }).connect(wakeup);
  assert.deepEqual(probes, []);
  assert.equal((await store.policy('-1'))?.enabled, false);
  assert.equal(connection(await store.snapshot('-1')).status, 'expired');
});

test('a fulfilled old request cannot reactivate cleanup after trusted bot removal', async () => {
  await request();
  await runtime().connect(await reserve());
  assert.equal((await store.snapshot('-1')).enabled, true);
  await store.ingest({ update_type: 'bot_removed', chat_id: -1 }, 'removed-after-activation');
  await store.ingest({ update_type: 'bot_added', chat_id: -1 }, 'passively-readded');
  assert.deepEqual(await store.reserveConnections(16), []);
  assert.equal((await store.snapshot('-1')).connectionStatus, 'missing');
  assert.equal((await store.snapshot('-1')).connectionRequest, null);
  assert.deepEqual(await store.reserve(1), []);
});

for (const actorAllowed of [true, false]) {
  test(`background connection uses only exact-chat GET checks with actor ${actorAllowed ? 'verified' : 'HTTP 403 still unknown'}`, async () => {
    await request();
    const calls: Array<{ method: string | undefined; path: string; actor: string | null }> = [];
    const max = new MaxClient(
      settings,
      new HttpLimiter(redis, 20, `${prefix}:read-only`),
      async (input, init) => {
        const url = new URL(String(input));
        calls.push({
          method: init?.method,
          path: url.pathname,
          actor: url.searchParams.get('user_ids'),
        });
        assert.equal(init?.method, 'GET');
        if (url.pathname === '/chats/-1/members/me')
          return Response.json({
            user_id: 123,
            is_bot: true,
            is_admin: true,
            permissions: ['read_all_messages', 'write'],
          });
        assert.equal(url.pathname, '/chats/-1/members');
        assert.equal(url.searchParams.get('user_ids'), '5');
        if (!actorAllowed) return Response.json({ code: 'chat.denied' }, { status: 403 });
        return Response.json({ members: [{ user_id: 5, is_bot: false, is_admin: true }] });
      },
    );
    await new CleanupRuntime(store, max, settings).connect(await reserve());
    const state = await store.snapshot('-1');
    assert.equal(state.enabled, actorAllowed);
    if (!actorAllowed) assert.equal(connection(state).status, 'pending');
    assert.deepEqual(calls, [
      { method: 'GET', path: '/chats/-1/members/me', actor: null },
      { method: 'GET', path: '/chats/-1/members', actor: '5' },
    ]);
  });
}

test('real Redis connection queue stays bounded and proceeds while cleanup slots are occupied', async () => {
  for (let id = 1; id <= 40; id++) await request(String(-id));
  const queuePrefix = `${prefix}:independent`;
  const cleanup = new Queue('cleanup', {
    connection: { url: redisUrl, maxRetriesPerRequest: 1 },
    prefix: queuePrefix,
  });
  const connections = new Queue('connections', {
    connection: { url: redisUrl, maxRetriesPerRequest: 1 },
    prefix: queuePrefix,
  });
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const probes: string[] = [];
  const worker = new CleanupRuntime(
    store,
    transport({
      rights: async (chatId, before) => {
        await before?.();
        probes.push(chatId);
        await gate;
        throw new MaxError(403, 'eraser_rights_missing', false);
      },
    }),
    settings,
    queuePrefix,
  );
  try {
    await cleanup.addBulk(
      Array.from({ length: MAX_WAKEUPS }, (_, index) => ({
        name: 'visit',
        data: { chatId: '-999', leaseToken: randomUUID() },
        opts: { jobId: `slot-${index}`, delay: 86_400_000 },
      })),
    );
    await worker.start();
    await worker.tickConnections();
    for (let attempt = 0; attempt < 100 && probes.length < 2; attempt++) await delay(20);
    assert.equal(probes.length, 2);
    await worker.tickConnections();
    const jobs = await connections.getJobs(['waiting', 'active', 'delayed']);
    assert.equal(jobs.length, MAX_CONNECTION_WAKEUPS);
    assert.equal(new Set(jobs.map((job) => job.id)).size, MAX_CONNECTION_WAKEUPS);
    for (const job of jobs) assert.match(job.id!, /^slot-(?:[0-9]|1[0-5])$/);
    assert.equal(await cleanup.getJobCountByTypes('delayed'), MAX_WAKEUPS);
    assert.equal(await connections.getJobCountByTypes('active'), 2);
    assert.equal(
      (await pool.query('SELECT COUNT(*)::int AS count FROM eraser_policies WHERE enabled'))
        .rows[0]!.count,
      0,
    );
  } finally {
    release();
    await worker.close();
    await cleanup.obliterate({ force: true });
    await connections.obliterate({ force: true });
    await cleanup.close();
    await connections.close();
  }
});

for (const [who, status, code, expected] of [
  ['bot', 403, 'eraser_rights_missing', 'pending'],
  ['bot', 0, 'membership_unknown', 'pending'],
  ['human', 0, 'membership_unknown', 'pending'],
  ['human', 404, 'not.found', 'pending'],
  ['human', 429, 'rate.limit', 'pending'],
  ['human', 503, 'unavailable', 'pending'],
  ['human', 403, 'chat.denied', 'pending'],
  ['human', 403, 'actor_rights_missing', 'cancelled'],
] as const) {
  test(`${who} rights ${status} keeps connection request ${expected} and never enables deletion`, async () => {
    await request();
    const fail = async () => {
      throw new MaxError(status, code, false, 90_000);
    };
    await runtime(who === 'bot' ? { rights: fail } : { actorRights: fail }).connect(
      await reserve(),
    );
    const state = await store.snapshot('-1');
    assert.equal(state.enabled, false);
    assert.equal(connection(state).status, expected);
    const row = (
      await pool.query<{ next_attempt_at: Date; expires_at: Date }>(
        "SELECT next_attempt_at,expires_at FROM eraser_connection_requests WHERE chat_id='-1'",
      )
    ).rows[0]!;
    if (expected === 'pending') {
      assert.ok(row.next_attempt_at.getTime() > Date.now() + 20_000);
      assert.ok(row.next_attempt_at.getTime() <= row.expires_at.getTime());
      if (status === 429) assert.ok(row.next_attempt_at.getTime() > Date.now() + 80_000);
    }
  });
}

test('local protection readiness is checked again before activation and existing holds survive', async () => {
  await request();
  await pool.query(
    "INSERT INTO eraser_candidates(chat_id,message_id,author_id,is_bot,source_ms,lane,state,dispatch_id,attempt_count) VALUES('-1','old-uncertain','9',false,$1,'history','uncertain',$2,1)",
    [Date.now() - 10 * 86_400_000, randomUUID()],
  );
  await runtime({
    actorRights: async () => {
      await store.protect('-1', { ...protection(), sourceRevision: 2, complete: false });
    },
  }).connect(await reserve());
  assert.equal((await store.snapshot('-1')).enabled, false);
  assert.equal(connection(await store.snapshot('-1')).status, 'pending');
  assert.equal(
    (
      await pool.query(
        "SELECT * FROM eraser_protected_messages WHERE chat_id='-1' AND message_id='old-uncertain'",
      )
    ).rowCount,
    1,
  );
  assert.equal(
    (
      await pool.query(
        "SELECT state FROM eraser_candidates WHERE chat_id='-1' AND message_id='old-uncertain'",
      )
    ).rows[0]!.state,
    'uncertain',
  );
  await store.protect('-1', { ...protection(), sourceRevision: 3 });
  await makeDue();
  await runtime().connect(await reserve());
  assert.equal((await store.snapshot('-1')).enabled, true);
  assert.equal(
    (
      await pool.query(
        "SELECT state FROM eraser_candidates WHERE chat_id='-1' AND message_id='old-uncertain'",
      )
    ).rows[0]!.state,
    'uncertain',
  );
});

test('due connection reservations are bounded, exclusive and rotate beyond one batch', async () => {
  for (let id = 1; id <= 25; id++) await request(String(-id));
  const batches = await Promise.all([store.reserveConnections(7), store.reserveConnections(7)]);
  assert.equal(batches[0].length, 7);
  assert.equal(batches[1].length, 7);
  const seen = new Set(batches.flat().map((row) => row.chatId));
  assert.equal(seen.size, 14);
  for (const wakeup of batches.flat())
    await store.finishConnection(wakeup.chatId, wakeup.leaseToken, 'pending', null, 30_000);
  const final = await store.reserveConnections(16);
  assert.equal(final.length, 11);
  for (const wakeup of final) assert.equal(seen.has(wakeup.chatId), false);
});

test('internal pending PUT acknowledges opt-in without probing before the bot is added', async () => {
  await store.bootstrap('-1', 48, protection());
  let probes = 0;
  const max = transport({
    rights: async () => {
      probes++;
      throw new MaxError(403, 'eraser_rights_missing', false);
    },
    actorRights: async () => {
      probes++;
    },
  });
  const server = createHttpServer(store, max, runtime(), settings, () => redis.ping());
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/internal/v1/chats/-1/policy`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${settings.controlToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(requestInput()),
    });
    assert.equal(response.status, 200);
    const state = (await response.json()) as Record<string, unknown>;
    assert.equal(state.enabled, false);
    assert.equal(connection(state).status, 'pending');
    assert.equal(probes, 0);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
