import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import archive from './monitor-capacity-archive.cjs';
import reportModule from './monitor-capacity-report.cjs';

const report = {
  ...reportModule,
  buildReport: (options) => reportModule.buildReport(options, Date.parse('2026-09-15T00:00:00Z')),
};

const from = '2026-09-14T10:59:00Z';
const to = '2026-09-14T11:04:00Z';
const cli = new URL('./monitor-capacity-report.cjs', import.meta.url).pathname;

function sample(observedAt, lag = 0.5) {
  return {
    schemaVersion: 1,
    observedAt,
    host: { cpuCount: 8, load1: 4, cpuIowaitPct: 2 },
    readiness: {
      available: true,
      httpStatus: 200,
      ok: true,
      database: true,
      redis: true,
      rawOk: true,
      queueOk: true,
      softWarning: false,
      softWarningCode: 'none',
      queueLagSec: lag,
      quarantinedCountLowerBound: 0,
      quarantineSampleLimitReached: false,
      oldestQuarantinedAgeSec: 0,
      mode: 'normal',
      condition: 'healthy',
      burstActive: false,
    },
    adminReadiness: { available: true, httpStatus: 200, ok: true, database: true, redis: true },
    queueFence: {
      available: true,
      queueCount: 24,
      pausedCount: 0,
      activeCount: 0,
      ownerPresent: false,
    },
    apiFleet: {
      available: true,
      expectedRoleCount: 13,
      observedRoleCount: 13,
      singletonRoleCount: 13,
      runningRoleCount: 13,
      identityRoleCount: 13,
      exactImageRoleCount: 13,
      duplicateContainerCount: 0,
      unexpectedApiContainerCount: 0,
      unexpectedMainContainerCount: 0,
      unexpectedScaleContainerCount: 0,
      unexpectedManualContainerCount: 0,
      totalRestartCount: 0,
      restartEvidence: {
        version: 1,
        basis: 'container_generation_intervals',
        previousObservedAt: new Date(Date.parse(observedAt) - 15_000).toISOString(),
        observedAt,
        api: { total: 0, delta: 0, generationChanged: false },
        ocr: { total: 0, delta: 0, generationChanged: false },
        photo: { total: 0, delta: 0, generationChanged: false },
      },
    },
    token: 'private-token-sentinel',
    chatId: 'private-chat-sentinel',
    payload: 'private-payload-sentinel',
  };
}

function series(start = from, lag = 0.5) {
  return Array.from({ length: 20 }, (_, index) =>
    sample(new Date(Date.parse(start) + index * 15_000).toISOString(), lag),
  );
}

function fixture(t, samples = series()) {
  const directory = mkdtempSync(join(tmpdir(), 'maxim-capacity-report-'));
  chmodSync(directory, 0o700);
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const groups = new Map();
  for (const entry of samples) {
    const filename = archive.archiveFilename(entry.observedAt);
    const rows = groups.get(filename) ?? [];
    rows.push(JSON.stringify({ schemaVersion: 1, sample: entry, rawLog: 'private-log-sentinel' }));
    groups.set(filename, rows);
  }
  const files = [...groups].map(([filename, rows]) => {
    const path = join(directory, filename);
    writeFileSync(path, `${rows.join('\n')}\n`, { mode: 0o600 });
    return path;
  });
  return { directory, files };
}

test('reports a continuous cross-hour window without changing files or exposing raw metadata', (t) => {
  const { directory, files } = fixture(t);
  const before = files.map((path) => [readFileSync(path, 'utf8'), statSync(path).mtimeMs]);
  const result = report.buildReport({ directory, from, to });
  assert.equal(result.schemaVersion, 2);
  assert.equal(result.basis, 'sampled_oldest_queue_lag_and_container_generation_intervals');
  assert.equal(result.current.status, 'healthy');
  assert.equal(result.current.coverage.status, 'complete');
  assert.equal(result.current.sampleCount, 20);
  assert.deepEqual(result.current.lagSec, {
    samples: 20,
    min: 0.5,
    p50: 0.5,
    p95: 0.5,
    p99: 0.5,
    max: 0.5,
  });
  assert.doesNotMatch(JSON.stringify(result), /private-|chatId|payload|rawLog/u);
  assert.deepEqual(
    files.map((path) => [readFileSync(path, 'utf8'), statSync(path).mtimeMs]),
    before,
  );
});

