import { describe, it, expect } from 'vitest';
import {
  safetyDeskOverviewResponseSchema,
  type SafetyDeskOverviewResponse,
} from '../src/safety-desk';

const at = '2026-11-04T12:00:00.000Z';
function sample(): SafetyDeskOverviewResponse {
  const unavailable = { availability: 'UNAVAILABLE' as const, observedAt: null, value: null };
  return {
    schemaVersion: 1,
    generatedAt: at,
    collector: { availability: 'UNAVAILABLE', observedAt: null, lastSuccessfulAt: null },
    queues: unavailable,
    receipts: unavailable,
    unfinishedActions: unavailable,
    actions: unavailable,
    workers: unavailable,
    bots: [],
    history: {
      availability: 'UNAVAILABLE',
      observedAt: null,
      windowSec: 86400,
      bucketSec: 60,
      retentionPoints: 1440,
      points: [],
    },
  };
}
describe('Safety Desk overview evidence contract', () => {
  it('preserves unavailable sources and honest partial pending evidence', () => {
    const value = sample();
    value.unfinishedActions = {
      availability: 'FRESH',
      observedAt: at,
      value: {
        countLowerBound: 0,
        sampleComplete: false,
        oldestAgeMs: null,
        ageBasis: 'state_updated_sample',
      },
    };
    expect(safetyDeskOverviewResponseSchema.parse(value)).toEqual(value);
  });
  it('rejects missing fresh evidence, fabricated unavailable counts and unbounded history', () => {
    expect(
      safetyDeskOverviewResponseSchema.safeParse({
        ...sample(),
        receipts: { availability: 'FRESH', observedAt: at, value: null },
      }).success,
    ).toBe(false);
    expect(
      safetyDeskOverviewResponseSchema.safeParse({
        ...sample(),
        queues: { availability: 'UNAVAILABLE', observedAt: null, value: { rows: [] } },
      }).success,
    ).toBe(false);
    expect(
      safetyDeskOverviewResponseSchema.safeParse({
        ...sample(),
        history: { ...sample().history, retentionPoints: 1441 },
      }).success,
    ).toBe(false);
  });
  it('rejects negative counters, nonmonotonic percentiles, and runtime secrets', () => {
    const base = sample();
    const actions = {
      availability: 'FRESH',
      observedAt: at,
      value: {
        windowSec: 900,
        windowStartedAt: at,
        windowEndedAt: at,
        sampleCount: 1,
        sampleComplete: true,
        latency: { sampleCount: 1, p50Ms: 20, p95Ms: 10, p99Ms: 30 },
        outcomes: [],
      },
    };
    expect(safetyDeskOverviewResponseSchema.safeParse({ ...base, actions }).success).toBe(false);
    expect(safetyDeskOverviewResponseSchema.safeParse({ ...base, token: 'secret' }).success).toBe(
      false,
    );
    expect(
      safetyDeskOverviewResponseSchema.safeParse({
        ...base,
        unfinishedActions: {
          availability: 'FRESH',
          observedAt: at,
          value: {
            countLowerBound: -1,
            sampleComplete: true,
            oldestAgeMs: null,
            ageBasis: 'state_updated_sample',
          },
        },
      }).success,
    ).toBe(false);
  });
});
