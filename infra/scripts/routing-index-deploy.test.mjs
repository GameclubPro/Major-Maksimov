import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

const root = resolve(import.meta.dirname, '../..');
const deploy = readFileSync(resolve(root, 'infra/scripts/vps-pull-build-up.sh'), 'utf8');
const fixture = resolve(import.meta.dirname, 'test-fixtures/routing-index-deploy.sh');

test('routing preparation precedes the first release journal and all queue pauses', () => {
  const preflight = deploy.indexOf('  maxim_routing_index_preflight "$TARGET_SHA" COMPOSE_FILES');
  const prepare = deploy.indexOf(
    '  maxim_routing_index_prepare "$TARGET_SHA" ROUTING_INDEX_RELEASE_STATE',
  );
  const build = deploy.indexOf('  maxim_topology_require_photo_native_image_capability');
  const transition = deploy.indexOf('  begin_release_runtime_transition\n');
  const pause = deploy.indexOf('  maxim_webhook_quiesce_for_api_rollout COMPOSE_FILES');
  assert.ok(preflight > 0 && preflight < deploy.indexOf('\nprepare_deploy_disk_capacity\n'));
  assert.ok(build > 0 && prepare > build && prepare < transition && transition < pause);
});

function runScenario(scenario, allowed = true) {
  const result = spawnSync('bash', [fixture, scenario], {
    cwd: root,
    encoding: 'utf8',
    timeout: 5_000,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, allowed ? 0 : 1, result.stderr);
  return result.stdout.split('\n').filter((line) => line.startsWith('fixture-'));
}

test('a verified compatible release skips index preparation and the general Prisma runner', () => {
  assert.deepEqual(runScenario('compatible'), [
    'fixture-state:preflight:compatible_pending',
    'fixture-state:prepare:compatible_pending',
    'fixture-journal',
    'fixture-state:rollout:compatible_pending',
    'fixture-pause',
    'fixture-state:post-migration:compatible_pending',
    'fixture-transition',
  ]);
});

test('a changed routing state stops the release before queue pause and Prisma', () => {
  assert.deepEqual(runScenario('changed-before-pause', false), [
    'fixture-state:preflight:compatible_pending',
    'fixture-state:prepare:compatible_pending',
    'fixture-journal',
    'fixture-state:rollout:prepare_routing',
  ]);
});

test('first giveaway activation stops before Prisma and role replacement when either mutator still runs', () => {
  assert.deepEqual(runScenario('giveaway-stop-refused', false), [
    'fixture-state:preflight:compatible_pending',
    'fixture-state:prepare:compatible_pending',
    'fixture-journal',
    'fixture-state:rollout:compatible_pending',
    'fixture-pause',
    'fixture-giveaway-stop',
    'fixture-giveaway-verify',
  ]);
});

test('an incompatible post-migration snapshot stops the release before role replacement', () => {
  assert.deepEqual(runScenario('changed-after-pause', false), [
    'fixture-state:preflight:compatible_pending',
    'fixture-state:prepare:compatible_pending',
    'fixture-journal',
    'fixture-state:rollout:compatible_pending',
    'fixture-pause',
    'fixture-state:post-migration:prepare_routing',
  ]);
});

test('the ordinary path runs the capacity check and confirms preparation before pausing queues', () => {
  assert.deepEqual(runScenario('prepare'), [
    'fixture-state:preflight:prepare_routing',
    'fixture-capacity',
    'fixture-state:prepare:prepare_routing',
    'fixture-prepare',
    'fixture-state:prepare:already_applied',
    'fixture-journal',
    'fixture-state:rollout:already_applied',
    'fixture-pause',
    'fixture-prisma',
    'fixture-state:post-migration:already_applied',
    'fixture-transition',
  ]);
});

test('capacity refusal does not touch the current release', () => {
  assert.deepEqual(runScenario('capacity', false), [
    'fixture-state:preflight:prepare_routing',
    'fixture-capacity',
  ]);
});

test('an incomplete build does not touch the current release', () => {
  assert.deepEqual(runScenario('prepare-incomplete', false), [
    'fixture-state:preflight:prepare_routing',
    'fixture-capacity',
    'fixture-state:prepare:prepare_routing',
    'fixture-prepare',
    'fixture-state:prepare:prepare_routing',
  ]);
});

test('an already applied index still permits ordinary Prisma migrations', () => {
  const trace = runScenario('applied');
  assert.ok(trace.includes('fixture-prisma'));
  assert.ok(!trace.includes('fixture-capacity') && !trace.includes('fixture-prepare'));
  assert.equal(trace.at(-1), 'fixture-transition');
});

test('a release cannot inspect compatibility without the protected lock', () => {
  assert.deepEqual(runScenario('lock', false), ['fixture-lock-refused']);
});

test('a release with a blocked effect authority cannot start preparation', () => {
  const trace = runScenario('authority', false);
  assert.ok(trace.includes('fixture-authority-refused'));
  assert.ok(!trace.includes('fixture-prepare') && !trace.includes('fixture-journal'));
});

for (const [scenario, allowed, probes] of [
  [
    'rollback-ok',
    true,
    ['fixture-lock', 'fixture-catalog', 'fixture-rollback-state:not_in_target'],
  ],
  ['rollback-complete', true, ['fixture-rollback-state:already_applied']],
  ['rollback-lock', false, ['fixture-lock']],
  ['rollback-catalog', false, ['fixture-lock', 'fixture-catalog']],
  ['rollback-other', false, []],
  ['rollback-legacy', false, ['fixture-lock']],
  ['rollback-pending', true, ['fixture-rollback-state:compatible_pending']],
  ['rollback-blocked', false, ['fixture-rollback-state:prepare_routing']],
]) {
  test(`immutable routing rollback: ${scenario}`, () => {
    assert.deepEqual(runScenario(scenario, allowed), probes);
  });
}

for (const [scenario, state, runsPrisma] of [
  ['ref-rollback-compatible', 'compatible_pending', false],
  ['ref-rollback-applied', 'already_applied', true],
  ['ref-rollback-old', 'not_in_target', true],
]) {
  test(`ref rollback uses the selected source's routing state: ${state}`, () => {
    assert.deepEqual(runScenario(scenario), [
      `fixture-state:ref-rollback:${state}`,
      'fixture-switch',
      'fixture-journal',
      ...(runsPrisma ? ['fixture-prisma'] : []),
      'fixture-pause',
    ]);
  });
}

test('ref rollback stops before checkout when the selected source still needs preparation', () => {
  assert.deepEqual(runScenario('ref-rollback-blocked', false), [
    'fixture-state:ref-rollback:prepare_routing',
  ]);
});
