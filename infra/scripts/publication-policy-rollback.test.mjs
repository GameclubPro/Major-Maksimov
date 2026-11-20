import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  assertPublicationPolicySource,
  PUBLICATION_CALENDAR_PROJECTION_CHECKS,
  PUBLICATION_POLICY_SOURCE_CHECKS,
} from './assert-publication-policy-source.mjs';

test('rollback requires the deadline reader, every execution boundary and the untouched-target CAS', () => {
  const checks = [...PUBLICATION_POLICY_SOURCE_CHECKS, ...PUBLICATION_CALENDAR_PROJECTION_CHECKS];
  const sources = new Map(
    checks.map(([path]) => [path, readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8')]),
  );
  assert.doesNotThrow(() => assertPublicationPolicySource((path) => sources.get(path)));
  for (const [path, fragments] of checks) {
    for (const fragment of fragments) {
      const before = sources.get(path).replace(/\s+/gu, '');
      const after = before.replaceAll(fragment.replace(/\s+/gu, ''), 'unsafe_reader');
      assert.notEqual(after, before, `Missing mutation: ${fragment}`);
      assert.throws(
        () =>
          assertPublicationPolicySource((candidate) =>
            candidate === path ? after : sources.get(candidate),
          ),
        /Rollback target lacks/u,
      );
    }
  }
  const service = 'apps/api/src/admin/publication.service.ts';
  const legacySource = readFileSync(new URL(`../../${service}`, import.meta.url), 'utf8')
    .replaceAll(
      'countRecurrenceRollupOccurrences(rule, grouped)',
      'readPublicationLatePolicy(rule)',
    )
    .replaceAll('countableCalendarOccurrenceWhere(rule)', 'legacyOccurrenceWhere(rule)');
  const readLegacy = (path) => {
    assert.notEqual(path, 'apps/api/src/admin/publication-calendar-projection.ts');
    return path === service ? legacySource : sources.get(path);
  };
  assert.doesNotThrow(() => assertPublicationPolicySource(readLegacy));
  assert.throws(
    () =>
      assertPublicationPolicySource((path) =>
        path === service
          ? legacySource.replace('maxResults: 300', 'maxResults: 999')
          : readLegacy(path),
      ),
    /maxResults: 300/u,
  );

  for (const path of ['vps-runtime-rollback.sh', 'vps-release-rollback.sh'])
    assert.match(
      readFileSync(new URL(path, import.meta.url), 'utf8'),
      /maxim_topology_require_publication_policy/u,
    );
});
