import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { assertReleaseSourceFloor } from './release-service-source-floor.mjs';

const paths = [
  'infra/scripts/lib/deploy-lock.sh',
  'infra/scripts/vps-release-rollback.sh',
  'infra/scripts/vps-runtime-rollback.sh',
  'infra/scripts/vps-connect.sh',
];

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'maxim-release-source-floor-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const repository = join(directory, 'repository');
  mkdirSync(repository);
  const trusted = join(directory, 'trusted');
  const configuration = join(trusted, 'configuration');
  const helpers = join(trusted, 'helpers');
  for (const path of [trusted, configuration, helpers]) mkdirSync(path, { mode: 0o755 });
  const markerPath = join(configuration, 'installed');
  const helperPath = join(helpers, 'release-service-source-floor.mjs');
  writeFileSync(helperPath, '// Trusted fixture helper.\n', { mode: 0o644 });
  const git = (...arguments_) => {
    const result = spawnSync(
      '/usr/bin/git',
      [
        '-c',
        'core.hooksPath=/dev/null',
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=fixture@example.invalid',
        ...arguments_,
      ],
      {
        cwd: repository,
        env: {
          PATH: '/usr/bin:/bin',
          HOME: directory,
          LANG: 'C.UTF-8',
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_CONFIG_GLOBAL: '/dev/null',
        },
        encoding: 'utf8',
        timeout: 10000,
      },
    );
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git('init', '-q', '--initial-branch=main');
  writeFileSync(join(repository, 'README.md'), 'Before the service floor.\n');
  git('add', '.');
  git('commit', '-qm', 'old source');
  const oldSha = git('rev-parse', 'HEAD');
  for (const path of paths) {
    mkdirSync(dirname(join(repository, path)), { recursive: true });
    writeFileSync(join(repository, path), readFileSync(new URL(`../../${path}`, import.meta.url)));
  }
  git('add', '.');
  git('commit', '-qm', 'installed source floor');
  const installedSha = git('rev-parse', 'HEAD');
  writeFileSync(markerPath, `${installedSha}\n`, { mode: 0o644 });
  const settings = {
    cwd: repository,
    repositoryRoot: repository,
    markerPath,
    helperPath,
    trustedDirectories: [trusted, configuration, helpers],
    expectedUid: process.getuid(),
  };
  const commit = (message = 'candidate') => {
    git('add', '.');
    git('commit', '-qm', message, '--allow-empty');
    return git('rev-parse', 'HEAD');
  };
  const change = (path, transform) => {
    const destination = join(repository, path);
    writeFileSync(destination, transform(readFileSync(destination, 'utf8')));
    return commit();
  };
  return {
    directory,
    repository,
    trusted,
    configuration,
    helpers,
    markerPath,
    helperPath,
    git,
    commit,
    change,
    settings,
    oldSha,
    installedSha,
    check: (candidateSha) => assertReleaseSourceFloor({ ...settings, candidateSha }),
  };
}

function assertCode(callback, code) {
  assert.throws(callback, (error) => error.code === code, code);
}

test('an absent installation marker preserves existing dispatch without requiring Git or new helpers', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'maxim-no-release-floor-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  assert.deepEqual(
    assertReleaseSourceFloor({
      markerPath: join(directory, 'absent'),
      cwd: '/does-not-exist',
      candidateSha: 'main',
    }),
    { installed: false },
  );
});

test('installed source and descendants retain protected hooks without executing candidate code', (t) => {
  const data = fixture(t);
  assert.deepEqual(data.check(data.installedSha), {
    installed: true,
    installedSha: data.installedSha,
    candidateSha: data.installedSha,
  });
  const sentinel = join(data.directory, 'candidate-executed');
  for (const path of paths) {
    const destination = join(data.repository, path);
    writeFileSync(
      destination,
      `${readFileSync(destination, 'utf8')}\nprintf forbidden > '${sentinel}'\n`,
    );
  }
  const descendant = data.commit('unrelated commands after protected boundary');
  assert.equal(data.check(descendant).candidateSha, descendant);
  assert.equal(existsSync(sentinel), false);
});

test('old source and a cousin branch cannot erase the installed floor', (t) => {
  const data = fixture(t);
  assertCode(() => data.check(data.oldSha), 'SOURCE_DOWNGRADE');
  data.git('checkout', '-q', '--detach', data.oldSha);
  writeFileSync(join(data.repository, 'README.md'), 'Unrelated branch.\n');
  const cousin = data.commit('cousin');
  assertCode(() => data.check(cousin), 'SOURCE_DOWNGRADE');
});

test('working tree modifications do not replace the committed Git proof', (t) => {
  const data = fixture(t);
  writeFileSync(join(data.repository, paths[0]), 'exit 0\n');
  assert.equal(data.check(data.installedSha).installed, true);
  assert.equal(readFileSync(join(data.repository, paths[0]), 'utf8'), 'exit 0\n');
});

for (const path of paths) {
  test(`protected prefix changes fail closed in ${path}`, (t) => {
    const data = fixture(t);
    const candidate = data.change(path, (source) =>
      source.replace('#!/usr/bin/env bash\n', '#!/usr/bin/env bash\nexit 0\n'),
    );
    assertCode(() => data.check(candidate), 'PROTECTED_PREFIX_CHANGED');
  });
}

