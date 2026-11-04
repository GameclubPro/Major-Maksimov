import Redis from 'ioredis';
import { ConfigService } from '@nestjs/config';
import type { SafetyDeskOverviewResponse } from '@maxim/contracts/safety-desk';
import {
  SafetyDeskOverviewStore,
  writeOverview,
  OVERVIEW_SNAPSHOT_KEY,
  OVERVIEW_HISTORY_KEY,
} from './safety-desk-overview-store';
import {
  overviewHistoryPoint,
  SafetyDeskOverviewService,
  OVERVIEW_COLLECTOR_LOCK_KEY,
} from './safety-desk-overview.service';
import { READ_OVERVIEW_QUEUE_COUNTERS_LUA } from '../system/queue-metrics.service';
import { MaxBotRegistryService } from '../max/max-bot-registry.service';
import { projectOverviewActions } from './safety-desk-overview-actions.service';
import { randomUUID } from 'node:crypto';

const url = process.env.MAXIM_TEST_REDIS_URL?.trim() ?? '';
const native = url ? describe : describe.skip;
function snapshot(at: number): SafetyDeskOverviewResponse {
  const missing = { availability: 'UNAVAILABLE' as const, observedAt: null, value: null };
  return {
    schemaVersion: 1,
    generatedAt: new Date(at).toISOString(),
    collector: {
      availability: 'FRESH',
      observedAt: new Date(at).toISOString(),
      lastSuccessfulAt: null,
    },
    queues: missing,
    workers: missing,
    receipts: missing,
    unfinishedActions: missing,
    actions: missing,
    bots: [],
    history: {
      availability: 'UNAVAILABLE',
      observedAt: null,
      windowSec: 86400,
      bucketSec: 60,
      retentionPoints: 1440,
      points: [],
    },
  };
}

