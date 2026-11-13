import { WebhookExecutionOwnerUnavailableError } from '../common/webhook-execution-owner-unavailable.error';
import { WebhookPreparationDeferredError } from '../common/webhook-preparation-deferred.error';

export const WEBHOOK_WORK_CLASSES = ['ordinary', 'interactive', 'lifecycle'] as const;
export type WebhookWorkClass = (typeof WEBHOOK_WORK_CLASSES)[number];
export const WEBHOOK_PREPARATION_ERROR_REASONS = [
  'ownerUnavailable',
  'preparationDeferred',
  'databaseConflict',
  'databaseTimeout',
  'databaseConnection',
  'databaseOther',
  'dependencyFailure',
  'unclassified',
] as const;
type PreparationErrorReason = (typeof WEBHOOK_PREPARATION_ERROR_REASONS)[number];

// FLAG: Diagnostic classification never authorizes retries. Inspect at most four cause
// nodes and exact scalar codes; never retain messages, stacks, metadata or dynamic labels.
export function classifyWebhookPreparationError(error: unknown): PreparationErrorReason {
  let fallback: PreparationErrorReason = 'unclassified';
  try {
    let current = error;
    for (let depth = 0; depth < 4 && current && typeof current === 'object'; depth += 1) {
      if (current instanceof WebhookExecutionOwnerUnavailableError) fallback = 'ownerUnavailable';
      else if (current instanceof WebhookPreparationDeferredError && fallback === 'unclassified')
        fallback = 'preparationDeferred';
      const source = current as { code?: unknown; meta?: { code?: unknown }; cause?: unknown };
      const outerCode = source.code;
      const code = outerCode === 'P2010' ? source.meta?.code : outerCode;
      switch (code) {
        case 'P2002':
        case '23505':
        case 'P2034':
        case '40001':
        case '40P01':
          return 'databaseConflict';
        case 'P1002':
        case 'P1008':
        case 'P2024':
          return 'databaseTimeout';
        case 'P1001':
        case 'P1017':
        case '08000':
        case '08001':
        case '08003':
        case '08006':
        case '57P01':
        case '57P02':
        case '57P03':
          return 'databaseConnection';
        case 'P2028':
        case '55P03':
        case '57014':
          return 'databaseOther';
        case 'ETIMEDOUT':
        case 'UND_ERR_CONNECT_TIMEOUT':
        case 'UND_ERR_HEADERS_TIMEOUT':
        case 'UND_ERR_BODY_TIMEOUT':
        case 'ECONNREFUSED':
        case 'ECONNRESET':
        case 'EPIPE':
        case 'ENOTFOUND':
        case 'EAI_AGAIN':
          return 'dependencyFailure';
      }
      current = source.cause;
    }
  } catch {
    // FLAG: A throwing getter/proxy must not replace the original task rejection or leak a slot.
  }
  return fallback;
}

export const WEBHOOK_OUTBOX_STAGES = [
  'admission',
  'selection',
  'refill',
  'prioritization',
  'enqueue',
] as const;
export type WebhookOutboxStage = (typeof WEBHOOK_OUTBOX_STAGES)[number];
export const WEBHOOK_ENQUEUE_PROGRESS_FIELDS = [
  'workUnits',
  'quarantined',
  'orderedHeadBlocked',
  'preparationBlocked',
  'preparationSharedCapacityBlocked',
  'preparationScopeBlocked',
  'prepared',
  'settled',
  'outstanding',
  'enqueueBlocked',
  'workUnitErrors',
] as const;
export const WEBHOOK_RETENTION_PHASES = [
  'webhookProcessedOrDuplicate',
  'webhookFailedTerminal',
  'moderationEvents',
  'sanctionHistory',
  'violations',
  'violationMessageClaims',
  'userDisplayNames',
  'voiceSources',
] as const;
const TIMING_FIELDS = ['calls', 'errors', 'totalMs', 'maxMs', 'unknownClocks'] as const;
const DURATION_FIELDS = ['under100Ms', 'under500Ms', 'under2000Ms', 'atLeast2000Ms'] as const;
const RETENTION_FIELDS = [
  'calls',
  'errors',
  'removed',
  'scanned',
  'batches',
  'budgetHits',
  'totalMs',
] as const;
const RETENTION_CONFIG_NUMBERS = [
  'webhookRetentionDays',
  'webhookFailedRetentionHours',
  'moderationRetentionDays',
  'userDisplayNameRetentionDays',
] as const;
const RETENTION_CONFIG_FLAGS = [
  'webhookCompletedRetentionEnabled',
  'webhookFailedRetentionEnabled',
] as const;

