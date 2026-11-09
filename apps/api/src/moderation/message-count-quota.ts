import { createHash } from 'node:crypto';
import type Redis from 'ioredis';
import {
  DUPLICATE_EVENT_MAX_FUTURE_SKEW_MS,
  resolveDuplicateHistoryRetentionSeconds,
} from './duplicate-state';

export const MESSAGE_COUNT_QUOTA_VERSION = 3;
export const MESSAGE_COUNT_QUOTA_MAX_WINDOW_SECONDS = 24 * 60 * 60;
export const MESSAGE_COUNT_QUOTA_RETENTION_SECONDS = resolveDuplicateHistoryRetentionSeconds(
  MESSAGE_COUNT_QUOTA_MAX_WINDOW_SECONDS,
);
const QUOTA_SOURCE_LIFETIME_MS = 5 * 60_000;

export type MessageCountQuotaInput = {
  chatId: string;
  userId: string;
  messageId: string;
  eventTimestampMs: number;
  maxMessages: number;
  windowSeconds: number;
  // FLAG: Only the caller's verified direct album ID may join different outer messages.
  publicationId?: string;
  deadlineAtMs: number;
  requireReadyBeforeDispatch?: boolean;
};

export type MessageCountQuotaResult =
  | {
      kind: 'allowed' | 'blocked';
      replayed: boolean;
      eventTimestampMs: number;
      publicationId?: string;
    }
  | { kind: 'stale' | 'deadline_exceeded' };

export function buildMessageCountQuotaKeys(input: MessageCountQuotaInput) {
  const scope = `message:count-limit:v3:${input.chatId.trim()}:${input.userId.trim()}`;
  const member = createHash('sha256')
    .update(JSON.stringify(['message', input.messageId.trim()]))
    .digest('hex');
  const publicationHash = input.publicationId
    ? createHash('sha256')
        .update(JSON.stringify(['album', input.publicationId]))
        .digest('hex')
    : undefined;
  return {
    historyKey: `${scope}:admitted`,
    decisionKey: `${scope}:decision:${member}`,
    member,
    ...(publicationHash
      ? {
          publicationKey: `${scope}:publication:${publicationHash}`,
          publicationMember: `album:${input.publicationId}`,
        }
      : {}),
  };
}

