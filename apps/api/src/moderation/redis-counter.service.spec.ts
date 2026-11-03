import type Redis from 'ioredis';
import type { Callback, RedisKey, RedisValue } from 'ioredis';
import {
  DUPLICATE_WINDOW_MAX_OUTSTANDING,
  DuplicateWindowCapacityError,
  RedisCounterService,
  isRedisCounterPreDispatchUnavailable,
} from './redis-counter.service';
import { MessageDuplicateHistoryService } from './message-duplicate/message-duplicate-history.service';

type RedisEvalArguments = [
  script: Parameters<Redis['eval']>[0],
  numkeys: Parameters<Redis['eval']>[1],
  ...args: Array<RedisValue | RedisKey[] | Callback<unknown> | undefined>,
];

function createService(evalResult: unknown) {
  const redis: jest.Mocked<Pick<Redis, 'status' | 'get'>> & {
    eval: jest.Mock<ReturnType<Redis['eval']>, RedisEvalArguments>;
  } = {
    status: 'ready',
    eval: jest.fn<ReturnType<Redis['eval']>, RedisEvalArguments>().mockResolvedValue(evalResult),
    get: jest.fn<ReturnType<Redis['get']>, Parameters<Redis['get']>>().mockResolvedValue(null),
  } satisfies Pick<Redis, 'status' | 'eval' | 'get'>;
  const service = Object.create(RedisCounterService.prototype) as RedisCounterService;
  Object.defineProperty(service, 'redis', { value: redis });
  Object.defineProperty(service, 'duplicateWindowOutstanding', { value: 0, writable: true });
  return { redis, service };
}

