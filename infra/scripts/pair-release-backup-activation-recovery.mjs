#!/usr/bin/env node
import { constants } from 'node:fs';
import { open, lstat, readFile, readlink, readdir, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';

const execute = promisify(execFile);
const ROOT = '/var/lib/major-karavan-release';
const MAJOR = '/var/www/Chat_bot';
const KARAVAN = '/var/www/max-delivery-platform';
const SCHEDULE = '/mnt/maxim-cold/backups/maxim/.scheduler-v1';
const ERASER_SCHEDULE = '/mnt/maxim-cold/backups/maxim/eraser/.scheduler-v1';
const LOCKS = [
  `${ROOT}/state/admission.lock`,
  '/var/lib/maxim-deploy/deploy.lock',
  `${KARAVAN}/var/ops/karavan-production-operation.lock`,
];
const OWNER = `${ROOT}/state/admission.owner`;
const PRIMITIVE = `${MAJOR}/infra/scripts/pair-release-backup-refusal-recovery.mjs`;
const digest = (value) => createHash('sha256').update(value).digest('hex');
const requireFact = (value, code) => {
  if (!value) throw new Error(code);
};
export const ACTIVATION = Object.freeze({
  sourceSha: '932c81a1b195d2c0464285fc92ecc364cc613779',
  ownerSha256: 'd1cdf926b08aa6ebfad8a1c92dec927eef13ca203c29a6e9b76cda1fd3df8154',
  stateSha256: 'd59770fc8a096cc9d95fb637a1ad1fe20210e1ca2dbf304eba9148754abc1dc8',
  invocationId: '7af37b8a7bab4a6ab480b7f7c519cb49',
  startedAt: '2026-11-03T10:42:05.747Z',
  scriptSha256: '2dede4e25abdca8f1d866b5b17947da314bf2a00e26d1fc4c703a3bd87966b4a',
  primitiveSha256: '73dd7e647328c6c28371e30cb81b04b34078936a8aac3352151d041d0fe4a167',
  environmentSha256: '713f39aafe315e40b8e2a0fcd87c40f192228cd35bef5329f901c73b6289ffd0',
});
const OCR_CONTAINER = Object.freeze({
  id: '5f69399b82fb89ef9e2eb1d7779b48128278a4edc98eb7491c1c65ea349aca4e',
  created: '2026-11-02T22:27:11.07201918Z',
  observedRestartCount: 15,
});
const OCR_ENTRY =
  'apps/api/dist/apps/api/src/moderation/commercial-ocr/native-ocr-sandbox.entrypoint.js';
const UNIT_HASHES = Object.freeze({
  'maxim-postgres-backup.service':
    '5bc019a6f414934b939180e19b570d4f4df30eb7c5a0a060923ddea1819ec1aa',
  'maxim-postgres-backup.timer': '8b0770d707291356d9be5071db9a2716bf21264c656803dde5987aa1d8176bf4',
  'maxim-postgres-backup-retry.service':
    '65c2499abf266c894a0ca929d945b654f888b4bd452511755e5cc73c7774e145',
  'maxim-postgres-backup-retry.timer':
    'aff1ae300658bf2bff17a3fa0989b97ccdb591fd14dedf941d69d559148dbfbb',
  'maxim-postgres-restore-smoke.service':
    'ecfb9732a46a52d9b98091cb990d52b7e8918e82af70cfc6e06392fa4a753197',
  'maxim-postgres-restore-smoke.timer':
    '9924cbae71720125f30efe20469809f10c85cb0f9c3a86c87c45a60a4e3c6fd3',
  'maxim-postgres-backup-health.service':
    'cca24823d855d164614ba00c39ec85e819c9fce477bcad1e0eef6e94dff508d0',
  'maxim-postgres-backup-health.timer':
    '8b7d111b2239fd9aa63874bca91453c0d37984aa86993595a235c75c5e1ee537',
  'maxim-eraser-postgres-backup.service':
    '92ab49eba773fe3d69c6bc96a65c0b5b0dd65fd2e06b283e5394489f662d8031',
  'maxim-eraser-postgres-backup.timer':
    'ceec29d65c5566a5a6c5cf7af9ebd6e226fa48a5999e171f6b0d5e8b753c84d1',
  'maxim-eraser-postgres-backup-retry.service':
    '31e49ba5d00393f281f2c396e46161e2dc7b7b4edb4fd825fd7907d4ca48654a',
  'maxim-eraser-postgres-backup-retry.timer':
    '13bd822934f5320b30ed6c8106ecd7c30ab05cf0ff6c1a6ff57af8ef00e370f0',
  'maxim-eraser-postgres-restore-smoke.service':
    '93ccf275735c10e57172b3ee5070a1abaa948b96902d0a70b698be2a46066516',
  'maxim-eraser-postgres-restore-smoke.timer':
    '032f22d5fe5afabbb4773bd448bd4e5ee694e41e6f1242290d9aaa1e4c4ee4cf',
  'maxim-eraser-postgres-backup-health.service':
    '242a8b0c7d0c91ebfdc4b2a1a125df75b9af286d66f926b68439871d0cc2f33c',
  'maxim-eraser-postgres-backup-health.timer':
    '6dc880084c94acbe3814f17fbe4b5fc29995ae62d1c4adb9be6c91f818ae758b',
});
const ROLES = [
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
  'ocr-native-sandbox',
  'photo-native-sandbox',
  'eraser',
  'postgres',
  'redis',
  'eraser-postgres',
  'eraser-redis',
  'miniapp-major-static',
  'admin-static',
];
const PROPERTIES = [
  'Id',
  'LoadState',
  'ActiveState',
  'SubState',
  'MainPID',
  'ControlPID',
  'ControlGroup',
  'InvocationID',
  'ExecMainCode',
  'ExecMainStatus',
  'ExecMainStartTimestamp',
  'ExecMainExitTimestamp',
  'Result',
  'DropInPaths',
  'FragmentPath',
  'UnitFileState',
  'LastTriggerUSec',
  'NextElapseUSecRealtime',
  'OnFailure',
  'OnSuccess',
  'ExecStart',
  'ExecStartPre',
  'ExecCondition',
  'ExecStartPost',
  'ExecStop',
  'ExecStopPost',
  'WorkingDirectory',
  'EnvironmentFiles',
  'Environment',
  'PassEnvironment',
  'UnsetEnvironment',
  'User',
  'Group',
  'RootDirectory',
  'RootImage',
  'NeedDaemonReload',
];

export function parseBackupActivationRecoveryArgs(args) {
  const [mode, ...rest] = args;
  requireFact(
    ['preview', 'apply'].includes(mode) && rest.length === (mode === 'apply' ? 10 : 8),
    'invalid_arguments',
  );
  const keys = {
    '--owner-sha256': 'ownerSha256',
    '--state-sha256': 'stateSha256',
    '--source-sha': 'sourceSha',
    '--invocation-id': 'invocationId',
    '--proof-sha256': 'proofSha256',
  };
  const request = { mode };
  for (let index = 0; index < rest.length; index += 2) {
    const key = keys[rest[index]];
    requireFact(key && request[key] === undefined, 'invalid_arguments');
    request[key] = rest[index + 1];
  }
  requireFact(
    ['ownerSha256', 'stateSha256', 'sourceSha', 'invocationId'].every(
      (key) => request[key] === ACTIVATION[key],
    ) &&
      (mode === 'preview'
        ? request.proofSha256 === undefined
        : /^[a-f0-9]{64}$/u.test(request.proofSha256 ?? '')),
    'unreviewed_activation_identity',
  );
  return request;
}

function ownerFields(bytes) {
  requireFact(bytes.length > 0 && bytes.length <= 393, 'unexpected_owner_size');
  const rows = bytes
    .toString('utf8')
    .trimEnd()
    .split('\n')
    .map((line) => {
      const at = line.indexOf('=');
      requireFact(at > 0, 'invalid_owner');
      return [line.slice(0, at), line.slice(at + 1)];
    });
  const keys = [
    'protocol',
    'token',
    'product',
    'mode',
    'target',
    'pid',
    'start',
    'boot',
    'cwd',
    'fd',
    'inode',
    'initial_state',
    'started_at',
  ];
  requireFact(
    rows.length === keys.length && rows.every(([key], index) => key === keys[index]),
    'invalid_owner',
  );
  const owner = Object.fromEntries(rows);
  requireFact(
    owner.protocol === 'major-karavan-release-v1' &&
      owner.product === 'major' &&
      owner.mode === 'runtime' &&
      owner.target === '' &&
      owner.cwd === digest(MAJOR) &&
      /^[1-9][0-9]*$/u.test(owner.pid) &&
      /^[0-9]+$/u.test(owner.start) &&
      /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/u.test(owner.boot) &&
      /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/u.test(owner.token) &&
      /^[1-9][0-9]{1,5}$/u.test(owner.fd) &&
      /^[0-9]+:[0-9]+$/u.test(owner.inode) &&
      owner.started_at === ACTIVATION.startedAt &&
      /^[a-f0-9]{64}$/u.test(owner.initial_state),
    'unexpected_owner_scope',
  );
  return owner;
}

function commands(value) {
  return [...value.matchAll(/path=([^;]+); argv\[\]=([^;]+);/gu)].map((match) => [
    match[1].trim(),
    match[2].trim(),
  ]);
}

export function validateActivationUnits(units) {
  requireFact(
    Object.keys(units).sort().join() === Object.keys(UNIT_HASHES).sort().join(),
    'unit_inventory_changed',
  );
  const stable = [];
  for (const [name, expectedHash] of Object.entries(UNIT_HASHES)) {
    const { sha256, uid, mode, properties: p } = units[name];
    requireFact(
      sha256 === expectedHash &&
        uid === 0 &&
        mode === 0o644 &&
        p.Id === name &&
        p.LoadState === 'loaded' &&
        p.FragmentPath === `/etc/systemd/system/${name}` &&
        p.DropInPaths === '' &&
        p.OnFailure === '' &&
        p.OnSuccess === '' &&
        p.NeedDaemonReload === 'no',
      'unit_source_changed',
    );
    const eraser = name.startsWith('maxim-eraser-');
    if (name.endsWith('.timer')) {
      const enabled = eraser && !name.includes('-retry.');
      requireFact(
        p.UnitFileState === (enabled ? 'enabled' : 'disabled') &&
          p.ActiveState === (enabled ? 'active' : 'inactive') &&
          p.SubState === (enabled ? 'waiting' : 'dead') &&
          p.Result === 'success',
        'timer_state_changed',
      );
      if (enabled && !name.includes('-health.'))
        requireFact(
          Date.parse(p.NextElapseUSecRealtime) > Date.now() + 180_000,
          'scheduled_work_too_close',
        );
      if (!enabled)
        requireFact(
          p.LastTriggerUSec === '' && p.NextElapseUSecRealtime === '',
          'unexpected_timer_trigger',
        );
    } else {
      const profile = eraser ? 'eraser' : 'maxim';
      const health = name.includes('-health.');
      requireFact(
        p.MainPID === '0' &&
          p.ControlPID === '0' &&
          p.ControlGroup === '' &&
          p.UnitFileState === 'static' &&
          p.WorkingDirectory === MAJOR &&
          p.EnvironmentFiles ===
            `/etc/maxim-postgres-backup.env (ignore_errors=${health ? 'no' : 'yes'})` &&
          [
            'User',
            'Group',
            'Environment',
            'PassEnvironment',
            'UnsetEnvironment',
            'RootDirectory',
            'RootImage',
            'ExecCondition',
            'ExecStartPost',
            'ExecStop',
            'ExecStopPost',
          ].every((key) => p[key] === ''),
        'service_execution_boundary_changed',
      );
      const pre = [
        ...(eraser
          ? [
              [
                '/usr/bin/test',
                `/usr/bin/test -f ${MAJOR}/infra/scripts/lib/postgres-backup-profile.sh`,
              ],
            ]
          : []),
        [
          '/usr/bin/env',
          `/usr/bin/env MAXIM_BACKUP_PROFILE=${profile} node ${MAJOR}/infra/scripts/postgres-backup-schedule.mjs capability`,
        ],
      ];
      const executable = health
        ? `node ${MAJOR}/infra/scripts/check-postgres-backup-health.mjs`
        : name.includes('restore-smoke')
          ? `${MAJOR}/infra/scripts/restore-postgres-backup-smoke.sh`
          : `${MAJOR}/infra/scripts/postgres-backup-schedule.sh ${name.includes('-retry.') ? 'tick' : 'request'}`;
      requireFact(
        JSON.stringify(commands(p.ExecStartPre)) === JSON.stringify(pre) &&
          JSON.stringify(commands(p.ExecStart)) ===
            JSON.stringify([
              ['/usr/bin/env', `/usr/bin/env MAXIM_BACKUP_PROFILE=${profile} ${executable}`],
            ]),
        'service_command_changed',
      );
      const failed =
        name === 'maxim-postgres-backup.service' || name === 'maxim-postgres-backup-retry.service';
      requireFact(
        p.ActiveState === (failed ? 'failed' : 'inactive') &&
          p.SubState === (failed ? 'failed' : 'dead') &&
          p.Result === (failed ? 'exit-code' : 'success') &&
          p.ExecMainStatus === (failed ? '1' : '0'),
        'service_outcome_changed',
      );
      if (name === 'maxim-postgres-backup-retry.service') {
        requireFact(
          p.InvocationID === ACTIVATION.invocationId &&
            p.ExecMainCode === '1' &&
            Date.parse(p.ExecMainStartTimestamp) === Date.parse('2026-11-03T10:42:07Z') &&
            Date.parse(p.ExecMainExitTimestamp) === Date.parse('2026-11-03T10:42:07Z'),
          'retry_invocation_changed',
        );
      } else if (name === 'maxim-eraser-postgres-backup-health.service') {
        requireFact(
          /^[a-f0-9]{32}$/u.test(p.InvocationID) &&
            p.ExecMainCode === '1' &&
            Number.isFinite(Date.parse(p.ExecMainExitTimestamp)),
          'eraser_health_unproved',
        );
      } else if (p.InvocationID) {
        requireFact(
          Date.parse(p.ExecMainExitTimestamp) < Date.parse(ACTIVATION.startedAt),
          'unexpected_backup_invocation',
        );
      } else
        requireFact(
          p.ExecMainCode === '0' &&
            p.ExecMainStartTimestamp === '' &&
            p.ExecMainExitTimestamp === '',
          'unexpected_service_history',
        );
    }
    stable.push({
      name,
      sha256,
      active: p.ActiveState,
      enabled: p.UnitFileState,
      invocation: name.includes('-health.') ? null : p.InvocationID,
      lastTrigger: name.includes('-health.') ? null : (p.LastTriggerUSec ?? null),
    });
  }
  return stable;
}

function timestampNanos(value) {
  requireFact(typeof value === 'string', 'invalid_runtime_timestamp');
  const match = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.(\d{1,9}))?Z$/u.exec(value);
  requireFact(match, 'invalid_runtime_timestamp');
  const whole = Date.parse(`${match[1]}Z`);
  requireFact(
    Number.isSafeInteger(whole) && new Date(whole).toISOString().slice(0, 19) === match[1],
    'invalid_runtime_timestamp',
  );
  return BigInt(whole) * 1_000_000n + BigInt((match[2] ?? '').padEnd(9, '0'));
}

