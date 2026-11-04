#!/usr/bin/env node

import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { OperationStore, validateReleaseRequest } from './release-operation-store.mjs';
import {
  assertDirectory,
  cleanEnvironment,
  HASH,
  RELEASE_PATHS,
  sha256,
  SHA,
  UUID,
} from './release-service-boundary.mjs';
import { validateCompleteReleaseManifest } from './release-manifest.mjs';
import { readPolicy, resumePolicy } from './release-service-policy.mjs';

export const CONTROL_SOCKET = '/run/maxim-release/control.sock';
export const ADMIN_SOCKET = '/run/maxim-release/admin.sock';
const MAX_WIRE_BYTES = 131072;
const MAX_EVENT_BYTES = 8192;
const RESPONSE_FLUSH_TIMEOUT_MS = 5000;
const CODE = /^[A-Z][A-Z0-9_]{0,63}$/u;
const SAFE_PUBLIC_CODES = new Set([
  'INVALID_REQUEST',
  'INVALID_COMMAND',
  'REQUEST_TOO_LARGE',
  'REQUEST_TIMEOUT',
  'ID_CONFLICT',
  'CAPACITY_REACHED',
  'UNRESOLVED_REVIEW',
  'POLICY_PAUSED',
  'AUTOMATIC_DISABLED',
  'NOT_FOUND',
  'STALE_POLICY',
  'POLICY_CHANGED',
  'INVALID_RESOLUTION_STATE',
  'RESOLUTION_BUSY',
  'RESOLUTION_UNPROVED',
]);

function fail(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}
function exact(value, keys) {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).sort().join(',') === [...keys].sort().join(',')
  );
}
function whitespace(bytes) {
  return bytes.every((byte) => [9, 10, 13, 32].includes(byte));
}
function decode(bytes) {
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    fail('INVALID_REQUEST');
  }
}
function identity(summary) {
  if (!UUID.test(summary.id) || !HASH.test(summary.requestHash) || !SHA.test(summary.sourceSha))
    fail('INVALID_OPERATION');
  return summary;
}

