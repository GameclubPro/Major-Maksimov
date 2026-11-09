import { randomUUID } from 'node:crypto';
import { Prisma, PrismaClient, createPrismaAdapter } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import {
  deferPublicationRecurrencePreparation,
  recoverPublicationRecurrencePreparationFailure,
} from './publication-recurrence-recovery';
import { dispatchScheduledPublicationOccurrences } from './publication-occurrence-dispatcher';
import { PublicationPublisherRoutingService } from './publication-publisher-routing.service';
import { PublisherSetupRequiredException } from '../publisher/publisher-errors';
import {
  cancelPublicationDeliveryBeforeStoppedDispatch,
  ensureManagedBroadcastPublicationExecutionActive,
} from './publication-execution-recovery';
import { PublisherManagedBroadcastDispatch } from './publisher-managed-broadcast-dispatch';
import { isPublicationScheduledWindowExpired } from './publication-late-policy';
import { isTransientPublicationPrismaError } from './publication-prisma-retry';

const databaseUrl = process.env.CHAT_ROUTING_POSTGRES_RACE_DATABASE_URL?.trim() ?? '';
const postgres = databaseUrl ? describe : describe.skip;

postgres('Publication recurrence failure fencing on PostgreSQL', () => {
  let db: PrismaClient;
  let publicationId: string;
  const testChatIds: string[] = [];
  const lockCalendar = async (tx: Prisma.TransactionClient) => {
    await tx.$executeRaw(
      Prisma.sql`SELECT pg_advisory_xact_lock(hashtext('publication-calendar'))`,
    );
  };

  beforeAll(async () => {
    const url = new URL(databaseUrl);
    if (
      !['localhost', '127.0.0.1', '::1'].includes(url.hostname) ||
      !url.pathname.includes('race_test')
    ) {
      throw new Error('Disposable local race_test database required');
    }
    db = new PrismaClient({
      adapter: createPrismaAdapter(databaseUrl, { max: 3, statement_timeout: 10_000 }),
    });
    await db.$connect();
  });
  beforeEach(async () => {
    const publication = await db.publication.create({
      data: {
        actorUserId: `recovery-${randomUUID()}`,
        requestId: randomUUID(),
        lifecycle: 'ACTIVE',
        dispatchProfile: 'PUBLIK_V1',
        requiredBotId: 'publisher-test',
        schedule: {
          create: { mode: 'RECURRENCE', status: 'ACTIVE', rule: {}, nextMaterializeAt: new Date() },
        },
      },
    });
    publicationId = publication.id;
  });
  afterEach(async () => {
    await db.publication.delete({ where: { id: publicationId } });
    if (testChatIds.length)
      await db.chat.deleteMany({ where: { id: { in: testChatIds.splice(0) } } });
  });
  afterAll(async () => {
    await db?.$disconnect();
  });

  async function createPastOccurrence() {
    const schedule = await db.publicationSchedule.update({
      where: { publicationId },
      data: {
        mode: 'ONCE',
        rule: { mode: 'once', timezone: 'Europe/Moscow', at: '2026-01-01T00:00:00.000Z' },
      },
    });
    const content = await db.publicationContentRevision.create({
      data: { publicationId, revision: 1 },
    });
    return db.publicationOccurrence.create({
      data: {
        publicationId,
        scheduleId: schedule.id,
        scheduleRevision: schedule.revision,
        contentRevisionId: content.id,
        dispatchProfile: 'PUBLIK_V1',
        requiredBotId: 'publisher-test',
        scheduledAt: new Date(Date.now() - 3_600_000),
      },
    });
  }

  async function createLateEnvelope() {
    const occurrence = await createPastOccurrence();
    await db.publicationOccurrence.update({
      where: { id: occurrence.id },
      data: { status: 'IN_PROGRESS' },
    });
    const chatId = `late-policy-${randomUUID()}`;
    testChatIds.push(chatId);
    await db.chat.create({ data: { id: chatId, title: 'Late policy integration fixture' } });
    const row = await db.managedBroadcast.create({
      data: {
        sourceChatId: chatId,
        actorUserId: 'late-policy-author',
        targetChatIds: [chatId],
        buttons: [],
        dispatchProfile: 'PUBLIK_V1',
        requiredBotId: 'publisher-test',
        publicationOccurrenceId: occurrence.id,
        publicationContentRevisionId: occurrence.contentRevisionId,
        nextSendAt: occurrence.scheduledAt,
        lockedAt: new Date(),
        lockToken: randomUUID(),
      },
    });
    const delivery = await db.managedBroadcastDelivery.create({
      data: {
        broadcastId: row.id,
        occurrenceIndex: 1,
        targetChatId: chatId,
        dispatchProfile: 'PUBLIK_V1',
        requiredBotId: 'publisher-test',
        publicationOccurrenceId: occurrence.id,
        contentRevisionId: occurrence.contentRevisionId,
        dialogBotId: 'publisher-test',
        publicationPolicyRevision: 1,
        publisherDialogContext: {
          version: 1,
          dialogBotId: 'publisher-test',
          buttons: [],
          reference: null,
        },
      },
    });
    return { occurrence, row, delivery };
  }

  it.each([
    ['timeout', '57014', true],
    ['syntax', '42601', false],
  ] as const)(
    'handles a real raw SQL %s during occurrence preparation without losing failure certainty',
    async (failureKind, sqlState, transient) => {
      const occurrence = await createPastOccurrence();
      const scheduledAt = new Date();
      const deliveryDeadlineAt = new Date(scheduledAt.getTime() + 86_400_000);
      await db.publicationOccurrence.update({
        where: { id: occurrence.id },
        data: { scheduledAt, deliveryDeadlineAt },
      });
      await db.publicationSchedule.update({
        where: { id: occurrence.scheduleId },
        data: {
          rule: { mode: 'once', timezone: 'UTC', at: scheduledAt.toISOString() },
        },
      });
      const cancelFutureWork = jest.fn(async () => {});
      let preparationError: unknown;
      const createExecution = jest.fn(async () => {
        try {
          await db.$transaction(async (tx) => {
            if (failureKind === 'timeout') {
              await tx.$executeRaw`SET LOCAL statement_timeout = '40ms'`;
              await tx.$executeRaw`SELECT pg_sleep(0.15)`;
            } else {
              await tx.$executeRaw`SELEC invalid_publication_fixture`;
            }
          });
        } catch (error: unknown) {
          preparationError = error;
          throw error;
        }
      });
      const context: Parameters<typeof dispatchScheduledPublicationOccurrences>[0] = {
        prisma: db as unknown as PrismaService,
        publisherRouting: {
          blockedRetryBefore: () => new Date(Date.now() - 60_000),
          deferOccurrenceIfBlocked: jest.fn().mockResolvedValue(false),
        } as unknown as PublicationPublisherRoutingService,
        logger: { warn: jest.fn() },
        resolveTargets: async () => [
          {
            chatId: 'raw-query-fixture',
            entityType: 'chat',
            title: 'Fixture',
            avatarUrl: null,
            link: null,
          },
        ],
        createExecution,
        cancelFutureWork,
        lockCalendar,
      };
      const dispatch = dispatchScheduledPublicationOccurrences(context, 1, undefined, {
        publicationId,
      });
      if (transient)
        await expect(dispatch).rejects.toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
      else await expect(dispatch).resolves.toBeUndefined();

      expect(preparationError).toMatchObject({
        code: 'P2010',
        meta: { driverAdapterError: { cause: { originalCode: sqlState } } },
      });
      expect(isTransientPublicationPrismaError(preparationError)).toBe(transient);
      expect(createExecution).toHaveBeenCalledTimes(1);
      expect(cancelFutureWork).toHaveBeenCalledTimes(transient ? 0 : 1);
      expect(
        await db.publicationOccurrence.findUniqueOrThrow({ where: { id: occurrence.id } }),
      ).toMatchObject({
        status: transient ? 'SCHEDULED' : 'FAILED',
        contentRevisionId: occurrence.contentRevisionId,
        deliveryDeadlineAt,
      });
      expect(
        await db.publication.findUniqueOrThrow({
          where: { id: publicationId },
          include: { schedule: true },
        }),
      ).toMatchObject({
        lifecycle: transient ? 'ACTIVE' : 'ERROR',
        schedule: { status: transient ? 'ACTIVE' : 'ERROR', revision: occurrence.scheduleRevision },
      });
      expect(
        await db.managedBroadcast.count({ where: { publicationOccurrenceId: occurrence.id } }),
      ).toBe(0);
    },
  );

  it('defers a real advisory deadlock without terminalizing the schedule', async () => {
    const schedule = await db.publicationSchedule.findUniqueOrThrow({ where: { publicationId } });
    let participants = 0;
    let release!: () => void;
    const ready = new Promise<void>((resolve) => {
      release = resolve;
    });
    const contend = (first: number, second: number) =>
      db.$transaction(
        async (tx) => {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${publicationId}), ${first}::int)`;
          if (++participants === 2) release();
          await ready;
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${publicationId}), ${second}::int)`;
        },
        { timeout: 5_000 },
      );
    const outcomes = await Promise.allSettled([contend(1, 2), contend(2, 1)]);
    const failed = outcomes.filter((outcome) => outcome.status === 'rejected');
    expect(failed).toHaveLength(1);
    const error: unknown = failed[0]!.reason;
    expect(error).toMatchObject({
      code: 'P2010',
      meta: { driverAdapterError: { cause: { originalCode: '40P01' } } },
    });
    expect(isTransientPublicationPrismaError(error)).toBe(true);
    const startedAt = Date.now();
    await expect(
      recoverPublicationRecurrencePreparationFailure({
        prisma: db as unknown as PrismaService,
        logger: { warn: jest.fn() },
        schedule,
        publicationVersion: 1,
        error,
        lockCalendar,
      }),
    ).resolves.toBe(true);
    const current = await db.publication.findUniqueOrThrow({
      where: { id: publicationId },
      include: { schedule: true },
    });
    expect(current.lifecycle).toBe('ACTIVE');
    expect(current.schedule).toMatchObject({
      status: 'ACTIVE',
      revision: schedule.revision,
      lastError: 'PUBLICATION_PREPARATION_TRANSIENT',
    });
    expect(current.schedule!.nextMaterializeAt!.getTime()).toBeGreaterThanOrEqual(
      startedAt + 60_000,
    );
    expect(current.schedule!.nextMaterializeAt!.getTime()).toBeLessThan(Date.now() + 75_000);
    expect(await db.publicationOccurrence.count({ where: { publicationId } })).toBe(0);
  });

  it('retains a new recoverable delivery after a 15-minute outage across a restart', async () => {
    const { occurrence, row, delivery } = await createLateEnvelope();
    await db.publicationSchedule.update({
      where: { id: occurrence.scheduleId },
      data: {
        rule: {
          mode: 'once',
          timezone: 'Europe/Moscow',
          at: occurrence.scheduledAt.toISOString(),
          latePolicy: { mode: 'recover', maxDelayMinutes: 1440, catchUp: 'latest' },
        },
      },
    });
    for (let replica = 0; replica < 2; replica++) {
      expect(
        await ensureManagedBroadcastPublicationExecutionActive({
          prisma: db as never,
          row,
          occurrenceIndex: 1,
        }),
      ).toBe(true);
    }
    expect(
      await db.managedBroadcastDelivery.findUniqueOrThrow({ where: { id: delivery.id } }),
    ).toMatchObject({ status: 'PENDING', attemptCount: 0 });
  });

  it.each(['SENT', 'AMBIGUOUS'] as const)(
    'expires only an unstarted recipient alongside a %s effect',
    async (status) => {
      const { occurrence, row, delivery } = await createLateEnvelope();
      await db.publicationSchedule.update({
        where: { id: occurrence.scheduleId },
        data: {
          rule: {
            mode: 'once',
            timezone: 'Europe/Moscow',
            at: occurrence.scheduledAt.toISOString(),
            latePolicy: { mode: 'strict', maxDelayMinutes: 5, catchUp: 'all' },
          },
        },
      });
      await db.managedBroadcastDelivery.update({
        where: { id: delivery.id },
        data: {
          status,
          attemptCount: 1,
          remoteMessageId: status === 'SENT' ? 'confirmed-receipt' : null,
          sentAt: status === 'SENT' ? new Date() : null,
        },
      });
      const pending = await db.managedBroadcastDelivery.create({
        data: {
          broadcastId: row.id,
          occurrenceIndex: 1,
          targetChatId: `${delivery.targetChatId}-pending`,
          publicationOccurrenceId: occurrence.id,
          contentRevisionId: occurrence.contentRevisionId,
          dispatchProfile: 'PUBLIK_V1',
          requiredBotId: 'publisher-test',
          dialogBotId: 'publisher-test',
          publicationPolicyRevision: 0,
          publisherDialogContext: {
            version: 1,
            dialogBotId: 'publisher-test',
            buttons: [],
            reference: null,
          },
        },
      });
      expect(
        await ensureManagedBroadcastPublicationExecutionActive({
          prisma: db as never,
          row,
          occurrenceIndex: 1,
        }),
      ).toBe(true);
      expect(
        await db.managedBroadcastDelivery.findUniqueOrThrow({ where: { id: pending.id } }),
      ).toMatchObject({
        status: 'FAILED',
        attemptCount: 0,
        lastErrorCode: 'PUBLISHER_MISSED_WINDOW_REVIEW',
      });
      expect(
        await db.managedBroadcastDelivery.findUniqueOrThrow({ where: { id: delivery.id } }),
      ).toMatchObject({ status, attemptCount: 1 });
    },
  );

  it('stops and removes an unattempted late envelope while preserving the missed occurrence', async () => {
    const { occurrence, row } = await createLateEnvelope();
    await expect(
      ensureManagedBroadcastPublicationExecutionActive({
        prisma: db as unknown as PrismaService,
        row,
        occurrenceIndex: 1,
      }),
    ).resolves.toBe(false);
    expect(await db.managedBroadcast.findUnique({ where: { id: row.id } })).toBeNull();
    expect(
      await db.publicationOccurrence.findUniqueOrThrow({ where: { id: occurrence.id } }),
    ).toMatchObject({ status: 'FAILED', dispatchBlockerCode: 'PUBLISHER_MISSED_WINDOW_REVIEW' });
  });

  it.each(['SENT', 'AMBIGUOUS'] as const)(
    'preserves an earlier %s delivery across the late boundary',
    async (status) => {
      const { occurrence, row, delivery } = await createLateEnvelope();
      await db.managedBroadcastDelivery.update({
        where: { id: delivery.id },
        data: {
          status,
          attemptCount: 1,
          remoteMessageId: status === 'SENT' ? 'test-remote-receipt' : null,
          sentAt: status === 'SENT' ? new Date() : null,
          botId: 'publisher-test',
        },
      });
      await expect(
        ensureManagedBroadcastPublicationExecutionActive({
          prisma: db as unknown as PrismaService,
          row,
          occurrenceIndex: 1,
        }),
      ).resolves.toBe(true);
      expect(
        await db.publicationOccurrence.findUniqueOrThrow({ where: { id: occurrence.id } }),
      ).toMatchObject({ status: 'IN_PROGRESS' });
      expect(
        await db.managedBroadcastDelivery.findUniqueOrThrow({ where: { id: delivery.id } }),
      ).toMatchObject({ status, attemptCount: 1 });
    },
  );

  it('excludes only the first exact pre-dispatch claim and preserves its token until its owner cancels it', async () => {
    const { occurrence, row, delivery } = await createLateEnvelope();
    const lockToken = randomUUID();
    await db.managedBroadcastDelivery.update({
      where: { id: delivery.id },
      data: { status: 'SENDING', attemptCount: 1, lockedAt: new Date(), lockToken },
    });
    await expect(
      ensureManagedBroadcastPublicationExecutionActive({
        prisma: db as unknown as PrismaService,
        row,
        occurrenceIndex: 1,
        preDispatchClaim: { id: delivery.id, lockToken, attemptCount: 1 },
      }),
    ).resolves.toBe(false);
    expect(
      await db.managedBroadcastDelivery.findUniqueOrThrow({ where: { id: delivery.id } }),
    ).toMatchObject({ status: 'SENDING', lockToken });
    expect(
      await db.publicationOccurrence.findUniqueOrThrow({ where: { id: occurrence.id } }),
    ).toMatchObject({ status: 'FAILED' });
    await cancelPublicationDeliveryBeforeStoppedDispatch(db as unknown as PrismaService, {
      id: delivery.id,
      lockToken,
      attemptCount: 0,
      sendAttemptStarted: false,
    });
    expect(await db.managedBroadcast.findUnique({ where: { id: row.id } })).toBeNull();
    expect(await db.managedBroadcastDelivery.findUnique({ where: { id: delivery.id } })).toBeNull();
    expect(
      await db.publicationOccurrence.findUniqueOrThrow({ where: { id: occurrence.id } }),
    ).toMatchObject({
      status: 'FAILED',
      legacyBroadcastId: null,
      dispatchBlockerCode: 'PUBLISHER_MISSED_WINDOW_REVIEW',
    });
  });

  it.each([false, true])('keeps author retry after materialization (legacy=%s)', async (legacy) => {
    const { occurrence, row, delivery } = await createLateEnvelope();
    const authorizedAt = new Date();
    await db.publicationOccurrence.update({
      where: { id: occurrence.id },
      data: {
        retryAuthorizedAt: legacy ? null : authorizedAt,
        dispatchBlockerCode: 'PUBLISHER_EXPLICIT_RETRY',
        dispatchBlockedAt: authorizedAt,
      },
    });
    const lockToken = randomUUID();
    await db.managedBroadcastDelivery.update({
      where: { id: delivery.id },
      data: { status: 'SENDING', attemptCount: 1, lockedAt: new Date(), lockToken },
    });
    const dispatch = new PublisherManagedBroadcastDispatch(
      { prisma: db, logger: { warn: jest.fn() } } as never,
      { warn: jest.fn() } as never,
    );
    await dispatch.deferClaimed({
      row,
      delivery,
      deliveryLockToken: lockToken,
      sendAttemptStarted: false,
      blockerCode: 'bot_access_expired',
    });
    const deferred = await db.publicationOccurrence.findUniqueOrThrow({
      where: { id: occurrence.id },
      include: { schedule: true },
    });
    expect(deferred).toMatchObject({
      retryAuthorizedAt: authorizedAt,
      dispatchBlockerCode: 'bot_access_expired',
      status: 'IN_PROGRESS',
    });
    expect(isPublicationScheduledWindowExpired(deferred)).toBe(false);
    expect(
      isPublicationScheduledWindowExpired(deferred, new Date(authorizedAt.getTime() + 300_001)),
    ).toBe(true);
    await expect(
      ensureManagedBroadcastPublicationExecutionActive({
        prisma: db as unknown as PrismaService,
        row,
        occurrenceIndex: 1,
      }),
    ).resolves.toBe(true);
    expect(
      await db.managedBroadcastDelivery.findUniqueOrThrow({ where: { id: delivery.id } }),
    ).toMatchObject({ status: 'PENDING', attemptCount: 0 });
  });

  it.each([false, true])(
    'keeps author retry before materialization (legacy=%s)',
    async (legacy) => {
      const occurrence = await createPastOccurrence();
      const retryAuthorizedAt = new Date();
      const retried = await db.publicationOccurrence.update({
        where: { id: occurrence.id },
        data: {
          retryAuthorizedAt: legacy ? null : retryAuthorizedAt,
          dispatchBlockerCode: 'PUBLISHER_EXPLICIT_RETRY',
          dispatchBlockedAt: retryAuthorizedAt,
        },
      });
      const routing = new PublicationPublisherRoutingService(
        db as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
      );
      await routing.deferOccurrenceIfBlocked(
        retried,
        new PublisherSetupRequiredException([], 'bot_access_expired'),
      );
      const deferred = await db.publicationOccurrence.findUniqueOrThrow({
        where: { id: occurrence.id },
        include: { schedule: true },
      });
      expect(deferred.retryAuthorizedAt).toEqual(retryAuthorizedAt);
      expect(deferred.dispatchBlockerCode).toBe('bot_access_expired');
      expect(isPublicationScheduledWindowExpired(deferred)).toBe(false);
      expect(
        isPublicationScheduledWindowExpired(
          deferred,
          new Date(retryAuthorizedAt.getTime() + 300_001),
        ),
      ).toBe(true);
    },
  );

  it('does not refresh an expired dedicated authorization from a fresher legacy marker', async () => {
    const { occurrence, row, delivery } = await createLateEnvelope();
    const authorizedAt = new Date(Date.now() - 300_001);
    await db.publicationOccurrence.update({
      where: { id: occurrence.id },
      data: {
        retryAuthorizedAt: authorizedAt,
        dispatchBlockerCode: 'PUBLISHER_EXPLICIT_RETRY',
        dispatchBlockedAt: new Date(),
      },
    });
    const lockToken = randomUUID();
    await db.managedBroadcastDelivery.update({
      where: { id: delivery.id },
      data: { status: 'SENDING', attemptCount: 1, lockedAt: new Date(), lockToken },
    });
    const dispatch = new PublisherManagedBroadcastDispatch({ prisma: db } as never, {} as never);
    await dispatch.deferClaimed({
      row,
      delivery,
      deliveryLockToken: lockToken,
      sendAttemptStarted: false,
      blockerCode: 'bot_access_expired',
    });
    const deferred = await db.publicationOccurrence.findUniqueOrThrow({
      where: { id: occurrence.id },
      include: { schedule: true },
    });
    expect(deferred.retryAuthorizedAt).toEqual(authorizedAt);
    expect(isPublicationScheduledWindowExpired(deferred)).toBe(true);
  });

  it.each(['SENDING', 'SENT', 'AMBIGUOUS'] as const)(
    'preserves concurrent %s evidence while canceling its own expired pre-HTTP claim',
    async (status) => {
      const { row, delivery } = await createLateEnvelope();
      const lockToken = randomUUID();
      await db.managedBroadcastDelivery.update({
        where: { id: delivery.id },
        data: { status: 'SENDING', attemptCount: 1, lockedAt: new Date(), lockToken },
      });
      await ensureManagedBroadcastPublicationExecutionActive({
        prisma: db as unknown as PrismaService,
        row,
        occurrenceIndex: 1,
        preDispatchClaim: { id: delivery.id, lockToken, attemptCount: 1 },
      });
      let release!: () => void;
      let entered!: () => void;
      const ready = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const competingToken = randomUUID();
      const competing = db.$transaction(async (tx) => {
        await lockCalendar(tx);
        const targetChatId = `concurrent-stop-${randomUUID()}`;
        testChatIds.push(targetChatId);
        await tx.chat.create({ data: { id: targetChatId, title: 'Concurrent cleanup fence' } });
        const other = await tx.managedBroadcastDelivery.create({
          data: {
            ...delivery,
            id: randomUUID(),
            targetChatId,
            status,
            attemptCount: 1,
            botId: 'publisher-test',
            remoteMessageId: status === 'SENT' ? 'concurrent-durable-receipt' : null,
            sentAt: status === 'SENT' ? new Date() : null,
            lockedAt: status === 'SENDING' ? new Date() : null,
            lockToken: status === 'SENDING' ? competingToken : null,
            publisherDialogContext: delivery.publisherDialogContext as Prisma.InputJsonValue,
          },
        });
        entered();
        await held;
        return other;
      });
      await ready;
      const canceling = cancelPublicationDeliveryBeforeStoppedDispatch(
        db as unknown as PrismaService,
        { id: delivery.id, lockToken, attemptCount: 0, sendAttemptStarted: false },
      );
      release();
      const [other] = await Promise.all([competing, canceling]);
      expect(await db.managedBroadcast.findUnique({ where: { id: row.id } })).not.toBeNull();
      expect(
        await db.managedBroadcastDelivery.findUniqueOrThrow({ where: { id: delivery.id } }),
      ).toMatchObject({ status: 'CANCELED', attemptCount: 0 });
      expect(
        await db.managedBroadcastDelivery.findUniqueOrThrow({ where: { id: other.id } }),
      ).toMatchObject({ status, attemptCount: 1, remoteMessageId: other.remoteMessageId });
    },
  );

  it('does not cancel a replaced claim token or decrement its attempt', async () => {
    const { delivery } = await createLateEnvelope();
    const ownerToken = randomUUID();
    await db.managedBroadcastDelivery.update({
      where: { id: delivery.id },
      data: { status: 'SENDING', attemptCount: 2, lockedAt: new Date(), lockToken: ownerToken },
    });
    await cancelPublicationDeliveryBeforeStoppedDispatch(db as unknown as PrismaService, {
      id: delivery.id,
      lockToken: 'stale-owner',
      attemptCount: 0,
      sendAttemptStarted: false,
    });
    expect(
      await db.managedBroadcastDelivery.findUniqueOrThrow({ where: { id: delivery.id } }),
    ).toMatchObject({ status: 'SENDING', attemptCount: 2, lockToken: ownerToken });
  });

  it('settles a superseded recurrence on its transaction connection while the second pool connection waits for the calendar lock', async () => {
    const { occurrence, row, delivery } = await createLateEnvelope();
    const now = new Date();
    const deliveryDeadlineAt = new Date(now.getTime() + 3_600_000);
    await db.publicationSchedule.update({
      where: { id: occurrence.scheduleId },
      data: {
        mode: 'RECURRENCE',
        rule: {
          mode: 'recurrence',
          latePolicy: { mode: 'recover', maxDelayMinutes: 1440, catchUp: 'latest' },
        },
      },
    });
    await db.publicationOccurrence.update({
      where: { id: occurrence.id },
      data: { deliveryDeadlineAt },
    });
    const newer = await db.publicationOccurrence.create({
      data: {
        publicationId,
        scheduleId: occurrence.scheduleId,
        scheduleRevision: occurrence.scheduleRevision,
        contentRevisionId: occurrence.contentRevisionId,
        dispatchProfile: 'PUBLIK_V1',
        requiredBotId: 'publisher-test',
        scheduledAt: new Date(now.getTime() - 30 * 60_000),
        deliveryDeadlineAt,
      },
    });
    const lockToken = randomUUID();
    await db.managedBroadcastDelivery.update({
      where: { id: delivery.id },
      data: { status: 'SENDING', attemptCount: 1, lockedAt: now, lockToken },
    });
    expect(
      await ensureManagedBroadcastPublicationExecutionActive({
        prisma: db as unknown as PrismaService,
        row,
        occurrenceIndex: 1,
        preDispatchClaim: { id: delivery.id, lockToken, attemptCount: 1 },
      }),
    ).toBe(false);

    const limitedDb = new PrismaClient({
      adapter: createPrismaAdapter(databaseUrl, {
        max: 2,
        connectionTimeoutMillis: 300,
        statement_timeout: 10_000,
      }),
    });
    let reachedOccurrenceRead!: () => void;
    const occurrenceRead = new Promise<void>((resolve) => {
      reachedOccurrenceRead = resolve;
    });
    let releaseOccurrenceRead!: () => void;
    const occurrenceReadRelease = new Promise<void>((resolve) => {
      releaseOccurrenceRead = resolve;
    });
    let competingStarted!: (pid: number) => void;
    const competingReady = new Promise<number>((resolve) => {
      competingStarted = resolve;
    });
    const guardedDb = {
      $transaction: (run: (tx: Prisma.TransactionClient) => Promise<unknown>) =>
        limitedDb.$transaction(async (tx) => {
          const guardedTx = new Proxy(tx, {
            get(target, key) {
              if (key === 'publicationOccurrence')
                return new Proxy(target.publicationOccurrence, {
                  get(delegate, method) {
                    if (method === 'findUnique')
                      return async (args: Parameters<typeof delegate.findUnique>[0]) => {
                        const saved = await delegate.findUnique(args);
                        reachedOccurrenceRead();
                        await occurrenceReadRelease;
                        return saved;
                      };
                    return Reflect.get(delegate, method);
                  },
                });
              return Reflect.get(target, key);
            },
          });
          return run(guardedTx);
        }),
      // FLAG: Preserve the real root delegate so this test reproduces a read escaping the
      // transaction; it must compete for the same two-connection pool as the waiting writer.
      publicationOccurrence: limitedDb.publicationOccurrence,
    };
    let cleaning: Promise<void> | undefined;
    let competing: Promise<void> | undefined;
    let competingAcquired = false;
    try {
      await limitedDb.$connect();
      cleaning = cancelPublicationDeliveryBeforeStoppedDispatch(
        guardedDb as unknown as PrismaService,
        { id: delivery.id, lockToken, attemptCount: 0, sendAttemptStarted: false },
      );
      await Promise.race([
        occurrenceRead,
        cleaning.then(() => {
          throw new Error('Cleanup completed before reaching its recurrence read');
        }),
      ]);
      competing = limitedDb.$transaction(async (tx) => {
        const [{ pid }] = await tx.$queryRaw<Array<{ pid: number }>>(
          Prisma.sql`SELECT pg_backend_pid() AS pid`,
        );
        competingStarted(pid);
        await lockCalendar(tx);
        competingAcquired = true;
      });
      const competingPid = await Promise.race([
        competingReady,
        competing.then(() => {
          throw new Error('Competing writer completed before requesting the calendar lock');
        }),
      ]);
      const observeUntil = Date.now() + 2_000;
      let waitingForCalendar = false;
      do {
        const [state] = await db.$queryRaw<Array<{ waiting: boolean }>>(Prisma.sql`
          SELECT "wait_event_type" = 'Lock' AND "wait_event" = 'advisory' AS "waiting"
          FROM pg_stat_activity
          WHERE pid = ${competingPid}
        `);
        waitingForCalendar = state?.waiting === true;
        if (!waitingForCalendar) await new Promise((resolve) => setTimeout(resolve, 10));
      } while (!waitingForCalendar && Date.now() < observeUntil);
      expect(waitingForCalendar).toBe(true);
      releaseOccurrenceRead();
      await Promise.all([cleaning, competing]);
      expect(competingAcquired).toBe(true);
      expect(await db.managedBroadcast.findUnique({ where: { id: row.id } })).toBeNull();
      expect(
        await db.managedBroadcastDelivery.findUnique({ where: { id: delivery.id } }),
      ).toBeNull();
      expect(
        await db.publicationOccurrence.findUniqueOrThrow({ where: { id: occurrence.id } }),
      ).toMatchObject({
        status: 'CANCELED',
        dispatchBlockerCode: 'PUBLISHER_WINDOW_EXPIRED',
        deliveryDeadlineAt,
      });
      expect(
        await db.publicationOccurrence.findUniqueOrThrow({ where: { id: newer.id } }),
      ).toMatchObject({ status: 'SCHEDULED', deliveryDeadlineAt });
    } finally {
      releaseOccurrenceRead();
      await Promise.allSettled([cleaning, competing]);
      await limitedDb.$disconnect();
    }
  });

  it.each(['edit', 'cancel', 'content'] as const)(
    'fences nonterminal retry deferral behind a concurrent %s',
    async (operation) => {
      const schedule = await db.publicationSchedule.findUniqueOrThrow({ where: { publicationId } });
      let releaseEdit!: () => void;
      let enteredEdit!: () => void;
      let enteredDeferral!: () => void;
      const editReady = new Promise<void>((resolve) => {
        enteredEdit = resolve;
      });
      const editRelease = new Promise<void>((resolve) => {
        releaseEdit = resolve;
      });
      const deferralReady = new Promise<void>((resolve) => {
        enteredDeferral = resolve;
      });
      const editing = db.$transaction(async (tx) => {
        await lockCalendar(tx);
        await tx.publication.update({
          where: { id: publicationId },
          data: {
            version: { increment: 1 },
            lifecycle: operation === 'cancel' ? 'CANCELED' : 'ACTIVE',
          },
        });
        if (operation !== 'content')
          await tx.publicationSchedule.update({
            where: { id: schedule.id },
            data: {
              revision: { increment: 1 },
              status: operation === 'cancel' ? 'CANCELED' : 'ACTIVE',
            },
          });
        enteredEdit();
        await editRelease;
      });
      await editReady;
      const deferring = deferPublicationRecurrencePreparation({
        prisma: db as unknown as PrismaService,
        logger: { warn: jest.fn() },
        schedule,
        publicationVersion: 1,
        lockCalendar: async (tx) => {
          enteredDeferral();
          await lockCalendar(tx);
        },
      });
      await deferralReady;
      releaseEdit();
      await Promise.all([editing, deferring]);
      expect(
        await db.publicationSchedule.findUniqueOrThrow({ where: { id: schedule.id } }),
      ).toMatchObject({ nextMaterializeAt: schedule.nextMaterializeAt, lastError: null });
    },
  );

  it('preserves an explicit retry committed after a missed slot was selected', async () => {
    const occurrence = await createPastOccurrence();
    const retryAt = new Date();
    const createExecution = jest.fn();
    await dispatchScheduledPublicationOccurrences(
      {
        prisma: db as unknown as PrismaService,
        publisherRouting: {
          blockedRetryBefore: () => new Date(Date.now() - 60_000),
        } as unknown as PublicationPublisherRoutingService,
        logger: { warn: jest.fn() },
        resolveTargets: jest.fn(),
        createExecution,
        cancelFutureWork: jest.fn(),
        lockCalendar: async (tx) => {
          await db.publicationOccurrence.update({
            where: { id: occurrence.id },
            data: {
              dispatchBlockerCode: 'PUBLISHER_EXPLICIT_RETRY',
              dispatchBlockedAt: retryAt,
            },
          });
          await lockCalendar(tx);
        },
      },
      1,
      undefined,
      { publicationId },
    );
    expect(
      await db.publicationOccurrence.findUniqueOrThrow({ where: { id: occurrence.id } }),
    ).toMatchObject({
      status: 'SCHEDULED',
      dispatchBlockerCode: 'PUBLISHER_EXPLICIT_RETRY',
      dispatchBlockedAt: retryAt,
    });
    expect(createExecution).not.toHaveBeenCalled();
  });

  it('keeps the first blocker timestamp when stale and fresh deferrals race', async () => {
    const occurrence = await createPastOccurrence();
    const routing = new PublicationPublisherRoutingService(
      db as unknown as PrismaService,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    const error = new PublisherSetupRequiredException(['target'], 'policy_disabled');
    await routing.deferOccurrenceIfBlocked(occurrence, error);
    const first = await db.publicationOccurrence.findUniqueOrThrow({
      where: { id: occurrence.id },
    });
    expect(first.dispatchFirstBlockedAt).toBeInstanceOf(Date);
    await routing.deferOccurrenceIfBlocked(occurrence, error);
    expect(
      await db.publicationOccurrence.findUniqueOrThrow({ where: { id: occurrence.id } }),
    ).toMatchObject({
      dispatchFirstBlockedAt: first.dispatchFirstBlockedAt,
      dispatchBlockedAt: first.dispatchBlockedAt,
    });
    await routing.deferOccurrenceIfBlocked(first, error);
    expect(
      await db.publicationOccurrence.findUniqueOrThrow({ where: { id: occurrence.id } }),
    ).toMatchObject({
      dispatchFirstBlockedAt: first.dispatchFirstBlockedAt,
    });
  });

  it.each(['edit', 'resume', 'cancel', 'content'] as const)(
    'does not overwrite a newer %s while waiting for the calendar lock',
    async (operation) => {
      const schedule = await db.publicationSchedule.findUniqueOrThrow({ where: { publicationId } });
      let releaseEdit!: () => void;
      let enteredEdit!: () => void;
      let enteredRecovery!: () => void;
      const editReady = new Promise<void>((resolve) => {
        enteredEdit = resolve;
      });
      const editRelease = new Promise<void>((resolve) => {
        releaseEdit = resolve;
      });
      const recoveryReady = new Promise<void>((resolve) => {
        enteredRecovery = resolve;
      });
      const editing = db.$transaction(async (tx) => {
        await lockCalendar(tx);
        await tx.publication.update({
          where: { id: publicationId },
          data: {
            version: { increment: 1 },
            lifecycle: operation === 'cancel' ? 'CANCELED' : 'ACTIVE',
          },
        });
        if (operation !== 'content')
          await tx.publicationSchedule.update({
            where: { id: schedule.id },
            data: {
              revision: { increment: 1 },
              status: operation === 'cancel' ? 'CANCELED' : 'ACTIVE',
            },
          });
        enteredEdit();
        await editRelease;
      });
      await editReady;
      const recovery = recoverPublicationRecurrencePreparationFailure({
        prisma: db as unknown as PrismaService,
        logger: { warn: jest.fn() },
        schedule,
        publicationVersion: 1,
        error: new Error('Old preparation failed'),
        lockCalendar: async (tx) => {
          enteredRecovery();
          await lockCalendar(tx);
        },
      });
      await recoveryReady;
      releaseEdit();
      await Promise.all([editing, recovery]);
      const current = await db.publication.findUniqueOrThrow({
        where: { id: publicationId },
        include: { schedule: true },
      });
      expect(current.version).toBe(2);
      expect(current.lifecycle).toBe(operation === 'cancel' ? 'CANCELED' : 'ACTIVE');
      expect(current.schedule!.status).toBe(operation === 'cancel' ? 'CANCELED' : 'ACTIVE');
    },
  );

  it('rolls back the schedule error when the publication write fails', async () => {
    const schedule = await db.publicationSchedule.findUniqueOrThrow({ where: { publicationId } });
    const failingDb = {
      $transaction: (run: (tx: Prisma.TransactionClient) => Promise<unknown>) =>
        db.$transaction(async (tx) => {
          const fenced = new Proxy(tx, {
            get(target, key) {
              if (key === 'publication')
                return {
                  updateMany: async () => {
                    throw new Error('Injected write failure');
                  },
                };
              return Reflect.get(target, key);
            },
          });
          return run(fenced);
        }),
    };
    await expect(
      recoverPublicationRecurrencePreparationFailure({
        prisma: failingDb as unknown as PrismaService,
        logger: { warn: jest.fn() },
        schedule,
        publicationVersion: 1,
        error: new Error('Old preparation failed'),
        lockCalendar,
      }),
    ).rejects.toThrow('Injected write failure');
    expect(
      await db.publicationSchedule.findUniqueOrThrow({ where: { id: schedule.id } }),
    ).toMatchObject({ status: 'ACTIVE', nextMaterializeAt: schedule.nextMaterializeAt });
    expect(await db.publication.findUniqueOrThrow({ where: { id: publicationId } })).toMatchObject({
      lifecycle: 'ACTIVE',
    });
  });
});
