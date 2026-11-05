import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';
import {
  patchStatisticsCentralEnv,
  patchStatisticsCentralEnvFile,
  readStatisticsCentralEnv,
  validateStatisticsCentralEpoch,
  verifyStatisticsCentralCompose,
  verifyStatisticsCentralRuntimeEnv,
} from './statistics-exchange-rollout-state.mjs';

const root = resolve(import.meta.dirname, '../..');
const helper = resolve(import.meta.dirname, 'statistics-exchange-rollout-state.mjs');
const deploy = readFileSync(resolve(root, 'infra/scripts/vps-pull-build-up.sh'), 'utf8');
const connect = readFileSync(resolve(root, 'infra/scripts/vps-connect.sh'), 'utf8');
const topology = readFileSync(resolve(root, 'infra/scripts/lib/deploy-topology.sh'), 'utf8');
const services = [
  ...topology.match(/MAXIM_PRODUCTION_API_SERVICES=\(\n([\s\S]*?)\n\)/u)[1].matchAll(/"([^"]+)"/gu),
].map((match) => match[1]);
const epoch = '12345678-1234-4234-8234-123456789abc';
const other = '12345678-1234-4234-8234-123456789abd';
const settings = {
  STATISTICS_CENTRAL_ENABLED: 'true',
  STATISTICS_CENTRAL_MODE: 'CENTRAL',
  STATISTICS_CENTRAL_EXCHANGE_EPOCH: epoch,
};
const runtime = Object.entries(settings).map(([key, value]) => `${key}=${value}`);

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
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      RETENTION_DEPLOY_MODE: '',
      MAXIM_MESSAGE_RETENTION_MODE: '',
      STATISTICS_EXCHANGE_DEPLOY_ENABLED: '',
      STATISTICS_EXCHANGE_V3_ENABLED: '',
      STATISTICS_CENTRAL_DEPLOY_EPOCH: '',
      MAXIM_STATISTICS_CENTRAL_EPOCH: '',
      ...env,
    },
  });
  assert.equal(result.error, undefined, result.stderr);
  assert.equal(result.signal, null, result.stderr);
  return result;
}

