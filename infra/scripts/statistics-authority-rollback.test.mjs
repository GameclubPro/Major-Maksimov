import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import {
  assertStatisticsAuthoritySource,
  STATISTICS_AUTHORITY_SOURCE_CHECKS,
} from './assert-statistics-authority-source.mjs';

const root = resolve(import.meta.dirname, '../..');
const read = (path) => readFileSync(resolve(root, path), 'utf8');
const marker = 'maxim_topology_require_statistics_authority_lifecycle';
const rollbackMarker = 'maxim_topology_require_statistics_and_night_mode_recovery';
const failure = /lacks statistics authority lifecycle v2 readers\/writers/u;

test('compatible lifecycle source retains the permanent writer and both reader fences', () => {
  assert.doesNotThrow(() => assertStatisticsAuthoritySource('a'.repeat(40), read));
  assert.throws(() => assertStatisticsAuthoritySource('main', read), /Exact source SHA required/u);
});

test('the installed pre-local-ban lifecycle checker accepts the promoted API selector', async () => {
  const current = read('infra/scripts/assert-statistics-authority-source.mjs');
  const selector = "['capability_marker=maxim_topology_require_local_chat_ban_reader']";
  assert.equal(current.split(selector).length, 2);
  // The installed checker differs only in this required connector fragment.
  const installed = current.replace(
    selector,
    "['capability_marker=maxim_topology_require_statistics_and_night_mode_recovery']",
  );
  const { assertStatisticsAuthoritySource: installedCheck } = await import(
    `data:text/javascript;base64,${Buffer.from(installed).toString('base64')}`
  );
  assert.doesNotThrow(() => installedCheck('a'.repeat(40), read));
  assert.throws(
    () =>
      installedCheck('a'.repeat(40), (path) =>
        path === 'infra/scripts/vps-connect.sh'
          ? read(path).replaceAll(
              'capability_marker=maxim_topology_require_statistics_and_night_mode_recovery',
              'capability_marker=removed',
            )
          : read(path),
      ),
    failure,
  );
});

test('a migration or version marker cannot substitute for the terminal writer, exact predecessor or reader fences', () => {
  const path = 'apps/api/src/statistics/stats-access.service.ts';
  const source = read(path);
  for (const [before, after] of [
    ['!r.superseded_by && ', ''],
    ["if (old?.superseded_by) return reply('SUPERSEDED', old);", ''],
    ["head.state !== 'REVOKED'", "head.state !== 'ACTIVE'"],
    ['op.supersedes?.id !== head.id', 'false'],
    ['op.supersedes.revision !== head.revision.toString()', 'false'],
    ['op.supersedes.epoch !== head.epoch.toString()', 'false'],
    ['predecessor.superseded_by !== old.id', 'false'],
    ['AND a.superseded_by IS NULL', ''],
    ['!active(r)', 'false'],
    ['!active(c)', 'false'],
  ]) {
    assert.ok(source.includes(before), `Missing fixture mutation: ${before}`);
    assert.throws(
      () =>
        assertStatisticsAuthoritySource('a'.repeat(40), (candidate) =>
          candidate === path ? source.replaceAll(before, after) : read(candidate),
        ),
      failure,
      before,
    );
  }
});

test('missing or comment-only schema, API and tooling support fails closed', () => {
  for (const [path] of STATISTICS_AUTHORITY_SOURCE_CHECKS) {
    for (const replacement of [
      '',
      `/* ${read(path).replaceAll('*/', '* /')} */`,
      'x'.repeat(1024 * 1024 + 1),
    ])
      assert.throws(
        () =>
          assertStatisticsAuthoritySource('a'.repeat(40), (candidate) =>
            candidate === path ? replacement : read(candidate),
          ),
        failure,
        path,
      );
  }
});

