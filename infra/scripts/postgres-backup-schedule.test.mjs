import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { chmod, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  ADMISSION_DEADLINE_MS,
  ADMISSION_DELAYS_MS,
  prepareScheduleDirectory,
  readPrivateJson,
  replicationSnapshot,
  runSchedule,
  writePrivateJson,
} from './postgres-backup-schedule.mjs';

const sourceSha = 'a'.repeat(40);
const initialTime = Date.parse('2026-11-03T10:00:00Z');
const hash = (text) => createHash('sha256').update(text).digest('hex');
const script = new URL('./postgres-backup-schedule.sh', import.meta.url).pathname;

async function fixture(t, profile = 'maxim') {
  const base = await mkdtemp(join(tmpdir(), 'backup-schedule-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const directory = profile === 'eraser' ? join(base, 'eraser') : base;
  await mkdir(directory, { recursive: true });
  const stateDirectory = await prepareScheduleDirectory(directory);
  let currentTime = initialTime;
  let producer = 'complete';
  let replica = 'complete';
  const calls = [];
  const destination = `test:bucket/postgres${profile === 'eraser' ? '/eraser' : ''}`;
  const archive = { name: `${profile}_20261103T100000Z.dump`, sha256: hash('archive'), bytes: 7 };
  const readState = () => readPrivateJson(join(stateDirectory, 'state.json'));
  const writeState = (state) => writePrivateJson(join(stateDirectory, 'state.json'), state);
  const receipt = async (override = {}) =>
    writePrivateJson(join(directory, `${archive.name}.remote-verified.json`), {
      schemaVersion: 1,
      profile,
      dump: archive.name,
      dumpSha256: archive.sha256,
      cipherSha256: 'c'.repeat(64),
      verifiedAt: new Date(currentTime).toISOString(),
      remoteObject: `${destination}/${archive.name}.${'c'.repeat(64)}.age`,
      verification: 'full_ciphertext_readback',
      ...override,
    });
  const run = async (kind, options) => {
    calls.push({ kind, options });
    if (kind === 'replicate') {
      assert.equal(options.archivePath, join(directory, archive.name));
      assert.equal(options.expectedSha256, archive.sha256);
      if (replica === 'throw') throw new Error('coordinator interrupted');
      if (replica === 'complete') await receipt();
      return { code: replica === 'complete' ? 0 : 1 };
    }
    const result = {
      schemaVersion: 1,
      profile,
      operationId: options.operationId,
      attemptId: options.attemptId,
    };
    if (producer === 'throw') throw new Error('coordinator interrupted');
    if (producer === 'unknown75') return { code: 75 };
    if (producer === 'stale75') return { code: 75 };
    if (producer === 'deferred') {
      await writePrivateJson(options.resultPath, {
        ...result,
        phase: 'deferred',
        reason: 'backup_lock_busy',
      });
      return { code: 75 };
    }
    await writePrivateJson(options.resultPath, {
      ...result,
      phase: 'producing',
      archiveName: archive.name,
    });
    if (producer === 'watchdog') return { code: 1 };
    await writeFile(join(directory, archive.name), 'archive', { mode: 0o600 });
    await writeFile(
      join(directory, `${archive.name}.sha256`),
      `${archive.sha256}  ${archive.name}\n`,
      { mode: 0o600 },
    );
    await writePrivateJson(options.resultPath, {
      ...result,
      phase: 'local_complete',
      archiveName: archive.name,
      sha256: archive.sha256,
      bytes: archive.bytes,
    });
    if (producer === 'crash-after-complete') throw new Error('coordinator interrupted');
    return { code: producer === 'complete-nonzero' ? 1 : 0 };
  };
  const invoke = (mode = 'tick', extra = {}) =>
    runSchedule({
      mode,
      profile,
      directory,
      destination,
      destinationHash: hash(destination),
      sourceSha,
      now: () => currentTime,
      run,
      ...extra,
    });
  return {
    base,
    directory,
    stateDirectory,
    calls,
    archive,
    invoke,
    readState,
    writeState,
    receipt,
    setTime: (value) => {
      currentTime = value;
    },
    setProducer: (value) => {
      producer = value;
    },
    setReplica: (value) => {
      replica = value;
    },
  };
}

for (const profile of ['maxim', 'eraser']) {
  test(`durable ${profile} admission resumes once after the original backoff`, async (t) => {
    const f = await fixture(t, profile);
    f.setProducer('deferred');
    const first = await f.invoke('request');
    assert.equal(first.phase, 'waiting');
    const stored = await f.readState();
    assert.equal(stored.deadlineAt, initialTime + ADMISSION_DEADLINE_MS);
    assert.equal((await f.invoke('request')).attempts, 1);
    f.setTime(stored.nextAttemptAt);
    f.setProducer('complete');
    assert.equal((await f.invoke()).phase, 'verified');
    assert.deepEqual(
      f.calls.map((call) => call.kind),
      ['produce', 'produce', 'replicate'],
    );
    assert.notEqual(f.calls[0].options.attemptId, f.calls[1].options.attemptId);
    assert.equal((await f.readState()).operationId, first.operationId);
    assert.equal((await f.invoke()).phase, 'verified');
    assert.equal(f.calls.length, 3);
  });
}

for (const failure of ['unknown75', 'watchdog', 'throw']) {
  test(`${failure} never schedules another dump across requests or restart`, async (t) => {
    const f = await fixture(t);
    f.setProducer(failure);
    if (failure === 'throw') await assert.rejects(f.invoke('request'), /interrupted/);
    else assert.equal((await f.invoke('request')).phase, 'needs_review');
    f.setTime(initialTime + 2 * ADMISSION_DEADLINE_MS);
    assert.equal((await f.invoke()).phase, 'needs_review');
    assert.equal((await f.invoke('request')).phase, 'needs_review');
    assert.equal(f.calls.length, 1);
  });
}

test('stale deferred receipt cannot authorize retry of a new unknown attempt', async (t) => {
  const f = await fixture(t);
  f.setProducer('deferred');
  await f.invoke('request');
  f.setTime((await f.readState()).nextAttemptAt);
  f.setProducer('stale75');
  assert.equal((await f.invoke()).phase, 'needs_review');
  assert.equal(f.calls.length, 2);
});

test('six admission attempts and the twelve-hour deadline survive new daily requests', async (t) => {
  const f = await fixture(t);
  f.setProducer('deferred');
  await f.invoke('request');
  for (const delay of ADMISSION_DELAYS_MS) {
    const before = await f.readState();
    assert.equal(before.nextAttemptAt, before.lastAttemptAt + delay);
    f.setTime(before.nextAttemptAt);
    await f.invoke('request');
  }
  assert.equal((await f.readState()).phase, 'overdue');
  assert.equal((await f.invoke('request')).attempts, 6);
  assert.equal(f.calls.length, 6);
  const other = await fixture(t);
  other.setProducer('deferred');
  await other.invoke('request');
  other.setTime(initialTime + ADMISSION_DEADLINE_MS);
  assert.equal((await other.invoke('request')).phase, 'overdue');
  assert.equal(other.calls.length, 1);
});

test('source update stops pending admission before a different producer can run', async (t) => {
  const f = await fixture(t);
  f.setProducer('deferred');
  await f.invoke('request');
  f.setTime((await f.readState()).nextAttemptAt);
  assert.equal(
    (await f.invoke('tick', { sourceSha: 'b'.repeat(40) })).reason,
    'producer_source_changed',
  );
  assert.equal(f.calls.length, 1);
});

test('completed archive receipt survives coordinator interruption without another dump', async (t) => {
  const f = await fixture(t);
  f.setProducer('crash-after-complete');
  await assert.rejects(f.invoke('request'), /interrupted/);
  assert.equal((await f.invoke()).phase, 'verified');
  assert.deepEqual(
    f.calls.map((call) => call.kind),
    ['produce', 'replicate'],
  );
});

test('replication failure requires exact explicit recovery and retains the original archive', async (t) => {
  const f = await fixture(t);
  f.setReplica('failed');
  const failed = await f.invoke('request');
  assert.equal(failed.phase, 'needs_review');
  assert.equal((await f.invoke('request')).phase, 'needs_review');
  assert.equal(f.calls.length, 2);
  await assert.rejects(
    f.invoke('resume-replication', { expectedOperationId: 'wrong' }),
    /Exact replication/,
  );
  await assert.rejects(
    f.invoke('resume-replication', {
      expectedOperationId: failed.operationId,
      destinationHash: hash('test:other'),
    }),
    /target/,
  );
  f.setReplica('complete');
  assert.equal(
    (await f.invoke('resume-replication', { expectedOperationId: failed.operationId })).phase,
    'verified',
  );
  assert.deepEqual(
    f.calls.map((call) => call.kind),
    ['produce', 'replicate', 'replicate'],
  );
});

test('replication recovery budget cannot be reset by ticks or requests', async (t) => {
  const f = await fixture(t);
  f.setReplica('failed');
  const failed = await f.invoke('request');
  for (let i = 0; i < 2; i++)
    await f.invoke('resume-replication', { expectedOperationId: failed.operationId });
  await assert.rejects(
    f.invoke('resume-replication', { expectedOperationId: failed.operationId }),
    /budget/,
  );
  assert.equal((await f.invoke('request')).phase, 'needs_review');
  assert.equal(f.calls.filter((call) => call.kind === 'produce').length, 1);
  assert.equal(f.calls.length, 4);
});

test('exact receipt reconciles interrupted replication without retransmission', async (t) => {
  const f = await fixture(t);
  f.setReplica('throw');
  await assert.rejects(f.invoke('request'), /interrupted/);
  await f.receipt();
  assert.equal((await f.invoke()).phase, 'verified');
  assert.equal(f.calls.length, 2);
});

test('a receipt from another target cannot satisfy recovery', async (t) => {
  const f = await fixture(t);
  f.setReplica('throw');
  await assert.rejects(f.invoke('request'), /interrupted/);
  await f.receipt({ remoteObject: `test:other/${f.archive.name}.${'c'.repeat(64)}.age` });
  assert.equal((await f.invoke()).reason, 'replication_evidence_invalid');
  assert.equal((await f.readState()).phase, 'needs_review');
  assert.equal(f.calls.length, 2);
});

test('changed archive or checksum fails closed before replica execution', async (t) => {
  for (const target of ['archive', 'checksum']) {
    const f = await fixture(t);
    f.setReplica('failed');
    const failed = await f.invoke('request');
    await writeFile(
      join(f.directory, f.archive.name + (target === 'checksum' ? '.sha256' : '')),
      'changed input',
    );
    assert.equal(
      (await f.invoke('resume-replication', { expectedOperationId: failed.operationId })).reason,
      'archive_or_replication_evidence_invalid',
    );
    assert.equal((await f.readState()).phase, 'needs_review');
    assert.equal(f.calls.length, 2);
  }
});

test('state rejects unknown schema, public modes and symlink replacement', async (t) => {
  const f = await fixture(t);
  f.setProducer('deferred');
  await f.invoke('request');
  const state = await f.readState();
  await f.writeState({ ...state, schemaVersion: 2 });
  await assert.rejects(f.invoke(), /Invalid backup schedule/);
  await f.writeState(state);
  const path = join(f.stateDirectory, 'state.json');
  await chmod(path, 0o644);
  await assert.rejects(f.invoke(), /Unsafe/);
  await rm(path);
  const foreign = join(f.base, 'foreign');
  await writeFile(foreign, '{}', { mode: 0o600 });
  await symlink(foreign, path);
  await assert.rejects(f.invoke(), /Unsafe/);
});

test('only explicit close of the exact failed operation permits a new request', async (t) => {
  const f = await fixture(t);
  f.setProducer('watchdog');
  const failed = await f.invoke('request');
  await assert.rejects(f.invoke('close', { expectedOperationId: 'wrong' }), /Exact failed/);
  assert.equal(
    (await f.invoke('close', { expectedOperationId: failed.operationId })).phase,
    'closed',
  );
  f.setProducer('complete');
  const next = await f.invoke('request');
  assert.equal(next.phase, 'verified');
  assert.notEqual(next.operationId, failed.operationId);
});

test('shell coordinator fences mutations while status reads the active heartbeat without work', async (t) => {
  const f = await fixture(t);
  f.setProducer('deferred');
  await f.invoke('request');
  const active = {
    ...(await f.readState()),
    phase: 'producing',
    process: {
      pid: 1234,
      startedAt: initialTime,
      heartbeatAt: initialTime + 30_000,
      deadlineAt: initialTime + 44_100_000,
    },
  };
  await f.writeState(active);
  const env = {
    ...process.env,
    MAXIM_BACKUP_DIR: f.base,
    MAXIM_BACKUP_PROFILE: 'maxim',
    MAXIM_BACKUP_REPLICATION_REQUIRED: '1',
    MAXIM_BACKUP_REMOTE_PREFIX: 'test:bucket/postgres',
  };
  const holder = spawn(
    'bash',
    [
      '-c',
      'exec 9<>"$1"; flock -n 9; printf "held\\n"; read -r _',
      'fixture',
      join(f.stateDirectory, 'lock'),
    ],
    { stdio: ['pipe', 'pipe', 'pipe'] },
  );
  const closed = once(holder, 'close');
  t.after(() => holder.kill());
  await once(holder.stdout, 'data');
  assert.equal(spawnSync('bash', [script, 'tick'], { env }).status, 75);
  const observed = spawnSync('bash', [script, 'status'], {
    env: { ...env, MAXIM_BACKUP_REPLICATION_REQUIRED: '0', MAXIM_BACKUP_REMOTE_PREFIX: '' },
    encoding: 'utf8',
  });
  assert.equal(observed.status, 0, observed.stderr);
  assert.equal(JSON.parse(observed.stdout).phase, 'producing');
  assert.deepEqual(JSON.parse(observed.stdout).process, active.process);
  assert.deepEqual(await f.readState(), active);
  holder.stdin.end('done\n');
  await closed;
  const status = spawnSync('bash', [script, 'status'], { env, encoding: 'utf8' });
  assert.equal(status.status, 0, status.stderr);
  assert.equal(JSON.parse(status.stdout).phase, 'producing');
  assert.deepEqual(await f.readState(), active);
  assert.equal(f.calls.length, 1);
  const direct = spawnSync(process.execPath, [script.replace(/\.sh$/, '.mjs'), 'tick'], {
    env: { ...env, MAXIM_BACKUP_SCHEDULE_LOCKED: '1' },
    encoding: 'utf8',
  });
  assert.equal(direct.status, 1);
  assert.doesNotMatch(direct.stderr, /test:bucket|ENOENT|\/proc/);
});

test('complete archive survives a later producer failure for explicit replication recovery', async (t) => {
  const f = await fixture(t);
  f.setProducer('complete-nonzero');
  const failed = await f.invoke('request');
  assert.equal(failed.phase, 'needs_review');
  assert.equal(failed.archive, f.archive.name);
  assert.equal(f.calls.length, 1);
  assert.equal(
    (await f.invoke('resume-replication', { expectedOperationId: failed.operationId })).phase,
    'verified',
  );
  assert.deepEqual(
    f.calls.map((call) => call.kind),
    ['produce', 'replicate'],
  );
});

test('replication uses verified immutable source bytes after checkout changes', async (t) => {
  const f = await fixture(t);
  const repo = join(f.base, 'repo');
  await mkdir(join(repo, 'infra/scripts/lib'), { recursive: true });
  const files = [
    'infra/scripts/replicate-postgres-backup.sh',
    'infra/scripts/lib/postgres-backup-profile.sh',
  ];
  for (const file of files) await writeFile(join(repo, file), '# original source\n');
  const git = (...args) => {
    const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git('init', '--quiet');
  git('add', 'infra');
  git(
    '-c',
    'user.name=Backup fixture',
    '-c',
    'user.email=fixture@example.invalid',
    'commit',
    '--quiet',
    '-m',
    'Original tool source',
  );
  const sha = git('rev-parse', 'HEAD');
  const operation = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  const target = await replicationSnapshot(f.directory, operation, sha, repo);
  for (const file of files) await writeFile(join(repo, file), '# changed checkout source\n');
  assert.equal(await replicationSnapshot(f.directory, operation, sha, repo), target);
  assert.equal(await readFile(target, 'utf8'), '# original source\n');
  await writeFile(target, '# corrupted private snapshot\n');
  await assert.rejects(replicationSnapshot(f.directory, operation, sha, repo), /snapshot changed/);
});

for (const corrupt of ['malformed-json', 'invalid-result']) {
  for (const interrupted of [false, true]) {
    test(`producer evidence ${corrupt}, interrupted=${interrupted}, persists needs_review without replay`, async (t) => {
      const f = await fixture(t);
      let calls = 0;
      const run = async (kind, options) => {
        calls++;
        assert.equal(kind, 'produce');
        if (corrupt === 'malformed-json') await writeFile(options.resultPath, '{', { mode: 0o600 });
        else
          await writePrivateJson(options.resultPath, {
            schemaVersion: 2,
            profile: 'maxim',
            operationId: options.operationId,
            attemptId: options.attemptId,
            phase: 'local_complete',
          });
        if (interrupted) throw new Error('coordinator interrupted');
        return { code: 0 };
      };
      if (interrupted) await assert.rejects(f.invoke('request', { run }), /interrupted/);
      else assert.equal((await f.invoke('request', { run })).reason, 'producer_evidence_invalid');
      const result = await f.invoke('tick', { run });
      assert.equal(result.phase, 'needs_review');
      assert.equal(result.reason, 'producer_evidence_invalid');
      assert.equal((await f.readState()).phase, 'needs_review');
      assert.equal((await f.invoke('request', { run })).phase, 'needs_review');
      assert.equal(calls, 1);
    });
  }
}

test('idle status creates no directories and needs no replication configuration', async (t) => {
  const base = await mkdtemp(join(tmpdir(), 'backup-status-readonly-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const observed = spawnSync('bash', [script, 'status'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      MAXIM_BACKUP_DIR: base,
      MAXIM_BACKUP_PROFILE: 'maxim',
      MAXIM_BACKUP_REPLICATION_REQUIRED: '0',
      MAXIM_BACKUP_REMOTE_PREFIX: '',
    },
  });
  assert.equal(observed.status, 0, observed.stderr);
  assert.equal(JSON.parse(observed.stdout).phase, 'idle');
  assert.deepEqual(await readdir(base), []);
});
