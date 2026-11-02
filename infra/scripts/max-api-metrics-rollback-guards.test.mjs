import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { deployLockEnvironment, deployLockFixture } from './test-fixtures/deploy-lock.mjs';

const root = resolve(import.meta.dirname, '../..');
const paths = {
  counter: 'apps/api/src/max/max-api-counter-storage.ts',
  consumer: 'apps/api/src/system/max-api-metrics.service.ts',
  keys: 'apps/api/src/max/max-api-metrics-key.util.ts',
};
const minuteReaderMarker = 'maxim_topology_require_max_api_metrics_minute_reader';
const apiAuthorityMarker = 'maxim_topology_require_local_chat_ban_reader';
const apiRecoveryMarker = 'maxim_topology_require_statistics_and_night_mode_recovery';
const previousReleaseMarker = 'select_release_recovery_base';
const connect = readFileSync(resolve(root, 'infra/scripts/vps-connect.sh'), 'utf8');
const pairAdmissionSources = [
  'infra/scripts/lib/pair-release-admission.sh',
  'infra/scripts/lib/deploy-lock.sh',
  'infra/scripts/vps-pull-build-up.sh',
  'infra/scripts/vps-runtime-rollback.sh',
  'infra/scripts/vps-connect.sh',
];

function functionBlock(name, source = connect) {
  const start = source.indexOf(`${name}() {`);
  assert.notEqual(start, -1, `Missing shell function: ${name}`);
  const end = source.indexOf('\n}\n', start);
  assert.notEqual(end, -1, `Unterminated shell function: ${name}`);
  return source.slice(start, end + 2);
}

