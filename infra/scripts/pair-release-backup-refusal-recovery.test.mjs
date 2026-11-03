import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile, readFile, lstat, rm, access, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  parseBackupRefusalRecoveryArgs,
  buildBackupRefusalProof,
  recoverBackupRefusal,
  withBackupRefusalLocks,
  archiveBackupRefusal,
  matchesBackupRefusalUnit,
  observeBackupRefusalSourceGit,
} from './pair-release-backup-refusal-recovery.mjs';

const digest = (value) => createHash('sha256').update(value).digest('hex');
const SOURCE = '895cc0cbe10bae80a3379348fc98a355699d20d2';
const BOOT = '01234567-89ab-cdef-0123-456789abcdef';
const INVOCATION = 'f'.repeat(32);

function fixture() {
  const snapshot = {
    schemaVersion: 1,
    protocol: 'major-karavan-release-v1',
    major: { checkoutSha: SOURCE, manifestSha256: 'a'.repeat(64) },
    karavan: { checkoutSha: 'b'.repeat(40), manifestSha256: 'c'.repeat(64) },
    configuration: { majorSha256: 'd'.repeat(64), karavanSha256: 'e'.repeat(64) },
  };
  const old = structuredClone(snapshot);
  old.major.checkoutSha = null;
  old.karavan.checkoutSha = null;
  const initial = digest(JSON.stringify(old));
  let owner = `protocol=major-karavan-release-v1\ntoken=${BOOT}\nproduct=major\nmode=runtime\ntarget=\npid=3679474\nstart=1\nboot=${BOOT}\ncwd=${digest('/var/www/Chat_bot')}\nfd=10\ninode=57:81811201\ninitial_state=${initial}\nstarted_at=2026-10-31T09:16:48.863Z\n`;
  owner = owner.replace('start=1\n', `start=${'1'.repeat(394 - Buffer.byteLength(owner))}\n`);
  assert.equal(Buffer.byteLength(owner), 393);
  const request = {
    mode: 'preview',
    sourceSha: SOURCE,
    ownerSha256: digest(owner),
    initialStateSha256: initial,
    stateSha256: digest(JSON.stringify(snapshot)),
    invocationId: INVOCATION,
  };
  const observation = {
    root: true,
    locksHeld: true,
    ownerBytes: Buffer.from(owner),
    ownerUid: 0,
    ownerMode: 0o600,
    ownerLinks: 1,
    operatorUid: 1000,
    admissionInode: '57:81811201',
    bootId: BOOT,
    originalProcessAbsent: true,
    noActors: true,
    legacySourcesMatch: true,
    unitMatches: true,
    unit: {
      ActiveState: 'inactive',
      SubState: 'dead',
      MainPID: '0',
      Result: 'success',
      ExecMainCode: '0',
      ExecMainStatus: '0',
      InvocationID: '',
      DropInPaths: '',
      FragmentPath: '/etc/systemd/system/maxim-postgres-backup.service',
    },
    journal: [
      {
        _SYSTEMD_INVOCATION_ID: INVOCATION,
        _SYSTEMD_UNIT: 'maxim-postgres-backup.service',
        _PID: '3679474',
        _UID: '0',
        _COMM: 'bash',
        SYSLOG_IDENTIFIER: 'backup-postgres.sh',
        _BOOT_ID: BOOT.replaceAll('-', ''),
        __REALTIME_TIMESTAMP: '1793438208938316',
        MESSAGE:
          'Refusing PostgreSQL backup while a deployment or maintenance operation is active.',
      },
    ],
    snapshot,
  };
  return { request, observation };
}

test('requires exact reviewed source and all five caller-bound identities', () => {
  const { request } = fixture();
  const args = [
    'preview',
    '--owner-sha256',
    request.ownerSha256,
    '--initial-state-sha256',
    request.initialStateSha256,
    '--state-sha256',
    request.stateSha256,
    '--source-sha',
    SOURCE,
    '--invocation-id',
    INVOCATION,
  ];
  assert.deepEqual(parseBackupRefusalRecoveryArgs(args), request);
  assert.throws(() => parseBackupRefusalRecoveryArgs(args.slice(0, -2)));
  assert.throws(() =>
    parseBackupRefusalRecoveryArgs(
      args.map((value) => (value === SOURCE ? 'a'.repeat(40) : value)),
    ),
  );
  assert.throws(() =>
    parseBackupRefusalRecoveryArgs([...args.slice(0, -2), '--source-sha', SOURCE]),
  );
});

