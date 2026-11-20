import { WebhookSubscriptionStatusService } from './webhook-subscription-status.service';
import { MAX_REQUIRED_WEBHOOK_UPDATE_TYPES } from '../max/max-webhook-subscription.constants';

type RedisMock = {
  status: string;
  get: jest.Mock<Promise<string | null>, [string]>;
  set: jest.Mock<Promise<'OK'>, [string, string]>;
  hgetall: jest.Mock<Promise<Record<string, string>>, [string]>;
  eval: jest.Mock<Promise<number>, [string, number, string, string, string]>;
  quit: jest.Mock<Promise<void>, []>;
  strings: Map<string, string>;
  hashes: Map<string, Record<string, string>>;
};

const redisInstances: RedisMock[] = [];

jest.mock('ioredis', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => {
    const strings = new Map<string, string>();
    const hashes = new Map<string, Record<string, string>>();
    const instance: RedisMock = {
      status: 'ready',
      strings,
      hashes,
      get: jest.fn(async (key) => strings.get(key) ?? null),
      set: jest.fn(async (key, value) => {
        strings.set(key, value);
        return 'OK' as const;
      }),
      hgetall: jest.fn(async (key) => ({ ...(hashes.get(key) ?? {}) })),
      eval: jest.fn(async (_script, _keyCount, key, botField, incomingValue) => {
        const hash = { ...(hashes.get(key) ?? {}) };
        const incoming = Number(incomingValue);
        hash[botField] = String(Math.max(Number(hash[botField] ?? 0), incoming));
        hash.global = String(Math.max(Number(hash.global ?? 0), incoming));
        hashes.set(key, hash);
        return 1;
      }),
      quit: jest.fn().mockResolvedValue(undefined),
    };
    redisInstances.push(instance);
    return instance;
  }),
}));

