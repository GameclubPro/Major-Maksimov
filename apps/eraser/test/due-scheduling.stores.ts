import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { migrate } from '../src/migrate.js';
import { Store } from '../src/store.js';
import { updatePolicy, connectionProof } from './support/policy-proof.js';
import type { Candidate, Message } from '../src/types.js';

const url = process.env.MAXIM_TEST_POSTGRES_URL;
if (!url) throw new Error('Use the public with-test-stores wrapper');
const schema = `eraser_due_${randomUUID().replaceAll('-', '')}`;
const admin = new pg.Pool({ connectionString: url, max: 1 });
const pool = new pg.Pool({
  connectionString: url,
  max: 4,
  application_name: schema,
  options: `-c search_path=${schema} -c timezone=UTC`,
});
const store = new Store(pool, true);
const HOUR = 3_600_000;
const message = (id: string, sourceMs: number): Message => ({
  id,
  sourceMs,
  chatId: '-1',
  authorId: '5',
  isBot: false,
});
async function enable() {
  await store.bootstrap('-1', 24, {
    sourceRevision: 1,
    protectedMessageIds: [],
    protectedBotIds: [],
    holdMessageIds: [],
    completeThrough: new Date().toISOString(),
  });
  await updatePolicy(store, '-1', {
    enabled: true,
    hours: 24,
    expectedRevision: 0,
    actorUserId: '5',
    operationId: randomUUID(),
  });
}
async function update(hours: 24 | 48 | 168) {
  const policy = (await store.policy('-1'))!;
  return updatePolicy(store, '-1', {
    enabled: true,
    hours,
    expectedRevision: policy.revision,
    actorUserId: '5',
    operationId: randomUUID(),
  });
}
async function wake() {
  await pool.query(
    "UPDATE eraser_policies SET normal_next_at=clock_timestamp(),next_run_at=clock_timestamp() WHERE chat_id='-1'",
  );
  return (await store.reserve(1))[0]!;
}
async function addCandidate(id: string, sourceMs: number): Promise<Candidate> {
  return (
    await pool.query<Candidate>(
      "INSERT INTO eraser_candidates(chat_id,message_id,author_id,is_bot,source_ms,lane) VALUES('-1',$1,'5',false,$2,'history') RETURNING *",
      [id, sourceMs],
    )
  ).rows[0]!;
}
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
});

test('future arrivals retain a compact minute bitmap without immediately waking an idle chat', async () => {
  await enable();
  const reserved = await wake();
  await pool.query(
    "UPDATE eraser_policies SET history_complete=true,live_due=false,safety_next_at=clock_timestamp()+INTERVAL '2 days',live_floor=$1 WHERE chat_id='-1'",
    [Date.now() - 24 * HOUR + 1],
  );
  const hour = Math.floor(Date.now() / HOUR) * HOUR - HOUR;
  const generation = (await store.policy('-1'))!.scan_generation;
  for (const minute of [0, 31, 32, 59])
    await store.ingest({}, randomUUID(), message(`future-${minute}`, hour + minute * 60_000 + 1));
  const before = (
    await pool.query<{ minutes: string; xmin: string }>(
      'SELECT minutes::text,xmin::text FROM eraser_future_hours',
    )
  ).rows;
  assert.equal(before.length, 1);
  assert.equal(
    before[0]!.minutes,
    Array.from({ length: 60 }, (_, minute) => ([0, 31, 32, 59].includes(minute) ? '1' : '0')).join(
      '',
    ),
  );
  await store.ingest({}, randomUUID(), message('same-minute', hour + 32 * 60_000 + 2));
  assert.deepEqual(
    (await pool.query('SELECT minutes::text,xmin::text FROM eraser_future_hours')).rows,
    before,
  );
  assert.equal((await store.policy('-1'))!.scan_generation, generation);
  await store.finishVisit('-1', reserved.leaseToken);
  const policy = (await store.policy('-1'))!;
  assert.equal(policy.next_run_at.getTime(), hour + 60_000 + 24 * HOUR);
  assert.deepEqual(await store.reserve(1), []);
});

test('a late due arrival wins an empty stale page and finishVisit cannot erase its wakeup', async () => {
  await enable();
  const reserved = await wake();
  const current = (await store.active('-1', reserved.leaseToken))!;
  const lateAt = Date.now() - 30 * HOUR;
  await store.ingest({}, randomUUID(), message('late', lateAt));
  await store.savePage(current, 'live', []);
  await store.finishVisit('-1', reserved.leaseToken, null, 30_000);
  const fresh = (await store.policy('-1'))!;
  assert.ok(Number(fresh.live_floor) <= lateAt);
  assert.ok(fresh.next_run_at.getTime() <= Date.now() + 1500);
  assert.ok(BigInt(fresh.due_generation) > BigInt(current.due_generation));
});