test('the connector stdin validator imports recovery without starting its CLI', async () => {
  const root = fileURLToPath(new URL('../../', import.meta.url));
  const connector = await readFile(new URL('./vps-connect.sh', import.meta.url), 'utf8');
  const importer = connector.match(
    /node --input-type=module - "\$ROOT_DIR" "\$@" <<'NODE'\n(?<source>[\s\S]*?)\nNODE/u,
  )?.groups?.source;
  assert.ok(importer, 'the actual connector stdin validator must be exercised');
  const { request } = fixture();
  for (const mode of ['preview', 'apply']) {
    const child = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-',
        root,
        mode,
        '--owner-sha256',
        request.ownerSha256,
        '--initial-state-sha256',
        request.initialStateSha256,
        '--state-sha256',
        request.stateSha256,
        '--source-sha',
        request.sourceSha,
        '--invocation-id',
        request.invocationId,
      ],
      { input: importer, encoding: 'utf8', timeout: 5_000, maxBuffer: 65_536 },
    );
    assert.ifError(child.error);
    assert.equal(child.signal, null);
    assert.equal(child.status, 0, child.stderr);
    assert.equal(child.stdout, '');
    assert.equal(child.stderr, '');
  }
});

for (const entry of ['direct file', 'streamed stdin']) {
  test(`${entry} CLI rejects invalid arguments before observing production paths`, async () => {
    const source = new URL('./pair-release-backup-refusal-recovery.mjs', import.meta.url);
    const child = spawnSync(
      process.execPath,
      entry === 'direct file'
        ? [fileURLToPath(source), 'invalid-mode']
        : ['--input-type=module', '-', 'invalid-mode'],
      {
        ...(entry === 'streamed stdin' ? { input: await readFile(source, 'utf8') } : {}),
        encoding: 'utf8',
        timeout: 5_000,
        maxBuffer: 65_536,
      },
    );
    assert.ifError(child.error);
    assert.equal(child.signal, null);
    assert.equal(child.status, 1);
    assert.equal(child.stdout, '');
    assert.deepEqual(JSON.parse(child.stderr), { ok: false, code: 'invalid_arguments' });
  });
}

test('preview proves only the observed pre-product-lock refusal and performs no archival', async () => {
  const { request, observation } = fixture();
  let observations = 0;
  const proof = await recoverBackupRefusal(request, {
    observe: async () => {
      observations++;
      return observation;
    },
    archive: async () => assert.fail('preview cannot mutate'),
  });
  assert.equal(observations, 1);
  assert.equal(proof.archived, false);
  assert.equal(proof.ownerSha256, request.ownerSha256);
  assert.equal(proof.refusalAt, '2026-10-31T09:16:48.938Z');
  assert.equal(JSON.stringify(proof).includes('token='), false);
});

test('retained systemd exit75 is accepted only for the exact completed invocation', () => {
  const { request, observation } = fixture();
  Object.assign(observation.unit, {
    ExecMainCode: '1',
    ExecMainStatus: '75',
    InvocationID: INVOCATION,
  });
  assert.equal(buildBackupRefusalProof(request, observation).sourceSha, SOURCE);
  observation.unit.InvocationID = 'a'.repeat(32);
  assert.throws(
    () => buildBackupRefusalProof(request, observation),
    /backup_service_not_quiescent/u,
  );
});