export function readInstalledReleaseInventory({
  directory = RELEASE_PATHS.manifestState,
  floor = '/',
  now = Date.now,
} = {}) {
  const observedAt = new Date(now()).toISOString();
  let descriptor;
  try {
    assertDirectory(directory, { floor });
    const path = join(directory, 'current.json');
    const safe = (stat) =>
      stat.isFile() &&
      !stat.isSymbolicLink() &&
      stat.nlink === 1 &&
      !(stat.mode & 0o022) &&
      [0, process.getuid()].includes(stat.uid) &&
      stat.size > 0 &&
      stat.size <= 1024 * 1024;
    const before = fs.lstatSync(path);
    if (!safe(before)) fail('MANIFEST_UNPROVED');
    descriptor = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const opened = fs.fstatSync(descriptor);
    if (
      !safe(opened) ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      opened.size !== before.size
    )
      fail('MANIFEST_UNPROVED');
    const buffer = Buffer.alloc(opened.size + 1);
    let bytes = 0;
    while (bytes < buffer.length) {
      const count = fs.readSync(descriptor, buffer, bytes, buffer.length - bytes, null);
      if (count === 0) break;
      bytes += count;
    }
    const after = fs.fstatSync(descriptor);
    const current = fs.lstatSync(path);
    if (
      bytes !== opened.size ||
      !safe(after) ||
      !safe(current) ||
      current.dev !== opened.dev ||
      current.ino !== opened.ino ||
      current.size !== opened.size ||
      after.size !== opened.size ||
      after.mtimeMs !== opened.mtimeMs ||
      after.ctimeMs !== opened.ctimeMs
    )
      fail('MANIFEST_UNPROVED');
    const raw = buffer.subarray(0, bytes);
    const manifest = validateCompleteReleaseManifest(
      JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw)),
    );
    if (typeof manifest.createdAt !== 'string' || !Number.isFinite(Date.parse(manifest.createdAt)))
      fail('MANIFEST_UNPROVED');
    const components = {};
    for (const [id, component] of Object.entries(manifest.components)) {
      if (component.imageRef.length > 512 || /\s/u.test(component.imageRef))
        fail('MANIFEST_UNPROVED');
      components[id] = {
        sourceSha: component.sourceSha,
        imageRef: component.imageRef,
        imageId: component.imageId,
      };
    }
    // FLAG: Inventory exposes identities only. Hash the exact protected bytes so a submit
    // can bind its expected manifest without exporting retained proof or arbitrary metadata.
    return {
      status: 'PROVED',
      observedAt,
      manifestSha256: sha256(raw),
      releaseId: manifest.releaseId,
      targetSha: manifest.targetSha,
      createdAt: manifest.createdAt,
      components,
    };
  } catch {
    return { status: 'UNPROVED', observedAt, reasonCode: 'MANIFEST_UNPROVED' };
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

export function processIdentity(pid, sourceSha, now = Date.now()) {
  const stat = fs.readFileSync(`/proc/${pid}/stat`).toString('utf8');
  const startTicks = stat.slice(stat.lastIndexOf(') ') + 2).split(' ')[19];
  const bootId = fs.readFileSync('/proc/sys/kernel/random/boot_id').toString('utf8').trim();
  return { pid, sourceSha, startedAt: new Date(now).toISOString(), bootId, startTicks };
}

export function parseChildEvent(bytes, summary) {
  const value = decode(bytes);
  const keys =
    value?.event === 'SAFE_REFUSAL'
      ? ['schemaVersion', 'event', 'id', 'requestHash', 'reasonCode']
      : ['schemaVersion', 'event', 'id', 'requestHash'];
  if (
    !exact(value, keys) ||
    value.schemaVersion !== 1 ||
    value.id !== summary.id ||
    value.requestHash !== summary.requestHash ||
    !['PREPARED', 'READY', 'SAFE_REFUSAL'].includes(value.event) ||
    (value.event === 'SAFE_REFUSAL' &&
      (typeof value.reasonCode !== 'string' || !CODE.test(value.reasonCode)))
  )
    fail('INVALID_CHILD_EVENT');
  return value;
}

function terminate(child) {
  // FLAG: Only the process group created for this exact child may be stopped.
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch {
    try {
      child.kill('SIGTERM');
    } catch {
      /* observed exit decides the outcome */
    }
  }
}

export function observeReleaseChild(
  child,
  { summary, expectedEvent, timeoutMs, onReady = () => {}, killGraceMs = 5000 },
) {
  return new Promise((resolve) => {
    let bytes = Buffer.alloc(0);
    let event = null;
    let invalid = false;
    let deadlineExceeded = false;
    let spawnFailed = false;
    let forceTimer;
    let abandonTimer;
    let settled = false;
    const fd3 = child.stdio?.[3];
    const fd4 = child.stdio?.[4];
    const finish = (exitCode, signal, exitProved = true) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(forceTimer);
      clearTimeout(abandonTimer);
      resolve({ exitCode, signal, exitProved, event, invalid, deadlineExceeded, spawnFailed });
    };
    const stop = () => {
      terminate(child);
      if (!forceTimer)
        forceTimer = setTimeout(() => {
          try {
            process.kill(-child.pid, 'SIGKILL');
          } catch {
            try {
              child.kill('SIGKILL');
            } catch {
              /* no exit proof */
            }
          }
        }, killGraceMs);
      if (!abandonTimer)
        abandonTimer = setTimeout(() => finish(null, null, false), killGraceMs * 2);
    };
    const invalidate = () => {
      invalid = true;
      stop();
    };
    const timer = setTimeout(() => {
      deadlineExceeded = true;
      stop();
    }, timeoutMs);
    child.once('error', () => {
      spawnFailed = true;
    });
    child.once('close', (code, signal) => finish(code, signal));
    if (!fd3) {
      invalidate();
      return;
    }
    fd3.on('error', invalidate);
    fd4?.on('error', invalidate);
    fd3.on('data', (chunk) => {
      if (invalid || settled) return;
      if (bytes.length + chunk.length > MAX_EVENT_BYTES) {
        invalidate();
        return;
      }
      bytes = Buffer.concat([bytes, chunk]);
      const newline = bytes.indexOf(10);
      if (newline < 0) return;
      if (!whitespace(bytes.subarray(newline + 1))) {
        invalidate();
        return;
      }
      if (event !== null) return;
      try {
        event = parseChildEvent(bytes.subarray(0, newline), summary);
        if (event.event !== expectedEvent && event.event !== 'SAFE_REFUSAL') {
          invalidate();
          return;
        }
        if (event.event === 'READY') {
          if (!fd4 || typeof fd4.end !== 'function') {
            invalidate();
            return;
          }
          // FLAG: Persist EXECUTING before authorizing any runtime mutation over the private FD.
          onReady();
          fd4.end(`PROCEED:${summary.id}:${summary.requestHash}\n`);
        }
      } catch {
        invalidate();
      }
    });
  });
}

