import Redis from 'ioredis';
import {
  SafetyDeskOverviewService,
  ageOverview,
  overviewHistoryPoint,
  OVERVIEW_CHEAP_INTERVAL_MS,
  OVERVIEW_EXPENSIVE_INTERVAL_MS,
} from './safety-desk-overview.service';
import {
  OverviewInvalidEvidenceError,
  type SafetyDeskOverviewStore,
} from './safety-desk-overview-store';
import type { QueueMetricsService } from '../system/queue-metrics.service';
import { MaxBotRegistryService } from '../max/max-bot-registry.service';
import { ConfigService } from '@nestjs/config';
import type { SafetyDeskOverviewPendingService } from './safety-desk-overview-pending.service';
import type { SafetyDeskOverviewActionsService } from './safety-desk-overview-actions.service';
import { projectOverviewActions } from './safety-desk-overview-actions.service';

const now = new Date('2026-11-04T12:00:00.000Z');

function fixture() {
  const redis = new Redis('redis://127.0.0.1:1', { lazyConnect: true, retryStrategy: () => null });
  jest.spyOn(redis, 'get').mockResolvedValue(null);
  jest.spyOn(redis, 'set').mockResolvedValue('OK');
  jest.spyOn(redis, 'eval').mockResolvedValue(1);
  jest.spyOn(redis, 'mget').mockImplementation(async (...keys) => keys.map(() => null));
  const registry = new MaxBotRegistryService(
    new ConfigService({
      MAX_BOT_TOKEN: 'test-token',
      MAX_BOT_ID: 'major',
      MAX_BOT_LABEL: 'Майор',
      MAX_WEBHOOK_SECRET_PATH: 'test-path',
      MAX_WEBHOOK_HEADER_SECRET: 'test-header',
    }),
  );
  const ids = [
    ...registry.getAllBots().map((bot) => bot.id),
    registry.getPublisherBotDescriptor().id,
  ];
  const store = {
    invalidate: jest.fn<
      ReturnType<SafetyDeskOverviewStore['invalidate']>,
      Parameters<SafetyDeskOverviewStore['invalidate']>
    >(),
    connection: jest
      .fn<ReturnType<SafetyDeskOverviewStore['connection']>, []>()
      .mockResolvedValue(redis),
    readSnapshot: jest
      .fn<ReturnType<SafetyDeskOverviewStore['readSnapshot']>, []>()
      .mockResolvedValue(null),
    readHistory: jest
      .fn<ReturnType<SafetyDeskOverviewStore['readHistory']>, [number]>()
      .mockResolvedValue([]),
    write: jest
      .fn<
        ReturnType<SafetyDeskOverviewStore['write']>,
        Parameters<SafetyDeskOverviewStore['write']>
      >()
      .mockResolvedValue(),
  } satisfies Pick<
    SafetyDeskOverviewStore,
    'connection' | 'readSnapshot' | 'readHistory' | 'write' | 'invalidate'
  >;
  const queues = {
    getOverviewCounters: jest
      .fn<
        ReturnType<QueueMetricsService['getOverviewCounters']>,
        Parameters<QueueMetricsService['getOverviewCounters']>
      >()
      .mockImplementation(async () => ({
        observedAt: new Date().toISOString(),
        rows: [
          {
            name: 'webhook-critical',
            family: 'webhook',
            waiting: 2,
            prioritized: 3,
            active: 1,
            delayed: 0,
            failed: 0,
            completed: 4,
          },
        ],
      })),
  } satisfies Pick<QueueMetricsService, 'getOverviewCounters'>;
  const pending = {
    getSnapshot: jest
      .fn<
        ReturnType<SafetyDeskOverviewPendingService['getSnapshot']>,
        Parameters<SafetyDeskOverviewPendingService['getSnapshot']>
      >()
      .mockImplementation(async () => ({
        observedAt: new Date().toISOString(),
        unfinishedActions: { countLowerBound: 0, truncated: true, oldestStateAt: null },
        bots: ids.map((botId) => ({
          botId,
          received: { countLowerBound: 0, truncated: false, oldestAt: null },
          queued: { countLowerBound: 0, truncated: false, oldestAt: null },
          unfinishedActions: { countLowerBound: 0, truncated: true, oldestStateAt: null },
        })),
      })),
  } satisfies Pick<SafetyDeskOverviewPendingService, 'getSnapshot'>;
  const actions = {
    getSnapshot: jest
      .fn<
        ReturnType<SafetyDeskOverviewActionsService['getSnapshot']>,
        Parameters<SafetyDeskOverviewActionsService['getSnapshot']>
      >()
      .mockImplementation(async () =>
        projectOverviewActions([], new Date(), ids, registry.getDefaultBot().id),
      ),
  } satisfies Pick<SafetyDeskOverviewActionsService, 'getSnapshot'>;
  return {
    redis,
    store,
    queues,
    pending,
    actions,
    service: new SafetyDeskOverviewService(store, queues, registry, pending, actions),
  };
}

