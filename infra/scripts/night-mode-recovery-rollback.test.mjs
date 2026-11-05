import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import {
  assertNightModeRecoverySource,
  NIGHT_MODE_RECOVERY_SOURCE_CHECKS,
} from './assert-night-mode-recovery-source.mjs';

const read = (path) => readFileSync(resolve(import.meta.dirname, '../..', path), 'utf8');

test('night-mode rollback accepts the durable independent recovery reader', () => {
  assert.doesNotThrow(() => assertNightModeRecoverySource('a'.repeat(40), read));
});

test('night-mode rollback refuses the Stage 1 reader before calendar interpretation support', () => {
  assert.throws(
    () =>
      assertNightModeRecoverySource('a'.repeat(40), (path) =>
        read(path).replace(
          'NIGHT_MODE_INDEPENDENT_RECOVERY_READER_VERSION = 2',
          'NIGHT_MODE_INDEPENDENT_RECOVERY_READER_VERSION = 1',
        ),
      ),
    /lacks independent night-mode recovery readers/u,
  );
});

test('night-mode rollback refuses old DELETE readers despite retained transition recovery', () => {
  assert.throws(
    () =>
      assertNightModeRecoverySource('a'.repeat(40), (path) =>
        path === 'apps/api/src/moderation/moderation-delete-intent.service.ts'
          ? read(path).replaceAll(
              'await this.assertNightModeOpenNoticeCleanupStillAuthorized(intent);',
              '',
            )
          : read(path),
      ),
    /lacks independent night-mode recovery readers/u,
  );
});

test('opening cleanup retains both its initial and final pre-dispatch policy checkpoints', () => {
  const path = 'apps/api/src/moderation/moderation-delete-intent.service.ts';
  const source = read(path);
  const checkpoint = 'await this.assertNightModeOpenNoticeCleanupStillAuthorized(intent);';
  const dispatchStart = source.indexOf('private async runDeletePreDispatchGuards(');
  assert.ok(dispatchStart > 0);
  const weakened =
    source.slice(0, dispatchStart) + source.slice(dispatchStart).replace(checkpoint, '');
  assert.notEqual(weakened, source);
  assert.throws(
    () =>
      assertNightModeRecoverySource('a'.repeat(40), (name) =>
        name === path ? weakened : read(name),
      ),
    /final cleanup checkpoints/u,
  );
});

test('missing or comment-only opening policy readers cannot satisfy the rollback floor', () => {
  const path = 'apps/api/src/moderation/night-mode-open-notice-cleanup-guard.service.ts';
  const source = read(path);
  assert.throws(
    () =>
      assertNightModeRecoverySource('a'.repeat(40), (name) =>
        name === path ? `/* ${source} */` : read(name),
      ),
    /lacks independent night-mode recovery readers/u,
  );
  assert.throws(
    () =>
      assertNightModeRecoverySource('a'.repeat(40), (name) => {
        if (name === path) throw new Error('missing');
        return read(name);
      }),
    /lacks independent night-mode recovery readers/u,
  );
});

test('opening cleanup reader promotion must affect the actual API bootstrap command', () => {
  const path = 'infra/scripts/vps-connect.sh';
  const source = read(path);
  const promotion = `  if [[ "$capability_marker" == maxim_topology_require_local_chat_ban_reader ]]; then
    capability_marker=maxim_topology_require_night_open_notice_cleanup_reader
  fi`;
  assert.ok(source.includes(promotion));
  const late = source
    .replace(promotion, '')
    .replace('\ncommercial_ocr_promote() {', `\n${promotion}\ncommercial_ocr_promote() {`);
  assert.throws(
    () =>
      assertNightModeRecoverySource('a'.repeat(40), (name) => (name === path ? late : read(name))),
    /API bootstrap promotion/u,
  );
});

for (const [path, markers] of NIGHT_MODE_RECOVERY_SOURCE_CHECKS) {
  for (const marker of markers) {
    test(`night-mode rollback rejects missing capability ${path}: ${marker}`, () => {
      assert.throws(
        () =>
          assertNightModeRecoverySource('a'.repeat(40), (name) =>
            name === path ? read(name).replaceAll(marker, 'removed_reader') : read(name),
          ),
        /lacks independent night-mode recovery readers/u,
      );
    });
  }
}

test('night-mode source gate refuses a non-exact revision before reading it', () => {
  assert.throws(
    () => assertNightModeRecoverySource('main', () => assert.fail('must not read')),
    /Exact source SHA required/u,
  );
});

test('both API rollback paths check recovery before beginning a runtime transition', () => {
  for (const path of [
    'infra/scripts/vps-runtime-rollback.sh',
    'infra/scripts/vps-release-rollback.sh',
  ]) {
    const source = read(path);
    const gate = source.indexOf('maxim_topology_require_statistics_and_night_mode_recovery');
    const transition = Math.max(
      source.lastIndexOf('\nbegin_release_runtime_transition\n'),
      source.lastIndexOf('\nbegin_runtime_rollback_transition\n'),
    );
    assert.ok(gate >= 0 && transition > gate, path);
    assert.ok(source.includes('maxim_topology_require_commercial_ai_pool_delete_reader'), path);
    assert.ok(source.includes('maxim_topology_require_exact_statistics_rollup_reader'), path);
    const openingCleanupGate = source.indexOf(
      'maxim_topology_require_night_open_notice_cleanup_reader',
    );
    assert.ok(openingCleanupGate >= 0 && openingCleanupGate < transition, path);
  }
});