test('pins the observed historical service and refuses profile wrappers or extra effects', () => {
  const unit = `[Unit]\nDescription=MAXIM validated PostgreSQL backup\nRequires=docker.service\nAfter=docker.service\nConditionPathExists=/var/www/Chat_bot/infra/scripts/backup-postgres.sh\n\n[Service]\nType=oneshot\nWorkingDirectory=/var/www/Chat_bot\nEnvironmentFile=-/etc/maxim-postgres-backup.env\nExecStart=/var/www/Chat_bot/infra/scripts/backup-postgres.sh\nSuccessExitStatus=75\nTimeoutStartSec=18h15m\nTimeoutStopSec=1m\nKillSignal=SIGTERM\nRestart=no\nUMask=0077\nNice=10\nIOSchedulingClass=best-effort\nIOSchedulingPriority=7\n`;
  assert.equal(matchesBackupRefusalUnit(unit), true);
  assert.equal(
    matchesBackupRefusalUnit(
      unit.replace('ExecStart=', 'ExecStart=/usr/bin/env MAXIM_BACKUP_PROFILE=maxim '),
    ),
    false,
  );
  assert.equal(matchesBackupRefusalUnit(`${unit}ExecStartPost=/usr/bin/true\n`), false);
  assert.equal(matchesBackupRefusalUnit(`${unit}Environment=MAXIM_BACKUP_PROFILE=eraser\n`), false);
});

const refusals = [
  [
    'non-root',
    (x) => {
      x.root = false;
    },
  ],
  [
    'missing locks',
    (x) => {
      x.locksHeld = false;
    },
  ],
  [
    'non-root owner',
    (x) => {
      x.ownerUid = 1000;
    },
  ],
  [
    'world-readable owner',
    (x) => {
      x.ownerMode = 0o644;
    },
  ],
  [
    'hardlinked owner',
    (x) => {
      x.ownerLinks = 2;
    },
  ],
  [
    'different lock inode',
    (x) => {
      x.admissionInode = '57:42';
    },
  ],
  [
    'different boot',
    (x) => {
      x.bootId = 'f'.repeat(36);
    },
  ],
  [
    'live or reused PID',
    (x) => {
      x.originalProcessAbsent = false;
    },
  ],
  [
    'remaining actor',
    (x) => {
      x.noActors = false;
    },
  ],
  [
    'changed legacy controller',
    (x) => {
      x.legacySourcesMatch = false;
    },
  ],
  [
    'different service commands',
    (x) => {
      x.unitMatches = false;
    },
  ],
  [
    'active service',
    (x) => {
      x.unit.ActiveState = 'activating';
    },
  ],
  [
    'drop-in override',
    (x) => {
      x.unit.DropInPaths = '/etc/systemd/system/unsafe.conf';
    },
  ],
  [
    'unknown service exit',
    (x) => {
      x.unit.ExecMainStatus = '143';
    },
  ],
  [
    'missing journal',
    (x) => {
      x.journal = [];
    },
  ],
  [
    'extra journal outcome',
    (x) => {
      x.journal.push({ MESSAGE: 'unknown' });
    },
  ],
  [
    'wrong journal unit',
    (x) => {
      x.journal[0]._SYSTEMD_UNIT = 'other.service';
    },
  ],
  [
    'wrong journal invocation',
    (x) => {
      x.journal[0]._SYSTEMD_INVOCATION_ID = 'b'.repeat(32);
    },
  ],
  [
    'wrong journal PID',
    (x) => {
      x.journal[0]._PID = '1';
    },
  ],
  [
    'unprivileged journal',
    (x) => {
      x.journal[0]._UID = '1000';
    },
  ],
  [
    'wrong journal boot',
    (x) => {
      x.journal[0]._BOOT_ID = 'f'.repeat(32);
    },
  ],
  [
    'other refusal',
    (x) => {
      x.journal[0].MESSAGE = 'readiness refused';
    },
  ],
  [
    'late journal',
    (x) => {
      x.journal[0].__REALTIME_TIMESTAMP = '1793438220000000';
    },
  ],
  [
    'changed source',
    (x) => {
      x.snapshot.major.checkoutSha = 'a'.repeat(40);
    },
  ],
  [
    'unknown peer source',
    (x) => {
      x.snapshot.karavan.checkoutSha = null;
    },
  ],
  [
    'changed environment',
    (x) => {
      x.snapshot.configuration.majorSha256 = 'f'.repeat(64);
    },
  ],
];
for (const [name, mutate] of refusals) {
  test(`refuses ${name} before any archival`, async () => {
    const { request, observation } = fixture();
    mutate(observation);
    await assert.rejects(
      recoverBackupRefusal(
        { ...request, mode: 'apply' },
        {
          observe: async () => observation,
          archive: async () => assert.fail('invalid evidence cannot mutate'),
        },
      ),
    );
  });
}

