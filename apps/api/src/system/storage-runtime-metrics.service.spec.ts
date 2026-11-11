import { ConfigService } from '@nestjs/config';
import { monitorEventLoopDelay, PerformanceObserver } from 'node:perf_hooks';
import { getHeapStatistics } from 'node:v8';
import { createChatContextCacheActivity } from '../chat-context/chat-context-cache-metrics';
import { WebhookOutboxRuntimeMetrics } from '../webhook/webhook-runtime-metrics';
import { WebhookPreparationAdmission } from '../webhook/webhook-preparation-admission';
import { RUNTIME_SERVICE_NAMES } from '../runtime/runtime-topology';
import {
  connectionAdmissionMetrics,
  type ConnectionAdmissionSnapshot,
} from '../prisma/connection-admission-metrics';
import {
  sanitizeStorageRuntimeSnapshot,
  STORAGE_DELETE_DUE_SWEEP_STAGES,
  STORAGE_DELETE_RECONCILER_PHASES,
  StorageRuntimeMetricsService,
  STORAGE_RUNTIME_MAX_REPORT_BYTES,
} from './storage-runtime-metrics.service';

const mockRedis = {
  on: jest.fn(),
  connect: jest.fn().mockResolvedValue(undefined),
  set: jest.fn().mockResolvedValue('OK'),
  mget: jest.fn(),
  disconnect: jest.fn(),
};
jest.mock('ioredis', () => ({ __esModule: true, default: jest.fn(() => mockRedis) }));
const mockGcObserver = { observe: jest.fn(), disconnect: jest.fn() };
const mockEventLoopDelay = {
  enable: jest.fn(),
  disable: jest.fn(),
  reset: jest.fn(),
  count: 0,
  mean: NaN,
  max: Number.MAX_SAFE_INTEGER,
  percentile: jest.fn(),
};
let mockGcCallback:
  | ((list: { getEntries(): Array<{ entryType: string; duration: number }> }) => void)
  | null = null;
jest.mock('node:perf_hooks', () => ({
  ...jest.requireActual<typeof import('node:perf_hooks')>('node:perf_hooks'),
  PerformanceObserver: jest.fn((callback) => {
    mockGcCallback = callback;
    return mockGcObserver;
  }),
  monitorEventLoopDelay: jest.fn(() => mockEventLoopDelay),
}));
jest.mock('node:v8', () => ({ getHeapStatistics: jest.fn() }));
const memoryFixture = {
  rss: 4096,
  heapUsed: 512,
  heapTotal: 1024,
  external: 512,
  arrayBuffers: 256,
};

function connectionAdmissionSnapshot(): ConnectionAdmissionSnapshot {
  return {
    lanes: {
      ordinary: {
        calls: 4,
        errors: 1,
        unknownClock: 1,
        totalMs: 650,
        maxMs: 500,
        under100Ms: 1,
        under500Ms: 1,
        under2000Ms: 1,
        under10000Ms: 0,
        atLeast10000Ms: 0,
      },
      budgeted: {
        calls: 1,
        errors: 0,
        unknownClock: 0,
        totalMs: 5,
        maxMs: 5,
        under100Ms: 1,
        under500Ms: 0,
        under2000Ms: 0,
        under10000Ms: 0,
        atLeast10000Ms: 0,
      },
    },
    counters: {
      retryTimeouts: 1,
      budgetRejectedBefore: 0,
      capacityRejected: 0,
      budgetRejectedAfter: 0,
      lateReleases: 0,
      registryOverflows: 0,
    },
    gauges: {
      pools: 2,
      capacity: 12,
      total: 6,
      idle: 1,
      waiting: 2,
      budgetedInFlight: 2,
      endingPools: 0,
    },
  };
}

function deleteReconcilerSnapshot() {
  return {
    tickCalls: 1,
    skippedInFlight: 0,
    completedTicks: 1,
    phases: Object.fromEntries(
      STORAGE_DELETE_RECONCILER_PHASES.map((phase) => [
        phase,
        {
          calls: 1,
          succeeded: 1,
          errors: 0,
          returnedCount: 0,
          durationBuckets: { under100Ms: 1, under500Ms: 0, under2000Ms: 0, atLeast2000Ms: 0 },
        },
      ]),
    ),
  };
}

function deleteDueSweepSnapshot() {
  return {
    calls: 1,
    completed: 1,
    errors: 0,
    executionDisabled: 0,
    selectedCount: 2,
    handoffAttemptedCount: 2,
    handoffAcknowledgedCount: 1,
    handoffErrorCount: 1,
    handoffInsertionUnknownCount: 1,
    handoffOutcomes: {
      insertedCount: 0,
      existingCount: 0,
      reusedCount: 0,
      observationErrorCount: 0,
    },
    stages: Object.fromEntries(
      STORAGE_DELETE_DUE_SWEEP_STAGES.map((stage) => [
        stage,
        {
          calls: 1,
          succeeded: 1,
          errors: 0,
          returnedCount: stage === 'handoff' ? 1 : 2,
          totalDurationMs: 201,
          maxDurationMs: 201,
          durationBuckets: { under100Ms: 0, under500Ms: 1, under2000Ms: 0, atLeast2000Ms: 0 },
        },
      ]),
    ),
  };
}

