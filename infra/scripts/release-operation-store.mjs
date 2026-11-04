import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import { join, resolve } from 'node:path';
import { validatePreloadRequest } from './registry-preload-host.mjs';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const BOOT_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;
const SHA = /^[a-f0-9]{40}$/u;
const HASH = /^[a-f0-9]{64}$/u;
const CODE = /^[A-Z][A-Z0-9_]{0,63}$/u;
const COMPONENTS = new Set(['api', 'miniapp', 'admin', 'eraser']);
const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_STATE_BYTES = 18 * 1024 * 1024;
const MAX_PENDING = 32;
const MAX_RECORDS = 256;
const ACTIVE = new Set(['QUEUED', 'ADMITTING', 'WAITING_LOCK', 'EXECUTING']);
const TRANSITIONS = {
  QUEUED: ['ADMITTING'],
  WAITING_LOCK: ['ADMITTING'],
  ADMITTING: ['WAITING_LOCK', 'EXECUTING', 'REJECTED', 'SUPERSEDED', 'NEEDS_REVIEW'],
  EXECUTING: ['SUCCEEDED', 'NEEDS_REVIEW'],
  SUCCEEDED: [],
  REJECTED: [],
  SUPERSEDED: [],
  NEEDS_REVIEW: [],
};
const REQUEST_KEYS = [
  'schemaVersion',
  'id',
  'sourceSha',
  'expectedManifestSha256',
  'trigger',
  'images',
];
const RECORD_KEYS = [
  'request',
  'requestHash',
  'state',
  'phase',
  'createdAt',
  'updatedAt',
  'lastHeartbeatAt',
  'createdSequence',
  'sequence',
  'reasonCode',
  'executor',
  'attempts',
  'resolution',
];

function fail(code) {
  const error = new Error(`Release operation ${code}.`);
  error.code = code;
  throw error;
}

function exactKeys(value, required, optional = []) {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
    required.some((key) => !Object.hasOwn(value, key)) ||
    Object.keys(value).some((key) => !required.includes(key) && !optional.includes(key)) ||
    Object.getOwnPropertySymbols(value).length > 0 ||
    Object.values(Object.getOwnPropertyDescriptors(value)).some((entry) => !('value' in entry))
  )
    fail('INVALID_SHAPE');
}

function canonical(value, depth = 0) {
  if (depth > 32) fail('INVALID_JSON');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map((entry) => canonical(entry, depth + 1));
  if (value && typeof value === 'object') {
    exactKeys(value, [], Object.keys(value));
    const result = Object.create(null);
    for (const key of Object.keys(value).sort()) result[key] = canonical(value[key], depth + 1);
    return result;
  }
  fail('INVALID_JSON');
}

function json(value) {
  try {
    return JSON.stringify(canonical(value));
  } catch {
    fail('INVALID_JSON');
  }
}

