import type { ChatSummary } from '@maxim/contracts';
import { AdminManagedEntitiesRuntime } from './admin-managed-entities-runtime';
import type { AdminManagedEntitiesRuntimeContext } from './admin-managed-entities-runtime-context';

const user = {
  userId: 'admin-1',
  username: null,
  displayName: null,
  chatTitle: null,
};

function createContext(
  overrides: Partial<AdminManagedEntitiesRuntimeContext> = {},
): AdminManagedEntitiesRuntimeContext {
  return {
    prisma: {
      chat: {
        findMany: jest.fn().mockResolvedValue([]),
      },
    } as never,
    chatContextCache: {
      getManagedEntityBotProfile: jest.fn().mockResolvedValue(null),
      setManagedEntityBotProfile: jest.fn().mockResolvedValue(undefined),
    } as never,
    maxClient: {
      getOwnProfile: jest.fn().mockResolvedValue({ avatarUrl: 'https://cdn.example/bot.png' }),
    } as never,
    logger: { warn: jest.fn() } as never,
    maxBotRegistry: {
      getAllBots: jest.fn().mockReturnValue([]),
    } as never,
    assertChatAdmin: jest.fn().mockResolvedValue(undefined),
    assertReadOnlyChatAdmin: jest.fn().mockResolvedValue(undefined),
    attachManagedEntityFavoriteTypes: jest.fn(async (_userId, items: readonly ChatSummary[]) =>
      items.map((item: ChatSummary) => ({ ...item, favoriteTypes: ['watch'] })),
    ) as never,
    attachManagedEntityFavoriteTypesToDiff: jest.fn(async (_userId, diff) => diff),
    collectManagedEntitiesForMassAction: jest.fn().mockResolvedValue([]),
    ensureEntityType: jest.fn().mockResolvedValue(undefined),
    isManagedEntityRuntimeBotId: jest.fn((botId) => botId === 'bot-1'),
    listManagedEntitiesDetailed: jest.fn().mockResolvedValue({
      items: [
        {
          id: 'chat-1',
          title: 'Chat One',
          entityType: 'chat',
          link: null,
          channelOverview: null,
          primaryBotId: null,
          assignedBots: [],
          sharedMode: 'owned',
        },
      ],
      refresh: null,
    }),
    resolveBackgroundReadBotAssignment: jest.fn().mockResolvedValue('bot-1'),
    runManagedEntitiesBoundedRefreshJob: jest.fn().mockResolvedValue({ continueAfterMs: 1500 }),
    runManagedEntitiesRemoteFullRefresh: jest.fn().mockResolvedValue(null),
    ...overrides,
  };
}

