import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, beforeEach, test } from 'node:test';
import pg from 'pg';
import { observePoolErrors } from '../src/pool-errors.js';
import { migrate } from '../src/migrate.js';
import { Store } from '../src/store.js';

const databaseUrl = process.env.MAXIM_TEST_POSTGRES_URL;
if (!databaseUrl) throw new Error('Use the public with-test-stores wrapper');
const schema = `eraser_housekeeping_${randomUUID().replaceAll('-', '')}`;
const admin = new pg.Pool({ connectionString: databaseUrl, max: 1 });
const pool = new pg.Pool({
  connectionString: databaseUrl,
  max: 4,
  options: `-c search_path=${schema} -c timezone=UTC -c statement_timeout=2000 -c lock_timeout=500`,
});
const store = new Store(pool, true);
before(async () => {
  await admin.query(`CREATE SCHEMA ${schema}`);
  await migrate(pool);
});
after(async () => {
  await pool.end();
  await admin.query(`DROP SCHEMA ${schema} CASCADE`);
  await admin.end();
});
beforeEach(async () => {
  await pool.query('TRUNCATE eraser_policies,eraser_webhook_receipts CASCADE');
  await store.bootstrap('-1', 24);
});
async function candidate(id: string, state = 'deleted', age = '8 days') {
  await pool.query(
    `INSERT INTO eraser_candidates(chat_id,message_id,author_id,is_bot,source_ms,lane,state,updated_at)
    VALUES('-1',$1,'10',false,1,'live',$2,now()-$3::interval)`,
    [id, state, age],
  );
}
test('housekeeping skips a locked terminal row and continues independent expired records', async () => {
  await candidate('locked');
  await candidate('free');
  await pool.query(
    "INSERT INTO eraser_webhook_receipts(receipt_key,received_at) VALUES('old',now()-interval '8 days')",
  );
  const lock = await pool.connect();
  try {
    await lock.query('BEGIN');
    await lock.query("SELECT 1 FROM eraser_candidates WHERE message_id='locked' FOR UPDATE");
    await store.housekeeping();
    assert.deepEqual((await pool.query('SELECT message_id FROM eraser_candidates')).rows, [
      { message_id: 'locked' },
    ]);
    assert.equal((await pool.query('SELECT 1 FROM eraser_webhook_receipts')).rowCount, 0);
  } finally {
    await lock.query('ROLLBACK');
    lock.release();
  }
});
test('seven-day retention and every nonterminal journal survive maintenance', async () => {
  for (const state of ['pending', 'dispatching', 'uncertain', 'review'])
    await candidate(state, state, '90 days');
  await candidate('recent', 'deleted', '6 days 23 hours');
  await candidate('recent-protection', 'protected', '6 days');
  await candidate('expired');
  await candidate('expired-protection', 'protected');
  await pool.query(
    "INSERT INTO eraser_webhook_receipts(receipt_key,received_at) VALUES('recent',now()-interval '6 days'),('expired',now()-interval '8 days')",
  );
  await store.housekeeping();
  assert.deepEqual(
    (await pool.query('SELECT message_id FROM eraser_candidates ORDER BY message_id')).rows.map(
      (r) => r.message_id,
    ),
    ['dispatching', 'pending', 'recent', 'recent-protection', 'review', 'uncertain'],
  );
  assert.deepEqual((await pool.query('SELECT receipt_key FROM eraser_webhook_receipts')).rows, [
    { receipt_key: 'recent' },
  ]);
});

