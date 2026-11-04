'use strict';

const { spawn } = require('node:child_process');
const { lstatSync, readFileSync, statfsSync } = require('node:fs');
const os = require('node:os');
const { resolve } = require('node:path');
const { performance } = require('node:perf_hooks');
const readyMonitorPath =
  __filename === '[stdin]'
    ? resolve(process.cwd(), 'infra/scripts/monitor-ready-status.cjs')
    : resolve(__dirname, 'monitor-ready-status.cjs');
const { ADMIN_READY_URL, INGRESS_READY_URL, probeReadyEndpoint, readBoundedResponseBody } = require(
  readyMonitorPath,
);
const photoBoundaryPath =
  __filename === '[stdin]'
    ? resolve(process.cwd(), 'infra/scripts/photo-native-runtime-boundary.cjs')
    : resolve(__dirname, 'photo-native-runtime-boundary.cjs');
let photoBoundary;
try {
  photoBoundary = require(photoBoundaryPath);
} catch {
  photoBoundary = null;
}

const DEFAULT_BLOCK_DEVICE = 'md1';
const DEFAULT_DISK_PATH = '/var/lib/docker';
const DEFAULT_SAMPLE_MS = 1_000;
const MAX_PROCESS_OUTPUT_BYTES = 64 * 1024;
const MAX_DOCKER_INSPECT_BYTES = 16 * 1024 * 1024;
const MAX_DOCKER_CONTAINER_COUNT = 128;
const PROCESS_TIMEOUT_MS = 5_000;
const RESTART_SAMPLE_GAP_MS = 90_000;
const STREAM_IDLE_MS = 90_000;
const STREAM_LIFETIME_MS = 3_600_000;
const QUEUE_CONTROL_HELPER = 'infra/scripts/webhook-queue-rollout-control.cjs';
const RELEASE_MANIFEST_PATH = resolve(
  process.env.MAXIM_RELEASE_STATE_DIR || '/var/lib/maxim-deploy',
  'current.json',
);
const MAX_RELEASE_MANIFEST_BYTES = 64 * 1024;
const DEFAULT_EXPECTED_API_SERVICES = Object.freeze([
  'api-ingress',
  'api-admin',
  'api-enqueue',
  'api-moderation',
  'api-moderation-critical',
  'api-moderation-join',
  'api-moderation-realtime-b',
  'api-moderation-realtime-c',
  'api-moderation-realtime-d',
  'api-moderation-background',
  'api-media-analysis',
  'api-action',
  'api-publisher',
  'api-message-retention',
]);
const HISTORICALLY_OPTIONAL_API_SERVICES = new Set([
  'api-media-analysis',
  'api-publisher',
  'api-message-retention',
]);
const OCR_NATIVE_SANDBOX_SERVICE = 'ocr-native-sandbox';
const PHOTO_NATIVE_SANDBOX_SERVICE = 'photo-native-sandbox';
const OCR_NATIVE_SANDBOX_COMMAND = Object.freeze([
  'node',
  'apps/api/dist/apps/api/src/moderation/commercial-ocr/native-ocr-sandbox.entrypoint.js',
]);
const OCR_NATIVE_SANDBOX_REQUIRED_ENV = Object.freeze({
  NODE_ENV: 'production',
  COMMERCIAL_OCR_NATIVE_SANDBOX_SOCKET_PATH: '/run/maxim-ocr/native-ocr.sock',
  PHOTO_DUPLICATE_MAX_BYTES: '16777216',
  COMMERCIAL_OCR_MAX_INPUT_PIXELS: '40000000',
  COMMERCIAL_OCR_MAX_OUTPUT_PIXELS: '3000000',
  COMMERCIAL_OCR_MAX_SIDE: '2000',
  COMMERCIAL_OCR_TESSERACT_BINARY: 'tesseract',
  COMMERCIAL_OCR_TESSERACT_CONCURRENCY: '1',
  COMMERCIAL_OCR_TESSERACT_MAX_QUEUE: '4',
  COMMERCIAL_OCR_TESSERACT_TIMEOUT_MS: '10000',
  COMMERCIAL_OCR_TESSERACT_RECYCLE_AFTER_JOBS: '250',
  COMMERCIAL_OCR_TESSERACT_MAX_IMAGE_BYTES: '16777216',
  COMMERCIAL_OCR_TESSERACT_MAX_OUTPUT_BYTES: '4194304',
  OMP_THREAD_LIMIT: '1',
});
const OCR_NATIVE_SANDBOX_ALLOWED_IMAGE_ENV = new Set([
  'HOME',
  'NODE_EXTRA_CA_CERTS',
  'NODE_VERSION',
  'PATH',
  'YARN_VERSION',
]);
const SAFE_IMAGE_REF_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._/:@-]{0,511}$/u;
const DIGEST_IMAGE_REF_PATTERN = /@sha256:[0-9a-f]{64}$/u;
const FULL_SHA_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const IMAGE_ID_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const RELEASE_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/u;
const REQUIRED_RELEASE_COMPONENTS = Object.freeze([
  'api-shared',
  'miniapp-major-static',
  'admin-static',
]);
const SUPPORTED_RELEASE_COMPONENTS = new Set([...REQUIRED_RELEASE_COMPONENTS, 'eraser']);
const EXPECTED_APP_ROLE_BY_SERVICE = Object.freeze({
  'api-ingress': 'ingress',
  'api-admin': 'admin',
  'api-enqueue': 'enqueue',
  'api-moderation': 'moderation',
  'api-moderation-critical': 'moderation',
  'api-moderation-join': 'moderation',
  'api-moderation-realtime-b': 'moderation',
  'api-moderation-realtime-c': 'moderation',
  'api-moderation-realtime-d': 'moderation',
  'api-moderation-background': 'moderation',
  'api-media-analysis': 'moderation',
  'api-action': 'action',
  'api-publisher': 'publisher',
  'api-message-retention': 'message-retention',
});
const API_ROLES = new Set([
  'message-retention',
  'all',
  'ingress',
  'admin',
  'enqueue',
  'moderation',
  'action',
  'publisher',
]);
const DOCKER_TOKEN_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/u;
const DOCKER_STATUS_PATTERN = /^(?:created|running|paused|restarting|removing|exited|dead)$/u;

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function finiteNonNegative(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function normalizeActionHealth(raw) {
  if (!isRecord(raw)) return null;
  const windowSec = raw.windowSec;
  const total = raw.total;
  const success = raw.success;
  const failure = raw.failure;
  const critical = raw.critical;
  const errorRate = raw.errorRate;
  const criticalRate = raw.criticalRate;
  const integers = [windowSec, total, success, failure, critical];
  if (
    !Number.isSafeInteger(windowSec) ||
    windowSec <= 0 ||
    windowSec > 86_400 ||
    integers.slice(1).some((value) => !Number.isSafeInteger(value) || value < 0) ||
    total !== success + failure ||
    critical > failure ||
    ![errorRate, criticalRate].every(
      (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1,
    )
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

function parseProcStat(raw) {
  const line = raw.split(/\r?\n/u).find((candidate) => candidate.startsWith('cpu '));
  if (!line) throw new Error('Host CPU counters are unavailable.');
  const values = line.trim().split(/\s+/u).slice(1, 9).map(Number);
  if (values.length < 5 || values.some((value) => !Number.isFinite(value) || value < 0)) {
    throw new Error('Host CPU counters are invalid.');
  }
  return {
    total: values.reduce((sum, value) => sum + value, 0),
    iowait: values[4],
  };
}

function parseVmstat(raw) {
  const values = new Map();
  for (const line of raw.split(/\r?\n/u)) {
    const match = /^([a-z_]+)\s+(\d+)$/u.exec(line.trim());
    if (match) values.set(match[1], Number(match[2]));
  }
  const swapInPages = values.get('pswpin');
  if (!Number.isSafeInteger(swapInPages) || swapInPages < 0) {
    throw new Error('Host swap-in counter is unavailable.');
  }
  return { swapInPages };
}

function parseMeminfo(raw) {
  const values = new Map();
  for (const line of raw.split(/\r?\n/u)) {
    const match = /^([A-Za-z_()]+):\s+(\d+)\s+kB$/u.exec(line.trim());
    if (match) values.set(match[1], Number(match[2]) * 1024);
  }
  const required = ['MemTotal', 'MemAvailable', 'SwapTotal', 'SwapFree'];
  if (required.some((field) => !Number.isSafeInteger(values.get(field)))) {
    throw new Error('Host memory counters are unavailable.');
  }
  return {
    memoryTotalBytes: values.get('MemTotal'),
    memoryAvailableBytes: values.get('MemAvailable'),
    swapTotalBytes: values.get('SwapTotal'),
    swapUsedBytes: Math.max(0, values.get('SwapTotal') - values.get('SwapFree')),
  };
}

function parseDiskstats(raw, device) {
  const line = raw
    .split(/\r?\n/u)
    .map((candidate) => candidate.trim().split(/\s+/u))
    .find((fields) => fields[2] === device);
  if (!line || line.length < 14) throw new Error('Host block-device counters are unavailable.');
  const ioMs = Number(line[12]);
  const weightedIoMs = Number(line[13]);
  if (![ioMs, weightedIoMs].every((value) => Number.isFinite(value) && value >= 0)) {
    throw new Error('Host block-device counters are invalid.');
  }
  return { ioMs, weightedIoMs };
}

function calculateCounterRates(before, after, elapsedMs) {
  if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) {
    throw new Error('Capacity sample interval is invalid.');
  }
  const cpuDelta = after.cpu.total - before.cpu.total;
  const iowaitDelta = after.cpu.iowait - before.cpu.iowait;
  const swapInDelta = after.vmstat.swapInPages - before.vmstat.swapInPages;
  const diskIoDelta = after.disk.ioMs - before.disk.ioMs;
  const weightedIoDelta = after.disk.weightedIoMs - before.disk.weightedIoMs;
  if (
    [cpuDelta, iowaitDelta, swapInDelta, diskIoDelta, weightedIoDelta].some((value) => value < 0)
  ) {
    throw new Error('Capacity counters moved backwards.');
  }
  return {
    cpuIowaitPct: cpuDelta > 0 ? (iowaitDelta / cpuDelta) * 100 : null,
    swapInPagesPerSec: (swapInDelta * 1_000) / elapsedMs,
    diskUtilPct: Math.min(100, (diskIoDelta / elapsedMs) * 100),
    diskAvgQueueDepth: weightedIoDelta / elapsedMs,
  };
}

function readHostCounters(device) {
  return {
    cpu: parseProcStat(readFileSync('/proc/stat', 'utf8')),
    vmstat: parseVmstat(readFileSync('/proc/vmstat', 'utf8')),
    disk: parseDiskstats(readFileSync('/proc/diskstats', 'utf8'), device),
  };
}

function diskCapacity(path) {
  const stats = statfsSync(path, { bigint: true });
  const totalBytes = stats.blocks * stats.bsize;
  const availableBytes = stats.bavail * stats.bsize;
  if (totalBytes <= 0n || availableBytes < 0n || availableBytes > totalBytes) {
    throw new Error('Host filesystem counters are invalid.');
  }
  return {
    totalBytes: Number(totalBytes),
    availableBytes: Number(availableBytes),
    usedPct: Number(((totalBytes - availableBytes) * 10_000n) / totalBytes) / 100,
  };
}

function unwrapHealthBody(raw) {
  if (!isRecord(raw)) return {};
  return isRecord(raw.message) ? raw.message : raw;
}

function normalizeReadyProbe(probe, includeQueue) {
  const body = unwrapHealthBody(probe?.body);
  const checks = isRecord(body.checks) ? body.checks : {};
  const queueLag = isRecord(checks.queueLag) ? checks.queueLag : {};
  const systemMode = isRecord(body.systemMode) ? body.systemMode : {};
  const burst = isRecord(body.burst) ? body.burst : {};
  const httpStatus = Number.isInteger(probe?.httpStatus) ? probe.httpStatus : null;
  const softWarning = typeof queueLag.softWarning === 'boolean' ? queueLag.softWarning : null;
  const softWarningCode =
    softWarning === false && queueLag.softWarningCode === null
      ? 'none'
      : softWarning === true &&
          ['queue-lag-hysteresis', 'stale-ready-fallback'].includes(queueLag.softWarningCode)
        ? queueLag.softWarningCode
        : 'unknown';
  const result = {
    available: httpStatus !== null && typeof body.ok === 'boolean',
    httpStatus,
    ok: typeof body.ok === 'boolean' ? body.ok : null,
    database: typeof checks.database === 'boolean' ? checks.database : null,
    redis: typeof checks.redis === 'boolean' ? checks.redis : null,
  };
  if (!includeQueue) return result;
  return {
    ...result,
    rawOk: typeof queueLag.rawOk === 'boolean' ? queueLag.rawOk : null,
    queueOk: typeof queueLag.ok === 'boolean' ? queueLag.ok : null,
    softWarning,
    softWarningCode,
    queueLagSec: finiteNonNegative(queueLag.effectiveLagSec ?? systemMode.queueLagSec),
    // FLAG: Raw age and proved execution waits are separate observations. Missing
    // operational evidence must not become zero or inherit a different signal.
    operationalLagSec: finiteNonNegative(queueLag.operationalLagSec),
    readinessWaitingCount:
      Number.isSafeInteger(queueLag.readinessWaitingCount) && queueLag.readinessWaitingCount >= 0
        ? queueLag.readinessWaitingCount
        : null,
    readinessHeadLimitReached:
      typeof queueLag.readinessHeadLimitReached === 'boolean'
        ? queueLag.readinessHeadLimitReached
        : null,
    quarantinedCountLowerBound:
      Number.isSafeInteger(queueLag.quarantinedCountLowerBound) &&
      queueLag.quarantinedCountLowerBound >= 0 &&
      queueLag.quarantinedCountLowerBound <= 65
        ? queueLag.quarantinedCountLowerBound
        : null,
    quarantineSampleLimitReached:
      typeof queueLag.quarantineSampleLimitReached === 'boolean'
        ? queueLag.quarantineSampleLimitReached
        : null,
    oldestQuarantinedAgeSec: finiteNonNegative(queueLag.oldestQuarantinedAgeSec),
    mode:
      systemMode.mode === 'normal' || systemMode.mode === 'degrade' ? systemMode.mode : 'unknown',
    condition:
      typeof systemMode.condition === 'string' &&
      ['healthy', 'queue_backlog', 'max_api', 'mixed', 'stabilizing', 'manual', 'unknown'].includes(
        systemMode.condition,
      )
        ? systemMode.condition
        : 'unknown',
    burstActive: typeof burst.active === 'boolean' ? burst.active : null,
    action: normalizeActionHealth(systemMode.action),
  };
}

function normalizeQueueFence(raw) {
  if (!isRecord(raw)) throw new Error('Webhook queue status is invalid.');
  const integerFields = ['queueCount', 'pausedCount', 'activeCount'];
  if (integerFields.some((field) => !Number.isSafeInteger(raw[field]) || raw[field] < 0)) {
    throw new Error('Webhook queue status counters are invalid.');
  }
  if (typeof raw.ownerPresent !== 'boolean') {
    throw new Error('Webhook queue ownership status is invalid.');
  }
  return {
    available: true,
    queueCount: raw.queueCount,
    pausedCount: raw.pausedCount,
    activeCount: raw.activeCount,
    ownerPresent: raw.ownerPresent,
  };
}

function runBounded(command, args, options = {}) {
  return new Promise((resolve) => {
    if (options.signal?.aborted) return resolve({ ok: false, output: '' });
    let output = '';
    let outputBytes = 0;
    let settled = false;
    let refused = false;
    const child = spawn(command, args, {
      cwd: options.cwd ?? process.cwd(),
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      options.signal?.removeEventListener('abort', abort);
      resolve(result);
    };
    const abort = () => {
      refused = true;
      child.kill('SIGKILL');
    };
    const timeout = setTimeout(() => {
      abort();
    }, options.timeoutMs ?? PROCESS_TIMEOUT_MS);
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();
    child.once('error', () => {
      if (child.pid === undefined) finish({ ok: false, output: '' });
      else abort();
    });
    child.stdin.on('error', () => undefined);
    child.stdout.on('data', (chunk) => {
      outputBytes += chunk.byteLength;
      if (outputBytes > (options.maxOutputBytes ?? MAX_PROCESS_OUTPUT_BYTES)) {
        abort();
        return;
      }
      output += chunk.toString('utf8');
    });
    // FLAG: Cancellation resolves only after the exact child has closed and is reaped.
    child.once('close', (code) =>
      finish({ ok: !refused && code === 0, output: refused ? '' : output }),
    );
    child.stdin.end(options.input ?? '');
  });
}

async function probeQueueFence(options = {}) {
  let helper;
  try {
    helper = readFileSync(QUEUE_CONTROL_HELPER, 'utf8');
  } catch {
    return { available: false };
  }
  const result = await runBounded(
    'docker',
    [
      'compose',
      '--env-file',
      '.env',
      '-p',
      'infra',
      '-f',
      'infra/docker-compose.yml',
      'exec',
      '-T',
      'api-admin',
      'node',
      '-',
      'status',
    ],
    { input: helper, signal: options.signal },
  );
  if (!result.ok) return { available: false };
  try {
    return normalizeQueueFence(JSON.parse(result.output));
  } catch {
    return { available: false };
  }
}

function normalizeExpectedApiServices(values) {
  const requiredServices = DEFAULT_EXPECTED_API_SERVICES.filter(
    (service) => !HISTORICALLY_OPTIONAL_API_SERVICES.has(service),
  );
  if (
    !Array.isArray(values) ||
    values.length < requiredServices.length ||
    values.length > DEFAULT_EXPECTED_API_SERVICES.length ||
    new Set(values).size !== values.length ||
    values.some(
      (value) => typeof value !== 'string' || !DEFAULT_EXPECTED_API_SERVICES.includes(value),
    ) ||
    requiredServices.some((service) => !values.includes(service))
  ) {
    throw new Error('Expected API service topology is invalid.');
  }
  return [...values];
}

function isSupportedApiImageRef(imageRef, sourceSha) {
  return (
    typeof imageRef === 'string' &&
    SAFE_IMAGE_REF_PATTERN.test(imageRef) &&
    (DIGEST_IMAGE_REF_PATTERN.test(imageRef) ||
      imageRef.endsWith(`:${sourceSha}`) ||
      imageRef.endsWith(`:runtime-rollback-${sourceSha}`))
  );
}

function readExpectedApiImage(path = RELEASE_MANIFEST_PATH) {
  const stats = lstatSync(path);
  if (
    !stats.isFile() ||
    stats.isSymbolicLink() ||
    stats.size <= 0 ||
    stats.size > MAX_RELEASE_MANIFEST_BYTES
  ) {
    throw new Error('Current release manifest is unavailable or unsafe.');
  }
  const manifest = JSON.parse(readFileSync(path, 'utf8'));
  const componentEntries = isRecord(manifest?.components)
    ? Object.entries(manifest.components)
    : [];
  if (
    manifest?.schemaVersion !== 1 ||
    !RELEASE_ID_PATTERN.test(manifest?.releaseId ?? '') ||
    !FULL_SHA_PATTERN.test(manifest?.targetSha ?? '') ||
    componentEntries.length < REQUIRED_RELEASE_COMPONENTS.length ||
    componentEntries.length > SUPPORTED_RELEASE_COMPONENTS.size ||
    componentEntries.some(
      ([id, component]) =>
        !SUPPORTED_RELEASE_COMPONENTS.has(id) ||
        !isRecord(component) ||
        typeof component.sourceSha !== 'string' ||
        !FULL_SHA_PATTERN.test(component.sourceSha ?? '') ||
        typeof component.imageRef !== 'string' ||
        !SAFE_IMAGE_REF_PATTERN.test(component.imageRef ?? '') ||
        typeof component.imageId !== 'string' ||
        !IMAGE_ID_PATTERN.test(component.imageId ?? ''),
    ) ||
    REQUIRED_RELEASE_COMPONENTS.some((id) => !Object.hasOwn(manifest.components, id))
  ) {
    throw new Error('Current release manifest is incomplete or invalid.');
  }
  const component = manifest?.components?.['api-shared'];
  const sourceSha = component?.sourceSha;
  const imageRef = component?.imageRef;
  const imageId = component?.imageId;
  if (
    typeof sourceSha !== 'string' ||
    !FULL_SHA_PATTERN.test(sourceSha) ||
    !isSupportedApiImageRef(imageRef, sourceSha) ||
    typeof imageId !== 'string' ||
    !IMAGE_ID_PATTERN.test(imageId)
  ) {
    throw new Error('Current release API image identity is invalid.');
  }
  return { imageId, imageRef, sourceSha };
}

function resolveExpectedApiTopologyFromCompose(expectedServices, composeSource) {
  const expected = normalizeExpectedApiServices(expectedServices);
  if (
    typeof composeSource !== 'string' ||
    Buffer.byteLength(composeSource) > MAX_PROCESS_OUTPUT_BYTES
  ) {
    throw new Error('API source Compose topology is unavailable or oversized.');
  }
  const serviceCounts = new Map();
  let inServices = false;
  let servicesSectionCount = 0;
  for (const line of composeSource.split(/\r?\n/u)) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    if (/^services:\s*$/u.test(line)) {
      servicesSectionCount += 1;
      inServices = true;
      continue;
    }
    if (/^\S/u.test(line)) {
      inServices = false;
      continue;
    }
    if (!inServices) continue;
    const match = /^ {2}([a-z0-9]+(?:-[a-z0-9]+)*):\s*$/u.exec(line);
    if (!match) continue;
    serviceCounts.set(match[1], (serviceCounts.get(match[1]) ?? 0) + 1);
  }
  if (servicesSectionCount !== 1) {
    throw new Error('API source Compose services section is missing or ambiguous.');
  }
  const present = [];
  for (const service of expected) {
    const matches = serviceCounts.get(service) ?? 0;
    if (matches > 1) throw new Error('API source Compose topology is ambiguous.');
    if (matches === 1) {
      present.push(service);
    } else if (!HISTORICALLY_OPTIONAL_API_SERVICES.has(service)) {
      throw new Error('API source Compose topology is missing a required role.');
    }
  }
  const auxiliaryCount = serviceCounts.get(OCR_NATIVE_SANDBOX_SERVICE) ?? 0;
  if (auxiliaryCount > 1) {
    throw new Error('API source Compose auxiliary topology is ambiguous.');
  }
  if (auxiliaryCount === 1 && !present.includes('api-media-analysis')) {
    throw new Error('API source Compose auxiliary topology is missing its media role.');
  }
  const photoCount = serviceCounts.get(PHOTO_NATIVE_SANDBOX_SERVICE) ?? 0;
  if (photoCount > 1 || (photoCount === 1 && !present.includes('api-moderation-background'))) {
    throw new Error(
      'API source Compose photo auxiliary topology is ambiguous or missing its consumer.',
    );
  }
  return {
    services: normalizeExpectedApiServices(present),
    expectedAuxiliaryService:
      [
        auxiliaryCount === 1 ? OCR_NATIVE_SANDBOX_SERVICE : null,
        photoCount === 1 ? PHOTO_NATIVE_SANDBOX_SERVICE : null,
      ]
        .filter(Boolean)
        .join(',') || null,
  };
}

function resolveExpectedApiServicesFromCompose(expectedServices, composeSource) {
  return resolveExpectedApiTopologyFromCompose(expectedServices, composeSource).services;
}

function readOptionalDockerToken(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || !DOCKER_TOKEN_PATTERN.test(value)) {
    throw new Error('Docker returned an invalid label token.');
  }
  return value;
}

function parseApiIdentityEnvironment(raw) {
  if (!Array.isArray(raw)) {
    return {
      appRole: null,
      appServiceName: null,
      commercialOcrVersionPresent: false,
      identityInvalid: true,
    };
  }
  const selected = new Map();
  let identityInvalid = false;
  for (const entry of raw) {
    if (typeof entry !== 'string') continue;
    const separator = entry.indexOf('=');
    if (separator < 1) continue;
    const key = entry.slice(0, separator);
    if (!['APP_ROLE', 'APP_SERVICE_NAME', 'COMMERCIAL_OCR_VERSION'].includes(key)) continue;
    if (selected.has(key)) identityInvalid = true;
    selected.set(key, entry.slice(separator + 1));
  }
  const appRoleRaw = selected.get('APP_ROLE');
  const appServiceNameRaw = selected.get('APP_SERVICE_NAME');
  const appRole = typeof appRoleRaw === 'string' && API_ROLES.has(appRoleRaw) ? appRoleRaw : null;
  const appServiceName =
    typeof appServiceNameRaw === 'string' && DOCKER_TOKEN_PATTERN.test(appServiceNameRaw)
      ? appServiceNameRaw
      : null;
  if (
    (selected.has('APP_ROLE') && appRole === null) ||
    (selected.has('APP_SERVICE_NAME') && appServiceName === null)
  ) {
    identityInvalid = true;
  }
  return {
    appRole,
    appServiceName,
    commercialOcrVersionPresent: Boolean(selected.get('COMMERCIAL_OCR_VERSION')),
    identityInvalid,
  };
}

function isExactOcrNativeSandboxEnvironment(value) {
  if (!Array.isArray(value)) return false;
  const environment = new Map();
  for (const entry of value) {
    if (typeof entry !== 'string') return false;
    const separator = entry.indexOf('=');
    if (separator < 1) return false;
    const key = entry.slice(0, separator);
    if (environment.has(key)) return false;
    if (
      !Object.hasOwn(OCR_NATIVE_SANDBOX_REQUIRED_ENV, key) &&
      !OCR_NATIVE_SANDBOX_ALLOWED_IMAGE_ENV.has(key)
    ) {
      return false;
    }
    environment.set(key, entry.slice(separator + 1));
  }
  return Object.entries(OCR_NATIVE_SANDBOX_REQUIRED_ENV).every(
    ([key, expectedValue]) => environment.get(key) === expectedValue,
  );
}

function hasExactStringArray(value, expected) {
  return (
    Array.isArray(value) &&
    value.length === expected.length &&
    value.every((entry, index) => entry === expected[index])
  );
}

function hasExactSandboxTmpfs(value) {
  if (!isRecord(value)) return false;
  const entries = Object.entries(value);
  if (entries.length !== 1 || entries[0][0] !== '/tmp' || typeof entries[0][1] !== 'string') {
    return false;
  }
  const options = new Map();
  const flags = new Set();
  for (const option of entries[0][1].split(',')) {
    const separator = option.indexOf('=');
    if (separator < 1) {
      if (option !== 'rw' || flags.has(option)) return false;
      flags.add(option);
      continue;
    }
    const key = option.slice(0, separator);
    if (options.has(key)) return false;
    options.set(key, option.slice(separator + 1));
  }
  return (
    options.size === 4 &&
    flags.size <= 1 &&
    ['64m', '64M', String(64 * 1024 * 1024)].includes(options.get('size')) &&
    options.get('mode') === '1777' &&
    options.get('uid') === '1000' &&
    options.get('gid') === '1000'
  );
}

function hasExactSandboxMount(value, expectedProject) {
  if (!Array.isArray(value) || value.length !== 1) return false;
  const mount = value[0];
  return (
    isRecord(mount) &&
    mount.Type === 'volume' &&
    mount.Name === `${expectedProject}_ocr_native_ipc` &&
    mount.Destination === '/run/maxim-ocr' &&
    mount.RW === true &&
    mount.Mode === 'rw'
  );
}

function parseApiFleetInspection(raw) {
  // FLAG: Docker inspection contains secret-bearing env; retain only fixed identity signals in memory.
  if (typeof raw !== 'string' || Buffer.byteLength(raw) === 0) return [];
  if (Buffer.byteLength(raw) > MAX_DOCKER_INSPECT_BYTES) {
    throw new Error('Docker API fleet inspection is oversized.');
  }
  const inspection = JSON.parse(raw);
  if (!Array.isArray(inspection) || inspection.length > MAX_DOCKER_CONTAINER_COUNT) {
    throw new Error('Docker returned an invalid API fleet inspection.');
  }
  return inspection.map((container) => {
    const config = isRecord(container?.Config) ? container.Config : {};
    const labels = isRecord(config.Labels) ? config.Labels : {};
    const state = isRecord(container?.State) ? container.State : {};
    const id = container?.Id;
    const imageId = container?.Image;
    const imageRef = config.Image;
    const name = container?.Name;
    const restartCount = container?.RestartCount;
    const identity = parseApiIdentityEnvironment(config.Env);
    const healthStatus = isRecord(state.Health) ? state.Health.Status : null;
    if (
      typeof id !== 'string' ||
      !/^[0-9a-f]{64}$/u.test(id) ||
      typeof imageId !== 'string' ||
      !IMAGE_ID_PATTERN.test(imageId) ||
      typeof imageRef !== 'string' ||
      !SAFE_IMAGE_REF_PATTERN.test(imageRef) ||
      typeof name !== 'string' ||
      !/^\/[a-zA-Z0-9][a-zA-Z0-9_.-]{0,255}$/u.test(name) ||
      typeof state.Running !== 'boolean' ||
      typeof state.Status !== 'string' ||
      !DOCKER_STATUS_PATTERN.test(state.Status) ||
      !Number.isSafeInteger(restartCount) ||
      restartCount < 0
    ) {
      throw new Error('Docker returned invalid API fleet metadata.');
    }
    if (
      healthStatus !== null &&
      !['starting', 'healthy', 'unhealthy', 'none'].includes(healthStatus)
    ) {
      throw new Error('Docker returned invalid API fleet health metadata.');
    }
    const project = readOptionalDockerToken(labels['com.docker.compose.project']);
    return {
      id,
      project,
      service: readOptionalDockerToken(labels['com.docker.compose.service']),
      name,
      imageId,
      imageRef,
      running: state.Running,
      status: state.Status,
      restartCount,
      releaseProtected: labels['com.maxim.release-protected'] === 'true',
      ocrNativeSandbox: labels['com.maxim.ocr-native-sandbox'] === 'true',
      photoNativeSandbox: labels['com.maxim.photo-native-sandbox'] === 'true',
      photoSandboxCommandExact: hasExactStringArray(config.Cmd, [
        'node',
        'apps/api/dist/apps/api/src/moderation/photo-duplicate/native-photo-sandbox.entrypoint.js',
      ]),
      photoSandboxRuntimeReviewed: Boolean(
        photoBoundary?.isReviewedPhotoNativeSandboxRuntime(container, 'infra'),
      ),

      ocrNativeSandboxCapable: labels['com.maxim.ocr-native-sandbox-capable'] === 'true',
      healthStatus,
      sandboxCommandExact: hasExactStringArray(config.Cmd, OCR_NATIVE_SANDBOX_COMMAND),
      sandboxEnvironmentExact: isExactOcrNativeSandboxEnvironment(config.Env),
      sandboxUserExact: config.User === '1000:1000',
      sandboxNetworkNone: container?.HostConfig?.NetworkMode === 'none',
      sandboxReadOnly: container?.HostConfig?.ReadonlyRootfs === true,
      sandboxInit: container?.HostConfig?.Init === true,
      sandboxLimitsExact:
        container?.HostConfig?.Memory === 1024 ** 3 &&
        container?.HostConfig?.NanoCpus === 1_000_000_000 &&
        container?.HostConfig?.PidsLimit === 128,
      sandboxCapDropAll: hasExactStringArray(container?.HostConfig?.CapDrop, ['ALL']),
      sandboxNoNewPrivileges: hasExactStringArray(container?.HostConfig?.SecurityOpt, [
        'no-new-privileges:true',
      ]),
      sandboxTmpfsExact: hasExactSandboxTmpfs(container?.HostConfig?.Tmpfs),
      sandboxMainMountExact: hasExactSandboxMount(container?.Mounts, 'infra'),
      sandboxScaleMountExact: hasExactSandboxMount(container?.Mounts, 'infra-scale'),
      ...identity,
    };
  });
}

function isApiLikeService(value) {
  return typeof value === 'string' && /^api(?:-|$)/u.test(value);
}

function isApiLikeContainerName(value) {
  return typeof value === 'string' && /(?:^|[-_])api(?:[-_]|$)/u.test(value.slice(1));
}

function isExpectedComposeServiceContainerName(value, service) {
  const match = /^\/infra([-_])([a-z0-9][a-z0-9-]*)([-_])([1-9]\d*)$/u.exec(value);
  return Boolean(match && match[1] === match[3] && match[2] === service);
}

function isExpectedProjectApiContainerName(value) {
  if (typeof value !== 'string') return false;
  return ['api', ...DEFAULT_EXPECTED_API_SERVICES].some((service) =>
    isExpectedComposeServiceContainerName(value, service),
  );
}

function isOcrNativeSandboxCandidate(container) {
  return (
    container.ocrNativeSandbox === true ||
    container.service === OCR_NATIVE_SANDBOX_SERVICE ||
    isExpectedComposeServiceContainerName(container.name, OCR_NATIVE_SANDBOX_SERVICE) ||
    /^\/infra-scale(?:-|_)ocr-native-sandbox(?:-|_)[1-9]\d*$/u.test(container.name) ||
    container.sandboxCommandExact === true
  );
}

function isPhotoNativeSandboxCandidate(container) {
  return (
    container.photoNativeSandbox === true ||
    container.service === PHOTO_NATIVE_SANDBOX_SERVICE ||
    /^\/infra(?:-scale)?(?:-|_)photo-native-sandbox(?:-|_)[1-9]\d*$/u.test(container.name) ||
    container.photoSandboxCommandExact === true
  );
}

function isReviewedOcrNativeSandbox(container, expectedImage, expectedProject) {
  return (
    container.project === expectedProject &&
    container.service === OCR_NATIVE_SANDBOX_SERVICE &&
    isExpectedComposeServiceContainerName(container.name, OCR_NATIVE_SANDBOX_SERVICE) &&
    container.running === true &&
    container.status === 'running' &&
    container.healthStatus === 'healthy' &&
    container.imageId === expectedImage.imageId &&
    container.imageRef === expectedImage.imageRef &&
    container.releaseProtected === true &&
    container.ocrNativeSandbox === true &&
    container.photoNativeSandbox !== true &&
    container.ocrNativeSandboxCapable === true &&
    container.identityInvalid === false &&
    container.appRole === null &&
    container.appServiceName === null &&
    container.commercialOcrVersionPresent === false &&
    container.sandboxCommandExact === true &&
    container.sandboxEnvironmentExact === true &&
    container.sandboxUserExact === true &&
    container.sandboxNetworkNone === true &&
    container.sandboxReadOnly === true &&
    container.sandboxInit === true &&
    container.sandboxLimitsExact === true &&
    container.sandboxCapDropAll === true &&
    container.sandboxNoNewPrivileges === true &&
    container.sandboxTmpfsExact === true &&
    container.sandboxMainMountExact === true
  );
}

function isApiFleetCandidate(container, expectedImage) {
  const apiLikeService = isApiLikeService(container.service);
  const apiLikeAppService = isApiLikeService(container.appServiceName);
  const apiLikeName = isApiLikeContainerName(container.name);
  const appRoleSignal = API_ROLES.has(container.appRole);
  const expectedServiceSignal = DEFAULT_EXPECTED_API_SERVICES.includes(container.service);
  const expectedAppServiceSignal = DEFAULT_EXPECTED_API_SERVICES.includes(container.appServiceName);
  const imageMatches = container.imageId === expectedImage.imageId;
  const maximImageRef = /(?:^|\/)maxim-api(?::|@)/u.test(container.imageRef);
  const ownedName = isExpectedProjectApiContainerName(container.name);
  const protectedApiSignal =
    container.releaseProtected &&
    (apiLikeService ||
      apiLikeAppService ||
      apiLikeName ||
      appRoleSignal ||
      expectedServiceSignal ||
      expectedAppServiceSignal ||
      imageMatches ||
      maximImageRef ||
      ownedName);
  const maximSpecificSignal =
    expectedServiceSignal ||
    expectedAppServiceSignal ||
    container.commercialOcrVersionPresent ||
    protectedApiSignal ||
    imageMatches ||
    maximImageRef ||
    ownedName;
  return (
    (['infra', 'infra-scale'].includes(container.project) &&
      (apiLikeService || appRoleSignal || maximSpecificSignal)) ||
    maximSpecificSignal ||
    (apiLikeService && appRoleSignal)
  );
}

function validRestartEntries(entries, name) {
  return (
    Array.isArray(entries) &&
    entries.length <= (name === 'api' ? 14 : 1) &&
    entries.every(
      (entry) =>
        isRecord(entry) &&
        typeof entry.key === 'string' &&
        /^[0-9a-f]{64}$/u.test(entry.id) &&
        Number.isSafeInteger(entry.count) &&
        entry.count >= 0,
    ) &&
    new Set(entries.map((entry) => entry.key)).size === entries.length &&
    new Set(entries.map((entry) => entry.id)).size === entries.length &&
    Number.isSafeInteger(entries.reduce((sum, entry) => sum + entry.count, 0))
  );
}

function createRestartTracker() {
  let previous = null;
  let previousAt = null;
  let previousClock = null;
  return {
    observe(classes, observedAt, clock = performance.now()) {
      const at = Date.parse(observedAt);
      const priorAt = previousAt === null ? NaN : Date.parse(previousAt);
      const ordered = Number.isFinite(priorAt) && at > priorAt;
      const continuous =
        ordered &&
        at - priorAt <= RESTART_SAMPLE_GAP_MS &&
        clock > previousClock &&
        clock - previousClock <= RESTART_SAMPLE_GAP_MS;
      const result = {
        version: 1,
        basis: 'container_generation_intervals',
        previousObservedAt: ordered ? previousAt : null,
        observedAt,
      };
      const next = {};
      for (const name of ['api', 'ocr', 'photo']) {
        const entries = classes?.[name];
        const valid = validRestartEntries(entries, name);
        const current = valid
          ? new Map(entries.map((entry) => [entry.key, { id: entry.id, count: entry.count }]))
          : null;
        const total = valid ? entries.reduce((sum, entry) => sum + entry.count, 0) : null;
        const before = previous?.[name];
        let generationChanged = null;
        let delta = null;
        if (current && before && ordered) {
          generationChanged =
            current.size !== before.size ||
            [...current].some(([key, entry]) => before.get(key)?.id !== entry.id);
          if (
            continuous &&
            !generationChanged &&
            [...current].every(([key, entry]) => entry.count >= before.get(key).count)
          ) {
            delta = [...current].reduce(
              (sum, [key, entry]) => sum + entry.count - before.get(key).count,
              0,
            );
          }
        }
        result[name] = {
          total: Number.isSafeInteger(total) ? total : null,
          delta: Number.isSafeInteger(delta) ? delta : null,
          generationChanged,
        };
        next[name] = current;
      }
      // FLAG: Only these <=14+2 exact identities survive in remote RAM. Never serialize the map.
      previous = next;
      previousAt = observedAt;
      previousClock = clock;
      return result;
    },
  };
}

function restartEvidence(classes, options = {}) {
  const observedAt = options.observedAt ?? new Date().toISOString();
  if (options.restartTracker)
    return options.restartTracker.observe(classes, observedAt, options.clock);
  const result = {
    version: 1,
    basis: 'historical_container_totals',
    previousObservedAt: null,
    observedAt,
  };
  for (const name of ['api', 'ocr', 'photo']) {
    const total = validRestartEntries(classes[name], name)
      ? classes[name].reduce((sum, entry) => sum + entry.count, 0)
      : null;
    result[name] = {
      total: Number.isSafeInteger(total) ? total : null,
      delta: null,
      generationChanged: null,
    };
  }
  return result;
}

function summarizeApiFleet(
  expectedServices,
  expectedImage,
  containers,
  expectedAuxiliaryService = null,
  options = null,
) {
  const expected = normalizeExpectedApiServices(expectedServices);
  if (
    !isRecord(expectedImage) ||
    typeof expectedImage.sourceSha !== 'string' ||
    !FULL_SHA_PATTERN.test(expectedImage.sourceSha) ||
    !isSupportedApiImageRef(expectedImage.imageRef, expectedImage.sourceSha) ||
    !IMAGE_ID_PATTERN.test(expectedImage.imageId ?? '')
  ) {
    throw new Error('Expected API image is invalid.');
  }
  const expectedAuxiliaries = new Set(expectedAuxiliaryService?.split(',') ?? []);
  if (
    expectedAuxiliaries.size !== (expectedAuxiliaryService?.split(',').length ?? 0) ||
    [...expectedAuxiliaries].some(
      (service) => ![OCR_NATIVE_SANDBOX_SERVICE, PHOTO_NATIVE_SANDBOX_SERVICE].includes(service),
    )
  ) {
    throw new Error('Expected API auxiliary topology is invalid.');
  }
  const expectedSet = new Set(expected);
  const byService = new Map(expected.map((service) => [service, []]));
  const auxiliaryContainers = [];
  const photoAuxiliaryContainers = [];
  let unexpectedApiContainerCount = 0;
  let unexpectedMainContainerCount = 0;
  let unexpectedScaleContainerCount = 0;
  let unexpectedManualContainerCount = 0;
  for (const container of containers) {
    if (
      !isRecord(container) ||
      (container.project !== null && typeof container.project !== 'string') ||
      (container.service !== null && typeof container.service !== 'string')
    ) {
      throw new Error('API fleet container metadata is invalid.');
    }
    if (isOcrNativeSandboxCandidate(container)) {
      auxiliaryContainers.push(container);
    } else if (isPhotoNativeSandboxCandidate(container)) {
      photoAuxiliaryContainers.push(container);
    } else if (container.project === 'infra' && expectedSet.has(container.service)) {
      byService.get(container.service).push(container);
    } else if (isApiFleetCandidate(container, expectedImage)) {
      unexpectedApiContainerCount += 1;
      if (container.project === 'infra') {
        unexpectedMainContainerCount += 1;
      } else if (container.project === 'infra-scale') {
        unexpectedScaleContainerCount += 1;
      } else {
        unexpectedManualContainerCount += 1;
      }
    }
  }

  const unexpectedOrdinaryApiContainerCount = unexpectedApiContainerCount;
  let acceptedAuxiliaryRestartCount = 0;
  let ocrEntries = expectedAuxiliaries.has(OCR_NATIVE_SANDBOX_SERVICE) ? null : [];
  let photoEntries = expectedAuxiliaries.has(PHOTO_NATIVE_SANDBOX_SERVICE) ? null : [];
  if (
    expectedAuxiliaries.has(OCR_NATIVE_SANDBOX_SERVICE) &&
    auxiliaryContainers.length === 1 &&
    isReviewedOcrNativeSandbox(auxiliaryContainers[0], expectedImage, 'infra')
  ) {
    acceptedAuxiliaryRestartCount = auxiliaryContainers[0].restartCount;
    ocrEntries = [
      { key: 'ocr', id: auxiliaryContainers[0].id, count: auxiliaryContainers[0].restartCount },
    ];
  } else if (
    auxiliaryContainers.length === 0 &&
    expectedAuxiliaries.has(OCR_NATIVE_SANDBOX_SERVICE)
  ) {
    unexpectedApiContainerCount += 1;
    unexpectedMainContainerCount += 1;
  } else {
    if (auxiliaryContainers.length) ocrEntries = null;
    for (const container of auxiliaryContainers) {
      unexpectedApiContainerCount += 1;
      if (container.project === 'infra') {
        unexpectedMainContainerCount += 1;
      } else if (container.project === 'infra-scale') {
        unexpectedScaleContainerCount += 1;
      } else {
        unexpectedManualContainerCount += 1;
      }
    }
  }

  if (
    expectedAuxiliaries.has(PHOTO_NATIVE_SANDBOX_SERVICE) &&
    photoAuxiliaryContainers.length === 1 &&
    photoAuxiliaryContainers[0].photoSandboxRuntimeReviewed === true &&
    photoAuxiliaryContainers[0].imageId === expectedImage.imageId &&
    photoAuxiliaryContainers[0].imageRef === expectedImage.imageRef &&
    isExpectedComposeServiceContainerName(
      photoAuxiliaryContainers[0].name,
      PHOTO_NATIVE_SANDBOX_SERVICE,
    )
  ) {
    acceptedAuxiliaryRestartCount += photoAuxiliaryContainers[0].restartCount;
    photoEntries = [
      {
        key: 'photo',
        id: photoAuxiliaryContainers[0].id,
        count: photoAuxiliaryContainers[0].restartCount,
      },
    ];
  } else if (
    photoAuxiliaryContainers.length === 0 &&
    expectedAuxiliaries.has(PHOTO_NATIVE_SANDBOX_SERVICE)
  ) {
    unexpectedApiContainerCount += 1;
    unexpectedMainContainerCount += 1;
  } else {
    if (photoAuxiliaryContainers.length) photoEntries = null;
    for (const container of photoAuxiliaryContainers) {
      unexpectedApiContainerCount += 1;
      if (container.project === 'infra') unexpectedMainContainerCount += 1;
      else if (container.project === 'infra-scale') unexpectedScaleContainerCount += 1;
      else unexpectedManualContainerCount += 1;
    }
  }

  let observedRoleCount = 0;
  let singletonRoleCount = 0;
  let runningRoleCount = 0;
  let identityRoleCount = 0;
  let exactImageRoleCount = 0;
  let duplicateContainerCount = 0;
  let totalRestartCount = acceptedAuxiliaryRestartCount;
  const apiEntries = [];
  for (const service of expected) {
    const matches = byService.get(service);
    if (matches.length > 0) observedRoleCount += 1;
    duplicateContainerCount += Math.max(0, matches.length - 1);
    totalRestartCount += matches.reduce((sum, container) => sum + container.restartCount, 0);
    if (matches.length !== 1) continue;
    singletonRoleCount += 1;
    const container = matches[0];
    if (container.running === true && container.status === 'running') runningRoleCount += 1;
    if (
      container.identityInvalid === false &&
      container.appServiceName === service &&
      container.appRole === EXPECTED_APP_ROLE_BY_SERVICE[service] &&
      container.releaseProtected === true &&
      isExpectedComposeServiceContainerName(container.name, service)
    ) {
      identityRoleCount += 1;
    }
    if (
      container.imageId === expectedImage.imageId &&
      container.imageRef === expectedImage.imageRef
    ) {
      exactImageRoleCount += 1;
    }
    if (
      container.identityInvalid === false &&
      container.appServiceName === service &&
      container.appRole === EXPECTED_APP_ROLE_BY_SERVICE[service] &&
      container.releaseProtected === true &&
      isExpectedComposeServiceContainerName(container.name, service) &&
      container.imageId === expectedImage.imageId &&
      container.imageRef === expectedImage.imageRef
    ) {
      apiEntries.push({ key: service, id: container.id, count: container.restartCount });
    }
  }

  return {
    available: true,
    expectedRoleCount: expected.length,
    observedRoleCount,
    singletonRoleCount,
    runningRoleCount,
    identityRoleCount,
    exactImageRoleCount,
    duplicateContainerCount,
    unexpectedApiContainerCount,
    unexpectedMainContainerCount,
    unexpectedScaleContainerCount,
    unexpectedManualContainerCount,
    totalRestartCount,
    ...(options
      ? {
          restartEvidence: restartEvidence(
            {
              api:
                apiEntries.length === expected.length && unexpectedOrdinaryApiContainerCount === 0
                  ? apiEntries
                  : null,
              ocr: ocrEntries,
              photo: photoEntries,
            },
            options,
          ),
        }
      : {}),
  };
}

async function probeApiFleet(expectedServices, options = {}) {
  const unavailable = () => ({
    available: false,
    restartEvidence: restartEvidence({ api: null, ocr: null, photo: null }, options),
  });
  try {
    const currentExpected = normalizeExpectedApiServices(expectedServices);
    const expectedImage = options.expectedImage ?? readExpectedApiImage(options.manifestPath);
    const baseRun = options.runBounded ?? runBounded;
    const run = (command, args, settings = {}) =>
      baseRun(command, args, { ...settings, signal: options.signal });
    const sourceCompose = await run('git', [
      'show',
      `${expectedImage.sourceSha}:infra/docker-compose.yml`,
    ]);
    if (!sourceCompose.ok) return unavailable();
    const topology = resolveExpectedApiTopologyFromCompose(currentExpected, sourceCompose.output);
    const expected = topology.services;
    const list = await run('docker', ['ps', '-a', '--no-trunc', '--format', '{{.ID}}']);
    if (!list.ok) return unavailable();
    const ids = list.output.trim() ? list.output.trim().split(/\s+/u) : [];
    if (
      ids.length > MAX_DOCKER_CONTAINER_COUNT ||
      new Set(ids).size !== ids.length ||
      ids.some((id) => !/^[0-9a-f]{64}$/u.test(id))
    ) {
      return unavailable();
    }
    if (ids.length === 0) {
      return summarizeApiFleet(
        expected,
        expectedImage,
        [],
        topology.expectedAuxiliaryService,
        options,
      );
    }
    const inspection = await run('docker', ['inspect', ...ids], {
      maxOutputBytes: MAX_DOCKER_INSPECT_BYTES,
    });
    if (!inspection.ok) return unavailable();
    const containers = parseApiFleetInspection(inspection.output);
    const inspectedIds = containers.map((container) => container.id);
    if (
      inspectedIds.length !== ids.length ||
      new Set(inspectedIds).size !== inspectedIds.length ||
      inspectedIds.some((id) => !ids.includes(id))
    ) {
      return unavailable();
    }
    return summarizeApiFleet(
      expected,
      expectedImage,
      containers,
      topology.expectedAuxiliaryService,
      options,
    );
  } catch {
    return unavailable();
  }
}

function wait(ms, signal) {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
    if (signal?.aborted) done();
  });
}