describe('AdminManagedEntitiesRuntime', () => {
  it('requires synchronous human protection at the managed settings access boundary', async () => {
    const context = createContext();
    const runtime = new AdminManagedEntitiesRuntime(context);

    await runtime.assertManagedEntityAdminAccess('chat-1', user.userId, 'chat');

    expect(context.assertChatAdmin).toHaveBeenCalledWith('chat-1', user.userId, 'chat', {
      trafficClass: 'interactive',
      allowPersistedFallback: false,
      bypassPositiveCache: true,
      syncPersistedAccess: false,
      protectHumanAdministrator: true,
    });
    expect(context.ensureEntityType).toHaveBeenCalledWith('chat-1', user.userId, 'chat');
  });

  it('lists managed entities through typed context callbacks', async () => {
    const context = createContext();
    const runtime = new AdminManagedEntitiesRuntime(context);

    await expect(runtime.listChats(user, { fresh: true })).resolves.toEqual([
      expect.objectContaining({
        id: 'chat-1',
        favoriteTypes: ['watch'],
      }),
    ]);

    expect(context.listManagedEntitiesDetailed).toHaveBeenCalledWith(user, 'chat', {
      fresh: true,
    });
    expect(context.attachManagedEntityFavoriteTypes).toHaveBeenCalledWith('admin-1', [
      expect.objectContaining({ id: 'chat-1' }),
    ]);
  });

  it('forwards mass broadcast discovery mode through the managed entities context', async () => {
    const context = createContext({
      collectManagedEntitiesForMassAction: jest
        .fn()
        .mockResolvedValue([{ id: 'chat-1', entityType: 'chat' }]),
    });
    const runtime = new AdminManagedEntitiesRuntime(context);

    await runtime.listChatsForMassBroadcast(user);
    await runtime.listChatsForMassBroadcast(user, { discoveryMode: 'full' });

    expect(context.collectManagedEntitiesForMassAction).toHaveBeenNthCalledWith(1, user, 'chat', {
      discoveryMode: 'cached-first',
    });
    expect(context.collectManagedEntitiesForMassAction).toHaveBeenNthCalledWith(2, user, 'chat', {
      discoveryMode: 'full',
    });
  });

  it('maps refresh jobs to bounded refresh delegates with a synthetic auth user', async () => {
    const context = createContext();
    const runtime = new AdminManagedEntitiesRuntime(context);

    await expect(
      runtime.processManagedEntitiesRefreshJob({
        userId: 'admin-2',
        entityType: 'channel',
        bypassRemoteCache: true,
        resetRefreshCursor: true,
      }),
    ).resolves.toEqual({ continueAfterMs: 1500 });

    expect(context.runManagedEntitiesBoundedRefreshJob).toHaveBeenCalledWith(
      {
        userId: 'admin-2',
        username: null,
        displayName: null,
        chatTitle: null,
      },
      'channel',
      {
        bypassRemoteCache: true,
        resetRefreshCursor: true,
      },
    );
    expect(context.runManagedEntitiesRemoteFullRefresh).not.toHaveBeenCalled();
  });

  it('hydrates assigned bot avatars only for runtime bot ids and caches misses', async () => {
    const context = createContext({
      prisma: {
        chat: {
          findMany: jest.fn().mockResolvedValue([
            {
              id: 'chat-1',
              botId: 'bot-1',
              primaryBotId: 'bot-1',
              botMemberships: [
                {
                  botId: 'bot-1',
                  role: 'PRIMARY',
                  status: 'ACTIVE',
                  capabilities: [],
                  permissionsSnapshot: null,
                },
                {
                  botId: 'bot-external',
                  role: 'STANDBY',
                  status: 'ACTIVE',
                  capabilities: [],
                  permissionsSnapshot: null,
                },
              ],
            },
          ]),
        },
      } as never,
      maxBotRegistry: {
        getBotById: jest.fn((botId) => (botId === 'bot-1' ? { id: botId } : null)),
        getAllBots: jest.fn().mockReturnValue([
          { id: 'bot-1', label: 'Primary' },
          { id: 'bot-external', label: 'External' },
        ]),
      } as never,
    });
    const runtime = new AdminManagedEntitiesRuntime(context);

    await expect(
      runtime.attachManagedEntityHeaderBotAssignmentsForManagedEntities({
        id: 'chat-1',
        title: 'Chat One',
        entityType: 'chat',
        link: null,
        participantsCount: null,
        primaryBotId: 'bot-1',
        assignedBots: [
          {
            botId: ' bot-1 ',
            label: 'Primary',
            role: 'primary',
            membershipStatus: 'active',
            lifecycleState: 'active',
            speechPersona: 'male',
            characterName: null,
            avatarUrl: null,
            capabilities: [],
            permissionsSummary: null,
          },
          {
            botId: 'bot-external',
            label: 'External',
            role: 'standby',
            membershipStatus: 'active',
            lifecycleState: 'active',
            speechPersona: 'female',
            characterName: null,
            avatarUrl: null,
            capabilities: [],
            permissionsSummary: null,
          },
        ],
        sharedMode: 'shared-standby',
        accessDiagnostics: {
          state: 'ok',
          lastDetectedAt: null,
          lastCheckedAt: null,
          freshUntil: null,
          source: 'unknown',
          activeBotCount: 2,
          lostBots: [],
        },
        viewerAccess: {
          state: 'checking',
          reason: null,
          checkedAt: null,
          canEdit: false,
        },
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        assignedBots: [
          expect.objectContaining({
            botId: 'bot-1',
            avatarUrl: 'https://cdn.example/bot.png',
          }),
          expect.objectContaining({
            botId: 'bot-external',
            avatarUrl: null,
          }),
        ],
      }),
    );

    expect(context.isManagedEntityRuntimeBotId).toHaveBeenCalledWith('bot-1');
    expect(context.isManagedEntityRuntimeBotId).toHaveBeenCalledWith('bot-external');
    expect(context.maxClient.getOwnProfile).toHaveBeenCalledTimes(1);
    expect(context.maxClient.getOwnProfile).toHaveBeenCalledWith(
      expect.objectContaining({ botId: 'bot-1' }),
    );
    expect(context.chatContextCache.setManagedEntityBotProfile).toHaveBeenCalledWith('bot-1', {
      avatarUrl: 'https://cdn.example/bot.png',
    });
  });
});