test('lengthening parks a full never-issued future buffer and preserves independent old history and journals', async () => {
  await enable();
  const reserved = await wake();
  const at = Date.now() - 72 * HOUR;
  await pool.query(
    "INSERT INTO eraser_candidates(chat_id,message_id,author_id,is_bot,source_ms,lane) SELECT '-1','future-'||id,'5',false,$1::bigint-id,'history' FROM generate_series(1,200) id",
    [at],
  );
  const stale = (
    await pool.query<Candidate>("SELECT * FROM eraser_candidates WHERE message_id='future-1'")
  ).rows[0]!;
  await addCandidate('unknown', Date.now() - 200 * HOUR);
  await pool.query(
    "UPDATE eraser_candidates SET state='uncertain',dispatch_id=$1,attempt_count=1 WHERE message_id='unknown'",
    [randomUUID()],
  );
  const journal = (
    await pool.query<Candidate>("SELECT * FROM eraser_candidates WHERE message_id='unknown'")
  ).rows[0];
  await update(168);
  assert.equal(await store.bufferSize('-1'), 0);
  assert.equal((await pool.query('SELECT * FROM eraser_future_hours')).rowCount, 1);
  await assert.rejects(
    store.assertAndMarkDispatch(stale, reserved.leaseToken, Date.now(), Date.now()),
    { code: 'ERASER_GUARD_CHANGED' },
  );
  const policy = (await store.active('-1', reserved.leaseToken))!;
  await store.savePage(policy, 'history', [message('older', Date.now() - 200 * HOUR)]);
  assert.deepEqual(
    (await store.nextCandidates('-1')).map((row) => row.message_id),
    ['older'],
  );
  await update(24);
  assert.deepEqual(
    (await pool.query<Candidate>("SELECT * FROM eraser_candidates WHERE message_id='unknown'"))
      .rows[0],
    journal,
  );
});

test('age deferral never replaces a rejected retry or pin deadline across 24 to 168 to 24 hours', async () => {
  await enable();
  const at = Date.now() - 72 * HOUR;
  for (const [id, code, issued] of [
    ['retry', 'rate_limited', true],
    ['pin', 'pinned', false],
  ] as const) {
    await addCandidate(id, at);
    await pool.query(
      "UPDATE eraser_candidates SET next_attempt_at=clock_timestamp()+INTERVAL '8 days',outcome_code=$2,dispatch_id=$3,attempt_count=$4 WHERE message_id=$1",
      [id, code, issued ? randomUUID() : null, issued ? 1 : 0],
    );
  }
  const original = (
    await pool.query<Candidate>('SELECT * FROM eraser_candidates ORDER BY message_id')
  ).rows;
  await update(168);
  for (const row of original) await store.defer(row, 'not_due', HOUR);
  await update(24);
  const after = (await pool.query<Candidate>('SELECT * FROM eraser_candidates ORDER BY message_id'))
    .rows;
  assert.deepEqual(
    after.map((row) => [row.message_id, row.next_attempt_at, row.dispatch_id]),
    original.map((row) => [row.message_id, row.next_attempt_at, row.dispatch_id]),
  );
  assert.deepEqual(await store.nextCandidates('-1'), []);
});

test('future ingestion during a live page preserves its generation and only whole covered minutes clear', async (t) => {
  // FLAG: Keep both old minutes in one hour so ingestion cannot trigger unrelated
  // hourly compaction and invalidate this page before its minute-coverage check.
  const now = Math.floor(Date.now() / HOUR) * HOUR + 30 * 60_000 + 30_000;
  t.mock.method(Date, 'now', () => now);
  await enable();
  const reserved = await wake();
  const cutoff = Date.now() - 24 * HOUR;
  const start = Math.floor(cutoff / 60_000) * 60_000;
  await pool.query(
    "UPDATE eraser_policies SET history_complete=true,live_floor=$1,due_floor=$1,live_due=true WHERE chat_id='-1'",
    [start - 60_000],
  );
  for (const minute of [start - 60_000, start])
    await pool.query(
      "INSERT INTO eraser_future_hours VALUES('-1',$1,set_bit(B'0'::bit(60),$2,1)) ON CONFLICT(chat_id,hour_ms) DO UPDATE SET minutes=eraser_future_hours.minutes | EXCLUDED.minutes",
      [Math.floor(minute / HOUR) * HOUR, Math.floor((minute % HOUR) / 60_000)],
    );
  const policy = (await store.active('-1', reserved.leaseToken))!;
  assert.ok(await store.openScan(policy, 'live'));
  const futureAt = Date.now();
  await store.ingest({}, randomUUID(), message('future-during-page', futureAt));
  const afterIngest = (await store.policy('-1'))!;
  assert.equal(afterIngest.scan_generation, policy.scan_generation);
  assert.equal(afterIngest.due_generation, policy.due_generation);
  await store.savePage(policy, 'live', []);
  const complete = (await store.policy('-1'))!;
  assert.equal(
    complete.last_live_completed_at,
    null,
    'a known-due window does not certify broad safety coverage',
  );
  assert.equal(complete.live_cursor, null);
  const buckets = (
    await pool.query<{ hour_ms: string; minutes: string }>(
      'SELECT hour_ms,minutes::text FROM eraser_future_hours ORDER BY hour_ms',
    )
  ).rows;
  assert.equal(buckets.length, 2, 'partial old minute and unrelated future minute both survive');
  assert.equal(buckets[0]!.minutes[Math.floor((start % HOUR) / 60_000)], '1');
  assert.equal(
    buckets[0]!.minutes.replaceAll('0', '').length,
    1,
    'the wholly scanned older minute is cleared',
  );
  assert.equal(buckets[1]!.minutes[Math.floor((futureAt % HOUR) / 60_000)], '1');
  await store.finishVisit('-1', reserved.leaseToken);
  assert.equal((await store.policy('-1'))!.normal_next_at.getTime(), start + 60_000 + 24 * HOUR);
});

