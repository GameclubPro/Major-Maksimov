import {
  Prisma,
  PublicationDispatchProfile,
  PublicationLifecycle,
  PublicationOccurrenceStatus,
  PublicationScheduleMode,
  PublicationScheduleStatus,
} from '../prisma/prisma-client';
import { dispatchScheduledPublicationOccurrences } from './publication-occurrence-dispatcher';

const occurrence = {
  id: 'occurrence-1',
  publicationId: 'publication-1',
  scheduleId: 'schedule-1',
  scheduleRevision: 3,
  contentRevisionId: 'content-4',
  dispatchProfile: PublicationDispatchProfile.PUBLIK_V1,
  requiredBotId: 'publisher-bot',
  scheduledAt: new Date('2026-09-04T10:00:00.000Z'),
  schedule: {
    id: 'schedule-1',
    mode: PublicationScheduleMode.NOW,
    revision: 3,
    status: PublicationScheduleStatus.ACTIVE,
    rule: { mode: 'now', timezone: 'Europe/Moscow' },
  },
  contentRevision: {},
  publication: {
    actorUserId: 'user-1',
    lifecycle: PublicationLifecycle.ACTIVE,
    targets: [],
  },
};

function createHarness(options: {
  createExecutionError: unknown;
  occurrenceClaimCount?: number;
  scheduleClaimCount?: number;
  publicationClaimCount?: number;
}) {
  const tx = {
    publicationOccurrence: {
      updateMany: jest.fn().mockResolvedValue({ count: options.occurrenceClaimCount ?? 1 }),
    },
    publicationSchedule: {
      updateMany: jest.fn().mockResolvedValue({ count: options.scheduleClaimCount ?? 1 }),
    },
    publication: {
      updateMany: jest.fn().mockResolvedValue({ count: options.publicationClaimCount ?? 1 }),
    },
  };
  let rolledBack = false;
  const transaction = jest.fn(async (operation: (client: typeof tx) => Promise<unknown>) => {
    try {
      return await operation(tx);
    } catch (error: unknown) {
      rolledBack = true;
      throw error;
    }
  });
  const logger = { warn: jest.fn() };
  const publisherRouting = {
    blockedRetryBefore: jest.fn((now: Date) => new Date(now.getTime() - 60_000)),
    deferOccurrenceIfBlocked: jest.fn().mockResolvedValue(false),
  };
  const lockCalendar = jest.fn().mockResolvedValue(undefined);
  const cancelFutureWork = jest.fn().mockResolvedValue(undefined);
  const createExecution = jest.fn().mockRejectedValue(options.createExecutionError);
  const context = {
    prisma: {
      publicationOccurrence: { findMany: jest.fn().mockResolvedValue([occurrence]) },
      $transaction: transaction,
    },
    publisherRouting,
    logger,
    resolveTargets: jest.fn().mockResolvedValue([
      {
        chatId: 'chat-1',
        entityType: 'chat',
        title: 'Chat 1',
        avatarUrl: null,
        link: null,
      },
    ]),
    createExecution,
    lockCalendar,
    cancelFutureWork,
  };

  return {
    context,
    tx,
    transaction,
    logger,
    publisherRouting,
    lockCalendar,
    cancelFutureWork,
    wasRolledBack: () => rolledBack,
  };
}