function fixture(t) {
  const directory = mkdtempSync(resolve(tmpdir(), 'maxim-statistics-central-env-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = resolve(directory, '.env');
  return { directory, path };
}

test('activation patches exactly three settings preserving quoted secrets, BOM, CRLF and cohort', () => {
  for (const quote of ['"', "'", '`']) {
    for (const ending of ['\n', '\r\n']) {
      const secret = `\uFEFFSECRET=${quote}first${ending}STATISTICS_CENTRAL_MODE=CENTRAL${ending}last${quote}${ending}`;
      const suffix = `SVYAZKA_STATISTICS_V2_USERS=*${ending}STATISTICS_EXCHANGE_V3_ENABLED=false`;
      const input = `${secret}export STATISTICS_CENTRAL_ENABLED = false${ending}STATISTICS_CENTRAL_MODE=LEGACY${ending}${suffix}`;
      const output = patchStatisticsCentralEnv(input, epoch);
      assert.equal(
        output,
        `${secret}STATISTICS_CENTRAL_ENABLED=true${ending}STATISTICS_CENTRAL_MODE=CENTRAL${ending}${suffix}${ending}STATISTICS_CENTRAL_EXCHANGE_EPOCH=${epoch}${ending}`,
      );
      assert.deepEqual(readStatisticsCentralEnv(output), {
        enabled: 'true',
        mode: 'CENTRAL',
        epoch,
      });
      assert.equal(patchStatisticsCentralEnv(output, epoch), output);
    }
  }
  assert.deepEqual(readStatisticsCentralEnv('SECRET=untouched\n'), {
    enabled: 'false',
    mode: 'LEGACY',
    epoch: null,
  });
});

test('persisted epoch is immutable even when disabled; malformed or ambiguous input fails closed', () => {
  for (const contents of [
    `STATISTICS_CENTRAL_EXCHANGE_EPOCH=${other}\n`,
    'STATISTICS_CENTRAL_ENABLED=false\nSTATISTICS_CENTRAL_ENABLED=false\n',
    'STATISTICS_CENTRAL_MODE="CENTRAL"\n',
    'STATISTICS_CENTRAL_MODE: CENTRAL\n',
    'STATISTICS_CENTRAL_ENABLED=true\n',
    'STATISTICS_CENTRAL_MODE=CENTRAL\n',
    'STATISTICS_CENTRAL_ENABLED=true\nSTATISTICS_CENTRAL_MODE=CENTRAL\n',
    'STATISTICS_CENTRAL_ENABLED=false # ambiguous\n',
    'SECRET="unterminated\n',
    'SECRET=\0',
    Buffer.from([0xff]),
    'X'.repeat(1024 * 1024 + 1),
  ])
    assert.throws(() => patchStatisticsCentralEnv(contents, epoch));
  for (const invalid of ['', '*', epoch.toUpperCase(), `${epoch}\n`, `$(touch /tmp/never)`, null])
    assert.throws(() => validateStatisticsCentralEpoch(invalid));
});

test('atomic activation preserves file identity metadata and no-op retries never replace the inode', (t) => {
  const { directory, path } = fixture(t);
  writeFileSync(path, 'SECRET=do not expand $(touch /tmp/never)\n', { mode: 0o640 });
  const before = statSync(path);
  patchStatisticsCentralEnvFile(path, epoch);
  const after = statSync(path);
  assert.notEqual(after.ino, before.ino);
  assert.equal(after.mode, before.mode);
  assert.equal(after.uid, before.uid);
  assert.equal(after.gid, before.gid);
  patchStatisticsCentralEnvFile(path, epoch);
  assert.equal(statSync(path).ino, after.ino);
  const bytes = readFileSync(path);
  assert.throws(() => patchStatisticsCentralEnvFile(path, other));
  assert.deepEqual(readFileSync(path), bytes);
  assert.deepEqual(readdirSync(directory), ['.env']);
  const cli = spawnSync(process.execPath, [helper, 'patch-central-env', path, other], {
    encoding: 'utf8',
  });
  assert.equal(cli.status, 1);
  assert.doesNotMatch(cli.stdout + cli.stderr, /SECRET|12345678|do not expand/u);
});

test('Compose and runtime proof require all three exact settings on all fourteen roles', () => {
  const config = {
    services: Object.fromEntries(services.map((s) => [s, { environment: settings }])),
  };
  verifyStatisticsCentralCompose(config, epoch, services);
  assert.throws(() => verifyStatisticsCentralCompose(config, epoch, services.slice(1)));
  assert.throws(() => verifyStatisticsCentralCompose(config, epoch, Array(14).fill(services[0])));
  for (const service of services) {
    const changed = structuredClone(config);
    changed.services[service].environment.STATISTICS_CENTRAL_EXCHANGE_EPOCH = other;
    assert.throws(() => verifyStatisticsCentralCompose(changed, epoch, services));
  }
  verifyStatisticsCentralRuntimeEnv(['SECRET=hidden', ...runtime], epoch);
  for (const entry of runtime) {
    assert.throws(() =>
      verifyStatisticsCentralRuntimeEnv(
        runtime.filter((e) => e !== entry),
        epoch,
      ),
    );
    assert.throws(() => verifyStatisticsCentralRuntimeEnv([...runtime, entry], epoch));
  }
});

test('actual production Compose propagates the canonical env file without exposing keys to native auxiliaries', (t) => {
  const { path } = fixture(t);
  writeFileSync(path, patchStatisticsCentralEnv('SVYAZKA_STATISTICS_V2_USERS=*\n', epoch), {
    mode: 0o600,
  });
  const result = spawnSync(
    'docker',
    ['compose', '--env-file', path, '-f', 'infra/docker-compose.yml', 'config', '--format', 'json'],
    {
      cwd: root,
      encoding: 'utf8',
      timeout: 15000,
      env: { PATH: process.env.PATH, HOME: process.env.HOME, MAXIM_COMPOSE_SERVICE_ENV_FILE: path },
    },
  );
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  const config = JSON.parse(result.stdout);
  verifyStatisticsCentralCompose(config, epoch, services);
  for (const native of ['ocr-native-sandbox', 'photo-native-sandbox'])
    for (const key of Object.keys(settings))
      assert.equal(config.services[native].environment[key], undefined);
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
  if [[ -n "\${MAXIM_STATISTICS_CENTRAL_EPOCH:-}" ]]; then
    [[ "$1" == *"MAXIM_STATISTICS_CENTRAL_EPOCH=$MAXIM_STATISTICS_CENTRAL_EPOCH "* ]] || return 96
  else
    [[ "$1" != *'MAXIM_STATISTICS_CENTRAL_EPOCH='* ]] || return 96
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
      { MAXIM_STATISTICS_CENTRAL_EPOCH: epoch, CONNECTOR_FAIL_AT: failAt },
    );
    assert.equal(result.status, status, result.stderr);
    assert.equal(result.stdout, '');
    assert.deepEqual(
      result.stderr
        .trim()
        .split('\n')
        .filter((line) => !line.startsWith('Release preparation: ')),
      connectorStages.slice(0, connectorStages.indexOf(event) + 1),
    );
  }
});

