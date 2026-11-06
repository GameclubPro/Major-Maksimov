import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter, once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import Redis from 'ioredis';
import { Queue, Worker } from 'bullmq';
import queuesModule from './source-abandonment-session-queues.cjs';
import stock from './webhook-queue-rollout-control.cjs';

const {
  CONNECTION_OPTIONS,
  QUEUE_LIMITS,
  isSupportedSourceAbandonmentQueueInventory,
  buildQueueReadScripts,
  createQueueClient,
  createSessionQueueAdapters,
} = queuesModule;
const legacyQueueNames = [
  ...stock.WEBHOOK_QUEUE_NAMES,
  ...Array.from({ length: 29 }, (_, i) => `session-aux-${i}`),
];
const queueNames = [...legacyQueueNames, 'admin-manual-commands'];
const nonce = '11111111-1111-4111-8111-111111111111';
const connectionName = `maxim-source-session:${nonce}`;
const manifest = {
  version: 1,
  sessionId: '22222222-2222-4222-8222-222222222222',
  controllerNonce: nonce,
  registryDigest: 'a'.repeat(64),
};
const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

function fakeTransport(names = queueNames) {
  const redis = new EventEmitter();
  redis.status = 'ready';
  redis.options = { ...CONNECTION_OPTIONS, connectionName };
  redis.disconnect = () => {
    redis.status = 'end';
    redis.emit('end');
  };
  const state = {
    calls: [],
    connections: [],
    readiness: [],
    owner: null,
    rows: names.map((name) => ({ name, paused: false, active: 0 })),
  };
  class FakeQueue extends EventEmitter {
    constructor(name, options) {
      super();
      this.name = name;
      state.connections.push(options.connection);
      assert.equal(options.skipMetasUpdate, true);
      this.ready = new Promise((resolve) => state.readiness.push(resolve));
    }
    waitUntilReady() {
      return this.ready;
    }
    async isPaused() {
      return state.rows.find((row) => row.name === this.name).paused;
    }
    async getActiveCount() {
      return state.rows.find((row) => row.name === this.name).active;
    }
    async pause() {
      state.calls.push(`pause:${this.name}`);
      state.rows.find((row) => row.name === this.name).paused = true;
    }
    async resume() {
      state.calls.push(`resume:${this.name}`);
      state.rows.find((row) => row.name === this.name).paused = false;
    }
    async close() {}
  }
  redis.eval_ro = async (script) => {
    if (script.startsWith('local kind=')) return [1, state.owner];
    state.calls.push('read');
    return [1, state.rows.map((row) => [row.name, row.active, Number(row.paused)])];
  };
  redis.set = async (_key, owner) => {
    if (state.owner !== null) return null;
    state.owner = owner;
    return 'OK';
  };
  redis.eval = async (script, _count, _key, owner) => {
    if (state.owner !== owner) return 0;
    if (script.includes("redis.call('DEL'")) state.owner = null;
    return 1;
  };
  redis.client = async (operation) =>
    operation === 'ID' ? 5 : operation === 'GETNAME' ? connectionName : '';
  const ready = () => state.readiness.forEach((resolve) => resolve());
  return { redis, state, FakeQueue, ready };
}
function fakeAdapter({ previous = null, names = queueNames } = {}) {
  const rows = names.map((name, index) => ({ name, paused: index === 24, active: 0 }));
  const events = [],
    state = { owner: null, previousPresent: false, time: 0, reads: 0, closeCount: 0 };
  let saved = previous;
  const ledger = {
    read: () => saved,
    compareAndSet: (expected, value) => {
      assert.equal(expected, saved === null ? null : digest(saved));
      events.push('ledger');
      saved = structuredClone(value);
    },
  };
  const fence = () => ({
    queueCount: 24,
    pausedCount: rows.slice(0, 24).filter((row) => row.paused).length,
    activeCount: rows.slice(0, 24).reduce((sum, row) => sum + row.active, 0),
    ownerPresent: state.owner !== null,
    ownerMatches: state.owner === nonce,
  });
  const client = {
    connectionIdentity: async () => ({ clientId: 20, connectionName }),
    readOriginalClientAbsent: async (identity) => {
      events.push('old-absence');
      if (state.previousPresent) throw new Error('old_present');
      return { clientId: identity.clientId, absent: true };
    },
    readQueues: async () => {
      state.reads++;
      events.push('read');
      return structuredClone(rows);
    },
    readWebhookFence: async () => fence(),
    pauseWebhookQueues: async () => {
      events.push('pause24');
      if (state.owner !== null && state.owner !== nonce) throw new Error('foreign_owner');
      state.owner = nonce;
      rows.slice(0, 24).forEach((row) => {
        row.paused = true;
      });
      return fence();
    },
    resumeWebhookQueues: async () => {
      events.push('resume24');
      assert.equal(state.owner, nonce);
      state.owner = null;
      rows.slice(0, 24).forEach((row) => {
        row.paused = false;
      });
      return fence();
    },
    pause: async (name) => {
      events.push(`pause:${name}`);
      rows.find((row) => row.name === name).paused = true;
    },
    resume: async (name) => {
      events.push(`resume:${name}`);
      rows.find((row) => row.name === name).paused = false;
    },
    close: async () => {
      state.closeCount++;
    },
  };
  const adapters = createSessionQueueAdapters({
    redisUrl: 'redis://127.0.0.1:1',
    queueNames: names,
    manifest,
    connectionLedger: ledger,
    openClient: async () => client,
    now: () => state.time,
    wait: async (ms) => {
      state.time += ms;
    },
  });
  return { adapters, client, ledger, state, rows, events, saved: () => saved };
}

