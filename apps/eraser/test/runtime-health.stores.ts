import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { Queue, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import pg from 'pg';
import { CleanupRuntime, MAX_WAKEUPS, type Wakeup } from '../src/runtime.js';
import { Store } from '../src/store.js';
import { updatePolicy } from './support/policy-proof.js';
import { migrate } from '../src/migrate.js';
import type { MaxTransport } from '../src/max.js';

const redisUrl = process.env.MAXIM_TEST_REDIS_URL;
if (!redisUrl)
  throw new Error('Native Eraser health tests require scripts/agent/with-test-stores.mjs');

type HealthStore = Pick<
  Store,
  | 'reserve'
  | 'reserveConnections'
  | 'housekeeping'
  | 'housekeepingHealth'
  | 'active'
  | 'finishVisit'
>;
const idleStore: HealthStore = {
  reserve: async () => [],
  reserveConnections: async () => [],
  housekeeping: async () => {},
  housekeepingHealth: () => new Store({} as Store['pool'], true).housekeepingHealth(),
  active: async () => null,
  finishVisit: async () => {},
};
const noMax: MaxTransport = {
  rights: async () => assert.fail('Health must not probe MAX'),
  actorRights: async () => assert.fail('Health must not probe MAX'),
  pin: async () => assert.fail('Health must not probe MAX'),
  page: async () => assert.fail('Health must not probe MAX'),
  presence: async () => assert.fail('Health must not probe MAX'),
  remove: async () => assert.fail('Health must not mutate MAX'),
};

async function eventually(check: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!check() && Date.now() < deadline) await delay(10);
  assert.ok(check(), label);
}

async function fixture(
  run: (runtime: CleanupRuntime, queue: Queue<Wakeup>) => Promise<void>,
  overrides: Partial<HealthStore> = {},
) {
  const prefix = `eraser:health:${randomUUID()}`;
  const runtime = new CleanupRuntime(
    { ...idleStore, ...overrides } as Store,
    noMax,
    { enabled: true, redisUrl: redisUrl! },
    prefix,
  );
  const queue = new Queue<Wakeup>('cleanup', {
    connection: { url: redisUrl!, maxRetriesPerRequest: 1 },
    prefix,
  });
  const redis = new Redis(redisUrl!, { maxRetriesPerRequest: 1 });
  try {
    await runtime.start();
    await Promise.all([runtime.tick(), runtime.tickConnections()]);
    await eventually(() => runtime.health().schedulerHealthy, 'idle workers become ready');
    await run(runtime, queue);
  } finally {
    await runtime.close();
    await queue.close();
    const keys = await redis.keys(`${prefix}:*`);
    if (keys.length) await redis.del(...keys);
    await redis.quit();
  }
}

test('real idle workers stay healthy without any completed jobs or MAX probes', async () => {
  await fixture(async (runtime) => {
    await Promise.all([runtime.tick(), runtime.tickConnections()]);
    const health = runtime.health();
    assert.equal(health.schedulerHealthy, true);
    for (const worker of Object.values(health.workers!)) {
      assert.equal(worker.healthy, true);
      assert.equal(worker.ready, true);
      assert.equal(worker.running, true);
      assert.equal(worker.occupiedSlots, 0);
      assert.equal(worker.lastCompletedAt, null);
      assert.equal(worker.progressOverdue, false);
    }
  });
});

for (const target of ['worker', 'connectionWorker'] as const) {
  test(`a closed ${target} degrades health despite successful fresh scheduler ticks`, async () => {
    await fixture(async (runtime) => {
      const worker = (runtime as unknown as Record<typeof target, Worker>)[target];
      await worker.close();
      await Promise.all([runtime.tick(), runtime.tickConnections()]);
      const health = runtime.health();
      assert.ok(Date.now() - Date.parse(health.schedulerLastSuccessfulAt!) < 1000);
      assert.equal(health.connectionSchedulerHealthy, true);
      assert.equal(health.schedulerHealthy, false);
      const observed = health.workers![target === 'worker' ? 'cleanup' : 'connection'];
      assert.equal(observed.healthy, false);
      assert.equal(observed.running, false);
      assert.equal(observed.lastErrorCode, 'worker_closed');
    });
  });
}

