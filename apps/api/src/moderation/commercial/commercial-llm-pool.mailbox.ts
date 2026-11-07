import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as pause } from 'node:timers/promises';
import type Redis from 'ioredis';
import {
  CommercialLlmError,
  parseCommercialLlmEnvelope,
  type CommercialLlmResponseIssue,
} from './commercial-llm.client';
import { buildCommercialLlmRequest } from './commercial-llm.protocol';
import {
  COMMERCIAL_LLM_POOL_HEARTBEAT_MS,
  COMMERCIAL_LLM_POOL_LEASE_MS,
  COMMERCIAL_LLM_POOL_PROFILES,
  COMMERCIAL_LLM_POOL_REQUEST_BYTES,
  COMMERCIAL_LLM_POOL_RESPONSE_BYTES,
  COMMERCIAL_LLM_POOL_TIMEOUT_MS,
  POOL_NODE_IDS,
  POOL_PENDING_KEYS,
  POOL_DISPATCH_PENDING_KEY,
  POOL_ADMISSION_WORKER_KEY,
  commercialLlmPoolIdentityMatches,
  commercialLlmPoolJobKey,
  commercialLlmPoolMinRemainingMs,
  commercialLlmPoolNodeKeys,
  type CommercialLlmPoolNodeId,
} from './commercial-llm-pool.protocol';

type Store = Pick<Redis, 'eval' | 'get' | 'mget'>;
export type CommercialLlmPoolReservation = Readonly<{
  nodeId: CommercialLlmPoolNodeId;
  session: string;
  id: string;
  attemptId: string;
  jobId: string;
  attempt: 1 | 2;
  deadlineAtMs: number;
  body: string;
  raw: string;
}>;
export type CommercialLlmPoolRequest = { id: string; body: string; remainingMs: number };
export type CommercialLlmPoolOutcome =
  | { outcome: 'COMPLETE'; body: string }
  | { outcome: 'UNAVAILABLE' | 'TIMEOUT' }
  | { outcome: 'FAILED'; responseIssue?: CommercialLlmResponseIssue };
const tokenPattern = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u;
const decodeLua = `local function decode(raw)
  if not raw then return nil end
  local ok, value = pcall(cjson.decode, raw)
  if ok and type(value) == 'table' then return value end
  return nil
end
local function nowMs()
  local t = redis.call('TIME'); return t[1] * 1000 + math.floor(t[2] / 1000)
end
local function same(value, id, session)
  return value and value.id == id and value.session == session
end
`;

function record(raw: string | null, limit = 65536): Record<string, unknown> | null {
  if (!raw || Buffer.byteLength(raw) > limit) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  return (
    '{' +
    Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => JSON.stringify(key) + ':' + canonical(item))
      .join(',') +
    '}'
  );
}

function payloadDigest(nodeId: CommercialLlmPoolNodeId, body: string): string {
  if (typeof body !== 'string' || Buffer.byteLength(body) > COMMERCIAL_LLM_POOL_REQUEST_BYTES)
    throw new Error('pool_request_refused');
  const parsed = record(body, COMMERCIAL_LLM_POOL_REQUEST_BYTES);
  const messages = parsed?.messages;
  const user: unknown = Array.isArray(messages) ? messages[1] : null;
  const userRecord =
    user && typeof user === 'object' && !Array.isArray(user)
      ? (user as Record<string, unknown>)
      : null;
  const input =
    userRecord && typeof userRecord.content === 'string' ? record(userRecord.content) : null;
  if (!input || typeof input.message !== 'string' || Object.keys(input).length !== 1)
    throw new Error('pool_request_refused');
  const expected = {
    ...buildCommercialLlmRequest(input.message),
    model: COMMERCIAL_LLM_POOL_PROFILES[nodeId].identity.modelAlias,
  };
  if (canonical(parsed) !== canonical(expected)) throw new Error('pool_request_refused');
  // FLAG: A retry may change model/node but never the prompt, source text, grammar or budget.
  return createHash('sha256')
    .update(canonical({ ...expected, model: 'pool-selected-model' }))
    .digest('hex');
}

export class CommercialLlmPoolMailbox {
  constructor(
    private readonly redis: Store,
    private readonly pendingKeys: readonly string[] = POOL_PENDING_KEYS,
  ) {
    if (
      pendingKeys.length !== 2 ||
      new Set(pendingKeys).size !== 2 ||
      pendingKeys.some((key) => !POOL_PENDING_KEYS.some((expected) => expected === key))
    )
      throw new Error('pool_pending_keys_refused');
  }

