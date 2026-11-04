#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  cleanEnvironment,
  HASH,
  RELEASE_PATHS,
  sha256,
  stableJson,
} from './release-service-boundary.mjs';

const MAX_POLICY_BYTES = 4096;
const KEYS = ['schemaVersion', 'revision', 'paused', 'autoEnabled', 'reason', 'updatedAt'];
const failedDirectories = new Set();

function fail(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}
function settings({ directory = RELEASE_PATHS.state, now = Date.now, fileSystem = fs } = {}) {
  if (typeof directory !== 'string' || !directory || typeof now !== 'function')
    fail('INVALID_POLICY_OPTIONS');
  const absolute = resolve(directory);
  return {
    directory: absolute,
    floor: absolute === RELEASE_PATHS.state ? '/' : absolute,
    now,
    io: fileSystem,
  };
}
function clock(options) {
  const value = options.now();
  const milliseconds = value instanceof Date ? value.getTime() : value;
  if (!Number.isFinite(milliseconds)) fail('INVALID_POLICY_CLOCK');
  return milliseconds;
}
function assertDirectory(options) {
  if (failedDirectories.has(options.directory)) fail('POLICY_RESTART_REQUIRED');
  let current = options.directory;
  while (true) {
    const stat = options.io.lstatSync(current);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      stat.mode & 0o022 ||
      ![0, process.getuid()].includes(stat.uid)
    )
      fail('UNSAFE_POLICY_DIRECTORY');
    if (current === options.floor) return;
    current = dirname(current);
  }
}
function privateStat(stat, { empty = false } = {}) {
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.nlink !== 1 ||
    (stat.mode & 0o777) !== 0o600 ||
    ![0, process.getuid()].includes(stat.uid) ||
    (!empty && stat.size < 1) ||
    stat.size > MAX_POLICY_BYTES
  )
    fail('UNSAFE_POLICY_FILE');
}
function validate(value, options) {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(',') !== [...KEYS].sort().join(',') ||
    value.schemaVersion !== 1 ||
    !Number.isSafeInteger(value.revision) ||
    value.revision < 1 ||
    typeof value.paused !== 'boolean' ||
    value.autoEnabled !== false ||
    !['INITIALIZED', 'ROLLBACK', 'OPERATOR_RESUME'].includes(value.reason) ||
    value.paused !== (value.reason !== 'OPERATOR_RESUME') ||
    typeof value.updatedAt !== 'string' ||
    !Number.isFinite(Date.parse(value.updatedAt)) ||
    new Date(value.updatedAt).toISOString() !== value.updatedAt ||
    Date.parse(value.updatedAt) > clock(options)
  )
    fail('INVALID_POLICY');
  return value;
}
function projection(value) {
  return { ...value, policySha256: sha256(stableJson(value)) };
}
function read(options) {
  assertDirectory(options);
  const path = join(options.directory, 'policy.json');
  let before;
  try {
    before = options.io.lstatSync(path);
  } catch (error) {
    if (error.code === 'ENOENT') fail('POLICY_MISSING');
    throw error;
  }
  privateStat(before);
  const fd = options.io.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const opened = options.io.fstatSync(fd);
    privateStat(opened);
    if (opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size)
      fail('POLICY_CHANGED');
    const bytes = Buffer.alloc(opened.size + 1);
    let used = 0;
    while (used < bytes.length) {
      const count = options.io.readSync(fd, bytes, used, bytes.length - used, null);
      if (count === 0) break;
      used += count;
    }
    if (used !== opened.size) fail('POLICY_CHANGED');
    let value;
    try {
      value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, used)));
    } catch {
      fail('INVALID_POLICY');
    }
    return projection(validate(value, options));
  } finally {
    options.io.closeSync(fd);
  }
}

export function readPolicy(options = {}) {
  return read(settings(options));
}