test('occupied stale slots degrade health even while both workers and schedulers are running', async () => {
  await fixture(async (runtime, queue) => {
    await queue.pause();
    await queue.addBulk(
      Array.from({ length: MAX_WAKEUPS }, (_, index) => ({
        name: 'visit',
        data: { chatId: '-1', leaseToken: randomUUID() },
        opts: {
          jobId: `slot-${index}`,
          timestamp: Date.now() - 121_000,
          removeOnComplete: true,
          removeOnFail: true,
        },
      })),
    );
    await Promise.all([runtime.tick(), runtime.tickConnections()]);
    const health = runtime.health();
    assert.equal(health.workers!.cleanup.running, true);
    assert.equal(health.workers!.connection.healthy, true);
    assert.equal(health.workers!.cleanup.occupiedSlots, MAX_WAKEUPS);
    assert.equal(health.workers!.cleanup.progressOverdue, true);
    assert.equal(health.schedulerHealthy, false);
    assert.ok(Date.now() - Date.parse(health.schedulerLastSuccessfulAt!) < 1000);

    await queue.resume();
    await eventually(
      () => runtime.health().workers!.cleanup.lastCompletedAt !== null,
      'actual worker completion is observed',
    );
    const deadline = Date.now() + 5000;
    while (!runtime.health().schedulerHealthy && Date.now() < deadline) {
      await runtime.tick();
      await delay(10);
    }
    assert.equal(runtime.health().schedulerHealthy, true);
    assert.equal(runtime.health().workers!.cleanup.occupiedSlots, 0);
  });
});

test('worker errors remain unhealthy until recovery and emit bounded diagnostics without secrets', async () => {
  await fixture(async (runtime, queue) => {
    const worker = (runtime as unknown as { worker: Worker }).worker;
    const logs: string[] = [];
    const write = process.stderr.write;
    process.stderr.write = ((value: string | Uint8Array) => {
      logs.push(String(value));
      return true;
    }) as typeof process.stderr.write;
    try {
      worker.emit('error', new Error('credential=private-token chat=-123 job=private-id'));
      worker.emit('error', new Error('another-private-token'));
    } finally {
      process.stderr.write = write;
    }
    await Promise.all([runtime.tick(), runtime.tickConnections()]);
    assert.equal(runtime.health().schedulerHealthy, false);
    assert.equal(runtime.health().workers!.cleanup.lastErrorCode, 'worker_error');
    assert.deepEqual(
      logs.map((entry) => JSON.parse(entry)),
      [{ service: 'eraser', component: 'cleanup', code: 'worker_error' }],
    );
    await queue.add(
      'visit',
      { chatId: '-1', leaseToken: randomUUID() },
      { removeOnComplete: true },
    );
    await eventually(
      () => runtime.health().schedulerHealthy,
      'successful completion recovers health',
    );
    assert.ok(runtime.health().workers!.cleanup.lastCompletedAt);
    assert.equal(runtime.health().workers!.cleanup.lastErrorCode, 'worker_error');
  });
});

for (const drainFirst of [true, false]) {
  test(`idle health recovers when the last failed job ${drainFirst ? 'follows' : 'precedes'} a real drained event`, async () => {
    let releaseFailure: (() => void) | undefined;
    let finishStarted = false;
    const finishGate = new Promise<void>((resolve) => {
      releaseFailure = resolve;
    });
    await fixture(
      async (runtime, queue) => {
        const worker = (runtime as unknown as { worker: Worker }).worker;
        worker.concurrency = drainFirst ? 8 : 1;
        let drained = 0;
        worker.on('drained', () => drained++);
        await queue.add(
          'visit',
          { chatId: '-1', leaseToken: randomUUID() },
          { removeOnFail: true },
        );
        try {
          await eventually(() => finishStarted, 'the actual processor reaches its failure gate');
          if (drainFirst)
            await eventually(() => drained > 0, 'the queue drains while its last job is active');
          else assert.equal(drained, 0);
        } finally {
          releaseFailure!();
        }
        await eventually(
          () => runtime.health().workers!.cleanup.lastErrorCode === 'job_failed',
          'the actual BullMQ job fails',
        );
        await eventually(() => drained > 0, 'the worker observes an empty queue');
        await runtime.tick();
        assert.equal(runtime.health().schedulerHealthy, true);
        assert.equal(runtime.health().workers!.cleanup.occupiedSlots, 0);
        assert.equal(runtime.health().workers!.cleanup.lastCompletedAt, null);
        assert.equal(runtime.health().workers!.cleanup.lastErrorCode, 'job_failed');
      },
      {
        finishVisit: async () => {
          finishStarted = true;
          await finishGate;
          throw new Error('simulated final store failure');
        },
      },
    );
  });
}

