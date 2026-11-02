import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

import { globToBashEre, renderDeployImpactBash } from '../generate-deploy-impact-bash.mjs';

const root = resolve(import.meta.dirname, '../../..');
const configPath = resolve(root, 'config/change-impact.json');
const generatedPath = resolve(root, 'infra/scripts/lib/change-impact-components.generated.sh');
const classifierHelperPath = resolve(import.meta.dirname, 'fixtures/classify-deploy-impact.sh');

test('translates impact globs to slash-aware Bash regular expressions', () => {
  assert.match('apps/api/src/main.ts', new RegExp(globToBashEre('apps/api/**'), 'u'));
  assert.doesNotMatch('apps/api/deep/main.ts', new RegExp(globToBashEre('apps/api/*.ts'), 'u'));
  assert.match('AGENTS.md', new RegExp(globToBashEre('**/AGENTS.md'), 'u'));
});

test('keeps the checked-in Bash mapping synchronized with the impact config', () => {
  const rawConfig = readFileSync(configPath, 'utf8');
  assert.equal(readFileSync(generatedPath, 'utf8'), renderDeployImpactBash(rawConfig));
});

test('classifies deploy components in Bash and fails closed for unknown paths', () => {
  assert.deepEqual(classify('apps/api/src/main.ts'), [1, 0, 0, 0]);
  assert.deepEqual(classify('apps/api/src/main.spec.ts'), [0, 0, 0, 0]);
  assert.deepEqual(classify('apps/miniapp/src/main.tsx'), [0, 1, 0, 0]);
  assert.deepEqual(classify('apps/admin/src/main.tsx'), [0, 0, 1, 0]);
  assert.deepEqual(classify('packages/contracts/src/core.ts'), [1, 1, 1, 0]);
  assert.deepEqual(classify('config/prisma-migration-policy.json'), [0, 0, 0, 0]);
  assert.deepEqual(classify('config/prisma-drift-baseline.json'), [0, 0, 0, 0]);
  for (const path of [
    'AGENTS.md',
    'apps/api/prisma/migrations/README.md',
    'apps/api/test/README.md',
    'scripts/agent/README.md',
    'infra/scripts/README.md',
    'infra/env/README.md',
    'infra/certs/README.md',
    '.env.example',
    'infra/env/vps.env.example',
    'docs/operations/example.json',
  ]) {
    assert.deepEqual(classify(path), [0, 0, 0, 0], path);
  }
  assert.deepEqual(classify('future/unclassified.file'), [1, 1, 1, 1]);
});

test('selects the API image only for the exact packaged migration preparer', () => {
  assert.deepEqual(classify('scripts/agent/multibot-online-prepare.mjs'), [1, 0, 0, 0]);
  for (const path of [
    'scripts/agent/routing-index-online-target.mjs',
    'scripts/agent/routing-index-online-prepare.mjs',
    'infra/scripts/routing-index-online-state.mjs',
    'infra/scripts/online-migration-receipts.mjs',
  ])
    assert.deepEqual(classify(path), [1, 0, 0, 0], path);
  for (const path of [
    'scripts/agent/plan.mjs',
    'scripts/agent/test/multibot-online-prepare.test.mjs',
    'scripts/agent/multibot-online-prepare-retired.mjs',
    'scripts/agent/multibot-online-prepare.mjs.backup',
  ]) {
    assert.deepEqual(classify(path), [0, 0, 0, 0], path);
  }
});

function classify(path) {
  const output = execFileSync('bash', [classifierHelperPath, generatedPath, path], {
    encoding: 'utf8',
  });
  return output
    .trim()
    .split(' ')
    .map((value) => Number(value));
}
