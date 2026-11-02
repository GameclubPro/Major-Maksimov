import { ServiceUnavailableException } from '@nestjs/common';
import { AdminParticipantsRuntime } from './admin-participants-runtime';
import {
  createAdminParticipantsRuntimeContext,
  type AdminParticipantsRuntimeContext,
} from './admin-participants-runtime-context';
import { createDeferred, createPrismaMock } from './admin-service-test-support';

const participantAdmin = {
  userId: 'admin-1',
  username: null,
  displayName: null,
  chatTitle: null,
};

function createParticipantsRuntimeContext(params: {
  prisma: ReturnType<typeof createPrismaMock>;
  maxClient: Record<string, unknown>;
  accessLossService: Record<string, unknown>;
}): AdminParticipantsRuntimeContext {
  return {
    prisma: params.prisma,
    maxClient: params.maxClient,
    logger: { warn: jest.fn(), log: jest.fn() },
    managedEntityAccessLossService: params.accessLossService,
    assertReadOnlyChatAdmin: jest.fn().mockResolvedValue(undefined),
    buildParticipantViolationCountWhere: jest.fn(),
    buildProfileMentionHandoffUrl: jest.fn().mockReturnValue(null),
    buildUserProfileUrl: jest.fn().mockReturnValue(null),
    ensureEntityType: jest.fn().mockResolvedValue(undefined),
    getManagedEntityHeader: jest.fn().mockResolvedValue({
      id: 'chat-1',
      title: 'Команда MAX',
      entityType: 'chat',
      participantsCount: 1200,
    }),
    normalizeMaxProfileUrl: jest.fn().mockReturnValue(null),
    prepareManualModerationTarget: jest.fn(),
    readTrimmedString: jest.fn().mockReturnValue(null),
    resolveBackgroundReadBotAssignment: jest.fn().mockResolvedValue('bot-2'),
    resolveParticipantCleanupBotAssignment: jest.fn().mockResolvedValue('bot-2'),
    isKnownRuntimeBotUserId: jest.fn().mockReturnValue(false),
    resolveLogsDashboardFrom: jest.fn(
      (_range: unknown, to: Date) => new Date(to.getTime() - 1_000),
    ),
    toSafeInteger: jest.fn((value: unknown) => (typeof value === 'number' ? Math.trunc(value) : 0)),
  } as unknown as AdminParticipantsRuntimeContext;
}

describe('AdminParticipantsRuntimeContext', () => {
  it('preserves live dependency identity and method receivers without legacy properties', async () => {
    const target = {
      prefix: 'runtime',
      calls: [] as string[],
      prisma: {} as never,
      maxClient: {} as never,
      logger: {} as never,
      managedEntityAccessLossService: {} as never,
      assertReadOnlyChatAdmin: jest.fn(),
      buildProfileMentionHandoffUrl: jest.fn(),
      ensureEntityType: jest.fn(),
      getManagedEntityHeader: jest.fn(),
      prepareManualModerationTarget: jest.fn(),
      resolveParticipantCleanupBotAssignment: jest.fn(),
      isKnownRuntimeBotUserId: jest.fn().mockReturnValue(false),
      resolveBackgroundReadBotAssignment(chatId: string) {
        return Promise.resolve(`${this.prefix}:${chatId}`);
      },
    };
    const context = createAdminParticipantsRuntimeContext(target);
    new AdminParticipantsRuntime(context);
    expect(context.prisma).toBe(target.prisma);
    const replacement = {} as never;
    target.prisma = replacement;
    expect(context.prisma).toBe(replacement);
    await expect(context.resolveBackgroundReadBotAssignment('chat-1')).resolves.toBe(
      'runtime:chat-1',
    );
  });
});

