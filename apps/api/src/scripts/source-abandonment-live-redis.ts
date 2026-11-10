import type { MaxActionJob } from '../max/max-client.service';
import { parseChatIdAsBigInt } from '../common/chat-id.util';
import { MAX_ACTION_ALL_QUEUE_NAMES } from '../max/max-action.queue';
import { readLegacyActionSourceScopes } from '../webhook/webhook-legacy-hold.service';
import {
  SOURCE_ABANDONMENT_CHANNEL_PROFILE,
  SOURCE_ABANDONMENT_HUMAN_PROFILE,
} from '../webhook/webhook-source-abandonment.contract';
import {
  LEGACY_RECOVERY_LIVE_QUEUE_NAMES,
  LEGACY_RECOVERY_LIVE_QUEUE_STATES,
} from './legacy-recovery-live-registry';
import { isLegacyRecoveryWebhookQueue } from './legacy-recovery-queue-inventory';
import {
  sourceAbandonmentDigest,
  SOURCE_ABANDONMENT_OBSERVATION_QUEUE,
  type SourceAbandonmentChildEvidence,
  type SourceAbandonmentLiveSelection,
} from './source-abandonment-live-protocol';
import type { SourceInventoryAllowance } from './source-abandonment-live-sql';
import type { LegacyRecoveryLivePlanProof } from './legacy-recovery-live-protocol';
import {
  readSourceAbandonmentCleanupScopes,
  sourceAbandonmentCleanupParentKey,
  type SourceAbandonmentCleanupParent,
} from './source-abandonment-cleanup-proof';
import {
  inventorySourceAbandonmentNamespaces,
  projectSourceAbandonmentNamespaceCounts,
  type SourceAbandonmentCatalogReader,
  type SourceAbandonmentCatalogProof,
} from './source-abandonment-redis-catalog';

// FLAG: Owner/job EVAL_RO readers retain the reviewed legacy byte/probe limits.
// The separately bounded full namespace census cannot spend this effect budget.
const headerScript = `-- source-abandonment:headers
local function kind(key) return redis.call('TYPE', key).ok end
local fence = 'maxim:webhook-rollout:pause-owner:v1'
if ARGV[3] == 'offline' and (kind(fence) ~= 'string' or redis.call('STRLEN', fence) > 256 or redis.call('GET', fence) ~= ARGV[2]) then
  return {0, 'QUEUE_FENCE_UNVERIFIED'}
end
local queues = cjson.decode(ARGV[1])
local states = {'wait','paused','active','delayed','prioritized','waiting-children','failed','completed'}
local rows = {}
local probes = 3
for _, name in ipairs(queues) do
  local prefix = 'bull:' .. name .. ':'
  local meta = prefix .. 'meta'
  local mk = kind(meta)
  probes = probes + 1
  if mk ~= 'none' and mk ~= 'hash' then return {0, 'QUEUE_METADATA_TYPE_INVALID'} end
  local paused = ''
  local version = ''
  if mk == 'hash' then
    if redis.call('HSTRLEN', meta, 'paused') > 16 or redis.call('HSTRLEN', meta, 'version') > 128 then
      return {0, 'QUEUE_METADATA_OVERSIZED'}
    end
    paused = redis.call('HGET', meta, 'paused') or ''
    version = redis.call('HGET', meta, 'version') or ''
    probes = probes + 4
  end
  local counter = prefix .. 'id'
  local ck = kind(counter)
  probes = probes + 1
  if ck ~= 'none' and ck ~= 'string' then return {0, 'QUEUE_COUNTER_TYPE_INVALID'} end
  local generation = ''
  if ck == 'string' then
    if redis.call('STRLEN', counter) > 20 then return {0, 'QUEUE_COUNTER_OVERSIZED'} end
    generation = redis.call('GET', counter)
    probes = probes + 2
  end
  local row = {name, generation, paused, version}
  for i, state in ipairs(states) do
    local key = prefix .. state
    local k = kind(key)
    local expected = i <= 3 and 'list' or 'zset'
    probes = probes + 1
    if k ~= 'none' and k ~= expected then return {0, 'QUEUE_STATE_TYPE_INVALID'} end
    local count = 0
    if k ~= 'none' then
      count = redis.call(i <= 3 and 'LLEN' or 'ZCARD', key)
      probes = probes + 1
    end
    table.insert(row, count)
  end
  local repeatKey = prefix .. 'repeat'
  local rk = kind(repeatKey)
  probes = probes + 1
  if rk ~= 'none' and rk ~= 'zset' then return {0, 'QUEUE_REPEAT_TYPE_INVALID'} end
  table.insert(row, rk == 'none' and 0 or redis.call('ZCARD', repeatKey))
  probes = probes + (rk == 'none' and 0 or 1)
  table.insert(rows, row)
end
return {1, probes, rows}
`;

