import { DelayedError, Queue, QueueEvents, type Job, UnrecoverableError, Worker } from 'bullmq';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { from } from 'rxjs';
import { PrismaClient, createPrismaAdapter } from '../prisma/prisma-client';
import { MaxActionDispatchService } from './max-action-dispatch.service';
import { MaxActionLedgerService } from './max-action-ledger.service';
import { MaxActionInteractiveProcessor } from './max-action.processor';
import { MaxApiInternalRateLimitError } from './max-api-internal-rate-limit.error';
import { MaxClientService, type MaxActionJob } from './max-client.service';
import { markMaxApiCapacityRefusal } from './max-send-capacity-deferral';

const databaseUrl = process.env.CHAT_ROUTING_POSTGRES_RACE_DATABASE_URL?.trim() ?? '';
const redisUrl = process.env.MAXIM_TEST_REDIS_URL?.trim() ?? '';
const integration = databaseUrl && redisUrl ? describe : describe.skip;

type SendHarness = {
  executeQueuedSendMessage(
    action: MaxActionJob,
    attachments: Record<string, unknown>[],
    options: { botId: string },
  ): Promise<Record<string, unknown>>;
};

integration('Notice SEND capacity on locked Redis jobs and PostgreSQL ledger', () => {
  let db: PrismaClient;
  let ledger: MaxActionLedgerService;
  let queue: Queue<MaxActionJob>;
  let worker: Worker<MaxActionJob>;
  let queueOptions: { prefix: string; connection: { host: string; port: number } };
  const ids: string[] = [];
  const botId = `capacity-bot-${randomUUID()}`;
  const previousRole = process.env.APP_ROLE;

  beforeAll(async () => {
    const pg = new URL(databaseUrl);
    const cache = new URL(redisUrl);
    if (
      !['localhost', '127.0.0.1'].includes(pg.hostname) ||
      !pg.pathname.includes('race_test') ||
      !['localhost', '127.0.0.1'].includes(cache.hostname)
    )
      throw new Error('Local disposable PostgreSQL race_test and Redis required');
    db = new PrismaClient({
      adapter: createPrismaAdapter(databaseUrl, { max: 3, statement_timeout: 10_000 }),
    });
    await db.$connect();
    ledger = new MaxActionLedgerService(db as never);
    queueOptions = {
      prefix: `capacity-${randomUUID()}`,
      connection: { host: cache.hostname, port: Number(cache.port) },
    };
    queue = new Queue<MaxActionJob>('notice-capacity', queueOptions);
    worker = new Worker<MaxActionJob>('notice-capacity', async () => undefined, {
      ...queueOptions,
      autorun: false,
    });
    process.env.APP_ROLE = 'action';
  });

  afterEach(async () => {
    await queue.obliterate({ force: true });
    await db.maxActionLedgerEntry.deleteMany({ where: { jobId: { in: ids.splice(0) } } });
  });

  afterAll(async () => {
    await worker?.close();
    await queue?.close();
    await db?.$disconnect();
    if (previousRole === undefined) delete process.env.APP_ROLE;
    else process.env.APP_ROLE = previousRole;
  });

  async function enqueue(deadlineOffsetMs = 60_000, attempts = 2): Promise<Job<MaxActionJob>> {
    const now = Date.now();
    const id = `capacity-notice-${randomUUID()}`;
    ids.push(id);
    const data: MaxActionJob = {
      actionType: 'SEND_MESSAGE',
      botId,
      chatId: `capacity-chat-${randomUUID()}`,
      text: 'Synthetic notice with no external network',
      sourceTag: 'moderation_notice',
      idempotencyKey: id,
      attempt: 1,
      createdAt: new Date(now).toISOString(),
      ledgerContext: {
        moderationRuleNotice: {
          version: 1,
          chatId: '',
          messageId: `source-${id}`,
          userId: `subject-${id}`,
          reasonKey: 'VOICE_BLOCKED_DELETE',
          ruleCode: 'VOICE',
          policySha256: 'a'.repeat(64),
          deadlineAtMs: now + deadlineOffsetMs,
        },
      },
    };
    data.ledgerContext!.moderationRuleNotice = {
      ...(data.ledgerContext!.moderationRuleNotice as Record<string, string | number>),
      chatId: data.chatId,
    };
    await ledger.recordEnqueuedIfAbsent(data, new Date(now));
    return queue.add('send', data, {
      jobId: id,
      attempts,
      backoff: { type: 'fixed', delay: 10 },
    });
  }

  function harness() {
    let denyCapacity = true;
    let allowed = true;
    const request = jest.fn(async () => ({ message_id: `remote-${randomUUID()}` }));
    const guard = jest.fn(
      async (
        job: MaxActionJob,
        _bot: string,
        _readers: unknown,
        checkpoint?: () => Promise<void>,
      ) => {
        const proof = job.ledgerContext!.moderationRuleNotice as { deadlineAtMs: number };
        if (!allowed || Date.now() >= proof.deadlineAtMs)
          throw new UnrecoverableError('Final notice authority expired or revoked');
        await checkpoint?.();
        if (!allowed || Date.now() >= proof.deadlineAtMs)
          throw new UnrecoverableError('Final notice authority expired or revoked');
      },
    );
    // FLAG: Real SEND/fence, ledger and locked BullMQ transitions run here. Only
    // external MAX and the unchanged feature-authority boundary use synthetic doubles.
    const client = Object.assign(Object.create(MaxClientService.prototype), {
      actionLedgerService: ledger,
      mutationExecutionScope: new AsyncLocalStorage(),
      priorityHttpSource: new AsyncLocalStorage(),
      recordPriorityHttpAttempt: () => undefined,
      muteApiBudget: { consumeRequest: () => undefined, assertRequestAllowed: () => undefined },
      baseUrl: 'https://notice-capacity.invalid',
      getCurrentBot: () => ({ id: botId, token: 'synthetic-no-network-token' }),
      botRegistry: { getPublisherBotDescriptor: () => ({ id: 'unused-publisher' }) },
      moderationRuleNoticeGuard: { assertAllowed: guard },
      reserveRateLimitSlot: async (selectedBotId: string, chatId: string | null) => {
        if (!denyCapacity) return;
        throw markMaxApiCapacityRefusal(
          new MaxApiInternalRateLimitError('Synthetic shared token capacity', 250, 'bot'),
          { botId: selectedBotId, chatId, operation: 'send' },
        );
      },
      executeMutation: (_chat: string, run: () => Promise<unknown>) => run(),
      httpService: {
        request: (options: { method: string; url: string }) => {
          if (
            options.method !== 'post' ||
            options.url !== 'https://notice-capacity.invalid/messages'
          )
            throw new Error('Fixture refuses non-synthetic MAX HTTP');
          return from(request().then((data) => ({ status: 200, data })));
        },
      },
      logger: { warn: jest.fn() },
    }) as SendHarness;
    const max = {
      executeActionJob: async (job: MaxActionJob) => {
        const result = await client.executeQueuedSendMessage(job, [], { botId });
        return { messageId: String(result.message_id), url: null };
      },
    } satisfies Pick<MaxClientService, 'executeActionJob'>;
    const dispatcher = new MaxActionDispatchService(max as never, undefined, ledger);
    const processor = new MaxActionInteractiveProcessor(dispatcher);
    const processJob = processor.process.bind(processor) as (
      job: Job<MaxActionJob>,
      token: string,
    ) => Promise<unknown>;
    return {
      request,
      guard,
      processJob,
      releaseCapacity: () => {
        denyCapacity = false;
      },
      revoke: () => {
        allowed = false;
      },
    };
  }

  it('preserves the locked job identity and attempts, permits independent work, then sends once', async () => {
    const original = await enqueue();
    const independent = await enqueue();
    const originalData = JSON.stringify(original.data);
    const f = harness();
    const events = new QueueEvents(queue.name, queueOptions);
    const entries: Array<{ id: string | undefined; attempts: number; timestamp: number }> = [];
    const completed: Array<string | undefined> = [];
    let deferred = 0;
    const running = new Worker<MaxActionJob>(
      queue.name,
      async (job, token) => {
        entries.push({ id: job.id, attempts: job.attemptsMade, timestamp: job.timestamp });
        try {
          return await f.processJob(job, token!);
        } catch (error) {
          if (error instanceof DelayedError) {
            deferred += 1;
            expect(await job.getState()).toBe('delayed');
            expect(f.request).not.toHaveBeenCalled();
            expect(
              await db.maxActionLedgerEntry.findUniqueOrThrow({
                where: { jobId: job.data.idempotencyKey },
              }),
            ).toMatchObject({
              status: 'FAILED_RETRYABLE',
              terminal: false,
              ambiguous: false,
              dispatchToken: null,
              dispatchStartedAt: null,
            });
            f.releaseCapacity();
          }
          throw error;
        }
      },
      { ...queueOptions, autorun: false },
    );
    running.on('completed', (job) => {
      completed.push(job.id);
    });
    running.on('error', () => undefined);
    await events.waitUntilReady();
    const execution = running.run();
    try {
      await Promise.all([
        original.waitUntilFinished(events, 10_000),
        independent.waitUntilFinished(events, 10_000),
      ]);
      // FLAG: Redis completion can reach QueueEvents before the Worker's local
      // completed event. Observe both identities before asserting their local order.
      await new Promise<void>((resolve, reject) => {
        const onCompleted = () => {
          if (!completed.includes(original.id) || !completed.includes(independent.id)) return;
          clearTimeout(deadline);
          running.off('completed', onCompleted);
          resolve();
        };
        const deadline = setTimeout(() => {
          running.off('completed', onCompleted);
          reject(new Error('Missing local Worker completion observation'));
        }, 5_000);
        running.on('completed', onCompleted);
        onCompleted();
      });
      expect(deferred).toBe(1);
      expect(completed).toEqual([independent.id, original.id]);
      expect(entries.filter((entry) => entry.id === original.id)).toEqual([
        { id: original.id, attempts: 0, timestamp: original.timestamp },
        { id: original.id, attempts: 0, timestamp: original.timestamp },
      ]);
      expect((await queue.getJob(original.id!))!.data).toEqual(JSON.parse(originalData));
      expect(f.request).toHaveBeenCalledTimes(2);
      expect(
        await db.maxActionLedgerEntry.findUniqueOrThrow({
          where: { jobId: original.data.idempotencyKey },
        }),
      ).toMatchObject({
        status: 'SUCCEEDED',
        terminal: true,
        ambiguous: false,
      });
    } finally {
      await running.close();
      await execution;
      await events.close();
    }
  }, 15_000);

  it('expires an elapsed original proof without HTTP or another capacity deferral', async () => {
    const original = await enqueue();
    const f = harness();
    const active = (await worker.getNextJob('capacity-lock'))!;
    await expect(f.processJob(active, 'capacity-lock')).rejects.toBeInstanceOf(DelayedError);
    await new Promise((resolve) => setTimeout(resolve, 275));
    const retry = (await worker.getNextJob('expired-lock'))!;
    const proof = original.data.ledgerContext!.moderationRuleNotice as { deadlineAtMs: number };
    const clock = jest.spyOn(Date, 'now').mockReturnValue(proof.deadlineAtMs + 1);
    try {
      await expect(f.processJob(retry, 'expired-lock')).rejects.toBeInstanceOf(UnrecoverableError);
    } finally {
      clock.mockRestore();
    }
    expect(retry.data.ledgerContext).toEqual(original.data.ledgerContext);
    expect(f.request).not.toHaveBeenCalled();
    expect(
      await db.maxActionLedgerEntry.findUniqueOrThrow({
        where: { jobId: original.data.idempotencyKey },
      }),
    ).toMatchObject({
      terminal: true,
      ambiguous: false,
      dispatchToken: null,
      remoteMessageId: null,
    });
  }, 15_000);

  it('uses ordinary Worker attempts after a definitive HTTP rate rejection', async () => {
    const original = await enqueue();
    const f = harness();
    f.releaseCapacity();
    f.request.mockRejectedValueOnce(
      Object.assign(new Error('Synthetic HTTP rate rejection'), {
        response: { status: 429, data: { code: 'too.many.requests' } },
      }),
    );
    const events = new QueueEvents(queue.name, queueOptions);
    const attempts: number[] = [];
    const running = new Worker<MaxActionJob>(
      queue.name,
      async (job, token) => {
        attempts.push(job.attemptsMade);
        return f.processJob(job, token!);
      },
      { ...queueOptions, autorun: false },
    );
    running.on('error', () => undefined);
    await events.waitUntilReady();
    const execution = running.run();
    try {
      await original.waitUntilFinished(events, 10_000);
      expect(attempts).toEqual([0, 1]);
      expect(f.request).toHaveBeenCalledTimes(2);
      expect(
        await db.maxActionLedgerEntry.findUniqueOrThrow({
          where: { jobId: original.data.idempotencyKey },
        }),
      ).toMatchObject({
        status: 'SUCCEEDED',
        terminal: true,
        ambiguous: false,
      });
    } finally {
      await running.close();
      await execution;
      await events.close();
    }
  }, 15_000);

  it('rechecks revoked final authority after delay without HTTP or a renewed deadline', async () => {
    const original = await enqueue();
    const f = harness();
    const active = (await worker.getNextJob('capacity-lock'))!;
    await expect(f.processJob(active, 'capacity-lock')).rejects.toBeInstanceOf(DelayedError);
    f.releaseCapacity();
    f.revoke();
    await new Promise((resolve) => setTimeout(resolve, 275));
    const retry = (await worker.getNextJob('revoked-lock'))!;
    await expect(f.processJob(retry, 'revoked-lock')).rejects.toBeInstanceOf(UnrecoverableError);
    expect(retry.data.ledgerContext).toEqual(original.data.ledgerContext);
    expect(f.request).not.toHaveBeenCalled();
    expect(
      await db.maxActionLedgerEntry.findUniqueOrThrow({
        where: { jobId: retry.data.idempotencyKey },
      }),
    ).toMatchObject({
      terminal: true,
      ambiguous: false,
      dispatchToken: null,
      remoteMessageId: null,
    });
  }, 15_000);

  it('rejects a wrong actual Redis lock without acknowledging a delayed transition', async () => {
    await enqueue();
    const f = harness();
    const active = (await worker.getNextJob('owned-lock'))!;
    const error: unknown = await f
      .processJob(active, 'wrong-lock')
      .catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(DelayedError);
    expect(await active.getState()).toBe('active');
    expect(active.attemptsMade).toBe(0);
    expect(f.request).not.toHaveBeenCalled();
  }, 15_000);

  it('settles final-attempt expiry when the real retry-state write crosses its original deadline', async () => {
    const original = await enqueue(60_000, 1);
    const proof = original.data.ledgerContext!.moderationRuleNotice as { deadlineAtMs: number };
    const f = harness();
    const recordFailed = ledger.recordFailed.bind(ledger);
    let clock: jest.SpyInstance<number, []> | undefined;
    const persistence = jest
      .spyOn(ledger, 'recordFailed')
      .mockImplementationOnce(async (...args) => {
        await recordFailed(...args);
        clock = jest.spyOn(Date, 'now').mockReturnValue(proof.deadlineAtMs + 1);
      });
    try {
      const active = (await worker.getNextJob('slow-write-lock'))!;
      const timestamp = active.timestamp;
      await expect(f.processJob(active, 'slow-write-lock')).rejects.toBeInstanceOf(DelayedError);
      expect(await active.getState()).toBe('delayed');
      expect(persistence.mock.calls[0]![2]).toEqual({ exhausted: false });
      const retry = (await worker.getNextJob('past-due-reentry-lock'))!;
      expect(retry.id).toBe(original.id);
      expect(retry.timestamp).toBe(timestamp);
      expect(retry.attemptsMade).toBe(0);
      expect(retry.data.ledgerContext).toEqual(original.data.ledgerContext);
      await expect(f.processJob(retry, 'past-due-reentry-lock')).rejects.toBeInstanceOf(
        UnrecoverableError,
      );
      expect(f.request).not.toHaveBeenCalled();
      expect(
        await db.maxActionLedgerEntry.findUniqueOrThrow({
          where: { jobId: original.data.idempotencyKey },
        }),
      ).toMatchObject({
        status: 'FAILED_TERMINAL',
        terminal: true,
        ambiguous: false,
        dispatchToken: null,
        remoteMessageId: null,
      });
    } finally {
      clock?.mockRestore();
      persistence.mockRestore();
    }
  }, 15_000);
});