test('20000 completed idle chats have no ordinary reservations and only two safety slots', async () => {
  await pool.query(
    `INSERT INTO eraser_policies(chat_id,enabled,hours,activation_id,history_complete,live_floor,normal_next_at,next_run_at,safety_next_at)
    SELECT (-id)::text,true,24,$1,true,$2,'9999-01-01',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP FROM generate_series(1,20000) id`,
    [randomUUID(), Date.now() - 24 * HOUR],
  );
  await pool.query('ANALYZE eraser_policies');
  assert.deepEqual(await store.reserve(64), []);
  assert.equal((await store.reserve(2, 'safety')).length, 2);
  await assert.rejects(store.reserve(3, 'safety'), /Invalid reservation limit/);
  const explained = (
    await pool.query(`EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) SELECT chat_id FROM eraser_policies
    WHERE enabled AND connection_status NOT IN ('missing','no_access') AND normal_next_at<=CURRENT_TIMESTAMP
      AND (lease_until IS NULL OR lease_until<CURRENT_TIMESTAMP)
    ORDER BY normal_next_at,chat_id LIMIT 64 FOR UPDATE SKIP LOCKED`)
  ).rows[0]['QUERY PLAN'][0].Plan;
  const nodes = (node: Record<string, unknown>): Array<Record<string, unknown>> => [
    node,
    ...((node.Plans ?? []) as Array<Record<string, unknown>>).flatMap(nodes),
  ];
  assert.ok(
    nodes(explained).some((node) => node['Index Name'] === 'eraser_policies_due_ready_idx'),
  );
  assert.ok(nodes(explained).every((node) => node['Node Type'] !== 'Seq Scan'));
});

test('legacy scheduling preserves old-reader pages and forward upgrade conservatively resumes safety', async () => {
  await enable();
  const floor = Date.now() - 30 * HOUR;
  const cursor = Date.now() - 26 * HOUR;
  await pool.query(
    "UPDATE eraser_policies SET history_complete=true,live_due=false,normal_next_at='9999-01-01',safety_next_at=clock_timestamp()+INTERVAL '15 minutes',next_run_at=clock_timestamp()+INTERVAL '15 minutes',live_floor=$1,safety_floor=$1,live_cursor=$2,live_upper=$3,due_floor=$1 WHERE chat_id='-1'",
    [floor, cursor, Date.now() - 24 * HOUR],
  );
  // Stage1 finish writes only its ordinary timestamp; it must retain its unfinished cursor.
  await pool.query(
    "UPDATE eraser_policies SET next_run_at=clock_timestamp()-INTERVAL '1 second' WHERE chat_id='-1'",
  );
  const legacy = (await store.policy('-1'))!;
  assert.equal(legacy.normal_next_at.getTime(), legacy.next_run_at.getTime());
  assert.equal(
    Number(legacy.live_cursor),
    cursor,
    'old worker can continue rather than restarting each visit',
  );
  assert.equal(legacy.due_floor, null);
  assert.equal(legacy.live_due, false, 'unclassified legacy discovery stays in safety budget');
  assert.equal(Number(legacy.safety_floor), floor);
  const [ordinary] = await store.reserve(1);
  assert.ok(ordinary);
  assert.equal(
    await store.openScan((await store.active('-1', ordinary.leaseToken))!, 'live'),
    null,
  );
  await store.finishVisit('-1', ordinary.leaseToken);
  assert.equal((await store.policy('-1'))!.normal_next_at.getUTCFullYear(), 9999);
  const [safety] = await store.reserve(1, 'safety');
  assert.ok(safety);
  const policy = (await store.active('-1', safety.leaseToken))!;
  const window = await store.openScan(policy, 'live', 'safety');
  assert.ok(window);
  assert.equal(window.lower, floor);
  await store.savePage(policy, 'live', [], 'safety');
  await store.finishVisit('-1', safety.leaseToken);
  const forward = (await store.policy('-1'))!;
  assert.equal(forward.normal_next_at.getUTCFullYear(), 9999);
  assert.equal(forward.next_run_at.getTime(), forward.safety_next_at.getTime());
  assert.equal(forward.live_due, false);
  assert.equal(forward.live_cursor, null);
  assert.ok(forward.last_live_completed_at);
  assert.ok(Number(forward.live_floor) > floor);
  assert.ok(Number.isFinite(forward.next_run_at.getTime()));
});