describe('RedisCounterService pre-dispatch admission', () => {
  const cooldown = (): Parameters<RedisCounterService['claimEventCooldown']>[0] => ({
    key: 'cooldown-key',
    memberKey: 'cooldown-member',
    eventTimestampMs: Date.now(),
    windowSeconds: 60,
    deadlineAtMs: Date.now() + 10_000,
    requireReadyBeforeDispatch: true,
  });
  const membership = (): Parameters<
    RedisCounterService['replaceRevisionedSetMembershipsBeforeDeadline']
  >[0] => ({
    stateKey: 'state-key',
    member: 'member',
    revision: 20,
    membershipKeys: ['membership-key'],
    windowSeconds: 60,
    ttlSeconds: 61,
    deadlineAtMs: Date.now() + 10_000,
    requireReadyBeforeDispatch: true,
  });
  const captureError = async (operation: Promise<unknown>): Promise<Error> => {
    try {
      await operation;
    } catch (error) {
      if (error instanceof Error) return error;
      throw error;
    }
    throw new Error('Expected the counter operation to reject');
  };
  const invoke = (service: RedisCounterService, kind: 'cooldown' | 'membership') =>
    kind === 'cooldown'
      ? service.claimEventCooldown(cooldown())
      : service.replaceRevisionedSetMembershipsBeforeDeadline(membership());

  it.each<Redis['status']>(['wait', 'reconnecting', 'connecting', 'connect', 'close', 'end'])(
    'refuses %s before GET or EVAL and brands only the actual errors',
    async (status) => {
      for (const kind of ['cooldown', 'membership'] as const) {
        const { redis, service } = createService(null);
        redis.status = status;
        const error = await captureError(invoke(service, kind));
        expect(isRedisCounterPreDispatchUnavailable(error)).toBe(true);
        expect(redis.get).not.toHaveBeenCalled();
        expect(redis.eval).not.toHaveBeenCalled();
        for (const forged of [
          new Error(error.message),
          Object.assign(new Error(error.message), error),
          Object.create(error),
          { ...error, name: error.name, message: error.message, preDispatch: true },
          null,
        ]) {
          expect(isRedisCounterPreDispatchUnavailable(forged)).toBe(false);
        }
      }
    },
  );

  it('preserves input errors and the existing membership deadline before admission', async () => {
    const { redis, service } = createService(null);
    redis.status = 'end';
    for (const operation of [
      service.claimEventCooldown({ ...cooldown(), key: '' }),
      service.replaceRevisionedSetMembershipsBeforeDeadline({ ...membership(), member: '' }),
    ]) {
      const error = await captureError(operation);
      expect(isRedisCounterPreDispatchUnavailable(error)).toBe(false);
      expect(error.message).toMatch(/input/i);
    }
    await expect(
      service.replaceRevisionedSetMembershipsBeforeDeadline({
        ...membership(),
        deadlineAtMs: Date.now() - 1,
      }),
    ).resolves.toEqual({ kind: 'deadline_exceeded' });
    expect(redis.get).not.toHaveBeenCalled();
    expect(redis.eval).not.toHaveBeenCalled();
  });

  it('rechecks readiness after GET and refuses the first mutation', async () => {
    const { redis, service } = createService([1, 1]);
    redis.get.mockImplementationOnce(async () => {
      redis.status = 'reconnecting';
      return null;
    });
    const error = await captureError(
      service.replaceRevisionedSetMembershipsBeforeDeadline(membership()),
    );
    expect(isRedisCounterPreDispatchUnavailable(error)).toBe(true);
    expect(redis.get).toHaveBeenCalledTimes(1);
    expect(redis.eval).not.toHaveBeenCalled();
  });

  it.each(['NOAUTH', 'WRONGTYPE', 'connection lost'])(
    'preserves an actual GET rejection: %s',
    async (message) => {
      const { redis, service } = createService([1, 1]);
      const error = new Error(message);
      redis.get.mockRejectedValueOnce(error);
      await expect(
        service.replaceRevisionedSetMembershipsBeforeDeadline(membership()),
      ).rejects.toBe(error);
      expect(isRedisCounterPreDispatchUnavailable(error)).toBe(false);
      expect(redis.eval).not.toHaveBeenCalled();
    },
  );

  it.each(['cooldown', 'membership'] as const)(
    'preserves synchronous and asynchronous %s EVAL failures after admission',
    async (kind) => {
      for (const synchronous of [true, false]) {
        const { redis, service } = createService(null);
        const error = new Error('EVAL response lost');
        redis.eval.mockImplementationOnce(() => {
          redis.status = 'end';
          if (synchronous) throw error;
          return Promise.reject(error);
        });
        await expect(invoke(service, kind)).rejects.toBe(error);
        expect(isRedisCounterPreDispatchUnavailable(error)).toBe(false);
        expect(redis.eval).toHaveBeenCalledTimes(1);
      }
    },
  );

  it('never brands readiness loss after a mutating CAS attempt', async () => {
    const { redis, service } = createService([2]);
    redis.eval.mockImplementationOnce(async () => {
      redis.status = 'reconnecting';
      return [2];
    });
    const error = await captureError(
      service.replaceRevisionedSetMembershipsBeforeDeadline(membership()),
    );
    expect(isRedisCounterPreDispatchUnavailable(error)).toBe(false);
    expect(error.message).toMatch(/after a mutation dispatch/);
    expect(redis.get).toHaveBeenCalledTimes(1);
    expect(redis.eval).toHaveBeenCalledTimes(1);
  });

  it('preserves readonly verification errors and malformed state/results', async () => {
    const replay = createService(1);
    replay.redis.get.mockResolvedValue(
      JSON.stringify({
        v: 1,
        revision: 20,
        memberships: { 'membership-key': 1 },
      }),
    );
    const error = new Error('readonly verification failed');
    replay.redis.eval.mockRejectedValueOnce(error);
    await expect(
      replay.service.replaceRevisionedSetMembershipsBeforeDeadline(membership()),
    ).rejects.toBe(error);
    expect(isRedisCounterPreDispatchUnavailable(error)).toBe(false);

    const corrupt = createService([1, 1]);
    corrupt.redis.get.mockResolvedValue('{broken');
    const parseError = await captureError(
      corrupt.service.replaceRevisionedSetMembershipsBeforeDeadline(membership()),
    );
    expect(isRedisCounterPreDispatchUnavailable(parseError)).toBe(false);
    expect(corrupt.redis.eval).not.toHaveBeenCalled();
    for (const kind of ['cooldown', 'membership'] as const) {
      const invalid = createService(kind === 'cooldown' ? 100 : [1, -1]);
      const resultError = await captureError(invoke(invalid.service, kind));
      expect(isRedisCounterPreDispatchUnavailable(resultError)).toBe(false);
      expect(resultError.message).toMatch(/invalid/);
    }
  });

  it.each([undefined, false])(
    'preserves existing callers when admission is %s',
    async (requireReadyBeforeDispatch) => {
      const claim = createService(1);
      claim.redis.status = 'connecting';
      await expect(
        claim.service.claimEventCooldown({ ...cooldown(), requireReadyBeforeDispatch }),
      ).resolves.toBe('allowed');
      expect(claim.redis.eval).toHaveBeenCalledTimes(1);
      const counter = createService([1, 1]);
      counter.redis.status = 'connecting';
      await expect(
        counter.service.replaceRevisionedSetMembershipsBeforeDeadline({
          ...membership(),
          requireReadyBeforeDispatch,
        }),
      ).resolves.toEqual({ kind: 'applied', counts: [1] });
      expect(counter.redis.get).toHaveBeenCalledTimes(1);
      expect(counter.redis.eval).toHaveBeenCalledTimes(1);
    },
  );
});

