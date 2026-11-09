import { RuntimeDiagnosticsService } from './runtime-diagnostics.service';
import { OptimizationRuntimeMetrics } from './optimization-runtime-metrics';
import type { StorageRuntimeMetricsService } from './storage-runtime-metrics.service';
import {
  RULE_COVERAGE_FAMILIES,
  createRuleEngineObservation,
} from '../moderation/rule-engine-observation';

type RedisHashes = Map<string, Record<string, string>>;

const redisInstances: Array<{
  hashes: RedisHashes;
  strings: Map<string, string>;
  scan: jest.Mock;
  pipeline: jest.Mock;
  quit: jest.Mock<Promise<void>, []>;
}> = [];

function createPipeline(hashes: RedisHashes) {
  const commands: Array<{
    kind: 'hincrby' | 'hset' | 'hgetall' | 'expire';
    args: unknown[];
  }> = [];
  const pipeline = {
    hincrby: (...args: [string, string, number]) => pipelineImpl.hincrby(...args),
    hset: (...args: [string, string, string]) => pipelineImpl.hset(...args),
    hgetall: (...args: [string]) => pipelineImpl.hgetall(...args),
    expire: (...args: [string, number]) => pipelineImpl.expire(...args),
    exec: () => pipelineImpl.exec(),
  };
  const pipelineImpl = {
    hincrby: jest.fn((...args: [string, string, number]) => {
      commands.push({ kind: 'hincrby', args });
      return pipeline;
    }),
    hset: jest.fn((...args: [string, string, string]) => {
      commands.push({ kind: 'hset', args });
      return pipeline;
    }),
    hgetall: jest.fn((...args: [string]) => {
      commands.push({ kind: 'hgetall', args });
      return pipeline;
    }),
    expire: jest.fn((...args: [string, number]) => {
      commands.push({ kind: 'expire', args });
      return pipeline;
    }),
    exec: jest.fn(async () =>
      commands.map((command) => {
        if (command.kind === 'hincrby') {
          const [key, field, increment] = command.args as [string, string, number];
          const current = { ...(hashes.get(key) ?? {}) };
          const nextValue = Number(current[field] ?? '0') + increment;
          current[field] = String(nextValue);
          hashes.set(key, current);
          return [null, nextValue] as const;
        }
        if (command.kind === 'hset') {
          const [key, field, value] = command.args as [string, string, string];
          const current = { ...(hashes.get(key) ?? {}) };
          current[field] = value;
          hashes.set(key, current);
          return [null, 1] as const;
        }
        if (command.kind === 'hgetall') {
          const [key] = command.args as [string];
          return [null, { ...(hashes.get(key) ?? {}) }] as const;
        }
        return [null, 1] as const;
      }),
    ),
  };

  return pipeline;
}

jest.mock('ioredis', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => {
    const hashes: RedisHashes = new Map();
    const strings = new Map<string, string>();
    const instance = {
      hashes,
      strings,
      get: jest.fn(async (key: string) => strings.get(key) ?? null),
      set: jest.fn(async (key: string, value: string) => {
        strings.set(key, value);
        return 'OK';
      }),
      hget: jest.fn(async (key: string, field: string) => hashes.get(key)?.[field] ?? null),
      hmget: jest.fn(async (key: string, ...fields: string[]) =>
        fields.map((field) => hashes.get(key)?.[field] ?? null),
      ),
      mget: jest.fn(async (...keys: string[]) => keys.map((key) => strings.get(key) ?? null)),
      scan: jest.fn(async () => ['0', []]),
      pipeline: jest.fn(() => createPipeline(hashes)),
      quit: jest.fn().mockResolvedValue(undefined),
    };
    redisInstances.push(instance);
    return instance;
  }),
}));

function createConfigMock(values: Record<string, string | number | undefined> = {}) {
  return {
    get: jest.fn((key: string) => values[key]),
    getOrThrow: jest.fn((key: string) => {
      if (key === 'REDIS_URL') {
        return 'redis://localhost:6379/0';
      }
      throw new Error(`Missing key ${key}`);
    }),
  };
}

