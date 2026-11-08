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
});