function normalizeDevice(value) {
  const candidate = typeof value === 'string' && value.trim() ? value.trim() : DEFAULT_BLOCK_DEVICE;
  if (!/^[A-Za-z0-9._-]{1,64}$/u.test(candidate)) {
    throw new Error('Capacity block device is invalid.');
  }
  return candidate;
}

async function collectCapacitySnapshot(options = {}) {
  const device = normalizeDevice(options.device);
  const expectedApiServices = normalizeExpectedApiServices(
    options.expectedApiServices ?? DEFAULT_EXPECTED_API_SERVICES,
  );
  const sampleMs = options.sampleMs ?? DEFAULT_SAMPLE_MS;
  if (!Number.isSafeInteger(sampleMs) || sampleMs < 250 || sampleMs > 5_000) {
    throw new Error('Capacity sample duration must be between 250 and 5000 milliseconds.');
  }
  const readCounters = options.readHostCounters ?? readHostCounters;
  const before = readCounters(device);
  const startedAt = performance.now();
  const ready = options.signal
    ? async (url) => {
        let response;
        try {
          response = await fetch(url, {
            redirect: 'error',
            signal: AbortSignal.any([options.signal, AbortSignal.timeout(15_000)]),
          });
        } catch {
          return { httpStatus: null, body: null };
        }
        try {
          return {
            httpStatus: response.status,
            body: JSON.parse(await readBoundedResponseBody(response)),
          };
        } catch {
          return { httpStatus: response.status, body: null };
        }
      }
    : probeReadyEndpoint;
  const probesPromise = Promise.allSettled([
    ready(INGRESS_READY_URL),
    ready(ADMIN_READY_URL),
    probeQueueFence(options),
    probeApiFleet(expectedApiServices, {
      restartTracker: options.restartTracker,
      signal: options.signal,
    }),
  ]);
  await wait(sampleMs, options.signal);
  let after;
  let counterError;
  try {
    after = readCounters(device);
  } catch (error) {
    counterError = error;
  }
  const elapsedMs = performance.now() - startedAt;
  // FLAG: A failed counter read or probe must not let active subprocesses escape teardown.
  const probes = await probesPromise;
  options.signal?.throwIfAborted();
  if (counterError) throw counterError;
  const [ingressProbe, adminProbe, queueFence, apiFleet] = probes.map((result) => {
    if (result.status === 'rejected') throw result.reason;
    return result.value;
  });
  const rates = calculateCounterRates(before, after, elapsedMs);
  const memory = parseMeminfo(readFileSync('/proc/meminfo', 'utf8'));
  let filesystem;
  let diskPath = options.diskPath ?? DEFAULT_DISK_PATH;
  try {
    filesystem = diskCapacity(diskPath);
  } catch {
    diskPath = '/';
    filesystem = diskCapacity(diskPath);
  }

  return {
    schemaVersion: 1,
    observedAt: apiFleet.restartEvidence.observedAt,
    host: {
      cpuCount: os.cpus().length,
      load1: finiteNonNegative(os.loadavg()[0]),
      ...memory,
      cpuIowaitPct: finiteNonNegative(rates.cpuIowaitPct),
      swapInPagesPerSec: finiteNonNegative(rates.swapInPagesPerSec),
      disk: {
        device,
        path: diskPath,
        ...filesystem,
        utilPct: finiteNonNegative(rates.diskUtilPct),
        avgQueueDepth: finiteNonNegative(rates.diskAvgQueueDepth),
      },
    },
    readiness: normalizeReadyProbe(ingressProbe, true),
    adminReadiness: normalizeReadyProbe(adminProbe, false),
    queueFence,
    apiFleet,
  };
}

