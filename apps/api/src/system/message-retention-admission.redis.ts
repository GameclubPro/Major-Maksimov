import { RETENTION_PRIORITY_VERSION } from '../max/retention-priority-admission';

export const RETENTION_ADMISSION_COLLECTOR_KEY = 'maxapi:retention-priority:collector:v1';

// FLAG: This fixed inventory sampler reads cardinalities and one due-delay member;
// it never scans jobs. BullMQ 5 stores delayed timestamps in score / 4096.
export const RETENTION_SAMPLE_SCRIPT = `
local time = redis.call('TIME')
local nowMs = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
local ready = 0
local active = 0
local due = 0
if redis.call('EXISTS', KEYS[3]) ~= 0 then return {nowMs, 'activity_unavailable'} end
local activityKind = redis.call('TYPE', KEYS[2]).ok
if activityKind ~= 'none' and activityKind ~= 'zset' then return redis.error_reply('Invalid higher priority activity') end
if activityKind == 'zset' then
  active = redis.call('ZCARD', KEYS[2])
  if active > 0 then
    local oldest = redis.call('ZRANGE', KEYS[2], 0, 0, 'WITHSCORES')
    if tonumber(oldest[2]) <= nowMs then return {nowMs, 'stale_activity'} end
  end
end
for index = 4, #KEYS, 5 do
  for offset = 0, 2 do
    local key = KEYS[index + offset]
    local kind = redis.call('TYPE', key).ok
    if kind ~= 'none' and kind ~= 'list' then return redis.error_reply('Invalid priority queue list') end
    local size = kind == 'list' and redis.call('LLEN', key) or 0
    if offset == 1 then active = active + size else ready = ready + size end
  end
  for offset = 3, 4 do
    local key = KEYS[index + offset]
    local kind = redis.call('TYPE', key).ok
    if kind ~= 'none' and kind ~= 'zset' then return redis.error_reply('Invalid priority queue set') end
    if kind == 'zset' then
      if offset == 3 then ready = ready + redis.call('ZCARD', key)
      elseif #redis.call('ZRANGEBYSCORE', key, '-inf', (nowMs + 1) * 4096 - 1, 'LIMIT', 0, 1) > 0 then due = due + 1 end
    end
  end
end
local minute = math.floor(tonumber(time[1]) / 60) * 60
local current = KEYS[1] .. ':' .. tostring(minute)
redis.call('HSETNX', current, 'arrivals', 0)
redis.call('HSETNX', current, 'http', 0)
redis.call('EXPIRE', current, tonumber(ARGV[1]))
local counts = redis.call('HMGET', current, 'arrivals', 'http')
local previous = redis.call('HMGET', KEYS[1] .. ':' .. tostring(minute - 60), 'arrivals', 'http')
return {nowMs, ready, active, due, counts[1], counts[2], previous[1] or '', previous[2] or ''}
`;

export const RETENTION_COMMIT_SAMPLE_SCRIPT = `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
local time = redis.call('TIME')
local nowMs = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
local started = tonumber(ARGV[2])
if not started or started > nowMs or nowMs - started > 2000 then return 0 end
redis.call('PEXPIRE', KEYS[1], 4000)
redis.call('SET', KEYS[2], ARGV[3], 'EX', 180)
if ARGV[4] == '1' then
  local deadline = math.min(nowMs + 900, started + 1900)
  redis.call('HSET', KEYS[3], 'version', '${RETENTION_PRIORITY_VERSION}', 'sampleStartedAtMs', started, 'validUntilMs', deadline)
  redis.call('PEXPIRE', KEYS[3], deadline - nowMs)
else redis.call('DEL', KEYS[3]) end
return 1
`;

export const RETENTION_RELEASE_COLLECTOR_SCRIPT = `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
redis.call('DEL', KEYS[2])
return redis.call('DEL', KEYS[1])
`;
