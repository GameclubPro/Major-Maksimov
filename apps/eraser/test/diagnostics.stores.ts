import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import pg from 'pg';
import type { Config } from '../src/config.js';
import { createHttpServer } from '../src/http.js';
import { migrate } from '../src/migrate.js';
import type { MaxTransport } from '../src/max.js';
import { Store } from '../src/store.js';
import { updatePolicy } from './support/policy-proof.js';
import type { Candidate } from '../src/types.js';
import type { CleanupRuntime } from '../src/runtime.js';

const databaseUrl = process.env.MAXIM_TEST_POSTGRES_URL;
const redisUrl = process.env.MAXIM_TEST_REDIS_URL;
if (!databaseUrl || !redisUrl) throw new Error('Use the public with-test-stores wrapper');
const schema = `eraser_diagnostics_${randomUUID().replaceAll('-', '')}`;
const admin = new pg.Pool({ connectionString: databaseUrl, max: 1 });
const pool = new pg.Pool({
  connectionString: databaseUrl,
  max: 4,
  options: `-c search_path=${schema} -c timezone=UTC`,
});
const store = new Store(pool, true);
let health: ReturnType<CleanupRuntime['health']> = {
  schedulerHealthy: true,
  schedulerLastSuccessfulAt: null,
};
const settings: Config = {
  databaseUrl,
  redisUrl,
  controlToken: 'a'.repeat(32),
  webhookSecret: 'b'.repeat(32),
  botToken: 'test',
  botId: '1',
  apiBaseUrl: 'https://platform-api2.max.ru',
  port: 3000,
  enabled: true,
  maxRps: 20,
  commitSha: 'native-diagnostics',
  webhookUrl: null,
};
const noMax: MaxTransport = {
  rights: async () => assert.fail('Diagnostics cannot probe MAX'),
  actorRights: async () => assert.fail('Diagnostics cannot probe MAX'),
  pin: async () => assert.fail('Diagnostics cannot probe MAX'),
  page: async () => assert.fail('Diagnostics cannot probe MAX'),
  presence: async () => assert.fail('Diagnostics cannot inspect unknown effects'),
  remove: async () => assert.fail('Diagnostics cannot dispatch DELETE'),
};
const server = createHttpServer(
  store,
  noMax,
  {
    health: () => health,
  },
  settings,
  async () => 'PONG',
);
let base: string;
const headers = { Authorization: `Bearer ${settings.controlToken}` };
type State = {
  chatId: string;
  initialized: boolean;
  pendingCount: number;
  deletedCount: number;
  oldestDueAt: string | null;
  status: string;
  progress: {
    pendingCountComplete: boolean;
    eligibleCount: number;
    eligibleCountComplete: boolean;
    oldestEligibleDueAt: string | null;
    unknownCount: number;
    unknownCountComplete: boolean;
    oldestUnknownAt: string | null;
  };
  coverage: {
    lastCompletedAt: string | null;
    gap: boolean;
    protectedHistory: boolean;
    executionStopped: boolean;
  };
  confirmationCounts: {
    historicalUnknown: number;
    deleteAcknowledged: number;
    removalReceipt: number;
  };
  connectionRequest: {
    status: string;
    operationId: string;
    actorUserId: string;
    policyRevision: number;
    expiresAt: string;
    nextAttemptAt: string | null;
    updatedAt: string;
    lastError: string | null;
  } | null;
};
type Runtime = {
  items: State[];
  nextAfter: string | null;
  incomplete: boolean;
  unavailableSources: Array<{ chatId: string; reason: string }>;
  cooldown: { durableUntil: string | null };
};
type Review = {
  items: Array<{
    messageId: string;
    intentStatus: string;
    intentUpdatedAt: string;
    retryAllowed: boolean;
    reconcileAfter: string | null;
  }>;
  nextAfter: string | null;
  incomplete: boolean;
};
async function read<T>(path: string): Promise<T> {
  const response = await fetch(`${base}/internal/v1/${path}`, { headers });
  assert.equal(response.status, 200);
  return (await response.json()) as T;
}
async function insert(messageId: string, state = 'pending', age = 8 * 86_400_000) {
  return (
    await pool.query<Candidate>(
      `INSERT INTO eraser_candidates(chat_id,message_id,author_id,is_bot,source_ms,lane,state)
     VALUES('-1',$1,'5',false,$2,'history',$3) RETURNING *`,
      [messageId, Date.now() - age, state],
    )
  ).rows[0]!;
}
before(async () => {
  await admin.query(`CREATE SCHEMA ${schema}`);
  await migrate(pool);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  base = `http://127.0.0.1:${address.port}`;
});
after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await pool.end();
  await admin.query(`DROP SCHEMA ${schema} CASCADE`);
  await admin.end();
});
beforeEach(async () => {
  health = { schedulerHealthy: true, schedulerLastSuccessfulAt: null };
  await pool.query('TRUNCATE eraser_policies,eraser_webhook_receipts,eraser_rate_limits CASCADE');
  await store.bootstrap('-1', 24);
  await pool.query(
    "UPDATE eraser_policies SET enabled=true,connection_status='connected' WHERE chat_id='-1'",
  );
});

