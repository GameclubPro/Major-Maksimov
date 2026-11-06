import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import {
  scaleHostEnvironment,
  scaleHostIdentityFixture,
} from './test-fixtures/scale-deploy-profile.mjs';

const root = resolve(import.meta.dirname, '../..');
const sourceSha = execFileSync('git', ['rev-parse', 'HEAD'], {
  cwd: root,
  encoding: 'utf8',
}).trim();
const scripts = [
  ['vps-pull-build-up.sh', ['main', '--full']],
  ['vps-pull-build-up-scale.sh', ['main']],
  ['vps-runtime-rollback.sh', [sourceSha]],
  ['vps-release-rollback.sh', ['release-fixture', 'miniapp-major-static']],
  ['vps-finalize-release-recovery.sh', ['main']],
  ['vps-commercial-ocr-rollout.sh', ['downgrade', '--expected-revision', '1', '--apply']],
  ['vps-publisher-dispatch-rollout.sh', ['disable', '--apply']],
  ['vps-retire-legacy-default-webhook-queue.sh', ['--apply']],
  ['vps-retire-legacy-vk-publish-queue.sh', ['--apply']],
  ['deploy.sh', ['api-ingress']],
  ['vps-docker-space-reclaim.sh', []],
];

// FLAG: Relocate only the fixed host sentinel in a disposable copy. Production
// has no configurable path or environment bypass for an interrupted pre-drain.
function pendingPreDrainFixture() {
  const directory = mkdtempSync(join(tmpdir(), 'maxim-predrain-entrypoint-'));
  const pending = join(directory, 'queue-predrain-pending.json');
  const script = join(directory, 'authority.sh');
  const log = join(directory, 'calls.log');
  const source = readFileSync(join(root, 'infra/scripts/lib/legacy-cold-maintenance.sh'), 'utf8');
  assert.equal(source.split('/var/lib/maxim-deploy/queue-predrain-pending.json').length, 3);
  writeFileSync(
    script,
    source.replaceAll('/var/lib/maxim-deploy/queue-predrain-pending.json', pending),
  );
  return {
    directory,
    pending,
    run({ lock = true, journalStatus = 0 } = {}) {
      return spawnSync(
        'bash',
        [
          '-c',
          `source "$1"
PREDRAIN_TEST_LOCK_STATUS="$2"
PREDRAIN_TEST_JOURNAL_STATUS="$3"
require_deploy_lock() { return "$PREDRAIN_TEST_LOCK_STATUS"; }
node() { printf '%s\\n' "$*" >>"$PREDRAIN_TEST_LOG"; return "$PREDRAIN_TEST_JOURNAL_STATUS"; }
maxim_require_ordinary_effect_authority "$4"
`,
          'pending-pre-drain-fixture',
          script,
          lock ? '0' : '1',
          String(journalStatus),
          root,
        ],
        {
          encoding: 'utf8',
          env: {
            ...process.env,
            PREDRAIN_TEST_LOG: log,
            MAXIM_WEBHOOK_ROLLOUT_ADOPT_EXISTING_PAUSE: '1',
            MAXIM_PREDRAIN_ALLOW_PENDING: '1',
            MAXIM_PREDRAIN_PENDING_PATH: join(directory, 'absent-override'),
          },
        },
      );
    },
    calls() {
      try {
        return readFileSync(log, 'utf8');
      } catch (error) {
        if (error.code === 'ENOENT') return '';
        throw error;
      }
    },
    cleanup: () => rmSync(directory, { recursive: true, force: true }),
  };
}

for (const kind of ['valid', 'malformed', 'empty', 'directory', 'dangling-symlink']) {
  test(`pending pre-drain ${kind} refuses ordinary authority before the old cold journal`, () => {
    const state = pendingPreDrainFixture();
    try {
      if (kind === 'directory') mkdirSync(state.pending);
      else if (kind === 'dangling-symlink') symlinkSync('absent-target', state.pending);
      else
        writeFileSync(
          state.pending,
          kind === 'valid' ? '{"version":1}\n' : kind === 'malformed' ? '{' : '',
          { mode: 0o600 },
        );
      const result = state.run();
      assert.equal(result.status, 1);
      assert.match(result.stderr, /Queue pre-drain recovery is pending/u);
      assert.equal(state.calls(), '');
    } finally {
      state.cleanup();
    }
  });
}

