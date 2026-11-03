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
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { deployLockEnvironment, deployLockFixture } from './test-fixtures/deploy-lock.mjs';
import {
  assertEraserConnectionProofReaderSource,
  installEraserConnectionProofReaderFloor,
  validateEraserConnectionProofReaderFloor,
} from './assert-eraser-source.mjs';

const root = resolve(import.meta.dirname, '../..');
const bridgeLine =
  'node "${BASH_SOURCE[0]%/*}/../assert-eraser-source.mjs" "$proof_source" --installed-connection-proof-reader tooling || return 1';
const toolingPaths = [
  'infra/scripts/assert-eraser-source.mjs',
  'infra/scripts/lib/deploy-lock.sh',
  'infra/scripts/lib/deploy-topology.sh',
  'infra/scripts/lib/eraser-deploy.sh',
  'infra/scripts/lib/pair-release-admission.sh',
  'infra/scripts/lib/photo-native-lifecycle.sh',
  'infra/scripts/vps-connect.sh',
  'infra/scripts/vps-pull-build-up.sh',
  'infra/scripts/vps-runtime-rollback.sh',
  'infra/scripts/vps-release-rollback.sh',
];
const appPaths = [
  'apps/eraser/src/store.ts',
  'apps/eraser/src/types.ts',
  'apps/eraser/src/http.ts',
  'apps/eraser/src/runtime.ts',
  'apps/eraser/migrations/0009-connection-generation.sql',
];
const read = (path) => readFileSync(join(root, path), 'utf8');
const frozenBootstrap = read('infra/scripts/test-fixtures/pre-proof-rollback-bootstrap.sh.txt');

function functionBlock(source, name) {
  const start = source.indexOf(`${name}() {`);
  assert.ok(start >= 0, name);
  const end = source.indexOf('\n}\n', start);
  assert.ok(end > start, name);
  return source.slice(start, end + 2);
}

function command(cwd, program, args, options = {}) {
  return spawnSync(program, args, { cwd, encoding: 'utf8', timeout: 15_000, ...options });
}

