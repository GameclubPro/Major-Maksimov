import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  readBacklogCancellationInput,
  runBacklogCancellationHost,
} from './backlog-cancellation-host.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const host = fileURLToPath(new URL('./backlog-cancellation-host.mjs', import.meta.url));
const connector = readFileSync(new URL('./vps-connect.sh', import.meta.url), 'utf8');
const fixture = JSON.parse(
  readFileSync(
    new URL('../fixtures/backlog-cancellation-v2-contract.json', import.meta.url),
    'utf8',
  ),
);
const start = connector.indexOf('validate_backlog_request() {');
const end = connector.indexOf('\ncancel_webhook_backlog() {', start);
assert.ok(start >= 0 && end > start);
const validation = connector.slice(start, end);
const functions = connector.slice(
  connector.indexOf('cancel_webhook_backlog() {'),
  connector.indexOf('\nlegacy_cold_recovery() {'),
);
const shellSource = readFileSync(new URL('./vps-backlog-cancellation.sh', import.meta.url), 'utf8');
const lockHelper = readFileSync(new URL('./lib/deploy-lock.sh', import.meta.url), 'utf8');
const commandSupervisor = [
  '_maxim_deploy_controller_start',
  '_maxim_deploy_signal_controller',
  'supervise_deploy_lock_command',
]
  .map((name) => {
    const start = lockHelper.indexOf(`${name}() {`);
    const end = lockHelper.indexOf('\n}\n', start);
    assert.ok(start >= 0 && end > start, `Missing command supervisor function: ${name}`);
    return lockHelper.slice(start, end + 2);
  })
  .join('\n');
const entrypoints = [
  ['cancel_webhook_backlog', fixture.validApply],
  ['preview_webhook_backlog', fixture.validNomination],
];
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])]),
    );
  return value;
}
const bytes = (value) => `${JSON.stringify(canonical(value))}\n`;

test('bounded host stdin rejects oversize and malformed UTF-8 without consuming unbounded memory', () => {
  const directory = mkdtempSync(join(tmpdir(), 'maxim-cancel-input-'));
  try {
    for (const [name, value, accepted] of [
      ['valid', Buffer.from(bytes(fixture.validApply)), true],
      ['bom-preserved', Buffer.from(`\uFEFF${bytes(fixture.validApply)}`), true],
      ['empty', Buffer.alloc(0), false],
      ['oversize', Buffer.alloc(16 * 1024 + 1, 32), false],
      ['utf8', Buffer.from([0xc3, 0x28]), false],
    ]) {
      const path = join(directory, name);
      writeFileSync(path, value);
      const fd = openSync(path, 'r');
      try {
        if (accepted) assert.equal(readBacklogCancellationInput(fd), value.toString());
        else assert.throws(() => readBacklogCancellationInput(fd));
      } finally {
        closeSync(fd);
      }
    }
  } finally {
    rmSync(directory, { recursive: true });
  }
});

test('connector validates exact private v1/apply/nomination before GitHub and SSH', () => {
  const directory = mkdtempSync(join(tmpdir(), 'maxim-cancel-connector-'));
  const legacy = Object.fromEntries(
    ['id', 'cutoff', 'sourceSha', 'imageId'].map((key) => [key, fixture.validApply[key]]),
  );
  try {
    for (const [value, mode, accepted, prefix = ''] of [
      [legacy, 'apply', true],
      [fixture.validApply, 'apply', true],
      [fixture.validNomination, 'preview', true],
      [fixture.validNomination, 'apply', false],
      [fixture.validApply, 'preview', false],
      [{ ...fixture.validNomination, version: 3 }, 'preview', false],
      [{ ...fixture.validNomination, force: true }, 'preview', false],
      [{ ...fixture.validApply, previewSha256: 'PRIVATE_SECRET_MARKER' }, 'apply', false],
      [fixture.validApply, 'apply', false, '\uFEFF'],
      [fixture.validNomination, 'preview', false, '\uFEFF'],
    ]) {
      const path = join(directory, 'request.json');
      writeFileSync(path, `${prefix}${bytes(value)}`, { mode: 0o600 });
      const result = spawnSync(
        'bash',
        [
          '-c',
          `${validation}\nvalidate_backlog_request "$1" "$2" "$3"`,
          'validate',
          path,
          fixture.validApply.sourceSha,
          mode,
        ],
        {
          encoding: 'utf8',
          timeout: 10_000,
          env: { ...process.env, ROOT_DIR: root },
        },
      );
      assert.equal(result.status, accepted ? 0 : 2, result.stderr);
      assert.equal(result.stdout, accepted ? bytes(value) : '');
      assert.ok(!result.stderr.includes('PRIVATE_SECRET_MARKER'));
    }
    for (const [name, following] of [
      ['cancel_webhook_backlog', 'preview_webhook_backlog'],
      ['preview_webhook_backlog', 'legacy_cold_recovery'],
    ]) {
      const body = connector.slice(
        connector.indexOf(`${name}() {`),
        connector.indexOf(`\n${following}() {`),
      );
      assert.ok(body.indexOf('validate_backlog_request ') < body.indexOf('assert-green.mjs'));
      assert.ok(body.indexOf('assert-green.mjs') < body.indexOf('remote_exec '));
      assert.match(body, /validated_request="\$\(validate_backlog_request /);
      assert.match(body, /printf '%s\\n' "\$validated_request" \| remote_exec /);
      assert.ok(!body.includes('<"$request_file"'));
    }
  } finally {
    rmSync(directory, { recursive: true });
  }
});

test('the broad legacy continuation refuses scoped requests before a runtime or store call', async () => {
  await assert.rejects(runBacklogCancellationHost(fixture.validApply, true), /scoped controller/);
  const result = spawnSync(process.execPath, [host, '--resume-pending'], {
    input: bytes(fixture.validApply),
    encoding: 'utf8',
    timeout: 10_000,
  });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /preserve the exact operation/);
});