test('effective due indexes bypass a large retained retry population for every product period', async () => {
  await enable();
  await pool.query(
    `INSERT INTO eraser_candidates(chat_id,message_id,author_id,is_bot,source_ms,lane,dispatch_id,attempt_count,next_attempt_at)
    SELECT '-1','retry-'||id,'5',false,$1,'history',gen_random_uuid(),1,clock_timestamp()+INTERVAL '8 days' FROM generate_series(1,10000) id`,
    [Date.now() - 200 * HOUR],
  );
  await addCandidate('eligible', Date.now() - 200 * HOUR);
  await pool.query('ANALYZE eraser_candidates');
  for (const hours of [24, 48, 168] as const) {
    const expression = `GREATEST(source_ms + ${hours * HOUR},CEIL(EXTRACT(EPOCH FROM (next_attempt_at AT TIME ZONE 'UTC')) * 1000)::bigint)`;
    const plan = (
      await pool.query(
        `EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) SELECT * FROM eraser_candidates
      WHERE chat_id='-1' AND state='pending' AND lane='history' AND ${expression}<=$1
      ORDER BY ${expression},source_ms,message_id LIMIT 5`,
        [Date.now()],
      )
    ).rows[0]['QUERY PLAN'][0].Plan;
    const child = plan.Plans[0];
    assert.equal(child['Index Name'], `eraser_candidates_due_${hours}_idx`);
    assert.equal(child['Actual Rows'], 1);
    assert.equal(child['Rows Removed by Filter'] ?? 0, 0);
    assert.deepEqual(
      (await store.nextCandidates('-1', hours)).map((row) => row.message_id),
      ['eligible'],
    );
  }
});

test('an ambiguous full live boundary pauses automatic work but a new due receipt preserves gap and proceeds', async () => {
  await enable();
  const reserved = await wake();
  const at = Date.now() - 26 * HOUR;
  const page = Array.from({ length: 100 }, (_, id) => message(`protected-${id}`, at));
  await pool.query(
    "INSERT INTO eraser_protected_messages(chat_id,message_id,kind) SELECT '-1',id,'protected' FROM unnest($1::text[]) id",
    [page.map((row) => row.id)],
  );
  await pool.query(
    "UPDATE eraser_policies SET history_complete=true,live_floor=$1,due_floor=$1,live_due=true WHERE chat_id='-1'",
    [at - 1],
  );
  for (let visit = 0; visit < 2; visit++) {
    const policy = (await store.active('-1', reserved.leaseToken))!;
    assert.ok(await store.openScan(policy, 'live'));
    await store.savePage(policy, 'live', page);
  }
  const blocked = (await store.policy('-1'))!;
  assert.equal(blocked.live_gap, true);
  assert.equal(Number(blocked.live_gap_at), at);
  assert.equal(blocked.history_gap, false, 'a live gap must not block independent history');
  assert.equal(blocked.last_live_completed_at, null);
  await store.finishVisit('-1', reserved.leaseToken);
  assert.deepEqual(await store.reserve(1), []);
  assert.ok(
    (await store.policy('-1'))!.safety_next_at.getTime() <= Date.now(),
    'ordinary gap does not park independent safety work',
  );
  assert.equal((await store.snapshot('-1')).status, 'delayed');
  await store.ingest({}, randomUUID(), message('new-due', at + 60_000));
  const [next] = await store.reserve(1);
  assert.ok(next);
  const policy = (await store.active('-1', next.leaseToken))!;
  const window = await store.openScan(policy, 'live');
  assert.ok(window);
  assert.equal(window.lower, at - 1, 'the unproven boundary is never skipped');
  await store.savePage(policy, 'live', [message('new-due', at + 60_000), ...page.slice(0, 99)]);
  assert.deepEqual(
    (await store.nextCandidates('-1')).map((row) => row.message_id),
    ['new-due'],
  );
  const fresh = (await store.policy('-1'))!;
  assert.equal(Number(fresh.live_gap_at), at);
  assert.equal(fresh.last_live_completed_at, null);
  assert.equal((await store.snapshot('-1')).status, 'delayed');
});

test('a historical timestamp gap does not prevent an independently known live window', async () => {
  await enable();
  await pool.query("UPDATE eraser_policies SET history_gap=true WHERE chat_id='-1'");
  await store.ingest({}, randomUUID(), message('independent-live', Date.now() - 25 * HOUR));
  const [wakeup] = await store.reserve(1);
  assert.ok(wakeup);
  const policy = (await store.active('-1', wakeup.leaseToken))!;
  assert.equal(await store.openScan(policy, 'history'), null);
  assert.ok(await store.openScan(policy, 'live'));
  await store.savePage(policy, 'live', [message('independent-live', Date.now() - 25 * HOUR)]);
  assert.deepEqual(
    (await store.nextCandidates('-1')).map((row) => row.message_id),
    ['independent-live'],
  );
  assert.equal((await store.policy('-1'))!.history_gap, true);
});

