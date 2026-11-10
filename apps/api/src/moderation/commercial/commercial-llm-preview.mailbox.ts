import { randomUUID } from 'node:crypto';
import { setTimeout as pause } from 'node:timers/promises';
import type Redis from 'ioredis';
import { z } from 'zod';
import { CommercialLlmError } from './commercial-llm.client';
import { commercialLlmHasPinnedServerIdentity } from './commercial-llm-enforcement.protocol';
import { COMMERCIAL_LLM_ENFORCEMENT_KEYS } from './commercial-llm-enforcement.mailbox';
import { COMMERCIAL_LLM_POOL_ADMISSION_KEYS } from './commercial-llm-pool-admission.mailbox';
import {
  COMMERCIAL_LLM_COOLDOWN_KEY,
  COMMERCIAL_LLM_LEASE_KEY,
} from './commercial-llm-shadow.lease';
import {
  parseCommercialLlmDecision,
  type CommercialLlmObservationResult,
} from './commercial-llm.protocol';

export const COMMERCIAL_LLM_PREVIEW_KEYS = {
  ready: 'commercial-llm-preview:v1:ready',
  request: 'commercial-llm-preview:v1:request',
  claim: 'commercial-llm-preview:v1:claim',
  result: 'commercial-llm-preview:v1:result:',
} as const;
export const COMMERCIAL_LLM_PREVIEW_TIMEOUT_MS = 20_000;
const moderationKeys = [
  COMMERCIAL_LLM_ENFORCEMENT_KEYS,
  COMMERCIAL_LLM_POOL_ADMISSION_KEYS,
].flatMap((entry) => [entry.slot, entry.slotNext, entry.active, entry.primary, entry.secondary]);
const blockers = [...moderationKeys, COMMERCIAL_LLM_LEASE_KEY, COMMERCIAL_LLM_COOLDOWN_KEY];
const requestSchema = z
  .object({
    id: z.uuid(),
    worker: z.uuid(),
    excerpt: z.string().trim().min(1).max(2500),
    deadlineAtMs: z.number().int().positive(),
  })
  .strict();
export type CommercialLlmPreviewRequest = z.infer<typeof requestSchema>;
const ADMIT = `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
if redis.call('GET', KEYS[4]) ~= ARGV[1] and redis.call('GET', KEYS[5]) ~= ARGV[1] then return 0 end
for i = 3, #KEYS do if i ~= 4 and i ~= 5 and redis.call('EXISTS', KEYS[i]) == 1 then return 0 end end
return redis.call('SET', KEYS[2], ARGV[2], 'PX', ARGV[3], 'NX') and 1 or 0`;
const CLAIM = `
if redis.call('GET', KEYS[1]) ~= ARGV[1] or redis.call('GET', KEYS[2]) ~= ARGV[2] then return 0 end
if redis.call('GET', KEYS[4]) ~= ARGV[1] and redis.call('GET', KEYS[5]) ~= ARGV[1] then return 0 end
for i = 6, #KEYS do if redis.call('EXISTS', KEYS[i]) == 1 then return 0 end end
local ttl = redis.call('PTTL', KEYS[2])
if ttl <= 0 then return 0 end
return redis.call('SET', KEYS[3], ARGV[3], 'PX', ttl, 'NX') and 1 or 0`;
const FINISH = `
if redis.call('GET', KEYS[2]) ~= ARGV[2] then return 0 end
redis.call('DEL', KEYS[2])
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
if ARGV[3] ~= '' then redis.call('SET', KEYS[3], ARGV[3], 'PX', 5000, 'NX') end
return redis.call('DEL', KEYS[1])`;
const CANCEL = `
if redis.call('GET', KEYS[1]) == ARGV[1] then redis.call('DEL', KEYS[1]) end
return redis.call('DEL', KEYS[2])`;

// FLAG: A single expiring diagnostic slot is separate from every enforcement source/proof.
// Only the background owner reaches the CPU; expiry never releases its physical model lease.
export class CommercialLlmPreviewMailbox {
  constructor(private readonly redis: Redis) {}

  async advertise(worker: string) {
    await this.redis.eval(
      `
if redis.call('GET', KEYS[2]) ~= ARGV[1] and redis.call('GET', KEYS[3]) ~= ARGV[1] then return 0 end
return redis.call('SET', KEYS[1], ARGV[1], 'PX', 1500)`,
      3,
      COMMERCIAL_LLM_PREVIEW_KEYS.ready,
      COMMERCIAL_LLM_ENFORCEMENT_KEYS.worker,
      COMMERCIAL_LLM_POOL_ADMISSION_KEYS.worker,
      worker,
    );
  }

  async withdraw(worker: string) {
    await this.redis.eval(
      "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end",
      1,
      COMMERCIAL_LLM_PREVIEW_KEYS.ready,
      worker,
    );
  }

