import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';
import {
  assessMultibotPrepareCapacity,
  checkMultibotPrepareCapacity,
  parseCapacityFilesystem,
} from './multibot-prepare-capacity.mjs';

const root = resolve(import.meta.dirname, '../..');
const library = resolve(root, 'infra/scripts/lib/webhook-rollout-quiescence.sh');
const mainComposeArgs = ['--env-file', '.env', '-p', 'infra', '-f', 'infra/docker-compose.yml'];
const GiB = 1024 ** 3;
const metadata = {
  tableBytes: 70 * GiB,
  approxRows: 47_000_000,
  orderedIndexBytes: 2.5 * GiB,
  maxWalBytes: GiB,
  dataDirectory: '/var/lib/postgresql/data',
  tempTablespaces: '',
  defaultLayout: true,
};
const filesystem = (device, availableBytes) => ({ device, availableBytes, mount: '/' });
const sharedFilesystems = (availableBytes) =>
  Object.fromEntries(
    ['data', 'temp', 'wal', 'docker'].map((role) => [
      role,
      filesystem('/dev/shared', availableBytes),
    ]),
  );

test('early capacity preflight reads the cutoff before any build or transition', (t) => {
  const result = probeEarlyPreflight(t);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /ready\n\{"code":"MULTIBOT_PREPARE_CAPACITY"/u);
  assert.match(result.stdout, /\nafter-preflight\n/u);
  assert.doesNotMatch(result.stdout, /Unexpected mutation/u);
});

for (const failure of ['capacity', 'receipt', 'malformed'])
  test(`early ${failure} failure preserves the current inventory and live runtime`, (t) => {
    const result = probeEarlyPreflight(t, failure, failure === 'malformed' ? 'unknown' : '0');
    assert.equal(result.status, 1, result.stderr);
    assert.match(
      result.stdout,
      /images=unbuilt journal=current ingress=live workers=live paused=0 cutoff=0/u,
    );
    assert.doesNotMatch(result.stdout, /after-preflight|Unexpected mutation/u);
    if (failure === 'capacity')
      assert.match(result.stderr, /MULTIBOT_PREPARE_CAPACITY_INSUFFICIENT/u);
    else assert.doesNotMatch(result.stdout, /MULTIBOT_PREPARE_CAPACITY/u);
  });

test('early preflight skips capacity when the exact effects cutoff is already applied', (t) => {
  const result = probeEarlyPreflight(t, 'none', '1');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /after-preflight/u);
  assert.doesNotMatch(result.stdout, /MULTIBOT_PREPARE_CAPACITY/u);
});

test('static-only deploy does not require an early multibot capacity or receipt probe', (t) => {
  const result = probeEarlyPreflight(t, 'receipt', '0', '0');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /after-preflight/u);
  assert.doesNotMatch(result.stdout, /^(?:ready|.*MULTIBOT_PREPARE_CAPACITY.*)$/mu);
});

