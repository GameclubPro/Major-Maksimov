import Redis from 'ioredis';

jest.mock('ioredis', () => {
  const store = new Map<string, string>();
  const subscribers = new Set<(channel: string, payload: string) => void>();
  type OrderedSnapshot = {
    checkedAtMs: number;
    probeStartedAtMs: number;
    writerPolicy: string;
  };
  const shouldApplySnapshot = (
    currentRaw: string | null,
    incoming: OrderedSnapshot,
    strictPolicy: string,
  ): boolean => {
    if (!currentRaw) {
      return true;
    }

    try {
      const current = JSON.parse(currentRaw) as Partial<OrderedSnapshot>;
      if (typeof current.checkedAtMs !== 'number') {
        return true;
      }
      if (
        typeof current.probeStartedAtMs !== 'number' ||
        typeof current.writerPolicy !== 'string'
      ) {
        return incoming.checkedAtMs >= current.checkedAtMs;
      }

      const incomingIsStrict = incoming.writerPolicy === strictPolicy;
      const currentIsStrict = current.writerPolicy === strictPolicy;
      if (incomingIsStrict && !currentIsStrict) {
        return incoming.checkedAtMs >= current.probeStartedAtMs;
      }
      if (!incomingIsStrict && currentIsStrict) {
        return incoming.probeStartedAtMs > current.checkedAtMs;
      }
      return (
        incoming.probeStartedAtMs > current.probeStartedAtMs ||
        (incoming.probeStartedAtMs === current.probeStartedAtMs &&
          incoming.checkedAtMs >= current.checkedAtMs)
      );
    } catch {
      return true;
    }
  };
  const createInstance = () => {
    const messageHandlers = new Set<(channel: string, payload: string) => void>();
    const instance = {
      get: jest.fn().mockImplementation(async (key: string) => store.get(key) ?? null),
      mget: jest
        .fn()
        .mockImplementation(async (...keys: string[]) => keys.map((key) => store.get(key) ?? null)),
      set: jest.fn().mockImplementation(async (key: string, value: string) => {
        store.set(key, value);
        return 'OK';
      }),
      eval: jest
        .fn()
        .mockImplementation(
          async (_script: string, numberOfKeys: number, ...args: Array<string | number>) => {
            const keys = args.slice(0, numberOfKeys).map(String);
            if (_script.includes('membership-cache-invalidation-v1')) {
              const invalidatedAtMs = Number(args[numberOfKeys]);
              const fenceSuffix = String(args[numberOfKeys + 2]);
              const channel = String(args[numberOfKeys + 3]);
              const payload = String(args[numberOfKeys + 4]);
              for (const key of keys) {
                store.delete(key);
                const fenceKey = `${key}${fenceSuffix}`;
                const currentInvalidatedAtMs = Number(store.get(fenceKey) ?? 0);
                store.set(fenceKey, String(Math.max(currentInvalidatedAtMs, invalidatedAtMs)));
              }
              for (const subscriber of subscribers) {
                subscriber(channel, payload);
              }
              return keys.length;
            }

            const serializedSnapshot = String(args[numberOfKeys]);
            const strictPolicy = String(args[numberOfKeys + 2]);
            const fenceSuffix = String(args[numberOfKeys + 3]);
            const incoming = JSON.parse(serializedSnapshot) as OrderedSnapshot;
            return keys.map((key) => {
              const invalidatedAtMs = Number(store.get(`${key}${fenceSuffix}`) ?? 0);
              if (incoming.probeStartedAtMs <= invalidatedAtMs) {
                return 0;
              }
              if (!shouldApplySnapshot(store.get(key) ?? null, incoming, strictPolicy)) {
                return 0;
              }
              store.set(key, serializedSnapshot);
              return 1;
            });
          },
        ),
      del: jest.fn().mockImplementation(async (...keys: string[]) => {
        let deleted = 0;
        for (const key of keys) {
          if (store.delete(key)) {
            deleted += 1;
          }
        }
        return deleted;
      }),
      publish: jest.fn().mockImplementation(async (channel: string, payload: string) => {
        for (const subscriber of subscribers) {
          subscriber(channel, payload);
        }
        return subscribers.size;
      }),
      subscribe: jest.fn().mockResolvedValue(1),
      on: jest.fn().mockImplementation((event: string, handler: unknown) => {
        if (event === 'message' && typeof handler === 'function') {
          const messageHandler = handler as (channel: string, payload: string) => void;
          messageHandlers.add(messageHandler);
          subscribers.add(messageHandler);
        }
        return instance;
      }),
      duplicate: jest.fn().mockImplementation(() => createInstance()),
      quit: jest.fn().mockImplementation(async () => {
        for (const handler of messageHandlers) {
          subscribers.delete(handler);
        }
        messageHandlers.clear();
      }),
    };

    return instance;
  };

  const RedisMock = Object.assign(
    jest.fn().mockImplementation(() => {
      const instance = {
        ...createInstance(),
      };
      return instance;
    }),
    {
      __store: store,
      __subscribers: subscribers,
    },
  );

  return {
    __esModule: true,
    default: RedisMock,
  };
});

import {
  isMaxMembershipLookupLocalQuotaResolution,
  MaxMembershipLookupService,
} from './max-membership-lookup.service';
import { MaxApiInternalRateLimitError, type MaxClientService } from './max-client.service';
import { MaxModerationApiBudgetError } from './max-moderation-api-budget';
import type { MaxBotLinkService } from './max-bot-link.service';
import {
  markMaxMemberMutationAttempted,
  markMaxMemberMutationConfirmed,
} from './max-member-error.util';
import { markMaxMessageSendAttempted } from './max-mutation-outcome.util';

function createConfigMock(overrides: Partial<Record<string, number | string | boolean>> = {}) {
  return {
    getOrThrow: jest.fn((key: string) => {
      if (key === 'REDIS_URL') {
        return 'redis://localhost:6379/0';
      }

      throw new Error(`Unexpected config key ${key}`);
    }),
    get: jest.fn((key: string, fallback?: unknown) => {
      if (key in overrides) {
        return overrides[key];
      }
      if (key === 'MAX_MEMBERSHIP_LOOKUP_BATCH_WINDOW_MS') {
        return 0;
      }
      return fallback;
    }),
  };
}

function readRedisMembershipSnapshot(cacheKey: string): {
  isMember: boolean;
  checkedAtMs: number;
} | null {
  const raw = (Redis as unknown as { __store: Map<string, string> }).__store.get(cacheKey);
  return raw ? (JSON.parse(raw) as { isMember: boolean; checkedAtMs: number }) : null;
}

function publishMembershipInvalidation(chatId: string, userIds: string[]): void {
  const payload = JSON.stringify({ chatId, userIds, invalidatedAtMs: Date.now() });
  for (const subscriber of (
    Redis as unknown as { __subscribers: Set<(channel: string, payload: string) => void> }
  ).__subscribers) {
    subscriber('max:membership:invalidate:v1', payload);
  }
}

function readMembershipEpochState(service: MaxMembershipLookupService) {
  return service as unknown as {
    cacheEpochs: Map<string, { epoch: number; expiresAtMs: number }>;
    activeCacheEpochReaders: Map<string, number>;
    cacheEpochSweepIterator: IterableIterator<unknown> | null;
    cacheEpochSweepRemaining: number;
  };
}

