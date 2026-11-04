'use strict';

const crypto = require('node:crypto');
const {
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} = require('node:fs');
const { basename, dirname, join, resolve } = require('node:path');

const ARCHIVE_SCHEMA_VERSION = 1;
const RETENTION_DAYS = 14;
const RETENTION_MS = RETENTION_DAYS * 24 * 60 * 60 * 1_000;
const MAX_ARCHIVE_HOURS = RETENTION_DAYS * 24 + 1;
const MAX_RECORDS_PER_HOUR = 240;
const MAX_HOURLY_FILE_BYTES = 8 * 1024 * 1024;
const MAX_INPUT_BYTES = 64 * 1024;
const MAX_SAMPLE_GAP_MS = 90_000;
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1_000;
const EXPECTED_WEBHOOK_QUEUE_COUNT = 24;
const GIB = 1024 ** 3;

const ALERT_DEFINITIONS = Object.freeze({
  load_per_cpu_warning_5m: { severity: 'warning', threshold: 0.85, windowSec: 300 },
  load_per_cpu_critical_2m: { severity: 'critical', threshold: 1.25, windowSec: 120 },
  iowait_warning_5m: { severity: 'warning', threshold: 15, windowSec: 300 },
  iowait_critical_2m: { severity: 'critical', threshold: 30, windowSec: 120 },
  swap_in_sustained_5m: { severity: 'warning', threshold: 0, windowSec: 300 },
  swap_used_10pct_5m: { severity: 'warning', threshold: 10, windowSec: 300 },
  memory_available_warning_5m: { severity: 'warning', threshold: 25, windowSec: 300 },
  memory_available_critical_2m: { severity: 'critical', threshold: 15, windowSec: 120 },
  disk_util_warning_5m: { severity: 'warning', threshold: 80, windowSec: 300 },
  disk_util_critical_2m: { severity: 'critical', threshold: 95, windowSec: 120 },
  disk_free_40gib: { severity: 'warning', threshold: 40 * GIB, windowSec: 0 },
  readiness: { severity: 'critical', threshold: 'healthy', windowSec: 0 },
  readiness_fallback: { severity: 'warning', threshold: false, windowSec: 0 },
  queue_metrics: { severity: 'critical', threshold: true, windowSec: 0 },
  system_mode: { severity: 'warning', threshold: 'auto-normal/no-burst', windowSec: 0 },
  queue_backlog_mode: { severity: 'warning', threshold: false, windowSec: 0 },
  max_api_mode: { severity: 'warning', threshold: false, windowSec: 0 },
  stabilizing_mode: { severity: 'warning', threshold: false, windowSec: 0 },
  queue_lag_warning: { severity: 'warning', threshold: 10, windowSec: 0 },
  queue_lag_critical: { severity: 'critical', threshold: 30, windowSec: 0 },
  quarantined_receipts: { severity: 'warning', threshold: 0, windowSec: 0 },
  queue_fence: { severity: 'critical', threshold: 'unpaused/unowned', windowSec: 0 },
  api_fleet_topology: {
    severity: 'critical',
    threshold:
      'source-topology singleton/running/exact-identity/exact-image roles; no duplicates or unexpected API containers',
    windowSec: 0,
  },
  api_fleet_restarts: {
    severity: 'warning',
    threshold: 0,
    windowSec: 0,
    version: 2,
    basis: 'container_generation_intervals',
    restartClass: 'api',
  },
  ocr_native_restarts: {
    severity: 'warning',
    threshold: 0,
    windowSec: 0,
    version: 1,
    basis: 'container_generation_intervals',
    restartClass: 'ocr',
  },
  photo_native_restarts: {
    severity: 'warning',
    threshold: 0,
    windowSec: 0,
    version: 1,
    basis: 'container_generation_intervals',
    restartClass: 'photo',
  },
});

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function numberOrNull(value, min = 0, max = Number.MAX_SAFE_INTEGER) {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max
    ? value
    : null;
}

function integerOrNull(value, min = 0, max = Number.MAX_SAFE_INTEGER) {
  return Number.isSafeInteger(value) && value >= min && value <= max ? value : null;
}

function booleanOrNull(value) {
  return typeof value === 'boolean' ? value : null;
}

function alertValueOrNull(value) {
  if (typeof value === 'boolean') return value;
  return numberOrNull(value, -Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER);
}

function safeToken(value, allowed, fallback = 'unknown') {
  return allowed.includes(value) ? value : fallback;
}

function normalizeActionHealth(raw) {
  if (!isRecord(raw)) return null;
  const windowSec = integerOrNull(raw.windowSec, 1, 86_400);
  const total = integerOrNull(raw.total);
  const success = integerOrNull(raw.success);
  const failure = integerOrNull(raw.failure);
  const critical = integerOrNull(raw.critical);
  const errorRate = numberOrNull(raw.errorRate, 0, 1);
  const criticalRate = numberOrNull(raw.criticalRate, 0, 1);
  if (
    [windowSec, total, success, failure, critical, errorRate, criticalRate].some(
      (value) => value === null,
    ) ||
    total !== success + failure ||
    critical > failure
  ) {
    return null;
  }
  const expectedErrorRate = total === 0 ? 0 : failure / total;
  const expectedCriticalRate = total === 0 ? 0 : critical / total;
  if (
    Math.abs(errorRate - expectedErrorRate) > 1e-9 ||
    Math.abs(criticalRate - expectedCriticalRate) > 1e-9
  ) {
    return null;
  }
  return { windowSec, total, success, failure, critical, errorRate, criticalRate };
}

