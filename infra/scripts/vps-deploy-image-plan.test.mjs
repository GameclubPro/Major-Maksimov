import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { parseImagePreparationPlan } from './registry-preload.mjs';

const deploy = readFileSync(new URL('./vps-pull-build-up.sh', import.meta.url), 'utf8');
const classifierPath = fileURLToPath(
  new URL('./lib/change-impact-components.generated.sh', import.meta.url),
);
const imageId = `sha256:${'1'.repeat(64)}`;
const components = ['api-shared', 'miniapp-major-static', 'admin-static', 'eraser'];

function shellFunction(name, next) {
  const start = deploy.indexOf(`${name}() {\n`);
  const end = deploy.indexOf(`\n${next}() {`, start);
  assert.ok(start >= 0 && end > start, `Missing deploy function ${name}`);
  return deploy.slice(start, end);
}

const selectionStart = deploy.indexOf('SERVICES=()\n');
const selectionEnd = deploy.indexOf('\nAPI_SERVICES=', selectionStart);
assert.ok(selectionStart >= 0 && selectionEnd > selectionStart);
const selection = deploy.slice(selectionStart, selectionEnd);
const planFunctions = [
  shellFunction('contains_service', 'validate_requested_services'),
  shellFunction('component_manifest_matches_runtime', 'impact_plan_selects_component'),
  shellFunction('impact_plan_selects_component', 'derive_auto_services'),
  shellFunction('derive_auto_services', 'print_deploy_plan'),
  shellFunction('print_image_preparation_plan', 'has_requested_api_service'),
  shellFunction('api_deploy_settings_requested', 'is_enabled'),
  shellFunction('verify_eraser_only_release', 'record_successful_release'),
].join('\n');

const runtimeSelectionStart = deploy.indexOf('\nif api_deploy_settings_requested &&');
const runtimeSelectionEnd = deploy.indexOf('\nvalidate_requested_services', runtimeSelectionStart);
assert.ok(runtimeSelectionStart >= 0 && runtimeSelectionEnd > runtimeSelectionStart);
const runtimeSelection = deploy.slice(runtimeSelectionStart, runtimeSelectionEnd);