// Hash field names/lengths are bounded before HGETALL. Unknown hash fields remain
// in the digest, so changing a parent envelope cannot evade the aggregate's second read.
const readHashLua = `
local function readHash(key, canRead)
  local k = redis.call('TYPE', key).ok
  probes = probes + 1
  if k == 'none' then return nil, 0 end
  if k ~= 'hash' then return nil, -1 end
  if canRead == false then return nil, -4 end
  local count = redis.call('HLEN', key)
  probes = probes + 1
  if count == 0 or count > 32 then return nil, -2 end
  local names = redis.call('HKEYS', key)
  local size = 0
  probes = probes + 1
  for _, field in ipairs(names) do
    if string.len(field) > 128 then return nil, -2 end
    local n = redis.call('HSTRLEN', key, field)
    probes = probes + 1
    if n > 32768 then return nil, -2 end
    size = size + n + string.len(field) + 16
    if size > 45000 then return nil, -2 end
  end
  if bytes + size > 48000 then return nil, -3 end
  bytes = bytes + size
  probes = probes + 1
  return redis.call('HGETALL', key), size
end
`;

const jobsScript = `-- source-abandonment:jobs
local probes = 0
local bytes = 0
${readHashLua}
local prefix = ARGV[1]
local state = ARGV[2]
local offset = tonumber(ARGV[3])
local take = tonumber(ARGV[4])
local isList = state == 'wait' or state == 'paused' or state == 'active'
local ids
if isList then ids = redis.call('LRANGE', prefix .. state, offset, offset + take - 1)
else ids = redis.call('ZRANGE', prefix .. state, offset, offset + take - 1, 'WITHSCORES') end
probes = probes + 1
local rows = {}
local step = isList and 1 or 2
for i = 1, #ids, step do
  local id = ids[i]
  if string.len(id) == 0 or string.len(id) > 512 then return {0, 'JOB_ID_INVALID'} end
  bytes = bytes + string.len(id) + string.len(state) + 192
  local hash, size = readHash(prefix .. id)
  if size == -3 and #rows > 0 then break end
  if not hash then return {0, (size == -2 or size == -3) and 'JOB_PAYLOAD_OVERSIZED' or 'JOB_HASH_MISSING_OR_INVALID'} end
  table.insert(rows, {id, state, hash, offset + (i - 1) / step, isList and '' or ids[i + 1]})
end
return {1, probes, #rows, rows}
`;

