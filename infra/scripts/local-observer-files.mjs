import * as fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';

export function observerFailure(code) {
  throw Object.assign(new Error(code), { code });
}
export function privateDirectory(path, { floor = '/', privateLeaf = true } = {}) {
  const root = resolve(path);
  const minimum = resolve(floor);
  if (root !== minimum && !root.startsWith(minimum === '/' ? '/' : minimum + '/'))
    observerFailure('OBSERVER_UNSAFE_PATH');
  let current = root;
  while (true) {
    const stat = fs.lstatSync(current);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      stat.mode & 0o022 ||
      ![0, process.getuid()].includes(stat.uid)
    )
      observerFailure('OBSERVER_UNSAFE_DIRECTORY');
    if (current === minimum) break;
    current = dirname(current);
  }
  if (privateLeaf && (fs.lstatSync(root).mode & 0o077) !== 0)
    observerFailure('OBSERVER_PRIVATE_DIRECTORY_REQUIRED');
  return root;
}
export function readObserverPrivate(
  path,
  { floor = '/', maxBytes = 1024 * 1024, empty = false } = {},
) {
  privateDirectory(dirname(path), { floor });
  const before = fs.lstatSync(path);
  const safe = (stat) =>
    stat.isFile() &&
    !stat.isSymbolicLink() &&
    stat.nlink === 1 &&
    (stat.mode & 0o777) === 0o600 &&
    [0, process.getuid()].includes(stat.uid) &&
    stat.size <= maxBytes &&
    (empty || stat.size > 0);
  if (!safe(before)) observerFailure('OBSERVER_UNSAFE_FILE');
  const fd = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const opened = fs.fstatSync(fd);
    if (!safe(opened) || opened.dev !== before.dev || opened.ino !== before.ino)
      observerFailure('OBSERVER_FILE_CHANGED');
    const buffer = Buffer.alloc(maxBytes + 1);
    let used = 0;
    while (used < buffer.length) {
      const count = fs.readSync(fd, buffer, used, buffer.length - used, null);
      if (!count) break;
      used += count;
    }
    const after = fs.fstatSync(fd);
    const named = fs.lstatSync(path);
    if (
      used !== opened.size ||
      !safe(after) ||
      !safe(named) ||
      named.dev !== opened.dev ||
      named.ino !== opened.ino ||
      named.size !== opened.size ||
      after.mtimeMs !== opened.mtimeMs ||
      after.ctimeMs !== opened.ctimeMs
    )
      observerFailure('OBSERVER_FILE_CHANGED');
    return buffer.subarray(0, used);
  } finally {
    fs.closeSync(fd);
  }
}
export function writeObserverPrivate(path, value, { floor = '/', exclusive = false } = {}) {
  privateDirectory(dirname(path), { floor });
  if (fs.existsSync(path)) {
    if (exclusive) observerFailure('OBSERVER_FILE_EXISTS');
    readObserverPrivate(path, { floor, empty: true });
  }
  const temporary = path + '.' + randomUUID() + '.tmp';
  const fd = fs.openSync(
    temporary,
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
    0o600,
  );
  try {
    fs.writeFileSync(fd, value);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    if (exclusive) {
      fs.linkSync(temporary, path);
      fs.unlinkSync(temporary);
    } else fs.renameSync(temporary, path);
    const dir = fs.openSync(
      dirname(path),
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
