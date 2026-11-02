import {
  ChatBotAccessState,
  ChatBotMembershipStatus,
  ChatEntityType,
  ManagedAutopostRuleStatus,
  ManagedBroadcastDeliveryStatus,
  ManagedBroadcastStatus,
  ManagedEntityAccessState,
} from '../prisma/prisma-client';
import { PUBLICATION_DELIVERY_ACCESS_LOST_ERROR_CODE } from './managed-entity-access-loss.constants';
import {
  MANAGED_ENTITY_ACCESS_LOSS_CLEANUP_JOB_KIND,
  type ManagedEntityAccessLossCleanupJob,
} from './max-chat-admin-roster-sync.queue';
import {
  ManagedEntityAccessLossService,
  classifyMaxTerminalChatActionError,
  resolveManagedEntityAccessLossReason,
} from './managed-entity-access-loss.service';

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

function createMaxBotRegistry(botIds: readonly string[]) {
  return {
    getActionableBots: jest.fn().mockReturnValue(botIds.map((id) => ({ id }))),
  };
}

function createDeferredCleanupJob(
  overrides: Partial<ManagedEntityAccessLossCleanupJob> = {},
): ManagedEntityAccessLossCleanupJob {
  return {
    kind: MANAGED_ENTITY_ACCESS_LOSS_CLEANUP_JOB_KIND,
    chatId: 'chat-1',
    botId: 'bot-1',
    lifecycleEventAt: '2026-08-20T12:00:00.123Z',
    lifecycleEventType: 'bot_removed',
    lifecycleSource: 'webhook',
    reason: 'bot_removed',
    source: 'webhook_bot_removed',
    ...overrides,
  };
}

describe('classifyMaxTerminalChatActionError', () => {
  it.each([403, 404])(
    'does not revoke chat access for an ambiguous message lookup HTTP %s',
    async (status) => {
      const prisma = { chat: { findUnique: jest.fn() } };
      const service = new ManagedEntityAccessLossService(prisma as never, {} as never, {} as never);
      await expect(
        service.recordIfManagedEntityAccessLost({
          chatId: '-1001',
          botId: 'bot-1',
          source: 'managed_poll:lookup',
          operation: 'message_lookup',
          error: createMaxApiError(status, `Request failed with status code ${status}`),
        }),
      ).resolves.toMatchObject({ reason: null, recorded: null });
      expect(prisma.chat.findUnique).not.toHaveBeenCalled();
    },
  );

  it.each([
    [403, 'chat.denied', 'bot_denied'],
    [404, 'chat.not.found', 'chat_not_found'],
  ] as const)(
    'preserves explicit chat-level loss %s/%s during message lookup',
    (status, code, reason) => {
      expect(
        resolveManagedEntityAccessLossReason(
          'message_lookup',
          classifyMaxTerminalChatActionError(
            createMaxApiError(status, 'MAX rejected request', code),
          )!,
        ),
      ).toBe(reason);
      expect(
        resolveManagedEntityAccessLossReason(
          'lookup',
          classifyMaxTerminalChatActionError(createMaxApiError(status, 'MAX rejected request'))!,
        ),
      ).toBeNull();
    },
  );

  it('does not classify message.not.found as managed entity access loss', () => {
    expect(
      classifyMaxTerminalChatActionError(
        createMaxApiError(404, 'Request failed with status code 404', 'message.not.found'),
      ),
    ).toEqual(
      expect.objectContaining({
        kind: 'message_not_found',
        code: 'message.not.found',
      }),
    );
  });

  it('classifies chat.not.found as managed entity access loss', () => {
    expect(
      classifyMaxTerminalChatActionError(
        createMaxApiError(404, 'Request failed with status code 404', 'chat.not.found'),
      ),
    ).toEqual(
      expect.objectContaining({
        kind: 'managed_entity_access_lost',
        reason: 'chat_not_found',
        code: 'chat.not.found',
      }),
    );
  });

  it('keeps bare 404 terminal but unknown', () => {
    expect(classifyMaxTerminalChatActionError(createMaxApiError(404, 'Not found'))).toEqual(
      expect.objectContaining({
        kind: 'terminal_unknown',
        statusCode: 404,
      }),
    );
  });

  it('does not resolve message.not.found as access loss', () => {
    const classification = classifyMaxTerminalChatActionError(
      createMaxApiError(404, 'Request failed with status code 404', 'message.not.found'),
    );
    expect(classification).toEqual(expect.objectContaining({ kind: 'message_not_found' }));
    expect(resolveManagedEntityAccessLossReason('delete', classification!)).toBeNull();
  });

  it.each(['send', 'read', 'lookup'] as const)(
    'does not infer bot access loss from bare 403/404 on %s',
    (operation) => {
      for (const status of [403, 404]) {
        expect(
          resolveManagedEntityAccessLossReason(
            operation,
            classifyMaxTerminalChatActionError(createMaxApiError(status, 'Request failed'))!,
          ),
        ).toBeNull();
      }
    },
  );

  it('does not treat bare edit permission errors as full managed-entity access loss', () => {
    expect(
      resolveManagedEntityAccessLossReason(
        'edit',
        classifyMaxTerminalChatActionError(createMaxApiError(404, 'Not found'))!,
      ),
    ).toBeNull();
    expect(
      resolveManagedEntityAccessLossReason(
        'edit',
        classifyMaxTerminalChatActionError(createMaxApiError(403, 'Forbidden'))!,
      ),
    ).toBeNull();
  });

  it('does not resolve bare delete 403/404 as managed entity access loss', () => {
    expect(
      resolveManagedEntityAccessLossReason(
        'delete',
        classifyMaxTerminalChatActionError(createMaxApiError(403, 'Forbidden'))!,
      ),
    ).toBeNull();
    expect(
      resolveManagedEntityAccessLossReason(
        'delete',
        classifyMaxTerminalChatActionError(createMaxApiError(404, 'Not found'))!,
      ),
    ).toBeNull();
  });

  it('still resolves explicit chat loss errors for delete operations', () => {
    expect(
      resolveManagedEntityAccessLossReason(
        'delete',
        classifyMaxTerminalChatActionError(
          createMaxApiError(403, 'Request failed with status code 403', 'chat.denied'),
        )!,
      ),
    ).toBe('bot_denied');
    expect(
      resolveManagedEntityAccessLossReason(
        'delete',
        classifyMaxTerminalChatActionError(
          createMaxApiError(404, 'Request failed with status code 404', 'chat.not.found'),
        )!,
      ),
    ).toBe('chat_not_found');
  });

  it('does not resolve bare member moderation 403/404 as managed entity access loss', () => {
    expect(
      resolveManagedEntityAccessLossReason(
        'member_moderation',
        classifyMaxTerminalChatActionError(createMaxApiError(403, 'Forbidden'))!,
      ),
    ).toBeNull();
    expect(
      resolveManagedEntityAccessLossReason(
        'member_moderation',
        classifyMaxTerminalChatActionError(createMaxApiError(404, 'Not found'))!,
      ),
    ).toBeNull();
  });

  it('still resolves explicit chat loss errors for member moderation operations', () => {
    expect(
      resolveManagedEntityAccessLossReason(
        'member_moderation',
        classifyMaxTerminalChatActionError(
          createMaxApiError(403, 'Request failed with status code 403', 'chat.denied'),
        )!,
      ),
    ).toBe('bot_denied');
    expect(
      resolveManagedEntityAccessLossReason(
        'member_moderation',
        classifyMaxTerminalChatActionError(
          createMaxApiError(404, 'Request failed with status code 404', 'chat.not.found'),
        )!,
      ),
    ).toBe('chat_not_found');
  });
});

