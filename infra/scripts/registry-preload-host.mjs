#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import {
  closeSync,
  constants,
  fsyncSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statfsSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  assertImageInspection,
  assertRegistryRecord,
  isOpaqueGitHubCredential,
  parseImageInspection,
} from '../../scripts/ci/registry-images.mjs';

export const RELEASE_REPOSITORY = 'GameclubPro/Major-Maksimov';
export const RELEASE_REPOSITORY_ID = '1168895008';
const DIGEST = /^sha256:[a-f0-9]{64}$/u;
const COMPONENTS = Object.freeze({
  'api-shared': 'api',
  'miniapp-major-static': 'miniapp',
  'admin-static': 'admin',
  eraser: 'eraser',
});
const MAX_IMAGE_BYTES = 64 * 1024 ** 3;

export function registryArtifactName(record) {
  return `maxim-registry-${record.component}-${record.source.sha}-${record.source.runId}-${record.source.runAttempt}`;
}

export function validatePreloadRequest(request, { sha, component, now = Date.now() }) {
  const record = request?.record;
  const reference = assertRegistryRecord(record, {
    repository: RELEASE_REPOSITORY,
    sha,
    component,
  });
  const sampledAt = Date.parse(request.verifiedAt);
  if (
    request.schemaVersion !== 1 ||
    record.source.repositoryId !== RELEASE_REPOSITORY_ID ||
    !['push', 'workflow_dispatch'].includes(record.source.event) ||
    !Number.isSafeInteger(record.image.sizeBytes) ||
    record.image.sizeBytes < 1 ||
    record.image.sizeBytes > MAX_IMAGE_BYTES ||
    !Number.isSafeInteger(request.artifact?.id) ||
    request.artifact.id < 1 ||
    !DIGEST.test(request.artifact.digest ?? '') ||
    request.artifact.name !== registryArtifactName(record) ||
    !Number.isFinite(sampledAt) ||
    sampledAt > now + 120_000 ||
    sampledAt < now - 30 * 60_000
  ) {
    throw new Error(
      'Registry preload needs a fresh exact-source proof, bounded size and bound artifact identity.',
    );
  }
  return reference;
}

export function receiptPath(stateDir, component, sha) {
  if (!Object.hasOwn(COMPONENTS, component) || !/^[a-f0-9]{40}$/u.test(sha ?? '')) {
    throw new Error('Invalid registry receipt component or source SHA.');
  }
  return resolve(stateDir, 'registry-images', `${component}-${sha}.json`);
}

export function assertPrivateFile(path, { maxBytes = 65536 } = {}) {
  const stat = lstatSync(path);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.size < 1 ||
    stat.size > maxBytes ||
    stat.mode & 0o077 ||
    ![0, process.getuid()].includes(stat.uid)
  ) {
    throw new Error('Expected a private regular file owned by root or the deploy user.');
  }
  return stat;
}

function run(binary, args, { env = process.env, input, allowMissingImage = false } = {}) {
  const result = spawnSync(binary, args, {
    env,
    input,
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
    timeout: 20 * 60_000,
  });
  // FLAG: Credential content and command output never enter failure messages.
  if (result.status !== 0) {
    if (
      allowMissingImage &&
      result.status === 1 &&
      /(?:No such image|No such object):/u.test(result.stderr ?? '')
    )
      return null;
    throw new Error(
      `Registry preload ${binary} ${args[0]} failed (${result.status ?? result.error?.code ?? result.signal}).`,
    );
  }
  return result.stdout.trim();
}

function inspect(runCommand, reference, options) {
  const output = runCommand('docker', ['image', 'inspect', reference], options);
  if (output === null) return null;
  return parseImageInspection(output);
}

