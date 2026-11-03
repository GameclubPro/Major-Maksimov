import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, beforeEach, test, type TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import pg from 'pg';
import { Redis } from 'ioredis';
import { createHttpServer } from '../src/http.js';
import { migrate } from '../src/migrate.js';
import { Store } from '../src/store.js';
import { CleanupRuntime } from '../src/runtime.js';
import { MaxError, type MaxTransport } from '../src/max.js';
import type { Config } from '../src/config.js';
import type { PolicyActivationProof, UpdatePolicy } from '../src/types.js';
import { connectionProof, updatePolicy } from './support/policy-proof.js';

const databaseUrl = process.env.MAXIM_TEST_POSTGRES_URL;
const redisUrl = process.env.MAXIM_TEST_REDIS_URL;
if (!databaseUrl || !redisUrl) throw new Error('Use the public with-test-stores wrapper');
const schema = `eraser_proof_${randomUUID().replaceAll('-', '')}`;
const admin = new pg.Pool({ connectionString: databaseUrl, max: 1 });
const pool = new pg.Pool({
  connectionString: databaseUrl,
  max: 8,
  application_name: schema,
  options: `-c search_path=${schema} -c timezone=UTC`,
});
const redis = new Redis(redisUrl, { maxRetriesPerRequest: 1 });
const store = new Store(pool, true);
const settings: Config = {
  databaseUrl,
  redisUrl,
  controlToken: 'a'.repeat(32),
  webhookSecret: 'b'.repeat(32),
  botToken: 'synthetic',
  botId: '123',
  apiBaseUrl: 'https://example.invalid',
  port: 3000,
  enabled: true,
  maxRps: 20,
  commitSha: 'native-proof',
  webhookUrl: null,
};
const input = (extra: Partial<UpdatePolicy> = {}): UpdatePolicy => ({
  enabled: true,
  hours: 48,
  expectedRevision: 1,
  operationId: randomUUID(),
  actorUserId: '5',
  ...extra,
});
const protection = () => ({
  sourceRevision: 1,
  protectedMessageIds: ['rules'],
  protectedBotIds: [],
  holdMessageIds: ['held'],
  completeThrough: new Date().toISOString(),
});
type Denial = 'missing' | 'no_access';
async function deny(status: Denial) {
  if (status === 'missing')
    await store.ingest({ update_type: 'bot_removed', chat_id: -1 }, randomUUID());
  else await store.connection('-1', 'no_access');
}
async function setup(status: Denial = 'missing') {
  await store.bootstrap('-1', 48, protection());
  const original = input({ expectedRevision: 0 });
  const response = await updatePolicy(store, '-1', original);
  await deny(status);
  return { original, response };
}
const forbidden = async (): Promise<never> => {
  throw new Error('Unexpected external effect');
};
function transport(overrides: Partial<MaxTransport> = {}): MaxTransport {
  return {
    rights: async (_chat, before) => {
      await before?.();
    },
    actorRights: async (_chat, _actor, before) => {
      await before?.();
    },
    pin: forbidden,
    page: forbidden,
    presence: forbidden,
    remove: forbidden,
    ...overrides,
  };
}
async function http(t: TestContext, overrides: Partial<MaxTransport> = {}, httpStore = store) {
  let checks = 0;
  const max = transport(overrides);
  const server = createHttpServer(
    httpStore,
    {
      ...max,
      rights: async (...args) => {
        checks++;
        await max.rights(...args);
      },
    },
    { health: () => ({ schedulerHealthy: true, schedulerLastSuccessfulAt: null }) },
    settings,
    () => redis.ping(),
  );
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return {
    checks: () => checks,
    save: async (value: UpdatePolicy) => {
      const response = await fetch(`http://127.0.0.1:${address.port}/internal/v1/chats/-1/policy`, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${settings.controlToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(value),
      });
      return { status: response.status, body: (await response.json()) as Record<string, unknown> };
    },
  };
}
async function fenced(status: Denial, revision = 1, hours = 48) {
  const policy = (await store.policy('-1'))!;
  assert.equal(policy.connection_status, status);
  assert.equal(policy.revision, revision);
  assert.equal(policy.hours, hours);
  await pool.query(
    "UPDATE eraser_policies SET normal_next_at=clock_timestamp(),next_run_at=clock_timestamp() WHERE chat_id='-1'",
  );
  assert.deepEqual(await store.reserve(1), []);
}
async function noOperation(operationId: string) {
  assert.equal(
    (await pool.query('SELECT 1 FROM eraser_operations WHERE operation_id=$1', [operationId]))
      .rowCount,
    0,
  );
}
async function waitForLock() {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (
      (
        await pool.query<{ waiting: boolean }>(
          "SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock') AS waiting",
          [schema],
        )
      ).rows[0]?.waiting
    )
      return;
    await delay(10);
  }
  assert.fail('Expected an actual PostgreSQL row-lock wait');
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
  await redis.quit();
});
beforeEach(async () => {
  await pool.query(
    'TRUNCATE eraser_policies,eraser_webhook_receipts,eraser_global_held_authors,eraser_global_message_holds CASCADE',
  );
});

