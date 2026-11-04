import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { PassThrough, Writable } from 'node:stream';

import archiveModule from './monitor-capacity-archive.cjs';
import probeModule from './monitor-capacity-probe.cjs';
import { runtime as photoRuntime } from './test-fixtures/photo-native-fixtures.mjs';

const root = resolve(import.meta.dirname, '../..');
const archivePath = resolve(root, 'infra/scripts/monitor-capacity-archive.cjs');
const probePath = resolve(root, 'infra/scripts/monitor-capacity-probe.cjs');
const monitorPath = resolve(root, 'infra/scripts/vps-monitor-readonly.sh');
const monitorSource = readFileSync(monitorPath, 'utf8');

const {
  MAX_ARCHIVE_HOURS,
  MAX_RECORDS_PER_HOUR,
  RETENTION_DAYS,
  archiveFilename,
  archiveSnapshot,
  evaluateAlerts,
  normalizeActionHealth: normalizeArchivedActionHealth,
  normalizeApiFleet,
  normalizeSnapshot,
} = archiveModule;
const {
  DEFAULT_BLOCK_DEVICE,
  DEFAULT_EXPECTED_API_SERVICES,
  calculateCounterRates,
  collectCapacitySnapshot,
  createRestartTracker,
  normalizeActionHealth: normalizeProbedActionHealth,
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
} = probeModule;

const apiImageSha = 'b'.repeat(40);
const expectedApiImage = {
  imageId: `sha256:${'a'.repeat(64)}`,
  imageRef: `maxim-api:${apiImageSha}`,
  sourceSha: apiImageSha,
};
const productionComposeSource = readFileSync(resolve(root, 'infra/docker-compose.yml'), 'utf8');
const expectedAppRoleByService = Object.freeze({
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

function inspectedContainer(index, options = {}) {
  const service = Object.hasOwn(options, 'service')
    ? options.service
    : DEFAULT_EXPECTED_API_SERVICES[index];
  const project = Object.hasOwn(options, 'project') ? options.project : 'infra';
  const appServiceName = Object.hasOwn(options, 'appServiceName')
    ? options.appServiceName
    : service;
  const appRole = Object.hasOwn(options, 'appRole')
    ? options.appRole
    : expectedAppRoleByService[service];
  const labels = { ...(options.labels ?? {}) };
  if (project !== null) labels['com.docker.compose.project'] = project;
  if (service !== null) labels['com.docker.compose.service'] = service;
  if (options.releaseProtected !== false) labels['com.maxim.release-protected'] = 'true';
  const environment = ['PRIVATE_TOKEN=must-not-survive'];
  if (appServiceName !== null && appServiceName !== undefined) {
    environment.push(`APP_SERVICE_NAME=${appServiceName}`);
  }
  if (appRole !== null && appRole !== undefined) environment.push(`APP_ROLE=${appRole}`);
  if (options.ocrVersionPresent) environment.push('COMMERCIAL_OCR_VERSION=private-version');
  environment.push(...(options.extraEnvironment ?? []));
  const normalizedNamePart = service ?? 'manual-worker';
  return {
    Id: (index + 1).toString(16).padStart(64, '0'),
    Name: options.name ?? `/${project ?? 'manual'}-${normalizedNamePart}-1`,
    Image: options.imageId ?? expectedApiImage.imageId,
    RestartCount: options.restartCount ?? 0,
    State: {
      Running: options.running ?? true,
      Status: options.status ?? (options.running === false ? 'exited' : 'running'),
    },
    Config: {
      Env: environment,
      Image: options.imageRef ?? expectedApiImage.imageRef,
      Labels: labels,
    },
  };
}

function inspectedSandbox(index, options = {}) {
  const project = Object.hasOwn(options, 'project') ? options.project : 'infra';
  const service = options.service ?? 'ocr-native-sandbox';
  const sandboxCommand = [
    'node',
    'apps/api/dist/apps/api/src/moderation/commercial-ocr/native-ocr-sandbox.entrypoint.js',
  ];
  return {
    Id: (index + 1).toString(16).padStart(64, '0'),
    Name: options.name ?? `/${project}-${service}-1`,
    Image: options.imageId ?? expectedApiImage.imageId,
    RestartCount: options.restartCount ?? 0,
    Mounts: options.mounts ?? [
      {
        Type: 'volume',
        Name: `${project}_ocr_native_ipc`,
        Destination: '/run/maxim-ocr',
        RW: true,
        Mode: 'rw',
      },
    ],
    State: {
      Running: options.running ?? true,
      Status: options.status ?? 'running',
      Health: { Status: options.health ?? 'healthy' },
    },
    Config: {
      User: options.user ?? '1000:1000',
      Cmd: options.command ?? sandboxCommand,
      Env: options.environment ?? [
        'NODE_ENV=production',
        'COMMERCIAL_OCR_NATIVE_SANDBOX_SOCKET_PATH=/run/maxim-ocr/native-ocr.sock',
        'PHOTO_DUPLICATE_MAX_BYTES=16777216',
        'COMMERCIAL_OCR_MAX_INPUT_PIXELS=40000000',
        'COMMERCIAL_OCR_MAX_OUTPUT_PIXELS=3000000',
        'COMMERCIAL_OCR_MAX_SIDE=2000',
        'COMMERCIAL_OCR_TESSERACT_BINARY=tesseract',
        'COMMERCIAL_OCR_TESSERACT_CONCURRENCY=1',
        'COMMERCIAL_OCR_TESSERACT_MAX_QUEUE=4',
        'COMMERCIAL_OCR_TESSERACT_TIMEOUT_MS=10000',
        'COMMERCIAL_OCR_TESSERACT_RECYCLE_AFTER_JOBS=250',
        'COMMERCIAL_OCR_TESSERACT_MAX_IMAGE_BYTES=16777216',
        'COMMERCIAL_OCR_TESSERACT_MAX_OUTPUT_BYTES=4194304',
        'OMP_THREAD_LIMIT=1',
        'HOME=/home/node',
        'NODE_EXTRA_CA_CERTS=/usr/local/share/ca-certificates/russian-trusted-ca-bundle.crt',
        'NODE_VERSION=24.8.0',
        'PATH=/usr/local/bin:/usr/bin:/bin',
        'YARN_VERSION=1.22.22',
      ],
      Image: options.imageRef ?? expectedApiImage.imageRef,
      Labels: {
        'com.docker.compose.project': project,
        'com.docker.compose.service': service,
        'com.maxim.release-protected': 'true',
        'com.maxim.ocr-native-sandbox': 'true',
        'com.maxim.ocr-native-sandbox-capable': 'true',
        ...(options.labels ?? {}),
      },
    },
    HostConfig: {
      NetworkMode: 'none',
      ReadonlyRootfs: true,
      Init: true,
      Memory: 1024 ** 3,
      NanoCpus: 1_000_000_000,
      PidsLimit: 128,
      CapDrop: ['ALL'],
      SecurityOpt: ['no-new-privileges:true'],
      Tmpfs: { '/tmp': 'rw,size=67108864,mode=1777,uid=1000,gid=1000' },
      ...(options.hostConfig ?? {}),
    },
  };
}

function currentReleaseManifest(apiImage = expectedApiImage) {
  return {
    schemaVersion: 1,
    releaseId: 'release-test',
    targetSha: 'd'.repeat(40),
    components: {
      'api-shared': {
        sourceSha: apiImage.sourceSha,
        imageRef: apiImage.imageRef,
        imageId: apiImage.imageId,
      },
      'miniapp-major-static': {
        sourceSha: 'e'.repeat(40),
        imageRef: `maxim-miniapp-major:${'e'.repeat(40)}`,
        imageId: `sha256:${'e'.repeat(64)}`,
      },
      'admin-static': {
        sourceSha: 'f'.repeat(40),
        imageRef: `maxim-admin:${'f'.repeat(40)}`,
        imageId: `sha256:${'f'.repeat(64)}`,
      },
    },
  };
}

function sample(observedAt, overrides = {}) {
  const hostOverrides = overrides.host ?? {};
  return {
    schemaVersion: 1,
    observedAt,
    host: {
      cpuCount: 8,
      load1: 3,
      memoryTotalBytes: 24 * 1024 ** 3,
      memoryAvailableBytes: 12 * 1024 ** 3,
      swapTotalBytes: 4 * 1024 ** 3,
      swapUsedBytes: 0,
      cpuIowaitPct: 5,
      swapInPagesPerSec: 0,
      ...hostOverrides,
      disk: {
        device: 'vda',
        path: '/var/lib/docker',
        totalBytes: 300 * 1024 ** 3,
        availableBytes: 100 * 1024 ** 3,
        usedPct: 66.67,
        utilPct: 50,
        avgQueueDepth: 2,
        ...(hostOverrides.disk ?? {}),
      },
    },
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
      queueLagSec: 0.5,
      quarantinedCountLowerBound: 0,
      quarantineSampleLimitReached: false,
      oldestQuarantinedAgeSec: 0,
      mode: 'normal',
      condition: 'healthy',
      burstActive: false,
      action: {
        windowSec: 60,
        total: 1_659,
        success: 1_659,
        failure: 0,
        critical: 0,
        errorRate: 0,
        criticalRate: 0,
      },
      ...(overrides.readiness ?? {}),
    },
    adminReadiness: {
      available: true,
      httpStatus: 200,
      ok: true,
      database: true,
      redis: true,
      ...(overrides.adminReadiness ?? {}),
    },
    queueFence: {
      available: true,
      queueCount: 24,
      pausedCount: 0,
      activeCount: 0,
      ownerPresent: false,
      ...(overrides.queueFence ?? {}),
    },
    apiFleet: {
      available: true,
      expectedRoleCount: 14,
      observedRoleCount: 14,
      singletonRoleCount: 14,
      runningRoleCount: 14,
      identityRoleCount: 14,
      exactImageRoleCount: 14,
      duplicateContainerCount: 0,
      unexpectedApiContainerCount: 0,
      unexpectedMainContainerCount: 0,
      unexpectedScaleContainerCount: 0,
      unexpectedManualContainerCount: 0,
      totalRestartCount: 0,
      ...(overrides.apiFleet ?? {}),
    },
    privateToken: 'must-not-survive',
  };
}

function minuteSamples(start, count, overrides) {
  const startedAtMs = Date.parse(start);
  return Array.from({ length: count }, (_, index) =>
    normalizeSnapshot(sample(new Date(startedAtMs + index * 60_000).toISOString(), overrides)),
  );
}

function archiveAt(directory, value) {
  return archiveSnapshot(value, { directory, nowMs: Date.parse(value.observedAt) });
}

function shellFunction(name) {
  const match = new RegExp(`^${name}\\(\\) \\{[\\s\\S]*?^\\}`, 'mu').exec(monitorSource);
  assert.ok(match, `missing shell function ${name}`);
  return match[0];
}

function runMonitorLogHarness(logPath, tempRoot) {
  const harness = [
    'set -euo pipefail',
    'umask 077',
    'LOG_FILE="$1"',
    'EPHEMERAL_LOG_DIR=""',
    'MONITOR_LOG_FD=""',
    'MONITOR_TEE_PID=""',
    'MONITOR_WORKER_PID=""',
    'CAPACITY_SAMPLER_PID=""',
    'CAPACITY_SAMPLER_LOCK_FD=""',
    'TMPDIR="$2"',
    shellFunction('cleanup_monitor_log'),
    shellFunction('cleanup_monitor'),
    shellFunction('prepare_monitor_log'),
    'trap cleanup_monitor EXIT',
    'prepare_monitor_log',
    'printf "private monitor line\\n" | tee -a "/dev/fd/$MONITOR_LOG_FD" >/dev/null',
    'printf "path=%s\\n" "$LOG_FILE"',
    'printf "mode=%s\\n" "$(stat -c \'%a\' -- "$LOG_FILE")"',
  ].join('\n');
  return spawnSync('bash', ['-c', harness, 'monitor-log-harness', logPath, tempRoot], {
    encoding: 'utf8',
  });
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const commandEnd = stat.lastIndexOf(')');
    const state = commandEnd >= 0 ? stat.slice(commandEnd + 2, commandEnd + 3) : '';
    return state !== 'Z' && state !== 'X';
  } catch {
    return false;
  }
}

