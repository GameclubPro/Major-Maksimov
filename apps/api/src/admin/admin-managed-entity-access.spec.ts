import { ForbiddenException, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AdminService } from './admin.service';
import type { MaxChatMemberAccess, MaxClientService } from '../max/max-client.service';
import { MaxBotRegistryService } from '../max/max-bot-registry.service';
import {
  createChatContextCacheMock,
  createConfigMock,
  createDeferred,
  createPrismaMock,
  flushAsyncTasks,
} from './admin-service-test-support';

function protectedEntryMaxClient(isAdmin = true, botContactId = '777000') {
  const actor: MaxChatMemberAccess = {
    userId: 'admin-1',
    isBot: false,
    isAdmin,
    isOwner: false,
    permissions: [],
    explicitPrivilegeEvidence: isAdmin,
    explicitNonPrivilegeEvidence: !isAdmin,
  };
  const bot: MaxChatMemberAccess = {
    userId: botContactId,
    isBot: true,
    isAdmin: true,
    isOwner: false,
    permissions: [],
    explicitPrivilegeEvidence: true,
  };
  return {
    getChatMembersAccess: jest
      .fn<
        ReturnType<MaxClientService['getChatMembersAccess']>,
        Parameters<MaxClientService['getChatMembersAccess']>
      >()
      .mockResolvedValue(
        new Map([
          [actor.userId!, actor],
          [bot.userId!, bot],
        ]),
      ),
    getCurrentChatMemberAccess: jest
      .fn<
        ReturnType<MaxClientService['getCurrentChatMemberAccess']>,
        Parameters<MaxClientService['getCurrentChatMemberAccess']>
      >()
      .mockResolvedValue(bot),
  } satisfies Pick<MaxClientService, 'getChatMembersAccess' | 'getCurrentChatMemberAccess'>;
}

