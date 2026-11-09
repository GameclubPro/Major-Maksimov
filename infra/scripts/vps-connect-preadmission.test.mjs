import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const connector = readFileSync(new URL('./vps-connect.sh', import.meta.url), 'utf8');
const start = connector.indexOf('recover_pair_preadmission() (');
const end = connector.indexOf('\ncommand=', start);
assert.ok(start >= 0 && end > start);
const helper = connector.slice(start, end);
const args = [
  'preview',
  '--owner-sha256',
  '26cb8346bc18f328df52a466f26bb0ce17e6a9ee125ca05f2a33b2c1a5096af4',
  '--state-sha256',
  '75e6376ec4527d8ec67fba2dd1d458b341fa23bb410ff9c33fc1e07ca3e20245',
  '--source-sha',
  '4345d1210212ab26c9c892badc8b16e67cb918bc',
  '--operation-id',
  'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
];

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'maxim-preadmission-connector-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const root = join(directory, 'repo');
  mkdirSync(join(root, 'infra/scripts'), { recursive: true });
  mkdirSync(join(root, 'scripts/ci'), { recursive: true });
  copyFileSync(
    new URL('./pair-release-preadmission-recovery.mjs', import.meta.url),
    join(root, 'infra/scripts/pair-release-preadmission-recovery.mjs'),
  );
  writeFileSync(
    join(root, 'scripts/ci/assert-green.mjs'),
    `
import { appendFileSync } from 'node:fs';
appendFileSync(process.env.TEST_CI_LOG, JSON.stringify(process.argv.slice(2)) + String.fromCharCode(10));
process.exit(process.env.TEST_REFUSE_CI === '1' ? 1 : 0);
`,
  );
  function git(...values) {
    const result = spawnSync('git', ['-c', 'core.hooksPath=/dev/null', ...values], {
      cwd: root,
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  }
  git('init', '--initial-branch=main');
  git('add', '.');
  git(
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    'commit',
    '-m',
    'Fixture controller',
  );
  const sha = git('rev-parse', 'HEAD');
  const sent = join(directory, 'sent.mjs');
  const remote = join(directory, 'remote.txt');
  const ciLog = join(directory, 'ci.log');
  function run(values = args, environment = {}) {
    return spawnSync(
      'bash',
      [
        '-c',
        `
set -euo pipefail
shell_quote_args() { printf '%q ' "$@"; }
remote_exec() {
  printf '%s' "$1" > "$TEST_REMOTE_LOG"
  cat > "$TEST_SENT_FILE"
  return "$TEST_REMOTE_STATUS"
}
${helper}
recover_pair_preadmission "$@"
`,
        'fixture',
        ...values,
      ],
      {
        cwd: root,
        encoding: 'utf8',
        timeout: 15000,
        env: {
          ...process.env,
          ROOT_DIR: root,
          MAXIM_VPS_REPO_DIR: '/var/www/Chat_bot',
          TEST_SENT_FILE: sent,
          TEST_REMOTE_LOG: remote,
          TEST_CI_LOG: ciLog,
          TEST_REMOTE_STATUS: '0',
          ...environment,
        },
      },
    );
  }
  return { root, sha, sent, remote, ciLog, run, git };
}

test('preadmission recovery rejects invalid identity and a different checkout before CI or SSH', (t) => {
  const f = fixture(t);
  assert.notEqual(f.run(['apply']).status, 0);
  assert.equal(f.run(args, { MAXIM_VPS_REPO_DIR: '/var/www/other' }).status, 2);
  assert.equal(existsSync(f.ciLog), false);
  assert.equal(existsSync(f.sent), false);
});

test('preadmission recovery refuses a dirty controller before CI or SSH', (t) => {
  const f = fixture(t);
  writeFileSync(join(f.root, 'unfinished.txt'), 'Uncommitted input');
  const result = f.run();
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /clean exact controller/u);
  assert.equal(existsSync(f.ciLog), false);
  assert.equal(existsSync(f.sent), false);
});

test('preadmission recovery requires exact CI even when a general deploy bypass is set', (t) => {
  const f = fixture(t);
  const result = f.run(args, {
    TEST_REFUSE_CI: '1',
    MAXIM_DEPLOY_EMERGENCY_BYPASS: '1',
    MAXIM_DEPLOY_EMERGENCY_REASON: 'Fixture only',
  });
  assert.equal(result.status, 1, result.stderr);
  assert.equal(
    readFileSync(f.ciLog, 'utf8'),
    JSON.stringify([f.sha, '--purpose', 'production']) + String.fromCharCode(10),
  );
  assert.equal(existsSync(f.sent), false);
});

test('preadmission recovery streams committed bytes only after exact CI and keeps operator timeout bounded', (t) => {
  const f = fixture(t);
  const result = f.run(args, { MAXIM_CI_PURPOSE: 'review' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    readFileSync(f.ciLog, 'utf8'),
    JSON.stringify([f.sha, '--purpose', 'production']) + String.fromCharCode(10),
  );
  assert.deepEqual(
    readFileSync(f.sent),
    readFileSync(join(f.root, 'infra/scripts/pair-release-preadmission-recovery.mjs')),
  );
  assert.match(
    readFileSync(f.remote, 'utf8'),
    /^timeout --signal=TERM --kill-after=5s 90s node --input-type=module - preview /u,
  );
  assert.match(connector, /recover-pair-preadmission\)\s+recover_pair_preadmission "\$@"/u);
});

test('preadmission recovery preserves a failed remote outcome without another invocation', (t) => {
  const f = fixture(t);
  const result = f.run(args, { TEST_REMOTE_STATUS: '7' });
  assert.equal(result.status, 7, result.stderr);
  assert.equal(
    readFileSync(f.ciLog, 'utf8'),
    JSON.stringify([f.sha, '--purpose', 'production']) + String.fromCharCode(10),
  );
});

test('preadmission recovery requires an exact preview proof before apply and forwards it once', (t) => {
  const f = fixture(t);
  const withoutProof = ['apply', ...args.slice(1)];
  assert.notEqual(f.run(withoutProof).status, 0);
  assert.equal(existsSync(f.sent), false);
  const proof = 'a'.repeat(64);
  const result = f.run([...withoutProof, '--proof-sha256', proof]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(readFileSync(f.remote, 'utf8'), new RegExp('--proof-sha256 ' + proof));
  assert.equal(
    readFileSync(f.ciLog, 'utf8'),
    JSON.stringify([f.sha, '--purpose', 'production']) + String.fromCharCode(10),
  );
});

test('preadmission recovery refuses a forged clean tree supplied through Git replacement objects', (t) => {
  const f = fixture(t);
  const modulePath = join(f.root, 'infra/scripts/pair-release-preadmission-recovery.mjs');
  writeFileSync(
    modulePath,
    readFileSync(modulePath, 'utf8') + '\n// Replacement bytes must never reach production.\n',
  );
  f.git('add', '.');
  f.git(
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    'commit',
    '-m',
    'Replacement fixture',
  );
  const replacement = f.git('rev-parse', 'HEAD');
  f.git('replace', f.sha, replacement);
  f.git('update-ref', 'refs/heads/main', f.sha);
  assert.equal(f.git('status', '--porcelain'), '');
  const result = f.run(args, { GIT_NO_REPLACE_OBJECTS: '0' });
  assert.equal(result.status, 2, result.stderr);
  assert.equal(existsSync(f.ciLog), false);
  assert.equal(existsSync(f.sent), false);
});
