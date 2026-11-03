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
const start = connector.indexOf('recover_pair_backup_activation() (');
const end = connector.indexOf('\ninstall_pair_release_admission() (', start);
assert.ok(start >= 0 && end > start);
const helper = connector.slice(start, end);
const args = [
  'preview',
  '--owner-sha256',
  'd1cdf926b08aa6ebfad8a1c92dec927eef13ca203c29a6e9b76cda1fd3df8154',
  '--state-sha256',
  'd59770fc8a096cc9d95fb637a1ad1fe20210e1ca2dbf304eba9148754abc1dc8',
  '--source-sha',
  '932c81a1b195d2c0464285fc92ecc364cc613779',
  '--invocation-id',
  '7af37b8a7bab4a6ab480b7f7c519cb49',
];

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'maxim-backup-activation-connector-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const root = join(directory, 'repo');
  mkdirSync(join(root, 'infra/scripts'), { recursive: true });
  mkdirSync(join(root, 'scripts/ci'), { recursive: true });
  copyFileSync(
    new URL('./pair-release-backup-activation-recovery.mjs', import.meta.url),
    join(root, 'infra/scripts/pair-release-backup-activation-recovery.mjs'),
  );
  writeFileSync(
    join(root, 'scripts/ci/assert-green.mjs'),
    `
import { appendFileSync } from 'node:fs';
appendFileSync(process.env.TEST_CI_LOG, process.argv[2] + '\\n');
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
recover_pair_backup_activation "$@"
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
  return { root, sha, sent, remote, ciLog, run };
}

test('activation recovery rejects invalid identity and a different checkout before CI or SSH', (t) => {
  const f = fixture(t);
  assert.notEqual(f.run(['apply']).status, 0);
  assert.equal(f.run(args, { MAXIM_VPS_REPO_DIR: '/var/www/other' }).status, 2);
  assert.equal(existsSync(f.ciLog), false);
  assert.equal(existsSync(f.sent), false);
});

test('activation recovery refuses a dirty controller before CI or SSH', (t) => {
  const f = fixture(t);
  writeFileSync(join(f.root, 'unfinished.txt'), 'Uncommitted input');
  const result = f.run();
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /clean exact controller/u);
  assert.equal(existsSync(f.ciLog), false);
  assert.equal(existsSync(f.sent), false);
});

test('activation recovery requires exact CI even when a general deploy bypass is set', (t) => {
  const f = fixture(t);
  const result = f.run(args, {
    TEST_REFUSE_CI: '1',
    MAXIM_DEPLOY_EMERGENCY_BYPASS: '1',
    MAXIM_DEPLOY_EMERGENCY_REASON: 'Fixture only',
  });
  assert.equal(result.status, 1, result.stderr);
  assert.equal(readFileSync(f.ciLog, 'utf8'), `${f.sha}\n`);
  assert.equal(existsSync(f.sent), false);
});

test('activation recovery streams committed bytes only after exact CI and keeps root timeout bounded', (t) => {
  const f = fixture(t);
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(f.ciLog, 'utf8'), `${f.sha}\n`);
  assert.deepEqual(
    readFileSync(f.sent),
    readFileSync(join(f.root, 'infra/scripts/pair-release-backup-activation-recovery.mjs')),
  );
  assert.match(
    readFileSync(f.remote, 'utf8'),
    /^sudo -n timeout --signal=TERM --kill-after=5s 90s node --input-type=module - preview /u,
  );
  assert.match(
    connector,
    /recover-pair-backup-activation\)\s+recover_pair_backup_activation "\$@"/u,
  );
});

test('activation recovery preserves a failed remote outcome without another invocation', (t) => {
  const f = fixture(t);
  const result = f.run(args, { TEST_REMOTE_STATUS: '7' });
  assert.equal(result.status, 7, result.stderr);
  assert.equal(readFileSync(f.ciLog, 'utf8'), `${f.sha}\n`);
});