async function runCapacityStream(options = {}) {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const collect = options.collect ?? collectCapacitySnapshot;
  const controller = new AbortController();
  const tracker = createRestartTracker();
  let active = null;
  let buffer = '';
  let stopped = false;
  let idle;
  let lifetime;
  let finish;
  const finished = new Promise((resolve) => {
    finish = resolve;
  });
  const stop = (code) => {
    if (stopped) return;
    stopped = true;
    controller.abort();
    clearTimeout(idle);
    clearTimeout(lifetime);
    input.pause();
    void Promise.resolve(active)
      .catch(() => undefined)
      .then(() => {
        input.removeListener('data', data);
        input.removeListener('end', ended);
        input.removeListener('error', failed);
        output.removeListener('error', failed);
        process.removeListener('SIGTERM', terminated);
        process.removeListener('SIGINT', interrupted);
        process.removeListener('SIGHUP', hungup);
        finish(code);
      });
  };
  const armIdle = () => {
    clearTimeout(idle);
    idle = setTimeout(() => stop(1), options.idleMs ?? STREAM_IDLE_MS);
  };
  const failed = () => stop(1);
  const ended = () => stop(0);
  const terminated = () => stop(143);
  const interrupted = () => stop(130);
  const hungup = () => stop(129);
  const data = (chunk) => {
    // FLAG: The protocol admits one literal request, no queued/catch-up work or raw diagnostics.
    if (stopped) return;
    if (Buffer.byteLength(chunk) > 9 - Buffer.byteLength(buffer)) return stop(1);
    buffer += chunk.toString('utf8');
    if (Buffer.byteLength(buffer) > 9 || !'SNAPSHOT\n'.startsWith(buffer)) return stop(1);
    if (buffer !== 'SNAPSHOT\n') return;
    buffer = '';
    if (active) return stop(1);
    armIdle();
    active = (async () => {
      const snapshot = await collect({
        device: options.device,
        expectedApiServices: options.expectedApiServices,
        restartTracker: tracker,
        signal: controller.signal,
      });
      if (stopped) return;
      const line = JSON.stringify(snapshot) + '\n';
      if (Buffer.byteLength(line) > MAX_PROCESS_OUTPUT_BYTES)
        throw new Error('Capacity response exceeded its bound.');
      await new Promise((resolve, reject) => {
        const aborted = () => reject(new Error('Capacity output cancelled.'));
        controller.signal.addEventListener('abort', aborted, { once: true });
        output.write(line, (error) => {
          controller.signal.removeEventListener('abort', aborted);
          if (error) reject(error);
          else resolve();
        });
      });
    })().then(
      () => {
        active = null;
      },
      () => {
        active = null;
        stop(1);
      },
    );
  };
  input.on('data', data);
  input.once('end', ended);
  input.once('error', failed);
  output.on('error', failed);
  if (options.listenSignals !== false) {
    process.once('SIGTERM', terminated);
    process.once('SIGINT', interrupted);
    process.once('SIGHUP', hungup);
  }
  armIdle();
  lifetime = setTimeout(() => stop(0), options.lifetimeMs ?? STREAM_LIFETIME_MS);
  return finished;
}

