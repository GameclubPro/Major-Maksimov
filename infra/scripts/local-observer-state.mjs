import * as fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { initialObserverModel, OBSERVER_REASONS } from './local-observer-model.mjs';
import {
  observerFailure,
  privateDirectory,
  readObserverPrivate,
  writeObserverPrivate,
} from './local-observer-files.mjs';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const exact = (value, keys) =>
  value !== null &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  Object.keys(value).sort().join(',') === [...keys].sort().join(',');
const timestamp = (value) =>
  typeof value === 'string' &&
  Number.isFinite(Date.parse(value)) &&
  new Date(Date.parse(value)).toISOString() === value;
const nullableTime = (value) => value === null || timestamp(value);
const integer = (value) => Number.isSafeInteger(value) && value >= 0;
const MODEL_KEYS = [
  'schemaVersion',
  'lastPollAt',
  'lastSuccessfulSampleAt',
  'lastSourceObservedAt',
  'degradedSince',
  'candidate',
  'incident',
  'events',
];
export function validateObserverModel(model) {
  const valid =
    exact(model, MODEL_KEYS) &&
    model.schemaVersion === 1 &&
    ['lastPollAt', 'lastSuccessfulSampleAt', 'lastSourceObservedAt', 'degradedSince'].every((key) =>
      nullableTime(model[key]),
    ) &&
    (model.candidate === null ||
      (exact(model.candidate, ['since', 'firstEvidenceAt', 'lastEvidenceAt']) &&
        Object.values(model.candidate).every(timestamp) &&
        Date.parse(model.candidate.lastEvidenceAt) >=
          Date.parse(model.candidate.firstEvidenceAt))) &&
    (model.incident === null ||
      (exact(model.incident, ['id', 'startedAt', 'problemEventId']) &&
        UUID.test(model.incident.id) &&
        UUID.test(model.incident.problemEventId) &&
        timestamp(model.incident.startedAt))) &&
    Array.isArray(model.events) &&
    model.events.length <= 256;
  if (!valid) observerFailure('OBSERVER_STATE_INVALID');
  const ids = new Set();
  for (const row of model.events) {
    const keys = ['id', 'kind', 'startedAt', 'observedAt', 'reasonCodes'];
    if (row?.event && Object.hasOwn(row.event, 'counts')) keys.push('counts');
    if (
      !exact(row, ['event', 'state', 'attempts', 'nextAttemptAt', 'outcomeCode']) ||
      !exact(row.event, keys) ||
      !UUID.test(row.event.id) ||
      ids.has(row.event.id) ||
      !['PROBLEM', 'RECOVERY'].includes(row.event.kind) ||
      !timestamp(row.event.startedAt) ||
      !timestamp(row.event.observedAt) ||
      !Array.isArray(row.event.reasonCodes) ||
      row.event.reasonCodes.length < 1 ||
      row.event.reasonCodes.length > OBSERVER_REASONS.length ||
      row.event.reasonCodes.some((code) => !OBSERVER_REASONS.includes(code)) ||
      new Set(row.event.reasonCodes).size !== row.event.reasonCodes.length ||
      !['PENDING', 'SENDING', 'SENT', 'REJECTED', 'UNCERTAIN', 'SUPPRESSED'].includes(row.state) ||
      !integer(row.attempts) ||
      row.attempts > 3 ||
      !nullableTime(row.nextAttemptAt) ||
      !(row.outcomeCode === null || /^[A-Z][A-Z0-9_]{0,63}$/u.test(row.outcomeCode)) ||
      (Object.hasOwn(row.event, 'counts') &&
        (!exact(row.event.counts, ['affectedBots', 'totalBots', 'pending', 'oldestPendingAgeMs']) ||
          !Object.values(row.event.counts).every(integer)))
    )
      observerFailure('OBSERVER_STATE_INVALID');
    ids.add(row.event.id);
  }
  if (
    model.incident &&
    !model.events.some(
      (row) => row.event.id === model.incident.problemEventId && row.event.kind === 'PROBLEM',
    )
  )
    observerFailure('OBSERVER_STATE_INVALID');
  return model;
}

