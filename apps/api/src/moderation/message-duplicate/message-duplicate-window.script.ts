import { DUPLICATE_WINDOW_MAX_SEC } from '@maxim/contracts/settings';

export const MESSAGE_DUPLICATE_HISTORY_STORAGE_VERSION = 'v4';
export const MESSAGE_DUPLICATE_HISTORY_FENCE_STORAGE_VERSION = 'v3';
// FLAG: Ten-minute action authority and one-minute accepted future skew fit inside the
// retention grace. Stored proof outlives its window without extending action authority.
export const MESSAGE_DUPLICATE_HISTORY_GRACE_MS = 11 * 60_000;
export const MESSAGE_DUPLICATE_HISTORY_RETENTION_MS =
  DUPLICATE_WINDOW_MAX_SEC * 1000 + MESSAGE_DUPLICATE_HISTORY_GRACE_MS;

// FLAG: Duplicate windows are anchored to an accepted original. Rejected attempts never
// become evidence or extend its lifetime. This script is intentionally separate from burst
// and quota rolling counters. Work is bounded by 128 fingerprints and constant-size records.
export const MESSAGE_DUPLICATE_WINDOW_SCRIPT = `
local p = cjson.decode(ARGV[1])
local prefix = KEYS[1] .. '${MESSAGE_DUPLICATE_HISTORY_STORAGE_VERSION}:'
-- FLAG: New positive history discards incorrect envelope publication clocks. Existing
-- removal/reset evidence remains authoritative, including future-dated old incarnations.
local resetPrefix = KEYS[1] .. '${MESSAGE_DUPLICATE_HISTORY_FENCE_STORAGE_VERSION}:'
local clock = redis.call('TIME')
local now = tonumber(clock[1]) * 1000 + math.floor(tonumber(clock[2]) / 1000)
if now > p.deadline then return cjson.encode({ kind = 'deadline_exceeded' }) end
local retentionMs = ${MESSAGE_DUPLICATE_HISTORY_RETENTION_MS}
local graceMs = ${MESSAGE_DUPLICATE_HISTORY_GRACE_MS}
if p.windowMs then p.windowMs = math.min(p.windowMs, ${DUPLICATE_WINDOW_MAX_SEC * 1000}) end
local function read(key)
  local namespace = string.sub(key, 1, 8) == 'removed:' and resetPrefix or prefix
  local raw = redis.call('GET', namespace .. key)
  if raw then return cjson.decode(raw) end
  return nil
end
local function eventExpiry(at)
  return math.min(at and at > 0 and at or now, now) + retentionMs
end
local function windowExpiry(at)
  -- FLAG: Message/qualification proof follows its own configured window. Keeping the
  -- full ceiling here would increase ordinary short-window history instead of bounding it.
  return math.min(at and at > 0 and at or now, now) + math.min((p.windowMs or 0) + graceMs, retentionMs)
end
local function write(key, value, expiresAt, preserveExpiry)
  -- FLAG: An event/accepted-original anchor owns expiry. Replay and qualification cannot
  -- turn proof into a sliding lease; accepted future timestamps never exceed the ceiling.
  local expiry = math.min(expiresAt or (now + retentionMs), now + retentionMs)
  if preserveExpiry then
    local previousExpiry = redis.call('PEXPIRETIME', prefix .. key)
    if previousExpiry > now then expiry = math.min(expiry, previousExpiry) end
  end
  local namespace = string.sub(key, 1, 8) == 'removed:' and resetPrefix or prefix
  redis.call('SET', namespace .. key, cjson.encode(value), 'PXAT', expiry)
end
local function epoch(author)
  local raw = redis.call('GET', resetPrefix .. 'reset:' .. author)
  return raw and cjson.decode(raw) or 0
end
if p.op == 'reset' then
  -- FLAG: Reset/removal fences live at least as long as every pre-fence record in v3.
  -- Never read old v2 proof or its unversioned reset key after shortening retention.
  redis.call('SET', resetPrefix .. 'reset:' .. p.author, cjson.encode(math.max(now, epoch(p.author) + 1)), 'PXAT', now + retentionMs)
  return cjson.encode({ kind = 'ok' })
end
if p.op == 'remove' then
  if not read('removed:' .. p.member) then write('removed:' .. p.member, true) end
  return cjson.encode({ kind = 'ok' })
end
local function lifecycle(member, mode, at, source, publishedAt, previous)
  local key = 'life:' .. member .. ':' .. mode
  if not previous then
    local raw = redis.call('GET', resetPrefix .. key)
    local prior = raw and cjson.decode(raw) or nil
    -- FLAG: A history upgrade must retain stale/conflicting and unknown-time refusals.
    -- Only a later observed source change supplies a new introduction time; old positive
    -- publication clocks, revisions and counters never become current evidence.
    if prior then
      if at < prior.at or (at == prior.at and (prior.conflict or prior.source ~= source)) then return nil end
      if prior.source ~= source then
        publishedAt = at
      elseif prior.introducedKnown == false then
        previous = { at = prior.at, source = prior.source, conflict = prior.conflict,
          revision = p.token, introducedAt = 0, introducedKnown = false }
      end
    end
  end
  if previous and at < previous.at then return nil end
  if previous and at == previous.at then
    if previous.source ~= source then
      previous.conflict = true
      previous.predecessorRevision = nil
      previous.revision = p.token
      write(key, previous, eventExpiry(previous.at), true)
    end
    return not previous.conflict and previous or nil
  end
  local changed = not previous or previous.source ~= source
  local life = {
    at = at, source = source, conflict = false,
    revision = previous and not changed and not previous.conflict and previous.revision or p.token,
    introducedAt = changed and at or (previous and previous.introducedAt or at),
    introducedKnown = changed or (previous and previous.introducedKnown or false),
    predecessorRevision = previous and (changed and not previous.conflict and previous.revision or (not changed and previous.predecessorRevision or nil)) or nil,
    materializedRevision = previous and previous.materializedRevision or nil,
    materialized = previous and previous.materialized or nil,
  }
  if not previous then
    life.introducedAt = publishedAt or at
    life.introducedKnown = true
  end
  write(key, life, eventExpiry(life.at))
  return life
end
if p.op == 'lifecycle' then
  for mode, source in pairs(p.sources) do
    lifecycle(p.member, mode, p.at, source, p.publishedAt, read('life:' .. p.member .. ':' .. mode))
  end
  return cjson.encode({ kind = 'ok' })
end
if p.op == 'invalidate' then
  for mode, source in pairs(p.sources) do
    local key = 'life:' .. p.member .. ':' .. mode
    local previous = read(key)
    if not previous then
      local raw = redis.call('GET', resetPrefix .. key)
      if raw then previous = cjson.decode(raw) end
    end
    if not previous or previous.source ~= source then
      write(key, { at = previous and previous.at or 0, source = source, conflict = true,
        revision = p.token, introducedAt = 0, introducedKnown = false,
        materializedRevision = previous and previous.materializedRevision or nil,
        materialized = previous and previous.materialized or nil }, eventExpiry(previous and previous.at or now), true)
    end
  end
  return cjson.encode({ kind = 'ok' })
end
local function stateKey(member) return 'message:' .. member .. ':' .. p.mode end
local function valid(evidence)
  if not evidence or not evidence.revision or not evidence.originalId or read('removed:' .. evidence.member) then return false end
  if epoch(evidence.author) ~= evidence.epoch then return false end
  local life = read('life:' .. evidence.member .. ':' .. p.mode)
  if not life or life.conflict or life.source ~= evidence.sourceDigest or life.revision ~= evidence.revision then return false end
  local state = read(stateKey(evidence.member))
  return state and state.epoch == evidence.epoch and state.source == evidence.sourceDigest
    and state.identity == evidence.contentDigest and state.revision == evidence.revision
    and state.originalId == evidence.originalId and state.publishedAt == evidence.publishedAtMs
end
local function groupKey(fingerprint) return 'group:' .. p.scope .. ':' .. fingerprint end
local function counterKey(fingerprint, original)
  return 'count:' .. p.author .. ':' .. fingerprint .. ':' .. original.originalId
    .. ':' .. original.epoch .. ':' .. epoch(p.author)
end
-- FLAG: Candidate pointers are not accepted originals. This bounded read requires
-- the same live lifecycle, reset epoch and immutable publication window as dispatch.
if p.op == 'image_anchor' then
  local original = read(groupKey(p.fingerprint))
  if p.mode ~= 'IMAGE' or not valid(original) or p.at < original.publishedAtMs
    or p.at >= original.expiresAtMs
    or (p.periodStart and original.publishedAtMs < p.periodStart) then
    return cjson.encode({ kind = 'stale' })
  end
  return cjson.encode({ kind = 'ok', original = original })
end
local function matching()
  if p.at <= epoch(p.author) then return nil end
  if read('removed:' .. p.member) and not p.afterDelete then return nil end
  local state = read(stateKey(p.member))
  if not p.revision or not state or state.revision ~= p.revision or state.at ~= p.at or state.epoch ~= epoch(p.author) or state.source ~= p.source
    or state.identity ~= p.identity then return nil end
  local life = read('life:' .. p.member .. ':' .. p.mode)
  if not life or life.conflict or life.source ~= p.source or life.revision ~= p.revision then return nil end
  for _, match in ipairs(state.matches or {}) do
    if match.fingerprint == p.fingerprint and match.original.member == p.original.member
      and match.original.member ~= p.member
      and match.original.originalId == p.original.originalId and match.original.revision == p.original.revision
      and match.original.epoch == p.original.epoch and valid(match.original)
      and p.at >= match.original.publishedAtMs and p.at < match.original.expiresAtMs then
      return match, state
    end
  end
  return nil
end
if p.op == 'check' or p.op == 'qualify' then
  local match, state = matching()
  if not match then return cjson.encode({ kind = 'stale' }) end
  if p.op == 'check' then return cjson.encode({ kind = 'ok', count = match.qualified or match.count, qualified = match.qualified }) end
  if not match.qualified then
    local qualificationKey = 'qualification:' .. p.member
    local qualification = read(qualificationKey)
    if qualification and qualification.epoch == epoch(p.author) then return cjson.encode({ kind = 'stale' }) end
    local key = counterKey(p.fingerprint, match.original)
    local count = read(key) or { accepted = p.allowed, qualified = 0 }
    count.qualified = math.min(20 - p.allowed, count.qualified + 1)
    write(key, count, match.original.expiresAtMs + graceMs, true)
    match.qualified = math.min(20, p.allowed + count.qualified)
    write(qualificationKey, { epoch = epoch(p.author) }, windowExpiry(state.at), true)
    write(stateKey(p.member), state, windowExpiry(state.at), true)
  end
  return cjson.encode({ kind = 'ok', count = match.qualified })
end
if p.op ~= 'observe' then return cjson.encode({ kind = 'stale' }) end
if read('removed:' .. p.member) or p.at <= epoch(p.author) then return cjson.encode({ kind = 'stale' }) end
-- FLAG: Approximate equality cannot establish a new original. Pin its accepted anchor
-- atomically before lifecycle/counter writes, including a removal or reset during decoding.
if p.recompressionOriginal then
  local expected = p.recompressionOriginal
  if p.mode ~= 'IMAGE' or #p.fingerprints ~= 1 then return cjson.encode({ kind = 'stale' }) end
  local original = read(groupKey(p.fingerprints[1]))
  if not valid(original) or original.member ~= expected.member
    or original.revision ~= expected.revision or original.originalId ~= expected.originalId
    or original.epoch ~= expected.epoch or original.contentDigest ~= expected.contentDigest
    or p.at < original.publishedAtMs or p.at >= original.expiresAtMs
    or (p.periodStart and original.publishedAtMs < p.periodStart) then
    return cjson.encode({ kind = 'stale' })
  end
end
local previous = read(stateKey(p.member))
local currentEpoch = epoch(p.author)
local previousLife = read('life:' .. p.member .. ':' .. p.mode)
local priorLife = nil
if (not previousLife or not previousLife.materializedRevision) and currentEpoch ~= 0 then
  local raw = redis.call('GET', resetPrefix .. 'life:' .. p.member .. ':' .. p.mode)
  if raw then priorLife = cjson.decode(raw) end
end
-- FLAG: The old incarnation is negative reset evidence only; never reuse its publication
-- time, equality, matches or revision as positive v4 history.
local materialized = previousLife and previousLife.materialized or (priorLife and priorLife.materialized or nil)
if not materialized and previous then
  materialized = { epoch = previous.epoch, at = previous.at, source = previous.source, identity = previous.identity }
end
local resetIncarnation = materialized and materialized.epoch ~= currentEpoch
-- FLAG: Reset revokes an incarnation, including accepted future-dated events. A newer
-- date or locator with unchanged/unverified bytes cannot admit its old content again.
-- Lifecycle provenance survives loss of the shorter-lived message state.
if resetIncarnation and (p.at <= materialized.at or p.identity == '' or not materialized.identity
  or materialized.identity == '' or p.identity == materialized.identity) then
  return cjson.encode({ kind = 'stale' })
end
if not materialized and ((previousLife and previousLife.materializedRevision) or (priorLife and priorLife.materializedRevision)) and currentEpoch ~= 0 then
  return cjson.encode({ kind = 'stale' })
end
-- FLAG: A synthetic pending replay cannot replace proof for this exact event. Newer
-- incomplete content still invalidates the old revision before an early return.
if previous and previous.epoch == currentEpoch and p.at == previous.at and p.source == previous.source and p.identity == '' then
  local life = previousLife
  if life and not life.conflict and life.revision == previous.revision and life.source == previous.source then
    return cjson.encode({ kind = 'replayed', matches = previous.matches, observedAt = previous.at, revision = previous.revision })
  end
end
local life = lifecycle(p.member, p.mode, p.at, p.lifecycleSource or p.source, p.publishedAt, previousLife)
if not life then return cjson.encode({ kind = 'stale' }) end
if resetIncarnation then
  -- FLAG: Only a proved later content change may introduce another incarnation after
  -- reset. Unknown-time replacements retain their fail-closed introduction boundary.
  if not life.introducedKnown then return cjson.encode({ kind = 'stale' }) end
  if life.source == materialized.source or priorLife then life.introducedAt = p.at end
  if life.introducedAt <= currentEpoch then return cjson.encode({ kind = 'stale' }) end
  life.revision = p.token
  life.predecessorRevision = nil
end
if not previous and life.materializedRevision then
  -- FLAG: Reconstructing missing evidence is a new incarnation. A surviving lifecycle
  -- record must not give an old binding authority over newly reconstructed message state.
  life.revision = p.token
  life.predecessorRevision = nil
end
if previous and previous.epoch == currentEpoch then
  if p.at < previous.at then return cjson.encode({ kind = 'stale' }) end
  if previous.context == p.context and previous.revision == life.revision and previous.source == p.source and (previous.identity == p.identity or (p.identity == '' and p.pendingSafe)) then
    return cjson.encode({ kind = 'replayed', matches = previous.matches, observedAt = previous.at, revision = previous.revision })
  end
  if previous.revision == life.revision and previous.identity ~= '' and p.identity ~= '' and previous.identity ~= p.identity then
    -- FLAG: Reused source IDs do not prove unchanged bytes. Independent proof of a
    -- different identity revokes the previous revision even when its locator is unchanged.
    life.revision = p.token
    life.predecessorRevision = nil
    life.introducedAt = p.at
    life.introducedKnown = true
    write('life:' .. p.member .. ':' .. p.mode, life, eventExpiry(life.at), true)
  end
end
local publishedAt = life.introducedAt
local originalId = previous and previous.revision == life.revision and previous.originalId or p.token
local continuity = nil
if previous and previous.epoch == currentEpoch and previous.source ~= p.source and previous.identity ~= '' and previous.revision == life.predecessorRevision then
  continuity = { revision = previous.revision, identity = previous.identity,
    publishedAt = previous.publishedAt, originalId = previous.originalId, context = previous.context,
    accepted = previous.accepted, matches = previous.matches }
elseif previous and previous.epoch == currentEpoch and previous.revision == life.revision and previous.continuity and previous.continuity.revision == life.predecessorRevision then
  continuity = previous.continuity
end
local verifiedContinuity = continuity and p.identity ~= '' and p.identity == continuity.identity and life.introducedKnown and life.source == p.source
local preserveOccurrences = verifiedContinuity and continuity.context == p.context
if verifiedContinuity then
  -- FLAG: Only one observed locator transition plus independently equal content can
  -- retain an original's counter/window. An intermediate transition loses this proof.
  publishedAt = continuity.publishedAt
  originalId = continuity.originalId
  life.introducedAt = publishedAt
  write('life:' .. p.member .. ':' .. p.mode, life, eventExpiry(life.at), true)
end
local accepted = {}
if preserveOccurrences then
  for _, fingerprint in ipairs(p.fingerprints) do
    if continuity.accepted and continuity.accepted[fingerprint] then accepted[fingerprint] = true end
  end
end
local state = { at = p.at, publishedAt = publishedAt, source = p.source, identity = p.identity, context = p.context,
  epoch = currentEpoch, revision = life.revision, originalId = originalId,
  accepted = accepted, matches = {} }
if p.identity == '' and p.pendingSafe and continuity and life.source == p.source then state.continuity = continuity end
life.materializedRevision = life.revision
life.materialized = { epoch = currentEpoch, at = p.at, source = p.source, identity = p.identity }
write('life:' .. p.member .. ':' .. p.mode, life, eventExpiry(life.at), true)
write(stateKey(p.member), state, windowExpiry(state.at))
if p.identity == '' or not life.introducedKnown then return cjson.encode({ kind = 'ok', matches = {}, revision = life.revision }) end
-- FLAG: An old post edited without a content change must never become today's original.
if p.periodStart and (publishedAt < p.periodStart or publishedAt >= p.periodEnd) then
  return cjson.encode({ kind = 'ok', matches = {} })
end
local writes = {}
local newlyAccepted = {}
for _, fingerprint in ipairs(p.fingerprints) do
  local key = groupKey(fingerprint)
  local original = read(key)
  if not valid(original) or (p.periodStart and original.publishedAtMs < p.periodStart) then original = nil end
  if not original or publishedAt >= original.expiresAtMs then
    -- FLAG: An old edit or delayed observation cannot start a fresh window at processing time.
    -- The publication clock is immutable, including for a newly verified media baseline.
    local expiresAt = p.periodEnd or (publishedAt + p.windowMs)
    if expiresAt > p.at then
      original = { member = p.member, author = p.author, messageId = p.messageId,
        senderId = p.senderId, publishedAtMs = publishedAt, observedAtMs = p.at,
        expiresAtMs = expiresAt, sourceDigest = p.source,
        contentDigest = p.identity, mediaHashes = p.mediaHashes, epoch = currentEpoch,
        revision = life.revision, originalId = originalId }
      table.insert(writes, { key = key, value = original, expiresAt = original.expiresAtMs + graceMs })
    end
  -- FLAG: MAX timestamps may have second precision. Different members published at the
  -- same timestamp are real occurrences; replay of the accepted original is never one.
  elseif original.member ~= p.member and publishedAt >= original.publishedAtMs and p.at < original.expiresAtMs then
    local counter = counterKey(fingerprint, original)
    local count = read(counter) or { accepted = 0, qualified = 0 }
    if state.accepted[fingerprint] then
      -- FLAG: Independently unchanged content remains the same accepted occurrence.
    elseif count.accepted < p.allowed then
      count.accepted = count.accepted + 1
      newlyAccepted[fingerprint] = true
      table.insert(writes, { key = counter, value = count, expiresAt = original.expiresAtMs + graceMs, preserveExpiry = true })
    else
      local snapshot = nil
      if preserveOccurrences then
        for _, match in ipairs(continuity.matches or {}) do
          if match.fingerprint == fingerprint and match.original.originalId == original.originalId and match.original.revision == original.revision then snapshot = match end
        end
      end
      table.insert(state.matches, snapshot or { fingerprint = fingerprint, original = original,
        count = math.min(20, p.allowed + count.qualified + 1) })
    end
  end
end
if #state.matches == 0 then
  for _, entry in ipairs(writes) do write(entry.key, entry.value, entry.expiresAt, entry.preserveExpiry) end
  for fingerprint, _ in pairs(newlyAccepted) do state.accepted[fingerprint] = true end
end
write(stateKey(p.member), state, windowExpiry(state.at), true)
return cjson.encode({ kind = 'ok', matches = state.matches, observedAt = state.at, revision = state.revision })
`;

export type DuplicateWindowOriginal = {
  member: string;
  author: string;
  messageId: string;
  senderId: string;
  publishedAtMs: number;
  observedAtMs: number;
  expiresAtMs: number;
  sourceDigest: string;
  contentDigest: string;
  mediaHashes: string[];
  epoch: number;
  revision: string;
  originalId: string;
};

export type DuplicateWindowResult = {
  kind: 'ok' | 'replayed' | 'stale' | 'deadline_exceeded';
  count?: number;
  qualified?: number;
  observedAt?: number;
  revision?: string;
  original?: DuplicateWindowOriginal;
  matches?: {
    fingerprint: string;
    original: DuplicateWindowOriginal;
    count: number;
    qualified?: number;
  }[];
};
