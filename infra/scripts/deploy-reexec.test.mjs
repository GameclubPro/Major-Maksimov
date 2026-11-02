import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';
import { deployLockEnvironment, deployLockFixture } from './test-fixtures/deploy-lock.mjs';

const source = readFileSync(new URL('./vps-pull-build-up.sh', import.meta.url), 'utf8');
const entrypoint = 'infra/scripts/vps-pull-build-up.sh';
const outcomeHelper = 'infra/scripts/lib/outcome-cohort-online-prepare.sh';
const routingHelper = 'infra/scripts/lib/routing-index-online-prepare.sh';
const photoHelper = 'infra/scripts/lib/photo-native-lifecycle.sh';
const eraserHelper = 'infra/scripts/lib/eraser-deploy.sh';
const topologyHelper = 'infra/scripts/lib/deploy-topology.sh';
const topologySource = readFileSync(new URL('./lib/deploy-topology.sh', import.meta.url), 'utf8');
const topologySources = topologySource
  .split('\n')
  .filter((line) => line.startsWith('source '))
  .join('\n');
function functionBlock(name) {
  const start = source.indexOf(`${name}() {`);
  assert.notEqual(start, -1, name);
  const end = source.indexOf('\n}\n', start);
  assert.notEqual(end, -1, name);
  return source.slice(start, end + 2);
}
const sharedFunctions = [
  'has_pulled_changes',
  'diff_in_paths',
  'reexec_if_current_script_changed',
  'verify_expected_deploy_sha',
]
  .map(functionBlock)
  .join('\n');
const sync = functionBlock('sync_branch');
// FLAG: This deliberate regression mutant restores the production failure's late
// capture. The otherwise identical real Git fixture must expose the omitted hook.
const baselineLine = '  PRE_PULL_HEAD="$(git rev-parse --verify HEAD)" || return 2\n';
assert.ok(sync.includes(baselineLine));
const lateCaptureSync = sync
  .replace(baselineLine, '')
  .replace(
    '  tracked_status="$(git status --porcelain --untracked-files=no)"',
    `${baselineLine}  tracked_status="$(git status --porcelain --untracked-files=no)"`,
  );
function controller(revision, lateCapture = false) {
  return `#!/usr/bin/env bash
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT_DIR"
SCRIPT_PATH="$ROOT_DIR/${entrypoint}"
SCRIPT_REL_PATH="${entrypoint}"
ORIGINAL_ARGS=("$@")
BRANCH="$1"
PRE_PULL_HEAD=""
EXPECTED_DEPLOY_SHA="$MAXIM_EXPECTED_DEPLOY_SHA"
DEPLOY_MODE=auto
LOADED_CONTROLLER=${revision}
source "$ROOT_DIR/infra/scripts/lib/deploy-lock.sh"
source "$ROOT_DIR/${outcomeHelper}"
source "$ROOT_DIR/${routingHelper}"
source "$ROOT_DIR/${topologyHelper}"
source "$ROOT_DIR/${eraserHelper}"
# This fixture proves controller re-exec, while the lifecycle floor has separate
# immutable-source rejection tests and must not inspect this synthetic API tree.
maxim_topology_require_statistics_authority_lifecycle() { :; }
${sharedFunctions}
${lateCapture ? lateCaptureSync : sync}
acquire_deploy_lock
require_deploy_lock
printf 'ENTRY\\t%s\\t%s\\t%s\\t%s\\n' "$LOADED_CONTROLLER" "$BASHPID" "$MAXIM_DEPLOY_LOCK_FD" "$MAXIM_DEPLOY_LOCK_IDENTITY" >> "$FIXTURE_LOG"
printf 'ARG\\t%s\\n' "$@" >> "$FIXTURE_LOG"
sync_branch
verify_expected_deploy_sha
if [[ -n "$FIXTURE_DIFF_BASELINE" ]]; then PRE_PULL_HEAD="$FIXTURE_DIFF_BASELINE"; fi
reexec_if_current_script_changed
require_deploy_lock
if [[ "$LOADED_CONTROLLER" == new ]]; then maxim_outcome_cohort_prepare; fi
if [[ "$LOADED_CONTROLLER" == new ]]; then maxim_routing_index_prepare; fi
if [[ "$FIXTURE_NATIVE_PROBE" == 1 ]]; then maxim_photo_native_probe; fi
if [[ "$FIXTURE_ERASER_PROBE" == 1 ]]; then maxim_eraser_install_rate_limit_reader_floor; fi
printf 'PAUSE\\nMIGRATION\\n' >> "$FIXTURE_LOG"
`;
}
function helper(revision) {
  return `maxim_outcome_cohort_prepare() {
  printf 'PREPARE\\t${revision}\\n' >> "$FIXTURE_LOG"
  if [[ "$FIXTURE_PREPARE_FAILURE" == 1 ]]; then return 19; fi
}
`;
}
function photoNativeHelper(revision) {
  return `maxim_photo_native_probe() {
  printf 'NATIVE\\t${revision}\\n' >> "$FIXTURE_LOG"
}
`;
}

