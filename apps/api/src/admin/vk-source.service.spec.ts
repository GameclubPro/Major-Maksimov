import { VkParsingOwnerProfile } from '../prisma/prisma-client';
import { VkSourceService } from './vk-source.service';

describe('VkSourceService source identity', () => {
  function fixture() {
    const service = new VkSourceService(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      { get: () => undefined } as never,
      {} as never,
    );
    return service as unknown as {
      normalizeSourceInput: (input: string) => { domain: string; url: string };
      resolveSourceInfo: (
        input: { domain: string; url: string },
        wall: unknown,
      ) => { wallOwnerId: number; title: string };
    };
  }

  it('does not connect a group mentioned on a personal wall', () => {
    const service = fixture();
    const input = service.normalizeSourceInput('https://vk.ru/person');
    expect(() =>
      service.resolveSourceInfo(input, {
        items: [{ owner_id: 123, id: 1 }],
        groups: [{ id: 999, name: 'Unrelated' }],
      }),
    ).toThrow('личную страницу');
  });

  it('does not use the only extended group unless it matches an empty source wall', () => {
    const service = fixture();
    expect(() =>
      service.resolveSourceInfo(service.normalizeSourceInput('public123'), {
        items: [],
        groups: [{ id: 999, name: 'Unrelated' }],
      }),
    ).toThrow('не найдено');
  });

  it.each(['club123', 'public123', 'event123', 'community'])(
    'resolves an exact empty-wall group for %s',
    (domain) => {
      const service = fixture();
      expect(
        service.resolveSourceInfo(service.normalizeSourceInput(domain), {
          items: [],
          groups: [{ id: 123, name: 'Community', screen_name: 'community' }],
        }),
      ).toMatchObject({ wallOwnerId: -123, title: 'Community' });
    },
  );

  it.each([
    'https://user:password@vk.ru/club123',
    'https://vk.ru:8443/club123',
    'https://vk.ru.evil.test/club123',
  ])('rejects an ambiguous source URL: %s', (url) => {
    expect(() => fixture().normalizeSourceInput(url)).toThrow();
  });

  it('trusts the post wall owner, not the first referenced group', () => {
    const service = fixture();
    expect(
      service.resolveSourceInfo(service.normalizeSourceInput('community'), {
        items: [{ owner_id: -123, id: 1 }],
        groups: [
          { id: 999, name: 'Unrelated' },
          { id: 123, name: 'Correct' },
        ],
      }),
    ).toMatchObject({ wallOwnerId: -123, title: 'Correct' });
  });
});

type CleanupQuery = {
  where: Record<string, unknown> & { OR?: Array<Record<string, unknown>> };
  data: Record<string, unknown>;
};