function timestamp(value) {
  return (
    typeof value === 'string' &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}

function matches(pattern, value) {
  return typeof value === 'string' && pattern.test(value);
}

export function validateReleaseRequest(request) {
  exactKeys(request, REQUEST_KEYS);
  if (
    request.schemaVersion !== 1 ||
    !matches(UUID, request.id) ||
    !matches(SHA, request.sourceSha) ||
    !(request.expectedManifestSha256 === null || matches(HASH, request.expectedManifestSha256)) ||
    !['operator', 'automatic'].includes(request.trigger) ||
    !Array.isArray(request.images) ||
    request.images.length > COMPONENTS.size
  )
    fail('INVALID_REQUEST');
  const components = new Set();
  for (const proof of request.images) {
    exactKeys(proof, ['record', 'artifact', 'verifiedAt']);
    const component = proof.record?.component;
    if (!COMPONENTS.has(component) || components.has(component) || !timestamp(proof.verifiedAt))
      fail('INVALID_IMAGE_PROOF');
    try {
      // FLAG: This checks historical proof shape only; admission must freshly verify CI and provenance.
      validatePreloadRequest(
        { ...proof, schemaVersion: 1 },
        {
          sha: request.sourceSha,
          component,
          now: Date.parse(proof.verifiedAt),
        },
      );
    } catch {
      fail('INVALID_IMAGE_PROOF');
    }
    components.add(component);
  }
  const encoded = json(request);
  if (Buffer.byteLength(encoded) > MAX_REQUEST_BYTES) fail('REQUEST_TOO_LARGE');
  return JSON.parse(encoded);
}

export function requestHash(request) {
  return createHash('sha256')
    .update(json(validateReleaseRequest(request)))
    .digest('hex');
}

function executorIdentity(identity, sourceSha) {
  exactKeys(identity, ['pid', 'sourceSha', 'startedAt', 'bootId', 'startTicks']);
  if (
    !Number.isSafeInteger(identity.pid) ||
    identity.pid < 1 ||
    identity.pid > 2 ** 31 - 1 ||
    identity.sourceSha !== sourceSha ||
    !timestamp(identity.startedAt) ||
    !matches(BOOT_ID, identity.bootId) ||
    typeof identity.startTicks !== 'string' ||
    !/^[0-9]{1,24}$/u.test(identity.startTicks)
  )
    fail('INVALID_EXECUTOR');
  return JSON.parse(json(identity));
}

function reviewResolution(value) {
  exactKeys(value, ['kind', 'evidenceSha256', 'manifestSha256']);
  if (
    !['RECOVERED', 'UNCHANGED'].includes(value.kind) ||
    !matches(HASH, value.evidenceSha256) ||
    !matches(HASH, value.manifestSha256)
  )
    fail('INVALID_RESOLUTION');
  return JSON.parse(json(value));
}

function validateState(state) {
  exactKeys(state, ['schemaVersion', 'sequence', 'operations']);
  if (
    state.schemaVersion !== 1 ||
    !Number.isSafeInteger(state.sequence) ||
    state.sequence < 0 ||
    !Array.isArray(state.operations) ||
    state.operations.length > MAX_RECORDS
  )
    fail('INVALID_STATE');
  const ids = new Set();
  const revisions = new Set();
  let previousSequence = 0;
  for (const record of state.operations) {
    exactKeys(record, RECORD_KEYS);
    const request = validateReleaseRequest(record.request);
    if (
      ids.has(request.id) ||
      record.requestHash !== requestHash(request) ||
      !Object.hasOwn(TRANSITIONS, record.state) ||
      !matches(CODE, record.phase) ||
      !timestamp(record.createdAt) ||
      !timestamp(record.updatedAt) ||
      !(record.lastHeartbeatAt === null || timestamp(record.lastHeartbeatAt)) ||
      Date.parse(record.updatedAt) < Date.parse(record.createdAt) ||
      (record.lastHeartbeatAt !== null &&
        (Date.parse(record.lastHeartbeatAt) < Date.parse(record.createdAt) ||
          Date.parse(record.lastHeartbeatAt) > Date.parse(record.updatedAt))) ||
      !Number.isSafeInteger(record.createdSequence) ||
      record.createdSequence <= previousSequence ||
      !Number.isSafeInteger(record.sequence) ||
      record.sequence < record.createdSequence ||
      record.sequence > state.sequence ||
      revisions.has(record.sequence) ||
      !(record.reasonCode === null || matches(CODE, record.reasonCode))
    )
      fail('INVALID_STATE');
    if (record.executor !== null) {
      executorIdentity(record.executor, request.sourceSha);
      if (record.state === 'QUEUED') fail('INVALID_STATE');
    }
    if (!Array.isArray(record.attempts) || record.attempts.length > 15) fail('INVALID_STATE');
    for (const attempt of record.attempts) {
      exactKeys(attempt, ['executor', 'endedAt']);
      executorIdentity(attempt.executor, request.sourceSha);
      if (
        !timestamp(attempt.endedAt) ||
        Date.parse(attempt.endedAt) < Date.parse(record.createdAt) ||
        Date.parse(attempt.endedAt) > Date.parse(record.updatedAt)
      )
        fail('INVALID_STATE');
    }
    if (record.state === 'QUEUED' && record.attempts.length !== 0) fail('INVALID_STATE');
    if (record.resolution !== null) {
      exactKeys(record.resolution, ['kind', 'evidenceSha256', 'manifestSha256', 'resolvedAt']);
      const { resolvedAt, ...resolution } = record.resolution;
      reviewResolution(resolution);
      if (
        record.state !== 'NEEDS_REVIEW' ||
        !timestamp(resolvedAt) ||
        Date.parse(resolvedAt) < Date.parse(record.createdAt) ||
        Date.parse(resolvedAt) > Date.parse(record.updatedAt)
      )
        fail('INVALID_STATE');
    }
    previousSequence = record.createdSequence;
    ids.add(request.id);
    revisions.add(record.sequence);
  }
  if (
    state.operations.filter((record) => ACTIVE.has(record.state)).length > MAX_PENDING ||
    (state.operations.length === 0
      ? state.sequence !== 0
      : Math.max(...revisions) !== state.sequence)
  )
    fail('INVALID_STATE');
  return state;
}

function summary(record) {
  if (!record) return null;
  return structuredClone({
    id: record.request.id,
    requestHash: record.requestHash,
    sourceSha: record.request.sourceSha,
    expectedManifestSha256: record.request.expectedManifestSha256,
    trigger: record.request.trigger,
    components: record.request.images.map((proof) => proof.record.component),
    state: record.state,
    phase: record.phase,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    lastHeartbeatAt: record.lastHeartbeatAt,
    createdSequence: record.createdSequence,
    sequence: record.sequence,
    reasonCode: record.reasonCode,
    executor: record.executor,
    attemptCount: record.attempts.length + 1,
    resolution:
      record.resolution === null
        ? null
        : { kind: record.resolution.kind, resolvedAt: record.resolution.resolvedAt },
  });
}

export class OperationStore {
  #directory;
  #path;
  #now;
  #uid;
  #io;
  #failed = false;

  constructor({ directory, now = Date.now, uid = process.getuid(), fileSystem = fs }) {
    if (
      typeof directory !== 'string' ||
      !directory ||
      typeof now !== 'function' ||
      !Number.isSafeInteger(uid) ||
      uid < 0
    )
      fail('INVALID_OPTIONS');
    this.#directory = resolve(directory);
    this.#path = join(this.#directory, 'state.json');
    this.#now = now;
    this.#uid = uid;
    this.#io = fileSystem;
    try {
      this.#io.mkdirSync(this.#directory, { mode: 0o700 });
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    this.#assertDirectory();
    if (this.#exists()) this.#read();
    else this.#write({ schemaVersion: 1, sequence: 0, operations: [] });
  }

  #assertDirectory() {
    const stat = this.#io.lstatSync(this.#directory);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      stat.mode & 0o022 ||
      ![0, this.#uid].includes(stat.uid)
    )
      fail('UNSAFE_DIRECTORY');
    return stat;
  }

  #exists() {
    try {
      this.#io.lstatSync(this.#path);
      return true;
    } catch (error) {
      if (error.code === 'ENOENT') return false;
      throw error;
    }
  }

  #assertFile(path) {
    const stat = this.#io.lstatSync(path);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.nlink !== 1 ||
      (stat.mode & 0o777) !== 0o600 ||
      ![0, this.#uid].includes(stat.uid) ||
      stat.size < 1 ||
      stat.size > MAX_STATE_BYTES
    )
      fail('UNSAFE_STATE_FILE');
    return stat;
  }

  #read() {
    if (this.#failed) fail('STORE_RESTART_REQUIRED');
    this.#assertDirectory();
    const before = this.#assertFile(this.#path);
    const descriptor = this.#io.openSync(
      this.#path,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
    );
    try {
      const opened = this.#io.fstatSync(descriptor);
      if (opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size)
        fail('STATE_CHANGED');
      const buffer = Buffer.alloc(before.size + 1);
      let bytes = 0;
      while (bytes < buffer.length) {
        const count = this.#io.readSync(descriptor, buffer, bytes, buffer.length - bytes, null);
        if (count === 0) break;
        bytes += count;
      }
      if (bytes !== before.size) fail('STATE_CHANGED');
      let state;
      try {
        state = JSON.parse(buffer.subarray(0, bytes).toString('utf8'));
      } catch {
        fail('INVALID_STATE');
      }
      return validateState(state);
    } finally {
      this.#io.closeSync(descriptor);
    }
  }

  #write(state) {
    if (this.#failed) fail('STORE_RESTART_REQUIRED');
    validateState(state);
    const encoded = `${JSON.stringify(state)}\n`;
    if (Buffer.byteLength(encoded) > MAX_STATE_BYTES) fail('STATE_TOO_LARGE');
    const before = this.#assertDirectory();
    if (this.#exists()) this.#assertFile(this.#path);
    const directoryDescriptor = this.#io.openSync(
      this.#directory,
      fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW,
    );
    const temporary = join(this.#directory, `.state-${randomUUID()}.tmp`);
    let descriptor;
    try {
      const opened = this.#io.fstatSync(directoryDescriptor);
      if (opened.dev !== before.dev || opened.ino !== before.ino) fail('DIRECTORY_CHANGED');
      descriptor = this.#io.openSync(
        temporary,
        fs.constants.O_WRONLY |
          fs.constants.O_CREAT |
          fs.constants.O_EXCL |
          fs.constants.O_NOFOLLOW,
        0o600,
      );
      this.#io.writeFileSync(descriptor, encoded);
      this.#io.fsyncSync(descriptor);
      this.#io.closeSync(descriptor);
      descriptor = undefined;
      this.#assertDirectory();
      if (this.#exists()) this.#assertFile(this.#path);
      // FLAG: A caller sees success only after both the atomic replacement and directory fsync.
      this.#io.renameSync(temporary, this.#path);
      this.#io.fsyncSync(directoryDescriptor);
    } catch (error) {
      // FLAG: A failed commit can be uncertain after rename; do not perform another mutation in this daemon.
      this.#failed = true;
      throw error;
    } finally {
      if (descriptor !== undefined) this.#io.closeSync(descriptor);
      this.#io.closeSync(directoryDescriptor);
      this.#io.rmSync(temporary, { force: true });
    }
  }

  #time(record = null) {
    const value = this.#now();
    const parsed = value instanceof Date ? value.getTime() : value;
    if (!Number.isFinite(parsed)) fail('INVALID_CLOCK');
    const time = new Date(parsed).toISOString();
    if (record && Date.parse(time) < Date.parse(record.updatedAt)) fail('CLOCK_MOVED_BACKWARDS');
    return time;
  }

  #record(state, id) {
    if (!matches(UUID, id)) fail('INVALID_ID');
    const record = state.operations.find((operation) => operation.request.id === id);
    if (!record) fail('NOT_FOUND');
    return record;
  }

  #commitRecord(state, record) {
    if (state.sequence === Number.MAX_SAFE_INTEGER) fail('SEQUENCE_EXHAUSTED');
    record.updatedAt = this.#time(record);
    record.sequence = ++state.sequence;
    this.#write(state);
    return summary(record);
  }

  submit(input) {
    const request = validateReleaseRequest(input);
    const hash = requestHash(request);
    const state = this.#read();
    const existing = state.operations.find((operation) => operation.request.id === request.id);
    if (existing) {
      if (existing.requestHash !== hash) fail('ID_CONFLICT');
      return summary(existing);
    }
    if (
      state.operations.length >= MAX_RECORDS ||
      state.operations.filter((record) => ACTIVE.has(record.state)).length >= MAX_PENDING
    )
      fail('CAPACITY_REACHED');
    if (this.#uncertain(state)) fail('UNRESOLVED_REVIEW');
    const createdAt = this.#time();
    if (state.sequence === Number.MAX_SAFE_INTEGER) fail('SEQUENCE_EXHAUSTED');
    const record = {
      request,
      requestHash: hash,
      state: 'QUEUED',
      phase: 'QUEUED',
      createdAt,
      updatedAt: createdAt,
      lastHeartbeatAt: null,
      createdSequence: ++state.sequence,
      sequence: state.sequence,
      reasonCode: null,
      executor: null,
      attempts: [],
      resolution: null,
    };
    state.operations.push(record);
    this.#write(state);
    return summary(record);
  }

  get(id) {
    if (!matches(UUID, id)) fail('INVALID_ID');
    return summary(this.#read().operations.find((record) => record.request.id === id));
  }

  list({ limit = 32 } = {}) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 32) fail('INVALID_LIMIT');
    return this.#read().operations.slice(-limit).reverse().map(summary);
  }

  next() {
    const state = this.#read();
    return this.#uncertain(state)
      ? null
      : summary(
          state.operations.find((record) => ['QUEUED', 'WAITING_LOCK'].includes(record.state)),
        );
  }

  readRequest(id) {
    return structuredClone(this.#record(this.#read(), id).request);
  }

  transition(id, expectedState, nextState, details = {}) {
    exactKeys(details, [], ['reasonCode', 'phase']);
    if (
      (details.reasonCode !== undefined && !matches(CODE, details.reasonCode)) ||
      (details.phase !== undefined && !matches(CODE, details.phase))
    )
      fail('INVALID_DETAILS');
    const state = this.#read();
    const record = this.#record(state, id);
    if (record.state !== expectedState) fail('STALE_STATE');
    const exhaustedRejection =
      record.state === 'WAITING_LOCK' &&
      nextState === 'REJECTED' &&
      details.reasonCode === 'LOCK_WAIT_EXHAUSTED' &&
      record.attempts.length === 15;
    if (!TRANSITIONS[record.state].includes(nextState) && !exhaustedRejection)
      fail('INVALID_TRANSITION');
    if (nextState === 'ADMITTING' && this.#uncertain(state)) fail('UNRESOLVED_REVIEW');
    if (record.state === 'WAITING_LOCK' && nextState === 'ADMITTING' && record.executor !== null) {
      if (details.reasonCode !== 'PREVIOUS_CHILD_EXIT_PROVED') fail('PREVIOUS_EXECUTOR_UNPROVED');
      if (record.attempts.length >= 15) fail('ATTEMPT_LIMIT');
      // FLAG: Only the daemon can supply this proof code, after its exact child exited with SAFE_REFUSAL.
      record.attempts.push({ executor: record.executor, endedAt: this.#time(record) });
      record.executor = null;
    }
    record.state = nextState;
    record.phase = details.phase ?? nextState;
    record.reasonCode = details.reasonCode ?? null;
    return this.#commitRecord(state, record);
  }

  setExecutor(id, identity) {
    const state = this.#read();
    const record = this.#record(state, id);
    if (!['ADMITTING', 'EXECUTING'].includes(record.state)) fail('INVALID_EXECUTOR_STATE');
    const validated = executorIdentity(identity, record.request.sourceSha);
    if (record.executor !== null) {
      if (json(record.executor) !== json(validated)) fail('EXECUTOR_CONFLICT');
      return summary(record);
    }
    record.executor = validated;
    return this.#commitRecord(state, record);
  }

  heartbeat(id) {
    const state = this.#read();
    const record = this.#record(state, id);
    if (!ACTIVE.has(record.state) || record.state === 'QUEUED') fail('INVALID_HEARTBEAT_STATE');
    record.lastHeartbeatAt = this.#time(record);
    return this.#commitRecord(state, record);
  }

  recoverInterrupted() {
    const state = this.#read();
    const recovered = [];
    for (const record of state.operations) {
      if (!['ADMITTING', 'WAITING_LOCK', 'EXECUTING'].includes(record.state)) continue;
      record.state = 'NEEDS_REVIEW';
      record.phase = 'NEEDS_REVIEW';
      record.reasonCode = 'DAEMON_RESTART';
      record.updatedAt = this.#time(record);
      if (state.sequence === Number.MAX_SAFE_INTEGER) fail('SEQUENCE_EXHAUSTED');
      record.sequence = ++state.sequence;
      recovered.push(record);
    }
    if (recovered.length > 0) this.#write(state);
    return recovered.map(summary);
  }

  #uncertain(state) {
    return state.operations.some(
      (record) => record.state === 'NEEDS_REVIEW' && record.resolution === null,
    );
  }

  hasUncertain() {
    return this.#uncertain(this.#read());
  }

  resolveReview(id, resolution) {
    const validated = reviewResolution(resolution);
    const state = this.#read();
    const record = this.#record(state, id);
    if (record.state !== 'NEEDS_REVIEW') fail('INVALID_RESOLUTION_STATE');
    if (record.resolution !== null) {
      const existing = {
        kind: record.resolution.kind,
        evidenceSha256: record.resolution.evidenceSha256,
        manifestSha256: record.resolution.manifestSha256,
      };
      if (json(existing) !== json(validated)) fail('RESOLUTION_CONFLICT');
      return summary(record);
    }
    record.resolution = { ...validated, resolvedAt: this.#time(record) };
    return this.#commitRecord(state, record);
  }
}
