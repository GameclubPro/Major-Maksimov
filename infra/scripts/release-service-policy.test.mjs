import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { sha256, stableJson } from './release-service-boundary.mjs';
import {
  initializePolicy,
  pausePolicy,
  readPolicy,
  resumePolicy,
  runPolicyCommand,
  withPolicyMutationLock,
} from './release-service-policy.mjs';

const start = Date.parse('2026-11-04T05:00:00.000Z');

function fixture(callback) {
  const root = fs.mkdtempSync(join(tmpdir(), 'maxim-policy-'));
  let time = start;
  const options = { directory: root, now: () => time };
  try {
    return callback({
      root,
      options,
      path: join(root, 'policy.json'),
      advance: (value = 1000) => {
        time += value;
      },
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}
const code = (expected) => (error) => error.code === expected;

test('read is fail closed and never creates a missing policy or a mutation lock', () => {
  fixture(({ root, options }) => {
    assert.throws(() => readPolicy(options), code('POLICY_MISSING'));
    assert.deepEqual(fs.readdirSync(root), []);
    assert.throws(() => pausePolicy({ ...options, reason: 'ROLLBACK' }), code('POLICY_MISSING'));
    assert.equal(fs.existsSync(join(root, 'policy.json')), false);
  });
});

test('explicit initialization creates a private paused policy and never enables automatic delivery', () => {
  fixture(({ path, options, advance }) => {
    const first = initializePolicy(options);
    assert.equal(first.schemaVersion, 1);
    assert.equal(first.paused, true);
    assert.equal(first.autoEnabled, false);
    assert.equal(first.reason, 'INITIALIZED');
    assert.equal(first.revision, 1);
    assert.equal(fs.statSync(path).mode & 0o777, 0o600);
    const stored = JSON.parse(fs.readFileSync(path).toString('utf8'));
    assert.equal(first.policySha256, sha256(stableJson(stored)));
    assert.equal(Object.hasOwn(stored, 'policySha256'), false);
    advance();
    assert.deepEqual(initializePolicy(options), first);
    assert.deepEqual(readPolicy(options), first);
  });
});

test('rollback pause is idempotent and optimistic resume never enables automatic delivery', () => {
  fixture(({ options, path, advance }) => {
    const first = initializePolicy(options);
    const resumed = resumePolicy({ ...options, expectedPolicySha256: first.policySha256 });
    assert.equal(resumed.paused, false);
    assert.equal(resumed.autoEnabled, false);
    assert.equal(resumed.reason, 'OPERATOR_RESUME');
    assert.notEqual(resumed.policySha256, first.policySha256);
    advance();
    const paused = pausePolicy({ ...options, reason: 'ROLLBACK' });
    assert.equal(paused.paused, true);
    assert.equal(paused.autoEnabled, false);
    assert.equal(paused.reason, 'ROLLBACK');
    assert.equal(paused.revision, resumed.revision + 1);
    const inode = fs.statSync(path).ino;
    advance();
    assert.deepEqual(pausePolicy({ ...options, reason: 'ROLLBACK' }), paused);
    assert.equal(fs.statSync(path).ino, inode, 'idempotent pause replaced durable policy');
    assert.throws(
      () => resumePolicy({ ...options, expectedPolicySha256: resumed.policySha256 }),
      code('STALE_POLICY'),
    );
    assert.deepEqual(readPolicy(options), paused);
    const again = resumePolicy({ ...options, expectedPolicySha256: paused.policySha256 });
    assert.equal(again.paused, false);
    assert.equal(again.autoEnabled, false);
    assert.deepEqual(resumePolicy({ ...options, expectedPolicySha256: again.policySha256 }), again);
  });
});

test('durable replacement fsyncs file before atomic replacement and its directory before success', () => {
  fixture(({ root, options }) => {
    const calls = [];
    const fileSystem = {
      ...fs,
      fsyncSync(fd) {
        calls.push(fs.fstatSync(fd).isDirectory() ? 'directory-sync' : 'file-sync');
        return fs.fsyncSync(fd);
      },
      linkSync(...args) {
        calls.push('exclusive-link');
        return fs.linkSync(...args);
      },
      renameSync(...args) {
        calls.push('rename');
        return fs.renameSync(...args);
      },
    };
    initializePolicy({ ...options, fileSystem });
    assert.ok(calls.indexOf('file-sync') < calls.indexOf('exclusive-link'));
    assert.ok(calls.indexOf('exclusive-link') < calls.indexOf('directory-sync'));
    calls.length = 0;
    pausePolicy({ ...options, fileSystem, reason: 'ROLLBACK' });
    assert.deepEqual(calls, ['file-sync', 'rename', 'directory-sync']);
    assert.ok(!fs.readdirSync(root).some((name) => name.endsWith('.tmp')));
  });
});

test('uncertain directory fsync failure is not success and blocks later policy use in that process', () => {
  fixture(({ options }) => {
    initializePolicy(options);
    const fileSystem = {
      ...fs,
      fsyncSync(fd) {
        if (fs.fstatSync(fd).isDirectory()) throw new Error('fixture fsync failure');
        return fs.fsyncSync(fd);
      },
    };
    assert.throws(
      () => pausePolicy({ ...options, fileSystem, reason: 'ROLLBACK' }),
      /fixture fsync/u,
    );
    assert.throws(() => readPolicy(options), code('POLICY_RESTART_REQUIRED'));
    assert.throws(
      () => resumePolicy({ ...options, expectedPolicySha256: 'a'.repeat(64) }),
      code('POLICY_RESTART_REQUIRED'),
    );
  });
});

test('corrupt, future, permissive or automatic-enabled policies are never repaired by reads or initialize', () => {
  for (const mutate of [
    () => '{bad',
    (value) => JSON.stringify({ ...value, autoEnabled: true }),
    (value) => JSON.stringify({ ...value, paused: false }),
    (value) => JSON.stringify({ ...value, updatedAt: new Date(start + 1).toISOString() }),
    (value) => JSON.stringify({ ...value, revision: 0 }),
    (value) => JSON.stringify({ ...value, extra: true }),
  ])
    fixture(({ options, path }) => {
      initializePolicy(options);
      const corrupt = mutate(JSON.parse(fs.readFileSync(path).toString('utf8')));
      fs.writeFileSync(path, corrupt);
      assert.throws(() => readPolicy(options));
      assert.throws(() => initializePolicy(options));
      assert.equal(fs.readFileSync(path).toString('utf8'), corrupt);
    });
});

test('policy and lock files reject symlinks, hard links and unsafe permissions', () => {
  for (const kind of [
    'policy-mode',
    'policy-link',
    'policy-symlink',
    'lock-mode',
    'lock-link',
    'lock-symlink',
  ]) {
    fixture(({ root, options, path }) => {
      initializePolicy(options);
      const target = kind.startsWith('policy') ? path : join(root, 'policy.lock');
      if (kind.endsWith('mode')) fs.chmodSync(target, 0o644);
      else if (kind.endsWith('symlink')) {
        fs.renameSync(target, `${target}.retained`);
        fs.symlinkSync(`${target}.retained`, target);
      } else fs.linkSync(target, `${target}.hardlink`);
      if (kind.startsWith('policy')) assert.throws(() => readPolicy(options));
      assert.throws(() => pausePolicy({ ...options, reason: 'ROLLBACK' }));
    });
  }
});

test('input validation rejects unknown reason, stale or malformed hashes and clock rollback', () => {
  fixture(({ options, advance }) => {
    const initialized = initializePolicy(options);
    assert.throws(
      () => pausePolicy({ ...options, reason: 'private input' }),
      code('INVALID_POLICY_REASON'),
    );
    for (const expectedPolicySha256 of [
      undefined,
      null,
      '',
      'a'.repeat(64) + '\n',
      'A'.repeat(64),
    ]) {
      assert.throws(
        () => resumePolicy({ ...options, expectedPolicySha256 }),
        code('INVALID_POLICY_HASH'),
      );
    }
    assert.throws(
      () => resumePolicy({ ...options, expectedPolicySha256: 'a'.repeat(64) }),
      code('STALE_POLICY'),
    );
    advance(-1000);
    assert.throws(() =>
      resumePolicy({ ...options, expectedPolicySha256: initialized.policySha256 }),
    );
  });
});

test('kernel policy lock serializes actual competing processes and its persistent inode is retained', () => {
  fixture(({ root, options }) => {
    initializePolicy(options);
    const path = join(root, 'policy.lock');
    const inode = fs.statSync(path).ino;
    withPolicyMutationLock(options, () => {
      const competitor = spawnSync('/usr/bin/flock', [
        '--exclusive',
        '--nonblock',
        path,
        process.execPath,
        '-e',
        'process.exit(0)',
      ]);
      assert.equal(competitor.status, 1);
      assert.throws(
        () => pausePolicy({ ...options, reason: 'ROLLBACK' }),
        code('POLICY_LOCK_BUSY'),
      );
    });
    const after = spawnSync('/usr/bin/flock', [
      '--exclusive',
      '--nonblock',
      path,
      process.execPath,
      '-e',
      'process.exit(0)',
    ]);
    assert.equal(after.status, 0);
    assert.equal(fs.statSync(path).ino, inode);
  });
});

test('process death releases the kernel policy lock without deleting or replacing its inode', async () => {
  const root = fs.mkdtempSync(join(tmpdir(), 'maxim-policy-crash-'));
  initializePolicy({ directory: root });
  const path = join(root, 'policy.lock');
  const inode = fs.statSync(path).ino;
  const source = `
    import fs from 'node:fs';
    import {withPolicyMutationLock} from ${JSON.stringify(new URL('./release-service-policy.mjs', import.meta.url).href)};
    withPolicyMutationLock({directory:process.argv[1]},()=>{fs.writeSync(1,'LOCKED\\n');fs.readFileSync(0);});
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', source, root], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const exited = new Promise((resolve) => child.once('exit', resolve));
  try {
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error('Policy lock child did not report readiness.')),
        5000,
      );
      child.stdout.once('data', (chunk) => {
        clearTimeout(timeout);
        assert.equal(chunk.toString('utf8'), 'LOCKED\n');
        resolve();
      });
      child.once('error', (error) => {
        clearTimeout(timeout);
        reject(error);
      });
    });
    const blocked = spawnSync('/usr/bin/flock', [
      '--exclusive',
      '--nonblock',
      path,
      process.execPath,
      '-e',
      'process.exit(0)',
    ]);
    assert.equal(blocked.status, 1);
    child.kill('SIGKILL');
    await exited;
    const available = spawnSync('/usr/bin/flock', [
      '--exclusive',
      '--nonblock',
      path,
      process.execPath,
      '-e',
      'process.exit(0)',
    ]);
    assert.equal(available.status, 0);
    assert.equal(fs.statSync(path).ino, inode);
  } finally {
    child.kill('SIGKILL');
    child.stdin.destroy();
    await exited;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('CLI exposes no resume or caller-selected path and prints no raw input on rejection', () => {
  for (const args of [
    ['resume'],
    ['read', '/private/path'],
    ['pause-rollback', 'private reason'],
  ]) {
    const result = spawnSync(
      process.execPath,
      [new URL('./release-service-policy.mjs', import.meta.url).pathname, ...args],
      { encoding: 'utf8' },
    );
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, 'Release policy refused: INVALID_POLICY_COMMAND.\n');
  }
});

function delegatedPolicy() {
  const value = {
    schemaVersion: 1,
    revision: 2,
    paused: true,
    autoEnabled: false,
    reason: 'ROLLBACK',
    updatedAt: '1970-01-01T00:00:00.000Z',
  };
  return { ...value, policySha256: sha256(stableJson(value)) };
}

test('root rollback CLI delegates only to the fixed installed deploy user and helper', () => {
  const expected = delegatedPolicy();
  let calls = 0;
  const runner = (binary, args, options) => {
    calls += 1;
    assert.equal(binary, '/usr/sbin/runuser');
    assert.deepEqual(args, [
      '--user',
      'maximadmin',
      '--',
      '/usr/bin/env',
      '-i',
      'PATH=/usr/local/bin:/usr/bin:/bin',
      'HOME=/var/lib/maxim-release',
      'LANG=C.UTF-8',
      '/usr/bin/node',
      '/usr/local/lib/maxim-release/infra/scripts/release-service-policy.mjs',
      'pause-rollback',
    ]);
    assert.deepEqual(options, {
      env: {
        PATH: '/usr/local/bin:/usr/bin:/bin',
        HOME: '/var/lib/maxim-release',
        LANG: 'C.UTF-8',
        GIT_NO_REPLACE_OBJECTS: '1',
        GIT_TERMINAL_PROMPT: '0',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 10_000,
      maxBuffer: 4096,
    });
    return { status: 0, signal: null, stdout: Buffer.from(`${JSON.stringify(expected)}\n`) };
  };
  assert.deepEqual(
    runPolicyCommand(['pause-rollback'], { uid: 0, node: '/usr/bin/node', runner }),
    expected,
  );
  assert.equal(calls, 1);
  for (const args of [
    ['pause-rollback', '/private/path'],
    ['pause-rollback', '--user', 'other-user'],
    ['resume'],
  ]) {
    assert.throws(
      () => runPolicyCommand(args, { uid: 0, node: '/usr/bin/node', runner }),
      code('INVALID_POLICY_COMMAND'),
    );
  }
  assert.equal(calls, 1);
});

test('root delegation refuses unreviewed Node, child failure, timeout and unproved output without leaking diagnostics', () => {
  let called = false;
  assert.throws(
    () =>
      runPolicyCommand(['pause-rollback'], {
        uid: 0,
        node: '/private/node',
        runner: () => {
          called = true;
        },
      }),
    code('POLICY_DELEGATION_UNAVAILABLE'),
  );
  assert.equal(called, false);
  const valid = { status: 0, signal: null, stdout: Buffer.from(JSON.stringify(delegatedPolicy())) };
  for (const result of [
    { ...valid, status: 1, stderr: Buffer.from('private child diagnostic') },
    { ...valid, status: null, signal: 'SIGTERM', error: new Error('private timeout') },
    { ...valid, stdout: Buffer.alloc(4097, 120) },
    { ...valid, stdout: Buffer.from([255]) },
    { ...valid, stdout: Buffer.from('private malformed receipt') },
    {
      ...valid,
      stdout: Buffer.from(JSON.stringify({ ...delegatedPolicy(), policySha256: 'a'.repeat(64) })),
    },
    { ...valid, stdout: Buffer.from(JSON.stringify({ ...delegatedPolicy(), paused: false })) },
    {
      ...valid,
      stdout: Buffer.from(JSON.stringify({ ...delegatedPolicy(), extra: 'private input' })),
    },
  ]) {
    assert.throws(
      () =>
        runPolicyCommand(['pause-rollback'], {
          uid: 0,
          node: '/usr/bin/node',
          runner: () => result,
        }),
      { code: 'POLICY_DELEGATION_UNPROVED', message: 'POLICY_DELEGATION_UNPROVED' },
    );
  }
  assert.throws(
    () =>
      runPolicyCommand(['pause-rollback'], {
        uid: 0,
        node: '/usr/bin/node',
        runner: () => {
          throw new Error('private NSS diagnostic');
        },
      }),
    { code: 'POLICY_DELEGATION_UNPROVED', message: 'POLICY_DELEGATION_UNPROVED' },
  );
});

test('native same-user rollback pause preserves private policy/lock ownership and the persistent lock inode', () => {
  fixture(({ root, path }) => {
    initializePolicy({ directory: root });
    const lock = join(root, 'policy.lock');
    const lockInode = fs.statSync(lock).ino;
    const source = `
      import * as fs from 'node:fs';
      import {pausePolicy} from ${JSON.stringify(new URL('./release-service-policy.mjs', import.meta.url).href)};
      const directory=process.argv[1];
      const policy=pausePolicy({directory,reason:'ROLLBACK'});
      const info=path=>{const stat=fs.statSync(path);return {uid:stat.uid,mode:stat.mode&0o777,ino:stat.ino};};
      process.stdout.write(JSON.stringify({uid:process.getuid(),policy,policyFile:info(directory+'/policy.json'),lock:info(directory+'/policy.lock')}));
    `;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', source, root], {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 5000,
      maxBuffer: 4096,
    });
    assert.equal(result.status, 0, result.stderr.toString('utf8'));
    const actual = JSON.parse(result.stdout.toString('utf8'));
    assert.equal(actual.uid, process.getuid());
    assert.equal(actual.policy.paused, true);
    assert.equal(actual.policy.reason, 'ROLLBACK');
    assert.equal(actual.policy.autoEnabled, false);
    for (const stat of [actual.policyFile, actual.lock]) {
      assert.equal(stat.uid, process.getuid());
      assert.equal(stat.mode, 0o600);
    }
    assert.equal(actual.lock.ino, lockInode);
    assert.equal(fs.statSync(path).uid, process.getuid());
  });
});

test('all rollback routes pause the root-installed service after lock and before mutations or retained dispatch', () => {
  const names = ['vps-release-rollback.sh', 'vps-runtime-rollback.sh', 'vps-connect.sh'];
  for (const name of names) {
    const complete = fs.readFileSync(new URL(`./${name}`, import.meta.url)).toString('utf8');
    const source =
      name === 'vps-connect.sh'
        ? complete.slice(
            complete.indexOf('rollback_entrypoint_bootstrap_source()'),
            complete.indexOf('build_guarded_rollback_command()'),
          )
        : complete;
    const lock = source.indexOf('\nacquire_deploy_lock\n');
    const pause = source.indexOf(
      '/usr/local/lib/maxim-release/infra/scripts/release-service-policy.mjs pause-rollback',
    );
    assert.ok(lock >= 0 && pause > lock, `${name}: pause must follow protected lock`);
    assert.ok(
      source.includes('[[ -e /etc/maxim-release/installed || -L /etc/maxim-release/installed ]]'),
    );
    assert.ok(source.includes("stat -c '%u:%h'"));
    assert.ok(
      source.includes('/usr/local/lib/maxim-release/infra/scripts/release-service-boundary.mjs'),
    );
    const boundary =
      name === 'vps-connect.sh'
        ? source.indexOf('if [[ -x "$entrypoint" ]]')
        : name === 'vps-runtime-rollback.sh'
          ? source.indexOf('\nensure_compose_env\n')
          : source.indexOf('\nPLAN_FILE="$(mktemp)"');
    assert.ok(boundary > pause, `${name}: mutation or retained dispatch precedes pause`);
  }
});
