import {
  OptimizationRuntimeMetrics,
  sanitizeOptimizationRuntimeMetrics,
} from './optimization-runtime-metrics';
import {
  RULE_COVERAGE_COUNTERS,
  RULE_COVERAGE_FAMILIES,
  RULE_COVERAGE_SCHEMA,
  createRuleEngineObservation,
} from '../moderation/rule-engine-observation';

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
    metrics.ruleStage('stop-words-policy', 12);
    metrics.ruleStage('media-cooldowns', null);
    metrics.ruleStage('private-chat-id', 5000);
    metrics.contextLoad('coldLoad', 250, true);
    metrics.contextLoad('candidateLoad', null);
    const snapshot = metrics.snapshot()!;
    expect(snapshot.ruleStages!.links).toMatchObject({ calls: 1, under500Ms: 1, totalMs: 126 });
    expect(snapshot.ruleSharedStages!['stop-words-policy']).toMatchObject({
      calls: 1,
      under100Ms: 1,
      totalMs: 12,
    });
    expect(snapshot.ruleSharedStages!['media-cooldowns']).toMatchObject({
      calls: 1,
      unknownClock: 1,
    });
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
      ruleSharedStages: null,
      ruleCoverage: null,
    });
    expect(sanitizeOptimizationRuntimeMetrics({ ...snapshot, ruleStages: {} })).toEqual({
      ...snapshot,
      ruleStages: null,
    });
    const previous = Object.fromEntries(
      Object.entries(snapshot).filter(
        ([key]) => !['ruleCoverage', 'ruleSharedStages'].includes(key),
      ),
    );
    expect(sanitizeOptimizationRuntimeMetrics(previous)).toEqual({
      ...snapshot,
      ruleSharedStages: null,
      ruleCoverage: null,
    });
  });
  it('aggregates each fixed coverage cell without retaining observers or private dimensions', () => {
    const metrics = new OptimizationRuntimeMetrics();
    const scope = createRuleEngineObservation();
    const links = scope.family('links');
    links.configured(true);
    links.eligible();
    links.finish({ kind: 'evaluated', matched: true });
    const coverage = scope.close();
    metrics.ruleCoverage(coverage);
    metrics.ruleCoverage(coverage);
    const index = RULE_COVERAGE_FAMILIES.indexOf('links');
    const snapshot = metrics.snapshot()!;
    expect(snapshot.ruleCoverage!.schema).toBe(RULE_COVERAGE_SCHEMA);
    expect(snapshot.ruleCoverage!.rows).toHaveLength(RULE_COVERAGE_FAMILIES.length);
    expect(snapshot.ruleCoverage!.rows[index]).toEqual([2, 2, 2, 2, 0, 0, 0, 0, 0, 0]);
    coverage.rows[index]![0] = 500;
    snapshot.ruleCoverage!.rows[index]![1] = 500;
    expect(metrics.snapshot()!.ruleCoverage!.rows[index]).toEqual([2, 2, 2, 2, 0, 0, 0, 0, 0, 0]);
    const maxRows = RULE_COVERAGE_FAMILIES.map(() =>
      RULE_COVERAGE_COUNTERS.map(() => Number.MAX_SAFE_INTEGER),
    );
    const maximum = { schema: RULE_COVERAGE_SCHEMA, rows: maxRows };
    metrics.ruleCoverage(maximum);
    metrics.ruleCoverage(maximum);
    expect(metrics.snapshot()!.ruleCoverage).toEqual(maximum);
  });
  it('keeps malformed coverage unavailable without discarding existing optimization data', () => {
    const metrics = new OptimizationRuntimeMetrics();
    const snapshot = metrics.snapshot()!;
    const row = snapshot.ruleCoverage!.rows[0]!;
    for (const invalid of [
      undefined,
      {},
      [],
      snapshot.ruleCoverage!.rows,
      { rows: snapshot.ruleCoverage!.rows },
      ...[
        [],
        [...snapshot.ruleCoverage!.rows, row],
        [row.slice(1), ...snapshot.ruleCoverage!.rows.slice(1)],
        [[...row, 0], ...snapshot.ruleCoverage!.rows.slice(1)],
        ...[-1, NaN, Infinity, '1', undefined].map((count) => [
          [count, ...row.slice(1)],
          ...snapshot.ruleCoverage!.rows.slice(1),
        ]),
      ].map((rows) => ({ schema: RULE_COVERAGE_SCHEMA, rows })),
    ]) {
      metrics.ruleCoverage(invalid);
      expect(metrics.snapshot()).toEqual(snapshot);
      expect(sanitizeOptimizationRuntimeMetrics({ ...snapshot, ruleCoverage: invalid })).toEqual({
        ...snapshot,
        ruleCoverage: null,
      });
    }
    expect(
      sanitizeOptimizationRuntimeMetrics({ ...snapshot, ruleSharedStages: { private: {} } }),
    ).toEqual({ ...snapshot, ruleSharedStages: null });
  });
  it('rejects another coverage schema even with an otherwise valid matrix of the same size', () => {
    const metrics = new OptimizationRuntimeMetrics();
    const snapshot = metrics.snapshot()!;
    const another = {
      schema: 'rule-engine-coverage-v2',
      rows: snapshot.ruleCoverage!.rows.map((row) => row.map(() => 1)),
    };
    metrics.ruleCoverage(another);
    expect(metrics.snapshot()).toEqual(snapshot);
    expect(sanitizeOptimizationRuntimeMetrics({ ...snapshot, ruleCoverage: another })).toEqual({
      ...snapshot,
      ruleCoverage: null,
    });
  });
});
