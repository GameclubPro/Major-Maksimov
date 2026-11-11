import {
  ChatBotMembershipStatus,
  ChatEntityType,
  GiveawayEligibilityState,
  ManagedEntityAccessState,
  ManagedGiveawayStatus,
  ManagedGiveawayWinnerNotificationStatus,
  ManagedGiveawayWinnerStatus,
  type Prisma,
} from '../prisma/prisma-client';
import { MAX_API_SOURCE_TAGS } from '../max/max-client.service';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import {
  ManagedGiveawayMembershipLookupUnavailableError,
  ManagedGiveawayService,
} from './managed-giveaway.service';
import {
  buildManagedGiveawayDuePageQuery,
  type ManagedGiveawayDueRow,
} from './managed-giveaway-due-selection';

function createConfigMock(options: { token?: string; previousToken?: string } = {}) {
  return {
    get: jest.fn((key: string) => {
      if (key === 'APP_BASE_URL') {
        return 'https://major-maksimov.ru';
      }
      if (key === 'MAX_BOT_CONTACT_ID') {
        return 'maxim-bot';
      }
      if (key === 'MAX_BOT_ID') {
        return 'maxim-bot';
      }
      if (key === 'MAX_BOT_TOKEN_PREVIOUS') {
        return options.previousToken;
      }
      return undefined;
    }),
    getOrThrow: jest.fn((key: string) => {
      if (key === 'MAX_BOT_TOKEN') {
        return options.token ?? 'test-token';
      }
      throw new Error(`Missing config key ${key}`);
    }),
  };
}