function runMonitorLifecycleHarness(tempRoot, processRoot, exitStatus) {
  const childFile = join(processRoot, 'child.pid');
  const samplerFile = join(processRoot, 'sampler.pid');
  const harness = [
    'set -euo pipefail',
    'umask 077',
    'LOG_FILE=""',
    'EPHEMERAL_LOG_DIR=""',
    'MONITOR_LOG_FD=""',
    'MONITOR_TEE_PID=""',
    'MONITOR_WORKER_PID=""',
    'CAPACITY_SAMPLER_PID=""',
    'CAPACITY_SAMPLER_LOCK_FD=""',
    'DURATION_SEC=10',
    'TMPDIR="$1"',
    'RUN_STATUS="$2"',
    'child_file="$3"',
    'sampler_file="$4"',
    shellFunction('cleanup_monitor_log'),
    shellFunction('cleanup_monitor'),
    shellFunction('prepare_monitor_log'),
    shellFunction('stop_capacity_sampler'),
    shellFunction('start_monitor_worker'),
    shellFunction('stop_monitor_worker'),
    shellFunction('start_monitor_output'),
    shellFunction('stop_monitor_output'),
    shellFunction('run_monitor_with_capacity_sampler'),
    'start_capacity_sampler() {',
    '  setsid bash -c \'sleep 30 & printf "%s\\n" "$!" > "$1"; wait\' sampler "$child_file" &',
    '  CAPACITY_SAMPLER_PID=$!',
    '  printf "%s\\n" "$CAPACITY_SAMPLER_PID" > "$sampler_file"',
    '}',
    'run_monitor() {',
    '  for _ in $(seq 1 100); do [[ -s "$child_file" ]] && break; sleep 0.01; done',
    '  [[ -s "$child_file" ]]',
    '  return "$RUN_STATUS"',
    '}',
    'trap cleanup_monitor EXIT',
    'prepare_monitor_log',
    'exec {MONITOR_LOCK_FD}>"$TMPDIR/monitor.lock"',
    'start_monitor_output',
    'printf "path=%s\\n" "$LOG_FILE"',
    'if run_monitor_with_capacity_sampler; then status=0; else status=$?; fi',
    'exit "$status"',
  ].join('\n');
  const result = spawnSync(
    'bash',
    [
      '-c',
      harness,
      'monitor-lifecycle-harness',
      tempRoot,
      String(exitStatus),
      childFile,
      samplerFile,
    ],
    { encoding: 'utf8' },
  );
  return { childFile, result, samplerFile };
}

function writeExecutable(path, source) {
  writeFileSync(path, source, { mode: 0o700 });
  chmodSync(path, 0o700);
}

function recordedProcesses(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .trim()
    .split(/\r?\n/u)
    .filter(Boolean)
    .flatMap((line) => line.trim().split(/\s+/u).map(Number))
    .filter((pid) => Number.isSafeInteger(pid) && pid > 1);
}

async function waitForCondition(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
  }
  throw new Error('Timed out waiting for monitor harness state.');
}