describe('duplicate window Redis capacity', () => {
  afterEach(() => jest.useRealTimers());

  it('retains slots after caller timeout, rejects before dispatch and releases on actual settlement', async () => {
    jest.useFakeTimers();
    const { redis, service } = createService(null);
    const pending: Array<{ resolve: (value: string) => void; reject: (error: Error) => void }> = [];
    redis.eval.mockImplementation(
      () =>
        new Promise<string>((resolve, reject) => {
          pending.push({ resolve, reject });
        }),
    );
    const history = new MessageDuplicateHistoryService(service);
    const calls = Array.from({ length: DUPLICATE_WINDOW_MAX_OUTSTANDING }, (_, index) =>
      history.remove('chat', `message-${index}`).then(
        () => null,
        (error: unknown) => error,
      ),
    );
    await jest.advanceTimersByTimeAsync(1_001);
    const results = await Promise.all(calls);
    expect(results).toHaveLength(DUPLICATE_WINDOW_MAX_OUTSTANDING);
    expect(
      results.every(
        (error) =>
          error instanceof Error && error.message === 'Message duplicate history deadline exceeded',
      ),
    ).toBe(true);
    expect(redis.eval).toHaveBeenCalledTimes(DUPLICATE_WINDOW_MAX_OUTSTANDING);
    await expect(service.duplicateWindow('chat', { op: 'remove' })).rejects.toBeInstanceOf(
      DuplicateWindowCapacityError,
    );
    expect(redis.eval).toHaveBeenCalledTimes(DUPLICATE_WINDOW_MAX_OUTSTANDING);

    const other = createService(JSON.stringify({ kind: 'ok' }));
    await expect(other.service.duplicateWindow('another-chat', { op: 'remove' })).resolves.toEqual({
      kind: 'ok',
    });
    expect(other.redis.eval).toHaveBeenCalledTimes(1);

    pending[0]!.resolve(JSON.stringify({ kind: 'ok' }));
    await jest.advanceTimersByTimeAsync(0);
    const afterResolve = service.duplicateWindow('chat', { op: 'remove' });
    expect(redis.eval).toHaveBeenCalledTimes(DUPLICATE_WINDOW_MAX_OUTSTANDING + 1);
    pending[DUPLICATE_WINDOW_MAX_OUTSTANDING]!.resolve(JSON.stringify({ kind: 'ok' }));
    await expect(afterResolve).resolves.toEqual({ kind: 'ok' });

    pending[1]!.reject(new Error('Redis disconnected'));
    await jest.advanceTimersByTimeAsync(0);
    const afterReject = service.duplicateWindow('chat', { op: 'remove' });
    expect(redis.eval).toHaveBeenCalledTimes(DUPLICATE_WINDOW_MAX_OUTSTANDING + 2);
    pending[DUPLICATE_WINDOW_MAX_OUTSTANDING + 1]!.resolve(JSON.stringify({ kind: 'ok' }));
    await expect(afterReject).resolves.toEqual({ kind: 'ok' });

    for (const operation of pending.slice(2, DUPLICATE_WINDOW_MAX_OUTSTANDING)) {
      operation.resolve(JSON.stringify({ kind: 'ok' }));
    }
    await jest.advanceTimersByTimeAsync(0);
  });

  it('releases a slot after a synchronous Redis dispatch failure', async () => {
    const { redis, service } = createService(JSON.stringify({ kind: 'ok' }));
    redis.eval.mockImplementationOnce(() => {
      throw new Error('dispatch failed');
    });
    await expect(service.duplicateWindow('chat', { op: 'remove' })).rejects.toThrow(
      'dispatch failed',
    );
    await expect(service.duplicateWindow('chat', { op: 'remove' })).resolves.toEqual({
      kind: 'ok',
    });
  });
});

