import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import {
  beginReleaseTransition,
  buildReleaseManifest,
  commitReleaseManifest,
} from './release-manifest.mjs';

const root = resolve(import.meta.dirname, '../..');
const finalizerPath = resolve(root, 'infra/scripts/vps-finalize-release-recovery.sh');

function read(path) {
  return readFileSync(resolve(root, path), 'utf8');
}

function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function functionBlock(script, name) {
  const start = script.indexOf(`${name}() {`);
  assert.notEqual(start, -1, `Missing shell function: ${name}`);
  const end = script.indexOf('\n}\n', start);
  assert.notEqual(end, -1, `Unterminated shell function: ${name}`);
  return script.slice(start, end + 2);
}

function runSourced(body) {
  return spawnSync(
    'bash',
    [
      '-c',
      `set -euo pipefail
export MAXIM_EXPECTED_DEPLOY_SHA=${'a'.repeat(40)}
source ${JSON.stringify(finalizerPath)}
${body}`,
    ],
    { encoding: 'utf8', cwd: root },
  );
}

test('finalizer is syntax-valid and contains no runtime lifecycle, build, or migration command', () => {
  const finalizer = read('infra/scripts/vps-finalize-release-recovery.sh');
  const normalizedFinalizer = finalizer.replace(/\\\r?\n[ \t]*/gu, ' ');
  execFileSync('bash', ['-n', finalizerPath]);

  assert.match(finalizer, /source "\$ROOT_DIR\/infra\/scripts\/lib\/deploy-lock\.sh"/u);
  assert.match(finalizer, /acquire_deploy_lock/u);
  assert.match(finalizer, /release_manifest recovery-base/u);
  assert.match(finalizer, /verify_runtime_snapshot/u);
  assert.match(finalizer, /assert_webhook_queue_fence_released/u);
  assert.match(finalizer, /maxim_topology_smoke_media_analysis_tesseract COMPOSE_FILES required/u);
  assert.match(finalizer, /release_manifest archive-transition/u);
  assert.doesNotMatch(
    normalizedFinalizer,
    /\bdocker\s+compose\b[^\n]*\b(?:up|build|run|create|start|stop|restart|kill|rm|down|pause|unpause|pull)\b/u,
  );
  assert.doesNotMatch(
    normalizedFinalizer,
    /\bdocker\s+(?:build|buildx|create|start|restart|stop|kill|rm|rmi|pull)\b/u,
  );
  assert.doesNotMatch(normalizedFinalizer, /\bdocker\s+image\s+(?:rm|pull)\b/u);
  assert.doesNotMatch(normalizedFinalizer, /\bforce-recreate\b/u);
  assert.doesNotMatch(normalizedFinalizer, /\bprisma\s+migrate\b/iu);
});

test('finalizer binds every active component to the target ref and re-proves strict smokes', () => {
  const finalizer = read('infra/scripts/vps-finalize-release-recovery.sh');
  const runtime = functionBlock(finalizer, 'inspect_service_runtime');
  const resolveImages = functionBlock(finalizer, 'resolve_target_images');
  const smokes = functionBlock(finalizer, 'run_strict_finalizer_smokes');
  const commit = functionBlock(finalizer, 'commit_recovered_release');
  const main = functionBlock(finalizer, 'main');

  assert.match(finalizer, /api-shared\) printf 'maxim-api:%s' "\$component_source"/u);
  assert.match(
    finalizer,
    /miniapp-major-static\) printf 'maxim-miniapp-major:%s' "\$component_source"/u,
  );
  assert.match(finalizer, /admin-static\) printf 'maxim-admin:%s' "\$component_source"/u);
  assert.match(runtime, /\{\{\.Config\.Image\}\}.*\{\{\.Image\}\}/u);
  assert.match(runtime, /"\$image_ref" == "\$expected_ref"/u);
  assert.match(runtime, /"\$image_id" == "\$expected_id"/u);
  assert.match(finalizer, /for service in "\$\{MAXIM_PRODUCTION_API_SERVICES\[@\]\}"/u);
  assert.match(finalizer, /commercial-ocr-runtime-inventory\.mjs/u);
  assert.match(finalizer, /maxim_topology_ocr_services_for_compose/u);
  assert.match(finalizer, /maxim_topology_verify_ocr_native_sandbox_runtime/u);
  assert.match(finalizer, /reviewedAuxiliaryCount === value\.expectedAuxiliaryCount/u);

  for (const endpoint of [
    'http://127.0.0.1:3001/api/health/live',
    'http://127.0.0.1:3001/api/health/ready',
    'http://127.0.0.1:3002/api/health/live',
    'http://127.0.0.1:3002/api/health/ready',
    'http://127.0.0.1:3003/app/',
    'http://127.0.0.1:3004/',
  ]) {
    assert.match(smokes, new RegExp(endpoint.replaceAll('/', '\\/'), 'u'), endpoint);
  }
  assert.match(smokes, /"\$PUBLIC_HEALTH_URL\/api\/health\/live"/u);
  assert.match(smokes, /"\$PUBLIC_HEALTH_URL\/app\/"/u);
  assert.match(smokes, /maxim_topology_verify_api_commercial_ocr_version/u);
  assert.match(
    smokes,
    /maxim_topology_smoke_media_analysis_tesseract COMPOSE_FILES required sandbox/u,
  );

  assert.match(
    resolveImages,
    /FINALIZER_COMPONENTS=\(api-shared miniapp-major-static admin-static\)/u,
  );
  assert.match(resolveImages, /FINALIZER_COMPONENTS\+=\(eraser\)/u);
  assert.match(commit, /for component in "\$\{FINALIZER_COMPONENTS\[@\]\}"/u);
  assert.match(
    commit,
    /\$\{component\}\|\$\{COMPONENT_SOURCE_SHA\[\$component\]:-\$EXPECTED_RUNTIME_SHA\}\|/u,
  );
  assert.match(commit, /--current-manifest-file "\$RECOVERY_BASE_MANIFEST"/u);
  assert.match(commit, /--migrations-file "\$MIGRATIONS_FILE"/u);
  assert.match(commit, /release_manifest archive-transition/u);
  assert.equal([...main.matchAll(/assert_webhook_queue_fence_released/gu)].length, 2);
  assert.ok(
    main.indexOf('run_strict_finalizer_smokes') < main.lastIndexOf('verify_runtime_snapshot'),
  );
  assert.ok(
    main.lastIndexOf('verify_runtime_snapshot') < main.indexOf('capture_applied_migrations'),
  );
  assert.ok(
    main.indexOf('capture_applied_migrations') <
      main.lastIndexOf('assert_webhook_queue_fence_released'),
  );
  assert.ok(
    main.lastIndexOf('assert_webhook_queue_fence_released') <
      main.indexOf('commit_recovered_release'),
  );
  assert.match(main, /"\$runtime_after" == "\$runtime_before"/u);
  assert.match(
    main,
    /acquire_deploy_lock(?: \|\| return(?: 1)?)?\n\s+trap finalizer_cleanup EXIT/u,
  );
});