describe('WebhookSubscriptionStatusService', () => {
  beforeEach(() => {
    redisInstances.length = 0;
  });

  it('uses the extended event list in a pending shadow snapshot', async () => {
    const service = new WebhookSubscriptionStatusService({
      getOrThrow: jest.fn().mockReturnValue('redis://localhost:6379/0'),
      get: jest.fn().mockReturnValue('shadow'),
    } as never);

    expect(service.createPendingSnapshot()).toEqual(
      expect.objectContaining({
        requiredUpdateTypes: [...MAX_REQUIRED_WEBHOOK_UPDATE_TYPES],
        missingUpdateTypes: [...MAX_REQUIRED_WEBHOOK_UPDATE_TYPES],
      }),
    );

    await service.onModuleDestroy();
  });

  it('uses the extended event list when on is selected', async () => {
    const service = new WebhookSubscriptionStatusService({
      getOrThrow: jest.fn().mockReturnValue('redis://localhost:6379/0'),
      get: jest.fn().mockReturnValue('on'),
    } as never);

    expect(service.createPendingSnapshot()).toEqual(
      expect.objectContaining({
        requiredUpdateTypes: [...MAX_REQUIRED_WEBHOOK_UPDATE_TYPES],
        missingUpdateTypes: [...MAX_REQUIRED_WEBHOOK_UPDATE_TYPES],
      }),
    );

    await service.onModuleDestroy();
  });

  it('distinguishes absent state from a failed read or invalid persisted configuration', async () => {
    const service = new WebhookSubscriptionStatusService({
      getOrThrow: jest.fn().mockReturnValue('redis://localhost:6379/0'),
    } as never);
    const redis = redisInstances[0]!;
    await expect(service.getSyncState()).resolves.toBeNull();
    redis.hgetall.mockRejectedValueOnce(new Error('Redis unavailable'));
    await expect(service.getSyncState()).rejects.toThrow('Redis unavailable');
    redis.strings.set('system:webhook-subscription:sync-state:v1', '{');
    await expect(service.getSyncState()).rejects.toBeInstanceOf(SyntaxError);
    await service.onModuleDestroy();
  });

  it('atomically keeps the newest per-bot and global ingress timestamp', async () => {
    const service = new WebhookSubscriptionStatusService({
      getOrThrow: jest.fn().mockReturnValue('redis://localhost:6379/0'),
    } as never);
    const newerAt = '2026-07-10T12:00:00.456Z';
    const olderAt = '2026-07-10T11:59:59.123Z';

    await service.markIncomingWebhook('bot-1', newerAt);
    await service.markIncomingWebhook('bot-1', olderAt);

    await expect(service.getSyncState()).resolves.toEqual(
      expect.objectContaining({
        bots: expect.objectContaining({
          'bot-1': expect.objectContaining({
            lastIncomingWebhookAt: newerAt,
          }),
        }),
        lastGlobalIncomingWebhookAt: newerAt,
      }),
    );
    expect(redisInstances[0]?.eval).toHaveBeenCalledTimes(2);

    await service.onModuleDestroy();
  });

  it('coalesces confirmed receipt times per bot during disconnects and pending Redis writes', async () => {
    jest.useFakeTimers();
    const service = new WebhookSubscriptionStatusService({
      getOrThrow: () => 'redis://localhost',
    } as never);
    const redis = redisInstances[0]!;
    let release!: (result: number) => void;
    const blocked = new Promise<number>((resolve) => {
      release = resolve;
    });
    try {
      const base = Date.now();
      redis.status = 'reconnecting';
      for (let n = 0; n < 100; n++) service.recordIncomingWebhook('bot-1', base + n);
      await jest.advanceTimersByTimeAsync(250);
      expect(redis.eval).not.toHaveBeenCalled();
      redis.status = 'ready';
      redis.eval.mockImplementationOnce(() => blocked);
      await jest.advanceTimersByTimeAsync(2_000);
      expect(redis.eval.mock.calls.map((args) => args.slice(3))).toEqual([
        ['bot:bot-1', String(base + 99)],
      ]);
      for (let n = 0; n < 100; n++) service.recordIncomingWebhook('bot-1', base + 100 + n);
      service.recordIncomingWebhook('bot-2', base + 50);
      await jest.advanceTimersByTimeAsync(2_000);
      expect(redis.eval).toHaveBeenCalledTimes(1);
      release(1);
      await service.onModuleDestroy();
      expect(redis.eval.mock.calls.slice(1).map((args) => args.slice(3))).toEqual([
        ['bot:bot-1', String(base + 199)],
        ['bot:bot-2', String(base + 50)],
      ]);
    } finally {
      release(1);
      jest.useRealTimers();
    }
  });

  it('retains subscription configuration but trusts only atomic ingress over old or newer snapshot times', async () => {
    const service = new WebhookSubscriptionStatusService({
      getOrThrow: jest.fn().mockReturnValue('redis://localhost:6379/0'),
    } as never);
    const redis = redisInstances[0]!;
    redis.strings.set(
      'system:webhook-subscription:sync-state:v1',
      JSON.stringify({
        bots: {
          'bot-1': {
            configuredUrl: 'https://example.test/webhook',
            headerSecretFingerprint: 'fingerprint',
            updatedAt: '2026-07-10T10:00:00.000Z',
            lastIncomingWebhookAt: '2026-07-11T10:00:00.000Z',
            lastAutoRecreateAt: null,
          },
        },
        lastGlobalIncomingWebhookAt: '2026-07-11T10:00:00.000Z',
        lastGlobalAutoRecreateAt: null,
      }),
    );

    await expect(service.getSyncState()).resolves.toMatchObject({
      bots: {
        'bot-1': { configuredUrl: 'https://example.test/webhook', lastIncomingWebhookAt: null },
      },
      lastGlobalIncomingWebhookAt: null,
    });
    await service.markIncomingWebhook('bot-1', '2026-07-10T12:00:00.789Z');

    await expect(service.getSyncState()).resolves.toEqual(
      expect.objectContaining({
        bots: expect.objectContaining({
          'bot-1': expect.objectContaining({
            configuredUrl: 'https://example.test/webhook',
            lastIncomingWebhookAt: '2026-07-10T12:00:00.789Z',
          }),
        }),
        lastGlobalIncomingWebhookAt: '2026-07-10T12:00:00.789Z',
      }),
    );

    await service.onModuleDestroy();
  });
});