test('reports finite fleet failure buckets while preserving unknown causes and restart intervals', (t) => {
  const rows = series();
  rows[2].apiFleet = {
    available: false,
    observationFailure: {
      version: 1,
      stage: 'docker_inspect',
      code: 'timeout',
      stderr: 'private-stderr',
    },
  };
  rows[5].apiFleet = { available: false };
  rows[7].apiFleet = {
    available: false,
    observationFailure: {
      version: 1,
      stage: 'private-stage',
      code: 'private-code',
    },
  };
  rows[9].apiFleet = {
    available: null,
    observationFailure: {
      version: 1,
      stage: 'docker_inspect',
      code: 'timeout',
    },
  };
  for (const index of [3, 6, 8, 10]) {
    for (const name of ['api', 'ocr', 'photo']) {
      rows[index].apiFleet.restartEvidence[name].delta = null;
      rows[index].apiFleet.restartEvidence[name].generationChanged = null;
    }
  }
  const { directory } = fixture(t, rows);
  const result = report.buildReport({ directory, from, to }).current;
  assert.deepEqual(result.fleetObservationFailures, {
    version: 1,
    failedSamples: 3,
    diagnosedSamples: 1,
    unknownCauseSamples: 2,
    missingSamples: 1,
    byStageAndCode: [{ stage: 'docker_inspect', code: 'timeout', samples: 1 }],
  });
  for (const name of ['api', 'ocr', 'photo']) {
    assert.equal(result.restarts[name].unknownIntervals, 8);
    assert.equal(result.restarts[name].coverage, 'partial');
    assert.equal(result.restarts[name].delta, null);
  }
  assert.equal(result.status, 'degraded');
  assert.deepEqual(result.checks.api_fleet_topology, { failing: 3, unknown: 1 });
  assert.doesNotMatch(JSON.stringify(result), /private-|stderr/u);
  const legacy = fixture(t);
  assert.deepEqual(
    report.buildReport({ directory: legacy.directory, from, to }).current.fleetObservationFailures,
    {
      version: 1,
      failedSamples: 0,
      diagnosedSamples: 0,
      unknownCauseSamples: 0,
      missingSamples: 0,
      byStageAndCode: [],
    },
  );
});

test('reports exact nearest-rank percentiles and does not count unknown lag as zero', () => {
  assert.deepEqual(
    report.percentiles([null, ...Array.from({ length: 100 }, (_, index) => index + 1)]),
    { samples: 100, min: 1, p50: 50, p95: 95, p99: 99, max: 100 },
  );
  assert.equal(report.percentiles([null]).p95, null);
});

test('reports distinct operational coverage without reconstructing older missing evidence', (t) => {
  const rows = series(from, 294);
  for (const row of rows.slice(1)) {
    row.readiness.operationalLagSec = 0.45;
    row.readiness.readinessWaitingCount = 1;
    row.readiness.readinessHeadLimitReached = false;
  }
  rows[1].readiness.readinessHeadLimitReached = true;
  const { directory } = fixture(t, rows);
  const result = report.buildReport({ directory, from, to }).current;
  assert.equal(result.lagSec.p95, 294);
  assert.equal(result.operationalLagSec.p95, 0.45);
  assert.equal(result.operationalLagSec.samples, 19);
  assert.equal(result.operationalLagCoverage, 'partial');
  assert.equal(result.maxReadinessWaitingCount, 1);
  assert.equal(result.readinessHeadLimitReachedSamples, 1);
  assert.equal(result.status, 'degraded');
  assert.equal(result.checks.queue_lag_critical.failing, 20);
  assert.equal(result.last.operationalLagSec, 0.45);

  const old = fixture(t);
  const legacy = report.buildReport({ directory: old.directory, from, to }).current;
  assert.equal(legacy.operationalLagSec.samples, 0);
  assert.equal(legacy.operationalLagSec.p95, null);
  assert.equal(legacy.operationalLagCoverage, 'unavailable');
  assert.equal(legacy.maxReadinessWaitingCount, null);
  assert.equal(legacy.readinessHeadLimitReachedSamples, 0);
  assert.equal(legacy.last.operationalLagSec, null);
});