test('activation is caller-only and only deploy forwards it after exact CI', (t) => {
  const { path } = fixture(t);
  const start = connect.indexOf('PAIR_RELEASE_EXPECTED_STATE_FROM_CALLER=');
  const end = connect.indexOf('\nMAXIM_VPS_SSH_TARGET=', start);
  assert.ok(start >= 0 && end > start);
  const bootstrap = connect.slice(start, end);
  for (const caller of ['', epoch, 'not-a-uuid']) {
    writeFileSync(path, `MAXIM_STATISTICS_CENTRAL_EPOCH=${other}\n`, { mode: 0o600 });
    const result = shell(
      `
ENV_FILE="$TEST_ENV_FILE"
${bootstrap}
${block(connect, 'deploy_main')}
${connectorDoubles}
deploy_main main --auto
`,
      { MAXIM_STATISTICS_CENTRAL_EPOCH: caller, TEST_ENV_FILE: path },
    );
    assert.equal(result.status, caller === 'not-a-uuid' ? 2 : 0, result.stderr);
    if (caller === epoch)
      assert.match(result.stdout, new RegExp(`MAXIM_STATISTICS_CENTRAL_EPOCH=${epoch} `, 'u'));
    else assert.doesNotMatch(result.stdout, /MAXIM_STATISTICS_CENTRAL_EPOCH=/u);
    if (caller === 'not-a-uuid') assert.doesNotMatch(result.stderr, /CI/u);
    else assert.match(result.stderr, /CI/u);
    assertConnectorStages(result, caller !== 'not-a-uuid');
    assert.equal(readFileSync(path, 'utf8'), `MAXIM_STATISTICS_CENTRAL_EPOCH=${other}\n`);
  }
  for (const name of ['rollback_runtime', 'rollback_release', 'finalize_release_recovery'])
    assert.doesNotMatch(block(connect, name), /MAXIM_STATISTICS_CENTRAL_EPOCH/u);
});

test('same-SHA activation selects all API roles via the existing shared-image rollout without patching in plan', () => {
  const result = shell(
    `
${block(deploy, 'derive_auto_services')}
${block(deploy, 'print_deploy_plan')}
${block(deploy, 'contains_service')}
RELEASE_COMPONENTS=(api-shared miniapp-major-static admin-static)
impact_plan_selects_component() { return 1; }
release_field() { printf '%040d' 1; }
git() { printf '%040d' 1; }
node() { exit 99; }
derive_auto_services
printf 'services=%s\\n' "\${SERVICES[*]}"
print_deploy_plan
`,
    { STATISTICS_CENTRAL_DEPLOY_EPOCH: epoch },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /services=api-ingress/u);
  assert.match(result.stdout, /Deploy components: api-shared/u);
  const plan = deploy.slice(
    deploy.indexOf('if [[ "$DEPLOY_MODE" == "plan" ]]; then\n  load_current_component_images'),
    deploy.indexOf('prepare_statistics_central_deploy_epoch\n'),
  );
  assert.match(plan, /print_deploy_plan\n {2}exit 0/u);
  assert.doesNotMatch(plan, /patch-central-env|persist_statistics_central_deploy_epoch/u);
});