for (const offset of [0, -16_000, -30_000, -59_999, -31 * 60_000, 31 * 60_000]) {
  test(`synthetic connection proofs remain fresh with scheduling clock offset ${offset}ms`, async (t) => {
    const schedulingNow = new Date().getTime() + offset;
    t.mock.method(Date, 'now', () => schedulingNow);
    await store.bootstrap('-1', 48, protection());
    await updatePolicy(store, '-1', input({ expectedRevision: 0 }));
    const active = (await store.policy('-1'))!;
    assert.equal(active.enabled, true);
    assert.equal(Number(active.live_floor), schedulingNow - 48 * 3_600_000 + 1);

    await store.bootstrap('-2', 48, protection());
    await store.update('-2', input({ expectedRevision: 0, connectWhenReady: true }));
    const pending = (await store.reserveConnections(1))[0]!;
    assert.equal(pending.chatId, '-2');
    const expiredAt = new Date(0);
    const expired = await connectionProof(store, '-2', expiredAt);
    assert.equal(expired.expiresAt, expiredAt);
    assert.equal(await store.activateConnection('-2', pending.leaseToken, expired), false);
    assert.equal((await store.policy('-2'))!.enabled, false);

    const proof = await connectionProof(store, '-2');
    const remaining = (
      await pool.query<{ remaining_ms: number }>(
        'SELECT (EXTRACT(EPOCH FROM ($1::timestamptz-clock_timestamp()))*1000)::double precision AS remaining_ms',
        [proof.expiresAt],
      )
    ).rows[0]!.remaining_ms;
    assert.ok(remaining > 0 && remaining <= 15_000, 'proof has at most 15 real seconds');
    assert.equal(await store.activateConnection('-2', pending.leaseToken, proof), true);
  });
}

for (const status of ['missing', 'no_access'] as const) {
  test(`A03 rejected stale HTTP save preserves durable ${status} and execution fence`, async (t) => {
    await setup(status);
    const api = await http(t);
    const request = input({ expectedRevision: 0, hours: 24 });
    const result = await api.save(request);
    assert.equal(result.status, 409);
    assert.equal(result.body.code, 'MESSAGE_RETENTION_REVISION_CONFLICT');
    assert.equal(api.checks(), 0);
    await fenced(status);
    await noOperation(request.operationId);
  });
  test(`accepted exact fresh HTTP save restores ${status} atomically with one operation`, async (t) => {
    await setup(status);
    const api = await http(t);
    const request = input({ hours: 24 });
    const result = await api.save(request);
    assert.equal(result.status, 200);
    assert.equal(result.body.connectionStatus, 'connected');
    const policy = (await store.policy('-1'))!;
    assert.equal(policy.revision, 2);
    assert.equal(policy.hours, 24);
    assert.equal(policy.connection_generation, '1');
    const reserved = await store.reserve(1);
    assert.equal(reserved.length, 1);
    assert.ok(await store.active('-1', reserved[0]!.leaseToken));
    assert.equal(
      (
        await pool.query('SELECT 1 FROM eraser_operations WHERE operation_id=$1', [
          request.operationId,
        ])
      ).rowCount,
      1,
    );
  });
  test(`operation replay after ${status} returns its receipt without reactivation`, async (t) => {
    const { original, response } = await setup(status);
    const api = await http(t);
    const result = await api.save(original);
    assert.equal(result.status, 200);
    assert.deepEqual(result.body, response);
    assert.equal(api.checks(), 0);
    await fenced(status);
  });
  for (const newer of ['missing', 'no_access'] as const) {
    test(`${status} proof is superseded by ${newer} committed while rights are awaited`, async (t) => {
      await setup(status);
      const api = await http(t, {
        rights: async (_chat, before) => {
          await before?.();
          await deny(newer);
        },
      });
      const request = input({ hours: 24 });
      const result = await api.save(request);
      assert.equal(result.status, 409);
      assert.equal(result.body.code, 'ERASER_CONNECTION_GUARD_CHANGED');
      assert.equal((await store.policy('-1'))!.connection_generation, '2');
      await fenced(newer);
      await noOperation(request.operationId);
    });
  }
}

