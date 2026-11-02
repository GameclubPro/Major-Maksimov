import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import {
  assertSemanticMirrorQuarantineSource,
  SEMANTIC_MIRROR_QUARANTINE_SOURCE_PATHS,
} from './assert-semantic-mirror-quarantine-source.mjs';

const root = resolve(import.meta.dirname, '../..');
const paths = SEMANTIC_MIRROR_QUARANTINE_SOURCE_PATHS;
const read = (path) => readFileSync(resolve(root, path), 'utf8');

function checkChanged(path, change) {
  assertSemanticMirrorQuarantineSource((candidate) =>
    candidate === path ? change(read(path)) : read(candidate),
  );
}

function rejectChanged(path, before, after) {
  assert.ok(read(path).includes(before), `Fixture missing ${before}`);
  assert.throws(
    () => checkChanged(path, (source) => source.replaceAll(before, after)),
    /typed semantic-mirror quarantine reader/u,
  );
}

test('rollback accepts the typed deadline-free reader including a writer-disabled image', () => {
  assert.doesNotThrow(() => assertSemanticMirrorQuarantineSource(read));
  assert.doesNotThrow(() =>
    checkChanged(paths.service, (source) =>
      source.replace(
        'WEBHOOK_DEPENDENCY_QUARANTINE_WRITES_ENABLED = true',
        'WEBHOOK_DEPENDENCY_QUARANTINE_WRITES_ENABLED = false',
      ),
    ),
  );
  assert.doesNotThrow(() =>
    assertSemanticMirrorQuarantineSource((path) => read(path).replaceAll('  ', '    ')),
  );
});

test('rollback rejects status-only, marker-only and accidentally expiring semantic readers', () => {
  for (const [before, after] of [
    [
      'WEBHOOK_SEMANTIC_MIRROR_QUARANTINE_READER_VERSION = 1',
      'WEBHOOK_SEMANTIC_MIRROR_QUARANTINE_READER_VERSION = 0',
    ],
    ['entry.kind === WebhookDependencyKind.SEMANTIC_MIRROR', 'false'],
    ['entry.kind !== WebhookDependencyKind.ORDERED || !entry.deadlineAt', '!entry.deadlineAt'],
    ['entry.deadlineAt !== null', 'false'],
    ['receipt.executionDeadlineAt !== null', 'false'],
    ["owner.status !== 'PROCESSED'", "owner.status !== 'FAILED'"],
    ['owner.errorMessage !== null', 'false'],
    ["completed.status !== 'COMPLETED'", 'false'],
    ['completed.webhookEventId !== owner.id', 'false'],
    ['completed.leaseToken !== null', 'false'],
    ['execution_deadline_at IS NULL', 'execution_deadline_at > clock_timestamp()'],
  ])
    rejectChanged(paths.service, before, after);
  rejectChanged(
    paths.service,
    'export const WEBHOOK_SEMANTIC_MIRROR_QUARANTINE_READER_VERSION = 1;',
    '// export const WEBHOOK_SEMANTIC_MIRROR_QUARANTINE_READER_VERSION = 1;',
  );
});

test('rollback requires the persisted kind and nullable deadline schema', () => {
  for (const [before, after] of [
    ['SEMANTIC_MIRROR', 'UNTYPED_MIRROR'],
    ['WebhookDependencyKind @default(ORDERED)', 'WebhookDependencyKind @default(SEMANTIC_MIRROR)'],
    ['deadlineAt DateTime?', 'deadlineAt DateTime'],
  ])
    rejectChanged(paths.schema, before, after);
});

test('both API rollback paths check dependency readers before replacing runtime', () => {
  for (const [path, mutation] of [
    ['infra/scripts/vps-runtime-rollback.sh', '\ngit switch --detach '],
    ['infra/scripts/vps-release-rollback.sh', '\nbegin_release_runtime_transition\n'],
  ]) {
    const source = read(path);
    const check = source.indexOf('\nmaxim_topology_require_dependency_quarantine ');
    const selectedApiCheck = source.indexOf('\n  maxim_topology_require_dependency_quarantine ');
    const guard = Math.max(check, selectedApiCheck);
    const runtime = source.indexOf(mutation);
    assert.ok(
      guard >= 0 && runtime > guard,
      `${path} must reject an incompatible target before runtime mutation`,
    );
  }
});
