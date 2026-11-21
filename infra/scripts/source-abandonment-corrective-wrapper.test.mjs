import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = fileURLToPath(new URL('../../', import.meta.url));
const connector = readFileSync(new URL('./vps-connect.sh', import.meta.url), 'utf8');
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
const start = connector.indexOf('source_abandonment_corrective() {');
const end = connector.indexOf('\nremote_from_args() {', start);
assert.ok(start > 0 && end > start);
const helper = connector.slice(start, end);
const quoteStart = connector.indexOf('shell_quote_args() {');
const quoteEnd = connector.indexOf('\nssh_args() {', quoteStart);
const quoteHelper = connector.slice(quoteStart, quoteEnd);
const controllerSha = 'c'.repeat(40);
const runtimeSha = 'a'.repeat(40);
const envelope = (operation = 'apply') => ({
  version: 1,
  controllerSha,
  runtimeRequest: {
    version: 1,
    operation,
    targetSha: runtimeSha,
    expectedJournalDigest: 'b'.repeat(64),
    ...(operation === 'retry-preview'
      ? {}
      : { reviewedPreviewDigest: 'd'.repeat(64), reviewedInventoryDigest: 'e'.repeat(64) }),
  },
});

function directory(t) {
  const dir = mkdtempSync(join(tmpdir(), 'maxim-corrective-wrapper-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function readOrEmpty(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return '';
    throw error;
  }
}

function localCall(t, options = {}) {
  const dir = directory(t);
  const trace = join(dir, 'trace');
  const forwarded = join(dir, 'forwarded');
  const path = join(dir, 'private-envelope.json');
  const text = options.text ?? `${JSON.stringify(options.envelope ?? envelope(), null, 2)}\n`;
  writeFileSync(path, text, { mode: options.mode ?? 0o600 });
  if (options.mode) chmodSync(path, options.mode);
  let input = path;
  if (options.symlink) {
    input = join(dir, 'link');
    symlinkSync(path, input);
  }
  if (options.hardlink) linkSync(path, join(dir, 'second-link'));
  const script = `set -euo pipefail
${quoteHelper}
${helper}
git() { printf '%s\\n' "$FIXTURE_CONTROLLER_SHA"; }
node() {
  if [[ "$1" == "$ROOT_DIR/scripts/ci/assert-green.mjs" ]]; then
    printf 'CI %s\\n' "$2" >> "$FIXTURE_TRACE"
    return "$FIXTURE_CI_STATUS"
  fi
  "$FIXTURE_NODE" "$@"
}
remote_exec() {
  printf 'REMOTE %s\\n' "$1" >> "$FIXTURE_TRACE"
  cat > "$FIXTURE_FORWARDED"
}
source_abandonment_corrective "$@"
`;
  const result = spawnSync('bash', ['-c', script, 'fixture', ...(options.noArgs ? [] : [input])], {
    encoding: 'utf8',
    env: {
      ...process.env,
      ROOT_DIR: root,
      FIXTURE_CONTROLLER_SHA: options.localSha ?? controllerSha,
      FIXTURE_TRACE: trace,
      FIXTURE_FORWARDED: forwarded,
      FIXTURE_CI_STATUS: String(options.ciStatus ?? 0),
      FIXTURE_NODE: process.execPath,
      MAXIM_DEPLOY_EMERGENCY_BYPASS: options.bypass ?? '0',
      MAXIM_DEPLOY_EMERGENCY_REASON: options.reason ?? '',
    },
  });
  return { ...result, text, trace: readOrEmpty(trace), forwarded: readOrEmpty(forwarded) };
}

test('connector admits green exact controller while forwarding the unchanged older runtime request', (t) => {
  for (const operation of ['apply', 'reconcile', 'retry-preview', 'refreeze-preview']) {
    const result = localCall(t, { envelope: envelope(operation) });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.forwarded, result.text);
    assert.equal(
      result.trace,
      `CI ${controllerSha}\nREMOTE env MAXIM_EXPECTED_CONTROLLER_SHA=${controllerSha} bash ./infra/scripts/vps-source-abandonment-corrective.sh \n`,
    );
    assert.doesNotMatch(result.trace, /git (?:pull|fetch)|MAXIM_EXPECTED_DEPLOY_SHA/u);
  }
});