test('policy locking serializes period lengthening against final dispatch in either order', async () => {
  async function awaitLockWait() {
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      const count = (
        await admin.query<{ count: number }>(
          "SELECT COUNT(*)::int AS count FROM pg_stat_activity WHERE application_name=$1 AND pid<>pg_backend_pid() AND wait_event_type='Lock' AND query LIKE '%eraser_policies%' AND query LIKE '%FOR UPDATE%'",
          [schema],
        )
      ).rows[0]!.count;
      if (count > 0) return;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.fail('expected native row-lock wait');
  }
  for (const first of ['period', 'dispatch'] as const) {
    await pool.query('TRUNCATE eraser_policies,eraser_webhook_receipts CASCADE');
    await enable();
    const [wakeup] = await store.reserve(1);
    assert.ok(wakeup);
    const row = await addCandidate(`race-${first}`, Date.now() - 72 * HOUR);
    const blocker = await pool.connect();
    await blocker.query('BEGIN');
    await blocker.query("SELECT chat_id FROM eraser_policies WHERE chat_id='-1' FOR UPDATE");
    const operation =
      first === 'period'
        ? update(168)
        : store.assertAndMarkDispatch(row, wakeup.leaseToken, Date.now(), Date.now());
    const observed = operation.then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
    await awaitLockWait();
    const later =
      first === 'period'
        ? store.assertAndMarkDispatch(row, wakeup.leaseToken, Date.now(), Date.now())
        : update(168);
    const laterObserved = later.then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
    await blocker.query('COMMIT');
    blocker.release();
    const [a, b] = await Promise.all([observed, laterObserved]);
    assert.ok(!('error' in a));
    if (first === 'period') {
      assert.ok('error' in b && b.error.code === 'ERASER_GUARD_CHANGED');
      assert.equal(await store.bufferSize('-1'), 0);
    } else {
      assert.ok(!('error' in b));
      const issued = (
        await pool.query<Candidate>('SELECT * FROM eraser_candidates WHERE message_id=$1', [
          row.message_id,
        ])
      ).rows[0]!;
      assert.equal(issued.state, 'dispatching');
      assert.equal(issued.attempt_count, 1);
      assert.equal(issued.dispatch_id, 'value' in a ? a.value : null);
    }
  }
});

test('a late known rejection schedules its retained retry after the original visit parked', async () => {
  await enable();
  const [wakeup] = await store.reserve(1);
  assert.ok(wakeup);
  const row = await addCandidate('late-rejection', Date.now() - 200 * HOUR);
  const dispatch = await store.assertAndMarkDispatch(
    row,
    wakeup.leaseToken,
    Date.now(),
    Date.now(),
  );
  const issued = { ...row, state: 'dispatching' as const, dispatch_id: dispatch };
  await pool.query(
    "UPDATE eraser_policies SET history_complete=true,live_due=false,safety_next_at=clock_timestamp()+INTERVAL '1 hour' WHERE chat_id='-1'",
  );
  await store.finishVisit('-1', wakeup.leaseToken);
  assert.equal((await store.policy('-1'))!.normal_next_at.getUTCFullYear(), 9999);
  await store.settle(issued, 'pending', 'rate_limited', 60_000);
  const policy = (await store.policy('-1'))!;
  const retry = (
    await pool.query<Candidate>("SELECT * FROM eraser_candidates WHERE message_id='late-rejection'")
  ).rows[0]!;
  assert.equal(policy.normal_next_at.getTime(), retry.next_attempt_at.getTime());
  assert.ok(policy.normal_next_at.getTime() < Date.now() + 61_000);
  assert.deepEqual(await store.nextCandidates('-1'), []);
});

test('newly due minute reopens a blocked live window without advancing the retained floor', async () => {
  await enable();
  const at = Date.now() - 27 * HOUR;
  const minute = Math.floor((Date.now() - 24 * HOUR) / 60_000) * 60_000 - 60_000;
  await pool.query(
    "UPDATE eraser_policies SET history_complete=true,live_gap=true,live_gap_at=$1,live_floor=$1,due_floor=$1,live_upper=$2,live_cursor=$1,live_due=false,normal_next_at=clock_timestamp(),safety_next_at='9999-01-01',next_run_at=clock_timestamp() WHERE chat_id='-1'",
    [at, minute - 60_000],
  );
  await pool.query("INSERT INTO eraser_future_hours VALUES('-1',$1,set_bit(B'0'::bit(60),$2,1))", [
    Math.floor(minute / HOUR) * HOUR,
    Math.floor((minute % HOUR) / 60_000),
  ]);
  const [wakeup] = await store.reserve(1);
  assert.ok(wakeup);
  const policy = (await store.active('-1', wakeup.leaseToken))!;
  const window = await store.openScan(policy, 'live');
  assert.ok(window);
  assert.equal(window.lower, at);
  const fresh = (await store.policy('-1'))!;
  assert.equal(fresh.live_gap, false);
  assert.equal(Number(fresh.live_gap_at), at);
  assert.equal(fresh.last_live_completed_at, null);
});

