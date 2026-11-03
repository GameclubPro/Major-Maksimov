import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  DEFAULT_CONFIG_PATH,
  loadImpactConfig,
  matchesImpactPattern,
  validateImpactConfig,
} from '../impact-config.mjs';
import { createImpactPlan, renderImpactPlanHuman, renderImpactPlanJson } from '../impact-plan.mjs';

const config = await loadImpactConfig();

test('loads a config whose routine components exclude paused delivery targets', () => {
  assert.deepEqual(config.deployComponentIds, [
    'api-shared',
    'miniapp-major-static',
    'admin-static',
    'eraser',
  ]);
  for (const component of config.deployComponentIds) {
    assert.doesNotMatch(component, /app2|cdn|object[-_]storage|s3/iu);
  }
});

test('rejects a forbidden routine component even when a rule references it correctly', async () => {
  const invalid = JSON.parse(await readFile(DEFAULT_CONFIG_PATH, 'utf8'));
  invalid.deployComponents.push({ id: 'app2-static', label: 'Paused shell' });
  invalid.fallback.deployComponents.push('app2-static');

  assert.throws(() => validateImpactConfig(invalid, '<test-config>'), /forbidden fragment app2/u);
});

test('matches root and recursive glob patterns without crossing path segments for a single star', () => {
  assert.equal(matchesImpactPattern('AGENTS.md', '**/AGENTS.md'), true);
  assert.equal(matchesImpactPattern('apps/api/AGENTS.md', '**/AGENTS.md'), true);
  assert.equal(matchesImpactPattern('apps/api/src/main.ts', 'apps/api/**'), true);
  assert.equal(matchesImpactPattern('apps/api/main.ts', 'apps/*/main.ts'), true);
  assert.equal(matchesImpactPattern('apps/api/src/main.ts', 'apps/*/main.ts'), false);
});

test('maps API runtime changes to the shared API component', () => {
  const plan = planFor([{ status: 'M', path: 'apps/api/src/main.ts' }]);

  assert.deepEqual(plan.deploy.components, ['api-shared']);
  assert.deepEqual(plan.unknownPaths, []);
  assert.ok(plan.checks.includes('api'));
  assert.equal(plan.migration.required, false);
});

test('maps Lastik runtime and tests to its independent validation boundary', () => {
  const runtime = planFor([{ status: 'M', path: 'apps/eraser/src/runtime.ts' }]);
  assert.deepEqual(runtime.deploy.components, ['eraser']);
  assert.deepEqual(runtime.checks, ['repo-static', 'eraser']);
  assert.deepEqual(runtime.unknownPaths, []);

  const tests = planFor([{ status: 'M', path: 'apps/eraser/test/runtime.stores.ts' }]);
  assert.deepEqual(tests.deploy.components, []);
  assert.deepEqual(tests.checks, ['repo-static', 'eraser']);
  assert.deepEqual(tests.unknownPaths, []);
});

test('deploys and validates the exact migration preparer copied into the API image', () => {
  for (const status of ['A', 'M', 'D']) {
    const plan = planFor([{ status, path: 'scripts/agent/multibot-online-prepare.mjs' }]);

    assert.deepEqual(plan.deploy.components, ['api-shared']);
    assert.deepEqual(plan.checks, ['repo-static', 'agent-tools', 'infra', 'api', 'prisma']);
    assert.deepEqual(plan.unknownPaths, []);
    assert.equal(plan.migration.required, false);
    assert.equal(plan.migration.reviewRequired, false);
  }

  const renamed = planFor([
    {
      status: 'R100',
      oldPath: 'scripts/agent/multibot-online-prepare.mjs',
      newPath: 'scripts/agent/multibot-online-prepare-retired.mjs',
    },
  ]);
  assert.deepEqual(renamed.deploy.components, ['api-shared']);
});

