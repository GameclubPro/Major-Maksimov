import { randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { PrismaClient, createPrismaAdapter } from '../prisma/prisma-client';
import { PublicationContentService } from './publication-content.service';
import type { PublicationPublisherRoutingService } from './publication-publisher-routing.service';
import { PublicationService } from './publication.service';

const databaseUrl = process.env.CHAT_ROUTING_POSTGRES_RACE_DATABASE_URL?.trim() ?? '';
const postgres = databaseUrl ? describe : describe.skip;
const now = new Date('2026-11-20T09:00:00Z');
const profile = 'PUBLIK_V1';
const user = { userId: 'calendar-projection-author', username: null, displayName: null };
const firstChat = 'calendar-projection-first';
const secondChat = 'calendar-projection-second';
const botId = 'calendar-projection-bot';
const withAudience = (...chatIds: string[]) => ({
  selection: 'SELECTED',
  mode: 'SNAPSHOT',
  targets: chatIds.map((chatId) => ({ chatId, entityType: 'chat' as const })),
});
const recurrence = {
  mode: 'recurrence',
  timezone: 'UTC',
  frequency: 'daily',
  times: ['10:00'],
  startsAt: now.toISOString(),
};
const once = (at: string) => ({ mode: 'once', timezone: 'UTC', at });
const target = (chatId: string) => ({
  chatId,
  entityType: 'chat' as const,
  title: chatId,
  avatarUrl: null,
  link: null,
});
const routing = {
  requireNewRoute: () => ({ dispatchProfile: profile, requiredBotId: botId }),
  resolveAudienceTargets: async (_user, body) => body.targets.map(({ chatId }) => target(chatId)),
  resolvePersistedTargets: async (_user, rows) => rows.map((row) => target(row.targetChatId)),
  resolveScheduledTargets: async (row) => row.targets.map((saved) => target(saved.targetChatId)),
  assertTargetsReady: async (targets) =>
    targets.map((entry) => ({ ...entry, requiredBotId: botId, policyRevision: 0 })),
} satisfies Pick<
  PublicationPublisherRoutingService,
  | 'requireNewRoute'
  | 'resolveAudienceTargets'
  | 'resolvePersistedTargets'
  | 'resolveScheduledTargets'
  | 'assertTargetsReady'
>;

postgres('Publication calendar with PostgreSQL', () => {
  let db: PrismaClient;
  let service: PublicationService;
  const create = (schedule: unknown, destination = firstChat) =>
    service.create(user, {
      requestId: randomUUID(),
      intent: 'publish',
      content: { text: 'Calendar projection fixture' },
      schedule,
      audience: withAudience(destination),
    });
  const refreshSeries = () =>
    (
      service as unknown as { materializeRecurringSchedules(limit: number): Promise<void> }
    ).materializeRecurringSchedules(10);

  beforeAll(async () => {
    const url = new URL(databaseUrl);
    if (
      !['127.0.0.1', 'localhost', '::1'].includes(url.hostname) ||
      !url.pathname.includes('race_test')
    ) {
      throw new Error('Disposable local race_test database required');
    }
    db = new PrismaClient({
      adapter: createPrismaAdapter(databaseUrl, { max: 4, statement_timeout: 10_000 }),
    });
    await db.$connect();
    for (const chatId of [firstChat, secondChat]) {
      await db.chat.create({ data: { id: chatId, title: chatId } });
      await db.managedEntityAccessEdge.create({
        data: {
          chatId,
          userId: user.userId,
          botId,
          entityType: 'CHAT',
          state: 'GRANTED',
          userRole: 'ADMIN',
          botRole: 'ADMIN',
          source: 'calendar-fixture',
        },
      });
    }
    service = new PublicationService(
      db as never,
      new PublicationContentService(db as never, {} as never),
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      routing as never,
      { enqueueAfterCommittedMutation: async () => undefined } as never,
      new ConfigService({}),
    );
    jest.spyOn(service, 'get').mockImplementation(async (id) => ({ id }) as never);
  });
  beforeEach(() => {
    jest
      .useFakeTimers({
        doNotFake: [
          'hrtime',
          'nextTick',
          'performance',
          'queueMicrotask',
          'setImmediate',
          'clearImmediate',
          'setTimeout',
          'clearTimeout',
          'setInterval',
          'clearInterval',
        ],
      })
      .setSystemTime(now);
  });
  afterEach(async () => {
    jest.useRealTimers();
    await db.publication.deleteMany({ where: { actorUserId: user.userId } });
  });
  afterAll(async () => {
    if (!db) return;
    await db.chat.deleteMany({ where: { id: { in: [firstChat, secondChat] } } });
    await db.$disconnect();
  });

  it.each([null, 3])(
    'admits a distant start with limit %s and materializes its first slot once',
    async (maxOccurrences) => {
      const publication = await create({
        ...recurrence,
        startsAt: '2026-12-11T09:00:00.000Z',
        maxOccurrences,
      });
      const schedule = await db.publicationSchedule.findUniqueOrThrow({
        where: { publicationId: publication.id },
      });
      expect(schedule.nextMaterializeAt?.toISOString()).toBe('2026-11-27T10:00:00.000Z');
      expect(
        await db.publicationOccurrence.count({ where: { publicationId: publication.id } }),
      ).toBe(0);
      jest.setSystemTime(schedule.nextMaterializeAt!);
      await refreshSeries();
      await refreshSeries();
      expect(
        await db.publicationOccurrence.findMany({
          where: { publicationId: publication.id },
          select: { scheduledAt: true, status: true },
        }),
      ).toEqual([{ scheduledAt: new Date('2026-12-11T10:00:00.000Z'), status: 'SCHEDULED' }]);
    },
  );

  it('protects a projected slot outside the materialized horizon and excludes the series when editing it', async () => {
    const at = '2026-12-10T10:00:00.000Z';
    const series = await create(recurrence);
    expect(await db.publicationOccurrence.count({ where: { publicationId: series.id } })).toBe(14);
    const availability = { audience: withAudience(firstChat), from: at, to: at };
    await expect(service.getCalendarAvailability(user, availability)).resolves.toMatchObject({
      slots: [{ scheduledAt: at, targetCount: 1 }],
    });
    await expect(
      service.getCalendarAvailability(user, { ...availability, excludePublicationId: series.id }),
    ).resolves.toMatchObject({ slots: [] });
    await expect(create({ ...once(at), replaceConflicts: true })).rejects.toMatchObject({
      response: {
        code: 'PUBLICATION_CONFLICT_REQUIRES_MANUAL_REVIEW',
        conflicts: [{ chatId: firstChat, scheduledAt: at }],
        conflictCount: 1,
      },
    });
    await expect(create(once(at), secondChat)).resolves.toMatchObject({ id: expect.any(String) });
  });

  it('also detects an earlier booking when creating the prospective series', async () => {
    const at = '2026-12-10T10:00:00.000Z';
    const booked = await create(once(at));
    await expect(create(recurrence)).rejects.toMatchObject({
      response: {
        code: 'PUBLICATION_SCHEDULE_CONFLICT',
        conflicts: [{ chatId: firstChat, scheduledAt: at }],
        conflictCount: 1,
      },
    });
    expect(await db.publication.count({ where: { actorUserId: user.userId } })).toBe(1);
    expect(
      await db.publicationOccurrence.findFirst({ where: { publicationId: booked.id } }),
    ).toMatchObject({ status: 'SCHEDULED' });
  });

  it('rechecks concurrent calendar writers on PostgreSQL', async () => {
    const results = await Promise.allSettled([
      create(recurrence),
      create(once('2026-12-10T10:00:00.000Z')),
    ]);
    expect(results.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(({ status }) => status === 'rejected')).toHaveLength(1);
    expect(await db.publication.count({ where: { actorUserId: user.userId } })).toBe(1);
  });

  it('rejects replacement when the confirmed conflicting occurrence changed', async () => {
    const at = '2026-12-10T10:00:00.000Z';
    await create(once(at));
    const readConfirmation = async () => {
      try {
        await create(once(at));
      } catch (error) {
        if (error instanceof Error && 'response' in error) {
          return (error.response as { conflictConfirmation: string }).conflictConfirmation;
        }
        throw error;
      }
      throw new Error('Expected a calendar conflict');
    };
    const oldConfirmation = await readConfirmation();
    expect(oldConfirmation).toMatch(/^[a-f0-9]{64}$/u);
    const replacement = await create({
      ...once(at),
      replaceConflicts: true,
      conflictConfirmation: oldConfirmation,
    });
    const newConfirmation = await readConfirmation();
    expect(newConfirmation).not.toBe(oldConfirmation);
    await expect(
      create({
        ...once(at),
        replaceConflicts: true,
        conflictConfirmation: oldConfirmation,
      }),
    ).rejects.toMatchObject({
      response: {
        code: 'PUBLICATION_SCHEDULE_CONFLICT',
        conflictConfirmation: newConfirmation,
      },
    });
    const persisted = await db.publicationSchedule.findUniqueOrThrow({
      where: { publicationId: replacement.id },
    });
    expect(persisted.rule).toMatchObject({ replaceConflicts: false });
    expect(persisted.rule).not.toHaveProperty('conflictConfirmation');
    expect(
      await db.publicationOccurrence.findFirst({ where: { publicationId: replacement.id } }),
    ).toMatchObject({ status: 'SCHEDULED' });
  });

  it('skips a late collision inherited from an already accepted calendar and keeps adjacent slots', async () => {
    const at = '2026-12-10T10:00:00.000Z';
    const series = await create(recurrence);
    const other = await create(once(at), secondChat);
    // Seed the pre-change state where both posts were already accepted for this recipient.
    await db.publicationTarget.updateMany({
      where: { publicationId: other.id },
      data: { targetChatId: firstChat },
    });
    jest.setSystemTime(new Date('2026-11-27T09:00:00.000Z'));
    await refreshSeries();
    expect(
      await db.publicationSchedule.findUnique({ where: { publicationId: series.id } }),
    ).toMatchObject({ status: 'ACTIVE', lastError: null });
    expect(
      await db.publicationOccurrence.findUnique({
        where: {
          publicationId_scheduleRevision_scheduledAt: {
            publicationId: series.id,
            scheduleRevision: 1,
            scheduledAt: new Date(at),
          },
        },
      }),
    ).toMatchObject({
      status: 'CANCELED',
      dispatchBlockerCode: 'PUBLICATION_CALENDAR_SLOT_OCCUPIED',
    });
    expect(
      await db.publicationOccurrence.count({
        where: { publicationId: series.id, status: 'SCHEDULED', scheduledAt: { gt: new Date(at) } },
      }),
    ).toBe(0);
    jest.setSystemTime(new Date('2026-11-28T13:00:00.000Z'));
    await refreshSeries();
    expect(
      await db.publicationOccurrence.count({
        where: { publicationId: series.id, status: 'SCHEDULED', scheduledAt: { gt: new Date(at) } },
      }),
    ).toBeGreaterThan(0);
    expect(
      await db.publicationOccurrence.findFirst({ where: { publicationId: other.id } }),
    ).toMatchObject({ status: 'SCHEDULED', scheduledAt: new Date(at) });
  });

  it('preserves the remaining count after an audience edit and keeps prior occurrences', async () => {
    const series = await create({ ...recurrence, maxOccurrences: 3 });
    await db.publicationOccurrence.updateMany({
      where: { publicationId: series.id, scheduledAt: { lt: new Date('2026-11-21T12:00:00Z') } },
      data: { status: 'SENT' },
    });
    jest.setSystemTime(new Date('2026-11-21T12:00:00Z'));
    await service.update(
      series.id,
      user,
      {
        requestId: randomUUID(),
        expectedRevision: 1,
        audience: withAudience(secondChat),
      },
      profile,
    );
    expect(
      await db.publicationOccurrence.findMany({
        where: { publicationId: series.id },
        orderBy: [{ scheduleRevision: 'asc' }, { scheduledAt: 'asc' }],
        select: { scheduleRevision: true, status: true, scheduledAt: true },
      }),
    ).toEqual([
      { scheduleRevision: 1, status: 'SENT', scheduledAt: new Date('2026-11-20T10:00:00Z') },
      { scheduleRevision: 1, status: 'SENT', scheduledAt: new Date('2026-11-21T10:00:00Z') },
      { scheduleRevision: 1, status: 'CANCELED', scheduledAt: new Date('2026-11-22T10:00:00Z') },
      { scheduleRevision: 2, status: 'SCHEDULED', scheduledAt: new Date('2026-11-22T10:00:00Z') },
    ]);
  });

  it('skips exactly one upcoming occurrence and replays the same command without another revision', async () => {
    const series = await create({ ...recurrence, maxOccurrences: 2 });
    const [first, second] = await db.publicationOccurrence.findMany({
      where: { publicationId: series.id },
      orderBy: { scheduledAt: 'asc' },
    });
    const request = { expectedRevision: 1, requestId: randomUUID() };
    await service.skipOccurrence(series.id, first.id, user, request, profile);
    await service.skipOccurrence(series.id, first.id, user, request, profile);
    await expect(
      service.skipOccurrence(
        series.id,
        second.id,
        user,
        {
          expectedRevision: 1,
          requestId: randomUUID(),
        },
        profile,
      ),
    ).rejects.toMatchObject({ response: { code: 'PUBLICATION_REVISION_CONFLICT' } });
    expect(await db.publication.findUnique({ where: { id: series.id } })).toMatchObject({
      version: 2,
    });
    expect(await db.publicationOccurrence.findUnique({ where: { id: first.id } })).toMatchObject({
      status: 'CANCELED',
      dispatchBlockerCode: 'PUBLICATION_CALENDAR_SLOT_SKIPPED',
    });
    expect(await db.publicationOccurrence.findUnique({ where: { id: second.id } })).toMatchObject({
      status: 'SCHEDULED',
      scheduledAt: second.scheduledAt,
    });
    await service.update(
      series.id,
      user,
      {
        requestId: randomUUID(),
        expectedRevision: 2,
        audience: withAudience(secondChat),
      },
      profile,
    );
    const rebuilt = await db.publicationOccurrence.findMany({
      where: { publicationId: series.id, scheduleRevision: 2 },
      orderBy: { scheduledAt: 'asc' },
      select: { status: true, scheduledAt: true, dispatchBlockerCode: true },
    });
    expect(rebuilt).toEqual([
      {
        status: 'CANCELED',
        scheduledAt: first.scheduledAt,
        dispatchBlockerCode: 'PUBLICATION_CALENDAR_SLOT_SKIPPED',
      },
      { status: 'SCHEDULED', scheduledAt: second.scheduledAt, dispatchBlockerCode: null },
    ]);
  });

  it('rejects skip once an execution envelope exists and rolls back the version', async () => {
    const series = await create({ ...recurrence, maxOccurrences: 1 });
    const slot = await db.publicationOccurrence.findFirstOrThrow({
      where: { publicationId: series.id },
    });
    await db.managedBroadcast.create({
      data: {
        sourceChatId: firstChat,
        actorUserId: user.userId,
        targetChatIds: [firstChat],
        buttons: [],
        dispatchProfile: profile,
        requiredBotId: botId,
        publicationOccurrenceId: slot.id,
        publicationContentRevisionId: slot.contentRevisionId,
        nextSendAt: slot.scheduledAt,
      },
    });
    await expect(
      service.skipOccurrence(
        series.id,
        slot.id,
        user,
        {
          requestId: randomUUID(),
          expectedRevision: 1,
        },
        profile,
      ),
    ).rejects.toMatchObject({ status: 409 });
    expect(await db.publication.findUnique({ where: { id: series.id } })).toMatchObject({
      version: 1,
    });
    expect(await db.publicationOccurrence.findUnique({ where: { id: slot.id } })).toMatchObject({
      status: 'SCHEDULED',
    });
  });
});