describe('RuntimeDiagnosticsService', () => {
  it('records rule timing and coverage locally even when Redis diagnostics is unavailable', async () => {
    const optimization = new OptimizationRuntimeMetrics();
    const provider: Pick<StorageRuntimeMetricsService, 'optimization'> = { optimization };
    const service = new RuntimeDiagnosticsService(
      createConfigMock() as never,
      provider as StorageRuntimeMetricsService,
    );
    const redis = redisInstances.at(-1)!;
    redis.pipeline.mockImplementationOnce(() => {
      throw new Error('unavailable');
    });
    const observation = createRuleEngineObservation();
    const links = observation.family('links');
    links.configured(true);
    links.eligible();
    links.finish({ kind: 'evaluated', matched: false });
    await expect(
      service.recordHotPathProfile({
        snapshot: {
          ruleCoverage: observation.close(),
          stageDurations: {
            'rule-engine.links': 320,
            'rule-engine.stop-words-policy': 4,
            'rule-engine.private-dimension': 1000,
            'chat-context': 200,
          },
        },
      }),
    ).rejects.toThrow('unavailable');
    expect(optimization.snapshot()!.ruleStages!.links).toMatchObject({ calls: 1, totalMs: 320 });
    expect(optimization.snapshot()!.ruleSharedStages!['stop-words-policy']).toMatchObject({
      calls: 1,
      totalMs: 4,
    });
    expect(
      optimization.snapshot()!.ruleCoverage!.rows[RULE_COVERAGE_FAMILIES.indexOf('links')],
    ).toEqual([1, 1, 1, 0, 0, 0, 0, 0, 0, 0]);
    expect(JSON.stringify(optimization.snapshot())).not.toContain('private-dimension');
    await service.onModuleDestroy();
  });
  it('records coverage without a Redis exchange when no stage duration exists', async () => {
    const optimization = new OptimizationRuntimeMetrics();
    const provider: Pick<StorageRuntimeMetricsService, 'optimization'> = { optimization };
    const service = new RuntimeDiagnosticsService(
      createConfigMock() as never,
      provider as StorageRuntimeMetricsService,
    );
    const observation = createRuleEngineObservation();
    const coverage = observation.close(true);
    await service.recordHotPathProfile({ snapshot: { ruleCoverage: coverage } });
    expect(optimization.snapshot()!.ruleCoverage).toEqual(coverage);
    expect(redisInstances.at(-1)!.pipeline).not.toHaveBeenCalled();
    await service.recordHotPathProfile({
      snapshot: { ruleCoverage: coverage },
      stagePrefix: 'other.',
    });
    expect(optimization.snapshot()!.ruleCoverage).toEqual(coverage);
    await service.onModuleDestroy();
  });
  beforeEach(() => {
    redisInstances.length = 0;
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('separates nine-bot deliveries, logical creations, edits and executions', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-06-21T12:00:00.000Z'));
    const service = new RuntimeDiagnosticsService(createConfigMock() as never);
    try {
      for (const eventType of ['message_created', 'message_edited']) {
        for (let bot = 0; bot < 9; bot += 1) {
          await service.recordHotChatActivity({
            chatId: '-123',
            botId: `bot-${bot}`,
            eventType,
            stage: 'RECEIPT',
          });
          if (bot > 0)
            await service.recordHotChatActivity({
              chatId: '-123',
              botId: `bot-${bot}`,
              eventType,
              stage: 'MIRROR',
            });
        }
        await service.recordHotChatMessage({ chatId: '-123', botId: 'bot-8', eventType });
      }
      await service.recordHotChatActivity({
        chatId: '-123',
        eventType: 'message_callback',
        stage: 'RECEIPT',
      });
      const snapshot = await service.getDashboardSnapshot();
      expect(snapshot.hotChats.items[0]).toMatchObject({
        chatId: '-123',
        messageCreatedCount: 1,
        messageEditedCount: 1,
        executionCount: 2,
        deliveryCount: 18,
        mirrorCount: 16,
      });
    } finally {
      await service.onModuleDestroy();
    }
  });

  it('keeps readiness diagnostics on fixed-key Redis reads', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-06-21T12:00:00.000Z'));
    const service = new RuntimeDiagnosticsService(createConfigMock() as never);

    await service.recordQueueLagSnapshot({
      queues: {
        effectiveLagSec: 3,
        userFacingEffectiveLagSec: 3,
        generatedAt: '2026-06-21T12:00:00.000Z',
        bots: {},
      },
      mode: {
        mode: 'degrade',
        reason: 'queue lag',
      },
    });

    const redis = redisInstances.at(-1)!;
    const snapshot = await service.getReadinessSnapshot();

    expect(snapshot.burst).toEqual(
      expect.objectContaining({
        active: true,
        peakLagSec: 3,
      }),
    );
    expect(redis.scan).not.toHaveBeenCalled();

    await service.onModuleDestroy();
  });

  it('aggregates spammer read-model rollout health counters', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-06-21T12:00:00.000Z'));
    const service = new RuntimeDiagnosticsService(
      createConfigMock({
        SYSTEM_RUNTIME_DIAGNOSTICS_SPAMMER_READ_MODEL_WINDOW_SEC: 900,
      }) as never,
    );

    await service.recordSpammerReadModelEvent({ event: 'profile_read_hit' });
    await service.recordSpammerReadModelEvent({ event: 'profile_read_hit' });
    await service.recordSpammerReadModelEvent({ event: 'profile_read_miss' });
    await service.recordSpammerReadModelEvent({ event: 'profile_read_stale' });
    await service.recordSpammerReadModelEvent({ event: 'fallback_after_profile_miss' });
    await service.recordSpammerReadModelEvent({ event: 'shadow_compared' });
    await service.recordSpammerReadModelEvent({ event: 'shadow_matched' });
    await service.recordSpammerReadModelEvent({ event: 'shadow_compared' });
    await service.recordSpammerReadModelEvent({ event: 'shadow_mismatched' });
    await service.recordSpammerReadModelEvent({ event: 'shadow_score_drift' });
    await service.recordSpammerReadModelEvent({ event: 'profile_write_success' });
    await service.recordSpammerReadModelEvent({ event: 'profile_write_failure' });
    await service.recordSpammerReadModelEvent({
      event: 'denorm_job_enqueued',
    });
    await service.recordSpammerReadModelEvent({
      event: 'denorm_job_enqueue_failed',
    });
    await service.recordSpammerReadModelEvent({
      event: 'denorm_fast_path_enqueued',
    });
    await service.recordSpammerReadModelEvent({
      event: 'denorm_fast_path_fallback',
    });
    await service.recordSpammerReadModelEvent({
      event: 'denorm_fast_path_replayed',
    });
    await service.recordSpammerReadModelEvent({
      event: 'denorm_fast_path_replay_missing',
    });
    await service.recordSpammerReadModelEvent({
      event: 'denorm_job_processed',
      jobAgeMs: 1_000,
    });
    await service.recordSpammerReadModelEvent({
      event: 'denorm_job_failed',
      jobAgeMs: 3_000,
    });

    const snapshot = await service.getDashboardSnapshot();

    expect(snapshot.spammerReadModel).toEqual({
      windowSec: 900,
      profileReads: {
        hits: 2,
        misses: 1,
        stale: 1,
        fallbacks: 1,
        hitRate: 0.5,
      },
      shadow: {
        compared: 2,
        matched: 1,
        mismatched: 1,
        scoreDrift: 1,
        scoreDriftRate: 0.5,
        mismatchRate: 0.5,
      },
      profileWrites: {
        success: 1,
        failure: 1,
      },
      denormJobs: {
        enqueued: 1,
        enqueueFailed: 1,
        fastPathEnqueued: 1,
        fastPathFallbacks: 1,
        fastPathReplayed: 1,
        fastPathReplayMissing: 1,
        processed: 1,
        failed: 1,
        avgAgeMs: 2_000,
        maxAgeMs: 3_000,
        lastSuccessAt: '2026-06-21T12:00:00.000Z',
        lastFailureAt: '2026-06-21T12:00:00.000Z',
      },
    });

    await service.onModuleDestroy();
  });

  it('aggregates spammer admin surface timing percentiles', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-06-21T12:00:00.000Z'));
    const service = new RuntimeDiagnosticsService(
      createConfigMock({
        SYSTEM_RUNTIME_DIAGNOSTICS_SPAMMER_SURFACE_WINDOW_SEC: 900,
      }) as never,
    );

    await service.recordSpammerSurfaceTiming({
      surface: 'spammer-review',
      timings: {
        assertAdmin: 12,
        queue: 220,
        profile: 35,
        zodParse: 8,
        total: 275,
      },
    });
    await service.recordSpammerSurfaceTiming({
      surface: 'spammer-review',
      timings: {
        assertAdmin: 20,
        queue: 480,
        total: 540,
      },
    });
    await service.recordSpammerSurfaceTiming({
      surface: 'spammer-diagnostics',
      timings: {
        diagnostics: 1_250,
        profile: 15,
        total: 1_310,
      },
    });

    const snapshot = await service.getDashboardSnapshot();

    expect(snapshot.spammerSurfaces).toEqual({
      windowSec: 900,
      timings: expect.arrayContaining([
        expect.objectContaining({
          surface: 'spammer-review',
          stage: 'total',
          count: 2,
          avgMs: 407.5,
          p95Ms: 750,
          p99Ms: 750,
          maxMs: 540,
          lastObservedAt: '2026-06-21T12:00:00.000Z',
        }),
        expect.objectContaining({
          surface: 'spammer-diagnostics',
          stage: 'diagnostics',
          count: 1,
          avgMs: 1_250,
          p95Ms: 1_500,
          p99Ms: 1_500,
          maxMs: 1_250,
          lastObservedAt: '2026-06-21T12:00:00.000Z',
        }),
      ]),
    });

    await service.onModuleDestroy();
  });
});
