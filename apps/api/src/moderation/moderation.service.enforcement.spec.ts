import {
  markMaxMemberMutationAttempted,
  ChatEntityType,
  EventType,
  Operator,
  SanctionAction,
  ModerationSanctionStateLockLeaseLostError,
  ModerationService,
  withAutomaticMutePersistenceFixture,
  DUPLICATE_FOLLOW_UP_HOT_PATH_TIMEOUT_MS,
  MODERATION_ACTION_DISPATCH_TIMEOUT_MS,
  userMention,
  majorExplanation,
  duplicateExplanation,
  muteNotice,
  permanentBanNotice,
  textFilterWarnNotice,
  expectImmediateDeleteMessage,
  expectImmediateBanMember,
  nightModeNotice,
  nightModeOpenNotice,
  createMaxApiError,
  createRedisCounterMock,
  createModerationServiceWithManualBridge,
  createModerationServiceWithSanctionStateLock,
  createSettings,
  createUpdate,
  createAdminForwardedBanUpdate,
  createAdminLinkedModerationUpdate,
  createAdminReplyModerationUpdate,
  createAdminForwardedRulesUpdate,
  createGroupRulesCallbackUpdate,
  type MaxUpdate,
} from './moderation.service.spec-support';
import { MaxActionLedgerService } from '../max/max-action-ledger.service';
import type { AdminService } from '../admin/admin.service';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { classifyDuplicateEventTime } from './duplicate-enforcement-safety';
import { CommercialDeleteGuardRejectedError } from './commercial/commercial-delete-guard.service';
import { buildNightModeTransitionScheduleFingerprint } from './night-mode-transition-generation.util';
import { ConfigService } from '@nestjs/config';
import {
  CLOSED_CHAT_DELETE_RULE_CODES,
  ClosedChatDeleteGuardService,
} from './closed-chat-delete-guard.service';
import type { EnsureModerationDeleteIntentInput } from './moderation-delete-intent.types';
import type { NightModeTransitionSchedulerService } from './night-mode-transition-scheduler.service';
import { NIGHT_MODE_TRANSITION_CLOSE_CLEANUP_RECOVERY } from './night-mode-transition.queue';
import type { Prisma } from '../prisma/prisma-client';

// FLAG: These legacy transport mocks verify templates and hot-path orchestration only.
// Native multibot/queue fixtures and the real notice-guard suites own v3 receipt authority.
jest.mock('./message-duplicate/message-duplicate-notice-proof', () => ({
  ...jest.requireActual('./message-duplicate/message-duplicate-notice-proof'),
  buildMessageDuplicateNoticeContext: jest.fn(async () => ({
    orchestrationFixture: 'duplicate-notice-handoff',
  })),
}));

const NIGHT_MODE_V4_JOB_METADATA = {
  transitionRuntimeVersion: 4 as const,
  scheduleFingerprint: buildNightModeTransitionScheduleFingerprint({
    nightModeEnabled: true,
    nightModeStartTimeMinutes: 23 * 60,
    nightModeEndTimeMinutes: 8 * 60,
    nightModeTimezone: 'Europe/Moscow',
  }),
};

function installProfanityDeleteGuard(service: ModerationService): void {
  Object.assign(service, {
    profanityDeleteGuard: { assertMessageStillActionable: jest.fn().mockResolvedValue('allowed') },
  });
  const maxClient = (service as unknown as { maxClient: { deleteMessage: jest.Mock } }).maxClient;
  const originalDelete = maxClient.deleteMessage.getMockImplementation();
  maxClient.deleteMessage.mockImplementation(async (...args: unknown[]) => {
    const options = args[2] as { beforeImmediateDeleteMutation?: () => Promise<void> } | undefined;
    await options?.beforeImmediateDeleteMutation?.();
    return originalDelete?.(...args);
  });
}

function installCommercialDeleteGuard(service: ModerationService) {
  const guard = {
    assertMessageStillActionable: jest.fn().mockResolvedValue('allowed'),
    createSanctionPermit: jest.fn().mockReturnValue({ expiresAtMs: Date.now() + 60_000 }),
    authorizeSanction: jest.fn().mockResolvedValue(true),
  };
  Object.assign(service, { commercialDeleteGuard: guard });
  const maxClient = (service as unknown as { maxClient: { deleteMessage: jest.Mock } }).maxClient;
  const remoteDelete = jest.fn(maxClient.deleteMessage.getMockImplementation());
  maxClient.deleteMessage.mockImplementation(async (...args: unknown[]) => {
    await (
      args[2] as { beforeImmediateDeleteMutation?: () => Promise<void> }
    )?.beforeImmediateDeleteMutation?.();
    return remoteDelete(...args);
  });
  return { guard, remoteDelete };
}

function installClosedChatDeleteFixture(
  service: ModerationService,
  settings: ReturnType<typeof createSettings>,
  update: MaxUpdate,
) {
  const message = update.message!;
  const dependencies = service as unknown as {
    prisma: { moderationEvent: { create: jest.Mock } };
    maxClient: { deleteMessage: jest.Mock };
  };
  const access = jest.fn(async (chatId: string, userId: string) =>
    chatId === message.chatId && userId === message.senderId
      ? { userId, isAdmin: false, isOwner: false }
      : null,
  );
  const source = jest.fn(async (chatId: string, messageId: string) =>
    chatId === message.chatId && messageId === message.messageId
      ? {
          sender: { user_id: message.senderId },
          recipient: { chat_id: message.chatId, chat_type: 'chat' },
          timestamp: Date.parse(message.createdAt),
          body: { mid: message.messageId, text: message.text },
        }
      : null,
  );
  const guard = new ClosedChatDeleteGuardService(
    {
      chatSettings: {
        findUnique: jest.fn(async ({ where }: { where: { chatId: string } }) =>
          where.chatId === message.chatId
            ? {
                ...settings,
                chat: { entityType: ChatEntityType.CHAT, admins: [], chatControlOrderAt: null },
              }
            : null,
        ),
      },
    } as never,
    { getChatMemberAccess: access, getExactMessageRow: source } as never,
    { isKnownBotUserId: () => false } as never,
    { consumeForMessage: async () => 'not_granted' } as never,
    new ConfigService(),
  );
  const remoteDelete = jest.fn(dependencies.maxClient.deleteMessage.getMockImplementation());
  dependencies.maxClient.deleteMessage.mockImplementation(async (...args: unknown[]) => {
    await (
      args[2] as { beforeImmediateDeleteMutation?: () => Promise<void> }
    )?.beforeImmediateDeleteMutation?.();
    return remoteDelete(...args);
  });
  // FLAG: Closed-chat fixtures use the real current-session/source guard at transport.
  // The intent adapter delegates authorization to that guard before recording success.
  Object.assign(service, {
    moderationDeleteIntentService: {
      ensureIntent: jest.fn(),
      getRolloutForInput: () => 'execute',
      ensureAndAttempt: async (input: EnsureModerationDeleteIntentInput) => {
        if (!input.ruleCode || !CLOSED_CHAT_DELETE_RULE_CODES.has(input.ruleCode))
          throw new Error('Closed-chat fixture received an unrelated rule');
        const botId = 'closed-chat-fixture-bot';
        await dependencies.maxClient.deleteMessage(input.chatId, input.messageId, {
          botId,
          immediate: true,
          trafficClass: 'critical',
          actionHealthLane: 'critical',
          sourceTag: 'moderation_delete',
          timeoutMs: MODERATION_ACTION_DISPATCH_TIMEOUT_MS,
          ignoreFailureMetricStatuses: [403, 404],
          beforeImmediateDeleteMutation: async () => {
            const permit = await guard.authorize({
              chatId: input.chatId,
              messageId: input.messageId,
              subjectUserId: input.subjectUserId ?? null,
              sourceMessageAt: input.sourceMessageAt ? new Date(input.sourceMessageAt) : null,
              botId,
              reasons: [
                {
                  ruleCode: input.ruleCode!,
                  reasonKey: input.reasonKey,
                  metadata: input.event?.metadata,
                },
              ],
            });
            if (typeof permit !== 'object' || !permit.reasonKeys.includes(input.reasonKey))
              throw new Error('Closed-chat fixture source is not authorized');
          },
        });
        await dependencies.prisma.moderationEvent.create({
          data: {
            chatId: input.chatId,
            userId: input.subjectUserId,
            messageId: input.messageId,
            eventType: EventType.MESSAGE,
            ruleCode: input.ruleCode,
            action: SanctionAction.DELETE_MESSAGE,
            maskedExcerpt: input.event?.maskedExcerpt,
            score: input.event?.score,
            operator: Operator.BOT,
            metadata: input.event?.metadata,
          },
        });
        return {
          kind: 'confirmed',
          confirmed: true,
          intentId: 'closed-chat-fixture-intent',
          status: 'SUCCEEDED',
          botId,
          verifiedReasonKeys: [input.reasonKey],
        };
      },
    },
  });
  return { access, source, remoteDelete };
}

jest
  .spyOn(MaxActionLedgerService.prototype, 'inspectCompletedNightModeCloseNoticeDispatch')
  .mockImplementation(async ({ chatId, sessionKey }) => ({
    kind: 'missing',
    jobId: `night-mode:close:${chatId.trim()}:session:${sessionKey.trim()}`,
  }));

function installRemoteAdminProbeFence(prisma: object): void {
  Object.assign(prisma, {
    $transaction: jest.fn().mockImplementation(async (operation: (tx: unknown) => unknown) =>
      operation({
        $queryRaw: jest.fn().mockImplementation(async (query: unknown) => {
          const sql = (query as { strings?: readonly string[] }).strings?.join('?') ?? '';
          return sql.includes('FROM "chats" AS chat') ? [{ id: 'chat-1' }] : [];
        }),
      }),
    ),
  });
}

function installNightModeSideEffectFence<T extends { chat?: Record<string, unknown> | null }>(
  prisma: object,
  settings: T,
): T {
  const persistedSettings = {
    ...settings,
    chat: {
      ...(settings.chat ?? {}),
      entityType: ChatEntityType.CHAT,
    },
  };
  Object.assign(prisma, {
    chatSettings: {
      findUnique: jest.fn().mockResolvedValue(persistedSettings),
    },
  });
  return persistedSettings;
}

function createNightModeOpenEventStore() {
  return {
    create: jest.fn(),
    findFirst: jest.fn(async (query: Prisma.ModerationEventFindFirstArgs) =>
      query.where?.ruleCode === 'NIGHT_MODE_CLOSE_NOTICE'
        ? { id: 'night-close-event-1', messageId: 'night-close-1', botId: 'bot-1' }
        : null,
    ),
  };
}

function installNightModeRecoveryFixture(service: ModerationService) {
  const scheduler = {
    scheduleRecoveryObligation: jest
      .fn<
        ReturnType<NightModeTransitionSchedulerService['scheduleRecoveryObligation']>,
        Parameters<NightModeTransitionSchedulerService['scheduleRecoveryObligation']>
      >()
      .mockResolvedValue(undefined),
  } satisfies Pick<NightModeTransitionSchedulerService, 'scheduleRecoveryObligation'>;
  Object.assign(service, { nightModeTransitionScheduler: scheduler });
  return {
    scheduler,
    processCleanup: async () => {
      const handoff = scheduler.scheduleRecoveryObligation.mock.calls.find(
        ([, recovery]) => recovery.kind === NIGHT_MODE_TRANSITION_CLOSE_CLEANUP_RECOVERY,
      );
      if (!handoff || handoff[1].kind !== NIGHT_MODE_TRANSITION_CLOSE_CLEANUP_RECOVERY)
        throw new Error('Expected a separate close notice cleanup handoff');
      const [chatId, recovery] = handoff;
      return service.processNightModeTransitionJob({
        ...NIGHT_MODE_V4_JOB_METADATA,
        chatId,
        transition: 'open',
        scheduledFor: recovery.openScheduledFor,
        sessionKey: recovery.sessionKey,
        recoveryOnly: recovery,
      });
    },
  };
}

function createAdminAccessEpochCache(
  context: {
    settings?: ReturnType<typeof createSettings>;
    adminUserIds?: string[];
  } = {},
) {
  const states = new Map<string, 'granted' | 'user_denied'>();
  return {
    getChatContext: jest.fn().mockResolvedValue({
      chatId: 'chat-1',
      title: 'Chat 1',
      settings: context.settings ?? createSettings(),
      domainAllowlist: [],
      adminUserIds: context.adminUserIds ?? [],
      rulesPublishedUrl: null,
      rulesPublishedMessageId: null,
    }),
    getAdminAccessBatch: jest
      .fn()
      .mockImplementation(
        async (_chatId: string, userIds: readonly string[]) =>
          new Map(userIds.map((userId) => [userId, states.get(userId) ?? null] as const)),
      ),
    applyAdminAccessEpochMutation: jest
      .fn()
      .mockImplementation(async (params: { userId: string; state: 'granted' | 'user_denied' }) => {
        states.set(params.userId, params.state);
        return true;
      }),
  };
}

