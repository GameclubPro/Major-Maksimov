import assert from 'node:assert/strict';
import test from 'node:test';
import { safetyDeskOverviewResponseSchema as schema } from '../../packages/contracts/src/safety-desk-overview.ts';
import { readObserverSnapshot, runObserver, observerStatus } from './local-observer.mjs';
import { initialObserverModel } from './local-observer-model.mjs';
import { makeObserverSnapshot } from './local-observer-test-fixture.mjs';

const start = Date.parse('2026-11-04T06:00:00.000Z');
const config = {
  directory: '/fixture-private-config',
  overviewUrl: 'https://admin.major-maksimov.ru/api/v1/safety-desk/runtime-observer/overview',
  reader: {
    token: 'a'.repeat(64),
    basicUsername: 'maxim-observer',
    basicPassword: 'fixture-password',
  },
};
function pendingModel() {
  const model = initialObserverModel();
  const event = {
    id: '00000000-0000-4000-8000-000000000001',
    kind: 'PROBLEM',
    startedAt: new Date(start - 120000).toISOString(),
    observedAt: new Date(start).toISOString(),
    reasonCodes: ['RECEIPT_DELAY'],
  };
  model.incident = {
    id: '00000000-0000-4000-8000-000000000002',
    startedAt: event.startedAt,
    problemEventId: event.id,
  };
  model.events.push({
    event,
    state: 'PENDING',
    attempts: 0,
    nextAttemptAt: null,
    outcomeCode: null,
  });
  return model;
}
function memoryStore(model = initialObserverModel()) {
  return {
    model,
    closed: false,
    locked: false,
    lock() {
      this.locked = true;
    },
    read() {
      return structuredClone(this.model);
    },
    write(value) {
      this.model = structuredClone(value);
    },
    close() {
      this.closed = true;
    },
  };
}
function criticalSnapshot(now) {
  const snapshot = makeObserverSnapshot(now);
  snapshot.receipts.value = {
    countLowerBound: 1,
    sampleComplete: true,
    oldestAgeMs: 45000,
    ageBasis: 'receipt_created',
  };
  return snapshot;
}

test('HTTP reader parses the real contract, uses one fixed credential channel and disables redirects', async () => {
  const snapshot = makeObserverSnapshot(start);
  const result = await readObserverSnapshot(config, schema, {
    fetcher: async (url, options) => {
      assert.equal(url, config.overviewUrl);
      assert.equal(options.redirect, 'error');
      assert.equal(options.headers['x-runtime-overview-reader-token'], config.reader.token);
      assert.equal(
        options.headers.authorization,
        'Basic ' + Buffer.from('maxim-observer:fixture-password').toString('base64'),
      );
      return new Response(JSON.stringify(snapshot), {
        headers: { 'content-type': 'application/json; charset=utf-8' },
      });
    },
  });
  assert.deepEqual(result, schema.parse(snapshot));
});

test('HTTP failures, oversized, malformed and history-bearing evidence never turn into healthy samples', async () => {
  const withHistory = makeObserverSnapshot(start);
  withHistory.history = {
    ...withHistory.history,
    availability: 'FRESH',
    observedAt: new Date(start).toISOString(),
  };
  for (const response of [
    new Response('denied', { status: 403 }),
    new Response('{}', { headers: { 'content-type': 'text/html' } }),
    new Response('x'.repeat(250001), { headers: { 'content-type': 'application/json' } }),
    new Response('{broken', { headers: { 'content-type': 'application/json' } }),
    new Response(
      JSON.stringify({ ...makeObserverSnapshot(start), privateMessage: 'never retained' }),
      { headers: { 'content-type': 'application/json' } },
    ),
    new Response(JSON.stringify(withHistory), { headers: { 'content-type': 'application/json' } }),
  ]) {
    await assert.rejects(readObserverSnapshot(config, schema, { fetcher: async () => response }), {
      code: 'OBSERVER_SAMPLE_UNAVAILABLE',
    });
  }
});