function utcInstantOrNull(value) {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(value)
  )
    return null;
  const instant = Date.parse(value);
  const canonical = value.length === 20 ? value.slice(0, -1) + '.000Z' : value;
  return Number.isFinite(instant) && new Date(instant).toISOString() === canonical
    ? canonical
    : null;
}

function normalizeRestartEvidence(raw, observedAt) {
  if (
    !isRecord(raw) ||
    raw.version !== 1 ||
    !['container_generation_intervals', 'historical_container_totals'].includes(raw.basis)
  ) {
    return null;
  }
  const current = utcInstantOrNull(raw.observedAt);
  if (current === null || current !== observedAt) return null;
  const historical = raw.basis === 'historical_container_totals';
  const previous = historical ? null : utcInstantOrNull(raw.previousObservedAt);
  const intervalMs = previous === null ? null : Date.parse(current) - Date.parse(previous);
  const intervalValid = intervalMs !== null && intervalMs > 0 && intervalMs <= MAX_SAMPLE_GAP_MS;
  const result = {
    version: 1,
    basis: raw.basis,
    previousObservedAt: intervalMs !== null && intervalMs > 0 ? previous : null,
    observedAt: current,
  };
  for (const name of ['api', 'ocr', 'photo']) {
    const value = isRecord(raw[name]) ? raw[name] : {};
    const total = integerOrNull(value.total, 0, 1_000_000_000);
    const generationChanged =
      total !== null && !historical && intervalMs > 0
        ? booleanOrNull(value.generationChanged)
        : null;
    const delta = integerOrNull(value.delta, 0, 1_000_000_000);
    // FLAG: Totals cannot certify an interval; replacements, gaps and malformed
    // class evidence retain unknown deltas independently of the other classes.
    result[name] = {
      total,
      delta:
        total !== null &&
        intervalValid &&
        generationChanged === false &&
        delta !== null &&
        delta <= total
          ? delta
          : null,
      generationChanged,
    };
  }
  return result;
}

function emptyApiFleet(available = null) {
  return {
    available,
    expectedRoleCount: null,
    observedRoleCount: null,
    singletonRoleCount: null,
    runningRoleCount: null,
    identityRoleCount: null,
    exactImageRoleCount: null,
    duplicateContainerCount: null,
    unexpectedApiContainerCount: null,
    unexpectedMainContainerCount: null,
    unexpectedScaleContainerCount: null,
    unexpectedManualContainerCount: null,
    totalRestartCount: null,
    restartEvidence: null,
  };
}

function normalizeApiFleet(raw, observedAt) {
  if (!isRecord(raw)) return emptyApiFleet();
  const available = booleanOrNull(raw.available);
  if (available !== true) return emptyApiFleet(available);
  const fleet = {
    available: true,
    expectedRoleCount: integerOrNull(raw.expectedRoleCount, 1, 128),
    observedRoleCount: integerOrNull(raw.observedRoleCount, 0, 128),
    singletonRoleCount: integerOrNull(raw.singletonRoleCount, 0, 128),
    runningRoleCount: integerOrNull(raw.runningRoleCount, 0, 128),
    identityRoleCount: integerOrNull(raw.identityRoleCount, 0, 128),
    exactImageRoleCount: integerOrNull(raw.exactImageRoleCount, 0, 128),
    duplicateContainerCount: integerOrNull(raw.duplicateContainerCount, 0, 128),
    unexpectedApiContainerCount: integerOrNull(raw.unexpectedApiContainerCount, 0, 128),
    unexpectedMainContainerCount: integerOrNull(raw.unexpectedMainContainerCount, 0, 128),
    unexpectedScaleContainerCount: integerOrNull(raw.unexpectedScaleContainerCount, 0, 128),
    unexpectedManualContainerCount: integerOrNull(raw.unexpectedManualContainerCount, 0, 128),
    totalRestartCount: integerOrNull(raw.totalRestartCount, 0, 1_000_000_000),
  };
  const counts = [
    fleet.expectedRoleCount,
    fleet.observedRoleCount,
    fleet.singletonRoleCount,
    fleet.runningRoleCount,
    fleet.identityRoleCount,
    fleet.exactImageRoleCount,
    fleet.duplicateContainerCount,
    fleet.unexpectedApiContainerCount,
    fleet.unexpectedMainContainerCount,
    fleet.unexpectedScaleContainerCount,
    fleet.unexpectedManualContainerCount,
    fleet.totalRestartCount,
  ];
  if (
    counts.some((value) => value === null) ||
    fleet.observedRoleCount > fleet.expectedRoleCount ||
    fleet.singletonRoleCount > fleet.observedRoleCount ||
    fleet.duplicateContainerCount < fleet.observedRoleCount - fleet.singletonRoleCount ||
    fleet.runningRoleCount > fleet.singletonRoleCount ||
    fleet.identityRoleCount > fleet.singletonRoleCount ||
    fleet.exactImageRoleCount > fleet.singletonRoleCount ||
    fleet.unexpectedApiContainerCount !==
      fleet.unexpectedMainContainerCount +
        fleet.unexpectedScaleContainerCount +
        fleet.unexpectedManualContainerCount
  ) {
    return emptyApiFleet();
  }
  return { ...fleet, restartEvidence: normalizeRestartEvidence(raw.restartEvidence, observedAt) };
}

