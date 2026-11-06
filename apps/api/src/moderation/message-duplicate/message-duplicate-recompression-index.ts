import type { RedisCounterService } from '../redis-counter.service';

export type MessageDuplicateRecompressionCandidate = {
  webhookEventId: string;
  messageId: string;
  eventTimestampMs: number;
  publishedAtMs: number;
  canonicalHash: string;
  recompressionHash: string;
  expiresAtMs: number;
};

export type DuplicateRecompressionIndexInput = {
  op: 'read' | 'remember';
  atMs: number;
  candidate?: MessageDuplicateRecompressionCandidate;
};

const HASH = /^[a-f0-9]{64}$/u;
const RECOMPRESSION_HASH = /^[a-f0-9]{16}$/u;
const MAX_RETENTION_MS = 48 * 60 * 60 * 1000;
const FIELDS = [
  'webhookEventId',
  'messageId',
  'eventTimestampMs',
  'publishedAtMs',
  'canonicalHash',
  'recompressionHash',
  'expiresAtMs',
] as const;

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 32 || code === 127) return true;
  }
  return false;
}

function validCandidate(value: unknown): value is MessageDuplicateRecompressionCandidate {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return (
    Object.keys(row).length === FIELDS.length &&
    FIELDS.every((field) => Object.hasOwn(row, field)) &&
    typeof row.webhookEventId === 'string' &&
    Buffer.byteLength(row.webhookEventId) > 0 &&
    Buffer.byteLength(row.webhookEventId) <= 128 &&
    !hasControlCharacter(row.webhookEventId) &&
    typeof row.messageId === 'string' &&
    Buffer.byteLength(row.messageId) > 0 &&
    Buffer.byteLength(row.messageId) <= 256 &&
    !hasControlCharacter(row.messageId) &&
    typeof row.canonicalHash === 'string' &&
    HASH.test(row.canonicalHash) &&
    typeof row.recompressionHash === 'string' &&
    RECOMPRESSION_HASH.test(row.recompressionHash) &&
    ['eventTimestampMs', 'publishedAtMs', 'expiresAtMs'].every(
      (field) => Number.isSafeInteger(row[field]) && Number(row[field]) > 0,
    ) &&
    Number(row.expiresAtMs) > Number(row.publishedAtMs)
  );
}

export function duplicateRecompressionIndexKeys(scope: string, hash: string): string[] {
  if (!HASH.test(scope) || !RECOMPRESSION_HASH.test(hash))
    throw new Error('Invalid duplicate recompression index scope');
  return Array.from(
    { length: 8 },
    (_, band) => `dup:recompression:v1:${scope}:${band}:${hash.slice(band * 2, band * 2 + 2)}`,
  );
}

