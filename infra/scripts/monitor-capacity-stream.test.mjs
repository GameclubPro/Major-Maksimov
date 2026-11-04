import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';

const root = resolve(import.meta.dirname, '../..');
const archivePath = join(root, 'infra/scripts/monitor-capacity-archive.cjs');
const monitorSource = readFileSync(join(root, 'infra/scripts/vps-monitor-readonly.sh'), 'utf8');

function shellFunction(name) {
  const match = new RegExp(`^${name}\\(\\) \\{[\\s\\S]*?^\\}`, 'mu').exec(monitorSource);
  assert.ok(match, `missing shell function ${name}`);
  return match[0];
}

// A real request/reply process replaces only SSH. The shell descriptors, polling,
// process ownership, cleanup and archive CLI remain the production implementation.
const remoteFixture = String.raw`#!/usr/bin/env node
const { appendFileSync, readFileSync } = require('node:fs');
const { createInterface } = require('node:readline');
const record = (value) => appendFileSync(process.env.CAPACITY_TEST_EVENTS, JSON.stringify(value) + '\n');
const fields = readFileSync('/proc/self/stat', 'utf8').split(') ').at(-1).split(' ');
record({ kind: 'start', pid: process.pid, pgid: Number(fields[2]), startTicks: fields[19], args: process.argv.slice(2) });
process.on('exit', (code) => record({ kind: 'exit', pid: process.pid, code }));
process.on('SIGTERM', () => process.exit(143));
let sequence = 0;
const input = createInterface({ input: process.stdin });
input.on('line', (line) => {
  record({ kind: 'request', pid: process.pid, line });
  if (line !== 'SNAPSHOT') process.exit(91);
  const snapshot = JSON.stringify({
    schemaVersion: 1,
    observedAt: new Date().toISOString(),
    host: { cpuCount: 24, load1: ++sequence },
    privateToken: 'fixture-private-value',
  });
  switch (process.env.CAPACITY_TEST_MODE) {
    case 'exit7': process.exit(7); break;
    case 'eof': process.exit(0); break;
    case 'partial': process.stdout.write(snapshot.slice(0, -1)); process.exit(7); break;
    case 'oversized': process.stdout.write('x'.repeat(65_538) + '\n'); break;
    case 'malformed': process.stdout.write('{broken\n'); break;
    case 'extra': process.stdout.write(snapshot + '\n' + snapshot + '\n'); break;
    case 'waiting': break;
    default: process.stdout.write(snapshot + '\n');
  }
});
if (process.env.CAPACITY_TEST_MODE === 'stubborn') setInterval(() => {}, 1_000);
input.on('close', () => {
  if (process.env.CAPACITY_TEST_MODE !== 'stubborn') process.exit(0);
});
`;

const functions = [
  'is_positive_integer',
  'capacity_owner_valid',
  'capacity_stream_running',
  'start_capacity_stream',
  'stop_capacity_stream',
  'read_capacity_stream_snapshot',
  'summarize_capacity_observability',
].map(shellFunction);

function harness(body) {
  return [
    'set -euo pipefail',
    'umask 077',
    'ROOT_DIR="$1"',
    'CAPACITY_ARCHIVER="$2"',
    'CAPACITY_ARCHIVE_DIR="$ROOT_DIR/archive"',
    'CAPACITY_BLOCK_DEVICE=md1',
    'SERVICES=(api-ingress api-action)',
    'CAPACITY_STREAM_PID=""',
    'CAPACITY_STREAM_READ_FD=""',
    'CAPACITY_STREAM_WRITE_FD=""',
    'CAPACITY_STREAM_STARTED_AT=0',
    'CAPACITY_STREAM_SNAPSHOT=""',
    'CAPACITY_STREAM_OWNER_PID="${CAPACITY_TEST_OWNER_PID:-$BASHPID}"',
    'CAPACITY_STREAM_LOCK_FD=""',
    ...functions,
    shellFunction('read_capacity_owner_start_ticks').replace(
      'read_capacity_owner_start_ticks()',
      'read_real_capacity_owner_start_ticks()',
    ),
    'read_capacity_owner_start_ticks() {',
    '  if [[ -e "$ROOT_DIR/generation-changed" ]]; then printf "1\\n";',
    '  else read_real_capacity_owner_start_ticks "$@"; fi',
    '}',
    'CAPACITY_STREAM_OWNER_START_TICKS="$(read_capacity_owner_start_ticks "$CAPACITY_STREAM_OWNER_PID")"',
    'exec {CAPACITY_STREAM_LOCK_FD}>>"$ROOT_DIR/capacity.lock"',
    'flock -n "$CAPACITY_STREAM_LOCK_FD"',
    "trap 'stop_capacity_stream || true' EXIT",
    "trap 'exit 143' TERM",
    "trap '' PIPE",
    body,
  ].join('\n');
}