function normalizeSnapshot(raw) {
  if (!isRecord(raw) || raw.schemaVersion !== 1) {
    throw new Error('Capacity snapshot schema is invalid.');
  }
  const observedAtMs = Date.parse(raw.observedAt);
  if (!Number.isFinite(observedAtMs)) throw new Error('Capacity snapshot timestamp is invalid.');
  const host = isRecord(raw.host) ? raw.host : {};
  const disk = isRecord(host.disk) ? host.disk : {};
  const readiness = isRecord(raw.readiness) ? raw.readiness : {};
  const adminReadiness = isRecord(raw.adminReadiness) ? raw.adminReadiness : {};
  const queueFence = isRecord(raw.queueFence) ? raw.queueFence : {};
  const apiFleet = isRecord(raw.apiFleet) ? raw.apiFleet : {};
  const diskPath = disk.path === '/var/lib/docker' || disk.path === '/' ? disk.path : 'unknown';
  const diskDevice =
    typeof disk.device === 'string' && /^[A-Za-z0-9._-]{1,64}$/u.test(disk.device)
      ? disk.device
      : 'unknown';

  return {
    schemaVersion: ARCHIVE_SCHEMA_VERSION,
    observedAt: new Date(observedAtMs).toISOString(),
    host: {
      cpuCount: integerOrNull(host.cpuCount, 1, 4_096),
      load1: numberOrNull(host.load1, 0, 1_000_000),
      memoryTotalBytes: integerOrNull(host.memoryTotalBytes),
      memoryAvailableBytes: integerOrNull(host.memoryAvailableBytes),
      swapTotalBytes: integerOrNull(host.swapTotalBytes),
      swapUsedBytes: integerOrNull(host.swapUsedBytes),
      cpuIowaitPct: numberOrNull(host.cpuIowaitPct, 0, 100),
      swapInPagesPerSec: numberOrNull(host.swapInPagesPerSec, 0, 1_000_000_000),
      disk: {
        device: diskDevice,
        path: diskPath,
        totalBytes: integerOrNull(disk.totalBytes),
        availableBytes: integerOrNull(disk.availableBytes),
        usedPct: numberOrNull(disk.usedPct, 0, 100),
        utilPct: numberOrNull(disk.utilPct, 0, 100),
        avgQueueDepth: numberOrNull(disk.avgQueueDepth, 0, 1_000_000),
      },
    },
    readiness: {
      available: booleanOrNull(readiness.available),
      httpStatus: integerOrNull(readiness.httpStatus, 100, 599),
      ok: booleanOrNull(readiness.ok),
      database: booleanOrNull(readiness.database),
      redis: booleanOrNull(readiness.redis),
      rawOk: booleanOrNull(readiness.rawOk),
      queueOk: booleanOrNull(readiness.queueOk),
      softWarning: booleanOrNull(readiness.softWarning),
      softWarningCode: safeToken(readiness.softWarningCode, [
        'none',
        'queue-lag-hysteresis',
        'stale-ready-fallback',
        'unknown',
      ]),
      queueLagSec: numberOrNull(readiness.queueLagSec, 0, 365 * 24 * 60 * 60),
      operationalLagSec: numberOrNull(readiness.operationalLagSec, 0, 365 * 24 * 60 * 60),
      readinessWaitingCount: integerOrNull(readiness.readinessWaitingCount, 0, 10_000),
      readinessHeadLimitReached: booleanOrNull(readiness.readinessHeadLimitReached),
      quarantinedCountLowerBound: integerOrNull(readiness.quarantinedCountLowerBound, 0, 65),
      quarantineSampleLimitReached: booleanOrNull(readiness.quarantineSampleLimitReached),
      oldestQuarantinedAgeSec: numberOrNull(
        readiness.oldestQuarantinedAgeSec,
        0,
        365 * 24 * 60 * 60,
      ),
      mode: safeToken(readiness.mode, ['normal', 'degrade']),
      condition: safeToken(readiness.condition, [
        'healthy',
        'queue_backlog',
        'max_api',
        'mixed',
        'stabilizing',
        'manual',
        'unknown',
      ]),
      burstActive: booleanOrNull(readiness.burstActive),
      action: normalizeActionHealth(readiness.action),
    },
    adminReadiness: {
      available: booleanOrNull(adminReadiness.available),
      httpStatus: integerOrNull(adminReadiness.httpStatus, 100, 599),
      ok: booleanOrNull(adminReadiness.ok),
      database: booleanOrNull(adminReadiness.database),
      redis: booleanOrNull(adminReadiness.redis),
    },
    queueFence: {
      available: booleanOrNull(queueFence.available),
      queueCount: integerOrNull(queueFence.queueCount, 0, 10_000),
      pausedCount: integerOrNull(queueFence.pausedCount, 0, 10_000),
      activeCount: integerOrNull(queueFence.activeCount, 0, 10_000_000),
      ownerPresent: booleanOrNull(queueFence.ownerPresent),
    },
    apiFleet: normalizeApiFleet(apiFleet, new Date(observedAtMs).toISOString()),
  };
}

