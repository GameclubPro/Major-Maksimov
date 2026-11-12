import { OptimizationRuntimeMetrics } from '../system/optimization-runtime-metrics';
import type { StorageRuntimeMetricsService } from '../system/storage-runtime-metrics.service';
import { createHash, randomUUID } from 'node:crypto';
import Redis from 'ioredis';
import { ConfigService } from '@nestjs/config';
import type { HttpService } from '@nestjs/axios';
import { of, throwError } from 'rxjs';
import type { ActionHealthService } from '../system/action-health.service';
import { MaxBotRegistryService } from './max-bot-registry.service';
import { MaxBotContextService } from './max-bot-context.service';
import { withMaxFinalAuthorityCheckpoint } from './max-action-pre-dispatch-guard';
import { normalizeMaxApiRateLimitServiceScope } from './max-api-metrics-key.util';
import {
  MAX_API_EXTERNAL_COOLDOWN_SCRIPT,
  MAX_API_RATE_LIMIT_RESERVATION_SCRIPT,
  MaxClientService,
} from './max-client.service';

const redisUrl = process.env.MAXIM_TEST_REDIS_URL;
const describeRedis = redisUrl ? describe : describe.skip;

function nativeTransportFixture(
  botId = `test-quota-${randomUUID()}`,
  overrides: Record<string, string | number> = {},
) {
  const config = new ConfigService({
    MAX_API_BASE_URL: 'https://platform-api2.max.ru',
    REDIS_URL: redisUrl!,
    MAX_BOT_ID: botId,
    MAX_BOT_TOKEN: `native-quota-test-token-${botId}`,
    MAX_WEBHOOK_SECRET_PATH: 'native-quota-test-path',
    MAX_WEBHOOK_HEADER_SECRET: 'native-quota-test-header',
    MAX_API_RATE_LIMIT_WAIT_MS_BACKGROUND: 0,
    APP_SERVICE_NAME: 'test-quota-metrics',
    ...overrides,
  });
  const request = jest.fn().mockReturnValue(of({ status: 200, data: { user_id: '123' } }));
  const health: Pick<ActionHealthService, 'recordSuccessForLane' | 'recordFailureForLane'> = {
    recordSuccessForLane: jest.fn(),
    recordFailureForLane: jest.fn(),
  };
  const service = new MaxClientService(
    { request } as unknown as HttpService,
    config,
    health as ActionHealthService,
    new MaxBotRegistryService(config),
    new MaxBotContextService(),
  );
  const metrics = { optimization: new OptimizationRuntimeMetrics() } satisfies Pick<
    StorageRuntimeMetricsService,
    'optimization'
  >;
  Object.defineProperty(service, 'storageMetrics', { value: metrics });
  const internals = service as unknown as {
    limiterRedis: Redis;
    recordRateLimitUsage(
      botId: string,
      trafficClass: 'critical' | 'interactive' | 'background',
      sourceTag?: string | null,
    ): Promise<void>;
    registerCriticalFailure(
      botId: string,
      permit: { halfOpenProbeToken: string | null },
    ): Promise<void>;
  };
  const serviceScope = normalizeMaxApiRateLimitServiceScope(config.get('APP_SERVICE_NAME'));
  return {
    botId,
    service,
    metrics,
    request,
    internals,
    tokenKey: `maxapi:gcra:v1:bot:${botId}:all`,
    classKey: `maxapi:gcra:v1:service:${serviceScope}:bot:${botId}:class:background`,
  };
}

