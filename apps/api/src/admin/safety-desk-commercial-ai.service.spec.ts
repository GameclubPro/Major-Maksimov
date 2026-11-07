import { ConfigService } from '@nestjs/config';
import type Redis from 'ioredis';
import { createCommercialLlmRedis } from '../moderation/commercial/commercial-llm-shadow.lease';
import { COMMERCIAL_LLM_ENFORCEMENT_KEYS } from '../moderation/commercial/commercial-llm-enforcement.mailbox';
import { COMMERCIAL_LLM_POOL_ADMISSION_KEYS } from '../moderation/commercial/commercial-llm-pool-admission.mailbox';
import {
  COMMERCIAL_AI_STATUS_MAX_BYTES,
  READ_COMMERCIAL_AI_STATUS,
  SafetyDeskCommercialAiService,
  projectCommercialAiStatus,
} from './safety-desk-commercial-ai.service';

jest.mock('../moderation/commercial/commercial-llm-shadow.lease', () => ({
  createCommercialLlmRedis: jest.fn(),
}));

const now = Date.parse('2026-10-28T00:00:00.000Z');
const iso = (offset = 0) => new Date(now + offset).toISOString();
function status(overrides: Record<string, unknown> = {}) {
  return {
    stage: 'commercial-ai',
    schemaVersion: 2,
    mode: 'ENFORCE',
    heartbeatAt: iso(),
    lastSuccessAt: iso(-1000),
    active: 1,
    observationProcessId: 'c4a57d04-4d26-49ab-a2c1-7421a1567009',
    observationStartedAt: iso(-60000),
    availabilityState: 'ready',
    availabilityObservedAt: iso(-500),
    outcomeBasis: 'process_cumulative',
    outcomes: {
      kept: 3,
      unsure: 2,
      delete_registered: 1,
      delete_not_admitted: 2,
      registration_unknown: 1,
      secondary_capacity_skipped: 4,
      future_reason: 2,
    },
    pendingDiscardBasis: 'redis_namespace_cumulative',
    pendingDiscards: { pending_expired: 4, foreign_worker: 2, invalid_pending: 1 },
    ...overrides,
  };
}
const read = (value: unknown = status(), at = now, ttl = 30000) => ({
  kind: 'value' as const,
  raw: JSON.stringify(value),
  ttl,
  at,
});

