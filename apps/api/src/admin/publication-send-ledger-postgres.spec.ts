import { ActionLatencyService } from '../system/action-latency.service';
import { createMaxSendObservation } from '../max/max-send-observation';
import { ConfigService } from '@nestjs/config';
import { Logger } from '@nestjs/common';
import { Queue, UnrecoverableError } from 'bullmq';
import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import Redis from 'ioredis';
import { from } from 'rxjs';
import { MaxActionLedgerService } from '../max/max-action-ledger.service';
import { MaxClientService, type MaxActionJob } from '../max/max-client.service';
import { Prisma, PrismaClient, createPrismaAdapter } from '../prisma/prisma-client';
import {
  PublisherDispatchDisabledError,
  PublisherRuntimeBoundaryService,
} from '../publisher/publisher-runtime-boundary.service';
import { markManagedBroadcastSendPhase } from './admin-managed-broadcast-reconciliation';
import { buildPublicationDeliveryActionKey } from './publication-delivery-action-key';
import { deferPublicationDeliveryAfterPreDispatchThrottle } from './publication-execution-recovery';
import {
  classifyPublicationSendFailure,
  persistPublicationSendFailure,
} from './publication-send-failure';

const databaseUrl = process.env.CHAT_ROUTING_POSTGRES_RACE_DATABASE_URL?.trim() ?? '';
const redisUrl = process.env.MAXIM_TEST_REDIS_URL?.trim() ?? '';
const integration = databaseUrl && redisUrl ? describe : describe.skip;

type SendHarness = {
  executeQueuedSendMessage: (
    job: MaxActionJob,
    attachments: Record<string, unknown>[],
    options: { botId: string },
    beforeMutation?: () => Promise<void>,
  ) => Promise<Record<string, unknown>>;
};

