import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { assertExecutorStopped } from './release-service-recovery.mjs';

const sourceSha = 'a'.repeat(40);
const bootId = '12345678-1234-1234-1234-123456789abc';
const otherBootId = '87654321-4321-4321-4321-cba987654321';

function codedError(code) {
  return Object.assign(new Error(code), { code });
}
function absentGroup() {
  throw codedError('ESRCH');
}

function procStat(
  pid,
  { state = 'S', group = 42, startTicks = '12345', command = 'node (executor) child' } = {},
) {
  const fields = Array(21).fill('0');
  fields[0] = state;
  fields[1] = '1';
  fields[2] = String(group);
  fields[19] = startTicks;
  return `${pid} (${command}) ${fields.join(' ')}\n`;
}

function procFixture(t) {
  const proc = fs.mkdtempSync(join(tmpdir(), 'maxim-recovery-proc-'));
  fs.mkdirSync(join(proc, 'sys/kernel/random'), { recursive: true });
  fs.writeFileSync(join(proc, 'sys/kernel/random/boot_id'), `${bootId}\n`);
  t.after(() => fs.rmSync(proc, { recursive: true, force: true }));
  return {
    proc,
    executor: { pid: 42, bootId, startTicks: '12345', sourceSha },
    options: { proc, signalProcessGroup: absentGroup },
    row(pid, fields) {
      fs.mkdirSync(join(proc, String(pid)), { recursive: true });
      fs.writeFileSync(join(proc, String(pid), 'stat'), procStat(pid, fields));
    },
  };
}

function readLiveIdentity(pid) {
  const raw = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
  const fields = raw
    .slice(raw.lastIndexOf(') ') + 2)
    .trim()
    .split(/\s+/u);
  assert.equal(Number(fields[2]), pid, 'test executor must own its detached process group');
  return {
    pid,
    sourceSha,
    bootId: fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(),
    startTicks: fields[19],
  };
}

function observeExit(child) {
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
}

function firstLine(child) {
  return new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(
      () => finish(new Error('Detached test executor did not become ready.')),
      3000,
    );
    const onData = (data) => {
      output += data;
      if (output.length > 1024) finish(new Error('Unexpected test executor output.'));
      else if (output.includes('\n')) finish(null, output.slice(0, output.indexOf('\n')));
    };
    const onClose = () =>
      finish(new Error('Detached test executor exited before its ready message.'));
    const finish = (error, value) => {
      clearTimeout(timer);
      child.stdout.off('data', onData);
      child.off('error', finish);
      child.off('close', onClose);
      if (error) reject(error);
      else resolve(value);
    };
    child.stdout.on('data', onData);
    child.once('error', finish);
    child.once('close', onClose);
  });
}

async function bounded(promise, label, milliseconds = 3000) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(label)), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function killOwnedGroup(pid) {
  assert.ok(
    Number.isSafeInteger(pid) && pid > 1,
    'only an owned positive child PID may be signalled',
  );
  try {
    process.kill(-pid, 'SIGKILL');
  } catch (error) {
    if (error.code !== 'ESRCH') throw error;
  }
}

test(
  'a live detached executor blocks recovery until the reaped process group is gone',
  { skip: process.platform !== 'linux', timeout: 10000 },
  async (t) => {
    const child = spawn(
      process.execPath,
      ['-e', 'process.stdout.write("ready\\n"); setInterval(() => {}, 1000);'],
      {
        detached: true,
        stdio: ['ignore', 'pipe', 'ignore'],
      },
    );
    const exited = observeExit(child);
    t.after(async () => {
      killOwnedGroup(child.pid);
      await bounded(exited, 'Owned detached test executor did not stop.');
    });
    assert.equal(await firstLine(child), 'ready');
    const executor = readLiveIdentity(child.pid);
    assert.throws(() => assertExecutorStopped(executor), { code: 'EXECUTOR_STILL_PRESENT' });
    killOwnedGroup(child.pid);
    assert.deepEqual(await bounded(exited, 'Detached test executor did not exit.'), {
      code: null,
      signal: 'SIGKILL',
    });
    assert.deepEqual(assertExecutorStopped(executor), {
      bootId: executor.bootId,
      previousBoot: false,
    });
  },
);

