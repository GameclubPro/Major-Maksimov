import assert from 'node:assert/strict';
import test from 'node:test';

import { buildMigrationReadiness, renderMigrationReadiness } from '../migration-readiness.mjs';

test('migration readiness stays quiet for unrelated paths', () => {
  const report = buildMigrationReadiness([
    'apps/api/src/spammers/spammer-removal.service.ts',
    'infra/scripts/routing-index-online.test.mjs',
  ]);
  assert.equal(report, null);
  assert.equal(renderMigrationReadiness(report), '');
});

test('migration readiness warns when the diff includes an unpinned tail after the routing index', () => {
  const report = buildMigrationReadiness([
    'apps/api/prisma/migrations/20261121000100_index_spammer_projection_due/migration.sql',
    'apps/api/prisma/migrations/20261122000000_add_review_metadata/migration.sql',
  ]);
  assert.equal(report.unpinnedTailChanged, true);
  assert.equal(report.pinnedSourceChanged, true);
  const output = renderMigrationReadiness(report);
  assert.match(output, /If the index is still pending/u);
  assert.match(output, /routing table cap is 160 GiB including TOAST/u);
  assert.match(output, /#early-migration-readiness/u);
});

test('a change to the pinned source calls for checksum review rather than claiming a new tail', () => {
  const report = buildMigrationReadiness([
    'apps/api/prisma/migrations/20261121000100_index_spammer_projection_due/migration.sql',
  ]);
  assert.equal(report.unpinnedTailChanged, false);
  assert.match(renderMigrationReadiness(report), /Review the exact migration list, checksums/u);
});

test('schema or routing policy alone still surfaces the operator checklist', () => {
  for (const path of [
    'apps/api/prisma/schema.prisma',
    'infra/scripts/routing-index-prepare-capacity.mjs',
  ]) {
    assert.match(renderMigrationReadiness(buildMigrationReadiness([path])), /Operator checklist/u);
  }
});