function fixture(t, changes = []) {
  const directory = mkdtempSync(join(tmpdir(), 'maxim-real-image-plan-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const git = (...args) => {
    const result = spawnSync(
      'git',
      [
        '-c',
        'core.hooksPath=/dev/null',
        '-c',
        'user.name=Image plan fixture',
        '-c',
        'user.email=image-plan@example.invalid',
        ...args,
      ],
      { cwd: directory, encoding: 'utf8', timeout: 5000 },
    );
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git('init', '-q', '--initial-branch=main');
  writeFileSync(join(directory, 'README.md'), 'Image plan fixture.\n');
  git('add', '.');
  git('commit', '-qm', 'component baseline');
  writeFileSync(join(directory, '.env'), 'POSTGRES_PASSWORD=fixture\n');
  const revisions = [git('rev-parse', 'HEAD')];
  for (const [index, path] of changes.entries()) {
    mkdirSync(dirname(join(directory, path)), { recursive: true });
    writeFileSync(join(directory, path), `Changed input ${index}.\n`);
    git('add', path);
    git('commit', '-qm', `change ${index}`);
    revisions.push(git('rev-parse', 'HEAD'));
  }
  return {
    revisions,
    run({
      args = ['main', '--auto', '--image-plan'],
      sources = {},
      driftService = '',
      probe = 'plan',
      refusal = '',
    } = {}) {
      return spawnSync(
        'bash',
        [
          '--noprofile',
          '--norc',
          '-euo',
          'pipefail',
          '-c',
          `
DEPLOY_MODE=manual
IMAGE_PLAN_ONLY=0
BRANCH="$1"
EXPECTED_DEPLOY_SHA="$(git rev-parse HEAD)"
POST_RELEASE_RECLAIM=0
MAXIM_WEBHOOK_ROLLOUT_ADOPT_EXISTING_PAUSE=0
${selection}
API_SERVICES=(api-ingress api-admin)
RELEASE_COMPONENTS=(api-shared miniapp-major-static admin-static eraser)
RETENTION_DEPLOY_MODE=''
unset COMMERCIAL_OCR_DEPLOY_MODE COMMERCIAL_AI_DEPLOY_ENABLED COMMERCIAL_AI_POOL_DEPLOY_REQUESTED
unset COMMERCIAL_AI_POOL_WORKERS_DEPLOY_ENABLED COMMERCIAL_AI_POOL_DEPLOY_ENABLED COMMERCIAL_AI_POOL_DEPLOY_POLICY
unset STATISTICS_EXCHANGE_DEPLOY_ENABLED STATISTICS_CENTRAL_DEPLOY_EPOCH
source "$CLASSIFIER_PATH"
${planFunctions}
if [[ "$FIXTURE_REFUSAL" == api-settings ]]; then COMMERCIAL_AI_POOL_DEPLOY_REQUESTED=true; fi
if [[ "$FIXTURE_REFUSAL" == reclaim ]]; then POST_RELEASE_RECLAIM=1; fi
if [[ "$FIXTURE_REFUSAL" == recovery ]]; then MAXIM_WEBHOOK_ROLLOUT_ADOPT_EXISTING_PAUSE=1; fi
if [[ "$FIXTURE_REFUSAL" == missing-env ]]; then rm .env; fi
release_manifest() {
  [[ "$*" == 'validate-current --eraser-rollback-baseline 1' && "$FIXTURE_REFUSAL" != journal ]]
}
release_field() {
  local source
  case "$1" in
    api-shared) source="$FIXTURE_API_SHA" ;;
    miniapp-major-static) source="$FIXTURE_MINIAPP_SHA" ;;
    admin-static) source="$FIXTURE_ADMIN_SHA" ;;
    eraser) source="$FIXTURE_ERASER_SHA" ;;
    *) return 94 ;;
  esac
  case "$2" in
    sourceSha) printf '%s\\n' "$source" ;;
    imageId) printf '%s\\n' "$FIXTURE_IMAGE_ID" ;;
    imageRef) printf 'maxim-%s:%s\\n' "$1" "$source" ;;
    *) return 94 ;;
  esac
}
docker() {
  case "$1" in
    compose)
      if [[ "$2" == -p && "$3" == infra-scale ]]; then
        case "$FIXTURE_REFUSAL" in
          scale-running) printf 'api-ingress\\n' ;;
          scale-unknown) return 1 ;;
        esac
        return
      fi
      printf 'fixture-%s\\n' "\${!#}"
      ;;
    image)
      [[ "$FIXTURE_REFUSAL" != rollback-image ]] || return 1
      printf '%s\\n' "$FIXTURE_IMAGE_ID"
      ;;
    inspect)
      if [[ -n "$FIXTURE_DRIFT_SERVICE" && "\${!#}" == "fixture-$FIXTURE_DRIFT_SERVICE" ]]; then
        printf 'sha256:drift\\n'
      else
        printf '%s\\n' "$FIXTURE_IMAGE_ID"
      fi
      ;;
    *) return 95 ;;
  esac
}
maxim_topology_verify_ocr_native_sandbox_for_image() { [[ "$FIXTURE_REFUSAL" != ocr && "$FIXTURE_REFUSAL" != photo ]]; }
maxim_topology_require_eraser_bridge() { [[ "$FIXTURE_REFUSAL" != bridge ]]; }
maxim_durable_executor_requested() { [[ "$FIXTURE_REFUSAL" == durable ]]; }
maxim_eraser_configured() { return 0; }
maxim_eraser_require_stores() { [[ "$FIXTURE_REFUSAL" != stores ]]; }
node() {
  if [[ "$1" == infra/scripts/assert-eraser-source.mjs ]]; then
    case "$3:$4" in
      --connection-requests:api-shared|--connection-requests:eraser|--rate-limit-reader:eraser|--connection-proof-reader:eraser)
        [[ "$FIXTURE_REFUSAL" != source-floor ]]
        return
        ;;
      *) return 96 ;;
    esac
  fi
  command node "$@"
}
COMPOSE_FILES=()
ALTERNATE_COMPOSE_FILES=(-p infra-scale -f infra/docker-compose.scale.yml)
if [[ "$FIXTURE_PROBE" == runtime ]]; then
  verify_eraser_only_release
  ${runtimeSelection}
  printf 'BUILD_API_IMAGE=%s\\n' "$BUILD_API_IMAGE"
  printf 'RUNTIME_SERVICE=%s\\n' "\${SERVICES[@]}"
  exit
fi
[[ "$IMAGE_PLAN_ONLY" == 1 ]] || exit 93
print_image_preparation_plan
if [[ "$DEPLOY_MODE" == auto ]]; then
  derive_auto_services
  for service in "\${SERVICES[@]}"; do printf 'AUTO_SERVICE=%s\\n' "$service"; done
fi
`,
          'real-image-plan',
          ...args,
        ],
        {
          cwd: directory,
          encoding: 'utf8',
          timeout: 5000,
          env: {
            ...process.env,
            BASH_ENV: '/dev/null',
            ENV: '/dev/null',
            CLASSIFIER_PATH: classifierPath,
            FIXTURE_IMAGE_ID: imageId,
            FIXTURE_API_SHA: sources['api-shared'] ?? revisions[0],
            FIXTURE_MINIAPP_SHA: sources['miniapp-major-static'] ?? revisions[0],
            FIXTURE_ADMIN_SHA: sources['admin-static'] ?? revisions[0],
            FIXTURE_ERASER_SHA: sources.eraser ?? revisions[0],
            FIXTURE_DRIFT_SERVICE: driftService,
            FIXTURE_PROBE: probe,
            FIXTURE_REFUSAL: refusal,
          },
        },
      );
    },
  };
}

for (const [scenario, paths, expected] of [
  ['no-op', [], []],
  ['mini app', ['apps/miniapp/src/night-setting.tsx'], ['miniapp-major-static']],
  ['Safety Desk', ['apps/admin/src/overview.tsx'], ['admin-static']],
  ['shared API', ['apps/api/src/night-mode.ts'], ['api-shared']],
  ['Lastik', ['apps/eraser/src/worker.ts'], ['eraser']],
  ['contracts', ['packages/contracts/src/settings.ts'], components],
  ['unknown input', ['unclassified-runtime-input.bin'], components],
]) {
  test(`actual --auto --image-plan and runtime selection agree for ${scenario} changes`, (t) => {
    const data = fixture(t, paths);
    const result = data.run();
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(parseImagePreparationPlan(result.stdout, data.revisions.at(-1)), expected);
    const runtimeComponents = result.stdout
      .split('\n')
      .filter((line) => line.startsWith('AUTO_SERVICE='))
      .map((line) => line.slice('AUTO_SERVICE='.length))
      .map((service) => (service.startsWith('api-') ? 'api-shared' : service));
    assert.deepEqual(runtimeComponents, expected);
  });
}

test('cumulative planning uses each active component manifest source independently', (t) => {
  const data = fixture(t, ['apps/miniapp/src/night-setting.tsx', 'apps/api/src/night-mode.ts']);
  const result = data.run({
    sources: {
      'api-shared': data.revisions[1],
      'miniapp-major-static': data.revisions[0],
      'admin-static': data.revisions[2],
      eraser: data.revisions[2],
    },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(parseImagePreparationPlan(result.stdout, data.revisions[2]), [
    'api-shared',
    'miniapp-major-static',
  ]);
});

test('manual service requests retain cumulative API impact and the exact source SHA', (t) => {
  const data = fixture(t, ['apps/api/src/night-mode.ts']);
  const result = data.run({ args: ['main', 'admin-static', '--image-plan'] });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(parseImagePreparationPlan(result.stdout, data.revisions[1]), [
    'api-shared',
    'admin-static',
  ]);
});

test('Lastik-only image plan and runtime exclude accumulated API and static changes', (t) => {
  const data = fixture(t, [
    'apps/api/src/night-mode.ts',
    'apps/admin/src/overview.tsx',
    'apps/eraser/src/worker.ts',
  ]);
  const planned = data.run({ args: ['main', '--eraser-only', '--image-plan'] });
  assert.equal(planned.status, 0, planned.stderr);
  assert.deepEqual(parseImagePreparationPlan(planned.stdout, data.revisions.at(-1)), ['eraser']);
  const runtime = data.run({ args: ['main', '--eraser-only'], probe: 'runtime' });
  assert.equal(runtime.status, 0, runtime.stderr);
  assert.equal(runtime.stdout, 'BUILD_API_IMAGE=0\nRUNTIME_SERVICE=eraser\n');
  const ordinary = data.run({ sources: { eraser: data.revisions.at(-1) } });
  assert.equal(ordinary.status, 0, ordinary.stderr);
  assert.deepEqual(parseImagePreparationPlan(ordinary.stdout, data.revisions.at(-1)), [
    'api-shared',
    'admin-static',
  ]);
});

test('Lastik-only planning and runtime refuse unsafe starting states', (t) => {
  const data = fixture(t);
  for (const options of [
    { refusal: 'journal' },
    { refusal: 'scale-running' },
    { refusal: 'scale-unknown' },
    { refusal: 'api-settings' },
    { refusal: 'reclaim' },
    { refusal: 'recovery' },
    { refusal: 'durable' },
    { refusal: 'bridge' },
    { refusal: 'source-floor' },
    { refusal: 'ocr' },
    { refusal: 'photo' },
    { refusal: 'rollback-image' },
    { refusal: 'stores' },
    { driftService: 'api-admin' },
    { driftService: 'admin-static' },
    { driftService: 'eraser' },
    { sources: { eraser: 'unknown' } },
    { refusal: 'missing-env' },
  ]) {
    for (const probe of ['plan', 'runtime']) {
      const args = ['main', '--eraser-only', ...(probe === 'plan' ? ['--image-plan'] : [])];
      const result = data.run({ args, probe, ...options });
      assert.ok([1, 2].includes(result.status), JSON.stringify({ ...options, probe, ...result }));
      assert.equal(result.stdout, '');
    }
  }
});

test('Lastik-only refuses a target with shared connection changes', (t) => {
  const data = fixture(t, ['apps/api/src/message-retention/new-bridge.ts']);
  const result = data.run({ args: ['main', '--eraser-only', '--image-plan'] });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /unchanged shared connection/u);
});

test('failed Lastik manifest publication retains its journal and committed pointer', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'maxim-eraser-commit-exit-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const current = join(directory, 'current.json');
  const journal = 'current.invalid-deploy-eraser-fixture.json';
  writeFileSync(current, 'committed successor');
  writeFileSync(join(directory, journal), 'previous release');
  const result = spawnSync(
    'bash',
    [
      '-euc',
      `
RELEASE_STATE_DIR="$1"
RECOVERY_BASE_MANIFEST="$1/$2"
DEPLOY_RUNTIME_STARTED=1
DEPLOY_MANIFEST_RECORDED=0
DEPLOY_MODE=eraser-only
${shellFunction('invalidate_stale_release_inventory', 'cleanup')}
invalidate_stale_release_inventory
`,
      'lastik-commit-exit',
      directory,
      journal,
    ],
    { encoding: 'utf8', timeout: 5000 },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(readdirSync(directory).sort(), [journal, 'current.json']);
  assert.equal(readFileSync(current, 'utf8'), 'committed successor');
});

test('native attestation rejects unknown OCR capability and unexpected legacy runtime', () => {
  const topology = fileURLToPath(new URL('./lib/deploy-topology.sh', import.meta.url));
  const result = spawnSync(
    'bash',
    [
      '-ec',
      `source "$1"
COMPOSE_FILES=(-p infra -f infra/docker-compose.yml)
maxim_topology_verify_photo_native_sandbox_for_image() { return 0; }
docker() {
  case "$1" in
    image)
      case "$LABEL" in
        unavailable) return 1 ;;
        absent) return 0 ;;
        *) printf '%s' "$LABEL" ;;
      esac
      ;;
    compose)
      if [[ "$PRESENT" == 1 ]]; then printf '%s' running-sandbox; fi
      ;;
    ps)
      case "$*" in
        'ps -a -q --no-trunc --filter label=com.docker.compose.project=infra --filter label=com.docker.compose.service=ocr-native-sandbox-2')
          if [[ "\${EXTRA_PRESENT:-0}" == 1 ]]; then printf '%064d' 2; fi ;;
        'ps -a -q --no-trunc --filter label=com.docker.compose.project=infra --filter label=com.docker.compose.service=ocr-native-sandbox-3') ;;
        *) return 99 ;;
      esac
      ;;
    *) return 99 ;;
  esac
}
for LABEL in unavailable malformed; do
  if maxim_topology_verify_ocr_native_sandbox_for_image COMPOSE_FILES "$2"; then exit 10; fi
  if maxim_topology_require_ocr_native_sandbox_image_capability "$2" 0; then exit 11; fi
done
LABEL=absent
PRESENT=1
if maxim_topology_verify_ocr_native_sandbox_for_image COMPOSE_FILES "$2"; then exit 12; fi
PRESENT=0
EXTRA_PRESENT=1
if maxim_topology_verify_ocr_native_sandbox_for_image COMPOSE_FILES "$2"; then exit 13; fi
EXTRA_PRESENT=0
maxim_topology_verify_ocr_native_sandbox_for_image COMPOSE_FILES "$2"
maxim_topology_require_ocr_native_sandbox_image_capability "$2" 0
`,
      'ocr-attestation',
      topology,
      imageId,
    ],
    { encoding: 'utf8', timeout: 5000 },
  );
  assert.equal(result.status, 0, result.stderr);
});

test('runtime image drift selects its component even when source is current', (t) => {
  const data = fixture(t);
  const result = data.run({ driftService: 'admin-static' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(parseImagePreparationPlan(result.stdout, data.revisions[0]), ['admin-static']);
});

const admissionStart = deploy.indexOf('\nif acquire_deploy_lock; then\n');
const admissionEnd = deploy.indexOf('\ntrap cleanup EXIT', admissionStart);
assert.ok(admissionStart >= 0 && admissionEnd > admissionStart);
const admission = deploy.slice(admissionStart, admissionEnd);

for (const [refusal, expected] of [
  ['pair_lock_busy', 'pair_lock_busy'],
  ['product_lock_busy', 'product_lock_busy'],
  ['unknown', 'unknown'],
  ['private inherited text\nunsafe=value', 'unknown'],
]) {
  test(`backend admission reports only an allowlisted refusal (${expected})`, () => {
    const result = spawnSync(
      'bash',
      [
        '--noprofile',
        '--norc',
        '-euo',
        'pipefail',
        '-c',
        `
acquire_deploy_lock() { MAXIM_DEPLOY_ADMISSION_REFUSAL="$FIXTURE_REFUSAL"; return 37; }
maxim_durable_executor_requested() { return 1; }
${admission}
printf 'unexpected runtime\\n'
`,
      ],
      {
        encoding: 'utf8',
        timeout: 5000,
        env: {
          ...process.env,
          BASH_ENV: '/dev/null',
          ENV: '/dev/null',
          // Reproduce Bash's remote startup path even in a local validation shell.
          SSH_CLIENT: 'fixture',
          SHLVL: '0',
          FIXTURE_REFUSAL: refusal,
        },
      },
    );
    assert.equal(result.status, 37, result.stderr);
    assert.equal(result.stdout, '');
    assert.equal(
      result.stderr,
      `Deploy admission refused: MAXIM_DEPLOY_ADMISSION_REFUSAL=${expected} exit=37\n`,
    );
  });
}
