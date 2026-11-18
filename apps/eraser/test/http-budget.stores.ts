import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Redis } from 'ioredis';
import type { Config } from '../src/config.js';
import { HttpAdmissionDeferred, HttpLimiter } from '../src/limiter.js';
import { MaxClient } from '../src/max.js';

const redisUrl = process.env.MAXIM_TEST_REDIS_URL;
if (!redisUrl) throw new Error('Use the public with-test-stores wrapper');
const settings: Config = {
  databaseUrl: 'postgresql://unused/test',
  redisUrl,
  controlToken: 'a'.repeat(32),
  webhookSecret: 'b'.repeat(32),
  botToken: 'test',
  botId: '1',
  apiBaseUrl: 'https://platform-api2.max.ru',
  port: 3000,
  enabled: true,
  maxRps: 20,
  commitSha: 'test',
  webhookUrl: null,
};

async function fixture(run: (redis: Redis, prefix: string) => Promise<void>) {
  const redis = new Redis(redisUrl!, { maxRetriesPerRequest: 1 });
  const prefix = `eraser:budget:${randomUUID()}`;
  try {
    await redis.ping();
    await run(redis, prefix);
  } finally {
    const keys = await redis.keys(`${prefix}:*`);
    if (keys.length) await redis.del(...keys);
    await redis.quit();
  }
}

test('safety rights and pages share one request per second across clients without throttling useful pin reads to that rate', async () => {
  await fixture(async (redis, prefix) => {
    const calls: Array<{ path: string; at: number }> = [];
    const http: typeof fetch = async (input) => {
      const path = new URL(String(input)).pathname;
      calls.push({ path, at: Date.now() });
      if (path.endsWith('/members/me')) return Response.json({ user_id: '1', is_owner: true });
      if (path === '/messages') return Response.json({ messages: [] });
      if (path.endsWith('/pin')) return Response.json({});
      assert.fail('Unexpected MAX request');
    };
    const one = new MaxClient(settings, new HttpLimiter(redis, 20, prefix), http);
    const two = new MaxClient(settings, new HttpLimiter(redis, 20, prefix), http);
    await one.rights('-1', undefined, 'safety');
    await Promise.all([two.page('-2', 1000, 0, 'safety'), one.pin('-1')]);
    const rights = calls.find((call) => call.path.endsWith('/members/me'))!;
    const page = calls.find((call) => call.path === '/messages')!;
    assert.ok(page.at - rights.at >= 950, `Safety spacing was ${page.at - rights.at}ms`);
    assert.ok(calls.findIndex((call) => call.path.endsWith('/pin')) < calls.indexOf(page));
    for (let index = 1; index < calls.length; index++)
      assert.ok(calls[index]!.at - calls[index - 1]!.at >= 40, 'Total HTTP cadence is retained');
  });
});

test('a legacy Redis-only long cooldown defers admission instead of occupying a worker', async () => {
  await fixture(async (redis, prefix) => {
    const limiter = new HttpLimiter(redis, 20, prefix);
    await limiter.cooldownUntil(Date.now() + 60_000);
    await assert.rejects(
      limiter.acquire(undefined, AbortSignal.timeout(200)),
      (error) => error instanceof HttpAdmissionDeferred && error.retryAfterMs > 59_000,
    );
    assert.equal(await redis.get(`${prefix}:next`), null);
  });
});