test('a fresh caller fingerprint cannot disguise drift from the original root snapshot', () => {
  const { request, observation } = fixture();
  observation.snapshot.configuration.majorSha256 = 'f'.repeat(64);
  request.stateSha256 = digest(JSON.stringify(observation.snapshot));
  assert.throws(
    () => buildBackupRefusalProof(request, observation),
    /original_pair_state_changed/u,
  );
});

test('owner hash changes and runtime targets never gain no-write recovery', () => {
  const { request, observation } = fixture();
  request.ownerSha256 = 'f'.repeat(64);
  assert.throws(() => buildBackupRefusalProof(request, observation), /owner_changed/u);
  observation.ownerBytes = Buffer.from(
    Buffer.from(observation.ownerBytes)
      .toString()
      .replace('target=\n', `target=${'a'.repeat(40)}\n`),
  );
  request.ownerSha256 = digest(observation.ownerBytes);
  assert.throws(() => buildBackupRefusalProof(request, observation), /unexpected_owner_size/u);
});

test('apply reobserves all evidence and never archives after a late lock or state loss', async () => {
  for (const field of ['locksHeld', 'noActors', 'legacySourcesMatch']) {
    const { request, observation } = fixture();
    let count = 0;
    await assert.rejects(
      recoverBackupRefusal(
        { ...request, mode: 'apply' },
        {
          observe: async () => {
            const next = structuredClone(observation);
            if (++count === 2) next[field] = false;
            return next;
          },
          archive: async () => assert.fail('late loss cannot mutate'),
        },
      ),
    );
    assert.equal(count, 2);
  }
});