describeRedis('MAX transport wait lifetime', () => {
  it('does not reserve or dispatch when a timer resumes after the wait budget and cooldown', async () => {
    const { service, internals, request, tokenKey } = nativeTransportFixture(undefined, {
      MAX_API_RATE_LIMIT_WAIT_MS_BACKGROUND: 20,
    });
    const sleeper = service as unknown as { sleep(ms: number): Promise<void> };
    const sleep = jest.spyOn(sleeper, 'sleep').mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      // FLAG: Model a late scheduler wake with capacity now available in real Redis.
      await internals.limiterRedis.del(`${tokenKey}:cooldown`);
    });
    try {
      await internals.limiterRedis.set(`${tokenKey}:cooldown`, '1', 'PX', 10_000);
      await expect(service.getOwnProfile({ trafficClass: 'background' })).rejects.toMatchObject({
        code: 'MAX_API_INTERNAL_RATE_LIMIT',
        preDispatch: true,
      });
      expect(request).not.toHaveBeenCalled();
      expect(await internals.limiterRedis.zcard(`${tokenKey}:window:v1`)).toBe(0);
    } finally {
      sleep.mockRestore();
      await service.onModuleDestroy();
    }
  });

  it('refuses a cooldown beyond the caller budget even when the retry floor would outlive it', async () => {
    const fixture = nativeTransportFixture(undefined, {
      MAX_API_RATE_LIMIT_WAIT_MS_BACKGROUND: 20,
      MAX_API_RATE_LIMIT_RETRY_FLOOR_MS: 250,
    });
    const { service, internals, request, tokenKey } = fixture;
    try {
      await internals.limiterRedis.set(`${tokenKey}:cooldown`, '1', 'PX', 150);
      await expect(service.getOwnProfile({ trafficClass: 'background' })).rejects.toMatchObject({
        code: 'MAX_API_INTERNAL_RATE_LIMIT',
        preDispatch: true,
        limitScope: 'external_cooldown',
      });
      expect(request).not.toHaveBeenCalled();
      expect(await internals.limiterRedis.zcard(`${tokenKey}:window:v1`)).toBe(0);
    } finally {
      await service.onModuleDestroy();
    }
  });

  it.each(['quota', 'keyboard'] as const)(
    'settles a pending %s wait when the client stops without dispatching HTTP',
    async (kind) => {
      const { service, internals, request, tokenKey } = nativeTransportFixture(undefined, {
        MAX_API_RATE_LIMIT_WAIT_MS_BACKGROUND: 5_000,
      });
      const messageId = `shutdown-edit-${randomUUID()}`;
      const lockKey = `max:message-keyboard-edit:v1:${createHash('sha256').update(messageId).digest('hex')}`;
      let enteredWait!: () => void;
      const waiting = new Promise<void>((resolve) => {
        enteredWait = resolve;
      });
      const sleeper = service as unknown as { sleep(ms: number): Promise<void> };
      const originalSleep = sleeper.sleep.bind(service);
      const sleep = jest.spyOn(sleeper, 'sleep').mockImplementation((ms) => {
        const result = originalSleep(ms);
        enteredWait();
        return result;
      });
      let deadline: NodeJS.Timeout | undefined;
      let shutdown: Promise<void> | undefined;
      try {
        await internals.limiterRedis.set(
          kind === 'quota' ? `${tokenKey}:cooldown` : lockKey,
          'held-by-other-operation',
          'PX',
          10_000,
        );
        const operation =
          kind === 'quota'
            ? service.getOwnProfile({ trafficClass: 'background' })
            : service.editMessageInlineKeyboard('chat-shutdown', messageId, 'Fixture');
        const outcome = operation.then(
          () => 'dispatched',
          () => 'rejected',
        );
        await waiting;
        shutdown = service.onModuleDestroy();
        await shutdown;
        expect(
          await Promise.race([
            outcome,
            new Promise<string>((resolve) => {
              deadline = setTimeout(() => resolve('unsettled'), 250);
            }),
          ]),
        ).toBe('rejected');
        expect(request).not.toHaveBeenCalled();
      } finally {
        if (deadline) clearTimeout(deadline);
        sleep.mockRestore();
        await (shutdown ?? service.onModuleDestroy());
      }
    },
  );

  it('passes the caller timeout to the chat title HTTP request', async () => {
    const { service, request } = nativeTransportFixture();
    request.mockReturnValue(of({ status: 200, data: { title: 'Fixture title' } }));
    try {
      await expect(service.getChatTitle('chat-title', { timeoutMs: 123 })).resolves.toBe(
        'Fixture title',
      );
      expect(request).toHaveBeenCalledWith(expect.objectContaining({ timeout: 123 }));
    } finally {
      await service.onModuleDestroy();
    }
  });
});

