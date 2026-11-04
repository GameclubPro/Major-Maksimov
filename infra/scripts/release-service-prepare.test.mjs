import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const scriptPath = fileURLToPath(new URL('./release-service-prepare.sh', import.meta.url));
const id = '12345678-1234-4234-8234-123456789abc';
const requestHash = 'b'.repeat(64);
const sha = 'a'.repeat(40);
const manifestHash = 'c'.repeat(64);
const admission = '/usr/local/lib/maxim-release/infra/scripts/release-service-admission.mjs';
const bundle = '/usr/local/lib/maxim-release';
const plan = `before plan\nMAXIM_IMAGE_PLAN={"schemaVersion":1,"sourceSha":"${sha}","components":["api-shared"]}\nafter plan`;

function quote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

async function preparation({
  action = 'prepare',
  args = action === 'reconcile'
    ? [action, id, requestHash, sha, manifestHash]
    : [action, id, requestHash, sha],
  preflightStatus = 0,
  nodeStatus = 0,
  planStatus = 0,
  imageStatus = 0,
  snapshotStatus = 0,
  resultStatus = 0,
  reconcileStatus = 0,
  sourceStatus = 0,
  authorityStatus = 0,
  releaseStatus = 0,
  lock = 'none',
  env = {},
} = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'maxim-release-prepare-'));
  const controller = join(directory, 'controller');
  mkdirSync(join(controller, 'infra/scripts'), { recursive: true });
  const fakeDeploy = join(controller, 'infra/scripts/vps-pull-build-up.sh');
  writeFileSync(
    fakeDeploy,
    `#!/bin/bash
set -euo pipefail
event() { printf '%s\\n' "$1" >>${quote(join(directory, 'events'))}; }
[[ "$#" == 2 && "$1" == main && "$MAXIM_EXPECTED_DEPLOY_SHA" == ${quote(sha)} ]] || exit 90
[[ "$GIT_SSH_COMMAND" == ${quote(`${bundle}/infra/scripts/release-service-git-ssh.sh`)} ]] || exit 89
case "$2" in
  --plan)
    event SYNC_PLAN
    [[ -z "\${MAXIM_DEPLOY_LOCK_FD:-}\${PAIR_RELEASE_ADMISSION_FD:-}" ]] || exit 91
    exit ${planStatus}
    ;;
  --image-plan)
    event IMAGE_PLAN
    [[ "$MAXIM_DEPLOY_LOCK_OWNER_PID" == "$BASHPID" && "$PAIR_RELEASE_ADMISSION_OWNER_PID" != "$BASHPID" ]] || exit 92
    [[ -e "/proc/$BASHPID/fd/$MAXIM_DEPLOY_LOCK_FD" && -e "/proc/$BASHPID/fd/$PAIR_RELEASE_ADMISSION_FD" ]] || exit 93
    if flock -n -E 75 ${quote(join(directory, 'product.lock'))} true; then exit 94; else [[ "$?" == 75 ]] || exit 95; fi
    if flock -n -E 75 ${quote(join(directory, 'pair.lock'))} true; then exit 96; else [[ "$?" == 75 ]] || exit 97; fi
    printf '%s\\n' ${quote(plan)}
    exit ${imageStatus}
    ;;
  *) event RUNTIME; exit 98 ;;
esac
`,
  );
  chmodSync(fakeDeploy, 0o700);
  writeFileSync(
    join(directory, 'deploy-lock.sh'),
    `acquire_deploy_lock() {
  event LOCK
  MAXIM_DEPLOY_ADMISSION_REFUSAL=${quote(lock)}
  [[ "$MAXIM_DEPLOY_ADMISSION_REFUSAL" == none ]] || return 1
  exec {MAXIM_DEPLOY_LOCK_FD}<>${quote(join(directory, 'product.lock'))} || return
  flock -n "$MAXIM_DEPLOY_LOCK_FD" || return
  exec {PAIR_RELEASE_ADMISSION_FD}<>${quote(join(directory, 'pair.lock'))} || return
  flock -n "$PAIR_RELEASE_ADMISSION_FD" || return
  export MAXIM_DEPLOY_LOCK_FD PAIR_RELEASE_ADMISSION_FD
  export MAXIM_DEPLOY_LOCK_OWNER_PID="$BASHPID" PAIR_RELEASE_ADMISSION_OWNER_PID="$BASHPID"
  export MAXIM_DEPLOY_LOCK_VERSION=flock-v1
}
release_deploy_lock() {
  event RELEASE
  [[ ${releaseStatus} == 0 ]] || return ${releaseStatus}
  exec {MAXIM_DEPLOY_LOCK_FD}>&-
  exec {PAIR_RELEASE_ADMISSION_FD}>&-
}
return ${sourceStatus}
`,
  );
  writeFileSync(
    join(directory, 'legacy-cold-maintenance.sh'),
    `maxim_require_ordinary_effect_authority() {
  [[ "$1" == ${quote(bundle)} ]] || return 99
  event AUTHORITY
  return ${authorityStatus}
}
`,
  );
  const harness = `builtin source ${quote(scriptPath)}
event() { printf '%s\\n' "$1" >>${quote(join(directory, 'events'))}; }
cd() {
  [[ "$#" == 1 && "$1" == /var/www/Chat_bot ]] || return 90
  event CWD
  builtin cd ${quote(controller)}
}
pwd() { printf '%s\\n' /var/www/Chat_bot; }
source() {
  case "$1" in
    ${bundle}/infra/scripts/lib/deploy-lock.sh)
      event SOURCE_LOCK
      builtin source ${quote(join(directory, 'deploy-lock.sh'))}
      ;;
    ${bundle}/infra/scripts/lib/legacy-cold-maintenance.sh)
      event SOURCE_AUTHORITY
      builtin source ${quote(join(directory, 'legacy-cold-maintenance.sh'))}
      ;;
    *) return 89 ;;
  esac
}
node() {
  if [[ "$1" == -e ]]; then event NODE24; return ${nodeStatus}; fi
  [[ "$1" == ${quote(admission)} && "$3" == ${quote(id)} && "$4" == ${quote(requestHash)} ]] || return 87
  if [[ "$2" == reconcile ]]; then
    [[ "$#" == 5 && "$5" == ${quote(manifestHash)} ]] || return 86
  else
    [[ "$#" == 4 ]] || return 86
  fi
  case "$2" in
    preflight)
      event PREFLIGHT
      [[ -z "\${MAXIM_DEPLOY_LOCK_FD:-}\${PAIR_RELEASE_ADMISSION_FD:-}" ]] || return 88
      if [[ ${preflightStatus} == 86 ]]; then
        printf '%s\\n' ${quote(JSON.stringify({ schemaVersion: 1, event: 'SAFE_REFUSAL', id, requestHash, reasonCode: 'SOURCE_NOT_CURRENT_MAIN' }))} >&3
      fi
      return ${preflightStatus}
      ;;
    snapshot)
      event SNAPSHOT
      [[ -e "/proc/$BASHPID/fd/$MAXIM_DEPLOY_LOCK_FD" && -e "/proc/$BASHPID/fd/$PAIR_RELEASE_ADMISSION_FD" ]] || return 89
      local input
      input="$(cat)" || return
      printf '%s' "$input" >${quote(join(directory, 'snapshot-input'))}
      [[ "$input" == ${quote(plan)} ]] || return 90
      return ${snapshotStatus}
      ;;
    result)
      event RESULT
      [[ -e "/proc/$BASHPID/fd/$MAXIM_DEPLOY_LOCK_FD" && -e "/proc/$BASHPID/fd/$PAIR_RELEASE_ADMISSION_FD" ]] || return 91
      return ${resultStatus}
      ;;
    reconcile)
      event RECONCILE
      [[ -e "/proc/$BASHPID/fd/$MAXIM_DEPLOY_LOCK_FD" && -e "/proc/$BASHPID/fd/$PAIR_RELEASE_ADMISSION_FD" ]] || return 91
      printf '%s\\n' ${quote(JSON.stringify({ schemaVersion: 1, kind: 'RECOVERED', evidenceSha256: 'd'.repeat(64), manifestSha256: manifestHash }))}
      return ${reconcileStatus}
      ;;
    *) return 92 ;;
  esac
}
maxim_release_prepare_main ${args.map(quote).join(' ')}
`;
  const child = spawn('/bin/bash', ['--noprofile', '--norc', '-c', harness], {
    env: {
      PATH: '/usr/local/bin:/usr/bin:/bin',
      HOME: '/var/lib/maxim-release',
      LANG: 'C.UTF-8',
      GIT_NO_REPLACE_OBJECTS: '1',
      GIT_TERMINAL_PROMPT: '0',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  let control = '';
  child.stdout.setEncoding('utf8').on('data', (chunk) => {
    stdout += chunk;
  });
  child.stderr.setEncoding('utf8').on('data', (chunk) => {
    stderr += chunk;
  });
  child.stdio[3].setEncoding('utf8').on('data', (chunk) => {
    control += chunk;
  });
  const timeout = setTimeout(() => child.kill('SIGKILL'), 5_000);
  try {
    const exitCode = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', resolve);
    });
    const eventsPath = join(directory, 'events');
    const inputPath = join(directory, 'snapshot-input');
    return {
      exitCode,
      stdout,
      stderr,
      events: existsSync(eventsPath) ? readFileSync(eventsPath, 'utf8').trim().split('\n') : [],
      control: control.trim()
        ? control
            .trim()
            .split('\n')
            .map((line) => JSON.parse(line))
        : [],
      input: existsSync(inputPath) ? readFileSync(inputPath, 'utf8') : undefined,
    };
  } finally {
    clearTimeout(timeout);
    rmSync(directory, { recursive: true, force: true });
  }
}

