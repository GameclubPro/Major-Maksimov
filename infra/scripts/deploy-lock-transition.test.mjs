import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { deployLockEnvironment } from './test-fixtures/deploy-lock.mjs';
import { pairReleaseFixture } from './test-fixtures/pair-release.mjs';

const lockMarker = 'export MAXIM_DEPLOY_LOCK_VERSION=flock-v1';
const lockTrailer = `#${'x'.repeat(126)}\n`.repeat(8192);

function fixture(
  t,
  { largeLockSource = false, missingLockMarker = false, failLockSourceRead = false } = {},
) {
  const root = mkdtempSync(join(tmpdir(), 'maxim-lock-transition-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = join(root, 'repo');
  const remote = join(root, 'origin.git');
  const protectedDir = join(root, 'protected');
  const legacy = join(root, 'legacy');
  mkdirSync(repo);
  mkdirSync(protectedDir, { mode: 0o700 });
  const env = deployLockEnvironment({
    GIT_AUTHOR_NAME: 'Fixture',
    GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
    GIT_COMMITTER_NAME: 'Fixture',
    GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
  });
  const git = (...args) =>
    execFileSync('git', args, {
      cwd: repo,
      env,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  git('init', '-b', 'main');
  mkdirSync(join(repo, 'infra/scripts/lib'), { recursive: true });
  writeFileSync(join(repo, 'infra/scripts/lib/deploy-lock.sh'), '# legacy\n');
  git('add', '.');
  git('commit', '-m', 'old');
  const old = git('rev-parse', 'HEAD');
  let pair;
  const relocate = (text) =>
    text
      .replaceAll('/var/lib/maxim-deploy', protectedDir)
      .replaceAll(
        '/var/lib/major-karavan-release',
        pair?.protectedDirectory ?? '/var/lib/major-karavan-release',
      )
      .replaceAll('/tmp/maxim-main-deploy.lock', legacy);
  let lockSource = relocate(readFileSync(new URL('./lib/deploy-lock.sh', import.meta.url), 'utf8'));
  assert.ok(lockSource.includes(lockMarker), 'fixture must retain the reviewed lock marker');
  if (missingLockMarker) {
    lockSource = lockSource.replaceAll(lockMarker, 'export MAXIM_DEPLOY_LOCK_VERSION=missing');
  }
  // FLAG: A valid committed shell trailer exceeds the pipe capacity after the marker.
  // A successful marker match must not terminate this real Git source read early.
  if (largeLockSource) lockSource += lockTrailer;
  writeFileSync(join(repo, 'infra/scripts/lib/deploy-lock.sh'), lockSource);
  pair = pairReleaseFixture(root, join(repo, 'infra/scripts/lib/pair-release-admission.sh'));
  writeFileSync(join(repo, 'infra/scripts/legacy-cold-journal.mjs'), '// reviewed fixture\n');
  git('add', '.');
  git('commit', '-m', 'new');
  const target = git('rev-parse', 'HEAD');
  git('init', '--bare', remote);
  git('remote', 'add', 'origin', remote);
  git('push', 'origin', 'main');
  git('checkout', '-B', 'main', old);
  if (failLockSourceRead) {
    const bin = join(root, 'bin');
    mkdirSync(bin);
    env.MAXIM_TEST_REAL_GIT = execFileSync('bash', ['-c', 'command -v git'], {
      env,
      encoding: 'utf8',
    }).trim();
    env.MAXIM_TEST_LOCK_SOURCE_REVISION = `${target}:infra/scripts/lib/deploy-lock.sh`;
    // FLAG: Only the exact candidate read fails after real Git emits its complete
    // stream. Every other Git operation and both lock protocols remain real.
    writeFileSync(
      join(bin, 'git'),
      `#!/usr/bin/env bash
set -euo pipefail
if [[ "\${1:-}" == show && "\${2:-}" == "$MAXIM_TEST_LOCK_SOURCE_REVISION" ]]; then
  "$MAXIM_TEST_REAL_GIT" "$@"
  exit 73
fi
exec "$MAXIM_TEST_REAL_GIT" "$@"
`,
      { mode: 0o755 },
    );
    env.PATH = `${bin}:${env.PATH}`;
  }
  // Only process discovery is removed from this isolated protocol test; real Git,
  // inode validation, both locks and exact owned cleanup execute unchanged.
  let script = relocate(
    readFileSync(new URL('./vps-install-deploy-flock.sh', import.meta.url), 'utf8'),
  );
  script = script.replace(
    /assert_no_legacy_actors\(\) \{[\s\S]*?\n\}\nassert_no_legacy_actors/u,
    'assert_no_legacy_actors() { :; }\nassert_no_legacy_actors',
  );
  const run = () =>
    spawnSync('bash', ['-s', '--', old, target], {
      cwd: repo,
      env,
      input: script,
      encoding: 'utf8',
      timeout: 15000,
    });
  return {
    repo,
    legacy,
    protectedDir,
    admission: pair.protectedDirectory,
    old,
    target,
    run,
    git,
    env,
  };
}

test('one-time transition advances exact source under both locks and retains the protected inode', (t) => {
  const h = fixture(t);
  const result = h.run();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(h.git('rev-parse', 'HEAD'), h.target);
  assert.equal(existsSync(h.legacy), false);
  const lock = join(h.protectedDir, 'deploy.lock');
  assert.equal(existsSync(lock), true);
  const probe = spawnSync(
    'bash',
    ['-c', 'source infra/scripts/lib/deploy-lock.sh; acquire_deploy_lock; require_deploy_lock'],
    { cwd: h.repo, env: h.env, encoding: 'utf8' },
  );
  assert.equal(probe.status, 0, probe.stderr);
});

test('one-time transition reads the complete large committed source before advancing', (t) => {
  const h = fixture(t, { largeLockSource: true });
  assert.ok(
    Number(h.git('cat-file', '-s', `${h.target}:infra/scripts/lib/deploy-lock.sh`)) > 1048576,
  );
  const result = h.run();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(h.git('rev-parse', 'HEAD'), h.target);
  assert.equal(existsSync(h.legacy), false);
  assert.equal(existsSync(join(h.protectedDir, 'deploy.lock')), true);
});

test('missing lock marker refuses a large candidate without advancing source', (t) => {
  const h = fixture(t, { largeLockSource: true, missingLockMarker: true });
  const result = h.run();
  assert.equal(result.status, 1, result.stderr);
  assert.equal(h.git('rev-parse', 'HEAD'), h.old);
  assert.equal(existsSync(h.legacy), false);
});

test('a Git failure after the complete matching source still refuses the transition', (t) => {
  const h = fixture(t, { largeLockSource: true, failLockSourceRead: true });
  const result = h.run();
  assert.equal(result.status, 73, result.stderr);
  assert.equal(h.git('rev-parse', 'HEAD'), h.old);
  assert.equal(existsSync(h.legacy), false);
});

test('foreign legacy lock is preserved without changing source or provisioning new authority', (t) => {
  const h = fixture(t);
  mkdirSync(h.legacy);
  writeFileSync(join(h.legacy, 'pid'), 'foreign\n');
  assert.notEqual(h.run().status, 0);
  assert.equal(h.git('rev-parse', 'HEAD'), h.old);
  assert.equal(readFileSync(join(h.legacy, 'pid'), 'utf8'), 'foreign\n');
  assert.equal(existsSync(join(h.protectedDir, 'deploy.lock')), false);
});

test('dirty source refuses before any lock ownership', (t) => {
  const h = fixture(t);
  writeFileSync(join(h.repo, 'infra/scripts/lib/deploy-lock.sh'), '# unrelated work\n');
  assert.notEqual(h.run().status, 0);
  assert.equal(h.git('rev-parse', 'HEAD'), h.old);
  assert.equal(existsSync(h.legacy), false);
});

test('pair-aware target without installed common admission refuses before source advance', (t) => {
  const h = fixture(t);
  rmSync(h.admission, { recursive: true });
  const result = h.run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /guarded install-pair-release-admission bootstrap/u);
  assert.equal(h.git('rev-parse', 'HEAD'), h.old);
  assert.equal(existsSync(h.legacy), false);
});