test('bounded expired bitmap compaction preserves work and cannot repeatedly reopen a known gap', async () => {
  await enable();
  const hour = Math.floor((Date.now() - 30 * HOUR) / HOUR) * HOUR;
  const upper = Date.now() - 24 * HOUR;
  await pool.query(
    "UPDATE eraser_policies SET history_complete=true,live_gap=true,live_gap_at=$1,live_floor=$1,due_floor=$1,live_upper=$2,live_cursor=$1,live_due=false,normal_next_at='9999-01-01',safety_next_at='9999-01-01',next_run_at='9999-01-01' WHERE chat_id='-1'",
    [hour, upper],
  );
  await pool.query(
    "INSERT INTO eraser_future_hours SELECT '-1',$1::bigint-id*3600000::bigint,set_bit(B'0'::bit(60),32,1) FROM generate_series(0,33) id",
    [hour],
  );
  await store.ingest({}, randomUUID(), message('current', Date.now()));
  const policy = (await store.policy('-1'))!;
  assert.equal(Number(policy.live_floor), hour - 33 * HOUR + 32 * 60_000);
  assert.equal(policy.live_due, true);
  assert.equal(policy.live_gap, true);
  assert.equal(Number(policy.live_upper), upper);
  assert.equal(Number(policy.live_cursor), hour);
  assert.equal(
    (await pool.query('SELECT * FROM eraser_future_hours')).rowCount,
    3,
    '32 expired hours compact into a due floor; two old and one future hour remain',
  );
  assert.deepEqual(await store.reserve(1), []);
  assert.equal((await store.snapshot('-1')).status, 'delayed');
});

test('a period change cannot hide an older ambiguous live boundary behind a newer completed window', async () => {
  await enable();
  const gap = Date.now() - 30 * HOUR;
  await pool.query(
    "UPDATE eraser_policies SET live_gap=true,live_gap_at=$1,live_floor=$1,due_floor=$1,live_upper=$2,live_cursor=$1 WHERE chat_id='-1'",
    [gap, Date.now() - 24 * HOUR],
  );
  await update(48);
  const [wakeup] = await store.reserve(1);
  assert.ok(wakeup);
  await pool.query(
    "UPDATE eraser_policies SET live_floor=$1,due_floor=$1,live_due=true WHERE chat_id='-1'",
    [Date.now() - 49 * HOUR],
  );
  const policy = (await store.active('-1', wakeup.leaseToken))!;
  assert.ok(await store.openScan(policy, 'live'));
  await store.savePage(policy, 'live', []);
  assert.equal(
    Number((await store.policy('-1'))!.live_gap_at),
    gap,
    'a completed older age window did not prove the still-young gap',
  );
  await update(24);
  assert.equal(
    Number((await store.policy('-1'))!.live_floor),
    gap,
    'shortening retains the unproven source boundary for the next window',
  );
  assert.equal((await store.snapshot('-1')).status, 'delayed');
});

test('expired bitmap compaction immediately wakes a parked ordinary window', async () => {
  await enable();
  const hour = Math.floor((Date.now() - 26 * HOUR) / HOUR) * HOUR;
  await pool.query(
    "UPDATE eraser_policies SET history_complete=true,live_due=false,normal_next_at='9999-01-01',safety_next_at=clock_timestamp()+INTERVAL '6 hours',next_run_at=clock_timestamp()+INTERVAL '6 hours' WHERE chat_id='-1'",
  );
  await pool.query("INSERT INTO eraser_future_hours VALUES('-1',$1,set_bit(B'0'::bit(60),32,1))", [
    hour,
  ]);
  await store.ingest({}, randomUUID(), message('future-after-expiry', Date.now()));
  const [wakeup] = await store.reserve(1);
  assert.ok(wakeup, 'expired durable work must not wait for safety or the fresh future arrival');
  const policy = (await store.active('-1', wakeup.leaseToken))!;
  const window = await store.openScan(policy, 'live');
  assert.ok(window);
  assert.ok(window.lower! <= hour + 32 * 60_000);
});

