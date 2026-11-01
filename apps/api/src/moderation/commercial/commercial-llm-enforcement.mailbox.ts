import { createHash } from 'node:crypto';
import { Logger } from '@nestjs/common';
import type Redis from 'ioredis';
import {
  commercialLlmRequestSchema,
  commercialLlmSourceCurrent,
  commercialLlmSourceKey,
  COMMERCIAL_LLM_PENDING_MAX_AGE_MS,
  type CommercialLlmRequest,
  type CommercialLlmSource,
} from './commercial-llm-enforcement.protocol';
const prefix = 'commercial-llm-enforcement:v2';
const pendingPrefix = 'commercial-llm-enforcement:v3';
const proofPrefix = 'commercial-llm-enforcement:v1';
export const COMMERCIAL_LLM_PRIMARY_INTERVAL_MS = 2_000;
export const COMMERCIAL_LLM_POLL_INTERVAL_MS = 250;
const burstCooldownMaximumMs = 250;
export const COMMERCIAL_LLM_ACTIVE_LIMIT = 3;
export const COMMERCIAL_LLM_CHAT_ACTIVE_LIMIT = 2;
export const COMMERCIAL_LLM_ENFORCEMENT_KEYS = {
  worker: `${prefix}:worker`,
  ready: `${prefix}:ready`,
  slot: `${pendingPrefix}:slot`,
  slotNext: `${pendingPrefix}:slot-next`,
  active: `${prefix}:active`,
  primary: `${prefix}:primary`,
  secondary: `${prefix}:secondary`,
  metrics: `${prefix}:metrics`,
  // FLAG: Readback and issued DELETE proofs remain compatible across the ephemeral handoff upgrade.
  status: `${proofPrefix}:status`,
  cooldown: `${prefix}:primary-cooldown`,
} as const;
export type CommercialLlmAdmissionResult =
  | 'accepted'
  | 'no_worker'
  | 'not_ready'
  | 'buffer_full'
  | 'chat_busy'
  | 'active_limit'
  | 'source_stale'
  | 'source_expired'
  | 'worker_changed';
const pendingDiscardReasons = ['pending_expired', 'foreign_worker', 'invalid_pending'] as const;
export type CommercialLlmPendingDiscardReason = (typeof pendingDiscardReasons)[number];
export const commercialLlmProofKey = (source: CommercialLlmSource) =>
  `${proofPrefix}:proof:${commercialLlmSourceKey(source)}`;
const rawKey = (raw: string) => createHash('sha256').update(raw).digest('hex');
const chatKey = (source: CommercialLlmSource) =>
  createHash('sha256').update(source.chatId).digest('hex');