test('registry is host supplied, complete, bounded and includes the exact stock 24 queues', () => {
  const scripts = buildQueueReadScripts(queueNames);
  assert.match(scripts.queues, /session-aux-28/u);
  assert.doesNotMatch(scripts.queues, /bindings\.json/u);
  for (const names of [
    queueNames.slice(1),
    [...queueNames, 'extra'],
    queueNames.map((n, i) => (i === 52 ? queueNames[0] : n)),
    queueNames.map((n, i) => (i === 52 ? "bad');redis.call('FLUSHALL')" : n)),
  ])
    assert.throws(() => buildQueueReadScripts(names), /registry/u);
});
test('only the current command inventory and retained legacy inventory are supported without mutation', () => {
  for (const names of [legacyQueueNames, queueNames]) {
    const immutable = Object.freeze([...names]);
    assert.equal(isSupportedSourceAbandonmentQueueInventory(immutable), true);
    assert.deepEqual(immutable, names);
    assert.doesNotThrow(() => buildQueueReadScripts(immutable));
  }
  const sparse = [...queueNames];
  delete sparse[0];
  for (const names of [
    legacyQueueNames.slice(1),
    [...queueNames, 'unsupported-extra'],
    [...legacyQueueNames, 'unsupported-replacement'],
    queueNames.slice(1),
    queueNames.map((name, index) => (index === 0 ? queueNames[1] : name)),
    sparse,
    null,
  ])
    assert.equal(isSupportedSourceAbandonmentQueueInventory(names), false);
});
test('current declared registry includes the dedicated command queue in all 54 session reads', () => {
  const text = readFileSync(
    new URL('../../apps/api/src/scripts/legacy-recovery-live-registry.ts', import.meta.url),
    'utf8',
  );
  const declaration = text.match(
    /export const LEGACY_RECOVERY_LIVE_QUEUE_NAMES = Object\.freeze\(\[([\s\S]*?)\] as const\);/u,
  );
  assert(declaration);
  const current = [...declaration[1].matchAll(/'([a-z0-9-]+)'/gu)].map((match) => match[1]);
  assert.equal(current.length, 54);
  assert.equal(current.filter((name) => name === 'admin-manual-commands').length, 1);
  const scripts = buildQueueReadScripts(current);
  assert.match(scripts.queues, /'admin-manual-commands'/u);
  assert.match(scripts.fence, /return \{1,24,paused,active/u);
});
test('all 54 readiness acknowledgements precede requested operations on one shared connection', async () => {
  const f = fakeTransport(),
    client = createQueueClient(f.redis, f.FakeQueue, { queueNames });
  const mutation = client.pause('session-aux-1');
  f.state.readiness.slice(0, queueNames.length - 1).forEach((resolve) => resolve());
  await delay(10);
  assert.deepEqual(f.state.calls, []);
  assert.equal(f.state.connections.length, 54);
  assert(f.state.connections.every((connection) => connection === f.redis));
  f.ready();
  await mutation;
  assert.deepEqual(f.state.calls, ['pause:session-aux-1']);
  await client.close();
});
test('read barrier and stock owner protocol share the same FIFO as auxiliary mutations', async () => {
  const f = fakeTransport();
  let finish;
  f.FakeQueue.prototype.pause = async function () {
    if (this.name === 'session-aux-1') {
      f.state.calls.push('aux-start');
      await new Promise((resolve) => {
        finish = resolve;
      });
      f.state.calls.push('aux-end');
    } else f.state.calls.push(`stock:${this.name}`);
    f.state.rows.find((row) => row.name === this.name).paused = true;
  };
  const client = createQueueClient(f.redis, f.FakeQueue, { queueNames });
  f.ready();
  await client.ready();
  const mutation = client.pause('session-aux-1'),
    read = client.readQueues(),
    pauseStock = client.pauseWebhookQueues(nonce);
  await delay(10);
  assert.deepEqual(f.state.calls, ['aux-start']);
  finish();
  await Promise.all([mutation, read, pauseStock]);
  assert.deepEqual(f.state.calls.slice(0, 3), ['aux-start', 'aux-end', 'read']);
  assert.equal(f.state.calls.filter((event) => event.startsWith('stock:')).length, 24);
  await client.close();
});
test('unacknowledged mutation poisons and disconnects before any queued resume or read', async () => {
  const f = fakeTransport();
  let finish;
  f.FakeQueue.prototype.pause = async function () {
    f.state.calls.push('unacknowledged');
    await new Promise((resolve) => {
      finish = resolve;
    });
  };
  const client = createQueueClient(f.redis, f.FakeQueue, { queueNames });
  f.ready();
  await client.ready();
  const mutation = client.pause('session-aux-1'),
    resume = client.resume('session-aux-1'),
    read = client.readQueues();
  resume.catch(() => {});
  read.catch(() => {});
  await assert.rejects(mutation, /failed_closed/u);
  await assert.rejects(resume, /unavailable/u);
  await assert.rejects(read, /unavailable/u);
  assert.deepEqual(f.state.calls, ['unacknowledged']);
  assert.equal(f.redis.status, 'end');
  finish();
  await client.close();
});
test('direct webhook mutation and Redis reconnect/resend configurations are refused', async () => {
  for (const [key, value] of [
    ['maxRetriesPerRequest', 1],
    ['enableOfflineQueue', true],
    ['autoResendUnfulfilledCommands', true],
    ['retryStrategy', () => 1],
    ['commandTimeout', 1001],
  ]) {
    const f = fakeTransport();
    f.redis.options[key] = value;
    assert.throws(() => createQueueClient(f.redis, f.FakeQueue, { queueNames }), /unbounded/u);
  }
  const f = fakeTransport(),
    client = createQueueClient(f.redis, f.FakeQueue, { queueNames });
  f.ready();
  await client.ready();
  assert.throws(() => client.pause('moderation'), /outside_auxiliary/u);
  assert.throws(() => client.resume('moderation-default-0'), /outside_auxiliary/u);
  await client.close();
});
test('read-only original client barrier refuses presence and never sends CLIENT KILL', async () => {
  const f = fakeTransport();
  const commands = [];
  f.redis.client = async (...args) => {
    commands.push(args);
    return `id=4 name=${connectionName} addr=127.0.0.1:1\n`;
  };
  const client = createQueueClient(f.redis, f.FakeQueue, { queueNames });
  f.ready();
  await client.ready();
  await assert.rejects(
    client.readOriginalClientAbsent({ clientId: 4, connectionName }),
    /failed_closed/u,
  );
  assert.deepEqual(commands, [['LIST', 'ID', '4']]);
  await client.close();
});
test('durable identity and old-client absence precede all mutations, original auxiliary pauses survive', async () => {
  const f = fakeAdapter({ previous: { clientId: 7, connectionName } });
  const baseline = await f.adapters.inspectQueueBaseline(manifest);
  const result = await f.adapters.preDrainRuntime(manifest, baseline);
  assert.equal(result.queueWorkDrained, true);
  assert.equal(result.zeroObservations, 2);
  assert.equal('detachedWorkDrained' in result, false);
  assert(f.events.indexOf('old-absence') < f.events.indexOf('ledger'));
  assert(f.events.indexOf('ledger') < f.events.indexOf('pause24'));
  assert(!f.events.includes('pause:session-aux-0'));
  await f.adapters.resumeWebhookQueues(manifest);
  const restored = await f.adapters.restoreAuxiliaryQueues(manifest, baseline);
  assert.equal(restored.queueBaselineDigest, digest(baseline));
  assert.equal(restored.restored, true);
  assert(!f.events.includes('resume:session-aux-0'));
  assert.equal(f.rows[24].paused, true);
  assert.equal(f.rows.filter((row) => row.paused).length, 1);
  await f.adapters.close();
});
test('retained 53-queue baselines restore exact original pause states without adding the command queue', async () => {
  const f = fakeAdapter({ names: legacyQueueNames });
  const baseline = await f.adapters.inspectQueueBaseline(manifest);
  const before = JSON.stringify(baseline);
  assert.equal(baseline.queueCount, 53);
  assert.equal(
    baseline.queues.some(({ name }) => name === 'admin-manual-commands'),
    false,
  );
  await f.adapters.preDrainRuntime(manifest, baseline);
  await f.adapters.resumeWebhookQueues(manifest);
  await f.adapters.restoreAuxiliaryQueues(manifest, baseline);
  assert.equal(JSON.stringify(baseline), before);
  assert.deepEqual(
    f.rows.map(({ name, paused }) => ({ name, paused })),
    baseline.queues,
  );
  assert.equal(
    f.events.some((event) => event.includes('admin-manual-commands')),
    false,
  );
  await f.adapters.close();
});
test('a current 54-queue adapter refuses a baseline with the new queue dropped', async () => {
  const f = fakeAdapter();
  const baseline = await f.adapters.inspectQueueBaseline(manifest);
  const changed = {
    ...baseline,
    queueCount: 53,
    queues: baseline.queues.filter(({ name }) => name !== 'admin-manual-commands'),
  };
  await assert.rejects(f.adapters.preDrainRuntime(manifest, changed), /baseline_changed/u);
  assert.equal(f.events.includes('pause24'), false);
  await f.adapters.close();
});
test('old live connection and lost ledger acknowledgement prevent all queue mutations', async () => {
  const f = fakeAdapter({ previous: { clientId: 7, connectionName } });
  f.state.previousPresent = true;
  await assert.rejects(f.adapters.inspectQueueBaseline(manifest), /old_present/u);
  assert.equal(f.saved().clientId, 7);
  assert.equal(f.state.closeCount, 1);
  assert(!f.events.includes('pause24'));
  const g = fakeAdapter();
  g.ledger.compareAndSet = () => {
    throw new Error('ledger_ack_unknown');
  };
  await assert.rejects(g.adapters.inspectQueueBaseline(manifest), /ledger_ack_unknown/u);
  assert.equal(g.state.closeCount, 1);
  assert(!g.events.includes('pause24'));
});
test('active work must naturally drain twice and 60-second failure stays paused for parent containment', async () => {
  const f = fakeAdapter(),
    baseline = await f.adapters.inspectQueueBaseline(manifest);
  f.rows[30].active = 1;
  await assert.rejects(f.adapters.preDrainRuntime(manifest, baseline), /drain_deadline/u);
  assert(f.state.time < QUEUE_LIMITS.drainMs);
  assert(f.rows.every((row) => row.paused));
  assert(!f.events.some((event) => event.startsWith('resume')));
  await f.adapters.close();
});
test('baseline drift, foreign ownership and lost original pause block restoration', async () => {
  const f = fakeAdapter(),
    baseline = await f.adapters.inspectQueueBaseline(manifest);
  f.rows[25].paused = true;
  await assert.rejects(f.adapters.preDrainRuntime(manifest, baseline), /baseline_drift/u);
  assert(!f.events.includes('pause24'));
  f.rows[25].paused = false;
  await f.adapters.preDrainRuntime(manifest, baseline);
  await f.adapters.resumeWebhookQueues(manifest);
  f.state.owner = 'foreign';
  await assert.rejects(f.adapters.restoreAuxiliaryQueues(manifest, baseline), /resume_required/u);
  f.state.owner = null;
  f.rows[24].paused = false;
  await assert.rejects(
    f.adapters.restoreAuxiliaryQueues(manifest, baseline),
    /original_pause_lost/u,
  );
  await f.adapters.close();
});
test('stop-first containment can reassert all 54 after partial auxiliary restoration', async () => {
  const f = fakeAdapter(),
    baseline = await f.adapters.inspectQueueBaseline(manifest);
  await f.adapters.preDrainRuntime(manifest, baseline);
  await f.adapters.resumeWebhookQueues(manifest);
  f.rows[25].paused = false;
  await f.adapters.pauseAllQueues(manifest, baseline);
  assert(f.rows.every((row) => row.paused));
  assert.equal(f.state.owner, nonce);
  await f.adapters.close();
});

const nativeAvailable = /^Redis server v=7\./u.test(
  spawnSync('redis-server', ['--version'], { encoding: 'utf8' }).stdout ?? '',
);
test(
  'native Redis 7 proves actual owner fencing, job retention, drain and old-connection absence',
  {
    skip: !nativeAvailable,
    timeout: 20000,
  },
  async (t) => {
    const directory = mkdtempSync(join(tmpdir(), 'maxim-session-redis-'));
    const listener = createServer();
    listener.listen(0, '127.0.0.1');
    await once(listener, 'listening');
    const port = listener.address().port;
    await new Promise((resolve) => listener.close(resolve));
    const child = spawn(
      'redis-server',
      [
        '--bind',
        '127.0.0.1',
        '--port',
        String(port),
        '--save',
        '',
        '--appendonly',
        'no',
        '--dir',
        directory,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let output = '';
    child.stdout.on('data', (data) => {
      output += data;
    });
    child.stderr.on('data', () => {});
    t.after(async () => {
      if (child.exitCode === null) {
        child.kill('SIGTERM');
        await once(child, 'exit');
      }
      rmSync(directory, { recursive: true, force: true });
    });
    for (let i = 0; i < 100 && !output.includes('Ready to accept connections'); i++)
      await delay(20);
    assert(output.includes('Ready to accept connections'));
    const redisUrl = `redis://127.0.0.1:${port}/0`;
    const admin = new Redis(redisUrl, {
      lazyConnect: true,
      maxRetriesPerRequest: 0,
      retryStrategy: null,
    });
    await admin.connect();
    t.after(() => admin.disconnect());
    await admin.hset('bull:session-aux-0:meta', 'paused', '1');
    const q = new Queue('session-aux-1', { connection: { url: redisUrl }, skipMetasUpdate: true });
    t.after(() => q.close());
    await q.add('retained', { fixture: 'private' }, { jobId: 'retained-job' });
    const commands = new Queue('admin-manual-commands', {
      connection: { url: redisUrl },
      skipMetasUpdate: true,
    });
    t.after(() => commands.close());
    await commands.add(
      'retained-command',
      { fixture: 'private' },
      { jobId: 'retained-command-job' },
    );
    let saved = null;
    const ledger = {
      read: () => saved,
      compareAndSet: (expected, next) => {
        assert.equal(expected, saved === null ? null : digest(saved));
        saved = structuredClone(next);
      },
    };
    const options = { redisUrl, queueNames, manifest, connectionLedger: ledger };
    const first = createSessionQueueAdapters(options);
    t.after(() => first.close());
    const baseline = await first.inspectQueueBaseline(manifest);
    assert.equal(baseline.queueCount, 54);
    assert.equal(baseline.queues.filter(({ name }) => name === 'admin-manual-commands').length, 1);
    const collision = createSessionQueueAdapters(options);
    t.after(() => collision.close());
    await assert.rejects(collision.inspectQueueBaseline(manifest), /failed_closed/u);
    assert.equal(await admin.get(stock.WEBHOOK_ROLLOUT_OWNER_KEY), null);
    const result = await first.preDrainRuntime(manifest, baseline);
    assert.equal(result.queueWorkDrained, true);
    assert.equal(await commands.isPaused(), true);
    assert.equal((await commands.getJob('retained-command-job')).id, 'retained-command-job');
    assert.equal((await q.getJob('retained-job')).id, 'retained-job');
    assert.equal(await q.getWaitingCount(), 1);
    const firstId = saved.clientId;
    await first.close();
    const resumed = createSessionQueueAdapters(options);
    t.after(() => resumed.close());
    const fence = await resumed.readWebhookFence(manifest);
    assert.equal(fence.ownerMatches, true);
    assert.notEqual(saved.clientId, firstId);
    await resumed.resumeWebhookQueues(manifest);
    await resumed.restoreAuxiliaryQueues(manifest, baseline);
    assert.equal(await admin.get(stock.WEBHOOK_ROLLOUT_OWNER_KEY), null);
    assert.equal(await admin.hget('bull:session-aux-0:meta', 'paused'), '1');
    assert.equal(await q.isPaused(), false);
    assert.equal(await commands.isPaused(), false);
    assert.equal((await commands.getJob('retained-command-job')).id, 'retained-command-job');
    assert.equal((await q.getJob('retained-job')).id, 'retained-job');
    // A real active handler prevents zero-count acceptance until it finishes normally.
    let release, began;
    const started = new Promise((resolve) => {
      began = resolve;
    });
    const held = new Promise((resolve) => {
      release = resolve;
    });
    const worker = new Worker(
      'session-aux-1',
      async () => {
        began();
        await held;
        return 'done';
      },
      { connection: { url: redisUrl, maxRetriesPerRequest: null } },
    );
    worker.on('error', () => {});
    t.after(() => worker.close());
    await started;
    const secondBaseline = await resumed.inspectQueueBaseline(manifest);
    const drain = resumed.preDrainRuntime(manifest, secondBaseline);
    await delay(100);
    assert.equal(await q.getActiveCount(), 1);
    release();
    await drain;
    assert.equal(await q.getActiveCount(), 0);
    assert.equal((await q.getJob('retained-job')).id, 'retained-job');
    await resumed.resumeWebhookQueues(manifest);
    await resumed.restoreAuxiliaryQueues(manifest, secondBaseline);
    await worker.close();
    await q.close();
    await resumed.close();
  },
);
