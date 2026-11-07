import {
  safetyDeskCommercialAiResponseSchema,
  type SafetyDeskCommercialAiResponse,
} from '@maxim/contracts/safety-desk';
import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type Redis from 'ioredis';
import { z } from 'zod';
import { createCommercialLlmRedis } from '../moderation/commercial/commercial-llm-shadow.lease';
import { COMMERCIAL_LLM_ENFORCEMENT_KEYS } from '../moderation/commercial/commercial-llm-enforcement.mailbox';
import { COMMERCIAL_LLM_POOL_ADMISSION_KEYS } from '../moderation/commercial/commercial-llm-pool-admission.mailbox';

export const COMMERCIAL_AI_STATUS_MAX_BYTES = 16_384;
const FRESH_MS = 30_000;
const CACHE_MS = 2_000;
// FLAG: Read one fixed key atomically and cap bytes before reading its value. Never read
// pending inputs, model requests, source proofs or any worker ownership token.
export const READ_COMMERCIAL_AI_STATUS = `
local kind = redis.call('TYPE', KEYS[1]).ok
if kind == 'none' then return {'missing'} end
if kind ~= 'string' then return {'invalid'} end
local size = redis.call('STRLEN', KEYS[1])
if size == 0 then return {'missing'} end
if size > tonumber(ARGV[1]) then return {'invalid'} end
local ttl = redis.call('PTTL', KEYS[1])
if ttl == -1 then return {'invalid'} end
if ttl <= 0 then return {'missing'} end
return {'value', redis.call('GET', KEYS[1]), ttl}`;

const count = z.number().int().nonnegative().safe();
const statusSchema = z.object({
  stage: z.literal('commercial-ai'),
  schemaVersion: z.literal(2),
  mode: z.literal('ENFORCE'),
  heartbeatAt: z.iso.datetime(),
  lastSuccessAt: z.iso.datetime().nullable(),
  active: count.max(4),
  outcomeBasis: z.literal('process_cumulative'),
  outcomes: z.record(z.string().max(80), count),
  pendingDiscardBasis: z.literal('redis_namespace_cumulative'),
  pendingDiscards: z
    .object({
      pending_expired: count.optional(),
      foreign_worker: count.optional(),
      invalid_pending: count.optional(),
    })
    .strict(),
  observationProcessId: z.uuid().optional(),
  observationStartedAt: z.iso.datetime().optional(),
  availabilityState: z.enum(['unknown', 'ready', 'governor_paused', 'headroom_paused']).optional(),
  availabilityObservedAt: z.iso.datetime().nullable().optional(),
});

type StatusRead =
  | { kind: 'missing' | 'invalid' | 'unavailable'; at: number }
  | { kind: 'value'; raw: string; ttl: number; at: number };

const resultKeys = {
  kept: 'kept',
  unsure: 'unsure',
  deleteRegistered: 'delete_registered',
  deleteNotAdmitted: 'delete_not_admitted',
  registrationUnknown: 'registration_unknown',
  capacitySkipped: 'secondary_capacity_skipped',
  unavailableSkipped: 'unavailable_skipped',
  sourceExpired: 'source_expired',
  pressureSkipped: 'pressure_skipped',
  dependencyUnavailable: 'dependency_unavailable',
} as const;

