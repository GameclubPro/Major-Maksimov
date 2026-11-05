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
  patchStatisticsExchangeEnv,
  patchStatisticsExchangeEnvFile,
  readStatisticsExchangeEnv,
  verifyStatisticsExchangeCompose,
  verifyStatisticsExchangeRuntimeEnv,
} from './statistics-exchange-rollout-state.mjs';

const root = resolve(import.meta.dirname, '../..');
const helper = resolve(import.meta.dirname, 'statistics-exchange-rollout-state.mjs');
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
    env: {
      ...process.env,
      RETENTION_DEPLOY_MODE: '',
      MAXIM_MESSAGE_RETENTION_MODE: '',
      STATISTICS_EXCHANGE_DEPLOY_ENABLED: '',
      STATISTICS_EXCHANGE_V3_ENABLED: '',
      ...env,
    },
  });
  assert.equal(result.error, undefined, result.stderr);
  assert.equal(result.signal, null, result.stderr);
  return result;
}

function fixture(t) {
  const directory = mkdtempSync(resolve(tmpdir(), 'maxim-statistics-exchange-env-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = resolve(directory, '.env');
  const contents =
    'SECRET=do not expand $(touch /tmp/never)\nSTATISTICS_EXCHANGE_V3_ENABLED=false\nOTHER=with spaces\n';
  writeFileSync(path, contents, { mode: 0o640 });
  return { directory, path, contents };
}

test('patches only the flag while preserving cohort, unrelated bytes, BOM, CRLF and final newline', () => {
  for (const prefix of ['', '\uFEFF']) {
    for (const ending of ['\n', '\r\n']) {
      for (const final of ['', ending]) {
        const contents = `${prefix}SECRET="unchanged spaces"${ending} export STATISTICS_EXCHANGE_V3_ENABLED = false${ending}SVYAZKA_STATISTICS_V2_USERS=*${final}`;
        const expected = `${prefix}SECRET="unchanged spaces"${ending}STATISTICS_EXCHANGE_V3_ENABLED=true${ending}SVYAZKA_STATISTICS_V2_USERS=*${final}`;
        assert.equal(patchStatisticsExchangeEnv(contents, 'true'), expected);
        assert.equal(
          patchStatisticsExchangeEnv(expected, 'false'),
          expected.replace('ENABLED=true', 'ENABLED=false'),
        );
      }
    }
  }
  assert.equal(
    patchStatisticsExchangeEnv('\uFEFFSTATISTICS_EXCHANGE_V3_ENABLED=false\r\n', 'true'),
    '\uFEFFSTATISTICS_EXCHANGE_V3_ENABLED=true\r\n',
  );
  assert.equal(
    patchStatisticsExchangeEnv('SECRET=value', 'false'),
    'SECRET=value\nSTATISTICS_EXCHANGE_V3_ENABLED=false\n',
  );
  assert.equal(readStatisticsExchangeEnv('SECRET=value\n'), 'false');
});

test('rejects duplicate, malformed, oversized, NUL and invalid UTF8 values without widening scope', () => {
  for (const contents of [
    'STATISTICS_EXCHANGE_V3_ENABLED=false\nexport STATISTICS_EXCHANGE_V3_ENABLED=true\n',
    'STATISTICS_EXCHANGE_V3_ENABLED=private-invalid-mode\n',
    'STATISTICS_EXCHANGE_V3_ENABLED=true # ambiguous\n',
    'STATISTICS_EXCHANGE_V3_ENABLED="true"\n',
    'STATISTICS_EXCHANGE_V3_ENABLED: true\n',
    'SECRET="unterminated\n',
    'SECRET=\0\n',
    Buffer.from([0xff]),
    'X'.repeat(1024 * 1024 + 1),
  ])
    assert.throws(() => patchStatisticsExchangeEnv(contents, 'true'));
  for (const mode of [
    'canary',
    'shadow',
    '*',
    '',
    'ON',
    'TRUE',
    'False',
    '1',
    '0',
    'yes',
    ' true',
    'false ',
  ]) {
    assert.throws(() => patchStatisticsExchangeEnv('', mode));
  }
});

test('atomically replaces an owned dotenv preserving its permissions and all unrelated bytes', (t) => {
  const data = fixture(t);
  const previous = statSync(data.path);
  patchStatisticsExchangeEnvFile(data.path, 'true');
  assert.equal(
    readFileSync(data.path, 'utf8'),
    data.contents.replace('ENABLED=false', 'ENABLED=true'),
  );
  const current = statSync(data.path);
  assert.equal(current.mode & 0o777, previous.mode & 0o777);
  assert.equal(current.uid, previous.uid);
  assert.equal(current.gid, previous.gid);
  assert.notEqual(current.ino, previous.ino);
  assert.deepEqual(readdirSync(data.directory), ['.env']);
  patchStatisticsExchangeEnvFile(data.path, 'true');
  assert.equal(statSync(data.path).ino, current.ino);
});

test('refuses symlinks, hardlinks and writable dotenv files without mutating the target', (t) => {
  const data = fixture(t);
  const symbolic = resolve(data.directory, 'symbolic');
  symlinkSync(data.path, symbolic);
  assert.throws(() => patchStatisticsExchangeEnvFile(symbolic, 'true'));
  const hard = resolve(data.directory, 'hard');
  linkSync(data.path, hard);
  assert.throws(() => patchStatisticsExchangeEnvFile(data.path, 'true'));
  rmSync(hard);
  chmodSync(data.path, 0o666);
  assert.throws(() => patchStatisticsExchangeEnvFile(data.path, 'true'));
  assert.equal(readFileSync(data.path, 'utf8'), data.contents);
});

test('refuses a malformed file without replacing it or disclosing values on the CLI', (t) => {
  const data = fixture(t);
  const contents = data.contents.replace('ENABLED=false', 'ENABLED=private-invalid-mode');
  writeFileSync(data.path, contents);
  const previous = statSync(data.path);
  const result = spawnSync(process.execPath, [helper, 'patch-env', data.path, 'true'], {
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
      services.map((service) => [
        service,
        { environment: { STATISTICS_EXCHANGE_V3_ENABLED: 'true' } },
      ]),
    ),
  };
  assert.equal(services.length, 14);
  verifyStatisticsExchangeCompose(config, 'true', services);
  for (const service of services) {
    const changed = structuredClone(config);
    changed.services[service].environment.STATISTICS_EXCHANGE_V3_ENABLED = 'false';
    assert.throws(() => verifyStatisticsExchangeCompose(changed, 'true', services));
  }
  assert.throws(() => verifyStatisticsExchangeCompose(config, 'true', services.slice(1)));
  assert.throws(() => verifyStatisticsExchangeCompose(config, 'true', Array(14).fill(services[0])));
  verifyStatisticsExchangeRuntimeEnv(
    ['SECRET=hidden', 'STATISTICS_EXCHANGE_V3_ENABLED=true'],
    'true',
  );
  verifyStatisticsExchangeRuntimeEnv(['STATISTICS_EXCHANGE_V3_ENABLED=false'], 'false');
  for (const value of [
    null,
    [],
    ['STATISTICS_EXCHANGE_V3_ENABLED=false'],
    ['STATISTICS_EXCHANGE_V3_ENABLED=true', 'STATISTICS_EXCHANGE_V3_ENABLED=true'],
  ]) {
    assert.throws(() => verifyStatisticsExchangeRuntimeEnv(value, 'true'));
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
  if [[ -n "\${STATISTICS_EXCHANGE_V3_ENABLED:-}" ]]; then
    [[ "$1" == *"STATISTICS_EXCHANGE_V3_ENABLED=$STATISTICS_EXCHANGE_V3_ENABLED "* ]] || return 96
  else
    [[ "$1" != *'STATISTICS_EXCHANGE_V3_ENABLED='* ]] || return 96
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
      { STATISTICS_EXCHANGE_V3_ENABLED: 'true', CONNECTOR_FAIL_AT: failAt },
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

test('caller accepts only explicit true/false and forwards the setting only through deploy', () => {
  for (const mode of [
    '',
    'true',
    'false',
    'shadow',
    'canary',
    '*',
    '1',
    '0',
    'yes',
    'TRUE',
    'False',
    ' true',
    'false ',
  ]) {
    const result = shell(
      `
${block(connect, 'deploy_main')}
${connectorDoubles}
deploy_main main --auto
`,
      { STATISTICS_EXCHANGE_V3_ENABLED: mode },
    );
    const accepted = ['', 'true', 'false'].includes(mode);
    assert.equal(result.status, accepted ? 0 : 2, result.stderr);
    assertConnectorStages(result, accepted);
    if (accepted && mode)
      assert.match(result.stdout, new RegExp(`STATISTICS_EXCHANGE_V3_ENABLED=${mode} `, 'u'));
    if (!accepted) assert.equal(result.stdout, '');
  }
  for (const name of ['rollback_runtime', 'rollback_release', 'finalize_release_recovery']) {
    assert.doesNotMatch(block(connect, name), /STATISTICS_EXCHANGE_V3_ENABLED/u);
  }
});

test('statistics flag is caller-only across persisted VPS configuration', (t) => {
  const data = fixture(t);
  const envFile = resolve(data.directory, '.env.vps');
  const start = connect.indexOf('PAIR_RELEASE_EXPECTED_STATE_FROM_CALLER=');
  const end = connect.indexOf('\nMAXIM_VPS_SSH_TARGET=', start);
  assert.ok(start >= 0 && end > start);
  const bootstrap = connect.slice(start, end);
  assert.ok(
    bootstrap.indexOf('STATISTICS_EXCHANGE_V3_FROM_CALLER=') <
      bootstrap.indexOf('source "$ENV_FILE"'),
  );
  assert.ok(
    bootstrap.indexOf('STATISTICS_EXCHANGE_V3_ENABLED="$STATISTICS_EXCHANGE_V3_FROM_CALLER"') >
      bootstrap.indexOf('source "$ENV_FILE"'),
  );
  for (const { caller, persisted, expected, status } of [
    { caller: '', persisted: 'true', expected: '', status: 0 },
    { caller: 'true', persisted: 'false', expected: 'true', status: 0 },
    { caller: 'false', persisted: 'true', expected: 'false', status: 0 },
    { caller: 'shadow', persisted: 'false', expected: '', status: 2 },
  ]) {
    writeFileSync(envFile, `STATISTICS_EXCHANGE_V3_ENABLED=${persisted}\n`, { mode: 0o600 });
    const result = shell(
      `
ENV_FILE="$STATISTICS_TEST_ENV_FILE"
${bootstrap}
${block(connect, 'deploy_main')}
${connectorDoubles}
deploy_main main --auto
`,
      {
        STATISTICS_EXCHANGE_V3_ENABLED: caller,
        STATISTICS_TEST_ENV_FILE: envFile,
      },
    );
    assert.equal(result.status, status, result.stderr);
    assertConnectorStages(result, status === 0);
    if (expected) {
      assert.match(result.stdout, new RegExp(`STATISTICS_EXCHANGE_V3_ENABLED=${expected} `, 'u'));
    } else {
      assert.doesNotMatch(result.stdout, /STATISTICS_EXCHANGE_V3_ENABLED=/u);
    }
    if (status !== 0) assert.equal(result.stdout, '');
    assert.equal(readFileSync(envFile, 'utf8'), `STATISTICS_EXCHANGE_V3_ENABLED=${persisted}\n`);
  }
});

test('plan selects the shared API without invoking the environment patch', () => {
  for (const mode of ['', 'true', 'false']) {
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
      { STATISTICS_EXCHANGE_DEPLOY_ENABLED: mode },
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
    deploy.indexOf('prepare_statistics_exchange_deploy_flag\n'),
  );
  assert.match(plan, /print_deploy_plan\n {2}exit 0/u);
  assert.doesNotMatch(plan, /patch-env|persist_statistics_exchange_deploy_flag/u);
});

test('persistence rechecks lock and queue fence before patch, and propagates each refusal', () => {
  for (const failAt of ['none', 'lock', 'fence', 'patch', 'compose']) {
    const result = shell(
      `
${block(deploy, 'persist_statistics_exchange_deploy_flag')}
STATISTICS_EXCHANGE_DEPLOY_ENABLED=true
STATISTICS_EXCHANGE_STATE_HELPER=helper
COMPOSE_FILES=()
API_SERVICES=(api-ingress)
require_deploy_lock() { printf 'lock\\n' >&2; [[ "$FAIL_AT" != lock ]]; }
maxim_webhook_assert_api_rollout_quiescence() { printf 'fence\\n' >&2; [[ "$FAIL_AT" != fence ]]; }
node() { if [[ "$2" == patch-env ]]; then printf 'patch\\n' >&2; [[ "$FAIL_AT" != patch ]]; else cat >/dev/null; fi; }
docker() { printf 'compose\\n' >&2; [[ "$FAIL_AT" != compose ]]; }
persist_statistics_exchange_deploy_flag
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
  const persist = deploy.lastIndexOf('\n  persist_statistics_exchange_deploy_flag\n');
  assert.ok(persist > deploy.indexOf('\n  begin_release_runtime_transition\n'));
  assert.ok(persist > deploy.indexOf('\n  maxim_webhook_quiesce_for_api_rollout COMPOSE_FILES\n'));
  assert.ok(
    persist < deploy.indexOf('\n  recreate_service_wave "action, publisher and retention"'),
  );
  const verify = deploy.indexOf('\n  verify_statistics_exchange_deploy_flag\n');
  assert.ok(verify > persist);
  assert.ok(verify < deploy.indexOf('\n  maxim_webhook_resume_after_api_fence COMPOSE_FILES\n'));
  const admission = /^\s*(?:if\s+)?acquire_deploy_lock(?:;|\s|$)/mu.exec(deploy);
  assert.ok(admission, 'normal deploy must acquire its protected lock');
  const validation = deploy.indexOf('\nvalidate_statistics_exchange_deploy_flag\n');
  assert.ok(validation >= 0 && validation < admission.index);
});

test('runtime verification covers every actual role and refuses duplicates or stale modes', () => {
  for (const scenario of ['valid', 'stale', 'duplicate-container', 'duplicate-mode']) {
    const result = shell(
      `
${block(deploy, 'verify_statistics_exchange_deploy_flag')}
STATISTICS_EXCHANGE_DEPLOY_ENABLED=true
STATISTICS_EXCHANGE_STATE_HELPER="$HELPER"
COMPOSE_FILES=()
API_SERVICES=(${services.join(' ')})
docker() {
  if [[ "$1" == compose ]]; then
    if [[ "$SCENARIO" == duplicate-container && "\${*: -1}" == api-action ]]; then printf '%064d\\n%064d\\n' 1 2; else printf '%064d' 1; fi
  else
    if [[ "$SCENARIO" == stale ]]; then printf '["STATISTICS_EXCHANGE_V3_ENABLED=false"]';
    elif [[ "$SCENARIO" == duplicate-mode ]]; then printf '["STATISTICS_EXCHANGE_V3_ENABLED=true","STATISTICS_EXCHANGE_V3_ENABLED=true"]';
    else printf '["STATISTICS_EXCHANGE_V3_ENABLED=true"]'; fi
  fi
}
verify_statistics_exchange_deploy_flag
`,
      { SCENARIO: scenario, HELPER: helper },
    );
    assert.equal(result.status, scenario === 'valid' ? 0 : 1, result.stderr);
  }
});

test('never edits apparent flag assignments inside unrelated multiline quoted values', () => {
  for (const quote of ['"', "'", '`']) {
    for (const separator of ['=', ': ']) {
      const secret = `SECRET${separator}${quote}first\nSTATISTICS_EXCHANGE_V3_ENABLED=false\nlast${quote}\n`;
      const contents = `${secret}SVYAZKA_STATISTICS_V2_USERS=*\nSTATISTICS_EXCHANGE_V3_ENABLED=false\n`;
      assert.equal(
        patchStatisticsExchangeEnv(contents, 'true'),
        `${secret}SVYAZKA_STATISTICS_V2_USERS=*\nSTATISTICS_EXCHANGE_V3_ENABLED=true\n`,
      );
    }
  }
});

test('absent deploy setting performs no patch, inspection or dotenv replacement', (t) => {
  const data = fixture(t);
  const previous = statSync(data.path);
  const result = shell(`
${block(deploy, 'prepare_statistics_exchange_deploy_flag')}
${block(deploy, 'persist_statistics_exchange_deploy_flag')}
${block(deploy, 'verify_statistics_exchange_deploy_flag')}
node() { exit 91; }
docker() { exit 92; }
require_deploy_lock() { exit 93; }
maxim_webhook_assert_api_rollout_quiescence() { exit 94; }
prepare_statistics_exchange_deploy_flag
persist_statistics_exchange_deploy_flag
verify_statistics_exchange_deploy_flag
`);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(data.path, 'utf8'), data.contents);
  assert.equal(statSync(data.path).ino, previous.ino);
});

test('preparation removes caller interpolation and custom env-file override before reading canonical dotenv', () => {
  for (const mode of ['true', 'false']) {
    const result = shell(
      `
${block(deploy, 'prepare_statistics_exchange_deploy_flag')}
STATISTICS_EXCHANGE_STATE_HELPER=helper
MAXIM_COMPOSE_SERVICE_ENV_FILE=/custom/ignored.env
node() {
  [[ "\${STATISTICS_EXCHANGE_V3_ENABLED+x}" != x ]]
  [[ "$MAXIM_COMPOSE_SERVICE_ENV_FILE" == ../.env ]]
  [[ "$*" == 'helper read-env .env' ]]
}
prepare_statistics_exchange_deploy_flag
`,
      { STATISTICS_EXCHANGE_DEPLOY_ENABLED: mode, STATISTICS_EXCHANGE_V3_ENABLED: mode },
    );
    assert.equal(result.status, 0, result.stderr);
  }
});

test('actual production Compose resolves both boolean settings into every API role and defaults false', (t) => {
  const data = fixture(t);
  for (const mode of ['true', 'false', null]) {
    writeFileSync(
      data.path,
      `SVYAZKA_STATISTICS_V2_USERS=*\n${mode === null ? '' : `STATISTICS_EXCHANGE_V3_ENABLED=${mode}\n`}`,
    );
    const result = spawnSync(
      'docker',
      [
        'compose',
        '--env-file',
        data.path,
        '-f',
        'infra/docker-compose.yml',
        'config',
        '--format',
        'json',
      ],
      {
        cwd: root,
        encoding: 'utf8',
        timeout: 15000,
        env: {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          MAXIM_COMPOSE_SERVICE_ENV_FILE: data.path,
        },
      },
    );
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr);
    const config = JSON.parse(result.stdout);
    verifyStatisticsExchangeCompose(config, mode ?? 'false', services);
    assert.equal(config.services['api-admin'].environment.SVYAZKA_STATISTICS_V2_USERS, '*');
    for (const native of ['ocr-native-sandbox', 'photo-native-sandbox']) {
      assert.equal(config.services[native].environment.STATISTICS_EXCHANGE_V3_ENABLED, undefined);
    }
  }
});