test('distinguishes missing archive coverage from healthy runtime', (t) => {
  const { directory } = fixture(t, []);
  const result = report.buildReport({ directory, from, to });
  assert.equal(result.current.status, 'unknown');
  assert.equal(result.current.coverage.status, 'insufficient');
  assert.equal(result.current.lagSec.samples, 0);
  assert.equal(result.current.last, null);
});

test('rejects sparse gaps even when enough samples exist', (t) => {
  const rows = series().filter((_row, index) => index < 5 || index > 13);
  const { directory } = fixture(t, rows);
  const result = report.buildReport({ directory, from, to });
  assert.equal(result.current.status, 'unknown');
  assert.equal(result.current.coverage.status, 'insufficient');
  assert.equal(result.current.coverage.maxGapSec, 150);
});

test('keeps readiness, stale data, queue fences, and fleet failures visible', (t) => {
  const rows = series();
  rows[0].adminReadiness.ok = false;
  rows[1].queueFence.ownerPresent = true;
  rows[2].apiFleet.exactImageRoleCount = 12;
  rows[3].readiness.softWarning = true;
  rows[3].readiness.softWarningCode = 'stale-ready-fallback';
  rows[4].readiness.queueLagSec = 40;
  const { directory } = fixture(t, rows);
  const result = report.buildReport({ directory, from, to });
  assert.equal(result.current.status, 'degraded');
  for (const key of [
    'readiness',
    'queue_fence',
    'api_fleet_topology',
    'queue_metrics',
    'queue_lag_critical',
  ]) {
    assert.equal(result.current.checks[key].failing, 1);
  }
});

test('reports quarantine separately and refuses a green window with isolated receipts', (t) => {
  const rows = series();
  rows[0].readiness.quarantinedCountLowerBound = 2;
  rows[0].readiness.oldestQuarantinedAgeSec = 90;
  rows[1].readiness.quarantinedCountLowerBound = 65;
  rows[1].readiness.quarantineSampleLimitReached = true;
  rows[1].readiness.oldestQuarantinedAgeSec = 105;
  const { directory } = fixture(t, rows);
  const result = report.buildReport({ directory, from, to }).current;
  assert.equal(result.status, 'degraded');
  assert.deepEqual(result.checks.quarantined_receipts, { failing: 2, unknown: 0 });
  assert.deepEqual(result.checks.readiness, { failing: 0, unknown: 0 });
  assert.deepEqual(result.quarantine, {
    basis: 'retained_receipts_not_currently_blocked_chats',
    maxCountLowerBound: 65,
    maxOldestAgeSec: 105,
    sampleLimitReachedSamples: 1,
    knownSamples: 20,
  });
});

test('older archives retain unknown quarantine coverage instead of a synthetic zero', (t) => {
  const rows = series();
  for (const row of rows) {
    delete row.readiness.quarantinedCountLowerBound;
    delete row.readiness.quarantineSampleLimitReached;
    delete row.readiness.oldestQuarantinedAgeSec;
  }
  const { directory } = fixture(t, rows);
  const result = report.buildReport({ directory, from, to }).current;
  assert.equal(result.status, 'unknown');
  assert.equal(result.coverage.status, 'complete');
  assert.deepEqual(result.checks.quarantined_receipts, { failing: 0, unknown: 20 });
  assert.equal(result.quarantine.maxCountLowerBound, null);
  assert.equal(result.quarantine.knownSamples, 0);
});

test('compares equal earlier windows while retaining known failures in the baseline', (t) => {
  const compareFrom = '2026-09-14T10:54:00Z';
  const compareTo = from;
  const { directory } = fixture(t, [...series(compareFrom, 20), ...series()]);
  const result = report.buildReport({ directory, from, to, compareFrom, compareTo });
  assert.equal(result.baseline.status, 'degraded');
  assert.deepEqual(result.comparison, {
    comparable: true,
    p95LagChangeSec: -19.5,
    maxLagChangeSec: -19.5,
  });
});