async function temporary(t) {
  const directory = await mkdtemp(join(tmpdir(), 'maxim-backup-refusal-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test('real flock descriptions remain fenced after helper loss until parent cleanup', async (t) => {
  const directory = await temporary(t);
  const paths = [0, 1, 2].map((id) => join(directory, `lock-${id}`));
  await Promise.all(paths.map((path) => writeFile(path, '', { mode: 0o600 })));
  const inodes = await Promise.all(paths.map(async (path) => (await lstat(path)).ino));
  await withBackupRefusalLocks(paths, async ({ assertLocks, holderPid }) => {
    await assertLocks();
    for (const path of paths)
      assert.notEqual(spawnSync('flock', ['-n', '--shared', path, 'true']).status, 0);
    process.kill(holderPid, 'SIGKILL');
    await new Promise((resolve) => setTimeout(resolve, 30));
    await assert.rejects(assertLocks());
    for (const path of paths)
      assert.notEqual(spawnSync('flock', ['-n', '--shared', path, 'true']).status, 0);
  });
  for (const path of paths)
    assert.equal(spawnSync('flock', ['-n', '--shared', path, 'true']).status, 0);
  assert.deepEqual(await Promise.all(paths.map(async (path) => (await lstat(path)).ino)), inodes);
});

test('archives exact original bytes and proof while preserving all persistent lock inodes', async (t) => {
  const directory = await temporary(t);
  const { request, observation } = fixture();
  const ownerPath = join(directory, 'admission.owner');
  await writeFile(ownerPath, observation.ownerBytes, { mode: 0o600 });
  const ownerInode = (await lstat(ownerPath)).ino;
  const paths = [0, 1, 2].map((id) => join(directory, `lock-${id}`));
  await Promise.all(paths.map((path) => writeFile(path, '', { mode: 0o600 })));
  const proof = buildBackupRefusalProof(request, observation);
  const archiveDirectory = join(directory, 'archive');
  await withBackupRefusalLocks(paths, async ({ assertLocks }) => {
    await archiveBackupRefusal({
      ownerPath,
      archiveDirectory,
      operatorUid: process.getuid(),
      operatorGid: process.getgid(),
      ownerBytes: observation.ownerBytes,
      proof,
      assertLocks,
    });
  });
  await assert.rejects(access(ownerPath), { code: 'ENOENT' });
  const archived = join(archiveDirectory, `${request.ownerSha256}.owner`);
  assert.deepEqual(await readFile(archived), observation.ownerBytes);
  assert.equal((await lstat(archived)).ino, ownerInode);
  assert.deepEqual(
    JSON.parse(await readFile(join(archiveDirectory, `${request.ownerSha256}.proof.json`), 'utf8')),
    proof,
  );
  assert.equal((await lstat(archiveDirectory)).mode & 0o777, 0o700);
});

test('a lock-holder loss before rename retains original and durable proof for exact resume', async (t) => {
  const directory = await temporary(t);
  const { request, observation } = fixture();
  const ownerPath = join(directory, 'admission.owner');
  await writeFile(ownerPath, observation.ownerBytes, { mode: 0o600 });
  const proof = buildBackupRefusalProof(request, observation);
  const options = {
    ownerPath,
    archiveDirectory: join(directory, 'archive'),
    operatorUid: process.getuid(),
    operatorGid: process.getgid(),
    ownerBytes: observation.ownerBytes,
    proof,
  };
  let calls = 0;
  await assert.rejects(
    archiveBackupRefusal({
      ...options,
      assertLocks: async () => {
        if (++calls === 2) throw new Error('lost');
      },
    }),
    /lost/u,
  );
  assert.deepEqual(await readFile(ownerPath), observation.ownerBytes);
  assert.equal(
    (await lstat(join(options.archiveDirectory, `${request.ownerSha256}.proof.json`))).isFile(),
    true,
  );
  await archiveBackupRefusal({ ...options, assertLocks: async () => {} });
  assert.deepEqual(
    await readFile(join(options.archiveDirectory, `${request.ownerSha256}.owner`)),
    observation.ownerBytes,
  );
});

test('refusal source Git reads preserve the index despite stale file stats and inherited optional locks', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'maxim-refusal-git-read-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const git = (...args) => {
    const result = spawnSync('git', ['-C', directory, ...args], {
      encoding: 'utf8',
      timeout: 5000,
    });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  };
  git('init', '--quiet');
  const tracked = join(directory, 'tracked.txt');
  await writeFile(tracked, 'committed content\n');
  git('add', 'tracked.txt');
  git(
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    'commit',
    '--quiet',
    '-m',
    'source',
  );
  const current = await lstat(tracked);
  const changedTime = new Date(current.mtimeMs + 10_000);
  await utimes(tracked, changedTime, changedTime);
  const index = join(directory, '.git/index');
  const identity = async () => {
    const metadata = await lstat(index, { bigint: true });
    return {
      ...Object.fromEntries(
        ['dev', 'ino', 'uid', 'gid', 'mode', 'size', 'mtimeNs', 'ctimeNs'].map((key) => [
          key,
          metadata[key],
        ]),
      ),
      bytes: digest(await readFile(index)),
    };
  };
  const before = await identity();
  const inherited = process.env.GIT_OPTIONAL_LOCKS;
  const mask = process.umask(0o077);
  process.env.GIT_OPTIONAL_LOCKS = '1';
  try {
    assert.equal(await observeBackupRefusalSourceGit(directory, ['status', '--porcelain']), '');
    assert.deepEqual(await identity(), before);
    await writeFile(tracked, 'changed content\n');
    await writeFile(join(directory, 'untracked.txt'), 'new file\n');
    const status = await observeBackupRefusalSourceGit(directory, ['status', '--porcelain']);
    assert.match(status, /^ M tracked\.txt$/mu);
    assert.match(status, /^\?\? untracked\.txt$/mu);
    assert.deepEqual(await identity(), before);
  } finally {
    process.umask(mask);
    if (inherited === undefined) delete process.env.GIT_OPTIONAL_LOCKS;
    else process.env.GIT_OPTIONAL_LOCKS = inherited;
  }
});
