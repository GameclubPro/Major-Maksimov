import {
  USER_AGREEMENT_SHORT_NOTICE,
  SanctionAction,
  createDuplicateSanctionAuthorization,
  buildActiveMuteStateKey,
  DEVELOPER_FORCED_GLOBAL_SPAMMER_WARM_MARKER_TTL_SEC,
  buildDeveloperForcedGlobalSpammerCacheKey,
  buildDeveloperForcedGlobalSpammerWarmMarkerKey,
  ModerationService,
  resolveModerationDeleteIntentRollout,
  MODERATION_ACTION_DISPATCH_TIMEOUT_MS,
  userMention,
  expectImmediateDeleteMessage,
  expectImmediateKickMember,
  nightModeNotice,
  nightModeOpenNotice,
  createMaxApiError,
  createRedisCounterMock,
  createModerationServiceWithManualBridge,
  createSettings,
  createUpdate,
  createBotAuthoredUpdate,
  createOwnBotUpdateWithoutBotFlags,
  createServiceBotJoinedUpdate,
  createBotAddedUpdate,
  createServiceUserJoinedUpdate,
  createServiceUserJoinedUpdateWithSplitName,
  createServiceUserJoinedUpdateInDataEnvelope,
  createServiceUserJoinedUpdateWithoutServiceSender,
  createUserAddedUpdate,
  createUserAddedUpdateWithSuffix,
  createUserRemovedUpdate,
  createBotRemovedUpdate,
  createBotStartedPrivateUpdate,
  createBotStartedPrivateHandoffUpdate,
  createBotStartedGroupUpdate,
  createPrivateCommandUpdate,
  createPrivateCallbackUpdate,
  createModerationReleaseCallbackUpdate,
  createOldUpdate,
  type MaxUpdate,
} from './moderation.service.spec-support';
import { MAX_SEND_FENCE_STALE_MS } from '../max/max-send-ambiguity.util';
import { WebhookParser } from '../webhook/webhook.parser';
import { hasPersistedTerminalDuplicateSanction } from './moderation-message-action-claim';
import { duplicateExplanationIdempotencyKey } from './duplicate-moderation.actions';
import type { EnsureModerationDeleteIntentInput } from './moderation-delete-intent.types';
import { ConfigService } from '@nestjs/config';
import { MaxBotRegistryService } from '../max/max-bot-registry.service';
import type { MaxBotLinkService } from '../max/max-bot-link.service';
import { MAX_ERASER_BOT_CONTACT_ID, MAX_ERASER_BOT_ID } from '../max/max-service-bot-identities';

function installStateDeleteExecutorFixture(service: ModerationService) {
  const dependencies = service as unknown as {
    prisma: { moderationEvent: { create: jest.Mock } };
    maxClient: { deleteMessage: jest.Mock };
  };
  const allowedRules = new Set([
    'BOT_ACCOUNT_MESSAGE_DELETE',
    'GLOBAL_SPAMMER_MESSAGE_DELETE',
    'MUTE_ACTIVE_DELETE',
    'NIGHT_MODE_DELETE',
  ]);
  // FLAG: These lifecycle fixtures exercise the durable executor boundary. Native
  // multibot tests cover its actual source, current-state and transport guards.
  const executor = {
    ensureIntent: jest.fn(),
    getRolloutForInput: () => 'execute',
    ensureAndAttempt: jest.fn(async (input: EnsureModerationDeleteIntentInput) => {
      if (!input.ruleCode || !allowedRules.has(input.ruleCode))
        throw new Error('State executor fixture received an unrelated rule');
      if (
        !input.sourceMessageAt ||
        Date.now() >= new Date(input.sourceMessageAt).getTime() + 300_000
      )
        return { kind: 'expired', confirmed: false };
      await dependencies.maxClient.deleteMessage(input.chatId, input.messageId, {
        immediate: true,
        trafficClass: 'critical',
        actionHealthLane: 'critical',
        sourceTag: 'moderation_delete',
        timeoutMs: MODERATION_ACTION_DISPATCH_TIMEOUT_MS,
        ignoreFailureMetricStatuses: [403, 404],
      });
      if (input.event?.eventType === 'MESSAGE')
        await dependencies.prisma.moderationEvent.create({
          data: {
            chatId: input.chatId,
            userId: input.subjectUserId,
            messageId: input.messageId,
            eventType: 'MESSAGE',
            ruleCode: input.ruleCode,
            action: SanctionAction.DELETE_MESSAGE,
            operator: 'BOT',
            maskedExcerpt: input.event.maskedExcerpt,
            score: input.event.score,
            metadata: input.event.metadata,
          },
        });
      return {
        kind: 'confirmed',
        confirmed: true,
        intentId: 'lifecycle-fixture-intent',
        status: 'SUCCEEDED',
        botId: 'lifecycle-fixture-bot',
        verifiedReasonKeys: [input.reasonKey],
      };
    }),
  };
  Object.assign(service, { moderationDeleteIntentService: executor });
  return executor;
}

function userMentionHtml(displayName: string, userId: string): string {
  return `<a href="max://user/${userId}">${displayName}</a>`;
}