test('the combined recovery capability cannot omit either source check or its fail-fast boundary', () => {
  const path = 'infra/scripts/lib/deploy-topology.sh';
  const source = read(path);
  for (const call of [
    'maxim_topology_require_statistics_authority_lifecycle "$commit_sha" || return $?',
    'maxim_topology_require_night_mode_recovery_reader "$commit_sha" || return $?',
  ]) {
    assert.ok(source.includes(call));
    for (const replacement of ['', call.replace(' || return $?', '')]) {
      assert.throws(
        () =>
          assertStatisticsAuthoritySource('a'.repeat(40), (candidate) =>
            candidate === path ? source.replace(call, replacement) : read(candidate),
          ),
        failure,
      );
    }
  }
});

test('database tombstones and partial uniqueness remain mandatory in a retained candidate', () => {
  for (const [path, before] of [
    [
      '20261029193000_statistics_authority_successors',
      'IF OLD.superseded_by IS NOT NULL AND NEW IS DISTINCT FROM OLD THEN',
    ],
    [
      '20261029193000_statistics_authority_successors',
      'FOR EACH ROW EXECUTE FUNCTION protect_statistics_authority_successor()',
    ],
    ['20261029193100_index_statistics_authority_heads', 'WHERE superseded_by IS NULL'],
    [
      '20261029193200_enable_statistics_authority_successors',
      'ALTER TABLE stats_authorities DROP CONSTRAINT stats_authorities_scope_key',
    ],
  ]) {
    const target = `apps/api/prisma/migrations/${path}/migration.sql`;
    const source = read(target);
    assert.ok(source.includes(before));
    assert.throws(
      () =>
        assertStatisticsAuthoritySource('a'.repeat(40), (candidate) =>
          candidate === target ? source.replace(before, 'removed_fence') : read(candidate),
        ),
      failure,
    );
  }
});