function probeEarlyPreflight(t, failure = 'none', receipt = '0', buildApiImage = '1') {
  const deploy = readFileSync(resolve(root, 'infra/scripts/vps-pull-build-up.sh'), 'utf8');
  const projectDeclaration = deploy.match(/^MAIN_PROJECT_NAME="[^"\r\n]+"$/mu)?.[0];
  const composeDeclaration = deploy.match(/^COMPOSE_FILES=\([^\r\n]+\)$/mu)?.[0];
  assert.ok(projectDeclaration && composeDeclaration, 'Use the real main Compose scope');
  const block = deploy.match(
    /\nif \[\[ "\$BUILD_API_IMAGE" -eq 1 \]\]; then\n {2}require_stateful_services_ready\n {2}maxim_webhook_preflight_multibot_prepare_capacity COMPOSE_FILES\n {2}maxim_outcome_cohort_preflight COMPOSE_FILES\nfi\n/u,
  )?.[0];
  assert.ok(block, 'An early API-only preflight block is required');
  const bin = mkdtempSync(resolve(tmpdir(), 'maxim-multibot-capacity-'));
  t.after(() => rmSync(bin, { recursive: true, force: true }));
  writeFileSync(resolve(bin, '.env'), '');
  const dfOutput = `printf 'Filesystem 1024-blocks Used Available Capacity Mounted on\\n/dev/shared 100000000 1000 %s 1%% /\\n' "$MAXIM_TEST_CAPACITY_AVAILABLE_KIB"`;
  writeFileSync(
    resolve(bin, 'docker'),
    `#!/usr/bin/env bash
set -euo pipefail
[[ "$#" -ge 11 && "$1" == compose && "$2" == --env-file && "$3" == .env && "$4" == -p && "$5" == infra && "$6" == -f && "$7" == infra/docker-compose.yml && "$8" == exec && "$9" == -T && "\${10}" == postgres ]] || { echo 'Unexpected Docker scope' >&2; exit 99; }
shift 10
case "$1" in
  psql) cat >/dev/null; printf '%s\\n' "$MAXIM_TEST_CAPACITY_METADATA" ;;
  sh) printf '/var/lib/postgresql/data/pg_wal\\n' ;;
  df) ${dfOutput} ;;
  *) echo 'Unexpected mutation' >&2; exit 99 ;;
esac
`,
    { mode: 0o755 },
  );
  writeFileSync(
    resolve(bin, 'df'),
    `#!/usr/bin/env bash
set -euo pipefail
[[ "$#" == 2 && "$1" == -Pk && "$2" == /var/lib/docker ]] || exit 99
${dfOutput}
`,
    { mode: 0o755 },
  );
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    MAXIM_TEST_CAPACITY_METADATA: JSON.stringify(metadata),
    MAXIM_TEST_CAPACITY_AVAILABLE_KIB: String(((failure === 'capacity' ? 9 : 10) * GiB) / 1024),
  };
  // Run the real CLI outside the parent Node test harness.
  delete env.NODE_TEST_CONTEXT;
  return spawnSync(
    'bash',
    [
      '-c',
      `set -euo pipefail
ROOT_DIR="$1"
source "$2"
failure="$3"
receipt="$4"
BUILD_API_IMAGE="$5"
${projectDeclaration}
${composeDeclaration}
images=unbuilt journal=current ingress=live workers=live paused=0 cutoff=0
trap 'printf "images=%s journal=%s ingress=%s workers=%s paused=%s cutoff=%s\\n" "$images" "$journal" "$ingress" "$workers" "$paused" "$cutoff"' EXIT
require_stateful_services_ready() { echo ready; }
# This fixture isolates the historical cutoff; the independent outcome hook has its own tests.
maxim_outcome_cohort_preflight() { :; }
timeout() { [[ "$failure" != receipt ]] || return 1; printf '%s\\n' "$receipt"; }
docker() { echo 'Unexpected mutation' >&2; return 99; }
run_online_multibot_migrations() { echo 'Unexpected mutation' >&2; return 99; }
${block}
echo after-preflight
images=built journal=transitioned
`,
      'multibot-early-capacity',
      root,
      library,
      failure,
      receipt,
      buildApiImage,
    ],
    { encoding: 'utf8', cwd: bin, env },
  );
}

test('online preparation succeeds before quiescence without applying the effects cutoff', () => {
  const result = probeHook();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /capacity\nprepare\nexact-indexes/u);
  assert.match(result.stdout, /status=0 ingress=live workers=live paused=0 cutoff=0/u);
});

for (const failure of ['capacity', 'prepare', 'indexes'])
  test(`${failure} failure leaves old ingress, workers, queues and cutoff unchanged`, () => {
    const result = probeHook(failure);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /status=1 ingress=live workers=live paused=0 cutoff=0/u);
    if (failure === 'capacity') assert.doesNotMatch(result.stdout, /^prepare$/mu);
    if (failure === 'prepare') assert.doesNotMatch(result.stdout, /^exact-indexes$/mu);
  });

test('a successful existing cutoff skips all online preparation work', () => {
  const result = probeHook('none', '1');
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /^(?:capacity|prepare|exact-indexes)$/mu);
  assert.match(result.stdout, /status=0 ingress=live workers=live paused=0 cutoff=0/u);
});

