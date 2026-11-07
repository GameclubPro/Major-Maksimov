import { randomUUID } from 'node:crypto';
import { setTimeout as pause } from 'node:timers/promises';
import { ConfigService } from '@nestjs/config';
import type Redis from 'ioredis';
import { COMMERCIAL_LLM_ENFORCEMENT_KEYS as keys } from '../moderation/commercial/commercial-llm-enforcement.mailbox';
import { COMMERCIAL_LLM_POOL_ADMISSION_KEYS as poolKeys } from '../moderation/commercial/commercial-llm-pool-admission.mailbox';
import { createCommercialLlmRedis } from '../moderation/commercial/commercial-llm-shadow.lease';
import {
  COMMERCIAL_AI_STATUS_MAX_BYTES,
  READ_COMMERCIAL_AI_STATUS,
  SafetyDeskCommercialAiService,
} from './safety-desk-commercial-ai.service';

const redisUrl = process.env.MAXIM_TEST_REDIS_URL?.trim() ?? '';
const integration = redisUrl ? describe : describe.skip;

integration('bounded commercial AI diagnostics on disposable Redis', () => {
  let redis: Redis;
  let fixtureCreated = false;
  let ownsStatus = false;
  let ownsPoolStatus = false;
  const owner = randomUUID();
  const services: SafetyDeskCommercialAiService[] = [];

  beforeAll(async () => {
    if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(redisUrl).hostname))
      throw new Error('Disposable loopback Redis required');
    redis = createCommercialLlmRedis(redisUrl);
    await redis.connect();
    if ((await redis.exists(keys.status, keys.worker, poolKeys.status)) !== 0)
      throw new Error('Commercial AI diagnostic fixture keys must be absent');
    expect(await redis.set(keys.worker, owner, 'NX')).toBe('OK');
    fixtureCreated = true;
  });

  afterEach(async () => {
    services.splice(0).forEach((service) => service.onModuleDestroy());
    jest.restoreAllMocks();
    if (!fixtureCreated) return;
    try {
      expect(await redis.get(keys.worker)).toBe(owner);
      expect(await redis.pttl(keys.worker)).toBe(-1);
    } finally {
      if (ownsStatus) await redis.del(keys.status);
      ownsStatus = false;
      if (ownsPoolStatus) await redis.del(poolKeys.status);
      ownsPoolStatus = false;
    }
  });

  afterAll(async () => {
    if (!redis) return;
    try {
      if (fixtureCreated)
        await redis.eval(
          "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end",
          1,
          keys.worker,
          owner,
        );
    } finally {
      redis.disconnect();
    }
  });

  const read = (): Promise<unknown> =>
    redis.eval(READ_COMMERCIAL_AI_STATUS, 1, keys.status, COMMERCIAL_AI_STATUS_MAX_BYTES);

  async function write(raw: string, ttlMs?: number) {
    ownsStatus = true;
    if (ttlMs === undefined) await redis.set(keys.status, raw);
    else await redis.set(keys.status, raw, 'PX', ttlMs);
  }

  async function monitorBarrier(monitor: Redis) {
    const marker = randomUUID();
    await new Promise<void>((resolve, reject) => {
      const finish = (error?: unknown) => {
        clearTimeout(timeout);
        monitor.off('monitor', observe);
        if (error) reject(error);
        else resolve();
      };
      const observe = (_time: string, args: string[]) => {
        if (args[0]?.toLowerCase() === 'ping' && args[1] === marker) finish();
      };
      const timeout = setTimeout(() => finish(new Error('Redis monitor barrier missing')), 2_000);
      monitor.on('monitor', observe);
      void redis.ping(marker).catch(finish);
    });
  }

  it('reads pool generations without substituting a healthy legacy status when pool evidence disappears', async () => {
    const now = Date.now();
    const clock = jest.spyOn(Date, 'now').mockReturnValue(now);
    const snapshot = (kept: number, active: number) =>
      JSON.stringify({
        stage: 'commercial-ai',
        schemaVersion: 2,
        mode: 'ENFORCE',
        heartbeatAt: new Date(now).toISOString(),
        lastSuccessAt: null,
        active,
        observationProcessId: randomUUID(),
        observationStartedAt: new Date(now).toISOString(),
        outcomeBasis: 'process_cumulative',
        outcomes: { kept },
        pendingDiscardBasis: 'redis_namespace_cumulative',
        pendingDiscards: {},
      });
    const legacy = snapshot(99, 3);
    await write(legacy, 30_000);
    const pool = snapshot(2, 4);
    ownsPoolStatus = true;
    await redis.set(poolKeys.status, pool, 'PX', 30_000);
    const service = new SafetyDeskCommercialAiService(
      new ConfigService({
        COMMERCIAL_LLM_ENFORCEMENT_ENABLED: true,
        COMMERCIAL_LLM_POOL_ENABLED: true,
        COMMERCIAL_LLM_POOL_WORKERS_ENABLED: true,
        REDIS_URL: redisUrl,
      }),
    );
    services.push(service);
    expect(await service.getSnapshot()).toMatchObject({
      availability: 'FRESH',
      active: 4,
      observationProcessId: JSON.parse(pool).observationProcessId,
      outcomes: { kept: 2 },
    });
    await redis.del(poolKeys.status);
    clock.mockReturnValue(now + 2_001);
    expect(await service.getSnapshot()).toMatchObject({ availability: 'MISSING', outcomes: null });
    expect(await redis.get(keys.status)).toBe(legacy);
  });

  it('returns missing for the absent exact status key and preserves neighboring ownership', async () => {
    await expect(read()).resolves.toEqual(['missing']);
    expect(await redis.exists(keys.status)).toBe(0);
  });

  it('returns the exact UTF-8 byte boundary and a live Redis TTL', async () => {
    const raw = 'я'.repeat(COMMERCIAL_AI_STATUS_MAX_BYTES / 2);
    expect(Buffer.byteLength(raw, 'utf8')).toBe(COMMERCIAL_AI_STATUS_MAX_BYTES);
    await write(raw, 30_000);
    const result = await read();
    expect(result).toEqual(['value', raw, expect.any(Number)]);
    if (!Array.isArray(result)) throw new Error('Expected Redis status tuple');
    expect(result[2]).toBeGreaterThan(0);
    expect(result[2]).toBeLessThanOrEqual(30_000);
    expect(await redis.get(keys.status)).toBe(raw);
  });

  it('rejects an oversized UTF-8 value before executing GET', async () => {
    const raw = 'я'.repeat(COMMERCIAL_AI_STATUS_MAX_BYTES / 2 + 1);
    expect(raw.length).toBeLessThan(COMMERCIAL_AI_STATUS_MAX_BYTES);
    expect(Buffer.byteLength(raw, 'utf8')).toBeGreaterThan(COMMERCIAL_AI_STATUS_MAX_BYTES);
    await write(raw, 30_000);
    const monitor = await redis.monitor();
    const commands: string[] = [];
    monitor.on('monitor', (_time: string, args: string[]) => {
      if (args[1] === keys.status) commands.push(args[0]!.toLowerCase());
    });
    try {
      await expect(read()).resolves.toEqual(['invalid']);
      await monitorBarrier(monitor);
      expect(commands).toContain('strlen');
      expect(commands).not.toContain('get');
      expect(commands).not.toContain('pttl');
    } finally {
      monitor.disconnect();
    }
  });

  it('rejects a non-expiring status and preserves its value', async () => {
    await write('{"synthetic":true}');
    await expect(read()).resolves.toEqual(['invalid']);
    expect(await redis.get(keys.status)).toBe('{"synthetic":true}');
    expect(await redis.pttl(keys.status)).toBe(-1);
  });

  it('rejects a non-string status without changing the stored type or fields', async () => {
    ownsStatus = true;
    await redis.hset(keys.status, 'synthetic', 'retained');
    await redis.pexpire(keys.status, 30_000);
    await expect(read()).resolves.toEqual(['invalid']);
    expect(await redis.hgetall(keys.status)).toEqual({ synthetic: 'retained' });
  });

  it('reports expiration using the real Redis clock', async () => {
    await write('{"synthetic":true}', 30);
    await pause(80);
    await expect(read()).resolves.toEqual(['missing']);
    expect(await redis.pttl(keys.status)).toBe(-2);
  });

  it('refreshes cached process generations and closes without altering ownership', async () => {
    let now = Date.now();
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    const firstGeneration = randomUUID();
    const secondGeneration = randomUUID();
    const status = (observationProcessId: string, kept: number) => ({
      stage: 'commercial-ai',
      schemaVersion: 2,
      mode: 'ENFORCE',
      heartbeatAt: new Date(now).toISOString(),
      lastSuccessAt: new Date(now - 100).toISOString(),
      active: 0,
      outcome: 'idle',
      observationProcessId,
      observationStartedAt: new Date(now - 1_000).toISOString(),
      availabilityState: 'ready',
      availabilityObservedAt: new Date(now).toISOString(),
      outcomeBasis: 'process_cumulative',
      outcomes: { kept },
      pendingDiscardBasis: 'redis_namespace_cumulative',
      pendingDiscards: { pending_expired: 4 },
    });
    const service = new SafetyDeskCommercialAiService(
      new ConfigService({ COMMERCIAL_LLM_ENFORCEMENT_ENABLED: true, REDIS_URL: redisUrl }),
    );
    services.push(service);
    await write(JSON.stringify(status(firstGeneration, 9)), 30_000);
    const first = await service.getSnapshot();
    expect(first).toMatchObject({
      availability: 'FRESH',
      observationProcessId: firstGeneration,
      admission: 'READY',
      lastRecordedResultAt: new Date(now - 100).toISOString(),
      outcomes: { kept: 9 },
      pendingDiscards: { expired: 4 },
      confirmedDeletes: null,
      trafficCoverage: 'NOT_ESTABLISHED',
    });
    now += 1_000;
    const secondRaw = JSON.stringify(status(secondGeneration, 1));
    await write(secondRaw, 30_000);
    expect(await service.getSnapshot()).toMatchObject({
      observationProcessId: firstGeneration,
      observedAt: first.observedAt,
      outcomes: { kept: 9 },
    });
    now += 1_001;
    expect(await service.getSnapshot()).toMatchObject({
      availability: 'FRESH',
      observationProcessId: secondGeneration,
      observedAt: new Date(now).toISOString(),
      admission: 'READY',
      outcomes: { kept: 1 },
      pendingDiscards: { expired: 4 },
      confirmedDeletes: null,
    });
    service.onModuleDestroy();
    expect(await service.getSnapshot()).toMatchObject({
      availability: 'UNAVAILABLE',
      observationProcessId: null,
      outcomes: null,
      admission: 'UNKNOWN',
    });
    expect(await redis.get(keys.status)).toBe(secondRaw);
  });
});
