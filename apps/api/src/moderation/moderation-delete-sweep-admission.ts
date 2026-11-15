import { randomUUID } from 'node:crypto';
import type { IRedisClient, Queue } from 'bullmq';
import type { ModerationDeleteIntentJob } from './moderation-delete-intent.queue';

export const DELETE_SWEEP_HISTORICAL_WINDOW = 1000;
const RESERVATION_TTL_MS = 60_000;
const registered = new WeakSet<IRedisClient>();
const RESERVE_COMMAND = 'maximDeleteSweepReserveV1';
const RELEASE_COMMAND = 'maximDeleteSweepReleaseV1';

// FLAG: Reserve missing historical wakeups across reconcilers. Counts are O(1),
// independent of retained history. Existing repair and fresh producers bypass this
// admission; it is a historical target, not a hard cap on all queue traffic.
const RESERVE = `-- delete-sweep-admission-v1
local nowParts = redis.call('TIME')
local now = nowParts[1] * 1000 + math.floor(nowParts[2] / 1000)
redis.call('ZREMRANGEBYSCORE', KEYS[6], '-inf', now)
local occupied = redis.call('LLEN', KEYS[1]) + redis.call('LLEN', KEYS[2])
  + redis.call('LLEN', KEYS[3]) + redis.call('ZCARD', KEYS[4])
  + redis.call('ZCARD', KEYS[5]) + redis.call('ZCARD', KEYS[6])
local count = math.max(0, math.min(tonumber(ARGV[2]), tonumber(ARGV[1]) - occupied))
for i = 0, count - 1 do
  redis.call('ZADD', KEYS[6], now + tonumber(ARGV[4]), ARGV[3] .. ':' .. i)
end
if count > 0 then redis.call('PEXPIRE', KEYS[6], ARGV[4]) end
return count`;

export async function reserveDeleteSweepAdmission(
  queue: Queue<ModerationDeleteIntentJob>,
  requested: number,
  window: number,
): Promise<{ count: number; release: (indexes: number[]) => Promise<void> }> {
  if (
    !Number.isInteger(window) ||
    window < 1 ||
    window > DELETE_SWEEP_HISTORICAL_WINDOW ||
    !Number.isInteger(requested) ||
    requested < 1 ||
    requested > 100
  )
    throw new Error('Invalid bounded DELETE sweep admission');
  const client = await queue.client;
  const key = queue.toKey('historical-admission-v1');
  const token = randomUUID();
  if (!registered.has(client)) {
    client.defineCommand(RESERVE_COMMAND, { numberOfKeys: 6, lua: RESERVE });
    client.defineCommand(RELEASE_COMMAND, {
      numberOfKeys: 1,
      lua: "return redis.call('ZREM', KEYS[1], unpack(ARGV))",
    });
    registered.add(client);
  }
  const count: unknown = await client.runCommand(RESERVE_COMMAND, [
    ...['wait', 'paused', 'active', 'prioritized', 'delayed'].map((name) => queue.toKey(name)),
    key,
    window,
    requested,
    token,
    RESERVATION_TTL_MS,
  ]);
  if (typeof count !== 'number' || !Number.isInteger(count) || count < 0 || count > requested)
    throw new Error('Invalid DELETE sweep admission response');
  return {
    count,
    async release(indexes) {
      if (indexes.length)
        await client.runCommand(RELEASE_COMMAND, [
          key,
          ...indexes.map((index) => `${token}:${index}`),
        ]);
    },
  };
}