describe('commercial AI bounded public projection', () => {
  it('separates registered effects, missing coverage and independently scoped counters', () => {
    const result = projectCommercialAiStatus('DELETE_ONLY', read(), now);
    expect(result).toMatchObject({
      availability: 'FRESH',
      admission: 'READY',
      lastRecordedResultAt: iso(-1000),
      observationStartedAt: iso(-60000),
      trafficCoverage: 'NOT_ESTABLISHED',
      confirmedDeletes: null,
      outcomeBasis: 'PROCESS_CUMULATIVE',
      outcomes: {
        kept: 3,
        unsure: 2,
        deleteRegistered: 1,
        deleteNotAdmitted: 2,
        registrationUnknown: 1,
        capacitySkipped: 4,
        unavailableSkipped: 0,
        other: 2,
      },
      pendingDiscardBasis: 'REDIS_NAMESPACE_CUMULATIVE',
      pendingDiscards: { expired: 4, foreignWorker: 2, invalidPending: 1 },
    });
  });

  it('accepts legacy status without fabricating a process generation or admission', () => {
    const legacy = status();
    for (const key of [
      'observationProcessId',
      'observationStartedAt',
      'availabilityState',
      'availabilityObservedAt',
    ])
      delete (legacy as Record<string, unknown>)[key];
    expect(projectCommercialAiStatus('DELETE_ONLY', read(legacy), now)).toMatchObject({
      availability: 'FRESH',
      observationProcessId: null,
      observationStartedAt: null,
      admission: 'UNKNOWN',
      admissionObservedAt: null,
    });
  });

  it.each([0, 3, 4])('preserves %i active slots without making a coverage claim', (active) => {
    expect(projectCommercialAiStatus('DELETE_ONLY', read(status({ active })), now)).toMatchObject({
      availability: 'FRESH',
      active,
      trafficCoverage: 'NOT_ESTABLISHED',
      confirmedDeletes: null,
    });
  });

  it('expires a cached sample and the independent admission observation', () => {
    expect(projectCommercialAiStatus('DELETE_ONLY', read(), now + 30000)).toMatchObject({
      availability: 'STALE',
      admission: 'UNKNOWN',
      admissionObservedAt: null,
      outcomes: { deleteRegistered: 1 },
    });
    expect(
      projectCommercialAiStatus('DELETE_ONLY', read(status(), now, 500), now + 500).availability,
    ).toBe('STALE');
    expect(
      projectCommercialAiStatus(
        'DELETE_ONLY',
        read(status({ availabilityObservedAt: iso(-30000) })),
        now,
      ),
    ).toMatchObject({
      availability: 'FRESH',
      admission: 'UNKNOWN',
      admissionObservedAt: null,
    });
  });

  it.each(['OFF', 'OBSERVE'] as const)('does not use enforcement evidence in mode %s', (mode) => {
    expect(projectCommercialAiStatus(mode, null, now)).toMatchObject({
      availability: mode === 'OFF' ? 'DISABLED' : 'OBSERVING',
      outcomes: null,
      heartbeatAt: null,
      admission: 'UNKNOWN',
    });
  });

  it.each(['missing', 'invalid', 'unavailable'] as const)(
    'preserves %s without fabricated zeroes',
    (kind) => {
      expect(projectCommercialAiStatus('DELETE_ONLY', { kind, at: now }, now)).toMatchObject({
        availability: kind.toUpperCase(),
        outcomes: null,
        active: null,
        pendingDiscards: null,
        lastRecordedResultAt: null,
      });
    },
  );

  it.each([
    { schemaVersion: 1 },
    { active: 5 },
    { heartbeatAt: iso(5001) },
    { observationStartedAt: iso(1) },
    { observationProcessId: undefined },
    { lastSuccessAt: iso(1) },
    { lastSuccessAt: iso(-60001) },
    { availabilityObservedAt: iso(1) },
    { availabilityObservedAt: iso(-60001) },
    { outcomes: { kept: -1 } },
    { outcomes: { kept: Number.MAX_SAFE_INTEGER, unsure: 1 } },
    { outcomes: Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`reason${i}`, 1])) },
    { pendingDiscards: { pending_expired: 0.5 } },
  ])('fails closed on malformed or contradictory producer data %j', (override) => {
    expect(projectCommercialAiStatus('DELETE_ONLY', read(status(override)), now)).toMatchObject({
      availability: 'INVALID',
      heartbeatAt: null,
      outcomes: null,
      active: null,
      admission: 'UNKNOWN',
      pendingDiscards: null,
    });
  });

  it('rejects oversized, non-expiring and future observations without echoing data', () => {
    for (const sample of [
      { ...read(), raw: 'private:' + 'x'.repeat(COMMERCIAL_AI_STATUS_MAX_BYTES) },
      { ...read(), raw: 'secret malformed json' },
      read(status(), now, -1),
      read(status(), now, 30001),
      read(status(), now + 5001),
    ]) {
      const result = projectCommercialAiStatus('DELETE_ONLY', sample, now);
      expect(result.availability).toBe('INVALID');
      expect(JSON.stringify(result)).not.toMatch(/private|secret/);
    }
    const result = projectCommercialAiStatus(
      'DELETE_ONLY',
      read(
        status({
          worker: 'lease-secret',
          excerpt: 'private-message',
          botToken: 'bot-secret',
        }),
      ),
      now,
    );
    expect(result.availability).toBe('FRESH');
    expect(JSON.stringify(result)).not.toMatch(/lease-secret|private-message|bot-secret/);
  });
});

