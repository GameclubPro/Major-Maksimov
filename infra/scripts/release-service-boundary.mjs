import * as fs from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';

export const RELEASE_PATHS = Object.freeze({
  controller: '/var/www/Chat_bot',
  executors: '/var/www/Chat_bot/.release-executors',
  state: '/var/lib/maxim-release',
  manifestState: '/var/lib/maxim-deploy',
  bundle: '/usr/local/lib/maxim-release',
  credential: '/etc/maxim-deploy/ghcr-read.json',
});
export const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
export const HASH = /^[a-f0-9]{64}$/u;
export const SHA = /^[a-f0-9]{40}$/u;
export const COMPONENTS = Object.freeze({
  api: 'api-shared',
  miniapp: 'miniapp-major-static',
  admin: 'admin-static',
  eraser: 'eraser',
});

export function refuse(code) {
  const error = new Error(`Release service ${code}.`);
  error.code = code;
  throw error;
}

export function stableJson(value) {
  return JSON.stringify(value, function (_key, entry) {
    if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
      return Object.fromEntries(
        Object.keys(entry)
          .sort()
          .map((key) => [key, entry[key]]),
      );
    }
    return entry;
  });
}

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function assertDirectory(path, { floor = '/' } = {}) {
  const absolute = resolve(path);
  const minimum = resolve(floor);
  if (absolute !== minimum && !absolute.startsWith(`${minimum === '/' ? '' : minimum}/`))
    refuse('UNSAFE_PATH');
  let current = absolute;
  while (true) {
    const stat = fs.lstatSync(current);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      stat.mode & 0o022 ||
      ![0, process.getuid()].includes(stat.uid)
    )
      refuse('UNSAFE_DIRECTORY');
    if (current === minimum) break;
    current = dirname(current);
  }
  return absolute;
}

export function privateBytes(path, { maxBytes = 1024 * 1024, floor = '/' } = {}) {
  assertDirectory(dirname(path), { floor });
  const descriptor = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(descriptor);
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      stat.mode & 0o077 ||
      ![0, process.getuid()].includes(stat.uid) ||
      stat.size < 1 ||
      stat.size > maxBytes
    )
      refuse('UNSAFE_FILE');
    const value = fs.readFileSync(descriptor);
    if (value.length > maxBytes) refuse('OVERSIZED_FILE');
    return value;
  } finally {
    fs.closeSync(descriptor);
  }
}

export function writePrivateJson(path, value, { floor = '/', exclusive = false } = {}) {
  const directory = assertDirectory(dirname(path), { floor });
  if (fs.existsSync(path)) {
    if (exclusive) refuse('EXISTING_CONTEXT');
    privateBytes(path, { floor });
  }
  const temporary = `${path}.${randomUUID()}.tmp`;
  const fd = fs.openSync(
    temporary,
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
    0o600,
  );
  try {
    fs.writeFileSync(fd, `${stableJson(value)}\n`);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    if (exclusive) {
      // FLAG: A retained operation context cannot be replaced by a retry or a second daemon.
      fs.linkSync(temporary, path);
      fs.unlinkSync(temporary);
    } else fs.renameSync(temporary, path);
    const dir = fs.openSync(
      directory,
      fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW,
    );
    try {
      fs.fsyncSync(dir);
    } finally {
      fs.closeSync(dir);
    }
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

export function cleanEnvironment() {
  return {
    PATH: '/usr/local/bin:/usr/bin:/bin',
    HOME: '/var/lib/maxim-release',
    LANG: 'C.UTF-8',
    GIT_NO_REPLACE_OBJECTS: '1',
    GIT_TERMINAL_PROMPT: '0',
  };
}
