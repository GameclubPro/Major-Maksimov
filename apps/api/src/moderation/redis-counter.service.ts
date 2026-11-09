import {
  MESSAGE_DUPLICATE_WINDOW_SCRIPT,
  type DuplicateWindowResult,
} from './message-duplicate/message-duplicate-window.script';
import { digestDuplicateContent } from './message-duplicate/message-duplicate-content';
import {
  DUPLICATE_RECOMPRESSION_INDEX_SCRIPT,
  type DuplicateRecompressionIndexInput,
} from './message-duplicate/message-duplicate-recompression-index';
import {
  DUPLICATE_HEAVY_ADMISSION_SCRIPT,
  MESSAGE_DUPLICATE_HEAVY_ADMISSION_KEY,
  parseDuplicateHeavyAdmission,
  validateDuplicateHeavyAdmission,
  type DuplicateHeavyAdmissionResult,
} from './message-duplicate/message-duplicate-heavy-admission';
import {
  DUPLICATE_TELEMETRY_FIELDS,
  DUPLICATE_TELEMETRY_TTL_SECONDS,
  MERGE_DUPLICATE_TELEMETRY_SCRIPT,
  type DuplicateTelemetryCounters,
} from './message-duplicate/message-duplicate-telemetry';
import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { randomUUID } from 'node:crypto';
import {
  COMMERCIAL_CAMPAIGN_SLIDING_WINDOW_SCRIPT,
  COMMERCIAL_SLIDING_CAMPAIGN_MAX_FUTURE_SKEW_MS,
  COMMERCIAL_SLIDING_CAMPAIGN_MAX_MEMBERS,
  fingerprintCommercialCampaignSlidingMember,
} from './commercial/commercial-campaign-sliding';
import {
  DUPLICATE_EVENT_MAX_FUTURE_SKEW_MS,
  resolveDuplicateHistoryRetentionSeconds,
} from './duplicate-state';
import {
  claimMessageCountQuota,
  type MessageCountQuotaInput,
  type MessageCountQuotaResult,
} from './message-count-quota';

const preDispatchUnavailableErrors = new WeakSet<Error>();

export function isRedisCounterPreDispatchUnavailable(error: unknown): error is Error {
  return error instanceof Error && preDispatchUnavailableErrors.has(error);
}

// FLAG: Cooldowns use event time, not delivery time. Rejected attempts never move the anchor,
// and retries must recover their original decision before inspecting a newer anchor.
const CLAIM_EVENT_COOLDOWN_SCRIPT = `
local time = redis.call('TIME')
local now_ms = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
if now_ms >= tonumber(ARGV[4]) then return -1 end
local occurred_at = tonumber(ARGV[1])
local window_ms = tonumber(ARGV[2])
if now_ms - occurred_at >= window_ms or occurred_at - now_ms > tonumber(ARGV[5]) then
  return 0
end
local replay = redis.call('GET', KEYS[2])
if replay then
  local saved = cjson.decode(replay)
  if math.abs(saved.timestamp - occurred_at) > tonumber(ARGV[6]) then return 0 end
  return saved.result
end
local anchor = redis.call('GET', KEYS[1])
local result = 1
if anchor then
  local previous = tonumber(anchor)
  if not previous then return redis.error_reply('Invalid cooldown anchor') end
  if occurred_at < previous then return 0 end
  if occurred_at - previous < window_ms then result = 2 end
end
if result == 1 then
  redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[3])
end
redis.call('SET', KEYS[2], cjson.encode({timestamp = occurred_at, result = result}), 'EX', ARGV[3])
return result
`;

const INCREMENT_WITH_TTL_SCRIPT = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then
  redis.call('EXPIRE', KEYS[1], ARGV[1])
end
return count
`;

const INCREMENT_ONCE_PER_MEMBER_WITH_TTL_SCRIPT = `
local added = redis.call('SET', KEYS[2], '1', 'EX', ARGV[1], 'NX')
local count = tonumber(redis.call('GET', KEYS[1]) or '0')
if not added then
  return {0, count}
end
count = redis.call('INCR', KEYS[1])
local ttl = redis.call('TTL', KEYS[1])
if ttl < 0 then
  redis.call('EXPIRE', KEYS[1], ARGV[1])
end
return {1, count}
`;

// FLAG: The deadline check must remain before INCR/SET. Callers may stop awaiting at the same
// deadline, so a late script must be read-only and a completed write must remain replayable.
const REPLAYABLE_INCREMENT_BEFORE_DEADLINE_SCRIPT = `
local replayed_count = redis.call('GET', KEYS[2])
if replayed_count then
  return {2, tonumber(replayed_count) or -1}
end

local redis_time = redis.call('TIME')
local now_ms = (tonumber(redis_time[1]) * 1000) + math.floor(tonumber(redis_time[2]) / 1000)
if now_ms >= tonumber(ARGV[2]) then
  return {0, 0}
end

local count = redis.call('INCR', KEYS[1])
local full_ttl_ms = tonumber(ARGV[1]) * 1000
local counter_pttl = redis.call('PTTL', KEYS[1])
if counter_pttl < 0 then
  redis.call('PEXPIRE', KEYS[1], full_ttl_ms)