function productionChild(command, args, summary, logDescriptor, options = {}) {
  identity(summary);
  return spawn(command, args, {
    env: cleanEnvironment(),
    stdio: ['ignore', logDescriptor, logDescriptor, 'pipe', 'pipe'],
    detached: true,
    ...options,
  });
}

export function spawnProductionPrepare(summary, logDescriptor) {
  return productionChild(
    '/bin/bash',
    [
      join(RELEASE_PATHS.bundle, 'infra/scripts/release-service-prepare.sh'),
      'prepare',
      summary.id,
      summary.requestHash,
      summary.sourceSha,
    ],
    summary,
    logDescriptor,
  );
}

export function spawnProductionExecutor(summary, logDescriptor) {
  const cwd = join(RELEASE_PATHS.executors, identity(summary).id, 'source');
  return productionChild(
    '/bin/bash',
    [join(cwd, 'infra/scripts/vps-pull-build-up.sh'), 'main', '--auto'],
    summary,
    logDescriptor,
    {
      cwd,
      env: {
        ...cleanEnvironment(),
        MAXIM_DURABLE_RELEASE_OPERATION: summary.id,
        MAXIM_DURABLE_RELEASE_REQUEST_HASH: summary.requestHash,
        MAXIM_EXPECTED_DEPLOY_SHA: summary.sourceSha,
      },
    },
  );
}

export function validateProductionResult(summary, logDescriptor, { timeoutMs = 10 * 60_000 } = {}) {
  return new Promise((resolve) => {
    identity(summary);
    const child = spawn(
      '/bin/bash',
      [
        join(RELEASE_PATHS.bundle, 'infra/scripts/release-service-prepare.sh'),
        'result',
        summary.id,
        summary.requestHash,
        summary.sourceSha,
      ],
      {
        env: cleanEnvironment(),
        stdio: ['ignore', logDescriptor, logDescriptor],
        detached: true,
      },
    );
    let timedOut = false;
    let killTimer;
    let abandonTimer;
    let settled = false;
    const finish = (accepted) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      clearTimeout(abandonTimer);
      resolve(accepted);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      terminate(child);
      killTimer = setTimeout(() => {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          /* fail closed */
        }
      }, 5000);
      abandonTimer = setTimeout(() => finish(false), 10_000);
    }, timeoutMs);
    child.on('error', () => {});
    child.once('close', (code, signal) => {
      finish(!timedOut && code === 0 && signal === null);
    });
  });
}

function checkedResolution(value, expectedManifestSha256) {
  if (
    !exact(value, ['kind', 'evidenceSha256', 'manifestSha256']) ||
    !['RECOVERED', 'UNCHANGED'].includes(value.kind) ||
    typeof value.evidenceSha256 !== 'string' ||
    !HASH.test(value.evidenceSha256) ||
    value.manifestSha256 !== expectedManifestSha256
  )
    fail('RESOLUTION_UNPROVED');
  return {
    kind: value.kind,
    evidenceSha256: value.evidenceSha256,
    manifestSha256: value.manifestSha256,
  };
}