describe('ModerationService', () => {
  it('exposes only expected group-admin command errors', () => {
    const service = createModerationServiceWithManualBridge({
      prisma: {},
      ruleEngine: {},
      sanctionService: {},
      maxClient: {},
      manualBridge: {},
    });
    const extractMessage = (error: unknown) =>
      (service as any).extractGroupAdminCommandErrorMessage(error);

    expect(extractMessage(new BadRequestException('Исправьте параметры команды.'))).toBe(
      'Исправьте параметры команды.',
    );
    expect(extractMessage(new ForbiddenException('Команда недоступна этому администратору.'))).toBe(
      'Команда недоступна этому администратору.',
    );
    expect(extractMessage(new Error('internal database connection details'))).toBe(
      'Попробуйте ещё раз через несколько секунд.',
    );
  });

  it.each([
    { name: 'ordinary Moscow', at: '2026-10-30T00:04:00Z', timezone: 'Europe/Moscow', start: 1380 },
    {
      name: 'second Berlin hour',
      at: '2026-10-25T01:15:00Z',
      timezone: 'Europe/Berlin',
      start: 150,
    },
  ])(
    'deletes night mode messages silently during $name even when notices are enabled',
    async (scenario) => {
      jest
        .useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] })
        .setSystemTime(new Date(scenario.at));
      try {
        const settings = createSettings({
          nightModeEnabled: true,
          nightModeStartTimeMinutes: scenario.start,
          nightModeEndTimeMinutes: 480,
          nightModeTimezone: scenario.timezone,
          nightModeBotMessageEnabled: true,
          nightModeBotMessageText: '',
        });
        const prisma = {
          chat: {
            upsert: jest.fn().mockResolvedValue({
              id: 'chat-1',
              title: 'Chat 1',
              settings,
              domains: [],
              admins: [],
            }),
          },
          violation: {
            create: jest.fn(),
          },
          moderationEvent: {
            findFirst: jest.fn().mockResolvedValue(null),
            create: jest.fn(),
          },
          webhookEvent: {
            findUnique: jest.fn(),
            update: jest.fn(),
          },
        };
        const ruleEngine = {
          detect: jest.fn(),
        };
        const sanctionService = {
          resolveAction: jest.fn(),
        };
        const maxClient = {
          deleteMessage: jest.fn(),
          sendMessage: jest.fn(),
          kickMember: jest.fn(),
          banMember: jest.fn(),
          notifyModerators: jest.fn(),
          getChatMembersAccess: jest.fn().mockResolvedValue(
            new Map([
              [
                'user-1',
                {
                  userId: 'user-1',
                  isAdmin: false,
                  isOwner: false,
                  permissions: [],
                },
              ],
            ]),
          ),
        };

        const service = new ModerationService(
          prisma as never,
          ruleEngine as never,
          sanctionService as never,
          maxClient as never,
        );

        const update = createUpdate();
        const closed = installClosedChatDeleteFixture(service, settings, update);
        await service.handleUpdate(update);

        expect(closed.remoteDelete).toHaveBeenCalledTimes(1);
        expect(closed.access).toHaveBeenCalledWith(
          'chat-1',
          'user-1',
          expect.objectContaining({ botId: 'closed-chat-fixture-bot', bypassCache: true }),
        );
        expect(closed.source).toHaveBeenCalledWith(
          'chat-1',
          'msg-1',
          expect.objectContaining({ botId: 'closed-chat-fixture-bot', bypassCache: true }),
        );

        expect(ruleEngine.detect).not.toHaveBeenCalled();
        expectImmediateDeleteMessage(maxClient.deleteMessage, 'chat-1', 'msg-1');
        expect(maxClient.sendMessage).not.toHaveBeenCalled();
        expect(maxClient.notifyModerators).not.toHaveBeenCalled();
        expect(prisma.moderationEvent.create).toHaveBeenCalledTimes(1);
        expect(prisma.moderationEvent.create).toHaveBeenCalledWith({
          data: expect.objectContaining({
            chatId: 'chat-1',
            userId: 'user-1',
            messageId: 'msg-1',
            ruleCode: 'NIGHT_MODE_DELETE',
            action: SanctionAction.DELETE_MESSAGE,
          }),
        });
      } finally {
        jest.useRealTimers();
      }
    },
  );

  it('recognizes channel updates by normalized parser entityType', () => {
    const service = new ModerationService({} as never, {} as never, {} as never, {} as never);
    const update = {
      ...createUpdate(),
      message: {
        ...createUpdate().message!,
        chatId: 'channel-1',
        entityType: 'channel',
      },
      raw: {},
    } satisfies MaxUpdate;

    expect(
      (service as unknown as { isChannelMessage(update: MaxUpdate): boolean }).isChannelMessage(
        update,
      ),
    ).toBe(true);
  });

  it('sends the night mode close notice from the schedule transition', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-05-30T20:00:15.000Z'));
    try {
      const prisma = {
        moderationEvent: {
          create: jest.fn(),
        },
      };
      const maxClient = {
        sendMessage: jest.fn().mockResolvedValue({
          messageId: 'night-close-1',
          url: null,
        }),
        deleteMessage: jest.fn(),
      };
      const redisCounter = createRedisCounterMock();
      const maxBotLinkService = {
        resolveBotRoute: jest.fn().mockResolvedValue({ botId: 'bot-1' }),
      };
      const service = new ModerationService(
        prisma as never,
        {} as never,
        {} as never,
        maxClient as never,
        undefined,
        undefined,
        { get: jest.fn().mockReturnValue('bot-1') } as never,
        redisCounter as never,
        undefined,
        undefined,
        undefined,
        maxBotLinkService as never,
      );

      await (service as any).processNightModeTransitionForChat(
        installNightModeSideEffectFence(prisma, {
          ...createSettings({
            nightModeEnabled: true,
            nightModeStartTimeMinutes: 23 * 60,
            nightModeEndTimeMinutes: 8 * 60,
            nightModeTimezone: 'Europe/Moscow',
            nightModeBotMessageEnabled: true,
            nightModeBotMessageText: '',
            commentsEnabled: false,
            nightModeCommentsEnabled: true,
            nightModeBotButtonEnabled: true,
            nightModeBotButtonUrl: 'https://max.ru/night-rules',
            nightModeBotButtonText: 'Правила',
            nightModeOpenMessageEnabled: true,
          }),
          chat: {
            entityType: ChatEntityType.CHAT,
            rules: null,
          },
        }),
      );

      expect(maxClient.sendMessage).toHaveBeenCalledTimes(1);
      expect(maxClient.sendMessage).toHaveBeenCalledWith(
        'chat-1',
        nightModeNotice('23:00-08:00', 'Москва'),
        expect.objectContaining({
          textFormat: 'html',
        }),
        expect.objectContaining({
          trafficClass: 'background',
          actionHealthLane: 'background',
          sourceTag: 'night_mode_transition',
          botId: 'bot-1',
        }),
      );
      expect(maxClient.sendMessage.mock.calls[0]?.[2]).toEqual(
        expect.objectContaining({
          buttons: [
            [
              expect.objectContaining({
                text: '💬 Комментарии',
              }),
            ],
            [
              {
                text: 'Правила',
                url: 'https://max.ru/night-rules',
              },
            ],
          ],
        }),
      );
      expect(maxClient.deleteMessage).not.toHaveBeenCalled();
      expect(redisCounter.setStringWithTtl).toHaveBeenCalledWith(
        'night-mode-transition-state:v1:chat-1',
        expect.stringContaining('"closeNoticeMessageId":"night-close-1"'),
        expect.any(Number),
      );
      expect(prisma.moderationEvent.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          chatId: 'chat-1',
          messageId: 'night-close-1',
          ruleCode: 'NIGHT_MODE_CLOSE_NOTICE',
          action: SanctionAction.NONE,
        }),
      });
    } finally {
      jest.useRealTimers();
    }
  });

  it('records access loss and stops scheduling when the close notice chat is gone', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-05-30T20:00:15.000Z'));
    try {
      const prisma = {
        moderationEvent: {
          create: jest.fn(),
        },
      };
      const maxClient = {
        sendMessage: jest
          .fn()
          .mockRejectedValue(
            createMaxApiError(404, 'Request failed with status code 404', 'chat.not.found'),
          ),
        deleteMessage: jest.fn(),
      };
      const redisCounter = createRedisCounterMock();
      const maxBotLinkService = {
        resolveBotRoute: jest.fn().mockResolvedValue({ botId: 'bot-1' }),
      };
      const managedEntityAccessLossService = {
        recordManagedEntityAccessLost: jest.fn().mockResolvedValue(undefined),
      };
      const service = new ModerationService(
        prisma as never,
        {} as never,
        {} as never,
        maxClient as never,
        undefined,
        undefined,
        { get: jest.fn().mockReturnValue('bot-1') } as never,
        redisCounter as never,
        undefined,
        undefined,
        undefined,
        maxBotLinkService as never,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        managedEntityAccessLossService as never,
      );

      const result = await (service as any).processNightModeTransitionForChat(
        installNightModeSideEffectFence(prisma, {
          ...createSettings({
            nightModeEnabled: true,
            nightModeStartTimeMinutes: 23 * 60,
            nightModeEndTimeMinutes: 8 * 60,
            nightModeTimezone: 'Europe/Moscow',
            nightModeBotMessageEnabled: true,
          }),
          chat: {
            entityType: ChatEntityType.CHAT,
            rules: null,
          },
        }),
      );

      expect(maxClient.sendMessage).toHaveBeenCalledTimes(1);
      expect(maxClient.deleteMessage).not.toHaveBeenCalled();
      expect(prisma.moderationEvent.create).not.toHaveBeenCalled();
      expect(redisCounter.setStringWithTtl).not.toHaveBeenCalled();
      expect(result).toEqual({ shouldEnqueueNext: false, messageId: null, botId: null });
      expect(managedEntityAccessLossService.recordManagedEntityAccessLost).toHaveBeenCalledWith({
        chatId: 'chat-1',
        botId: 'bot-1',
        lifecycleEventAt: new Date('2026-05-30T20:00:15.000Z'),
        lifecycleEventType: 'live_probe',
        lifecycleSource: 'live_probe',
        reason: 'chat_not_found',
        source: 'night_mode_transition:send-close-notice',
        lastMaxErrorCode: 'chat.not.found',
        lastMaxErrorMessage: 'request failed with status code 404',
        lastMaxStatusCode: 404,
      });
    } finally {
      jest.useRealTimers();
    }
  });

  it('does not invent a late close notice without a close-boundary snapshot', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-05-30T20:40:00.000Z'));
    try {
      const prisma = {
        moderationEvent: {
          create: jest.fn(),
        },
      };
      const maxClient = {
        sendMessage: jest.fn(),
        deleteMessage: jest.fn(),
      };
      const redisCounter = createRedisCounterMock();
      const service = new ModerationService(
        prisma as never,
        {} as never,
        {} as never,
        maxClient as never,
        undefined,
        undefined,
        { get: jest.fn().mockReturnValue('bot-1') } as never,
        redisCounter as never,
      );

      await (service as any).processNightModeTransitionForChat({
        ...createSettings({
          nightModeEnabled: true,
          nightModeStartTimeMinutes: 23 * 60,
          nightModeEndTimeMinutes: 8 * 60,
          nightModeTimezone: 'Europe/Moscow',
          nightModeBotMessageEnabled: true,
        }),
        chat: {
          entityType: ChatEntityType.CHAT,
          rules: null,
        },
      });

      expect(maxClient.sendMessage).not.toHaveBeenCalled();
      expect(maxClient.deleteMessage).not.toHaveBeenCalled();
      expect(prisma.moderationEvent.create).not.toHaveBeenCalled();
      expect(redisCounter.setStringWithTtl).toHaveBeenCalledWith(
        'night-mode-transition-state:v1:chat-1',
        expect.stringContaining('"status":"closed"'),
        expect.any(Number),
      );
    } finally {
      jest.useRealTimers();
    }
  });

  it('ignores stale night mode transition jobs', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-05-30T20:00:15.000Z'));
    try {
      const prisma = {
        chatSettings: {
          findUnique: jest.fn().mockResolvedValue({
            ...createSettings({
              nightModeEnabled: true,
              nightModeStartTimeMinutes: 23 * 60,
              nightModeEndTimeMinutes: 8 * 60,
              nightModeTimezone: 'Europe/Moscow',
              nightModeBotMessageEnabled: true,
              nightModeOpenMessageEnabled: true,
            }),
            chat: {
              entityType: ChatEntityType.CHAT,
              rules: null,
            },
          }),
        },
        moderationEvent: {
          create: jest.fn(),
        },
      };
      const maxClient = {
        sendMessage: jest.fn(),
        deleteMessage: jest.fn(),
      };
      const redisCounter = createRedisCounterMock();
      const service = new ModerationService(
        prisma as never,
        {} as never,
        {} as never,
        maxClient as never,
        undefined,
        undefined,
        { get: jest.fn().mockReturnValue('bot-1') } as never,
        redisCounter as never,
      );

      await service.processNightModeTransitionJob({
        ...NIGHT_MODE_V4_JOB_METADATA,
        chatId: 'chat-1',
        transition: 'close',
        scheduledFor: '2026-05-30T20:00:00.000Z',
        sessionKey: 'v1:Europe/Moscow:23:00:08:00:2026-05-29',
      });

      expect(prisma.chatSettings.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({ where: { chatId: 'chat-1' } }),
      );
      expect(maxClient.sendMessage).not.toHaveBeenCalled();
      expect(maxClient.deleteMessage).not.toHaveBeenCalled();
      expect(prisma.moderationEvent.create).not.toHaveBeenCalled();
      expect(redisCounter.setStringWithTtl).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it('stops night mode transition jobs for channels', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-05-30T20:00:15.000Z'));
    try {
      const prisma = {
        chatSettings: {
          findUnique: jest.fn().mockResolvedValue({
            ...createSettings({
              chatId: 'channel-1',
              nightModeEnabled: true,
              nightModeStartTimeMinutes: 23 * 60,
              nightModeEndTimeMinutes: 8 * 60,
              nightModeTimezone: 'Europe/Moscow',
              nightModeBotMessageEnabled: true,
              nightModeOpenMessageEnabled: true,
            }),
            chat: {
              entityType: ChatEntityType.CHANNEL,
              rules: null,
            },
          }),
        },
        moderationEvent: {
          create: jest.fn(),
        },
      };
      const maxClient = {
        sendMessage: jest.fn(),
        deleteMessage: jest.fn(),
      };
      const redisCounter = createRedisCounterMock();
      const service = new ModerationService(
        prisma as never,
        {} as never,
        {} as never,
        maxClient as never,
        undefined,
        undefined,
        { get: jest.fn().mockReturnValue('bot-1') } as never,
        redisCounter as never,
      );

      await expect(
        service.processNightModeTransitionJob({
          ...NIGHT_MODE_V4_JOB_METADATA,
          chatId: 'channel-1',
          transition: 'close',
          scheduledFor: '2026-05-30T20:00:00.000Z',
          sessionKey: 'v1:Europe/Moscow:23:00:08:00:2026-05-30',
        }),
      ).resolves.toEqual({ shouldEnqueueNext: false });

      expect(prisma.chatSettings.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { chatId: 'channel-1' },
          include: {
            chat: {
              select: expect.objectContaining({
                entityType: true,
              }),
            },
          },
        }),
      );
      expect(maxClient.sendMessage).not.toHaveBeenCalled();
      expect(maxClient.deleteMessage).not.toHaveBeenCalled();
      expect(prisma.moderationEvent.create).not.toHaveBeenCalled();
      expect(redisCounter.setStringWithTtl).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it('sends the close notice when the close job runs after the boundary minute', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-05-30T20:12:10.000Z'));
    try {
      const prisma = {
        chatSettings: {
          findUnique: jest.fn().mockResolvedValue({
            ...createSettings({
              nightModeEnabled: true,
              nightModeStartTimeMinutes: 23 * 60,
              nightModeEndTimeMinutes: 8 * 60,
              nightModeTimezone: 'Europe/Moscow',
              nightModeBotMessageEnabled: true,
              nightModeBotMessageText: '',
              nightModeOpenMessageEnabled: true,
            }),
            chat: {
              entityType: ChatEntityType.CHAT,
              rules: null,
            },
          }),
        },
        moderationEvent: {
          create: jest.fn(),
        },
      };
      const maxClient = {
        sendMessage: jest.fn().mockResolvedValue({
          messageId: 'night-close-late-1',
          url: null,
        }),
        deleteMessage: jest.fn(),
      };
      const redisCounter = createRedisCounterMock();
      const maxBotLinkService = {
        resolveBotRoute: jest.fn().mockResolvedValue({ botId: 'bot-1' }),
      };
      const service = new ModerationService(
        prisma as never,
        {} as never,
        {} as never,
        maxClient as never,
        undefined,
        undefined,
        { get: jest.fn().mockReturnValue('bot-1') } as never,
        redisCounter as never,
        undefined,
        undefined,
        undefined,
        maxBotLinkService as never,
      );

      await service.processNightModeTransitionJob({
        ...NIGHT_MODE_V4_JOB_METADATA,
        chatId: 'chat-1',
        transition: 'close',
        scheduledFor: '2026-05-30T20:00:00.000Z',
        sessionKey: 'v1:Europe/Moscow:23:00:08:00:2026-05-30',
      });

      expect(maxClient.sendMessage).toHaveBeenCalledWith(
        'chat-1',
        nightModeNotice('23:00-08:00', 'Москва'),
        expect.objectContaining({
          textFormat: 'html',
        }),
        expect.objectContaining({
          trafficClass: 'background',
          actionHealthLane: 'background',
          sourceTag: 'night_mode_transition',
          botId: 'bot-1',
        }),
      );
      expect(prisma.moderationEvent.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          chatId: 'chat-1',
          messageId: 'night-close-late-1',
          ruleCode: 'NIGHT_MODE_CLOSE_NOTICE',
          action: SanctionAction.NONE,
        }),
      });
      expect(redisCounter.setStringWithTtl).toHaveBeenCalledWith(
        'night-mode-transition-state:v1:chat-1',
        expect.stringContaining('"closeNoticeMessageId":"night-close-late-1"'),
        expect.any(Number),
      );
    } finally {
      jest.useRealTimers();
    }
  });

  it('restores close notice state from persisted events instead of resending after Redis loss', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-05-30T20:12:10.000Z'));
    try {
      const prisma = {
        chatSettings: {
          findUnique: jest.fn().mockResolvedValue({
            ...createSettings({
              nightModeEnabled: true,
              nightModeStartTimeMinutes: 23 * 60,
              nightModeEndTimeMinutes: 8 * 60,
              nightModeTimezone: 'Europe/Moscow',
              nightModeBotMessageEnabled: true,
              nightModeBotMessageText: '',
              nightModeOpenMessageEnabled: true,
            }),
            chat: {
              entityType: ChatEntityType.CHAT,
              rules: null,
            },
          }),
        },
        moderationEvent: {
          findFirst: jest.fn().mockResolvedValue({
            messageId: 'night-close-existing-1',
          }),
          create: jest.fn(),
        },
      };
      const maxClient = {
        sendMessage: jest.fn(),
        deleteMessage: jest.fn(),
      };
      const redisCounter = createRedisCounterMock();
      const service = new ModerationService(
        prisma as never,
        {} as never,
        {} as never,
        maxClient as never,
        undefined,
        undefined,
        { get: jest.fn().mockReturnValue('bot-1') } as never,
        redisCounter as never,
      );

      await service.processNightModeTransitionJob({
        ...NIGHT_MODE_V4_JOB_METADATA,
        chatId: 'chat-1',
        transition: 'close',
        scheduledFor: '2026-05-30T20:00:00.000Z',
        sessionKey: 'v1:Europe/Moscow:23:00:08:00:2026-05-30',
      });

      expect(prisma.moderationEvent.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            chatId: 'chat-1',
            ruleCode: 'NIGHT_MODE_CLOSE_NOTICE',
            messageId: {
              not: null,
            },
            metadata: {
              path: ['sessionKey'],
              equals: 'v1:Europe/Moscow:23:00:08:00:2026-05-30',
            },
          }),
        }),
      );
      expect(maxClient.sendMessage).not.toHaveBeenCalled();
      expect(maxClient.deleteMessage).not.toHaveBeenCalled();
      expect(prisma.moderationEvent.create).not.toHaveBeenCalled();
      expect(redisCounter.setStringWithTtl).toHaveBeenCalledWith(
        'night-mode-transition-state:v1:chat-1',
        expect.stringContaining('"closeNoticeMessageId":"night-close-existing-1"'),
        expect.any(Number),
      );
    } finally {
      jest.useRealTimers();
    }
  });

  it('recovers three close-event failures at the open boundary and cleans up without resend', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-05-30T20:12:10.000Z'));
    try {
      const settings = {
        ...createSettings({
          nightModeEnabled: true,
          nightModeStartTimeMinutes: 23 * 60,
          nightModeEndTimeMinutes: 8 * 60,
          nightModeTimezone: 'Europe/Moscow',
          nightModeBotMessageEnabled: true,
          nightModeBotMessageText: '',
          nightModeOpenMessageEnabled: false,
        }),
        chat: {
          entityType: ChatEntityType.CHAT,
          rules: null,
        },
      };
      let persistedCloseEvent: {
        id: string;
        messageId: string;
        botId: string | null;
      } | null = null;
      let remainingCloseEventFailures = 3;
      const moderationEvent = {
        findFirst: jest.fn(async (query: { where?: { ruleCode?: unknown } }) =>
          query.where?.ruleCode === 'NIGHT_MODE_CLOSE_NOTICE' ? persistedCloseEvent : null,
        ),
        create: jest.fn(async (query: { data: Record<string, unknown> }) => {
          if (
            query.data.ruleCode === 'NIGHT_MODE_CLOSE_NOTICE' &&
            remainingCloseEventFailures > 0
          ) {
            remainingCloseEventFailures -= 1;
            throw new Error('database is temporarily unavailable');
          }
          const event = {
            id:
              query.data.ruleCode === 'NIGHT_MODE_CLOSE_NOTICE'
                ? 'night-close-event-recovered-1'
                : 'night-open-event-1',
            messageId: String(query.data.messageId),
            botId: typeof query.data.botId === 'string' ? query.data.botId : null,
          };
          if (query.data.ruleCode === 'NIGHT_MODE_CLOSE_NOTICE') {
            persistedCloseEvent = event;
          }
          return event;
        }),
      };
      const prisma = {
        chatSettings: {
          findUnique: jest.fn().mockResolvedValue(settings),
        },
        moderationEvent,
        $transaction: jest.fn(
          async (
            operation: (tx: {
              moderationEvent: typeof moderationEvent;
              $executeRaw: jest.Mock;
            }) => unknown,
          ) =>
            operation({
              moderationEvent,
              $executeRaw: jest.fn().mockResolvedValue(0),
            }),
        ),
      };
      const durableSends = new Map<string, { messageId: string; url: null }>();
      const maxHttpSendKeys: string[] = [];
      const maxClient = {
        sendMessage: jest.fn(
          async (
            _chatId: string,
            _text: string,
            _messageOptions: unknown,
            dispatchOptions: {
              idempotencyKey?: string | null;
              beforeImmediateSendMutation?: () => Promise<void>;
            },
          ) => {
            const idempotencyKey = dispatchOptions.idempotencyKey?.trim() ?? '';
            const recovered = durableSends.get(idempotencyKey);
            if (recovered) {
              return recovered;
            }
            await dispatchOptions.beforeImmediateSendMutation?.();
            const sent = {
              messageId: idempotencyKey.includes(':close:')
                ? 'night-close-accepted-1'
                : 'night-open-1',
              url: null,
            } as const;
            durableSends.set(idempotencyKey, sent);
            maxHttpSendKeys.push(idempotencyKey);
            return sent;
          },
        ),
        deleteMessage: jest.fn(
          async (
            _chatId: string,
            _messageId: string,
            options: { beforeImmediateDeleteMutation?: () => Promise<void> },
          ) => {
            await options.beforeImmediateDeleteMutation?.();
          },
        ),
      };
      const redisCounter = createRedisCounterMock();
      const maxBotLinkService = {
        resolveBotRoute: jest.fn().mockResolvedValue({ botId: 'bot-1' }),
      };
      const maxActionLedgerService = {
        inspectCompletedNightModeCloseNoticeDispatch: jest
          .fn<
            ReturnType<MaxActionLedgerService['inspectCompletedNightModeCloseNoticeDispatch']>,
            Parameters<MaxActionLedgerService['inspectCompletedNightModeCloseNoticeDispatch']>
          >()
          .mockResolvedValue({
            kind: 'missing',
            jobId: 'night-mode:close:chat-1:session:v1:Europe/Moscow:23:00:08:00:2026-05-30',
          }),
        getExactCompletedNightModeCloseNoticeDispatch: jest
          .fn<
            ReturnType<MaxActionLedgerService['getExactCompletedNightModeCloseNoticeDispatch']>,
            Parameters<MaxActionLedgerService['getExactCompletedNightModeCloseNoticeDispatch']>
          >()
          .mockResolvedValue({
            jobId: 'night-mode:close:chat-1:session:v1:Europe/Moscow:23:00:08:00:2026-05-30',
            remoteMessageId: 'night-close-accepted-1',
            dispatchBotId: 'bot-1',
            completedAt: new Date('2026-05-30T20:12:10.000Z'),
            routeHalfOpenProbe: false,
            stickyRouteHalfOpenProbe: false,
          }),
      } satisfies Pick<
        MaxActionLedgerService,
        | 'inspectCompletedNightModeCloseNoticeDispatch'
        | 'getExactCompletedNightModeCloseNoticeDispatch'
      >;
      const service = new ModerationService(
        prisma as never,
        {} as never,
        {} as never,
        maxClient as never,
        undefined,
        undefined,
        { get: jest.fn().mockReturnValue('bot-1') } as never,
        redisCounter as never,
        undefined,
        undefined,
        undefined,
        maxBotLinkService as never,
      );
      (service as any).maxActionLedgerService = maxActionLedgerService;
      const recovery = installNightModeRecoveryFixture(service);
      const closeJob = {
        ...NIGHT_MODE_V4_JOB_METADATA,
        chatId: 'chat-1',
        transition: 'close' as const,
        scheduledFor: '2026-05-30T20:00:00.000Z',
        sessionKey: 'v1:Europe/Moscow:23:00:08:00:2026-05-30',
      };

      await expect(service.processNightModeTransitionJob(closeJob)).rejects.toThrow(
        'event persistence failed',
      );
      const stateKey = 'night-mode-transition-state:v1:chat-1';
      expect(JSON.parse(redisCounter.stringCache.get(stateKey) ?? '{}')).toMatchObject({
        status: 'closed',
        closeNoticeMessageId: 'night-close-accepted-1',
        closeNoticeEventRecovery: {
          version: 2,
          pending: true,
          timezone: 'Europe/Moscow',
          startMinutes: 23 * 60,
          endMinutes: 8 * 60,
        },
      });
      expect(maxHttpSendKeys).toEqual([
        'night-mode:close:chat-1:session:v1:Europe/Moscow:23:00:08:00:2026-05-30',
      ]);

      await expect(service.processNightModeTransitionJob(closeJob)).rejects.toThrow(
        'database is temporarily unavailable',
      );
      await expect(service.processNightModeTransitionJob(closeJob)).rejects.toThrow(
        'database is temporarily unavailable',
      );
      expect(maxClient.sendMessage).toHaveBeenCalledTimes(1);
      expect(maxHttpSendKeys).toHaveLength(1);
      expect(moderationEvent.create).toHaveBeenCalledTimes(3);
      expect(JSON.parse(redisCounter.stringCache.get(stateKey) ?? '{}')).toHaveProperty(
        'closeNoticeEventRecovery.pending',
        true,
      );

      jest.setSystemTime(new Date('2026-05-31T05:00:10.000Z'));
      await expect(
        service.processNightModeTransitionJob({
          ...NIGHT_MODE_V4_JOB_METADATA,
          chatId: 'chat-1',
          transition: 'open',
          scheduledFor: '2026-05-31T05:00:00.000Z',
          sessionKey: closeJob.sessionKey,
        }),
      ).resolves.toEqual({ shouldEnqueueNext: true });

      expect(maxClient.deleteMessage).not.toHaveBeenCalled();
      expect(moderationEvent.create).toHaveBeenCalledTimes(3);
      maxActionLedgerService.inspectCompletedNightModeCloseNoticeDispatch.mockResolvedValue({
        kind: 'completed',
        jobId: 'night-mode:close:chat-1:session:v1:Europe/Moscow:23:00:08:00:2026-05-30',
        remoteMessageId: 'night-close-accepted-1',
        dispatchBotId: 'bot-1',
        completedAt: new Date('2026-05-30T20:12:10.000Z'),
        routeHalfOpenProbe: false,
        stickyRouteHalfOpenProbe: false,
      });
      await expect(recovery.processCleanup()).resolves.toEqual({ shouldEnqueueNext: true });

      expect(maxClient.deleteMessage).toHaveBeenCalledWith(
        'chat-1',
        'night-close-accepted-1',
        expect.objectContaining({ immediate: true, botId: 'bot-1' }),
      );
      expect(maxClient.sendMessage).toHaveBeenCalledTimes(1);
      expect(moderationEvent.create).toHaveBeenCalledTimes(4);
      expect(
        maxActionLedgerService.getExactCompletedNightModeCloseNoticeDispatch,
      ).toHaveBeenCalledTimes(2);
      expect(
        maxActionLedgerService.getExactCompletedNightModeCloseNoticeDispatch,
      ).toHaveBeenLastCalledWith({
        chatId: 'chat-1',
        sessionKey: closeJob.sessionKey,
        messageId: 'night-close-accepted-1',
        dispatchBotId: 'bot-1',
      });
      expect(moderationEvent.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            chatId: 'chat-1',
            ruleCode: 'NIGHT_MODE_CLOSE_NOTICE',
            messageId: 'night-close-accepted-1',
            botId: 'bot-1',
            metadata: {
              path: ['sessionKey'],
              equals: closeJob.sessionKey,
            },
          }),
        }),
      );
      expect(maxHttpSendKeys).toEqual([
        'night-mode:close:chat-1:session:v1:Europe/Moscow:23:00:08:00:2026-05-30',
      ]);
      expect(JSON.parse(redisCounter.stringCache.get(stateKey) ?? '{}')).toMatchObject({
        status: 'open',
        sessionKey: closeJob.sessionKey,
      });
      expect(JSON.parse(redisCounter.stringCache.get(stateKey) ?? '{}')).not.toHaveProperty(
        'closeNoticeEventRecovery',
      );
    } finally {
      jest.useRealTimers();
    }
  });

  it('repairs a closed transition state that missed its close notice', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-05-30T20:12:10.000Z'));
    try {
      const prisma = {
        chatSettings: {
          findUnique: jest.fn().mockResolvedValue({
            ...createSettings({
              nightModeEnabled: true,
              nightModeStartTimeMinutes: 23 * 60,
              nightModeEndTimeMinutes: 8 * 60,
              nightModeTimezone: 'Europe/Moscow',
              nightModeBotMessageEnabled: true,
              nightModeBotMessageText: '',
              nightModeOpenMessageEnabled: true,
            }),
            chat: {
              entityType: ChatEntityType.CHAT,
              rules: null,
            },
          }),
        },
        moderationEvent: {
          create: jest.fn(),
        },
      };
      const maxClient = {
        sendMessage: jest.fn().mockResolvedValue({
          messageId: 'night-close-repair-1',
          url: null,
        }),
        deleteMessage: jest.fn(),
      };
      const redisCounter = createRedisCounterMock();
      redisCounter.stringCache.set(
        'night-mode-transition-state:v1:chat-1',
        JSON.stringify({
          status: 'closed',
          sessionKey: 'v1:Europe/Moscow:23:00:08:00:2026-05-30',
          closeNoticeMessageId: null,
        }),
      );
      const maxBotLinkService = {
        resolveBotRoute: jest.fn().mockResolvedValue({ botId: 'bot-1' }),
      };
      const service = new ModerationService(
        prisma as never,
        {} as never,
        {} as never,
        maxClient as never,
        undefined,
        undefined,
        { get: jest.fn().mockReturnValue('bot-1') } as never,
        redisCounter as never,
        undefined,
        undefined,
        undefined,
        maxBotLinkService as never,
      );

      await service.processNightModeTransitionJob({
        ...NIGHT_MODE_V4_JOB_METADATA,
        chatId: 'chat-1',
        transition: 'close',
        scheduledFor: '2026-05-30T20:00:00.000Z',
        sessionKey: 'v1:Europe/Moscow:23:00:08:00:2026-05-30',
      });

      expect(maxClient.sendMessage).toHaveBeenCalledWith(
        'chat-1',
        nightModeNotice('23:00-08:00', 'Москва'),
        expect.objectContaining({
          textFormat: 'html',
        }),
        expect.objectContaining({
          trafficClass: 'background',
          actionHealthLane: 'background',
          sourceTag: 'night_mode_transition',
          botId: 'bot-1',
        }),
      );
      expect(redisCounter.setStringWithTtl).toHaveBeenCalledWith(
        'night-mode-transition-state:v1:chat-1',
        expect.stringContaining('"closeNoticeMessageId":"night-close-repair-1"'),
        expect.any(Number),
      );
    } finally {
      jest.useRealTimers();
    }
  });

  it('sends the open notice and separately cleans up when the open job runs late', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-05-31T05:12:10.000Z'));
    try {
      const prisma = {
        chatSettings: {
          findUnique: jest.fn().mockResolvedValue({
            ...createSettings({
              nightModeEnabled: true,
              nightModeStartTimeMinutes: 23 * 60,
              nightModeEndTimeMinutes: 8 * 60,
              nightModeTimezone: 'Europe/Moscow',
              nightModeBotMessageEnabled: true,
              nightModeOpenMessageEnabled: true,
              nightModeOpenMessageText: '',
            }),
            chat: {
              entityType: ChatEntityType.CHAT,
              rules: null,
            },
          }),
        },
        moderationEvent: createNightModeOpenEventStore(),
      };
      const maxClient = {
        sendMessage: jest.fn().mockResolvedValue({
          messageId: 'night-open-1',
          url: null,
        }),
        deleteMessage: jest.fn(),
      };
      const redisCounter = createRedisCounterMock();
      redisCounter.stringCache.set(
        'night-mode-transition-state:v1:chat-1',
        JSON.stringify({
          status: 'closed',
          sessionKey: 'v1:Europe/Moscow:23:00:08:00:2026-05-30',
          closeNoticeMessageId: 'night-close-1',
        }),
      );
      const maxBotLinkService = {
        resolveBotRoute: jest.fn().mockResolvedValue({ botId: 'bot-1' }),
      };
      const service = new ModerationService(
        prisma as never,
        {} as never,
        {} as never,
        maxClient as never,
        undefined,
        undefined,
        { get: jest.fn().mockReturnValue('bot-1') } as never,
        redisCounter as never,
        undefined,
        undefined,
        undefined,
        maxBotLinkService as never,
      );
      const recovery = installNightModeRecoveryFixture(service);

      await service.processNightModeTransitionJob({
        ...NIGHT_MODE_V4_JOB_METADATA,
        chatId: 'chat-1',
        transition: 'open',
        scheduledFor: '2026-05-31T05:00:00.000Z',
        sessionKey: 'v1:Europe/Moscow:23:00:08:00:2026-05-30',
      });

      expect(maxClient.deleteMessage).not.toHaveBeenCalled();
      await recovery.processCleanup();
      expect(maxClient.deleteMessage).toHaveBeenCalledWith(
        'chat-1',
        'night-close-1',
        expect.objectContaining({
          immediate: true,
          trafficClass: 'background',
          actionHealthLane: 'background',
          sourceTag: 'night_mode_transition',
          botId: 'bot-1',
        }),
      );
      expect(maxClient.sendMessage).toHaveBeenCalledWith(
        'chat-1',
        nightModeOpenNotice(),
        expect.objectContaining({
          textFormat: 'html',
        }),
        expect.objectContaining({
          trafficClass: 'background',
          actionHealthLane: 'background',
          sourceTag: 'night_mode_transition',
          botId: 'bot-1',
        }),
      );
      expect(prisma.moderationEvent.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          chatId: 'chat-1',
          messageId: 'night-open-1',
          ruleCode: 'NIGHT_MODE_OPEN_NOTICE',
          action: SanctionAction.NONE,
        }),
      });
      expect(redisCounter.setStringWithTtl).toHaveBeenLastCalledWith(
        'night-mode-transition-state:v1:chat-1',
        expect.stringContaining('"status":"open"'),
        expect.any(Number),
      );
    } finally {
      jest.useRealTimers();
    }
  });

  it('records access loss and stops scheduling when the open notice chat is gone', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-05-31T05:00:10.000Z'));
    try {
      const prisma = {
        moderationEvent: createNightModeOpenEventStore(),
      };
      const maxClient = {
        sendMessage: jest
          .fn()
          .mockRejectedValue(
            createMaxApiError(403, 'Request failed with status code 403', 'chat.denied'),
          ),
        deleteMessage: jest.fn(),
      };
      const redisCounter = createRedisCounterMock();
      redisCounter.stringCache.set(
        'night-mode-transition-state:v1:chat-1',
        JSON.stringify({
          status: 'closed',
          sessionKey: 'v1:Europe/Moscow:23:00:08:00:2026-05-30',
          closeNoticeMessageId: 'night-close-1',
        }),
      );
      const maxBotLinkService = {
        resolveBotRoute: jest.fn().mockResolvedValue({ botId: 'bot-1' }),
      };
      const managedEntityAccessLossService = {
        recordManagedEntityAccessLost: jest.fn().mockResolvedValue(undefined),
      };
      const service = new ModerationService(
        prisma as never,
        {} as never,
        {} as never,
        maxClient as never,
        undefined,
        undefined,
        { get: jest.fn().mockReturnValue('bot-1') } as never,
        redisCounter as never,
        undefined,
        undefined,
        undefined,
        maxBotLinkService as never,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        managedEntityAccessLossService as never,
      );
      const recovery = installNightModeRecoveryFixture(service);

      const result = await (service as any).processNightModeTransitionForChat(
        installNightModeSideEffectFence(prisma, {
          ...createSettings({
            nightModeEnabled: true,
            nightModeStartTimeMinutes: 23 * 60,
            nightModeEndTimeMinutes: 8 * 60,
            nightModeTimezone: 'Europe/Moscow',
            nightModeBotMessageEnabled: true,
            nightModeOpenMessageEnabled: true,
            nightModeOpenMessageText: '',
          }),
          chat: {
            entityType: ChatEntityType.CHAT,
            rules: null,
          },
        }),
      );

      expect(maxClient.deleteMessage).not.toHaveBeenCalled();
      expect(recovery.scheduler.scheduleRecoveryObligation).toHaveBeenCalledTimes(1);
      expect(maxClient.sendMessage).toHaveBeenCalledTimes(1);
      expect(prisma.moderationEvent.create).not.toHaveBeenCalled();
      expect(redisCounter.setStringWithTtl).not.toHaveBeenCalled();
      expect(result).toEqual({ shouldEnqueueNext: false });
      expect(managedEntityAccessLossService.recordManagedEntityAccessLost).toHaveBeenCalledWith({
        chatId: 'chat-1',
        botId: 'bot-1',
        lifecycleEventAt: new Date('2026-05-31T05:00:10.000Z'),
        lifecycleEventType: 'live_probe',
        lifecycleSource: 'live_probe',
        reason: 'bot_denied',
        source: 'night_mode_transition:send-open-notice',
        lastMaxErrorCode: 'chat.denied',
        lastMaxErrorMessage: 'request failed with status code 403',
        lastMaxStatusCode: 403,
      });
    } finally {
      jest.useRealTimers();
    }
  });

  it('opens independently while separate close-notice cleanup retries a permission error', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-05-31T05:00:10.000Z'));
    try {
      const prisma = {
        moderationEvent: createNightModeOpenEventStore(),
      };
      const maxClient = {
        sendMessage: jest.fn().mockResolvedValue({
          messageId: 'night-open-1',
          url: null,
        }),
        deleteMessage: jest
          .fn()
          .mockRejectedValue(createMaxApiError(400, 'User is not an admin', 'user.not.admin')),
      };
      const redisCounter = createRedisCounterMock();
      redisCounter.stringCache.set(
        'night-mode-transition-state:v1:chat-1',
        JSON.stringify({
          status: 'closed',
          sessionKey: 'v1:Europe/Moscow:23:00:08:00:2026-05-30',
          closeNoticeMessageId: 'night-close-1',
        }),
      );
      const service = new ModerationService(
        prisma as never,
        {} as never,
        {} as never,
        maxClient as never,
        undefined,
        undefined,
        { get: jest.fn().mockReturnValue('bot-1') } as never,
        redisCounter as never,
      );
      const recovery = installNightModeRecoveryFixture(service);

      await expect(
        (service as any).processNightModeTransitionForChat(
          installNightModeSideEffectFence(prisma, {
            ...createSettings({
              nightModeEnabled: true,
              nightModeStartTimeMinutes: 23 * 60,
              nightModeEndTimeMinutes: 8 * 60,
              nightModeTimezone: 'Europe/Moscow',
              nightModeBotMessageEnabled: true,
              nightModeOpenMessageEnabled: true,
              nightModeOpenMessageText: '',
            }),
            chat: {
              entityType: ChatEntityType.CHAT,
              rules: null,
            },
          }),
        ),
      ).resolves.toEqual({ shouldEnqueueNext: true });

      expect(maxClient.deleteMessage).not.toHaveBeenCalled();
      expect(maxClient.sendMessage).toHaveBeenCalledTimes(1);
      await expect(recovery.processCleanup()).rejects.toThrow('User is not an admin');
      expect(maxClient.deleteMessage).toHaveBeenCalledTimes(1);
      expect(maxClient.sendMessage).toHaveBeenCalledTimes(1);
      expect(prisma.moderationEvent.create).toHaveBeenCalledTimes(1);
      expect(redisCounter.stringCache.get('night-mode-transition-state:v1:chat-1')).toContain(
        '"status":"open"',
      );
    } finally {
      jest.useRealTimers();
    }
  });

  it('sends the open notice before separate close-notice cleanup from the schedule transition', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-05-31T05:00:10.000Z'));
    try {
      const prisma = {
        moderationEvent: createNightModeOpenEventStore(),
      };
      const maxClient = {
        sendMessage: jest.fn().mockResolvedValue({
          messageId: 'night-open-1',
          url: null,
        }),
        deleteMessage: jest.fn(),
      };
      const redisCounter = createRedisCounterMock();
      redisCounter.stringCache.set(
        'night-mode-transition-state:v1:chat-1',
        JSON.stringify({
          status: 'closed',
          sessionKey: 'v1:Europe/Moscow:23:00:08:00:2026-05-30',
          closeNoticeMessageId: 'night-close-1',
        }),
      );
      const maxBotLinkService = {
        resolveBotRoute: jest.fn().mockResolvedValue({ botId: 'bot-1' }),
      };
      const service = new ModerationService(
        prisma as never,
        {} as never,
        {} as never,
        maxClient as never,
        undefined,
        undefined,
        { get: jest.fn().mockReturnValue('bot-1') } as never,
        redisCounter as never,
        undefined,
        undefined,
        undefined,
        maxBotLinkService as never,
      );
      const recovery = installNightModeRecoveryFixture(service);

      await (service as any).processNightModeTransitionForChat(
        installNightModeSideEffectFence(prisma, {
          ...createSettings({
            nightModeEnabled: true,
            nightModeStartTimeMinutes: 23 * 60,
            nightModeEndTimeMinutes: 8 * 60,
            nightModeTimezone: 'Europe/Moscow',
            nightModeBotMessageEnabled: true,
            nightModeOpenMessageEnabled: true,
            nightModeOpenMessageText: '',
          }),
          chat: {
            entityType: ChatEntityType.CHAT,
            rules: null,
          },
        }),
      );

      expect(maxClient.deleteMessage).not.toHaveBeenCalled();
      await recovery.processCleanup();
      expect(maxClient.deleteMessage).toHaveBeenCalledWith(
        'chat-1',
        'night-close-1',
        expect.objectContaining({
          immediate: true,
          trafficClass: 'background',
          actionHealthLane: 'background',
          sourceTag: 'night_mode_transition',
          botId: 'bot-1',
        }),
      );
      expect(maxClient.sendMessage).toHaveBeenCalledWith(
        'chat-1',
        nightModeOpenNotice(),
        expect.objectContaining({
          textFormat: 'html',
        }),
        expect.objectContaining({
          trafficClass: 'background',
          actionHealthLane: 'background',
          sourceTag: 'night_mode_transition',
          botId: 'bot-1',
        }),
      );
      expect(maxClient.sendMessage.mock.invocationCallOrder[0]).toBeLessThan(
        maxClient.deleteMessage.mock.invocationCallOrder[0],
      );
      expect(prisma.moderationEvent.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          chatId: 'chat-1',
          messageId: 'night-open-1',
          ruleCode: 'NIGHT_MODE_OPEN_NOTICE',
          action: SanctionAction.NONE,
        }),
      });
      expect(redisCounter.setStringWithTtl).toHaveBeenLastCalledWith(
        'night-mode-transition-state:v1:chat-1',
        expect.stringContaining('"status":"open"'),
        expect.any(Number),
      );
    } finally {
      jest.useRealTimers();
    }
  });

  it('deletes messages during manual group close silently', async () => {
    const settings = createSettings({
      nightModeForceCloseEnabled: true,
      nightModeForceCloseForever: false,
      nightModeForceCloseDays: 0,
      nightModeForceCloseHours: 4,
      nightModeForceCloseUntil: new Date(Date.now() + 4 * 60 * 60 * 1_000).toISOString(),
    });
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings,
          domains: [],
          admins: [],
        }),
      },
      violation: {
        create: jest.fn(),
      },
      moderationEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
      webhookEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };
    const ruleEngine = {
      detect: jest.fn(),
    };
    const sanctionService = {
      resolveAction: jest.fn(),
    };
    const maxClient = {
      deleteMessage: jest.fn(),
      sendMessage: jest.fn(),
      kickMember: jest.fn(),
      banMember: jest.fn(),
      notifyModerators: jest.fn(),
      getChatMembersAccess: jest.fn().mockResolvedValue(
        new Map([
          [
            'user-1',
            {
              userId: 'user-1',
              isAdmin: false,
              isOwner: false,
              permissions: [],
            },
          ],
        ]),
      ),
    };

    const service = new ModerationService(
      prisma as never,
      ruleEngine as never,
      sanctionService as never,
      maxClient as never,
    );

    const update = createUpdate();
    const closed = installClosedChatDeleteFixture(service, settings, update);
    await service.handleUpdate(update);

    expect(closed.remoteDelete).toHaveBeenCalledTimes(1);
    expect(closed.access).toHaveBeenCalledWith(
      'chat-1',
      'user-1',
      expect.objectContaining({ botId: 'closed-chat-fixture-bot', bypassCache: true }),
    );
    expect(closed.source).toHaveBeenCalledWith(
      'chat-1',
      'msg-1',
      expect.objectContaining({ botId: 'closed-chat-fixture-bot', bypassCache: true }),
    );

    expect(ruleEngine.detect).not.toHaveBeenCalled();
    expect(maxClient.getChatMembersAccess).not.toHaveBeenCalled();
    expectImmediateDeleteMessage(maxClient.deleteMessage, 'chat-1', 'msg-1');
    expect(prisma.moderationEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        chatId: 'chat-1',
        userId: 'user-1',
        messageId: 'msg-1',
        ruleCode: 'MANUAL_GROUP_CLOSE_DELETE',
        action: SanctionAction.DELETE_MESSAGE,
      }),
    });
  });

  it('keeps manual group close deletion on the hot path when local allowlist is stale', async () => {
    const settings = createSettings({
      nightModeForceCloseEnabled: true,
      nightModeForceCloseForever: true,
    });
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings,
          domains: [],
          admins: [{ userId: 'admin-1' }],
        }),
      },
      violation: {
        create: jest.fn(),
      },
      moderationEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
      webhookEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };
    const ruleEngine = {
      detect: jest.fn(),
    };
    const sanctionService = {
      resolveAction: jest.fn(),
    };
    const maxClient = {
      deleteMessage: jest.fn(),
      sendMessage: jest.fn(),
      kickMember: jest.fn(),
      banMember: jest.fn(),
      notifyModerators: jest.fn(),
      getChatMembersAccess: jest.fn().mockResolvedValue(
        new Map([
          [
            'user-1',
            {
              userId: 'user-1',
              isAdmin: false,
              isOwner: false,
              permissions: [],
            },
          ],
        ]),
      ),
      getCurrentChatMemberAccess: jest.fn(),
    };

    const service = new ModerationService(
      prisma as never,
      ruleEngine as never,
      sanctionService as never,
      maxClient as never,
    );

    const update = createUpdate();
    const closed = installClosedChatDeleteFixture(service, settings, update);
    await service.handleUpdate(update);

    expect(closed.remoteDelete).toHaveBeenCalledTimes(1);
    expect(closed.access).toHaveBeenCalledWith(
      'chat-1',
      'user-1',
      expect.objectContaining({ botId: 'closed-chat-fixture-bot', bypassCache: true }),
    );
    expect(closed.source).toHaveBeenCalledWith(
      'chat-1',
      'msg-1',
      expect.objectContaining({ botId: 'closed-chat-fixture-bot', bypassCache: true }),
    );

    expect(maxClient.getChatMembersAccess).not.toHaveBeenCalled();
    expect(maxClient.getCurrentChatMemberAccess).not.toHaveBeenCalled();
    expectImmediateDeleteMessage(maxClient.deleteMessage, 'chat-1', 'msg-1');
  });

  it('keeps manual close deletion in degrade mode without live admin lookup', async () => {
    const settings = createSettings({
      nightModeForceCloseEnabled: true,
      nightModeForceCloseForever: true,
    });
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings,
          domains: [],
          admins: [],
        }),
      },
      violation: {
        create: jest.fn(),
      },
      moderationEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
      webhookEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };
    const ruleEngine = {
      detect: jest.fn(),
    };
    const sanctionService = {
      resolveAction: jest.fn(),
    };
    const maxClient = {
      deleteMessage: jest.fn(),
      sendMessage: jest.fn(),
      kickMember: jest.fn(),
      banMember: jest.fn(),
      notifyModerators: jest.fn(),
      getChatMembersAccess: jest.fn(),
      getCurrentChatMemberAccess: jest.fn(),
    };
    const systemModeService = {
      getSnapshot: jest.fn().mockReturnValue({
        mode: 'degrade',
        source: 'auto',
        reason: 'queue lag',
        updatedAt: new Date().toISOString(),
        manualMode: null,
        queueLagSec: 45,
        action: {
          windowSec: 60,
          total: 100,
          success: 96,
          failure: 4,
          critical: 0,
          errorRate: 0.04,
          criticalRate: 0,
        },
      }),
    };

    const service = new ModerationService(
      prisma as never,
      ruleEngine as never,
      sanctionService as never,
      maxClient as never,
      undefined,
      systemModeService as never,
    );

    const update = createUpdate();
    const closed = installClosedChatDeleteFixture(service, settings, update);
    await service.handleUpdate(update);

    expect(closed.remoteDelete).toHaveBeenCalledTimes(1);
    expect(closed.access).toHaveBeenCalledWith(
      'chat-1',
      'user-1',
      expect.objectContaining({ botId: 'closed-chat-fixture-bot', bypassCache: true }),
    );
    expect(closed.source).toHaveBeenCalledWith(
      'chat-1',
      'msg-1',
      expect.objectContaining({ botId: 'closed-chat-fixture-bot', bypassCache: true }),
    );

    expect(maxClient.getChatMembersAccess).not.toHaveBeenCalled();
    expect(maxClient.getCurrentChatMemberAccess).not.toHaveBeenCalled();
    expectImmediateDeleteMessage(maxClient.deleteMessage, 'chat-1', 'msg-1');
    expect(prisma.moderationEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        chatId: 'chat-1',
        userId: 'user-1',
        messageId: 'msg-1',
        ruleCode: 'MANUAL_GROUP_CLOSE_DELETE',
        action: SanctionAction.DELETE_MESSAGE,
      }),
    });
  });

  it('keeps local profanity and commercial filters enabled in degrade mode', () => {
    const service = new ModerationService({} as never, {} as never, {} as never, {} as never);
    const settings = createSettings({
      russianProfanityFilterEnabled: true,
      commercialAdsFilterEnabled: true,
    });

    const effectiveSettings = (
      service as unknown as {
        applyDegradeSettings: (value: typeof settings, degradeMode: boolean) => typeof settings;
      }
    ).applyDegradeSettings(settings, true);

    expect(effectiveSettings).toBe(settings);
    expect(effectiveSettings).toEqual(
      expect.objectContaining({
        russianProfanityFilterEnabled: true,
        commercialAdsFilterEnabled: true,
      }),
    );
  });

  it('does not apply night mode deletion to chat admins', async () => {
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings({
            nightModeEnabled: true,
            nightModeStartTimeMinutes: 0,
            nightModeEndTimeMinutes: 0,
            nightModeBotMessageEnabled: true,
          }),
          domains: [],
          admins: [{ userId: 'user-1' }],
        }),
      },
      violation: {
        create: jest.fn(),
      },
      moderationEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
      webhookEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };
    const ruleEngine = {
      detect: jest.fn().mockResolvedValue({
        violations: [],
      }),
    };
    const sanctionService = {
      resolveAction: jest.fn(),
    };
    const maxClient = {
      deleteMessage: jest.fn(),
      getChatAdminIds: jest.fn(),
      sendMessage: jest.fn(),
      kickMember: jest.fn(),
      banMember: jest.fn(),
      notifyModerators: jest.fn(),
    };

    const service = new ModerationService(
      prisma as never,
      ruleEngine as never,
      sanctionService as never,
      maxClient as never,
    );

    await service.handleUpdate(createUpdate());

    expect(ruleEngine.detect).not.toHaveBeenCalled();
    expect(prisma.violation.create).not.toHaveBeenCalled();
    expect(prisma.moderationEvent.findFirst).not.toHaveBeenCalled();
    expect(prisma.moderationEvent.create).not.toHaveBeenCalled();
    expect(maxClient.deleteMessage).not.toHaveBeenCalled();
    expect(maxClient.getChatAdminIds).not.toHaveBeenCalled();
    expect(maxClient.sendMessage).not.toHaveBeenCalled();
    expect(maxClient.kickMember).not.toHaveBeenCalled();
    expect(maxClient.banMember).not.toHaveBeenCalled();
  });

  it('does not apply manual close deletion to cached remote chat admins when local allowlist is stale', async () => {
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings({
            nightModeForceCloseEnabled: true,
            nightModeForceCloseForever: true,
          }),
          domains: [],
          admins: [{ userId: 'existing-admin' }],
        }),
      },
      violation: {
        create: jest.fn(),
      },
      moderationEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
      webhookEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };
    const ruleEngine = {
      detect: jest.fn().mockResolvedValue({
        violations: [],
      }),
    };
    const sanctionService = {
      resolveAction: jest.fn(),
    };
    const maxClient = {
      deleteMessage: jest.fn(),
      getChatMembersAccess: jest.fn(),
      sendMessage: jest.fn(),
      kickMember: jest.fn(),
      banMember: jest.fn(),
      notifyModerators: jest.fn(),
    };
    const chatContextCache = {
      getChatContext: jest.fn().mockResolvedValue({
        chatId: 'chat-1',
        title: 'Chat 1',
        settings: createSettings({
          nightModeForceCloseEnabled: true,
          nightModeForceCloseForever: true,
        }),
        domainAllowlist: [],
        adminUserIds: ['existing-admin'],
        rulesPublishedUrl: null,
        rulesPublishedMessageId: null,
      }),
      getAdminAccess: jest.fn().mockResolvedValue('granted'),
    };

    const service = new ModerationService(
      prisma as never,
      ruleEngine as never,
      sanctionService as never,
      maxClient as never,
      chatContextCache as never,
    );

    await service.handleUpdate(createUpdate());

    expect(chatContextCache.getAdminAccess).toHaveBeenCalled();
    expect(maxClient.getChatMembersAccess).not.toHaveBeenCalled();
    expect(ruleEngine.detect).not.toHaveBeenCalled();
    expect(prisma.violation.create).not.toHaveBeenCalled();
    expect(prisma.moderationEvent.create).not.toHaveBeenCalled();
    expect(maxClient.deleteMessage).not.toHaveBeenCalled();
    expect(maxClient.sendMessage).not.toHaveBeenCalled();
    expect(maxClient.kickMember).not.toHaveBeenCalled();
    expect(maxClient.banMember).not.toHaveBeenCalled();
  });

  it('deletes during manual close without waiting for remote admin access and schedules roster refresh', async () => {
    const settings = createSettings({
      nightModeForceCloseEnabled: true,
      nightModeForceCloseForever: true,
    });
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings,
          domains: [],
          admins: [{ userId: 'existing-admin' }],
        }),
      },
      violation: {
        create: jest.fn(),
      },
      moderationEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
      webhookEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };
    const ruleEngine = {
      detect: jest.fn().mockResolvedValue({
        violations: [],
      }),
    };
    const sanctionService = {
      resolveAction: jest.fn(),
    };
    const maxClient = {
      deleteMessage: jest.fn(),
      getChatMembersAccess: jest.fn(),
      sendMessage: jest.fn(),
      kickMember: jest.fn(),
      banMember: jest.fn(),
      notifyModerators: jest.fn(),
    };
    const maxChatAdminRosterSyncService = {
      scheduleChatAdminRosterSync: jest.fn().mockResolvedValue(true),
    };

    const service = new ModerationService(
      prisma as never,
      ruleEngine as never,
      sanctionService as never,
      maxClient as never,
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
      undefined,
      undefined,
      maxChatAdminRosterSyncService as never,
    );

    const update = createUpdate();
    const closed = installClosedChatDeleteFixture(service, settings, update);
    await service.handleUpdate(update);

    expect(closed.remoteDelete).toHaveBeenCalledTimes(1);
    expect(closed.access).toHaveBeenCalledWith(
      'chat-1',
      'user-1',
      expect.objectContaining({ botId: 'closed-chat-fixture-bot', bypassCache: true }),
    );
    expect(closed.source).toHaveBeenCalledWith(
      'chat-1',
      'msg-1',
      expect.objectContaining({ botId: 'closed-chat-fixture-bot', bypassCache: true }),
    );

    expect(maxClient.getChatMembersAccess).not.toHaveBeenCalled();
    expect(maxChatAdminRosterSyncService.scheduleChatAdminRosterSync).toHaveBeenCalledWith({
      chatId: 'chat-1',
      botIds: [],
      title: null,
      entityType: 'chat',
      source: 'moderation_destructive_path',
      retryUntilMs: null,
    });
    expect(ruleEngine.detect).not.toHaveBeenCalled();
    expect(prisma.violation.create).not.toHaveBeenCalled();
    expectImmediateDeleteMessage(maxClient.deleteMessage, 'chat-1', 'msg-1');
    expect(maxClient.sendMessage).not.toHaveBeenCalled();
    expect(maxClient.kickMember).not.toHaveBeenCalled();
    expect(maxClient.banMember).not.toHaveBeenCalled();
  });

  it('skips moderation for remote chat admins when local allowlist is stale', async () => {
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings(),
          domains: [],
          admins: [],
        }),
      },
      violation: {
        create: jest.fn(),
      },
      moderationEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
      webhookEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
      chatAdminAllowlist: {
        upsert: jest.fn().mockResolvedValue(undefined),
      },
    };
    installRemoteAdminProbeFence(prisma);
    const ruleEngine = {
      detect: jest.fn().mockResolvedValue({
        violations: [{ ruleCode: 'LINK_BLOCKED', score: 0.9, reason: 'Blocked link' }],
      }),
    };
    const sanctionService = {
      resolveAction: jest.fn(),
    };
    const maxClient = {
      deleteMessage: jest.fn(),
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
      getChatAdminIds: jest.fn(),
      sendMessage: jest.fn(),
      kickMember: jest.fn(),
      banMember: jest.fn(),
      notifyModerators: jest.fn(),
    };
    const chatContextCache = {
      getChatContext: jest.fn().mockResolvedValue({
        chatId: 'chat-1',
        title: 'Chat 1',
        settings: createSettings(),
        domainAllowlist: [],
        adminUserIds: [],
        rulesPublishedUrl: null,
        rulesPublishedMessageId: null,
      }),
      getAdminAccess: jest.fn().mockResolvedValue(null),
      applyAdminAccessEpochMutation: jest.fn().mockResolvedValue(true),
      invalidate: jest.fn().mockResolvedValue(undefined),
    };

    const service = new ModerationService(
      prisma as never,
      ruleEngine as never,
      sanctionService as never,
      maxClient as never,
      chatContextCache as never,
    );

    await service.handleUpdate(createUpdate());

    expect(maxClient.getChatMembersAccess).toHaveBeenCalledWith('chat-1', ['user-1'], {
      bypassCache: true,
      trafficClass: 'interactive',
      actionHealthLane: 'background',
      timeoutMs: 2000,
      ignoreFailureMetricStatuses: [403, 404],
    });
    expect(maxClient.getChatAdminIds).not.toHaveBeenCalled();
    expect(prisma.chatAdminAllowlist.upsert).not.toHaveBeenCalled();
    expect(chatContextCache.applyAdminAccessEpochMutation).toHaveBeenCalledWith({
      chatId: 'chat-1',
      userId: 'user-1',
      state: 'granted',
      eventAt: expect.any(Date),
    });
    expect(chatContextCache.applyAdminAccessEpochMutation).toHaveBeenCalledWith({
      chatId: 'chat-1',
      userId: 'iduser-1',
      state: 'granted',
      eventAt: expect.any(Date),
    });
    expect(chatContextCache.invalidate).not.toHaveBeenCalled();
    expect(ruleEngine.detect).not.toHaveBeenCalled();
    expect(prisma.violation.create).not.toHaveBeenCalled();
    expect(maxClient.deleteMessage).not.toHaveBeenCalled();
    expect(maxClient.sendMessage).not.toHaveBeenCalled();
    expect(maxClient.kickMember).not.toHaveBeenCalled();
    expect(maxClient.banMember).not.toHaveBeenCalled();
  });

  it('lets chat admins permanently ban a forwarded sender from the same chat with the ban command', async () => {
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings({
            muteDurationHours: 12,
            deleteBotMessagesEnabled: true,
            deleteBotMessagesDelayMinutes: 3,
          }),
          domains: [],
          admins: [{ userId: 'admin-1' }],
        }),
      },
      violation: {
        create: jest.fn(),
      },
      moderationEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
      webhookEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };
    const ruleEngine = {
      detect: jest.fn(),
    };
    const sanctionService = {
      resolveAction: jest.fn(),
    };
    const maxClient = {
      deleteMessage: jest.fn(),
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      sendMessage: jest.fn(),
      kickMember: jest.fn(),
      banMember: jest.fn(),
      notifyModerators: jest.fn(),
    };
    const adminService = {
      enqueueManualGroupModerationCommand: jest.fn().mockResolvedValue(true),
      applyManualSystemBan: jest.fn(),
    };

    const service = createModerationServiceWithManualBridge({
      prisma,
      ruleEngine,
      sanctionService,
      maxClient,
      manualBridge: adminService,
    });

    await service.handleUpdate({
      ...createAdminForwardedBanUpdate(),
      executionOwnerBotId: 'id613002203036_4_bot',
    } as MaxUpdate & { executionOwnerBotId: string });

    expect(maxClient.getChatAdminIds).toHaveBeenCalledTimes(1);
    expect(adminService.enqueueManualGroupModerationCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceChatId: 'chat-1',
        commandBotId: 'id613002203036_4_bot',
        targetUserId: 'user-2',
        targetSenderName: 'Нарушитель',
        targetMessageId: 'mid-forward-ban-1',
        commandMessageId: 'msg-admin-forward-ban-1',
        action: 'BAN',
        deleteBotMessagesEnabled: true,
        deleteBotMessagesDelayMinutes: 3,
        actor: expect.objectContaining({
          userId: 'admin-1',
          chatId: 'chat-1',
          chatTitle: null,
        }),
      }),
    );
    expect(adminService.applyManualSystemBan).not.toHaveBeenCalled();
    expect(ruleEngine.detect).not.toHaveBeenCalled();
    expect(maxClient.deleteMessage).not.toHaveBeenCalled();
    expect(maxClient.sendMessage).not.toHaveBeenCalled();
  });

  it('treats uppercase ban command as a ban across all admin chats', async () => {
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings({
            deleteBotMessagesEnabled: true,
            deleteBotMessagesDelayMinutes: 3,
          }),
          domains: [],
          admins: [{ userId: 'admin-1' }],
        }),
      },
      violation: {
        create: jest.fn(),
      },
      moderationEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
      webhookEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };
    const ruleEngine = {
      detect: jest.fn(),
    };
    const sanctionService = {
      resolveAction: jest.fn(),
    };
    const maxClient = {
      deleteMessage: jest.fn(),
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      sendMessage: jest.fn(),
      kickMember: jest.fn(),
      banMember: jest.fn(),
      notifyModerators: jest.fn(),
    };
    const adminService = {
      enqueueManualGroupModerationCommand: jest.fn().mockResolvedValue(true),
      applyManualSystemBan: jest.fn(),
    };

    const service = createModerationServiceWithManualBridge({
      prisma,
      ruleEngine,
      sanctionService,
      maxClient,
      manualBridge: adminService,
    });

    await service.handleUpdate(createAdminForwardedBanUpdate('БаН!'));

    expect(adminService.enqueueManualGroupModerationCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceChatId: 'chat-1',
        targetUserId: 'user-2',
        action: 'BAN',
        fanoutAllChats: true,
        deleteBotMessagesEnabled: true,
        deleteBotMessagesDelayMinutes: 3,
      }),
    );
    expect(ruleEngine.detect).not.toHaveBeenCalled();
    expect(maxClient.sendMessage).not.toHaveBeenCalled();
  });

  it('queues group forwarded moderation commands outside the webhook hot path', async () => {
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings({
            muteDurationHours: 12,
            deleteBotMessagesEnabled: true,
            deleteBotMessagesDelayMinutes: 3,
          }),
          domains: [],
          admins: [{ userId: 'admin-1' }],
        }),
      },
      violation: {
        create: jest.fn(),
      },
      moderationEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
      webhookEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };
    const ruleEngine = {
      detect: jest.fn(),
    };
    const sanctionService = {
      resolveAction: jest.fn(),
    };
    const maxClient = {
      deleteMessage: jest.fn(),
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      sendMessage: jest.fn(),
      kickMember: jest.fn(),
      banMember: jest.fn(),
      notifyModerators: jest.fn(),
    };
    const adminService = {
      enqueueManualGroupModerationCommand: jest.fn().mockResolvedValue(true),
      applyManualSystemBan: jest.fn(),
      applyManualModerationAction: jest.fn(),
    };

    const service = createModerationServiceWithManualBridge({
      prisma,
      ruleEngine,
      sanctionService,
      maxClient,
      manualBridge: adminService,
    });

    await service.handleUpdate(createAdminForwardedBanUpdate());

    expect(adminService.enqueueManualGroupModerationCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceChatId: 'chat-1',
        targetUserId: 'user-2',
        targetMessageId: 'mid-forward-ban-1',
        commandMessageId: 'msg-admin-forward-ban-1',
        action: 'BAN',
        deleteBotMessagesEnabled: true,
        deleteBotMessagesDelayMinutes: 3,
        actor: expect.objectContaining({
          userId: 'admin-1',
          chatId: 'chat-1',
        }),
      }),
    );
    expect(adminService.applyManualSystemBan).not.toHaveBeenCalled();
    expect(adminService.applyManualModerationAction).not.toHaveBeenCalled();
    expect(ruleEngine.detect).not.toHaveBeenCalled();
    expect(maxClient.deleteMessage).not.toHaveBeenCalled();
    expect(maxClient.sendMessage).not.toHaveBeenCalled();
  });

  it('does not execute a state-changing admin command from message_edited', async () => {
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings(),
          domains: [],
          admins: [{ userId: 'admin-1' }],
        }),
      },
      violation: { create: jest.fn() },
      moderationEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
      webhookEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };
    const ruleEngine = { detect: jest.fn() };
    const sanctionService = { resolveAction: jest.fn() };
    const maxClient = {
      deleteMessage: jest.fn(),
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      sendMessage: jest.fn(),
      kickMember: jest.fn(),
      banMember: jest.fn(),
      notifyModerators: jest.fn(),
    };
    const manualBridge = {
      enqueueManualGroupModerationCommand: jest.fn().mockResolvedValue(true),
      applyManualSystemBan: jest.fn(),
      applyManualModerationAction: jest.fn(),
    };
    const service = createModerationServiceWithManualBridge({
      prisma,
      ruleEngine,
      sanctionService,
      maxClient,
      manualBridge,
    });
    const update = createAdminReplyModerationUpdate('бан');
    update.type = 'message_edited';

    await service.handleUpdate(update);

    expect(manualBridge.enqueueManualGroupModerationCommand).not.toHaveBeenCalled();
    expect(manualBridge.applyManualSystemBan).not.toHaveBeenCalled();
    expect(manualBridge.applyManualModerationAction).not.toHaveBeenCalled();
    expect(maxClient.sendMessage).not.toHaveBeenCalled();
  });

  it('uses per-chat custom ban command name for group commands', async () => {
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings({
            adminBanCommandName: 'заблокировать',
          }),
          domains: [],
          admins: [{ userId: 'admin-1' }],
        }),
      },
      violation: {
        create: jest.fn(),
      },
      moderationEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
      webhookEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };
    const ruleEngine = {
      detect: jest.fn(),
    };
    const sanctionService = {
      resolveAction: jest.fn(),
    };
    const maxClient = {
      deleteMessage: jest.fn(),
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      sendMessage: jest.fn(),
      kickMember: jest.fn(),
      banMember: jest.fn(),
      notifyModerators: jest.fn(),
    };
    const adminService = {
      enqueueManualGroupModerationCommand: jest.fn().mockResolvedValue(true),
      applyManualSystemBan: jest.fn(),
      applyManualModerationAction: jest.fn(),
    };

    const service = createModerationServiceWithManualBridge({
      prisma,
      ruleEngine,
      sanctionService,
      maxClient,
      manualBridge: adminService,
    });

    await service.handleUpdate(createAdminForwardedBanUpdate('заблокировать'));

    expect(adminService.enqueueManualGroupModerationCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceChatId: 'chat-1',
        targetUserId: 'user-2',
        action: 'BAN',
      }),
    );
    expect(ruleEngine.detect).not.toHaveBeenCalled();
    expect(maxClient.sendMessage).not.toHaveBeenCalled();
  });

  it('uses per-chat custom all-chats ban command name for group commands', async () => {
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings({
            adminBanAllCommandName: 'бан везде',
          }),
          domains: [],
          admins: [{ userId: 'admin-1' }],
        }),
      },
      violation: {
        create: jest.fn(),
      },
      moderationEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
      webhookEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };
    const ruleEngine = {
      detect: jest.fn(),
    };
    const sanctionService = {
      resolveAction: jest.fn(),
    };
    const maxClient = {
      deleteMessage: jest.fn(),
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      sendMessage: jest.fn(),
      kickMember: jest.fn(),
      banMember: jest.fn(),
      notifyModerators: jest.fn(),
    };
    const adminService = {
      enqueueManualGroupModerationCommand: jest.fn().mockResolvedValue(true),
      applyManualSystemBan: jest.fn(),
      applyManualModerationAction: jest.fn(),
    };

    const service = createModerationServiceWithManualBridge({
      prisma,
      ruleEngine,
      sanctionService,
      maxClient,
      manualBridge: adminService,
    });

    await service.handleUpdate(createAdminForwardedBanUpdate('бан везде'));

    expect(adminService.enqueueManualGroupModerationCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceChatId: 'chat-1',
        targetUserId: 'user-2',
        action: 'BAN',
        fanoutAllChats: true,
      }),
    );
    expect(ruleEngine.detect).not.toHaveBeenCalled();
    expect(maxClient.sendMessage).not.toHaveBeenCalled();
  });

  it('lets the bot developer queue a super ban reply command without chat-admin rights', async () => {
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings({
            deleteBotMessagesEnabled: true,
            deleteBotMessagesDelayMinutes: 3,
          }),
          domains: [],
          admins: [{ userId: 'admin-1' }],
        }),
      },
      violation: {
        create: jest.fn(),
      },
      moderationEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
      webhookEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };
    const ruleEngine = {
      detect: jest.fn(),
    };
    const sanctionService = {
      resolveAction: jest.fn(),
    };
    const maxClient = {
      deleteMessage: jest.fn(),
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      sendMessage: jest.fn(),
      kickMember: jest.fn(),
      banMember: jest.fn(),
      notifyModerators: jest.fn(),
    };
    const adminService = {
      isSuperBanDeveloperUserId: jest.fn((userId: string) => userId === '98315271'),
      enqueueDeveloperSuperBanCommand: jest.fn().mockResolvedValue(true),
      enqueueManualGroupModerationCommand: jest.fn().mockResolvedValue(true),
      applyManualSystemBan: jest.fn(),
      applyManualModerationAction: jest.fn(),
    };

    const service = createModerationServiceWithManualBridge({
      prisma,
      ruleEngine,
      sanctionService,
      maxClient,
      manualBridge: adminService,
    });

    const update = createAdminReplyModerationUpdate('супер бан');
    update.message!.senderId = '98315271';
    update.message!.senderName = 'Разработчик';
    (update as MaxUpdate & { executionOwnerBotId: string }).executionOwnerBotId = 'bot-2';
    const rawMessage = (update.raw as { message: Record<string, unknown> }).message;
    (rawMessage.sender as Record<string, unknown>).user_id = '98315271';
    (rawMessage.sender as Record<string, unknown>).display_name = 'Разработчик';

    await service.handleUpdate(update);

    expect(maxClient.getChatAdminIds).not.toHaveBeenCalled();
    expect(adminService.enqueueDeveloperSuperBanCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceChatId: 'chat-1',
        commandBotId: 'bot-2',
        targetUserId: 'user-2',
        targetSenderName: 'Нарушитель',
        targetMessageId: 'mid-reply-target-1',
        commandMessageId: 'msg-admin-reply-moderation-1',
        deleteBotMessagesEnabled: true,
        deleteBotMessagesDelayMinutes: 3,
        actor: expect.objectContaining({
          userId: '98315271',
          chatId: 'chat-1',
        }),
      }),
    );
    expect(adminService.enqueueManualGroupModerationCommand).not.toHaveBeenCalled();
    expect(ruleEngine.detect).not.toHaveBeenCalled();
    expect(maxClient.sendMessage).not.toHaveBeenCalled();
  });

  it('rejects super ban commands from non-developers before enqueueing', async () => {
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings(),
          domains: [],
          admins: [{ userId: 'admin-1' }],
        }),
      },
      violation: {
        create: jest.fn(),
      },
      moderationEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
      webhookEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };
    const ruleEngine = {
      detect: jest.fn(),
    };
    const sanctionService = {
      resolveAction: jest.fn(),
    };
    const maxClient = {
      deleteMessage: jest.fn(),
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      sendMessage: jest.fn(),
      kickMember: jest.fn(),
      banMember: jest.fn(),
      notifyModerators: jest.fn(),
    };
    const adminService = {
      isSuperBanDeveloperUserId: jest.fn().mockReturnValue(false),
      enqueueDeveloperSuperBanCommand: jest.fn().mockResolvedValue(true),
      enqueueManualGroupModerationCommand: jest.fn().mockResolvedValue(true),
      applyManualSystemBan: jest.fn(),
      applyManualModerationAction: jest.fn(),
    };

    const service = createModerationServiceWithManualBridge({
      prisma,
      ruleEngine,
      sanctionService,
      maxClient,
      manualBridge: adminService,
    });

    const update = createAdminReplyModerationUpdate('super ban');
    (update as MaxUpdate & { executionOwnerBotId: string }).executionOwnerBotId = 'bot-4';
    await service.handleUpdate(update);

    expect(adminService.enqueueDeveloperSuperBanCommand).not.toHaveBeenCalled();
    expect(adminService.enqueueManualGroupModerationCommand).not.toHaveBeenCalled();
    expect(maxClient.sendMessage).toHaveBeenCalledWith(
      'chat-1',
      'Недостаточно прав: команду <code>супер бан</code> может запускать только разработчик бота.',
      { textFormat: 'html' },
      expect.objectContaining({ immediate: true, botId: 'bot-4' }),
    );
  });

  it('reports reply moderation command enqueue failures without technical details', async () => {
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings(),
          domains: [],
          admins: [{ userId: 'admin-1' }],
        }),
      },
      violation: {
        create: jest.fn(),
      },
      moderationEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
      webhookEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };
    const ruleEngine = {
      detect: jest.fn(),
    };
    const sanctionService = {
      resolveAction: jest.fn(),
    };
    const maxClient = {
      deleteMessage: jest.fn(),
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      sendMessage: jest.fn(),
      kickMember: jest.fn(),
      banMember: jest.fn(),
      notifyModerators: jest.fn(),
    };
    const adminService = {
      enqueueManualGroupModerationCommand: jest.fn().mockResolvedValue(false),
      applyManualSystemBan: jest.fn(),
      applyManualModerationAction: jest.fn(),
    };

    const service = createModerationServiceWithManualBridge({
      prisma,
      ruleEngine,
      sanctionService,
      maxClient,
      manualBridge: adminService,
    });

    await service.handleUpdate(createAdminReplyModerationUpdate('мут'));

    expect(adminService.applyManualSystemBan).not.toHaveBeenCalled();
    expect(adminService.applyManualModerationAction).not.toHaveBeenCalled();
    expect(maxClient.sendMessage).toHaveBeenCalledWith(
      'chat-1',
      'Команда не запущена. Повторите через несколько секунд.',
      { textFormat: 'html' },
      expect.objectContaining({ immediate: true }),
    );
  });

  it('uses the current chat for MAX reply moderation commands without recipient in the reply link', async () => {
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings(),
          domains: [],
          admins: [{ userId: 'admin-1' }],
        }),
      },
      violation: {
        create: jest.fn(),
      },
      moderationEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
      webhookEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };
    const ruleEngine = {
      detect: jest.fn(),
    };
    const sanctionService = {
      resolveAction: jest.fn(),
    };
    const maxClient = {
      deleteMessage: jest.fn(),
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      sendMessage: jest.fn(),
      kickMember: jest.fn(),
      banMember: jest.fn(),
      notifyModerators: jest.fn(),
    };
    const adminService = {
      enqueueManualGroupModerationCommand: jest.fn().mockResolvedValue(true),
      applyManualSystemBan: jest.fn(),
      applyManualModerationAction: jest.fn(),
    };

    const service = createModerationServiceWithManualBridge({
      prisma,
      ruleEngine,
      sanctionService,
      maxClient,
      manualBridge: adminService,
    });

    const update = createAdminReplyModerationUpdate();
    delete (
      ((update.raw as Record<string, unknown>).message as Record<string, unknown>).body as {
        text?: string;
      }
    ).text;

    await service.handleUpdate(update);

    expect(adminService.enqueueManualGroupModerationCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceChatId: 'chat-1',
        targetUserId: 'user-2',
        targetSenderName: 'Нарушитель',
        targetMessageId: 'mid-reply-target-1',
        commandMessageId: 'msg-admin-reply-moderation-1',
        action: 'BAN',
        actor: expect.objectContaining({
          userId: 'admin-1',
          chatId: 'chat-1',
        }),
      }),
    );
    expect(adminService.applyManualModerationAction).not.toHaveBeenCalled();
    expect(adminService.applyManualSystemBan).not.toHaveBeenCalled();
    expect(ruleEngine.detect).not.toHaveBeenCalled();
    expect(maxClient.sendMessage).not.toHaveBeenCalled();
  });

  it('lets chat admins mute a replied sender with the default duration', async () => {
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings(),
          domains: [],
          admins: [{ userId: 'admin-1' }],
        }),
      },
      violation: {
        create: jest.fn(),
      },
      moderationEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
      webhookEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };
    const ruleEngine = {
      detect: jest.fn(),
    };
    const sanctionService = {
      resolveAction: jest.fn(),
    };
    const maxClient = {
      deleteMessage: jest.fn(),
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      sendMessage: jest.fn(),
      kickMember: jest.fn(),
      banMember: jest.fn(),
      notifyModerators: jest.fn(),
    };
    const adminService = {
      enqueueManualGroupModerationCommand: jest.fn().mockResolvedValue(true),
      applyManualSystemBan: jest.fn(),
      applyManualModerationAction: jest.fn(),
    };

    const service = createModerationServiceWithManualBridge({
      prisma,
      ruleEngine,
      sanctionService,
      maxClient,
      manualBridge: adminService,
    });

    await service.handleUpdate(createAdminLinkedModerationUpdate());

    expect(maxClient.getChatAdminIds).toHaveBeenCalledTimes(1);
    expect(adminService.enqueueManualGroupModerationCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceChatId: 'chat-1',
        targetUserId: 'user-2',
        targetSenderName: 'Нарушитель',
        targetMessageId: null,
        commandMessageId: 'msg-admin-link-moderation-1',
        action: 'MUTE',
        muteDurationHours: 6,
        actor: expect.objectContaining({
          userId: 'admin-1',
          chatId: 'chat-1',
          chatTitle: null,
        }),
      }),
    );
    expect(adminService.applyManualModerationAction).not.toHaveBeenCalled();
    expect(adminService.applyManualSystemBan).not.toHaveBeenCalled();
    expect(ruleEngine.detect).not.toHaveBeenCalled();
    expect(maxClient.deleteMessage).not.toHaveBeenCalled();
    expect(maxClient.sendMessage).not.toHaveBeenCalled();
  });

  it('lets chat admins mute a replied sender for an explicit duration', async () => {
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings(),
          domains: [],
          admins: [{ userId: 'admin-1' }],
        }),
      },
      violation: {
        create: jest.fn(),
      },
      moderationEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
      webhookEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };
    const ruleEngine = {
      detect: jest.fn(),
    };
    const sanctionService = {
      resolveAction: jest.fn(),
    };
    const maxClient = {
      deleteMessage: jest.fn(),
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      sendMessage: jest.fn(),
      kickMember: jest.fn(),
      banMember: jest.fn(),
      notifyModerators: jest.fn(),
    };
    const adminService = {
      enqueueManualGroupModerationCommand: jest.fn().mockResolvedValue(true),
      applyManualSystemBan: jest.fn(),
      applyManualModerationAction: jest.fn(),
    };

    const service = createModerationServiceWithManualBridge({
      prisma,
      ruleEngine,
      sanctionService,
      maxClient,
      manualBridge: adminService,
    });

    await service.handleUpdate(createAdminLinkedModerationUpdate('мут 12'));

    expect(adminService.enqueueManualGroupModerationCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceChatId: 'chat-1',
        targetUserId: 'user-2',
        commandMessageId: 'msg-admin-link-moderation-1',
        action: 'MUTE',
        muteDurationHours: 12,
        actor: expect.objectContaining({
          userId: 'admin-1',
          chatId: 'chat-1',
        }),
      }),
    );
    expect(adminService.applyManualModerationAction).not.toHaveBeenCalled();
    expect(adminService.applyManualSystemBan).not.toHaveBeenCalled();
    expect(maxClient.sendMessage).not.toHaveBeenCalled();
  });

  it('queues the bang mute command for every chat administered by the actor', async () => {
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings(),
          domains: [],
          admins: [{ userId: 'admin-1' }],
        }),
      },
      violation: {
        create: jest.fn(),
      },
      moderationEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
      webhookEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };
    const adminService = {
      enqueueManualGroupModerationCommand: jest.fn().mockResolvedValue(true),
      applyManualSystemBan: jest.fn(),
      applyManualModerationAction: jest.fn(),
    };
    const service = createModerationServiceWithManualBridge({
      prisma,
      ruleEngine: { detect: jest.fn() },
      sanctionService: { resolveAction: jest.fn() },
      maxClient: {
        deleteMessage: jest.fn(),
        getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
        sendMessage: jest.fn(),
        kickMember: jest.fn(),
        banMember: jest.fn(),
        notifyModerators: jest.fn(),
      },
      manualBridge: adminService,
    });

    await service.handleUpdate(createAdminLinkedModerationUpdate('Мут! 24'));

    expect(adminService.enqueueManualGroupModerationCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceChatId: 'chat-1',
        targetUserId: 'user-2',
        action: 'MUTE',
        fanoutAllChats: true,
        muteDurationHours: 24,
      }),
    );
  });

  it('uses per-chat custom mute command name for group commands', async () => {
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings({
            adminMuteCommandName: 'тихо',
          }),
          domains: [],
          admins: [{ userId: 'admin-1' }],
        }),
      },
      violation: {
        create: jest.fn(),
      },
      moderationEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
      webhookEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };
    const ruleEngine = {
      detect: jest.fn(),
    };
    const sanctionService = {
      resolveAction: jest.fn(),
    };
    const maxClient = {
      deleteMessage: jest.fn(),
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      sendMessage: jest.fn(),
      kickMember: jest.fn(),
      banMember: jest.fn(),
      notifyModerators: jest.fn(),
    };
    const adminService = {
      enqueueManualGroupModerationCommand: jest.fn().mockResolvedValue(true),
      applyManualSystemBan: jest.fn(),
      applyManualModerationAction: jest.fn(),
    };

    const service = createModerationServiceWithManualBridge({
      prisma,
      ruleEngine,
      sanctionService,
      maxClient,
      manualBridge: adminService,
    });

    await service.handleUpdate(createAdminLinkedModerationUpdate('тихо 12'));

    expect(adminService.enqueueManualGroupModerationCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceChatId: 'chat-1',
        targetUserId: 'user-2',
        action: 'MUTE',
        muteDurationHours: 12,
      }),
    );
    expect(ruleEngine.detect).not.toHaveBeenCalled();
    expect(maxClient.sendMessage).not.toHaveBeenCalled();
  });

  it('lets chat admins enable silence from a group command without a target message', async () => {
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings({
            deleteBotMessagesEnabled: true,
            deleteBotMessagesDelayMinutes: 3,
          }),
          domains: [],
          admins: [{ userId: 'admin-1' }],
        }),
      },
      violation: {
        create: jest.fn(),
      },
      moderationEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
      webhookEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };
    const ruleEngine = {
      detect: jest.fn(),
    };
    const sanctionService = {
      resolveAction: jest.fn(),
    };
    const maxClient = {
      deleteMessage: jest.fn(),
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      sendMessage: jest.fn(),
      kickMember: jest.fn(),
      banMember: jest.fn(),
      notifyModerators: jest.fn(),
    };
    const adminService = {
      enqueueManualGroupModerationCommand: jest.fn(),
      applyManualChatSilenceCommand: jest.fn().mockResolvedValue({
        ok: true,
        message:
          'Чат закрыт на 12 ч. До конца срока сообщения участников без прав администратора будут удаляться.',
        durationHours: 12,
        until: '2026-06-20T15:00:00.000Z',
      }),
      applyManualOpenChatCommand: jest.fn(),
    };

    const service = createModerationServiceWithManualBridge({
      prisma,
      ruleEngine,
      sanctionService,
      maxClient,
      manualBridge: adminService,
    });
    const cleanupSpy = jest.spyOn(service as any, 'deleteAdminCommandMessage');
    const executeDeleteSpy = jest.spyOn(service as any, 'executeModerationDelete');

    const baseUpdate = createUpdate();
    const baseMessage = baseUpdate.message!;
    baseMessage.createdAt = '2026-08-15T09:39:00.000Z';
    await service.handleUpdate({
      ...baseUpdate,
      message: {
        ...baseMessage,
        messageId: 'msg-admin-silence-1',
        senderId: 'admin-1',
        text: 'тишина 12',
      },
    });

    expect(adminService.applyManualChatSilenceCommand).toHaveBeenCalledWith(
      'chat-1',
      expect.objectContaining({
        userId: 'admin-1',
        chatId: 'chat-1',
      }),
      { durationHours: 12 },
      'group_command',
      expect.objectContaining({ executionBotId: 'bot-1', chatId: 'chat-1' }),
    );
    expect(adminService.enqueueManualGroupModerationCommand).not.toHaveBeenCalled();
    expect(adminService.applyManualOpenChatCommand).not.toHaveBeenCalled();
    expect(cleanupSpy).toHaveBeenCalledWith('chat-1', 'msg-admin-silence-1', baseMessage.createdAt);
    expect(executeDeleteSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        ruleCode: 'ADMIN_COMMAND_CLEANUP',
        sourceMessageAt: baseMessage.createdAt,
      }),
    );
    expect(maxClient.deleteMessage).toHaveBeenCalledWith(
      'chat-1',
      'msg-admin-silence-1',
      expect.objectContaining({
        immediate: true,
        trafficClass: 'critical',
        actionHealthLane: 'critical',
        sourceTag: 'moderation_delete',
        timeoutMs: MODERATION_ACTION_DISPATCH_TIMEOUT_MS,
      }),
    );
    expect(maxClient.sendMessage).toHaveBeenCalledWith(
      'chat-1',
      'Чат закрыт на 12 ч. До конца срока сообщения участников без прав администратора будут удаляться.',
      expect.any(Object),
      expect.objectContaining({
        autoDeleteDelayMs: 180_000,
        immediate: true,
      }),
    );
    expect(ruleEngine.detect).not.toHaveBeenCalled();
  });

  it('routes forwarded admin command cleanup through a delete-capable fallback bot', async () => {
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings(),
          domains: [],
          admins: [{ userId: 'admin-1' }],
        }),
      },
      violation: {
        create: jest.fn(),
      },
      moderationEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
      webhookEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };
    const ruleEngine = {
      detect: jest.fn(),
    };
    const sanctionService = {
      resolveAction: jest.fn(),
    };
    const terminalDeleteError = {
      response: {
        status: 403,
        data: { code: 'chat.denied', message: 'bot cannot delete command message' },
      },
    };
    const maxClient = {
      deleteMessage: jest
        .fn()
        .mockImplementation(
          async (_chatId: string, _messageId: string, options?: { botId?: string }) => {
            if (options?.botId === 'bot-2') {
              throw terminalDeleteError;
            }
          },
        ),
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      sendMessage: jest.fn(),
      kickMember: jest.fn(),
      banMember: jest.fn(),
      notifyModerators: jest.fn(),
    };
    const maxBotLinkService = {
      resolveBotRoutes: jest.fn().mockResolvedValue({
        purpose: 'moderation_action',
        chatId: 'chat-1',
        primaryBotId: 'bot-2',
        botId: 'bot-2',
        candidateBotIds: ['bot-2', 'bot-6'],
        reason: 'primary_soft',
        action: 'delete_message',
      }),
    };
    const adminService = {
      enqueueManualGroupModerationCommand: jest.fn(),
      applyManualChatSilenceCommand: jest.fn().mockResolvedValue({
        ok: true,
        message:
          'Чат закрыт на 12 ч. До конца срока сообщения участников без прав администратора будут удаляться.',
        durationHours: 12,
        until: '2026-06-20T15:00:00.000Z',
      }),
      applyManualOpenChatCommand: jest.fn(),
    };

    const service = createModerationServiceWithManualBridge({
      prisma,
      ruleEngine,
      sanctionService,
      maxClient,
      manualBridge: adminService,
      maxBotLinkService,
    });

    const baseUpdate = createUpdate();
    await service.handleUpdate({
      ...baseUpdate,
      message: {
        ...baseUpdate.message!,
        messageId: 'msg-admin-silence-1',
        senderId: 'admin-1',
        text: 'тишина 12',
      },
    });

    expect(maxClient.deleteMessage).toHaveBeenCalledWith(
      'chat-1',
      'msg-admin-silence-1',
      expect.objectContaining({
        immediate: true,
        botId: 'bot-2',
        sourceTag: 'moderation_delete',
      }),
    );
    expect(maxClient.deleteMessage).toHaveBeenCalledWith(
      'chat-1',
      'msg-admin-silence-1',
      expect.objectContaining({
        immediate: true,
        botId: 'bot-6',
        sourceTag: 'moderation_delete',
      }),
    );
    expect(adminService.applyManualChatSilenceCommand).toHaveBeenCalled();
    expect(ruleEngine.detect).not.toHaveBeenCalled();
  });

  it.each([
    'Чат открыт. Для сообщений снова действуют обычные правила.',
    'Ручное закрытие снято. Чат остаётся закрыт по ночному расписанию.',
  ])('passes the effective group opening result through unchanged: %s', async (message) => {
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings(),
          domains: [],
          admins: [{ userId: 'admin-1' }],
        }),
      },
      violation: {
        create: jest.fn(),
      },
      moderationEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
      webhookEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };
    const ruleEngine = {
      detect: jest.fn(),
    };
    const sanctionService = {
      resolveAction: jest.fn(),
    };
    const maxClient = {
      deleteMessage: jest.fn(),
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      sendMessage: jest.fn(),
      kickMember: jest.fn(),
      banMember: jest.fn(),
      notifyModerators: jest.fn(),
    };
    const adminService = {
      enqueueManualGroupModerationCommand: jest.fn(),
      applyManualChatSilenceCommand: jest.fn(),
      applyManualOpenChatCommand: jest
        .fn<
          ReturnType<AdminService['applyManualOpenChatCommand']>,
          Parameters<AdminService['applyManualOpenChatCommand']>
        >()
        .mockResolvedValue({ ok: true, message }),
    };

    const service = createModerationServiceWithManualBridge({
      prisma,
      ruleEngine,
      sanctionService,
      maxClient,
      manualBridge: adminService,
    });

    const baseUpdate = createUpdate();
    const baseMessage = baseUpdate.message!;
    await service.handleUpdate({
      ...baseUpdate,
      message: {
        ...baseMessage,
        messageId: 'msg-admin-open-chat-1',
        senderId: 'admin-1',
        text: 'тишина выкл',
      },
    });

    expect(adminService.applyManualOpenChatCommand).toHaveBeenCalledWith(
      'chat-1',
      expect.objectContaining({
        userId: 'admin-1',
        chatId: 'chat-1',
      }),
      'group_command',
      expect.objectContaining({ executionBotId: 'bot-1', chatId: 'chat-1' }),
    );
    expect(adminService.applyManualChatSilenceCommand).not.toHaveBeenCalled();
    expect(adminService.enqueueManualGroupModerationCommand).not.toHaveBeenCalled();
    expect(maxClient.deleteMessage).toHaveBeenCalledWith(
      'chat-1',
      'msg-admin-open-chat-1',
      expect.objectContaining({
        immediate: true,
        trafficClass: 'critical',
        actionHealthLane: 'critical',
        sourceTag: 'moderation_delete',
        timeoutMs: MODERATION_ACTION_DISPATCH_TIMEOUT_MS,
      }),
    );
    expect(maxClient.sendMessage).toHaveBeenCalledWith(
      'chat-1',
      message,
      expect.any(Object),
      expect.objectContaining({
        immediate: true,
      }),
    );
    expect(ruleEngine.detect).not.toHaveBeenCalled();
  });

  it('stops accepting the default mute word after a chat replaces its command name', async () => {
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings({
            adminMuteCommandName: 'тихо',
          }),
          domains: [],
          admins: [{ userId: 'admin-1' }],
        }),
      },
      violation: {
        create: jest.fn(),
      },
      moderationEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
      webhookEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };
    const ruleEngine = {
      detect: jest.fn(),
    };
    const sanctionService = {
      resolveAction: jest.fn(),
    };
    const maxClient = {
      deleteMessage: jest.fn(),
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      sendMessage: jest.fn(),
      kickMember: jest.fn(),
      banMember: jest.fn(),
      notifyModerators: jest.fn(),
    };
    const adminService = {
      enqueueManualGroupModerationCommand: jest.fn().mockResolvedValue(true),
      applyManualSystemBan: jest.fn(),
      applyManualModerationAction: jest.fn(),
    };

    const service = createModerationServiceWithManualBridge({
      prisma,
      ruleEngine,
      sanctionService,
      maxClient,
      manualBridge: adminService,
    });

    await service.handleUpdate(createAdminLinkedModerationUpdate('мут 12'));

    expect(adminService.enqueueManualGroupModerationCommand).not.toHaveBeenCalled();
    expect(ruleEngine.detect).not.toHaveBeenCalled();
    expect(maxClient.sendMessage).not.toHaveBeenCalled();
  });

  it('uses the default permanent mute command name as a separate command', async () => {
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings(),
          domains: [],
          admins: [{ userId: 'admin-1' }],
        }),
      },
      violation: {
        create: jest.fn(),
      },
      moderationEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
      webhookEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };
    const ruleEngine = {
      detect: jest.fn(),
    };
    const sanctionService = {
      resolveAction: jest.fn(),
    };
    const maxClient = {
      deleteMessage: jest.fn(),
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      sendMessage: jest.fn(),
      kickMember: jest.fn(),
      banMember: jest.fn(),
      notifyModerators: jest.fn(),
    };
    const adminService = {
      enqueueManualGroupModerationCommand: jest.fn().mockResolvedValue(true),
      applyManualSystemBan: jest.fn(),
      applyManualModerationAction: jest.fn(),
    };

    const service = createModerationServiceWithManualBridge({
      prisma,
      ruleEngine,
      sanctionService,
      maxClient,
      manualBridge: adminService,
    });

    await service.handleUpdate(createAdminLinkedModerationUpdate('мут 88'));

    expect(adminService.enqueueManualGroupModerationCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceChatId: 'chat-1',
        targetUserId: 'user-2',
        action: 'MUTE',
        mutePermanent: true,
      }),
    );
    expect(ruleEngine.detect).not.toHaveBeenCalled();
    expect(maxClient.sendMessage).not.toHaveBeenCalled();
  });

  it('uses the separate permanent mute command name', async () => {
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings({
            adminPermanentMuteCommandName: 'навсегда',
          }),
          domains: [],
          admins: [{ userId: 'admin-1' }],
        }),
      },
      violation: {
        create: jest.fn(),
      },
      moderationEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
      webhookEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };
    const ruleEngine = {
      detect: jest.fn(),
    };
    const sanctionService = {
      resolveAction: jest.fn(),
    };
    const maxClient = {
      deleteMessage: jest.fn(),
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      sendMessage: jest.fn(),
      kickMember: jest.fn(),
      banMember: jest.fn(),
      notifyModerators: jest.fn(),
    };
    const adminService = {
      enqueueManualGroupModerationCommand: jest.fn().mockResolvedValue(true),
      applyManualSystemBan: jest.fn(),
      applyManualModerationAction: jest.fn(),
    };

    const service = createModerationServiceWithManualBridge({
      prisma,
      ruleEngine,
      sanctionService,
      maxClient,
      manualBridge: adminService,
    });

    await service.handleUpdate(createAdminLinkedModerationUpdate('навсегда'));

    expect(adminService.enqueueManualGroupModerationCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceChatId: 'chat-1',
        targetUserId: 'user-2',
        commandMessageId: 'msg-admin-link-moderation-1',
        action: 'MUTE',
        mutePermanent: true,
        actor: expect.objectContaining({
          userId: 'admin-1',
          chatId: 'chat-1',
        }),
      }),
    );
    expect(adminService.applyManualModerationAction).not.toHaveBeenCalled();
    expect(adminService.applyManualSystemBan).not.toHaveBeenCalled();
    expect(maxClient.sendMessage).not.toHaveBeenCalled();
  });

  it('lets chat admins bind forwarded rules message to moderation buttons', async () => {
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings(),
          domains: [],
          admins: [{ userId: 'admin-1' }],
        }),
      },
      violation: {
        create: jest.fn(),
      },
      moderationEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
      webhookEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };
    const ruleEngine = {
      detect: jest.fn(),
    };
    const sanctionService = {
      resolveAction: jest.fn(),
    };
    const maxClient = {
      deleteMessage: jest.fn(),
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      sendMessage: jest.fn(),
      kickMember: jest.fn(),
      banMember: jest.fn(),
      notifyModerators: jest.fn(),
    };
    const adminService = {
      adoptChatRulesFromMessage: jest.fn().mockResolvedValue({
        text: '1. Без спама.\n2. Без ссылок.',
        imageBase64: '',
        imageMimeType: '',
        imageFileName: '',
        autoTextEnabled: false,
        buttonEnabled: false,
        buttonUrl: '',
        buttonText: 'Открыть',
        publishedMessageId: 'mid-rules-source-1',
        publishedUrl: 'https://max.ru/chats/chat-1/message/321',
        publishedAt: '2026-03-27T01:00:00.000Z',
      }),
    };

    const service = createModerationServiceWithManualBridge({
      prisma,
      ruleEngine,
      sanctionService,
      maxClient,
      manualBridge: adminService,
    });

    await service.handleUpdate(createAdminForwardedRulesUpdate());

    expect(adminService.adoptChatRulesFromMessage).toHaveBeenCalledWith(
      'chat-1',
      expect.objectContaining({
        userId: 'admin-1',
        chatId: 'chat-1',
        chatTitle: null,
      }),
      {
        sourceMessageId: 'mid-rules-source-1',
        sourceMessageUrl: null,
        text: '1. Без спама.\n2. Без ссылок.',
      },
      'group_command',
      expect.objectContaining({ executionBotId: 'bot-1', chatId: 'chat-1' }),
    );
    expect(maxClient.deleteMessage).toHaveBeenCalledWith(
      'chat-1',
      'msg-admin-forward-rules-1',
      expect.objectContaining({
        immediate: true,
        trafficClass: 'critical',
        actionHealthLane: 'critical',
        sourceTag: 'moderation_delete',
        timeoutMs: MODERATION_ACTION_DISPATCH_TIMEOUT_MS,
      }),
    );
    const sentTexts = maxClient.sendMessage.mock.calls.map((call) => String(call[1] ?? ''));
    expect(
      sentTexts.some((text) =>
        text.includes(
          'Правила привязаны к этому сообщению. Кнопка «Правила» в нарушениях включена.',
        ),
      ),
    ).toBe(true);
  });

  it('uses per-chat custom rules command name for forwarded rules messages', async () => {
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings({
            adminRulesCommandName: 'регламент',
          }),
          domains: [],
          admins: [{ userId: 'admin-1' }],
        }),
      },
      violation: {
        create: jest.fn(),
      },
      moderationEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
      webhookEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };
    const ruleEngine = {
      detect: jest.fn(),
    };
    const sanctionService = {
      resolveAction: jest.fn(),
    };
    const maxClient = {
      deleteMessage: jest.fn(),
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      sendMessage: jest.fn(),
      kickMember: jest.fn(),
      banMember: jest.fn(),
      notifyModerators: jest.fn(),
    };
    const adminService = {
      adoptChatRulesFromMessage: jest.fn().mockResolvedValue({
        text: '1. Без спама.\n2. Без ссылок.',
        imageBase64: '',
        imageMimeType: '',
        imageFileName: '',
        autoTextEnabled: false,
        buttonEnabled: false,
        buttonUrl: '',
        buttonText: 'Открыть',
        publishedMessageId: 'mid-rules-source-1',
        publishedUrl: 'https://max.ru/chats/chat-1/message/321',
        publishedAt: '2026-03-27T01:00:00.000Z',
      }),
    };

    const service = createModerationServiceWithManualBridge({
      prisma,
      ruleEngine,
      sanctionService,
      maxClient,
      manualBridge: adminService,
    });

    await service.handleUpdate(createAdminForwardedRulesUpdate('регламент'));

    expect(adminService.adoptChatRulesFromMessage).toHaveBeenCalledWith(
      'chat-1',
      expect.objectContaining({
        userId: 'admin-1',
        chatId: 'chat-1',
      }),
      expect.objectContaining({
        sourceMessageId: 'mid-rules-source-1',
      }),
      'group_command',
      expect.objectContaining({ executionBotId: 'bot-1', chatId: 'chat-1' }),
    );
    expect(ruleEngine.detect).not.toHaveBeenCalled();
    expect(maxClient.deleteMessage).toHaveBeenCalledWith(
      'chat-1',
      'msg-admin-forward-rules-1',
      expect.objectContaining({
        immediate: true,
        trafficClass: 'critical',
        actionHealthLane: 'critical',
        sourceTag: 'moderation_delete',
        timeoutMs: MODERATION_ACTION_DISPATCH_TIMEOUT_MS,
      }),
    );
  });

  it('rejects duration suffix for the group ban command', async () => {
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings(),
          domains: [],
          admins: [{ userId: 'admin-1' }],
        }),
      },
      violation: {
        create: jest.fn(),
      },
      moderationEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
      webhookEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };
    const ruleEngine = {
      detect: jest.fn(),
    };
    const sanctionService = {
      resolveAction: jest.fn(),
    };
    const maxClient = {
      deleteMessage: jest.fn(),
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      sendMessage: jest.fn(),
      kickMember: jest.fn(),
      banMember: jest.fn(),
      notifyModerators: jest.fn(),
    };
    const adminService = {
      applyManualSystemBan: jest.fn(),
    };

    const service = createModerationServiceWithManualBridge({
      prisma,
      ruleEngine,
      sanctionService,
      maxClient,
      manualBridge: adminService,
    });

    await service.handleUpdate(createAdminForwardedBanUpdate('бан 24'));

    expect(adminService.applyManualSystemBan).not.toHaveBeenCalled();
    const sentTexts = maxClient.sendMessage.mock.calls.map((call) => String(call[1] ?? ''));
    expect(
      sentTexts.some((text) =>
        text.includes(
          'Команда <code>бан</code> применяется без срока. Отправьте её без длительности: <code>бан</code>.',
        ),
      ),
    ).toBe(true);
  });

  it('rejects admin ban command when the forwarded message comes from another chat', async () => {
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings({
            muteDurationHours: 12,
            deleteBotMessagesEnabled: true,
            deleteBotMessagesDelayMinutes: 3,
          }),
          domains: [],
          admins: [{ userId: 'admin-1' }],
        }),
      },
      violation: {
        create: jest.fn(),
      },
      moderationEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
      webhookEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };
    const ruleEngine = {
      detect: jest.fn(),
    };
    const sanctionService = {
      resolveAction: jest.fn(),
    };
    const maxClient = {
      deleteMessage: jest.fn(),
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      sendMessage: jest.fn(),
      kickMember: jest.fn(),
      banMember: jest.fn(),
      notifyModerators: jest.fn(),
    };
    const adminService = {
      applyManualModerationAction: jest.fn(),
    };

    const service = createModerationServiceWithManualBridge({
      prisma,
      ruleEngine,
      sanctionService,
      maxClient,
      manualBridge: adminService,
    });

    await service.handleUpdate(createAdminForwardedBanUpdate('бан', 'chat-2'));

    expect(maxClient.getChatAdminIds).toHaveBeenCalledTimes(1);
    expect(adminService.applyManualModerationAction).not.toHaveBeenCalled();
    expect(ruleEngine.detect).not.toHaveBeenCalled();
    expect(maxClient.deleteMessage).not.toHaveBeenCalled();
    const sentTexts = maxClient.sendMessage.mock.calls.map((call) => String(call[1] ?? ''));
    expect(
      sentTexts.some((text) =>
        text.includes('Команда <code>бан</code> применима только к участнику этого чата'),
      ),
    ).toBe(true);
  });

  it('retains local admin protection when a remote denial cannot pass the SQL proof fence', async () => {
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings(),
          domains: [],
          admins: [{ userId: 'user-1' }],
        }),
      },
      violation: {
        create: jest.fn(),
      },
      moderationEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
      webhookEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };
    const ruleEngine = {
      detect: jest.fn().mockResolvedValue({
        violations: [],
      }),
    };
    const sanctionService = {
      resolveAction: jest.fn(),
    };
    const maxClient = {
      deleteMessage: jest.fn(),
      getChatAdminIds: jest.fn().mockResolvedValue(['another-admin']),
      sendMessage: jest.fn(),
      kickMember: jest.fn(),
      banMember: jest.fn(),
      notifyModerators: jest.fn(),
    };

    const service = new ModerationService(
      prisma as never,
      ruleEngine as never,
      sanctionService as never,
      maxClient as never,
    );

    await service.handleUpdate(createUpdate());

    expect(maxClient.getChatAdminIds).toHaveBeenCalledTimes(1);
    expect(ruleEngine.detect).not.toHaveBeenCalled();
  });

  it('rechecks remote admin access before link enforcement when local admin roster is stale', async () => {
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings(),
          domains: [],
          admins: [{ userId: 'existing-admin' }],
        }),
      },
      violation: {
        create: jest.fn(),
      },
      moderationEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
      webhookEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };
    installRemoteAdminProbeFence(prisma);
    const ruleEngine = {
      detect: jest.fn().mockResolvedValue({
        violations: [{ ruleCode: 'LINK_BLOCKED', score: 0.9, reason: 'Blocked link' }],
      }),
    };
    const sanctionService = {
      resolveAction: jest.fn(),
    };
    const maxClient = {
      deleteMessage: jest.fn(),
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
      sendMessage: jest.fn(),
      kickMember: jest.fn(),
      banMember: jest.fn(),
      notifyModerators: jest.fn(),
    };
    const chatContextCache = createAdminAccessEpochCache({
      adminUserIds: ['existing-admin'],
    });

    const service = new ModerationService(
      prisma as never,
      ruleEngine as never,
      sanctionService as never,
      maxClient as never,
      chatContextCache as never,
    );

    await service.handleUpdate(createUpdate());

    expect(maxClient.getChatMembersAccess).toHaveBeenCalledTimes(1);
    expect(maxClient.deleteMessage).not.toHaveBeenCalled();
    expect(maxClient.sendMessage).not.toHaveBeenCalled();
    expect(prisma.violation.create).not.toHaveBeenCalled();
    expect(prisma.moderationEvent.create).not.toHaveBeenCalled();
    expect(sanctionService.resolveAction).not.toHaveBeenCalled();
  });

  it('rechecks remote admin access before text duplicate enforcement when the local roster is stale', async () => {
    const prisma = {
      violation: { create: jest.fn() },
      moderationEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
      webhookEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };
    installRemoteAdminProbeFence(prisma);
    const ruleEngine = {
      detect: jest.fn().mockResolvedValue({
        violations: [],
        duplicateDecision: {
          action: 'WARN',
          count: 2,
          threshold: 2,
          windowSec: 12 * 60 * 60,
          hash: 'stale-admin-duplicate',
          fingerprintType: 'exact',
          nextAction: 'MUTE',
        },
      }),
    };
    const maxClient = {
      deleteMessage: jest.fn(),
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
      sendMessage: jest.fn(),
      kickMember: jest.fn(),
      banMember: jest.fn(),
      notifyModerators: jest.fn(),
    };
    const chatContextCache = createAdminAccessEpochCache({
      adminUserIds: ['existing-admin'],
    });
    const service = new ModerationService(
      prisma as never,
      ruleEngine as never,
      { resolveAction: jest.fn() } as never,
      maxClient as never,
      chatContextCache as never,
    );

    await service.handleUpdate(createUpdate());

    expect(maxClient.getChatMembersAccess).toHaveBeenCalledTimes(1);
    expect(maxClient.deleteMessage).not.toHaveBeenCalled();
    expect(maxClient.sendMessage).not.toHaveBeenCalled();
    expect(prisma.moderationEvent.create).not.toHaveBeenCalled();
  });

  it('fails open for the message when text duplicate admin access stays unresolved', async () => {
    const prisma = {
      violation: { create: jest.fn() },
      moderationEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
      webhookEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };
    const ruleEngine = {
      detect: jest.fn().mockResolvedValue({
        violations: [],
        duplicateDecision: {
          action: 'BAN',
          count: 4,
          threshold: 4,
          windowSec: 12 * 60 * 60,
          hash: 'unresolved-admin-duplicate',
          fingerprintType: 'exact',
          nextAction: null,
        },
      }),
    };
    const maxClient = {
      deleteMessage: jest.fn(),
      getChatMembersAccess: jest.fn().mockRejectedValue(new Error('MAX unavailable')),
      sendMessage: jest.fn(),
      kickMember: jest.fn(),
      banMember: jest.fn(),
      notifyModerators: jest.fn(),
    };
    const chatContextCache = createAdminAccessEpochCache({
      adminUserIds: ['existing-admin'],
    });
    const service = new ModerationService(
      prisma as never,
      ruleEngine as never,
      { resolveAction: jest.fn() } as never,
      maxClient as never,
      chatContextCache as never,
    );
    const warnSpy = jest
      .spyOn(
        (service as unknown as { logger: { warn: (...args: unknown[]) => void } }).logger,
        'warn',
      )
      .mockImplementation(() => undefined);

    try {
      await service.handleUpdate(createUpdate());
    } finally {
      warnSpy.mockRestore();
    }

    expect(maxClient.getChatMembersAccess).toHaveBeenCalled();
    expect(maxClient.deleteMessage).not.toHaveBeenCalled();
    expect(maxClient.banMember).not.toHaveBeenCalled();
    expect(maxClient.sendMessage).not.toHaveBeenCalled();
    expect(prisma.moderationEvent.create).not.toHaveBeenCalled();
  });

  it('runs Karavan storefront relay for a forwarded dollar-prefixed seller post after violation admin recheck', async () => {
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings(),
          domains: [],
          admins: [{ userId: 'existing-admin' }],
        }),
      },
      violation: {
        create: jest.fn(),
      },
      moderationEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
      webhookEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };
    installRemoteAdminProbeFence(prisma);
    const ruleEngine = {
      detect: jest.fn().mockResolvedValue({
        violations: [{ ruleCode: 'LINK_BLOCKED', score: 0.9, reason: 'Blocked link' }],
      }),
    };
    const sanctionService = {
      resolveAction: jest.fn(),
    };
    const maxClient = {
      deleteMessage: jest.fn(),
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
      sendMessage: jest.fn(),
      kickMember: jest.fn(),
      banMember: jest.fn(),
      notifyModerators: jest.fn(),
    };
    const karavanStorefrontRelayService = {
      handleMessageCreated: jest.fn().mockResolvedValue('handled'),
    };
    const chatContextCache = createAdminAccessEpochCache({
      adminUserIds: ['existing-admin'],
    });
    const baseUpdate = createUpdate();
    const update = {
      ...baseUpdate,
      message: {
        ...baseUpdate.message!,
        text: '$ Овощной Кирова 12Г',
      },
      raw: {
        message: {
          body: {
            text: '',
          },
          link: {
            type: 'forward',
            sender: {
              user_id: 'user-1',
            },
            message: {
              text: '$ Овощной Кирова 12Г',
            },
          },
        },
      },
    };

    const service = new ModerationService(
      prisma as never,
      ruleEngine as never,
      sanctionService as never,
      maxClient as never,
      chatContextCache as never,
    );
    (
      service as unknown as {
        karavanStorefrontRelayService: typeof karavanStorefrontRelayService;
      }
    ).karavanStorefrontRelayService = karavanStorefrontRelayService;

    await service.handleUpdate(update);

    expect(maxClient.getChatMembersAccess).toHaveBeenCalledTimes(1);
    expect(karavanStorefrontRelayService.handleMessageCreated).toHaveBeenCalledWith({
      updateType: 'message_created',
      karavanStorefrontEnabled: false,
      storefrontTexts: expect.objectContaining({
        karavanStorefrontMessageText: '',
        karavanStorefrontOpenButtonText: '',
        karavanStorefrontCatalogButtonText: '',
        karavanStorefrontCreateButtonText: '',
      }),
      chatId: 'chat-1',
      messageId: 'msg-1',
      senderId: 'user-1',
      senderName: 'Алексей',
      text: '$ Овощной Кирова 12Г',
      raw: update.raw,
      botId: null,
    });
    expect(maxClient.deleteMessage).not.toHaveBeenCalled();
    expect(maxClient.sendMessage).not.toHaveBeenCalled();
    expect(prisma.violation.create).not.toHaveBeenCalled();
    expect(prisma.moderationEvent.create).not.toHaveBeenCalled();
    expect(sanctionService.resolveAction).not.toHaveBeenCalled();
  });

  it('caps ordinary remote admin lookup wait time when local admins are unknown', async () => {
    jest.useFakeTimers();
    let loggerWarnSpy: jest.SpyInstance | undefined;
    try {
      const maxClient = {
        getChatMembersAccess: jest.fn().mockImplementation(
          () =>
            new Promise<Map<string, unknown>>(() => {
              // Intentionally never resolves within the soft timeout window.
            }),
        ),
        getCurrentChatMemberAccess: jest.fn(),
      };
      const service = new ModerationService(
        {} as never,
        { detect: jest.fn() } as never,
        { resolveAction: jest.fn() } as never,
        maxClient as never,
        {
          getAdminAccess: jest.fn().mockResolvedValue(null),
        } as never,
      );
      loggerWarnSpy = jest
        .spyOn(
          (service as unknown as { logger: { warn: (...args: unknown[]) => void } }).logger,
          'warn',
        )
        .mockImplementation(() => undefined);

      const pendingCheck = (service as any).resolveSenderChatAdminCheck('chat-1', [], 'user-1', {
        allowRemoteLookup: true,
        skipRemoteLookupWhenLocalAdminsKnown: true,
        remoteLookupSoftTimeoutMs: 500,
      });

      await jest.advanceTimersByTimeAsync(500);

      await expect(pendingCheck).resolves.toEqual({
        isAdmin: false,
        source: 'local_fallback',
      });
      expect(maxClient.getChatMembersAccess).toHaveBeenCalledWith(
        'chat-1',
        ['user-1'],
        expect.objectContaining({
          trafficClass: 'interactive',
          actionHealthLane: 'background',
          timeoutMs: 2000,
          ignoreFailureMetricStatuses: [403, 404],
        }),
      );
      await jest.advanceTimersByTimeAsync(3_000);
      await Promise.resolve();
    } finally {
      loggerWarnSpy?.mockRestore();
      jest.useRealTimers();
    }
  });

  it('adds provisional chat backoff after a soft-timed remote admin lookup', async () => {
    jest.useFakeTimers();
    let loggerWarnSpy: jest.SpyInstance | undefined;
    try {
      const maxClient = {
        getChatMembersAccess: jest.fn().mockImplementation(
          () =>
            new Promise<Map<string, unknown>>(() => {
              // Intentionally never resolves within the soft timeout window.
            }),
        ),
        getCurrentChatMemberAccess: jest.fn(),
      };
      const service = new ModerationService(
        {} as never,
        { detect: jest.fn() } as never,
        { resolveAction: jest.fn() } as never,
        maxClient as never,
        {
          getAdminAccess: jest.fn().mockResolvedValue(null),
        } as never,
        undefined,
        {
          get: jest.fn((key: string) => {
            if (key === 'CHAT_ADMIN_LOOKUP_TIMEOUT_MS') {
              return 10_000;
            }
            return undefined;
          }),
        } as never,
      );
      loggerWarnSpy = jest
        .spyOn(
          (service as unknown as { logger: { warn: (...args: unknown[]) => void } }).logger,
          'warn',
        )
        .mockImplementation(() => undefined);
      const options = {
        allowRemoteLookup: true,
        skipRemoteLookupWhenLocalAdminsKnown: true,
        remoteLookupSoftTimeoutMs: 500,
      };

      const first = (service as any).resolveSenderChatAdminCheck('chat-1', [], 'user-1', options);
      await jest.advanceTimersByTimeAsync(500);
      await expect(first).resolves.toEqual({
        isAdmin: false,
        source: 'local_fallback',
      });
      expect(maxClient.getChatMembersAccess).toHaveBeenCalledTimes(1);

      await expect(
        (service as any).resolveSenderChatAdminCheck('chat-1', [], 'user-2', options),
      ).resolves.toEqual({
        isAdmin: false,
        source: 'local_fallback',
      });
      expect(maxClient.getChatMembersAccess).toHaveBeenCalledTimes(1);

      await jest.advanceTimersByTimeAsync(5_000);

      const third = (service as any).resolveSenderChatAdminCheck('chat-1', [], 'user-3', options);
      await jest.advanceTimersByTimeAsync(500);
      await expect(third).resolves.toEqual({
        isAdmin: false,
        source: 'local_fallback',
      });
      expect(maxClient.getChatMembersAccess).toHaveBeenCalledTimes(2);
      await jest.advanceTimersByTimeAsync(11_000);
      await Promise.resolve();
    } finally {
      loggerWarnSpy?.mockRestore();
      jest.useRealTimers();
    }
  });

  it('keeps synchronous remote admin lookup for forwarded moderation commands when local admins are unknown', async () => {
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings({
            muteDurationHours: 12,
            deleteBotMessagesEnabled: true,
            deleteBotMessagesDelayMinutes: 3,
          }),
          domains: [],
          admins: [],
        }),
      },
      violation: {
        create: jest.fn(),
      },
      moderationEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
      webhookEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };
    installRemoteAdminProbeFence(prisma);
    const ruleEngine = {
      detect: jest.fn(),
    };
    const sanctionService = {
      resolveAction: jest.fn(),
    };
    const maxClient = {
      deleteMessage: jest.fn(),
      getChatAdminIds: jest.fn().mockResolvedValue(['admin-1']),
      sendMessage: jest.fn(),
      kickMember: jest.fn(),
      banMember: jest.fn(),
      notifyModerators: jest.fn(),
    };
    const adminService = {
      enqueueManualGroupModerationCommand: jest.fn().mockResolvedValue(true),
      applyManualSystemBan: jest.fn(),
    };

    const service = createModerationServiceWithManualBridge({
      prisma,
      ruleEngine,
      sanctionService,
      maxClient,
      manualBridge: adminService,
      chatContextCache: createAdminAccessEpochCache({
        settings: createSettings({
          muteDurationHours: 12,
          deleteBotMessagesEnabled: true,
          deleteBotMessagesDelayMinutes: 3,
        }),
      }),
    });

    await service.handleUpdate(createAdminForwardedBanUpdate());

    expect(maxClient.getChatAdminIds).toHaveBeenCalledTimes(1);
    expect(adminService.enqueueManualGroupModerationCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceChatId: 'chat-1',
        targetUserId: 'user-2',
        targetMessageId: 'mid-forward-ban-1',
        commandMessageId: 'msg-admin-forward-ban-1',
        action: 'BAN',
        actor: expect.objectContaining({
          userId: 'admin-1',
          chatId: 'chat-1',
        }),
      }),
    );
    expect(adminService.applyManualSystemBan).not.toHaveBeenCalled();
  });

  it('does not require a shared execution lock for owner-stamped shared chat updates', async () => {
    const maxBotLinkService = {
      getChatExecutionBinding: jest.fn(),
    };
    const maxBotContextService = {
      getActiveBotId: jest.fn().mockReturnValue('bot-1'),
    };
    const service = new ModerationService(
      {} as never,
      { detect: jest.fn() } as never,
      { resolveAction: jest.fn() } as never,
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
      ...createUpdate(),
      executionOwnerBotId: 'bot-1',
    } as MaxUpdate & { executionOwnerBotId: string };

    await expect(
      (service as any).resolveSharedChatExecutionGuard(update, '-68829672464520'),
    ).resolves.toEqual({
      mode: 'allow',
      activeBotId: 'bot-1',
      primaryBotId: 'bot-1',
      assignedBotIds: ['bot-1'],
      requiresExecutionLock: false,
      lockScope: 'owner',
    });

    expect(maxBotLinkService.getChatExecutionBinding).not.toHaveBeenCalled();
  });

  it('handles managed poll callbacks before the shared chat owner guard', async () => {
    const managedPollService = {
      tryHandleCallback: jest.fn().mockResolvedValue(true),
    };
    const service = new ModerationService(
      {} as never,
      { detect: jest.fn() } as never,
      { resolveAction: jest.fn() } as never,
      {} as never,
    );
    (service as any).managedPollService = managedPollService;
    const resolveSharedChatExecutionGuard = jest.fn().mockResolvedValue({ mode: 'skip' });
    (service as any).resolveSharedChatExecutionGuard = resolveSharedChatExecutionGuard;
    const baseUpdate = createGroupRulesCallbackUpdate({ botId: 'poll-publisher-bot' });
    const update = {
      ...baseUpdate,
      message: {
        ...baseUpdate.message!,
        chatId: 'channel-1',
        messageId: 'poll-message-1',
      },
      raw: {
        ...baseUpdate.raw,
        callback: {
          callback_id: 'poll-callback-1',
          payload: 'poll|v2|poll-1|option-1',
          user: { user_id: 'poll-voter-1' },
        },
      },
    } satisfies MaxUpdate;

    await service.handleUpdate(update);

    expect(managedPollService.tryHandleCallback).toHaveBeenCalledWith(update);
    expect(resolveSharedChatExecutionGuard).not.toHaveBeenCalled();
  });

  it('annotates bot moderation events with the active bot id when multi-bot context is available', () => {
    const maxBotContextService = {
      getActiveBotId: jest.fn().mockReturnValue('id613002203036_4_bot'),
    };
    const service = new ModerationService(
      {
        moderationEvent: {
          create: jest.fn(),
        },
      } as never,
      { detect: jest.fn() } as never,
      { resolveAction: jest.fn() } as never,
      {} as never,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      maxBotContextService as never,
    );

    expect(
      (service as any).withBotModerationEventData({
        chatId: 'chat-1',
        userId: 'user-1',
        eventType: EventType.MESSAGE,
        ruleCode: 'RULE_CODE',
        action: SanctionAction.DELETE_MESSAGE,
        operator: Operator.BOT,
      }),
    ).toEqual(
      expect.objectContaining({
        botId: 'id613002203036_4_bot',
      }),
    );
  });

  it('keeps the shared execution lock for binding-lookup shared chat updates', async () => {
    const maxBotLinkService = {
      getChatExecutionBinding: jest.fn().mockResolvedValue({
        chatId: '-68829672464520',
        activeBotId: 'bot-1',
        primaryBotId: 'bot-1',
        activeMembershipStatus: 'ACTIVE',
        assignedBotIds: ['bot-1', 'bot-2'],
        shouldHandleGroupUpdate: true,
      }),
    };
    const maxBotContextService = {
      getActiveBotId: jest.fn().mockReturnValue('bot-1'),
    };
    const service = new ModerationService(
      {} as never,
      { detect: jest.fn() } as never,
      { resolveAction: jest.fn() } as never,
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

    await expect(
      (service as any).resolveSharedChatExecutionGuard(createUpdate(), '-68829672464520'),
    ).resolves.toEqual({
      mode: 'allow',
      activeBotId: 'bot-1',
      primaryBotId: 'bot-1',
      assignedBotIds: ['bot-1', 'bot-2'],
      requiresExecutionLock: true,
      lockScope: 'owner',
    });

    expect(maxBotLinkService.getChatExecutionBinding).toHaveBeenCalledWith({
      chatId: '-68829672464520',
      activeBotId: 'bot-1',
    });
  });

  it('falls back to a conservative chat-scoped lock when shared binding lookup stalls', async () => {
    const maxBotLinkService = {
      getChatExecutionBinding: jest.fn(),
    };
    const maxBotContextService = {
      getActiveBotId: jest.fn().mockReturnValue('bot-1'),
    };
    const service = new ModerationService(
      {} as never,
      { detect: jest.fn() } as never,
      { resolveAction: jest.fn() } as never,
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
    (service as any).executeSharedChatOperationWithGuard = jest
      .fn()
      .mockRejectedValue(new Error('timed out'));

    await expect(
      (service as any).resolveSharedChatExecutionGuard(createUpdate(), '-68829672464520'),
    ).resolves.toEqual({
      mode: 'allow',
      activeBotId: 'bot-1',
      primaryBotId: null,
      assignedBotIds: ['bot-1'],
      requiresExecutionLock: true,
      lockScope: 'chat',
    });
  });

  it('does not wait indefinitely for redis shared execution lock release', async () => {
    jest.useFakeTimers();
    const redisCounter = {
      releaseLock: jest.fn().mockImplementation(
        () =>
          new Promise<void>(() => {
            // Intentionally never resolves within the release guard window.
          }),
      ),
    };
    const service = new ModerationService(
      {} as never,
      { detect: jest.fn() } as never,
      { resolveAction: jest.fn() } as never,
      {} as never,
      undefined,
      undefined,
      undefined,
      redisCounter as never,
    );
    const loggerWarnSpy = jest
      .spyOn((service as any).logger, 'warn')
      .mockImplementation(() => undefined);
    (service as any).sharedChatExecutionLockTimeoutMs = 25;

    try {
      const releasePromise = (service as any).releaseSharedChatExecutionLock({
        key: 'shared-chat-execution:v1:bot-1:chat-1:update-1',
        token: 'token-1',
        mode: 'redis',
      });

      await jest.advanceTimersByTimeAsync(25);
      await expect(releasePromise).resolves.toBeUndefined();
      expect(redisCounter.releaseLock).toHaveBeenCalledWith(
        'shared-chat-execution:v1:bot-1:chat-1:update-1',
        'token-1',
      );
      expect(loggerWarnSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          key: 'shared-chat-execution:v1:bot-1:chat-1:update-1',
          timeoutMs: 25,
        }),
        'Failed to release redis shared chat execution lock',
      );
    } finally {
      loggerWarnSpy.mockRestore();
      jest.useRealTimers();
    }
  });

  it('uses shared cache for remote chat admins to avoid MAX API call', async () => {
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings(),
          domains: [],
          admins: [],
        }),
      },
      violation: {
        create: jest.fn(),
      },
      moderationEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
      webhookEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };
    const ruleEngine = {
      detect: jest.fn().mockResolvedValue({
        violations: [{ ruleCode: 'LINK_BLOCKED', score: 0.9, reason: 'Blocked link' }],
      }),
    };
    const sanctionService = {
      resolveAction: jest.fn(),
    };
    const maxClient = {
      deleteMessage: jest.fn(),
      getChatAdminIds: jest.fn(),
      sendMessage: jest.fn(),
      kickMember: jest.fn(),
      banMember: jest.fn(),
      notifyModerators: jest.fn(),
    };
    const chatContextCache = {
      getChatContext: jest.fn().mockResolvedValue({
        chatId: 'chat-1',
        title: 'Chat 1',
        settings: createSettings(),
        domainAllowlist: [],
        adminUserIds: [],
        rulesPublishedUrl: null,
        rulesPublishedMessageId: null,
      }),
      getAdminAccess: jest
        .fn()
        .mockImplementation(async (_chatId: string, userId: string) =>
          userId === 'user-1' ? 'granted' : null,
        ),
    };

    const service = new ModerationService(
      prisma as never,
      ruleEngine as never,
      sanctionService as never,
      maxClient as never,
      chatContextCache as never,
    );

    await service.handleUpdate(createUpdate());

    expect(chatContextCache.getAdminAccess).toHaveBeenCalledWith('chat-1', 'user-1');
    expect(maxClient.getChatAdminIds).not.toHaveBeenCalled();
    expect(ruleEngine.detect).not.toHaveBeenCalled();
  });

  it('batches concurrent remote chat admin lookups within the same chat', async () => {
    const prisma = {};
    installRemoteAdminProbeFence(prisma);
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
      getCurrentChatMemberAccess: jest.fn(),
    };
    const chatContextCache = {
      getAdminAccess: jest.fn().mockResolvedValue(null),
      applyAdminAccessEpochMutation: jest.fn().mockResolvedValue(true),
      invalidate: jest.fn().mockResolvedValue(undefined),
    };
    const service = new ModerationService(
      prisma as never,
      { detect: jest.fn() } as never,
      { resolveAction: jest.fn() } as never,
      maxClient as never,
      chatContextCache as never,
    );

    const [first, second] = await Promise.all([
      (service as any).getRemoteChatAdminAccess('chat-1', 'user-1'),
      (service as any).getRemoteChatAdminAccess('chat-1', 'user-2'),
    ]);

    expect(first).toBe('granted');
    expect(second).toBe('user_denied');
    expect(maxClient.getChatMembersAccess).toHaveBeenCalledTimes(1);
    expect(maxClient.getChatMembersAccess).toHaveBeenCalledWith(
      'chat-1',
      ['user-1', 'user-2'],
      expect.objectContaining({
        trafficClass: 'interactive',
        actionHealthLane: 'background',
        ignoreFailureMetricStatuses: [403, 404],
      }),
    );
    expect(maxClient.getCurrentChatMemberAccess).not.toHaveBeenCalled();
  });

  it('routes remote chat admin lookups through the chat-bound bot when one is assigned', async () => {
    const prisma = {};
    installRemoteAdminProbeFence(prisma);
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
          [
            '214634783',
            {
              userId: '214634783',
              isAdmin: true,
              isOwner: false,
              permissions: [],
            },
          ],
        ]),
      ),
      getCurrentChatMemberAccess: jest.fn(),
    };
    const chatContextCache = {
      getAdminAccess: jest.fn().mockResolvedValue(null),
      applyAdminAccessEpochMutation: jest.fn().mockResolvedValue(true),
      invalidate: jest.fn().mockResolvedValue(undefined),
    };
    const maxBotLinkService = {
      resolveBotId: jest.fn().mockResolvedValue('id613002203036_4_bot'),
      resolveContactIdSync: jest.fn(),
    };
    const service = new ModerationService(
      prisma as never,
      { detect: jest.fn() } as never,
      { resolveAction: jest.fn() } as never,
      maxClient as never,
      chatContextCache as never,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      maxBotLinkService as never,
    );

    await expect((service as any).getRemoteChatAdminAccess('chat-1', 'user-1')).resolves.toBe(
      'granted',
    );

    expect(maxBotLinkService.resolveBotId).toHaveBeenCalledWith({ chatId: 'chat-1' });
    expect(maxClient.getChatMembersAccess).toHaveBeenCalledWith(
      'chat-1',
      ['user-1'],
      expect.objectContaining({
        trafficClass: 'interactive',
        actionHealthLane: 'background',
        ignoreFailureMetricStatuses: [403, 404],
        botId: 'id613002203036_4_bot',
      }),
    );
  });

  it('applies chat-level backoff after a throttled remote chat admin batch lookup', async () => {
    const prisma = {};
    const maxClient = {
      getChatMembersAccess: jest
        .fn()
        .mockRejectedValue(new Error('MAX API interactive rate limit exceeded')),
      getCurrentChatMemberAccess: jest.fn(),
    };
    const chatContextCache = {
      getAdminAccess: jest.fn().mockResolvedValue(null),
      applyAdminAccessEpochMutation: jest.fn().mockResolvedValue(true),
      invalidate: jest.fn().mockResolvedValue(undefined),
    };
    const service = new ModerationService(
      prisma as never,
      { detect: jest.fn() } as never,
      { resolveAction: jest.fn() } as never,
      maxClient as never,
      chatContextCache as never,
    );

    const [first, second] = await Promise.all([
      (service as any).getRemoteChatAdminAccess('chat-1', 'user-1'),
      (service as any).getRemoteChatAdminAccess('chat-1', 'user-2'),
    ]);
    const third = await (service as any).getRemoteChatAdminAccess('chat-1', 'user-3');

    expect(first).toBeNull();
    expect(second).toBeNull();
    expect(third).toBeNull();
    expect(maxClient.getChatMembersAccess).toHaveBeenCalledTimes(1);
  });

  it('handles duplicate escalation separately and does not call SanctionService', async () => {
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings(),
          domains: [],
        }),
      },
      violation: {
        create: jest.fn(),
      },
      moderationEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
      webhookEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };
    const ruleEngine = {
      detect: jest.fn().mockResolvedValue({
        violations: [],
        duplicateDecision: {
          action: 'MUTE',
          count: 3,
          threshold: 3,
          windowSec: 24 * 60 * 60,
          hash: 'abc123',
          nextAction: 'BAN',
        },
      }),
    };
    const sanctionService = {
      resolveAction: jest.fn(),
    };
    const maxClient = {
      deleteMessage: jest.fn(),
      sendMessage: jest.fn(),
      kickMember: jest.fn(),
      banMember: jest.fn(),
      notifyModerators: jest.fn(),
    };

    withAutomaticMutePersistenceFixture(prisma);
    const service = new ModerationService(
      prisma as never,
      ruleEngine as never,
      sanctionService as never,
      maxClient as never,
    );

    await service.handleUpdate(createUpdate());

    expect(prisma.violation.create).not.toHaveBeenCalled();
    expect(sanctionService.resolveAction).not.toHaveBeenCalled();
    expectImmediateDeleteMessage(maxClient.deleteMessage, 'chat-1', 'msg-1');
    expect(maxClient.sendMessage).toHaveBeenCalledWith(
      'chat-1',
      muteNotice('Алексей', '6ч'),
      expect.objectContaining({ textFormat: 'html' }),
      expect.objectContaining({
        trafficClass: 'interactive',
        actionHealthLane: 'interactive',
        sourceTag: 'moderation_notice',
      }),
    );
    expect(maxClient.kickMember).not.toHaveBeenCalled();
    expect(maxClient.banMember).not.toHaveBeenCalled();

    expect(prisma.moderationEvent.create).toHaveBeenCalledTimes(2);
    expect(prisma.moderationEvent.create).toHaveBeenNthCalledWith(1, {
      data: expect.objectContaining({
        chatId: 'chat-1',
        userId: 'user-1',
        messageId: 'msg-1',
        ruleCode: 'DUPLICATE_DELETE',
        action: SanctionAction.DELETE_MESSAGE,
      }),
    });
    expect(prisma.moderationEvent.create).toHaveBeenNthCalledWith(2, {
      data: expect.objectContaining({
        chatId: 'chat-1',
        userId: 'user-1',
        messageId: 'msg-1',
        ruleCode: 'DUPLICATE_MUTE',
        action: SanctionAction.MUTE,
        metadata: expect.objectContaining({
          windowSec: 24 * 60 * 60,
          count: 3,
          threshold: 3,
          nextStep: 'BAN',
        }),
      }),
    });
  });

  it('applies participant moderation immunity to text duplicates', async () => {
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings(),
          domains: [],
        }),
      },
      moderationEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
      webhookEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
      $queryRaw: jest.fn().mockResolvedValue([{ expires_at: null }]),
    };
    const ruleEngine = {
      detect: jest.fn().mockResolvedValue({
        violations: [],
        duplicateDecision: {
          action: 'MUTE',
          count: 3,
          threshold: 3,
          windowSec: 24 * 60 * 60,
          hash: 'duplicate-immunity',
          fingerprintType: 'exact',
          nextAction: 'BAN',
        },
      }),
    };
    const maxClient = {
      deleteMessage: jest.fn(),
      sendMessage: jest.fn(),
      kickMember: jest.fn(),
      banMember: jest.fn(),
      notifyModerators: jest.fn(),
    };
    const service = new ModerationService(
      prisma as never,
      ruleEngine as never,
      { resolveAction: jest.fn() } as never,
      maxClient as never,
    );

    await service.handleUpdate(createUpdate());

    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
    expect(maxClient.deleteMessage).not.toHaveBeenCalled();
    expect(maxClient.sendMessage).not.toHaveBeenCalled();
    expect(prisma.moderationEvent.create).not.toHaveBeenCalled();
  });

  it('sends duplicate explanation when duplicate bot toggle is enabled', async () => {
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings({ duplicateBotMessageEnabled: true }),
          domains: [],
        }),
      },
      violation: {
        create: jest.fn(),
      },
      moderationEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
      webhookEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };
    const ruleEngine = {
      detect: jest.fn().mockResolvedValue({
        violations: [],
        duplicateDecision: {
          action: 'WARN',
          count: 2,
          threshold: 2,
          windowSec: 12 * 60 * 60,
          hash: 'dup-hash-1',
          nextAction: 'MUTE',
        },
      }),
    };
    const sanctionService = {
      resolveAction: jest.fn(),
    };
    const maxClient = {
      deleteMessage: jest.fn(),
      sendMessage: jest.fn(),
      kickMember: jest.fn(),
      banMember: jest.fn(),
      notifyModerators: jest.fn(),
    };

    const service = new ModerationService(
      prisma as never,
      ruleEngine as never,
      sanctionService as never,
      maxClient as never,
    );

    await service.handleUpdate(createUpdate());

    expectImmediateDeleteMessage(maxClient.deleteMessage, 'chat-1', 'msg-1');
    expect(maxClient.sendMessage).toHaveBeenCalledTimes(1);
    (expect(maxClient.sendMessage) as any).toHaveBeenCalledWithPrefix(
      'chat-1',
      duplicateExplanation(
        'Алексей',
        'Вынесено предупреждение. Копию в трёх экземплярах здесь не требуют.',
      ),
    );
  });

  it('sends duplicate explanation in degrade mode when duplicate bot toggle is enabled', async () => {
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings({ duplicateBotMessageEnabled: true }),
          domains: [],
        }),
      },
      violation: {
        create: jest.fn(),
      },
      moderationEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
      webhookEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };
    const ruleEngine = {
      detect: jest.fn().mockResolvedValue({
        violations: [],
        duplicateHit: {
          count: 1,
          windowSec: 60,
          hash: 'dup-hit-degrade-1',
        },
      }),
    };
    const sanctionService = {
      resolveAction: jest.fn(),
    };
    const maxClient = {
      deleteMessage: jest.fn(),
      sendMessage: jest.fn(),
      kickMember: jest.fn(),
      banMember: jest.fn(),
      notifyModerators: jest.fn(),
    };
    const systemModeService = {
      getSnapshot: jest.fn().mockReturnValue({
        mode: 'degrade',
        source: 'auto',
        reason: 'queue lag',
        updatedAt: new Date().toISOString(),
        manualMode: null,
        queueLagSec: 20,
        action: {
          windowSec: 60,
          total: 100,
          success: 96,
          failure: 4,
          critical: 0,
          errorRate: 0.04,
          criticalRate: 0,
        },
      }),
    };

    const service = new ModerationService(
      prisma as never,
      ruleEngine as never,
      sanctionService as never,
      maxClient as never,
      undefined,
      systemModeService as never,
    );

    await service.handleUpdate(createUpdate());

    (expect(maxClient.sendMessage) as any).toHaveBeenCalledWithPrefix(
      'chat-1',
      duplicateExplanation('Алексей', 'Копия удалена. Для протокола достаточно одного экземпляра.'),
    );
  });

  it('does not report duplicate-state throttling when anti-duplicate is disabled', async () => {
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings({ antiDuplicateEnabled: false }),
          domains: [],
        }),
      },
      violation: { create: jest.fn() },
      moderationEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
      webhookEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };
    const ruleEngine = { detect: jest.fn().mockResolvedValue({ violations: [] }) };
    const systemModeService = {
      getSnapshot: jest.fn().mockReturnValue({
        mode: 'degrade',
        source: 'auto',
        reason: 'queue lag',
        updatedAt: new Date().toISOString(),
        manualMode: null,
        queueLagSec: 20,
        action: {
          windowSec: 60,
          total: 100,
          success: 96,
          failure: 4,
          critical: 0,
          errorRate: 0.04,
          criticalRate: 0,
        },
      }),
    };
    const service = new ModerationService(
      prisma as never,
      ruleEngine as never,
      { resolveAction: jest.fn() } as never,
      {
        deleteMessage: jest.fn(),
        sendMessage: jest.fn(),
        kickMember: jest.fn(),
        banMember: jest.fn(),
        notifyModerators: jest.fn(),
      } as never,
      undefined,
      systemModeService as never,
    );
    const warnSpy = jest
      .spyOn(
        (service as unknown as { logger: { warn: (...args: unknown[]) => void } }).logger,
        'warn',
      )
      .mockImplementation(() => undefined);

    try {
      await service.handleUpdate(createUpdate());

      expect(ruleEngine.detect).toHaveBeenCalledWith(
        expect.objectContaining({ skipDuplicateState: false }),
      );
      expect(
        warnSpy.mock.calls.some(
          ([context]) =>
            (context as { stage?: unknown } | undefined)?.stage === 'rule-engine.duplicate-state',
        ),
      ).toBe(false);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('classifies only out-of-window and materially future duplicate event times as unsafe', () => {
    const nowMs = Date.parse('2026-09-05T12:00:00.000Z');
    const classify = (eventTimestampMs: number) =>
      classifyDuplicateEventTime({
        eventTimestampMs,
        windowSec: 3_600,
        nowMs,
      });

    expect(classify(nowMs - 3_599_999)).toBeNull();
    expect(classify(nowMs - 3_600_000)).toContain('outside the 3600s window');
    expect(classify(nowMs - 3_600_001)).toContain('outside the 3600s window');
    expect(classify(nowMs + 60_000)).toBeNull();
    expect(classify(nowMs + 60_001)).toContain('ahead of the server clock');
  });

  it('skips unsafe duplicate event times but still handles a delayed event inside the configured window', async () => {
    const nowMs = Date.parse('2026-09-05T12:00:00.000Z');
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(nowMs);
    const settings = createSettings({
      duplicateBotMessageEnabled: false,
      duplicateWarnWindowSec: 3_600,
    });
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings,
          domains: [],
        }),
      },
      violation: { create: jest.fn() },
      moderationEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
      webhookEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };
    const ruleEngine = {
      detect: jest.fn(async (params: { skipDuplicateState?: boolean }) =>
        params.skipDuplicateState
          ? { violations: [], duplicateStateSkipped: true }
          : {
              violations: [],
              duplicateHit: {
                count: 1,
                windowSec: 3_600,
                hash: 'delayed-inside-window',
                fingerprintType: 'exact',
              },
            },
      ),
    };
    const maxClient = {
      deleteMessage: jest.fn().mockResolvedValue(undefined),
      sendMessage: jest.fn(),
      kickMember: jest.fn(),
      banMember: jest.fn(),
      notifyModerators: jest.fn(),
    };
    const service = new ModerationService(
      prisma as never,
      ruleEngine as never,
      { resolveAction: jest.fn() } as never,
      maxClient as never,
    );
    const warnSpy = jest
      .spyOn(
        (service as unknown as { logger: { warn: (...args: unknown[]) => void } }).logger,
        'warn',
      )
      .mockImplementation(() => undefined);
    const staleUpdate = createUpdate();
    staleUpdate.eventTimestampSource = 'payload';
    staleUpdate.message!.messageId = 'stale-message';
    staleUpdate.message!.createdAt = new Date(nowMs - 3_600_001).toISOString();
    const futureUpdate = createUpdate();
    futureUpdate.eventTimestampSource = 'payload';
    futureUpdate.message!.messageId = 'future-message';
    futureUpdate.message!.createdAt = new Date(nowMs + 60_001).toISOString();
    const delayedUpdate = createUpdate();
    delayedUpdate.eventTimestampSource = 'payload';
    delayedUpdate.message!.messageId = 'delayed-message';
    delayedUpdate.message!.createdAt = new Date(nowMs - 3_599_999).toISOString();

    try {
      await service.handleUpdate(staleUpdate);
      await service.handleUpdate(futureUpdate);
      await service.handleUpdate(delayedUpdate);
    } finally {
      warnSpy.mockRestore();
      nowSpy.mockRestore();
    }

    expect(ruleEngine.detect).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ skipDuplicateState: true }),
    );
    expect(ruleEngine.detect).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ skipDuplicateState: true }),
    );
    expect(ruleEngine.detect).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({ skipDuplicateState: false }),
    );
    expectImmediateDeleteMessage(maxClient.deleteMessage, 'chat-1', 'delayed-message');
    expect(maxClient.deleteMessage).toHaveBeenCalledTimes(1);
  });

  it('keeps duplicate moderation active during chat hot-timeout backoff while the system is healthy', async () => {
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings({ duplicateBotMessageEnabled: true }),
          domains: [],
        }),
      },
      violation: {
        create: jest.fn(),
      },
      moderationEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
      webhookEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };
    const ruleEngine = {
      detect: jest.fn().mockResolvedValue({
        violations: [],
        duplicateHit: {
          count: 1,
          windowSec: 60,
          hash: 'dup-hit-hot-chat-1',
        },
      }),
    };
    const maxClient = {
      deleteMessage: jest.fn(),
      sendMessage: jest.fn(),
      kickMember: jest.fn(),
      banMember: jest.fn(),
      notifyModerators: jest.fn(),
    };

    const service = new ModerationService(
      prisma as never,
      ruleEngine as never,
      { resolveAction: jest.fn() } as never,
      maxClient as never,
    );
    (service as any).webhookHotTimeoutChatBackoffUntilMs.set('chat-1', Date.now() + 60_000);

    await service.handleUpdate(createUpdate());

    expectImmediateDeleteMessage(maxClient.deleteMessage, 'chat-1', 'msg-1');
    expect(maxClient.sendMessage).not.toHaveBeenCalled();
  });

  it('sends duplicate explanation with inline button when button toggle is enabled', async () => {
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings({
            duplicateBotMessageEnabled: true,
            duplicateBotButtonEnabled: true,
            duplicateBotButtonUrl: 'https://max.ru/help/bots',
            duplicateBotButtonText: 'Правила',
          }),
          domains: [],
        }),
      },
      violation: {
        create: jest.fn(),
      },
      moderationEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
      webhookEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };
    const ruleEngine = {
      detect: jest.fn().mockResolvedValue({
        violations: [],
        duplicateDecision: {
          action: 'WARN',
          count: 2,
          threshold: 2,
          windowSec: 12 * 60 * 60,
          hash: 'dup-hash-button',
          nextAction: 'MUTE',
        },
      }),
    };
    const sanctionService = {
      resolveAction: jest.fn(),
    };
    const maxClient = {
      deleteMessage: jest.fn(),
      sendMessage: jest.fn(),
      kickMember: jest.fn(),
      banMember: jest.fn(),
      notifyModerators: jest.fn(),
    };

    const service = new ModerationService(
      prisma as never,
      ruleEngine as never,
      sanctionService as never,
      maxClient as never,
    );

    await service.handleUpdate(createUpdate());

    (expect(maxClient.sendMessage) as any).toHaveBeenCalledWithPrefix(
      'chat-1',
      duplicateExplanation(
        'Алексей',
        'Вынесено предупреждение. Копию в трёх экземплярах здесь не требуют.',
      ),
      {
        button: {
          text: 'Правила',
          url: 'https://max.ru/help/bots',
        },
        textFormat: 'html',
        marketplacePublication: {
          entityId: 'chat-1',
          purpose: 'MODERATION_NOTICE',
          module: 'DUPLICATES',
        },
      },
    );
  });

  it('sends permanent ban notice for duplicate BAN even when duplicate toggle is disabled', async () => {
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings({ duplicateBotMessageEnabled: false }),
          domains: [],
        }),
      },
      violation: {
        create: jest.fn(),
      },
      moderationEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
      webhookEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };
    const ruleEngine = {
      detect: jest.fn().mockResolvedValue({
        violations: [],
        duplicateDecision: {
          action: 'BAN',
          count: 4,
          threshold: 4,
          windowSec: 48 * 60 * 60,
          hash: 'dup-ban-1',
          nextAction: null,
        },
      }),
    };
    const sanctionService = {
      resolveAction: jest.fn(),
    };
    const maxClient = {
      deleteMessage: jest.fn(),
      sendMessage: jest.fn(),
      kickMember: jest.fn(),
      banMember: jest.fn(),
      notifyModerators: jest.fn(),
    };

    const service = new ModerationService(
      prisma as never,
      ruleEngine as never,
      sanctionService as never,
      maxClient as never,
    );

    await service.handleUpdate(createUpdate());

    expectImmediateDeleteMessage(maxClient.deleteMessage, 'chat-1', 'msg-1');
    expectImmediateBanMember(maxClient.banMember, 'chat-1', 'user-1');
    expect(maxClient.sendMessage).toHaveBeenCalledTimes(1);
    (expect(maxClient.sendMessage) as any).toHaveBeenCalledWithPrefix(
      'chat-1',
      permanentBanNotice('Алексей'),
    );
    expect(maxClient.sendMessage).toHaveBeenCalledWith(
      'chat-1',
      expect.any(String),
      expect.any(Object),
      expect.objectContaining({ immediate: true, immediateFailurePolicy: 'terminal' }),
    );
  });

  it('uses permanent ban notice for duplicate BAN regardless of mute duration', async () => {
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings({ duplicateBotMessageEnabled: false, muteDurationHours: 12 }),
          domains: [],
        }),
      },
      violation: {
        create: jest.fn(),
      },
      moderationEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
      webhookEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };
    const ruleEngine = {
      detect: jest.fn().mockResolvedValue({
        violations: [],
        duplicateDecision: {
          action: 'BAN',
          count: 4,
          threshold: 4,
          windowSec: 48 * 60 * 60,
          hash: 'dup-ban-12h',
          nextAction: null,
        },
      }),
    };
    const sanctionService = {
      resolveAction: jest.fn(),
    };
    const maxClient = {
      deleteMessage: jest.fn(),
      sendMessage: jest.fn(),
      kickMember: jest.fn(),
      banMember: jest.fn(),
      notifyModerators: jest.fn(),
    };

    const service = new ModerationService(
      prisma as never,
      ruleEngine as never,
      sanctionService as never,
      maxClient as never,
    );

    await service.handleUpdate(createUpdate());

    expectImmediateBanMember(maxClient.banMember, 'chat-1', 'user-1');
    (expect(maxClient.sendMessage) as any).toHaveBeenCalledWithPrefix(
      'chat-1',
      permanentBanNotice('Алексей'),
    );
  });

  it('deletes duplicate hit and sends explanation before WARN stage', async () => {
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings({ duplicateBotMessageEnabled: true }),
          domains: [],
        }),
      },
      violation: {
        create: jest.fn(),
      },
      moderationEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
      webhookEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };
    const ruleEngine = {
      detect: jest.fn().mockResolvedValue({
        violations: [],
        duplicateHit: {
          count: 1,
          windowSec: 60,
          hash: 'dup-hit-1',
        },
      }),
    };
    const sanctionService = {
      resolveAction: jest.fn(),
    };
    const maxClient = {
      deleteMessage: jest.fn(),
      sendMessage: jest.fn(),
      kickMember: jest.fn(),
      banMember: jest.fn(),
      notifyModerators: jest.fn(),
    };

    const service = new ModerationService(
      prisma as never,
      ruleEngine as never,
      sanctionService as never,
      maxClient as never,
    );

    await service.handleUpdate(createUpdate());

    expect(sanctionService.resolveAction).not.toHaveBeenCalled();
    expectImmediateDeleteMessage(maxClient.deleteMessage, 'chat-1', 'msg-1');
    expect(maxClient.sendMessage).toHaveBeenCalledTimes(1);
    (expect(maxClient.sendMessage) as any).toHaveBeenCalledWithPrefix(
      'chat-1',
      duplicateExplanation('Алексей', 'Копия удалена. Для протокола достаточно одного экземпляра.'),
    );
    expect(maxClient.kickMember).not.toHaveBeenCalled();
    expect(maxClient.banMember).not.toHaveBeenCalled();
    expect(prisma.moderationEvent.create).toHaveBeenCalledTimes(1);
    expect(prisma.moderationEvent.create).toHaveBeenNthCalledWith(1, {
      data: expect.objectContaining({
        chatId: 'chat-1',
        userId: 'user-1',
        messageId: 'msg-1',
        ruleCode: 'DUPLICATE_DELETE',
        action: SanctionAction.DELETE_MESSAGE,
      }),
    });
  });

  it('detaches duplicate follow-up when bot notice delivery exceeds the hot-path budget', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-07-03T10:00:00.000Z'));
    const runtimeDiagnosticsService = {
      recordHotPathStageOutcome: jest.fn(),
      recordHotPathProfile: jest.fn(),
    };
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings({ duplicateBotMessageEnabled: true }),
          domains: [],
        }),
      },
      violation: {
        create: jest.fn(),
      },
      moderationEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
      webhookEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };
    const ruleEngine = {
      detect: jest.fn().mockResolvedValue({
        violations: [],
        duplicateHit: {
          count: 1,
          windowSec: 60,
          hash: 'dup-hit-slow-follow-up',
        },
      }),
    };
    const maxClient = {
      deleteMessage: jest.fn().mockResolvedValue(undefined),
      sendMessage: jest.fn(
        () =>
          new Promise(() => {
            // Intentionally never resolves.
          }),
      ),
      kickMember: jest.fn(),
      banMember: jest.fn(),
      notifyModerators: jest.fn(),
    };
    const service = new ModerationService(
      prisma as never,
      ruleEngine as never,
      { resolveAction: jest.fn() } as never,
      maxClient as never,
      undefined,
      undefined,
      {
        get: jest.fn((key: string) =>
          key === 'WEBHOOK_USER_FACING_TIMEOUT_MS' ? 10_000 : undefined,
        ),
      } as never,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      runtimeDiagnosticsService as never,
    );
    (service as any).webhookUserFacingTimeoutMs = 10_000;
    const debugSpy = jest
      .spyOn((service as any).logger, 'debug')
      .mockImplementation(() => undefined);
    const hotPathProfile = (service as any).createWebhookHotPathProfile();

    try {
      const result = service.handleUpdate(createUpdate(), hotPathProfile);

      await Promise.resolve();
      await Promise.resolve();
      await jest.advanceTimersByTimeAsync(DUPLICATE_FOLLOW_UP_HOT_PATH_TIMEOUT_MS);
      await expect(result).resolves.toBeUndefined();

      expectImmediateDeleteMessage(maxClient.deleteMessage, 'chat-1', 'msg-1');
      expect(prisma.moderationEvent.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          chatId: 'chat-1',
          userId: 'user-1',
          messageId: 'msg-1',
          ruleCode: 'DUPLICATE_DELETE',
          action: SanctionAction.DELETE_MESSAGE,
        }),
      });
      expect(maxClient.sendMessage).toHaveBeenCalledTimes(1);

      const snapshot = (service as any).readWebhookHotPathProfileSnapshot(hotPathProfile);
      expect(snapshot).toMatchObject({
        latestStage: 'duplicate-follow-up',
        successBoundaryReached: true,
        successBoundaryStage: 'duplicate-delete',
      });
      expect(runtimeDiagnosticsService.recordHotPathStageOutcome).toHaveBeenCalledWith({
        stage: 'duplicate-follow-up.deferred',
        outcome: 'skip',
        failOpen: true,
      });
      expect(runtimeDiagnosticsService.recordHotPathStageOutcome).toHaveBeenCalledWith({
        stage: 'follow_up_deferred',
        outcome: 'skip',
        failOpen: true,
      });
      expect(debugSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          stage: 'duplicate-follow-up',
          chatId: 'chat-1',
          userId: 'user-1',
          messageId: 'msg-1',
          timeoutMs: DUPLICATE_FOLLOW_UP_HOT_PATH_TIMEOUT_MS,
        }),
        'Detached webhook follow-up after hot-path budget window',
      );
    } finally {
      debugSpy.mockRestore();
      jest.useRealTimers();
    }
  });

  it('applies duplicate mute before a slow optional duplicate explanation exhausts the follow-up budget', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-07-03T10:00:00.000Z'));
    const runtimeDiagnosticsService = {
      recordHotPathStageOutcome: jest.fn(),
      recordHotPathProfile: jest.fn(),
    };
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings({ duplicateBotMessageEnabled: true }),
          domains: [],
        }),
      },
      violation: {
        create: jest.fn(),
      },
      moderationEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
      webhookEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };
    const ruleEngine = {
      detect: jest.fn().mockResolvedValue({
        violations: [],
        duplicateDecision: {
          action: 'MUTE',
          count: 3,
          threshold: 3,
          windowSec: 24 * 60 * 60,
          hash: 'dup-mute-slow-explanation',
          nextAction: 'BAN',
        },
      }),
    };
    const maxClient = {
      deleteMessage: jest.fn().mockResolvedValue(undefined),
      sendMessage: jest
        .fn()
        .mockResolvedValueOnce(undefined)
        .mockImplementationOnce(
          () =>
            new Promise(() => {
              // Intentionally never resolves.
            }),
        ),
      kickMember: jest.fn(),
      banMember: jest.fn(),
      notifyModerators: jest.fn(),
    };
    withAutomaticMutePersistenceFixture(prisma);
    const service = new ModerationService(
      prisma as never,
      ruleEngine as never,
      { resolveAction: jest.fn() } as never,
      maxClient as never,
      undefined,
      undefined,
      {
        get: jest.fn((key: string) =>
          key === 'WEBHOOK_USER_FACING_TIMEOUT_MS' ? 10_000 : undefined,
        ),
      } as never,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      runtimeDiagnosticsService as never,
    );
    (service as any).webhookUserFacingTimeoutMs = 10_000;
    const debugSpy = jest
      .spyOn((service as any).logger, 'debug')
      .mockImplementation(() => undefined);
    const hotPathProfile = (service as any).createWebhookHotPathProfile();

    try {
      const result = service.handleUpdate(createUpdate(), hotPathProfile);

      await Promise.resolve();
      await Promise.resolve();
      await jest.advanceTimersByTimeAsync(DUPLICATE_FOLLOW_UP_HOT_PATH_TIMEOUT_MS);
      await expect(result).resolves.toBeUndefined();

      expectImmediateDeleteMessage(maxClient.deleteMessage, 'chat-1', 'msg-1');
      expect(maxClient.sendMessage).toHaveBeenCalledTimes(2);
      (expect(maxClient.sendMessage) as any).toHaveBeenCalledWithPrefix(
        'chat-1',
        muteNotice('Алексей', '6ч'),
      );
      (expect(maxClient.sendMessage) as any).toHaveBeenCalledWithPrefix(
        'chat-1',
        duplicateExplanation('Алексей', 'Назначен мут на 6ч.'),
      );
      expect(prisma.moderationEvent.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          chatId: 'chat-1',
          userId: 'user-1',
          messageId: 'msg-1',
          ruleCode: 'DUPLICATE_MUTE',
          action: SanctionAction.MUTE,
        }),
      });
      expect(runtimeDiagnosticsService.recordHotPathStageOutcome).toHaveBeenCalledWith({
        stage: 'duplicate-follow-up.deferred',
        outcome: 'skip',
        failOpen: true,
      });
      expect(debugSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          stage: 'duplicate-follow-up',
          chatId: 'chat-1',
          userId: 'user-1',
          messageId: 'msg-1',
          timeoutMs: DUPLICATE_FOLLOW_UP_HOT_PATH_TIMEOUT_MS,
        }),
        'Detached webhook follow-up after hot-path budget window',
      );
    } finally {
      debugSpy.mockRestore();
      jest.useRealTimers();
    }
  });

  it.each(['WARN', 'MUTE', 'BAN'] as const)(
    'keeps handleUpdate pending for critical duplicate %s after the optional budget is exhausted',
    async (duplicateAction) => {
      let finishSanction!: (persisted: boolean) => void;
      const sanction = new Promise<boolean>((resolve) => {
        finishSanction = resolve;
      });
      const prisma = {
        chat: {
          upsert: jest.fn().mockResolvedValue({
            id: 'chat-1',
            title: 'Chat 1',
            settings: createSettings({ duplicateBotMessageEnabled: false }),
            domains: [],
          }),
        },
        violation: { create: jest.fn() },
        moderationEvent: {
          findFirst: jest.fn().mockResolvedValue(null),
          create: jest.fn(),
        },
        webhookEvent: {
          findUnique: jest.fn(),
          update: jest.fn(),
        },
      };
      const ruleEngine = {
        detect: jest.fn().mockResolvedValue({
          violations: [],
          duplicateDecision: {
            action: duplicateAction,
            count: 4,
            threshold: 2,
            windowSec: 60,
            hash: `duplicate-critical-${duplicateAction.toLowerCase()}`,
            fingerprintType: 'exact',
            nextAction: null,
          },
        }),
      };
      const maxClient = {
        deleteMessage: jest.fn().mockResolvedValue(undefined),
        sendMessage: jest.fn(),
        kickMember: jest.fn(),
        banMember: jest.fn(),
        notifyModerators: jest.fn(),
      };
      const service = new ModerationService(
        prisma as never,
        ruleEngine as never,
        { resolveAction: jest.fn() } as never,
        maxClient as never,
      );
      (service as any).webhookUserFacingTimeoutMs = 10_000;
      (service as any).claimDuplicateMessageAction = jest.fn().mockResolvedValue('claimed');
      const applySanctionAction = jest
        .spyOn(service as any, 'applySanctionAction')
        .mockReturnValue(sanction);
      const hotPathProfile = (service as any).createWebhookHotPathProfile();
      hotPathProfile.startedAtMs = Date.now() - 9_500;
      hotPathProfile.lastMarkedAtMs = hotPathProfile.startedAtMs;
      let settled = false;

      const execution = service.handleUpdate(createUpdate(), hotPathProfile).finally(() => {
        settled = true;
      });

      for (
        let attempt = 0;
        attempt < 20 && applySanctionAction.mock.calls.length === 0;
        attempt += 1
      ) {
        await new Promise<void>((resolve) => setImmediate(resolve));
      }

      expect(applySanctionAction).toHaveBeenCalledTimes(1);
      expect(settled).toBe(false);

      finishSanction(true);
      await expect(execution).resolves.toBeUndefined();
    },
  );

  it('propagates a critical duplicate sanction error after the optional budget is exhausted', async () => {
    const sanctionError = new Error('sanction storage unavailable');
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings({ duplicateBotMessageEnabled: true }),
          domains: [],
        }),
      },
      violation: { create: jest.fn() },
      moderationEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
      webhookEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };
    const ruleEngine = {
      detect: jest.fn().mockResolvedValue({
        violations: [],
        duplicateDecision: {
          action: 'MUTE',
          count: 3,
          threshold: 3,
          windowSec: 60,
          hash: 'duplicate-critical-error',
          fingerprintType: 'exact',
          nextAction: 'BAN',
        },
      }),
    };
    const maxClient = {
      deleteMessage: jest.fn().mockResolvedValue(undefined),
      sendMessage: jest.fn(),
      kickMember: jest.fn(),
      banMember: jest.fn(),
      notifyModerators: jest.fn(),
    };
    const service = new ModerationService(
      prisma as never,
      ruleEngine as never,
      { resolveAction: jest.fn() } as never,
      maxClient as never,
    );
    (service as any).webhookUserFacingTimeoutMs = 10_000;
    (service as any).claimDuplicateMessageAction = jest.fn().mockResolvedValue('claimed');
    jest.spyOn(service as any, 'applySanctionAction').mockRejectedValue(sanctionError);
    const hotPathProfile = (service as any).createWebhookHotPathProfile();
    hotPathProfile.startedAtMs = Date.now() - 9_500;
    hotPathProfile.lastMarkedAtMs = hotPathProfile.startedAtMs;

    await expect(service.handleUpdate(createUpdate(), hotPathProfile)).rejects.toBe(sanctionError);
    expect(maxClient.sendMessage).not.toHaveBeenCalled();
  });

  it('retries a duplicate ban after a proven pre-dispatch transient failure', async () => {
    const preDispatchError = new Error('route preparation unavailable');
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings({ duplicateBotMessageEnabled: false }),
          domains: [],
        }),
      },
      violation: { create: jest.fn() },
      moderationEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({ id: 'moderation-event' }),
      },
      webhookEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };
    const ruleEngine = {
      detect: jest.fn().mockResolvedValue({
        violations: [],
        duplicateDecision: {
          action: 'BAN',
          count: 4,
          threshold: 4,
          windowSec: 60,
          hash: 'duplicate-ban-pre-dispatch-retry',
          fingerprintType: 'exact',
          nextAction: null,
        },
      }),
    };
    const maxClient = {
      deleteMessage: jest.fn().mockResolvedValue(undefined),
      sendMessage: jest.fn().mockResolvedValue(undefined),
      kickMember: jest.fn(),
      banMember: jest.fn().mockRejectedValueOnce(preDispatchError).mockResolvedValueOnce(undefined),
      notifyModerators: jest.fn(),
    };
    const service = new ModerationService(
      prisma as never,
      ruleEngine as never,
      { resolveAction: jest.fn() } as never,
      maxClient as never,
    );
    (service as any).claimDuplicateMessageAction = jest
      .fn()
      .mockResolvedValueOnce('claimed')
      .mockResolvedValueOnce('resumed');
    const warnSpy = jest
      .spyOn((service as unknown as { logger: { warn: () => void } }).logger, 'warn')
      .mockImplementation(() => undefined);

    try {
      await expect(service.handleUpdate(createUpdate())).rejects.toBe(preDispatchError);
      await expect(service.handleUpdate(createUpdate())).resolves.toBeUndefined();
    } finally {
      warnSpy.mockRestore();
    }

    expect(maxClient.banMember).toHaveBeenCalledTimes(2);
    expect(maxClient.sendMessage).toHaveBeenCalledTimes(1);
    expect(
      prisma.moderationEvent.create.mock.calls.filter(
        ([call]) => call.data.action === SanctionAction.BAN,
      ),
    ).toHaveLength(1);
    expect(
      prisma.moderationEvent.create.mock.calls.some(
        ([call]) =>
          call.data.action === SanctionAction.NONE && call.data.ruleCode === 'DUPLICATE_BAN',
      ),
    ).toBe(false);
  });

  it('retries when a duplicate mute could not be persisted or cached', async () => {
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings({ duplicateBotMessageEnabled: false }),
          domains: [],
        }),
      },
      violation: { create: jest.fn() },
      moderationEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
      webhookEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };
    const ruleEngine = {
      detect: jest.fn().mockResolvedValue({
        violations: [],
        duplicateDecision: {
          action: 'MUTE',
          count: 3,
          threshold: 3,
          windowSec: 60,
          hash: 'duplicate-mute-persistence-retry',
          fingerprintType: 'exact',
          nextAction: 'BAN',
        },
      }),
    };
    const maxClient = {
      deleteMessage: jest.fn().mockResolvedValue(undefined),
      sendMessage: jest.fn(),
      kickMember: jest.fn(),
      banMember: jest.fn(),
      notifyModerators: jest.fn(),
    };
    const service = new ModerationService(
      prisma as never,
      ruleEngine as never,
      { resolveAction: jest.fn() } as never,
      maxClient as never,
    );
    (service as any).claimDuplicateMessageAction = jest.fn().mockResolvedValue('claimed');
    jest.spyOn(service as any, 'applySanctionAction').mockResolvedValue(false);

    await expect(service.handleUpdate(createUpdate())).rejects.toThrow(
      'Duplicate mute sanction could not be persisted',
    );
    expect(
      prisma.moderationEvent.create.mock.calls.some(
        ([call]) =>
          call.data.action === SanctionAction.NONE && call.data.ruleCode === 'DUPLICATE_MUTE',
      ),
    ).toBe(false);
  });

  it('does not call SanctionService for text filter violations', async () => {
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings(),
          domains: [],
        }),
      },
      violation: {
        create: jest.fn(),
      },
      moderationEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
      webhookEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };
    const ruleEngine = {
      detect: jest.fn().mockResolvedValue({
        violations: [{ ruleCode: 'PROFANITY', score: 0.95, reason: 'Profanity detected' }],
      }),
    };
    const sanctionService = {
      resolveAction: jest.fn().mockResolvedValue(SanctionAction.WARN),
    };
    const maxClient = {
      deleteMessage: jest.fn(),
      sendMessage: jest.fn(),
      kickMember: jest.fn(),
      banMember: jest.fn(),
      notifyModerators: jest.fn(),
    };

    const service = new ModerationService(
      prisma as never,
      ruleEngine as never,
      sanctionService as never,
      maxClient as never,
    );

    installProfanityDeleteGuard(service);
    await service.handleUpdate(createUpdate());

    expect(prisma.violation.create).toHaveBeenCalledTimes(1);
    expect(sanctionService.resolveAction).not.toHaveBeenCalled();
    expect(maxClient.sendMessage).not.toHaveBeenCalled();
    expect(prisma.moderationEvent.create).toHaveBeenCalledTimes(2);
    expect(prisma.moderationEvent.create).toHaveBeenNthCalledWith(1, {
      data: expect.objectContaining({
        ruleCode: 'PROFANITY_DELETE',
        action: SanctionAction.DELETE_MESSAGE,
      }),
    });
    expect(prisma.moderationEvent.create).toHaveBeenNthCalledWith(2, {
      data: expect.objectContaining({
        ruleCode: 'PROFANITY',
        action: SanctionAction.NONE,
      }),
    });
  });

  it('deletes strict mild insults without bot messages or automatic escalation', async () => {
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings({
            profanityBotMessageEnabled: true,
            profanityWarnEnabled: true,
            profanityMuteEnabled: true,
            profanityBanEnabled: true,
          }),
          domains: [],
        }),
      },
      violation: {
        create: jest.fn(),
        count: jest.fn().mockResolvedValue(4),
      },
      moderationEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
      webhookEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };
    const ruleEngine = {
      detect: jest.fn().mockResolvedValue({
        violations: [
          {
            ruleCode: 'PROFANITY',
            score: 0.75,
            reason: 'Detected targeted mild insult',
            metadata: {
              category: 'MILD_INSULT',
              detectorVersion: 'profanity-v2',
            },
          },
        ],
      }),
    };
    const sanctionService = {
      resolveAction: jest.fn(),
    };
    const maxClient = {
      deleteMessage: jest.fn(),
      sendMessage: jest.fn(),
      kickMember: jest.fn(),
      banMember: jest.fn(),
      notifyModerators: jest.fn(),
    };

    const service = new ModerationService(
      prisma as never,
      ruleEngine as never,
      sanctionService as never,
      maxClient as never,
    );

    installProfanityDeleteGuard(service);
    await service.handleUpdate(createUpdate());

    expectImmediateDeleteMessage(maxClient.deleteMessage, 'chat-1', 'msg-1');
    expect(prisma.violation.count).not.toHaveBeenCalled();
    expect(maxClient.sendMessage).not.toHaveBeenCalled();
    expect(maxClient.kickMember).not.toHaveBeenCalled();
    expect(maxClient.banMember).not.toHaveBeenCalled();
    expect(sanctionService.resolveAction).not.toHaveBeenCalled();
    expect(prisma.moderationEvent.create).toHaveBeenNthCalledWith(2, {
      data: expect.objectContaining({
        ruleCode: 'PROFANITY',
        action: SanctionAction.NONE,
        metadata: expect.not.objectContaining({
          textFilterViolationCount24h: expect.any(Number),
        }),
      }),
    });
  });

  it('issues WARN on second text-filter violation in 24h when warning stage is enabled', async () => {
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings({
            profanityBotMessageEnabled: false,
            profanityWarnEnabled: true,
          }),
          domains: [],
        }),
      },
      violation: {
        create: jest.fn(),
        count: jest.fn().mockResolvedValue(2),
      },
      moderationEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
      webhookEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };
    const ruleEngine = {
      detect: jest.fn().mockResolvedValue({
        violations: [{ ruleCode: 'PROFANITY', score: 0.95, reason: 'Profanity detected' }],
      }),
    };
    const sanctionService = {
      resolveAction: jest.fn(),
    };
    const maxClient = {
      deleteMessage: jest.fn(),
      sendMessage: jest.fn(),
      kickMember: jest.fn(),
      banMember: jest.fn(),
      notifyModerators: jest.fn(),
    };

    const service = new ModerationService(
      prisma as never,
      ruleEngine as never,
      sanctionService as never,
      maxClient as never,
    );

    installProfanityDeleteGuard(service);
    await service.handleUpdate(createUpdate());

    expect(prisma.violation.count).toHaveBeenCalledWith({
      where: expect.objectContaining({
        chatId: 'chat-1',
        userId: 'user-1',
        ruleCode: 'PROFANITY',
        score: { gte: 0.9 },
      }),
    });
    expectImmediateDeleteMessage(maxClient.deleteMessage, 'chat-1', 'msg-1');
    (expect(maxClient.sendMessage) as any).toHaveBeenCalledWithPrefix(
      'chat-1',
      textFilterWarnNotice('Алексей', 'грубая лексика запрещена правилами чата'),
    );
    expect(maxClient.kickMember).not.toHaveBeenCalled();
    expect(maxClient.banMember).not.toHaveBeenCalled();
    expect(sanctionService.resolveAction).not.toHaveBeenCalled();
    expect(prisma.moderationEvent.create).toHaveBeenNthCalledWith(2, {
      data: expect.objectContaining({
        ruleCode: 'PROFANITY',
        action: SanctionAction.WARN,
        metadata: expect.objectContaining({
          textFilterViolationCount24h: 2,
          textFilterEscalationWindowHours: 24,
        }),
      }),
    });
  });

  it.each([1, 2])(
    'isolates profanity notices from commercial buttons at strike %s, preserving rules and admin contact',
    async (strike) => {
      const prisma = {
        chat: {
          upsert: jest.fn().mockResolvedValue({
            id: 'chat-1',
            title: 'Chat 1',
            domains: [],
            rules: { publishedUrl: 'https://max.ru/chats/chat-1/message/999' },
            settings: createSettings({
              profanityBotMessageEnabled: true,
              profanityWarnEnabled: true,
              profanityAdminContactButtonEnabled: true,
              profanityAdminContactButtonUrl: 'https://max.ru/profanity-admin',
              textFiltersBotButtonEnabled: true,
              textFiltersBotButtonUrl: 'https://max.ru/commercial-legacy',
              textFiltersBotButtonText: 'Коммерческая кнопка',
              textFiltersBotButtons: [
                { text: 'Коммерческая кнопка', url: 'https://max.ru/commercial-custom' },
              ],
              rulesAttachViolationsEnabled: true,
            }),
          }),
        },
        violation: { create: jest.fn(), count: jest.fn().mockResolvedValue(strike) },
        moderationEvent: { findFirst: jest.fn().mockResolvedValue(null), create: jest.fn() },
        webhookEvent: { findUnique: jest.fn(), update: jest.fn() },
      };
      const maxClient = {
        deleteMessage: jest.fn(),
        sendMessage: jest.fn(),
        kickMember: jest.fn(),
        banMember: jest.fn(),
        notifyModerators: jest.fn(),
      };
      const service = new ModerationService(
        prisma as never,
        {
          detect: jest.fn().mockResolvedValue({
            violations: [{ ruleCode: 'PROFANITY', score: 0.95, reason: 'Profanity detected' }],
          }),
        } as never,
        { resolveAction: jest.fn() } as never,
        maxClient as never,
      );
      installProfanityDeleteGuard(service);
      await service.handleUpdate(createUpdate());
      expect(maxClient.sendMessage).toHaveBeenCalledTimes(1);
      const [, sentText, options] = maxClient.sendMessage.mock.calls[0]!;
      expect(options).toEqual({
        button: { text: 'Правила', url: 'https://max.ru/chats/chat-1/message/999' },
        textFormat: 'html',
        marketplacePublication: {
          entityId: 'chat-1',
          purpose: 'MODERATION_NOTICE',
          module: 'PROFANITY',
        },
      });
      expect(sentText).toContain('https://max.ru/profanity-admin');
      expect(JSON.stringify(maxClient.sendMessage.mock.calls)).not.toContain('commercial-');
    },
  );

  it('does not send repeated text-filter explanation when warning stage is disabled', async () => {
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings({
            profanityBotMessageEnabled: true,
            profanityWarnEnabled: false,
            profanityBanEnabled: false,
            profanityMuteEnabled: false,
          }),
          domains: [],
        }),
      },
      violation: {
        create: jest.fn(),
        count: jest.fn().mockResolvedValue(2),
      },
      moderationEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
      webhookEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };
    const ruleEngine = {
      detect: jest.fn().mockResolvedValue({
        violations: [{ ruleCode: 'PROFANITY', score: 0.95, reason: 'Profanity detected' }],
      }),
    };
    const sanctionService = {
      resolveAction: jest.fn(),
    };
    const maxClient = {
      deleteMessage: jest.fn(),
      sendMessage: jest.fn(),
      kickMember: jest.fn(),
      banMember: jest.fn(),
      notifyModerators: jest.fn(),
    };

    const service = new ModerationService(
      prisma as never,
      ruleEngine as never,
      sanctionService as never,
      maxClient as never,
    );

    installProfanityDeleteGuard(service);
    await service.handleUpdate(createUpdate());

    expect(maxClient.sendMessage).not.toHaveBeenCalled();
  });

  it('suppresses duplicate escalation while a later manual unmute is still inside the duplicate window', async () => {
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings(),
          domains: [],
        }),
      },
      violation: {
        create: jest.fn(),
      },
      moderationEvent: {
        findFirst: jest.fn().mockResolvedValue({
          action: SanctionAction.NONE,
          ruleCode: 'MANUAL_UNMUTE',
          metadata: null,
          createdAt: new Date(Date.now() - 60 * 60 * 1000),
        }),
        create: jest.fn(),
      },
      webhookEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };
    const ruleEngine = {
      detect: jest.fn().mockResolvedValue({
        violations: [],
        duplicateDecision: {
          action: 'MUTE',
          count: 3,
          threshold: 3,
          windowSec: 24 * 60 * 60,
          hash: 'dup-after-unmute',
          nextAction: 'BAN',
        },
      }),
    };
    const sanctionService = {
      resolveAction: jest.fn(),
    };
    const maxClient = {
      deleteMessage: jest.fn(),
      sendMessage: jest.fn(),
      kickMember: jest.fn(),
      banMember: jest.fn(),
      notifyModerators: jest.fn(),
    };

    const service = new ModerationService(
      prisma as never,
      ruleEngine as never,
      sanctionService as never,
      maxClient as never,
    );

    await service.handleUpdate(createUpdate());

    expect(maxClient.deleteMessage).not.toHaveBeenCalled();
    expect(maxClient.kickMember).not.toHaveBeenCalled();
    expect(maxClient.banMember).not.toHaveBeenCalled();
    expect(maxClient.sendMessage).not.toHaveBeenCalled();
  });

  it('uses permanent ban flow for text-filter BAN escalation', async () => {
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings({
            profanityBotMessageEnabled: false,
            profanityBanEnabled: true,
            muteDurationHours: 12,
          }),
          domains: [],
        }),
      },
      violation: {
        create: jest.fn(),
        count: jest.fn().mockResolvedValue(3),
      },
      moderationEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
      webhookEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };
    const ruleEngine = {
      detect: jest.fn().mockResolvedValue({
        violations: [{ ruleCode: 'PROFANITY', score: 0.95, reason: 'Profanity detected' }],
      }),
    };
    const sanctionService = {
      resolveAction: jest.fn(),
    };
    const maxClient = {
      deleteMessage: jest.fn(),
      sendMessage: jest.fn(),
      kickMember: jest.fn(),
      banMember: jest.fn(),
      notifyModerators: jest.fn(),
    };

    const service = new ModerationService(
      prisma as never,
      ruleEngine as never,
      sanctionService as never,
      maxClient as never,
    );

    installProfanityDeleteGuard(service);
    await service.handleUpdate(createUpdate());

    expectImmediateDeleteMessage(maxClient.deleteMessage, 'chat-1', 'msg-1');
    expectImmediateBanMember(maxClient.banMember, 'chat-1', 'user-1');
    expect(maxClient.kickMember).not.toHaveBeenCalled();
    (expect(maxClient.sendMessage) as any).toHaveBeenCalledWithPrefix(
      'chat-1',
      permanentBanNotice('Алексей'),
    );
    expect(sanctionService.resolveAction).not.toHaveBeenCalled();
    expect(prisma.moderationEvent.create).toHaveBeenNthCalledWith(2, {
      data: expect.objectContaining({
        ruleCode: 'PROFANITY',
        action: SanctionAction.BAN,
        metadata: expect.objectContaining({
          textFilterViolationCount24h: 3,
          textFilterEscalationWindowHours: 24,
        }),
      }),
    });
  });

  it('issues MUTE on fourth text-filter violation in 24h when mute stage is enabled', async () => {
    const globalSpammer = {
      upsert: jest.fn(),
    };
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings({
            profanityBotMessageEnabled: false,
            profanityMuteEnabled: true,
          }),
          domains: [],
        }),
      },
      violation: {
        create: jest.fn(),
        count: jest.fn().mockResolvedValue(4),
      },
      moderationEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
      webhookEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
      globalSpammer,
    };
    const ruleEngine = {
      detect: jest.fn().mockResolvedValue({
        violations: [{ ruleCode: 'PROFANITY', score: 0.95, reason: 'Profanity detected' }],
      }),
    };
    const sanctionService = {
      resolveAction: jest.fn(),
    };
    const maxClient = {
      deleteMessage: jest.fn(),
      sendMessage: jest.fn(),
      kickMember: jest.fn(),
      banMember: jest.fn(),
      notifyModerators: jest.fn(),
    };

    withAutomaticMutePersistenceFixture(prisma);
    const service = new ModerationService(
      prisma as never,
      ruleEngine as never,
      sanctionService as never,
      maxClient as never,
    );

    installProfanityDeleteGuard(service);
    await service.handleUpdate(createUpdate());

    expectImmediateDeleteMessage(maxClient.deleteMessage, 'chat-1', 'msg-1');
    expect(maxClient.kickMember).not.toHaveBeenCalled();
    expect(maxClient.banMember).not.toHaveBeenCalled();
    (expect(maxClient.sendMessage) as any).toHaveBeenCalledWithPrefix(
      'chat-1',
      muteNotice('Алексей', '6ч'),
    );
    expect(globalSpammer.upsert).not.toHaveBeenCalled();
    expect(sanctionService.resolveAction).not.toHaveBeenCalled();
    expect(prisma.moderationEvent.create).toHaveBeenNthCalledWith(2, {
      data: expect.objectContaining({
        ruleCode: 'PROFANITY',
        action: SanctionAction.MUTE,
        metadata: expect.objectContaining({
          textFilterViolationCount24h: 4,
          textFilterEscalationWindowHours: 24,
        }),
      }),
    });
  });

  it.each([
    {
      actionLabel: 'BAN',
      action: SanctionAction.BAN,
      violationCount: 3,
      settings: { profanityBanEnabled: true },
      expectedEffects: [
        'fence-prepare',
        'remote-ban',
        'cache',
        'event',
        'fence-commit',
        'remote-notice',
      ],
      expectedNotice: permanentBanNotice('Алексей'),
    },
    {
      actionLabel: 'MUTE',
      action: SanctionAction.MUTE,
      violationCount: 4,
      settings: { profanityMuteEnabled: true },
      expectedEffects: ['fence-prepare', 'event', 'cache', 'fence-commit', 'remote-notice'],
      expectedNotice: muteNotice('Алексей', '6ч'),
    },
  ])(
    'keeps the automatic $actionLabel transition inside the injected sanction-state lock',
    async ({ action, violationCount, settings, expectedEffects, expectedNotice }) => {
      let lockActive = false;
      let ownershipCheckedSinceEffect = false;
      const transitionEffects: Array<{ name: string; lockActive: boolean }> = [];
      const cacheLockStates: boolean[] = [];
      const recordTransitionEffect = (name: string) => {
        expect(ownershipCheckedSinceEffect).toBe(true);
        ownershipCheckedSinceEffect = false;
        transitionEffects.push({ name, lockActive });
      };
      const prisma = {
        chat: {
          upsert: jest.fn().mockResolvedValue({
            id: 'chat-1',
            title: 'Chat 1',
            settings: createSettings({
              profanityBotMessageEnabled: false,
              ...settings,
            }),
            domains: [],
          }),
        },
        violation: {
          create: jest.fn(),
          count: jest.fn().mockResolvedValue(violationCount),
        },
        moderationEvent: {
          findFirst: jest.fn().mockResolvedValue(null),
          create: jest.fn(
            async ({ data }: { data: { action?: SanctionAction; metadata?: unknown } }) => {
              const metadata =
                data.metadata && typeof data.metadata === 'object'
                  ? (data.metadata as Record<string, unknown>)
                  : {};
              if (data.action === action && metadata.sanctionApplied === true) {
                recordTransitionEffect('event');
                return { id: `sanction-event-${action.toLowerCase()}` };
              }
              return { id: 'delete-event' };
            },
          ),
        },
        webhookEvent: {
          findUnique: jest.fn(),
          update: jest.fn(),
        },
      };
      const ruleEngine = {
        detect: jest.fn().mockResolvedValue({
          violations: [{ ruleCode: 'PROFANITY', score: 0.95, reason: 'Profanity detected' }],
        }),
      };
      const sanctionService = { resolveAction: jest.fn() };
      const maxClient = {
        deleteMessage: jest.fn(),
        sendMessage: jest.fn(async (_chatId: string, text: string) => {
          if (text === expectedNotice) {
            recordTransitionEffect('remote-notice');
          }
        }),
        kickMember: jest.fn(),
        banMember: jest.fn(async () => {
          recordTransitionEffect('remote-ban');
        }),
        notifyModerators: jest.fn(),
      };
      const redisCounter = {
        setStringWithTtl: jest.fn(async () => {
          cacheLockStates.push(lockActive);
          if (lockActive) {
            recordTransitionEffect('cache');
          }
        }),
      };
      const leaseGuard = {
        assertOwned: jest.fn(async () => {
          expect(lockActive).toBe(true);
          ownershipCheckedSinceEffect = true;
        }),
      };
      const sanctionStateLock = {
        runExclusive: jest.fn(
          async (_subject: unknown, operation: (guard: typeof leaseGuard) => Promise<unknown>) => {
            lockActive = true;
            try {
              return await operation(leaseGuard);
            } finally {
              lockActive = false;
            }
          },
        ),
      };
      const automaticFence = {
        version: 1,
        transitionId: `transition-${action.toLowerCase()}`,
        chatId: 'chat-1',
        userId: 'user-1',
        intendedAction: action,
        operator: Operator.BOT,
        source: 'automatic_moderation',
        invalidatedSanctionEventIds: [],
      };
      const sanctionStateFence = {
        prepare: jest.fn(async () => {
          recordTransitionEffect('fence-prepare');
          return automaticFence;
        }),
        commit: jest.fn(async () => {
          recordTransitionEffect('fence-commit');
        }),
        markRemoteConfirmedEventMissing: jest.fn(),
        abort: jest.fn(),
      };
      withAutomaticMutePersistenceFixture(prisma);
      const service = createModerationServiceWithSanctionStateLock({
        prisma,
        ruleEngine,
        sanctionService,
        maxClient,
        redisCounter,
        sanctionStateLock,
        sanctionStateFence,
      });

      installProfanityDeleteGuard(service);
      await service.handleUpdate(createUpdate());

      expect(sanctionStateLock.runExclusive).toHaveBeenCalledTimes(1);
      expect(sanctionStateLock.runExclusive).toHaveBeenCalledWith(
        { chatId: 'chat-1', userId: 'user-1' },
        expect.any(Function),
      );
      expect(transitionEffects).toEqual(
        expectedEffects.map((name) => ({ name, lockActive: true })),
      );
      expect(sanctionStateFence.prepare).toHaveBeenCalledWith({
        chatId: 'chat-1',
        userId: 'user-1',
        intendedAction: action,
        operator: Operator.BOT,
        source: 'automatic_moderation',
      });
      expect(sanctionStateFence.commit).toHaveBeenCalledWith(
        automaticFence,
        `sanction-event-${action.toLowerCase()}`,
      );
      expect(sanctionStateFence.abort).not.toHaveBeenCalled();
      expect(cacheLockStates).toContain(true);
    },
  );

  it.each([{ stateStored: true }, { stateStored: false }])(
    'requires durable MUTE persistence before resolving through lease loss ($stateStored)',
    async ({ stateStored }) => {
      const leaseLostError = new ModerationSanctionStateLockLeaseLostError({
        chatId: 'chat-1',
        userId: 'user-1',
      });
      const leaseGuard = { assertOwned: jest.fn().mockResolvedValue(undefined) };
      const sanctionStateLock = {
        runExclusive: jest.fn(
          async (_subject: unknown, operation: (guard: typeof leaseGuard) => Promise<unknown>) => {
            await operation(leaseGuard);
            throw leaseLostError;
          },
        ),
      };
      const automaticFence = {
        version: 1,
        transitionId: `transition-mute-post-return-${stateStored}`,
        chatId: 'chat-1',
        userId: 'user-1',
        intendedAction: 'MUTE',
        operator: Operator.BOT,
        source: 'automatic_moderation',
        invalidatedSanctionEventIds: [],
      };
      const sanctionStateFence = {
        prepare: jest.fn().mockResolvedValue(automaticFence),
        commit: jest.fn().mockResolvedValue(undefined),
        markRemoteConfirmedEventMissing: jest.fn(),
        abort: jest.fn().mockResolvedValue(undefined),
      };
      const maxClient = {
        sendMessage: jest.fn().mockResolvedValue({ messageId: 'mute-notice-1' }),
      };
      const persistModerationEvent = stateStored
        ? jest.fn().mockResolvedValue({ id: 'mute-event-1' })
        : jest.fn().mockRejectedValue(new Error('database unavailable'));
      const service = createModerationServiceWithSanctionStateLock({
        prisma: {},
        ruleEngine: {},
        sanctionService: {},
        maxClient,
        redisCounter: {
          setStringWithTtl: stateStored
            ? jest.fn().mockResolvedValue(undefined)
            : jest.fn().mockRejectedValue(new Error('redis unavailable')),
        },
        sanctionStateLock,
        sanctionStateFence,
      });

      const result = (service as any).applySanctionAction({
        chatId: 'chat-1',
        userId: 'user-1',
        action: SanctionAction.MUTE,
        userLabel: userMention('Нарушитель'),
        messageId: `message-mute-post-return-${stateStored}`,
        muteDurationHours: 6,
        deleteBotMessagesEnabled: false,
        deleteBotMessagesDelayMinutes: 0,
        botSpeechStyle: null,
        persistModerationEvent,
      });
      if (stateStored) await expect(result).resolves.toBe(true);
      else await expect(result).rejects.toThrow('Automatic mute requires a durable sanction event');

      expect(sanctionStateLock.runExclusive).toHaveBeenCalledTimes(1);
      if (stateStored) {
        expect(sanctionStateFence.commit).toHaveBeenCalledWith(automaticFence, 'mute-event-1');
        expect(maxClient.sendMessage).toHaveBeenCalledTimes(1);
      } else {
        expect(sanctionStateFence.abort).toHaveBeenCalledWith(automaticFence);
        expect(maxClient.sendMessage).not.toHaveBeenCalled();
      }
    },
  );

  it.each([false, true])(
    'aborts MUTE without durable storage even when Redis works (%s)',
    async (redisAvailable) => {
      const leaseGuard = { assertOwned: jest.fn().mockResolvedValue(undefined) };
      const sanctionStateLock = {
        runExclusive: jest.fn(
          async (_subject: unknown, operation: (guard: typeof leaseGuard) => Promise<unknown>) =>
            operation(leaseGuard),
        ),
      };
      const automaticFence = {
        version: 1,
        transitionId: 'transition-mute-storage-failed',
        chatId: 'chat-1',
        userId: 'user-1',
        intendedAction: 'MUTE',
        operator: Operator.BOT,
        source: 'automatic_moderation',
        invalidatedSanctionEventIds: ['previous-ban-event'],
      };
      const sanctionStateFence = {
        prepare: jest.fn().mockResolvedValue(automaticFence),
        commit: jest.fn(),
        markRemoteConfirmedEventMissing: jest.fn(),
        abort: jest.fn().mockResolvedValue(undefined),
      };
      const maxClient = { sendMessage: jest.fn() };
      const service = createModerationServiceWithSanctionStateLock({
        prisma: {},
        ruleEngine: {},
        sanctionService: {},
        maxClient,
        redisCounter: {
          setStringWithTtl: redisAvailable
            ? jest.fn().mockResolvedValue(undefined)
            : jest.fn().mockRejectedValue(new Error('redis unavailable')),
        },
        sanctionStateLock,
        sanctionStateFence,
      });

      await expect(
        (service as any).applySanctionAction({
          chatId: 'chat-1',
          userId: 'user-1',
          action: SanctionAction.MUTE,
          userLabel: userMention('Нарушитель'),
          messageId: 'message-mute-storage-failed',
          muteDurationHours: 6,
          deleteBotMessagesEnabled: false,
          deleteBotMessagesDelayMinutes: 0,
          botSpeechStyle: null,
          persistModerationEvent: jest.fn().mockRejectedValue(new Error('database unavailable')),
        }),
      ).rejects.toThrow('Automatic mute requires a durable sanction event');

      expect(sanctionStateFence.abort).toHaveBeenCalledWith(automaticFence);
      expect(sanctionStateFence.commit).not.toHaveBeenCalled();
      expect(sanctionStateFence.markRemoteConfirmedEventMissing).not.toHaveBeenCalled();
      expect(maxClient.sendMessage).not.toHaveBeenCalled();
      expect(sanctionStateLock.runExclusive).toHaveBeenCalledTimes(1);
    },
  );

  it('keeps the automatic BAN fence invalidating after MAX succeeds without an event', async () => {
    let remoteBanConfirmed = false;
    const ownershipPhases: Array<'before-confirmation' | 'after-confirmation'> = [];
    const leaseGuard = {
      assertOwned: jest.fn(async () => {
        ownershipPhases.push(remoteBanConfirmed ? 'after-confirmation' : 'before-confirmation');
      }),
    };
    const sanctionStateLock = {
      runExclusive: jest.fn(
        async (_subject: unknown, operation: (guard: typeof leaseGuard) => Promise<unknown>) =>
          operation(leaseGuard),
      ),
    };
    const automaticFence = {
      version: 1,
      transitionId: 'transition-ban-event-missing',
      chatId: 'chat-1',
      userId: 'user-1',
      intendedAction: 'BAN',
      operator: Operator.BOT,
      source: 'automatic_moderation',
      invalidatedSanctionEventIds: ['previous-mute-event'],
    };
    const sanctionStateFence = {
      prepare: jest.fn().mockResolvedValue(automaticFence),
      commit: jest.fn(),
      markRemoteConfirmedEventMissing: jest.fn().mockResolvedValue(undefined),
      abort: jest.fn(),
    };
    const maxClient = {
      banMember: jest.fn(async () => {
        remoteBanConfirmed = true;
      }),
      sendMessage: jest.fn().mockResolvedValue({ messageId: 'ban-notice-1' }),
    };
    const service = createModerationServiceWithSanctionStateLock({
      prisma: {},
      ruleEngine: {},
      sanctionService: {},
      maxClient,
      redisCounter: { setStringWithTtl: jest.fn().mockResolvedValue(undefined) },
      sanctionStateLock,
      sanctionStateFence,
    });

    await expect(
      (service as any).applySanctionAction({
        chatId: 'chat-1',
        userId: 'user-1',
        action: SanctionAction.BAN,
        userLabel: userMention('Нарушитель'),
        messageId: 'message-ban-event-missing',
        muteDurationHours: 6,
        deleteBotMessagesEnabled: false,
        deleteBotMessagesDelayMinutes: 0,
        botSpeechStyle: null,
        trackAsGlobalSpammer: false,
        persistModerationEvent: jest.fn().mockRejectedValue(new Error('database unavailable')),
      }),
    ).resolves.toBe(true);

    expect(maxClient.banMember).toHaveBeenCalledTimes(1);
    expect(sanctionStateFence.markRemoteConfirmedEventMissing).toHaveBeenCalledWith(automaticFence);
    expect(sanctionStateFence.commit).not.toHaveBeenCalled();
    expect(sanctionStateFence.abort).not.toHaveBeenCalled();
    expect(maxClient.sendMessage).toHaveBeenCalledTimes(1);
    expect(ownershipPhases).toContain('before-confirmation');
    expect(ownershipPhases).toContain('after-confirmation');
  });

  it.each([
    {
      failureLabel: 'times out',
      error: markMaxMemberMutationAttempted(new Error('MAX request timeout')),
      mutationAttempted: true,
    },
    {
      failureLabel: 'loses the connection after dispatch',
      error: markMaxMemberMutationAttempted(
        Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }),
      ),
      mutationAttempted: true,
    },
    {
      failureLabel: 'fails before dispatch with a timeout-shaped error',
      error: new Error('MAX route timeout'),
      mutationAttempted: false,
    },
  ])(
    'settles the automatic BAN fence safely when MAX $failureLabel',
    async ({ error, mutationAttempted }) => {
      const leaseGuard = { assertOwned: jest.fn().mockResolvedValue(undefined) };
      const sanctionStateLock = {
        runExclusive: jest.fn(
          async (_subject: unknown, operation: (guard: typeof leaseGuard) => Promise<unknown>) =>
            operation(leaseGuard),
        ),
      };
      const automaticFence = {
        version: 1,
        transitionId: 'transition-ban-timeout',
        chatId: 'chat-1',
        userId: 'user-1',
        intendedAction: 'BAN',
        operator: Operator.BOT,
        source: 'automatic_moderation',
        invalidatedSanctionEventIds: ['previous-mute-event'],
      };
      const sanctionStateFence = {
        prepare: jest.fn().mockResolvedValue(automaticFence),
        commit: jest.fn(),
        markRemoteConfirmedEventMissing: jest.fn(),
        abort: jest.fn(),
      };
      const maxClient = {
        banMember: jest.fn().mockRejectedValue(error),
        sendMessage: jest.fn(),
      };
      const persistModerationEvent = jest.fn();
      const service = createModerationServiceWithSanctionStateLock({
        prisma: {},
        ruleEngine: {},
        sanctionService: {},
        maxClient,
        redisCounter: { setStringWithTtl: jest.fn() },
        sanctionStateLock,
        sanctionStateFence,
      });

      await expect(
        (service as any).applySanctionAction({
          chatId: 'chat-1',
          userId: 'user-1',
          action: SanctionAction.BAN,
          userLabel: userMention('Нарушитель'),
          messageId: 'message-ban-timeout',
          muteDurationHours: 6,
          deleteBotMessagesEnabled: false,
          deleteBotMessagesDelayMinutes: 0,
          botSpeechStyle: null,
          trackAsGlobalSpammer: false,
          persistModerationEvent,
        }),
      ).resolves.toBe(false);

      expect(maxClient.banMember).toHaveBeenCalledTimes(1);
      expect(persistModerationEvent).not.toHaveBeenCalled();
      expect(sanctionStateFence.commit).not.toHaveBeenCalled();
      expect(sanctionStateFence.markRemoteConfirmedEventMissing).not.toHaveBeenCalled();
      if (mutationAttempted) {
        expect(sanctionStateFence.abort).not.toHaveBeenCalled();
      } else {
        expect(sanctionStateFence.abort).toHaveBeenCalledWith(automaticFence);
      }
      expect(maxClient.sendMessage).not.toHaveBeenCalled();
    },
  );

  it('aborts the automatic BAN fence when the lease is lost before MAX dispatch', async () => {
    const leaseLostError = new ModerationSanctionStateLockLeaseLostError({
      chatId: 'chat-1',
      userId: 'user-1',
    });
    const leaseGuard = {
      assertOwned: jest
        .fn()
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(leaseLostError),
    };
    const sanctionStateLock = {
      runExclusive: jest.fn(
        async (_subject: unknown, operation: (guard: typeof leaseGuard) => Promise<unknown>) =>
          operation(leaseGuard),
      ),
    };
    const automaticFence = {
      version: 1,
      transitionId: 'transition-ban-lease-lost-before-dispatch',
      chatId: 'chat-1',
      userId: 'user-1',
      intendedAction: 'BAN',
      operator: Operator.BOT,
      source: 'automatic_moderation',
      invalidatedSanctionEventIds: ['previous-mute-event'],
    };
    const sanctionStateFence = {
      prepare: jest.fn().mockResolvedValue(automaticFence),
      commit: jest.fn(),
      markRemoteConfirmedEventMissing: jest.fn(),
      abort: jest.fn().mockResolvedValue(undefined),
    };
    const maxClient = {
      banMember: jest.fn(),
      sendMessage: jest.fn(),
    };
    const persistModerationEvent = jest.fn();
    const service = createModerationServiceWithSanctionStateLock({
      prisma: {},
      ruleEngine: {},
      sanctionService: {},
      maxClient,
      redisCounter: { setStringWithTtl: jest.fn() },
      sanctionStateLock,
      sanctionStateFence,
    });

    await expect(
      (service as any).applySanctionAction({
        chatId: 'chat-1',
        userId: 'user-1',
        action: SanctionAction.BAN,
        userLabel: userMention('Нарушитель'),
        messageId: 'message-ban-lease-lost-before-dispatch',
        muteDurationHours: 6,
        deleteBotMessagesEnabled: false,
        deleteBotMessagesDelayMinutes: 0,
        botSpeechStyle: null,
        trackAsGlobalSpammer: false,
        persistModerationEvent,
      }),
    ).rejects.toBe(leaseLostError);

    expect(maxClient.banMember).not.toHaveBeenCalled();
    expect(persistModerationEvent).not.toHaveBeenCalled();
    expect(sanctionStateFence.abort).toHaveBeenCalledWith(automaticFence);
    expect(sanctionStateFence.commit).not.toHaveBeenCalled();
    expect(sanctionStateFence.markRemoteConfirmedEventMissing).not.toHaveBeenCalled();
    expect(maxClient.sendMessage).not.toHaveBeenCalled();
  });

  it('keeps the automatic BAN fence active when the lease is lost after MAX succeeds', async () => {
    const leaseLostError = new ModerationSanctionStateLockLeaseLostError({
      chatId: 'chat-1',
      userId: 'user-1',
    });
    let remoteBanConfirmed = false;
    const leaseGuard = {
      assertOwned: jest.fn(async () => {
        if (remoteBanConfirmed) throw leaseLostError;
      }),
    };
    const sanctionStateLock = {
      runExclusive: jest.fn(
        async (_subject: unknown, operation: (guard: typeof leaseGuard) => Promise<unknown>) =>
          operation(leaseGuard),
      ),
    };
    const automaticFence = {
      version: 1,
      transitionId: 'transition-ban-lease-lost-after-dispatch',
      chatId: 'chat-1',
      userId: 'user-1',
      intendedAction: 'BAN',
      operator: Operator.BOT,
      source: 'automatic_moderation',
      invalidatedSanctionEventIds: ['previous-mute-event'],
    };
    const sanctionStateFence = {
      prepare: jest.fn().mockResolvedValue(automaticFence),
      commit: jest.fn(),
      markRemoteConfirmedEventMissing: jest.fn().mockResolvedValue(undefined),
      abort: jest.fn(),
    };
    const maxClient = {
      banMember: jest.fn(async () => {
        remoteBanConfirmed = true;
      }),
      sendMessage: jest.fn(),
    };
    const persistModerationEvent = jest.fn();
    const redisCounter = { setStringWithTtl: jest.fn() };
    const service = createModerationServiceWithSanctionStateLock({
      prisma: {},
      ruleEngine: {},
      sanctionService: {},
      maxClient,
      redisCounter,
      sanctionStateLock,
      sanctionStateFence,
    });

    await expect(
      (service as any).applySanctionAction({
        chatId: 'chat-1',
        userId: 'user-1',
        action: SanctionAction.BAN,
        userLabel: userMention('Нарушитель'),
        messageId: 'message-ban-lease-lost-after-dispatch',
        muteDurationHours: 6,
        deleteBotMessagesEnabled: false,
        deleteBotMessagesDelayMinutes: 0,
        botSpeechStyle: null,
        trackAsGlobalSpammer: false,
        persistModerationEvent,
      }),
    ).rejects.toBe(leaseLostError);

    expect(maxClient.banMember).toHaveBeenCalledTimes(1);
    expect(redisCounter.setStringWithTtl).not.toHaveBeenCalled();
    expect(persistModerationEvent).not.toHaveBeenCalled();
    expect(sanctionStateFence.markRemoteConfirmedEventMissing).toHaveBeenCalledWith(automaticFence);
    expect(sanctionStateFence.commit).not.toHaveBeenCalled();
    expect(sanctionStateFence.abort).not.toHaveBeenCalled();
    expect(maxClient.sendMessage).not.toHaveBeenCalled();
  });

  it('does not prepare an automatic sanction fence for a configured runtime bot', async () => {
    const leaseGuard = { assertOwned: jest.fn() };
    const sanctionStateLock = {
      runExclusive: jest.fn(
        async (_subject: unknown, operation: (guard: typeof leaseGuard) => Promise<unknown>) =>
          operation(leaseGuard),
      ),
    };
    const sanctionStateFence = {
      prepare: jest.fn(),
      commit: jest.fn(),
      markRemoteConfirmedEventMissing: jest.fn(),
      abort: jest.fn(),
    };
    const maxClient = {
      banMember: jest.fn(),
      sendMessage: jest.fn(),
    };
    const persistModerationEvent = jest.fn();
    const maxBotLinkService = {
      isKnownBotUserId: jest.fn().mockReturnValue(true),
    };
    const service = createModerationServiceWithSanctionStateLock({
      prisma: {},
      ruleEngine: {},
      sanctionService: {},
      maxClient,
      redisCounter: { setStringWithTtl: jest.fn() },
      sanctionStateLock,
      sanctionStateFence,
      maxBotLinkService,
    });

    await expect(
      (service as any).applySanctionAction({
        chatId: 'chat-1',
        userId: 'runtime-bot-user-1',
        action: SanctionAction.BAN,
        userLabel: userMention('Служебный бот', 'runtime-bot-user-1'),
        messageId: 'message-from-runtime-bot',
        muteDurationHours: 6,
        deleteBotMessagesEnabled: false,
        deleteBotMessagesDelayMinutes: 0,
        botSpeechStyle: null,
        trackAsGlobalSpammer: false,
        persistModerationEvent,
      }),
    ).resolves.toBe(false);

    expect(sanctionStateLock.runExclusive).toHaveBeenCalledTimes(1);
    expect(maxBotLinkService.isKnownBotUserId).toHaveBeenCalledWith('runtime-bot-user-1');
    expect(leaseGuard.assertOwned).toHaveBeenCalledTimes(1);
    expect(sanctionStateFence.prepare).not.toHaveBeenCalled();
    expect(persistModerationEvent).not.toHaveBeenCalled();
    expect(maxClient.banMember).not.toHaveBeenCalled();
    expect(maxClient.sendMessage).not.toHaveBeenCalled();
  });

  it('does not send link explanation when link bot toggle is disabled', async () => {
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings({ linkBotMessageEnabled: false }),
          domains: [],
        }),
      },
      violation: {
        create: jest.fn(),
      },
      moderationEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
      webhookEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };
    const ruleEngine = {
      detect: jest.fn().mockResolvedValue({
        violations: [{ ruleCode: 'LINK_BLOCKED', score: 0.9, reason: 'Link detected' }],
      }),
    };
    const sanctionService = {
      resolveAction: jest.fn().mockResolvedValue(SanctionAction.WARN),
    };
    const maxClient = {
      deleteMessage: jest.fn(),
      sendMessage: jest.fn(),
      kickMember: jest.fn(),
      banMember: jest.fn(),
      notifyModerators: jest.fn(),
    };

    const service = new ModerationService(
      prisma as never,
      ruleEngine as never,
      sanctionService as never,
      maxClient as never,
    );

    await service.handleUpdate(createUpdate());

    expectImmediateDeleteMessage(maxClient.deleteMessage, 'chat-1', 'msg-1');
    expect(maxClient.sendMessage).not.toHaveBeenCalled();
    expect(sanctionService.resolveAction).not.toHaveBeenCalled();
    expect(maxClient.kickMember).not.toHaveBeenCalled();
    expect(maxClient.banMember).not.toHaveBeenCalled();
    expect(prisma.moderationEvent.create).toHaveBeenCalledTimes(2);
    expect(prisma.moderationEvent.create).toHaveBeenNthCalledWith(2, {
      data: expect.objectContaining({
        ruleCode: 'LINK_BLOCKED',
        action: SanctionAction.NONE,
      }),
    });
  });

  it('keeps a link message when fresh allowlist permits a stale cached violation', async () => {
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings({ linkBotMessageEnabled: true }),
          domains: [],
          admins: [],
        }),
      },
      domainAllowlist: {
        findMany: jest.fn().mockResolvedValue([{ domain: 'domain:avito.ru' }]),
      },
      violation: {
        create: jest.fn(),
      },
      moderationEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
      webhookEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };
    const ruleEngine = {
      detect: jest.fn().mockResolvedValue({
        violations: [
          {
            ruleCode: 'LINK_BLOCKED',
            score: 0.9,
            reason: 'Link https://www.avito.ru/item/123 is not in allowlist',
          },
        ],
      }),
    };
    const maxClient = {
      deleteMessage: jest.fn(),
      sendMessage: jest.fn(),
      kickMember: jest.fn(),
      banMember: jest.fn(),
      notifyModerators: jest.fn(),
    };

    const service = new ModerationService(
      prisma as never,
      ruleEngine as never,
      { resolveAction: jest.fn() } as never,
      maxClient as never,
    );
    const update = createUpdate();
    if (update.message) {
      update.message.text = 'Продам https://www.avito.ru/item/123';
    }

    await service.handleUpdate(update);

    expect(ruleEngine.detect).toHaveBeenCalledWith(
      expect.objectContaining({
        domainAllowlist: [],
      }),
    );
    expect(prisma.domainAllowlist.findMany).toHaveBeenCalledWith({
      where: {
        chatId: 'chat-1',
        OR: [{ removeAfterAt: null }, { removeAfterAt: { gt: expect.any(Date) } }],
      },
      select: {
        domain: true,
      },
    });
    expect(maxClient.deleteMessage).not.toHaveBeenCalled();
    expect(maxClient.sendMessage).not.toHaveBeenCalled();
    expect(prisma.violation.create).not.toHaveBeenCalled();
    expect(prisma.moderationEvent.create).not.toHaveBeenCalled();
  });

  it('keeps a blocked-domain message when fresh allowlist permits a stale cached violation', async () => {
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings({
            linkBotMessageEnabled: true,
            messageLimitsBlockedDomains: ['avito.ru'],
          }),
          domains: [],
          admins: [],
        }),
      },
      domainAllowlist: {
        findMany: jest.fn().mockResolvedValue([{ domain: 'domain:avito.ru' }]),
      },
      violation: {
        create: jest.fn(),
      },
      moderationEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
      webhookEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };
    const ruleEngine = {
      detect: jest.fn().mockResolvedValue({
        violations: [
          {
            ruleCode: 'LINK_BLOCKED',
            score: 0.9,
            reason: 'Link https://www.avito.ru/item/123 is not in allowlist',
          },
          {
            ruleCode: 'MESSAGE_BLOCKED_DOMAIN',
            score: 0.9,
            reason: 'Blocked domain detected: avito.ru',
            metadata: {
              blockedDomain: 'avito.ru',
              matchedDomain: 'www.avito.ru',
              matchedLink: 'https://www.avito.ru/item/123',
            },
          },
        ],
      }),
    };
    const maxClient = {
      deleteMessage: jest.fn(),
      sendMessage: jest.fn(),
      kickMember: jest.fn(),
      banMember: jest.fn(),
      notifyModerators: jest.fn(),
    };

    const service = new ModerationService(
      prisma as never,
      ruleEngine as never,
      { resolveAction: jest.fn() } as never,
      maxClient as never,
    );
    const update = createUpdate();
    if (update.message) {
      update.message.text = 'Продам https://www.avito.ru/item/123';
    }

    await service.handleUpdate(update);

    expect(prisma.domainAllowlist.findMany).toHaveBeenCalledWith({
      where: {
        chatId: 'chat-1',
        OR: [{ removeAfterAt: null }, { removeAfterAt: { gt: expect.any(Date) } }],
      },
      select: {
        domain: true,
      },
    });
    expect(maxClient.deleteMessage).not.toHaveBeenCalled();
    expect(maxClient.sendMessage).not.toHaveBeenCalled();
    expect(prisma.violation.create).not.toHaveBeenCalled();
    expect(prisma.moderationEvent.create).not.toHaveBeenCalled();
  });

  it('recalculates blocked-domain reason after fresh allowlist permits an earlier link', async () => {
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings({
            linkPolicy: 'ALERT_ONLY',
            messageLimitsBlockedDomains: ['avito.ru', 'casino.example'],
          }),
          domains: [],
          admins: [],
        }),
      },
      domainAllowlist: {
        findMany: jest.fn().mockResolvedValue([{ domain: 'domain:avito.ru' }]),
      },
      violation: {
        create: jest.fn(),
      },
      moderationEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
      webhookEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };
    const ruleEngine = {
      detect: jest.fn().mockResolvedValue({
        violations: [
          {
            ruleCode: 'MESSAGE_BLOCKED_DOMAIN',
            score: 0.9,
            reason: 'Blocked domain detected: avito.ru',
            metadata: {
              blockedDomain: 'avito.ru',
              matchedDomain: 'www.avito.ru',
              matchedLink: 'https://www.avito.ru/item/123',
            },
          },
        ],
      }),
    };
    const maxClient = {
      deleteMessage: jest.fn(),
      sendMessage: jest.fn(),
      kickMember: jest.fn(),
      banMember: jest.fn(),
      notifyModerators: jest.fn(),
    };

    const service = new ModerationService(
      prisma as never,
      ruleEngine as never,
      { resolveAction: jest.fn() } as never,
      maxClient as never,
    );
    const update = createUpdate();
    if (update.message) {
      update.message.text =
        'Продам https://www.avito.ru/item/123 и бонус https://promo.casino.example/path';
    }

    await service.handleUpdate(update);

    expectImmediateDeleteMessage(maxClient.deleteMessage, 'chat-1', 'msg-1');
    expect(prisma.violation.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        chatId: 'chat-1',
        userId: 'user-1',
        ruleCode: 'MESSAGE_BLOCKED_DOMAIN',
      }),
    });
    expect(prisma.moderationEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        ruleCode: 'MESSAGE_BLOCKED_DOMAIN_DELETE',
        metadata: expect.objectContaining({
          reason: 'Blocked domain detected: casino.example',
          blockedDomain: 'casino.example',
          matchedDomain: 'promo.casino.example',
          matchedLink: 'https://promo.casino.example/path',
        }),
      }),
    });
  });

  it.each([
    { actionBand: 'DELETE', messageDisposition: undefined, guardResult: 'allowed' },
    { actionBand: 'WARN', messageDisposition: undefined, guardResult: 'allowed' },
    { actionBand: 'WARN', messageDisposition: 'DELETE', guardResult: 'allowed' },
    { actionBand: 'DELETE', messageDisposition: 'DELETE', guardResult: 'allowed' },
    { actionBand: 'WARN', messageDisposition: 'DELETE', guardResult: 'absent' },
    { actionBand: 'WARN', messageDisposition: 'DELETE', guardResult: 'rejected' },
  ])(
    'deletes an eligible commercial ad and sends first-step explanation: %j',
    async ({ actionBand, messageDisposition, guardResult }) => {
      const prisma = {
        chat: {
          upsert: jest.fn().mockResolvedValue({
            id: 'chat-1',
            title: 'Chat 1',
            settings: createSettings({
              commercialAdsFilterEnabled: true,
              textFiltersBotMessageEnabled: true,
              textFiltersWarnEnabled: true,
              textFiltersBotButtonEnabled: true,
              textFiltersBotButtonUrl: 'https://max.ru/channel/rules',
              textFiltersBotButtonText: 'Правила',
            }),
            domains: [],
          }),
        },
        violation: {
          create: jest.fn(),
        },
        moderationEvent: {
          findFirst: jest.fn().mockResolvedValue(null),
          create: jest.fn(),
        },
        webhookEvent: {
          findUnique: jest.fn(),
          update: jest.fn(),
        },
      };
      const ruleEngine = {
        detect: jest.fn().mockResolvedValue({
          violations: [
            {
              ruleCode: 'COMMERCIAL_AD',
              score: 0.9,
              reason: 'Detected ad',
              metadata: {
                confidenceScore: 88,
                decisionBand: 'HIGH',
                actionBand,
                messageDisposition,
                matchedSignals: ['intent:продам', 'contact:пишите в лс'],
                negativeSignals: [],
                appliedThresholds: {
                  warnThreshold: 45,
                  deleteThreshold: 65,
                  sensitivity: 'BALANCED',
                },
              },
            },
          ],
        }),
      };
      const sanctionService = {
        resolveAction: jest.fn(),
      };
      const maxClient = {
        deleteMessage: jest.fn(),
        sendMessage: jest.fn(),
        kickMember: jest.fn(),
        banMember: jest.fn(),
        notifyModerators: jest.fn(),
      };

      const service = new ModerationService(
        prisma as never,
        ruleEngine as never,
        sanctionService as never,
        maxClient as never,
      );

      const proof = installCommercialDeleteGuard(service);
      if (guardResult === 'rejected')
        proof.guard.assertMessageStillActionable.mockRejectedValue(
          new CommercialDeleteGuardRejectedError('commercial_text_settings_disabled'),
        );
      else proof.guard.assertMessageStillActionable.mockResolvedValue(guardResult);
      await service.handleUpdate(createUpdate());
      if (guardResult !== 'allowed') {
        expect(proof.remoteDelete).not.toHaveBeenCalled();
        expect(prisma.violation.create).not.toHaveBeenCalled();
        expect(maxClient.sendMessage).not.toHaveBeenCalled();
        expect(maxClient.banMember).not.toHaveBeenCalled();
        expect(prisma.moderationEvent.create).not.toHaveBeenCalled();
        return;
      }

      expectImmediateDeleteMessage(maxClient.deleteMessage, 'chat-1', 'msg-1');
      (expect(maxClient.sendMessage) as any).toHaveBeenCalledWithPrefix(
        'chat-1',
        majorExplanation('Алексей', 'удалено', 'коммерческая реклама запрещена правилами чата'),
        {
          button: {
            text: 'Правила',
            url: 'https://max.ru/channel/rules',
          },
          textFormat: 'html',
          marketplacePublication: {
            entityId: 'chat-1',
            purpose: 'MODERATION_NOTICE',
            module: 'COMMERCIAL',
          },
        },
      );
      expect(sanctionService.resolveAction).not.toHaveBeenCalled();
      expect(prisma.moderationEvent.create).toHaveBeenNthCalledWith(1, {
        data: expect.objectContaining({
          ruleCode: 'COMMERCIAL_AD_DELETE',
          action: SanctionAction.DELETE_MESSAGE,
        }),
      });
      expect(prisma.moderationEvent.create).toHaveBeenNthCalledWith(2, {
        data: expect.objectContaining({
          ruleCode: 'COMMERCIAL_AD',
          action: SanctionAction.NONE,
        }),
      });
    },
  );

  it.each([
    { actionBand: 'REVIEW_ONLY', actionable: false, recordable: false },
    { actionBand: 'REVIEW_ONLY', actionable: false, recordable: false, messageDisposition: 'KEEP' },
    { actionBand: 'WARN', actionable: true, recordable: true, messageDisposition: 'KEEP' },
    { actionBand: 'DELETE', actionable: true, recordable: true, messageDisposition: null },
  ])(
    'keeps non-enforceable commercial telemetry out of user-facing moderation: %j',
    async (commercialPolicy) => {
      const maxClient = {
        deleteMessage: jest.fn(),
        sendMessage: jest.fn(),
        kickMember: jest.fn(),
        banMember: jest.fn(),
        notifyModerators: jest.fn(),
      };
      const prisma = {
        chat: {
          upsert: jest.fn().mockResolvedValue({
            id: 'chat-1',
            title: 'Chat 1',
            settings: createSettings({
              commercialAdsFilterEnabled: true,
              textFiltersBotMessageEnabled: true,
              textFiltersWarnEnabled: true,
              textFiltersMuteEnabled: true,
              textFiltersBanEnabled: true,
            }),
            domains: [],
          }),
        },
        violation: {
          create: jest.fn(),
          count: jest.fn(),
        },
        moderationEvent: {
          findFirst: jest.fn().mockResolvedValue(null),
          create: jest.fn(),
        },
        webhookEvent: {
          findUnique: jest.fn(),
          update: jest.fn(),
        },
      };
      const ruleEngine = {
        detect: jest.fn().mockResolvedValue({
          violations: [
            {
              ruleCode: 'COMMERCIAL_AD',
              score: 0,
              reason: 'Ambiguous transport candidate',
              metadata: {
                confidenceScore: 0,
                decisionBand: 'LOW',
                matchedSignals: ['review-only:transport-door-to-door-operator'],
                negativeSignals: [],
                ...commercialPolicy,
                reviewRecommended: true,
                reviewReasons: ['ambiguous-transport-review-only'],
                appliedThresholds: {
                  warnThreshold: 45,
                  deleteThreshold: 65,
                  sensitivity: 'BALANCED',
                },
              },
            },
          ],
        }),
      };
      const service = new ModerationService(
        prisma as never,
        ruleEngine as never,
        { resolveAction: jest.fn() } as never,
        maxClient as never,
      );

      const immunity = jest
        .spyOn(service as any, 'consumeChatParticipantModerationImmunity')
        .mockResolvedValue(true);
      await service.handleUpdate(createUpdate());
      expect(immunity).not.toHaveBeenCalled();

      expect(maxClient.deleteMessage).not.toHaveBeenCalled();
      expect(maxClient.sendMessage).not.toHaveBeenCalled();
      expect(prisma.violation.create).not.toHaveBeenCalled();
      expect(prisma.violation.count).not.toHaveBeenCalled();
      expect(prisma.moderationEvent.create).toHaveBeenCalledTimes(1);
      expect(prisma.moderationEvent.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          ruleCode: 'COMMERCIAL_AD',
          action: SanctionAction.NONE,
          metadata: expect.not.objectContaining({
            textFilterViolationCount24h: expect.any(Number),
          }),
        }),
      });
    },
  );

  it.each([
    [
      'profanity',
      {
        ruleCode: 'PROFANITY',
        score: 0.95,
        reason: 'Detected profanity or abusive language pattern',
      },
    ],
    [
      'blocked word',
      {
        ruleCode: 'MESSAGE_BLOCKED_WORD',
        score: 0.89,
        reason: 'Blocked word detected: казино',
        metadata: { blockedWord: 'казино' },
      },
    ],
    [
      'blocked phone',
      {
        ruleCode: 'PHONE_NUMBER_BLOCKED',
        score: 0.9,
        reason: 'Phone numbers are disabled in this chat',
      },
    ],
  ])('does not let ambiguous-transport review telemetry mask %s', async (_label, violation) => {
    const maxClient = {
      deleteMessage: jest.fn(),
      sendMessage: jest.fn(),
      kickMember: jest.fn(),
      banMember: jest.fn(),
      notifyModerators: jest.fn(),
    };
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings({ commercialAdsFilterEnabled: true }),
          domains: [],
        }),
      },
      violation: {
        create: jest.fn(),
        count: jest.fn().mockResolvedValue(1),
      },
      moderationEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
      webhookEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };
    const ruleEngine = {
      detect: jest.fn().mockResolvedValue({
        violations: [
          {
            ruleCode: 'COMMERCIAL_AD',
            score: 0,
            reason: 'Ambiguous transport candidate',
            metadata: {
              confidenceScore: 0,
              decisionBand: 'LOW',
              matchedSignals: ['review-only:transport-door-to-door-operator'],
              negativeSignals: [],
              actionBand: 'REVIEW_ONLY',
              actionable: false,
              recordable: false,
              reviewRecommended: true,
              reviewReasons: ['ambiguous-transport-review-only'],
            },
          },
          violation,
        ],
      }),
    };
    const service = new ModerationService(
      prisma as never,
      ruleEngine as never,
      { resolveAction: jest.fn() } as never,
      maxClient as never,
    );

    installProfanityDeleteGuard(service);
    await service.handleUpdate(createUpdate());

    expectImmediateDeleteMessage(maxClient.deleteMessage, 'chat-1', 'msg-1');
    expect(prisma.violation.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        ruleCode: violation.ruleCode,
      }),
    });
    expect(prisma.violation.create).not.toHaveBeenCalledWith({
      data: expect.objectContaining({
        ruleCode: 'COMMERCIAL_AD',
      }),
    });
    expect(prisma.moderationEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        ruleCode: `${violation.ruleCode}_DELETE`,
        action: SanctionAction.DELETE_MESSAGE,
      }),
    });
  });

  it('deletes first-step WARN commercial detections before sending explanation', async () => {
    const maxClient = {
      deleteMessage: jest.fn(),
      sendMessage: jest.fn(),
      kickMember: jest.fn(),
      banMember: jest.fn(),
      notifyModerators: jest.fn(),
    };
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings({
            commercialAdsFilterEnabled: true,
            textFiltersBotMessageEnabled: true,
            textFiltersWarnEnabled: true,
            textFiltersMuteEnabled: true,
            textFiltersBanEnabled: true,
          }),
          domains: [],
        }),
      },
      violation: {
        create: jest.fn(),
        count: jest.fn().mockResolvedValue(1),
      },
      moderationEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
      webhookEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };
    const ruleEngine = {
      detect: jest.fn().mockResolvedValue({
        violations: [
          {
            ruleCode: 'COMMERCIAL_AD',
            score: 0.68,
            reason: 'Detected reviewable commercial ad',
            metadata: {
              confidenceScore: 68,
              decisionBand: 'MEDIUM',
              actionBand: 'WARN',
              matchedSignals: ['service-specialty:yard-cleanup-service', 'contact:phone'],
              negativeSignals: [],
              appliedThresholds: {
                warnThreshold: 57,
                deleteThreshold: 77,
                sensitivity: 'BALANCED',
              },
            },
          },
        ],
      }),
    };
    const service = new ModerationService(
      prisma as never,
      ruleEngine as never,
      { resolveAction: jest.fn() } as never,
      maxClient as never,
    );

    installCommercialDeleteGuard(service);
    await service.handleUpdate(createUpdate());

    expectImmediateDeleteMessage(maxClient.deleteMessage, 'chat-1', 'msg-1');
    expect(prisma.violation.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        chatId: 'chat-1',
        userId: 'user-1',
        ruleCode: 'COMMERCIAL_AD',
      }),
    });
    expect(maxClient.sendMessage).toHaveBeenCalledTimes(1);
    (expect(maxClient.sendMessage) as any).toHaveBeenCalledWithPrefix(
      'chat-1',
      majorExplanation('Алексей', 'удалено', 'коммерческая реклама запрещена правилами чата'),
    );
    expect(prisma.moderationEvent.create).toHaveBeenNthCalledWith(1, {
      data: expect.objectContaining({
        ruleCode: 'COMMERCIAL_AD_DELETE',
        action: SanctionAction.DELETE_MESSAGE,
        metadata: expect.objectContaining({
          actionBand: 'WARN',
        }),
      }),
    });
    expect(prisma.moderationEvent.create).toHaveBeenNthCalledWith(2, {
      data: expect.objectContaining({
        ruleCode: 'COMMERCIAL_AD',
        action: SanctionAction.NONE,
        metadata: expect.objectContaining({
          actionBand: 'WARN',
          textFilterViolationCount24h: 1,
          textFilterEscalationWindowHours: 24,
        }),
      }),
    });
  });

  it('deletes DELETE_AND_ESCALATE commercial detections without direct first-hit sanction', async () => {
    const maxClient = {
      deleteMessage: jest.fn(),
      sendMessage: jest.fn(),
      kickMember: jest.fn(),
      banMember: jest.fn(),
      notifyModerators: jest.fn(),
    };
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings({
            commercialAdsFilterEnabled: true,
            textFiltersBotMessageEnabled: true,
            textFiltersWarnEnabled: true,
            textFiltersMuteEnabled: true,
            textFiltersBanEnabled: true,
          }),
          domains: [],
        }),
      },
      violation: {
        create: jest.fn(),
        count: jest.fn().mockResolvedValue(1),
      },
      moderationEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
      webhookEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };
    const ruleEngine = {
      detect: jest.fn().mockResolvedValue({
        violations: [
          {
            ruleCode: 'COMMERCIAL_AD',
            score: 0.96,
            reason: 'High-risk commercial leadgen',
            metadata: {
              confidenceScore: 96,
              decisionBand: 'HIGH',
              actionBand: 'DELETE_AND_ESCALATE',
              matchedSignals: ['risk:loan-leadgen', 'deal-channel:link'],
              negativeSignals: [],
              reasonCodes: ['action:DELETE_AND_ESCALATE', 'risk:escalation-grade'],
              appliedThresholds: {
                warnThreshold: 45,
                deleteThreshold: 65,
                sensitivity: 'BALANCED',
              },
            },
          },
        ],
      }),
    };
    const sanctionService = {
      resolveAction: jest.fn(),
    };
    const service = new ModerationService(
      prisma as never,
      ruleEngine as never,
      sanctionService as never,
      maxClient as never,
    );

    installCommercialDeleteGuard(service);
    await service.handleUpdate(createUpdate());

    expectImmediateDeleteMessage(maxClient.deleteMessage, 'chat-1', 'msg-1');
    expect(maxClient.kickMember).not.toHaveBeenCalled();
    expect(maxClient.banMember).not.toHaveBeenCalled();
    expect(sanctionService.resolveAction).not.toHaveBeenCalled();
    expect(prisma.moderationEvent.create).toHaveBeenNthCalledWith(1, {
      data: expect.objectContaining({
        ruleCode: 'COMMERCIAL_AD_DELETE',
        action: SanctionAction.DELETE_MESSAGE,
        metadata: expect.objectContaining({
          actionBand: 'DELETE_AND_ESCALATE',
          reasonCodes: ['action:DELETE_AND_ESCALATE', 'risk:escalation-grade'],
        }),
      }),
    });
    expect(prisma.moderationEvent.create).toHaveBeenNthCalledWith(2, {
      data: expect.objectContaining({
        ruleCode: 'COMMERCIAL_AD',
        action: SanctionAction.NONE,
        metadata: expect.objectContaining({
          actionBand: 'DELETE_AND_ESCALATE',
          textFilterViolationCount24h: 1,
          textFilterEscalationWindowHours: 24,
        }),
      }),
    });
  });

  it('keeps commercial detections without action band out of user-facing moderation', async () => {
    const maxClient = {
      deleteMessage: jest.fn(),
      sendMessage: jest.fn(),
      kickMember: jest.fn(),
      banMember: jest.fn(),
      notifyModerators: jest.fn(),
    };
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings({
            commercialAdsFilterEnabled: true,
            textFiltersBotMessageEnabled: true,
            textFiltersWarnEnabled: true,
            textFiltersMuteEnabled: true,
            textFiltersBanEnabled: true,
          }),
          domains: [],
        }),
      },
      violation: {
        create: jest.fn(),
        count: jest.fn(),
      },
      moderationEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
      webhookEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };
    const ruleEngine = {
      detect: jest.fn().mockResolvedValue({
        violations: [
          {
            ruleCode: 'COMMERCIAL_AD',
            score: 0.95,
            reason: 'Commercial candidate from legacy path',
            metadata: {
              confidenceScore: 95,
              decisionBand: 'HIGH',
              matchedSignals: ['channel-placement:mass-invite-link', 'deal-channel:link'],
            },
          },
        ],
      }),
    };
    const service = new ModerationService(
      prisma as never,
      ruleEngine as never,
      { resolveAction: jest.fn() } as never,
      maxClient as never,
    );

    await service.handleUpdate(createUpdate());

    expect(maxClient.deleteMessage).not.toHaveBeenCalled();
    expect(maxClient.sendMessage).not.toHaveBeenCalled();
    expect(prisma.violation.create).not.toHaveBeenCalled();
    expect(prisma.violation.count).not.toHaveBeenCalled();
    expect(prisma.moderationEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        ruleCode: 'COMMERCIAL_AD',
        action: SanctionAction.NONE,
      }),
    });
  });

  it('does not moderate message when commercial detector returns no violation', async () => {
    const maxClient = {
      deleteMessage: jest.fn(),
      sendMessage: jest.fn(),
      kickMember: jest.fn(),
      banMember: jest.fn(),
      notifyModerators: jest.fn(),
    };
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings({
            commercialAdsFilterEnabled: true,
          }),
          domains: [],
        }),
      },
      violation: {
        create: jest.fn(),
      },
      moderationEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
      webhookEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };
    const ruleEngine = {
      detect: jest.fn().mockResolvedValue({
        violations: [],
      }),
    };
    const service = new ModerationService(
      prisma as never,
      ruleEngine as never,
      { resolveAction: jest.fn() } as never,
      maxClient as never,
    );

    await service.handleUpdate(createUpdate());

    expect(prisma.violation.create).not.toHaveBeenCalled();
    expect(maxClient.deleteMessage).not.toHaveBeenCalled();
    expect(maxClient.sendMessage).not.toHaveBeenCalled();
    expect(prisma.moderationEvent.create).not.toHaveBeenCalled();
  });

  it('sends warning on second commercial violation when explanation and warning are enabled', async () => {
    const maxClient = {
      deleteMessage: jest.fn(),
      sendMessage: jest.fn(),
      kickMember: jest.fn(),
      banMember: jest.fn(),
      notifyModerators: jest.fn(),
    };
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings({
            commercialAdsFilterEnabled: true,
            textFiltersBotMessageEnabled: true,
            textFiltersWarnEnabled: true,
          }),
          domains: [],
        }),
      },
      violation: {
        create: jest.fn(),
        count: jest.fn().mockResolvedValue(2),
      },
      moderationEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
      webhookEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };
    const ruleEngine = {
      detect: jest.fn().mockResolvedValue({
        violations: [
          {
            ruleCode: 'COMMERCIAL_AD',
            score: 0.92,
            reason: 'High confidence ad',
            metadata: {
              confidenceScore: 92,
              decisionBand: 'HIGH',
              actionBand: 'DELETE',
              matchedSignals: ['intent:продам', 'contact:пишите в лс', 'transaction:price'],
              negativeSignals: [],
              appliedThresholds: {
                warnThreshold: 45,
                deleteThreshold: 65,
                sensitivity: 'BALANCED',
              },
            },
          },
        ],
      }),
    };
    const service = new ModerationService(
      prisma as never,
      ruleEngine as never,
      { resolveAction: jest.fn() } as never,
      maxClient as never,
    );

    installCommercialDeleteGuard(service);
    await service.handleUpdate(createUpdate());

    expectImmediateDeleteMessage(maxClient.deleteMessage, 'chat-1', 'msg-1');
    expect(maxClient.sendMessage).toHaveBeenCalledTimes(1);
    (expect(maxClient.sendMessage) as any).toHaveBeenCalledWithPrefix(
      'chat-1',
      textFilterWarnNotice('Алексей', 'коммерческая реклама запрещена правилами чата'),
    );
    expect(prisma.moderationEvent.create).toHaveBeenNthCalledWith(2, {
      data: expect.objectContaining({
        ruleCode: 'COMMERCIAL_AD',
        action: SanctionAction.WARN,
        metadata: expect.objectContaining({
          textFilterViolationCount24h: 2,
          textFilterEscalationWindowHours: 24,
        }),
      }),
    });
  });

  it.each([
    { strike: 1, revokeDuring: 'contact' },
    { strike: 2, revokeDuring: 'media' },
  ])(
    'rechecks commercial notice authority after $revokeDuring work at strike $strike',
    async ({ strike, revokeDuring }) => {
      const prisma = {
        chat: {
          upsert: jest.fn().mockResolvedValue({
            id: 'chat-1',
            title: 'Chat 1',
            domains: [],
            settings: createSettings({
              commercialAdsFilterEnabled: true,
              textFiltersBotMessageEnabled: true,
              textFiltersWarnEnabled: true,
            }),
          }),
        },
        violation: { create: jest.fn(), count: jest.fn().mockResolvedValue(strike) },
        moderationEvent: { findFirst: jest.fn().mockResolvedValue(null), create: jest.fn() },
        webhookEvent: { findUnique: jest.fn(), update: jest.fn() },
      };
      const maxClient = {
        deleteMessage: jest.fn(),
        sendMessage: jest.fn(),
        kickMember: jest.fn(),
        banMember: jest.fn(),
        notifyModerators: jest.fn(),
      };
      const service = new ModerationService(
        prisma as never,
        {
          detect: jest.fn().mockResolvedValue({
            violations: [
              {
                ruleCode: 'COMMERCIAL_AD',
                score: 0.92,
                reason: 'High confidence ad',
                metadata: { actionBand: 'DELETE', messageDisposition: 'DELETE' },
              },
            ],
          }),
        } as never,
        { resolveAction: jest.fn() } as never,
        maxClient as never,
      );
      const { guard, remoteDelete } = installCommercialDeleteGuard(service);
      jest
        .spyOn(
          service as any,
          revokeDuring === 'contact'
            ? 'appendAdminContactMarkdownLink'
            : 'withBotSpeechMediaOptions',
        )
        .mockImplementation(async (...args: unknown[]) => {
          guard.authorizeSanction.mockResolvedValue(false);
          return revokeDuring === 'contact' ? args[1] : args[0];
        });
      await service.handleUpdate(createUpdate());
      expect(remoteDelete).toHaveBeenCalledTimes(1);
      expect(guard.authorizeSanction.mock.calls.length).toBeGreaterThanOrEqual(3);
      expect(maxClient.sendMessage).not.toHaveBeenCalled();
      expect(maxClient.kickMember).not.toHaveBeenCalled();
      expect(maxClient.banMember).not.toHaveBeenCalled();
      expect(
        prisma.moderationEvent.create.mock.calls.some(
          ([call]) =>
            call.data.ruleCode === 'COMMERCIAL_AD' && call.data.metadata.sanctionApplied === true,
        ),
      ).toBe(false);
      if (strike === 2)
        expect(prisma.moderationEvent.create).toHaveBeenCalledWith({
          data: expect.objectContaining({ action: SanctionAction.WARN }),
        });
    },
  );

  it.each(['revoked', 'failed', 'confirmed'] as const)(
    'records commercial BAN reputation only after a confirmed guarded mutation: %s',
    async (outcome) => {
      const effects: string[] = [];
      const prisma = {
        chat: {
          upsert: jest.fn().mockResolvedValue({
            id: 'chat-1',
            title: 'Chat 1',
            domains: [],
            settings: createSettings({
              commercialAdsFilterEnabled: true,
              textFiltersBanEnabled: true,
            }),
          }),
        },
        violation: { create: jest.fn(), count: jest.fn().mockResolvedValue(3) },
        moderationEvent: {
          findFirst: jest.fn().mockResolvedValue(null),
          create: jest.fn().mockResolvedValue({ id: 'event' }),
        },
        webhookEvent: { findUnique: jest.fn(), update: jest.fn() },
        globalSpammer: {
          upsert: jest.fn(async () => {
            effects.push('reputation');
          }),
        },
      };
      const maxClient = {
        deleteMessage: jest.fn(),
        sendMessage: jest.fn(),
        kickMember: jest.fn(),
        banMember: jest.fn(),
        notifyModerators: jest.fn(),
      };
      const service = new ModerationService(
        prisma as never,
        {
          detect: jest.fn().mockResolvedValue({
            violations: [
              {
                ruleCode: 'COMMERCIAL_AD',
                score: 0.92,
                reason: 'High confidence ad',
                metadata: { actionBand: 'DELETE', messageDisposition: 'DELETE' },
              },
            ],
          }),
        } as never,
        { resolveAction: jest.fn() } as never,
        maxClient as never,
      );
      const { guard } = installCommercialDeleteGuard(service);
      maxClient.banMember.mockImplementation(
        async (
          _chatId: string,
          _userId: string,
          options?: { beforeImmediateMemberMutation?: () => Promise<void> },
        ) => {
          if (outcome === 'revoked') guard.authorizeSanction.mockResolvedValue(false);
          await options?.beforeImmediateMemberMutation?.();
          if (outcome === 'failed') throw new Error('Remote mutation failed');
          effects.push('remote-ban');
        },
      );
      await service.handleUpdate(createUpdate());
      if (outcome === 'confirmed') {
        expect(effects).toEqual(['remote-ban', 'reputation']);
        expect(prisma.globalSpammer.upsert).toHaveBeenCalledTimes(1);
        expect(prisma.globalSpammer.upsert).toHaveBeenCalledWith(
          expect.objectContaining({
            create: expect.objectContaining({ lastReason: 'SANCTION_BAN' }),
          }),
        );
      } else {
        expect(prisma.globalSpammer.upsert).not.toHaveBeenCalled();
        expect(maxClient.sendMessage).not.toHaveBeenCalled();
        expect(
          prisma.moderationEvent.create.mock.calls.some(
            ([call]) => call.data.action === SanctionAction.BAN,
          ),
        ).toBe(false);
      }
    },
  );

  it('rechecks the generic commercial mute notice after sanction persistence', async () => {
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          domains: [],
          settings: createSettings({
            commercialAdsFilterEnabled: true,
            textFiltersMuteEnabled: true,
          }),
        }),
      },
      violation: { create: jest.fn(), count: jest.fn().mockResolvedValue(3) },
      moderationEvent: { findFirst: jest.fn().mockResolvedValue(null), create: jest.fn() },
      webhookEvent: { findUnique: jest.fn(), update: jest.fn() },
    };
    const maxClient = {
      deleteMessage: jest.fn(),
      sendMessage: jest.fn(),
      kickMember: jest.fn(),
      banMember: jest.fn(),
      notifyModerators: jest.fn(),
    };
    withAutomaticMutePersistenceFixture(prisma);
    const service = new ModerationService(
      prisma as never,
      {
        detect: jest.fn().mockResolvedValue({
          violations: [
            {
              ruleCode: 'COMMERCIAL_AD',
              score: 0.92,
              reason: 'High confidence ad',
              metadata: { actionBand: 'DELETE', messageDisposition: 'DELETE' },
            },
          ],
        }),
      } as never,
      { resolveAction: jest.fn() } as never,
      maxClient as never,
    );
    const { guard } = installCommercialDeleteGuard(service);
    prisma.moderationEvent.create.mockImplementation(
      async ({ data }: { data: { action: SanctionAction } }) => {
        if (data.action === SanctionAction.MUTE) guard.authorizeSanction.mockResolvedValue(false);
        return { id: 'event' };
      },
    );
    await service.handleUpdate(createUpdate());
    expect(prisma.moderationEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ action: SanctionAction.MUTE }),
    });
    expect(maxClient.sendMessage).not.toHaveBeenCalled();
  });

  it('ignores retired topic-filter violations before deletion or sanctions', async () => {
    const maxClient = {
      deleteMessage: jest.fn(),
      sendMessage: jest.fn(),
      kickMember: jest.fn(),
      banMember: jest.fn(),
      notifyModerators: jest.fn(),
    };
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings({
            thematicCodewordEnabled: true,
            thematicCodeword: 'недвижимость',
          }),
          domains: [],
        }),
      },
      violation: {
        create: jest.fn(),
      },
      moderationEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
      webhookEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };
    const ruleEngine = {
      detect: jest.fn().mockResolvedValue({
        violations: [
          {
            ruleCode: 'TOPIC_FILTER_MISMATCH',
            score: 0.84,
            reason: 'Retired thematic filter result',
            metadata: { requiredCodeword: 'недвижимость' },
          },
        ],
      }),
    };
    const sanctionService = { resolveAction: jest.fn() };
    const service = new ModerationService(
      prisma as never,
      ruleEngine as never,
      sanctionService as never,
      maxClient as never,
    );

    await service.handleUpdate(createUpdate());

    expect(maxClient.deleteMessage).not.toHaveBeenCalled();
    expect(maxClient.sendMessage).not.toHaveBeenCalled();
    expect(maxClient.kickMember).not.toHaveBeenCalled();
    expect(maxClient.banMember).not.toHaveBeenCalled();
    expect(sanctionService.resolveAction).not.toHaveBeenCalled();
    expect(prisma.violation.create).not.toHaveBeenCalled();
    expect(prisma.moderationEvent.create).not.toHaveBeenCalled();
  });
});