describe('ModerationService', () => {
  it.each([
    { text: 'Готово, чат подключен.', botId: 'major-bot', remoteMessageId: 'confirmation-1' },
    {
      text: 'Чат уже подключен. Доступ обновлен.',
      botId: 'major-bot',
      remoteMessageId: 'confirmation-1',
    },
    {
      text: 'Готово. Чат или канал подключен к Публику и появился в мини-приложении.',
      botId: 'publisher-bot',
      remoteMessageId: 'confirmation-1',
    },
    { text: 'Готово, чат подключен.', botId: 'major-bot', remoteMessageId: null },
    {
      text: 'Готово. Чат или канал подключен к Публику и появился в мини-приложении.',
      botId: 'publisher-bot',
      remoteMessageId: null,
    },
  ])(
    'preserves the Start confirmation with auto-delete enabled: $botId / $remoteMessageId',
    async ({ text, botId, remoteMessageId }) => {
      const findFirst = jest.fn();
      if (remoteMessageId) findFirst.mockResolvedValue({ id: 'start-receipt', remoteMessageId });
      else
        findFirst
          .mockResolvedValueOnce(null)
          .mockResolvedValueOnce({ id: 'start-receipt', remoteMessageId });
      const prisma = { maxActionLedgerEntry: { findFirst } };
      const service = new ModerationService(prisma as never, {} as never, {} as never, {} as never);
      (service as any).maxBotLinkService = {
        resolveBotIdFromUserId: jest.fn().mockReturnValue(botId),
      };
      const scheduleAutoDelete = jest.fn();
      (service as any).handleBotMessageAutoDelete = scheduleAutoDelete;

      await (service as any).handleOwnBotMessageAutoDelete({
        chatId: 'chat-1',
        userId: 'bot-user',
        messageId: 'confirmation-1',
        text,
        createdAt: '2026-10-01T09:00:00.000Z',
        settings: createSettings({
          deleteBotMessagesEnabled: true,
          deleteBotMessagesDelayMinutes: 0.5,
        }),
      });

      expect(scheduleAutoDelete).not.toHaveBeenCalled();
      expect(findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            chatId: 'chat-1',
            dispatchBotId: botId,
            remoteMessageId: 'confirmation-1',
            sourceTag: 'managed_handshake',
            actionType: 'SEND_MESSAGE',
          }),
        }),
      );
    },
  );

  it.each(['Готово, чат подключен.', 'Обычное сообщение бота'])(
    'retains normal auto-delete when no Start receipt owns the message: %s',
    async (text) => {
      const findFirst = jest.fn().mockResolvedValue(null);
      const prisma = {
        maxActionLedgerEntry: { findFirst },
        chatRules: { findUnique: jest.fn().mockResolvedValue(null) },
        moderationEvent: { findFirst: jest.fn().mockResolvedValue(null) },
      };
      const service = new ModerationService(prisma as never, {} as never, {} as never, {} as never);
      (service as any).maxBotLinkService = {
        resolveBotIdFromUserId: jest.fn().mockReturnValue('major-bot'),
      };
      const scheduleAutoDelete = jest.fn();
      (service as any).handleBotMessageAutoDelete = scheduleAutoDelete;
      await (service as any).handleOwnBotMessageAutoDelete({
        chatId: 'chat-1',
        userId: 'bot-user',
        messageId: 'ordinary-1',
        text,
        createdAt: '2026-10-01T09:00:00.000Z',
        settings: createSettings({
          deleteBotMessagesEnabled: true,
          deleteBotMessagesDelayMinutes: 0.5,
        }),
      });
      expect(scheduleAutoDelete).toHaveBeenCalledWith(
        expect.objectContaining({ messageId: 'ordinary-1', delayMinutes: 0.5 }),
      );
      expect(findFirst).toHaveBeenCalledTimes(text === 'Обычное сообщение бота' ? 0 : 2);
    },
  );

  it('caps violation admin recheck wait to the remaining hot-path budget under pressure', () => {
    const service = new ModerationService(
      {} as never,
      { detect: jest.fn() } as never,
      { resolveAction: jest.fn() } as never,
      {} as never,
      undefined,
      undefined,
      {
        get: jest.fn(),
      } as never,
    );

    const dateNowSpy = jest.spyOn(Date, 'now');
    let now = 10_000;
    dateNowSpy.mockImplementation(() => now);

    try {
      const profile = (service as any).createWebhookHotPathProfile();
      now = 19_400;

      const waitMs = (service as any).resolveWebhookHotPathStageWaitBudgetMs({
        hotPathProfile: profile,
        systemMode: {
          mode: 'degrade',
          reason: 'recovery window in progress',
          queueLagSec: 0,
        },
        hotChatBackoffActive: false,
        defaultWaitMs: 500,
        reserveMs: 250,
      });

      expect(waitMs).toBe(350);
    } finally {
      dateNowSpy.mockRestore();
    }
  });

  it.each([
    { mode: 'normal', operationalQueueLagSec: 0, pressure: false },
    { mode: 'normal', operationalQueueLagSec: 32, pressure: true },
    { mode: 'normal', operationalQueueLagSec: undefined, pressure: true },
    { mode: 'degrade', operationalQueueLagSec: 0, pressure: true },
  ])(
    'uses operational lag $operationalQueueLagSec for optional hot stages in $mode mode',
    ({ mode, operationalQueueLagSec, pressure }) => {
      const service = new ModerationService({} as never, {} as never, {} as never, {} as never);
      const systemMode = {
        mode,
        source: mode === 'degrade' ? 'manual' : 'auto',
        reason: mode === 'degrade' ? 'manual override' : 'system healthy',
        queueLagSec: 290,
        operationalQueueLagSec,
      };
      const dateNowSpy = jest.spyOn(Date, 'now');
      dateNowSpy.mockReturnValue(10_000);
      try {
        const profile = (service as any).createWebhookHotPathProfile();
        dateNowSpy.mockReturnValue(19_400);
        expect((service as any).shouldSkipOptionalHotChatStages(systemMode, true)).toBe(pressure);
        expect(
          (service as any).resolveWebhookHotPathStageWaitBudgetMs({
            hotPathProfile: profile,
            systemMode,
            defaultWaitMs: 500,
            reserveMs: 250,
          }),
        ).toBe(pressure ? 350 : 500);
        const skipReason = (service as any).resolveOptionalWebhookStageSkipReason({
          stage: 'cross-chat tracking',
          hotPathProfile: profile,
          systemMode,
          minRemainingMs: 700,
        });
        if (pressure) {
          expect(skipReason).toContain('cross-chat tracking skipped with 600ms remaining');
          if (mode === 'normal')
            expect(skipReason).toContain(
              `queue lag ${(operationalQueueLagSec ?? 290).toFixed(1)}s`,
            );
        } else {
          expect(skipReason).toBeNull();
        }
      } finally {
        dateNowSpy.mockRestore();
      }
    },
  );

  it('ignores bot-authored messages when delete-bot toggle is disabled', async () => {
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings({
            removeBotsFromGroupEnabled: false,
            deleteBotMessagesEnabled: false,
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
      globalSpammer: {
        upsert: jest.fn(),
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
    };

    const service = new ModerationService(
      prisma as never,
      ruleEngine as never,
      sanctionService as never,
      maxClient as never,
    );
    await service.handleUpdate(createBotAuthoredUpdate());

    expect(prisma.chat.upsert).toHaveBeenCalledTimes(1);
    expect(ruleEngine.detect).not.toHaveBeenCalled();
    expect(prisma.violation.create).not.toHaveBeenCalled();
    expect(prisma.moderationEvent.create).not.toHaveBeenCalled();
    expect(maxClient.deleteMessage).not.toHaveBeenCalled();
    expect(maxClient.sendMessage).not.toHaveBeenCalled();
    expect(maxClient.kickMember).not.toHaveBeenCalled();
    expect(maxClient.banMember).not.toHaveBeenCalled();
  });

  it('schedules auto-delete for bot-authored messages when toggle is enabled', async () => {
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings({
            removeBotsFromGroupEnabled: false,
            deleteBotMessagesEnabled: true,
            deleteBotMessagesDelayMinutes: 2,
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
      auditLog: {
        findFirst: jest.fn(),
      },
      webhookEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
      globalSpammer: {
        upsert: jest.fn(),
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
    };

    const service = new ModerationService(
      prisma as never,
      ruleEngine as never,
      sanctionService as never,
      maxClient as never,
      undefined,
      undefined,
      {
        get: jest.fn().mockReturnValue('bot-1'),
      } as never,
    );

    await service.handleUpdate(createBotAuthoredUpdate());

    expect(ruleEngine.detect).not.toHaveBeenCalled();
    expect(prisma.violation.create).not.toHaveBeenCalled();
    expect(maxClient.deleteMessage).toHaveBeenCalledWith(
      'chat-1',
      'msg-bot-1',
      expect.objectContaining({
        delayMs: 2 * 60 * 1000,
        trafficClass: 'critical',
        actionHealthLane: 'critical',
        sourceTag: 'moderation_delete',
        timeoutMs: MODERATION_ACTION_DISPATCH_TIMEOUT_MS,
      }),
    );
    expect(maxClient.sendMessage).not.toHaveBeenCalled();
    expect(maxClient.kickMember).not.toHaveBeenCalled();
    expect(maxClient.banMember).not.toHaveBeenCalled();
    expect(prisma.auditLog.findFirst).not.toHaveBeenCalled();
    expect(prisma.moderationEvent.create).not.toHaveBeenCalled();
  });

  it('keeps the legacy delete path mutually exclusive with an executing durable intent', async () => {
    const maxClient = { deleteMessage: jest.fn() };
    const deleteIntents = {
      getRolloutForChat: jest.fn().mockReturnValue('execute'),
      getRolloutForRule: jest.fn().mockReturnValue('execute'),
      getRolloutForInput: jest.fn().mockReturnValue('execute'),
      ensureIntent: jest.fn().mockResolvedValue({
        intentId: 'intent-channel-copy-1',
        rollout: 'execute',
        status: 'PENDING',
      }),
      ensureAndAttempt: jest.fn().mockResolvedValue({
        kind: 'pending',
        confirmed: false,
        intentId: 'intent-1',
        status: 'RETRYABLE',
      }),
    };
    const service = new ModerationService(
      {} as never,
      {} as never,
      {} as never,
      maxClient as never,
    );
    (service as any).moderationDeleteIntentService = deleteIntents;

    const result = await (service as any).executeModerationDelete({
      chatId: 'chat-1',
      messageId: 'message-1',
      reasonKey: 'PROFANITY:delete',
      ruleCode: 'PROFANITY_DELETE',
      subjectUserId: 'user-1',
    });

    expect(deleteIntents.ensureAndAttempt).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: 'chat-1',
        messageId: 'message-1',
        entityType: 'CHAT',
        messageAuthorKind: 'user',
        routingPolicy: 'origin_first',
      }),
      undefined,
    );
    expect(maxClient.deleteMessage).not.toHaveBeenCalled();
    expect(result).toEqual({
      accepted: true,
      gone: false,
      deleted: false,
      eventPersistedByIntent: false,
      botId: null,
    });
  });

  it('returns the bot that confirmed a durable moderation delete', async () => {
    const maxClient = { deleteMessage: jest.fn() };
    const deleteIntents = {
      getRolloutForInput: jest.fn().mockReturnValue('execute'),
      ensureAndAttempt: jest.fn().mockResolvedValue({
        kind: 'confirmed',
        confirmed: true,
        intentId: 'intent-1',
        status: 'SUCCEEDED',
        botId: 'bot-delete-capable',
      }),
    };
    const service = new ModerationService(
      {} as never,
      {} as never,
      {} as never,
      maxClient as never,
    );
    (service as any).moderationDeleteIntentService = deleteIntents;

    const result = await (service as any).executeModerationDelete({
      chatId: 'chat-1',
      messageId: 'message-1',
      reasonKey: 'REQUIRED_SUBSCRIPTION:message-delete',
      ruleCode: 'REQUIRED_SUBSCRIPTION_DELETE',
      subjectUserId: 'user-1',
    });

    expect(result).toEqual({
      accepted: true,
      gone: true,
      deleted: true,
      eventPersistedByIntent: true,
      botId: 'bot-delete-capable',
    });
    expect(maxClient.deleteMessage).not.toHaveBeenCalled();
  });

  it('does not fall back to direct deletion when exact replacement cleanup persistence fails', async () => {
    const persistenceError = new Error('intent persistence unavailable');
    const maxClient = { deleteMessage: jest.fn() };
    const deleteIntents = {
      getRolloutForChat: jest.fn().mockReturnValue('observed'),
      getRolloutForRule: jest.fn().mockReturnValue('execute'),
      getRolloutForInput: jest.fn().mockReturnValue('execute'),
      ensureAndAttempt: jest.fn().mockRejectedValue(persistenceError),
    };
    const service = new ModerationService(
      {} as never,
      {} as never,
      {} as never,
      maxClient as never,
    );
    (service as any).moderationDeleteIntentService = deleteIntents;

    await expect(
      (service as any).executeModerationDelete({
        chatId: 'chat-outside-canary',
        messageId: 'message-1',
        reasonKey: 'chat_auto_comment_admin_message_replacement_cleanup',
        ruleCode: 'CHAT_AUTO_COMMENT_ADMIN_MESSAGE_REPLACEMENT_CLEANUP',
        originBotId: 'bot-1',
      }),
    ).rejects.toBe(persistenceError);

    expect(deleteIntents.getRolloutForInput).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: 'chat-outside-canary',
        ruleCode: 'CHAT_AUTO_COMMENT_ADMIN_MESSAGE_REPLACEMENT_CLEANUP',
      }),
    );
    expect(maxClient.deleteMessage).not.toHaveBeenCalled();
  });

  it('fails closed when pre-claim replacement cleanup intent persistence fails', async () => {
    const persistenceError = new Error('intent persistence unavailable');
    const deleteIntents = {
      getRolloutForChat: jest.fn().mockReturnValue('observed'),
      getRolloutForRule: jest.fn().mockReturnValue('execute'),
      getRolloutForInput: jest.fn().mockReturnValue('execute'),
      ensureIntent: jest.fn().mockRejectedValue(persistenceError),
    };
    const service = new ModerationService({} as never, {} as never, {} as never, {} as never);
    (service as any).moderationDeleteIntentService = deleteIntents;

    await expect(
      (service as any).ensureModerationDeleteIntent({
        chatId: 'channel-outside-canary',
        messageId: 'message-1',
        reasonKey: 'channel_auto_post_forward_replacement_cleanup',
        ruleCode: 'CHANNEL_AUTO_POST_FORWARD_REPLACEMENT_CLEANUP',
        originBotId: 'bot-1',
      }),
    ).rejects.toBe(persistenceError);

    expect(deleteIntents.getRolloutForInput).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: 'channel-outside-canary',
        ruleCode: 'CHANNEL_AUTO_POST_FORWARD_REPLACEMENT_CLEANUP',
      }),
    );
  });

  it('persists a duplicate delete intent before returning for an existing semantic claim', async () => {
    const deleteIntents = {
      getRolloutForChat: jest.fn().mockReturnValue('execute'),
      getRolloutForRule: jest.fn().mockReturnValue('execute'),
      getRolloutForInput: jest.fn().mockReturnValue('execute'),
      ensureIntent: jest.fn().mockResolvedValue({
        intentId: 'intent-duplicate',
        rollout: 'execute',
        status: 'PENDING',
      }),
      ensureAndAttempt: jest.fn(),
    };
    const service = new ModerationService({} as never, {} as never, {} as never, {} as never);
    (service as any).moderationDeleteIntentService = deleteIntents;
    const claim = jest.fn().mockResolvedValue('blocked');
    (service as any).claimDuplicateMessageAction = claim;

    await (service as any).handleDuplicateDecision({
      chatId: 'chat-1',
      userId: 'user-1',
      messageId: 'message-1',
      text: 'same message',
      createdAt: new Date().toISOString(),
      decision: {
        windowSec: 60,
        count: 3,
        threshold: 3,
        action: 'WARN',
        hash: 'duplicate-hash',
        fingerprintType: 'exact',
        nextAction: null,
      },
      userLabel: 'User',
      muteDurationHours: 1,
      botSpeechStyle: null,
      botSpeechMedia: null,
      duplicateBotMessageEnabled: false,
      duplicateBotMessageText: '',
      duplicateBotButtons: [],
      duplicateBotButtonEnabled: false,
      duplicateBotButtonUrl: '',
      duplicateBotButtonText: '',
      duplicateAdminContactButtonEnabled: false,
      duplicateAdminContactButtonUrl: '',
      rulesAttachViolationsEnabled: false,
      rulesPublishedUrl: null,
      rulesPublishedMessageId: null,
      deleteBotMessagesEnabled: false,
      deleteBotMessagesDelayMinutes: 0,
      suppressNonEssentialMessages: true,
    });

    expect(deleteIntents.ensureIntent).toHaveBeenCalledTimes(1);
    expect(claim).toHaveBeenCalledTimes(1);
    expect(deleteIntents.ensureIntent.mock.invocationCallOrder[0]).toBeLessThan(
      claim.mock.invocationCallOrder[0],
    );
    expect(deleteIntents.ensureAndAttempt).not.toHaveBeenCalled();
  });

  it('rechecks photo authorization inside the sanction boundary after deletion', async () => {
    const authorizeSanction = jest.fn().mockResolvedValue(false);
    const deleteIntents = {
      getRolloutForChat: jest.fn().mockReturnValue('execute'),
      getRolloutForRule: jest.fn().mockReturnValue('execute'),
      getRolloutForInput: jest.fn().mockReturnValue('execute'),
      ensureIntent: jest.fn().mockResolvedValue({
        intentId: 'intent-photo-duplicate',
        rollout: 'execute',
        status: 'PENDING',
      }),
      ensureAndAttempt: jest.fn().mockResolvedValue({
        kind: 'confirmed',
        confirmed: true,
        intentId: 'intent-photo-duplicate',
        status: 'SUCCEEDED',
        botId: 'bot-1',
      }),
    };
    const service = new ModerationService(
      { moderationEvent: { findFirst: jest.fn().mockResolvedValue(null) } } as never,
      {} as never,
      {} as never,
      {} as never,
    );
    (service as any).moderationDeleteIntentService = deleteIntents;
    (service as any).buildBotMessageOptions = jest.fn().mockReturnValue(undefined);
    const persistEvent = jest.fn();
    (service as any).createBotModerationEvent = persistEvent;
    const applyUnderLock = jest.spyOn(service as any, 'applySanctionActionUnderLock');

    await (service as any).handleDuplicateDecision({
      chatId: 'chat-1',
      userId: 'user-1',
      messageId: 'message-1',
      text: '',
      createdAt: new Date().toISOString(),
      decision: {
        windowSec: 60,
        count: 2,
        threshold: 2,
        action: 'WARN',
        hash: 'photo-duplicate-hash',
        fingerprintType: 'image',
        nextAction: null,
        metadata: { duplicateSource: 'photo' },
      },
      userLabel: 'User',
      muteDurationHours: 1,
      botSpeechStyle: null,
      botSpeechMedia: null,
      duplicateBotMessageEnabled: true,
      duplicateBotMessageText: '',
      duplicateBotButtons: [],
      duplicateBotButtonEnabled: false,
      duplicateBotButtonUrl: '',
      duplicateBotButtonText: '',
      duplicateAdminContactButtonEnabled: false,
      duplicateAdminContactButtonUrl: '',
      rulesAttachViolationsEnabled: false,
      rulesPublishedUrl: null,
      rulesPublishedMessageId: null,
      deleteBotMessagesEnabled: false,
      deleteBotMessagesDelayMinutes: 0,
      suppressNonEssentialMessages: false,
      backgroundExecution: true,
      actionClaimed: true,
      authorizeSanction,
    });

    expect(authorizeSanction).toHaveBeenCalledTimes(1);
    expect(applyUnderLock).not.toHaveBeenCalled();
    expect(persistEvent).not.toHaveBeenCalled();
  });

  it('rechecks photo authorization after acquiring the mute or ban sanction lock', async () => {
    const events: string[] = [];
    const authorizeSanction = jest.fn(async () => {
      events.push('authorize');
      return false;
    });
    const prepareFence = jest.fn();
    const service = new ModerationService({} as never, {} as never, {} as never, {} as never);
    (service as any).moderationSanctionStateLockServiceInstance = {
      runExclusive: jest.fn(async (_key, operation) => {
        events.push('lock');
        return operation({
          assertOwned: jest.fn(async () => {
            events.push('lease');
          }),
        });
      }),
    };
    (service as any).moderationSanctionStateFenceServiceInstance = { prepare: prepareFence };
    const persistModerationEvent = jest.fn();

    await expect(
      (service as any).applySanctionAction({
        chatId: 'chat-1',
        userId: 'user-1',
        action: SanctionAction.BAN,
        userLabel: 'User',
        messageId: 'message-1',
        muteDurationHours: 1,
        deleteBotMessagesEnabled: false,
        deleteBotMessagesDelayMinutes: 0,
        botSpeechStyle: null,
        persistModerationEvent,
        authorizeSanction,
      }),
    ).resolves.toBe(false);

    expect(events).toEqual(['lock', 'lease', 'authorize']);
    expect(prepareFence).not.toHaveBeenCalled();
    expect(persistModerationEvent).not.toHaveBeenCalled();
  });

  it('serializes concurrent duplicate WARN authorization and persists one terminal event', async () => {
    let terminalEvent: { id: string } | null = null;
    const terminalSnapshots: boolean[] = [];
    const findFirst = jest.fn(async () => {
      terminalSnapshots.push(terminalEvent !== null);
      return terminalEvent;
    });
    const persistModerationEvent = jest.fn(async () => {
      terminalEvent = { id: 'duplicate-warn-event-1' };
      return terminalEvent;
    });
    let lockTail = Promise.resolve();
    const sanctionStateLock = {
      runExclusive: jest.fn(
        async (
          _key: unknown,
          operation: (guard: { assertOwned: () => Promise<void> }) => Promise<boolean>,
        ) => {
          let releaseLock!: () => void;
          const previousLock = lockTail;
          lockTail = new Promise<void>((resolve) => {
            releaseLock = resolve;
          });
          await previousLock;
          try {
            return await operation({ assertOwned: jest.fn().mockResolvedValue(undefined) });
          } finally {
            releaseLock();
          }
        },
      ),
    };
    const service = new ModerationService({} as never, {} as never, {} as never, {} as never);
    const lockSpy = jest
      .spyOn(service as any, 'moderationSanctionStateLockService', 'get')
      .mockReturnValue(sanctionStateLock);
    const executeWarn = () => {
      const authorization = createDuplicateSanctionAuthorization({
        model: { findFirst },
        chatId: 'chat-1',
        userId: 'user-1',
        messageId: 'message-1',
      });
      return (service as any).applySanctionAction({
        chatId: 'chat-1',
        userId: 'user-1',
        action: SanctionAction.WARN,
        userLabel: 'User',
        messageId: 'message-1',
        muteDurationHours: 1,
        deleteBotMessagesEnabled: false,
        deleteBotMessagesDelayMinutes: 0,
        botSpeechStyle: null,
        persistModerationEvent,
        authorizeSanction: authorization.authorize,
      });
    };

    await expect(Promise.all([executeWarn(), executeWarn()])).resolves.toEqual([true, false]);

    expect(sanctionStateLock.runExclusive).toHaveBeenCalledTimes(2);
    expect(findFirst).toHaveBeenCalledTimes(2);
    expect(terminalSnapshots).toEqual([false, true]);
    expect(persistModerationEvent).toHaveBeenCalledTimes(1);
    lockSpy.mockRestore();
  });

  it('checks the full duplicate guard immediately before WARN persistence', async () => {
    const service = new ModerationService({} as never, {} as never, {} as never, {} as never);
    const persistModerationEvent = jest.fn();
    const beforeSanctionMutation = jest.fn().mockRejectedValue(new Error('full duplicate revoked'));
    const lockSpy = jest
      .spyOn(service as any, 'moderationSanctionStateLockService', 'get')
      .mockReturnValue({
        runExclusive: async (_key: unknown, operation: (guard: unknown) => Promise<boolean>) =>
          operation({ assertOwned: async () => undefined }),
      });
    try {
      await expect(
        (service as any).applySanctionAction({
          chatId: 'chat-1',
          userId: 'user-1',
          messageId: 'm',
          action: SanctionAction.WARN,
          userLabel: 'User',
          muteDurationHours: 1,
          deleteBotMessagesEnabled: false,
          deleteBotMessagesDelayMinutes: 0,
          botSpeechStyle: null,
          persistModerationEvent,
          authorizeSanction: async () => true,
          beforeSanctionMutation,
        }),
      ).rejects.toThrow('full duplicate revoked');
      expect(beforeSanctionMutation).toHaveBeenCalledTimes(1);
      expect(persistModerationEvent).not.toHaveBeenCalled();
    } finally {
      lockSpy.mockRestore();
    }
  });

  it('does not persist MUTE after the full duplicate guard is revoked', async () => {
    const service = new ModerationService({} as never, {} as never, {} as never, {} as never);
    const persistModerationEvent = jest.fn();
    await expect(
      (service as any).applySanctionActionUnderLock(
        {
          chatId: 'chat-1',
          userId: 'user-1',
          messageId: 'm',
          action: SanctionAction.MUTE,
          userLabel: 'User',
          muteDurationHours: 1,
          deleteBotMessagesEnabled: false,
          deleteBotMessagesDelayMinutes: 0,
          botSpeechStyle: null,
          persistModerationEvent,
          beforeSanctionMutation: async () => {
            throw new Error('full duplicate revoked');
          },
        },
        { assertOwned: async () => undefined },
      ),
    ).rejects.toThrow('full duplicate revoked');
    expect(persistModerationEvent).not.toHaveBeenCalled();
  });

  it('keeps the full BAN callback in the final MAX member mutation, alongside the ownership lease', async () => {
    const events: string[] = [];
    const max = {
      banMember: jest.fn(
        async (
          _chat: string,
          _user: string,
          options: { beforeImmediateMemberMutation: () => Promise<void> },
        ) => {
          await options.beforeImmediateMemberMutation();
          events.push('ban');
        },
      ),
    };
    const service = new ModerationService({} as never, {} as never, {} as never, max as never);
    const route = jest
      .spyOn(service as any, 'executeModerationActionWithFallbackResult')
      .mockImplementation(async (params: any) => {
        await params.operation('bot');
        return { ok: true, botId: 'bot' };
      });
    try {
      await expect(
        (service as any).banMemberImmediatelyWithResult(
          'chat',
          'user',
          {
            beforeImmediateMemberMutation: async () => {
              events.push('guard');
              throw new Error('revoked');
            },
          },
          {
            assertOwned: async () => {
              events.push('lease');
            },
          },
        ),
      ).rejects.toThrow('revoked');
      expect(events).toEqual(['lease', 'lease', 'guard']);
      expect(events).not.toContain('ban');
    } finally {
      route.mockRestore();
    }
  });

  it('does not treat an unapplied duplicate decision with action NONE as a terminal sanction', async () => {
    const findFirst = jest.fn().mockResolvedValue(null);

    await expect(
      hasPersistedTerminalDuplicateSanction({
        model: { findFirst },
        chatId: 'chat-1',
        userId: 'user-1',
        messageId: 'message-1',
      }),
    ).resolves.toBe(false);

    expect(findFirst).toHaveBeenCalledWith({
      where: {
        chatId: 'chat-1',
        userId: 'user-1',
        messageId: 'message-1',
        ruleCode: { in: ['DUPLICATE_WARN', 'DUPLICATE_MUTE', 'DUPLICATE_BAN'] },
        operator: 'BOT',
        action: { in: ['WARN', 'MUTE', 'BAN'] },
      },
      select: { id: true },
    });
  });

  it('stops an observed duplicate delete when photo authorization is revoked pre-dispatch', async () => {
    const authorizeDelete = jest.fn().mockResolvedValue(false);
    const authorizeSanction = jest.fn().mockResolvedValue(true);
    const remoteDeleteMutation = jest.fn();
    const maxClient = {
      deleteMessage: jest.fn(
        async (
          _chatId: string,
          _messageId: string,
          options?: { beforeImmediateDeleteMutation?: () => Promise<void> },
        ) => {
          await options?.beforeImmediateDeleteMutation?.();
          remoteDeleteMutation();
        },
      ),
      sendMessage: jest.fn(),
    };
    const deleteIntents = {
      getRolloutForChat: jest.fn().mockReturnValue('observed'),
      getRolloutForRule: jest.fn().mockReturnValue('observed'),
      getRolloutForInput: jest.fn().mockReturnValue('observed'),
      ensureIntent: jest.fn().mockResolvedValue({
        intentId: 'intent-photo-observed',
        rollout: 'observed',
        status: 'PENDING',
      }),
      ensureAndAttempt: jest.fn().mockResolvedValue({
        kind: 'observed',
        confirmed: false,
        intentId: 'intent-photo-observed',
        status: 'PENDING',
      }),
    };
    const service = new ModerationService(
      { moderationEvent: { findFirst: jest.fn() } } as never,
      {} as never,
      {} as never,
      maxClient as never,
    );
    (service as any).moderationDeleteIntentService = deleteIntents;
    const persistEvent = jest.fn();
    (service as any).createBotModerationEvent = persistEvent;

    await (service as any).handleDuplicateDecision({
      chatId: 'chat-1',
      userId: 'user-1',
      messageId: 'message-1',
      text: '',
      createdAt: new Date().toISOString(),
      decision: {
        windowSec: 60,
        count: 2,
        threshold: 2,
        action: 'WARN',
        hash: 'photo-duplicate-hash',
        fingerprintType: 'image',
        nextAction: null,
        metadata: { duplicateSource: 'photo' },
      },
      userLabel: 'User',
      muteDurationHours: 1,
      botSpeechStyle: null,
      botSpeechMedia: null,
      duplicateBotMessageEnabled: true,
      duplicateBotMessageText: '',
      duplicateBotButtons: [],
      duplicateBotButtonEnabled: false,
      duplicateBotButtonUrl: '',
      duplicateBotButtonText: '',
      duplicateAdminContactButtonEnabled: false,
      duplicateAdminContactButtonUrl: '',
      rulesAttachViolationsEnabled: false,
      rulesPublishedUrl: null,
      rulesPublishedMessageId: null,
      deleteBotMessagesEnabled: false,
      deleteBotMessagesDelayMinutes: 0,
      suppressNonEssentialMessages: false,
      backgroundExecution: true,
      actionClaimed: true,
      authorizeDelete,
      authorizeSanction,
    });

    expect(deleteIntents.ensureAndAttempt).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: 'message-1' }),
      { beforeDeleteMutation: expect.any(Function) },
    );
    expect(authorizeDelete).toHaveBeenCalledTimes(1);
    expect(maxClient.deleteMessage).toHaveBeenCalledTimes(1);
    expect(remoteDeleteMutation).not.toHaveBeenCalled();
    expect(authorizeSanction).not.toHaveBeenCalled();
    expect(persistEvent).not.toHaveBeenCalled();
    expect(maxClient.sendMessage).not.toHaveBeenCalled();
  });

  it.each(['handleDuplicateDecision', 'handleDuplicateHit'])(
    'stops %s after a committed initial source deferral without sanction, notice or DELETE proof',
    async (method) => {
      const service = new ModerationService({} as never, {} as never, {} as never, {} as never);
      const internals = service as any;
      internals.moderationDeleteIntentService = {
        ensureIntent: jest.fn(),
        getRolloutForInput: () => 'execute',
        ensureAndAttempt: jest.fn().mockResolvedValue({
          kind: 'inline_declined',
          confirmed: false,
          intentId: 'intent',
          status: 'RETRYABLE',
        }),
      };
      internals.applySanctionAction = jest.fn();
      internals.createBotModerationEvent = jest.fn();
      internals.sendBotMessageWithOptionalAutoDelete = jest.fn();
      const hit = { count: 1, windowSec: 60, hash: 'hash', fingerprintType: 'exact' };
      await expect(
        internals[method]({
          chatId: 'chat-1',
          userId: 'user-1',
          messageId: 'message-1',
          text: 'repeat',
          createdAt: new Date().toISOString(),
          userLabel: 'User',
          hit,
          decision: { ...hit, action: 'WARN', threshold: 1, nextAction: null },
          actionClaimed: true,
          authorizeDelete: jest.fn(),
          duplicateBotMessageEnabled: true,
        }),
      ).resolves.toBeUndefined();
      expect(internals.applySanctionAction).not.toHaveBeenCalled();
      expect(internals.createBotModerationEvent).not.toHaveBeenCalled();
      expect(internals.sendBotMessageWithOptionalAutoDelete).not.toHaveBeenCalled();
    },
  );

  it.each(['handleDuplicateDecision', 'handleDuplicateHit'])(
    'retries %s after a transient delete verification failure without sanctions or notices',
    async (method) => {
      const service = new ModerationService({} as never, {} as never, {} as never, {} as never);
      const failure = new Error('temporary duplicate verification failure');
      const authorizeDelete = jest.fn().mockRejectedValueOnce(failure).mockResolvedValue(true);
      const internals = service as any;
      internals.ensureModerationDeleteIntent = jest.fn();
      internals.executeModerationDelete = jest.fn(async (_input, options) => {
        await options.beforeImmediateDeleteMutation();
        return { gone: true, deleted: true, eventPersistedByIntent: true };
      });
      internals.applySanctionAction = jest.fn().mockResolvedValue(true);
      internals.sendBotMessageWithOptionalAutoDelete = jest.fn();
      const hit = { count: 1, windowSec: 60, hash: 'hash', fingerprintType: 'exact' };
      const params = {
        chatId: 'chat-1',
        userId: 'user-1',
        messageId: 'message-1',
        text: 'repeat',
        createdAt: new Date().toISOString(),
        userLabel: 'User',
        hit,
        decision: { ...hit, action: 'WARN', threshold: 1, nextAction: null },
        actionClaimed: true,
        authorizeDelete,
        suppressNonEssentialMessages: true,
        duplicateBotMessageEnabled: false,
      };
      await expect(internals[method](params)).rejects.toBe(failure);
      expect(internals.applySanctionAction).not.toHaveBeenCalled();
      expect(internals.sendBotMessageWithOptionalAutoDelete).not.toHaveBeenCalled();
      await expect(internals[method](params)).resolves.toBeUndefined();
      expect(authorizeDelete).toHaveBeenCalledTimes(2);
      expect(internals.applySanctionAction).toHaveBeenCalledTimes(
        method === 'handleDuplicateDecision' ? 1 : 0,
      );
    },
  );

  it('stops duplicate action recovery when its ordering lease is lost after intent persistence', async () => {
    const leaseLost = new Error('photo ordering lease lost');
    const deleteIntents = {
      getRolloutForChat: jest.fn().mockReturnValue('execute'),
      getRolloutForRule: jest.fn().mockReturnValue('execute'),
      getRolloutForInput: jest.fn().mockReturnValue('execute'),
      ensureIntent: jest.fn().mockResolvedValue({
        intentId: 'intent-duplicate',
        rollout: 'execute',
        status: 'PENDING',
      }),
    };
    const service = new ModerationService({} as never, {} as never, {} as never, {} as never);
    (service as any).moderationDeleteIntentService = deleteIntents;
    const claim = jest.fn().mockResolvedValue(true);
    (service as any).claimMessageScopedModerationAction = claim;
    const assertActiveLease = jest
      .fn()
      .mockImplementationOnce(() => undefined)
      .mockImplementation(() => {
        throw leaseLost;
      });

    await expect(
      (service as any).handleDuplicateHit({
        chatId: 'chat-1',
        userId: 'user-1',
        messageId: 'message-1',
        text: '',
        createdAt: new Date().toISOString(),
        hit: {
          windowSec: 60,
          count: 1,
          hash: 'duplicate-hash',
          fingerprintType: 'image',
          metadata: { duplicateSource: 'photo' },
        },
        userLabel: 'User',
        botSpeechStyle: null,
        botSpeechMedia: null,
        duplicateBotMessageEnabled: false,
        duplicateBotMessageText: '',
        duplicateBotButtons: [],
        duplicateBotButtonEnabled: false,
        duplicateBotButtonUrl: '',
        duplicateBotButtonText: '',
        duplicateAdminContactButtonEnabled: false,
        duplicateAdminContactButtonUrl: '',
        rulesAttachViolationsEnabled: false,
        rulesPublishedUrl: null,
        rulesPublishedMessageId: null,
        deleteBotMessagesEnabled: false,
        deleteBotMessagesDelayMinutes: 0,
        suppressNonEssentialMessages: true,
        backgroundExecution: true,
        assertActiveLease,
      }),
    ).rejects.toBe(leaseLost);

    expect(deleteIntents.ensureIntent).toHaveBeenCalledTimes(1);
    expect(claim).not.toHaveBeenCalled();
  });

  it('passes the ordering lease guard through the durable delete boundary', async () => {
    const leaseLost = new Error('photo ordering lease lost before DELETE');
    let insideDeleteGuard = false;
    let lost = false;
    const assertActiveLease = jest.fn(() => {
      if (insideDeleteGuard || lost) {
        lost = true;
        throw leaseLost;
      }
    });
    const deleteIntents = {
      getRolloutForChat: jest.fn().mockReturnValue('execute'),
      getRolloutForRule: jest.fn().mockReturnValue('execute'),
      getRolloutForInput: jest.fn().mockReturnValue('execute'),
      ensureIntent: jest.fn().mockResolvedValue({
        intentId: 'intent-duplicate',
        rollout: 'execute',
        status: 'PENDING',
      }),
      ensureAndAttempt: jest.fn(
        async (_input: unknown, options?: { beforeDeleteMutation?: () => Promise<void> }) => {
          insideDeleteGuard = true;
          await options?.beforeDeleteMutation?.();
          return {
            kind: 'confirmed',
            confirmed: true,
            intentId: 'intent-duplicate',
            status: 'SUCCEEDED',
            botId: 'bot-1',
          };
        },
      ),
    };
    const maxClient = { sendMessage: jest.fn() };
    const service = new ModerationService(
      {} as never,
      {} as never,
      {} as never,
      maxClient as never,
    );
    (service as any).moderationDeleteIntentService = deleteIntents;
    (service as any).claimMessageScopedModerationAction = jest.fn();

    await expect(
      (service as any).handleDuplicateHit({
        chatId: 'chat-1',
        userId: 'user-1',
        messageId: 'message-1',
        text: '',
        createdAt: new Date().toISOString(),
        hit: {
          windowSec: 60,
          count: 1,
          hash: 'duplicate-hash',
          fingerprintType: 'image',
          metadata: { duplicateSource: 'photo' },
        },
        userLabel: 'User',
        botSpeechStyle: null,
        botSpeechMedia: null,
        duplicateBotMessageEnabled: true,
        duplicateBotMessageText: '',
        duplicateBotButtons: [],
        duplicateBotButtonEnabled: false,
        duplicateBotButtonUrl: '',
        duplicateBotButtonText: '',
        duplicateAdminContactButtonEnabled: false,
        duplicateAdminContactButtonUrl: '',
        rulesAttachViolationsEnabled: false,
        rulesPublishedUrl: null,
        rulesPublishedMessageId: null,
        deleteBotMessagesEnabled: false,
        deleteBotMessagesDelayMinutes: 0,
        suppressNonEssentialMessages: false,
        backgroundExecution: true,
        actionClaimed: true,
        assertActiveLease,
      }),
    ).rejects.toBe(leaseLost);

    expect(deleteIntents.ensureAndAttempt).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: 'message-1' }),
      { beforeDeleteMutation: expect.any(Function) },
    );
    expect(maxClient.sendMessage).not.toHaveBeenCalled();
  });

  it('scopes photo duplicate explanation idempotency to the chat and message', () => {
    const metadata = { duplicateSource: 'photo' };

    expect(duplicateExplanationIdempotencyKey(metadata, 'chat-1', 'message-1')).toBe(
      'photo-duplicate:chat-1:message-1:explanation',
    );
    expect(duplicateExplanationIdempotencyKey(metadata, 'chat-2', 'message-1')).toBe(
      'photo-duplicate:chat-2:message-1:explanation',
    );
  });

  it('does not turn a photo duplicate ban into global spammer evidence', async () => {
    const service = new ModerationService({} as never, {} as never, {} as never, {} as never);
    const handleDuplicateDecision = jest
      .spyOn(service as any, 'handleDuplicateDecision')
      .mockResolvedValue(undefined);
    const assertOwned = jest.fn();

    await service.executePhotoDuplicateAction({
      update: {
        updateId: 'update-photo-ban-1',
        type: 'message_created',
        eventTimestampSource: 'payload',
        message: {
          chatId: 'chat-1',
          messageId: 'message-1',
          senderId: 'user-1',
          senderName: 'User',
          text: '',
          createdAt: '2026-08-11T12:00:00.000Z',
        },
        raw: {},
      },
      chatId: 'chat-1',
      userId: 'user-1',
      messageId: 'message-1',
      settings: createSettings() as never,
      rulesPublishedUrl: null,
      rulesPublishedMessageId: null,
      actionClaimed: true,
      lease: { assertOwned } as never,
      authorizeDelete: jest.fn().mockResolvedValue(true),
      authorizeSanction: jest.fn().mockResolvedValue(true),
      outcome: {
        kind: 'decision',
        decision: {
          action: 'BAN',
          count: 3,
          threshold: 3,
          windowSec: 3_600,
          hash: 'photo-hash',
          fingerprintType: 'image',
          nextAction: null,
          metadata: { duplicateSource: 'photo' },
        },
      },
    });

    expect(handleDuplicateDecision).toHaveBeenCalledWith(
      expect.objectContaining({
        decision: expect.objectContaining({ action: 'BAN' }),
        trackAsGlobalSpammer: false,
      }),
    );
  });

  it('checks the photo lease after notice preparation and before durable send handoff', async () => {
    const leaseLost = new Error('photo ordering lease lost before notice handoff');
    const events: string[] = [];
    const maxClient = {
      sendMessage: jest.fn(async () => {
        events.push('send-handoff');
      }),
    };
    const service = new ModerationService(
      {} as never,
      {} as never,
      {} as never,
      maxClient as never,
    );
    (service as any).shouldSendBotNotice = jest.fn(async () => {
      events.push('notice-bucket');
      return true;
    });
    (service as any).withBotSpeechMediaOptions = jest.fn(async () => {
      events.push('media-preparation');
      return undefined;
    });
    const beforeSend = jest.fn(async () => {
      events.push('lease-guard');
      throw leaseLost;
    });

    await expect(
      (service as any).sendBotMessageWithOptionalAutoDelete({
        chatId: 'chat-1',
        text: 'Повтор фотографии удалён',
        messageOptions: undefined,
        media: null,
        deleteBotMessagesEnabled: false,
        deleteBotMessagesDelayMinutes: 0,
        idempotencyKey: 'photo-duplicate:chat-1:message-1:explanation',
        beforeSend,
      }),
    ).rejects.toBe(leaseLost);

    expect(events).toEqual(['notice-bucket', 'media-preparation', 'lease-guard']);
    expect(maxClient.sendMessage).not.toHaveBeenCalled();
  });

  it('does not record delayed bot auto-delete before the durable intent succeeds', async () => {
    const sourceMessageAt = '2026-08-15T09:30:00.000Z';
    const prisma = { moderationEvent: { create: jest.fn() } };
    const maxClient = { deleteMessage: jest.fn() };
    const deleteIntents = {
      getRolloutForChat: jest.fn().mockReturnValue('execute'),
      getRolloutForRule: jest.fn().mockReturnValue('execute'),
      getRolloutForInput: jest.fn().mockReturnValue('execute'),
      ensureIntent: jest.fn().mockResolvedValue({
        intentId: 'intent-delayed',
        rollout: 'execute',
        status: 'PENDING',
      }),
      ensureAndAttempt: jest.fn().mockResolvedValue({
        kind: 'pending',
        confirmed: false,
        intentId: 'intent-delayed',
        status: 'PENDING',
      }),
    };
    const service = new ModerationService(
      prisma as never,
      {} as never,
      {} as never,
      maxClient as never,
    );
    (service as any).moderationDeleteIntentService = deleteIntents;
    (service as any).maxBotLinkService = {
      resolveBotIdFromUserId: jest.fn().mockReturnValue('registry-bot-1'),
    };
    (service as any).claimMessageScopedModerationAction = jest.fn().mockResolvedValue(true);

    await (service as any).handleBotMessageAutoDelete({
      chatId: 'chat-1',
      userId: 'bot-1',
      messageId: 'message-bot-1',
      text: 'temporary notice',
      createdAt: sourceMessageAt,
      delayMinutes: 2,
    });

    expect(deleteIntents.ensureIntent).toHaveBeenCalledWith(
      expect.objectContaining({
        executeAt: expect.any(Date),
        sourceMessageAt,
        messageAuthorKind: 'bot',
        originBotId: 'registry-bot-1',
      }),
    );
    expect(deleteIntents.ensureAndAttempt).toHaveBeenCalledTimes(1);
    expect(maxClient.deleteMessage).not.toHaveBeenCalled();
    expect(prisma.moderationEvent.create).not.toHaveBeenCalled();
  });

  it.each([
    { mode: 'canary' as const, canaryChatIds: new Set(['chat-1']) },
    { mode: 'on' as const, canaryChatIds: new Set<string>() },
  ])(
    'does not schedule a second own-bot delete from the webhook in $mode execute rollout',
    async ({ mode, canaryChatIds }) => {
      const deleteIntents = {
        getRolloutForChat: jest.fn((chatId: string) =>
          resolveModerationDeleteIntentRollout({ mode, canaryChatIds, chatId }),
        ),
        getRolloutForRule: jest.fn((chatId: string) =>
          resolveModerationDeleteIntentRollout({ mode, canaryChatIds, chatId }),
        ),
        getRolloutForInput: jest.fn((input: { chatId: string }) =>
          resolveModerationDeleteIntentRollout({ mode, canaryChatIds, chatId: input.chatId }),
        ),
        ensureIntent: jest.fn(),
        ensureAndAttempt: jest.fn(),
      };
      const actionLedger = {
        hasSucceededDelete: jest.fn().mockResolvedValue(true),
      };
      const service = new ModerationService({} as never, {} as never, {} as never, {} as never);
      (service as any).moderationDeleteIntentService = deleteIntents;
      (service as any).maxActionLedgerService = actionLedger;
      (service as any).resolveOwnBotAutoDeleteSkipReason = jest.fn().mockResolvedValue(null);
      const scheduleWebhookDelete = jest.fn();
      (service as any).handleBotMessageAutoDelete = scheduleWebhookDelete;

      await (service as any).handleOwnBotMessageAutoDelete({
        chatId: 'chat-1',
        userId: 'runtime-bot-user-1',
        messageId: 'sent-message-1',
        text: 'temporary runtime notice',
        createdAt: '2026-08-15T09:31:00.000Z',
        settings: createSettings({
          deleteBotMessagesEnabled: true,
          deleteBotMessagesDelayMinutes: 2,
        }),
      });

      expect(actionLedger.hasSucceededDelete).toHaveBeenCalledWith('chat-1', 'sent-message-1');
      expect(scheduleWebhookDelete).not.toHaveBeenCalled();
      expect(deleteIntents.ensureIntent).not.toHaveBeenCalled();
      expect(deleteIntents.ensureAndAttempt).not.toHaveBeenCalled();
    },
  );

  it('keeps the legacy webhook owner in shadow rollout', async () => {
    const deleteIntents = {
      getRolloutForChat: jest.fn().mockReturnValue('observed'),
      getRolloutForRule: jest.fn().mockReturnValue('observed'),
      getRolloutForInput: jest.fn().mockReturnValue('observed'),
    };
    const actionLedger = {
      hasSucceededDelete: jest.fn().mockResolvedValue(true),
    };
    const service = new ModerationService({} as never, {} as never, {} as never, {} as never);
    (service as any).moderationDeleteIntentService = deleteIntents;
    (service as any).maxActionLedgerService = actionLedger;
    (service as any).resolveOwnBotAutoDeleteSkipReason = jest.fn().mockResolvedValue(null);
    const scheduleWebhookDelete = jest.fn();
    (service as any).handleBotMessageAutoDelete = scheduleWebhookDelete;
    const sourceMessageAt = '2026-08-15T09:32:00.000Z';

    await (service as any).handleOwnBotMessageAutoDelete({
      chatId: 'chat-1',
      userId: 'runtime-bot-user-1',
      messageId: 'sent-message-1',
      text: 'temporary runtime notice',
      createdAt: sourceMessageAt,
      settings: createSettings({
        deleteBotMessagesEnabled: true,
        deleteBotMessagesDelayMinutes: 2,
      }),
    });

    expect(actionLedger.hasSucceededDelete).not.toHaveBeenCalled();
    expect(scheduleWebhookDelete).toHaveBeenCalledWith({
      chatId: 'chat-1',
      userId: 'runtime-bot-user-1',
      messageId: 'sent-message-1',
      text: 'temporary runtime notice',
      createdAt: sourceMessageAt,
      delayMinutes: 2,
    });
  });

  it('keeps durable own-bot cleanup when no succeeded legacy delete confirms cleanup', async () => {
    const service = new ModerationService({} as never, {} as never, {} as never, {} as never);
    (service as any).moderationDeleteIntentService = {
      getRolloutForChat: jest.fn().mockReturnValue('execute'),
      getRolloutForRule: jest.fn().mockReturnValue('execute'),
      getRolloutForInput: jest.fn().mockReturnValue('execute'),
    };
    (service as any).maxActionLedgerService = {
      hasSucceededDelete: jest.fn().mockResolvedValue(false),
    };
    (service as any).resolveOwnBotAutoDeleteSkipReason = jest.fn().mockResolvedValue(null);
    const scheduleWebhookDelete = jest.fn();
    (service as any).handleBotMessageAutoDelete = scheduleWebhookDelete;

    await (service as any).handleOwnBotMessageAutoDelete({
      chatId: 'chat-1',
      userId: 'runtime-bot-user-1',
      messageId: 'unowned-message-1',
      text: 'message without a completed send ledger',
      createdAt: '2026-08-15T09:33:00.000Z',
      settings: createSettings({
        deleteBotMessagesEnabled: true,
        deleteBotMessagesDelayMinutes: 2,
      }),
    });

    expect(scheduleWebhookDelete).toHaveBeenCalledTimes(1);
  });

  it('routes delayed own-bot auto-delete through a delete-capable fallback bot', async () => {
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings({
            removeBotsFromGroupEnabled: false,
            deleteBotMessagesEnabled: true,
            deleteBotMessagesDelayMinutes: 2,
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
      globalSpammer: {
        upsert: jest.fn(),
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
        data: { code: 'chat.denied', message: 'bot cannot delete messages' },
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
      sendMessage: jest.fn(),
      kickMember: jest.fn(),
      banMember: jest.fn(),
      notifyModerators: jest.fn(),
    };
    const maxBotLinkService = {
      resolveBotIdFromUserId: jest.fn().mockReturnValue('bot-2'),
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

    const service = new ModerationService(
      prisma as never,
      ruleEngine as never,
      sanctionService as never,
      maxClient as never,
      undefined,
      undefined,
      {
        get: jest.fn().mockReturnValue('bot-1'),
      } as never,
      undefined,
      undefined,
      undefined,
      undefined,
      maxBotLinkService as never,
    );

    await service.handleUpdate(createBotAuthoredUpdate());

    expect(maxClient.deleteMessage).toHaveBeenCalledWith(
      'chat-1',
      'msg-bot-1',
      expect.objectContaining({
        delayMs: 2 * 60 * 1000,
        botId: 'bot-2',
        trafficClass: 'critical',
        actionHealthLane: 'critical',
        sourceTag: 'moderation_delete',
      }),
    );
    expect(maxClient.deleteMessage).toHaveBeenCalledWith(
      'chat-1',
      'msg-bot-1',
      expect.objectContaining({
        delayMs: 2 * 60 * 1000,
        botId: 'bot-6',
        trafficClass: 'critical',
        actionHealthLane: 'critical',
        sourceTag: 'moderation_delete',
      }),
    );
    expect(prisma.moderationEvent.create).not.toHaveBeenCalled();
  });

  it('does not auto-delete messages from another configured bot', async () => {
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings({
            removeBotsFromGroupEnabled: false,
            deleteBotMessagesEnabled: true,
            deleteBotMessagesDelayMinutes: 2,
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
      globalSpammer: {
        upsert: jest.fn(),
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
    };
    const maxBotLinkService = {
      isKnownBotUserId: jest.fn((userId: string) => userId === 'bot-1'),
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
      maxBotLinkService as never,
    );

    await service.handleUpdate({
      ...createBotAuthoredUpdate(),
      botId: 'bot-active',
    });

    expect(maxBotLinkService.isKnownBotUserId).toHaveBeenCalledWith('bot-1');
    expect(maxClient.getChatMembersAccess).not.toHaveBeenCalled();
    expect(ruleEngine.detect).not.toHaveBeenCalled();
    expect(prisma.violation.create).not.toHaveBeenCalled();
    expect(maxClient.deleteMessage).not.toHaveBeenCalled();
    expect(maxClient.sendMessage).not.toHaveBeenCalled();
    expect(maxClient.kickMember).not.toHaveBeenCalled();
    expect(maxClient.banMember).not.toHaveBeenCalled();
    expect(prisma.moderationEvent.create).not.toHaveBeenCalled();
  });

  it('schedules auto-delete when MAX_BOT_ID is in id..._bot format', async () => {
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings({
            removeBotsFromGroupEnabled: false,
            deleteBotMessagesEnabled: true,
            deleteBotMessagesDelayMinutes: 2,
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
      globalSpammer: {
        upsert: jest.fn(),
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
    };

    const service = new ModerationService(
      prisma as never,
      ruleEngine as never,
      sanctionService as never,
      maxClient as never,
      undefined,
      undefined,
      {
        get: jest.fn().mockReturnValue('idbot-1_bot'),
      } as never,
    );

    await service.handleUpdate(createBotAuthoredUpdate());

    expect(maxClient.deleteMessage).toHaveBeenCalledWith(
      'chat-1',
      'msg-bot-1',
      expect.objectContaining({
        delayMs: 2 * 60 * 1000,
        trafficClass: 'critical',
        actionHealthLane: 'critical',
        sourceTag: 'moderation_delete',
        timeoutMs: MODERATION_ACTION_DISPATCH_TIMEOUT_MS,
      }),
    );
    expect(maxClient.kickMember).not.toHaveBeenCalled();
    expect(maxClient.banMember).not.toHaveBeenCalled();
  });

  it('schedules auto-delete for own bot message without explicit bot flags in payload', async () => {
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings({
            removeBotsFromGroupEnabled: false,
            deleteBotMessagesEnabled: true,
            deleteBotMessagesDelayMinutes: 2,
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
      globalSpammer: {
        upsert: jest.fn(),
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
    };

    const service = new ModerationService(
      prisma as never,
      ruleEngine as never,
      sanctionService as never,
      maxClient as never,
      undefined,
      undefined,
      {
        get: jest.fn().mockReturnValue('id613002203036_bot'),
      } as never,
    );

    await service.handleUpdate(createOwnBotUpdateWithoutBotFlags());

    expect(maxClient.deleteMessage).toHaveBeenCalledWith(
      'chat-1',
      'msg-own-bot-no-flags-1',
      expect.objectContaining({
        delayMs: 2 * 60 * 1000,
        trafficClass: 'critical',
        actionHealthLane: 'critical',
        sourceTag: 'moderation_delete',
        timeoutMs: MODERATION_ACTION_DISPATCH_TIMEOUT_MS,
      }),
    );
    expect(maxClient.kickMember).not.toHaveBeenCalled();
    expect(maxClient.banMember).not.toHaveBeenCalled();
  });

  it('supports 30-second auto-delete for own bot messages', async () => {
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings({
            removeBotsFromGroupEnabled: false,
            deleteBotMessagesEnabled: true,
            deleteBotMessagesDelayMinutes: 0.5,
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
      globalSpammer: {
        upsert: jest.fn(),
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
    };

    const service = new ModerationService(
      prisma as never,
      ruleEngine as never,
      sanctionService as never,
      maxClient as never,
      undefined,
      undefined,
      {
        get: jest.fn().mockReturnValue('id613002203036_bot'),
      } as never,
    );

    await service.handleUpdate(createOwnBotUpdateWithoutBotFlags());

    expect(maxClient.deleteMessage).toHaveBeenCalledWith(
      'chat-1',
      'msg-own-bot-no-flags-1',
      expect.objectContaining({
        delayMs: 30_000,
        trafficClass: 'critical',
        actionHealthLane: 'critical',
        sourceTag: 'moderation_delete',
        timeoutMs: MODERATION_ACTION_DISPATCH_TIMEOUT_MS,
      }),
    );
  });

  it('does not auto-delete the published chat rules message from own bot', async () => {
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings({
            deleteBotMessagesEnabled: true,
            deleteBotMessagesDelayMinutes: 0.5,
          }),
          domains: [],
          admins: [],
        }),
      },
      chatRules: {
        findUnique: jest.fn().mockResolvedValue({
          publishedMessageId: 'mid-published-rules-1',
          publishSendStartedAt: null,
        }),
      },
      violation: {
        create: jest.fn(),
      },
      moderationEvent: {
        findFirst: jest.fn(),
        create: jest.fn(),
      },
      webhookEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
      globalSpammer: {
        upsert: jest.fn(),
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
      { detect: jest.fn() } as never,
      { resolveAction: jest.fn() } as never,
      maxClient as never,
      undefined,
      undefined,
      {
        get: jest.fn().mockReturnValue('id613002203036_bot'),
      } as never,
    );

    await service.handleUpdate(
      createOwnBotUpdateWithoutBotFlags('Правила чата', 'mid-published-rules-1'),
    );

    expect(prisma.chatRules.findUnique).toHaveBeenCalledWith({
      where: {
        chatId: 'chat-1',
      },
      select: {
        publishedMessageId: true,
        publishSendStartedAt: true,
      },
    });
    expect(maxClient.deleteMessage).not.toHaveBeenCalled();
    expect(prisma.moderationEvent.findFirst).not.toHaveBeenCalled();
    expect(prisma.moderationEvent.create).not.toHaveBeenCalled();
  });

  it('defers an unrelated own-bot message while chat rules publish is in flight', async () => {
    const prisma = {
      chatRules: {
        findUnique: jest.fn().mockResolvedValue({
          publishedMessageId: 'mid-previous-rules-1',
          publishSendStartedAt: new Date(),
        }),
      },
    };
    const maxClient = {
      deleteMessage: jest.fn(),
    };
    const service = new ModerationService(
      prisma as never,
      {} as never,
      {} as never,
      maxClient as never,
    );

    await expect(
      (service as any).handleOwnBotMessageAutoDelete({
        chatId: 'chat-1',
        userId: 'id613002203036_bot',
        messageId: 'mid-new-rules-1',
        text: 'Правила чата',
        createdAt: '2026-08-15T09:34:00.000Z',
        settings: createSettings({
          deleteBotMessagesEnabled: true,
          deleteBotMessagesDelayMinutes: 0.5,
        }),
      }),
    ).rejects.toMatchObject({
      name: 'ChatRulesPublishFenceRetryError',
      chatRulesPublishFenceRetryable: true,
      retryAfterMs: expect.any(Number),
    });

    expect(maxClient.deleteMessage).not.toHaveBeenCalled();
  });

  it('does not auto-delete tracked greeting message from own bot', async () => {
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings({
            deleteBotMessagesEnabled: true,
            deleteBotMessagesDelayMinutes: 2,
          }),
          domains: [],
          admins: [],
        }),
      },
      violation: {
        create: jest.fn(),
      },
      moderationEvent: {
        findFirst: jest
          .fn()
          .mockResolvedValue({ id: 'greeting-event-1', ruleCode: 'GREETING_MESSAGE' }),
        create: jest.fn(),
      },
      managedBroadcastDelivery: {
        findFirst: jest.fn(),
      },
      webhookEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
      globalSpammer: {
        upsert: jest.fn(),
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
    };

    const service = new ModerationService(
      prisma as never,
      ruleEngine as never,
      sanctionService as never,
      maxClient as never,
      undefined,
      undefined,
      {
        get: jest.fn().mockReturnValue('id613002203036_bot'),
      } as never,
    );

    await service.handleUpdate(createOwnBotUpdateWithoutBotFlags('welcome', 'msg-greeting-own-1'));

    expect(prisma.moderationEvent.findFirst).toHaveBeenCalledWith({
      where: {
        chatId: 'chat-1',
        OR: [
          {
            messageId: 'msg-greeting-own-1',
            ruleCode: {
              in: ['NIGHT_MODE_CLOSE_NOTICE', 'NIGHT_MODE_OPEN_NOTICE'],
            },
          },
          {
            ruleCode: 'GREETING_MESSAGE',
            metadata: {
              path: ['sentMessageId'],
              equals: 'msg-greeting-own-1',
            },
          },
        ],
      },
      select: {
        id: true,
        ruleCode: true,
      },
    });
    expect(maxClient.deleteMessage).not.toHaveBeenCalled();
    expect(prisma.managedBroadcastDelivery.findFirst).not.toHaveBeenCalled();
  });

  it('does not auto-delete a persisted Karavan storefront relay companion', async () => {
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings({
            deleteBotMessagesEnabled: true,
            deleteBotMessagesDelayMinutes: 1,
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
      auditLog: {
        findFirst: jest.fn().mockResolvedValue({ id: 'storefront-relay-audit-1' }),
      },
      managedBroadcastDelivery: {
        findFirst: jest.fn(),
      },
      webhookEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
      globalSpammer: {
        upsert: jest.fn(),
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
    };

    const service = new ModerationService(
      prisma as never,
      ruleEngine as never,
      sanctionService as never,
      maxClient as never,
      undefined,
      undefined,
      {
        get: jest.fn().mockReturnValue('id613002203036_bot'),
      } as never,
    );

    await service.handleUpdate(
      createOwnBotUpdateWithoutBotFlags('Витрина продавца', 'mid-storefront-button-1'),
    );

    expect(prisma.auditLog.findFirst).toHaveBeenCalledWith({
      where: {
        chatId: 'chat-1',
        action: 'KARAVAN_STOREFRONT_RELAY',
        payload: {
          path: ['companionMessageId'],
          equals: 'mid-storefront-button-1',
        },
      },
      select: {
        id: true,
      },
    });
    expect(maxClient.deleteMessage).not.toHaveBeenCalled();
    expect(prisma.moderationEvent.create).not.toHaveBeenCalled();
    expect(prisma.managedBroadcastDelivery.findFirst).not.toHaveBeenCalled();
  });

  it.each(['Витрина продавца', 'Авторский текст витрины'])(
    'does not auto-delete a queued Karavan companion with copy %s',
    async (companionText) => {
      const prisma = {
        chat: {
          upsert: jest.fn().mockResolvedValue({
            id: 'chat-1',
            title: 'Chat 1',
            settings: createSettings({
              deleteBotMessagesEnabled: true,
              deleteBotMessagesDelayMinutes: 1,
            }),
            domains: [],
            admins: [],
          }),
        },
        violation: { create: jest.fn() },
        moderationEvent: {
          findFirst: jest.fn().mockResolvedValue(null),
          create: jest.fn(),
        },
        auditLog: { findFirst: jest.fn() },
        managedBroadcastDelivery: { findFirst: jest.fn() },
        webhookEvent: { findUnique: jest.fn(), update: jest.fn() },
        globalSpammer: { upsert: jest.fn() },
      };
      const maxClient = {
        deleteMessage: jest.fn(),
        sendMessage: jest.fn(),
        kickMember: jest.fn(),
        banMember: jest.fn(),
        notifyModerators: jest.fn(),
      };
      const karavanStorefrontRelayService = {
        isCompanionMessageCandidate: jest.fn().mockReturnValue(true),
        recognizeCompanionMessage: jest.fn().mockResolvedValue(true),
      };
      const update = createOwnBotUpdateWithoutBotFlags(
        companionText,
        'mid-storefront-button-queued-1',
      );
      update.raw = {
        message: {
          sender: { user_id: 613002203036 },
          link: {
            type: 'reply',
            message: { mid: 'mid-source-queued-1' },
          },
        },
      };

      const service = new ModerationService(
        prisma as never,
        { detect: jest.fn() } as never,
        { resolveAction: jest.fn() } as never,
        maxClient as never,
        undefined,
        undefined,
        { get: jest.fn().mockReturnValue('id613002203036_bot') } as never,
      );
      (
        service as unknown as {
          karavanStorefrontRelayService: typeof karavanStorefrontRelayService;
        }
      ).karavanStorefrontRelayService = karavanStorefrontRelayService;

      await service.handleUpdate(update);

      expect(karavanStorefrontRelayService.recognizeCompanionMessage).toHaveBeenCalledWith({
        chatId: 'chat-1',
        messageId: 'mid-storefront-button-queued-1',
        text: companionText,
        raw: update.raw,
      });
      expect(maxClient.deleteMessage).not.toHaveBeenCalled();
      expect(prisma.auditLog.findFirst).not.toHaveBeenCalled();
    },
  );

  it('does not auto-delete managed broadcast message from own bot', async () => {
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings({
            deleteBotMessagesEnabled: true,
            deleteBotMessagesDelayMinutes: 2,
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
      managedBroadcastDelivery: {
        findFirst: jest.fn().mockResolvedValue({ id: 'delivery-1' }),
      },
      webhookEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
      globalSpammer: {
        upsert: jest.fn(),
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
    };

    const service = new ModerationService(
      prisma as never,
      ruleEngine as never,
      sanctionService as never,
      maxClient as never,
      undefined,
      undefined,
      {
        get: jest.fn().mockReturnValue('id613002203036_bot'),
      } as never,
    );

    await service.handleUpdate(createOwnBotUpdateWithoutBotFlags('broadcast', 'mid-broadcast-1'));

    expect(prisma.managedBroadcastDelivery.findFirst).toHaveBeenCalledWith({
      where: {
        targetChatId: 'chat-1',
        remoteMessageId: 'mid-broadcast-1',
      },
      select: {
        id: true,
      },
    });
    expect(maxClient.deleteMessage).not.toHaveBeenCalled();
  });

  it('does not schedule webhook auto-delete while the matching publication send is in flight', async () => {
    const findFirst = jest
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'delivery-in-flight-1', remoteMessageId: null });
    const prisma = {
      chatRules: { findUnique: jest.fn().mockResolvedValue(null) },
      moderationEvent: { findFirst: jest.fn().mockResolvedValue(null) },
      managedBroadcastDelivery: { findFirst },
      chatAutoCommentAttachMarker: { findFirst: jest.fn().mockResolvedValue(null) },
    };
    const service = new ModerationService(prisma as never, {} as never, {} as never, {} as never);
    (service as any).maxBotLinkService = {
      resolveBotIdFromUserId: jest.fn().mockReturnValue('publisher-bot-1'),
    };
    const scheduleAutoDelete = jest.fn();
    (service as any).handleBotMessageAutoDelete = scheduleAutoDelete;

    await (service as any).handleOwnBotMessageAutoDelete({
      chatId: 'chat-1',
      userId: 'publisher-user-1',
      messageId: 'message-before-persistence-1',
      text: 'managed publication',
      createdAt: '2026-09-01T08:30:00.000Z',
      settings: createSettings({
        deleteBotMessagesEnabled: true,
        deleteBotMessagesDelayMinutes: 2,
      }),
    });

    expect(findFirst).toHaveBeenNthCalledWith(1, {
      where: {
        targetChatId: 'chat-1',
        remoteMessageId: 'message-before-persistence-1',
      },
      select: { id: true },
    });
    expect(findFirst).toHaveBeenNthCalledWith(2, {
      where: {
        targetChatId: 'chat-1',
        OR: [
          { remoteMessageId: 'message-before-persistence-1' },
          {
            botId: 'publisher-bot-1',
            remoteMessageId: null,
            broadcast: { is: { entityType: 'CHAT' } },
            OR: [
              {
                status: 'SENDING',
                lockedAt: { gt: expect.any(Date) },
              },
              {
                status: 'AMBIGUOUS',
                updatedAt: {
                  gte: new Date('2026-09-01T08:20:00.000Z'),
                  lte: new Date('2026-09-01T08:40:00.000Z'),
                },
              },
            ],
          },
        ],
      },
      select: { id: true, remoteMessageId: true },
    });
    expect(scheduleAutoDelete).not.toHaveBeenCalled();
  });

  it('does not let a stale publication send fence suppress webhook auto-delete', async () => {
    const nowMs = Date.parse('2026-09-01T09:00:00.000Z');
    const dateNowSpy = jest.spyOn(Date, 'now').mockReturnValue(nowMs);
    const findFirst = jest.fn().mockResolvedValue(null);
    const prisma = {
      chatRules: { findUnique: jest.fn().mockResolvedValue(null) },
      moderationEvent: { findFirst: jest.fn().mockResolvedValue(null) },
      managedBroadcastDelivery: { findFirst },
      chatAutoCommentAttachMarker: { findFirst: jest.fn().mockResolvedValue(null) },
    };
    const service = new ModerationService(prisma as never, {} as never, {} as never, {} as never);
    (service as any).maxBotLinkService = {
      resolveBotIdFromUserId: jest.fn().mockReturnValue('publisher-bot-1'),
    };
    const scheduleAutoDelete = jest.fn();
    (service as any).handleBotMessageAutoDelete = scheduleAutoDelete;

    try {
      await (service as any).handleOwnBotMessageAutoDelete({
        chatId: 'chat-1',
        userId: 'publisher-user-1',
        messageId: 'ordinary-bot-message-1',
        text: 'temporary bot notice',
        createdAt: '2026-09-01T09:00:00.000Z',
        settings: createSettings({
          deleteBotMessagesEnabled: true,
          deleteBotMessagesDelayMinutes: 2,
        }),
      });
    } finally {
      dateNowSpy.mockRestore();
    }

    expect(findFirst).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        where: expect.objectContaining({
          OR: expect.arrayContaining([
            expect.objectContaining({
              OR: expect.arrayContaining([
                expect.objectContaining({
                  lockedAt: { gt: new Date(nowMs - MAX_SEND_FENCE_STALE_MS) },
                }),
                expect.objectContaining({
                  status: 'AMBIGUOUS',
                  updatedAt: {
                    gte: new Date(nowMs - MAX_SEND_FENCE_STALE_MS),
                    lte: new Date(nowMs + MAX_SEND_FENCE_STALE_MS),
                  },
                }),
              ]),
            }),
          ]),
        }),
      }),
    );
    expect(scheduleAutoDelete).toHaveBeenCalledWith({
      chatId: 'chat-1',
      userId: 'publisher-user-1',
      messageId: 'ordinary-bot-message-1',
      text: 'temporary bot notice',
      createdAt: '2026-09-01T09:00:00.000Z',
      delayMinutes: 2,
    });
  });

  it('does not auto-delete a bot output that carries chat comments', async () => {
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings({
            deleteBotMessagesEnabled: true,
            deleteBotMessagesDelayMinutes: 2,
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
      managedBroadcastDelivery: {
        findFirst: jest.fn().mockResolvedValue(null),
      },
      chatAutoCommentAttachMarker: {
        findFirst: jest.fn().mockResolvedValue({ id: 'comment-copy-1' }),
      },
      webhookEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
      globalSpammer: {
        upsert: jest.fn(),
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
    };

    const service = new ModerationService(
      prisma as never,
      ruleEngine as never,
      sanctionService as never,
      maxClient as never,
      undefined,
      undefined,
      {
        get: jest.fn().mockReturnValue('id613002203036_bot'),
      } as never,
    );

    await service.handleUpdate(
      createOwnBotUpdateWithoutBotFlags('post with comments', 'mid-comment-copy-1'),
    );

    expect(prisma.chatAutoCommentAttachMarker.findFirst).toHaveBeenCalledWith({
      where: {
        chatId: 'chat-1',
        OR: [
          { replacementMessageId: 'mid-comment-copy-1' },
          { replyMessageId: 'mid-comment-copy-1' },
        ],
      },
      select: {
        id: true,
      },
    });
    expect(maxClient.deleteMessage).not.toHaveBeenCalled();
    expect(prisma.moderationEvent.create).not.toHaveBeenCalled();
  });

  it('does not auto-delete night mode notice from own bot', async () => {
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings({
            nightModeEnabled: true,
            nightModeStartTimeMinutes: 23 * 60,
            nightModeEndTimeMinutes: 8 * 60,
            nightModeTimezone: 'Europe/Moscow',
            nightModeBotMessageEnabled: true,
            nightModeBotMessageText: '',
            deleteBotMessagesEnabled: true,
            deleteBotMessagesDelayMinutes: 2,
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
      globalSpammer: {
        upsert: jest.fn(),
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
    };

    const service = new ModerationService(
      prisma as never,
      ruleEngine as never,
      sanctionService as never,
      maxClient as never,
      undefined,
      undefined,
      {
        get: jest.fn().mockReturnValue('bot-1'),
      } as never,
    );

    await service.handleUpdate({
      updateId: 'upd-night-own-bot-1',
      type: 'message_created',
      message: {
        messageId: 'msg-night-own-bot-1',
        chatId: 'chat-1',
        senderId: 'bot-1',
        text: nightModeNotice('23:00-08:00', 'Москва'),
        createdAt: new Date().toISOString(),
      },
      raw: {
        message: {
          sender: {
            id: 'bot-1',
            type: 'bot',
            is_bot: true,
          },
        },
      },
    });

    expect(ruleEngine.detect).not.toHaveBeenCalled();
    expect(maxClient.deleteMessage).not.toHaveBeenCalled();
    expect(prisma.moderationEvent.findFirst).not.toHaveBeenCalled();
    expect(prisma.moderationEvent.create).not.toHaveBeenCalled();
  });

  it('protects a persisted night notice when MAX returns plain webhook text for escaped Markdown', async () => {
    const storedMarkdown =
      'Сейчас тихий режим 🌙 20:00-06:00 \\(Москва\\). Новые сообщения временно не принимаются.';
    const webhookText =
      'Сейчас тихий режим 🌙 20:00-06:00 (Москва). Новые сообщения временно не принимаются.';
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings({
            nightModeEnabled: true,
            nightModeStartTimeMinutes: 20 * 60,
            nightModeEndTimeMinutes: 6 * 60,
            nightModeTimezone: 'Europe/Moscow',
            nightModeBotMessageEnabled: true,
            nightModeBotMessageText: storedMarkdown,
            deleteBotMessagesEnabled: true,
            deleteBotMessagesDelayMinutes: 2,
          }),
          domains: [],
          admins: [],
        }),
      },
      violation: {
        create: jest.fn(),
      },
      moderationEvent: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'night-close-event-1',
          ruleCode: 'NIGHT_MODE_CLOSE_NOTICE',
        }),
        create: jest.fn(),
      },
      webhookEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
      globalSpammer: {
        upsert: jest.fn(),
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
      { detect: jest.fn() } as never,
      { resolveAction: jest.fn() } as never,
      maxClient as never,
      undefined,
      undefined,
      { get: jest.fn().mockReturnValue('bot-1') } as never,
    );

    await service.handleUpdate({
      updateId: 'upd-night-markdown-own-bot-1',
      type: 'message_created',
      message: {
        messageId: 'msg-night-markdown-own-bot-1',
        chatId: 'chat-1',
        senderId: 'bot-1',
        text: webhookText,
        createdAt: new Date().toISOString(),
      },
      raw: {
        message: {
          sender: {
            id: 'bot-1',
            type: 'bot',
            is_bot: true,
          },
        },
      },
    });

    expect(prisma.moderationEvent.findFirst).toHaveBeenCalledWith({
      where: {
        chatId: 'chat-1',
        OR: [
          {
            messageId: 'msg-night-markdown-own-bot-1',
            ruleCode: {
              in: ['NIGHT_MODE_CLOSE_NOTICE', 'NIGHT_MODE_OPEN_NOTICE'],
            },
          },
          {
            ruleCode: 'GREETING_MESSAGE',
            metadata: {
              path: ['sentMessageId'],
              equals: 'msg-night-markdown-own-bot-1',
            },
          },
        ],
      },
      select: {
        id: true,
        ruleCode: true,
      },
    });
    expect(maxClient.deleteMessage).not.toHaveBeenCalled();
    expect(prisma.moderationEvent.create).not.toHaveBeenCalled();
  });

  it('does not auto-delete night mode open notice from own bot', async () => {
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings({
            nightModeEnabled: true,
            nightModeStartTimeMinutes: 23 * 60,
            nightModeEndTimeMinutes: 8 * 60,
            nightModeTimezone: 'Europe/Moscow',
            nightModeOpenMessageEnabled: true,
            nightModeOpenMessageText: '',
            deleteBotMessagesEnabled: true,
            deleteBotMessagesDelayMinutes: 2,
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
      globalSpammer: {
        upsert: jest.fn(),
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
    };

    const service = new ModerationService(
      prisma as never,
      ruleEngine as never,
      sanctionService as never,
      maxClient as never,
      undefined,
      undefined,
      {
        get: jest.fn().mockReturnValue('bot-1'),
      } as never,
    );

    await service.handleUpdate({
      updateId: 'upd-night-open-own-bot-1',
      type: 'message_created',
      message: {
        messageId: 'msg-night-open-own-bot-1',
        chatId: 'chat-1',
        senderId: 'bot-1',
        text: nightModeOpenNotice(),
        createdAt: new Date().toISOString(),
      },
      raw: {
        message: {
          sender: {
            id: 'bot-1',
            type: 'bot',
            is_bot: true,
          },
        },
      },
    });

    expect(ruleEngine.detect).not.toHaveBeenCalled();
    expect(maxClient.deleteMessage).not.toHaveBeenCalled();
    expect(prisma.moderationEvent.findFirst).not.toHaveBeenCalled();
    expect(prisma.moderationEvent.create).not.toHaveBeenCalled();
  });

  it('records first 6-chat fanout as an observed signal without auto-kick when toggle is enabled', async () => {
    const nowIso = new Date().toISOString();
    const createSpamUpdate = (chatId: string, messageId: string, text: string): MaxUpdate => ({
      updateId: `upd-${chatId}-${messageId}`,
      type: 'message_created',
      message: {
        messageId,
        chatId,
        senderId: 'user-spam-1',
        senderName: 'Спамер',
        text,
        createdAt: nowIso,
      },
      raw: {
        message: {
          sender: {
            id: 'user-spam-1',
            type: 'user',
          },
          body: {
            text,
          },
        },
      },
    });

    const prisma = {
      chat: {
        upsert: jest.fn().mockImplementation(({ where }: { where: { id: string } }) =>
          Promise.resolve({
            id: where.id,
            title: `Chat ${where.id}`,
            settings: createSettings({ deleteSpammersEnabled: true }),
            domains: [],
            admins: [{ userId: 'owner-1' }],
          }),
        ),
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
      globalSpammer: {
        upsert: jest.fn(),
        findUnique: jest.fn().mockResolvedValue(null),
      },
    };
    const ruleEngine = {
      detect: jest.fn().mockResolvedValue({ violations: [] }),
      hasCommercialSpamMarkers: jest.fn().mockReturnValue(false),
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
    const redisCounter = {
      addToSetWithTtl: jest
        .fn()
        .mockResolvedValueOnce({ added: true, size: 1 })
        .mockResolvedValueOnce({ added: true, size: 2 })
        .mockResolvedValueOnce({ added: true, size: 3 })
        .mockResolvedValueOnce({ added: true, size: 4 })
        .mockResolvedValueOnce({ added: true, size: 5 })
        .mockResolvedValueOnce({ added: true, size: 6 })
        .mockResolvedValueOnce({ added: true, size: 1 }),
      incrementWithTtl: jest.fn().mockResolvedValue(1),
    };

    const service = new ModerationService(
      prisma as never,
      ruleEngine as never,
      sanctionService as never,
      maxClient as never,
      undefined,
      undefined,
      {
        get: jest.fn().mockReturnValue('bot-1'),
      } as never,
      redisCounter as never,
    );

    await service.handleUpdate(createSpamUpdate('chat-1', 'msg-1', 'Текст 1'));
    await service.handleUpdate(createSpamUpdate('chat-2', 'msg-2', 'Текст 2'));
    await service.handleUpdate(createSpamUpdate('chat-3', 'msg-3', 'Текст 3'));
    await service.handleUpdate(createSpamUpdate('chat-4', 'msg-4', 'Текст 4'));
    await service.handleUpdate(createSpamUpdate('chat-5', 'msg-5', 'Текст 5'));
    await service.handleUpdate(createSpamUpdate('chat-6', 'msg-6', 'Текст 6'));
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(maxClient.sendMessage).not.toHaveBeenCalled();
    expect(maxClient.deleteMessage).not.toHaveBeenCalled();
    expect(maxClient.kickMember).not.toHaveBeenCalled();
    expect(prisma.globalSpammer.upsert).not.toHaveBeenCalled();
    expect(redisCounter.incrementWithTtl).toHaveBeenCalledWith(
      'global-spammer:fanout-episodes:v2:user-spam-1',
      604800,
    );
  });

  it('does not auto-kick on sixth unique chat when the sender is exempted by a chat admin', async () => {
    const nowIso = new Date().toISOString();
    const createSpamUpdate = (chatId: string, messageId: string, text: string): MaxUpdate => ({
      updateId: `upd-${chatId}-${messageId}`,
      type: 'message_created',
      message: {
        messageId,
        chatId,
        senderId: 'user-spam-1',
        senderName: 'Спамер',
        text,
        createdAt: nowIso,
      },
      raw: {
        message: {
          sender: {
            id: 'user-spam-1',
            type: 'user',
          },
          body: {
            text,
          },
        },
      },
    });

    const prisma = {
      chat: {
        upsert: jest.fn().mockImplementation(({ where }: { where: { id: string } }) =>
          Promise.resolve({
            id: where.id,
            title: `Chat ${where.id}`,
            settings: createSettings({ deleteSpammersEnabled: true }),
            domains: [],
            admins: [{ userId: 'owner-1' }],
          }),
        ),
      },
      adminGlobalSpammerExemption: {
        findMany: jest.fn().mockResolvedValue([{ userId: 'user-spam-1' }]),
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
      globalSpammer: {
        upsert: jest.fn(),
        findUnique: jest.fn().mockResolvedValue(null),
      },
    };
    const ruleEngine = {
      detect: jest.fn().mockResolvedValue({ violations: [] }),
      hasCommercialSpamMarkers: jest.fn().mockReturnValue(false),
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
    const redisCounter = {
      addToSetWithTtl: jest
        .fn()
        .mockResolvedValueOnce({ added: true, size: 1 })
        .mockResolvedValueOnce({ added: true, size: 2 })
        .mockResolvedValueOnce({ added: true, size: 3 })
        .mockResolvedValueOnce({ added: true, size: 4 })
        .mockResolvedValueOnce({ added: true, size: 5 })
        .mockResolvedValueOnce({ added: true, size: 6 })
        .mockResolvedValueOnce({ added: true, size: 1 }),
      incrementWithTtl: jest.fn().mockResolvedValue(1),
    };

    const service = new ModerationService(
      prisma as never,
      ruleEngine as never,
      sanctionService as never,
      maxClient as never,
      undefined,
      undefined,
      {
        get: jest.fn().mockReturnValue('bot-1'),
      } as never,
      redisCounter as never,
    );

    await service.handleUpdate(createSpamUpdate('chat-1', 'msg-1', 'Текст 1'));
    await service.handleUpdate(createSpamUpdate('chat-2', 'msg-2', 'Текст 2'));
    await service.handleUpdate(createSpamUpdate('chat-3', 'msg-3', 'Текст 3'));
    await service.handleUpdate(createSpamUpdate('chat-4', 'msg-4', 'Текст 4'));
    await service.handleUpdate(createSpamUpdate('chat-5', 'msg-5', 'Текст 5'));
    await service.handleUpdate(createSpamUpdate('chat-6', 'msg-6', 'Текст 6'));

    expect(maxClient.sendMessage).not.toHaveBeenCalled();
    expect(maxClient.deleteMessage).not.toHaveBeenCalled();
    expect(maxClient.kickMember).not.toHaveBeenCalled();
    expect(prisma.globalSpammer.upsert).not.toHaveBeenCalled();
  });

  it('does not re-track global spammer state for repeated messages from the same user in the same chat window', async () => {
    const nowIso = new Date().toISOString();
    const createSpamUpdate = (messageId: string, text: string): MaxUpdate => ({
      updateId: `upd-chat-1-${messageId}`,
      type: 'message_created',
      message: {
        messageId,
        chatId: 'chat-1',
        senderId: 'user-spam-1',
        senderName: 'Спамер',
        text,
        createdAt: nowIso,
      },
      raw: {
        message: {
          sender: {
            id: 'user-spam-1',
            type: 'user',
          },
          body: {
            text,
          },
        },
      },
    });

    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat chat-1',
          settings: createSettings({ deleteSpammersEnabled: true }),
          domains: [],
          admins: [{ userId: 'owner-1' }],
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
      globalSpammer: {
        upsert: jest.fn(),
        findUnique: jest.fn().mockResolvedValue(null),
      },
    };
    const ruleEngine = {
      detect: jest.fn().mockResolvedValue({ violations: [] }),
      hasCommercialSpamMarkers: jest.fn().mockReturnValue(false),
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
    const redisCounter = {
      addToSetWithTtl: jest.fn().mockResolvedValue({ added: true, size: 1 }),
      incrementWithTtl: jest.fn().mockResolvedValue(1),
    };

    const service = new ModerationService(
      prisma as never,
      ruleEngine as never,
      sanctionService as never,
      maxClient as never,
      undefined,
      undefined,
      {
        get: jest.fn().mockReturnValue('bot-1'),
      } as never,
      redisCounter as never,
    );

    await service.handleUpdate(createSpamUpdate('msg-1', 'Первое сообщение'));
    await service.handleUpdate(createSpamUpdate('msg-2', 'Второе сообщение'));

    expect(redisCounter.addToSetWithTtl).toHaveBeenCalledTimes(1);
    expect(redisCounter.addToSetWithTtl).toHaveBeenCalledWith(
      'global-spammer:any:v1:user-spam-1',
      'chat-1',
      125,
    );
  });

  it('keeps first 6-chat fanout out of the global registry when toggle is disabled', async () => {
    const nowIso = new Date().toISOString();
    const createSpamUpdate = (chatId: string, messageId: string, text: string): MaxUpdate => ({
      updateId: `upd-${chatId}-${messageId}`,
      type: 'message_created',
      message: {
        messageId,
        chatId,
        senderId: 'user-spam-1',
        senderName: 'Спамер',
        text,
        createdAt: nowIso,
      },
      raw: {
        message: {
          sender: {
            id: 'user-spam-1',
            type: 'user',
          },
          body: {
            text,
          },
        },
      },
    });

    const prisma = {
      chat: {
        upsert: jest.fn().mockImplementation(({ where }: { where: { id: string } }) =>
          Promise.resolve({
            id: where.id,
            title: `Chat ${where.id}`,
            settings: createSettings({ deleteSpammersEnabled: false }),
            domains: [],
            admins: [{ userId: 'owner-1' }],
          }),
        ),
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
      globalSpammer: {
        upsert: jest.fn(),
        findUnique: jest.fn().mockResolvedValue(null),
      },
    };
    const ruleEngine = {
      detect: jest.fn().mockResolvedValue({ violations: [] }),
      hasCommercialSpamMarkers: jest.fn().mockReturnValue(false),
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
    const redisCounter = {
      addToSetWithTtl: jest
        .fn()
        .mockResolvedValueOnce({ added: true, size: 1 })
        .mockResolvedValueOnce({ added: true, size: 2 })
        .mockResolvedValueOnce({ added: true, size: 3 })
        .mockResolvedValueOnce({ added: true, size: 4 })
        .mockResolvedValueOnce({ added: true, size: 5 })
        .mockResolvedValueOnce({ added: true, size: 6 })
        .mockResolvedValueOnce({ added: true, size: 1 }),
      incrementWithTtl: jest.fn().mockResolvedValue(1),
    };

    const service = new ModerationService(
      prisma as never,
      ruleEngine as never,
      sanctionService as never,
      maxClient as never,
      undefined,
      undefined,
      {
        get: jest.fn().mockReturnValue('bot-1'),
      } as never,
      redisCounter as never,
    );

    await service.handleUpdate(createSpamUpdate('chat-1', 'msg-1', 'Текст 1'));
    await service.handleUpdate(createSpamUpdate('chat-2', 'msg-2', 'Текст 2'));
    await service.handleUpdate(createSpamUpdate('chat-3', 'msg-3', 'Текст 3'));
    await service.handleUpdate(createSpamUpdate('chat-4', 'msg-4', 'Текст 4'));
    await service.handleUpdate(createSpamUpdate('chat-5', 'msg-5', 'Текст 5'));
    await service.handleUpdate(createSpamUpdate('chat-6', 'msg-6', 'Текст 6'));

    expect(maxClient.sendMessage).not.toHaveBeenCalled();
    expect(maxClient.deleteMessage).not.toHaveBeenCalled();
    expect(maxClient.kickMember).not.toHaveBeenCalled();
    expect(prisma.globalSpammer.upsert).not.toHaveBeenCalled();
  });

  it('does not send warning on fifth unique chat in 2 minutes when toggle is disabled', async () => {
    const nowIso = new Date().toISOString();
    const createSpamUpdate = (chatId: string, messageId: string, text: string): MaxUpdate => ({
      updateId: `upd-${chatId}-${messageId}`,
      type: 'message_created',
      message: {
        messageId,
        chatId,
        senderId: 'user-spam-1',
        senderName: 'Спамер',
        text,
        createdAt: nowIso,
      },
      raw: {
        message: {
          sender: {
            id: 'user-spam-1',
            type: 'user',
          },
          body: {
            text,
          },
        },
      },
    });

    const prisma = {
      chat: {
        upsert: jest.fn().mockImplementation(({ where }: { where: { id: string } }) =>
          Promise.resolve({
            id: where.id,
            title: `Chat ${where.id}`,
            settings: createSettings({ deleteSpammersEnabled: false }),
            domains: [],
            admins: [{ userId: 'owner-1' }],
          }),
        ),
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
      globalSpammer: {
        upsert: jest.fn(),
        findUnique: jest.fn().mockResolvedValue(null),
      },
    };
    const ruleEngine = {
      detect: jest.fn().mockResolvedValue({ violations: [] }),
      hasCommercialSpamMarkers: jest.fn().mockReturnValue(false),
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
    const redisCounter = {
      addToSetWithTtl: jest
        .fn()
        .mockResolvedValueOnce({ added: true, size: 1 })
        .mockResolvedValueOnce({ added: true, size: 2 })
        .mockResolvedValueOnce({ added: true, size: 3 })
        .mockResolvedValueOnce({ added: true, size: 4 })
        .mockResolvedValueOnce({ added: true, size: 5 }),
      incrementWithTtl: jest.fn().mockResolvedValue(1),
    };

    const service = new ModerationService(
      prisma as never,
      ruleEngine as never,
      sanctionService as never,
      maxClient as never,
      undefined,
      undefined,
      {
        get: jest.fn().mockReturnValue('bot-1'),
      } as never,
      redisCounter as never,
    );

    await service.handleUpdate(createSpamUpdate('chat-1', 'msg-1', 'Добрый день, 1'));
    await service.handleUpdate(createSpamUpdate('chat-2', 'msg-2', 'Добрый день, 2'));
    await service.handleUpdate(createSpamUpdate('chat-3', 'msg-3', 'Добрый день, 3'));
    await service.handleUpdate(createSpamUpdate('chat-4', 'msg-4', 'Добрый день, 4'));
    await service.handleUpdate(createSpamUpdate('chat-5', 'msg-5', 'Добрый день, 5'));

    expect(maxClient.sendMessage).not.toHaveBeenCalled();
    expect(prisma.globalSpammer.upsert).not.toHaveBeenCalled();
    expect(maxClient.deleteMessage).not.toHaveBeenCalled();
    expect(maxClient.kickMember).not.toHaveBeenCalled();
  });

  it('keeps repeated 5-chat fanout out of the registry when toggle is disabled', async () => {
    const nowIso = new Date().toISOString();
    const createSpamUpdate = (chatId: string, messageId: string, text: string): MaxUpdate => ({
      updateId: `upd-${chatId}-${messageId}`,
      type: 'message_created',
      message: {
        messageId,
        chatId,
        senderId: 'user-spam-1',
        senderName: 'Спамер',
        text,
        createdAt: nowIso,
      },
      raw: {
        message: {
          sender: {
            id: 'user-spam-1',
            type: 'user',
          },
          body: {
            text,
          },
        },
      },
    });

    const prisma = {
      chat: {
        upsert: jest.fn().mockImplementation(({ where }: { where: { id: string } }) =>
          Promise.resolve({
            id: where.id,
            title: `Chat ${where.id}`,
            settings: createSettings({ deleteSpammersEnabled: false }),
            domains: [],
            admins: [{ userId: 'owner-1' }],
          }),
        ),
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
      globalSpammer: {
        upsert: jest.fn(),
        findUnique: jest.fn().mockResolvedValue(null),
      },
    };
    const ruleEngine = {
      detect: jest.fn().mockResolvedValue({ violations: [] }),
      hasCommercialSpamMarkers: jest.fn().mockReturnValue(false),
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
    const redisCounter = {
      addToSetWithTtl: jest
        .fn()
        .mockResolvedValueOnce({ added: true, size: 1 })
        .mockResolvedValueOnce({ added: true, size: 2 })
        .mockResolvedValueOnce({ added: true, size: 3 })
        .mockResolvedValueOnce({ added: true, size: 4 })
        .mockResolvedValueOnce({ added: true, size: 5 })
        .mockResolvedValueOnce({ added: true, size: 1 })
        .mockResolvedValueOnce({ added: true, size: 2 })
        .mockResolvedValueOnce({ added: true, size: 3 })
        .mockResolvedValueOnce({ added: true, size: 4 })
        .mockResolvedValueOnce({ added: true, size: 5 }),
      incrementWithTtl: jest.fn().mockResolvedValueOnce(1).mockResolvedValueOnce(2),
    };

    const service = new ModerationService(
      prisma as never,
      ruleEngine as never,
      sanctionService as never,
      maxClient as never,
      undefined,
      undefined,
      {
        get: jest.fn().mockReturnValue('bot-1'),
      } as never,
      redisCounter as never,
    );

    await service.handleUpdate(createSpamUpdate('chat-1', 'msg-1', 'Добрый день, команда 1'));
    await service.handleUpdate(createSpamUpdate('chat-2', 'msg-2', 'Добрый день, команда 2'));
    await service.handleUpdate(createSpamUpdate('chat-3', 'msg-3', 'Добрый день, команда 3'));
    await service.handleUpdate(createSpamUpdate('chat-4', 'msg-4', 'Добрый день, команда 4'));
    await service.handleUpdate(createSpamUpdate('chat-5', 'msg-5', 'Добрый день, команда 5'));
    await service.handleUpdate(createSpamUpdate('chat-6', 'msg-6', 'Добрый день, команда 6'));
    await service.handleUpdate(createSpamUpdate('chat-7', 'msg-7', 'Добрый день, команда 7'));
    await service.handleUpdate(createSpamUpdate('chat-8', 'msg-8', 'Добрый день, команда 8'));
    await service.handleUpdate(createSpamUpdate('chat-9', 'msg-9', 'Добрый день, команда 9'));
    await service.handleUpdate(createSpamUpdate('chat-10', 'msg-10', 'Добрый день, команда 10'));

    expect(maxClient.sendMessage).not.toHaveBeenCalled();
    expect(prisma.globalSpammer.upsert).not.toHaveBeenCalled();
    expect(maxClient.deleteMessage).not.toHaveBeenCalled();
    expect(maxClient.kickMember).not.toHaveBeenCalled();
  });

  it('keeps repeated 5-chat fanout in review without warning when toggle is enabled', async () => {
    const nowIso = new Date().toISOString();
    const createSpamUpdate = (chatId: string, messageId: string, text: string): MaxUpdate => ({
      updateId: `upd-${chatId}-${messageId}`,
      type: 'message_created',
      message: {
        messageId,
        chatId,
        senderId: 'user-spam-1',
        senderName: 'Спамер',
        text,
        createdAt: nowIso,
      },
      raw: {
        message: {
          sender: {
            id: 'user-spam-1',
            type: 'user',
          },
          body: {
            text,
          },
        },
      },
    });

    const prisma = {
      chat: {
        upsert: jest.fn().mockImplementation(({ where }: { where: { id: string } }) =>
          Promise.resolve({
            id: where.id,
            title: `Chat ${where.id}`,
            settings: createSettings({ deleteSpammersEnabled: true }),
            domains: [],
            admins: [{ userId: 'owner-1' }],
          }),
        ),
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
      globalSpammer: {
        upsert: jest.fn(),
        findUnique: jest.fn().mockResolvedValue(null),
      },
    };
    const ruleEngine = {
      detect: jest.fn().mockResolvedValue({ violations: [] }),
      hasCommercialSpamMarkers: jest.fn().mockReturnValue(false),
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
    const redisCounter = {
      addToSetWithTtl: jest
        .fn()
        .mockResolvedValueOnce({ added: true, size: 1 })
        .mockResolvedValueOnce({ added: true, size: 2 })
        .mockResolvedValueOnce({ added: true, size: 3 })
        .mockResolvedValueOnce({ added: true, size: 4 })
        .mockResolvedValueOnce({ added: true, size: 5 })
        .mockResolvedValueOnce({ added: true, size: 1 })
        .mockResolvedValueOnce({ added: true, size: 2 })
        .mockResolvedValueOnce({ added: true, size: 3 })
        .mockResolvedValueOnce({ added: true, size: 4 })
        .mockResolvedValueOnce({ added: true, size: 5 }),
      incrementWithTtl: jest.fn().mockResolvedValueOnce(1).mockResolvedValueOnce(2),
    };

    const service = new ModerationService(
      prisma as never,
      ruleEngine as never,
      sanctionService as never,
      maxClient as never,
      undefined,
      undefined,
      {
        get: jest.fn().mockReturnValue('bot-1'),
      } as never,
      redisCounter as never,
    );

    await service.handleUpdate(createSpamUpdate('chat-1', 'msg-1', 'Добрый день, команда 1'));
    await service.handleUpdate(createSpamUpdate('chat-2', 'msg-2', 'Добрый день, команда 2'));
    await service.handleUpdate(createSpamUpdate('chat-3', 'msg-3', 'Добрый день, команда 3'));
    await service.handleUpdate(createSpamUpdate('chat-4', 'msg-4', 'Добрый день, команда 4'));
    await service.handleUpdate(createSpamUpdate('chat-5', 'msg-5', 'Добрый день, команда 5'));
    await service.handleUpdate(createSpamUpdate('chat-6', 'msg-6', 'Добрый день, команда 6'));
    await service.handleUpdate(createSpamUpdate('chat-7', 'msg-7', 'Добрый день, команда 7'));
    await service.handleUpdate(createSpamUpdate('chat-8', 'msg-8', 'Добрый день, команда 8'));
    await service.handleUpdate(createSpamUpdate('chat-9', 'msg-9', 'Добрый день, команда 9'));
    await service.handleUpdate(createSpamUpdate('chat-10', 'msg-10', 'Добрый день, команда 10'));

    expect(maxClient.sendMessage).not.toHaveBeenCalled();
    expect(prisma.globalSpammer.upsert).not.toHaveBeenCalled();
    expect(maxClient.deleteMessage).not.toHaveBeenCalled();
    expect(maxClient.kickMember).not.toHaveBeenCalled();
  });

  it('removes bot-authored accounts from group when toggle is enabled', async () => {
    const queryRaw = jest
      .fn()
      .mockResolvedValueOnce([{ id: 'chat-1' }])
      .mockResolvedValueOnce([]);
    const prisma = {
      $transaction: jest
        .fn()
        .mockImplementation(async (operation: (tx: unknown) => unknown) =>
          operation({ $queryRaw: queryRaw }),
        ),
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings({ removeBotsFromGroupEnabled: true }),
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
      globalSpammer: {
        upsert: jest.fn(),
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
      getChatMembersAccess: jest.fn().mockResolvedValue(new Map()),
    };
    const chatContextCache = {
      getChatContext: jest.fn().mockResolvedValue({
        settings: createSettings({ removeBotsFromGroupEnabled: true }),
        domainAllowlist: [],
        adminUserIds: [],
        rulesPublishedUrl: null,
        rulesPublishedMessageId: null,
      }),
      getAdminAccessBatch: jest.fn().mockResolvedValue(new Map()),
      applyAdminAccessEpochMutation: jest.fn().mockResolvedValue(true),
    };

    const service = new ModerationService(
      prisma as never,
      ruleEngine as never,
      sanctionService as never,
      maxClient as never,
      chatContextCache as never,
    );
    installStateDeleteExecutorFixture(service);
    const ensureDeleteIntent = jest
      .spyOn(service as any, 'ensureModerationDeleteIntent')
      .mockResolvedValue(undefined);
    const update = createBotAuthoredUpdate();
    update.message!.createdAt = new Date().toISOString();

    await service.handleUpdate(update);

    expect(ruleEngine.detect).not.toHaveBeenCalled();
    expect(prisma.violation.create).not.toHaveBeenCalled();
    expectImmediateDeleteMessage(maxClient.deleteMessage, 'chat-1', 'msg-bot-1');
    expect(maxClient.sendMessage).not.toHaveBeenCalled();
    expectImmediateKickMember(maxClient.kickMember, 'chat-1', 'bot-1');
    expect(maxClient.banMember).not.toHaveBeenCalled();
    expect(ensureDeleteIntent).toHaveBeenCalledWith(
      expect.objectContaining({
        ruleCode: 'BOT_ACCOUNT_MESSAGE_DELETE',
        sourceMessageAt: update.message!.createdAt,
      }),
    );
    expect(prisma.moderationEvent.create).toHaveBeenCalledTimes(1);
    expect(prisma.moderationEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        chatId: 'chat-1',
        userId: 'bot-1',
        messageId: 'msg-bot-1',
        ruleCode: 'BOT_ACCOUNT_KICK',
        action: SanctionAction.KICK,
      }),
    });
  });

  it('does not remove bot-authored admin messages when remove-bots toggle is enabled', async () => {
    const queryRaw = jest
      .fn()
      .mockResolvedValueOnce([{ id: 'chat-1' }])
      .mockResolvedValueOnce([]);
    const prisma = {
      $transaction: jest
        .fn()
        .mockImplementation(async (operation: (tx: unknown) => unknown) =>
          operation({ $queryRaw: queryRaw }),
        ),
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings({ removeBotsFromGroupEnabled: true }),
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
      globalSpammer: {
        upsert: jest.fn(),
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
    };
    const chatContextCache = {
      getChatContext: jest.fn().mockResolvedValue({
        settings: createSettings({ removeBotsFromGroupEnabled: true }),
        domainAllowlist: [],
        adminUserIds: ['admin-1'],
        rulesPublishedUrl: null,
        rulesPublishedMessageId: null,
      }),
      getAdminAccessBatch: jest.fn().mockResolvedValue(new Map()),
      applyAdminAccessEpochMutation: jest.fn().mockResolvedValue(true),
    };

    const service = new ModerationService(
      prisma as never,
      ruleEngine as never,
      sanctionService as never,
      maxClient as never,
      chatContextCache as never,
    );

    await service.handleUpdate(createBotAuthoredUpdate());

    expect(maxClient.getChatMembersAccess).toHaveBeenCalledWith(
      'chat-1',
      ['bot-1'],
      expect.objectContaining({ trafficClass: 'interactive' }),
    );
    expect(ruleEngine.detect).not.toHaveBeenCalled();
    expect(prisma.violation.create).not.toHaveBeenCalled();
    expect(maxClient.deleteMessage).not.toHaveBeenCalled();
    expect(maxClient.sendMessage).not.toHaveBeenCalled();
    expect(maxClient.kickMember).not.toHaveBeenCalled();
    expect(maxClient.banMember).not.toHaveBeenCalled();
    expect(prisma.moderationEvent.create).not.toHaveBeenCalled();
  });

  it('auto-leaves chats from join denylist on bot_added update', async () => {
    const prisma = {
      $queryRaw: jest.fn().mockResolvedValue([{ id: 'chat-1' }]),
      chatAdminAllowlist: {
        deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      $transaction: async <T>(work: (tx: unknown) => Promise<T>): Promise<T> => work(prisma),
    };
    const ruleEngine = {
      detect: jest.fn(),
    };
    const sanctionService = {};
    const maxClient = {
      leaveCurrentChat: jest.fn().mockResolvedValue(undefined),
    };
    const chatContextCache = {
      invalidate: jest.fn().mockResolvedValue(undefined),
    };
    const configService = {
      get: jest.fn((key: string) =>
        key === 'MAX_JOIN_DENY_CHAT_IDS' ? 'chat-1,chat-2' : undefined,
      ),
    };

    const service = new ModerationService(
      prisma as never,
      ruleEngine as never,
      sanctionService as never,
      maxClient as never,
      chatContextCache as never,
      undefined,
      configService as never,
    );

    await service.handleUpdate(createBotAddedUpdate('chat-1', 'id613002203036_4_bot'));

    expect(maxClient.leaveCurrentChat).toHaveBeenCalledWith('chat-1', {
      botId: 'id613002203036_4_bot',
    });
    expect(prisma.chatAdminAllowlist.deleteMany).toHaveBeenCalledWith({
      where: {
        chatId: 'chat-1',
      },
    });
    expect(chatContextCache.invalidate).toHaveBeenCalledWith('chat-1');
    expect(ruleEngine.detect).not.toHaveBeenCalled();
  });

  it('does not send a premature miniapp settings handoff on bot_added updates', async () => {
    const service = new ModerationService(
      {} as never,
      {} as never,
      {} as never,
      {
        sendMessage: jest.fn().mockResolvedValue(undefined),
      } as never,
      undefined,
      undefined,
      {
        get: jest.fn((key: string) => {
          if (key === 'MAX_BOT_ID') {
            return '777000_bot';
          }
          return undefined;
        }),
      } as never,
    );

    await service.handleUpdate(createBotAddedUpdate('chat-1'));

    const maxClient = (service as unknown as { maxClient: { sendMessage: jest.Mock } }).maxClient;
    expect(maxClient.sendMessage).not.toHaveBeenCalled();
  });

  it('never treats bot_added callback or service-member fields as moderation work', async () => {
    const ruleEngine = { detect: jest.fn() };
    const maxClient = { sendMessage: jest.fn(), leaveCurrentChat: jest.fn() };
    const poll = { tryHandleCallback: jest.fn().mockResolvedValue(true) };
    const duplicate = { observeLifecycle: jest.fn() };
    const service = new ModerationService(
      {} as never,
      ruleEngine as never,
      {} as never,
      maxClient as never,
    );
    Object.assign(service, { managedPollService: poll, messageDuplicateService: duplicate });
    const update = new WebhookParser().parse(
      {
        update_id: 'fixture-bot-added-injected-effects',
        update_type: 'bot_added',
        chat_id: '-100-fixture',
        timestamp: Date.now(),
        user: { user_id: 'fixture-actor' },
        callback: { callback_id: 'fixture-callback', payload: 'injected' },
        new_members: [{ user_id: 'fixture-member' }],
      },
      { botId: 'fixture-bot' },
    );
    await service.handleUpdate(update);
    expect(duplicate.observeLifecycle).not.toHaveBeenCalled();
    expect(poll.tryHandleCallback).not.toHaveBeenCalled();
    expect(ruleEngine.detect).not.toHaveBeenCalled();
    expect(maxClient.sendMessage).not.toHaveBeenCalled();
    expect(maxClient.leaveCurrentChat).not.toHaveBeenCalled();
  });

  it('does not treat the human bot_added actor as a joined service member', async () => {
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings({
            deleteSpammersEnabled: true,
            invitationAccessEnabled: true,
            invitationAccessRequiredCount: 2,
            greetingEnabled: true,
            greetingBotMessageEnabled: true,
          }),
          domains: [],
          admins: [],
        }),
      },
      globalSpammer: {
        findMany: jest.fn().mockResolvedValue([]),
      },
      chatInvitationAccessProgress: {
        findUnique: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
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
    const ruleEngine = { detect: jest.fn() };
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
    const update = new WebhookParser().parse(
      {
        update_id: 'upd-bot-added-human-actor-1',
        update_type: 'bot_added',
        chat_id: 'chat-1',
        user: {
          user_id: 'admin-actor-1',
          first_name: 'Иван',
          last_name: 'Администратор',
        },
        timestamp: '2026-08-20T10:00:00.000Z',
      },
      { botId: 'managed-bot-1' },
    );

    expect(update.membership?.memberUserIds).toEqual(['managed-bot-1']);
    expect(update.message?.senderId).toBe('admin-actor-1');

    await service.handleUpdate(update);

    expect(prisma.chat.upsert).not.toHaveBeenCalled();
    expect(prisma.globalSpammer.findMany).not.toHaveBeenCalled();
    expect(prisma.chatInvitationAccessProgress.create).not.toHaveBeenCalled();
    expect(maxClient.sendMessage).not.toHaveBeenCalled();
    expect(maxClient.kickMember).not.toHaveBeenCalled();
    expect(prisma.moderationEvent.create).not.toHaveBeenCalled();
    expect(ruleEngine.detect).not.toHaveBeenCalled();
  });

  it.each(['269798165', 'id613000037577_3_bot'])(
    'does not moderate Birzhik messages using the real registry: %s',
    async (userId) => {
      const prisma = {
        chat: {
          upsert: jest.fn().mockResolvedValue({
            id: 'chat-1',
            title: 'Chat 1',
            settings: createSettings({
              removeBotsFromGroupEnabled: true,
              deleteBotMessagesEnabled: true,
            }),
            domains: [],
            admins: [],
          }),
        },
        violation: { create: jest.fn() },
        moderationEvent: { findFirst: jest.fn().mockResolvedValue(null), create: jest.fn() },
        webhookEvent: { findUnique: jest.fn(), update: jest.fn() },
      };
      const maxClient = {
        deleteMessage: jest.fn(),
        sendMessage: jest.fn(),
        kickMember: jest.fn(),
        banMember: jest.fn(),
        notifyModerators: jest.fn(),
        getChatMembersAccess: jest.fn().mockResolvedValue(new Map()),
      };
      const registry = new MaxBotRegistryService(
        new ConfigService({
          MAX_BOT_ID: '777000_bot',
          MAX_BOT_TOKEN: 'test-token',
          MAX_WEBHOOK_SECRET_PATH: 'secret-path',
          MAX_WEBHOOK_HEADER_SECRET: 'header-secret',
        }),
      );
      const botIdentity = {
        isKnownBotUserId: registry.isKnownBotUserId.bind(registry),
        resolveBotIdFromUserId: registry.resolveBotIdFromUserId.bind(registry),
      } satisfies Pick<MaxBotLinkService, 'isKnownBotUserId' | 'resolveBotIdFromUserId'>;
      const ruleEngine = { detect: jest.fn() };
      const service = new ModerationService(
        prisma as never,
        ruleEngine as never,
        { resolveAction: jest.fn() } as never,
        maxClient as never,
      );
      Object.assign(service, { maxBotLinkService: botIdentity });
      installStateDeleteExecutorFixture(service);
      const update = createBotAuthoredUpdate();
      update.message!.senderId = userId;
      update.raw = {
        message: { sender: { user_id: userId, name: 'Биржик', is_bot: true } },
      };

      await service.handleUpdate(update);

      expect(ruleEngine.detect).not.toHaveBeenCalled();
      expect(prisma.violation.create).not.toHaveBeenCalled();
      expect(prisma.moderationEvent.create).not.toHaveBeenCalled();
      expect(maxClient.kickMember).not.toHaveBeenCalled();
      expect(maxClient.banMember).not.toHaveBeenCalled();
      expect(maxClient.deleteMessage).not.toHaveBeenCalled();
      expect(maxClient.sendMessage).not.toHaveBeenCalled();
      expect(maxClient.getChatMembersAccess).not.toHaveBeenCalled();
    },
  );

  it.each([
    { userId: '269798165', protected: true },
    { userId: 'id613000037577_3_bot', protected: true },
    { userId: '269798166', protected: false },
    { userId: MAX_ERASER_BOT_CONTACT_ID, protected: true },
    { userId: MAX_ERASER_BOT_ID, protected: true },
    { userId: '281772329', protected: false },
  ])(
    'applies real service bot identity immunity to bot joins: $userId protected=$protected',
    async ({ userId, protected: isProtected }) => {
      const settings = createSettings({ removeBotsFromGroupEnabled: true });
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
        violation: { create: jest.fn() },
        moderationEvent: {
          findFirst: jest.fn().mockResolvedValue(null),
          create: jest.fn(),
        },
        webhookEvent: { findUnique: jest.fn(), update: jest.fn() },
      };
      const maxClient = {
        deleteMessage: jest.fn(),
        sendMessage: jest.fn(),
        kickMember: jest.fn(),
        banMember: jest.fn(),
        notifyModerators: jest.fn(),
      };
      const registry = new MaxBotRegistryService(
        new ConfigService({
          APP_BASE_URL: 'https://major-maksimov.ru',
          MAX_BOT_ID: '777000_bot',
          MAX_BOT_TOKEN: 'test-token',
          MAX_WEBHOOK_SECRET_PATH: 'secret-path',
          MAX_WEBHOOK_HEADER_SECRET: 'header-secret',
        }),
      );
      const botIdentity = {
        isKnownBotUserId: registry.isKnownBotUserId.bind(registry),
        resolveBotIdFromUserId: registry.resolveBotIdFromUserId.bind(registry),
      } satisfies Pick<MaxBotLinkService, 'isKnownBotUserId' | 'resolveBotIdFromUserId'>;
      const service = new ModerationService(
        prisma as never,
        { detect: jest.fn() } as never,
        { resolveAction: jest.fn() } as never,
        maxClient as never,
      );
      Object.assign(service, { maxBotLinkService: botIdentity });
      const update = createServiceBotJoinedUpdate();
      update.raw = {
        message: {
          sender: { id: 'service-1', type: 'service', is_service: true },
          body: { new_members: [{ user_id: userId, name: 'Ластик', is_bot: true }] },
        },
      };

      await service.handleUpdate(update);

      if (isProtected) {
        expect(maxClient.kickMember).not.toHaveBeenCalled();
        expect(prisma.moderationEvent.create).not.toHaveBeenCalled();
      } else {
        expectImmediateKickMember(maxClient.kickMember, 'chat-1', userId);
        expect(prisma.moderationEvent.create).toHaveBeenCalledWith({
          data: expect.objectContaining({ userId, ruleCode: 'BOT_ACCOUNT_KICK' }),
        });
      }
      expect(maxClient.banMember).not.toHaveBeenCalled();
      expect(maxClient.deleteMessage).not.toHaveBeenCalled();
      expect(maxClient.sendMessage).not.toHaveBeenCalled();
    },
  );

  it('kicks bots immediately from service join events when toggle is enabled', async () => {
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings({ removeBotsFromGroupEnabled: true }),
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
    };

    const service = new ModerationService(
      prisma as never,
      ruleEngine as never,
      sanctionService as never,
      maxClient as never,
    );

    await service.handleUpdate(createServiceBotJoinedUpdate());

    expect(ruleEngine.detect).not.toHaveBeenCalled();
    expect(prisma.violation.create).not.toHaveBeenCalled();
    expect(maxClient.deleteMessage).not.toHaveBeenCalled();
    expect(maxClient.sendMessage).not.toHaveBeenCalled();
    expectImmediateKickMember(maxClient.kickMember, 'chat-1', 'bot-joined-1');
    expect(maxClient.banMember).not.toHaveBeenCalled();
    expect(prisma.moderationEvent.create).toHaveBeenCalledTimes(1);
    expect(prisma.moderationEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        chatId: 'chat-1',
        userId: 'bot-joined-1',
        messageId: 'msg-service-bot-join-1',
        ruleCode: 'BOT_ACCOUNT_KICK',
        action: SanctionAction.KICK,
      }),
    });
  });

  it('dedupes exact mirrored bot-join deliveries but handles a distinct rejoin in the same second', async () => {
    const claimedKeys = new Set<string>();
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings({ removeBotsFromGroupEnabled: true }),
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
      moderationViolationMessageClaim: {
        createMany: jest.fn(async (args: { data: Array<{ dedupeKey: string }> }) => {
          const dedupeKey = args.data[0]?.dedupeKey;
          if (!dedupeKey || claimedKeys.has(dedupeKey)) {
            return { count: 0 };
          }

          claimedKeys.add(dedupeKey);
          return { count: 1 };
        }),
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
    };
    const redisCounter = createRedisCounterMock();
    const service = new ModerationService(
      prisma as never,
      ruleEngine as never,
      sanctionService as never,
      maxClient as never,
      undefined,
      undefined,
      undefined,
      redisCounter as never,
    );
    const createdAtMs = new Date('2026-04-06T01:10:00.100Z').getTime();
    const createDeliveredJoinUpdate = (
      botId: string,
      updateId: string,
      offsetMs: number,
    ): MaxUpdate => {
      const createdAt = new Date(createdAtMs + offsetMs).toISOString();
      return {
        ...createServiceBotJoinedUpdate(),
        updateId,
        botId,
        message: {
          ...createServiceBotJoinedUpdate().message!,
          messageId: `msg-service-bot-join-${botId}`,
          createdAt,
        },
        raw: {
          message: {
            sender: {
              id: 'service-1',
              type: 'service',
              is_service: true,
            },
            timestamp: new Date(createdAt).getTime(),
            body: {
              new_members: [
                {
                  user_id: 'bot-joined-1',
                  type: 'bot',
                  is_bot: true,
                },
              ],
            },
          },
        },
      };
    };

    await service.handleUpdate(createDeliveredJoinUpdate('bot-1', 'upd-service-bot-join-bot-1', 0));
    await service.handleUpdate(createDeliveredJoinUpdate('bot-2', 'upd-service-bot-join-bot-2', 0));
    await service.handleUpdate(createDeliveredJoinUpdate('bot-3', 'upd-service-bot-join-bot-3', 0));
    await service.handleUpdate(createDeliveredJoinUpdate('bot-1', 'upd-service-bot-rejoin-2', 300));

    expect(maxClient.kickMember).toHaveBeenCalledTimes(2);
    expect(prisma.moderationEvent.create).toHaveBeenCalledTimes(2);
    expect(prisma.moderationViolationMessageClaim.createMany).toHaveBeenCalledTimes(2);
    const windowClaimCalls = redisCounter.incrementOncePerMemberWithTtl.mock.calls.filter(
      ([counterKey]) =>
        String(counterKey).startsWith(
          'moderation:service-member-action-window:v1:BOT_ACCOUNT_KICK:service_member',
        ),
    );
    expect(windowClaimCalls).toHaveLength(4);
    expect(new Set(windowClaimCalls.slice(0, 3).map(([, memberKey]) => memberKey)).size).toBe(1);
    expect(new Set(windowClaimCalls.map(([, memberKey]) => memberKey)).size).toBe(2);
  });

  it('sends greeting message for joined human members when greeting is enabled', async () => {
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings({
            greetingEnabled: true,
            greetingBotMessageEnabled: true,
            greetingBotMessageText: 'Добро пожаловать, {user}! {greeting}.',
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
    };

    const service = new ModerationService(
      prisma as never,
      ruleEngine as never,
      sanctionService as never,
      maxClient as never,
    );

    await service.handleUpdate(createServiceUserJoinedUpdate());

    expect(ruleEngine.detect).not.toHaveBeenCalled();
    expect(maxClient.sendMessage.mock.calls[0]?.[2]).toEqual(
      expect.objectContaining({
        marketplacePublication: { entityId: 'chat-1', purpose: 'GREETING' },
      }),
    );
    (expect(maxClient.sendMessage) as any).toHaveBeenCalledWithPrefix(
      'chat-1',
      `Добро пожаловать, ${userMentionHtml('Новый участник', 'user-black-2')}! добро пожаловать в чат.`,
    );
    expect(prisma.moderationEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        chatId: 'chat-1',
        userId: 'user-black-2',
        messageId: 'msg-service-user-join-1',
        ruleCode: 'GREETING_MESSAGE',
        action: SanctionAction.NONE,
        metadata: expect.objectContaining({
          reason: 'Greeting message accepted for delivery',
          deliveryStatus: 'accepted_for_delivery',
        }),
      }),
    });
  });

  it.each([0, 150])(
    'does not send greeting while night mode closes the chat (start=%s)',
    async (start) => {
      jest
        .useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] })
        .setSystemTime(new Date('2026-10-25T01:15:00Z'));
      try {
        const prisma = {
          chat: {
            upsert: jest.fn().mockResolvedValue({
              id: 'chat-1',
              title: 'Chat 1',
              settings: createSettings({
                greetingEnabled: true,
                greetingBotMessageEnabled: true,
                greetingBotMessageText: 'Добро пожаловать, {user}! {greeting}.',
                nightModeEnabled: true,
                nightModeStartTimeMinutes: start,
                nightModeEndTimeMinutes: start === 0 ? 0 : 480,
                nightModeTimezone: 'Europe/Berlin',
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
        };

        const service = new ModerationService(
          prisma as never,
          ruleEngine as never,
          sanctionService as never,
          maxClient as never,
        );

        await service.handleUpdate(createServiceUserJoinedUpdate());

        expect(maxClient.sendMessage).not.toHaveBeenCalled();
        expect(prisma.moderationEvent.create).not.toHaveBeenCalledWith({
          data: expect.objectContaining({
            ruleCode: 'GREETING_MESSAGE',
          }),
        });
      } finally {
        jest.useRealTimers();
      }
    },
  );

  it('does not send greeting while manual group close is active', async () => {
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings({
            greetingEnabled: true,
            greetingBotMessageEnabled: true,
            greetingBotMessageText: 'Добро пожаловать, {user}! {greeting}.',
            nightModeForceCloseEnabled: true,
            nightModeForceCloseForever: true,
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
    };

    const service = new ModerationService(
      prisma as never,
      ruleEngine as never,
      sanctionService as never,
      maxClient as never,
    );

    await service.handleUpdate(createServiceUserJoinedUpdate());

    expect(maxClient.sendMessage).not.toHaveBeenCalled();
    expect(prisma.moderationEvent.create).not.toHaveBeenCalledWith({
      data: expect.objectContaining({
        ruleCode: 'GREETING_MESSAGE',
      }),
    });
  });

  it('builds greeting mentions from first and last name when display_name is absent', () => {
    const service = new ModerationService({} as never, {} as never, {} as never, {} as never);

    const members = (service as any).extractHumanServiceMembers(
      createServiceUserJoinedUpdateWithSplitName(),
    );

    expect(members).toEqual([
      {
        userId: 'user-split-name-1',
        userLabel: userMention('Анна Каренина', 'user-split-name-1'),
      },
    ]);
  });

  it.each([
    { name: 'Анна', first_name: 'Анна', last_name: 'Каренина' },
    { nickname: 'Аня', firstName: 'Анна', lastName: 'Каренина' },
    { first_name: '', firstName: 'Анна', last_name: '', lastName: 'Каренина' },
  ])('keeps the full greeting mention with legacy or empty name aliases: %j', (nameFields) => {
    const service = new ModerationService({} as never, {} as never, {} as never, {} as never);
    const update = createServiceUserJoinedUpdateWithSplitName();
    (update.raw as any).message.body.new_members = [
      { user_id: 'user-split-name-1', type: 'user', ...nameFields },
    ];

    expect((service as any).extractHumanServiceMembers(update)).toEqual([
      {
        userId: 'user-split-name-1',
        userLabel: userMention('Анна Каренина', 'user-split-name-1'),
      },
    ]);
  });

  it('adds the rules button to greeting message when enabled', async () => {
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings({
            greetingEnabled: true,
            greetingBotMessageEnabled: true,
            greetingBotMessageText: 'Добро пожаловать, {user}! {greeting}.',
            greetingRulesButtonEnabled: true,
          }),
          rules: {
            publishedUrl: 'https://max.ru/chats/chat-1/message/999',
            publishedMessageId: '999',
          },
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
    };

    const service = new ModerationService(
      prisma as never,
      ruleEngine as never,
      sanctionService as never,
      maxClient as never,
    );

    await service.handleUpdate(createServiceUserJoinedUpdate());

    expect(maxClient.sendMessage).toHaveBeenCalledTimes(1);
    (expect(maxClient.sendMessage) as any).toHaveBeenCalledWithPrefix(
      'chat-1',
      `Добро пожаловать, ${userMentionHtml('Новый участник', 'user-black-2')}! добро пожаловать в чат.`,
      {
        button: {
          text: 'Правила',
          url: 'https://max.ru/chats/chat-1/message/999',
        },
        textFormat: 'html',
        marketplacePublication: { entityId: 'chat-1', purpose: 'GREETING' },
      },
    );
  });

  it('auto-deletes greeting message when greeting delete toggle is enabled', async () => {
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings({
            greetingEnabled: true,
            greetingBotMessageEnabled: true,
            greetingDeleteBotMessageEnabled: true,
            greetingDeleteBotMessageDelayMinutes: 0.5,
            greetingBotMessageText: 'Добро пожаловать, {user}! {greeting}.',
            deleteBotMessagesEnabled: false,
            deleteBotMessagesDelayMinutes: 5,
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
    };

    const service = new ModerationService(
      prisma as never,
      ruleEngine as never,
      sanctionService as never,
      maxClient as never,
    );

    await service.handleUpdate(createServiceUserJoinedUpdate());

    expect(maxClient.deleteMessage).not.toHaveBeenCalled();
    expect(maxClient.sendMessage).toHaveBeenCalledWith(
      'chat-1',
      expect.stringContaining(userMentionHtml('Новый участник', 'user-black-2')),
      expect.objectContaining({
        textFormat: 'html',
      }),
      expect.objectContaining({
        autoDeleteDelayMs: 30_000,
        trafficClass: 'background',
        actionHealthLane: 'background',
        sourceTag: 'moderation_notice',
        ignoreFailureMetricStatuses: [403, 404],
      }),
    );
    expect(prisma.moderationEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        chatId: 'chat-1',
        userId: 'user-black-2',
        ruleCode: 'GREETING_MESSAGE',
        metadata: expect.objectContaining({
          reason: 'Greeting message accepted for delivery',
          deliveryStatus: 'accepted_for_delivery',
        }),
      }),
    });
  });

  it('auto-deletes greeting message when global bot auto-delete is enabled', async () => {
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings({
            greetingEnabled: true,
            greetingBotMessageEnabled: true,
            greetingBotMessageText: 'Добро пожаловать, {user}! {greeting}.',
            deleteBotMessagesEnabled: true,
            deleteBotMessagesDelayMinutes: 2,
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
    };

    const service = new ModerationService(
      prisma as never,
      ruleEngine as never,
      sanctionService as never,
      maxClient as never,
    );

    await service.handleUpdate(createServiceUserJoinedUpdate());

    expect(maxClient.sendMessage).toHaveBeenCalledWith(
      'chat-1',
      `Добро пожаловать, ${userMentionHtml('Новый участник', 'user-black-2')}! добро пожаловать в чат.`,
      expect.objectContaining({
        textFormat: 'html',
      }),
      expect.objectContaining({
        autoDeleteDelayMs: 120_000,
        trafficClass: 'background',
        actionHealthLane: 'background',
        sourceTag: 'moderation_notice',
      }),
    );
    expect(maxClient.deleteMessage).not.toHaveBeenCalled();
    expect(prisma.moderationEvent.create).toHaveBeenCalledTimes(1);
    expect(prisma.moderationEvent.create).toHaveBeenNthCalledWith(1, {
      data: expect.objectContaining({
        chatId: 'chat-1',
        userId: 'user-black-2',
        messageId: 'msg-service-user-join-1',
        ruleCode: 'GREETING_MESSAGE',
        action: SanctionAction.NONE,
        metadata: expect.objectContaining({
          reason: 'Greeting message accepted for delivery',
          deliveryStatus: 'accepted_for_delivery',
        }),
      }),
    });
  });

  it('renders moderation markdown as safe HTML while preserving plain and prepared HTML text', async () => {
    const maxClient = {
      sendMessage: jest.fn(),
    };
    const service = new ModerationService(
      {} as never,
      {} as never,
      {} as never,
      maxClient as never,
    );
    const send = (text: string, messageOptions?: { textFormat: 'html' }) =>
      (service as any).sendBotMessageWithOptionalAutoDelete({
        chatId: 'chat-1',
        text,
        messageOptions,
        deleteBotMessagesEnabled: false,
        deleteBotMessagesDelayMinutes: 2,
      });

    await send('🔥[**_++MAX Docs++_**](https://dev.max.ru/docs-api)\n\n^^Фокус^^');
    await send('2 < 3 & 5');
    await send('<strong>Уже готово</strong>', { textFormat: 'html' });
    await send('&'.repeat(1_000));
    await expect(send('A'.repeat(4_001), { textFormat: 'html' })).rejects.toThrow(
      'MAX moderation notice exceeds 4000 characters after formatting',
    );

    expect(maxClient.sendMessage).toHaveBeenNthCalledWith(
      1,
      'chat-1',
      '🔥<a href="https://dev.max.ru/docs-api"><strong><em><u>MAX Docs</u></em></strong></a>\n\n<mark>Фокус</mark>',
      expect.objectContaining({ textFormat: 'html' }),
      expect.any(Object),
    );
    expect(maxClient.sendMessage).toHaveBeenNthCalledWith(
      2,
      'chat-1',
      '2 &lt; 3 &amp; 5',
      expect.objectContaining({ textFormat: 'html' }),
      expect.any(Object),
    );
    expect(maxClient.sendMessage).toHaveBeenNthCalledWith(
      3,
      'chat-1',
      '<strong>Уже готово</strong>',
      expect.objectContaining({ textFormat: 'html' }),
      expect.any(Object),
    );
    expect(maxClient.sendMessage).toHaveBeenNthCalledWith(
      4,
      'chat-1',
      '&'.repeat(1_000),
      expect.objectContaining({ textFormat: 'markdown' }),
      expect.any(Object),
    );
    expect(maxClient.sendMessage).toHaveBeenCalledTimes(4);
  });

  it('skips non-immediate bot notices after the per-chat notice bucket is exhausted', async () => {
    const maxClient = {
      sendMessage: jest.fn(),
    };
    const redisCounter = {
      incrementWithTtl: jest.fn().mockResolvedValueOnce(1).mockResolvedValueOnce(2),
    };
    const runtimeDiagnosticsService = {
      recordHotPathStageOutcome: jest.fn(),
    };
    const service = new ModerationService(
      {} as never,
      {} as never,
      {} as never,
      maxClient as never,
      undefined,
      undefined,
      {
        get: jest.fn((key: string, fallback?: unknown) =>
          key === 'BOT_NOTICE_TOKEN_BUCKET_LIMIT' ? 1 : fallback,
        ),
      } as never,
      redisCounter as never,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      runtimeDiagnosticsService as never,
    );

    await (service as any).sendBotMessageWithOptionalAutoDelete({
      chatId: 'chat-1',
      text: 'notice 1',
      deleteBotMessagesEnabled: false,
      deleteBotMessagesDelayMinutes: 2,
    });
    await (service as any).sendBotMessageWithOptionalAutoDelete({
      chatId: 'chat-1',
      text: 'notice 2',
      deleteBotMessagesEnabled: false,
      deleteBotMessagesDelayMinutes: 2,
    });

    expect(redisCounter.incrementWithTtl).toHaveBeenCalledWith(
      'moderation:bot-notice-bucket:v1:chat-1',
      60,
    );
    expect(maxClient.sendMessage).toHaveBeenCalledTimes(1);
    expect(maxClient.sendMessage).toHaveBeenCalledWith(
      'chat-1',
      'notice 1',
      expect.objectContaining({
        textFormat: 'html',
      }),
      expect.objectContaining({
        trafficClass: 'background',
        actionHealthLane: 'background',
        sourceTag: 'moderation_notice',
      }),
    );
    expect(runtimeDiagnosticsService.recordHotPathStageOutcome).toHaveBeenCalledWith({
      stage: 'bot-notice-token-bucket',
      outcome: 'skip',
      failOpen: false,
    });
  });

  it('routes user-facing sanction notices through the interactive lane without forcing immediate HTTP', async () => {
    const maxClient = {
      sendMessage: jest.fn(),
    };
    const redisCounter = {
      incrementWithTtl: jest.fn().mockResolvedValue(1_000_000),
    };
    const service = new ModerationService(
      {} as never,
      {} as never,
      {} as never,
      maxClient as never,
      undefined,
      undefined,
      undefined,
      redisCounter as never,
    );

    await (service as any).sendBotMessageWithOptionalAutoDelete({
      chatId: 'chat-1',
      text: 'Предупреждение',
      deleteBotMessagesEnabled: false,
      deleteBotMessagesDelayMinutes: 2,
      userFacing: true,
    });

    expect(maxClient.sendMessage).toHaveBeenCalledWith(
      'chat-1',
      'Предупреждение',
      expect.objectContaining({ textFormat: 'html' }),
      expect.objectContaining({
        trafficClass: 'interactive',
        actionHealthLane: 'interactive',
        sourceTag: 'moderation_notice',
        ignoreFailureMetricStatuses: [403, 404],
      }),
    );
    expect(maxClient.sendMessage.mock.calls[0]?.[3]).not.toHaveProperty('immediate');
    expect(redisCounter.incrementWithTtl).not.toHaveBeenCalled();
  });

  it('uploads bot speech media and attaches it to bot notices', async () => {
    const maxClient = {
      sendMessage: jest.fn(),
      uploadImage: jest.fn().mockResolvedValue({ token: 'bot-speech-image-1' }),
    };
    const service = new ModerationService(
      {} as never,
      {} as never,
      {} as never,
      maxClient as never,
    );

    await (service as any).sendBotMessageWithOptionalAutoDelete({
      chatId: 'chat-1',
      botId: 'id613002203036_4_bot',
      text: 'notice with image',
      media: {
        base64: Buffer.from('image-bytes').toString('base64'),
        mimeType: 'image/png',
        fileName: 'notice.png',
        fieldKey: 'messageLimitsBotMessageText',
      },
      deleteBotMessagesEnabled: false,
      deleteBotMessagesDelayMinutes: 2,
    });

    expect(maxClient.uploadImage).toHaveBeenCalledWith(
      Buffer.from('image-bytes'),
      'notice.png',
      'image/png',
      expect.objectContaining({
        trafficClass: 'background',
        actionHealthLane: 'background',
        sourceTag: 'moderation_notice',
        botId: 'id613002203036_4_bot',
      }),
    );
    expect(maxClient.sendMessage).toHaveBeenCalledWith(
      'chat-1',
      'notice with image',
      expect.objectContaining({
        imagePayload: { token: 'bot-speech-image-1' },
        textFormat: 'html',
      }),
      expect.objectContaining({
        trafficClass: 'background',
        actionHealthLane: 'background',
        sourceTag: 'moderation_notice',
        botId: 'id613002203036_4_bot',
      }),
    );
  });

  it('sends greeting message for service join event wrapped in data.message envelope', async () => {
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings({
            greetingEnabled: true,
            greetingBotMessageEnabled: true,
            greetingBotMessageText: 'Добро пожаловать, {user}! {greeting}.',
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
    };

    const service = new ModerationService(
      prisma as never,
      ruleEngine as never,
      sanctionService as never,
      maxClient as never,
    );

    await service.handleUpdate(createServiceUserJoinedUpdateInDataEnvelope());

    expect(ruleEngine.detect).not.toHaveBeenCalled();
    (expect(maxClient.sendMessage) as any).toHaveBeenCalledWithPrefix(
      'chat-1',
      `Добро пожаловать, ${userMentionHtml('Новый участник из data', 'user-envelope-2')}! добро пожаловать в чат.`,
    );
    expect(prisma.moderationEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        chatId: 'chat-1',
        userId: 'user-envelope-2',
        messageId: 'msg-service-user-join-envelope-1',
        ruleCode: 'GREETING_MESSAGE',
        action: SanctionAction.NONE,
      }),
    });
  });

  it('sends greeting message when service sender marker is absent but new_members exists', async () => {
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings({
            greetingEnabled: true,
            greetingBotMessageEnabled: true,
            greetingBotMessageText: 'Добро пожаловать, {user}! {greeting}.',
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
    };

    const service = new ModerationService(
      prisma as never,
      ruleEngine as never,
      sanctionService as never,
      maxClient as never,
    );

    await service.handleUpdate(createServiceUserJoinedUpdateWithoutServiceSender());

    expect(ruleEngine.detect).not.toHaveBeenCalled();
    (expect(maxClient.sendMessage) as any).toHaveBeenCalledWithPrefix(
      'chat-1',
      `Добро пожаловать, ${userMentionHtml('Новый участник без sender', 'user-no-sender-2')}! добро пожаловать в чат.`,
    );
    expect(prisma.moderationEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        chatId: 'chat-1',
        userId: 'user-no-sender-2',
        messageId: 'msg-service-user-join-no-sender-1',
        ruleCode: 'GREETING_MESSAGE',
        action: SanctionAction.NONE,
      }),
    });
  });

  it('greets the invited user from user_added instead of the inviter', async () => {
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings({
            greetingEnabled: true,
            greetingBotMessageEnabled: true,
            greetingBotMessageText: 'Добро пожаловать, {user}! {greeting}.',
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
    };

    const service = new ModerationService(
      prisma as never,
      ruleEngine as never,
      sanctionService as never,
      maxClient as never,
    );

    const update = createUserAddedUpdate();
    update.membership = {
      action: 'added',
      memberUserIds: ['user-added-1'],
      inviterId: 'admin-inviter-1',
    };
    update.raw = {
      ...(update.raw as Record<string, unknown>),
      user_id: 'admin-inviter-1',
      inviter_id: 'admin-inviter-1',
    };

    await service.handleUpdate(update);

    expect(ruleEngine.detect).not.toHaveBeenCalled();
    (expect(maxClient.sendMessage) as any).toHaveBeenCalledWithPrefix(
      'chat-1',
      `Добро пожаловать, ${userMentionHtml('Новый участник user_added', 'user-added-1')}! добро пожаловать в чат.`,
    );
    expect(prisma.moderationEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        chatId: 'chat-1',
        userId: 'user-added-1',
        messageId: 'user_added:upd-user-added-1',
        ruleCode: 'GREETING_MESSAGE',
        action: SanctionAction.NONE,
      }),
    });
    expect(maxClient.sendMessage.mock.calls[0]?.[1]).not.toContain('admin-inviter-1');
  });

  it('dedupes greeting messages for the same joined user across multiple bot deliveries', async () => {
    const claimedKeys = new Set<string>();
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings({
            greetingEnabled: true,
            greetingBotMessageEnabled: true,
            greetingBotMessageText: 'Добро пожаловать, {user}! {greeting}.',
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
      moderationViolationMessageClaim: {
        createMany: jest.fn(async (args: { data: Array<{ dedupeKey: string }> }) => {
          const dedupeKey = args.data[0]?.dedupeKey;
          if (!dedupeKey || claimedKeys.has(dedupeKey)) {
            return { count: 0 };
          }

          claimedKeys.add(dedupeKey);
          return { count: 1 };
        }),
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
    };
    const redisCounter = createRedisCounterMock();
    const service = new ModerationService(
      prisma as never,
      ruleEngine as never,
      sanctionService as never,
      maxClient as never,
      undefined,
      undefined,
      undefined,
      redisCounter as never,
    );
    const createdAtMs = new Date('2026-04-06T01:09:59.999Z').getTime();
    const createDeliveredJoinUpdate = (
      botId: string,
      updateId: string,
      offsetMs: number,
    ): MaxUpdate => {
      const createdAt = new Date(createdAtMs + offsetMs).toISOString();
      return {
        updateId,
        type: 'user_added',
        botId,
        message: {
          messageId: `user_added:${updateId}`,
          chatId: 'chat-1',
          senderId: 'user-added-1',
          senderName: 'Новый участник user_added',
          text: '',
          createdAt,
        },
        raw: {
          update_type: 'user_added',
          chat_id: 'chat-1',
          user: {
            user_id: 'user-added-1',
            type: 'user',
            display_name: 'Новый участник user_added',
          },
          timestamp: new Date(createdAt).getTime(),
        },
      };
    };

    await service.handleUpdate(createDeliveredJoinUpdate('bot-1', 'upd-user-added-bot-1', 0));
    await service.handleUpdate(createDeliveredJoinUpdate('bot-2', 'upd-user-added-bot-2', 1));
    await service.handleUpdate(createDeliveredJoinUpdate('bot-3', 'upd-user-added-bot-3', 2));

    expect(maxClient.sendMessage).toHaveBeenCalledTimes(1);
    expect(prisma.moderationEvent.create).toHaveBeenCalledTimes(1);
    expect(prisma.moderationViolationMessageClaim.createMany).toHaveBeenCalledTimes(1);
    const windowClaimCalls = redisCounter.incrementOncePerMemberWithTtl.mock.calls.filter(
      ([counterKey]) =>
        String(counterKey).startsWith(
          'moderation:service-member-action-window:v1:GREETING_MESSAGE:user_added',
        ),
    );
    expect(windowClaimCalls).toHaveLength(3);
    expect(new Set(windowClaimCalls.map(([, memberKey]) => memberKey)).size).toBe(1);
  });

  it('does not track invitation access progress while the invite gate is disabled', async () => {
    const progressRows = new Map<string, { invitedUserIds: string[]; completedAt: Date | null }>();
    const prismaRef: { current: unknown } = { current: null };
    const prisma = {
      $transaction: jest.fn(async (callback: (client: unknown) => Promise<unknown>) =>
        callback(prismaRef.current),
      ),
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings({
            invitationAccessEnabled: true,
            invitationAccessRequiredCount: 2,
            greetingEnabled: false,
          }),
          domains: [],
          admins: [],
        }),
      },
      chatInvitationAccessProgress: {
        findUnique: jest.fn(
          async ({ where }: { where: { chatId_userId: { chatId: string; userId: string } } }) => {
            const key = `${where.chatId_userId.chatId}:${where.chatId_userId.userId}`;
            return progressRows.get(key) ?? null;
          },
        ),
        create: jest.fn(
          async ({
            data,
          }: {
            data: {
              chatId: string;
              userId: string;
              invitedUserIds: string[];
              completedAt?: Date;
            };
          }) => {
            const row = {
              invitedUserIds: data.invitedUserIds,
              completedAt: data.completedAt ?? null,
            };
            progressRows.set(`${data.chatId}:${data.userId}`, row);
            return row;
          },
        ),
        update: jest.fn(),
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
    prismaRef.current = prisma;
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
    };

    const service = new ModerationService(
      prisma as never,
      ruleEngine as never,
      sanctionService as never,
      maxClient as never,
    );
    const update = {
      ...createUserAddedUpdate(),
      membership: {
        action: 'added' as const,
        memberUserIds: ['user-added-1'],
        inviterId: 'inviter-1',
      },
      raw: {
        ...createUserAddedUpdate().raw,
        inviter_id: 'inviter-1',
      },
    };

    await service.handleUpdate(update);

    expect(prisma.chatInvitationAccessProgress.create).not.toHaveBeenCalled();
    expect(prisma.moderationEvent.create).not.toHaveBeenCalled();
    expect(ruleEngine.detect).not.toHaveBeenCalled();
  });

  it('skips system mode lookup for user_added service events', async () => {
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings({
            greetingEnabled: true,
            greetingBotMessageEnabled: true,
            greetingBotMessageText: 'Добро пожаловать, {user}! {greeting}.',
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
    };
    const systemModeService = {
      getEffectiveSnapshot: jest.fn(),
    };

    const service = new ModerationService(
      prisma as never,
      ruleEngine as never,
      sanctionService as never,
      maxClient as never,
      undefined,
      systemModeService as never,
    );

    await service.handleUpdate(createUserAddedUpdate());

    expect(systemModeService.getEffectiveSnapshot).not.toHaveBeenCalled();
    expect(ruleEngine.detect).not.toHaveBeenCalled();
    (expect(maxClient.sendMessage) as any).toHaveBeenCalledWithPrefix(
      'chat-1',
      `Добро пожаловать, ${userMentionHtml('Новый участник user_added', 'user-added-1')}! добро пожаловать в чат.`,
    );
  });

  it.each(['chat_title_changed', 'bot_stopped', 'dialog_removed', 'message_removed'])(
    'treats %s updates as lifecycle no-ops for moderation',
    async (updateType) => {
      const prisma = {
        chat: {
          upsert: jest.fn(),
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
      };
      const systemModeService = {
        getEffectiveSnapshot: jest.fn(),
      };

      const service = new ModerationService(
        prisma as never,
        ruleEngine as never,
        sanctionService as never,
        maxClient as never,
        undefined,
        systemModeService as never,
      );

      await service.handleUpdate({
        updateId: `upd-${updateType}-1`,
        type: updateType,
        message: {
          messageId: `${updateType}:upd-${updateType}-1`,
          chatId: 'chat-1',
          chatTitle: 'Новый заголовок',
          senderId: 'actor-1',
          senderName: 'Админ',
          text: '',
          createdAt: new Date().toISOString(),
        },
        raw: {},
      });

      expect(systemModeService.getEffectiveSnapshot).not.toHaveBeenCalled();
      expect(prisma.chat.upsert).not.toHaveBeenCalled();
      expect(ruleEngine.detect).not.toHaveBeenCalled();
      expect(prisma.violation.create).not.toHaveBeenCalled();
      expect(prisma.moderationEvent.create).not.toHaveBeenCalled();
      expect(maxClient.deleteMessage).not.toHaveBeenCalled();
      expect(maxClient.sendMessage).not.toHaveBeenCalled();
      expect(maxClient.kickMember).not.toHaveBeenCalled();
      expect(maxClient.banMember).not.toHaveBeenCalled();
      expect(maxClient.notifyModerators).not.toHaveBeenCalled();
    },
  );

  it('invalidates user_removed membership only after shared-chat execution is allowed', async () => {
    const prisma = {
      chat: {
        upsert: jest.fn(),
        findMany: jest.fn().mockResolvedValue([
          {
            id: '-70000000000001',
            title: 'Тестовый чат 1',
          },
          {
            id: '-70000000000002',
            title: 'Тестовый чат 2',
          },
        ]),
      },
      violation: {
        create: jest.fn(),
      },
      moderationEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
      webhookEvent: {
        findFirst: jest
          .fn()
          .mockResolvedValueOnce({ id: 'owner-user-removed-event' })
          .mockResolvedValue(null),
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
    };
    const membershipLookupService = {
      invalidateMemberships: jest.fn().mockResolvedValue(undefined),
    };
    const maxBotLinkService = {
      getChatExecutionBinding: jest.fn(),
    };
    const maxBotContextService = {
      getActiveBotId: jest.fn().mockReturnValue('bot-standby'),
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
      membershipLookupService as never,
      maxBotLinkService as never,
      maxBotContextService as never,
    );
    const acquireSharedChatExecutionLock = jest.spyOn(
      service as any,
      'acquireSharedChatExecutionLock',
    );
    const releaseSharedChatExecutionLock = jest.spyOn(
      service as any,
      'releaseSharedChatExecutionLock',
    );
    const createMembershipUpdate = (updateId: string, memberUserId: string) =>
      ({
        ...createUserRemovedUpdate(),
        updateId,
        botId: maxBotContextService.getActiveBotId(),
        executionOwnerBotId: 'bot-owner',
        membership: {
          action: 'removed',
          memberUserIds: [memberUserId],
        },
      }) as MaxUpdate & { executionOwnerBotId: string };

    await service.handleUpdate(createMembershipUpdate('upd-user-removed-mirror', 'mirror-user'));

    expect(membershipLookupService.invalidateMemberships).not.toHaveBeenCalled();
    expect(acquireSharedChatExecutionLock).not.toHaveBeenCalled();
    expect(releaseSharedChatExecutionLock).not.toHaveBeenCalled();

    await service.handleUpdate(
      createMembershipUpdate('upd-user-removed-recovery', 'standby-recovery-user'),
    );

    expect(membershipLookupService.invalidateMemberships).toHaveBeenCalledWith('chat-1', [
      'standby-recovery-user',
    ]);
    expect(acquireSharedChatExecutionLock).toHaveBeenCalledTimes(1);
    expect(releaseSharedChatExecutionLock).toHaveBeenCalledTimes(1);
    expect(acquireSharedChatExecutionLock.mock.invocationCallOrder[0]).toBeLessThan(
      membershipLookupService.invalidateMemberships.mock.invocationCallOrder[0]!,
    );
    expect(membershipLookupService.invalidateMemberships.mock.invocationCallOrder[0]).toBeLessThan(
      releaseSharedChatExecutionLock.mock.invocationCallOrder[0]!,
    );

    maxBotContextService.getActiveBotId.mockReturnValue('bot-owner');
    await service.handleUpdate(
      createMembershipUpdate('upd-user-removed-owner', 'canonical-owner-user'),
    );

    expect(membershipLookupService.invalidateMemberships).toHaveBeenNthCalledWith(2, 'chat-1', [
      'canonical-owner-user',
    ]);
    expect(prisma.chat.upsert).not.toHaveBeenCalled();
    expect(ruleEngine.detect).not.toHaveBeenCalled();
    expect(prisma.violation.create).not.toHaveBeenCalled();
    expect(prisma.moderationEvent.create).not.toHaveBeenCalled();
    expect(maxClient.deleteMessage).not.toHaveBeenCalled();
    expect(maxClient.sendMessage).not.toHaveBeenCalled();
    expect(maxClient.kickMember).not.toHaveBeenCalled();
    expect(maxClient.banMember).not.toHaveBeenCalled();
    expect(maxClient.notifyModerators).not.toHaveBeenCalled();
  });

  it('skips moderation flow for bot_removed update', async () => {
    const prisma = {
      chat: {
        upsert: jest.fn(),
        findMany: jest.fn().mockResolvedValue([
          {
            id: '-70000000000001',
            title: 'Тестовый чат 1',
          },
          {
            id: '-70000000000002',
            title: 'Тестовый чат 2',
          },
        ]),
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
    };

    const service = new ModerationService(
      prisma as never,
      ruleEngine as never,
      sanctionService as never,
      maxClient as never,
    );

    await service.handleUpdate(createBotRemovedUpdate());

    expect(prisma.chat.upsert).not.toHaveBeenCalled();
    expect(ruleEngine.detect).not.toHaveBeenCalled();
    expect(prisma.violation.create).not.toHaveBeenCalled();
    expect(prisma.moderationEvent.create).not.toHaveBeenCalled();
    expect(maxClient.deleteMessage).not.toHaveBeenCalled();
    expect(maxClient.sendMessage).not.toHaveBeenCalled();
    expect(maxClient.kickMember).not.toHaveBeenCalled();
    expect(maxClient.banMember).not.toHaveBeenCalled();
    expect(maxClient.notifyModerators).not.toHaveBeenCalled();
  });

  it('opens private menu for personal bot_started update and skips moderation flow', async () => {
    const prisma = {
      chat: {
        upsert: jest.fn(),
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
    };

    const service = new ModerationService(
      prisma as never,
      ruleEngine as never,
      sanctionService as never,
      maxClient as never,
    );

    await service.handleUpdate(createBotStartedPrivateUpdate());

    expect(maxClient.sendMessage).toHaveBeenCalledWith(
      '152517912',
      expect.stringContaining('Майор Максимов'),
      expect.objectContaining({
        buttons: expect.any(Array),
      }),
      {
        ignoreFailureMetricStatuses: [403, 404],
      },
    );
    expect(maxClient.sendMessage).toHaveBeenCalledWith(
      '152517912',
      expect.stringContaining(USER_AGREEMENT_SHORT_NOTICE),
      expect.objectContaining({
        buttons: expect.any(Array),
        textFormat: 'markdown',
      }),
      {
        ignoreFailureMetricStatuses: [403, 404],
      },
    );
    expect(maxClient.sendMessage).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining('розыгрыш'),
      expect.anything(),
      expect.anything(),
    );
    expect(ruleEngine.detect).not.toHaveBeenCalled();
    expect(prisma.chat.upsert).not.toHaveBeenCalled();
    expect(prisma.violation.create).not.toHaveBeenCalled();
    expect(prisma.moderationEvent.create).not.toHaveBeenCalled();
  });

  it('skips the long instruction for broadcast handoff bot_started update', async () => {
    const prisma = {
      chat: {
        upsert: jest.fn(),
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
    };
    const privateControlService = {
      handleBotStarted: jest.fn().mockResolvedValue(undefined),
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
      privateControlService as never,
    );

    const update = createBotStartedPrivateHandoffUpdate();

    await service.handleUpdate(update);

    expect(maxClient.sendMessage).not.toHaveBeenCalled();
    expect(privateControlService.handleBotStarted).toHaveBeenCalledWith(update);
    expect(ruleEngine.detect).not.toHaveBeenCalled();
    expect(prisma.chat.upsert).not.toHaveBeenCalled();
    expect(prisma.violation.create).not.toHaveBeenCalled();
    expect(prisma.moderationEvent.create).not.toHaveBeenCalled();
  });

  it('skips the long instruction for giveaway handoff bot_started update', async () => {
    const prisma = {
      chat: {
        upsert: jest.fn(),
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
    };
    const privateControlService = {
      handleBotStarted: jest.fn().mockResolvedValue(undefined),
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
      privateControlService as never,
    );

    const update = createBotStartedPrivateHandoffUpdate('ggh-test-payload');

    await service.handleUpdate(update);

    expect(maxClient.sendMessage).not.toHaveBeenCalled();
    expect(privateControlService.handleBotStarted).toHaveBeenCalledWith(update);
    expect(ruleEngine.detect).not.toHaveBeenCalled();
    expect(prisma.chat.upsert).not.toHaveBeenCalled();
    expect(prisma.violation.create).not.toHaveBeenCalled();
    expect(prisma.moderationEvent.create).not.toHaveBeenCalled();
  });

  it('does not send instruction for group bot_started update and skips moderation flow', async () => {
    const prisma = {
      chat: {
        upsert: jest.fn(),
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
    };

    const service = new ModerationService(
      prisma as never,
      ruleEngine as never,
      sanctionService as never,
      maxClient as never,
    );

    await service.handleUpdate(createBotStartedGroupUpdate());

    expect(maxClient.sendMessage).not.toHaveBeenCalled();
    expect(ruleEngine.detect).not.toHaveBeenCalled();
    expect(prisma.chat.upsert).not.toHaveBeenCalled();
    expect(prisma.violation.create).not.toHaveBeenCalled();
    expect(prisma.moderationEvent.create).not.toHaveBeenCalled();
  });

  it('handles /menu in private chat without moderation flow', async () => {
    const prisma = {
      chat: {
        upsert: jest.fn(),
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
      answerCallback: jest.fn(),
      listBotChats: jest.fn(),
    };

    const service = new ModerationService(
      prisma as never,
      ruleEngine as never,
      sanctionService as never,
      maxClient as never,
      undefined,
      undefined,
      {
        get: jest.fn((key: string) => {
          if (key === 'MAX_BOT_ID') {
            return '777000_bot';
          }

          if (key === 'APP_BASE_URL') {
            return 'https://major-maksimov.ru';
          }

          return undefined;
        }),
      } as never,
    );

    await service.handleUpdate(createPrivateCommandUpdate('/menu'));

    expect(maxClient.sendMessage).toHaveBeenCalledWithPrefix(
      '152517912',
      expect.stringContaining('Майор Максимов'),
      expect.objectContaining({
        buttons: expect.any(Array),
      }),
    );
    expect(maxClient.sendMessage).toHaveBeenCalledWithPrefix(
      '152517912',
      expect.any(String),
      expect.objectContaining({
        buttons: expect.arrayContaining([
          expect.arrayContaining([
            expect.objectContaining({ type: 'callback', text: 'Чаты' }),
            expect.objectContaining({ type: 'callback', text: 'Каналы' }),
          ]),
          expect.arrayContaining([
            expect.objectContaining({
              type: 'link',
              text: 'Открыть приложение',
              url: expect.stringContaining('https://max.ru/777000_bot?startapp='),
            }),
          ]),
        ]),
      }),
    );
    expect(prisma.chat.upsert).not.toHaveBeenCalled();
    expect(ruleEngine.detect).not.toHaveBeenCalled();
    expect(prisma.violation.create).not.toHaveBeenCalled();
    expect(prisma.moderationEvent.create).not.toHaveBeenCalled();
  });

  it('handles plain text in private chat and returns menu', async () => {
    const prisma = {
      chat: {
        upsert: jest.fn(),
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
      answerCallback: jest.fn(),
      listBotChats: jest.fn(),
    };

    const service = new ModerationService(
      prisma as never,
      ruleEngine as never,
      sanctionService as never,
      maxClient as never,
    );

    await service.handleUpdate(createPrivateCommandUpdate('привет'));

    expect(maxClient.sendMessage).toHaveBeenCalledWithPrefix(
      '152517912',
      expect.stringContaining('Майор Максимов'),
      expect.objectContaining({
        buttons: expect.any(Array),
      }),
    );
    expect(prisma.chat.upsert).not.toHaveBeenCalled();
    expect(ruleEngine.detect).not.toHaveBeenCalled();
    expect(prisma.violation.create).not.toHaveBeenCalled();
    expect(prisma.moderationEvent.create).not.toHaveBeenCalled();
  });

  it('fails open when fallback private menu delivery hits a terminal MAX error', async () => {
    const prisma = {
      chat: {
        upsert: jest.fn(),
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
      sendMessage: jest
        .fn()
        .mockRejectedValue(
          createMaxApiError(404, 'Request failed with status code 404', 'chat.not.found'),
        ),
      kickMember: jest.fn(),
      banMember: jest.fn(),
      notifyModerators: jest.fn(),
      answerCallback: jest.fn(),
      listBotChats: jest.fn(),
    };

    const service = new ModerationService(
      prisma as never,
      ruleEngine as never,
      sanctionService as never,
      maxClient as never,
    );

    await expect(
      service.handleUpdate(createPrivateCommandUpdate('привет')),
    ).resolves.toBeUndefined();

    expect(maxClient.sendMessage).toHaveBeenCalledWith(
      '152517912',
      expect.stringContaining('Майор Максимов'),
      expect.objectContaining({
        buttons: expect.any(Array),
      }),
      {
        ignoreFailureMetricStatuses: [403, 404],
      },
    );
    expect(prisma.chat.upsert).not.toHaveBeenCalled();
    expect(ruleEngine.detect).not.toHaveBeenCalled();
    expect(prisma.violation.create).not.toHaveBeenCalled();
    expect(prisma.moderationEvent.create).not.toHaveBeenCalled();
  });

  it('handles attachment-only message in private chat and returns menu', async () => {
    const prisma = {
      chat: {
        upsert: jest.fn(),
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
      answerCallback: jest.fn(),
      listBotChats: jest.fn(),
    };

    const service = new ModerationService(
      prisma as never,
      ruleEngine as never,
      sanctionService as never,
      maxClient as never,
    );

    await service.handleUpdate(createPrivateCommandUpdate(''));

    expect(maxClient.sendMessage).toHaveBeenCalledWithPrefix(
      '152517912',
      expect.stringContaining('Майор Максимов'),
      expect.objectContaining({
        buttons: expect.any(Array),
      }),
    );
    expect(prisma.chat.upsert).not.toHaveBeenCalled();
    expect(ruleEngine.detect).not.toHaveBeenCalled();
    expect(prisma.violation.create).not.toHaveBeenCalled();
    expect(prisma.moderationEvent.create).not.toHaveBeenCalled();
  });

  it('handles callback menu command in private chat and returns chats list', async () => {
    const prisma = {
      chat: {
        upsert: jest.fn(),
        findMany: jest.fn().mockResolvedValue([
          {
            id: '-70000000000001',
            title: 'Тестовый чат 1',
          },
          {
            id: '-70000000000002',
            title: 'Тестовый чат 2',
          },
        ]),
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
      answerCallback: jest.fn(),
      listBotChats: jest.fn(),
    };

    const service = new ModerationService(
      prisma as never,
      ruleEngine as never,
      sanctionService as never,
      maxClient as never,
    );

    await service.handleUpdate(createPrivateCallbackUpdate('private_menu:chats'));

    expect(maxClient.answerCallback).toHaveBeenCalledWith(
      'callback-1',
      'Собираю список чатов',
      undefined,
      {
        ignoreFailureMetricStatuses: [400, 404],
        rateLimitEntityId: '152517912',
      },
    );
    expect(maxClient.listBotChats).not.toHaveBeenCalled();
    expect(prisma.chat.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          catalogKind: 'MANAGED',
          entityType: 'CHAT',
          id: { startsWith: '-' },
          botMemberships: {
            some: {
              status: 'ACTIVE',
            },
          },
        }),
      }),
    );
    expect(maxClient.sendMessage).toHaveBeenCalledWith(
      '152517912',
      expect.stringContaining('Чаты с ботом: 2'),
      expect.objectContaining({
        buttons: expect.any(Array),
      }),
      {
        ignoreFailureMetricStatuses: [403, 404],
      },
    );
    expect(prisma.chat.upsert).not.toHaveBeenCalled();
    expect(ruleEngine.detect).not.toHaveBeenCalled();
    expect(prisma.violation.create).not.toHaveBeenCalled();
    expect(prisma.moderationEvent.create).not.toHaveBeenCalled();
  });

  it.each([
    ['UNBAN', SanctionAction.BAN, 'Блокировка снята'],
    ['UNMUTE', SanctionAction.MUTE, 'Мут снят'],
  ] as const)(
    'allows a current chat admin to apply %s from a sanction notice',
    async (action, sanctionAction, notification) => {
      const sanctionEventId = `sanction-event-${action.toLowerCase()}`;
      const prisma = {
        moderationEvent: {
          findUnique: jest.fn().mockResolvedValue({
            id: sanctionEventId,
            chatId: 'chat-1',
            userId: 'Target-User-ABC',
            action: sanctionAction,
            ruleCode: action === 'UNBAN' ? 'AUTO_BAN' : 'AUTO_MUTE',
            metadata: action === 'UNMUTE' ? { mutePermanent: true } : {},
            createdAt: new Date('2026-08-04T12:00:00.000Z'),
          }),
          findFirst: jest.fn().mockResolvedValue({
            id: sanctionEventId,
          }),
        },
      };
      const maxClient = {
        getChatMemberAccess: jest.fn().mockResolvedValue({
          userId: 'admin-1',
          isAdmin: true,
          isOwner: false,
          permissions: [],
        }),
        answerCallback: jest.fn().mockResolvedValue(undefined),
      };
      const manualBridge = {
        applyManualModerationAction: jest.fn().mockResolvedValue({
          ok: true,
          action,
          userId: 'Target-User-ABC',
          muteDurationHours: null,
          muteExpiresAt: null,
          message: notification,
        }),
      };
      const service = createModerationServiceWithManualBridge({
        prisma,
        ruleEngine: {},
        sanctionService: {},
        maxClient,
        manualBridge,
      });

      await service.handleUpdate(
        createModerationReleaseCallbackUpdate({
          action,
          sanctionEventId,
        }),
      );

      expect(maxClient.getChatMemberAccess).toHaveBeenCalledWith('chat-1', 'admin-1', {
        bypassCache: true,
        trafficClass: 'critical',
        actionHealthLane: 'critical',
        sourceTag: 'moderation_sanction',
        botId: 'bot-1',
      });
      expect(prisma.moderationEvent.findUnique).toHaveBeenCalledWith({
        where: { id: sanctionEventId },
        select: {
          id: true,
          chatId: true,
          userId: true,
          action: true,
          ruleCode: true,
          metadata: true,
          createdAt: true,
        },
      });
      expect(prisma.moderationEvent.findFirst).toHaveBeenCalledWith({
        where: {
          chatId: 'chat-1',
          userId: 'Target-User-ABC',
          OR: [
            { action: { in: [SanctionAction.BAN, SanctionAction.MUTE] } },
            { ruleCode: { in: ['MANUAL_UNBAN', 'MANUAL_UNMUTE'] } },
          ],
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        select: {
          id: true,
        },
      });
      expect(manualBridge.applyManualModerationAction).toHaveBeenCalledWith(
        'chat-1',
        'Target-User-ABC',
        expect.objectContaining({
          userId: 'admin-1',
          launchBotId: 'bot-1',
          chatId: 'chat-1',
        }),
        { action },
        'group_command',
        {
          actorAlreadyVerified: true,
          allowTargetDisplayNameRemoteLookup: false,
          expectedSanctionEventId: sanctionEventId,
          ...(action === 'UNBAN' ? { attemptUnbanWithRemove: true } : {}),
        },
      );
      expect(maxClient.answerCallback).toHaveBeenCalledWith(
        'callback-release-1',
        notification,
        undefined,
        {
          ignoreFailureMetricStatuses: [400, 404],
          botId: 'bot-1',
          rateLimitEntityId: 'chat-1',
        },
      );
    },
  );

  it('silently ignores a moderation release click from a regular chat member', async () => {
    const prisma = {
      moderationEvent: {
        findUnique: jest.fn(),
        findFirst: jest.fn(),
      },
    };
    const maxClient = {
      getChatMemberAccess: jest.fn().mockResolvedValue({
        userId: 'member-1',
        isAdmin: false,
        isOwner: false,
        permissions: [],
      }),
      answerCallback: jest.fn().mockResolvedValue(undefined),
    };
    const manualBridge = {
      applyManualModerationAction: jest.fn(),
    };
    const service = createModerationServiceWithManualBridge({
      prisma,
      ruleEngine: {},
      sanctionService: {},
      maxClient,
      manualBridge,
    });

    await service.handleUpdate(
      createModerationReleaseCallbackUpdate({ action: 'UNBAN', actorUserId: 'member-1' }),
    );

    expect(prisma.moderationEvent.findUnique).not.toHaveBeenCalled();
    expect(prisma.moderationEvent.findFirst).not.toHaveBeenCalled();
    expect(manualBridge.applyManualModerationAction).not.toHaveBeenCalled();
    expect(maxClient.answerCallback).toHaveBeenCalledWith(
      'callback-release-1',
      undefined,
      undefined,
      {
        ignoreFailureMetricStatuses: [400, 404],
        botId: 'bot-1',
        rateLimitEntityId: 'chat-1',
      },
    );
  });

  it('fails closed for a missing callback actor', async () => {
    const prisma = {
      moderationEvent: {
        findUnique: jest.fn(),
        findFirst: jest.fn(),
      },
    };
    const maxClient = {
      getChatMemberAccess: jest.fn(),
      answerCallback: jest.fn().mockResolvedValue(undefined),
    };
    const manualBridge = {
      applyManualModerationAction: jest.fn(),
    };
    const service = createModerationServiceWithManualBridge({
      prisma,
      ruleEngine: {},
      sanctionService: {},
      maxClient,
      manualBridge,
    });

    await service.handleUpdate(
      createModerationReleaseCallbackUpdate({
        action: 'UNMUTE',
        actorUserId: null,
      }),
    );

    expect(maxClient.getChatMemberAccess).not.toHaveBeenCalled();
    expect(prisma.moderationEvent.findUnique).not.toHaveBeenCalled();
    expect(prisma.moderationEvent.findFirst).not.toHaveBeenCalled();
    expect(manualBridge.applyManualModerationAction).not.toHaveBeenCalled();
    expect(maxClient.answerCallback).toHaveBeenCalledWith(
      'callback-release-1',
      undefined,
      undefined,
      {
        ignoreFailureMetricStatuses: [400, 404],
        botId: 'bot-1',
        rateLimitEntityId: 'chat-1',
      },
    );
  });

  it('fails closed when a sanction event belongs to another chat', async () => {
    const prisma = {
      moderationEvent: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'sanction-event-other-chat',
          chatId: 'chat-2',
          userId: 'Target-User-1',
          action: SanctionAction.MUTE,
          ruleCode: 'AUTO_MUTE',
          metadata: { mutePermanent: true },
          createdAt: new Date('2026-08-04T12:00:00.000Z'),
        }),
        findFirst: jest.fn(),
      },
    };
    const maxClient = {
      getChatMemberAccess: jest.fn().mockResolvedValue({
        userId: 'admin-1',
        isAdmin: true,
        isOwner: false,
        permissions: [],
      }),
      answerCallback: jest.fn().mockResolvedValue(undefined),
    };
    const manualBridge = {
      applyManualModerationAction: jest.fn(),
    };
    const service = createModerationServiceWithManualBridge({
      prisma,
      ruleEngine: {},
      sanctionService: {},
      maxClient,
      manualBridge,
    });

    await service.handleUpdate(
      createModerationReleaseCallbackUpdate({
        action: 'UNMUTE',
        sanctionEventId: 'sanction-event-other-chat',
        messageChatId: 'chat-1',
      }),
    );

    expect(maxClient.getChatMemberAccess).toHaveBeenCalledWith(
      'chat-1',
      'admin-1',
      expect.any(Object),
    );
    expect(prisma.moderationEvent.findFirst).not.toHaveBeenCalled();
    expect(manualBridge.applyManualModerationAction).not.toHaveBeenCalled();
    expect(maxClient.answerCallback).toHaveBeenCalledWith(
      'callback-release-1',
      'Санкция уже снята или изменилась',
      undefined,
      {
        ignoreFailureMetricStatuses: [400, 404],
        botId: 'bot-1',
        rateLimitEntityId: 'chat-1',
      },
    );
  });

  it('does not let an old ban button release a newer mute', async () => {
    const prisma = {
      moderationEvent: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'old-ban-event',
          chatId: 'chat-1',
          userId: 'Target-User-1',
          action: SanctionAction.BAN,
          ruleCode: 'AUTO_BAN',
          metadata: {},
          createdAt: new Date('2026-08-04T12:00:00.000Z'),
        }),
        findFirst: jest.fn().mockResolvedValue({
          id: 'newer-mute-event',
        }),
      },
    };
    const maxClient = {
      getChatMemberAccess: jest.fn().mockResolvedValue({
        userId: 'admin-1',
        isAdmin: true,
        isOwner: false,
        permissions: [],
      }),
      answerCallback: jest.fn().mockResolvedValue(undefined),
    };
    const manualBridge = {
      applyManualModerationAction: jest.fn(),
    };
    const service = createModerationServiceWithManualBridge({
      prisma,
      ruleEngine: {},
      sanctionService: {},
      maxClient,
      manualBridge,
    });

    await service.handleUpdate(
      createModerationReleaseCallbackUpdate({
        action: 'UNBAN',
        sanctionEventId: 'old-ban-event',
      }),
    );

    expect(manualBridge.applyManualModerationAction).not.toHaveBeenCalled();
    expect(maxClient.answerCallback).toHaveBeenCalledWith(
      'callback-release-1',
      'Санкция уже снята или изменилась',
      undefined,
      {
        ignoreFailureMetricStatuses: [400, 404],
        botId: 'bot-1',
        rateLimitEntityId: 'chat-1',
      },
    );
  });

  it('does not apply the same release action twice', async () => {
    let active = true;
    const sanctionEventId = 'sanction-event-ban-once';
    const prisma = {
      moderationEvent: {
        findUnique: jest.fn().mockResolvedValue({
          id: sanctionEventId,
          chatId: 'chat-1',
          userId: 'Target-User-1',
          action: SanctionAction.BAN,
          ruleCode: 'AUTO_BAN',
          metadata: {},
          createdAt: new Date('2026-08-04T12:00:00.000Z'),
        }),
        findFirst: jest
          .fn()
          .mockImplementation(async () =>
            active ? { id: sanctionEventId } : { id: 'manual-unban-event' },
          ),
      },
    };
    const maxClient = {
      getChatMemberAccess: jest.fn().mockResolvedValue({
        userId: 'admin-1',
        isAdmin: false,
        isOwner: true,
        permissions: [],
      }),
      answerCallback: jest.fn().mockResolvedValue(undefined),
    };
    const manualBridge = {
      applyManualModerationAction: jest.fn().mockImplementation(async () => {
        active = false;
        return {
          ok: true,
          action: 'UNBAN',
          userId: 'Target-User-1',
          muteDurationHours: null,
          muteExpiresAt: null,
          message: 'Блокировка снята',
        };
      }),
    };
    const service = createModerationServiceWithManualBridge({
      prisma,
      ruleEngine: {},
      sanctionService: {},
      maxClient,
      manualBridge,
    });

    await service.handleUpdate(
      createModerationReleaseCallbackUpdate({
        action: 'UNBAN',
        sanctionEventId,
        callbackId: 'callback-release-1',
      }),
    );
    await service.handleUpdate(
      createModerationReleaseCallbackUpdate({
        action: 'UNBAN',
        sanctionEventId,
        callbackId: 'callback-release-2',
        updateId: 'upd-release-2',
      }),
    );

    expect(manualBridge.applyManualModerationAction).toHaveBeenCalledTimes(1);
    expect(maxClient.answerCallback).toHaveBeenLastCalledWith(
      'callback-release-2',
      'Санкция уже снята или изменилась',
      undefined,
      {
        ignoreFailureMetricStatuses: [400, 404],
        botId: 'bot-1',
        rateLimitEntityId: 'chat-1',
      },
    );
  });

  it('does not send greeting message when greeting toggle is disabled', async () => {
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings({
            greetingEnabled: false,
            greetingBotMessageEnabled: true,
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
    };

    const service = new ModerationService(
      prisma as never,
      ruleEngine as never,
      sanctionService as never,
      maxClient as never,
    );

    await service.handleUpdate(createServiceUserJoinedUpdate());

    expect(ruleEngine.detect).not.toHaveBeenCalled();
    expect(maxClient.sendMessage).not.toHaveBeenCalled();
    expect(prisma.moderationEvent.create).not.toHaveBeenCalled();
  });

  it('keeps sending greeting messages during join bursts', async () => {
    const redisCounter = createRedisCounterMock();
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings({
            greetingEnabled: true,
            greetingBotMessageEnabled: true,
            greetingBotMessageText: 'Добро пожаловать, {user}! {greeting}.',
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
    };

    const service = new ModerationService(
      prisma as never,
      ruleEngine as never,
      sanctionService as never,
      maxClient as never,
      undefined,
      undefined,
      undefined,
      redisCounter as never,
    );

    for (let index = 1; index <= 8; index += 1) {
      await service.handleUpdate(createUserAddedUpdateWithSuffix(index));
    }

    expect(maxClient.sendMessage).toHaveBeenCalledTimes(8);
    expect(redisCounter.incrementWithTtl).not.toHaveBeenCalled();
  });

  it('ignores stale hidden greeting auto-disable state', async () => {
    const redisCounter = {
      getString: jest.fn().mockResolvedValue('2026-03-18T10:00:00.000Z'),
      incrementByWithTtl: jest.fn(),
      setStringWithTtl: jest.fn(),
    };
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings({
            greetingEnabled: true,
            greetingBotMessageEnabled: true,
            greetingBotMessageText: 'Добро пожаловать, {user}! {greeting}.',
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
    };

    const service = new ModerationService(
      prisma as never,
      ruleEngine as never,
      sanctionService as never,
      maxClient as never,
      undefined,
      undefined,
      undefined,
      redisCounter as never,
    );

    await service.handleUpdate(createUserAddedUpdateWithSuffix('blocked'));

    expect(redisCounter.getString).not.toHaveBeenCalled();
    expect(redisCounter.incrementByWithTtl).not.toHaveBeenCalled();
    expect(maxClient.sendMessage).toHaveBeenCalledTimes(1);
    expect(prisma.moderationEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        chatId: 'chat-1',
        userId: 'user-added-blocked',
        messageId: 'user_added:upd-user-added-blocked',
        ruleCode: 'GREETING_MESSAGE',
        action: SanctionAction.NONE,
      }),
    });
  });

  it('kicks and deletes message from globally blacklisted sender when toggle is enabled', async () => {
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings({
            deleteSpammersEnabled: true,
            greetingEnabled: true,
            greetingBotMessageEnabled: true,
            greetingBotMessageText: 'Добро пожаловать, {user}! {greeting}.',
          }),
          domains: [],
          admins: [],
        }),
      },
      globalSpammer: {
        findUnique: jest.fn().mockResolvedValue({ userId: 'user-1' }),
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
    };

    const service = new ModerationService(
      prisma as never,
      ruleEngine as never,
      sanctionService as never,
      maxClient as never,
    );
    installStateDeleteExecutorFixture(service);
    const ensureDeleteIntent = jest
      .spyOn(service as any, 'ensureModerationDeleteIntent')
      .mockResolvedValue(undefined);
    const update = createUpdate();
    update.message!.createdAt = new Date().toISOString();

    await service.handleUpdate(update);

    expect(ruleEngine.detect).not.toHaveBeenCalled();
    expect(prisma.violation.create).not.toHaveBeenCalled();
    expectImmediateDeleteMessage(maxClient.deleteMessage, 'chat-1', 'msg-1');
    expectImmediateKickMember(maxClient.kickMember, 'chat-1', 'user-1');
    expect(ensureDeleteIntent).toHaveBeenCalledWith(
      expect.objectContaining({
        ruleCode: 'GLOBAL_SPAMMER_MESSAGE_DELETE',
        sourceMessageAt: update.message!.createdAt,
      }),
    );
    expect(prisma.moderationEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        chatId: 'chat-1',
        userId: 'user-1',
        messageId: 'msg-1',
        ruleCode: 'GLOBAL_SPAMMER_KICK',
        action: SanctionAction.KICK,
      }),
    });
  });

  it('does not read or enforce developer-forced blacklist when spammer deletion is disabled', async () => {
    const expiresAt = new Date(Date.now() + 60_000);
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings({ deleteSpammersEnabled: false }),
          domains: [],
          admins: [{ userId: 'owner-1' }],
        }),
      },
      globalSpammer: {
        findMany: jest.fn().mockResolvedValue([
          {
            userId: 'user-1',
            expiresAt,
            sourceBreakdown: {
              DEVELOPER_FORCED: {
                score: 1,
                count: 1,
                reasons: ['По решению разработчика бота за нарушение правил'],
              },
            },
          },
        ]),
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
      detect: jest.fn().mockResolvedValue({ violations: [] }),
      hasCommercialSpamMarkers: jest.fn().mockReturnValue(false),
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
    const redisCounter = {
      getString: jest.fn().mockResolvedValue(null),
      setStringWithTtl: jest.fn().mockResolvedValue(undefined),
      addToSetWithTtl: jest.fn().mockResolvedValue({ added: true, size: 1 }),
      incrementWithTtl: jest.fn().mockResolvedValue(1),
    };

    const service = new ModerationService(
      prisma as never,
      ruleEngine as never,
      sanctionService as never,
      maxClient as never,
      undefined,
      undefined,
      undefined,
      redisCounter as never,
    );

    await service.handleUpdate(createUpdate());

    expect(redisCounter.getString).not.toHaveBeenCalledWith(
      buildDeveloperForcedGlobalSpammerCacheKey('user-1'),
    );
    expect(redisCounter.getString).not.toHaveBeenCalledWith(
      buildDeveloperForcedGlobalSpammerWarmMarkerKey(),
    );
    expect(prisma.globalSpammer.findMany).not.toHaveBeenCalled();
    expect(redisCounter.setStringWithTtl).not.toHaveBeenCalledWith(
      buildDeveloperForcedGlobalSpammerCacheKey('user-1'),
      expect.any(String),
      expect.any(Number),
    );
    expect(ruleEngine.detect).toHaveBeenCalledTimes(1);
    expect(maxClient.deleteMessage).not.toHaveBeenCalled();
    expect(maxClient.kickMember).not.toHaveBeenCalled();
    expect(prisma.moderationEvent.create).not.toHaveBeenCalledWith({
      data: expect.objectContaining({
        chatId: 'chat-1',
        userId: 'user-1',
        messageId: 'msg-1',
        ruleCode: 'GLOBAL_SPAMMER_KICK',
        action: SanctionAction.KICK,
      }),
    });
  });

  it('restores developer-forced blacklist cache from registry and enforces when spammer deletion is enabled', async () => {
    const expiresAt = new Date(Date.now() + 60_000);
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings({ deleteSpammersEnabled: true }),
          domains: [],
          admins: [{ userId: 'owner-1' }],
        }),
      },
      globalSpammer: {
        findMany: jest.fn().mockResolvedValue([
          {
            userId: 'user-1',
            expiresAt,
            sourceBreakdown: {
              DEVELOPER_FORCED: {
                score: 1,
                count: 1,
                reasons: ['По решению разработчика бота за нарушение правил'],
              },
            },
          },
        ]),
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
    };
    const redisCounter = {
      getString: jest.fn().mockResolvedValue(null),
      setStringWithTtl: jest.fn().mockResolvedValue(undefined),
    };

    const service = new ModerationService(
      prisma as never,
      ruleEngine as never,
      sanctionService as never,
      maxClient as never,
      undefined,
      undefined,
      undefined,
      redisCounter as never,
    );
    installStateDeleteExecutorFixture(service);
    const ensureDeleteIntent = jest
      .spyOn(service as any, 'ensureModerationDeleteIntent')
      .mockResolvedValue(undefined);
    const update = createUpdate();
    update.message!.createdAt = new Date().toISOString();

    await service.handleUpdate(update);

    expect(redisCounter.getString).toHaveBeenCalledWith(
      buildDeveloperForcedGlobalSpammerCacheKey('user-1'),
    );
    expect(redisCounter.getString).toHaveBeenCalledWith(
      buildDeveloperForcedGlobalSpammerWarmMarkerKey(),
    );
    expect(prisma.globalSpammer.findMany).toHaveBeenCalledWith({
      where: expect.objectContaining({
        expiresAt: {
          gt: expect.any(Date),
        },
        sourceBreakdown: expect.objectContaining({
          path: ['DEVELOPER_FORCED'],
        }),
      }),
      select: {
        userId: true,
        expiresAt: true,
        sourceBreakdown: true,
      },
    });
    expect(redisCounter.setStringWithTtl).toHaveBeenCalledWith(
      buildDeveloperForcedGlobalSpammerCacheKey('user-1'),
      '1',
      expect.any(Number),
    );
    expect(redisCounter.setStringWithTtl).toHaveBeenCalledWith(
      buildDeveloperForcedGlobalSpammerWarmMarkerKey(),
      '1',
      DEVELOPER_FORCED_GLOBAL_SPAMMER_WARM_MARKER_TTL_SEC,
    );
    expect(ruleEngine.detect).not.toHaveBeenCalled();
    expectImmediateDeleteMessage(maxClient.deleteMessage, 'chat-1', 'msg-1');
    expectImmediateKickMember(maxClient.kickMember, 'chat-1', 'user-1');
    expect(ensureDeleteIntent).toHaveBeenCalledWith(
      expect.objectContaining({
        ruleCode: 'GLOBAL_SPAMMER_MESSAGE_DELETE',
        sourceMessageAt: update.message!.createdAt,
      }),
    );
  });

  it('negative-caches developer-forced registry misses after checking Redis when spammer deletion is enabled', async () => {
    const createMessageUpdate = (messageId: string): MaxUpdate => ({
      ...createUpdate(),
      updateId: `upd-${messageId}`,
      message: {
        ...createUpdate().message!,
        messageId,
      },
    });
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings({ deleteSpammersEnabled: true }),
          domains: [],
          admins: [{ userId: 'owner-1' }],
        }),
      },
      globalSpammer: {
        findMany: jest.fn().mockResolvedValue([]),
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
      detect: jest.fn().mockResolvedValue({ violations: [] }),
      hasCommercialSpamMarkers: jest.fn().mockReturnValue(false),
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
    const redisCounter = {
      getString: jest.fn().mockResolvedValue(null),
      setStringWithTtl: jest.fn().mockResolvedValue(undefined),
      addToSetWithTtl: jest.fn().mockResolvedValue({ added: true, size: 1 }),
      incrementWithTtl: jest.fn().mockResolvedValue(1),
    };

    const service = new ModerationService(
      prisma as never,
      ruleEngine as never,
      sanctionService as never,
      maxClient as never,
      undefined,
      undefined,
      undefined,
      redisCounter as never,
    );

    await service.handleUpdate(createMessageUpdate('msg-1'));
    await service.handleUpdate(createMessageUpdate('msg-2'));

    expect(redisCounter.getString).toHaveBeenCalledWith(
      buildDeveloperForcedGlobalSpammerCacheKey('user-1'),
    );
    expect(redisCounter.getString).toHaveBeenCalledWith(
      buildDeveloperForcedGlobalSpammerWarmMarkerKey(),
    );
    expect(prisma.globalSpammer.findMany).toHaveBeenCalledTimes(1);
    expect(ruleEngine.detect).toHaveBeenCalledTimes(2);
    expect(maxClient.deleteMessage).not.toHaveBeenCalled();
    expect(redisCounter.setStringWithTtl).toHaveBeenCalledWith(
      buildDeveloperForcedGlobalSpammerWarmMarkerKey(),
      '1',
      DEVELOPER_FORCED_GLOBAL_SPAMMER_WARM_MARKER_TTL_SEC,
    );
    expect(redisCounter.setStringWithTtl).not.toHaveBeenCalledWith(
      buildDeveloperForcedGlobalSpammerCacheKey('user-1'),
      expect.any(String),
      expect.any(Number),
    );
  });

  it('ignores legacy global spammer rows without an active expiry window', async () => {
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings({ deleteSpammersEnabled: true }),
          domains: [],
          admins: [],
        }),
      },
      globalSpammer: {
        findFirst: jest.fn().mockResolvedValue(null),
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
      detect: jest.fn().mockResolvedValue({ violations: [] }),
      hasCommercialSpamMarkers: jest.fn().mockReturnValue(false),
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

    expect(prisma.globalSpammer.findFirst).toHaveBeenCalledWith({
      where: {
        userId: 'user-1',
        expiresAt: {
          gt: expect.any(Date),
        },
      },
      select: {
        userId: true,
      },
    });
    expect(ruleEngine.detect).toHaveBeenCalledTimes(1);
    expect(maxClient.deleteMessage).not.toHaveBeenCalled();
    expect(maxClient.kickMember).not.toHaveBeenCalled();
  });

  it('does not auto-kick an exempted globally blacklisted sender', async () => {
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings({ deleteSpammersEnabled: true }),
          domains: [],
          admins: [{ userId: 'owner-1' }],
        }),
      },
      adminGlobalSpammerExemption: {
        findMany: jest.fn().mockResolvedValue([{ userId: 'user-1' }]),
      },
      globalSpammer: {
        findUnique: jest.fn().mockResolvedValue({ userId: 'user-1' }),
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
      detect: jest.fn().mockResolvedValue({ violations: [] }),
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

    expect(ruleEngine.detect).toHaveBeenCalledTimes(1);
    expect(maxClient.deleteMessage).not.toHaveBeenCalled();
    expect(maxClient.kickMember).not.toHaveBeenCalled();
    expect(prisma.moderationEvent.create).not.toHaveBeenCalled();
  });

  it('kicks globally blacklisted user on service join event when toggle is enabled', async () => {
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings({ deleteSpammersEnabled: true }),
          domains: [],
          admins: [],
        }),
      },
      globalSpammer: {
        findMany: jest.fn().mockResolvedValue([{ userId: 'user-black-2' }]),
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
    };

    const service = new ModerationService(
      prisma as never,
      ruleEngine as never,
      sanctionService as never,
      maxClient as never,
    );

    await service.handleUpdate(createServiceUserJoinedUpdate());

    expect(ruleEngine.detect).not.toHaveBeenCalled();
    expect(prisma.violation.create).not.toHaveBeenCalled();
    expect(maxClient.deleteMessage).not.toHaveBeenCalled();
    expectImmediateKickMember(maxClient.kickMember, 'chat-1', 'user-black-2');
    expect(maxClient.sendMessage).not.toHaveBeenCalled();
    expect(prisma.moderationEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        chatId: 'chat-1',
        userId: 'user-black-2',
        messageId: 'msg-service-user-join-1',
        ruleCode: 'GLOBAL_SPAMMER_KICK',
        action: SanctionAction.KICK,
      }),
    });
    expect(prisma.globalSpammer.findMany).toHaveBeenCalledWith({
      where: {
        userId: {
          in: ['user-black-2'],
        },
        expiresAt: {
          gt: expect.any(Date),
        },
      },
      select: {
        userId: true,
      },
    });
  });

  it('dedupes service join global spammer kicks across multiple bot deliveries', async () => {
    const claimedKeys = new Set<string>();
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings({ deleteSpammersEnabled: true }),
          domains: [],
          admins: [],
        }),
      },
      globalSpammer: {
        findMany: jest.fn().mockResolvedValue([{ userId: 'user-black-2' }]),
      },
      violation: {
        create: jest.fn(),
      },
      moderationEvent: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn(),
      },
      moderationViolationMessageClaim: {
        createMany: jest.fn(async (args: { data: Array<{ dedupeKey: string }> }) => {
          const dedupeKey = args.data[0]?.dedupeKey;
          if (!dedupeKey || claimedKeys.has(dedupeKey)) {
            return { count: 0 };
          }

          claimedKeys.add(dedupeKey);
          return { count: 1 };
        }),
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
    };
    const service = new ModerationService(
      prisma as never,
      ruleEngine as never,
      sanctionService as never,
      maxClient as never,
    );
    const createdAtMs = new Date('2026-04-06T01:00:15.999Z').getTime();
    const createDeliveredJoinUpdate = (
      botId: string,
      updateId: string,
      offsetMs: number,
    ): MaxUpdate => {
      const createdAt = new Date(createdAtMs + offsetMs).toISOString();
      return {
        ...createServiceUserJoinedUpdate(),
        updateId,
        botId,
        message: {
          ...createServiceUserJoinedUpdate().message!,
          messageId: `msg-service-user-join-${botId}`,
          createdAt,
        },
        raw: {
          message: {
            sender: {
              id: 'service-1',
              type: 'service',
              is_service: true,
            },
            timestamp: new Date(createdAt).getTime(),
            body: {
              new_members: [
                {
                  user_id: 'user-black-2',
                  type: 'user',
                  display_name: 'Новый участник',
                },
              ],
            },
          },
        },
      };
    };

    await service.handleUpdate(
      createDeliveredJoinUpdate('bot-1', 'upd-service-user-join-bot-1', 0),
    );
    await service.handleUpdate(
      createDeliveredJoinUpdate('bot-2', 'upd-service-user-join-bot-2', 0),
    );
    await service.handleUpdate(
      createDeliveredJoinUpdate('bot-3', 'upd-service-user-join-bot-3', 0),
    );

    expect(maxClient.kickMember).toHaveBeenCalledTimes(1);
    expect(maxClient.sendMessage).not.toHaveBeenCalled();
    expect(prisma.moderationEvent.create).toHaveBeenCalledTimes(1);
    expect(prisma.moderationViolationMessageClaim.createMany).toHaveBeenCalledTimes(3);
    expect(
      new Set(
        prisma.moderationViolationMessageClaim.createMany.mock.calls.map(
          ([args]) => args.data[0]?.dedupeKey,
        ),
      ).size,
    ).toBe(1);
  });

  it('records global spammer policy decisions for service join kicks', async () => {
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings({ deleteSpammersEnabled: true }),
          domains: [],
          admins: [],
        }),
      },
      globalSpammer: {
        findMany: jest.fn().mockResolvedValue([{ userId: 'user-black-2' }]),
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
      kickMember: jest.fn().mockResolvedValue(undefined),
      banMember: jest.fn(),
      notifyModerators: jest.fn(),
    };
    const globalSpammerIntelligence = {
      evaluatePolicy: jest.fn().mockResolvedValue({ action: 'DELETE_AND_KICK' }),
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
      undefined,
      globalSpammerIntelligence as never,
    );

    await service.handleUpdate(createServiceUserJoinedUpdate());

    expectImmediateKickMember(maxClient.kickMember, 'chat-1', 'user-black-2');
    expect(globalSpammerIntelligence.evaluatePolicy).toHaveBeenCalledWith({
      chatId: 'chat-1',
      userId: 'user-black-2',
      messageId: 'msg-service-user-join-1',
      trigger: 'member_join',
      deleteSpammersEnabled: true,
      adminExempt: false,
      recordDecision: true,
    });
    expect(globalSpammerIntelligence.evaluatePolicy).toHaveBeenCalledTimes(1);
  });

  it('does not auto-kick an exempted globally blacklisted user on service join event', async () => {
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings({ deleteSpammersEnabled: true }),
          domains: [],
          admins: [{ userId: 'owner-1' }],
        }),
      },
      adminGlobalSpammerExemption: {
        findMany: jest.fn().mockResolvedValue([{ userId: 'user-black-2' }]),
      },
      globalSpammer: {
        findMany: jest.fn().mockResolvedValue([{ userId: 'user-black-2' }]),
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
    };

    const service = new ModerationService(
      prisma as never,
      ruleEngine as never,
      sanctionService as never,
      maxClient as never,
    );

    await service.handleUpdate(createServiceUserJoinedUpdate());

    expect(maxClient.kickMember).not.toHaveBeenCalled();
    expect(prisma.moderationEvent.create).not.toHaveBeenCalled();
  });

  it('deletes messages silently while 6h active mute is in effect', async () => {
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
          id: 'ban-1',
          createdAt: new Date(Date.now() - 5 * 60 * 1000),
          action: SanctionAction.BAN,
          ruleCode: 'DUPLICATE_BAN',
          metadata: { banDurationHours: 6 },
        }),
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
    installStateDeleteExecutorFixture(service);

    await service.handleUpdate(createUpdate());

    expect(ruleEngine.detect).not.toHaveBeenCalled();
    expect(maxClient.getChatMembersAccess).toHaveBeenCalledWith('chat-1', ['user-1'], {
      trafficClass: 'interactive',
      actionHealthLane: 'background',
      timeoutMs: 2000,
      bypassCache: true,
      ignoreFailureMetricStatuses: [403, 404],
    });
    expectImmediateDeleteMessage(maxClient.deleteMessage, 'chat-1', 'msg-1');
    expect(maxClient.sendMessage).not.toHaveBeenCalled();
    expect(prisma.moderationEvent.create).toHaveBeenCalledTimes(1);
    expect(prisma.moderationEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        chatId: 'chat-1',
        userId: 'user-1',
        messageId: 'msg-1',
        ruleCode: 'MUTE_ACTIVE_DELETE',
        action: SanctionAction.DELETE_MESSAGE,
      }),
    });
  });

  it('deduplicates mirrored active-mute expired-message claims without dispatch', async () => {
    const claimedKeys = new Set<string>();
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
          id: 'ban-1',
          createdAt: new Date(Date.now() - 5 * 60 * 1000),
          action: SanctionAction.BAN,
          ruleCode: 'DUPLICATE_BAN',
          metadata: { banDurationHours: 6 },
        }),
        create: jest.fn(),
      },
      moderationViolationMessageClaim: {
        createMany: jest.fn(async (args: { data: Array<{ dedupeKey: string }> }) => {
          const dedupeKey = args.data[0]?.dedupeKey;
          if (!dedupeKey || claimedKeys.has(dedupeKey)) {
            return { count: 0 };
          }

          claimedKeys.add(dedupeKey);
          return { count: 1 };
        }),
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
    installStateDeleteExecutorFixture(service);

    await service.handleUpdate(createOldUpdate());
    await service.handleUpdate({
      ...createOldUpdate(),
      updateId: 'upd-old-standby-1',
      botId: 'bot-2',
    });

    expect(ruleEngine.detect).not.toHaveBeenCalled();
    expect(maxClient.deleteMessage).not.toHaveBeenCalled();
    expect(prisma.moderationEvent.create).not.toHaveBeenCalled();
    expect(maxClient.notifyModerators).not.toHaveBeenCalled();
    expect(prisma.moderationViolationMessageClaim.createMany).toHaveBeenCalledTimes(2);
    expect(claimedKeys.size).toBe(1);
  });

  it('keeps deleting messages for a permanent manual mute until it is lifted', async () => {
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
          id: 'manual-mute-permanent-1',
          createdAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
          action: SanctionAction.MUTE,
          ruleCode: 'MANUAL_MUTE',
          metadata: { mutePermanent: true },
        }),
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
    installStateDeleteExecutorFixture(service);

    await service.handleUpdate(createUpdate());

    expect(ruleEngine.detect).not.toHaveBeenCalled();
    expect(maxClient.getChatMembersAccess).toHaveBeenCalledWith('chat-1', ['user-1'], {
      trafficClass: 'interactive',
      actionHealthLane: 'background',
      timeoutMs: 2000,
      bypassCache: true,
      ignoreFailureMetricStatuses: [403, 404],
    });
    expectImmediateDeleteMessage(maxClient.deleteMessage, 'chat-1', 'msg-1');
    expect(prisma.moderationEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        chatId: 'chat-1',
        userId: 'user-1',
        messageId: 'msg-1',
        ruleCode: 'MUTE_ACTIVE_DELETE',
        action: SanctionAction.DELETE_MESSAGE,
        metadata: expect.objectContaining({
          mutePermanent: true,
          muteEventId: 'manual-mute-permanent-1',
        }),
      }),
    });
  });

  it('does not keep deleting messages after a later manual unban', async () => {
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
          id: 'unban-1',
          createdAt: new Date(Date.now() - 2 * 60 * 1000),
          action: SanctionAction.NONE,
          ruleCode: 'MANUAL_UNBAN',
          metadata: null,
        }),
        create: jest.fn(),
      },
      webhookEvent: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };
    const ruleEngine = {
      detect: jest.fn().mockResolvedValue({ violations: [] }),
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

    expect(ruleEngine.detect).toHaveBeenCalledTimes(1);
    expect(maxClient.deleteMessage).not.toHaveBeenCalled();
    expect(prisma.moderationEvent.create).not.toHaveBeenCalled();
  });

  it('resets link escalation window after a later manual unban', async () => {
    const nowSpy = jest
      .spyOn(Date, 'now')
      .mockReturnValue(new Date('2026-03-28T10:00:00.000Z').getTime());
    try {
      const prisma = {
        violation: {
          count: jest.fn().mockResolvedValue(1),
        },
        moderationEvent: {
          findFirst: jest.fn().mockResolvedValue({
            createdAt: new Date('2026-03-28T02:00:00.000Z'),
          }),
        },
      };

      const service = new ModerationService(prisma as never, {} as never, {} as never, {} as never);

      const result = await (
        service as unknown as {
          countRecentLinkViolations: (chatId: string, userId: string) => Promise<number>;
        }
      ).countRecentLinkViolations('chat-1', 'user-1');

      expect(result).toBe(1);
      expect(prisma.violation.count).toHaveBeenCalledWith({
        where: {
          chatId: 'chat-1',
          userId: 'user-1',
          ruleCode: 'LINK_BLOCKED',
          createdAt: {
            gte: new Date('2026-03-28T02:00:00.000Z'),
            lte: new Date('2026-03-28T10:00:00.000Z'),
          },
        },
      });
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('resets link escalation window after a later manual unmute', async () => {
    const nowSpy = jest
      .spyOn(Date, 'now')
      .mockReturnValue(new Date('2026-03-28T10:00:00.000Z').getTime());
    try {
      const prisma = {
        violation: {
          count: jest.fn().mockResolvedValue(1),
        },
        moderationEvent: {
          findFirst: jest.fn().mockResolvedValue({
            createdAt: new Date('2026-03-28T03:30:00.000Z'),
          }),
        },
      };

      const service = new ModerationService(prisma as never, {} as never, {} as never, {} as never);

      const result = await (
        service as unknown as {
          countRecentLinkViolations: (chatId: string, userId: string) => Promise<number>;
        }
      ).countRecentLinkViolations('chat-1', 'user-1');

      expect(result).toBe(1);
      expect(prisma.violation.count).toHaveBeenCalledWith({
        where: {
          chatId: 'chat-1',
          userId: 'user-1',
          ruleCode: 'LINK_BLOCKED',
          createdAt: {
            gte: new Date('2026-03-28T03:30:00.000Z'),
            lte: new Date('2026-03-28T10:00:00.000Z'),
          },
        },
      });
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('suppresses duplicate escalation while a later manual unban is still inside the duplicate window', async () => {
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
          ruleCode: 'MANUAL_UNBAN',
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
          hash: 'dup-after-unban',
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

    expect(ruleEngine.detect).toHaveBeenCalledTimes(1);
    expect(maxClient.deleteMessage).not.toHaveBeenCalled();
    expect(maxClient.kickMember).not.toHaveBeenCalled();
    expect(maxClient.banMember).not.toHaveBeenCalled();
    expect(prisma.moderationEvent.create).not.toHaveBeenCalled();
  });

  it('honors manual ban durations above 36 hours from moderation metadata', async () => {
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
          id: 'ban-72h-1',
          createdAt: new Date(Date.now() - 48 * 60 * 60 * 1000),
          action: SanctionAction.BAN,
          ruleCode: 'MANUAL_BAN',
          metadata: {
            muteDurationHours: 72,
          },
        }),
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
    installStateDeleteExecutorFixture(service);

    await service.handleUpdate(createUpdate());

    expect(ruleEngine.detect).not.toHaveBeenCalled();
    expectImmediateDeleteMessage(maxClient.deleteMessage, 'chat-1', 'msg-1');
    expect(prisma.moderationEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        chatId: 'chat-1',
        userId: 'user-1',
        messageId: 'msg-1',
        ruleCode: 'MUTE_ACTIVE_DELETE',
        action: SanctionAction.DELETE_MESSAGE,
      }),
    });
  });

  it('uses cached active mute state before hitting prisma', async () => {
    const issuedAt = new Date(Date.now() - 60 * 60 * 1000);
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
    const prisma = {
      moderationEvent: {
        findFirst: jest.fn(),
      },
    };
    const redisCounter = {
      getString: jest.fn().mockResolvedValue(
        JSON.stringify({
          eventId: 'cached-mute-1',
          issuedAt: issuedAt.toISOString(),
          expiresAt: expiresAt.toISOString(),
          durationHours: 6,
          ruleCode: null,
        }),
      ),
    };

    const service = new ModerationService(
      prisma as never,
      {} as never,
      {} as never,
      {} as never,
      undefined,
      undefined,
      undefined,
      redisCounter as never,
    );

    const result = await (
      service as unknown as {
        getActiveMute: (
          chatId: string,
          userId: string,
          fallbackMuteDurationHours: number,
        ) => Promise<{
          eventId: string;
          durationHours: number;
          issuedAt: Date;
          expiresAt: Date;
        } | null>;
      }
    ).getActiveMute('chat-1', 'user-1', 6);

    expect(result).toEqual({
      eventId: 'cached-mute-1',
      durationHours: 6,
      issuedAt,
      expiresAt,
      permanent: false,
      ruleCode: null,
    });
    expect(prisma.moderationEvent.findFirst).not.toHaveBeenCalled();
  });

  it('rehydrates a legacy active mute cache entry without its rule origin', async () => {
    const issuedAt = new Date(Date.now() - 60 * 60 * 1000);
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
    const prisma = {
      moderationEvent: {
        findFirst: jest
          .fn()
          .mockResolvedValueOnce({
            id: 'legacy-required-mute-1',
            createdAt: issuedAt,
            metadata: { muteDurationHours: 2 },
            action: SanctionAction.MUTE,
            ruleCode: 'REQUIRED_SUBSCRIPTION',
          })
          .mockResolvedValueOnce(null),
      },
    };
    const redisCounter = {
      getString: jest.fn().mockResolvedValue(
        JSON.stringify({
          eventId: 'legacy-required-mute-1',
          issuedAt: issuedAt.toISOString(),
          expiresAt: expiresAt.toISOString(),
          durationHours: 2,
        }),
      ),
      setStringWithTtl: jest.fn().mockResolvedValue(undefined),
    };
    const service = new ModerationService(
      prisma as never,
      {} as never,
      {} as never,
      {} as never,
      undefined,
      undefined,
      undefined,
      redisCounter as never,
    );

    const result = await (service as any).getActiveMute('chat-1', 'user-1', 6);

    expect(result).toEqual({
      eventId: 'legacy-required-mute-1',
      issuedAt,
      expiresAt: new Date(issuedAt.getTime() + 2 * 60 * 60 * 1000),
      durationHours: 2,
      permanent: false,
      ruleCode: 'REQUIRED_SUBSCRIPTION',
    });
    expect(redisCounter.setStringWithTtl).toHaveBeenCalledWith(
      buildActiveMuteStateKey('chat-1', 'user-1'),
      expect.stringContaining('"ruleCode":"REQUIRED_SUBSCRIPTION"'),
      expect.any(Number),
    );
  });

  it('hydrates active mute cache from prisma fallback', async () => {
    const prisma = {
      moderationEvent: {
        findFirst: jest
          .fn()
          .mockResolvedValueOnce({
            id: 'evt-mute-1',
            createdAt: new Date(Date.now() - 60 * 60 * 1000),
            metadata: null,
            action: SanctionAction.MUTE,
            ruleCode: 'COMMERCIAL_AD',
          })
          .mockResolvedValueOnce(null),
      },
    };
    const redisCounter = {
      getString: jest.fn().mockResolvedValue(null),
      setStringWithTtl: jest.fn().mockResolvedValue(undefined),
    };

    const service = new ModerationService(
      prisma as never,
      {} as never,
      {} as never,
      {} as never,
      undefined,
      undefined,
      undefined,
      redisCounter as never,
    );

    const result = await (
      service as unknown as {
        getActiveMute: (
          chatId: string,
          userId: string,
          fallbackMuteDurationHours: number,
        ) => Promise<{
          eventId: string;
          durationHours: number;
          issuedAt: Date;
          expiresAt: Date;
        } | null>;
      }
    ).getActiveMute('chat-1', 'user-1', 6);

    expect(result).toEqual(
      expect.objectContaining({
        eventId: 'evt-mute-1',
        durationHours: 6,
        issuedAt: expect.any(Date),
        expiresAt: expect.any(Date),
      }),
    );
    expect(redisCounter.setStringWithTtl).toHaveBeenCalledWith(
      buildActiveMuteStateKey('chat-1', 'user-1'),
      expect.stringContaining('"eventId":"evt-mute-1"'),
      expect.any(Number),
    );
  });

  it('prefers cached system mode snapshot in moderation hot path', async () => {
    const cachedSnapshot = {
      mode: 'degrade' as const,
      source: 'auto' as const,
      reason: 'cached snapshot',
      updatedAt: '2026-04-06T09:00:00.000Z',
      manualMode: null,
      queueLagSec: 2,
      action: {
        windowSec: 60,
        total: 10,
        success: 10,
        failure: 0,
        critical: 0,
        errorRate: 0,
        criticalRate: 0,
      },
    };
    const systemModeService = {
      peekCachedSnapshot: jest.fn().mockReturnValue(cachedSnapshot),
      getEffectiveSnapshot: jest.fn(),
    };

    const service = new ModerationService(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      undefined,
      systemModeService as never,
    );

    const result = await (
      service as unknown as {
        resolveSystemModeSnapshot: () => Promise<typeof cachedSnapshot>;
      }
    ).resolveSystemModeSnapshot();

    expect(result).toBe(cachedSnapshot);
    expect(systemModeService.getEffectiveSnapshot).not.toHaveBeenCalled();
  });

  it('deletes messages during night mode silently when bot notice is disabled', async () => {
    const prisma = {
      chat: {
        upsert: jest.fn().mockResolvedValue({
          id: 'chat-1',
          title: 'Chat 1',
          settings: createSettings({
            nightModeEnabled: true,
            nightModeStartTimeMinutes: 0,
            nightModeEndTimeMinutes: 0,
            nightModeBotMessageEnabled: false,
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
    installStateDeleteExecutorFixture(service);

    await service.handleUpdate(createUpdate());

    expect(ruleEngine.detect).not.toHaveBeenCalled();
    expectImmediateDeleteMessage(maxClient.deleteMessage, 'chat-1', 'msg-1');
    expect(maxClient.sendMessage).not.toHaveBeenCalled();
    expect(prisma.moderationEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        chatId: 'chat-1',
        userId: 'user-1',
        messageId: 'msg-1',
        ruleCode: 'NIGHT_MODE_DELETE',
        action: SanctionAction.DELETE_MESSAGE,
      }),
    });
  });
});

describe('report counter ownership after admission disable', () => {
  it('never gives a known counter to generic auto-delete after a delayed webhook', async () => {
    const service = new ModerationService({} as never, {} as never, {} as never, {} as never);
    const ownsCounter = jest.fn().mockResolvedValue(true);
    const cleanup = jest.fn();
    Object.assign(service, {
      reportSubmission: { ownsCounter },
      handleBotMessageAutoDelete: cleanup,
    });
    await (service as any).handleOwnBotMessageAutoDelete({
      chatId: 'chat',
      userId: 'bot-user',
      messageId: 'counter',
      text: 'counter',
      createdAt: new Date().toISOString(),
      settings: createSettings({ reportsEnabled: false, deleteBotMessagesEnabled: true }),
    });
    expect(ownsCounter).toHaveBeenCalledTimes(1);
    expect(cleanup).not.toHaveBeenCalled();
  });
});
