import Redis from 'ioredis';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { readMaxApiBaseline } from './max-api-baseline-reader';
import { maxApiMinuteCounterAddress } from '../max/max-api-counter-storage';
import {
  MAX_API_SOURCE_DIMENSION_BOOTSTRAP_COMPLETE_KEY as COMPLETE,
  MAX_API_SOURCE_DIMENSION_CATALOG_KEY as CATALOG,
  serializeMaxApiSourceMetricDimension,
} from '../max/max-api-metrics-key.util';

const url = process.env.MAXIM_TEST_REDIS_URL?.trim() ?? '';
const native = url ? describe : describe.skip;

native('bounded read-only fleet MAX baseline on native Redis', () => {
  let redis: Redis;
  let fixtureUrl: string;
  const keys = new Set<string>();
  const botId = `baseline-${randomUUID()}`;
  const untilMs = Math.floor((Date.now() - 120_000) / 60_000) * 60_000;
  const sec = untilMs / 1_000 - 1;
  jest.setTimeout(30_000);

  async function string(key: string, value: string) {
    keys.add(key);
    await redis.set(key, value);
  }
  async function minute(legacyKey: string, count: string) {
    const address = maxApiMinuteCounterAddress(legacyKey);
    keys.add(address.key);
    await redis.hset(address.key, address.field, count);
  }
  async function catalog(
    sourceTag = 'moderation_delete',
    trafficClass: 'critical' | 'interactive' | 'background' = 'critical',
  ) {
    keys.add(COMPLETE);
    keys.add(CATALOG);
    await redis.set(COMPLETE, '1');
    await redis.sadd(
      CATALOG,
      serializeMaxApiSourceMetricDimension({ botId, sourceTag, trafficClass }),
    );
  }

  beforeAll(async () => {
    if (!['127.0.0.1', 'localhost', '[::1]', '::1'].includes(new URL(url).hostname))
      throw new Error('Disposable localhost Redis required');
    // FLAG: The suite owns DB15 on the disposable wrapper Redis, leaving the
    // shared DB0 source catalog and every other suite's observations intact.
    if (!['', '/', '/0'].includes(new URL(url).pathname))
      throw new Error('Test wrapper default database required');
    const isolated = new URL(url);
    isolated.pathname = '/15';
    fixtureUrl = isolated.toString();
    redis = new Redis(fixtureUrl, { maxRetriesPerRequest: 0, commandTimeout: 2_000 });
    if (await redis.exists(COMPLETE, CATALOG))
      throw new Error('Baseline fixture catalog must be empty');
  });
  afterEach(async () => {
    if (keys.size) await redis.del(...keys);
    keys.clear();
  });
  afterAll(async () => {
    await redis.quit();
  });

  it('isolates fixtures from the shared default database', async () => {
    const shared = new Redis(url, { maxRetriesPerRequest: 0, commandTimeout: 2_000 });
    const sentinel = `maxapi:baseline-isolation:${randomUUID()}`;
    try {
      await shared.set(sentinel, 'owned-default-database-fixture');
      expect(await redis.get(sentinel)).toBeNull();
      expect(await shared.get(sentinel)).toBe('owned-default-database-fixture');
    } finally {
      await shared.del(sentinel);
      await shared.quit();
    }
  });

  it('sums disjoint storage layouts, scopes the closed window and redacts identities', async () => {
    await catalog();
    await catalog('private_unknown_source');
    const global = `maxapi:rps:global:${botId}:${sec}`;
    await string(global, '2');
    await minute(global, '3');
    await string(`maxapi:rps:global:${botId}:critical:${sec}`, '5');
    await minute(`maxapi:rps:source:v1:${botId}:critical:moderation_delete:${sec}`, '4');
    await minute(`maxapi:rps:source:v1:${botId}:critical:private_unknown_source:${sec}`, '1');
    await minute(`maxapi:rate-limit:v1:internal_limiter:${botId}:critical:${sec}`, '2');
    await string(`maxapi:rate-limit:v1:external_429:${botId}:background:${sec}`, '1');
    await minute(`maxapi:rps:global:${botId}:${untilMs / 1_000}`, '100');
    await minute(`maxapi:rps:global:${botId}:${untilMs / 1_000 - 61}`, '100');

    const report = await readMaxApiBaseline(redis, { botIds: [botId], untilMs });
    expect(report.available).toBe(true);
    if (!report.available) throw new Error('Baseline unavailable');
    expect(report.bots).toEqual([
      expect.objectContaining({
        alias: 'token_1',
        admitted: 5,
        classes: { critical: 5, interactive: 0, background: 0 },
        internalLimiterRejects: { critical: 2, interactive: 0, background: 0 },
        external429: { critical: 0, interactive: 0, background: 1 },
        sources: {
          moderation_delete: { critical: 4, interactive: 0, background: 0 },
          other: { critical: 1, interactive: 0, background: 0 },
        },
      }),
    ]);
    expect(report.populationComplete).toBe(false);
    expect(report.zeroOrMissingCounters).toBeGreaterThan(0);
    expect(JSON.stringify(report)).not.toContain(botId);
    expect(JSON.stringify(report)).not.toContain('private_unknown_source');
  });

  it('works with credentials that prohibit every write and keyspace scan', async () => {
    await catalog();
    await minute(`maxapi:rps:global:${botId}:${sec}`, '7');
    const name = `baseline_${randomUUID().replaceAll('-', '')}`;
    const password = randomUUID();
    await redis.acl(
      'SETUSER',
      name,
      'reset',
      'on',
      `>${password}`,
      '~maxapi:*',
      '-@all',
      '+get',
      '+scard',
      '+smembers',
      '+type',
      '+strlen',
      '+hstrlen',
      '+hget',
      '+eval_ro',
      '+memory|usage',
      '+select',
    );
    const reader = new Redis(fixtureUrl, {
      username: name,
      password,
      lazyConnect: true,
      enableReadyCheck: false,
      maxRetriesPerRequest: 0,
      commandTimeout: 2_000,
    });
    reader.on('error', () => undefined);
    try {
      await reader.connect();
      const report = await readMaxApiBaseline(reader, { botIds: [botId], untilMs });
      expect(report.available).toBe(true);
      if (report.available) expect(report.bots[0]?.admitted).toBe(7);
      await expect(reader.set('maxapi:forbidden', '1')).rejects.toThrow(/NOPERM/u);
      await expect(reader.scan('0')).rejects.toThrow(/NOPERM/u);
    } finally {
      reader.disconnect();
      await redis.acl('DELUSER', name);
    }
  });

  it('refuses missing bootstrap evidence without changing the catalog', async () => {
    const call = jest.spyOn(redis, 'call');
    try {
      const report = await readMaxApiBaseline(redis, { botIds: [botId], untilMs });
      expect(report).toMatchObject({ available: false, code: 'catalog_unavailable' });
      expect(call).toHaveBeenCalledTimes(1);
      expect(await redis.exists(COMPLETE, CATALOG)).toBe(0);
    } finally {
      call.mockRestore();
    }
  });

  it('refuses an oversized catalog and reads the largest admitted catalog in bounded slices', async () => {
    await catalog();
    const members = Array.from({ length: 512 }, (_, index) =>
      serializeMaxApiSourceMetricDimension({
        botId,
        trafficClass: 'critical',
        sourceTag: `source_${index}`,
      }),
    );
    await redis.sadd(CATALOG, ...members);
    expect(await readMaxApiBaseline(redis, { botIds: [botId], untilMs })).toMatchObject({
      available: false,
      code: 'catalog_limit',
    });
    await redis.srem(CATALOG, members[0]!);
    expect(
      await readMaxApiBaseline(redis, { botIds: [botId], untilMs, windowSec: 300 }),
    ).toMatchObject({ available: true, countersRead: (20 + 512) * 300 });
  });

  it.each([
    [7, 321],
    [32, 512],
  ])(
    'reads five closed minutes for %i bots and %i dimensions',
    async (botCount, dimensionCount) => {
      await catalog();
      const botIds = Array.from({ length: botCount }, (_, index) =>
        index ? `${botId}_${index}` : botId,
      );
      await redis.sadd(
        CATALOG,
        ...Array.from({ length: dimensionCount - 1 }, (_, index) =>
          serializeMaxApiSourceMetricDimension({
            botId: botIds[index % botCount]!,
            trafficClass: 'critical',
            sourceTag: `source_${index}`,
          }),
        ),
      );
      const fromSec = untilMs / 1_000 - 300;
      for (const id of botIds) {
        for (let slice = 0; slice < 5; slice++) {
          const key = `maxapi:rps:global:${id}:${fromSec + slice * 60}`;
          await string(key, '2');
          await minute(key, '3');
        }
        await minute(`maxapi:rps:global:${id}:${fromSec - 1}`, '100');
        await minute(`maxapi:rps:global:${id}:${untilMs / 1_000}`, '100');
      }
      const report = await readMaxApiBaseline(redis, { botIds, untilMs, windowSec: 300 });
      expect(report).toMatchObject({
        available: true,
        collectionComplete: true,
        slicesRead: 5,
        populationComplete: false,
        catalogDimensions: dimensionCount,
        countersRead: (10 * (botCount + 1) + dimensionCount) * 300,
        countersPresent: botCount * 5,
      });
      if (!report.available) throw new Error('Fleet baseline unavailable');
      expect(report.bots).toHaveLength(botCount);
      expect(report.bots.every((bot) => bot.admitted === 25)).toBe(true);
    },
  );

  it('refuses a catalog changed during collection instead of publishing partial totals', async () => {
    await catalog();
    const original = redis.call.bind(redis);
    let catalogReads = 0;
    const call = jest.spyOn(redis, 'call').mockImplementation(async (...args) => {
      if (args.includes(COMPLETE) && ++catalogReads === 2) {
        await catalog('new_dimension_during_collection');
      }
      return original(...args);
    });
    try {
      expect(await readMaxApiBaseline(redis, { botIds: [botId], untilMs })).toMatchObject({
        available: false,
        code: 'catalog_changed',
      });
      expect(catalogReads).toBe(2);
    } finally {
      call.mockRestore();
    }
  });

  it('stops after the common deadline without issuing another batch or returning partial data', async () => {
    await catalog();
    const clock = jest.spyOn(performance, 'now').mockReturnValue(0);
    const original = redis.call.bind(redis);
    let batches = 0;
    const call = jest.spyOn(redis, 'call').mockImplementation(async (...args) => {
      const result = await original(...args);
      if (!args.includes(COMPLETE)) {
        batches++;
        expect(Number(args[2])).toBeLessThanOrEqual(400);
        clock.mockReturnValue(8_001);
      }
      return result;
    });
    try {
      expect(
        await readMaxApiBaseline(redis, { botIds: [botId], untilMs, windowSec: 300 }),
      ).toMatchObject({
        available: false,
        code: 'deadline',
      });
      expect(batches).toBe(1);
    } finally {
      call.mockRestore();
      clock.mockRestore();
    }
  });

  it('refuses oversized catalog values before materializing their contents', async () => {
    await catalog();
    await redis.sadd(CATALOG, 'x'.repeat(512 * 1_024));
    expect(await readMaxApiBaseline(redis, { botIds: [botId], untilMs })).toMatchObject({
      available: false,
      code: 'catalog_limit',
    });
    await redis.srem(CATALOG, 'x'.repeat(512 * 1_024));
    await string(COMPLETE, 'x'.repeat(512 * 1_024));
    expect(await readMaxApiBaseline(redis, { botIds: [botId], untilMs })).toMatchObject({
      available: false,
      code: 'catalog_invalid',
    });
  });

  it.each(['-1', 'garbage', '9007199254740992', '1'.repeat(17)])(
    'retains invalid counter %s as failed evidence',
    async (value) => {
      await catalog();
      await string(`maxapi:rps:global:${botId}:${sec}`, value);
      expect(await readMaxApiBaseline(redis, { botIds: [botId], untilMs })).toMatchObject({
        available: false,
        code: 'read_failed',
      });
    },
  );

  it('refuses a duplicate semantic catalog dimension and reports absent counters explicitly', async () => {
    await catalog();
    const empty = await readMaxApiBaseline(redis, { botIds: [botId], untilMs });
    expect(empty).toMatchObject({ available: true, populationComplete: false, countersPresent: 0 });
    await redis.sadd(CATALOG, `[ "${botId}", "critical", "moderation_delete" ]`);
    expect(await readMaxApiBaseline(redis, { botIds: [botId], untilMs })).toMatchObject({
      available: false,
      code: 'catalog_invalid',
    });
  });

  it('rejects future, unaligned and expired windows before accessing Redis', async () => {
    const call = jest.spyOn(redis, 'call');
    try {
      for (const until of [Date.now() + 60_000, untilMs + 1, untilMs - 6 * 3_600_000])
        expect(await readMaxApiBaseline(redis, { botIds: [botId], untilMs: until })).toMatchObject({
          available: false,
          code: 'invalid_scope',
        });
      expect(call).not.toHaveBeenCalled();
    } finally {
      call.mockRestore();
    }
  });
});
