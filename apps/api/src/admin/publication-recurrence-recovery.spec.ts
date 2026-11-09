import { PublisherSetupRequiredException } from '../publisher/publisher-errors';
import { PublicationLifecycle, PublicationScheduleStatus } from '../prisma/prisma-client';
import { PublicationService } from './publication.service';
import { ServiceUnavailableException } from '@nestjs/common';

function createHarness() {
  const scheduledAt = new Date('2026-09-13T09:00:00Z');
  const schedule = {
    id: 'schedule',
    publicationId: 'publication',
    revision: 2,
    nextMaterializeAt: scheduledAt,
    rule: {
      mode: 'recurrence',
      timezone: 'UTC',
      frequency: 'daily',
      interval: 1,
      weekdays: [],
      times: ['12:00'],
      startsAt: '2026-09-13T09:00:00Z',
      endsAt: null,
      maxOccurrences: 2,
      replaceConflicts: false,
    },
    publication: {
      id: 'publication',
      version: 1,
      canonicalContentRevisionId: 'content',
      dispatchProfile: 'PUBLIK_V1',
      requiredBotId: 'publik',
      actorUserId: 'author',
    },
  };
  const scheduleUpdate = jest.fn().mockResolvedValue({ count: 1 });
  const publicationUpdate = jest.fn().mockResolvedValue({ count: 1 });
  const occurrenceCreate = jest.fn().mockResolvedValue({ count: 2 });
  const claim = jest.fn().mockResolvedValue({ count: 1 });
  const latest = jest.fn().mockResolvedValue(null);
  const tx = {
    publicationSchedule: {
      updateMany: jest.fn((args) =>
        args.data.status === PublicationScheduleStatus.ERROR || args.data.lastError
          ? scheduleUpdate(args)
          : claim(args),
      ),
    },
    publication: {
      findUnique: jest.fn().mockResolvedValue({ canonicalContentRevisionId: 'content' }),
      updateMany: publicationUpdate,
    },
    publicationOccurrence: { createMany: occurrenceCreate },
  };
  const transaction = jest.fn(async (callback) => callback(tx));
  const service = Object.assign(Object.create(PublicationService.prototype), {
    prisma: {
      publicationSchedule: {
        findMany: jest.fn().mockResolvedValue([schedule]),
        updateMany: scheduleUpdate,
      },
      publicationOccurrence: { findFirst: latest, count: jest.fn().mockResolvedValue(0) },
      publication: { updateMany: publicationUpdate },
      $transaction: transaction,
    },
    logger: { warn: jest.fn() },
    resolveOccurrenceTargets: jest.fn().mockResolvedValue([{ chatId: 'chat', entityType: 'chat' }]),
    lockPublicationCalendar: jest.fn().mockResolvedValue(undefined),
    reservePublicationCalendar: jest.fn().mockResolvedValue(undefined),
  });
  return {
    service,
    schedule,
    scheduleUpdate,
    publicationUpdate,
    occurrenceCreate,
    latest,
    transaction,
    claim,
  };
}

