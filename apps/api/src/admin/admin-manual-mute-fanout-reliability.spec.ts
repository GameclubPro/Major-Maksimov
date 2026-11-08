import {
  BadRequestException,
  ForbiddenException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { MaxApiCircuitOpenError } from '../max/max-client.service';
import {
  createAdminMaxBotLinkMock,
  createChatContextCacheMock,
  createConfigMock,
  createPrismaMock,
  createAdminServiceFixture,
} from './admin-service-test-support';

type PrismaMock = ReturnType<typeof createPrismaMock>;

function configureFanoutChats(prisma: PrismaMock, chatIds: readonly string[]): void {
  prisma.chatAdminAllowlist.findMany.mockResolvedValue(
    chatIds.map((chatId, index) => ({
      userId: 'admin-1',
      chatId,
      chat: {
        id: chatId,
        title: `Chat ${chatId}`,
        createdAt: new Date(`2026-03-${String(index + 2).padStart(2, '0')}T00:00:00.000Z`),
        entityType: 'CHAT',
      },
    })),
  );
}

function buildMuteFanoutJob(jobId: string, targetUserId = 'user-2') {
  return {
    kind: 'manual_mute_fanout' as const,
    jobId,
    sourceChatId: 'chat-1',
    targetUserId,
    cleanupSourceChatMessages: false,
    actor: {
      userId: 'admin-1',
      username: null,
      displayName: null,
      chatId: null,
      chatTitle: null,
    },
    muteDurationHours: 6,
    muteExpiresAt: '2026-04-08T22:18:25.418Z',
    mutePermanent: false,
    source: 'group_command' as const,
  };
}

function createActionableBotRegistry(botIds: readonly string[]) {
  return {
    isKnownBotUserId: jest.fn().mockReturnValue(false),
    getBotById: jest.fn((botId?: string | null) =>
      botId && botIds.includes(botId) ? { id: botId } : null,
    ),
    getDefaultBot: jest.fn().mockReturnValue(botIds[0] ? { id: botIds[0] } : null),
    getActionableBots: jest.fn().mockReturnValue(botIds.map((id) => ({ id }))),
    getOperationalBots: jest.fn().mockReturnValue(botIds.map((id) => ({ id }))),
    getDiscoveryBots: jest.fn().mockReturnValue([]),
  };
}

describe('AdminService manual mute fanout reliability', () => {
  it.each([
    [
      'forbidden',
      new ForbiddenException(
        'Не найден бот MAX с подтвержденным правом выполнить действие модерации в этом чате.',
      ),
    ],
    ['bad request', new BadRequestException('Маршрут модерации недоступен для этого чата.')],
  ])('continues after a terminal %s route failure', async (_label, routeError) => {
    const prisma = createPrismaMock();
    configureFanoutChats(prisma, ['chat-2', 'chat-3']);
    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      getCurrentChatMemberAccess: jest.fn().mockResolvedValue({
        userId: 'bot-3',
        isAdmin: true,
        isOwner: false,
        permissions: ['read_all_messages', 'write'],
      }),
      getChatMemberAccess: jest.fn().mockResolvedValue({
        userId: 'user-3',
        isAdmin: false,
        isOwner: false,
        permissions: [],
      }),
    };
    const service = createAdminServiceFixture(
      prisma as never,
      maxClient as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
    );
    const resolveRoute = jest
      .spyOn(service as any, 'resolveManualModerationActionBotAssignment')
      .mockImplementation(async (...args: unknown[]) => {
        const [chatId, action] = args as [string, string];
        if (chatId === 'chat-2' && action === 'delete_message') {
          throw routeError;
        }
        return 'bot-3';
      });

    await expect(
      service.processManualModerationFanoutJob(
        buildMuteFanoutJob('job-mute-partial-route-1', 'user-3'),
      ),
    ).resolves.toBeUndefined();

    await expect(
      prisma.manualModerationFanoutLedgerEntry.findMany({
        where: { operation: 'FANOUT_MUTE_RECORD' },
      }),
    ).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ targetChatId: 'chat-2', status: 'FAILED_TERMINAL' }),
        expect.objectContaining({ targetChatId: 'chat-3', status: 'SUCCEEDED' }),
      ]),
    );
    expect(
      prisma.manualModerationFanoutLedgerEntry.createMany.mock.invocationCallOrder[0],
    ).toBeLessThan(resolveRoute.mock.invocationCallOrder[0]);
    expect(prisma.moderationEvent.create).toHaveBeenCalledTimes(1);
  });

  it('terminalizes permission failures under the claimed target ledger', async () => {
    const prisma = createPrismaMock();
    configureFanoutChats(prisma, ['chat-2']);
    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      getCurrentChatMemberAccess: jest.fn().mockResolvedValue({
        userId: 'bot-2',
        isAdmin: true,
        isOwner: false,
        permissions: ['read_all_messages'],
      }),
    };
    const service = createAdminServiceFixture(
      prisma as never,
      maxClient as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
    );
    jest
      .spyOn(service as any, 'resolveManualModerationActionBotAssignment')
      .mockResolvedValue('bot-2');

    await expect(
      service.processManualModerationFanoutJob(
        buildMuteFanoutJob('job-mute-terminal-permission-1'),
      ),
    ).resolves.toBeUndefined();

    await expect(
      prisma.manualModerationFanoutLedgerEntry.findMany({
        where: { operation: 'FANOUT_MUTE_RECORD', targetChatId: 'chat-2' },
      }),
    ).resolves.toEqual([
      expect.objectContaining({ status: 'FAILED_TERMINAL', terminal: true, lockToken: null }),
    ]);
  });

  it.each([
    [
      'HTTP 502',
      Object.assign(new Error('Request failed with status code 502'), {
        response: { status: 502, data: { code: 'server.failure', message: 'Bad Gateway' } },
      }),
    ],
    ['circuit open', new MaxApiCircuitOpenError('bot-1', 30_000)],
    [
      'HTTP 429',
      Object.assign(new Error('Request failed with status code 429'), {
        response: { status: 429, data: { code: 'rate.limited', message: 'Too Many Requests' } },
      }),
    ],
    ['timeout', Object.assign(new Error('MAX lookup timeout'), { code: 'ECONNABORTED' })],
  ])('stops bot probing and durably retries after %s', async (_label, lookupError) => {
    const prisma = createPrismaMock();
    configureFanoutChats(prisma, ['chat-2']);
    const getCurrentChatMemberAccess = jest.fn().mockRejectedValue(lookupError);
    const maxBotLinkService = createAdminMaxBotLinkMock({
      resolveBotRoutes: jest.fn().mockResolvedValue({
        purpose: 'moderation_action',
        chatId: 'chat-2',
        primaryBotId: 'bot-1',
        botId: 'bot-1',
        candidateBotIds: ['bot-1', 'bot-2'],
        reason: 'primary_confirmed',
        action: 'delete_message',
      }),
    });
    const maxBotRegistry = createActionableBotRegistry(['bot-1', 'bot-2']);
    const service = createAdminServiceFixture(
      prisma as never,
      {
        getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
        getCurrentChatMemberAccess,
      } as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
      undefined,
      undefined,
      undefined,
      undefined,
      maxBotLinkService as never,
      maxBotRegistry as never,
    );

    await expect(
      service.processManualModerationFanoutJob(buildMuteFanoutJob(`job-mute-${_label}`)),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);

    expect(getCurrentChatMemberAccess).toHaveBeenCalledTimes(1);
    expect(getCurrentChatMemberAccess).toHaveBeenCalledWith(
      'chat-2',
      expect.objectContaining({ botId: 'bot-1', bypassCache: true }),
    );
    await expect(
      prisma.manualModerationFanoutLedgerEntry.findMany({
        where: { operation: 'FANOUT_MUTE_RECORD', targetChatId: 'chat-2' },
      }),
    ).resolves.toEqual([
      expect.objectContaining({ status: 'FAILED_RETRYABLE', terminal: false, lockToken: null }),
    ]);
  });

  it('does not probe a settled terminal target when a mixed job is replayed', async () => {
    const prisma = createPrismaMock();
    configureFanoutChats(prisma, ['chat-2', 'chat-3']);
    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      getCurrentChatMemberAccess: jest.fn().mockResolvedValue({
        userId: 'bot-3',
        isAdmin: true,
        isOwner: false,
        permissions: ['read_all_messages', 'write'],
      }),
      getChatMemberAccess: jest.fn().mockResolvedValue({
        userId: 'user-2',
        isAdmin: false,
        isOwner: false,
        permissions: [],
      }),
    };
    const service = createAdminServiceFixture(
      prisma as never,
      maxClient as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
    );
    const routeCalls: string[] = [];
    let retryableAttempts = 0;
    jest
      .spyOn(service as any, 'resolveManualModerationActionBotAssignment')
      .mockImplementation(async (...args: unknown[]) => {
        const [chatId] = args as [string];
        routeCalls.push(chatId);
        if (chatId === 'chat-2') {
          throw new ForbiddenException('No delete-capable route');
        }
        retryableAttempts += 1;
        if (retryableAttempts === 1) {
          throw new ServiceUnavailableException('MAX is unavailable');
        }
        return 'bot-3';
      });
    const job = buildMuteFanoutJob('job-mute-mixed-replay-1');

    await expect(service.processManualModerationFanoutJob(job)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    await expect(service.processManualModerationFanoutJob(job)).resolves.toBeUndefined();

    expect(routeCalls.filter((chatId) => chatId === 'chat-2')).toHaveLength(1);
    expect(routeCalls.filter((chatId) => chatId === 'chat-3')).toHaveLength(2);
    await expect(
      prisma.manualModerationFanoutLedgerEntry.findMany({
        where: { operation: 'FANOUT_MUTE_RECORD' },
      }),
    ).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ targetChatId: 'chat-2', status: 'FAILED_TERMINAL' }),
        expect.objectContaining({ targetChatId: 'chat-3', status: 'SUCCEEDED' }),
      ]),
    );
  });
});