describe('Safety Desk shared bounded overview', () => {
  const originalRole = process.env.APP_ROLE;
  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(now);
    process.env.APP_ROLE = 'admin';
  });
  afterEach(() => {
    jest.useRealTimers();
    if (originalRole === undefined) delete process.env.APP_ROLE;
    else process.env.APP_ROLE = originalRole;
  });

  it('does no SQL or counter collection on browser GET and coalesces concurrent reads', async () => {
    const f = fixture();
    const [a, b] = await Promise.all([f.service.getSnapshot(), f.service.getSnapshot()]);
    expect(a.collector.availability).toBe('UNAVAILABLE');
    expect(b.queues.value).toBeNull();
    expect(f.store.readSnapshot).toHaveBeenCalledTimes(1);
    expect(f.queues.getOverviewCounters).not.toHaveBeenCalled();
    expect(f.pending.getSnapshot).not.toHaveBeenCalled();
    expect(f.actions.getSnapshot).not.toHaveBeenCalled();
    f.redis.disconnect();
  });

  it('collects only on the admin role, coalesces work, and keeps exact 10/30 second intervals', async () => {
    expect(OVERVIEW_CHEAP_INTERVAL_MS).toBe(10000);
    expect(OVERVIEW_EXPENSIVE_INTERVAL_MS).toBe(30000);
    const f = fixture();
    process.env.APP_ROLE = 'action';
    f.service.onModuleInit();
    await f.service.collect();
    expect(f.store.connection).not.toHaveBeenCalled();
    process.env.APP_ROLE = 'admin';
    const first = f.service.collect();
    expect(f.service.collect()).toBe(first);
    await first;
    jest.setSystemTime(new Date(now.getTime() + 10000));
    await f.service.collect();
    expect(f.queues.getOverviewCounters).toHaveBeenCalledTimes(2);
    expect(f.pending.getSnapshot).toHaveBeenCalledTimes(1);
    jest.setSystemTime(new Date(now.getTime() + 30000));
    await f.service.collect();
    expect(f.pending.getSnapshot).toHaveBeenCalledTimes(2);
    expect(f.actions.getSnapshot).toHaveBeenCalledTimes(2);
    const snapshot = f.store.write.mock.calls.at(-1)![0];
    expect(snapshot.unfinishedActions.value).toMatchObject({
      countLowerBound: 0,
      sampleComplete: false,
      ageBasis: 'state_updated_sample',
    });
    expect(snapshot.bots.every((bot) => bot.lastTerminalAt.value?.at === null)).toBe(true);
    expect(snapshot.workers.value?.freshCount).toBe(0);
    await f.service.onModuleDestroy();
    f.redis.disconnect();
  });

  it('retains failed samples with their source timestamps and exposes unavailable Redis without local zero fallbacks', async () => {
    const f = fixture();
    await f.service.collect();
    const original = f.store.write.mock.calls[0]![0];
    jest.setSystemTime(new Date(now.getTime() + 30000));
    f.queues.getOverviewCounters.mockRejectedValue(new Error('private redis details'));
    f.pending.getSnapshot.mockRejectedValue(new Error('private SQL details'));
    f.actions.getSnapshot.mockRejectedValue(new Error('private SQL details'));
    await f.service.collect();
    const stale = f.store.write.mock.calls[1]![0];
    expect(stale.queues).toEqual({ ...original.queues, availability: 'STALE' });
    expect(stale.receipts.observedAt).toBe(original.receipts.observedAt);
    expect(stale.collector.lastSuccessfulAt).toBe(original.collector.lastSuccessfulAt);
    expect(overviewHistoryPoint(stale).waiting).toBeNull();
    f.store.readSnapshot.mockRejectedValue(new Error('Redis unavailable'));
    const read = await f.service.getSnapshot();
    expect(read.queues).toEqual({ availability: 'UNAVAILABLE', observedAt: null, value: null });
    expect(JSON.stringify(read)).not.toContain('private');
    f.store.readSnapshot.mockRejectedValue(new OverviewInvalidEvidenceError());
    expect((await f.service.getSnapshot()).collector.availability).toBe('INVALID');
    f.redis.disconnect();
  });

  it('marks persisted evidence stale after restart and rejects future source clocks', async () => {
    const f = fixture();
    await f.service.collect();
    const snapshot = f.store.write.mock.calls[0]![0];
    f.store.readSnapshot.mockResolvedValue(snapshot);
    jest.setSystemTime(new Date(now.getTime() + 90000));
    const read = await f.service.getSnapshot();
    expect(read.collector.availability).toBe('STALE');
    expect(read.actions.availability).toBe('STALE');
    expect(read.queues.observedAt).toBe(now.toISOString());
    const future = structuredClone(snapshot);
    future.queues.observedAt = new Date(now.getTime() + 60000).toISOString();
    expect(ageOverview(future, now.getTime()).queues.availability).toBe('INVALID');
    expect(overviewHistoryPoint(snapshot).waiting).toBe(5);
    f.redis.disconnect();
  });
  it('waits for an in-flight cheap read on shutdown and never starts SQL afterward', async () => {
    const f = fixture();
    let started!: () => void, release!: () => void;
    const reading = new Promise<void>((resolve) => {
      started = resolve;
    });
    const pendingRead = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.queues.getOverviewCounters.mockImplementationOnce(async () => {
      started();
      await pendingRead;
      return { observedAt: now.toISOString(), rows: [] };
    });
    const collection = f.service.collect();
    await reading;
    let stopped = false;
    const stopping = f.service.onModuleDestroy().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);
    release();
    await Promise.all([collection, stopping]);
    expect(f.pending.getSnapshot).not.toHaveBeenCalled();
    expect(f.actions.getSnapshot).not.toHaveBeenCalled();
    expect(f.store.write).not.toHaveBeenCalled();
    await f.service.collect();
    expect(f.queues.getOverviewCounters).toHaveBeenCalledTimes(1);
    f.redis.disconnect();
  });
  it('waits for the already-running transaction and does not start the next SQL reader on shutdown', async () => {
    const f = fixture();
    let started!: () => void, release!: () => void;
    const reading = new Promise<void>((resolve) => {
      started = resolve;
    });
    const pendingRead = new Promise<void>((resolve) => {
      release = resolve;
    });
    const original = f.pending.getSnapshot.getMockImplementation()!;
    f.pending.getSnapshot.mockImplementationOnce(async (...args) => {
      started();
      await pendingRead;
      return original(...args);
    });
    const collection = f.service.collect();
    await reading;
    let stopped = false;
    const stopping = f.service.onModuleDestroy().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);
    release();
    await Promise.all([collection, stopping]);
    expect(f.actions.getSnapshot).not.toHaveBeenCalled();
    expect(f.store.write).not.toHaveBeenCalled();
    f.redis.disconnect();
  });
});
