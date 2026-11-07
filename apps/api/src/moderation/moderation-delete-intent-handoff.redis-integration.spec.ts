import { randomUUID } from 'node:crypto';
import { Queue, Worker } from 'bullmq';
import Redis from 'ioredis';
import {
  handoffModerationDeleteSweepJob,
  MODERATION_DELETE_INTENT_QUEUE,
  type ModerationDeleteIntentJob,
} from './moderation-delete-intent.queue';

const redisUrl = process.env.MAXIM_TEST_REDIS_URL?.trim() ?? '';
jest.setTimeout(15_000);

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

(redisUrl ? describe : describe.skip)('DELETE sweep deterministic BullMQ handoff', () => {
  let queue: Queue<ModerationDeleteIntentJob>;
  let worker: Worker<ModerationDeleteIntentJob> | undefined;
  let inspector: Redis | undefined;
  let connection: { host: string; port: number; db: number };
  let prefix: string;

  beforeEach(async () => {
    const url = new URL(redisUrl);
    if (!['localhost', '127.0.0.1'].includes(url.hostname)) {
      throw new Error('DELETE handoff tests require disposable local Redis');
    }
    connection = {
      host: url.hostname,
      port: Number(url.port || 6379),
      db: Number(url.pathname.slice(1) || 0),
    };
    prefix = `delete-sweep-handoff-${randomUUID()}`;
    queue = new Queue(MODERATION_DELETE_INTENT_QUEUE, { connection, prefix });
    await queue.waitUntilReady();
  });

  afterEach(async () => {
    await worker?.close();
    worker = undefined;
    await inspector?.quit();
    inspector = undefined;
    if (queue) {
      await queue.obliterate({ force: true });
      await queue.close();
    }
  });

  it('reuses a legacy job without duplicate stream writes or priority/payload changes', async () => {
    const old = await queue.add(
      'execute-moderation-delete-intent',
      { intentId: 'existing-intent' },
      { jobId: 'mdi-existing-intent', priority: 1, removeOnComplete: true, removeOnFail: true },
    );
    inspector = new Redis(redisUrl, { lazyConnect: true, maxRetriesPerRequest: 0 });
    await inspector.connect();
    const eventCount = await inspector.xlen(queue.toKey('events'));

    for (let attempt = 0; attempt < 20; attempt++) {
      await expect(handoffModerationDeleteSweepJob(queue, 'existing-intent', 10)).resolves.toEqual({
        insertion: 'existing',
        reused: true,
        observationErrors: 0,
      });
    }

    const preserved = (await queue.getJob(old.id!))!;
    expect(preserved.data).toEqual({ intentId: 'existing-intent' });
    expect(preserved.opts.priority).toBe(1);
    expect(await preserved.getState()).toBe('prioritized');
    expect(await inspector.xlen(queue.toKey('events'))).toBe(eventCount);
    expect(await queue.getJobCounts('prioritized')).toMatchObject({ prioritized: 1 });
  });

  it('keeps a different persisted token uncertain when concurrent missing-job observations race', async () => {
    const bothObservedMissing = deferred();
    let reads = 0;
    const racingQueue = {
      add: queue.add.bind(queue),
      getJob: async (id: string) => {
        const observed = await queue.getJob(id);
        reads++;
        if (reads <= 2) {
          if (reads === 2) bothObservedMissing.resolve();
          await bothObservedMissing.promise;
        }
        return observed;
      },
    } satisfies Pick<Queue<ModerationDeleteIntentJob>, 'add' | 'getJob'>;

    const results = await Promise.all([
      handoffModerationDeleteSweepJob(racingQueue, 'racing-intent', 10),
      handoffModerationDeleteSweepJob(racingQueue, 'racing-intent', 10),
    ]);

    expect(results.map((result) => result.insertion).sort()).toEqual(['inserted', 'unknown']);
    expect(results.every((result) => !result.reused && result.observationErrors === 0)).toBe(true);
    const persisted = (await queue.getJob('mdi-racing-intent'))!;
    expect(persisted.data.intentId).toBe('racing-intent');
    expect(persisted.data.handoffToken).toMatch(/^[0-9a-f-]{36}$/u);
    expect(await queue.getJobCounts('prioritized')).toMatchObject({ prioritized: 1 });
  });

  it('keeps a completed-and-removed job uncertain and permits the next SQL wakeup', async () => {
    const completed = deferred();
    const handled: string[] = [];
    worker = new Worker<ModerationDeleteIntentJob>(
      MODERATION_DELETE_INTENT_QUEUE,
      async (job) => {
        // FLAG: This inert worker consumes the production payload shape without any SQL or MAX effects.
        handled.push(job.data.intentId);
      },
      { connection, prefix },
    );
    worker.once('completed', () => completed.resolve());
    await worker.waitUntilReady();
    const completedBeforeObservation = {
      getJob: queue.getJob.bind(queue),
      add: async (...args: Parameters<Queue<ModerationDeleteIntentJob>['add']>) => {
        const job = await queue.add(...args);
        await completed.promise;
        return job;
      },
    } satisfies Pick<Queue<ModerationDeleteIntentJob>, 'add' | 'getJob'>;

    await expect(
      handoffModerationDeleteSweepJob(completedBeforeObservation, 'completed-intent', 10),
    ).resolves.toEqual({ insertion: 'unknown', reused: false, observationErrors: 0 });

    expect(handled).toEqual(['completed-intent']);
    expect(await queue.getJob('mdi-completed-intent')).toBeUndefined();
    await worker.close();
    worker = undefined;
    await expect(handoffModerationDeleteSweepJob(queue, 'completed-intent', 10)).resolves.toEqual({
      insertion: 'inserted',
      reused: false,
      observationErrors: 0,
    });
  });

  it('repairs a job disappearing after the reuse observation on the next sweep', async () => {
    await queue.add(
      'execute-moderation-delete-intent',
      { intentId: 'disappearing-intent' },
      { jobId: 'mdi-disappearing-intent', priority: 10, removeOnComplete: true },
    );
    const disappearingAfterRead = {
      add: queue.add.bind(queue),
      getJob: async (id: string) => {
        const observed = await queue.getJob(id);
        await observed?.remove();
        return observed;
      },
    } satisfies Pick<Queue<ModerationDeleteIntentJob>, 'add' | 'getJob'>;

    await expect(
      handoffModerationDeleteSweepJob(disappearingAfterRead, 'disappearing-intent', 10),
    ).resolves.toEqual({ insertion: 'existing', reused: true, observationErrors: 0 });
    expect(await queue.getJob('mdi-disappearing-intent')).toBeUndefined();
    await expect(
      handoffModerationDeleteSweepJob(queue, 'disappearing-intent', 10),
    ).resolves.toEqual({ insertion: 'inserted', reused: false, observationErrors: 0 });
  });

  it('keeps completed-and-replaced insertion uncertain without changing the replacement', async () => {
    const completed = deferred();
    const handled: string[] = [];
    worker = new Worker<ModerationDeleteIntentJob>(
      MODERATION_DELETE_INTENT_QUEUE,
      async (job) => {
        handled.push(job.data.intentId);
      },
      { connection, prefix },
    );
    worker.once('completed', () => completed.resolve());
    await worker.waitUntilReady();
    const replacementToken = randomUUID();
    const replacedBeforeObservation = {
      getJob: queue.getJob.bind(queue),
      add: async (...args: Parameters<Queue<ModerationDeleteIntentJob>['add']>) => {
        const original = await queue.add(...args);
        await completed.promise;
        await worker!.close();
        worker = undefined;
        await queue.add(
          'execute-moderation-delete-intent',
          { intentId: 'replaced-intent', handoffToken: replacementToken },
          { jobId: 'mdi-replaced-intent', priority: 1, removeOnComplete: true },
        );
        return original;
      },
    } satisfies Pick<Queue<ModerationDeleteIntentJob>, 'add' | 'getJob'>;

    await expect(
      handoffModerationDeleteSweepJob(replacedBeforeObservation, 'replaced-intent', 10),
    ).resolves.toEqual({ insertion: 'unknown', reused: false, observationErrors: 0 });

    expect(handled).toEqual(['replaced-intent']);
    const replacement = (await queue.getJob('mdi-replaced-intent'))!;
    expect(replacement.data).toEqual({
      intentId: 'replaced-intent',
      handoffToken: replacementToken,
    });
    expect(replacement.opts.priority).toBe(1);
    expect(await replacement.getState()).toBe('prioritized');
    expect(await queue.getJobCounts('prioritized')).toMatchObject({ prioritized: 1 });
  });

  it('does not suppress deterministic add after an unavailable existence observation', async () => {
    let reads = 0;
    const unavailableFirstRead = {
      add: queue.add.bind(queue),
      getJob: async (id: string) => {
        if (++reads === 1) throw new Error('temporary read unavailable');
        return queue.getJob(id);
      },
    } satisfies Pick<Queue<ModerationDeleteIntentJob>, 'add' | 'getJob'>;

    await expect(
      handoffModerationDeleteSweepJob(unavailableFirstRead, 'read-failure-intent', 10),
    ).resolves.toEqual({ insertion: 'inserted', reused: false, observationErrors: 1 });
    expect(await queue.getJob('mdi-read-failure-intent')).toBeDefined();
  });
});