function metricPoint(sample, select) {
  return { observedAtMs: Date.parse(sample.observedAt), value: select(sample) };
}

function sustainedOutcome(samples, select, predicate, definition) {
  const points = samples
    .map((sample) => metricPoint(sample, select))
    .sort((left, right) => left.observedAtMs - right.observedAtMs);
  const current = points.at(-1);
  if (!current || current.value === null || current.value === undefined) {
    return alertOutcome(definition, 'unknown', null, 0);
  }
  if (!predicate(current.value)) return alertOutcome(definition, 'clear', current.value, 0);

  let earliest = current;
  for (let index = points.length - 2; index >= 0; index -= 1) {
    const point = points[index];
    if (earliest.observedAtMs - point.observedAtMs > MAX_SAMPLE_GAP_MS) break;
    if (point.value === null || point.value === undefined) break;
    if (!predicate(point.value)) break;
    earliest = point;
  }
  const sustainedForSec = Math.max(0, (current.observedAtMs - earliest.observedAtMs) / 1_000);
  return alertOutcome(
    definition,
    sustainedForSec >= definition.windowSec ? 'firing' : 'pending',
    current.value,
    sustainedForSec,
  );
}

function immediateOutcome(value, predicate, definition) {
  if (value === null || value === undefined) return alertOutcome(definition, 'unknown', null, 0);
  return alertOutcome(definition, predicate(value) ? 'firing' : 'clear', value, 0);
}

function alertOutcome(definition, outcome, value, sustainedForSec) {
  return {
    ...(definition.basis
      ? {
          version: definition.version,
          basis: definition.basis,
          restartClass: definition.restartClass,
        }
      : {}),
    outcome,
    severity: definition.severity,
    threshold: definition.threshold,
    windowSec: definition.windowSec,
    value,
    sustainedForSec: Math.floor(sustainedForSec),
  };
}

