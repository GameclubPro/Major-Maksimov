'use strict';

const { closeSync, constants, fstatSync, lstatSync, openSync, readSync } = require('node:fs');
const { homedir } = require('node:os');
const { join, resolve } = require('node:path');
const {
  archiveFilename,
  evaluateAlerts,
  normalizeFleetObservationFailure,
  normalizeSnapshot,
} = require('./monitor-capacity-archive.cjs');

const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_LINE_BYTES = 64 * 1024;
const MAX_FILE_RECORDS = 240;
const MAX_WINDOW_MS = 60 * 60_000;
const MAX_GAP_MS = 90_000;
const CHECKS = [
  'readiness',
  'queue_metrics',
  'system_mode',
  'queue_lag_warning',
  'queue_lag_critical',
  'quarantined_receipts',
  'queue_fence',
  'api_fleet_topology',
];

function instant(value) {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(value)
  ) {
    throw new Error('Expected an ISO UTC timestamp.');
  }
  const ms = Date.parse(value);
  const canonical = value.length === 20 ? `${value.slice(0, -1)}.000Z` : value;
  if (!Number.isFinite(ms) || new Date(ms).toISOString() !== canonical)
    throw new Error('Invalid timestamp.');
  return ms;
}

function windowBounds(from, to) {
  const start = instant(from);
  const end = instant(to);
  if (end - start < 60_000 || end - start > MAX_WINDOW_MS)
    throw new Error('Window must span 1-60 minutes.');
  return { start, end };
}

function assertPrivate(stats, directory = false) {
  if (
    (directory ? !stats.isDirectory() : !stats.isFile()) ||
    stats.isSymbolicLink() ||
    (stats.mode & 0o077) !== 0 ||
    (typeof process.getuid === 'function' && stats.uid !== process.getuid())
  ) {
    throw new Error('Archive must be private and owned by the current user.');
  }
}

function readHour(path, hourMs) {
  let descriptor;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw new Error('Cannot open private archive.');
  }
  try {
    const stats = fstatSync(descriptor);
    assertPrivate(stats);
    if (stats.size > MAX_FILE_BYTES) throw new Error('Archive is oversized.');
    // FLAG: Bound descriptor reads as well as stat checks, including concurrent file growth.
    const buffer = Buffer.alloc(MAX_FILE_BYTES + 1);
    let bytes = 0;
    while (bytes < buffer.length) {
      const read = readSync(descriptor, buffer, bytes, buffer.length - bytes, null);
      if (read === 0) break;
      bytes += read;
    }
    if (bytes > MAX_FILE_BYTES) throw new Error('Archive is oversized.');
    const samples = [];
    for (const line of buffer.toString('utf8', 0, bytes).split(/\r?\n/u)) {
      if (!line.trim()) continue;
      if (Buffer.byteLength(line) > MAX_LINE_BYTES || samples.length >= MAX_FILE_RECORDS)
        throw new Error('Archive record budget exceeded.');
      const record = JSON.parse(line);
      if (record?.schemaVersion !== 1) throw new Error('Invalid archive schema.');
      const sample = normalizeSnapshot(record.sample);
      if (Math.floor(Date.parse(sample.observedAt) / 3_600_000) * 3_600_000 !== hourMs)
        throw new Error('Archive hour mismatch.');
      samples.push(sample);
    }
    return samples;
  } finally {
    closeSync(descriptor);
  }
}

function readWindow(directory, bounds) {
  assertPrivate(lstatSync(directory), true);
  const samples = [];
  for (
    let hour = Math.floor(bounds.start / 3_600_000) * 3_600_000;
    hour < bounds.end;
    hour += 3_600_000
  ) {
    samples.push(...readHour(join(directory, archiveFilename(new Date(hour).toISOString())), hour));
  }
  return samples
    .filter((sample) => {
      const ms = Date.parse(sample.observedAt);
      return ms >= bounds.start && ms < bounds.end;
    })
    .sort((left, right) => Date.parse(left.observedAt) - Date.parse(right.observedAt));
}

function percentiles(values) {
  const sorted = values
    .filter((value) => typeof value === 'number' && Number.isFinite(value))
    .sort((a, b) => a - b);
  const pick = (quantile) =>
    sorted.length ? sorted[Math.max(0, Math.ceil(quantile * sorted.length) - 1)] : null;
  return {
    samples: sorted.length,
    min: sorted[0] ?? null,
    p50: pick(0.5),
    p95: pick(0.95),
    p99: pick(0.99),
    max: sorted.at(-1) ?? null,
  };
}

