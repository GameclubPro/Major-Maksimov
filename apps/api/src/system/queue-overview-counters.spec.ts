import {
  QueueMetricsService,
  AUXILIARY_QUEUE_NAMES,
  type OverviewCounterRedis,
} from './queue-metrics.service';
import { DEFAULT_WEBHOOK_QUEUE_NAMES, JOIN_WEBHOOK_QUEUE_NAMES } from '../webhook/webhook-queues';
import { MAX_ACTION_ALL_QUEUE_NAMES } from '../max/max-action.queue';

describe('fixed overview queue counters', () => {
  function fixture() {
    const redis = {
      eval: jest
        .fn<Promise<unknown>, [string, number, ...string[]]>()
        .mockImplementation(async (_script, count) =>
          Array.from({ length: count }, () => [3, 3, 4, 5, 6, 7]),
        ),
    } satisfies OverviewCounterRedis;
    const queue = { toKey: (type: string) => `bull:fixture:${type}` };
    const service = Object.create(QueueMetricsService.prototype) as QueueMetricsService;
    const map = (names: readonly string[]) =>
      Object.fromEntries(names.map((name) => [name, queue]));
    const queryRaw = jest.fn();
    Object.assign(service, {
      prisma: { $queryRaw: queryRaw },
      moduleRef: { get: () => queue },
      webhookCriticalQueue: queue,
      webhookBackgroundQueue: queue,
      webhookLegacyQueue: queue,
      globalSpammerDenormQueue: queue,
      webhookJoinQueuesByName: map(JOIN_WEBHOOK_QUEUE_NAMES),
      webhookDefaultQueuesByName: map(DEFAULT_WEBHOOK_QUEUE_NAMES),
      auxiliaryQueuesByName: map(AUXILIARY_QUEUE_NAMES),
      actionQueuesByName: map(MAX_ACTION_ALL_QUEUE_NAMES),
    });
    return { service, redis, queryRaw };
  }
  it('reads each fixed queue once without SQL, merging paused into waiting without double-counted aggregates', async () => {
    const f = fixture();
    const { rows } = await f.service.getOverviewCounters(f.redis);
    expect(new Set(rows.map((row) => row.name)).size).toBe(rows.length);
    expect(f.redis.eval).toHaveBeenCalledTimes(1);
    expect(
      rows.every((row) => row.waiting === 3 && row.prioritized === 3 && row.active === 4),
    ).toBe(true);
    expect(f.queryRaw).not.toHaveBeenCalled();
  });
  it('rejects missing queues and malformed Redis counts instead of returning idle zeroes', async () => {
    const f = fixture();
    Object.assign(f.service, { webhookCriticalQueue: undefined });
    await expect(f.service.getOverviewCounters(f.redis)).rejects.toThrow('unavailable');
    const malformed = fixture();
    malformed.redis.eval.mockResolvedValue([[1]]);
    await expect(malformed.service.getOverviewCounters(malformed.redis)).rejects.toThrow('Invalid');
    const unavailable = fixture();
    unavailable.redis.eval.mockRejectedValue(new Error('Redis offline'));
    await expect(unavailable.service.getOverviewCounters(unavailable.redis)).rejects.toThrow(
      'Redis offline',
    );
  });
});