  async acquireWorker(nodeId: CommercialLlmPoolNodeId, session: string): Promise<boolean> {
    if (!tokenPattern.test(session)) throw new Error('pool_session_refused');
    const keys = commercialLlmPoolNodeKeys(nodeId);
    return (
      (await this.redis.eval(
        `local owner = redis.call('GET', KEYS[1])
         if owner then return owner == ARGV[1] and 1 or 0 end
         redis.call('SET', KEYS[1], ARGV[1], 'PX', ARGV[2]); return 1`,
        1,
        keys.lease,
        session,
        COMMERCIAL_LLM_POOL_LEASE_MS,
      )) === 1
    );
  }

  async refreshWorker(
    nodeId: CommercialLlmPoolNodeId,
    session: string,
    ready: boolean,
  ): Promise<CommercialLlmPoolRequest | null> {
    const keys = commercialLlmPoolNodeKeys(nodeId);
    if (!tokenPattern.test(session) || typeof ready !== 'boolean')
      throw new Error('pool_session_refused');
    const value = await this.redis.eval(
      `${decodeLua}
       if redis.call('GET', KEYS[1]) ~= ARGV[1] then return nil end
       redis.call('PEXPIRE', KEYS[1], ARGV[2])
       redis.call('SET', KEYS[2], ARGV[3], 'PX', ARGV[4])
       local raw = redis.call('GET', KEYS[3]); local slot = decode(raw)
       if slot and slot.session == ARGV[1] then return {raw, redis.call('PTTL', KEYS[3])} end
       return {'', 0}`,
      3,
      keys.lease,
      keys.heartbeat,
      keys.slot,
      session,
      COMMERCIAL_LLM_POOL_LEASE_MS,
      JSON.stringify({
        nodeId,
        session,
        ready,
        identity: COMMERCIAL_LLM_POOL_PROFILES[nodeId].identity,
      }),
      COMMERCIAL_LLM_POOL_HEARTBEAT_MS,
    );
    if (!Array.isArray(value)) throw new Error('pool_session_lost');
    const slot = record(String(value[0] ?? ''));
    if (!slot) return null;
    const remainingMs = Number(value[1]);
    if (
      slot.nodeId !== nodeId ||
      slot.session !== session ||
      typeof slot.id !== 'string' ||
      !tokenPattern.test(slot.id) ||
      typeof slot.body !== 'string' ||
      Buffer.byteLength(slot.body) > COMMERCIAL_LLM_POOL_REQUEST_BYTES ||
      !Number.isSafeInteger(remainingMs) ||
      remainingMs <= 0 ||
      remainingMs > COMMERCIAL_LLM_POOL_TIMEOUT_MS
    )
      throw new Error('pool_slot_refused');
    return { id: slot.id, body: slot.body, remainingMs };
  }

  async releaseWorker(nodeId: CommercialLlmPoolNodeId, session: string): Promise<void> {
    const keys = commercialLlmPoolNodeKeys(nodeId);
    await this.redis.eval(
      `${decodeLua}
       if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
       redis.call('DEL', KEYS[1])
       for i = 2, #KEYS do
         local value = decode(redis.call('GET', KEYS[i]))
         if value and value.session == ARGV[1] then redis.call('DEL', KEYS[i]) end
       end
       return 1`,
      4,
      keys.lease,
      keys.heartbeat,
      keys.slot,
      keys.response,
      session,
    );
  }

  async available(): Promise<CommercialLlmPoolNodeId[]> {
    const keys = POOL_NODE_IDS.flatMap((id) => {
      const node = commercialLlmPoolNodeKeys(id);
      return [node.lease, node.heartbeat, node.slot];
    });
    const values = await this.redis.mget(...keys);
    return POOL_NODE_IDS.filter((nodeId, index) => {
      const [session, raw, slotRaw] = values.slice(index * 3, index * 3 + 3);
      const heartbeat = record(raw, 4096);
      const slot = record(slotRaw);
      return (
        !!session &&
        heartbeat?.session === session &&
        heartbeat.nodeId === nodeId &&
        heartbeat.ready === true &&
        commercialLlmPoolIdentityMatches(nodeId, heartbeat.identity) &&
        (!slotRaw || (slot !== null && slot.session !== session))
      );
    });
  }