function routingIndexHelper(revision) {
  return `maxim_routing_index_prepare() {
  printf 'ROUTING\\t${revision}\\n' >> "$FIXTURE_LOG"
}
`;
}

function eraserDeployHelper(revision) {
  return `maxim_eraser_install_rate_limit_reader_floor() {
  printf 'ERASER\\t${revision}\\n' >> "$FIXTURE_LOG"
}
`;
}

function fixture(
  t,
  {
    lateCapture = false,
    helperOnly = false,
    routingHelperOnly = false,
    photoHelperOnly = false,
    eraserHelperOnly = false,
    localMain = 'B',
    initial = 'A',
    remoteMain = 'C',
  } = {},
) {
  const directory = mkdtempSync(resolve(tmpdir(), 'maxim-deploy-reexec-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const repo = resolve(directory, 'repo');
  const remote = resolve(directory, 'origin.git');
  const log = resolve(directory, 'events.log');
  mkdirSync(repo);
  const lock = deployLockFixture(directory, resolve(repo, 'infra/scripts/lib/deploy-lock.sh'));
  for (const file of ['vps-runtime-rollback.sh', 'vps-connect.sh']) {
    writeFileSync(
      resolve(repo, 'infra/scripts', file),
      readFileSync(new URL(`./${file}`, import.meta.url), 'utf8'),
    );
  }
  const env = deployLockEnvironment({
    GIT_AUTHOR_NAME: 'Fixture',
    GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
    GIT_COMMITTER_NAME: 'Fixture',
    GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
    MAXIM_DEPLOY_SCRIPT_REEXECED: '0',
    FIXTURE_LOG: log,
    FIXTURE_DIFF_BASELINE: '',
    FIXTURE_PREPARE_FAILURE: '0',
    FIXTURE_NATIVE_PROBE: '0',
    FIXTURE_ERASER_PROBE: '0',
  });
  const git = (...args) =>
    execFileSync('git', args, {
      cwd: repo,
      env,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 5000,
    }).trim();
  const commit = (name) => {
    git('add', '.');
    git('commit', '-m', name);
    return git('rev-parse', 'HEAD');
  };
  git('init', '-b', 'fixture');
  writeFileSync(
    resolve(repo, entrypoint),
    controller(
      helperOnly || routingHelperOnly || photoHelperOnly || eraserHelperOnly ? 'new' : 'old',
      lateCapture,
    ),
  );
  chmodSync(resolve(repo, entrypoint), 0o755);
  writeFileSync(resolve(repo, outcomeHelper), helper('old'));
  writeFileSync(resolve(repo, routingHelper), routingIndexHelper('old'));
  writeFileSync(
    resolve(repo, topologyHelper),
    `${topologySources}\n${topologySource.slice(topologySource.indexOf('maxim_topology_require_eraser_bridge() {'))}`
      .replaceAll('/var/lib/maxim-deploy', resolve(directory, 'deploy-state'))
      .replaceAll('/var/lib/maxim-secrets', resolve(directory, 'secrets')),
  );
  writeFileSync(resolve(repo, photoHelper), photoNativeHelper('old'));
  writeFileSync(resolve(repo, eraserHelper), eraserDeployHelper('old'));
  const A = commit('A: original installed controller');
  if (!helperOnly && !routingHelperOnly && !photoHelperOnly && !eraserHelperOnly)
    writeFileSync(resolve(repo, entrypoint), controller('new'));
  if (routingHelperOnly) writeFileSync(resolve(repo, routingHelper), routingIndexHelper('new'));
  else if (photoHelperOnly) writeFileSync(resolve(repo, photoHelper), photoNativeHelper('new'));
  else if (eraserHelperOnly) writeFileSync(resolve(repo, eraserHelper), eraserDeployHelper('new'));
  else writeFileSync(resolve(repo, outcomeHelper), helper('new'));
  const B = commit('B: updated controller or preparation helper');
  writeFileSync(resolve(repo, 'release-notes.txt'), 'C changes no loaded controller inputs.\n');
  const C = commit('C: unrelated later commit');
  const refs = { A, B, C };
  git('init', '--bare', remote);
  git('remote', 'add', 'origin', remote);
  git('push', 'origin', `${refs[remoteMain]}:refs/heads/main`);
  git('branch', 'main', refs[localMain]);
  if (initial === 'main') git('checkout', 'main');
  else git('checkout', '--detach', refs[initial]);
  const run = (extra = {}) =>
    spawnSync(resolve(repo, entrypoint), ['main', '--auto', 'literal argument with spaces'], {
      cwd: repo,
      env: { ...env, MAXIM_EXPECTED_DEPLOY_SHA: refs[remoteMain], ...extra },
      encoding: 'utf8',
      timeout: 10000,
    });
  const events = () =>
    existsSync(log)
      ? readFileSync(log, 'utf8')
          .trim()
          .split('\n')
          .map((line) => line.split('\t'))
      : [];
  const unlocked = () =>
    spawnSync(
      'bash',
      [
        '-c',
        'set -euo pipefail; source "$1"; acquire_deploy_lock; require_deploy_lock; release_deploy_lock',
        'lock-probe',
        lock.helper,
      ],
      { cwd: repo, env, encoding: 'utf8', timeout: 3000 },
    );
  return { repo, git, refs, run, events, unlocked };
}
function completed(h, result, expectedEntries, expectedPreparation = ['new']) {
  assert.equal(result.error, undefined, result.stderr);
  assert.equal(result.status, 0, result.stderr);
  const events = h.events();
  const entries = events.filter(([event]) => event === 'ENTRY');
  assert.deepEqual(
    entries.map((entry) => entry[1]),
    expectedEntries,
  );
  // Real production FD/inode validation runs before and after exec. A spawned child
  // would have a different BASHPID and fail inherited authority validation.
  assert.ok(entries.every((entry) => entry.slice(2).join(':') === entries[0].slice(2).join(':')));
  assert.deepEqual(
    events.filter(([event]) => event === 'ARG').map((entry) => entry[1]),
    expectedEntries.flatMap(() => ['main', '--auto', 'literal argument with spaces']),
  );
  assert.deepEqual(
    events.filter(([event]) => event === 'PREPARE').map((entry) => entry[1]),
    expectedPreparation,
  );
  assert.equal(events.filter(([event]) => event === 'PAUSE').length, 1);
  assert.equal(events.filter(([event]) => event === 'MIGRATION').length, 1);
  if (expectedPreparation.length)
    assert.ok(
      events.findIndex(([event]) => event === 'PREPARE') <
        events.findIndex(([event]) => event === 'PAUSE'),
    );
  assert.equal(h.unlocked().status, 0);
}

test('detached A to local main B to remote C exposes the old lost-baseline behavior and executes the new hook before pause', (t) => {
  const broken = fixture(t, { lateCapture: true });
  completed(broken, broken.run(), ['old'], []);
  assert.doesNotMatch(
    broken.git('diff', '--name-only', broken.refs.B, broken.refs.C),
    /vps-pull-build-up|outcome-cohort/u,
  );
  const fixed = fixture(t);
  completed(fixed, fixed.run(), ['old', 'new']);
  assert.equal(fixed.git('rev-parse', 'HEAD'), fixed.refs.C);
});

test('checkout-only controller replacement reexecutes even when main needs no pull', (t) => {
  const h = fixture(t, { remoteMain: 'B' });
  completed(h, h.run(), ['old', 'new']);
  assert.equal(h.git('rev-parse', 'HEAD'), h.refs.B);
});

test('ordinary pull still reexecutes changed controller and preserves exact SHA and original arguments', (t) => {
  const h = fixture(t, { localMain: 'A', initial: 'main' });
  completed(h, h.run(), ['old', 'new']);
  assert.equal(h.git('rev-parse', 'HEAD'), h.refs.C);
});

test('unchanged controller stays in the same process for no-change sync and unrelated pull', (t) => {
  for (const localMain of ['B', 'C']) {
    const h = fixture(t, { localMain, initial: 'main' });
    completed(h, h.run(), ['new']);
    assert.equal(h.git('rev-parse', 'HEAD'), h.refs.C);
  }
});

test('outcome helper-only checkout change reexecutes an otherwise identical entrypoint', (t) => {
  const h = fixture(t, { helperOnly: true });
  assert.equal(
    h.git('rev-parse', `${h.refs.A}:${entrypoint}`),
    h.git('rev-parse', `${h.refs.C}:${entrypoint}`),
  );
  completed(h, h.run(), ['new', 'new']);
});

test('routing helper-only checkout change reloads preparation under the same deploy lock', (t) => {
  const h = fixture(t, { routingHelperOnly: true });
  assert.deepEqual(h.git('diff', '--name-only', h.refs.A, h.refs.B).split('\n'), [routingHelper]);
  completed(h, h.run(), ['new', 'new'], ['old']);
  assert.deepEqual(
    h.events().filter(([event]) => event === 'ROUTING'),
    [['ROUTING', 'new']],
  );
  assert.ok(
    h.events().findIndex(([event]) => event === 'ROUTING') <
      h.events().findIndex(([event]) => event === 'PAUSE'),
  );
});

test('nested photo lifecycle helper-only change reloads native functions before the pause', (t) => {
  const h = fixture(t, { photoHelperOnly: true });
  assert.deepEqual(h.git('diff', '--name-only', h.refs.A, h.refs.B).split('\n'), [photoHelper]);
  completed(h, h.run({ FIXTURE_NATIVE_PROBE: '1' }), ['new', 'new'], ['old']);
  assert.deepEqual(
    h.events().filter(([event]) => event === 'NATIVE'),
    [['NATIVE', 'new']],
  );
  assert.ok(
    h.events().findIndex(([event]) => event === 'NATIVE') <
      h.events().findIndex(([event]) => event === 'PAUSE'),
  );
});

test('Lastik helper-only change reloads its reader-floor installer before migration', (t) => {
  const h = fixture(t, { eraserHelperOnly: true });
  assert.deepEqual(h.git('diff', '--name-only', h.refs.A, h.refs.B).split('\n'), [eraserHelper]);
  completed(h, h.run({ FIXTURE_ERASER_PROBE: '1' }), ['new', 'new'], ['old']);
  assert.deepEqual(
    h.events().filter(([event]) => event === 'ERASER'),
    [['ERASER', 'new']],
  );
  assert.ok(
    h.events().findIndex(([event]) => event === 'ERASER') <
      h.events().findIndex(([event]) => event === 'MIGRATION'),
  );
});

test('invalid comparison reference refuses before preparation, pause or migration and releases only its owned lock', (t) => {
  const h = fixture(t, { localMain: 'C', initial: 'main' });
  const result = h.run({ FIXTURE_DIFF_BASELINE: 'missing-controller-revision' });
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /Cannot compare the loaded deploy controller/u);
  assert.ok(h.events().every(([event]) => event === 'ENTRY' || event === 'ARG'));
  assert.equal(h.unlocked().status, 0);
});

test('already-reexecuted flag cannot hide a new controller change or comparison error', (t) => {
  for (const invalid of [false, true]) {
    const h = fixture(t);
    const result = h.run({
      MAXIM_DEPLOY_SCRIPT_REEXECED: '1',
      FIXTURE_DIFF_BASELINE: invalid ? 'missing-controller-revision' : '',
    });
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, invalid ? /Cannot compare/u : /changed again after re-exec/u);
    assert.ok(h.events().every(([event]) => event === 'ENTRY' || event === 'ARG'));
    assert.equal(h.unlocked().status, 0);
  }
});

test('exact SHA mismatch and new-controller preparation failure cannot cross the pause boundary', (t) => {
  const wrongSha = fixture(t);
  const mismatch = wrongSha.run({ MAXIM_EXPECTED_DEPLOY_SHA: wrongSha.refs.B });
  assert.equal(mismatch.status, 2, mismatch.stderr);
  assert.match(mismatch.stderr, /synchronized VPS commit does not match/u);
  assert.ok(wrongSha.events().every(([event]) => event === 'ENTRY' || event === 'ARG'));
  assert.equal(wrongSha.unlocked().status, 0);
  const failure = fixture(t);
  const failed = failure.run({ FIXTURE_PREPARE_FAILURE: '1' });
  assert.equal(failed.status, 19, failed.stderr);
  assert.deepEqual(
    failure
      .events()
      .filter(([event]) => event === 'ENTRY')
      .map((e) => e[1]),
    ['old', 'new'],
  );
  assert.ok(failure.events().some(([event]) => event === 'PREPARE'));
  assert.ok(failure.events().every(([event]) => event !== 'PAUSE' && event !== 'MIGRATION'));
  assert.equal(failure.unlocked().status, 0);
});