function waitForClose(child, timeoutMs) {
  return new Promise((resolvePromise, reject) => {
    const timer = setTimeout(
      () => reject(new Error('Monitor did not terminate in time.')),
      timeoutMs,
    );
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      resolvePromise({ code, signal });
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

function capacityStreamHarness(collect, options = {}) {
  const input = new PassThrough();
  const output = options.output ?? new PassThrough();
  let stdout = '';
  if (!options.output)
    output.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
    });
  const finished = runCapacityStream({
    input,
    output,
    collect,
    listenSignals: false,
    idleMs: 2_000,
    lifetimeMs: 5_000,
    ...options,
  });
  return {
    input,
    output,
    finished,
    stdout: () => stdout,
    async request() {
      const before = stdout.split('\n').length;
      input.write('SNAPSHOT\n');
      await waitForCondition(() => stdout.split('\n').length > before, 2_000);
      await new Promise((resolvePromise) => setImmediate(resolvePromise));
      return JSON.parse(stdout.trim().split('\n').at(-1));
    },
  };
}

function inspectedFleet() {
  return [
    ...DEFAULT_EXPECTED_API_SERVICES.map((_, index) => inspectedContainer(index)),
    inspectedSandbox(80, { restartCount: 12 }),
    inspectedPhotoSandbox(),
  ];
}

function probeInspectedFleet(inspection, options = {}) {
  return probeApiFleet(DEFAULT_EXPECTED_API_SERVICES, {
    expectedImage: expectedApiImage,
    ...options,
    runBounded: async (command, args) => ({
      ok: true,
      output:
        command === 'git'
          ? productionComposeSource
          : args[0] === 'ps'
            ? inspection.map((container) => container.Id).join('\n')
            : JSON.stringify(inspection),
    }),
  });
}

test('production disk counters select the REG RAID while legacy overrides remain explicit', () => {
  const diskstats = [
    '259 0 nvme0n1 10 0 20 30 40 0 50 60 0 11 12',
    '9 0 md0 10 0 20 30 40 0 50 60 0 21 22',
    '9 1 md1 10 0 20 30 40 0 50 60 0 70 80',
  ].join('\n');
  assert.equal(DEFAULT_BLOCK_DEVICE, 'md1');
  assert.match(
    monitorSource,
    /CAPACITY_BLOCK_DEVICE="\$\{MAXIM_MONITOR_CAPACITY_BLOCK_DEVICE:-md1\}"/u,
  );
  assert.deepEqual(parseDiskstats(diskstats, DEFAULT_BLOCK_DEVICE), {
    ioMs: 70,
    weightedIoMs: 80,
  });
  assert.throws(() => parseDiskstats(diskstats, 'vda'));
});

test('host counter parsers calculate bounded iowait, swap-in, and disk rates', () => {
  assert.deepEqual(parseProcStat('cpu  100 0 50 800 50 0 0 0 0 0\n'), {
    total: 1000,
    iowait: 50,
  });
  assert.deepEqual(parseVmstat('pgpgin 12\npswpin 42\npswpout 7\n'), { swapInPages: 42 });
  assert.deepEqual(
    parseMeminfo('MemTotal: 1000 kB\nMemAvailable: 400 kB\nSwapTotal: 200 kB\nSwapFree: 150 kB\n'),
    {
      memoryTotalBytes: 1_024_000,
      memoryAvailableBytes: 409_600,
      swapTotalBytes: 204_800,
      swapUsedBytes: 51_200,
    },
  );
  assert.deepEqual(parseDiskstats('8 0 vda 10 0 20 30 40 0 50 60 0 70 80\n', 'vda'), {
    ioMs: 70,
    weightedIoMs: 80,
  });
  assert.deepEqual(
    calculateCounterRates(
      {
        cpu: { total: 1_000, iowait: 50 },
        vmstat: { swapInPages: 10 },
        disk: { ioMs: 100, weightedIoMs: 200 },
      },
      {
        cpu: { total: 1_100, iowait: 70 },
        vmstat: { swapInPages: 14 },
        disk: { ioMs: 700, weightedIoMs: 1_200 },
      },
      1_000,
    ),
    {
      cpuIowaitPct: 20,
      swapInPagesPerSec: 4,
      diskUtilPct: 60,
      diskAvgQueueDepth: 1,
    },
  );
});

test('readiness and queue probes retain only allowlisted aggregate fields', () => {
  const readiness = normalizeReadyProbe(
    {
      httpStatus: 503,
      body: {
        message: {
          ok: false,
          privateToken: 'secret',
          burst: { active: true, privateBotId: 'bot-private' },
          systemMode: {
            mode: 'degrade',
            condition: 'queue_backlog',
            queueLagSec: 31,
            reason: 'private detail',
            action: {
              windowSec: 60,
              total: 100,
              success: 95,
              failure: 5,
              critical: 5,
              errorRate: 0.05,
              criticalRate: 0.05,
              privateBotIds: ['bot-private'],
            },
          },
          checks: {
            database: true,
            redis: true,
            queueLag: {
              ok: false,
              rawOk: false,
              softWarning: false,
              softWarningCode: null,
              effectiveLagSec: 31,
            },
          },
        },
      },
    },
    true,
  );
  assert.deepEqual(readiness, {
    available: true,
    httpStatus: 503,
    ok: false,
    database: true,
    redis: true,
    rawOk: false,
    queueOk: false,
    softWarning: false,
    softWarningCode: 'none',
    queueLagSec: 31,
    operationalLagSec: null,
    readinessWaitingCount: null,
    readinessHeadLimitReached: null,
    quarantinedCountLowerBound: null,
    quarantineSampleLimitReached: null,
    oldestQuarantinedAgeSec: null,
    mode: 'degrade',
    condition: 'queue_backlog',
    burstActive: true,
    action: {
      windowSec: 60,
      total: 100,
      success: 95,
      failure: 5,
      critical: 5,
      errorRate: 0.05,
      criticalRate: 0.05,
    },
  });
  assert.deepEqual(
    normalizeQueueFence({
      queueCount: 24,
      pausedCount: 0,
      activeCount: 3,
      ownerPresent: false,
      ownerToken: 'secret',
    }),
    { available: true, queueCount: 24, pausedCount: 0, activeCount: 3, ownerPresent: false },
  );
  assert.doesNotMatch(JSON.stringify(readiness), /secret|private/u);
});

test('preserves raw age and operational lag independently without weakening raw alerts', () => {
  const readiness = normalizeReadyProbe(
    {
      httpStatus: 200,
      body: {
        ok: true,
        checks: {
          database: true,
          redis: true,
          queueLag: {
            ok: true,
            rawOk: false,
            effectiveLagSec: 294,
            operationalLagSec: 0.45,
            readinessWaitingCount: 1,
            readinessHeadLimitReached: false,
            oldestQueuedEventId: 'private-event',
          },
        },
      },
    },
    true,
  );
  const archived = normalizeSnapshot(sample('2026-09-02T12:00:00.000Z', { readiness }));
  assert.equal(archived.readiness.queueLagSec, 294);
  assert.equal(archived.readiness.operationalLagSec, 0.45);
  assert.equal(archived.readiness.readinessWaitingCount, 1);
  assert.equal(archived.readiness.readinessHeadLimitReached, false);
  assert.equal(evaluateAlerts([], archived).alerts.queue_lag_critical.outcome, 'firing');
  assert.doesNotMatch(JSON.stringify(archived), /private-event|oldestQueuedEventId/u);

  for (const value of [undefined, null, '0', -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    const invalid = normalizeReadyProbe(
      {
        httpStatus: 200,
        body: {
          ok: true,
          checks: { queueLag: { effectiveLagSec: 294, operationalLagSec: value } },
        },
      },
      true,
    );
    assert.equal(invalid.operationalLagSec, null);
    assert.equal(invalid.readinessWaitingCount, null);
    assert.equal(invalid.readinessHeadLimitReached, null);
  }
  const legacy = normalizeSnapshot(sample('2026-09-02T12:00:00.000Z'));
  assert.equal(legacy.readiness.operationalLagSec, null);
  assert.equal(legacy.readiness.readinessWaitingCount, null);
  assert.equal(legacy.readiness.readinessHeadLimitReached, null);
  const invalidArchive = normalizeSnapshot(
    sample('2026-09-02T12:00:00.000Z', {
      readiness: {
        operationalLagSec: '0',
        readinessWaitingCount: 1.5,
        readinessHeadLimitReached: 'false',
      },
    }),
  );
  assert.equal(invalidArchive.readiness.operationalLagSec, null);
  assert.equal(invalidArchive.readiness.readinessWaitingCount, null);
  assert.equal(invalidArchive.readiness.readinessHeadLimitReached, null);
});

test('retains bounded quarantine evidence and warns even when active lag is zero', () => {
  for (const count of [0, 2, 65]) {
    const raw = normalizeReadyProbe(
      {
        httpStatus: 200,
        body: {
          ok: true,
          checks: {
            database: true,
            redis: true,
            queueLag: {
              ok: true,
              rawOk: true,
              softWarning: false,
              softWarningCode: null,
              effectiveLagSec: 0,
              operationalLagSec: 0,
              quarantinedCountLowerBound: count,
              quarantineSampleLimitReached: count === 65,
              oldestQuarantinedAgeSec: count ? 90 : 0,
              oldestQuarantinedChatId: 'private-quarantined-chat',
            },
          },
        },
      },
      true,
    );
    const current = normalizeSnapshot(sample('2026-09-02T12:00:00.000Z', { readiness: raw }));
    assert.equal(current.readiness.quarantinedCountLowerBound, count);
    assert.equal(current.readiness.quarantineSampleLimitReached, count === 65);
    assert.equal(current.readiness.oldestQuarantinedAgeSec, count ? 90 : 0);
    const { alerts } = evaluateAlerts([], current);
    assert.equal(alerts.readiness.outcome, 'clear');
    assert.equal(alerts.queue_lag_critical.outcome, 'clear');
    assert.equal(alerts.quarantined_receipts.outcome, count ? 'firing' : 'clear');
    assert.equal(alerts.quarantined_receipts.severity, 'warning');
    assert.equal(alerts.quarantined_receipts.value, count);
    assert.doesNotMatch(JSON.stringify(current), /private-quarantined-chat|ChatId/u);
  }
});

test('missing, malformed, inconsistent and stale quarantine samples cannot report empty', () => {
  for (const fields of [
    { quarantinedCountLowerBound: undefined },
    { quarantinedCountLowerBound: '0' },
    { quarantinedCountLowerBound: -1 },
    { quarantinedCountLowerBound: 1.5 },
    { quarantinedCountLowerBound: 66 },
    { quarantinedCountLowerBound: 65, quarantineSampleLimitReached: false },
    { quarantineSampleLimitReached: true },
    { quarantineSampleLimitReached: undefined },
    { oldestQuarantinedAgeSec: undefined },
    { oldestQuarantinedAgeSec: 1 },
    { oldestQuarantinedAgeSec: Number.NaN },
    { oldestQuarantinedAgeSec: -1 },
    { available: false },
    { softWarning: true, softWarningCode: 'stale-ready-fallback' },
  ]) {
    const current = normalizeSnapshot(sample('2026-09-02T12:00:00.000Z', { readiness: fields }));
    assert.equal(evaluateAlerts([], current).alerts.quarantined_receipts.outcome, 'unknown');
  }
  for (const value of [undefined, null, '0', -1, 1.5, 66, Number.NaN, Infinity]) {
    const raw = normalizeReadyProbe(
      {
        httpStatus: 200,
        body: { ok: true, checks: { queueLag: { quarantinedCountLowerBound: value } } },
      },
      true,
    );
    assert.equal(raw.quarantinedCountLowerBound, null);
  }
});

test('action health snapshots require internally consistent bounded arithmetic', () => {
  const valid = {
    windowSec: 60,
    total: 100,
    success: 95,
    failure: 5,
    critical: 4,
    errorRate: 0.05,
    criticalRate: 0.04,
    privateBreakdown: { botId: 'private' },
  };
  const expected = {
    windowSec: 60,
    total: 100,
    success: 95,
    failure: 5,
    critical: 4,
    errorRate: 0.05,
    criticalRate: 0.04,
  };
  assert.deepEqual(normalizeProbedActionHealth(valid), expected);
  assert.deepEqual(normalizeArchivedActionHealth(valid), expected);

  for (const malformed of [
    { ...valid, total: 99 },
    { ...valid, critical: 6 },
    { ...valid, errorRate: 0.5 },
    { ...valid, criticalRate: Number.NaN },
    { ...valid, success: -1 },
  ]) {
    assert.equal(normalizeProbedActionHealth(malformed), null);
    assert.equal(normalizeArchivedActionHealth(malformed), null);
  }
});

test('API fleet census checks runtime identity and exact-image roles without exposing identities', async () => {
  const inspection = [
    ...DEFAULT_EXPECTED_API_SERVICES.map((_, index) => inspectedContainer(index)),
    inspectedSandbox(80),
    inspectedPhotoSandbox(),
  ];
  const ids = inspection.map((container) => container.Id);
  const calls = [];
  const healthy = await probeApiFleet(DEFAULT_EXPECTED_API_SERVICES, {
    expectedImage: expectedApiImage,
    runBounded: async (command, args, options) => {
      calls.push([command, args, options]);
      if (command === 'git') return { ok: true, output: productionComposeSource };
      return args[0] === 'ps'
        ? { ok: true, output: `${ids.join('\n')}\n` }
        : { ok: true, output: JSON.stringify(inspection) };
    },
  });
  const { restartEvidence: historicalRestarts, ...healthyCounters } = healthy;
  assert.equal(historicalRestarts.basis, 'historical_container_totals');
  assert.deepEqual(historicalRestarts.api, { total: 0, delta: null, generationChanged: null });
  assert.deepEqual(healthyCounters, {
    available: true,
    expectedRoleCount: 14,
    observedRoleCount: 14,
    singletonRoleCount: 14,
    runningRoleCount: 14,
    identityRoleCount: 14,
    exactImageRoleCount: 14,
    duplicateContainerCount: 0,
    unexpectedApiContainerCount: 0,
    unexpectedMainContainerCount: 0,
    unexpectedScaleContainerCount: 0,
    unexpectedManualContainerCount: 0,
    totalRestartCount: 0,
  });
  assert.deepEqual(calls[0].slice(0, 2), [
    'git',
    ['show', `${apiImageSha}:infra/docker-compose.yml`],
  ]);
  assert.deepEqual(calls[1][1].slice(0, 2), ['ps', '-a']);
  assert.equal(calls[2][1][0], 'inspect');
  assert.equal(calls[2][1].length, ids.length + 1);
  assert.equal(calls[2][2].maxOutputBytes, 16 * 1024 * 1024);
  assert.doesNotMatch(
    JSON.stringify(healthy),
    /sha256|[0-9a-f]{40}|api-|must-not-survive|PRIVATE_TOKEN/u,
  );

  const containers = parseApiFleetInspection(
    JSON.stringify([
      inspection[0],
      inspectedContainer(1, { appRole: 'moderation' }),
      ...inspection.slice(2, -3),
      inspectedContainer(13, { running: false, restartCount: 2 }),
      inspectedContainer(20, { service: DEFAULT_EXPECTED_API_SERVICES[0] }),
      inspectedContainer(21, {
        service: 'api-unexpected',
        appServiceName: null,
        appRole: null,
      }),
      inspectedContainer(22, { project: 'infra-scale', service: 'api-action' }),
      inspectedContainer(23, {
        project: null,
        service: null,
        appServiceName: 'api-moderation',
        appRole: 'moderation',
        imageId: `sha256:${'8'.repeat(64)}`,
        imageRef: 'private-worker:stable',
        releaseProtected: false,
        running: false,
      }),
      inspectedContainer(24, {
        project: null,
        service: null,
        appServiceName: null,
        appRole: null,
        imageId: `sha256:${'7'.repeat(64)}`,
        imageRef: 'private-worker:stable',
        name: '/manual-api-worker',
      }),
      inspectedContainer(25, {
        project: 'sibling',
        service: 'api',
        appServiceName: null,
        appRole: null,
        imageId: `sha256:${'6'.repeat(64)}`,
        imageRef: 'sibling-api:stable',
        releaseProtected: false,
      }),
      inspectedContainer(26, {
        project: 'infra',
        service: 'miniapp-major-static',
        appServiceName: null,
        appRole: null,
        imageId: `sha256:${'5'.repeat(64)}`,
        imageRef: 'maxim-miniapp-major:stable',
        name: '/infra-miniapp-major-static-1',
      }),
    ]),
  );
  assert.doesNotMatch(JSON.stringify(containers), /must-not-survive|PRIVATE_TOKEN/u);
  assert.deepEqual(summarizeApiFleet(DEFAULT_EXPECTED_API_SERVICES, expectedApiImage, containers), {
    available: true,
    expectedRoleCount: 14,
    observedRoleCount: 14,
    singletonRoleCount: 13,
    runningRoleCount: 12,
    identityRoleCount: 12,
    exactImageRoleCount: 13,
    duplicateContainerCount: 1,
    unexpectedApiContainerCount: 4,
    unexpectedMainContainerCount: 1,
    unexpectedScaleContainerCount: 1,
    unexpectedManualContainerCount: 2,
    totalRestartCount: 2,
  });
  assert.equal(normalizeApiFleet({ ...healthy, runningRoleCount: 15 }).available, null);
  assert.equal(
    normalizeApiFleet({ ...healthy, unexpectedManualContainerCount: 1 }).available,
    null,
  );
  const preIdentityFleet = { ...healthy };
  delete preIdentityFleet.identityRoleCount;
  delete preIdentityFleet.unexpectedMainContainerCount;
  delete preIdentityFleet.unexpectedScaleContainerCount;
  delete preIdentityFleet.unexpectedManualContainerCount;
  assert.equal(normalizeApiFleet(preIdentityFleet).available, null);
  assert.equal(
    evaluateAlerts([], normalizeSnapshot(sample('2026-09-02T12:00:00.000Z', { apiFleet: healthy })))
      .alerts.api_fleet_topology.outcome,
    'clear',
  );
  assert.equal(
    evaluateAlerts(
      [],
      normalizeSnapshot(
        sample('2026-09-02T12:00:00.000Z', {
          apiFleet: summarizeApiFleet(DEFAULT_EXPECTED_API_SERVICES, expectedApiImage, containers),
        }),
      ),
    ).alerts.api_fleet_topology.outcome,
    'firing',
  );
});

test('resident capacity collector reuses exact generations and resets on a new process', async () => {
  let inspection = inspectedFleet();
  let index = 0;
  const collect = async ({ restartTracker, signal }) => {
    const observedAt = new Date(Date.UTC(2026, 8, 2, 12, 0, index * 15)).toISOString();
    const apiFleet = await probeInspectedFleet(inspection, {
      restartTracker,
      signal,
      observedAt,
      clock: ++index * 15_000,
    });
    return { observedAt, apiFleet };
  };
  const stream = capacityStreamHarness(collect);
  try {
    const first = await stream.request();
    assert.equal(first.observedAt, first.apiFleet.restartEvidence.observedAt);
    assert.equal(first.apiFleet.totalRestartCount, 12, 'legacy protection total includes OCR');
    assert.deepEqual(first.apiFleet.restartEvidence.api, {
      total: 0,
      delta: null,
      generationChanged: null,
    });
    assert.deepEqual(first.apiFleet.restartEvidence.ocr, {
      total: 12,
      delta: null,
      generationChanged: null,
    });
    assert.deepEqual(first.apiFleet.restartEvidence.photo, {
      total: 0,
      delta: null,
      generationChanged: null,
    });
    inspection = structuredClone(inspection);
    inspection[0].RestartCount = 1;
    const second = await stream.request();
    assert.equal(second.apiFleet.restartEvidence.previousObservedAt, first.observedAt);
    assert.deepEqual(second.apiFleet.restartEvidence.api, {
      total: 1,
      delta: 1,
      generationChanged: false,
    });
    assert.deepEqual(second.apiFleet.restartEvidence.ocr, {
      total: 12,
      delta: 0,
      generationChanged: false,
    });
    inspection.at(-1).RestartCount = 2;
    const third = await stream.request();
    assert.deepEqual(third.apiFleet.restartEvidence.api, {
      total: 1,
      delta: 0,
      generationChanged: false,
    });
    assert.deepEqual(third.apiFleet.restartEvidence.photo, {
      total: 2,
      delta: 2,
      generationChanged: false,
    });
    assert.doesNotMatch(
      stream.stdout(),
      /[0-9a-f]{40}|sha256|api-|native-sandbox|PRIVATE_TOKEN|APP_ROLE|must-not-survive|OOM|timeoutReason/u,
    );
  } finally {
    stream.input.end();
    await stream.finished;
  }
  const restarted = capacityStreamHarness(collect);
  try {
    const first = await restarted.request();
    assert.equal(first.apiFleet.restartEvidence.previousObservedAt, null);
    for (const name of ['api', 'ocr', 'photo']) {
      assert.equal(first.apiFleet.restartEvidence[name].delta, null);
      assert.equal(first.apiFleet.restartEvidence[name].generationChanged, null);
    }
  } finally {
    restarted.input.end();
    await restarted.finished;
  }
});

test('restart intervals detect equal-sum replacements, counter rollback, gaps and invalid classes', async () => {
  const observedAt = (seconds) => new Date(Date.UTC(2026, 8, 2, 12, 0, seconds)).toISOString();
  for (const [label, replacement, nextOtherCount] of [
    ['equal total', 5, 0],
    ['lower total', 0, 0],
    ['offsetting changes', 0, 5],
  ]) {
    const tracker = createRestartTracker();
    const inspection = inspectedFleet();
    inspection[0].RestartCount = 5;
    await probeInspectedFleet(inspection, {
      restartTracker: tracker,
      observedAt: observedAt(0),
      clock: 0,
    });
    inspection[0].Id = 'e'.repeat(64);
    inspection[0].RestartCount = replacement;
    inspection[1].RestartCount = nextOtherCount;
    const result = await probeInspectedFleet(inspection, {
      restartTracker: tracker,
      observedAt: observedAt(15),
      clock: 15_000,
    });
    assert.equal(result.restartEvidence.api.generationChanged, true, label);
    assert.equal(result.restartEvidence.api.delta, null, label);
    assert.equal(result.restartEvidence.ocr.delta, 0, label);
  }
  const classes = {
    api: [
      { key: 'first', id: '1'.repeat(64), count: 5 },
      { key: 'second', id: '2'.repeat(64), count: 0 },
    ],
    ocr: [{ key: 'ocr', id: '3'.repeat(64), count: 12 }],
    photo: [{ key: 'photo', id: '4'.repeat(64), count: 0 }],
  };
  const tracker = createRestartTracker();
  tracker.observe(classes, observedAt(0), 0);
  classes.api[0].count = 0;
  let current = tracker.observe(classes, observedAt(15), 15_000);
  assert.deepEqual(current.api, { total: 0, delta: null, generationChanged: false });
  current = tracker.observe(classes, observedAt(106), 106_000);
  assert.equal(current.previousObservedAt, observedAt(15));
  assert.deepEqual(current.api, { total: 0, delta: null, generationChanged: false });
  current = tracker.observe(classes, observedAt(121), 121_000);
  assert.equal(current.api.delta, 0, 'a gap does not permanently disable the next valid interval');
  current = tracker.observe({ ...classes, ocr: null }, observedAt(136), 136_000);
  assert.deepEqual(current.ocr, { total: null, delta: null, generationChanged: null });
  assert.equal(current.api.delta, 0);
  assert.equal(current.photo.delta, 0);
  current = tracker.observe(classes, observedAt(151), 151_000);
  assert.deepEqual(current.ocr, { total: 12, delta: null, generationChanged: null });
  assert.equal(current.api.delta, 0);
  for (const entries of [
    undefined,
    [null],
    [{ key: 'api', count: 0 }],
    [{ key: 'api', id: 'bad', count: 0 }],
    [{ key: 'api', id: '1'.repeat(64), count: -1 }],
    [{ key: 'api', id: '1'.repeat(64), count: '0' }],
    [
      { key: 'one', id: '1'.repeat(64), count: Number.MAX_SAFE_INTEGER },
      { key: 'two', id: '2'.repeat(64), count: 1 },
    ],
    [...classes.api, classes.api[0]],
  ]) {
    const invalid = createRestartTracker().observe({ ...classes, api: entries }, observedAt(0), 0);
    assert.deepEqual(invalid.api, { total: null, delta: null, generationChanged: null });
    assert.equal(invalid.ocr.total, 12);
  }
});

test('invalid native identity clears only its restart baseline and malformed inspection fails closed', async () => {
  const tracker = createRestartTracker();
  const inspection = inspectedFleet();
  await probeInspectedFleet(inspection, {
    restartTracker: tracker,
    observedAt: '2026-09-02T12:00:00.000Z',
    clock: 0,
  });
  const invalid = structuredClone(inspection);
  invalid.at(-2).Config.Env.push('REDIS_URL=redis://private-secret');
  const current = await probeInspectedFleet(invalid, {
    restartTracker: tracker,
    observedAt: '2026-09-02T12:00:15.000Z',
    clock: 15_000,
  });
  assert.deepEqual(current.restartEvidence.ocr, {
    total: null,
    delta: null,
    generationChanged: null,
  });
  assert.equal(current.restartEvidence.api.delta, 0);
  assert.equal(current.restartEvidence.photo.delta, 0);
  assert.doesNotMatch(JSON.stringify(current), /private-secret|REDIS_URL/u);
  for (const defect of ['id', 'state', 'counter']) {
    const broken = structuredClone(inspection);
    if (defect === 'id') delete broken[0].Id;
    if (defect === 'state') delete broken[0].State;
    if (defect === 'counter') broken[0].RestartCount = '0';
    const refused = await probeInspectedFleet(broken);
    assert.equal(refused.available, false, defect);
    for (const name of ['api', 'ocr', 'photo'])
      assert.equal(refused.restartEvidence[name].total, null, defect);
  }
});

test('resident capacity protocol refuses malformed, queued, overlapping and oversized work', async () => {
  for (const payload of ['INVALID\n', 'SNAPSHOT\nSNAPSHOT\n', 'SNAPSHOT\r\n', 'x'.repeat(65_537)]) {
    let calls = 0;
    const stream = capacityStreamHarness(async () => {
      calls += 1;
      return {};
    });
    stream.input.write(payload);
    assert.equal(await stream.finished, 1);
    assert.equal(calls, 0);
    assert.equal(stream.stdout(), '');
    stream.input.destroy();
  }
  let aborted = false;
  const overlapping = capacityStreamHarness(
    ({ signal }) =>
      new Promise((resolvePromise) => {
        signal.addEventListener(
          'abort',
          () => {
            aborted = true;
            resolvePromise({});
          },
          { once: true },
        );
      }),
  );
  overlapping.input.write('SNAPSHOT\n');
  overlapping.input.write('SNAPSHOT\n');
  assert.equal(await overlapping.finished, 1);
  assert.equal(aborted, true);
  assert.equal(overlapping.stdout(), '');
  overlapping.input.destroy();
  const oversized = capacityStreamHarness(async () => ({ private: 'x'.repeat(65_537) }));
  oversized.input.write('SNAPSHOT\n');
  assert.equal(await oversized.finished, 1);
  assert.equal(oversized.stdout(), '');
  oversized.input.destroy();
});

test('resident stream cancels active collection on EOF, idle, TTL and EPIPE', async () => {
  for (const [label, options, expected] of [
    ['EOF', {}, 0],
    ['idle', { idleMs: 30 }, 1],
    ['TTL', { lifetimeMs: 30 }, 0],
  ]) {
    let aborted = false;
    const stream = capacityStreamHarness(
      ({ signal }) =>
        new Promise((resolvePromise) => {
          signal.addEventListener(
            'abort',
            () => {
              aborted = true;
              resolvePromise({});
            },
            { once: true },
          );
        }),
      options,
    );
    stream.input.write('SNAPSHOT\n');
    if (label === 'EOF') stream.input.end();
    assert.equal(await stream.finished, expected, label);
    assert.equal(aborted, true, label);
    assert.equal(stream.stdout(), '', label);
    stream.input.destroy();
  }
  const brokenOutput = new Writable({
    write(_chunk, _encoding, callback) {
      const error = new Error('fixture closed pipe');
      error.code = 'EPIPE';
      callback(error);
    },
  });
  const broken = capacityStreamHarness(async () => ({}), { output: brokenOutput });
  broken.input.write('SNAPSHOT\n');
  assert.equal(await broken.finished, 1);
  broken.input.destroy();
  let cancelled = false;
  const blocked = capacityStreamHarness(async () => ({}), {
    output: new Writable({
      write() {
        cancelled = true;
      },
    }),
  });
  blocked.input.write('SNAPSHOT\n');
  await waitForCondition(() => cancelled, 1_000);
  blocked.input.end();
  assert.equal(await blocked.finished, 0, 'EOF cancels a blocked response write');
});

test(
  'resident process reaps its exact active subprocess on EOF and termination signals',
  { timeout: 20_000 },
  async () => {
    const directory = mkdtempSync(join(tmpdir(), 'maxim-capacity-stream-children-'));
    const childSource =
      "require('node:fs').writeFileSync(process.argv[1], String(process.pid)); setInterval(() => {}, 1000);";
    const harnessSource = `
    const { runCapacityStream, runBounded } = require(process.argv[1]);
    runCapacityStream({ collect: async ({ signal }) => {
      await runBounded(process.execPath, ['-e', ${JSON.stringify(childSource)}, process.argv[2]], { signal, timeoutMs: 10000 });
      return {};
    } }).then((code) => { process.exitCode = code; });
  `;
    try {
      for (const [signal, expected] of [
        [null, 0],
        ['SIGTERM', 143],
        ['SIGINT', 130],
        ['SIGHUP', 129],
      ]) {
        const pidPath = join(directory, `${signal ?? 'EOF'}.pid`);
        const child = spawn(process.execPath, ['-e', harnessSource, probePath, pidPath], {
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        let stdout = '';
        let stderr = '';
        let pid;
        child.stdout.on('data', (chunk) => {
          stdout += chunk.toString('utf8');
        });
        child.stderr.on('data', (chunk) => {
          stderr += chunk.toString('utf8');
        });
        try {
          child.stdin.write('SNAPSHOT\n');
          await waitForCondition(
            () => existsSync(pidPath) && readFileSync(pidPath, 'utf8').length > 0,
            2_000,
          );
          pid = Number(readFileSync(pidPath, 'utf8'));
          assert.ok(isProcessAlive(pid));
          const closed = waitForClose(child, 2_000);
          if (signal) child.kill(signal);
          else child.stdin.end();
          assert.deepEqual(await closed, { code: expected, signal: null }, stderr);
          assert.equal(
            existsSync(`/proc/${pid}`),
            false,
            `owned child was not reaped after ${signal ?? 'EOF'}`,
          );
          assert.equal(stdout, '');
        } finally {
          child.kill('SIGKILL');
          if (pid && isProcessAlive(pid)) process.kill(pid, 'SIGKILL');
        }
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

test('bounded probe cancellation waits for child close on timeout and output overflow', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'maxim-capacity-bounded-'));
  try {
    for (const overflow of [false, true]) {
      const pidPath = join(directory, `${overflow}.pid`);
      const source =
        "require('node:fs').writeFileSync(process.argv[1], String(process.pid)); " +
        (overflow ? "process.stdout.write('x'.repeat(10000)); " : '') +
        'setInterval(() => {}, 1000);';
      const result = await runBounded(process.execPath, ['-e', source, pidPath], {
        timeoutMs: 500,
        maxOutputBytes: 10,
      });
      assert.deepEqual(result, { ok: false, output: '' });
      assert.equal(existsSync(`/proc/${Number(readFileSync(pidPath, 'utf8'))}`), false);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('failed host counter read drains active probe children before collection rejects', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'maxim-capacity-counter-failure-'));
  const pidPath = join(directory, 'docker.pid');
  const priorPath = process.env.PATH;
  const controller = new AbortController();
  let pid;
  writeExecutable(
    join(directory, 'docker'),
    ['#!/usr/bin/env bash', `printf '%s' "$$" > '${pidPath}'`, 'exec sleep 30'].join('\n'),
  );
  process.env.PATH = `${directory}:${priorPath}`;
  try {
    let reads = 0;
    let settled = false;
    const result = collectCapacitySnapshot({
      sampleMs: 250,
      signal: controller.signal,
      readHostCounters() {
        if (++reads > 1) throw new Error('fixture counter read failed');
        return {};
      },
    })
      .then(
        () => ({ success: true }),
        (error) => ({ error }),
      )
      .finally(() => {
        settled = true;
      });
    await waitForCondition(
      () => existsSync(pidPath) && readFileSync(pidPath, 'utf8').length > 0 && reads === 2,
      2_000,
    );
    pid = Number(readFileSync(pidPath, 'utf8'));
    assert.ok(isProcessAlive(pid));
    assert.equal(settled, false, 'counter failure must wait for pending probes');
    controller.abort();
    const rejected = await result;
    assert.equal(rejected.error?.name, 'AbortError');
    assert.equal(
      existsSync(`/proc/${pid}`),
      false,
      'collection must reap the active probe before rejecting',
    );
  } finally {
    controller.abort();
    process.env.PATH = priorPath;
    if (pid && isProcessAlive(pid)) process.kill(pid, 'SIGKILL');
    rmSync(directory, { recursive: true, force: true });
  }
});

test('invalid resident CLI arguments return a fixed diagnostic without reflecting input', () => {
  for (const args of [
    ['--stream', 'PRIVATE_TOKEN=private-argument'],
    ['--stream', 'md2', 'private-service-name'],
  ]) {
    const refused = spawnSync(process.execPath, [probePath, ...args], { encoding: 'utf8' });
    assert.equal(refused.status, 1);
    assert.equal(refused.stdout, '');
    assert.equal(refused.stderr, 'Capacity stream unavailable.\n');
  }
});

test('API fleet expected roles fail closed on env, protected-label, and owned-name drift', () => {
  for (const [label, defect] of [
    ['role env', { appRole: 'admin' }],
    ['protected label', { releaseProtected: false }],
    ['container name', { name: '/infra-api-admin-1' }],
  ]) {
    const inspection = DEFAULT_EXPECTED_API_SERVICES.map((_, index) =>
      inspectedContainer(index, index === 0 ? defect : {}),
    );
    const fleet = summarizeApiFleet(
      DEFAULT_EXPECTED_API_SERVICES,
      expectedApiImage,
      parseApiFleetInspection(JSON.stringify(inspection)),
    );
    assert.equal(fleet.observedRoleCount, 14, label);
    assert.equal(fleet.singletonRoleCount, 14, label);
    assert.equal(fleet.runningRoleCount, 14, label);
    assert.equal(fleet.exactImageRoleCount, 14, label);
    assert.equal(fleet.identityRoleCount, 13, label);
    assert.equal(
      evaluateAlerts([], normalizeSnapshot(sample('2026-09-02T12:00:00.000Z', { apiFleet: fleet })))
        .alerts.api_fleet_topology.outcome,
      'firing',
      label,
    );
  }
});

test('API fleet keeps 14 role metrics while strictly attesting the source-expected OCR sandbox', () => {
  const roles = DEFAULT_EXPECTED_API_SERVICES.map((_, index) => inspectedContainer(index));
  const validSandbox = inspectedSandbox(80, { restartCount: 2 });
  const healthy = summarizeApiFleet(
    DEFAULT_EXPECTED_API_SERVICES,
    expectedApiImage,
    parseApiFleetInspection(JSON.stringify([...roles, validSandbox])),
    'ocr-native-sandbox',
  );
  assert.deepEqual(healthy, {
    available: true,
    expectedRoleCount: 14,
    observedRoleCount: 14,
    singletonRoleCount: 14,
    runningRoleCount: 14,
    identityRoleCount: 14,
    exactImageRoleCount: 14,
    duplicateContainerCount: 0,
    unexpectedApiContainerCount: 0,
    unexpectedMainContainerCount: 0,
    unexpectedScaleContainerCount: 0,
    unexpectedManualContainerCount: 0,
    totalRestartCount: 2,
  });
  assert.equal(
    evaluateAlerts([], normalizeSnapshot(sample('2026-09-02T12:00:00.000Z', { apiFleet: healthy })))
      .alerts.api_fleet_topology.outcome,
    'clear',
  );

  const missing = summarizeApiFleet(
    DEFAULT_EXPECTED_API_SERVICES,
    expectedApiImage,
    parseApiFleetInspection(JSON.stringify(roles)),
    'ocr-native-sandbox',
  );
  assert.equal(missing.expectedRoleCount, 14);
  assert.equal(missing.unexpectedApiContainerCount, 1);
  assert.equal(missing.unexpectedMainContainerCount, 1);

  const duplicate = summarizeApiFleet(
    DEFAULT_EXPECTED_API_SERVICES,
    expectedApiImage,
    parseApiFleetInspection(
      JSON.stringify([
        ...roles,
        validSandbox,
        inspectedSandbox(81, { name: '/infra-ocr-native-sandbox-2' }),
      ]),
    ),
    'ocr-native-sandbox',
  );
  assert.equal(duplicate.expectedRoleCount, 14);
  assert.equal(duplicate.duplicateContainerCount, 0);
  assert.equal(duplicate.unexpectedApiContainerCount, 2);
  assert.equal(duplicate.unexpectedMainContainerCount, 2);

  const historical = summarizeApiFleet(
    DEFAULT_EXPECTED_API_SERVICES,
    expectedApiImage,
    parseApiFleetInspection(JSON.stringify([...roles, validSandbox])),
  );
  assert.equal(historical.unexpectedApiContainerCount, 1);
  assert.equal(historical.unexpectedMainContainerCount, 1);

  const foreign = summarizeApiFleet(
    DEFAULT_EXPECTED_API_SERVICES,
    expectedApiImage,
    parseApiFleetInspection(
      JSON.stringify([...roles, inspectedSandbox(82, { project: 'infra-scale' })]),
    ),
    'ocr-native-sandbox',
  );
  assert.equal(foreign.unexpectedApiContainerCount, 1);
  assert.equal(foreign.unexpectedScaleContainerCount, 1);

  const mislabeledRole = inspectedContainer(0, {
    labels: { 'com.maxim.ocr-native-sandbox': 'true' },
  });
  const mislabeled = summarizeApiFleet(
    DEFAULT_EXPECTED_API_SERVICES,
    expectedApiImage,
    parseApiFleetInspection(JSON.stringify([mislabeledRole, ...roles.slice(1), validSandbox])),
    'ocr-native-sandbox',
  );
  assert.equal(mislabeled.observedRoleCount, 13);
  assert.equal(mislabeled.unexpectedApiContainerCount, 2);
  assert.equal(mislabeled.unexpectedMainContainerCount, 2);
});

test('API fleet rejects every security-relevant OCR sandbox drift without exposing secrets', () => {
  const roles = DEFAULT_EXPECTED_API_SERVICES.map((_, index) => inspectedContainer(index));
  const baselineEnvironment = inspectedSandbox(80).Config.Env;
  const defects = [
    { status: 'paused' },
    { health: 'unhealthy' },
    { imageId: `sha256:${'8'.repeat(64)}` },
    { imageRef: `maxim-api:${'c'.repeat(40)}` },
    { user: '0:0' },
    { command: ['node', 'unexpected.js'] },
    { environment: [...baselineEnvironment, 'APP_ROLE=moderation'] },
    { environment: [...baselineEnvironment, 'APP_SERVICE_NAME=api-media-analysis'] },
    { environment: [...baselineEnvironment, 'REDIS_URL=redis://private-secret'] },
    { environment: [...baselineEnvironment, 'COMMERCIAL_OCR_TESSDATA_PREFIX=/models'] },
    {
      environment: baselineEnvironment.map((entry) =>
        entry.startsWith('COMMERCIAL_OCR_MAX_SIDE=') ? 'COMMERCIAL_OCR_MAX_SIDE=1600' : entry,
      ),
    },
    {
      environment: baselineEnvironment.filter(
        (entry) => !entry.startsWith('COMMERCIAL_OCR_TESSERACT_RECYCLE_AFTER_JOBS='),
      ),
    },
    { labels: { 'com.maxim.release-protected': 'false' } },
    { labels: { 'com.maxim.ocr-native-sandbox': 'false' } },
    { labels: { 'com.maxim.ocr-native-sandbox-capable': 'false' } },
    { hostConfig: { NetworkMode: 'default' } },
    { hostConfig: { ReadonlyRootfs: false } },
    { hostConfig: { Init: false } },
    { hostConfig: { Memory: 512 * 1024 ** 2 } },
    { hostConfig: { NanoCpus: 2_000_000_000 } },
    { hostConfig: { PidsLimit: 0 } },
    { hostConfig: { CapDrop: [] } },
    { hostConfig: { SecurityOpt: [] } },
    { hostConfig: { Tmpfs: { '/tmp': 'size=128m,mode=1777,uid=1000,gid=1000' } } },
    { mounts: [] },
    {
      mounts: [
        {
          Type: 'volume',
          Name: 'infra_ocr_native_ipc',
          Destination: '/run/maxim-ocr',
          RW: false,
          Mode: 'ro',
        },
      ],
    },
  ];

  defects.forEach((defect, index) => {
    const parsed = parseApiFleetInspection(
      JSON.stringify([...roles, inspectedSandbox(index + 80, defect)]),
    );
    assert.doesNotMatch(JSON.stringify(parsed), /private-secret|REDIS_URL/u);
    const fleet = summarizeApiFleet(
      DEFAULT_EXPECTED_API_SERVICES,
      expectedApiImage,
      parsed,
      'ocr-native-sandbox',
    );
    assert.equal(fleet.expectedRoleCount, 14, JSON.stringify(defect));
    assert.equal(fleet.unexpectedApiContainerCount, 1, JSON.stringify(defect));
    assert.equal(fleet.unexpectedMainContainerCount, 1, JSON.stringify(defect));
  });
});

test('API fleet reads a release with independent Lastik while retaining manifest guards', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'maxim-capacity-lastik-'));
  const manifestPath = join(directory, 'current.json');
  const eraser = {
    sourceSha: '1'.repeat(40),
    imageRef: `maxim-eraser:${'1'.repeat(40)}`,
    imageId: `sha256:${'2'.repeat(64)}`,
  };
  const manifest = currentReleaseManifest();
  manifest.components.eraser = eraser;
  writeFileSync(manifestPath, JSON.stringify(manifest));
  const inspection = [
    ...DEFAULT_EXPECTED_API_SERVICES.map((_, index) => inspectedContainer(index)),
    inspectedSandbox(80),
    inspectedPhotoSandbox(),
    inspectedContainer(81, {
      service: 'eraser',
      appRole: null,
      appServiceName: null,
      imageRef: eraser.imageRef,
      imageId: eraser.imageId,
    }),
  ];
  const fleet = await probeApiFleet(DEFAULT_EXPECTED_API_SERVICES, {
    manifestPath,
    runBounded: async (command, args) => {
      if (command === 'git') {
        assert.deepEqual(args, ['show', `${apiImageSha}:infra/docker-compose.yml`]);
        return { ok: true, output: productionComposeSource };
      }
      return {
        ok: true,
        output:
          args[0] === 'ps'
            ? inspection.map((container) => container.Id).join('\n')
            : JSON.stringify(inspection),
      };
    },
  });
  assert.equal(fleet.available, true);
  assert.equal(fleet.expectedRoleCount, 14);
  assert.equal(fleet.exactImageRoleCount, 14);
  assert.equal(fleet.identityRoleCount, 14);
  assert.equal(fleet.unexpectedApiContainerCount, 0);
  assert.deepEqual(readExpectedApiImage(manifestPath), expectedApiImage);

  const invalid = [
    { ...manifest.components, eraser: null },
    { ...manifest.components, eraser: { ...eraser, sourceSha: 'invalid' } },
    { ...manifest.components, eraser: { ...eraser, imageId: '' } },
    { ...manifest.components, eraser: { ...eraser, imageRef: '' } },
    { ...currentReleaseManifest().components, unknown: eraser },
    { ...manifest.components, unknown: eraser },
  ];
  const missingRequired = { ...manifest.components };
  delete missingRequired['admin-static'];
  invalid.push(missingRequired);
  for (const components of invalid) {
    writeFileSync(manifestPath, JSON.stringify({ ...manifest, components }));
    assert.throws(() => readExpectedApiImage(manifestPath), /incomplete or invalid/u);
  }
});

test('API fleet fallback topology and release manifest identity stay exact', () => {
  const topologySource = readFileSync(
    resolve(root, 'infra/scripts/lib/deploy-topology.sh'),
    'utf8',
  );
  const topologyBlock =
    /MAXIM_PRODUCTION_API_SERVICES=\(\n(?<services>[\s\S]*?)\n\)/u.exec(topologySource)?.groups
      ?.services ?? '';
  const topologyServices = [...topologyBlock.matchAll(/^\s+"(?<service>api-[a-z0-9-]+)"$/gmu)].map(
    (match) => match.groups.service,
  );
  assert.deepEqual(DEFAULT_EXPECTED_API_SERVICES, topologyServices);
  const baseServices = DEFAULT_EXPECTED_API_SERVICES.filter(
    (service) =>
      service !== 'api-media-analysis' &&
      service !== 'api-publisher' &&
      service !== 'api-message-retention',
  );
  const legacyCompose = `services:\n${baseServices.map((service) => `  ${service}:`).join('\n')}`;
  assert.deepEqual(
    resolveExpectedApiTopologyFromCompose(DEFAULT_EXPECTED_API_SERVICES, productionComposeSource),
    {
      services: DEFAULT_EXPECTED_API_SERVICES,
      expectedAuxiliaryService: 'ocr-native-sandbox,photo-native-sandbox',
    },
  );
  assert.deepEqual(
    resolveExpectedApiTopologyFromCompose(DEFAULT_EXPECTED_API_SERVICES, legacyCompose),
    { services: baseServices, expectedAuxiliaryService: null },
  );
  assert.deepEqual(
    resolveExpectedApiServicesFromCompose(DEFAULT_EXPECTED_API_SERVICES, legacyCompose),
    baseServices,
  );
  assert.deepEqual(
    resolveExpectedApiServicesFromCompose(
      DEFAULT_EXPECTED_API_SERVICES,
      `${legacyCompose}\n  api-media-analysis:`,
    ),
    DEFAULT_EXPECTED_API_SERVICES.filter(
      (service) => service !== 'api-publisher' && service !== 'api-message-retention',
    ),
  );
  assert.deepEqual(
    resolveExpectedApiServicesFromCompose(
      DEFAULT_EXPECTED_API_SERVICES,
      `${legacyCompose}\nvolumes:\n  api-publisher:`,
    ),
    baseServices,
  );
  assert.deepEqual(
    resolveExpectedApiServicesFromCompose(
      DEFAULT_EXPECTED_API_SERVICES,
      legacyCompose.replace('\n  api-admin:', '\n# valid root comment\n  api-admin:'),
    ),
    baseServices,
  );
  assert.throws(
    () =>
      resolveExpectedApiServicesFromCompose(
        DEFAULT_EXPECTED_API_SERVICES,
        `${legacyCompose}\nservices:\n${baseServices.map((service) => `  ${service}:`).join('\n')}`,
      ),
    /services section is missing or ambiguous/u,
  );
  assert.throws(
    () =>
      resolveExpectedApiTopologyFromCompose(
        DEFAULT_EXPECTED_API_SERVICES,
        `${legacyCompose}\n  ocr-native-sandbox:`,
      ),
    /auxiliary topology is missing its media role/u,
  );
  assert.throws(
    () =>
      resolveExpectedApiTopologyFromCompose(
        DEFAULT_EXPECTED_API_SERVICES,
        productionComposeSource.replace('services:\n', 'services:\n  ocr-native-sandbox:\n'),
      ),
    /auxiliary topology is ambiguous/u,
  );

  const directory = mkdtempSync(join(tmpdir(), 'maxim-capacity-manifest-'));
  const manifestPath = join(directory, 'current.json');
  writeFileSync(manifestPath, JSON.stringify(currentReleaseManifest()));
  assert.deepEqual(readExpectedApiImage(manifestPath), expectedApiImage);
  const runtimeRollbackImage = {
    ...expectedApiImage,
    imageRef: `maxim-api:runtime-rollback-${apiImageSha}`,
  };
  writeFileSync(manifestPath, JSON.stringify(currentReleaseManifest(runtimeRollbackImage)));
  assert.deepEqual(readExpectedApiImage(manifestPath), runtimeRollbackImage);
  const digestImage = {
    ...expectedApiImage,
    imageRef: `registry.example/maxim-api@sha256:${'7'.repeat(64)}`,
  };
  writeFileSync(manifestPath, JSON.stringify(currentReleaseManifest(digestImage)));
  assert.deepEqual(readExpectedApiImage(manifestPath), digestImage);
  writeFileSync(
    manifestPath,
    JSON.stringify(
      currentReleaseManifest({
        ...expectedApiImage,
        imageRef: `maxim-api:${'c'.repeat(40)}`,
      }),
    ),
  );
  assert.throws(() => readExpectedApiImage(manifestPath), /identity is invalid/u);
  const partial = currentReleaseManifest();
  delete partial.components['admin-static'];
  writeFileSync(manifestPath, JSON.stringify(partial));
  assert.throws(() => readExpectedApiImage(manifestPath), /incomplete or invalid/u);
  writeFileSync(manifestPath, JSON.stringify({ ...currentReleaseManifest(), schemaVersion: 2 }));
  assert.throws(() => readExpectedApiImage(manifestPath), /incomplete or invalid/u);
});

test('API fleet manifest reader rejects coerced component identities', () => {
  const directory = mkdtempSync(join(tmpdir(), 'maxim-capacity-typed-manifest-'));
  const manifestPath = join(directory, 'current.json');
  const manifest = currentReleaseManifest();
  manifest.components.eraser = {
    sourceSha: '1'.repeat(40),
    imageRef: `maxim-eraser:${'1'.repeat(40)}`,
    imageId: `sha256:${'2'.repeat(64)}`,
  };
  writeFileSync(manifestPath, JSON.stringify(manifest));
  assert.deepEqual(readExpectedApiImage(manifestPath), expectedApiImage);
  for (const id of Object.keys(manifest.components)) {
    for (const field of ['sourceSha', 'imageRef', 'imageId']) {
      const invalid = structuredClone(manifest);
      invalid.components[id][field] = [invalid.components[id][field]];
      writeFileSync(manifestPath, JSON.stringify(invalid));
      assert.throws(
        () => readExpectedApiImage(manifestPath),
        /incomplete or invalid/u,
        `${id}: ${field} must be a string`,
      );
    }
  }
});

test('capacity probe resolves its sibling helper when executed through node stdin', () => {
  const result = spawnSync(process.execPath, ['-', 'invalid/device'], {
    cwd: root,
    input: readFileSync(probePath, 'utf8'),
    encoding: 'utf8',
  });
  assert.equal(result.status, 1, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    schemaVersion: 1,
    observedAt: JSON.parse(result.stdout).observedAt,
    unavailable: true,
  });
});

test('alert windows require continuous samples and expose every requested outcome', () => {
  const high = minuteSamples('2026-09-02T12:00:00.000Z', 6, {
    host: {
      load1: 12,
      cpuIowaitPct: 35,
      memoryAvailableBytes: 2 * 1024 ** 3,
      swapInPagesPerSec: 2,
      swapUsedBytes: 1024 ** 3,
      disk: { utilPct: 99 },
    },
  });
  const result = evaluateAlerts(high.slice(0, -1), high.at(-1));
  assert.equal(result.alerts.load_per_cpu_warning_5m.outcome, 'firing');
  assert.equal(result.alerts.load_per_cpu_critical_2m.outcome, 'firing');
  assert.equal(result.alerts.iowait_warning_5m.outcome, 'firing');
  assert.equal(result.alerts.iowait_critical_2m.outcome, 'firing');
  assert.equal(result.alerts.swap_in_sustained_5m.outcome, 'firing');
  assert.equal(result.alerts.swap_used_10pct_5m.outcome, 'firing');
  assert.equal(result.alerts.memory_available_warning_5m.outcome, 'firing');
  assert.equal(result.alerts.memory_available_critical_2m.outcome, 'firing');
  assert.equal(result.alerts.disk_util_warning_5m.outcome, 'firing');
  assert.equal(result.alerts.disk_util_critical_2m.outcome, 'firing');
  assert.equal(result.alerts.disk_free_40gib.outcome, 'clear');
  assert.equal(result.alerts.readiness.outcome, 'clear');
  assert.equal(result.alerts.queue_metrics.outcome, 'clear');
  assert.equal(result.alerts.queue_lag_warning.outcome, 'clear');
  assert.equal(result.alerts.queue_fence.outcome, 'clear');
  assert.equal(result.overallStatus, 'critical');

  const gap = [high[0], high.at(-1)];
  assert.equal(
    evaluateAlerts(gap.slice(0, -1), gap.at(-1)).alerts.iowait_warning_5m.outcome,
    'pending',
  );

  const unknown = normalizeSnapshot(
    sample('2026-09-02T12:03:00.000Z', { host: { cpuIowaitPct: null } }),
  );
  const interrupted = [...high.slice(0, 3), unknown, ...high.slice(4)];
  assert.equal(
    evaluateAlerts(interrupted.slice(0, -1), interrupted.at(-1)).alerts.iowait_warning_5m.outcome,
    'pending',
  );
});

test('immediate readiness, queue, fallback, mode, fence, and disk alerts fail closed', () => {
  const current = normalizeSnapshot(
    sample('2026-09-02T12:00:00.000Z', {
      host: { disk: { availableBytes: 39 * 1024 ** 3 } },
      readiness: {
        httpStatus: 503,
        ok: false,
        rawOk: false,
        queueOk: false,
        softWarning: true,
        softWarningCode: 'stale-ready-fallback',
        queueLagSec: 31,
        mode: 'degrade',
        condition: 'mixed',
        burstActive: true,
      },
      queueFence: { pausedCount: 24, ownerPresent: true },
      apiFleet: {
        runningRoleCount: 12,
        identityRoleCount: 12,
        exactImageRoleCount: 12,
        duplicateContainerCount: 1,
        unexpectedApiContainerCount: 1,
        unexpectedMainContainerCount: 1,
        totalRestartCount: 2,
      },
    }),
  );
  const result = evaluateAlerts([], current);
  for (const id of [
    'disk_free_40gib',
    'readiness',
    'readiness_fallback',
    'queue_metrics',
    'system_mode',
    'queue_backlog_mode',
    'max_api_mode',
    'queue_lag_warning',
    'queue_lag_critical',
    'queue_fence',
    'api_fleet_topology',
  ]) {
    assert.equal(result.alerts[id].outcome, 'firing', id);
  }
  assert.equal(result.alerts.api_fleet_restarts.outcome, 'unknown');
  assert.equal(result.overallStatus, 'critical');

  const lagHysteresis = normalizeSnapshot(
    sample('2026-09-02T12:00:00.000Z', {
      readiness: {
        rawOk: false,
        queueOk: true,
        softWarning: true,
        softWarningCode: 'queue-lag-hysteresis',
        queueLagSec: 12,
      },
    }),
  );
  const lagHysteresisAlerts = evaluateAlerts([], lagHysteresis).alerts;
  assert.equal(lagHysteresisAlerts.readiness.outcome, 'clear');
  assert.equal(lagHysteresisAlerts.readiness_fallback.outcome, 'clear');
  assert.equal(lagHysteresisAlerts.queue_metrics.outcome, 'clear');
  assert.equal(lagHysteresisAlerts.queue_lag_warning.outcome, 'firing');
  assert.equal(lagHysteresisAlerts.queue_lag_critical.outcome, 'clear');

  const malformedSoftWarning = normalizeSnapshot(
    sample('2026-09-02T12:00:00.000Z', {
      readiness: { softWarning: true, softWarningCode: 'none' },
    }),
  );
  assert.equal(
    evaluateAlerts([], malformedSoftWarning).alerts.readiness_fallback.outcome,
    'unknown',
  );
  assert.equal(evaluateAlerts([], malformedSoftWarning).alerts.queue_metrics.outcome, 'unknown');

  const stabilizing = normalizeSnapshot(
    sample('2026-09-02T12:00:00.000Z', {
      readiness: { mode: 'degrade', condition: 'stabilizing', burstActive: true },
    }),
  );
  assert.equal(evaluateAlerts([], stabilizing).alerts.stabilizing_mode.outcome, 'firing');

  const manualNormal = normalizeSnapshot(
    sample('2026-09-02T12:00:00.000Z', {
      readiness: { mode: 'normal', condition: 'manual', burstActive: false },
    }),
  );
  const manualResult = evaluateAlerts([], manualNormal);
  assert.equal(manualResult.alerts.system_mode.outcome, 'firing');
  assert.equal(manualResult.alerts.system_mode.threshold, 'auto-normal/no-burst');
  assert.equal(manualResult.overallStatus, 'warning');

  const incompleteFence = normalizeSnapshot(
    sample('2026-09-02T12:00:00.000Z', { queueFence: { queueCount: 23 } }),
  );
  assert.equal(evaluateAlerts([], incompleteFence).alerts.queue_fence.outcome, 'firing');

  const unavailableFleet = normalizeSnapshot(
    sample('2026-09-02T12:00:00.000Z', { apiFleet: { available: false } }),
  );
  assert.equal(evaluateAlerts([], unavailableFleet).alerts.api_fleet_topology.outcome, 'firing');
  assert.equal(evaluateAlerts([], unavailableFleet).alerts.api_fleet_restarts.outcome, 'unknown');

  for (const expectedRoleCount of [11, 12, 13]) {
    const historicalFleet = normalizeSnapshot(
      sample('2026-09-02T12:00:00.000Z', {
        apiFleet: {
          expectedRoleCount,
          observedRoleCount: expectedRoleCount,
          singletonRoleCount: expectedRoleCount,
          runningRoleCount: expectedRoleCount,
          identityRoleCount: expectedRoleCount,
          exactImageRoleCount: expectedRoleCount,
        },
      }),
    );
    assert.equal(evaluateAlerts([], historicalFleet).alerts.api_fleet_topology.outcome, 'clear');
  }
});

test('archive is private, atomic, rotated, bounded, and excludes unknown input fields', () => {
  const directory = mkdtempSync(join(tmpdir(), 'maxim-capacity-archive-'));
  const old = join(directory, 'capacity-20260818T11.jsonl');
  const unrelated = join(directory, 'operator-note.txt');
  writeFileSync(old, '{}\n');
  writeFileSync(unrelated, 'preserve\n');

  const first = archiveAt(directory, sample('2026-09-02T12:00:00.000Z'));
  const second = archiveAt(directory, sample('2026-09-02T12:01:00.000Z'));
  const path = join(directory, second.filename);
  const content = readFileSync(path, 'utf8');

  assert.equal(RETENTION_DAYS, 14);
  assert.equal(MAX_ARCHIVE_HOURS, 337);
  assert.equal(MAX_RECORDS_PER_HOUR, 240);
  assert.equal(first.filename, archiveFilename(first.sample.observedAt));
  assert.equal(content.trim().split('\n').length, 2);
  assert.doesNotMatch(
    content,
    /must-not-survive|token|payload|secret|botId|sha256:[0-9a-f]{64}|maxim-api:(?:runtime-rollback-)?[0-9a-f]{40}/u,
  );
  assert.equal(lstatSync(directory).mode & 0o777, 0o700);
  assert.equal(lstatSync(path).mode & 0o777, 0o600);
  assert.equal(existsSync(old), false);
  assert.equal(readFileSync(unrelated, 'utf8'), 'preserve\n');
  assert.equal(
    readdirSync(directory).some((name) => name.includes('.tmp-')),
    false,
  );
});

test('archive rejects an existing non-private directory without changing its mode', () => {
  const directory = mkdtempSync(join(tmpdir(), 'maxim-capacity-public-'));
  chmodSync(directory, 0o755);
  assert.throws(
    () => archiveAt(directory, sample('2026-09-02T12:00:00.000Z')),
    /private to its owner/u,
  );
  assert.equal(lstatSync(directory).mode & 0o777, 0o755);
});

test('archive rejects a symlink directory and CLI prints explicit alert outcomes without jq', () => {
  const parent = mkdtempSync(join(tmpdir(), 'maxim-capacity-symlink-'));
  const target = join(parent, 'target');
  const link = join(parent, 'link');
  writeFileSync(target, 'not-a-directory');
  symlinkSync(target, link);
  assert.throws(() => archiveAt(link, sample('2026-09-02T12:00:00.000Z')), /real directory/u);

  const directory = mkdtempSync(join(tmpdir(), 'maxim-capacity-cli-'));
  const result = spawnSync(process.execPath, [archivePath, '--archive-dir', directory], {
    input: JSON.stringify(sample(new Date().toISOString())),
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /capacity-summary status=warning/u);
  assert.match(result.stdout, /capacity-alert id=api_fleet_restarts outcome=unknown/u);
  assert.match(result.stdout, /capacity-alert id=ocr_native_restarts outcome=unknown/u);
  assert.match(result.stdout, /capacity-alert id=photo_native_restarts outcome=unknown/u);
  assert.match(result.stdout, /capacity-action available=true windowSec=60 total=1659/u);
  assert.match(
    result.stdout,
    /capacity-api-fleet available=true expected=14 observed=14 singleton=14 running=14 identity=14 exactImage=14 duplicates=0 unexpected=0 unexpectedMain=0 unexpectedScale=0 unexpectedManual=0 restarts=0/u,
  );
  assert.match(result.stdout, /capacity-alert id=load_per_cpu_warning_5m outcome=clear/u);
  assert.match(result.stdout, /capacity-alert id=iowait_warning_5m outcome=clear/u);
  assert.match(result.stdout, /capacity-alert id=disk_util_critical_2m outcome=clear/u);
  assert.match(result.stdout, /capacity-alert id=queue_lag_critical outcome=clear/u);
  assert.doesNotMatch(readFileSync(archivePath, 'utf8'), /\bjq\b/u);
});

test('archive rejects remote clock jumps and preserves calendar-invalid reserved names', () => {
  const directory = mkdtempSync(join(tmpdir(), 'maxim-capacity-clock-'));
  const invalidName = join(directory, 'capacity-20269999T99.jsonl');
  writeFileSync(invalidName, 'operator-owned\n');
  assert.throws(
    () =>
      archiveSnapshot(sample('2026-09-03T12:00:00.000Z'), {
        directory,
        nowMs: Date.parse('2026-09-02T12:00:00.000Z'),
      }),
    /archive clock/u,
  );
  archiveAt(directory, sample('2026-09-02T12:00:00.000Z'));
  assert.equal(readFileSync(invalidName, 'utf8'), 'operator-owned\n');
});

test('archive trims the boundary hour to an exact 14-day retention window', () => {
  const directory = mkdtempSync(join(tmpdir(), 'maxim-capacity-boundary-'));
  const boundary = join(directory, 'capacity-20260819T12.jsonl');
  const record = (observedAt) =>
    JSON.stringify({
      schemaVersion: 1,
      sample: normalizeSnapshot(sample(observedAt)),
      alerts: {},
      overallStatus: 'ok',
    });
  writeFileSync(
    boundary,
    `${record('2026-08-19T12:00:00.000Z')}\n${record('2026-08-19T12:45:00.000Z')}\n`,
  );

  archiveSnapshot(sample('2026-09-02T12:30:00.000Z'), {
    directory,
    nowMs: Date.parse('2026-09-02T12:30:00.000Z'),
  });
  const retained = readFileSync(boundary, 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(
    retained.map((item) => item.sample.observedAt),
    ['2026-08-19T12:45:00.000Z'],
  );
});

test('archive fails closed without rewriting a malformed owned hour', () => {
  const directory = mkdtempSync(join(tmpdir(), 'maxim-capacity-malformed-'));
  const path = join(directory, 'capacity-20260902T12.jsonl');
  writeFileSync(path, '{malformed}\n');
  assert.throws(() => archiveAt(directory, sample('2026-09-02T12:01:00.000Z')), /archive record/u);
  assert.equal(readFileSync(path, 'utf8'), '{malformed}\n');
  assert.equal(
    readdirSync(directory).some((name) => name.includes('.tmp-')),
    false,
  );
});

test('archive rewrites prior alerts without preserving free-form values', () => {
  const directory = mkdtempSync(join(tmpdir(), 'maxim-capacity-alert-value-'));
  const observedAt = '2026-09-02T12:00:00.000Z';
  const path = join(directory, archiveFilename(observedAt));
  writeFileSync(
    path,
    `${JSON.stringify({
      schemaVersion: 1,
      sample: normalizeSnapshot(sample(observedAt)),
      alerts: {
        iowait_warning_5m: {
          outcome: 'firing',
          severity: 'warning',
          threshold: 15,
          windowSec: 300,
          value: 'private_token',
          sustainedForSec: 300,
        },
      },
      overallStatus: 'warning',
    })}\n`,
  );

  archiveAt(directory, sample('2026-09-02T12:01:00.000Z'));
  const records = readFileSync(path, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(records[0].alerts.iowait_warning_5m.value, null);
  assert.doesNotMatch(JSON.stringify(records), /private_token/u);
});

test('legacy snapshots classify a missing system condition as unknown without preserving reason', () => {
  const raw = sample('2026-09-02T12:00:00.000Z');
  delete raw.readiness.condition;
  delete raw.readiness.action;
  delete raw.apiFleet;
  raw.readiness.reason = 'private MAX diagnostic';
  const normalized = normalizeSnapshot(raw);
  const alerts = evaluateAlerts([], normalized).alerts;
  assert.equal(normalized.readiness.condition, 'unknown');
  assert.equal(normalized.readiness.action, null);
  assert.equal(normalized.apiFleet.available, null);
  assert.equal(alerts.queue_backlog_mode.outcome, 'unknown');
  assert.equal(alerts.max_api_mode.outcome, 'unknown');
  assert.equal(alerts.stabilizing_mode.outcome, 'unknown');
  assert.equal(alerts.api_fleet_topology.outcome, 'unknown');
  assert.equal(alerts.api_fleet_restarts.outcome, 'unknown');
  assert.doesNotMatch(JSON.stringify(normalized), /private MAX diagnostic|reason/u);
});

test('raw monitor logs are exclusive, private, and ephemeral by default', () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'maxim-monitor-log-root-'));
  const ephemeral = runMonitorLogHarness('', tempRoot);
  assert.equal(ephemeral.status, 0, ephemeral.stderr);
  assert.match(ephemeral.stdout, /mode=600/u);
  const ephemeralPath = /^path=(.+)$/mu.exec(ephemeral.stdout)?.[1];
  assert.ok(ephemeralPath);
  assert.equal(existsSync(ephemeralPath), false);
  assert.deepEqual(readdirSync(tempRoot), []);

  const privateDirectory = mkdtempSync(join(tmpdir(), 'maxim-monitor-log-private-'));
  const retainedPath = join(privateDirectory, 'retained.log');
  const retained = runMonitorLogHarness(retainedPath, tempRoot);
  assert.equal(retained.status, 0, retained.stderr);
  assert.match(retained.stdout, /mode=600/u);
  assert.equal(readFileSync(retainedPath, 'utf8'), 'private monitor line\n');

  const existing = runMonitorLogHarness(retainedPath, tempRoot);
  assert.notEqual(existing.status, 0);
  assert.equal(readFileSync(retainedPath, 'utf8'), 'private monitor line\n');

  const publicDirectory = mkdtempSync(join(tmpdir(), 'maxim-monitor-log-public-'));
  chmodSync(publicDirectory, 0o755);
  const rejectedPath = join(publicDirectory, 'rejected.log');
  const rejected = runMonitorLogHarness(rejectedPath, tempRoot);
  assert.notEqual(rejected.status, 0);
  assert.equal(existsSync(rejectedPath), false);
});

test('capacity scheduler keeps its cadence through diagnostics beyond the nominal deadline', () => {
  const harness = [
    'set -euo pipefail',
    'clock=100',
    'CAPACITY_INTERVAL_SEC=15',
    'MAXIM_MONITOR_CAPACITY_OWNER_START_TICKS=123',
    'read_capacity_owner_start_ticks() { printf "123\\n"; }',
    'capacity_samples=0',
    'date() { [[ "$1" == "+%s" ]] && printf "%s\\n" "$clock"; }',
    'sleep() { (($1 > 0)) || return 99; clock=$((clock + $1)); }',
    'kill() { ((clock < 206)); }',
    'flock() { return 0; }',
    'sample_capacity_once() {',
    '  capacity_samples=$((capacity_samples + 1))',
    '  printf "sample=%s\\n" "$clock"',
    '}',
    shellFunction('is_positive_integer'),
    shellFunction('run_capacity_sampler'),
    'run_capacity_sampler 42 146 9',
    'printf "samples=%s clock=%s\\n" "$capacity_samples" "$clock"',
  ].join('\n');
  const result = spawnSync('bash', ['-c', harness], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    result.stdout,
    'sample=100\nsample=115\nsample=130\nsample=145\nsample=160\nsample=175\nsample=190\nsample=205\nsamples=8 clock=206\n',
  );
  assert.doesNotMatch(shellFunction('sample_once'), /capacity-observability/u);
  assert.doesNotMatch(shellFunction('run_monitor'), /sample_capacity|capacity-observability/u);
  const wrapper = shellFunction('run_monitor_with_capacity_sampler');
  assert.ok(wrapper.indexOf('start_capacity_sampler') < wrapper.indexOf('start_monitor_worker'));
  assert.ok(
    wrapper.indexOf('start_monitor_worker') < wrapper.indexOf('wait "$MONITOR_WORKER_PID"'),
  );
});

test('a slow capacity probe keeps one owner without overlapping or catch-up bursts', () => {
  const harness = [
    'set -euo pipefail',
    'clock=100',
    'CAPACITY_INTERVAL_SEC=15',
    'MAXIM_MONITOR_CAPACITY_OWNER_START_TICKS=123',
    'read_capacity_owner_start_ticks() { printf "123\\n"; }',
    'date() { [[ "$1" == "+%s" ]] && printf "%s\\n" "$clock"; }',
    'sleep() { (($1 > 0)) || return 99; clock=$((clock + $1)); }',
    'kill() { ((clock < 190)); }',
    'flock() { return 0; }',
    'sample_capacity_once() { printf "sample=%s\\n" "$clock"; clock=$((clock + 20)); }',
    shellFunction('is_positive_integer'),
    shellFunction('run_capacity_sampler'),
    'run_capacity_sampler 42 110 9',
    'printf "finished=%s\\n" "$clock"',
  ].join('\n');
  const result = spawnSync('bash', ['-c', harness], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'sample=100\nsample=135\nsample=170\nfinished=190\n');
});

test('capacity sampler stops when its PID belongs to another owner generation', () => {
  const harness = [
    'set -euo pipefail',
    'clock=100',
    'CAPACITY_INTERVAL_SEC=15',
    'MAXIM_MONITOR_CAPACITY_OWNER_START_TICKS=123',
    'date() { [[ "$1" == "+%s" ]] && printf "%s\\n" "$clock"; }',
    'sleep() { clock=$((clock + $1)); }',
    'kill() { return 0; }',
    'read_capacity_owner_start_ticks() { if ((clock < 130)); then printf "123\\n"; else printf "456\\n"; fi; }',
    'flock() { return 0; }',
    'sample_capacity_once() { printf "sample=%s\\n" "$clock"; }',
    shellFunction('is_positive_integer'),
    shellFunction('run_capacity_sampler'),
    'run_capacity_sampler 42 110 9',
    'printf "finished=%s\\n" "$clock"',
  ].join('\n');
  const result = spawnSync('bash', ['-c', harness], { encoding: 'utf8', timeout: 5000 });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'sample=100\nsample=115\nfinished=130\n');
});

test('capacity owner generation reader handles comm delimiters and newlines and refuses missing processes', () => {
  const harness = [
    'set -euo pipefail',
    shellFunction('is_positive_integer'),
    shellFunction('read_capacity_owner_start_ticks'),
    'owner_pid=$BASHPID',
    'ticks="$(read_capacity_owner_start_ticks "$owner_pid")"',
    '[[ "$ticks" =~ ^[1-9][0-9]*$ ]]',
    'printf "a) \\nb) c\\n" >"/proc/$owner_pid/comm"',
    '[[ "$(read_capacity_owner_start_ticks "$owner_pid")" == "$ticks" ]]',
    'if read_capacity_owner_start_ticks 0; then exit 90; fi',
    'if read_capacity_owner_start_ticks 999999999; then exit 91; fi',
    'printf "owner_generation_validated\\n"',
  ].join('\n');
  const result = spawnSync('bash', ['-c', harness], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'owner_generation_validated\n');
});

test('occupied capacity lock fails before the heavy monitor worker starts', () => {
  const directory = mkdtempSync(join(tmpdir(), 'maxim-capacity-lock-contention-'));
  const harness = [
    'set -euo pipefail',
    'DURATION_SEC=60',
    'ROOT_DIR=/unused',
    'CAPACITY_SAMPLER_PID=""',
    'CAPACITY_SAMPLER_LOCK_FD=""',
    'CAPACITY_SAMPLER_LOCK_FILE="$1"',
    'MONITOR_WORKER_PID=""',
    'worker_started=0',
    'exec {MONITOR_LOCK_FD}>"$2"',
    'exec {held_lock_fd}>>"$CAPACITY_SAMPLER_LOCK_FILE"',
    'flock -n "$held_lock_fd"',
    shellFunction('is_positive_integer'),
    shellFunction('read_capacity_owner_start_ticks'),
    shellFunction('start_capacity_sampler'),
    shellFunction('stop_capacity_sampler'),
    shellFunction('run_monitor_with_capacity_sampler'),
    'start_monitor_worker() { worker_started=1; }',
    'if run_monitor_with_capacity_sampler; then status=0; else status=$?; fi',
    'printf "status=%s worker=%s\\n" "$status" "$worker_started"',
  ].join('\n');
  const result = spawnSync(
    'bash',
    [
      '-c',
      harness,
      'capacity-lock-harness',
      join(directory, 'capacity.lock'),
      join(directory, 'monitor.lock'),
    ],
    { encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /Another capacity sampler already holds/u);
  assert.match(result.stdout, /status=3 worker=0/u);
});

test('failed heavy-worker start reaps the capacity sampler and preserves failure status', () => {
  const harness = [
    'set -euo pipefail',
    'DURATION_SEC=60',
    'CAPACITY_SAMPLER_PID=""',
    'CAPACITY_SAMPLER_LOCK_FD=""',
    'MONITOR_WORKER_PID=""',
    shellFunction('stop_capacity_sampler'),
    shellFunction('run_monitor_with_capacity_sampler'),
    'sampler_file="$1"',
    'start_capacity_sampler() {',
    '  setsid sleep 30 &',
    '  CAPACITY_SAMPLER_PID=$!',
    '  printf "%s\\n" "$CAPACITY_SAMPLER_PID" > "$sampler_file"',
    '}',
    'start_monitor_worker() { return 29; }',
    'if run_monitor_with_capacity_sampler; then status=0; else status=$?; fi',
    'sampler_pid="$(<"$sampler_file")"',
    'printf "status=%s sampler_alive=%s\\n" "$status" "$(kill -0 "$sampler_pid" 2>/dev/null && echo yes || echo no)"',
  ].join('\n');
  const directory = mkdtempSync(join(tmpdir(), 'maxim-worker-start-failure-'));
  const result = spawnSync(
    'bash',
    ['-c', harness, 'worker-start-harness', join(directory, 'sampler.pid')],
    { encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'status=29 sampler_alive=no\n');
});

test('capacity sampler cleanup terminates and reaps its isolated process group', async () => {
  const harness = [
    'set -euo pipefail',
    'child_file="$1"',
    'CAPACITY_SAMPLER_LOCK_FD=""',
    'setsid bash -c \'sleep 30 & printf "%s\\n" "$!" > "$1"; wait\' sampler "$child_file" &',
    'CAPACITY_SAMPLER_PID=$!',
    'for _ in $(seq 1 100); do [[ -s "$child_file" ]] && break; sleep 0.01; done',
    '[[ -s "$child_file" ]]',
    'sampler_pid="$CAPACITY_SAMPLER_PID"',
    'child_pid="$(<"$child_file")"',
    shellFunction('stop_capacity_sampler'),
    'stop_capacity_sampler',
    'printf "sampler=%s child=%s\\n" "$sampler_pid" "$child_pid"',
  ].join('\n');
  const directory = mkdtempSync(join(tmpdir(), 'maxim-capacity-sampler-stop-'));
  const result = spawnSync(
    'bash',
    ['-c', harness, 'capacity-stop-harness', join(directory, 'pid')],
    {
      encoding: 'utf8',
    },
  );
  assert.equal(result.status, 0, result.stderr);
  const match = /^sampler=(\d+) child=(\d+)$/mu.exec(result.stdout);
  assert.ok(match, result.stdout);
  const pids = match.slice(1).map(Number);
  await waitForCondition(() => pids.every((pid) => !isProcessAlive(pid)), 2_000);
});

test('monitor entrypoint composes sampler and ephemeral-log cleanup without losing status', async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'maxim-monitor-lifecycle-log-'));
  const processRoot = mkdtempSync(join(tmpdir(), 'maxim-monitor-lifecycle-process-'));
  const { childFile, result, samplerFile } = runMonitorLifecycleHarness(tempRoot, processRoot, 37);
  assert.equal(result.status, 37, result.stderr);
  const ephemeralPath = /^path=(.+)$/mu.exec(result.stdout)?.[1];
  assert.ok(ephemeralPath);
  assert.equal(existsSync(ephemeralPath), false);
  const pids = [samplerFile, childFile].map((path) => Number(readFileSync(path, 'utf8').trim()));
  await waitForCondition(() => pids.every((pid) => !isProcessAlive(pid)), 2_000);
  const wrapper = shellFunction('run_monitor_with_capacity_sampler');
  assert.doesNotMatch(wrapper, /trap (cleanup_monitor|stop_capacity_sampler) EXIT/u);
  assert.match(monitorSource, /trap cleanup_monitor EXIT/u);
  assert.match(monitorSource, /start_monitor_output[\s\S]*if run_monitor_with_capacity_sampler/u);
});

