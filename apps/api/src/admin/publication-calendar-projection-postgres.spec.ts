import { createHash, randomUUID } from 'node:crypto';
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
  const slotsFor = (publicationId: string) =>
    db.publicationOccurrence.findMany({
      where: { publicationId },
      orderBy: { scheduledAt: 'asc' },
    });
  const readSeries = (id: string) =>
    db.publication.findUniqueOrThrow({
      where: { id },
      include: {
        canonicalContentRevision: { include: { assets: { orderBy: { position: 'asc' } } } },
        targets: { orderBy: { position: 'asc' } },
        schedule: true,
      },
    });
  const publicationCount = () => db.publication.count({ where: { actorUserId: user.userId } });
  const refreshSeries = () =>
    (
      service as unknown as { materializeRecurringSchedules(limit: number): Promise<void> }
    ).materializeRecurringSchedules(10);
  const finishSeries = (publicationId: string) =>
    (
      service as unknown as { rollupPublicationLifecycle(id: string): Promise<void> }
    ).rollupPublicationLifecycle(publicationId);

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
    await db.publicationAsset.deleteMany({ where: { actorUserId: user.userId } });
  });
  afterAll(async () => {
    if (!db) return;
    await db.chat.deleteMany({ where: { id: { in: [firstChat, secondChat] } } });
    await db.$disconnect();
  });

  it('previews a distant, sparse count-limited schedule using its local anchor across DST', async () => {
    jest.setSystemTime(new Date('2027-03-19T09:00:00Z'));
    const schedule = {
      ...recurrence,
      timezone: 'Europe/Berlin',
      startsAt: '2027-03-28T00:00:00.000Z',
      frequency: 'weekly',
      interval: 2,
      weekdays: [7],
      times: ['02:30'],
      maxOccurrences: 3,
    };
    await expect(service.previewSchedule(user, { schedule }, profile)).resolves.toEqual({
      state: 'finite',
      timezone: 'Europe/Berlin',
      firstOccurrenceAt: '2027-04-11T00:30:00.000Z',
      lastOccurrenceAt: '2027-05-09T00:30:00.000Z',
    });
    expect(await publicationCount()).toBe(0);
    expect(await db.publicationOccurrence.count()).toBe(0);
  });

  it('previews the exact last reachable slot before a saved date limit', async () => {
    const series = await create({
      ...recurrence,
      interval: 2,
      times: ['10:00', '18:00'],
      endsAt: '2026-11-24T12:00:00.000Z',
    });
    const before = await readSeries(series.id);
    const slots = await slotsFor(series.id);
    await expect(
      service.previewSchedule(
        user,
        { editing: { publicationId: series.id, expectedRevision: 1 } },
        profile,
      ),
    ).resolves.toEqual({
      state: 'finite',
      timezone: 'UTC',
      firstOccurrenceAt: '2026-11-20T10:00:00.000Z',
      lastOccurrenceAt: '2026-11-24T10:00:00.000Z',
    });
    expect(await readSeries(series.id)).toEqual(before);
    expect(await slotsFor(series.id)).toEqual(slots);
  });

  it('previews content and audience edits without restoring a skipped slot or extending a count limit', async () => {
    const series = await create({ ...recurrence, maxOccurrences: 5 });
    const [sentFirst, sentSecond, skipped] = await slotsFor(series.id);
    await db.publicationOccurrence.updateMany({
      where: { id: { in: [sentFirst.id, sentSecond.id] } },
      data: { status: 'SENT' },
    });
    await service.skipOccurrence(
      series.id,
      skipped.id,
      user,
      { expectedRevision: 1, requestId: randomUUID() },
      profile,
    );
    jest.setSystemTime(new Date('2026-11-21T12:00:00Z'));
    const editing = { publicationId: series.id, expectedRevision: 2 };
    const before = await readSeries(series.id);
    const originalSlots = await slotsFor(series.id);

    const preserved = await service.previewSchedule(user, { editing }, profile);
    const rebooked = await service.previewSchedule(
      user,
      { editing, audience: withAudience(secondChat) },
      profile,
    );
    const expected = {
      state: 'finite',
      timezone: 'UTC',
      firstOccurrenceAt: '2026-11-23T10:00:00.000Z',
      lastOccurrenceAt: '2026-11-24T10:00:00.000Z',
    };
    expect(preserved).toEqual(expected);
    expect(rebooked).toEqual(expected);
    expect(await readSeries(series.id)).toEqual(before);
    expect(await slotsFor(series.id)).toEqual(originalSlots);

    await service.update(
      series.id,
      user,
      { expectedRevision: 2, requestId: randomUUID(), audience: withAudience(secondChat) },
      profile,
    );
    expect(
      (await slotsFor(series.id))
        .filter((slot) => slot.scheduleRevision === 2 && slot.status === 'SCHEDULED')
        .map((slot) => slot.scheduledAt.toISOString()),
    ).toEqual([expected.firstOccurrenceAt, expected.lastOccurrenceAt]);
  });

  it('requires the current revision and full Publisher access before previewing a saved series', async () => {
    const series = await create({ ...recurrence, maxOccurrences: 3 });
    await service.update(
      series.id,
      user,
      {
        expectedRevision: 1,
        requestId: randomUUID(),
        audience: withAudience(firstChat, secondChat),
      },
      profile,
    );

    const request = { editing: { publicationId: series.id, expectedRevision: 2 } };
    await expect(
      service.previewSchedule(
        user,
        { editing: { ...request.editing, expectedRevision: 1 } },
        profile,
      ),
    ).rejects.toMatchObject({
      status: 409,
      response: { code: 'PUBLICATION_REVISION_CONFLICT' },
    });

    try {
      await db.managedEntityAccessEdge.updateMany({
        where: { chatId: secondChat, userId: user.userId, botId },
        data: { state: 'USER_DENIED' },
      });
      await expect(service.previewSchedule(user, request, profile)).rejects.toMatchObject({
        status: 404,
      });
      await expect(
        service.previewSchedule(user, { ...request, audience: withAudience(firstChat) }, profile),
      ).rejects.toMatchObject({ status: 404 });
    } finally {
      await db.managedEntityAccessEdge.updateMany({
        where: { chatId: secondChat, userId: user.userId, botId },
        data: { state: 'GRANTED' },
      });
    }
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
    const unrelated = await create(once(first.scheduledAt.toISOString()), secondChat);
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
    expect(
      await db.publicationOccurrence.findFirst({ where: { publicationId: unrelated.id } }),
    ).toMatchObject({ status: 'SCHEDULED', scheduledAt: first.scheduledAt });
  });

  it('moves one occurrence to a separate post and replays without copying it again', async () => {
    const series = await create({ ...recurrence, maxOccurrences: 3 });
    const saved = await readSeries(series.id);
    const assets = [];
    for (const [index, mimeType] of ['image/png', 'video/mp4'].entries()) {
      const bytes = Buffer.from([index]);
      const asset = await db.publicationAsset.create({
        data: {
          actorUserId: user.userId,
          sha256: createHash('sha256').update(bytes).digest('hex'),
          mimeType,
          fileName: `attachment-${index}`,
          sizeBytes: 1,
          bytes,
        },
      });
      assets.push({ assetId: asset.id, position: index });
    }
    await db.publicationContentAsset.createMany({
      data: assets.map((asset) => ({
        ...asset,
        contentRevisionId: saved.canonicalContentRevisionId!,
      })),
    });
    const original = await readSeries(series.id);
    const originalSlots = await slotsFor(series.id);
    const [first, moved, last] = originalSlots;
    const at = '2026-11-21T16:00:00.000Z';
    const request = { expectedRevision: 1, requestId: randomUUID(), scope: 'occurrence', at };
    const result = await service.rescheduleOccurrence(series.id, moved.id, user, request, profile);
    expect(result.source.id).toBe(series.id);
    expect(result.publication.id).not.toBe(series.id);

    const [updated, replacement, oldSlots, newSlots] = await Promise.all([
      readSeries(series.id),
      readSeries(result.publication.id),
      slotsFor(series.id),
      slotsFor(result.publication.id),
    ]);
    expect(updated.version).toBe(original.version + 1);
    expect(updated.schedule).toEqual(original.schedule);
    expect(oldSlots).toEqual([
      first,
      expect.objectContaining({
        id: moved.id,
        status: 'CANCELED',
        scheduledAt: moved.scheduledAt,
        contentRevisionId: moved.contentRevisionId,
      }),
      last,
    ]);
    expect(replacement).toMatchObject({
      actorUserId: original.actorUserId,
      requiredBotId: original.requiredBotId,
      dispatchProfile: original.dispatchProfile,
      audienceSelection: original.audienceSelection,
      audienceMode: original.audienceMode,
      schedule: { mode: 'ONCE', timezone: 'UTC' },
      targets: [{ targetChatId: firstChat, entityType: 'CHAT', position: 0 }],
    });
    expect(replacement.canonicalContentRevision).toMatchObject({
      publicationId: replacement.id,
      text: original.canonicalContentRevision?.text,
      textFormat: original.canonicalContentRevision?.textFormat,
      buttons: original.canonicalContentRevision?.buttons,
      postPublish: original.canonicalContentRevision?.postPublish,
    });
    expect(replacement.canonicalContentRevision?.assets).toEqual(
      assets.map((asset) => ({
        ...asset,
        contentRevisionId: replacement.canonicalContentRevisionId,
      })),
    );
    expect(replacement.canonicalContentRevisionId).not.toBe(original.canonicalContentRevisionId);
    expect(newSlots).toEqual([
      expect.objectContaining({
        status: 'SCHEDULED',
        scheduledAt: new Date(at),
        contentRevisionId: replacement.canonicalContentRevisionId,
      }),
    ]);

    await expect(
      service.rescheduleOccurrence(series.id, moved.id, user, request, profile),
    ).resolves.toMatchObject({
      source: { id: series.id },
      publication: { id: replacement.id },
    });
    expect(await publicationCount()).toBe(2);
    expect((await readSeries(series.id)).version).toBe(updated.version);
    expect(await slotsFor(series.id)).toEqual(oldSlots);
    expect(await slotsFor(replacement.id)).toEqual(newSlots);
  });

  it('commits at most one of two concurrent moves of the same occurrence', async () => {
    const series = await create({ ...recurrence, maxOccurrences: 3 });
    const [first, moved, last] = await slotsFor(series.id);
    const requests = ['2026-11-21T16:00:00.000Z', '2026-11-21T17:00:00.000Z'].map((at) => ({
      expectedRevision: 1,
      requestId: randomUUID(),
      scope: 'occurrence',
      at,
    }));

    // Both requests finish the pre-transaction checks before either can write.
    const originalReadiness = routing.assertTargetsReady;
    let checked = 0;
    let release!: () => void;
    const bothChecked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const barrier = jest
      .spyOn(routing, 'assertTargetsReady')
      .mockImplementation(async (targets) => {
        if (++checked === requests.length) release();
        await bothChecked;
        return originalReadiness(targets);
      });
    try {
      const results = await Promise.allSettled(
        requests.map((request) =>
          service.rescheduleOccurrence(series.id, moved.id, user, request, profile),
        ),
      );
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      const winnerIndex = results.findIndex((result) => result.status === 'fulfilled');
      const winner = results[winnerIndex];
      const loser = results[1 - winnerIndex];
      if (winner.status !== 'fulfilled') throw new Error('Expected one committed move');
      expect(loser).toMatchObject({
        status: 'rejected',
        reason: { status: 409, response: { code: 'PUBLICATION_REVISION_CONFLICT' } },
      });
      expect(await publicationCount()).toBe(2);
      expect((await readSeries(series.id)).version).toBe(2);
      expect(await slotsFor(series.id)).toEqual([
        first,
        expect.objectContaining({ id: moved.id, status: 'CANCELED' }),
        last,
      ]);
      expect(await slotsFor(winner.value.publication.id)).toEqual([
        expect.objectContaining({
          status: 'SCHEDULED',
          scheduledAt: new Date(requests[winnerIndex].at),
        }),
      ]);
      expect(
        await db.publicationMutationRecord.findMany({
          where: {
            actorUserId: user.userId,
            requestId: { in: requests.map(({ requestId }) => requestId) },
          },
          select: { requestId: true, publicationId: true },
        }),
      ).toEqual([
        {
          requestId: requests[winnerIndex].requestId,
          publicationId: winner.value.publication.id,
        },
      ]);
    } finally {
      release();
      barrier.mockRestore();
    }
  });

  it('rolls back a move when another publication already has that recipient and instant', async () => {
    const at = '2026-11-21T16:00:00.000Z';
    const series = await create({ ...recurrence, maxOccurrences: 3 });
    const booking = await create(once(at));
    const original = await readSeries(series.id);
    const originalSlots = await slotsFor(series.id);
    const bookedSlots = await slotsFor(booking.id);
    const request = { expectedRevision: 1, requestId: randomUUID(), scope: 'occurrence', at };
    await expect(
      service.rescheduleOccurrence(series.id, originalSlots[1].id, user, request, profile),
    ).rejects.toMatchObject({
      status: 409,
      response: {
        code: 'PUBLICATION_SCHEDULE_CONFLICT',
        conflicts: [{ chatId: firstChat, scheduledAt: at }],
      },
    });
    expect(await publicationCount()).toBe(2);
    expect(await readSeries(series.id)).toEqual(original);
    expect(await slotsFor(series.id)).toEqual(originalSlots);
    expect(await slotsFor(booking.id)).toEqual(bookedSlots);
    expect(
      await db.publicationMutationRecord.count({
        where: { actorUserId: user.userId, requestId: request.requestId },
      }),
    ).toBe(0);
  });

  it('rejects a stale revision and refuses a move after an execution envelope has been created', async () => {
    const series = await create({ ...recurrence, maxOccurrences: 3 });
    const original = await readSeries(series.id);
    const [, slot] = await slotsFor(series.id);
    const request = {
      expectedRevision: original.version + 1,
      requestId: randomUUID(),
      scope: 'occurrence',
      at: '2026-11-21T16:00:00.000Z',
    };
    await expect(
      service.rescheduleOccurrence(series.id, slot.id, user, request, profile),
    ).rejects.toMatchObject({ response: { code: 'PUBLICATION_REVISION_CONFLICT' } });

    const execution = await db.managedBroadcast.create({
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
      service.rescheduleOccurrence(
        series.id,
        slot.id,
        user,
        {
          ...request,
          expectedRevision: original.version,
          requestId: randomUUID(),
        },
        profile,
      ),
    ).rejects.toMatchObject({ response: { code: 'PUBLICATION_CONFLICT_REQUIRES_MANUAL_REVIEW' } });
    expect(await publicationCount()).toBe(1);
    expect(await readSeries(series.id)).toEqual(original);
    expect(await db.publicationOccurrence.findUnique({ where: { id: slot.id } })).toEqual(slot);
    expect(await db.managedBroadcast.findUnique({ where: { id: execution.id } })).toEqual(
      execution,
    );
  });

  it('moves this and later slots to a finite continuation while keeping the accepted prefix', async () => {
    const series = await create({ ...recurrence, maxOccurrences: 5 });
    const original = await readSeries(series.id);
    const [first, , split] = await slotsFor(series.id);
    await db.publicationOccurrence.update({ where: { id: first.id }, data: { status: 'SENT' } });
    const oldSlots = await slotsFor(series.id);
    const request = {
      expectedRevision: original.version,
      requestId: randomUUID(),
      scope: 'following',
      schedule: {
        ...recurrence,
        startsAt: split.scheduledAt.toISOString(),
        times: ['14:00'],
        maxOccurrences: 5,
      },
    };
    const moved = await service.rescheduleOccurrence(series.id, split.id, user, request, profile);
    const kept = await readSeries(series.id);
    const continuation = await readSeries(moved.publication.id);
    const oldRows = await slotsFor(series.id);
    const newRows = await slotsFor(continuation.id);
    expect(moved.source.id).toBe(series.id);
    expect(kept.version).toBe(original.version + 1);
    expect(kept.schedule).toMatchObject({
      mode: 'RECURRENCE',
      rule: { endsAt: '2026-11-22T09:59:59.999Z' },
    });
    expect(oldRows.slice(0, 2)).toEqual(oldSlots.slice(0, 2));
    expect(oldRows.slice(2)).toEqual(
      oldSlots.slice(2).map((slot) =>
        expect.objectContaining({
          id: slot.id,
          status: 'CANCELED',
          scheduledAt: slot.scheduledAt,
        }),
      ),
    );
    expect(continuation.schedule).toMatchObject({
      mode: 'RECURRENCE',
      rule: { maxOccurrences: 3 },
    });
    expect(
      newRows.map(({ scheduledAt, status }) => ({ at: scheduledAt.toISOString(), status })),
    ).toEqual([
      { at: '2026-11-22T14:00:00.000Z', status: 'SCHEDULED' },
      { at: '2026-11-23T14:00:00.000Z', status: 'SCHEDULED' },
      { at: '2026-11-24T14:00:00.000Z', status: 'SCHEDULED' },
    ]);
    // Subsequent scheduler runs may advance the horizon without adding either side's old suffix.
    jest.setSystemTime(new Date('2026-11-25T09:00:00.000Z'));
    await refreshSeries();
    expect(await slotsFor(series.id)).toHaveLength(5);
    expect(await slotsFor(continuation.id)).toHaveLength(3);
  });

  it('completes a previously saved finite recurrence after the only occurrence is skipped', async () => {
    const series = await create({ ...recurrence, maxOccurrences: 1 });
    const skipped = await db.publicationOccurrence.findFirstOrThrow({
      where: { publicationId: series.id },
    });
    // A retained rule may predate the explicit late-delivery policy.
    await db.publicationSchedule.update({
      where: { publicationId: series.id },
      data: { rule: { ...recurrence, maxOccurrences: 1 } },
    });
    await service.skipOccurrence(
      series.id,
      skipped.id,
      user,
      {
        requestId: randomUUID(),
        expectedRevision: 1,
      },
      profile,
    );
    jest.setSystemTime(new Date(skipped.scheduledAt.getTime() + 60_000));
    await finishSeries(series.id);
    await refreshSeries();
    await finishSeries(series.id);
    expect(
      await db.publicationSchedule.findUnique({ where: { publicationId: series.id } }),
    ).toMatchObject({ status: 'COMPLETED', nextMaterializeAt: null });
    expect(await db.publicationOccurrence.count({ where: { publicationId: series.id } })).toBe(1);
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