module.exports = {
  DEFAULT_BLOCK_DEVICE,
  DEFAULT_DISK_PATH,
  DEFAULT_EXPECTED_API_SERVICES,
  calculateCounterRates,
  collectCapacitySnapshot,
  createRestartTracker,
  normalizeActionHealth,
  normalizeQueueFence,
  normalizeReadyProbe,
  parseApiFleetInspection,
  parseDiskstats,
  parseMeminfo,
  parseProcStat,
  parseVmstat,
  probeApiFleet,
  readExpectedApiImage,
  resolveExpectedApiTopologyFromCompose,
  resolveExpectedApiServicesFromCompose,
  summarizeApiFleet,
  runBounded,
  runCapacityStream,
};

if (require.main === module || __filename === '[stdin]') {
  const streaming = process.argv[2] === '--stream';
  void (async () => {
    if (streaming) {
      process.exitCode = await runCapacityStream({
        device: normalizeDevice(process.argv[3]),
        expectedApiServices: normalizeExpectedApiServices(
          process.argv.length > 4 ? process.argv.slice(4) : DEFAULT_EXPECTED_API_SERVICES,
        ),
      });
      return;
    }
    const snapshot = await collectCapacitySnapshot({
      device: process.argv[2],
      expectedApiServices:
        process.argv.length > 3 ? process.argv.slice(3) : DEFAULT_EXPECTED_API_SERVICES,
    });
    process.stdout.write(`${JSON.stringify(snapshot)}\n`);
  })().catch(() => {
    if (streaming) process.stderr.write('Capacity stream unavailable.\n');
    else {
      process.stdout.write(
        `${JSON.stringify({ schemaVersion: 1, observedAt: new Date().toISOString(), unavailable: true })}\n`,
      );
    }
    process.exitCode = 1;
  });
}
