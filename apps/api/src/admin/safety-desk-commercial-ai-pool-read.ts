import { z } from 'zod';
import {
  COMMERCIAL_LLM_POOL_PROFILES,
  POOL_NODE_IDS,
  commercialLlmPoolNodeKeys,
} from '../moderation/commercial/commercial-llm-pool.protocol';
import { COMMERCIAL_LLM_POOL_ADMISSION_KEYS } from '../moderation/commercial/commercial-llm-pool-admission.mailbox';

export const COMMERCIAL_AI_POOL_READ_KEYS = [
  ...POOL_NODE_IDS.flatMap((id) => {
    const keys = commercialLlmPoolNodeKeys(id);
    return [keys.lease, keys.heartbeat, keys.slot];
  }),
  COMMERCIAL_LLM_POOL_ADMISSION_KEYS.status,
];
export const COMMERCIAL_AI_POOL_EXPECTED = JSON.stringify(
  POOL_NODE_IDS.map((nodeId) => ({
    nodeId,
    identity: COMMERCIAL_LLM_POOL_PROFILES[nodeId].identity,
  })),
);

// FLAG: Thirteen fixed keys, bounded GET only after TYPE/STRLEN/PTTL. Ownership tokens stay
// inside Redis; slot bodies, prompts, responses, sources and pending queues are never read.
// This projection is diagnostic only and neither renews nor releases any runtime authority.
export const READ_COMMERCIAL_AI_POOL = `
local expected = cjson.decode(ARGV[1])
local function kind(key) return redis.call('TYPE', key).ok end
local function decode(raw)
  local ok, value = pcall(cjson.decode, raw)
  if ok and type(value) == 'table' then return value end
  return nil
end
local function sameIdentity(actual, target)
  if type(actual) ~= 'table' then return false end
  local a, b = 0, 0
  for k,v in pairs(actual) do a=a+1; if target[k] ~= v then return false end end
  for _ in pairs(target) do b=b+1 end
  return a == b
end
local nodes = {}
for i=1,4 do
  local at=(i-1)*3
  local lk,hk,sk=kind(KEYS[at+1]),kind(KEYS[at+2]),kind(KEYS[at+3])
  local lt,ht,st=redis.call('PTTL',KEYS[at+1]),redis.call('PTTL',KEYS[at+2]),redis.call('PTTL',KEYS[at+3])
  local state,ttl='OFFLINE',0
  if (lk~='none' and (lk~='string' or lt<=0 or lt>10000 or redis.call('STRLEN',KEYS[at+1])~=36))
    or (hk~='none' and (hk~='string' or ht<=0 or ht>6000 or redis.call('STRLEN',KEYS[at+2])>4096))
    or (sk~='none' and (sk~='string' or st<=0 or st>20000)) then state='INVALID'
  elseif lk=='string' and hk=='string' then
    local session=redis.call('GET',KEYS[at+1])
    local heartbeat=decode(redis.call('GET',KEYS[at+2]))
    if not heartbeat or heartbeat.nodeId~=expected[i].nodeId or heartbeat.session~=session
      or type(heartbeat.ready)~='boolean' or not sameIdentity(heartbeat.identity,expected[i].identity) then state='INVALID'
    else
      ttl=math.min(lt,ht)
      if sk~='none' then state='SLOT_OCCUPIED'; ttl=math.min(ttl,st)
      elseif heartbeat.ready then state='READY'
      else state='NOT_READY' end
    end
  end
  nodes[i]={nodeId=expected[i].nodeId,state=state,ttlMs=ttl}
end
local status={'missing'}
local k=kind(KEYS[13])
if k~='none' then
  if k~='string' then status={'invalid'}
  else
    local n=redis.call('STRLEN',KEYS[13]); local ttl=redis.call('PTTL',KEYS[13])
    if n>16384 or ttl==-1 or ttl>30000 then status={'invalid'}
    elseif n>0 and ttl>0 then status={'value',redis.call('GET',KEYS[13]),ttl} end
  end
end
return cjson.encode({nodes=nodes,status=status})`;

export const commercialAiPoolReadSchema = z
  .object({
    nodes: z
      .array(
        z
          .object({
            nodeId: z.enum(POOL_NODE_IDS),
            state: z.enum(['READY', 'SLOT_OCCUPIED', 'NOT_READY', 'OFFLINE', 'INVALID']),
            ttlMs: z.number().int().min(0).max(6000),
          })
          .strict(),
      )
      .length(4)
      .refine((nodes) =>
        nodes.every(
          (node, index) =>
            node.nodeId === POOL_NODE_IDS[index] &&
            (['OFFLINE', 'INVALID'].includes(node.state) ? node.ttlMs === 0 : node.ttlMs > 0),
        ),
      ),
    status: z.union([
      z.tuple([z.enum(['missing', 'invalid'])]),
      z.tuple([z.literal('value'), z.string().max(16384), z.number().int().positive().max(30000)]),
    ]),
  })
  .strict();