describeRedis('MAX targeted member shared cache fill', () => {
  function gate() {
    let resolve = () => undefined as void;
    const promise = new Promise<void>((done) => {
      resolve = done;
    });
    return { promise, resolve };
  }

  it('shares a slow Redis fill, writes each member once and keeps bypass reads independent', async () => {
    const fixture = nativeTransportFixture();
    const { service, request, internals, botId } = fixture;
    const chatId = `member-fill-${randomUUID()}`;
    const cacheKey = `maxapi:cache:v1:chat-member-access:${botId}:${chatId}:user`;
    request.mockReturnValue(
      of({
        status: 200,
        data: {
          members: [
            { user_id: 'user', role: 'admin', is_admin: true, permissions: ['delete_message'] },
          ],
        },
      }),
    );
    const filling = gate();
    const release = gate();
    const followerRead = gate();
    const originalSet = internals.limiterRedis.set.bind(internals.limiterRedis);
    const originalGet = internals.limiterRedis.get.bind(internals.limiterRedis);
    let cacheReads = 0;
    let writes = 0;
    jest.spyOn(internals.limiterRedis, 'get').mockImplementation(async (...args) => {
      const value = await originalGet(...args);
      if (args[0] === cacheKey && ++cacheReads === 2) followerRead.resolve();
      return value;
    });
    jest.spyOn(internals.limiterRedis, 'set').mockImplementation(async (...args) => {
      if (args[0] === cacheKey) {
        writes += 1;
        filling.resolve();
        await release.promise;
      }
      return originalSet(...args);
    });
    const lookups: ReturnType<MaxClientService['getChatMembersAccess']>[] = [];
    try {
      lookups.push(service.getChatMembersAccess(chatId, ['user']));
      await filling.promise;
      lookups.push(service.getChatMembersAccess(chatId, ['user']));
      await followerRead.promise;
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(request).toHaveBeenCalledTimes(1);
      expect(writes).toBe(1);
      request.mockReturnValue(
        of({ status: 200, data: { members: [{ user_id: 'user', role: 'member' }] } }),
      );
      const fresh = await service.getChatMembersAccess(chatId, ['user'], { bypassCache: true });
      expect(fresh.get('user')?.isAdmin).toBe(false);
      expect(request).toHaveBeenCalledTimes(2);
      expect(writes).toBe(1);
      release.resolve();
      const [first, follower] = await Promise.all(lookups);
      expect(first.get('user')?.isAdmin).toBe(true);
      expect(follower).toEqual(first);
      first.get('user')!.permissions.push('mutated');
      expect(follower.get('user')?.permissions).toEqual(['delete_message']);
      const cached = await service.getChatMembersAccess(chatId, ['user']);
      expect(cached).toEqual(follower);
      expect(request).toHaveBeenCalledTimes(2);
      expect(writes).toBe(1);
      expect(await internals.limiterRedis.ttl(cacheKey)).toBeGreaterThan(0);
    } finally {
      release.resolve();
      await Promise.allSettled(lookups);
      await internals.limiterRedis.del(cacheKey);
      await service.onModuleDestroy();
    }
  });

  it('shares partially filled and overlapping batches while returning only requested members', async () => {
    const { service, request, internals, botId } = nativeTransportFixture();
    const chatId = `member-batch-${randomUUID()}`;
    const key = (id: string) => `maxapi:cache:v1:chat-member-access:${botId}:${chatId}:${id}`;
    request.mockImplementation((config: { url: string }) => {
      const ids = new URL(config.url, 'https://example.invalid').searchParams
        .get('user_ids')!
        .split(',');
      return of({
        status: 200,
        data: { members: ids.map((user_id) => ({ user_id, role: 'member' })) },
      });
    });
    const filling = gate();
    const release = gate();
    const independentFilled = gate();
    const originalSet = internals.limiterRedis.set.bind(internals.limiterRedis);
    const writes: string[] = [];
    jest.spyOn(internals.limiterRedis, 'set').mockImplementation(async (...args) => {
      if (args[0] === key('b')) {
        filling.resolve();
        await release.promise;
      }
      const result = await originalSet(...args);
      if ([key('a'), key('b'), key('c')].includes(String(args[0]))) writes.push(String(args[0]));
      if (args[0] === key('c')) independentFilled.resolve();
      return result;
    });
    const lookups: ReturnType<MaxClientService['getChatMembersAccess']>[] = [];
    try {
      lookups.push(service.getChatMembersAccess(chatId, ['a', 'b']));
      await filling.promise;
      expect(await internals.limiterRedis.get(key('a'))).not.toBeNull();
      lookups.push(service.getChatMembersAccess(chatId, ['b', 'a', 'c']));
      lookups.push(service.getChatMembersAccess(chatId, ['b']));
      await independentFilled.promise;
      expect(request).toHaveBeenCalledTimes(2);
      expect(
        new URL(request.mock.calls[1]![0].url, 'https://example.invalid').searchParams.get(
          'user_ids',
        ),
      ).toBe('c');
      release.resolve();
      const [first, overlap, subset] = await Promise.all(lookups);
      expect([...first.keys()].sort()).toEqual(['a', 'b']);
      expect([...overlap.keys()].sort()).toEqual(['a', 'b', 'c']);
      expect([...subset.keys()]).toEqual(['b']);
      expect(writes.sort()).toEqual([key('a'), key('b'), key('c')].sort());
    } finally {
      release.resolve();
      await Promise.allSettled(lookups);
      await internals.limiterRedis.del(key('a'), key('b'), key('c'));
      await service.onModuleDestroy();
    }
  });

  it('releases failed cache fills so a later lookup can load again', async () => {
    const { service, request, internals, botId } = nativeTransportFixture();
    const chatId = `member-failed-fill-${randomUUID()}`;
    const key = `maxapi:cache:v1:chat-member-access:${botId}:${chatId}:user`;
    request.mockReturnValue(
      of({ status: 200, data: { members: [{ user_id: 'user', role: 'member' }] } }),
    );
    const originalSet = internals.limiterRedis.set.bind(internals.limiterRedis);
    let fail = true;
    jest.spyOn(internals.limiterRedis, 'set').mockImplementation(async (...args) => {
      if (args[0] === key && fail) {
        fail = false;
        throw new Error('fixture cache write unavailable');
      }
      return originalSet(...args);
    });
    try {
      await expect(service.getChatMembersAccess(chatId, ['user'])).rejects.toThrow(
        'fixture cache write unavailable',
      );
      expect(await internals.limiterRedis.get(key)).toBeNull();
      expect((await service.getChatMembersAccess(chatId, ['user'])).get('user')?.isAdmin).toBe(
        false,
      );
      expect(request).toHaveBeenCalledTimes(2);
    } finally {
      await internals.limiterRedis.del(key);
      await service.onModuleDestroy();
    }
  });
});

