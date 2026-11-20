import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  assertPublicationPolicySource,
  PUBLICATION_POLICY_SOURCE_CHECKS,
} from './assert-publication-policy-source.mjs';

const service = 'apps/api/src/admin/publication.service.ts';
const projection = 'apps/api/src/admin/publication-calendar-projection.ts';
const source = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');

test('rollback requires the deadline reader, every execution boundary and the untouched-target CAS', () => {
  const sources = new Map(PUBLICATION_POLICY_SOURCE_CHECKS.map(([path]) => [path, source(path)]));
  sources.set(projection, source(projection));
  assert.doesNotThrow(() => assertPublicationPolicySource((path) => sources.get(path)));
  for (const [path, fragments] of PUBLICATION_POLICY_SOURCE_CHECKS) {
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
  for (const path of ['vps-runtime-rollback.sh', 'vps-release-rollback.sh'])
    assert.match(
      readFileSync(new URL(path, import.meta.url), 'utf8'),
      /maxim_topology_require_publication_policy/u,
    );
});

test('requires the executed filter and rollup readers of the delegated calendar', () => {
  for (const [path, fragment] of [
    [service, '...countableCalendarOccurrenceWhere(rule)'],
    [service, "from './publication-calendar-projection'"],
    [service, 'countRecurrenceRollupOccurrences(rule, grouped)'],
    [projection, 'return readPublicationLatePolicy(rule)'],
    [projection, 'Boolean(readPublicationLatePolicy(rule))'],
    [projection, 'return count + (counts ? group._count._all : 0)'],
  ]) {
    assert.ok(source(path).includes(fragment));
    assert.throws(
      () =>
        assertPublicationPolicySource((candidate) =>
          candidate === path
            ? source(path).replaceAll(fragment, 'missing_reader')
            : source(candidate),
        ),
      /Rollback target lacks/u,
    );
  }
});

test('retains inline readers without requiring an extracted file or accepting an unrelated marker', () => {
  const filter =
    '...(readPublicationLatePolicy(rule) ? {} : { status: { not: PublicationOccurrenceStatus.CANCELED } })';
  const where = `where: { scheduleId: schedule.id, scheduleRevision: schedule.revision, ${filter}`;
  const inline = `this.prisma.publicationOccurrence.count({ ${where} } });
  this.prisma.publicationOccurrence.findFirst({ ${where} } });
  !readPublicationLatePolicy(rule) && group.status === PublicationOccurrenceStatus.CANCELED ? count : count + group._count._all;
  expandPublicationSchedule(rule, {maxResults: 300});`;
  const read = (code) => (path) => {
    assert.notEqual(path, projection);
    return path === service ? code : source(path);
  };
  assert.doesNotThrow(() => assertPublicationPolicySource(read(inline)));
  assert.throws(
    () => assertPublicationPolicySource(read(inline.replace(filter, '...unconditional'))),
    /Rollback target lacks/u,
  );
});