describe('AdminParticipantsRuntime access-loss probes', () => {
  it('records delayed terminal roster denial at probe start before returning an empty page', async () => {
    const prisma = createPrismaMock();
    prisma.chatSettings.findUnique.mockResolvedValue({
      nightModeTimezone: 'Europe/Moscow',
    });

    const rosterError = Object.assign(new Error('Request failed with status code 403'), {
      response: {
        status: 403,
        data: {
          code: 'chat.denied',
          message: 'access denied',
        },
      },
    });
    const rosterStarted = createDeferred<void>();
    const delayedRoster = createDeferred<never>();
    const maxClient = {
      getChatMembersPage: jest.fn().mockImplementation(() => {
        rosterStarted.resolve();
        return delayedRoster.promise;
      }),
    };
    const accessLossService = {
      recordIfManagedEntityAccessLost: jest.fn().mockResolvedValue(undefined),
    };
    const runtime = new AdminParticipantsRuntime(
      createParticipantsRuntimeContext({ prisma, maxClient, accessLossService }),
    );

    const resultPromise = runtime.getChatParticipantsPage('chat-1', participantAdmin, {
      limit: 10,
      range: '7d',
    });
    await rosterStarted.promise;
    const newerLifecycleAt = new Date(Date.now() + 1_000);
    delayedRoster.reject(rosterError);
    const result = await resultPromise;

    expect(result).toEqual({
      items: [],
      totalCount: 1200,
      hasMore: false,
      nextCursor: null,
    });
    expect(prisma.moderationEvent.groupBy).not.toHaveBeenCalled();
    expect(prisma.chatParticipantModerationImmunity.findMany).not.toHaveBeenCalled();
    expect(accessLossService.recordIfManagedEntityAccessLost).toHaveBeenCalledWith({
      chatId: 'chat-1',
      botId: 'bot-2',
      source: 'admin_participants:roster',
      operation: 'lookup',
      error: rosterError,
      lifecycleEventAt: expect.any(Date),
      lifecycleEventType: 'live_probe_denied',
      lifecycleSource: 'live_probe',
    });
    const lifecycleEventAt = accessLossService.recordIfManagedEntityAccessLost.mock.calls[0][0]
      .lifecycleEventAt as Date;
    expect(lifecycleEventAt.getTime()).toBeLessThan(newerLifecycleAt.getTime());
  });

  it('uses the failing remote page epoch for a multi-page participant search', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-08-20T12:00:00.000Z'));
    try {
      const prisma = createPrismaMock();
      prisma.chatSettings.findUnique.mockResolvedValue({
        nightModeTimezone: 'Europe/Moscow',
      });
      const secondPageStartedAt = new Date('2026-08-20T12:00:05.000Z');
      const rosterError = Object.assign(new Error('Request failed with status code 403'), {
        response: {
          status: 403,
          data: { code: 'chat.denied', message: 'access denied' },
        },
      });
      const maxClient = {
        getChatMembersPage: jest
          .fn()
          .mockImplementationOnce(async () => {
            jest.setSystemTime(secondPageStartedAt);
            return {
              items: [
                {
                  userId: 'user-1',
                  displayName: 'Другой участник',
                  username: null,
                  avatarUrl: null,
                  profileUrl: null,
                  role: 'member',
                  isBot: false,
                },
              ],
              nextMarker: 'page-2',
            };
          })
          .mockRejectedValueOnce(rosterError),
      };
      const accessLossService = {
        recordIfManagedEntityAccessLost: jest.fn().mockResolvedValue(undefined),
      };
      const runtime = new AdminParticipantsRuntime(
        createParticipantsRuntimeContext({ prisma, maxClient, accessLossService }),
      );

      await expect(
        runtime.getChatParticipantsPage('chat-1', participantAdmin, {
          limit: 10,
          range: '7d',
          search: 'needle',
          roleFilter: 'all',
        }),
      ).resolves.toEqual({
        items: [],
        totalCount: 1200,
        hasMore: false,
        nextCursor: null,
      });

      expect(maxClient.getChatMembersPage).toHaveBeenCalledTimes(2);
      expect(accessLossService.recordIfManagedEntityAccessLost).toHaveBeenCalledWith(
        expect.objectContaining({
          error: rosterError,
          lifecycleEventAt: secondPageStartedAt,
        }),
      );
    } finally {
      jest.useRealTimers();
    }
  });

  it('records a delayed terminal cleanup self-probe at probe start before rethrowing', async () => {
    const prisma = createPrismaMock();
    const probeError = Object.assign(new Error('Request failed with status code 404'), {
      response: {
        status: 404,
        data: {
          code: 'chat.not.found',
          message: 'chat not found',
        },
      },
    });
    const probeStarted = createDeferred<void>();
    const delayedProbe = createDeferred<never>();
    const maxClient = {
      getCurrentChatMemberAccess: jest.fn().mockImplementation(() => {
        probeStarted.resolve();
        return delayedProbe.promise;
      }),
      getChatMembersPage: jest.fn(),
    };
    const accessLossService = {
      recordIfManagedEntityAccessLost: jest.fn().mockResolvedValue(undefined),
    };
    const runtime = new AdminParticipantsRuntime(
      createParticipantsRuntimeContext({ prisma, maxClient, accessLossService }),
    );

    const cleanupPromise = runtime.cleanupUnavailableChatParticipants(
      'chat-1',
      participantAdmin,
      {},
    );
    await probeStarted.promise;
    const newerLifecycleAt = new Date(Date.now() + 1_000);
    delayedProbe.reject(probeError);

    await expect(cleanupPromise).rejects.toBe(probeError);
    expect(accessLossService.recordIfManagedEntityAccessLost).toHaveBeenCalledWith({
      chatId: 'chat-1',
      botId: 'bot-2',
      source: 'admin_participants:cleanup_self_probe',
      operation: 'lookup',
      error: probeError,
      lifecycleEventAt: expect.any(Date),
      lifecycleEventType: 'live_probe_denied',
      lifecycleSource: 'live_probe',
    });
    const lifecycleEventAt = accessLossService.recordIfManagedEntityAccessLost.mock.calls[0][0]
      .lifecycleEventAt as Date;
    expect(lifecycleEventAt.getTime()).toBeLessThan(newerLifecycleAt.getTime());
    expect(maxClient.getChatMembersPage).not.toHaveBeenCalled();
  });

  it('does not record participant access loss for a transient cleanup self-probe failure', async () => {
    const prisma = createPrismaMock();
    const throttleError = Object.assign(new Error('Request failed with status code 429'), {
      response: {
        status: 429,
        data: {
          code: 'rate.limit',
          message: 'too many requests',
        },
      },
    });
    const maxClient = {
      getCurrentChatMemberAccess: jest.fn().mockRejectedValue(throttleError),
      getChatMembersPage: jest.fn(),
    };
    const accessLossService = {
      recordIfManagedEntityAccessLost: jest.fn(),
    };
    const runtime = new AdminParticipantsRuntime(
      createParticipantsRuntimeContext({ prisma, maxClient, accessLossService }),
    );

    await expect(
      runtime.cleanupUnavailableChatParticipants('chat-1', participantAdmin, {}),
    ).rejects.toBe(throttleError);

    expect(accessLossService.recordIfManagedEntityAccessLost).not.toHaveBeenCalled();
    expect(maxClient.getChatMembersPage).not.toHaveBeenCalled();
  });
});