export function projectCommercialAiStatus(
  mode: SafetyDeskCommercialAiResponse['mode'],
  read: StatusRead | null,
  now: number,
): SafetyDeskCommercialAiResponse {
  const snapshot: SafetyDeskCommercialAiResponse = {
    schemaVersion: 1,
    generatedAt: new Date(now).toISOString(),
    observedAt: read ? new Date(read.at).toISOString() : null,
    mode,
    availability: mode === 'OFF' ? 'DISABLED' : mode === 'OBSERVE' ? 'OBSERVING' : 'UNAVAILABLE',
    heartbeatAt: null,
    lastRecordedResultAt: null,
    observationStartedAt: null,
    observationProcessId: null,
    active: null,
    admission: 'UNKNOWN',
    admissionObservedAt: null,
    outcomeBasis: 'PROCESS_CUMULATIVE',
    outcomes: null,
    pendingDiscardBasis: 'REDIS_NAMESPACE_CUMULATIVE',
    pendingDiscards: null,
    trafficCoverage: 'NOT_ESTABLISHED',
    confirmedDeletes: null,
  };
  if (mode !== 'DELETE_ONLY' || !read) return snapshot;
  if (read.kind !== 'value') {
    snapshot.availability = { missing: 'MISSING', invalid: 'INVALID', unavailable: 'UNAVAILABLE' }[
      read.kind
    ] as SafetyDeskCommercialAiResponse['availability'];
    return snapshot;
  }
  try {
    if (
      Buffer.byteLength(read.raw, 'utf8') > COMMERCIAL_AI_STATUS_MAX_BYTES ||
      !Number.isSafeInteger(read.ttl) ||
      read.ttl <= 0 ||
      read.ttl > FRESH_MS
    )
      throw new Error();
    const status = statusSchema.parse(JSON.parse(read.raw));
    const heartbeat = Date.parse(status.heartbeatAt);
    const started = status.observationStartedAt ? Date.parse(status.observationStartedAt) : null;
    const lastSuccess = status.lastSuccessAt ? Date.parse(status.lastSuccessAt) : null;
    const admissionAt = status.availabilityObservedAt
      ? Date.parse(status.availabilityObservedAt)
      : null;
    if (
      heartbeat > read.at + 5_000 ||
      read.at > now + 5_000 ||
      (started !== null && started > heartbeat) ||
      (lastSuccess !== null &&
        (lastSuccess > heartbeat || (started !== null && lastSuccess < started))) ||
      (admissionAt !== null &&
        (admissionAt > heartbeat || (started !== null && admissionAt < started))) ||
      Boolean(status.observationProcessId) !== Boolean(status.observationStartedAt)
    )
      throw new Error();
    const values = Object.values(status.outcomes);
    if (values.length > 64 || !Number.isSafeInteger(values.reduce((sum, value) => sum + value, 0)))
      throw new Error();
    const known = new Set<string>(Object.values(resultKeys));
    const outcomes = Object.fromEntries(
      Object.entries(resultKeys).map(([key, value]) => [key, status.outcomes[value] ?? 0]),
    );
    snapshot.availability =
      now - heartbeat >= FRESH_MS || now - read.at >= read.ttl ? 'STALE' : 'FRESH';
    snapshot.heartbeatAt = status.heartbeatAt;
    snapshot.lastRecordedResultAt = status.lastSuccessAt;
    snapshot.observationStartedAt = status.observationStartedAt ?? null;
    snapshot.observationProcessId = status.observationProcessId ?? null;
    snapshot.active = status.active;
    snapshot.outcomes = {
      ...outcomes,
      other: Object.entries(status.outcomes).reduce(
        (sum, [key, value]) => sum + (known.has(key) ? 0 : value),
        0,
      ),
    } as SafetyDeskCommercialAiResponse['outcomes'];
    snapshot.pendingDiscards = {
      expired: status.pendingDiscards.pending_expired ?? 0,
      foreignWorker: status.pendingDiscards.foreign_worker ?? 0,
      invalidPending: status.pendingDiscards.invalid_pending ?? 0,
    };
    // FLAG: Governor eligibility is a timestamped observation, not model health or fleet coverage.
    // Never present an old eligibility decision as current just because the worker heartbeat is fresh.
    if (snapshot.availability === 'FRESH' && admissionAt !== null && now - admissionAt < FRESH_MS) {
      snapshot.admissionObservedAt = status.availabilityObservedAt!;
      snapshot.admission = {
        unknown: 'UNKNOWN',
        ready: 'READY',
        governor_paused: 'GOVERNOR_PAUSED',
        headroom_paused: 'HEADROOM_PAUSED',
      }[status.availabilityState ?? 'unknown'] as SafetyDeskCommercialAiResponse['admission'];
    }
    return safetyDeskCommercialAiResponseSchema.parse(snapshot);
  } catch {
    return {
      ...snapshot,
      availability: 'INVALID',
      heartbeatAt: null,
      lastRecordedResultAt: null,
      observationStartedAt: null,
      observationProcessId: null,
      active: null,
      admission: 'UNKNOWN',
      admissionObservedAt: null,
      outcomes: null,
      pendingDiscards: null,
    };
  }
}