function webhookOutboxSnapshot() {
  const metrics = new WebhookOutboxRuntimeMetrics();
  return {
    ...metrics,
    inFlightWorkUnits: 0,
    retention: {
      ...metrics.retention,
      cleaning: false,
      maintenancePending: false,
      config: {
        webhookCompletedRetentionEnabled: false,
        webhookFailedRetentionEnabled: false,
        webhookRetentionDays: 7,
        webhookFailedRetentionHours: 24,
        moderationRetentionDays: 90,
        userDisplayNameRetentionDays: 180,
      },
    },
  };
}

describe('bounded storage-runtime metrics', () => {
  let metrics: StorageRuntimeMetricsService;
  beforeEach(() => {
    jest.clearAllMocks();
    mockRedis.set.mockResolvedValue('OK');
    jest.spyOn(process, 'memoryUsage').mockReturnValue(memoryFixture);
    (getHeapStatistics as jest.Mock).mockReturnValue({ heap_size_limit: 8192 });
    mockEventLoopDelay.count = 0;
    mockEventLoopDelay.mean = NaN;
    mockEventLoopDelay.max = Number.MAX_SAFE_INTEGER;
    mockEventLoopDelay.percentile.mockReturnValue(NaN);
    mockGcCallback = null;
    metrics = new StorageRuntimeMetricsService(
      new ConfigService({
        APP_SERVICE_NAME: 'api-admin',
        REDIS_URL: 'redis://127.0.0.1:6379',
      }),
    );
  });
  afterEach(async () => {
    await metrics.onModuleDestroy();
    jest.restoreAllMocks();
  });

  it('publishes and reads fixed admission measurements with the existing report epoch and TTL', async () => {
    const fixture = connectionAdmissionSnapshot();
    const privateFixture = {
      ...fixture,
      lanes: {
        ...fixture.lanes,
        ordinary: { ...fixture.lanes.ordinary, sql: 'private-query-fixture' },
        'private-lane': fixture.lanes.ordinary,
      },
      counters: { ...fixture.counters, botId: 'private-bot-fixture' },
      gauges: { ...fixture.gauges!, application_name: 'private-application-fixture' },
      connectionString: 'private-connection-fixture',
    };
    const snapshot = jest
      .spyOn(connectionAdmissionMetrics, 'snapshot')
      .mockReturnValue(privateFixture);
    const before = metrics.getLocalSnapshot()!;
    expect(before.prismaAdmission).toEqual(fixture);
    await metrics.publish();
    const [key, encoded, expiration, ttl] = mockRedis.set.mock.calls[0];
    const report = JSON.parse(encoded);
    expect(key).toBe('runtime:storage-cost:v1:api-admin');
    expect([expiration, ttl]).toEqual(['PX', 90_000]);
    expect(report.startedAt).toBe(before.startedAt);
    expect(report.prismaAdmission).toEqual(fixture);
    expect(encoded).not.toContain('private-');
    expect(snapshot).toHaveBeenCalledTimes(2);
    mockRedis.mget.mockResolvedValueOnce([
      JSON.stringify({ ...report, prismaAdmission: privateFixture }),
      ...Array(RUNTIME_SERVICE_NAMES.length - 1).fill(null),
    ]);
    const fleet = await metrics.getFleetSnapshot();
    expect(fleet.services[0].snapshot?.prismaAdmission).toEqual(fixture);
    expect(JSON.stringify(fleet)).not.toContain('private-');
    expect(snapshot).toHaveBeenCalledTimes(2);
  });
  it('keeps older and corrupt optional admission measurements independent of other metrics', () => {
    const report = metrics.getLocalSnapshot()!;
    const fixture = connectionAdmissionSnapshot();
    const older = Object.fromEntries(
      Object.entries(report).filter(([field]) => field !== 'prismaAdmission'),
    );
    expect(sanitizeStorageRuntimeSnapshot(older)).toMatchObject({
      prismaAdmission: null,
      counters: report.counters,
      optimization: report.optimization,
    });
    for (const prismaAdmission of [
      null,
      [],
      {},
      { ...fixture, lanes: { ...fixture.lanes, budgeted: [] } },
      { ...fixture, counters: { ...fixture.counters, retryTimeouts: -1 } },
      { ...fixture, counters: { ...fixture.counters, lateReleases: 0.5 } },
      {
        ...fixture,
        lanes: { ...fixture.lanes, ordinary: { ...fixture.lanes.ordinary, calls: NaN } },
      },
    ])
      expect(sanitizeStorageRuntimeSnapshot({ ...report, prismaAdmission })).toMatchObject({
        prismaAdmission: null,
        counters: report.counters,
        optimization: report.optimization,
        processMemory: report.processMemory,
      });
    for (const prismaAdmission of [
      { ...fixture, gauges: null },
      { ...fixture, gauges: { ...fixture.gauges!, total: -1 } },
      { ...fixture, counters: { ...fixture.counters, registryOverflows: 1 } },
    ])
      expect(
        sanitizeStorageRuntimeSnapshot({ ...report, prismaAdmission })?.prismaAdmission,
      ).toEqual({
        lanes: fixture.lanes,
        counters: prismaAdmission.counters,
        gauges: null,
      });
    jest.spyOn(connectionAdmissionMetrics, 'snapshot').mockImplementation(() => {
      throw new Error('private-admission-fixture');
    });
    expect(metrics.getLocalSnapshot()).toMatchObject({
      prismaAdmission: null,
      counters: report.counters,
      optimization: report.optimization,
    });
  });

  it('persists only fixed scalars and bounds the lifetime of every report', async () => {
    metrics.increment('deleteLeaseChecks');
    metrics.registerAutomaticDeleteAuthorSnapshot(() => ({
      roster: 3,
      protected: 1,
      legacy: 0,
      membership: 2,
      shared: 1,
      userId: 'private-author-fixture',
    }));
    metrics.registerChatContextCacheSnapshot(() => ({
      entries: 2,
      estimatedBytes: 100,
      hits: 1,
      maxEntries: 2048,
      maxBytes: 33554432,
      maxEntryBytes: 16777216,
      misses: 0,
      writes: 0,
      oversizedSkips: 0,
      capacityEvictions: 0,
      expiredEvictions: 0,
      invalidations: 0,
      sweepInspected: 0,
      activity: {
        ...createChatContextCacheActivity(),
        redisHits: 7,
        invalidationsByReason: {
          ...createChatContextCacheActivity().invalidationsByReason,
          access_denied: { events: 2, evictedEntries: 1 },
          'private-reason-fixture': { events: 9, evictedEntries: 9 },
        },
        chatId: 'private-activity-fixture',
      },
      settingsTemplates: {
        entries: 1,
        estimatedBytes: 2048,
        maxEntries: 2048,
        maxBytes: 16777216,
        maxEntryBytes: 16777216,
        hits: 3,
        misses: 1,
        writes: 1,
        oversizedSkips: 0,
        capacityEvictions: 0,
        fullLoads: 1,
        shellReads: 3,
        reuses: 2,
        segments: {
          compactBytes: 1024,
          maxCompactBytes: 8388608,
          maxCompactEntryBytes: 262144,
          mediaBytes: 1024,
          maxMediaBytes: 8388608,
          mediaEntries: 1,
          sharedMediaReuses: 2,
          mediaCapacityEvictions: 0,
          content: 'private-media-fixture',
        },
        chatId: 'private-template-fixture',
      },
      payload: 'private-content-fixture',
      chatId: 'private-id-fixture',
    }));
    metrics.registerVkPersistenceSnapshot(() => ({
      batches: 1,
      postsAttempted: 1,
      rowsWritten: 1,
      rowsSkippedOrFenced: 0,
      failedBatches: 0,
      durationBuckets: {
        under100Ms: 1,
        under500Ms: 0,
        under2000Ms: 0,
        atLeast2000Ms: 0,
        sql: 'private-sql-fixture',
      },
    }));
    await metrics.publish();
    const [key, encoded, expiration, ttl] = mockRedis.set.mock.calls[0];
    expect(key).toBe('runtime:storage-cost:v1:api-admin');
    expect(expiration).toBe('PX');
    expect(ttl).toBe(90_000);
    expect(encoded).not.toContain('private-');
    const snapshot = JSON.parse(encoded);
    expect(snapshot.counters.deleteLeaseChecks).toBe(1);
    expect(snapshot.automaticDeleteAuthors).toEqual({
      roster: 3,
      protected: 1,
      legacy: 0,
      membership: 2,
      shared: 1,
    });
    expect(snapshot.chatContextCache.entries).toBe(2);
    expect(snapshot.chatContextCache.activity.redisHits).toBe(7);
    expect(snapshot.chatContextCache.settingsTemplates).toEqual({
      entries: 1,
      estimatedBytes: 2048,
      maxEntries: 2048,
      maxBytes: 16777216,
      maxEntryBytes: 16777216,
      hits: 3,
      misses: 1,
      writes: 1,
      oversizedSkips: 0,
      capacityEvictions: 0,
      fullLoads: 1,
      shellReads: 3,
      reuses: 2,
      segments: {
        compactBytes: 1024,
        maxCompactBytes: 8388608,
        maxCompactEntryBytes: 262144,
        mediaBytes: 1024,
        maxMediaBytes: 8388608,
        mediaEntries: 1,
        sharedMediaReuses: 2,
        mediaCapacityEvictions: 0,
      },
    });
    expect(sanitizeStorageRuntimeSnapshot(snapshot)?.chatContextCache?.settingsTemplates).toEqual(
      snapshot.chatContextCache.settingsTemplates,
    );
    for (const segments of [undefined, null, {}, { mediaBytes: -1 }]) {
      const older = sanitizeStorageRuntimeSnapshot({
        ...snapshot,
        chatContextCache: {
          ...snapshot.chatContextCache,
          settingsTemplates: { ...snapshot.chatContextCache.settingsTemplates, segments },
        },
      });
      expect(older?.chatContextCache?.settingsTemplates).toMatchObject({ entries: 1, reuses: 2 });
      expect(older?.chatContextCache?.settingsTemplates).not.toHaveProperty('segments');
    }
    expect(snapshot.chatContextCache.activity.invalidationsByReason.access_denied).toEqual({
      events: 2,
      evictedEntries: 1,
    });
    expect(snapshot.vkPersistence.durationBuckets.under100Ms).toBe(1);
  });
  it('keeps older cache reports readable and exposes invalid attribution as missing coverage', () => {
    const report = metrics.getLocalSnapshot()!;
    const cache = {
      entries: 0,
      estimatedBytes: 0,
      maxEntries: 1,
      maxBytes: 1024,
      maxEntryBytes: 1024,
      hits: 0,
      misses: 0,
      writes: 0,
      oversizedSkips: 0,
      capacityEvictions: 0,
      expiredEvictions: 0,
      invalidations: 0,
      sweepInspected: 0,
    };
    expect(sanitizeStorageRuntimeSnapshot({ ...report, chatContextCache: cache })).toMatchObject({
      chatContextCache: { ...cache, activity: null, settingsTemplates: null },
    });
    for (const activity of [
      null,
      {},
      { ...createChatContextCacheActivity(), sourceLoads: -1 },
      { ...createChatContextCacheActivity(), redisHits: 0.5 },
      { ...createChatContextCacheActivity(), invalidationsByReason: {} },
      {
        ...createChatContextCacheActivity(),
        invalidationsByReason: {
          ...createChatContextCacheActivity().invalidationsByReason,
          explicit: { events: 1, evictedEntries: 2 },
        },
      },
    ]) {
      expect(
        sanitizeStorageRuntimeSnapshot({ ...report, chatContextCache: { ...cache, activity } }),
      ).toMatchObject({ chatContextCache: { ...cache, activity: null } });
    }
    for (const settingsTemplates of [null, {}, { entries: -1 }, { reuses: 0.5 }]) {
      expect(
        sanitizeStorageRuntimeSnapshot({
          ...report,
          chatContextCache: {
            ...cache,
            activity: createChatContextCacheActivity(),
            settingsTemplates,
          },
        }),
      ).toMatchObject({
        chatContextCache: { activity: createChatContextCacheActivity(), settingsTemplates: null },
      });
    }
  });
  it('coalesces slow reporting without queuing reports or affecting work', async () => {
    let resolve!: (value: string) => void;
    mockRedis.set.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const first = metrics.publish();
    expect(metrics.publish()).toBe(first);
    await Promise.resolve();
    expect(mockRedis.set).toHaveBeenCalledTimes(1);
    resolve('OK');
    await first;
  });
  it('samples fixed memory byte gauges without serializing V8 or process metadata', async () => {
    jest
      .spyOn(process, 'memoryUsage')
      .mockReturnValue({ ...memoryFixture, ...{ payload: 'private-process-fixture' } });
    (getHeapStatistics as jest.Mock).mockReturnValue({
      heap_size_limit: 8192,
      payload: 'private-v8-fixture',
    });
    await metrics.publish();
    const encoded = mockRedis.set.mock.calls[0][1];
    expect(JSON.parse(encoded).processMemory).toEqual({
      rssBytes: 4096,
      heapUsedBytes: 512,
      heapTotalBytes: 1024,
      externalBytes: 512,
      arrayBuffersBytes: 256,
      heapLimitBytes: 8192,
    });
    expect(encoded).not.toContain('private');
    expect(encoded).not.toContain('heap_size_limit');
    expect(JSON.parse(encoded).processPerformance).toBeNull();
  });
  it('keeps old report fields readable with explicit missing coverage for additive measurements', () => {
    const current = metrics.getLocalSnapshot()!;
    const older = Object.fromEntries(
      Object.entries(current).filter(
        ([key]) =>
          !['processMemory', 'processPerformance', 'deleteDueSweep', 'vkMediaAdmission'].includes(
            key,
          ),
      ),
    );
    expect(sanitizeStorageRuntimeSnapshot(older)).toMatchObject({
      counters: current.counters,
      startedAt: current.startedAt,
      processMemory: null,
      processPerformance: null,
      deleteDueSweep: null,
      vkMediaAdmission: null,
    });
  });
  it('publishes bounded media reservations as scalars without retaining provider metadata', async () => {
    const state = {
      budgetBytes: 1024,
      reservedBytes: 512,
      active: 1,
      waiting: 2,
      peakReservedBytes: 768,
      peakWaiting: 3,
      stopping: false,
    };
    metrics.registerVkMediaAdmissionSnapshot(() => ({ ...state, payload: 'private-media' }));
    await metrics.publish();
    const encoded = mockRedis.set.mock.calls[0][1];
    expect(JSON.parse(encoded).vkMediaAdmission).toEqual(state);
    expect(encoded).not.toContain('private-media');
    const valid = metrics.getLocalSnapshot()!;
    for (const invalid of [
      { ...state, reservedBytes: 2048 },
      { ...state, peakWaiting: 1 },
      { ...state, stopping: 'private' },
      { ...state, active: -1 },
    ]) {
      expect(sanitizeStorageRuntimeSnapshot({ ...valid, vkMediaAdmission: invalid })).toMatchObject(
        {
          vkMediaAdmission: null,
          counters: valid.counters,
        },
      );
    }
    metrics.registerVkMediaAdmissionSnapshot(() => {
      throw new Error('private-media');
    });
    expect(metrics.getLocalSnapshot()?.vkMediaAdmission).toBeNull();
  });
  it('isolates unavailable or corrupt memory measurements from existing counters', () => {
    metrics.increment('deleteLeaseChecks');
    jest.spyOn(process, 'memoryUsage').mockImplementation(() => {
      throw new Error('private-process-fixture');
    });
    expect(metrics.getLocalSnapshot()).toMatchObject({
      processMemory: null,
      counters: { deleteLeaseChecks: 1 },
    });
    const valid = metrics.getLocalSnapshot()!;
    const fields = {
      rssBytes: 1,
      heapUsedBytes: 1,
      heapTotalBytes: 1,
      externalBytes: 1,
      arrayBuffersBytes: 1,
      heapLimitBytes: 1,
    };
    for (const value of [-1, Infinity, NaN, '1', undefined])
      expect(
        sanitizeStorageRuntimeSnapshot({ ...valid, processMemory: { ...fields, rssBytes: value } }),
      ).toMatchObject({ processMemory: null, counters: valid.counters });
  });
  it('collects cumulative GC and event-loop scalars without resetting them on snapshot reads', () => {
    metrics.onModuleInit();
    expect(monitorEventLoopDelay).toHaveBeenCalledWith({ resolution: 100 });
    expect(mockGcObserver.observe).toHaveBeenCalledWith({ entryTypes: ['gc'] });
    expect(metrics.getLocalSnapshot()?.processPerformance).toEqual({
      gc: { count: 0, totalDurationUs: 0 },
      eventLoopDelay: null,
    });
    mockGcCallback!({
      getEntries: () => [
        { entryType: 'gc', duration: 0.12501, ...{ payload: 'private-gc-fixture' } },
        { entryType: 'gc', duration: 2 },
        { entryType: 'measure', duration: 10 },
        { entryType: 'gc', duration: NaN },
        { entryType: 'gc', duration: -1 },
      ],
    });
    mockEventLoopDelay.count = 3;
    mockEventLoopDelay.mean = 101_000_001;
    mockEventLoopDelay.max = 250_000_001;
    mockEventLoopDelay.percentile.mockReturnValue(200_000_001);
    const first = metrics.getLocalSnapshot()!;
    expect(first.processPerformance).toEqual({
      gc: { count: 2, totalDurationUs: 2126 },
      eventLoopDelay: {
        resolutionMs: 100,
        samples: 3,
        meanUs: 101001,
        p95Us: 200001,
        maxUs: 250001,
      },
    });
    mockGcCallback!({ getEntries: () => [{ entryType: 'gc', duration: 1 }] });
    expect(metrics.getLocalSnapshot()?.processPerformance?.gc).toEqual({
      count: 3,
      totalDurationUs: 3126,
    });
    expect(first.processPerformance?.gc).toEqual({ count: 2, totalDurationUs: 2126 });
    expect(mockEventLoopDelay.reset).not.toHaveBeenCalled();
    expect(JSON.stringify(first)).not.toContain('private');
  });
  it('saturates cumulative GC duration without invalidating later reports', () => {
    metrics.onModuleInit();
    mockGcCallback!({
      getEntries: () => Array(3).fill({ entryType: 'gc', duration: 4_000_000_000_000 }),
    });
    expect(metrics.getLocalSnapshot()?.processPerformance?.gc).toEqual({
      count: 3,
      totalDurationUs: Number.MAX_SAFE_INTEGER,
    });
  });
  it('starts monitoring once and releases observers and reporting before teardown', async () => {
    metrics.onModuleInit();
    metrics.onModuleInit();
    expect(PerformanceObserver).toHaveBeenCalledTimes(1);
    expect(mockEventLoopDelay.enable).toHaveBeenCalledTimes(1);
    const callback = mockGcCallback!;
    await metrics.onModuleDestroy();
    expect(mockGcObserver.disconnect).toHaveBeenCalledTimes(1);
    expect(mockEventLoopDelay.disable).toHaveBeenCalledTimes(1);
    callback({ getEntries: () => [{ entryType: 'gc', duration: 1 }] });
    await metrics.publish();
    metrics.onModuleInit();
    expect(mockRedis.set).not.toHaveBeenCalled();
    expect(PerformanceObserver).toHaveBeenCalledTimes(1);
    expect(metrics.getLocalSnapshot()?.processPerformance).toBeNull();
  });
  it('isolates unsupported GC monitoring and failed histogram reads', () => {
    mockGcObserver.observe.mockImplementationOnce(() => {
      throw new Error('private-observer-fixture');
    });
    metrics.onModuleInit();
    expect(mockGcObserver.disconnect).toHaveBeenCalledTimes(1);
    mockEventLoopDelay.count = 1;
    mockEventLoopDelay.percentile.mockImplementationOnce(() => {
      throw new Error('private-histogram-fixture');
    });
    expect(metrics.getLocalSnapshot()).toMatchObject({
      processPerformance: { gc: null, eventLoopDelay: null },
      processMemory: { rssBytes: 4096 },
    });
  });
  it('preserves GC coverage when event-loop monitoring cannot start', () => {
    mockEventLoopDelay.enable.mockImplementationOnce(() => {
      throw new Error('private-histogram-fixture');
    });
    metrics.onModuleInit();
    expect(mockEventLoopDelay.disable).toHaveBeenCalledTimes(1);
    expect(metrics.getLocalSnapshot()?.processPerformance).toEqual({
      gc: { count: 0, totalDurationUs: 0 },
      eventLoopDelay: null,
    });
  });
  it('does not start process observers for an unrecognized runtime role', async () => {
    const invalid = new StorageRuntimeMetricsService(
      new ConfigService({
        APP_SERVICE_NAME: 'private-unknown-role',
        REDIS_URL: 'redis://127.0.0.1:6379',
      }),
    );
    try {
      invalid.onModuleInit();
      expect(PerformanceObserver).not.toHaveBeenCalled();
      expect(monitorEventLoopDelay).not.toHaveBeenCalled();
    } finally {
      await invalid.onModuleDestroy();
    }
  });
  it('allowlists due-sweep counters and preserves acknowledgement-versus-insertion uncertainty', async () => {
    const fixture = deleteDueSweepSnapshot();
    metrics.registerDeleteDueSweepSnapshot(() => ({
      ...fixture,
      botId: 'private-bot-fixture',
      stages: {
        ...fixture.stages,
        privateLabel: fixture.stages.handoff,
        handoff: { ...fixture.stages.handoff, payload: 'private-payload-fixture' },
      },
    }));
    await metrics.publish();
    const encoded = mockRedis.set.mock.calls[0][1];
    const snapshot = JSON.parse(encoded);
    expect(snapshot.deleteDueSweep).toEqual(fixture);
    expect(snapshot.deleteDueSweep.handoffAcknowledgedCount).toBe(1);
    expect(snapshot.deleteDueSweep.handoffInsertionUnknownCount).toBe(1);
    expect(encoded).not.toContain('private');
    expect(Buffer.byteLength(encoded)).toBeLessThanOrEqual(STORAGE_RUNTIME_MAX_REPORT_BYTES);
  });
  it('keeps invalid or failing due-sweep measurements from discarding the existing report', () => {
    const valid = metrics.getLocalSnapshot()!;
    const fixture = deleteDueSweepSnapshot();
    const legacyFixture: Partial<typeof fixture> = { ...fixture };
    delete legacyFixture.handoffOutcomes;
    expect(
      sanitizeStorageRuntimeSnapshot({ ...valid, deleteDueSweep: legacyFixture }),
    ).toMatchObject({ deleteDueSweep: { handoffOutcomes: null, handoffInsertionUnknownCount: 1 } });
    expect(
      sanitizeStorageRuntimeSnapshot({
        ...valid,
        deleteDueSweep: {
          ...fixture,
          handoffOutcomes: { ...fixture.handoffOutcomes, insertedCount: -1 },
        },
      }),
    ).toMatchObject({ deleteDueSweep: { handoffOutcomes: null, handoffAcknowledgedCount: 1 } });
    for (const value of [-1, Infinity, NaN, '1', undefined])
      expect(
        sanitizeStorageRuntimeSnapshot({
          ...valid,
          deleteDueSweep: {
            ...fixture,
            stages: {
              ...fixture.stages,
              handoff: { ...fixture.stages.handoff, totalDurationMs: value },
            },
          },
        }),
      ).toMatchObject({ counters: valid.counters, deleteDueSweep: null });
    metrics.registerDeleteDueSweepSnapshot(() => {
      throw new Error('private-sweep-fixture');
    });
    expect(metrics.getLocalSnapshot()).toMatchObject({
      counters: valid.counters,
      deleteDueSweep: null,
    });
  });
  it('keeps a complete report at maximum scalar widths inside the fleet decoder size budget', async () => {
    jest
      .spyOn(connectionAdmissionMetrics, 'snapshot')
      .mockReturnValue(connectionAdmissionSnapshot());
    const automaticDeleteAuthors = { roster: 1, protected: 1, legacy: 1, membership: 1, shared: 1 };
    const vkMediaAdmission = {
      budgetBytes: 1,
      reservedBytes: 1,
      active: 1,
      waiting: 1,
      peakReservedBytes: 1,
      peakWaiting: 1,
      stopping: false,
    };
    const templateSegments = {
      compactBytes: 1,
      maxCompactBytes: 1,
      maxCompactEntryBytes: 1,
      mediaBytes: 1,
      maxMediaBytes: 1,
      mediaEntries: 1,
      sharedMediaReuses: 1,
      mediaCapacityEvictions: 1,
    };
    metrics.onModuleInit();
    mockEventLoopDelay.count = 1;
    mockEventLoopDelay.mean = 100_000_000;
    mockEventLoopDelay.max = 100_000_000;
    mockEventLoopDelay.percentile.mockReturnValue(100_000_000);
    metrics.registerWebhookOutboxSnapshot(webhookOutboxSnapshot);
    metrics.registerWebhookPreparationSnapshot(() =>
      new WebhookPreparationAdmission(4, jest.fn()).runtimeSnapshot(),
    );
    metrics.registerDeleteReconcilerSnapshot(deleteReconcilerSnapshot);
    metrics.registerDeleteDueSweepSnapshot(deleteDueSweepSnapshot);
    metrics.registerAutomaticDeleteAuthorSnapshot(() => automaticDeleteAuthors);
    metrics.registerVkMediaAdmissionSnapshot(() => vkMediaAdmission);
    metrics.registerChatContextCacheSnapshot(() => ({
      entries: 1,
      estimatedBytes: 1,
      maxEntries: 1,
      maxBytes: 1,
      maxEntryBytes: 1,
      hits: 1,
      misses: 1,
      writes: 1,
      oversizedSkips: 1,
      capacityEvictions: 1,
      expiredEvictions: 1,
      invalidations: 1,
      sweepInspected: 1,
      activity: createChatContextCacheActivity(),
      settingsTemplates: {
        entries: 1,
        estimatedBytes: 1,
        maxEntries: 1,
        maxBytes: 1,
        maxEntryBytes: 1,
        hits: 1,
        misses: 1,
        writes: 1,
        oversizedSkips: 1,
        capacityEvictions: 1,
        fullLoads: 1,
        shellReads: 1,
        reuses: 1,
        segments: templateSegments,
      },
    }));
    metrics.registerVkPersistenceSnapshot(() => ({
      batches: 1,
      postsAttempted: 1,
      rowsWritten: 1,
      rowsSkippedOrFenced: 1,
      failedBatches: 1,
      durationBuckets: { under100Ms: 1, under500Ms: 1, under2000Ms: 1, atLeast2000Ms: 1 },
    }));
    const widen = (value: unknown, field?: string): unknown => {
      if (typeof value === 'number')
        return field === 'schemaVersion' || field === 'resolutionMs'
          ? value
          : field === 'registryOverflows'
            ? 0
            : Number.MAX_SAFE_INTEGER;
      if (value && typeof value === 'object')
        return Object.fromEntries(
          Object.entries(value).map(([key, entry]) => [key, widen(entry, key)]),
        );
      return value;
    };
    const local = metrics.getLocalSnapshot();
    expect(local?.prismaAdmission).toEqual(connectionAdmissionSnapshot());
    expect(local?.automaticDeleteAuthors).toEqual(automaticDeleteAuthors);
    expect(local?.vkMediaAdmission).toEqual(vkMediaAdmission);
    expect(local?.chatContextCache?.settingsTemplates?.segments).toEqual(templateSegments);
    const widest = widen(local);
    const encoded = JSON.stringify(widest);
    expect(Buffer.byteLength(encoded)).toBeLessThanOrEqual(STORAGE_RUNTIME_MAX_REPORT_BYTES);
    expect(sanitizeStorageRuntimeSnapshot(JSON.parse(encoded))).toEqual(widest);
    jest.spyOn(Date, 'now').mockReturnValue(Number.MAX_SAFE_INTEGER);
    mockRedis.mget.mockResolvedValueOnce([
      encoded,
      ...Array(RUNTIME_SERVICE_NAMES.length - 1).fill(null),
    ]);
    expect((await metrics.getFleetSnapshot()).services[0].snapshot).toEqual(widest);
  });
  it('publishes sanitized webhook attribution through the existing report and tolerates missing writers', async () => {
    const fixture = webhookOutboxSnapshot();
    metrics.registerWebhookOutboxSnapshot(() => ({
      ...fixture,
      payload: 'private-payload',
      stages: { ...fixture.stages, 'private-stage': {} },
    }));
    metrics.registerWebhookPreparationSnapshot(() =>
      new WebhookPreparationAdmission(4, jest.fn()).runtimeSnapshot(),
    );
    const before = metrics.getLocalSnapshot()!;
    await metrics.publish();
    expect(mockRedis.set).toHaveBeenCalledTimes(1);
    const encoded = mockRedis.set.mock.calls[0][1];
    expect(JSON.parse(encoded)).toMatchObject({
      startedAt: before.startedAt,
      webhookOutbox: fixture,
    });
    expect(encoded).not.toContain('private');
    const older = { ...before, webhookOutbox: undefined, webhookPreparation: undefined };
    expect(sanitizeStorageRuntimeSnapshot(older)).toMatchObject({
      webhookOutbox: null,
      webhookPreparation: null,
    });
    expect(
      sanitizeStorageRuntimeSnapshot({
        ...before,
        webhookOutbox: { ...fixture, selectedCount: -1 },
      }),
    ).toMatchObject({ webhookOutbox: null, webhookPreparation: before.webhookPreparation });
    metrics.registerWebhookOutboxSnapshot(() => ({
      get inFlightWorkUnits() {
        throw new Error('private');
      },
    }));
    expect(metrics.getLocalSnapshot()).toMatchObject({
      webhookOutbox: null,
      webhookPreparation: before.webhookPreparation,
    });
    metrics.registerWebhookOutboxSnapshot(() => {
      throw new Error('private');
    });
    expect(metrics.getLocalSnapshot()).toMatchObject({
      webhookOutbox: null,
      webhookPreparation: before.webhookPreparation,
    });
  });

  it('publishes only fixed reconciliation phases with the existing process epoch and report', async () => {
    const fixture = deleteReconcilerSnapshot();
    fixture.phases.privateLabel = { ...fixture.phases.dueSweep };
    metrics.registerDeleteReconcilerSnapshot(() => ({
      ...fixture,
      error: 'private-error-fixture',
      phases: {
        ...fixture.phases,
        dueSweep: { ...fixture.phases.dueSweep, payload: 'private-content-fixture' },
      },
    }));
    const before = metrics.getLocalSnapshot()!;
    await metrics.publish();
    expect(mockRedis.set).toHaveBeenCalledTimes(1);
    const encoded = mockRedis.set.mock.calls[0][1];
    const snapshot = JSON.parse(encoded);
    expect(snapshot.startedAt).toBe(before.startedAt);
    expect(Object.keys(snapshot.deleteReconciler.phases)).toEqual(STORAGE_DELETE_RECONCILER_PHASES);
    expect(snapshot.deleteReconciler.phases.dueSweep.returnedCount).toBe(0);
    expect(encoded).not.toContain('private');
    expect(Buffer.byteLength(encoded)).toBeLessThanOrEqual(STORAGE_RUNTIME_MAX_REPORT_BYTES);
  });
  it('rejects invalid reconciliation counts and allows reports from roles without this provider', () => {
    const valid = metrics.getLocalSnapshot()!;
    expect(valid.deleteReconciler).toBeNull();
    const older = Object.fromEntries(
      Object.entries(valid).filter(([field]) => field !== 'deleteReconciler'),
    );
    expect(sanitizeStorageRuntimeSnapshot(older)?.deleteReconciler).toBeNull();
    const fixture = deleteReconcilerSnapshot();
    for (const value of [-1, Infinity, NaN, '1', undefined])
      expect(
        sanitizeStorageRuntimeSnapshot({
          ...valid,
          deleteReconciler: {
            ...fixture,
            phases: {
              ...fixture.phases,
              dueSweep: { ...fixture.phases.dueSweep, returnedCount: value },
            },
          },
        }),
      ).toBeNull();
  });
  it('keeps a failing reconciliation provider independent of other local measurements', () => {
    metrics.increment('deleteLeaseChecks');
    metrics.registerDeleteReconcilerSnapshot(() => {
      throw new Error('private-error-fixture');
    });
    expect(metrics.getLocalSnapshot()).toMatchObject({
      deleteReconciler: null,
      counters: { deleteLeaseChecks: 1 },
    });
  });
  it('fails softly on Redis and on a local provider exception', async () => {
    metrics.registerChatContextCacheSnapshot(() => {
      throw new Error('private-error-fixture');
    });
    mockRedis.set.mockRejectedValueOnce(new Error('private-error-fixture'));
    await expect(metrics.publish()).resolves.toBeUndefined();
    expect(metrics.getLocalSnapshot()?.chatContextCache).toBeNull();
    mockRedis.mget.mockRejectedValueOnce(new Error('private-error-fixture'));
    await expect(metrics.getFleetSnapshot()).resolves.toMatchObject({
      available: false,
      services: [],
    });
  });
  it('marks missing, malformed, too large and stale reports as missing coverage', async () => {
    const healthy = JSON.stringify(metrics.getLocalSnapshot());
    const stale = JSON.stringify({
      ...metrics.getLocalSnapshot(),
      observedAt: Date.now() - 100_000,
    });
    const oversized = JSON.stringify({
      ...metrics.getLocalSnapshot(),
      unexpected: 'x'.repeat(STORAGE_RUNTIME_MAX_REPORT_BYTES),
    });
    expect(Buffer.byteLength(oversized)).toBeGreaterThan(STORAGE_RUNTIME_MAX_REPORT_BYTES);
    expect(sanitizeStorageRuntimeSnapshot(JSON.parse(oversized))).not.toBeNull();
    mockRedis.mget.mockResolvedValueOnce([healthy, stale, '{', oversized, ...Array(11).fill(null)]);
    const fleet = await metrics.getFleetSnapshot();
    expect(mockRedis.mget.mock.calls[0]).toHaveLength(RUNTIME_SERVICE_NAMES.length);
    expect(fleet.services[0].snapshot).not.toBeNull();
    expect(fleet.services.slice(1).every((entry) => entry.snapshot === null)).toBe(true);
  });
  it('publishes an independent process start so a restarted role cannot inherit its old counters', async () => {
    jest.spyOn(Date, 'now').mockReturnValueOnce(100_000);
    const restarted = new StorageRuntimeMetricsService(
      new ConfigService({
        APP_SERVICE_NAME: 'api-publisher',
        REDIS_URL: 'redis://127.0.0.1:6379',
      }),
    );
    try {
      expect(restarted.getLocalSnapshot()?.startedAt).toBe(100_000);
      expect(restarted.getLocalSnapshot()?.counters.deleteLeaseChecks).toBe(0);
    } finally {
      jest.restoreAllMocks();
      await restarted.onModuleDestroy();
    }
  });
  it('does not allow configuration to create arbitrary metric keys', async () => {
    const invalid = new StorageRuntimeMetricsService(
      new ConfigService({
        APP_SERVICE_NAME: 'unknown-user-value',
        REDIS_URL: 'redis://127.0.0.1:6379',
      }),
    );
    try {
      await invalid.publish();
      expect(mockRedis.set).not.toHaveBeenCalled();
    } finally {
      await invalid.onModuleDestroy();
    }
  });
  it('rejects unknown report versions without exposing their content', () => {
    expect(sanitizeStorageRuntimeSnapshot({ schemaVersion: 2, payload: 'private' })).toBeNull();
  });
  it('rejects corrupt counters and epochs rather than presenting them as zero savings', () => {
    const valid = metrics.getLocalSnapshot()!;
    for (const value of [-1, Infinity, NaN, '1', undefined])
      expect(
        sanitizeStorageRuntimeSnapshot({
          ...valid,
          counters: { ...valid.counters, deleteLeaseChecks: value },
        }),
      ).toBeNull();
    expect(sanitizeStorageRuntimeSnapshot({ ...valid, startedAt: 0 })).toBeNull();
    expect(
      sanitizeStorageRuntimeSnapshot({ ...valid, startedAt: valid.observedAt + 1 }),
    ).toBeNull();
  });
});
