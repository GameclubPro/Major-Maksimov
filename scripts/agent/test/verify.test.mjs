import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

import { parseVerifyArgs, selectVerificationScripts } from '../verify.mjs';
import { loadImpactConfig } from '../impact-config.mjs';
import { createImpactPlan } from '../impact-plan.mjs';

const config = {
  checkById: {
    'repo-static': { id: 'repo-static', script: 'check:static:ci' },
    api: { id: 'api', script: 'check:api' },
    full: { id: 'full', script: 'check' },
    'agent-tools': { id: 'agent-tools', script: 'test:agent-tools' },
    infra: { id: 'infra', script: 'check:infra' },
    miniapp: { id: 'miniapp', script: 'check:miniapp' },
    'miniapp-css': { id: 'miniapp-css', script: 'check:miniapp-css' },
    'miniapp-visual-local': { id: 'miniapp-visual-local', script: 'screenshots:miniapp:smoke' },
  },
};

test('selects mapped checks in plan order', () => {
  assert.deepEqual(
    selectVerificationScripts({
      config,
      plan: { checks: ['repo-static', 'api'] },
    }),
    [
      { id: 'repo-static', script: 'check:static:ci' },
      { id: 'api', script: 'check:api' },
    ],
  );
});

test('a scoped mixed plan runs the existing public API aggregate once before infrastructure', async () => {
  const repositoryConfig = await loadImpactConfig();
  const changedPaths = ['apps/api/src/main.ts', 'infra/scripts/vps-connect.sh'];
  const plan = createImpactPlan({
    config: repositoryConfig,
    changeSet: {
      source: { mode: 'worktree', base: null, head: null },
      changedPaths,
      changes: changedPaths.map((path) => ({ status: 'M', path, paths: [path] })),
    },
  });
  assert.deepEqual(selectVerificationScripts({ config: repositoryConfig, plan }), [
    { id: 'repo-static', script: 'check:static:ci' },
    { id: 'api', script: 'check:api' },
    { id: 'infra', script: 'check:infra' },
  ]);
});

test('full check supersedes narrower checks but retains the browser smoke', () => {
  assert.deepEqual(
    selectVerificationScripts({
      config,
      plan: { checks: ['repo-static', 'api', 'full'] },
    }),
    [
      { id: 'full', script: 'check' },
      { id: 'miniapp-visual-local', script: 'screenshots:miniapp:smoke' },
    ],
  );
  assert.deepEqual(selectVerificationScripts({ config, plan: null, full: true }), [
    { id: 'full', script: 'check' },
    { id: 'miniapp-visual-local', script: 'screenshots:miniapp:smoke' },
  ]);
});

test('deduplicates only checks guaranteed by the current aggregate npm scripts', () => {
  const scripts = JSON.parse(
    readFileSync(new URL('../../../package.json', import.meta.url), 'utf8'),
  ).scripts;
  for (const [aggregate, nested] of [
    ['check:static', 'test:agent-tools'],
    ['check:static:ci', 'test:agent-tools:core'],
    ['check:miniapp', 'check:miniapp-css'],
  ]) {
    assert.ok(scripts[aggregate].split(/\s*&&\s*/u).includes(`npm run ${nested}`));
  }
  assert.deepEqual(
    selectVerificationScripts({
      config,
      plan: {
        checks: ['repo-static', 'agent-tools', 'miniapp-css', 'miniapp', 'miniapp-visual-local'],
      },
    }).map((check) => check.id),
    ['repo-static', 'miniapp', 'miniapp-visual-local'],
  );
  assert.deepEqual(
    selectVerificationScripts({ config, plan: { checks: ['agent-tools', 'miniapp-css'] } }).map(
      (check) => check.id,
    ),
    ['agent-tools', 'miniapp-css'],
  );
});

test('runs local tooling once and includes infrastructure only when selected', () => {
  for (const checks of [
    ['repo-static', 'agent-tools'],
    ['agent-tools', 'repo-static'],
  ]) {
    assert.deepEqual(selectVerificationScripts({ config, plan: { checks } }), [
      { id: 'repo-static', script: 'check:static:ci' },
    ]);
  }
  for (const checks of [
    ['repo-static', 'infra'],
    ['repo-static', 'agent-tools', 'infra'],
  ]) {
    assert.deepEqual(selectVerificationScripts({ config, plan: { checks } }), [
      { id: 'repo-static', script: 'check:static:ci' },
      { id: 'infra', script: 'check:infra' },
    ]);
  }
  assert.deepEqual(selectVerificationScripts({ config, plan: { checks: ['agent-tools'] } }), [
    { id: 'agent-tools', script: 'test:agent-tools:core' },
  ]);
  assert.deepEqual(
    selectVerificationScripts({ config, plan: { checks: ['agent-tools', 'infra'] } }),
    [
      { id: 'agent-tools', script: 'test:agent-tools:core' },
      { id: 'infra', script: 'check:infra' },
    ],
  );
});

test('parses full and dry-run modes without weakening range validation', () => {
  assert.equal(parseVerifyArgs(['--full', '--dry-run']).full, true);
  assert.throws(() => parseVerifyArgs(['--full', '--staged']), /cannot be combined/u);
  assert.throws(() => parseVerifyArgs(['--full', '--since', 'HEAD']), /cannot be combined/u);
  assert.equal(parseVerifyArgs(['--base', 'main', '--head', 'HEAD']).mode, 'range');
});

test('rejects a check without an executable script mapping', () => {
  assert.throws(
    () => selectVerificationScripts({ config, plan: { checks: ['docs'] } }),
    /has no npm script mapping/u,
  );
});
