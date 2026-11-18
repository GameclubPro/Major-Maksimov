import type Redis from 'ioredis';
import { raceWithTimeout } from '../common/promise-timeout.util';
import { ALL_WEBHOOK_QUEUE_NAMES } from '../webhook/webhook-queues';
import {
  AUXILIARY_QUEUE_NAMES,
  RETENTION_PRIORITY_ADDITIONAL_QUEUE_NAMES,
} from '../runtime/runtime-queue-inventory';
import { GLOBAL_SPAMMER_DENORM_QUEUE } from '../moderation/global-spammer-denorm.queue';
import { MAX_ACTION_ALL_QUEUE_NAMES } from './max-action.queue';

export const RETENTION_PRIORITY_VERSION = '1';
export const RETENTION_PRIORITY_PERMIT_KEY = 'maxapi:retention-priority:permit:v1';
export const RETENTION_PRIORITY_STATUS_KEY = 'maxapi:retention-priority:status:v1';
export const RETENTION_PRIORITY_TRAFFIC_KEY_PREFIX = 'maxapi:retention-priority:traffic:v1';
export const RETENTION_PRIORITY_TRAFFIC_TTL_SEC = 5 * 60;
export const HIGHER_PRIORITY_ACTIVITY_KEY = 'maxapi:retention-priority:activity:v1';
export const HIGHER_PRIORITY_ACTIVITY_UNAVAILABLE_KEY =
  'maxapi:retention-priority:activity-unavailable:v1';
export const HIGHER_PRIORITY_ACTIVITY_LEASE_MS = 30_000;
export const HIGHER_PRIORITY_ACTIVITY_RENEW_MS = 5_000;
export const HIGHER_PRIORITY_ACTIVITY_LIMIT = 4_096;
export const HIGHER_PRIORITY_ACTIVITY_RELEASE_RECEIPT_TTL_MS = 60_000;
export const HIGHER_PRIORITY_ACTIVITY_RELEASE_RECEIPT_LIMIT = 8_192;
const HIGHER_PRIORITY_ACTIVITY_SETTLEMENT_TIMEOUT_MS = 200;
const ACTIVITY_RELEASE_RECEIPT_PREFIX = 'maxapi:retention-priority:activity-released:v1';

export function activityReleaseReceiptKey(id: string): string {
  const kind = id.startsWith('receipt:') ? 'sql' : 'http';
  return `${ACTIVITY_RELEASE_RECEIPT_PREFIX}:${kind}`;
}
export const RETENTION_PRIORITY_RESERVATION_MARKER = 'retention-priority:v1:';

export const RETENTION_PRIORITY_QUEUE_NAMES = Object.freeze([
  ...new Set<string>([
    ...ALL_WEBHOOK_QUEUE_NAMES,
    ...MAX_ACTION_ALL_QUEUE_NAMES,
    GLOBAL_SPAMMER_DENORM_QUEUE,
    ...AUXILIARY_QUEUE_NAMES.filter((name) => name !== 'message-retention'),
    ...RETENTION_PRIORITY_ADDITIONAL_QUEUE_NAMES,
  ]),
]);

export type RetentionPriorityQueueDescriptor = {
  name: string;
  wait: string;
  active: string;
  paused: string;
  prioritized: string;
  delayed: string;
};

// FLAG: RuntimeCoreModule uses the inherited BullMQ default prefix. Both the sampler
// and atomic MAX admission use this fixed inventory; test prefixes isolate real Redis.
export function buildRetentionPriorityQueueDescriptors(
  prefix = 'bull',
): RetentionPriorityQueueDescriptor[] {
  if (!prefix || prefix.includes('\0')) throw new Error('Invalid BullMQ priority prefix');
  return RETENTION_PRIORITY_QUEUE_NAMES.map((name) => ({
    name,
    wait: `${prefix}:${name}:wait`,
    active: `${prefix}:${name}:active`,
    paused: `${prefix}:${name}:paused`,
    prioritized: `${prefix}:${name}:prioritized`,
    delayed: `${prefix}:${name}:delayed`,
  }));
}

export function retentionPriorityQueueKeys(
  descriptors = buildRetentionPriorityQueueDescriptors(),
): string[] {
  return descriptors.flatMap(({ wait, active, paused, prioritized, delayed }) => [
    wait,
    active,
    paused,
    prioritized,
    delayed,
  ]);
}

/** Minute epoch is seconds (divisible by 60), matching Redis TIME. */
export function retentionPriorityTrafficKey(atMs: number): string {
  return `${RETENTION_PRIORITY_TRAFFIC_KEY_PREFIX}:${Math.floor(atMs / 60_000) * 60}`;
}

