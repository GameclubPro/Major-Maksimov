import * as fs from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, parse, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const attestationAuthFailureMessage =
  'Private attestation authentication could not be prepared or restored.';
const maximumBytes = 65_536;
const stateName = '.maxim-attestation-auth';
const temporaryName = '.maxim-attestation-config.tmp';
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const requireFact = (fact) => {
  if (!fact) throw new Error(attestationAuthFailureMessage);
};

function optionalStat(fileSystem, path) {
  try {
    return fileSystem.lstatSync(path);
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  }
}

function directories(fileSystem, path, uid, { privateLeaf = false, missingLeaf = false } = {}) {
  const root = parse(path).root;
  const parts = path.slice(root.length).split('/').filter(Boolean);
  let current = root;
  for (const [index, part] of ['', ...parts].entries()) {
    if (part) current = join(current, part);
    const leaf = index === parts.length;
    const stat = optionalStat(fileSystem, current);
    if (!stat && leaf && missingLeaf) return undefined;
    requireFact(stat?.isDirectory() && !stat.isSymbolicLink());
    requireFact([0, uid].includes(stat.uid));
    // FLAG: A root-owned sticky ancestor such as /tmp is allowed; the private
    // leaf and the runner's home/config directories must never be shared-writable.
    requireFact(
      (stat.mode & 0o022) === 0 || (!leaf && stat.uid === 0 && (stat.mode & 0o1000) !== 0),
    );
    if (leaf) {
      requireFact(stat.uid === uid);
      if (privateLeaf) requireFact((stat.mode & 0o777) === 0o700);
      return stat;
    }
  }
}

function readBounded(fileSystem, path, uid, { privateFile = false } = {}) {
  const before = fileSystem.lstatSync(path);
  const safe = (stat) =>
    stat.isFile() &&
    !stat.isSymbolicLink() &&
    stat.nlink === 1 &&
    stat.uid === uid &&
    (stat.mode & 0o7022) === 0 &&
    stat.size <= maximumBytes &&
    (!privateFile || (stat.mode & 0o777) === 0o600);
  requireFact(safe(before));
  let descriptor;
  try {
    descriptor = fileSystem.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const opened = fileSystem.fstatSync(descriptor);
    requireFact(safe(opened) && before.dev === opened.dev && before.ino === opened.ino);
    const bytes = Buffer.alloc(opened.size + 1);
    let length = 0;
    while (length < bytes.length) {
      const count = fileSystem.readSync(descriptor, bytes, length, bytes.length - length, null);
      if (count === 0) break;
      length += count;
    }
    const after = fileSystem.fstatSync(descriptor);
    requireFact(
      length === opened.size &&
        after.size === opened.size &&
        after.mtimeMs === opened.mtimeMs &&
        after.ctimeMs === opened.ctimeMs &&
        safe(after),
    );
    return { bytes: bytes.subarray(0, length), mode: opened.mode & 0o777 };
  } finally {
    if (descriptor !== undefined) fileSystem.closeSync(descriptor);
  }
}

function writePrivate(fileSystem, path, bytes, mode = 0o600) {
  let descriptor;
  try {
    descriptor = fileSystem.openSync(
      path,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
      0o600,
    );
    let written = 0;
    while (written < bytes.length) {
      const count = fileSystem.writeSync(descriptor, bytes, written, bytes.length - written);
      requireFact(count > 0);
      written += count;
    }
    fileSystem.fchmodSync(descriptor, mode);
    fileSystem.fsyncSync(descriptor);
  } finally {
    if (descriptor !== undefined) fileSystem.closeSync(descriptor);
  }
}

function syncDirectory(fileSystem, path) {
  const descriptor = fileSystem.openSync(
    path,
    fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW,
  );
  try {
    fileSystem.fsyncSync(descriptor);
  } finally {
    fileSystem.closeSync(descriptor);
  }
}

function requireUnchangedTarget({ fileSystem, target, uid }, expected) {
  const current = optionalStat(fileSystem, target)
    ? readBounded(fileSystem, target, uid)
    : undefined;
  requireFact(
    Boolean(current) === Boolean(expected) &&
      (!current || (current.mode === expected.mode && current.bytes.equals(expected.bytes))),
  );
}