native('Safety Desk shared history on native Redis', () => {
  let redis: Redis;
  jest.setTimeout(30000);
  beforeAll(async () => {
    if (!['127.0.0.1', 'localhost', '[::1]', '::1'].includes(new URL(url).hostname))
      throw new Error('Disposable localhost Redis required');
    redis = new Redis(url, { maxRetriesPerRequest: 0, commandTimeout: 2000 });
    if (
      await redis.exists(OVERVIEW_SNAPSHOT_KEY, OVERVIEW_HISTORY_KEY, OVERVIEW_COLLECTOR_LOCK_KEY)
    )
      throw new Error('Overview fixture keys must initially be empty');
  });
  afterEach(async () => {
    await redis.del(OVERVIEW_SNAPSHOT_KEY, OVERVIEW_HISTORY_KEY, OVERVIEW_COLLECTOR_LOCK_KEY);
  });
  afterAll(async () => {
    await redis.quit();
  });

  it('replaces the current minute, retains exactly 1440 points, expires after 24h and shares the same snapshot across restarts', async () => {
    const base = Math.floor(Date.now() / 60000) * 60000 - 1444 * 60000;
    for (let index = 0; index < 1445; index++) {
      const sample = snapshot(base + index * 60000);
      await writeOverview(redis, sample, overviewHistoryPoint(sample));
    }
    expect(await redis.zcard(OVERVIEW_HISTORY_KEY)).toBe(1440);
    expect(await redis.ttl(OVERVIEW_HISTORY_KEY)).toBeGreaterThanOrEqual(86395);
    expect(await redis.ttl(OVERVIEW_HISTORY_KEY)).toBeLessThanOrEqual(86400);
    const latest = snapshot(base + 1444 * 60000 + 5000);
    await writeOverview(redis, latest, { ...overviewHistoryPoint(latest), waiting: 7 });
    expect(await redis.zcard(OVERVIEW_HISTORY_KEY)).toBe(1440);
    const store = new SafetyDeskOverviewStore(new ConfigService({ REDIS_URL: url }));
    expect((await store.readSnapshot())?.generatedAt).toBe(latest.generatedAt);
    expect((await store.readHistory(base + 1444 * 60000 + 10000)).at(-1)?.waiting).toBe(7);
    store.onModuleDestroy();
    const restarted = new SafetyDeskOverviewStore(new ConfigService({ REDIS_URL: url }));
    expect((await restarted.readSnapshot())?.generatedAt).toBe(latest.generatedAt);
    restarted.onModuleDestroy();
  });
  it('rejects older writer completion and preserves missing observations as gaps', async () => {
    const at = Math.floor(Date.now() / 60000) * 60000;
    const latest = snapshot(at),
      older = snapshot(at - 60000);
    await writeOverview(redis, latest, overviewHistoryPoint(latest));
    await writeOverview(redis, older, { ...overviewHistoryPoint(older), waiting: 0 });
    expect(await redis.zcard(OVERVIEW_HISTORY_KEY)).toBe(1);
    const point = JSON.parse((await redis.zrange(OVERVIEW_HISTORY_KEY, 0, -1))[0]!);
    expect(point.waiting).toBeNull();
    expect(JSON.parse((await redis.get(OVERVIEW_SNAPSHOT_KEY))!).generatedAt).toBe(
      latest.generatedAt,
    );
    const store = new SafetyDeskOverviewStore(new ConfigService({ REDIS_URL: url }));
    try {
      await redis.set(OVERVIEW_SNAPSHOT_KEY, '{invalid');
      await expect(store.readSnapshot()).rejects.toThrow('Invalid overview snapshot');
    } finally {
      store.onModuleDestroy();
    }
  });
  it('reads actual BullMQ state counts without removing deprecated wait markers or any work', async () => {
    const prefix = `test:overview:${randomUUID()}:`;
    const keys = ['wait', 'paused', 'active', 'prioritized', 'delayed', 'failed', 'completed'].map(
      (name) => prefix + name,
    );
    try {
      await redis.rpush(prefix + 'wait', 'job-1', 'job-2', '0:legacy-marker');
      await redis.rpush(prefix + 'paused', 'job-3');
      await redis.rpush(prefix + 'active', 'job-4');
      await redis.zadd(prefix + 'prioritized', 1, 'job-5');
      expect(await redis.eval(READ_OVERVIEW_QUEUE_COUNTERS_LUA, 1, prefix)).toEqual([
        [3, 1, 1, 0, 0, 0],
      ]);
      expect(await redis.lrange(prefix + 'wait', 0, -1)).toEqual([
        'job-1',
        'job-2',
        '0:legacy-marker',
      ]);
      expect(await redis.zrange(prefix + 'prioritized', 0, -1)).toEqual(['job-5']);
    } finally {
      await redis.del(...keys);
    }
  });
  it('coalesces collectors across instances and settles a refused connection before recovering on the next tick', async () => {
    const config = new ConfigService({ REDIS_URL: url });
    const store = new SafetyDeskOverviewStore(config);
    const registry = new MaxBotRegistryService(
      new ConfigService({
        MAX_BOT_TOKEN: 'test-token',
        MAX_BOT_ID: 'major',
        MAX_WEBHOOK_SECRET_PATH: 'test-path',
        MAX_WEBHOOK_HEADER_SECRET: 'test-header',
      }),
    );
    const queues = {
      getOverviewCounters: jest.fn(async () => ({
        observedAt: new Date().toISOString(),
        rows: [],
      })),
    };
    const pending = {
      getSnapshot: jest.fn(async (ids: readonly string[]) => ({
        observedAt: new Date().toISOString(),
        unfinishedActions: { countLowerBound: 0, truncated: false, oldestStateAt: null },
        bots: ids.map((botId) => ({
          botId,
          received: { countLowerBound: 0, truncated: false, oldestAt: null },
          queued: { countLowerBound: 0, truncated: false, oldestAt: null },
          unfinishedActions: { countLowerBound: 0, truncated: false, oldestStateAt: null },
        })),
      })),
    };
    const actions = {
      getSnapshot: jest.fn(async (ids: string[], defaultId: string) =>
        projectOverviewActions([], new Date(), ids, defaultId),
      ),
    };
    const oldRole = process.env.APP_ROLE;
    process.env.APP_ROLE = 'admin';
    const service = new SafetyDeskOverviewService(store, queues, registry, pending, actions);
    try {
      await redis.set(OVERVIEW_COLLECTOR_LOCK_KEY, 'other-collector', 'PX', 60000);
      await service.collect();
      expect(pending.getSnapshot).not.toHaveBeenCalled();
      await redis.del(OVERVIEW_COLLECTOR_LOCK_KEY);
      store.invalidate();
      config.set('REDIS_URL', 'redis://127.0.0.1:1');
      const started = Date.now();
      await expect(service.collect()).rejects.toThrow();
      expect(Date.now() - started).toBeLessThan(3000);
      expect(pending.getSnapshot).not.toHaveBeenCalled();
      config.set('REDIS_URL', url);
      await service.collect();
      expect(pending.getSnapshot).toHaveBeenCalledTimes(1);
      expect((await store.readSnapshot())?.collector.availability).toBe('FRESH');
      expect(await redis.exists(OVERVIEW_COLLECTOR_LOCK_KEY)).toBe(0);
    } finally {
      await service.onModuleDestroy();
      store.onModuleDestroy();
      if (oldRole === undefined) delete process.env.APP_ROLE;
      else process.env.APP_ROLE = oldRole;
    }
  });
});
