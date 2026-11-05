import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const libraryPath = fileURLToPath(new URL('./lib/durable-release-executor.sh', import.meta.url));
const deploy = readFileSync(new URL('./vps-pull-build-up.sh', import.meta.url), 'utf8');
const library = readFileSync(libraryPath, 'utf8');
const operation = '12345678-1234-4234-8234-123456789abc';
const requestHash = 'b'.repeat(64);
const sha = 'a'.repeat(40);
const executorRoot = `/var/www/Chat_bot/.release-executors/${operation}/source`;
const admissionPath = '/usr/local/lib/maxim-release/infra/scripts/release-service-admission.mjs';
const startupStart = deploy.indexOf('\nrequire_node_24\n');
const startupEnd = deploy.indexOf(
  '\nensure_compose_env\nprepare_retention_deploy_mode',
  startupStart,
);
assert.ok(startupStart > 0 && startupEnd > startupStart);
const startup = deploy.slice(startupStart, startupEnd);

function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

async function executor({
  ack = 'valid',
  lock = 'none',
  helperStatus = 0,
  manifestStatus = 0,
  actualSha = sha,
  root = executorRoot,
  branch = false,
  dirty = false,
  statusFailure = false,
  envMode = 0o600,
  envSymlink = false,
  sourceSymlink = false,
  helperOwner = '0',
  ordinary = false,
  mode = 'auto',
  services = [],
  imagePlan = false,
  deployBranch = 'main',
  overrides = {},
} = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'maxim-durable-executor-'));
  const snapshot = join(directory, 'snapshot.env');
  const realSnapshot = join(directory, 'canonical.env');
  writeFileSync(realSnapshot, 'A_PRIVATE_SETTING=fixture\n', { mode: envMode });
  chmodSync(realSnapshot, envMode);
  if (envSymlink) symlinkSync(realSnapshot, snapshot);
  else {
    writeFileSync(snapshot, readFileSync(realSnapshot), { mode: envMode });
    // FLAG: Preserve the requested permission case under restrictive agent umasks.
    chmodSync(snapshot, envMode);
  }
  const environment = { ...process.env };
  // The installed daemon supplies an allowlisted environment. Fixtures must not
  // inherit a developer's Docker/Node/rollout overrides as implicit authorization.
  for (const key of Object.keys(environment)) {
    if (
      /^(?:MAXIM_|PAIR_RELEASE_|COMPOSE_|DOCKER_|GIT_|NODE_OPTIONS$|NODE_PATH$|STATISTICS_EXCHANGE_V3_ENABLED$)/u.test(
        key,
      )
    )
      delete environment[key];
  }
  Object.assign(environment, {
    FIXTURE_DIRECTORY: directory,
    FIXTURE_ENV_FILE: snapshot,
    FIXTURE_SHA: actualSha,
    FIXTURE_ROOT: root,
    FIXTURE_BRANCH: String(branch),
    FIXTURE_DIRTY: String(dirty),
    FIXTURE_STATUS_FAILURE: String(statusFailure),
    FIXTURE_SOURCE_SYMLINK: String(sourceSymlink),
    FIXTURE_HELPER_OWNER: helperOwner,
    FIXTURE_HELPER_STATUS: String(helperStatus),
    FIXTURE_MANIFEST_STATUS: String(manifestStatus),
    FIXTURE_LOCK: lock,
    FIXTURE_ORDINARY: String(ordinary),
    MAXIM_DURABLE_RELEASE_OPERATION: ordinary ? '' : operation,
    MAXIM_DURABLE_RELEASE_REQUEST_HASH: ordinary ? '' : requestHash,
    MAXIM_EXPECTED_DEPLOY_SHA: sha,
    ...overrides,
  });
  const script = `source ${shellQuote(libraryPath)}
ROOT_DIR="$FIXTURE_ROOT"
BRANCH=${shellQuote(deployBranch)}
DEPLOY_MODE=${shellQuote(mode)}
IMAGE_PLAN_ONLY=${imagePlan ? '1' : '0'}
SERVICES=(${services.map(shellQuote).join(' ')})
RELEASE_STATE_DIR="\${MAXIM_RELEASE_STATE_DIR:-/var/lib/maxim-deploy}"
EXPECTED_DEPLOY_SHA="$MAXIM_EXPECTED_DEPLOY_SHA"
RECOVERY_BASE_MANIFEST=''
MAXIM_WEBHOOK_ROLLOUT_CONTROL_HELPER="$ROOT_DIR/infra/scripts/webhook-queue-rollout-control.cjs"
MAXIM_PHOTO_NATIVE_BOUNDARY_HELPER="$ROOT_DIR/infra/scripts/photo-native-runtime-boundary.cjs"
event() { printf '%s\\n' "$1" >>"$FIXTURE_DIRECTORY/events"; }
pwd() { printf '%s\\n' "$ROOT_DIR"; }
stat() {
  local path="\${@: -1}"
  case "$path" in
    "$ROOT_DIR/.env") command stat -c "$2" -- "$FIXTURE_ENV_FILE" ;;
    ${admissionPath}) printf 'regular file|%s|444|1\\n' "$FIXTURE_HELPER_OWNER" ;;
    /usr|/usr/*) printf 'directory|0|755\\n' ;;
    "$ROOT_DIR")
      if [[ "$FIXTURE_SOURCE_SYMLINK" == true ]]; then printf 'symbolic link\\n'; else printf 'directory\\n'; fi
      ;;
    *) printf 'directory\\n' ;;
  esac
}
git() {
  event "GIT:$*"
  case "$1" in
    rev-parse) printf '%s\\n' "$FIXTURE_SHA" ;;
    symbolic-ref) [[ "$FIXTURE_BRANCH" == true ]] ;;
    diff) [[ "$FIXTURE_DIRTY" == false ]] ;;
    status)
      if [[ "$FIXTURE_STATUS_FAILURE" == true ]]; then return 74; fi
      if [[ "$FIXTURE_DIRTY" == true ]]; then printf ' M tracked-input\\n'; fi
      return 0
      ;;
    *) event GIT_WRITE; return 93 ;;
  esac
}
node() {
  [[ "$1" == ${admissionPath} && "$2" == admit && "$3" == "$MAXIM_DURABLE_RELEASE_OPERATION" &&
     "$4" == "$MAXIM_DURABLE_RELEASE_REQUEST_HASH" && "$5" == "$ROOT_DIR" ]] || return 94
  local plan
  plan="$(cat)" || return
  [[ "$plan" == 'MAXIM_IMAGE_PLAN={"schemaVersion":1,"sourceSha":"${sha}","components":["api-shared"]}' ]] || return 95
  event ADMISSION
  if [[ "$FIXTURE_HELPER_STATUS" == 86 ]]; then
    printf '{"schemaVersion":1,"event":"SAFE_REFUSAL","id":"%s","requestHash":"%s","reasonCode":"CANDIDATE_CHANGED"}\\n' \
      "$MAXIM_DURABLE_RELEASE_OPERATION" "$MAXIM_DURABLE_RELEASE_REQUEST_HASH" >&3
    return 86
  fi
  if [[ "$FIXTURE_HELPER_STATUS" != 0 ]]; then return "$FIXTURE_HELPER_STATUS"; fi
  printf '{"schemaVersion":1,"event":"READY","id":"%s","requestHash":"%s"}\\n' \
    "$MAXIM_DURABLE_RELEASE_OPERATION" "$MAXIM_DURABLE_RELEASE_REQUEST_HASH" >&3
}
acquire_deploy_lock() {
  if [[ "$FIXTURE_LOCK" != none ]]; then
    MAXIM_DEPLOY_ADMISSION_REFUSAL="$FIXTURE_LOCK"
    return 1
  fi
  event LOCK
}
cleanup() { :; }
maxim_require_ordinary_effect_authority() { event AUTHORITY; }
require_market_statistics_lock_dispatch() { event "COMPAT:market:$1"; }
require_pair_release_admission_dispatch() { event "COMPAT:pair:$1"; }
maxim_topology_require_statistics_authority_lifecycle() { event "COMPAT:statistics:$1"; }
maxim_topology_require_eraser_bridge() { event "COMPAT:bridge:$1"; }
maxim_topology_require_eraser_rate_limit_reader() { event "COMPAT:rate:$1:$2"; }
maxim_topology_require_eraser_connection_proof_reader() { event "COMPAT:proof:$1:$2"; }
verify_expected_deploy_sha() { event VERIFY; }
sync_branch() { event SYNC; }
reexec_if_current_script_changed() { event REEXEC; }
release_manifest() {
  [[ "$*" == validate-current ]] || return 96
  event MANIFEST
  return "$FIXTURE_MANIFEST_STATUS"
}
load_current_component_images() { event IMAGES; }
print_image_preparation_plan() {
  printf 'MAXIM_IMAGE_PLAN={"schemaVersion":1,"sourceSha":"${sha}","components":["api-shared"]}\\n'
}
require_node_24() { :; }
require_production_branch_confirmation() { :; }
validate_requested_services() { :; }
validate_api_ready_timeout() { :; }
validate_post_release_reclaim() { :; }
validate_retention_deploy_mode() { :; }
maxim_topology_requested_commercial_ocr_deploy_mode() { :; }
validate_commercial_ai_deploy_flag() { :; }
validate_commercial_ai_pool_deploy_flags() { :; }
validate_statistics_exchange_deploy_flag() { :; }
validate_statistics_central_deploy_epoch() { :; }
${startup}
event MUTATION
printf 'MUTATION\\n'
if [[ "$FIXTURE_ORDINARY" != true ]]; then
  if { : >&3; } 2>/dev/null; then event FD3_LEAK; fi
  if { : <&4; } 2>/dev/null; then event FD4_LEAK; fi
fi
`;
  try {
    const child = spawn('bash', ['-euo', 'pipefail', '-c', script], {
      env: environment,
      stdio: ['ignore', 'pipe', 'pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let pending = '';
    let acknowledgmentSent = ordinary;
    let mutationBeforeAck = false;
    const messages = [];
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      if (stdout.includes('MUTATION') && !acknowledgmentSent) mutationBeforeAck = true;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.stdio[4].on('error', () => {});
    child.stdio[3].on('data', (chunk) => {
      pending += chunk.toString('utf8');
      while (pending.includes('\n')) {
        const end = pending.indexOf('\n');
        const message = JSON.parse(pending.slice(0, end));
        pending = pending.slice(end + 1);
        messages.push(message);
        if (message.event !== 'READY') continue;
        if (ack === 'eof') child.stdio[4].end();
        else {
          acknowledgmentSent = true;
          const value =
            ack === 'valid'
              ? `PROCEED:${operation}:${requestHash}\n`
              : ack === 'unterminated'
                ? `PROCEED:${operation}:${requestHash}`
                : `PROCEED:99999999-9999-4999-8999-999999999999:${requestHash}\n`;
          child.stdio[4].end(value);
        }
      }
    });
    const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
    const { code, signal } = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => resolve({ code, signal }));
    });
    clearTimeout(timer);
    let events = [];
    try {
      events = readFileSync(join(directory, 'events'), 'utf8').trim().split('\n');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    return { code, signal, stdout, stderr, messages, events, mutationBeforeAck };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function noMutation(result) {
  assert.equal(result.signal, null, result.stderr);
  assert.ok(!result.events.includes('MUTATION'), result.events.join('\n'));
  assert.ok(!result.events.includes('GIT_WRITE'), result.events.join('\n'));
  assert.ok(!result.events.includes('SYNC') && !result.events.includes('REEXEC'));
}

test('immutable executor keeps exact source checks and waits for request-bound authorization', async () => {
  const result = await executor();
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.mutationBeforeAck, false);
  assert.deepEqual(result.messages, [
    { schemaVersion: 1, event: 'READY', id: operation, requestHash },
  ]);
  assert.equal(result.events.filter((value) => value === 'MUTATION').length, 1);
  assert.ok(result.events.includes(`COMPAT:pair:${sha}`));
  assert.ok(result.events.includes(`COMPAT:proof:${sha}:tooling`));
  assert.ok(
    !result.events.some((value) =>
      ['SYNC', 'REEXEC', 'GIT_WRITE', 'FD3_LEAK', 'FD4_LEAK'].includes(value),
    ),
  );
});

for (const ack of ['eof', 'foreign', 'unterminated']) {
  test(`READY followed by ${ack} authorization cannot enter runtime`, async () => {
    const result = await executor({ ack });
    assert.equal(result.code, 70, result.stderr);
    assert.equal(result.messages[0]?.event, 'READY');
    noMutation(result);
  });
}

test('foreign checkout, stale SHA, branch and tracked changes stop before admission', async () => {
  for (const options of [
    { root: '/var/www/Chat_bot' },
    { actualSha: 'c'.repeat(40) },
    { branch: true },
    { dirty: true },
    { sourceSymlink: true },
    { statusFailure: true },
  ]) {
    const result = await executor(options);
    assert.notEqual(result.code, 0, result.stderr);
    assert.deepEqual(result.messages, []);
    noMutation(result);
  }
});

test('configuration changes, source overrides and recovery adoption require another protocol', async () => {
  for (const overrides of [
    { MAXIM_MESSAGE_RETENTION_MODE: 'on' },
    { MAXIM_COMMERCIAL_LLM_POOL_ENABLED: 'false' },
    { MAXIM_WEBHOOK_ROLLOUT_ADOPT_EXISTING_PAUSE: '1' },
    { MAXIM_COMPOSE_SERVICE_ENV_FILE: '/another.env' },
    { MAXIM_RELEASE_STATE_DIR: '/another-state' },
    { GIT_DIR: '/another.git' },
    { COMPOSE_FILE: '/another.yml' },
  ]) {
    const result = await executor({ overrides });
    assert.equal(result.code, 70, result.stderr);
    assert.deepEqual(result.messages, []);
    noMutation(result);
  }
});

test('service release accepts only main auto mode without explicit services or plan overrides', async () => {
  for (const options of [
    { mode: 'full' },
    { services: ['api-ingress'] },
    { imagePlan: true },
    { deployBranch: 'another-branch' },
  ]) {
    const result = await executor(options);
    assert.equal(result.code, 70, result.stderr);
    assert.deepEqual(result.messages, []);
    noMutation(result);
  }
});

test('configuration snapshots reject symlinks and nonprivate permissions', async () => {
  for (const options of [{ envSymlink: true }, { envMode: 0o644 }]) {
    const result = await executor(options);
    assert.equal(result.code, 70, result.stderr);
    assert.deepEqual(result.messages, []);
    noMutation(result);
  }
});

test('complete manifest and root-owned installed admission are prerequisites for READY', async () => {
  for (const options of [{ manifestStatus: 1 }, { helperOwner: '12345' }]) {
    const result = await executor(options);
    assert.notEqual(result.code, 0, result.stderr);
    assert.deepEqual(result.messages, []);
    noMutation(result);
  }
});

test('positive admission refusal stays typed while an unknown helper failure stays ambiguous', async () => {
  const refused = await executor({ helperStatus: 86 });
  assert.equal(refused.code, 86, refused.stderr);
  assert.deepEqual(refused.messages, [
    {
      schemaVersion: 1,
      event: 'SAFE_REFUSAL',
      id: operation,
      requestHash,
      reasonCode: 'CANDIDATE_CHANGED',
    },
  ]);
  noMutation(refused);
  const unknown = await executor({ helperStatus: 74 });
  assert.equal(unknown.code, 74, unknown.stderr);
  assert.deepEqual(unknown.messages, []);
  noMutation(unknown);
});

test('only positively classified pair/product lock conflicts produce retryable refusal', async () => {
  for (const lock of ['pair_lock_busy', 'product_lock_busy']) {
    const result = await executor({ lock });
    assert.equal(result.code, 75, result.stderr);
    assert.deepEqual(result.messages, [
      {
        schemaVersion: 1,
        event: 'SAFE_REFUSAL',
        id: operation,
        requestHash,
        reasonCode: 'LOCK_BUSY',
      },
    ]);
    noMutation(result);
  }
  const unknown = await executor({ lock: 'unknown' });
  assert.equal(unknown.code, 1, unknown.stderr);
  assert.deepEqual(unknown.messages, []);
  noMutation(unknown);
});

test('ordinary delivery retains its existing synchronization and re-execution branch', async () => {
  const result = await executor({ ordinary: true });
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(result.messages, []);
  assert.ok(
    result.events.includes('SYNC') &&
      result.events.includes('VERIFY') &&
      result.events.includes('REEXEC'),
  );
  assert.match(
    deploy,
    /sync_branch\n\s+verify_expected_deploy_sha\n\s+reexec_if_current_script_changed\n/u,
  );
  assert.ok(
    deploy.indexOf('reexec_if_current_script_changed\n') <
      deploy.indexOf('maxim_eraser_install_connection_proof_reader_floor "$TARGET_SHA"'),
  );
  assert.match(
    library,
    /MAXIM_DURABLE_RELEASE_EXECUTOR_PROTOCOL=maxim-durable-release-executor-v1/u,
  );
  assert.match(library, /read -r -t 30 -n 110 acknowledgment <&4/u);
  assert.match(
    readFileSync(new URL('../../.gitignore', import.meta.url), 'utf8'),
    /^\/\.release-executors\/$/mu,
  );
});
