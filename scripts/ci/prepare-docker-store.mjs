import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import { dirname, isAbsolute, join, parse, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const dockerStoreFailureMessage =
  'Default hosted Docker image store preparation or verification failed.';
const maximumBytes = 65_536;
const infoFormat =
  '{"serverVersion":{{json .ServerVersion}},"driver":{{json .Driver}},"driverStatus":{{json .DriverStatus}}}';
const backendType = 'io.containerd.snapshotter.v1';
const requireFact = (fact) => {
  if (!fact) throw new Error(dockerStoreFailureMessage);
};

export class DockerStoreError extends Error {
  constructor(info) {
    super(dockerStoreFailureMessage);
    this.code = 'DOCKER_STORE_INVALID';
    this.serverVersion = info?.serverVersion ?? 'unknown';
    this.backend = info ? (requiredBackend(info) ? 'required' : 'other') : 'unverified';
  }
}

function execute(binary, args, options) {
  const result = spawnSync(binary, args, {
    ...options,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  requireFact(!result.error && result.status === 0);
  return result.stdout;
}

function command(run, env, binary, args, timeout = 20_000) {
  const output = run(binary, args, { env, timeout, maxBuffer: maximumBytes });
  requireFact(typeof output === 'string' && Buffer.byteLength(output) <= maximumBytes);
  return output.trim();
}

function hostedDefaultContext({ env, run }) {
  requireFact(
    process.platform === 'linux' &&
      env.GITHUB_ACTIONS === 'true' &&
      env.RUNNER_ENVIRONMENT === 'github-hosted',
  );
  requireFact(
    (env.DOCKER_HOST === undefined || env.DOCKER_HOST === '') &&
      (env.DOCKER_CONTEXT === undefined || env.DOCKER_CONTEXT === ''),
  );
  requireFact(command(run, env, 'docker', ['context', 'show']) === 'default');
  requireFact(
    command(run, env, 'docker', [
      'context',
      'inspect',
      'default',
      '--format',
      '{{.Endpoints.docker.Host}}',
    ]) === 'unix:///var/run/docker.sock',
  );
}

function backendInformation({ env, run }) {
  const value = JSON.parse(command(run, env, 'docker', ['info', '--format', infoFormat]));
  requireFact(
    value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      Object.keys(value).sort().join(',') === 'driver,driverStatus,serverVersion',
  );
  requireFact(
    typeof value.serverVersion === 'string' &&
      /^(?:28|29)\.\d{1,3}\.\d{1,3}(?:[-+][A-Za-z0-9.-]{1,32})?$/u.test(value.serverVersion),
  );
  requireFact(typeof value.driver === 'string' && value.driver.length <= 128);
  requireFact(
    Array.isArray(value.driverStatus) &&
      value.driverStatus.length <= 32 &&
      value.driverStatus.every(
        (entry) =>
          Array.isArray(entry) &&
          entry.length === 2 &&
          entry.every((part) => typeof part === 'string' && part.length <= 256),
      ),
  );
  return value;
}

function requiredBackend(info) {
  const types = info.driverStatus.filter(([name]) => name === 'driver-type');
  return info.driver === 'overlayfs' && types.length === 1 && types[0][1] === backendType;
}

function result(info) {
  return { serverVersion: info.serverVersion, driver: 'overlayfs', driverType: backendType };
}

export function verifyDockerStore({ env = process.env, run = execute } = {}) {
  let info;
  try {
    hostedDefaultContext({ env, run });
    info = backendInformation({ env, run });
    requireFact(requiredBackend(info));
    return result(info);
  } catch {
    throw new DockerStoreError(info);
  }
}

function optionalStat(fileSystem, path) {
  try {
    return fileSystem.lstatSync(path);
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  }
}

function safeDirectory(fileSystem, path, ownerUid, missingLeaf = false) {
  requireFact(isAbsolute(path) && resolve(path) === path && dirname(path) !== path);
  const root = parse(path).root;
  let current = root;
  const parts = path.slice(root.length).split('/').filter(Boolean);
  for (const [index, part] of ['', ...parts].entries()) {
    if (part) current = join(current, part);
    const leaf = index === parts.length;
    const stat = optionalStat(fileSystem, current);
    if (!stat && leaf && missingLeaf) return undefined;
    requireFact(stat?.isDirectory() && !stat.isSymbolicLink() && [0, ownerUid].includes(stat.uid));
    requireFact(
      (stat.mode & 0o022) === 0 || (!leaf && stat.uid === 0 && (stat.mode & 0o1000) !== 0),
    );
    if (leaf) {
      requireFact(stat.uid === ownerUid);
      return stat;
    }
  }
}

function readConfig(fileSystem, path, ownerUid) {
  const before = optionalStat(fileSystem, path);
  if (!before) return undefined;
  const safe = (stat) =>
    stat.isFile() &&
    !stat.isSymbolicLink() &&
    stat.uid === ownerUid &&
    stat.nlink === 1 &&
    (stat.mode & 0o7022) === 0 &&
    stat.size <= maximumBytes;
  requireFact(safe(before));
  let descriptor;
  try {
    descriptor = fileSystem.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const opened = fileSystem.fstatSync(descriptor);
    requireFact(safe(opened) && opened.dev === before.dev && opened.ino === before.ino);
    const bytes = Buffer.alloc(opened.size + 1);
    let length = 0;
    while (length < bytes.length) {
      const count = fileSystem.readSync(descriptor, bytes, length, bytes.length - length, null);
      if (count === 0) break;
      length += count;
    }
    const after = fileSystem.fstatSync(descriptor);
    requireFact(
      safe(after) &&
        length === opened.size &&
        after.size === opened.size &&
        after.mtimeMs === opened.mtimeMs &&
        after.ctimeMs === opened.ctimeMs,
    );
    return { bytes: bytes.subarray(0, length), mode: opened.mode & 0o777 };
  } finally {
    if (descriptor !== undefined) fileSystem.closeSync(descriptor);
  }
}

function syncDirectory(fileSystem, directory) {
  const descriptor = fileSystem.openSync(
    directory,
    fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW,
  );
  try {
    fileSystem.fsyncSync(descriptor);
  } finally {
    fileSystem.closeSync(descriptor);
  }
}

function installConfig({ fileSystem, configDirectory, ownerUid }) {
  const existingDirectory = safeDirectory(fileSystem, configDirectory, ownerUid, true);
  const path = join(configDirectory, 'daemon.json');
  const temporary = join(configDirectory, '.maxim-containerd-daemon.tmp');
  requireFact(!optionalStat(fileSystem, temporary));
  const previous = readConfig(fileSystem, path, ownerUid);
  const config = previous ? JSON.parse(previous.bytes) : {};
  const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
  requireFact(object(config) && (!Object.hasOwn(config, 'features') || object(config.features)));
  const bytes = Buffer.from(
    `${JSON.stringify({ ...config, features: { ...config.features, 'containerd-snapshotter': true } }, null, 2)}\n`,
  );
  requireFact(bytes.length <= maximumBytes);
  if (!existingDirectory) fileSystem.mkdirSync(configDirectory, { mode: 0o755 });
  safeDirectory(fileSystem, configDirectory, ownerUid);
  let descriptor,
    writtenIdentity,
    installed = false;
  try {
    descriptor = fileSystem.openSync(
      temporary,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
      0o600,
    );
    writtenIdentity = fileSystem.fstatSync(descriptor);
    requireFact(
      writtenIdentity.uid === ownerUid && writtenIdentity.isFile() && writtenIdentity.nlink === 1,
    );
    let offset = 0;
    while (offset < bytes.length) {
      const count = fileSystem.writeSync(descriptor, bytes, offset, bytes.length - offset);
      requireFact(count > 0);
      offset += count;
    }
    fileSystem.fchmodSync(descriptor, previous?.mode ?? 0o600);
    fileSystem.fsyncSync(descriptor);
    fileSystem.closeSync(descriptor);
    descriptor = undefined;
    safeDirectory(fileSystem, configDirectory, ownerUid);
    const current = readConfig(fileSystem, path, ownerUid);
    requireFact(
      Boolean(current) === Boolean(previous) &&
        (!current || (current.mode === previous.mode && current.bytes.equals(previous.bytes))),
    );
    fileSystem.renameSync(temporary, path);
    installed = true;
    syncDirectory(fileSystem, configDirectory);
  } finally {
    if (descriptor !== undefined) fileSystem.closeSync(descriptor);
    if (!installed && writtenIdentity) {
      const current = optionalStat(fileSystem, temporary);
      if (
        current?.isFile() &&
        current.nlink === 1 &&
        current.uid === ownerUid &&
        current.dev === writtenIdentity.dev &&
        current.ino === writtenIdentity.ino
      )
        fileSystem.unlinkSync(temporary);
    }
  }
}

// FLAG: This configures only the disposable hosted runner's existing default
// dockerd, before containers/builders/image loads. Preserve the exact image Size
// guard; preparing a common backend still requires new cross-job CI acceptance.
export function prepareDockerStore({
  env = process.env,
  run = execute,
  fileSystem = fs,
  configDirectory = '/etc/docker',
  uid = process.getuid(),
  ownerUid = 0,
} = {}) {
  let info;
  try {
    requireFact(uid === 0);
    hostedDefaultContext({ env, run });
    info = backendInformation({ env, run });
    if (requiredBackend(info)) return result(info);
    requireFact(command(run, env, 'docker', ['container', 'ls', '--all', '--quiet']) === '');
    installConfig({ fileSystem, configDirectory, ownerUid });
    command(run, env, 'systemctl', ['restart', 'docker.service'], 60_000);
    return verifyDockerStore({ env, run });
  } catch (error) {
    if (error instanceof DockerStoreError) throw error;
    throw new DockerStoreError(info);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    requireFact(process.argv.length === 3 && ['prepare', 'verify'].includes(process.argv[2]));
    const info = process.argv[2] === 'prepare' ? prepareDockerStore() : verifyDockerStore();
    process.stdout.write(`${JSON.stringify(info)}\n`);
  } catch (error) {
    const failure = error instanceof DockerStoreError ? error : new DockerStoreError();
    process.stderr.write(
      `${JSON.stringify({
        error: failure.code,
        message: failure.message,
        serverVersion: failure.serverVersion,
        backend: failure.backend,
      })}\n`,
    );
    process.exitCode = 1;
  }
}