export type RetentionPriorityPermit = {
  version: typeof RETENTION_PRIORITY_VERSION;
  sampleStartedAtMs: number;
  validUntilMs: number;
};

export type RetentionPriorityReservationOptions = {
  version: typeof RETENTION_PRIORITY_VERSION;
  dimensions: number;
  retention: boolean;
  operationId?: string;
};

// FLAG: These observations never authorize another module's effect. A failed writer
// leaves cleanup denied; existing higher-priority HTTP keeps its own transport guards.
export const RETENTION_PRIORITY_RECORD_TRAFFIC_SCRIPT = `
-- MAX_RETENTION_PRIORITY_TRAFFIC_V1
local field = ARGV[1]
if field ~= 'arrivals' and field ~= 'http' then return redis.error_reply('Invalid traffic field') end
local time = redis.call('TIME')
local minute = math.floor(tonumber(time[1]) / 60) * 60
local key = KEYS[1] .. ':' .. tostring(minute)
redis.call('HINCRBY', key, field, 1)
redis.call('EXPIRE', key, tonumber(ARGV[2]))
return minute
`;

export const HIGHER_PRIORITY_ACTIVITY_ACQUIRE_SCRIPT = `
-- MAX_HIGHER_PRIORITY_ACTIVITY_ACQUIRE_V1
local time = redis.call('TIME')
local nowMs = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
local count = redis.pcall('ZCARD', KEYS[1])
if type(count) == 'table' or count >= ${HIGHER_PRIORITY_ACTIVITY_LIMIT} then
  redis.call('SET', KEYS[2], 'activity_coverage_unavailable', 'NX')
  return 0
end
redis.call('ZADD', KEYS[1], nowMs + tonumber(ARGV[2]), ARGV[1])
return 1
`;

const ACTIVITY_RELEASE_RECEIPT_LUA = `
local time = redis.call('TIME')
local nowMs = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
local activityKey, unavailableKey, receiptKey = KEYS[1], KEYS[2], KEYS[3]
local id = ARGV[1]
local receiptTtlMs = ${HIGHER_PRIORITY_ACTIVITY_RELEASE_RECEIPT_TTL_MS}
local function validSet(key)
  local kind = redis.call('TYPE', key).ok
  return kind == 'none' or kind == 'zset'
end
local function validReceiptSet()
  local kind = redis.call('TYPE', receiptKey).ok
  if kind == 'none' then return true end
  if kind ~= 'zset' then return false end
  local ttl = redis.call('PTTL', receiptKey)
  return ttl >= 0 and ttl <= receiptTtlMs
end
local function freshReceipt(score)
  return score and tonumber(score) > nowMs and tonumber(score) <= nowMs + receiptTtlMs
end
local function unavailable(reason)
  redis.call('SET', unavailableKey, reason, 'NX')
  return 0
end
`;

export const HIGHER_PRIORITY_ACTIVITY_RENEW_SCRIPT = `
-- MAX_HIGHER_PRIORITY_ACTIVITY_RENEW_V2
${ACTIVITY_RELEASE_RECEIPT_LUA}
if not validSet(activityKey) or not validReceiptSet() then
  return unavailable('activity_coverage_lost')
end
local active = redis.call('ZSCORE', activityKey, id)
local receipt = redis.call('ZSCORE', receiptKey, id)
if not active and freshReceipt(receipt) then return 1 end
if receipt or not active or tonumber(active) <= nowMs then
  return unavailable('activity_coverage_lost')
end
redis.call('ZADD', activityKey, 'XX', nowMs + tonumber(ARGV[2]), id)
return 1
`;

// FLAG: Write the exact completion proof before removing its active marker. A
// missing member, or a receipt coexisting with an active member, is not proof.
export const HIGHER_PRIORITY_ACTIVITY_RELEASE_SCRIPT = `
-- MAX_HIGHER_PRIORITY_ACTIVITY_RELEASE_V2
${ACTIVITY_RELEASE_RECEIPT_LUA}
if not validSet(activityKey) or not validReceiptSet() then
  return unavailable('activity_release_unknown')
end
local active = redis.call('ZSCORE', activityKey, id)
local receipt = redis.call('ZSCORE', receiptKey, id)
if not active and freshReceipt(receipt) then return 1 end
if not active or receipt then return unavailable('activity_release_unknown') end
local count = redis.call('ZCARD', receiptKey)
local limit = ${HIGHER_PRIORITY_ACTIVITY_RELEASE_RECEIPT_LIMIT}
if count > limit then return unavailable('activity_release_unknown') end
if count == limit then
  local oldest = redis.call('ZRANGE', receiptKey, 0, 0)[1]
  if redis.call('ZSCORE', activityKey, oldest) then
    return unavailable('activity_release_unknown')
  end
  redis.call('ZREM', receiptKey, oldest)
end
redis.call('ZADD', receiptKey, nowMs + receiptTtlMs, id)
redis.call('PEXPIRE', receiptKey, receiptTtlMs)
redis.call('ZREM', activityKey, id)
return 1
`;

