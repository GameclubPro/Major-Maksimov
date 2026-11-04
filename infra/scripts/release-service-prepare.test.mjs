import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
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
import { parseImagePreparationPlan } from './registry-preload.mjs';

const scriptPath = fileURLToPath(new URL('./release-service-prepare.sh', import.meta.url));
const deployScript = readFileSync(new URL('./vps-pull-build-up.sh', import.meta.url), 'utf8');
const id = '12345678-1234-4234-8234-123456789abc';
const requestHash = 'b'.repeat(64);
const sha = 'a'.repeat(40);
const manifestHash = 'c'.repeat(64);
const admission = '/usr/local/lib/maxim-release/infra/scripts/release-service-admission.mjs';
const bundle = '/usr/local/lib/maxim-release';
const httpsOrigin = 'https://github.com/GameclubPro/Major-Maksimov.git';
const sshOrigin = 'git@github.com:GameclubPro/Major-Maksimov.git';
const plan = `before plan\nMAXIM_IMAGE_PLAN={"schemaVersion":1,"sourceSha":"${sha}","components":["api-shared"]}\nafter plan`;

function quote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function deployFunction(name, next) {
  const start = deployScript.indexOf(`${name}() {\n`);
  const end = deployScript.indexOf(`\n${next}() {`, start);
  assert.ok(start >= 0 && end > start, `Missing deploy function: ${name}`);
  return deployScript.slice(start, end);
}