function git(cwd, ...args) {
  const result = command(cwd, 'git', args);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function bootstrapFixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'lastik-proof-floor-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const repo = join(directory, 'repo');
  mkdirSync(repo, { mode: 0o700 });
  const lock = deployLockFixture(directory, join(repo, 'infra/scripts/lib/deploy-lock.sh'));
  const relocate = (source) =>
    lock.pair
      .relocate(source)
      .replaceAll('/var/lib/maxim-deploy', lock.protectedDirectory)
      .replaceAll('/tmp/maxim-main-deploy.lock', lock.legacyDirectory)
      .replaceAll('/var/lib/maxim-secrets', join(directory, 'absent-secrets'))
      .replaceAll('/etc/maxim-deploy/market-statistics', join(directory, 'absent-market-floor'));
  // Pair paths and the MAXIM product lock have separate fixture roots.
  const relocateTool = (source) =>
    relocate(source.replaceAll('/var/lib/maxim-deploy', lock.protectedDirectory));
  const put = (path, source) => {
    const target = join(repo, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(
      target,
      path.endsWith('/pair-release-admission.sh')
        ? lock.pair.relocate(source)
        : relocateTool(source),
    );
  };
  git(repo, 'init', '-b', 'main');
  git(repo, 'config', 'user.name', 'Lastik proof fixture');
  git(repo, 'config', 'user.email', 'lastik-fixture@example.invalid');
  // The exact old caller is frozen. Its incompatible target is self-contained:
  // real sources with the new dispatch removed, requiring no historical Git objects.
  for (const path of [...toolingPaths, ...appPaths]) {
    const source = read(path);
    put(
      path,
      path === 'infra/scripts/lib/deploy-lock.sh'
        ? source.replace(bridgeLine, ':')
        : path === 'apps/eraser/src/store.ts'
          ? source.replace(
              'ERASER_CONNECTION_PROOF_READER_VERSION = 1;',
              'ERASER_CONNECTION_PROOF_READER_VERSION = 0;',
            )
          : source,
    );
  }
  put(
    'infra/scripts/lib/legacy-cold-maintenance.sh',
    'maxim_require_ordinary_effect_authority() { require_deploy_lock; }\n',
  );
  const entrypoint = './fixture-entrypoint.sh';
  put(
    entrypoint,
    '#!/usr/bin/env bash\n# fixture-capability\nrequire_deploy_lock\nprintf "ENTERED\\n"\n',
  );
  command(repo, 'chmod', ['700', entrypoint]);
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', 'Candidate missing proof admission');
  const oldSha = git(repo, 'rev-parse', 'HEAD');
  for (const path of [...toolingPaths, ...appPaths]) put(path, read(path));
  put(
    entrypoint,
    '#!/usr/bin/env bash\n# retained older entrypoint needs tooling synchronization\nexit 99\n',
  );
  git(repo, 'add', '.');
  git(repo, 'commit', '--allow-empty', '-qm', 'Current remote helpers');
  const currentSha = git(repo, 'rev-parse', 'HEAD');
  git(repo, 'checkout', '--detach', currentSha);
  git(repo, 'branch', '-f', 'main', oldSha);
  const floor = join(lock.protectedDirectory, 'eraser-connection-proof-reader-version');
  writeFileSync(floor, '1\n', { mode: 0o600 });
  const run = (expected = oldSha) =>
    command(
      repo,
      'bash',
      [
        '-c',
        relocateTool(frozenBootstrap),
        'old-local-bootstrap',
        expected,
        entrypoint,
        'fixture-capability',
        'fixture-release',
      ],
      { env: deployLockEnvironment() },
    );
  const candidate = (overrides = {}) => {
    put(
      entrypoint,
      '#!/usr/bin/env bash\n# fixture-capability\nrequire_deploy_lock\nprintf "ENTERED\\n"\n',
    );
    for (const [path, source] of Object.entries(overrides)) put(path, source);
    git(repo, 'add', '.');
    git(repo, 'commit', '--allow-empty', '-qm', 'Selected candidate');
    const sha = git(repo, 'rev-parse', 'HEAD');
    git(repo, 'checkout', '--detach', currentSha);
    git(repo, 'branch', '-f', 'main', sha);
    return sha;
  };
  return { directory, repo, lock, floor, oldSha, currentSha, run, put, candidate, relocateTool };
}

test('old local bootstrap cannot switch to proof-unaware tooling through current remote helpers', (t) => {
  const f = bootstrapFixture(t);
  const marker = statSync(f.floor);
  const result = f.run();
  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.equal(git(f.repo, 'rev-parse', 'HEAD'), f.currentSha);
  assert.equal(git(f.repo, 'rev-parse', 'main'), f.oldSha);
  assert.doesNotMatch(result.stdout, /ENTERED/);
  assert.equal(readFileSync(f.floor, 'utf8'), '1\n');
  assert.equal(statSync(f.floor).ino, marker.ino);
  assert.ok(existsSync(f.lock.file));
});

test('old bootstrap admits compatible tooling with the real marker, checker, lock and Git switch', (t) => {
  const f = bootstrapFixture(t);
  const target = f.candidate();
  const result = f.run(target);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(git(f.repo, 'rev-parse', 'HEAD'), target);
  assert.equal(result.stdout, 'ENTERED\n');
  assert.equal(command(f.repo, 'flock', ['-n', f.lock.file, 'true']).status, 0);
});

test('old bootstrap rejects unknown proof floors even without the older markers', (t) => {
  const f = bootstrapFixture(t);
  const target = f.candidate();
  for (const value of ['', '1', '2\n', '1\nextra']) {
    writeFileSync(f.floor, value);
    const result = f.run(target);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /connection proof reader floor is unknown or unsafe/);
    assert.equal(git(f.repo, 'rev-parse', 'HEAD'), f.currentSha);
    assert.equal(readFileSync(f.floor, 'utf8'), value);
    assert.doesNotMatch(result.stdout, /ENTERED/);
  }
});

test('proof marker is durable and strict about link, mode, version and caller identity', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'lastik-proof-marker-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const floor = join(directory, 'floor');
  installEraserConnectionProofReaderFloor(floor);
  const inode = statSync(floor).ino;
  installEraserConnectionProofReaderFloor(floor);
  assert.equal(statSync(floor).ino, inode);
  validateEraserConnectionProofReaderFloor(floor);
  const originalUid = process.getuid;
  process.getuid = () => originalUid() + 1;
  try {
    assert.throws(() => validateEraserConnectionProofReaderFloor(floor), /unknown or unsafe/);
  } finally {
    process.getuid = originalUid;
  }
  chmodSync(floor, 0o644);
  assert.throws(() => installEraserConnectionProofReaderFloor(floor), /unknown or unsafe/);
  chmodSync(floor, 0o600);
  symlinkSync(floor, join(directory, 'link'));
  assert.throws(() => installEraserConnectionProofReaderFloor(join(directory, 'link')));
  symlinkSync(join(directory, 'absent'), join(directory, 'dangling'));
  assert.throws(() => installEraserConnectionProofReaderFloor(join(directory, 'dangling')));
  linkSync(floor, join(directory, 'hardlink'));
  assert.throws(() => installEraserConnectionProofReaderFloor(floor), /unknown or unsafe/);
  assert.equal(readFileSync(floor, 'utf8'), '1\n');
  assert.equal(statSync(floor).ino, inode);
});