export function observeReviewChild(
  child,
  { summary, expectedManifestSha256, timeoutMs = 10 * 60_000, killGraceMs = 5000 },
) {
  return new Promise((resolve, reject) => {
    let bytes = Buffer.alloc(0);
    let invalid = false;
    let settled = false;
    let forceTimer;
    let abandonTimer;
    const finish = (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(forceTimer);
      clearTimeout(abandonTimer);
      try {
        if (invalid || code !== 0 || signal !== null) fail('RESOLUTION_UNPROVED');
        const newline = bytes.indexOf(10);
        if (newline < 0 || !whitespace(bytes.subarray(newline + 1))) fail('RESOLUTION_UNPROVED');
        const value = decode(bytes.subarray(0, newline));
        if (
          !exact(value, ['schemaVersion', 'kind', 'evidenceSha256', 'manifestSha256']) ||
          value.schemaVersion !== 1
        )
          fail('RESOLUTION_UNPROVED');
        resolve(
          checkedResolution(
            {
              kind: value.kind,
              evidenceSha256: value.evidenceSha256,
              manifestSha256: value.manifestSha256,
            },
            expectedManifestSha256,
          ),
        );
      } catch {
        reject(
          Object.assign(new Error('Review reconciliation could not be proved.'), {
            code: 'RESOLUTION_UNPROVED',
          }),
        );
      }
    };
    const stop = () => {
      invalid = true;
      terminate(child);
      if (!forceTimer)
        forceTimer = setTimeout(() => {
          try {
            process.kill(-child.pid, 'SIGKILL');
          } catch {
            try {
              child.kill('SIGKILL');
            } catch {
              /* unresolved */
            }
          }
        }, killGraceMs);
      if (!abandonTimer) abandonTimer = setTimeout(() => finish(null, null), killGraceMs * 2);
    };
    const timer = setTimeout(stop, timeoutMs);
    child.once('error', stop);
    child.once('close', finish);
    child.stdout?.on('error', stop);
    child.stdout?.on('data', (chunk) => {
      if (settled || invalid) return;
      if (bytes.length + chunk.length > MAX_EVENT_BYTES) {
        stop();
        return;
      }
      bytes = Buffer.concat([bytes, chunk]);
    });
    try {
      identity(summary);
      if (!HASH.test(expectedManifestSha256 ?? '') || !child.stdout) fail('RESOLUTION_UNPROVED');
      const observed = processIdentity(child.pid, summary.sourceSha);
      if (
        observed.pid !== child.pid ||
        !/^[a-f0-9-]{36}$/u.test(observed.bootId) ||
        !/^[0-9]+$/u.test(observed.startTicks)
      )
        fail('RESOLUTION_UNPROVED');
    } catch {
      stop();
    }
  });
}

export function reconcileProductionReview(summary, expectedManifestSha256, logDescriptor) {
  identity(summary);
  if (!HASH.test(expectedManifestSha256 ?? '')) fail('RESOLUTION_UNPROVED');
  const child = spawn(
    '/bin/bash',
    [
      join(RELEASE_PATHS.bundle, 'infra/scripts/release-service-prepare.sh'),
      'reconcile',
      summary.id,
      summary.requestHash,
      summary.sourceSha,
      expectedManifestSha256,
    ],
    {
      env: cleanEnvironment(),
      stdio: ['ignore', 'pipe', logDescriptor],
      detached: true,
    },
  );
  return observeReviewChild(child, { summary, expectedManifestSha256 });
}

function safeDirectory(directory, mode = 0o700) {
  try {
    fs.mkdirSync(directory, { mode });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  const stat = fs.lstatSync(directory);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.mode & 0o022 ||
    ![0, process.getuid()].includes(stat.uid)
  )
    fail('UNSAFE_DIRECTORY');
}

function logFile(directory, id) {
  const descriptor = fs.openSync(
    join(directory, `${id}.log`),
    fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW,
    0o600,
  );
  const stat = fs.fstatSync(descriptor);
  if (
    !stat.isFile() ||
    stat.nlink !== 1 ||
    (stat.mode & 0o777) !== 0o600 ||
    ![0, process.getuid()].includes(stat.uid)
  ) {
    fs.closeSync(descriptor);
    fail('UNSAFE_LOG');
  }
  return descriptor;
}

export class ReleaseService {
  constructor({
    directory = RELEASE_PATHS.state,
    socketPath = CONTROL_SOCKET,
    adminSocketPath = ADMIN_SOCKET,
    store,
    policyReader = readPolicy,
    policyResumer = resumePolicy,
    readInventory = readInstalledReleaseInventory,
    reconcileReview = reconcileProductionReview,
    spawnPrepare = spawnProductionPrepare,
    spawnExecutor = spawnProductionExecutor,
    validateResult = validateProductionResult,
    readIdentity = processIdentity,
    prepareTimeoutMs = 10 * 60_000,
    executorTimeoutMs = 60 * 60_000,
    heartbeatMs = 10_000,
    retryDelayMs = 30_000,
    lockDeadlineMs = 10 * 60_000,
    socketTimeoutMs = 20_000,
    adminSocketTimeoutMs = 10 * 60_000,
    killGraceMs = 5000,
  } = {}) {
    this.directory = directory;
    this.socketPath = socketPath;
    this.adminSocketPath = adminSocketPath;
    this.store = store ?? new OperationStore({ directory: join(directory, 'operations') });
    this.policyReader = policyReader;
    this.policyResumer = policyResumer;
    this.readInventory = readInventory;
    this.reconcileReview = reconcileReview;
    this.spawnPrepare = spawnPrepare;
    this.spawnExecutor = spawnExecutor;
    this.validateResult = validateResult;
    this.readIdentity = readIdentity;
    this.timings = {
      prepareTimeoutMs,
      executorTimeoutMs,
      heartbeatMs,
      retryDelayMs: Math.min(30_000, retryDelayMs),
      lockDeadlineMs: Math.min(10 * 60_000, lockDeadlineMs),
      socketTimeoutMs,
      adminSocketTimeoutMs,
      killGraceMs,
    };
    for (const value of Object.values(this.timings))
      if (!Number.isFinite(value) || value <= 0) fail('INVALID_OPTIONS');
    this.servers = [];
    this.connections = new Set();
    this.running = null;
    this.stopping = false;
    this.fatal = false;
    this.activeProcess = null;
    this.recovering = null;
    this.recoveryPromise = null;
  }