test('migration snapshot is bounded, read-only, validated, and owner-only', () => {
  const finalizer = read('infra/scripts/vps-finalize-release-recovery.sh');

  assert.match(finalizer, /mktemp \/tmp\/maxim-release-finalizer-migrations\.XXXXXX/u);
  assert.match(finalizer, /chmod 0600 "\$MIGRATIONS_FILE"/u);
  assert.match(finalizer, /MAX_MIGRATIONS_FILE_BYTES=1048576/u);
  assert.match(finalizer, /timeout --foreground --kill-after=2s "\$\{COMMAND_TIMEOUT_SEC\}s"/u);
  assert.match(finalizer, /default_transaction_read_only=on/u);
  assert.match(finalizer, /statement_timeout=5s/u);
  assert.match(finalizer, /lock_timeout=500ms/u);
  assert.match(finalizer, /max_parallel_workers_per_gather=0/u);
  assert.match(finalizer, /psql -X --no-password -v ON_ERROR_STOP=1/u);
  assert.match(
    finalizer,
    /SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL ORDER BY migration_name;/u,
  );
  assert.match(finalizer, /\^\[0-9\]\{14\}_\[a-z0-9\]/u);

  const valid = runSourced(`
release_deploy_lock() { :; }
timeout() {
  printf '%s\\n' \\
    20260228000000_init \\
    20260301000000_add_max_message_length
}
trap finalizer_cleanup EXIT
capture_applied_migrations
printf 'mode=%s\\n' "$(stat -c '%a' "$MIGRATIONS_FILE")"
printf 'contents=%s\\n' "$(paste -sd, "$MIGRATIONS_FILE")"
`);
  assert.equal(valid.status, 0, valid.stderr);
  assert.equal(
    valid.stdout,
    'mode=600\ncontents=20260228000000_init,20260301000000_add_max_message_length\n',
  );

  for (const timeoutBody of ["printf '%s\\n' invalid-name", 'return 17']) {
    const invalid = runSourced(`
release_deploy_lock() { :; }
timeout() { ${timeoutBody}; }
trap finalizer_cleanup EXIT
capture_applied_migrations
printf '%s\\n' COMMIT_REACHED
`);
    assert.notEqual(invalid.status, 0, timeoutBody);
    assert.doesNotMatch(invalid.stdout, /COMMIT_REACHED/u, timeoutBody);
  }
});

test('finalizer cleanup removes its migration snapshot and preserves the exit status', () => {
  const result = runSourced(`
release_deploy_lock() { printf '%s\\n' lock-released >&2; }
MIGRATIONS_FILE="$(mktemp /tmp/maxim-release-finalizer-cleanup.XXXXXX)"
printf '%s\\n' "$MIGRATIONS_FILE"
trap finalizer_cleanup EXIT
exit 23
`);

  assert.equal(result.status, 23, result.stderr);
  assert.match(result.stderr, /lock-released/u);
  assert.equal(existsSync(result.stdout.trim()), false);
});