test('activation cannot persist before lock and queue fence or resume queues before per-role verification', () => {
  for (const failAt of ['none', 'lock', 'fence', 'patch', 'compose']) {
    const result = shell(
      `
${block(deploy, 'persist_statistics_central_deploy_epoch')}
STATISTICS_EXCHANGE_STATE_HELPER=helper
COMPOSE_FILES=()
API_SERVICES=(api-ingress)
require_deploy_lock() { printf 'lock\\n' >&2; [[ "$FAIL_AT" != lock ]]; }
maxim_webhook_assert_api_rollout_quiescence() { printf 'fence\\n' >&2; [[ "$FAIL_AT" != fence ]]; }
node() { if [[ "$2" == patch-central-env ]]; then printf 'patch\\n' >&2; [[ "$FAIL_AT" != patch ]]; else cat >/dev/null; fi; }
docker() { printf 'compose\\n' >&2; [[ "$FAIL_AT" != compose ]]; }
persist_statistics_central_deploy_epoch
`,
      { FAIL_AT: failAt, STATISTICS_CENTRAL_DEPLOY_EPOCH: epoch },
    );
    assert.equal(result.status, failAt === 'none' ? 0 : 1, result.stderr);
    const events = ['lock', 'fence', 'patch', 'compose'];
    assert.deepEqual(
      result.stderr.trim().split('\n'),
      failAt === 'none' ? events : events.slice(0, events.indexOf(failAt) + 1),
    );
  }
  const persist = deploy.lastIndexOf('\n  persist_statistics_central_deploy_epoch\n');
  assert.ok(persist > deploy.indexOf('\n  begin_release_runtime_transition\n'));
  assert.ok(persist > deploy.indexOf('\n  maxim_webhook_quiesce_for_api_rollout COMPOSE_FILES\n'));
  assert.ok(
    persist < deploy.indexOf('\n  recreate_service_wave "action, publisher and retention"'),
  );
  const verify = deploy.indexOf('\n  verify_statistics_central_deploy_epoch\n');
  assert.ok(verify > persist);
  assert.ok(verify < deploy.indexOf('\n  maxim_webhook_resume_after_api_fence COMPOSE_FILES\n'));
});

test('runtime checks reject a missing/duplicate container and changed epoch on any actual role', () => {
  for (const scenario of ['valid', 'stale', 'duplicate']) {
    const result = shell(
      `
${block(deploy, 'verify_statistics_central_deploy_epoch')}
STATISTICS_EXCHANGE_STATE_HELPER="$HELPER"
COMPOSE_FILES=()
API_SERVICES=(${services.join(' ')})
docker() {
  if [[ "$1" == compose ]]; then
    if [[ "$SCENARIO" == duplicate && "\${*: -1}" == api-action ]]; then printf '%064d\\n%064d\\n' 1 2; else printf '%064d' 1; fi
  elif [[ "$SCENARIO" == stale ]]; then printf '%s' "$STALE_RUNTIME";
  else printf '%s' "$VALID_RUNTIME"; fi
}
verify_statistics_central_deploy_epoch
`,
      {
        SCENARIO: scenario,
        HELPER: helper,
        STATISTICS_CENTRAL_DEPLOY_EPOCH: epoch,
        VALID_RUNTIME: JSON.stringify(runtime),
        STALE_RUNTIME: JSON.stringify(runtime.map((e) => e.replace(epoch, other))),
      },
    );
    assert.equal(result.status, scenario === 'valid' ? 0 : 1, result.stderr);
  }
});

test('unrequested activation has no side effects; preparation removes interpolation and custom env-file overrides', () => {
  const blocks = [
    'prepare_statistics_central_deploy_epoch',
    'persist_statistics_central_deploy_epoch',
    'verify_statistics_central_deploy_epoch',
  ]
    .map((name) => block(deploy, name))
    .join('\n');
  assert.equal(
    shell(
      `${blocks}\nnode() { exit 91; }\ndocker() { exit 92; }\nprepare_statistics_central_deploy_epoch\npersist_statistics_central_deploy_epoch\nverify_statistics_central_deploy_epoch`,
    ).status,
    0,
  );
  const result = shell(
    `
${block(deploy, 'prepare_statistics_central_deploy_epoch')}
STATISTICS_EXCHANGE_STATE_HELPER=helper
MAXIM_COMPOSE_SERVICE_ENV_FILE=/ignored/custom.env
node() {
  [[ "\${STATISTICS_CENTRAL_ENABLED+x}" != x && "\${STATISTICS_CENTRAL_MODE+x}" != x && "\${STATISTICS_CENTRAL_EXCHANGE_EPOCH+x}" != x ]]
  [[ "$MAXIM_COMPOSE_SERVICE_ENV_FILE" == ../.env ]]
  [[ "$*" == "helper check-central-env .env $STATISTICS_CENTRAL_DEPLOY_EPOCH" ]]
}
prepare_statistics_central_deploy_epoch
`,
    {
      STATISTICS_CENTRAL_DEPLOY_EPOCH: epoch,
      STATISTICS_CENTRAL_ENABLED: 'true',
      STATISTICS_CENTRAL_MODE: 'CENTRAL',
      STATISTICS_CENTRAL_EXCHANGE_EPOCH: other,
    },
  );
  assert.equal(result.status, 0, result.stderr);
});
