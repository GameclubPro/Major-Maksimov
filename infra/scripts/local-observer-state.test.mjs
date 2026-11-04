import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { initialObserverModel, recoverObserverModel } from './local-observer-model.mjs';
import {
  ObserverStore,
  deliverObserverEvent,
  readObserverState,
  validateObserverModel,
} from './local-observer-state.mjs';

const start = Date.parse('2026-11-04T06:00:00.000Z');
function pending() {
  const model = initialObserverModel();
  model.events.push({
    event: {
      id: '00000000-0000-4000-8000-000000000001',
      kind: 'PROBLEM',
      startedAt: new Date(start).toISOString(),
      observedAt: new Date(start + 120000).toISOString(),
      reasonCodes: ['OBSERVATION_LOST'],
    },
    state: 'PENDING',
    attempts: 0,
    nextAttemptAt: null,
    outcomeCode: null,
  });
  return model;
}
function fixture(t) {
  const directory = fs.mkdtempSync(join(tmpdir(), 'maxim-observer-state-'));
  const store = new ObserverStore(directory, { floor: directory });
  t.after(() => {
    store.close();
    fs.rmSync(directory, { force: true, recursive: true });
  });
  return { directory, store };
}

test('a real inherited flock prevents another process while atomic status reads remain available', (t) => {
  const { store, directory } = fixture(t);
  assert.throws(() => store.read(), { code: 'OBSERVER_LOCK_REQUIRED' });
  store.lock();
  const inode = fs.statSync(join(directory, 'observer.lock')).ino;
  store.write(pending());
  const script = `import { ObserverStore } from ${JSON.stringify(new URL('./local-observer-state.mjs', import.meta.url).href)};
    const s = new ObserverStore(process.argv[1], { floor: process.argv[1] });
    try { s.lock(); s.close(); process.stdout.write('LOCKED'); }
    catch (e) { process.stdout.write(e.code); process.exitCode = 2; }`;
  const child = () =>
    spawnSync(process.execPath, ['--input-type=module', '-e', script, directory], {
      encoding: 'utf8',
      timeout: 10000,
    });
  assert.deepEqual(readObserverState(directory, { floor: directory }), pending());
  const refused = child();
  assert.equal(refused.status, 2);
  assert.equal(refused.stdout, 'OBSERVER_BUSY');
  assert.equal(fs.statSync(join(directory, 'observer.lock')).ino, inode);
  store.close();
  assert.equal(child().status, 0);
});

test('SENDING is durable before SMTP and uncertain results survive restart without another attempt', async (t) => {
  const { store } = fixture(t);
  store.lock();
  let calls = 0;
  const model = await deliverObserverEvent(
    pending(),
    store,
    async (event) => {
      calls += 1;
      const saved = store.read();
      assert.equal(saved.events[0].event.id, event.id);
      assert.equal(saved.events[0].state, 'SENDING');
      assert.equal(saved.events[0].attempts, 1);
      throw new Error('sensitive provider response must never be saved');
    },
    start,
  );
  assert.equal(model.events[0].state, 'UNCERTAIN');
  assert.equal(model.events[0].outcomeCode, 'SMTP_OUTCOME_UNKNOWN');
  const recovered = recoverObserverModel(store.read());
  await deliverObserverEvent(
    recovered,
    store,
    async () => {
      calls += 1;
    },
    start + 3600000,
  );
  assert.equal(calls, 1);
  assert.doesNotMatch(JSON.stringify(store.read()), /sensitive provider/u);
});

test('a crash at the fsynced sending boundary is quarantined rather than replayed', async (t) => {
  const { store } = fixture(t);
  store.lock();
  const crashed = pending();
  crashed.events[0].state = 'SENDING';
  crashed.events[0].attempts = 1;
  store.write(crashed);
  const recovered = recoverObserverModel(store.read());
  assert.equal(recovered.events[0].state, 'UNCERTAIN');
  assert.equal(recovered.events[0].outcomeCode, 'OBSERVER_RESTART_DURING_SEND');
  let calls = 0;
  await deliverObserverEvent(
    recovered,
    store,
    async () => {
      calls += 1;
    },
    start,
  );
  assert.equal(calls, 0);
});

