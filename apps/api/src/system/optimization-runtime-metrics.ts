// FLAG: Fixed dimensions only. These counters describe invocations, never unique users,
// chats, HTTP successes or permission authority. No observations may affect execution.
export const DELETE_AUTHOR_MODULES = [
  'links',
  'commercial',
  'commercialLlm',
  'commercialOcr',
  'profanity',
  'stopWords',
  'messageLimits',
  'closedChat',
  'moderationState',
  'trafficProtection',
  'other',
] as const;
export type DeleteAuthorModule = (typeof DELETE_AUTHOR_MODULES)[number];
export const DELETE_AUTHOR_COUNTERS = [
  'calls',
  'rosterSkips',
  'protectedSkips',
  'missingRoster',
  'membershipRequired',
  'memberCalls',
  'sharedReads',
  'errors',
] as const;
export const ROSTER_SYNC_STATES = ['bootstrap', 'refresh', 'unknown'] as const;
export type RosterSyncState = (typeof ROSTER_SYNC_STATES)[number];
export const ROSTER_SYNC_COUNTERS = [
  'calls',
  'completed',
  'notSynced',
  'sourceBackoff',
  'rateLimited',
  'failed',
] as const;
export const ROSTER_DEMAND_COUNTERS = [
  'bootstrapObserved',
  'refreshObserved',
  'localDeferred',
  'reservationRefused',
  'acknowledged',
  'notAcknowledged',
  'failed',
] as const;
export const OPTIMIZATION_TIMING_PHASES = [
  'author',
  'sendQuota',
  'sendGuard',
  'sendHttp',
  'sendDispatch',
  'sendLedger',
  'sendReceipt',
  'sendFirstQueue',
  'sendRetryQueue',
] as const;
export type OptimizationTimingPhase = (typeof OPTIMIZATION_TIMING_PHASES)[number];
export const OPTIMIZATION_TIMING_FIELDS = [
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

function counters<const T extends readonly string[]>(fields: T): Record<T[number], number> {
  return Object.fromEntries(fields.map((key) => [key, 0])) as Record<T[number], number>;
}
function matrix<const K extends readonly string[], const F extends readonly string[]>(
  keys: K,
  fields: F,
) {
  return Object.fromEntries(keys.map((key) => [key, counters(fields)])) as Record<
    K[number],
    Record<F[number], number>
  >;
}
function add(counts: Record<string, number>, key: string, value = 1): void {
  counts[key] = Math.min(Number.MAX_SAFE_INTEGER, (counts[key] ?? 0) + value);
}
export function optimizationNow(): number | null {
  try {
    const now = performance.now();
    return Number.isFinite(now) ? now : null;
  } catch {
    return null;
  }
}
export function optimizationElapsed(start: number | null): number | null {
  if (start === null) return null;
  const now = optimizationNow();
  return start !== null && now !== null && now >= start ? now - start : null;
}

export class OptimizationRuntimeMetrics {
  private readonly authors = matrix(DELETE_AUTHOR_MODULES, DELETE_AUTHOR_COUNTERS);
  private readonly roster = matrix(ROSTER_SYNC_STATES, ROSTER_SYNC_COUNTERS);
  private readonly demand = counters(ROSTER_DEMAND_COUNTERS);
  private readonly timings = matrix(OPTIMIZATION_TIMING_PHASES, OPTIMIZATION_TIMING_FIELDS);

  author(
    module: DeleteAuthorModule | undefined,
    counter: (typeof DELETE_AUTHOR_COUNTERS)[number],
  ): void {
    const key = DELETE_AUTHOR_MODULES.includes(module as DeleteAuthorModule) ? module! : 'other';
    add(this.authors[key], counter);
  }
  rosterSync(state: RosterSyncState, counter: (typeof ROSTER_SYNC_COUNTERS)[number]): void {
    add(this.roster[state], counter);
  }
  rosterDemand(counter: (typeof ROSTER_DEMAND_COUNTERS)[number]): void {
    add(this.demand, counter);
  }
  timing(phase: OptimizationTimingPhase, elapsedMs: number | null, failed = false): void {
    const counts = this.timings[phase];
    add(counts, 'calls');
    if (failed) add(counts, 'errors');
    if (
      elapsedMs === null ||
      !Number.isFinite(elapsedMs) ||
      elapsedMs < 0 ||
      elapsedMs > Number.MAX_SAFE_INTEGER
    ) {
      add(counts, 'unknownClock');
      return;
    }
    const ms = Math.ceil(elapsedMs);
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
  }
  snapshot() {
    return sanitizeOptimizationRuntimeMetrics({
      authors: this.authors,
      roster: this.roster,
      demand: this.demand,
      timings: this.timings,
    });
  }
}

function checked(value: unknown, fields: readonly string[]): Record<string, number> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  if (
    fields.some(
      (key) =>
        typeof source[key] !== 'number' ||
        !Number.isSafeInteger(source[key]) ||
        (source[key] as number) < 0,
    )
  )
    return null;
  return Object.fromEntries(fields.map((key) => [key, source[key] as number]));
}
function checkedMatrix(value: unknown, keys: readonly string[], fields: readonly string[]) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const result: Record<string, Record<string, number>> = {};
  for (const key of keys) {
    const row = checked((value as Record<string, unknown>)[key], fields);
    if (!row) return null;
    result[key] = row;
  }
  return result;
}
export function sanitizeOptimizationRuntimeMetrics(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  const authors = checkedMatrix(source.authors, DELETE_AUTHOR_MODULES, DELETE_AUTHOR_COUNTERS);
  const roster = checkedMatrix(source.roster, ROSTER_SYNC_STATES, ROSTER_SYNC_COUNTERS);
  const demand = checked(source.demand, ROSTER_DEMAND_COUNTERS);
  const timings = checkedMatrix(
    source.timings,
    OPTIMIZATION_TIMING_PHASES,
    OPTIMIZATION_TIMING_FIELDS,
  );
  return authors && roster && demand && timings ? { authors, roster, demand, timings } : null;
}