function runConnector(value, entrypoint, settings = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'maxim-cancel-routing-'));
  const path = join(directory, 'request.json');
  const events = join(directory, 'events');
  const remote = join(directory, 'remote');
  writeFileSync(path, bytes(value), { mode: 0o600 });
  const script = `${validation}\n${functions}\n
git() {
  if [[ "$3" == rev-parse && "$4" == HEAD ]]; then
    if [[ -e "$TEST_EVENTS" && "$TEST_DRIFT" == sha ]]; then printf '%s\\n' "$TEST_CHANGED_SHA";
    else printf '%s\\n' "$TEST_SOURCE_SHA"; fi
  elif [[ "$3" == status ]]; then
    if [[ "$TEST_DIRTY" == 1 || ( -e "$TEST_EVENTS" && "$TEST_DRIFT" == dirty ) ]]; then printf '%s\\n' ' M owned-script';
    elif [[ "$TEST_GIT_STATUS_FAILURE" == 1 ]]; then return 3; fi
  else return 99; fi
}
node() {
  if [[ "$1" == "$ROOT_DIR/scripts/ci/assert-green.mjs" ]]; then
    printf 'ci:%s\\n' "$2" >> "$TEST_EVENTS"
    if [[ "$TEST_MUTATE" == 1 ]]; then printf '%s\\n' 'changed-during-ci' > "$TEST_REQUEST_PATH"; fi
    if [[ "$2" == "$TEST_CI_FAIL_SHA" ]]; then return 1; fi
  else command node "$@"; fi
}
shell_quote_args() { printf '%q ' "$@"; }
remote_exec() {
  printf '%s\\n' ssh >> "$TEST_EVENTS"
  printf '%s\\n' "$1" > "$TEST_REMOTE"
  cat
}
"$1" "$2"
`;
  try {
    const result = spawnSync(
      'bash',
      ['-euo', 'pipefail', '-c', script, 'routing', entrypoint, path],
      {
        encoding: 'utf8',
        timeout: 10_000,
        env: {
          ...process.env,
          ROOT_DIR: root,
          TEST_SOURCE_SHA: settings.controllerSha ?? value.sourceSha,
          TEST_CHANGED_SHA: 'f'.repeat(40),
          TEST_REQUEST_PATH: path,
          TEST_EVENTS: events,
          TEST_REMOTE: remote,
          TEST_DIRTY: settings.dirty ? '1' : '0',
          TEST_GIT_STATUS_FAILURE: settings.gitStatusFailure ? '1' : '0',
          TEST_MUTATE: settings.mutate ? '1' : '0',
          TEST_DRIFT: settings.drift ?? '',
          TEST_CI_FAIL_SHA: settings.ciFailSha ?? '',
        },
      },
    );
    return {
      ...result,
      events: existsSync(events) ? readFileSync(events, 'utf8').trim().split('\n') : [],
      remote: existsSync(remote) ? readFileSync(remote, 'utf8').trim() : '',
      request: readFileSync(path, 'utf8'),
    };
  } finally {
    rmSync(directory, { recursive: true });
  }
}