  policy() {
    return this.policyReader({ directory: this.directory });
  }

  inventory() {
    return {
      schemaVersion: 1,
      policy: this.policy(),
      operations: this.store.list(),
      blockedByReview: this.store.hasUncertain(),
      workerAvailable: !this.stopping && !this.fatal,
      installedRelease: this.readInventory(),
      activeProcess: this.activeProcess,
      activeRecovery: this.recovering,
    };
  }

  async dispatch(frame, { admin = false } = {}) {
    if (exact(frame, ['operation']) && frame.operation === 'inventory') return this.inventory();
    if (admin) {
      if (
        exact(frame, ['operation', 'id', 'expectedManifestSha256']) &&
        frame.operation === 'resolve_review' &&
        typeof frame.id === 'string' &&
        UUID.test(frame.id) &&
        typeof frame.expectedManifestSha256 === 'string' &&
        HASH.test(frame.expectedManifestSha256)
      ) {
        return this.resolveReview(frame.id, frame.expectedManifestSha256);
      }
      if (
        !exact(frame, ['operation', 'expectedPolicySha256']) ||
        frame.operation !== 'resume' ||
        typeof frame.expectedPolicySha256 !== 'string' ||
        !HASH.test(frame.expectedPolicySha256)
      )
        fail('INVALID_COMMAND');
      const result = this.policyResumer({
        directory: this.directory,
        expectedPolicySha256: frame.expectedPolicySha256,
      });
      this.wake();
      return result;
    }
    if (
      exact(frame, ['operation', 'id']) &&
      frame.operation === 'status' &&
      typeof frame.id === 'string' &&
      UUID.test(frame.id)
    ) {
      const value = this.store.get(frame.id);
      if (value === null) fail('NOT_FOUND');
      return value;
    }
    if (!exact(frame, ['operation', 'request']) || frame.operation !== 'submit')
      fail('INVALID_COMMAND');
    let request;
    try {
      request = validateReleaseRequest(frame.request);
    } catch {
      fail('INVALID_REQUEST');
    }
    // FLAG: A repeated accepted identity returns its durable outcome even after a policy pause.
    if (this.store.get(request.id)) return this.store.submit(request);
    if (this.stopping || this.fatal) fail('DAEMON_UNAVAILABLE');
    this.checkPolicy(request);
    const accepted = this.store.submit(request);
    this.wake();
    return accepted;
  }

  async resolveReview(id, expectedManifestSha256) {
    if (this.stopping || this.fatal) fail('DAEMON_UNAVAILABLE');
    if (this.running || this.activeProcess || this.recovering) fail('RESOLUTION_BUSY');
    const summary = this.store.get(id);
    if (!summary) fail('NOT_FOUND');
    if (summary.state !== 'NEEDS_REVIEW' || summary.resolution !== null)
      fail('INVALID_RESOLUTION_STATE');
    this.recovering = id;
    const work = async () => {
      const descriptor = logFile(join(this.directory, 'logs'), id);
      try {
        let resolution;
        try {
          resolution = checkedResolution(
            await this.reconcileReview(summary, expectedManifestSha256, descriptor),
            expectedManifestSha256,
          );
        } catch {
          fail('RESOLUTION_UNPROVED');
        }
        // FLAG: Only this trusted locked verifier may close an unresolved operation.
        // A disconnect or stop never permits a fabricated outcome or a late state write.
        if (this.stopping || this.fatal) fail('DAEMON_UNAVAILABLE');
        const current = this.store.get(id);
        if (
          current?.state !== 'NEEDS_REVIEW' ||
          current.resolution !== null ||
          current.requestHash !== summary.requestHash
        )
          fail('INVALID_RESOLUTION_STATE');
        return this.store.resolveReview(id, resolution);
      } finally {
        fs.closeSync(descriptor);
      }
    };
    this.recoveryPromise = work();
    try {
      return await this.recoveryPromise;
    } finally {
      this.recovering = null;
      this.recoveryPromise = null;
      if (!this.stopping && !this.fatal) {
        try {
          if (this.policy().paused === false) this.wake();
        } catch {
          this.fatal = true;
        }
      }
    }
  }

