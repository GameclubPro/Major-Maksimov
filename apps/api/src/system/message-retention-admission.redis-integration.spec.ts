import { randomUUID } from 'node:crypto';
import Redis from 'ioredis';
import { ConfigService } from '@nestjs/config';
import {
  activityReleaseReceiptKey,
  buildRetentionPriorityQueueDescriptors,
  retentionPriorityQueueKeys,
  HIGHER_PRIORITY_ACTIVITY_KEY,
  HIGHER_PRIORITY_ACTIVITY_UNAVAILABLE_KEY,
  retentionPriorityTrafficKey,
} from '../max/retention-priority-admission';
import { WebhookIngressMetricsService } from './webhook-ingress-metrics.service';
import {
  evaluateRetentionWindow,
  type RetentionObservation,
} from './message-retention-admission.policy';
import {
  RETENTION_COMMIT_SAMPLE_SCRIPT,
  RETENTION_RELEASE_COLLECTOR_SCRIPT,
  RETENTION_SAMPLE_SCRIPT,
} from './message-retention-admission.redis';

const redisUrl = process.env.MAXIM_TEST_REDIS_URL ?? '';
const localRedis = /^redis:\/\/(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(redisUrl);

(localRedis ? describe : describe.skip)('retention admission with real Redis', () => {
  let first: Redis;
  let second: Redis;
  let prefix: string;
  let ownedKeys: Set<string>;
  const own = (key: string) => {
    ownedKeys.add(key);
    return key;
  };

  beforeEach(() => {
    first = new Redis(redisUrl);
    second = new Redis(redisUrl);
    prefix = `retention-admission-native:${randomUUID()}`;
    ownedKeys = new Set();
  });
  afterEach(async () => {
    if (ownedKeys.size) await first.del(...ownedKeys);
    await Promise.all([first.quit(), second.quit()]);
  });

  const serverNow = async () => {
    const [seconds, microseconds] = await first.time();
    return Number(seconds) * 1_000 + Math.floor(Number(microseconds) / 1_000);
  };

  it('samples all registered queue structures and only due delayed jobs with BullMQ scores', async () => {
    const descriptors = buildRetentionPriorityQueueDescriptors(prefix);
    const keys = retentionPriorityQueueKeys(descriptors);
    keys.forEach(own);
    const traffic = `${prefix}:traffic`;
    const activity = own(`${prefix}:activity`);
    const unavailable = own(`${prefix}:unavailable`);
    const now = await serverNow();
    own(`${traffic}:${Math.floor(now / 60_000) * 60}`);
    own(`${traffic}:${Math.floor(now / 60_000) * 60 + 60}`);
    await first.zadd(descriptors[0]!.delayed, (now + 60_000) * 4_096, 'future');
    const sample = () =>
      first.eval(
        RETENTION_SAMPLE_SCRIPT,
        3 + keys.length,
        traffic,
        activity,
        unavailable,
        ...keys,
        '300',
      ) as Promise<number[]>;
    expect((await sample()).slice(1, 4)).toEqual([0, 0, 0]);
    await first.zadd(descriptors[0]!.delayed, (now - 1) * 4_096 + 4_095, 'due');
    await first.lpush(descriptors[1]!.paused, 'paused-ready');
    await first.lpush(descriptors[2]!.active, 'in-progress');
    expect((await sample()).slice(1, 4)).toEqual([1, 1, 1]);
    await first.set(descriptors[3]!.wait, 'corrupt');
    await expect(sample()).rejects.toThrow('Invalid priority queue list');
  });

  it('has one collector, commits a short permit, and rejects a former owner without renewing anything', async () => {
    const collector = own(`${prefix}:collector`);
    const status = own(`${prefix}:status`);
    const permit = own(`${prefix}:permit`);
    const contenders = await Promise.all([
      first.set(collector, 'one', 'PX', 4_000, 'NX'),
      second.set(collector, 'two', 'PX', 4_000, 'NX'),
    ]);
    expect(contenders.filter((value) => value === 'OK')).toHaveLength(1);
    const owner = (await first.get(collector))!;
    const started = await serverNow();
    expect(
      await first.eval(
        RETENTION_COMMIT_SAMPLE_SCRIPT,
        3,
        collector,
        status,
        permit,
        owner,
        String(started),
        '{"observed":true}',
        '1',
      ),
    ).toBe(1);
    expect(await first.hgetall(permit)).toMatchObject({
      version: '1',
      sampleStartedAtMs: String(started),
    });
    expect(await first.pttl(permit)).toBeLessThanOrEqual(900);
    expect(
      await second.eval(
        RETENTION_COMMIT_SAMPLE_SCRIPT,
        3,
        collector,
        status,
        permit,
        'former-owner',
        String(started),
        'invalid',
        '1',
      ),
    ).toBe(0);
    expect(await first.get(status)).toBe('{"observed":true}');
    await first.pexpireat(permit, started - 1);
    expect(await first.exists(permit)).toBe(0);
    expect(await first.eval(RETENTION_RELEASE_COLLECTOR_SCRIPT, 2, collector, permit, owner)).toBe(
      1,
    );
  });

  it('treats unfinished priority work as active and lost observation coverage as unavailable', async () => {
    const descriptors = buildRetentionPriorityQueueDescriptors(prefix);
    const traffic = `${prefix}:traffic`;
    const activity = own(`${prefix}:activity`);
    const unavailable = own(`${prefix}:unavailable`);
    const now = await serverNow();
    own(`${traffic}:${Math.floor(now / 60_000) * 60}`);
    own(`${traffic}:${Math.floor(now / 60_000) * 60 + 60}`);
    const keys = retentionPriorityQueueKeys(descriptors);
    const sample = () =>
      first.eval(
        RETENTION_SAMPLE_SCRIPT,
        3 + keys.length,
        traffic,
        activity,
        unavailable,
        ...keys,
        '300',
      ) as Promise<number[]>;
    await first.zadd(activity, now + 30_000, 'unfinished-receipt');
    expect((await sample())[2]).toBe(1);
    await first.zadd(activity, now - 1, 'unfinished-receipt');
    await expect(sample()).rejects.toThrow('Stale higher priority activity');
    await first.del(activity);
    await first.set(unavailable, 'lost-writer');
    await expect(sample()).rejects.toThrow('Higher priority observation unavailable');
  });

  it('publishes after a complete current quiet minute without any history key', async () => {
    const collector = own(`${prefix}:collector`);
    const status = own(`${prefix}:status`);
    const permit = own(`${prefix}:permit`);
    await first.set(collector, 'current-owner', 'PX', 4_000);
    const now = await serverNow();
    const observations: RetentionObservation[] = Array.from({ length: 61 }, (_, index) => ({
      atMs: now - 60_000 + index * 1_000,
      complete: true,
      cumulativeArrivals: index,
      cumulativeHttp: index,
      resourcesHealthy: true,
    }));
    const evaluation = evaluateRetentionWindow(observations, now);
    expect(evaluation.ready).toBe(true);
    expect(
      await first.eval(
        RETENTION_COMMIT_SAMPLE_SCRIPT,
        3,
        collector,
        status,
        permit,
        'current-owner',
        String(now),
        JSON.stringify(evaluation),
        evaluation.ready ? '1' : '0',
      ),
    ).toBe(1);
    expect(await second.exists(permit)).toBe(1);
    expect(JSON.parse((await second.get(status))!)).toMatchObject({
      ready: true,
      window: { complete: true, coverage: 1, arrivalsPerMinute: 60 },
    });
  });

  it('holds an ingress observation through actual completion and records its arrival in the same Redis receipt script', async () => {
    const active = own(HIGHER_PRIORITY_ACTIVITY_KEY);
    const unavailable = own(HIGHER_PRIORITY_ACTIVITY_UNAVAILABLE_KEY);
    const sqlReceipts = own(activityReleaseReceiptKey('receipt:sql'));
    await first.del(active, unavailable, sqlReceipts);
    const service = new WebhookIngressMetricsService(new ConfigService({ REDIS_URL: redisUrl }));
    const serviceRedis = (service as unknown as { redis: Redis }).redis;
    if (serviceRedis.status !== 'ready')
      await new Promise<void>((resolve) => serviceRedis.once('ready', resolve));
    let finish!: () => void;
    let started!: () => void;
    const didStart = new Promise<void>((resolve) => {
      started = resolve;
    });
    const work = service.observeReceiptWork(async () => {
      started();
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
    });
    let sqlId: string | undefined;
    try {
      await didStart;
      const ids = await first.zrange(active, 0, -1);
      expect(ids).toHaveLength(1);
      sqlId = ids[0];
      expect(sqlId).toMatch(/^receipt:/u);
      expect(await second.zscore(sqlReceipts, sqlId!)).toBeNull();
      expect(await first.exists(unavailable)).toBe(0);
      const now = await serverNow();
      const trafficKey = own(retentionPriorityTrafficKey(now));
      const nextTrafficKey = own(retentionPriorityTrafficKey(now + 60_000));
      const arrivals = async () =>
        Number((await first.hget(trafficKey, 'arrivals')) ?? 0) +
        Number((await first.hget(nextTrafficKey, 'arrivals')) ?? 0);
      const before = await arrivals();
      await service.recordReceiptPersistence({
        botId: 'native-retention-test',
        outcome: 'persisted',
        latencyMs: 1,
      });
      const after = await arrivals();
      expect(after).toBeGreaterThanOrEqual(before + 1);
    } finally {
      finish();
      await work;
      await service.onModuleDestroy();
    }
    expect(await second.zcard(active)).toBe(0);
    expect(Number(await second.zscore(sqlReceipts, sqlId!))).toBeGreaterThan(await serverNow());
    expect(await second.exists(unavailable)).toBe(0);
  });
});