test('purge walks only indexed expiry pages beside retained history', async () => {
  const { HOUSEKEEPING_PAGE_SQL } = await import('../src/housekeeping.js');
  await pool.query(`INSERT INTO eraser_candidates(chat_id,message_id,author_id,is_bot,source_ms,lane,state,updated_at)
    SELECT '-1',n::text,'10',false,1,'live','deleted',now()-CASE WHEN n<=20000 THEN interval '8 days' ELSE interval '1 day' END
    FROM generate_series(1,40000)n`);
  await pool.query(`INSERT INTO eraser_webhook_receipts(receipt_key,received_at)
    SELECT n::text,now()-CASE WHEN n<=20000 THEN interval '8 days' ELSE interval '1 day' END FROM generate_series(1,40000)n`);
  await pool.query('ANALYZE eraser_candidates; ANALYZE eraser_webhook_receipts');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query(
      'EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) ' + HOUSEKEEPING_PAGE_SQL,
      [500, 1000],
    );
    type Plan = {
      'Node Type': string;
      'Relation Name'?: string;
      'Index Name'?: string;
      'Actual Rows': number;
      'Actual Loops': number;
      Plans?: Plan[];
    };
    const nodes: Plan[] = [];
    const walk = (plan: Plan) => {
      nodes.push(plan);
      for (const child of plan.Plans ?? []) walk(child);
    };
    walk(result.rows[0]['QUERY PLAN'][0].Plan);
    assert.equal(
      nodes.some(
        (p) =>
          p['Node Type'] === 'Seq Scan' &&
          ['eraser_candidates', 'eraser_webhook_receipts'].includes(p['Relation Name'] ?? ''),
      ),
      false,
    );
    for (const [index, limit] of [
      ['eraser_candidates_purge_idx', 500],
      ['eraser_webhook_receipts_purge_idx', 1000],
    ] as const) {
      const scans = nodes.filter((p) => p['Index Name'] === index);
      assert.ok(scans.length > 0, index);
      assert.ok(
        scans.reduce((sum, p) => sum + p['Actual Rows'] * p['Actual Loops'], 0) <= limit,
        index + ' stays page bounded',
      );
    }
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
});

test('adaptive passes drain backlog with finite pages and expose stale observations after a failed pass', async () => {
  const maintenance = new Store(pool, true);
  await pool.query(`INSERT INTO eraser_candidates(chat_id,message_id,author_id,is_bot,source_ms,lane,state,updated_at)
    SELECT '-1',n::text,'10',false,1,'live','deleted',now()-interval '8 days' FROM generate_series(1,16000)n`);
  await pool.query(`INSERT INTO eraser_webhook_receipts(receipt_key,received_at)
    SELECT n::text,now()-interval '8 days' FROM generate_series(1,32000)n`);
  await pool.query('ANALYZE eraser_candidates; ANALYZE eraser_webhook_receipts');
  for (let pass = 0; pass < 40; pass++) {
    await maintenance.housekeeping();
    const state = maintenance.housekeepingHealth();
    assert.ok(state.rows.candidates <= 8000 && state.rows.receipts <= 16000);
    assert.ok(state.completedRounds <= 16);
    if (!state.oldestExpiredCandidateAt && !state.oldestExpiredReceiptAt) break;
  }
  const complete = maintenance.housekeepingHealth();
  assert.equal(complete.totalRows.candidates, 16000);
  assert.equal(complete.totalRows.receipts, 32000);
  assert.equal(complete.oldestExpiredCandidateAt, null);
  assert.equal(complete.oldestExpiredReceiptAt, null);
  const lock = await pool.connect();
  try {
    await lock.query('BEGIN; LOCK TABLE eraser_candidates IN ACCESS EXCLUSIVE MODE');
    await assert.rejects(maintenance.housekeeping(), { code: '55P03' });
    const failed = maintenance.housekeepingHealth();
    assert.equal(failed.lastErrorCode, 'query_budget');
    assert.equal(failed.lastSuccessfulAt, complete.lastSuccessfulAt);
    assert.equal(failed.backlogObservedAt, complete.backlogObservedAt);
    assert.equal(failed.running, false);
  } finally {
    await lock.query('ROLLBACK');
    lock.release();
  }
  await maintenance.housekeeping();
  assert.equal(maintenance.housekeepingHealth().lastErrorCode, null);
});

test('an idle PostgreSQL disconnect leaves the process and replacement connection available', async () => {
  const own = new pg.Pool({ connectionString: databaseUrl, max: 1 });
  const logs: string[] = [];
  observePoolErrors(own, (line) => {
    logs.push(line);
    return true;
  });
  try {
    const {
      rows: [identity],
    } = await own.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
    const observed = new Promise<void>((resolve) => own.once('error', () => resolve()));
    await admin.query('SELECT pg_terminate_backend($1)', [identity!.pid]);
    await observed;
    const replacement = await own.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
    assert.notEqual(replacement.rows[0]!.pid, identity!.pid);
    assert.deepEqual(
      logs.map((line) => JSON.parse(line)),
      [{ service: 'eraser', code: 'idle_database_connection_lost' }],
    );
  } finally {
    await own.end();
  }
});
