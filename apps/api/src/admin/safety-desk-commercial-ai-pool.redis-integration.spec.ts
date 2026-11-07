import { randomUUID } from 'node:crypto';
import { setTimeout as pause } from 'node:timers/promises';
import { ConfigService } from '@nestjs/config';
import type Redis from 'ioredis';
import { createCommercialLlmRedis } from '../moderation/commercial/commercial-llm-shadow.lease';
import {
  COMMERCIAL_LLM_POOL_PROFILES,
  commercialLlmPoolNodeKeys,
  type CommercialLlmPoolNodeId,
} from '../moderation/commercial/commercial-llm-pool.protocol';
import {
  COMMERCIAL_AI_POOL_EXPECTED,
  COMMERCIAL_AI_POOL_READ_KEYS,
  READ_COMMERCIAL_AI_POOL,
} from './safety-desk-commercial-ai-pool-read';
import {
  projectCommercialAiPool,
  SafetyDeskCommercialAiPoolService,
} from './safety-desk-commercial-ai-pool.service';

const redisUrl = process.env.MAXIM_TEST_REDIS_URL?.trim() ?? '';
const integration = redisUrl ? describe : describe.skip;
const config = { workersEnabled: true, routingEnabled: true, policy: 'confirm-positive' as const };

integration('commercial pool diagnostics with real Redis', () => {
  let redis: Redis;
  let owned = false;
  const services: SafetyDeskCommercialAiPoolService[] = [];
  beforeAll(async () => {
    if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(redisUrl).hostname))
      throw new Error('Disposable Redis only');
    redis = createCommercialLlmRedis(redisUrl);
    await redis.connect();
    if (await redis.exists(...COMMERCIAL_AI_POOL_READ_KEYS))
      throw new Error('Fixture keys must be absent');
    owned = true;
  });
  afterEach(async () => {
    services.splice(0).forEach((service) => service.onModuleDestroy());
    jest.restoreAllMocks();
    if (owned) await redis.del(...COMMERCIAL_AI_POOL_READ_KEYS);
  });
  afterAll(() => redis?.disconnect());
  const read = async () => {
    const at = Date.now();
    const raw = await redis.eval(
      READ_COMMERCIAL_AI_POOL,
      COMMERCIAL_AI_POOL_READ_KEYS.length,
      ...COMMERCIAL_AI_POOL_READ_KEYS,
      COMMERCIAL_AI_POOL_EXPECTED,
    );
    if (typeof raw !== 'string') throw new Error('Expected bounded projection');
    return { kind: 'value' as const, at, raw };
  };
  async function node(id: CommercialLlmPoolNodeId, ready = true, ttl = 6000) {
    const keys = commercialLlmPoolNodeKeys(id),
      session = randomUUID();
    await redis.set(keys.lease, session, 'PX', 10000);
    await redis.set(
      keys.heartbeat,
      JSON.stringify({
        nodeId: id,
        session,
        ready,
        identity: COMMERCIAL_LLM_POOL_PROFILES[id].identity,
      }),
      'PX',
      ttl,
    );
    return { keys, session };
  }
  it('distinguishes ready, reserved and disconnected nodes without returning secrets or reading slot bodies', async () => {
    const a = await node('server-9b'),
      b = await node('pc-a-4b'),
      cpu = await node('pc-a-cpu-9b');
    await redis.set(a.keys.slot, 'PRIVATE_PROMPT_AND_SOURCE', 'PX', 20000);
    const result = await read();
    expect(result.raw).not.toContain(a.session);
    expect(result.raw).not.toContain(b.session);
    expect(result.raw).not.toContain(cpu.session);
    expect(result.raw).not.toContain('PRIVATE_PROMPT');
    expect(projectCommercialAiPool(config, result, Date.now())).toMatchObject({
      availability: 'FRESH',
      metrics: null,
      nodes: [
        { nodeId: 'server-9b', state: 'SLOT_OCCUPIED' },
        { nodeId: 'pc-a-4b', state: 'READY' },
        { nodeId: 'pc-b-9b', state: 'OFFLINE' },
        { nodeId: 'pc-a-cpu-9b', state: 'READY' },
      ],
      confirmedDeletes: null,
    });
    expect(await redis.get(a.keys.slot)).toBe('PRIVATE_PROMPT_AND_SOURCE');
    expect(await redis.get(a.keys.lease)).toBe(a.session);
    expect(await redis.get(cpu.keys.lease)).toBe(cpu.session);
  });
  it.each([3, 4])(
    'reads %i-node process metrics after the fourth node keys without adding attempts',
    async (length) => {
      const { keys, session } = await node('pc-a-cpu-9b');
      const now = Date.now();
      const at = new Date(now).toISOString();
      const nodes = ['server-9b', 'pc-a-4b', 'pc-b-9b', 'pc-a-cpu-9b']
        .slice(0, length)
        .map((nodeId) => ({
          nodeId,
          completedAttempts: nodeId === 'pc-a-cpu-9b' ? 7 : 0,
          failedAttempts: 0,
          lastCompletedAt: nodeId === 'pc-a-cpu-9b' ? at : null,
          lastFailureAt: null,
          ewmaDurationMs: nodeId === 'pc-a-cpu-9b' ? 6000 : null,
        }));
      const status = JSON.stringify({
        stage: 'commercial-ai',
        schemaVersion: 2,
        mode: 'ENFORCE',
        heartbeatAt: at,
        lastSuccessAt: length === 4 ? at : null,
        active: length,
        observationProcessId: randomUUID(),
        observationStartedAt: new Date(now - 60000).toISOString(),
        outcomeBasis: 'process_cumulative',
        outcomes: {},
        pendingDiscardBasis: 'redis_namespace_cumulative',
        pendingDiscards: {},
        poolDiagnostics: {
          schemaVersion: 1,
          nodes,
          consultations: { completed: 0, noCapacity: 0, budgetExhausted: 0 },
        },
      });
      const statusKey = COMMERCIAL_AI_POOL_READ_KEYS.at(-1)!;
      await redis.set(statusKey, status, 'PX', 30000);
      const projected = projectCommercialAiPool(config, await read(), Date.now());
      expect(projected.availability).toBe('FRESH');
      expect(projected.nodes).toHaveLength(4);
      expect(projected.nodes?.at(-1)).toMatchObject({ nodeId: 'pc-a-cpu-9b', state: 'READY' });
      expect(projected.metrics?.diagnostics.nodes).toEqual(nodes);
      expect(await redis.get(statusKey)).toBe(status);
      expect(await redis.get(keys.lease)).toBe(session);
    },
  );
  it('rejects a CPU 9B heartbeat carrying PC-A 4B identity without affecting the 4B registration', async () => {
    const gpu = await node('pc-a-4b');
    const cpu = await node('pc-a-cpu-9b');
    const raw = JSON.stringify({
      nodeId: 'pc-a-cpu-9b',
      session: cpu.session,
      ready: true,
      identity: COMMERCIAL_LLM_POOL_PROFILES['pc-a-4b'].identity,
    });
    await redis.set(cpu.keys.heartbeat, raw, 'PX', 6000);
    const projected = projectCommercialAiPool(config, await read(), Date.now());
    expect(projected.nodes?.[1]).toMatchObject({ nodeId: 'pc-a-4b', state: 'READY' });
    expect(projected.nodes?.[3]).toMatchObject({ nodeId: 'pc-a-cpu-9b', state: 'INVALID' });
    expect(await redis.get(cpu.keys.heartbeat)).toBe(raw);
    expect(await redis.get(gpu.keys.lease)).toBe(gpu.session);
  });
  it('uses real TTL expiry and does not keep cached readiness alive', async () => {
    await node('pc-a-4b', true, 60);
    const result = await read();
    await pause(90);
    expect(projectCommercialAiPool(config, result, Date.now()).nodes?.[1].state).toBe('STALE');
    expect(projectCommercialAiPool(config, await read(), Date.now()).nodes?.[1].state).toBe(
      'OFFLINE',
    );
  });
  it.each(['identity', 'session', 'type', 'oversize', 'permanent', 'slot-type'] as const)(
    'refuses %s corruption while preserving data',
    async (variant) => {
      const { keys, session } = await node('pc-b-9b');
      if (variant === 'type') {
        await redis.del(keys.heartbeat);
        await redis.hset(keys.heartbeat, 'secret', 'private');
      } else if (variant === 'slot-type') await redis.hset(keys.slot, 'private', 'source');
      else if (variant === 'oversize')
        await redis.set(keys.heartbeat, 'x'.repeat(4097), 'PX', 6000);
      else if (variant === 'permanent') await redis.persist(keys.heartbeat);
      else {
        const value = JSON.parse((await redis.get(keys.heartbeat))!);
        if (variant === 'session') value.session = randomUUID();
        else value.identity.modelAlias = 'untrusted-model';
        await redis.set(keys.heartbeat, JSON.stringify(value), 'PX', 6000);
      }
      const before = await redis.dump(keys.heartbeat);
      expect(projectCommercialAiPool(config, await read(), Date.now()).nodes?.[2].state).toBe(
        'INVALID',
      );
      expect(await redis.dump(keys.heartbeat)).toEqual(before);
      expect(await redis.get(keys.lease)).toBe(session);
    },
  );
  it('projects not-ready independently and bounds every Redis read before GET', async () => {
    const { keys } = await node('server-9b', false);
    const b = await node('pc-a-4b');
    await redis.set(b.keys.heartbeat, 'x'.repeat(4097), 'PX', 6000);
    await redis.set(keys.slot, 'private-source', 'PX', 20000);
    const monitor = await redis.monitor();
    const commands: string[][] = [];
    monitor.on('monitor', (_time: string, args: string[]) => commands.push(args));
    try {
      await read();
      const marker = randomUUID();
      const barrier = new Promise<void>((resolve) => {
        monitor.on('monitor', (_time: string, args: string[]) => {
          if (args[0] === 'ping' && args[1] === marker) resolve();
        });
      });
      await redis.ping(marker);
      await barrier;
      const gets = commands
        .filter((args) => args[0]?.toLowerCase() === 'get')
        .map((args) => args[1]);
      expect(gets).not.toContain(keys.slot);
      expect(gets).not.toContain(b.keys.heartbeat);
      expect(
        commands.some((args) =>
          ['set', 'del', 'expire', 'pexpire', 'scan', 'keys', 'mget'].includes(
            args[0]?.toLowerCase() ?? '',
          ),
        ),
      ).toBe(false);
    } finally {
      monitor.disconnect();
    }
    await redis.del(keys.slot);
    expect(projectCommercialAiPool(config, await read(), Date.now()).nodes?.[0].state).toBe(
      'NOT_READY',
    );
  });
  it('caches a bounded snapshot, refreshes after two seconds, and closes without touching registrations', async () => {
    const a = await node('pc-a-4b');
    const service = new SafetyDeskCommercialAiPoolService(
      new ConfigService({
        COMMERCIAL_LLM_POOL_WORKERS_ENABLED: true,
        COMMERCIAL_LLM_POOL_ENABLED: true,
        REDIS_URL: redisUrl,
      }),
    );
    services.push(service);
    const first = await service.getSnapshot();
    await redis.del(a.keys.heartbeat);
    expect((await service.getSnapshot()).nodes?.[1].state).toBe('READY');
    const time = Date.now();
    jest.spyOn(Date, 'now').mockReturnValue(time + 2001);
    expect((await service.getSnapshot()).nodes?.[1].state).toBe('OFFLINE');
    service.onModuleDestroy();
    expect((await service.getSnapshot()).availability).toBe('UNAVAILABLE');
    expect(first.metrics).toBeNull();
    expect(await redis.get(a.keys.lease)).toBe(a.session);
  });
});