test('missing or malformed internal proof cannot lift a durable fence', async () => {
  await setup();
  for (const proof of [
    undefined,
    null,
    {},
    { chatId: '-1', connectionGeneration: {}, expiresAt: new Date() },
  ])
    await assert.rejects(store.update('-1', input(), proof as PolicyActivationProof | undefined), {
      code: 'ERASER_CONNECTION_GUARD_CHANGED',
    });
  await fenced('missing');
});

test('operation payload conflict is rejected before MAX and leaves the fence unchanged', async (t) => {
  const { original } = await setup();
  const api = await http(t);
  const result = await api.save({ ...original, hours: 24 });
  assert.equal(result.status, 409);
  assert.equal(result.body.code, 'ERASER_OPERATION_CONFLICT');
  assert.equal(api.checks(), 0);
  await fenced('missing');
});

test('operation collision committed during rights wins without a late positive side effect', async (t) => {
  await setup();
  const request = input({ hours: 24 });
  const api = await http(t, {
    rights: async () => {
      await store.update('-1', { ...request, enabled: false });
    },
  });
  const result = await api.save(request);
  assert.equal(result.status, 409);
  assert.equal(result.body.code, 'ERASER_OPERATION_CONFLICT');
  await fenced('missing', 2, 24);
  assert.equal((await store.policy('-1'))!.enabled, false);
});

test('concurrent exact replay after a newer denial never rewrites current authority', async (t) => {
  await setup();
  const request = input();
  let saved: Record<string, unknown> | undefined;
  const api = await http(t, {
    rights: async () => {
      saved = await updatePolicy(store, '-1', request);
      await deny('no_access');
    },
  });
  const result = await api.save(request);
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, saved);
  await fenced('no_access', 2);
  assert.equal((await store.policy('-1'))!.connection_generation, '2');
});

for (const change of ['cancel', 'protection'] as const) {
  test(`${change} during rights rejects activation without changing protected effect journals`, async (t) => {
    await setup();
    await pool.query(
      "INSERT INTO eraser_candidates(chat_id,message_id,author_id,is_bot,source_ms,lane,state,attempt_count,dispatch_id) VALUES('-1','unknown','5',false,1,'history','uncertain',1,$1)",
      [randomUUID()],
    );
    const before = (await pool.query("SELECT * FROM eraser_candidates WHERE chat_id='-1'")).rows;
    const api = await http(t, {
      rights: async () => {
        if (change === 'cancel') await store.update('-1', input({ enabled: false }));
        else await store.protect('-1', { ...protection(), sourceRevision: 2, complete: false });
      },
    });
    const request = input({ hours: 24 });
    const result = await api.save(request);
    assert.equal(result.status, 409);
    assert.equal(
      result.body.code,
      change === 'cancel' ? 'MESSAGE_RETENTION_REVISION_CONFLICT' : 'ERASER_PROTECTION_PENDING',
    );
    await fenced('missing', change === 'cancel' ? 2 : 1);
    await noOperation(request.operationId);
    assert.deepEqual(
      (await pool.query("SELECT * FROM eraser_candidates WHERE chat_id='-1'")).rows,
      before,
    );
    assert.equal(
      (
        await pool.query(
          "SELECT 1 FROM eraser_protected_messages WHERE chat_id='-1' AND message_id='held'",
        )
      ).rowCount,
      1,
    );
  });
}