describe('publication occurrence dispatcher', () => {
  it('uses durable manual retry authorization even after a Redis wake is lost', async () => {
    const harness = createHarness({ createExecutionError: null });
    harness.context.createExecution.mockResolvedValue(undefined);
    harness.context.prisma.publicationOccurrence.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          ...occurrence,
          schedule: { ...occurrence.schedule, mode: PublicationScheduleMode.ONCE },
          dispatchBlockerCode: 'PUBLISHER_EXPLICIT_RETRY',
          dispatchBlockedAt: new Date(),
        },
      ]);
    await dispatchScheduledPublicationOccurrences(harness.context as never, 1);
    expect(harness.context.createExecution).toHaveBeenCalledTimes(1);
  });

  it('does not let a delayed explicit wake revive expired retry authorization', async () => {
    const harness = createHarness({ createExecutionError: null });
    harness.context.prisma.publicationOccurrence.findMany
      .mockResolvedValueOnce([
        {
          ...occurrence,
          schedule: { ...occurrence.schedule, mode: PublicationScheduleMode.ONCE },
          dispatchBlockerCode: 'PUBLISHER_EXPLICIT_RETRY',
          dispatchBlockedAt: new Date(Date.now() - 600_000),
        },
      ])
      .mockResolvedValueOnce([]);
    await dispatchScheduledPublicationOccurrences(harness.context as never, 1, undefined, {
      occurrenceId: occurrence.id,
    });
    expect(harness.context.createExecution).not.toHaveBeenCalled();
    expect(harness.tx.publicationOccurrence.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'FAILED',
          dispatchBlockerCode: 'PUBLISHER_MISSED_WINDOW_REVIEW',
        }),
      }),
    );
  });
  it.each([
    PublicationScheduleMode.ONCE,
    PublicationScheduleMode.SLOTS,
    PublicationScheduleMode.RECURRENCE,
  ])('does not send missed %s slots after access returns', async (mode) => {
    const harness = createHarness({ createExecutionError: null });
    harness.context.prisma.publicationOccurrence.findMany
      .mockResolvedValueOnce([{ ...occurrence, schedule: { ...occurrence.schedule, mode } }])
      .mockResolvedValueOnce([]);
    await dispatchScheduledPublicationOccurrences(harness.context as never, 1);
    expect(harness.context.createExecution).not.toHaveBeenCalled();
    expect(harness.context.resolveTargets).not.toHaveBeenCalled();
    expect(harness.tx.publicationOccurrence.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: mode === PublicationScheduleMode.RECURRENCE ? 'CANCELED' : 'FAILED',
        }),
      }),
    );
  });
  it('prepares new ready work ahead of older blocked schedules while reserving recovery', async () => {
    const harness = createHarness({ createExecutionError: null });
    const ready = Array.from({ length: 10 }, (_, index) => ({
      ...occurrence,
      id: `ready-${index}`,
      scheduledAt: new Date('2026-09-27T10:00:00Z'),
    }));
    const blocked = Array.from({ length: 2 }, (_, index) => ({
      ...occurrence,
      id: `blocked-${index}`,
      scheduledAt: new Date('2026-09-01T10:00:00Z'),
    }));
    harness.context.prisma.publicationOccurrence.findMany
      .mockResolvedValueOnce(ready)
      .mockResolvedValueOnce(blocked);
    harness.context.createExecution.mockResolvedValue(undefined);

    await dispatchScheduledPublicationOccurrences(harness.context as never, 10);

    expect(harness.context.createExecution.mock.calls.map(([row]) => row.id)).toEqual(
      [...ready.slice(0, 8), ...blocked].map((row) => row.id),
    );
    const calls = harness.context.prisma.publicationOccurrence.findMany.mock.calls as any[];
    expect(calls[0][0].where.dispatchBlockerCode).toBeNull();
    expect(calls[1][0].where.dispatchBlockerCode).toEqual({ not: null });
    expect(calls[1][0].take).toBe(2);
  });

  it('uses spare capacity for blocked recovery without increasing the total batch', async () => {
    const harness = createHarness({ createExecutionError: null });
    harness.context.prisma.publicationOccurrence.findMany
      .mockResolvedValueOnce([occurrence])
      .mockResolvedValueOnce([{ ...occurrence, id: 'blocked' }]);
    harness.context.createExecution.mockResolvedValue(undefined);
    await dispatchScheduledPublicationOccurrences(harness.context as never, 2);
    expect(harness.context.createExecution).toHaveBeenCalledTimes(2);
  });

  it.each([
    [
      'P1001 connection failure',
      Object.assign(new Error('database unavailable'), { code: 'P1001' }),
    ],
    ['P2024 pool timeout', Object.assign(new Error('pool timeout'), { code: 'P2024' })],
    [
      'P2028 transaction timeout',
      Object.assign(new Error('transaction timeout'), { code: 'P2028' }),
    ],
    [
      'Prisma initialization failure',
      new Prisma.PrismaClientInitializationError('database unavailable', 'test-client'),
    ],
    ...['57014', '40P01', '40001', '55P03'].map((code): [string, Error] => [
      `P2010 SQLSTATE ${code}`,
      Object.assign(new Error('Raw query failed'), {
        code: 'P2010',
        meta: { driverAdapterError: { cause: { originalCode: code } } },
      }),
    ]),
  ])('rethrows a transient %s without a permanent domain transition', async (_label, error) => {
    const harness = createHarness({ createExecutionError: error });

    await expect(
      dispatchScheduledPublicationOccurrences(harness.context as never, 1, [
        PublicationScheduleMode.NOW,
      ]),
    ).rejects.toBe(error);

    expect(harness.publisherRouting.deferOccurrenceIfBlocked).not.toHaveBeenCalled();
    expect(harness.transaction).not.toHaveBeenCalled();
    expect(harness.logger.warn).not.toHaveBeenCalled();
  });

  it('keeps a permanent raw query failure terminal instead of deferring it forever', async () => {
    const failure = Object.assign(new Error('Invalid publication SQL'), {
      code: 'P2010',
      meta: { driverAdapterError: { cause: { originalCode: '42601' } } },
    });
    const harness = createHarness({ createExecutionError: failure });
    await dispatchScheduledPublicationOccurrences(harness.context as never, 1, [
      PublicationScheduleMode.NOW,
    ]);
    expect(harness.tx.publicationSchedule.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'ERROR' }) }),
    );
    expect(harness.cancelFutureWork).toHaveBeenCalledTimes(1);
  });

  it('does not stop the schedule when another worker materialized the occurrence first', async () => {
    const harness = createHarness({
      createExecutionError: new Error('invalid publication payload'),
      occurrenceClaimCount: 0,
    });

    await expect(
      dispatchScheduledPublicationOccurrences(harness.context as never, 1, [
        PublicationScheduleMode.NOW,
      ]),
    ).resolves.toBeUndefined();

    expect(harness.lockCalendar).toHaveBeenCalledTimes(1);
    expect(harness.tx.publicationOccurrence.updateMany).toHaveBeenCalledWith({
      where: {
        id: occurrence.id,
        publicationId: occurrence.publicationId,
        scheduleId: occurrence.scheduleId,
        scheduleRevision: occurrence.scheduleRevision,
        contentRevisionId: occurrence.contentRevisionId,
        status: PublicationOccurrenceStatus.SCHEDULED,
        legacyBroadcasts: { none: {} },
      },
      data: { status: PublicationOccurrenceStatus.FAILED },
    });
    expect(harness.tx.publicationSchedule.updateMany).not.toHaveBeenCalled();
    expect(harness.tx.publication.updateMany).not.toHaveBeenCalled();
    expect(harness.cancelFutureWork).not.toHaveBeenCalled();
    expect(harness.logger.warn).not.toHaveBeenCalled();
  });

  it('commits the permanent domain transition after winning the occurrence fence', async () => {
    const failure = new Error('invalid publication payload');
    const harness = createHarness({ createExecutionError: failure });

    await expect(
      dispatchScheduledPublicationOccurrences(harness.context as never, 1, [
        PublicationScheduleMode.NOW,
      ]),
    ).resolves.toBeUndefined();

    expect(harness.tx.publicationSchedule.updateMany).toHaveBeenCalledWith({
      where: {
        id: occurrence.scheduleId,
        publicationId: occurrence.publicationId,
        revision: occurrence.scheduleRevision,
        status: PublicationScheduleStatus.ACTIVE,
      },
      data: {
        status: PublicationScheduleStatus.ERROR,
        nextMaterializeAt: null,
        lastError: failure.message,
      },
    });
    expect(harness.tx.publication.updateMany).toHaveBeenCalledWith({
      where: {
        id: occurrence.publicationId,
        lifecycle: PublicationLifecycle.ACTIVE,
      },
      data: { lifecycle: PublicationLifecycle.ERROR },
    });
    expect(harness.cancelFutureWork).toHaveBeenCalledTimes(1);
    expect(harness.logger.warn).toHaveBeenCalledWith(
      {
        occurrenceId: occurrence.id,
        publicationId: occurrence.publicationId,
        err: failure.message,
      },
      'Failed to prepare publication execution',
    );
    expect(harness.lockCalendar.mock.invocationCallOrder[0]).toBeLessThan(
      harness.tx.publicationOccurrence.updateMany.mock.invocationCallOrder[0]!,
    );
    expect(harness.tx.publicationOccurrence.updateMany.mock.invocationCallOrder[0]).toBeLessThan(
      harness.tx.publicationSchedule.updateMany.mock.invocationCallOrder[0]!,
    );
  });

  it.each([
    ['schedule', { scheduleClaimCount: 0 }, false],
    ['publication', { publicationClaimCount: 0 }, true],
  ])(
    'rolls back the occurrence failure when the %s fence was lost',
    async (_label, claimCounts, publicationUpdateAttempted) => {
      const harness = createHarness({
        createExecutionError: new Error('invalid publication payload'),
        ...claimCounts,
      });

      await expect(
        dispatchScheduledPublicationOccurrences(harness.context as never, 1, [
          PublicationScheduleMode.NOW,
        ]),
      ).resolves.toBeUndefined();

      expect(harness.wasRolledBack()).toBe(true);
      expect(harness.tx.publication.updateMany).toHaveBeenCalledTimes(
        publicationUpdateAttempted ? 1 : 0,
      );
      expect(harness.cancelFutureWork).not.toHaveBeenCalled();
      expect(harness.logger.warn).not.toHaveBeenCalled();
    },
  );
});