test('HTTP deadline and shutdown abort an outstanding sample without leaving a timer', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let requestedSignal;
  const fetcher = async (_url, { signal }) => {
    requestedSignal = signal;
    return new Promise((_resolve, reject) => {
      if (signal.aborted) reject(signal.reason);
      else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
  };
  const deadline = assert.rejects(readObserverSnapshot(config, schema, { fetcher }), {
    code: 'OBSERVER_SAMPLE_UNAVAILABLE',
  });
  t.mock.timers.tick(10000);
  await deadline;
  assert.equal(requestedSignal.aborted, true);
  const controller = new AbortController();
  const stopped = assert.rejects(
    readObserverSnapshot(config, schema, { fetcher, signal: controller.signal }),
    { code: 'OBSERVER_SAMPLE_UNAVAILABLE' },
  );
  controller.abort();
  await stopped;
  assert.equal(requestedSignal.aborted, true);
});

test('shutdown during a fetch cannot create an event or begin a new SMTP attempt', async () => {
  const controller = new AbortController();
  const store = memoryStore(pendingModel());
  let sent = 0;
  await runObserver(config, schema, {
    signal: controller.signal,
    store,
    clock: () => start,
    readSnapshot: async (_config, _schema, { signal }) => {
      assert.equal(signal, controller.signal);
      controller.abort();
      return criticalSnapshot(start);
    },
    readConfiguration: () => ({ smtpConfigured: true, smtp: {} }),
    sendMail: async () => {
      sent += 1;
    },
  });
  assert.equal(sent, 0);
  assert.equal(store.model.events[0].attempts, 0);
  assert.equal(store.model.lastPollAt, null);
  assert.equal(store.closed, true);
});

test('missing SMTP configuration preserves pending delivery beyond retry budgets and sends once after configuration recovers', async () => {
  const controller = new AbortController();
  const store = memoryStore(pendingModel());
  let now = start;
  let polls = 0;
  let sent = 0;
  await runObserver(config, schema, {
    signal: controller.signal,
    store,
    clock: () => now,
    readSnapshot: async () => {
      polls += 1;
      return criticalSnapshot(now);
    },
    readConfiguration: () => ({ smtpConfigured: polls > 45, smtp: { password: 'fixture' } }),
    sendMail: async () => {
      sent += 1;
      assert.equal(store.model.events[0].state, 'SENDING');
      assert.equal(store.model.events[0].attempts, 1);
      return { outcome: 'SENT', reasonCode: 'SMTP_ACCEPTED' };
    },
    pause: async () => {
      now += 15000;
      if (polls >= 48) controller.abort();
    },
  });
  assert.equal(sent, 1);
  assert.equal(store.model.events.length, 1);
  assert.equal(store.model.events[0].state, 'SENT');
  assert.equal(store.model.events[0].attempts, 1);
  assert.equal(store.closed, true);
});

test('missing observations remain missing with a fresh heartbeat and later report an observation incident', async () => {
  const controller = new AbortController();
  const store = memoryStore();
  let now = start;
  let polls = 0;
  await runObserver(config, schema, {
    signal: controller.signal,
    store,
    clock: () => now,
    readSnapshot: async () => {
      polls += 1;
      throw new Error('private fetch details');
    },
    readConfiguration: () => ({ smtpConfigured: false }),
    pause: async () => {
      now += 15000;
      if (polls >= 10) controller.abort();
    },
  });
  const status = observerStatus(store.model, now);
  assert.equal(status.heartbeatFresh, true);
  assert.equal(status.lastSuccessfulSampleAt, null);
  assert.equal(status.incidentActive, true);
  assert.deepEqual(store.model.events[0].event.reasonCodes, ['OBSERVATION_LOST']);
  assert.doesNotMatch(JSON.stringify(store.model), /private fetch/u);
  assert.equal(observerStatus(store.model, now + 60000).heartbeatFresh, false);
});

test('an existing SMTP attempt finishes its persisted outcome during graceful shutdown', async () => {
  const controller = new AbortController();
  const store = memoryStore(pendingModel());
  let sent = 0;
  await runObserver(config, schema, {
    signal: controller.signal,
    store,
    clock: () => start,
    readSnapshot: async () => criticalSnapshot(start),
    readConfiguration: () => ({ smtpConfigured: true, smtp: {} }),
    sendMail: async () => {
      sent += 1;
      controller.abort();
      return { outcome: 'SENT', reasonCode: 'SMTP_ACCEPTED' };
    },
  });
  assert.equal(sent, 1);
  assert.equal(store.model.events[0].state, 'SENT');
  assert.equal(store.closed, true);
});