for (const status of ['missing', 'no_access'] as const) {
  test(`a ${status} committed by the policy lock holder supersedes the waiting HTTP activation`, async (t) => {
    await setup();
    const blocker = await pool.connect();
    let saving: ReturnType<Awaited<ReturnType<typeof http>>['save']> | undefined;
    try {
      const api = await http(t, {
        rights: async () => {
          await blocker.query('BEGIN');
          await blocker.query("SELECT chat_id FROM eraser_policies WHERE chat_id='-1' FOR UPDATE");
        },
      });
      const request = input({ hours: 24 });
      saving = api.save(request);
      await waitForLock();
      await blocker.query(
        "UPDATE eraser_policies SET connection_status=$1,connection_generation=connection_generation+1 WHERE chat_id='-1'",
        [status],
      );
      await blocker.query('COMMIT');
      const result = await saving;
      assert.equal(result.status, 409);
      assert.equal(result.body.code, 'ERASER_CONNECTION_GUARD_CHANGED');
      await fenced(status);
      await noOperation(request.operationId);
    } finally {
      await blocker.query('ROLLBACK');
      blocker.release();
      await saving?.catch(() => {});
    }
  });
}

test('immediate proof expires across a real row-lock wait using database wall time', async () => {
  await setup();
  const request = input();
  const proof = {
    ...(await store.activationGuard('-1', request)),
    expiresAt: new Date(Date.now() + 300),
  };
  const blocker = await pool.connect();
  let saving: Promise<unknown> | undefined;
  try {
    await blocker.query('BEGIN');
    await blocker.query("SELECT chat_id FROM eraser_policies WHERE chat_id='-1' FOR UPDATE");
    saving = store.update('-1', request, proof);
    const rejected = assert.rejects(saving, { code: 'ERASER_CONNECTION_GUARD_CHANGED' });
    await waitForLock();
    await delay(Math.max(1, proof.expiresAt.getTime() - Date.now() + 50));
    await blocker.query('COMMIT');
    await rejected;
    await fenced('missing');
    await noOperation(request.operationId);
  } finally {
    await blocker.query('ROLLBACK');
    blocker.release();
    await saving?.catch(() => {});
  }
});

for (const failure of [
  new MaxError(403, 'eraser_rights_missing', false),
  new MaxError(429, 'rate.limit', false, 1000),
  new MaxError(503, 'lookup.failed', false),
  new MaxError(0, 'membership_unknown', false),
]) {
  test(`rights failure ${failure.code} cannot grant authority or invent ambiguous denial`, async (t) => {
    await setup();
    const api = await http(t, {
      rights: async () => {
        throw failure;
      },
    });
    const request = input();
    const result = await api.save(request);
    const denied = failure.code === 'eraser_rights_missing';
    assert.equal(result.status, denied ? 409 : 503);
    await fenced(denied ? 'no_access' : 'missing');
    assert.equal((await store.policy('-1'))!.connection_generation, denied ? '2' : '1');
    await noOperation(request.operationId);
  });
}

test('generation is narrow, survives migration replay and counts each new denial', async () => {
  await setup();
  await migrate(pool);
  await store.connection('-1', 'connected');
  await store.protect('-1', { ...protection(), sourceRevision: 2 });
  await pool.query(
    "UPDATE eraser_policies SET scan_generation=scan_generation+1,due_generation=due_generation+1,lease_token=$1 WHERE chat_id='-1'",
    [randomUUID()],
  );
  assert.equal((await store.policy('-1'))!.connection_generation, '1');
  await store.ingest({ update_type: 'bot_removed', chat_id: -1 }, 'same-removal');
  await store.ingest({ update_type: 'bot_removed', chat_id: -1 }, 'same-removal');
  assert.equal((await store.policy('-1'))!.connection_generation, '2');
  await deny('no_access');
  await deny('no_access');
  assert.equal((await store.policy('-1'))!.connection_generation, '4');
});

