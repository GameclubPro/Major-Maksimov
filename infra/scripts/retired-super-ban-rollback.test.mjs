import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { assertRetiredSuperBanSource } from './assert-retired-super-ban-source.mjs';
const read = (path) => readFileSync(new URL('../../' + path, import.meta.url), 'utf8');
test('rollback requires compatible message dispatch, queue wiring and both registry readers', () => {
  assert.doesNotThrow(() => assertRetiredSuperBanSource(read));
  for (const [path, from, to] of [
    [
      'moderation/moderation-state-delete-guard.service.ts',
      'Developer-forced global blacklist',
      'Developer-forcedglobalblacklist',
    ],
    ['admin/admin.module.ts', 'AdminModule', 'AdminSuperBanProcessor'],
    ['moderation/global-spammer-provenance.ts', 'sources.every(isActiveObservationSource)', 'true'],
    [
      'moderation/global-spammer-intelligence.service.ts',
      'hasActiveRegistryProvenance(snapshot.sourceBreakdown)',
      'true',
    ],
    [
      'moderation/moderation-state-delete-guard.service.ts',
      'this.metadata(latest.metadata).superBan !== true',
      'true',
    ],
  ]) {
    const file = 'apps/api/src/' + path;
    assert.throws(
      () =>
        assertRetiredSuperBanSource((name) =>
          name === file ? read(name).replace(from, to) : read(name),
        ),
      /reactivate retired/u,
    );
  }
});