test('the CLI checks an immutable commit rather than a newer dirty worktree and rejects before runtime calls', (t) => {
  const repository = mkdtempSync(join(tmpdir(), 'statistics-authority-floor-'));
  t.after(() => rmSync(repository, { recursive: true, force: true }));
  const git = (...args) => {
    const result = spawnSync('git', ['-C', repository, ...args], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git('init', '-q');
  for (const [path] of STATISTICS_AUTHORITY_SOURCE_CHECKS) {
    mkdirSync(dirname(join(repository, path)), { recursive: true });
    writeFileSync(join(repository, path), read(path));
  }
  const contract = 'packages/contracts/src/statistics-central.ts';
  writeFileSync(
    join(repository, contract),
    read(contract).replace(
      'STATISTICS_AUTHORITY_LIFECYCLE_VERSION = 2',
      'STATISTICS_AUTHORITY_LIFECYCLE_VERSION = 1',
    ),
  );
  git('add', '.');
  git(
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    'commit',
    '-qm',
    'old writer',
  );
  const stale = git('rev-parse', 'HEAD');
  writeFileSync(join(repository, contract), read(contract));
  const run = (sha) =>
    spawnSync(
      'bash',
      [
        '-c',
        'set -euo pipefail; source "$1"; maxim_topology_require_statistics_authority_lifecycle "$2"; printf "RUNTIME_ALLOWED\\n"',
        'floor-fixture',
        resolve(root, 'infra/scripts/lib/deploy-topology.sh'),
        sha,
      ],
      { cwd: repository, encoding: 'utf8' },
    );
  const refused = run(stale);
  assert.equal(refused.status, 1, refused.stderr);
  assert.match(refused.stderr, failure);
  assert.doesNotMatch(refused.stdout, /RUNTIME_ALLOWED/u);
  git('add', contract);
  git(
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    'commit',
    '-qm',
    'compatible writer',
  );
  const accepted = run(git('rev-parse', 'HEAD'));
  assert.equal(accepted.status, 0, accepted.stderr);
  assert.equal(accepted.stdout, 'RUNTIME_ALLOWED\n');
});

test('both API rollback paths enforce the authority lifecycle floor before any runtime mutation', () => {
  for (const [file, target, mutation] of [
    ['vps-runtime-rollback.sh', 'TARGET_FULL_SHA', '\ngit switch --detach "$TARGET_FULL_SHA"'],
    ['vps-release-rollback.sh', 'API_SOURCE_SHA', '\nbegin_release_runtime_transition\n'],
  ]) {
    const source = read(`infra/scripts/${file}`);
    const call = `${rollbackMarker} "$${target}"`;
    const position = source.indexOf(call);
    assert.ok(position >= 0, `${file} must verify the exact API source`);
    assert.equal(source.indexOf(call, position + call.length), -1);
    assert.ok(position < source.indexOf(mutation), `${file} must reject before ${mutation}`);
  }
});

test('normal API deploy verifies lifecycle compatibility before accepting the image or applying migrations', () => {
  const source = read('infra/scripts/vps-pull-build-up.sh');
  const call = `${marker} "$TARGET_SHA"`;
  const position = source.indexOf(call);
  assert.ok(position > source.indexOf('TARGET_SHA="$(git rev-parse HEAD)"'));
  const imageAdmission = source.indexOf('\n  require_preloaded_target_image "$MAXIM_API_IMAGE"');
  const runtimeTransition = source.indexOf('\n  begin_release_runtime_transition', imageAdmission);
  assert.ok(imageAdmission > position && runtimeTransition > imageAdmission);
  assert.doesNotMatch(source, /maxim_topology_build_shared_api_image|docker compose[^\n]* build/u);
  assert.ok(position < source.indexOf('\n  if ! run_migrations; then'));
  const before = source.lastIndexOf('if [[ "$BUILD_API_IMAGE" -eq 1 ]]; then', position);
  const end = source.indexOf('\nfi\n', position);
  assert.ok(before >= 0 && end > position);
  const result = spawnSync(
    'bash',
    ['-c', `set -euo pipefail\nBUILD_API_IMAGE=0\n${source.slice(before, end + 4)}`],
    { encoding: 'utf8' },
  );
  assert.equal(result.status, 0, 'Static-only deploy must not execute API compatibility checks');
});

test('branch synchronization rejects incompatible remote and local tooling before checkout or re-exec', () => {
  const source = read('infra/scripts/vps-pull-build-up.sh');
  const start = source.indexOf('sync_branch() {');
  const end = source.indexOf('\n}\n', start);
  assert.ok(start >= 0 && end > start);
  const sync = source.slice(start, end + 2);
  for (const refused of ['origin/main', 'refs/heads/main']) {
    const result = spawnSync(
      'bash',
      [
        '-c',
        `set -euo pipefail
BRANCH=main
git() {
  case "$1" in
    rev-parse) printf '%s' "\${*: -1}" ;;
    fetch|show-ref) return 0 ;;
    *) printf 'UNSAFE: %s\\n' "$*" >&2; return 91 ;;
  esac
}
require_market_statistics_lock_dispatch() { :; }
require_major_market_release_dispatch() {
  [[ "$#" == 1 && ( "$1" == origin/main || "$1" == refs/heads/main ) ]] || return 92
  printf 'major-market-source-checked:%s\\n' "$1"
}
require_pair_release_admission_dispatch() {
  [[ "$#" == 1 && ( "$1" == origin/main || "$1" == refs/heads/main ) ]] || return 93
  printf 'pair-admission-source-checked:%s\\n' "$1"
}
maxim_topology_require_eraser_bridge() { :; }
maxim_topology_require_eraser_rate_limit_reader() { :; }
${marker}() {
  printf 'lifecycle-source-checked:%s\\n' "$1"
  [[ "$1" != "$REFUSED_REF" ]]
}
${sync}
sync_branch
`,
      ],
      { encoding: 'utf8', env: { PATH: process.env.PATH, REFUSED_REF: refused } },
    );
    assert.equal(result.status, 2, result.stderr);
    const checkedRefs = refused === 'origin/main' ? ['origin/main'] : ['origin/main', refused];
    assert.deepEqual(
      result.stdout.trimEnd().split('\n'),
      checkedRefs.flatMap((ref) => [
        `major-market-source-checked:${ref}`,
        `pair-admission-source-checked:${ref}`,
        `lifecycle-source-checked:${ref}`,
      ]),
    );
    assert.doesNotMatch(result.stderr, /UNSAFE|command not found/u);
  }
});