// FLAG: Only the OCR generation observed in this incident may cross the owner start.
// A timeout lifecycle record corroborates its latest recycle, never all historical restarts.
export function validateActivationOcrRestart(item, evidence, nowMs = Date.now()) {
  requireFact(
    item.id === OCR_CONTAINER.id &&
      item.created === OCR_CONTAINER.created &&
      Number.isSafeInteger(item.restarts) &&
      item.restarts > OCR_CONTAINER.observedRestartCount,
    'unreviewed_ocr_generation',
  );
  const started = timestampNanos(item.started);
  requireFact(
    timestampNanos(item.created) < timestampNanos(ACTIVATION.startedAt) &&
      started > timestampNanos(ACTIVATION.startedAt),
    'unreviewed_ocr_restart',
  );
  requireFact(Number.isSafeInteger(nowMs) && nowMs > 0, 'invalid_observation_clock');
  const now = BigInt(nowMs) * 1_000_000n + 999_999n;
  const container = evidence?.container;
  const state = container?.state;
  requireFact(
    container?.id === item.id &&
      container.created === item.created &&
      container.image === item.image &&
      container.restarts === item.restarts &&
      state?.StartedAt === item.started &&
      state.Status === 'running' &&
      state.Running === true &&
      state.Restarting === false &&
      state.Paused === false &&
      state.Dead === false &&
      state.OOMKilled === false &&
      container.restartPolicy === 'unless-stopped' &&
      JSON.stringify(container.command) === JSON.stringify(['node', OCR_ENTRY]),
    'ocr_process_state_unproved',
  );
  const healthcheck = container.healthcheck;
  requireFact(
    JSON.stringify(healthcheck?.Test) === JSON.stringify(['CMD', 'node', OCR_ENTRY, '--probe']) &&
      healthcheck.Interval === 10_000_000_000 &&
      healthcheck.Timeout === 8_000_000_000 &&
      healthcheck.Retries === 3 &&
      healthcheck.StartPeriod === 20_000_000_000 &&
      state.Health?.Status === 'healthy' &&
      state.Health.FailingStreak === 0 &&
      Array.isArray(state.Health.Log) &&
      state.Health.Log.length > 0 &&
      state.Health.Log.length <= 5,
    'ocr_health_unproved',
  );
  const latestProbe = state.Health.Log.at(-1);
  const probeStart = timestampNanos(latestProbe.Start);
  const probeEnd = timestampNanos(latestProbe.End);
  requireFact(
    latestProbe.ExitCode === 0 &&
      started <= probeStart &&
      probeStart <= probeEnd &&
      probeEnd <= now &&
      now - probeEnd <= 30_000_000_000n,
    'ocr_health_not_fresh',
  );
  const logs = evidence?.logs;
  requireFact(
    typeof logs?.stdout === 'string' &&
      typeof logs.stderr === 'string' &&
      Buffer.byteLength(logs.stdout) + Buffer.byteLength(logs.stderr) < 65_536,
    'ocr_log_observation_capped',
  );
  const lines = `${logs.stdout}\n${logs.stderr}`.split('\n').filter((line) => line !== '');
  requireFact(lines.length > 0 && lines.length < 32, 'ocr_log_observation_capped');
  const lifecycle = [];
  for (const line of lines) {
    const split = line.indexOf(' ');
    requireFact(split > 0, 'ocr_log_timestamp_unproved');
    const timestamp = line.slice(0, split);
    const at = timestampNanos(timestamp);
    requireFact(at >= started - 5_000_000_000n && at < started, 'ocr_log_window_changed');
    const message = line.slice(split + 1);
    let event;
    try {
      event = JSON.parse(message);
    } catch {
      requireFact(!message.includes('native_ocr_sandbox_recycle'), 'ocr_lifecycle_invalid');
      continue;
    }
    if (event?.event === 'native_ocr_sandbox_recycle') lifecycle.push({ timestamp, at, event });
  }
  requireFact(lifecycle.length === 1, 'ocr_timeout_recycle_unproved');
  const { timestamp, at, event } = lifecycle[0];
  const numeric = [
    'queueDepth',
    'pendingBytes',
    'requestedTimeoutMs',
    'executionBudgetMs',
    'queueWaitMs',
    'operationElapsedMs',
  ];
  requireFact(
    event.reason === 'native_timeout' &&
      event.operation === 'recognize' &&
      Object.keys(event).length === 3 + numeric.length &&
      numeric.every((key) => Number.isSafeInteger(event[key]) && event[key] >= 0) &&
      event.requestedTimeoutMs > 0 &&
      event.requestedTimeoutMs <= 10_000 &&
      event.executionBudgetMs > 0 &&
      event.executionBudgetMs <= event.requestedTimeoutMs &&
      at > timestampNanos(ACTIVATION.startedAt),
    'ocr_timeout_recycle_unproved',
  );
  return {
    containerId: item.id,
    createdAt: item.created,
    startedAt: item.started,
    restartCount: item.restarts,
    recycleAt: timestamp,
    lifecycleSha256: digest(JSON.stringify(event)),
    readiness: 'fresh_successful_image_owned_probe',
    attribution: 'latest_timeout_recycle_correlated; historical_restarts_not_attributed',
  };
}

