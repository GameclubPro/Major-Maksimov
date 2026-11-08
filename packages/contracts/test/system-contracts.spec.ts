import { describe, expect, it } from 'vitest';
import {
  systemDashboardActionLatencySchema,
  systemDashboardWebhookIngressSloSchema,
  systemModeSnapshotSchema,
} from '../src/system.js';

const emptyPercentiles = {
  sampleCount: 0,
  p50Ms: null,
  p95Ms: null,
  p99Ms: null,
};

const populatedPercentiles = {
  sampleCount: 2,
  p50Ms: 100,
  p95Ms: 200,
  p99Ms: 200,
};

function createActionGroup(key: string, rowCount = 2) {
  return {
    key,
    rowCount,
    effectiveReadyToLastAttempt: populatedPercentiles,
    lastAttemptToTerminal: populatedPercentiles,
    effectiveReadyToTerminal: populatedPercentiles,
  };
}

function createDeleteGroup(key: string, rowCount = 2) {
  return {
    key,
    rowCount,
    messageToFirstAttempt: populatedPercentiles,
    firstAttemptToTerminal: populatedPercentiles,
    messageToTerminal: populatedPercentiles,
  };
}

function createSnapshot() {
  return {
    basis: 'terminal_outcomes' as const,
    windowBasis: 'completed_at' as const,
    actionStartBasis: 'max_enqueued_at_scheduled_for' as const,
    windowSec: 900,
    windowStartedAt: '2026-08-15T11:45:00.000Z',
    sampleLimit: 5_000,
    actionSampleCount: 0,
    actionSampleTruncated: false,
    actionSampledFrom: null,
    overall: {
      effectiveReadyToLastAttempt: emptyPercentiles,
      lastAttemptToTerminal: emptyPercentiles,
      effectiveReadyToTerminal: emptyPercentiles,
    },
    byAction: [],
    byOutcome: [],
    bySource: [],
    byBot: [],
    byTrafficClass: [],
    moderationDelete: {
      sampleCount: 0,
      sampleTruncated: false,
      sampledFrom: null,
      overall: {
        messageToFirstAttempt: emptyPercentiles,
        firstAttemptToTerminal: emptyPercentiles,
        messageToTerminal: emptyPercentiles,
      },
      byOutcome: [],
    },
    generatedAt: '2026-08-15T12:00:00.000Z',
  };
}

function createPopulatedSnapshot() {
  return {
    ...createSnapshot(),
    actionSampleCount: 2,
    actionSampledFrom: '2026-08-15T11:59:00.000Z',
    overall: {
      effectiveReadyToLastAttempt: populatedPercentiles,
      lastAttemptToTerminal: populatedPercentiles,
      effectiveReadyToTerminal: populatedPercentiles,
    },
    byAction: [createActionGroup('SEND_MESSAGE')],
    byOutcome: [createActionGroup('SUCCEEDED')],
    bySource: [createActionGroup('moderation')],
    byBot: [createActionGroup('bot-1')],
    byTrafficClass: [createActionGroup('critical')],
    moderationDelete: {
      sampleCount: 2,
      sampleTruncated: false,
      sampledFrom: '2026-08-15T11:58:30.000Z',
      overall: {
        messageToFirstAttempt: populatedPercentiles,
        firstAttemptToTerminal: populatedPercentiles,
        messageToTerminal: populatedPercentiles,
      },
      byOutcome: [createDeleteGroup('SUCCEEDED')],
    },
  };
}

function expectRejectedAt(value: unknown, path: Array<string | number>) {
  const result = systemDashboardActionLatencySchema.safeParse(value);
  expect(result.success).toBe(false);
  if (!result.success) {
    expect(result.error.issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ path })]),
    );
  }
}