function evaluateAlerts(history, current) {
  const samples = [...history, current].sort(
    (left, right) => Date.parse(left.observedAt) - Date.parse(right.observedAt),
  );
  const swapUsedPct = (sample) => {
    const total = sample.host.swapTotalBytes;
    const used = sample.host.swapUsedBytes;
    if (total === 0 && used === 0) return 0;
    return total && used !== null ? (used / total) * 100 : null;
  };
  const memoryAvailablePct = (sample) => {
    const total = sample.host.memoryTotalBytes;
    const available = sample.host.memoryAvailableBytes;
    return total && available !== null ? (available / total) * 100 : null;
  };
  const loadPerCpu = (sample) => {
    const cpuCount = sample.host.cpuCount;
    const load1 = sample.host.load1;
    return cpuCount && load1 !== null ? load1 / cpuCount : null;
  };
  const readyHealthy =
    current.readiness.available === true &&
    current.readiness.httpStatus === 200 &&
    current.readiness.ok === true &&
    current.readiness.database === true &&
    current.readiness.redis === true &&
    current.adminReadiness.available === true &&
    current.adminReadiness.httpStatus === 200 &&
    current.adminReadiness.ok === true &&
    current.adminReadiness.database === true &&
    current.adminReadiness.redis === true;
  const readinessKnown =
    current.readiness.available !== null && current.adminReadiness.available !== null;
  const softWarningStateKnown =
    (current.readiness.softWarning === false && current.readiness.softWarningCode === 'none') ||
    (current.readiness.softWarning === true &&
      ['queue-lag-hysteresis', 'stale-ready-fallback'].includes(current.readiness.softWarningCode));
  const queueMetricsKnown =
    current.readiness.available === true &&
    current.readiness.rawOk !== null &&
    current.readiness.queueOk !== null &&
    softWarningStateKnown;
  const staleQueueMetrics = current.readiness.softWarningCode === 'stale-ready-fallback';
  // FLAG: Quarantine is retained evidence, separate from executable queue pressure.
  // Missing/stale/contradictory observations never prove that quarantine is empty.
  const quarantineKnown =
    queueMetricsKnown &&
    !staleQueueMetrics &&
    current.readiness.quarantinedCountLowerBound !== null &&
    current.readiness.oldestQuarantinedAgeSec !== null &&
    current.readiness.quarantineSampleLimitReached ===
      (current.readiness.quarantinedCountLowerBound === 65) &&
    (current.readiness.quarantinedCountLowerBound > 0 ||
      current.readiness.oldestQuarantinedAgeSec === 0);
  const fenceHealthy =
    current.queueFence.available === true &&
    current.queueFence.queueCount === EXPECTED_WEBHOOK_QUEUE_COUNT &&
    current.queueFence.pausedCount === 0 &&
    current.queueFence.ownerPresent === false;
  const fleet = current.apiFleet;
  const restarts =
    fleet.available === true
      ? normalizeRestartEvidence(fleet.restartEvidence, current.observedAt)
      : null;
  const fleetTopologyHealthy =
    fleet.available === true &&
    [11, 12, 13, 14].includes(fleet.expectedRoleCount) &&
    fleet.observedRoleCount === fleet.expectedRoleCount &&
    fleet.singletonRoleCount === fleet.expectedRoleCount &&
    fleet.runningRoleCount === fleet.expectedRoleCount &&
    fleet.identityRoleCount === fleet.expectedRoleCount &&
    fleet.exactImageRoleCount === fleet.expectedRoleCount &&
    fleet.duplicateContainerCount === 0 &&
    fleet.unexpectedApiContainerCount === 0;

  const alerts = {
    load_per_cpu_warning_5m: sustainedOutcome(
      samples,
      loadPerCpu,
      (value) => value > ALERT_DEFINITIONS.load_per_cpu_warning_5m.threshold,
      ALERT_DEFINITIONS.load_per_cpu_warning_5m,
    ),
    load_per_cpu_critical_2m: sustainedOutcome(
      samples,
      loadPerCpu,
      (value) => value > ALERT_DEFINITIONS.load_per_cpu_critical_2m.threshold,
      ALERT_DEFINITIONS.load_per_cpu_critical_2m,
    ),
    iowait_warning_5m: sustainedOutcome(
      samples,
      (sample) => sample.host.cpuIowaitPct,
      (value) => value > 15,
      ALERT_DEFINITIONS.iowait_warning_5m,
    ),
    iowait_critical_2m: sustainedOutcome(
      samples,
      (sample) => sample.host.cpuIowaitPct,
      (value) => value > 30,
      ALERT_DEFINITIONS.iowait_critical_2m,
    ),
    swap_in_sustained_5m: sustainedOutcome(
      samples,
      (sample) => sample.host.swapInPagesPerSec,
      (value) => value > 0,
      ALERT_DEFINITIONS.swap_in_sustained_5m,
    ),
    swap_used_10pct_5m: sustainedOutcome(
      samples,
      swapUsedPct,
      (value) => value > 10,
      ALERT_DEFINITIONS.swap_used_10pct_5m,
    ),
    memory_available_warning_5m: sustainedOutcome(
      samples,
      memoryAvailablePct,
      (value) => value < 25,
      ALERT_DEFINITIONS.memory_available_warning_5m,
    ),
    memory_available_critical_2m: sustainedOutcome(
      samples,
      memoryAvailablePct,
      (value) => value < 15,
      ALERT_DEFINITIONS.memory_available_critical_2m,
    ),
    disk_util_warning_5m: sustainedOutcome(
      samples,
      (sample) => sample.host.disk.utilPct,
      (value) => value > ALERT_DEFINITIONS.disk_util_warning_5m.threshold,
      ALERT_DEFINITIONS.disk_util_warning_5m,
    ),
    disk_util_critical_2m: sustainedOutcome(
      samples,
      (sample) => sample.host.disk.utilPct,
      (value) => value > ALERT_DEFINITIONS.disk_util_critical_2m.threshold,
      ALERT_DEFINITIONS.disk_util_critical_2m,
    ),
    disk_free_40gib: immediateOutcome(
      current.host.disk.availableBytes,
      (value) => value < ALERT_DEFINITIONS.disk_free_40gib.threshold,
      ALERT_DEFINITIONS.disk_free_40gib,
    ),
    readiness: immediateOutcome(
      readinessKnown ? readyHealthy : null,
      (value) => value === false,
      ALERT_DEFINITIONS.readiness,
    ),
    readiness_fallback: immediateOutcome(
      softWarningStateKnown ? staleQueueMetrics : null,
      (value) => value === true,
      ALERT_DEFINITIONS.readiness_fallback,
    ),
    queue_metrics: immediateOutcome(
      queueMetricsKnown ? !staleQueueMetrics : null,
      (value) => value === false,
      ALERT_DEFINITIONS.queue_metrics,
    ),
    system_mode: immediateOutcome(
      current.readiness.mode === 'unknown' ||
        current.readiness.condition === 'unknown' ||
        current.readiness.burstActive === null
        ? null
        : current.readiness.mode !== 'normal' ||
            current.readiness.condition === 'manual' ||
            current.readiness.burstActive,
      (value) => value === true,
      ALERT_DEFINITIONS.system_mode,
    ),
    queue_backlog_mode: immediateOutcome(
      current.readiness.condition === 'unknown'
        ? null
        : current.readiness.condition === 'queue_backlog' ||
            current.readiness.condition === 'mixed',
      (value) => value === true,
      ALERT_DEFINITIONS.queue_backlog_mode,
    ),
    max_api_mode: immediateOutcome(
      current.readiness.condition === 'unknown'
        ? null
        : current.readiness.condition === 'max_api' || current.readiness.condition === 'mixed',
      (value) => value === true,
      ALERT_DEFINITIONS.max_api_mode,
    ),
    stabilizing_mode: immediateOutcome(
      current.readiness.condition === 'unknown'
        ? null
        : current.readiness.condition === 'stabilizing',
      (value) => value === true,
      ALERT_DEFINITIONS.stabilizing_mode,
    ),
    queue_lag_warning: immediateOutcome(
      current.readiness.queueLagSec,
      (value) => value > ALERT_DEFINITIONS.queue_lag_warning.threshold,
      ALERT_DEFINITIONS.queue_lag_warning,
    ),
    queue_lag_critical: immediateOutcome(
      current.readiness.queueLagSec,
      (value) => value > ALERT_DEFINITIONS.queue_lag_critical.threshold,
      ALERT_DEFINITIONS.queue_lag_critical,
    ),
    queue_fence: immediateOutcome(
      current.queueFence.available === null ? null : fenceHealthy,
      (value) => value === false,
      ALERT_DEFINITIONS.queue_fence,
    ),
    quarantined_receipts: immediateOutcome(
      quarantineKnown ? current.readiness.quarantinedCountLowerBound : null,
      (value) => value > 0,
      ALERT_DEFINITIONS.quarantined_receipts,
    ),
    api_fleet_topology: immediateOutcome(
      fleet.available === null ? null : fleetTopologyHealthy,
      (value) => value === false,
      ALERT_DEFINITIONS.api_fleet_topology,
    ),
    api_fleet_restarts: immediateOutcome(
      restarts?.api.delta ?? null,
      (value) => value > ALERT_DEFINITIONS.api_fleet_restarts.threshold,
      ALERT_DEFINITIONS.api_fleet_restarts,
    ),
    ocr_native_restarts: immediateOutcome(
      restarts?.ocr.delta ?? null,
      (value) => value > ALERT_DEFINITIONS.ocr_native_restarts.threshold,
      ALERT_DEFINITIONS.ocr_native_restarts,
    ),
    photo_native_restarts: immediateOutcome(
      restarts?.photo.delta ?? null,
      (value) => value > ALERT_DEFINITIONS.photo_native_restarts.threshold,
      ALERT_DEFINITIONS.photo_native_restarts,
    ),
  };

  const outcomes = Object.values(alerts);
  const overallStatus = outcomes.some(
    (alert) => alert.outcome === 'firing' && alert.severity === 'critical',
  )
    ? 'critical'
    : outcomes.some((alert) => alert.outcome !== 'clear')
      ? 'warning'
      : 'ok';
  return { alerts, overallStatus };
}