test('guarded wrapper requires exact green CI and directly verifies the synchronized checkout', () => {
  const connect = read('infra/scripts/vps-connect.sh');
  const wrapper = functionBlock(connect, 'finalize_release_recovery');
  const ci = wrapper.indexOf('node scripts/ci/assert-green.mjs "$expected_sha"');
  const finalizer = wrapper.indexOf('./infra/scripts/vps-finalize-release-recovery.sh "$branch"');
  const remoteExec = wrapper.indexOf('remote_exec "$remote_command"');

  assert.match(connect, /finalize-release-recovery \[branch\]/u);
  assert.match(connect, /finalize-release-recovery\)\n\s+finalize_release_recovery "\$@"/u);
  assert.match(wrapper, /node scripts\/ci\/assert-green\.mjs "\$expected_sha"/u);
  assert.match(wrapper, /node scripts\/ci\/assert-green\.mjs "\$runtime_sha"/u);
  assert.match(wrapper, /MAXIM_EXPECTED_DEPLOY_SHA/u);
  assert.ok(ci >= 0 && ci < finalizer && finalizer < remoteExec);
  assert.equal([...wrapper.matchAll(/remote_exec "\$remote_command"/gu)].length, 1);
  assert.doesNotMatch(wrapper, /vps-pull-build-up|--plan/u);
  assert.doesNotMatch(wrapper, /MAXIM_WEBHOOK_ROLLOUT_ADOPT_EXISTING_PAUSE/u);
  assert.doesNotMatch(wrapper, /MAXIM_DEPLOY_EMERGENCY_BYPASS|MAXIM_DEPLOY_EMERGENCY_REASON/u);
});

test('split wrapper gates both exact commits before its one remote call', () => {
  const wrapper = functionBlock(read('infra/scripts/vps-connect.sh'), 'finalize_release_recovery');
  const controller = 'a'.repeat(40);
  const runtime = 'b'.repeat(40);
  const run = (arguments_, rejected = '') =>
    spawnSync(
      'bash',
      [
        '-c',
        `set -euo pipefail
git() { printf '%s' '${controller}'; }
node() {
  printf 'ci=%s\\n' "$2" >&2
  [[ "$2" != '${rejected}' ]]
}
shell_quote_args() { printf '%q ' "$@"; }
remote_exec() { printf 'remote=%s\\n' "$1"; }
${wrapper}
finalize_release_recovery "$@"`,
        'test-wrapper',
        ...arguments_,
      ],
      { encoding: 'utf8', cwd: root },
    );
  const result = run(['codex/controller', '--runtime-sha', runtime]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, `ci=${controller}\nci=${runtime}\n`);
  assert.match(result.stdout, new RegExp(`MAXIM_EXPECTED_DEPLOY_SHA=${controller}`, 'u'));
  assert.match(result.stdout, new RegExp(`MAXIM_FINALIZER_RUNTIME_SHA=${runtime}`, 'u'));
  assert.equal(result.stdout.trim().split('\n').length, 1);
  for (const rejected of [controller, runtime]) {
    for (const apiOnly of [[], ['--api-only']]) {
      const failed = run(['codex/controller', '--runtime-sha', runtime, ...apiOnly], rejected);
      assert.notEqual(failed.status, 0);
      assert.equal(failed.stdout, '');
    }
  }
  for (const args of [
    ['codex/controller', '--runtime-sha', ''],
    ['codex/controller', '--runtime-sha', 'main'],
    ['codex/controller', '--runtime-sha', runtime, '--extra'],
    ['--api-only', '--api-only'],
    ['codex/controller', '--runtime-sha', runtime, '--runtime-sha', runtime],
    ['--api-only', '--runtime-sha'],
    ['--api-only', '--runtime-sha', 'main'],
  ]) {
    const invalid = run(args);
    assert.notEqual(invalid.status, 0);
    assert.equal(invalid.stdout, '');
    assert.doesNotMatch(invalid.stderr, /ci=/u);
  }
  const ordinary = run(['main']);
  assert.equal(ordinary.status, 0, ordinary.stderr);
  assert.equal(ordinary.stderr, `ci=${controller}\n`);
  assert.match(ordinary.stdout, new RegExp(`MAXIM_FINALIZER_RUNTIME_SHA=${controller}`, 'u'));
  const defaultBranch = run(['--runtime-sha', runtime]);
  assert.equal(defaultBranch.status, 0, defaultBranch.stderr);
  assert.match(defaultBranch.stdout, /vps-finalize-release-recovery\.sh main/u);
  for (const args of [
    ['codex/controller', '--runtime-sha', runtime, '--api-only'],
    ['codex/controller', '--api-only', '--runtime-sha', runtime],
    ['--api-only', '--runtime-sha', runtime],
  ]) {
    const apiOnly = run(args);
    assert.equal(apiOnly.status, 0, apiOnly.stderr);
    assert.equal(apiOnly.stderr, `ci=${controller}\nci=${runtime}\n`);
    assert.match(
      apiOnly.stdout,
      /vps-finalize-release-recovery\.sh (?:codex\/controller|main) --api-only/u,
    );
    assert.match(apiOnly.stdout, new RegExp(`MAXIM_FINALIZER_RUNTIME_SHA=${runtime}`, 'u'));
    assert.equal(apiOnly.stdout.trim().split('\n').length, 1);
  }
  const apiOnlyDefault = run(['--api-only']);
  assert.equal(apiOnlyDefault.status, 0, apiOnlyDefault.stderr);
  assert.equal(apiOnlyDefault.stderr, `ci=${controller}\n`);
  assert.match(apiOnlyDefault.stdout, /vps-finalize-release-recovery\.sh main --api-only/u);
});