describe('system dashboard contracts', () => {
  it('accepts optional clock coverage while preserving older snapshots', () => {
    const snapshot = createPopulatedSnapshot();
    expect(systemDashboardActionLatencySchema.safeParse(snapshot).success).toBe(true);
    const withCoverage = {
      ...snapshot,
      readiness: [{ state: 'KNOWN', count: 2 }],
      scheduleClockBasis: 'scalar_with_bounded_legacy_fallback',
      enqueueClockBasis: 'latest_accepted_queue_or_direct_invocation',
      overall: {
        ...snapshot.overall,
        effectiveReadyToTerminal: { ...populatedPercentiles, excludedCount: 0 },
      },
    };
    expect(systemDashboardActionLatencySchema.safeParse(withCoverage).success).toBe(true);
    expectRejectedAt({ ...withCoverage, readiness: [{ state: 'KNOWN', count: 1 }] }, ['readiness']);
    expectRejectedAt(
      {
        ...withCoverage,
        readiness: [
          { state: 'KNOWN', count: 1 },
          { state: 'KNOWN', count: 1 },
        ],
      },
      ['readiness'],
    );
    expectRejectedAt(
      {
        ...withCoverage,
        overall: {
          ...withCoverage.overall,
          effectiveReadyToTerminal: { ...populatedPercentiles, excludedCount: 1 },
        },
      },
      ['overall', 'effectiveReadyToTerminal', 'excludedCount'],
    );
    expectRejectedAt(
      {
        ...snapshot,
        byAction: [
          {
            ...createActionGroup('SEND_MESSAGE'),
            effectiveReadyToTerminal: { ...populatedPercentiles, excludedCount: 1 },
          },
        ],
      },
      ['byAction', 0, 'effectiveReadyToTerminal', 'excludedCount'],
    );
  });

  it('classifies system mode while accepting legacy snapshots without a condition', () => {
    const legacy = {
      mode: 'degrade',
      source: 'auto',
      reason: 'legacy snapshot',
      updatedAt: '2026-08-15T12:00:00.000Z',
      manualMode: null,
      queueLagSec: 12,
      action: {
        windowSec: 60,
        total: 0,
        success: 0,
        failure: 0,
        critical: 0,
        errorRate: 0,
        criticalRate: 0,
      },
    };

    expect(systemModeSnapshotSchema.parse(legacy).condition).toBe('unknown');
    expect(
      systemModeSnapshotSchema.parse({ ...legacy, condition: 'queue_backlog' }).condition,
    ).toBe('queue_backlog');
  });

  it('defaults admission rejects for webhook ingress snapshots from older API versions', () => {
    expect(
      systemDashboardWebhookIngressSloSchema.parse({
        available: true,
        targetMs: 2_000,
        attemptedReceipts: 1,
        persistedReceipts: 1,
        failedReceipts: 0,
        sampledReceipts: 1,
        p95LatencyMs: 10,
        p99LatencyMs: 10,
        underTargetRatio: 1,
        bots: {
          'bot-1': {
            attemptedReceipts: 1,
            persistedReceipts: 1,
            failedReceipts: 0,
          },
        },
      }),
    ).toMatchObject({
      rejectedReceipts: 0,
      bots: { 'bot-1': { rejectedReceipts: 0 } },
    });
  });

  it('accepts bounded action latency snapshots', () => {
    expect(systemDashboardActionLatencySchema.parse(createSnapshot())).toMatchObject({
      actionStartBasis: 'max_enqueued_at_scheduled_for',
      sampleLimit: 5_000,
      actionSampleCount: 0,
    });
    expect(systemDashboardActionLatencySchema.parse(createPopulatedSnapshot())).toMatchObject({
      actionSampleCount: 2,
      moderationDelete: { sampleCount: 2 },
    });
  });

  it('rejects unbounded or internally inconsistent samples', () => {
    expect(() =>
      systemDashboardActionLatencySchema.parse({
        ...createSnapshot(),
        sampleLimit: 5_001,
      }),
    ).toThrow();

    expect(() =>
      systemDashboardActionLatencySchema.parse({
        ...createSnapshot(),
        actionSampleCount: 1,
        actionSampledFrom: null,
      }),
    ).toThrow();

    expect(() =>
      systemDashboardActionLatencySchema.parse({
        ...createSnapshot(),
        overall: {
          ...createSnapshot().overall,
          effectiveReadyToLastAttempt: {
            sampleCount: 1,
            p50Ms: 500,
            p95Ms: 400,
            p99Ms: 600,
          },
        },
      }),
    ).toThrow();
  });

  it('rejects false truncation claims and timestamps outside the sample window', () => {
    expectRejectedAt(
      {
        ...createPopulatedSnapshot(),
        sampleLimit: 3,
        actionSampleTruncated: true,
      },
      ['actionSampleTruncated'],
    );
    expectRejectedAt(
      {
        ...createPopulatedSnapshot(),
        sampleLimit: 3,
        moderationDelete: {
          ...createPopulatedSnapshot().moderationDelete,
          sampleTruncated: true,
        },
      },
      ['moderationDelete', 'sampleTruncated'],
    );
    expectRejectedAt(
      {
        ...createPopulatedSnapshot(),
        windowStartedAt: '2026-08-15T12:00:01.000Z',
      },
      ['windowStartedAt'],
    );
    expectRejectedAt(
      {
        ...createPopulatedSnapshot(),
        windowSec: 60,
      },
      ['windowSec'],
    );
    expectRejectedAt(
      {
        ...createPopulatedSnapshot(),
        actionSampledFrom: '2026-08-15T12:00:01.000Z',
      },
      ['actionSampledFrom'],
    );
    expectRejectedAt(
      {
        ...createPopulatedSnapshot(),
        moderationDelete: {
          ...createPopulatedSnapshot().moderationDelete,
          sampledFrom: '2026-08-15T11:44:59.000Z',
        },
      },
      ['moderationDelete', 'sampledFrom'],
    );
  });

  it('rejects duplicate, incomplete, and metrically inconsistent group partitions', () => {
    const duplicateGroup = {
      ...createActionGroup('SEND_MESSAGE', 1),
      effectiveReadyToLastAttempt: { ...populatedPercentiles, sampleCount: 1 },
      lastAttemptToTerminal: { ...populatedPercentiles, sampleCount: 1 },
      effectiveReadyToTerminal: { ...populatedPercentiles, sampleCount: 1 },
    };
    expectRejectedAt(
      {
        ...createPopulatedSnapshot(),
        byAction: [duplicateGroup, duplicateGroup],
      },
      ['byAction', 1, 'key'],
    );
    expectRejectedAt(
      {
        ...createPopulatedSnapshot(),
        byBot: [{ ...createActionGroup('bot-1'), rowCount: 3 }],
      },
      ['byBot'],
    );
    expectRejectedAt(
      {
        ...createPopulatedSnapshot(),
        bySource: [
          {
            ...createActionGroup('moderation'),
            effectiveReadyToLastAttempt: { ...populatedPercentiles, sampleCount: 1 },
          },
        ],
      },
      ['bySource'],
    );
    expectRejectedAt(
      {
        ...createPopulatedSnapshot(),
        moderationDelete: {
          ...createPopulatedSnapshot().moderationDelete,
          byOutcome: [{ ...createDeleteGroup('SUCCEEDED'), rowCount: 3 }],
        },
      },
      ['moderationDelete', 'byOutcome'],
    );
  });
});