test('conditional preparation rejects changed or reordered Compose context in the forwarding stub', () => {
  for (const override of [
    'COMPOSE_FILES=(--env-file wrong.env -p infra -f infra/docker-compose.yml)',
    'COMPOSE_FILES=(--env-file .env -p other -f infra/docker-compose.yml)',
    'COMPOSE_FILES=(--env-file .env -p infra -f wrong.yml)',
    'COMPOSE_FILES=(-p infra --env-file .env -f infra/docker-compose.yml)',
  ]) {
    const result = probeHook('none', '0', override);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /status=1 ingress=live workers=live paused=0 cutoff=0/u);
    assert.doesNotMatch(result.stdout, /^(?:capacity|prepare|exact-indexes)$/mu);
  }
});

function probeHook(failure = 'none', receipt = '0', override = '') {
  const deploy = readFileSync(resolve(root, 'infra/scripts/vps-pull-build-up.sh'), 'utf8');
  const projectDeclaration = deploy.match(/^MAIN_PROJECT_NAME="[^"\r\n]+"$/mu)?.[0];
  const composeDeclaration = deploy.match(/^COMPOSE_FILES=\([^\r\n]+\)$/mu)?.[0];
  assert.ok(projectDeclaration && composeDeclaration, 'Use the real main Compose scope');
  return spawnSync(
    'bash',
    [
      '-c',
      `set -euo pipefail
ROOT_DIR="$1"
source "$2"
failure="$3"
receipt="$4"
${projectDeclaration}
${composeDeclaration}
${override}
ingress=live workers=live paused=0 cutoff=0
maxim_webhook_read_multibot_cutover_receipt() { printf '%s\\n' "$receipt"; }
node() {
  [[ "$1" == "$ROOT_DIR/infra/scripts/multibot-prepare-capacity.mjs" ]] || return 1
  shift
  expected=(--env-file .env -p infra -f infra/docker-compose.yml)
  [[ "$#" -eq "\${#expected[@]}" ]] || return 1
  for value in "\${expected[@]}"; do [[ "$1" == "$value" ]] || return 1; shift; done
  echo capacity
  [[ "$failure" != capacity ]]
}
run_online_multibot_migrations() { echo prepare; [[ "$failure" != prepare ]]; }
maxim_webhook_assert_multibot_migration_indexes() { echo exact-indexes; [[ "$failure" != indexes ]]; }
docker() { echo 'Unexpected container mutation' >&2; return 99; }
if maxim_webhook_prepare_multibot_before_quiescence COMPOSE_FILES; then status=0; else status=$?; fi
printf 'status=%s ingress=%s workers=%s paused=%s cutoff=%s\\n' "$status" "$ingress" "$workers" "$paused" "$cutoff"
`,
      'multibot-online-hook',
      root,
      library,
      failure,
      receipt,
    ],
    { encoding: 'utf8' },
  );
}