test('split finalization writes the captured runtime identity and rechecks compatibility before commit', () => {
  const runtime = 'b'.repeat(40);
  const body = `
EXPECTED_RUNTIME_SHA='${runtime}'
COMPONENT_SOURCE_SHA[api-shared]="$EXPECTED_RUNTIME_SHA"
RECOVERY_BASE_MANIFEST=/private/transition.json
MIGRATIONS_FILE=/private/migrations.txt
FINALIZER_COMPONENTS=(api-shared miniapp-major-static admin-static)
maxim_require_ordinary_effect_authority() { :; }
verify_synchronized_checkout() { :; }
verify_controller_runtime_compatibility() { :; }
maxim_routing_index_require_release() { printf 'routing=%s\\n' "$*" >&2; }
for component in "\${FINALIZER_COMPONENTS[@]}"; do
  COMPONENT_IMAGE_REF["$component"]="$(expected_component_ref "$component")"
  COMPONENT_IMAGE_ID["$component"]='sha256:${'c'.repeat(64)}'
done
release_manifest() { printf 'manifest=%s\\n' "$*" >&2; }
`;
  const result = runSourced(`${body}\ncommit_recovered_release`);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stderr.startsWith(`routing=${runtime} COMPOSE_FILES\n`));
  assert.match(result.stderr, new RegExp(`--target-sha ${runtime}`, 'u'));
  for (const [component, image] of [
    ['api-shared', 'maxim-api'],
    ['miniapp-major-static', 'maxim-miniapp-major'],
    ['admin-static', 'maxim-admin'],
  ])
    assert.ok(result.stderr.includes(`--component ${component}|${runtime}|${image}:${runtime}|`));
  assert.doesNotMatch(result.stderr, new RegExp('a'.repeat(40), 'u'));
  for (const failed of [
    'maxim_require_ordinary_effect_authority',
    'verify_synchronized_checkout',
    'verify_controller_runtime_compatibility',
    'maxim_routing_index_require_release',
  ]) {
    const invalid = runSourced(
      `${body}\n${failed}() { return 41; }\nif commit_recovered_release; then exit 99; else exit "$?"; fi`,
    );
    assert.equal(invalid.status, 41, failed);
    assert.doesNotMatch(invalid.stderr, /manifest=/u);
  }
});

test('API-only finalization records inherited static sources, refs and image IDs truthfully', () => {
  const runtime = '76dcefb09dc51355bed98847595d47654cde3905';
  const statics = 'd'.repeat(40);
  const identities = [
    ['api-shared', runtime, 'maxim-api', '1'.repeat(64)],
    ['miniapp-major-static', statics, 'maxim-miniapp-major', '2'.repeat(64)],
    ['admin-static', statics, 'maxim-admin', '3'.repeat(64)],
  ];
  const body = `
API_ONLY_RECOVERY=1
EXPECTED_RUNTIME_SHA=${shellQuote(runtime)}
RECOVERY_BASE_MANIFEST=/private/current.invalid-deploy-20261019T000000Z-123.json
MIGRATIONS_FILE=/private/migrations.txt
FINALIZER_COMPONENTS=(api-shared miniapp-major-static admin-static)
maxim_require_ordinary_effect_authority() { :; }
verify_synchronized_checkout() { :; }
verify_controller_runtime_compatibility() { :; }
maxim_routing_index_require_release() { printf 'routing=%s\\n' "$*" >&2; }
${identities
  .map(
    ([
      component,
      source,
      image,
      id,
    ]) => `COMPONENT_SOURCE_SHA[${shellQuote(component)}]=${shellQuote(source)}
COMPONENT_IMAGE_REF[${shellQuote(component)}]=${shellQuote(`${image}:${source}`)}
COMPONENT_IMAGE_ID[${shellQuote(component)}]=${shellQuote(`sha256:${id}`)}`,
  )
  .join('\n')}
release_manifest() { printf 'manifest=%s\\n' "$*" >&2; }
`;
  const valid = runSourced(`${body}\nif commit_recovered_release; then :; else exit "$?"; fi`);
  assert.equal(valid.status, 0, valid.stderr);
  assert.ok(valid.stderr.startsWith(`routing=${runtime} COMPOSE_FILES\n`));
  assert.match(valid.stderr, new RegExp(`--target-sha ${runtime}`, 'u'));
  for (const [component, source, image, id] of identities) {
    assert.ok(
      valid.stderr.includes(`--component ${component}|${source}|${image}:${source}|sha256:${id}`),
    );
  }
  assert.doesNotMatch(
    valid.stderr,
    new RegExp(`(?:miniapp-major-static|admin-static)\\|${runtime}\\|`, 'u'),
  );
  assert.match(valid.stdout, /Release recovery finalized without runtime recreation/u);
  for (const failed of ['commit', 'archive-transition']) {
    const invalid = runSourced(`${body}
release_manifest() { [[ "$1" != ${shellQuote(failed)} ]]; }
if commit_recovered_release; then printf '%s\\n' COMMIT_ACCEPTED; else exit "$?"; fi`);
    assert.notEqual(invalid.status, 0, failed);
    assert.doesNotMatch(invalid.stdout, /COMMIT_ACCEPTED|Release recovery finalized/u, failed);
  }
});

