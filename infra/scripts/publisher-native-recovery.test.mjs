import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { legacyColdFleet } from './test-fixtures/legacy-cold-fleet.mjs';

const root = resolve(import.meta.dirname, '../..');
const rollout = readFileSync(join(root, 'infra/scripts/vps-publisher-dispatch-rollout.sh'), 'utf8');
const serviceOf = (container) => container.Config.Labels['com.docker.compose.service'];
const mediaService = 'api-media-analysis';
const photoConsumerService = 'api-moderation-background';
function block(name) {
  const start = rollout.indexOf(`${name}() {`);
  assert.notEqual(start, -1);
  const end = rollout.indexOf('\n}', start);
  assert.notEqual(end, -1);
  return rollout.slice(start, end + 2);
}

function fixture() {
  const containers = legacyColdFleet();
  const ocr = containers.find((row) => serviceOf(row) === 'ocr-native-sandbox');
  ocr.HostConfig.Privileged = false;
  const media = containers.find((row) => serviceOf(row) === mediaService);
  media.Mounts = [{ ...ocr.Mounts[0], RW: false }];
  media.Config.Env.push(...ocr.Config.Env);
  const photoConsumer = containers.find((row) => serviceOf(row) === photoConsumerService);
  photoConsumer.Config.Env.push(
    'PHOTO_NATIVE_SANDBOX_SOCKET_PATH=/run/maxim-photo/native-photo.sock',
  );
  photoConsumer.Mounts = [
    { Type: 'volume', Name: 'infra_photo_native_ipc', Destination: '/run/maxim-photo', RW: false },
  ];
  for (const container of containers.filter((row) => serviceOf(row).startsWith('api-'))) {
    container.Config.Env.push(
      'MAX_PUBLISHER_DISPATCH_ENABLED=true',
      'PUBLISHER_TEMPORAL_SELECTION_ROLLOUT=test',
    );
  }
  return { containers };
}
function stop(container) {
  container.State.Running = false;
  container.State.Status = 'exited';
}
async function dockerFixture(directory) {
  const calls = [];
  const sockets = new Set();
  const errors = [];
  const statePath = join(directory, 'state.json');
  const label = (container, key) => container.Config?.Labels?.[key];
  function respond(args) {
    calls.push(args);
    const state = JSON.parse(readFileSync(statePath, 'utf8'));
    const finish = (stdout = '', status = 0, stderr = '') => ({ stdout, status, stderr });
    if (args[0] === 'compose' && args.includes('config') && args.includes('--services'))
      return finish(state.containers.map(serviceOf).join('\n'));
    if (args[0] === 'compose' && args.includes('config'))
      return finish(JSON.stringify({ name: 'infra' }));
    if (args[0] === 'compose' && args.includes('ps')) {
      let rows = state.containers.filter((container) => serviceOf(container) === args.at(-1));
      if (!args.includes('-a')) rows = rows.filter((container) => container.State.Running);
      return finish(rows.map((container) => container.Id).join('\n'));
    }
    if (args[0] === 'image' && args.includes('inspect')) return finish('true');
    if (args[0] === 'ps') {
      let rows = state.containers.filter(
        (container) => args.includes('-a') || args.includes('--all') || container.State.Running,
      );
      for (let i = 0; i < args.length; i++) {
        if (args[i] !== '--filter') continue;
        const filter = args[++i];
        if (filter.startsWith('label=')) {
          const [key, value] = filter.slice(6).split('=');
          rows = rows.filter((container) => label(container, key) === value);
        } else if (filter.startsWith('volume=')) {
          rows = rows.filter((container) =>
            container.Mounts?.some((mount) => mount.Name === filter.slice(7)),
          );
        } else return finish('', 91);
      }
      return finish(rows.map((container) => container.Id).join('\n'));
    }
    if (args[0] === 'inspect') {
      const ids = args.slice(args[1] === '--format' ? 3 : 1);
      const rows = ids.map((id) => state.containers.find((container) => container.Id === id));
      if (rows.some((container) => !container)) return finish('', 1);
      const container = rows[0];
      const format = args[2];
      if (args[1] !== '--format') return finish(JSON.stringify(rows));
      if (format === '{{.Image}}') return finish(container.Image);
      if (format.includes('.Config.Env')) return finish(container.Config.Env.join('\n'));
      if (format.includes('.State.Status')) {
        const result = [
          container.State.Running,
          container.State.Status,
          container.State.Paused,
          container.State.Restarting,
          container.State.Dead,
        ].join('|');
        if (state.replaceAfterState === serviceOf(container)) {
          container.Id = '7'.repeat(64);
          delete state.replaceAfterState;
          writeFileSync(statePath, JSON.stringify(state));
        }
        return finish(result);
      }
      if (format.includes('.Mounts')) {
        return finish(
          container.Mounts?.find(
            (mount) =>
              mount.Destination ===
              (format.includes('/run/maxim-ocr') ? '/run/maxim-ocr' : '/run/maxim-photo'),
          )?.Name ?? '',
        );
      }
      return finish('', 92);
    }
    return finish('', 93, 'Unexpected fake Docker operation');
  }
  // Only fake Docker is persistent; every production validator still executes normally.
  // NUL frames preserve shell arguments and exact output without a Node startup per command.
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', (error) => errors.push(error));
    let request = Buffer.alloc(0);
    let handled = false;
    const reject = () => {
      errors.push(new Error('Invalid fake Docker request frame'));
      socket.destroy();
    };
    socket.on('end', () => {
      if (!handled) reject();
    });
    socket.on('data', (chunk) => {
      if (handled) {
        reject();
        return;
      }
      request = Buffer.concat([request, chunk]);
      if (request.length > 65536) {
        reject();
        return;
      }
      const fields = request.toString('utf8').split('\0');
      if (fields.length < 2) return;
      if (!/^[0-9]+$/u.test(fields[0])) {
        reject();
        return;
      }
      const count = Number(fields[0]);
      if (!Number.isSafeInteger(count) || count > 256) {
        reject();
        return;
      }
      if (fields.length < count + 2) return;
      if (fields.length !== count + 2 || fields.at(-1) !== '') {
        reject();
        return;
      }
      handled = true;
      try {
        const result = respond(fields.slice(1, -1));
        socket.end(`${result.status}\0${result.stderr}\0${result.stdout}`);
      } catch (error) {
        errors.push(error);
        socket.end('94\0Fake Docker responder failed\0');
      }
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    port: server.address().port,
    calls,
    errors,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}

async function run({
  stopped = [],
  mutate = () => {},
  policy = 'allow-stopped',
  command,
  apply = 1,
  adopt = 1,
  executeApply = false,
  dispatch = 'true',
  dispatchConfigured = 'true',
  expectedSelection = 'test',
  runtimeSelection = 'test',
  afterRecreateSelection = expectedSelection === 'default-off' ? undefined : expectedSelection,
  expectedRollup = 'default-off',
  runtimeRollup,
  afterRecreateRollup = expectedRollup === 'default-off' ? undefined : expectedRollup,
  runtimeExpectedState = 'any',
  selectionPolicy = 'required',
  selectionOperation = 0,
  modeOperation = selectionOperation ? 'selection' : '',
  statusCommand = false,
} = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'publisher-native-recovery-'));
  const state = fixture();
  for (const container of state.containers.filter((row) => serviceOf(row).startsWith('api-'))) {
    container.Config.Env = container.Config.Env.filter(
      (value) =>
        !value.startsWith('MAX_PUBLISHER_DISPATCH_ENABLED=') &&
        !value.startsWith('PUBLISHER_TEMPORAL_SELECTION_ROLLOUT=') &&
        !value.startsWith('PUBLISHER_OCCURRENCE_ROLLUP_NOOP_ROLLOUT='),
    );
    if (dispatchConfigured === 'true') {
      container.Config.Env.push(`MAX_PUBLISHER_DISPATCH_ENABLED=${dispatch}`);
    }
    if (runtimeRollup != null) {
      container.Config.Env.push(`PUBLISHER_OCCURRENCE_ROLLUP_NOOP_ROLLOUT=${runtimeRollup}`);
    }
    if (runtimeSelection != null) {
      container.Config.Env.push(`PUBLISHER_TEMPORAL_SELECTION_ROLLOUT=${runtimeSelection}`);
    }
  }
  for (const service of stopped) stop(state.containers.find((row) => serviceOf(row) === service));
  mutate(state);
  writeFileSync(join(directory, 'state.json'), JSON.stringify(state));
  writeFileSync(
    join(directory, '.env'),
    `UNCHANGED=value\n${expectedSelection === 'default-off' ? '' : `PUBLISHER_TEMPORAL_SELECTION_ROLLOUT=${expectedSelection}\n`}${expectedRollup === 'default-off' ? '' : `PUBLISHER_OCCURRENCE_ROLLUP_NOOP_ROLLOUT=${expectedRollup}\n`}`,
  );
  writeFileSync(
    join(directory, 'recreate.cjs'),
    `const fs=require('node:fs'),path=require('node:path');
const file=path.join(process.env.PUBLISHER_NATIVE_TEST_DIRECTORY,'state.json');
const state=JSON.parse(fs.readFileSync(file,'utf8'));
for(const c of state.containers.filter(c=>c.Config.Labels['com.docker.compose.service'].startsWith('api-'))) {
 c.State.Running=true;c.State.Status='running';
 c.Config.Env=c.Config.Env.filter(v=>!v.startsWith('MAX_PUBLISHER_DISPATCH_ENABLED=')&&!v.startsWith('PUBLISHER_TEMPORAL_SELECTION_ROLLOUT=')&&!v.startsWith('PUBLISHER_OCCURRENCE_ROLLUP_NOOP_ROLLOUT='));
 c.Config.Env.push('MAX_PUBLISHER_DISPATCH_ENABLED=false');
 const selection=${JSON.stringify(afterRecreateSelection) ?? 'undefined'};
 if(selection!==undefined)c.Config.Env.push('PUBLISHER_TEMPORAL_SELECTION_ROLLOUT='+selection);
 const rollup=${JSON.stringify(afterRecreateRollup) ?? 'undefined'};
 if(rollup!==undefined)c.Config.Env.push('PUBLISHER_OCCURRENCE_ROLLUP_NOOP_ROLLOUT='+rollup);
}
fs.writeFileSync(file,JSON.stringify(state));
`,
  );
  const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";
  writeFileSync(
    join(directory, 'docker'),
    `#!/usr/bin/env bash
set -euo pipefail
exec 3<>/dev/tcp/127.0.0.1/"$PUBLISHER_NATIVE_TEST_PORT"
printf '%s\\0' "$#" "$@" >&3
IFS= read -r -d '' fixture_status <&3
IFS= read -r -d '' fixture_error <&3
[[ "$fixture_status" =~ ^[0-9]{1,3}$ && "$fixture_status" -le 255 ]] || exit 94
printf '%s' "$fixture_error" >&2
cat <&3
exit "$fixture_status"
`,
    { mode: 0o755 },
  );
  const image = state.containers[0].Image;
  const apiServices = fixture()
    .containers.filter((row) => serviceOf(row).startsWith('api-'))
    .map(serviceOf);
  const script = `set -euo pipefail
source infra/scripts/lib/deploy-topology.sh
${block('native_consumer_runtime_state')}
${block('container_env_summary')}
${block('verify_runtime')}
${block('rollout_preflight')}
${block('apply_rollout')}
${block('read_rollout_modes')}
${block('status_command')}
COMPOSE_FILES=(--env-file .env -p infra -f infra/docker-compose.yml)
MAXIM_PRODUCTION_API_SERVICES=(${apiServices.join(' ')})
MANIFEST_IMAGE_ID='${image}'
STATE_HELPER=${quote(join(root, 'infra/scripts/publisher-dispatch-rollout-state.mjs'))}
COMMAND_TIMEOUT_SEC=5
EXPECTED_HAS_OCR_NATIVE_SANDBOX=1
MAXIM_TARGET_HAS_PHOTO_NATIVE_SANDBOX=1
CURRENT_ENV_STATE=${dispatch}
CURRENT_ENV_CONFIGURED=${dispatchConfigured}
DESIRED_STATE=false
EXPECTED_OCR_VERSION=reviewed
MANIFEST_SOURCE_SHA=${'b'.repeat(40)}
MODE_OPERATION=${quote(modeOperation)}
COMMAND=${command ?? 'disable'}
APPLY=${apply}
MAXIM_WEBHOOK_ROLLOUT_ADOPT_EXISTING_PAUSE=${adopt}
fail() { printf '%s\\n' "$*" >&2; return 1; }
verify_no_unreviewed_running_api_containers() { :; }
verify_compose_config() { :; }
verify_preview_compose_config() { :; }
maxim_topology_require_api_commercial_ocr_version_config() { :; }
maxim_topology_require_media_analysis_rollout_config() { :; }
require_stateful_services_ready() { :; }
ROOT_DIR=${quote(root)}
cd "$PUBLISHER_NATIVE_TEST_DIRECTORY"
read_rollout_modes
cd "$ROOT_DIR"
RECONCILE_ONLY=0
ROLLOUT_COMPLETE=0
POST_CLEAR_REARM_REQUIRED=0
events=()
maxim_require_ordinary_effect_authority() { :; }
arm_operator_pause() { events+=(arm); }
patch_dispatch_env() { events+=(patch); }
recreate_all_api_roles() { events+=(recreate); node "$PUBLISHER_NATIVE_TEST_DIRECTORY/recreate.cjs"; }
wait_for_url() { :; }
wait_for_heartbeat() { events+=(heartbeat); }
maxim_webhook_resume_after_api_fence() { events+=(resume); }
run_health_smokes() { events+=(health); }
maxim_topology_verify_api_commercial_ocr_version() { :; }
maxim_topology_smoke_media_analysis_tesseract() { :; }
clear_operator_pause() { events+=(clear); }
best_effort_rearm_operator_pause() { events+=(rearm); }
read_control_status() { printf '{}'; }
control_field() { printf 'missing'; }
publisher_secret_state() { return 1; }
trap 'status=$?; printf "status=%s complete=%s reconcile=%s events=%s\\n" "$status" "$ROLLOUT_COMPLETE" "$RECONCILE_ONLY" "\${events[*]}"' EXIT
${statusCommand ? 'status_command' : command ? 'rollout_preflight' : `verify_runtime ${runtimeExpectedState} ${policy} ${selectionPolicy}`}
${executeApply ? 'apply_rollout' : ''}
printf 'native-preflight-verified\\n'`;
  let docker;
  let child;
  let commandTimer;
  let killTimer;
  let deadlineExpired = false;
  const groupErrors = [];
  const killGroup = (signal) => {
    if (!child?.pid) return;
    try {
      process.kill(-child.pid, signal);
    } catch (error) {
      if (error.code !== 'ESRCH') groupErrors.push(error);
    }
  };
  try {
    docker = await dockerFixture(directory);
    child = spawn('bash', ['-c', script], {
      cwd: root,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        PATH: `${directory}:${process.env.PATH}`,
        PUBLISHER_NATIVE_TEST_DIRECTORY: directory,
        PUBLISHER_NATIVE_TEST_PORT: String(docker.port),
      },
    });
    // Keep the original deadline, including descendants holding the output pipes.
    // An uncooperative fixture process gets a fixed, bounded teardown grace period.
    commandTimer = setTimeout(
      () => {
        deadlineExpired = true;
        killGroup('SIGTERM');
        killTimer = setTimeout(() => killGroup('SIGKILL'), 250);
      },
      executeApply ? 60_000 : 15_000,
    );
    let spawnError;
    child.once('error', (error) => {
      spawnError = error;
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.setEncoding('utf8').on('data', (chunk) => {
      stderr += chunk;
    });
    const [status, signal] = await new Promise((resolve) =>
      child.once('close', (...result) => resolve(result)),
    );
    if (spawnError) throw spawnError;
    assert.equal(deadlineExpired, false, 'the fixture command exceeded its original deadline');
    const result = { status, signal, stdout, stderr };
    const { calls } = docker;
    assert.deepEqual(
      docker.errors,
      [],
      'fake Docker transport must not hide an infrastructure failure',
    );
    assert.equal(signal, null, 'the original shell timeout must remain authoritative');
    assert.ok(
      calls.every(
        (args) => !['stop', 'rm', 'run', 'up', 'exec'].some((token) => args.includes(token)),
      ),
      'preflight must remain read-only',
    );
    assert.doesNotMatch(result.stdout + result.stderr, /do-not-log/u);
    return {
      ...result,
      calls,
      state: JSON.parse(readFileSync(join(directory, 'state.json'), 'utf8')),
    };
  } finally {
    clearTimeout(commandTimer);
    clearTimeout(killTimer);
    killGroup('SIGKILL');
    await docker?.close();
    rmSync(directory, { recursive: true, force: true });
    assert.deepEqual(groupErrors, [], 'the owned fixture process group must be cleaned up');
  }
}

for (const [name, runtimeSelection, mutate] of [
  ['all roles stale', 'test', () => {}],
  [
    'one role stale',
    'off',
    ({ containers }) => {
      const admin = containers.find((row) => serviceOf(row) === 'api-admin');
      admin.Config.Env = admin.Config.Env.map((value) =>
        value.startsWith('PUBLISHER_TEMPORAL_SELECTION_ROLLOUT=')
          ? 'PUBLISHER_TEMPORAL_SELECTION_ROLLOUT=test'
          : value,
      );
    },
  ],
  [
    'one explicit key missing',
    'off',
    ({ containers }) => {
      const admin = containers.find((row) => serviceOf(row) === 'api-admin');
      admin.Config.Env = admin.Config.Env.filter(
        (value) => !value.startsWith('PUBLISHER_TEMPORAL_SELECTION_ROLLOUT='),
      );
    },
  ],
]) {
  test(`disabled recovery recreates persisted selection drift: ${name}`, async () => {
    const result = await run({
      command: 'disable',
      executeApply: true,
      dispatch: 'false',
      expectedSelection: 'off',
      runtimeSelection,
      mutate,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /status=0 complete=1 reconcile=0 events=arm patch recreate/u);
    const apis = result.state.containers.filter((row) => serviceOf(row).startsWith('api-'));
    assert.equal(apis.length, 14);
    for (const container of apis) {
      assert.ok(container.Config.Env.includes('PUBLISHER_TEMPORAL_SELECTION_ROLLOUT=off'));
      assert.ok(!container.Config.Env.includes('PUBLISHER_TEMPORAL_SELECTION_ROLLOUT=test'));
    }
  });
}

for (const [name, expectedSelection, runtimeSelection] of [
  ['explicit off', 'off', 'off'],
  ['persisted test', 'test', 'test'],
  ['absent mode with missing runtime keys', 'default-off', null],
  ['absent mode with off runtime keys', 'default-off', 'off'],
]) {
  test(`disabled recovery keeps exact persisted selection shortcut: ${name}`, async () => {
    const result = await run({
      command: 'disable',
      executeApply: true,
      dispatch: 'false',
      expectedSelection,
      runtimeSelection,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /status=0 complete=1 reconcile=1/u);
    assert.doesNotMatch(result.stdout, /\b(?:patch|recreate|resume|rearm)\b/u);
  });
}

test('missing dispatch assignment retains full recovery even with exact selection', async () => {
  const result = await run({
    command: 'disable',
    executeApply: true,
    dispatch: 'false',
    dispatchConfigured: 'false',
    expectedSelection: 'off',
    runtimeSelection: 'off',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /status=0 complete=1 reconcile=0 events=arm patch recreate/u);
});

test('post-recreation selection mismatch fails before pause release or completion', async () => {
  const result = await run({
    command: 'disable',
    executeApply: true,
    dispatch: 'false',
    expectedSelection: 'off',
    runtimeSelection: 'test',
    afterRecreateSelection: 'test',
  });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stdout, /^status=1 complete=0 reconcile=0 events=arm patch recreate$/mu);
  assert.doesNotMatch(result.stdout, /rollout complete|\b(?:heartbeat|resume|health|clear)\b/u);
});

test('guarded disabled recovery permits stale selection with both stopped native consumers', async () => {
  const result = await run({
    command: 'disable',
    executeApply: true,
    dispatch: 'false',
    expectedSelection: 'off',
    runtimeSelection: 'test',
    stopped: [mediaService, photoConsumerService],
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /status=0 complete=1 reconcile=0 events=arm patch recreate/u);
});

test('status reports persisted selection drift as mixed after exact identity admission', async () => {
  const result = await run({
    statusCommand: true,
    dispatch: 'false',
    expectedSelection: 'off',
    runtimeSelection: 'test',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /dispatch status: env=false runtime=mixed/u);
});

for (const [name, options] of [
  ['final disabled parity', { runtimeExpectedState: 'false', selectionPolicy: 'identity-only' }],
  ['final enabled parity', { runtimeExpectedState: 'true', selectionPolicy: 'identity-only' }],
  ['selection operation', { selectionOperation: 1, selectionPolicy: 'identity-only' }],
  ['unknown policy', { selectionPolicy: 'skip' }],
]) {
  test(`selection identity exception rejects ${name}`, async () => {
    const result = await run(options);
    assert.equal(result.status, 1, result.stderr);
    assert.equal(result.calls.length, 0);
  });
}

for (const stopped of [
  [],
  [mediaService],
  [photoConsumerService],
  [mediaService, photoConsumerService],
]) {
  test(`guarded recovery verifies exact native boundaries with stopped consumers: ${stopped.join(',') || 'none'}`, async () => {
    const result = await run({ stopped, command: 'disable' });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /native-preflight-verified/u);
  });
}
for (const service of [mediaService, photoConsumerService]) {
  test(`ordinary running verification refuses stopped ${service}`, async () => {
    assert.notEqual((await run({ stopped: [service], policy: 'running' })).status, 0);
  });
  for (const [name, mutate] of [
    [
      'paused',
      (c) => {
        c.State.Running = true;
        c.State.Paused = true;
        c.State.Status = 'paused';
      },
    ],
    [
      'restarting',
      (c) => {
        c.State.Running = true;
        c.State.Restarting = true;
        c.State.Status = 'restarting';
      },
    ],
    [
      'dead',
      (c) => {
        c.State.Dead = true;
      },
    ],
    [
      'created',
      (c) => {
        c.State.Status = 'created';
      },
    ],
    [
      'foreign image',
      (c) => {
        c.Image = `sha256:${'9'.repeat(64)}`;
      },
    ],
    [
      'foreign service',
      (c) => {
        c.Config.Labels['com.docker.compose.service'] = 'unexpected';
      },
    ],
    [
      'foreign project',
      (c) => {
        c.Config.Labels['com.docker.compose.project'] = 'foreign';
      },
    ],
    [
      'wrong role',
      (c) => {
        c.Config.Env = c.Config.Env.map((v) =>
          v === 'APP_ROLE=moderation' ? 'APP_ROLE=admin' : v,
        );
      },
    ],
    [
      'writable socket',
      (c) => {
        c.Mounts[0].RW = true;
      },
    ],
    [
      'wrong socket',
      (c) => {
        c.Mounts[0].Name = 'infra_unreviewed_ipc';
      },
    ],
    [
      'wrong name',
      (c) => {
        c.Name = '/manual-native-consumer';
      },
    ],
    [
      'wrong native profile',
      (c) => {
        c.Config.Env = c.Config.Env.map((v) =>
          v.includes('SANDBOX_SOCKET_PATH=') ? v.replace('.sock', '-other.sock') : v,
        );
      },
    ],
  ]) {
    test(`stopped ${service} recovery rejects ${name}`, async () => {
      const result = await run({
        stopped: [service],
        mutate: (state) => mutate(state.containers.find((row) => serviceOf(row) === service)),
      });
      assert.notEqual(result.status, 0);
      assert.doesNotMatch(result.stdout, /native-preflight-verified/u);
    });
  }
  test(`stopped ${service} recovery rejects a changed consumer generation`, async () => {
    const result = await run({
      stopped: [service],
      mutate: (state) => {
        state.replaceAfterState = service;
      },
    });
    assert.notEqual(result.status, 0);
  });
  test(`stopped ${service} recovery rejects duplicate consumer containers`, async () => {
    const result = await run({
      stopped: [service],
      mutate: (state) => {
        const duplicate = structuredClone(
          state.containers.find((row) => serviceOf(row) === service),
        );
        duplicate.Id = '6'.repeat(64);
        state.containers.push(duplicate);
      },
    });
    assert.notEqual(result.status, 0);
  });
  test(`stopped ${service} recovery rejects a rogue live IPC consumer`, async () => {
    const result = await run({
      stopped: [service],
      mutate: (state) => {
        const consumer = structuredClone(
          state.containers.find((row) => serviceOf(row) === service),
        );
        consumer.Id = '8'.repeat(64);
        consumer.State.Running = true;
        consumer.State.Status = 'running';
        consumer.Config.Labels['com.docker.compose.service'] = 'rogue';
        state.containers.push(consumer);
      },
    });
    assert.notEqual(result.status, 0);
  });
}
for (const [command, apply, adopt] of [
  ['disable', 0, 1],
  ['disable', 1, 0],
  ['enable', 1, 1],
]) {
  test(`stopped recovery remains restricted: ${command}/apply=${apply}/adopt=${adopt}`, async () => {
    assert.notEqual(
      (await run({ stopped: [mediaService, photoConsumerService], command, apply, adopt })).status,
      0,
    );
  });
}

for (const [name, runtimeRollup, mutate] of [
  ['all stale', 'test', () => {}],
  [
    'one stale',
    'off',
    (state) => {
      const admin = state.containers.find((row) => serviceOf(row) === 'api-admin');
      admin.Config.Env = admin.Config.Env.map((value) =>
        value.startsWith('PUBLISHER_OCCURRENCE_ROLLUP_NOOP_ROLLOUT=')
          ? 'PUBLISHER_OCCURRENCE_ROLLUP_NOOP_ROLLOUT=test'
          : value,
      );
    },
  ],
  ['missing explicit key', undefined, () => {}],
]) {
  test(`disabled recovery repairs persisted rollup mode drift: ${name}`, async () => {
    const result = await run({
      command: 'disable',
      executeApply: true,
      dispatch: 'false',
      expectedRollup: 'off',
      runtimeRollup,
      mutate,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /status=0 complete=1 reconcile=0 events=arm patch recreate/u);
    const apis = result.state.containers.filter((row) => serviceOf(row).startsWith('api-'));
    assert.equal(apis.length, 14);
    for (const container of apis) {
      assert.ok(container.Config.Env.includes('PUBLISHER_OCCURRENCE_ROLLUP_NOOP_ROLLOUT=off'));
      assert.ok(container.Config.Env.includes('PUBLISHER_TEMPORAL_SELECTION_ROLLOUT=test'));
    }
  });
}

for (const [expectedRollup, runtimeRollup] of [
  ['off', 'off'],
  ['test', 'test'],
  ['default-off', undefined],
  ['default-off', 'off'],
]) {
  test(`disabled recovery reuses exact persisted rollup parity: ${expectedRollup}/${runtimeRollup}`, async () => {
    const result = await run({
      command: 'disable',
      executeApply: true,
      dispatch: 'false',
      expectedRollup,
      runtimeRollup,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /complete=1 reconcile=1/u);
    assert.doesNotMatch(result.stdout, /\b(?:patch|recreate|resume)\b/u);
  });
}

test('post-recreation rollup drift prevents pause release and completion', async () => {
  const result = await run({
    command: 'disable',
    executeApply: true,
    dispatch: 'false',
    expectedRollup: 'off',
    runtimeRollup: 'test',
    afterRecreateRollup: 'test',
  });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stdout, /^status=1 complete=0 reconcile=0 events=arm patch recreate$/mu);
});

test('ordinary disable repairs both mode drifts with both native consumers stopped', async () => {
  const result = await run({
    command: 'disable',
    executeApply: true,
    dispatch: 'false',
    expectedSelection: 'off',
    runtimeSelection: 'test',
    expectedRollup: 'off',
    runtimeRollup: 'test',
    stopped: [mediaService, photoConsumerService],
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /complete=1 reconcile=0 events=arm patch recreate/u);
});

for (const modeOperation of ['selection', 'rollup-noop']) {
  test(`${modeOperation} off cannot use stopped-consumer adoption or identity-only admission`, async () => {
    for (const options of [
      { policy: 'allow-stopped' },
      { selectionPolicy: 'identity-only' },
      { command: 'disable', executeApply: true, stopped: [mediaService, photoConsumerService] },
    ]) {
      const result = await run({
        modeOperation,
        dispatch: 'false',
        expectedSelection: 'off',
        runtimeSelection: 'off',
        expectedRollup: 'off',
        runtimeRollup: 'off',
        ...options,
      });
      assert.equal(result.status, 1, result.stderr);
      assert.doesNotMatch(result.stdout, /rollout complete|complete=1/u);
    }
  });
}
