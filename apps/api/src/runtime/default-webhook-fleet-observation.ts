import {
  DEFAULT_WEBHOOK_WORKER_GROUP_NAMES,
  RUNTIME_SERVICE_PROFILES,
  WEBHOOK_DYNAMIC_LEASES_MODES,
  type DefaultWebhookWorkerGroupName,
  type WebhookDynamicLeasesMode,
} from './runtime-topology';

type Mode = WebhookDynamicLeasesMode;
type Group = DefaultWebhookWorkerGroupName;
type Seen = { group: Group; mode: Mode; expiresAtMs: number };
type RedisReply = readonly [Error | null, unknown];

export type LeaseHeartbeatObservation = {
  seen: Seen[];
  unreadable: number;
  observedAtMs: number;
  expiresAtMs: number;
};

// FLAG: Scheduling fallbacks and last-writer summaries cannot establish which workers are live.
export function readLeaseHeartbeats(
  replies: readonly RedisReply[] | null,
  nowMs: number,
  ttlMs: number,
  readStartedAtMs = nowMs,
): LeaseHeartbeatObservation {
  const seen: Seen[] = [];
  let unreadable = 0;
  for (const [index, group] of DEFAULT_WEBHOOK_WORKER_GROUP_NAMES.entries()) {
    const reply = replies?.[index * 2];
    const ttlReply = replies?.[index * 2 + 1];
    const remainingMs = ttlReply?.[0] === null ? ttlReply[1] : undefined;
    if (reply?.[0] === null && reply[1] === null && remainingMs === -2) continue;
    let value: Record<string, unknown> | null = null;
    if (reply && reply[0] === null && typeof reply[1] === 'string') {
      try {
        value = JSON.parse(reply[1]) as Record<string, unknown> | null;
      } catch {
        // An unreadable value makes the observation incomplete.
      }
    }
    const timestamp = value?.updatedAtMs;
    const mode = value?.mode;
    if (
      value?.workerGroupName === group &&
      typeof timestamp === 'number' &&
      Number.isSafeInteger(timestamp) &&
      timestamp > 0 &&
      timestamp <= nowMs &&
      timestamp + ttlMs > nowMs &&
      typeof remainingMs === 'number' &&
      remainingMs > 0 &&
      readStartedAtMs + remainingMs > nowMs &&
      isLeaseMode(mode)
    ) {
      seen.push({
        group,
        mode,
        expiresAtMs: Math.min(timestamp + ttlMs, readStartedAtMs + remainingMs),
      });
    } else {
      unreadable += 1;
    }
  }
  return { seen, unreadable, observedAtMs: nowMs, expiresAtMs: nowMs + ttlMs };
}

export function isLeaseMode(value: unknown): value is Mode {
  return WEBHOOK_DYNAMIC_LEASES_MODES.some((mode) => mode === value);
}

export function expectedLeaseMode(serviceName: string | undefined, localMode: Mode): Mode {
  if (serviceName === 'api-all') return localMode;
  const modes = DEFAULT_WEBHOOK_WORKER_GROUP_NAMES.map(
    (group): Mode => RUNTIME_SERVICE_PROFILES[group].dynamicLeasesMode,
  );
  return modes.find((mode) => mode !== 'off') ?? 'off';
}

export function observeLeaseFleet(
  evidence: LeaseHeartbeatObservation | undefined,
  expectedMode: Mode,
  summaryMode: Mode | undefined,
  nowMs = Date.now(),
) {
  const total = DEFAULT_WEBHOOK_WORKER_GROUP_NAMES.length;
  const fresh = evidence && evidence.observedAtMs <= nowMs && evidence.expiresAtMs > nowMs;
  const seen = fresh ? evidence.seen.filter((sample) => sample.expiresAtMs > nowMs) : [];
  const unreadable = fresh ? evidence.unreadable + evidence.seen.length - seen.length : total;
  const liveWorkerGroups = seen.map((sample) => sample.group);
  const modes = new Set(seen.map((sample) => sample.mode));
  const observed = modes.size === 1 ? seen[0]?.mode : undefined;
  const consensus = seen.length === total && observed !== undefined;
  const partialNonOff = observed && observed !== 'off' ? observed : undefined;
  const summaryNonOff = summaryMode && summaryMode !== 'off' ? summaryMode : undefined;
  const knownNonOff = seen.find((sample) => sample.mode !== 'off')?.mode;
  // FLAG: One worker's off and a summary written by that worker cannot disable fleet monitoring.
  const source = consensus
    ? 'all-workers'
    : partialNonOff
      ? 'some-workers'
      : summaryNonOff
        ? 'one-summary'
        : 'expected';
  const mode =
    (consensus ? observed : partialNonOff) ??
    summaryNonOff ??
    (expectedMode !== 'off' ? expectedMode : (knownNonOff ?? 'off'));
  const mixed = modes.size > 1;
  const summaryConflict =
    summaryMode !== undefined && seen.some((sample) => sample.mode !== summaryMode);
  const monitor = mode !== 'off' || mixed || summaryConflict;
  return { mode, source, liveWorkerGroups, unreadable, consensus, mixed, summaryConflict, monitor };
}

export function currentLeaseSummaryMode(
  summary: { mode: unknown; generatedAt: unknown } | null | undefined,
  ttlMs: number,
  nowMs: number,
): Mode | undefined {
  if (!summary || !isLeaseMode(summary.mode) || typeof summary.generatedAt !== 'string') return;
  const stamp = Date.parse(summary.generatedAt);
  if (Number.isFinite(stamp) && stamp <= nowMs && nowMs - stamp < ttlMs) return summary.mode;
}