export function addWebhookMetric(value: number, amount = 1): number {
  if (!Number.isFinite(amount) || amount < 0) return value;
  return Math.min(Number.MAX_SAFE_INTEGER, value + Math.ceil(amount));
}
function zeroes<T extends string>(fields: readonly T[]): Record<T, number> {
  return Object.fromEntries(fields.map((field) => [field, 0])) as Record<T, number>;
}
function fixedMap<T extends string, V>(keys: readonly T[], factory: () => V): Record<T, V> {
  return Object.fromEntries(keys.map((key) => [key, factory()])) as Record<T, V>;
}
function checkedNumbers(value: unknown, fields: readonly string[]) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  if (
    fields.some(
      (field) =>
        typeof source[field] !== 'number' ||
        !Number.isSafeInteger(source[field]) ||
        (source[field] as number) < 0,
    )
  )
    return null;
  return Object.fromEntries(fields.map((field) => [field, source[field] as number]));
}
function checkedMap(
  value: unknown,
  keys: readonly string[],
  sanitize: (value: unknown) => unknown,
) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    const entry = sanitize((value as Record<string, unknown>)[key]);
    if (!entry) return null;
    result[key] = entry;
  }
  return result;
}
function emptyTiming() {
  return { ...zeroes(TIMING_FIELDS), buckets: zeroes(DURATION_FIELDS) };
}
function sanitizeTiming(value: unknown) {
  const counters = checkedNumbers(value, TIMING_FIELDS);
  const buckets = checkedNumbers(
    (value as Record<string, unknown> | null)?.buckets,
    DURATION_FIELDS,
  );
  return counters && buckets ? { ...counters, buckets } : null;
}
function observeTiming(timing: ReturnType<typeof emptyTiming>, started: number, failed: boolean) {
  timing.calls = addWebhookMetric(timing.calls);
  if (failed) timing.errors = addWebhookMetric(timing.errors);
  const duration = performance.now() - started;
  if (!Number.isFinite(duration) || duration < 0) {
    timing.unknownClocks = addWebhookMetric(timing.unknownClocks);
    return;
  }
  const rounded = Math.min(Number.MAX_SAFE_INTEGER, Math.ceil(duration));
  timing.totalMs = addWebhookMetric(timing.totalMs, rounded);
  timing.maxMs = Math.max(timing.maxMs, rounded);
  const field =
    DURATION_FIELDS[duration < 100 ? 0 : duration < 500 ? 1 : duration < 2_000 ? 2 : 3]!;
  timing.buckets[field] = addWebhookMetric(timing.buckets[field]);
}

function sanitizePreparationSnapshot(value: unknown) {
  const source = value as Record<string, unknown> | null;
  const gauges = checkedNumbers(source, ['maxInFlight', 'inFlight', 'botScopes', 'peakInFlight']);
  if (!gauges || typeof source?.closed !== 'boolean') return null;
  const result: Record<string, unknown> = { ...gauges, closed: source.closed };
  for (const field of ['active', 'admitted', 'deferred', 'completed', 'errors']) {
    const counts = checkedNumbers(source[field], WEBHOOK_WORK_CLASSES);
    if (!counts) return null;
    result[field] = counts;
  }
  const duration = sanitizeTiming(source.duration);
  return duration
    ? { ...result, duration, errorReasons: sanitizePreparationErrorReasons(source) }
    : null;
}