export function validateActivationRuntime(runtime, snapshot, ocrRestart) {
  requireFact(
    runtime.length === ROLES.length &&
      new Set(runtime.map((row) => row.name)).size === ROLES.length &&
      new Set(runtime.map((row) => row.id)).size === ROLES.length,
    'runtime_inventory_changed',
  );
  const components = Object.fromEntries(
    snapshot.major.components.map((value) => [value.id, value]),
  );
  const stable = [];
  for (const role of ROLES) {
    const item = runtime.find((row) => row.name === `/infra-${role}-1`);
    requireFact(
      item &&
        /^[a-f0-9]{64}$/u.test(item.id) &&
        /^sha256:[a-f0-9]{64}$/u.test(item.image) &&
        item.status === 'running' &&
        Number.isFinite(Date.parse(item.created)) &&
        Number.isFinite(Date.parse(item.started)) &&
        Date.parse(item.created) <= Date.parse(item.started) &&
        Date.parse(item.created) < Date.parse(ACTIVATION.startedAt),
      'runtime_generation_changed',
    );
    let restartProof;
    if (Date.parse(item.started) >= Date.parse(ACTIVATION.startedAt)) {
      requireFact(role === 'ocr-native-sandbox', 'runtime_generation_changed');
      restartProof = validateActivationOcrRestart(item, ocrRestart);
    }
    if (['postgres', 'redis', 'eraser-postgres', 'eraser-redis'].includes(role)) {
      const volume = `infra_${role.replaceAll('-', '_')}_data`;
      const destination = role.endsWith('postgres') ? '/var/lib/postgresql/data' : '/data';
      const mounts = item.mounts.filter((mount) => mount.Destination === destination);
      requireFact(
        mounts.length === 1 &&
          mounts[0].Type === 'volume' &&
          mounts[0].Name === volume &&
          mounts[0].Source === `/var/lib/docker/volumes/${volume}/_data` &&
          mounts[0].RW === true,
        'store_mount_changed',
      );
    } else {
      const component =
        components[
          ['eraser', 'miniapp-major-static', 'admin-static'].includes(role) ? role : 'api-shared'
        ];
      requireFact(component?.imageId === item.image, 'runtime_image_changed');
    }
    stable.push(restartProof ? { ...item, ocrRestartEvidence: restartProof } : item);
  }
  return stable;
}

