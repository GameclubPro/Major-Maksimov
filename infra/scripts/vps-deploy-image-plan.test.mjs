import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
].join('\n');

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
  const revisions = [git('rev-parse', 'HEAD')];
  for (const [index, path] of changes.entries()) {
    mkdirSync(dirname(join(directory, path)), { recursive: true });
    writeFileSync(join(directory, path), `Changed input ${index}.\n`);
    git('add', '.');
    git('commit', '-qm', `change ${index}`);
    revisions.push(git('rev-parse', 'HEAD'));
  }
  return {
    revisions,
    run({ args = ['main', '--auto', '--image-plan'], sources = {}, driftService = '' } = {}) {
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
${selection}
[[ "$IMAGE_PLAN_ONLY" == 1 ]] || exit 93
API_SERVICES=(api-ingress api-admin)
RELEASE_COMPONENTS=(api-shared miniapp-major-static admin-static eraser)
RETENTION_DEPLOY_MODE=''
unset COMMERCIAL_OCR_DEPLOY_MODE COMMERCIAL_AI_DEPLOY_ENABLED COMMERCIAL_AI_POOL_DEPLOY_REQUESTED
unset COMMERCIAL_AI_POOL_WORKERS_DEPLOY_ENABLED COMMERCIAL_AI_POOL_DEPLOY_ENABLED COMMERCIAL_AI_POOL_DEPLOY_POLICY
unset STATISTICS_EXCHANGE_DEPLOY_ENABLED STATISTICS_CENTRAL_DEPLOY_EPOCH
source "$CLASSIFIER_PATH"
${planFunctions}
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
    *) return 94 ;;
  esac
}
docker() {
  case "$1" in
    compose) printf 'fixture-%s\\n' "\${!#}" ;;
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
maxim_topology_verify_ocr_native_sandbox_for_image() { return 0; }
COMPOSE_FILES=()
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