describe('VkSourceService autopublish cleanup', () => {
  function createSource(overrides: Record<string, unknown> = {}) {
    return {
      id: 'source-1',
      chatId: 'channel-1',
      ownerProfile: VkParsingOwnerProfile.PUBLISHER,
      ownerBotId: 'publisher-bot',
      status: 'ACTIVE',
      importEnabled: true,
      autoPublishEnabled: true,
      autoPublishEnabledAt: new Date('2026-09-04T09:00:00.000Z'),
      autoPublishPausedAt: null,
      autoPublishPausedReason: null,
      publishIntervalMinutes: 30,
      dailyLimit: 12,
      minPublishIntervalMinutes: 15,
      publishMode: 'QUEUE',
      priority: 'NORMAL',
      quietHoursStart: null,
      quietHoursEnd: null,
      ...overrides,
    };
  }

  function createFixture() {
    const source = createSource();
    const prisma = {
      $queryRaw: jest.fn().mockResolvedValue([{ id: 'channel-1' }]),
      $transaction: jest.fn(),
      vkParsingSource: {
        count: jest.fn().mockResolvedValue(0),
        findFirst: jest.fn().mockResolvedValue(source),
        findMany: jest.fn().mockResolvedValue([]),
        update: jest.fn().mockResolvedValue(source),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      vkParsingSettings: {
        findUnique: jest.fn().mockResolvedValue(null),
        upsert: jest.fn().mockResolvedValue({}),
      },
      vkParsingPost: {
        count: jest.fn().mockResolvedValue(0),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      auditLog: {
        create: jest.fn().mockResolvedValue({ id: 'audit-1' }),
      },
      chat: { findUnique: jest.fn().mockResolvedValue({ entityType: 'CHANNEL' }) },
      vkBotReview: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
    };
    prisma.$transaction.mockImplementation(async (operation: (tx: typeof prisma) => unknown) =>
      operation(prisma),
    );
    const feedService = {
      buildFeed: jest.fn().mockResolvedValue({}),
    };
    const syncQueue = {
      add: jest.fn().mockResolvedValue(undefined),
      getJob: jest.fn().mockResolvedValue(null),
    };
    const configService = {
      get: jest.fn().mockReturnValue(undefined),
    };
    const ownership = {
      getPublisherScope: jest.fn().mockReturnValue({
        ownerProfile: VkParsingOwnerProfile.PUBLISHER,
        ownerBotId: 'publisher-bot',
      }),
    };
    const service = new VkSourceService(
      prisma as never,
      feedService as never,
      {} as never,
      syncQueue as never,
      configService as never,
      ownership as never,
    );

    return { prisma, service };
  }

  function expectCleanupQuery(query: CleanupQuery | undefined, sourceIds: string[]): void {
    expect(query).toBeDefined();
    expect(query?.where).toEqual(
      expect.objectContaining({
        chatId: 'channel-1',
        ownerProfile: VkParsingOwnerProfile.PUBLISHER,
        ownerBotId: 'publisher-bot',
        sourceId: { in: sourceIds },
        status: { in: ['NEW', 'FAILED'] },
        publishLockedAt: null,
        publishAttemptCount: 0,
      }),
    );
    expect(query?.where).not.toHaveProperty('publishReason');
    expect(query?.where.OR).toEqual([
      {
        publishReason: 'autopublish',
        OR: [
          { publishQueuedAt: { not: null } },
          { publishIdempotencyKey: { not: null } },
          { publishScheduledAt: { not: null } },
        ],
      },
      {
        publishScheduleFingerprint: { not: null },
        publishQueuedAt: null,
        publishLockedAt: null,
        publishIdempotencyKey: null,
        publishReason: null,
        publishScheduledAt: null,
        publishCancelledAt: null,
        publishCancelledByUserId: null,
        publishActorUserId: null,
        dispatchBlockerCode: null,
        dispatchBlockedAt: null,
      },
    ]);
    expect(query?.data).toEqual({
      publishQueuedAt: null,
      publishLockedAt: null,
      publishIdempotencyKey: null,
      publishReason: null,
      publishScheduledAt: null,
      publishScheduleFingerprint: null,
    });
  }

  it.each([
    ['disabled Auto', { autoPublishEnabled: false }],
    ['paused imports', { importEnabled: false }],
    ['review mode', { publishMode: 'REVIEW' }],
  ])('clears queued Auto work and unqueued pending markers for %s', async (_label, patch) => {
    const { prisma, service } = createFixture();

    await service.updateSource('channel-1', 'source-1', { userId: 'admin-1' }, patch);

    expectCleanupQuery(prisma.vkParsingPost.updateMany.mock.calls[0]?.[0], ['source-1']);
  });

  it('does not change the protected minimum when changing the publication interval', async () => {
    const { prisma, service } = createFixture();
    prisma.vkParsingSource.findFirst.mockResolvedValue(
      createSource({
        autoPublishEnabled: true,
        autoPublishPausedAt: null,
        minPublishIntervalMinutes: 30,
      }),
    );
    await service.updateSource(
      'channel-1',
      'source-1',
      { userId: 'admin-1' },
      {
        publishIntervalMinutes: 20,
        ifAutomatic: true,
      },
    );
    const data = prisma.vkParsingSource.update.mock.calls[0]?.[0].data;
    expect(data?.publishIntervalMinutes).toBe(20);
    expect(data).not.toHaveProperty('minPublishIntervalMinutes');
    expect(data).not.toHaveProperty('ifAutomatic');
  });

  it.each([
    { autoPublishEnabled: false },
    { autoPublishPausedAt: new Date(), autoPublishPausedReason: 'circuit_breaker' },
    { importEnabled: false },
    { publishMode: 'REVIEW' },
  ])('rejects stale bulk scope before modifying a group (%j)', async (change) => {
    const { prisma, service } = createFixture();
    prisma.vkParsingSource.findFirst.mockResolvedValue(
      createSource({
        autoPublishEnabled: true,
        autoPublishPausedAt: null,
        ...change,
      }),
    );
    await expect(
      service.updateSource(
        'channel-1',
        'source-1',
        { userId: 'admin-1' },
        {
          dailyLimit: 4,
          ifAutomatic: true,
        },
      ),
    ).rejects.toThrow('Группа больше не публикует автоматически.');
    expect(prisma.vkParsingSource.update).not.toHaveBeenCalled();
  });

  it('requires an explicit recipient before entering bot review', async () => {
    const { prisma, service } = createFixture();
    await expect(
      service.updateSource(
        'channel-1',
        'source-1',
        { userId: '17' },
        { publishMode: 'BOT_REVIEW' },
      ),
    ).rejects.toThrow('подключите личку');
    expect(prisma.vkParsingSource.update).not.toHaveBeenCalled();
  });

  it('starts a fresh auto baseline when leaving legacy review with its old auto flag still true', async () => {
    const { prisma, service } = createFixture();
    const oldBaseline = new Date('2020-01-01T00:00:00Z');
    prisma.vkParsingSource.findFirst.mockResolvedValue(
      createSource({
        publishMode: 'REVIEW',
        autoPublishEnabled: true,
        autoPublishEnabledAt: oldBaseline,
        autoPublishPausedAt: oldBaseline,
        autoPublishPausedReason: 'manual',
      }),
    );
    await service.updateSource('channel-1', 'source-1', { userId: '17' }, { publishMode: 'QUEUE' });
    const patch = prisma.vkParsingSource.update.mock.calls[0]?.[0]?.data;
    expect(patch.autoPublishEnabledAt).toBeInstanceOf(Date);
    expect(patch.autoPublishEnabledAt.getTime()).toBeGreaterThan(oldBaseline.getTime());
    expect(patch.autoPublishPausedAt).toBeNull();
  });

  it('does not preserve a legacy review baseline when applying an automatic preset', async () => {
    const { prisma, service } = createFixture();
    await service.applyBulkPreset(
      'channel-1',
      { userId: '17' },
      { sourceIds: ['source-1'], preset: 'SLOW' },
    );
    expect(prisma.vkParsingSource.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ publishMode: 'REVIEW', autoPublishEnabled: true }),
        data: expect.objectContaining({
          autoPublishEnabledAt: expect.any(Date),
          autoPublishPausedAt: null,
        }),
      }),
    );
    expect(prisma.vkParsingSource.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          autoPublishEnabled: true,
          publishMode: { notIn: ['REVIEW', 'BOT_REVIEW'] },
        }),
      }),
    );
  });

  it('enters bot review with a new baseline and clears unattempted publication intents', async () => {
    const { prisma, service } = createFixture();
    prisma.vkParsingSettings.findUnique.mockResolvedValue({
      botReviewRecipientUserId: '17',
    } as never);
    await service.updateSource(
      'channel-1',
      'source-1',
      { userId: '17' },
      { publishMode: 'BOT_REVIEW' },
    );
    expect(prisma.vkParsingSource.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          publishMode: 'BOT_REVIEW',
          autoPublishEnabled: false,
          botReviewEnabledAt: expect.any(Date),
        }),
      }),
    );
    expect(prisma.vkParsingPost.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ publishAttemptCount: 0, publishLockedAt: null }),
        data: expect.objectContaining({ publishIdempotencyKey: null }),
      }),
    );
  });

  it('refuses a mode switch while publication dispatch is in flight', async () => {
    const { prisma, service } = createFixture();
    prisma.vkParsingSettings.findUnique.mockResolvedValue({
      botReviewRecipientUserId: '17',
    } as never);
    prisma.vkParsingPost.count.mockResolvedValue(1);
    await expect(
      service.updateSource(
        'channel-1',
        'source-1',
        { userId: '17' },
        { publishMode: 'BOT_REVIEW' },
      ),
    ).rejects.toThrow('Дождитесь');
    expect(prisma.vkParsingSource.update).not.toHaveBeenCalled();
  });

  it('clears queued Auto work and pending markers for a deduplicated REVIEW preset', async () => {
    const { prisma, service } = createFixture();

    await service.applyBulkPreset(
      'channel-1',
      { userId: 'admin-1' },
      {
        sourceIds: ['source-1', 'source-1', 'source-2'],
        preset: 'REVIEW',
      },
    );

    expectCleanupQuery(prisma.vkParsingPost.updateMany.mock.calls[0]?.[0], [
      'source-1',
      'source-2',
    ]);
  });

  it.each(['NEWS', 'SLOW', 'CLEAN'] as const)(
    'does not clear pending markers for the %s preset',
    async (preset) => {
      const { prisma, service } = createFixture();

      await service.applyBulkPreset(
        'channel-1',
        { userId: 'admin-1' },
        {
          sourceIds: ['source-1'],
          preset,
        },
      );

      expect(prisma.vkParsingPost.updateMany).not.toHaveBeenCalled();
    },
  );

  it('clears queued Auto work and unqueued pending markers when a source is removed', async () => {
    const { prisma, service } = createFixture();

    await service.removeSource('channel-1', 'source-1');

    expectCleanupQuery(prisma.vkParsingPost.updateMany.mock.calls[0]?.[0], ['source-1']);
  });

  it('commits CLEAN filters before enabling sources without changing the global Auto switch', async () => {
    const { prisma, service } = createFixture();
    await service.applyBulkPreset(
      'channel-1',
      { userId: 'admin-1' },
      {
        sourceIds: ['source-1'],
        preset: 'CLEAN',
      },
    );
    expect(prisma.vkParsingSettings.upsert).toHaveBeenCalledWith({
      where: {
        chatId_ownerProfile_ownerBotId: {
          chatId: 'channel-1',
          ownerProfile: 'PUBLISHER',
          ownerBotId: 'publisher-bot',
        },
      },
      create: {
        chatId: 'channel-1',
        ownerProfile: 'PUBLISHER',
        ownerBotId: 'publisher-bot',
        stripLinksEnabled: true,
        skipAdsEnabled: true,
      },
      update: { stripLinksEnabled: true, skipAdsEnabled: true },
    });
    expect(prisma.vkParsingSettings.upsert.mock.invocationCallOrder[0]).toBeLessThan(
      prisma.vkParsingSource.updateMany.mock.invocationCallOrder[0]!,
    );
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });

  it('does not activate CLEAN sources when persisting its safety filters fails', async () => {
    const { prisma, service } = createFixture();
    prisma.vkParsingSettings.upsert.mockRejectedValue(new Error('settings unavailable'));
    await expect(
      service.applyBulkPreset(
        'channel-1',
        { userId: 'admin-1' },
        {
          sourceIds: ['source-1'],
          preset: 'CLEAN',
        },
      ),
    ).rejects.toThrow('settings unavailable');
    expect(prisma.vkParsingSource.updateMany).not.toHaveBeenCalled();
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  it('rejects enabling a source whose quiet window covers the global work window', async () => {
    const { prisma, service } = createFixture();
    prisma.vkParsingSource.findFirst.mockResolvedValue(
      createSource({
        autoPublishEnabled: false,
        autoPublishEnabledAt: null,
        autoPublishPausedAt: new Date('2026-09-04T08:00:00.000Z'),
        autoPublishPausedReason: 'manual',
        quietHoursStart: '09:00',
        quietHoursEnd: '18:00',
      }),
    );
    prisma.vkParsingSettings.findUnique.mockResolvedValue({
      autoPublishEnabled: true,
      schedulerTimezone: 'UTC',
      workHoursStart: '09:00',
      workHoursEnd: '18:00',
      quietHoursStart: null,
      quietHoursEnd: null,
    });

    await expect(
      service.updateSource(
        'channel-1',
        'source-1',
        { userId: 'admin-1' },
        {
          autoPublishEnabled: true,
        },
      ),
    ).rejects.toThrow('Рабочее время полностью перекрыто паузами публикации.');

    expect(prisma.vkParsingSource.update).not.toHaveBeenCalled();
  });

  it('rejects an Auto preset that would activate a source without a valid slot', async () => {
    const { prisma, service } = createFixture();
    prisma.vkParsingSource.findMany.mockResolvedValue([
      createSource({ quietHoursStart: '09:00', quietHoursEnd: '18:00' }),
    ]);
    prisma.vkParsingSettings.findUnique.mockResolvedValue({
      autoPublishEnabled: true,
      schedulerTimezone: 'UTC',
      workHoursStart: '09:00',
      workHoursEnd: '18:00',
      quietHoursStart: null,
      quietHoursEnd: null,
    });

    await expect(
      service.applyBulkPreset(
        'channel-1',
        { userId: 'admin-1' },
        { sourceIds: ['source-1'], preset: 'NEWS' },
      ),
    ).rejects.toThrow('Рабочее время полностью перекрыто паузами публикации.');

    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });
});