test('keeps other agent tools and migration preparer tests deployment-free', () => {
  for (const path of [
    'scripts/agent/plan.mjs',
    'scripts/agent/test/multibot-online-prepare.test.mjs',
    'scripts/agent/multibot-online-prepare-retired.mjs',
    'scripts/agent/multibot-online-prepare.mjs.backup',
  ]) {
    const plan = planFor([{ status: 'M', path }]);

    assert.deepEqual(plan.checks, ['repo-static', 'agent-tools']);
    assert.deepEqual(plan.deploy.components, []);
    assert.deepEqual(plan.unknownPaths, []);
  }
});

test('keeps workspace tests out of production deploy scope', () => {
  const plan = planFor([
    { status: 'M', path: 'packages/contracts/test/publication-contract.spec.ts' },
    { status: 'M', path: 'apps/api/src/health/health.service.spec.ts' },
    { status: 'M', path: 'apps/miniapp/test/public-config.test.ts' },
    { status: 'M', path: 'apps/admin/test/admin-request.test.ts' },
  ]);

  assert.deepEqual(plan.deploy.components, []);
  assert.ok(plan.checks.includes('contracts'));
  assert.ok(plan.checks.includes('api'));
  assert.ok(plan.checks.includes('miniapp'));
  assert.ok(plan.checks.includes('admin'));
  assert.deepEqual(plan.unknownPaths, []);
});

test('maps shared contracts to every active production component', () => {
  const plan = planFor([{ status: 'M', path: 'packages/contracts/src/publication.ts' }]);

  assert.deepEqual(plan.deploy.components, [
    'api-shared',
    'miniapp-major-static',
    'admin-static',
    'eraser',
  ]);
  assert.ok(plan.checks.includes('contracts'));
  assert.ok(plan.checks.includes('api'));
  assert.ok(plan.checks.includes('miniapp-production-build'));
  assert.ok(plan.checks.includes('admin'));
});

test('reports a Prisma schema change without migration as review-required', () => {
  const plan = planFor([{ status: 'M', path: 'apps/api/prisma/schema.prisma' }]);

  assert.deepEqual(plan.deploy.components, ['api-shared']);
  assert.deepEqual(plan.migration, {
    schemaChanged: true,
    configOnly: false,
    migrationFiles: [],
    required: true,
    present: false,
    reviewRequired: true,
  });
  assert.match(plan.warnings.join('\n'), /without a changed migration\.sql/u);
});

test('accepts a config-only Prisma schema change and rejects a deleted migration as evidence', () => {
  const configOnlyPlan = planFor([{ status: 'M', path: 'apps/api/prisma/schema.prisma' }], {
    schemaChanged: true,
    migrationRequired: false,
    configOnly: true,
  });
  assert.deepEqual(configOnlyPlan.migration, {
    schemaChanged: true,
    configOnly: true,
    migrationFiles: [],
    required: false,
    present: false,
    reviewRequired: false,
  });
  assert.match(
    renderImpactPlanHuman(configOnlyPlan, config),
    /limited to generator\/datasource configuration/u,
  );

  const deletedMigrationPlan = planFor([
    { status: 'M', path: 'apps/api/prisma/schema.prisma' },
    {
      status: 'D',
      path: 'apps/api/prisma/migrations/20260719000000_removed/migration.sql',
    },
  ]);
  assert.equal(deletedMigrationPlan.migration.present, false);
  assert.equal(deletedMigrationPlan.migration.reviewRequired, true);
  assert.deepEqual(deletedMigrationPlan.migration.migrationFiles, []);
});

test('recognizes a changed Prisma migration and keeps tooling-only changes migration-free', () => {
  const schemaPlan = planFor([
    { status: 'M', path: 'apps/api/prisma/schema.prisma' },
    {
      status: 'A',
      path: 'apps/api/prisma/migrations/20260719000000_example/migration.sql',
    },
  ]);
  assert.equal(schemaPlan.migration.present, true);
  assert.equal(schemaPlan.migration.reviewRequired, false);

  const toolingPlan = planFor([{ status: 'M', path: 'apps/api/prisma.config.ts' }]);
  assert.equal(toolingPlan.migration.required, false);
  assert.deepEqual(toolingPlan.deploy.components, ['api-shared']);
});