test('TERM to only the top-level monitor PID reaps every worker and ephemeral log', async () => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'maxim-monitor-term-fixture-'));
  const scriptsDirectory = join(fixtureRoot, 'infra/scripts');
  const libraryDirectory = join(scriptsDirectory, 'lib');
  const binaryDirectory = join(fixtureRoot, 'bin');
  const processFile = join(fixtureRoot, 'processes.txt');
  const teeFile = join(fixtureRoot, 'tee.pid');
  const monitorLock = join(fixtureRoot, 'monitor.lock');
  mkdirSync(libraryDirectory, { recursive: true });
  mkdirSync(binaryDirectory, { recursive: true });
  writeFileSync(
    join(libraryDirectory, 'deploy-topology.sh'),
    'MAXIM_PRODUCTION_API_SERVICES=("api-ingress")\n',
  );
  writeFileSync(
    join(libraryDirectory, 'deploy-disk-capacity.sh'),
    'MAXIM_API_BUILD_HARD_MIN_FREE_BYTES=10737418240\n',
  );
  writeFileSync(join(scriptsDirectory, 'monitor-capacity-probe.cjs'), '// fixture\n');
  writeFileSync(join(scriptsDirectory, 'monitor-capacity-archive.cjs'), '// fixture\n');
  writeExecutable(join(scriptsDirectory, 'vps-monitor-readonly.sh'), monitorSource);
  writeExecutable(
    join(scriptsDirectory, 'vps-connect.sh'),
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'sleep 30 &',
      'child_pid=$!',
      'process_group="$(ps -o pgid= -p "$$" | tr -d "[:space:]")"',
      'printf "%s %s %s\\n" "$$" "$child_pid" "$process_group" >> "$MAXIM_TEST_PROCESS_FILE"',
      'wait "$child_pid"',
    ].join('\n'),
  );
  const systemTee = spawnSync('sh', ['-c', 'command -v tee'], { encoding: 'utf8' }).stdout.trim();
  assert.ok(systemTee.startsWith('/'));
  writeExecutable(
    join(binaryDirectory, 'tee'),
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'printf "%s\\n" "$$" > "$MAXIM_TEST_TEE_FILE"',
      `exec ${systemTee} "$@"`,
    ].join('\n'),
  );

  const environment = {
    ...process.env,
    HOME: fixtureRoot,
    MAXIM_MONITOR_CAPACITY_ARCHIVE_DIR: join(fixtureRoot, 'archive'),
    MAXIM_MONITOR_LOCK_FILE: monitorLock,
    MAXIM_TEST_PROCESS_FILE: processFile,
    MAXIM_TEST_TEE_FILE: teeFile,
    PATH: `${binaryDirectory}:${process.env.PATH}`,
    TMPDIR: fixtureRoot,
    XDG_STATE_HOME: join(fixtureRoot, 'state'),
  };
  delete environment.MAXIM_MONITOR_LOG;
  const monitor = spawn(join(scriptsDirectory, 'vps-monitor-readonly.sh'), ['60', '300'], {
    cwd: fixtureRoot,
    env: environment,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  monitor.stdout.on('data', (chunk) => {
    stdout += chunk.toString('utf8');
  });
  monitor.stderr.on('data', (chunk) => {
    stderr += chunk.toString('utf8');
  });

  try {
    await waitForCondition(
      () =>
        /^log_file=.+$/mu.test(stdout) &&
        recordedProcesses(processFile).length >= 6 &&
        existsSync(teeFile),
      2_000,
    );
    const startedAt = Date.now();
    monitor.kill('SIGTERM');
    const result = await waitForClose(monitor, 2_000);
    assert.deepEqual(result, { code: 143, signal: null }, stderr);
    assert.ok(Date.now() - startedAt < 2_000, 'top-level TERM must be bounded');
    const ephemeralPath = /^log_file=(.+)$/mu.exec(stdout)?.[1];
    assert.ok(ephemeralPath);
    assert.equal(existsSync(ephemeralPath), false);
    assert.equal(existsSync(dirname(ephemeralPath)), false);
    const recordedPids = [...recordedProcesses(processFile), ...recordedProcesses(teeFile)];
    await waitForCondition(() => recordedPids.every((pid) => !isProcessAlive(pid)), 2_000);
    for (const pid of recordedPids) {
      assert.equal(isProcessAlive(pid), false, `monitor process ${pid} survived top-level TERM`);
    }
    const lockProbe = spawnSync(
      'bash',
      ['-c', 'exec 9>>"$1"; flock -n 9', 'monitor-lock-probe', monitorLock],
      { encoding: 'utf8' },
    );
    assert.equal(lockProbe.status, 0, lockProbe.stderr);
  } finally {
    if (isProcessAlive(monitor.pid)) monitor.kill('SIGKILL');
    const groups = new Set();
    for (const [index, pid] of recordedProcesses(processFile).entries()) {
      if (index % 3 === 2) groups.add(pid);
    }
    for (const processGroup of groups) {
      try {
        process.kill(-processGroup, 'SIGKILL');
      } catch {
        // The expected path already reaped the group.
      }
    }
    for (const pid of [...recordedProcesses(processFile), ...recordedProcesses(teeFile)]) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // The expected path already reaped the process.
      }
    }
  }
});

