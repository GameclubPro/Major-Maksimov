import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import pg from 'pg';
import type { Config } from '../src/config.js';
import { createHttpServer } from '../src/http.js';
import { migrate } from '../src/migrate.js';
import type { MaxTransport } from '../src/max.js';
import { Store } from '../src/store.js';
import { updatePolicy } from './support/policy-proof.js';
import type { Candidate } from '../src/types.js';

const databaseUrl = process.env.MAXIM_TEST_POSTGRES_URL;
const redisUrl = process.env.MAXIM_TEST_REDIS_URL;
if (!databaseUrl || !redisUrl) throw new Error('Use the public with-test-stores wrapper');
const schema = `eraser_retry_${randomUUID().replaceAll('-', '')}`;
const admin = new pg.Pool({ connectionString: databaseUrl, max: 1 });
const pool = new pg.Pool({
  connectionString: databaseUrl,
  max: 4,
  application_name: schema,
  options: `-c search_path=${schema} -c timezone=UTC`,
});
const store = new Store(pool, true);
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
  commitSha: 'native-retry',
  webhookUrl: null,
};
const noMax: MaxTransport = {
  rights: async () => assert.fail('Review cannot probe MAX'),
  actorRights: async () => assert.fail('Review cannot probe MAX'),
  pin: async () => assert.fail('Review cannot probe MAX'),
  page: async () => assert.fail('Review cannot probe MAX'),
  presence: async () => assert.fail('Review cannot inspect unknown effects'),
  remove: async () => assert.fail('Review cannot dispatch DELETE'),
};
const server = createHttpServer(
  store,
  noMax,
  {
    health: () => ({ schedulerHealthy: true, schedulerLastSuccessfulAt: null }),
  },
  settings,
  async () => 'PONG',
);
let base: string;
const headers = {
  Authorization: `Bearer ${settings.controlToken}`,
  'Content-Type': 'application/json',
};
type Review = {
  revision: number;
  activationId: string;
  items: Array<{
    messageId: string;
    intentId: string;
    intentUpdatedAt: string;
    intentAttemptCount: number;
    retryAllowed: boolean;
  }>;
};
function input(review: Review) {
  const item = review.items[0]!;
  return {
    messageId: item.messageId,
    intentId: item.intentId,
    expectedRevision: review.revision,
    activationId: review.activationId,
    expectedIntentUpdatedAt: item.intentUpdatedAt,
    expectedAttemptCount: item.intentAttemptCount,
  };
}
async function read() {
  const response = await fetch(`${base}/internal/v1/chats/-1/review`, { headers });
  assert.equal(response.status, 200);
  return (await response.json()) as Review;
}
async function retry(value: ReturnType<typeof input>) {
  return fetch(`${base}/internal/v1/chats/-1/retry`, {
    method: 'POST',
    headers,
    body: JSON.stringify(value),
  });
}
async function candidate() {
  return (
    await pool.query<Candidate>(
      "SELECT * FROM eraser_candidates WHERE chat_id='-1' AND message_id='message'",
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
  await pool.query('TRUNCATE eraser_policies CASCADE');
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
    operationId: randomUUID(),
    actorUserId: '5',
  });
  await pool.query(
    "INSERT INTO eraser_candidates(chat_id,message_id,author_id,is_bot,source_ms,lane,state,updated_at) VALUES('-1','message','5',false,$1,'history','review','2026-10-28T00:00:00.123000Z')",
    [Date.now() - 8 * 86_400_000],
  );
  await pool.query(
    "UPDATE eraser_policies SET history_complete=true,live_due=false,normal_next_at='9999-01-01',safety_next_at=clock_timestamp()+INTERVAL '6 hours',next_run_at=clock_timestamp()+INTERVAL '6 hours' WHERE chat_id='-1'",
  );
});