describe('RedisCounterService revisioned set memberships', () => {
  const deadlineAtMs = 1_800_000_000_000;

  it('keeps compare and server deadline checks before rolling-history mutations', async () => {
    const currentRaw = JSON.stringify({
      v: 1,
      revision: 10,
      memberships: { 'old-key': 1, 'shared-key': 6 },
    });
    const { redis, service } = createService([1, 3, 7]);
    redis.get.mockResolvedValue(currentRaw);

    await expect(
      service.replaceRevisionedSetMembershipsBeforeDeadline({
        stateKey: 'state-key',
        member: 'message-hash',
        revision: 20,
        membershipKeys: ['shared-key', 'new-key'],
        windowSeconds: 60,
        ttlSeconds: 61,
        deadlineAtMs,
      }),
    ).resolves.toEqual({ kind: 'applied', counts: [7, 3] });

    const [
      script,
      keyCount,
      stateKey,
      newKey,
      oldKey,
      sharedKey,
      expectedState,
      revision,
      window,
      ttl,
      deadline,
      member,
      newDesired,
      oldDesired,
      sharedDesired,
      countLimit,
    ] = redis.eval.mock.calls[0]!;
    const lua = String(script);
    const compareAt = lua.indexOf("local current_state = redis.call('GET', KEYS[1])");
    const deadlineAt = lua.indexOf('if now_ms >= tonumber(ARGV[5]) then');
    const firstPruneAt = lua.indexOf("redis.call('ZREMRANGEBYSCORE'");
    const firstRemoveAt = lua.indexOf("redis.call('ZREM'");
    const firstAddAt = lua.indexOf("redis.call('ZADD'");
    const stateWriteAt = lua.lastIndexOf("redis.call('SET'");

    expect(compareAt).toBeGreaterThanOrEqual(0);
    expect(deadlineAt).toBeGreaterThan(compareAt);
    expect(firstPruneAt).toBeGreaterThan(deadlineAt);
    expect(firstRemoveAt).toBeGreaterThan(deadlineAt);
    expect(firstAddAt).toBeGreaterThan(deadlineAt);
    expect(stateWriteAt).toBeGreaterThan(deadlineAt);
    expect([
      keyCount,
      stateKey,
      newKey,
      oldKey,
      sharedKey,
      expectedState,
      revision,
      window,
      ttl,
      deadline,
      member,
      newDesired,
      oldDesired,
      sharedDesired,
      countLimit,
    ]).toEqual([
      4,
      'state-key',
      'new-key',
      'old-key',
      'shared-key',
      currentRaw,
      '20',
      '60',
      '61',
      String(deadlineAtMs),
      'message-hash',
      '1',
      '0',
      '1',
      '21',
    ]);
  });

  it('uses trusted event time for the rolling window while retaining Redis time for deadlines', async () => {
    const { redis, service } = createService([1, 2]);

    await service.replaceRevisionedSetMembershipsBeforeDeadline({
      stateKey: 'state-key',
      member: 'message-hash',
      revision: 20,
      membershipKeys: ['membership-key'],
      windowSeconds: 60,
      ttlSeconds: 61,
      deadlineAtMs,
    });

    const script = String(redis.eval.mock.calls[0]?.[0] ?? '');
    expect(script).toContain('local member_timestamp_ms = tonumber(ARGV[2])');
    expect(script).toContain('local window_ms = tonumber(ARGV[3]) * 1000');
    expect(script).toContain('local count_limit = tonumber(ARGV[#ARGV])');
    expect(script).toContain('local cutoff_ms = member_timestamp_ms - window_ms');
    expect(script).toContain('local retention_cutoff_ms = now_ms - full_ttl_ms');
    expect(script).toContain(
      "redis.call('ZREMRANGEBYSCORE', KEYS[key_index], '-inf', retention_cutoff_ms)",
    );
    expect(script).toContain("redis.call('ZADD', KEYS[key_index], member_timestamp_ms, ARGV[6])");
    expect(script).toContain("local logical_lower_bound = '(' .. tostring(cutoff_ms)");
    expect(script).toContain("local membership_count = redis.call(\n      'ZCOUNT'");
    expect(script).toContain('logical_lower_bound,\n      member_timestamp_ms');
    expect(script).toContain('membership_count = math.min(membership_count, count_limit)');
    expect(script).not.toContain('future_cutoff_ms');
    expect(script).toContain('if baseline_policy and key_index == baseline_policy[2] then');
    expect(script).toContain("'WITHSCORES', 'LIMIT', 0, 1");
    expect(script).toContain("redis.call('PEXPIRE', KEYS[key_index], full_ttl_ms)");
    expect(script).not.toContain("redis.call('ZCARD', KEYS[key_index])");
    expect(script).not.toContain("redis.call('PTTL', KEYS[key_index])");
    expect(script).not.toContain("redis.call('SADD'");
    expect(script).not.toContain("redis.call('SCARD'");
  });

  it.each([
    { response: [0], expected: { kind: 'deadline_exceeded' } },
    { response: [1, 2], expected: { kind: 'applied', counts: [2] } },
  ])('maps a revisioned mutation result: $expected.kind', async ({ response, expected }) => {
    const { service } = createService(response);

    await expect(
      service.replaceRevisionedSetMembershipsBeforeDeadline({
        stateKey: 'state-key',
        member: 'message-hash',
        revision: 10,
        membershipKeys: ['membership-key'],
        windowSeconds: 60,
        ttlSeconds: 61,
        deadlineAtMs,
      }),
    ).resolves.toEqual(expected);
  });

  it('rejects a retention TTL that is shorter than the event-time window', async () => {
    const { redis, service } = createService([1, 1]);

    await expect(
      service.replaceRevisionedSetMembershipsBeforeDeadline({
        stateKey: 'state-key',
        member: 'message-hash',
        revision: 10,
        membershipKeys: ['membership-key'],
        windowSeconds: 61,
        ttlSeconds: 60,
        deadlineAtMs,
      }),
    ).rejects.toThrow('valid unique keys and times');
    expect(redis.get).not.toHaveBeenCalled();
    expect(redis.eval).not.toHaveBeenCalled();
  });

  it('rejects an unbounded rolling-window count limit', async () => {
    const { redis, service } = createService([1, 1]);

    await expect(
      service.replaceRevisionedSetMembershipsBeforeDeadline({
        stateKey: 'state-key',
        member: 'message-hash',
        revision: 10,
        membershipKeys: ['membership-key'],
        windowSeconds: 60,
        ttlSeconds: 181,
        countLimit: 101,
        deadlineAtMs,
      }),
    ).rejects.toThrow('valid unique keys and times');
    expect(redis.get).not.toHaveBeenCalled();
    expect(redis.eval).not.toHaveBeenCalled();
  });

  it('returns stale without mutating when the stored revision is newer', async () => {
    const { redis, service } = createService([1]);
    redis.get.mockResolvedValue(
      JSON.stringify({ v: 1, revision: 11, memberships: { 'membership-key': 1 } }),
    );

    await expect(
      service.replaceRevisionedSetMembershipsBeforeDeadline({
        stateKey: 'state-key',
        member: 'message-hash',
        revision: 10,
        membershipKeys: ['membership-key'],
        windowSeconds: 60,
        ttlSeconds: 61,
        deadlineAtMs,
      }),
    ).resolves.toEqual({ kind: 'stale' });
    expect(redis.eval).not.toHaveBeenCalled();
  });

  it('replays the stored count snapshot without reading mutable history', async () => {
    const currentRaw = JSON.stringify({
      v: 1,
      revision: 10,
      memberships: { 'membership-b': 3, 'membership-a': 5 },
    });
    const { redis, service } = createService(1);
    redis.get.mockResolvedValue(currentRaw);

    await expect(
      service.replaceRevisionedSetMembershipsBeforeDeadline({
        stateKey: 'state-key',
        member: 'message-hash',
        revision: 10,
        membershipKeys: ['membership-a', 'membership-b'],
        windowSeconds: 60,
        ttlSeconds: 61,
        deadlineAtMs,
      }),
    ).resolves.toEqual({ kind: 'replayed', counts: [5, 3] });
    const [script, keyCount, stateKey, expectedState] = redis.eval.mock.calls[0]!;
    const lua = String(script);
    expect(lua).toContain("redis.call('GET', KEYS[1]) == ARGV[1]");
    expect(lua).not.toContain("redis.call('ZCARD'");
    expect(lua).not.toContain("redis.call('ZADD'");
    expect(lua).not.toContain("redis.call('ZREM'");
    expect([keyCount, stateKey, expectedState]).toEqual([1, 'state-key', currentRaw]);
  });

  it('turns a replay into stale when a concurrent newer revision wins', async () => {
    const replayedRaw = JSON.stringify({
      v: 1,
      revision: 10,
      memberships: { 'membership-key': 1 },
    });
    const newerRaw = JSON.stringify({
      v: 1,
      revision: 11,
      memberships: { 'membership-key': 1 },
    });
    const { redis, service } = createService(2);
    redis.get.mockResolvedValueOnce(replayedRaw).mockResolvedValueOnce(newerRaw);

    await expect(
      service.replaceRevisionedSetMembershipsBeforeDeadline({
        stateKey: 'state-key',
        member: 'message-hash',
        revision: 10,
        membershipKeys: ['membership-key'],
        windowSeconds: 60,
        ttlSeconds: 61,
        deadlineAtMs,
      }),
    ).resolves.toEqual({ kind: 'stale' });

    expect(redis.get).toHaveBeenCalledTimes(2);
    expect(redis.eval).toHaveBeenCalledTimes(1);
  });

  it('retries after a CAS conflict and applies against the refreshed state', async () => {
    const refreshedRaw = JSON.stringify({
      v: 1,
      revision: 15,
      memberships: { 'old-key': 2 },
    });
    const { redis, service } = createService([2]);
    redis.get.mockResolvedValueOnce(null).mockResolvedValueOnce(refreshedRaw);
    redis.eval.mockResolvedValueOnce([2]).mockResolvedValueOnce([1, 4]);

    await expect(
      service.replaceRevisionedSetMembershipsBeforeDeadline({
        stateKey: 'state-key',
        member: 'message-hash',
        revision: 20,
        membershipKeys: ['new-key'],
        windowSeconds: 60,
        ttlSeconds: 61,
        deadlineAtMs,
      }),
    ).resolves.toEqual({ kind: 'applied', counts: [4] });

    expect(redis.get).toHaveBeenCalledTimes(2);
    expect(redis.eval).toHaveBeenCalledTimes(2);
    expect(redis.eval.mock.calls[1]).toEqual([
      expect.any(String),
      3,
      'state-key',
      'new-key',
      'old-key',
      refreshedRaw,
      '20',
      '60',
      '61',
      String(deadlineAtMs),
      'message-hash',
      '1',
      '0',
      '21',
    ]);
  });

  it('clears previous memberships while retaining the revision tombstone', async () => {
    const currentRaw = JSON.stringify({
      v: 1,
      revision: 10,
      memberships: { 'old-b': 2, 'old-a': 1 },
    });
    const { redis, service } = createService([1]);
    redis.get.mockResolvedValue(currentRaw);

    await expect(
      service.replaceRevisionedSetMembershipsBeforeDeadline({
        stateKey: 'state-key',
        member: 'message-hash',
        revision: 20,
        membershipKeys: [],
        windowSeconds: 60,
        ttlSeconds: 61,
        deadlineAtMs,
      }),
    ).resolves.toEqual({ kind: 'applied', counts: [] });

    expect(redis.eval.mock.calls[0]).toEqual([
      expect.any(String),
      3,
      'state-key',
      'old-a',
      'old-b',
      currentRaw,
      '20',
      '60',
      '61',
      String(deadlineAtMs),
      'message-hash',
      '0',
      '0',
      '21',
    ]);
    expect(String(redis.eval.mock.calls[0]?.[0] ?? '')).toContain(
      'memberships = stored_memberships',
    );
    expect(String(redis.eval.mock.calls[0]?.[0] ?? '')).toContain(
      'table.insert(stored_memberships, {key = KEYS[key_index], count = membership_count})',
    );
  });

  it('accepts an empty array tombstone produced by Redis Lua after an edit clears text', async () => {
    const currentRaw = JSON.stringify({ v: 1, revision: 20, memberships: [] });
    const { redis, service } = createService(1);
    redis.get.mockResolvedValue(currentRaw);

    await expect(
      service.replaceRevisionedSetMembershipsBeforeDeadline({
        stateKey: 'state-key',
        member: 'message-hash',
        revision: 20,
        membershipKeys: [],
        windowSeconds: 60,
        ttlSeconds: 61,
        deadlineAtMs,
      }),
    ).resolves.toEqual({ kind: 'replayed', counts: [] });
  });

  it('rejects malformed stored state', async () => {
    const { redis, service } = createService([1]);
    redis.get.mockResolvedValue('{"v":1,"revision":"broken"}');

    await expect(
      service.replaceRevisionedSetMembershipsBeforeDeadline({
        stateKey: 'state-key',
        member: 'message-hash',
        revision: 20,
        membershipKeys: ['membership-key'],
        windowSeconds: 60,
        ttlSeconds: 61,
        deadlineAtMs,
      }),
    ).rejects.toThrow('malformed revisioned membership state');
    expect(redis.eval).not.toHaveBeenCalled();
  });

  it('rejects malformed mutation counts and stored replay snapshots', async () => {
    const mutation = createService([1]);
    await expect(
      mutation.service.replaceRevisionedSetMembershipsBeforeDeadline({
        stateKey: 'state-key',
        member: 'message-hash',
        revision: 20,
        membershipKeys: ['membership-key'],
        windowSeconds: 60,
        ttlSeconds: 61,
        deadlineAtMs,
      }),
    ).rejects.toThrow('invalid revisioned membership counts');

    const replay = createService([1, 1]);
    replay.redis.get.mockResolvedValue(
      JSON.stringify({ v: 1, revision: 20, memberships: { 'membership-key': -1 } }),
    );
    await expect(
      replay.service.replaceRevisionedSetMembershipsBeforeDeadline({
        stateKey: 'state-key',
        member: 'message-hash',
        revision: 20,
        membershipKeys: ['membership-key'],
        windowSeconds: 60,
        ttlSeconds: 61,
        deadlineAtMs,
      }),
    ).rejects.toThrow('malformed revisioned membership state');
  });
});