  checkPolicy(operation) {
    const policy = this.policy();
    if (policy.paused !== false) fail('POLICY_PAUSED');
    if (operation.trigger === 'automatic' && policy.autoEnabled !== true)
      fail('AUTOMATIC_DISABLED');
  }

  async listen(path, admin) {
    safeDirectory(dirname(path), 0o750);
    try {
      fs.lstatSync(path);
      fail('SOCKET_EXISTS');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    const server = createServer({ allowHalfOpen: true }, (socket) => {
      this.connections.add(socket);
      socket.on('error', () => {});
      socket.once('close', () => this.connections.delete(socket));
      let bytes = Buffer.alloc(0);
      let done = false;
      let flushTimer;
      const respond = (response) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (socket.destroyed) return;
        let wire = Buffer.from(`${JSON.stringify(response)}\n`);
        if (wire.length > MAX_WIRE_BYTES)
          wire = Buffer.from(
            '{"schemaVersion":1,"ok":false,"error":{"code":"RESPONSE_TOO_LARGE"}}\n',
          );
        // FLAG: A paused half-open peer cannot retain a daemon connection after its one response.
        // Flush once, bound that independent wait, then close both socket directions.
        flushTimer = setTimeout(() => socket.destroy(), RESPONSE_FLUSH_TIMEOUT_MS);
        socket.end(wire, () => socket.destroy());
      };
      const reject = (code) => respond({ schemaVersion: 1, ok: false, error: { code } });
      const timer = setTimeout(
        () => reject('REQUEST_TIMEOUT'),
        admin ? this.timings.adminSocketTimeoutMs : this.timings.socketTimeoutMs,
      );
      socket.on('data', async (chunk) => {
        if (done) return;
        if (bytes.length + chunk.length > MAX_WIRE_BYTES) {
          reject('REQUEST_TOO_LARGE');
          return;
        }
        bytes = Buffer.concat([bytes, chunk]);
        const newline = bytes.indexOf(10);
        if (newline < 0) return;
        if (!whitespace(bytes.subarray(newline + 1))) {
          reject('INVALID_REQUEST');
          return;
        }
        socket.pause();
        try {
          const result = await this.dispatch(decode(bytes.subarray(0, newline)), { admin });
          respond({ schemaVersion: 1, ok: true, result });
        } catch (error) {
          reject(SAFE_PUBLIC_CODES.has(error.code) ? error.code : 'DAEMON_UNAVAILABLE');
        }
      });
      socket.once('end', () => {
        if (!done) reject('INVALID_REQUEST');
      });
      socket.once('close', () => {
        clearTimeout(timer);
        clearTimeout(flushTimer);
      });
    });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(path, resolve);
    });
    fs.chmodSync(path, admin ? 0o600 : 0o660);
    const stat = fs.lstatSync(path);
    this.servers.push({ server, path, dev: stat.dev, ino: stat.ino });
  }

  async start() {
    safeDirectory(this.directory);
    safeDirectory(join(this.directory, 'logs'));
    this.store.recoverInterrupted();
    try {
      await this.listen(this.socketPath, false);
      await this.listen(this.adminSocketPath, true);
    } catch (error) {
      await this.stop();
      throw error;
    }
    this.wake();
    return this;
  }

  wake() {
    if (this.running || this.stopping || this.fatal || this.recovering) return;
    this.running = Promise.resolve()
      .then(() => this.pump())
      .catch(() => {
        this.fatal = true;
      })
      .finally(() => {
        this.running = null;
        if (this.stopping || this.fatal || this.recovering) return;
        try {
          // FLAG: A submit can be persisted after pump observed an empty queue but before
          // this finalizer. Recheck once after releasing the worker identity to avoid stranding it.
          if (!this.store.hasUncertain() && this.policy().paused === false && this.store.next())
            this.wake();
        } catch {
          this.fatal = true;
        }
      });
  }

  async pump() {
    while (!this.stopping && !this.fatal && !this.recovering && !this.store.hasUncertain()) {
      if (this.policy().paused !== false) return;
      const next = this.store.next();
      if (!next) return;
      await this.perform(next);
    }
  }

  review(id, reasonCode) {
    const current = this.store.get(id);
    if (current && ['ADMITTING', 'EXECUTING'].includes(current.state)) {
      return this.store.transition(id, current.state, 'NEEDS_REVIEW', { reasonCode });
    }
    return current;
  }

  async observe(summary, phase, child) {
    let childIdentity;
    try {
      childIdentity = this.readIdentity(child.pid, summary.sourceSha);
      this.activeProcess = { phase, ...childIdentity };
      if (phase === 'EXECUTOR') this.store.setExecutor(summary.id, childIdentity);
    } catch {
      // A missing PID/start tick is an observation gap, never evidence that runtime stayed unchanged.
      terminate(child);
      child.on('error', () => {});
      fail('EXECUTOR_IDENTITY_UNKNOWN');
    }
    let heartbeatFailed = false;
    const heartbeat = setInterval(() => {
      try {
        this.store.heartbeat(summary.id);
      } catch {
        heartbeatFailed = true;
        terminate(child);
      }
    }, this.timings.heartbeatMs);
    try {
      const result = await observeReleaseChild(child, {
        summary,
        expectedEvent: phase === 'PREPARE' ? 'PREPARED' : 'READY',
        timeoutMs:
          phase === 'PREPARE' ? this.timings.prepareTimeoutMs : this.timings.executorTimeoutMs,
        killGraceMs: this.timings.killGraceMs,
        onReady: () => {
          this.checkPolicy(summary);
          this.store.transition(summary.id, 'ADMITTING', 'EXECUTING', { phase: 'RUNTIME' });
        },
      });
      return { ...result, heartbeatFailed };
    } finally {
      clearInterval(heartbeat);
      this.activeProcess = null;
    }
  }

  async perform(initial) {
    const id = initial.id;
    let descriptor;
    try {
      let summary = this.store.transition(id, 'QUEUED', 'ADMITTING', { phase: 'PREPARING' });
      try {
        this.checkPolicy(summary);
      } catch (error) {
        this.store.transition(id, 'ADMITTING', 'REJECTED', { reasonCode: error.code });
        return;
      }
      descriptor = logFile(join(this.directory, 'logs'), id);
      const prepared = await this.observe(
        summary,
        'PREPARE',
        this.spawnPrepare(summary, descriptor),
      );
      if (
        prepared.invalid ||
        prepared.deadlineExceeded ||
        prepared.heartbeatFailed ||
        !prepared.exitProved ||
        prepared.signal !== null
      ) {
        this.review(id, 'PREPARATION_UNCERTAIN');
        return;
      }
      if (
        prepared.event?.event === 'SAFE_REFUSAL' &&
        (prepared.exitCode === 86 ||
          (prepared.event.reasonCode === 'LOCK_BUSY' && prepared.exitCode === 75))
      ) {
        const reasonCode = prepared.event.reasonCode;
        this.store.transition(
          id,
          'ADMITTING',
          reasonCode === 'SUPERSEDED' ? 'SUPERSEDED' : 'REJECTED',
          { reasonCode },
        );
        return;
      }
      if (prepared.exitCode !== 0 || prepared.event?.event !== 'PREPARED') {
        this.review(id, 'PREPARATION_UNCERTAIN');
        return;
      }
      const lockDeadline = Date.now() + this.timings.lockDeadlineMs;
      while (true) {
        try {
          this.checkPolicy(summary);
        } catch (error) {
          this.store.transition(id, 'ADMITTING', 'REJECTED', { reasonCode: error.code });
          return;
        }
        const outcome = await this.observe(
          summary,
          'EXECUTOR',
          this.spawnExecutor(summary, descriptor),
        );
        if (
          outcome.invalid ||
          outcome.deadlineExceeded ||
          outcome.heartbeatFailed ||
          !outcome.exitProved ||
          outcome.signal !== null
        ) {
          this.review(id, 'EXECUTOR_UNCERTAIN');
          return;
        }
        if (
          outcome.event?.event === 'SAFE_REFUSAL' &&
          outcome.exitCode === 86 &&
          this.store.get(id)?.state === 'ADMITTING'
        ) {
          const reasonCode = outcome.event.reasonCode;
          this.store.transition(
            id,
            'ADMITTING',
            reasonCode === 'SUPERSEDED' ? 'SUPERSEDED' : 'REJECTED',
            { reasonCode },
          );
          return;
        }
        if (
          outcome.event?.event === 'SAFE_REFUSAL' &&
          outcome.event.reasonCode === 'LOCK_BUSY' &&
          outcome.exitCode === 75
        ) {
          summary = this.store.transition(id, 'ADMITTING', 'WAITING_LOCK', {
            reasonCode: 'LOCK_BUSY',
          });
          if (summary.attemptCount >= 16) {
            this.store.transition(id, 'WAITING_LOCK', 'REJECTED', {
              reasonCode: 'LOCK_WAIT_EXHAUSTED',
            });
            return;
          }
          if (Date.now() >= lockDeadline || this.stopping) {
            this.store.transition(id, 'WAITING_LOCK', 'ADMITTING', {
              reasonCode: 'PREVIOUS_CHILD_EXIT_PROVED',
            });
            this.store.transition(id, 'ADMITTING', 'REJECTED', {
              reasonCode: 'LOCK_WAIT_EXHAUSTED',
            });
            return;
          }
          await new Promise((resolve) =>
            setTimeout(resolve, Math.min(this.timings.retryDelayMs, lockDeadline - Date.now())),
          );
          summary = this.store.transition(id, 'WAITING_LOCK', 'ADMITTING', {
            reasonCode: 'PREVIOUS_CHILD_EXIT_PROVED',
            phase: 'PREPARED',
          });
          continue;
        }
        if (
          outcome.exitCode !== 0 ||
          outcome.event?.event !== 'READY' ||
          this.store.get(id)?.state !== 'EXECUTING'
        ) {
          this.review(id, 'EXECUTOR_UNCERTAIN');
          return;
        }
        // FLAG: Exit zero is insufficient; the locked independent final verifier must accept installed runtime.
        let accepted = false;
        const heartbeat = setInterval(() => {
          try {
            this.store.heartbeat(id);
          } catch {
            this.fatal = true;
          }
        }, this.timings.heartbeatMs);
        try {
          accepted = (await this.validateResult(this.store.get(id), descriptor)) === true;
        } finally {
          clearInterval(heartbeat);
        }
        if (!accepted || this.fatal) {
          this.review(id, 'RESULT_NOT_PROVED');
          return;
        }
        this.store.transition(id, 'EXECUTING', 'SUCCEEDED', { phase: 'COMPLETE' });
        return;
      }
    } catch {
      try {
        const reviewed = this.review(id, 'DAEMON_EXECUTION_FAILED');
        // FLAG: A failed transition can leave QUEUED/WAITING_LOCK state. Do not
        // retry that uncertain write in a tight loop or start another child.
        if (reviewed?.state !== 'NEEDS_REVIEW') this.fatal = true;
      } catch {
        this.fatal = true;
      }
    } finally {
      if (descriptor !== undefined) fs.closeSync(descriptor);
    }
  }

  async stop() {
    this.stopping = true;
    for (const socket of this.connections) socket.destroy();
    const servers = this.servers.splice(0);
    await Promise.all(servers.map(({ server }) => new Promise((resolve) => server.close(resolve))));
    if (this.running) await this.running;
    if (this.recoveryPromise) await this.recoveryPromise.catch(() => {});
    for (const { path, dev, ino } of servers) {
      try {
        const stat = fs.lstatSync(path);
        if (stat.isSocket() && stat.dev === dev && stat.ino === ino) fs.unlinkSync(path);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.length !== 2) process.exitCode = 1;
  else {
    const service = new ReleaseService();
    try {
      await service.start();
      for (const signal of ['SIGTERM', 'SIGINT'])
        process.once(signal, () => {
          service.stop().then(
            () => {
              process.exitCode = 0;
            },
            () => {
              process.exitCode = 1;
            },
          );
        });
    } catch {
      process.stderr.write('Release service unavailable.\n');
      process.exitCode = 1;
    }
  }
}
