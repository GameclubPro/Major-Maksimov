import {
  RULE_COVERAGE_COUNTERS,
  RULE_COVERAGE_FAMILIES,
  RULE_COVERAGE_SCHEMA,
  type RuleCoverageRow,
  type RuleCoverageSnapshot,
} from '../moderation/rule-engine-observation';

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
export const RULE_TIMING_STAGES = [
  'normalize',
  'profanity',
  'commercial-ad',
  'links',
  'message-length',
  'anti-spam-burst',
  'message-count-limit',
  'blocked-words',
  'blocked-domains',
  'phone-numbers',
  'attachments',
  'traffic-protection',
  'duplicate-precheck',
  'duplicate-state',
] as const;
export const RULE_SHARED_TIMING_STAGES = ['stop-words-policy', 'media-cooldowns'] as const;
export const CONTEXT_TIMING_PHASES = ['coldLoad', 'candidateLoad'] as const;
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
  private readonly ruleStages = matrix(RULE_TIMING_STAGES, OPTIMIZATION_TIMING_FIELDS);
  private readonly ruleSharedStages = matrix(RULE_SHARED_TIMING_STAGES, OPTIMIZATION_TIMING_FIELDS);
  private readonly ruleCoverageCounts: RuleCoverageRow[] = RULE_COVERAGE_FAMILIES.map(
    () => RULE_COVERAGE_COUNTERS.map(() => 0) as RuleCoverageRow,
  );
  private readonly contextSource = matrix(CONTEXT_TIMING_PHASES, OPTIMIZATION_TIMING_FIELDS);

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
    this.observeTiming(this.timings[phase], elapsedMs, failed);
  }
  ruleStage(stage: string, elapsedMs: number | null): void {
    if (RULE_SHARED_TIMING_STAGES.includes(stage as (typeof RULE_SHARED_TIMING_STAGES)[number])) {
      this.observeTiming(
        this.ruleSharedStages[stage as (typeof RULE_SHARED_TIMING_STAGES)[number]],
        elapsedMs,
      );
      return;
    }
    if (!RULE_TIMING_STAGES.includes(stage as (typeof RULE_TIMING_STAGES)[number])) return;
    this.observeTiming(this.ruleStages[stage as (typeof RULE_TIMING_STAGES)[number]], elapsedMs);
  }
  ruleCoverage(value: unknown): void {
    const snapshot = checkedRuleCoverage(value);
    if (!snapshot) return;
    snapshot.rows.forEach((row, family) => {
      row.forEach((count, counter) => {
        this.ruleCoverageCounts[family]![counter] = Math.min(
          Number.MAX_SAFE_INTEGER,
          this.ruleCoverageCounts[family]![counter]! + count,
        );
      });
    });
  }
  contextLoad(
    phase: (typeof CONTEXT_TIMING_PHASES)[number],
    elapsedMs: number | null,
    failed = false,
  ): void {
    this.observeTiming(this.contextSource[phase], elapsedMs, failed);
  }
  private observeTiming(
    counts: Record<string, number>,
    elapsedMs: number | null,
    failed = false,
  ): void {
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
      ruleStages: this.ruleStages,
      ruleSharedStages: this.ruleSharedStages,
      ruleCoverage: { schema: RULE_COVERAGE_SCHEMA, rows: this.ruleCoverageCounts },
      contextSource: this.contextSource,
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
function checkedRuleCoverage(value: unknown): RuleCoverageSnapshot | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  if (
    source.schema !== RULE_COVERAGE_SCHEMA ||
    !Array.isArray(source.rows) ||
    source.rows.length !== RULE_COVERAGE_FAMILIES.length
  )
    return null;
  const rows: RuleCoverageRow[] = [];
  for (const row of source.rows) {
    if (
      !Array.isArray(row) ||
      row.length !== RULE_COVERAGE_COUNTERS.length ||
      RULE_COVERAGE_COUNTERS.some((_, index) => !Number.isSafeInteger(row[index]) || row[index] < 0)
    )
      return null;
    rows.push(RULE_COVERAGE_COUNTERS.map((_, index) => row[index]) as RuleCoverageRow);
  }
  return { schema: RULE_COVERAGE_SCHEMA, rows };
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
  // FLAG: Missing additive dimensions are unavailable coverage for older processes.
  // Do not manufacture zero measurements while accepting their existing counters.
  const ruleStages = checkedMatrix(
    source.ruleStages,
    RULE_TIMING_STAGES,
    OPTIMIZATION_TIMING_FIELDS,
  );
  const contextSource = checkedMatrix(
    source.contextSource,
    CONTEXT_TIMING_PHASES,
    OPTIMIZATION_TIMING_FIELDS,
  );
  const ruleSharedStages = checkedMatrix(
    source.ruleSharedStages,
    RULE_SHARED_TIMING_STAGES,
    OPTIMIZATION_TIMING_FIELDS,
  );
  const ruleCoverage = checkedRuleCoverage(source.ruleCoverage);
  return authors && roster && demand && timings
    ? {
        authors,
        roster,
        demand,
        timings,
        ruleStages,
        contextSource,
        ruleSharedStages,
        ruleCoverage,
      }
    : null;
}