const ownersScript = `-- source-abandonment:owners
local probes = 0
local bytes = 0
${readHashLua}
local prefix = ARGV[1]
local owners = cjson.decode(ARGV[2])
local start = tonumber(ARGV[3])
local maxProbes = tonumber(ARGV[4])
local maxRows = tonumber(ARGV[5])
local states = {'wait','paused','active','delayed','prioritized','waiting-children','failed','completed'}
local rows = {}
local processed = 0
for i = start + 1, #owners do
  if #rows >= 32 then break end
  if maxRows > 0 and #rows >= maxRows then break end
  if probes + 64 > maxProbes then return {0, 'REDIS_PROBE_BUDGET_EXCEEDED'} end
  local id = owners[i]
  bytes = bytes + string.len(id) + 192
  local hash, size = readHash(prefix .. id, #rows < maxRows)
  if size == -3 and processed > 0 then break end
  if size < 0 then return {0, size == -4 and 'REDIS_ROW_BUDGET_EXCEEDED' or (size == -2 or size == -3) and 'JOB_PAYLOAD_OVERSIZED' or 'JOB_HASH_MISSING_OR_INVALID'} end
  local memberships = {}
  for j, state in ipairs(states) do
    local key = prefix .. state
    local found = false
    local position = -1
    local score = ''
    if j <= 3 then
      local n = redis.call('LLEN', key)
      probes = probes + 1
      if n > 0 then
        if probes + n + 64 > maxProbes then return {0, 'REDIS_PROBE_BUDGET_EXCEEDED'} end
        local p = redis.call('LPOS', key, id, 'MAXLEN', n)
        found = p ~= false
        if found then position = p end
        probes = probes + n
      end
    else
      local s = redis.call('ZSCORE', key, id)
      found = s ~= false
      if found then
        score = s
        position = redis.call('ZRANK', key, id)
        probes = probes + 1
      end
      probes = probes + 1
    end
    if found then table.insert(memberships, {state, position, score}) end
  end
  if #memberships > 1 or (hash and #memberships ~= 1) or (not hash and #memberships ~= 0) then
    return {0, 'WEBHOOK_OWNER_STATE_INCONSISTENT'}
  end
  if hash then table.insert(rows, {id, memberships[1][1], hash, memberships[1][2], memberships[1][3]}) end
  processed = processed + 1
end
return {1, probes, processed, rows}
`;

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
function identity(value: unknown): value is string {
  return (
    typeof value === 'string' && value.length > 0 && value.length <= 512 && value === value.trim()
  );
}
function integer(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}
class Refused extends Error {
  constructor(
    readonly code: string,
    readonly descriptor?: string,
  ) {
    super(code);
  }
}
type JobRead = {
  id: string;
  state: string;
  hash: Record<string, string>;
  data: unknown;
  position: number;
  score: string;
};
function decodeJobs(value: unknown): JobRead[] {
  if (!Array.isArray(value) || value.length > 200) throw new Refused('REDIS_REPLY_INVALID');
  return value.map((raw) => {
    if (
      !Array.isArray(raw) ||
      raw.length !== 5 ||
      !identity(raw[0]) ||
      !identity(raw[1]) ||
      !Array.isArray(raw[2]) ||
      !integer(raw[3]) ||
      typeof raw[4] !== 'string' ||
      raw[4].length > 128 ||
      (raw[4] !== '' && !Number.isFinite(Number(raw[4])))
    )
      throw new Refused('REDIS_REPLY_INVALID');
    const fields = raw[2];
    if (
      fields.length === 0 ||
      fields.length > 64 ||
      fields.length % 2 !== 0 ||
      fields.some((v) => typeof v !== 'string')
    )
      throw new Refused('JOB_HASH_MISSING_OR_INVALID');
    const hash: Record<string, string> = Object.create(null) as Record<string, string>;
    for (let i = 0; i < fields.length; i += 2) {
      if (Object.hasOwn(hash, fields[i])) throw new Refused('JOB_HASH_DUPLICATE_FIELD');
      hash[fields[i]] = fields[i + 1];
    }
    if (!Object.hasOwn(hash, 'data')) throw new Refused('JOB_DATA_MISSING');
    let data: unknown;
    try {
      data = JSON.parse(hash.data);
    } catch {
      throw new Refused('JOB_DATA_INVALID');
    }
    return { id: raw[0], state: raw[1], hash, data, position: raw[3], score: raw[4] };
  });
}

export type SourceAbandonmentRedisReader = SourceAbandonmentCatalogReader;
export type SourceAbandonmentRedisSource = { chatId: string; messageId: string } & (
  | { userId: string; sourceProfile?: typeof SOURCE_ABANDONMENT_HUMAN_PROFILE }
  | { userId: null; sourceProfile: typeof SOURCE_ABANDONMENT_CHANNEL_PROFILE }
);

// FLAG: Only full SQL source proof may supply the explicit authorless profile.
// Missing user metadata on an ordinary source never becomes a channel identity.
function assertSourceIdentities(sources: readonly SourceAbandonmentRedisSource[]): void {
  if (
    sources.some(
      (source) =>
        !identity(source.chatId) ||
        !identity(source.messageId) ||
        (source.sourceProfile === SOURCE_ABANDONMENT_CHANNEL_PROFILE
          ? source.userId !== null
          : !identity(source.userId) ||
            (source.sourceProfile !== undefined &&
              source.sourceProfile !== SOURCE_ABANDONMENT_HUMAN_PROFILE)),
    )
  )
    throw new Refused('SOURCE_PROFILE_UNPROVED');
}

function canonicalFanoutIdentity(value: unknown, chat: boolean): value is string {
  if (!identity(value)) return false;
  const numeric = parseChatIdAsBigInt(value);
  return numeric !== null && numeric.toString() === value && (chat ? numeric < 0n : numeric > 0n);
}