test('does not compare incomplete or partly unknown baselines', (t) => {
  const compareFrom = '2026-09-14T10:54:00Z';
  const rows = series(compareFrom, 20);
  rows[0].apiFleet.available = null;
  const { directory } = fixture(t, [...rows, ...series()]);
  const result = report.buildReport({ directory, from, to, compareFrom, compareTo: from });
  assert.deepEqual(result.comparison, {
    comparable: false,
    p95LagChangeSec: null,
    maxLagChangeSec: null,
  });
});

test('old archive totals never prove generation-safe restart coverage', (t) => {
  const rows = series();
  for (const row of rows) {
    row.apiFleet.totalRestartCount = 5;
    delete row.apiFleet.restartEvidence;
  }
  const stable = fixture(t, rows);
  assert.equal(
    report.buildReport({ directory: stable.directory, from, to }).current.status,
    'unknown',
  );
  rows.at(-1).apiFleet.totalRestartCount = 6;
  const increased = fixture(t, rows);
  const increase = report.buildReport({ directory: increased.directory, from, to }).current;
  assert.equal(increase.status, 'unknown');
  assert.equal(increase.historicalRestartDiagnostic.counterIncreases, 1);
  assert.equal(increase.restarts.api.delta, null);
  assert.equal(increase.restarts.api.coverage, 'unavailable');
  rows.at(-1).apiFleet.totalRestartCount = 0;
  const reset = fixture(t, rows);
  const changed = report.buildReport({ directory: reset.directory, from, to }).current;
  assert.equal(changed.status, 'unknown');
  assert.equal(changed.historicalRestartDiagnostic.counterResets, 1);
});

test('historical native restarts stay separate from confirmed current API intervals', (t) => {
  const rows = series();
  for (const row of rows) {
    row.apiFleet.totalRestartCount = 12;
    row.apiFleet.restartEvidence.ocr.total = 12;
  }
  const { directory } = fixture(t, rows);
  const current = report.buildReport({ directory, from, to }).current;
  assert.equal(current.status, 'healthy');
  assert.equal(current.restarts.coverage, 'complete');
  assert.equal(current.restarts.api.maxObservedTotal, 0);
  assert.equal(current.restarts.ocr.maxObservedTotal, 12);
  assert.equal(current.restarts.api.delta, 0);
  assert.equal(current.restarts.ocr.delta, 0);
  assert.equal(current.restarts.api.knownIntervals, 19);
  const { alerts } = archive.evaluateAlerts([], archive.normalizeSnapshot(rows.at(-1)));
  assert.equal(alerts.api_fleet_restarts.outcome, 'clear');
  assert.equal(alerts.api_fleet_restarts.version, 2);
  assert.equal(alerts.api_fleet_restarts.basis, 'container_generation_intervals');
  assert.equal(alerts.ocr_native_restarts.outcome, 'clear');
  assert.equal(alerts.photo_native_restarts.outcome, 'clear');
});

test('confirmed API and photo deltas remain separate and degrade their window', (t) => {
  const rows = series();
  const last = rows.at(-1);
  last.apiFleet.totalRestartCount = 3;
  last.apiFleet.restartEvidence.api = { total: 1, delta: 1, generationChanged: false };
  last.apiFleet.restartEvidence.photo = { total: 2, delta: 2, generationChanged: false };
  const { directory } = fixture(t, rows);
  const current = report.buildReport({ directory, from, to }).current;
  assert.equal(current.status, 'degraded');
  assert.equal(current.restarts.api.delta, 1);
  assert.equal(current.restarts.photo.delta, 2);
  assert.equal(current.restarts.ocr.delta, 0);
  const { alerts } = archive.evaluateAlerts([], archive.normalizeSnapshot(last));
  assert.equal(alerts.api_fleet_restarts.outcome, 'firing');
  assert.equal(alerts.photo_native_restarts.outcome, 'firing');
  assert.equal(alerts.ocr_native_restarts.outcome, 'clear');
});