test('preparation proves source before synchronization and snapshots the full plan under inherited locks', async () => {
  const result = await preparation();
  assert.equal(result.exitCode, 0, result.stderr);
  assert.deepEqual(result.events, [
    'NODE24',
    'CWD',
    'PREFLIGHT',
    'SYNC_PLAN',
    'SOURCE_LOCK',
    'SOURCE_AUTHORITY',
    'LOCK',
    'AUTHORITY',
    'IMAGE_PLAN',
    'SNAPSHOT',
    'RELEASE',
  ]);
  assert.equal(result.input, plan);
  assert.deepEqual(result.control, [{ schemaVersion: 1, event: 'PREPARED', id, requestHash }]);
  assert.ok(!result.events.includes('RUNTIME'));
});

test('preflight rejection preserves its correlation and prevents synchronization and lock acquisition', async () => {
  const result = await preparation({ preflightStatus: 86 });
  assert.equal(result.exitCode, 86, result.stderr);
  assert.deepEqual(result.events, ['NODE24', 'CWD', 'PREFLIGHT']);
  assert.deepEqual(result.control, [
    {
      schemaVersion: 1,
      event: 'SAFE_REFUSAL',
      id,
      requestHash,
      reasonCode: 'SOURCE_NOT_CURRENT_MAIN',
    },
  ]);
});