test('API-only journal gates reject invalid, wrong-kind, replaced and changed transition evidence', (t) => {
  const makeJournal = (kind = 'deploy') => {
    const stateDir = mkdtempSync(join(tmpdir(), 'maxim-finalizer-journal-'));
    t.after(() => rmSync(stateDir, { recursive: true, force: true }));
    const source = 'd'.repeat(40);
    const manifest = buildReleaseManifest({
      releaseId: 'fixture-release',
      targetSha: source,
      components: [
        ['api-shared', 'maxim-api'],
        ['miniapp-major-static', 'maxim-miniapp-major'],
        ['admin-static', 'maxim-admin'],
      ].map(([id, image]) => ({
        id,
        sourceSha: source,
        imageRef: `${image}:${source}`,
        imageId: `sha256:${'2'.repeat(64)}`,
      })),
    });
    commitReleaseManifest({ stateDir, manifest });
    const path = beginReleaseTransition({
      stateDir,
      kind,
      now: new Date('2026-10-19T00:00:00Z'),
      pid: 123,
    });
    return { stateDir, path };
  };
  const setup = (stateDir) => `
API_ONLY_RECOVERY=1
RELEASE_STATE_DIR=${shellQuote(stateDir)}
`;
  const valid = makeJournal();
  const accepted = runSourced(`${setup(valid.stateDir)}
if resolve_recovery_base_manifest && verify_recovery_base_unchanged; then
  printf '%s\\n' JOURNAL_ACCEPTED
else
  exit "$?"
fi`);
  assert.equal(accepted.status, 0, accepted.stderr);
  assert.equal(accepted.stdout, 'JOURNAL_ACCEPTED\n');
  const invalid = makeJournal();
  writeFileSync(invalid.path, '{invalid');
  const wrongKind = makeJournal('runtime-rollback');
  for (const fixture of [invalid, wrongKind]) {
    const result = runSourced(`${setup(fixture.stateDir)}
if resolve_recovery_base_manifest; then printf '%s\\n' JOURNAL_ACCEPTED; else exit "$?"; fi`);
    assert.notEqual(result.status, 0);
    assert.doesNotMatch(result.stdout, /JOURNAL_ACCEPTED/u);
  }
  for (const mutation of [
    `printf ' ' >>"$RECOVERY_BASE_MANIFEST"`,
    `mv -- "$RECOVERY_BASE_MANIFEST" "$RELEASE_STATE_DIR/current.invalid-deploy-20261019T000001Z-123.json"`,
    `cp -- "$RECOVERY_BASE_MANIFEST" "$RELEASE_STATE_DIR/current.invalid-deploy-20261019T000001Z-123.json"`,
    `cp -- "$RECOVERY_BASE_MANIFEST" "$RELEASE_STATE_DIR/current.json"`,
  ]) {
    const fixture = makeJournal();
    const result = runSourced(`${setup(fixture.stateDir)}
resolve_recovery_base_manifest
${mutation}
if verify_recovery_base_unchanged; then printf '%s\\n' JOURNAL_ACCEPTED; else exit "$?"; fi`);
    assert.notEqual(result.status, 0, mutation);
    assert.doesNotMatch(result.stdout, /JOURNAL_ACCEPTED/u);
  }
});