test('online prep follows verified image admission and precedes queue fence, ingress stop and full migrations', () => {
  const deploy = readFileSync(resolve(root, 'infra/scripts/vps-pull-build-up.sh'), 'utf8');
  const earlyPreflight = deploy.indexOf(
    '\n  maxim_webhook_preflight_multibot_prepare_capacity COMPOSE_FILES',
  );
  const imageCapacity = deploy.indexOf('\nprepare_deploy_disk_capacity\n');
  const alternateShutdown = deploy.indexOf('\nstop_conflicting_stacks\n');
  const apiImageAdmission = deploy.indexOf('\n  require_preloaded_target_image "$MAXIM_API_IMAGE"');
  const staticImageAdmission = deploy.indexOf(
    '\n  require_preloaded_target_image "$candidate_image_ref"',
  );
  const transition = deploy.indexOf('\n  begin_release_runtime_transition', earlyPreflight);
  const prepare = deploy.indexOf(
    '\n  maxim_webhook_prepare_multibot_before_quiescence COMPOSE_FILES',
  );
  const quiesce = deploy.indexOf('\n  maxim_webhook_quiesce_for_api_rollout COMPOSE_FILES');
  const ingress = deploy.indexOf(
    '\n  maxim_webhook_quiesce_legacy_ingress_for_multibot_cutover COMPOSE_FILES',
  );
  const migrations = deploy.indexOf('\n  if ! run_migrations');
  assert.ok(earlyPreflight >= 0 && imageCapacity > earlyPreflight);
  assert.ok(alternateShutdown > imageCapacity && apiImageAdmission > alternateShutdown);
  assert.ok(
    transition > apiImageAdmission &&
      staticImageAdmission > transition &&
      prepare > staticImageAdmission,
  );
  assert.ok(quiesce > prepare && ingress > quiesce && migrations > ingress);
  assert.doesNotMatch(deploy, /maxim_topology_build_shared_api_image|docker compose[^\n]* build/u);
  const beforePrepare = deploy.slice(apiImageAdmission, prepare);
  assert.doesNotMatch(beforePrepare, /recreate_service_wave|up -d.*--force-recreate/u);
  const runner = deploy.slice(
    deploy.indexOf('run_online_multibot_migrations()'),
    deploy.indexOf('\nif ! command -v docker'),
  );
  assert.match(runner, /MAXIM_MIGRATION_API_IMAGE="\$MAXIM_API_IMAGE"/u);
  assert.match(
    runner,
    /node "\$ROOT_DIR\/infra\/scripts\/multibot-online-supervisor\.mjs" "\$\{MIGRATION_COMPOSE_FILES\[@\]\}"/u,
  );
  assert.doesNotMatch(runner, /docker compose.*run/u);
});

test('capacity sums simultaneous data, sort and WAL budgets on the shared Docker device', () => {
  const report = assessMultibotPrepareCapacity(metadata, sharedFilesystems(40 * GiB));
  assert.equal(report.devices.length, 1);
  assert.deepEqual(report.devices[0].roles, ['data', 'temp', 'wal', 'docker']);
  assert.equal(report.fullIndexes, 1);
  assert.equal(report.partialIndexes, 2);
  assert.equal(report.partialIndexAllowanceBytes, GiB);
  assert.equal(report.serializedIndexBuilds, true);
  assert.equal(report.devices[0].sufficient, true);
  const insufficient = assessMultibotPrepareCapacity(metadata, sharedFilesystems(25 * GiB));
  assert.equal(insufficient.devices[0].sufficient, true);
  assert.equal(insufficient.devices[0].estimateSufficient, false);
  assert.equal(insufficient.devices[0].requiredBytes, 10 * GiB);
  assert.equal(report.admissionMinimumBytes, 10 * GiB);
  assert.equal(report.supervisionRequired, true);
  assert.ok(insufficient.devices[0].estimatedRequiredBytes > 25 * GiB);
  assert.equal(
    assessMultibotPrepareCapacity(metadata, sharedFilesystems(10 * GiB)).devices[0].sufficient,
    true,
  );
  assert.equal(
    assessMultibotPrepareCapacity(metadata, sharedFilesystems(10 * GiB - 1)).devices[0].sufficient,
    false,
  );
});

test('capacity verifies each distinct data, WAL and Docker filesystem and uses minimum observed free bytes', () => {
  const report = assessMultibotPrepareCapacity(metadata, {
    data: filesystem('/dev/data', 30 * GiB),
    temp: filesystem('/dev/data', 20 * GiB),
    wal: filesystem('/dev/wal', 15 * GiB),
    docker: filesystem('/dev/docker', 25 * GiB),
  });
  assert.equal(report.devices.length, 3);
  assert.equal(report.devices[0].availableBytes, 20 * GiB);
  assert.equal(report.devices[0].sufficient, true);
  assert.equal(report.devices[1].sufficient, true);
  assert.equal(report.devices[2].sufficient, true);
});

test('unknown or external storage layouts fail before any migration is started', () => {
  for (const change of [
    { defaultLayout: false },
    { tempTablespaces: 'external_temp' },
    { approxRows: -1 },
  ])
    assert.throws(() =>
      assessMultibotPrepareCapacity({ ...metadata, ...change }, sharedFilesystems(100 * GiB)),
    );
  assert.throws(() => assessMultibotPrepareCapacity(metadata, {}));
  assert.throws(() => parseCapacityFilesystem('unknown'));
});