function writeReceipt(path, request) {
  const directory = resolve(path, '..');
  mkdirSync(directory, { recursive: true, mode: 0o750 });
  const stat = lstatSync(directory);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.mode & 0o022 ||
    ![0, process.getuid()].includes(stat.uid)
  ) {
    throw new Error('Registry receipt directory has unsafe ownership or permissions.');
  }
  const temporary = `${path}.${process.pid}.tmp`;
  const descriptor = openSync(
    temporary,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    writeFileSync(
      descriptor,
      `${JSON.stringify({ ...request, preloadedAt: new Date().toISOString() }, null, 2)}\n`,
    );
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  try {
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
  const directoryDescriptor = openSync(directory, 'r');
  try {
    fsyncSync(directoryDescriptor);
  } finally {
    closeSync(directoryDescriptor);
  }
}

export function preloadRegistryImage(
  request,
  {
    sha,
    component,
    stateDir = '/var/lib/maxim-deploy',
    credentialFile = '/etc/maxim-deploy/ghcr-read.json',
    runCommand = run,
    now = Date.now(),
    availableBytes,
  } = {},
) {
  const reference = validatePreloadRequest(request, { sha, component, now });
  const record = request.record;
  const floor = (component === 'api' ? 10 : 6) * 1024 ** 3;
  let available = availableBytes;
  if (available === undefined) {
    const filesystem = statfsSync('/var/lib/docker', { bigint: true });
    available = Number(filesystem.bavail * filesystem.bsize);
  }
  const required = floor + 2 * record.image.sizeBytes;
  if (!Number.isSafeInteger(available) || available < required) {
    throw new Error(
      `Registry pull capacity refused: ${available}B available, ${required}B required including the rollout reserve.`,
    );
  }
  assertPrivateFile(credentialFile);
  let credentials;
  try {
    credentials = JSON.parse(readFileSync(credentialFile, 'utf8'));
  } catch {
    // FLAG: JSON parse diagnostics may quote the credential; render only this fixed refusal.
    throw new Error('Invalid read-only GHCR credential configuration.');
  }
  if (
    credentials === null ||
    typeof credentials !== 'object' ||
    Array.isArray(credentials) ||
    !/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/u.test(credentials.username ?? '') ||
    !isOpaqueGitHubCredential(credentials.token)
  ) {
    throw new Error('Invalid read-only GHCR credential configuration.');
  }
  const directory = mkdtempSync(join(tmpdir(), 'maxim-ghcr-pull-'));
  const childEnv = { ...process.env, DOCKER_CONFIG: directory };
  const authenticatedRun = (binary, args, options = {}) =>
    runCommand(binary, args, { ...options, env: childEnv });
  try {
    authenticatedRun(
      'docker',
      ['login', 'ghcr.io', '--username', credentials.username, '--password-stdin'],
      { input: credentials.token },
    );
    authenticatedRun('docker', ['image', 'pull', '--platform', 'linux/amd64', reference]);
    const inspection = inspect(authenticatedRun, reference);
    assertImageInspection(inspection, { sha, imageId: record.image.imageId });
    if (inspection.Size !== record.image.sizeBytes)
      throw new Error('Pulled image size differs from the tested image.');
    // FLAG: Validate the digest subject before assigning the rollback-compatible local SHA alias.
    // Pulling or a failed inspection must never change the running containers or their aliases.
    const previous = inspect(authenticatedRun, record.image.alias, { allowMissingImage: true });
    if (previous && previous.Id !== record.image.imageId)
      throw new Error(
        'Existing immutable SHA alias points to a different image; refusing overwrite.',
      );
    authenticatedRun('docker', ['image', 'tag', reference, record.image.alias]);
    assertImageInspection(inspect(authenticatedRun, record.image.alias), {
      sha,
      imageId: record.image.imageId,
    });
    const releaseComponent = Object.entries(COMPONENTS).find(
      ([, value]) => value === component,
    )?.[0];
    writeReceipt(receiptPath(stateDir, releaseComponent, sha), request);
    return reference;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

export function verifyPreloadedImage({
  stateDir = '/var/lib/maxim-deploy',
  component,
  sha,
  imageRef,
  imageId,
}) {
  const path = receiptPath(stateDir, component, sha);
  assertPrivateFile(path);
  const request = JSON.parse(readFileSync(path, 'utf8'));
  const record = request.record;
  // Historical receipts retain proof identity; freshness is required when accepting a pull request only.
  validatePreloadRequest(request, {
    sha,
    component: COMPONENTS[component],
    now: Date.parse(request.verifiedAt),
  });
  if (record.image.alias !== imageRef || record.image.imageId !== imageId)
    throw new Error('Local image does not match its verified registry receipt.');
  return request;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [command, component, sha, imageRef, imageId] = process.argv.slice(2);
    const stateDir = process.env.MAXIM_RELEASE_STATE_DIR || '/var/lib/maxim-deploy';
    if (command === 'pull') {
      if (
        process.env.MAXIM_DEPLOY_LOCK_VERSION !== 'flock-v1' ||
        !/^[1-9][0-9]*$/u.test(process.env.MAXIM_DEPLOY_LOCK_OWNER_PID ?? '')
      ) {
        throw new Error('Registry pull requires the protected deploy-lock wrapper.');
      }
      // FLAG: Buffer the complete pipe before decoding; Node 24's encoded stdin fast path is unsafe.
      const input = readFileSync(0).toString('utf8');
      if (Buffer.byteLength(input) > 65536) throw new Error('Oversized registry preload request.');
      const reference = preloadRegistryImage(JSON.parse(input), { sha, component, stateDir });
      process.stdout.write(`Preloaded ${reference} as its verified immutable SHA alias.\n`);
    } else if (command === 'verify') {
      const request = verifyPreloadedImage({ stateDir, component, sha, imageRef, imageId });
      process.stdout.write(`${JSON.stringify(request.record)}\n`);
    } else throw new Error('Expected pull or verify.');
  } catch (error) {
    process.stderr.write(`Registry preload: ${error.message}\n`);
    process.exitCode = 1;
  }
}
