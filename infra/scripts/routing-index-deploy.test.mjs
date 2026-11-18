import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

const root = resolve(import.meta.dirname, '../..');
const deploy = readFileSync(resolve(root, 'infra/scripts/vps-pull-build-up.sh'), 'utf8');
const fixture = resolve(import.meta.dirname, 'test-fixtures/routing-index-deploy.sh');

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

for (const [failure, expected] of [
  ['none', ['lock', 'authority', 'env', 'prepare', 'assert', 'journal-and-pause']],
  ['lock', ['lock']],
  ['authority', ['lock', 'authority']],
  ['prepare', ['lock', 'authority', 'env', 'prepare']],
  ['assert', ['lock', 'authority', 'env', 'prepare', 'assert']],
]) {
  test(`routing hook reports the expected steps for ${failure}`, () => {
    const result = spawnSync('bash', [fixture, failure], { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, failure === 'none' ? 0 : 1, result.stderr);
    assert.deepEqual(result.stdout.trimEnd().split('\n'), expected);
  });
}

for (const [scenario, allowed, probes] of [
  ['rollback-ok', true, ['fixture-lock', 'fixture-catalog']],
  ['rollback-complete', true, []],
  ['rollback-lock', false, ['fixture-lock']],
  ['rollback-catalog', false, ['fixture-lock', 'fixture-catalog']],
  ['rollback-other', false, []],
  ['rollback-legacy', false, ['fixture-lock']],
]) {
  test(`immutable routing rollback: ${scenario}`, () => {
    const result = spawnSync('bash', [fixture, scenario], { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, allowed ? 0 : 1, result.stderr);
    assert.deepEqual(
      result.stdout.split('\n').filter((line) => line.startsWith('fixture-')),
      probes,
    );
  });
}