// FLAG: A retained FANOUT_HIGH observation can legitimately have no message.
// Prove its persisted identity and complete user/chat disjointness before
// excluding it from this source inventory. This never installs a child hold,
// retries a job, or treats its failure as success. Clocks cannot prove independence:
// the observation producer can update observedAt on the same persisted row.
// An authorless channel cannot prove the required global-user disjointness.
export function isUnrelatedSourceAbandonmentFanoutObservation(
  data: Record<string, unknown>,
  observation: Record<string, unknown> | null,
  sources: readonly SourceAbandonmentRedisSource[],
): boolean {
  return Boolean(
    observation &&
    identity(data.observationId) &&
    observation.id === data.observationId &&
    canonicalFanoutIdentity(data.userId, false) &&
    observation.userId === data.userId &&
    canonicalFanoutIdentity(data.chatId, true) &&
    observation.chatId === data.chatId &&
    observation.messageId === null &&
    data.source === 'FANOUT_HIGH' &&
    observation.source === data.source &&
    data.fastPath === false &&
    sources.length > 0 &&
    sources.every(
      (source) =>
        canonicalFanoutIdentity(source.userId, false) &&
        canonicalFanoutIdentity(source.chatId, true) &&
        source.userId !== observation.userId &&
        source.chatId !== observation.chatId,
    ),
  );
}

type SourceAbandonmentResolvedRow = {
  key: string;
  row: Record<string, unknown> | null;
  digest: string;
};
export type SourceAbandonmentRedisResolver = (
  kind: 'action' | 'observation',
  keys: readonly string[],
  allowance: SourceInventoryAllowance,
) => Promise<{
  rows: SourceAbandonmentResolvedRow[];
  cost: { pages: number; rows: number; probes: number; bytes: number };
  plans: LegacyRecoveryLivePlanProof[];
  issue: { code: string; descriptor: string } | null;
}>;
const queueNames = [...LEGACY_RECOVERY_LIVE_QUEUE_NAMES].sort();
const actionQueues = new Set<string>(MAX_ACTION_ALL_QUEUE_NAMES);
const contexts = new Set([
  'moderationSource',
  'moderationRuleNotice',
  'requiredSubscriptionNotice',
  'duplicateNotice',
  'moderationNoticeEnvelope',
]);

function assertJobAncestry(job: JobRead): void {
  if (['parent', 'parentKey', 'rjk', 'nrjid'].some((key) => job.hash[key]))
    throw new Refused('JOB_PARENT_UNPROVED');
  const opts = job.hash.opts ? record(JSON.parse(job.hash.opts)) : {};
  if (!opts || opts.parent || opts.repeat) throw new Refused('JOB_PARENT_UNPROVED');
}

// FLAG: The source parser is shared with final transport guards. User identity and
// job creation time never manufacture a source or an exact child exclusion.
export function classifySourceAbandonmentAction(
  job: JobRead,
  sources: readonly SourceAbandonmentRedisSource[],
  cleanupParent?: SourceAbandonmentCleanupParent,
): SourceAbandonmentChildEvidence | null {
  assertSourceIdentities(sources);
  assertJobAncestry(job);
  const data = record(job.data);
  if (
    !data ||
    !identity(data.idempotencyKey) ||
    !identity(data.chatId) ||
    ![
      'SEND_MESSAGE',
      'DELETE_MESSAGE',
      'BAN_MEMBER',
      'KICK_MEMBER',
      'UNBAN_MEMBER',
      'TRY_UNBAN_MEMBER',
      'NOTIFY_MODERATORS',
    ].includes(String(data.actionType))
  )
    throw new Refused('ACTION_ENVELOPE_UNPROVED');
  const context = data.ledgerContext === undefined ? {} : record(data.ledgerContext);
  // FLAG: This extra key belongs only to a retained completed rule SEND cleanup.
  // Its exact typed lineage is checked below; it cannot admit an arbitrary action.
  const possibleRuleCleanup =
    data.actionType === 'DELETE_MESSAGE' && record(data.sendAutoDelete)?.sourceMessageId === null;
  if (
    !context ||
    Object.keys(context).some(
      (key) => !contexts.has(key) && !(key === 'moderationRuleFollowup' && possibleRuleCleanup),
    )
  )
    throw new Refused('ACTION_PRODUCER_UNPROVED');
  let cleanupScopes: ReturnType<typeof readLegacyActionSourceScopes> | null = null;
  if (data.sendAutoDelete !== undefined) {
    const marker = record(data.sendAutoDelete);
    if (marker?.sourceMessageId === null) {
      cleanupScopes = readSourceAbandonmentCleanupScopes(data, cleanupParent, sources);
      if (!cleanupScopes) throw new Refused('CLEANUP_ORIGINAL_SOURCE_UNPROVED');
    }
    if (
      !cleanupScopes &&
      (!marker ||
        !identity(marker.sourceSendJobId) ||
        !identity(marker.sourceChatId) ||
        !identity(marker.sourceMessageId))
    )
      throw new Refused('CLEANUP_ORIGINAL_SOURCE_UNPROVED');
  }
  const scopes = cleanupScopes ?? readLegacyActionSourceScopes(data as unknown as MaxActionJob);
  const bound = scopes.filter((scope) => identity(scope.chatId) && identity(scope.messageId));
  if (!bound.length) throw new Refused('ACTION_SOURCE_UNPROVED');
  const related = sources.filter((source) =>
    bound.some((scope) => scope.chatId === source.chatId && scope.messageId === source.messageId),
  );
  if (related.length > 1) throw new Refused('ACTION_SOURCE_AMBIGUOUS');
  if (!related.length) return null;
  const source = related[0]!;
  if (
    bound.some(
      (scope) =>
        scope.chatId === source.chatId &&
        scope.messageId === source.messageId &&
        scope.userId &&
        scope.userId !== source.userId,
    )
  )
    throw new Refused('ACTION_SUBJECT_CONFLICT');
  return {
    jobKey: data.idempotencyKey,
    queueName: '',
    jobPayloadDigest: sourceAbandonmentDigest(data),
    chatId: source.chatId,
    messageId: source.messageId,
    ...(source.userId !== null ? { userId: source.userId } : {}),
  };
}