@Injectable()
export class SafetyDeskCommercialAiService implements OnModuleDestroy {
  private redis: Redis | null = null;
  private cached: StatusRead | null = null;
  private inFlight: Promise<StatusRead> | null = null;
  private stopping = false;

  constructor(private readonly config: ConfigService) {}

  async getSnapshot(): Promise<SafetyDeskCommercialAiResponse> {
    const mode =
      this.config.get<boolean>('COMMERCIAL_LLM_ENFORCEMENT_ENABLED') === true
        ? 'DELETE_ONLY'
        : this.config.get<boolean>('COMMERCIAL_LLM_SHADOW_ENABLED') === true
          ? 'OBSERVE'
          : 'OFF';
    if (mode !== 'DELETE_ONLY') return projectCommercialAiStatus(mode, null, Date.now());
    const now = Date.now();
    if (this.stopping)
      return projectCommercialAiStatus(mode, { kind: 'unavailable', at: now }, now);
    if (this.cached && now >= this.cached.at && now - this.cached.at < CACHE_MS)
      return projectCommercialAiStatus(mode, this.cached, now);
    if (!this.inFlight) {
      const request = this.readStatus().then((read) => {
        if (!this.stopping) this.cached = read;
        return read;
      });
      this.inFlight = request;
      void request.finally(() => {
        if (this.inFlight === request) this.inFlight = null;
      });
    }
    const read = await this.inFlight;
    return projectCommercialAiStatus(mode, read, Date.now());
  }

  private async readStatus(): Promise<StatusRead> {
    try {
      if (this.stopping) throw new Error();
      if (!this.redis || this.redis.status !== 'ready') {
        this.redis?.disconnect();
        this.redis = createCommercialLlmRedis(this.config.getOrThrow<string>('REDIS_URL'));
        await this.redis.connect();
      }
      if (this.stopping) throw new Error();
      const poolEnabled =
        this.config.get<boolean>('COMMERCIAL_LLM_POOL_ENABLED') === true &&
        this.config.get<boolean>('COMMERCIAL_LLM_POOL_WORKERS_ENABLED') === true;
      const reply: unknown = await this.redis.eval(
        READ_COMMERCIAL_AI_STATUS,
        1,
        (poolEnabled ? COMMERCIAL_LLM_POOL_ADMISSION_KEYS : COMMERCIAL_LLM_ENFORCEMENT_KEYS).status,
        COMMERCIAL_AI_STATUS_MAX_BYTES,
      );
      const at = Date.now();
      if (!Array.isArray(reply)) return { kind: 'invalid', at };
      if (reply[0] === 'missing' || reply[0] === 'invalid') return { kind: reply[0], at };
      if (reply[0] !== 'value' || typeof reply[1] !== 'string' || typeof reply[2] !== 'number')
        return { kind: 'invalid', at };
      return { kind: 'value', raw: reply[1], ttl: reply[2], at };
    } catch {
      // FLAG: Diagnostic errors may contain credentials. Emit only a finite unavailable state.
      return { kind: 'unavailable', at: Date.now() };
    }
  }

  onModuleDestroy(): void {
    this.stopping = true;
    this.cached = null;
    this.redis?.disconnect();
  }
}