function createPrismaMock() {
  const prisma = {
    managedGiveaway: {
      create: jest.fn(),
      findFirst: jest.fn(),
      findMany: jest.fn(),
      findUnique: jest.fn(),
      findUniqueOrThrow: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      delete: jest.fn(),
    },
    managedGiveawayEntry: {
      upsert: jest.fn(),
      update: jest.fn(),
    },
    managedGiveawayWinner: {
      findMany: jest.fn().mockResolvedValue([]),
      update: jest.fn(),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      deleteMany: jest.fn(),
      create: jest.fn(),
      createMany: jest.fn(),
    },
    managedGiveawayWinnerNotification: {
      create: jest.fn(),
      createMany: jest.fn(),
      findMany: jest.fn().mockResolvedValue([]),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    chat: {
      upsert: jest.fn().mockResolvedValue(undefined),
      findUnique: jest.fn().mockResolvedValue({ title: 'Основной канал' }),
    },
    managedEntityAccessEdge: {
      findMany: jest.fn().mockResolvedValue([]),
    },
    chatBotMembership: {
      findMany: jest.fn().mockResolvedValue([]),
    },
    auditLog: {
      create: jest.fn().mockResolvedValue(undefined),
    },
    $transaction: jest.fn(),
    $queryRaw: jest.fn() as jest.MockedFunction<Prisma.TransactionClient['$queryRaw']>,
  };
  prisma.$transaction.mockImplementation(async (callback) => callback(prisma));
  prisma.$queryRaw.mockResolvedValue([]);
  return prisma;
}

function createDueGiveawayRow(
  overrides: Pick<ManagedGiveawayDueRow, 'id'> & Partial<Omit<ManagedGiveawayDueRow, 'id'>>,
): ManagedGiveawayDueRow {
  return {
    sourceChatId: `source-${overrides.id}`,
    lockedAt: null,
    dueAt: new Date('2026-03-20T12:00:00.000Z'),
    ...overrides,
  };
}

type ManagedGiveawayRunnerMethods = {
  processDueManagedGiveaway: ManagedGiveawayService['processDueManagedGiveaway'];
  getManagedGiveawayRunnerDeferRemainingMs: ManagedGiveawayService['getManagedGiveawayRunnerDeferRemainingMs'];
};

function getDuePageQueries(prisma: ReturnType<typeof createPrismaMock>): Prisma.Sql[] {
  return prisma.$queryRaw.mock.calls.map(([query]) => query as Prisma.Sql);
}

function createMaxApiError(status: number, message: string, code?: string): Error {
  return Object.assign(new Error(message), {
    response: {
      status,
      data: {
        ...(code ? { code } : {}),
        message,
      },
    },
  });
}

function createMaxEditRejectedError(): Error {
  return Object.assign(new Error('Error on message edit'), {
    response: {
      status: 200,
      data: {
        success: false,
        message: 'Error on message edit',
      },
    },
  });
}

function createMaxClientMock() {
  return {
    hasChatMember: jest.fn(),
    getChatTitle: jest.fn(),
    getChatSnapshot: jest.fn(),
    getExactMessagePresence: jest.fn().mockResolvedValue('present'),
    resolveMessageLink: jest.fn(),
    uploadImage: jest.fn(),
    sendMessageImmediateWithResolvedLink: jest.fn(),
    sendMessageImmediateToUser: jest.fn(),
    editMessageInlineKeyboard: jest.fn(),
    deleteMessage: jest.fn(),
  };
}

function expectManagedGiveawaySendOptions(overrides: Record<string, unknown> = {}) {
  return expect.objectContaining({
    trafficClass: 'interactive',
    actionHealthLane: 'interactive',
    sourceTag: MAX_API_SOURCE_TAGS.MANAGED_GIVEAWAY,
    timeoutMs: 12000,
    ...overrides,
  });
}

function createManagedEntityAccessLossMock() {
  return {
    recordIfManagedEntityAccessLost: jest.fn().mockResolvedValue(null),
  };
}

function createMaxBotLinkMock(
  options: {
    resolvedBotId?: string;
    entryBotId?: string;
    contactId?: string | null;
    token?: string;
  } = {},
) {
  const resolvedBotId = options.resolvedBotId ?? 'id613002203036_4_bot';
  const entryBotId = options.entryBotId ?? resolvedBotId;
  const contactId = options.contactId ?? '613002203040';
  const token = options.token ?? 'test-token';

  return {
    getBotTokenSync: jest.fn().mockReturnValue(token),
    getValidationTokens: jest.fn().mockReturnValue([token]),
    resolveBotIdForRead: jest.fn().mockResolvedValue(resolvedBotId),
    resolveBotIdForSend: jest.fn().mockResolvedValue(resolvedBotId),
    resolveBotIdForModerationAction: jest.fn().mockResolvedValue(resolvedBotId),
    resolveBotId: jest.fn().mockResolvedValue(resolvedBotId),
    resolveContactIdSync: jest.fn((botId?: string | null) =>
      botId === resolvedBotId || botId == null ? contactId : null,
    ),
    buildEntryMiniappStartUrlSync: jest.fn((startParam: string) => {
      return `https://max.ru/${encodeURIComponent(entryBotId)}?startapp=${encodeURIComponent(startParam)}`;
    }),
    buildMiniappStartUrlSync: jest.fn((startParam: string, botId?: string | null) => {
      const targetBotId = botId?.trim() || resolvedBotId;
      return `https://max.ru/${encodeURIComponent(targetBotId)}?startapp=${encodeURIComponent(startParam)}`;
    }),
    buildBotStartUrlSync: jest.fn((startParam: string, botId?: string | null) => {
      const targetBotId = botId?.trim() || resolvedBotId;
      return `https://max.ru/${encodeURIComponent(targetBotId)}?start=${encodeURIComponent(startParam)}`;
    }),
  };
}

function createChatContextCacheMock(
  options: {
    giveawayBackoffRemainingById?: Map<string, number>;
    giveawayDeferRemainingById?: Map<string, number>;
    giveawayFailureCountById?: Map<string, number>;
  } = {},
) {
  const giveawayBackoffRemainingById = options.giveawayBackoffRemainingById ?? new Map();
  const giveawayDeferRemainingById = options.giveawayDeferRemainingById ?? new Map();
  const giveawayFailureCountById = options.giveawayFailureCountById ?? new Map();

  return {
    invalidate: jest.fn(),
    getManagedGiveawayRunnerBackoffRemainingMs: jest
      .fn()
      .mockImplementation(
        async (giveawayId: string) => giveawayBackoffRemainingById.get(giveawayId) ?? 0,
      ),
    getManagedGiveawayRunnerDeferRemainingMs: jest
      .fn()
      .mockImplementation(
        async (giveawayId: string) => giveawayDeferRemainingById.get(giveawayId) ?? 0,
      ),
    activateManagedGiveawayRunnerBackoff: jest
      .fn()
      .mockImplementation(async (giveawayId: string, ttlSec: number) => {
        giveawayBackoffRemainingById.set(giveawayId, ttlSec * 1000);
      }),
    activateManagedGiveawayRunnerDefer: jest
      .fn()
      .mockImplementation(async (giveawayId: string, ttlSec: number) => {
        giveawayDeferRemainingById.set(giveawayId, ttlSec * 1000);
      }),
    incrementManagedGiveawayRunnerFailureCount: jest
      .fn()
      .mockImplementation(async (giveawayId: string) => {
        const next = (giveawayFailureCountById.get(giveawayId) ?? 0) + 1;
        giveawayFailureCountById.set(giveawayId, next);
        return next;
      }),
    clearManagedGiveawayRunnerRetryCounters: jest
      .fn()
      .mockImplementation(async (giveawayId: string) => {
        giveawayBackoffRemainingById.delete(giveawayId);
        giveawayFailureCountById.delete(giveawayId);
      }),
    clearManagedGiveawayRunnerFailureState: jest
      .fn()
      .mockImplementation(async (giveawayId: string) => {
        giveawayBackoffRemainingById.delete(giveawayId);
        giveawayDeferRemainingById.delete(giveawayId);
        giveawayFailureCountById.delete(giveawayId);
      }),
  };
}

function createGiveaway(overrides: Record<string, unknown> = {}) {
  return {
    id: 'giveaway-1',
    sourceChatId: 'source-1',
    entityType: ChatEntityType.CHANNEL,
    actorUserId: 'admin-1',
    title: 'Весенний розыгрыш',
    description: '',
    imageEnabled: false,
    imageBase64: '',
    imageMimeType: '',
    imageFileName: '',
    startsAt: null,
    endsAt: new Date(Date.now() + 24 * 60 * 60_000),
    claimHours: 48,
    status: ManagedGiveawayStatus.ACTIVE,
    requiredChannelIds: ['extra-1'],
    publicationMessageId: null,
    publicationBotId: null,
    publicationUrl: null,
    publishedAt: null,
    resultsMessageId: null,
    resultsBotId: null,
    resultsUrl: null,
    drawSeed: null,
    drawnAt: null,
    completedAt: null,
    canceledAt: null,
    lockedAt: null,
    sendLockKey: null,
    createdAt: new Date('2026-03-21T09:00:00.000Z'),
    updatedAt: new Date('2026-03-21T09:00:00.000Z'),
    prizes: [],
    entries: [],
    winners: [],
    ...overrides,
  };
}

function createEntry(overrides: Record<string, unknown> = {}) {
  return {
    id: 'entry-1',
    giveawayId: 'giveaway-1',
    userId: 'user-1',
    displayName: 'Тестер',
    joinedAt: new Date('2026-03-21T10:00:00.000Z'),
    eligibilityState: GiveawayEligibilityState.REJECTED,
    eligibilityReason: 'Подписка на обязательный чат/канал не подтверждена.',
    missingChannelIds: ['extra-1'],
    checkedAt: new Date('2026-03-21T10:00:00.000Z'),
    drawRank: null,
    createdAt: new Date('2026-03-21T10:00:00.000Z'),
    updatedAt: new Date('2026-03-21T10:00:00.000Z'),
    ...overrides,
  };
}

function createPrize(overrides: Record<string, unknown> = {}) {
  return {
    id: 'prize-1',
    giveawayId: 'giveaway-1',
    position: 1,
    title: 'Главный приз',
    createdAt: new Date('2026-03-21T09:00:00.000Z'),
    updatedAt: new Date('2026-03-21T09:00:00.000Z'),
    ...overrides,
  };
}

function createWinner(overrides: Record<string, unknown> = {}) {
  const entry = createEntry({
    id: 'entry-winner-1',
    userId: 'winner-1',
    displayName: 'CEO',
  });
  const prize = createPrize();

  return {
    id: 'winner-1',
    giveawayId: 'giveaway-1',
    prizeId: prize.id,
    entryId: entry.id,
    rank: 1,
    status: ManagedGiveawayWinnerStatus.SELECTED,
    claimDeadlineAt: new Date('2026-12-23T12:00:00.000Z'),
    claimedAt: null,
    deliveredAt: null,
    expiredAt: null,
    rerolledAt: null,
    selectedAt: new Date('2026-03-21T12:00:00.000Z'),
    createdAt: new Date('2026-03-21T12:00:00.000Z'),
    updatedAt: new Date('2026-03-21T12:00:00.000Z'),
    prize,
    entry,
    ...overrides,
  };
}

function createSecondWinner(overrides: Record<string, unknown> = {}) {
  const entry = createEntry({
    id: 'entry-winner-2',
    userId: 'winner-2',
    displayName: 'CTO',
  });
  const prize = createPrize({
    id: 'prize-2',
    position: 2,
    title: 'Второй приз',
  });

  return {
    id: 'winner-2',
    giveawayId: 'giveaway-1',
    prizeId: prize.id,
    entryId: entry.id,
    rank: 2,
    status: ManagedGiveawayWinnerStatus.SELECTED,
    claimDeadlineAt: new Date('2026-12-23T12:00:00.000Z'),
    claimedAt: null,
    deliveredAt: null,
    expiredAt: null,
    rerolledAt: null,
    selectedAt: new Date('2026-03-21T12:05:00.000Z'),
    createdAt: new Date('2026-03-21T12:05:00.000Z'),
    updatedAt: new Date('2026-03-21T12:05:00.000Z'),
    prize,
    entry,
    ...overrides,
  };
}

function createWinnerNotification(overrides: Record<string, unknown> = {}) {
  const { winner: winnerOverride, ...notificationOverrides } = overrides;
  const winner = {
    ...createWinner(),
    ...((winnerOverride as Record<string, unknown> | undefined) ?? {}),
  };
  const giveaway = {
    ...createGiveaway({
      status: ManagedGiveawayStatus.COMPLETED,
      prizes: [winner.prize],
    }),
    ...(((winnerOverride as { giveaway?: Record<string, unknown> } | undefined)?.giveaway ?? {}) as
      | Record<string, unknown>
      | undefined),
  };

  return {
    id: 'winner-notification-1',
    winnerId: winner.id,
    status: ManagedGiveawayWinnerNotificationStatus.PENDING,
    nextAttemptAt: new Date('2026-03-21T12:00:00.000Z'),
    attemptCount: 0,
    lockedAt: null,
    dispatchedAt: null,
    botId: null,
    remoteMessageId: null,
    lastError: null,
    sentAt: null,
    ambiguousAt: null,
    createdAt: new Date('2026-03-21T12:00:00.000Z'),
    updatedAt: new Date('2026-03-21T12:00:00.000Z'),
    winner: {
      ...winner,
      giveaway,
    },
    ...notificationOverrides,
  };
}

describe('ManagedGiveawayService', () => {
  const user = {
    userId: 'user-1',
    username: 'tester',
    displayName: 'Тестер',
  };

  afterEach(() => {
    jest.useRealTimers();
  });

  it('serializes the empty-current-giveaway check with creation', async () => {
    const prisma = createPrismaMock();
    const service = new ManagedGiveawayService(
      prisma as never,
      createMaxClientMock() as never,
      {} as never,
      {} as never,
      createConfigMock() as never,
    );
    jest.spyOn(service as any, 'assertAdminEntityAccess').mockResolvedValue(undefined);
    prisma.managedGiveaway.findFirst.mockResolvedValue(null);
    const draft = createGiveaway({ status: 'DRAFT', prizes: [createPrize()] });
    prisma.managedGiveaway.create.mockResolvedValue(draft);
    await service.createManagedGiveaway(
      'source-1',
      user,
      {
        title: 'Новый розыгрыш',
        endsAt: draft.endsAt.toISOString(),
        prizes: [{ position: 1, title: 'Приз' }],
      },
      'channel',
    );
    expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: 'Serializable',
    });
    expect(prisma.managedGiveaway.findFirst.mock.invocationCallOrder[0]).toBeLessThan(
      prisma.managedGiveaway.create.mock.invocationCallOrder[0],
    );
  });

  it('reports a creation serialization conflict without silently duplicating the draft', async () => {
    const prisma = createPrismaMock();
    const service = new ManagedGiveawayService(
      prisma as never,
      createMaxClientMock() as never,
      {} as never,
      {} as never,
      createConfigMock() as never,
    );
    jest.spyOn(service as any, 'assertAdminEntityAccess').mockResolvedValue(undefined);
    prisma.$transaction.mockRejectedValue({ code: 'P2034' });
    await expect(
      service.createManagedGiveaway(
        'source-1',
        user,
        {
          title: 'Новый розыгрыш',
          endsAt: new Date(Date.now() + 60_000).toISOString(),
          prizes: [{ position: 1, title: 'Приз' }],
        },
        'channel',
      ),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.managedGiveaway.create).not.toHaveBeenCalled();
  });

  it('rejects an expired draft before attempting publication', async () => {
    const prisma = createPrismaMock();
    const maxClient = createMaxClientMock();
    const service = new ManagedGiveawayService(
      prisma as never,
      maxClient as never,
      {} as never,
      {} as never,
      createConfigMock() as never,
    );
    jest.spyOn(service as any, 'assertAdminEntityAccess').mockResolvedValue(undefined);
    prisma.managedGiveaway.findFirst.mockResolvedValue(
      createGiveaway({ status: 'DRAFT', endsAt: new Date(Date.now() - 1) }),
    );
    await expect(
      service.publishManagedGiveaway('source-1', 'giveaway-1', user, 'channel'),
    ).rejects.toThrow('Время завершения уже прошло');
    expect(prisma.managedGiveaway.updateMany).not.toHaveBeenCalled();
    expect(maxClient.sendMessageImmediateWithResolvedLink).not.toHaveBeenCalled();
  });

  it('rejects an entry when draw acquires the giveaway during membership lookup', async () => {
    const prisma = createPrismaMock();
    const service = new ManagedGiveawayService(
      prisma as never,
      createMaxClientMock() as never,
      {} as never,
      {} as never,
      createConfigMock() as never,
    );
    const giveaway = createGiveaway({ endsAt: new Date(Date.now() + 60_000) });
    jest.spyOn(service as any, 'findPublicGiveawayById').mockResolvedValue(giveaway);
    jest.spyOn(service as any, 'upsertParticipantChatAccess').mockResolvedValue(undefined);
    jest
      .spyOn(service as any, 'evaluateGiveawayEligibility')
      .mockResolvedValue({ state: 'VERIFIED', reason: null, missingChannelIds: [] });
    prisma.managedGiveaway.updateMany.mockResolvedValue({ count: 0 });
    await expect(service.enterGiveaway(giveaway.id, user)).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(prisma.managedGiveawayEntry.upsert).not.toHaveBeenCalled();
    expect((service as any).evaluateGiveawayEligibility).toHaveBeenCalledWith(
      giveaway,
      user.userId,
      {
        forceFreshMembership: true,
        lookupPolicy: 'giveaway_interactive',
        allowStaleMembershipOnError: false,
      },
    );
    expect(prisma.managedGiveaway.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: 'ACTIVE', endsAt: { gt: expect.any(Date) } }),
      }),
    );
  });

  it('checks the entry deadline again after obtaining the SQL admission lock', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-09-11T10:00:00Z'));
    const prisma = createPrismaMock();
    const service = new ManagedGiveawayService(
      prisma as never,
      createMaxClientMock() as never,
      {} as never,
      {} as never,
      createConfigMock() as never,
    );
    const giveaway = createGiveaway({ endsAt: new Date('2026-09-11T10:00:01Z') });
    jest.spyOn(service as any, 'findPublicGiveawayById').mockResolvedValue(giveaway);
    jest.spyOn(service as any, 'upsertParticipantChatAccess').mockResolvedValue(undefined);
    jest
      .spyOn(service as any, 'evaluateGiveawayEligibility')
      .mockResolvedValue({ state: 'VERIFIED', reason: null, missingChannelIds: [] });
    prisma.managedGiveaway.updateMany.mockImplementation(async () => {
      jest.setSystemTime(giveaway.endsAt);
      return { count: 1 };
    });
    await expect(service.enterGiveaway(giveaway.id, user)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(prisma.managedGiveawayEntry.upsert).not.toHaveBeenCalled();
  });

  it('does not persist a claim when the final database deadline guard rejects after MAX', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-09-11T10:00:00Z'));
    const prisma = createPrismaMock();
    const service = new ManagedGiveawayService(
      prisma as never,
      createMaxClientMock() as never,
      {} as never,
      {} as never,
      createConfigMock() as never,
    );
    const winner = createWinner({
      claimDeadlineAt: new Date('2026-09-11T10:00:01Z'),
      entry: createEntry({ userId: user.userId }),
    });
    jest
      .spyOn(service as any, 'findPublicGiveawayById')
      .mockResolvedValue(createGiveaway({ status: 'COMPLETED', winners: [winner] }));
    jest.spyOn(service as any, 'evaluateGiveawayEligibility').mockImplementation(async () => {
      jest.setSystemTime(new Date('2026-09-11T10:00:02Z'));
      return { state: 'VERIFIED', reason: null, missingChannelIds: [] };
    });
    prisma.$queryRaw
      .mockResolvedValueOnce([{ id: winner.id, status: winner.status }])
      .mockResolvedValueOnce([]);
    await expect(service.claimGiveaway('giveaway-1', user)).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(2);
    expect(prisma.managedGiveawayWinner.update).not.toHaveBeenCalled();
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  it('does not persist entries or winners after losing its draw lease', async () => {
    const prisma = createPrismaMock();
    const service = new ManagedGiveawayService(
      prisma as never,
      createMaxClientMock() as never,
      {} as never,
      {} as never,
      createConfigMock() as never,
    );
    const entry = createEntry({ eligibilityState: 'VERIFIED' });
    const giveaway = createGiveaway({
      status: 'DRAWING',
      drawSeed: 'lease-seed',
      lockedAt: new Date(),
      entries: [entry],
      prizes: [createPrize()],
    });
    jest.spyOn(service as any, 'findGiveawayById').mockResolvedValue(giveaway);
    jest
      .spyOn(service as any, 'claimGiveawayForDraw')
      .mockResolvedValue({ status: 'claimed', giveaway, drawSeed: 'lease-seed' });
    jest
      .spyOn(service as any, 'evaluateGiveawayEligibilityForDraw')
      .mockResolvedValue(
        new Map([[entry.userId, { state: 'VERIFIED', reason: null, missingChannelIds: [] }]]),
      );
    prisma.managedGiveaway.updateMany.mockResolvedValue({ count: 0 });
    await expect((service as any).drawGiveaway(giveaway.id, 'runner')).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(prisma.managedGiveawayEntry.update).not.toHaveBeenCalled();
    expect(prisma.managedGiveawayWinner.createMany).not.toHaveBeenCalled();
    expect(prisma.managedGiveawayWinner.deleteMany).not.toHaveBeenCalled();
    expect(prisma.managedGiveaway.updateMany).toHaveBeenLastCalledWith({
      where: {
        id: giveaway.id,
        status: 'DRAWING',
        lockedAt: giveaway.lockedAt,
        drawSeed: 'lease-seed',
      },
      data: { status: 'DRAWING', lockedAt: null, sendLockKey: null },
    });
  });

  it('starts the claim window after the membership scan, not when draw begins', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-09-11T10:00:00Z'));
    const prisma = createPrismaMock();
    const service = new ManagedGiveawayService(
      prisma as never,
      createMaxClientMock() as never,
      {} as never,
      {} as never,
      createConfigMock() as never,
    );
    const entry = createEntry({ eligibilityState: 'VERIFIED' });
    const giveaway = createGiveaway({
      status: 'DRAWING',
      drawSeed: 'seed',
      lockedAt: new Date(),
      entries: [entry],
      prizes: [createPrize()],
      claimHours: 1,
    });
    jest.spyOn(service as any, 'findGiveawayById').mockResolvedValue(giveaway);
    jest
      .spyOn(service as any, 'claimGiveawayForDraw')
      .mockResolvedValue({ status: 'claimed', giveaway, drawSeed: 'seed' });
    jest
      .spyOn(service as any, 'evaluateGiveawayEligibilityForDraw')
      .mockImplementation(async () => {
        jest.setSystemTime(new Date('2026-09-11T10:02:00Z'));
        return new Map([
          [entry.userId, { state: 'VERIFIED', reason: null, missingChannelIds: [] }],
        ]);
      });
    prisma.managedGiveaway.findUniqueOrThrow.mockResolvedValue(giveaway);
    jest.spyOn(service as any, 'editGiveawayPublicationIfNeeded').mockResolvedValue(undefined);
    jest.spyOn(service as any, 'republishGiveawayResults').mockResolvedValue(false);
    await (service as any).drawGiveaway(giveaway.id, 'runner');
    expect(prisma.managedGiveawayWinner.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          selectedAt: new Date('2026-09-11T10:02:00Z'),
          claimDeadlineAt: new Date('2026-09-11T11:02:00Z'),
        }),
      ],
    });
  });

  it('deletes published giveaway messages with their persisted author bots before removing the giveaway', async () => {
    const prisma = createPrismaMock();
    const maxClient = createMaxClientMock();
    const service = new ManagedGiveawayService(
      prisma as never,
      maxClient as never,
      { invalidate: jest.fn() } as never,
      { getChannelSettings: jest.fn().mockResolvedValue({}) } as never,
      createConfigMock() as never,
    );

    prisma.managedGiveaway.findFirst.mockResolvedValue(
      createGiveaway({
        status: ManagedGiveawayStatus.COMPLETED,
        publicationMessageId: 'publication-1',
        publicationBotId: 'publication-author-bot',
        resultsMessageId: 'results-1',
        resultsBotId: 'results-author-bot',
      }),
    );
    prisma.managedGiveaway.delete.mockResolvedValue(createGiveaway());
    maxClient.deleteMessage.mockResolvedValue(undefined);

    await service.deleteManagedGiveaway('source-1', 'giveaway-1', user as never, 'channel');

    expect(maxClient.deleteMessage).toHaveBeenNthCalledWith(
      1,
      'source-1',
      'publication-1',
      expectManagedGiveawaySendOptions({
        immediate: true,
        botId: 'publication-author-bot',
      }),
    );
    expect(maxClient.deleteMessage).toHaveBeenNthCalledWith(
      2,
      'source-1',
      'results-1',
      expectManagedGiveawaySendOptions({
        immediate: true,
        botId: 'results-author-bot',
      }),
    );
    expect(prisma.managedGiveaway.delete).toHaveBeenCalledWith({
      where: { id: 'giveaway-1' },
    });
    expect(prisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: 'DELETE_GIVEAWAY',
        }),
      }),
    );
  });

  it('routes legacy giveaway message deletes through explicit delete-capable bots', async () => {
    const deleteAttemptStartedAt = new Date('2026-08-20T12:00:00.123Z');
    jest.useFakeTimers().setSystemTime(deleteAttemptStartedAt);

    const prisma = createPrismaMock();
    const maxClient = createMaxClientMock();
    const maxBotLinkService = createMaxBotLinkMock();
    const managedEntityAccessLossService = createManagedEntityAccessLossMock();
    const deleteError = createMaxApiError(403, 'Forbidden', 'chat.denied');
    const service = new ManagedGiveawayService(
      prisma as never,
      maxClient as never,
      { invalidate: jest.fn() } as never,
      { getChannelSettings: jest.fn().mockResolvedValue({}) } as never,
      createConfigMock() as never,
      undefined,
      maxBotLinkService as never,
      managedEntityAccessLossService as never,
    );

    prisma.managedGiveaway.findFirst.mockResolvedValue(
      createGiveaway({
        status: ManagedGiveawayStatus.COMPLETED,
        publicationMessageId: 'legacy-publication-1',
        publicationBotId: null,
        resultsMessageId: 'legacy-results-1',
        resultsBotId: null,
      }),
    );
    maxBotLinkService.resolveBotIdForModerationAction
      .mockResolvedValueOnce('publication-delete-bot')
      .mockResolvedValueOnce('results-delete-bot')
      .mockResolvedValueOnce('results-delete-bot');
    maxClient.deleteMessage.mockResolvedValueOnce(undefined).mockRejectedValueOnce(deleteError);

    await expect(
      service.deleteManagedGiveaway('source-1', 'giveaway-1', user as never, 'channel'),
    ).rejects.toThrow(BadRequestException);

    expect(maxBotLinkService.resolveBotIdForModerationAction).toHaveBeenNthCalledWith(1, {
      chatId: 'source-1',
      action: 'delete_message',
      fallbackToPrimary: true,
    });
    expect(maxBotLinkService.resolveBotIdForModerationAction).toHaveBeenNthCalledWith(2, {
      chatId: 'source-1',
      action: 'delete_message',
      fallbackToPrimary: true,
    });
    expect(maxBotLinkService.resolveBotIdForModerationAction).toHaveBeenNthCalledWith(3, {
      chatId: 'source-1',
      action: 'delete_message',
      fallbackToPrimary: true,
    });
    expect(maxClient.deleteMessage).toHaveBeenNthCalledWith(
      1,
      'source-1',
      'legacy-publication-1',
      expectManagedGiveawaySendOptions({ immediate: true, botId: 'publication-delete-bot' }),
    );
    expect(maxClient.deleteMessage).toHaveBeenNthCalledWith(
      2,
      'source-1',
      'legacy-results-1',
      expectManagedGiveawaySendOptions({ immediate: true, botId: 'results-delete-bot' }),
    );
    expect(managedEntityAccessLossService.recordIfManagedEntityAccessLost).toHaveBeenCalledWith({
      chatId: 'source-1',
      botId: 'results-delete-bot',
      entityType: ChatEntityType.CHANNEL,
      source: 'managed_giveaway:results:delete',
      operation: 'delete',
      error: deleteError,
      lifecycleEventAt: deleteAttemptStartedAt,
      lifecycleEventType: 'live_probe',
      lifecycleSource: 'live_probe',
    });
    expect(prisma.managedGiveaway.delete).not.toHaveBeenCalled();
  });

  it('retries a persisted giveaway message delete through a survivor after terminal origin loss', async () => {
    const deleteAttemptStartedAt = new Date('2026-08-20T12:00:00.123Z');
    jest.useFakeTimers().setSystemTime(deleteAttemptStartedAt);
    const prisma = createPrismaMock();
    const maxClient = createMaxClientMock();
    const maxBotLinkService = createMaxBotLinkMock();
    const managedEntityAccessLossService = createManagedEntityAccessLossMock();
    const terminalError = createMaxApiError(403, 'Forbidden', 'chat.denied');
    const service = new ManagedGiveawayService(
      prisma as never,
      maxClient as never,
      { invalidate: jest.fn() } as never,
      { getChannelSettings: jest.fn().mockResolvedValue({}) } as never,
      createConfigMock() as never,
      undefined,
      maxBotLinkService as never,
      managedEntityAccessLossService as never,
    );

    prisma.managedGiveaway.findFirst.mockResolvedValue(
      createGiveaway({
        status: ManagedGiveawayStatus.COMPLETED,
        publicationMessageId: 'publication-1',
        publicationBotId: 'origin-bot',
      }),
    );
    prisma.managedGiveaway.delete.mockResolvedValue(createGiveaway());
    maxClient.deleteMessage.mockRejectedValueOnce(terminalError).mockResolvedValueOnce(undefined);
    maxBotLinkService.resolveBotIdForModerationAction.mockResolvedValueOnce('survivor-bot');

    await service.deleteManagedGiveaway('source-1', 'giveaway-1', user as never, 'channel');

    expect(maxClient.deleteMessage).toHaveBeenNthCalledWith(
      1,
      'source-1',
      'publication-1',
      expectManagedGiveawaySendOptions({ immediate: true, botId: 'origin-bot' }),
    );
    expect(maxClient.deleteMessage).toHaveBeenNthCalledWith(
      2,
      'source-1',
      'publication-1',
      expectManagedGiveawaySendOptions({ immediate: true, botId: 'survivor-bot' }),
    );
    expect(managedEntityAccessLossService.recordIfManagedEntityAccessLost).toHaveBeenCalledWith({
      chatId: 'source-1',
      botId: 'origin-bot',
      entityType: ChatEntityType.CHANNEL,
      source: 'managed_giveaway:publication:delete',
      operation: 'delete',
      error: terminalError,
      lifecycleEventAt: deleteAttemptStartedAt,
      lifecycleEventType: 'live_probe',
      lifecycleSource: 'live_probe',
    });
    expect(maxBotLinkService.resolveBotIdForModerationAction).toHaveBeenCalledWith({
      chatId: 'source-1',
      action: 'delete_message',
      fallbackToPrimary: true,
    });
    expect(prisma.managedGiveaway.delete).toHaveBeenCalledWith({
      where: { id: 'giveaway-1' },
    });
  });

  it('keeps survivor route lookup failures inside the managed giveaway delete error boundary', async () => {
    const prisma = createPrismaMock();
    const maxClient = createMaxClientMock();
    const maxBotLinkService = createMaxBotLinkMock();
    const managedEntityAccessLossService = createManagedEntityAccessLossMock();
    const terminalError = createMaxApiError(403, 'Forbidden', 'chat.denied');
    const survivorLookupError = new Error('route database unavailable');
    const service = new ManagedGiveawayService(
      prisma as never,
      maxClient as never,
      { invalidate: jest.fn() } as never,
      { getChannelSettings: jest.fn().mockResolvedValue({}) } as never,
      createConfigMock() as never,
      undefined,
      maxBotLinkService as never,
      managedEntityAccessLossService as never,
    );
    const warnSpy = jest.spyOn((service as any).logger, 'warn');

    prisma.managedGiveaway.findFirst.mockResolvedValue(
      createGiveaway({
        status: ManagedGiveawayStatus.COMPLETED,
        publicationMessageId: 'publication-1',
        publicationBotId: 'origin-bot',
      }),
    );
    maxClient.deleteMessage.mockRejectedValueOnce(terminalError);
    maxBotLinkService.resolveBotIdForModerationAction.mockRejectedValueOnce(survivorLookupError);

    await expect(
      service.deleteManagedGiveaway('source-1', 'giveaway-1', user as never, 'channel'),
    ).rejects.toThrow(BadRequestException);

    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        giveawayId: 'giveaway-1',
        messageId: 'publication-1',
        botId: 'origin-bot',
        err: survivorLookupError.message,
      }),
      'Failed to resolve a survivor bot for managed giveaway message delete',
    );
    expect(prisma.managedGiveaway.delete).not.toHaveBeenCalled();
  });

  it('treats already missing giveaway publication messages as deleted', async () => {
    const prisma = createPrismaMock();
    const maxClient = createMaxClientMock();
    const managedEntityAccessLossService = createManagedEntityAccessLossMock();
    const service = new ManagedGiveawayService(
      prisma as never,
      maxClient as never,
      { invalidate: jest.fn() } as never,
      { getChannelSettings: jest.fn().mockResolvedValue({}) } as never,
      createConfigMock() as never,
      undefined,
      undefined,
      managedEntityAccessLossService as never,
    );

    prisma.managedGiveaway.findFirst.mockResolvedValue(
      createGiveaway({
        status: ManagedGiveawayStatus.CANCELED,
        publicationMessageId: 'publication-missing-1',
        publicationBotId: 'publication-author-bot',
      }),
    );
    prisma.managedGiveaway.delete.mockResolvedValue(createGiveaway());
    maxClient.deleteMessage.mockRejectedValueOnce(
      createMaxApiError(404, 'message not found', 'message.not.found'),
    );

    await service.deleteManagedGiveaway('source-1', 'giveaway-1', user as never, 'channel');

    expect(prisma.managedGiveaway.delete).toHaveBeenCalledWith({
      where: { id: 'giveaway-1' },
    });
    expect(managedEntityAccessLossService.recordIfManagedEntityAccessLost).not.toHaveBeenCalled();
  });

  it('stores repeated prize titles as unique winner slots', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-21T09:00:00.000Z'));

    const prisma = createPrismaMock();
    const service = new ManagedGiveawayService(
      prisma as never,
      createMaxClientMock() as never,
      { invalidate: jest.fn() } as never,
      { getChannelSettings: jest.fn().mockResolvedValue({}) } as never,
      createConfigMock() as never,
    );
    const prizes = Array.from({ length: 10 }, (_, index) => ({
      id: `prize-${index + 1}`,
      giveawayId: 'giveaway-duplicate-prizes',
      position: index + 1,
      title: `Прикормка ${index + 1}`,
      displayTitle: 'Прикормка',
      createdAt: new Date('2026-03-21T09:00:00.000Z'),
    }));
    const created = createGiveaway({
      id: 'giveaway-duplicate-prizes',
      status: ManagedGiveawayStatus.DRAFT,
      prizes,
    });

    prisma.managedGiveaway.findFirst.mockResolvedValueOnce(null);
    prisma.managedGiveaway.create.mockResolvedValueOnce(created);

    await expect(
      service.createManagedGiveaway(
        'source-1',
        user as never,
        {
          title: 'Розыгрыш прикормки',
          description: '',
          imageEnabled: false,
          startsAt: null,
          endsAt: '2026-03-22T12:00:00.000Z',
          claimHours: 24,
          requiredChannelIds: [],
          prizes: Array.from({ length: 10 }, (_, index) => ({
            position: index + 1,
            title: 'Прикормка',
          })),
        },
        'channel',
      ),
    ).resolves.toMatchObject({
      id: 'giveaway-duplicate-prizes',
      prizes: prizes.map((prize) => ({
        position: prize.position,
        title: prize.title,
        displayTitle: 'Прикормка',
      })),
    });

    expect(prisma.managedGiveaway.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          prizes: {
            create: Array.from({ length: 10 }, (_, index) => ({
              position: index + 1,
              title: `Прикормка ${index + 1}`,
              displayTitle: 'Прикормка',
            })),
          },
        }),
      }),
    );
  });

  it('stores exact missing channel ids when enter fails required subscription checks', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-21T10:05:00.000Z'));

    const prisma = createPrismaMock();
    const maxClient = createMaxClientMock();
    const service = new ManagedGiveawayService(
      prisma as never,
      maxClient as never,
      { invalidate: jest.fn() } as never,
      {} as never,
      createConfigMock() as never,
    );

    const initial = createGiveaway();
    const savedEntry = createEntry({
      eligibilityState: GiveawayEligibilityState.REJECTED,
      missingChannelIds: ['extra-1'],
    });
    const latest = createGiveaway({
      entries: [savedEntry],
    });

    prisma.managedGiveaway.findUnique
      .mockResolvedValueOnce(initial)
      .mockResolvedValueOnce(initial)
      .mockResolvedValueOnce(latest);
    prisma.managedGiveawayEntry.upsert.mockResolvedValue(savedEntry);
    maxClient.hasChatMember.mockResolvedValueOnce(true).mockResolvedValueOnce(false);

    const result = await service.enterGiveaway('giveaway-1', user);

    expect(prisma.managedGiveawayEntry.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          eligibilityState: GiveawayEligibilityState.REJECTED,
          missingChannelIds: ['extra-1'],
        }),
        update: expect.objectContaining({
          eligibilityState: GiveawayEligibilityState.REJECTED,
          missingChannelIds: ['extra-1'],
        }),
      }),
    );
    expect(result.eligibilityState).toBe('REJECTED');
    expect(result.missingChannelIds).toEqual(['extra-1']);
  });

  it('clears missing channel ids after successful retry', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-21T10:10:00.000Z'));

    const prisma = createPrismaMock();
    const maxClient = createMaxClientMock();
    const service = new ManagedGiveawayService(
      prisma as never,
      maxClient as never,
      { invalidate: jest.fn() } as never,
      {} as never,
      createConfigMock() as never,
    );

    const rejectedEntry = createEntry();
    const refreshed = createGiveaway({
      entries: [rejectedEntry],
    });
    const savedEntry = createEntry({
      eligibilityState: GiveawayEligibilityState.VERIFIED,
      eligibilityReason: null,
      missingChannelIds: [],
    });
    const latest = createGiveaway({
      entries: [savedEntry],
    });

    prisma.managedGiveaway.findUnique
      .mockResolvedValueOnce(refreshed)
      .mockResolvedValueOnce(refreshed)
      .mockResolvedValueOnce(latest);
    prisma.managedGiveawayEntry.upsert.mockResolvedValue(savedEntry);
    maxClient.hasChatMember.mockResolvedValueOnce(true).mockResolvedValueOnce(true);

    const result = await service.enterGiveaway('giveaway-1', user);

    expect(prisma.managedGiveawayEntry.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({
          eligibilityState: GiveawayEligibilityState.VERIFIED,
          missingChannelIds: [],
        }),
      }),
    );
    expect(result.eligibilityState).toBe('VERIFIED');
    expect(result.missingChannelIds).toEqual([]);
  });

  it('uses the persisted bot assignment when checking giveaway required chat membership', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-21T10:11:00.000Z'));

    const prisma = createPrismaMock();
    const maxClient = createMaxClientMock();
    const membershipLookup = {
      getMembership: jest.fn().mockResolvedValue(true),
      getLookupIssue: jest.fn(),
    };
    prisma.chat.findUnique.mockImplementation(async (args: { where?: { id?: string } }) => {
      if (args.where?.id === 'source-1') {
        return { primaryBotId: 'bot-source', botId: null };
      }
      if (args.where?.id === 'extra-chat-1') {
        return { primaryBotId: 'bot-extra-chat', botId: null };
      }

      return { title: 'Основной канал' };
    });

    const service = new ManagedGiveawayService(
      prisma as never,
      maxClient as never,
      { invalidate: jest.fn() } as never,
      {} as never,
      createConfigMock() as never,
      membershipLookup as never,
    );

    const refreshed = createGiveaway({
      requiredChannelIds: ['extra-chat-1'],
    });
    const savedEntry = createEntry({
      eligibilityState: GiveawayEligibilityState.VERIFIED,
      eligibilityReason: null,
      missingChannelIds: [],
    });
    const latest = createGiveaway({
      requiredChannelIds: ['extra-chat-1'],
      entries: [savedEntry],
    });

    prisma.managedGiveaway.findUnique
      .mockResolvedValueOnce(refreshed)
      .mockResolvedValueOnce(refreshed)
      .mockResolvedValueOnce(latest);
    prisma.managedGiveawayEntry.upsert.mockResolvedValue(savedEntry);

    const result = await service.enterGiveaway('giveaway-1', user);

    expect(result.eligibilityState).toBe('VERIFIED');
    expect(membershipLookup.getMembership).toHaveBeenNthCalledWith(
      1,
      'source-1',
      'user-1',
      'giveaway_interactive',
      expect.objectContaining({ botId: 'bot-source' }),
    );
    expect(membershipLookup.getMembership).toHaveBeenNthCalledWith(
      2,
      'extra-chat-1',
      'user-1',
      'giveaway_interactive',
      expect.objectContaining({ botId: 'bot-extra-chat' }),
    );
    expect(maxClient.hasChatMember).not.toHaveBeenCalled();
  });

  it('writes a recheck audit entry when eligibility changes after retry', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-21T10:11:00.000Z'));

    const prisma = createPrismaMock();
    const maxClient = createMaxClientMock();
    const service = new ManagedGiveawayService(
      prisma as never,
      maxClient as never,
      { invalidate: jest.fn() } as never,
      {} as never,
      createConfigMock() as never,
    );

    const rejectedEntry = createEntry();
    const refreshed = createGiveaway({
      entries: [rejectedEntry],
    });
    const savedEntry = createEntry({
      eligibilityState: GiveawayEligibilityState.VERIFIED,
      eligibilityReason: null,
      missingChannelIds: [],
    });
    const latest = createGiveaway({
      entries: [savedEntry],
    });

    prisma.managedGiveaway.findUnique
      .mockResolvedValueOnce(refreshed)
      .mockResolvedValueOnce(refreshed)
      .mockResolvedValueOnce(latest);
    prisma.managedGiveawayEntry.upsert.mockResolvedValue(savedEntry);
    maxClient.hasChatMember.mockResolvedValueOnce(true).mockResolvedValueOnce(true);

    await service.enterGiveaway('giveaway-1', user);

    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: 'RECHECK_GIVEAWAY_ENTRY',
        actorUserId: 'user-1',
        chatId: 'source-1',
      }),
    });
  });

  it('does not create duplicate audit entries for unchanged participation rechecks', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-21T10:12:00.000Z'));

    const prisma = createPrismaMock();
    const maxClient = createMaxClientMock();
    const service = new ManagedGiveawayService(
      prisma as never,
      maxClient as never,
      { invalidate: jest.fn() } as never,
      {} as never,
      createConfigMock() as never,
    );

    const existingEntry = createEntry({
      eligibilityState: GiveawayEligibilityState.VERIFIED,
      eligibilityReason: null,
      missingChannelIds: [],
    });
    const refreshed = createGiveaway({
      requiredChannelIds: [],
      entries: [existingEntry],
    });
    const latest = createGiveaway({
      requiredChannelIds: [],
      entries: [existingEntry],
    });

    prisma.managedGiveaway.findUnique
      .mockResolvedValueOnce(refreshed)
      .mockResolvedValueOnce(refreshed)
      .mockResolvedValueOnce(latest);
    prisma.managedGiveawayEntry.upsert.mockResolvedValue(existingEntry);
    maxClient.hasChatMember.mockResolvedValueOnce(true);

    await service.enterGiveaway('giveaway-1', user);

    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  it('refreshes publication button with the current participants count after enter', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-21T10:12:00.000Z'));

    const prisma = createPrismaMock();
    const maxClient = createMaxClientMock();
    const service = new ManagedGiveawayService(
      prisma as never,
      maxClient as never,
      { invalidate: jest.fn() } as never,
      {} as never,
      createConfigMock() as never,
    );

    const initial = createGiveaway({
      description: 'Текст публикации',
      publicationMessageId: 'publication-1',
      entries: [],
    });
    const savedEntry = createEntry({
      eligibilityState: GiveawayEligibilityState.VERIFIED,
      eligibilityReason: null,
      missingChannelIds: [],
    });
    const latest = createGiveaway({
      description: 'Текст публикации',
      publicationMessageId: 'publication-1',
      entries: [savedEntry],
    });

    prisma.managedGiveaway.findUnique
      .mockResolvedValueOnce(initial)
      .mockResolvedValueOnce(initial)
      .mockResolvedValueOnce(latest);
    prisma.managedGiveawayEntry.upsert.mockResolvedValue(savedEntry);
    maxClient.hasChatMember.mockResolvedValueOnce(true).mockResolvedValueOnce(true);

    await service.enterGiveaway('giveaway-1', user);

    expect(maxClient.editMessageInlineKeyboard).toHaveBeenCalledWith(
      'source-1',
      'publication-1',
      null,
      expect.objectContaining({
        buttons: [[expect.objectContaining({ text: 'Участвовать · 1' })]],
      }),
      expectManagedGiveawaySendOptions(),
    );
  });

  it('uses the persisted publication bot when refreshing an existing giveaway post', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-21T10:12:15.000Z'));

    const prisma = createPrismaMock();
    const maxClient = createMaxClientMock();
    const maxBotLinkService = createMaxBotLinkMock({ resolvedBotId: 'current-route-bot' });
    const service = new ManagedGiveawayService(
      prisma as never,
      maxClient as never,
      { invalidate: jest.fn() } as never,
      {} as never,
      createConfigMock() as never,
      undefined,
      maxBotLinkService as never,
    );

    const initial = createGiveaway({
      description: 'Текст публикации',
      publicationMessageId: 'publication-1',
      publicationBotId: 'publication-author-bot',
      entries: [],
    });
    const savedEntry = createEntry({
      eligibilityState: GiveawayEligibilityState.VERIFIED,
      eligibilityReason: null,
      missingChannelIds: [],
    });
    const latest = createGiveaway({
      description: 'Текст публикации',
      publicationMessageId: 'publication-1',
      publicationBotId: 'publication-author-bot',
      entries: [savedEntry],
    });

    prisma.managedGiveaway.findUnique
      .mockResolvedValueOnce(initial)
      .mockResolvedValueOnce(initial)
      .mockResolvedValueOnce(latest);
    prisma.managedGiveawayEntry.upsert.mockResolvedValue(savedEntry);
    maxClient.hasChatMember.mockResolvedValueOnce(true).mockResolvedValueOnce(true);

    await service.enterGiveaway('giveaway-1', user);

    expect(maxClient.editMessageInlineKeyboard).toHaveBeenCalledWith(
      'source-1',
      'publication-1',
      null,
      expect.objectContaining({
        buttons: [[expect.objectContaining({ text: 'Участвовать · 1' })]],
      }),
      expectManagedGiveawaySendOptions({ botId: 'publication-author-bot' }),
    );
  });

  it('does not count rejected entries in the published giveaway button', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-21T10:12:30.000Z'));

    const prisma = createPrismaMock();
    const maxClient = createMaxClientMock();
    const service = new ManagedGiveawayService(
      prisma as never,
      maxClient as never,
      { invalidate: jest.fn() } as never,
      {} as never,
      createConfigMock() as never,
    );

    const initial = createGiveaway({
      description: 'Текст публикации',
      publicationMessageId: 'publication-1',
      entries: [],
    });
    const savedEntry = createEntry({
      eligibilityState: GiveawayEligibilityState.REJECTED,
      missingChannelIds: ['extra-1'],
    });
    const latest = createGiveaway({
      description: 'Текст публикации',
      publicationMessageId: 'publication-1',
      entries: [savedEntry],
    });

    prisma.managedGiveaway.findUnique
      .mockResolvedValueOnce(initial)
      .mockResolvedValueOnce(initial)
      .mockResolvedValueOnce(latest);
    prisma.managedGiveawayEntry.upsert.mockResolvedValue(savedEntry);
    maxClient.hasChatMember.mockResolvedValueOnce(true).mockResolvedValueOnce(false);

    await service.enterGiveaway('giveaway-1', user);

    expect(maxClient.editMessageInlineKeyboard).toHaveBeenCalledWith(
      'source-1',
      'publication-1',
      null,
      expect.objectContaining({
        buttons: [[expect.objectContaining({ text: 'Участвовать · 0' })]],
      }),
      expectManagedGiveawaySendOptions(),
    );
  });

  it('does not resend publication text when refreshing the published giveaway post', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-21T10:13:00.000Z'));

    const prisma = createPrismaMock();
    const maxClient = createMaxClientMock();
    const service = new ManagedGiveawayService(
      prisma as never,
      maxClient as never,
      { invalidate: jest.fn() } as never,
      {} as never,
      createConfigMock() as never,
    );

    const initial = createGiveaway({
      description: '# Жирный заголовок\n\nТекст с **акцентом**.',
      publicationMessageId: 'publication-1',
      entries: [],
    });
    const savedEntry = createEntry({
      eligibilityState: GiveawayEligibilityState.VERIFIED,
      eligibilityReason: null,
      missingChannelIds: [],
    });
    const latest = createGiveaway({
      description: '# Жирный заголовок\n\nТекст с **акцентом**.',
      publicationMessageId: 'publication-1',
      entries: [savedEntry],
    });

    prisma.managedGiveaway.findUnique
      .mockResolvedValueOnce(initial)
      .mockResolvedValueOnce(initial)
      .mockResolvedValueOnce(latest);
    prisma.managedGiveawayEntry.upsert.mockResolvedValue(savedEntry);
    maxClient.hasChatMember.mockResolvedValueOnce(true).mockResolvedValueOnce(true);

    await service.enterGiveaway('giveaway-1', user);

    expect(maxClient.editMessageInlineKeyboard).toHaveBeenCalledWith(
      'source-1',
      'publication-1',
      null,
      expect.not.objectContaining({
        textFormat: expect.any(String),
      }),
      expectManagedGiveawaySendOptions(),
    );
    expect(maxClient.editMessageInlineKeyboard).toHaveBeenCalledWith(
      'source-1',
      'publication-1',
      null,
      expect.objectContaining({
        buttons: [[expect.objectContaining({ text: 'Участвовать · 1' })]],
      }),
      expectManagedGiveawaySendOptions(),
    );
  });

  it('does not auto-recheck rejected entries when reading participant state', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-21T10:15:00.000Z'));

    const prisma = createPrismaMock();
    const maxClient = createMaxClientMock();
    const service = new ManagedGiveawayService(
      prisma as never,
      maxClient as never,
      { invalidate: jest.fn() } as never,
      {} as never,
      createConfigMock() as never,
    );

    const giveaway = createGiveaway({
      entries: [createEntry()],
    });
    prisma.managedGiveaway.findUnique
      .mockResolvedValueOnce(giveaway)
      .mockResolvedValueOnce(giveaway);

    const result = await service.getGiveawayParticipantState('giveaway-1', user);

    expect(maxClient.hasChatMember).not.toHaveBeenCalled();
    expect(result.eligibilityState).toBe('REJECTED');
    expect(result.missingChannelIds).toEqual(['extra-1']);
  });

  it('scopes participant claim bot url to the giveaway source bot', async () => {
    const prisma = createPrismaMock();
    const maxClient = createMaxClientMock();
    const maxBotLinkService = createMaxBotLinkMock({ resolvedBotId: '888000_bot' });
    const service = new ManagedGiveawayService(
      prisma as never,
      maxClient as never,
      { invalidate: jest.fn() } as never,
      {} as never,
      createConfigMock() as never,
      undefined,
      maxBotLinkService as never,
    );
    const entry = createEntry({
      id: 'entry-claim-1',
      userId: 'user-1',
      eligibilityState: GiveawayEligibilityState.VERIFIED,
      eligibilityReason: null,
      missingChannelIds: [],
    });
    const winner = createWinner({
      id: 'winner-claim-1',
      entryId: entry.id,
      entry,
      status: ManagedGiveawayWinnerStatus.SELECTED,
    });
    const giveaway = createGiveaway({
      publicationMessageId: 'publication-1',
      publishedAt: new Date('2026-03-21T10:30:00.000Z'),
      entries: [entry],
      prizes: [winner.prize],
      winners: [winner],
    });
    prisma.managedGiveaway.findUnique.mockResolvedValue(giveaway);

    const result = await service.getGiveawayParticipantState('giveaway-1', user);

    expect(result.canClaim).toBe(true);
    expect(result.claimBotUrl).toContain('https://max.ru/888000_bot?start=');
    expect(maxBotLinkService.buildBotStartUrlSync).toHaveBeenCalledWith(
      expect.any(String),
      '888000_bot',
    );
  });

  it('does not expose an unpublished draft through the public giveaway endpoint', async () => {
    const prisma = createPrismaMock();
    const service = new ManagedGiveawayService(
      prisma as never,
      createMaxClientMock() as never,
      { invalidate: jest.fn() } as never,
      {} as never,
      createConfigMock() as never,
    );

    prisma.managedGiveaway.findUnique.mockResolvedValueOnce(
      createGiveaway({
        status: ManagedGiveawayStatus.DRAFT,
        publishedAt: null,
        publicationMessageId: null,
        publicationUrl: null,
      }),
    );

    await expect(service.getPublicGiveaway('giveaway-1', user)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('exposes only non-rejected entries in the public giveaway count', async () => {
    const prisma = createPrismaMock();
    const service = new ManagedGiveawayService(
      prisma as never,
      createMaxClientMock() as never,
      { invalidate: jest.fn() } as never,
      {} as never,
      createConfigMock() as never,
    );

    const giveaway = createGiveaway({
      publicationMessageId: 'publication-1',
      requiredChannelIds: [],
      prizes: [createPrize()],
      entries: [
        createEntry({
          id: 'entry-verified-1',
          userId: 'verified-1',
          eligibilityState: GiveawayEligibilityState.VERIFIED,
          eligibilityReason: null,
          missingChannelIds: [],
        }),
        createEntry({
          id: 'entry-rejected-1',
          userId: 'rejected-1',
          eligibilityState: GiveawayEligibilityState.REJECTED,
        }),
      ],
    });
    prisma.managedGiveaway.findUnique.mockResolvedValue(giveaway);

    await expect(service.getPublicGiveaway('giveaway-1', user)).resolves.toMatchObject({
      entriesCount: 1,
    });
  });

  it.each([ChatEntityType.CHAT, ChatEntityType.CHANNEL])(
    'returns the source avatar from the existing %s snapshot lookup',
    async (entityType) => {
      const prisma = createPrismaMock();
      const maxClient = createMaxClientMock();
      const service = new ManagedGiveawayService(
        prisma as never,
        maxClient as never,
        { invalidate: jest.fn() } as never,
        {} as never,
        createConfigMock() as never,
      );
      const giveaway = createGiveaway({
        entityType,
        publicationMessageId: 'publication-1',
        requiredChannelIds: [],
      });
      prisma.managedGiveaway.findUnique.mockResolvedValue(giveaway);
      maxClient.getChatSnapshot.mockResolvedValue({
        link: 'https://max.ru/source',
        avatarUrl: 'https://cdn.example.com/source.jpg',
      });

      await expect(service.getPublicGiveaway('giveaway-1', user)).resolves.toMatchObject({
        sourceLink: 'https://max.ru/source',
        sourceAvatarUrl: 'https://cdn.example.com/source.jpg',
      });
      expect(maxClient.getChatSnapshot).toHaveBeenCalledTimes(1);
      expect(maxClient.getChatSnapshot).toHaveBeenCalledWith(
        giveaway.sourceChatId,
        expect.objectContaining({ sourceTag: MAX_API_SOURCE_TAGS.MANAGED_GIVEAWAY }),
      );
    },
  );

  it('loads every giveaway condition through its own bot read route', async () => {
    const prisma = createPrismaMock();
    const maxClient = createMaxClientMock();
    const botByChatId: Record<string, string> = {
      'source-1': 'bot-source',
      'extra-1': 'bot-extra',
      'extra-2': 'bot-other',
    };
    const maxBotLinkService = {
      ...createMaxBotLinkMock(),
      resolveBotRoute: jest.fn(async ({ chatId }: { chatId: string }) => ({
        purpose: 'read',
        chatId,
        primaryBotId: botByChatId[chatId],
        botId: botByChatId[chatId],
        candidateBotIds: [botByChatId[chatId]],
        reason: 'primary_confirmed',
      })),
    };
    const service = new ManagedGiveawayService(
      prisma as never,
      maxClient as never,
      { invalidate: jest.fn() } as never,
      {} as never,
      createConfigMock() as never,
      undefined,
      maxBotLinkService as never,
    );
    prisma.managedGiveaway.findUnique.mockResolvedValue(
      createGiveaway({
        publicationMessageId: 'publication-1',
        requiredChannelIds: ['extra-1', 'source-1', 'extra-2', 'extra-1'],
      }),
    );
    maxClient.getChatSnapshot.mockImplementation(
      async (chatId: string, options: { botId?: string }) => {
        if (options.botId !== botByChatId[chatId]) {
          throw createMaxApiError(403, 'Bot has no access to this chat', 'access.denied');
        }
        return { title: chatId, link: `https://max.ru/join/${chatId}`, avatarUrl: null };
      },
    );

    const result = await service.getPublicGiveaway('giveaway-1', user);

    expect(result.sourceLink).toBe('https://max.ru/join/source-1');
    expect(result.requiredChannels).toEqual([
      { id: 'extra-1', title: 'Основной канал', link: 'https://max.ru/join/extra-1' },
      { id: 'extra-2', title: 'Основной канал', link: 'https://max.ru/join/extra-2' },
    ]);
    expect(maxClient.getChatSnapshot).toHaveBeenCalledTimes(3);
    for (const [chatId, botId] of Object.entries(botByChatId)) {
      expect(maxClient.getChatSnapshot).toHaveBeenCalledWith(
        chatId,
        expect.objectContaining({
          botId,
          sourceTag: MAX_API_SOURCE_TAGS.MANAGED_GIVEAWAY,
          timeoutMs: 2500,
        }),
      );
    }
    expect(maxClient.getChatTitle).not.toHaveBeenCalled();
    expect(maxClient.hasChatMember).not.toHaveBeenCalled();
    expect(maxBotLinkService.resolveBotId).not.toHaveBeenCalled();
  });

  it('reuses condition snapshots for missing local titles without extra MAX reads', async () => {
    const prisma = createPrismaMock();
    const maxClient = createMaxClientMock();
    const maxBotLinkService = createMaxBotLinkMock({ resolvedBotId: 'bot-extra' });
    const service = new ManagedGiveawayService(
      prisma as never,
      maxClient as never,
      { invalidate: jest.fn() } as never,
      {} as never,
      createConfigMock() as never,
      undefined,
      maxBotLinkService as never,
    );
    prisma.chat.findUnique.mockImplementation(async ({ where }: { where: { id: string } }) =>
      where.id === 'source-1' ? { title: 'Основной канал' } : null,
    );
    prisma.managedGiveaway.findUnique.mockResolvedValue(
      createGiveaway({ publicationMessageId: 'publication-1' }),
    );
    maxClient.getChatSnapshot.mockImplementation(async (chatId: string) => ({
      title: ' Дополнительная группа ',
      link: ` https://max.ru/join/${chatId} `,
      avatarUrl: null,
    }));

    const result = await service.getPublicGiveaway('giveaway-1', user);

    expect(result.requiredChannels).toEqual([
      { id: 'extra-1', title: 'Дополнительная группа', link: 'https://max.ru/join/extra-1' },
    ]);
    expect(maxClient.getChatSnapshot).toHaveBeenCalledTimes(2);
    expect(maxClient.getChatSnapshot).toHaveBeenCalledWith(
      'extra-1',
      expect.objectContaining({ botId: 'bot-extra' }),
    );
    expect(maxClient.getChatTitle).not.toHaveBeenCalled();
  });

  it('does not use a launch or persisted bot when a condition has no safe read route', async () => {
    const prisma = createPrismaMock();
    const maxClient = createMaxClientMock();
    const maxBotLinkService = {
      ...createMaxBotLinkMock(),
      resolveBotRoute: jest.fn(async ({ chatId }: { chatId: string }) => ({
        purpose: 'read',
        chatId,
        primaryBotId: null,
        botId: chatId === 'source-1' ? 'bot-source' : null,
        candidateBotIds: chatId === 'source-1' ? ['bot-source'] : [],
        reason: null,
      })),
    };
    const service = new ManagedGiveawayService(
      prisma as never,
      maxClient as never,
      { invalidate: jest.fn() } as never,
      {} as never,
      createConfigMock() as never,
      undefined,
      maxBotLinkService as never,
    );
    prisma.chat.findUnique.mockResolvedValue({
      title: 'Сохранённое название',
      primaryBotId: 'dormant-bot',
      botId: 'dormant-bot',
    });
    prisma.managedGiveaway.findUnique.mockResolvedValue(
      createGiveaway({ publicationMessageId: 'publication-1' }),
    );
    maxClient.getChatSnapshot.mockResolvedValue({
      title: 'Источник',
      link: 'https://max.ru/source',
      avatarUrl: null,
    });

    const result = await service.getPublicGiveaway('giveaway-1', user);

    expect(result.requiredChannels).toEqual([
      { id: 'extra-1', title: 'Сохранённое название', link: null },
    ]);
    expect(maxClient.getChatSnapshot).toHaveBeenCalledTimes(1);
    expect(maxClient.getChatSnapshot).toHaveBeenCalledWith(
      'source-1',
      expect.objectContaining({ botId: 'bot-source' }),
    );
    expect(maxBotLinkService.resolveBotIdForRead).not.toHaveBeenCalled();
    expect(maxBotLinkService.resolveBotId).not.toHaveBeenCalled();
  });

  it.each(['snapshot-unavailable', 'route-unavailable', 'no-link'])(
    'isolates a %s condition without losing other links or checking membership',
    async (mode) => {
      const prisma = createPrismaMock();
      const maxClient = createMaxClientMock();
      const maxBotLinkService = createMaxBotLinkMock();
      maxBotLinkService.resolveBotIdForRead.mockImplementation(async ({ chatId }) => {
        if (chatId === 'extra-1' && mode === 'route-unavailable') {
          throw new Error('Route unavailable');
        }
        return 'bot-source';
      });
      const service = new ManagedGiveawayService(
        prisma as never,
        maxClient as never,
        { invalidate: jest.fn() } as never,
        {} as never,
        createConfigMock() as never,
        undefined,
        maxBotLinkService as never,
      );
      prisma.chat.findUnique.mockImplementation(async ({ where }: { where: { id: string } }) =>
        where.id === 'extra-1' ? null : { title: 'Название' },
      );
      prisma.managedGiveaway.findUnique.mockResolvedValue(
        createGiveaway({
          publicationMessageId: 'publication-1',
          requiredChannelIds: ['extra-1', 'extra-2'],
        }),
      );
      maxClient.getChatSnapshot.mockImplementation(async (chatId: string) => {
        if (chatId === 'extra-1' && mode === 'snapshot-unavailable') {
          throw createMaxApiError(503, 'Unavailable');
        }
        return {
          title: null,
          link: chatId === 'extra-1' ? null : `https://max.ru/join/${chatId}`,
          avatarUrl: null,
        };
      });

      const result = await service.getPublicGiveaway('giveaway-1', user);

      expect(result.sourceLink).toBe('https://max.ru/join/source-1');
      expect(result.requiredChannels).toEqual([
        { id: 'extra-1', title: 'Chat extra-1', link: null },
        { id: 'extra-2', title: 'Название', link: 'https://max.ru/join/extra-2' },
      ]);
      expect(maxClient.getChatSnapshot).toHaveBeenCalledTimes(mode === 'route-unavailable' ? 2 : 3);
      expect(maxClient.getChatTitle).not.toHaveBeenCalled();
      expect(maxClient.hasChatMember).not.toHaveBeenCalled();
      expect(prisma.managedGiveawayEntry.upsert).not.toHaveBeenCalled();
    },
  );

  it('bounds metadata concurrency across the source and required groups while preserving order', async () => {
    const prisma = createPrismaMock();
    const maxClient = createMaxClientMock();
    const service = new ManagedGiveawayService(
      prisma as never,
      maxClient as never,
      { invalidate: jest.fn() } as never,
      {} as never,
      createConfigMock() as never,
      undefined,
      createMaxBotLinkMock() as never,
    );
    const requiredChannelIds = Array.from({ length: 11 }, (_, index) => `extra-${index + 1}`);
    prisma.managedGiveaway.findUnique.mockResolvedValue(
      createGiveaway({ publicationMessageId: 'publication-1', requiredChannelIds }),
    );
    let active = 0;
    let peakActive = 0;
    maxClient.getChatSnapshot.mockImplementation(async (chatId: string) => {
      active += 1;
      peakActive = Math.max(peakActive, active);
      await new Promise<void>((resolve) => setImmediate(resolve));
      active -= 1;
      return { title: chatId, link: `https://max.ru/join/${chatId}`, avatarUrl: null };
    });

    const result = await service.getPublicGiveaway('giveaway-1', user);

    expect(peakActive).toBe(4);
    expect(active).toBe(0);
    expect(maxClient.getChatSnapshot).toHaveBeenCalledTimes(12);
    expect(result.requiredChannels.map(({ id }) => id)).toEqual(requiredChannelIds);
    expect(result.requiredChannels.every(({ link }) => Boolean(link))).toBe(true);
  });

  it.each(['no-photo', 'unavailable'])(
    'keeps a %s source usable without an avatar',
    async (mode) => {
      const prisma = createPrismaMock();
      const maxClient = createMaxClientMock();
      const service = new ManagedGiveawayService(
        prisma as never,
        maxClient as never,
        { invalidate: jest.fn() } as never,
        {} as never,
        createConfigMock() as never,
      );
      prisma.managedGiveaway.findUnique.mockResolvedValue(
        createGiveaway({ publicationMessageId: 'publication-1', requiredChannelIds: [] }),
      );
      if (mode === 'unavailable')
        maxClient.getChatSnapshot.mockRejectedValue(new Error('Unavailable'));
      else
        maxClient.getChatSnapshot.mockResolvedValue({
          link: 'https://max.ru/source',
          avatarUrl: null,
        });

      await expect(service.getPublicGiveaway('giveaway-1', user)).resolves.toMatchObject({
        sourceTitle: 'Основной канал',
        sourceAvatarUrl: null,
      });
    },
  );

  it('does not let a stale giveaway read route overwrite the persisted primary bot', async () => {
    const prisma = createPrismaMock();
    const maxBotLinkService = createMaxBotLinkMock({ resolvedBotId: 'stale-read-bot' });
    const service = new ManagedGiveawayService(
      prisma as never,
      createMaxClientMock() as never,
      { invalidate: jest.fn() } as never,
      {} as never,
      createConfigMock() as never,
      undefined,
      maxBotLinkService as never,
    );
    prisma.managedGiveaway.findUnique.mockResolvedValue(
      createGiveaway({ publicationMessageId: 'publication-1' }),
    );

    await service.getPublicGiveaway('giveaway-1', user);

    const upsert = prisma.chat.upsert.mock.calls[0]?.[0];
    expect(upsert?.create).toEqual(
      expect.objectContaining({
        botId: 'stale-read-bot',
        primaryBotId: 'stale-read-bot',
      }),
    );
    expect(upsert?.update).not.toHaveProperty('botId');
    expect(upsert?.update).not.toHaveProperty('primaryBotId');
  });

  it('rejects participation for an unpublished giveaway id', async () => {
    const prisma = createPrismaMock();
    const service = new ManagedGiveawayService(
      prisma as never,
      createMaxClientMock() as never,
      { invalidate: jest.fn() } as never,
      {} as never,
      createConfigMock() as never,
    );

    prisma.managedGiveaway.findUnique.mockResolvedValueOnce(
      createGiveaway({
        status: ManagedGiveawayStatus.CANCELED,
        publishedAt: null,
        publicationMessageId: null,
        publicationUrl: null,
        resultsMessageId: null,
        resultsUrl: null,
      }),
    );

    await expect(service.enterGiveaway('giveaway-1', user)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('falls back to the full mandatory list for legacy rejected entries without missingChannelIds', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-21T10:20:00.000Z'));

    const prisma = createPrismaMock();
    const maxClient = createMaxClientMock();
    const service = new ManagedGiveawayService(
      prisma as never,
      maxClient as never,
      { invalidate: jest.fn() } as never,
      {} as never,
      createConfigMock() as never,
    );

    const giveaway = createGiveaway({
      requiredChannelIds: ['extra-1', 'extra-2'],
      entries: [
        createEntry({
          missingChannelIds: [],
          eligibilityReason: 'Подписка на обязательные чаты/каналы не подтверждена.',
        }),
      ],
    });
    prisma.managedGiveaway.findUnique
      .mockResolvedValueOnce(giveaway)
      .mockResolvedValueOnce(giveaway);

    const result = await service.getGiveawayParticipantState('giveaway-1', user);

    expect(result.missingChannelIds).toEqual(['source-1', 'extra-1', 'extra-2']);
  });

  it('publishes giveaway results as a linked reply to the original post', async () => {
    const prisma = createPrismaMock();
    const maxClient = createMaxClientMock();
    const service = new ManagedGiveawayService(
      prisma as never,
      maxClient as never,
      { invalidate: jest.fn() } as never,
      {} as never,
      createConfigMock() as never,
    );

    const giveaway = createGiveaway({
      status: ManagedGiveawayStatus.COMPLETED,
      publicationMessageId: 'publication-1',
      publicationUrl: 'https://max.ru/channels/source-1/messages/publication-1',
      winners: [createWinner({ status: ManagedGiveawayWinnerStatus.CLAIMED })],
    });

    maxClient.sendMessageImmediateWithResolvedLink.mockResolvedValue({
      messageId: 'results-1',
      url: 'https://max.ru/channels/source-1/messages/results-1',
    });

    const resultsConfirmed = await (service as any).republishGiveawayResults(giveaway);

    expect(resultsConfirmed).toBe(true);
    expect(maxClient.sendMessageImmediateWithResolvedLink).toHaveBeenCalledWith(
      'source-1',
      expect.stringContaining('🏆 Победитель:\n\n1. [CEO](max://user/winner-1)'),
      expect.objectContaining({
        textFormat: 'markdown',
        messageLink: {
          type: 'reply',
          mid: 'publication-1',
        },
        buttons: [[expect.objectContaining({ text: 'Проверить результаты' })]],
      }),
      expectManagedGiveawaySendOptions(),
    );
    expect(prisma.managedGiveaway.update).toHaveBeenCalledWith({
      where: { id: 'giveaway-1' },
      data: {
        resultsMessageId: 'results-1',
        resultsBotId: null,
        resultsUrl: 'https://max.ru/channels/source-1/messages/results-1',
        lockedAt: null,
        sendLockKey: null,
      },
    });
  });

  it('keeps the channel CTA before the results action on send and edit', async () => {
    const prisma = createPrismaMock();
    const maxClient = createMaxClientMock();
    const signatureService = {
      preparePostText: jest.fn(async (_chatId: string, payload: Record<string, unknown>) => ({
        ...payload,
        signatureApplied: false,
      })),
      buildPostButton: jest.fn().mockResolvedValue({
        type: 'link',
        text: '📞 Заказать рекламу',
        url: 'https://ads.example/contact',
      }),
    };
    const service = new ManagedGiveawayService(
      prisma as never,
      maxClient as never,
      { invalidate: jest.fn() } as never,
      {} as never,
      createConfigMock() as never,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      signatureService as never,
    );
    const giveaway = createGiveaway({
      status: ManagedGiveawayStatus.COMPLETED,
      publicationMessageId: 'publication-1',
      winners: [createWinner({ status: ManagedGiveawayWinnerStatus.CLAIMED })],
    });
    maxClient.sendMessageImmediateWithResolvedLink.mockResolvedValue({
      messageId: 'results-with-cta',
      url: null,
    });

    await (service as any).republishGiveawayResults(giveaway);

    expect(maxClient.sendMessageImmediateWithResolvedLink.mock.calls[0]?.[2]?.buttons).toEqual([
      [expect.objectContaining({ text: '📞 Заказать рекламу' })],
      [expect.objectContaining({ text: 'Проверить результаты' })],
    ]);

    maxClient.editMessageInlineKeyboard.mockResolvedValue(undefined);
    await (service as any).republishGiveawayResults({
      ...giveaway,
      resultsMessageId: 'results-with-cta',
    });
    expect(maxClient.editMessageInlineKeyboard.mock.calls.at(-1)?.[3]?.buttons).toEqual([
      [expect.objectContaining({ text: '📞 Заказать рекламу' })],
      [expect.objectContaining({ text: 'Проверить результаты' })],
    ]);
  });

  it('stores and uses the persisted publication bot when publishing giveaway results', async () => {
    const prisma = createPrismaMock();
    const maxClient = createMaxClientMock();
    const maxBotLinkService = createMaxBotLinkMock({ resolvedBotId: 'current-route-bot' });
    const service = new ManagedGiveawayService(
      prisma as never,
      maxClient as never,
      { invalidate: jest.fn() } as never,
      {} as never,
      createConfigMock() as never,
      undefined,
      maxBotLinkService as never,
    );

    const giveaway = createGiveaway({
      status: ManagedGiveawayStatus.COMPLETED,
      publicationMessageId: 'publication-1',
      publicationBotId: 'publication-author-bot',
      publicationUrl: 'https://max.ru/channels/source-1/messages/publication-1',
      winners: [createWinner({ status: ManagedGiveawayWinnerStatus.CLAIMED })],
    });

    maxClient.sendMessageImmediateWithResolvedLink.mockResolvedValue({
      messageId: 'results-1',
      url: 'https://max.ru/channels/source-1/messages/results-1',
    });

    await (service as any).republishGiveawayResults(giveaway);

    expect(maxClient.sendMessageImmediateWithResolvedLink).toHaveBeenCalledWith(
      'source-1',
      expect.stringContaining('🏆 Победитель:'),
      expect.objectContaining({
        messageLink: {
          type: 'reply',
          mid: 'publication-1',
        },
      }),
      expectManagedGiveawaySendOptions({ botId: 'publication-author-bot' }),
    );
    expect(prisma.managedGiveaway.update).toHaveBeenCalledWith({
      where: { id: 'giveaway-1' },
      data: {
        resultsMessageId: 'results-1',
        resultsBotId: 'publication-author-bot',
        resultsUrl: 'https://max.ru/channels/source-1/messages/results-1',
        lockedAt: null,
        sendLockKey: null,
      },
    });
  });

  it('persists the routed dispatch bot when recovering a completed giveaway results send', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-21T13:00:00.000Z'));

    const prisma = createPrismaMock();
    const maxClient = createMaxClientMock();
    const maxRoutedPublicationService = {
      publish: jest.fn(),
    };
    const maxActionLedgerService = {
      getCompletedSendDispatchResult: jest.fn().mockResolvedValue({
        remoteMessageId: 'results-recovered-1',
        dispatchBotId: 'dispatch-bot-2',
      }),
      assertCanEnqueue: jest.fn(),
    };
    maxClient.resolveMessageLink.mockResolvedValue(
      'https://max.ru/channels/source-1/messages/results-recovered-1',
    );
    const service = new ManagedGiveawayService(
      prisma as never,
      maxClient as never,
      { invalidate: jest.fn() } as never,
      {} as never,
      createConfigMock() as never,
      undefined,
      createMaxBotLinkMock({ resolvedBotId: 'stale-queued-bot' }) as never,
      undefined,
      undefined,
      maxRoutedPublicationService as never,
      maxActionLedgerService as never,
    );
    const giveaway = createGiveaway({
      status: ManagedGiveawayStatus.COMPLETED,
      publicationMessageId: 'publication-1',
      publicationBotId: 'stale-queued-bot',
      publicationUrl: 'https://max.ru/channels/source-1/messages/publication-1',
      lockedAt: new Date('2026-03-21T12:58:00.000Z'),
      sendLockKey: 'managed-giveaway:results:giveaway-1',
      winners: [createWinner({ status: ManagedGiveawayWinnerStatus.CLAIMED })],
    });

    const resultsConfirmed = await (service as any).republishGiveawayResults(giveaway);

    expect(resultsConfirmed).toBe(true);
    expect(maxActionLedgerService.getCompletedSendDispatchResult).toHaveBeenCalledWith(
      expect.objectContaining({
        actionType: 'SEND_MESSAGE',
        chatId: 'source-1',
        idempotencyKey: 'managed-giveaway:results:giveaway-1',
      }),
    );
    expect(maxActionLedgerService.assertCanEnqueue).not.toHaveBeenCalled();
    expect(maxRoutedPublicationService.publish).not.toHaveBeenCalled();
    expect(maxClient.sendMessageImmediateWithResolvedLink).not.toHaveBeenCalled();
    expect(maxClient.editMessageInlineKeyboard).toHaveBeenCalledWith(
      'source-1',
      'results-recovered-1',
      expect.stringContaining('🏆 Победитель:'),
      expect.objectContaining({ textFormat: 'markdown' }),
      expectManagedGiveawaySendOptions({ botId: 'dispatch-bot-2' }),
    );
    expect(prisma.managedGiveaway.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'giveaway-1',
        resultsMessageId: null,
        lockedAt: new Date('2026-03-21T12:58:00.000Z'),
        sendLockKey: 'managed-giveaway:results:giveaway-1',
      },
      data: {
        resultsMessageId: 'results-recovered-1',
        resultsBotId: 'dispatch-bot-2',
        resultsUrl: 'https://max.ru/channels/source-1/messages/results-recovered-1',
        lockedAt: null,
        sendLockKey: null,
      },
    });
    expect(prisma.managedGiveaway.update).not.toHaveBeenCalled();
  });

  it('quarantines giveaway results after an ambiguous MAX send timeout', async () => {
    const prisma = createPrismaMock();
    const maxClient = createMaxClientMock();
    const managedEntityAccessLossService = createManagedEntityAccessLossMock();
    const service = new ManagedGiveawayService(
      prisma as never,
      maxClient as never,
      { invalidate: jest.fn() } as never,
      {} as never,
      createConfigMock() as never,
      undefined,
      createMaxBotLinkMock() as never,
      managedEntityAccessLossService as never,
    );
    const timeoutError = new Error('request timed out before response body arrived');
    const giveaway = createGiveaway({
      status: ManagedGiveawayStatus.COMPLETED,
      publicationMessageId: 'publication-1',
      publicationUrl: 'https://max.ru/channels/source-1/messages/publication-1',
      winners: [createWinner({ status: ManagedGiveawayWinnerStatus.CLAIMED })],
    });
    prisma.managedGiveaway.updateMany.mockResolvedValue({ count: 1 });
    maxClient.sendMessageImmediateWithResolvedLink.mockRejectedValue(timeoutError);

    const resultsConfirmed = await (service as any).republishGiveawayResults(giveaway);

    expect(resultsConfirmed).toBe(false);
    expect(maxClient.sendMessageImmediateWithResolvedLink).toHaveBeenCalledTimes(1);
    expect(prisma.managedGiveaway.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: 'giveaway-1',
          resultsMessageId: null,
          lockedAt: null,
        },
        data: {
          lockedAt: expect.any(Date),
          sendLockKey: null,
        },
      }),
    );
    expect(prisma.managedGiveaway.updateMany).not.toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ lockedAt: null }),
      }),
    );
    expect(prisma.managedGiveaway.update).not.toHaveBeenCalled();
    expect(managedEntityAccessLossService.recordIfManagedEntityAccessLost).not.toHaveBeenCalled();

    maxClient.sendMessageImmediateWithResolvedLink.mockClear();
    await (service as any).republishGiveawayResults({
      ...giveaway,
      lockedAt: new Date('2026-03-21T12:40:00.000Z'),
    });

    expect(maxClient.sendMessageImmediateWithResolvedLink).not.toHaveBeenCalled();
  });

  it('records MAX access loss when publishing giveaway results is denied', async () => {
    const maxSendAttemptStartedAt = new Date('2026-08-20T12:00:00.123Z');
    jest.useFakeTimers().setSystemTime(maxSendAttemptStartedAt);
    const prisma = createPrismaMock();
    const maxClient = createMaxClientMock();
    const maxBotLinkService = createMaxBotLinkMock();
    const managedEntityAccessLossService = createManagedEntityAccessLossMock();
    const service = new ManagedGiveawayService(
      prisma as never,
      maxClient as never,
      { invalidate: jest.fn() } as never,
      {} as never,
      createConfigMock() as never,
      undefined,
      maxBotLinkService as never,
      managedEntityAccessLossService as never,
    );
    const error = createMaxApiError(403, 'Request failed with status code 403', 'chat.denied');
    const giveaway = createGiveaway({
      status: ManagedGiveawayStatus.COMPLETED,
      publicationMessageId: 'publication-1',
      publicationUrl: 'https://max.ru/channels/source-1/messages/publication-1',
      winners: [createWinner({ status: ManagedGiveawayWinnerStatus.CLAIMED })],
    });
    maxClient.sendMessageImmediateWithResolvedLink.mockRejectedValue(error);
    managedEntityAccessLossService.recordIfManagedEntityAccessLost.mockResolvedValue({
      classification: {
        kind: 'managed_entity_access_lost',
        reason: 'bot_denied',
        statusCode: 403,
        code: 'chat.denied',
        message: 'request failed with status code 403',
      },
      reason: 'bot_denied',
      recorded: {
        chatId: 'source-1',
        botId: 'id613002203036_4_bot',
        nextOwnerBotId: null,
        updatedAccessEdges: 1,
        cleanup: {
          nightModeJobsCleared: false,
          canceledBroadcasts: 0,
          canceledBroadcastDeliveries: 0,
          canceledBroadcastOccurrences: 0,
          clearedVkPublishPosts: 0,
          pausedVkSources: 0,
          removedRosterSyncJobs: 0,
        },
      },
    });

    await (service as any).republishGiveawayResults(giveaway);

    expect(managedEntityAccessLossService.recordIfManagedEntityAccessLost).toHaveBeenCalledWith({
      chatId: 'source-1',
      botId: 'id613002203036_4_bot',
      entityType: ChatEntityType.CHANNEL,
      source: 'managed_giveaway:results',
      operation: 'send',
      error,
      lifecycleEventAt: maxSendAttemptStartedAt,
      lifecycleEventType: 'live_probe',
      lifecycleSource: 'live_probe',
    });
    expect(prisma.managedGiveaway.update).not.toHaveBeenCalled();
  });

  it('publishes giveaway text with markdown format when the bot draft contains markup', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-21T12:30:00.000Z'));

    const prisma = createPrismaMock();
    const maxClient = createMaxClientMock();
    const chatContextCache = { invalidate: jest.fn() };
    const adminService = {
      getChannelSettings: jest.fn().mockResolvedValue({}),
      getSettings: jest.fn().mockResolvedValue({}),
    };
    const service = new ManagedGiveawayService(
      prisma as never,
      maxClient as never,
      chatContextCache as never,
      adminService as never,
      createConfigMock() as never,
    );

    const draft = createGiveaway({
      status: ManagedGiveawayStatus.DRAFT,
      description:
        '# Жирный заголовок\n\nТекст с **акцентом**, _курсивом_ и [ссылкой](https://max.ru/).',
      entries: [],
      winners: [],
    });
    const published = createGiveaway({
      ...draft,
      status: ManagedGiveawayStatus.ACTIVE,
      publicationMessageId: 'publication-1',
      publicationUrl: 'https://max.ru/channels/source-1/messages/publication-1',
      publishedAt: new Date('2026-03-21T12:30:00.000Z'),
    });

    prisma.managedGiveaway.findFirst.mockResolvedValueOnce(draft).mockResolvedValueOnce(null);
    prisma.managedGiveaway.update.mockResolvedValue(published);
    maxClient.sendMessageImmediateWithResolvedLink.mockResolvedValue({
      messageId: 'publication-1',
      url: 'https://max.ru/channels/source-1/messages/publication-1',
    });

    await service.publishManagedGiveaway('source-1', 'giveaway-1', user as never, 'channel');

    expect(maxClient.sendMessageImmediateWithResolvedLink).toHaveBeenCalledWith(
      'source-1',
      '<h1>Жирный заголовок</h1><p>Текст с <strong>акцентом</strong>, <em>курсивом</em> и <a href="https://max.ru/">ссылкой</a>.</p>',
      expect.objectContaining({
        textFormat: 'html',
        buttons: [[expect.objectContaining({ text: 'Участвовать · 0' })]],
      }),
      expectManagedGiveawaySendOptions(),
    );
    expect(prisma.managedGiveaway.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'giveaway-1' },
        data: expect.objectContaining({
          status: ManagedGiveawayStatus.ACTIVE,
          publicationMessageId: 'publication-1',
        }),
      }),
    );
    expect(chatContextCache.invalidate).toHaveBeenCalledWith('source-1');
  });

  it('prepares giveaway publication media for the routed bot and persists the actual sender', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-21T12:31:00.000Z'));

    const prisma = createPrismaMock();
    const maxClient = createMaxClientMock();
    const chatContextCache = { invalidate: jest.fn() };
    const maxBotLinkService = createMaxBotLinkMock({
      resolvedBotId: 'route-primary-bot',
      entryBotId: 'entry-bot',
    });
    const maxRoutedPublicationService = {
      publish: jest.fn().mockImplementation(async (request: any) => {
        const prepared = await request.prepareAttempt({
          botId: 'route-survivor-bot',
          job: {},
        });
        expect(prepared.options).toEqual(
          expect.objectContaining({
            imagePayload: { token: 'route-survivor-upload' },
            buttons: [[expect.objectContaining({ text: 'Участвовать · 0' })]],
          }),
        );
        request.onDispatchAttempt({ botId: 'route-survivor-bot', job: {} });
        return {
          messageId: 'publication-routed-1',
          url: 'https://max.ru/channels/source-1/messages/publication-routed-1',
          botId: 'route-survivor-bot',
          candidateBotIds: ['route-primary-bot', 'route-survivor-bot'],
          routingVersion: 15,
        };
      }),
    };
    const service = new ManagedGiveawayService(
      prisma as never,
      maxClient as never,
      chatContextCache as never,
      {
        getChannelSettings: jest.fn().mockResolvedValue({}),
        getSettings: jest.fn().mockResolvedValue({}),
      } as never,
      createConfigMock() as never,
      undefined,
      maxBotLinkService as never,
      undefined,
      undefined,
      maxRoutedPublicationService as never,
    );
    const draft = createGiveaway({
      status: ManagedGiveawayStatus.DRAFT,
      description: 'Текст routed-публикации',
      imageEnabled: true,
      imageBase64: Buffer.from('giveaway-image').toString('base64'),
      imageMimeType: 'image/png',
      imageFileName: 'giveaway.png',
    });
    const published = createGiveaway({
      ...draft,
      status: ManagedGiveawayStatus.ACTIVE,
      publicationMessageId: 'publication-routed-1',
      publicationBotId: 'route-survivor-bot',
      publicationUrl: 'https://max.ru/channels/source-1/messages/publication-routed-1',
      publishedAt: new Date('2026-03-21T12:31:00.000Z'),
    });
    prisma.managedGiveaway.findFirst.mockResolvedValueOnce(draft).mockResolvedValueOnce(null);
    prisma.managedGiveaway.update.mockResolvedValue(published);
    maxClient.uploadImage.mockResolvedValue({ token: 'route-survivor-upload' });

    await service.publishManagedGiveaway('source-1', 'giveaway-1', user as never, 'channel');

    expect(maxRoutedPublicationService.publish).toHaveBeenCalledWith(
      expect.objectContaining({
        entityId: 'source-1',
        logicalIdempotencyKey: 'managed-giveaway:publication:giveaway-1',
        text: 'Текст routed-публикации',
        trafficClass: 'interactive',
        actionHealthLane: 'interactive',
        sourceTag: MAX_API_SOURCE_TAGS.MANAGED_GIVEAWAY,
        timeoutMs: 12000,
      }),
    );
    expect(maxClient.uploadImage).toHaveBeenCalledWith(
      expect.any(Buffer),
      'giveaway.png',
      'image/png',
      expectManagedGiveawaySendOptions({
        botId: 'route-survivor-bot',
        timeoutMs: 30000,
      }),
    );
    expect(maxClient.sendMessageImmediateWithResolvedLink).not.toHaveBeenCalled();
    expect(prisma.managedGiveaway.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'giveaway-1' },
        data: expect.objectContaining({
          publicationMessageId: 'publication-routed-1',
          publicationBotId: 'route-survivor-bot',
        }),
      }),
    );
  });

  it('fails closed before a production giveaway publication when routed wiring is missing', async () => {
    const previousNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    const prisma = createPrismaMock();
    const maxClient = createMaxClientMock();
    const service = new ManagedGiveawayService(
      prisma as never,
      maxClient as never,
      { invalidate: jest.fn() } as never,
      {
        getChannelSettings: jest.fn().mockResolvedValue({}),
        getSettings: jest.fn().mockResolvedValue({}),
      } as never,
      createConfigMock() as never,
    );
    prisma.managedGiveaway.findFirst
      .mockResolvedValueOnce(
        createGiveaway({
          status: ManagedGiveawayStatus.DRAFT,
          description: 'Production giveaway',
        }),
      )
      .mockResolvedValueOnce(null);

    try {
      await expect(
        service.publishManagedGiveaway('source-1', 'giveaway-1', user as never, 'channel'),
      ).rejects.toThrow(
        'Routed MAX publication service is required for production managed giveaways',
      );
      expect(maxClient.sendMessageImmediateWithResolvedLink).not.toHaveBeenCalled();
      expect(prisma.managedGiveaway.updateMany).not.toHaveBeenCalled();
    } finally {
      process.env.NODE_ENV = previousNodeEnv;
    }
  });

  it('fails closed before a production giveaway results send when routed wiring is missing', async () => {
    const previousNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    const maxClient = createMaxClientMock();
    const service = new ManagedGiveawayService(
      createPrismaMock() as never,
      maxClient as never,
      { invalidate: jest.fn() } as never,
      {} as never,
      createConfigMock() as never,
    );

    try {
      await expect(
        (service as any).republishGiveawayResults(
          createGiveaway({
            status: ManagedGiveawayStatus.COMPLETED,
            publicationMessageId: 'publication-1',
            resultsMessageId: null,
            winners: [createWinner({ status: ManagedGiveawayWinnerStatus.CLAIMED })],
          }),
        ),
      ).rejects.toThrow(
        'Routed MAX publication service is required for production managed giveaways',
      );
      expect(maxClient.sendMessageImmediateWithResolvedLink).not.toHaveBeenCalled();
    } finally {
      process.env.NODE_ENV = previousNodeEnv;
    }
  });

  it('recovers a completed routed giveaway publication from a stale local lock', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-21T13:00:00.000Z'));

    const prisma = createPrismaMock();
    const maxClient = createMaxClientMock();
    const chatContextCache = { invalidate: jest.fn() };
    const maxRoutedPublicationService = { publish: jest.fn() };
    const maxActionLedgerService = {
      getCompletedSendDispatchResult: jest.fn().mockResolvedValue({
        remoteMessageId: 'publication-recovered-1',
        dispatchBotId: 'dispatch-bot-3',
      }),
      assertCanEnqueue: jest.fn(),
    };
    maxClient.resolveMessageLink.mockResolvedValue(
      'https://max.ru/channels/source-1/messages/publication-recovered-1',
    );
    const service = new ManagedGiveawayService(
      prisma as never,
      maxClient as never,
      chatContextCache as never,
      {
        getChannelSettings: jest.fn().mockResolvedValue({}),
        getSettings: jest.fn().mockResolvedValue({}),
      } as never,
      createConfigMock() as never,
      undefined,
      createMaxBotLinkMock() as never,
      undefined,
      undefined,
      maxRoutedPublicationService as never,
      maxActionLedgerService as never,
    );
    const staleLockAt = new Date('2026-03-21T12:58:00.000Z');
    const draft = createGiveaway({
      status: ManagedGiveawayStatus.DRAFT,
      description: 'Текст публикации',
      lockedAt: staleLockAt,
      sendLockKey: 'managed-giveaway:publication:giveaway-1',
    });
    prisma.managedGiveaway.findFirst.mockResolvedValueOnce(draft);

    const recovered = await service.publishManagedGiveaway(
      'source-1',
      'giveaway-1',
      user as never,
      'channel',
    );

    expect(recovered).toEqual(
      expect.objectContaining({
        status: ManagedGiveawayStatus.ACTIVE,
        publicationMessageId: 'publication-recovered-1',
      }),
    );
    expect(maxActionLedgerService.getCompletedSendDispatchResult).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotencyKey: 'managed-giveaway:publication:giveaway-1',
      }),
    );
    expect(maxActionLedgerService.assertCanEnqueue).not.toHaveBeenCalled();
    expect(maxRoutedPublicationService.publish).not.toHaveBeenCalled();
    expect(prisma.managedGiveaway.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'giveaway-1',
        status: ManagedGiveawayStatus.DRAFT,
        publicationMessageId: null,
        lockedAt: staleLockAt,
        sendLockKey: 'managed-giveaway:publication:giveaway-1',
      },
      data: {
        actorUserId: 'user-1',
        status: ManagedGiveawayStatus.ACTIVE,
        publicationMessageId: 'publication-recovered-1',
        publicationBotId: 'dispatch-bot-3',
        publicationUrl: 'https://max.ru/channels/source-1/messages/publication-recovered-1',
        publishedAt: new Date('2026-03-21T13:00:00.000Z'),
        lockedAt: null,
        sendLockKey: null,
      },
    });
    expect(chatContextCache.invalidate).toHaveBeenCalledWith('source-1');
  });

  it('keeps a stale routed giveaway publication quarantined when dispatch started without a remote id', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-21T13:00:00.000Z'));

    const prisma = createPrismaMock();
    const maxRoutedPublicationService = { publish: jest.fn() };
    const maxActionLedgerService = {
      getCompletedSendDispatchResult: jest.fn().mockResolvedValue(null),
      assertCanEnqueue: jest
        .fn()
        .mockRejectedValue(new Error('dispatch fence requires manual review')),
    };
    const service = new ManagedGiveawayService(
      prisma as never,
      createMaxClientMock() as never,
      { invalidate: jest.fn() } as never,
      { getChannelSettings: jest.fn().mockResolvedValue({}) } as never,
      createConfigMock() as never,
      undefined,
      createMaxBotLinkMock() as never,
      undefined,
      undefined,
      maxRoutedPublicationService as never,
      maxActionLedgerService as never,
    );
    prisma.managedGiveaway.findFirst.mockResolvedValueOnce(
      createGiveaway({
        status: ManagedGiveawayStatus.DRAFT,
        description: 'Текст публикации',
        lockedAt: new Date('2026-03-21T12:58:00.000Z'),
        sendLockKey: 'managed-giveaway:publication:giveaway-1',
      }),
    );

    await expect(
      service.publishManagedGiveaway('source-1', 'giveaway-1', user as never, 'channel'),
    ).rejects.toThrow('требует ручной проверки');

    expect(maxActionLedgerService.assertCanEnqueue).toHaveBeenCalledTimes(1);
    expect(prisma.managedGiveaway.updateMany).not.toHaveBeenCalled();
    expect(maxRoutedPublicationService.publish).not.toHaveBeenCalled();
  });

  it('releases a stale routed giveaway lock before claim and retries with the same logical key', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-21T13:00:00.000Z'));

    const prisma = createPrismaMock();
    const maxClient = createMaxClientMock();
    const maxRoutedPublicationService = {
      publish: jest.fn().mockImplementation(async (request: any) => {
        const prepared = await request.prepareAttempt({ botId: 'retry-bot-2', job: {} });
        expect(prepared.options).toEqual(
          expect.objectContaining({
            buttons: [[expect.objectContaining({ text: 'Участвовать · 0' })]],
          }),
        );
        request.onDispatchAttempt({ botId: 'retry-bot-2', job: {} });
        return {
          messageId: 'publication-retried-1',
          url: 'https://max.ru/channels/source-1/messages/publication-retried-1',
          botId: 'retry-bot-2',
          candidateBotIds: ['retry-bot-2'],
          routingVersion: 18,
        };
      }),
    };
    const maxActionLedgerService = {
      getCompletedSendDispatchResult: jest.fn().mockResolvedValue(null),
      assertCanEnqueue: jest.fn().mockResolvedValue(undefined),
    };
    const service = new ManagedGiveawayService(
      prisma as never,
      maxClient as never,
      { invalidate: jest.fn() } as never,
      { getChannelSettings: jest.fn().mockResolvedValue({}) } as never,
      createConfigMock() as never,
      undefined,
      createMaxBotLinkMock() as never,
      undefined,
      undefined,
      maxRoutedPublicationService as never,
      maxActionLedgerService as never,
    );
    const staleLockAt = new Date('2026-03-21T12:58:00.000Z');
    const draft = createGiveaway({
      status: ManagedGiveawayStatus.DRAFT,
      description: 'Текст публикации',
      lockedAt: staleLockAt,
      sendLockKey: 'managed-giveaway:publication:giveaway-1',
    });
    const published = createGiveaway({
      ...draft,
      status: ManagedGiveawayStatus.ACTIVE,
      publicationMessageId: 'publication-retried-1',
      publicationBotId: 'retry-bot-2',
      publicationUrl: 'https://max.ru/channels/source-1/messages/publication-retried-1',
      publishedAt: new Date('2026-03-21T13:00:00.000Z'),
      lockedAt: null,
      sendLockKey: null,
    });
    prisma.managedGiveaway.findFirst
      .mockResolvedValueOnce(draft)
      .mockResolvedValueOnce({ ...draft, lockedAt: null, sendLockKey: null })
      .mockResolvedValueOnce(null);
    prisma.managedGiveaway.update.mockResolvedValue(published);

    await service.publishManagedGiveaway('source-1', 'giveaway-1', user as never, 'channel');

    expect(prisma.managedGiveaway.updateMany).toHaveBeenNthCalledWith(1, {
      where: {
        id: 'giveaway-1',
        lockedAt: staleLockAt,
        sendLockKey: 'managed-giveaway:publication:giveaway-1',
        status: ManagedGiveawayStatus.DRAFT,
        publicationMessageId: null,
      },
      data: { lockedAt: null, sendLockKey: null },
    });
    expect(prisma.managedGiveaway.updateMany).toHaveBeenNthCalledWith(2, {
      where: {
        id: 'giveaway-1',
        status: ManagedGiveawayStatus.DRAFT,
        lockedAt: null,
        updatedAt: expect.any(Date),
        endsAt: { gt: expect.any(Date) },
      },
      data: {
        lockedAt: new Date('2026-03-21T13:00:00.000Z'),
        sendLockKey: 'managed-giveaway:publication:giveaway-1',
      },
    });
    expect(maxRoutedPublicationService.publish).toHaveBeenCalledWith(
      expect.objectContaining({
        logicalIdempotencyKey: 'managed-giveaway:publication:giveaway-1',
      }),
    );
  });

  it('keeps the giveaway publication locked after an ambiguous routed send', async () => {
    const prisma = createPrismaMock();
    const maxClient = createMaxClientMock();
    const maxRoutedPublicationService = {
      publish: jest.fn().mockImplementation(async (request: any) => {
        await request.prepareAttempt({ botId: 'route-bot-1', job: {} });
        request.onDispatchAttempt({ botId: 'route-bot-1', job: {} });
        throw createMaxApiError(503, 'MAX upstream unavailable');
      }),
    };
    const service = new ManagedGiveawayService(
      prisma as never,
      maxClient as never,
      { invalidate: jest.fn() } as never,
      {
        getChannelSettings: jest.fn().mockResolvedValue({}),
        getSettings: jest.fn().mockResolvedValue({}),
      } as never,
      createConfigMock() as never,
      undefined,
      createMaxBotLinkMock() as never,
      undefined,
      undefined,
      maxRoutedPublicationService as never,
    );
    const draft = createGiveaway({
      status: ManagedGiveawayStatus.DRAFT,
      description: 'Текст публикации',
    });
    prisma.managedGiveaway.findFirst.mockResolvedValueOnce(draft).mockResolvedValueOnce(null);

    await expect(
      service.publishManagedGiveaway('source-1', 'giveaway-1', user as never, 'channel'),
    ).rejects.toMatchObject({ response: { status: 503 } });

    expect(maxRoutedPublicationService.publish).toHaveBeenCalledTimes(1);
    expect(maxClient.sendMessageImmediateWithResolvedLink).not.toHaveBeenCalled();
    expect(prisma.managedGiveaway.updateMany).toHaveBeenCalledTimes(1);
    expect(prisma.managedGiveaway.update).not.toHaveBeenCalled();
  });

  it('quarantines giveaway publication after an ambiguous MAX send timeout', async () => {
    const prisma = createPrismaMock();
    const maxClient = createMaxClientMock();
    const chatContextCache = { invalidate: jest.fn() };
    const adminService = {
      getChannelSettings: jest.fn().mockResolvedValue({}),
      getSettings: jest.fn().mockResolvedValue({}),
    };
    const service = new ManagedGiveawayService(
      prisma as never,
      maxClient as never,
      chatContextCache as never,
      adminService as never,
      createConfigMock() as never,
    );
    const draft = createGiveaway({
      status: ManagedGiveawayStatus.DRAFT,
      description: 'Текст публикации',
      entries: [],
      winners: [],
    });
    const timeoutError = new Error('request timed out before response body arrived');
    prisma.managedGiveaway.findFirst.mockResolvedValueOnce(draft).mockResolvedValueOnce(null);
    prisma.managedGiveaway.updateMany.mockResolvedValue({ count: 1 });
    maxClient.sendMessageImmediateWithResolvedLink.mockRejectedValue(timeoutError);

    await expect(
      service.publishManagedGiveaway('source-1', 'giveaway-1', user as never, 'channel'),
    ).rejects.toBe(timeoutError);

    expect(maxClient.sendMessageImmediateWithResolvedLink).toHaveBeenCalledTimes(1);
    expect(prisma.managedGiveaway.updateMany).toHaveBeenCalledTimes(1);
    expect(prisma.managedGiveaway.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'giveaway-1',
        status: ManagedGiveawayStatus.DRAFT,
        lockedAt: null,
        updatedAt: expect.any(Date),
        endsAt: { gt: expect.any(Date) },
      },
      data: {
        lockedAt: expect.any(Date),
        sendLockKey: null,
      },
    });
    expect(prisma.managedGiveaway.update).not.toHaveBeenCalled();
    expect(chatContextCache.invalidate).not.toHaveBeenCalled();

    prisma.managedGiveaway.findFirst.mockResolvedValueOnce({
      ...draft,
      lockedAt: new Date('2026-03-21T12:35:00.000Z'),
    });
    await expect(
      service.publishManagedGiveaway('source-1', 'giveaway-1', user as never, 'channel'),
    ).rejects.toThrow('требует ручной проверки');
    expect(maxClient.sendMessageImmediateWithResolvedLink).toHaveBeenCalledTimes(1);
  });

  it('publishes nested bold italic underline links in giveaway text', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-21T12:30:00.000Z'));

    const prisma = createPrismaMock();
    const maxClient = createMaxClientMock();
    const chatContextCache = { invalidate: jest.fn() };
    const adminService = {
      getChannelSettings: jest.fn().mockResolvedValue({}),
      getSettings: jest.fn().mockResolvedValue({}),
    };
    const service = new ManagedGiveawayService(
      prisma as never,
      maxClient as never,
      chatContextCache as never,
      adminService as never,
      createConfigMock() as never,
    );

    const draft = createGiveaway({
      status: ManagedGiveawayStatus.DRAFT,
      description: '[**_++MAX Docs++_**](https://dev.max.ru/docs-api)',
      entries: [],
      winners: [],
    });
    const published = createGiveaway({
      ...draft,
      status: ManagedGiveawayStatus.ACTIVE,
      publicationMessageId: 'publication-1',
      publicationUrl: 'https://max.ru/channels/source-1/messages/publication-1',
      publishedAt: new Date('2026-03-21T12:30:00.000Z'),
    });

    prisma.managedGiveaway.findFirst.mockResolvedValueOnce(draft).mockResolvedValueOnce(null);
    prisma.managedGiveaway.update.mockResolvedValue(published);
    maxClient.sendMessageImmediateWithResolvedLink.mockResolvedValue({
      messageId: 'publication-1',
      url: 'https://max.ru/channels/source-1/messages/publication-1',
    });

    await service.publishManagedGiveaway('source-1', 'giveaway-1', user as never, 'channel');

    expect(maxClient.sendMessageImmediateWithResolvedLink).toHaveBeenCalledWith(
      'source-1',
      '<p><a href="https://dev.max.ru/docs-api"><strong><em><u>MAX Docs</u></em></strong></a></p>',
      expect.objectContaining({
        textFormat: 'html',
        buttons: [[expect.objectContaining({ text: 'Участвовать · 0' })]],
      }),
      expectManagedGiveawaySendOptions(),
    );
  });

  it('keeps the channel CTA before giveaway actions on publish and every status refresh', async () => {
    const prisma = createPrismaMock();
    const maxClient = createMaxClientMock();
    const signatureService = {
      preparePostText: jest.fn(async (_chatId: string, payload: Record<string, unknown>) => ({
        ...payload,
        signatureApplied: false,
      })),
      buildPostButton: jest.fn().mockResolvedValue({
        type: 'link',
        text: '📞 Заказать рекламу',
        url: 'https://ads.example/contact',
      }),
    };
    const service = new ManagedGiveawayService(
      prisma as never,
      maxClient as never,
      { invalidate: jest.fn() } as never,
      { getChannelSettings: jest.fn(), getSettings: jest.fn() } as never,
      createConfigMock() as never,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      signatureService as never,
    );
    const draft = createGiveaway({
      status: ManagedGiveawayStatus.DRAFT,
      description: 'Текст публикации',
    });
    const published = createGiveaway({
      ...draft,
      status: ManagedGiveawayStatus.ACTIVE,
      publicationMessageId: 'publication-with-cta',
      publishedAt: new Date('2026-03-21T12:30:00.000Z'),
    });
    prisma.managedGiveaway.findFirst.mockResolvedValueOnce(draft).mockResolvedValueOnce(null);
    prisma.managedGiveaway.update.mockResolvedValue(published);
    maxClient.sendMessageImmediateWithResolvedLink.mockResolvedValue({
      messageId: 'publication-with-cta',
      url: null,
    });

    await service.publishManagedGiveaway('source-1', 'giveaway-1', user as never, 'channel');

    expect(maxClient.sendMessageImmediateWithResolvedLink.mock.calls[0]?.[2]?.buttons).toEqual([
      [expect.objectContaining({ text: '📞 Заказать рекламу' })],
      [expect.objectContaining({ text: 'Участвовать · 0' })],
    ]);

    maxClient.editMessageInlineKeyboard.mockResolvedValue(undefined);
    for (const status of [
      ManagedGiveawayStatus.ACTIVE,
      ManagedGiveawayStatus.CANCELED,
      ManagedGiveawayStatus.COMPLETED,
    ]) {
      await (service as any).editGiveawayPublicationIfNeeded({ ...published, status }, status);
      const options = maxClient.editMessageInlineKeyboard.mock.calls.at(-1)?.[3];
      expect(options?.buttons).toEqual([
        [expect.objectContaining({ text: '📞 Заказать рекламу' })],
        [expect.objectContaining({ type: 'link' })],
      ]);
    }
  });

  it('uses the entry bot for giveaway mini app deep links and the source bot for publication', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-21T12:35:00.000Z'));

    const prisma = createPrismaMock();
    const maxClient = createMaxClientMock();
    const chatContextCache = { invalidate: jest.fn() };
    const adminService = {
      getChannelSettings: jest.fn().mockResolvedValue({}),
      getSettings: jest.fn().mockResolvedValue({}),
    };
    const maxBotLinkService = createMaxBotLinkMock({
      resolvedBotId: 'id613002203036_4_bot',
      entryBotId: 'entry_bot',
    });
    const service = new ManagedGiveawayService(
      prisma as never,
      maxClient as never,
      chatContextCache as never,
      adminService as never,
      createConfigMock() as never,
      undefined,
      maxBotLinkService as never,
    );

    const draft = createGiveaway({
      status: ManagedGiveawayStatus.DRAFT,
      description: 'Текст публикации',
      entries: [],
      winners: [],
    });
    const published = createGiveaway({
      ...draft,
      status: ManagedGiveawayStatus.ACTIVE,
      publicationMessageId: 'publication-1',
      publicationUrl: 'https://max.ru/channels/source-1/messages/publication-1',
      publishedAt: new Date('2026-03-21T12:35:00.000Z'),
    });

    prisma.managedGiveaway.findFirst.mockResolvedValueOnce(draft).mockResolvedValueOnce(null);
    prisma.managedGiveaway.update.mockResolvedValue(published);
    maxClient.sendMessageImmediateWithResolvedLink.mockResolvedValue({
      messageId: 'publication-1',
      url: 'https://max.ru/channels/source-1/messages/publication-1',
    });

    await service.publishManagedGiveaway('source-1', 'giveaway-1', user as never, 'channel');

    expect(maxBotLinkService.resolveBotIdForSend).toHaveBeenCalledWith({
      chatId: 'source-1',
      fallbackToPrimary: true,
    });
    expect(maxBotLinkService.resolveBotIdForRead).not.toHaveBeenCalled();
    expect(maxBotLinkService.buildEntryMiniappStartUrlSync).toHaveBeenCalledWith(
      expect.stringMatching(/^gg-/u),
    );
    expect(maxBotLinkService.buildMiniappStartUrlSync).not.toHaveBeenCalled();
    expect(maxBotLinkService.resolveContactIdSync).not.toHaveBeenCalled();
    expect(maxClient.sendMessageImmediateWithResolvedLink).toHaveBeenCalledWith(
      'source-1',
      'Текст публикации',
      expect.objectContaining({
        buttons: [
          [
            expect.objectContaining({
              type: 'link',
              text: 'Участвовать · 0',
              url: expect.stringContaining('https://max.ru/entry_bot?startapp=gg-'),
            }),
          ],
        ],
      }),
      expectManagedGiveawaySendOptions({ botId: 'id613002203036_4_bot' }),
    );
    expect(prisma.managedGiveaway.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'giveaway-1' },
        data: expect.objectContaining({
          publicationMessageId: 'publication-1',
          publicationBotId: 'id613002203036_4_bot',
        }),
      }),
    );
  });

  it('uses the active unified send route for giveaway publication instead of a stale primary', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-21T12:36:00.000Z'));

    const prisma = createPrismaMock();
    const maxClient = createMaxClientMock();
    const chatContextCache = { invalidate: jest.fn() };
    const adminService = {
      getChannelSettings: jest.fn().mockResolvedValue({}),
      getSettings: jest.fn().mockResolvedValue({}),
    };
    prisma.chat.findUnique.mockResolvedValue({
      primaryBotId: 'draining-primary-bot',
      botId: 'draining-primary-bot',
    });
    const maxBotLinkService = {
      ...createMaxBotLinkMock({
        resolvedBotId: 'active-giveaway-bot',
        entryBotId: 'active-giveaway-bot',
      }),
      resolveBotRoute: jest.fn().mockResolvedValue({
        purpose: 'send_message',
        chatId: 'source-route-1',
        primaryBotId: 'draining-primary-bot',
        botId: 'active-giveaway-bot',
        candidateBotIds: ['active-giveaway-bot'],
        reason: 'alternate_confirmed',
      }),
      resolveBotIdForSend: jest.fn().mockResolvedValue('draining-primary-bot'),
      resolveBotId: jest.fn().mockResolvedValue('draining-primary-bot'),
    };
    const service = new ManagedGiveawayService(
      prisma as never,
      maxClient as never,
      chatContextCache as never,
      adminService as never,
      createConfigMock() as never,
      undefined,
      maxBotLinkService as never,
    );

    const draft = createGiveaway({
      sourceChatId: 'source-route-1',
      status: ManagedGiveawayStatus.DRAFT,
      description: 'Текст публикации',
      entries: [],
      winners: [],
    });
    const published = createGiveaway({
      ...draft,
      status: ManagedGiveawayStatus.ACTIVE,
      publicationMessageId: 'publication-route-1',
      publicationUrl: 'https://max.ru/channels/source-route-1/messages/publication-route-1',
      publishedAt: new Date('2026-03-21T12:36:00.000Z'),
    });

    prisma.managedGiveaway.findFirst.mockResolvedValueOnce(draft).mockResolvedValueOnce(null);
    prisma.managedGiveaway.update.mockResolvedValue(published);
    maxClient.sendMessageImmediateWithResolvedLink.mockResolvedValue({
      messageId: 'publication-route-1',
      url: 'https://max.ru/channels/source-route-1/messages/publication-route-1',
    });

    await service.publishManagedGiveaway('source-route-1', 'giveaway-1', user as never, 'channel');

    expect(maxBotLinkService.resolveBotRoute).toHaveBeenCalledWith({
      purpose: 'send_message',
      chatId: 'source-route-1',
      fallbackToPrimary: true,
    });
    expect(maxBotLinkService.resolveBotIdForRead).not.toHaveBeenCalled();
    expect(maxBotLinkService.resolveBotIdForSend).not.toHaveBeenCalled();
    expect(maxBotLinkService.buildEntryMiniappStartUrlSync).toHaveBeenCalledWith(
      expect.stringMatching(/^gg-/u),
    );
    expect(maxBotLinkService.buildMiniappStartUrlSync).not.toHaveBeenCalled();
    expect(maxClient.sendMessageImmediateWithResolvedLink).toHaveBeenCalledWith(
      'source-route-1',
      'Текст публикации',
      expect.objectContaining({
        buttons: [
          [
            expect.objectContaining({
              type: 'link',
              text: 'Участвовать · 0',
              url: expect.stringContaining('https://max.ru/active-giveaway-bot?startapp=gg-'),
            }),
          ],
        ],
      }),
      expectManagedGiveawaySendOptions({ botId: 'active-giveaway-bot' }),
    );
  });

  it('does not fall back to a persisted source bot when the giveaway send route has no executable bot', async () => {
    const prisma = createPrismaMock();
    prisma.chat.findUnique.mockResolvedValue({
      primaryBotId: 'draining-bot',
      botId: 'draining-bot',
    });
    const maxBotLinkService = {
      ...createMaxBotLinkMock(),
      resolveBotRoute: jest.fn().mockResolvedValue({
        purpose: 'send_message',
        chatId: 'source-draining-1',
        primaryBotId: null,
        botId: null,
        candidateBotIds: [],
        reason: null,
      }),
      resolveBotIdForSend: jest.fn().mockResolvedValue('draining-bot'),
      resolveBotId: jest.fn().mockResolvedValue('draining-bot'),
    };
    const service = new ManagedGiveawayService(
      prisma as never,
      createMaxClientMock() as never,
      { invalidate: jest.fn() } as never,
      {} as never,
      createConfigMock() as never,
      undefined,
      maxBotLinkService as never,
    );

    await expect(
      (service as any).resolveGiveawayPublicationBotId('source-draining-1'),
    ).resolves.toBeUndefined();

    expect(maxBotLinkService.resolveBotRoute).toHaveBeenCalledWith({
      purpose: 'send_message',
      chatId: 'source-draining-1',
      fallbackToPrimary: true,
    });
    expect(maxBotLinkService.resolveBotIdForSend).not.toHaveBeenCalled();
    expect(maxBotLinkService.resolveBotId).not.toHaveBeenCalled();
    expect(prisma.chat.findUnique).not.toHaveBeenCalled();
  });

  it('does not fall back to a persisted membership lookup bot when the read route has no safe bot', async () => {
    const prisma = createPrismaMock();
    prisma.chat.findUnique.mockResolvedValue({ primaryBotId: 'dormant-bot', botId: 'dormant-bot' });
    const maxBotLinkService = {
      ...createMaxBotLinkMock(),
      resolveBotRoute: jest.fn().mockResolvedValue({
        purpose: 'read',
        chatId: 'required-dormant-1',
        primaryBotId: null,
        botId: null,
        candidateBotIds: [],
        reason: null,
      }),
      resolveBotIdForRead: jest.fn().mockResolvedValue('dormant-bot'),
      resolveBotId: jest.fn().mockResolvedValue('dormant-bot'),
    };
    const service = new ManagedGiveawayService(
      prisma as never,
      createMaxClientMock() as never,
      { invalidate: jest.fn() } as never,
      {} as never,
      createConfigMock() as never,
      undefined,
      maxBotLinkService as never,
    );

    await expect(
      (service as any).resolveGiveawayMembershipLookupBotId('required-dormant-1'),
    ).resolves.toBeNull();

    expect(maxBotLinkService.resolveBotRoute).toHaveBeenCalledWith({
      purpose: 'read',
      chatId: 'required-dormant-1',
    });
    expect(maxBotLinkService.resolveBotIdForRead).not.toHaveBeenCalled();
    expect(maxBotLinkService.resolveBotId).not.toHaveBeenCalled();
    expect(prisma.chat.findUnique).not.toHaveBeenCalled();
  });

  it('exposes winner name in public results immediately after draw', () => {
    const service = new ManagedGiveawayService(
      createPrismaMock() as never,
      createMaxClientMock() as never,
      { invalidate: jest.fn() } as never,
      {} as never,
      createConfigMock() as never,
    );

    const selectedText = (service as any).buildGiveawayResultsText(
      createGiveaway({
        status: ManagedGiveawayStatus.COMPLETED,
        publicationMessageId: 'publication-1',
        winners: [createWinner({ status: ManagedGiveawayWinnerStatus.SELECTED })],
      }),
    );
    const confirmedText = (service as any).buildGiveawayResultsText(
      createGiveaway({
        status: ManagedGiveawayStatus.COMPLETED,
        publicationMessageId: 'publication-1',
        winners: [createWinner({ status: ManagedGiveawayWinnerStatus.CLAIMED })],
      }),
    );

    expect(selectedText).toContain('🏆 Победитель:\n\n1. [CEO](max://user/winner-1)');
    expect(confirmedText).toContain('🏆 Победитель:\n\n1. [CEO](max://user/winner-1)');
  });

  it('uses plural winner heading when multiple prizes are awarded', () => {
    const service = new ManagedGiveawayService(
      createPrismaMock() as never,
      createMaxClientMock() as never,
      { invalidate: jest.fn() } as never,
      {} as never,
      createConfigMock() as never,
    );

    const text = (service as any).buildGiveawayResultsText(
      createGiveaway({
        status: ManagedGiveawayStatus.COMPLETED,
        publicationMessageId: 'publication-1',
        winners: [
          createWinner({ status: ManagedGiveawayWinnerStatus.SELECTED }),
          createSecondWinner({ status: ManagedGiveawayWinnerStatus.SELECTED }),
        ],
      }),
    );

    expect(text).toContain('🏆 Победители:\n\n1. [CEO](max://user/winner-1)');
    expect(text).toContain('2. [CTO](max://user/winner-2)');
  });

  it('publishes giveaway results as markdown with real line breaks', async () => {
    const prisma = createPrismaMock();
    const maxClient = createMaxClientMock();
    const service = new ManagedGiveawayService(
      prisma as never,
      maxClient as never,
      { invalidate: jest.fn() } as never,
      {} as never,
      createConfigMock() as never,
    );

    maxClient.sendMessageImmediateWithResolvedLink.mockResolvedValue({
      messageId: 'results-1',
      url: 'https://max.ru/channels/source-1/messages/results-1',
    });

    await (service as any).republishGiveawayResults(
      createGiveaway({
        status: ManagedGiveawayStatus.COMPLETED,
        publicationMessageId: 'publication-1',
        winners: [
          createWinner({ status: ManagedGiveawayWinnerStatus.SELECTED }),
          createSecondWinner({ status: ManagedGiveawayWinnerStatus.SELECTED }),
        ],
      }),
    );

    expect(maxClient.sendMessageImmediateWithResolvedLink).toHaveBeenCalledWith(
      'source-1',
      expect.stringContaining(
        '🏆 Победители:\n\n1. [CEO](max://user/winner-1) — Главный приз\n2. [CTO](max://user/winner-2) — Второй приз',
      ),
      expect.objectContaining({
        textFormat: 'markdown',
      }),
      expectManagedGiveawaySendOptions(),
    );
  });

  it('keeps winner mention as a hyperlink when refreshing an existing results post', async () => {
    const prisma = createPrismaMock();
    const maxClient = createMaxClientMock();
    const service = new ManagedGiveawayService(
      prisma as never,
      maxClient as never,
      { invalidate: jest.fn() } as never,
      {} as never,
      createConfigMock() as never,
    );

    await (service as any).republishGiveawayResults(
      createGiveaway({
        status: ManagedGiveawayStatus.COMPLETED,
        publicationMessageId: 'publication-1',
        resultsMessageId: 'results-1',
        resultsBotId: 'results-author-bot',
        winners: [createWinner({ status: ManagedGiveawayWinnerStatus.CLAIMED })],
      }),
    );

    expect(maxClient.editMessageInlineKeyboard).toHaveBeenCalledWith(
      'source-1',
      'results-1',
      expect.stringContaining('[CEO](max://user/winner-1)'),
      expect.objectContaining({
        textFormat: 'markdown',
        messageLink: {
          type: 'reply',
          mid: 'publication-1',
        },
      }),
      expectManagedGiveawaySendOptions({ botId: 'results-author-bot' }),
    );
  });

  it('safely replaces a verified-absent giveaway results post with a fenced routed send', async () => {
    const prisma = createPrismaMock();
    const maxClient = createMaxClientMock();
    const maxRoutedPublicationService = {
      publish: jest.fn().mockImplementation(async (request: any) => {
        await request.prepareAttempt({ botId: 'replacement-bot', job: {} });
        request.onDispatchAttempt({ botId: 'replacement-bot', job: {} });
        return {
          messageId: 'results-replacement-1',
          url: 'https://max.ru/channels/source-1/messages/results-replacement-1',
          botId: 'replacement-bot',
          candidateBotIds: ['replacement-bot'],
          routingVersion: 1,
        };
      }),
    };
    const service = new ManagedGiveawayService(
      prisma as never,
      maxClient as never,
      { invalidate: jest.fn() } as never,
      {} as never,
      createConfigMock() as never,
      undefined,
      createMaxBotLinkMock() as never,
      undefined,
      undefined,
      maxRoutedPublicationService as never,
    );
    const giveaway = createGiveaway({
      status: ManagedGiveawayStatus.COMPLETED,
      publicationMessageId: 'publication-1',
      publicationBotId: 'publication-author-bot',
      resultsMessageId: 'results-old-1',
      resultsBotId: 'results-author-bot',
      resultsUrl: 'https://max.ru/channels/source-1/messages/results-old-1',
      winners: [createWinner({ status: ManagedGiveawayWinnerStatus.CLAIMED })],
    });
    maxClient.editMessageInlineKeyboard.mockRejectedValue(
      createMaxApiError(404, 'Message not found', 'message.not.found'),
    );
    maxClient.getExactMessagePresence.mockResolvedValue('absent');

    await expect((service as any).republishGiveawayResults(giveaway)).resolves.toBe(true);

    expect(maxClient.getExactMessagePresence).toHaveBeenCalledWith(
      'source-1',
      'results-old-1',
      expect.objectContaining({
        botId: 'results-author-bot',
        bypassCache: true,
        ignoreFailureMetricStatuses: [404],
      }),
    );
    const replacementCas = prisma.managedGiveaway.updateMany.mock.calls.find(
      ([query]) => query.where?.resultsMessageId === 'results-old-1',
    )?.[0];
    const replacementSendLockKey = replacementCas?.data?.sendLockKey;
    expect(replacementCas).toEqual({
      where: {
        id: 'giveaway-1',
        status: ManagedGiveawayStatus.COMPLETED,
        resultsMessageId: 'results-old-1',
        lockedAt: null,
        sendLockKey: null,
      },
      data: {
        resultsMessageId: null,
        resultsBotId: null,
        resultsUrl: null,
        lockedAt: null,
        sendLockKey: replacementSendLockKey,
      },
    });
    expect(replacementSendLockKey).toMatch(
      /^managed-giveaway:results-replacement:giveaway-1:[0-9a-f]{24}$/u,
    );
    expect(maxRoutedPublicationService.publish).toHaveBeenCalledWith(
      expect.objectContaining({ logicalIdempotencyKey: replacementSendLockKey }),
    );
    expect(maxClient.editMessageInlineKeyboard).toHaveBeenCalledTimes(1);
    expect(prisma.managedGiveaway.update).toHaveBeenCalledWith({
      where: { id: 'giveaway-1' },
      data: {
        resultsMessageId: 'results-replacement-1',
        resultsBotId: 'replacement-bot',
        resultsUrl: 'https://max.ru/channels/source-1/messages/results-replacement-1',
        lockedAt: null,
        sendLockKey: null,
      },
    });
  });

  it('uses a new deterministic key when MAX rejects editing a verified-present results post', async () => {
    const prisma = createPrismaMock();
    const maxClient = createMaxClientMock();
    const maxRoutedPublicationService = {
      publish: jest.fn().mockImplementation(async (request: any) => {
        request.onDispatchAttempt({ botId: 'replacement-bot', job: {} });
        return {
          messageId: 'results-replacement-2',
          url: null,
          botId: 'replacement-bot',
        };
      }),
    };
    const service = new ManagedGiveawayService(
      prisma as never,
      maxClient as never,
      { invalidate: jest.fn() } as never,
      {} as never,
      createConfigMock() as never,
      undefined,
      createMaxBotLinkMock() as never,
      undefined,
      undefined,
      maxRoutedPublicationService as never,
    );
    const giveaway = createGiveaway({
      status: ManagedGiveawayStatus.COMPLETED,
      publicationMessageId: 'publication-1',
      resultsMessageId: 'results-present-1',
      resultsBotId: 'results-author-bot',
      winners: [createWinner({ status: ManagedGiveawayWinnerStatus.CLAIMED })],
    });
    maxClient.editMessageInlineKeyboard.mockRejectedValue(createMaxEditRejectedError());

    await expect((service as any).republishGiveawayResults(giveaway)).resolves.toBe(true);

    const replacementSendLockKey =
      maxRoutedPublicationService.publish.mock.calls[0]?.[0]?.logicalIdempotencyKey;
    expect(maxClient.getExactMessagePresence).toHaveBeenCalledWith(
      'source-1',
      'results-present-1',
      expect.objectContaining({ botId: 'results-author-bot', bypassCache: true }),
    );
    expect(replacementSendLockKey).toMatch(
      /^managed-giveaway:results-replacement:giveaway-1:[0-9a-f]{24}$/u,
    );
    expect(replacementSendLockKey).not.toBe('managed-giveaway:results:giveaway-1');
    expect(maxClient.editMessageInlineKeyboard).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['chat.denied', createMaxApiError(403, 'Forbidden', 'chat.denied')],
    ['chat.not.found', createMaxApiError(404, 'Chat not found', 'chat.not.found')],
  ])(
    'records terminal %s from results verification without replacing the original edit failure',
    async (_label, lookupError) => {
      const editAttemptStartedAt = new Date('2026-08-20T12:10:00.123Z');
      const lookupAttemptStartedAt = new Date('2026-08-20T12:10:01.456Z');
      jest.useFakeTimers().setSystemTime(editAttemptStartedAt);

      const prisma = createPrismaMock();
      const maxClient = createMaxClientMock();
      const managedEntityAccessLossService = createManagedEntityAccessLossMock();
      const service = new ManagedGiveawayService(
        prisma as never,
        maxClient as never,
        { invalidate: jest.fn() } as never,
        {} as never,
        createConfigMock() as never,
        undefined,
        createMaxBotLinkMock() as never,
        managedEntityAccessLossService as never,
      );
      const giveaway = createGiveaway({
        status: ManagedGiveawayStatus.COMPLETED,
        publicationMessageId: 'publication-1',
        resultsMessageId: 'results-verification-denied-1',
        resultsBotId: 'results-author-bot',
        winners: [createWinner({ status: ManagedGiveawayWinnerStatus.CLAIMED })],
      });
      const editError = createMaxApiError(404, 'Message not found', 'message.not.found');
      maxClient.editMessageInlineKeyboard.mockImplementation(async () => {
        jest.setSystemTime(lookupAttemptStartedAt);
        throw editError;
      });
      maxClient.getExactMessagePresence.mockRejectedValue(lookupError);

      await expect((service as any).republishGiveawayResults(giveaway)).resolves.toBe(false);

      expect(
        managedEntityAccessLossService.recordIfManagedEntityAccessLost,
      ).toHaveBeenNthCalledWith(1, {
        chatId: 'source-1',
        botId: 'results-author-bot',
        entityType: ChatEntityType.CHANNEL,
        source: 'managed_giveaway:results:verification',
        operation: 'message_lookup',
        error: lookupError,
        lifecycleEventAt: lookupAttemptStartedAt,
        lifecycleEventType: 'live_probe',
        lifecycleSource: 'live_probe',
      });
      expect(
        managedEntityAccessLossService.recordIfManagedEntityAccessLost,
      ).toHaveBeenNthCalledWith(2, {
        chatId: 'source-1',
        botId: 'results-author-bot',
        entityType: ChatEntityType.CHANNEL,
        source: 'managed_giveaway:results',
        operation: 'edit',
        error: editError,
        lifecycleEventAt: editAttemptStartedAt,
        lifecycleEventType: 'live_probe',
        lifecycleSource: 'live_probe',
      });
      expect(prisma.managedGiveaway.updateMany).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['rate limit', createMaxApiError(429, 'Too many requests')],
    ['server failure', createMaxApiError(500, 'MAX upstream failure')],
    ['timeout', new Error('request timed out before response body arrived')],
  ])('does not replace giveaway results after a transient %s', async (_label, error) => {
    const prisma = createPrismaMock();
    const maxClient = createMaxClientMock();
    const maxRoutedPublicationService = { publish: jest.fn() };
    const service = new ManagedGiveawayService(
      prisma as never,
      maxClient as never,
      { invalidate: jest.fn() } as never,
      {} as never,
      createConfigMock() as never,
      undefined,
      createMaxBotLinkMock() as never,
      undefined,
      undefined,
      maxRoutedPublicationService as never,
    );
    const giveaway = createGiveaway({
      status: ManagedGiveawayStatus.COMPLETED,
      publicationMessageId: 'publication-1',
      resultsMessageId: 'results-1',
      resultsBotId: 'results-author-bot',
      winners: [createWinner({ status: ManagedGiveawayWinnerStatus.CLAIMED })],
    });
    maxClient.editMessageInlineKeyboard.mockRejectedValue(error);

    await expect((service as any).republishGiveawayResults(giveaway)).resolves.toBe(false);

    expect(maxClient.getExactMessagePresence).not.toHaveBeenCalled();
    expect(maxRoutedPublicationService.publish).not.toHaveBeenCalled();
    expect(prisma.managedGiveaway.updateMany).not.toHaveBeenCalled();
  });

  it('preserves the replacement key after a definitive replacement send failure', async () => {
    const prisma = createPrismaMock();
    const maxClient = createMaxClientMock();
    const maxRoutedPublicationService = {
      publish: jest.fn().mockRejectedValue(createMaxApiError(500, 'Pre-dispatch failure')),
    };
    const service = new ManagedGiveawayService(
      prisma as never,
      maxClient as never,
      { invalidate: jest.fn() } as never,
      {} as never,
      createConfigMock() as never,
      undefined,
      createMaxBotLinkMock() as never,
      undefined,
      undefined,
      maxRoutedPublicationService as never,
    );
    const giveaway = createGiveaway({
      status: ManagedGiveawayStatus.COMPLETED,
      publicationMessageId: 'publication-1',
      resultsMessageId: 'results-uneditable-1',
      resultsBotId: 'results-author-bot',
      winners: [createWinner({ status: ManagedGiveawayWinnerStatus.CLAIMED })],
    });
    maxClient.editMessageInlineKeyboard.mockRejectedValue(createMaxEditRejectedError());

    await expect((service as any).republishGiveawayResults(giveaway)).resolves.toBe(false);

    const replacementSendLockKey =
      prisma.managedGiveaway.updateMany.mock.calls[0]?.[0]?.data?.sendLockKey;
    expect(replacementSendLockKey).toMatch(
      /^managed-giveaway:results-replacement:giveaway-1:[0-9a-f]{24}$/u,
    );
    expect(prisma.managedGiveaway.updateMany).toHaveBeenLastCalledWith({
      where: {
        id: 'giveaway-1',
        resultsMessageId: null,
        lockedAt: expect.any(Date),
        sendLockKey: replacementSendLockKey,
      },
      data: {
        lockedAt: null,
        sendLockKey: replacementSendLockKey,
      },
    });
  });

  it('retries a stale replacement lock with the same deterministic key', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-21T13:00:00.000Z'));

    const prisma = createPrismaMock();
    const maxClient = createMaxClientMock();
    const maxRoutedPublicationService = {
      publish: jest.fn().mockImplementation(async (request: any) => {
        request.onDispatchAttempt({ botId: 'replacement-bot', job: {} });
        return {
          messageId: 'results-recovered-replacement-1',
          url: null,
          botId: 'replacement-bot',
        };
      }),
    };
    const maxActionLedgerService = {
      getCompletedSendDispatchResult: jest.fn().mockResolvedValue(null),
      assertCanEnqueue: jest.fn().mockResolvedValue(undefined),
    };
    const service = new ManagedGiveawayService(
      prisma as never,
      maxClient as never,
      { invalidate: jest.fn() } as never,
      {} as never,
      createConfigMock() as never,
      undefined,
      createMaxBotLinkMock() as never,
      undefined,
      undefined,
      maxRoutedPublicationService as never,
      maxActionLedgerService as never,
    );
    const replacementSendLockKey = (service as any).buildGiveawayResultsReplacementSendLockKey(
      'giveaway-1',
      'results-uneditable-1',
    );
    const staleLockAt = new Date('2026-03-21T12:58:00.000Z');
    const giveaway = createGiveaway({
      status: ManagedGiveawayStatus.COMPLETED,
      publicationMessageId: 'publication-1',
      resultsMessageId: null,
      lockedAt: staleLockAt,
      sendLockKey: replacementSendLockKey,
      winners: [createWinner({ status: ManagedGiveawayWinnerStatus.CLAIMED })],
    });

    await expect((service as any).republishGiveawayResults(giveaway)).resolves.toBe(true);

    expect(maxActionLedgerService.assertCanEnqueue).toHaveBeenCalledWith(
      expect.objectContaining({ idempotencyKey: replacementSendLockKey }),
    );
    expect(prisma.managedGiveaway.updateMany).toHaveBeenNthCalledWith(1, {
      where: {
        id: 'giveaway-1',
        lockedAt: staleLockAt,
        sendLockKey: replacementSendLockKey,
        resultsMessageId: null,
      },
      data: {
        lockedAt: null,
        sendLockKey: replacementSendLockKey,
      },
    });
    expect(prisma.managedGiveaway.updateMany).toHaveBeenNthCalledWith(2, {
      where: {
        id: 'giveaway-1',
        resultsMessageId: null,
        lockedAt: null,
      },
      data: {
        lockedAt: new Date('2026-03-21T13:00:00.000Z'),
        sendLockKey: replacementSendLockKey,
      },
    });
    expect(maxRoutedPublicationService.publish).toHaveBeenCalledWith(
      expect.objectContaining({ logicalIdempotencyKey: replacementSendLockKey }),
    );
    expect(maxClient.editMessageInlineKeyboard).not.toHaveBeenCalled();
  });

  it('stores the remote message id after a durable winner notification send', async () => {
    const prisma = createPrismaMock();
    const maxClient = createMaxClientMock();
    const notification = createWinnerNotification({
      winner: {
        giveaway: {
          publicationUrl: 'https://max.ru/chats/chat-1/message/1',
          resultsUrl: 'https://max.ru/chats/chat-1/message/2',
        },
      },
    });
    prisma.managedGiveawayWinnerNotification.findMany.mockResolvedValue([notification]);
    prisma.managedGiveawayWinnerNotification.updateMany
      .mockResolvedValueOnce({ count: 0 })
      .mockResolvedValueOnce({ count: 0 })
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 1 });
    maxClient.sendMessageImmediateToUser.mockImplementation(async (_userId, _text, options) => {
      await options.beforeSend();
      return { messageId: 'winner-dm-1', url: null };
    });
    const service = new ManagedGiveawayService(
      prisma as never,
      maxClient as never,
      { invalidate: jest.fn() } as never,
      {} as never,
      createConfigMock() as never,
    );

    await (service as any).processWinnerNotificationOutbox('miniapp', 'giveaway-1');

    expect(maxClient.sendMessageImmediateToUser).toHaveBeenCalledWith(
      'winner-1',
      expect.stringContaining('Вы выиграли в розыгрыше'),
      expect.objectContaining({
        buttons: [
          [expect.objectContaining({ text: 'Забрать приз' })],
          [
            expect.objectContaining({ text: 'Открыть пост' }),
            expect.objectContaining({ text: 'Итоги' }),
          ],
        ],
      }),
      expectManagedGiveawaySendOptions(),
    );
    expect(prisma.managedGiveawayWinnerNotification.updateMany).toHaveBeenLastCalledWith({
      where: {
        id: 'winner-notification-1',
        status: ManagedGiveawayWinnerNotificationStatus.DISPATCHING,
        lockedAt: expect.any(Date),
      },
      data: {
        status: ManagedGiveawayWinnerNotificationStatus.SENT,
        remoteMessageId: 'winner-dm-1',
        sentAt: expect.any(Date),
        lockedAt: null,
        nextAttemptAt: expect.any(Date),
        lastError: null,
      },
    });
  });

  it('keeps published-message edits and winner DMs outside the routed SEND executor', async () => {
    const prisma = createPrismaMock();
    const maxClient = createMaxClientMock();
    const maxRoutedPublicationService = { publish: jest.fn() };
    const service = new ManagedGiveawayService(
      prisma as never,
      maxClient as never,
      { invalidate: jest.fn() } as never,
      {} as never,
      createConfigMock() as never,
      undefined,
      createMaxBotLinkMock({ resolvedBotId: 'publication-author-bot' }) as never,
      undefined,
      undefined,
      maxRoutedPublicationService as never,
    );
    const winner = createWinner({ status: ManagedGiveawayWinnerStatus.SELECTED });
    const giveaway = createGiveaway({
      status: ManagedGiveawayStatus.COMPLETED,
      publicationMessageId: 'publication-1',
      publicationBotId: 'publication-author-bot',
      resultsMessageId: 'results-1',
      resultsBotId: 'results-author-bot',
      winners: [winner],
    });
    prisma.managedGiveawayWinnerNotification.findMany.mockResolvedValue([
      createWinnerNotification({
        winner: {
          ...winner,
          giveaway,
        },
      }),
    ]);
    prisma.managedGiveawayWinnerNotification.updateMany
      .mockResolvedValueOnce({ count: 0 })
      .mockResolvedValueOnce({ count: 0 })
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 1 });
    maxClient.sendMessageImmediateToUser.mockImplementation(async (_userId, _text, options) => {
      await options.beforeSend();
      return { messageId: 'winner-dm-1', url: null };
    });

    await (service as any).republishGiveawayResults(giveaway);
    await (service as any).processWinnerNotificationOutbox('miniapp', giveaway.id);

    expect(maxRoutedPublicationService.publish).not.toHaveBeenCalled();
    expect(maxClient.editMessageInlineKeyboard).toHaveBeenCalledWith(
      'source-1',
      'results-1',
      expect.any(String),
      expect.any(Object),
      expectManagedGiveawaySendOptions({ botId: 'results-author-bot' }),
    );
    expect(maxClient.sendMessageImmediateToUser).toHaveBeenCalledWith(
      'winner-1',
      expect.any(String),
      expect.any(Object),
      expectManagedGiveawaySendOptions({ botId: 'publication-author-bot' }),
    );
  });

  it('sends winner direct messages and claim links through the giveaway publication bot', async () => {
    const prisma = createPrismaMock();
    prisma.chat.findUnique.mockResolvedValue({
      title: 'Основной канал',
      primaryBotId: '888000_bot',
      botId: '777000_bot',
    });
    const maxClient = createMaxClientMock();
    const maxBotLinkService = createMaxBotLinkMock({
      resolvedBotId: '888000_bot',
      token: 'selected-token',
    });
    const service = new ManagedGiveawayService(
      prisma as never,
      maxClient as never,
      { invalidate: jest.fn() } as never,
      {} as never,
      createConfigMock() as never,
      undefined,
      maxBotLinkService as never,
    );

    prisma.managedGiveawayWinnerNotification.findMany.mockResolvedValue([
      createWinnerNotification({
        winner: {
          giveaway: {
            sourceChatId: '-70000000000001',
          },
        },
      }),
    ]);
    prisma.managedGiveawayWinnerNotification.updateMany
      .mockResolvedValueOnce({ count: 0 })
      .mockResolvedValueOnce({ count: 0 })
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 1 });
    maxClient.sendMessageImmediateToUser.mockImplementation(async (_userId, _text, options) => {
      await options.beforeSend();
      return { messageId: 'winner-dm-route-1', url: null };
    });

    await (service as any).processWinnerNotificationOutbox('miniapp', 'giveaway-1');

    expect(maxBotLinkService.getBotTokenSync).toHaveBeenCalledWith('888000_bot');
    expect(maxBotLinkService.buildBotStartUrlSync).toHaveBeenCalledWith(
      expect.any(String),
      '888000_bot',
    );
    expect(maxClient.sendMessageImmediateToUser).toHaveBeenCalledWith(
      'winner-1',
      expect.stringContaining('Вы выиграли в розыгрыше'),
      expect.objectContaining({
        buttons: [
          [
            expect.objectContaining({
              text: 'Забрать приз',
              url: expect.stringContaining('https://max.ru/888000_bot?start='),
            }),
          ],
        ],
      }),
      expectManagedGiveawaySendOptions({ botId: '888000_bot' }),
    );
  });

  it('quarantines a winner notification after outbound dispatch starts', async () => {
    const prisma = createPrismaMock();
    const maxClient = createMaxClientMock();
    prisma.managedGiveawayWinnerNotification.findMany.mockResolvedValue([
      createWinnerNotification(),
    ]);
    prisma.managedGiveawayWinnerNotification.updateMany
      .mockResolvedValueOnce({ count: 0 })
      .mockResolvedValueOnce({ count: 0 })
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 1 });
    maxClient.sendMessageImmediateToUser.mockImplementation(async (_userId, _text, options) => {
      await options.beforeSend();
      throw new Error('MAX request timed out after dispatch');
    });
    const service = new ManagedGiveawayService(
      prisma as never,
      maxClient as never,
      { invalidate: jest.fn() } as never,
      {} as never,
      createConfigMock() as never,
    );

    await (service as any).processWinnerNotificationOutbox('runner');

    expect(prisma.managedGiveawayWinnerNotification.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: ManagedGiveawayWinnerNotificationStatus.AMBIGUOUS,
          ambiguousAt: expect.any(Date),
          lockedAt: null,
        }),
      }),
    );
    expect(prisma.managedGiveawayWinnerNotification.updateMany).not.toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: ManagedGiveawayWinnerNotificationStatus.RETRYABLE,
        }),
      }),
    );
  });

  it('backs off a clearly pre-dispatch winner notification failure', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-21T13:00:00.000Z'));

    try {
      const prisma = createPrismaMock();
      const maxClient = createMaxClientMock();
      prisma.managedGiveawayWinnerNotification.findMany.mockResolvedValue([
        createWinnerNotification(),
      ]);
      prisma.managedGiveawayWinnerNotification.updateMany
        .mockResolvedValueOnce({ count: 0 })
        .mockResolvedValueOnce({ count: 0 })
        .mockResolvedValueOnce({ count: 1 })
        .mockResolvedValueOnce({ count: 1 });
      maxClient.sendMessageImmediateToUser.mockImplementation(async () => {
        jest.setSystemTime(new Date('2026-03-21T13:02:00.000Z'));
        throw new Error('background action lane unavailable before send');
      });
      const service = new ManagedGiveawayService(
        prisma as never,
        maxClient as never,
        { invalidate: jest.fn() } as never,
        {} as never,
        createConfigMock() as never,
      );

      await (service as any).processWinnerNotificationOutbox('runner');

      expect(prisma.managedGiveawayWinnerNotification.updateMany).toHaveBeenLastCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: ManagedGiveawayWinnerNotificationStatus.RETRYABLE,
            nextAttemptAt: new Date('2026-03-21T13:02:30.000Z'),
            lockedAt: null,
          }),
        }),
      );
    } finally {
      jest.useRealTimers();
    }
  });

  it('stops retrying pre-dispatch winner notification failures after five attempts', async () => {
    const prisma = createPrismaMock();
    const maxClient = createMaxClientMock();
    prisma.managedGiveawayWinnerNotification.findMany.mockResolvedValue([
      createWinnerNotification({
        status: ManagedGiveawayWinnerNotificationStatus.RETRYABLE,
        attemptCount: 4,
      }),
    ]);
    prisma.managedGiveawayWinnerNotification.updateMany
      .mockResolvedValueOnce({ count: 0 })
      .mockResolvedValueOnce({ count: 0 })
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 1 });
    maxClient.sendMessageImmediateToUser.mockRejectedValue(
      new Error('background action lane unavailable before send'),
    );
    const service = new ManagedGiveawayService(
      prisma as never,
      maxClient as never,
      { invalidate: jest.fn() } as never,
      {} as never,
      createConfigMock() as never,
    );

    await (service as any).processWinnerNotificationOutbox('runner');

    expect(prisma.managedGiveawayWinnerNotification.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: ManagedGiveawayWinnerNotificationStatus.FAILED_TERMINAL,
          lockedAt: null,
        }),
      }),
    );
  });

  it('quarantines stale dispatching winner notifications without sending again', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-21T13:00:00.000Z'));

    try {
      const prisma = createPrismaMock();
      const maxClient = createMaxClientMock();
      const service = new ManagedGiveawayService(
        prisma as never,
        maxClient as never,
        { invalidate: jest.fn() } as never,
        {} as never,
        createConfigMock() as never,
      );

      await (service as any).processWinnerNotificationOutbox('runner');

      expect(prisma.managedGiveawayWinnerNotification.updateMany).toHaveBeenNthCalledWith(1, {
        where: {
          status: ManagedGiveawayWinnerNotificationStatus.DISPATCHING,
          lockedAt: { lt: new Date('2026-03-21T12:59:00.000Z') },
        },
        data: {
          status: ManagedGiveawayWinnerNotificationStatus.AMBIGUOUS,
          ambiguousAt: new Date('2026-03-21T13:00:00.000Z'),
          lockedAt: null,
          lastError: expect.stringContaining('manual verification'),
        },
      });
      expect(maxClient.sendMessageImmediateToUser).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it('synchronizes results once per giveaway and reloads only the bounded notification snapshot', async () => {
    const prisma = createPrismaMock();
    const giveaway = createGiveaway({
      status: ManagedGiveawayStatus.COMPLETED,
      resultsMessageId: 'results-1',
    });
    const first = createWinnerNotification({
      winner: { giveaway },
    });
    const secondWinner = createSecondWinner();
    const second = createWinnerNotification({
      id: 'winner-notification-2',
      winnerId: secondWinner.id,
      winner: { ...secondWinner, giveaway },
    });
    prisma.managedGiveawayWinnerNotification.findMany
      .mockResolvedValueOnce([first, second])
      .mockResolvedValueOnce([first, second]);
    prisma.managedGiveaway.findUnique.mockResolvedValue(giveaway);
    const service = new ManagedGiveawayService(
      prisma as never,
      createMaxClientMock() as never,
      { invalidate: jest.fn() } as never,
      {} as never,
      createConfigMock() as never,
    );
    const resultsSpy = jest
      .spyOn(service as any, 'republishGiveawayResults')
      .mockResolvedValue(true);
    const dispatchSpy = jest
      .spyOn(service as any, 'processWinnerNotification')
      .mockResolvedValue(undefined);

    await (service as any).processWinnerNotificationOutbox('runner', undefined, 20, {
      synchronizeResultsBeforeDispatch: true,
    });

    expect(resultsSpy).toHaveBeenCalledTimes(1);
    expect(resultsSpy).toHaveBeenCalledWith(giveaway, 'runner');
    expect(prisma.managedGiveawayWinnerNotification.findMany).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        where: expect.objectContaining({
          id: { in: ['winner-notification-1', 'winner-notification-2'] },
          winner: expect.objectContaining({
            giveaway: expect.objectContaining({ id: 'giveaway-1' }),
          }),
        }),
        take: 2,
      }),
    );
    expect(dispatchSpy).toHaveBeenCalledTimes(2);
  });

  it('defers only the selected notifications when results cannot be confirmed', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-21T13:00:00.000Z'));

    try {
      const prisma = createPrismaMock();
      const notification = createWinnerNotification();
      prisma.managedGiveawayWinnerNotification.findMany.mockResolvedValueOnce([notification]);
      prisma.managedGiveaway.findUnique.mockResolvedValue(notification.winner.giveaway);
      const service = new ManagedGiveawayService(
        prisma as never,
        createMaxClientMock() as never,
        { invalidate: jest.fn() } as never,
        {} as never,
        createConfigMock() as never,
      );
      jest.spyOn(service as any, 'republishGiveawayResults').mockResolvedValue(false);
      const dispatchSpy = jest
        .spyOn(service as any, 'processWinnerNotification')
        .mockResolvedValue(undefined);

      await (service as any).processWinnerNotificationOutbox('runner', undefined, 20, {
        synchronizeResultsBeforeDispatch: true,
      });

      expect(prisma.managedGiveawayWinnerNotification.findMany).toHaveBeenCalledTimes(1);
      expect(dispatchSpy).not.toHaveBeenCalled();
      expect(prisma.managedGiveawayWinnerNotification.updateMany).toHaveBeenLastCalledWith({
        where: {
          id: { in: ['winner-notification-1'] },
          status: {
            in: [
              ManagedGiveawayWinnerNotificationStatus.PENDING,
              ManagedGiveawayWinnerNotificationStatus.RETRYABLE,
            ],
          },
          nextAttemptAt: { lte: new Date('2026-03-21T13:00:00.000Z') },
          OR: [{ lockedAt: null }, { lockedAt: { lt: new Date('2026-03-21T12:59:00.000Z') } }],
        },
        data: {
          nextAttemptAt: new Date('2026-03-21T13:00:30.000Z'),
        },
      });
      expect(prisma.managedGiveawayWinnerNotification.updateMany).not.toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ attemptCount: expect.anything() }),
        }),
      );
    } finally {
      jest.useRealTimers();
    }
  });

  it('creates the replacement winner notification in the reroll transaction', async () => {
    const prisma = createPrismaMock();
    const service = new ManagedGiveawayService(
      prisma as never,
      createMaxClientMock() as never,
      { invalidate: jest.fn() } as never,
      {} as never,
      createConfigMock() as never,
    );
    const oldWinner = createWinner({ status: ManagedGiveawayWinnerStatus.EXPIRED });
    const nextEntry = createEntry({
      id: 'entry-reroll-next',
      userId: 'winner-reroll-next',
      eligibilityState: GiveawayEligibilityState.VERIFIED,
      drawRank: 'rank-reroll-next',
    });
    const giveaway = createGiveaway({
      status: ManagedGiveawayStatus.COMPLETED,
      drawSeed: 'reroll-seed',
      prizes: [oldWinner.prize],
      entries: [oldWinner.entry, nextEntry],
      winners: [oldWinner],
    });
    const replacementWinner = createWinner({
      id: 'winner-reroll-next',
      entryId: nextEntry.id,
      entry: nextEntry,
    });
    const updated = createGiveaway({
      ...giveaway,
      winners: [{ ...oldWinner, status: ManagedGiveawayWinnerStatus.REROLLED }, replacementWinner],
    });
    const txWinnerCreate = jest.fn().mockResolvedValue(replacementWinner);
    const txNotificationCreate = jest.fn().mockResolvedValue(undefined);
    const txNotificationUpdateMany = jest.fn().mockResolvedValue({ count: 1 });
    prisma.$transaction.mockImplementation(async (callback) =>
      callback({
        managedGiveawayEntry: {
          update: jest.fn().mockResolvedValue(nextEntry),
        },
        managedGiveawayWinner: {
          update: jest.fn().mockResolvedValue(oldWinner),
          create: txWinnerCreate,
        },
        managedGiveawayWinnerNotification: {
          updateMany: txNotificationUpdateMany,
          create: txNotificationCreate,
        },
        managedGiveaway: {
          findUniqueOrThrow: jest.fn().mockResolvedValue(updated),
        },
      }),
    );
    jest.spyOn(service as any, 'assertAdminEntityAccess').mockResolvedValue(undefined);
    jest.spyOn(service as any, 'findGiveawayForSource').mockResolvedValue(giveaway);
    jest.spyOn(service as any, 'pickNextRerollCandidate').mockReturnValue({
      entry: nextEntry,
      drawRank: 'rank-reroll-next',
    });
    jest.spyOn(service as any, 'editGiveawayPublicationIfNeeded').mockResolvedValue(undefined);
    const resultsSpy = jest
      .spyOn(service as any, 'republishGiveawayResults')
      .mockResolvedValue(true);
    jest.spyOn(service as any, 'findGiveawayById').mockResolvedValue(updated);
    const outboxSpy = jest
      .spyOn(service as any, 'processWinnerNotificationOutbox')
      .mockResolvedValue(undefined);
    jest.spyOn(service as any, 'writeAuditLog').mockResolvedValue(undefined);

    await service.rerollManagedGiveawayWinner(
      'source-1',
      'giveaway-1',
      user as never,
      { winnerId: oldWinner.id },
      'channel',
    );

    expect(txNotificationUpdateMany).toHaveBeenCalledWith({
      where: {
        winnerId: oldWinner.id,
        status: {
          in: [
            ManagedGiveawayWinnerNotificationStatus.PENDING,
            ManagedGiveawayWinnerNotificationStatus.RETRYABLE,
          ],
        },
      },
      data: {
        status: ManagedGiveawayWinnerNotificationStatus.CANCELED,
        lockedAt: null,
        nextAttemptAt: expect.any(Date),
      },
    });
    const replacementWinnerId = txWinnerCreate.mock.calls[0][0].data.id;
    expect(replacementWinnerId).toEqual(expect.any(String));
    expect(txNotificationCreate).toHaveBeenCalledWith({
      data: {
        winnerId: replacementWinnerId,
        nextAttemptAt: expect.any(Date),
      },
    });
    expect(outboxSpy).toHaveBeenCalledWith('miniapp', 'giveaway-1', 20, {
      winnerIds: [replacementWinnerId],
    });

    outboxSpy.mockClear();
    resultsSpy.mockResolvedValue(false);
    await service.rerollManagedGiveawayWinner(
      'source-1',
      'giveaway-1',
      user as never,
      { winnerId: oldWinner.id },
      'channel',
    );
    expect(outboxSpy).not.toHaveBeenCalled();
  });

  it('returns a conflict for a concurrent reroll unique race without masking other errors', async () => {
    const prisma = createPrismaMock();
    const service = new ManagedGiveawayService(
      prisma as never,
      createMaxClientMock() as never,
      { invalidate: jest.fn() } as never,
      {} as never,
      createConfigMock() as never,
    );
    const oldWinner = createWinner({ status: ManagedGiveawayWinnerStatus.EXPIRED });
    const nextEntry = createEntry({
      id: 'entry-reroll-next',
      userId: 'winner-reroll-next',
      eligibilityState: GiveawayEligibilityState.VERIFIED,
      drawRank: 'rank-reroll-next',
    });
    const giveaway = createGiveaway({
      status: ManagedGiveawayStatus.COMPLETED,
      drawSeed: 'reroll-seed',
      prizes: [oldWinner.prize],
      entries: [oldWinner.entry, nextEntry],
      winners: [oldWinner],
    });
    const publicationSpy = jest
      .spyOn(service as any, 'editGiveawayPublicationIfNeeded')
      .mockResolvedValue(undefined);
    const resultsSpy = jest
      .spyOn(service as any, 'republishGiveawayResults')
      .mockResolvedValue(true);
    const outboxSpy = jest
      .spyOn(service as any, 'processWinnerNotificationOutbox')
      .mockResolvedValue(undefined);
    const auditSpy = jest.spyOn(service as any, 'writeAuditLog').mockResolvedValue(undefined);
    jest.spyOn(service as any, 'assertAdminEntityAccess').mockResolvedValue(undefined);
    jest.spyOn(service as any, 'findGiveawayForSource').mockResolvedValue(giveaway);
    jest.spyOn(service as any, 'pickNextRerollCandidate').mockReturnValue({
      entry: nextEntry,
      drawRank: 'rank-reroll-next',
    });

    prisma.$transaction.mockRejectedValueOnce(
      Object.assign(new Error('Unique constraint failed'), { code: 'P2002' }),
    );

    await expect(
      service.rerollManagedGiveawayWinner(
        'source-1',
        'giveaway-1',
        user as never,
        { winnerId: oldWinner.id },
        'channel',
      ),
    ).rejects.toEqual(
      new ConflictException('Состояние победителя изменилось. Обновите экран и повторите реролл.'),
    );
    expect(publicationSpy).not.toHaveBeenCalled();
    expect(resultsSpy).not.toHaveBeenCalled();
    expect(outboxSpy).not.toHaveBeenCalled();
    expect(auditSpy).not.toHaveBeenCalled();

    const unrelatedError = Object.assign(new Error('Timed out fetching a new connection'), {
      code: 'P2024',
    });
    prisma.$transaction.mockRejectedValueOnce(unrelatedError);

    await expect(
      service.rerollManagedGiveawayWinner(
        'source-1',
        'giveaway-1',
        user as never,
        { winnerId: oldWinner.id },
        'channel',
      ),
    ).rejects.toBe(unrelatedError);
  });

  it('accepts giveaway claim payloads signed with the previous bot token', () => {
    const previousToken = 'test-token-previous';
    const legacyService = new ManagedGiveawayService(
      createPrismaMock() as never,
      createMaxClientMock() as never,
      { invalidate: jest.fn() } as never,
      {} as never,
      createConfigMock({ token: previousToken }) as never,
    );
    const service = new ManagedGiveawayService(
      createPrismaMock() as never,
      createMaxClientMock() as never,
      { invalidate: jest.fn() } as never,
      {} as never,
      createConfigMock({ previousToken }) as never,
    );

    const claimUrl = legacyService.buildGiveawayClaimBotStartUrl('giveaway-1', 'winner-1');
    const claimPayload = claimUrl ? new URL(claimUrl).searchParams.get('start') : null;

    expect(claimPayload).not.toBeNull();
    expect(claimPayload!.length).toBeLessThanOrEqual(128);
    expect(service.parseClaimStartPayload(claimPayload)).toEqual({
      giveawayId: 'giveaway-1',
      winnerId: 'winner-1',
    });
  });

  it('revalidates every entry before draw and excludes users who left the source chat', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-21T13:00:00.000Z'));

    const prisma = createPrismaMock();
    const maxClient = createMaxClientMock();
    const service = new ManagedGiveawayService(
      prisma as never,
      maxClient as never,
      { invalidate: jest.fn() } as never,
      {} as never,
      createConfigMock() as never,
    );

    const removedEntry = createEntry({
      id: 'entry-removed',
      userId: 'winner-1',
      displayName: 'Ушёл',
      eligibilityState: GiveawayEligibilityState.VERIFIED,
      eligibilityReason: null,
      missingChannelIds: [],
    });
    const activeEntry = createEntry({
      id: 'entry-active',
      userId: 'winner-2',
      displayName: 'Остался',
      eligibilityState: GiveawayEligibilityState.VERIFIED,
      eligibilityReason: null,
      missingChannelIds: [],
      drawRank: '000-active',
    });
    const lateRejectedEntry = createEntry({
      id: 'entry-late',
      userId: 'winner-3',
      displayName: 'Вернулся',
      eligibilityState: GiveawayEligibilityState.REJECTED,
      eligibilityReason: 'Подписка на источник не подтверждена.',
      missingChannelIds: ['source-1'],
      drawRank: 'fff-late',
    });
    const prize = createPrize();
    const initial = createGiveaway({
      requiredChannelIds: [],
      prizes: [prize],
      entries: [removedEntry, activeEntry, lateRejectedEntry],
      drawSeed: 'seed-1',
      resultsMessageId: 'results-1',
    });
    const drawStarted = createGiveaway({
      ...initial,
      status: ManagedGiveawayStatus.DRAWING,
      drawSeed: 'seed-1',
      drawnAt: new Date('2026-03-21T13:00:00.000Z'),
      lockedAt: new Date('2026-03-21T13:00:00.000Z'),
    });
    const refreshedActiveEntry = {
      ...activeEntry,
      checkedAt: new Date('2026-03-21T13:00:00.000Z'),
      drawRank: 'draw-rank-active',
    };
    const refreshedLateEntry = {
      ...lateRejectedEntry,
      eligibilityState: GiveawayEligibilityState.VERIFIED,
      eligibilityReason: null,
      missingChannelIds: [],
      checkedAt: new Date('2026-03-21T13:00:00.000Z'),
    };
    const completed = createGiveaway({
      ...initial,
      status: ManagedGiveawayStatus.COMPLETED,
      drawSeed: 'seed-1',
      drawnAt: new Date('2026-03-21T13:00:00.000Z'),
      completedAt: new Date('2026-03-21T13:00:00.000Z'),
      entries: [
        {
          ...removedEntry,
          eligibilityState: GiveawayEligibilityState.REJECTED,
          eligibilityReason: 'Подписка на источник не подтверждена.',
          missingChannelIds: ['source-1'],
          checkedAt: new Date('2026-03-21T13:00:00.000Z'),
        },
        refreshedActiveEntry,
        refreshedLateEntry,
      ],
      winners: [
        createWinner({
          prize,
          prizeId: prize.id,
          entry: refreshedActiveEntry,
          entryId: refreshedActiveEntry.id,
          status: ManagedGiveawayWinnerStatus.SELECTED,
          selectedAt: new Date('2026-03-21T13:00:00.000Z'),
          claimedAt: null,
          claimDeadlineAt: new Date('2026-03-23T13:00:00.000Z'),
        }),
      ],
    });

    const prismaEntryUpdate = jest.fn().mockImplementation(async ({ where, data }) => ({
      ...(where.id === removedEntry.id
        ? removedEntry
        : where.id === lateRejectedEntry.id
          ? lateRejectedEntry
          : activeEntry),
      ...data,
    }));
    const txManagedEntryUpdate = jest.fn().mockImplementation(async ({ where, data }) => ({
      ...(where.id === removedEntry.id
        ? removedEntry
        : where.id === lateRejectedEntry.id
          ? lateRejectedEntry
          : activeEntry),
      ...data,
    }));
    const txWinnerCreateMany = jest.fn().mockResolvedValue({ count: 1 });
    const txNotificationCreateMany = jest.fn().mockResolvedValue({ count: 1 });
    const outboxSpy = jest.spyOn(service as any, 'processWinnerNotificationOutbox');

    prisma.managedGiveaway.updateMany.mockResolvedValueOnce({ count: 1 });
    prisma.managedGiveaway.findUnique
      .mockResolvedValueOnce(initial)
      .mockResolvedValueOnce(drawStarted)
      .mockResolvedValueOnce(completed);
    prisma.managedGiveawayEntry.update = prismaEntryUpdate;
    prisma.$transaction.mockImplementation(async (callback) =>
      callback({
        managedGiveaway: {
          update: jest.fn().mockResolvedValue(undefined),
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
          findUniqueOrThrow: jest.fn().mockResolvedValue(completed),
        },
        managedGiveawayEntry: {
          update: txManagedEntryUpdate,
        },
        managedGiveawayWinner: {
          deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
          createMany: txWinnerCreateMany,
        },
        managedGiveawayWinnerNotification: {
          createMany: txNotificationCreateMany,
        },
      }),
    );
    maxClient.hasChatMember
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true);
    maxClient.editMessageInlineKeyboard.mockResolvedValue(undefined);
    maxClient.sendMessageImmediateToUser.mockResolvedValue(undefined);

    await (service as any).drawGiveaway('giveaway-1', 'runner');

    expect(txManagedEntryUpdate).toHaveBeenCalledWith({
      where: { id: 'entry-removed' },
      data: expect.objectContaining({
        eligibilityState: GiveawayEligibilityState.REJECTED,
        missingChannelIds: ['source-1'],
      }),
    });
    expect(txManagedEntryUpdate).toHaveBeenCalledWith({
      where: { id: 'entry-late' },
      data: expect.objectContaining({
        eligibilityState: GiveawayEligibilityState.VERIFIED,
        missingChannelIds: [],
      }),
    });
    expect(txWinnerCreateMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          id: expect.any(String),
          entryId: 'entry-active',
          prizeId: 'prize-1',
        }),
      ],
    });
    expect(txNotificationCreateMany).toHaveBeenCalledWith({
      data: [
        {
          winnerId: txWinnerCreateMany.mock.calls[0][0].data[0].id,
          nextAttemptAt: new Date('2026-03-21T13:00:00.000Z'),
        },
      ],
    });
    expect(outboxSpy).toHaveBeenCalledWith('runner', 'giveaway-1', 20, {
      winnerIds: [txWinnerCreateMany.mock.calls[0][0].data[0].id],
    });
  });

  it('defers draw without changing entries or selecting winners on transient recheck failures', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-21T13:05:00.000Z'));

    const prisma = createPrismaMock();
    const maxClient = createMaxClientMock();
    const service = new ManagedGiveawayService(
      prisma as never,
      maxClient as never,
      { invalidate: jest.fn() } as never,
      {} as never,
      createConfigMock() as never,
    );

    const verifiedEntry = createEntry({
      id: 'entry-verified',
      userId: 'winner-1',
      displayName: 'Проверенный',
      eligibilityState: GiveawayEligibilityState.VERIFIED,
      eligibilityReason: null,
      missingChannelIds: [],
    });
    const prize = createPrize();
    const initial = createGiveaway({
      requiredChannelIds: [],
      prizes: [prize],
      entries: [verifiedEntry],
      drawSeed: 'seed-2',
      resultsMessageId: 'results-1',
    });
    const drawStarted = createGiveaway({
      ...initial,
      status: ManagedGiveawayStatus.DRAWING,
      drawSeed: 'seed-2',
      drawnAt: new Date('2026-03-21T13:05:00.000Z'),
      lockedAt: new Date('2026-03-21T13:05:00.000Z'),
    });
    const refreshedEntry = {
      ...verifiedEntry,
      checkedAt: new Date('2026-03-21T13:05:00.000Z'),
      drawRank: 'draw-rank-verified',
    };
    const completed = createGiveaway({
      ...initial,
      status: ManagedGiveawayStatus.COMPLETED,
      drawSeed: 'seed-2',
      drawnAt: new Date('2026-03-21T13:05:00.000Z'),
      completedAt: new Date('2026-03-21T13:05:00.000Z'),
      entries: [refreshedEntry],
      winners: [
        createWinner({
          prize,
          prizeId: prize.id,
          entry: refreshedEntry,
          entryId: refreshedEntry.id,
          status: ManagedGiveawayWinnerStatus.SELECTED,
          selectedAt: new Date('2026-03-21T13:05:00.000Z'),
          claimedAt: null,
          claimDeadlineAt: new Date('2026-03-23T13:05:00.000Z'),
        }),
      ],
    });

    const prismaEntryUpdate = jest.fn().mockImplementation(async ({ data }) => ({
      ...verifiedEntry,
      ...data,
    }));
    const txManagedEntryUpdate = jest.fn().mockImplementation(async ({ data }) => ({
      ...verifiedEntry,
      ...data,
    }));
    const txWinnerCreateMany = jest.fn().mockResolvedValue({ count: 1 });
    const txNotificationCreateMany = jest.fn().mockResolvedValue({ count: 1 });
    const outboxSpy = jest.spyOn(service as any, 'processWinnerNotificationOutbox');

    prisma.managedGiveaway.updateMany.mockResolvedValueOnce({ count: 1 });
    prisma.managedGiveaway.findUnique
      .mockResolvedValueOnce(initial)
      .mockResolvedValueOnce(drawStarted)
      .mockResolvedValueOnce(completed);
    prisma.managedGiveawayEntry.update = prismaEntryUpdate;
    prisma.$transaction.mockImplementation(async (callback) =>
      callback({
        managedGiveaway: {
          update: jest.fn().mockResolvedValue(undefined),
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
          findUniqueOrThrow: jest.fn().mockResolvedValue(completed),
        },
        managedGiveawayEntry: {
          update: txManagedEntryUpdate,
        },
        managedGiveawayWinner: {
          deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
          createMany: txWinnerCreateMany,
        },
        managedGiveawayWinnerNotification: {
          createMany: txNotificationCreateMany,
        },
      }),
    );
    maxClient.hasChatMember.mockRejectedValueOnce(new Error('temporary MAX failure'));
    maxClient.editMessageInlineKeyboard.mockRejectedValue(
      new Error('giveaway results edit unavailable'),
    );
    maxClient.sendMessageImmediateToUser.mockResolvedValue(undefined);

    await expect((service as any).drawGiveaway('giveaway-1', 'runner')).rejects.toBeInstanceOf(
      ManagedGiveawayMembershipLookupUnavailableError,
    );
    expect(prismaEntryUpdate).not.toHaveBeenCalled();
    expect(txManagedEntryUpdate).not.toHaveBeenCalled();
    expect(txWinnerCreateMany).not.toHaveBeenCalled();
    expect(txNotificationCreateMany).not.toHaveBeenCalled();
    expect(prisma.managedGiveaway.updateMany).toHaveBeenLastCalledWith({
      where: {
        id: 'giveaway-1',
        status: ManagedGiveawayStatus.DRAWING,
        lockedAt: drawStarted.lockedAt,
        drawSeed: 'seed-2',
      },
      data: { status: ManagedGiveawayStatus.DRAWING, lockedAt: null, sendLockKey: null },
    });
    expect(outboxSpy).not.toHaveBeenCalled();
  });

  it('uses shared batch membership lookups during draw when the lookup service is available', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-21T13:10:00.000Z'));

    const prisma = createPrismaMock();
    const maxClient = createMaxClientMock();
    const membershipLookup = {
      getMemberships: jest.fn().mockImplementation(async (chatId: string) => {
        if (chatId === 'source-1' || chatId === 'extra-1') {
          return new Map([['user-1', true]]);
        }

        return new Map();
      }),
    };
    const service = new ManagedGiveawayService(
      prisma as never,
      maxClient as never,
      { invalidate: jest.fn() } as never,
      {} as never,
      createConfigMock() as never,
      membershipLookup as never,
    );

    const entry = createEntry({
      id: 'entry-batch-1',
      eligibilityState: GiveawayEligibilityState.VERIFIED,
      eligibilityReason: null,
      missingChannelIds: [],
    });
    const prize = createPrize();
    const initial = createGiveaway({
      requiredChannelIds: ['extra-1'],
      prizes: [prize],
      entries: [entry],
      drawSeed: 'seed-batch',
      resultsMessageId: 'results-batch-1',
    });
    const drawStarted = createGiveaway({
      ...initial,
      status: ManagedGiveawayStatus.DRAWING,
      drawSeed: 'seed-batch',
      drawnAt: new Date('2026-03-21T13:10:00.000Z'),
      lockedAt: new Date('2026-03-21T13:10:00.000Z'),
    });
    const refreshedEntry = {
      ...entry,
      checkedAt: new Date('2026-03-21T13:10:00.000Z'),
      drawRank: 'draw-rank-batch',
    };
    const completed = createGiveaway({
      ...initial,
      status: ManagedGiveawayStatus.COMPLETED,
      drawSeed: 'seed-batch',
      drawnAt: new Date('2026-03-21T13:10:00.000Z'),
      completedAt: new Date('2026-03-21T13:10:00.000Z'),
      entries: [refreshedEntry],
      winners: [
        createWinner({
          prize,
          prizeId: prize.id,
          entry: refreshedEntry,
          entryId: refreshedEntry.id,
          status: ManagedGiveawayWinnerStatus.SELECTED,
          selectedAt: new Date('2026-03-21T13:10:00.000Z'),
          claimedAt: null,
          claimDeadlineAt: new Date('2026-03-23T13:10:00.000Z'),
        }),
      ],
    });

    prisma.managedGiveaway.updateMany.mockResolvedValueOnce({ count: 1 });
    prisma.managedGiveaway.findUnique
      .mockResolvedValueOnce(initial)
      .mockResolvedValueOnce(drawStarted)
      .mockResolvedValueOnce(completed);
    prisma.managedGiveawayEntry.update = jest.fn().mockImplementation(async ({ data }) => ({
      ...entry,
      ...data,
    }));
    prisma.$transaction.mockImplementation(async (callback) =>
      callback({
        managedGiveaway: {
          update: jest.fn().mockResolvedValue(undefined),
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
          findUniqueOrThrow: jest.fn().mockResolvedValue(completed),
        },
        managedGiveawayEntry: {
          update: jest.fn().mockImplementation(async ({ data }) => ({
            ...entry,
            ...data,
          })),
        },
        managedGiveawayWinner: {
          deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
          createMany: jest.fn().mockResolvedValue({ count: 1 }),
        },
        managedGiveawayWinnerNotification: {
          createMany: jest.fn().mockResolvedValue({ count: 1 }),
        },
      }),
    );
    maxClient.editMessageInlineKeyboard.mockResolvedValue(undefined);
    maxClient.sendMessageImmediateToUser.mockResolvedValue(undefined);

    await (service as any).drawGiveaway('giveaway-1', 'runner');

    expect(membershipLookup.getMemberships).toHaveBeenCalledTimes(2);
    expect(membershipLookup.getMemberships).toHaveBeenNthCalledWith(
      1,
      'source-1',
      ['user-1'],
      'giveaway_draw_background',
      {
        forceRefresh: true,
        allowStaleOnError: false,
      },
    );
    expect(membershipLookup.getMemberships).toHaveBeenNthCalledWith(
      2,
      'extra-1',
      ['user-1'],
      'giveaway_draw_background',
      {
        forceRefresh: true,
        allowStaleOnError: false,
      },
    );
    expect(maxClient.hasChatMember).not.toHaveBeenCalled();
  });

  it('drains completed winner notification intents on every runner pass', async () => {
    const prisma = createPrismaMock();
    const service = new ManagedGiveawayService(
      prisma as never,
      createMaxClientMock() as never,
      createChatContextCacheMock() as never,
      {} as never,
      createConfigMock() as never,
    );
    const outboxSpy = jest
      .spyOn(service as any, 'processWinnerNotificationOutbox')
      .mockResolvedValue(undefined);

    await service.processDueManagedGiveaways('scheduled');

    expect(outboxSpy).toHaveBeenCalledWith('runner', undefined, 20, {
      synchronizeResultsBeforeDispatch: true,
    });
  });

  it('skips due giveaways that are already under retry backoff', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-21T13:20:00.000Z'));

    try {
      const prisma = createPrismaMock();
      prisma.$queryRaw.mockResolvedValueOnce([
        createDueGiveawayRow({ id: 'giveaway-1' }),
        createDueGiveawayRow({ id: 'giveaway-2' }),
      ]);

      const chatContextCache = createChatContextCacheMock({
        giveawayBackoffRemainingById: new Map([['giveaway-1', 45_000]]),
      });
      const service = new ManagedGiveawayService(
        prisma as never,
        createMaxClientMock() as never,
        chatContextCache as never,
        {} as never,
        createConfigMock() as never,
      );
      const processSpy = jest
        .spyOn(service as any, 'processDueManagedGiveaway')
        .mockResolvedValue(undefined);

      await service.processDueManagedGiveaways('scheduled');

      expect(processSpy).toHaveBeenCalledTimes(1);
      expect(processSpy).toHaveBeenCalledWith('giveaway-2', 'scheduled', expect.any(Date));
    } finally {
      jest.useRealTimers();
    }
  });

  it('pauses due giveaways when the background governor is unavailable', async () => {
    const prisma = createPrismaMock();
    const backgroundRuntimeGovernor = {
      decide: jest.fn().mockRejectedValue(new Error('timeout exceeded when trying to connect')),
    };
    const service = new ManagedGiveawayService(
      prisma as never,
      createMaxClientMock() as never,
      createChatContextCacheMock() as never,
      {} as never,
      createConfigMock() as never,
      undefined,
      undefined,
      undefined,
      backgroundRuntimeGovernor as never,
    );
    const processSpy = jest
      .spyOn(service as any, 'processDueManagedGiveaway')
      .mockResolvedValue(undefined);

    await service.processDueManagedGiveaways('scheduled');

    expect(backgroundRuntimeGovernor.decide).toHaveBeenCalledWith({
      component: 'managed-giveaway',
      sourceTag: 'giveaway_draw_background',
    });
    expect(prisma.managedGiveawayWinner.findMany).not.toHaveBeenCalled();
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
    expect(processSpy).not.toHaveBeenCalled();
  });

  it('skips due giveaways for chats with bot-denied access edges', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-21T13:22:00.000Z'));

    try {
      const prisma = createPrismaMock();
      prisma.$queryRaw.mockResolvedValueOnce([
        createDueGiveawayRow({ id: 'giveaway-denied', sourceChatId: 'source-denied' }),
        createDueGiveawayRow({ id: 'giveaway-open', sourceChatId: 'source-open' }),
      ]);
      prisma.managedEntityAccessEdge.findMany
        .mockResolvedValueOnce([{ chatId: 'source-denied', botId: 'lost-bot' }])
        .mockResolvedValueOnce([]);

      const service = new ManagedGiveawayService(
        prisma as never,
        createMaxClientMock() as never,
        createChatContextCacheMock() as never,
        {} as never,
        createConfigMock() as never,
      );
      const processSpy = jest
        .spyOn(service as any, 'processDueManagedGiveaway')
        .mockResolvedValue(undefined);

      await service.processDueManagedGiveaways('scheduled');

      expect(prisma.managedEntityAccessEdge.findMany).toHaveBeenCalledWith({
        where: {
          chatId: { in: ['source-denied', 'source-open'] },
          state: ManagedEntityAccessState.BOT_DENIED,
        },
        select: { chatId: true, botId: true },
      });
      expect(processSpy).toHaveBeenCalledTimes(1);
      expect(processSpy).toHaveBeenCalledWith('giveaway-open', 'scheduled', expect.any(Date));
    } finally {
      jest.useRealTimers();
    }
  });

  it('still skips due giveaways when a fresh granted edge lacks active bot membership', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-21T13:22:00.000Z'));

    try {
      const prisma = createPrismaMock();
      prisma.$queryRaw.mockResolvedValueOnce([
        createDueGiveawayRow({ id: 'giveaway-denied', sourceChatId: 'source-denied' }),
      ]);
      prisma.managedEntityAccessEdge.findMany
        .mockResolvedValueOnce([{ chatId: 'source-denied', botId: 'lost-bot' }])
        .mockResolvedValueOnce([{ chatId: 'source-denied', botId: 'active-bot' }]);

      const service = new ManagedGiveawayService(
        prisma as never,
        createMaxClientMock() as never,
        createChatContextCacheMock() as never,
        {} as never,
        createConfigMock() as never,
      );
      const processSpy = jest
        .spyOn(service as any, 'processDueManagedGiveaway')
        .mockResolvedValue(undefined);

      await service.processDueManagedGiveaways('scheduled');

      expect(processSpy).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it('keeps due giveaways running when a fresh granted edge matches active bot membership', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-21T13:22:00.000Z'));

    try {
      const prisma = createPrismaMock();
      prisma.$queryRaw.mockResolvedValueOnce([
        createDueGiveawayRow({ id: 'giveaway-shared', sourceChatId: 'source-shared' }),
      ]);
      prisma.managedEntityAccessEdge.findMany
        .mockResolvedValueOnce([{ chatId: 'source-shared', botId: 'lost-bot' }])
        .mockResolvedValueOnce([{ chatId: 'source-shared', botId: 'active-bot' }]);
      prisma.chatBotMembership.findMany.mockResolvedValue([
        {
          chatId: 'source-shared',
          botId: 'active-bot',
          status: ChatBotMembershipStatus.ACTIVE,
          permissionsSnapshot: null,
        },
        {
          chatId: 'source-shared',
          botId: 'lost-bot',
          status: ChatBotMembershipStatus.REMOVED,
          permissionsSnapshot: null,
        },
      ]);

      const service = new ManagedGiveawayService(
        prisma as never,
        createMaxClientMock() as never,
        createChatContextCacheMock() as never,
        {} as never,
        createConfigMock() as never,
      );
      const processSpy = jest
        .spyOn(service as any, 'processDueManagedGiveaway')
        .mockResolvedValue(undefined);

      await service.processDueManagedGiveaways('scheduled');

      expect(processSpy).toHaveBeenCalledTimes(1);
      expect(processSpy).toHaveBeenCalledWith('giveaway-shared', 'scheduled', expect.any(Date));
    } finally {
      jest.useRealTimers();
    }
  });

  it('keeps due giveaways running when another bot still has confirmed admin access', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-21T13:22:00.000Z'));

    try {
      const prisma = createPrismaMock();
      prisma.$queryRaw.mockResolvedValueOnce([
        createDueGiveawayRow({ id: 'giveaway-shared', sourceChatId: 'source-shared' }),
      ]);
      prisma.managedEntityAccessEdge.findMany
        .mockResolvedValueOnce([{ chatId: 'source-shared', botId: 'lost-bot' }])
        .mockResolvedValueOnce([]);
      prisma.chatBotMembership.findMany.mockResolvedValue([
        {
          chatId: 'source-shared',
          botId: 'active-bot',
          status: ChatBotMembershipStatus.ACTIVE,
          permissionsSnapshot: {
            isAdmin: true,
            isOwner: false,
            permissions: [],
          },
        },
        {
          chatId: 'source-shared',
          botId: 'lost-bot',
          status: ChatBotMembershipStatus.REMOVED,
          permissionsSnapshot: null,
        },
      ]);

      const service = new ManagedGiveawayService(
        prisma as never,
        createMaxClientMock() as never,
        createChatContextCacheMock() as never,
        {} as never,
        createConfigMock() as never,
      );
      const processSpy = jest
        .spyOn(service as any, 'processDueManagedGiveaway')
        .mockResolvedValue(undefined);

      await service.processDueManagedGiveaways('scheduled');

      expect(processSpy).toHaveBeenCalledTimes(1);
      expect(processSpy).toHaveBeenCalledWith('giveaway-shared', 'scheduled', expect.any(Date));
    } finally {
      jest.useRealTimers();
    }
  });

  it('skips due giveaways that are already under extended retry defer', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-21T13:25:00.000Z'));

    try {
      const prisma = createPrismaMock();
      prisma.$queryRaw.mockResolvedValueOnce([
        createDueGiveawayRow({ id: 'giveaway-1' }),
        createDueGiveawayRow({ id: 'giveaway-2' }),
      ]);

      const chatContextCache = createChatContextCacheMock({
        giveawayDeferRemainingById: new Map([['giveaway-1', 15 * 60_000]]),
      });
      const service = new ManagedGiveawayService(
        prisma as never,
        createMaxClientMock() as never,
        chatContextCache as never,
        {} as never,
        createConfigMock() as never,
      );
      const processSpy = jest
        .spyOn(service as any, 'processDueManagedGiveaway')
        .mockResolvedValue(undefined);

      await service.processDueManagedGiveaways('scheduled');

      expect(processSpy).toHaveBeenCalledTimes(1);
      expect(processSpy).toHaveBeenCalledWith('giveaway-2', 'scheduled', expect.any(Date));
    } finally {
      jest.useRealTimers();
    }
  });

  it('continues after the inspected candidate when a per-candidate read fails', async () => {
    const initialNow = new Date('2026-03-21T13:25:00.000Z');
    jest.useFakeTimers().setSystemTime(initialNow);

    try {
      const prisma = createPrismaMock();
      const first = createDueGiveawayRow({ id: 'giveaway-1' });
      const second = createDueGiveawayRow({ id: 'giveaway-2' });
      prisma.$queryRaw
        .mockResolvedValueOnce([first, second])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([second]);
      const service = new ManagedGiveawayService(
        prisma as never,
        createMaxClientMock() as never,
        createChatContextCacheMock() as never,
        {} as never,
        createConfigMock() as never,
      );
      const runner = service as unknown as ManagedGiveawayRunnerMethods;
      const readError = new Error('candidate read unavailable');
      jest
        .spyOn(runner, 'getManagedGiveawayRunnerDeferRemainingMs')
        .mockRejectedValueOnce(readError)
        .mockResolvedValue(0);
      const processSpy = jest
        .spyOn(runner, 'processDueManagedGiveaway')
        .mockResolvedValue(undefined);

      await expect(service.processDueManagedGiveaways('scheduled')).rejects.toBe(readError);
      expect(processSpy).not.toHaveBeenCalled();
      jest.setSystemTime(new Date(initialNow.getTime() + 60_000));
      await service.processDueManagedGiveaways('scheduled');

      expect(processSpy).toHaveBeenCalledTimes(1);
      expect(processSpy).toHaveBeenCalledWith(second.id, 'scheduled', expect.any(Date));
      const resumed = getDuePageQueries(prisma).at(-1)!;
      expect(resumed.text).toContain('source."starts_at" AS "dueAt"');
      expect(resumed.values).toContainEqual(initialNow);
      expect(resumed.values).toContainEqual(first.dueAt);
      expect(resumed.values).toContain(first.id);
      expect(resumed.values).not.toContain(second.id);
    } finally {
      jest.useRealTimers();
    }
  });

  it('retains the whole page when its batch access read fails', async () => {
    const initialNow = new Date('2026-03-21T13:25:00.000Z');
    jest.useFakeTimers().setSystemTime(initialNow);

    try {
      const prisma = createPrismaMock();
      const rows = [
        createDueGiveawayRow({ id: 'giveaway-1' }),
        createDueGiveawayRow({ id: 'giveaway-2' }),
      ];
      prisma.$queryRaw
        .mockResolvedValueOnce(rows)
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce(rows);
      const readError = new Error('access read unavailable');
      prisma.managedEntityAccessEdge.findMany.mockRejectedValueOnce(readError);
      const service = new ManagedGiveawayService(
        prisma as never,
        createMaxClientMock() as never,
        createChatContextCacheMock() as never,
        {} as never,
        createConfigMock() as never,
      );
      const runner = service as unknown as ManagedGiveawayRunnerMethods;
      const processSpy = jest
        .spyOn(runner, 'processDueManagedGiveaway')
        .mockResolvedValue(undefined);

      await expect(service.processDueManagedGiveaways('scheduled')).rejects.toBe(readError);
      expect(processSpy).not.toHaveBeenCalled();
      jest.setSystemTime(new Date(initialNow.getTime() + 60_000));
      await service.processDueManagedGiveaways('scheduled');

      expect(processSpy.mock.calls.map(([id]) => id)).toEqual(rows.map(({ id }) => id));
      const resumed = getDuePageQueries(prisma).at(-1)!;
      expect(resumed.text).toContain('source."starts_at" AS "dueAt"');
      expect(resumed.values).toContainEqual(initialNow);
      for (const row of rows) {
        expect(resumed.values).not.toContain(row.id);
      }
    } finally {
      jest.useRealTimers();
    }
  });

  it('preserves the sweep cutoff, cursor and family rotation across a governor pause', async () => {
    const initialNow = new Date('2026-03-21T13:25:00.000Z');
    jest.useFakeTimers().setSystemTime(initialNow);

    try {
      const prisma = createPrismaMock();
      const firstPage = Array.from({ length: 20 }, (_, index) =>
        createDueGiveawayRow({ id: `giveaway-${String(index).padStart(3, '0')}` }),
      );
      const tail = createDueGiveawayRow({ id: 'giveaway-020' });
      prisma.$queryRaw
        .mockResolvedValueOnce(firstPage)
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([tail]);
      const backgroundRuntimeGovernor = {
        decide: jest
          .fn()
          .mockResolvedValueOnce({ action: 'run', retryAfterMs: 0, reason: 'available' })
          .mockResolvedValueOnce({ action: 'pause', retryAfterMs: 60_000, reason: 'pressure' })
          .mockResolvedValueOnce({ action: 'run', retryAfterMs: 0, reason: 'available' }),
      };
      const service = new ManagedGiveawayService(
        prisma as never,
        createMaxClientMock() as never,
        createChatContextCacheMock() as never,
        {} as never,
        createConfigMock() as never,
        undefined,
        undefined,
        undefined,
        backgroundRuntimeGovernor as never,
      );
      const runner = service as unknown as ManagedGiveawayRunnerMethods;
      const processSpy = jest
        .spyOn(runner, 'processDueManagedGiveaway')
        .mockResolvedValue(undefined);

      await service.processDueManagedGiveaways('scheduled');
      expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
      expect(processSpy).toHaveBeenCalledTimes(20);
      await service.processDueManagedGiveaways('scheduled');
      expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
      expect(processSpy).toHaveBeenCalledTimes(20);
      jest.setSystemTime(new Date(initialNow.getTime() + 120_000));
      await service.processDueManagedGiveaways('scheduled');

      const queries = getDuePageQueries(prisma);
      expect(queries).toHaveLength(5);
      expect(queries[1]!.text).toContain('source."ends_at" AS "dueAt"');
      expect(queries[1]!.values).toContain('SCHEDULED');
      expect(queries[4]!.text).toContain('source."starts_at" AS "dueAt"');
      expect(queries[4]!.values).toContainEqual(initialNow);
      expect(queries[4]!.values).toContain(firstPage.at(-1)!.id);
      expect(processSpy.mock.calls.map(([id]) => id)).toEqual([
        ...firstPage.map(({ id }) => id),
        tail.id,
      ]);
    } finally {
      jest.useRealTimers();
    }
  });

  it.each([0, -1, 21, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects the unbounded due page size %s',
    (take) => {
      expect(() =>
        buildManagedGiveawayDuePageQuery({
          family: 'activeEnd',
          cutoff: new Date(),
          after: null,
          take,
        }),
      ).toThrow('integer take between 1 and 20');
    },
  );

  it('expires selected winners whose claim deadline has passed before processing due giveaways', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-23T13:30:00.000Z'));

    try {
      const prisma = createPrismaMock();
      prisma.managedGiveawayWinner.findMany.mockResolvedValueOnce([
        { id: 'winner-1', giveawayId: 'giveaway-1' },
      ]);
      prisma.managedGiveaway.findMany.mockResolvedValueOnce([
        { id: 'giveaway-1', sourceChatId: 'source-1' },
      ] satisfies Prisma.ManagedGiveawayGetPayload<{
        select: { id: true; sourceChatId: true };
      }>[]);
      prisma.managedGiveaway.findUnique.mockResolvedValue(
        createGiveaway({
          status: ManagedGiveawayStatus.COMPLETED,
          winners: [createWinner()],
          resultsMessageId: 'results-1',
        }),
      );
      const service = new ManagedGiveawayService(
        prisma as never,
        createMaxClientMock() as never,
        createChatContextCacheMock() as never,
        {} as never,
        createConfigMock() as never,
      );
      jest.spyOn(service as any, 'editGiveawayPublicationIfNeeded').mockResolvedValue(undefined);
      jest.spyOn(service as any, 'republishGiveawayResults').mockResolvedValue(undefined);

      await service.processDueManagedGiveaways('scheduled');

      expect(prisma.managedGiveawayWinner.updateMany).toHaveBeenCalledWith({
        where: {
          id: { in: ['winner-1'] },
          status: ManagedGiveawayWinnerStatus.SELECTED,
        },
        data: {
          status: ManagedGiveawayWinnerStatus.EXPIRED,
          expiredAt: new Date('2026-03-23T13:30:00.000Z'),
        },
      });
      expect((service as any).republishGiveawayResults).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });

  it('applies a longer terminal defer and clears short retry state after terminal lookup failures', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-21T13:25:00.000Z'));

    try {
      const prisma = createPrismaMock();
      prisma.managedGiveaway.updateMany.mockResolvedValue({ count: 1 });
      prisma.managedGiveaway.findUnique.mockResolvedValue(
        createGiveaway({
          endsAt: new Date('2026-03-21T13:00:00.000Z'),
        }),
      );

      const chatContextCache = createChatContextCacheMock();
      const service = new ManagedGiveawayService(
        prisma as never,
        createMaxClientMock() as never,
        chatContextCache as never,
        {} as never,
        createConfigMock() as never,
      );
      jest
        .spyOn(service as any, 'drawGiveaway')
        .mockRejectedValue(
          new ManagedGiveawayMembershipLookupUnavailableError('terminal', 'source-1', 30 * 60_000),
        );

      await expect(
        (service as any).processDueManagedGiveaway(
          'giveaway-1',
          'scheduled',
          new Date('2026-03-21T13:24:00.000Z'),
        ),
      ).resolves.toBeUndefined();

      expect(chatContextCache.activateManagedGiveawayRunnerDefer).toHaveBeenCalledWith(
        'giveaway-1',
        2 * 60 * 60,
      );
      expect(chatContextCache.clearManagedGiveawayRunnerRetryCounters).toHaveBeenCalledWith(
        'giveaway-1',
      );
      expect(chatContextCache.incrementManagedGiveawayRunnerFailureCount).not.toHaveBeenCalled();
      expect(prisma.managedGiveaway.updateMany).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it('escalates runner membership lookup retries from backoff to defer after repeated failures', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-21T13:25:00.000Z'));

    try {
      const prisma = createPrismaMock();
      prisma.managedGiveaway.updateMany.mockResolvedValue({ count: 1 });
      prisma.managedGiveaway.findUnique.mockResolvedValue(
        createGiveaway({
          endsAt: new Date('2026-03-21T13:00:00.000Z'),
        }),
      );

      const chatContextCache = createChatContextCacheMock();
      const service = new ManagedGiveawayService(
        prisma as never,
        createMaxClientMock() as never,
        chatContextCache as never,
        {} as never,
        createConfigMock() as never,
      );
      jest
        .spyOn(service as any, 'drawGiveaway')
        .mockRejectedValue(
          new BadRequestException('Не удалось проверить участие в исходном чате. Повторите позже.'),
        );

      await expect(
        (service as any).processDueManagedGiveaway(
          'giveaway-1',
          'scheduled',
          new Date('2026-03-21T13:24:00.000Z'),
        ),
      ).resolves.toBeUndefined();
      await expect(
        (service as any).processDueManagedGiveaway(
          'giveaway-1',
          'scheduled',
          new Date('2026-03-21T13:24:00.000Z'),
        ),
      ).resolves.toBeUndefined();
      await expect(
        (service as any).processDueManagedGiveaway(
          'giveaway-1',
          'scheduled',
          new Date('2026-03-21T13:24:00.000Z'),
        ),
      ).resolves.toBeUndefined();
      await expect(
        (service as any).processDueManagedGiveaway(
          'giveaway-1',
          'scheduled',
          new Date('2026-03-21T13:24:00.000Z'),
        ),
      ).resolves.toBeUndefined();

      expect(chatContextCache.incrementManagedGiveawayRunnerFailureCount).toHaveBeenNthCalledWith(
        1,
        'giveaway-1',
        6 * 60 * 60,
      );
      expect(chatContextCache.activateManagedGiveawayRunnerBackoff).toHaveBeenNthCalledWith(
        1,
        'giveaway-1',
        60,
      );
      expect(chatContextCache.activateManagedGiveawayRunnerBackoff).toHaveBeenNthCalledWith(
        2,
        'giveaway-1',
        120,
      );
      expect(chatContextCache.activateManagedGiveawayRunnerBackoff).toHaveBeenNthCalledWith(
        3,
        'giveaway-1',
        240,
      );
      expect(chatContextCache.activateManagedGiveawayRunnerDefer).toHaveBeenCalledWith(
        'giveaway-1',
        30 * 60,
      );
      expect(chatContextCache.clearManagedGiveawayRunnerRetryCounters).toHaveBeenCalledWith(
        'giveaway-1',
      );
      expect(prisma.managedGiveaway.updateMany).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });
});