function summarizeRestarts(samples, bounds, coverageComplete) {
  const result = { version: 1, basis: 'container_generation_intervals' };
  for (const name of ['api', 'ocr', 'photo']) {
    let knownIntervals = 0;
    let unknownIntervals = 0;
    let generationChanges = 0;
    let confirmedDelta = 0;
    for (let index = 1; index < samples.length; index++) {
      const current = samples[index];
      const evidence = current.apiFleet.restartEvidence;
      const previous = samples[index - 1].observedAt;
      const intervalInsideWindow =
        evidence?.basis === 'container_generation_intervals' &&
        evidence.observedAt === current.observedAt &&
        evidence.previousObservedAt === previous &&
        Date.parse(previous) >= bounds.start &&
        Date.parse(current.observedAt) < bounds.end &&
        Date.parse(current.observedAt) - Date.parse(previous) <= MAX_GAP_MS;
      // FLAG: A missing archived endpoint can hide its delta. Only complete,
      // adjacent in-window generation intervals count; the first row is an anchor.
      if (intervalInsideWindow && evidence[name].generationChanged === true) generationChanges++;
      if (intervalInsideWindow && evidence[name].delta !== null) {
        knownIntervals++;
        confirmedDelta += evidence[name].delta;
      } else {
        unknownIntervals++;
      }
    }
    const complete = coverageComplete && knownIntervals > 0 && unknownIntervals === 0;
    result[name] = {
      maxObservedTotal: percentiles(
        samples.map((sample) => sample.apiFleet.restartEvidence?.[name].total ?? null),
      ).max,
      coverage: complete ? 'complete' : knownIntervals > 0 ? 'partial' : 'unavailable',
      knownIntervals,
      unknownIntervals,
      generationChanges,
      delta: complete ? confirmedDelta : null,
      confirmedDeltaLowerBound: knownIntervals > 0 ? confirmedDelta : null,
    };
  }
  result.coverage = ['api', 'ocr', 'photo'].every((name) => result[name].coverage === 'complete')
    ? 'complete'
    : ['api', 'ocr', 'photo'].some((name) => result[name].knownIntervals > 0)
      ? 'partial'
      : 'unavailable';
  return result;
}

function summarizeWindow(samples, bounds) {
  const times = samples.map((sample) => Date.parse(sample.observedAt));
  if (new Set(times).size !== times.length) throw new Error('Duplicate sample timestamps.');
  const boundaries = [bounds.start, ...times, bounds.end];
  const maxGapMs = Math.max(...boundaries.slice(1).map((time, index) => time - boundaries[index]));
  const coverageComplete =
    times.length >= Math.max(2, Math.floor((bounds.end - bounds.start) / 60_000)) &&
    maxGapMs <= MAX_GAP_MS;
  const checks = Object.fromEntries(CHECKS.map((id) => [id, { failing: 0, unknown: 0 }]));
  const fleetObservationFailures = {
    version: 1,
    failedSamples: 0,
    diagnosedSamples: 0,
    unknownCauseSamples: 0,
    missingSamples: 0,
    byStageAndCode: [],
  };
  const failureBuckets = new Map();
  for (const sample of samples) {
    if (sample.apiFleet.available === false) {
      fleetObservationFailures.failedSamples++;
      const failure = normalizeFleetObservationFailure(sample.apiFleet.observationFailure);
      if (failure === null) fleetObservationFailures.unknownCauseSamples++;
      else {
        fleetObservationFailures.diagnosedSamples++;
        const key = `${failure.stage}:${failure.code}`;
        const bucket = failureBuckets.get(key) ?? {
          stage: failure.stage,
          code: failure.code,
          samples: 0,
        };
        bucket.samples++;
        failureBuckets.set(key, bucket);
      }
    } else if (sample.apiFleet.available !== true) fleetObservationFailures.missingSamples++;
    const { alerts } = evaluateAlerts([], sample);
    for (const id of CHECKS) {
      if (alerts[id].outcome === 'firing') checks[id].failing++;
      if (alerts[id].outcome === 'unknown') checks[id].unknown++;
    }
  }
  fleetObservationFailures.byStageAndCode = [...failureBuckets.values()].sort((left, right) =>
    `${left.stage}:${left.code}`.localeCompare(`${right.stage}:${right.code}`),
  );
  const lagSec = percentiles(samples.map((sample) => sample.readiness.queueLagSec));
  const operationalLagSec = percentiles(
    samples.map((sample) => sample.readiness.operationalLagSec),
  );
  const restarts = summarizeRestarts(samples, bounds, coverageComplete);
  const restartCounts = samples.map((sample) => sample.apiFleet.totalRestartCount);
  let restartCounterIncreases = 0;
  let restartCounterResets = 0;
  for (let index = 1; index < restartCounts.length; index++) {
    const previous = restartCounts[index - 1];
    const current = restartCounts[index];
    if (previous === null || current === null) continue;
    if (current < previous) restartCounterResets++;
    else restartCounterIncreases += current - previous;
  }
  const unknown =
    !coverageComplete ||
    lagSec.samples !== samples.length ||
    restarts.coverage !== 'complete' ||
    Object.values(checks).some((check) => check.unknown > 0);
  const failed =
    ['api', 'ocr', 'photo'].some((name) => restarts[name].confirmedDeltaLowerBound > 0) ||
    Object.values(checks).some((check) => check.failing > 0);
  return {
    from: new Date(bounds.start).toISOString(),
    to: new Date(bounds.end).toISOString(),
    sampleCount: samples.length,
    coverage: {
      status: coverageComplete ? 'complete' : 'insufficient',
      maxGapSec: maxGapMs / 1_000,
    },
    status: failed ? 'degraded' : unknown ? 'unknown' : 'healthy',
    lagSec,
    operationalLagSec,
    operationalLagCoverage:
      operationalLagSec.samples === 0
        ? 'unavailable'
        : operationalLagSec.samples === samples.length
          ? 'complete'
          : 'partial',
    maxReadinessWaitingCount: percentiles(
      samples.map((sample) => sample.readiness.readinessWaitingCount),
    ).max,
    readinessHeadLimitReachedSamples: samples.filter(
      (sample) => sample.readiness.readinessHeadLimitReached === true,
    ).length,
    quarantine: {
      basis: 'retained_receipts_not_currently_blocked_chats',
      maxCountLowerBound: percentiles(
        samples.map((sample) => sample.readiness.quarantinedCountLowerBound),
      ).max,
      maxOldestAgeSec: percentiles(
        samples.map((sample) => sample.readiness.oldestQuarantinedAgeSec),
      ).max,
      sampleLimitReachedSamples: samples.filter(
        (sample) => sample.readiness.quarantineSampleLimitReached === true,
      ).length,
      knownSamples: samples.length - checks.quarantined_receipts.unknown,
    },
    checks,
    fleetObservationFailures,
    loadPerCpu: percentiles(
      samples.map((sample) =>
        sample.host.cpuCount && sample.host.load1 !== null
          ? sample.host.load1 / sample.host.cpuCount
          : null,
      ),
    ),
    iowaitPct: percentiles(samples.map((sample) => sample.host.cpuIowaitPct)),
    restarts,
    historicalRestartDiagnostic: {
      basis: 'legacy_total_counter_differences_not_generation_safe',
      maxObservedTotal: percentiles(restartCounts).max,
      counterIncreases: restartCounterIncreases,
      counterResets: restartCounterResets,
    },
    last: samples.length
      ? {
          observedAt: samples.at(-1).observedAt,
          mode: samples.at(-1).readiness.mode,
          condition: samples.at(-1).readiness.condition,
          queueLagSec: samples.at(-1).readiness.queueLagSec,
          operationalLagSec: samples.at(-1).readiness.operationalLagSec,
        }
      : null,
  };
}

