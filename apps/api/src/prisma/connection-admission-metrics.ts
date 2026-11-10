// FLAG: Admission observations never authorize work or change pool policy. Only fixed
// scalars leave the process; no pool identity, SQL, credentials, errors or labels are retained.
export const CONNECTION_ADMISSION_LANES = ['ordinary', 'budgeted'] as const;
export const CONNECTION_ADMISSION_TIMING_FIELDS = [
  'calls',
  'errors',
  'unknownClock',
  'totalMs',
  'maxMs',
  'under100Ms',
  'under500Ms',
  'under2000Ms',
  'under10000Ms',
  'atLeast10000Ms',
] as const;
export const CONNECTION_ADMISSION_COUNTERS = [
  'retryTimeouts',
  'budgetRejectedBefore',
  'capacityRejected',
  'budgetRejectedAfter',
  'lateReleases',
  'registryOverflows',
] as const;
export const CONNECTION_ADMISSION_GAUGE_FIELDS = [
  'pools',
  'capacity',
  'total',
  'idle',
  'waiting',
  'budgetedInFlight',
  'endingPools',
] as const;
const POOL_STATE_FIELDS = ['capacity', 'total', 'idle', 'waiting', 'budgetedInFlight'] as const;
const POOL_REGISTRY_LIMIT = 16;

export type ConnectionAdmissionLane = (typeof CONNECTION_ADMISSION_LANES)[number];
export type ConnectionAdmissionCounter = (typeof CONNECTION_ADMISSION_COUNTERS)[number];
type TimingCounts = Record<(typeof CONNECTION_ADMISSION_TIMING_FIELDS)[number], number>;
type AdmissionCounters = Record<ConnectionAdmissionCounter, number>;
type PoolGauges = Record<(typeof CONNECTION_ADMISSION_GAUGE_FIELDS)[number], number>;
export type ConnectionAdmissionPoolState = Readonly<
  Record<(typeof POOL_STATE_FIELDS)[number], number> & { ending: boolean; ended: boolean }
>;
export interface ConnectionAdmissionGaugeSource {
  readConnectionAdmissionState(): ConnectionAdmissionPoolState;
}
export type ConnectionAdmissionSnapshot = Readonly<{
  lanes: Readonly<Record<ConnectionAdmissionLane, Readonly<TimingCounts>>>;
  counters: Readonly<AdmissionCounters>;
  gauges: Readonly<PoolGauges> | null;
}>;