// FLAG: This proves one partially installed scheduler activation, never a release,
// completed backup or generic targetless-owner recovery. Directory/lock creation is retained.
export function buildBackupActivationProof(request, observation) {
  requireFact(
    request.sourceSha === ACTIVATION.sourceSha &&
      /^[a-f0-9]{64}$/u.test(request.stateSha256 ?? '') &&
      request.invocationId === ACTIVATION.invocationId,
    'unreviewed_activation_identity',
  );
  const bytes = Buffer.from(observation.ownerBytes);
  const owner = ownerFields(bytes);
  requireFact(
    digest(bytes) === request.ownerSha256 &&
      owner.initial_state === request.stateSha256 &&
      observation.ownerUid === observation.operatorUid &&
      observation.operatorUid > 0 &&
      observation.ownerMode === 0o600 &&
      observation.ownerLinks === 1,
    'owner_changed',
  );
  requireFact(
    observation.root === true &&
      observation.locksHeld === true &&
      owner.inode === observation.admissionInode &&
      observation.bootId === owner.boot &&
      observation.originalProcessAbsent === true &&
      observation.noActors === true,
    'operation_quiescence_unproved',
  );
  requireFact(
    observation.sourcesMatch === true &&
      observation.environmentSha256 === ACTIVATION.environmentSha256 &&
      observation.schedulerEmpty === true &&
      /^[a-f0-9]{64}$/u.test(observation.schedulerSha256 ?? ''),
    'activation_boundary_unproved',
  );
  const snapshot = observation.snapshot;
  requireFact(
    snapshot.schemaVersion === 1 &&
      snapshot.protocol === 'major-karavan-release-v1' &&
      snapshot.major.checkoutSha === ACTIVATION.sourceSha &&
      digest(JSON.stringify(snapshot)) === request.stateSha256,
    'pair_state_changed',
  );
  const unitProjection = validateActivationUnits(observation.units);
  const runtime = validateActivationRuntime(observation.runtime, snapshot, observation.ocrRestart);
  const messages = [
    "fatal: detected dubious ownership in repository at '/var/www/Chat_bot'",
    'To add an exception for this directory, call:',
    '\tgit config --global --add safe.directory /var/www/Chat_bot',
    'Backup schedule refused: inspect private state and service journal.',
  ];
  requireFact(observation.journal.length === messages.length, 'journal_incomplete');
  const journal = observation.journal.map((row, index) => {
    const at = Number(row.__REALTIME_TIMESTAMP);
    requireFact(
      row.MESSAGE === messages[index] &&
        row._SYSTEMD_INVOCATION_ID === ACTIVATION.invocationId &&
        row._SYSTEMD_UNIT === 'maxim-postgres-backup-retry.service' &&
        row._SYSTEMD_CGROUP === '/system.slice/maxim-postgres-backup-retry.service' &&
        row._UID === '0' &&
        row._GID === '0' &&
        row._BOOT_ID === owner.boot.replaceAll('-', '') &&
        row._EXE === '/usr/local/bin/node' &&
        row._CMDLINE === `node ${MAJOR}/infra/scripts/postgres-backup-schedule.mjs tick` &&
        row._PID === observation.journal[0]._PID &&
        /^[1-9][0-9]*$/u.test(row._PID) &&
        Number.isSafeInteger(at) &&
        at >= Date.parse('2026-11-03T10:42:07Z') * 1000 &&
        at < Date.parse('2026-11-03T10:42:08Z') * 1000,
      'journal_refusal_unproved',
    );
    return { at, pid: row._PID, message: row.MESSAGE };
  });
  return {
    schemaVersion: 1,
    kind: 'backup-scheduler-partial-activation',
    ownerSha256: request.ownerSha256,
    initialStateSha256: owner.initial_state,
    stateSha256: request.stateSha256,
    sourceSha: request.sourceSha,
    invocationId: request.invocationId,
    ownerStartedAt: owner.started_at,
    activationScriptSha256: ACTIVATION.scriptSha256,
    environmentSha256: observation.environmentSha256,
    unitsSha256: digest(JSON.stringify(unitProjection)),
    runtimeSha256: digest(JSON.stringify(runtime)),
    ocrRestartEvidence:
      runtime.find((item) => item.name === '/infra-ocr-native-sandbox-1').ocrRestartEvidence ??
      null,
    schedulerSha256: observation.schedulerSha256,
    eraserCoordinator: 'absent_not_locked; triggers_beyond_bounded_recovery',
    journalSha256: digest(JSON.stringify(journal)),
    verification: 'installed_units_and_git_refusal_before_operation_or_producer',
    runtimeEvidence:
      'current_manifest_images_and_containers_predating_owner; only_pinned_ocr_timeout_recycle_may_restart_after_owner; no_prior_container_inventory',
  };
}