test('classifies Prisma migration and drift baselines as validation-only tooling', () => {
  for (const path of ['config/prisma-migration-policy.json', 'config/prisma-drift-baseline.json']) {
    const plan = planFor([{ status: 'M', path }]);

    assert.deepEqual(plan.unknownPaths, []);
    assert.deepEqual(plan.deploy.components, []);
    assert.deepEqual(plan.checks, ['repo-static', 'prisma']);
  }
});

test('maps mini app runtime and CSS changes only to the Major static service', () => {
  const plan = planFor([
    { status: 'M', path: 'apps/miniapp/src/pages/chats-page.tsx' },
    { status: 'M', path: 'apps/miniapp/src/pages/chats-page.css' },
  ]);

  assert.deepEqual(plan.deploy.components, ['miniapp-major-static']);
  assert.ok(plan.checks.includes('miniapp-css'));
  assert.ok(plan.checks.includes('miniapp-production-build'));
  assert.ok(plan.checks.includes('miniapp-visual-local'));
});

test('maps Safety Desk runtime changes only to admin-static', () => {
  const plan = planFor([{ status: 'M', path: 'apps/admin/src/admin-app.tsx' }]);

  assert.deepEqual(plan.deploy.components, ['admin-static']);
  assert.ok(plan.checks.includes('admin'));
});

test('shared Vite resolution selects both frontend builds and visuals, not the API', () => {
  const plan = planFor([{ status: 'M', path: 'scripts/vite-contracts-source.mjs' }]);
  assert.deepEqual(plan.deploy.components, ['miniapp-major-static', 'admin-static']);
  for (const check of ['miniapp', 'miniapp-production-build', 'miniapp-visual-local', 'admin']) {
    assert.ok(plan.checks.includes(check), check);
  }
  assert.deepEqual(plan.unknownPaths, []);
  const tooling = planFor([{ status: 'A', path: '.prettierignore' }]);
  assert.deepEqual(tooling.deploy.components, []);
  assert.deepEqual(tooling.unknownPaths, []);
});

test('maps nginx files to explicit manual operations without container deploy targets', () => {
  const plan = planFor([
    { status: 'M', path: 'infra/nginx/major-maksimov.ru.conf' },
    { status: 'M', path: 'infra/nginx/admin.major-maksimov.ru.conf' },
  ]);

  assert.deepEqual(plan.deploy.components, []);
  assert.deepEqual(plan.deploy.manualOperations, ['apply-major-nginx', 'apply-admin-nginx']);
  assert.equal(plan.deploy.reviewRequired, true);
});

test('maps the root lockfile fail-closed to all checks and active components', () => {
  const plan = planFor([{ status: 'M', path: 'package-lock.json' }]);

  assert.deepEqual(plan.deploy.components, [
    'api-shared',
    'miniapp-major-static',
    'admin-static',
    'eraser',
  ]);
  assert.ok(plan.checks.includes('full'));
  assert.ok(plan.checks.includes('prisma'));
});

test('keeps docs and agent notes deployment-free', () => {
  const plan = planFor([
    { status: 'M', path: 'README.md' },
    { status: 'M', path: 'apps/api/AGENTS.md' },
    { status: 'M', path: 'apps/api/README.md' },
    { status: 'M', path: 'packages/contracts/README.md' },
    { status: 'M', path: 'packages/contracts/test/README.md' },
    { status: 'M', path: 'apps/api/test/README.md' },
    { status: 'M', path: 'apps/api/prisma/migrations/README.md' },
    { status: 'M', path: 'apps/miniapp/test/README.md' },
    { status: 'M', path: 'apps/admin/test/README.md' },
    { status: 'M', path: 'docs/runbook.md' },
    { status: 'M', path: 'scripts/agent/README.md' },
    { status: 'M', path: 'scripts/README.md' },
    { status: 'M', path: '.github/README.md' },
    { status: 'M', path: 'infra/scripts/README.md' },
    { status: 'M', path: 'infra/env/README.md' },
    { status: 'M', path: 'infra/nginx/README.md' },
    { status: 'M', path: 'infra/certs/README.md' },
    { status: 'M', path: 'infra/www/major-maksimov/README.md' },
    { status: 'M', path: 'infra/README.md' },
    { status: 'M', path: 'apps/api/src/__tests__/README.md' },
  ]);

  assert.deepEqual(plan.deploy.components, []);
  assert.deepEqual(plan.unknownPaths, []);
  assert.deepEqual(plan.checks, ['docs']);
});