function wrapperMarker(name, args) {
  const result = spawnSync(
    'bash',
    [
      '-c',
      `
    set -euo pipefail
    ${functionBlock(name)}
    build_guarded_rollback_command() {
      local -n result="$1"
      result="$3"
    }
    prepend_webhook_rollout_recovery_env() { :; }
    remote_exec() { printf '%s\\n' "$1"; }
    ${name} "$@"
  `,
      'rollback-wrapper-marker-test',
      ...args,
    ],
    { encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function bootstrapProbe(t, { name, args, current = false, previousMarker, gitMode = 'reviewed' }) {
  const directory = mkdtempSync(join(tmpdir(), 'maxim-metric-reader-bootstrap-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const entrypoint = join(directory, 'entrypoint.sh');
  const currentEntrypoint = join(directory, 'current-entrypoint.sh');
  const gitLog = join(directory, 'git.log');
  const argumentLog = join(directory, 'arguments.log');
  const lock = deployLockFixture(directory, join(directory, 'infra/scripts/lib/deploy-lock.sh'));
  writeFileSync(
    join(directory, 'infra/scripts/lib/legacy-cold-maintenance.sh'),
    'maxim_require_ordinary_effect_authority() { require_deploy_lock; }\n',
  );
  const makeEntrypoint = (marker, label) => `
    #!/usr/bin/env bash
    # ${marker}
    require_deploy_lock
    printf '%s\\n' "$@" > "$MAXIM_TEST_ARGUMENT_LOG"
    printf '${label}\\n'
  `;
  writeFileSync(gitLog, '');
  writeFileSync(currentEntrypoint, makeEntrypoint(apiAuthorityMarker, 'current'), { mode: 0o700 });
  writeFileSync(
    entrypoint,
    makeEntrypoint(
      current
        ? apiAuthorityMarker
        : (previousMarker ??
            (name === 'rollback_runtime'
              ? 'select_runtime_rollback_recovery_base'
              : previousReleaseMarker)),
      current ? 'current' : 'previous',
    ),
    { mode: 0o700 },
  );
  const declaration = connect.indexOf('rollback_entrypoint_bootstrap_source() {');
  assert.notEqual(declaration, -1);
  const opening = "  cat <<'BOOTSTRAP'\n";
  const openingIndex = connect.indexOf(opening, declaration);
  assert.notEqual(openingIndex, -1);
  const start = openingIndex + opening.length;
  const end = connect.indexOf('\nBOOTSTRAP\n}', start);
  assert.notEqual(end, -1);
  const productionBootstrap = connect.slice(start, end);
  // The production bootstrap sources the real protected helper relocated only
  // inside this disposable fixture; no production lock-path override exists.
  const bootstrap = productionBootstrap;
  const result = spawnSync(
    'bash',
    [
      '-c',
      `
    git() {
      printf '%s\\n' "$*" >> "$MAXIM_TEST_GIT_LOG"
      if [[ "$MAXIM_TEST_GIT_MODE" == forbidden ]]; then
        echo "Unexpected Git access on offline rollback" >&2
        return 99
      fi
      case "$*" in
        'status --porcelain --untracked-files=no')
          if [[ "$MAXIM_TEST_GIT_MODE" == dirty ]]; then printf ' M tracked-file\\n'; fi
          ;;
        'cat-file -e reviewed^{commit}')
          [[ "$MAXIM_TEST_GIT_MODE" != missing ]]
          ;;
        'rev-parse --verify refs/heads/main')
          if [[ "$MAXIM_TEST_GIT_MODE" == wrong-main ]]; then printf 'different\\n'; else printf 'reviewed\\n'; fi
          ;;
        ${pairAdmissionSources.map((path) => `'show reviewed:${path}'`).join('|')})
          if [[ "$MAXIM_TEST_GIT_MODE" == missing-pair-admission && "$2" == reviewed:infra/scripts/lib/pair-release-admission.sh ]]; then
            printf '# target predates pair admission\\n'
          else
            cat "$MAXIM_TEST_SOURCE_ROOT/\${2#*:}"
          fi
          ;;
        'checkout main') cp "$MAXIM_TEST_CURRENT_ENTRYPOINT" "$MAXIM_TEST_ENTRYPOINT" ;;
        'rev-parse HEAD') printf 'reviewed\\n' ;;
        *) echo "Unexpected bootstrap Git operation" >&2; return 99 ;;
      esac
    }
    ${bootstrap}
  `,
      'rollback-bootstrap-test',
      'reviewed',
      entrypoint,
      wrapperMarker(name, args),
      ...args,
    ],
    {
      cwd: directory,
      env: deployLockEnvironment({
        MAXIM_TEST_CURRENT_ENTRYPOINT: currentEntrypoint,
        MAXIM_TEST_ENTRYPOINT: entrypoint,
        MAXIM_TEST_GIT_LOG: gitLog,
        MAXIM_TEST_ARGUMENT_LOG: argumentLog,
        MAXIM_TEST_GIT_MODE: gitMode,
        MAXIM_TEST_SOURCE_ROOT: root,
      }),
      encoding: 'utf8',
    },
  );
  assert.equal(existsSync(lock.file), true, 'The protected inode survives bootstrap cleanup');
  const unlocked = spawnSync('flock', ['-n', lock.file, 'true']);
  assert.equal(unlocked.status, 0, 'Bootstrap must close its owned lock descriptor');
  return {
    result,
    gitCalls: readFileSync(gitLog, 'utf8').trim().split('\n').filter(Boolean),
    arguments: existsSync(argumentLog)
      ? readFileSync(argumentLog, 'utf8').trimEnd().split('\n')
      : null,
  };
}

function probe(t, overrides = {}, selectApi = true) {
  const directory = mkdtempSync(join(tmpdir(), 'maxim-metric-reader-floor-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  for (const [name, path] of Object.entries(paths)) {
    if (overrides[name] === null) continue;
    const file = join(directory, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, overrides[name] ?? readFileSync(resolve(root, path), 'utf8'));
  }
  return spawnSync(
    'bash',
    [
      '-c',
      `
    set -euo pipefail
    source "$MAXIM_TEST_ROOT/infra/scripts/lib/deploy-topology.sh"
    git() {
      if [[ "$MAXIM_TEST_SELECT_API" != 1 ]]; then
        echo "Static rollback attempted Git access" >&2
        return 1
      fi
      [[ "$1" == show && "$2" == target:* ]] || return 1
      cat "$MAXIM_TEST_SOURCE_ROOT/\${2#*:}"
    }
    docker() { echo "Unexpected Docker access from source floor" >&2; return 1; }
    if [[ "$MAXIM_TEST_SELECT_API" == 1 ]]; then
      maxim_topology_require_max_api_metrics_minute_reader target
    fi
  `,
    ],
    {
      cwd: root,
      env: {
        ...process.env,
        MAXIM_TEST_ROOT: root,
        MAXIM_TEST_SOURCE_ROOT: directory,
        MAXIM_TEST_SELECT_API: selectApi ? '1' : '0',
      },
      encoding: 'utf8',
    },
  );
}

test('accepts compatible readers independently of writer defaults or environment downgrade', (t) => {
  // The source floor reads only counter/consumer/key capability files; it does not
  // require the activation release default and therefore accepts the first release.
  const result = probe(t);
  assert.equal(result.status, 0, result.stderr);
});

test('missing capability fails closed before any runtime operation', (t) => {
  const result = probe(t, { counter: null });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /predates the MAX API minute metric reader/u);
});

for (const [name, before, after] of [
  [
    'counter',
    'MAX_API_METRICS_MINUTE_READER_VERSION = 1',
    'MAX_API_METRICS_MINUTE_READER_VERSION = 0',
  ],
  [
    'counter',
    'export async function readMaxApiMetricCounts',
    'async function readMaxApiMetricCounts',
  ],
  ['counter', 'await redis.mget(...chunk)', 'await redis.mget()'],
  ['counter', 'pipeline.hmget(key, ...entries.map((entry) => entry.field))', 'pipeline.hmget(key)'],
  [
    'counter',
    'counts.set(entry.legacyKey, (counts.get(entry.legacyKey) ?? 0) + count)',
    'counts.set(entry.legacyKey, count)',
  ],
  [
    'consumer',
    'return readMaxApiMetricCounts(this.redis, keys);',
    'return this.redis.mget(...keys);',
  ],
  [
    'consumer',
    'currentBatch.map((entry) => entry.key)',
    'currentBatch.map((entry) => entry.oldKey)',
  ],
  ['consumer', "from '../max/max-api-counter-storage'", "from '../max/missing-counter-storage'"],
  ['keys', 'maxApiLegacyCounterMinute(key)', 'null'],
]) {
  test(`rejects broken ${name} reader capability: ${before}`, (t) => {
    const source = readFileSync(resolve(root, paths[name]), 'utf8');
    assert.ok(source.includes(before), `Missing mutation anchor: ${before}`);
    const result = probe(t, { [name]: source.replaceAll(before, after) });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /lacks the wired MAX API minute metric reader/u);
  });
}

test('static-only selection never invokes the reader floor, Git, or Docker', (t) => {
  const result = probe(t, { counter: null, consumer: null, keys: null }, false);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
});

test('immutable source floor selects the API component source before transition mutation', () => {
  const script = readFileSync(resolve(root, 'infra/scripts/vps-release-rollback.sh'), 'utf8');
  const call = '  maxim_topology_require_max_api_metrics_minute_reader "$API_SOURCE_SHA"';
  const callIndex = script.indexOf(call);
  assert.ok(callIndex > 0);
  assert.equal(script.indexOf(call, callIndex + call.length), -1);
  const blockStart = script.lastIndexOf('if [[ "$SELECT_API" -eq 1 ]]; then', callIndex);
  const blockEnd = script.indexOf('\nfi\n', callIndex) + 4;
  assert.ok(blockStart >= 0 && blockEnd > callIndex);
  const block = script.slice(blockStart, blockEnd);
  assert.ok(block.includes('API_SOURCE_SHA="${COMPONENT_SOURCE_SHA[api-shared]}"'));
  assert.ok(callIndex < script.indexOf('\nbegin_release_runtime_transition\n'));

  // Execute the actual preflight block with static-only selection and fail if
  // any of its Git, command, Docker or source-floor branches become unconditional.
  const result = spawnSync(
    'bash',
    [
      '-c',
      `
    set -euo pipefail
    source "$MAXIM_TEST_ROOT/infra/scripts/lib/deploy-topology.sh"
    git() { echo "Unexpected static Git access" >&2; return 1; }
    require_command() { echo "Unexpected static command preflight" >&2; return 1; }
    docker() { echo "Unexpected static Docker access" >&2; return 1; }
    maxim_topology_require_max_api_metrics_minute_reader() { echo "Unexpected static reader floor" >&2; return 1; }
    SELECT_API=0
    ${block}
  `,
    ],
    { env: { ...process.env, MAXIM_TEST_ROOT: root }, encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
});

test('ref source floor checks the exact target before Git switch, image build, or runtime transition', () => {
  const script = readFileSync(resolve(root, 'infra/scripts/vps-runtime-rollback.sh'), 'utf8');
  const call = 'maxim_topology_require_max_api_metrics_minute_reader "$TARGET_FULL_SHA"';
  const callIndex = script.indexOf(call);
  assert.ok(callIndex > 0);
  assert.equal(script.indexOf(call, callIndex + call.length), -1);
  assert.ok(script.indexOf('TARGET_FULL_SHA="$(git rev-parse') < callIndex);
  for (const mutation of [
    '\ngit switch --detach "$TARGET_FULL_SHA"',
    '\nmaxim_topology_build_shared_api_image "$ROLLBACK_API_IMAGE"',
    '\nbegin_runtime_rollback_transition\n',
    '\nmaxim_webhook_quiesce_for_api_rollout COMPOSE_FILES',
  ]) {
    assert.ok(script.indexOf(mutation) > callIndex, `Floor must precede ${mutation}`);
  }
});

test('combined API recovery checks both exact source floors and refuses either failure without errexit', () => {
  const topology = readFileSync(resolve(root, 'infra/scripts/lib/deploy-topology.sh'), 'utf8');
  for (const [statisticsStatus, nightStatus, expectedStatus, expectedCalls] of [
    [17, 0, 17, ['statistics exact-sha']],
    [0, 23, 23, ['statistics exact-sha', 'night exact-sha']],
    [0, 0, 0, ['statistics exact-sha', 'night exact-sha', 'RUNTIME_ALLOWED']],
  ]) {
    const result = spawnSync(
      'bash',
      [
        '-c',
        `set -uo pipefail
maxim_topology_require_statistics_authority_lifecycle() { printf 'statistics %s\\n' "$1"; return ${statisticsStatus}; }
maxim_topology_require_night_mode_recovery_reader() { printf 'night %s\\n' "$1"; return ${nightStatus}; }
${functionBlock(apiRecoveryMarker, topology)}
${apiRecoveryMarker} exact-sha && printf 'RUNTIME_ALLOWED\\n'
`,
      ],
      { encoding: 'utf8' },
    );
    assert.equal(result.status, expectedStatus, result.stderr);
    assert.deepEqual(result.stdout.trim().split('\n'), expectedCalls);
  }
});

for (const [name, args, expected] of [
  ['rollback_runtime', ['compatibility-sha', 'api-action'], apiAuthorityMarker],
  ['rollback_release', ['release-id'], apiAuthorityMarker],
  ['rollback_release', ['release-id', 'api-shared'], apiAuthorityMarker],
  ['rollback_release', ['release-id', 'admin-static', 'api-shared'], apiAuthorityMarker],
  ['rollback_release', ['release-id', 'miniapp-major-static'], previousReleaseMarker],
  [
    'rollback_release',
    ['release-id', 'admin-static', 'miniapp-major-static'],
    previousReleaseMarker,
  ],
]) {
  test(`${name} selects the required bootstrap capability for ${args.join(' ')}`, () => {
    assert.equal(wrapperMarker(name, args), expected);
  });
}

for (const [name, args] of [
  ['rollback_runtime', ['compatibility-sha', 'api-action']],
  ['rollback_release', ['release-id', 'admin-static', 'api-shared']],
]) {
  for (const [description, previousMarker] of [
    ['lifecycle-only', 'maxim_topology_require_statistics_authority_lifecycle'],
    ['night-mode-only', 'maxim_topology_require_night_mode_recovery_reader'],
  ]) {
    test(`${name} upgrades ${description} tooling before either recovery floor can be bypassed`, (t) => {
      const probe = bootstrapProbe(t, { name, args, previousMarker });
      assert.equal(probe.result.status, 0, probe.result.stderr);
      assert.equal(probe.result.stdout, 'current\n');
      assert.deepEqual(probe.arguments, args);
      assert.ok(probe.gitCalls.includes('checkout main'));
    });
  }

  test(`${name} restores reviewed tooling when the previous guarded entrypoint lacks the authority floor`, (t) => {
    const probe = bootstrapProbe(t, { name, args });
    assert.equal(probe.result.status, 0, probe.result.stderr);
    assert.equal(probe.result.stdout, 'current\n');
    assert.deepEqual(probe.arguments, args);
    assert.deepEqual(probe.gitCalls, [
      'status --porcelain --untracked-files=no',
      'cat-file -e reviewed^{commit}',
      'rev-parse --verify refs/heads/main',
      ...pairAdmissionSources.map((path) => `show reviewed:${path}`),
      'checkout main',
      'rev-parse HEAD',
    ]);
  });

  test(`${name} upgrades minute-reader tooling before API rollback with pending multibot journals`, (t) => {
    const probe = bootstrapProbe(t, { name, args, previousMarker: minuteReaderMarker });
    assert.equal(probe.result.status, 0, probe.result.stderr);
    assert.equal(probe.result.stdout, 'current\n');
    assert.deepEqual(probe.arguments, args);
    assert.ok(probe.gitCalls.includes('checkout main'));
  });

  test(`${name} upgrades legacy AI tooling before rollback with retained pool sources`, (t) => {
    const probe = bootstrapProbe(t, {
      name,
      args,
      previousMarker: 'maxim_topology_require_commercial_ai_delete_guard',
    });
    assert.equal(probe.result.status, 0, probe.result.stderr);
    assert.equal(probe.result.stdout, 'current\n');
    assert.deepEqual(probe.arguments, args);
    assert.ok(probe.gitCalls.includes('checkout main'));
  });

  test(`${name} upgrades pool-reader tooling before rollback with superseded statistics authorities`, (t) => {
    const probe = bootstrapProbe(t, {
      name,
      args,
      previousMarker: 'maxim_topology_require_commercial_ai_pool_delete_reader',
    });
    assert.equal(probe.result.status, 0, probe.result.stderr);
    assert.equal(probe.result.stdout, 'current\n');
    assert.deepEqual(probe.arguments, args);
    assert.ok(probe.gitCalls.includes('checkout main'));
  });

  test(`${name} upgrades fixed-moderator tooling before rollback with installed network journals`, (t) => {
    const probe = bootstrapProbe(t, {
      name,
      args,
      previousMarker: 'maxim_topology_require_fixed_moderator',
    });
    assert.equal(probe.result.status, 0, probe.result.stderr);
    assert.equal(probe.result.stdout, 'current\n');
    assert.deepEqual(probe.arguments, args);
    assert.ok(probe.gitCalls.includes('checkout main'));
  });

  test(`${name} upgrades scalar-only network tooling before rollback with retained list intents`, (t) => {
    const probe = bootstrapProbe(t, {
      name,
      args,
      previousMarker: 'maxim_topology_require_managed_network_foundation',
    });
    assert.equal(probe.result.status, 0, probe.result.stderr);
    assert.equal(probe.result.stdout, 'current\n');
    assert.deepEqual(probe.arguments, args);
    assert.ok(probe.gitCalls.includes('checkout main'));
  });

  test(`${name} stays offline when the checked-out entrypoint already retains the authority floor`, (t) => {
    const probe = bootstrapProbe(t, { name, args, current: true, gitMode: 'forbidden' });
    assert.equal(probe.result.status, 0, probe.result.stderr);
    assert.equal(probe.result.stdout, 'current\n');
    assert.deepEqual(probe.arguments, args);
    assert.deepEqual(probe.gitCalls, []);
  });
}

test('static-only rollback remains offline with the previous guarded entrypoint', (t) => {
  const args = ['release-id', 'admin-static', 'miniapp-major-static'];
  const probe = bootstrapProbe(t, { name: 'rollback_release', args, gitMode: 'forbidden' });
  assert.equal(probe.result.status, 0, probe.result.stderr);
  assert.equal(probe.result.stdout, 'previous\n');
  assert.deepEqual(probe.arguments, args);
  assert.deepEqual(probe.gitCalls, []);
});

for (const [gitMode, error] of [
  ['dirty', /VPS worktree has tracked changes/u],
  ['missing', /Reviewed rollback tooling commit is not retained/u],
  ['wrong-main', /Retained VPS main does not match the reviewed/u],
]) {
  test(`authority floor bootstrap preserves the ${gitMode} tooling synchronization rejection`, (t) => {
    const probe = bootstrapProbe(t, {
      name: 'rollback_release',
      args: ['release-id'],
      gitMode,
    });
    assert.notEqual(probe.result.status, 0);
    assert.match(probe.result.stderr, error);
    assert.equal(probe.arguments, null, 'Rejected bootstrap must never source the entrypoint');
    assert.ok(!probe.gitCalls.includes('checkout main'));
  });
}

test('reviewed tooling without pair admission refuses before source checkout or entrypoint', (t) => {
  const probe = bootstrapProbe(t, {
    name: 'rollback_release',
    args: ['release-id'],
    gitMode: 'missing-pair-admission',
  });
  assert.notEqual(probe.result.status, 0);
  assert.equal(probe.arguments, null);
  assert.ok(probe.gitCalls.includes('show reviewed:infra/scripts/lib/pair-release-admission.sh'));
  assert.ok(!probe.gitCalls.includes('checkout main'));
});