async function boundedFile(path, maximum) {
  const fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await fd.stat();
    requireFact(
      before.isFile() && before.nlink === 1 && before.size <= maximum,
      'unsafe_input_file',
    );
    const bytes = await fd.readFile();
    const after = await fd.stat();
    const current = await lstat(path);
    requireFact(
      bytes.length <= maximum &&
        ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs'].every((key) => before[key] === after[key]) &&
        current.dev === after.dev &&
        current.ino === after.ino &&
        !current.isSymbolicLink(),
      'input_file_changed',
    );
    return { bytes, stat: after };
  } finally {
    await fd.close();
  }
}
async function command(file, args, options = {}) {
  try {
    return (
      await execute(file, args, {
        timeout: 10_000,
        maxBuffer: 1_048_576,
        env: { ...process.env, GIT_NO_REPLACE_OBJECTS: '1' },
        ...options,
      })
    ).stdout;
  } catch {
    throw new Error('bounded_observation_failed');
  }
}
async function absent(path) {
  try {
    await lstat(path);
    return false;
  } catch (error) {
    if (error.code === 'ENOENT') return true;
    throw error;
  }
}
async function protectedPaths() {
  requireFact(process.getuid() === 0, 'root_required');
  const state = await lstat(`${ROOT}/state`);
  requireFact(
    state.isDirectory() &&
      !state.isSymbolicLink() &&
      state.uid > 0 &&
      (state.mode & 0o777) === 0o700,
    'unsafe_state_directory',
  );
  for (const path of ['/var', '/var/lib', ROOT, '/var/lib/maxim-deploy']) {
    const value = await lstat(path);
    requireFact(
      value.isDirectory() &&
        !value.isSymbolicLink() &&
        !(value.mode & 0o022) &&
        (path !== ROOT || value.uid === 0),
      'unsafe_protected_directory',
    );
  }
  for (const path of LOCKS) {
    const value = await boundedFile(path, 0);
    requireFact(
      value.stat.uid === state.uid && (value.stat.mode & 0o777) === 0o600,
      'unsafe_persistent_lock',
    );
  }
  requireFact(
    (await realpath(MAJOR)) === MAJOR && (await realpath(KARAVAN)) === KARAVAN,
    'source_path_changed',
  );
  return state;
}

