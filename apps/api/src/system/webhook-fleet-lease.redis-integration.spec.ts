import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import Redis from 'ioredis';
import { buildDefaultWebhookWorkerHeartbeatKey } from '../runtime/default-webhook-dynamic-leases';
import { DEFAULT_WEBHOOK_WORKER_GROUP_NAMES as groups } from '../runtime/runtime-topology';
import { WebhookDynamicLeaseStatusService } from './webhook-dynamic-lease-status.service';

const redisUrl = process.env.MAXIM_TEST_REDIS_URL;
const native = redisUrl ? describe : describe.skip;

function createFleetFixture() {
  const url = new URL(redisUrl!);
  if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
    throw new Error('Disposable localhost Redis required');
  url.searchParams.set('keyPrefix', 'test:lease-fleet:' + randomUUID() + ':');
  return {
    client: new Redis(url.toString()),
    service: new WebhookDynamicLeaseStatusService(new ConfigService({ REDIS_URL: url.toString() })),
  };
}

native('worker heartbeat evidence on Redis', () => {
  it('isolates missing, malformed, expired and unreadable records per group, including off', async () => {
    const { client, service } = createFleetFixture();
    const keys = groups.map(buildDefaultWebhookWorkerHeartbeatKey);
    const heartbeat = (group: string, mode: string, time = Date.now()) =>
      JSON.stringify({ workerGroupName: group, mode, updatedAtMs: time });
    try {
      const deadline = Date.now() + 3_000;
      let evidence = await service.getHeartbeatObservation();
      while (evidence.unreadable && Date.now() < deadline) {
        await delay(15);
        evidence = await service.getHeartbeatObservation();
      }
      expect(evidence).toMatchObject({ seen: [], unreadable: 0 });
      await Promise.all([
        client.set(keys[0]!, heartbeat(groups[0], 'off'), 'PX', 24_000),
        client.rpush(keys[1]!, 'wrong type'),
        client.set(keys[2]!, heartbeat(groups[1], 'canary'), 'PX', 24_000),
        client.set(keys[3]!, heartbeat(groups[3], 'on', Date.now() - 60_000), 'PX', 24_000),
      ]);
      await expect(service.getHeartbeatObservation()).resolves.toMatchObject({
        seen: [{ group: groups[0], mode: 'off' }],
        unreadable: 3,
      });
      await Promise.all([
        client.del(keys[1]!),
        client.set(keys[2]!, heartbeat(groups[2], 'invented'), 'PX', 24_000),
        client.set(keys[3]!, heartbeat(groups[3], 'on', Date.now() + 60_000), 'PX', 24_000),
      ]);
      await expect(service.getHeartbeatObservation()).resolves.toMatchObject({
        seen: [{ group: groups[0], mode: 'off' }],
        unreadable: 2,
      });
      // The reader must respect a worker's shorter configured expiry, and reject persistent keys.
      await client.set(keys[0]!, heartbeat(groups[0], 'off'), 'PX', 2_000);
      await client.set(keys[2]!, heartbeat(groups[2], 'canary'));
      const started = Date.now();
      evidence = await service.getHeartbeatObservation();
      expect(evidence.unreadable).toBe(2);
      expect(evidence.seen).toHaveLength(1);
      expect(evidence.seen[0]!.expiresAtMs).toBeLessThanOrEqual(started + 2_000);
      await Promise.all(
        keys.map((key, index) =>
          client.set(key, heartbeat(groups[index]!, 'canary'), 'PX', 24_000),
        ),
      );
      evidence = await service.getHeartbeatObservation();
      expect(evidence.seen.map((sample) => sample.group)).toEqual([...groups]);
      expect(evidence.unreadable).toBe(0);
    } finally {
      try {
        await client.del(...keys);
      } finally {
        await Promise.all([client.quit(), service.onModuleDestroy()]);
      }
    }
  });

  it('keeps modes and their Redis TTLs from the same observation across a fleet transition', async () => {
    const { client, service } = createFleetFixture();
    const keys = groups.map(buildDefaultWebhookWorkerHeartbeatKey);
    const replaceAll = async (mode: 'off' | 'on') => {
      const write = client.multi();
      for (const group of groups) {
        write.set(
          buildDefaultWebhookWorkerHeartbeatKey(group),
          JSON.stringify({ workerGroupName: group, mode, updatedAtMs: Date.now() }),
          'PX',
          mode === 'on' ? 20_000 : 5_000,
        );
      }
      const replies = await write.exec();
      expect(replies?.every(([error, value]) => !error && value === 'OK')).toBe(true);
    };
    try {
      await replaceAll('off');
      const deadline = Date.now() + 3_000;
      while ((await service.getHeartbeatObservation()).seen.length < groups.length) {
        if (Date.now() > deadline) throw new Error('Fleet reader did not connect to fixture');
        await delay(15);
      }
      for (let index = 0; index < 32; index++) {
        const [beforeOrAfter] = await Promise.all([
          service.getHeartbeatObservation(),
          replaceAll(index % 2 === 0 ? 'on' : 'off'),
        ]);
        expect(beforeOrAfter.seen.map(({ group }) => group)).toEqual([...groups]);
        expect(new Set(beforeOrAfter.seen.map(({ mode }) => mode)).size).toBe(1);
        for (const record of beforeOrAfter.seen) {
          const remaining = record.expiresAtMs - beforeOrAfter.observedAtMs;
          if (record.mode === 'on') expect(remaining).toBeGreaterThan(10_000);
          else expect(remaining).toBeLessThanOrEqual(5_000);
        }
      }
    } finally {
      try {
        await client.del(...keys);
      } finally {
        await Promise.all([client.quit(), service.onModuleDestroy()]);
      }
    }
  });
});
