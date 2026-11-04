import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { parseImagePreparationPlan } from './registry-preload.mjs';

const deploy = readFileSync(new URL('./vps-pull-build-up.sh', import.meta.url), 'utf8');
const connector = readFileSync(new URL('./vps-connect.sh', import.meta.url), 'utf8');
const sha = 'a'.repeat(40);

function shellFunction(source, name, next) {
  const start = source.indexOf(`${name}() {\n`);
  const end = source.indexOf(`\n${next}() {`, start);
  assert.ok(start >= 0 && end > start);
  return source.slice(start, end);
}

function imagePlan({ selected = [], impact = [], modeFlag = '' } = {}) {
  const code = `set -euo pipefail
${shellFunction(deploy, 'contains_service', 'validate_requested_services')}
${shellFunction(deploy, 'print_image_preparation_plan', 'has_requested_api_service')}
RELEASE_COMPONENTS=(api-shared miniapp-major-static admin-static eraser)
SERVICES=(${selected.join(' ')})
COMMERCIAL_AI_POOL_DEPLOY_ENABLED="$MODE_FLAG"
impact_plan_selects_component() { [[ "$IMPACT" == *"|$1|"* ]]; }
git() { printf '%s\\n' "$SOURCE_SHA"; }
print_image_preparation_plan
`;
  return spawnSync('bash', ['-c', code], {
    encoding: 'utf8',
    env: {
      ...process.env,
      SOURCE_SHA: sha,
      IMPACT: impact.map((value) => `|${value}|`).join(''),
      MODE_FLAG: modeFlag,
    },
  });
}

test('release preparation adds accumulated component changes to explicitly requested services', () => {
  const result = imagePlan({ selected: ['admin-static'], impact: ['api-shared'] });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(parseImagePreparationPlan(result.stdout, sha), ['api-shared', 'admin-static']);
});

test('API roles share one image and Lastik remains an independent component', () => {
  const result = imagePlan({
    selected: ['api-ingress', 'api-admin', 'eraser'],
    impact: ['eraser'],
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(parseImagePreparationPlan(result.stdout, sha), ['eraser', 'api-shared']);
});

test('a runtime mode change prepares API even without source impact; no-op auto plans stay empty', () => {
  const changed = imagePlan({ modeFlag: 'false' });
  assert.equal(changed.status, 0, changed.stderr);
  assert.deepEqual(parseImagePreparationPlan(changed.stdout, sha), ['api-shared']);
  const noop = imagePlan();
  assert.equal(noop.status, 0, noop.stderr);
  assert.deepEqual(parseImagePreparationPlan(noop.stdout, sha), []);
});

test('unsupported legacy and store targets cannot enter registry delivery', () => {
  for (const selected of [['miniapp-static'], ['postgres']]) {
    const result = imagePlan({ selected });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /No CI registry component/u);
  }
});

test('normal delivery prepares every image before invoking the final runtime executor', () => {
  const normal = shellFunction(connector, 'deploy_main', 'prepare_registry_release_images');
  const preparation = normal.indexOf(
    'prepare_registry_release_images "$branch" "$expected_sha" "$remote_command"',
  );
  const runtime = normal.lastIndexOf('remote_exec "$remote_command"');
  assert.ok(preparation > 0 && runtime > preparation);
  assert.match(normal, /assert-green\.mjs "\$expected_sha" --purpose production/u);
  assert.match(
    deploy,
    /if \[\[ "\$IMAGE_PLAN_ONLY" -eq 1 \]\]; then\n {2}load_current_component_images\n {2}print_image_preparation_plan\n {2}exit 0/u,
  );
  assert.ok(
    deploy.indexOf('print_image_preparation_plan\n  exit 0') <
      deploy.lastIndexOf('\ninitialize_release_inventory\n'),
  );
  assert.doesNotMatch(
    deploy,
    /docker compose.* build|docker buildx build|maxim_topology_build_shared_api_image/u,
  );
});