test('connector sends frozen bytes and runtime identity when the input changes during either CI wait', () => {
  const controllerSha = 'e'.repeat(40);
  for (const [entrypoint, value] of entrypoints) {
    const result = runConnector(value, entrypoint, {
      controllerSha,
      mutate: true,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.request, 'changed-during-ci\n');
    assert.equal(result.stdout, bytes(value));
    assert.deepEqual(result.events, [`ci:${controllerSha}`, `ci:${value.sourceSha}`, 'ssh']);
    assert.ok(result.remote.includes(`MAXIM_EXPECTED_DEPLOY_SHA=${controllerSha}`));
    assert.ok(result.remote.includes(`MAXIM_EXPECTED_BACKLOG_RUNTIME_SHA=${value.sourceSha}`));
    assert.equal(result.remote.includes('--preview'), entrypoint === 'preview_webhook_backlog');
  }
});

test('connector checks one exact CI identity for same-source v2 and preserves same-source legacy apply', () => {
  const legacy = Object.fromEntries(
    ['id', 'cutoff', 'sourceSha', 'imageId'].map((key) => [key, fixture.validApply[key]]),
  );
  for (const [entrypoint, value] of [...entrypoints, ['cancel_webhook_backlog', legacy]]) {
    const result = runConnector(value, entrypoint);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, bytes(value));
    assert.deepEqual(result.events, [`ci:${value.sourceSha}`, 'ssh']);
  }
  const mismatch = runConnector(legacy, 'cancel_webhook_backlog', {
    controllerSha: 'e'.repeat(40),
  });
  assert.equal(mismatch.status, 2);
  assert.deepEqual(mismatch.events, []);
  assert.equal(mismatch.remote, '');
});

test('either failed exact CI check blocks SSH and never falls back to the other source', () => {
  const controllerSha = 'e'.repeat(40);
  for (const [entrypoint, value] of entrypoints) {
    for (const ciFailSha of [controllerSha, value.sourceSha]) {
      const result = runConnector(value, entrypoint, {
        controllerSha,
        ciFailSha,
      });
      assert.equal(result.status, 1, result.stderr);
      assert.deepEqual(
        result.events,
        ciFailSha === controllerSha
          ? [`ci:${controllerSha}`]
          : [`ci:${controllerSha}`, `ci:${value.sourceSha}`],
      );
      assert.equal(result.remote, '');
      assert.equal(result.stdout, '');
    }
  }
});

test('dirty or unreadable local source refuses before CI and source drift during CI refuses before SSH', () => {
  for (const [entrypoint, value] of entrypoints) {
    for (const settings of [{ dirty: true }, { gitStatusFailure: true }]) {
      const result = runConnector(value, entrypoint, settings);
      assert.equal(result.status, 2, result.stderr);
      assert.deepEqual(result.events, []);
      assert.equal(result.remote, '');
    }
    for (const drift of ['sha', 'dirty']) {
      const result = runConnector(value, entrypoint, { drift });
      assert.equal(result.status, 2, result.stderr);
      assert.deepEqual(result.events, [`ci:${value.sourceSha}`]);
      assert.equal(result.remote, '');
    }
  }
});

