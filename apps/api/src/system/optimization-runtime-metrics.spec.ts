import {
  OptimizationRuntimeMetrics,
  sanitizeOptimizationRuntimeMetrics,
} from './optimization-runtime-metrics';

describe('bounded optimization observations', () => {
  it('keeps missing and corrupt coverage unavailable and strips arbitrary dimensions', () => {
    const metrics = new OptimizationRuntimeMetrics();
    const snapshot = metrics.snapshot()!;
    expect(sanitizeOptimizationRuntimeMetrics(undefined)).toBeNull();
    expect(sanitizeOptimizationRuntimeMetrics({ ...snapshot, demand: {} })).toBeNull();
    expect(
      sanitizeOptimizationRuntimeMetrics({
        ...snapshot,
        payload: 'private',
        authors: { ...snapshot.authors, private: {} },
      }),
    ).toEqual(snapshot);
    expect(
      sanitizeOptimizationRuntimeMetrics({
        ...snapshot,
        timings: { ...snapshot.timings, sendHttp: { ...snapshot.timings.sendHttp, calls: -1 } },
      }),
    ).toBeNull();
  });
  it('separates failures and unknown clocks from measured duration without retaining samples', () => {
    const metrics = new OptimizationRuntimeMetrics();
    for (const ms of [0, 99, 100, 499, 500, 1999, 2000, 9999, 10000])
      metrics.timing('sendHttp', ms);
    metrics.timing('sendHttp', null, true);
    metrics.timing('sendHttp', -1, true);
    metrics.timing('sendHttp', NaN);
    const counts = metrics.snapshot()!.timings.sendHttp!;
    expect(counts).toMatchObject({
      calls: 12,
      errors: 2,
      unknownClock: 3,
      maxMs: 10000,
      under100Ms: 2,
      under500Ms: 2,
      under2000Ms: 2,
      under10000Ms: 2,
      atLeast10000Ms: 1,
    });
    metrics.timing('sendHttp', Number.MAX_SAFE_INTEGER);
    expect(metrics.snapshot()!.timings.sendHttp!.totalMs).toBe(Number.MAX_SAFE_INTEGER);
  });
  it('admits fixed rule and source phases while preserving unavailable older coverage', () => {
    const metrics = new OptimizationRuntimeMetrics();
    metrics.ruleStage('links', 126);
    metrics.ruleStage('private-chat-id', 5000);
    metrics.contextLoad('coldLoad', 250, true);
    metrics.contextLoad('candidateLoad', null);
    const snapshot = metrics.snapshot()!;
    expect(snapshot.ruleStages!.links).toMatchObject({ calls: 1, under500Ms: 1, totalMs: 126 });
    expect(snapshot.contextSource!.coldLoad).toMatchObject({ calls: 1, errors: 1, under500Ms: 1 });
    expect(snapshot.contextSource!.candidateLoad).toMatchObject({ calls: 1, unknownClock: 1 });
    expect(JSON.stringify(snapshot)).not.toContain('private-chat-id');
    const legacy = {
      authors: snapshot.authors,
      roster: snapshot.roster,
      demand: snapshot.demand,
      timings: snapshot.timings,
    };
    expect(sanitizeOptimizationRuntimeMetrics(legacy)).toEqual({
      ...legacy,
      ruleStages: null,
      contextSource: null,
    });
    expect(sanitizeOptimizationRuntimeMetrics({ ...snapshot, ruleStages: {} })).toEqual({
      ...snapshot,
      ruleStages: null,
    });
  });
});