// FLAG: v2 contains attempted messages, including rejected sends. Never import it as admission
// history. v3 starts cold once; settings changes reuse this same chat/author history thereafter.
// Redis time/deadline/type checks precede every mutation. Replays preserve the original timestamp,
// decision and TTL; rejected attempts never add history or extend the admitted set's retention.
export const CLAIM_MESSAGE_COUNT_QUOTA_SCRIPT = `
local clock = redis.call('TIME')
local now = tonumber(clock[1]) * 1000 + math.floor(tonumber(clock[2]) / 1000)
if now >= tonumber(ARGV[4]) then return {-1} end
local occurred_at = tonumber(ARGV[1])
local window_ms = tonumber(ARGV[2]) * 1000
if now - occurred_at >= window_ms or occurred_at - now > tonumber(ARGV[7]) then
  return {0}
end
local history_type = redis.call('TYPE', KEYS[1]).ok
if history_type ~= 'none' and history_type ~= 'zset' then
  return redis.error_reply('Invalid message quota history type')
end
local function read_receipt(key)
  local receipt_type = redis.call('TYPE', key).ok
  if receipt_type ~= 'none' and receipt_type ~= 'string' then
    return nil, 'Invalid message quota decision type'
  end
  local raw = redis.call('GET', key)
  if not raw then return nil end
  local ok, saved = pcall(cjson.decode, raw)
  if not ok or type(saved) ~= 'table' or saved.version ~= 3 or
    (saved.result ~= 1 and saved.result ~= 2) or
    type(saved.timestamp) ~= 'number' or saved.timestamp <= 0 or
    saved.timestamp ~= math.floor(saved.timestamp) or
    type(saved.policy) ~= 'string' or saved.policy == '' or
    type(saved.publicationId) ~= 'string' or
    type(saved.member) ~= 'string' then
    return nil, 'Invalid message quota decision'
  end
  return saved
end
local function admission_error(saved)
  local score = redis.call('ZSCORE', KEYS[1], saved.member)
  if saved.result == 1 and now - saved.timestamp < tonumber(ARGV[5]) and
    (not score or tonumber(score) ~= saved.timestamp) then
    return 'Message quota admission history is missing'
  end
  if saved.result == 2 and score then return 'Invalid message quota refused history' end
end
local saved, receipt_error = read_receipt(KEYS[2])
if receipt_error then return redis.error_reply(receipt_error) end
if saved then
  -- FLAG: Physical MID ownership is immutable even if a replay changes or loses its album alias.
  if type(saved.messageTimestamp) ~= 'number' or saved.messageTimestamp <= 0 or
    saved.messageTimestamp ~= math.floor(saved.messageTimestamp) or
    (saved.publicationId == '' and
      (saved.member ~= ARGV[3] or saved.timestamp ~= saved.messageTimestamp)) or
    (saved.publicationId ~= '' and
      (saved.member ~= 'album:' .. saved.publicationId or
       math.abs(saved.messageTimestamp - saved.timestamp) >= tonumber(ARGV[9]) or
       (saved.result == 2 and saved.messageTimestamp < saved.timestamp))) then
    return redis.error_reply('Invalid message quota decision')
  end
  if saved.messageTimestamp ~= occurred_at then return {0} end
  local history_error = admission_error(saved)
  if history_error then return redis.error_reply(history_error) end
  if saved.result == 2 then
    -- FLAG: Later album constituents cannot renew the first rejected publication's authority.
    if saved.policy ~= ARGV[6] or
      now >= saved.timestamp + tonumber(ARGV[9]) then return {0} end
  end
  return {saved.result + 2, saved.timestamp, saved.publicationId}
end
if redis.call('ZSCORE', KEYS[1], ARGV[3]) then
  return redis.error_reply('Message quota decision is missing')
end
local retention_ms = tonumber(ARGV[5])
local publication_id = ''
local member = ARGV[3]
local use_new_publication = false
local expired_publication_member = nil
if #KEYS == 3 then
  local publication, publication_error = read_receipt(KEYS[3])
  if publication_error then return redis.error_reply(publication_error) end
  if publication then
    if publication.publicationId ~= ARGV[8] or
      publication.member ~= 'album:' .. ARGV[8] or
      publication.messageTimestamp ~= nil then
      return redis.error_reply('Invalid message quota publication')
    end
    local history_error = admission_error(publication)
    if history_error then return redis.error_reply(history_error) end
    -- FLAG: Compatibility aliases do not guarantee unique sends. Only a bounded constituent
    -- interval may reuse a group; a later fresh MID falls back to its own atomic quota claim.
    if math.abs(occurred_at - publication.timestamp) < tonumber(ARGV[9]) and
      now < publication.timestamp + tonumber(ARGV[9]) then
      -- FLAG: An earlier constituent can share an allowance, never a later refusal.
      if publication.result == 2 and occurred_at < publication.timestamp then return {0} end
      if publication.result == 2 and publication.policy ~= ARGV[6] then return {0} end
      redis.call('SET', KEYS[2], cjson.encode({
        version = 3, timestamp = publication.timestamp, messageTimestamp = occurred_at,
        result = publication.result, policy = publication.policy,
        member = publication.member, publicationId = publication.publicationId
      }), 'PX', retention_ms)
      return {publication.result + 2, publication.timestamp, publication.publicationId}
    end
  else
    local previous_member = 'album:' .. ARGV[8]
    local previous_score = redis.call('ZSCORE', KEYS[1], previous_member)
    if previous_score then
      -- FLAG: A retained future-scored member may outlive its receipt when another send renews
      -- the shared history. At two maximum windows old, it cannot affect any eligible event.
      if tonumber(previous_score) > now - tonumber(ARGV[11]) then
        return redis.error_reply('Message quota publication decision is missing')
      end
      expired_publication_member = previous_member
    end
    if now < occurred_at + tonumber(ARGV[9]) then
      publication_id = ARGV[8]
      member = 'album:' .. ARGV[8]
      use_new_publication = true
    end
  end
end
local count = redis.call('ZCOUNT', KEYS[1], '(' .. tostring(occurred_at - window_ms), occurred_at)
local result = 2
if count < tonumber(ARGV[10]) then
  result = 1
elseif now >= occurred_at + tonumber(ARGV[9]) then
  return {0}
end
if expired_publication_member then
  redis.call('ZREM', KEYS[1], expired_publication_member)
end
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now - retention_ms)
if result == 1 then
  redis.call('ZADD', KEYS[1], occurred_at, member)
  redis.call('PEXPIRE', KEYS[1], retention_ms)
end
redis.call('SET', KEYS[2], cjson.encode({
  version = 3, timestamp = occurred_at, messageTimestamp = occurred_at,
  result = result, policy = ARGV[6], member = member, publicationId = publication_id
}), 'PX', retention_ms)
if use_new_publication then
  redis.call('SET', KEYS[3], cjson.encode({
    version = 3, timestamp = occurred_at, result = result, policy = ARGV[6],
    member = member, publicationId = publication_id
  }), 'PX', retention_ms)
end
return {result, occurred_at, publication_id}
`;

