import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { deployLockEnvironment, deployLockFixture } from './test-fixtures/deploy-lock.mjs';

const root = new URL('../..', import.meta.url).pathname;
const helper = join(root, 'infra/scripts/backup-postgres.sh');
const rateLimiter = join(root, 'infra/scripts/rate-limit-stream.mjs');
const installer = join(root, 'infra/scripts/vps-install-postgres-backup-timers.sh');
const envExample = join(root, 'infra/env/postgres-backup.env.example');

const READY_JSON = JSON.stringify({
  ok: true,
  checks: {
    database: true,
    redis: true,
    queueLag: { rawOk: true, softWarning: false },
  },
});

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'maxim-postgres-backup-'));
  const bin = join(directory, 'bin');
  const backup = join(directory, 'backup');
  const dockerLog = join(directory, 'docker.log');
  const cleanupMarker = join(directory, 'cleanup-called');
  const readyCounter = join(directory, 'ready-counter');
  const dumpPid = join(directory, 'dump.pid');
  const lock = join(directory, 'backup.lock');
  const deployLockData = deployLockFixture(directory);
  const deployLock = deployLockData.file;
  const isolatedHelper = join(directory, 'backup-postgres.sh');
  writeFileSync(
    isolatedHelper,
    readFileSync(helper, 'utf8')
      .replace(/^ROOT_DIR=.*$/mu, `ROOT_DIR='${root}'`)
      .replace(
        'DEPLOY_LOCK_HELPER="$ROOT_DIR/infra/scripts/lib/deploy-lock.sh"',
        `DEPLOY_LOCK_HELPER='${deployLockData.helper}'`,
      ),
  );
  mkdirSync(bin);
  mkdirSync(backup);

  writeFileSync(
    join(bin, 'curl'),
    `#!/usr/bin/env bash
set -euo pipefail
if [[ "\${MOCK_READY_FAIL:-0}" == 1 ]]; then
  exit 22
fi
if [[ -n "\${MOCK_READY_COUNTER_FILE:-}" ]]; then
  count=0
  if [[ -f "\${MOCK_READY_COUNTER_FILE}" ]]; then
    count="$(cat "\${MOCK_READY_COUNTER_FILE}")"
  fi
  count=$((count + 1))
  printf '%s' "$count" >"\${MOCK_READY_COUNTER_FILE}"
  if [[ -n "\${MOCK_DEGRADE_AFTER_CALL:-}" ]] && ((count > MOCK_DEGRADE_AFTER_CALL)); then
    printf '%s' "\${MOCK_DEGRADED_READY_JSON}"
    exit 0
  fi
fi
printf '%s' "\${MOCK_READY_JSON}"
`,
  );
  writeFileSync(
    join(bin, 'docker'),
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >>"\${MOCK_DOCKER_LOG}"
all_args="$*"
if [[ "$all_args" == *pg_database_size* ]]; then
  printf '%s\n' "\${MOCK_DATABASE_BYTES:-4096}"
  exit 0
fi
if [[ "$all_args" == *pg_terminate_backend* ]]; then
  : >"\${MOCK_CLEANUP_MARKER}"
  exit 0
fi
if [[ "$all_args" == *pg_restore* ]]; then
  cat >/dev/null
  if [[ "\${MOCK_RESTORE_FAIL:-0}" == 1 ]]; then
    exit 9
  fi
  exit 0
fi
if [[ "$all_args" == *pg_dump* ]]; then
  if [[ -n "\${MOCK_DUMP_PID_FILE:-}" ]]; then
    printf '%s' "$$" >"\${MOCK_DUMP_PID_FILE}"
  fi
  sleep "\${MOCK_DUMP_SLEEP_SEC:-0}"
  if [[ "\${MOCK_DUMP_FAIL:-0}" == 1 ]]; then
    exit 7
  fi
  printf '%s' "\${MOCK_DUMP:-custom dump payload}"
  exit 0
fi
echo 'unexpected docker invocation' >&2
exit 1
`,
  );
  writeFileSync(
    join(bin, 'node'),
    `#!/usr/bin/env bash
set -euo pipefail
if [[ "\${1:-}" == *check-eraser-backup-readiness.mjs ]]; then
  exit "\${MOCK_ERASER_READY_STATUS:-0}"
fi
if [[ "\${1:-}" == *rate-limit-stream.mjs && "\${MOCK_LIMITER_FAIL:-0}" == 1 ]]; then
  exit 8
fi
exec "\${MOCK_REAL_NODE}" "$@"
`,
  );
  for (const executable of ['curl', 'docker', 'node']) {
    chmodSync(join(bin, executable), 0o755);
  }
  return {
    directory,
    bin,
    backup,
    dockerLog,
    cleanupMarker,
    readyCounter,
    dumpPid,
    lock,
    deployLock,
    deployLockData,
    isolatedHelper,
  };
}

function helperEnv(data, extraEnv = {}) {
  return deployLockEnvironment({
    PATH: `${data.bin}:${process.env.PATH}`,
    MAXIM_BACKUP_DIR: data.backup,
    MAXIM_BACKUP_COMPOSE_FILE: join(data.directory, 'compose.yml'),
    MAXIM_BACKUP_MIN_FREE_BYTES: '1',
    MAXIM_BACKUP_REQUIRE_DEDICATED_FILESYSTEM: '0',
    MAXIM_BACKUP_LOCK_FILE: data.lock,
    MAXIM_BACKUP_MAX_DURATION_SEC: '5',
    MOCK_READY_JSON: READY_JSON,
    MOCK_DOCKER_LOG: data.dockerLog,
    MOCK_CLEANUP_MARKER: data.cleanupMarker,
    MOCK_READY_COUNTER_FILE: data.readyCounter,
    MOCK_DUMP_PID_FILE: data.dumpPid,
    MOCK_REAL_NODE: process.execPath,
    ...extraEnv,
  });
}

function runHelper(data, args = [], extraEnv = {}) {
  return spawnSync('bash', [data.isolatedHelper, ...args], {
    cwd: root,
    encoding: 'utf8',
    timeout: 10_000,
    env: helperEnv(data, extraEnv),
  });
}

function rootRunner(t) {
  // FLAG: Real Git must see a different owner with no sudo/user config trust,
  // matching the root systemd producer rather than an operator's sudo shell.
  const clean = [
    '/usr/bin/env',
    '-i',
    `PATH=${process.env.PATH}`,
    'GIT_CONFIG_NOSYSTEM=1',
    'GIT_CONFIG_SYSTEM=/dev/null',
    'GIT_CONFIG_GLOBAL=/dev/null',
  ];
  const candidates = process.getuid() === 0 ? [clean] : [['sudo', '-n', ...clean]];
  if (process.getuid() !== 0 && process.env.WSL_DISTRO_NAME) {
    candidates.push([
      '/mnt/c/WINDOWS/system32/wsl.exe',
      '--distribution',
      process.env.WSL_DISTRO_NAME,
      '--user',
      'root',
      '--exec',
      ...clean,
    ]);
  }
  for (const [executable, ...prefix] of candidates) {
    const run = (args, env = {}) =>
      spawnSync(
        executable,
        [...prefix, ...Object.entries(env).map(([k, v]) => `${k}=${v}`), ...args],
        {
          encoding: 'utf8',
          timeout: 20_000,
        },
      );
    if (run([process.execPath, '-e', 'process.exit(process.getuid() === 0 ? 0 : 1)']).status === 0)
      return run;
  }
  t.skip('Cross-UID coverage requires passwordless root execution.');
  return null;
}

for (const source of [
  'clean',
  'clean-stale-stat',
  'wrong-revision',
  'dirty-scripts',
  'dirty-script-mode',
  'deleted-script',
  'invalid-index',
]) {
  test(`root scheduled producer checks operator-owned source before dump: ${source}`, (t) => {
    const elevated = rootRunner(t);
    if (!elevated) return;
    const data = fixture();
    t.after(() => {
      const cleanup = elevated(['rm', '-rf', '--', data.directory]);
      assert.equal(cleanup.status, 0, cleanup.stderr);
    });
    const repo = join(data.directory, 'repo');
    mkdirSync(join(repo, 'infra/scripts/lib'), { recursive: true });
    for (const file of [
      'lib/postgres-backup-profile.sh',
      'probe-postgres-backup-readiness.mjs',
      'check-postgres-backup-readiness.mjs',
      'postgres-backup-schedule.mjs',
      'rate-limit-stream.mjs',
    ]) {
      writeFileSync(
        join(repo, 'infra/scripts', file),
        readFileSync(join(root, 'infra/scripts', file)),
      );
    }
    const producer = join(repo, 'infra/scripts/backup-postgres.sh');
    writeFileSync(
      producer,
      readFileSync(helper, 'utf8').replace(
        'DEPLOY_LOCK_HELPER="$ROOT_DIR/infra/scripts/lib/deploy-lock.sh"',
        `DEPLOY_LOCK_HELPER='${data.deployLockData.helper}'`,
      ),
    );
    const sourceOnly = join(repo, 'infra/scripts/source-only.sh');
    writeFileSync(sourceOnly, '# fixture-only source\n');
    const git = (...args) => {
      const result = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
      return result.stdout.trim();
    };
    git('init', '--quiet');
    git('add', 'infra');
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
    const sha = git('rev-parse', 'HEAD');
    if (source === 'clean-stale-stat') {
      const changedTime = new Date(Date.now() + 5_000);
      utimesSync(sourceOnly, changedTime, changedTime);
    } else if (source === 'dirty-scripts') {
      writeFileSync(sourceOnly, '# changed source\n');
    } else if (source === 'dirty-script-mode') {
      chmodSync(sourceOnly, 0o755);
    } else if (source === 'deleted-script') {
      rmSync(sourceOnly);
    } else if (source === 'invalid-index') {
      writeFileSync(join(repo, '.git/index'), 'invalid fixture index\n');
    }
    if (process.getuid() === 0) {
      const ownership = elevated(['chown', '-R', '65534', repo]);
      assert.equal(ownership.status, 0, ownership.stderr);
    }
    writeFileSync(data.deployLock, '', { mode: 0o600 });
    writeFileSync(data.dockerLog, '');
    const denied = elevated(['git', '-C', repo, 'rev-parse', 'HEAD']);
    assert.equal(denied.status, 128);
    assert.match(denied.stderr, /dubious ownership/);
    const configured = helperEnv(data, {
      MAXIM_BACKUP_SOURCE_SHA: source === 'wrong-revision' ? 'b'.repeat(40) : sha,
      MAXIM_BACKUP_PROFILE: 'maxim',
      MAXIM_BACKUP_REPLICATION_REQUIRED: '0',
    });
    const env = Object.fromEntries(
      Object.entries(configured).filter(([name]) => /^(?:PATH$|MAXIM_BACKUP_|MOCK_)/.test(name)),
    );
    env.GIT_OPTIONAL_LOCKS = '1';
    const gitPaths = ['.git', '.git/index', '.git/HEAD', '.git/config'];
    const gitMetadata = () =>
      gitPaths.map((name) => {
        const value = statSync(join(repo, name), { bigint: true });
        return {
          name,
          uid: value.uid,
          gid: value.gid,
          mode: value.mode,
          ino: value.ino,
          size: value.size,
          mtimeNs: value.mtimeNs,
          ctimeNs: value.ctimeNs,
        };
      });
    const metadataBefore = gitMetadata();
    const contentBefore = gitPaths.slice(1).map((name) =>
      createHash('sha256')
        .update(readFileSync(join(repo, name)))
        .digest('hex'),
    );
    const result = elevated(['bash', producer], env);
    const clean = source === 'clean' || source === 'clean-stale-stat';
    assert.equal(result.status, clean ? 0 : source === 'invalid-index' ? 128 : 1, result.stderr);
    assert.deepEqual(
      gitMetadata(),
      metadataBefore,
      'Source reads must preserve Git ownership and metadata',
    );
    assert.deepEqual(
      gitPaths.slice(1).map((name) =>
        createHash('sha256')
          .update(readFileSync(join(repo, name)))
          .digest('hex'),
      ),
      contentBefore,
      'Source reads must preserve Git file bytes',
    );
    assert.doesNotMatch(result.stdout, /source-only\.sh|changed source/u);
    assert.doesNotMatch(result.stderr, /dubious ownership/);
    const operations = readFileSync(data.dockerLog, 'utf8');
    if (clean) {
      assert.match(operations, /pg_dump/);
      assert.equal(dumpFiles(data).filter((name) => name.endsWith('.dump')).length, 1);
    } else {
      assert.equal(operations, '');
      assert.deepEqual(dumpFiles(data), []);
    }
    assert.equal(elevated(['git', '-C', repo, 'rev-parse', 'HEAD']).status, 128);
    assert.equal(spawnSync('flock', ['-n', data.deployLock, 'true']).status, 0);
  });
}

function dumpFiles(data) {
  return readdirSync(data.backup).filter((name) => name.includes('.dump'));
}

test('creates a rate-limited low-priority dump and publishes the validated pair atomically', (t) => {
  const data = fixture();
  t.after(() => rmSync(data.directory, { force: true, recursive: true }));

  const result = runHelper(data);
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);

  const names = readdirSync(data.backup).sort();
  const dumpName = names.find((name) => /^maxim_.*\.dump$/u.test(name));
  assert.ok(dumpName);
  assert.deepEqual(names, [dumpName, `${dumpName}.sha256`].sort());
  assert.equal(readFileSync(join(data.backup, dumpName), 'utf8'), 'custom dump payload');
  assert.equal(statSync(join(data.backup, dumpName)).mode & 0o777, 0o600);

  const dockerLog = readFileSync(data.dockerLog, 'utf8');
  assert.match(dockerLog, /PGAPPNAME="\$3" ionice -c2 -n7 nice -n19 pg_dump/u);
  assert.match(dockerLog, /--compress=gzip:3/u);
  assert.match(dockerLog, /--lock-wait-timeout=10s/u);
  assert.match(dockerLog, /maxim-postgres-backup-[0-9TZ]+-[0-9]+/u);
  assert.equal(existsSync(data.cleanupMarker), true);
  assert.equal(existsSync(data.deployLock), true);
  assert.equal(spawnSync('flock', ['-n', data.deployLock, 'true']).status, 0);
  assert.doesNotMatch(names.join('\n'), /\.tmp$/u);
});

test('rejects degraded raw queue lag before sizing or creating a temporary dump', (t) => {
  const data = fixture();
  t.after(() => rmSync(data.directory, { force: true, recursive: true }));
  const degraded = JSON.stringify({
    ok: true,
    checks: {
      database: true,
      redis: true,
      queueLag: { rawOk: false, softWarning: true },
    },
  });

  const result = runHelper(data, [], { MOCK_READY_JSON: degraded });
  assert.equal(result.status, 75, result.stderr);
  assert.match(result.stderr, /raw queue lag is degraded/u);
  assert.equal(existsSync(data.dockerLog), false);
  assert.deepEqual(readdirSync(data.backup), []);
});

test('uses a nonblocking lock and does not enter readiness while another run owns it', async (t) => {
  const data = fixture();
  t.after(() => rmSync(data.directory, { force: true, recursive: true }));
  const readyMarker = join(data.directory, 'lock-ready');
  const holder = spawn('flock', [data.lock, 'bash', '-c', `: >${readyMarker}; sleep 5`], {
    stdio: 'ignore',
  });
  t.after(() => holder.kill('SIGTERM'));
  for (let attempt = 0; attempt < 50 && !existsSync(readyMarker); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(existsSync(readyMarker), true);

  const result = runHelper(data);
  assert.equal(result.status, 75, result.stderr);
  assert.match(result.stderr, /already running/u);
  assert.equal(existsSync(data.dockerLog), false);
});

test('refuses a live legacy deploy lock without touching PostgreSQL or deleting its state', (t) => {
  const data = fixture();
  t.after(() => rmSync(data.directory, { force: true, recursive: true }));
  mkdirSync(data.deployLockData.legacyDirectory);
  writeFileSync(join(data.deployLockData.legacyDirectory, 'pid'), `${process.pid}\n`);

  const result = runHelper(data);

  assert.equal(result.status, 75, result.stderr);
  assert.match(result.stderr, /deployment or maintenance operation is active/u);
  assert.equal(existsSync(data.dockerLog), false);
  assert.equal(
    readFileSync(join(data.deployLockData.legacyDirectory, 'pid'), 'utf8'),
    `${process.pid}\n`,
  );
});

test(
  'the real persistent flock fences the backup before PostgreSQL work',
  { timeout: 5_000 },
  async (t) => {
    const data = fixture();
    t.after(() => rmSync(data.directory, { force: true, recursive: true }));
    writeFileSync(data.deployLock, '', { mode: 0o600 });
    const holder = spawn(
      'flock',
      ['-n', data.deployLock, 'bash', '-c', 'printf "%s\\n" READY; read -r _'],
      {
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    const done = once(holder, 'close');
    t.after(async () => {
      holder.stdin.end('release\n');
      await done;
    });
    const [ready] = await once(holder.stdout, 'data');
    assert.equal(ready.toString().trim(), 'READY');
    const inode = statSync(data.deployLock).ino;
    const result = runHelper(data);
    assert.equal(result.status, 75, result.stderr);
    assert.equal(existsSync(data.dockerLog), false);
    assert.equal(statSync(data.deployLock).ino, inode);
    assert.equal(spawnSync('flock', ['-n', data.deployLock, 'true']).status, 1);
    holder.stdin.end('release\n');
    await done;
    assert.equal(spawnSync('flock', ['-n', data.deployLock, 'true']).status, 0);
  },
);

test('bounds dump duration, terminates its exact backend, and removes temporary output', (t) => {
  const data = fixture();
  t.after(() => rmSync(data.directory, { force: true, recursive: true }));

  const startedAt = Date.now();
  const result = runHelper(data, [], {
    MAXIM_BACKUP_MAX_DURATION_SEC: '1',
    MOCK_DUMP_SLEEP_SEC: '5',
  });
  const elapsedMs = Date.now() - startedAt;
  assert.notEqual(result.status, 0);
  assert.ok(elapsedMs < 3_000, `backup timeout took ${elapsedMs}ms`);
  assert.match(result.stderr, /bounded resource envelope/u);
  assert.equal(existsSync(data.cleanupMarker), true);
  assert.deepEqual(dumpFiles(data), []);
  assert.doesNotMatch(readdirSync(data.backup).join('\n'), /\.tmp$/u);
});

test('SIGTERM terminates the exact backend and every local pipeline process', async (t) => {
  const data = fixture();
  t.after(() => rmSync(data.directory, { force: true, recursive: true }));
  const child = spawn('bash', [data.isolatedHelper], {
    cwd: root,
    stdio: 'ignore',
    env: helperEnv(data, {
      MAXIM_BACKUP_MAX_DURATION_SEC: '20',
      MOCK_DUMP_SLEEP_SEC: '10',
    }),
  });
  t.after(() => child.kill('SIGKILL'));
  for (let attempt = 0; attempt < 100 && !existsSync(data.dumpPid); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(existsSync(data.dumpPid), true);

  child.kill('SIGTERM');
  const [code, signal] = await once(child, 'exit');
  assert.equal(signal, null);
  assert.equal(code, 143);
  assert.equal(existsSync(data.cleanupMarker), true);
  assert.deepEqual(dumpFiles(data), []);
  assert.doesNotMatch(readdirSync(data.backup).join('\n'), /\.tmp$/u);
  const dumpPid = Number(readFileSync(data.dumpPid, 'utf8'));
  assert.throws(() => process.kill(dumpPid, 0), { code: 'ESRCH' });
});

test('does not publish dump bytes that fail restore-list validation', (t) => {
  const data = fixture();
  t.after(() => rmSync(data.directory, { force: true, recursive: true }));

  const result = runHelper(data, [], { MOCK_RESTORE_FAIL: '1' });
  assert.notEqual(result.status, 0);
  assert.deepEqual(dumpFiles(data), []);
  assert.doesNotMatch(readdirSync(data.backup).join('\n'), /\.tmp$/u);
});

test('stops the dump backend immediately when the stream limiter fails', (t) => {
  const data = fixture();
  t.after(() => rmSync(data.directory, { force: true, recursive: true }));

  const startedAt = Date.now();
  const result = runHelper(data, [], {
    MAXIM_BACKUP_MAX_DURATION_SEC: '20',
    MOCK_DUMP_SLEEP_SEC: '10',
    MOCK_LIMITER_FAIL: '1',
  });
  const elapsedMs = Date.now() - startedAt;

  assert.notEqual(result.status, 0);
  assert.ok(elapsedMs < 3_000, `limiter failure cleanup took ${elapsedMs}ms`);
  assert.equal(existsSync(data.cleanupMarker), true);
  assert.deepEqual(dumpFiles(data), []);
  const dumpPid = Number(readFileSync(data.dumpPid, 'utf8'));
  assert.throws(() => process.kill(dumpPid, 0), { code: 'ESRCH' });
});

test('aborts the exact dump backend after two consecutive watchdog failures', (t) => {
  const data = fixture();
  t.after(() => rmSync(data.directory, { force: true, recursive: true }));
  const degraded = JSON.stringify({
    ok: true,
    checks: {
      database: true,
      redis: true,
      queueLag: { rawOk: false, softWarning: true },
    },
  });

  const startedAt = Date.now();
  const result = runHelper(data, [], {
    MAXIM_BACKUP_MAX_DURATION_SEC: '20',
    MAXIM_BACKUP_WATCHDOG_INTERVAL_SEC: '1',
    MAXIM_BACKUP_WATCHDOG_FAILURE_THRESHOLD: '2',
    MOCK_DEGRADE_AFTER_CALL: '1',
    MOCK_DEGRADED_READY_JSON: degraded,
    MOCK_DUMP_SLEEP_SEC: '10',
  });
  const elapsedMs = Date.now() - startedAt;

  assert.notEqual(result.status, 0);
  assert.ok(elapsedMs < 5_000, `watchdog abort took ${elapsedMs}ms`);
  assert.match(result.stderr, /watchdog observed degraded readiness.*1\/2/iu);
  assert.match(result.stderr, /watchdog observed degraded readiness.*2\/2/iu);
  assert.match(result.stderr, /aborted after sustained readiness/iu);
  const probes = result.stderr
    .split('\n')
    .filter((line) => line.startsWith('{'))
    .map((line) => JSON.parse(line));
  assert.equal(probes.length, 2);
  assert.ok(
    probes.every(
      (probe) =>
        probe.metric === 'backup_readiness_v1' &&
        probe.failures.includes('raw_queue_lag') &&
        probe.failures.includes('queue_soft_warning'),
    ),
  );
  assert.equal(existsSync(data.cleanupMarker), true);
  assert.deepEqual(dumpFiles(data), []);
  const dumpPid = Number(readFileSync(data.dumpPid, 'utf8'));
  assert.throws(() => process.kill(dumpPid, 0), { code: 'ESRCH' });
});

test('preflight checks readiness and capacity without deleting or starting a dump', (t) => {
  const data = fixture();
  t.after(() => rmSync(data.directory, { force: true, recursive: true }));
  const oldDump = join(data.backup, 'maxim_20200101T000000Z.dump');
  writeFileSync(oldDump, 'old dump');
  writeFileSync(`${oldDump}.sha256`, 'old checksum');
  const oldTime = new Date('2020-01-01T00:00:00.000Z');
  utimesSync(oldDump, oldTime, oldTime);
  utimesSync(`${oldDump}.sha256`, oldTime, oldTime);

  const result = runHelper(data, ['--preflight-only']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /readiness and capacity preflight passed/u);
  assert.equal(existsSync(oldDump), true);
  assert.equal(existsSync(`${oldDump}.sha256`), true);
  assert.doesNotMatch(readFileSync(data.dockerLog, 'utf8'), /pg_dump/u);
});

test('repository stream limiter enforces its configured average byte rate', () => {
  const input = Buffer.alloc(65_536, 0x61);
  const startedAt = Date.now();
  const result = spawnSync(process.execPath, [rateLimiter, '131072'], {
    input,
    maxBuffer: input.length * 2,
  });
  const elapsedMs = Date.now() - startedAt;

  assert.equal(result.status, 0, result.stderr.toString());
  assert.deepEqual(result.stdout, input);
  assert.ok(elapsedMs >= 400, `rate limiter emitted too quickly in ${elapsedMs}ms`);
  assert.ok(elapsedMs < 2_000, `rate limiter emitted too slowly in ${elapsedMs}ms`);
});

test('timer and environment keep the scheduled backup bounded and fail closed', () => {
  const installerSource = readFileSync(installer, 'utf8');
  const envSource = readFileSync(envExample, 'utf8');

  assert.match(installerSource, /SuccessExitStatus=75/u);
  assert.match(installerSource, /TimeoutStartSec=12h15m/u);
  assert.match(installerSource, /TimeoutStopSec=1m/u);
  assert.match(installerSource, /KillSignal=SIGTERM/u);
  assert.match(installerSource, /Restart=no/u);
  assert.match(installerSource, /MAXIM_ENABLE_POSTGRES_BACKUP_TIMER:-0/u);
  assert.match(envSource, /MAXIM_BACKUP_RATE_LIMIT_BYTES_PER_SEC=1048576/u);
  assert.match(envSource, /MAXIM_BACKUP_MAX_DURATION_SEC=43200/u);
  assert.match(envSource, /MAXIM_BACKUP_WATCHDOG_INTERVAL_SEC=30/u);
  assert.match(envSource, /MAXIM_BACKUP_WATCHDOG_FAILURE_THRESHOLD=2/u);
  assert.match(envSource, /MAXIM_BACKUP_READINESS_URL=http:\/\/127\.0\.0\.1:3001/u);
});

test('Lastik profile selects only its fixed store and isolated archive namespace', (t) => {
  const data = fixture();
  t.after(() => rmSync(data.directory, { recursive: true, force: true }));
  const result = runHelper(data, [], { MAXIM_BACKUP_PROFILE: 'eraser' });
  assert.equal(result.status, 0, result.stderr);
  const operations = readFileSync(data.dockerLog, 'utf8');
  assert.match(operations, /exec -T eraser-postgres/);
  assert.match(operations, /-U eraser -d eraser/);
  assert.doesNotMatch(operations, /exec -T postgres(?: |$)/);
  const dumps = readdirSync(join(data.backup, 'eraser')).filter((x) => x.endsWith('.dump'));
  assert.equal(dumps.length, 1);
  assert.match(dumps[0], /^eraser_/);
  assert.equal(
    readdirSync(data.backup).some((x) => x.endsWith('.dump')),
    false,
  );
});
test('Lastik readiness failure or unknown backup profile cannot start a dump', (t) => {
  const data = fixture();
  t.after(() => rmSync(data.directory, { recursive: true, force: true }));
  assert.equal(
    runHelper(data, [], { MAXIM_BACKUP_PROFILE: 'eraser', MOCK_ERASER_READY_STATUS: '1' }).status,
    75,
  );
  assert.equal(existsSync(data.dockerLog), false);
  assert.equal(runHelper(data, [], { MAXIM_BACKUP_PROFILE: 'other-project' }).status, 2);
  assert.equal(existsSync(data.dockerLog), false);
});

for (const profile of ['maxim', 'eraser']) {
  const unitPrefix = profile === 'eraser' ? 'maxim-eraser-postgres' : 'maxim-postgres';
  for (const scenario of ['disabled', 'healthy', 'missing-evidence']) {
    test(`${profile} timer installation keeps its own identity and evidence gate: ${scenario}`, (t) => {
      const directory = mkdtempSync(join(tmpdir(), 'eraser-backup-units-'));
      t.after(() => rmSync(directory, { recursive: true, force: true }));
      const bin = join(directory, 'bin');
      const units = join(directory, 'units');
      const log = join(directory, 'commands');
      mkdirSync(bin);
      mkdirSync(units);
      writeFileSync(
        join(bin, 'sudo'),
        `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$TEST_UNIT_LOG"
case "$1" in
  install) cp -- "$8" "$9" ;;
  test) exit 0 ;;
  systemctl)
    if [[ "$2" == start && "$3" == "$TEST_UNIT_PREFIX-backup-health.service" ]]; then
      exit "$TEST_UNIT_HEALTH"
    fi ;;
  *) exit 99 ;;