test('expired compaction preserves new work above a blocked upper even after removing its bitmap', async () => {
  await enable();
  const hour = Math.floor((Date.now() - 26 * HOUR) / HOUR) * HOUR;
  const blocked = hour - 60_000;
  const floor = hour - 2 * HOUR;
  await pool.query(
    "UPDATE eraser_policies SET history_complete=true,live_due=false,live_gap=true,live_gap_at=$1,live_floor=$1,due_floor=$1,live_upper=$2,live_cursor=$1,normal_next_at='9999-01-01',safety_next_at='9999-01-01',next_run_at='9999-01-01' WHERE chat_id='-1'",
    [floor, blocked],
  );
  await pool.query("INSERT INTO eraser_future_hours VALUES('-1',$1,set_bit(B'0'::bit(60),32,1))", [
    hour,
  ]);
  await store.ingest({}, randomUUID(), message('future-after-gap', Date.now()));
  assert.equal(
    (await pool.query('SELECT * FROM eraser_future_hours WHERE hour_ms=$1', [hour])).rowCount,
    0,
  );
  const [wakeup] = await store.reserve(1);
  assert.ok(wakeup, 'newly expired work must remain runnable after bucket compaction');
  const policy = (await store.active('-1', wakeup.leaseToken))!;
  assert.equal(policy.live_gap, false);
  assert.equal(Number(policy.live_gap_at), floor, 'the unresolved boundary remains visible');
  const window = await store.openScan(policy, 'live');
  assert.ok(window);
  assert.equal(window.lower, floor);
});

test('an authenticated removal receipt wakes known work when it frees the page buffer', async () => {
  await enable();
  const [wakeup] = await store.reserve(1);
  assert.ok(wakeup);
  const source = Date.now() - 30 * HOUR;
  await pool.query(
    "INSERT INTO eraser_candidates(chat_id,message_id,author_id,is_bot,source_ms,lane,next_attempt_at) SELECT '-1','retry-'||id,'5',false,$1,'history',clock_timestamp()+INTERVAL '8 days' FROM generate_series(1,101) id",
    [source],
  );
  await pool.query(
    "UPDATE eraser_policies SET history_complete=true,live_due=false,safety_next_at=clock_timestamp()+INTERVAL '6 hours' WHERE chat_id='-1'",
  );
  await pool.query("INSERT INTO eraser_future_hours VALUES('-1',$1,set_bit(B'0'::bit(60),32,1))", [
    Math.floor(source / HOUR) * HOUR,
  ]);
  await store.finishVisit('-1', wakeup.leaseToken);
  assert.ok((await store.policy('-1'))!.normal_next_at.getTime() > Date.now() + HOUR);
  await store.ingest(
    { update_type: 'message_removed', chat_id: '-1', message_id: 'retry-1' },
    randomUUID(),
  );
  assert.equal(await store.bufferSize('-1'), 100);
  assert.ok(
    (await store.policy('-1'))!.normal_next_at.getTime() <= Date.now() + 1500,
    'freed capacity must wake the retained due bitmap',
  );
});

for (const placement of ['inside', 'outside'] as const)
  test(`a late due receipt ${placement} a partial safety window preserves the correct coverage proof`, async () => {
    await enable();
    const floor = Date.now() - 30 * HOUR;
    const upper = Date.now() - 26 * HOUR;
    const cursor = Date.now() - 27 * HOUR;
    await pool.query(
      "UPDATE eraser_policies SET history_complete=true,safety_floor=$1,live_floor=$1,safety_upper=$2,safety_cursor=$3,normal_next_at='9999-01-01',next_run_at=clock_timestamp(),safety_next_at=clock_timestamp() WHERE chat_id='-1'",
      [floor, upper, cursor],
    );
    const [wakeup] = await store.reserve(1, 'safety');
    assert.ok(wakeup);
    const before = (await store.active('-1', wakeup.leaseToken))!;
    const source = Date.now() - (placement === 'inside' ? 28 : 25) * HOUR;
    await store.ingest({}, randomUUID(), message(`late-${placement}`, source));
    const ingested = (await store.policy('-1'))!;
    assert.equal(Number(ingested.due_floor), source);
    if (placement === 'inside') {
      assert.ok(BigInt(ingested.scan_generation) > BigInt(before.scan_generation));
      assert.equal(Number(ingested.safety_cursor), upper);
    } else {
      assert.equal(ingested.scan_generation, before.scan_generation);
      assert.equal(Number(ingested.safety_cursor), cursor);
    }
    await store.savePage(before, 'live', [], 'safety');
    const after = (await store.policy('-1'))!;
    assert.equal(
      Number(after.due_floor),
      source,
      'safety never erases an independent known-due hint',
    );
    if (placement === 'inside') {
      assert.equal(after.last_live_completed_at, null);
      assert.equal(Number(after.safety_floor), floor);
    } else {
      assert.ok(after.last_live_completed_at);
      assert.equal(Number(after.safety_floor), upper + 1);
    }
  });