test('only typed pair and product lock conflicts produce retryable correlated refusals', async () => {
  for (const lock of ['pair_lock_busy', 'product_lock_busy']) {
    const result = await preparation({ lock });
    assert.equal(result.exitCode, 75, result.stderr);
    assert.deepEqual(result.control, [
      { schemaVersion: 1, event: 'SAFE_REFUSAL', id, requestHash, reasonCode: 'LOCK_BUSY' },
    ]);
    assert.ok(!result.events.includes('AUTHORITY'));
    assert.ok(!result.events.includes('SNAPSHOT'));
  }
  const unknown = await preparation({ lock: 'unknown' });
  assert.equal(unknown.exitCode, 1, unknown.stderr);
  assert.deepEqual(unknown.control, []);
  assert.ok(!unknown.events.includes('SNAPSHOT'));
});

test('source, planning, authority and snapshot failures propagate without PREPARED or runtime', async () => {
  for (const options of [
    { planStatus: 42 },
    { sourceStatus: 43 },
    { authorityStatus: 44 },
    { imageStatus: 45 },
    { snapshotStatus: 46 },
  ]) {
    const result = await preparation(options);
    assert.equal(result.exitCode, Object.values(options)[0], result.stderr);
    assert.deepEqual(result.control, []);
    assert.ok(!result.events.includes('RUNTIME'));
    if (options.authorityStatus || options.imageStatus || options.snapshotStatus)
      assert.equal(result.events.at(-1), 'RELEASE');
    if (options.planStatus) assert.ok(!result.events.includes('SOURCE_LOCK'));
    if (options.sourceStatus) assert.ok(!result.events.includes('LOCK'));
    if (options.authorityStatus) assert.ok(!result.events.includes('IMAGE_PLAN'));
    if (options.imageStatus) assert.ok(!result.events.includes('SNAPSHOT'));
  }
});