describe('AdminParticipantsRuntime transient roster failures', () => {
  it.each([
    [
      'HTTP 502',
      Object.assign(new Error('Request failed with status code 502'), {
        response: { status: 502, data: { code: 'server.failure', message: 'Bad Gateway' } },
      }),
    ],
    [
      'HTTP 429',
      Object.assign(new Error('Request failed with status code 429'), {
        response: { status: 429, data: { code: 'rate.limit', message: 'Too Many Requests' } },
      }),
    ],
    ['timeout', Object.assign(new Error('MAX roster timeout'), { code: 'ECONNABORTED' })],
  ])('maps %s to an actionable 503 without recording access loss', async (_label, rosterError) => {
    const prisma = createPrismaMock();
    prisma.chatSettings.findUnique.mockResolvedValue({ nightModeTimezone: 'Europe/Moscow' });
    const maxClient = { getChatMembersPage: jest.fn().mockRejectedValue(rosterError) };
    const accessLossService = { recordIfManagedEntityAccessLost: jest.fn() };
    const runtime = new AdminParticipantsRuntime(
      createParticipantsRuntimeContext({ prisma, maxClient, accessLossService }),
    );

    const error = await runtime
      .getChatParticipantsPage('chat-1', participantAdmin, { limit: 10, range: '7d' })
      .catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(ServiceUnavailableException);
    expect((error as ServiceUnavailableException).getStatus()).toBe(503);
    expect((error as ServiceUnavailableException).getResponse()).toMatchObject({
      statusCode: 503,
      code: 'MAX_CHAT_PARTICIPANTS_TEMPORARILY_UNAVAILABLE',
      retryable: true,
      retryAfterMs: 5_000,
    });
    expect(accessLossService.recordIfManagedEntityAccessLost).not.toHaveBeenCalled();
  });

  it('coalesces an in-flight failure, negative-caches it briefly, then retries after the TTL', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-09-03T08:00:00.000Z'));
    try {
      const prisma = createPrismaMock();
      prisma.chatSettings.findUnique.mockResolvedValue({ nightModeTimezone: 'Europe/Moscow' });
      const rosterError = Object.assign(new Error('Request failed with status code 502'), {
        response: { status: 502, data: { code: 'server.failure', message: 'Bad Gateway' } },
      });
      const firstAttempt = createDeferred<never>();
      const getChatMembersPage = jest
        .fn()
        .mockImplementationOnce(() => firstAttempt.promise)
        .mockResolvedValueOnce({ items: [], nextMarker: null });
      const context = createParticipantsRuntimeContext({
        prisma,
        maxClient: { getChatMembersPage },
        accessLossService: { recordIfManagedEntityAccessLost: jest.fn() },
      });
      const runtime = new AdminParticipantsRuntime(context);
      const query = { limit: 10, range: '7d' as const };

      const first = runtime.getChatParticipantsPage('chat-1', participantAdmin, query);
      const concurrent = runtime.getChatParticipantsPage('chat-1', participantAdmin, query);
      firstAttempt.reject(rosterError);
      await expect(first).rejects.toBeInstanceOf(ServiceUnavailableException);
      await expect(concurrent).rejects.toBeInstanceOf(ServiceUnavailableException);
      await expect(
        runtime.getChatParticipantsPage('chat-1', participantAdmin, query),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
      expect(getChatMembersPage).toHaveBeenCalledTimes(1);
      expect(runtime['chatParticipantsPageCache'].size).toBe(1);

      jest.advanceTimersByTime(4_999);
      expect(runtime['chatParticipantsPageCache'].size).toBe(1);
      jest.advanceTimersByTime(1);
      expect(runtime['chatParticipantsPageCache'].size).toBe(0);
      await expect(
        runtime.getChatParticipantsPage('chat-1', participantAdmin, query),
      ).resolves.toMatchObject({ items: [], hasMore: false, nextCursor: null });
      expect(getChatMembersPage).toHaveBeenCalledTimes(2);
    } finally {
      jest.useRealTimers();
    }
  });

  it('does not leak a transient negative cache entry between actor cache keys', async () => {
    const prisma = createPrismaMock();
    prisma.chatSettings.findUnique.mockResolvedValue({ nightModeTimezone: 'Europe/Moscow' });
    const rosterError = Object.assign(new Error('Request failed with status code 502'), {
      response: { status: 502, data: { code: 'server.failure', message: 'Bad Gateway' } },
    });
    const getChatMembersPage = jest
      .fn()
      .mockRejectedValueOnce(rosterError)
      .mockResolvedValueOnce({ items: [], nextMarker: null });
    const runtime = new AdminParticipantsRuntime(
      createParticipantsRuntimeContext({
        prisma,
        maxClient: { getChatMembersPage },
        accessLossService: { recordIfManagedEntityAccessLost: jest.fn() },
      }),
    );

    await expect(
      runtime.getChatParticipantsPage('chat-1', participantAdmin, { limit: 10, range: '7d' }),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    await expect(
      runtime.getChatParticipantsPage(
        'chat-1',
        { ...participantAdmin, userId: 'admin-2' },
        { limit: 10, range: '7d' },
      ),
    ).resolves.toMatchObject({ items: [] });
    expect(getChatMembersPage).toHaveBeenCalledTimes(2);
  });

  it('maps an upstream 5xx during search to the same structured 503', async () => {
    const prisma = createPrismaMock();
    prisma.chatSettings.findUnique.mockResolvedValue({ nightModeTimezone: 'Europe/Moscow' });
    const rosterError = Object.assign(new Error('Request failed with status code 502'), {
      response: { status: 502, data: { code: 'server.failure', message: 'Bad Gateway' } },
    });
    const maxClient = { getChatMembersPage: jest.fn().mockRejectedValue(rosterError) };
    const accessLossService = { recordIfManagedEntityAccessLost: jest.fn() };
    const runtime = new AdminParticipantsRuntime(
      createParticipantsRuntimeContext({ prisma, maxClient, accessLossService }),
    );

    const error = await runtime
      .getChatParticipantsPage('chat-1', participantAdmin, {
        limit: 10,
        range: '7d',
        search: 'needle',
      })
      .catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(ServiceUnavailableException);
    expect((error as ServiceUnavailableException).getResponse()).toMatchObject({
      statusCode: 503,
      code: 'MAX_CHAT_PARTICIPANTS_TEMPORARILY_UNAVAILABLE',
      retryAfterMs: 5_000,
    });
    expect(maxClient.getChatMembersPage).toHaveBeenCalledTimes(1);
    expect(accessLossService.recordIfManagedEntityAccessLost).not.toHaveBeenCalled();
  });

  it('does not let an old transient eviction timer delete a replacement cache promise', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-09-03T08:00:00.000Z'));
    try {
      const prisma = createPrismaMock();
      prisma.chatSettings.findUnique.mockResolvedValue({ nightModeTimezone: 'Europe/Moscow' });
      const rosterError = Object.assign(new Error('Request failed with status code 502'), {
        response: { status: 502, data: { code: 'server.failure', message: 'Bad Gateway' } },
      });
      const context = createParticipantsRuntimeContext({
        prisma,
        maxClient: { getChatMembersPage: jest.fn().mockRejectedValue(rosterError) },
        accessLossService: { recordIfManagedEntityAccessLost: jest.fn() },
      });
      const runtime = new AdminParticipantsRuntime(context);

      await expect(
        runtime.getChatParticipantsPage('chat-1', participantAdmin, { limit: 10, range: '7d' }),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
      const cacheKey = [...runtime['chatParticipantsPageCache'].keys()][0];
      expect(cacheKey).toEqual(expect.any(String));
      const replacementPromise = Promise.resolve({
        items: [],
        totalCount: 0,
        hasMore: false,
        nextCursor: null,
      });
      runtime['chatParticipantsPageCache'].set(cacheKey!, {
        expiresAtMs: Date.now() + 30_000,
        promise: replacementPromise,
      });

      jest.advanceTimersByTime(5_000);

      expect(runtime['chatParticipantsPageCache'].get(cacheKey!)?.promise).toBe(replacementPromise);
    } finally {
      jest.useRealTimers();
    }
  });

  it('does not negative-cache non-transient roster errors', async () => {
    const prisma = createPrismaMock();
    prisma.chatSettings.findUnique.mockResolvedValue({ nightModeTimezone: 'Europe/Moscow' });
    const rosterError = Object.assign(new Error('Request failed with status code 422'), {
      response: { status: 422, data: { code: 'invalid.request', message: 'Invalid request' } },
    });
    const getChatMembersPage = jest.fn().mockRejectedValue(rosterError);
    const runtime = new AdminParticipantsRuntime(
      createParticipantsRuntimeContext({
        prisma,
        maxClient: { getChatMembersPage },
        accessLossService: { recordIfManagedEntityAccessLost: jest.fn() },
      }),
    );
    const query = { limit: 10, range: '7d' as const };

    await expect(runtime.getChatParticipantsPage('chat-1', participantAdmin, query)).rejects.toBe(
      rosterError,
    );
    await expect(runtime.getChatParticipantsPage('chat-1', participantAdmin, query)).rejects.toBe(
      rosterError,
    );
    expect(getChatMembersPage).toHaveBeenCalledTimes(2);
  });
});
