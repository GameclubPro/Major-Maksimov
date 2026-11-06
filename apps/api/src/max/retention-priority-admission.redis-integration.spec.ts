import { randomUUID } from 'node:crypto';
import { Queue } from 'bullmq';
import Redis from 'ioredis';
import { ADMIN_MANUAL_COMMAND_QUEUE } from '../admin/admin-manual-command.queue';
import { MAX_API_RATE_LIMIT_RESERVATION_SCRIPT } from './max-client.service';
import {
  buildRetentionPriorityQueueDescriptors,
  HIGHER_PRIORITY_ACTIVITY_ACQUIRE_SCRIPT,
  HIGHER_PRIORITY_ACTIVITY_RELEASE_SCRIPT,
  HIGHER_PRIORITY_ACTIVITY_RENEW_SCRIPT,
  RETENTION_PRIORITY_RESERVATION_MARKER,
  RETENTION_PRIORITY_VERSION,
  retentionPriorityQueueKeys,
  type RetentionPriorityReservationOptions,
} from './retention-priority-admission';

const redisUrl = process.env.MAXIM_TEST_REDIS_URL ?? '';
const localRedis = /^redis:\/\/(localhost|127\.0\.0\.1|\[::1\])[:/]/u.test(redisUrl);
const describeRedis = localRedis ? describe : describe.skip;

