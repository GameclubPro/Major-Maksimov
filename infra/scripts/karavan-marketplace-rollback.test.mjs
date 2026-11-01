import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  assertKaravanMarketplaceSource,
  KARAVAN_MARKETPLACE_SOURCE_CHECKS,
} from './assert-karavan-marketplace-source.mjs';
const root = resolve(import.meta.dirname, '../..');
const read = (path) => readFileSync(resolve(root, path), 'utf8');
test('current source retains scoped publication, format epochs, fixed targets and enrollment readers', () => {
  assert.doesNotThrow(() => assertKaravanMarketplaceSource('a'.repeat(40), read));
});
for (const [path, markers] of KARAVAN_MARKETPLACE_SOURCE_CHECKS)
  for (const marker of markers)
    test(`rollback refuses missing Karavan guard: ${marker}`, () => {
      assert.throws(
        () =>
          assertKaravanMarketplaceSource('a'.repeat(40), (sourcePath) =>
            sourcePath === path ? read(path).replaceAll(marker, 'missing_guard') : read(sourcePath),
          ),
        (error) =>
          error instanceof Error &&
          error.message.includes('lacks permanent Karavan') &&
          error.message.endsWith(path),
      );
    });
for (const file of [
  'infra/scripts/vps-release-rollback.sh',
  'infra/scripts/vps-runtime-rollback.sh',
])
  test(`${file} checks Karavan reader floor before runtime mutation`, () => {
    const source = read(file);
    const guard = source.indexOf('maxim_topology_require_karavan_marketplaces ');
    assert.ok(guard > 0);
    assert.ok(guard < source.lastIndexOf('maxim_webhook_quiesce_for_api_rollout'));
  });