describe('RedisCounterService replayable deadline counter', () => {
  it('keeps the server deadline check before every mutation', async () => {
    const { redis, service } = createService([0, 0]);

    await expect(
      service.incrementOncePerMemberWithTtlBeforeDeadline(
        'counter-key',
        'member-key',
        61,
        1_800_000_000_000,
      ),
    ).resolves.toEqual({ kind: 'deadline_exceeded' });

    const [script, keyCount, counterKey, memberKey, ttl, deadline] = redis.eval.mock.calls[0]!;
    const deadlineBranchAt = String(script).indexOf('if now_ms >= tonumber(ARGV[2]) then');
    expect(deadlineBranchAt).toBeGreaterThanOrEqual(0);
    expect(String(script).indexOf("redis.call('INCR'", deadlineBranchAt)).toBeGreaterThan(
      deadlineBranchAt,
    );
    expect(String(script).indexOf("redis.call('SET'", deadlineBranchAt)).toBeGreaterThan(
      deadlineBranchAt,
    );
    expect([keyCount, counterKey, memberKey, ttl, deadline]).toEqual([
      2,
      'counter-key',
      'member-key',
      '61',
      '1800000000000',
    ]);
  });

  it('does not extend an existing counter near expiry and retains the replay value', async () => {
    const { redis, service } = createService([1, 7]);

    await service.incrementOncePerMemberWithTtlBeforeDeadline(
      'counter-key',
      'member-key',
      61,
      1_800_000_000_000,
    );

    const script = String(redis.eval.mock.calls[0]?.[0] ?? '');
    expect(script).toContain("local counter_pttl = redis.call('PTTL', KEYS[1])");
    expect(script).toContain('if counter_pttl < 0 then');
    expect(script).not.toContain('if counter_pttl < 1 then');
    expect(script).toContain("redis.call('PEXPIRE', KEYS[1], full_ttl_ms)");
    expect(script).toContain("redis.call('SET', KEYS[2], tostring(count), 'PX', full_ttl_ms)");
  });

  it.each([
    { response: [1, 7] as [number, number], expected: { kind: 'inserted', count: 7 } },
    { response: [2, 7] as [number, number], expected: { kind: 'replayed', count: 7 } },
  ])('maps a replayable Redis result: $expected.kind', async ({ response, expected }) => {
    const { service } = createService(response);

    await expect(
      service.incrementOncePerMemberWithTtlBeforeDeadline(
        'counter-key',
        'member-key',
        61,
        1_800_000_000_000,
      ),
    ).resolves.toEqual(expected);
  });

  it('rejects malformed counter results instead of silently changing semantics', async () => {
    const { service } = createService([2, -1]);

    await expect(
      service.incrementOncePerMemberWithTtlBeforeDeadline(
        'counter-key',
        'member-key',
        61,
        1_800_000_000_000,
      ),
    ).rejects.toThrow('invalid replayable counter result');
  });
});

