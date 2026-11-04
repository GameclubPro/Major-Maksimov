import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { createHash, randomUUID } from 'node:crypto';
import { VkApiClientService } from './vk-api-client.service';
import { VkParsingRateLimitService } from './vk-parsing-rate-limit.service';

const redisUrl = process.env.MAXIM_TEST_REDIS_URL?.trim() ?? '';
const localRedis = (() => {
  try {
    return ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(new URL(redisUrl).hostname);
  } catch {
    return false;
  }
})();
const describeRedis = localRedis ? describe : describe.skip;

describeRedis('VK provider cooldown atomic Redis admission', () => {
  const originalFetch = global.fetch;
  let inspector: Redis;
  let services: VkParsingRateLimitService[];
  let ownedKeys: Set<string>;

  const scopeFor = (token: string) =>
    createHash('sha256').update(`https://api.vk.ru\0${token}`).digest('hex');
  const cooldownKey = (scope: string) => `vkapi:provider-cooldown:v1:${scope}`;
  const admission = (scope: string) => ({
    credentialScope: scope,
    deadlineAtMs: Date.now() + 20_000,
  });
  const runtimeRedis = (service: VkParsingRateLimitService) =>
    (service as unknown as { redis: Redis }).redis;

  async function limiter(config: Record<string, unknown> = {}) {
    const service = new VkParsingRateLimitService(
      new ConfigService({
        REDIS_URL: redisUrl,
        VK_API_RPS: 100,
        VK_API_RATE_LIMIT_WAIT_MS: 0,
        ...config,
      }),
    );
    services.push(service);
    const redis = runtimeRedis(service);
    if (redis.status !== 'ready') {
      await new Promise<void>((resolve, reject) => {
        redis.once('ready', resolve);
        redis.once('error', reject);
      });
    }
    const evaluate = redis.eval.bind(redis);
    jest.spyOn(redis, 'eval').mockImplementation(async (...args) => {
      for (const key of args.slice(2, 2 + Number(args[1]))) ownedKeys.add(String(key));
      return evaluate(...args);
    });
    return service;
  }

  const client = (service: VkParsingRateLimitService, token: string) =>
    new VkApiClientService(
      new ConfigService({ VK_SERVICE_TOKEN: token, VK_API_MAX_ATTEMPTS: 3 }),
      service,
    );

  beforeAll(async () => {
    inspector = new Redis(redisUrl, { maxRetriesPerRequest: 1 });
    await inspector.ping();
  });
  beforeEach(() => {
    services = [];
    ownedKeys = new Set();
  });
  afterEach(async () => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
    await Promise.all(services.map((service) => service.onModuleDestroy()));
    // FLAG: Delete only exact keys observed in this isolated localhost suite; never scan or flush Redis.
    if (ownedKeys.size) await inspector.del(...ownedKeys);
  });
  afterAll(async () => inspector.quit());

  it('blocks the same credential across methods without consuming either quota', async () => {
    const origin = await limiter();
    const peer = await limiter();
    const scope = scopeFor(randomUUID());
    const retryAtMs = Date.now() + 120_000;
    await origin.publishVkApiCooldown(scope, retryAtMs);
    await expect(peer.reserveVkApiSlot('video.get', admission(scope))).rejects.toMatchObject({
      code: 'provider_cooldown',
      retryAtMs,
    });
    const quotas = [...ownedKeys].filter((key) => key.startsWith('vkapi:rps:'));
    expect(quotas).toHaveLength(2);
    expect(await inspector.mget(...quotas)).toEqual([null, null]);
  });

  it('keeps credential cooldown independent while the shared global quota is available', async () => {
    const first = await limiter();
    const second = await limiter();
    const paused = scopeFor(randomUUID());
    const available = scopeFor(randomUUID());
    await first.publishVkApiCooldown(paused, Date.now() + 120_000);
    await expect(
      second.reserveVkApiSlot('wall.get', admission(available)),
    ).resolves.toBeUndefined();
    await expect(second.reserveVkApiSlot('wall.get', admission(paused))).rejects.toMatchObject({
      code: 'provider_cooldown',
    });
  });

  it('retains shared global RPS across different credentials and methods', async () => {
    const service = await limiter({ VK_API_RPS: 1 });
    const now = Date.now();
    jest.spyOn(Date, 'now').mockReturnValue(now);
    await service.reserveVkApiSlot('wall.get', admission(scopeFor(randomUUID())));
    await expect(
      service.reserveVkApiSlot('video.get', admission(scopeFor(randomUUID()))),
    ).rejects.toThrow('rate limit exceeded');
    expect(await inspector.get(`vkapi:rps:global:${Math.floor(now / 1_000)}`)).toBe('1');
  });

  it('checks the existing method quota without burning a global slot', async () => {
    const service = await limiter({ VK_API_RPS: 1 });
    const now = Date.now();
    jest.spyOn(Date, 'now').mockReturnValue(now);
    const methodKey = `vkapi:rps:method:wall.get:${Math.floor(now / 1_000)}`;
    ownedKeys.add(methodKey);
    await inspector.set(methodKey, '1', 'PX', 2_000);
    await expect(
      service.reserveVkApiSlot('wall.get', admission(scopeFor(randomUUID()))),
    ).rejects.toThrow('rate limit exceeded');
    expect(await inspector.get(`vkapi:rps:global:${Math.floor(now / 1_000)}`)).toBeNull();
  });

  it('keeps the longest concurrent deadline and exact expiry when a shorter reply follows', async () => {
    const first = await limiter();
    const second = await limiter();
    const scope = scopeFor(randomUUID());
    const longest = Date.now() + 7_200_000;
    await Promise.all([
      first.publishVkApiCooldown(scope, longest),
      second.publishVkApiCooldown(scope, longest - 6_000_000),
    ]);
    await second.publishVkApiCooldown(scope, longest - 7_000_000);
    expect(await inspector.get(cooldownKey(scope))).toBe(String(longest));
    const ttl = await inspector.pttl(cooldownKey(scope));
    expect(ttl).toBeGreaterThan(7_195_000);
    expect(ttl).toBeLessThanOrEqual(7_200_000);
    await expect(second.reserveVkApiSlot('wall.get', admission(scope))).rejects.toMatchObject({
      retryAtMs: longest,
    });
  });

  it('preserves the largest storage-safe provider date through Lua and expiry', async () => {
    const first = await limiter();
    const peer = await limiter();
    const scope = scopeFor(randomUUID());
    const largestDate = 253_402_300_799_999;
    await first.publishVkApiCooldown(scope, largestDate);
    await peer.publishVkApiCooldown(scope, Date.now() + 120_000);
    expect(await inspector.get(cooldownKey(scope))).toBe(String(largestDate));
    expect(await inspector.pttl(cooldownKey(scope))).toBeGreaterThan(200_000_000_000_000);
    await expect(peer.reserveVkApiSlot('wall.get', admission(scope))).rejects.toMatchObject({
      retryAtMs: largestDate,
    });
  });

  it.each([253_402_300_800_000, 8_640_000_000_000_000])(
    'rejects a deadline that cannot round-trip through source storage before Redis: %s',
    async (retryAtMs) => {
      const service = await limiter();
      const scope = scopeFor(randomUUID());
      await expect(service.publishVkApiCooldown(scope, retryAtMs)).rejects.toThrow(
        'Invalid VK API provider deadline',
      );
      expect(runtimeRedis(service).eval).not.toHaveBeenCalled();
      expect(await inspector.get(cooldownKey(scope))).toBeNull();
    },
  );

  it('admits a fresh reservation after the original short provider pause expires', async () => {
    const service = await limiter();
    const scope = scopeFor(randomUUID());
    await service.publishVkApiCooldown(scope, Date.now() + 1_000);
    await expect(service.reserveVkApiSlot('wall.get', admission(scope))).rejects.toMatchObject({
      code: 'provider_cooldown',
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 1_100));
    expect(await inspector.get(cooldownKey(scope))).toBeNull();
    await expect(service.reserveVkApiSlot('wall.get', admission(scope))).resolves.toBeUndefined();
  });

  it('does not reintroduce a long client sleep after a prompt shared admission refusal', async () => {
    const origin = await limiter();
    const peer = await limiter();
    const token = randomUUID();
    const retryAtMs = Date.now() + 5_000;
    await origin.publishVkApiCooldown(scopeFor(token), retryAtMs);
    global.fetch = jest.fn().mockResolvedValue(Response.json({ response: [] }));
    const started = Date.now();
    await expect(client(peer, token).request('wall.get', {})).rejects.toMatchObject({
      code: 'provider_cooldown',
      retryAtMs,
    });
    expect(Date.now() - started).toBeLessThan(2_500);
    expect(global.fetch).not.toHaveBeenCalled();
    expect(await inspector.get(cooldownKey(scopeFor(token)))).toBe(String(retryAtMs));
  });

  it.each(['before-write', 'after-real-eval'] as const)(
    'preserves the original HTTP error and a new origin request after %s publication failure',
    async (failure) => {
      const origin = await limiter();
      const peer = await limiter();
      const token = randomUUID();
      const originRedis = runtimeRedis(origin);
      jest.spyOn(originRedis, 'eval').mockRestore();
      const evaluate = originRedis.eval.bind(originRedis);
      let failed = false;
      jest.spyOn(originRedis, 'eval').mockImplementation(async (...args) => {
        for (const key of args.slice(2, 2 + Number(args[1]))) ownedKeys.add(String(key));
        if (Number(args[1]) === 1 && !failed) {
          failed = true;
          ownedKeys.add(String(args[2]));
          if (failure === 'after-real-eval') await evaluate(...args);
          throw new Error('publication acknowledgement unavailable');
        }
        return evaluate(...args);
      });
      global.fetch = jest.fn(
        async () => new Response('', { status: 429, headers: { 'Retry-After': '120' } }),
      );
      const api = client(origin, token);
      const error = await api.request('wall.get', {}).catch((error: unknown) => error);
      expect(error).toMatchObject({
        code: 'http_429',
        retryable: true,
        retryAtMs: expect.any(Number),
      });
      await expect(api.request('wall.get', {})).rejects.toMatchObject({
        code: 'provider_cooldown',
      });
      expect(global.fetch).toHaveBeenCalledTimes(1);
      const stored = await inspector.get(cooldownKey(scopeFor(token)));
      if (failure === 'after-real-eval') {
        expect(stored).not.toBeNull();
        await expect(client(peer, token).request('video.get', {})).rejects.toMatchObject({
          code: 'provider_cooldown',
          retryAtMs: Number(stored),
        });
        expect(global.fetch).toHaveBeenCalledTimes(1);
      } else {
        // FLAG: No acknowledged or observed shared write: only the origin's retained pause is proved.
        expect(stored).toBeNull();
      }
    },
  );

  it('prevents a fetch when local cooldown arrives after a real reservation but before its ACK', async () => {
    const service = await limiter();
    const token = randomUUID();
    const redis = runtimeRedis(service);
    jest.spyOn(redis, 'eval').mockRestore();
    const evaluate = redis.eval.bind(redis);
    let acknowledge!: () => void;
    let admitted!: () => void;
    const reservationCommitted = new Promise<void>((resolve) => (admitted = resolve));
    const releaseAcknowledgement = new Promise<void>((resolve) => (acknowledge = resolve));
    let held = false;
    jest.spyOn(redis, 'eval').mockImplementation(async (...args) => {
      for (const key of args.slice(2, 2 + Number(args[1]))) ownedKeys.add(String(key));
      const reply = await evaluate(...args);
      if (Number(args[1]) === 3 && !held) {
        held = true;
        admitted();
        await releaseAcknowledgement;
      }
      return reply;
    });
    global.fetch = jest.fn().mockResolvedValue(Response.json({ response: [] }));
    const result = expect(client(service, token).request('wall.get', {})).rejects.toMatchObject({
      code: 'provider_cooldown',
    });
    try {
      await reservationCommitted;
      await service.publishVkApiCooldown(scopeFor(token), Date.now() + 120_000);
    } finally {
      acknowledge();
    }
    await result;
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('rejects corrupt provider evidence before incrementing the quota keys', async () => {
    const service = await limiter();
    const scope = scopeFor(randomUUID());
    const key = cooldownKey(scope);
    ownedKeys.add(key);
    await inspector.set(key, 'not-a-deadline', 'PX', 20_000);
    await expect(service.reserveVkApiSlot('wall.get', admission(scope))).rejects.toThrow(
      'Invalid VK provider cooldown',
    );
    const quotas = [...ownedKeys].filter((key) => key.startsWith('vkapi:rps:'));
    expect(await inspector.mget(...quotas)).toEqual([null, null]);
  });
});