  async classify(excerpt: string): Promise<CommercialLlmObservationResult> {
    const worker = await this.redis.get(COMMERCIAL_LLM_PREVIEW_KEYS.ready);
    const request = requestSchema.safeParse({
      id: randomUUID(),
      worker,
      excerpt,
      deadlineAtMs: Date.now() + COMMERCIAL_LLM_PREVIEW_TIMEOUT_MS,
    });
    if (!request.success) throw new CommercialLlmError('BUSY');
    const raw = JSON.stringify(request.data);
    const resultKey = COMMERCIAL_LLM_PREVIEW_KEYS.result + request.data.id;
    const keys = [
      COMMERCIAL_LLM_PREVIEW_KEYS.ready,
      COMMERCIAL_LLM_PREVIEW_KEYS.request,
      COMMERCIAL_LLM_PREVIEW_KEYS.claim,
      COMMERCIAL_LLM_ENFORCEMENT_KEYS.worker,
      COMMERCIAL_LLM_POOL_ADMISSION_KEYS.worker,
      ...blockers,
    ];
    if (
      (await this.redis.eval(
        ADMIT,
        keys.length,
        ...keys,
        worker!,
        raw,
        COMMERCIAL_LLM_PREVIEW_TIMEOUT_MS,
      )) !== 1
    )
      throw new CommercialLlmError('BUSY');
    try {
      while (Date.now() < request.data.deadlineAtMs) {
        const [response, ready, claim] = await this.redis.mget(
          resultKey,
          COMMERCIAL_LLM_PREVIEW_KEYS.ready,
          COMMERCIAL_LLM_PREVIEW_KEYS.claim,
        );
        if (response) {
          if (response.length > 4000 || Date.now() >= request.data.deadlineAtMs)
            throw new CommercialLlmError('INVALID_RESPONSE');
          const result = JSON.parse(response) as CommercialLlmObservationResult;
          if (
            !result ||
            !parseCommercialLlmDecision({
              classification: result.classification,
              reasonCodes: result.reasonCodes,
            }) ||
            !commercialLlmHasPinnedServerIdentity(result)
          )
            throw new CommercialLlmError('INVALID_RESPONSE');
          return result;
        }
        if (ready !== worker && claim !== request.data.id)
          throw new CommercialLlmError('UNAVAILABLE');
        await pause(50);
      }
      throw new CommercialLlmError('ABORTED');
    } finally {
      await this.redis
        .eval(CANCEL, 2, COMMERCIAL_LLM_PREVIEW_KEYS.request, resultKey, raw)
        .catch(() => undefined);
    }
  }

  async take(
    worker: string,
  ): Promise<{ raw: string; request: CommercialLlmPreviewRequest } | null> {
    const raw = await this.redis.get(COMMERCIAL_LLM_PREVIEW_KEYS.request);
    if (!raw || raw.length > 16000) return null;
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      return null;
    }
    const parsed = requestSchema.safeParse(value);
    if (
      !parsed.success ||
      parsed.data.worker !== worker ||
      parsed.data.deadlineAtMs <= Date.now() ||
      parsed.data.deadlineAtMs > Date.now() + COMMERCIAL_LLM_PREVIEW_TIMEOUT_MS
    )
      return null;
    const keys = [
      COMMERCIAL_LLM_PREVIEW_KEYS.ready,
      COMMERCIAL_LLM_PREVIEW_KEYS.request,
      COMMERCIAL_LLM_PREVIEW_KEYS.claim,
      COMMERCIAL_LLM_ENFORCEMENT_KEYS.worker,
      COMMERCIAL_LLM_POOL_ADMISSION_KEYS.worker,
      ...blockers,
    ];
    return (await this.redis.eval(CLAIM, keys.length, ...keys, worker, raw, parsed.data.id)) === 1
      ? { raw, request: parsed.data }
      : null;
  }

  async current(raw: string, request: CommercialLlmPreviewRequest): Promise<boolean> {
    if (Date.now() >= request.deadlineAtMs) return false;
    const keys = [
      COMMERCIAL_LLM_PREVIEW_KEYS.request,
      COMMERCIAL_LLM_PREVIEW_KEYS.claim,
      COMMERCIAL_LLM_ENFORCEMENT_KEYS.worker,
      COMMERCIAL_LLM_POOL_ADMISSION_KEYS.worker,
      ...moderationKeys,
    ];
    return (
      (await this.redis.eval(
        `
if redis.call('GET', KEYS[1]) ~= ARGV[1] or redis.call('GET', KEYS[2]) ~= ARGV[2] then return 0 end
if redis.call('GET', KEYS[3]) ~= ARGV[3] and redis.call('GET', KEYS[4]) ~= ARGV[3] then return 0 end
for i = 5, #KEYS do if redis.call('EXISTS', KEYS[i]) == 1 then return 0 end end
return 1`,
        keys.length,
        ...keys,
        raw,
        request.id,
        request.worker,
      )) === 1
    );
  }

  async finish(
    raw: string,
    request: CommercialLlmPreviewRequest,
    result: CommercialLlmObservationResult | null,
  ) {
    await this.redis.eval(
      FINISH,
      3,
      COMMERCIAL_LLM_PREVIEW_KEYS.request,
      COMMERCIAL_LLM_PREVIEW_KEYS.claim,
      COMMERCIAL_LLM_PREVIEW_KEYS.result + request.id,
      raw,
      request.id,
      result && Date.now() < request.deadlineAtMs ? JSON.stringify(result) : JSON.stringify(null),
    );
  }
}