describeRedis('retention final priority admission against actual Redis', () => {
  let redis: Redis;
  let peer: Redis;
  let prefix: string;
  let token: string;
  let permit: string;
  let activity: string;
  let unavailable: string;
  let queue: Queue;
  let queueKeys: ReturnType<typeof buildRetentionPriorityQueueDescriptors>;

  beforeAll(async () => {
    redis = new Redis(redisUrl);
    peer = new Redis(redisUrl);
    await Promise.all([redis.ping(), peer.ping()]);
  });
  beforeEach(() => {
    prefix = `test-retention-priority-${randomUUID()}`;
    token = `${prefix}:token`;
    permit = `${prefix}:permit`;
    activity = `${prefix}:activity`;
    unavailable = `${prefix}:unavailable`;
    queueKeys = buildRetentionPriorityQueueDescriptors(prefix);
    queue = new Queue(queueKeys[0]!.name, { prefix, connection: { url: redisUrl } });
  });
  afterEach(async () => {
    await queue.obliterate({ force: true });
    await queue.close();
    await redis.del(
      token,
      `${token}:window:v1`,
      `${token}:cooldown`,
      permit,
      activity,
      unavailable,
      ...retentionPriorityQueueKeys(queueKeys),
    );
  });
  afterAll(async () => {
    await Promise.all([redis?.quit(), peer?.quit()]);
  });

  async function nowMs(): Promise<number> {
    const [sec, micros] = await redis.time();
    return Number(sec) * 1_000 + Math.floor(Number(micros) / 1_000);
  }

  async function publish(overrides: Record<string, string> = {}): Promise<void> {
    const at = await nowMs();
    await redis
      .multi()
      .hset(permit, {
        version: RETENTION_PRIORITY_VERSION,
        sampleStartedAtMs: String(at),
        validUntilMs: String(at + 900),
        ...overrides,
      })
      .pexpire(permit, 900)
      .exec();
  }

  function reservation(retention = true, operationId: string = randomUUID()) {
    const options: RetentionPriorityReservationOptions = {
      version: RETENTION_PRIORITY_VERSION,
      dimensions: 1,
      retention,
      ...(!retention ? { operationId } : {}),
    };
    const keys = [
      token,
      permit,
      activity,
      unavailable,
      ...(retention ? retentionPriorityQueueKeys(queueKeys) : []),
    ];
    return {
      keys,
      args: ['30', '29', RETENTION_PRIORITY_RESERVATION_MARKER + JSON.stringify(options), '2000'],
    };
  }

  async function reserve(retention = true, operationId?: string, client = redis) {
    const { keys, args } = reservation(retention, operationId);
    return (await client.eval(
      MAX_API_RATE_LIMIT_RESERVATION_SCRIPT,
      keys.length,
      ...keys,
      ...args,
    )) as [number, number, number, string?];
  }

  async function expectNoSlots(): Promise<void> {
    expect(await redis.get(token)).toBeNull();
    expect(await redis.zcard(`${token}:window:v1`)).toBe(0);
  }

  it('requires a fresh complete permit without spending any transport slot', async () => {
    expect(await reserve()).toEqual([0, -1, 1000, 'permit_missing']);
    await expectNoSlots();
    await publish({ version: 'incompatible' });
    expect(await reserve()).toEqual([0, -1, 1000, 'permit_expired']);
    await expectNoSlots();
    await publish({ sampleStartedAtMs: String((await nowMs()) - 3_000) });
    expect(await reserve()).toEqual([0, -1, 1000, 'permit_expired']);
    await expectNoSlots();
    await publish({ sampleStartedAtMs: 'NaN' });
    expect(await reserve()).toEqual([0, -1, 1000, 'permit_expired']);
    await expectNoSlots();
    await publish();
    expect(await reserve()).toEqual([1, 0, 0]);
  });

  it.each(['wait', 'paused', 'active', 'prioritized'] as const)(
    'sees %s work inserted by another producer after a quiet snapshot',
    async (state) => {
      await publish();
      const key = queueKeys[0]![state];
      if (state === 'prioritized') await peer.zadd(key, 1, 'higher');
      else await peer.lpush(key, 'higher');
      expect(await reserve()).toEqual([
        0,
        -1,
        1000,
        state === 'active' ? 'higher_priority_active' : 'higher_priority_ready',
      ]);
      await expectNoSlots();
      await peer.del(key);
      await publish();
      expect(await reserve()).toEqual([1, 0, 0]);
    },
  );

  it.each(['wait', 'active'] as const)(
    'blocks retention transport while manual commands are %s without consuming a slot',
    async (state) => {
      const commands = queueKeys.find(({ name }) => name === ADMIN_MANUAL_COMMAND_QUEUE);
      expect(commands).toBeDefined();
      await publish();
      await peer.lpush(commands![state], 'manual-command');

      expect(await reserve()).toEqual([
        0,
        -1,
        1000,
        state === 'active' ? 'higher_priority_active' : 'higher_priority_ready',
      ]);
      await expectNoSlots();
      await peer.del(commands![state]);
      await publish();
      expect(await reserve()).toEqual([1, 0, 0]);
    },
  );

  it('uses the actual installed BullMQ prefix and delayed score encoding', async () => {
    expect(queue.toKey('wait')).toBe(queueKeys[0]!.wait);
    expect(queue.toKey('delayed')).toBe(queueKeys[0]!.delayed);
    const future = await queue.add('future', {}, { delay: 60_000 });
    const futureScore = Number(await redis.zscore(queueKeys[0]!.delayed, future.id!));
    expect(Math.floor(futureScore / 4096)).toBe(future.timestamp + future.delay);
    await publish();
    expect(await reserve()).toEqual([1, 0, 0]);
    await redis.del(token, `${token}:window:v1`);
    const due = await queue.add('due', {}, { delay: 1 });
    const dueAt = Math.floor(Number(await redis.zscore(queueKeys[0]!.delayed, due.id!)) / 4096);
    const remaining = Math.max(0, dueAt - (await nowMs()) + 2);
    if (remaining) await new Promise((resolve) => setTimeout(resolve, remaining));
    await publish();
    expect(await reserve()).toEqual([0, -1, 1000, 'higher_priority_ready']);
    await expectNoSlots();
  });

  it('fails closed on malformed queue structures and sticky missing coverage', async () => {
    await publish();
    await redis.set(queueKeys[1]!.active, 'broken');
    expect(await reserve()).toEqual([0, -1, 1000, 'metrics_unavailable']);
    await expectNoSlots();
    await redis.del(queueKeys[1]!.active);
    await redis.set(unavailable, 'writer_failed');
    expect(await reserve()).toEqual([0, -1, 1000, 'metrics_unavailable']);
    await expectNoSlots();
  });

  it('keeps expired unresolved activity closed and does not prune evidence', async () => {
    await publish();
    await redis.zadd(activity, (await nowMs()) - 1, 'unknown-operation');
    expect(await reserve()).toEqual([0, -1, 1000, 'metrics_unavailable']);
    expect(await redis.zcard(activity)).toBe(1);
    await expectNoSlots();
    await redis.zadd(activity, (await nowMs()) + 30_000, 'unknown-operation');
    expect(await reserve()).toEqual([0, -1, 1000, 'higher_priority_active']);
  });

  it('leaves higher-priority admission usable with no permit and pending cleanup blockers', async () => {
    await redis.set(unavailable, 'history_unknown');
    await redis.lpush(queueKeys[0]!.wait, 'ordinary-work');
    expect(await reserve(false, 'ordinary-http')).toEqual([1, 0, 0]);
    expect(Number(await redis.zscore(activity, 'ordinary-http'))).toBeGreaterThan(await nowMs());
    expect(
      await redis.eval(
        HIGHER_PRIORITY_ACTIVITY_RELEASE_SCRIPT,
        2,
        activity,
        unavailable,
        'ordinary-http',
      ),
    ).toBe(1);
    expect(await redis.zcard(activity)).toBe(0);
    expect(await redis.get(unavailable)).toBe('history_unknown');
  });

  it('registers/releases nonqueue work and treats missing renewal as unavailable', async () => {
    expect(
      await redis.eval(
        HIGHER_PRIORITY_ACTIVITY_ACQUIRE_SCRIPT,
        2,
        activity,
        unavailable,
        'ingress',
        '30000',
      ),
    ).toBe(1);
    await publish();
    expect(await reserve()).toEqual([0, -1, 1000, 'higher_priority_active']);
    expect(
      await redis.eval(
        HIGHER_PRIORITY_ACTIVITY_RENEW_SCRIPT,
        2,
        activity,
        unavailable,
        'ingress',
        '30000',
      ),
    ).toBe(1);
    expect(
      await redis.eval(
        HIGHER_PRIORITY_ACTIVITY_RELEASE_SCRIPT,
        2,
        activity,
        unavailable,
        'ingress',
      ),
    ).toBe(1);
    await publish();
    expect(await reserve()).toEqual([1, 0, 0]);
    expect(
      await redis.eval(
        HIGHER_PRIORITY_ACTIVITY_RENEW_SCRIPT,
        2,
        activity,
        unavailable,
        'missing',
        '30000',
      ),
    ).toBe(0);
    expect(await redis.get(unavailable)).toBe('activity_coverage_lost');
  });

  it('preserves cooldown and all-or-nothing rolling token admission with the new shape', async () => {
    await publish();
    await redis.set(`${token}:cooldown`, '1', 'PX', 30_000);
    const cooldown = await reserve();
    expect(cooldown.slice(0, 2)).toEqual([0, 0]);
    expect(cooldown[2]).toBeGreaterThan(20_000);
    await expectNoSlots();
    await redis.del(`${token}:cooldown`);
    const { keys, args } = reservation();
    const all = (await redis.eval(
      `local function reserve(KEYS, ARGV)\n${MAX_API_RATE_LIMIT_RESERVATION_SCRIPT}\nend
       local results = {}
       for i=1,31 do results[i] = reserve(KEYS, ARGV) end
       return results`,
      keys.length,
      ...keys,
      ...args,
    )) as number[][];
    expect(all.filter((result) => result[0] === 1)).toHaveLength(30);
    expect(all[30]!.slice(0, 2)).toEqual([0, 1]);
    expect(await redis.zcard(`${token}:window:v1`)).toBe(30);
    const tat = await redis.get(token);
    await peer.lpush(queueKeys[0]!.wait, 'new-arrival');
    expect(await reserve()).toEqual([0, -1, 1000, 'higher_priority_ready']);
    expect(await redis.get(token)).toBe(tat);
    expect(await redis.zcard(`${token}:window:v1`)).toBe(30);
  });
});
