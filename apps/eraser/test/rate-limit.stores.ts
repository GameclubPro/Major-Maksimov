import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import pg from 'pg';
import { Redis } from 'ioredis';
import type { Config } from '../src/config.js';
import { migrate } from '../src/migrate.js';
import { DurableRateLimit } from '../src/rate-limit.js';
import { ADMIT_HTTP_LUA, HttpAdmissionDeferred, HttpLimiter } from '../src/limiter.js';
import { MaxClient, MaxError } from '../src/max.js';
import { CleanupRuntime } from '../src/runtime.js';
import { Store } from '../src/store.js';
import { updatePolicy } from './support/policy-proof.js';

const databaseUrl = process.env.MAXIM_TEST_POSTGRES_URL;
const redisUrl = process.env.MAXIM_TEST_REDIS_URL;
if (!databaseUrl || !redisUrl) throw new Error('Use the public with-test-stores wrapper');
const schema = `eraser_limit_${randomUUID().replaceAll('-', '')}`;
const admin = new pg.Pool({ connectionString: databaseUrl, max: 1 });
const pool = new pg.Pool({
  connectionString: databaseUrl,
  max: 4,
  options: `-c search_path=${schema} -c timezone=UTC`,
});
const settings: Config = {
  databaseUrl,
  redisUrl,
  controlToken: 'a'.repeat(32),
  webhookSecret: 'b'.repeat(32),
  botToken: 'test',
  botId: '123',
  apiBaseUrl: 'https://platform-api2.max.ru',
  port: 3000,
  enabled: true,
  maxRps: 20,
  commitSha: 'test',
  webhookUrl: null,
};
before(async () => {
  await admin.query(`CREATE SCHEMA ${schema}`);
  await migrate(pool);
});
after(async () => {
  await pool.end();
  await admin.query(`DROP SCHEMA ${schema} CASCADE`);
  await admin.end();
});

test('received DELETE 429 survives Redis disconnect and a new client cannot dispatch before its durable deadline', async () => {
  const redis = new Redis(redisUrl!, { maxRetriesPerRequest: 1 });
  const restartedRedis = new Redis(redisUrl!, { maxRetriesPerRequest: 1 });
  redis.on('error', () => {});
  restartedRedis.on('error', () => {});
  const prefix = `eraser:limit:${randomUUID()}`;
  const store = new Store(pool, true);
  const durable = new DurableRateLimit(pool, settings.botId);
  let deletes = 0;
  try {
    await Promise.all([redis.ping(), restartedRedis.ping()]);
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
      `INSERT INTO eraser_candidates(chat_id,message_id,author_id,is_bot,source_ms,lane)
      VALUES('-1','message','5',false,$1,'live')`,
      [Date.now() - 8 * 86_400_000],
    );
    const [wakeup] = await store.reserve(1);
    assert.ok(wakeup);
    const max = new MaxClient(
      settings,
      new HttpLimiter(redis, 20, prefix, durable),
      async (url, init) => {
        if (init?.method === 'DELETE') {
          deletes++;
          redis.disconnect();
          return Response.json(
            { code: 'rate.limit' },
            { status: 429, headers: { 'Retry-After': '2' } },
          );
        }
        if (String(url).endsWith('/members/me'))
          return Response.json({
            user_id: 123,
            is_admin: true,
            permissions: ['read_all_messages', 'write'],
          });
        if (String(url).endsWith('/pin')) return Response.json({ message: null });
        assert.fail('Unexpected MAX request');
      },
    );
    const runtime = new CleanupRuntime(store, max, settings);
    await runtime.visit(wakeup);
    const row = (
      await pool.query(
        'SELECT state,outcome_code,attempt_count,next_attempt_at FROM eraser_candidates',
      )
    ).rows[0];
    assert.equal(deletes, 1);
    assert.equal(row.state, 'pending');
    assert.equal(row.outcome_code, 'rate_limited');
    assert.equal(row.attempt_count, 1);
    assert.ok(row.next_attempt_at.getTime() > Date.now());
    assert.ok((await durable.remainingMs()) > 1000);
    assert.equal(await restartedRedis.get(`${prefix}:cooldown`), null);
    let dispatches = 0;
    const restarted = new MaxClient(
      settings,
      new HttpLimiter(restartedRedis, 20, prefix, new DurableRateLimit(pool, settings.botId)),
      async () => {
        dispatches++;
        return Response.json({ success: true });
      },
    );
    await assert.rejects(
      restarted.remove('-1', 'message', async () => {
        dispatches++;
      }),
      (error) => error instanceof MaxError && error.status === 429 && !error.attempted,
    );
    assert.equal(dispatches, 0);
    await delay((await durable.remainingMs()) + 30);
    await restarted.remove('-1', 'message', async () => {
      dispatches++;
    });
    assert.equal(dispatches, 2);
  } finally {
    redis.disconnect();
    const keys = await restartedRedis.keys(`${prefix}:*`);
    if (keys.length) await restartedRedis.del(...keys);
    await restartedRedis.quit();
  }
});

test('parallel cooldown writers never shorten the durable token deadline and other tokens remain independent', async () => {
  const one = new DurableRateLimit(pool, '456');
  const two = new DurableRateLimit(pool, '456');
  await Promise.all([one.extend(30_000), two.extend(1000)]);
  assert.ok((await one.remainingMs()) > 29_000);
  await two.extend(1000);
  assert.ok((await one.remainingMs()) > 29_000);
  assert.equal(await new DurableRateLimit(pool, '789').remainingMs(), 0);
});

test('missing durable storage closes admission before any Redis reservation or dispatch', async () => {
  const unavailable = new pg.Pool({
    connectionString: databaseUrl,
    max: 1,
    options: '-c search_path=pg_catalog',
  });
  const redis = new Redis(redisUrl!, { maxRetriesPerRequest: 1 });
  const prefix = `eraser:limit:${randomUUID()}`;
  try {
    await redis.ping();
    const limiter = new HttpLimiter(redis, 20, prefix, new DurableRateLimit(unavailable, '123'));
    await assert.rejects(
      limiter.acquire(),
      (error: unknown) => !(error instanceof HttpAdmissionDeferred),
    );
    assert.equal(await redis.get(`${prefix}:next`), null);
  } finally {
    await redis.quit();
    await unavailable.end();
  }
});

test('a cooldown committed during a delayed Redis admission reply wins the final admission check', async () => {
  const redis = new Redis(redisUrl!, { maxRetriesPerRequest: 1 });
  const prefix = `eraser:limit:${randomUUID()}`;
  const durable = new DurableRateLimit(pool, '222');
  const deferred = () => {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => {
      resolve = done;
    });
    return { promise, resolve };
  };
  const committed = deferred();
  const reply = deferred();
  try {
    await redis.ping();
    const limiter = new HttpLimiter(
      {
        eval: async () => {
          const result = await redis.eval(
            ADMIT_HTTP_LUA,
            3,
            `${prefix}:cooldown`,
            `${prefix}:next`,
            '',
            50,
          );
          assert.equal(result, 0);
          committed.resolve();
          await reply.promise;
          return result;
        },
      },
      20,
      prefix,
      durable,
    );
    const admission = limiter.acquire();
    const rejected = assert.rejects(admission, HttpAdmissionDeferred);
    await committed.promise;
    await durable.extend(30_000);
    assert.equal(await redis.get(`${prefix}:cooldown`), null);
    reply.resolve();
    await rejected;
  } finally {
    reply.resolve();
    const keys = await redis.keys(`${prefix}:*`);
    if (keys.length) await redis.del(...keys);
    await redis.quit();
  }
});