describe('SafetyDeskCommercialAiService', () => {
  afterEach(() => jest.restoreAllMocks());
  function harness(enabled = true, shadow = false, pool = false, workers = false) {
    const redis = {
      status: 'ready',
      connect: jest.fn<ReturnType<Redis['connect']>, []>().mockResolvedValue(),
      disconnect: jest.fn<ReturnType<Redis['disconnect']>, []>(),
      eval: jest.fn<Promise<unknown>, [string, number, string, number]>(),
    };
    jest
      .mocked(createCommercialLlmRedis)
      .mockClear()
      .mockReturnValue(redis as unknown as Redis);
    const service = new SafetyDeskCommercialAiService(
      new ConfigService({
        COMMERCIAL_LLM_ENFORCEMENT_ENABLED: enabled,
        COMMERCIAL_LLM_SHADOW_ENABLED: shadow,
        COMMERCIAL_LLM_POOL_ENABLED: pool,
        COMMERCIAL_LLM_POOL_WORKERS_ENABLED: workers,
        REDIS_URL: 'redis://synthetic.invalid',
      }),
    );
    return { service, redis };
  }

  it('coalesces reads, caps the exact key and recomputes freshness before cache reuse', async () => {
    const clock = jest.spyOn(Date, 'now').mockReturnValue(now);
    const { service, redis } = harness();
    redis.eval.mockResolvedValue([
      'value',
      JSON.stringify(
        status({ heartbeatAt: iso(-29500), lastSuccessAt: null, availabilityObservedAt: null }),
      ),
      30000,
    ]);
    const results = await Promise.all([service.getSnapshot(), service.getSnapshot()]);
    expect(results.map((x) => x.availability)).toEqual(['FRESH', 'FRESH']);
    expect(redis.eval).toHaveBeenCalledTimes(1);
    expect(redis.eval).toHaveBeenCalledWith(
      READ_COMMERCIAL_AI_STATUS,
      1,
      COMMERCIAL_LLM_ENFORCEMENT_KEYS.status,
      COMMERCIAL_AI_STATUS_MAX_BYTES,
    );
    clock.mockReturnValue(now + 500);
    expect((await service.getSnapshot()).availability).toBe('STALE');
    expect(redis.eval).toHaveBeenCalledTimes(1);
    clock.mockReturnValue(now + 2000);
    redis.eval.mockResolvedValue(['missing']);
    expect((await service.getSnapshot()).availability).toBe('MISSING');
    expect(redis.eval).toHaveBeenCalledTimes(2);
    service.onModuleDestroy();
  });

  it.each([
    [true, true, COMMERCIAL_LLM_POOL_ADMISSION_KEYS.status],
    [false, true, COMMERCIAL_LLM_ENFORCEMENT_KEYS.status],
    [true, false, COMMERCIAL_LLM_ENFORCEMENT_KEYS.status],
  ] as const)(
    'reads only the active namespace for routing=%s/workers=%s',
    async (pool, workers, key) => {
      const { service, redis } = harness(true, false, pool, workers);
      redis.eval.mockResolvedValue(['missing']);
      expect((await service.getSnapshot()).availability).toBe('MISSING');
      expect(redis.eval).toHaveBeenCalledTimes(1);
      expect(redis.eval).toHaveBeenCalledWith(
        READ_COMMERCIAL_AI_STATUS,
        1,
        key,
        COMMERCIAL_AI_STATUS_MAX_BYTES,
      );
      service.onModuleDestroy();
    },
  );

  it.each([
    [false, false, 'DISABLED'],
    [false, true, 'OBSERVING'],
  ] as const)('does not connect for configuration %s/%s', async (enabled, shadow, availability) => {
    const { service } = harness(enabled, shadow);
    expect((await service.getSnapshot()).availability).toBe(availability);
    expect(createCommercialLlmRedis).not.toHaveBeenCalled();
  });

  it('contains Redis failures and does not reuse cached health after shutdown', async () => {
    const { service, redis } = harness();
    redis.eval.mockRejectedValue(new Error('redis://secret:password@private'));
    const result = await service.getSnapshot();
    expect(result.availability).toBe('UNAVAILABLE');
    expect(JSON.stringify(result)).not.toMatch(/secret|password|private/);
    service.onModuleDestroy();
    expect((await service.getSnapshot()).availability).toBe('UNAVAILABLE');
    expect(redis.eval).toHaveBeenCalledTimes(1);
    expect(redis.disconnect).toHaveBeenCalled();
  });
});
