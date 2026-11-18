import Redis from 'ioredis';
import { WebhookIngressMetricsService } from './webhook-ingress-metrics.service';
import {
  activityReleaseReceiptKey,
  HIGHER_PRIORITY_ACTIVITY_ACQUIRE_SCRIPT,
  HIGHER_PRIORITY_ACTIVITY_KEY,
  HIGHER_PRIORITY_ACTIVITY_LEASE_MS,
  HIGHER_PRIORITY_ACTIVITY_RELEASE_SCRIPT,
  HIGHER_PRIORITY_ACTIVITY_RENEW_MS,
  HIGHER_PRIORITY_ACTIVITY_RENEW_SCRIPT,
  retentionPriorityTrafficKey,
  RETENTION_PRIORITY_TRAFFIC_KEY_PREFIX,
  RETENTION_PRIORITY_TRAFFIC_TTL_SEC,
  HIGHER_PRIORITY_ACTIVITY_UNAVAILABLE_KEY,
} from '../max/retention-priority-admission';

type RedisMockState = {
  hashes: Map<string, Record<string, string>>;
  failReads: boolean;
  failWrites: boolean;
};

const redisState: RedisMockState = {
  hashes: new Map(),
  failReads: false,
  failWrites: false,
};

type EvalArgs = [script: string, keyCount: number, key: string, ...args: string[]];
type StopArgs = [key: string, reason: string, mode: 'NX'];

const redisInstances: Array<{
  eval: jest.Mock<ReturnType<Redis['eval']>, EvalArgs>;
  set: jest.Mock<Promise<'OK' | null>, StopArgs>;
  pipeline: jest.Mock;
  quit: jest.Mock;
}> = [];

jest.mock('ioredis', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => {
    const instance = {
      eval: jest.fn(async (script: string, _keyCount: number, key: string, ...args: string[]) => {
        if (redisState.failWrites) {
          throw new Error('redis write unavailable');
        }
        if (script.includes('MAX_HIGHER_PRIORITY_ACTIVITY_')) return 1;
        const hash = { ...(redisState.hashes.get(key) ?? {}) };
        const increment = (field: string) => {
          hash[field] = String(Number(hash[field] ?? 0) + 1);
        };
        if (script.includes('MAXIM_WEBHOOK_ROUTE_OUTCOMES_V1')) {
          for (let index = 1; index < args.length; index += 2) {
            const field = args[index];
            const count = Number(args[index + 1] ?? 0);
            if (field && count > 0) {
              hash[field] = String(Number(hash[field] ?? 0) + count);
            }
          }
          redisState.hashes.set(key, hash);
          return 1;
        }

        if (_keyCount === 2) {
          const prefix = args.shift();
          expect(prefix).toBe(RETENTION_PRIORITY_TRAFFIC_KEY_PREFIX);
          const trafficKey = retentionPriorityTrafficKey(Date.now());
          const traffic = redisState.hashes.get(trafficKey) ?? {};
          traffic.arrivals = String(Number(traffic.arrivals ?? 0) + 1);
          redisState.hashes.set(trafficKey, traffic);
        }

        const [outcome, encodedBotId, latencyBucket, rawLatencyMs, underTarget] = args;
        increment('attempted');
        increment(`bot:${encodedBotId}:attempted`);
        if (outcome === 'persisted') {
          increment('persisted');
          increment(`latency:${latencyBucket}`);
          increment(`bot:${encodedBotId}:persisted`);
          if (underTarget === '1') {
            increment('under_target');
          }
          hash.max_latency_ms = String(
            Math.max(Number(hash.max_latency_ms ?? 0), Number(rawLatencyMs)),
          );
        } else if (outcome === 'failed') {
          increment('failed');
          increment(`bot:${encodedBotId}:failed`);
        } else {
          increment('rejected');
          increment(`bot:${encodedBotId}:rejected`);
        }
        redisState.hashes.set(key, hash);
        return 1;
      }),
      set: jest.fn<Promise<'OK' | null>, StopArgs>().mockResolvedValue('OK'),
      pipeline: jest.fn(() => {
        const keys: string[] = [];
        return {
          hgetall: jest.fn((key: string) => {
            keys.push(key);
          }),
          exec: jest.fn(async () => {
            if (redisState.failReads) {
              throw new Error('redis read unavailable');
            }
            return keys.map((key) => [null, { ...(redisState.hashes.get(key) ?? {}) }]);
          }),
        };
      }),
      quit: jest.fn().mockResolvedValue(undefined),
    };
    redisInstances.push(instance);
    return instance;
  }),
}));