for (const phase of ['bot', 'actor'] as const) {
  for (const status of ['missing', 'no_access'] as const) {
    test(`pending activation preserves ${status} committed during ${phase} rights`, async () => {
      await store.bootstrap('-1', 48, protection());
      await store.update('-1', input({ expectedRevision: 0, connectWhenReady: true }));
      const request = (await store.reserveConnections(1))[0]!;
      assert.ok(request);
      const expiry = (await store.connectionRequest('-1', request.leaseToken))!.expires_at;
      const max = transport({
        ...(phase === 'bot'
          ? {
              rights: async () => {
                await deny(status);
              },
            }
          : {
              actorRights: async () => {
                await deny(status);
              },
            }),
      });
      await new CleanupRuntime(store, max, settings).connect(request);
      await fenced(status);
      assert.equal((await store.policy('-1'))!.enabled, false);
      const pending = (
        await pool.query("SELECT * FROM eraser_connection_requests WHERE chat_id='-1'")
      ).rows[0];
      assert.equal(pending.status, 'pending');
      assert.deepEqual(pending.expires_at, expiry);
    });
  }
}

for (const status of ['missing', 'no_access'] as const) {
  test(`pending proof cannot cross a ${status} committed during its policy lock wait`, async () => {
    await store.bootstrap('-1', 48, protection());
    await store.update('-1', input({ expectedRevision: 0, connectWhenReady: true }));
    const request = (await store.reserveConnections(1))[0]!;
    const proof = await connectionProof(store, '-1');
    const blocker = await pool.connect();
    let activating: Promise<boolean> | undefined;
    try {
      await blocker.query('BEGIN');
      await blocker.query("SELECT chat_id FROM eraser_policies WHERE chat_id='-1' FOR UPDATE");
      activating = store.activateConnection('-1', request.leaseToken, proof);
      await waitForLock();
      await blocker.query(
        "UPDATE eraser_policies SET connection_status=$1,connection_generation=connection_generation+1 WHERE chat_id='-1'",
        [status],
      );
      await blocker.query('COMMIT');
      assert.equal(await activating, false);
      await fenced(status);
      assert.equal((await store.policy('-1'))!.enabled, false);
    } finally {
      await blocker.query('ROLLBACK');
      blocker.release();
      await activating?.catch(() => {});
    }
  });
}

test('pending exact bot denial installs a generation even if status was already no_access', async () => {
  await store.bootstrap('-1', 48, protection());
  await store.update('-1', input({ expectedRevision: 0, connectWhenReady: true }));
  await deny('no_access');
  const request = (await store.reserveConnections(1))[0]!;
  await new CleanupRuntime(
    store,
    transport({
      rights: async () => {
        throw new MaxError(403, 'eraser_rights_missing', false);
      },
    }),
    settings,
  ).connect(request);
  assert.equal((await store.policy('-1'))!.connection_generation, '2');
  await fenced('no_access');
});

test('proof expiry during candidate parking rolls back policy, operation and parked work', async () => {
  await setup();
  await pool.query(
    "INSERT INTO eraser_candidates(chat_id,message_id,author_id,is_bot,source_ms,lane) VALUES('-1','young','5',false,$1,'history')",
    [Date.now() - 70 * 3_600_000],
  );
  const request = input({ hours: 168 });
  const proof = {
    ...(await store.activationGuard('-1', request)),
    expiresAt: new Date(Date.now() + 300),
  };
  const blocker = await pool.connect();
  let saving: Promise<unknown> | undefined;
  try {
    await blocker.query('BEGIN');
    await blocker.query("SELECT message_id FROM eraser_candidates WHERE chat_id='-1' FOR UPDATE");
    saving = store.update('-1', request, proof);
    const rejected = assert.rejects(saving, { code: 'ERASER_CONNECTION_GUARD_CHANGED' });
    await waitForLock();
    await delay(Math.max(1, proof.expiresAt.getTime() - Date.now() + 50));
    await blocker.query('COMMIT');
    await rejected;
    await fenced('missing');
    await noOperation(request.operationId);
    assert.equal(
      (
        await pool.query(
          "SELECT 1 FROM eraser_candidates WHERE chat_id='-1' AND message_id='young'",
        )
      ).rowCount,
      1,
    );
    assert.equal(
      (await pool.query("SELECT 1 FROM eraser_future_hours WHERE chat_id='-1'")).rowCount,
      0,
    );
  } finally {
    await blocker.query('ROLLBACK');
    blocker.release();
    await saving?.catch(() => {});
  }
});