describeRedis('MAX configured token burst pacing', () => {
  let redis: Redis;
  beforeAll(async () => {
    redis = new Redis(redisUrl!);
    await redis.ping();
  });
  afterAll(async () => {
    await redis?.quit();
  });

  type Fixture = ReturnType<typeof nativeTransportFixture>;

  async function close(fixtures: Fixture[]) {
    await Promise.all(fixtures.map(({ service }) => service.onModuleDestroy()));
    await redis.del(
      ...fixtures.flatMap(({ tokenKey, classKey }) => [
        tokenKey,
        `${tokenKey}:window:v1`,
        `${tokenKey}:cooldown`,
        classKey,
      ]),
    );
  }

  function useAdmissionClock(fixtures: Fixture[], now: () => number) {
    const clock = "local time = redis.call('TIME')";
    expect(MAX_API_RATE_LIMIT_RESERVATION_SCRIPT.split(clock)).toHaveLength(2);
    for (const { internals } of fixtures) {
      const originalEval = internals.limiterRedis.eval.bind(internals.limiterRedis);
      jest.spyOn(internals.limiterRedis, 'eval').mockImplementation(async (...args) => {
        // FLAG: Only the authoritative clock changes. Constructor configuration, ARGV,
        // Redis execution and the public transport lifecycle remain real.
        if (args[0] === MAX_API_RATE_LIMIT_RESERVATION_SCRIPT) {
          const milliseconds = now();
          args[0] = MAX_API_RATE_LIMIT_RESERVATION_SCRIPT.replace(
            clock,
            `local time = {${Math.floor(milliseconds / 1000)}, ${(milliseconds % 1000) * 1000}}`,
          );
        }
        return originalEval(...args);
      });
    }
  }

  it('shares zero-burst 30 rps pacing without burning denied quota or changing cooldown', async () => {
    const botId = `test-paced-${randomUUID()}`;
    const config = { MAX_API_GLOBAL_RPS: '30', MAX_API_GLOBAL_BURST: '0' };
    const first = nativeTransportFixture(botId, { ...config, APP_SERVICE_NAME: 'test-pacing-a' });
    const peer = nativeTransportFixture(botId, { ...config, APP_SERVICE_NAME: 'test-pacing-b' });
    const other = nativeTransportFixture(`test-independent-${randomUUID()}`, {
      ...config,
      APP_SERVICE_NAME: 'test-pacing-c',
    });
    const fixtures = [first, peer, other];
    let nowMs = 1_700_000_000_000;
    useAdmissionClock(fixtures, () => nowMs);
    const read = ({ service }: Fixture) => service.getOwnProfile({ trafficClass: 'background' });
    const state = async () => ({
      tats: await redis.mget(first.tokenKey, first.classKey, peer.classKey),
      window: await redis.zrange(`${first.tokenKey}:window:v1`, 0, -1, 'WITHSCORES'),
    });
    try {
      await read(first);
      const admitted = await state();
      expect(admitted.tats[0]).not.toBeNull();
      expect(admitted.window).toHaveLength(2);
      await expect(read(peer)).rejects.toMatchObject({
        code: 'MAX_API_INTERNAL_RATE_LIMIT',
        preDispatch: true,
        limitScope: 'bot',
        retryAfterMs: 34,
      });
      expect(await state()).toEqual(admitted);
      expect(peer.request).not.toHaveBeenCalled();
      await read(other);
      expect(other.request).toHaveBeenCalledTimes(1);

      nowMs += 33;
      await expect(read(peer)).rejects.toMatchObject({
        code: 'MAX_API_INTERNAL_RATE_LIMIT',
        limitScope: 'bot',
        retryAfterMs: 1,
      });
      expect(await state()).toEqual(admitted);
      expect(peer.request).not.toHaveBeenCalled();

      nowMs += 1;
      await read(peer);
      expect(first.request).toHaveBeenCalledTimes(1);
      expect(peer.request).toHaveBeenCalledTimes(1);
      expect(await redis.zcard(`${first.tokenKey}:window:v1`)).toBe(2);

      const cooldownKey = `${first.tokenKey}:cooldown`;
      await redis.eval(MAX_API_EXTERNAL_COOLDOWN_SCRIPT, 1, cooldownKey, '60000');
      const expiry = await redis.pexpiretime(cooldownKey);
      await redis.eval(MAX_API_EXTERNAL_COOLDOWN_SCRIPT, 1, cooldownKey, '1000');
      const beforeCooldownRefusal = await state();
      nowMs += 34;
      await expect(read(first)).rejects.toMatchObject({
        code: 'MAX_API_INTERNAL_RATE_LIMIT',
        preDispatch: true,
        limitScope: 'external_cooldown',
      });
      expect(await state()).toEqual(beforeCooldownRefusal);
      expect(await redis.pexpiretime(cooldownKey)).toBe(expiry);
      expect(await redis.pttl(cooldownKey)).toBeGreaterThan(50_000);
      expect(first.request).toHaveBeenCalledTimes(1);
      await read(other);
      expect(other.request).toHaveBeenCalledTimes(2);
    } finally {
      await close(fixtures);
    }
  });

  it('preserves immediate shared-token admissions when burst configuration is omitted', async () => {
    const botId = `test-default-burst-${randomUUID()}`;
    const first = nativeTransportFixture(botId, { APP_SERVICE_NAME: 'test-default-a' });
    const peer = nativeTransportFixture(botId, { APP_SERVICE_NAME: 'test-default-b' });
    const fixtures = [first, peer];
    useAdmissionClock(fixtures, () => 1_700_000_000_000);
    try {
      await first.service.getOwnProfile({ trafficClass: 'background' });
      await peer.service.getOwnProfile({ trafficClass: 'background' });
      expect(first.request).toHaveBeenCalledTimes(1);
      expect(peer.request).toHaveBeenCalledTimes(1);
      expect(await redis.zcard(`${first.tokenKey}:window:v1`)).toBe(2);
    } finally {
      await close(fixtures);
    }
  });

  it('paces concurrent callers within their bounded wait using the actual Redis clock', async () => {
    const botId = `test-concurrent-pacing-${randomUUID()}`;
    const config = {
      MAX_API_GLOBAL_RPS: '30',
      MAX_API_GLOBAL_BURST: '0',
      MAX_API_GLOBAL_RPS_BACKGROUND: '30',
      MAX_API_RATE_LIMIT_WAIT_MS_BACKGROUND: '500',
    };
    const first = nativeTransportFixture(botId, { ...config, APP_SERVICE_NAME: 'test-wait-a' });
    const peer = nativeTransportFixture(botId, { ...config, APP_SERVICE_NAME: 'test-wait-b' });
    const fixtures = [first, peer];
    try {
      await Promise.all(fixtures.map(({ internals }) => internals.limiterRedis.ping()));
      const startedAt = Date.now();
      const outcomes = await Promise.allSettled(
        Array.from({ length: 6 }, (_, index) =>
          fixtures[index % fixtures.length]!.service.getOwnProfile({ trafficClass: 'background' }),
        ),
      );
      expect(Date.now() - startedAt).toBeLessThan(1_000);
      expect(outcomes.map(({ status }) => status)).toEqual(Array(6).fill('fulfilled'));
      expect(first.request.mock.calls.length + peer.request.mock.calls.length).toBe(6);
      const window = await redis.zrange(`${first.tokenKey}:window:v1`, 0, -1, 'WITHSCORES');
      expect(window).toHaveLength(12);
      const admissionTimes = window.filter((_, index) => index % 2 === 1).map(Number);
      for (let index = 1; index < admissionTimes.length; index++) {
        expect(admissionTimes[index]! - admissionTimes[index - 1]!).toBeGreaterThanOrEqual(33);
      }
    } finally {
      await close(fixtures);
    }
  });

  it.each([2, 25])(
    'paces actual HTTP sends after delayed final-authority preparation at %i rps using the actual Redis clock',
    async (rps) => {
      const fixture = nativeTransportFixture(`test-final-authority-${randomUUID()}`, {
        MAX_API_GLOBAL_RPS: String(rps),
        MAX_API_GLOBAL_BURST: '0',
        MAX_API_GLOBAL_RPS_CRITICAL: String(rps),
        MAX_API_RATE_LIMIT_WAIT_MS_CRITICAL: '2500',
      });
      const independent = nativeTransportFixture(`test-independent-final-${randomUUID()}`);
      const dispatchedAt: number[] = [];
      fixture.request.mockImplementation(() => {
        dispatchedAt.push(performance.now());
        return of({ status: 200, data: { message: { body: { mid: randomUUID() } } } });
      });
      let releasePreparation!: () => void;
      const preparation = new Promise<void>((resolve) => {
        releasePreparation = resolve;
      });
      let entered = 0;
      const sends = Array.from({ length: 3 }, (_, index) =>
        fixture.service.sendMessage(
          `test-final-authority-chat-${index}`,
          'Fixture notice',
          undefined,
          {
            immediate: true,
            idempotencyKey: `test-final-authority-${index}-${randomUUID()}`,
            beforeImmediateSendMutation: withMaxFinalAuthorityCheckpoint(
              async (beforeFinalAuthority) => {
                entered++;
                await preparation;
                // FLAG: Real guards finish their remote preparation before this checkpoint,
                // then obtain their final SQL/feature permit without another quota wait.
                await beforeFinalAuthority?.();
              },
            ),
          },
        ),
      );
      try {
        const deadline = Date.now() + 4_000;
        while (entered < sends.length && Date.now() < deadline)
          await new Promise((resolve) => setTimeout(resolve, 10));
        expect(entered).toBe(3);
        expect(dispatchedAt).toEqual([]);
        await independent.service.getOwnProfile({ trafficClass: 'background' });
        expect(independent.request).toHaveBeenCalledTimes(1);
        releasePreparation();
        await Promise.all(sends);
        expect(dispatchedAt).toHaveLength(3);
        const interval = 1000 / rps;
        for (let index = 1; index < dispatchedAt.length; index++)
          expect(dispatchedAt[index]! - dispatchedAt[index - 1]!).toBeGreaterThanOrEqual(
            interval - Math.min(20, interval * 0.1),
          );
        await redis.eval(
          MAX_API_EXTERNAL_COOLDOWN_SCRIPT,
          1,
          `${fixture.tokenKey}:cooldown`,
          '5000',
        );
        await expect(
          fixture.service.sendMessage('test-cooled-chat', 'Cooled fixture', undefined, {
            immediate: true,
            timeoutMs: 1,
            beforeImmediateSendMutation: withMaxFinalAuthorityCheckpoint(async (checkpoint) => {
              await checkpoint?.();
            }),
          }),
        ).rejects.toMatchObject({
          code: 'MAX_API_INTERNAL_RATE_LIMIT',
          preDispatch: true,
          limitScope: 'external_cooldown',
        });
        expect(dispatchedAt).toHaveLength(3);
        const timings = fixture.metrics.optimization.snapshot()!.timings;
        expect(timings.sendQuota).toMatchObject({ calls: 4, errors: 1, unknownClock: 0 });
        expect(timings.sendGuard).toMatchObject({ calls: 4, errors: 1, unknownClock: 0 });
        expect(timings.sendHttp).toMatchObject({ calls: 3, errors: 0, unknownClock: 0 });
        await independent.service.getOwnProfile({ trafficClass: 'background' });
        expect(independent.request).toHaveBeenCalledTimes(2);
      } finally {
        releasePreparation();
        await Promise.allSettled(sends);
        await close([fixture, independent]);
      }
    },
  );
});