function context({ env = process.env, homeDirectory = homedir(), fileSystem = fs } = {}) {
  requireFact(
    process.platform === 'linux' &&
      env.GITHUB_ACTIONS === 'true' &&
      env.RUNNER_ENVIRONMENT === 'github-hosted',
  );
  const source = env.DOCKER_CONFIG;
  requireFact(
    typeof source === 'string' &&
      isAbsolute(source) &&
      resolve(source) === source &&
      dirname(source) !== source,
  );
  requireFact(
    typeof homeDirectory === 'string' &&
      isAbsolute(homeDirectory) &&
      resolve(homeDirectory) === homeDirectory,
  );
  const directory = join(homeDirectory, '.docker');
  requireFact(
    source !== directory &&
      !source.startsWith(`${directory}/`) &&
      !directory.startsWith(`${source}/`),
  );
  return {
    fileSystem,
    uid: process.getuid(),
    source,
    homeDirectory,
    directory,
    target: join(directory, 'config.json'),
    state: join(source, stateName),
    temporary: join(directory, temporaryName),
  };
}

function journalRecord(fileSystem, path, uid, expected) {
  const value = JSON.parse(readBounded(fileSystem, path, uid, { privateFile: true }).bytes);
  requireFact(
    value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      Object.keys(value).sort().join(',') ===
        'bridgeDigest,directoryCreated,homeDirectory,originalDigest,originalExists,originalMode,schemaVersion',
  );
  requireFact(
    value.schemaVersion === 1 &&
      value.homeDirectory === expected.homeDirectory &&
      typeof value.directoryCreated === 'boolean' &&
      typeof value.originalExists === 'boolean' &&
      /^[a-f0-9]{64}$/u.test(value.bridgeDigest),
  );
  requireFact(
    value.originalExists
      ? /^[a-f0-9]{64}$/u.test(value.originalDigest) &&
          Number.isInteger(value.originalMode) &&
          value.originalMode >= 0 &&
          value.originalMode <= 0o777 &&
          (value.originalMode & 0o022) === 0
      : value.originalDigest === null && value.originalMode === null,
  );
  return value;
}

// FLAG: Pinned actions/attest reads homedir/.docker/config.json, ignoring the
// job's DOCKER_CONFIG. Only its inline ghcr.io credential crosses that boundary;
// the durable private journal precedes every change to the standard location.
export function prepareRegistryAttestationAuth(options = {}) {
  try {
    const data = context(options);
    const { fileSystem, uid, source, homeDirectory, directory, target, state, temporary } = data;
    directories(fileSystem, source, uid, { privateLeaf: true });
    directories(fileSystem, homeDirectory, uid);
    requireFact(!optionalStat(fileSystem, state));
    const sourceConfig = JSON.parse(
      readBounded(fileSystem, join(source, 'config.json'), uid, { privateFile: true }).bytes,
    );
    const auth = sourceConfig?.auths?.['ghcr.io']?.auth;
    requireFact(
      typeof auth === 'string' && auth.length <= 16_384 && /^[A-Za-z0-9+/]+={0,2}$/u.test(auth),
    );
    const decoded = Buffer.from(auth, 'base64');
    requireFact(
      decoded.toString('base64') === auth &&
        decoded.every((byte) => byte >= 0x21 && byte <= 0x7e) &&
        /^[^:\s]+:.+$/u.test(decoded.toString('utf8')),
    );
    const replacement = Buffer.from(`${JSON.stringify({ auths: { 'ghcr.io': { auth } } })}\n`);
    const existingDirectory = directories(fileSystem, directory, uid, { missingLeaf: true });
    requireFact(!optionalStat(fileSystem, temporary));
    const original = optionalStat(fileSystem, target)
      ? readBounded(fileSystem, target, uid)
      : undefined;
    const journal = {
      schemaVersion: 1,
      homeDirectory,
      directoryCreated: !existingDirectory,
      originalExists: Boolean(original),
      originalDigest: original ? digest(original.bytes) : null,
      originalMode: original?.mode ?? null,
      bridgeDigest: digest(replacement),
    };
    fileSystem.mkdirSync(state, { mode: 0o700 });
    if (original) writePrivate(fileSystem, join(state, 'original.json'), original.bytes);
    writePrivate(fileSystem, join(state, 'journal.tmp'), Buffer.from(JSON.stringify(journal)));
    fileSystem.renameSync(join(state, 'journal.tmp'), join(state, 'state.json'));
    syncDirectory(fileSystem, state);
    syncDirectory(fileSystem, source);
    if (!existingDirectory) fileSystem.mkdirSync(directory, { mode: 0o700 });
    directories(fileSystem, directory, uid);
    writePrivate(fileSystem, temporary, replacement);
    requireUnchangedTarget(data, original);
    fileSystem.renameSync(temporary, target);
    syncDirectory(fileSystem, directory);
    return { status: 'prepared' };
  } catch {
    throw new Error(attestationAuthFailureMessage);
  }
}