  async reserve(
    nodeId: CommercialLlmPoolNodeId,
    request: { jobId: string; attempt: 1 | 2; deadlineAtMs: number; body: string },
    options: { consultation?: boolean } = {},
  ): Promise<CommercialLlmPoolReservation | null> {
    const keys = commercialLlmPoolNodeKeys(nodeId);
    const jobKey = commercialLlmPoolJobKey(request.jobId);
    if (![1, 2].includes(request.attempt) || !Number.isSafeInteger(request.deadlineAtMs))
      throw new Error('pool_attempt_refused');
    if (options.consultation && COMMERCIAL_LLM_POOL_PROFILES[nodeId].model !== '9b')
      throw new Error('pool_consultation_refused');
    const payloadSha256 = payloadDigest(nodeId, request.body);
    const [session, heartbeatRaw] = await this.redis.mget(keys.lease, keys.heartbeat);
    const heartbeat = record(heartbeatRaw, 4096);
    if (
      !session ||
      !tokenPattern.test(session) ||
      heartbeat?.session !== session ||
      heartbeat.nodeId !== nodeId ||
      heartbeat.ready !== true ||
      !commercialLlmPoolIdentityMatches(nodeId, heartbeat.identity)
    )
      return null;
    const id = randomUUID();
    const slot = { ...request, nodeId, session, id, payloadSha256 };
    const raw = JSON.stringify(slot);
    const job = JSON.stringify({
      jobId: request.jobId,
      attempt: request.attempt,
      id,
      nodeId,
      session,
      deadlineAtMs: request.deadlineAtMs,
      payloadSha256,
      state: 'pending',
    });
    // FLAG: Priority, node capacity and the attempt fence are one Redis transaction. A failed
    // reservation neither consumes a retry nor creates a queue behind a busy model. The PC CPU
    // floor is rechecked against Redis time after the awaited heartbeat read, before any write.
    const accepted = await this.redis.eval(
      `${decodeLua}
       local now = nowMs(); local deadline = tonumber(ARGV[4])
       if deadline <= now or deadline - now > tonumber(ARGV[8]) then return 0 end
       if deadline - now < tonumber(ARGV[10]) then return 0 end
       if redis.call('GET', KEYS[1]) ~= ARGV[1] or redis.call('GET', KEYS[2]) ~= ARGV[2] then return 0 end
       local slotRaw = redis.call('GET', KEYS[3]); local slot = decode(slotRaw)
       if slotRaw and (not slot or slot.session == ARGV[1]) then return 0 end
       if ARGV[9] == '1' then
         for i = 6, 7 do if redis.call('EXISTS', KEYS[i]) == 1 then return 0 end end
         if redis.call('HLEN', KEYS[8]) > 4 then return 0 end
         local owner = redis.call('GET', KEYS[9])
         local waiting = redis.call('HGETALL', KEYS[8]); local blocked = false
         for i = 1, #waiting, 2 do
           local item = decode(waiting[i + 1]); local source = item and type(item.source) == 'table' and item.source or nil
           local deadline = source and tonumber(source.deadlineAtMs)
           if not owner or not item or not source or not deadline or deadline <= now or item.worker ~= owner
             or item.source.nonce ~= waiting[i] then redis.call('HDEL', KEYS[8], waiting[i])
           else blocked = true end
         end
         if blocked then return 0 end
       end
       local previousRaw = redis.call('GET', KEYS[5]); local previous = decode(previousRaw)
       local next = decode(ARGV[6])
       if tonumber(ARGV[7]) == 1 then
         if previousRaw then return 0 end
       else
         if not previous or previous.attempt ~= 1 or previous.state ~= 'released'
           or previous.nodeId == next.nodeId or previous.deadlineAtMs ~= deadline
           or previous.payloadSha256 ~= next.payloadSha256 then return 0 end
       end
       redis.call('SET', KEYS[3], ARGV[3], 'PXAT', deadline)
       redis.call('DEL', KEYS[4])
       redis.call('SET', KEYS[5], ARGV[6], 'PXAT', deadline)
       if ARGV[9] ~= '1' then redis.call('HDEL', KEYS[8], next.jobId) end
       return 1`,
      7 + this.pendingKeys.length,
      keys.lease,
      keys.heartbeat,
      keys.slot,
      keys.response,
      jobKey,
      ...this.pendingKeys,
      POOL_DISPATCH_PENDING_KEY,
      POOL_ADMISSION_WORKER_KEY,
      session,
      heartbeatRaw!,
      raw,
      request.deadlineAtMs,
      id,
      job,
      request.attempt,
      COMMERCIAL_LLM_POOL_TIMEOUT_MS,
      options.consultation ? '1' : '0',
      nodeId === 'pc-a-cpu-9b' ? commercialLlmPoolMinRemainingMs(nodeId) : 0,
    );
    return accepted === 1
      ? Object.freeze({ ...request, nodeId, session, id, attemptId: id, raw })
      : null;
  }