describeRedis('MAX external cooldown atomic admission', () => {
  let redis: Redis;
  const key = `test:publication-cooldown:${randomUUID()}`;
  beforeAll(async () => {
    redis = new Redis(redisUrl!);
    await redis.ping();
  });
  afterAll(async () => {
    if (redis) {
      await redis.del(
        key,
        `${key}:cooldown`,
        `${key}:other`,
        `${key}:window:v1`,
        `${key}:other:window:v1`,
      );
      await redis.quit();
    }
  });

  it('shares cooldown across callers, preserves longer waits and isolates another token', async () => {
    const reserve = (scope: string) =>
      redis.eval(MAX_API_RATE_LIMIT_RESERVATION_SCRIPT, 1, scope, '30', '29', '2000');
    expect(await reserve(key)).toEqual([1, 0, 0]);
    await redis.eval(MAX_API_EXTERNAL_COOLDOWN_SCRIPT, 1, `${key}:cooldown`, '60000');
    const originalTat = await redis.get(key);
    await redis.eval(MAX_API_EXTERNAL_COOLDOWN_SCRIPT, 1, `${key}:cooldown`, '1000');
    const rejected = (await reserve(key)) as number[];
    expect(rejected[0]).toBe(0);
    expect(rejected[2]).toBeGreaterThan(50_000);
    expect(await redis.get(key)).toBe(originalTat);
    expect(await reserve(`${key}:other`)).toEqual([1, 0, 0]);
    await redis.pexpire(`${key}:cooldown`, 1);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(await reserve(key)).toEqual([1, 0, 0]);
  });

  it('does not hold an admitted GET behind usage metrics and release it into a later 30s cooldown', async () => {
    const { botId, tokenKey, service, request, internals } = nativeTransportFixture();
    let metricsEntered!: () => void;
    let releaseMetrics!: () => void;
    const entered = new Promise<void>((resolve) => {
      metricsEntered = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      releaseMetrics = resolve;
    });
    jest.spyOn(internals, 'recordRateLimitUsage').mockImplementation(async () => {
      metricsEntered();
      await blocked;
    });
    const reading = service.getOwnProfile({ botId, trafficClass: 'background' });
    try {
      await entered;
      await new Promise<void>((resolve) => setImmediate(resolve));
      const startsBeforeCooldown = request.mock.calls.length;
      await redis.eval(MAX_API_EXTERNAL_COOLDOWN_SCRIPT, 1, `${tokenKey}:cooldown`, '30000');
      releaseMetrics();
      await reading;

      expect(startsBeforeCooldown).toBe(1);
      expect(request).toHaveBeenCalledTimes(startsBeforeCooldown);
      await expect(
        service.getOwnProfile({ botId, trafficClass: 'background' }),
      ).rejects.toMatchObject({
        code: 'MAX_API_INTERNAL_RATE_LIMIT',
        preDispatch: true,
        limitScope: 'external_cooldown',
      });
      expect(request).toHaveBeenCalledTimes(1);
      expect(await redis.pttl(`${tokenKey}:cooldown`)).toBeGreaterThan(25_000);
    } finally {
      releaseMetrics();
      await reading.catch(() => undefined);
      await service.onModuleDestroy();
      await redis.del(
        tokenKey,
        `${tokenKey}:window:v1`,
        `${tokenKey}:cooldown`,
        `maxapi:gcra:v1:service:test-quota-metrics:bot:${botId}:class:background`,
      );
    }
  });

  it('retains shared external 429 cooldown before waiting for circuit bookkeeping', async () => {
    const { botId, tokenKey, service, request, internals } = nativeTransportFixture();
    const peer = nativeTransportFixture(botId);
    const failure = Object.assign(new Error('MAX quota exceeded'), {
      response: { status: 429, headers: { 'retry-after': '30' } },
    });
    request.mockReturnValueOnce(throwError(() => failure));
    let circuitEntered!: () => void;
    let releaseCircuit!: () => void;
    const entered = new Promise<void>((resolve) => {
      circuitEntered = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      releaseCircuit = resolve;
    });
    const register = internals.registerCriticalFailure.bind(internals);
    jest.spyOn(internals, 'registerCriticalFailure').mockImplementation(async (...args) => {
      circuitEntered();
      await blocked;
      await register(...args);
    });
    const reading = service
      .getOwnProfile({ botId, trafficClass: 'background' })
      .catch((error: unknown) => error);
    try {
      await entered;
      const ttlWhileCircuitBlocked = await redis.pttl(`${tokenKey}:cooldown`);
      const peerResult = await peer.service
        .getOwnProfile({ botId, trafficClass: 'background' })
        .catch((error: unknown) => error);
      releaseCircuit();
      expect(await reading).toBe(failure);
      expect(ttlWhileCircuitBlocked).toBeGreaterThan(25_000);
      expect(peerResult).toMatchObject({
        code: 'MAX_API_INTERNAL_RATE_LIMIT',
        preDispatch: true,
        limitScope: 'external_cooldown',
      });
      expect(peer.request).not.toHaveBeenCalled();
    } finally {
      releaseCircuit();
      await reading;
      await Promise.all([service.onModuleDestroy(), peer.service.onModuleDestroy()]);
      await redis.del(
        tokenKey,
        `${tokenKey}:window:v1`,
        `${tokenKey}:cooldown`,
        `maxapi:gcra:v1:service:test-quota-metrics:bot:${botId}:class:background`,
      );
    }
  });
});

