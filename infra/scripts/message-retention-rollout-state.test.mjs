import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  linkSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';
import {
  patchRetentionEnv,
  patchRetentionEnvFile,
  readRetentionEnv,
  verifyRetentionCompose,
  verifyRetentionRuntimeEnv,
} from './message-retention-rollout-state.mjs';

const root = resolve(import.meta.dirname, '../..');
const helper = resolve(import.meta.dirname, 'message-retention-rollout-state.mjs');
const deploy = readFileSync(resolve(root, 'infra/scripts/vps-pull-build-up.sh'), 'utf8');
const connect = readFileSync(resolve(root, 'infra/scripts/vps-connect.sh'), 'utf8');
const topology = readFileSync(resolve(root, 'infra/scripts/lib/deploy-topology.sh'), 'utf8');
const services = [
  ...topology.match(/MAXIM_PRODUCTION_API_SERVICES=\(\n([\s\S]*?)\n\)/u)[1].matchAll(/"([^"]+)"/gu),
].map((match) => match[1]);

function block(source, name) {
  const start = source.indexOf(`${name}() {`);
  assert.ok(start >= 0, name);
  const end = source.indexOf('\n}', start);
  assert.ok(end > start, name);
  return source.slice(start, end + 2);
}

function shell(source, env = {}) {
  const result = spawnSync('bash', ['-c', `set -euo pipefail\n${source}`], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  assert.equal(result.error, undefined, result.stderr);
  assert.equal(result.signal, null, result.stderr);
  return result;
}

function fixture(t) {
  const directory = mkdtempSync(resolve(tmpdir(), 'maxim-retention-env-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = resolve(directory, '.env');
  const contents =
    'SECRET=do not expand $(touch /tmp/never)\nMESSAGE_RETENTION_MODE=off\nOTHER=with spaces\n';
  writeFileSync(path, contents, { mode: 0o640 });
  return { directory, path, contents };
}

test('patches only the mode while preserving unrelated bytes, BOM, CRLF and final newline', () => {
  for (const prefix of ['', '\uFEFF']) {
    for (const ending of ['\n', '\r\n']) {
      for (const final of ['', ending]) {
        const contents = `${prefix}SECRET="unchanged spaces"${ending} export MESSAGE_RETENTION_MODE = off${ending}MESSAGE_RETENTION_CANARY_CHAT_IDS=-123${final}`;
        const expected = `${prefix}SECRET="unchanged spaces"${ending}MESSAGE_RETENTION_MODE=on${ending}MESSAGE_RETENTION_CANARY_CHAT_IDS=-123${final}`;
        assert.equal(patchRetentionEnv(contents, 'on'), expected);
      }
    }
  }
  assert.equal(
    patchRetentionEnv('\uFEFFMESSAGE_RETENTION_MODE=off\r\n', 'on'),
    '\uFEFFMESSAGE_RETENTION_MODE=on\r\n',
  );
  assert.equal(
    patchRetentionEnv('SECRET=value', 'off'),
    'SECRET=value\nMESSAGE_RETENTION_MODE=off\n',
  );
  assert.equal(readRetentionEnv('SECRET=value\n'), 'off');
});

test('rejects duplicate, malformed, oversized, NUL and invalid UTF8 values without widening scope', () => {
  for (const contents of [
    'MESSAGE_RETENTION_MODE=off\nexport MESSAGE_RETENTION_MODE=on\n',
    'MESSAGE_RETENTION_MODE=private-invalid-mode\n',
    'MESSAGE_RETENTION_MODE=on # ambiguous\n',
    'SECRET=\0\n',
    Buffer.from([0xff]),
    'X'.repeat(1024 * 1024 + 1),
  ])
    assert.throws(() => patchRetentionEnv(contents, 'on'));
  for (const mode of ['canary', 'shadow', '*', '', 'ON']) {
    assert.throws(() => patchRetentionEnv('', mode));
  }
});

test('atomically replaces an owned dotenv preserving its permissions and all unrelated bytes', (t) => {
  const data = fixture(t);
  const previous = statSync(data.path);
  patchRetentionEnvFile(data.path, 'on');
  assert.equal(readFileSync(data.path, 'utf8'), data.contents.replace('MODE=off', 'MODE=on'));
  const current = statSync(data.path);
  assert.equal(current.mode & 0o777, previous.mode & 0o777);
  assert.equal(current.uid, previous.uid);
  assert.equal(current.gid, previous.gid);
  assert.notEqual(current.ino, previous.ino);
  assert.deepEqual(readdirSync(data.directory), ['.env']);
  patchRetentionEnvFile(data.path, 'on');
  assert.equal(statSync(data.path).ino, current.ino);
});

test('refuses symlinks, hardlinks and writable dotenv files without mutating the target', (t) => {
  const data = fixture(t);
  const symbolic = resolve(data.directory, 'symbolic');
  symlinkSync(data.path, symbolic);
  assert.throws(() => patchRetentionEnvFile(symbolic, 'on'));
  const hard = resolve(data.directory, 'hard');
  linkSync(data.path, hard);
  assert.throws(() => patchRetentionEnvFile(data.path, 'on'));
  rmSync(hard);
  chmodSync(data.path, 0o666);
  assert.throws(() => patchRetentionEnvFile(data.path, 'on'));
  assert.equal(readFileSync(data.path, 'utf8'), data.contents);
});

test('refuses a malformed file without replacing it or disclosing values on the CLI', (t) => {
  const data = fixture(t);
  const contents = data.contents.replace('MODE=off', 'MODE=private-invalid-mode');
  writeFileSync(data.path, contents);
  const previous = statSync(data.path);
  const result = spawnSync(process.execPath, [helper, 'patch-env', data.path, 'on'], {
    encoding: 'utf8',
  });
  assert.equal(result.status, 1, result.stderr);
  assert.doesNotMatch(result.stdout + result.stderr, /private-invalid-mode|SECRET|do not expand/u);
  assert.equal(readFileSync(data.path, 'utf8'), contents);
  assert.equal(statSync(data.path).ino, previous.ino);
  assert.deepEqual(readdirSync(data.directory), ['.env']);
});

test('requires a complete Compose topology and exactly one explicit matching runtime mode', () => {
  const config = {
    services: Object.fromEntries(
      services.map((service) => [service, { environment: { MESSAGE_RETENTION_MODE: 'on' } }]),
    ),
  };
  assert.equal(services.length, 14);
  verifyRetentionCompose(config, 'on', services);
  for (const service of services) {
    const changed = structuredClone(config);
    changed.services[service].environment.MESSAGE_RETENTION_MODE = 'off';
    assert.throws(() => verifyRetentionCompose(changed, 'on', services));
  }
  assert.throws(() => verifyRetentionCompose(config, 'on', services.slice(1)));
  assert.throws(() => verifyRetentionCompose(config, 'on', Array(14).fill(services[0])));
  verifyRetentionRuntimeEnv(['SECRET=hidden', 'MESSAGE_RETENTION_MODE=on'], 'on');
  for (const value of [
    null,
    [],
    ['MESSAGE_RETENTION_MODE=off'],
    ['MESSAGE_RETENTION_MODE=on', 'MESSAGE_RETENTION_MODE=on'],
  ]) {
    assert.throws(() => verifyRetentionRuntimeEnv(value, 'on'));
  }
});

const connectorDoubles = `
${block(connect, 'prepare_registry_release_images')}
CONNECTOR_SHA=0000000000000000000000000000000000000001
CONNECTOR_CI_CALLS=0
CONNECTOR_SYNC_SEEN=0
CONNECTOR_PRELOADS=0
MAXIM_DEPLOY_EMERGENCY_BYPASS=0
maxim_validate_git_ssh_port() { [[ "$#" == 1 && "$1" == default ]]; }
git() {
  [[ "$#" == 4 && "$*" == 'rev-parse --verify --end-of-options main^{commit}' ]] || return 91
  printf '%s' "$CONNECTOR_SHA"
}
node() {
  if [[ "$#" == 4 && "$1" == scripts/ci/assert-green.mjs && "$2" == "$CONNECTOR_SHA" && "$3" == --purpose && "$4" == production ]]; then
    CONNECTOR_CI_CALLS=$((CONNECTOR_CI_CALLS + 1))
    [[ "$CONNECTOR_CI_CALLS" -le 2 ]] || return 92
    if [[ "$CONNECTOR_CI_CALLS" == 2 ]]; then
      [[ "$CONNECTOR_SYNC_SEEN" == 1 && "$CONNECTOR_PRELOADS" == 1 ]] || return 93
    fi
    printf 'CI:%s\\n' "$CONNECTOR_CI_CALLS" >&2
    [[ "\${CONNECTOR_FAIL_AT:-}" != "ci-$CONNECTOR_CI_CALLS" ]] || return 66
  elif [[ "$#" == 3 && "$1" == infra/scripts/registry-preload.mjs && "$2" == plan && "$3" == "$CONNECTOR_SHA" ]]; then
    command node "$@"
  else
    return 94
  fi
}
shell_quote_args() { printf '%s ' "$@"; }
prepend_webhook_rollout_recovery_env() { :; }
prepend_post_release_reclaim_env() { :; }
prepend_deploy_disk_floor_env() { :; }
prepend_deploy_ready_timeout_env() { :; }
maxim_prepend_git_ssh_transport() { :; }
connector_assert_runtime_command() {
  [[ "$#" == 1 && "$1" == *"MAXIM_EXPECTED_DEPLOY_SHA=$CONNECTOR_SHA "* && "$1" == *'./infra/scripts/vps-pull-build-up.sh main --auto '* ]] || return 95
  if [[ -n "\${MAXIM_MESSAGE_RETENTION_MODE:-}" ]]; then
    [[ "$1" == *"MAXIM_MESSAGE_RETENTION_MODE=$MAXIM_MESSAGE_RETENTION_MODE "* ]] || return 96
  else
    [[ "$1" != *'MAXIM_MESSAGE_RETENTION_MODE='* ]] || return 96
  fi
}
remote_exec() {
  [[ "$#" == 1 ]] || return 97
  if [[ "$1" == *' --plan ' ]]; then
    [[ "$CONNECTOR_CI_CALLS" == 1 && "$CONNECTOR_SYNC_SEEN" == 0 && "$1" == "MAXIM_EXPECTED_DEPLOY_SHA=$CONNECTOR_SHA ./infra/scripts/vps-pull-build-up.sh main --plan " ]] || return 98
    printf 'SYNC\\n' >&2
    [[ "\${CONNECTOR_FAIL_AT:-}" != sync ]] || return 67
    CONNECTOR_SYNC_SEEN=1
  elif [[ "$1" == *' --image-plan' ]]; then
    [[ "$CONNECTOR_CI_CALLS" == 1 && "$CONNECTOR_SYNC_SEEN" == 1 ]] || return 99
    connector_assert_runtime_command "$1" || return
    printf 'IMAGE_PLAN\\n' >&2
    [[ "\${CONNECTOR_FAIL_AT:-}" != image-plan ]] || return 68
    printf 'MAXIM_IMAGE_PLAN={"schemaVersion":1,"sourceSha":"%s","components":["api-shared"]}\\n' "$CONNECTOR_SHA"
  else
    [[ "$CONNECTOR_CI_CALLS" == 2 && "$CONNECTOR_SYNC_SEEN" == 1 && "$CONNECTOR_PRELOADS" == 1 ]] || return 100
    connector_assert_runtime_command "$1" || return
    printf 'RUNTIME\\n' >&2
    printf '%s' "$1"
  fi
}
preload_ci_image() {
  [[ "$#" == 2 && "$1" == api-shared && "$2" == "$CONNECTOR_SHA" && "$CONNECTOR_CI_CALLS" == 1 && "$CONNECTOR_SYNC_SEEN" == 1 && "$CONNECTOR_PRELOADS" == 0 ]] || return 101
  printf 'PRELOAD:api-shared\\n' >&2
  [[ "\${CONNECTOR_FAIL_AT:-}" != preload ]] || return 69
  CONNECTOR_PRELOADS=1
}
`;

const connectorStages = ['CI:1', 'SYNC', 'IMAGE_PLAN', 'PRELOAD:api-shared', 'CI:2', 'RUNTIME'];
function assertConnectorStages(result, accepted) {
  const events = result.stderr
    .trim()
    .split('\n')
    .filter((line) => connectorStages.includes(line));
  assert.deepEqual(events, accepted ? connectorStages : []);
}

test('feature activation stops before runtime after either CI proof or image preparation fails', () => {
  for (const [failAt, event, status] of [
    ['ci-1', 'CI:1', 66],
    ['sync', 'SYNC', 67],
    ['image-plan', 'IMAGE_PLAN', 68],
    ['preload', 'PRELOAD:api-shared', 69],
    ['ci-2', 'CI:2', 66],
  ]) {
    const result = shell(
      `
${block(connect, 'deploy_main')}
${connectorDoubles}
deploy_main main --auto
`,
      { MAXIM_MESSAGE_RETENTION_MODE: 'on', CONNECTOR_FAIL_AT: failAt },
    );
    assert.equal(result.status, status, result.stderr);
    assert.equal(result.stdout, '');
    assert.deepEqual(
      result.stderr.trim().split('\n'),
      connectorStages.slice(0, connectorStages.indexOf(event) + 1),
    );
  }
});

test('caller accepts only explicit on/off and forwards the setting only through deploy', () => {
  for (const mode of ['', 'on', 'off', 'shadow', 'canary', '*']) {
    const result = shell(
      `
${block(connect, 'deploy_main')}
${connectorDoubles}
deploy_main main --auto
`,
      { MAXIM_MESSAGE_RETENTION_MODE: mode },
    );
    const accepted = ['', 'on', 'off'].includes(mode);
    assert.equal(result.status, accepted ? 0 : 2, result.stderr);
    assertConnectorStages(result, accepted);
    if (accepted && mode)
      assert.match(result.stdout, new RegExp(`MAXIM_MESSAGE_RETENTION_MODE=${mode} `, 'u'));
    if (!accepted) assert.equal(result.stdout, '');
  }
  for (const name of ['rollback_runtime', 'rollback_release', 'finalize_release_recovery']) {
    assert.doesNotMatch(block(connect, name), /MAXIM_MESSAGE_RETENTION_MODE/u);
  }
});

test('retention mode is caller-only across persisted VPS configuration', (t) => {
  const data = fixture(t);
  const envFile = resolve(data.directory, '.env.vps');
  const start = connect.indexOf('PAIR_RELEASE_EXPECTED_STATE_FROM_CALLER=');
  const end = connect.indexOf('\nMAXIM_VPS_SSH_TARGET=', start);
  assert.ok(start >= 0 && end > start);
  const bootstrap = connect.slice(start, end);
  assert.ok(
    bootstrap.indexOf('MESSAGE_RETENTION_MODE_FROM_CALLER=') <
      bootstrap.indexOf('source "$ENV_FILE"'),
  );
  assert.ok(
    bootstrap.indexOf('MAXIM_MESSAGE_RETENTION_MODE="$MESSAGE_RETENTION_MODE_FROM_CALLER"') >
      bootstrap.indexOf('source "$ENV_FILE"'),
  );
  for (const { caller, persisted, expected, status } of [
    { caller: '', persisted: 'on', expected: '', status: 0 },
    { caller: 'on', persisted: 'off', expected: 'on', status: 0 },
    { caller: 'off', persisted: 'on', expected: 'off', status: 0 },
    { caller: 'shadow', persisted: 'off', expected: '', status: 2 },
  ]) {
    writeFileSync(envFile, `MAXIM_MESSAGE_RETENTION_MODE=${persisted}\n`, { mode: 0o600 });
    const result = shell(
      `
ENV_FILE="$RETENTION_TEST_ENV_FILE"
${bootstrap}
${block(connect, 'deploy_main')}
${connectorDoubles}
deploy_main main --auto
`,
      {
        MAXIM_MESSAGE_RETENTION_MODE: caller,
        RETENTION_TEST_ENV_FILE: envFile,
      },
    );
    assert.equal(result.status, status, result.stderr);
    assertConnectorStages(result, status === 0);
    if (expected) {
      assert.match(result.stdout, new RegExp(`MAXIM_MESSAGE_RETENTION_MODE=${expected} `, 'u'));
    } else {
      assert.doesNotMatch(result.stdout, /MAXIM_MESSAGE_RETENTION_MODE=/u);
    }
    if (status !== 0) assert.equal(result.stdout, '');
    assert.equal(readFileSync(envFile, 'utf8'), `MAXIM_MESSAGE_RETENTION_MODE=${persisted}\n`);
  }
});

test('plan selects the shared API without invoking the environment patch', () => {
  for (const mode of ['', 'on', 'off']) {
    const result = shell(
      `
${block(deploy, 'derive_auto_services')}
${block(deploy, 'print_deploy_plan')}
${block(deploy, 'contains_service')}
RELEASE_COMPONENTS=(api-shared miniapp-major-static admin-static)
impact_plan_selects_component() { return 1; }
release_field() { printf '%040d' 1; }
git() { printf '%040d' 2; }
node() { exit 99; }
derive_auto_services
printf 'services=%s\\n' "\${SERVICES[*]}"
print_deploy_plan
`,
      { RETENTION_DEPLOY_MODE: mode },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, mode ? /services=api-ingress/u : /services=\n/u);
    assert.match(
      result.stdout,
      mode ? /Deploy components: api-shared/u : /No production components require deployment/u,
    );
  }
  const plan = deploy.slice(
    deploy.indexOf('if [[ "$DEPLOY_MODE" == "plan" ]]; then\n  load_current_component_images'),
    deploy.indexOf('prepare_retention_deploy_mode\n'),
  );
  assert.match(plan, /print_deploy_plan\n {2}exit 0/u);
  assert.doesNotMatch(plan, /patch-env|persist_retention_deploy_mode/u);
});

test('persistence rechecks lock and queue fence before patch, and propagates each refusal', () => {
  for (const failAt of ['none', 'lock', 'fence', 'patch', 'compose']) {
    const result = shell(
      `
${block(deploy, 'persist_retention_deploy_mode')}
RETENTION_DEPLOY_MODE=on
RETENTION_STATE_HELPER=helper
COMPOSE_FILES=()
API_SERVICES=(api-ingress)
require_deploy_lock() { printf 'lock\\n' >&2; [[ "$FAIL_AT" != lock ]]; }
maxim_webhook_assert_api_rollout_quiescence() { printf 'fence\\n' >&2; [[ "$FAIL_AT" != fence ]]; }
node() { if [[ "$2" == patch-env ]]; then printf 'patch\\n' >&2; [[ "$FAIL_AT" != patch ]]; else cat >/dev/null; fi; }
docker() { printf 'compose\\n' >&2; [[ "$FAIL_AT" != compose ]]; }
persist_retention_deploy_mode
`,
      { FAIL_AT: failAt },
    );
    assert.equal(result.status, failAt === 'none' ? 0 : 1, result.stderr);
    const events = result.stderr.trim().split('\n');
    const expected = ['lock', 'fence', 'patch', 'compose'];
    assert.deepEqual(
      events,
      failAt === 'none' ? expected : expected.slice(0, expected.indexOf(failAt) + 1),
    );
  }
  const persist = deploy.lastIndexOf('\n  persist_retention_deploy_mode\n');
  assert.ok(persist > deploy.indexOf('\n  begin_release_runtime_transition\n'));
  assert.ok(persist > deploy.indexOf('\n  maxim_webhook_quiesce_for_api_rollout COMPOSE_FILES\n'));
  assert.ok(
    persist < deploy.indexOf('\n  recreate_service_wave "action, publisher and retention"'),
  );
  const verify = deploy.indexOf('\n  verify_retention_deploy_mode\n');
  assert.ok(verify > persist);
  assert.ok(verify < deploy.indexOf('\n  maxim_webhook_resume_after_api_fence COMPOSE_FILES\n'));
  const admission = /^\s*(?:if\s+)?acquire_deploy_lock(?:;|\s|$)/mu.exec(deploy);
  assert.ok(admission, 'normal deploy must acquire its protected lock');
  const validation = deploy.indexOf('\nvalidate_retention_deploy_mode\n');
  assert.ok(validation >= 0 && validation < admission.index);
});

test('runtime verification covers every actual role and refuses duplicates or stale modes', () => {
  for (const scenario of ['valid', 'stale', 'duplicate-container', 'duplicate-mode']) {
    const result = shell(
      `
${block(deploy, 'verify_retention_deploy_mode')}
RETENTION_DEPLOY_MODE=on
RETENTION_STATE_HELPER="$HELPER"
COMPOSE_FILES=()
API_SERVICES=(${services.join(' ')})
docker() {
  if [[ "$1" == compose ]]; then
    if [[ "$SCENARIO" == duplicate-container && "\${*: -1}" == api-action ]]; then printf '%064d\\n%064d\\n' 1 2; else printf '%064d' 1; fi
  else
    if [[ "$SCENARIO" == stale ]]; then printf '["MESSAGE_RETENTION_MODE=off"]';
    elif [[ "$SCENARIO" == duplicate-mode ]]; then printf '["MESSAGE_RETENTION_MODE=on","MESSAGE_RETENTION_MODE=on"]';
    else printf '["MESSAGE_RETENTION_MODE=on"]'; fi
  fi
}
verify_retention_deploy_mode
`,
      { SCENARIO: scenario, HELPER: helper },
    );
    assert.equal(result.status, scenario === 'valid' ? 0 : 1, result.stderr);
  }
});