function processIdentity(pid) {
  try {
    process.kill(pid, 0);
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    if (['Z', 'X', 'x'].includes(fields[0])) return null;
    return { pgid: Number(fields[2]), startTicks: fields[19] };
  } catch {
    return null;
  }
}

function processAlive(pid) {
  return processIdentity(pid) !== null;
}

async function waitUntil(predicate, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, 'fixture did not reach its expected lifecycle state');
    await delay(10);
  }
}

function fixture(t, mode = 'normal') {
  const directory = mkdtempSync(join(tmpdir(), 'maxim-capacity-stream-'));
  const scripts = join(directory, 'infra/scripts');
  const eventsPath = join(directory, 'events.jsonl');
  mkdirSync(scripts, { recursive: true });
  writeFileSync(join(directory, 'mock-remote.cjs'), remoteFixture, { mode: 0o700 });
  writeFileSync(
    join(scripts, 'vps-connect.sh'),
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'printf \'{"kind":"wrapper","pid":%s}\\n\' "$BASHPID" >>"$CAPACITY_TEST_EVENTS"',
      'status=0',
      'node "$CAPACITY_TEST_REMOTE" "$@" || status=$?',
      'exit "$status"',
    ].join('\n'),
    { mode: 0o700 },
  );
  const children = [];
  const events = () =>
    existsSync(eventsPath)
      ? readFileSync(eventsPath, 'utf8')
          .trim()
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line))
      : [];
  t.after(() => {
    const groups = new Set();
    for (const event of events().filter((event) => event.kind === 'start')) {
      const current = processIdentity(event.pid);
      if (current?.startTicks === event.startTicks && current.pgid === event.pgid) {
        groups.add(event.pgid);
      }
    }
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) groups.add(child.pid);
    }
    for (const group of groups) {
      try {
        process.kill(-group, 'SIGKILL');
      } catch {
        // The expected path already reaped this fixture's isolated process group.
      }
    }
    rmSync(directory, { recursive: true, force: true });
  });
  return {
    directory,
    events,
    archiveRows() {
      const archiveDirectory = join(directory, 'archive');
      if (!existsSync(archiveDirectory)) return [];
      return readdirSync(archiveDirectory)
        .filter((name) => /^capacity-\d{8}T\d{2}\.jsonl$/u.test(name))
        .sort()
        .flatMap((name) =>
          readFileSync(join(archiveDirectory, name), 'utf8')
            .trim()
            .split('\n')
            .filter(Boolean)
            .map((line) => JSON.parse(line)),
        );
    },
    start(body, extraEnv = {}) {
      const child = spawn(
        'bash',
        ['-c', harness(body), 'capacity-stream-fixture', directory, archivePath],
        {
          cwd: directory,
          detached: true,
          env: {
            ...process.env,
            CAPACITY_TEST_EVENTS: eventsPath,
            CAPACITY_TEST_MODE: mode,
            CAPACITY_TEST_REMOTE: join(directory, 'mock-remote.cjs'),
            ...extraEnv,
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      children.push(child);
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk) => {
        stdout += chunk;
      });
      child.stderr.on('data', (chunk) => {
        stderr += chunk;
      });
      const closed = once(child, 'close').then(([code, signal]) => ({
        code,
        signal,
        stdout,
        stderr,
      }));
      return { child, closed };
    },
  };
}

