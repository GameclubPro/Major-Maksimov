import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

const root = resolve(import.meta.dirname, '../..');
const deployScript = readFileSync(resolve(root, 'infra/scripts/vps-pull-build-up.sh'), 'utf8');

function runArgumentSelection(args) {
  const start = deployScript.indexOf('SERVICES=()\n');
  const end = deployScript.indexOf('\nAPI_SERVICES=', start);
  assert.notEqual(start, -1, 'deploy service selection start is missing');
  assert.notEqual(end, -1, 'deploy service selection end is missing');

  const selection = deployScript.slice(start, end);
  const probe = `set -euo pipefail
DEPLOY_MODE="manual"
${selection}
printf 'mode=%s\\n' "$DEPLOY_MODE"
printf 'service=%s\\n' "\${SERVICES[@]}"
`;

  return spawnSync('bash', ['-c', probe, 'deploy-selection-test', ...args], {
    encoding: 'utf8',
    cwd: root,
  });
}

const expectedFullSelection = [
  'mode=full',
  'service=api-ingress',
  'service=api-admin',
  'service=api-enqueue',
  'service=api-moderation',
  'service=api-moderation-critical',
  'service=api-moderation-join',
  'service=api-moderation-realtime-b',
  'service=api-moderation-realtime-c',
  'service=api-moderation-realtime-d',
  'service=api-moderation-background',
  'service=api-media-analysis',
  'service=api-action',
  'service=api-publisher',
  'service=api-message-retention',
  'service=miniapp-major-static',
  'service=admin-static',
];

test('default and --full select every active production service', () => {
  for (const args of [['main'], ['main', '--full']]) {
    const result = runArgumentSelection(args);
    const expected = [...expectedFullSelection];
    expected[0] = args.length === 1 ? 'mode=manual' : 'mode=full';

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.stdout.trim().split('\n'), expected);
  }
});

test('--full rejects an explicitly requested service in either order', () => {
  for (const args of [
    ['main', '--full', 'api-admin'],
    ['main', 'api-admin', '--full'],
  ]) {
    const result = runArgumentSelection(args);

    assert.equal(result.status, 2);
    assert.match(result.stderr, /Explicit services cannot be combined with --full\./u);
  }
});

test('--eraser-only selects Lastik and excludes other runtime targets', () => {
  for (const args of [
    ['main', '--eraser-only'],
    ['main', '--eraser-only', '--image-plan'],
  ]) {
    const result = runArgumentSelection(args);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.stdout.trim().split('\n'), ['mode=eraser-only', 'service=eraser']);
  }
  for (const extra of ['--auto', '--plan', '--full', '--eraser-only', 'eraser', 'api-ingress']) {
    assert.equal(runArgumentSelection(['main', '--eraser-only', extra]).status, 2);
    assert.equal(runArgumentSelection(['main', extra, '--eraser-only']).status, 2);
  }
});

test('legacy preview/apply refuses before service selection or runtime mutation', () => {
  for (const operation of [
    '--legacy-order-preview=owner-a,owner-b',
    `--legacy-order-apply=${'a'.repeat(64)}:owner-a,owner-b`,
  ]) {
    const result = runArgumentSelection(['main', operation, 'api-ingress']);
    assert.equal(result.status, 2);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /cold_activation_disabled/u);
  }
});

test('legacy operations reject selection plans, duplicate operations and unreviewed apply', () => {
  for (const args of [
    ['main', '--plan', '--legacy-order-preview=owner-a'],
    ['main', '--legacy-order-preview=owner-a', '--legacy-order-preview=owner-b'],
    ['main', '--legacy-order-apply=owner-a'],
  ])
    assert.equal(runArgumentSelection(args).status, 2);
});