test('inherited static inputs use real Git history and the shared fail-closed classifier', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'maxim-finalizer-static-inputs-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const git = (...args) =>
    execFileSync('git', args, {
      cwd: directory,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'Finalizer Fixture',
        GIT_AUTHOR_EMAIL: 'finalizer@example.invalid',
        GIT_COMMITTER_NAME: 'Finalizer Fixture',
        GIT_COMMITTER_EMAIL: 'finalizer@example.invalid',
      },
    }).trim();
  const write = (path, text) => {
    mkdirSync(dirname(join(directory, path)), { recursive: true });
    writeFileSync(join(directory, path), text);
  };
  git('init', '-q');
  for (const path of [
    'apps/api/src/runtime.ts',
    'apps/miniapp/src/main.tsx',
    'apps/admin/src/main.tsx',
    'packages/contracts/src/index.ts',
    'docs/guide.md',
    'package.json',
    'package-lock.json',
    'tsconfig.base.json',
    '.dockerignore',
  ])
    write(path, `original ${path}\n`);
  git('add', '--all');
  git('-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture baseline');
  const baseline = git('rev-parse', 'HEAD');
  const cases = [
    {
      name: 'API and documentation only',
      paths: ['apps/api/src/runtime.ts', 'docs/guide.md'],
      accepts: [true, true],
    },
    {
      name: 'shared contracts',
      paths: ['packages/contracts/src/index.ts'],
      accepts: [false, false],
    },
    { name: 'package manifest', paths: ['package.json'], accepts: [false, false] },
    { name: 'package lock', paths: ['package-lock.json'], accepts: [false, false] },
    { name: 'root build configuration', paths: ['tsconfig.base.json'], accepts: [false, false] },
    { name: 'Docker input configuration', paths: ['.dockerignore'], accepts: [false, false] },
    {
      name: 'unknown deployment input',
      paths: ['unmapped/new-input.bin'],
      accepts: [false, false],
    },
    {
      name: 'miniapp renamed into documentation',
      move: ['apps/miniapp/src/main.tsx', 'docs/old-miniapp.md'],
      accepts: [false, true],
    },
    {
      name: 'documentation renamed into admin',
      move: ['docs/guide.md', 'apps/admin/src/new.tsx'],
      accepts: [true, false],
    },
    { name: 'miniapp deletion', remove: 'apps/miniapp/src/main.tsx', accepts: [false, true] },
    { name: 'admin deletion', remove: 'apps/admin/src/main.tsx', accepts: [true, false] },
  ];
  for (const scenario of cases) {
    git('switch', '--detach', '--quiet', baseline);
    for (const path of scenario.paths ?? []) write(path, `changed ${scenario.name}\n`);
    if (scenario.move) git('mv', ...scenario.move);
    if (scenario.remove) git('rm', scenario.remove);
    git('add', '--all');
    git('-c', 'commit.gpgsign=false', 'commit', '-qm', scenario.name);
    const target = git('rev-parse', 'HEAD');
    for (const [index, component] of ['miniapp-major-static', 'admin-static'].entries()) {
      const result = runSourced(`
cd ${shellQuote(directory)}
EXPECTED_RUNTIME_SHA=${shellQuote(target)}
release_deploy_lock() { :; }
trap finalizer_cleanup EXIT
if require_unchanged_static_inputs ${shellQuote(component)} ${shellQuote(baseline)}; then
  printf '%s\\n' INPUTS_ACCEPTED
else
  exit "$?"
fi`);
      if (scenario.accepts[index]) {
        assert.equal(result.status, 0, `${scenario.name}/${component}: ${result.stderr}`);
        assert.equal(result.stdout, 'INPUTS_ACCEPTED\n');
      } else {
        assert.notEqual(result.status, 0, `${scenario.name}/${component}`);
        assert.doesNotMatch(result.stdout, /INPUTS_ACCEPTED/u);
      }
    }
  }
});

test('image inspection refuses invalid identities inside assignments and conditional calls', () => {
  const source = 'd'.repeat(40);
  const imageId = `sha256:${'2'.repeat(64)}`;
  const ref = `maxim-miniapp-major:${source}`;
  const command = `inspect_target_image miniapp-major-static ${shellQuote(ref)}`;
  const setup = `
API_ONLY_RECOVERY=1
COMPONENT_SOURCE_SHA[miniapp-major-static]=${shellQuote(source)}
`;
  const valid = runSourced(`${setup}
timeout() { printf '%s\\n' ${shellQuote(`${imageId}|${source}|true`)}; }
value="$(${command})"
printf '%s\\n' "$value"`);
  assert.equal(valid.status, 0, valid.stderr);
  assert.equal(valid.stdout, `${imageId}\n`);
  for (const response of [
    `invalid-id|${source}|true`,
    `${imageId}|${'e'.repeat(40)}|true`,
    `${imageId}||true`,
    `${imageId}|${source}|false`,
    `${imageId}|${source}|true|extra`,
    null,
  ]) {
    const timeout =
      response === null
        ? 'timeout() { return 41; }'
        : `timeout() { printf '%s\\n' ${shellQuote(response)}; }`;
    for (const invocation of [
      `value="$(${command})"\nprintf '%s\\n' IMAGE_ACCEPTED`,
      `if value="$(${command})"; then printf '%s\\n' IMAGE_ACCEPTED; else exit "$?"; fi`,
    ]) {
      const invalid = runSourced(`${setup}\n${timeout}\n${invocation}`);
      assert.notEqual(invalid.status, 0, String(response));
      assert.doesNotMatch(invalid.stdout, /IMAGE_ACCEPTED/u);
    }
  }
});

test('ordinary target resolution keeps all components at the target without inherited readers', () => {
  const runtime = 'b'.repeat(40);
  const imageId = `sha256:${'1'.repeat(64)}`;
  const result = runSourced(`
EXPECTED_RUNTIME_SHA=${shellQuote(runtime)}
resolve_inherited_static_component() { printf '%s\\n' UNEXPECTED_INHERITANCE; return 41; }
timeout() { printf '%s\\n' ${shellQuote(`${imageId}|${runtime}|true`)}; }
if resolve_target_images; then :; else exit "$?"; fi
for component in api-shared miniapp-major-static admin-static; do
  printf '%s|%s|%s|%s\\n' "$component" "\${COMPONENT_SOURCE_SHA[$component]}" "\${COMPONENT_IMAGE_REF[$component]}" "\${COMPONENT_IMAGE_ID[$component]}"
done`);
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /UNEXPECTED_INHERITANCE/u);
  for (const [component, image] of [
    ['api-shared', 'maxim-api'],
    ['miniapp-major-static', 'maxim-miniapp-major'],
    ['admin-static', 'maxim-admin'],
  ])
    assert.ok(result.stdout.includes(`${component}|${runtime}|${image}:${runtime}|${imageId}`));
});

