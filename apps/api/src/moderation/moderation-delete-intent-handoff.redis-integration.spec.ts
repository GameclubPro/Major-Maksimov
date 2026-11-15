import { randomUUID } from 'node:crypto';
import { Queue, Worker } from 'bullmq';
import Redis from 'ioredis';
import {
  enqueueModerationDeleteWakeup,
  handoffModerationDeleteSweepJob,
  handoffModerationDeleteSweepJobs,
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
  const clientRestorations: Array<() => void> = [];

  async function mockPipeline() {
    const client = await queue.client;
    const original = client.pipeline;
    const pipeline = jest.fn(original.bind(client));
    // FLAG: BullMQ's Redis adapter rejects delete; restore overrides by assignment.
    client.pipeline = pipeline;
    clientRestorations.push(() => {
      client.pipeline = original;
    });
    return pipeline;
  }

  async function interceptNextBatchRead(
    transform: (
      results: Array<[Error | null, unknown]> | null,
    ) => Promise<Array<[Error | null, unknown]> | null> | Array<[Error | null, unknown]> | null,
  ) {
    const pipeline = (await queue.client).pipeline();
    const execute = pipeline.exec.bind(pipeline);
    jest.spyOn(pipeline, 'exec').mockImplementation(async () => transform(await execute()));
    (await mockPipeline()).mockReturnValueOnce(pipeline);
  }

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
    for (const restore of clientRestorations.splice(0).reverse()) restore();
    jest.restoreAllMocks();
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

  it('promotes the persisted priority even when duplicate add reports the requested priority', async () => {
    await enqueueModerationDeleteWakeup(queue, 'urgent', 10);
    const duplicate = await queue.add(
      'execute-moderation-delete-intent',
      { intentId: 'urgent' },
      {
        jobId: 'mdi-urgent',
        priority: 1,
      },
    );
    expect(duplicate.opts.priority).toBe(1);
    expect((await queue.getJob('mdi-urgent'))!.priority).toBe(10);
    await enqueueModerationDeleteWakeup(queue, 'urgent', 1);
    expect((await queue.getJob('mdi-urgent'))!.priority).toBe(1);
    await enqueueModerationDeleteWakeup(queue, 'urgent', 10);
    expect((await queue.getJob('mdi-urgent'))!.priority).toBe(1);
    expect(await queue.getJobCounts('prioritized')).toMatchObject({ prioritized: 1 });
  });

  it('retains the earlier delayed wakeup and advances it only after SQL reports due work', async () => {
    await enqueueModerationDeleteWakeup(queue, 'scheduled', 1, 60_000);
    const original = (await queue.getJob('mdi-scheduled'))!;
    await enqueueModerationDeleteWakeup(queue, 'scheduled', 10, 120_000);
    const preserved = (await queue.getJob('mdi-scheduled'))!;
    expect(preserved.timestamp).toBe(original.timestamp);
    expect(preserved.delay).toBe(60_000);
    expect(preserved.priority).toBe(1);
    expect(await preserved.getState()).toBe('delayed');
    await expect(handoffModerationDeleteSweepJobs(queue, ['scheduled'], 10)).resolves.toEqual([
      { status: 'fulfilled', value: { insertion: 'existing', reused: true, observationErrors: 0 } },
    ]);
    expect(await preserved.getState()).toBe('prioritized');
    expect((await queue.getJob('mdi-scheduled'))!.priority).toBe(1);
  });

  it('wakes a newly urgent reason immediately without creating a second job', async () => {
    await enqueueModerationDeleteWakeup(queue, 'urgent-reason', 10, 60_000);
    await enqueueModerationDeleteWakeup(queue, 'urgent-reason', 1);
    const persisted = (await queue.getJob('mdi-urgent-reason'))!;
    expect(persisted.priority).toBe(1);
    expect(await persisted.getState()).toBe('prioritized');
    expect(await queue.getJobCounts('delayed', 'prioritized')).toMatchObject({
      delayed: 0,
      prioritized: 1,
    });
  });

  it('preserves an active job when delayed promotion races the SQL handoff', async () => {
    await enqueueModerationDeleteWakeup(queue, 'promotion-race', 1, 60_000);
    const started = deferred();
    const release = deferred();
    let starts = 0;
    await interceptNextBatchRead(async (results) => {
      await (await queue.getJob('mdi-promotion-race'))!.promote();
      worker = new Worker<ModerationDeleteIntentJob>(
        MODERATION_DELETE_INTENT_QUEUE,
        async () => {
          starts++;
          started.resolve();
          await release.promise;
        },
        { connection, prefix },
      );
      await started.promise;
      return results;
    });
    try {
      const results = await handoffModerationDeleteSweepJobs(queue, ['promotion-race'], 10);
      expect(results[0]).toMatchObject({ status: 'fulfilled', value: { reused: true } });
      expect(await (await queue.getJob('mdi-promotion-race'))!.getState()).toBe('active');
      expect(starts).toBe(1);
    } finally {
      release.resolve();
    }
  });

  it('serves a fresh scheduled wakeup before 600000 retained jobs and then progresses background work', async () => {
    for (let offset = 0; offset < 600_000; offset += 1000) {
      await queue.addBulk(
        Array.from({ length: 1000 }, (_, index) => {
          const intentId = `retained-${offset + index}`;
          return {
            name: 'execute-moderation-delete-intent',
            data: { intentId },
            opts: { jobId: `mdi-${intentId}`, priority: 10, removeOnComplete: true },
          };
        }),
      );
    }
    expect(await queue.getJobCounts('prioritized')).toMatchObject({ prioritized: 600_000 });
    const historicalAdds = jest.spyOn(queue, 'add');
    const admission = await handoffModerationDeleteSweepJobs(
      queue,
      ['retained-0', ...Array.from({ length: 99 }, (_, i) => `missing-history-${i}`)],
      10,
      1000,
    );
    expect(admission[0]).toMatchObject({ status: 'fulfilled', value: { reused: true } });
    expect(
      admission
        .slice(1)
        .every((result) => result.status === 'fulfilled' && result.value.insertion === 'deferred'),
    ).toBe(true);
    expect(historicalAdds).not.toHaveBeenCalled();
    await enqueueModerationDeleteWakeup(queue, 'fresh', 1, 200);
    const scheduled = (await queue.getJob('mdi-fresh'))!;
    expect(await scheduled.getState()).toBe('delayed');
    await new Promise((resolve) => setTimeout(resolve, 250));
    const completed = deferred();
    const handled: string[] = [];
    let completions = 0;
    worker = new Worker<ModerationDeleteIntentJob>(
      MODERATION_DELETE_INTENT_QUEUE,
      async (job) => {
        handled.push(job.data.intentId);
        if (handled.length === 2) await worker!.pause(true);
      },
      { connection, prefix, concurrency: 1 },
    );
    worker.on('completed', () => {
      if (++completions === 2) completed.resolve();
    });
    await completed.promise;
    expect(handled).toEqual(['fresh', 'retained-0']);
  }, 120_000);

  it('shares a bounded window between concurrent schedulers while fresh work bypasses it', async () => {
    const results = await Promise.all(
      Array.from({ length: 4 }, (_, scheduler) =>
        handoffModerationDeleteSweepJobs(
          queue,
          Array.from({ length: 20 }, (_, i) => `scheduler-${scheduler}-${i}`),
          10,
          25,
        ),
      ),
    );
    const outcomes = results.flat().map((result) => {
      if (result.status === 'rejected') throw result.reason;
      return result.value;
    });
    expect(outcomes.filter((result) => result.insertion === 'inserted')).toHaveLength(25);
    expect(outcomes.filter((result) => result.insertion === 'deferred')).toHaveLength(55);
    expect(await queue.getJobCounts('prioritized')).toMatchObject({ prioritized: 25 });
    await enqueueModerationDeleteWakeup(queue, 'fresh-over-window', 1);
    expect(await queue.getJobCounts('prioritized')).toMatchObject({ prioritized: 26 });
    const jobs = await queue.getJobs(['prioritized'], 0, 1);
    await jobs[0]!.remove();
    await jobs[1]!.remove();
    await expect(
      handoffModerationDeleteSweepJobs(queue, ['recovered-capacity'], 10, 25),
    ).resolves.toMatchObject([{ status: 'fulfilled', value: { insertion: 'inserted' } }]);
  });

  it('counts delayed and paused work but repairs existing jobs even at capacity', async () => {
    await enqueueModerationDeleteWakeup(queue, 'delayed', 10, 60_000);
    await queue.pause();
    await queue.add('inert', { intentId: 'paused' }, { jobId: 'mdi-paused' });
    await expect(
      handoffModerationDeleteSweepJobs(queue, ['missing', 'delayed', 'paused'], 10, 2),
    ).resolves.toMatchObject([
      { status: 'fulfilled', value: { insertion: 'deferred', reused: false } },
      { status: 'fulfilled', value: { insertion: 'existing', reused: true } },
      { status: 'fulfilled', value: { insertion: 'existing', reused: true } },
    ]);
    expect(await (await queue.getJob('mdi-delayed'))!.getState()).toBe('prioritized');
  });

  it('retains admission after an unknown add and resumes after bounded permit expiry', async () => {
    const add = jest
      .spyOn(queue, 'add')
      .mockRejectedValueOnce(new Error('synthetic unknown enqueue'));
    expect((await handoffModerationDeleteSweepJobs(queue, ['uncertain'], 10, 1))[0]!.status).toBe(
      'rejected',
    );
    const client = await queue.client;
    const key = queue.toKey('historical-admission-v1');
    expect(await client.zcard(key)).toBe(1);
    inspector = new Redis(redisUrl, { maxRetriesPerRequest: 0 });
    expect(await inspector.pttl(key)).toBeGreaterThan(0);
    await expect(handoffModerationDeleteSweepJobs(queue, ['later'], 10, 1)).resolves.toMatchObject([
      { status: 'fulfilled', value: { insertion: 'deferred' } },
    ]);
    expect(add).toHaveBeenCalledTimes(1);
    // FLAG: Advance only this disposable permit's expiry, without sleeping a minute.
    const [permit] = await client.zrange(key, 0, 0);
    await inspector.zadd(key, 0, permit!);
    await expect(
      handoffModerationDeleteSweepJobs(queue, ['uncertain'], 10, 1),
    ).resolves.toMatchObject([{ status: 'fulfilled', value: { insertion: 'inserted' } }]);
    expect(await client.zcard(key)).toBe(0);
  });

  it('fails closed for new history on admission failure and keeps existing repair', async () => {
    await enqueueModerationDeleteWakeup(queue, 'known', 10);
    const client = await queue.client;
    const original = client.runCommand;
    client.runCommand = jest.fn().mockRejectedValue(new Error('synthetic Redis outage'));
    clientRestorations.push(() => {
      client.runCommand = original;
    });
    const add = jest.spyOn(queue, 'add');
    const results = await handoffModerationDeleteSweepJobs(queue, ['missing', 'known'], 10, 1000);
    expect(results[0]!.status).toBe('rejected');
    expect(results[1]).toMatchObject({ status: 'fulfilled', value: { insertion: 'existing' } });
    expect(add).not.toHaveBeenCalled();
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

  it('preserves input order when a batch mixes legacy and missing jobs', async () => {
    await queue.addBulk(
      ['existing-first', 'existing-last'].map((intentId) => ({
        name: 'execute-moderation-delete-intent',
        data: { intentId },
        opts: { jobId: `mdi-${intentId}`, priority: 1, removeOnComplete: true },
      })),
    );
    const add = jest.spyOn(queue, 'add');
    const getJob = jest.spyOn(queue, 'getJob');
    const pipeline = await mockPipeline();

    await expect(
      handoffModerationDeleteSweepJobs(queue, ['existing-first', 'missing', 'existing-last'], 10),
    ).resolves.toEqual([
      { status: 'fulfilled', value: { insertion: 'existing', reused: true, observationErrors: 0 } },
      {
        status: 'fulfilled',
        value: { insertion: 'inserted', reused: false, observationErrors: 0 },
      },
      { status: 'fulfilled', value: { insertion: 'existing', reused: true, observationErrors: 0 } },
    ]);

    expect(pipeline).toHaveBeenCalledTimes(1);
    expect(add).toHaveBeenCalledTimes(1);
    expect(getJob).toHaveBeenCalledTimes(1);
    expect(getJob).toHaveBeenCalledWith('mdi-missing');
    for (const intentId of ['existing-first', 'existing-last']) {
      const preserved = (await queue.getJob(`mdi-${intentId}`))!;
      expect(preserved.data).toEqual({ intentId });
      expect(preserved.opts.priority).toBe(1);
    }
  });

  it('bounds pre-observation chunks without scalar reads or writes for reused jobs', async () => {
    const intentIds = Array.from({ length: 201 }, (_, index) => `chunk-${index}`);
    await queue.addBulk(
      intentIds.map((intentId) => ({
        name: 'execute-moderation-delete-intent',
        data: { intentId },
        opts: { jobId: `mdi-${intentId}`, priority: 1, removeOnComplete: true },
      })),
    );
    inspector = new Redis(redisUrl, { lazyConnect: true, maxRetriesPerRequest: 0 });
    await inspector.connect();
    const eventCount = await inspector.xlen(queue.toKey('events'));
    const client = await queue.client;
    const createPipeline = client.pipeline.bind(client);
    const batchSizes: number[] = [];
    (await mockPipeline()).mockImplementation(() => {
      const pipeline = createPipeline();
      const reads = jest.spyOn(pipeline, 'hgetall');
      const execute = pipeline.exec.bind(pipeline);
      jest.spyOn(pipeline, 'exec').mockImplementation(async () => {
        batchSizes.push(reads.mock.calls.length);
        return execute();
      });
      return pipeline;
    });
    const getJob = jest.spyOn(queue, 'getJob');
    const add = jest.spyOn(queue, 'add');

    const results = await handoffModerationDeleteSweepJobs(queue, intentIds, 10);

    expect(results).toHaveLength(201);
    expect(results.every((result) => result.status === 'fulfilled' && result.value.reused)).toBe(
      true,
    );
    expect(batchSizes).toEqual([100, 100, 1]);
    expect(getJob).not.toHaveBeenCalled();
    expect(add).not.toHaveBeenCalled();
    expect(await inspector.xlen(queue.toKey('events'))).toBe(eventCount);
    expect(await queue.getJobCounts('prioritized')).toMatchObject({ prioritized: 201 });
  });

  it('does not open a pipeline for an empty batch', async () => {
    const pipeline = await mockPipeline();
    const add = jest.spyOn(queue, 'add');

    await expect(handoffModerationDeleteSweepJobs(queue, [], 10)).resolves.toEqual([]);

    expect(pipeline).not.toHaveBeenCalled();
    expect(add).not.toHaveBeenCalled();
  });

  it.each(['command-error', 'malformed-hash', 'invalid-json'] as const)(
    'isolates a %s observation from healthy entries in the same batch',
    async (failure) => {
      for (const intentId of ['healthy-before', 'damaged-observation', 'healthy-after']) {
        await queue.add(
          'execute-moderation-delete-intent',
          { intentId },
          { jobId: `mdi-${intentId}`, priority: 1, removeOnComplete: true },
        );
      }
      await interceptNextBatchRead((results) => {
        if (!results) throw new Error('Expected a real Redis pipeline response');
        if (failure === 'command-error') results[1] = [new Error('read unavailable'), null];
        if (failure === 'malformed-hash') results[1] = [null, { name: 'incomplete' }];
        if (failure === 'invalid-json') {
          const encoded = results[1]![1];
          if (!encoded || typeof encoded !== 'object') throw new Error('Expected Redis hash');
          results[1] = [null, { ...encoded, data: '{invalid-json' }];
        }
        return results;
      });
      const add = jest.spyOn(queue, 'add');

      await expect(
        handoffModerationDeleteSweepJobs(
          queue,
          ['healthy-before', 'damaged-observation', 'healthy-after'],
          10,
        ),
      ).resolves.toEqual([
        {
          status: 'fulfilled',
          value: { insertion: 'existing', reused: true, observationErrors: 0 },
        },
        {
          status: 'fulfilled',
          value: { insertion: 'unknown', reused: false, observationErrors: 1 },
        },
        {
          status: 'fulfilled',
          value: { insertion: 'existing', reused: true, observationErrors: 0 },
        },
      ]);
      expect(add).toHaveBeenCalledTimes(1);
      expect(add.mock.calls[0]![1].intentId).toBe('damaged-observation');
      const preserved = (await queue.getJob('mdi-damaged-observation'))!;
      expect(preserved.data).toEqual({ intentId: 'damaged-observation' });
      expect(preserved.opts.priority).toBe(1);
    },
  );

  it.each(['throw', 'null', 'length-mismatch'] as const)(
    'falls back to deterministic add for every entry after a %s pipeline response',
    async (failure) => {
      await interceptNextBatchRead((results) => {
        if (failure === 'throw') throw new Error('pipeline unavailable');
        if (failure === 'null') return null;
        return results?.slice(1) ?? [];
      });
      const add = jest.spyOn(queue, 'add');

      await expect(
        handoffModerationDeleteSweepJobs(queue, ['fallback-first', 'fallback-last'], 10),
      ).resolves.toEqual([
        {
          status: 'fulfilled',
          value: { insertion: 'inserted', reused: false, observationErrors: 1 },
        },
        {
          status: 'fulfilled',
          value: { insertion: 'inserted', reused: false, observationErrors: 1 },
        },
      ]);
      expect(add).toHaveBeenCalledTimes(2);
      expect(await queue.getJob('mdi-fallback-first')).toBeDefined();
      expect(await queue.getJob('mdi-fallback-last')).toBeDefined();
    },
  );

  it('repairs a job removed after a bulk observation on the next sweep', async () => {
    const existing = await queue.add(
      'execute-moderation-delete-intent',
      { intentId: 'vanished-batch-intent' },
      { jobId: 'mdi-vanished-batch-intent', priority: 1, removeOnComplete: true },
    );
    await interceptNextBatchRead(async (results) => {
      await existing.remove();
      return results;
    });

    await expect(
      handoffModerationDeleteSweepJobs(queue, ['vanished-batch-intent'], 10),
    ).resolves.toEqual([
      { status: 'fulfilled', value: { insertion: 'existing', reused: true, observationErrors: 0 } },
    ]);
    expect(await queue.getJob('mdi-vanished-batch-intent')).toBeUndefined();
    await expect(
      handoffModerationDeleteSweepJobs(queue, ['vanished-batch-intent'], 10),
    ).resolves.toEqual([
      {
        status: 'fulfilled',
        value: { insertion: 'inserted', reused: false, observationErrors: 0 },
      },
    ]);
  });

  it('preserves a replacement when a batch insertion completes before its final observation', async () => {
    const completed = deferred();
    worker = new Worker<ModerationDeleteIntentJob>(
      MODERATION_DELETE_INTENT_QUEUE,
      async () => undefined,
      { connection, prefix },
    );
    worker.once('completed', () => completed.resolve());
    await worker.waitUntilReady();
    const add = queue.add.bind(queue);
    const replacementToken = randomUUID();
    jest.spyOn(queue, 'add').mockImplementationOnce(async (...args) => {
      const original = await add(...args);
      await completed.promise;
      await worker!.close();
      worker = undefined;
      await add(
        'execute-moderation-delete-intent',
        { intentId: 'batch-replacement', handoffToken: replacementToken },
        { jobId: 'mdi-batch-replacement', priority: 1, removeOnComplete: true },
      );
      return original;
    });

    await expect(
      handoffModerationDeleteSweepJobs(queue, ['batch-replacement'], 10),
    ).resolves.toEqual([
      { status: 'fulfilled', value: { insertion: 'unknown', reused: false, observationErrors: 0 } },
    ]);
    const replacement = (await queue.getJob('mdi-batch-replacement'))!;
    expect(replacement.data.handoffToken).toBe(replacementToken);
    expect(replacement.opts.priority).toBe(1);
    expect(await replacement.getState()).toBe('prioritized');
  });

  it('settles an add failure independently while other intents still receive wakeups', async () => {
    const add = queue.add.bind(queue);
    const unavailable = new Error('independent add unavailable');
    jest.spyOn(queue, 'add').mockImplementation(async (...args) => {
      if (args[1].intentId === 'failed-add') throw unavailable;
      return add(...args);
    });

    await expect(
      handoffModerationDeleteSweepJobs(
        queue,
        ['success-before', 'failed-add', 'success-after'],
        10,
      ),
    ).resolves.toEqual([
      {
        status: 'fulfilled',
        value: { insertion: 'inserted', reused: false, observationErrors: 0 },
      },
      { status: 'rejected', reason: unavailable },
      {
        status: 'fulfilled',
        value: { insertion: 'inserted', reused: false, observationErrors: 0 },
      },
    ]);
    expect(await queue.getJob('mdi-success-before')).toBeDefined();
    expect(await queue.getJob('mdi-failed-add')).toBeUndefined();
    expect(await queue.getJob('mdi-success-after')).toBeDefined();
  });
});
