import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { assertServiceOrigin } from './release-service-admission.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const script = (name) => join(root, 'infra/scripts', name);
const quote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;

test('installation preview succeeds without privileges, host access or system mutations', () => {
  const result = spawnSync('/bin/bash', [script('install-release-service.sh'), '--plan'], {
    encoding: 'utf8',
    timeout: 3000,
    env: { PATH: '/usr/bin:/bin' },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /does not start or enable/u);
  assert.match(result.stdout, /automatic releases disabled/u);
  assert.match(result.stdout, /existing shared deploy locks, complete manifest/u);
  assert.doesNotMatch(result.stdout, /backup\/restore acceptance/u);
  assert.doesNotMatch(
    fs.readFileSync(script('install-release-service.sh'), 'utf8'),
    /maxim-release-recovery-accepted|backupEvidenceSha256|isolatedRestoreEvidenceSha256/u,
  );
  assert.match(result.stdout, /git-read-key/u);
});

test('service Git origin accepts only the canonical HTTPS or exact repository SSH identity', () => {
  for (const origin of [
    'https://github.com/GameclubPro/Major-Maksimov.git',
    'git@github.com:GameclubPro/Major-Maksimov.git',
    'ssh://git@github.com/GameclubPro/Major-Maksimov.git',
    'ssh://git@ssh.github.com:443/GameclubPro/Major-Maksimov.git',
  ])
    assertServiceOrigin(origin);
  for (const origin of [
    '',
    'https://github.com/GameclubPro/MAXIM.git',
    'git@github.com:GameclubPro/MAXIM.git',
    'https://github.com/attacker/Major-Maksimov.git',
    'https://github.com.evil/GameclubPro/Major-Maksimov.git',
    'https://github.com/GameclubPro/Major-Maksimov.git/other',
    'https://github.com/GameclubPro/Major-Maksimov.git?redirect=other',
    'https://github.com/GameclubPro/Major-Maksimov.git\n',
    'git@github.com:attacker/repo.git',
    'ssh://git@github.com.evil/GameclubPro/Major-Maksimov.git',
    'git@github.com:GameclubPro/Major-Maksimov.git\n',
  ]) {
    assert.throws(() => assertServiceOrigin(origin), { code: 'GIT_ORIGIN_UNPROVED' });
  }
});

test('service SSH ignores interactive config/agent and preserves strict explicit host trust', () => {
  const directory = fs.mkdtempSync(join(tmpdir(), 'maxim-service-ssh-'));
  const captured = join(directory, 'argv');
  try {
    const harness = `exec() { printf '%s\\0' "$@" > ${quote(captured)}; }; source ${quote(script('release-service-git-ssh.sh'))} "$@"`;
    const result = spawnSync(
      '/bin/bash',
      [
        '--noprofile',
        '--norc',
        '-c',
        harness,
        'test',
        'git@github.com',
        "git-upload-pack 'GameclubPro/Major-Maksimov.git'",
      ],
      {
        encoding: 'utf8',
        timeout: 3000,
        env: { PATH: '/usr/bin:/bin', HOME: directory, SSH_AUTH_SOCK: '/untrusted/agent' },
      },
    );
    assert.equal(result.status, 0, result.stderr);
    const args = fs.readFileSync(captured, 'utf8').split('\0').slice(0, -1);
    assert.equal(args[0], '/usr/bin/ssh');
    assert.equal(args[args.indexOf('-F') + 1], '/dev/null');
    assert.equal(args[args.indexOf('-i') + 1], '/etc/maxim-deploy/git-read-key');
    for (const option of [
      'IdentitiesOnly=yes',
      'IdentityAgent=none',
      'BatchMode=yes',
      'StrictHostKeyChecking=yes',
      'UserKnownHostsFile=/etc/maxim-deploy/git-known-hosts',
      'GlobalKnownHostsFile=/dev/null',
      'HostName=ssh.github.com',
      'HostKeyAlias=github.com',
    ])
      assert.ok(args.includes(option), option);
    assert.equal(args[args.indexOf('-p') + 1], '443');
    assert.deepEqual(args.slice(-2), [
      'git@github.com',
      "git-upload-pack 'GameclubPro/Major-Maksimov.git'",
    ]);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('unit preserves global legacy-lock visibility and confines the administrative home', () => {
  const source = fs.readFileSync(join(root, 'infra/systemd/maxim-release.service'), 'utf8');
  assert.doesNotMatch(source, /^PrivateTmp=(?:true|yes|1)$/mu);
  assert.match(source, /^ProtectHome=true$/mu);
  assert.match(source, /^KillMode=process$/mu);
  assert.match(source, /^RuntimeDirectory=maxim-release$/mu);
  assert.match(source, /^NoNewPrivileges=false$/mu);
  assert.match(source, /^RestrictSUIDSGID=true$/mu);
});