test('50 runtime policies use at most three SQL statements and selected missing sources remain explicit', async (t) => {
  await pool.query(
    `INSERT INTO eraser_policies(chat_id,hours,activation_id)
    SELECT (-n)::text,24,$1 FROM generate_series(2,51) n`,
    [randomUUID()],
  );
  const spy = t.mock.method(pool, 'query');
  const page = await read<Runtime>('runtime');
  assert.equal(page.items.length, 50);
  assert.ok(page.nextAfter);
  assert.ok(spy.mock.callCount() <= 3, `${spy.mock.callCount()} SQL statements`);
  spy.mock.restore();
  const selected = await read<Runtime>('runtime?chatIds=-1,-999');
  assert.deepEqual(
    selected.items.map((item) => item.chatId),
    ['-1'],
  );
  assert.deepEqual(
    selected.unavailableSources.map((item) => [item.chatId, item.reason]),
    [['-999', 'not_initialized']],
  );
  assert.equal(selected.incomplete, true);
  assert.equal(selected.nextAfter, null);
});

test('policy reads expose initialization without creating policy rows', async () => {
  assert.equal((await read<State>('chats/-999/policy')).initialized, false);
  assert.equal(await store.policy('-999'), null);
  assert.equal((await read<State>('chats/-1/policy')).initialized, true);
});