test('commented dispatch, altered scope and duplicate dispatch definitions cannot satisfy retention', (t) => {
  const data = fixture(t);
  const original = readFileSync(join(data.repository, paths[0]), 'utf8');
  let candidate = data.change(paths[0], (source) =>
    source.replace(
      '      "$release_source_floor_node" /usr/local/lib/maxim-release/infra/scripts/release-service-source-floor.mjs',
      '      # "$release_source_floor_node" /usr/local/lib/maxim-release/infra/scripts/release-service-source-floor.mjs',
    ),
  );
  assertCode(() => data.check(candidate), 'PROTECTED_PREFIX_CHANGED');
  writeFileSync(
    join(data.repository, paths[0]),
    original.replace(
      'maxim_pair_release_required() {\n',
      'maxim_pair_release_required() {\n  return 1\n',
    ),
  );
  candidate = data.commit('scope bypass');
  assertCode(() => data.check(candidate), 'PROTECTED_PREFIX_CHANGED');
  writeFileSync(
    join(data.repository, paths[0]),
    `${original}\nrequire_pair_release_admission_dispatch() { return 0; }\n`,
  );
  candidate = data.commit('duplicate dispatch');
  assertCode(() => data.check(candidate), 'AMBIGUOUS_DISPATCH');
});

test('deleted pause hook and connector bootstrap change cannot retain only a textual marker', (t) => {
  const data = fixture(t);
  const original = readFileSync(join(data.repository, paths[3]), 'utf8');
  let candidate = data.change(paths[3], (source) =>
    source.replace('pause-rollback >/dev/null || exit $?', 'read >/dev/null || exit $?'),
  );
  assertCode(() => data.check(candidate), 'HOOK_MISSING');
  writeFileSync(
    join(data.repository, paths[3]),
    original.replace(
      "rollback_entrypoint_bootstrap_source() {\n  cat <<'BOOTSTRAP'\n",
      "rollback_entrypoint_bootstrap_source() {\n  return 0\n  cat <<'BOOTSTRAP'\n",
    ),
  );
  candidate = data.commit('bootstrap bypass');
  assertCode(() => data.check(candidate), 'HOOK_MISSING');
});

test('missing, symlinked and oversized committed source blobs are refused before reading candidate bytes', (t) => {
  const data = fixture(t);
  const original = readFileSync(join(data.repository, paths[2]), 'utf8');
  unlinkSync(join(data.repository, paths[2]));
  let candidate = data.commit('missing rollback');
  assertCode(() => data.check(candidate), 'UNSAFE_SOURCE_BLOB');
  symlinkSync('vps-connect.sh', join(data.repository, paths[2]));
  candidate = data.commit('symlink rollback');
  assertCode(() => data.check(candidate), 'UNSAFE_SOURCE_BLOB');
  unlinkSync(join(data.repository, paths[2]));
  writeFileSync(join(data.repository, paths[2]), original + 'x'.repeat(262144));
  candidate = data.commit('oversized rollback');
  assertCode(() => data.check(candidate), 'SOURCE_TOO_LARGE');
});

test('replacement refs cannot fabricate ancestry and legacy grafts are rejected', (t) => {
  const data = fixture(t);
  data.git('checkout', '-q', '--detach', data.oldSha);
  writeFileSync(join(data.repository, 'README.md'), 'Unrelated branch.\n');
  const cousin = data.commit('cousin replacement target');
  data.git('replace', '--graft', cousin, data.installedSha);
  assert.equal(data.git('merge-base', '--is-ancestor', data.installedSha, cousin), '');
  assertCode(() => data.check(cousin), 'SOURCE_DOWNGRADE');
  writeFileSync(join(data.repository, '.git/info/grafts'), `${cousin} ${data.installedSha}\n`);
  assertCode(() => data.check(cousin), 'GRAFTED_HISTORY');
});

test('marker must be exactly a lowercase commit SHA with one newline', (t) => {
  const data = fixture(t);
  for (const marker of [
    data.installedSha,
    `${data.installedSha}\n\n`,
    `${data.installedSha.toUpperCase()}\n`,
    `${'g'.repeat(40)}\n`,
    Buffer.concat([Buffer.alloc(40, 0xe1), Buffer.from('\n')]),
  ]) {
    writeFileSync(data.markerPath, marker);
    assert.throws(() => data.check(data.installedSha));
  }
  const blob = data.git('rev-parse', `${data.installedSha}:README.md`);
  writeFileSync(data.markerPath, `${blob}\n`);
  assertCode(() => data.check(data.installedSha), 'INVALID_COMMIT');
});

test('present unsafe directories, helper files and marker inodes fail closed', (t) => {
  const data = fixture(t);
  chmodSync(data.configuration, 0o775);
  assertCode(() => data.check(data.installedSha), 'UNSAFE_DIRECTORY');
  chmodSync(data.configuration, 0o755);
  chmodSync(data.helperPath, 0o666);
  assertCode(() => data.check(data.installedSha), 'UNSAFE_FILE');
  chmodSync(data.helperPath, 0o644);
  const otherLink = join(data.configuration, 'marker-link');
  linkSync(data.markerPath, otherLink);
  assertCode(() => data.check(data.installedSha), 'UNSAFE_FILE');
  unlinkSync(otherLink);
  unlinkSync(data.markerPath);
  symlinkSync(join(data.configuration, 'missing-target'), data.markerPath);
  assertCode(() => data.check(data.installedSha), 'UNSAFE_FILE');
});

test('present installation never accepts refs, option-like candidates or an unrelated repository path', (t) => {
  const data = fixture(t);
  for (const candidate of ['main', '--help', data.installedSha.toUpperCase(), null])
    assertCode(() => data.check(candidate), 'INVALID_ARGUMENTS');
  assertCode(
    () =>
      assertReleaseSourceFloor({
        ...data.settings,
        repositoryRoot: data.configuration,
        candidateSha: data.installedSha,
      }),
    'UNSAFE_REPOSITORY',
  );
});