test(
  'an exited executor parent cannot hide its surviving child in the detached group',
  { skip: process.platform !== 'linux', timeout: 10000 },
  async (t) => {
    const source = [
      'const { spawn } = require("node:child_process");',
      'const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });',
      'child.once("spawn", () => process.stdout.write(`${child.pid}\\n`));',
      'process.stdin.once("data", () => process.exit(0));',
      'setInterval(() => {}, 1000);',
    ].join('\n');
    const parent = spawn(process.execPath, ['-e', source], {
      detached: true,
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    const exited = observeExit(parent);
    t.after(async () => {
      killOwnedGroup(parent.pid);
      await bounded(exited, 'Owned parent test executor did not stop.');
    });
    const descendantPid = Number(await firstLine(parent));
    assert.ok(Number.isSafeInteger(descendantPid) && descendantPid > 1);
    const executor = readLiveIdentity(parent.pid);
    parent.stdin.end('exit\n');
    assert.deepEqual(await bounded(exited, 'Parent test executor did not exit.'), {
      code: 0,
      signal: null,
    });
    assert.throws(() => fs.readFileSync(`/proc/${parent.pid}/stat`), { code: 'ENOENT' });
    const descendant = fs.readFileSync(`/proc/${descendantPid}/stat`, 'utf8');
    const fields = descendant
      .slice(descendant.lastIndexOf(') ') + 2)
      .trim()
      .split(/\s+/u);
    assert.equal(Number(fields[2]), parent.pid);
    assert.ok(!['Z', 'X'].includes(fields[0]), 'the remaining child must still be live');
    assert.throws(() => assertExecutorStopped(executor), { code: 'EXECUTOR_STILL_PRESENT' });
  },
);

test('an empty proc snapshot needs a positive kernel proof that the original group is absent', (t) => {
  const value = procFixture(t);
  const calls = [];
  assert.deepEqual(
    assertExecutorStopped(value.executor, {
      ...value.options,
      signalProcessGroup: (...args) => {
        calls.push(args);
        absentGroup();
      },
    }),
    { bootId, previousBoot: false },
  );
  assert.deepEqual(calls, [[-42, 0]]);
  assert.throws(
    () =>
      assertExecutorStopped(value.executor, { ...value.options, signalProcessGroup: () => true }),
    { code: 'EXECUTOR_STILL_PRESENT' },
  );
  for (const code of ['EPERM', 'EACCES', 'EIO']) {
    assert.throws(
      () =>
        assertExecutorStopped(value.executor, {
          ...value.options,
          signalProcessGroup: () => {
            throw codedError(code);
          },
        }),
      { code: 'PROCESS_OBSERVATION_UNPROVED' },
    );
  }
});

test('PID reuse is accepted only after the old identity and original group are both absent', (t) => {
  const value = procFixture(t);
  value.row(42, { group: 99, startTicks: '67890' });
  assert.deepEqual(assertExecutorStopped(value.executor, value.options), {
    bootId,
    previousBoot: false,
  });
  value.row(42, { group: 42, startTicks: '67890' });
  assert.throws(() => assertExecutorStopped(value.executor, value.options), {
    code: 'EXECUTOR_STILL_PRESENT',
  });
  value.row(42, { group: 99, startTicks: '12345' });
  assert.throws(() => assertExecutorStopped(value.executor, value.options), {
    code: 'EXECUTOR_STILL_PRESENT',
  });
});

test('a live descendant is found even when the parent PID is absent and comm contains parentheses', (t) => {
  const value = procFixture(t);
  value.row(72, { group: 42, startTicks: '67890', command: 'worker (nested) ) child' });
  assert.throws(() => assertExecutorStopped(value.executor, value.options), {
    code: 'EXECUTOR_STILL_PRESENT',
  });
});

test('a different boot proves that the old executor ended without scanning or probing reused groups', () => {
  const executor = { pid: 42, bootId, startTicks: '12345', sourceSha };
  assert.deepEqual(
    assertExecutorStopped(executor, {
      fileSystem: {
        readFileSync: (path) => {
          assert.equal(path, '/proc/sys/kernel/random/boot_id');
          return `${otherBootId}\n`;
        },
        readdirSync: () => assert.fail('a previous boot must not scan this boot'),
      },
      signalProcessGroup: () => assert.fail('a previous boot must not inspect a reused group'),
    }),
    { bootId: otherBootId, previousBoot: true },
  );
});

test('the proc scan is bounded before reading any process rows or probing the kernel', () => {
  const executor = { pid: 42, bootId, startTicks: '12345', sourceSha };
  assert.throws(
    () =>
      assertExecutorStopped(executor, {
        fileSystem: {
          readFileSync: (path) => {
            assert.equal(path, '/proc/sys/kernel/random/boot_id');
            return bootId;
          },
          readdirSync: () => Array.from({ length: 32769 }, (_entry, index) => String(index + 1)),
        },
        signalProcessGroup: () => assert.fail('an incomplete scan must never prove absence'),
      }),
    { code: 'PROCESS_OBSERVATION_UNPROVED' },
  );
});

test('processes disappearing during the proc scan are tolerated only for ENOENT and ESRCH', () => {
  const executor = { pid: 42, bootId, startTicks: '12345', sourceSha };
  for (const code of ['ENOENT', 'ESRCH', 'EACCES']) {
    const options = {
      fileSystem: {
        readFileSync: (path) => {
          if (path.endsWith('/boot_id')) return bootId;
          assert.equal(path, '/proc/72/stat');
          throw codedError(code);
        },
        readdirSync: () => ['self', '0072', '0', '72', 'sys'],
      },
      signalProcessGroup: absentGroup,
    };
    if (code === 'EACCES') assert.throws(() => assertExecutorStopped(executor, options), { code });
    else
      assert.deepEqual(assertExecutorStopped(executor, options), { bootId, previousBoot: false });
  }
});

test('missing or malformed executor identity fails before observing host processes', () => {
  const executor = { pid: 42, bootId, startTicks: '12345', sourceSha };
  const options = {
    fileSystem: { readFileSync: () => assert.fail('invalid identity must not inspect the host') },
    signalProcessGroup: () => assert.fail('invalid identity must not probe the host'),
  };
  for (const candidate of [
    null,
    undefined,
    {},
    { ...executor, pid: 0 },
    { ...executor, pid: 1.5 },
    { ...executor, sourceSha: 'unknown' },
    { ...executor, bootId: 'unknown' },
    { ...executor, startTicks: '' },
    { ...executor, startTicks: '1'.repeat(25) },
    { ...executor, startTicks: '-1' },
  ])
    assert.throws(() => assertExecutorStopped(candidate, options), {
      code: 'EXECUTOR_IDENTITY_UNPROVED',
    });
});

test('malformed boot, stat records and a mismatched proc PID cannot prove absence', (t) => {
  const value = procFixture(t);
  const path = join(value.proc, '72/stat');
  value.row(72, { group: 99, startTicks: '67890' });
  for (const raw of [
    '72 (unterminated S 1 99',
    procStat(72, { group: 99, startTicks: 'invalid' }),
    procStat(72, { group: 99, state: '?' }),
    procStat(73, { group: 99, startTicks: '67890' }),
  ]) {
    fs.writeFileSync(path, raw);
    assert.throws(() => assertExecutorStopped(value.executor, value.options), {
      code: 'PROCESS_OBSERVATION_UNPROVED',
    });
  }
  fs.writeFileSync(join(value.proc, 'sys/kernel/random/boot_id'), 'not-a-boot-id\n');
  assert.throws(() => assertExecutorStopped(value.executor, value.options), {
    code: 'PROCESS_OBSERVATION_UNPROVED',
  });
});
