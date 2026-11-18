import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
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
import { resolve } from 'node:path';
import test from 'node:test';
import {
  assertEraserRateLimitReaderSource,
  ERASER_RATE_LIMIT_READER_CHECKS,
  installEraserRateLimitReaderFloor,
  validateEraserRateLimitReaderFloor,
} from './assert-eraser-source.mjs';

const sha = 'a'.repeat(40);
const root = resolve(import.meta.dirname, '../..');
const read = (path) => readFileSync(resolve(root, path), 'utf8');
function temporary(t) {
  const directory = mkdtempSync(resolve(tmpdir(), 'lastik-rate-limit-reader-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test('rate limit floor is durable and idempotent without rewriting existing reader floors', (t) => {
  const directory = temporary(t);
  for (const name of ['eraser-reader-version', 'eraser-connection-request-version'])
    writeFileSync(resolve(directory, name), '1\n', { mode: 0o600 });
  const floor = resolve(directory, 'eraser-rate-limit-reader-version');
  installEraserRateLimitReaderFloor(floor);
  const before = statSync(floor);
  installEraserRateLimitReaderFloor(floor);
  validateEraserRateLimitReaderFloor(floor);
  assert.equal(statSync(floor).ino, before.ino);
  assert.equal(statSync(floor).mode & 0o777, 0o600);
  for (const name of [
    'eraser-reader-version',
    'eraser-connection-request-version',
    'eraser-rate-limit-reader-version',
  ])
    assert.equal(readFileSync(resolve(directory, name), 'utf8'), '1\n');
});

test('unknown, partial, writable and linked rate limit floors fail closed without replacement', (t) => {
  const directory = temporary(t);
  for (const [index, value] of ['', '1', '2\n', '1\nextra'].entries()) {
    const floor = resolve(directory, `invalid-${index}`);
    writeFileSync(floor, value, { mode: 0o600 });
    assert.throws(() => installEraserRateLimitReaderFloor(floor), /rate limit reader floor/u);
    assert.equal(readFileSync(floor, 'utf8'), value);
  }
  const floor = resolve(directory, 'floor');
  installEraserRateLimitReaderFloor(floor);
  chmodSync(floor, 0o644);
  assert.throws(() => installEraserRateLimitReaderFloor(floor), /rate limit reader floor/u);
  chmodSync(floor, 0o600);
  const alias = resolve(directory, 'alias');
  symlinkSync(floor, alias);
  assert.throws(() => installEraserRateLimitReaderFloor(alias));
  linkSync(floor, resolve(directory, 'hardlink'));
  assert.throws(() => installEraserRateLimitReaderFloor(floor), /rate limit reader floor/u);
  const dangling = resolve(directory, 'dangling');
  symlinkSync(resolve(directory, 'absent'), dangling);
  assert.throws(() => installEraserRateLimitReaderFloor(dangling));
});

test('reader guard rejects old and commented wiring while keeping API sources outside its scope', () => {
  const sources = new Map();
  for (const checks of Object.values(ERASER_RATE_LIMIT_READER_CHECKS))
    for (const [path, markers] of checks) sources.set(path, markers.join('\n'));
  for (const [component, checks] of Object.entries(ERASER_RATE_LIMIT_READER_CHECKS)) {
    assert.doesNotThrow(() =>
      assertEraserRateLimitReaderSource(sha, component, (path) => sources.get(path)),
    );
    for (const [path, markers] of checks) {
      for (const marker of markers)
        assert.throws(
          () =>
            assertEraserRateLimitReaderSource(sha, component, (candidate) =>
              candidate === path
                ? sources.get(path).replaceAll(marker, 'removed')
                : sources.get(candidate),
            ),
          /rate limit reader/u,
          `${path}: ${marker}`,
        );
      assert.throws(
        () =>
          assertEraserRateLimitReaderSource(sha, component, (candidate) =>
            candidate === path
              ? path.endsWith('.sh') || path.endsWith('.sql')
                ? sources
                    .get(path)
                    .split('\n')
                    .map((line) => `${path.endsWith('.sh') ? '#' : '--'} ${line}`)
                    .join('\n')
                : `/* ${sources.get(path)} */`
              : sources.get(candidate),
          ),
        /rate limit reader/u,
      );
      const literal = path.endsWith('.sh')
        ? `'${sources.get(path)}'`
        : path.endsWith('.sql')
          ? `$guard$${sources.get(path)}$guard$`
          : JSON.stringify(sources.get(path));
      assert.throws(
        () =>
          assertEraserRateLimitReaderSource(sha, component, (candidate) =>
            candidate === path ? literal : sources.get(candidate),
          ),
        /rate limit reader/u,
        `${path}: string-only capability`,
      );
    }
  }
  const visited = [];
  assertEraserRateLimitReaderSource(sha, 'all', (path) => {
    visited.push(path);
    return sources.get(path);
  });
  assert.ok(visited.every((path) => !path.startsWith('apps/api/')));
  assert.throws(
    () => assertEraserRateLimitReaderSource('main', 'eraser', read),
    /exact source SHA/u,
  );
  assert.throws(() => assertEraserRateLimitReaderSource(sha, 'api-shared', read), /Unknown/u);
});

test('current source retains durable token admission in the worker and webhook registration', () => {
  assert.doesNotThrow(() => assertEraserRateLimitReaderSource(sha, 'all', read));
});

test('trailing JavaScript comments cannot replace either durable constructor argument', () => {
  const marker = 'new DurableRateLimit(pool, settings.botId)';
  for (const path of ['apps/eraser/src/main.ts', 'apps/eraser/src/register-webhook.ts']) {
    const source = read(path);
    assert.ok(source.includes(`${marker},`));
    const mutant = source.replace(`${marker},`, `undefined, // ${marker}`);
    assert.throws(
      () =>
        assertEraserRateLimitReaderSource(sha, 'eraser', (candidate) =>
          candidate === path ? mutant : read(candidate),
        ),
      /rate limit reader/u,
    );
    for (const literal of [JSON.stringify(marker), '`' + marker + '`']) {
      const stringOnly = source.replace(`${marker},`, `undefined,\n  ${literal},`);
      assert.throws(
        () =>
          assertEraserRateLimitReaderSource(sha, 'eraser', (candidate) =>
            candidate === path ? stringOnly : read(candidate),
          ),
        /rate limit reader/u,
      );
    }
  }
});

test('SQL line comments or literals cannot stand in for the persisted cooldown table', () => {
  const path = 'apps/eraser/migrations/0005-durable-rate-limit.sql';
  const source = read(path);
  for (const mutant of [
    source
      .split('\n')
      .map((line) => `-- ${line}`)
      .join('\n'),
    "SELECT 'eraser_rate_limits not_before';",
    'SELECT $guard$eraser_rate_limits not_before$guard$;',
    '/* outer /* nested */ eraser_rate_limits not_before */ SELECT 1;',
  ])
    assert.throws(
      () =>
        assertEraserRateLimitReaderSource(sha, 'eraser', (candidate) =>
          candidate === path ? mutant : read(candidate),
        ),
      /rate limit reader/u,
    );
});

test('quoted URLs, comment-like strings and shell arguments preserve real active wiring', () => {
  assert.doesNotThrow(() =>
    assertEraserRateLimitReaderSource(sha, 'all', (path) => {
      const prefix = path.endsWith('.sh')
        ? `url='https://example.invalid/#fragment'\nmessage="literal # text"\n`
        : path.endsWith('.sql')
          ? `SELECT 'https://example.invalid/--path', 'it''s /* literal */';\n`
          : `const url = 'https://example.invalid/path';\nconst text = "literal // text";\nconst pattern = /["'\\/]/u;\n`;
      return prefix + read(path);
    }),
  );
});

test('floor is installed only for a selected Lastik image before migration and startup', () => {
  const deploy = read('infra/scripts/vps-pull-build-up.sh');
  const targetSha = deploy.indexOf('TARGET_SHA="$(git rev-parse HEAD)"');
  const migration = deploy.indexOf('node apps/eraser/dist/migrate.js');
  const ordinary = deploy.slice(targetSha, deploy.indexOf('\nRELEASE_ID=', targetSha));
  const ordinaryTransition = deploy.indexOf('\n  begin_release_runtime_transition\n', targetSha);
  assert.ok(targetSha >= 0 && ordinaryTransition > targetSha + ordinary.length);
  assert.match(ordinary, /^TARGET_SHA=.*\nif \[\[ "\$DEPLOY_MODE" != eraser-only \]\]; then\n/u);
  assert.match(
    ordinary,
    /if contains_service eraser "\$\{SERVICES\[@\]\}"; then\n {4}maxim_eraser_install_rate_limit_reader_floor "\$TARGET_SHA"\n/u,
  );
  const imageAdmission = deploy.indexOf(
    '\n  require_preloaded_target_image "$candidate_image_ref"',
  );
  const isolated = deploy.slice(imageAdmission, migration);
  assert.ok(imageAdmission > ordinaryTransition && migration > imageAdmission);
  assert.match(
    isolated,
    /\nif \[\[ "\$DEPLOY_MODE" != eraser-only \]\]; then\n {2}ensure_compose_env\nelse\n {2}maxim_eraser_install_connection_request_floor "\$TARGET_SHA"\n {2}maxim_eraser_install_rate_limit_reader_floor "\$TARGET_SHA"\n {2}maxim_eraser_install_connection_proof_reader_floor "\$TARGET_SHA"\nfi\nif .*; then\n {2}begin_release_runtime_transition\n/u,
  );
  assert.equal(
    deploy.match(/\bmaxim_eraser_install_rate_limit_reader_floor "\$TARGET_SHA"/gu)?.length,
    2,
  );
  const runtime = read('infra/scripts/vps-runtime-rollback.sh');
  const guard = runtime.indexOf(
    'maxim_topology_require_eraser_rate_limit_reader "$TARGET_FULL_SHA" tooling',
  );
  assert.ok(guard > 0 && guard < runtime.indexOf('\ngit switch --detach "$TARGET_FULL_SHA"'));
  assert.doesNotMatch(
    runtime,
    /require_eraser_rate_limit_reader "\$TARGET_FULL_SHA" (?:all|eraser)/u,
  );
});

test('installed cooldown floor remains enforced without availability or the older markers', (t) => {
  const directory = temporary(t);
  installEraserRateLimitReaderFloor(resolve(directory, 'eraser-rate-limit-reader-version'));
  const source = read('infra/scripts/lib/deploy-topology.sh');
  const start = source.indexOf('maxim_topology_require_eraser_rate_limit_reader() {');
  const guard = source
    .slice(start, source.indexOf('\n}\n', start) + 2)
    .replaceAll('/var/lib/maxim-deploy', directory);
  const result = spawnSync(
    'bash',
    [
      '-c',
      `set -euo pipefail
${guard}
node() {
  printf '%s\\n' "$*"
  if [[ "$*" == *'--rate-limit-reader eraser' ]]; then return 47; fi
}
maxim_topology_require_eraser_rate_limit_reader '${sha}' eraser
printf 'FORBIDDEN\\n'
`,
    ],
    { encoding: 'utf8', timeout: 5000 },
  );
  assert.equal(result.status, 47, result.stderr);
  assert.match(result.stdout, /--validate-rate-limit-reader-floor/u);
  assert.match(result.stdout, /--rate-limit-reader eraser/u);
  assert.doesNotMatch(result.stdout, /FORBIDDEN/u);
});

test('immutable rollback rejects an old Lastik image before mutations but preserves API/static scope', () => {
  const source = read('infra/scripts/vps-release-rollback.sh');
  const start = source.indexOf('if [[ "$SELECT_ERASER" -eq 1 ]]; then');
  const end = source.indexOf('\nfi\n', start) + 4;
  assert.ok(start > 0 && end < source.indexOf('\nbegin_release_runtime_transition\n'));
  for (const selected of [0, 1]) {
    const result = spawnSync(
      'bash',
      [
        '-c',
        `set -euo pipefail
SELECT_ERASER=${selected}
declare -A COMPONENT_SOURCE_SHA=([eraser]='${sha}')
maxim_topology_require_eraser_connection_requests() { :; }
maxim_topology_require_eraser_rate_limit_reader() { printf 'READER_REFUSED\\n'; return 47; }
${source.slice(start, end)}
printf 'CONTINUE\\n'
`,
      ],
      { encoding: 'utf8', timeout: 5000 },
    );
    assert.equal(result.status, selected ? 47 : 0, result.stderr);
    assert.equal(result.stdout, selected ? 'READER_REFUSED\n' : 'CONTINUE\n');
  }
});

test('rollback bootstrap enforces cooldown tooling only when Lastik or checkout can change', (t) => {
  const directory = temporary(t);
  const library = resolve(directory, 'infra/scripts/lib');
  mkdirSync(library, { recursive: true });
  writeFileSync(
    resolve(library, 'deploy-lock.sh'),
    'export MAXIM_DEPLOY_LOCK_VERSION=flock-v1\nacquire_deploy_lock() { :; }\n',
  );
  writeFileSync(
    resolve(library, 'legacy-cold-maintenance.sh'),
    'maxim_require_ordinary_effect_authority() { :; }\n',
  );
  writeFileSync(
    resolve(library, 'deploy-topology.sh'),
    'maxim_topology_require_eraser_rate_limit_reader() { printf "READER_REFUSED\\n"; return 47; }\n',
  );
  const entrypoint = './infra/scripts/vps-release-rollback.sh';
  writeFileSync(
    resolve(directory, entrypoint),
    '#!/usr/bin/env bash\n# select_release_recovery_base\nprintf "ENTERED\\n"\n',
    { mode: 0o755 },
  );
  installEraserRateLimitReaderFloor(resolve(directory, 'eraser-rate-limit-reader-version'));
  const connector = read('infra/scripts/vps-connect.sh');
  const bootstrap =
    /rollback_entrypoint_bootstrap_source\(\) \{\n {2}cat <<'BOOTSTRAP'\n([\s\S]*?)\nBOOTSTRAP\n\}/u.exec(
      connector,
    )?.[1];
  assert.ok(bootstrap);
  const source = bootstrap.replaceAll('/var/lib/maxim-deploy', directory);
  const run = (components) =>
    spawnSync(
      'bash',
      [
        '-c',
        `git() { printf '${sha}\\n'; }\n${source}`,
        'fixture',
        sha,
        entrypoint,
        'select_release_recovery_base',
        'release-fixture',
        ...components,
      ],
      { cwd: directory, encoding: 'utf8', timeout: 5000 },
    );
  for (const components of [[], ['eraser'], ['api-shared', 'eraser']]) {
    const result = run(components);
    assert.equal(result.status, 1, result.stderr);
    assert.equal(result.stdout, 'READER_REFUSED\n');
  }
  for (const components of [['api-shared'], ['miniapp-major-static'], ['admin-static']]) {
    const result = run(components);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, 'ENTERED\n');
  }
  const fallback = source.indexOf(
    'require_market_statistics_lock_dispatch "$expected_tooling_sha"',
  );
  const check = source.indexOf(
    'maxim_topology_require_eraser_rate_limit_reader "$expected_tooling_sha" tooling',
  );
  assert.ok(check > fallback && check < source.indexOf('\ngit checkout main'));
});

test('branch synchronization checks both refs before replacing controller bytes', () => {
  const source = read('infra/scripts/vps-pull-build-up.sh');
  const start = source.indexOf('sync_branch() {');
  const end = source.indexOf('\n}\n', start);
  const sync = source.slice(start, end);
  for (const target of ['origin/$BRANCH', 'refs/heads/$BRANCH']) {
    const check = sync.indexOf(
      `maxim_topology_require_eraser_rate_limit_reader "$(git rev-parse "${target}")" tooling`,
    );
    assert.ok(check > 0 && check < sync.indexOf('git checkout "$BRANCH"'));
  }
});