esac
`,
        { mode: 0o700 },
      );
      const result = spawnSync('bash', [installer], {
        encoding: 'utf8',
        timeout: 5000,
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          MAXIM_SYSTEMD_UNIT_DIR: units,
          MAXIM_BACKUP_PROFILE: profile,
          TEST_UNIT_PREFIX: unitPrefix,
          MAXIM_ENABLE_POSTGRES_BACKUP_TIMER: scenario === 'disabled' ? '0' : '1',
          MAXIM_ENABLE_POSTGRES_RESTORE_SMOKE_TIMER: scenario === 'disabled' ? '0' : '1',
          TEST_UNIT_LOG: log,
          TEST_UNIT_HEALTH: scenario === 'missing-evidence' ? '1' : '0',
        },
      });
      assert.equal(result.status === 0, scenario !== 'missing-evidence', result.stderr);
      const names = readdirSync(units);
      assert.equal(names.length, 8);
      assert.ok(names.every((name) => name.startsWith(unitPrefix + '-')));
      for (const name of names.filter((name) => name.endsWith('.service'))) {
        const service = readFileSync(join(units, name), 'utf8');
        assert.match(service, new RegExp('ExecStart=.*MAXIM_BACKUP_PROFILE=' + profile + ' '));
        assert.match(service, /ExecStartPre=.*postgres-backup-schedule.mjs capability/);
        const precheck = service.match(/^ExecStartPre=\/usr\/bin\/test -f (.+)$/m)?.[1];
        if (profile === 'eraser') {
          assert.equal(precheck, join(root, 'infra/scripts/lib/postgres-backup-profile.sh'));
          // A checkout rollback removes this newly introduced tracked capability file. Systemd
          // must fail, not skip the unit successfully or execute the old main-database script.
          assert.equal(spawnSync('/usr/bin/test', ['-f', precheck]).status, 0);
          assert.notEqual(
            spawnSync('/usr/bin/test', [
              '-f',
              join(directory, 'old-checkout', 'infra/scripts/lib/postgres-backup-profile.sh'),
            ]).status,
            0,
          );
          assert.doesNotMatch(service, /^ConditionPathExists=.*postgres-backup-profile/m);
        } else assert.equal(precheck, undefined);
      }
      const commands = readFileSync(log, 'utf8');
      if (profile === 'eraser')
        assert.doesNotMatch(commands, /systemctl (?:start|enable).* maxim-postgres-/);
      const backup = readFileSync(join(units, unitPrefix + '-backup.service'), 'utf8');
      const retry = readFileSync(join(units, unitPrefix + '-backup-retry.service'), 'utf8');
      assert.match(backup, /postgres-backup-schedule.sh request/);
      assert.match(retry, /postgres-backup-schedule.sh tick/);
      if (scenario === 'healthy')
        assert.match(commands, new RegExp(unitPrefix + '-backup-retry.timer'));
      assert.equal(commands.includes('systemctl enable --now'), scenario === 'healthy');
    });
  }
}

function scheduledContext(data, archive = null) {
  const stateDirectory = join(data.backup, '.scheduler-v1');
  mkdirSync(stateDirectory, { mode: 0o700 });
  const operationId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  const attemptId = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
  const destination = 'test:bucket/postgres';
  writeFileSync(
    join(stateDirectory, 'state.json'),
    JSON.stringify({
      schemaVersion: 1,
      profile: 'maxim',
      operationId,
      attemptId,
      sourceSha: 'a'.repeat(40),
      phase: archive ? 'needs_review' : 'producing',
      requestedAt: 0,
      deadlineAt: 43_200_000,
      nextAttemptAt: 0,
      attempts: 1,
      replicationAttempts: 0,
      destination,
      destinationHash: createHash('sha256').update(destination).digest('hex'),
      archive,
    }),
    { mode: 0o600 },
  );
  return {
    MAXIM_BACKUP_OPERATION_ID: operationId,
    MAXIM_BACKUP_ATTEMPT_ID: attemptId,
    MAXIM_BACKUP_RESULT_FILE: join(stateDirectory, 'producer-result.json'),
  };
}

test('producer reports a proved pre-start refusal bound to operation and attempt', (t) => {
  const data = fixture();
  t.after(() => rmSync(data.directory, { recursive: true, force: true }));
  const context = scheduledContext(data);
  const result = runHelper(data, [], { ...context, MOCK_READY_FAIL: '1' });
  assert.equal(result.status, 75, result.stderr);
  const receipt = JSON.parse(readFileSync(context.MAXIM_BACKUP_RESULT_FILE));
  assert.equal(receipt.phase, 'deferred');
  assert.equal(receipt.reason, 'readiness_not_ready');
  assert.equal(receipt.operationId, context.MAXIM_BACKUP_OPERATION_ID);
  assert.equal(receipt.attemptId, context.MAXIM_BACKUP_ATTEMPT_ID);
  assert.equal(existsSync(data.dockerLog), false);
});

test('backup lock utility failure is unknown and cannot authorize a fresh dump retry', (t) => {
  const data = fixture();
  t.after(() => rmSync(data.directory, { recursive: true, force: true }));
  const context = scheduledContext(data);
  writeFileSync(join(data.bin, 'flock'), '#!/bin/sh\nexit 70\n', { mode: 0o700 });
  const result = runHelper(data, [], context);
  assert.equal(result.status, 75, result.stderr);
  assert.equal(JSON.parse(readFileSync(context.MAXIM_BACKUP_RESULT_FILE)).phase, 'admission');
  assert.equal(existsSync(data.dockerLog), false);
});

test('producer refuses source revision drift after admission before sizing or dump', (t) => {
  const data = fixture();
  t.after(() => rmSync(data.directory, { recursive: true, force: true }));
  const context = scheduledContext(data);
  const result = runHelper(data, [], { ...context, MAXIM_BACKUP_SOURCE_SHA: 'b'.repeat(40) });
  assert.equal(result.status, 1, result.stderr);
  assert.equal(JSON.parse(readFileSync(context.MAXIM_BACKUP_RESULT_FILE)).phase, 'admission');
  assert.equal(existsSync(data.dockerLog), false);
  assert.equal(spawnSync('flock', ['-n', data.deployLock, 'true']).status, 0);
});

test('producer publishes exact complete archive evidence before releasing admission', (t) => {
  const data = fixture();
  t.after(() => rmSync(data.directory, { recursive: true, force: true }));
  const context = scheduledContext(data);
  const result = runHelper(data, [], context);
  assert.equal(result.status, 0, result.stderr);
  const receipt = JSON.parse(readFileSync(context.MAXIM_BACKUP_RESULT_FILE));
  assert.equal(receipt.phase, 'local_complete');
  const archive = readFileSync(join(data.backup, receipt.archiveName));
  assert.equal(receipt.sha256, createHash('sha256').update(archive).digest('hex'));
  assert.equal(receipt.bytes, archive.length);
  assert.equal(receipt.attemptId, context.MAXIM_BACKUP_ATTEMPT_ID);
});

test('manual retention preserves an older pending archive and checksum beside the newest generation', (t) => {
  const data = fixture();
  t.after(() => rmSync(data.directory, { recursive: true, force: true }));
  const names = [
    'maxim_20200101T000000Z.dump',
    'maxim_20200102T000000Z.dump',
    'maxim_20200103T000000Z.dump',
  ];
  for (const name of names) {
    for (const suffix of ['', '.sha256']) {
      const path = join(data.backup, name + suffix);
      writeFileSync(path, 'old');
      utimesSync(path, new Date('2020-01-01'), new Date('2020-01-01'));
    }
  }
  scheduledContext(data, { name: names[0], sha256: 'a'.repeat(64), bytes: 3 });
  const result = runHelper(data, [], { MOCK_DUMP_FAIL: '1' });
  assert.notEqual(result.status, 0);
  for (const suffix of ['', '.sha256']) {
    assert.equal(existsSync(join(data.backup, names[0] + suffix)), true);
    assert.equal(existsSync(join(data.backup, names[1] + suffix)), false);
    assert.equal(existsSync(join(data.backup, names[2] + suffix)), true);
  }
});