integration('Publication send fences on real PostgreSQL and Redis', () => {
  let db: PrismaClient;
  let redis: Redis;
  let queue: Queue<MaxActionJob>;
  let ledger: MaxActionLedgerService;
  let job: MaxActionJob;
  let request: jest.Mock;
  let observations: Array<Parameters<Parameters<typeof createMaxSendObservation>[1]>[0]>;
  const botId = `publisher-send-test-${randomUUID()}`;
  const prefix = `publication-send-test-${randomUUID()}`;
  const ownedLedgerIds: string[] = [];
  const ownedPublicationIds: string[] = [];
  const ownedChatIds: string[] = [];

  beforeAll(async () => {
    const pg = new URL(databaseUrl);
    const cache = new URL(redisUrl);
    if (
      !['localhost', '127.0.0.1'].includes(pg.hostname) ||
      !pg.pathname.includes('race_test') ||
      !['localhost', '127.0.0.1'].includes(cache.hostname)
    ) {
      throw new Error('Local disposable PostgreSQL race_test and Redis required');
    }
    db = new PrismaClient({
      adapter: createPrismaAdapter(databaseUrl, { max: 3, statement_timeout: 10_000 }),
    });
    await db.$connect();
    redis = new Redis(redisUrl, { maxRetriesPerRequest: 1 });
    queue = new Queue('publication-send-restore', {
      prefix,
      connection: { host: cache.hostname, port: Number(cache.port) },
    });
    ledger = new MaxActionLedgerService(db as never);
  });

  beforeEach(async () => {
    ownedLedgerIds.length = 0;
    ownedPublicationIds.length = 0;
    ownedChatIds.length = 0;
    observations = [];
    job = {
      actionType: 'SEND_MESSAGE',
      chatId: `publication-chat-${randomUUID()}`,
      botId,
      text: 'Synthetic publication receipt fixture',
      attempt: 1,
      idempotencyKey: `publication-send-${randomUUID()}`,
      createdAt: new Date().toISOString(),
      sourceTag: 'managed_broadcast',
      routing: { purpose: 'send_message', requiredBotId: botId },
    } as MaxActionJob;
    ownedLedgerIds.push(job.idempotencyKey);
    await ledger.recordStarted(job);
    await ledger.recordPrepared(job);
    await queue.add('send', job, { jobId: job.idempotencyKey });
    request = jest.fn().mockResolvedValue({ message_id: `remote-${job.idempotencyKey}` });
  });

  afterEach(async () => {
    await queue.obliterate({ force: true });
    await db.maxActionLedgerEntry.deleteMany({ where: { jobId: { in: ownedLedgerIds } } });
    await db.publication.deleteMany({ where: { id: { in: ownedPublicationIds } } });
    await db.chat.deleteMany({ where: { id: { in: ownedChatIds } } });
  });

  afterAll(async () => {
    await queue?.close();
    await redis?.quit();
    await db?.$disconnect();
  });

  it('persists scalar schedule admission through real ledger create and preparation updates', async () => {
    const initial = await db.maxActionLedgerEntry.findUniqueOrThrow({
      where: { jobId: job.idempotencyKey },
    });
    expect(initial).toMatchObject({
      scheduleClockState: 'UNSCHEDULED',
      scheduledForAt: null,
      enqueuedAt: null,
    });
    const scheduledFor = '2026-11-08T19:00:00.100Z';
    await ledger.recordPrepared({ ...job, scheduledFor });
    expect(
      await db.maxActionLedgerEntry.findUniqueOrThrow({ where: { jobId: job.idempotencyKey } }),
    ).toMatchObject({
      scheduleClockState: 'VALID',
      scheduledForAt: new Date(scheduledFor),
      enqueuedAt: null,
    });
    await ledger.recordPrepared({ ...job, scheduledFor: '2026-02-30T19:00:00.000Z' });
    expect(
      await db.maxActionLedgerEntry.findUniqueOrThrow({ where: { jobId: job.idempotencyKey } }),
    ).toMatchObject({
      scheduleClockState: 'INVALID',
      scheduledForAt: null,
      enqueuedAt: null,
    });
    expect(request).not.toHaveBeenCalled();
  });

  it('dashboard measures scalar readiness with compressed metadata and excludes its legacy peer', async () => {
    const sourceTag = `clock-native-${randomUUID()}`;
    const legacyJobId = `${job.idempotencyKey}-legacy`;
    const anchor = Date.now() - 5_000;
    const scheduledForAt = new Date(anchor - 700);
    const metadata = {
      scheduledFor: scheduledForAt.toISOString(),
      padding: 'private-padding-'.repeat(4000),
    };
    const clocks = {
      enqueuedAt: new Date(anchor - 1000),
      lastAttemptAt: new Date(anchor - 400),
      completedAt: new Date(anchor),
    };
    try {
      await db.maxActionLedgerEntry.update({
        where: { jobId: job.idempotencyKey },
        data: {
          ...clocks,
          sourceTag,
          status: 'SUCCEEDED',
          terminal: true,
          scheduleClockState: 'VALID',
          scheduledForAt,
          metadata,
        },
      });
      await db.maxActionLedgerEntry.create({
        data: {
          ...clocks,
          jobId: legacyJobId,
          actionType: 'SEND_MESSAGE',
          chatId: job.chatId,
          sourceTag,
          status: 'SUCCEEDED',
          terminal: true,
          metadata,
        },
      });
      const storage = await db.$queryRaw<Array<{ compression: string | null }>>`
        SELECT pg_column_compression(metadata)::text AS compression FROM max_action_ledger
        WHERE job_id=${job.idempotencyKey}
      `;
      expect(storage[0]?.compression).not.toBeNull();
      const service = new ActionLatencyService(db as never, { get: () => undefined } as never);
      const snapshot = await service.getSnapshot();
      const group = snapshot.bySource.find((entry) => entry.key === sourceTag);
      expect(group).toMatchObject({
        rowCount: 2,
        effectiveReadyToTerminal: { sampleCount: 1, excludedCount: 1, p50Ms: 700 },
        effectiveReadyToLastAttempt: { sampleCount: 1, excludedCount: 1, p50Ms: 300 },
        lastAttemptToTerminal: { sampleCount: 2, excludedCount: 0, p50Ms: 400 },
      });
      expect(request).not.toHaveBeenCalled();
    } finally {
      await db.maxActionLedgerEntry.deleteMany({ where: { jobId: legacyJobId } });
    }
  });

  function client(selectedLedger = ledger): SendHarness {
    const priorityHttpSource: MaxClientService['priorityHttpSource'] = new AsyncLocalStorage();
    const recordPriorityHttpAttempt: MaxClientService['recordPriorityHttpAttempt'] = () =>
      undefined;
    const muteApiBudget: Pick<
      MaxClientService['muteApiBudget'],
      'consumeRequest' | 'assertRequestAllowed'
    > = {
      consumeRequest: () => undefined,
      assertRequestAllowed: () => undefined,
    };
    // FLAG: Exercise the production send/receipt boundary; only MAX HTTP and
    // unrelated route/rate scheduling are replaced. No network send is available.
    return Object.assign(Object.create(MaxClientService.prototype), {
      actionLedgerService: selectedLedger,
      mutationExecutionScope: new AsyncLocalStorage(),
      priorityHttpSource,
      muteApiBudget,
      recordPriorityHttpAttempt,
      baseUrl: 'https://publication-send-harness.invalid',
      getCurrentBot: () => ({ id: botId, token: 'synthetic-no-network-token' }),
      botRegistry: { getPublisherBotDescriptor: () => ({ id: botId }) },
      reserveRateLimitSlot: jest.fn().mockResolvedValue(undefined),
      executeMutation: (_chatId: string, run: () => Promise<Record<string, unknown>>) => run(),
      httpService: {
        request: (options: { method: string; url: string }) => {
          if (
            options.method !== 'post' ||
            options.url !== 'https://publication-send-harness.invalid/messages'
          )
            throw new Error('Publication fixture refuses non-synthetic MAX HTTP');
          return from(request(options).then((data: unknown) => ({ status: 200, data })));
        },
      },
      logger: { warn: jest.fn() },
    }) as SendHarness;
  }

  function observedSend(selectedLedger = ledger): Promise<Record<string, unknown>> {
    return createMaxSendObservation(
      { mode: 'NOW', media: 'none', lane: 'interactive' },
      (event) => {
        observations.push(event);
      },
    ).run(job.idempotencyKey, () =>
      client(selectedLedger).executeQueuedSendMessage(job, [], { botId }),
    );
  }

  async function snapshotQueue(): Promise<Array<{ key: string; value: Buffer }>> {
    const keys: string[] = [];
    let cursor = '0';
    do {
      const page = await redis.scan(cursor, 'MATCH', `${prefix}:${queue.name}:*`, 'COUNT', 64);
      cursor = page[0];
      keys.push(...page[1]);
      if (keys.length > 64) throw new Error('Synthetic queue exceeded snapshot bound');
    } while (cursor !== '0');
    return Promise.all(
      [...new Set(keys)].map(async (key) => {
        const value = await redis.dumpBuffer(key);
        if (!value) throw new Error('Synthetic queue key disappeared');
        return { key, value };
      }),
    );
  }

  async function restoreQueue(
    snapshot: Awaited<ReturnType<typeof snapshotQueue>>,
    queueJobId = job.idempotencyKey,
  ): Promise<void> {
    await queue.obliterate({ force: true });
    for (const { key, value } of snapshot) {
      await redis.restore(key, 0, value, 'REPLACE');
    }
    expect((await queue.getJob(queueJobId))?.data).toEqual(job);
  }

  async function createPublicationDelivery() {
    const chatId = `native-failure-${randomUUID()}`;
    await db.chat.create({ data: { id: chatId, title: 'Native delivery failure fixture' } });
    ownedChatIds.push(chatId);
    const publication = await db.publication.create({
      data: {
        actorUserId: 'native-delivery-fixture',
        requestId: randomUUID(),
        lifecycle: 'ACTIVE',
        dispatchProfile: 'PUBLIK_V1',
        requiredBotId: botId,
        schedule: {
          create: { mode: 'NOW', status: 'ACTIVE', rule: { mode: 'now', timezone: 'UTC' } },
        },
      },
      include: { schedule: true },
    });
    ownedPublicationIds.push(publication.id);
    const content = await db.publicationContentRevision.create({
      data: { publicationId: publication.id, revision: 1, text: 'Native failure fixture' },
    });
    await db.publication.update({
      where: { id: publication.id },
      data: { canonicalContentRevisionId: content.id },
    });
    const scheduledAt = new Date();
    const deliveryDeadlineAt = new Date(scheduledAt.getTime() + 86_400_000);
    const occurrence = await db.publicationOccurrence.create({
      data: {
        publicationId: publication.id,
        scheduleId: publication.schedule!.id,
        scheduleRevision: publication.schedule!.revision,
        contentRevisionId: content.id,
        dispatchProfile: 'PUBLIK_V1',
        requiredBotId: botId,
        scheduledAt,
        deliveryDeadlineAt,
        status: 'IN_PROGRESS',
      },
    });
    const broadcast = await db.managedBroadcast.create({
      data: {
        sourceChatId: chatId,
        actorUserId: publication.actorUserId,
        targetChatIds: [chatId],
        buttons: [],
        dispatchProfile: 'PUBLIK_V1',
        requiredBotId: botId,
        publicationOccurrenceId: occurrence.id,
        publicationContentRevisionId: content.id,
        lockedAt: scheduledAt,
        lockToken: randomUUID(),
      },
    });
    const delivery = await db.managedBroadcastDelivery.create({
      data: {
        broadcastId: broadcast.id,
        occurrenceIndex: 1,
        targetChatId: chatId,
        publicationOccurrenceId: occurrence.id,
        contentRevisionId: content.id,
        dispatchProfile: 'PUBLIK_V1',
        requiredBotId: botId,
        botId,
        dialogBotId: botId,
        publicationPolicyRevision: 1,
        publisherDialogContext: { version: 1, dialogBotId: botId, buttons: [], reference: null },
      },
    });
    return { publication, occurrence, broadcast, delivery };
  }

  it.each(['timeout', 'access_text_503'] as const)(
    'keeps the sixth %s SEND ambiguous after five real 429 deferrals and Redis restoration',
    async (failureKind) => {
      const fixture = await createPublicationDelivery();
      const sourceJob = job;
      let snapshot: Awaited<ReturnType<typeof snapshotQueue>> = [];
      let queueJobId = '';
      for (let attempt = 1; attempt <= 6; attempt += 1) {
        const before = await db.managedBroadcastDelivery.findUniqueOrThrow({
          where: { id: fixture.delivery.id },
        });
        const lockToken = randomUUID();
        // FLAG: The test drives eligible ticks explicitly; route/temporal admission is
        // covered separately. Real claims retain the saved counter and immutable route.
        const dueAt = before.nextAttemptAt ?? new Date();
        const claim = await db.managedBroadcastDelivery.updateMany({
          where: {
            id: before.id,
            status: 'PENDING',
            attemptCount: attempt - 1,
            OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: dueAt } }],
          },
          data: {
            status: 'SENDING',
            attemptCount: { increment: 1 },
            nextAttemptAt: null,
            waitReason: null,
            lockedAt: dueAt,
            lockToken,
          },
        });
        expect(claim.count).toBe(1);
        job = {
          ...sourceJob,
          chatId: before.targetChatId,
          attempt,
          idempotencyKey: buildPublicationDeliveryActionKey({
            broadcastId: fixture.broadcast.id,
            occurrenceIndex: 1,
            targetChatId: before.targetChatId,
            contentRevisionId: before.contentRevisionId!,
            attemptCount: attempt,
          }),
        };
        ownedLedgerIds.push(job.idempotencyKey);
        await ledger.recordStarted(job);
        await ledger.recordPrepared(job);
        queueJobId = randomUUID();
        await queue.add('send', job, { jobId: queueJobId });
        if (attempt === 6) snapshot = await snapshotQueue();
        const transportError =
          attempt < 6
            ? Object.assign(new Error('Too many requests'), {
                response: { status: 429, headers: { 'retry-after': '1' } },
              })
            : failureKind === 'timeout'
              ? Object.assign(new Error('SEND timed out'), { code: 'ETIMEDOUT' })
              : Object.assign(new Error('Chat not accessible'), {
                  response: { status: 503, data: { message: 'Chat not accessible' } },
                });
        request.mockRejectedValueOnce(transportError);
        let failure: unknown;
        try {
          await client().executeQueuedSendMessage(job, [], { botId });
        } catch (error: unknown) {
          failure = markManagedBroadcastSendPhase(error, true);
        }
        expect(failure).toBeInstanceOf(Error);
        if (attempt < 6) {
          expect(classifyPublicationSendFailure(failure)).toBe('failed');
          await ledger.recordFailed(job, failure);
          const retryAt = await deferPublicationDeliveryAfterPreDispatchThrottle({
            context: { prisma: db as never, logger: new Logger('NativePublicationFailure') },
            row: fixture.broadcast,
            delivery: before,
            reason: 'deadline',
            occurrenceIndex: 1,
            broadcastLockToken: fixture.broadcast.lockToken!,
            deliveryLockToken: lockToken,
            sendAttemptStarted: true,
            error: failure,
          });
          expect(retryAt).toBeInstanceOf(Date);
          expect(
            await db.managedBroadcastDelivery.findUniqueOrThrow({ where: { id: before.id } }),
          ).toMatchObject({
            status: 'PENDING',
            attemptCount: attempt,
            rateLimitDeferralCount: attempt,
            waitReason: 'max_rate_limit',
            nextAttemptAt: retryAt,
          });
          expect(
            await db.maxActionLedgerEntry.findUniqueOrThrow({
              where: { jobId: job.idempotencyKey },
            }),
          ).toMatchObject({
            status: 'FAILED_RETRYABLE',
            terminal: false,
            ambiguous: false,
            dispatchToken: null,
          });
        } else {
          expect(classifyPublicationSendFailure(failure)).toBe('ambiguous');
          expect(
            await persistPublicationSendFailure({
              prisma: db as never,
              deliveryId: before.id,
              lockToken,
              botId,
              failure: 'ambiguous',
              lastError: (failure as Error).message,
            }),
          ).toBe(true);
        }
      }

      for (let restart = 0; restart < 2; restart += 1) {
        expect(
          await db.managedBroadcastDelivery.findMany({
            where: { publicationOccurrenceId: fixture.occurrence.id, status: 'PENDING' },
          }),
        ).toEqual([]);
        await restoreQueue(snapshot, queueJobId);
        const restored = (await queue.getJob(queueJobId))!.data;
        const restartedLedger = new MaxActionLedgerService(db as never);
        await expect(
          client(restartedLedger).executeQueuedSendMessage(restored, [], { botId }),
        ).rejects.toBeInstanceOf(UnrecoverableError);
      }
      expect(request).toHaveBeenCalledTimes(6);
      expect(
        await db.managedBroadcastDelivery.findUniqueOrThrow({ where: { id: fixture.delivery.id } }),
      ).toMatchObject({
        status: 'AMBIGUOUS',
        attemptCount: 6,
        rateLimitDeferralCount: 5,
        contentRevisionId: fixture.occurrence.contentRevisionId,
        requiredBotId: botId,
        dialogBotId: botId,
        botId,
        remoteMessageId: null,
        lockedAt: null,
        lockToken: null,
      });
      expect(
        await db.publicationOccurrence.findUniqueOrThrow({ where: { id: fixture.occurrence.id } }),
      ).toMatchObject({
        deliveryDeadlineAt: fixture.occurrence.deliveryDeadlineAt,
        contentRevisionId: fixture.occurrence.contentRevisionId,
        requiredBotId: botId,
      });
      expect(
        await db.maxActionLedgerEntry.findUniqueOrThrow({ where: { jobId: job.idempotencyKey } }),
      ).toMatchObject({
        status: 'AMBIGUOUS',
        ambiguous: true,
        terminal: true,
        dispatchBotId: botId,
      });
    },
  );

  it.each(['replacement_token', 'sent_receipt'] as const)(
    'preserves a newer %s when an old failure writer resumes',
    async (state) => {
      const fixture = await createPublicationDelivery();
      const oldToken = randomUUID();
      const before = await db.managedBroadcastDelivery.update({
        where: { id: fixture.delivery.id },
        data:
          state === 'replacement_token'
            ? { status: 'SENDING', attemptCount: 6, lockToken: randomUUID(), lockedAt: new Date() }
            : {
                status: 'SENT',
                attemptCount: 6,
                remoteMessageId: 'confirmed-native-receipt',
                sentAt: new Date(),
              },
      });
      expect(
        await persistPublicationSendFailure({
          prisma: db as never,
          deliveryId: before.id,
          lockToken: oldToken,
          botId,
          failure: 'ambiguous',
          lastError: 'Old attempt timed out',
        }),
      ).toBe(false);
      expect(
        await db.managedBroadcastDelivery.findUniqueOrThrow({ where: { id: before.id } }),
      ).toEqual(before);
      expect(request).not.toHaveBeenCalled();
    },
  );

  function failReceiptWrite(afterCommit: boolean): MaxActionLedgerService {
    let injected = false;
    const adapter = new Proxy(db, {
      get(target, key) {
        if (key !== 'maxActionLedgerEntry') return Reflect.get(target, key);
        return new Proxy(target.maxActionLedgerEntry, {
          get(delegate, method) {
            if (method !== 'updateMany') return Reflect.get(delegate, method);
            return async (args: Parameters<typeof delegate.updateMany>[0]) => {
              if (!injected && args?.data.remoteMessageId) {
                injected = true;
                if (afterCommit) await delegate.updateMany(args);
                throw new Error('Injected database response loss at receipt commit');
              }
              return delegate.updateMany(args);
            };
          },
        });
      },
    });
    return new MaxActionLedgerService(adapter as never);
  }

  it('permits only one MAX request when concurrent dispatches claim the same intent', async () => {
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    request.mockImplementationOnce(async () => {
      entered();
      await gate;
      return { message_id: `remote-${job.idempotencyKey}` };
    });
    const first = observedSend();
    await started;
    try {
      await expect(client().executeQueuedSendMessage(job, [], { botId })).rejects.toBeInstanceOf(
        UnrecoverableError,
      );
    } finally {
      release();
    }
    await first;
    expect(request).toHaveBeenCalledTimes(1);
    expect(await ledger.getCompletedSendDispatch(job)).toBe(`remote-${job.idempotencyKey}`);
    expect(observations.filter((event) => event.stage === 'http')).toHaveLength(1);
    expect(observations.filter((event) => event.stage === 'ledger_persistence')).toEqual([
      expect.objectContaining({ outcome: 'cas_committed' }),
    ]);
  });

  it('recovers a SQL receipt after repeated restoration of an older Redis queue', async () => {
    const snapshot = await snapshotQueue();
    await observedSend();
    observations = [];
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await restoreQueue(snapshot);
      const restored = (await queue.getJob(job.idempotencyKey))!.data;
      expect(restored).toEqual(job);
      expect(await observedSend()).toMatchObject({
        message_id: `remote-${job.idempotencyKey}`,
      });
    }
    expect(request).toHaveBeenCalledTimes(1);
    expect(observations.filter((event) => event.stage === 'http')).toEqual([]);
    expect(
      await db.maxActionLedgerEntry.findUniqueOrThrow({ where: { jobId: job.idempotencyKey } }),
    ).toMatchObject({
      status: 'SUCCEEDED',
      terminal: true,
      ambiguous: false,
      dispatchBotId: botId,
    });
  });

  it('fences MAX acceptance without a persisted receipt after stale Redis restore', async () => {
    const snapshot = await snapshotQueue();
    await expect(observedSend(failReceiptWrite(false))).rejects.toBeInstanceOf(UnrecoverableError);
    expect(observations.filter((event) => event.stage === 'http')).toHaveLength(1);
    expect(observations.filter((event) => event.stage === 'ledger_persistence')).toEqual([]);
    await restoreQueue(snapshot);
    await expect(client().executeQueuedSendMessage(job, [], { botId })).rejects.toBeInstanceOf(
      UnrecoverableError,
    );
    expect(request).toHaveBeenCalledTimes(1);
    expect(
      await db.maxActionLedgerEntry.findUniqueOrThrow({ where: { jobId: job.idempotencyKey } }),
    ).toMatchObject({
      status: 'AMBIGUOUS',
      terminal: true,
      ambiguous: true,
      remoteMessageId: null,
    });
  });

  it('recovers a committed receipt with lost acknowledgement even when Redis work disappears', async () => {
    await observedSend(failReceiptWrite(true));
    expect(observations.filter((event) => event.stage === 'ledger_persistence')).toEqual([
      expect.objectContaining({ outcome: 'exact_readback' }),
    ]);
    await queue.obliterate({ force: true });
    expect(await queue.getJob(job.idempotencyKey)).toBeUndefined();
    expect(await client().executeQueuedSendMessage(job, [], { botId })).toMatchObject({
      message_id: `remote-${job.idempotencyKey}`,
    });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('does not send after a worker stops between durable claim and HTTP', async () => {
    expect(await ledger.claimSendDispatch(job, botId)).toMatchObject({ kind: 'claimed' });
    await expect(client().executeQueuedSendMessage(job, [], { botId })).rejects.toBeInstanceOf(
      UnrecoverableError,
    );
    expect(request).not.toHaveBeenCalled();
  });

  it('keeps final authority rejection outside HTTP timing and releases only its unattempted fence', async () => {
    const rejected = new Error('Synthetic final authority rejection');
    const scope = createMaxSendObservation(
      { mode: 'NOW', media: 'none', lane: 'interactive' },
      (event) => {
        observations.push(event);
      },
    );
    await expect(
      scope.run(job.idempotencyKey, () =>
        client().executeQueuedSendMessage(job, [], { botId }, async () => {
          throw rejected;
        }),
      ),
    ).rejects.toBe(rejected);
    expect(request).not.toHaveBeenCalled();
    expect(observations.filter((event) => event.stage === 'http')).toEqual([]);
    expect(observations.filter((event) => event.stage === 'final_admission')).toEqual([
      expect.objectContaining({ outcome: 'not_dispatched' }),
    ]);
    expect(
      await db.maxActionLedgerEntry.findUniqueOrThrow({ where: { jobId: job.idempotencyKey } }),
    ).toMatchObject({ dispatchToken: null, remoteMessageId: null, ambiguous: false });
  });

  it.each(['timeout', 'missing_remote_id'] as const)(
    'does not convert %s observations into a receipt or authorize another SEND',
    async (failure) => {
      if (failure === 'timeout') request.mockRejectedValueOnce(new Error('Synthetic MAX timeout'));
      else request.mockResolvedValueOnce({});
      await expect(observedSend()).rejects.toBeInstanceOf(UnrecoverableError);
      expect(observations.filter((event) => event.stage === 'http')).toEqual([
        expect.objectContaining({
          outcome: failure === 'timeout' ? 'transport_error' : 'response_received',
        }),
      ]);
      expect(observations.filter((event) => event.stage === 'ledger_persistence')).toEqual([]);
      expect(observations.some((event) => event.outcome === 'remote_id_observed')).toBe(false);
      await expect(observedSend()).rejects.toBeInstanceOf(UnrecoverableError);
      expect(request).toHaveBeenCalledTimes(1);
      expect(
        await db.maxActionLedgerEntry.findUniqueOrThrow({ where: { jobId: job.idempotencyKey } }),
      ).toMatchObject({ remoteMessageId: null, ambiguous: true, terminal: true });
    },
  );

  it('keeps the external runtime fence closed when old SQL and Redis lose evidence of MAX acceptance', async () => {
    const sqlSnapshot = await db.maxActionLedgerEntry.findUniqueOrThrow({
      where: { jobId: job.idempotencyKey },
    });
    const redisSnapshot = await snapshotQueue();
    await client().executeQueuedSendMessage(job, [], { botId });
    await db.maxActionLedgerEntry.delete({ where: { jobId: job.idempotencyKey } });
    await db.maxActionLedgerEntry.create({
      data: {
        ...sqlSnapshot,
        metadata:
          sqlSnapshot.metadata === null
            ? Prisma.DbNull
            : (sqlSnapshot.metadata as Prisma.InputJsonValue),
      },
    });
    await restoreQueue(redisSnapshot);
    expect(await ledger.getCompletedSendDispatch(job)).toBeNull();

    const oldRole = process.env.APP_ROLE;
    const oldService = process.env.APP_SERVICE_NAME;
    let boundary: PublisherRuntimeBoundaryService;
    try {
      process.env.APP_ROLE = 'publisher';
      process.env.APP_SERVICE_NAME = 'api-publisher';
      boundary = new PublisherRuntimeBoundaryService(
        new ConfigService({ MAX_PUBLISHER_DISPATCH_ENABLED: false }),
        {
          getBotId: () => botId,
          getRequiredActionToken: () => 'synthetic-no-network-token',
        } as never,
      );
    } finally {
      if (oldRole === undefined) delete process.env.APP_ROLE;
      else process.env.APP_ROLE = oldRole;
      if (oldService === undefined) delete process.env.APP_SERVICE_NAME;
      else process.env.APP_SERVICE_NAME = oldService;
    }
    const beforeMutation = jest.fn(async () => boundary.assertDispatchEnabled());
    await expect(
      client().executeQueuedSendMessage(job, [], { botId }, beforeMutation),
    ).rejects.toBeInstanceOf(PublisherDispatchDisabledError);
    expect(beforeMutation).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledTimes(1);
    expect(
      await db.maxActionLedgerEntry.findUniqueOrThrow({ where: { jobId: job.idempotencyKey } }),
    ).toMatchObject({
      dispatchToken: null,
      dispatchStartedAt: null,
      remoteMessageId: null,
      ambiguous: false,
      terminal: false,
    });
  });

  it('rejects a restored receipt under another required bot without another MAX request', async () => {
    await client().executeQueuedSendMessage(job, [], { botId });
    const foreign = {
      ...job,
      routing: { purpose: 'send_message', requiredBotId: `${botId}-other` },
    } as MaxActionJob;
    await expect(
      client().executeQueuedSendMessage(foreign, [], { botId: `${botId}-other` }),
    ).rejects.toBeInstanceOf(UnrecoverableError);
    expect(request).toHaveBeenCalledTimes(1);
  });
});