test('negative observation during MAX admission aborts the captured guard before HTTP', async (t) => {
  await setup();
  const api = await http(t, {
    rights: async (_chat, before) => {
      await deny('missing');
      await before?.();
      assert.fail('superseded guard cannot start MAX HTTP');
    },
  });
  const result = await api.save(input());
  assert.equal(result.status, 409);
  assert.equal(result.body.code, 'ERASER_CONNECTION_GUARD_CHANGED');
  await fenced('missing');
});

test('status ABA cannot revive a proof captured before two new negative observations', async (t) => {
  await setup();
  const api = await http(t, {
    rights: async () => {
      await deny('no_access');
      await deny('missing');
    },
  });
  assert.equal((await api.save(input())).status, 409);
  await fenced('missing');
  assert.equal((await store.policy('-1'))!.connection_generation, '3');
});

test('a fresh pending retry after denial preserves its original operation and expiry', async () => {
  await store.bootstrap('-1', 48, protection());
  const requested = input({ expectedRevision: 0, connectWhenReady: true });
  await store.update('-1', requested);
  const first = (await store.reserveConnections(1))[0]!;
  const expiry = (await store.connectionRequest('-1', first.leaseToken))!.expires_at;
  await new CleanupRuntime(
    store,
    transport({
      rights: async () => {
        throw new MaxError(403, 'eraser_rights_missing', false);
      },
    }),
    settings,
  ).connect(first);
  await pool.query(
    "UPDATE eraser_connection_requests SET next_attempt_at=clock_timestamp() WHERE chat_id='-1'",
  );
  const next = (await store.reserveConnections(1))[0]!;
  await new CleanupRuntime(store, transport(), settings).connect(next);
  const policy = (await store.policy('-1'))!;
  assert.equal(policy.enabled, true);
  assert.equal(policy.connection_status, 'connected');
  assert.equal(policy.revision, 2);
  assert.equal(policy.connection_generation, '1');
  assert.equal(policy.last_operation_id, requested.operationId);
  const stored = (await pool.query("SELECT * FROM eraser_connection_requests WHERE chat_id='-1'"))
    .rows[0];
  assert.equal(stored.operation_id, requested.operationId);
  assert.deepEqual(stored.expires_at, expiry);
  assert.equal(stored.status, 'activated');
});

test('a replay committed between HTTP receipt lookup and guard capture returns the original result', async (t) => {
  await setup();
  const request = input();
  let entered!: () => void;
  const entering = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  class DelayedGuardStore extends Store {
    override async activationGuard(chatId: string, value: UpdatePolicy) {
      entered();
      await gate;
      return super.activationGuard(chatId, value);
    }
  }
  const api = await http(t, {}, new DelayedGuardStore(pool, true));
  const saving = api.save(request);
  try {
    await entering;
    const committed = await updatePolicy(store, '-1', request);
    await deny('no_access');
    release();
    const result = await saving;
    assert.equal(result.status, 200);
    assert.deepEqual(result.body, committed);
    assert.equal(api.checks(), 0);
    await fenced('no_access', 2);
  } finally {
    release();
    await saving.catch(() => {});
  }
});

test('exact replay committed during MAX admission returns its receipt when the callback rejects the old revision', async (t) => {
  await setup();
  const request = input();
  let committed: Record<string, unknown> | undefined;
  const api = await http(t, {
    rights: async (_chat, before) => {
      committed = await updatePolicy(store, '-1', request);
      await deny('no_access');
      await before?.();
      assert.fail('a replay must not start another MAX request');
    },
  });
  const result = await api.save(request);
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, committed);
  await fenced('no_access', 2);
});