function readMembershipMemoryState(service: MaxMembershipLookupService) {
  type Snapshot = { isMember: boolean; checkedAtMs: number };
  return service as unknown as {
    memoryCache: Map<string, Snapshot>;
    memoryCacheSweepIterator: IterableIterator<unknown> | null;
    memoryCacheSweepRemaining: number;
    memoryCacheSweepTimer: NodeJS.Timeout | null;
    storeMemorySnapshot(key: string, snapshot: Snapshot): Snapshot;
  };
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe('MaxMembershipLookupService', () => {
  beforeEach(() => {
    (Redis as unknown as { __store: Map<string, string> }).__store.clear();
    (
      Redis as unknown as { __subscribers: Set<(channel: string, payload: string) => void> }
    ).__subscribers.clear();
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.clearAllMocks();
  });

  it.each([403, 404, 503])(
    'keeps opaque %s scoped to its token and permits a healthy peer',
    async (status) => {
      const max = {
        getChatMembersAccess: jest
          .fn()
          .mockRejectedValueOnce({ response: { status } })
          .mockResolvedValueOnce(new Map([['user', { userId: 'user' }]])),
      };
      const link = { recordBotAccessProbe: jest.fn() };
      const service = new MaxMembershipLookupService(
        max as never,
        createConfigMock() as never,
        link as never,
      );
      await expect(
        service.getMembership('channel', 'user', 'moderation_required_subscription', {
          botId: 'a',
          forceRefresh: true,
          allowStaleOnError: false,
        }),
      ).resolves.toBeNull();
      await expect(
        service.getMembership('channel', 'user', 'moderation_required_subscription', {
          botId: 'b',
          forceRefresh: true,
          allowStaleOnError: false,
        }),
      ).resolves.toBe(true);
      expect(link.recordBotAccessProbe).not.toHaveBeenCalled();
      expect(max.getChatMembersAccess).toHaveBeenCalledTimes(2);
      await service.onModuleDestroy();
    },
  );

  it('uses a newly selected healthy peer after an exact denial without poisoning that route', async () => {
    let botId = 'a';
    const max = {
      getChatMembersAccess: jest
        .fn()
        .mockRejectedValueOnce({ response: { status: 403, data: { code: 'chat.denied' } } })
        .mockResolvedValueOnce(new Map([['user', { userId: 'user' }]])),
    };
    const link = {
      resolveBotRoute: jest.fn(async () => ({ botId })),
      recordBotAccessProbe: jest.fn(async () => {
        botId = 'b';
        return true;
      }),
    };
    const service = new MaxMembershipLookupService(
      max as never,
      createConfigMock() as never,
      link as never,
    );
    await expect(
      service.getMembership('channel', 'user', 'moderation_required_subscription', {
        forceRefresh: true,
        allowStaleOnError: false,
      }),
    ).resolves.toBe(true);
    expect(max.getChatMembersAccess).toHaveBeenCalledTimes(2);
    expect(link.recordBotAccessProbe).toHaveBeenCalledWith(
      expect.objectContaining({ botId: 'a', lastErrorCode: 'chat.denied' }),
    );
    await service.onModuleDestroy();
  });

  it('disables Redis ready check on the pub/sub subscriber connection', () => {
    const maxClient = {
      hasChatMember: jest.fn(),
      getChatMembersAccess: jest.fn(),
    };

    new MaxMembershipLookupService(maxClient as never, createConfigMock() as never);

    const redisInstance = (Redis as unknown as jest.Mock).mock.results.at(-1)?.value as {
      duplicate: jest.Mock;
    };
    expect(redisInstance.duplicate).toHaveBeenCalledWith({ enableReadyCheck: false });
  });

  it('releases expired positive and negative snapshots after idle churn in bounded callbacks', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-10-01T12:00:00.000Z'));
    const maxClient = { hasChatMember: jest.fn(), getChatMembersAccess: jest.fn() };
    const service = new MaxMembershipLookupService(maxClient as never, createConfigMock() as never);
    const state = readMembershipMemoryState(service);
    for (let index = 0; index < 12000; index++) {
      state.storeMemorySnapshot(`idle-${index}`, {
        isMember: index % 2 === 0,
        checkedAtMs: Date.now(),
      });
    }
    expect(state.memoryCacheSweepTimer?.hasRef()).toBe(false);
    jest.setSystemTime(Date.now() + 91000);
    await jest.advanceTimersToNextTimerAsync();
    expect(state.memoryCache.size).toBe(12000 - 256);
    await jest.advanceTimersByTimeAsync(100);
    expect(state.memoryCache.size).toBe(0);
    expect(state.memoryCacheSweepIterator).toBeNull();
    expect(state.memoryCacheSweepTimer).toBeNull();
    expect(maxClient.hasChatMember).not.toHaveBeenCalled();
    expect(maxClient.getChatMembersAccess).not.toHaveBeenCalled();
    await service.onModuleDestroy();
  });

  it('keeps retained stale positives and refreshed snapshots usable during expiry maintenance', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-10-01T12:10:00.000Z'));
    const maxClient = {
      hasChatMember: jest.fn(),
      getChatMembersAccess: jest.fn().mockRejectedValue(new Error('temporary MAX failure')),
    };
    const service = new MaxMembershipLookupService(maxClient as never, createConfigMock() as never);
    const state = readMembershipMemoryState(service);
    state.storeMemorySnapshot('max:membership:v1:channel-1:user-1', {
      isMember: true,
      checkedAtMs: Date.now(),
    });
    state.storeMemorySnapshot('negative-idle', { isMember: false, checkedAtMs: Date.now() });
    await jest.advanceTimersByTimeAsync(20000);
    expect(state.memoryCache.has('negative-idle')).toBe(false);
    await expect(
      service.getMembership('channel-1', 'user-1', 'giveaway_interactive', {
        forceRefresh: true,
      }),
    ).resolves.toBe(true);
    state.storeMemorySnapshot('max:membership:v1:channel-1:user-1', {
      isMember: true,
      checkedAtMs: Date.now(),
    });
    await jest.advanceTimersByTimeAsync(75000);
    expect(state.memoryCache.has('max:membership:v1:channel-1:user-1')).toBe(true);
    await service.onModuleDestroy();
    expect(state.memoryCache.size).toBe(0);
    expect(state.memoryCacheSweepIterator).toBeNull();
    expect(state.memoryCacheSweepTimer).toBeNull();
    state.storeMemorySnapshot('late-after-shutdown', { isMember: true, checkedAtMs: Date.now() });
    expect(state.memoryCache.size).toBe(0);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('finishes a snapshot sweep pass despite continuous new cache keys', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-10-01T12:20:00.000Z'));
    const service = new MaxMembershipLookupService(
      { hasChatMember: jest.fn(), getChatMembersAccess: jest.fn() } as never,
      createConfigMock() as never,
    );
    const state = readMembershipMemoryState(service);
    for (let index = 0; index < 512; index++) {
      state.storeMemorySnapshot(`initial-${index}`, { isMember: true, checkedAtMs: Date.now() });
    }
    await jest.advanceTimersByTimeAsync(5000);
    expect(state.memoryCacheSweepRemaining).toBe(256);
    for (let index = 0; index < 512; index++) {
      state.storeMemorySnapshot(`new-${index}`, { isMember: true, checkedAtMs: Date.now() });
    }
    await jest.advanceTimersByTimeAsync(1);
    expect(state.memoryCacheSweepIterator).toBeNull();
    expect(state.memoryCacheSweepRemaining).toBe(0);
    expect(state.memoryCache.size).toBe(1024);
    await service.onModuleDestroy();
  });

  it('expires a large invalidation-only pub/sub stream without looking up its keys', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-29T09:00:00.000Z'));
    const maxClient = { hasChatMember: jest.fn(), getChatMembersAccess: jest.fn() };
    const registry = {
      getAllBots: () => [{ id: 'bot-1' }, { id: 'bot-2' }],
      getBotById: (id: string) => ({ id }),
    };
    const service = new MaxMembershipLookupService(
      maxClient as never,
      createConfigMock() as never,
      undefined,
      registry as never,
    );
    await service.onModuleInit();
    for (let index = 0; index < 2000; index++) {
      publishMembershipInvalidation('channel-idle', [`user-${index}`]);
    }
    const state = readMembershipEpochState(service);
    expect(state.cacheEpochs.size).toBe(12000);
    expect(state.activeCacheEpochReaders.size).toBe(0);

    await jest.advanceTimersByTimeAsync(5100);
    expect(state.cacheEpochs.size).toBe(12000);
    jest.setSystemTime(new Date('2026-03-29T09:02:00.000Z'));
    await jest.advanceTimersToNextTimerAsync();
    expect(12000 - state.cacheEpochs.size).toBe(256);
    expect(state.cacheEpochs.size).toBeGreaterThan(0);
    await jest.advanceTimersByTimeAsync(100);
    expect(state.cacheEpochs.size).toBe(0);
    expect(maxClient.getChatMembersAccess).not.toHaveBeenCalled();
    expect(maxClient.hasChatMember).not.toHaveBeenCalled();
    await service.onModuleDestroy();
  });

  it('retains refreshed invalidation states while sweeping older expired keys', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-29T09:05:00.000Z'));
    const service = new MaxMembershipLookupService(
      { hasChatMember: jest.fn(), getChatMembersAccess: jest.fn() } as never,
      createConfigMock() as never,
    );
    await service.onModuleInit();
    publishMembershipInvalidation('channel-old', ['user-old']);
    publishMembershipInvalidation('channel-refreshed', ['user-refreshed']);
    await jest.advanceTimersByTimeAsync(100000);
    publishMembershipInvalidation('channel-refreshed', ['user-refreshed']);
    await jest.advanceTimersByTimeAsync(25000);

    const state = readMembershipEpochState(service);
    expect(state.cacheEpochs.size).toBe(2);
    expect(state.cacheEpochs.get('max:membership:v1:channel-refreshed:user-refreshed')?.epoch).toBe(
      2,
    );
    await jest.advanceTimersByTimeAsync(100000);
    expect(state.cacheEpochs.size).toBe(0);
    await service.onModuleDestroy();
  });

  it('finishes a bounded sweep pass while new invalidations keep appending keys', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-29T09:10:00.000Z'));
    const service = new MaxMembershipLookupService(
      { hasChatMember: jest.fn(), getChatMembersAccess: jest.fn() } as never,
      createConfigMock() as never,
    );
    await service.onModuleInit();
    for (let index = 0; index < 512; index++) {
      publishMembershipInvalidation('channel-before-pass', [`user-${index}`]);
    }
    const state = readMembershipEpochState(service);
    await jest.advanceTimersByTimeAsync(5000);
    expect(state.cacheEpochSweepRemaining).toBe(768);
    for (let batch = 0; batch < 3; batch++) {
      for (let index = 0; index < 128; index++) {
        publishMembershipInvalidation(`channel-added-${batch}`, [`user-${index}`]);
      }
      await jest.advanceTimersByTimeAsync(1);
    }

    expect(state.cacheEpochSweepIterator).toBeNull();
    expect(state.cacheEpochSweepRemaining).toBe(0);
    expect(state.cacheEpochs.size).toBe(1792);
    await jest.advanceTimersByTimeAsync(100);
    expect(state.cacheEpochSweepIterator).toBeNull();
    expect(state.cacheEpochs.size).toBe(1792);
    await jest.advanceTimersByTimeAsync(125000);
    expect(state.cacheEpochs.size).toBe(0);
    await service.onModuleDestroy();
  });

  it.each([
    ['single', 1],
    ['batch', 2],
  ] as const)(
    'rejects a superseded invalidated %s lookup after its guard state TTL',
    async (_kind, userCount) => {
      jest.useFakeTimers().setSystemTime(new Date('2026-03-29T09:15:00.000Z'));
      const older = createDeferred<Map<string, { userId: string; isAdmin: boolean }>>();
      const maxClient = {
        hasChatMember: jest.fn(),
        getChatMembersAccess: jest
          .fn()
          .mockImplementationOnce(() => older.promise)
          .mockResolvedValueOnce(new Map()),
      };
      const service = new MaxMembershipLookupService(
        maxClient as never,
        createConfigMock({ MAX_MEMBERSHIP_LOOKUP_TIMEOUT_MS_INTERACTIVE: 180000 }) as never,
      );
      await service.onModuleInit();
      const userIds = Array.from({ length: userCount }, (_, index) => `user-${index}`);
      const olderLookup = service.getMemberships('channel-late', userIds, 'giveaway_interactive', {
        forceRefresh: true,
      });
      await Promise.resolve();
      await Promise.resolve();
      expect(maxClient.getChatMembersAccess).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(1);
      await service.invalidateMemberships('channel-late', userIds);
      await expect(
        service.getMemberships('channel-late', userIds, 'giveaway_interactive', {
          forceRefresh: true,
        }),
      ).resolves.toEqual(new Map(userIds.map((userId) => [userId, false])));

      const state = readMembershipEpochState(service);
      expect(state.activeCacheEpochReaders.size).toBe(userCount);
      await jest.advanceTimersByTimeAsync(125000);
      expect(state.cacheEpochs.size).toBe(userCount);
      older.resolve(new Map(userIds.map((userId) => [userId, { userId, isAdmin: false }])));
      await expect(olderLookup).resolves.toEqual(new Map(userIds.map((userId) => [userId, null])));
      expect(state.activeCacheEpochReaders.size).toBe(0);
      expect(state.cacheEpochs.size).toBe(0);
      for (const userId of userIds) {
        expect(
          readRedisMembershipSnapshot(`max:membership:v1:channel-late:${userId}`)?.isMember,
        ).toBe(false);
      }
      expect(maxClient.getChatMembersAccess).toHaveBeenCalledTimes(2);
      await service.onModuleDestroy();
    },
  );

  it('releases an invalidated lookup guard when a delayed MAX operation fails after expiry', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-29T09:20:00.000Z'));
    const deferred = createDeferred<Map<string, { userId: string; isAdmin: boolean }>>();
    const service = new MaxMembershipLookupService(
      { hasChatMember: jest.fn(), getChatMembersAccess: jest.fn(() => deferred.promise) } as never,
      createConfigMock({ MAX_MEMBERSHIP_LOOKUP_TIMEOUT_MS_INTERACTIVE: 180000 }) as never,
    );
    await service.onModuleInit();
    const lookup = service.getMembership('channel-error', 'user-error', 'giveaway_interactive', {
      forceRefresh: true,
    });
    await Promise.resolve();
    await Promise.resolve();
    await service.invalidateMemberships('channel-error', ['user-error']);
    await jest.advanceTimersByTimeAsync(125000);
    const state = readMembershipEpochState(service);
    expect(state.cacheEpochs.size).toBe(1);
    deferred.reject(Object.assign(new Error('Synthetic network error'), { code: 'ECONNRESET' }));
    await expect(lookup).resolves.toBeNull();
    expect(state.activeCacheEpochReaders.size).toBe(0);
    expect(state.cacheEpochs.size).toBe(0);
    await service.onModuleDestroy();
  });

  it('does not reuse an expired epoch number while an older reader is still pending', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-29T09:22:00.000Z'));
    const deferred = createDeferred<Map<string, { userId: string; isAdmin: boolean }>>();
    const service = new MaxMembershipLookupService(
      { hasChatMember: jest.fn(), getChatMembersAccess: jest.fn(() => deferred.promise) } as never,
      createConfigMock({ MAX_MEMBERSHIP_LOOKUP_TIMEOUT_MS_INTERACTIVE: 180000 }) as never,
    );
    await service.onModuleInit();
    await service.invalidateMemberships('channel-refresh-live', ['user-refresh-live']);
    const lookup = service.getMembership(
      'channel-refresh-live',
      'user-refresh-live',
      'giveaway_interactive',
      { forceRefresh: true },
    );
    await Promise.resolve();
    await Promise.resolve();
    await jest.advanceTimersByTimeAsync(125000);
    await service.invalidateMemberships('channel-refresh-live', ['user-refresh-live']);
    deferred.resolve(
      new Map([['user-refresh-live', { userId: 'user-refresh-live', isAdmin: false }]]),
    );
    await expect(lookup).resolves.toBeNull();
    const state = readMembershipEpochState(service);
    expect(state.activeCacheEpochReaders.size).toBe(0);
    expect(
      readRedisMembershipSnapshot('max:membership:v1:channel-refresh-live:user-refresh-live'),
    ).toBeNull();
    await jest.advanceTimersByTimeAsync(125000);
    expect(state.cacheEpochs.size).toBe(0);
    await service.onModuleDestroy();
  });

  it('rejects an invalidated Redis read when wall-clock time passes its epoch TTL', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-29T09:24:00.000Z'));
    const startedAtMs = Date.now();
    const deferred = createDeferred<Array<string | null>>();
    const maxClient = {
      hasChatMember: jest.fn(),
      getChatMembersAccess: jest.fn().mockResolvedValue(new Map()),
    };
    const service = new MaxMembershipLookupService(maxClient as never, createConfigMock() as never);
    const redisInstance = (Redis as unknown as jest.Mock).mock.results.at(-1)?.value as {
      mget: jest.Mock;
    };
    redisInstance.mget.mockImplementationOnce(() => deferred.promise);
    await service.onModuleInit();
    const lookup = service.getMembership(
      'channel-redis-late',
      'user-redis-late',
      'giveaway_interactive',
    );
    await Promise.resolve();
    expect(redisInstance.mget).toHaveBeenCalledTimes(1);
    await service.invalidateMemberships('channel-redis-late', ['user-redis-late']);
    jest.setSystemTime(startedAtMs + 125000);
    deferred.resolve([
      JSON.stringify({
        isMember: true,
        checkedAtMs: startedAtMs,
        probeStartedAtMs: startedAtMs - 1,
        writerPolicy: 'giveaway_interactive',
      }),
    ]);
    await expect(lookup).resolves.toBe(false);
    expect(maxClient.getChatMembersAccess).toHaveBeenCalledTimes(1);
    const state = readMembershipEpochState(service);
    expect(state.activeCacheEpochReaders.size).toBe(0);
    await jest.advanceTimersByTimeAsync(5000);
    expect(state.cacheEpochs.size).toBe(0);
    await service.onModuleDestroy();
  });

  it('releases Redis and MAX readers on error so their expired states can be swept', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-29T09:25:00.000Z'));
    const maxClient = {
      hasChatMember: jest.fn(),
      getChatMembersAccess: jest
        .fn()
        .mockRejectedValue(
          Object.assign(new Error('Synthetic network error'), { code: 'ECONNRESET' }),
        ),
    };
    const service = new MaxMembershipLookupService(maxClient as never, createConfigMock() as never);
    const redisInstance = (Redis as unknown as jest.Mock).mock.results.at(-1)?.value as {
      mget: jest.Mock;
    };
    redisInstance.mget.mockRejectedValueOnce(new Error('Synthetic Redis error'));
    await service.onModuleInit();
    publishMembershipInvalidation('channel-read-error', ['user-read-error']);
    await expect(
      service.getMembership('channel-read-error', 'user-read-error', 'giveaway_interactive'),
    ).resolves.toBeNull();
    const state = readMembershipEpochState(service);
    expect(state.activeCacheEpochReaders.size).toBe(0);
    await jest.advanceTimersByTimeAsync(125000);
    expect(state.cacheEpochs.size).toBe(0);
    await service.onModuleDestroy();
  });

  it('cancels maintenance during a sweep and does not schedule another callback after shutdown', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-29T09:30:00.000Z'));
    const service = new MaxMembershipLookupService(
      { hasChatMember: jest.fn(), getChatMembersAccess: jest.fn() } as never,
      createConfigMock() as never,
    );
    await service.onModuleInit();
    for (let index = 0; index < 512; index++) {
      publishMembershipInvalidation('channel-shutdown', [`user-${index}`]);
    }
    await jest.advanceTimersByTimeAsync(5000);
    const state = readMembershipEpochState(service);
    expect(state.cacheEpochSweepIterator).not.toBeNull();
    expect(jest.getTimerCount()).toBe(1);
    await service.onModuleDestroy();
    expect(state.cacheEpochSweepIterator).toBeNull();
    expect(state.cacheEpochSweepRemaining).toBe(0);
    expect(jest.getTimerCount()).toBe(0);
    await jest.advanceTimersByTimeAsync(125000);
    expect(jest.getTimerCount()).toBe(0);
    expect(state.cacheEpochs.size).toBe(1024);
  });

  it('does not trust a giveaway snapshot for required-subscription moderation', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-29T10:00:00.000Z'));

    const maxClient = {
      hasChatMember: jest.fn(),
      getChatMembersAccess: jest
        .fn()
        .mockResolvedValue(new Map([['user-1', { userId: 'user-1', isAdmin: false }]])),
    };
    const service = new MaxMembershipLookupService(maxClient as never, createConfigMock() as never);

    await expect(
      service.getMembership('channel-1', 'user-1', 'giveaway_interactive'),
    ).resolves.toBe(true);

    jest.advanceTimersByTime(12_000);

    await expect(
      service.getMembership('channel-1', 'user-1', 'moderation_required_subscription'),
    ).resolves.toBe(true);

    expect(maxClient.getChatMembersAccess).toHaveBeenCalledTimes(2);
    expect(maxClient.getChatMembersAccess.mock.calls[1]?.[2]).toEqual(
      expect.objectContaining({ bypassCache: true }),
    );
    expect(maxClient.hasChatMember).not.toHaveBeenCalled();
  });

  it('keeps a positive required-subscription snapshot warm for fifteen seconds', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-29T10:01:00.000Z'));

    const maxClient = {
      hasChatMember: jest.fn(),
      getChatMembersAccess: jest
        .fn()
        .mockResolvedValue(new Map([['user-1', { userId: 'user-1', isAdmin: false }]])),
    };
    const service = new MaxMembershipLookupService(maxClient as never, createConfigMock() as never);

    await expect(
      service.getMembership('channel-1', 'user-1', 'moderation_required_subscription'),
    ).resolves.toBe(true);

    jest.advanceTimersByTime(12_000);

    await expect(
      service.getMembership('channel-1', 'user-1', 'moderation_required_subscription'),
    ).resolves.toBe(true);

    expect(maxClient.getChatMembersAccess).toHaveBeenCalledTimes(1);
  });

  it('expires negative snapshots sooner than positive ones', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-29T10:05:00.000Z'));

    const maxClient = {
      hasChatMember: jest.fn(),
      getChatMembersAccess: jest.fn().mockResolvedValue(new Map()),
    };
    const service = new MaxMembershipLookupService(maxClient as never, createConfigMock() as never);

    await expect(
      service.getMembership('channel-1', 'user-2', 'giveaway_interactive'),
    ).resolves.toBe(false);

    jest.advanceTimersByTime(2_000);
    await expect(
      service.getMembership('channel-1', 'user-2', 'giveaway_interactive'),
    ).resolves.toBe(false);

    jest.advanceTimersByTime(2_000);
    await expect(
      service.getMembership('channel-1', 'user-2', 'giveaway_interactive'),
    ).resolves.toBe(false);

    expect(maxClient.getChatMembersAccess).toHaveBeenCalledTimes(2);
    expect(maxClient.getChatMembersAccess.mock.calls[0]?.[2]).not.toHaveProperty('bypassCache');
    expect(maxClient.hasChatMember).not.toHaveBeenCalled();
  });

  it('keeps a fresh giveaway decision independent of an outstanding cacheable probe', async () => {
    const cachedReadStarted = createDeferred<void>();
    const finishCachedRead =
      createDeferred<Awaited<ReturnType<MaxClientService['getChatMembersAccess']>>>();
    const getChatMembersAccess = jest.fn<
      ReturnType<MaxClientService['getChatMembersAccess']>,
      Parameters<MaxClientService['getChatMembersAccess']>
    >(async (_chatId, _ids, options) => {
      if (options?.bypassCache) return new Map();
      cachedReadStarted.resolve();
      return finishCachedRead.promise;
    });
    const lookup = new MaxMembershipLookupService(
      { getChatMembersAccess } as unknown as MaxClientService,
      createConfigMock() as never,
    );
    const policy = 'giveaway_interactive';
    const options = { allowStaleOnError: false, botId: 'bot-1' };
    const cached = lookup.getMembership('fresh-chat', '21', policy, options);
    await cachedReadStarted.promise;
    const fresh = lookup.getMembership('fresh-chat', '21', policy, {
      ...options,
      forceRefresh: true,
    });
    finishCachedRead.resolve(
      new Map([['21', { userId: '21', isAdmin: false, isOwner: false, permissions: [] }]]),
    );
    await expect(Promise.all([cached, fresh])).resolves.toEqual([true, false]);
    expect(getChatMembersAccess).toHaveBeenCalledTimes(2);
    await lookup.onModuleDestroy();
  });

  it('reports whether membership resolutions are fresh or stale fallbacks', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-29T10:07:00.000Z'));

    const timeoutError = Object.assign(new Error('lookup timeout'), {
      code: 'ECONNABORTED',
    });
    const maxClient = {
      hasChatMember: jest.fn(),
      getChatMembersAccess: jest
        .fn()
        .mockResolvedValueOnce(new Map())
        .mockRejectedValueOnce(timeoutError),
    };
    const service = new MaxMembershipLookupService(maxClient as never, createConfigMock() as never);

    await expect(
      service.getMembershipResolution('channel-1', 'user-2', 'giveaway_interactive'),
    ).resolves.toEqual({ membership: false, fresh: true });

    jest.advanceTimersByTime(4_000);

    await expect(
      service.getMembershipResolution('channel-1', 'user-2', 'giveaway_interactive', {
        allowStaleOnError: true,
      }),
    ).resolves.toEqual({ membership: false, fresh: false });

    expect(maxClient.getChatMembersAccess).toHaveBeenCalledTimes(2);
    expect(maxClient.hasChatMember).not.toHaveBeenCalled();
  });

  it('does not share a lenient stale in-flight result with required-subscription moderation', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-29T10:08:00.000Z'));

    let rejectLenientLookup: ((reason: unknown) => void) | null = null;
    const maxClient = {
      hasChatMember: jest.fn(),
      getChatMembersAccess: jest
        .fn()
        .mockResolvedValueOnce(new Map([['user-2', { userId: 'user-2', isAdmin: false }]]))
        .mockImplementationOnce(
          () =>
            new Promise<Map<string, never>>((_resolve, reject) => {
              rejectLenientLookup = reject;
            }),
        )
        .mockResolvedValueOnce(new Map()),
    };
    const service = new MaxMembershipLookupService(maxClient as never, createConfigMock() as never);

    await expect(
      service.getMembership('channel-1', 'user-2', 'giveaway_interactive'),
    ).resolves.toBe(true);
    jest.advanceTimersByTime(16_000);

    const lenientLookup = service.getMembershipResolution(
      'channel-1',
      'user-2',
      'giveaway_interactive',
      { forceRefresh: true, allowStaleOnError: true },
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(maxClient.getChatMembersAccess).toHaveBeenCalledTimes(2);

    const moderationLookup = service.getMembershipResolution(
      'channel-1',
      'user-2',
      'moderation_required_subscription',
      { forceRefresh: true, allowStaleOnError: false },
    );
    await expect(moderationLookup).resolves.toEqual({ membership: false, fresh: true });

    const rejectLookup = rejectLenientLookup as ((reason: unknown) => void) | null;
    if (!rejectLookup) {
      throw new Error('Expected lenient membership lookup rejector');
    }
    rejectLookup(Object.assign(new Error('lookup timeout'), { code: 'ECONNABORTED' }));

    await expect(lenientLookup).resolves.toEqual({ membership: false, fresh: false });
    expect(maxClient.getChatMembersAccess).toHaveBeenCalledTimes(3);
  });

  it('does not let an older lenient probe overwrite a newer strict result across instances', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-29T10:09:00.000Z'));

    let resolveOlderLookup:
      | ((value: Map<string, { userId: string; isAdmin: boolean }>) => void)
      | null = null;
    const maxClient = {
      hasChatMember: jest.fn(),
      getChatMembersAccess: jest
        .fn()
        .mockImplementationOnce(
          () =>
            new Promise<Map<string, { userId: string; isAdmin: boolean }>>((resolve) => {
              resolveOlderLookup = resolve;
            }),
        )
        .mockResolvedValueOnce(new Map()),
    };
    const lenientService = new MaxMembershipLookupService(
      maxClient as never,
      createConfigMock() as never,
    );
    const strictService = new MaxMembershipLookupService(
      maxClient as never,
      createConfigMock() as never,
    );

    const olderLookup = lenientService.getMembershipResolution(
      'channel-probe-order',
      'user-probe-order',
      'giveaway_interactive',
      { forceRefresh: true, allowStaleOnError: true },
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(maxClient.getChatMembersAccess).toHaveBeenCalledTimes(1);

    await expect(
      strictService.getMembershipResolution(
        'channel-probe-order',
        'user-probe-order',
        'moderation_required_subscription',
        { forceRefresh: true, allowStaleOnError: false },
      ),
    ).resolves.toEqual({ membership: false, fresh: true });

    const finishOlderLookup = resolveOlderLookup as
      | ((value: Map<string, { userId: string; isAdmin: boolean }>) => void)
      | null;
    if (!finishOlderLookup) {
      throw new Error('Expected older membership lookup resolver');
    }
    finishOlderLookup(
      new Map([['user-probe-order', { userId: 'user-probe-order', isAdmin: false }]]),
    );

    await expect(olderLookup).resolves.toEqual({ membership: true, fresh: true });
    await Promise.resolve();
    const readerService = new MaxMembershipLookupService(
      maxClient as never,
      createConfigMock() as never,
    );
    await expect(
      strictService.getMembership(
        'channel-probe-order',
        'user-probe-order',
        'moderation_required_subscription',
      ),
    ).resolves.toBe(false);
    await expect(
      readerService.getMembership(
        'channel-probe-order',
        'user-probe-order',
        'giveaway_interactive',
      ),
    ).resolves.toBe(false);
    expect(
      readRedisMembershipSnapshot('max:membership:v1:channel-probe-order:user-probe-order'),
    ).toEqual(expect.objectContaining({ isMember: false }));
    expect(
      readRedisMembershipSnapshot(
        'max:membership:v1:channel-probe-order:user-probe-order:policy:moderation_required_subscription',
      ),
    ).toEqual(expect.objectContaining({ isMember: false }));
    expect(maxClient.getChatMembersAccess).toHaveBeenCalledTimes(2);
  });

  it('lets an older strict probe supersede an overlapping newer lenient result across instances', async () => {
    let resolveStrictLookup:
      | ((value: Map<string, { userId: string; isAdmin: boolean }>) => void)
      | null = null;
    const maxClient = {
      hasChatMember: jest.fn(),
      getChatMembersAccess: jest
        .fn()
        .mockImplementationOnce(
          (_chatId, _userIds, options: { bypassCache?: boolean }) =>
            new Promise<Map<string, { userId: string; isAdmin: boolean }>>((resolve) => {
              expect(options).toEqual(expect.objectContaining({ bypassCache: true }));
              resolveStrictLookup = resolve;
            }),
        )
        .mockImplementationOnce((_chatId, _userIds, options: { bypassCache?: boolean }) => {
          expect(options).not.toHaveProperty('bypassCache');
          return new Map([['user-strict-first', { userId: 'user-strict-first', isAdmin: false }]]);
        }),
    };
    const strictService = new MaxMembershipLookupService(
      maxClient as never,
      createConfigMock() as never,
    );
    const lenientService = new MaxMembershipLookupService(
      maxClient as never,
      createConfigMock() as never,
    );

    const strictLookup = strictService.getMembershipResolution(
      'channel-strict-first',
      'user-strict-first',
      'moderation_required_subscription',
      { forceRefresh: true, allowStaleOnError: false },
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(maxClient.getChatMembersAccess).toHaveBeenCalledTimes(1);

    await expect(
      lenientService.getMembershipResolution(
        'channel-strict-first',
        'user-strict-first',
        'giveaway_interactive',
        { forceRefresh: true, allowStaleOnError: true },
      ),
    ).resolves.toEqual({ membership: true, fresh: true });

    const finishStrictLookup = resolveStrictLookup as
      | ((value: Map<string, { userId: string; isAdmin: boolean }>) => void)
      | null;
    if (!finishStrictLookup) {
      throw new Error('Expected strict membership lookup resolver');
    }
    finishStrictLookup(new Map());

    await expect(strictLookup).resolves.toEqual({ membership: false, fresh: true });
    const readerService = new MaxMembershipLookupService(
      maxClient as never,
      createConfigMock() as never,
    );
    await expect(
      strictService.getMembership(
        'channel-strict-first',
        'user-strict-first',
        'moderation_required_subscription',
      ),
    ).resolves.toBe(false);
    await expect(
      readerService.getMembership(
        'channel-strict-first',
        'user-strict-first',
        'giveaway_interactive',
      ),
    ).resolves.toBe(false);
    expect(
      readRedisMembershipSnapshot('max:membership:v1:channel-strict-first:user-strict-first'),
    ).toEqual(expect.objectContaining({ isMember: false }));
    expect(
      readRedisMembershipSnapshot(
        'max:membership:v1:channel-strict-first:user-strict-first:policy:moderation_required_subscription',
      ),
    ).toEqual(expect.objectContaining({ isMember: false }));
    expect(maxClient.getChatMembersAccess).toHaveBeenCalledTimes(2);
  });

  it('does not let an earlier Redis read replace a strict snapshot committed while it was pending', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-29T10:09:15.000Z'));

    let resolveRedisRead: ((values: Array<string | null>) => void) | null = null;
    const maxClient = {
      hasChatMember: jest.fn(),
      getChatMembersAccess: jest.fn().mockResolvedValue(new Map()),
    };
    const service = new MaxMembershipLookupService(maxClient as never, createConfigMock() as never);
    const redisInstance = (Redis as unknown as jest.Mock).mock.results.at(-1)?.value as {
      mget: jest.Mock;
    };
    redisInstance.mget.mockImplementationOnce(
      () =>
        new Promise<Array<string | null>>((resolve) => {
          resolveRedisRead = resolve;
        }),
    );

    const pendingGeneralLookup = service.getMembershipResolution(
      'channel-pending-cache-read',
      'user-pending-cache-read',
      'giveaway_interactive',
    );
    await Promise.resolve();
    expect(redisInstance.mget).toHaveBeenCalledTimes(1);

    await expect(
      service.getMembershipResolution(
        'channel-pending-cache-read',
        'user-pending-cache-read',
        'moderation_required_subscription',
        { forceRefresh: true, allowStaleOnError: false },
      ),
    ).resolves.toEqual({ membership: false, fresh: true });

    const finishRedisRead = resolveRedisRead as ((values: Array<string | null>) => void) | null;
    if (!finishRedisRead) {
      throw new Error('Expected pending Redis membership read resolver');
    }
    finishRedisRead([
      JSON.stringify({
        isMember: true,
        checkedAtMs: Date.now() - 1,
        probeStartedAtMs: Date.now() - 2,
        writerPolicy: 'giveaway_interactive',
      }),
    ]);

    await expect(pendingGeneralLookup).resolves.toEqual({ membership: false, fresh: true });
    expect(maxClient.getChatMembersAccess).toHaveBeenCalledTimes(1);
  });

  it('isolates a completed required-subscription result from a later stale inner-cache probe', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-29T10:09:30.000Z'));

    const maxClient = {
      hasChatMember: jest.fn(),
      getChatMembersAccess: jest
        .fn()
        .mockImplementationOnce((_chatId, _userIds, options: { bypassCache?: boolean }) => {
          expect(options).toEqual(expect.objectContaining({ bypassCache: true }));
          return new Map();
        })
        .mockImplementationOnce((_chatId, _userIds, options: { bypassCache?: boolean }) => {
          expect(options).not.toHaveProperty('bypassCache');
          return new Map([['user-stale-inner', { userId: 'user-stale-inner', isAdmin: false }]]);
        }),
    };
    const service = new MaxMembershipLookupService(maxClient as never, createConfigMock() as never);

    await expect(
      service.getMembershipResolution(
        'channel-stale-inner',
        'user-stale-inner',
        'moderation_required_subscription',
        { forceRefresh: true, allowStaleOnError: false },
      ),
    ).resolves.toEqual({ membership: false, fresh: true });
    jest.advanceTimersByTime(1);
    await expect(
      service.getMembershipResolution(
        'channel-stale-inner',
        'user-stale-inner',
        'giveaway_interactive',
        { forceRefresh: true, allowStaleOnError: true },
      ),
    ).resolves.toEqual({ membership: true, fresh: true });

    await expect(
      service.getMembership(
        'channel-stale-inner',
        'user-stale-inner',
        'moderation_required_subscription',
      ),
    ).resolves.toBe(false);
    await expect(
      service.getMembership('channel-stale-inner', 'user-stale-inner', 'giveaway_interactive'),
    ).resolves.toBe(true);
    expect(
      readRedisMembershipSnapshot('max:membership:v1:channel-stale-inner:user-stale-inner'),
    ).toEqual(expect.objectContaining({ isMember: true }));
    expect(
      readRedisMembershipSnapshot(
        'max:membership:v1:channel-stale-inner:user-stale-inner:policy:moderation_required_subscription',
      ),
    ).toEqual(expect.objectContaining({ isMember: false }));
    expect(maxClient.getChatMembersAccess).toHaveBeenCalledTimes(2);
  });

  it('rejects a delayed strict Redis write when a lenient probe started after strict completion', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-29T10:09:45.000Z'));

    const strictMaxClient = {
      hasChatMember: jest.fn(),
      getChatMembersAccess: jest.fn().mockResolvedValue(new Map()),
    };
    const strictService = new MaxMembershipLookupService(
      strictMaxClient as never,
      createConfigMock() as never,
    );
    const strictRedis = (Redis as unknown as jest.Mock).mock.results.at(-1)?.value as {
      eval: jest.Mock;
    };
    const originalEval = strictRedis.eval.getMockImplementation() as
      | ((...args: Array<string | number>) => Promise<unknown>)
      | undefined;
    if (!originalEval) {
      throw new Error('Expected Redis eval mock implementation');
    }
    let releaseStrictWrite: (() => void) | null = null;
    let markStrictWriteStarted: (() => void) | null = null;
    const strictWriteGate = new Promise<void>((resolve) => {
      releaseStrictWrite = resolve;
    });
    const strictWriteStarted = new Promise<void>((resolve) => {
      markStrictWriteStarted = resolve;
    });
    strictRedis.eval.mockImplementation(async (...args: Array<string | number>) => {
      if (String(args[0]).includes('membership-cache-compare-and-set-v1')) {
        markStrictWriteStarted?.();
        await strictWriteGate;
      }
      return originalEval(...args);
    });

    await expect(
      strictService.getMembershipResolution(
        'channel-delayed-strict-write',
        'user-delayed-strict-write',
        'moderation_required_subscription',
        { forceRefresh: true, allowStaleOnError: false },
      ),
    ).resolves.toEqual({ membership: false, fresh: true });
    await strictWriteStarted;
    const delayedStrictWrite = strictRedis.eval.mock.results[0]?.value as Promise<unknown>;

    jest.advanceTimersByTime(1);
    const lenientMaxClient = {
      hasChatMember: jest.fn(),
      getChatMembersAccess: jest
        .fn()
        .mockResolvedValue(
          new Map([
            ['user-delayed-strict-write', { userId: 'user-delayed-strict-write', isAdmin: false }],
          ]),
        ),
    };
    const lenientService = new MaxMembershipLookupService(
      lenientMaxClient as never,
      createConfigMock() as never,
    );
    await expect(
      lenientService.getMembershipResolution(
        'channel-delayed-strict-write',
        'user-delayed-strict-write',
        'giveaway_interactive',
        { forceRefresh: true, allowStaleOnError: true },
      ),
    ).resolves.toEqual({ membership: true, fresh: true });

    const finishStrictWrite = releaseStrictWrite as (() => void) | null;
    if (!finishStrictWrite) {
      throw new Error('Expected delayed strict Redis write resolver');
    }
    finishStrictWrite();
    await delayedStrictWrite;
    await Promise.resolve();

    expect(
      readRedisMembershipSnapshot(
        'max:membership:v1:channel-delayed-strict-write:user-delayed-strict-write',
      ),
    ).toEqual(expect.objectContaining({ isMember: true }));
    expect(
      readRedisMembershipSnapshot(
        'max:membership:v1:channel-delayed-strict-write:user-delayed-strict-write:policy:moderation_required_subscription',
      ),
    ).toEqual(expect.objectContaining({ isMember: false }));
  });

  it('uses MAX batch membership lookups for shared chat checks and reuses the cached result later', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-29T10:10:00.000Z'));

    const maxClient = {
      hasChatMember: jest.fn(),
      getChatMembersAccess: jest
        .fn()
        .mockResolvedValue(new Map([['user-1', { userId: 'user-1', isAdmin: false }]])),
    };
    const service = new MaxMembershipLookupService(maxClient as never, createConfigMock() as never);

    await expect(
      service.getMemberships('channel-1', ['user-1', 'user-2'], 'giveaway_draw_background', {
        forceRefresh: true,
        allowStaleOnError: false,
      }),
    ).resolves.toEqual(
      new Map([
        ['user-1', true],
        ['user-2', false],
      ]),
    );

    await expect(
      service.getMembership('channel-1', 'user-2', 'giveaway_interactive'),
    ).resolves.toBe(false);

    expect(maxClient.getChatMembersAccess).toHaveBeenCalledTimes(1);
    expect(maxClient.hasChatMember).not.toHaveBeenCalled();
  });

  it('uses member-access bot resolution before falling back to the generic chat binding', async () => {
    const maxClient = {
      hasChatMember: jest.fn(),
      getChatMembersAccess: jest
        .fn()
        .mockResolvedValue(new Map([['user-1', { userId: 'user-1', isAdmin: false }]])),
    };
    const maxBotLinkService = {
      resolveBotIdForMemberAccess: jest.fn().mockResolvedValue('id613002203036_4_bot'),
      resolveBotId: jest.fn(),
    };
    const service = new MaxMembershipLookupService(
      maxClient as never,
      createConfigMock() as never,
      maxBotLinkService as never,
    );

    await expect(
      service.getMembership('channel-lookup', 'user-1', 'moderation_required_subscription', {
        forceRefresh: true,
      }),
    ).resolves.toBe(true);

    expect(maxBotLinkService.resolveBotIdForMemberAccess).toHaveBeenCalledWith({
      chatId: 'channel-lookup',
    });
    expect(maxBotLinkService.resolveBotId).not.toHaveBeenCalled();
    expect(maxClient.getChatMembersAccess).toHaveBeenCalledWith(
      'channel-lookup',
      ['user-1'],
      expect.objectContaining({
        botId: 'id613002203036_4_bot',
      }),
    );
  });

  it('uses the unified read route when the link service exposes it', async () => {
    const maxClient = {
      hasChatMember: jest.fn(),
      getChatMembersAccess: jest
        .fn()
        .mockResolvedValue(new Map([['user-1', { userId: 'user-1', isAdmin: false }]])),
    };
    const maxBotLinkService = {
      resolveBotRoute: jest.fn().mockResolvedValue({
        purpose: 'read',
        chatId: 'channel-route-lookup',
        primaryBotId: 'id613002203036_bot',
        botId: 'id613002203036_4_bot',
        candidateBotIds: ['id613002203036_4_bot'],
        reason: 'alternate_confirmed',
      }),
    };
    const service = new MaxMembershipLookupService(
      maxClient as never,
      createConfigMock() as never,
      maxBotLinkService as never,
    );

    await expect(
      service.getMembership('channel-route-lookup', 'user-1', 'moderation_required_subscription', {
        forceRefresh: true,
      }),
    ).resolves.toBe(true);

    expect(maxBotLinkService.resolveBotRoute).toHaveBeenCalledWith({
      purpose: 'read',
      chatId: 'channel-route-lookup',
    });
    expect(maxClient.getChatMembersAccess).toHaveBeenCalledWith(
      'channel-route-lookup',
      ['user-1'],
      expect.objectContaining({
        botId: 'id613002203036_4_bot',
      }),
    );
  });

  it('keeps membership cache isolated per bot scope while leaving chat-level hot state shared', async () => {
    const maxClient = {
      hasChatMember: jest.fn(),
      getChatMembersAccess: jest
        .fn()
        .mockResolvedValueOnce(new Map([['user-1', { userId: 'user-1', isAdmin: false }]]))
        .mockResolvedValueOnce(new Map()),
    };
    const maxBotRegistry = {
      getBotById: jest.fn((botId: string) => ({ id: botId })),
      getAllBots: jest.fn(() => [{ id: 'bot-a' }, { id: 'bot-b' }]),
    };
    const service = new MaxMembershipLookupService(
      maxClient as never,
      createConfigMock() as never,
      undefined,
      maxBotRegistry as never,
    );

    await expect(
      service.getMembership('channel-shared', 'user-1', 'moderation_required_subscription', {
        botId: 'bot-a',
      }),
    ).resolves.toBe(true);

    await expect(
      service.getMembership('channel-shared', 'user-1', 'moderation_required_subscription', {
        botId: 'bot-b',
      }),
    ).resolves.toBe(false);

    await expect(
      service.getMembership('channel-shared', 'user-1', 'moderation_required_subscription', {
        botId: 'bot-a',
      }),
    ).resolves.toBe(true);

    expect(maxClient.getChatMembersAccess).toHaveBeenCalledTimes(2);
    expect(maxClient.getChatMembersAccess).toHaveBeenNthCalledWith(
      1,
      'channel-shared',
      ['user-1'],
      expect.objectContaining({
        botId: 'bot-a',
      }),
    );
    expect(maxClient.getChatMembersAccess).toHaveBeenNthCalledWith(
      2,
      'channel-shared',
      ['user-1'],
      expect.objectContaining({
        botId: 'bot-b',
      }),
    );
  });

  it('does not let a stalled redis membership read block the fallback MAX lookup', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-29T10:11:00.000Z'));

    const maxClient = {
      hasChatMember: jest.fn(),
      getChatMembersAccess: jest
        .fn()
        .mockResolvedValue(
          new Map([['user-redis-timeout', { userId: 'user-redis-timeout', isAdmin: false }]]),
        ),
    };
    const service = new MaxMembershipLookupService(maxClient as never, createConfigMock() as never);
    const redisInstance = (Redis as unknown as jest.Mock).mock.results[0]?.value as {
      mget: jest.Mock;
    };
    redisInstance.mget.mockImplementationOnce(() => new Promise(() => undefined));

    const pendingLookup = service.getMembership(
      'channel-redis-timeout',
      'user-redis-timeout',
      'moderation_required_subscription',
    );
    await jest.advanceTimersByTimeAsync(150);

    await expect(pendingLookup).resolves.toBe(true);
    expect(maxClient.getChatMembersAccess).toHaveBeenCalledTimes(1);
    expect(maxClient.getChatMembersAccess).toHaveBeenCalledWith(
      'channel-redis-timeout',
      ['user-redis-timeout'],
      expect.objectContaining({
        trafficClass: 'critical',
        timeoutMs: 1500,
        sourceTag: 'required_subscription_membership',
        ignoreFailureMetricStatuses: [403, 404],
      }),
    );
    expect(maxClient.hasChatMember).not.toHaveBeenCalled();
  });

  it('coalesces concurrent single-user lookups for the same chat into one MAX batch request', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-29T10:12:00.000Z'));

    const maxClient = {
      hasChatMember: jest.fn(),
      getChatMembersAccess: jest.fn().mockResolvedValue(
        new Map([
          ['user-1', { userId: 'user-1', isAdmin: false }],
          ['user-3', { userId: 'user-3', isAdmin: false }],
        ]),
      ),
    };
    const service = new MaxMembershipLookupService(maxClient as never, createConfigMock() as never);

    await expect(
      Promise.all([
        service.getMembership('channel-1', 'user-1', 'moderation_required_subscription', {
          forceRefresh: true,
        }),
        service.getMembership('channel-1', 'user-2', 'moderation_required_subscription', {
          forceRefresh: true,
        }),
        service.getMembership('channel-1', 'user-3', 'moderation_required_subscription', {
          forceRefresh: true,
        }),
      ]),
    ).resolves.toEqual([true, false, true]);

    expect(maxClient.getChatMembersAccess).toHaveBeenCalledTimes(1);
    expect(maxClient.getChatMembersAccess).toHaveBeenCalledWith(
      'channel-1',
      ['user-1', 'user-2', 'user-3'],
      {
        trafficClass: 'critical',
        timeoutMs: 1_500,
        bypassCache: true,
        sourceTag: 'required_subscription_membership',
        ignoreFailureMetricStatuses: [403, 404],
      },
    );
    expect(maxClient.hasChatMember).not.toHaveBeenCalled();
  });

  it('routes membership lookups through the chat-bound bot when one is assigned', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-29T10:12:30.000Z'));

    const maxClient = {
      hasChatMember: jest.fn(),
      getChatMembersAccess: jest
        .fn()
        .mockResolvedValue(new Map([['user-1', { userId: 'user-1', isAdmin: false }]])),
    };
    const maxBotLinkService = {
      resolveBotId: jest.fn().mockResolvedValue('id613002203036_4_bot'),
    };
    const service = new MaxMembershipLookupService(
      maxClient as never,
      createConfigMock() as never,
      maxBotLinkService as never,
    );

    await expect(
      service.getMembership('channel-1', 'user-1', 'moderation_required_subscription', {
        forceRefresh: true,
      }),
    ).resolves.toBe(true);

    expect(maxBotLinkService.resolveBotId).toHaveBeenCalledWith({ chatId: 'channel-1' });
    expect(maxClient.getChatMembersAccess).toHaveBeenCalledWith('channel-1', ['user-1'], {
      trafficClass: 'critical',
      timeoutMs: 1_500,
      bypassCache: true,
      sourceTag: 'required_subscription_membership',
      ignoreFailureMetricStatuses: [403, 404],
      botId: 'id613002203036_4_bot',
    });
  });

  it('debounces hot single-user moderation lookups long enough to batch near-simultaneous updates', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-29T10:13:00.000Z'));

    const maxClient = {
      hasChatMember: jest.fn(),
      getChatMembersAccess: jest.fn().mockResolvedValue(
        new Map([
          ['user-7', { userId: 'user-7', isAdmin: false }],
          ['user-8', { userId: 'user-8', isAdmin: false }],
        ]),
      ),
    };
    const service = new MaxMembershipLookupService(
      maxClient as never,
      createConfigMock({
        MAX_MEMBERSHIP_LOOKUP_BATCH_WINDOW_MS: 12,
      }) as never,
    );

    const firstLookup = service.getMembership(
      'channel-2',
      'user-7',
      'moderation_required_subscription',
      {
        forceRefresh: true,
      },
    );
    jest.advanceTimersByTime(6);
    const secondLookup = service.getMembership(
      'channel-2',
      'user-8',
      'moderation_required_subscription',
      {
        forceRefresh: true,
      },
    );

    expect(maxClient.getChatMembersAccess).not.toHaveBeenCalled();

    jest.advanceTimersByTime(6);

    await expect(Promise.all([firstLookup, secondLookup])).resolves.toEqual([true, true]);
    expect(maxClient.getChatMembersAccess).toHaveBeenCalledTimes(1);
    expect(maxClient.getChatMembersAccess).toHaveBeenCalledWith('channel-2', ['user-7', 'user-8'], {
      trafficClass: 'critical',
      timeoutMs: 1_500,
      bypassCache: true,
      sourceTag: 'required_subscription_membership',
      ignoreFailureMetricStatuses: [403, 404],
    });
  });

  describe('membership GET local quota provenance', () => {
    const isLocalQuotaResolution = isMaxMembershipLookupLocalQuotaResolution;
    const localQuota = () =>
      new MaxApiInternalRateLimitError('Membership read capacity unavailable', 250, 'bot');
    const fixture = (overrides: Partial<Record<string, number | string | boolean>> = {}) => {
      const maxClient: jest.Mocked<Pick<MaxClientService, 'getChatMembersAccess'>> = {
        getChatMembersAccess: jest.fn(),
      };
      const bots = {
        getDefaultBotId: jest.fn(() => 'bot-1'),
      } satisfies Pick<MaxBotLinkService, 'getDefaultBotId'>;
      const service = new MaxMembershipLookupService(
        maxClient as never,
        createConfigMock(overrides) as never,
        bots as never,
      );
      return { service, maxClient };
    };

    it.each(['single', 'coalesced', 'batch'] as const)(
      'retains only its own nominal refusal through strict backoff: %s',
      async (mode) => {
        jest.useFakeTimers().setSystemTime(new Date('2026-10-31T12:00:00.000Z'));
        const f = fixture();
        f.maxClient.getChatMembersAccess.mockRejectedValueOnce(Object.freeze(localQuota()));
        const resolutions =
          mode === 'batch'
            ? [
                ...(
                  await f.service.getMembershipResolutions(
                    'channel-1',
                    ['user-1', 'user-2'],
                    'moderation_required_subscription',
                    { forceRefresh: true, botId: 'bot-1' },
                  )
                ).values(),
              ]
            : await Promise.all(
                (mode === 'single' ? ['user-1'] : ['user-1', 'user-2']).map((userId) =>
                  f.service.getMembershipResolution(
                    'channel-1',
                    userId,
                    'moderation_required_subscription',
                    { forceRefresh: true, botId: 'bot-1' },
                  ),
                ),
              );
        for (const resolution of resolutions) {
          expect(resolution).toEqual({
            membership: null,
            fresh: false,
            unavailableReason: 'membership_get_local_quota',
          });
          expect(isLocalQuotaResolution(resolution)).toBe(true);
          expect(isLocalQuotaResolution({ ...resolution })).toBe(false);
          expect(isLocalQuotaResolution(JSON.parse(JSON.stringify(resolution)))).toBe(false);
        }
        const repeated = await f.service.getMembershipResolution(
          'channel-1',
          'user-1',
          'moderation_required_subscription',
          { forceRefresh: true, botId: 'bot-1' },
        );
        expect(isLocalQuotaResolution(repeated)).toBe(true);
        const unrelatedUser = await f.service.getMembershipResolution(
          'channel-1',
          'unrelated-user',
          'moderation_required_subscription',
          { forceRefresh: true, botId: 'bot-1' },
        );
        expect(unrelatedUser).toEqual({ membership: null, fresh: false });
        expect(isLocalQuotaResolution(unrelatedUser)).toBe(false);
        expect(f.maxClient.getChatMembersAccess).toHaveBeenCalledTimes(1);

        jest.advanceTimersByTime(15_001);
        f.maxClient.getChatMembersAccess.mockResolvedValueOnce(new Map());
        const recovered = await f.service.getMembershipResolution(
          'channel-1',
          'user-1',
          'moderation_required_subscription',
          { forceRefresh: true, botId: 'bot-1' },
        );
        expect(recovered).toEqual({ membership: false, fresh: true });
        expect(isLocalQuotaResolution(recovered)).toBe(false);
        expect(f.maxClient.getChatMembersAccess).toHaveBeenCalledTimes(2);
      },
    );

    it.each([
      [
        'copied fields',
        () =>
          Object.assign(new Error('Membership read capacity unavailable'), {
            code: 'MAX_API_INTERNAL_RATE_LIMIT',
            name: 'MaxApiInternalRateLimitError',
            preDispatch: true,
          }),
      ],
      ['HTTP 429', () => Object.assign(localQuota(), { response: { status: 429 } })],
      ['empty HTTP response', () => Object.assign(localQuota(), { response: {} })],
      ['direct HTTP status', () => Object.assign(localQuota(), { status: 429 })],
      ['transport request', () => Object.assign(localQuota(), { request: {} })],
      ['lost pre-dispatch evidence', () => Object.assign(localQuota(), { preDispatch: false })],
      ['POST method', () => Object.assign(localQuota(), { config: { method: 'post' } })],
      ['DELETE method', () => Object.assign(localQuota(), { config: { method: 'delete' } })],
      ['send attempt', () => markMaxMessageSendAttempted(localQuota())],
      ['member attempt', () => markMaxMemberMutationAttempted(localQuota())],
      ['member confirmation', () => markMaxMemberMutationConfirmed(localQuota())],
      [
        'ambiguous effect',
        () => new MaxApiInternalRateLimitError('Ambiguous MAX membership effect', 250),
      ],
      [
        'generic timeout',
        () => Object.assign(new Error('Membership timeout'), { code: 'ECONNABORTED' }),
      ],
      [
        'HTTP 503',
        () => Object.assign(new Error('Membership unavailable'), { response: { status: 503 } }),
      ],
    ] as const)('does not nominate %s as its local GET refusal', async (_label, createError) => {
      const f = fixture();
      f.maxClient.getChatMembersAccess.mockRejectedValueOnce(createError());
      const result = await f.service.getMembershipResolution(
        'channel-1',
        'user-1',
        'moderation_required_subscription',
        { forceRefresh: true, botId: 'bot-1' },
      );
      expect(result).toEqual({ membership: null, fresh: false });
      expect(isLocalQuotaResolution(result)).toBe(false);
    });

    it.each(['single', 'coalesced', 'batch'] as const)(
      'does not promote the muted-user protection budget through lookup or repeated reads: %s',
      async (mode) => {
        const f = fixture();
        const error = new MaxModerationApiBudgetError('attempt_budget', 1_000);
        expect(error).toBeInstanceOf(MaxApiInternalRateLimitError);
        expect(error.preDispatch).toBe(true);
        f.maxClient.getChatMembersAccess.mockRejectedValue(error);
        const resolutions =
          mode === 'batch'
            ? [
                ...(
                  await f.service.getMembershipResolutions(
                    'channel-1',
                    ['user-1', 'user-2'],
                    'moderation_required_subscription',
                    { forceRefresh: true, botId: 'bot-1' },
                  )
                ).values(),
              ]
            : await Promise.all(
                (mode === 'single' ? ['user-1'] : ['user-1', 'user-2']).map((userId) =>
                  f.service.getMembershipResolution(
                    'channel-1',
                    userId,
                    'moderation_required_subscription',
                    { forceRefresh: true, botId: 'bot-1' },
                  ),
                ),
              );
        for (const result of resolutions) {
          expect(result).toEqual({ membership: null, fresh: false });
          expect(isLocalQuotaResolution(result)).toBe(false);
        }
        const repeated = await f.service.getMembershipResolution(
          'channel-1',
          'user-1',
          'moderation_required_subscription',
          { forceRefresh: true, botId: 'bot-1' },
        );
        expect(repeated).toEqual({ membership: null, fresh: false });
        expect(isLocalQuotaResolution(repeated)).toBe(false);
        expect(f.maxClient.getChatMembersAccess).toHaveBeenCalledTimes(2);
      },
    );

    it('does not lend a refusal to another bot or policy when legacy cache keys are shared', async () => {
      const f = fixture({ MAX_MEMBERSHIP_LOOKUP_BOT_SCOPED_CACHE_ENABLED: false });
      const pending =
        createDeferred<Awaited<ReturnType<MaxClientService['getChatMembersAccess']>>>();
      f.maxClient.getChatMembersAccess.mockReturnValueOnce(pending.promise);
      const own = f.service.getMembershipResolution('channel-1', 'user-1', 'giveaway_interactive', {
        forceRefresh: true,
        allowStaleOnError: false,
        botId: 'bot-1',
      });
      await Promise.resolve();
      await Promise.resolve();
      const otherBot = f.service.getMembershipResolution(
        'channel-1',
        'user-1',
        'giveaway_interactive',
        {
          forceRefresh: true,
          allowStaleOnError: false,
          botId: 'bot-2',
        },
      );
      pending.reject(localQuota());
      expect(isLocalQuotaResolution(await own)).toBe(true);
      expect(await otherBot).toEqual({ membership: null, fresh: false });
      expect(f.maxClient.getChatMembersAccess).toHaveBeenCalledTimes(1);
      expect(
        await f.service.getMembershipResolution('channel-1', 'user-1', 'giveaway_draw_background', {
          forceRefresh: true,
          allowStaleOnError: false,
          botId: 'bot-1',
        }),
      ).toEqual({ membership: null, fresh: false });
    });

    it('validates implicit routes before preserving legacy-cache follower and backoff provenance', async () => {
      const f = fixture();
      const pending =
        createDeferred<Awaited<ReturnType<MaxClientService['getChatMembersAccess']>>>();
      f.maxClient.getChatMembersAccess.mockReturnValueOnce(pending.promise);
      let selectedBot = 'bot-1';
      const link = { resolveBotRoute: jest.fn(async () => ({ botId: selectedBot })) };
      const service = new MaxMembershipLookupService(
        f.maxClient as never,
        createConfigMock({
          MAX_MEMBERSHIP_LOOKUP_BOT_SCOPED_CACHE_ENABLED: false,
        }) as never,
        link as never,
      );
      const own = service.getMembershipResolution(
        'channel-1',
        'user-1',
        'moderation_required_subscription',
        { forceRefresh: true },
      );
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      const follower = service.getMembershipResolution(
        'channel-1',
        'user-1',
        'moderation_required_subscription',
        { forceRefresh: true },
      );
      pending.reject(localQuota());
      expect(isLocalQuotaResolution(await own)).toBe(true);
      expect(isLocalQuotaResolution(await follower)).toBe(true);
      expect(
        isLocalQuotaResolution(
          await service.getMembershipResolution(
            'channel-1',
            'user-1',
            'moderation_required_subscription',
            { forceRefresh: true },
          ),
        ),
      ).toBe(true);
      selectedBot = 'bot-2';
      expect(
        await service.getMembershipResolution(
          'channel-1',
          'user-1',
          'moderation_required_subscription',
          { forceRefresh: true },
        ),
      ).toEqual({ membership: null, fresh: false });
      expect(f.maxClient.getChatMembersAccess).toHaveBeenCalledTimes(1);
    });

    it('drops retained provenance after membership invalidation without borrowing chat backoff', async () => {
      const f = fixture();
      f.maxClient.getChatMembersAccess.mockRejectedValueOnce(localQuota());
      expect(
        isLocalQuotaResolution(
          await f.service.getMembershipResolution(
            'channel-1',
            'user-1',
            'moderation_required_subscription',
            { forceRefresh: true, botId: 'bot-1' },
          ),
        ),
      ).toBe(true);
      await f.service.invalidateMemberships('channel-1', ['user-1']);
      expect(
        await f.service.getMembershipResolution(
          'channel-1',
          'user-1',
          'moderation_required_subscription',
          { forceRefresh: true, botId: 'bot-1' },
        ),
      ).toEqual({ membership: null, fresh: false });
      expect(f.maxClient.getChatMembersAccess).toHaveBeenCalledTimes(1);
    });

    it('does not nominate a late quota refusal after its lookup guard timed out', async () => {
      jest.useFakeTimers().setSystemTime(new Date('2026-10-31T12:00:00.000Z'));
      const f = fixture({ MAX_MEMBERSHIP_LOOKUP_TIMEOUT_MS_CRITICAL: 100 });
      const pending =
        createDeferred<Awaited<ReturnType<MaxClientService['getChatMembersAccess']>>>();
      f.maxClient.getChatMembersAccess.mockReturnValueOnce(pending.promise);
      const lookup = f.service.getMembershipResolution(
        'channel-1',
        'user-1',
        'moderation_required_subscription',
        { forceRefresh: true, botId: 'bot-1' },
      );
      await jest.advanceTimersByTimeAsync(501);
      const result = await lookup;
      expect(result).toEqual({ membership: null, fresh: false });
      pending.reject(localQuota());
      await Promise.resolve();
      await Promise.resolve();
      expect(isLocalQuotaResolution(result)).toBe(false);
      expect(
        await f.service.getMembershipResolution(
          'channel-1',
          'user-1',
          'moderation_required_subscription',
          { forceRefresh: true, botId: 'bot-1' },
        ),
      ).toEqual({ membership: null, fresh: false });
    });

    it('does not mark an invalidated in-flight refusal or restore its backoff', async () => {
      const f = fixture();
      const pending =
        createDeferred<Awaited<ReturnType<MaxClientService['getChatMembersAccess']>>>();
      f.maxClient.getChatMembersAccess
        .mockReturnValueOnce(pending.promise)
        .mockResolvedValueOnce(new Map());
      const lookup = f.service.getMembershipResolution(
        'channel-1',
        'user-1',
        'moderation_required_subscription',
        { forceRefresh: true, botId: 'bot-1' },
      );
      await Promise.resolve();
      await Promise.resolve();
      await f.service.invalidateMemberships('channel-1', ['user-1']);
      expect(
        await f.service.getMembershipResolution(
          'channel-1',
          'user-1',
          'moderation_required_subscription',
          { forceRefresh: true, botId: 'bot-1' },
        ),
      ).toEqual({ membership: false, fresh: true });
      pending.reject(localQuota());
      expect(await lookup).toEqual({ membership: null, fresh: false });
      expect(
        await f.service.getMembershipResolution(
          'channel-1',
          'user-1',
          'moderation_required_subscription',
          { botId: 'bot-1' },
        ),
      ).toEqual({ membership: false, fresh: true });
    });

    it('does not mark a superseded probe after a newer policy lookup succeeds', async () => {
      const f = fixture();
      const pending =
        createDeferred<Awaited<ReturnType<MaxClientService['getChatMembersAccess']>>>();
      f.maxClient.getChatMembersAccess
        .mockReturnValueOnce(pending.promise)
        .mockResolvedValueOnce(new Map());
      const older = f.service.getMembershipResolution(
        'channel-1',
        'user-1',
        'giveaway_interactive',
        { forceRefresh: true, allowStaleOnError: false, botId: 'bot-1' },
      );
      await Promise.resolve();
      await Promise.resolve();
      expect(
        await f.service.getMembershipResolution('channel-1', 'user-1', 'giveaway_draw_background', {
          forceRefresh: true,
          allowStaleOnError: false,
          botId: 'bot-1',
        }),
      ).toEqual({ membership: false, fresh: true });
      pending.reject(localQuota());
      expect(await older).toEqual({ membership: null, fresh: false });
      expect(
        await f.service.getMembershipResolution('channel-1', 'user-1', 'giveaway_interactive', {
          botId: 'bot-1',
        }),
      ).toEqual({ membership: false, fresh: true });
    });

    it('returns only the healthy peer result after a nominal local refusal', async () => {
      const f = fixture();
      f.maxClient.getChatMembersAccess
        .mockRejectedValueOnce(localQuota())
        .mockResolvedValueOnce(new Map());
      const link = {
        resolveBotRoute: jest
          .fn()
          .mockResolvedValueOnce({ botId: 'bot-1' })
          .mockResolvedValueOnce({ botId: 'bot-2' }),
      };
      const service = new MaxMembershipLookupService(
        f.maxClient as never,
        createConfigMock() as never,
        link as never,
      );
      const result = await service.getMembershipResolution(
        'channel-1',
        'user-1',
        'moderation_required_subscription',
        { forceRefresh: true },
      );
      expect(result).toEqual({ membership: false, fresh: true });
      expect(isLocalQuotaResolution(result)).toBe(false);
      expect(f.maxClient.getChatMembersAccess).toHaveBeenCalledTimes(2);
    });
  });

  it('backs off repeated lookups for the same chat after a transient batch failure', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-29T10:14:00.000Z'));

    const throttleError = Object.assign(new Error('MAX API rate limit exceeded'), {
      response: { status: 429, data: { message: 'MAX API rate limit exceeded' } },
    });
    const maxClient = {
      hasChatMember: jest.fn(),
      getChatMembersAccess: jest
        .fn()
        .mockRejectedValueOnce(throttleError)
        .mockResolvedValueOnce(new Map([['user-3', { userId: 'user-3', isAdmin: false }]])),
    };
    const service = new MaxMembershipLookupService(maxClient as never, createConfigMock() as never);

    await expect(
      Promise.all([
        service.getMembership('channel-1', 'user-1', 'moderation_required_subscription', {
          forceRefresh: true,
        }),
        service.getMembership('channel-1', 'user-2', 'moderation_required_subscription', {
          forceRefresh: true,
        }),
      ]),
    ).resolves.toEqual([null, null]);

    await expect(
      service.getMembership('channel-1', 'user-3', 'moderation_required_subscription'),
    ).resolves.toBeNull();

    expect(maxClient.getChatMembersAccess).toHaveBeenCalledTimes(1);

    jest.advanceTimersByTime(15_001);

    await expect(
      service.getMembership('channel-1', 'user-3', 'moderation_required_subscription'),
    ).resolves.toBe(true);

    expect(maxClient.getChatMembersAccess).toHaveBeenCalledTimes(2);
    expect(maxClient.hasChatMember).not.toHaveBeenCalled();
  });

  it('persists a terminal single-user probe without reviving rejected lifecycle state', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-29T10:14:15.000Z'));

    const deniedError = Object.assign(new Error('Request failed with status code 403'), {
      response: {
        status: 403,
        data: { code: 'chat.denied', message: 'Request failed with status code 403' },
      },
    });
    const maxClient = {
      hasChatMember: jest.fn(),
      getChatMembersAccess: jest
        .fn()
        .mockRejectedValueOnce(deniedError)
        .mockResolvedValueOnce(new Map([['user-2', { userId: 'user-2', isAdmin: false }]])),
    };
    const maxBotLinkService = {
      recordBotAccessProbe: jest.fn().mockResolvedValue(false),
    };
    const service = new MaxMembershipLookupService(
      maxClient as never,
      createConfigMock() as never,
      maxBotLinkService as never,
    );

    await expect(
      service.getMembership('channel-denied', 'user-1', 'giveaway_draw_background', {
        forceRefresh: true,
        allowStaleOnError: false,
        botId: 'bot-1',
      }),
    ).resolves.toBeNull();

    await expect(
      service.getMembership('channel-denied', 'user-2', 'giveaway_draw_background', {
        forceRefresh: true,
        allowStaleOnError: false,
        botId: 'bot-1',
      }),
    ).resolves.toBeNull();

    expect(maxClient.getChatMembersAccess).toHaveBeenCalledTimes(1);
    expect(maxBotLinkService.recordBotAccessProbe).toHaveBeenCalledTimes(1);
    expect(maxBotLinkService.recordBotAccessProbe).toHaveBeenCalledWith({
      chatId: 'channel-denied',
      botId: 'bot-1',
      access: null,
      source: 'membership_lookup_giveaway_draw_background',
      checkedAt: new Date('2026-03-29T10:14:15.000Z'),
      lastErrorCode: 'chat.denied',
      allowMembershipRecovery: false,
    });
    expect(service.getLookupIssue('channel-denied', 'giveaway_draw_background')).toEqual(
      expect.objectContaining({
        chatId: 'channel-denied',
        policyName: 'giveaway_draw_background',
        kind: 'terminal',
        retryAfterMs: 30 * 60 * 1_000,
        statusCode: 403,
      }),
    );

    jest.advanceTimersByTime(30 * 60 * 1_000 + 1);

    await expect(
      service.getMembership('channel-denied', 'user-2', 'giveaway_draw_background', {
        forceRefresh: true,
        allowStaleOnError: false,
        botId: 'bot-1',
      }),
    ).resolves.toBe(true);

    expect(maxClient.getChatMembersAccess).toHaveBeenCalledTimes(2);
    expect(maxClient.hasChatMember).not.toHaveBeenCalled();
  });

  it('persists a terminal multi-user probe before strict required subscription backoff', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-29T10:15:00.000Z'));

    const deniedError = Object.assign(new Error('Request failed with status code 404'), {
      response: {
        status: 404,
        data: { code: 'chat.not.found', message: 'Request failed with status code 404' },
      },
    });
    const maxClient = {
      hasChatMember: jest.fn(),
      getChatMembersAccess: jest
        .fn()
        .mockRejectedValueOnce(deniedError)
        .mockResolvedValueOnce(new Map([['user-3', { userId: 'user-3', isAdmin: false }]])),
    };
    const runtimeDiagnosticsService = {
      recordMembershipBackoff: jest.fn(),
      recordMembershipIssue: jest.fn(),
    };
    const maxBotLinkService = {
      recordBotAccessProbe: jest.fn().mockResolvedValue(true),
    };
    const service = new MaxMembershipLookupService(
      maxClient as never,
      createConfigMock({
        MAX_MEMBERSHIP_LOOKUP_REQUIRED_SUBSCRIPTION_TERMINAL_BACKOFF_MS: 60_000,
      }) as never,
      maxBotLinkService as never,
      undefined,
      runtimeDiagnosticsService as never,
    );

    await expect(
      service.getMemberships(
        'channel-denied',
        ['user-1', 'user-2'],
        'moderation_required_subscription',
        {
          forceRefresh: true,
          allowStaleOnError: false,
          botId: 'bot-1',
        },
      ),
    ).resolves.toEqual(
      new Map([
        ['user-1', null],
        ['user-2', null],
      ]),
    );

    expect(maxClient.getChatMembersAccess).toHaveBeenCalledWith(
      'channel-denied',
      ['user-1', 'user-2'],
      {
        trafficClass: 'critical',
        timeoutMs: 1_500,
        bypassCache: true,
        sourceTag: 'required_subscription_membership',
        ignoreFailureMetricStatuses: [403, 404],
        botId: 'bot-1',
      },
    );

    await expect(
      service.getMembership('channel-denied', 'user-3', 'moderation_required_subscription', {
        forceRefresh: true,
        allowStaleOnError: false,
        botId: 'bot-1',
      }),
    ).resolves.toBeNull();

    expect(maxClient.getChatMembersAccess).toHaveBeenCalledTimes(1);
    expect(maxBotLinkService.recordBotAccessProbe).toHaveBeenCalledTimes(1);
    expect(maxBotLinkService.recordBotAccessProbe).toHaveBeenCalledWith({
      chatId: 'channel-denied',
      botId: 'bot-1',
      access: null,
      source: 'membership_lookup_moderation_required_subscription',
      checkedAt: new Date('2026-03-29T10:15:00.000Z'),
      lastErrorCode: 'chat.not.found',
      allowMembershipRecovery: false,
    });
    expect(service.getLookupIssue('channel-denied', 'moderation_required_subscription')).toEqual(
      expect.objectContaining({
        chatId: 'channel-denied',
        policyName: 'moderation_required_subscription',
        kind: 'terminal',
        retryAfterMs: 60_000,
        statusCode: 404,
      }),
    );
    expect(runtimeDiagnosticsService.recordMembershipBackoff).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: 'channel-denied',
        policyName: 'moderation_required_subscription',
        retryAfterMs: 60_000,
      }),
    );
    expect(runtimeDiagnosticsService.recordMembershipIssue).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: 'channel-denied',
        policyName: 'moderation_required_subscription',
        kind: 'terminal',
        retryAfterMs: 60_000,
      }),
    );

    jest.advanceTimersByTime(60_001);

    await expect(
      service.getMembership('channel-denied', 'user-3', 'moderation_required_subscription', {
        forceRefresh: true,
        allowStaleOnError: false,
        botId: 'bot-1',
      }),
    ).resolves.toBe(true);

    expect(maxClient.getChatMembersAccess).toHaveBeenCalledTimes(2);
    expect(maxClient.hasChatMember).not.toHaveBeenCalled();
  });

  it('fails open instead of hanging the caller when a membership batch lookup never resolves', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-29T10:14:30.000Z'));

    const maxClient = {
      hasChatMember: jest.fn(),
      getChatMembersAccess: jest.fn().mockImplementation(
        () =>
          new Promise<Map<string, { userId: string; isAdmin: boolean }>>(() => {
            // Intentionally never resolves to simulate a transport/runtime hang.
          }),
      ),
    };
    const service = new MaxMembershipLookupService(
      maxClient as never,
      createConfigMock({
        MAX_MEMBERSHIP_LOOKUP_TIMEOUT_MS_CRITICAL: 50,
      }) as never,
    );

    const lookup = service.getMembership(
      'channel-hang',
      'user-hang',
      'moderation_required_subscription',
      {
        forceRefresh: true,
      },
    );

    await Promise.resolve();
    await jest.advanceTimersByTimeAsync(801);

    await expect(lookup).resolves.toBeNull();
    expect(maxClient.getChatMembersAccess).toHaveBeenCalledTimes(1);
    expect(maxClient.hasChatMember).not.toHaveBeenCalled();
  });

  it('extends chat backoff after consecutive transient failures on the same moderation channel', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-29T10:14:00.000Z'));

    const throttleError = Object.assign(new Error('MAX API rate limit exceeded'), {
      response: { status: 429, data: { message: 'MAX API rate limit exceeded' } },
    });
    const maxClient = {
      hasChatMember: jest.fn(),
      getChatMembersAccess: jest
        .fn()
        .mockRejectedValueOnce(throttleError)
        .mockRejectedValueOnce(throttleError)
        .mockResolvedValueOnce(new Map([['user-4', { userId: 'user-4', isAdmin: false }]])),
    };
    const service = new MaxMembershipLookupService(
      maxClient as never,
      createConfigMock({
        MAX_MEMBERSHIP_LOOKUP_HOT_CHANNEL_BATCH_WINDOW_MS: 0,
      }) as never,
    );

    await expect(
      service.getMembership('channel-hot', 'user-1', 'moderation_required_subscription', {
        forceRefresh: true,
      }),
    ).resolves.toBeNull();

    jest.advanceTimersByTime(15_001);

    await expect(
      service.getMembership('channel-hot', 'user-2', 'moderation_required_subscription', {
        forceRefresh: true,
      }),
    ).resolves.toBeNull();

    await expect(
      service.getMembership('channel-hot', 'user-3', 'moderation_required_subscription'),
    ).resolves.toBeNull();

    expect(maxClient.getChatMembersAccess).toHaveBeenCalledTimes(2);

    jest.advanceTimersByTime(29_999);

    await expect(
      service.getMembership('channel-hot', 'user-4', 'moderation_required_subscription'),
    ).resolves.toBeNull();

    expect(maxClient.getChatMembersAccess).toHaveBeenCalledTimes(2);

    jest.advanceTimersByTime(2);

    await expect(
      service.getMembership('channel-hot', 'user-4', 'moderation_required_subscription'),
    ).resolves.toBe(true);

    expect(maxClient.getChatMembersAccess).toHaveBeenCalledTimes(3);
    expect(maxClient.hasChatMember).not.toHaveBeenCalled();
  });

  it('does not return stale required-subscription membership on transient errors, but still allows it for interactive policies', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-29T10:15:00.000Z'));

    const maxClient = {
      hasChatMember: jest.fn(),
      getChatMembersAccess: jest
        .fn()
        .mockResolvedValueOnce(new Map([['user-3', { userId: 'user-3', isAdmin: false }]]))
        .mockRejectedValueOnce(
          Object.assign(new Error('MAX API rate limit exceeded'), {
            response: { status: 429, data: { message: 'MAX API rate limit exceeded' } },
          }),
        )
        .mockRejectedValueOnce(
          Object.assign(new Error('MAX API rate limit exceeded'), {
            response: { status: 429, data: { message: 'MAX API rate limit exceeded' } },
          }),
        ),
    };
    const service = new MaxMembershipLookupService(maxClient as never, createConfigMock() as never);

    await expect(
      service.getMembership('channel-1', 'user-3', 'moderation_required_subscription'),
    ).resolves.toBe(true);

    jest.advanceTimersByTime(20_000);

    await expect(
      service.getMembership('channel-1', 'user-3', 'moderation_required_subscription', {
        forceRefresh: true,
      }),
    ).resolves.toBeNull();

    await expect(
      service.getMembership('channel-1', 'user-3', 'giveaway_interactive', {
        forceRefresh: true,
      }),
    ).resolves.toBe(true);
  });

  it('returns stale background giveaway membership when a retained positive snapshot exists', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-29T10:15:00.000Z'));

    const maxClient = {
      hasChatMember: jest.fn(),
      getChatMembersAccess: jest
        .fn()
        .mockResolvedValueOnce(new Map([['user-3', { userId: 'user-3', isAdmin: false }]]))
        .mockRejectedValueOnce(
          Object.assign(new Error('MAX API rate limit exceeded'), {
            response: { status: 429, data: { message: 'MAX API rate limit exceeded' } },
          }),
        ),
    };
    const service = new MaxMembershipLookupService(maxClient as never, createConfigMock() as never);

    await expect(
      service.getMembership('channel-1', 'user-3', 'giveaway_draw_background', {
        forceRefresh: true,
        allowStaleOnError: false,
      }),
    ).resolves.toBe(true);

    jest.advanceTimersByTime(11_000);

    await expect(
      service.getMembership('channel-1', 'user-3', 'giveaway_draw_background', {
        forceRefresh: true,
        allowStaleOnError: true,
      }),
    ).resolves.toBe(true);
  });

  it('extends positive moderation freshness on hot channels after repeated transient failures', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-29T10:16:00.000Z'));

    const throttleError = Object.assign(new Error('MAX API rate limit exceeded'), {
      response: { status: 429, data: { message: 'MAX API rate limit exceeded' } },
    });
    const maxClient = {
      hasChatMember: jest.fn(),
      getChatMembersAccess: jest
        .fn()
        .mockResolvedValueOnce(
          new Map([['user-stale-positive', { userId: 'user-stale-positive', isAdmin: false }]]),
        )
        .mockRejectedValueOnce(throttleError)
        .mockRejectedValueOnce(throttleError),
    };
    const service = new MaxMembershipLookupService(maxClient as never, createConfigMock() as never);

    await expect(
      service.getMembership(
        'channel-hot-mode',
        'user-stale-positive',
        'moderation_required_subscription',
      ),
    ).resolves.toBe(true);

    jest.advanceTimersByTime(61_000);

    await expect(
      service.getMembership(
        'channel-hot-mode',
        'user-trigger-1',
        'moderation_required_subscription',
        {
          forceRefresh: true,
        },
      ),
    ).resolves.toBeNull();
    jest.advanceTimersByTime(15_001);
    await expect(
      service.getMembership(
        'channel-hot-mode',
        'user-trigger-2',
        'moderation_required_subscription',
        {
          forceRefresh: true,
        },
      ),
    ).resolves.toBeNull();

    await expect(
      service.getMembership(
        'channel-hot-mode',
        'user-stale-positive',
        'moderation_required_subscription',
      ),
    ).resolves.toBe(true);

    expect(maxClient.getChatMembersAccess).toHaveBeenCalledTimes(3);
    expect(maxClient.hasChatMember).not.toHaveBeenCalled();
  });

  it('drops stale negative moderation snapshots in hot-channel mode and fails open instead', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-29T10:17:00.000Z'));

    const timeoutError = Object.assign(new Error('timeout of 2000ms exceeded'), {
      code: 'ECONNABORTED',
    });
    const maxClient = {
      hasChatMember: jest.fn(),
      getChatMembersAccess: jest
        .fn()
        .mockResolvedValueOnce(new Map())
        .mockRejectedValueOnce(timeoutError)
        .mockRejectedValueOnce(timeoutError),
    };
    const service = new MaxMembershipLookupService(maxClient as never, createConfigMock() as never);

    await expect(
      service.getMembership(
        'channel-hot-negative',
        'user-stale-negative',
        'moderation_required_subscription',
      ),
    ).resolves.toBe(false);

    jest.advanceTimersByTime(11_000);

    await expect(
      service.getMembership(
        'channel-hot-negative',
        'user-trigger-1',
        'moderation_required_subscription',
        { forceRefresh: true },
      ),
    ).resolves.toBeNull();
    jest.advanceTimersByTime(15_001);
    await expect(
      service.getMembership(
        'channel-hot-negative',
        'user-trigger-2',
        'moderation_required_subscription',
        { forceRefresh: true },
      ),
    ).resolves.toBeNull();

    await expect(
      service.getMembership(
        'channel-hot-negative',
        'user-stale-negative',
        'moderation_required_subscription',
      ),
    ).resolves.toBeNull();

    expect(maxClient.getChatMembersAccess).toHaveBeenCalledTimes(3);
    expect(maxClient.hasChatMember).not.toHaveBeenCalled();
  });

  it('invalidates cached membership snapshots and forces a fresh lookup', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-29T10:20:00.000Z'));

    const maxClient = {
      hasChatMember: jest.fn(),
      getChatMembersAccess: jest
        .fn()
        .mockResolvedValueOnce(new Map([['user-4', { userId: 'user-4', isAdmin: false }]]))
        .mockResolvedValueOnce(new Map()),
    };
    const service = new MaxMembershipLookupService(maxClient as never, createConfigMock() as never);

    await expect(
      service.getMembership('channel-1', 'user-4', 'giveaway_interactive'),
    ).resolves.toBe(true);
    await service.invalidateMemberships('channel-1', ['user-4']);
    await expect(
      service.getMembership('channel-1', 'user-4', 'giveaway_interactive'),
    ).resolves.toBe(false);

    expect(maxClient.getChatMembersAccess).toHaveBeenCalledTimes(2);
    expect(maxClient.hasChatMember).not.toHaveBeenCalled();
  });

  it('does not let an already-dispatched Redis write repopulate an invalidated snapshot', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-29T10:22:00.000Z'));

    const writerMaxClient = {
      hasChatMember: jest.fn(),
      getChatMembersAccess: jest
        .fn()
        .mockResolvedValueOnce(
          new Map([['user-delayed-write', { userId: 'user-delayed-write', isAdmin: false }]]),
        )
        .mockResolvedValueOnce(new Map()),
    };
    const writerService = new MaxMembershipLookupService(
      writerMaxClient as never,
      createConfigMock() as never,
    );
    const writerRedis = (Redis as unknown as jest.Mock).mock.results.at(-1)?.value as {
      eval: jest.Mock;
    };
    const originalEval = writerRedis.eval.getMockImplementation() as
      | ((...args: Array<string | number>) => Promise<unknown>)
      | undefined;
    if (!originalEval) {
      throw new Error('Expected Redis eval mock implementation');
    }
    let releaseWrite: (() => void) | null = null;
    const writeGate = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    writerRedis.eval.mockImplementation(async (...args: Array<string | number>) => {
      if (String(args[0]).includes('membership-cache-compare-and-set-v1')) {
        await writeGate;
      }
      return originalEval(...args);
    });

    await expect(
      writerService.getMembership(
        'channel-delayed-write',
        'user-delayed-write',
        'giveaway_interactive',
      ),
    ).resolves.toBe(true);
    const delayedWrite = writerRedis.eval.mock.results[0]?.value as Promise<unknown>;

    jest.advanceTimersByTime(1);
    const invalidatorService = new MaxMembershipLookupService(
      { hasChatMember: jest.fn(), getChatMembersAccess: jest.fn() } as never,
      createConfigMock({ MAX_MEMBERSHIP_LOOKUP_HOT_CHANNEL_POSITIVE_TTL_SEC: 300 }) as never,
    );
    const invalidatorRedis = (Redis as unknown as jest.Mock).mock.results.at(-1)?.value as {
      eval: jest.Mock;
    };
    await invalidatorService.invalidateMemberships('channel-delayed-write', ['user-delayed-write']);
    const invalidationCall = invalidatorRedis.eval.mock.calls[0] as Array<string | number>;
    expect(invalidationCall[Number(invalidationCall[1]) + 3]).toBe('420000');

    const finishWrite = releaseWrite as (() => void) | null;
    if (!finishWrite) {
      throw new Error('Expected delayed Redis write resolver');
    }
    finishWrite();
    await delayedWrite;
    await Promise.resolve();

    expect(
      readRedisMembershipSnapshot('max:membership:v1:channel-delayed-write:user-delayed-write'),
    ).toBeNull();
    await expect(
      writerService.getMembership(
        'channel-delayed-write',
        'user-delayed-write',
        'giveaway_interactive',
      ),
    ).resolves.toBe(false);
    expect(writerMaxClient.getChatMembersAccess).toHaveBeenCalledTimes(2);
  });

  it('ignores a Redis membership snapshot read before invalidation', async () => {
    let resolveRedisRead: ((values: Array<string | null>) => void) | null = null;
    const maxClient = {
      hasChatMember: jest.fn(),
      getChatMembersAccess: jest.fn().mockResolvedValue(new Map()),
    };
    const service = new MaxMembershipLookupService(maxClient as never, createConfigMock() as never);
    const redisInstance = (Redis as unknown as jest.Mock).mock.results.at(-1)?.value as {
      mget: jest.Mock;
    };
    redisInstance.mget.mockImplementationOnce(
      () =>
        new Promise<Array<string | null>>((resolve) => {
          resolveRedisRead = resolve;
        }),
    );

    const pendingLookup = service.getMembership(
      'channel-redis-race',
      'user-redis-race',
      'moderation_required_subscription',
    );
    await Promise.resolve();
    expect(redisInstance.mget).toHaveBeenCalledTimes(1);

    await service.invalidateMemberships('channel-redis-race', ['user-redis-race']);

    const finishRedisRead = resolveRedisRead as ((values: Array<string | null>) => void) | null;
    if (!finishRedisRead) {
      throw new Error('Expected deferred Redis membership read resolver');
    }
    finishRedisRead([
      JSON.stringify({
        isMember: true,
        checkedAtMs: Date.now(),
      }),
    ]);

    await expect(pendingLookup).resolves.toBe(false);
    expect(maxClient.getChatMembersAccess).toHaveBeenCalledTimes(1);
    expect(maxClient.getChatMembersAccess).toHaveBeenCalledWith(
      'channel-redis-race',
      ['user-redis-race'],
      expect.objectContaining({ bypassCache: true }),
    );
  });

  it('bypasses the MAX client cache after a membership invalidation', async () => {
    let remoteIsMember = true;
    const staleInnerAccess = new Map([['user-left', { userId: 'user-left', isAdmin: false }]]);
    const maxClient = {
      hasChatMember: jest.fn(),
      getChatMembersAccess: jest.fn(
        async (
          _chatId: string,
          _userIds: readonly string[],
          options: { bypassCache?: boolean },
        ) => {
          if (!options.bypassCache) {
            return staleInnerAccess;
          }

          return remoteIsMember ? staleInnerAccess : new Map();
        },
      ),
    };
    const service = new MaxMembershipLookupService(maxClient as never, createConfigMock() as never);

    await expect(
      service.getMembership('channel-required', 'user-left', 'moderation_required_subscription'),
    ).resolves.toBe(true);

    remoteIsMember = false;
    await service.invalidateMemberships('channel-required', ['user-left']);

    await expect(
      service.getMembership('channel-required', 'user-left', 'moderation_required_subscription'),
    ).resolves.toBe(false);

    expect(maxClient.getChatMembersAccess).toHaveBeenCalledTimes(2);
    expect(maxClient.getChatMembersAccess).toHaveBeenNthCalledWith(
      2,
      'channel-required',
      ['user-left'],
      expect.objectContaining({ bypassCache: true }),
    );
  });

  it('starts a fresh lookup instead of reusing an invalidated in-flight promise', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-29T10:25:00.000Z'));

    let resolveLookup: ((value: Map<string, { userId: string; isAdmin: boolean }>) => void) | null =
      null;
    const maxClient = {
      hasChatMember: jest.fn(),
      getChatMembersAccess: jest
        .fn()
        .mockImplementationOnce(
          () =>
            new Promise<Map<string, { userId: string; isAdmin: boolean }>>((resolve) => {
              resolveLookup = resolve;
            }),
        )
        .mockResolvedValueOnce(new Map()),
    };
    const service = new MaxMembershipLookupService(maxClient as never, createConfigMock() as never);

    const pendingLookup = service.getMembership('channel-1', 'user-5', 'giveaway_interactive', {
      forceRefresh: true,
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(maxClient.getChatMembersAccess).toHaveBeenCalledTimes(1);

    await service.invalidateMemberships('channel-1', ['user-5']);
    await expect(
      service.getMembership('channel-1', 'user-5', 'giveaway_interactive'),
    ).resolves.toBe(false);

    const finishLookup = resolveLookup as
      | ((value: Map<string, { userId: string; isAdmin: boolean }>) => void)
      | null;
    if (!finishLookup) {
      throw new Error('Expected pending membership lookup resolver');
    }
    finishLookup(new Map([['user-5', { userId: 'user-5', isAdmin: false }]]));
    await expect(pendingLookup).resolves.toBeNull();

    await expect(
      service.getMembership('channel-1', 'user-5', 'giveaway_interactive'),
    ).resolves.toBe(false);

    expect(maxClient.getChatMembersAccess).toHaveBeenCalledTimes(2);
    expect(maxClient.hasChatMember).not.toHaveBeenCalled();
  });

  it('settles a pending batch lookup before starting a replacement after invalidation', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-29T10:27:00.000Z'));

    const maxClient = {
      hasChatMember: jest.fn(),
      getChatMembersAccess: jest.fn().mockResolvedValue(new Map()),
    };
    const service = new MaxMembershipLookupService(
      maxClient as never,
      createConfigMock({ MAX_MEMBERSHIP_LOOKUP_BATCH_WINDOW_MS: 25 }) as never,
    );

    const invalidatedLookup = service.getMembership(
      'channel-pending',
      'user-pending',
      'moderation_required_subscription',
      { forceRefresh: true },
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(maxClient.getChatMembersAccess).not.toHaveBeenCalled();

    await service.invalidateMemberships('channel-pending', ['user-pending']);
    await expect(invalidatedLookup).resolves.toBeNull();

    const replacementLookup = service.getMembership(
      'channel-pending',
      'user-pending',
      'moderation_required_subscription',
      { forceRefresh: true },
    );
    await Promise.resolve();
    await Promise.resolve();
    await jest.advanceTimersByTimeAsync(25);

    await expect(replacementLookup).resolves.toBe(false);
    expect(maxClient.getChatMembersAccess).toHaveBeenCalledTimes(1);
  });

  it('does not cancel a replacement lookup on a reordered invalidation self-echo', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-29T10:27:30.000Z'));

    const maxClient = {
      hasChatMember: jest.fn(),
      getChatMembersAccess: jest.fn().mockResolvedValue(new Map()),
    };
    const service = new MaxMembershipLookupService(
      maxClient as never,
      createConfigMock({ MAX_MEMBERSHIP_LOOKUP_BATCH_WINDOW_MS: 25 }) as never,
    );
    const redisInstance = (Redis as unknown as jest.Mock).mock.results.at(-1)?.value as {
      eval: jest.Mock;
    };
    await service.onModuleInit();
    await service.invalidateMemberships('channel-invalidation-echo', ['user-invalidation-echo']);
    const publishedPayload = String(redisInstance.eval.mock.calls[0]?.at(-1));

    const replacementLookup = service.getMembership(
      'channel-invalidation-echo',
      'user-invalidation-echo',
      'moderation_required_subscription',
      { forceRefresh: true },
    );
    const subscribers = (
      Redis as unknown as {
        __subscribers: Set<(channel: string, payload: string) => void>;
      }
    ).__subscribers;
    for (const subscriber of subscribers) {
      subscriber('max:membership:invalidate:v1', publishedPayload);
    }

    await jest.advanceTimersByTimeAsync(25);
    await expect(replacementLookup).resolves.toBe(false);
    expect(maxClient.getChatMembersAccess).toHaveBeenCalledTimes(1);

    await service.onModuleDestroy();
  });

  it('does not merge two real invalidations created in the same millisecond', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-29T10:27:45.000Z'));

    const maxClient = {
      hasChatMember: jest.fn(),
      getChatMembersAccess: jest.fn(),
    };
    const service = new MaxMembershipLookupService(
      maxClient as never,
      createConfigMock({ MAX_MEMBERSHIP_LOOKUP_BATCH_WINDOW_MS: 25 }) as never,
    );
    await service.onModuleInit();
    await service.invalidateMemberships('channel-double-invalidation', [
      'user-double-invalidation',
    ]);

    const replacementLookup = service.getMembership(
      'channel-double-invalidation',
      'user-double-invalidation',
      'moderation_required_subscription',
      { forceRefresh: true },
    );
    await service.invalidateMemberships('channel-double-invalidation', [
      'user-double-invalidation',
    ]);

    await expect(replacementLookup).resolves.toBeNull();
    await jest.advanceTimersByTimeAsync(25);
    expect(maxClient.getChatMembersAccess).not.toHaveBeenCalled();

    await service.onModuleDestroy();
  });

  it('keeps strict and stale-tolerant moderation waiters separate inside the batch window', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-29T10:28:00.000Z'));

    const maxClient = {
      hasChatMember: jest.fn(),
      getChatMembersAccess: jest.fn().mockResolvedValue(new Map()),
    };
    const service = new MaxMembershipLookupService(
      maxClient as never,
      createConfigMock({ MAX_MEMBERSHIP_LOOKUP_BATCH_WINDOW_MS: 25 }) as never,
    );

    const staleTolerantLookup = service.getMembership(
      'channel-mixed-policy',
      'user-mixed-policy',
      'moderation_required_subscription',
      { forceRefresh: true, allowStaleOnError: true },
    );
    const strictLookup = service.getMembership(
      'channel-mixed-policy',
      'user-mixed-policy',
      'moderation_required_subscription',
      { forceRefresh: true, allowStaleOnError: false },
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(maxClient.getChatMembersAccess).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(25);

    await expect(Promise.all([staleTolerantLookup, strictLookup])).resolves.toEqual([false, false]);
    expect(maxClient.getChatMembersAccess).toHaveBeenCalledTimes(2);
  });

  it('propagates membership invalidations across instances via Redis pub/sub', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-29T10:30:00.000Z'));

    const maxClientA = {
      hasChatMember: jest.fn(),
      getChatMembersAccess: jest
        .fn()
        .mockResolvedValueOnce(new Map([['user-6', { userId: 'user-6', isAdmin: false }]]))
        .mockResolvedValueOnce(new Map()),
    };
    const maxClientB = {
      hasChatMember: jest.fn(),
      getChatMembersAccess: jest.fn(),
    };
    const serviceA = new MaxMembershipLookupService(
      maxClientA as never,
      createConfigMock() as never,
    );
    const serviceB = new MaxMembershipLookupService(
      maxClientB as never,
      createConfigMock() as never,
    );

    await serviceA.onModuleInit();
    await serviceB.onModuleInit();

    await expect(
      serviceA.getMembership('channel-1', 'user-6', 'giveaway_interactive'),
    ).resolves.toBe(true);

    await serviceB.invalidateMemberships('channel-1', ['user-6']);

    await expect(
      serviceA.getMembership('channel-1', 'user-6', 'giveaway_interactive'),
    ).resolves.toBe(false);

    expect(maxClientA.getChatMembersAccess).toHaveBeenCalledTimes(2);
    expect(maxClientA.hasChatMember).not.toHaveBeenCalled();
    expect(maxClientB.hasChatMember).not.toHaveBeenCalled();

    await serviceA.onModuleDestroy();
    await serviceB.onModuleDestroy();
  });
});