function archiveFilename(observedAt) {
  return `capacity-${observedAt.slice(0, 13).replace(/[-:]/gu, '')}.jsonl`;
}

function archiveHourMs(filename) {
  const match = /^capacity-(\d{4})(\d{2})(\d{2})T(\d{2})\.jsonl$/u.exec(filename);
  if (!match) return null;
  const [, year, month, day, hour] = match;
  const value = Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour));
  const parsed = new Date(value);
  return parsed.getUTCFullYear() === Number(year) &&
    parsed.getUTCMonth() === Number(month) - 1 &&
    parsed.getUTCDate() === Number(day) &&
    parsed.getUTCHours() === Number(hour)
    ? value
    : null;
}

function ensurePrivateDirectory(directory) {
  if (existsSync(directory)) {
    const existing = lstatSync(directory);
    if (!existing.isDirectory() || existing.isSymbolicLink()) {
      throw new Error('Capacity archive directory must be a real directory.');
    }
  } else {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
  }
  const stats = lstatSync(directory);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error('Capacity archive directory must be a real directory.');
  }
  if ((stats.mode & 0o077) !== 0) {
    throw new Error('Capacity archive directory must be private to its owner.');
  }
}

function normalizeArchivedAlerts(raw) {
  const source = isRecord(raw) ? raw : {};
  return Object.fromEntries(
    Object.entries(ALERT_DEFINITIONS).map(([id, definition]) => {
      const value = isRecord(source[id]) ? source[id] : {};
      const legacyRestart =
        id === 'api_fleet_restarts' &&
        ((value.version === undefined && value.basis === undefined) ||
          (value.version === 1 &&
            value.basis === 'historical_container_totals' &&
            value.restartClass === 'fleet'));
      const currentRestart =
        definition.basis &&
        value.version === definition.version &&
        value.basis === definition.basis &&
        value.restartClass === definition.restartClass;
      const metadata = definition.basis
        ? legacyRestart
          ? {
              version: 1,
              basis: 'historical_container_totals',
              restartClass: 'fleet',
            }
          : {
              version: definition.version,
              basis: definition.basis,
              restartClass: definition.restartClass,
            }
        : {};
      const compatible = !definition.basis || legacyRestart || currentRestart;
      return [
        id,
        {
          ...metadata,
          outcome: compatible
            ? safeToken(value.outcome, ['clear', 'pending', 'firing', 'unknown'])
            : 'unknown',
          severity: definition.severity,
          threshold: definition.threshold,
          windowSec: definition.windowSec,
          value: compatible ? alertValueOrNull(value.value) : null,
          sustainedForSec: Math.floor(numberOrNull(value.sustainedForSec, 0) ?? 0),
        },
      ];
    }),
  );
}