  async respond(
    nodeId: CommercialLlmPoolNodeId,
    session: string,
    id: string,
    body: string,
  ): Promise<boolean> {
    if (
      !tokenPattern.test(session) ||
      !tokenPattern.test(id) ||
      typeof body !== 'string' ||
      Buffer.byteLength(body) > COMMERCIAL_LLM_POOL_RESPONSE_BYTES
    )
      return false;
    const keys = commercialLlmPoolNodeKeys(nodeId);
    const slotRaw = await this.redis.get(keys.slot);
    const slot = record(slotRaw);
    if (slot?.id !== id || slot.session !== session || typeof slot.jobId !== 'string') return false;
    const jobKey = commercialLlmPoolJobKey(slot.jobId);
    return (
      (await this.redis.eval(
        `${decodeLua}
       if redis.call('GET', KEYS[1]) ~= ARGV[1] or redis.call('GET', KEYS[2]) ~= ARGV[3] then return 0 end
       local slot = decode(ARGV[3]); local job = decode(redis.call('GET', KEYS[4]))
       local ttl = redis.call('PTTL', KEYS[2]); if ttl <= 0 then return 0 end
       if not same(job, ARGV[2], ARGV[1]) or job.state ~= 'pending' then
         redis.call('DEL', KEYS[2], KEYS[3]); return 0
       end
       if redis.call('EXISTS', KEYS[3]) == 1 then return 0 end
       redis.call('SET', KEYS[3], ARGV[4], 'PX', ttl); return 1`,
        4,
        keys.lease,
        keys.slot,
        keys.response,
        jobKey,
        session,
        id,
        slotRaw!,
        JSON.stringify({ session, id, body }),
      )) === 1
    );
  }

  async release(reservation: CommercialLlmPoolReservation): Promise<void> {
    const keys = commercialLlmPoolNodeKeys(reservation.nodeId);
    // FLAG: Terminal job fences survive resource cleanup until the original deadline. An
    // abandoned computation retains its physical slot until reply, disconnect or expiry.
    await this.redis.eval(
      `${decodeLua}
       local job = decode(redis.call('GET', KEYS[3]))
       local response = decode(redis.call('GET', KEYS[2]))
       local finished = same(job, ARGV[1], ARGV[2]) and job.state == 'complete'
       if same(job, ARGV[1], ARGV[2]) and job.state == 'pending' then
         job.state = 'released'
         local ttl = redis.call('PTTL', KEYS[3])
         if ttl > 0 then redis.call('SET', KEYS[3], cjson.encode(job), 'PX', ttl) end
       end
       if finished or same(response, ARGV[1], ARGV[2]) then
         local slot = decode(redis.call('GET', KEYS[1]))
         if same(slot, ARGV[1], ARGV[2]) then redis.call('DEL', KEYS[1]) end
         if same(response, ARGV[1], ARGV[2]) then redis.call('DEL', KEYS[2]) end
       end
       return 1`,
      3,
      keys.slot,
      keys.response,
      commercialLlmPoolJobKey(reservation.jobId),
      reservation.id,
      reservation.session,
    );
  }

