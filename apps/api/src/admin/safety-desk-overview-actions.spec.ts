import {
  projectOverviewActions,
  type OverviewActionRow,
} from './safety-desk-overview-actions.service';

const at = new Date('2026-11-04T12:00:00.000Z');
function row(duration: number, patch: Partial<OverviewActionRow> = {}): OverviewActionRow {
  return {
    botId: 'major',
    status: 'SUCCEEDED',
    completedAt: at,
    enqueuedAt: new Date(at.getTime() - duration),
    scheduledFor: null,
    timingMetadataInspected: true,
    ...patch,
  };
}

describe('bounded overview terminal latency projection', () => {
  it('includes terminal failures and scheduled readiness while preserving missing clocks and legacy bot mapping', () => {
    const snapshot = projectOverviewActions(
      [
        row(1000),
        row(100000, {
          status: 'FAILED_TERMINAL',
          scheduledFor: new Date(at.getTime() - 2000).toISOString(),
        }),
        row(3000, { botId: null }),
        row(0, { enqueuedAt: null }),
        row(0, { enqueuedAt: null, scheduledFor: new Date(at.getTime() - 4000).toISOString() }),
      ],
      at,
      ['major', 'quiet'],
      'major',
    );
    expect(snapshot.actions.latency).toEqual({
      sampleCount: 4,
      p50Ms: 2000,
      p95Ms: 4000,
      p99Ms: 4000,
    });
    expect(snapshot.bots[0]?.outcomes).toContainEqual({ outcome: 'FAILED_TERMINAL', count: 1 });
    expect(snapshot.bots[1]).toMatchObject({
      lastTerminalAt: null,
      latency: { sampleCount: 0, p50Ms: null },
    });
  });
  it('bounds the sample and never represents a truncated cohort as complete', () => {
    const snapshot = projectOverviewActions(
      Array.from({ length: 5001 }, () => row(3)),
      at,
      ['major'],
      'major',
    );
    expect(snapshot.actions).toMatchObject({ sampleCount: 5000, sampleComplete: false });
  });
  it('rejects nonterminal states in terminal evidence and excludes negative clocks', () => {
    expect(() =>
      projectOverviewActions([row(1, { status: 'IN_PROGRESS' })], at, ['major'], 'major'),
    ).toThrow('Invalid terminal');
    expect(
      projectOverviewActions([row(-1)], at, ['major'], 'major').actions.latency.sampleCount,
    ).toBe(0);
  });
  it('retains outcomes but excludes unknown or invalid schedule evidence instead of using enqueue latency', () => {
    const snapshot = projectOverviewActions(
      [
        row(1000),
        row(5000, { timingMetadataInspected: false }),
        row(6000, { scheduledFor: 'invalid-clock' }),
        row(7000, { scheduledFor: '' }),
      ],
      at,
      ['major'],
      'major',
    );
    expect(snapshot.actions.sampleCount).toBe(4);
    expect(snapshot.actions.outcomes).toEqual([{ outcome: 'SUCCEEDED', count: 4 }]);
    expect(snapshot.actions.latency).toEqual({
      sampleCount: 1,
      p50Ms: 1000,
      p95Ms: 1000,
      p99Ms: 1000,
    });
  });
});