test('source capability binds active bridge and pre-mutation ordering to complete implementation', () => {
  const sha = 'a'.repeat(40);
  assert.doesNotThrow(() => assertEraserConnectionProofReaderSource(sha, 'all', read));
  assert.throws(
    () => assertEraserConnectionProofReaderSource('main', 'tooling', read),
    /exact source SHA/,
  );
  assert.throws(() => assertEraserConnectionProofReaderSource(sha, 'api-shared', read), /Unknown/);
  const path = 'infra/scripts/lib/deploy-lock.sh';
  for (const replacement of [':', `# ${bridgeLine}`, `printf '%s' '${bridgeLine}'`])
    assert.throws(
      () =>
        assertEraserConnectionProofReaderSource(sha, 'tooling', (file) =>
          file === path ? read(file).replace(bridgeLine, replacement) : read(file),
        ),
      /connection proof/,
    );
  const outside = read(path).replace(bridgeLine, ':') + `\nunused_proof() {\n  ${bridgeLine}\n}\n`;
  assert.throws(
    () =>
      assertEraserConnectionProofReaderSource(sha, 'tooling', (file) =>
        file === path ? outside : read(file),
      ),
    /outside source dispatch/,
  );
  const connector = 'infra/scripts/vps-connect.sh';
  const dispatch = 'require_pair_release_admission_dispatch "$expected_tooling_sha" || exit 1';
  const late = read(connector)
    .replace(dispatch, ':')
    .replace('git checkout main', `git checkout main\n${dispatch}`);
  assert.throws(
    () =>
      assertEraserConnectionProofReaderSource(sha, 'tooling', (file) =>
        file === connector ? late : read(file),
      ),
    /follows source\/runtime mutation/,
  );
});

test('immutable Lastik rollback checks its application while API/static-only scope remains independent', (t) => {
  const f = bootstrapFixture(t);
  const source = read('infra/scripts/vps-release-rollback.sh');
  const start = source.indexOf('if [[ "$SELECT_ERASER" -eq 1 ]]; then');
  const guard = source.slice(start, source.indexOf('\nfi', start) + 3);
  for (const [selected, target, allowed] of [
    [1, f.oldSha, false],
    [1, f.currentSha, true],
    [0, f.oldSha, true],
  ]) {
    const result = command(f.repo, 'bash', [
      '-c',
      `set -euo pipefail
source infra/scripts/lib/deploy-topology.sh
SELECT_ERASER="$1"
declare -A COMPONENT_SOURCE_SHA=([eraser]="$2")
${guard}
printf 'ADMITTED\\n'
`,
      'component-fixture',
      String(selected),
      target,
    ]);
    assert.equal(result.status === 0, allowed, result.stderr);
    assert.equal(result.stdout, allowed ? 'ADMITTED\n' : '');
    assert.equal(git(f.repo, 'rev-parse', 'HEAD'), f.currentSha);
  }
});

for (const scenario of ['old-origin', 'old-local', 'compatible']) {
  test(`real branch synchronization preserves the proof floor: ${scenario}`, (t) => {
    const f = bootstrapFixture(t);
    const remote = join(f.directory, 'origin.git');
    git(f.repo, 'init', '--bare', remote);
    git(f.repo, 'remote', 'add', 'origin', remote);
    const target = scenario === 'old-origin' ? f.oldSha : f.currentSha;
    git(f.repo, 'push', 'origin', `${target}:refs/heads/main`);
    git(f.repo, 'branch', '-f', 'main', scenario === 'old-local' ? f.oldSha : f.currentSha);
    const sync = functionBlock(read('infra/scripts/vps-pull-build-up.sh'), 'sync_branch');
    const result = command(
      f.repo,
      'bash',
      [
        '-c',
        `set -euo pipefail
source infra/scripts/lib/deploy-lock.sh
source infra/scripts/lib/deploy-topology.sh
# Unrelated API lifecycle has separate tests; the proof bridge and Git stay real.
maxim_topology_require_statistics_authority_lifecycle() { :; }
BRANCH=main
${sync}
acquire_deploy_lock
sync_branch
printf 'SYNCED\\n'
`,
      ],
      { env: deployLockEnvironment() },
    );
    assert.equal(result.status === 0, scenario === 'compatible', result.stderr);
    assert.equal(git(f.repo, 'rev-parse', 'HEAD'), f.currentSha);
    assert.equal(result.stdout.includes('SYNCED'), scenario === 'compatible');
    assert.equal(readFileSync(f.floor, 'utf8'), '1\n');
  });
}