function readRecords(path) {
  if (!existsSync(path)) return [];
  const stats = lstatSync(path);
  if (!stats.isFile() || stats.isSymbolicLink() || stats.size > MAX_HOURLY_FILE_BYTES) {
    throw new Error('Capacity archive file is invalid or oversized.');
  }
  const records = [];
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/u)) {
    if (!line.trim()) continue;
    if (Buffer.byteLength(line) > MAX_INPUT_BYTES) {
      throw new Error('Capacity archive record is oversized.');
    }
    try {
      const parsed = JSON.parse(line);
      if (!isRecord(parsed) || !isRecord(parsed.sample)) {
        throw new Error('Capacity archive record is invalid.');
      }
      records.push({
        schemaVersion: ARCHIVE_SCHEMA_VERSION,
        sample: normalizeSnapshot(parsed.sample),
        alerts: normalizeArchivedAlerts(parsed.alerts),
        overallStatus: safeToken(parsed.overallStatus, ['ok', 'warning', 'critical']),
      });
    } catch {
      throw new Error('Capacity archive record is invalid.');
    }
  }
  return records;
}

function writeAtomic(path, content) {
  const directory = dirname(path);
  const temporary = join(
    directory,
    `.${basename(path)}.tmp-${process.pid}-${crypto.randomBytes(8).toString('hex')}`,
  );
  let descriptor = null;
  try {
    descriptor = openSync(
      temporary,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    writeFileSync(descriptor, content, 'utf8');
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = null;
    renameSync(temporary, path);
    const directoryDescriptor = openSync(directory, constants.O_RDONLY);
    try {
      fsyncSync(directoryDescriptor);
    } finally {
      closeSync(directoryDescriptor);
    }
  } finally {
    if (descriptor !== null) closeSync(descriptor);
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

function listArchiveFiles(directory) {
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && archiveHourMs(entry.name) !== null)
    .map((entry) => ({ name: entry.name, hourMs: archiveHourMs(entry.name) }))
    .sort((left, right) => left.hourMs - right.hourMs);
}

function rotateArchive(directory, observedAtMs) {
  const cutoffMs = observedAtMs - RETENTION_MS;
  let files = listArchiveFiles(directory);
  for (const file of files) {
    const path = join(directory, file.name);
    if (file.hourMs + 3_600_000 <= cutoffMs) {
      unlinkSync(path);
      continue;
    }
    if (file.hourMs < cutoffMs) {
      const retained = readRecords(path).filter(
        (record) => Date.parse(record.sample.observedAt) >= cutoffMs,
      );
      if (retained.length === 0) {
        unlinkSync(path);
      } else {
        writeAtomic(path, `${retained.map((record) => JSON.stringify(record)).join('\n')}\n`);
      }
    }
  }
  files = listArchiveFiles(directory);
  const excess = Math.max(0, files.length - MAX_ARCHIVE_HOURS);
  for (const file of files.slice(0, excess)) unlinkSync(join(directory, file.name));
}

function readRecentHistory(directory, observedAtMs) {
  const oldestMs = observedAtMs - 10 * 60 * 1_000;
  const samples = [];
  for (const file of listArchiveFiles(directory)) {
    if (file.hourMs + 3_600_000 < oldestMs || file.hourMs > observedAtMs) continue;
    for (const record of readRecords(join(directory, file.name))) {
      const timestamp = Date.parse(record.sample.observedAt);
      if (timestamp >= oldestMs && timestamp < observedAtMs) samples.push(record.sample);
    }
  }
  return samples;
}

function archiveSnapshot(raw, options) {
  const directory = resolve(options.directory);
  ensurePrivateDirectory(directory);
  const sample = normalizeSnapshot(raw);
  const observedAtMs = Date.parse(sample.observedAt);
  const nowMs = options.nowMs ?? Date.now();
  if (!Number.isFinite(nowMs) || Math.abs(observedAtMs - nowMs) > MAX_CLOCK_SKEW_MS) {
    throw new Error('Capacity snapshot clock differs from the local archive clock.');
  }
  rotateArchive(directory, nowMs);
  const history = readRecentHistory(directory, observedAtMs);
  const { alerts, overallStatus } = evaluateAlerts(history, sample);
  const record = { schemaVersion: ARCHIVE_SCHEMA_VERSION, sample, alerts, overallStatus };
  const filename = archiveFilename(sample.observedAt);
  const path = join(directory, filename);
  const records = readRecords(path);
  records.push(record);
  const boundedRecords = records.slice(-MAX_RECORDS_PER_HOUR);
  const content = `${boundedRecords.map((item) => JSON.stringify(item)).join('\n')}\n`;
  if (Buffer.byteLength(content) > MAX_HOURLY_FILE_BYTES) {
    throw new Error('Capacity archive hour exceeded its byte bound.');
  }
  writeAtomic(path, content);
  rotateArchive(directory, nowMs);
  return { alerts, filename, overallStatus, sample };
}

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--archive-dir' && argv[index + 1]) {
      options.directory = argv[++index];
      continue;
    }
    throw new Error('Usage: monitor-capacity-archive.cjs --archive-dir <directory>');
  }
  if (!options.directory) throw new Error('Capacity archive directory is required.');
  return options;
}