function boundPriorityActivityObservation<T>(operation: Promise<T>): Promise<T> {
  return raceWithTimeout({
    operation,
    timeoutMs: HIGHER_PRIORITY_ACTIVITY_SETTLEMENT_TIMEOUT_MS,
    onTimeout: () => {
      throw new Error('Redis priority activity observation timed out');
    },
  });
}

export async function settleHigherPriorityActivity(
  redis: Pick<Redis, 'eval' | 'set'>,
  id: string,
): Promise<void> {
  // FLAG: Only this observation may be retried after a lost reply. SQL, HTTP
  // and quota reservation have already run under their own result contracts.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const result: unknown = await boundPriorityActivityObservation(
        redis.eval(
          HIGHER_PRIORITY_ACTIVITY_RELEASE_SCRIPT,
          3,
          HIGHER_PRIORITY_ACTIVITY_KEY,
          HIGHER_PRIORITY_ACTIVITY_UNAVAILABLE_KEY,
          activityReleaseReceiptKey(id),
          id,
        ),
      );
      if (result === 0 || result === 1) return;
      break;
    } catch {
      // The Redis command may already have executed. Reuse the exact ID.
    }
  }
  try {
    await boundPriorityActivityObservation(
      redis.set(HIGHER_PRIORITY_ACTIVITY_UNAVAILABLE_KEY, 'activity_release_failed', 'NX'),
    );
  } catch {
    // The active lease and Redis dependency checks still deny cleanup while unavailable.
  }
}

// FLAG: Run before every limiter write. Stale leases remain evidence of an unknown
// observation, never an empty fleet. Missing queue data is valid only under a fresh
// complete sampler permit; malformed structures deny cleanup without consuming slots.
export const RETENTION_PRIORITY_ADMISSION_LUA = `
local function retentionPriorityAdmission(keys, base, nowMs)
  local permitKey = keys[base + 1]
  local activityKey = keys[base + 2]
  local unavailableKey = keys[base + 3]
  if redis.call('EXISTS', unavailableKey) ~= 0 then return 'metrics_unavailable' end
  local activityType = redis.call('TYPE', activityKey).ok
  if activityType ~= 'none' and activityType ~= 'zset' then return 'metrics_unavailable' end
  if activityType == 'zset' and redis.call('ZCARD', activityKey) > 0 then
    local oldest = redis.call('ZRANGE', activityKey, 0, 0, 'WITHSCORES')
    if tonumber(oldest[2]) <= nowMs then return 'metrics_unavailable' end
    return 'higher_priority_active'
  end
  if redis.call('TYPE', permitKey).ok ~= 'hash' then return 'permit_missing' end
  local permit = redis.call('HMGET', permitKey, 'version', 'sampleStartedAtMs', 'validUntilMs')
  local sampled = tonumber(permit[2])
  local validUntil = tonumber(permit[3])
  local ttl = redis.call('PTTL', permitKey)
  if permit[1] ~= '${RETENTION_PRIORITY_VERSION}' or not sampled or not validUntil or
      sampled ~= math.floor(sampled) or validUntil ~= math.floor(validUntil) or
      sampled > nowMs or nowMs - sampled > 2000 or validUntil <= nowMs or
      validUntil - nowMs > 1000 or ttl <= 0 or ttl > 1000 then return 'permit_expired' end
  for index = base + 4, #keys, 5 do
    for offset = 0, 2 do
      local key = keys[index + offset]
      local kind = redis.call('TYPE', key).ok
      if kind ~= 'none' and kind ~= 'list' then return 'metrics_unavailable' end
      if kind == 'list' and redis.call('LLEN', key) > 0 then
        if offset == 1 then return 'higher_priority_active' end
        return 'higher_priority_ready'
      end
    end
    for offset = 3, 4 do
      local key = keys[index + offset]
      local kind = redis.call('TYPE', key).ok
      if kind ~= 'none' and kind ~= 'zset' then return 'metrics_unavailable' end
      if kind == 'zset' then
        if offset == 3 and redis.call('ZCARD', key) > 0 then return 'higher_priority_ready' end
        if offset == 4 and #redis.call('ZRANGEBYSCORE', key, '-inf',
            (nowMs + 1) * 4096 - 1, 'LIMIT', 0, 1) > 0 then return 'higher_priority_ready' end
      end
    end
  end
  return nil
end
`;