  async releaseUndispatched(reservation: CommercialLlmPoolReservation): Promise<boolean> {
    // FLAG: Only the in-process server adapter may call this, before its first HTTP request.
    // A timeout, transport error or remote-PC reservation is never proof of no computation.
    if (reservation.nodeId !== 'server-9b') throw new Error('pool_local_release_refused');
    const keys = commercialLlmPoolNodeKeys(reservation.nodeId);
    return (
      (await this.redis.eval(
        `${decodeLua}
       if redis.call('GET', KEYS[1]) ~= ARGV[1] or redis.call('GET', KEYS[2]) ~= ARGV[2]
         or redis.call('EXISTS', KEYS[3]) == 1 then return 0 end
       local job = decode(redis.call('GET', KEYS[4])); local ttl = redis.call('PTTL', KEYS[4])
       if not same(job, ARGV[3], ARGV[1]) or job.state ~= 'pending' or ttl <= 0 then return 0 end
       job.state = 'released'; redis.call('SET', KEYS[4], cjson.encode(job), 'PX', ttl)
       redis.call('DEL', KEYS[2]); return 1`,
        4,
        keys.lease,
        keys.slot,
        keys.response,
        commercialLlmPoolJobKey(reservation.jobId),
        reservation.session,
        reservation.raw,
        reservation.id,
      )) === 1
    );
  }

  async wait(
    reservation: CommercialLlmPoolReservation,
    signal?: AbortSignal,
  ): Promise<CommercialLlmPoolOutcome> {
    const keys = commercialLlmPoolNodeKeys(reservation.nodeId);
    const jobKey = commercialLlmPoolJobKey(reservation.jobId);
    try {
      while (Date.now() < reservation.deadlineAtMs) {
        if (signal?.aborted) throw new CommercialLlmError('ABORTED');
        const [session, slotRaw, responseRaw, jobRaw] = await this.redis.mget(
          keys.lease,
          keys.slot,
          keys.response,
          jobKey,
        );
        if (signal?.aborted) throw new CommercialLlmError('ABORTED');
        if (session !== reservation.session) return { outcome: 'UNAVAILABLE' };
        const job = record(jobRaw, 4096);
        if (slotRaw !== reservation.raw || job?.id !== reservation.id || job.state !== 'pending')
          return { outcome: Date.now() >= reservation.deadlineAtMs ? 'TIMEOUT' : 'FAILED' };
        const response = record(responseRaw, COMMERCIAL_LLM_POOL_RESPONSE_BYTES + 1024);
        if (response?.id === reservation.id && response.session === reservation.session) {
          if (
            typeof response.body !== 'string' ||
            Buffer.byteLength(response.body) > COMMERCIAL_LLM_POOL_RESPONSE_BYTES
          )
            return { outcome: 'FAILED' };
          parseCommercialLlmEnvelope(
            JSON.parse(response.body),
            COMMERCIAL_LLM_POOL_PROFILES[reservation.nodeId].identity.modelAlias,
          );
          const accepted = await this.redis.eval(
            `${decodeLua}
             if redis.call('GET', KEYS[1]) ~= ARGV[1] or redis.call('GET', KEYS[2]) ~= ARGV[2]
               or redis.call('GET', KEYS[3]) ~= ARGV[3] or redis.call('GET', KEYS[4]) ~= ARGV[4] then return 0 end
             local job = decode(ARGV[4]); local ttl = redis.call('PTTL', KEYS[4])
             if not job or job.state ~= 'pending' or ttl <= 0 or job.deadlineAtMs <= nowMs() then return 0 end
             job.state = 'complete'; redis.call('SET', KEYS[4], cjson.encode(job), 'PX', ttl); return 1`,
            4,
            keys.lease,
            keys.slot,
            keys.response,
            jobKey,
            reservation.session,
            reservation.raw,
            responseRaw!,
            jobRaw!,
          );
          return accepted === 1
            ? { outcome: 'COMPLETE', body: response.body }
            : { outcome: 'FAILED' };
        }
        await pause(Math.min(50, Math.max(1, reservation.deadlineAtMs - Date.now())), undefined, {
          signal,
        });
      }
      return { outcome: 'TIMEOUT' };
    } catch (error) {
      if (signal?.aborted) throw new CommercialLlmError('ABORTED');
      if (error instanceof CommercialLlmError)
        return {
          outcome: 'FAILED',
          ...(error.responseIssue ? { responseIssue: error.responseIssue } : {}),
        };
      if (error instanceof SyntaxError) return { outcome: 'FAILED', responseIssue: 'envelope' };
      // FLAG: A store/transport failure proves no malformed model answer.
      return { outcome: 'UNAVAILABLE' };
    } finally {
      await this.release(reservation).catch(() => undefined);
    }
  }
}