function createService(overrides: Record<string, unknown> = {}) {
  return new WebhookIngressMetricsService({
    getOrThrow: jest.fn().mockReturnValue('redis://localhost:6379/0'),
    get: jest.fn((key: string) => overrides[key]),
  } as never);
}

describe('WebhookIngressMetricsService', () => {
  beforeEach(() => {
    redisState.hashes.clear();
    redisState.failReads = false;
    redisState.failWrites = false;
    redisInstances.length = 0;
    jest.spyOn(Date, 'now').mockReturnValue(new Date('2026-07-11T10:00:05.000Z').getTime());
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('records fixed minute arrivals inside the existing receipt Lua command', async () => {
    const service = createService();
    await service.recordReceiptPersistence({ botId: 'major', outcome: 'persisted', latencyMs: 1 });
    expect(redisInstances[0]!.eval).toHaveBeenCalledTimes(1);
    const args = redisInstances[0]!.eval.mock.calls[0]!;
    expect(args[1]).toBe(2);
    expect(args[3]).toBe(RETENTION_PRIORITY_TRAFFIC_KEY_PREFIX);
    expect(args.at(-1)).toBe(String(RETENTION_PRIORITY_TRAFFIC_TTL_SEC));
    expect(redisState.hashes.get(retentionPriorityTrafficKey(Date.now()))).toEqual({
      arrivals: '1',
    });
    await service.onModuleDestroy();
  });

  it('keeps receipt activity until the actual operation settles after the caller stops waiting', async () => {
    const service = createService();
    let finish!: (value: number) => void;
    const operation = jest.fn(
      () =>
        new Promise<number>((resolve) => {
          finish = resolve;
        }),
    );
    const actual = service.observeReceiptWork(operation);
    await Promise.resolve();
    await Promise.resolve();
    expect(operation).toHaveBeenCalledTimes(1);
    expect(
      redisInstances[0]!.eval.mock.calls.some(([script]) =>
        String(script).includes('ACTIVITY_RELEASE'),
      ),
    ).toBe(false);
    finish(42);
    await expect(actual).resolves.toBe(42);
    expect(
      redisInstances[0]!.eval.mock.calls.some(([script]) =>
        String(script).includes('ACTIVITY_RELEASE'),
      ),
    ).toBe(true);
    await service.onModuleDestroy();
  });

  it('preserves the receipt operation when observation fails and leaves cleanup unavailable', async () => {
    const service = createService();
    redisState.failWrites = true;
    const operation = jest.fn().mockResolvedValue('persisted');
    await expect(service.observeReceiptWork(operation)).resolves.toBe('persisted');
    expect(operation).toHaveBeenCalledTimes(1);
    expect(redisInstances[0]!.set).toHaveBeenCalledWith(
      HIGHER_PRIORITY_ACTIVITY_UNAVAILABLE_KEY,
      'receipt_observation_unknown',
      'NX',
    );
    await service.onModuleDestroy();
  });

  it('returns SQL completion without waiting for slow observation release and keeps the active marker until acknowledgement', async () => {
    const service = createService();
    let active = false;
    let acknowledgeRelease!: (value: number) => void;
    redisInstances[0]!.eval.mockImplementation(async (script: string) => {
      if (script.includes('ACTIVITY_ACQUIRE')) {
        active = true;
        return 1;
      }
      if (script.includes('ACTIVITY_RELEASE')) {
        return new Promise<number>((resolve) => {
          acknowledgeRelease = (value) => {
            if (value === 1) active = false;
            resolve(value);
          };
        });
      }
      return 1;
    });
    const actual = service.observeReceiptWork(async () => 'SQL committed');
    await expect(actual).resolves.toBe('SQL committed');
    expect(active).toBe(true);
    expect(acknowledgeRelease).toBeDefined();
    acknowledgeRelease(1);
    await service.onModuleDestroy();
    expect(active).toBe(false);
  });

  it('waits for the last renewal before settling the same receipt after SQL completes', async () => {
    jest.useFakeTimers();
    try {
      const service = createService();
      const redis = redisInstances[0]!;
      let finishSql!: () => void;
      let finishRenew!: (result: number) => void;
      redis.eval.mockImplementation(async (script) => {
        if (script === HIGHER_PRIORITY_ACTIVITY_RENEW_SCRIPT)
          return new Promise<number>((resolve) => {
            finishRenew = resolve;
          });
        return 1;
      });
      const work = service.observeReceiptWork(
        () =>
          new Promise<void>((resolve) => {
            finishSql = resolve;
          }),
      );
      await jest.advanceTimersByTimeAsync(HIGHER_PRIORITY_ACTIVITY_RENEW_MS);
      const id = redis.eval.mock.calls[0]![4]!;
      expect(id).toMatch(/^receipt:/);
      expect(redis.eval).toHaveBeenCalledWith(
        HIGHER_PRIORITY_ACTIVITY_RENEW_SCRIPT,
        3,
        HIGHER_PRIORITY_ACTIVITY_KEY,
        HIGHER_PRIORITY_ACTIVITY_UNAVAILABLE_KEY,
        activityReleaseReceiptKey(id),
        id,
        String(HIGHER_PRIORITY_ACTIVITY_LEASE_MS),
      );
      finishSql();
      await work;
      expect(
        redis.eval.mock.calls.some(
          ([script]) => script === HIGHER_PRIORITY_ACTIVITY_RELEASE_SCRIPT,
        ),
      ).toBe(false);
      finishRenew(1);
      await service.onModuleDestroy();
      expect(redis.eval).toHaveBeenCalledWith(
        HIGHER_PRIORITY_ACTIVITY_RELEASE_SCRIPT,
        3,
        HIGHER_PRIORITY_ACTIVITY_KEY,
        HIGHER_PRIORITY_ACTIVITY_UNAVAILABLE_KEY,
        activityReleaseReceiptKey(id),
        id,
      );
      expect(redis.set).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it('retries a lost release reply for the same operation without repeating SQL', async () => {
    const service = createService();
    const redis = redisInstances[0]!;
    redis.eval
      .mockResolvedValueOnce(1)
      .mockRejectedValueOnce(new Error('Reply lost'))
      .mockResolvedValueOnce(1);
    const operation = jest.fn(async () => 'SQL committed');
    await expect(service.observeReceiptWork(operation)).resolves.toBe('SQL committed');
    await service.onModuleDestroy();
    const [acquire, release, retry] = redis.eval.mock.calls;
    expect(acquire?.[0]).toBe(HIGHER_PRIORITY_ACTIVITY_ACQUIRE_SCRIPT);
    const id = acquire![4]!;
    expect(release).toEqual([
      HIGHER_PRIORITY_ACTIVITY_RELEASE_SCRIPT,
      3,
      HIGHER_PRIORITY_ACTIVITY_KEY,
      HIGHER_PRIORITY_ACTIVITY_UNAVAILABLE_KEY,
      activityReleaseReceiptKey(id),
      id,
    ]);
    expect(retry).toEqual(release);
    expect(redis.eval).toHaveBeenCalledTimes(3);
    expect(operation).toHaveBeenCalledTimes(1);
    expect(redis.set).not.toHaveBeenCalled();
  });

  it('preserves a committed SQL result while failed asynchronous release blocks cleanup', async () => {
    const service = createService();
    redisInstances[0]!.eval.mockImplementation(async (script: string) => {
      if (script.includes('ACTIVITY_RELEASE')) throw new Error('Release unavailable');
      return 1;
    });
    await expect(service.observeReceiptWork(async () => 'SQL committed')).resolves.toBe(
      'SQL committed',
    );
    await service.onModuleDestroy();
    expect(redisInstances[0]!.set).toHaveBeenCalledWith(
      HIGHER_PRIORITY_ACTIVITY_UNAVAILABLE_KEY,
      'activity_release_failed',
      'NX',
    );
  });

  it('aggregates bounded persistence histograms and per-bot receipt counts', async () => {
    const service = createService({
      SYSTEM_WEBHOOK_INGRESS_SLO_TARGET_MS: 2_000,
      SYSTEM_WEBHOOK_SLO_WINDOW_SEC: 900,
    });

    await service.recordReceiptPersistence({
      botId: 'bot-1',
      outcome: 'persisted',
      latencyMs: 100,
    });
    await service.recordReceiptPersistence({
      botId: 'bot-1',
      outcome: 'persisted',
      latencyMs: 1_900,
    });
    await service.recordReceiptPersistence({
      botId: 'bot-1',
      outcome: 'persisted',
      latencyMs: 2_100,
    });
    await service.recordReceiptPersistence({
      botId: 'bot-2',
      outcome: 'persisted',
      latencyMs: 9_000,
    });
    await service.recordReceiptPersistence({ botId: 'bot-2', outcome: 'failed', latencyMs: 300 });
    await service.recordReceiptPersistence({ botId: 'bot-2', outcome: 'rejected', latencyMs: 0 });
    service.recordRouteOutcome({ botId: 'bot-1', outcome: 'accepted' });
    service.recordRouteOutcome({ botId: 'bot-2', outcome: 'invalid_payload' });
    service.recordRouteOutcome({ botId: null, outcome: 'authentication_rejected' });

    await expect(service.getSnapshot({ windowSec: 900 })).resolves.toEqual({
      available: true,
      targetMs: 2_000,
      attemptedReceipts: 6,
      persistedReceipts: 4,
      failedReceipts: 1,
      rejectedReceipts: 1,
      sampledReceipts: 4,
      p95LatencyMs: 10_000,
      p99LatencyMs: 10_000,
      underTargetRatio: 0.5,
      bots: {
        'bot-1': {
          attemptedReceipts: 3,
          persistedReceipts: 3,
          failedReceipts: 0,
          rejectedReceipts: 0,
        },
        'bot-2': {
          attemptedReceipts: 3,
          persistedReceipts: 1,
          failedReceipts: 1,
          rejectedReceipts: 1,
        },
      },
      route: {
        attemptedRequests: 3,
        outcomes: {
          accepted: 1,
          authentication_rejected: 1,
          admission_rejected: 0,
          invalid_json: 0,
          invalid_payload: 1,
          payload_too_large: 0,
          timed_out: 0,
          failed: 0,
        },
        bots: {
          'bot-1': {
            attemptedRequests: 1,
            outcomes: {
              accepted: 1,
              authentication_rejected: 0,
              admission_rejected: 0,
              invalid_json: 0,
              invalid_payload: 0,
              payload_too_large: 0,
              timed_out: 0,
              failed: 0,
            },
          },
          'bot-2': {
            attemptedRequests: 1,
            outcomes: {
              accepted: 0,
              authentication_rejected: 0,
              admission_rejected: 0,
              invalid_json: 0,
              invalid_payload: 1,
              payload_too_large: 0,
              timed_out: 0,
              failed: 0,
            },
          },
        },
      },
      membershipCache: {
        precheck: {
          hit: 0,
          miss: 0,
          failOpen: 0,
          timing: {
            sampled: 0,
            p95DurationMs: null,
            p99DurationMs: null,
            overflowSamples: 0,
          },
        },
        lua: {
          applied: 0,
          superseded: 0,
          conflict: 0,
          retry: 0,
          exhausted: 0,
          failed: 0,
          timing: {
            sampled: 0,
            p95DurationMs: null,
            p99DurationMs: null,
            overflowSamples: 0,
          },
        },
        budget: {
          completed: 0,
          timeout: 0,
          timing: {
            sampled: 0,
            p95DurationMs: null,
            p99DurationMs: null,
            overflowSamples: 0,
          },
        },
        detached: {
          completed: 0,
          timeout: 0,
          failure: 0,
          peakInFlight: 0,
          rejected: 0,
        },
      },
      membershipTransition: {
        edgeAdvance: {
          calls: 0,
          affectedRows: 0,
          noOpCalls: 0,
          timing: {
            sampled: 0,
            p95DurationMs: null,
            p99DurationMs: null,
            overflowSamples: 0,
          },
        },
      },
    });

    const metricKey = redisInstances[0]?.eval.mock.calls[0]?.[2] as string;
    expect(metricKey).toMatch(/^system:webhook-ingress:metrics:v1:2000:\d+$/u);
    expect(metricKey).not.toContain('bot-1');
    await service.onModuleDestroy();
  });

  it('aggregates privacy-safe membership cache and transition metrics', async () => {
    const service = createService();

    service.recordMembershipCacheMutation({ phase: 'precheck', outcome: 'hit', durationMs: 1 });
    service.recordMembershipCacheMutation({ phase: 'precheck', outcome: 'miss', durationMs: 2 });
    service.recordMembershipCacheMutation({
      phase: 'precheck',
      outcome: 'fail_open',
      durationMs: 100,
    });
    service.recordMembershipCacheMutation({ phase: 'lua', outcome: 'applied', durationMs: 5 });
    service.recordMembershipCacheMutation({
      phase: 'lua',
      outcome: 'superseded',
      durationMs: 10,
    });
    service.recordMembershipCacheMutation({ phase: 'lua', outcome: 'conflict', durationMs: 20 });
    service.recordMembershipCacheMutation({ phase: 'lua', outcome: 'retry' });
    service.recordMembershipCacheMutation({ phase: 'lua', outcome: 'exhausted' });
    service.recordMembershipCacheMutation({ phase: 'lua', outcome: 'failed', durationMs: 35 });
    service.recordMembershipCacheBudget({ outcome: 'completed', durationMs: 75 });
    service.recordMembershipCacheBudget({ outcome: 'timeout', durationMs: 100 });
    service.recordMembershipCacheDetachedWork({ outcome: null, inFlight: 2 });
    service.recordMembershipCacheDetachedWork({ outcome: 'timeout', inFlight: 2 });
    service.recordMembershipCacheDetachedWork({ outcome: 'completed', inFlight: 1 });
    service.recordMembershipCacheDetachedWork({ outcome: 'failure', inFlight: 0 });
    service.recordMembershipCacheDetachedWork({ outcome: 'rejected', inFlight: 0, count: 2 });
    service.recordMembershipAccessEdgeAdvance({ durationMs: 5, affectedRows: 3 });
    service.recordMembershipAccessEdgeAdvance({ durationMs: 150, affectedRows: 0 });

    await expect(service.getSnapshot({ windowSec: 900 })).resolves.toMatchObject({
      membershipCache: {
        precheck: {
          hit: 1,
          miss: 1,
          failOpen: 1,
          timing: { sampled: 3, p95DurationMs: 100, p99DurationMs: 100 },
        },
        lua: {
          applied: 1,
          superseded: 1,
          conflict: 1,
          retry: 1,
          exhausted: 1,
          failed: 1,
          timing: { sampled: 4, p95DurationMs: 35, p99DurationMs: 35 },
        },
        budget: {
          completed: 1,
          timeout: 1,
          timing: { sampled: 2, p95DurationMs: 100, p99DurationMs: 100 },
        },
        detached: {
          completed: 1,
          timeout: 1,
          failure: 1,
          peakInFlight: 2,
          rejected: 2,
        },
      },
      membershipTransition: {
        edgeAdvance: {
          calls: 2,
          affectedRows: 3,
          noOpCalls: 1,
          timing: { sampled: 2, p95DurationMs: 150, p99DurationMs: 150 },
        },
      },
    });

    const bufferedMetricCall = redisInstances[0]?.eval.mock.calls.find((call) =>
      String(call[0]).includes('MAXIM_WEBHOOK_ROUTE_OUTCOMES_V1'),
    );
    expect(JSON.stringify(bufferedMetricCall)).not.toMatch(/chat-|user-|update-|payload/iu);
    await service.onModuleDestroy();
  });

  it('reports Redis read failure without throwing into the dashboard path', async () => {
    const service = createService();
    redisState.failReads = true;

    await expect(service.getSnapshot({ windowSec: 900 })).resolves.toMatchObject({
      available: false,
      targetMs: 2_000,
      attemptedReceipts: 0,
      failedReceipts: 0,
      rejectedReceipts: 0,
      p99LatencyMs: null,
      route: { attemptedRequests: 0 },
    });
    await service.onModuleDestroy();
  });

  it('bounds Redis commands and the number of metric buckets read', async () => {
    const service = createService({ SYSTEM_WEBHOOK_SLO_WINDOW_SEC: Number.MAX_SAFE_INTEGER });

    await expect(
      service.getSnapshot({ windowSec: Number.MAX_SAFE_INTEGER }),
    ).resolves.toMatchObject({ available: true });

    const redis = Redis as unknown as jest.Mock;
    expect(redis).toHaveBeenCalledWith('redis://localhost:6379/0', {
      commandTimeout: 100,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
    });
    const pipeline = redisInstances[0]?.pipeline.mock.results[0]?.value as {
      hgetall: jest.Mock;
    };
    expect(pipeline.hgetall).toHaveBeenCalledTimes(8_641);
    await service.onModuleDestroy();
  });

  it('swallows Redis write failures so metric recording cannot affect webhook ACK', async () => {
    const service = createService();
    redisState.failWrites = true;

    await expect(
      service.recordReceiptPersistence({
        botId: 'bot-1',
        outcome: 'persisted',
        latencyMs: 120,
      }),
    ).resolves.toBeUndefined();
    expect(redisInstances[0]!.set).toHaveBeenCalledWith(
      HIGHER_PRIORITY_ACTIVITY_UNAVAILABLE_KEY,
      'receipt_counter_unknown',
      'NX',
    );
    service.recordRouteOutcome({ botId: null, outcome: 'authentication_rejected' });
    await expect(service.getSnapshot({ windowSec: 900 })).resolves.toMatchObject({
      available: true,
      route: { attemptedRequests: 0 },
    });
    expect(redisState.hashes.size).toBe(0);
    await service.onModuleDestroy();
  });

  it('creates Redis keys without bot ids, tokens, or webhook secrets', async () => {
    const service = createService();
    await service.recordReceiptPersistence({
      botId: 'public-bot-id',
      outcome: 'persisted',
      latencyMs: 25,
    });

    const redis = Redis as unknown as jest.Mock;
    expect(redis).toHaveBeenCalledWith('redis://localhost:6379/0', {
      commandTimeout: 100,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
    });
    const key = redisInstances[0]?.eval.mock.calls[0]?.[2] as string;
    expect(key).toBe('system:webhook-ingress:metrics:v1:2000:178376400');
    expect(key).not.toContain('public-bot-id');
    await service.onModuleDestroy();
  });
});