describe('ManagedEntityAccessLossService', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it.each(['empty', 'unavailable'] as const)(
    'preserves runtime work when the lost bot is unknown and survivor evidence is %s',
    async (survivorState) => {
      const findMany =
        survivorState === 'empty'
          ? jest.fn().mockResolvedValue([])
          : jest.fn().mockRejectedValue(new Error('survivor lookup unavailable'));
      const prisma = {
        chat: {
          findUnique: jest.fn().mockResolvedValue({ title: 'channel', entityType: 'CHANNEL' }),
        },
        chatBotMembership: { findMany },
        managedAutopostRule: { updateMany: jest.fn() },
        managedBroadcast: { updateMany: jest.fn() },
        managedBroadcastDelivery: { updateMany: jest.fn() },
        managedBroadcastOccurrence: { updateMany: jest.fn() },
      };
      const service = new ManagedEntityAccessLossService(
        prisma as never,
        { markChatBotRemoved: jest.fn() } as never,
        {} as never,
        undefined,
        undefined,
        createMaxBotRegistry(['bot-1']) as never,
      );
      const result = await service.recordIfManagedEntityAccessLost({
        chatId: '-123',
        botId: null,
        operation: 'read',
        source: 'test',
        error: createMaxApiError(403, 'Forbidden', 'chat.denied'),
        lifecycleEventAt: new Date(),
      });
      expect(result).toMatchObject({ reason: 'bot_denied', recorded: null });
      expect(findMany).not.toHaveBeenCalled();
      expect(prisma.managedAutopostRule.updateMany).not.toHaveBeenCalled();
      expect(prisma.managedBroadcast.updateMany).not.toHaveBeenCalled();
      expect(prisma.managedBroadcastDelivery.updateMany).not.toHaveBeenCalled();
      expect(prisma.managedBroadcastOccurrence.updateMany).not.toHaveBeenCalled();
    },
  );

  it('does not clean runtime work if checking surviving access fails', async () => {
    const failure = new Error('survivor lookup unavailable');
    const prisma = {
      chat: {
        findUnique: jest.fn().mockResolvedValue({ title: 'channel', entityType: 'CHANNEL' }),
      },
      chatBotMembership: { findMany: jest.fn().mockRejectedValue(failure) },
      managedEntityAccessEdge: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
      managedAutopostRule: { updateMany: jest.fn() },
      managedBroadcast: { updateMany: jest.fn() },
    };
    const cache = {
      invalidate: jest.fn().mockResolvedValue(undefined),
      invalidateManagedEntityHeader: jest.fn().mockResolvedValue(undefined),
      clearManagedEntitiesRecentBootstrapForChat: jest.fn().mockResolvedValue(undefined),
    };
    const service = new ManagedEntityAccessLossService(
      prisma as never,
      { markChatBotRemoved: jest.fn().mockResolvedValue(null) } as never,
      cache as never,
      undefined,
      undefined,
      createMaxBotRegistry(['bot-1', 'bot-2']) as never,
    );
    await expect(
      service.recordManagedEntityAccessLost({
        chatId: '-123',
        botId: 'bot-1',
        reason: 'bot_denied',
        source: 'test',
      }),
    ).rejects.toBe(failure);
    expect(cache.invalidate).toHaveBeenCalledWith('-123');
    expect(cache.invalidateManagedEntityHeader).toHaveBeenCalledWith('-123');
    expect(cache.clearManagedEntitiesRecentBootstrapForChat).toHaveBeenCalled();
    expect(prisma.managedAutopostRule.updateMany).not.toHaveBeenCalled();
    expect(prisma.managedBroadcast.updateMany).not.toHaveBeenCalled();
  });

  it('forwards the remote probe epoch when recording classified access loss', async () => {
    const lifecycleEventAt = new Date('2026-08-20T12:00:00.123Z');
    const service = new ManagedEntityAccessLossService({} as never, {} as never, {} as never);
    const recordManagedEntityAccessLost = jest
      .spyOn(service, 'recordManagedEntityAccessLost')
      .mockResolvedValue(null);

    await expect(
      service.recordIfManagedEntityAccessLost({
        chatId: 'chat-1',
        botId: 'bot-1',
        error: createMaxApiError(403, 'Forbidden', 'chat.denied'),
        operation: 'lookup',
        source: 'admin_participant_lookup',
        lifecycleEventAt,
        lifecycleEventType: 'live_probe',
        lifecycleSource: 'live_probe',
        cachePublicationWaitMs: 250,
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        reason: 'bot_denied',
        recorded: null,
      }),
    );

    expect(recordManagedEntityAccessLost).toHaveBeenCalledWith({
      chatId: 'chat-1',
      botId: 'bot-1',
      entityType: undefined,
      title: undefined,
      source: 'admin_participant_lookup',
      reason: 'bot_denied',
      lastMaxErrorCode: 'chat.denied',
      lastMaxErrorMessage: 'forbidden',
      lastMaxStatusCode: 403,
      lifecycleEventAt,
      lifecycleEventType: 'live_probe',
      lifecycleSource: 'live_probe',
      cachePublicationWaitMs: 250,
    });
  });

  it('finalizes a trusted bot removal once and fences edges and caches by lifecycle time', async () => {
    const lifecycleEventAt = new Date('2026-08-20T12:00:00.123Z');
    jest.useFakeTimers().setSystemTime(lifecycleEventAt);
    const transaction = jest.fn();
    const prisma = {
      chat: {
        findUnique: jest.fn().mockResolvedValue({
          title: 'Managed chat',
          entityType: ChatEntityType.CHAT,
        }),
      },
      chatBotMembership: {
        findUnique: jest.fn().mockResolvedValue({
          status: ChatBotMembershipStatus.ACTIVE,
          permissionsSnapshot: null,
          botAccessState: ChatBotAccessState.CONFIRMED_ADMIN,
          botAccessExpiresAt: new Date('2026-08-20T12:15:00.000Z'),
        }),
        findMany: jest.fn().mockResolvedValue([{ botId: 'bot-2' }]),
      },
      managedEntityAccessEdge: {
        findMany: jest
          .fn()
          .mockResolvedValueOnce([{ userId: 'admin-1' }, { userId: 'admin-2' }])
          .mockResolvedValueOnce([{ userId: 'admin-1' }]),
        findFirst: jest.fn().mockResolvedValue({ botId: 'bot-2' }),
        updateMany: jest.fn().mockResolvedValue({ count: 2 }),
      },
      managedEntityAdminMember: {
        deleteMany: jest.fn().mockResolvedValue({ count: 2 }),
      },
      managedBotChatCatalog: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      $queryRaw: jest
        .fn()
        .mockResolvedValueOnce([{ id: 'chat-1' }])
        .mockResolvedValueOnce([
          {
            status: ChatBotMembershipStatus.REMOVED,
            lifecycleEventAt,
            lifecycleEventType: 'bot_removed',
            lifecycleSource: 'webhook',
          },
        ])
        .mockResolvedValueOnce([{ id: 'chat-1' }]),
      $transaction: transaction,
    };
    transaction.mockImplementation(async (callback: (client: typeof prisma) => Promise<unknown>) =>
      callback(prisma),
    );
    const maxBotLinkService = {
      markChatBotRemoved: jest.fn().mockResolvedValue('bot-2'),
    };
    const chatContextCache = {
      invalidate: jest.fn(() => new Promise<void>(() => undefined)),
      invalidateManagedEntityHeader: jest.fn().mockResolvedValue(undefined),
      clearManagedEntitiesRecentBootstrapForChat: jest.fn().mockResolvedValue(undefined),
      clearManagedEntitiesPublishedSnapshotsForUsers: jest.fn().mockResolvedValue(undefined),
      clearAdminAccess: jest.fn().mockResolvedValue(undefined),
      applyAdminAccessEpochMutation: jest.fn().mockResolvedValue(true),
    };
    const service = new ManagedEntityAccessLossService(
      prisma as never,
      maxBotLinkService as never,
      chatContextCache as never,
    );

    const recording = service.recordManagedEntityAccessLost({
      chatId: 'chat-1',
      botId: 'bot-1',
      entityType: ChatEntityType.CHAT,
      reason: 'bot_removed',
      source: 'webhook_bot_removed',
      lifecycleEventAt,
      lifecycleEventType: 'bot_removed',
      lifecycleSource: 'webhook',
      cachePublicationWaitMs: 100,
    });
    await jest.advanceTimersByTimeAsync(100);
    await expect(recording).resolves.toEqual(
      expect.objectContaining({
        chatId: 'chat-1',
        botId: 'bot-1',
        nextOwnerBotId: 'bot-2',
        updatedAccessEdges: 2,
      }),
    );

    expect(maxBotLinkService.markChatBotRemoved).toHaveBeenCalledTimes(1);
    expect(maxBotLinkService.markChatBotRemoved).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: 'chat-1',
        botId: 'bot-1',
        lifecycleEventAt,
        lifecycleEventType: 'bot_removed',
        lifecycleSource: 'webhook',
      }),
    );
    const lockSql = prisma.$queryRaw.mock.calls.map(([query]) =>
      (query as readonly string[]).join(''),
    );
    expect(lockSql).toHaveLength(3);
    expect(lockSql[0]).toContain('FROM "chats"');
    expect(lockSql[1]).toContain('FROM "chat_bot_memberships"');
    expect(lockSql[2]).toContain('FROM "chats"');
    expect(prisma.managedEntityAccessEdge.updateMany).toHaveBeenCalledWith({
      where: {
        chatId: 'chat-1',
        botId: 'bot-1',
        checkedAt: { lte: lifecycleEventAt },
      },
      data: expect.objectContaining({
        state: ManagedEntityAccessState.BOT_DENIED,
        checkedAt: lifecycleEventAt,
        expiresAt: null,
        source: 'webhook_bot_removed',
      }),
    });
    expect(chatContextCache.applyAdminAccessEpochMutation).toHaveBeenCalledTimes(1);
    expect(chatContextCache.applyAdminAccessEpochMutation).toHaveBeenCalledWith({
      chatId: 'chat-1',
      userId: 'admin-2',
      state: 'bot_denied',
      eventAt: lifecycleEventAt,
    });
    expect(chatContextCache.clearAdminAccess).not.toHaveBeenCalled();
    expect(chatContextCache.clearManagedEntitiesPublishedSnapshotsForUsers).not.toHaveBeenCalled();
    expect(chatContextCache.clearManagedEntitiesRecentBootstrapForChat).not.toHaveBeenCalled();
    expect(chatContextCache.invalidate).toHaveBeenCalledWith('chat-1');
    expect(prisma.managedEntityAdminMember.deleteMany).toHaveBeenCalledWith({
      where: {
        chatId: 'chat-1',
        observedByBotId: 'bot-1',
        checkedAt: { lte: lifecycleEventAt },
      },
    });
    expect(prisma.managedBotChatCatalog.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ botId: 'bot-1', chatId: 'chat-1' }),
        data: expect.objectContaining({ status: 'REMOVED', lastSeenAt: lifecycleEventAt }),
      }),
    );
  });

  it('skips runtime cleanup when the same bot recovers after lifecycle finalization', async () => {
    const lifecycleEventAt = new Date('2026-08-20T12:00:00.123Z');
    const prisma = {
      chat: {
        findUnique: jest.fn().mockResolvedValue({
          title: 'Managed chat',
          entityType: ChatEntityType.CHAT,
        }),
      },
    };
    const maxBotLinkService = {
      markChatBotRemoved: jest.fn().mockResolvedValue(null),
    };
    const service = new ManagedEntityAccessLossService(
      prisma as never,
      maxBotLinkService as never,
      {} as never,
    );
    jest.spyOn(service as any, 'finalizeLifecycleRemoval').mockResolvedValue({
      updatedAccessEdges: 0,
      removalStillCurrent: true,
    });
    const hasConfirmedSurvivingBotAccess = jest
      .spyOn(service as any, 'hasConfirmedSurvivingBotAccess')
      .mockResolvedValue(true);
    const cleanupRuntimeWork = jest.spyOn(service as any, 'cleanupRuntimeWork');

    await expect(
      service.recordManagedEntityAccessLost({
        chatId: 'chat-1',
        botId: 'bot-1',
        reason: 'bot_denied',
        source: 'max_action:send_message',
        lifecycleEventAt,
        lifecycleEventType: 'live_probe',
        lifecycleSource: 'live_probe',
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        chatId: 'chat-1',
        botId: 'bot-1',
        cleanup: expect.objectContaining({ nightModeJobsCleared: false }),
      }),
    );

    expect(hasConfirmedSurvivingBotAccess).toHaveBeenCalledWith({
      chatId: 'chat-1',
      lostBotId: null,
      preferredBotId: null,
    });
    expect(cleanupRuntimeWork).not.toHaveBeenCalled();
  });

  it('schedules lifecycle cleanup as a durable delayed job instead of mutating runtime work', async () => {
    const lifecycleEventAt = new Date('2026-08-20T12:00:00.123Z');
    jest.useFakeTimers().setSystemTime(new Date('2026-08-20T12:00:01.000Z'));
    const prisma = {
      chat: {
        findUnique: jest.fn().mockResolvedValue({
          title: 'Managed chat',
          entityType: ChatEntityType.CHAT,
        }),
      },
    };
    const rosterSyncQueue = {
      add: jest.fn().mockResolvedValue({ id: 'cleanup-job' }),
    };
    const service = new ManagedEntityAccessLossService(
      prisma as never,
      { markChatBotRemoved: jest.fn().mockResolvedValue(null) } as never,
      {} as never,
      undefined,
      rosterSyncQueue as never,
    );
    jest.spyOn(service as any, 'finalizeLifecycleRemoval').mockResolvedValue({
      updatedAccessEdges: 1,
      removalStillCurrent: true,
    });
    const cleanupRuntimeWork = jest.spyOn(service as any, 'cleanupRuntimeWork');
    const hasConfirmedSurvivingBotAccess = jest.spyOn(
      service as any,
      'hasConfirmedSurvivingBotAccess',
    );

    await expect(
      service.recordManagedEntityAccessLost({
        chatId: 'chat-1',
        botId: 'bot-1',
        reason: 'bot_removed',
        source: 'webhook_bot_removed',
        lifecycleEventAt,
        lifecycleEventType: 'bot_removed',
        lifecycleSource: 'webhook',
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        cleanup: expect.objectContaining({
          nightModeJobsCleared: false,
          canceledBroadcasts: null,
        }),
      }),
    );

    expect(rosterSyncQueue.add).toHaveBeenCalledWith(
      'cleanup-managed-entity-access-loss',
      {
        kind: MANAGED_ENTITY_ACCESS_LOSS_CLEANUP_JOB_KIND,
        chatId: 'chat-1',
        botId: 'bot-1',
        lifecycleEventAt: lifecycleEventAt.toISOString(),
        lifecycleEventType: 'bot_removed',
        lifecycleSource: 'webhook',
        reason: 'bot_removed',
        source: 'webhook_bot_removed',
        createdAt: '2026-08-20T12:00:01.000Z',
      },
      expect.objectContaining({
        jobId: expect.stringMatching(/^managed-entity-access-loss-cleanup__/u),
        delay: 45_000,
        attempts: 3,
        removeOnComplete: true,
        removeOnFail: false,
      }),
    );
    expect(hasConfirmedSurvivingBotAccess).not.toHaveBeenCalled();
    expect(cleanupRuntimeWork).not.toHaveBeenCalled();
  });

  it('preserves runtime work when deferred cleanup enqueue fails', async () => {
    const lifecycleEventAt = new Date('2026-08-20T12:00:00.123Z');
    const rosterSyncQueue = {
      add: jest.fn().mockRejectedValue(new Error('redis unavailable')),
    };
    const service = new ManagedEntityAccessLossService(
      {
        chat: {
          findUnique: jest.fn().mockResolvedValue({
            title: 'Managed chat',
            entityType: ChatEntityType.CHAT,
          }),
        },
      } as never,
      { markChatBotRemoved: jest.fn().mockResolvedValue(null) } as never,
      {} as never,
      undefined,
      rosterSyncQueue as never,
    );
    jest.spyOn(service as any, 'finalizeLifecycleRemoval').mockResolvedValue({
      updatedAccessEdges: 1,
      removalStillCurrent: true,
    });
    const cleanupRuntimeWork = jest.spyOn(service as any, 'cleanupRuntimeWork');

    await expect(
      service.recordManagedEntityAccessLost({
        chatId: 'chat-1',
        botId: 'bot-1',
        reason: 'bot_removed',
        source: 'webhook_bot_removed',
        lifecycleEventAt,
        lifecycleEventType: 'bot_removed',
        lifecycleSource: 'webhook',
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        cleanup: expect.objectContaining({ canceledBroadcasts: null }),
      }),
    );

    expect(rosterSyncQueue.add).toHaveBeenCalledTimes(1);
    expect(cleanupRuntimeWork).not.toHaveBeenCalled();
  });

  it('runs deferred SQL cleanup in the same transaction after the exact loss epoch survives', async () => {
    const lifecycleEventAt = new Date('2026-08-20T12:00:00.123Z');
    jest.useFakeTimers().setSystemTime(new Date('2026-08-20T12:00:45.123Z'));
    const tx = {
      $queryRaw: jest
        .fn()
        .mockResolvedValueOnce([{ id: 'chat-1' }])
        .mockResolvedValueOnce([
          {
            status: ChatBotMembershipStatus.REMOVED,
            lifecycleEventAt,
            lifecycleEventType: 'bot_removed',
            lifecycleSource: 'webhook',
          },
        ]),
      chatBotMembership: {
        findMany: jest.fn().mockResolvedValue([]),
      },
      managedEntityAccessEdge: {
        findFirst: jest.fn(),
      },
      managedAutopostRule: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      managedBroadcast: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      managedBroadcastDelivery: {
        updateMany: jest.fn().mockResolvedValue({ count: 2 }),
      },
      managedBroadcastCalendarReservation: {
        deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      managedBroadcastOccurrence: {
        updateMany: jest.fn().mockResolvedValue({ count: 3 }),
      },
      vkParsingPost: {
        updateMany: jest.fn().mockResolvedValue({ count: 4 }),
      },
      vkParsingSource: {
        updateMany: jest.fn().mockResolvedValue({ count: 5 }),
      },
    };
    const prisma = {
      $transaction: jest.fn(async (callback: (client: typeof tx) => Promise<unknown>) =>
        callback(tx),
      ),
    };
    const nightModeTransitionScheduler = {
      reconcileChat: jest.fn().mockResolvedValue({
        queueAvailable: true,
        scheduleEnabled: false,
        passes: 1,
      }),
    };
    const rosterSyncQueue = {
      getJob: jest.fn(),
    };
    const service = new ManagedEntityAccessLossService(
      prisma as never,
      {} as never,
      {} as never,
      nightModeTransitionScheduler as never,
      rosterSyncQueue as never,
      createMaxBotRegistry(['bot-1', 'bot-2']) as never,
    );

    await expect(
      service.processDeferredRuntimeCleanup(createDeferredCleanupJob()),
    ).resolves.toEqual({
      applied: true,
      skippedReason: null,
      cleanup: {
        nightModeJobsCleared: true,
        canceledBroadcasts: 1,
        canceledBroadcastDeliveries: 2,
        canceledBroadcastOccurrences: 3,
        clearedVkPublishPosts: null,
        pausedVkSources: null,
        removedRosterSyncJobs: null,
      },
    });

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(tx.managedAutopostRule.updateMany).toHaveBeenCalledTimes(1);
    expect(tx.managedBroadcast.updateMany).toHaveBeenCalledTimes(1);
    expect(tx.vkParsingPost.updateMany).not.toHaveBeenCalled();
    expect(tx.vkParsingSource.updateMany).not.toHaveBeenCalled();
    expect(nightModeTransitionScheduler.reconcileChat).toHaveBeenCalledWith('chat-1');
    expect(rosterSyncQueue.getJob).not.toHaveBeenCalled();
  });

  it('propagates deferred night-mode reconciliation failures for BullMQ retry', async () => {
    const lifecycleEventAt = new Date('2026-08-20T12:00:00.123Z');
    const tx = {
      $queryRaw: jest
        .fn()
        .mockResolvedValueOnce([{ id: 'chat-1' }])
        .mockResolvedValueOnce([
          {
            status: ChatBotMembershipStatus.REMOVED,
            lifecycleEventAt,
            lifecycleEventType: 'bot_removed',
            lifecycleSource: 'webhook',
          },
        ]),
      chatBotMembership: {
        findMany: jest.fn().mockResolvedValue([]),
      },
      managedEntityAccessEdge: {
        findFirst: jest.fn(),
      },
      managedAutopostRule: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      managedBroadcast: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      managedBroadcastDelivery: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      managedBroadcastCalendarReservation: {
        deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      managedBroadcastOccurrence: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      vkParsingPost: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      vkParsingSource: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    const prisma = {
      $transaction: jest.fn(async (callback: (client: typeof tx) => Promise<unknown>) =>
        callback(tx),
      ),
    };
    const reconcileError = new Error('night-mode redis unavailable');
    const nightModeTransitionScheduler = {
      reconcileChat: jest.fn().mockRejectedValue(reconcileError),
    };
    const service = new ManagedEntityAccessLossService(
      prisma as never,
      {} as never,
      {} as never,
      nightModeTransitionScheduler as never,
      undefined,
      createMaxBotRegistry(['bot-1']) as never,
    );

    await expect(service.processDeferredRuntimeCleanup(createDeferredCleanupJob())).rejects.toBe(
      reconcileError,
    );

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(tx.managedAutopostRule.updateMany).toHaveBeenCalledTimes(1);
    expect(nightModeTransitionScheduler.reconcileChat).toHaveBeenCalledWith('chat-1');
  });

  it('does not cancel runtime work after a newer same-bot grant supersedes the cleanup epoch', async () => {
    const lossAt = new Date('2026-08-20T12:00:00.123Z');
    const grantAt = new Date('2026-08-20T12:00:10.456Z');
    const tx = {
      $queryRaw: jest
        .fn()
        .mockResolvedValueOnce([{ id: 'chat-1' }])
        .mockResolvedValueOnce([
          {
            status: ChatBotMembershipStatus.ACTIVE,
            lifecycleEventAt: grantAt,
            lifecycleEventType: 'bot_added',
            lifecycleSource: 'webhook',
          },
        ]),
      chatBotMembership: {
        findMany: jest.fn(),
      },
      managedEntityAccessEdge: {
        findFirst: jest.fn(),
      },
      managedAutopostRule: {
        updateMany: jest.fn(),
      },
      managedBroadcast: {
        updateMany: jest.fn(),
      },
      managedBroadcastDelivery: {
        updateMany: jest.fn(),
      },
      managedBroadcastCalendarReservation: {
        deleteMany: jest.fn(),
      },
      managedBroadcastOccurrence: {
        updateMany: jest.fn(),
      },
      vkParsingPost: {
        updateMany: jest.fn(),
      },
      vkParsingSource: {
        updateMany: jest.fn(),
      },
    };
    const prisma = {
      $transaction: jest.fn(async (callback: (client: typeof tx) => Promise<unknown>) =>
        callback(tx),
      ),
    };
    const service = new ManagedEntityAccessLossService(
      prisma as never,
      {} as never,
      {} as never,
      undefined,
      undefined,
      createMaxBotRegistry(['bot-1']) as never,
    );

    await expect(
      service.processDeferredRuntimeCleanup(
        createDeferredCleanupJob({ lifecycleEventAt: lossAt.toISOString() }),
      ),
    ).resolves.toEqual({
      applied: false,
      skippedReason: 'stale_lifecycle',
      cleanup: expect.objectContaining({ canceledBroadcasts: null }),
    });

    expect(tx.chatBotMembership.findMany).not.toHaveBeenCalled();
    expect(tx.managedAutopostRule.updateMany).not.toHaveBeenCalled();
    expect(tx.managedBroadcast.updateMany).not.toHaveBeenCalled();
    expect(tx.managedBroadcastDelivery.updateMany).not.toHaveBeenCalled();
    expect(tx.vkParsingPost.updateMany).not.toHaveBeenCalled();
    expect(tx.vkParsingSource.updateMany).not.toHaveBeenCalled();
  });

  it('does not cancel runtime work while another actionable bot has fresh access', async () => {
    const lifecycleEventAt = new Date('2026-08-20T12:00:00.123Z');
    const tx = {
      $queryRaw: jest
        .fn()
        .mockResolvedValueOnce([{ id: 'chat-1' }])
        .mockResolvedValueOnce([
          {
            status: ChatBotMembershipStatus.REMOVED,
            lifecycleEventAt,
            lifecycleEventType: 'bot_removed',
            lifecycleSource: 'webhook',
          },
        ]),
      chatBotMembership: {
        findMany: jest.fn().mockResolvedValue([
          {
            botId: 'bot-2',
            status: ChatBotMembershipStatus.ACTIVE,
            permissionsSnapshot: null,
            botAccessState: null,
            botAccessExpiresAt: null,
          },
        ]),
      },
      managedEntityAccessEdge: {
        findFirst: jest.fn().mockResolvedValue({ botId: 'bot-2' }),
      },
      managedAutopostRule: {
        updateMany: jest.fn(),
      },
      managedBroadcast: {
        updateMany: jest.fn(),
      },
      managedBroadcastDelivery: {
        updateMany: jest.fn(),
      },
      managedBroadcastCalendarReservation: {
        deleteMany: jest.fn(),
      },
      managedBroadcastOccurrence: {
        updateMany: jest.fn(),
      },
      vkParsingPost: {
        updateMany: jest.fn(),
      },
      vkParsingSource: {
        updateMany: jest.fn(),
      },
    };
    const prisma = {
      $transaction: jest.fn(async (callback: (client: typeof tx) => Promise<unknown>) =>
        callback(tx),
      ),
    };
    const service = new ManagedEntityAccessLossService(
      prisma as never,
      {} as never,
      {} as never,
      undefined,
      undefined,
      createMaxBotRegistry(['bot-1', 'bot-2']) as never,
    );

    await expect(
      service.processDeferredRuntimeCleanup(createDeferredCleanupJob()),
    ).resolves.toEqual({
      applied: false,
      skippedReason: 'surviving_access',
      cleanup: expect.objectContaining({ canceledBroadcasts: null }),
    });

    expect(tx.managedEntityAccessEdge.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          chatId: 'chat-1',
          botId: { in: ['bot-2'] },
          state: ManagedEntityAccessState.GRANTED,
        }),
      }),
    );
    expect(tx.managedAutopostRule.updateMany).not.toHaveBeenCalled();
    expect(tx.managedBroadcast.updateMany).not.toHaveBeenCalled();
    expect(tx.vkParsingSource.updateMany).not.toHaveBeenCalled();
  });

  it('marks bot membership removed, denies existing access edges, clears caches and night jobs', async () => {
    const prisma = {
      chat: {
        findUnique: jest.fn().mockResolvedValue({
          title: 'Managed chat',
          entityType: ChatEntityType.CHAT,
        }),
      },
      chatBotMembership: {
        findUnique: jest.fn(),
      },
      managedEntityAccessEdge: {
        updateMany: jest.fn().mockResolvedValue({ count: 2 }),
        findFirst: jest.fn(),
      },
      managedBroadcast: {
        findMany: jest.fn().mockResolvedValue([{ id: 'publication-broadcast-1' }]),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      managedBroadcastDelivery: {
        updateMany: jest.fn().mockResolvedValue({ count: 3 }),
      },
      managedBroadcastOccurrence: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      managedAutopostRule: {
        updateMany: jest.fn().mockResolvedValue({ count: 2 }),
      },
      publication: {
        findMany: jest.fn().mockResolvedValue([{ id: 'publication-1' }]),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      publicationSchedule: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      vkParsingPost: {
        updateMany: jest.fn().mockResolvedValue({ count: 4 }),
      },
      vkParsingSource: {
        updateMany: jest.fn().mockResolvedValue({ count: 2 }),
      },
    };
    const maxBotLinkService = {
      markChatBotRemoved: jest.fn().mockResolvedValue(null),
      resolveBotId: jest.fn(),
    };
    const chatContextCache = {
      invalidate: jest.fn().mockResolvedValue(undefined),
      clearManagedEntitiesRecentBootstrapForChat: jest.fn().mockResolvedValue(undefined),
    };
    const nightModeTransitionScheduler = {
      reconcileChat: jest.fn().mockResolvedValue({
        queueAvailable: true,
        scheduleEnabled: false,
        passes: 1,
      }),
    };
    const rosterSyncJob = {
      getState: jest.fn().mockResolvedValue('delayed'),
      remove: jest.fn().mockResolvedValue(undefined),
    };
    const rosterSyncQueue = {
      getJob: jest.fn().mockResolvedValue(rosterSyncJob),
    };
    const service = new ManagedEntityAccessLossService(
      prisma as never,
      maxBotLinkService as never,
      chatContextCache as never,
      nightModeTransitionScheduler as never,
      rosterSyncQueue as never,
    );

    await expect(
      service.recordManagedEntityAccessLost({
        chatId: ' chat-1 ',
        botId: ' bot-1 ',
        reason: 'chat_not_found',
        source: 'unit-test',
      }),
    ).resolves.toEqual({
      chatId: 'chat-1',
      botId: 'bot-1',
      nextOwnerBotId: null,
      updatedAccessEdges: 2,
      cleanup: {
        nightModeJobsCleared: true,
        canceledBroadcasts: 1,
        canceledBroadcastDeliveries: 3,
        canceledBroadcastOccurrences: 1,
        clearedVkPublishPosts: null,
        pausedVkSources: null,
        removedRosterSyncJobs: 1,
      },
    });

    expect(maxBotLinkService.markChatBotRemoved).toHaveBeenCalledWith({
      chatId: 'chat-1',
      botId: 'bot-1',
      title: 'Managed chat',
      entityType: ChatEntityType.CHAT,
      accessLostReason: 'chat_not_found',
      accessLostSource: 'unit-test',
      lastMaxErrorCode: undefined,
      lastMaxErrorMessage: undefined,
      lastMaxStatusCode: undefined,
    });
    expect(prisma.managedEntityAccessEdge.updateMany).toHaveBeenCalledWith({
      where: {
        chatId: 'chat-1',
        botId: 'bot-1',
      },
      data: expect.objectContaining({
        state: ManagedEntityAccessState.BOT_DENIED,
        botRole: 'MEMBER',
        expiresAt: null,
        deniedReason: 'chat_not_found',
        source: 'unit-test',
      }),
    });
    expect(chatContextCache.invalidate).toHaveBeenCalledWith('chat-1');
    expect(chatContextCache.clearManagedEntitiesRecentBootstrapForChat).toHaveBeenCalledWith(
      'chat-1',
      'chat',
    );
    expect(nightModeTransitionScheduler.reconcileChat).toHaveBeenCalledWith('chat-1');
    expect(prisma.managedAutopostRule.updateMany).toHaveBeenCalledWith({
      where: {
        sourceChatId: 'chat-1',
        status: {
          in: [ManagedAutopostRuleStatus.ACTIVE, ManagedAutopostRuleStatus.ERROR],
        },
      },
      data: expect.objectContaining({
        status: ManagedAutopostRuleStatus.PAUSED,
        nextMaterializeAt: null,
        lockedAt: null,
        lockToken: null,
      }),
    });
    expect(prisma.publication.findMany).not.toHaveBeenCalled();
    expect(prisma.publicationSchedule.updateMany).not.toHaveBeenCalled();
    expect(prisma.publication.updateMany).not.toHaveBeenCalled();
    expect(prisma.managedBroadcast.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          sourceChatId: 'chat-1',
          publicationOccurrenceId: null,
        }),
        data: expect.objectContaining({ status: 'CANCELED', nextSendAt: null }),
      }),
    );
    expect(rosterSyncQueue.getJob).toHaveBeenCalledWith('chat-admin-roster-sync__chat-1');
    expect(rosterSyncJob.remove).toHaveBeenCalledTimes(1);
    expect(prisma.vkParsingPost.updateMany).not.toHaveBeenCalled();
    expect(prisma.vkParsingSource.updateMany).not.toHaveBeenCalled();
  });

  it('keeps publication envelopes and healthy targets active while canceling the lost target', async () => {
    const broadcasts = [
      {
        id: 'publication-envelope',
        sourceChatId: 'chat-lost',
        publicationOccurrenceId: 'publication-occurrence-1',
        status: ManagedBroadcastStatus.ACTIVE,
      },
      {
        id: 'legacy-broadcast',
        sourceChatId: 'chat-lost',
        publicationOccurrenceId: null,
        status: ManagedBroadcastStatus.ACTIVE,
      },
    ];
    const deliveries = [
      {
        id: 'publication-lost-pending',
        broadcastId: 'publication-envelope',
        targetChatId: 'chat-lost',
        status: ManagedBroadcastDeliveryStatus.PENDING,
        lastErrorCode: null as string | null,
      },
      {
        id: 'publication-lost-failed',
        broadcastId: 'publication-envelope',
        targetChatId: 'chat-lost',
        status: ManagedBroadcastDeliveryStatus.FAILED,
        lastErrorCode: null as string | null,
      },
      {
        id: 'legacy-lost-sending',
        broadcastId: 'legacy-broadcast',
        targetChatId: 'chat-lost',
        status: ManagedBroadcastDeliveryStatus.SENDING,
        lastErrorCode: null as string | null,
      },
      {
        id: 'publication-lost-sent',
        broadcastId: 'publication-envelope',
        targetChatId: 'chat-lost',
        status: ManagedBroadcastDeliveryStatus.SENT,
        lastErrorCode: null as string | null,
      },
      {
        id: 'publication-healthy-pending',
        broadcastId: 'publication-envelope',
        targetChatId: 'chat-healthy',
        status: ManagedBroadcastDeliveryStatus.PENDING,
        lastErrorCode: null as string | null,
      },
    ];
    const reservations = [
      {
        id: 'publication-lost-reservation',
        broadcastId: 'publication-envelope',
        sourceChatId: 'chat-lost',
        targetChatId: 'chat-lost',
      },
      {
        id: 'publication-healthy-reservation',
        broadcastId: 'publication-envelope',
        sourceChatId: 'chat-lost',
        targetChatId: 'chat-healthy',
      },
      {
        id: 'legacy-source-reservation',
        broadcastId: 'legacy-broadcast',
        sourceChatId: 'chat-lost',
        targetChatId: 'chat-healthy',
      },
    ];
    const occurrences = [
      {
        id: 'publication-envelope-occurrence',
        broadcastId: 'publication-envelope',
        sourceChatId: 'chat-lost',
        status: ManagedBroadcastStatus.ACTIVE,
      },
      {
        id: 'legacy-occurrence',
        broadcastId: 'legacy-broadcast',
        sourceChatId: 'chat-lost',
        status: ManagedBroadcastStatus.ACTIVE,
      },
    ];
    const broadcastById = new Map(broadcasts.map((broadcast) => [broadcast.id, broadcast]));
    const prisma = {
      managedBroadcast: {
        updateMany: jest.fn(async ({ data }: { data: { status: ManagedBroadcastStatus } }) => {
          const affected = broadcasts.filter(
            (broadcast) =>
              broadcast.sourceChatId === 'chat-lost' &&
              broadcast.publicationOccurrenceId === null &&
              broadcast.status === ManagedBroadcastStatus.ACTIVE,
          );
          affected.forEach((broadcast) => Object.assign(broadcast, data));
          return { count: affected.length };
        }),
      },
      managedBroadcastDelivery: {
        updateMany: jest.fn(
          async ({
            data,
          }: {
            data: { status: ManagedBroadcastDeliveryStatus; lastErrorCode: string };
          }) => {
            const affected = deliveries.filter(
              (delivery) =>
                delivery.targetChatId === 'chat-lost' &&
                new Set<ManagedBroadcastDeliveryStatus>([
                  ManagedBroadcastDeliveryStatus.PENDING,
                  ManagedBroadcastDeliveryStatus.FAILED,
                ]).has(delivery.status),
            );
            affected.forEach((delivery) => Object.assign(delivery, data));
            return { count: affected.length };
          },
        ),
      },
      managedBroadcastCalendarReservation: {
        deleteMany: jest.fn(async () => {
          const retained = reservations.filter((reservation) => {
            const broadcast = broadcastById.get(reservation.broadcastId);
            return !(
              reservation.targetChatId === 'chat-lost' ||
              (reservation.sourceChatId === 'chat-lost' &&
                broadcast?.publicationOccurrenceId === null)
            );
          });
          const count = reservations.length - retained.length;
          reservations.splice(0, reservations.length, ...retained);
          return { count };
        }),
      },
      managedBroadcastOccurrence: {
        updateMany: jest.fn(async ({ data }: { data: { status: ManagedBroadcastStatus } }) => {
          const affected = occurrences.filter(
            (occurrence) =>
              occurrence.sourceChatId === 'chat-lost' &&
              broadcastById.get(occurrence.broadcastId)?.publicationOccurrenceId === null &&
              occurrence.status === ManagedBroadcastStatus.ACTIVE,
          );
          affected.forEach((occurrence) => Object.assign(occurrence, data));
          return { count: affected.length };
        }),
      },
    };
    const service = new ManagedEntityAccessLossService(prisma as never, {} as never, {} as never);
    const cleanup = {
      nightModeJobsCleared: false,
      canceledBroadcasts: null,
      canceledBroadcastDeliveries: null,
      canceledBroadcastOccurrences: null,
      clearedVkPublishPosts: null,
      pausedVkSources: null,
      removedRosterSyncJobs: null,
    };

    await (service as any).cancelManagedBroadcastRuntime(
      { chatId: 'chat-lost', reason: 'bot_denied', source: 'unit-test' },
      cleanup,
    );

    expect(prisma.managedBroadcast.updateMany).toHaveBeenCalledWith({
      where: {
        sourceChatId: 'chat-lost',
        publicationOccurrenceId: null,
        status: {
          in: [
            ManagedBroadcastStatus.ACTIVE,
            ManagedBroadcastStatus.PARTIAL,
            ManagedBroadcastStatus.FAILED,
          ],
        },
      },
      data: expect.objectContaining({
        status: ManagedBroadcastStatus.CANCELED,
        nextSendAt: null,
      }),
    });
    expect(prisma.managedBroadcastDelivery.updateMany).toHaveBeenCalledWith({
      where: {
        targetChatId: 'chat-lost',
        status: {
          in: [ManagedBroadcastDeliveryStatus.PENDING, ManagedBroadcastDeliveryStatus.FAILED],
        },
      },
      data: expect.objectContaining({
        status: ManagedBroadcastDeliveryStatus.CANCELED,
        lockedAt: null,
        lockToken: null,
        lastErrorCode: PUBLICATION_DELIVERY_ACCESS_LOST_ERROR_CODE,
      }),
    });
    expect(prisma.managedBroadcastCalendarReservation.deleteMany).toHaveBeenCalledWith({
      where: {
        OR: [
          { targetChatId: 'chat-lost' },
          {
            sourceChatId: 'chat-lost',
            broadcast: { is: { publicationOccurrenceId: null } },
          },
        ],
      },
    });
    expect(prisma.managedBroadcastOccurrence.updateMany).toHaveBeenCalledWith({
      where: {
        sourceChatId: 'chat-lost',
        broadcast: { is: { publicationOccurrenceId: null } },
        status: {
          in: [
            ManagedBroadcastStatus.ACTIVE,
            ManagedBroadcastStatus.PARTIAL,
            ManagedBroadcastStatus.FAILED,
          ],
        },
      },
      data: { status: ManagedBroadcastStatus.CANCELED },
    });
    expect(cleanup).toEqual(
      expect.objectContaining({
        canceledBroadcasts: 1,
        canceledBroadcastDeliveries: 2,
        canceledBroadcastOccurrences: 1,
      }),
    );
    expect(broadcasts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'publication-envelope',
          status: ManagedBroadcastStatus.ACTIVE,
        }),
        expect.objectContaining({
          id: 'legacy-broadcast',
          status: ManagedBroadcastStatus.CANCELED,
        }),
      ]),
    );
    expect(deliveries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'publication-healthy-pending',
          status: ManagedBroadcastDeliveryStatus.PENDING,
          lastErrorCode: null,
        }),
        expect.objectContaining({
          id: 'publication-lost-sent',
          status: ManagedBroadcastDeliveryStatus.SENT,
          lastErrorCode: null,
        }),
        expect.objectContaining({
          id: 'publication-lost-pending',
          status: ManagedBroadcastDeliveryStatus.CANCELED,
          lastErrorCode: PUBLICATION_DELIVERY_ACCESS_LOST_ERROR_CODE,
        }),
        expect.objectContaining({
          id: 'legacy-lost-sending',
          status: ManagedBroadcastDeliveryStatus.SENDING,
          lastErrorCode: null,
        }),
      ]),
    );
    expect(reservations).toEqual([
      expect.objectContaining({ id: 'publication-healthy-reservation' }),
    ]);
    expect(occurrences).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'publication-envelope-occurrence',
          status: ManagedBroadcastStatus.ACTIVE,
        }),
        expect.objectContaining({
          id: 'legacy-occurrence',
          status: ManagedBroadcastStatus.CANCELED,
        }),
      ]),
    );
  });

  it('keeps runtime work when a promoted replacement bot has confirmed access', async () => {
    const prisma = {
      chat: {
        findUnique: jest.fn().mockResolvedValue({
          title: 'Managed chat',
          entityType: ChatEntityType.CHAT,
        }),
      },
      chatBotMembership: {
        findUnique: jest.fn().mockResolvedValue({
          status: 'ACTIVE',
          permissionsSnapshot: {
            checkedAt: new Date().toISOString(),
            isAdmin: true,
            isOwner: false,
            permissions: [],
          },
        }),
      },
      managedEntityAccessEdge: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findFirst: jest.fn().mockResolvedValue(null),
      },
      managedBroadcast: {
        updateMany: jest.fn(),
      },
      managedBroadcastDelivery: {
        updateMany: jest.fn(),
      },
      managedBroadcastOccurrence: {
        updateMany: jest.fn(),
      },
      vkParsingPost: {
        updateMany: jest.fn(),
      },
      vkParsingSource: {
        updateMany: jest.fn(),
      },
    };
    const maxBotLinkService = {
      markChatBotRemoved: jest.fn().mockResolvedValue('bot-2'),
      resolveBotId: jest.fn(),
    };
    const chatContextCache = {
      invalidate: jest.fn().mockResolvedValue(undefined),
      clearManagedEntitiesRecentBootstrapForChat: jest.fn().mockResolvedValue(undefined),
    };
    const nightModeTransitionScheduler = {
      reconcileChat: jest.fn().mockResolvedValue({
        queueAvailable: true,
        scheduleEnabled: false,
        passes: 1,
      }),
    };
    const rosterSyncQueue = {
      getJob: jest.fn(),
    };
    const service = new ManagedEntityAccessLossService(
      prisma as never,
      maxBotLinkService as never,
      chatContextCache as never,
      nightModeTransitionScheduler as never,
      rosterSyncQueue as never,
    );

    await expect(
      service.recordManagedEntityAccessLost({
        chatId: 'chat-1',
        botId: 'bot-1',
        reason: 'bot_denied',
        source: 'unit-test',
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        chatId: 'chat-1',
        botId: 'bot-1',
        nextOwnerBotId: 'bot-2',
        updatedAccessEdges: 1,
        cleanup: {
          nightModeJobsCleared: false,
          canceledBroadcasts: null,
          canceledBroadcastDeliveries: null,
          canceledBroadcastOccurrences: null,
          clearedVkPublishPosts: null,
          pausedVkSources: null,
          removedRosterSyncJobs: null,
        },
      }),
    );

    expect(prisma.chatBotMembership.findUnique).toHaveBeenCalledWith({
      where: {
        chatId_botId: {
          chatId: 'chat-1',
          botId: 'bot-2',
        },
      },
      select: {
        status: true,
        permissionsSnapshot: true,
        botAccessState: true,
        botAccessExpiresAt: true,
      },
    });
    expect(nightModeTransitionScheduler.reconcileChat).not.toHaveBeenCalled();
    expect(rosterSyncQueue.getJob).not.toHaveBeenCalled();
    expect(prisma.managedBroadcast.updateMany).not.toHaveBeenCalled();
    expect(prisma.vkParsingSource.updateMany).not.toHaveBeenCalled();
  });

  it('cleans runtime work when a promoted replacement has a fresh edge but no active membership', async () => {
    const prisma = {
      chat: {
        findUnique: jest.fn().mockResolvedValue({
          title: 'Managed chat',
          entityType: ChatEntityType.CHAT,
        }),
      },
      chatBotMembership: {
        findUnique: jest.fn().mockResolvedValue(null),
      },
      managedEntityAccessEdge: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findFirst: jest.fn().mockResolvedValue({ botId: 'bot-2' }),
      },
      managedBroadcast: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      managedBroadcastDelivery: {
        updateMany: jest.fn().mockResolvedValue({ count: 2 }),
      },
      managedBroadcastOccurrence: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      vkParsingPost: {
        updateMany: jest.fn().mockResolvedValue({ count: 3 }),
      },
      vkParsingSource: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    const maxBotLinkService = {
      markChatBotRemoved: jest.fn().mockResolvedValue('bot-2'),
      resolveBotId: jest.fn(),
    };
    const chatContextCache = {
      invalidate: jest.fn().mockResolvedValue(undefined),
      clearManagedEntitiesRecentBootstrapForChat: jest.fn().mockResolvedValue(undefined),
    };
    const nightModeTransitionScheduler = {
      reconcileChat: jest.fn().mockResolvedValue({
        queueAvailable: true,
        scheduleEnabled: false,
        passes: 1,
      }),
    };
    const rosterSyncQueue = {
      getJob: jest.fn().mockResolvedValue(null),
    };
    const service = new ManagedEntityAccessLossService(
      prisma as never,
      maxBotLinkService as never,
      chatContextCache as never,
      nightModeTransitionScheduler as never,
      rosterSyncQueue as never,
    );

    await expect(
      service.recordManagedEntityAccessLost({
        chatId: 'chat-1',
        botId: 'bot-1',
        reason: 'bot_denied',
        source: 'unit-test',
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        nextOwnerBotId: 'bot-2',
        cleanup: expect.objectContaining({
          nightModeJobsCleared: true,
          canceledBroadcasts: 1,
          canceledBroadcastDeliveries: 2,
          canceledBroadcastOccurrences: 1,
          clearedVkPublishPosts: null,
          pausedVkSources: null,
          removedRosterSyncJobs: 0,
        }),
      }),
    );
    expect(prisma.managedEntityAccessEdge.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          chatId: 'chat-1',
          botId: 'bot-2',
          state: ManagedEntityAccessState.GRANTED,
        }),
      }),
    );
    expect(nightModeTransitionScheduler.reconcileChat).toHaveBeenCalledWith('chat-1');
  });

  it('preserves runtime work when a replacement has an old confirmed snapshot', async () => {
    const staleCheckedAt = new Date(Date.now() - 2 * 24 * 60 * 60 * 1_000).toISOString();
    const prisma = {
      chat: {
        findUnique: jest.fn().mockResolvedValue({
          title: 'Managed chat',
          entityType: ChatEntityType.CHANNEL,
        }),
      },
      chatBotMembership: {
        findUnique: jest.fn().mockResolvedValue({
          status: 'ACTIVE',
          permissionsSnapshot: {
            checkedAt: staleCheckedAt,
            isAdmin: true,
            isOwner: true,
            permissions: ['delete_messages', 'add_remove_members'],
          },
        }),
      },
      managedEntityAccessEdge: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findFirst: jest.fn().mockResolvedValue(null),
      },
      managedBroadcast: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      managedBroadcastDelivery: {
        updateMany: jest.fn().mockResolvedValue({ count: 2 }),
      },
      managedBroadcastOccurrence: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      vkParsingPost: {
        updateMany: jest.fn().mockResolvedValue({ count: 3 }),
      },
      vkParsingSource: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    const maxBotLinkService = {
      markChatBotRemoved: jest.fn().mockResolvedValue('bot-3'),
      resolveBotId: jest.fn(),
    };
    const chatContextCache = {
      invalidate: jest.fn().mockResolvedValue(undefined),
      invalidateManagedEntityHeader: jest.fn().mockResolvedValue(undefined),
      clearManagedEntitiesRecentBootstrapForChat: jest.fn().mockResolvedValue(undefined),
    };
    const nightModeTransitionScheduler = {
      reconcileChat: jest.fn().mockResolvedValue({
        queueAvailable: true,
        scheduleEnabled: false,
        passes: 1,
      }),
    };
    const rosterSyncQueue = {
      getJob: jest.fn().mockResolvedValue(null),
    };
    const service = new ManagedEntityAccessLossService(
      prisma as never,
      maxBotLinkService as never,
      chatContextCache as never,
      nightModeTransitionScheduler as never,
      rosterSyncQueue as never,
    );

    await expect(
      service.recordManagedEntityAccessLost({
        chatId: 'channel-1',
        botId: 'bot-1',
        reason: 'bot_denied',
        source: 'unit-test',
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        chatId: 'channel-1',
        botId: 'bot-1',
        nextOwnerBotId: 'bot-3',
        cleanup: expect.objectContaining({
          nightModeJobsCleared: false,
          canceledBroadcasts: null,
          canceledBroadcastDeliveries: null,
          canceledBroadcastOccurrences: null,
          clearedVkPublishPosts: null,
          pausedVkSources: null,
          removedRosterSyncJobs: null,
        }),
      }),
    );

    expect(prisma.chatBotMembership.findUnique).toHaveBeenCalledWith({
      where: {
        chatId_botId: {
          chatId: 'channel-1',
          botId: 'bot-3',
        },
      },
      select: {
        status: true,
        permissionsSnapshot: true,
        botAccessState: true,
        botAccessExpiresAt: true,
      },
    });
    expect(nightModeTransitionScheduler.reconcileChat).not.toHaveBeenCalled();
    expect(prisma.managedBroadcast.updateMany).not.toHaveBeenCalled();
    expect(prisma.vkParsingPost.updateMany).not.toHaveBeenCalled();
    expect(prisma.vkParsingSource.updateMany).not.toHaveBeenCalled();
    expect(chatContextCache.clearManagedEntitiesRecentBootstrapForChat).toHaveBeenCalledWith(
      'channel-1',
      'channel',
    );
  });

  it('cleans runtime work when a fresh granted access edge has no active bot membership', async () => {
    const prisma = {
      chat: {
        findUnique: jest.fn().mockResolvedValue({
          title: 'Managed chat',
          entityType: ChatEntityType.CHAT,
        }),
      },
      chatBotMembership: {
        findMany: jest.fn().mockResolvedValue([]),
      },
      managedEntityAccessEdge: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findFirst: jest.fn().mockResolvedValue({ botId: 'bot-2' }),
      },
      managedBroadcast: {
        updateMany: jest.fn(),
      },
      managedBroadcastDelivery: {
        updateMany: jest.fn(),
      },
      managedBroadcastOccurrence: {
        updateMany: jest.fn(),
      },
      vkParsingPost: {
        updateMany: jest.fn(),
      },
      vkParsingSource: {
        updateMany: jest.fn(),
      },
    };
    const maxBotLinkService = {
      markChatBotRemoved: jest.fn().mockResolvedValue(null),
      resolveBotId: jest.fn(),
    };
    const chatContextCache = {
      invalidate: jest.fn().mockResolvedValue(undefined),
      clearManagedEntitiesRecentBootstrapForChat: jest.fn().mockResolvedValue(undefined),
    };
    const nightModeTransitionScheduler = {
      reconcileChat: jest.fn().mockResolvedValue({
        queueAvailable: true,
        scheduleEnabled: false,
        passes: 1,
      }),
    };
    const rosterSyncQueue = {
      getJob: jest.fn(),
    };
    const service = new ManagedEntityAccessLossService(
      prisma as never,
      maxBotLinkService as never,
      chatContextCache as never,
      nightModeTransitionScheduler as never,
      rosterSyncQueue as never,
      createMaxBotRegistry(['bot-1', 'bot-2']) as never,
    );

    await expect(
      service.recordManagedEntityAccessLost({
        chatId: 'chat-1',
        botId: 'bot-1',
        reason: 'bot_denied',
        source: 'unit-test',
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        chatId: 'chat-1',
        botId: 'bot-1',
        nextOwnerBotId: null,
        cleanup: expect.objectContaining({
          nightModeJobsCleared: true,
          canceledBroadcasts: null,
          canceledBroadcastDeliveries: null,
          canceledBroadcastOccurrences: null,
          clearedVkPublishPosts: null,
          pausedVkSources: null,
          removedRosterSyncJobs: 0,
        }),
      }),
    );

    expect(prisma.chatBotMembership.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          chatId: 'chat-1',
          botId: { in: ['bot-2'] },
          status: ChatBotMembershipStatus.ACTIVE,
        }),
      }),
    );
    expect(prisma.managedEntityAccessEdge.findFirst).not.toHaveBeenCalled();
    expect(nightModeTransitionScheduler.reconcileChat).toHaveBeenCalledWith('chat-1');
    expect(rosterSyncQueue.getJob).toHaveBeenCalledWith('chat-admin-roster-sync__chat-1');
    expect(prisma.managedBroadcast.updateMany).toHaveBeenCalled();
    expect(prisma.vkParsingPost.updateMany).not.toHaveBeenCalled();
    expect(prisma.vkParsingSource.updateMany).not.toHaveBeenCalled();
  });

  it('keeps runtime work when a fresh granted edge belongs to an active surviving bot membership', async () => {
    const prisma = {
      chat: {
        findUnique: jest.fn().mockResolvedValue({
          title: 'Managed chat',
          entityType: ChatEntityType.CHAT,
        }),
      },
      chatBotMembership: {
        findMany: jest.fn().mockResolvedValue([
          {
            botId: 'bot-2',
            status: ChatBotMembershipStatus.ACTIVE,
            permissionsSnapshot: null,
            botAccessState: null,
            botAccessExpiresAt: null,
          },
        ]),
      },
      managedEntityAccessEdge: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findFirst: jest.fn().mockResolvedValue({ botId: 'bot-2' }),
      },
      managedBroadcast: {
        updateMany: jest.fn(),
      },
      managedBroadcastDelivery: {
        updateMany: jest.fn(),
      },
      managedBroadcastOccurrence: {
        updateMany: jest.fn(),
      },
      vkParsingPost: {
        updateMany: jest.fn(),
      },
      vkParsingSource: {
        updateMany: jest.fn(),
      },
    };
    const maxBotLinkService = {
      markChatBotRemoved: jest.fn().mockResolvedValue(null),
      resolveBotId: jest.fn(),
    };
    const chatContextCache = {
      invalidate: jest.fn().mockResolvedValue(undefined),
      clearManagedEntitiesRecentBootstrapForChat: jest.fn().mockResolvedValue(undefined),
    };
    const nightModeTransitionScheduler = {
      reconcileChat: jest.fn().mockResolvedValue({
        queueAvailable: true,
        scheduleEnabled: false,
        passes: 1,
      }),
    };
    const rosterSyncQueue = {
      getJob: jest.fn(),
    };
    const service = new ManagedEntityAccessLossService(
      prisma as never,
      maxBotLinkService as never,
      chatContextCache as never,
      nightModeTransitionScheduler as never,
      rosterSyncQueue as never,
      createMaxBotRegistry(['bot-1', 'bot-2']) as never,
    );

    await expect(
      service.recordManagedEntityAccessLost({
        chatId: 'chat-1',
        botId: 'bot-1',
        reason: 'bot_denied',
        source: 'unit-test',
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        chatId: 'chat-1',
        botId: 'bot-1',
        nextOwnerBotId: null,
        cleanup: {
          nightModeJobsCleared: false,
          canceledBroadcasts: null,
          canceledBroadcastDeliveries: null,
          canceledBroadcastOccurrences: null,
          clearedVkPublishPosts: null,
          pausedVkSources: null,
          removedRosterSyncJobs: null,
        },
      }),
    );

    expect(prisma.managedEntityAccessEdge.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          chatId: 'chat-1',
          botId: { in: ['bot-2'] },
          state: ManagedEntityAccessState.GRANTED,
        }),
      }),
    );
    expect(nightModeTransitionScheduler.reconcileChat).not.toHaveBeenCalled();
    expect(rosterSyncQueue.getJob).not.toHaveBeenCalled();
    expect(prisma.managedBroadcast.updateMany).not.toHaveBeenCalled();
    expect(prisma.vkParsingSource.updateMany).not.toHaveBeenCalled();
  });

  it('keeps runtime work when the lost bot is unresolved even if another bot has fresh access', async () => {
    const prisma = {
      chat: {
        findUnique: jest.fn().mockResolvedValue({
          title: 'Managed chat',
          entityType: ChatEntityType.CHAT,
        }),
      },
      chatBotMembership: {
        findMany: jest.fn().mockResolvedValue([
          {
            botId: 'bot-2',
            status: ChatBotMembershipStatus.ACTIVE,
            permissionsSnapshot: null,
            botAccessState: ChatBotAccessState.CONFIRMED_ADMIN,
            botAccessExpiresAt: new Date(Date.now() + 60_000),
          },
        ]),
      },
      managedEntityAccessEdge: {
        updateMany: jest.fn(),
        findFirst: jest.fn().mockResolvedValue(null),
      },
      managedBroadcast: {
        updateMany: jest.fn(),
      },
      managedBroadcastDelivery: {
        updateMany: jest.fn(),
      },
      managedBroadcastOccurrence: {
        updateMany: jest.fn(),
      },
      vkParsingPost: {
        updateMany: jest.fn(),
      },
      vkParsingSource: {
        updateMany: jest.fn(),
      },
    };
    const maxBotLinkService = {
      markChatBotRemoved: jest.fn(),
      resolveBotId: jest.fn().mockResolvedValue(null),
    };
    const chatContextCache = {
      invalidate: jest.fn().mockResolvedValue(undefined),
      clearManagedEntitiesRecentBootstrapForChat: jest.fn().mockResolvedValue(undefined),
    };
    const nightModeTransitionScheduler = {
      reconcileChat: jest.fn().mockResolvedValue({
        queueAvailable: true,
        scheduleEnabled: false,
        passes: 1,
      }),
    };
    const rosterSyncQueue = {
      getJob: jest.fn(),
    };
    const service = new ManagedEntityAccessLossService(
      prisma as never,
      maxBotLinkService as never,
      chatContextCache as never,
      nightModeTransitionScheduler as never,
      rosterSyncQueue as never,
      createMaxBotRegistry(['bot-2']) as never,
    );

    await expect(
      service.recordManagedEntityAccessLost({
        chatId: 'chat-1',
        botId: null,
        reason: 'bot_denied',
        source: 'unit-test',
      }),
    ).resolves.toBeNull();

    expect(maxBotLinkService.markChatBotRemoved).not.toHaveBeenCalled();
    expect(prisma.managedEntityAccessEdge.updateMany).not.toHaveBeenCalled();
    expect(prisma.chatBotMembership.findMany).not.toHaveBeenCalled();
    expect(nightModeTransitionScheduler.reconcileChat).not.toHaveBeenCalled();
    expect(rosterSyncQueue.getJob).not.toHaveBeenCalled();
    expect(prisma.managedBroadcast.updateMany).not.toHaveBeenCalled();
    expect(prisma.vkParsingSource.updateMany).not.toHaveBeenCalled();
  });

  it('does not report night jobs cleared when the queue is unavailable during cleanup', async () => {
    const staleCheckedAt = new Date(Date.now() - 2 * 24 * 60 * 60 * 1_000).toISOString();
    const prisma = {
      chat: {
        findUnique: jest.fn().mockResolvedValue({
          title: 'Managed chat',
          entityType: ChatEntityType.CHAT,
        }),
      },
      chatBotMembership: {
        findMany: jest.fn().mockResolvedValue([
          {
            botId: 'bot-2',
            status: ChatBotMembershipStatus.ACTIVE,
            permissionsSnapshot: {
              checkedAt: staleCheckedAt,
              isAdmin: true,
              isOwner: false,
              permissions: [],
            },
            botAccessState: ChatBotAccessState.DENIED,
            botAccessExpiresAt: new Date(Date.now() - 60_000),
          },
        ]),
      },
      managedEntityAccessEdge: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findFirst: jest.fn().mockResolvedValue(null),
      },
      managedBroadcast: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      managedBroadcastDelivery: {
        updateMany: jest.fn().mockResolvedValue({ count: 2 }),
      },
      managedBroadcastOccurrence: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      vkParsingPost: {
        updateMany: jest.fn().mockResolvedValue({ count: 3 }),
      },
      vkParsingSource: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    const maxBotLinkService = {
      markChatBotRemoved: jest.fn().mockResolvedValue(null),
      resolveBotId: jest.fn(),
    };
    const chatContextCache = {
      invalidate: jest.fn().mockResolvedValue(undefined),
      clearManagedEntitiesRecentBootstrapForChat: jest.fn().mockResolvedValue(undefined),
    };
    const nightModeTransitionScheduler = {
      reconcileChat: jest.fn().mockResolvedValue({
        queueAvailable: false,
        scheduleEnabled: null,
        passes: 0,
      }),
    };
    const rosterSyncQueue = {
      getJob: jest.fn().mockResolvedValue(null),
    };
    const service = new ManagedEntityAccessLossService(
      prisma as never,
      maxBotLinkService as never,
      chatContextCache as never,
      nightModeTransitionScheduler as never,
      rosterSyncQueue as never,
      createMaxBotRegistry(['bot-1', 'bot-2']) as never,
    );

    await expect(
      service.recordManagedEntityAccessLost({
        chatId: 'chat-1',
        botId: 'bot-1',
        reason: 'bot_denied',
        source: 'unit-test',
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        cleanup: expect.objectContaining({
          nightModeJobsCleared: false,
          canceledBroadcasts: 1,
          canceledBroadcastDeliveries: 2,
          canceledBroadcastOccurrences: 1,
          clearedVkPublishPosts: null,
          pausedVkSources: null,
          removedRosterSyncJobs: 0,
        }),
      }),
    );

    expect(nightModeTransitionScheduler.reconcileChat).toHaveBeenCalledWith('chat-1');
    expect(prisma.managedBroadcast.updateMany).toHaveBeenCalled();
    expect(prisma.vkParsingPost.updateMany).not.toHaveBeenCalled();
    expect(prisma.vkParsingSource.updateMany).not.toHaveBeenCalled();
  });

  it('does not mutate private direct dialogs', async () => {
    const prisma = {
      chat: {
        findUnique: jest.fn(),
      },
    };
    const service = new ManagedEntityAccessLossService(
      prisma as never,
      { markChatBotRemoved: jest.fn(), resolveBotId: jest.fn() } as never,
      {
        invalidate: jest.fn(),
        clearManagedEntitiesRecentBootstrapForChat: jest.fn(),
      } as never,
    );

    await expect(
      service.recordManagedEntityAccessLost({
        chatId: '12345',
        botId: 'bot-1',
        reason: 'bot_denied',
        source: 'unit-test',
      }),
    ).resolves.toBeNull();

    expect(prisma.chat.findUnique).not.toHaveBeenCalled();
  });

  it('does not mark every access edge bot-denied when the lost bot cannot be resolved', async () => {
    const prisma = {
      chat: {
        findUnique: jest.fn().mockResolvedValue({
          title: 'Managed chat',
          entityType: ChatEntityType.CHAT,
        }),
      },
      managedEntityAccessEdge: {
        updateMany: jest.fn().mockResolvedValue({ count: 2 }),
      },
    };
    const maxBotLinkService = {
      markChatBotRemoved: jest.fn(),
      resolveBotId: jest.fn().mockResolvedValue(null),
    };
    const chatContextCache = {
      invalidate: jest.fn().mockResolvedValue(undefined),
      clearManagedEntitiesRecentBootstrapForChat: jest.fn().mockResolvedValue(undefined),
    };
    const service = new ManagedEntityAccessLossService(
      prisma as never,
      maxBotLinkService as never,
      chatContextCache as never,
    );

    await expect(
      service.recordManagedEntityAccessLost({
        chatId: 'chat-1',
        botId: null,
        reason: 'bot_denied',
        source: 'unit-test',
      }),
    ).resolves.toBeNull();

    expect(maxBotLinkService.markChatBotRemoved).not.toHaveBeenCalled();
    expect(prisma.managedEntityAccessEdge.updateMany).not.toHaveBeenCalled();
  });

  it('does not mark the default routed bot lost when terminal access loss has no explicit bot id', async () => {
    const prisma = {
      chat: {
        findUnique: jest.fn().mockResolvedValue({
          title: 'Managed chat',
          entityType: ChatEntityType.CHAT,
        }),
      },
      managedEntityAccessEdge: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    const maxBotLinkService = {
      markChatBotRemoved: jest.fn(),
      resolveBotId: jest.fn().mockResolvedValue('id613002203036_bot'),
    };
    const chatContextCache = {
      invalidate: jest.fn().mockResolvedValue(undefined),
      clearManagedEntitiesRecentBootstrapForChat: jest.fn().mockResolvedValue(undefined),
    };
    const service = new ManagedEntityAccessLossService(
      prisma as never,
      maxBotLinkService as never,
      chatContextCache as never,
    );

    await expect(
      service.recordManagedEntityAccessLost({
        chatId: 'chat-1',
        botId: null,
        reason: 'bot_denied',
        source: 'unit-test',
      }),
    ).resolves.toBeNull();

    expect(maxBotLinkService.resolveBotId).not.toHaveBeenCalled();
    expect(maxBotLinkService.markChatBotRemoved).not.toHaveBeenCalled();
    expect(prisma.managedEntityAccessEdge.updateMany).not.toHaveBeenCalled();
  });
});