test('absent pre-drain sentinel preserves cold journal checks and refusals', () => {
  const state = pendingPreDrainFixture();
  try {
    assert.equal(state.run().status, 0);
    assert.equal(state.run({ journalStatus: 73 }).status, 73);
    assert.equal((state.calls().match(/assert-ordinary-host/gu) ?? []).length, 2);
    const result = state.run({ lock: false });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /protected shared deploy lock/u);
    assert.equal((state.calls().match(/assert-ordinary-host/gu) ?? []).length, 2);
  } finally {
    state.cleanup();
  }
});

function readScript(name) {
  return readFileSync(join(root, 'infra/scripts', name), 'utf8');
}

function functionBlock(source, name) {
  const start = source.indexOf(`${name}() {\n`);
  assert.notEqual(start, -1, `Missing function ${name}`);
  const end = source.indexOf('\n}\n', start);
  assert.notEqual(end, -1, `Missing function end ${name}`);
  return source.slice(start, end + 3);
}

// FLAG: These doubles exercise callers' fail-closed boundaries only. Journal,
// immutable SQL holds and the actual protected flock have their own store/native tests.
function fixture({ missingHelper = false, rejectAfter = 0, localBranchExists = true } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'maxim-cold-entrypoints-'));
  const bin = join(directory, 'bin');
  const log = join(directory, 'calls.log');
  mkdirSync(bin);
  cpSync(join(root, 'infra/scripts'), join(directory, 'infra/scripts'), { recursive: true });
  scaleHostIdentityFixture(directory);
  // FLAG: Target-source floors are separate compatibility tests. Permit their
  // read-only preflight here so every wrapper reaches the rejecting admission boundary.
  const topology = join(directory, 'infra/scripts/lib/deploy-topology.sh');
  const sourceFloors = [
    ...readScript('vps-runtime-rollback.sh').matchAll(
      /^(maxim_topology_require_\w+) "\$TARGET_FULL_SHA"$/gmu,
    ),
  ].map((match) => `${match[1]}() { return 0; }`);
  // FLAG: Deploy synchronization calls the lifecycle floor directly, while rollback
  // now enters it through the combined statistics/night-mode recovery capability.
  sourceFloors.push('maxim_topology_require_statistics_authority_lifecycle() { return 0; }');
  sourceFloors.push('maxim_topology_require_publisher_secret_files() { return 0; }');
  writeFileSync(topology, `${readFileSync(topology, 'utf8')}\n${sourceFloors.join('\n')}\n`);
  mkdirSync(join(directory, 'scripts'), { recursive: true });
  writeFileSync(join(directory, 'scripts/smoke-http.mjs'), 'export {};\n');
  writeFileSync(join(directory, '.env'), 'NODE_ENV=production\n');
  writeFileSync(
    join(directory, 'infra/scripts/lib/deploy-lock.sh'),
    `
acquire_deploy_lock() {
  FIXTURE_LOCK_OWNER="$BASHPID"
  printf '%s\\n' lock-acquired >>"$COLD_ENTRY_TEST_LOG"
  trap release_deploy_lock EXIT
}
require_market_statistics_lock_dispatch() {
  printf '%s\\n' market-statistics-source-checked >>"$COLD_ENTRY_TEST_LOG"
}
require_major_market_release_dispatch() {
  require_deploy_lock || return
  [[ "$#" == 1 && ( "$1" == origin/main || "$1" == refs/heads/main || "$1" == "$COLD_ENTRY_TEST_SHA" ) ]] || return 94
  printf 'major-market-source-checked:%s\\n' "$1" >>"$COLD_ENTRY_TEST_LOG"
}
require_pair_release_admission_dispatch() {
  [[ "$#" == 1 && ( "$1" == origin/main || "$1" == refs/heads/main || "$1" == "$COLD_ENTRY_TEST_SHA" ) ]] || return 93
  printf 'pair-admission-source-checked:%s\\n' "$1" >>"$COLD_ENTRY_TEST_LOG"
}
require_deploy_lock() {
  [[ "\${FIXTURE_LOCK_OWNER:-}" == "$BASHPID" ]] || return 91
}
release_deploy_lock() {
  printf '%s\\n' lock-released >>"$COLD_ENTRY_TEST_LOG"
  FIXTURE_LOCK_OWNER=''
}
`,
  );
  const helper = join(directory, 'infra/scripts/lib/legacy-cold-maintenance.sh');
  if (missingHelper) {
    rmSync(helper, { force: true });
  } else {
    writeFileSync(
      helper,
      `
FIXTURE_AUTHORITY_CALLS=0
maxim_require_ordinary_effect_authority() {
  require_deploy_lock || return
  [[ "$1" == "$COLD_ENTRY_TEST_ROOT" ]] || return 92
  FIXTURE_AUTHORITY_CALLS=$((FIXTURE_AUTHORITY_CALLS + 1))
  printf '%s\\n' authority-checked >>"$COLD_ENTRY_TEST_LOG"
  if ((FIXTURE_AUTHORITY_CALLS > COLD_ENTRY_TEST_REJECT_AFTER)); then
    printf '%s\\n' 'cold fixture authority refused' >&2
    return 73
  fi
}
`,
    );
  }
  writeFileSync(
    join(bin, 'git'),
    `#!/usr/bin/env bash
set -euo pipefail
printf 'git:%s\\n' "$*" >>"$COLD_ENTRY_TEST_LOG"
case "$1" in
  show-ref)
    [[ "$*" == 'show-ref --verify --quiet refs/heads/main' ]] || exit 98
    [[ "$COLD_ENTRY_TEST_LOCAL_BRANCH" == 1 ]]
    exit $? ;;
  fetch|checkout|switch|pull)
    [[ "\${COLD_ENTRY_TEST_PLAN:-0}" == 1 ]] || exit 98
    exit 0 ;;
  status) exit 0 ;;
  branch) printf '%s\\n' main; exit 0 ;;
  rev-parse) printf '%s\\n' "$COLD_ENTRY_TEST_SHA"; exit 0 ;;
esac
exec /usr/bin/git -C "$COLD_ENTRY_TEST_SOURCE_ROOT" "$@"
`,
  );
  writeFileSync(
    join(bin, 'node'),
    `#!/usr/bin/env bash
set -euo pipefail
printf 'node:%s\\n' "$*" >>"$COLD_ENTRY_TEST_LOG"
if [[ "\${1:-}" == '-e' || "\${1:-}" == '-p' ]]; then
  exec "$COLD_ENTRY_TEST_NODE" "$@"
fi
if [[ "\${COLD_ENTRY_TEST_PLAN:-0}" == 1 || "\${COLD_ENTRY_TEST_READONLY:-0}" == 1 ]]; then
  exit 3
fi
printf '%s\\n' 'unexpected store or manifest client' >&2
exit 98
`,
  );
  writeFileSync(
    join(bin, 'docker'),
    `#!/usr/bin/env bash
set -euo pipefail
printf 'docker:%s\\n' "$*" >>"$COLD_ENTRY_TEST_LOG"
case "$*" in
  'context show') printf '%s\\n' default; exit 0 ;;
  'context inspect default --format {{.Endpoints.docker.Host}}')
    printf '%s\\n' unix:///var/run/docker.sock; exit 0 ;;
esac
case " $* " in
  *' ps '*|*' inspect '*|*' config '*|*' system df ')
    if [[ "$*" == *' ps '*'-q api-admin'* ]]; then printf '%064d\\n' 1; fi
    exit 0 ;;
esac
printf '%s\\n' 'unexpected Docker mutation or application client' >&2
exit 98
`,
  );
  writeFileSync(
    join(bin, 'hostname'),
    `#!/usr/bin/env bash
set -euo pipefail
[[ "$*" == -I ]] || exit 98
printf '%s\\n' hostname-read >>"$COLD_ENTRY_TEST_LOG"
printf '%s\\n' 192.0.2.40
`,
  );
  writeFileSync(
    join(bin, 'npm'),
    '#!/bin/sh\nprintf "npm:%s\\n" "$*" >>"$COLD_ENTRY_TEST_LOG"\nexit 98\n',
  );
  for (const command of ['git', 'node', 'docker', 'hostname', 'npm'])
    chmodSync(join(bin, command), 0o755);
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    MAXIM_ALLOW_LEGACY_DEPLOY: '1',
    MAXIM_ALLOW_SCALE_DEPLOY: '1',
    MAXIM_EXPECTED_DEPLOY_SHA: sourceSha,
    COLD_ENTRY_TEST_LOG: log,
    COLD_ENTRY_TEST_NODE: process.execPath,
    COLD_ENTRY_TEST_ROOT: directory,
    COLD_ENTRY_TEST_SOURCE_ROOT: root,
    COLD_ENTRY_TEST_SHA: sourceSha,
    COLD_ENTRY_TEST_REJECT_AFTER: String(rejectAfter),
    COLD_ENTRY_TEST_LOCAL_BRANCH: localBranchExists ? '1' : '0',
  };
  return {
    directory,
    env,
    readLog: () => {
      try {
        return readFileSync(log, 'utf8');
      } catch {
        return '';
      }
    },
    run: (name, args = [], extra = {}) =>
      spawnSync('bash', [join(directory, 'infra/scripts', name), ...args], {
        cwd: directory,
        env: {
          ...env,
          ...(name === 'vps-pull-build-up-scale.sh' ? scaleHostEnvironment(directory) : {}),
          ...extra,
        },
        encoding: 'utf8',
        timeout: 15_000,
      }),
    runBody: (body) =>
      spawnSync(
        'bash',
        [
          '-c',
          `set -euo pipefail
ROOT_DIR="$COLD_ENTRY_TEST_ROOT"
source "$ROOT_DIR/infra/scripts/lib/deploy-lock.sh"
source "$ROOT_DIR/infra/scripts/lib/legacy-cold-maintenance.sh"
acquire_deploy_lock
${body}`,
        ],
        { cwd: directory, env, encoding: 'utf8', timeout: 10_000 },
      ),
    cleanup: () => rmSync(directory, { recursive: true, force: true }),
  };
}