export function withPolicyMutationLock(options, callback) {
  const selected = settings(options);
  assertDirectory(selected);
  const path = join(selected.directory, 'policy.lock');
  let existing;
  try {
    existing = selected.io.lstatSync(path);
    privateStat(existing, { empty: true });
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const fd = selected.io.openSync(
    path,
    fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
    0o600,
  );
  try {
    const opened = selected.io.fstatSync(fd);
    privateStat(opened, { empty: true });
    if (existing && (existing.dev !== opened.dev || existing.ino !== opened.ino))
      fail('POLICY_LOCK_CHANGED');
    const before = selected.io.lstatSync(path);
    privateStat(before, { empty: true });
    if (opened.dev !== before.dev || opened.ino !== before.ino) fail('POLICY_LOCK_CHANGED');
    // FLAG: flock locks the inherited open-file description. The parent keeps its FD open
    // throughout read/compare/write/fsync; process death releases the kernel lock without unlinking it.
    const result = spawnSync('/usr/bin/flock', ['--exclusive', '--nonblock', '3'], {
      env: cleanEnvironment(),
      stdio: ['ignore', 'ignore', 'ignore', fd],
      timeout: 5000,
    });
    if (result.status !== 0)
      fail(result.status === 1 ? 'POLICY_LOCK_BUSY' : 'POLICY_LOCK_UNAVAILABLE');
    const locked = selected.io.lstatSync(path);
    privateStat(locked, { empty: true });
    if (locked.dev !== opened.dev || locked.ino !== opened.ino) fail('POLICY_LOCK_CHANGED');
    return callback(selected);
  } finally {
    selected.io.closeSync(fd);
  }
}

function write(options, value, { exclusive = false } = {}) {
  validate(value, options);
  assertDirectory(options);
  const path = join(options.directory, 'policy.json');
  const temporary = join(options.directory, `.policy-${randomUUID()}.tmp`);
  const dir = options.io.openSync(
    options.directory,
    fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW,
  );
  let fd;
  try {
    fd = options.io.openSync(
      temporary,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
      0o600,
    );
    options.io.writeFileSync(fd, `${stableJson(value)}\n`);
    options.io.fsyncSync(fd);
    options.io.closeSync(fd);
    fd = undefined;
    if (exclusive) {
      options.io.linkSync(temporary, path);
      options.io.unlinkSync(temporary);
    } else {
      privateStat(options.io.lstatSync(path));
      options.io.renameSync(temporary, path);
    }
    // FLAG: Success requires both durable file content and the final directory entry.
    options.io.fsyncSync(dir);
  } catch (error) {
    failedDirectories.add(options.directory);
    throw error;
  } finally {
    if (fd !== undefined) options.io.closeSync(fd);
    options.io.closeSync(dir);
    options.io.rmSync(temporary, { force: true });
  }
  return projection(value);
}

export function initializePolicy(options = {}) {
  return withPolicyMutationLock(options, (selected) => {
    try {
      return read(selected);
    } catch (error) {
      if (error.code !== 'POLICY_MISSING') throw error;
    }
    return write(
      selected,
      {
        schemaVersion: 1,
        revision: 1,
        paused: true,
        autoEnabled: false,
        reason: 'INITIALIZED',
        updatedAt: new Date(clock(selected)).toISOString(),
      },
      { exclusive: true },
    );
  });
}

function update(options, mutate) {
  return withPolicyMutationLock(options, (selected) => {
    const current = read(selected);
    const next = mutate(current);
    if (next === current) return current;
    if (current.revision === Number.MAX_SAFE_INTEGER) fail('POLICY_REVISION_EXHAUSTED');
    const now = clock(selected);
    if (now < Date.parse(current.updatedAt)) fail('POLICY_CLOCK_MOVED_BACKWARDS');
    const previous = Object.fromEntries(KEYS.map((key) => [key, current[key]]));
    return write(selected, {
      ...previous,
      ...next,
      revision: current.revision + 1,
      updatedAt: new Date(now).toISOString(),
    });
  });
}

export function pausePolicy({ reason, ...options } = {}) {
  if (reason !== 'ROLLBACK') fail('INVALID_POLICY_REASON');
  return update(options, (current) =>
    current.paused && current.reason === reason ? current : { paused: true, reason },
  );
}

export function resumePolicy({ expectedPolicySha256, ...options } = {}) {
  if (
    typeof expectedPolicySha256 !== 'string' ||
    expectedPolicySha256.length !== 64 ||
    !HASH.test(expectedPolicySha256)
  )
    fail('INVALID_POLICY_HASH');
  return update(options, (current) => {
    if (current.policySha256 !== expectedPolicySha256) fail('STALE_POLICY');
    return current.paused ? { paused: false, reason: 'OPERATOR_RESUME' } : current;
  });
}

function delegatedRollbackPause({ runner, node, lstat }) {
  if (!['/usr/bin/node', '/usr/local/bin/node'].includes(node))
    fail('POLICY_DELEGATION_UNAVAILABLE');
  try {
    const stat = lstat(node);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== 0 || stat.mode & 0o022)
      fail('POLICY_DELEGATION_UNPROVED');
    // FLAG: Root maintenance must pause as the fixed installed deploy user. Never
    // relax state ownership or replace its private policy/lock with root-owned files.
    const result = runner(
      '/usr/sbin/runuser',
      [
        '--user',
        'maximadmin',
        '--',
        '/usr/bin/env',
        '-i',
        'PATH=/usr/local/bin:/usr/bin:/bin',
        'HOME=/var/lib/maxim-release',
        'LANG=C.UTF-8',
        node,
        '/usr/local/lib/maxim-release/infra/scripts/release-service-policy.mjs',
        'pause-rollback',
      ],
      {
        env: cleanEnvironment(),
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 10_000,
        maxBuffer: MAX_POLICY_BYTES,
      },
    );
    if (
      result.error ||
      result.status !== 0 ||
      result.signal !== null ||
      !Buffer.isBuffer(result.stdout) ||
      result.stdout.length > MAX_POLICY_BYTES
    )
      fail('POLICY_DELEGATION_UNPROVED');
    const { policySha256, ...value } = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(result.stdout),
    );
    validate(value, settings());
    const proved = projection(value);
    if (value.reason !== 'ROLLBACK' || policySha256 !== proved.policySha256)
      fail('POLICY_DELEGATION_UNPROVED');
    return proved;
  } catch {
    // FLAG: NSS/PAM, child stderr and process errors are private diagnostics, never CLI output.
    fail('POLICY_DELEGATION_UNPROVED');
  }
}

export function runPolicyCommand(
  args,
  { uid = process.getuid(), runner = spawnSync, node = process.execPath, lstat = fs.lstatSync } = {},
) {
  if (
    !Array.isArray(args) ||
    args.length !== 1 ||
    !['read', 'initialize', 'pause-rollback'].includes(args[0]) ||
    !Number.isSafeInteger(uid) ||
    uid < 0
  )
    fail('INVALID_POLICY_COMMAND');
  if (args[0] === 'pause-rollback')
    return uid === 0
      ? delegatedRollbackPause({ runner, node, lstat })
      : pausePolicy({ reason: 'ROLLBACK' });
  return args[0] === 'initialize' ? initializePolicy() : readPolicy();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = runPolicyCommand(process.argv.slice(2));
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    const code = /^[A-Z][A-Z0-9_]{0,63}$/u.test(error.code ?? '')
      ? error.code
      : 'POLICY_UNAVAILABLE';
    process.stderr.write(`Release policy refused: ${code}.\n`);
    process.exitCode = 1;
  }
}
