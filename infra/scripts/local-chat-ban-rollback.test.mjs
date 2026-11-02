import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import {
  assertLocalChatBanSource,
  LOCAL_CHAT_BAN_SOURCE_CHECKS,
} from './assert-local-chat-ban-source.mjs';

const read = (path) => readFileSync(resolve(import.meta.dirname, '../..', path), 'utf8');
const failure = /lacks local chat ban readers/u;
const revision = 'a'.repeat(40);

test('local chat ban rollback retains enforcement, local release and earlier recovery floors', () => {
  assert.doesNotThrow(() => assertLocalChatBanSource(revision, read));
  assert.throws(
    () => assertLocalChatBanSource('main', () => assert.fail('must not read a mutable ref')),
    /Exact source SHA required/u,
  );
});

test('missing, comment-only and oversized candidate readers fail closed', () => {
  for (const [path] of LOCAL_CHAT_BAN_SOURCE_CHECKS) {
    for (const replacement of [
      '',
      `/* ${read(path).replaceAll('*/', '* /')} */`,
      'x'.repeat(1024 * 1024 + 1),
    ]) {
      assert.throws(
        () =>
          assertLocalChatBanSource(revision, (name) => (name === path ? replacement : read(name))),
        failure,
        path,
      );
    }
  }
  assert.throws(
    () =>
      assertLocalChatBanSource(revision, () => {
        throw new Error('missing source');
      }),
    failure,
  );
});

test('the reader version cannot substitute for the sanction reader or dispatch guard', () => {
  const path = 'apps/api/src/moderation/local-chat-ban.ts';
  for (const marker of [
    'export async function readActiveLocalChatBan(',
    'export async function enforceLocalChatBan(',
    'beforeImmediateMemberMutation:',
    'withMaxFinalAuthorityCheckpoint(',
  ]) {
    assert.ok(read(path).includes(marker));
    assert.throws(
      () =>
        assertLocalChatBanSource(revision, (name) =>
          name === path ? read(name).replaceAll(marker, 'removed_reader') : read(name),
        ),
      failure,
      marker,
    );
  }
});

test('local UNBAN must be selected before the native or experimental restore path', () => {
  const path = 'apps/api/src/admin/admin.service.legacy.ts';
  const source = read(path);
  const call = "return applyLocalBan('UNBAN')";
  const native = 'await attemptManualMemberUnban(';
  const localAt = source.indexOf(call);
  const nativeAt = source.indexOf(native);
  assert.ok(localAt >= 0 && nativeAt > localAt);
  const reordered = `${source.slice(0, localAt)}${source.slice(localAt).replace(call, "return omittedLocalRelease('UNBAN')")}\n${call}`;
  assert.throws(
    () => assertLocalChatBanSource(revision, (name) => (name === path ? reordered : read(name))),
    /local release order/u,
  );
});

test('fenced or concurrently replaced local bans cannot fall through to native UNBAN', () => {
  for (const [path, marker] of [
    [
      'apps/api/src/admin/former-participant-moderation.ts',
      'if (active?.id !== latest.id) throw new ModerationSanctionStateChangedError()',
    ],
    [
      'apps/api/src/admin/admin.service.legacy.ts',
      'options.expectedSanctionEventId ?? localUnban.id',
    ],
  ]) {
    assert.ok(read(path).includes(marker));
    assert.throws(
      () =>
        assertLocalChatBanSource(revision, (name) =>
          name === path ? read(name).replaceAll(marker, 'removed_release_fence') : read(name),
        ),
      failure,
      marker,
    );
  }
});

test('join-only wiring is insufficient when the membership event was missed', () => {
  const path = 'apps/api/src/moderation/moderation.service.legacy.ts';
  const source = read(path);
  const call = 'this.enforceLocalChatBanForUpdate(';
  const first = source.indexOf(call);
  assert.ok(first >= 0 && source.indexOf(call, first + call.length) > first);
  const oneHook =
    source.slice(0, first + call.length) +
    source.slice(first + call.length).replaceAll(call, 'this.omittedLocalBanHook(');
  assert.throws(
    () => assertLocalChatBanSource(revision, (name) => (name === path ? oneHook : read(name))),
    /join\/message enforcement/u,
  );
});

test('API wrappers require the new rollback capability while static-only rollback stays offline', () => {
  const source = read('infra/scripts/vps-connect.sh');
  const runtime = source.slice(
    source.indexOf('rollback_runtime() {'),
    source.indexOf('rollback_release() {'),
  );
  const release = source.slice(
    source.indexOf('rollback_release() {'),
    source.indexOf('\nhealth() {'),
  );
  assert.match(runtime, /maxim_topology_require_local_chat_ban_reader/u);
  assert.match(release, /local capability_marker=select_release_recovery_base/u);
  assert.match(release, /if \[\[ "\$rollback_component" == api-shared \]\]/u);
  assert.equal(
    (release.match(/capability_marker=maxim_topology_require_local_chat_ban_reader/gu) ?? [])
      .length,
    2,
  );
});