test('public health projection distinguishes healthy idle work from a stopped worker without changing saved settings', async () => {
  await store.protect('-1', {
    sourceRevision: 1,
    protectedMessageIds: [],
    protectedBotIds: [],
    holdMessageIds: [],
    completeThrough: new Date().toISOString(),
  });
  const input = {
    enabled: true,
    hours: 24 as const,
    expectedRevision: 0,
    operationId: randomUUID(),
    actorUserId: '5',
  };
  const stored = await updatePolicy(store, '-1', input);
  assert.equal((await read<State>('chats/-1/policy')).status, 'running');
  assert.equal((await read<State>('chats/-1/policy')).coverage.executionStopped, false);
  const worker = {
    healthy: true,
    ready: true,
    running: true,
    sampledAt: new Date().toISOString(),
    occupiedSlots: 0,
    oldestOccupiedAt: null,
    lastCompletedAt: null,
    lastErrorAt: null,
    lastErrorCode: null,
    progressOverdue: false,
  };
  health = {
    ...health,
    workers: { cleanup: { ...worker, healthy: false, running: false }, connection: worker },
  };
  const before = await store.policy('-1');
  const stopped = await read<State>('chats/-1/policy');
  assert.equal(stopped.status, 'unavailable');
  assert.equal(stopped.coverage.executionStopped, true);
  assert.deepEqual(await store.policy('-1'), before);
  assert.deepEqual(await store.operation('-1', input), stored);
  const cached = await fetch(`${base}/internal/v1/chats/-1/policy`, {
    method: 'PUT',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  assert.equal(cached.status, 200);
  assert.equal(((await cached.json()) as State).coverage.executionStopped, true);
  assert.deepEqual(
    await store.operation('-1', input),
    stored,
    'Health projection cannot rewrite an idempotency receipt',
  );
  health = { schedulerHealthy: false, schedulerLastSuccessfulAt: null };
  assert.equal((await read<State>('chats/-1/policy')).status, 'unavailable');
  health = { schedulerHealthy: true, schedulerLastSuccessfulAt: null };
  assert.equal((await read<State>('chats/-1/policy')).coverage.executionStopped, false);
  await pool.query("UPDATE eraser_policies SET enabled=false WHERE chat_id='-1'");
  health = { schedulerHealthy: false, schedulerLastSuccessfulAt: null };
  assert.equal((await read<State>('chats/-1/policy')).status, 'off');
});

test('eligible, unknown and protected coverage remain separate with honest count caps', async () => {
  const due = await insert('due');
  await insert('young', 'pending', 1000);
  await insert('waiting');
  await pool.query(
    "UPDATE eraser_candidates SET next_attempt_at=clock_timestamp()+INTERVAL '1 hour' WHERE message_id='waiting'",
  );
  await insert('fresh', 'dispatching');
  await pool.query(
    "UPDATE eraser_candidates SET next_attempt_at=clock_timestamp()+INTERVAL '10 seconds' WHERE message_id='fresh'",
  );
  await insert('unknown', 'uncertain', 20 * 86_400_000);
  await insert('aged', 'dispatching');
  await pool.query(
    "UPDATE eraser_candidates SET updated_at=clock_timestamp()-INTERVAL '2 minutes',next_attempt_at=clock_timestamp()-INTERVAL '1 minute' WHERE message_id='aged'",
  );
  await pool.query(`UPDATE eraser_policies SET historical_deferred_from=1,safety_gap_at=1,
    last_live_completed_at='2026-10-28T01:02:03Z' WHERE chat_id='-1'`);
  const state = await read<State>('chats/-1/policy');
  assert.equal(state.pendingCount, 3);
  assert.equal(state.progress.eligibleCount, 1);
  assert.equal(state.progress.unknownCount, 2);
  assert.equal(state.oldestDueAt, new Date(Number(due.source_ms) + 86_400_000).toISOString());
  assert.ok(Date.parse(state.progress.oldestUnknownAt!) > Date.now() - 180_000);
  assert.deepEqual(state.coverage, {
    lastCompletedAt: '2026-10-28T01:02:03.000Z',
    gap: true,
    protectedHistory: true,
    executionStopped: false,
  });
  await pool.query(
    `INSERT INTO eraser_candidates(chat_id,message_id,author_id,source_ms,lane,state)
    SELECT '-1','extra-'||n,'5',$1,'live','pending' FROM generate_series(1,220) n`,
    [Date.now() - 8 * 86_400_000],
  );
  const capped = await read<State>('chats/-1/policy');
  assert.equal(capped.pendingCount, 200);
  assert.equal(capped.progress.pendingCountComplete, false);
  assert.equal(capped.progress.eligibleCount, 200);
  assert.equal(capped.progress.eligibleCountComplete, false);
});

test('review pagination preserves microseconds, binds the policy and only projects aged dispatching', async () => {
  await pool.query(
    `INSERT INTO eraser_candidates(chat_id,message_id,author_id,source_ms,lane,state,updated_at)
    SELECT '-1',LPAD(n::text,3,'0'),'5',$1,'history','review','2026-10-28T00:00:00.123456Z'
    FROM generate_series(1,25) n`,
    [Date.now() - 8 * 86_400_000],
  );
  const first = await read<Review>('chats/-1/review');
  assert.equal(first.items.length, 20);
  assert.equal(first.incomplete, true);
  assert.ok(first.nextAfter);
  assert.equal(first.items[0]!.intentUpdatedAt, '2026-10-28T00:00:00.123456Z');
  const second = await read<Review>(`chats/-1/review?after=${encodeURIComponent(first.nextAfter)}`);
  assert.equal(second.items.length, 5);
  assert.equal(second.incomplete, false);
  assert.equal(second.nextAfter, null);
  const cursor = JSON.parse(Buffer.from(first.nextAfter, 'base64url').toString('utf8'));
  for (const changed of [
    { ...cursor, source: 'legacy' },
    { ...cursor, chatId: '-2' },
  ]) {
    const after = Buffer.from(JSON.stringify(changed)).toString('base64url');
    assert.equal(
      (await fetch(`${base}/internal/v1/chats/-1/review?after=${after}`, { headers })).status,
      409,
    );
  }
  await pool.query("UPDATE eraser_policies SET revision=revision+1 WHERE chat_id='-1'");
  assert.equal(
    (
      await fetch(
        `${base}/internal/v1/chats/-1/review?after=${encodeURIComponent(first.nextAfter)}`,
        { headers },
      )
    ).status,
    409,
  );
  await pool.query('DELETE FROM eraser_candidates');
  await insert('aged', 'dispatching');
  await insert('fresh', 'dispatching');
  await pool.query(
    "UPDATE eraser_candidates SET next_attempt_at=clock_timestamp()+INTERVAL '10 seconds' WHERE message_id='fresh'",
  );
  await pool.query(
    "UPDATE eraser_candidates SET updated_at=clock_timestamp()-INTERVAL '2 minutes',dispatch_id=$1,attempt_count=1 WHERE message_id='aged'",
    [randomUUID()],
  );
  const before = (await pool.query('SELECT * FROM eraser_candidates ORDER BY message_id')).rows;
  const projected = await read<Review>('chats/-1/review');
  assert.equal(projected.items[0]!.intentStatus, 'AMBIGUOUS');
  assert.equal(projected.items[1]!.intentStatus, 'IN_PROGRESS');
  assert.ok(projected.items.every((item) => !item.retryAllowed && item.reconcileAfter === null));
  assert.deepEqual(
    (await pool.query('SELECT * FROM eraser_candidates ORDER BY message_id')).rows,
    before,
  );
});

test('closed connection diagnostics include effective expiry and allowlisted reasons', async () => {
  const operationId = randomUUID();
  await pool.query(
    `INSERT INTO eraser_connection_requests(chat_id,operation_id,actor_user_id,policy_revision,status,expires_at,last_error)
    VALUES('-1',$1,'5',0,'pending',clock_timestamp()-INTERVAL '1 minute','private arbitrary error')`,
    [operationId],
  );
  const runtime = await read<Runtime>('runtime?chatIds=-1');
  const connection = runtime.items[0]!.connectionRequest!;
  assert.equal(connection.status, 'expired');
  assert.equal(connection.operationId, operationId);
  assert.equal(connection.actorUserId, '5');
  assert.equal(connection.nextAttemptAt, null);
  assert.equal(connection.lastError, 'unknown');
  assert.ok(connection.updatedAt);
});

test('first confirmation counters deduplicate both receipt orderings and stale acknowledgements', async () => {
  for (const receiptFirst of [false, true]) {
    const messageId = receiptFirst ? 'receipt-first' : 'ack-first';
    await insert(messageId, 'dispatching');
    const candidate = (
      await pool.query<Candidate>(
        `UPDATE eraser_candidates SET dispatch_id=$2,attempt_count=1
      WHERE message_id=$1 RETURNING *`,
        [messageId, randomUUID()],
      )
    ).rows[0]!;
    const receipt = async () =>
      store.ingest(
        { update_type: 'message_removed', chat_id: '-1', message_id: messageId },
        randomUUID(),
      );
    if (receiptFirst) await receipt();
    await store.settle(candidate, 'deleted', 'deleted');
    await receipt();
    await store.settle(candidate, 'deleted', 'deleted');
    await store.settle({ ...candidate, dispatch_id: randomUUID() }, 'deleted', 'deleted');
  }
  const state = await read<State>('chats/-1/policy');
  assert.equal(state.deletedCount, 2);
  const closed = (await read<Runtime>('runtime?chatIds=-1')).items[0]!;
  assert.deepEqual(closed.confirmationCounts, {
    historicalUnknown: 0,
    deleteAcknowledged: 1,
    removalReceipt: 1,
  });
  await pool.query("UPDATE eraser_policies SET deleted_count=deleted_count+5 WHERE chat_id='-1'");
  const legacy = (await read<Runtime>('runtime?chatIds=-1')).items[0]!;
  assert.deepEqual(legacy.confirmationCounts, {
    historicalUnknown: 5,
    deleteAcknowledged: 1,
    removalReceipt: 1,
  });
  assert.equal(legacy.deletedCount, 7);
});

test('stale issued identity cannot confirm a live effect and concurrent confirmation has one first source', async () => {
  await insert('racing', 'dispatching');
  const candidate = (
    await pool.query<Candidate>(
      `UPDATE eraser_candidates SET dispatch_id=$1,attempt_count=1
    WHERE message_id='racing' RETURNING *`,
      [randomUUID()],
    )
  ).rows[0]!;
  await store.settle({ ...candidate, dispatch_id: randomUUID() }, 'deleted', 'deleted');
  assert.equal((await read<State>('chats/-1/policy')).deletedCount, 0);
  await Promise.all([
    store.settle(candidate, 'deleted', 'deleted'),
    store.ingest(
      { update_type: 'message_removed', chat_id: '-1', message_id: 'racing' },
      randomUUID(),
    ),
    store.settle(candidate, 'deleted', 'deleted'),
  ]);
  const result = (await new Store(pool, true).runtimeDiagnostics('1', { chatIds: ['-1'] }))
    .items[0]!;
  assert.equal(result.deletedCount, 1);
  assert.equal(result.confirmationCounts.historicalUnknown, 0);
  assert.equal(
    result.confirmationCounts.deleteAcknowledged + result.confirmationCounts.removalReceipt,
    1,
  );
});

test('runtime returns the configured durable cooldown even without a policy and rejects unbounded selections', async () => {
  const deadline = new Date(Date.now() + 60_000).toISOString();
  await pool.query('INSERT INTO eraser_rate_limits(bot_id,not_before) VALUES($1,$2),($3,$4)', [
    '1',
    deadline,
    '2',
    new Date(Date.now() + 120_000),
  ]);
  assert.equal((await read<Runtime>('runtime?chatIds=-999')).cooldown.durableUntil, deadline);
  for (const query of [
    'chatIds=-1,-1',
    'chatIds=-1&after=-1',
    `chatIds=${Array.from({ length: 51 }, (_, i) => -i - 1).join(',')}`,
  ]) {
    assert.equal((await fetch(`${base}/internal/v1/runtime?${query}`, { headers })).status, 400);
  }
});

test('diagnostic and review probes remain indexed and bounded behind retained terminal and unknown histories', async (t) => {
  await pool.query(
    `INSERT INTO eraser_candidates(chat_id,message_id,author_id,source_ms,lane,state,next_attempt_at)
    SELECT '-1','a-terminal-'||LPAD(n::text,6,'0'),'5',$1,'history','deleted',clock_timestamp()
    FROM generate_series(1,30000) n`,
    [Date.now() - 8 * 86_400_000],
  );
  await pool.query(
    `INSERT INTO eraser_candidates(chat_id,message_id,author_id,source_ms,lane,state,next_attempt_at)
    SELECT '-1','z-'||state||'-'||LPAD(n::text,6,'0'),'5',$1,'history',state,
      clock_timestamp()+CASE WHEN state='dispatching' THEN INTERVAL '1 hour' ELSE INTERVAL '0 seconds' END
    FROM unnest(ARRAY['uncertain','dispatching','pending','review']) state CROSS JOIN generate_series(1,1000) n`,
    [Date.now() - 8 * 86_400_000],
  );
  await pool.query('ANALYZE eraser_candidates');
  const spy = t.mock.method(pool, 'query');
  const runtime = await read<Runtime>('runtime?chatIds=-1');
  assert.equal(runtime.items[0]!.progress.unknownCount, 200);
  assert.equal(runtime.items[0]!.progress.unknownCountComplete, false);
  await read<Review>('chats/-1/review');
  const calls = spy.mock.calls.map((call) => call.arguments as unknown as [string, unknown[]]);
  spy.mock.restore();
  const probes = calls.filter(
    ([sql]) =>
      sql.includes('FROM unnest(') || sql.includes(') states ORDER BY message_id LIMIT 21'),
  );
  assert.equal(probes.length, 2);
  for (const [sql, parameters] of probes) {
    const plan = (await pool.query(`EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) ${sql}`, parameters))
      .rows[0]!['QUERY PLAN'][0].Plan;
    const indexes = new Set<string>();
    function check(node: Record<string, unknown>) {
      if (node['Relation Name'] === 'eraser_candidates') {
        assert.ok(
          ['Index Scan', 'Index Only Scan'].includes(String(node['Node Type'])),
          JSON.stringify(node),
        );
        assert.ok(Number(node['Actual Rows']) <= 201, JSON.stringify(node));
        assert.ok(Number(node['Rows Removed by Filter'] ?? 0) <= 201, JSON.stringify(node));
        indexes.add(String(node['Index Name']));
      }
      for (const child of (node.Plans as Array<Record<string, unknown>>) ?? []) check(child);
    }
    check(plan);
    assert.ok(indexes.size > 0);
    t.diagnostic(`Indexed bounded probes: ${[...indexes].sort().join(', ')}`);
  }
});

test('migration preserves historical unknown totals and classifies compatible older writers honestly', async () => {
  const legacySchema = `eraser_upgrade_${randomUUID().replaceAll('-', '')}`;
  await admin.query(`CREATE SCHEMA ${legacySchema}`);
  const legacy = new pg.Pool({
    connectionString: databaseUrl,
    max: 1,
    options: `-c search_path=${legacySchema} -c timezone=UTC`,
  });
  try {
    await legacy.query(
      'CREATE TABLE eraser_migrations(name text PRIMARY KEY,digest text NOT NULL,applied_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP)',
    );
    const directory = new URL('../migrations/', import.meta.url);
    for (const name of (await readdir(directory))
      .filter((name) => /^000[1-6]-.*\.sql$/.test(name))
      .sort()) {
      const sql = await readFile(new URL(name, directory), 'utf8');
      await legacy.query('BEGIN');
      await legacy.query(sql);
      await legacy.query('INSERT INTO eraser_migrations(name,digest) VALUES($1,$2)', [
        name,
        createHash('sha256').update(sql).digest('hex'),
      ]);
      await legacy.query('COMMIT');
    }
    await legacy.query(
      "INSERT INTO eraser_policies(chat_id,hours,activation_id,deleted_count) VALUES('-1',24,$1,17)",
      [randomUUID()],
    );
    await migrate(legacy);
    const upgraded = new Store(legacy, true);
    assert.deepEqual(
      (await upgraded.runtimeDiagnostics('1', { chatIds: ['-1'] })).items[0]!.confirmationCounts,
      { historicalUnknown: 17, deleteAcknowledged: 0, removalReceipt: 0 },
    );
    await legacy.query(
      "UPDATE eraser_policies SET deleted_count=deleted_count+1 WHERE chat_id='-1'",
    );
    assert.deepEqual(
      (await upgraded.runtimeDiagnostics('1', { chatIds: ['-1'] })).items[0]!.confirmationCounts,
      { historicalUnknown: 18, deleteAcknowledged: 0, removalReceipt: 0 },
    );
  } finally {
    await legacy.end();
    await admin.query(`DROP SCHEMA ${legacySchema} CASCADE`);
  }
});

test('policy and connection page probes stay bounded among 20000 unrelated policies and requests', async (t) => {
  await pool.query(
    `INSERT INTO eraser_policies(chat_id,hours,activation_id)
    SELECT (-n)::text,24,$1 FROM generate_series(2,20000) n`,
    [randomUUID()],
  );
  await pool.query(
    `INSERT INTO eraser_connection_requests(chat_id,operation_id,actor_user_id,policy_revision,status,expires_at)
    SELECT chat_id,$1,'5',revision,'pending',clock_timestamp()+INTERVAL '1 hour' FROM eraser_policies`,
    [randomUUID()],
  );
  await pool.query('ANALYZE eraser_policies');
  await pool.query('ANALYZE eraser_connection_requests');
  for (const selection of [
    {},
    { chatIds: Array.from({ length: 50 }, (_, i) => String(-19000 - i)) },
  ]) {
    const spy = t.mock.method(pool, 'query');
    const result = await store.runtimeDiagnostics('1', selection);
    assert.equal(result.items.length, 50);
    const [sql, parameters] = spy.mock.calls[0]!.arguments as unknown as [string, unknown[]];
    spy.mock.restore();
    const plan = (await pool.query(`EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) ${sql}`, parameters))
      .rows[0]!['QUERY PLAN'][0].Plan;
    function check(node: Record<string, unknown>) {
      if (
        ['eraser_policies', 'eraser_connection_requests'].includes(String(node['Relation Name']))
      ) {
        assert.ok(Number(node['Actual Rows']) <= 51, JSON.stringify(node));
        assert.ok(Number(node['Rows Removed by Filter'] ?? 0) <= 51, JSON.stringify(node));
        t.diagnostic(
          `${node['Relation Name']}: ${node['Node Type']}, ${node['Actual Rows']} rows x ${node['Actual Loops']} loops`,
        );
      }
      for (const child of (node.Plans as Array<Record<string, unknown>>) ?? []) check(child);
    }
    check(plan);
  }
});