describe('AdminService admin access validation', () => {
  const user = {
    userId: 'admin-1',
    username: null,
    displayName: null,
    chatTitle: null,
  };

  it('deduplicates concurrent admin checks for the same chat and user', async () => {
    const prisma = createPrismaMock();
    const chatContextCache = createChatContextCacheMock();
    let resolveAdminIds!: (value: string[]) => void;
    const maxClient = {
      getChatAdminIds: jest.fn().mockImplementation(
        () =>
          new Promise<string[]>((resolve) => {
            resolveAdminIds = resolve;
          }),
      ),
    };
    const service = new AdminService(
      prisma as never,
      maxClient as never,
      chatContextCache as never,
      createConfigMock() as never,
    );

    const pending = [
      service.assertChatAdmin('chat-1', user.userId, 'chat'),
      service.assertChatAdmin('chat-1', user.userId, 'chat'),
      service.assertChatAdmin('chat-1', user.userId, 'chat'),
    ];

    await flushAsyncTasks();
    await flushAsyncTasks();
    if (!resolveAdminIds) {
      throw new Error('resolveAdminIds was not initialized');
    }
    resolveAdminIds(['admin-1']);
    await expect(Promise.all(pending)).resolves.toEqual([undefined, undefined, undefined]);
    expect(maxClient.getChatAdminIds).toHaveBeenCalledTimes(1);
  });

  it('validates base admin access via the full MAX admin list', async () => {
    const prisma = createPrismaMock();
    const chatContextCache = createChatContextCacheMock();
    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      getChatEditableAdminIds: jest.fn().mockResolvedValue([]),
    };
    const service = new AdminService(
      prisma as never,
      maxClient as never,
      chatContextCache as never,
      createConfigMock() as never,
    );

    await expect(service.assertChatAdmin('chat-1', user.userId, 'chat')).resolves.toBeUndefined();
    expect(maxClient.getChatAdminIds).toHaveBeenCalledWith(
      'chat-1',
      expect.objectContaining({
        actionHealthLane: 'background',
      }),
    );
    expect(maxClient.getChatEditableAdminIds).not.toHaveBeenCalled();
  });

  it('treats a concurrent persisted admin allowlist insert as idempotent', async () => {
    const prisma = createPrismaMock();
    prisma.chatAdminAllowlist.upsert.mockRejectedValueOnce({ code: 'P2002' });
    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
    };
    const service = new AdminService(
      prisma as never,
      maxClient as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
    );

    await expect(service.assertChatAdmin('chat-1', user.userId, 'chat')).resolves.toBeUndefined();
    expect(prisma.chatAdminAllowlist.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          chatId_userId: {
            chatId: 'chat-1',
            userId: 'admin-1',
          },
        },
      }),
    );
  });

  it('fails closed when a newer membership event supersedes the remote grant before allowlist upsert', async () => {
    const prisma = createPrismaMock();
    const chatContextCache = createChatContextCacheMock();
    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
    };
    const service = new AdminService(
      prisma as never,
      maxClient as never,
      chatContextCache as never,
      createConfigMock() as never,
    );
    prisma.chatMembershipActivityEvent.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'newer-removal' });

    await expect(service.assertChatAdmin('chat-1', user.userId, 'chat')).rejects.toThrow(
      ServiceUnavailableException,
    );

    expect(prisma.chatMembershipActivityEvent.findFirst).toHaveBeenCalledTimes(2);
    expect(prisma.chatAdminAllowlist.upsert).not.toHaveBeenCalled();
  });

  it('rechecks stale bot_denied cache before rejecting admin access', async () => {
    const prisma = createPrismaMock();
    const chatContextCache = createChatContextCacheMock({
      getAdminAccess: jest.fn().mockResolvedValue('bot_denied'),
    });
    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
    };
    const service = new AdminService(
      prisma as never,
      maxClient as never,
      chatContextCache as never,
      createConfigMock() as never,
    );

    await expect(service.assertChatAdmin('chat-1', user.userId, 'chat')).resolves.toBeUndefined();
    expect(maxClient.getChatAdminIds).toHaveBeenCalledWith(
      'chat-1',
      expect.objectContaining({
        actionHealthLane: 'background',
      }),
    );
  });

  it('rechecks stale user_denied cache before rejecting admin access', async () => {
    const prisma = createPrismaMock();
    const chatContextCache = createChatContextCacheMock({
      getAdminAccess: jest.fn().mockResolvedValue('user_denied'),
    });
    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
    };
    const service = new AdminService(
      prisma as never,
      maxClient as never,
      chatContextCache as never,
      createConfigMock() as never,
    );

    await expect(service.assertChatAdmin('chat-1', user.userId, 'chat')).resolves.toBeUndefined();
    expect(maxClient.getChatAdminIds).toHaveBeenCalledWith(
      'chat-1',
      expect.objectContaining({
        actionHealthLane: 'background',
      }),
    );
  });

  it('fails closed on transient MAX admin check failures for mutating access', async () => {
    const prisma = createPrismaMock();
    prisma.chatAdminAllowlist.findMany.mockResolvedValue([{ chatId: 'chat-1' }]);
    const chatContextCache = createChatContextCacheMock();
    const maxClient = {
      getChatAdminIds: jest.fn().mockRejectedValue(
        Object.assign(new Error('timeout of 5000ms exceeded'), {
          code: 'ECONNABORTED',
        }),
      ),
    };
    const service = new AdminService(
      prisma as never,
      maxClient as never,
      chatContextCache as never,
      createConfigMock() as never,
    );

    await expect(service.assertChatAdmin('chat-1', user.userId, 'chat')).rejects.toThrow(
      ServiceUnavailableException,
    );
    expect(chatContextCache.setAdminAccess).not.toHaveBeenCalled();
    expect(prisma.chatAdminAllowlist.findMany).not.toHaveBeenCalled();
    expect(prisma.chatAdminAllowlist.deleteMany).not.toHaveBeenCalled();
  });

  it('does not accept a fresh access edge when strict MAX validation reports bot denied', async () => {
    const prisma = createPrismaMock();
    prisma.chat.findUnique.mockResolvedValue({
      id: 'chat-1',
      title: 'Команда MAX',
      entityType: 'CHAT',
      primaryBotId: 'bot-primary',
      botId: null,
      botMemberships: [{ botId: 'bot-primary' }],
    });
    (prisma as any).managedEntityAccessEdge = {
      findMany: jest.fn().mockResolvedValue([{ chatId: 'chat-1', botId: 'bot-primary' }]),
    };
    (prisma as any).chatBotMembership = {
      findMany: jest.fn().mockResolvedValue([{ chatId: 'chat-1', botId: 'bot-primary' }]),
    };
    const chatContextCache = createChatContextCacheMock();
    const maxClient = {
      getChatAdminIds: jest.fn().mockRejectedValue({
        response: {
          status: 403,
          data: {
            code: 'chat.denied',
            message: 'Bot is not a chat member',
          },
        },
      }),
    };
    const maxBotRegistry = {
      getBotById: jest.fn((botId: string | null | undefined) =>
        botId ? { id: botId, state: 'active' } : null,
      ),
      getAllBots: jest.fn().mockReturnValue([{ id: 'bot-primary' }]),
    };
    const service = new AdminService(
      prisma as never,
      maxClient as never,
      chatContextCache as never,
      createConfigMock({ botId: 'bot-primary' }) as never,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      maxBotRegistry as never,
    );

    await expect(
      service.assertChatAdmin('chat-1', user.userId, 'chat', {
        allowPersistedFallback: false,
      }),
    ).rejects.toThrow(ForbiddenException);
    expect((prisma as any).managedEntityAccessEdge.findMany).not.toHaveBeenCalled();
    expect(chatContextCache.applyAdminAccessEpochMutation).toHaveBeenCalledWith({
      chatId: 'chat-1',
      userId: user.userId,
      state: 'bot_denied',
      eventAt: expect.any(Date),
    });
    expect(chatContextCache.setAdminAccess).not.toHaveBeenCalled();
  });

  it('rechecks cached granted access and rejects a removed managed-entity admin', async () => {
    const prisma = createPrismaMock();
    prisma.chatAdminAllowlist.findMany.mockResolvedValue([{ chatId: 'chat-1' }]);
    const chatContextCache = createChatContextCacheMock({
      getAdminAccess: jest.fn().mockResolvedValue('granted'),
    });
    const maxClient = protectedEntryMaxClient(false);
    const service = new AdminService(
      prisma as never,
      maxClient as never,
      chatContextCache as never,
      createConfigMock() as never,
    );

    await expect(
      service.assertManagedEntityAdminAccess('chat-1', user.userId, 'chat'),
    ).rejects.toThrow(ForbiddenException);

    expect(maxClient.getChatMembersAccess).toHaveBeenCalledTimes(1);
    expect(chatContextCache.applyAdminAccessEpochMutation).toHaveBeenCalledWith({
      chatId: 'chat-1',
      userId: user.userId,
      state: 'user_denied',
      eventAt: expect.any(Date),
    });
    expect(chatContextCache.setAdminAccess).not.toHaveBeenCalled();
    expect(prisma.chatAdminAllowlist.deleteMany).toHaveBeenCalledWith({
      where: {
        chatId: 'chat-1',
        userId: { in: ['admin-1', 'idadmin-1'] },
      },
    });
  });

  it('returns 503 for managed mutations when MAX fails despite an old allowlist row', async () => {
    const prisma = createPrismaMock();
    prisma.chatAdminAllowlist.findMany.mockResolvedValue([{ chatId: 'chat-1' }]);
    const maxClient = protectedEntryMaxClient();
    maxClient.getChatMembersAccess.mockRejectedValue(
      Object.assign(new Error('timeout of 5000ms exceeded'), {
        code: 'ECONNABORTED',
      }),
    );
    const service = new AdminService(
      prisma as never,
      maxClient as never,
      createChatContextCacheMock() as never,
      createConfigMock() as never,
    );

    await expect(
      service.assertManagedEntityAdminAccess('chat-1', user.userId, 'chat'),
    ).rejects.toThrow(ServiceUnavailableException);
    expect(prisma.chatAdminAllowlist.findMany).not.toHaveBeenCalled();
  });

  it('keeps checking candidate bots until one confirms the current admin', async () => {
    const prisma = createPrismaMock();
    prisma.chat.findUnique.mockResolvedValue({
      id: 'chat-1',
      title: 'Команда MAX',
      entityType: 'CHAT',
      primaryBotId: '777000_bot',
      botId: null,
      botMemberships: [{ botId: '777000_bot' }, { botId: '888000_bot' }],
    });
    Object.assign(prisma, {
      managedEntityAccessEdge: {
        findUnique: jest.fn().mockResolvedValue(null),
        findFirst: jest.fn().mockResolvedValue(null),
        upsert: jest.fn().mockResolvedValue(undefined),
      },
    });
    const maxClient = protectedEntryMaxClient(true, '888000');
    maxClient.getChatMembersAccess.mockRejectedValueOnce({
      response: {
        status: 403,
        data: { code: 'chat.denied', message: 'Bot is not a chat member' },
      },
    });
    const config = new ConfigService({
      APP_BASE_URL: 'https://major-maksimov.ru',
      MAX_BOT_ID: '777000_bot',
      MAX_BOT_CONTACT_ID: '777000',
      MAX_BOT_TOKEN: 'test-primary-token',
      MAX_WEBHOOK_SECRET_PATH: 'test-primary-path',
      MAX_WEBHOOK_HEADER_SECRET: 'test-primary-header',
      MAX_BOTS_JSON: JSON.stringify([
        {
          id: '888000_bot',
          contactId: '888000',
          token: 'test-secondary-token',
          webhookSecretPath: 'test-secondary-path',
          webhookHeaderSecret: 'test-secondary-header',
          state: 'active',
        },
      ]),
    });
    const maxBotRegistry = new MaxBotRegistryService(config);
    const service = new AdminService(
      prisma as never,
      maxClient as never,
      createChatContextCacheMock() as never,
      config,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      maxBotRegistry,
    );

    await expect(
      service.assertManagedEntityAdminAccess('chat-1', user.userId, 'chat'),
    ).resolves.toBeUndefined();
    expect(maxClient.getChatMembersAccess).toHaveBeenCalledTimes(2);
    expect(maxClient.getChatMembersAccess).toHaveBeenNthCalledWith(
      1,
      'chat-1',
      ['admin-1', '777000'],
      expect.objectContaining({ botId: '777000_bot', bypassCache: true }),
    );
    expect(maxClient.getChatMembersAccess).toHaveBeenNthCalledWith(
      2,
      'chat-1',
      ['admin-1', '888000'],
      expect.objectContaining({ botId: '888000_bot', bypassCache: true }),
    );
    expect(maxClient.getCurrentChatMemberAccess).not.toHaveBeenCalled();
  });

  it('rechecks cached granted access for managed-entity reads', async () => {
    const prisma = createPrismaMock();
    const chatContextCache = createChatContextCacheMock({
      getAdminAccess: jest.fn().mockResolvedValue('granted'),
    });
    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue([]),
    };
    const service = new AdminService(
      prisma as never,
      maxClient as never,
      chatContextCache as never,
      createConfigMock() as never,
    );

    await expect(
      service.assertManagedEntityReadAccess('chat-1', user.userId, 'chat'),
    ).rejects.toThrow(ForbiddenException);
    expect(maxClient.getChatAdminIds).toHaveBeenCalledTimes(1);
  });

  it('returns 503 instead of false 403 when MAX admin check transiently fails without fallback', async () => {
    const prisma = createPrismaMock();
    const chatContextCache = createChatContextCacheMock();
    const maxClient = {
      getChatAdminIds: jest.fn().mockRejectedValue(
        Object.assign(new Error('timeout of 5000ms exceeded'), {
          code: 'ECONNABORTED',
        }),
      ),
    };
    const service = new AdminService(
      prisma as never,
      maxClient as never,
      chatContextCache as never,
      createConfigMock() as never,
    );

    await expect(service.assertChatAdmin('chat-1', user.userId, 'chat')).rejects.toThrow(
      ServiceUnavailableException,
    );
    expect(chatContextCache.setAdminAccess).not.toHaveBeenCalled();
  });

  it('does not cache bot_denied when one candidate bot is transiently unavailable', async () => {
    const prisma = createPrismaMock();
    prisma.chat.findUnique.mockResolvedValue({
      id: 'chat-1',
      title: 'Команда MAX',
      entityType: 'CHAT',
      primaryBotId: 'bot-primary',
      botId: null,
      botMemberships: [{ botId: 'bot-primary' }, { botId: 'bot-standby' }],
    });
    const chatContextCache = createChatContextCacheMock();
    const maxClient = {
      getChatAdminIds: jest
        .fn()
        .mockRejectedValueOnce(
          Object.assign(new Error('timeout of 5000ms exceeded'), {
            code: 'ECONNABORTED',
          }),
        )
        .mockRejectedValueOnce({
          response: {
            status: 403,
            data: {
              code: 'chat.denied',
              message: 'Bot is not a chat member',
            },
          },
        }),
    };
    const maxBotRegistry = {
      getBotById: jest.fn((botId: string | null | undefined) =>
        botId ? { id: botId, state: 'active' } : null,
      ),
      getAllBots: jest.fn().mockReturnValue([{ id: 'bot-primary' }, { id: 'bot-standby' }]),
    };
    const service = new AdminService(
      prisma as never,
      maxClient as never,
      chatContextCache as never,
      createConfigMock({ botId: 'bot-primary' }) as never,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      maxBotRegistry as never,
    );

    await expect(service.assertChatAdmin('chat-1', user.userId, 'chat')).rejects.toThrow(
      ServiceUnavailableException,
    );
    expect(maxClient.getChatAdminIds).toHaveBeenCalledTimes(2);
    expect(chatContextCache.setAdminAccess).not.toHaveBeenCalledWith(
      'chat-1',
      user.userId,
      'bot_denied',
    );
    expect(prisma.chatAdminAllowlist.deleteMany).not.toHaveBeenCalled();
  });

  it('cleans stale allowlist rows when MAX says bot no longer has access to the chat', async () => {
    const prisma = createPrismaMock();
    let accessState: 'bot_denied' | null = null;
    const chatContextCache = createChatContextCacheMock({
      getAdminAccess: jest.fn().mockImplementation(async () => accessState),
      setAdminAccess: jest
        .fn()
        .mockImplementation(async (_chatId: string, _userId: string, state: 'bot_denied') => {
          accessState = state;
        }),
    });
    const maxClient = {
      getChatAdminIds: jest.fn().mockRejectedValue({
        response: {
          status: 403,
          data: {
            code: 'chat.denied',
            message: 'Bot is not a chat member',
          },
        },
      }),
    };
    const service = new AdminService(
      prisma as never,
      maxClient as never,
      chatContextCache as never,
      createConfigMock() as never,
    );

    await expect(service.assertChatAdmin('chat-1', user.userId, 'chat')).rejects.toThrow(
      ForbiddenException,
    );
    await expect(service.assertChatAdmin('chat-1', user.userId, 'chat')).rejects.toThrow(
      'Действие недоступно: бот больше не состоит в этом чате MAX или утратил права администратора.',
    );
    expect(maxClient.getChatAdminIds).toHaveBeenCalledTimes(2);
  });

  it('rechecks cached granted access before reading moderation events', async () => {
    const prisma = createPrismaMock();
    prisma.moderationEvent.findMany.mockResolvedValue([]);
    const chatContextCache = createChatContextCacheMock({
      getAdminAccess: jest.fn().mockResolvedValue('granted'),
    });
    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue([]),
    };
    const service = new AdminService(
      prisma as never,
      maxClient as never,
      chatContextCache as never,
      createConfigMock() as never,
    );

    await expect(service.getEvents('chat-1', user, {})).rejects.toThrow(ForbiddenException);

    expect(maxClient.getChatAdminIds).toHaveBeenCalledTimes(1);
    expect(prisma.chat.upsert).not.toHaveBeenCalled();
    expect(prisma.chatAdminAllowlist.upsert).not.toHaveBeenCalled();
    expect(prisma.moderationEvent.findMany).not.toHaveBeenCalled();
  });

  it('warms admin context and roster after read-only miniapp validation confirms a new admin', async () => {
    const prisma = createPrismaMock();
    prisma.moderationEvent.findMany.mockResolvedValue([]);
    const chatContextCache = createChatContextCacheMock({
      getAdminAccess: jest.fn().mockResolvedValue(null),
      setAdminAccess: jest.fn().mockResolvedValue(undefined),
      rememberChatAdminUser: jest.fn().mockResolvedValue(undefined),
    });
    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
    };
    const maxChatAdminRosterSyncService = {
      scheduleChatAdminRosterSync: jest.fn().mockResolvedValue(true),
    };
    const service = new AdminService(
      prisma as never,
      maxClient as never,
      chatContextCache as never,
      createConfigMock() as never,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      maxChatAdminRosterSyncService as never,
    );

    await expect(service.getEvents('chat-1', user, {})).resolves.toEqual([]);
    await flushAsyncTasks();

    expect(chatContextCache.applyAdminAccessEpochMutation).toHaveBeenCalledWith({
      chatId: 'chat-1',
      userId: 'admin-1',
      state: 'granted',
      eventAt: expect.any(Date),
    });
    expect(chatContextCache.setAdminAccess).not.toHaveBeenCalled();
    expect(chatContextCache.rememberChatAdminUser).not.toHaveBeenCalled();
    expect(maxChatAdminRosterSyncService.scheduleChatAdminRosterSync).toHaveBeenCalledWith({
      chatId: 'chat-1',
      entityType: null,
      source: 'admin_access_validation',
      retryUntilMs: null,
    });
    expect(prisma.chatAdminAllowlist.upsert).not.toHaveBeenCalled();
  });

  it('fails closed when cache epoch CAS rejects a read-only remote grant', async () => {
    const prisma = createPrismaMock();
    prisma.moderationEvent.findMany.mockResolvedValue([]);
    const chatContextCache = createChatContextCacheMock({
      getAdminAccess: jest.fn().mockResolvedValue(null),
      applyAdminAccessEpochMutation: jest.fn().mockResolvedValue(false),
      setAdminAccess: jest.fn().mockResolvedValue(undefined),
      rememberChatAdminUser: jest.fn().mockResolvedValue(undefined),
    });
    const maxClient = {
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
    };
    const maxChatAdminRosterSyncService = {
      scheduleChatAdminRosterSync: jest.fn().mockResolvedValue(true),
    };
    const service = new AdminService(
      prisma as never,
      maxClient as never,
      chatContextCache as never,
      createConfigMock() as never,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      maxChatAdminRosterSyncService as never,
    );

    await expect(service.getEvents('chat-1', user, {})).rejects.toThrow(
      ServiceUnavailableException,
    );
    await flushAsyncTasks();

    expect(chatContextCache.applyAdminAccessEpochMutation).toHaveBeenCalledWith({
      chatId: 'chat-1',
      userId: 'admin-1',
      state: 'granted',
      eventAt: expect.any(Date),
    });
    expect(chatContextCache.setAdminAccess).not.toHaveBeenCalled();
    expect(chatContextCache.rememberChatAdminUser).not.toHaveBeenCalled();
    expect(maxChatAdminRosterSyncService.scheduleChatAdminRosterSync).not.toHaveBeenCalled();
    expect(prisma.moderationEvent.findMany).not.toHaveBeenCalled();
  });

  it('matches id-prefixed response aliases without sending them to MAX', async () => {
    const prisma = createPrismaMock();
    const chatContextCache = createChatContextCacheMock();
    const maxClient = {
      getChatMembersAccess: jest.fn().mockResolvedValue(
        new Map([
          [
            'id123',
            {
              userId: 'id123',
              isAdmin: true,
              isOwner: false,
            },
          ],
        ]),
      ),
      getCurrentChatMemberAccess: jest.fn().mockResolvedValue({
        userId: '777000',
        isAdmin: true,
        isOwner: false,
      }),
    };
    const service = new AdminService(
      prisma as never,
      maxClient as never,
      chatContextCache as never,
      createConfigMock() as never,
    );

    await expect(
      (service as any).resolveUserAndBotAdminAccess('chat-1', '123', {
        allowPersistedFallback: false,
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        status: 'granted',
        source: 'remote',
      }),
    );

    expect(maxClient.getChatMembersAccess).toHaveBeenCalledWith(
      'chat-1',
      ['123', '777000'],
      expect.objectContaining({ actionHealthLane: 'background' }),
    );
    expect(chatContextCache.applyAdminAccessEpochMutation).toHaveBeenCalledWith({
      chatId: 'chat-1',
      userId: '123',
      state: 'granted',
      eventAt: expect.any(Date),
    });
  });

  it('rejects a delayed remote grant after a newer aliased membership transition', async () => {
    const prisma = createPrismaMock();
    const lookup = createDeferred<string[]>();
    const chatContextCache = createChatContextCacheMock();
    const maxClient = {
      getChatAdminIds: jest.fn().mockReturnValue(lookup.promise),
    };
    const service = new AdminService(
      prisma as never,
      maxClient as never,
      chatContextCache as never,
      createConfigMock() as never,
    );

    const pending = (service as any).resolveUserAndBotAdminAccess('chat-1', '123', {
      allowPersistedFallback: false,
    });
    await flushAsyncTasks();
    prisma.chatMembershipActivityEvent.findFirst.mockResolvedValueOnce({ id: 'newer-removal' });
    lookup.resolve(['id123']);

    await expect(pending).resolves.toEqual(
      expect.objectContaining({
        status: 'unknown',
        error: expect.any(Error),
      }),
    );
    expect(prisma.chatMembershipActivityEvent.findFirst).toHaveBeenCalledWith({
      where: {
        chatId: 'chat-1',
        userId: { in: ['123', 'id123'] },
        eventType: { in: ['user_added', 'user_removed'] },
        eventAt: { gte: expect.any(Date) },
      },
      select: { id: true },
    });
    expect(chatContextCache.applyAdminAccessEpochMutation).not.toHaveBeenCalled();
  });

  it('keeps a P2024 discovery grant in process without publishing it to Redis', async () => {
    const prisma = createPrismaMock();
    const chatContextCache = createChatContextCacheMock();
    const service = new AdminService(
      prisma as never,
      {} as never,
      chatContextCache as never,
      createConfigMock() as never,
    );
    jest
      .spyOn(service as any, 'upsertUserChatAccess')
      .mockRejectedValueOnce({ code: 'P2024', message: 'pool timeout' });

    await expect(
      (service as any).persistManagedEntityAccessBestEffort({
        chatId: 'chat-transient',
        userId: 'admin-1',
        title: 'Временный чат',
        entityType: 'chat',
        createdAtFallback: '2026-05-14T09:00:00.000Z',
        source: 'local_discovery',
        probeStartedAt: new Date('2026-05-14T08:59:00.000Z'),
      }),
    ).resolves.toMatchObject({
      id: 'chat-transient',
      title: 'Временный чат',
      entityType: 'chat',
    });

    expect((service as any).readManagedEntitiesLastSuccessSnapshot('admin-1', 'chat')).toEqual([
      expect.objectContaining({
        id: 'chat-transient',
        title: 'Временный чат',
        entityType: 'chat',
      }),
    ]);
    expect(chatContextCache.applyAdminAccessEpochMutation).not.toHaveBeenCalled();
    expect(chatContextCache.upsertManagedEntityPublishedSnapshot).not.toHaveBeenCalled();
    expect(chatContextCache.setManagedEntitiesPublishedSnapshot).not.toHaveBeenCalled();
  });

  it('rejects a fresh access-edge fallback when the cache epoch CAS loses', async () => {
    const prisma = createPrismaMock();
    const checkedAt = new Date('2026-05-14T08:59:00.000Z');
    (prisma as any).managedEntityAccessEdge = {
      findMany: jest.fn().mockResolvedValue([
        {
          chatId: 'chat-1',
          userId: 'id123',
          botId: 'bot-1',
          checkedAt,
        },
      ]),
    };
    (prisma as any).chatBotMembership = {
      findMany: jest.fn().mockResolvedValue([{ chatId: 'chat-1', botId: 'bot-1' }]),
    };
    const chatContextCache = createChatContextCacheMock({
      applyAdminAccessEpochMutation: jest.fn().mockResolvedValue(false),
    });
    const service = new AdminService(
      prisma as never,
      {} as never,
      chatContextCache as never,
      createConfigMock({ botId: 'bot-1' }) as never,
    );

    await expect(
      (service as any).resolveFreshManagedEntityAccessEdgeFallback('chat-1', '123', 'chat'),
    ).resolves.toBeNull();

    expect((prisma as any).managedEntityAccessEdge.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          chatId: 'chat-1',
          userId: { in: ['123', 'id123'] },
        }),
      }),
    );
    expect(chatContextCache.applyAdminAccessEpochMutation).toHaveBeenCalledWith({
      chatId: 'chat-1',
      userId: '123',
      state: 'granted',
      eventAt: checkedAt,
    });
    expect(chatContextCache.setAdminAccess).not.toHaveBeenCalled();
  });
});