function buildReport(options, nowMs = Date.now()) {
  const currentBounds = windowBounds(options.from, options.to);
  if (!Number.isFinite(nowMs) || currentBounds.end > nowMs) {
    throw new Error('Report window has not elapsed.');
  }
  const directory = resolve(options.directory);
  const current = summarizeWindow(readWindow(directory, currentBounds), currentBounds);
  const report = {
    schemaVersion: 2,
    basis: 'sampled_oldest_queue_lag_and_container_generation_intervals',
    current,
  };
  if (options.compareFrom !== undefined || options.compareTo !== undefined) {
    const baselineBounds = windowBounds(options.compareFrom, options.compareTo);
    if (
      baselineBounds.end - baselineBounds.start !== currentBounds.end - currentBounds.start ||
      baselineBounds.end > currentBounds.start
    ) {
      throw new Error('Comparison must be an earlier non-overlapping window of equal duration.');
    }
    report.baseline = summarizeWindow(readWindow(directory, baselineBounds), baselineBounds);
    const comparable =
      current.status !== 'unknown' &&
      report.baseline.status !== 'unknown' &&
      current.coverage.status === 'complete' &&
      report.baseline.coverage.status === 'complete' &&
      current.lagSec.samples === current.sampleCount &&
      report.baseline.lagSec.samples === report.baseline.sampleCount &&
      current.restarts.coverage === 'complete' &&
      report.baseline.restarts.coverage === 'complete' &&
      [current, report.baseline].every((window) =>
        Object.values(window.checks).every((check) => check.unknown === 0),
      );
    report.comparison = {
      comparable,
      p95LagChangeSec: comparable
        ? Number((current.lagSec.p95 - report.baseline.lagSec.p95).toFixed(6))
        : null,
      maxLagChangeSec: comparable
        ? Number((current.lagSec.max - report.baseline.lagSec.max).toFixed(6))
        : null,
    };
  }
  return report;
}

function parseArguments(argv) {
  const mapping = {
    '--archive-dir': 'directory',
    '--from': 'from',
    '--to': 'to',
    '--compare-from': 'compareFrom',
    '--compare-to': 'compareTo',
  };
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = Object.hasOwn(mapping, argv[index]) ? mapping[argv[index]] : null;
    if (!key || !argv[index + 1] || Object.hasOwn(options, key))
      throw new Error('Invalid report arguments.');
    options[key] = argv[index + 1];
  }
  options.directory ??= join(
    process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state'),
    'maxim',
    'capacity-monitor',
  );
  return options;
}

module.exports = { buildReport, parseArguments, percentiles, summarizeWindow, windowBounds };

if (require.main === module) {
  try {
    process.stdout.write(
      `${JSON.stringify(buildReport(parseArguments(process.argv.slice(2))), null, 2)}\n`,
    );
  } catch {
    process.stderr.write('Capacity report failed: check the UTC windows and private archive.\n');
    process.exitCode = 1;
  }
}
