import assert from 'node:assert/strict';
import test from 'node:test';
import { AdminApiError } from '../src/api-response';
import {
  startOverviewPolling,
  type OverviewPollEnvironment,
  type OverviewPollState,
} from '../src/runtime-overview-polling';

function harness() {
  let visible = true;
  let now = 0;
  let listener = () => {};
  const timers = new Map<object, { at: number; callback: () => void }>();
  const environment: OverviewPollEnvironment = {
    visible: () => visible,
    onVisibilityChange(callback) {
      listener = callback;
      return () => {
        listener = () => {};
      };
    },
    schedule(callback, delayMs) {
      const id = {};
      timers.set(id, { at: now + delayMs, callback });
      return () => {
        timers.delete(id);
      };
    },
  };
  const requests: Array<{
    signal: AbortSignal;
    resolve: (value: string) => void;
    reject: (error: Error) => void;
  }> = [];
  const states: Array<OverviewPollState<string>> = [];
  const poll = startOverviewPolling(
    (signal) =>
      new Promise<string>((resolve, reject) => {
        requests.push({ signal, resolve, reject });
      }),
    (state) => states.push(state),
    environment,
  );
  return {
    poll,
    requests,
    states,
    timers,
    async flush() {
      for (let i = 0; i < 4; i += 1) await Promise.resolve();
    },
    show(value: boolean) {
      visible = value;
      listener();
    },
    advance(ms: number) {
      now += ms;
      for (const [id, timer] of [...timers]) {
        if (timer.at <= now) {
          timers.delete(id);
          timer.callback();
        }
      }
    },
  };
}

test('polls visible overview every 15 seconds and stops all work on unmount', async () => {
  const h = harness();
  await h.flush();
  assert.equal(h.requests.length, 1);
  h.requests[0]!.resolve('first');
  await h.flush();
  assert.equal(h.states.at(-1)?.snapshot, 'first');
  h.advance(14_999);
  await h.flush();
  assert.equal(h.requests.length, 1);
  h.advance(1);
  await h.flush();
  assert.equal(h.requests.length, 2);
  h.poll.stop();
  assert.equal(h.requests[1]!.signal.aborted, true);
  h.requests[1]!.resolve('late');
  h.advance(120_000);
  await h.flush();
  assert.equal(h.requests.length, 2);
  assert.equal(h.states.at(-1)?.snapshot, 'first');
  assert.equal(h.timers.size, 0);
});

test('hidden tabs abort reads, omit polling and fetch fresh evidence on return', async () => {
  const h = harness();
  await h.flush();
  h.show(false);
  assert.equal(h.requests[0]!.signal.aborted, true);
  h.requests[0]!.resolve('hidden late evidence');
  h.advance(90_000);
  await h.flush();
  assert.equal(h.requests.length, 1);
  assert.equal(h.states.at(-1)?.snapshot, null);
  h.show(true);
  await h.flush();
  assert.equal(h.requests.length, 2);
  h.requests[1]!.resolve('returned');
  await h.flush();
  assert.equal(h.states.at(-1)?.snapshot, 'returned');
  h.poll.stop();
});

test('denied access removes previous evidence and prevents timer and manual reads', async () => {
  for (const status of [401, 403]) {
    const h = harness();
    await h.flush();
    h.requests[0]!.resolve('private evidence');
    await h.flush();
    h.poll.refresh();
    await h.flush();
    h.requests[1]!.reject(new AdminApiError('raw upstream text', status));
    await h.flush();
    assert.deepEqual(h.states.at(-1), {
      snapshot: null,
      loading: false,
      denied: true,
      error: 'Нет доступа к наблюдениям.',
    });
    h.poll.refresh();
    h.show(false);
    h.show(true);
    h.advance(180_000);
    await h.flush();
    assert.equal(h.requests.length, 2);
    assert.equal(h.timers.size, 0);
    h.poll.stop();
  }
});

test('failures retain an explicitly stale snapshot, back off, and never render upstream errors', async () => {
  const h = harness();
  await h.flush();
  h.requests[0]!.resolve('last successful');
  await h.flush();
  h.poll.refresh();
  await h.flush();
  h.requests[1]!.reject(new Error('secret token'));
  await h.flush();
  assert.equal(h.states.at(-1)?.snapshot, 'last successful');
  assert.match(h.states.at(-1)!.error, /предыдущий снимок/);
  assert.doesNotMatch(JSON.stringify(h.states), /secret token/);
  h.advance(29_999);
  await h.flush();
  assert.equal(h.requests.length, 2);
  h.advance(1);
  await h.flush();
  assert.equal(h.requests.length, 3);
  h.poll.stop();
});

test('timed out and superseded requests cannot replace the next successful snapshot', async () => {
  const h = harness();
  await h.flush();
  h.advance(12_000);
  assert.equal(h.requests[0]!.signal.aborted, true);
  h.poll.refresh();
  await h.flush();
  h.requests[1]!.resolve('new scope evidence');
  await h.flush();
  h.requests[0]!.resolve('old late evidence');
  await h.flush();
  assert.equal(h.states.at(-1)?.snapshot, 'new scope evidence');
  h.poll.stop();
});
