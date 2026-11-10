import {
  CONNECTION_ADMISSION_COUNTERS,
  CONNECTION_ADMISSION_TIMING_FIELDS,
  ConnectionAdmissionMetrics,
  type ConnectionAdmissionGaugeSource,
  type ConnectionAdmissionPoolState,
  sanitizeConnectionAdmissionMetrics,
} from './connection-admission-metrics';

function poolFixture(overrides: Partial<ConnectionAdmissionPoolState> = {}) {
  const state = {
    capacity: 4,
    total: 2,
    idle: 1,
    waiting: 3,
    budgetedInFlight: 2,
    ending: false,
    ended: false,
    ...overrides,
  };
  const source: ConnectionAdmissionGaugeSource = {
    readConnectionAdmissionState: jest.fn(() => state),
  };
  return { state, source };
}

describe('bounded PostgreSQL admission observations', () => {
  it('counts each completed logical admission once with its full elapsed span', () => {
    let now = 10;
    const metrics = new ConnectionAdmissionMetrics(() => now);
    const complete = metrics.begin('ordinary');
    now = 210;
    metrics.increment('retryTimeouts');
    expect(metrics.snapshot().lanes.ordinary.calls).toBe(0);
    now = 410;
    complete(false);
    now = 900;
    complete(true);
    const rejected = metrics.begin('budgeted');
    now = 901;
    rejected(true);
    expect(metrics.snapshot()).toMatchObject({
      lanes: {
        ordinary: { calls: 1, errors: 0, totalMs: 400, maxMs: 400, under500Ms: 1 },
        budgeted: { calls: 1, errors: 1, totalMs: 1, under100Ms: 1 },
      },
      counters: { retryTimeouts: 1 },
    });
  });

  it('uses the existing rounded duration buckets without retaining individual observations', () => {
    let now = 0;
    const metrics = new ConnectionAdmissionMetrics(() => now);
    for (const elapsed of [0, 99, 100, 499, 500, 1999, 2000, 9999, 10000]) {
      const complete = metrics.begin('ordinary');
      now += elapsed;
      complete(false);
    }
    expect(metrics.snapshot().lanes.ordinary).toEqual({
      calls: 9,
      errors: 0,
      unknownClock: 0,
      totalMs: 25196,
      maxMs: 10000,
      under100Ms: 2,
      under500Ms: 2,
      under2000Ms: 2,
      under10000Ms: 2,
      atLeast10000Ms: 1,
    });
  });

  it('keeps unavailable, broken and reversed clocks out of measured duration buckets', () => {
    const readings: Array<number | null | Error> = [
      null,
      1,
      0,
      NaN,
      Infinity,
      1,
      10,
      9,
      new Error('private-clock'),
      1,
      0,
      new Error('private-clock'),
      0,
      Number.MAX_SAFE_INTEGER * 2,
    ];
    const metrics = new ConnectionAdmissionMetrics(() => {
      const value = readings.shift()!;
      if (value instanceof Error) throw value;
      return value;
    });
    for (let index = 0; index < 7; index += 1) {
      const complete = metrics.begin('budgeted');
      expect(() => complete(true)).not.toThrow();
    }
    expect(metrics.snapshot().lanes.budgeted).toEqual({
      calls: 7,
      errors: 7,
      unknownClock: 7,
      totalMs: 0,
      maxMs: 0,
      under100Ms: 0,
      under500Ms: 0,
      under2000Ms: 0,
      under10000Ms: 0,
      atLeast10000Ms: 0,
    });
  });

  it('saturates cumulative counters and timing fields at the safe integer boundary', () => {
    let now: number | null = 0;
    const metrics = new ConnectionAdmissionMetrics(() => now);
    const internals = metrics as unknown as {
      counts: Record<string, number>;
      lanes: { ordinary: Record<string, number> };
    };
    for (const field of CONNECTION_ADMISSION_COUNTERS) {
      internals.counts[field] = Number.MAX_SAFE_INTEGER - 1;
      metrics.increment(field);
      metrics.increment(field);
    }
    for (const field of CONNECTION_ADMISSION_TIMING_FIELDS)
      internals.lanes.ordinary[field] = Number.MAX_SAFE_INTEGER - 1;
    const complete = metrics.begin('ordinary');
    now = Number.MAX_SAFE_INTEGER;
    complete(true);
    now = null;
    metrics.begin('ordinary')(true);
    const snapshot = metrics.snapshot();
    expect(Object.values(snapshot.counters)).toEqual(
      Array(CONNECTION_ADMISSION_COUNTERS.length).fill(Number.MAX_SAFE_INTEGER),
    );
    expect(snapshot.lanes.ordinary).toMatchObject({
      calls: Number.MAX_SAFE_INTEGER,
      errors: Number.MAX_SAFE_INTEGER,
      unknownClock: Number.MAX_SAFE_INTEGER,
      totalMs: Number.MAX_SAFE_INTEGER,
      maxMs: Number.MAX_SAFE_INTEGER,
      atLeast10000Ms: Number.MAX_SAFE_INTEGER,
    });
    expect(Object.values(snapshot.lanes.ordinary).every(Number.isSafeInteger)).toBe(true);
  });

  it('copies cumulative snapshots without resetting observations or sharing mutable rows', () => {
    const metrics = new ConnectionAdmissionMetrics(() => 5);
    const pool = poolFixture();
    metrics.registerPool(pool.source);
    metrics.begin('ordinary')(false);
    const original = metrics.snapshot();
    const modified = metrics.snapshot() as {
      lanes: { ordinary: { calls: number } };
      counters: { retryTimeouts: number };
      gauges: { capacity: number };
    };
    modified.lanes.ordinary.calls = 999;
    modified.counters.retryTimeouts = 999;
    modified.gauges.capacity = 999;
    expect(metrics.snapshot()).toEqual(original);
    metrics.begin('ordinary')(false);
    expect(original.lanes.ordinary.calls).toBe(1);
    expect(metrics.snapshot().lanes.ordinary.calls).toBe(2);
  });

  it('aggregates different pool capacities and retains ending pools until they have ended', () => {
    const metrics = new ConnectionAdmissionMetrics();
    const first = poolFixture({ capacity: 2, total: 2, idle: 0, waiting: 1, budgetedInFlight: 1 });
    const second = poolFixture({ capacity: 7, total: 3, idle: 2, waiting: 4, budgetedInFlight: 3 });
    metrics.registerPool(first.source);
    metrics.registerPool(first.source);
    metrics.registerPool(second.source);
    second.state.ending = true;
    expect(metrics.snapshot().gauges).toEqual({
      pools: 2,
      capacity: 9,
      total: 5,
      idle: 2,
      waiting: 5,
      budgetedInFlight: 4,
      endingPools: 1,
    });
    second.state.ended = true;
    expect(metrics.snapshot().gauges).toEqual({
      pools: 1,
      capacity: 2,
      total: 2,
      idle: 0,
      waiting: 1,
      budgetedInFlight: 1,
      endingPools: 0,
    });
  });

  it('prunes sequential ended lifecycles without relying on garbage collection', () => {
    const metrics = new ConnectionAdmissionMetrics();
    const retainedFixtures = [];
    for (let index = 0; index < 40; index += 1) {
      const fixture = poolFixture();
      retainedFixtures.push(fixture);
      metrics.registerPool(fixture.source);
      fixture.state.ended = true;
    }
    expect(retainedFixtures).toHaveLength(40);
    expect(metrics.snapshot()).toMatchObject({
      counters: { registryOverflows: 0 },
      gauges: { pools: 0, capacity: 0, total: 0, idle: 0, waiting: 0, budgetedInFlight: 0 },
    });
  });

  it('saturates aggregated pool scalars without exposing source fields', () => {
    const metrics = new ConnectionAdmissionMetrics();
    const first = poolFixture({
      capacity: Number.MAX_SAFE_INTEGER,
      total: Number.MAX_SAFE_INTEGER,
    });
    const second = poolFixture({ capacity: 1, total: 1 });
    metrics.registerPool(first.source);
    metrics.registerPool(second.source);
    expect(metrics.snapshot().gauges).toEqual({
      pools: 2,
      capacity: Number.MAX_SAFE_INTEGER,
      total: Number.MAX_SAFE_INTEGER,
      idle: 2,
      waiting: 6,
      budgetedInFlight: 4,
      endingPools: 0,
    });
  });

  it('bounds live registrations and keeps overflow gauges unavailable for the process epoch', () => {
    const metrics = new ConnectionAdmissionMetrics(() => 0);
    const pools = Array.from({ length: 17 }, () => poolFixture());
    for (const pool of pools) metrics.registerPool(pool.source);
    for (const pool of pools) (pool.source.readConnectionAdmissionState as jest.Mock).mockClear();
    expect(metrics.snapshot()).toMatchObject({ counters: { registryOverflows: 1 }, gauges: null });
    for (const pool of pools.slice(0, 16))
      expect(pool.source.readConnectionAdmissionState).toHaveBeenCalledTimes(1);
    expect(pools[16]!.source.readConnectionAdmissionState).not.toHaveBeenCalled();
    for (const pool of pools) pool.state.ended = true;
    metrics.snapshot();
    const next = poolFixture();
    metrics.registerPool(next.source);
    metrics.begin('ordinary')(false);
    metrics.increment('retryTimeouts');
    expect(metrics.snapshot()).toMatchObject({
      counters: { registryOverflows: 1, retryTimeouts: 1 },
      lanes: { ordinary: { calls: 1 } },
      gauges: null,
    });
  });

  it('isolates broken gauge readers while preserving independent admission counters', () => {
    const metrics = new ConnectionAdmissionMetrics(() => 0);
    let broken = true;
    const source: ConnectionAdmissionGaugeSource = {
      readConnectionAdmissionState() {
        if (broken) throw new Error('private-pool');
        return poolFixture().state;
      },
    };
    expect(() => metrics.registerPool(source)).not.toThrow();
    const other = poolFixture();
    expect(() => metrics.registerPool(other.source)).not.toThrow();
    metrics.begin('budgeted')(true);
    expect(metrics.snapshot()).toMatchObject({
      lanes: { budgeted: { calls: 1, errors: 1 } },
      gauges: null,
    });
    broken = false;
    expect(metrics.snapshot().gauges?.pools).toBe(2);
  });

  it('strips arbitrary labels and isolates unavailable gauges from valid fixed counters', () => {
    const snapshot = new ConnectionAdmissionMetrics().snapshot();
    const injected = {
      ...snapshot,
      privateLabel: 'private-payload',
      lanes: { ...snapshot.lanes, privateLabel: snapshot.lanes.ordinary },
      counters: { ...snapshot.counters, privateLabel: 42 },
      gauges: { ...snapshot.gauges, privateLabel: 'private-payload' },
    };
    expect(sanitizeConnectionAdmissionMetrics(injected)).toEqual(snapshot);
    for (const gauges of [undefined, null, [], {}, { ...snapshot.gauges, total: -1 }])
      expect(sanitizeConnectionAdmissionMetrics({ ...snapshot, gauges })).toEqual({
        ...snapshot,
        gauges: null,
      });
    expect(
      sanitizeConnectionAdmissionMetrics({
        ...snapshot,
        gauges: {
          ...snapshot.gauges,
          get total() {
            throw new Error('private-gauge-getter');
          },
        },
      }),
    ).toEqual({ ...snapshot, gauges: null });
    expect(
      sanitizeConnectionAdmissionMetrics({
        ...snapshot,
        counters: { ...snapshot.counters, registryOverflows: 1 },
      })?.gauges,
    ).toBeNull();
  });

  it('rejects missing or corrupt required coverage without throwing on hostile getters', () => {
    const snapshot = new ConnectionAdmissionMetrics().snapshot();
    for (const value of [undefined, null, [], {}, 'private-payload'])
      expect(sanitizeConnectionAdmissionMetrics(value)).toBeNull();
    for (const value of [-1, 0.5, NaN, Infinity, undefined, '1', []]) {
      expect(
        sanitizeConnectionAdmissionMetrics({
          ...snapshot,
          counters: { ...snapshot.counters, retryTimeouts: value },
        }),
      ).toBeNull();
      expect(
        sanitizeConnectionAdmissionMetrics({
          ...snapshot,
          lanes: { ...snapshot.lanes, ordinary: { ...snapshot.lanes.ordinary, calls: value } },
        }),
      ).toBeNull();
    }
    expect(sanitizeConnectionAdmissionMetrics({ ...snapshot, counters: [] })).toBeNull();
    expect(sanitizeConnectionAdmissionMetrics({ ...snapshot, lanes: [] })).toBeNull();
    expect(
      sanitizeConnectionAdmissionMetrics({
        get lanes() {
          throw new Error('private-getter');
        },
      }),
    ).toBeNull();
  });
});