test('proved rejection retries only at the next deadline and stops after three attempts', async (t) => {
  const { store } = fixture(t);
  store.lock();
  let calls = 0;
  const send = async () => {
    calls += 1;
    return { outcome: 'REJECTED_BEFORE_SEND', reasonCode: 'SMTP_AUTH_REFUSED' };
  };
  let model = pending();
  for (let attempt = 0; attempt < 3; attempt += 1) {
    model = await deliverObserverEvent(model, store, send, start + attempt * 300000);
    assert.equal(model.events[0].attempts, attempt + 1);
    model = await deliverObserverEvent(model, store, send, start + attempt * 300000 + 1);
    assert.equal(calls, attempt + 1);
  }
  model = await deliverObserverEvent(model, store, send, start + 86400000);
  assert.equal(calls, 3);
  assert.equal(model.events[0].nextAttemptAt, null);
});

test('sent and invalid transport outcomes never trigger automatic replay', async (t) => {
  const { store } = fixture(t);
  store.lock();
  for (const result of [
    { outcome: 'SENT', reasonCode: 'SMTP_ACCEPTED' },
    { outcome: 'RETRY', reasonCode: 'untrusted raw response' },
  ]) {
    let calls = 0;
    const send = async () => {
      calls += 1;
      return result;
    };
    const model = await deliverObserverEvent(pending(), store, send, start);
    assert.equal(model.events[0].state, result.outcome === 'SENT' ? 'SENT' : 'UNCERTAIN');
    await deliverObserverEvent(model, store, send, start + 86400000);
    assert.equal(calls, 1);
  }
});

test('corrupt, duplicate, oversized and unsafe state fails closed without overwriting evidence', (t) => {
  const { store, directory } = fixture(t);
  store.lock();
  for (const mutate of [
    (model) => {
      model.events.push(structuredClone(model.events[0]));
    },
    (model) => {
      model.events[0].event.message = 'private message';
    },
    (model) => {
      model.events[0].event.counts = null;
    },
    (model) => {
      model.events[0].attempts = 4;
    },
    (model) => {
      model.incident = {
        id: model.events[0].event.id,
        startedAt: new Date(start).toISOString(),
        problemEventId: '00000000-0000-4000-8000-000000000002',
      };
    },
    (model) => {
      model.events = Array(257).fill(model.events[0]);
    },
  ]) {
    const model = pending();
    mutate(model);
    assert.throws(() => validateObserverModel(model), { code: 'OBSERVER_STATE_INVALID' });
  }
  const path = join(directory, 'state.json');
  fs.writeFileSync(path, '{incomplete', { mode: 0o600 });
  assert.throws(() => store.read(), { code: 'OBSERVER_STATE_UNREADABLE' });
  assert.equal(fs.readFileSync(path, 'utf8'), '{incomplete');
  fs.chmodSync(path, 0o644);
  assert.throws(() => store.write(pending()), { code: 'OBSERVER_UNSAFE_FILE' });
});

test('atomic replacement leaves private files and preserves an existing valid snapshot on write refusal', (t) => {
  const { store, directory } = fixture(t);
  store.lock();
  store.write(pending());
  const first = store.read();
  assert.equal(fs.statSync(join(directory, 'state.json')).mode & 0o777, 0o600);
  assert.throws(() => store.write({ ...first, events: 'invalid' }), {
    code: 'OBSERVER_STATE_INVALID',
  });
  assert.deepEqual(store.read(), first);
  store.write(initialObserverModel());
  assert.deepEqual(fs.readdirSync(directory).sort(), ['observer.lock', 'state.json']);
});