test('invalid private files and controller requests stop before CI or SSH', (t) => {
  for (const options of [
    { noArgs: true },
    { mode: 0o644 },
    { symlink: true },
    { hardlink: true },
    { text: ' '.repeat(65537) },
    { text: '{"private":"do-not-print",' },
    { localSha: 'f'.repeat(40) },
    { envelope: { ...envelope(), version: 2 } },
    { envelope: { ...envelope(), extra: true } },
    ...['status', 'preflight', 'prepare'].map((operation) => ({ envelope: envelope(operation) })),
  ]) {
    const result = localCall(t, options);
    assert.notEqual(result.status, 0);
    assert.equal(result.trace, '');
    assert.equal(result.forwarded, '');
    assert.doesNotMatch(result.stderr, /do-not-print/u);
  }
});

test('failed exact controller CI stops before SSH', (t) => {
  const result = localCall(t, { ciStatus: 7 });
  assert.equal(result.status, 7);
  assert.equal(result.trace, `CI ${controllerSha}\n`);
  assert.equal(result.forwarded, '');
});

test('emergency CI exception requires an explicit reason and retains controller and request binding', (t) => {
  for (const options of [
    { bypass: '1' },
    { bypass: '1', reason: ' \t\n ' },
    { bypass: 'true', reason: 'reviewed' },
    { bypass: '2', reason: 'reviewed' },
  ]) {
    const result = localCall(t, options);
    assert.equal(result.status, 2);
    assert.equal(result.trace, '');
    assert.equal(result.forwarded, '');
  }
  const reason = 'Stopped fleet; same reviewed recovery with corrected inventory comparison';
  const result = localCall(t, { bypass: '1', reason, ciStatus: 7 });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.forwarded, result.text);
  assert.equal(
    result.trace,
    `REMOTE env MAXIM_EXPECTED_CONTROLLER_SHA=${controllerSha} bash ./infra/scripts/vps-source-abandonment-corrective.sh \n`,
  );
  assert.equal(result.stderr, `Emergency corrective controller admission: ${reason}\n`);
  const wrongSource = localCall(t, { bypass: '1', reason, localSha: 'f'.repeat(40) });
  assert.notEqual(wrongSource.status, 0);
  assert.equal(wrongSource.trace, '');
});

