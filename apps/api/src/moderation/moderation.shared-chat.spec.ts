import { ChatBotMembershipStatus, WebhookStatus } from '../prisma/prisma-client';
import type { Prisma } from '../prisma/prisma-client';
import type { MaxUpdate } from '@maxim/contracts';
import { WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINE_PREFIX } from '../webhook/webhook-timeout-quarantine';
import { ModerationService } from './moderation.service';
import {
  SHARED_CHAT_EXECUTION_LOCK_AMBIGUOUS_RETRY_AFTER_MS,
  SHARED_CHAT_EXECUTION_LOCK_TTL_MS,
} from './moderation.service.support';

function createGroupMessageUpdate(type = 'message_created', botId?: string): MaxUpdate {
  return {
    updateId: `upd-${type}-1`,
    type,
    ...(botId ? { botId } : {}),
    message: {
      messageId: `mid-${type}-1`,
      chatId: '-100123',
      chatTitle: 'Shared chat',
      senderId: 'user-1',
      senderName: 'User 1',
      text: 'Привет',
      createdAt: new Date('2026-03-30T12:00:00.000Z').toISOString(),
    },
  };
}

type SharedChatLockGuard = {
  mode: 'allow';
  activeBotId: string;
  primaryBotId: string;
  assignedBotIds: string[];
  requiresExecutionLock: true;
};