function assertNoMutations(log) {
  assert.doesNotMatch(
    log,
    /git:(?:fetch|checkout|switch|pull)|npm:|docker:.*\b(?:up|start|restart|stop|down|run|rm|pull|build|pause|unpause)\b/u,
  );
  assert.doesNotMatch(
    log,
    /node:.*(?:release-manifest|migration-recovery|release-image-reclaim|supervisor)/u,
  );
}

for (const [name, args] of scripts) {
  test(`${name} refuses under the lock before any ordinary mutation`, () => {
    const state = fixture();
    try {
      const result = state.run(name, args);
      assert.equal(result.status, 73, `${result.stdout}\n${result.stderr}`);
      assert.match(result.stderr, /cold fixture authority refused/u);
      const log = state.readLog();
      assert.match(log, /lock-acquired\nauthority-checked\n/u);
      assert.match(log, /lock-released/u);
      assertNoMutations(log);
    } finally {
      state.cleanup();
    }
  });

  test(`${name} refuses a missing compatible authority helper before tools`, () => {
    const state = fixture({ missingHelper: true });
    try {
      const result = state.run(name, args);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /legacy-cold-maintenance\.sh/u);
      assert.equal(state.readLog(), '');
    } finally {
      state.cleanup();
    }
  });
}

for (const localBranchExists of [true, false]) {
  test(`deploy plan synchronizes source without runtime effects (local branch: ${localBranchExists})`, () => {
    const state = fixture({ localBranchExists });
    try {
      const result = state.run('vps-pull-build-up.sh', ['main', '--plan'], {
        COLD_ENTRY_TEST_PLAN: '1',
      });
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}\n${state.readLog()}`);
      const log = state.readLog();
      assert.match(log, /git:fetch/u);
      assert.equal(
        (log.match(/market-statistics-source-checked/gu) ?? []).length,
        localBranchExists ? 2 : 1,
      );
      assert.equal(
        (log.match(/pair-admission-source-checked:/gu) ?? []).length,
        localBranchExists ? 2 : 1,
      );
      const checkedRefs = localBranchExists ? ['origin/main', 'refs/heads/main'] : ['origin/main'];
      assert.deepEqual(
        [...log.matchAll(/^major-market-source-checked:(.+)$/gmu)].map((match) => match[1]),
        checkedRefs,
      );
      for (const ref of checkedRefs) {
        assert.ok(
          log.indexOf(`major-market-source-checked:${ref}\n`) < log.indexOf('git:checkout '),
          `Major/Market source ${ref} must be checked before checkout`,
        );
      }
      assert.match(log, /pair-admission-source-checked:origin\/main\n/u);
      assert.match(
        log,
        localBranchExists ? /git:checkout main\n/u : /git:checkout -b main origin\/main\n/u,
      );
      assert.doesNotMatch(
        log,
        /authority-checked|npm:|docker:.*\b(?:up|run|start|stop|build|rm)\b/u,
      );
      assert.equal(readFileSync(join(state.directory, '.env'), 'utf8'), 'NODE_ENV=production\n');
    } finally {
      state.cleanup();
    }
  });
}

test('reclaim dry run reaches only the read-only inventory path without ordinary effect admission', () => {
  const state = fixture();
  try {
    const result = state.run('vps-docker-space-reclaim.sh', ['--dry-run'], {
      COLD_ENTRY_TEST_READONLY: '1',
    });
    assert.equal(result.status, 3, result.stderr);
    assert.match(state.readLog(), /release-image-reclaim\.mjs reclaim .*--dry-run/u);
    assert.doesNotMatch(
      state.readLog(),
      /authority-checked|docker:.*\b(?:rm|up|start|stop|run)\b/u,
    );
  } finally {
    state.cleanup();
  }
});

const guardedFunctions = {
  'vps-pull-build-up.sh': [
    'begin_release_runtime_transition',
    'record_successful_release',
    'recreate_service_wave',
    'run_migrations',
  ],
  'vps-pull-build-up-scale.sh': ['recreate_service_wave', 'run_migrations'],
  'vps-runtime-rollback.sh': [
    'begin_runtime_rollback_transition',
    'record_runtime_rollback_release',
    'recreate_runtime_api_wave',
  ],
  'vps-release-rollback.sh': ['begin_release_runtime_transition', 'recreate_service'],
  'vps-finalize-release-recovery.sh': ['commit_recovered_release'],
  'vps-commercial-ocr-rollout.sh': [
    'recover_shadow',
    'recreate_service',
    'recreate_recovery_service',
    'start_ocr_producers',
    'apply_control',
    'clear_control',
  ],
  'vps-publisher-dispatch-rollout.sh': [
    'apply_rollout',
    'recreate_all_api_roles',
    'clear_operator_pause',
  ],
  'vps-retire-legacy-default-webhook-queue.sh': ['restore_enqueue_service', 'apply_retirement'],
};

for (const [name, functions] of Object.entries(guardedFunctions)) {
  for (const fn of functions) {
    test(`${name} ${fn} rechecks authority after earlier admission, even in a conditional caller`, () => {
      const state = fixture({ rejectAfter: 1 });
      try {
        const result = state.runBody(`
maxim_require_ordinary_effect_authority "$ROOT_DIR"
${functionBlock(readScript(name), fn)}
if ${fn} api-ingress 60; then exit 99; else exit "$?"; fi
`);
        assert.equal(result.status, 73, result.stderr);
        assert.equal((state.readLog().match(/authority-checked/gu) ?? []).length, 2);
        assertNoMutations(state.readLog());
      } finally {
        state.cleanup();
      }
    });
  }
}

test('failed OCR cleanup does not restart roles after authority is revoked and retains original error', () => {
  const state = fixture({ rejectAfter: 1 });
  try {
    const script = readScript('vps-commercial-ocr-rollout.sh');
    const result = state.runBody(`
maxim_require_ordinary_effect_authority "$ROOT_DIR"
${functionBlock(script, 'recover_shadow')}
${functionBlock(script, 'cleanup')}
quiesce_recovery_services() { printf '%s\\n' unexpected-quiescence >>"$COLD_ENTRY_TEST_LOG"; }
patch_env_shadow() { printf '%s\\n' unexpected-env-mutation >>"$COLD_ENTRY_TEST_LOG"; }
recreate_all_roles_best_effort() { printf '%s\\n' unexpected-restart >>"$COLD_ENTRY_TEST_LOG"; }
APPLY=1 RECOVERY_ARMED=1 ROLLOUT_COMPLETE=0 RECOVERY_QUIESCENCE_PROVEN=0
COHORT_FILE='' CONTROL_FILE='' CONTROL_OUTPUT_FILE='' CERTIFICATION_VERIFICATION_FILE=''
trap cleanup EXIT
exit 23
`);
    assert.equal(result.status, 23, result.stderr);
    assert.match(result.stderr, /cold fixture authority refused/u);
    assert.doesNotMatch(state.readLog(), /unexpected-/u);
    assert.match(state.readLog(), /lock-released/u);
  } finally {
    state.cleanup();
  }
});

test('both deploy reexec dependency lists include the authority helper', () => {
  for (const name of ['vps-pull-build-up.sh', 'vps-pull-build-up-scale.sh']) {
    assert.match(
      functionBlock(readScript(name), 'reexec_if_current_script_changed'),
      /infra\/scripts\/lib\/legacy-cold-maintenance\.sh/u,
    );
  }
});