describe('RedisCounterService deadline lock', () => {
  it('checks Redis time before creating the lock and uses the caller token', async () => {
    const { redis, service } = createService(0);

    await expect(
      service.acquireLockBeforeDeadline('lock-key', 'caller-token', 45_000, 1_800_000_000_000),
    ).resolves.toEqual({ kind: 'deadline_exceeded' });

    const [script, keyCount, key, token, ttlMs, deadlineAtMs] = redis.eval.mock.calls[0]!;
    const lua = String(script);
    const deadlineBranchAt = lua.indexOf('if now_ms >= tonumber(ARGV[3]) then');
    const firstSetAt = lua.indexOf("redis.call('SET'");
    expect(deadlineBranchAt).toBeGreaterThanOrEqual(0);
    expect(firstSetAt).toBeGreaterThan(deadlineBranchAt);
    expect([keyCount, key, token, ttlMs, deadlineAtMs]).toEqual([
      1,
      'lock-key',
      'caller-token',
      '45000',
      '1800000000000',
    ]);
  });

  it.each([
    { response: 0, expected: { kind: 'deadline_exceeded' } },
    { response: 1, expected: { kind: 'acquired' } },
    { response: 2, expected: { kind: 'busy' } },
  ])('maps deadline lock status $response', async ({ response, expected }) => {
    const { service } = createService(response);

    await expect(
      service.acquireLockBeforeDeadline('lock-key', 'caller-token', 45_000, Date.now() + 1_000),
    ).resolves.toEqual(expected);
  });

  it('rejects malformed lock results instead of treating them as contention', async () => {
    const { service } = createService(3);

    await expect(
      service.acquireLockBeforeDeadline('lock-key', 'caller-token', 45_000, Date.now() + 1_000),
    ).rejects.toThrow('invalid deadline lock acquisition result');
  });
});

