import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import {
  chmodSync,
  existsSync,
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
import { createInterface } from 'node:readline';
import test from 'node:test';
import { deployLockEnvironment, deployLockFixture } from './test-fixtures/deploy-lock.mjs';

function fixture(t) {
  const directory = mkdtempSync(resolve(tmpdir(), 'maxim-flock-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return { directory, ...deployLockFixture(directory) };
}

function command(data, script, args = [], env = {}) {
  return spawnSync(
    'bash',
    ['-c', `set -euo pipefail\nsource "$1"\n${script}`, 'fixture', data.helper, ...args],
    {
      env: deployLockEnvironment(env),
      encoding: 'utf8',
      timeout: 3_000,
    },
  );
}

function observe(data) {
  const result = command(data, 'acquire_deploy_lock; require_deploy_lock; release_deploy_lock');
  assert.equal(result.error, undefined, result.stderr);
  return result.status;
}

function actor(t, data, script, args = []) {
  const child = spawn(
    'bash',
    ['-c', `set -euo pipefail\nsource "$1"\n${script}`, 'fixture', data.helper, ...args],
    {
      env: deployLockEnvironment(),
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
    },
  );
  const lines = [];
  const waiters = [];
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  createInterface({ input: child.stdout }).on('line', (line) => {
    lines.push(line);
    for (const waiter of [...waiters])
      if (waiter.predicate(line)) {
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.resolve(line);
      }
  });
  const done = once(child, 'close').then(([code, signal]) => ({ code, signal, stderr }));
  child.once('close', () => {
    for (const waiter of waiters)
      waiter.reject(new Error(`Actor exited before marker: ${lines.join(', ')}; ${stderr}`));
  });
  t.after(async () => {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch (error) {
      if (error.code !== 'ESRCH') throw error;
    }
    await done;
  });
  return {
    child,
    done,
    lines,
    gate: (value = 'continue') => child.stdin.write(`${value}\n`),
    marker: (predicate) => {
      const found = lines.find(predicate);
      return found === undefined
        ? new Promise((resolveResult, reject) =>
            waiters.push({ predicate, resolve: resolveResult, reject }),
          )
        : Promise.resolve(found);
    },
  };
}

test(
  'simultaneous first admission has one owner and preserves one persistent inode',
  { timeout: 10_000 },
  async (t) => {
    const data = fixture(t);
    const actors = Array.from({ length: 6 }, () =>
      actor(
        t,
        data,
        `
printf '%s\n' READY
read -r _
if ! acquire_deploy_lock; then printf '%s\n' DENIED; exit 1; fi
require_deploy_lock
printf '%s\n' HELD
read -r _
release_deploy_lock
printf '%s\n' RELEASED
`,
      ),
    );
    await Promise.all(actors.map((item) => item.marker((line) => line === 'READY')));
    actors.forEach((item) => item.gate());
    const outcomes = await Promise.all(
      actors.map((item) => item.marker((line) => line === 'HELD' || line === 'DENIED')),
    );
    assert.equal(outcomes.filter((line) => line === 'HELD').length, 1);
    const inode = statSync(data.file).ino;
    assert.equal(statSync(data.file).mode & 0o777, 0o600);
    assert.equal(statSync(data.file).nlink, 1);
    assert.equal(observe(data), 1);
    actors[outcomes.indexOf('HELD')].gate();
    await Promise.all(actors.map((item) => item.done));
    assert.equal(observe(data), 0);
    assert.equal(statSync(data.file).ino, inode);
  },
);

test(
  'same process can source repeatedly and exec without releasing or replacing its flock',
  { timeout: 8_000 },
  async (t) => {
    const data = fixture(t);
    const replacement = resolve(data.directory, 'reexec.sh');
    writeFileSync(
      replacement,
      `#!/usr/bin/env bash
set -euo pipefail
source "$1"
acquire_deploy_lock
require_deploy_lock
printf 'REEXEC %s %s %s\n' "$BASHPID" "$MAXIM_DEPLOY_LOCK_FD" "$MAXIM_DEPLOY_LOCK_IDENTITY"
read -r _
release_deploy_lock
`,
    );
    const owner = actor(
      t,
      data,
      `
acquire_deploy_lock
source "$1"
acquire_deploy_lock
printf 'OWNER %s %s %s\n' "$BASHPID" "$MAXIM_DEPLOY_LOCK_FD" "$MAXIM_DEPLOY_LOCK_IDENTITY"
read -r _
exec bash "$2" "$1"
`,
      [replacement],
    );
    const original = await owner.marker((line) => line.startsWith('OWNER '));
    assert.equal(observe(data), 1);
    owner.gate();
    const next = await owner.marker((line) => line.startsWith('REEXEC '));
    assert.equal(next.replace('REEXEC ', ''), original.replace('OWNER ', ''));
    assert.equal(observe(data), 1);
    owner.gate();
    assert.equal((await owner.done).code, 0);
    assert.equal(observe(data), 0);
  },
);

for (const termination of ['release', 'SIGKILL']) {
  test(
    `inherited child keeps the fence after parent ${termination}, without receiving ownership`,
    { timeout: 8_000 },
    async (t) => {
      const data = fixture(t);
      const fifo = resolve(data.directory, 'child-gate');
      execFileSync('mkfifo', [fifo]);
      const childScript = resolve(data.directory, 'child.sh');
      writeFileSync(
        childScript,
        `#!/usr/bin/env bash
set -euo pipefail
source "$1"
if acquire_deploy_lock; then exit 91; fi
if release_deploy_lock; then exit 92; fi
printf 'CHILD %s\n' "$BASHPID"
read -r _ <"$2"
printf '%s\n' CHILD_DONE
`,
      );
      const owner = actor(
        t,
        data,
        `
acquire_deploy_lock
bash "$2" "$1" "$3" &
printf 'PARENT %s\n' "$BASHPID"
read -r _
release_deploy_lock
printf '%s\n' PARENT_RELEASED
`,
        [childScript, fifo],
      );
      const childPid = Number(
        (await owner.marker((line) => line.startsWith('CHILD '))).split(' ')[1],
      );
      t.after(() => {
        try {
          process.kill(childPid, 'SIGKILL');
        } catch (error) {
          if (error.code !== 'ESRCH') throw error;
        }
      });
      assert.equal(observe(data), 1);
      const exited = once(owner.child, 'exit');
      if (termination === 'release') owner.gate();
      else owner.child.kill(termination);
      await exited;
      assert.equal(observe(data), 1);
      process.kill(childPid, 0);
      writeFileSync(fifo, 'continue\n');
      await owner.marker((line) => line === 'CHILD_DONE');
      await owner.done;
      assert.equal(spawnSync('flock', ['-n', data.file, 'true']).status, 0);
      assert.equal(observe(data), termination === 'release' ? 0 : 1);
      assert.equal(
        existsSync(resolve(data.pair.state, 'admission.owner')),
        termination !== 'release',
      );
    },
  );
}

test(
  'a killed owner releases its product flock but preserves unresolved common admission and its inode',
  { timeout: 8_000 },
  async (t) => {
    const data = fixture(t);
    const owner = actor(t, data, 'acquire_deploy_lock; printf "%s\\n" HELD; read -r _');
    await owner.marker((line) => line === 'HELD');
    const inode = statSync(data.file).ino;
    const ownerFile = resolve(data.pair.state, 'admission.owner');
    const record = readFileSync(ownerFile, 'utf8');
    owner.child.kill('SIGKILL');
    await owner.done;
    assert.equal(spawnSync('flock', ['-n', data.file, 'true']).status, 0);
    assert.equal(observe(data), 1);
    assert.equal(readFileSync(ownerFile, 'utf8'), record);
    assert.equal(statSync(data.file).ino, inode);
  },
);

test('all legacy states refuse admission without deleting or changing another actor', (t) => {
  const data = fixture(t);
  for (const state of ['empty', 'invalid', 'dead', 'live']) {
    mkdirSync(data.legacyDirectory);
    const content =
      state === 'empty'
        ? undefined
        : state === 'invalid'
          ? 'unknown\n'
          : state === 'dead'
            ? '99999999\n'
            : `${process.pid}\n`;
    if (content !== undefined) writeFileSync(resolve(data.legacyDirectory, 'pid'), content);
    const before = statSync(data.legacyDirectory).ino;
    assert.equal(observe(data), 1);
    assert.equal(statSync(data.legacyDirectory).ino, before);
    if (content !== undefined)
      assert.equal(readFileSync(resolve(data.legacyDirectory, 'pid'), 'utf8'), content);
    assert.equal(existsSync(data.file), false);
    rmSync(data.legacyDirectory, { recursive: true });
  }
  symlinkSync(resolve(data.directory, 'absent'), data.legacyDirectory);
  assert.equal(observe(data), 1);
  assert.equal(existsSync(data.file), false);
});

test('path overrides, symlinks, hardlinks and unsafe permissions fail closed', (t) => {
  const data = fixture(t);
  assert.equal(
    command(data, 'acquire_deploy_lock', [], { MAXIM_DEPLOY_LOCK_DIR: data.directory }).status,
    1,
  );
  assert.equal(existsSync(data.file), false);
  chmodSync(data.protectedDirectory, 0o770);
  assert.equal(observe(data), 1);
  chmodSync(data.protectedDirectory, 0o700);
  const foreign = resolve(data.directory, 'unrelated');
  writeFileSync(foreign, 'unrelated', { mode: 0o600 });
  symlinkSync(foreign, data.file);
  assert.equal(observe(data), 1);
  assert.equal(readFileSync(foreign, 'utf8'), 'unrelated');
  rmSync(data.file);
  linkSync(foreign, data.file);
  assert.equal(observe(data), 1);
  rmSync(data.file);
  writeFileSync(data.file, '', { mode: 0o640 });
  // FLAG: File creation applies the caller's umask; install the unsafe fixture
  // explicitly so a private 0077 runner still exercises the permission refusal.
  chmodSync(data.file, 0o640);
  assert.equal(statSync(data.file).mode & 0o777, 0o640);
  assert.equal(observe(data), 1);
  chmodSync(data.file, 0o600);
  assert.equal(observe(data), 0);
});

test(
  'the actual Node runtime inherits the fence after shell death',
  { timeout: 8_000 },
  async (t) => {
    const data = fixture(t);
    const fifo = resolve(data.directory, 'node-gate');
    execFileSync('mkfifo', [fifo]);
    const script = resolve(data.directory, 'child.cjs');
    writeFileSync(
      script,
      `const fs = require('node:fs');
const descriptor = Number(process.env.MAXIM_DEPLOY_LOCK_FD);
fs.fstatSync(descriptor);
const info = fs.readFileSync('/proc/' + process.pid + '/fdinfo/' + descriptor, 'utf8');
if (!/FLOCK\\s+ADVISORY\\s+WRITE/.test(info)) process.exit(91);
console.log('NODE ' + process.pid);
fs.readFileSync(process.argv[2]);
console.log('NODE_DONE');
`,
    );
    const owner = actor(
      t,
      data,
      `
acquire_deploy_lock
"$2" "$3" "$4" &
read -r _
`,
      [process.execPath, script, fifo],
    );
    await owner.marker((line) => line.startsWith('NODE '));
    assert.equal(observe(data), 1);
    const exited = once(owner.child, 'exit');
    owner.child.kill('SIGKILL');
    await exited;
    assert.equal(observe(data), 1);
    writeFileSync(fifo, 'continue\n');
    await owner.marker((line) => line === 'NODE_DONE');
    await owner.done;
    assert.equal(spawnSync('flock', ['-n', data.file, 'true']).status, 0);
    assert.equal(observe(data), 1);
    assert.equal(existsSync(resolve(data.pair.state, 'admission.owner')), true);
  },
);

test('only physical Svyazka paths exclude common admission; inherited project variables do not', (t) => {
  const data = fixture(t);
  const svyazka = resolve(data.directory, 'svyazka');
  mkdirSync(svyazka);
  writeFileSync(
    data.helper,
    readFileSync(data.helper, 'utf8').replaceAll('/var/www/svyazka', svyazka),
  );
  const inherited = command(data, 'maxim_pair_release_required', [], {
    root: svyazka,
    source_dir: resolve(svyazka, 'release'),
    PWD: svyazka,
  });
  assert.equal(inherited.status, 0, inherited.stderr);

  const physicalDirectory = command(
    data,
    'cd "$2"; if maxim_pair_release_required; then exit 91; fi; maxim_pair_release_assert',
    [svyazka],
  );
  assert.equal(physicalDirectory.status, 0, physicalDirectory.stderr);

  const caller = resolve(svyazka, 'caller.sh');
  writeFileSync(
    caller,
    'set -euo pipefail\nsource "$1"\nif maxim_pair_release_required; then exit 91; fi\nmaxim_pair_release_assert\n',
  );
  const physicalCaller = spawnSync('bash', [caller, data.helper], {
    env: deployLockEnvironment(),
    encoding: 'utf8',
    timeout: 3_000,
  });
  assert.equal(physicalCaller.status, 0, physicalCaller.stderr);
});

test('matching unheld inherited FD is not authority', (t) => {
  const data = fixture(t);
  assert.equal(observe(data), 0);
  const result = command(
    data,
    `
exec {MAXIM_DEPLOY_LOCK_FD}<>"$(deploy_lock_file)"
export MAXIM_DEPLOY_LOCK_VERSION=flock-v1 MAXIM_DEPLOY_LOCK_OWNER_PID="$BASHPID"
export MAXIM_DEPLOY_LOCK_IDENTITY="$(stat -c '%d:%i' "$(deploy_lock_file)")"
if acquire_deploy_lock; then exit 91; fi
if release_deploy_lock; then exit 92; fi
`,
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /no exclusive whole-file flock/u);
  assert.equal(observe(data), 0);
});

test('authority checks and partial inherited markers never create a lock file', (t) => {
  const data = fixture(t);
  assert.equal(command(data, 'require_deploy_lock').status, 1);
  assert.equal(existsSync(data.file), false);
  assert.equal(
    command(data, 'acquire_deploy_lock', [], { MAXIM_DEPLOY_LOCK_VERSION: 'flock-v1' }).status,
    1,
  );
  assert.equal(existsSync(data.file), false);
});

test(
  'invalid descriptor identity cannot release an unrelated actor lock',
  { timeout: 8_000 },
  async (t) => {
    const data = fixture(t);
    assert.equal(observe(data), 0);
    const foreign = resolve(data.directory, 'unrelated');
    writeFileSync(foreign, 'preserve', { mode: 0o600 });
    const owner = actor(
      t,
      data,
      `
exec {MAXIM_DEPLOY_LOCK_FD}<>"$2"
flock -n "$MAXIM_DEPLOY_LOCK_FD"
export MAXIM_DEPLOY_LOCK_VERSION=flock-v1 MAXIM_DEPLOY_LOCK_OWNER_PID="$BASHPID"
export MAXIM_DEPLOY_LOCK_IDENTITY="$(stat -c '%d:%i' "$(deploy_lock_file)")"
if acquire_deploy_lock; then exit 91; fi
if release_deploy_lock; then exit 92; fi
printf '%s\n' PRESERVED
read -r _
`,
      [foreign],
    );
    await owner.marker((line) => line === 'PRESERVED');
    assert.equal(spawnSync('flock', ['-n', foreign, 'true']).status, 1);
    assert.equal(observe(data), 0);
    assert.equal(readFileSync(foreign, 'utf8'), 'preserve');
    owner.gate();
    assert.equal((await owner.done).code, 0);
    assert.equal(spawnSync('flock', ['-n', foreign, 'true']).status, 0);
  },
);

test('admission diagnostics prove pair conflict without changing the shared helper', async (t) => {
  const data = fixture(t);
  const holder = actor(t, data, 'exec 9<>"$2"; flock 9; printf "HELD\\n"; read -r _', [
    data.pair.file,
  ]);
  await holder.marker((line) => line === 'HELD');
  const denied = command(
    data,
    'if acquire_deploy_lock; then exit 99; fi; printf "%s\\n" "$MAXIM_DEPLOY_ADMISSION_REFUSAL"',
  );
  assert.equal(denied.status, 0, denied.stderr);
  assert.equal(denied.stdout.trim(), 'pair_lock_busy');
  holder.gate();
  await holder.done;
  assert.equal(observe(data), 0);
});

for (const helperStatus of [70, 75]) {
  test(`a pair helper refusal ${helperStatus} after a free probe remains unknown`, (t) => {
    const data = fixture(t);
    const denied = command(
      data,
      `
maxim_pair_release_load
maxim_pair_release_load() { :; }
pair_release_admission_acquire() { return ${helperStatus}; }
MAXIM_DEPLOY_ADMISSION_REFUSAL=pair_lock_busy
if acquire_deploy_lock; then exit 99; fi
printf '%s\\n' "$MAXIM_DEPLOY_ADMISSION_REFUSAL"
`,
    );
    assert.equal(denied.status, 0, denied.stderr);
    assert.equal(denied.stdout.trim(), 'unknown');
  });
}

for (const [flockStatus, releaseStatus, expected] of [
  [75, 0, 'product_lock_busy'],
  [70, 0, 'unknown'],
  [75, 70, 'unknown'],
]) {
  test(`product refusal classifies only conflict=${flockStatus} with successful release=${releaseStatus}`, (t) => {
    const data = fixture(t);
    const denied = command(
      data,
      `
maxim_pair_release_required() { return 1; }
maxim_pair_release_release() { return ${releaseStatus}; }
flock() { return ${flockStatus}; }
if acquire_deploy_lock; then exit 99; fi
trap - EXIT
printf '%s\\n' "$MAXIM_DEPLOY_ADMISSION_REFUSAL"
`,
    );
    assert.equal(denied.status, 0, denied.stderr);
    assert.equal(denied.stdout.trim(), expected);
  });
}

test('pair probe utility errors never become a busy classification', (t) => {
  const data = fixture(t);
  const denied = command(
    data,
    `flock() { return 70; }; if acquire_deploy_lock; then exit 99; fi; printf '%s\\n' "$MAXIM_DEPLOY_ADMISSION_REFUSAL"`,
  );
  assert.equal(denied.status, 0, denied.stderr);
  assert.equal(denied.stdout.trim(), 'unknown');
});