function readBoundedStdin() {
  const input = readFileSync(0);
  if (input.byteLength === 0 || input.byteLength > MAX_INPUT_BYTES) {
    throw new Error('Capacity snapshot input is empty or oversized.');
  }
  return JSON.parse(input.toString('utf8'));
}

function runCli(argv = process.argv.slice(2)) {
  const result = archiveSnapshot(readBoundedStdin(), parseArguments(argv));
  process.stdout.write(
    `capacity-summary status=${result.overallStatus} archive=${result.filename} retentionDays=${RETENTION_DAYS}\n`,
  );
  const action = result.sample.readiness.action;
  process.stdout.write(
    `capacity-action available=${action !== null} windowSec=${action?.windowSec ?? 'unknown'} ` +
      `total=${action?.total ?? 'unknown'} success=${action?.success ?? 'unknown'} ` +
      `failure=${action?.failure ?? 'unknown'} critical=${action?.critical ?? 'unknown'} ` +
      `errorRate=${action?.errorRate ?? 'unknown'} criticalRate=${action?.criticalRate ?? 'unknown'}\n`,
  );
  const fleet = result.sample.apiFleet;
  process.stdout.write(
    `capacity-api-fleet available=${fleet.available ?? 'unknown'} ` +
      `expected=${fleet.expectedRoleCount ?? 'unknown'} observed=${fleet.observedRoleCount ?? 'unknown'} ` +
      `singleton=${fleet.singletonRoleCount ?? 'unknown'} running=${fleet.runningRoleCount ?? 'unknown'} ` +
      `identity=${fleet.identityRoleCount ?? 'unknown'} ` +
      `exactImage=${fleet.exactImageRoleCount ?? 'unknown'} ` +
      `duplicates=${fleet.duplicateContainerCount ?? 'unknown'} ` +
      `unexpected=${fleet.unexpectedApiContainerCount ?? 'unknown'} ` +
      `unexpectedMain=${fleet.unexpectedMainContainerCount ?? 'unknown'} ` +
      `unexpectedScale=${fleet.unexpectedScaleContainerCount ?? 'unknown'} ` +
      `unexpectedManual=${fleet.unexpectedManualContainerCount ?? 'unknown'} ` +
      `restarts=${fleet.totalRestartCount ?? 'unknown'}\n`,
  );
  const restartEvidence = fleet.restartEvidence;
  process.stdout.write(
    `capacity-restarts version=1 basis=${restartEvidence?.basis ?? 'unknown'} ` +
      ['api', 'ocr', 'photo']
        .map(
          (name) =>
            `${name}Total=${restartEvidence?.[name].total ?? 'unknown'} ` +
            `${name}Delta=${restartEvidence?.[name].delta ?? 'unknown'} ` +
            `${name}GenerationChanged=${restartEvidence?.[name].generationChanged ?? 'unknown'}`,
        )
        .join(' ') +
      '\n',
  );
  for (const [id, alert] of Object.entries(result.alerts)) {
    process.stdout.write(
      `capacity-alert id=${id} outcome=${alert.outcome} severity=${alert.severity} ` +
        `value=${alert.value ?? 'unknown'} threshold=${alert.threshold} ` +
        `windowSec=${alert.windowSec} sustainedForSec=${alert.sustainedForSec}` +
        (alert.basis
          ? ` version=${alert.version} basis=${alert.basis} restartClass=${alert.restartClass}`
          : '') +
        '\n',
    );
  }
}

module.exports = {
  ALERT_DEFINITIONS,
  ARCHIVE_SCHEMA_VERSION,
  MAX_ARCHIVE_HOURS,
  MAX_RECORDS_PER_HOUR,
  RETENTION_DAYS,
  archiveFilename,
  archiveHourMs,
  archiveSnapshot,
  evaluateAlerts,
  normalizeActionHealth,
  normalizeApiFleet,
  normalizeSnapshot,
  rotateArchive,
};

if (require.main === module) {
  try {
    runCli();
  } catch {
    process.stderr.write('Capacity summary archival failed.\n');
    process.exitCode = 1;
  }
}