function parseRequest(raw: string): CommercialLlmRequest | null {
  try {
    const parsed = commercialLlmRequestSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
const release =
  "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end";
const decodeLua = `local function decode(value)
  if not value then return nil end
  local ok, request = pcall(cjson.decode, value)
  if ok and type(request) == 'table' then return request end
  return nil
end
`;
// FLAG: Only the current worker and an exact head/absence CAS may promote the tail. RENAME preserves its
// absolute Redis expiry, raw source and admission clock; no caller refills ahead of it.
const promotePendingLua = `local function promotePending(head, tail)
  if redis.call('EXISTS', tail) > 0 then redis.call('RENAME', tail, head) end
end
`;
// FLAG: Inspect at most the bounded active set; same-message nonce changes never bypass exclusion.
const chatAdmissionLua = `local function chatBusy(active, primary, chat, message, limit)
  local count = 0
  for _, raw in ipairs(redis.call('HVALS', active)) do
    local item = decode(raw)
    if item and type(item.source) == 'table' and item.source.chatId == chat then
      count = count + 1
      if raw == primary or item.source.messageId == message then return true end
    end
  end
  return count >= limit
end
`;
// FLAG: Both hashes are checked against the global bound before this pass. A claim retains
// its exact active source and worker; Redis reconnects cannot create another same-chat 9B turn.
const pruneSecondaryLua = `local function pruneSecondary(key, active, worker, now)
  local live = {}
  for _, raw in ipairs(redis.call('HVALS', active)) do live[raw] = true end
  local rows = redis.call('HGETALL', key)
  for i = 1, #rows, 2 do
    local request = decode(rows[i + 1])
    if not request or request.worker ~= worker or type(request.source) ~= 'table'
      or not tonumber(request.source.deadlineAtMs) or tonumber(request.source.deadlineAtMs) <= now
      or not live[rows[i + 1]] then
      redis.call('HDEL', key, rows[i])
    end
  end
end
`;
// FLAG: Every caller checks HLEN before this bounded pass. Expiry never renews source authority.
const pruneActiveLua = `${decodeLua}local function pruneActive(key, worker, now)
  local rows = redis.call('HGETALL', key)
  for i = 1, #rows, 2 do
    local request = decode(rows[i + 1])
    if not request or request.worker ~= worker or type(request.source) ~= 'table'
      or not tonumber(request.source.deadlineAtMs) or tonumber(request.source.deadlineAtMs) <= now then
      redis.call('HDEL', key, rows[i])
    end
  end
end
`;

export class CommercialLlmEnforcementMailbox {
  private readonly logger = new Logger(CommercialLlmEnforcementMailbox.name);
  constructor(
    protected readonly redis: Redis,
    protected readonly keys: {
      [Key in keyof typeof COMMERCIAL_LLM_ENFORCEMENT_KEYS]: string;
    } = COMMERCIAL_LLM_ENFORCEMENT_KEYS,
  ) {}

  async heartbeat(worker: string): Promise<boolean> {
    return (
      (await this.redis.eval(
        `local owner = redis.call('GET', KEYS[1])
      if owner and owner ~= ARGV[1] then return 0 end
      redis.call('SET', KEYS[1], ARGV[1], 'PX', 5000); return 1`,
        1,
        this.keys.worker,
        worker,
      )) === 1
    );
  }

  async ownsWorker(worker: string): Promise<boolean> {
    return (await this.redis.get(this.keys.worker)) === worker;
  }

  async advertise(worker: string): Promise<boolean> {
    return (
      (await this.redis.eval(
        `${pruneActiveLua}
      if redis.call('GET', KEYS[3]) ~= ARGV[1] or redis.call('EXISTS', KEYS[2], KEYS[5]) >= 2
          or redis.call('HLEN', KEYS[4]) > tonumber(ARGV[2]) then return 0 end
      local time = redis.call('TIME'); local now = time[1] * 1000 + math.floor(time[2] / 1000)
      pruneActive(KEYS[4], ARGV[1], now)
      if redis.call('HLEN', KEYS[4]) >= tonumber(ARGV[2]) then return 0 end
      redis.call('SET', KEYS[1], ARGV[1], 'PX', 2500); return 1`,
        5,
        this.keys.ready,
        this.keys.slot,
        this.keys.worker,
        this.keys.active,
        this.keys.slotNext,
        worker,
        COMMERCIAL_LLM_ACTIVE_LIMIT,
      )) === 1
    );
  }

  async withdraw(worker: string): Promise<void> {
    await this.redis.eval(release, 1, this.keys.ready, worker);
  }

  async offer(offer: { source: CommercialLlmSource; excerpt: string }): Promise<boolean> {
    return (await this.offerDetailed(offer)) === 'accepted';
  }

  async offerDetailed(
    offer: {
      source: CommercialLlmSource;
      excerpt: string;
    },
    beforeAdmission?: (request: CommercialLlmRequest) => Promise<void>,
  ): Promise<CommercialLlmAdmissionResult> {
    if (!commercialLlmSourceCurrent(offer.source)) return 'source_expired';
    const [worker, pendingRaw] = await this.redis.mget(this.keys.ready, this.keys.slot);
    const pending = pendingRaw ? parseRequest(pendingRaw) : null;
    const validatedPendingRaw =
      pending && pending.worker === worker && commercialLlmSourceCurrent(pending.source)
        ? pendingRaw!
        : '';
    const request = commercialLlmRequestSchema.parse({
      ...offer,
      worker: worker ?? '00000000-0000-4000-8000-000000000000',
      submittedAtMs: Date.now(),
    });
    if (beforeAdmission)
      await Promise.resolve()
        .then(() => beforeAdmission(request))
        .catch(() => undefined);
    // FLAG: A chat awaiting 9B may admit another message's primary, never a duplicate message
    // or concurrent same-chat primary. Model limits and original source clocks remain independent.
    // FLAG: Append at most one distinct-chat burst tail behind an exact validated head,
    // only with free primary, active <= 1 and <= 250ms of the unchanged two-second cooldown.
    // Both projected starts spend their own original three seconds, including two poll reserves.
    // FLAG: Readiness retains its short eligibility TTL across offers; it is not a model lease.
    return (await this.redis.eval(
      `${pruneActiveLua}${chatAdmissionLua}
      local time = redis.call('TIME'); local now = time[1] * 1000 + math.floor(time[2] / 1000)
      if tonumber(ARGV[3]) <= now then return 'source_expired' end
      if tonumber(ARGV[4]) < now - 10000 or tonumber(ARGV[4]) > now + 5000 then return 'source_stale' end
      local worker = redis.call('GET', KEYS[3])
      if not worker then return 'no_worker' end
      if redis.call('HLEN', KEYS[4]) > tonumber(ARGV[6]) then return 'active_limit' end
      pruneActive(KEYS[4], worker, now)
      local pendingRaw = redis.call('GET', KEYS[2])
      local pending = decode(pendingRaw)
      local nextRaw = redis.call('GET', KEYS[6])
      local next = decode(nextRaw)
      if pending and type(pending.source) == 'table' and pending.source.chatId == ARGV[5] then return 'chat_busy' end
      if next and type(next.source) == 'table' and next.source.chatId == ARGV[5] then return 'chat_busy' end
      if chatBusy(KEYS[4], redis.call('GET', KEYS[5]), ARGV[5], ARGV[7], tonumber(ARGV[8])) then return 'chat_busy' end
      local target = KEYS[2]
      if pendingRaw or nextRaw then
        if not pendingRaw or not pending or nextRaw or ARGV[9] == '' or pendingRaw ~= ARGV[9] then return 'buffer_full' end
        if redis.call('HLEN', KEYS[4]) > 1 or redis.call('EXISTS', KEYS[5]) > 0 then return 'buffer_full' end
        local cooldown = redis.call('PTTL', KEYS[7])
        if cooldown == -1 or cooldown > tonumber(ARGV[12]) then return 'buffer_full' end
        cooldown = math.max(0, cooldown)
        local headStart = now + cooldown + tonumber(ARGV[14])
        if tonumber(pending.submittedAtMs) > now + 1000
          or headStart > tonumber(pending.submittedAtMs) + tonumber(ARGV[11])
          or headStart >= tonumber(pending.source.deadlineAtMs) then return 'buffer_full' end
        local tailStart = headStart + tonumber(ARGV[13]) + tonumber(ARGV[14])
        if tonumber(ARGV[10]) > now + 1000 or tailStart > tonumber(ARGV[10]) + tonumber(ARGV[11])
          or tailStart >= tonumber(ARGV[3]) then return 'buffer_full' end
        target = KEYS[6]
      end
      if redis.call('HLEN', KEYS[4]) >= tonumber(ARGV[6]) then return 'active_limit' end
      local ready = redis.call('GET', KEYS[1])
      if not ready then return 'not_ready' end
      if ready ~= ARGV[1] or worker ~= ARGV[1] then return 'worker_changed' end
      redis.call('SET', target, ARGV[2], 'PXAT', ARGV[3])
      return 'accepted'`,
      7,
      this.keys.ready,
      this.keys.slot,
      this.keys.worker,
      this.keys.active,
      this.keys.primary,
      this.keys.slotNext,
      this.keys.cooldown,
      worker ?? '',
      JSON.stringify(request),
      offer.source.deadlineAtMs,
      offer.source.eventAtMs,
      offer.source.chatId,
      COMMERCIAL_LLM_ACTIVE_LIMIT,
      offer.source.messageId,
      COMMERCIAL_LLM_CHAT_ACTIVE_LIMIT,
      validatedPendingRaw,
      request.submittedAtMs,
      COMMERCIAL_LLM_PENDING_MAX_AGE_MS,
      burstCooldownMaximumMs,
      COMMERCIAL_LLM_PRIMARY_INTERVAL_MS,
      COMMERCIAL_LLM_POLL_INTERVAL_MS,
    )) as CommercialLlmAdmissionResult;
  }

  private async discardPending(
    raw: string,
    worker: string,
    reason: CommercialLlmPendingDiscardReason,
  ): Promise<void> {
    const discarded = await this.redis.eval(
      `${promotePendingLua}if redis.call('GET', KEYS[2]) ~= ARGV[2] or redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
      redis.call('DEL', KEYS[1]); promotePending(KEYS[1], KEYS[4]); redis.call('HINCRBY', KEYS[3], ARGV[3], 1)
      redis.call('EXPIRE', KEYS[3], 86400); return 1`,
      4,
      this.keys.slot,
      this.keys.worker,
      this.keys.metrics,
      this.keys.slotNext,
      raw,
      worker,
      reason,
    );
    if (discarded === 1) this.logPendingDiscard(reason, parseRequest(raw));
  }

  private logPendingDiscard(
    outcome: CommercialLlmPendingDiscardReason,
    request: CommercialLlmRequest | null,
  ): void {
    // FLAG: Only the successful exact discard CAS emits a terminal observation. Schema-validated
    // correlation is limited to the random trace and intake clock; source identifiers/text stay private.
    const intakeWindow = request
      ? new Date(Math.floor(request.submittedAtMs / 60_000) * 60_000)
      : null;
    this.logger.log(
      {
        stage: 'commercial-ai',
        schemaVersion: 2,
        mode: 'ENFORCE',
        outcome,
        ...(request && intakeWindow && Number.isFinite(intakeWindow.getTime())
          ? {
              traceId: request.source.nonce,
              admittedAtMs: request.submittedAtMs,
              admissionWindowStartAt: intakeWindow.toISOString(),
            }
          : {}),
      },
      'Commercial AI pending result',
    );
  }

  async readObservations(): Promise<Partial<Record<CommercialLlmPendingDiscardReason, number>>> {
    const counts = await this.redis.hmget(this.keys.metrics, ...pendingDiscardReasons);
    return Object.fromEntries(
      pendingDiscardReasons.flatMap((reason, index) => {
        const count = Number(counts[index]);
        return Number.isSafeInteger(count) && count > 0 ? [[reason, count]] : [];
      }),
    );
  }

  async take(worker: string): Promise<{ request: CommercialLlmRequest; raw: string } | null> {
    if (!(await this.ownsWorker(worker))) return null;
    const raw = await this.redis.eval(
      `${promotePendingLua}if redis.call('GET', KEYS[3]) ~= ARGV[1] then return nil end
      if redis.call('EXISTS', KEYS[1]) == 0 then promotePending(KEYS[1], KEYS[2]) end
      return redis.call('GET', KEYS[1])`,
      3,
      this.keys.slot,
      this.keys.slotNext,
      this.keys.worker,
      worker,
    );
    if (typeof raw !== 'string') return null;
    const request = parseRequest(raw);
    const reason: CommercialLlmPendingDiscardReason | null = !request
      ? 'invalid_pending'
      : request.worker !== worker
        ? 'foreign_worker'
        : !commercialLlmSourceCurrent(request.source) ||
            Date.now() - request.submittedAtMs > COMMERCIAL_LLM_PENDING_MAX_AGE_MS ||
            request.submittedAtMs > Date.now() + 1000
          ? 'pending_expired'
          : null;
    if (reason || !request) {
      await this.discardPending(raw, worker, reason ?? 'invalid_pending');
      return null;
    }
    // FLAG: Transferring the FIFO head to active and promoting its tail is one CAS.
    // A busy primary cannot consume the buffer,
    // and releasing 4B never releases the active source/proof authority still needed by 9B.
    const taken = await this.redis.eval(
      `${pruneActiveLua}${chatAdmissionLua}${promotePendingLua}
      if redis.call('GET', KEYS[2]) ~= ARGV[2] or redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
      local time = redis.call('TIME'); local now = time[1] * 1000 + math.floor(time[2] / 1000)
      if tonumber(ARGV[5]) <= now or now - tonumber(ARGV[4]) > tonumber(ARGV[6]) or tonumber(ARGV[4]) > now + 1000 then
        redis.call('DEL', KEYS[1]); promotePending(KEYS[1], KEYS[7]); redis.call('HINCRBY', KEYS[6], 'pending_expired', 1)
        redis.call('EXPIRE', KEYS[6], 86400); return 2
      end
      if redis.call('HLEN', KEYS[3]) > tonumber(ARGV[8]) then return 0 end
      pruneActive(KEYS[3], ARGV[2], now)
      if redis.call('HLEN', KEYS[3]) >= tonumber(ARGV[8]) or redis.call('EXISTS', KEYS[4], KEYS[5]) > 0 then return 0 end
      if chatBusy(KEYS[3], redis.call('GET', KEYS[4]), ARGV[9], ARGV[10], tonumber(ARGV[11])) then return 0 end
      redis.call('HSET', KEYS[3], ARGV[3], ARGV[1])
      local expire = redis.call('PEXPIRETIME', KEYS[3])
      if expire < tonumber(ARGV[5]) then redis.call('PEXPIREAT', KEYS[3], ARGV[5]) end
      redis.call('SET', KEYS[4], ARGV[1], 'PX', tonumber(ARGV[5]) - now)
      redis.call('SET', KEYS[5], '1', 'PX', ARGV[7]); redis.call('DEL', KEYS[1]); promotePending(KEYS[1], KEYS[7]); return 1`,
      7,
      this.keys.slot,
      this.keys.worker,
      this.keys.active,
      this.keys.primary,
      this.keys.cooldown,
      this.keys.metrics,
      this.keys.slotNext,
      raw,
      worker,
      rawKey(raw),
      request.submittedAtMs,
      request.source.deadlineAtMs,
      COMMERCIAL_LLM_PENDING_MAX_AGE_MS,
      COMMERCIAL_LLM_PRIMARY_INTERVAL_MS,
      COMMERCIAL_LLM_ACTIVE_LIMIT,
      request.source.chatId,
      request.source.messageId,
      COMMERCIAL_LLM_CHAT_ACTIVE_LIMIT,
    );
    if (taken === 2) this.logPendingDiscard('pending_expired', request);
    return taken === 1 ? { request, raw } : null;
  }

  async releasePrimary(raw: string, worker: string): Promise<boolean> {
    return (
      (await this.redis.eval(
        `if redis.call('GET', KEYS[2]) ~= ARGV[2] or redis.call('HGET', KEYS[3], ARGV[3]) ~= ARGV[1] then return 0 end
      if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end; return 0`,
        3,
        this.keys.primary,
        this.keys.worker,
        this.keys.active,
        raw,
        worker,
        rawKey(raw),
      )) === 1
    );
  }

  async claimSecondary(raw: string, worker: string): Promise<boolean> {
    const request = parseRequest(raw);
    if (!request || request.worker !== worker || !commercialLlmSourceCurrent(request.source))
      return false;
    // FLAG: One exact source per chat may run or wait for 9B. Claiming never releases
    // active DELETE authority, retries inference, or extends any source/model deadline.
    return (
      (await this.redis.eval(
        `${pruneActiveLua}${pruneSecondaryLua}
      if redis.call('GET', KEYS[2]) ~= ARGV[2] then return 0 end
      local time = redis.call('TIME'); local now = time[1] * 1000 + math.floor(time[2] / 1000)
      if tonumber(ARGV[5]) <= now then return 0 end
      if redis.call('HLEN', KEYS[1]) > tonumber(ARGV[6]) or redis.call('HLEN', KEYS[3]) > tonumber(ARGV[6]) then return 0 end
      pruneActive(KEYS[1], ARGV[2], now)
      pruneSecondary(KEYS[3], KEYS[1], ARGV[2], now)
      if redis.call('HGET', KEYS[1], ARGV[3]) ~= ARGV[1] or redis.call('GET', KEYS[4]) == ARGV[1] then return 0 end
      if redis.call('HEXISTS', KEYS[3], ARGV[4]) > 0 or redis.call('HLEN', KEYS[3]) >= tonumber(ARGV[6]) then return 0 end
      redis.call('HSET', KEYS[3], ARGV[4], ARGV[1])
      local expire = redis.call('PEXPIRETIME', KEYS[3])
      if expire < tonumber(ARGV[5]) then redis.call('PEXPIREAT', KEYS[3], ARGV[5]) end
      return 1`,
        4,
        this.keys.active,
        this.keys.worker,
        this.keys.secondary,
        this.keys.primary,
        raw,
        worker,
        rawKey(raw),
        chatKey(request.source),
        request.source.deadlineAtMs,
        COMMERCIAL_LLM_ACTIVE_LIMIT,
      )) === 1
    );
  }

  async releaseSecondary(raw: string, worker: string): Promise<boolean> {
    const request = parseRequest(raw);
    if (!request || request.worker !== worker || !commercialLlmSourceCurrent(request.source))
      return false;
    return (
      (await this.redis.eval(
        `if redis.call('GET', KEYS[2]) ~= ARGV[2] or redis.call('HGET', KEYS[1], ARGV[3]) ~= ARGV[1] then return 0 end
      local time = redis.call('TIME'); local now = time[1] * 1000 + math.floor(time[2] / 1000)
      if tonumber(ARGV[5]) <= now or redis.call('HGET', KEYS[3], ARGV[4]) ~= ARGV[1] then return 0 end
      return redis.call('HDEL', KEYS[3], ARGV[4])`,
        3,
        this.keys.active,
        this.keys.worker,
        this.keys.secondary,
        raw,
        worker,
        rawKey(raw),
        chatKey(request.source),
        request.source.deadlineAtMs,
      )) === 1
    );
  }

  async owns(raw: string): Promise<boolean> {
    const request = parseRequest(raw);
    if (!request || !commercialLlmSourceCurrent(request.source)) return false;
    return (
      (await this.redis.eval(
        `if redis.call('GET', KEYS[2]) == ARGV[2] and redis.call('HGET', KEYS[1], ARGV[3]) == ARGV[1] then return 1 end; return 0`,
        2,
        this.keys.active,
        this.keys.worker,
        raw,
        request.worker,
        rawKey(raw),
      )) === 1
    );
  }

  async prove(raw: string, source: CommercialLlmSource): Promise<boolean> {
    const request = parseRequest(raw);
    if (
      !request ||
      !commercialLlmSourceCurrent(source) ||
      JSON.stringify(request.source) !== JSON.stringify(source)
    )
      return false;
    // FLAG: Active authority and worker generation must match exactly; a new primary source does
    // not revoke an independently waiting server result or lend it another source's DELETE proof.
    return (
      (await this.redis.eval(
        `if redis.call('HGET', KEYS[1], ARGV[5]) ~= ARGV[1] or redis.call('GET', KEYS[3]) ~= ARGV[4] then return 0 end
      local time = redis.call('TIME'); local now = time[1] * 1000 + math.floor(time[2] / 1000)
      if tonumber(ARGV[3]) <= now then return 0 end
      redis.call('SET', KEYS[2], ARGV[2], 'PX', tonumber(ARGV[3]) - now, 'NX'); return 1`,
        3,
        this.keys.active,
        commercialLlmProofKey(source),
        this.keys.worker,
        raw,
        JSON.stringify(source),
        source.deadlineAtMs,
        request.worker,
        rawKey(raw),
      )) === 1
    );
  }

  async hasProof(source: CommercialLlmSource): Promise<boolean> {
    return (
      commercialLlmSourceCurrent(source) &&
      (await this.redis.get(commercialLlmProofKey(source))) === JSON.stringify(source)
    );
  }

  async finish(raw: string, worker?: string): Promise<void> {
    const request = parseRequest(raw);
    if (!request || (worker && request.worker !== worker)) return;
    // FLAG: Exact source and current worker own cleanup. Obsolete callers cannot remove a new
    // worker's active authority, primary or secondary; completed work cannot consume a successor.
    await this.redis.eval(
      `if redis.call('GET', KEYS[3]) ~= ARGV[2] then return 0 end
      if redis.call('HGET', KEYS[1], ARGV[3]) == ARGV[1] then redis.call('HDEL', KEYS[1], ARGV[3]) end
      if redis.call('GET', KEYS[2]) == ARGV[1] then redis.call('DEL', KEYS[2]) end
      if redis.call('HGET', KEYS[4], ARGV[4]) == ARGV[1] then redis.call('HDEL', KEYS[4], ARGV[4]) end; return 1`,
      4,
      this.keys.active,
      this.keys.primary,
      this.keys.worker,
      this.keys.secondary,
      raw,
      request.worker,
      rawKey(raw),
      chatKey(request.source),
    );
  }
}