export async function claimMessageCountQuota(
  redis: Pick<Redis, 'eval'>,
  input: MessageCountQuotaInput,
): Promise<MessageCountQuotaResult> {
  if (
    !input.chatId.trim() ||
    !input.userId.trim() ||
    !input.messageId.trim() ||
    (input.publicationId !== undefined &&
      (!input.publicationId.trim() ||
        input.publicationId.length > 256 ||
        input.publicationId.trim() !== input.publicationId)) ||
    ![input.eventTimestampMs, input.deadlineAtMs, input.maxMessages, input.windowSeconds].every(
      (value) => Number.isSafeInteger(value) && value > 0,
    ) ||
    input.maxMessages > 10 ||
    input.windowSeconds > MESSAGE_COUNT_QUOTA_MAX_WINDOW_SECONDS
  )
    throw new Error('Invalid message count quota input');
  const keys = buildMessageCountQuotaKeys(input);
  const response: unknown = await redis.eval(
    CLAIM_MESSAGE_COUNT_QUOTA_SCRIPT,
    keys.publicationKey ? 3 : 2,
    keys.historyKey,
    keys.decisionKey,
    ...(keys.publicationKey ? [keys.publicationKey] : []),
    String(input.eventTimestampMs),
    String(input.windowSeconds),
    keys.member,
    String(input.deadlineAtMs),
    String(MESSAGE_COUNT_QUOTA_RETENTION_SECONDS * 1000),
    `${input.maxMessages}:${input.windowSeconds}`,
    String(DUPLICATE_EVENT_MAX_FUTURE_SKEW_MS),
    input.publicationId ?? '',
    String(QUOTA_SOURCE_LIFETIME_MS),
    String(input.maxMessages),
    String(MESSAGE_COUNT_QUOTA_MAX_WINDOW_SECONDS * 2 * 1000),
  );
  if (!Array.isArray(response)) throw new Error('Invalid message count quota result');
  const status = Number(response[0]);
  if (status === -1) return { kind: 'deadline_exceeded' };
  if (status === 0) return { kind: 'stale' };
  const timestamp = Number(response[1]);
  const publicationId = response[2];
  if (
    ![1, 2, 3, 4].includes(status) ||
    !Number.isSafeInteger(timestamp) ||
    timestamp <= 0 ||
    typeof publicationId !== 'string' ||
    publicationId.length > 256
  )
    throw new Error('Invalid message count quota result');
  return {
    kind: status === 1 || status === 3 ? 'allowed' : 'blocked',
    replayed: status >= 3,
    eventTimestampMs: timestamp,
    ...(publicationId ? { publicationId } : {}),
  };
}
