import { describe, expect, it } from 'vitest';
import { safetyDeskCommercialAiResponseSchema } from '../src/safety-desk';

const unavailable = {
  schemaVersion: 1,
  generatedAt: '2026-10-28T00:00:00.000Z',
  observedAt: null,
  mode: 'DELETE_ONLY',
  availability: 'UNAVAILABLE',
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

describe('commercial AI observation contract', () => {
  it('preserves missing evidence instead of defaulting to zero or healthy', () => {
    expect(safetyDeskCommercialAiResponseSchema.parse(unavailable)).toEqual(unavailable);
  });
  it.each([0, 3, 4])('accepts %i observed active slots', (active) => {
    expect(safetyDeskCommercialAiResponseSchema.parse({ ...unavailable, active }).active).toBe(
      active,
    );
  });
  it.each([
    { confirmedDeletes: 1 },
    { trafficCoverage: 1 },
    { outcomeBasis: 'ALL_TRAFFIC' },
    { observationProcessId: 'private-worker-lease' },
    { token: 'secret' },
    { active: -1 },
    { active: 5 },
    { availability: 'HEALTHY' },
  ])('rejects unsupported success/privacy claims %j', (patch) => {
    expect(
      safetyDeskCommercialAiResponseSchema.safeParse({ ...unavailable, ...patch }).success,
    ).toBe(false);
  });
});