end
redis.call('SET', KEYS[2], tostring(count), 'PX', full_ttl_ms)
return {1, count}
`;

const REVISIONED_MEMBERSHIP_STATE_MISSING = '__maxim_revisioned_membership_missing__';
const REVISIONED_MEMBERSHIP_MAX_CAS_ATTEMPTS = 4;

// FLAG: Keep compare/deadline checks before mutations. Physical pruning uses Redis time and the
// extended retention TTL. Logical counts include only the current event and its chronological
// predecessors, so a later event can never make an out-of-order original actionable.
const REPLACE_REVISIONED_SET_MEMBERSHIPS_BEFORE_DEADLINE_SCRIPT = `
local current_state = redis.call('GET', KEYS[1])
if ARGV[1] == '${REVISIONED_MEMBERSHIP_STATE_MISSING}' then
  if current_state then
    return {2}
  end
elseif current_state ~= ARGV[1] then
  return {2}
end

local redis_time = redis.call('TIME')
local now_ms = (tonumber(redis_time[1]) * 1000) + math.floor(tonumber(redis_time[2]) / 1000)
if now_ms >= tonumber(ARGV[5]) then
  return {0}
end

local window_ms = tonumber(ARGV[3]) * 1000
local full_ttl_ms = tonumber(ARGV[4]) * 1000
local count_limit = tonumber(ARGV[#ARGV])
local member_timestamp_ms = tonumber(ARGV[2])
local baseline_policy = nil
if #ARGV == #KEYS + 8 then
  member_timestamp_ms = tonumber(ARGV[#ARGV - 2])
  baseline_policy = cjson.decode(ARGV[#ARGV - 1])
elseif #ARGV == #KEYS + 7 then
  member_timestamp_ms = tonumber(ARGV[#ARGV - 1])
end
local cutoff_ms = member_timestamp_ms - window_ms
local retention_cutoff_ms = now_ms - full_ttl_ms
local logical_lower_bound = '(' .. tostring(cutoff_ms)
local response = {1}
local stored_memberships = {}
for key_index = 2, #KEYS do
  local desired = ARGV[5 + key_index]
  redis.call('ZREMRANGEBYSCORE', KEYS[key_index], '-inf', retention_cutoff_ms)
  if desired == '1' then
    redis.call('ZADD', KEYS[key_index], member_timestamp_ms, ARGV[6])
    redis.call('PEXPIRE', KEYS[key_index], full_ttl_ms)
  else
    redis.call('ZREM', KEYS[key_index], ARGV[6])
  end
end
for key_index = 2, #KEYS do
  if ARGV[5 + key_index] == '1' then
    local membership_count = redis.call(
      'ZCOUNT',
      KEYS[key_index],
      logical_lower_bound,
      member_timestamp_ms
    )
    -- FLAG: Shared matching never inherits another author's escalation. The first chronological
    -- image is the shared baseline; each other author starts their own repeat ladder at one.
    if baseline_policy and key_index == baseline_policy[2] then
      local first = redis.call('ZRANGEBYSCORE', KEYS[baseline_policy[1]], logical_lower_bound, member_timestamp_ms, 'WITHSCORES', 'LIMIT', 0, 1)
      if first[2] and redis.call('ZCOUNT', KEYS[key_index], first[2], first[2]) == 0 then
        membership_count = membership_count + 1
      end
    end
    membership_count = math.min(membership_count, count_limit)
    table.insert(stored_memberships, {key = KEYS[key_index], count = membership_count})
    table.insert(response, membership_count)
  end
end

local next_state = cjson.encode({
  v = 1,
  revision = tonumber(ARGV[2]),
  scoreTimestampMs = member_timestamp_ms,
  memberships = stored_memberships
})
redis.call('SET', KEYS[1], next_state, 'PX', full_ttl_ms)
return response
`;

const VERIFY_REVISIONED_MEMBERSHIP_STATE_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return 1
end
return 2
`;

const READ_REVISIONED_MEMBERSHIP_COUNT_SCRIPT = `
local raw = redis.call('GET', KEYS[1])
if not raw then return {0, 0} end
local ok, state = pcall(cjson.decode, raw)
if not ok or state.v ~= 1 then return {-1, 0} end
if tonumber(state.revision) ~= tonumber(ARGV[1]) then return {0, 0} end
if tonumber(state.scoreTimestampMs) ~= tonumber(ARGV[3]) then return {0, 0} end
if type(state.memberships) ~= 'table' then return {-1, 0} end
local member_of_set = false
local shared_member_of_set = #KEYS == 2
for _, entry in pairs(state.memberships) do
  if type(entry) == 'table' and entry.key == KEYS[2] then member_of_set = true end
  if #KEYS == 3 and type(entry) == 'table' and entry.key == KEYS[3] then shared_member_of_set = true end
end
if not member_of_set or not shared_member_of_set then return {0, 0} end
local score = redis.call('ZSCORE', KEYS[2], ARGV[2])
if not score or tonumber(score) ~= tonumber(ARGV[3]) then return {0, 0} end
-- FLAG: Revalidate the same event-time window used at detection. Dispatch authority has its
-- own absolute deadline; queue delay must not move the comparison past a valid predecessor.
local cutoff = tonumber(ARGV[3]) - tonumber(ARGV[4]) * 1000
local lower = '(' .. tostring(cutoff)
local count = redis.call('ZCOUNT', KEYS[2], lower, ARGV[3])
if #KEYS == 3 then
  local shared_score = redis.call('ZSCORE', KEYS[3], ARGV[2])
  if not shared_score or tonumber(shared_score) ~= tonumber(ARGV[3]) or redis.call('ZCOUNT', KEYS[3], lower, ARGV[3]) < 2 then return {0, 0} end
  local first = redis.call('ZRANGEBYSCORE', KEYS[3], lower, ARGV[3], 'WITHSCORES', 'LIMIT', 0, 1)
  if first[2] and redis.call('ZCOUNT', KEYS[2], first[2], first[2]) == 0 then count = count + 1 end
end
return {1, math.min(tonumber(ARGV[5]), count)}
`;

const COMPARE_REVISIONED_CONTROL_SCRIPT = `
local revision = tonumber(redis.call('GET', KEYS[2]) or '0')
if not revision or revision < 0 or revision % 1 ~= 0 or revision >= 9007199254740991 then return {-1, 0} end
if revision ~= tonumber(ARGV[1]) then return {0, revision} end
local time = redis.call('TIME')
local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
local ok, value = pcall(cjson.decode, ARGV[2])
if not ok or type(value) ~= 'table' or (value.version ~= 1 and value.version ~= 2) or value.revision ~= revision + 1 then return {-1, revision} end
if ARGV[3] == 'permanent' then
  if value.version ~= 2 or value.expiresAt ~= cjson.null then return {-1, revision} end
  redis.call('SET', KEYS[1], ARGV[2])
else
  local ttl = tonumber(ARGV[3]) - now
  if ttl <= 0 or ttl > 86400000 then return {-1, revision} end
  redis.call('SET', KEYS[1], ARGV[2], 'PX', ttl)
end
redis.call('SET', KEYS[2], tostring(revision + 1))
return {1, revision + 1}
`;

const INCREMENT_BY_WITH_TTL_SCRIPT = `
local count = redis.call('INCRBY', KEYS[1], ARGV[1])
local ttl = redis.call('TTL', KEYS[1])
if ttl < 0 then
  redis.call('EXPIRE', KEYS[1], ARGV[2])
end
return count
`;

const ADD_TO_SET_WITH_TTL_SCRIPT = `
local added = redis.call('SADD', KEYS[1], ARGV[1])
local ttl = redis.call('TTL', KEYS[1])
if ttl < 0 then
  redis.call('EXPIRE', KEYS[1], ARGV[2])
end
local size = redis.call('SCARD', KEYS[1])
return {added, size}
`;

const RENEW_LOCK_SCRIPT = `
if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('pexpire', KEYS[1], ARGV[2])
end
return 0
`;

// FLAG: Keep the Redis TIME deadline check before SET. A caller may stop awaiting this command at
// the same deadline, so a command that reaches Redis late must never create an orphaned lock.
const ACQUIRE_LOCK_BEFORE_DEADLINE_SCRIPT = `
local redis_time = redis.call('TIME')
local now_ms = (tonumber(redis_time[1]) * 1000) + math.floor(tonumber(redis_time[2]) / 1000)
if now_ms >= tonumber(ARGV[3]) then
  return 0
end

local acquired = redis.call('SET', KEYS[1], ARGV[1], 'PX', ARGV[2], 'NX')
if acquired then
  return 1
end
return 2
`;

export type ReplayableDeadlineIncrementResult =
  | { kind: 'deadline_exceeded' }
  | { kind: 'inserted' | 'replayed'; count: number };

export type RevisionedSetMembershipResult =
  | { kind: 'deadline_exceeded' }
  | { kind: 'stale' }
  | { kind: 'applied' | 'replayed'; counts: number[] };

type StoredRevisionedSetMembershipState = {
  revision: number;
  scoreTimestampMs?: number;
  memberships: Map<string, number>;
};

export type DeadlineLockAcquireResult =
  | { kind: 'acquired' }
  | { kind: 'busy' }
  | { kind: 'deadline_exceeded' };

export const DUPLICATE_WINDOW_MAX_OUTSTANDING = 128;

export class DuplicateWindowCapacityError extends Error {
  readonly code = 'DUPLICATE_WINDOW_CAPACITY_EXCEEDED';

  constructor() {
    super('Message duplicate window capacity exceeded before Redis dispatch');
    this.name = 'DuplicateWindowCapacityError';
  }
}

@Injectable()
export class RedisCounterService implements OnModuleDestroy {
  private readonly redis: Redis;
  private duplicateWindowOutstanding = 0;

  constructor(private readonly configService: ConfigService) {
    this.redis = new Redis(this.configService.getOrThrow<string>('REDIS_URL'));
  }

  async onModuleDestroy() {
    await this.redis.quit();
  }

  async duplicateWindow(
    chatId: string,
    input: Record<string, unknown>,
  ): Promise<DuplicateWindowResult> {
    if (this.duplicateWindowOutstanding >= DUPLICATE_WINDOW_MAX_OUTSTANDING)
      throw new DuplicateWindowCapacityError();
    this.duplicateWindowOutstanding += 1;
    let raw: unknown;
    try {
      // FLAG: A caller's timeout does not settle the Redis operation or release its slot.
      raw = await this.redis.eval(
        MESSAGE_DUPLICATE_WINDOW_SCRIPT,
        1,
        `dup:window:v1:${digestDuplicateContent(chatId)}:`,
        JSON.stringify({ ...input, deadline: Date.now() + 250 }),
      );
    } finally {
      this.duplicateWindowOutstanding -= 1;
    }
    const result = JSON.parse(String(raw)) as DuplicateWindowResult;
    if (result.kind === 'deadline_exceeded')
      throw new Error('Message duplicate window deadline exceeded');
    return result;
  }

  async resetDuplicateWindow(chatId: string, userId: string): Promise<void> {
    await this.duplicateWindow(chatId, { op: 'reset', author: digestDuplicateContent(userId) });
  }

  async duplicateRecompressionIndex(
    keys: readonly string[],
    input: DuplicateRecompressionIndexInput,
  ): Promise<string> {
    const scope = /^dup:recompression:v1:([a-f0-9]{64}):0:[a-f0-9]{2}$/u.exec(keys[0] ?? '')?.[1];
    if (
      !scope ||
      keys.length !== 8 ||
      keys.some(
        (key, band) =>
          !new RegExp(`^dup:recompression:v1:${scope}:${band}:[a-f0-9]{2}$`, 'u').test(key),
      )
    )
      throw new Error('Invalid duplicate recompression index keys');
    return String(
      await this.redis.eval(
        DUPLICATE_RECOMPRESSION_INDEX_SCRIPT,
        keys.length,
        ...keys,
        JSON.stringify(input),
        Date.now() + 250,
      ),
    );
  }

  async mergeDuplicateTelemetry(
    key: string,
    counters: DuplicateTelemetryCounters,
  ): Promise<boolean> {
    const merged = await this.redis.eval(
      MERGE_DUPLICATE_TELEMETRY_SCRIPT,
      1,
      key,
      JSON.stringify(counters),
      DUPLICATE_TELEMETRY_TTL_SECONDS,
      Date.now() + 250,
      JSON.stringify(DUPLICATE_TELEMETRY_FIELDS),
    );
    return Number(merged) === 1;
  }

  async publishChatRouteEpoch(params: {
    chatId: string;
    routingVersion: number;
    botId: string | null;
    checkedAt?: Date | null;
    source?: string | null;
  }): Promise<void> {
    const payload = JSON.stringify({
      chatId: params.chatId,
      routingVersion: params.routingVersion,
      botId: params.botId,
      checkedAt: params.checkedAt?.toISOString() ?? null,
      source: params.source ?? null,
    });
    // FLAG: SQL authorizes mutations. Redis publication only invalidates role-local routing caches.
    await this.redis.eval(
      `
      local version = tonumber(redis.call('GET', KEYS[1]) or '-1')
      local incoming = tonumber(ARGV[1])
      if incoming < version then return 0 end
      redis.call('SET', KEYS[1], ARGV[1], 'EX', 86400)
      redis.call('PUBLISH', ARGV[2], ARGV[3])
      return 1
    `,
      1,
      `maxim:route-version:${digestDuplicateContent(params.chatId)}`,
      params.routingVersion,
      'chat:context:invalidate:v1',
      payload,
    );
  }

  async incrementWithTtl(key: string, ttlSeconds: number): Promise<number> {
    return Number(
      await this.redis.eval(INCREMENT_WITH_TTL_SCRIPT, 1, key, String(Math.trunc(ttlSeconds))),
    );
  }

  async claimMessageCountQuota(input: MessageCountQuotaInput): Promise<MessageCountQuotaResult> {
    if (input.requireReadyBeforeDispatch) this.requireReadyBeforeCounterDispatch(false);
    return claimMessageCountQuota(this.redis, input);
  }

  async claimEventCooldown(params: {
    key: string;
    memberKey: string;
    eventTimestampMs: number;
    windowSeconds: number;
    deadlineAtMs: number;
    memberTimestampToleranceMs?: number;
    requireReadyBeforeDispatch?: boolean;
  }): Promise<'allowed' | 'blocked' | 'stale' | 'deadline_exceeded'> {
    if (
      !params.key.trim() ||
      !params.memberKey.trim() ||
      params.key === params.memberKey ||
      ![params.eventTimestampMs, params.windowSeconds, params.deadlineAtMs].every(
        (value) => Number.isSafeInteger(value) && value > 0,
      ) ||
      params.windowSeconds > 86_400 ||
      !Number.isSafeInteger(params.memberTimestampToleranceMs ?? 0) ||
      (params.memberTimestampToleranceMs ?? 0) < 0 ||
      (params.memberTimestampToleranceMs ?? 0) > 2_000
    ) {
      throw new Error('Invalid event cooldown input');
    }
    if (params.requireReadyBeforeDispatch) this.requireReadyBeforeCounterDispatch(false);
    const result = Number(
      await this.redis.eval(
        CLAIM_EVENT_COOLDOWN_SCRIPT,
        2,
        params.key,
        params.memberKey,
        String(params.eventTimestampMs),
        String(params.windowSeconds * 1000),
        String(resolveDuplicateHistoryRetentionSeconds(params.windowSeconds)),
        String(params.deadlineAtMs),
        String(DUPLICATE_EVENT_MAX_FUTURE_SKEW_MS),
        String(params.memberTimestampToleranceMs ?? 0),
      ),
    );
    if (result === -1) return 'deadline_exceeded';
    if (result === 0) return 'stale';
    if (result === 1) return 'allowed';
    if (result === 2) return 'blocked';
    throw new Error('Redis returned an invalid event cooldown result');
  }

  async incrementOncePerMemberWithTtl(
    counterKey: string,
    memberKey: string,
    ttlSeconds: number,
  ): Promise<{ inserted: boolean; count: number }> {
    const result = (await this.redis.eval(
      INCREMENT_ONCE_PER_MEMBER_WITH_TTL_SCRIPT,
      2,
      counterKey,
      memberKey,
      String(Math.trunc(ttlSeconds)),
    )) as [number | string, number | string];
    return {
      inserted: Number(result?.[0] ?? 0) > 0,
      count: Number(result?.[1] ?? 0),
    };
  }

  async incrementOncePerMemberWithTtlBeforeDeadline(
    counterKey: string,
    memberKey: string,
    ttlSeconds: number,
    deadlineAtMs: number,
  ): Promise<ReplayableDeadlineIncrementResult> {
    const normalizedTtlSeconds = Math.trunc(ttlSeconds);
    const normalizedDeadlineAtMs = Math.trunc(deadlineAtMs);
    if (
      !Number.isFinite(normalizedTtlSeconds) ||
      normalizedTtlSeconds <= 0 ||
      !Number.isFinite(normalizedDeadlineAtMs) ||
      normalizedDeadlineAtMs <= 0
    ) {
      throw new Error('Replayable counter TTL and deadline must be valid positive values');
    }

    const result = (await this.redis.eval(
      REPLAYABLE_INCREMENT_BEFORE_DEADLINE_SCRIPT,
      2,
      counterKey,
      memberKey,
      String(normalizedTtlSeconds),
      String(normalizedDeadlineAtMs),
    )) as [number | string, number | string];
    const status = Number(result?.[0]);
    const count = Number(result?.[1]);
    if (status === 0) {
      return { kind: 'deadline_exceeded' };
    }
    if ((status === 1 || status === 2) && Number.isSafeInteger(count) && count > 0) {
      return { kind: status === 1 ? 'inserted' : 'replayed', count };
    }
    throw new Error('Redis returned an invalid replayable counter result');
  }

  async replaceRevisionedSetMembershipsBeforeDeadline(params: {
    stateKey: string;
    member: string;
    revision: number;
    scoreTimestampMs?: number;
    membershipKeys: readonly string[];
    windowSeconds: number;
    ttlSeconds: number;
    countLimit?: number;
    deadlineAtMs: number;
    sharedBaseline?: { sharedKey: string; authorKey: string };
    requireReadyBeforeDispatch?: boolean;
  }): Promise<RevisionedSetMembershipResult> {
    const stateKey = params.stateKey.trim();
    const member = params.member.trim();
    const revision = Math.trunc(params.revision);
    const scoreTimestampMs = Math.trunc(params.scoreTimestampMs ?? revision);
    const windowSeconds = Math.trunc(params.windowSeconds);
    const ttlSeconds = Math.trunc(params.ttlSeconds);
    const countLimit = Math.trunc(params.countLimit ?? 21);
    const deadlineAtMs = Math.trunc(params.deadlineAtMs);
    const membershipKeys = params.membershipKeys.map((key) => key.trim());
    if (
      params.sharedBaseline &&
      (params.scoreTimestampMs === undefined ||
        params.sharedBaseline.sharedKey === params.sharedBaseline.authorKey ||
        !membershipKeys.includes(params.sharedBaseline.sharedKey) ||
        !membershipKeys.includes(params.sharedBaseline.authorKey))
    ) {
      throw new Error('Shared baseline requires distinct declared memberships and event time');
    }
    if (
      !stateKey ||
      !member ||
      membershipKeys.some((key) => !key) ||
      new Set(membershipKeys).size !== membershipKeys.length ||
      !Number.isSafeInteger(revision) ||
      revision <= 0 ||
      !Number.isSafeInteger(scoreTimestampMs) ||
      scoreTimestampMs <= 0 ||
      !Number.isSafeInteger(windowSeconds) ||
      windowSeconds <= 0 ||
      !Number.isSafeInteger(ttlSeconds) ||
      ttlSeconds < windowSeconds ||
      !Number.isSafeInteger(countLimit) ||
      countLimit <= 0 ||
      countLimit > 100 ||
      !Number.isSafeInteger(deadlineAtMs) ||
      deadlineAtMs <= 0
    ) {
      throw new Error('Revisioned membership state input must contain valid unique keys and times');
    }

    let mutationEvalInvoked = false;
    for (let attempt = 0; attempt < REVISIONED_MEMBERSHIP_MAX_CAS_ATTEMPTS; attempt += 1) {
      if (Date.now() >= deadlineAtMs) {
        return { kind: 'deadline_exceeded' };
      }

      if (params.requireReadyBeforeDispatch) {
        this.requireReadyBeforeCounterDispatch(mutationEvalInvoked);
      }
      const currentRaw = await this.redis.get(stateKey);
      if (Date.now() >= deadlineAtMs) {
        return { kind: 'deadline_exceeded' };
      }
      const current = currentRaw ? this.parseRevisionedSetMembershipState(currentRaw) : null;
      if (current && revision < current.revision) {
        return { kind: 'stale' };
      }
      if (current && revision === current.revision) {
        if ((current.scoreTimestampMs ?? current.revision) !== scoreTimestampMs) {
          return { kind: 'stale' };
        }
        const currentMembershipKeys = Array.from(current.memberships.keys());
        if (!this.stringSetsEqual(currentMembershipKeys, membershipKeys)) {
          return { kind: 'stale' };
        }
        const replayStatus = Number(
          await this.redis.eval(
            VERIFY_REVISIONED_MEMBERSHIP_STATE_SCRIPT,
            1,
            stateKey,
            currentRaw as string,
          ),
        );
        if (replayStatus === 2) {
          continue;
        }
        if (replayStatus === 1) {
          return {
            kind: 'replayed',
            counts: membershipKeys.map((key) => current.memberships.get(key) ?? 0),
          };
        }
        throw new Error('Redis returned an invalid revisioned membership replay result');
      }

      const desiredKeySet = new Set(membershipKeys);
      const allMembershipKeys = Array.from(
        new Set([...(current?.memberships.keys() ?? []), ...membershipKeys]),
      ).sort();
      if (params.requireReadyBeforeDispatch) {
        this.requireReadyBeforeCounterDispatch(mutationEvalInvoked);
      }
      // FLAG: Once a mutating EVAL is invoked, even a CAS miss cannot certify this
      // invocation as never dispatched. Preserve every subsequent error as unknown.
      mutationEvalInvoked = true;
      const appliedResult = (await this.redis.eval(
        REPLACE_REVISIONED_SET_MEMBERSHIPS_BEFORE_DEADLINE_SCRIPT,
        1 + allMembershipKeys.length,
        stateKey,
        ...allMembershipKeys,
        currentRaw ?? REVISIONED_MEMBERSHIP_STATE_MISSING,
        String(revision),
        String(windowSeconds),
        String(ttlSeconds),
        String(deadlineAtMs),
        member,
        ...allMembershipKeys.map((key) => (desiredKeySet.has(key) ? '1' : '0')),
        ...(params.scoreTimestampMs === undefined ? [] : [String(scoreTimestampMs)]),
        ...(params.sharedBaseline
          ? [
              JSON.stringify([
                allMembershipKeys.indexOf(params.sharedBaseline.sharedKey) + 2,
                allMembershipKeys.indexOf(params.sharedBaseline.authorKey) + 2,
              ]),
            ]
          : []),
        String(countLimit),
      )) as Array<number | string>;
      const appliedStatus = Number(appliedResult?.[0]);
      if (appliedStatus === 0) {
        return { kind: 'deadline_exceeded' };
      }
      if (appliedStatus === 2) {
        continue;
      }
      if (appliedStatus === 1) {
        const sortedDesiredKeys = allMembershipKeys.filter((key) => desiredKeySet.has(key));
        const sortedCounts = this.parseRevisionedMembershipCounts(
          appliedResult.slice(1),
          sortedDesiredKeys.length,
        );
        const countByKey = new Map(
          sortedDesiredKeys.map((key, index) => [key, sortedCounts[index] ?? 0]),
        );
        return {
          kind: 'applied',
          counts: membershipKeys.map((key) => countByKey.get(key) ?? 0),
        };
      }
      throw new Error('Redis returned an invalid revisioned membership mutation result');
    }

    throw new Error('Redis revisioned membership state changed too frequently');
  }

  private requireReadyBeforeCounterDispatch(mutationEvalInvoked: boolean): void {
    if (this.redis.status === 'ready') return;
    const error = new Error(
      mutationEvalInvoked
        ? 'Redis counter became unavailable after a mutation dispatch'
        : 'Redis counter is unavailable before dispatch',
    );
    // FLAG: Only this explicit admission refusal owns proof of no mutating dispatch.
    // Matching properties or an error received from Redis never establish that proof.
    if (!mutationEvalInvoked) preDispatchUnavailableErrors.add(error);
    throw error;
  }

  async incrementByWithTtl(key: string, amount: number, ttlSeconds: number): Promise<number> {
    const normalizedAmount = Number.isFinite(amount) ? Math.trunc(amount) : 0;
    if (normalizedAmount <= 0) {
      return 0;
    }

    return Number(
      await this.redis.eval(
        INCREMENT_BY_WITH_TTL_SCRIPT,
        1,
        key,
        String(normalizedAmount),
        String(Math.trunc(ttlSeconds)),
      ),
    );
  }

  async readRevisionedMembershipCount(params: {
    stateKey: string;
    membershipKey: string;
    member: string;
    revision: number;
    scoreTimestampMs: number;
    windowSeconds: number;
    sharedBaselineKey?: string;
  }): Promise<number | null> {
    if (
      ![params.revision, params.scoreTimestampMs, params.windowSeconds].every(
        (value) => Number.isSafeInteger(value) && value > 0,
      )
    ) {
      throw new Error('Invalid revisioned membership read');
    }
    const result = (await this.redis.eval(
      READ_REVISIONED_MEMBERSHIP_COUNT_SCRIPT,
      params.sharedBaselineKey ? 3 : 2,
      params.stateKey,
      params.membershipKey,
      ...(params.sharedBaselineKey ? [params.sharedBaselineKey] : []),
      String(params.revision),
      params.member,
      String(params.scoreTimestampMs),
      String(params.windowSeconds),
      '21',
    )) as Array<number | string>;
    if (Number(result[0]) === 0) return null;
    if (
      Number(result[0]) !== 1 ||
      !Number.isSafeInteger(Number(result[1])) ||
      Number(result[1]) < 0
    ) {
      throw new Error('Invalid revisioned membership result');
    }
    return Number(result[1]);
  }

  async compareAndSetRevisionedControl(params: {
    key: string;
    expectedRevision: number;
    value: string;
    expiresAtMs: number | null;
  }): Promise<{ applied: boolean; revision: number }> {
    if (
      !Number.isSafeInteger(params.expectedRevision) ||
      params.expectedRevision < 0 ||
      (params.expiresAtMs !== null && !Number.isSafeInteger(params.expiresAtMs))
    )
      throw new Error('Invalid control revision');
    const result = (await this.redis.eval(
      COMPARE_REVISIONED_CONTROL_SCRIPT,
      2,
      params.key,
      `${params.key}:revision`,
      String(params.expectedRevision),
      params.value,
      params.expiresAtMs === null ? 'permanent' : String(params.expiresAtMs),
    )) as Array<number | string>;
    if (![0, 1].includes(Number(result[0])) || !Number.isSafeInteger(Number(result[1]))) {
      throw new Error('Invalid control update');
    }
    return { applied: Number(result[0]) === 1, revision: Number(result[1]) };
  }

  async addToSetWithTtl(
    key: string,
    member: string,
    ttlSeconds: number,
  ): Promise<{ added: boolean; size: number }> {
    const result = (await this.redis.eval(
      ADD_TO_SET_WITH_TTL_SCRIPT,
      1,
      key,
      member,
      String(Math.trunc(ttlSeconds)),
    )) as [number | string, number | string];
    const addedCount = Number(result?.[0] ?? 0);
    const size = Number(result?.[1] ?? 0);
    return {
      added: addedCount > 0,
      size,
    };
  }

  async trackCommercialCampaignSlidingWindow(params: {
    key: string;
    chatId: string;
    eventTimestampMs: number;
    windowSeconds: number;
  }): Promise<{ size: number; saturated: boolean }> {
    if (
      !/^commercial-campaign:sliding:v1:sender:[a-f0-9]{64}:velocity:(?:300|1800|7200):chats$/u.test(
        params.key,
      ) ||
      !params.chatId.trim() ||
      !Number.isSafeInteger(params.eventTimestampMs) ||
      params.eventTimestampMs <= 0 ||
      ![300, 1800, 7200].includes(params.windowSeconds) ||
      !params.key.endsWith(`:velocity:${params.windowSeconds}:chats`)
    )
      throw new Error('Invalid commercial sliding window observation');
    const result = (await this.redis.eval(
      COMMERCIAL_CAMPAIGN_SLIDING_WINDOW_SCRIPT,
      1,
      params.key,
      fingerprintCommercialCampaignSlidingMember(params.chatId),
      String(params.eventTimestampMs),
      String(params.windowSeconds),
      String(COMMERCIAL_SLIDING_CAMPAIGN_MAX_MEMBERS),
      String(COMMERCIAL_SLIDING_CAMPAIGN_MAX_FUTURE_SKEW_MS),
    )) as Array<number | string>;
    const size = Number(result?.[0]);
    const saturated = Number(result?.[1]);
    if (
      !Number.isSafeInteger(size) ||
      size < 0 ||
      size > COMMERCIAL_SLIDING_CAMPAIGN_MAX_MEMBERS ||
      ![0, 1].includes(saturated)
    )
      throw new Error('Invalid commercial sliding window result');
    return { size, saturated: saturated === 1 };
  }

  async getString(key: string): Promise<string | null> {
    return this.redis.get(key);
  }

  async admitDuplicateHeavyStart(input: {
    eligibleAtMs: number;
    intervalMs: number;
    deadlineAtMs: number;
  }): Promise<DuplicateHeavyAdmissionResult> {
    validateDuplicateHeavyAdmission(input);
    return parseDuplicateHeavyAdmission(
      await this.redis.eval(
        DUPLICATE_HEAVY_ADMISSION_SCRIPT,
        1,
        MESSAGE_DUPLICATE_HEAVY_ADMISSION_KEY,
        String(input.eligibleAtMs),
        String(input.intervalMs),
        String(input.deadlineAtMs),
      ),
    );
  }

  async getStrings(keys: readonly string[]): Promise<Array<string | null>> {
    if (keys.length > 10) throw new Error('String read batch exceeds ten keys');
    if (keys.length === 0) return [];
    if (keys.length === 1) return [await this.redis.get(keys[0]!)];
    // FLAG: Pipeline GET preserves GET's WRONGTYPE failure; MGET would silently
    // turn a wrong-type proof into a cache miss. No reads extend TTL or cross a request.
    const pipeline = this.redis.pipeline();
    for (const key of keys) pipeline.get(key);
    const results = await pipeline.exec();
    if (!results || results.length !== keys.length) throw new Error('Incomplete string read batch');
    return results.map(([error, value]) => {
      if (error) throw error;
      if (value !== null && typeof value !== 'string')
        throw new Error('Invalid string read result');
      return value;
    });
  }

  async setStringIfAbsentWithTtl(key: string, value: string, ttlSeconds: number): Promise<boolean> {
    if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds <= 0) throw new Error('Invalid TTL');
    return (await this.redis.set(key, value, 'EX', ttlSeconds, 'NX')) === 'OK';
  }

  async setStringWithTtl(key: string, value: string, ttlSeconds: number): Promise<void> {
    if (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0) {
      return;
    }

    await this.redis.set(key, value, 'EX', Math.trunc(ttlSeconds));
  }

  async deleteKey(key: string): Promise<number> {
    const normalizedKey = key.trim();
    if (!normalizedKey) {
      return 0;
    }

    return this.redis.del(normalizedKey);
  }

  async deleteKeysByPattern(pattern: string, scanCount = 200): Promise<number> {
    const normalizedPattern = pattern.trim();
    if (!normalizedPattern) {
      return 0;
    }

    let deleted = 0;
    let cursor = '0';
    const normalizedScanCount =
      Number.isFinite(scanCount) && scanCount > 0 ? Math.trunc(scanCount) : 200;

    do {
      const [nextCursor, keys] = await this.redis.scan(
        cursor,
        'MATCH',
        normalizedPattern,
        'COUNT',
        String(normalizedScanCount),
      );
      cursor = nextCursor;

      if (keys.length > 0) {
        deleted += await this.redis.del(...keys);
      }
    } while (cursor !== '0');

    return deleted;
  }

  async acquireLock(key: string, ttlMs: number): Promise<string | null> {
    if (!key.trim() || !Number.isFinite(ttlMs) || ttlMs <= 0) {
      return null;
    }

    const token = randomUUID();
    const acquired = await this.redis.set(key, token, 'PX', Math.trunc(ttlMs), 'NX');
    return acquired === 'OK' ? token : null;
  }

  async acquireLockBeforeDeadline(
    key: string,
    token: string,
    ttlMs: number,
    deadlineAtMs: number,
  ): Promise<DeadlineLockAcquireResult> {
    const normalizedKey = key.trim();
    const normalizedToken = token.trim();
    const normalizedTtlMs = Math.trunc(ttlMs);
    const normalizedDeadlineAtMs = Math.trunc(deadlineAtMs);
    if (
      !normalizedKey ||
      !normalizedToken ||
      !Number.isFinite(normalizedTtlMs) ||
      normalizedTtlMs <= 0 ||
      !Number.isFinite(normalizedDeadlineAtMs) ||
      normalizedDeadlineAtMs <= 0
    ) {
      throw new Error('Deadline lock key, token, TTL, and deadline must be valid');
    }

    const status = Number(
      await this.redis.eval(
        ACQUIRE_LOCK_BEFORE_DEADLINE_SCRIPT,
        1,
        normalizedKey,
        normalizedToken,
        String(normalizedTtlMs),
        String(normalizedDeadlineAtMs),
      ),
    );
    if (status === 0) {
      return { kind: 'deadline_exceeded' };
    }
    if (status === 1) {
      return { kind: 'acquired' };
    }
    if (status === 2) {
      return { kind: 'busy' };
    }
    throw new Error('Redis returned an invalid deadline lock acquisition result');
  }

  async releaseLock(key: string, token: string): Promise<void> {
    if (!key.trim() || !token.trim()) {
      return;
    }

    await this.redis.eval(
      'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end',
      1,
      key,
      token,
    );
  }

  async renewLock(key: string, token: string, ttlMs: number): Promise<boolean> {
    if (!key.trim() || !token.trim() || !Number.isFinite(ttlMs) || ttlMs <= 0) {
      return false;
    }

    const renewed = await this.redis.eval(
      RENEW_LOCK_SCRIPT,
      1,
      key,
      token,
      String(Math.trunc(ttlMs)),
    );
    return Number(renewed) > 0;
  }

  private parseRevisionedSetMembershipState(raw: string): StoredRevisionedSetMembershipState {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error('Redis returned malformed revisioned membership state');
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('Redis returned malformed revisioned membership state');
    }

    const record = parsed as Record<string, unknown>;
    const revision = record.revision;
    const memberships = record.memberships;
    if (
      record.v !== 1 ||
      (record.scoreTimestampMs !== undefined &&
        (typeof record.scoreTimestampMs !== 'number' ||
          !Number.isSafeInteger(record.scoreTimestampMs) ||
          record.scoreTimestampMs <= 0)) ||
      typeof revision !== 'number' ||
      !Number.isSafeInteger(revision) ||
      revision <= 0 ||
      !memberships ||
      typeof memberships !== 'object'
    ) {
      throw new Error('Redis returned malformed revisioned membership state');
    }

    const membershipEntries = Array.isArray(memberships)
      ? memberships.map((membership) => {
          if (!membership || typeof membership !== 'object' || Array.isArray(membership)) {
            return ['', Number.NaN] as [string, number];
          }
          const entry = membership as Record<string, unknown>;
          return [entry.key, entry.count] as [unknown, unknown];
        })
      : Object.entries(memberships as Record<string, unknown>);
    if (
      membershipEntries.some(
        ([key, count]) =>
          typeof key !== 'string' ||
          !key.trim() ||
          typeof count !== 'number' ||
          !Number.isSafeInteger(count) ||
          count < 0,
      ) ||
      new Set(membershipEntries.map(([key]) => key)).size !== membershipEntries.length
    ) {
      throw new Error('Redis returned malformed revisioned membership state');
    }

    return {
      revision,
      ...(typeof record.scoreTimestampMs === 'number'
        ? { scoreTimestampMs: record.scoreTimestampMs }
        : {}),
      memberships: new Map(membershipEntries as Array<[string, number]>),
    };
  }

  private parseRevisionedMembershipCounts(values: unknown[], expectedLength: number): number[] {
    const counts = values.map(Number);
    if (
      counts.length !== expectedLength ||
      counts.some((count) => !Number.isSafeInteger(count) || count < 0)
    ) {
      throw new Error('Redis returned invalid revisioned membership counts');
    }
    return counts;
  }

  private stringSetsEqual(left: readonly string[], right: readonly string[]): boolean {
    return left.length === right.length && left.every((value) => right.includes(value));
  }
}