export function readObserverState(directory, { floor = '/' } = {}) {
  privateDirectory(directory, { floor });
  try {
    const bytes = readObserverPrivate(join(directory, 'state.json'), { floor });
    return validateObserverModel(
      JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)),
    );
  } catch (error) {
    if (error.code === 'ENOENT') return initialObserverModel();
    observerFailure('OBSERVER_STATE_UNREADABLE');
  }
}

export class ObserverStore {
  constructor(directory, { floor = '/' } = {}) {
    this.directory = privateDirectory(directory, { floor });
    this.floor = floor;
    this.fd = undefined;
  }
  lock() {
    if (this.fd !== undefined) observerFailure('OBSERVER_ALREADY_LOCKED');
    const path = join(this.directory, 'observer.lock');
    const fd = fs.openSync(
      path,
      fs.constants.O_CREAT | fs.constants.O_RDWR | fs.constants.O_NOFOLLOW,
      0o600,
    );
    try {
      readObserverPrivate(path, { floor: this.floor, empty: true, maxBytes: 128 });
      const opened = fs.fstatSync(fd);
      const named = fs.lstatSync(path);
      if (opened.dev !== named.dev || opened.ino !== named.ino)
        observerFailure('OBSERVER_LOCK_CHANGED');
      const result = spawnSync('/usr/bin/flock', ['--exclusive', '--nonblock', '3'], {
        stdio: ['ignore', 'ignore', 'ignore', fd],
        timeout: 5000,
        env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' },
      });
      if (result.status !== 0) observerFailure('OBSERVER_BUSY');
      this.fd = fd;
    } finally {
      if (this.fd === undefined) fs.closeSync(fd);
    }
  }
  read() {
    if (this.fd === undefined) observerFailure('OBSERVER_LOCK_REQUIRED');
    return readObserverState(this.directory, { floor: this.floor });
  }
  write(model) {
    if (this.fd === undefined) observerFailure('OBSERVER_LOCK_REQUIRED');
    validateObserverModel(model);
    writeObserverPrivate(join(this.directory, 'state.json'), JSON.stringify(model) + '\n', {
      floor: this.floor,
    });
  }
  close() {
    if (this.fd !== undefined) fs.closeSync(this.fd);
    this.fd = undefined;
  }
}

export async function deliverObserverEvent(model, store, send, now = Date.now()) {
  const selected = model.events.find(
    (row) =>
      row.state === 'PENDING' ||
      (row.state === 'REJECTED' &&
        row.attempts < 3 &&
        row.nextAttemptAt !== null &&
        Date.parse(row.nextAttemptAt) <= now),
  );
  if (!selected) return model;
  const next = structuredClone(model);
  const row = next.events.find((item) => item.event.id === selected.event.id);
  row.state = 'SENDING';
  row.attempts += 1;
  row.nextAttemptAt = null;
  // FLAG: SMTP may accept before the process returns. Persist its uncertainty boundary first.
  store.write(next);
  let outcome;
  try {
    outcome = await send(row.event);
  } catch {
    outcome = { outcome: 'UNCERTAIN', reasonCode: 'SMTP_OUTCOME_UNKNOWN' };
  }
  if (
    !['SENT', 'REJECTED_BEFORE_SEND', 'UNCERTAIN'].includes(outcome?.outcome) ||
    !/^[A-Z][A-Z0-9_]{0,63}$/u.test(outcome?.reasonCode ?? '')
  )
    outcome = { outcome: 'UNCERTAIN', reasonCode: 'SMTP_OUTCOME_UNKNOWN' };
  row.state = outcome.outcome === 'REJECTED_BEFORE_SEND' ? 'REJECTED' : outcome.outcome;
  row.outcomeCode = outcome.reasonCode;
  if (row.state === 'REJECTED' && row.attempts < 3)
    row.nextAttemptAt = new Date(now + 300000).toISOString();
  store.write(next);
  return next;
}