for (const gap of [false, true]) {
  test(`a safe operator retry wakes an idle ${gap ? 'boundary-blocked' : 'six-hour safety'} policy`, async () => {
    if (gap)
      await pool.query(
        "UPDATE eraser_policies SET live_gap=true,live_gap_at=1000,safety_next_at='9999-01-01',next_run_at='9999-01-01' WHERE chat_id='-1'",
      );
    const request = input(await read());
    assert.equal((await retry(request)).status, 200);
    const policy = (await store.policy('-1'))!;
    assert.ok(
      policy.normal_next_at.getTime() <= Date.now() + 1500,
      'a due retry must wake ordinary scheduling',
    );
    assert.equal(policy.next_run_at.getTime(), policy.normal_next_at.getTime());
    const row = await candidate();
    assert.equal(row.state, 'pending');
    assert.equal(row.dispatch_id, null);
    assert.equal(row.attempt_count, 0);
    await delay(Math.max(0, policy.normal_next_at.getTime() - Date.now() + 10));
    assert.equal((await store.reserve(1))[0]?.chatId, '-1');
    assert.equal((await retry(request)).status, 409, 'the same review version cannot reopen again');
  });
}

test('review round-trips the exact PostgreSQL microsecond version into a safe retry', async () => {
  await pool.query(
    "UPDATE eraser_candidates SET updated_at='2026-10-28T00:00:00.123456Z' WHERE chat_id='-1'",
  );
  const request = input(await read());
  assert.equal(request.expectedIntentUpdatedAt, '2026-10-28T00:00:00.123456Z');
  assert.equal((await retry(request)).status, 200);
});

test('a one-microsecond version change refuses a stale operator retry without changing its schedule', async () => {
  await pool.query(
    "UPDATE eraser_candidates SET updated_at='2026-10-28T00:00:00.123456Z' WHERE chat_id='-1'",
  );
  const request = input(await read());
  await pool.query(
    "UPDATE eraser_candidates SET updated_at=updated_at+INTERVAL '1 microsecond' WHERE chat_id='-1'",
  );
  const before = await candidate();
  const policy = await store.policy('-1');
  const response = await retry(request);
  assert.equal(response.status, 409);
  assert.equal(((await response.json()) as { code: string }).code, 'ERASER_RETRY_UNSAFE');
  assert.deepEqual(await candidate(), before);
  assert.deepEqual(await store.policy('-1'), policy);
});

for (const [state, attempts, dispatched] of [
  ['uncertain', 1, true],
  ['dispatching', 1, true],
  ['review', 1, true],
  ['review', 0, true],
] as const) {
  test(`operator retry preserves ${state} with ${attempts} attempts and its issued identity`, async () => {
    await pool.query(
      "UPDATE eraser_candidates SET state=$1,attempt_count=$2,dispatch_id=$3 WHERE chat_id='-1'",
      [state, attempts, dispatched ? randomUUID() : null],
    );
    const view = await read();
    assert.equal(view.items[0]!.retryAllowed, false);
    const before = await candidate();
    const policy = await store.policy('-1');
    assert.equal((await retry(input(view))).status, 409);
    assert.deepEqual(await candidate(), before);
    assert.deepEqual(await store.policy('-1'), policy);
  });
}

test('operator retry checks the policy version after acquiring its real policy lock', async () => {
  const request = input(await read());
  const before = await candidate();
  const blocker = await pool.connect();
  let response: Promise<Response> | undefined;
  let settled = false;
  try {
    await blocker.query('BEGIN');
    await blocker.query("SELECT chat_id FROM eraser_policies WHERE chat_id='-1' FOR UPDATE");
    response = retry(request).then((value) => {
      settled = true;
      return value;
    });
    const deadline = Date.now() + 3000;
    for (;;) {
      const waiting = (
        await pool.query<{ waiting: boolean }>(
          "SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name=$1 AND wait_event_type='Lock') AS waiting",
          [schema],
        )
      ).rows[0]!.waiting;
      if (waiting) break;
      assert.equal(settled, false, 'retry must acquire the policy before mutating its candidate');
      assert.ok(Date.now() < deadline, 'retry must reach the policy lock');
      await delay(10);
    }
    await blocker.query("UPDATE eraser_policies SET revision=revision+1 WHERE chat_id='-1'");
    await blocker.query('COMMIT');
    const result = await response;
    assert.equal(result.status, 409);
    assert.equal(((await result.json()) as { code: string }).code, 'ERASER_RETRY_CONFLICT');
    assert.deepEqual(await candidate(), before);
  } finally {
    await blocker.query('ROLLBACK');
    blocker.release();
    await response;
  }
});