describeRedis('MAX token rolling-second admission', () => {
  let redis: Redis;
  let peer: Redis;
  let keys: string[];
  beforeAll(async () => {
    redis = new Redis(redisUrl!);
    peer = new Redis(redisUrl!);
    await Promise.all([redis.ping(), peer.ping()]);
  });
  beforeEach(() => {
    const prefix = `test:max-token-window:${randomUUID()}`;
    keys = [
      `${prefix}:token`,
      `${prefix}:class`,
      `${prefix}:other`,
      `${prefix}:background`,
      `${prefix}:interactive`,
      `${prefix}:chat`,
      `${prefix}:send-target`,
    ];
  });
  afterEach(async () => {
    await redis.del(...keys.flatMap((key) => [key, `${key}:window:v1`, `${key}:cooldown`]));
  });
  afterAll(async () => {
    await Promise.all([redis?.quit(), peer?.quit()]);
  });

  // Run the production Lua against real Redis with a deterministic clock inside one
  // atomic script, so runner pauses cannot disguise a replenished-slot burst.
  function clockedScenario(body: string): Promise<unknown> {
    const clock = "local time = redis.call('TIME')";
    expect(MAX_API_RATE_LIMIT_RESERVATION_SCRIPT.split(clock)).toHaveLength(2);
    return redis.eval(
      `local function reserve(KEYS, ARGV, time)\n${MAX_API_RATE_LIMIT_RESERVATION_SCRIPT.replace(clock, '')}\nend\n${body}`,
      keys.length,
      ...keys,
    );
  }

  it('keeps the initial burst but rejects replenishment until the original second ends', async () => {
    const result = await clockedScenario(`
      local args = {'30', '29', '2000'}
      local scope = {KEYS[1]}
      local admitted = 0
      for i=1,30 do admitted = admitted + reserve(scope, args, {1700000000, 0})[1] end
      local tat = redis.call('GET', KEYS[1])
      local blocked = reserve(scope, args, {1700000000, 400000})
      local unchanged = tat == redis.call('GET', KEYS[1])
      local independent = reserve({KEYS[3]}, args, {1700000000, 400000})
      local resumed = reserve(scope, args, {1700000001, 0})
      return {admitted, blocked, unchanged and 1 or 0, independent, resumed,
        redis.call('ZCARD', KEYS[1] .. ':window:v1')}
    `);
    expect(result).toEqual([30, [0, 1, 600], 1, [1, 0, 0], [1, 0, 0], 1]);
  });

  it('does not burn the token window when another dimension refuses admission', async () => {
    const result = await clockedScenario(`
      local scope = {KEYS[1], KEYS[2]}
      local args = {'30', '1', '29', '0', '2000'}
      local first = reserve(scope, args, {1700000000, 0})
      local tat = redis.call('GET', KEYS[1])
      local blocked = reserve(scope, args, {1700000000, 100000})
      return {first, blocked, tat == redis.call('GET', KEYS[1]) and 1 or 0,
        redis.call('ZCARD', KEYS[1] .. ':window:v1')}
    `);
    expect(result).toEqual([[1, 0, 0], [0, 2, 900], 1, 1]);
  });

  it('admits interactive SEND beyond background capacity while retaining shared token and target limits', async () => {
    const result = await clockedScenario(`
      local time = {1700000000, 0}
      local background = {KEYS[1], KEYS[4]}
      local backgroundArgs = {'30', '4', '29', '3', '2000'}
      local backgroundCount = 0
      for i=1,4 do backgroundCount = backgroundCount + reserve(background, backgroundArgs, time)[1] end
      local backgroundTat = redis.call('GET', KEYS[4])
      local backgroundBlocked = reserve(background, backgroundArgs, time)
      local send = {KEYS[1], KEYS[5], KEYS[6], KEYS[7]}
      local sendArgs = {'30', '18', '5', '2', '29', '17', '4', '0', '2000'}
      local admitted = reserve(send, sendArgs, time)
      local tats = redis.call('MGET', unpack(send))
      local targetBlocked = reserve(send, sendArgs, time)
      local unchanged = true
      for i,key in ipairs(send) do
        unchanged = unchanged and tats[i] == redis.call('GET', key)
      end
      local remainder = 0
      for i=1,25 do remainder = remainder + reserve({KEYS[1]}, {'30', '29', '2000'}, time)[1] end
      local tokenBlocked = reserve(send, sendArgs, time)
      return {backgroundCount, backgroundBlocked, admitted, targetBlocked, unchanged and 1 or 0,
        remainder, tokenBlocked, redis.call('ZCARD', KEYS[1] .. ':window:v1'),
        backgroundTat == redis.call('GET', KEYS[4]) and 1 or 0}
    `);
    expect(result).toEqual([4, [0, 2, 250], [1, 0, 0], [0, 4, 500], 1, 25, [0, 1, 1000], 30, 1]);
  });

  it('retains the configured sustained throughput without growing the window', async () => {
    const result = await clockedScenario(`
      local admitted = 0
      local maximum = 0
      for i=0,899 do
        local ms = math.ceil(i * 1000 / 30)
        local decision = reserve({KEYS[1]}, {'30', '29', '2000'},
          {1700000000 + math.floor(ms / 1000), (ms % 1000) * 1000})
        admitted = admitted + decision[1]
        maximum = math.max(maximum, redis.call('ZCARD', KEYS[1] .. ':window:v1'))
      end
      return {admitted, maximum}
    `);
    expect(result).toEqual([900, 30]);
  });

  it('honors a lower configured token quota across adjacent clock seconds', async () => {
    const result = await clockedScenario(`
      local args = {'2', '1', '2000'}
      local scope = {KEYS[1]}
      local first = reserve(scope, args, {1700000000, 900000})
      local second = reserve(scope, args, {1700000000, 900000})
      local blocked = reserve(scope, args, {1700000001, 400000})
      local resumed = reserve(scope, args, {1700000001, 900000})
      return {first, second, blocked, resumed}
    `);
    expect(result).toEqual([
      [1, 0, 0],
      [1, 0, 0],
      [0, 1, 500],
      [1, 0, 0],
    ]);
  });

  it('shares actual-clock admission across clients and retains only bounded expiring state', async () => {
    const startedAt = Date.now();
    const results = await Promise.all(
      Array.from({ length: 90 }, (_, index) =>
        (index % 2 ? peer : redis).eval(
          MAX_API_RATE_LIMIT_RESERVATION_SCRIPT,
          1,
          keys[0]!,
          '30',
          '29',
          '2000',
        ),
      ),
    );
    // This is a bounded concurrent burst; a slow/unrepresentative run must not pass.
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(results.filter((result) => (result as number[])[0] === 1)).toHaveLength(30);
    expect(await redis.zcard(`${keys[0]}:window:v1`)).toBe(30);
    expect(await redis.pttl(`${keys[0]}:window:v1`)).toBeGreaterThan(0);
    expect(await redis.pttl(`${keys[0]}:window:v1`)).toBeLessThanOrEqual(1_000);
    expect(
      await peer.eval(MAX_API_RATE_LIMIT_RESERVATION_SCRIPT, 1, keys[2]!, '30', '29', '2000'),
    ).toEqual([1, 0, 0]);
  });
});