test('replacement with equal aggregate totals cannot certify a stable window', (t) => {
  const rows = series();
  for (const row of rows) {
    row.apiFleet.totalRestartCount = 5;
    row.apiFleet.restartEvidence.api.total = 5;
  }
  rows.at(-1).apiFleet.restartEvidence.api.generationChanged = true;
  const { directory } = fixture(t, rows);
  const current = report.buildReport({ directory, from, to }).current;
  assert.equal(current.status, 'unknown');
  assert.equal(current.historicalRestartDiagnostic.counterIncreases, 0);
  assert.equal(current.historicalRestartDiagnostic.counterResets, 0);
  assert.equal(current.restarts.api.generationChanges, 1);
  assert.equal(current.restarts.api.delta, null);
  assert.equal(current.restarts.api.coverage, 'partial');
  assert.equal(current.restarts.ocr.coverage, 'complete');
});

test('prewindow deltas are excluded and cannot substitute for an in-window endpoint', (t) => {
  const rows = series();
  for (const row of rows) {
    row.apiFleet.totalRestartCount = 2;
    row.apiFleet.restartEvidence.photo.total = 2;
  }
  rows[0].apiFleet.restartEvidence.photo.delta = 2;
  const anchor = fixture(t, rows);
  const excluded = report.buildReport({ directory: anchor.directory, from, to }).current;
  assert.equal(excluded.status, 'healthy');
  assert.equal(excluded.restarts.photo.delta, 0);
  rows[1].apiFleet.restartEvidence.previousObservedAt =
    rows[0].apiFleet.restartEvidence.previousObservedAt;
  rows[1].apiFleet.restartEvidence.photo.delta = 2;
  const crossing = fixture(t, rows);
  const unknown = report.buildReport({ directory: crossing.directory, from, to }).current;
  assert.equal(unknown.status, 'unknown');
  assert.equal(unknown.restarts.photo.delta, null);
  assert.equal(unknown.restarts.photo.confirmedDeltaLowerBound, 0);
  assert.equal(unknown.restarts.photo.unknownIntervals, 1);
});

test('missing archived endpoint and independent class gaps retain unknown coverage', (t) => {
  const rows = series();
  rows[5].apiFleet.restartEvidence.ocr = { total: null, delta: null, generationChanged: null };
  const partial = fixture(t, rows);
  const independent = report.buildReport({ directory: partial.directory, from, to }).current;
  assert.equal(independent.status, 'unknown');
  assert.equal(independent.restarts.api.coverage, 'complete');
  assert.equal(independent.restarts.photo.coverage, 'complete');
  assert.equal(independent.restarts.ocr.coverage, 'partial');
  assert.equal(independent.restarts.ocr.delta, null);
  const missing = fixture(
    t,
    rows.filter((_row, index) => index !== 5),
  );
  const gap = report.buildReport({ directory: missing.directory, from, to }).current;
  assert.equal(gap.coverage.status, 'complete');
  assert.equal(gap.status, 'unknown');
  assert.equal(gap.restarts.api.unknownIntervals, 1);
});

test('restart evidence admits only versioned timestamps and bounded independent class scalars', () => {
  const raw = sample('2026-09-14T11:00:00.000Z');
  raw.apiFleet.restartEvidence.privateId = 'private-container-id';
  raw.apiFleet.restartEvidence.api.privateCause = 'private-timeout-guess';
  raw.apiFleet.restartEvidence.ocr.delta = '0';
  let normalized = archive.normalizeSnapshot(raw);
  assert.equal(normalized.apiFleet.available, true);
  assert.equal(normalized.apiFleet.restartEvidence.api.delta, 0);
  assert.equal(normalized.apiFleet.restartEvidence.ocr.delta, null);
  assert.equal(normalized.apiFleet.restartEvidence.photo.delta, 0);
  assert.doesNotMatch(JSON.stringify(normalized), /private-/u);
  for (const [field, value] of [
    ['version', 2],
    ['basis', 'private-invalid'],
    ['observedAt', '2026-09-14T11:00:01.000Z'],
  ]) {
    const invalid = structuredClone(raw);
    invalid.apiFleet.restartEvidence[field] = value;
    normalized = archive.normalizeSnapshot(invalid);
    assert.equal(normalized.apiFleet.restartEvidence, null);
    assert.equal(normalized.apiFleet.available, true);
    assert.equal(normalized.apiFleet.totalRestartCount, 0);
  }
  raw.apiFleet.restartEvidence.previousObservedAt = '2026-09-14T10:58:00.000Z';
  normalized = archive.normalizeSnapshot(raw);
  assert.equal(normalized.apiFleet.restartEvidence.api.total, 0);
  assert.equal(normalized.apiFleet.restartEvidence.api.delta, null);
  assert.equal(normalized.apiFleet.restartEvidence.previousObservedAt, '2026-09-14T10:58:00.000Z');
  raw.apiFleet.restartEvidence.basis = 'historical_container_totals';
  normalized = archive.normalizeSnapshot(raw);
  assert.equal(normalized.apiFleet.restartEvidence.api.delta, null);
  assert.equal(normalized.apiFleet.restartEvidence.api.generationChanged, null);
  assert.equal(normalized.apiFleet.restartEvidence.previousObservedAt, null);
});