async function finish(run, timeoutMs = 10_000) {
  let timer;
  try {
    return await Promise.race([
      run.closed,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('capacity stream fixture exceeded its deadline')),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

test('two complete snapshots share one SSH process and archive only normalized replies', async (t) => {
  const f = fixture(t);
  const result = await finish(
    f.start(
      'summarize_capacity_observability\nsummarize_capacity_observability\nstop_capacity_stream',
    ),
  );
  assert.equal(result.code, 0, result.stderr);
  const starts = f.events().filter((event) => event.kind === 'start');
  assert.equal(starts.length, 1);
  assert.deepEqual(starts[0].args, [
    'exec',
    'node',
    'infra/scripts/monitor-capacity-probe.cjs',
    '--stream',
    'md1',
    'api-ingress',
    'api-action',
  ]);
  assert.equal(f.events().filter((event) => event.kind === 'request').length, 2);
  assert.equal(processAlive(starts[0].pid), false);
  const rows = f.archiveRows();
  assert.equal(rows.length, 2);
  assert.deepEqual(
    rows.map((row) => row.sample.host.load1),
    [1, 2],
  );
  assert.doesNotMatch(JSON.stringify(rows), /fixture-private-value/u);
});

test('stream rotation reaps the old session before starting a fresh counter baseline', async (t) => {
  const f = fixture(t);
  const result = await finish(
    f.start(
      [
        'summarize_capacity_observability',
        'CAPACITY_STREAM_STARTED_AT=$(($(date +%s) - 3540))',
        'summarize_capacity_observability',
      ].join('\n'),
    ),
  );
  assert.equal(result.code, 0, result.stderr);
  const events = f.events();
  const starts = events.filter((event) => event.kind === 'start');
  assert.equal(starts.length, 2);
  assert.ok(
    events.findIndex((event) => event.kind === 'exit' && event.pid === starts[0].pid) <
      events.indexOf(starts[1]),
  );
  assert.deepEqual(
    f.archiveRows().map((row) => row.sample.host.load1),
    [1, 1],
  );
  assert.ok(starts.every(({ pid }) => !processAlive(pid)));
});

for (const mode of ['exit7', 'eof', 'partial', 'oversized', 'malformed', 'extra']) {
  test(`${mode} response fails without archiving a partial or unframed snapshot`, async (t) => {
    const f = fixture(t, mode);
    const result = await finish(f.start('summarize_capacity_observability'));
    assert.notEqual(result.code, 0, result.stderr);
    assert.equal(result.signal, null, result.stderr);
    if (mode === 'exit7') assert.equal(result.code, 7, result.stderr);
    assert.deepEqual(f.archiveRows(), []);
    assert.ok(
      f
        .events()
        .filter((event) => event.kind === 'start')
        .every(({ pid }) => !processAlive(pid)),
    );
  });
}

for (const loss of ['owner death', 'owner generation change']) {
  test(`a waiting snapshot stops promptly after ${loss}`, async (t) => {
    const f = fixture(t, 'waiting');
    const owner = spawn('sleep', ['30'], { stdio: 'ignore' });
    const ownerExit = once(owner, 'exit');
    t.after(() => {
      if (processAlive(owner.pid)) owner.kill('SIGKILL');
    });
    const run = f.start('summarize_capacity_observability', {
      CAPACITY_TEST_OWNER_PID: String(owner.pid),
    });
    await waitUntil(() => f.events().some((event) => event.kind === 'request'));
    const startedAt = performance.now();
    if (loss === 'owner death') {
      owner.kill('SIGTERM');
      await ownerExit;
    } else {
      writeFileSync(join(f.directory, 'generation-changed'), 'changed\n');
    }
    const result = await finish(run, 3_000);
    assert.equal(result.code, 3, result.stderr);
    assert.ok(
      performance.now() - startedAt < 2_000,
      'owner checks must remain within the one-second polling cadence',
    );
    assert.deepEqual(f.archiveRows(), []);
    assert.ok(
      f
        .events()
        .filter((event) => event.kind === 'start')
        .every(({ pid }) => !processAlive(pid)),
    );
  });
}

test('TERM during a waiting response reaps the SSH process and releases its lock', async (t) => {
  const f = fixture(t, 'waiting');
  const run = f.start('summarize_capacity_observability');
  await waitUntil(() => f.events().some((event) => event.kind === 'request'));
  run.child.kill('SIGTERM');
  const result = await finish(run, 3_000);
  assert.equal(result.code, 143, result.stderr);
  assert.deepEqual(f.archiveRows(), []);
  assert.ok(
    f
      .events()
      .filter((event) => event.kind === 'start')
      .every(({ pid }) => !processAlive(pid)),
  );
  const lock = spawnSync(
    'bash',
    ['-c', 'exec 9>>"$1"; flock -n 9', 'capacity-lock-check', join(f.directory, 'capacity.lock')],
    { encoding: 'utf8' },
  );
  assert.equal(lock.status, 0, lock.stderr);
});

test('stop terminates a wrapper and its child when the remote collector ignores stdin EOF', async (t) => {
  const f = fixture(t, 'stubborn');
  const startedAt = performance.now();
  const result = await finish(
    f.start(
      [
        'start_capacity_stream',
        'read_capacity_stream_snapshot',
        'stop_capacity_stream || true',
      ].join('\n'),
    ),
  );
  assert.equal(result.code, 0, result.stderr);
  assert.ok(
    performance.now() - startedAt < 9_000,
    'forced stream cleanup must retain its bounded wait',
  );
  const processes = f
    .events()
    .filter((event) => event.kind === 'start' || event.kind === 'wrapper');
  assert.equal(processes.length, 2);
  assert.ok(
    processes.every(({ pid }) => !processAlive(pid)),
    'stream cleanup left a wrapper child alive',
  );
  assert.deepEqual(f.archiveRows(), []);
});