// FLAG: These bands select source pointers only. A collision never establishes image
// equality or deletion authority; every returned source needs independent current proof.
export const DUPLICATE_RECOMPRESSION_INDEX_SCRIPT = `
local p = cjson.decode(ARGV[1])
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
if now >= tonumber(ARGV[2]) then return redis.error_reply('Recompression index deadline exceeded') end
local retention = ${MAX_RETENTION_MS}
local fields = {webhookEventId=true,messageId=true,eventTimestampMs=true,publishedAtMs=true,canonicalHash=true,recompressionHash=true,expiresAtMs=true}
local function integer(v) return type(v)=='number' and v>0 and v<=9007199254740991 and v==math.floor(v) end
local function valid(r)
  if type(r)~='table' then return false end
  local count=0
  for k,_ in pairs(r) do if not fields[k] then return false end; count=count+1 end
  return count==7 and type(r.webhookEventId)=='string' and #r.webhookEventId>0 and #r.webhookEventId<=128
    and not string.find(r.webhookEventId,'%c')
    and type(r.messageId)=='string' and #r.messageId>0 and #r.messageId<=256
    and not string.find(r.messageId,'%c')
    and type(r.canonicalHash)=='string' and #r.canonicalHash==64 and not string.find(r.canonicalHash,'[^a-f0-9]')
    and type(r.recompressionHash)=='string' and #r.recompressionHash==16 and not string.find(r.recompressionHash,'[^a-f0-9]')
    and integer(r.eventTimestampMs) and integer(r.publishedAtMs) and integer(r.expiresAtMs)
    and r.expiresAtMs>r.publishedAtMs
end
if #KEYS~=8 or not integer(p.atMs) or (p.op~='read' and p.op~='remember')
  or (p.op=='remember' and not valid(p.candidate)) then return redis.error_reply('Invalid recompression index input') end
local buckets={}
local expires=p.op=='remember' and math.min(p.candidate.expiresAtMs,p.candidate.publishedAtMs+retention,now+retention) or 0
-- FLAG: Validate all bounded buckets before mutating any of them. Corruption must
-- never yield partial candidate history or cross canonical raster identities.
for i=1,8 do
  local raw=redis.call('GET',KEYS[i])
  local rows={}
  if raw then
    if #raw>8192 or not string.match(raw,'^%s*%[') then return redis.error_reply('Invalid recompression index bucket') end
    local ok,decoded=pcall(cjson.decode,raw)
    if not ok or type(decoded)~='table' or #decoded>8 then return redis.error_reply('Invalid recompression index bucket') end
    local count=0
    for k,r in pairs(decoded) do
      count=count+1
      if type(k)~='number' or k<1 or k>#decoded or not valid(r)
        or r.expiresAtMs>r.publishedAtMs+retention
        or string.sub(r.recompressionHash,(i-1)*2+1,i*2)~=string.sub(KEYS[i],-2)
        then return redis.error_reply('Invalid recompression index candidate') end
    end
    if count~=#decoded then return redis.error_reply('Invalid recompression index bucket') end
    for _,r in ipairs(decoded) do
      if r.expiresAtMs>now then
        rows[#rows+1]=r
        if p.op=='remember' and r.messageId==p.candidate.messageId
          and r.webhookEventId==p.candidate.webhookEventId then expires=math.min(expires,r.expiresAtMs) end
      end
    end
  end
  buckets[i]=rows
end
local function earlier(a,b)
  if a.publishedAtMs~=b.publishedAtMs then return a.publishedAtMs<b.publishedAtMs end
  if a.eventTimestampMs~=b.eventTimestampMs then return a.eventTimestampMs<b.eventTimestampMs end
  if a.canonicalHash~=b.canonicalHash then return a.canonicalHash<b.canonicalHash end
  if a.messageId~=b.messageId then return a.messageId<b.messageId end
  return a.webhookEventId<b.webhookEventId
end
local function newerSource(a,b)
  if a.eventTimestampMs~=b.eventTimestampMs then return a.eventTimestampMs>b.eventTimestampMs end
  if a.publishedAtMs~=b.publishedAtMs then return a.publishedAtMs>b.publishedAtMs end
  if a.messageId~=b.messageId then return a.messageId>b.messageId end
  return a.webhookEventId>b.webhookEventId
end
local queryHash=''
for i=1,8 do queryHash=queryHash..string.sub(KEYS[i],-2) end
local distances={}
local function withinHamming(hash)
  local distance=0
  for i=1,16,2 do
    local differing=bit.bxor(tonumber(string.sub(hash,i,i+1),16),tonumber(string.sub(queryHash,i,i+1),16))
    while differing~=0 do
      distance=distance+1
      if distance>6 then return false end
      differing=bit.band(differing,differing-1)
    end
  end
  distances[hash]=distance
  return true
end
local all={}
local seen={}
local encoded={}
local deadlines={}
for i=1,8 do
  local rows=buckets[i]
  if p.op=='remember' and expires>now and expires>p.candidate.publishedAtMs then
    local incoming=p.candidate
    incoming.expiresAtMs=expires
    rows[#rows+1]=incoming
  end
  -- FLAG: A fresh exact raster can replace a removed/reset source pointer. This
  -- key is the exact canonical SHA-256, never a perceptual hash or approximate chain.
  local preferred={}
  for _,r in ipairs(rows) do
    local prior=preferred[r.canonicalHash]
    if prior and prior.messageId==r.messageId and prior.webhookEventId==r.webhookEventId then
      prior.expiresAtMs=math.min(prior.expiresAtMs,r.expiresAtMs)
    elseif not prior or newerSource(r,prior) then preferred[r.canonicalHash]=r end
  end
  rows={}
  for _,r in pairs(preferred) do rows[#rows+1]=r end
  table.sort(rows,earlier)
  local kept={}
  local hashes={}
  local deadline=0
  for _,r in ipairs(rows) do
    if not hashes[r.canonicalHash] and #kept<8 then
      hashes[r.canonicalHash]=true
      kept[#kept+1]=r
      deadline=math.max(deadline,r.expiresAtMs)
      if r.publishedAtMs<=p.atMs and r.eventTimestampMs<=p.atMs and r.expiresAtMs>p.atMs
        and (p.op~='read' or withinHamming(r.recompressionHash)) and not seen[r.canonicalHash] then
        seen[r.canonicalHash]=true; all[#all+1]=r
      end
    end
  end
  if #kept>0 then
    encoded[i]=cjson.encode(kept)
    if #encoded[i]>8192 then return redis.error_reply('Recompression index bucket exceeded') end
  else encoded[i]='' end
  deadlines[i]=math.min(deadline,now+retention)
end
for i=1,8 do
  if encoded[i]=='' then redis.call('DEL',KEYS[i])
  else redis.call('SET',KEYS[i],encoded[i],'PXAT',deadlines[i]) end
end
-- FLAG: Select the nearest retained sources before either bounded proof-attempt cap.
-- Distance only orders candidates; every match still requires independent native proof.
table.sort(all,function(a,b)
  if p.op=='read' then
    local left=distances[a.recompressionHash]
    local right=distances[b.recompressionHash]
    if left~=right then return left<right end
  end
  return earlier(a,b)
end)
local result={}
for i=1,math.min(8,#all) do result[i]=all[i] end
if #result==0 then return '[]' end
return cjson.encode(result)
`;

export class MessageDuplicateRecompressionIndex {
  constructor(private readonly redis: Pick<RedisCounterService, 'duplicateRecompressionIndex'>) {}

  async read(
    scope: string,
    hash: string,
    atMs: number,
  ): Promise<MessageDuplicateRecompressionCandidate[]> {
    if (!Number.isSafeInteger(atMs) || atMs <= 0)
      throw new Error('Invalid duplicate recompression index time');
    const raw = await this.redis.duplicateRecompressionIndex(
      duplicateRecompressionIndexKeys(scope, hash),
      { op: 'read', atMs },
    );
    const rows: unknown = JSON.parse(raw);
    if (!Array.isArray(rows) || rows.length > 8 || !rows.every(validCandidate))
      throw new Error('Invalid duplicate recompression index result');
    return rows;
  }

  async remember(scope: string, candidate: MessageDuplicateRecompressionCandidate): Promise<void> {
    if (!validCandidate(candidate)) throw new Error('Invalid duplicate recompression candidate');
    await this.redis.duplicateRecompressionIndex(
      duplicateRecompressionIndexKeys(scope, candidate.recompressionHash),
      { op: 'remember', atMs: candidate.eventTimestampMs, candidate },
    );
  }
}