test('readonly monitor archives only the allowlisted capacity probe outside raw log capture', () => {
  const monitor = monitorSource;
  const probe = readFileSync(probePath, 'utf8');
  assert.match(monitor, /# shellcheck disable=SC2317,SC2329/u);
  assert.match(monitor, /set -euo pipefail\numask 077/u);
  assert.match(monitor, /run_step capacity-observability summarize_capacity_observability/u);
  assert.match(monitor, /monitor-capacity-probe\.cjs/u);
  assert.match(monitor, /monitor-capacity-archive\.cjs/u);
  assert.match(monitor, /XDG_STATE_HOME/u);
  assert.match(monitor, /\.local\/state/u);
  assert.match(monitor, /retention_days=14/u);
  assert.match(monitor, /MAXIM_MONITOR_CAPACITY_INTERVAL_SEC:-15/u);
  assert.match(monitor, /CAPACITY_INTERVAL_SEC < 15 \|\| CAPACITY_INTERVAL_SEC > 60/u);
  assert.match(monitor, /exec setsid [\s\S]*--internal-capacity-sampler/u);
  assert.match(monitor, /kill -TERM -- "-\$sampler_pid"/u);
  assert.match(monitor, /wait "\$sampler_pid"/u);
  assert.match(monitor, /exec \{MONITOR_LOCK_FD\}>&-/u);
  assert.match(monitor, /flock -n "\$CAPACITY_SAMPLER_LOCK_FD"/u);
  assert.match(monitor, /MAXIM_MONITOR_CAPACITY_ARCHIVE_DIR must be an absolute path/u);
  assert.match(monitor, /read_capacity_stream_snapshot \|\| return \$\?/u);
  assert.match(monitor, /--stream "\$CAPACITY_BLOCK_DEVICE"/u);
  assert.match(monitor, /"\$CAPACITY_BLOCK_DEVICE" "\$\{SERVICES\[@\]\}"/u);
  assert.match(
    monitor,
    /if ! EPHEMERAL_LOG_DIR="\$\([\s\S]*mktemp -d "\$temp_root\/maxim-vps-readonly-monitor-\$\{UID\}\.XXXXXXXX"/u,
  );
  assert.match(monitor, /MAXIM_MONITOR_LOG parent must be owner-private/u);
  assert.match(monitor, /set -o noclobber/u);
  assert.match(monitor, /tee -a "\/dev\/fd\/\$MONITOR_LOG_FD"/u);
  assert.match(monitor, /unlink -- "\$LOG_FILE"/u);
  assert.doesNotMatch(monitor, /maxim-vps-readonly-monitor-\$\(date/u);
  assert.doesNotMatch(monitor, /scan_service_logs[\s\S]*monitor-capacity-archive/u);
  assert.doesNotMatch(monitor, /\bjq\b/u);
  assert.match(probe, /__filename === '\[stdin\]'/u);
  assert.match(probe, /resolve\(process\.cwd\(\), 'infra\/scripts\/monitor-ready-status\.cjs'\)/u);
});

function inspectedPhotoSandbox() {
  const value = photoRuntime();
  value.Id = 'f'.repeat(64);
  value.Image = expectedApiImage.imageId;
  value.Config.Image = expectedApiImage.imageRef;
  value.RestartCount = 0;
  return value;
}

test('photo and OCR auxiliaries are independently attested without changing the API role census', () => {
  const roles = DEFAULT_EXPECTED_API_SERVICES.map((_, index) => inspectedContainer(index));
  const photo = inspectedPhotoSandbox();
  photo.RestartCount = 3;
  const summarize = (values) =>
    summarizeApiFleet(
      DEFAULT_EXPECTED_API_SERVICES,
      expectedApiImage,
      parseApiFleetInspection(JSON.stringify([...roles, inspectedSandbox(80), ...values])),
      'ocr-native-sandbox,photo-native-sandbox',
    );
  assert.equal(summarize([photo]).unexpectedApiContainerCount, 0);
  assert.equal(summarize([photo]).expectedRoleCount, 14);
  assert.equal(summarize([photo]).totalRestartCount, 3);
  assert.equal(summarize([]).unexpectedApiContainerCount, 1);
  for (const mutate of [
    (v) => v.Config.Env.push('PRIVATE_TOKEN=must-not-survive'),
    (v) => {
      v.HostConfig.NetworkMode = 'bridge';
    },
    (v) => {
      v.Mounts[0].RW = false;
    },
    (v) => {
      v.Image = `sha256:${'d'.repeat(64)}`;
    },
    (v) => {
      v.State.Health.Status = 'unhealthy';
    },
    (v) => {
      v.Config.Labels['com.maxim.ocr-native-sandbox'] = 'true';
    },
  ]) {
    const invalid = structuredClone(photo);
    mutate(invalid);
    assert.ok(summarize([invalid]).unexpectedApiContainerCount > 0);
    assert.doesNotMatch(
      JSON.stringify(parseApiFleetInspection(JSON.stringify([invalid]))),
      /must-not-survive/u,
    );
  }
  assert.ok(summarize([photo, { ...photo, Id: 'e'.repeat(64) }]).unexpectedApiContainerCount >= 2);
});