function numbers<const T extends readonly string[]>(fields: T): Record<T[number], number> {
  return Object.fromEntries(fields.map((field) => [field, 0])) as Record<T[number], number>;
}
function add(counts: Record<string, number>, field: string, value = 1): void {
  counts[field] = Math.min(Number.MAX_SAFE_INTEGER, counts[field]! + value);
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function checkedNumbers<const T extends readonly string[]>(
  value: unknown,
  fields: T,
): Record<T[number], number> | null {
  if (!isRecord(value)) return null;
  const result = numbers(fields);
  for (const field of fields) {
    const number = value[field];
    if (typeof number !== 'number' || !Number.isSafeInteger(number) || number < 0) return null;
    result[field as T[number]] = number;
  }
  return result;
}
function monotonicNow(): number {
  return performance.now();
}

export class ConnectionAdmissionMetrics {
  private readonly lanes: Record<ConnectionAdmissionLane, TimingCounts> = {
    ordinary: numbers(CONNECTION_ADMISSION_TIMING_FIELDS),
    budgeted: numbers(CONNECTION_ADMISSION_TIMING_FIELDS),
  };
  private readonly counts = numbers(CONNECTION_ADMISSION_COUNTERS);
  private readonly pools: WeakRef<ConnectionAdmissionGaugeSource>[] = [];
  private registryIncomplete = false;

  constructor(private readonly now: () => number | null = monotonicNow) {}

  begin(lane: ConnectionAdmissionLane): (failed: boolean) => void {
    if (!CONNECTION_ADMISSION_LANES.includes(lane)) return () => {};
    const start = this.readClock();
    let finished = false;
    return (failed) => {
      if (finished) return;
      finished = true;
      try {
        const end = this.readClock();
        const counts = this.lanes[lane];
        add(counts, 'calls');
        if (failed) add(counts, 'errors');
        const elapsed = start !== null && end !== null && end >= start ? end - start : null;
        if (elapsed === null || !Number.isFinite(elapsed) || elapsed > Number.MAX_SAFE_INTEGER) {
          add(counts, 'unknownClock');
          return;
        }
        const ms = Math.ceil(elapsed);
        add(counts, 'totalMs', ms);
        counts.maxMs = Math.max(counts.maxMs, ms);
        add(
          counts,
          ms < 100
            ? 'under100Ms'
            : ms < 500
              ? 'under500Ms'
              : ms < 2000
                ? 'under2000Ms'
                : ms < 10000
                  ? 'under10000Ms'
                  : 'atLeast10000Ms',
        );
      } catch {
        // FLAG: Broken observation must never replace an admission result or caller error.
      }
    };
  }

  increment(counter: ConnectionAdmissionCounter): void {
    try {
      if (CONNECTION_ADMISSION_COUNTERS.includes(counter)) add(this.counts, counter);
    } catch {
      // FLAG: Observation cannot change execution.
    }
  }

  registerPool(source: ConnectionAdmissionGaugeSource): void {
    try {
      this.collectPoolStates();
      if (this.pools.some((reference) => reference.deref() === source)) return;
      if (this.pools.length >= POOL_REGISTRY_LIMIT) {
        this.increment('registryOverflows');
        return;
      }
      this.pools.push(new WeakRef(source));
    } catch {
      // FLAG: Incomplete registration is missing gauge coverage for the process epoch.
      this.registryIncomplete = true;
    }
  }

  snapshot(): ConnectionAdmissionSnapshot {
    let gauges: PoolGauges | null = null;
    try {
      const { states, complete } = this.collectPoolStates();
      if (complete && !this.registryIncomplete && this.counts.registryOverflows === 0) {
        gauges = numbers(CONNECTION_ADMISSION_GAUGE_FIELDS);
        for (const state of states) {
          add(gauges, 'pools');
          for (const field of POOL_STATE_FIELDS) add(gauges, field, state[field]);
          if (state.ending) add(gauges, 'endingPools');
        }
      }
    } catch {
      // FLAG: A failed gauge read never becomes a partial healthy aggregate.
      gauges = null;
    }
    return {
      lanes: { ordinary: { ...this.lanes.ordinary }, budgeted: { ...this.lanes.budgeted } },
      counters: { ...this.counts },
      gauges,
    };
  }

  private readClock(): number | null {
    try {
      const value = this.now();
      return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
    } catch {
      return null;
    }
  }

  private collectPoolStates(): { states: ConnectionAdmissionPoolState[]; complete: boolean } {
    const states: ConnectionAdmissionPoolState[] = [];
    let complete = true;
    let retained = 0;
    for (const reference of this.pools) {
      const source = reference.deref();
      if (!source) continue;
      let retainedSource = false;
      try {
        const value = source.readConnectionAdmissionState();
        if (isRecord(value) && value.ended === true) continue;
        this.pools[retained++] = reference;
        retainedSource = true;
        const gauges = checkedNumbers(value, POOL_STATE_FIELDS);
        if (!gauges || typeof value.ending !== 'boolean' || typeof value.ended !== 'boolean') {
          complete = false;
          continue;
        }
        states.push({ ...gauges, ending: value.ending, ended: value.ended });
      } catch {
        if (!retainedSource) this.pools[retained++] = reference;
        complete = false;
      }
    }
    this.pools.length = retained;
    return { states, complete };
  }
}

export const connectionAdmissionMetrics = new ConnectionAdmissionMetrics();

export function sanitizeConnectionAdmissionMetrics(
  value: unknown,
): ConnectionAdmissionSnapshot | null {
  try {
    if (!isRecord(value) || !isRecord(value.lanes)) return null;
    const ordinary = checkedNumbers(value.lanes.ordinary, CONNECTION_ADMISSION_TIMING_FIELDS);
    const budgeted = checkedNumbers(value.lanes.budgeted, CONNECTION_ADMISSION_TIMING_FIELDS);
    const counters = checkedNumbers(value.counters, CONNECTION_ADMISSION_COUNTERS);
    if (!ordinary || !budgeted || !counters) return null;
    let gauges: PoolGauges | null = null;
    if (counters.registryOverflows === 0) {
      try {
        gauges = checkedNumbers(value.gauges, CONNECTION_ADMISSION_GAUGE_FIELDS);
      } catch {
        // FLAG: Gauge availability is independent of valid cumulative admission counters.
      }
    }
    return {
      lanes: { ordinary, budgeted },
      counters,
      // FLAG: Registry gaps forbid a partial aggregate even if a writer supplied gauges.
      gauges,
    };
  } catch {
    return null;
  }
}