function actualImagePlanner(impact, controller, directory) {
  const components = ['api-shared', 'miniapp-major-static', 'admin-static', 'eraser'];
  assert.ok(impact.every((component) => components.includes(component)));
  const start = deployScript.indexOf('DEPLOY_MODE="manual"\n');
  const end = deployScript.indexOf('\nAPI_SERVICES=', start);
  assert.ok(start >= 0 && end > start, 'Missing real deploy argument parser');
  return `ROOT_DIR=${quote(controller)}
${deployScript.slice(start, end)}
printf '%s\\n' "$DEPLOY_MODE" "$IMAGE_PLAN_ONLY" "\${#SERVICES[@]}" >${quote(join(directory, 'planner-state'))}
${deployFunction('contains_service', 'validate_requested_services')}
${deployFunction('print_image_preparation_plan', 'has_requested_api_service')}
RELEASE_COMPONENTS=(${components.map(quote).join(' ')})
fixture_impact=(${impact.map(quote).join(' ')})
impact_plan_selects_component() {
  local component
  for component in "\${fixture_impact[@]}"; do
    if [[ "$1" == "$component" ]]; then return 0; fi
  done
  return 1
}
git() {
  [[ "$#" == 2 && "$1" == rev-parse && "$2" == HEAD ]] || return 83
  printf '%s\\n' ${quote(sha)}
}
node() { ${quote(process.execPath)} "$@"; }
print_image_preparation_plan`;
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
  origin = sshOrigin,
  gitRead = false,
  imagePlanImpact,
  env = {},
} = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'maxim-release-prepare-'));
  const controller = join(directory, 'controller');
  mkdirSync(join(controller, 'infra/scripts'), { recursive: true });
  const git = (args) => {
    const result = spawnSync(
      '/usr/bin/git',
      ['-C', controller, '-c', 'core.hooksPath=/dev/null', ...args],
      {
        encoding: 'utf8',
        timeout: 3000,
        env: {
          PATH: '/usr/bin:/bin',
          HOME: directory,
          LANG: 'C.UTF-8',
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_CONFIG_GLOBAL: '/dev/null',
          GIT_NO_REPLACE_OBJECTS: '1',
        },
      },
    );
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  const ssh = join(directory, 'git-read-ssh');
  const gitHelpers = join(directory, 'git-helpers');
  let originalConfig, remoteHead;
  if (gitRead) {
    const remote = join(directory, 'read-origin.git');
    git(['init', '--initial-branch=main']);
    git([
      '-c',
      'user.name=Release fixture',
      '-c',
      'user.email=fixture@example.invalid',
      'commit',
      '--allow-empty',
      '-qm',
      'Read fixture',
    ]);
    remoteHead = git(['rev-parse', 'HEAD']);
    git(['init', '--bare', '--initial-branch=main', remote]);
    git(['push', remote, 'main']);
    git(['remote', 'add', 'origin', origin]);
    originalConfig = readFileSync(join(controller, '.git/config'));
    writeFileSync(
      ssh,
      `#!/bin/bash
set -euo pipefail
printf '%s\\0' "$@" >>${quote(join(directory, 'ssh-arguments'))}
[[ "$#" == 2 && "$1" == git@github.com && "$2" == ${quote("git-upload-pack 'GameclubPro/Major-Maksimov.git'")} ]] || exit 85
exec /usr/bin/git upload-pack ${quote(remote)}
`,
      { mode: 0o700 },
    );
    mkdirSync(gitHelpers);
    writeFileSync(
      join(gitHelpers, 'git-remote-https'),
      `#!/bin/bash
set -euo pipefail
printf '%s\\0' "$@" >>${quote(join(directory, 'https-arguments'))}
[[ "$#" == 2 && "$1" == origin && "$2" == ${quote(httpsOrigin)} ]] || exit 84
while IFS= read -r command; do
  case "$command" in
    capabilities) printf '\\n' ;;
    list) printf '%s refs/heads/main\\n\\n' ${quote(remoteHead)} ;;
    '') exit 0 ;;
    *) exit 83 ;;
  esac
done
`,
      { mode: 0o700 },
    );
  }
  const fakeDeploy = join(controller, 'infra/scripts/vps-pull-build-up.sh');
  writeFileSync(
    fakeDeploy,
    `#!/bin/bash
set -euo pipefail
event() { printf '%s\\n' "$1" >>${quote(join(directory, 'events'))}; }
[[ "$1" == main && "$MAXIM_EXPECTED_DEPLOY_SHA" == ${quote(sha)} ]] || exit 90
if [[ ${quote(origin)} == ${quote(httpsOrigin)} ]]; then
  [[ -z "\${GIT_SSH_COMMAND:-}" ]] || exit 89
else
  [[ "$GIT_SSH_COMMAND" == ${quote(`${bundle}/infra/scripts/release-service-git-ssh.sh`)} ]] || exit 89
fi
[[ -z "\${GIT_CONFIG_COUNT:-}\${GIT_CONFIG_KEY_0:-}\${GIT_CONFIG_VALUE_0:-}" ]] || exit 88
if [[ ${gitRead} == true ]]; then
  [[ "$(/usr/bin/git remote get-url origin)" == ${quote(origin)} ]] || exit 87
  [[ "$(/usr/bin/git config --local --get remote.origin.url)" == ${quote(origin)} ]] || exit 86
  if [[ ${quote(origin)} == ${quote(httpsOrigin)} ]]; then
    GIT_EXEC_PATH=${quote(gitHelpers)} /usr/bin/git ls-remote --exit-code origin refs/heads/main >>${quote(join(directory, 'git-readbacks'))}
  else
    GIT_SSH_COMMAND=${quote(ssh)} GIT_SSH_VARIANT=simple /usr/bin/git ls-remote --exit-code origin refs/heads/main >>${quote(join(directory, 'git-readbacks'))}
  fi
fi
case "$*" in
  'main --plan')
    event SYNC_PLAN
    [[ -z "\${MAXIM_DEPLOY_LOCK_FD:-}\${PAIR_RELEASE_ADMISSION_FD:-}" ]] || exit 91
    exit ${planStatus}
    ;;
  'main --image-plan'|'main --auto --image-plan')
    event IMAGE_PLAN
    printf '%s\\0' "$@" >${quote(join(directory, 'image-plan-arguments'))}
    [[ "$MAXIM_DEPLOY_LOCK_OWNER_PID" == "$BASHPID" && "$PAIR_RELEASE_ADMISSION_OWNER_PID" != "$BASHPID" ]] || exit 92
    [[ -e "/proc/$BASHPID/fd/$MAXIM_DEPLOY_LOCK_FD" && -e "/proc/$BASHPID/fd/$PAIR_RELEASE_ADMISSION_FD" ]] || exit 93
    if flock -n -E 75 ${quote(join(directory, 'product.lock'))} true; then exit 94; else [[ "$?" == 75 ]] || exit 95; fi
    if flock -n -E 75 ${quote(join(directory, 'pair.lock'))} true; then exit 96; else [[ "$?" == 75 ]] || exit 97; fi
    ${imagePlanImpact === undefined ? `printf '%s\\n' ${quote(plan)}` : actualImagePlanner(imagePlanImpact, controller, directory)}
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
git() {
  [[ "$*" == 'remote get-url origin' ]] || return 84
  if [[ ${gitRead} == true ]]; then /usr/bin/git "$@"; else printf '%s\\n' ${quote(origin)}; fi
}
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
  [[ -z "\${GIT_CONFIG_COUNT:-}\${GIT_CONFIG_KEY_0:-}\${GIT_CONFIG_VALUE_0:-}\${GIT_SSH_COMMAND:-}" ]] || return 85
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
      ${imagePlanImpact === undefined ? `[[ "$input" == ${quote(plan)} ]] || return 90` : ':'}
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
    const imageArgumentsPath = join(directory, 'image-plan-arguments');
    const plannerStatePath = join(directory, 'planner-state');
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
      imageArguments: existsSync(imageArgumentsPath)
        ? readFileSync(imageArgumentsPath, 'utf8').split('\0').slice(0, -1)
        : undefined,
      plannerState: existsSync(plannerStatePath)
        ? readFileSync(plannerStatePath, 'utf8').trim().split('\n')
        : undefined,
      gitEvidence: gitRead
        ? {
            originalConfig,
            finalConfig: readFileSync(join(controller, '.git/config')),
            persistedOrigin: git(['config', '--local', '--get', 'remote.origin.url']),
            parentOrigin: git(['remote', 'get-url', 'origin']),
            remoteHead,
            readbacks: existsSync(join(directory, 'git-readbacks'))
              ? readFileSync(join(directory, 'git-readbacks'), 'utf8').trim().split('\n')
              : [],
            sshArguments: existsSync(join(directory, 'ssh-arguments'))
              ? readFileSync(join(directory, 'ssh-arguments'), 'utf8').split('\0').slice(0, -1)
              : [],
            httpsArguments: existsSync(join(directory, 'https-arguments'))
              ? readFileSync(join(directory, 'https-arguments'), 'utf8').split('\0').slice(0, -1)
              : [],
          }
        : undefined,
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

for (const { name, impact } of [
  { name: 'no-op', impact: [] },
  { name: 'mini app only', impact: ['miniapp-major-static'] },
  { name: 'admin only', impact: ['admin-static'] },
  { name: 'shared API only', impact: ['api-shared'] },
  { name: 'Lastik only', impact: ['eraser'] },
  { name: 'mixed API, admin and Lastik', impact: ['api-shared', 'admin-static', 'eraser'] },
]) {
  test(`preparation snapshots the real cumulative image plan for ${name}`, async () => {
    const result = await preparation({ imagePlanImpact: impact, origin: httpsOrigin });
    assert.equal(result.exitCode, 0, result.stderr);
    assert.deepEqual(parseImagePreparationPlan(result.input, sha), impact);
    assert.deepEqual(result.imageArguments, ['main', '--auto', '--image-plan']);
    assert.deepEqual(result.plannerState, ['auto', '1', '0']);
    assert.deepEqual(result.control, [{ schemaVersion: 1, event: 'PREPARED', id, requestHash }]);
    assert.equal(result.events.at(-1), 'RELEASE');
    assert.ok(!result.events.includes('RUNTIME'));
  });
}

test('canonical HTTPS stays HTTPS and SSH uses the fixed transport without changing Git configuration', async () => {
  for (const origin of [httpsOrigin, sshOrigin]) {
    const result = await preparation({ gitRead: true, origin });
    assert.equal(result.exitCode, 0, result.stderr);
    assert.deepEqual(result.gitEvidence.finalConfig, result.gitEvidence.originalConfig);
    assert.equal(result.gitEvidence.persistedOrigin, origin);
    assert.equal(result.gitEvidence.parentOrigin, origin);
    assert.deepEqual(
      result.gitEvidence.readbacks,
      Array(2).fill(`${result.gitEvidence.remoteHead}\trefs/heads/main`),
    );
    assert.deepEqual(
      result.gitEvidence.sshArguments,
      origin === sshOrigin
        ? Array(2)
            .fill(['git@github.com', "git-upload-pack 'GameclubPro/Major-Maksimov.git'"])
            .flat()
        : [],
    );
    assert.deepEqual(
      result.gitEvidence.httpsArguments,
      origin === httpsOrigin ? Array(2).fill(['origin', httpsOrigin]).flat() : [],
    );
    assert.equal(result.events.filter((event) => event === 'SYNC_PLAN').length, 1);
    assert.equal(result.events.filter((event) => event === 'IMAGE_PLAN').length, 1);
    assert.ok(!result.events.includes('RUNTIME'));
  }
});

test('legacy and foreign controller origins cannot enter either preparation plan', async () => {
  for (const origin of [
    'https://github.com/GameclubPro/MAXIM.git',
    'git@github.com:attacker/repo.git',
  ]) {
    const result = await preparation({ origin });
    assert.equal(result.exitCode, 70, result.stderr);
    assert.deepEqual(result.events, ['NODE24', 'CWD', 'PREFLIGHT']);
    assert.deepEqual(result.control, []);
  }
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
    { GIT_SSH_COMMAND: '/untrusted/git-ssh' },
    { GIT_CONFIG_COUNT: '1' },
  ]) {
    const result = await preparation({ env });
    assert.equal(result.exitCode, 70, result.stderr);
    assert.deepEqual(result.events, []);
    assert.deepEqual(result.control, []);
  }
});