// FLAG: The shared primitive holds exactly three release locks. This separate original
// descriptor holds the existing scheduler lock; it never creates or unlocks an inode.
export async function withActivationSchedulerLock(path, work) {
  const fd = await open(path, constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const child = spawn('flock', ['-n', '3'], { stdio: ['ignore', 'ignore', 'ignore', fd.fd] });
    const [code] = await once(child, 'exit');
    requireFact(code === 0, 'scheduler_lock_busy');
    const assertLock = async () => {
      const [current, original, info] = await Promise.all([
        lstat(path),
        fd.stat(),
        readFile(`/proc/${process.pid}/fdinfo/${fd.fd}`, 'utf8'),
      ]);
      requireFact(
        !current.isSymbolicLink() &&
          current.dev === original.dev &&
          current.ino === original.ino &&
          current.isFile() &&
          current.nlink === 1 &&
          current.size === 0 &&
          /^lock:\s+\d+:\s+FLOCK\s+ADVISORY\s+WRITE\s+\d+\s+\S+\s+0\s+EOF$/mu.test(info),
        'scheduler_lock_authority_lost',
      );
    };
    await assertLock();
    return await work(assertLock);
  } finally {
    await fd.close();
  }
}

async function assertSource() {
  const git = (root, args) => command('git', ['-c', `safe.directory=${root}`, '-C', root, ...args]);
  requireFact(
    (await git(MAJOR, ['rev-parse', 'HEAD'])).trim() === ACTIVATION.sourceSha &&
      (await git(MAJOR, ['status', '--porcelain'])).trim() === '' &&
      (await git(KARAVAN, ['status', '--porcelain'])).trim() === '',
    'source_changed',
  );
  for (const [path, source] of [
    [`${ROOT}/admission.sh`, 'infra/scripts/lib/pair-release-admission.sh'],
    [`${ROOT}/state.mjs`, 'infra/scripts/pair-release-state.mjs'],
  ]) {
    const value = await boundedFile(path, 262_144);
    requireFact(
      value.stat.uid === 0 &&
        !(value.stat.mode & 0o022) &&
        digest(value.bytes) ===
          digest(await git(MAJOR, ['show', `${ACTIVATION.sourceSha}:${source}`])),
      'shared_controller_changed',
    );
  }
  const primitive = await boundedFile(PRIMITIVE, 262_144);
  requireFact(digest(primitive.bytes) === ACTIVATION.primitiveSha256, 'recovery_primitive_changed');
  return primitive.bytes;
}
async function noActors() {
  const pattern =
    '[b]ash -se|[s]ystemctl (start|restart|reload|enable|disable|stop)|[v]ps-pull-build-up|[v]ps-runtime-rollback|[v]ps-release-rollback|[v]ps-finalize-release-recovery|[r]elease-karavan[.]sh|[v]ps-deploy-karavan|[v]ps-rollback-karavan|[b]ackup-postgres[.]sh|[r]estore-postgres-backup-smoke|[p]ostgres-backup-schedule|[r]eplicate-postgres-backup|[v]ps-install-postgres-backup-timers|[d]ocker (compose|buildx)|[t]imeout.*180s bash -se';
  let output;
  try {
    output = (await execute('pgrep', ['-f', pattern], { timeout: 2_000, maxBuffer: 8192 })).stdout;
  } catch (error) {
    if (error.code === 1) return true;
    throw new Error('actor_observation_failed');
  }
  const pids = output.trim().split('\n');
  requireFact(pids.length <= 256, 'actor_observation_capped');
  for (const pid of pids) {
    requireFact(/^[1-9][0-9]*$/u.test(pid), 'invalid_actor_observation');
    try {
      const cwd = await readlink(`/proc/${pid}/cwd`);
      const cmd = (await boundedFile(`/proc/${pid}/cmdline`, 65_536)).bytes.toString();
      if (
        [MAJOR, KARAVAN].some(
          (root) =>
            cwd === root ||
            cwd.startsWith(`${root}/`) ||
            cmd.split('\0').some((arg) => arg.startsWith(`${root}/`)),
        )
      )
        return false;
    } catch (error) {
      if (!['ENOENT', 'ESRCH'].includes(error.code)) throw error;
    }
  }
  return true;
}
async function assertServiceCgroupEmpty(name) {
  const root = `/sys/fs/cgroup/system.slice/${name}`;
  if (await absent(root)) return;
  const pending = [[root, 0]];
  let seen = 0;
  while (pending.length) {
    const [path, depth] = pending.shift();
    requireFact(++seen <= 32 && depth <= 4, 'service_cgroup_observation_capped');
    const stat = await lstat(path);
    requireFact(stat.isDirectory() && !stat.isSymbolicLink(), 'unsafe_service_cgroup');
    requireFact(
      (await boundedFile(`${path}/cgroup.procs`, 8192)).bytes.toString().trim() === '',
      'service_cgroup_not_empty',
    );
    for (const entry of await readdir(path, { withFileTypes: true })) {
      requireFact(!entry.isSymbolicLink(), 'unsafe_service_cgroup');
      if (entry.isDirectory()) pending.push([`${path}/${entry.name}`, depth + 1]);
    }
  }
}
export async function observeActivationOcrRestart(item) {
  if (Date.parse(item.started) < Date.parse(ACTIVATION.startedAt)) return null;
  requireFact(
    item.id === OCR_CONTAINER.id && item.created === OCR_CONTAINER.created,
    'unreviewed_ocr_generation',
  );
  const container = JSON.parse(
    await command(
      'docker',
      [
        'inspect',
        '--format',
        '{"id":{{json .Id}},"created":{{json .Created}},"image":{{json .Image}},"restarts":{{json .RestartCount}},"state":{{json .State}},"command":{{json .Config.Cmd}},"healthcheck":{{json .Config.Healthcheck}},"restartPolicy":{{json .HostConfig.RestartPolicy.Name}}}',
        OCR_CONTAINER.id,
      ],
      { maxBuffer: 65_536 },
    ),
  );
  const started = timestampNanos(item.started);
  const since = new Date(Number((started - 5_000_000_000n) / 1_000_000n)).toISOString();
  let logs;
  try {
    // Docker preserves container stderr on its own stderr. Both bounded streams
    // are evidence; neither stderr output nor an empty events buffer proves failure.
    const result = await execute(
      'docker',
      [
        'logs',
        '--timestamps',
        '--since',
        since,
        '--until',
        item.started,
        '--tail',
        '32',
        OCR_CONTAINER.id,
      ],
      { timeout: 10_000, maxBuffer: 32_768, encoding: 'utf8' },
    );
    logs = { stdout: result.stdout, stderr: result.stderr };
  } catch {
    throw new Error('ocr_log_observation_failed');
  }
  return { container, logs };
}
async function observe() {
  const state = await protectedPaths();
  await assertSource();
  const owner = await boundedFile(OWNER, 393);
  const parsed = ownerFields(owner.bytes);
  const environment = await boundedFile('/etc/maxim-postgres-backup.env', 16_384);
  requireFact(
    environment.stat.uid === 0 &&
      (environment.stat.mode & 0o777) === 0o600 &&
      digest(environment.bytes) === ACTIVATION.environmentSha256,
    'backup_environment_changed',
  );
  const units = {};
  for (const name of Object.keys(UNIT_HASHES)) {
    const value = await boundedFile(`/etc/systemd/system/${name}`, 16_384);
    const raw = await command('systemctl', [
      'show',
      name,
      '--no-pager',
      ...PROPERTIES.map((key) => `--property=${key}`),
    ]);
    const rows = raw
      .trimEnd()
      .split('\n')
      .map((line) => {
        const at = line.indexOf('=');
        requireFact(at > 0, 'invalid_unit_observation');
        return [line.slice(0, at), line.slice(at + 1)];
      });
    requireFact(new Set(rows.map(([key]) => key)).size === rows.length, 'invalid_unit_observation');
    if (name.endsWith('.service')) await assertServiceCgroupEmpty(name);
    units[name] = {
      sha256: digest(value.bytes),
      uid: value.stat.uid,
      mode: value.stat.mode & 0o777,
      properties: Object.fromEntries(rows),
    };
  }
  const directory = await lstat(SCHEDULE);
  requireFact(
    directory.isDirectory() &&
      !directory.isSymbolicLink() &&
      directory.uid === 0 &&
      (directory.mode & 0o777) === 0o700 &&
      (await realpath(SCHEDULE)) === SCHEDULE &&
      (await readdir(SCHEDULE)).sort().join() === 'lock' &&
      (await absent(ERASER_SCHEDULE)),
    'scheduler_state_changed',
  );
  const schedule = await boundedFile(`${SCHEDULE}/lock`, 0);
  requireFact(
    schedule.stat.uid === 0 && (schedule.stat.mode & 0o777) === 0o600,
    'unsafe_scheduler_lock',
  );
  const report = JSON.parse(await command('bash', [`${ROOT}/admission.sh`, 'state']));
  const snapshot = Object.fromEntries(
    Object.entries(report).filter(
      ([key]) => !['fingerprint', 'admission', 'observedAt'].includes(key),
    ),
  );
  const runtimeRaw = await command('docker', [
    'inspect',
    '--format',
    '{{json .Id}}|{{json .Name}}|{{json .Created}}|{{json .Image}}|{{json .Config.Image}}|{{json .State.StartedAt}}|{{json .State.Status}}|{{json .RestartCount}}|{{json .Mounts}}',
    ...ROLES.map((role) => `infra-${role}-1`),
  ]);
  const runtime = runtimeRaw
    .trim()
    .split('\n')
    .map((line) => {
      const values = line.split('|').map((part) => JSON.parse(part));
      requireFact(values.length === 9, 'invalid_runtime_observation');
      const [id, name, created, image, imageRef, started, status, restarts, mounts] = values;
      return { id, name, created, image, imageRef, started, status, restarts, mounts };
    });
  const ocrRestart = await observeActivationOcrRestart(
    runtime.find((item) => item.name === '/infra-ocr-native-sandbox-1'),
  );
  const journalRaw = await command(
    'journalctl',
    [`_SYSTEMD_INVOCATION_ID=${ACTIVATION.invocationId}`, '--no-pager', '-n', '50', '-o', 'json'],
    { maxBuffer: 65_536 },
  );
  const journal = journalRaw
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const lock = await lstat(LOCKS[0]);
  return {
    root: process.getuid() === 0,
    locksHeld: true,
    ownerBytes: owner.bytes,
    ownerUid: owner.stat.uid,
    ownerMode: owner.stat.mode & 0o777,
    ownerLinks: owner.stat.nlink,
    operatorUid: state.uid,
    admissionInode: `${lock.dev}:${lock.ino}`,
    bootId: (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim(),
    originalProcessAbsent: await absent(`/proc/${parsed.pid}`),
    noActors: await noActors(),
    sourcesMatch: true,
    environmentSha256: digest(environment.bytes),
    schedulerEmpty: true,
    schedulerSha256: digest(
      JSON.stringify({
        main: {
          dev: directory.dev,
          ino: directory.ino,
          lockDev: schedule.stat.dev,
          lockIno: schedule.stat.ino,
        },
        eraser: 'absent',
      }),
    ),
    snapshot,
    units,
    runtime,
    ocrRestart,
    journal,
  };
}

export async function recoverBackupActivation(request, dependencies) {
  const first = await dependencies.observe();
  const proof = buildBackupActivationProof(request, first);
  const proofSha256 = digest(JSON.stringify(proof));
  if (request.mode === 'apply') {
    requireFact(request.proofSha256 === proofSha256, 'preview_proof_changed');
    const second = await dependencies.observe();
    requireFact(
      digest(JSON.stringify(buildBackupActivationProof(request, second))) === proofSha256,
      'recovery_evidence_changed',
    );
    await dependencies.archive(second, proof);
  }
  return { ...proof, proofSha256, mode: request.mode, archived: request.mode === 'apply' };
}

async function main() {
  const request = parseBackupActivationRecoveryArgs(process.argv.slice(2));
  const state = await protectedPaths();
  const bytes = await assertSource();
  // FLAG: Import the checked immutable bytes, never a path that can change after hashing.
  const { withBackupRefusalLocks, archiveBackupRefusal } = await import(
    `data:text/javascript;base64,${bytes.toString('base64')}`
  );
  return withBackupRefusalLocks(LOCKS, ({ assertLocks }) =>
    withActivationSchedulerLock(`${SCHEDULE}/lock`, async (assertSchedulerLock) => {
      const assertAllLocks = async () => {
        await assertLocks();
        await assertSchedulerLock();
        requireFact(await absent(ERASER_SCHEDULE), 'eraser_scheduler_appeared');
        requireFact(await noActors(), 'operation_actor_appeared');
        const owner = await boundedFile(OWNER, 393);
        requireFact(
          digest(owner.bytes) === request.ownerSha256 &&
            owner.stat.uid === state.uid &&
            owner.stat.gid === state.gid &&
            (owner.stat.mode & 0o777) === 0o600,
          'owner_changed_before_archive',
        );
      };
      return recoverBackupActivation(request, {
        observe: async () => {
          await assertAllLocks();
          const result = await observe();
          await assertAllLocks();
          return result;
        },
        archive: async (value, proof) =>
          archiveBackupRefusal({
            ownerPath: OWNER,
            archiveDirectory: `${ROOT}/state/backup-activation-recoveries`,
            operatorUid: state.uid,
            operatorGid: state.gid,
            ownerBytes: value.ownerBytes,
            proof,
            assertLocks: assertAllLocks,
          }),
      });
    }),
  );
}
if (import.meta.main)
  main()
    .then((result) => process.stdout.write(`${JSON.stringify(result)}\n`))
    .catch((error) => {
      process.stderr.write(
        `${JSON.stringify({ ok: false, code: /^[a-z_]+$/u.test(error.message) ? error.message : 'recovery_observation_failed' })}\n`,
      );
      process.exitCode = 1;
    });