test('typed capacity probe uses bounded read-only catalogs and actual PGDATA/WAL/Docker mounts', () => {
  const calls = [];
  const run = (command, args, options) => {
    calls.push({ command, args, options });
    if (args.includes('psql')) {
      assert.match(options.input, /BEGIN READ ONLY;/u);
      assert.match(options.input, /statement_timeout = '10s'/u);
      assert.doesNotMatch(options.input, /FROM\s+(?:"?public"?\.)?"?webhook_events"?\b/iu);
      return JSON.stringify(metadata);
    }
    if (args.includes('sh')) return '/var/lib/postgresql/data/pg_wal\n';
    return 'Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/shared 100000000 1000 50000000 1% /\n';
  };
  for (const composeArgs of [
    ['-f', 'fixture.yml'],
    mainComposeArgs,
    [...mainComposeArgs, '-f', 'infra/docker-compose.runtime-no-build.yml'],
    ['-f', 'fixture.yml', '--project-name', 'infra-test', '--env-file', 'fixture env'],
  ]) {
    calls.length = 0;
    const originalArgs = [...composeArgs];
    const report = checkMultibotPrepareCapacity(composeArgs, run);
    assert.deepEqual(composeArgs, originalArgs);
    assert.equal(report.devices.length, 1);
    const dockerCalls = calls.filter((call) => call.command === 'docker');
    assert.equal(dockerCalls.length, 4);
    const prefix = ['compose', ...composeArgs, 'exec', '-T', 'postgres'];
    for (const call of dockerCalls) assert.deepEqual(call.args.slice(0, prefix.length), prefix);
    assert.ok(calls.every((call) => call.options.timeout === 30_000));
    assert.ok(calls.every((call) => call.options.maxBuffer === 1024 * 1024));
    assert.ok(calls.some((call) => call.args.at(-1) === metadata.dataDirectory));
    assert.ok(calls.some((call) => call.args.at(-1) === '/var/lib/postgresql/data/pg_wal'));
    assert.ok(
      calls.some((call) => call.command === 'df' && call.args.at(-1) === '/var/lib/docker'),
    );
  }
});

test('capacity rejects malformed or unsupported Compose scopes before any external probe', () => {
  let calls = 0;
  const run = () => {
    calls += 1;
    throw new Error('Unexpected probe');
  };
  for (const composeArgs of [
    null,
    '-f fixture.yml',
    [],
    ['--env-file', '.env'],
    ['-p', 'infra'],
    ['-f'],
    ['-f', ''],
    ['-f', '   '],
    ['-f', null],
    ['-f', '-'],
    ['-f', '--env-file'],
    ['-f', 'fixture.yml\0'],
    ['-f', 'fixture.yml\n'],
    ['-f', 'fixture.yml', '--env-file'],
    ['-f', 'fixture.yml', '--env-file', ''],
    ['-f', 'fixture.yml', '--env-file', '--help'],
    ['-f', 'fixture.yml', '-p', ''],
    ['-f', 'fixture.yml', '--project-name', ''],
    ['-f', 'fixture.yml', '-p', 'InvalidProject'],
    ['-f', 'fixture.yml', '--env-file', '.env', '--env-file', 'other.env'],
    ['-f', 'fixture.yml', '-p', 'infra', '--project-name', 'other'],
    ['-f', 'fixture.yml', '--unsafe', 'value'],
    ['-f', 'fixture.yml', '--project-directory', 'directory'],
    ['-f', 'fixture.yml', '--profile', 'unsafe'],
    ['-f', 'fixture.yml', 'up', '-d'],
    ['-f', 'fixture.yml', 'down', '--remove-orphans'],
    ['-f', 'fixture.yml', '--build', 'true'],
    ['-f', 'fixture.yml', '--', 'exec'],
    ['--env-file=.env', '-f', 'fixture.yml'],
  ])
    assert.throws(
      () => checkMultibotPrepareCapacity(composeArgs, run),
      /MULTIBOT_PREPARE_COMPOSE_ARGUMENTS_INVALID/u,
    );
  assert.equal(calls, 0);
});