function remoteCall(t, overrides = {}, args = []) {
  const dir = directory(t);
  const scripts = join(dir, 'infra/scripts');
  const binaries = join(dir, 'bin');
  const trace = join(dir, 'trace');
  const forwarded = join(dir, 'forwarded');
  mkdirSync(join(scripts, 'lib'), { recursive: true });
  mkdirSync(binaries);
  const wrapper = join(scripts, 'vps-source-abandonment-corrective.sh');
  copyFileSync(new URL('./vps-source-abandonment-corrective.sh', import.meta.url), wrapper);
  for (const name of ['deploy-topology.sh', 'photo-native-lifecycle.sh'])
    copyFileSync(new URL(`./lib/${name}`, import.meta.url), join(scripts, 'lib', name));
  writeFileSync(
    join(binaries, 'docker'),
    `#!/usr/bin/env bash
set -euo pipefail
[[ "\${FIXTURE_LOCK_HELD:-}" == 1 ]] || exit 91
case "$*" in
  'ps --all --quiet --no-trunc --filter label=com.docker.compose.project=infra --filter label=com.docker.compose.service=ocr-native-sandbox-2')
    if [[ "$FIXTURE_EXTRA_OCR_WORKER" == 1 ]]; then printf '%064d\\n' 2; fi ;;
  'ps --all --quiet --no-trunc --filter label=com.docker.compose.project=infra --filter label=com.docker.compose.service=ocr-native-sandbox-3') ;;
  *) exit 90 ;;
esac
`,
    { mode: 0o700 },
  );
  writeFileSync(
    join(scripts, 'lib/deploy-lock.sh'),
    `acquire_deploy_lock() {
  printf 'LOCK\\n' >> "$FIXTURE_TRACE"
  [[ "$FIXTURE_LOCK_STATUS" == 0 ]] || return "$FIXTURE_LOCK_STATUS"
  export FIXTURE_LOCK_HELD=1
}
require_deploy_lock() { [[ "\${FIXTURE_LOCK_HELD:-}" == 1 ]]; }
release_deploy_lock() { :; }
${commandSupervisor}
`,
  );
  writeFileSync(
    join(binaries, 'git'),
    `#!/usr/bin/env bash
set -euo pipefail
case "$*" in
  'rev-parse HEAD')
    [[ "$FIXTURE_GIT_FAILURE" != head ]] || exit 93
    if [[ "\${FIXTURE_LOCK_HELD:-}" == 1 && "$FIXTURE_CHANGED_AFTER_LOCK" == 1 ]]; then
      printf '%s\\n' '${'f'.repeat(40)}'
    else printf '%s\\n' "$FIXTURE_REMOTE_SHA"; fi ;;
  'status --porcelain --untracked-files=no')
    [[ "$FIXTURE_GIT_FAILURE" != status ]] || exit 93
    if [[ "$FIXTURE_DIRTY" == 1 || ( "\${FIXTURE_LOCK_HELD:-}" == 1 && "$FIXTURE_DIRTY_AFTER_LOCK" == 1 ) ]]; then
      printf ' M tracked-file\\n'
    fi ;;
  *) exit 90 ;;
esac
`,
    { mode: 0o700 },
  );
  writeFileSync(
    join(binaries, 'node'),
    `#!/usr/bin/env bash
set -euo pipefail
[[ "\${FIXTURE_LOCK_HELD:-}" == 1 ]] || exit 91
[[ $# == 1 && "$1" == "$FIXTURE_ROOT/infra/scripts/source-abandonment-corrective-host.mjs" ]] || exit 92
printf 'EXEC\\n' >> "$FIXTURE_TRACE"
cat > "$FIXTURE_FORWARDED"
`,
    { mode: 0o700 },
  );
  const text = `${JSON.stringify(envelope())}\n`;
  const result = spawnSync('bash', [wrapper, ...args], {
    encoding: 'utf8',
    input: text,
    env: {
      ...process.env,
      PATH: `${binaries}:${dirname(process.execPath)}:/usr/bin:/bin`,
      MAXIM_EXPECTED_CONTROLLER_SHA: controllerSha,
      FIXTURE_ROOT: dir,
      FIXTURE_REMOTE_SHA: controllerSha,
      FIXTURE_TRACE: trace,
      FIXTURE_FORWARDED: forwarded,
      FIXTURE_DIRTY: '0',
      FIXTURE_DIRTY_AFTER_LOCK: '0',
      FIXTURE_LOCK_STATUS: '0',
      FIXTURE_LOCK_HELD: '',
      FIXTURE_EXTRA_OCR_WORKER: '0',
      FIXTURE_CHANGED_AFTER_LOCK: '0',
      FIXTURE_GIT_FAILURE: '',
      ...overrides,
    },
  });
  return { ...result, text, trace: readOrEmpty(trace), forwarded: readOrEmpty(forwarded) };
}

test('remote wrapper runs the exact clean controller under the existing lock with unchanged stdin', (t) => {
  const result = remoteCall(t);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.trace, 'LOCK\nEXEC\n');
  assert.equal(result.forwarded, result.text);
});

test('remote source, tracked dirt and lock failures never execute the controller', (t) => {
  for (const overrides of [
    { MAXIM_EXPECTED_CONTROLLER_SHA: '' },
    { MAXIM_EXPECTED_CONTROLLER_SHA: runtimeSha },
    { MAXIM_EXPECTED_CONTROLLER_SHA: 'main' },
    { FIXTURE_DIRTY: '1' },
    { FIXTURE_LOCK_STATUS: '7' },
    { FIXTURE_CHANGED_AFTER_LOCK: '1' },
    { FIXTURE_DIRTY_AFTER_LOCK: '1' },
    { FIXTURE_GIT_FAILURE: 'head' },
    { FIXTURE_GIT_FAILURE: 'status' },
  ]) {
    const result = remoteCall(t, overrides);
    assert.notEqual(result.status, 0);
    assert.doesNotMatch(result.trace, /EXEC/u);
    assert.equal(result.forwarded, '');
  }
  const extra = remoteCall(t, {}, ['unexpected']);
  assert.equal(extra.status, 2);
  assert.equal(extra.trace, '');
});


test('remote corrective wrapper refuses a multiworker OCR runtime before executing the controller', (t) => {
  const result = remoteCall(t, { FIXTURE_EXTRA_OCR_WORKER: '1' });
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /only accepts a single OCR worker/u);
  assert.equal(result.trace, 'LOCK\n');
  assert.equal(result.forwarded, '');
});
