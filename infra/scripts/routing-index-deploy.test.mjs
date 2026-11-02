import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

const root = resolve(import.meta.dirname, '../..');
const deploy = readFileSync(resolve(root, 'infra/scripts/vps-pull-build-up.sh'), 'utf8');
const hook = resolve(root, 'infra/scripts/lib/routing-index-online-prepare.sh');

test('routing preparation precedes the first release journal and all queue pauses', () => {
  const preflight = deploy.indexOf('  maxim_routing_index_preflight COMPOSE_FILES');
  const prepare = deploy.indexOf('  maxim_routing_index_prepare\n');
  const build = deploy.indexOf('  maxim_topology_require_photo_native_image_capability');
  const transition = deploy.indexOf('  begin_release_runtime_transition\n');
  const pause = deploy.indexOf('  maxim_webhook_quiesce_for_api_rollout COMPOSE_FILES');
  assert.ok(preflight > 0 && preflight < deploy.indexOf('\nprepare_deploy_disk_capacity\n'));
  assert.ok(build > 0 && prepare > build && prepare < transition && transition < pause);
  assert.ok(
    deploy.indexOf('  maxim_routing_index_assert COMPOSE_FILES') >
      deploy.indexOf('  if ! run_migrations; then'),
  );
});

for (const failure of ['none', 'lock', 'authority', 'prepare', 'assert']) {
  test(`routing hook ${failure} preserves the current manifest on refusal`, () => {
    const result = spawnSync(
      'bash',
      [
        '-c',
        `set -euo pipefail
ROOT_DIR="$1"
failure="$2"
source "$3"
MAXIM_API_IMAGE=maxim-api:1111111111111111111111111111111111111111
MIGRATION_COMPOSE_FILES=(--env-file '.env' -p infra -f infra/docker-compose.yml -f infra/docker-compose.runtime-no-build.yml)
require_deploy_lock() { echo lock; [[ "$failure" != lock ]]; }
maxim_require_ordinary_effect_authority() { echo authority; [[ "$failure" != authority ]]; }
ensure_compose_env() { echo env; }
node() {
  [[ "$#" == 10 && "$3" == --env-file && "$4" == .env && "$5" == -p && "$6" == infra && "$7" == -f && "$8" == infra/docker-compose.yml && "$9" == -f && "\${10}" == infra/docker-compose.runtime-no-build.yml ]] || return 99
  case "$1:$2" in
    "$ROOT_DIR/infra/scripts/routing-index-online-supervisor.mjs:prepare")
      [[ "$MAXIM_MIGRATION_API_IMAGE" == "$MAXIM_API_IMAGE" ]] || return 99
      echo prepare
      [[ "$failure" != prepare ]] ;;
    "$ROOT_DIR/infra/scripts/routing-index-online-state.mjs:assert")
      echo assert
      [[ "$failure" != assert ]] ;;
    *) return 99 ;;
  esac
}
maxim_routing_index_prepare
echo journal-and-pause
`,
        'routing-hook',
        root,
        failure,
        hook,
      ],
      { encoding: 'utf8' },
    );
    assert.equal(result.status, failure === 'none' ? 0 : 1, result.stderr);
    if (failure === 'none')
      assert.match(result.stdout, /lock\nauthority\nenv\nprepare\nassert\njournal-and-pause/u);
    else assert.doesNotMatch(result.stdout, /journal-and-pause/u);
    if (['lock', 'authority'].includes(failure))
      assert.doesNotMatch(result.stdout, /env|prepare|assert/u);
    if (failure === 'prepare') assert.doesNotMatch(result.stdout, /assert/u);
  });
}