describe('RedisCounterService bounded proof reads', () => {
  function setup() {
    const results = [
      [null, 'proof'],
      [null, null],
      [null, 'proof'],
    ];
    const pipeline = { get: jest.fn(), exec: jest.fn().mockResolvedValue(results) };
    const redis = { get: jest.fn().mockResolvedValue('single'), pipeline: jest.fn(() => pipeline) };
    const service = Object.create(RedisCounterService.prototype) as RedisCounterService;
    Object.defineProperty(service, 'redis', { value: redis });
    return { service, redis, pipeline };
  }

  it('preserves order, misses and duplicate keys in one bounded pipeline', async () => {
    const s = setup();
    await expect(s.service.getStrings(['a', 'missing', 'a'])).resolves.toEqual([
      'proof',
      null,
      'proof',
    ]);
    expect(s.pipeline.get.mock.calls).toEqual([['a'], ['missing'], ['a']]);
    expect(s.pipeline.exec).toHaveBeenCalledTimes(1);
  });

  it('retains the existing one-key path and skips empty batches', async () => {
    const s = setup();
    await expect(s.service.getStrings([])).resolves.toEqual([]);
    await expect(s.service.getStrings(['a'])).resolves.toEqual(['single']);
    expect(s.redis.get).toHaveBeenCalledWith('a');
    expect(s.redis.pipeline).not.toHaveBeenCalled();
    await expect(s.service.getStrings(Array(11).fill('a'))).rejects.toThrow('ten keys');
  });

  it('propagates WRONGTYPE and connection errors instead of converting them into cache misses', async () => {
    const s = setup();
    const error = new Error('WRONGTYPE fixture');
    s.pipeline.exec.mockResolvedValueOnce([
      [null, 'first'],
      [error, null],
    ]);
    await expect(s.service.getStrings(['a', 'b'])).rejects.toBe(error);
    s.pipeline.exec.mockRejectedValueOnce(new Error('connection lost'));
    await expect(s.service.getStrings(['a', 'b'])).rejects.toThrow('connection lost');
    s.pipeline.exec.mockResolvedValueOnce(null);
    await expect(s.service.getStrings(['a', 'b'])).rejects.toThrow('Incomplete');
  });
});