test('first upgrade reloads the actual installer and persists its floor before a failed migration', (t) => {
  const f = bootstrapFixture(t);
  rmSync(f.floor);
  const remote = join(f.directory, 'origin.git');
  git(f.repo, 'init', '--bare', remote);
  git(f.repo, 'remote', 'add', 'origin', remote);
  git(f.repo, 'push', 'origin', `${f.currentSha}:refs/heads/main`);
  git(f.repo, 'branch', '-f', 'main', f.currentSha);
  git(f.repo, 'checkout', '--detach', f.oldSha);
  const helper = read('infra/scripts/lib/eraser-deploy.sh');
  f.put(
    'infra/scripts/lib/eraser-deploy.sh',
    helper.replace(
      functionBlock(helper, 'maxim_eraser_install_connection_proof_reader_floor'),
      'maxim_eraser_install_connection_proof_reader_floor() { echo STALE_INSTALLER; return 47; }',
    ),
  );
  git(f.repo, 'add', '.');
  git(f.repo, 'commit', '-qm', 'Old in-memory installer must reload');
  const deploy = read('infra/scripts/vps-pull-build-up.sh');
  const functions = [
    'sync_branch',
    'has_pulled_changes',
    'diff_in_paths',
    'verify_expected_deploy_sha',
    'reexec_if_current_script_changed',
  ]
    .map((name) => functionBlock(deploy, name))
    .join('\n');
  const harness = join(f.directory, 'controller.sh');
  const log = join(f.directory, 'events');
  const config = join(f.directory, 'configured.env');
  writeFileSync(config, 'fixture\n', { mode: 0o600 });
  writeFileSync(
    harness,
    `#!/usr/bin/env bash
set -euo pipefail
cd "$FIXTURE_REPO"
ROOT_DIR="$PWD"
SCRIPT_PATH="$FIXTURE_HARNESS"
SCRIPT_REL_PATH=infra/scripts/vps-pull-build-up.sh
ORIGINAL_ARGS=(main)
BRANCH=main
EXPECTED_DEPLOY_SHA="$FIXTURE_TARGET"
source infra/scripts/lib/deploy-lock.sh
source infra/scripts/lib/deploy-topology.sh
source infra/scripts/lib/eraser-deploy.sh
maxim_topology_require_statistics_authority_lifecycle() { :; }
${functions}
acquire_deploy_lock
printf 'ENTRY %s\\n' "$BASHPID" >> "$FIXTURE_LOG"
sync_branch
verify_expected_deploy_sha
reexec_if_current_script_changed
maxim_eraser_install_connection_proof_reader_floor "$(git rev-parse HEAD)"
test -f "$FIXTURE_FLOOR"
printf 'FLOOR\\nMIGRATION\\n' >> "$FIXTURE_LOG"
exit 23
`,
    { mode: 0o700 },
  );
  const result = command(f.repo, harness, [], {
    env: deployLockEnvironment({
      FIXTURE_REPO: f.repo,
      FIXTURE_HARNESS: harness,
      FIXTURE_TARGET: f.currentSha,
      FIXTURE_LOG: log,
      FIXTURE_FLOOR: f.floor,
      MAXIM_ERASER_ENV_FILE: config,
      MAXIM_DEPLOY_SCRIPT_REEXECED: '0',
    }),
  });
  assert.equal(result.status, 23, result.stdout + result.stderr);
  assert.doesNotMatch(result.stdout, /STALE_INSTALLER/);
  const events = readFileSync(log, 'utf8').trim().split('\n');
  assert.equal(
    events[0],
    events[1],
    'exec retains the actual controller identity and inherited lock',
  );
  assert.deepEqual(events.slice(2), ['FLOOR', 'MIGRATION']);
  assert.equal(readFileSync(f.floor, 'utf8'), '1\n');
  assert.equal(git(f.repo, 'rev-parse', 'HEAD'), f.currentSha);
});