function discardState(data) {
  const { fileSystem, uid, state, source } = data;
  for (const name of fileSystem.readdirSync(state)) {
    requireFact(['original.json', 'state.json', 'journal.tmp'].includes(name));
    readBounded(fileSystem, join(state, name), uid, { privateFile: true });
  }
  for (const name of ['state.json', 'original.json', 'journal.tmp']) {
    if (optionalStat(fileSystem, join(state, name))) fileSystem.unlinkSync(join(state, name));
  }
  fileSystem.rmdirSync(state);
  syncDirectory(fileSystem, source);
}

// FLAG: Cleanup runs even after failed prepare. It only replaces a recognized
// bridge/original file, preserves the old bytes/mode and never removes .docker.
// Retain DOCKER_CONFIG if restoration fails: it contains the recovery journal.
export function cleanupRegistryAttestationAuth(options = {}) {
  try {
    const data = context(options);
    const { fileSystem, uid, source, homeDirectory, directory, target, state, temporary } = data;
    if (!directories(fileSystem, source, uid, { privateLeaf: true, missingLeaf: true }))
      return { status: 'clean' };
    if (!optionalStat(fileSystem, state)) return { status: 'clean' };
    directories(fileSystem, state, uid, { privateLeaf: true });
    if (!optionalStat(fileSystem, join(state, 'state.json'))) {
      // No journal means prepare never reached a home mutation.
      discardState(data);
      return { status: 'clean' };
    }
    const journal = journalRecord(fileSystem, join(state, 'state.json'), uid, data);
    const original = journal.originalExists
      ? readBounded(fileSystem, join(state, 'original.json'), uid, { privateFile: true }).bytes
      : undefined;
    requireFact(!original || digest(original) === journal.originalDigest);
    directories(fileSystem, homeDirectory, uid);
    const targetDirectory = directories(fileSystem, directory, uid, { missingLeaf: true });
    requireFact(targetDirectory || (journal.directoryCreated && !journal.originalExists));
    if (targetDirectory) {
      if (optionalStat(fileSystem, temporary)) {
        readBounded(fileSystem, temporary, uid);
        fileSystem.unlinkSync(temporary);
      }
      const current = optionalStat(fileSystem, target)
        ? readBounded(fileSystem, target, uid)
        : undefined;
      const isOriginal =
        current &&
        journal.originalExists &&
        digest(current.bytes) === journal.originalDigest &&
        current.mode === journal.originalMode;
      const isBridge =
        current && digest(current.bytes) === journal.bridgeDigest && current.mode === 0o600;
      requireFact((!current && !journal.originalExists) || isOriginal || isBridge);
      if (original && !isOriginal) {
        writePrivate(fileSystem, temporary, original, journal.originalMode);
        requireUnchangedTarget(data, current);
        fileSystem.renameSync(temporary, target);
      } else if (!original && isBridge) {
        requireUnchangedTarget(data, current);
        fileSystem.unlinkSync(target);
      }
      syncDirectory(fileSystem, directory);
    }
    discardState(data);
    return { status: 'clean' };
  } catch {
    throw new Error(attestationAuthFailureMessage);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    requireFact(process.argv.length === 3);
    const command = process.argv[2];
    requireFact(command === 'prepare' || command === 'cleanup');
    if (command === 'prepare') prepareRegistryAttestationAuth();
    else cleanupRegistryAttestationAuth();
  } catch {
    process.stderr.write(`${attestationAuthFailureMessage}\n`);
    process.exitCode = 1;
  }
}