for (const setupQueue of ['cleanup', 'connections']) {
  test(`stopping during ${setupQueue} setup cannot create another worker or scheduler`, async (context) => {
    const prefix = `eraser:startup:${randomUUID()}`;
    const runtime = new CleanupRuntime(
      idleStore as Store,
      noMax,
      { enabled: true, redisUrl: redisUrl! },
      prefix,
    );
    const redis = new Redis(redisUrl!, { maxRetriesPerRequest: 1 });
    let entered!: () => void;
    let release!: () => void;
    const setupEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const setupReply = new Promise<void>((resolve) => {
      release = resolve;
    });
    const original = Queue.prototype.setGlobalConcurrency;
    context.mock.method(
      Queue.prototype,
      'setGlobalConcurrency',
      async function (this: Queue, concurrency: number) {
        const result = await original.call(this, concurrency);
        if (this.name === setupQueue && this.opts.prefix === prefix) {
          entered();
          await setupReply;
        }
        return result;
      },
    );
    const starting = runtime.start();
    try {
      await setupEntered;
      runtime.stopAdmission();
      release();
      await starting;
      const state = runtime as unknown as {
        worker: Worker | null;
        connectionWorker: Worker | null;
        timer: NodeJS.Timeout | null;
      };
      assert.equal(Boolean(state.worker), setupQueue === 'connections');
      assert.equal(state.connectionWorker, null);
      assert.equal(state.timer, null);
      assert.equal(runtime.health().schedulerHealthy, false);
      await runtime.start();
      assert.equal(state.connectionWorker, null, 'a stopped runtime cannot restart admission');
      assert.equal(state.timer, null);
    } finally {
      release();
      await starting;
      await runtime.close();
      const keys = await redis.keys(`${prefix}:*`);
      if (keys.length) await redis.del(...keys);
      await redis.quit();
    }
  });
}

test('shutdown during the final pin read cannot acquire a new DELETE journal', async () => {
  const databaseUrl = process.env.MAXIM_TEST_POSTGRES_URL;
  assert.ok(databaseUrl, 'native final-dispatch test requires the public store wrapper');
  const schema = `eraser_shutdown_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Pool({ connectionString: databaseUrl, max: 1 });
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    max: 2,
    options: `-c search_path=${schema} -c timezone=UTC`,
  });
  const store = new Store(pool, true);
  let deletes = 0;
  const max: MaxTransport = {
    ...noMax,
    rights: async () => {},
    pin: async () => {
      runtime.stopAdmission();
      return null;
    },
    remove: async (_chatId, _messageId, before) => {
      await before();
      deletes++;
    },
  };
  const runtime = new CleanupRuntime(store, max, { enabled: true, redisUrl: redisUrl! });
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
    await migrate(pool);
    await store.bootstrap('-1', 24, {
      sourceRevision: 1,
      protectedMessageIds: [],
      protectedBotIds: [],
      holdMessageIds: [],
      completeThrough: new Date().toISOString(),
    });
    await updatePolicy(store, '-1', {
      enabled: true,
      hours: 24,
      expectedRevision: 0,
      operationId: randomUUID(),
      actorUserId: '5',
    });
    await pool.query(
      `INSERT INTO eraser_candidates(chat_id,message_id,author_id,is_bot,source_ms,lane)
       VALUES('-1','message','5',false,$1,'live')`,
      [Date.now() - 8 * 86_400_000],
    );
    const [wakeup] = await store.reserve(1);
    assert.ok(wakeup);
    await runtime.visit(wakeup);
    assert.equal(deletes, 0);
    const row = (await pool.query('SELECT state,dispatch_id,attempt_count FROM eraser_candidates'))
      .rows[0];
    assert.equal(row.state, 'pending');
    assert.equal(row.dispatch_id, null);
    assert.equal(row.attempt_count, 0);
  } finally {
    await runtime.close();
    await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  }
});

test('maintenance failure does not stop dispatch scheduling or retry every scheduler tick', async (t) => {
  let attempts = 0;
  await fixture(
    async (runtime) => {
      let now = Date.now() + 31_000;
      t.mock.method(Date, 'now', () => now);
      await runtime.tickConnections();
      await runtime.tick();
      assert.equal(attempts, 1);
      assert.equal(runtime.health().schedulerHealthy, true);
      for (let i = 0; i < 5; i++) await runtime.tick();
      assert.equal(attempts, 1, 'failed maintenance retains the ordinary cadence');
      now += 30_000;
      await runtime.tickConnections();
      await runtime.tick();
      assert.equal(attempts, 2);
    },
    {
      housekeeping: async () => {
        attempts++;
        throw new Error('Synthetic unavailable maintenance');
      },
    },
  );
});