function sanitizePreparationErrorReasons(source: Record<string, unknown>) {
  try {
    const reasons = source.errorReasons;
    const errors = checkedNumbers(source.errors, WEBHOOK_WORK_CLASSES);
    if (
      !Array.isArray(reasons) ||
      reasons.length !== WEBHOOK_PREPARATION_ERROR_REASONS.length ||
      !errors
    )
      return null;
    const counts = WEBHOOK_PREPARATION_ERROR_REASONS.map((_, index) => reasons[index]);
    if (
      counts.some((value) => typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
    )
      return null;
    const total = counts.reduce((sum, value) => addWebhookMetric(sum, value), 0);
    const errorTotal = WEBHOOK_WORK_CLASSES.reduce(
      (sum, workClass) => addWebhookMetric(sum, errors[workClass]!),
      0,
    );
    return total === errorTotal ? (counts as number[]) : null;
  } catch {
    // FLAG: Old/malformed optional attribution is unknown; preserve the base measurements.
    return null;
  }
}

export class WebhookPreparationRuntimeMetrics {
  readonly admitted = zeroes(WEBHOOK_WORK_CLASSES);
  readonly deferred = zeroes(WEBHOOK_WORK_CLASSES);
  readonly completed = zeroes(WEBHOOK_WORK_CLASSES);
  readonly errors = zeroes(WEBHOOK_WORK_CLASSES);
  readonly errorReasons = zeroes(WEBHOOK_PREPARATION_ERROR_REASONS);
  readonly duration = emptyTiming();
  peakInFlight = 0;
  finish(workClass: WebhookWorkClass, started: number, failed: boolean, error?: unknown): void {
    this.completed[workClass] = addWebhookMetric(this.completed[workClass]);
    if (failed) {
      this.errors[workClass] = addWebhookMetric(this.errors[workClass]);
      const reason = classifyWebhookPreparationError(error);
      this.errorReasons[reason] = addWebhookMetric(this.errorReasons[reason]);
    }
    observeTiming(this.duration, started, failed);
  }
}

function sanitizeOutboxSnapshot(value: unknown) {
  const source = value as Record<string, unknown> | null;
  const gauges = checkedNumbers(source, ['inFlightWorkUnits']);
  const batch = sanitizeTiming(source?.batch);
  const stages = checkedMap(source?.stages, WEBHOOK_OUTBOX_STAGES, sanitizeTiming);
  const progress = checkedNumbers(source?.progress, WEBHOOK_ENQUEUE_PROGRESS_FIELDS);
  const counts = checkedNumbers(source, [
    'candidateCount',
    'selectedCount',
    'degradedBatches',
    'completedTimeoutRepairBatches',
  ]);
  const retention = source?.retention as Record<string, unknown> | null;
  const retentionCounts = checkedNumbers(retention, [
    'calls',
    'errors',
    'skippedInFlight',
    'maintenanceCalls',
    'unknownClocks',
  ]);
  const config = checkedNumbers(retention?.config, RETENTION_CONFIG_NUMBERS);
  const configSource = retention?.config as Record<string, unknown> | null;
  const phases = checkedMap(retention?.phases, WEBHOOK_RETENTION_PHASES, (entry) =>
    checkedNumbers(entry, RETENTION_FIELDS),
  );
  if (
    !gauges ||
    !batch ||
    !stages ||
    !progress ||
    !counts ||
    !retentionCounts ||
    !config ||
    !phases ||
    RETENTION_CONFIG_FLAGS.some((flag) => typeof configSource?.[flag] !== 'boolean') ||
    typeof retention?.cleaning !== 'boolean' ||
    typeof retention.maintenancePending !== 'boolean'
  )
    return null;
  return {
    ...gauges,
    batch,
    stages,
    progress,
    ...counts,
    retention: {
      ...retentionCounts,
      cleaning: retention.cleaning,
      maintenancePending: retention.maintenancePending,
      config: {
        ...config,
        ...Object.fromEntries(RETENTION_CONFIG_FLAGS.map((flag) => [flag, configSource![flag]])),
      },
      phases,
    },
  };
}

// FLAG: Fixed cumulative scalars only. No identities, payloads, raw errors, SQL or I/O.
export class WebhookOutboxRuntimeMetrics {
  readonly batch = emptyTiming();
  readonly stages = fixedMap(WEBHOOK_OUTBOX_STAGES, emptyTiming);
  readonly progress = zeroes(WEBHOOK_ENQUEUE_PROGRESS_FIELDS);
  readonly retention = {
    calls: 0,
    errors: 0,
    skippedInFlight: 0,
    maintenanceCalls: 0,
    unknownClocks: 0,
    phases: fixedMap(WEBHOOK_RETENTION_PHASES, () => zeroes(RETENTION_FIELDS)),
  };
  candidateCount = 0;
  selectedCount = 0;
  degradedBatches = 0;
  completedTimeoutRepairBatches = 0;

  startTiming(stage?: WebhookOutboxStage): (failed?: boolean) => void {
    const started = performance.now();
    const timing = stage ? this.stages[stage] : this.batch;
    let finished = false;
    return (failed = false) => {
      if (finished) return;
      finished = true;
      observeTiming(timing, started, failed);
    };
  }
  addProgress(progress: Record<(typeof WEBHOOK_ENQUEUE_PROGRESS_FIELDS)[number], number>): void {
    for (const field of WEBHOOK_ENQUEUE_PROGRESS_FIELDS)
      this.progress[field] = addWebhookMetric(this.progress[field], progress[field]);
  }
  finishRetentionPhase(
    name: string,
    result: {
      rows: number;
      scannedRows: number;
      batches: number;
      durationMs: number;
      budgetExhausted: boolean;
    },
    failed = false,
  ): void {
    // FLAG: Unknown labels never grow the report or affect cleanup work.
    if (!(WEBHOOK_RETENTION_PHASES as readonly string[]).includes(name)) return;
    const phase = this.retention.phases[name as (typeof WEBHOOK_RETENTION_PHASES)[number]];
    phase.calls = addWebhookMetric(phase.calls);
    if (failed) phase.errors = addWebhookMetric(phase.errors);
    phase.removed = addWebhookMetric(phase.removed, result.rows);
    phase.scanned = addWebhookMetric(phase.scanned, result.scannedRows);
    phase.batches = addWebhookMetric(phase.batches, result.batches);
    if (result.budgetExhausted) phase.budgetHits = addWebhookMetric(phase.budgetHits);
    if (!Number.isFinite(result.durationMs) || result.durationMs < 0) {
      this.retention.unknownClocks = addWebhookMetric(this.retention.unknownClocks);
      return;
    }
    phase.totalMs = addWebhookMetric(phase.totalMs, result.durationMs);
  }
}

// FLAG: Optional providers may be malformed, including throwing property readers.
// A diagnostic failure must not suppress the rest of the fixed process report.
export function sanitizeWebhookPreparationSnapshot(value: unknown) {
  try {
    return sanitizePreparationSnapshot(value);
  } catch {
    return null;
  }
}
export function sanitizeWebhookOutboxSnapshot(value: unknown) {
  try {
    return sanitizeOutboxSnapshot(value);
  } catch {
    return null;
  }
}