export async function inventorySourceAbandonmentRedis(
  redis: SourceAbandonmentRedisReader,
  selection: SourceAbandonmentLiveSelection,
  sources: readonly SourceAbandonmentRedisSource[],
  allowance: SourceInventoryAllowance,
  resolve: SourceAbandonmentRedisResolver,
  queueFenceNonce?: string,
  publisherBotId?: string,
): Promise<{
  children: SourceAbandonmentChildEvidence[];
  stableDigest: string;
  cost: { pages: number; rows: number; probes: number; bytes: number };
  issues: Array<{ code: string; descriptor: string }>;
  sqlPlans: LegacyRecoveryLivePlanProof[];
  queueCounts: Array<{ queueName: string; states: number[] }>;
  catalog: SourceAbandonmentCatalogProof | null;
}> {
  const cost = { pages: 0, rows: 0, probes: 0, bytes: 0 };
  const children = new Map<string, SourceAbandonmentChildEvidence>();
  const proofs: unknown[] = [];
  const sqlPlans: LegacyRecoveryLivePlanProof[] = [];
  const issues: Array<{ code: string; descriptor: string }> = [];
  let catalog: SourceAbandonmentCatalogProof | null = null;
  let descriptor = 'redis:inventory';
  const check = () => {
    if (Date.now() >= allowance.deadlineAtMs) throw new Refused('REDIS_DEADLINE_EXCEEDED');
    for (const key of ['pages', 'rows', 'probes', 'bytes'] as const)
      if (!integer(cost[key]) || cost[key] > allowance[key])
        throw new Refused('REDIS_BUDGET_EXCEEDED');
  };
  const read = async (script: string, args: string[]) => {
    check();
    if (
      cost.pages >= allowance.pages ||
      allowance.bytes - cost.bytes < 64 * 1024 ||
      cost.probes >= allowance.probes
    )
      throw new Refused('REDIS_BUDGET_EXCEEDED');
    const reserveProbes =
      script === headerScript
        ? queueNames.length * 45 + 3
        : script === jobsScript
          ? 16 * 48 + 1
          : 64;
    if (allowance.probes - cost.probes < reserveProbes) throw new Refused('REDIS_BUDGET_EXCEEDED');
    let timer: ReturnType<typeof setTimeout> | undefined;
    let reply: unknown;
    try {
      reply = await Promise.race([
        redis.eval_ro(script, 0, ...args),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Refused('REDIS_DEADLINE_EXCEEDED')),
            Math.max(1, allowance.deadlineAtMs - Date.now()),
          );
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
    cost.pages++;
    const bytes = Buffer.byteLength(JSON.stringify(reply));
    cost.bytes += bytes;
    if (bytes > 64 * 1024 || !Array.isArray(reply) || reply[0] !== 1 || !integer(reply[1]))
      throw new Refused('REDIS_REPLY_UNPROVED');
    cost.probes += reply[1];
    check();
    return reply;
  };
  const resolveRows = async (kind: 'action' | 'observation', keys: readonly string[]) => {
    check();
    const uniqueKeys = [...new Set(keys)];
    if (!uniqueKeys.length || uniqueKeys.length > 16 || uniqueKeys.some((key) => !identity(key)))
      throw new Refused('SQL_BATCH_REPLY_UNPROVED');
    const result = await resolve(kind, uniqueKeys, {
      pages: allowance.pages - cost.pages,
      rows: allowance.rows - cost.rows,
      probes: allowance.probes - cost.probes,
      bytes: allowance.bytes - cost.bytes,
      deadlineAtMs: allowance.deadlineAtMs,
    });
    if (
      !record(result) ||
      !record(result.cost) ||
      (['pages', 'rows', 'probes', 'bytes'] as const).some(
        (field) => !integer(result.cost[field]),
      ) ||
      !Array.isArray(result.plans)
    )
      throw new Refused('SQL_BATCH_REPLY_UNPROVED');
    // FLAG: A refused SQL batch still spent its completed reads. Charge those
    // reads once before propagating the exact refusal into this inventory.
    for (const field of ['pages', 'rows', 'probes', 'bytes'] as const)
      cost[field] += result.cost[field];
    sqlPlans.push(...result.plans);
    if (result.issue !== null) {
      if (
        !record(result.issue) ||
        !identity(result.issue.code) ||
        !identity(result.issue.descriptor)
      )
        throw new Refused('SQL_BATCH_REPLY_UNPROVED');
      throw new Refused(result.issue.code, result.issue.descriptor);
    }
    check();
    if (
      !Array.isArray(result.rows) ||
      result.rows.length !== uniqueKeys.length ||
      new Set(result.rows.map((row) => row?.key)).size !== uniqueKeys.length ||
      result.rows.some(
        (row) =>
          !record(row) ||
          !uniqueKeys.includes(row.key) ||
          (row.row !== null && !record(row.row)) ||
          !/^[0-9a-f]{64}$/u.test(row.digest),
      )
    )
      throw new Refused('SQL_BATCH_REPLY_UNPROVED');
    return new Map(result.rows.map((row) => [row.key, row]));
  };
  const resolvedRow = (
    kind: 'action' | 'observation',
    key: string,
    rows: Awaited<ReturnType<typeof resolveRows>>,
  ) => {
    const result = rows.get(key);
    if (!result) throw new Refused('SQL_BATCH_REPLY_UNPROVED');
    proofs.push({ kind, keyDigest: sourceAbandonmentDigest(key), digest: result.digest });
    return result.row;
  };
  const addChild = (child: SourceAbandonmentChildEvidence) => {
    const key = `${child.queueName === SOURCE_ABANDONMENT_OBSERVATION_QUEUE ? 'observation' : 'action'}:${child.jobKey}`;
    const prior = children.get(key);
    if (prior && sourceAbandonmentDigest(prior) !== sourceAbandonmentDigest(child))
      throw new Refused('CHILD_IDENTITY_CONFLICT');
    children.set(key, child);
  };
  let queueCounts: Array<{ queueName: string; states: number[] }> = [];
  const collectCatalog = async () => {
    descriptor = 'redis:namespace-catalog';
    catalog = await inventorySourceAbandonmentNamespaces(redis, allowance.deadlineAtMs);
    if (!catalog.complete || catalog.issue)
      throw new Refused(catalog.issue ?? 'QUEUE_CATALOG_UNPROVED');
    check();
    return catalog;
  };
  try {
    assertSourceIdentities(sources);
    // FLAG: Live jobs can finish during the full census. Capture their current
    // state counts afterwards; stopped inventories retain fence/header bracketing.
    const onlineCatalog = queueFenceNonce ? null : await collectCatalog();
    descriptor = 'redis:inventory';
    const headerArgs = [
      JSON.stringify(queueNames),
      queueFenceNonce ? `rollout:${queueFenceNonce}` : '',
      queueFenceNonce ? 'offline' : 'online',
    ];
    const headers = (await read(headerScript, headerArgs))[2];
    if (!Array.isArray(headers) || headers.length !== queueNames.length)
      throw new Refused('QUEUE_CATALOG_UNPROVED');
    queueCounts = headers.map((row, index) => {
      if (
        !Array.isArray(row) ||
        row.length !== 13 ||
        row[0] !== queueNames[index] ||
        row.slice(4).some((n) => !integer(n))
      )
        throw new Refused('QUEUE_HEADER_UNPROVED');
      if (
        queueFenceNonce &&
        (row[6] !== 0 || (isLegacyRecoveryWebhookQueue(row[0]) && row[2] !== '1'))
      )
        throw new Refused('QUEUE_QUIESCENCE_UNPROVED');
      if ((actionQueues.has(row[0]) || row[0] === 'global-spammer-denorm') && row[12] !== 0)
        throw new Refused('ACTION_SCHEDULER_UNPROVED');
      return { queueName: row[0], states: row.slice(4, 12) as number[] };
    });
    const completeCatalog = onlineCatalog ?? (await collectCatalog());
    // FLAG: The collector separately requires both complete raw catalogs to match
    // within this inventory. Only the two independent Publisher auxiliary counts
    // may differ across reviewed inventories; every header/owner/effect stays exact.
    proofs.push({
      catalog: projectSourceAbandonmentNamespaceCounts(completeCatalog.namespaceKeyCounts),
      headers,
    });
    const selectedFound = new Set<string>();
    for (const queue of queueCounts) {
      descriptor = `redis:${queue.queueName}`;
      if (isLegacyRecoveryWebhookQueue(queue.queueName)) {
        let offset = 0;
        while (offset < selection.ownerWebhookEventIds.length) {
          const reply = await read(ownersScript, [
            `bull:${queue.queueName}:`,
            JSON.stringify(selection.ownerWebhookEventIds),
            String(offset),
            String(allowance.probes - cost.probes),
            String(Math.min(32, allowance.rows - cost.rows)),
          ]);
          if (
            !integer(reply[2]) ||
            reply[2] < 1 ||
            offset + reply[2] > selection.ownerWebhookEventIds.length
          )
            throw new Refused('OWNER_PAGE_UNPROVED');
          const jobs = decodeJobs(reply[3]);
          cost.rows += jobs.length;
          for (const job of jobs) {
            assertJobAncestry(job);
            const data = record(job.data);
            if (
              !selection.ownerWebhookEventIds.slice(offset, offset + reply[2]).includes(job.id) ||
              !data ||
              Object.keys(data).length !== 1 ||
              data.webhookEventId !== job.id ||
              selectedFound.has(job.id)
            )
              throw new Refused('OWNER_JOB_UNPROVED');
            selectedFound.add(job.id);
          }
          proofs.push({ queue: queue.queueName, owners: jobs });
          offset += reply[2];
          check();
        }
        continue;
      }
      if (!actionQueues.has(queue.queueName) && queue.queueName !== 'global-spammer-denorm')
        continue;
      const seen = new Set<string>();
      for (let index = 0; index < 6; index++) {
        const state = LEGACY_RECOVERY_LIVE_QUEUE_STATES[index]!;
        const count = queue.states[index]!;
        let offset = 0;
        while (offset < count) {
          const take = Math.min(16, count - offset, allowance.rows - cost.rows);
          if (take < 1) throw new Refused('REDIS_BUDGET_EXCEEDED');
          const reply = await read(jobsScript, [
            `bull:${queue.queueName}:`,
            state,
            String(offset),
            String(take),
          ]);
          const jobs = decodeJobs(reply[3]);
          if (
            reply[2] !== jobs.length ||
            !jobs.length ||
            jobs.length > take ||
            offset + jobs.length > count
          )
            throw new Refused('ACTION_PAGE_UNPROVED');
          cost.rows += jobs.length;
          check();
          const page = jobs.map((job) => {
            if (seen.has(job.id)) throw new Refused('ACTION_MULTIPLE_STATES');
            seen.add(job.id);
            assertJobAncestry(job);
            const data = record(job.data);
            if (!data) throw new Refused('ACTION_PAYLOAD_UNPROVED');
            const key = actionQueues.has(queue.queueName)
              ? data.idempotencyKey
              : data.observationId;
            if (!identity(key))
              throw new Refused(
                actionQueues.has(queue.queueName)
                  ? 'ACTION_KEY_UNPROVED'
                  : 'OBSERVATION_JOB_SOURCE_UNPROVED',
              );
            return { job, data, key };
          });
          // FLAG: These maps belong only to this exact Redis page. Every later
          // page and independent inventory rereads all required SQL facts.
          if (actionQueues.has(queue.queueName)) {
            const ownRows = await resolveRows(
              'action',
              page.map(({ key }) => key),
            );
            const actions = page.map(({ job, data, key }) => {
              const ledger = ownRows.get(key)!.row;
              if (
                ledger &&
                (ledger.jobId !== data.idempotencyKey ||
                  ledger.chatId !== data.chatId ||
                  ledger.actionType !== data.actionType ||
                  (ledger.messageId !== null &&
                    ledger.messageId !== undefined &&
                    ledger.messageId !== data.messageId) ||
                  (ledger.userId !== null &&
                    ledger.userId !== undefined &&
                    ledger.userId !== data.userId))
              )
                throw new Refused('ACTION_LEDGER_IDENTITY_CONFLICT');
              // FLAG: Already fenced history remains untouched and never becomes a child
              // attribution or a successful outcome merely because the source is abandoned.
              if (
                ledger &&
                ((['BAN_MEMBER', 'KICK_MEMBER', 'TRY_UNBAN_MEMBER'].includes(
                  String(data.actionType),
                ) &&
                  (ledger.ambiguous === true || ledger.status === 'IN_PROGRESS')) ||
                  (ledger.ambiguous === true &&
                    ledger.terminal === true &&
                    ledger.status === 'AMBIGUOUS' &&
                    (data.actionType !== 'SEND_MESSAGE' || ledger.remoteMessageId == null)))
              )
                return { job, data, key, skipped: true, cleanupParentKey: null };
              return {
                job,
                data,
                key,
                skipped: false,
                cleanupParentKey: sourceAbandonmentCleanupParentKey(data),
              };
            });
            const parentKeys = actions.flatMap(({ cleanupParentKey }) =>
              cleanupParentKey ? [cleanupParentKey] : [],
            );
            const parentRows = parentKeys.length
              ? await resolveRows('action', parentKeys)
              : new Map<string, SourceAbandonmentResolvedRow>();
            for (const { job, key, skipped, cleanupParentKey } of actions) {
              resolvedRow('action', key, ownRows);
              if (skipped) continue;
              const cleanupParent = cleanupParentKey
                ? {
                    ledger: resolvedRow('action', cleanupParentKey, parentRows),
                    majorBotIds: selection.majorBotIds,
                    ...(publisherBotId ? { publisherBotId } : {}),
                  }
                : undefined;
              const child = classifySourceAbandonmentAction(job, sources, cleanupParent);
              if (child) addChild({ ...child, queueName: queue.queueName });
            }
          } else {
            const observations = await resolveRows(
              'observation',
              page.map(({ key }) => key),
            );
            for (const { data, key } of page) {
              const observation = resolvedRow('observation', key, observations);
              if (isUnrelatedSourceAbandonmentFanoutObservation(data, observation, sources))
                continue;
              if (
                !observation ||
                !identity(observation.chatId) ||
                !identity(observation.messageId) ||
                !identity(observation.userId) ||
                data.userId !== observation.userId
              )
                throw new Refused('OBSERVATION_SOURCE_UNPROVED');
              const related = sources.filter(
                (source) =>
                  source.chatId === observation.chatId &&
                  source.messageId === observation.messageId,
              );
              if (related.length > 1 || (related[0] && related[0].userId !== observation.userId))
                throw new Refused('OBSERVATION_SOURCE_CONFLICT');
              if (related[0])
                addChild({
                  jobKey: key,
                  queueName: SOURCE_ABANDONMENT_OBSERVATION_QUEUE,
                  jobPayloadDigest: sourceAbandonmentDigest(observation),
                  chatId: related[0].chatId,
                  messageId: related[0].messageId,
                  userId: observation.userId,
                });
            }
          }
          proofs.push({ queue: queue.queueName, state, jobs });
          offset += jobs.length;
        }
      }
    }
    if (
      queueFenceNonce &&
      sourceAbandonmentDigest((await read(headerScript, headerArgs))[2]) !==
        sourceAbandonmentDigest(headers)
    )
      throw new Refused('QUEUE_HEADERS_CHANGED');
  } catch (error) {
    issues.push({
      code: error instanceof Refused ? error.code : 'REDIS_STORE_OR_SOURCE_REFUSED',
      descriptor: error instanceof Refused ? (error.descriptor ?? descriptor) : descriptor,
    });
  }
  return {
    children: [...children.values()].sort(
      (a, b) => a.queueName.localeCompare(b.queueName) || a.jobKey.localeCompare(b.jobKey),
    ),
    stableDigest: sourceAbandonmentDigest(proofs),
    cost,
    issues,
    sqlPlans,
    queueCounts,
    catalog,
  };
}