test('result verifies installed evidence under locks without synchronization or runtime', async () => {
  const result = await preparation({ action: 'result' });
  assert.equal(result.exitCode, 0, result.stderr);
  assert.deepEqual(result.events, [
    'NODE24',
    'CWD',
    'SOURCE_LOCK',
    'SOURCE_AUTHORITY',
    'LOCK',
    'RESULT',
    'RELEASE',
  ]);
  assert.deepEqual(result.control, []);
  const failed = await preparation({ action: 'result', resultStatus: 47 });
  assert.equal(failed.exitCode, 47, failed.stderr);
  assert.deepEqual(failed.control, []);
  assert.equal(failed.events.at(-1), 'RELEASE');
});

test('result lock failures remain unclassified and cleanup failure cannot report success', async () => {
  for (const lock of ['pair_lock_busy', 'product_lock_busy', 'unknown']) {
    const result = await preparation({ action: 'result', lock });
    assert.equal(result.exitCode, 1, result.stderr);
    assert.deepEqual(result.control, []);
    assert.ok(!result.events.includes('RESULT'));
  }
  const cleanup = await preparation({ action: 'result', releaseStatus: 48 });
  assert.equal(cleanup.exitCode, 70, cleanup.stderr);
});

test('privileged reconciliation requires held fences and ordinary authority without synchronization or runtime', async () => {
  const result = await preparation({ action: 'reconcile' });
  assert.equal(result.exitCode, 0, result.stderr);
  assert.deepEqual(result.events, [
    'NODE24',
    'CWD',
    'SOURCE_LOCK',
    'SOURCE_AUTHORITY',
    'LOCK',
    'AUTHORITY',
    'RECONCILE',
    'RELEASE',
  ]);
  assert.equal(JSON.parse(result.stdout).manifestSha256, manifestHash);
  assert.deepEqual(result.control, []);
  for (const options of [{ lock: 'unknown' }, { authorityStatus: 49 }, { reconcileStatus: 50 }]) {
    const failed = await preparation({ action: 'reconcile', ...options });
    assert.notEqual(failed.exitCode, 0);
    assert.deepEqual(failed.control, []);
    assert.ok(!failed.events.includes('SYNC_PLAN'));
    assert.ok(!failed.events.includes('RUNTIME'));
  }
});

test('invalid identity, arity, Node version and environment stop before installed admission', async () => {
  for (const args of [
    ['prepare', id, requestHash],
    ['prepare', id, requestHash, sha, 'extra'],
    ['runtime', id, requestHash, sha],
    ['prepare', id.toUpperCase(), requestHash, sha],
    ['prepare', id, 'x'.repeat(64), sha],
    ['prepare', id, requestHash, sha.slice(1)],
    ['reconcile', id, requestHash, sha],
    ['reconcile', id, requestHash, sha, 'invalid'],
  ]) {
    const result = await preparation({ args });
    assert.equal(result.exitCode, 64, result.stderr);
    assert.deepEqual(result.events, []);
    assert.deepEqual(result.control, []);
  }
  const oldNode = await preparation({ nodeStatus: 1 });
  assert.equal(oldNode.exitCode, 70, oldNode.stderr);
  assert.deepEqual(oldNode.events, ['NODE24']);
  for (const env of [
    { MAXIM_RELEASE_STATE_DIR: '/tmp/override' },
    { NODE_OPTIONS: '--trace-warnings' },
    { HOME: '/tmp/override' },
    { GIT_NO_REPLACE_OBJECTS: '0' },
  ]) {
    const result = await preparation({ env });
    assert.equal(result.exitCode, 70, result.stderr);
    assert.deepEqual(result.events, []);
    assert.deepEqual(result.control, []);
  }
});