test('API-only image resolution propagates missing inheritance and journal image disagreement', () => {
  const runtime = 'b'.repeat(40);
  const staticSource = 'd'.repeat(40);
  const imageId = `sha256:${'2'.repeat(64)}`;
  for (const inheritance of [
    'return 41',
    `COMPONENT_SOURCE_SHA["$1"]=${shellQuote(staticSource)}; INHERITED_STATIC_IMAGE_ID["$1"]=${shellQuote(`sha256:${'3'.repeat(64)}`)}`,
  ]) {
    const result = runSourced(`
API_ONLY_RECOVERY=1
EXPECTED_RUNTIME_SHA=${shellQuote(runtime)}
resolve_inherited_static_component() { ${inheritance}; }
timeout() {
  if [[ "$*" == *maxim-api:* ]]; then
    printf '%s\\n' ${shellQuote(`${imageId}|${runtime}|true`)}
  else
    printf '%s\\n' ${shellQuote(`${imageId}|${staticSource}|true`)}
  fi
}
if resolve_target_images; then printf '%s\\n' RESOLUTION_ACCEPTED; else exit "$?"; fi`);
    assert.notEqual(result.status, 0, inheritance);
    assert.doesNotMatch(result.stdout, /RESOLUTION_ACCEPTED/u);
  }
});

test('runtime inspection refuses wrong refs and IDs inside assignment and conditional contexts', () => {
  const container = '4'.repeat(64);
  const source = 'd'.repeat(40);
  const imageId = `sha256:${'2'.repeat(64)}`;
  const ref = `maxim-miniapp-major:${source}`;
  const fields = [container, 'true', 'running', ref, imageId, '0', '2026-10-19T00:00:00Z'];
  const command = `inspect_service_runtime miniapp-major-static ${shellQuote(ref)} ${shellQuote(imageId)}`;
  const mock = (values) => `
timeout() {
  if [[ "$*" == *' ps -a -q '* ]]; then
    printf '%s\\n' ${shellQuote(container)}
  else
    printf '%s\\n' ${shellQuote(values.join('|'))}
  fi
}`;
  const valid = runSourced(`${mock(fields)}\nvalue="$(${command})"\nprintf '%s\\n' "$value"`);
  assert.equal(valid.status, 0, valid.stderr);
  assert.equal(valid.stdout, `miniapp-major-static|${container}|0|2026-10-19T00:00:00Z\n`);
  for (const [index, value] of [
    [0, 'invalid-container'],
    [1, 'false'],
    [2, 'exited'],
    [3, `maxim-miniapp-major:${'e'.repeat(40)}`],
    [4, `sha256:${'5'.repeat(64)}`],
    [5, 'invalid-restarts'],
    [6, ''],
  ]) {
    const invalidFields = fields.with(index, value);
    for (const invocation of [
      `value="$(${command})"\nprintf '%s\\n' RUNTIME_ACCEPTED`,
      `if value="$(${command})"; then printf '%s\\n' RUNTIME_ACCEPTED; else exit "$?"; fi`,
    ]) {
      const invalid = runSourced(`${mock(invalidFields)}\n${invocation}`);
      assert.notEqual(invalid.status, 0, `${index}/${value}`);
      assert.doesNotMatch(invalid.stdout, /RUNTIME_ACCEPTED/u);
    }
  }
});

test('runtime snapshot propagates a failed earlier service instead of later successful checks', () => {
  const result = runSourced(`
MAXIM_PRODUCTION_API_SERVICES=(api-admin api-ingress)
TARGET_HAS_OCR_NATIVE_SANDBOX=0
MAXIM_TARGET_HAS_PHOTO_NATIVE_SANDBOX=0
COMPONENT_IMAGE_REF[api-shared]=maxim-api:fixture
COMPONENT_IMAGE_ID[api-shared]=fixture-api-id
COMPONENT_IMAGE_REF[miniapp-major-static]=maxim-miniapp-major:fixture
COMPONENT_IMAGE_ID[miniapp-major-static]=fixture-miniapp-id
COMPONENT_IMAGE_REF[admin-static]=maxim-admin:fixture
COMPONENT_IMAGE_ID[admin-static]=fixture-admin-id
inspect_service_runtime() { [[ "$1" != api-admin ]]; }
maxim_topology_require_ocr_native_sandbox_absent() { :; }
maxim_topology_verify_photo_native_sandbox_for_image() { :; }
verify_no_unreviewed_running_api_containers() { :; }
if value="$(verify_runtime_snapshot)"; then printf '%s\\n' SNAPSHOT_ACCEPTED; else exit "$?"; fi`);
  assert.notEqual(result.status, 0);
  assert.doesNotMatch(result.stdout, /SNAPSHOT_ACCEPTED/u);
});