test('legacy baseline with equal totals is not comparable to a proven current window', (t) => {
  const compareFrom = '2026-09-14T10:54:00Z';
  const baseline = series(compareFrom);
  for (const row of baseline) delete row.apiFleet.restartEvidence;
  const { directory } = fixture(t, [...baseline, ...series()]);
  const result = report.buildReport({ directory, from, to, compareFrom, compareTo: from });
  assert.equal(result.current.status, 'healthy');
  assert.equal(result.baseline.status, 'unknown');
  assert.equal(result.comparison.comparable, false);
  assert.equal(result.comparison.p95LagChangeSec, null);
});

test('archive rewriting retains explicit historical and current restart alert meanings', (t) => {
  const { directory } = fixture(t, []);
  const first = sample('2026-09-14T10:59:00.000Z');
  delete first.apiFleet.restartEvidence;
  const path = join(directory, archive.archiveFilename(first.observedAt));
  writeFileSync(
    path,
    JSON.stringify({
      schemaVersion: 1,
      sample: first,
      overallStatus: 'ok',
      alerts: { api_fleet_restarts: { outcome: 'clear', value: 0 } },
    }) + '\n',
    { mode: 0o600 },
  );
  for (const observedAt of ['2026-09-14T10:59:15.000Z', '2026-09-14T10:59:30.000Z']) {
    archive.archiveSnapshot(sample(observedAt), { directory, nowMs: Date.parse(observedAt) });
  }
  const records = readFileSync(path, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert.equal(records[0].sample.apiFleet.restartEvidence, null);
  assert.equal(records[0].alerts.api_fleet_restarts.version, 1);
  assert.equal(records[0].alerts.api_fleet_restarts.basis, 'historical_container_totals');
  assert.equal(records[0].alerts.ocr_native_restarts.outcome, 'unknown');
  assert.equal(records[1].alerts.api_fleet_restarts.version, 2);
  assert.equal(records[1].alerts.api_fleet_restarts.basis, 'container_generation_intervals');
  assert.equal(records[1].alerts.api_fleet_restarts.outcome, 'clear');
});

test('a proved class restart remains visible when another class is unknown', (t) => {
  const rows = series();
  rows.at(-1).apiFleet.totalRestartCount = 1;
  rows.at(-1).apiFleet.restartEvidence.api = { total: 1, delta: 1, generationChanged: false };
  rows.at(-1).apiFleet.restartEvidence.photo = {
    total: null,
    delta: null,
    generationChanged: null,
  };
  const { directory } = fixture(t, rows);
  const current = report.buildReport({ directory, from, to }).current;
  assert.equal(current.status, 'degraded');
  assert.equal(current.restarts.api.delta, 1);
  assert.equal(current.restarts.photo.delta, null);
  assert.equal(current.restarts.coverage, 'partial');
});

test('rejects excessive, reversed, malformed, timezone-free, and overlapping windows', (t) => {
  for (const [start, end] of [
    [to, from],
    [from, '2026-09-14T13:00:00Z'],
    ['2026-02-30T10:00:00Z', to],
    ['2026-09-14T10:59:00', to],
    [from, '2026-09-14T10:59:30Z'],
  ])
    assert.throws(() => report.windowBounds(start, end));
  const { directory } = fixture(t);
  assert.throws(() =>
    report.buildReport({ directory, from, to, compareFrom: from, compareTo: to }),
  );
  assert.throws(() =>
    report.buildReport({
      directory,
      from,
      to,
      compareFrom: '2026-09-14T10:57:00Z',
      compareTo: from,
    }),
  );
  assert.throws(() => report.parseArguments(['--from', from, '--from', from]));
  assert.throws(() => report.parseArguments(['__proto__', 'value']));
});

test('rejects a still-open window instead of reporting healthy future coverage', (t) => {
  const { directory } = fixture(t);
  assert.throws(
    () => reportModule.buildReport({ directory, from, to }, Date.parse(to) - 1),
    /not elapsed/u,
  );
  assert.equal(
    reportModule.buildReport({ directory, from, to }, Date.parse(to)).current.status,
    'healthy',
  );
});

test('rejects duplicate timestamps, wrong hours, oversized files, and excess record counts', (t) => {
  const duplicate = fixture(t, [...series(), series()[0]]);
  assert.throws(
    () => report.buildReport({ directory: duplicate.directory, from, to }),
    /Duplicate/u,
  );
  const wrongHour = fixture(t);
  writeFileSync(
    wrongHour.files[0],
    JSON.stringify({ schemaVersion: 1, sample: sample('2026-09-14T12:00:00Z') }),
  );
  assert.throws(
    () => report.buildReport({ directory: wrongHour.directory, from, to }),
    /hour mismatch/u,
  );
  const oversized = fixture(t);
  truncateSync(oversized.files[0], 8 * 1024 * 1024 + 1);
  assert.throws(
    () => report.buildReport({ directory: oversized.directory, from, to }),
    /oversized/u,
  );
  const crowded = fixture(
    t,
    Array.from({ length: 241 }, (_, index) =>
      sample(new Date(Date.parse(from) + index).toISOString()),
    ),
  );
  assert.throws(
    () => report.buildReport({ directory: crowded.directory, from, to }),
    /record budget/u,
  );
});

test('refuses symlinked or publicly readable archives and never creates an absent directory', (t) => {
  const data = fixture(t);
  const link = join(data.directory, 'link');
  symlinkSync(data.directory, link);
  assert.throws(() => report.buildReport({ directory: link, from, to }));
  const target = join(data.directory, 'target');
  writeFileSync(target, readFileSync(data.files[0]), { mode: 0o600 });
  rmSync(data.files[0]);
  symlinkSync(target, data.files[0]);
  assert.throws(() => report.buildReport({ directory: data.directory, from, to }));
  const publicFile = fixture(t);
  chmodSync(publicFile.files[0], 0o644);
  assert.throws(() => report.buildReport({ directory: publicFile.directory, from, to }));
  chmodSync(publicFile.directory, 0o755);
  assert.throws(() => report.buildReport({ directory: publicFile.directory, from, to }));
  const missing = join(data.directory, 'absent');
  assert.throws(() => report.buildReport({ directory: missing, from, to }));
  assert.throws(() => statSync(missing), { code: 'ENOENT' });
});

test('CLI outputs only sanitized JSON and hides malformed input from errors', (t) => {
  const cliFrom = new Date(Date.now() - 600_000).toISOString();
  const cliTo = new Date(Date.parse(cliFrom) + 300_000).toISOString();
  const { directory, files } = fixture(t, series(cliFrom));
  const args = [cli, '--archive-dir', directory, '--from', cliFrom, '--to', cliTo];
  const success = spawnSync(process.execPath, args, { encoding: 'utf8' });
  assert.equal(success.status, 0, success.stderr);
  assert.equal(JSON.parse(success.stdout).current.status, 'healthy');
  assert.doesNotMatch(success.stdout, /private-/u);
  writeFileSync(files[0], 'invalid-private-secret-contents');
  const failure = spawnSync(process.execPath, args, { encoding: 'utf8' });
  assert.equal(failure.status, 1);
  assert.equal(failure.stdout, '');
  assert.doesNotMatch(failure.stderr, /invalid-private-secret-contents/u);
});
