import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from 'node:fs';
import { isOpaqueGitHubCredential } from './registry-images.mjs';

function credentialFailure() {
  const error = new Error(
    'Invalid private GHCR credential file. Provide a private 0600 regular file with a valid username and opaque credential.',
  );
  error.code = 'REGISTRY_CREDENTIAL_INVALID';
  throw error;
}

// FLAG: Open only the same bounded private inode observed before open; neither
// malformed credential content nor filesystem/JSON diagnostics may leave this reader.
export function readRegistryCredential(path) {
  let descriptor;
  try {
    if (typeof path !== 'string' || !path) credentialFailure();
    const before = lstatSync(path);
    const safe = (stat) =>
      stat.isFile() &&
      !stat.isSymbolicLink() &&
      stat.nlink === 1 &&
      (stat.mode & 0o777) === 0o600 &&
      [0, process.getuid()].includes(stat.uid) &&
      stat.size > 0 &&
      stat.size <= 4096;
    if (!safe(before)) credentialFailure();
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = fstatSync(descriptor);
    if (
      !safe(opened) ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      opened.size !== before.size
    )
      credentialFailure();
    const buffer = Buffer.alloc(opened.size + 1);
    let bytes = 0;
    while (bytes < buffer.length) {
      const count = readSync(descriptor, buffer, bytes, buffer.length - bytes, null);
      if (count === 0) break;
      bytes += count;
    }
    if (bytes !== opened.size) credentialFailure();
    const value = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, bytes)),
    );
    if (
      value === null ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      Object.keys(value).sort().join(',') !== 'token,username' ||
      typeof value.username !== 'string' ||
      value.username.trim() !== value.username ||
      !/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/u.test(value.username) ||
      !isOpaqueGitHubCredential(value.token)
    )
      credentialFailure();
    return value;
  } catch {
    credentialFailure();
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}