test('main proves journal, runtime, released queues, smokes, and stability before commit', () => {
  const body = `
validate_finalizer_environment() { printf '%s\\n' validate >&2; }
maxim_require_ordinary_effect_authority() { return 0; }
acquire_deploy_lock() { printf '%s\\n' lock >&2; }
verify_synchronized_checkout() { printf '%s\\n' checkout >&2; }
verify_controller_runtime_compatibility() { printf '%s\\n' compatibility >&2; }
resolve_recovery_base_manifest() { printf '%s\\n' journal >&2; }
resolve_target_images() { printf '%s\\n' images >&2; }
prepare_target_ocr_runtime() { printf '%s\\n' ocr-boundary >&2; }
verify_runtime_snapshot() { printf '%s\\n' runtime >&2; printf '%s' stable-runtime; }
assert_webhook_queue_fence_released() { printf '%s\\n' queues >&2; }
run_strict_finalizer_smokes() { printf '%s\\n' smokes >&2; }
wait_for_runtime_stability() { printf '%s\\n' stability >&2; }
verify_target_images_unchanged() { printf '%s\\n' image-recheck >&2; }
capture_applied_migrations() { printf '%s\\n' migrations >&2; }
verify_recovery_base_unchanged() { printf '%s\\n' journal-recheck >&2; }
commit_recovered_release() { printf '%s\\n' commit >&2; }
`;
  const expected = [
    'validate',
    'lock',
    'checkout',
    'compatibility',
    'journal',
    'images',
    'ocr-boundary',
    'runtime',
    'queues',
    'smokes',
    'stability',
    'image-recheck',
    'runtime',
    'migrations',
    'queues',
    'journal-recheck',
    'commit',
  ];
  for (const invocation of [
    'main main',
    'if main main; then :; else exit "$?"; fi',
    'main main --api-only\n[[ "$API_ONLY_RECOVERY" -eq 1 ]]',
    'if main main --api-only; then [[ "$API_ONLY_RECOVERY" -eq 1 ]]; else exit "$?"; fi',
  ]) {
    const result = runSourced(`${body}\n${invocation}`);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.stderr.trim().split('\n'), expected);
  }
});

test('main fails closed before manifest commit when any proof boundary fails', () => {
  for (const failingFunction of [
    'validate_finalizer_environment',
    'acquire_deploy_lock',
    'maxim_require_ordinary_effect_authority',
    'verify_synchronized_checkout',
    'verify_controller_runtime_compatibility',
    'resolve_recovery_base_manifest',
    'resolve_target_images',
    'prepare_target_ocr_runtime',
    'verify_runtime_snapshot',
    'assert_webhook_queue_fence_released',
    'run_strict_finalizer_smokes',
    'wait_for_runtime_stability',
    'verify_target_images_unchanged',
    'capture_applied_migrations',
    'verify_recovery_base_unchanged',
  ]) {
    for (const invocation of [
      'main main',
      'if main main --api-only; then printf MAIN_ACCEPTED; else exit "$?"; fi',
    ]) {
      const result = runSourced(`
validate_finalizer_environment() { :; }
acquire_deploy_lock() { :; }
maxim_require_ordinary_effect_authority() { :; }
verify_synchronized_checkout() { :; }
verify_controller_runtime_compatibility() { :; }
resolve_recovery_base_manifest() { :; }
resolve_target_images() { :; }
prepare_target_ocr_runtime() { :; }
verify_runtime_snapshot() { printf '%s' stable-runtime; }
assert_webhook_queue_fence_released() { :; }
run_strict_finalizer_smokes() { :; }
wait_for_runtime_stability() { :; }
verify_target_images_unchanged() { :; }
capture_applied_migrations() { :; }
verify_recovery_base_unchanged() { :; }
commit_recovered_release() { printf '%s\\n' COMMIT_REACHED; }
${failingFunction}() { return 41; }
${invocation}
`);

      assert.notEqual(result.status, 0, `${failingFunction}/${invocation}`);
      assert.doesNotMatch(result.stdout, /COMMIT_REACHED|MAIN_ACCEPTED/u, failingFunction);
    }
  }
});

test('queue release validator rejects paused, owned, incomplete, and malformed summaries', () => {
  const valid = runSourced(
    `validate_webhook_queue_status '{"queueCount":24,"pausedCount":0,"activeCount":7,"ownerPresent":false}'`,
  );
  assert.equal(valid.status, 0, valid.stderr);

  for (const summary of [
    '{"queueCount":24,"pausedCount":1,"activeCount":0,"ownerPresent":false}',
    '{"queueCount":24,"pausedCount":0,"activeCount":0,"ownerPresent":true}',
    '{"queueCount":23,"pausedCount":0,"activeCount":0,"ownerPresent":false}',
    '{"queueCount":24,"pausedCount":0,"activeCount":-1,"ownerPresent":false}',
    'not-json',
  ]) {
    const result = runSourced(`validate_webhook_queue_status ${JSON.stringify(summary)}`);
    assert.notEqual(result.status, 0, summary);
  }
});
