import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import {
  assertLegacyDispositionSource,
  LEGACY_CLAIM_WRITER_SOURCE_COUNTS,
  LEGACY_DISPOSITION_SOURCE_CHECKS,
} from '../../infra/scripts/assert-legacy-disposition-source.mjs';

const root = resolve(import.meta.dirname, '../..');
const read = (path) => readFileSync(resolve(root, path), 'utf8');
const producerPath = 'apps/api/src/publisher/publisher-auto-reply-producer.service.ts';
const removalPath = 'apps/api/src/webhook/webhook-legacy-held-removal.ts';

function refusesChangedSource(path, changed) {
  assert.notEqual(changed, read(path), 'mutation must change the actual reviewed source');
  assert.throws(
    () =>
      assertLegacyDispositionSource('a'.repeat(40), (name) =>
        name === path ? changed : read(name),
      ),
    /lacks permanent/u,
  );
}

function cancellationMethod(change) {
  const source = read(producerPath);
  const start = source.indexOf('  private async cancelPendingSourceDelivery(');
  const end = source.indexOf('\n  private async admitSource(', start);
  assert.ok(start >= 0 && end > start);
  return source.slice(0, start) + change(source.slice(start, end)) + source.slice(end);
}

function journalStatement(method) {
  const start = method.indexOf('await tx.publisherAutoReplyDelivery.updateMany(');
  const end = method.indexOf('\n      });', start);
  assert.ok(start >= 0 && end > start);
  return method.slice(start, end + '\n      });'.length);
}

test('current exact source has every permanent legacy hold and final effect reader', () => {
  assert.doesNotThrow(() => assertLegacyDispositionSource('a'.repeat(40), read));
});
for (const [path, markers] of LEGACY_DISPOSITION_SOURCE_CHECKS) {
  for (const marker of markers)
    test(`rollback refuses removal of ${path}: ${marker}`, () => {
      assert.throws(
        () =>
          assertLegacyDispositionSource('a'.repeat(40), (sourcePath) =>
            sourcePath === path
              ? read(path).replaceAll(marker, 'removed_reviewed_guard')
              : read(sourcePath),
          ),
        /lacks permanent/u,
      );
    });
}
for (const [path, marker, minimum] of LEGACY_CLAIM_WRITER_SOURCE_COUNTS)
  for (let occurrence = 0; occurrence < minimum; occurrence++)
    test(`rollback refuses one missing claim writer guard: ${path} ${occurrence} ${marker}`, () => {
      const source = read(path);
      let position = -1;
      for (let index = 0; index <= occurrence; index++)
        position = source.indexOf(marker, position + 1);
      assert.ok(position >= 0);
      const changed =
        source.slice(0, position) +
        'removed_reviewed_writer_guard' +
        source.slice(position + marker.length);
      assert.throws(
        () =>
          assertLegacyDispositionSource('a'.repeat(40), (name) =>
            name === path ? changed : read(name),
          ),
        /lacks permanent/u,
      );
    });

test('existing terminal proof readers cannot substitute for the shared claim writer protocol', () => {
  assert.throws(
    () =>
      assertLegacyDispositionSource('a'.repeat(40), (path) =>
        path === 'apps/api/src/webhook/webhook-semantic-claim-fence.ts' ? '' : read(path),
      ),
    /lacks permanent.*webhook-semantic-claim-fence/u,
  );
});

test('rollback refuses receipt admission committed before a separate Publisher journal transaction', () => {
  refusesChangedSource(
    producerPath,
    cancellationMethod((method) => {
      const opening = 'await this.prisma.$transaction(async (tx) => {';
      const receipt = 'const receiptId = sourceWebhookEventId?.trim();';
      const guard =
        'if (receiptId && !(await lockWebhookClaimReceiptAdmission(tx, receiptId))) return;';
      return method
        .replace(receipt, '')
        .replace(guard, '')
        .replace(opening, `${opening}\n      ${receipt}\n      ${guard}\n    });\n    ${opening}`);
    }),
  );
});

test('rollback refuses a Publisher journal update after its receipt transaction commits', () => {
  refusesChangedSource(
    producerPath,
    cancellationMethod((method) => {
      const journal = journalStatement(method);
      return method.replace(journal, '').replace('\n    });', `\n    });\n    ${journal}`);
    }),
  );
});

test('rollback refuses a Publisher journal update before receipt admission', () => {
  refusesChangedSource(
    producerPath,
    cancellationMethod((method) => {
      const guard =
        'if (receiptId && !(await lockWebhookClaimReceiptAdmission(tx, receiptId))) return;';
      const journal = journalStatement(method);
      return method.replace(guard, '').replace(journal, `${journal}\n      ${guard}`);
    }),
  );
});

test('rollback refuses the outer Prisma client for a guarded Publisher journal update', () => {
  refusesChangedSource(
    producerPath,
    cancellationMethod((method) =>
      method.replace(
        'await tx.publisherAutoReplyDelivery.updateMany(',
        'await this.prisma.publisherAutoReplyDelivery.updateMany(',
      ),
    ),
  );
});

for (const boundary of ['fence', 'claims'])
  test(`rollback refuses a missing Publisher source alias in the removal ${boundary}`, () => {
    const source = read(removalPath);
    const start = source.indexOf(
      boundary === 'fence'
        ? 'await tryLockWebhookSemanticClaimFences(tx, ['
        : 'for (const key of new Set(',
    );
    const end = source.indexOf(']))', start);
    assert.ok(start >= 0 && end > start);
    refusesChangedSource(
      removalPath,
      source.slice(0, start) +
        source.slice(start, end).replace('publisherSourceKey', 'canonical') +
        source.slice(end),
    );
  });

test('rollback refuses an ignored historical Publisher journal after the removal fence', () => {
  const source = read(removalPath);
  const journal = source.indexOf('await tx.publisherAutoReplyDelivery.findUnique(');
  const refusal = source.indexOf('return null;', journal);
  assert.ok(journal >= 0 && refusal > journal);
  refusesChangedSource(
    removalPath,
    source.slice(0, refusal) + source.slice(refusal).replace('return null;', 'void 0;'),
  );
});

test('both rollback mechanisms require the hold floor before their release transition', () => {
  for (const path of [
    'infra/scripts/vps-release-rollback.sh',
    'infra/scripts/vps-runtime-rollback.sh',
  ]) {
    const source = read(path);
    const floor = source.indexOf('maxim_topology_require_legacy_dispositions');
    assert.ok(floor >= 0);
    const transition = Math.max(
      source.lastIndexOf('\nbegin_release_runtime_transition\n'),
      source.lastIndexOf('\nbegin_runtime_rollback_transition\n'),
    );
    assert.ok(transition > floor, `${path} must verify its floor before mutating runtime`);
  }
});
test('legacy activation is refused before normal deploy mutations', () => {
  const source = read('infra/scripts/vps-pull-build-up.sh');
  const refusal = source.indexOf('cold_activation_disabled');
  const admission = /^\s*(?:if\s+)?acquire_deploy_lock(?:;|\s|$)/mu.exec(source);
  assert.ok(admission, 'normal deploy must acquire its protected lock');
  assert.ok(refusal > 0 && refusal < admission.index);
  assert.match(source, /--legacy-order-preview=\*/u);
  assert.match(source, /--legacy-order-apply=\*/u);
  assert.doesNotMatch(source, /node infra\/scripts\/multibot-legacy-cold-recovery\.mjs/u);
});