describe('Publication recurrence preparation recovery', () => {
  beforeEach(() => jest.useFakeTimers().setSystemTime(new Date('2026-09-13T10:00:00Z')));
  afterEach(() => jest.useRealTimers());

  it.each([
    ...['P1001', 'P2024', 'P2028', 'P2034'].map((code) => ({
      label: code,
      error: Object.assign(new Error('Transient database failure'), { code }),
    })),
    ...['57014', '40P01', '40001', '55P03'].map((code) => ({
      label: `P2010 SQLSTATE ${code}`,
      error: Object.assign(new Error('Raw query failed'), {
        code: 'P2010',
        meta: { driverAdapterError: { cause: { originalCode: code } } },
      }),
    })),
  ])(
    'preserves the schedule after $label and materializes it on the next poll',
    async ({ error }) => {
      const harness = createHarness();
      harness.transaction.mockRejectedValueOnce(error);
      await harness.service.materializeRecurringSchedules(1);
      expect(harness.scheduleUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            nextMaterializeAt: new Date('2026-09-13T09:00:00Z'),
            revision: 2,
          }),
          data: {
            nextMaterializeAt: expect.any(Date),
            lastError: 'PUBLICATION_PREPARATION_TRANSIENT',
          },
        }),
      );
      expect(harness.publicationUpdate).not.toHaveBeenCalled();
      expect(harness.occurrenceCreate).not.toHaveBeenCalled();

      jest.advanceTimersByTime(75_000);
      await harness.service.materializeRecurringSchedules(1);
      expect(harness.occurrenceCreate).toHaveBeenCalledTimes(1);
      expect(harness.claim).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ lastError: null }),
        }),
      );
    },
  );

  it('does not terminalize the schedule when a pre-transaction read times out', async () => {
    const harness = createHarness();
    harness.latest.mockRejectedValue(Object.assign(new Error('Pool timeout'), { code: 'P2024' }));
    await harness.service.materializeRecurringSchedules(1);
    expect(harness.scheduleUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ lastError: 'PUBLICATION_PREPARATION_TRANSIENT' }),
      }),
    );
    expect(harness.publicationUpdate).not.toHaveBeenCalled();
    expect(harness.transaction).toHaveBeenCalledTimes(1);
  });

  it.each([
    [1, 'access'],
    [2, 'access'],
    [50, 'access'],
    [2, 'database'],
  ] as const)(
    'lets healthy schedules pass a first batch of %s %s failures without widening the scan',
    async (limit, failureType) => {
      const harness = createHarness();
      const schedules = Array.from({ length: limit + 1 }, (_, index) => ({
        ...harness.schedule,
        id: `schedule-${index}`,
        publicationId: `publication-${index}`,
        nextMaterializeAt: new Date('2026-09-13T09:00:00Z'),
        lastError: null,
        publication: { ...harness.schedule.publication, id: `publication-${index}` },
      }));
      const select = harness.service.prisma.publicationSchedule.findMany;
      select.mockImplementation(
        async ({ where, take }: { where: { nextMaterializeAt: { lte: Date } }; take: number }) =>
          schedules
            .filter(
              (schedule) =>
                schedule.nextMaterializeAt &&
                schedule.nextMaterializeAt <= where.nextMaterializeAt.lte,
            )
            .sort(
              (left, right) => left.nextMaterializeAt.getTime() - right.nextMaterializeAt.getTime(),
            )
            .slice(0, take),
      );
      harness.scheduleUpdate.mockImplementation(async ({ where, data }) => {
        const schedule = schedules.find((entry) => entry.id === where.id);
        if (
          !schedule ||
          schedule.revision !== where.revision ||
          schedule.nextMaterializeAt.getTime() !== where.nextMaterializeAt.getTime()
        )
          return { count: 0 };
        Object.assign(schedule, data);
        return { count: 1 };
      });
      harness.service.resolveOccurrenceTargets.mockImplementation(
        async (publication: { id: string }) => {
          if (publication.id !== `publication-${limit}`)
            throw failureType === 'access'
              ? new ServiceUnavailableException('MAX temporarily unavailable')
              : Object.assign(new Error('Transient pool timeout'), { code: 'P2024' });
          return [{ chatId: 'healthy-chat', entityType: 'chat' }];
        },
      );
      await harness.service.materializeRecurringSchedules(limit);
      expect(harness.occurrenceCreate).not.toHaveBeenCalled();
      for (const schedule of schedules.slice(0, limit)) {
        expect(schedule.nextMaterializeAt.getTime()).toBeGreaterThanOrEqual(
          new Date('2026-09-13T10:01:00Z').getTime(),
        );
        expect(schedule.nextMaterializeAt.getTime()).toBeLessThan(
          new Date('2026-09-13T10:01:15Z').getTime(),
        );
      }
      await harness.service.materializeRecurringSchedules(limit);
      expect(harness.occurrenceCreate).toHaveBeenCalledTimes(1);
      expect(select).toHaveBeenCalledTimes(2);
      for (const [query] of select.mock.calls) expect(query.take).toBe(limit);
    },
  );

  it('keeps empty recurrence recovery from undoing a persisted preparation pause', async () => {
    const harness = createHarness();
    harness.service.prisma.publicationSchedule.findMany.mockResolvedValue([]);
    await harness.service.reconcileActiveRecurrenceSchedules(2);
    expect(harness.service.prisma.publicationSchedule.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ lastError: null }) }),
    );
  });

  it('stops the bounded sweep if the database cannot persist deferral', async () => {
    const harness = createHarness();
    harness.service.prisma.publicationSchedule.findMany.mockResolvedValue([
      harness.schedule,
      { ...harness.schedule, id: 'healthy-second' },
    ]);
    const transient = Object.assign(new Error('Pool timeout'), { code: 'P2024' });
    harness.latest.mockRejectedValue(transient);
    harness.scheduleUpdate.mockRejectedValue(transient);
    await expect(harness.service.materializeRecurringSchedules(2)).resolves.toBeUndefined();
    expect(harness.latest).toHaveBeenCalledTimes(1);
    expect(harness.scheduleUpdate).toHaveBeenCalledTimes(1);
    expect(harness.publicationUpdate).not.toHaveBeenCalled();
  });

  it('backs off unavailable Publisher access without canceling the recurrence', async () => {
    const harness = createHarness();
    harness.service.resolveOccurrenceTargets.mockRejectedValue(
      new PublisherSetupRequiredException(['chat'], 'PUBLISHER_ACTOR_ACCESS_REQUIRED'),
    );
    await harness.service.materializeRecurringSchedules(1);
    expect(harness.scheduleUpdate).toHaveBeenCalledWith({
      where: {
        id: 'schedule',
        revision: 2,
        status: PublicationScheduleStatus.ACTIVE,
        nextMaterializeAt: new Date('2026-09-13T09:00:00Z'),
        publication: { is: { lifecycle: PublicationLifecycle.ACTIVE, version: 1 } },
      },
      data: {
        nextMaterializeAt: new Date('2026-09-13T10:01:00Z'),
        lastError: 'PUBLISHER_ACTOR_ACCESS_REQUIRED',
      },
    });
    expect(harness.publicationUpdate).not.toHaveBeenCalled();
    expect(harness.occurrenceCreate).not.toHaveBeenCalled();
  });

  it('still records a permanent preparation failure under the observed schedule fence', async () => {
    const harness = createHarness();
    harness.service.reservePublicationCalendar.mockRejectedValue(new Error('Invalid calendar'));
    await harness.service.materializeRecurringSchedules(1);
    expect(harness.scheduleUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          nextMaterializeAt: new Date('2026-09-13T09:00:00Z'),
          revision: 2,
        }),
        data: {
          status: PublicationScheduleStatus.ERROR,
          nextMaterializeAt: null,
          lastError: 'Invalid calendar',
        },
      }),
    );
    expect(harness.publicationUpdate).toHaveBeenCalledTimes(1);
    expect(harness.service.lockPublicationCalendar).toHaveBeenCalledTimes(2);
    expect(harness.publicationUpdate).toHaveBeenCalledWith({
      where: { id: 'publication', lifecycle: PublicationLifecycle.ACTIVE, version: 1 },
      data: { lifecycle: PublicationLifecycle.ERROR },
    });
  });

  it('does not change a publication when a newer schedule or content revision wins', async () => {
    const harness = createHarness();
    harness.service.reservePublicationCalendar.mockRejectedValue(new Error('Invalid calendar'));
    harness.scheduleUpdate.mockResolvedValue({ count: 0 });
    await harness.service.materializeRecurringSchedules(1);
    expect(harness.publicationUpdate).not.toHaveBeenCalled();
  });
});