function runHostShell(settings = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'maxim-cancel-shell-'));
  const scripts = join(directory, 'infra', 'scripts');
  const binary = join(directory, 'bin');
  mkdirSync(join(scripts, 'lib'), { recursive: true });
  mkdirSync(binary);
  const events = join(directory, 'events');
  const forwarded = join(directory, 'forwarded');
  const input = bytes(fixture.validNomination);
  writeFileSync(join(scripts, 'vps-backlog-cancellation.sh'), shellSource);
  for (const name of ['deploy-topology.sh', 'photo-native-lifecycle.sh'])
    writeFileSync(
      join(scripts, 'lib', name),
      readFileSync(new URL(`./lib/${name}`, import.meta.url)),
    );
  writeFileSync(
    join(binary, 'docker'),
    `#!/usr/bin/env bash
set -euo pipefail
[[ -f "$TEST_ACQUIRED" && $# == 8 ]] || exit 90
case "$*" in
  'ps --all --quiet --no-trunc --filter label=com.docker.compose.project=infra --filter label=com.docker.compose.service=ocr-native-sandbox-2')
    [[ "$TEST_DOCKER_UNAVAILABLE" == 0 ]] || exit 1
    if [[ "$TEST_POOL" == 1 ]]; then printf '%064d\\n' 2; fi ;;
  'ps --all --quiet --no-trunc --filter label=com.docker.compose.project=infra --filter label=com.docker.compose.service=ocr-native-sandbox-3') ;;
  *) exit 91 ;;
esac
`,
    { mode: 0o700 },
  );
  writeFileSync(
    join(scripts, 'lib', 'deploy-lock.sh'),
    `acquire_deploy_lock() {
  printf '%s\n' lock >> "$TEST_EVENTS"
  touch "$TEST_ACQUIRED"
}
require_deploy_lock() { [[ -f "$TEST_ACQUIRED" ]]; }
release_deploy_lock() { :; }
${commandSupervisor}\n`,
  );
  writeFileSync(
    join(binary, 'git'),
    `#!/usr/bin/env bash
set -euo pipefail
if [[ "$1" == rev-parse ]]; then
  if [[ -e "$TEST_ACQUIRED" && "$TEST_DRIFT" == sha ]]; then printf '%s\n' "$TEST_CHANGED_SHA";
  else printf '%s\n' "$MAXIM_EXPECTED_DEPLOY_SHA"; fi
elif [[ "$1" == status ]]; then
  if [[ "$TEST_DIRTY" == 1 || ( -e "$TEST_ACQUIRED" && "$TEST_DRIFT" == dirty ) ]]; then printf '%s\n' ' M changed';
  elif [[ -e "$TEST_ACQUIRED" && "$TEST_DRIFT" == status-failure ]]; then exit 3; fi
else exit 99; fi
`,
  );
  writeFileSync(
    join(binary, 'node'),
    `#!/usr/bin/env bash
[[ $# == 2 && "$1" == "$TEST_ROOT/infra/scripts/backlog-cancellation-host.mjs" && "$2" == --preview ]] || exit 92
printf '%s\n' node >> "$TEST_EVENTS"
printf '%s\n' "$MAXIM_EXPECTED_DEPLOY_SHA" "\${MAXIM_EXPECTED_BACKLOG_RUNTIME_SHA-unset}"
cat > "$TEST_FORWARDED"
`,
  );
  chmodSync(join(binary, 'git'), 0o700);
  chmodSync(join(binary, 'node'), 0o700);
  try {
    const env = {
      ...process.env,
      PATH: `${binary}:${process.env.PATH}`,
      TEST_EVENTS: events,
      TEST_ROOT: directory,
      TEST_FORWARDED: forwarded,
      TEST_ACQUIRED: join(directory, 'acquired'),
      TEST_DRIFT: settings.drift ?? '',
      TEST_CHANGED_SHA: 'f'.repeat(40),
      TEST_DIRTY: settings.dirty ? '1' : '0',
      TEST_POOL: settings.pool ? '1' : '0',
      TEST_DOCKER_UNAVAILABLE: settings.dockerUnavailable ? '1' : '0',
      MAXIM_EXPECTED_DEPLOY_SHA: 'e'.repeat(40),
    };
    delete env.MAXIM_EXPECTED_BACKLOG_RUNTIME_SHA;
    if (Object.hasOwn(settings, 'runtimeSha'))
      env.MAXIM_EXPECTED_BACKLOG_RUNTIME_SHA = settings.runtimeSha;
    const result = spawnSync('bash', [join(scripts, 'vps-backlog-cancellation.sh'), '--preview'], {
      encoding: 'utf8',
      input,
      timeout: 10_000,
      env,
    });
    return {
      ...result,
      input,
      forwarded: existsSync(forwarded) ? readFileSync(forwarded, 'utf8') : '',
      events: existsSync(events) ? readFileSync(events, 'utf8').trim().split('\n') : [],
    };
  } finally {
    rmSync(directory, { recursive: true });
  }
}

test('host shell preserves separate identities and old omitted-runtime entry while checking clean locked source', () => {
  for (const settings of [{}, { runtimeSha: fixture.validApply.sourceSha }]) {
    const result = runHostShell(settings);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.events, ['lock', 'node']);
    assert.equal(result.forwarded, result.input);
    assert.equal(result.stdout, `${'e'.repeat(40)}\n${settings.runtimeSha ?? 'unset'}\n`);
  }
  for (const settings of [{ dirty: true }, { runtimeSha: '' }, { runtimeSha: 'invalid' }]) {
    const result = runHostShell(settings);
    assert.equal(result.status, 2, result.stderr);
    assert.deepEqual(result.events, []);
  }
});

test('host shell refuses source or cleanliness drift after acquiring the deploy lock before launching Node', () => {
  for (const drift of ['sha', 'dirty', 'status-failure']) {
    const result = runHostShell({
      drift,
      runtimeSha: fixture.validApply.sourceSha,
    });
    assert.equal(result.status, 2, result.stderr);
    assert.deepEqual(result.events, ['lock']);
    assert.equal(result.stdout, '');
  }
});

test('host shell refuses a multiworker OCR runtime before forwarding the request', () => {
  const result = runHostShell({ pool: true });
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /only accepts a single OCR worker/u);
  assert.deepEqual(result.events, ['lock']);
  assert.equal(result.forwarded, '');
  assert.equal(result.stdout, '');
});

test('host shell fails closed when the OCR container inventory is unavailable', () => {
  const result = runHostShell({ dockerUnavailable: true });
  assert.equal(result.status, 1, result.stderr);
  assert.deepEqual(result.events, ['lock']);
  assert.equal(result.forwarded, '');
});