test('a repeated safety boundary waits six hours without borrowing the ordinary schedule', async () => {
  await enable();
  const at = Date.now() - 30 * HOUR;
  const page = Array.from({ length: 100 }, (_, id) => message(`safe-gap-${id}`, at));
  await pool.query(
    "INSERT INTO eraser_protected_messages(chat_id,message_id,kind) SELECT '-1',id,'protected' FROM unnest($1::text[]) id",
    [page.map((row) => row.id)],
  );
  await pool.query(
    "UPDATE eraser_policies SET history_complete=true,live_floor=$1,safety_floor=$1,normal_next_at='9999-01-01',next_run_at=clock_timestamp(),safety_next_at=clock_timestamp() WHERE chat_id='-1'",
    [at - 1],
  );
  const [wakeup] = await store.reserve(1, 'safety');
  assert.ok(wakeup);
  for (let pageNumber = 0; pageNumber < 2; pageNumber++) {
    const policy = (await store.active('-1', wakeup.leaseToken))!;
    assert.ok(await store.openScan(policy, 'live', 'safety'));
    await store.savePage(policy, 'live', page, 'safety');
  }
  await store.finishVisit('-1', wakeup.leaseToken);
  const blocked = (await store.policy('-1'))!;
  assert.equal(blocked.safety_gap, true);
  assert.equal(Number(blocked.safety_gap_at), at);
  assert.equal(blocked.normal_next_at.getUTCFullYear(), 9999);
  assert.ok(blocked.safety_next_at.getTime() > Date.now() + 5 * HOUR);
  assert.equal(blocked.last_live_completed_at, null);
  assert.equal((await store.snapshot('-1')).status, 'delayed');
  assert.deepEqual(await store.reserve(1), []);
  assert.deepEqual(await store.reserve(1, 'safety'), []);
});

test('a completed safety window cannot clear a retained gap outside its current age cutoff', async () => {
  await enable();
  const gap = Date.now() - 30 * HOUR;
  await pool.query(
    "UPDATE eraser_policies SET safety_gap=true,safety_gap_at=$1,safety_floor=$1,live_floor=$1 WHERE chat_id='-1'",
    [gap],
  );
  await update(48);
  await pool.query("UPDATE eraser_policies SET safety_floor=$1,live_floor=$1 WHERE chat_id='-1'", [
    Date.now() - 49 * HOUR,
  ]);
  const [wakeup] = await store.reserve(1, 'safety');
  assert.ok(wakeup);
  const policy = (await store.active('-1', wakeup.leaseToken))!;
  assert.ok(await store.openScan(policy, 'live', 'safety'));
  await store.savePage(policy, 'live', [], 'safety');
  const fresh = (await store.policy('-1'))!;
  assert.equal(
    Number(fresh.safety_gap_at),
    gap,
    'the still-young timestamp was outside the completed window',
  );
  assert.equal((await store.snapshot('-1')).status, 'delayed');
});

test('connection activation keeps the legacy reader floor below retained gaps', async () => {
  await enable();
  const policy = (await store.policy('-1'))!;
  await updatePolicy(store, '-1', {
    enabled: true,
    hours: 24,
    expectedRevision: policy.revision,
    actorUserId: '5',
    operationId: randomUUID(),
    connectWhenReady: true,
  });
  const gap = Date.now() - 30 * HOUR;
  await pool.query(
    "UPDATE eraser_policies SET safety_gap_at=$1,live_gap_at=$1,safety_floor=$1,live_floor=$1 WHERE chat_id='-1'",
    [gap],
  );
  const [connection] = await store.reserveConnections(1);
  assert.ok(connection);
  assert.equal(
    await store.activateConnection('-1', connection.leaseToken, await connectionProof(store, '-1')),
    true,
  );
  const active = (await store.policy('-1'))!;
  assert.equal(
    Number(active.live_floor),
    gap,
    'a Stage1 rollback must see the entire retained range',
  );
  assert.equal(Number(active.safety_floor), gap);
});

test('a complete safety proof clears a covered ordinary gap while retaining its known work', async () => {
  await enable();
  const at = Date.now() - 30 * HOUR;
  await pool.query(
    "UPDATE eraser_policies SET history_complete=true,live_floor=$1,due_floor=$1,live_upper=$2,live_cursor=$2,live_due=true,live_gap=true,live_gap_at=$2,safety_floor=$1,normal_next_at='9999-01-01',next_run_at=clock_timestamp(),safety_next_at=clock_timestamp() WHERE chat_id='-1'",
    [at - 1, at],
  );
  const [wakeup] = await store.reserve(1, 'safety');
  assert.ok(wakeup);
  const policy = (await store.active('-1', wakeup.leaseToken))!;
  assert.ok(await store.openScan(policy, 'live', 'safety'));
  await store.savePage(policy, 'live', [], 'safety');
  const proved = (await store.policy('-1'))!;
  assert.equal(
    proved.live_gap_at,
    null,
    'a complete covering read resolves the previous ambiguous timestamp',
  );
  assert.equal(proved.live_gap, false);
  assert.equal(Number(proved.due_floor), at - 1, 'safety preserves independently tracked due work');
  assert.ok(proved.last_live_completed_at);
  await store.finishVisit('-1', wakeup.leaseToken);
  assert.ok((await store.policy('-1'))!.normal_next_at.getTime() <= Date.now() + 1500);
});
