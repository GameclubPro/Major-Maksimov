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
  assertEraserConnectionRequestSource,
  ERASER_CONNECTION_REQUEST_CHECKS,
  installEraserConnectionRequestFloor,
  validateEraserConnectionRequestFloor,
} from './assert-eraser-source.mjs';
import { installEraserSecrets } from './eraser-bootstrap.mjs';

const sha = 'a'.repeat(40);
const root = resolve(import.meta.dirname, '../..');
const read = (path) => readFileSync(resolve(root, path), 'utf8');

test('connection requests permanently install an owned exact reader floor without changing v1', (t) => {
  const directory = mkdtempSync(resolve(tmpdir(), 'lastik-connection-reader-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const floor = resolve(directory, 'eraser-connection-request-version');
  const ownership = resolve(directory, 'eraser-reader-version');
  writeFileSync(ownership, '1\n', { mode: 0o600 });
  installEraserConnectionRequestFloor(floor);
  const before = statSync(floor);
  installEraserConnectionRequestFloor(floor);
  validateEraserConnectionRequestFloor(floor);
  assert.equal(readFileSync(floor, 'utf8'), '1\n');
  assert.equal(statSync(floor).ino, before.ino);
  assert.equal(statSync(floor).mode & 0o777, 0o600);
  assert.equal(readFileSync(ownership, 'utf8'), '1\n');
});

test('unknown, writable, linked and partial connection floors fail closed without replacement', (t) => {
  const directory = mkdtempSync(resolve(tmpdir(), 'lastik-connection-floor-refuse-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  for (const [index, value] of ['', '1', '2\n', '1\nextra'].entries()) {
    const floor = resolve(directory, `floor-${index}`);
    writeFileSync(floor, value, { mode: 0o600 });
    assert.throws(() => installEraserConnectionRequestFloor(floor), /reader floor/u);
    assert.equal(readFileSync(floor, 'utf8'), value);
  }
  const floor = resolve(directory, 'unsafe');
  writeFileSync(floor, '1\n', { mode: 0o600 });
  chmodSync(floor, 0o644);
  assert.throws(() => installEraserConnectionRequestFloor(floor), /reader floor/u);
  chmodSync(floor, 0o600);
  const alias = resolve(directory, 'alias');
  symlinkSync(floor, alias);
  assert.throws(() => installEraserConnectionRequestFloor(alias));
  linkSync(floor, resolve(directory, 'hardlink'));
  assert.throws(() => installEraserConnectionRequestFloor(floor), /reader floor/u);
  symlinkSync(resolve(directory, 'missing'), resolve(directory, 'dangling'));
  assert.throws(() => installEraserConnectionRequestFloor(resolve(directory, 'dangling')));
});

test('bootstrap refuses unknown connection floor before credentials or bridge are written', (t) => {
  const directory = mkdtempSync(resolve(tmpdir(), 'lastik-connection-bootstrap-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const secretsDir = resolve(directory, 'secrets');
  mkdirSync(secretsDir, { mode: 0o700 });
  const envPath = resolve(directory, '.env');
  writeFileSync(envPath, 'OTHER=value\n', { mode: 0o600 });
  const floor = resolve(directory, 'floor');
  writeFileSync(floor, '2\n', { mode: 0o600 });
  assert.throws(
    () =>
      installEraserSecrets(
        { sourceSha: sha, botId: '123', botToken: 'b'.repeat(64) },
        {
          secretsDir,
          envPath,
          sourceSha: sha,
          connectionReaderMarkerPath: floor,
        },
      ),
    /reader floor/u,
  );
  assert.equal(readFileSync(envPath, 'utf8'), 'OTHER=value\n');
  assert.throws(() => statSync(resolve(secretsDir, 'eraser.env')), { code: 'ENOENT' });
});

test('each installed component needs its actual pending reader, cancellation and expiry wiring', () => {
  const sources = new Map();
  for (const checks of Object.values(ERASER_CONNECTION_REQUEST_CHECKS))
    for (const [path, markers] of checks) sources.set(path, markers.join('\n'));
  for (const [component, checks] of Object.entries(ERASER_CONNECTION_REQUEST_CHECKS)) {
    assert.doesNotThrow(() =>
      assertEraserConnectionRequestSource(sha, component, (path) => sources.get(path)),
    );
    for (const [path, markers] of checks) {
      for (const marker of markers) {
        assert.throws(
          () =>
            assertEraserConnectionRequestSource(sha, component, (candidate) =>
              candidate === path
                ? sources.get(path).replaceAll(marker, 'removed')
                : sources.get(candidate),
            ),
          /connection request reader/u,
          `${component} ${path}: ${marker}`,
        );
      }
      assert.throws(
        () =>
          assertEraserConnectionRequestSource(sha, component, (candidate) =>
            candidate === path ? `/* ${sources.get(path)} */` : sources.get(candidate),
          ),
        /connection request reader/u,
      );
    }
  }
  assert.throws(
    () => assertEraserConnectionRequestSource('main', 'all', () => ''),
    /exact source SHA/u,
  );
  assert.throws(() => assertEraserConnectionRequestSource(sha, 'unknown', () => ''), /Unknown/u);
  assert.doesNotThrow(() =>
    assertEraserConnectionRequestSource(sha, 'all', (path) => sources.get(path)),
  );
});

test('selected source retains pending readers in both applications and controller tooling', () => {
  assert.doesNotThrow(() => assertEraserConnectionRequestSource(sha, 'all', read));
});

test('install precedes migration and new writers; rollback guards precede component mutation', () => {
  const deploy = read('infra/scripts/vps-pull-build-up.sh');
  const install = deploy.indexOf('maxim_eraser_install_connection_request_floor "$TARGET_SHA"');
  assert.ok(install > deploy.indexOf('TARGET_SHA="$(git rev-parse HEAD)"'));
  assert.ok(install < deploy.indexOf('\n  begin_release_runtime_transition\n'));
  assert.ok(install < deploy.search(/^[ \t]+if ! run_migrations; then$/mu));
  assert.ok(install < deploy.indexOf('recreate_service_wave "admin"'));
  assert.ok(install < deploy.indexOf('node apps/eraser/dist/migrate.js'));
  const immutable = read('infra/scripts/vps-release-rollback.sh');
  const eraserGuard = immutable.indexOf(
    'maxim_topology_require_eraser_connection_requests "${COMPONENT_SOURCE_SHA[eraser]}" eraser',
  );
  assert.ok(eraserGuard > immutable.indexOf('if [[ "$SELECT_ERASER" -eq 1 ]]; then'));
  assert.ok(eraserGuard < immutable.indexOf('\nbegin_release_runtime_transition\n'));
  assert.ok(eraserGuard < immutable.indexOf('recreate_service eraser'));
  const runtime = read('infra/scripts/vps-runtime-rollback.sh');
  const guard = runtime.indexOf(
    'maxim_topology_require_eraser_connection_requests "$TARGET_FULL_SHA" all',
  );
  assert.ok(guard > 0 && guard < runtime.indexOf('\ngit switch --detach "$TARGET_FULL_SHA"'));
  const connector = read('infra/scripts/vps-connect.sh');
  const installed = connector.indexOf(
    'maxim_topology_require_eraser_connection_requests "$(git rev-parse HEAD)" tooling',
  );
  assert.ok(installed > 0 && installed < connector.indexOf('source "$entrypoint" "$@"'));
});

test('static-only component rollback does not probe the independent service source', () => {
  const source = read('infra/scripts/vps-release-rollback.sh');
  const start = source.indexOf('if [[ "$SELECT_ERASER" -eq 1 ]]; then');
  const end = source.indexOf('\nfi\n', start) + 4;
  const result = spawnSync(
    'bash',
    [
      '-c',
      `set -euo pipefail
SELECT_ERASER=0
maxim_topology_require_eraser_connection_requests() { exit 71; }
${source.slice(start, end)}
`,
    ],
    { encoding: 'utf8', timeout: 5000 },
  );
  assert.equal(result.status, 0, result.stderr);
});

test('installed connection floor is checked after availability and original ownership marker disappear', (t) => {
  const directory = mkdtempSync(resolve(tmpdir(), 'lastik-installed-connection-floor-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const source = read('infra/scripts/lib/deploy-topology.sh');
  const names = [
    'maxim_topology_require_eraser_bridge',
    'maxim_topology_require_eraser_connection_requests',
  ];
  const functions = names
    .map((name) => {
      const start = source.indexOf(`${name}() {`);
      return source.slice(start, source.indexOf('\n}\n', start) + 2);
    })
    .join('\n')
    .replaceAll('/var/lib/maxim-deploy', directory)
    .replaceAll('/var/lib/maxim-secrets', resolve(directory, 'absent-secrets'));
  const floor = resolve(directory, 'eraser-connection-request-version');
  installEraserConnectionRequestFloor(floor);
  const result = spawnSync(
    'bash',
    [
      '-c',
      `set -euo pipefail
${functions}
node() {
  printf '%s\\n' "$*"
  if [[ "$*" == *'--connection-requests all' ]]; then return 47; fi
}
maxim_topology_require_eraser_bridge '${sha}'
printf 'FORBIDDEN\\n'
`,
    ],
    { encoding: 'utf8', timeout: 5000 },
  );
  assert.equal(result.status, 47, result.stderr);
  assert.match(result.stdout, /--validate-connection-request-floor/u);
  assert.match(result.stdout, /--connection-requests all/u);
  assert.doesNotMatch(result.stdout, /FORBIDDEN/u);
  const legacyFailure = spawnSync(
    'bash',
    [
      '-c',
      `set -euo pipefail
${functions}
node() { return 48; }
maxim_topology_require_eraser_bridge '${sha}' || exit "$?"
printf 'FORBIDDEN\\n'
`,
    ],
    { encoding: 'utf8', timeout: 5000 },
  );
  assert.equal(legacyFailure.status, 48);
  assert.doesNotMatch(legacyFailure.stdout, /FORBIDDEN/u);
});

test('connector checks retained tooling before API or Eraser rollback, preserving static-only offline path', (t) => {
  const directory = mkdtempSync(resolve(tmpdir(), 'lastik-connection-bootstrap-controller-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
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
    'maxim_topology_require_eraser_connection_requests() { printf "READER_REFUSED\\n"; return 47; }\n',
  );
  const entrypoint = './infra/scripts/vps-release-rollback.sh';
  writeFileSync(
    resolve(directory, entrypoint),
    '#!/usr/bin/env bash\n# select_release_recovery_base\nprintf "ENTERED\\n"\n',
    { mode: 0o755 },
  );
  installEraserConnectionRequestFloor(resolve(directory, 'eraser-connection-request-version'));
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
  for (const components of [[], ['api-shared'], ['eraser'], ['miniapp-major-static', 'eraser']]) {
    const result = run(components);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stdout, /READER_REFUSED/u);
    assert.doesNotMatch(result.stdout, /ENTERED/u);
  }
  for (const components of [
    ['miniapp-major-static'],
    ['admin-static'],
    ['miniapp-major-static', 'admin-static'],
  ]) {
    const result = run(components);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, 'ENTERED\n');
  }
});
