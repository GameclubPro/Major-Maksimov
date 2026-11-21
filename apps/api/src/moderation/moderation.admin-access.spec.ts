import { ModerationAccessService } from './moderation-access.service';
import { ModerationService } from './moderation.service';

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

function readSqlText(value: unknown): string {
  const sql = value as { strings?: readonly string[] };
  return sql.strings?.join('?').replace(/\s+/g, ' ').trim() ?? '';
}

async function waitForMockCall(mock: jest.Mock): Promise<void> {
  for (let attempt = 0; attempt < 20 && mock.mock.calls.length === 0; attempt += 1) {
    await Promise.resolve();
  }
}

describe('ModerationService chat admin access lookups', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('rejects a delayed remote grant superseded by user removal', async () => {
    const remoteLookup = createDeferred<Map<string, unknown>>();
    const allowlistUpsert = jest.fn().mockResolvedValue(undefined);
    const queryRaw = jest.fn().mockImplementation(async (query: unknown) => {
      const sql = readSqlText(query);
      if (sql.includes('FROM "chats" AS chat')) {
        return [{ id: 'chat-1' }];
      }
      if (sql.includes('FROM "chat_membership_activity_events" AS activity')) {
        return [{ userId: 'user-1' }];
      }
      return [];
    });
    const transaction = jest.fn().mockImplementation(async (operation: (tx: unknown) => unknown) =>
      operation({
        $queryRaw: queryRaw,
        chatAdminAllowlist: { upsert: allowlistUpsert },
      }),
    );
    const maxClient = {
      getChatMembersAccess: jest.fn().mockReturnValue(remoteLookup.promise),
    };
    const chatContextCache = {
      getAdminAccessBatch: jest.fn().mockResolvedValue(new Map()),
      applyAdminAccessEpochMutation: jest.fn().mockResolvedValue(true),
      invalidate: jest.fn().mockResolvedValue(undefined),
    };
    const service = new ModerationAccessService(
      { $transaction: transaction } as never,
      maxClient as never,
      chatContextCache as never,
    );

    const pending = service.getRemoteChatAdminAccess('chat-1', 'user-1');
    await waitForMockCall(maxClient.getChatMembersAccess);
    remoteLookup.resolve(
      new Map([
        [
          'user-1',
          {
            userId: 'user-1',
            isAdmin: true,
            isOwner: false,
            permissions: [],
          },
        ],
      ]),
    );

    await expect(pending).resolves.toBeNull();
    expect(queryRaw).toHaveBeenCalledTimes(2);
    expect(readSqlText(queryRaw.mock.calls[0]?.[0])).toContain('FOR UPDATE OF chat');
    expect(readSqlText(queryRaw.mock.calls[1]?.[0])).toContain(
      `activity."event_type" IN ('user_added', 'user_removed')`,
    );
    expect(readSqlText(queryRaw.mock.calls[1]?.[0])).toContain('activity."event_at" >= ?');
    expect(allowlistUpsert).not.toHaveBeenCalled();
    expect(chatContextCache.applyAdminAccessEpochMutation).not.toHaveBeenCalled();
    expect(chatContextCache.invalidate).not.toHaveBeenCalled();
  });

  it('does not leave durable access when a newer negative probe beats an older grant', async () => {
    jest.useFakeTimers({ now: new Date('2026-08-20T09:00:00.000Z') });
    const oldGrantLookup = createDeferred<Map<string, unknown>>();
    const allowlistUpsert = jest.fn().mockResolvedValue(undefined);
    const queryRaw = jest
      .fn()
      .mockImplementation(async (query: unknown) =>
        readSqlText(query).includes('FROM "chats" AS chat') ? [{ id: 'chat-1' }] : [],
      );
    const transaction = jest.fn().mockImplementation(async (operation: (tx: unknown) => unknown) =>
      operation({
        $queryRaw: queryRaw,
        chatAdminAllowlist: { upsert: allowlistUpsert },
      }),
    );
    const sharedStates = new Map<string, 'granted' | 'user_denied'>();
    const sharedEpochs = new Map<string, { eventAtMs: number; priority: number }>();
    const chatContextCache = {
      getAdminAccessBatch: jest
        .fn()
        .mockImplementation(
          async (_chatId: string, userIds: readonly string[]) =>
            new Map(userIds.map((userId) => [userId, sharedStates.get(userId) ?? null] as const)),
        ),
      applyAdminAccessEpochMutation: jest
        .fn()
        .mockImplementation(
          async (params: { userId: string; state: 'granted' | 'user_denied'; eventAt: Date }) => {
            const eventAtMs = params.eventAt.getTime();
            const priority = params.state === 'granted' ? 0 : 1;
            const current = sharedEpochs.get(params.userId);
            if (
              current &&
              (current.eventAtMs > eventAtMs ||
                (current.eventAtMs === eventAtMs && current.priority > priority))
            ) {
              return false;
            }
            sharedEpochs.set(params.userId, { eventAtMs, priority });
            sharedStates.set(params.userId, params.state);
            return true;
          },
        ),
      invalidate: jest.fn().mockResolvedValue(undefined),
    };
    const oldGrantClient = {
      getChatMembersAccess: jest.fn().mockReturnValue(oldGrantLookup.promise),
    };
    const oldGrantService = new ModerationAccessService(
      { $transaction: transaction } as never,
      oldGrantClient as never,
      chatContextCache as never,
    );
    const newerDenyService = new ModerationAccessService(
      { $transaction: transaction } as never,
      { getChatMembersAccess: jest.fn().mockResolvedValue(new Map()) } as never,
      chatContextCache as never,
    );

    const oldGrant = oldGrantService.getRemoteChatAdminAccess('chat-1', 'user-1');
    await waitForMockCall(oldGrantClient.getChatMembersAccess);
    jest.setSystemTime(new Date('2026-08-20T09:00:01.000Z'));
    const newerDeny = newerDenyService.getRemoteChatAdminAccess('chat-1', 'user-1');
    await jest.advanceTimersByTimeAsync(0);
    await expect(newerDeny).resolves.toBe('user_denied');

    oldGrantLookup.resolve(
      new Map([
        [
          'user-1',
          {
            userId: 'user-1',
            isAdmin: true,
            isOwner: false,
            permissions: [],
          },
        ],
      ]),
    );
    await jest.advanceTimersByTimeAsync(0);

    await expect(oldGrant).resolves.toBeNull();
    expect(allowlistUpsert).not.toHaveBeenCalled();
    expect(sharedStates.get('user-1')).toBe('user_denied');
    expect(chatContextCache.invalidate).not.toHaveBeenCalled();
  });

  it('publishes accepted negative lookups through the probe epoch fence', async () => {
    jest.useFakeTimers({ now: new Date('2026-08-20T09:00:00.000Z') });
    const probeStartedAt = new Date();
    const allowlistUpsert = jest.fn().mockResolvedValue(undefined);
    const queryRaw = jest
      .fn()
      .mockImplementation(async (query: unknown) =>
        readSqlText(query).includes('FROM "chats" AS chat') ? [{ id: 'chat-1' }] : [],
      );
    const transaction = jest.fn().mockImplementation(async (operation: (tx: unknown) => unknown) =>
      operation({
        $queryRaw: queryRaw,
        chatAdminAllowlist: { upsert: allowlistUpsert },
      }),
    );
    const chatContextCache = {
      getAdminAccessBatch: jest.fn().mockResolvedValue(new Map()),
      applyAdminAccessEpochMutation: jest.fn().mockResolvedValue(true),
      invalidate: jest.fn().mockResolvedValue(undefined),
    };
    const service = new ModerationAccessService(
      { $transaction: transaction } as never,
      {
        getChatMembersAccess: jest.fn().mockResolvedValue(new Map()),
      } as never,
      chatContextCache as never,
    );

    const pending = service.getRemoteChatAdminAccess('chat-1', 'user-1');
    await jest.advanceTimersByTimeAsync(0);

    await expect(pending).resolves.toBe('user_denied');
    expect(allowlistUpsert).not.toHaveBeenCalled();
    expect(chatContextCache.applyAdminAccessEpochMutation).toHaveBeenCalledTimes(2);
    expect(chatContextCache.applyAdminAccessEpochMutation).toHaveBeenCalledWith({
      chatId: 'chat-1',
      userId: 'user-1',
      state: 'user_denied',
      eventAt: probeStartedAt,
    });
    expect(chatContextCache.applyAdminAccessEpochMutation).toHaveBeenCalledWith({
      chatId: 'chat-1',
      userId: 'iduser-1',
      state: 'user_denied',
      eventAt: probeStartedAt,
    });
  });

  it('keeps a crash-partial grant protective without compensating it to a denial', async () => {
    const sharedStates = new Map<string, 'granted' | 'user_denied'>();
    const queryRaw = jest
      .fn()
      .mockImplementation(async (query: unknown) =>
        readSqlText(query).includes('FROM "chats" AS chat') ? [{ id: 'chat-1' }] : [],
      );
    const applyAdminAccessEpochMutation = jest
      .fn()
      .mockImplementation(async (params: { userId: string; state: 'granted' | 'user_denied' }) => {
        if (params.userId === 'iduser-1') {
          throw new Error('Redis write failed after the first alias');
        }
        sharedStates.set(params.userId, params.state);
        return true;
      });
    const maxClient = {
      getChatMembersAccess: jest.fn().mockResolvedValue(
        new Map([
          [
            'user-1',
            {
              userId: 'user-1',
              isAdmin: true,
              isOwner: false,
              permissions: [],
            },
          ],
        ]),
      ),
    };
    const chatContextCache = {
      getAdminAccessBatch: jest
        .fn()
        .mockImplementation(
          async (_chatId: string, userIds: readonly string[]) =>
            new Map(userIds.map((userId) => [userId, sharedStates.get(userId) ?? null] as const)),
        ),
      applyAdminAccessEpochMutation,
    };
    const service = new ModerationAccessService(
      {
        $transaction: jest
          .fn()
          .mockImplementation(async (operation: (tx: unknown) => unknown) =>
            operation({ $queryRaw: queryRaw }),
          ),
      } as never,
      maxClient as never,
      chatContextCache as never,
    );

    await expect(service.getRemoteChatAdminAccess('chat-1', 'user-1')).resolves.toBeNull();
    expect(applyAdminAccessEpochMutation).toHaveBeenCalledTimes(2);
    expect(applyAdminAccessEpochMutation).not.toHaveBeenCalledWith(
      expect.objectContaining({ state: 'user_denied' }),
    );
    expect(sharedStates).toEqual(new Map([['user-1', 'granted']]));
    await expect(
      service.getRemoteChatAdminAccess('chat-1', 'user-1', { allowLookup: false }),
    ).resolves.toBe('granted');
    expect(maxClient.getChatMembersAccess).toHaveBeenCalledTimes(1);
  });

  it('keeps a crash-partial denial unresolved and skips destructive bot moderation', async () => {
    const sharedStates = new Map<string, 'granted' | 'user_denied'>();
    const queryRaw = jest
      .fn()
      .mockImplementation(async (query: unknown) =>
        readSqlText(query).includes('FROM "chats" AS chat') ? [{ id: 'chat-1' }] : [],
      );
    const applyAdminAccessEpochMutation = jest
      .fn()
      .mockImplementation(async (params: { userId: string; state: 'granted' | 'user_denied' }) => {
        if (params.userId === 'iduser-1') {
          return false;
        }
        sharedStates.set(params.userId, params.state);
        return true;
      });
    const maxClient = {
      getChatMembersAccess: jest.fn().mockResolvedValue(new Map()),
    };
    const chatContextCache = {
      getAdminAccessBatch: jest
        .fn()
        .mockImplementation(
          async (_chatId: string, userIds: readonly string[]) =>
            new Map(userIds.map((userId) => [userId, sharedStates.get(userId) ?? null] as const)),
        ),
      applyAdminAccessEpochMutation,
    };
    const service = new ModerationAccessService(
      {
        $transaction: jest
          .fn()
          .mockImplementation(async (operation: (tx: unknown) => unknown) =>
            operation({ $queryRaw: queryRaw }),
          ),
      } as never,
      maxClient as never,
      chatContextCache as never,
    );

    await expect(service.getRemoteChatAdminAccess('chat-1', 'user-1')).resolves.toBeNull();
    expect(sharedStates).toEqual(new Map([['user-1', 'user_denied']]));
    await expect(
      service.getRemoteChatAdminAccess('chat-1', 'user-1', { allowLookup: false }),
    ).resolves.toBeNull();
    await expect(
      service.isOtherBotAdminModerationBypass({
        chatId: 'chat-1',
        localAdminUserIds: [],
        senderId: 'user-1',
        degradeMode: true,
        hotChatBackoffActive: false,
      }),
    ).resolves.toBe(true);
    expect(maxClient.getChatMembersAccess).toHaveBeenCalledTimes(1);
  });

  it('keeps an unfenced remote grant unresolved instead of recording a denial', async () => {
    const setAdminAccess = jest.fn().mockResolvedValue(undefined);
    const queryRaw = jest
      .fn()
      .mockImplementation(async (query: unknown) =>
        readSqlText(query).includes('FROM "chats" AS chat') ? [{ id: 'chat-1' }] : [],
      );
    const service = new ModerationAccessService(
      {
        $transaction: jest.fn().mockImplementation(async (operation: (tx: unknown) => unknown) =>
          operation({
            $queryRaw: queryRaw,
          }),
        ),
      } as never,
      {
        getChatMembersAccess: jest.fn().mockResolvedValue(
          new Map([
            [
              'user-1',
              {
                userId: 'user-1',
                isAdmin: true,
                isOwner: false,
                permissions: [],
              },
            ],
          ]),
        ),
      } as never,
      {
        getAdminAccessBatch: jest.fn().mockResolvedValue(new Map()),
        setAdminAccess,
      } as never,
    );

    await expect(service.getRemoteChatAdminAccess('chat-1', 'user-1')).resolves.toBeNull();
    expect(setAdminAccess).not.toHaveBeenCalled();
  });

  it('skips destructive bot moderation when remote admin evidence cannot be fenced', async () => {
    const service = new ModerationAccessService(
      {} as never,
      {
        getChatMembersAccess: jest.fn().mockResolvedValue(
          new Map([
            [
              'bot-1',
              {
                userId: 'bot-1',
                isAdmin: true,
                isOwner: false,
                permissions: [],
              },
            ],
          ]),
        ),
      } as never,
    );

    await expect(
      service.isOtherBotAdminModerationBypass({
        chatId: 'chat-1',
        localAdminUserIds: [],
        senderId: 'bot-1',
        degradeMode: false,
        hotChatBackoffActive: false,
      }),
    ).resolves.toBe(true);
  });

  it('rechecks shared state before using a process-local granted result', async () => {
    let sharedState: 'granted' | 'user_denied' | null = null;
    const getAdminAccessBatch = jest
      .fn()
      .mockImplementation(
        async (_chatId: string, userIds: readonly string[]) =>
          new Map(userIds.map((userId) => [userId, sharedState] as const)),
      );
    const queryRaw = jest
      .fn()
      .mockImplementation(async (query: unknown) =>
        readSqlText(query).includes('FROM "chats" AS chat') ? [{ id: 'chat-1' }] : [],
      );
    const transaction = jest.fn().mockImplementation(async (operation: (tx: unknown) => unknown) =>
      operation({
        $queryRaw: queryRaw,
        chatAdminAllowlist: { upsert: jest.fn().mockResolvedValue(undefined) },
      }),
    );
    const maxClient = {
      getChatMembersAccess: jest.fn().mockResolvedValue(
        new Map([
          [
            'user-1',
            {
              userId: 'user-1',
              isAdmin: true,
              isOwner: false,
              permissions: [],
            },
          ],
        ]),
      ),
    };
    const chatContextCache = {
      getAdminAccessBatch,
      applyAdminAccessEpochMutation: jest.fn().mockResolvedValue(true),
      invalidate: jest.fn().mockResolvedValue(undefined),
    };
    const service = new ModerationAccessService(
      { $transaction: transaction } as never,
      maxClient as never,
      chatContextCache as never,
    );

    await expect(service.getRemoteChatAdminAccess('chat-1', 'user-1')).resolves.toBe('granted');
    sharedState = 'user_denied';
    await expect(
      service.getRemoteChatAdminAccess('chat-1', 'user-1', { allowLookup: false }),
    ).resolves.toBe('user_denied');

    expect(getAdminAccessBatch).toHaveBeenCalledTimes(2);
    expect(maxClient.getChatMembersAccess).toHaveBeenCalledTimes(1);
  });

  it('passes a bounded timeout to remote admin access reads', async () => {
    const maxClient = {
      getChatMembersAccess: jest.fn().mockResolvedValue(new Map()),
    };
    const configService = {
      get: jest.fn((key: string) => {
        if (key === 'CHAT_ADMIN_LOOKUP_TIMEOUT_MS') {
          return 1500;
        }
        return undefined;
      }),
    };

    const service = new ModerationService(
      {} as never,
      {} as never,
      {} as never,
      maxClient as never,
      undefined,
      undefined,
      configService as never,
    );

    await (
      service as unknown as {
        loadRemoteChatAdminAccessBatch: (
          chatId: string,
          userIds: readonly string[],
        ) => Promise<Map<string, 'granted' | 'user_denied'>>;
      }
    ).loadRemoteChatAdminAccessBatch('-100123', ['user-1']);

    expect(maxClient.getChatMembersAccess).toHaveBeenCalledWith(
      '-100123',
      ['user-1'],
      expect.objectContaining({
        trafficClass: 'interactive',
        actionHealthLane: 'background',
        timeoutMs: 1500,
        ignoreFailureMetricStatuses: [403, 404],
      }),
    );
  });

  it('fails open instead of hanging when a remote chat admin lookup never resolves', async () => {
    const maxClient = {
      getChatMembersAccess: jest.fn().mockImplementation(() => new Promise(() => undefined)),
      getCurrentChatMemberAccess: jest.fn(),
    };
    const configService = {
      get: jest.fn((key: string) => {
        if (key === 'CHAT_ADMIN_LOOKUP_TIMEOUT_MS') {
          return 50;
        }
        return undefined;
      }),
    };

    const service = new ModerationService(
      {} as never,
      {} as never,
      {} as never,
      maxClient as never,
      undefined,
      undefined,
      configService as never,
    );

    const setTimeoutSpy = jest.spyOn(global, 'setTimeout').mockImplementation(((
      callback: TimerHandler,
    ) => {
      const timer = { unref: jest.fn() } as unknown as NodeJS.Timeout;
      queueMicrotask(() => {
        if (typeof callback === 'function') {
          callback();
        }
      });
      return timer;
    }) as unknown as typeof setTimeout);
    const clearTimeoutSpy = jest
      .spyOn(global, 'clearTimeout')
      .mockImplementation((() => undefined) as unknown as typeof clearTimeout);

    try {
      const lookup = (
        service as unknown as {
          executeRemoteChatAdminLookupWithGuard: <T>(
            operation: () => Promise<T>,
            context: {
              chatId: string;
              userIds: readonly string[];
              botId?: string | null;
            },
          ) => Promise<T>;
        }
      ).executeRemoteChatAdminLookupWithGuard(
        () => maxClient.getChatMembersAccess('-100123', ['user-1'], {}),
        {
          chatId: '-100123',
          userIds: ['user-1'],
        },
      );

      await expect(lookup).rejects.toMatchObject({ code: 'ECONNABORTED' });
      expect(maxClient.getChatMembersAccess).toHaveBeenCalledTimes(1);
      expect(setTimeoutSpy).toHaveBeenCalledTimes(1);
      expect(clearTimeoutSpy).toHaveBeenCalledTimes(1);
    } finally {
      setTimeoutSpy.mockRestore();
      clearTimeoutSpy.mockRestore();
    }
  });

  it('does not block ordinary moderation on synchronous remote admin reads when local admins are already known', async () => {
    jest.useFakeTimers();
    let loggerWarnSpy: jest.SpyInstance | undefined;
    try {
      const ruleEngine = {
        detect: jest.fn().mockResolvedValue({ violations: [] }),
      };
      const maxClient = {
        getChatMembersAccess: jest.fn().mockImplementation(() => new Promise(() => undefined)),
        deleteMessage: jest.fn(),
        sendMessage: jest.fn(),
        kickMember: jest.fn(),
        banMember: jest.fn(),
        notifyModerators: jest.fn(),
      };
      const chatContextCache = {
        getChatContext: jest.fn().mockResolvedValue({
          chatId: 'chat-1',
          title: 'Chat 1',
          settings: {
            antiDuplicateEnabled: true,
            duplicateWarnEnabled: true,
            duplicateMuteEnabled: true,
            duplicateBanEnabled: true,
            duplicateWarnWindowSec: 43200,
            duplicateWarnMaxCount: 2,
            duplicateMuteWindowSec: 86400,
            duplicateMuteMaxCount: 3,
            duplicateBanWindowSec: 172800,
            duplicateBanMaxCount: 4,
            linkPolicy: 'ALLOWLIST_ONLY',
            botSpeechStyle: 'FRIENDLY',
            greetingEnabled: false,
            greetingBotMessageEnabled: false,
            greetingDeleteBotMessageEnabled: false,
            greetingDeleteBotMessageDelayMinutes: 2,
            greetingBotMessageText: '',
            greetingBotButtonEnabled: false,
            greetingBotButtonUrl: '',
            greetingBotButtonText: 'Открыть',
            greetingRulesButtonEnabled: false,
            requiredSubscriptionEnabled: false,
            requiredSubscriptionChannelIds: [],
            requiredSubscriptionBotMessageEnabled: true,
            requiredSubscriptionBotMessageText: '',
            requiredSubscriptionWarnEnabled: false,
            requiredSubscriptionWarnMessageText: '',
            requiredSubscriptionBanEnabled: false,
            requiredSubscriptionMuteEnabled: false,
            requiredSubscriptionMuteDurationHours: 6,
            invitationAccessEnabled: false,
            invitationAccessRequiredCount: 1,
            invitationAccessBotMessageEnabled: true,
            invitationAccessBotMessageText: '',
            invitationAccessWarnEnabled: false,
            invitationAccessWarnMessageText: '',
            invitationAccessBanEnabled: false,
            invitationAccessMuteEnabled: false,
            invitationAccessMuteDurationHours: 6,
            commentsEnabled: false,
            commentsAdminsEnabled: true,
            commentsAllEnabled: false,
            commentsChatBroadcastsEnabled: false,
            deleteBotMessagesEnabled: true,
            deleteBotMessagesDelayMinutes: 2,
            removeBotsFromGroupEnabled: true,
            deleteSpammersEnabled: false,
            profanityEnabled: false,
            profanityLevel: 'MEDIUM',
            profanityWarnEnabled: false,
            profanityMuteEnabled: false,
            profanityBanEnabled: false,
            linksEnabled: false,
            linksWarnEnabled: false,
            linksMuteEnabled: false,
            linksBanEnabled: false,
            commercialAdsEnabled: false,
            commercialAdsWarnEnabled: false,
            commercialAdsMuteEnabled: false,
            commercialAdsBanEnabled: false,
            commercialAdsSensitivity: 'BALANCED',
            thematicFiltersEnabled: false,
            thematicFiltersKeywords: [],
            thematicFiltersWarnEnabled: false,
            thematicFiltersMuteEnabled: false,
            thematicFiltersBanEnabled: false,
            messageLimitsEnabled: false,
            messageLimitsMaxCount: 5,
            messageLimitsWindowSec: 10,
            messageLimitsWarnEnabled: false,
            messageLimitsMuteEnabled: false,
            messageLimitsBanEnabled: false,
            duplicateBotMessageEnabled: false,
            duplicateBotMessageText: '',
            textFiltersWarnEnabled: false,
            textFiltersWarnMessageText: '',
            thematicFiltersWarnMessageText: '',
            linkWarnMessageText: '',
            messageLimitsWarnMessageText: '',
            muteDurationHours: 6,
            rulesAttachViolationsEnabled: false,
            nightModeEnabled: false,
            nightModeStartTimeMinutes: 0,
            nightModeEndTimeMinutes: 0,
            nightModeTimezone: 'UTC',
            nightModeBotMessageEnabled: false,
            nightModeBotMessageText: '',
            nightModeCommentsEnabled: false,
            nightModeBotButtonEnabled: false,
            nightModeBotButtonUrl: '',
            nightModeBotButtonText: '',
            nightModeRulesButtonEnabled: false,
            nightModeForceCloseEnabled: false,
            nightModeForceCloseForever: false,
            nightModeForceCloseUntil: null,
          },
          domainAllowlist: [],
          adminUserIds: ['admin-1'],
          rulesPublishedUrl: null,
          rulesPublishedMessageId: null,
        }),
        getAdminAccess: jest.fn().mockResolvedValue(null),
        applyAdminAccessEpochMutation: jest.fn().mockResolvedValue(true),
        invalidate: jest.fn().mockResolvedValue(undefined),
      };
      const configService = {
        get: jest.fn((key: string) => {
          if (key === 'CHAT_ADMIN_LOOKUP_TIMEOUT_MS') {
            return 250;
          }
          if (key === 'CHAT_ADMIN_SYNC_REMOTE_LOOKUP_WHEN_LOCAL_ADMINS_KNOWN') {
            return false;
          }
          return undefined;
        }),
      };

      const service = new ModerationService(
        {
          violation: { create: jest.fn() },
          moderationEvent: { findFirst: jest.fn().mockResolvedValue(null), create: jest.fn() },
          webhookEvent: { findUnique: jest.fn(), update: jest.fn() },
        } as never,
        ruleEngine as never,
        { resolveAction: jest.fn() } as never,
        maxClient as never,
        chatContextCache as never,
        undefined,
        configService as never,
      );
      loggerWarnSpy = jest
        .spyOn(
          (service as unknown as { logger: { warn: (...args: unknown[]) => void } }).logger,
          'warn',
        )
        .mockImplementation(() => undefined);

      await expect(
        service.handleUpdate({
          updateId: 'u-1',
          type: 'message_created',
          message: {
            messageId: 'm-1',
            chatId: 'chat-1',
            senderId: 'user-1',
            senderName: 'User 1',
            text: 'обычное сообщение',
            createdAt: '2026-03-31T12:00:00.000Z',
          },
          raw: {},
        } as never),
      ).resolves.toBeUndefined();

      expect(ruleEngine.detect).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(1_000);
      await Promise.resolve();
    } finally {
      loggerWarnSpy?.mockRestore();
      jest.useRealTimers();
    }
  });

  it('batches shared-cache admin reads within the same chat before remote lookup', async () => {
    const maxClient = {
      getChatMembersAccess: jest.fn(),
      getCurrentChatMemberAccess: jest.fn(),
    };
    const chatContextCache = {
      getAdminAccess: jest.fn(),
      getAdminAccessBatch: jest.fn().mockResolvedValue(
        new Map([
          ['user-1', 'granted'],
          ['iduser-1', null],
          ['user-2', 'user_denied'],
          ['iduser-2', 'user_denied'],
        ]),
      ),
      applyAdminAccessEpochMutation: jest.fn().mockResolvedValue(true),
      invalidate: jest.fn().mockResolvedValue(undefined),
    };
    const service = new ModerationService(
      {} as never,
      {} as never,
      {} as never,
      maxClient as never,
      chatContextCache as never,
    );

    const [first, second] = await Promise.all([
      (
        service as unknown as {
          getRemoteChatAdminAccess: (
            chatId: string,
            userId: string,
            options?: {
              allowLookup?: boolean;
            },
          ) => Promise<'granted' | 'user_denied' | null>;
        }
      ).getRemoteChatAdminAccess('chat-1', 'user-1', {
        allowLookup: false,
      }),
      (
        service as unknown as {
          getRemoteChatAdminAccess: (
            chatId: string,
            userId: string,
            options?: {
              allowLookup?: boolean;
            },
          ) => Promise<'granted' | 'user_denied' | null>;
        }
      ).getRemoteChatAdminAccess('chat-1', 'user-2', {
        allowLookup: false,
      }),
    ]);

    expect(first).toBe('granted');
    expect(second).toBe('user_denied');
    expect(chatContextCache.getAdminAccessBatch).toHaveBeenCalledTimes(1);
    expect(chatContextCache.getAdminAccessBatch).toHaveBeenCalledWith(
      'chat-1',
      expect.arrayContaining(['user-1', 'iduser-1', 'user-2', 'iduser-2']),
    );
    expect(chatContextCache.getAdminAccess).not.toHaveBeenCalled();
    expect(maxClient.getChatMembersAccess).not.toHaveBeenCalled();
  });

  it('treats conflicting alias epochs as unresolved and skips destructive bot moderation', async () => {
    const maxClient = {
      getChatMembersAccess: jest.fn(),
    };
    const chatContextCache = {
      getAdminAccessBatch: jest.fn().mockResolvedValue(
        new Map([
          ['bot-1', 'granted'],
          ['idbot-1', 'user_denied'],
        ]),
      ),
      applyAdminAccessEpochMutation: jest.fn().mockResolvedValue(true),
    };
    const service = new ModerationAccessService(
      {} as never,
      maxClient as never,
      chatContextCache as never,
    );

    await expect(
      service.getRemoteChatAdminAccess('chat-1', 'bot-1', { allowLookup: false }),
    ).resolves.toBeNull();
    await expect(
      service.isOtherBotAdminModerationBypass({
        chatId: 'chat-1',
        localAdminUserIds: [],
        senderId: 'bot-1',
        degradeMode: true,
        hotChatBackoffActive: false,
      }),
    ).resolves.toBe(true);
    expect(maxClient.getChatMembersAccess).not.toHaveBeenCalled();
  });

  it('backs off remote admin lookups after denied MAX responses', async () => {
    const deniedError = Object.assign(new Error('Request failed with status code 403'), {
      response: {
        status: 403,
        data: {
          message: 'Request failed with status code 403',
        },
      },
    });
    const maxClient = {
      getChatMembersAccess: jest.fn().mockRejectedValue(deniedError),
      getCurrentChatMemberAccess: jest.fn(),
    };
    const service = new ModerationService(
      {} as never,
      {} as never,
      {} as never,
      maxClient as never,
    );
    const accessService = service as unknown as {
      getRemoteChatAdminAccess: (
        chatId: string,
        userId: string,
      ) => Promise<'granted' | 'user_denied' | null>;
    };

    await expect(accessService.getRemoteChatAdminAccess('chat-denied', 'user-1')).resolves.toBe(
      null,
    );
    await expect(accessService.getRemoteChatAdminAccess('chat-denied', 'user-1')).resolves.toBe(
      null,
    );

    expect(maxClient.getChatMembersAccess).toHaveBeenCalledTimes(1);
  });

  it('backs off repeated same-chat admin lookups after an upstream MAX 5xx', async () => {
    const upstreamError = Object.assign(new Error('Request failed with status code 502'), {
      response: {
        status: 502,
        data: {
          message: 'Request failed with status code 502',
        },
      },
    });
    const maxClient = {
      getChatMembersAccess: jest.fn().mockRejectedValue(upstreamError),
    };
    const service = new ModerationAccessService({} as never, maxClient as never);
    const warn = jest.spyOn((service as any).logger, 'warn').mockImplementation(() => undefined);

    await expect(service.getRemoteChatAdminAccess('chat-upstream', 'user-1')).resolves.toBeNull();
    await expect(service.getRemoteChatAdminAccess('chat-upstream', 'user-1')).resolves.toBeNull();
    await expect(service.getRemoteChatAdminAccess('chat-upstream', 'user-2')).resolves.toBeNull();
    await expect(service.getRemoteChatAdminAccess('chat-other', 'user-1')).resolves.toBeNull();

    expect(maxClient.getChatMembersAccess).toHaveBeenCalledTimes(2);
    expect(maxClient.getChatMembersAccess.mock.calls.map(([chatId]) => chatId)).toEqual([
      'chat-upstream',
      'chat-other',
    ]);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: 'chat-upstream',
        userIds: ['user-1'],
        backoffMs: 30_000,
      }),
      'Failed to resolve chat admins for moderation bypass',
    );
  });

  it('shares remote admin lookup backoff between service instances', async () => {
    const deniedError = Object.assign(new Error('Request failed with status code 403'), {
      response: {
        status: 403,
        data: {
          message: 'Request failed with status code 403',
        },
      },
    });
    let sharedBackoffRemainingMs = 0;
    const chatContextCache = {
      getAdminAccessBatch: jest.fn().mockResolvedValue(new Map()),
      getAdminAccess: jest.fn(),
      applyAdminAccessEpochMutation: jest.fn().mockResolvedValue(true),
      activateAdminLookupBackoff: jest
        .fn()
        .mockImplementation(async (_chatId: string, ttlSec: number) => {
          sharedBackoffRemainingMs = ttlSec * 1_000;
        }),
      getAdminLookupBackoffRemainingMs: jest
        .fn()
        .mockImplementation(async () => sharedBackoffRemainingMs),
      invalidate: jest.fn().mockResolvedValue(undefined),
    };
    const maxClient = {
      getChatMembersAccess: jest.fn().mockRejectedValue(deniedError),
      getCurrentChatMemberAccess: jest.fn(),
    };
    const createService = () =>
      new ModerationService(
        {} as never,
        {} as never,
        {} as never,
        maxClient as never,
        chatContextCache as never,
      ) as unknown as {
        getRemoteChatAdminAccess: (
          chatId: string,
          userId: string,
        ) => Promise<'granted' | 'user_denied' | null>;
      };

    await expect(createService().getRemoteChatAdminAccess('chat-denied', 'user-1')).resolves.toBe(
      null,
    );
    await expect(createService().getRemoteChatAdminAccess('chat-denied', 'user-1')).resolves.toBe(
      null,
    );

    expect(chatContextCache.activateAdminLookupBackoff).toHaveBeenCalledWith('chat-denied', 30);
    expect(chatContextCache.getAdminLookupBackoffRemainingMs).toHaveBeenCalled();
    expect(maxClient.getChatMembersAccess).toHaveBeenCalledTimes(1);
  });

  it('batches concurrent global spammer exemption lookups within the same admin scope', async () => {
    const prisma = {
      adminGlobalSpammerExemption: {
        findMany: jest.fn().mockResolvedValue([{ userId: 'iduser-1' }]),
      },
    };
    const service = new ModerationService(prisma as never, {} as never, {} as never, {} as never);

    const [first, second] = await Promise.all([
      (
        service as unknown as {
          resolveGlobalSpammerExemptUserIds: (
            userIds: readonly string[],
            adminUserIds: readonly string[] | undefined,
            options?: {
              chatId?: string;
            },
          ) => Promise<Set<string>>;
        }
      ).resolveGlobalSpammerExemptUserIds(['user-1'], ['admin-1'], {
        chatId: 'chat-1',
      }),
      (
        service as unknown as {
          resolveGlobalSpammerExemptUserIds: (
            userIds: readonly string[],
            adminUserIds: readonly string[] | undefined,
            options?: {
              chatId?: string;
            },
          ) => Promise<Set<string>>;
        }
      ).resolveGlobalSpammerExemptUserIds(['user-2'], ['admin-1'], {
        chatId: 'chat-1',
      }),
    ]);

    expect(first).toEqual(new Set(['user-1']));
    expect(second).toEqual(new Set());
    // A sequential read of the same negative result must not require another SQL lookup.
    await expect(
      (
        service as unknown as {
          resolveGlobalSpammerExemptUserIds: (
            users: string[],
            admins: string[],
            options: { chatId: string },
          ) => Promise<Set<string>>;
        }
      ).resolveGlobalSpammerExemptUserIds(['user-2'], ['admin-1'], { chatId: 'chat-1' }),
    ).resolves.toEqual(new Set());
    expect(prisma.adminGlobalSpammerExemption.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.adminGlobalSpammerExemption.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          adminUserId: {
            in: expect.arrayContaining(['admin-1', 'idadmin-1']),
          },
          userId: {
            in: expect.arrayContaining(['user-1', 'iduser-1', 'user-2', 'iduser-2']),
          },
        },
        select: {
          userId: true,
          decision: true,
          updatedAt: true,
        },
      }),
    );
  });

  it('publishes a remote grant without materializing a durable allowlist row', async () => {
    const chatContextCache = {
      rememberChatAdminUser: jest.fn().mockResolvedValue(undefined),
      invalidate: jest.fn().mockResolvedValue(undefined),
    };
    const prisma = {
      chatAdminAllowlist: {
        upsert: jest.fn().mockResolvedValue(undefined),
      },
      $transaction: jest.fn(),
    };
    const queryRaw = jest
      .fn()
      .mockImplementation(async (query: unknown) =>
        readSqlText(query).includes('FROM "chats" AS chat') ? [{ id: 'chat-1' }] : [],
      );
    prisma.$transaction.mockImplementation(async (operation: (tx: unknown) => unknown) =>
      operation({
        $queryRaw: queryRaw,
      }),
    );
    const service = new ModerationService(
      prisma as never,
      {} as never,
      {} as never,
      {} as never,
      chatContextCache as never,
      undefined,
      { get: jest.fn() } as never,
    );

    await (
      service as unknown as {
        persistRemoteAdminGrant: (chatId: string, userId: string) => Promise<void>;
      }
    ).persistRemoteAdminGrant('chat-1', 'user-1');

    expect(prisma.chatAdminAllowlist.upsert).not.toHaveBeenCalled();
    expect(chatContextCache.rememberChatAdminUser).not.toHaveBeenCalled();
    expect(chatContextCache.invalidate).not.toHaveBeenCalled();
  });
});