describe('ModerationService shared chat ownership', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('skips non-primary group updates before moderation work starts', async () => {
    const prisma = {};
    const ruleEngine = {
      detect: jest.fn(),
    };
    const maxClient = {
      leaveCurrentChat: jest.fn(),
    };
    const maxBotLinkService = {
      getChatExecutionBinding: jest.fn().mockResolvedValue({
        chatId: '-100123',
        activeBotId: 'id613002203036_4_bot',
        primaryBotId: 'id613002203036_bot',
        activeMembershipStatus: ChatBotMembershipStatus.ACTIVE,
        assignedBotIds: ['id613002203036_bot', 'id613002203036_4_bot'],
        shouldHandleGroupUpdate: false,
      }),
    };
    const maxBotContextService = {
      getActiveBotId: jest.fn().mockReturnValue('id613002203036_4_bot'),
    };

    const service = new ModerationService(
      prisma as never,
      ruleEngine as never,
      {} as never,
      maxClient as never,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      maxBotLinkService as never,
      maxBotContextService as never,
    );

    await service.handleUpdate(createGroupMessageUpdate());

    expect(maxBotLinkService.getChatExecutionBinding).toHaveBeenCalledWith({
      chatId: '-100123',
      activeBotId: 'id613002203036_4_bot',
    });
    expect(ruleEngine.detect).not.toHaveBeenCalled();
    expect(maxClient.leaveCurrentChat).not.toHaveBeenCalled();
  });

  it('skips owner-stamped standby updates while a processable owner delivery exists', async () => {
    const prisma = {
      webhookEvent: {
        findFirst: jest.fn().mockResolvedValue({ id: 'owner-event-1' }),
      },
    };
    const maxBotContextService = {
      getActiveBotId: jest.fn().mockReturnValue('bot-2'),
    };
    const maxBotLinkService = {
      getChatExecutionBinding: jest.fn(),
    };
    const service = new ModerationService(
      prisma as never,
      {} as never,
      {} as never,
      {} as never,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      maxBotLinkService as never,
      maxBotContextService as never,
    );
    const update = {
      ...createGroupMessageUpdate('message_created', 'bot-2'),
      executionOwnerBotId: 'bot-1',
    } as MaxUpdate & { executionOwnerBotId: string };

    await expect(
      (
        service as unknown as {
          resolveSharedChatExecutionGuard: (
            update: MaxUpdate,
            chatId: string,
          ) => Promise<{
            mode: 'allow' | 'skip' | 'blocked-join-check-only';
            activeBotId: string | null;
            primaryBotId: string | null;
            assignedBotIds: string[];
            requiresExecutionLock?: boolean;
            lockScope?: 'owner' | 'chat';
            reason?: string;
          }>;
        }
      ).resolveSharedChatExecutionGuard(update, '-100123'),
    ).resolves.toEqual({
      mode: 'skip',
      activeBotId: 'bot-2',
      primaryBotId: 'bot-1',
      assignedBotIds: ['bot-1'],
      reason: 'non-primary-bot',
    });
    expect(prisma.webhookEvent.findFirst).toHaveBeenCalledWith({
      where: {
        dedupKey: 'bot-1:upd-message_created-1',
        botId: 'bot-1',
        OR: [
          {
            status: { in: [WebhookStatus.RECEIVED, WebhookStatus.QUEUED, WebhookStatus.PROCESSED] },
          },
          {
            status: WebhookStatus.FAILED,
            OR: [
              { nextEnqueueAt: { not: null } },
              {
                errorMessage: {
                  startsWith: `${WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINE_PREFIX}:`,
                },
              },
            ],
          },
        ],
      },
      select: {
        id: true,
      },
    });
  });

  it('skips owner-stamped standby updates while the owner failed delivery is retryable', async () => {
    const prisma = {
      webhookEvent: {
        findFirst: jest.fn().mockResolvedValue({ id: 'owner-retryable-failed-event' }),
      },
    };
    const maxBotContextService = {
      getActiveBotId: jest.fn().mockReturnValue('bot-2'),
    };
    const maxBotLinkService = {
      getChatExecutionBinding: jest.fn(),
    };
    const service = new ModerationService(
      prisma as never,
      {} as never,
      {} as never,
      {} as never,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      maxBotLinkService as never,
      maxBotContextService as never,
    );
    const update = {
      ...createGroupMessageUpdate('message_created', 'bot-2'),
      executionOwnerBotId: 'bot-1',
    } as MaxUpdate & { executionOwnerBotId: string };

    await expect(
      (
        service as unknown as {
          resolveSharedChatExecutionGuard: (
            update: MaxUpdate,
            chatId: string,
          ) => Promise<{
            mode: 'allow' | 'skip' | 'blocked-join-check-only';
            activeBotId: string | null;
            primaryBotId: string | null;
            assignedBotIds: string[];
            reason?: string;
          }>;
        }
      ).resolveSharedChatExecutionGuard(update, '-100123'),
    ).resolves.toEqual({
      mode: 'skip',
      activeBotId: 'bot-2',
      primaryBotId: 'bot-1',
      assignedBotIds: ['bot-1'],
      reason: 'non-primary-bot',
    });
    expect(prisma.webhookEvent.findFirst).toHaveBeenCalledWith({
      where: {
        dedupKey: 'bot-1:upd-message_created-1',
        botId: 'bot-1',
        OR: [
          {
            status: { in: [WebhookStatus.RECEIVED, WebhookStatus.QUEUED, WebhookStatus.PROCESSED] },
          },
          {
            status: WebhookStatus.FAILED,
            OR: [
              { nextEnqueueAt: { not: null } },
              {
                errorMessage: {
                  startsWith: `${WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINE_PREFIX}:`,
                },
              },
            ],
          },
        ],
      },
      select: {
        id: true,
      },
    });
  });

  it('processes owner-stamped standby updates as recovery when owner delivery is absent', async () => {
    const prisma = {
      webhookEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
      },
    };
    const maxBotContextService = {
      getActiveBotId: jest.fn().mockReturnValue('bot-2'),
    };
    const maxBotLinkService = {
      getChatExecutionBinding: jest.fn(),
    };
    const service = new ModerationService(
      prisma as never,
      {} as never,
      {} as never,
      {} as never,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      maxBotLinkService as never,
      maxBotContextService as never,
    );
    const update = {
      ...createGroupMessageUpdate('message_created', 'bot-2'),
      executionOwnerBotId: 'bot-1',
    } as MaxUpdate & { executionOwnerBotId: string };

    await expect(
      (
        service as unknown as {
          resolveSharedChatExecutionGuard: (
            update: MaxUpdate,
            chatId: string,
          ) => Promise<{
            mode: 'allow' | 'skip' | 'blocked-join-check-only';
            activeBotId: string | null;
            primaryBotId: string | null;
            assignedBotIds: string[];
            requiresExecutionLock?: boolean;
            lockScope?: 'owner' | 'chat';
          }>;
        }
      ).resolveSharedChatExecutionGuard(update, '-100123'),
    ).resolves.toEqual({
      mode: 'allow',
      activeBotId: 'bot-2',
      primaryBotId: 'bot-1',
      assignedBotIds: ['bot-1', 'bot-2'],
      requiresExecutionLock: true,
      lockScope: 'chat',
    });
  });

  it('processes owner-stamped standby updates as recovery when owner failure is terminal', async () => {
    const prisma = {
      webhookEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
      },
    };
    const maxBotContextService = {
      getActiveBotId: jest.fn().mockReturnValue('bot-2'),
    };
    const maxBotLinkService = {
      getChatExecutionBinding: jest.fn(),
    };
    const service = new ModerationService(
      prisma as never,
      {} as never,
      {} as never,
      {} as never,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      maxBotLinkService as never,
      maxBotContextService as never,
    );
    const update = {
      ...createGroupMessageUpdate('message_created', 'bot-2'),
      executionOwnerBotId: 'bot-1',
    } as MaxUpdate & { executionOwnerBotId: string };

    await expect(
      (
        service as unknown as {
          resolveSharedChatExecutionGuard: (
            update: MaxUpdate,
            chatId: string,
          ) => Promise<{
            mode: 'allow' | 'skip' | 'blocked-join-check-only';
            activeBotId: string | null;
            primaryBotId: string | null;
            assignedBotIds: string[];
            requiresExecutionLock?: boolean;
            lockScope?: 'owner' | 'chat';
          }>;
        }
      ).resolveSharedChatExecutionGuard(update, '-100123'),
    ).resolves.toEqual({
      mode: 'allow',
      activeBotId: 'bot-2',
      primaryBotId: 'bot-1',
      assignedBotIds: ['bot-1', 'bot-2'],
      requiresExecutionLock: true,
      lockScope: 'chat',
    });
    expect(prisma.webhookEvent.findFirst).toHaveBeenCalledWith({
      where: {
        dedupKey: 'bot-1:upd-message_created-1',
        botId: 'bot-1',
        OR: [
          {
            status: { in: [WebhookStatus.RECEIVED, WebhookStatus.QUEUED, WebhookStatus.PROCESSED] },
          },
          {
            status: WebhookStatus.FAILED,
            OR: [
              { nextEnqueueAt: { not: null } },
              {
                errorMessage: {
                  startsWith: `${WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINE_PREFIX}:`,
                },
              },
            ],
          },
        ],
      },
      select: {
        id: true,
      },
    });
  });

  it('still executes blocked-join protection for non-primary bot_added events in denied chats', async () => {
    const tx = {
      chatAdminAllowlist: {
        deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
      $queryRaw: jest.fn().mockResolvedValue([{ id: '-100123' }]),
    };
    const prisma = {
      ...tx,
      $transaction: jest.fn(async (work: (client: Prisma.TransactionClient) => Promise<void>) =>
        work(tx as unknown as Prisma.TransactionClient),
      ),
    };
    const maxClient = {
      leaveCurrentChat: jest.fn().mockResolvedValue(undefined),
    };
    const maxBotLinkService = {
      getChatExecutionBinding: jest.fn().mockResolvedValue({
        chatId: '-100123',
        activeBotId: 'id613002203036_4_bot',
        primaryBotId: 'id613002203036_bot',
        activeMembershipStatus: ChatBotMembershipStatus.ACTIVE,
        assignedBotIds: ['id613002203036_bot', 'id613002203036_4_bot'],
        shouldHandleGroupUpdate: false,
      }),
    };
    const maxBotContextService = {
      getActiveBotId: jest.fn().mockReturnValue('id613002203036_4_bot'),
    };
    const configService = {
      get: jest.fn((key: string) => {
        if (key === 'MAX_JOIN_DENY_CHAT_IDS') {
          return '-100123';
        }
        return undefined;
      }),
    };
    const chatContextCache = {
      invalidate: jest.fn().mockResolvedValue(undefined),
    };

    const service = new ModerationService(
      prisma as never,
      {} as never,
      {} as never,
      maxClient as never,
      chatContextCache as never,
      undefined,
      configService as never,
      undefined,
      undefined,
      undefined,
      undefined,
      maxBotLinkService as never,
      maxBotContextService as never,
    );

    await service.handleUpdate(createGroupMessageUpdate('bot_added', 'id613002203036_4_bot'));

    expect(maxClient.leaveCurrentChat).toHaveBeenCalledWith('-100123', {
      botId: 'id613002203036_4_bot',
    });
    expect(prisma.chatAdminAllowlist.deleteMany).toHaveBeenCalledWith({
      where: { chatId: '-100123' },
    });
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(chatContextCache.invalidate).toHaveBeenCalledWith('-100123');
  });

  it('acquires only one shared execution lock for the same update across runtimes', async () => {
    const service = new ModerationService(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        getActiveBotId: jest.fn().mockReturnValue('id613002203036_bot'),
      } as never,
    );

    const update = createGroupMessageUpdate();
    const guard: SharedChatLockGuard = {
      mode: 'allow' as const,
      activeBotId: 'id613002203036_bot',
      primaryBotId: 'id613002203036_bot',
      assignedBotIds: ['id613002203036_bot', 'id613002203036_4_bot'],
      requiresExecutionLock: true,
    };

    const first = await (
      service as unknown as {
        acquireSharedChatExecutionLock: (
          update: MaxUpdate,
          chatId: string,
          guard: SharedChatLockGuard,
        ) => Promise<{ key: string; token: string; mode: 'redis' | 'memory' } | null>;
        releaseSharedChatExecutionLock: (lock: {
          key: string;
          token: string;
          mode: 'redis' | 'memory';
        }) => Promise<void>;
      }
    ).acquireSharedChatExecutionLock(update, '-100123', guard);
    const second = await (
      service as unknown as {
        acquireSharedChatExecutionLock: (
          update: MaxUpdate,
          chatId: string,
          guard: SharedChatLockGuard,
        ) => Promise<{ key: string; token: string; mode: 'redis' | 'memory' } | null>;
      }
    ).acquireSharedChatExecutionLock(update, '-100123', guard);

    expect(first).not.toBeNull();
    expect(second).toBeNull();

    await (
      service as unknown as {
        releaseSharedChatExecutionLock: (lock: {
          key: string;
          token: string;
          mode: 'redis' | 'memory';
        }) => Promise<void>;
      }
    ).releaseSharedChatExecutionLock(first!);

    const third = await (
      service as unknown as {
        acquireSharedChatExecutionLock: (
          update: MaxUpdate,
          chatId: string,
          guard: SharedChatLockGuard,
        ) => Promise<{ key: string; token: string; mode: 'redis' | 'memory' } | null>;
      }
    ).acquireSharedChatExecutionLock(update, '-100123', guard);

    expect(third).not.toBeNull();
  });

  it('falls back to local execution when shared chat binding lookup stalls', async () => {
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

    const maxBotLinkService = {
      getChatExecutionBinding: jest.fn().mockImplementation(() => new Promise(() => undefined)),
    };
    const maxBotContextService = {
      getActiveBotId: jest.fn().mockReturnValue('id613002203036_bot'),
    };
    const configService = {
      get: jest.fn((key: string) => {
        if (key === 'SHARED_CHAT_EXECUTION_LOOKUP_TIMEOUT_MS') {
          return 50;
        }
        return undefined;
      }),
    };

    try {
      const service = new ModerationService(
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        undefined,
        undefined,
        configService as never,
        undefined,
        undefined,
        undefined,
        undefined,
        maxBotLinkService as never,
        maxBotContextService as never,
      );

      const guard = await (
        service as unknown as {
          resolveSharedChatExecutionGuard: (
            update: MaxUpdate,
            chatId: string,
          ) => Promise<{
            mode: 'allow' | 'skip' | 'blocked-join-check-only';
            activeBotId: string | null;
            primaryBotId: string | null;
            assignedBotIds: string[];
            requiresExecutionLock?: boolean;
          }>;
        }
      ).resolveSharedChatExecutionGuard(createGroupMessageUpdate(), '-100123');

      expect(guard).toMatchObject({
        mode: 'allow',
        activeBotId: 'id613002203036_bot',
        primaryBotId: null,
        assignedBotIds: ['id613002203036_bot'],
        requiresExecutionLock: true,
      });
      expect(setTimeoutSpy).toHaveBeenCalledTimes(1);
      expect(clearTimeoutSpy).toHaveBeenCalledTimes(1);
    } finally {
      setTimeoutSpy.mockRestore();
      clearTimeoutSpy.mockRestore();
    }
  });

  it('uses the caller token and Redis deadline for a shared execution lock', async () => {
    const redisCounter = {
      acquireLockBeforeDeadline: jest.fn().mockResolvedValue({ kind: 'acquired' }),
      releaseLock: jest.fn().mockResolvedValue(undefined),
    };
    const service = new ModerationService(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      undefined,
      undefined,
      undefined,
      redisCounter as never,
    );

    const startedAtMs = Date.now();
    const lock = await (
      service as unknown as {
        acquireSharedChatExecutionLock: (
          update: MaxUpdate,
          chatId: string,
          guard: SharedChatLockGuard,
        ) => Promise<{ key: string; token: string; mode: 'redis' | 'memory' } | null>;
        releaseSharedChatExecutionLock: (lock: {
          key: string;
          token: string;
          mode: 'redis' | 'memory';
        }) => Promise<void>;
      }
    ).acquireSharedChatExecutionLock(createGroupMessageUpdate(), '-100123', {
      mode: 'allow',
      activeBotId: 'id613002203036_bot',
      primaryBotId: 'id613002203036_bot',
      assignedBotIds: ['id613002203036_bot', 'id613002203036_4_bot'],
      requiresExecutionLock: true,
    });

    expect(lock).toMatchObject({ mode: 'redis', token: expect.any(String) });
    expect(redisCounter.acquireLockBeforeDeadline).toHaveBeenCalledWith(
      lock!.key,
      lock!.token,
      SHARED_CHAT_EXECUTION_LOCK_TTL_MS,
      expect.any(Number),
    );
    const deadlineAtMs = redisCounter.acquireLockBeforeDeadline.mock.calls[0]?.[3] as number;
    expect(deadlineAtMs).toBeGreaterThanOrEqual(startedAtMs + 1_000);
    expect(deadlineAtMs).toBeLessThanOrEqual(Date.now() + 1_000);

    await (
      service as unknown as {
        releaseSharedChatExecutionLock: (lock: {
          key: string;
          token: string;
          mode: 'redis' | 'memory';
        }) => Promise<void>;
      }
    ).releaseSharedChatExecutionLock(lock!);
    expect(redisCounter.releaseLock).toHaveBeenCalledWith(lock!.key, lock!.token);
  });

  it('keeps Redis contention as a duplicate skip without reentrant acquisition', async () => {
    const redisCounter = {
      acquireLockBeforeDeadline: jest.fn().mockResolvedValue({ kind: 'busy' }),
      releaseLock: jest.fn().mockResolvedValue(undefined),
    };
    const service = new ModerationService(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      undefined,
      undefined,
      undefined,
      redisCounter as never,
    );

    await expect(
      (
        service as unknown as {
          acquireSharedChatExecutionLock: (
            update: MaxUpdate,
            chatId: string,
            guard: SharedChatLockGuard,
          ) => Promise<{ key: string; token: string; mode: 'redis' | 'memory' } | null>;
        }
      ).acquireSharedChatExecutionLock(createGroupMessageUpdate(), '-100123', {
        mode: 'allow',
        activeBotId: 'id613002203036_bot',
        primaryBotId: 'id613002203036_bot',
        assignedBotIds: ['id613002203036_bot', 'id613002203036_4_bot'],
        requiresExecutionLock: true,
      }),
    ).resolves.toBeNull();

    expect(redisCounter.acquireLockBeforeDeadline).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      SHARED_CHAT_EXECUTION_LOCK_TTL_MS,
      expect.any(Number),
    );
    expect(redisCounter.releaseLock).not.toHaveBeenCalled();
  });

  it('retries when Redis rejects the acquisition at the server deadline', async () => {
    const redisCounter = {
      acquireLockBeforeDeadline: jest.fn().mockResolvedValue({ kind: 'deadline_exceeded' }),
      releaseLock: jest.fn().mockResolvedValue(undefined),
    };
    const service = new ModerationService(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      undefined,
      undefined,
      undefined,
      redisCounter as never,
    );

    await expect(
      (
        service as unknown as {
          acquireSharedChatExecutionLock: (
            update: MaxUpdate,
            chatId: string,
            guard: SharedChatLockGuard,
          ) => Promise<{ key: string; token: string; mode: 'redis' | 'memory' } | null>;
        }
      ).acquireSharedChatExecutionLock(createGroupMessageUpdate(), '-100123', {
        mode: 'allow',
        activeBotId: 'id613002203036_bot',
        primaryBotId: 'id613002203036_bot',
        assignedBotIds: ['id613002203036_bot', 'id613002203036_4_bot'],
        requiresExecutionLock: true,
      }),
    ).rejects.toMatchObject({
      code: 'ECONNABORTED',
      retryAfterMs: SHARED_CHAT_EXECUTION_LOCK_AMBIGUOUS_RETRY_AFTER_MS,
    });

    await Promise.resolve();
    const [key, token] = redisCounter.acquireLockBeforeDeadline.mock.calls[0]!;
    expect(redisCounter.releaseLock).toHaveBeenCalledWith(key, token);
  });

  it('does not use a process-local lock when Redis acquisition stalls', async () => {
    let resolveAcquisition!: (result: { kind: 'acquired' }) => void;
    const redisCounter = {
      acquireLockBeforeDeadline: jest.fn().mockImplementation(
        () =>
          new Promise<{ kind: 'acquired' }>((resolve) => {
            resolveAcquisition = resolve;
          }),
      ),
      releaseLock: jest.fn().mockResolvedValue(undefined),
    };
    const service = new ModerationService(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      undefined,
      undefined,
      undefined,
      redisCounter as never,
      undefined,
      undefined,
      undefined,
      undefined,
      {
        getActiveBotId: jest.fn().mockReturnValue('id613002203036_bot'),
      } as never,
    );
    const timeoutError = Object.assign(new Error('lock timed out'), {
      code: 'ECONNABORTED',
    });
    (service as any).executeSharedChatOperationWithGuard = jest.fn(
      async (operation: () => Promise<unknown>) => {
        void operation();
        throw timeoutError;
      },
    );

    const lockPromise = (
      service as unknown as {
        acquireSharedChatExecutionLock: (
          update: MaxUpdate,
          chatId: string,
          guard: SharedChatLockGuard,
        ) => Promise<{ key: string; token: string; mode: 'redis' | 'memory' } | null>;
      }
    ).acquireSharedChatExecutionLock(createGroupMessageUpdate(), '-100123', {
      mode: 'allow',
      activeBotId: 'id613002203036_bot',
      primaryBotId: 'id613002203036_bot',
      assignedBotIds: ['id613002203036_bot', 'id613002203036_4_bot'],
      requiresExecutionLock: true,
    });

    await expect(lockPromise).rejects.toMatchObject({
      code: 'ECONNABORTED',
      retryAfterMs: SHARED_CHAT_EXECUTION_LOCK_AMBIGUOUS_RETRY_AFTER_MS,
      sharedChatExecutionLockRetryable: true,
    });
    await Promise.resolve();

    expect(redisCounter.acquireLockBeforeDeadline).toHaveBeenCalledTimes(1);
    const [key, token, ttlMs, deadlineAtMs] = redisCounter.acquireLockBeforeDeadline.mock.calls[0]!;
    expect(ttlMs).toBe(SHARED_CHAT_EXECUTION_LOCK_TTL_MS);
    expect(deadlineAtMs).toBeGreaterThan(0);
    expect(redisCounter.releaseLock).toHaveBeenCalledTimes(1);
    expect(redisCounter.releaseLock).toHaveBeenCalledWith(key, token);

    resolveAcquisition({ kind: 'acquired' });
    await Promise.resolve();
    expect(redisCounter.releaseLock).toHaveBeenCalledTimes(1);
  });

  it('does not use a process-local lock after a Redis acquisition rejection', async () => {
    const transportError = Object.freeze(
      Object.assign(new Error('redis unavailable'), { code: 'ECONNRESET' }),
    );
    const redisCounter = {
      acquireLockBeforeDeadline: jest.fn().mockRejectedValue(transportError),
      releaseLock: jest.fn().mockResolvedValue(undefined),
    };
    const service = new ModerationService(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      undefined,
      undefined,
      undefined,
      redisCounter as never,
    );

    await expect(
      (
        service as unknown as {
          acquireSharedChatExecutionLock: (
            update: MaxUpdate,
            chatId: string,
            guard: SharedChatLockGuard,
          ) => Promise<{ key: string; token: string; mode: 'redis' | 'memory' } | null>;
        }
      ).acquireSharedChatExecutionLock(createGroupMessageUpdate(), '-100123', {
        mode: 'allow',
        activeBotId: 'id613002203036_bot',
        primaryBotId: 'id613002203036_bot',
        assignedBotIds: ['id613002203036_bot', 'id613002203036_4_bot'],
        requiresExecutionLock: true,
      }),
    ).rejects.toMatchObject({
      message: 'redis unavailable',
      code: 'ECONNRESET',
      retryAfterMs: SHARED_CHAT_EXECUTION_LOCK_AMBIGUOUS_RETRY_AFTER_MS,
      sharedChatExecutionLockRetryable: true,
      cause: transportError,
    });

    await Promise.resolve();
    const [key, token] = redisCounter.acquireLockBeforeDeadline.mock.calls[0]!;
    expect(redisCounter.releaseLock).toHaveBeenCalledWith(key, token);
  });
});