test('keeps environment templates and non-Markdown documentation out of the notes-only shortcut', () => {
  for (const path of ['.env.example', 'infra/env/vps.env.example']) {
    const plan = planFor([{ status: 'M', path }]);
    assert.deepEqual(plan.checks, ['repo-static', 'docs', 'infra'], path);
    assert.deepEqual(plan.deploy.components, [], path);
    assert.deepEqual(plan.unknownPaths, [], path);
  }
  const asset = planFor([{ status: 'M', path: 'docs/operations/example.json' }]);
  assert.deepEqual(asset.checks, ['repo-static', 'docs']);
  assert.deepEqual(asset.deploy.components, []);
  assert.deepEqual(asset.unknownPaths, []);
});

test('actual repository tools retain complete tooling checks while application changes use core static', () => {
  for (const path of ['scripts/check-docs.mjs', '.github/workflows/ci.yml']) {
    const plan = planFor([{ status: 'M', path }]);
    assert.deepEqual(plan.checks, ['repo-static', 'agent-tools'], path);
    assert.deepEqual(plan.deploy.components, [], path);
  }
  assert.equal(config.checkById['repo-static'].script, 'check:static:ci');
  const infra = planFor([{ status: 'M', path: 'infra/scripts/deploy.sh' }]);
  assert.deepEqual(infra.checks, ['repo-static', 'infra']);
  assert.deepEqual(infra.deploy.components, []);
});

test('unknown paths fail closed with full validation, all components, and a warning', () => {
  const plan = planFor([{ status: 'A', path: 'new-runtime/entrypoint.ts' }]);

  assert.deepEqual(plan.unknownPaths, ['new-runtime/entrypoint.ts']);
  assert.deepEqual(plan.checks, ['full']);
  assert.deepEqual(plan.deploy.components, [
    'api-shared',
    'miniapp-major-static',
    'admin-static',
    'eraser',
  ]);
  assert.equal(plan.deploy.reviewRequired, true);
  assert.match(plan.warnings[0], /Unclassified paths/u);
});

test('classifies both sides of a rename and renders deterministic human and JSON output', () => {
  const input = [
    { status: 'M', path: 'apps/admin/src/admin-app.tsx' },
    {
      status: 'R100',
      oldPath: 'apps/api/src/old.ts',
      newPath: 'docs/old-api.md',
    },
    { status: 'M', path: 'apps/miniapp/test/public-config.test.ts' },
  ];
  const first = planFor(input);
  const second = planFor([...input].reverse());

  assert.deepEqual(first.changedFiles, [
    'apps/admin/src/admin-app.tsx',
    'apps/api/src/old.ts',
    'apps/miniapp/test/public-config.test.ts',
    'docs/old-api.md',
  ]);
  assert.deepEqual(first.deploy.components, ['api-shared', 'admin-static']);
  assert.equal(renderImpactPlanJson(first), renderImpactPlanJson(second));
  assert.equal(renderImpactPlanHuman(first, config), renderImpactPlanHuman(second, config));
  assert.match(
    renderImpactPlanHuman(first, config),
    /R100 apps\/api\/src\/old\.ts -> docs\/old-api\.md/u,
  );
});

function planFor(changes, prismaSchemaImpact = null) {
  const changedPaths = [...new Set(changes.flatMap(changePaths))];
  return createImpactPlan({
    config,
    changeSet: {
      source: { mode: 'worktree', base: null, head: null },
      changes: changes.map((change) => ({ ...change, paths: changePaths(change) })),
      changedPaths,
    },
    prismaSchemaImpact,
  });
}

function changePaths(change) {
  return change.oldPath && change.newPath ? [change.oldPath, change.newPath] : [change.path];
}
