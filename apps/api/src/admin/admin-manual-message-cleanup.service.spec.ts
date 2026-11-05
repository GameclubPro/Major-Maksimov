import { AdminManualMessageCleanupService } from './admin-manual-message-cleanup.service';
import type { MaxClientService } from '../max/max-client.service';
import { markMaxPreDispatchGuardRejected } from '../max/max-action-pre-dispatch-guard';
import {
  markMaxMemberMutationAttempted,
  markMaxMemberMutationConfirmed,
} from '../max/max-member-error.util';
import { markMaxMessageSendAttempted } from '../max/max-mutation-outcome.util';
import { ModerationSanctionStateLockLeaseLostError } from '../moderation/moderation-sanction-state-lock.service';

function executorProofRejection(marked = true) {
  const error = Object.assign(new Error('MAX action executor proof changed during quota wait'), {
    code: 'max_action_executor_proof_rejected',
  });
  return marked ? markMaxPreDispatchGuardRejected(error, 'unused') : error;
}

function recentCleanupFixture(messageIds = ['message-1']) {
  const prisma = {
    $queryRaw: jest.fn().mockResolvedValue(messageIds.map((message_id) => ({ message_id }))),
  };
  const maxClient = {
    deleteMessage: jest.fn<
      ReturnType<MaxClientService['deleteMessage']>,
      Parameters<MaxClientService['deleteMessage']>
    >(),
  };
  const leaseGuard = { assertOwned: jest.fn<Promise<void>, []>().mockResolvedValue(undefined) };
  return {
    maxClient,
    prisma,
    leaseGuard,
    service: new AdminManualMessageCleanupService(prisma as never, maxClient as never),
  };
}

describe('AdminManualMessageCleanupService', () => {
  it.each([
    [
      'republish_previous',
      'chat_rules_republish_previous_message_cleanup',
      'CHAT_RULES_REPUBLISH_PREVIOUS_MESSAGE_CLEANUP',
    ],
    [
      'reset_current',
      'chat_rules_reset_published_message_cleanup',
      'CHAT_RULES_RESET_PUBLISHED_MESSAGE_CLEANUP',
    ],
  ] as const)(
    'preserves the durable identity when reconciling %s rules cleanup',
    async (cleanupKind, reasonKey, ruleCode) => {
      const service = new AdminManualMessageCleanupService({} as never, {} as never);
      const cleanup = jest
        .spyOn(service, 'deleteBotAuthoredMessage')
        .mockResolvedValue('confirmed');
      await expect(
        service.deleteChatRulesMessage({
          chatId: 'chat-1',
          messageId: 'old-rules',
          botId: 'original-bot',
          cleanupKind,
          source: 'miniapp',
          actorUserId: 'admin-1',
          directOptions: { immediate: true },
        }),
      ).resolves.toBe('confirmed');
      expect(cleanup).toHaveBeenCalledWith(
        expect.objectContaining({
          chatId: 'chat-1',
          messageId: 'old-rules',
          originBotId: 'original-bot',
          reasonKey,
          ruleCode,
        }),
      );
    },
  );
  it('routes exact replacement cleanup through the durable executor outside the global rollout', async () => {
    const maxClient = { deleteMessage: jest.fn() };
    const deleteIntents = {
      getRolloutForChat: jest.fn().mockReturnValue('observed'),
      getRolloutForRule: jest.fn().mockReturnValue('execute'),
      ensureIntent: jest.fn().mockResolvedValue({
        intentId: 'intent-1',
        rollout: 'execute',
        status: 'PENDING',
      }),
      ensureAndAttempt: jest.fn().mockResolvedValue({
        kind: 'pending',
        confirmed: false,
        intentId: 'intent-1',
        status: 'PENDING',
      }),
    };
    const service = new AdminManualMessageCleanupService(
      {} as never,
      maxClient as never,
      deleteIntents as never,
    );

    await expect(
      service.deleteBotAuthoredMessage({
        chatId: 'chat-outside-canary',
        messageId: 'message-1',
        originBotId: 'bot-1',
        reasonKey: 'chat_rules_republish_previous_message_cleanup',
        ruleCode: 'CHAT_RULES_REPUBLISH_PREVIOUS_MESSAGE_CLEANUP',
        metadata: { source: 'chat_rules' },
        directOptions: { immediate: true, botId: 'bot-1' },
      }),
    ).resolves.toBe('accepted');

    expect(deleteIntents.getRolloutForRule).toHaveBeenCalledWith(
      'chat-outside-canary',
      'CHAT_RULES_REPUBLISH_PREVIOUS_MESSAGE_CLEANUP',
    );
    expect(deleteIntents.ensureIntent).toHaveBeenCalledTimes(1);
    expect(deleteIntents.ensureAndAttempt).toHaveBeenCalledTimes(1);
    expect(maxClient.deleteMessage).not.toHaveBeenCalled();
  });

  it('distinguishes blocked rules cleanup from an actively pending deletion', async () => {
    const maxClient = { deleteMessage: jest.fn() };
    const deleteIntents = {
      getRolloutForRule: jest.fn().mockReturnValue('execute'),
      ensureIntent: jest.fn().mockResolvedValue({ intentId: 'intent-1' }),
      ensureAndAttempt: jest.fn().mockResolvedValue({
        kind: 'waiting_capability',
        confirmed: false,
        intentId: 'intent-1',
        status: 'WAITING_CAPABILITY',
      }),
    };
    const service = new AdminManualMessageCleanupService(
      {} as never,
      maxClient as never,
      deleteIntents as never,
    );

    await expect(
      service.deleteChatRulesMessage({
        chatId: 'chat-1',
        messageId: 'old-rules',
        botId: 'original-bot',
        cleanupKind: 'republish_previous',
        source: 'miniapp',
        actorUserId: 'admin-1',
        directOptions: { immediate: true },
      }),
    ).resolves.toBe('waiting_capability');
    expect(maxClient.deleteMessage).not.toHaveBeenCalled();
  });

  it('fails closed when exact replacement cleanup intent persistence fails', async () => {
    const persistenceError = new Error('intent persistence unavailable');
    const maxClient = { deleteMessage: jest.fn() };
    const deleteIntents = {
      getRolloutForChat: jest.fn().mockReturnValue('observed'),
      getRolloutForRule: jest.fn().mockReturnValue('execute'),
      ensureIntent: jest.fn().mockRejectedValue(persistenceError),
      ensureAndAttempt: jest.fn(),
    };
    const service = new AdminManualMessageCleanupService(
      {} as never,
      maxClient as never,
      deleteIntents as never,
    );

    await expect(
      service.deleteBotAuthoredMessage({
        chatId: 'chat-outside-canary',
        messageId: 'message-1',
        originBotId: 'bot-1',
        reasonKey: 'chat_rules_republish_previous_message_cleanup',
        ruleCode: 'CHAT_RULES_REPUBLISH_PREVIOUS_MESSAGE_CLEANUP',
        metadata: { source: 'chat_rules' },
        directOptions: { immediate: true, botId: 'bot-1' },
      }),
    ).rejects.toBe(persistenceError);

    expect(deleteIntents.ensureAndAttempt).not.toHaveBeenCalled();
    expect(maxClient.deleteMessage).not.toHaveBeenCalled();
  });

  it('stops recent-message deletion when the sanction lease is lost between items', async () => {
    const leaseLostError = new Error('sanction lease lost');
    const prisma = {
      $queryRaw: jest
        .fn()
        .mockResolvedValue([
          { message_id: 'message-1' },
          { message_id: 'message-2' },
          { message_id: 'message-3' },
        ]),
    };
    const maxClient = { deleteMessage: jest.fn().mockResolvedValue(undefined) };
    const leaseGuard = {
      assertOwned: jest.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(leaseLostError),
    };
    const service = new AdminManualMessageCleanupService(prisma as never, maxClient as never);

    await expect(
      service.deleteRecentTrackedMessages('chat-1', 'user-1', { leaseGuard }),
    ).rejects.toBe(leaseLostError);

    expect(leaseGuard.assertOwned).toHaveBeenCalledTimes(2);
    expect(maxClient.deleteMessage).toHaveBeenCalledTimes(1);
    expect(maxClient.deleteMessage).toHaveBeenCalledWith('chat-1', 'message-1', {
      immediate: true,
      beforeImmediateDeleteMutation: expect.any(Function),
    });
  });

  it('requalifies the same explicit executor once without restarting earlier cleanup', async () => {
    const s = recentCleanupFixture(['message-1', 'message-2']);
    s.maxClient.deleteMessage
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(executorProofRejection())
      .mockImplementationOnce(async (_chat, _message, options) => {
        await options?.beforeImmediateDeleteMutation?.();
      });

    await expect(
      s.service.deleteRecentTrackedMessages('chat-1', 'user-1', {
        botId: 'selected-bot',
        leaseGuard: s.leaseGuard,
      }),
    ).resolves.toEqual({
      candidateMessageIds: ['message-1', 'message-2'],
      deletedMessageIds: ['message-1', 'message-2'],
      pendingMessageIds: [],
      failedMessageIds: [],
    });
    expect(
      s.maxClient.deleteMessage.mock.calls.map(([chat, message, options]) => [
        chat,
        message,
        options?.botId,
      ]),
    ).toEqual([
      ['chat-1', 'message-1', 'selected-bot'],
      ['chat-1', 'message-2', 'selected-bot'],
      ['chat-1', 'message-2', 'selected-bot'],
    ]);
    expect(s.maxClient.deleteMessage.mock.calls[1][2]).toBe(
      s.maxClient.deleteMessage.mock.calls[2][2],
    );
    expect(s.leaseGuard.assertOwned).toHaveBeenCalledTimes(4);
  });

  it('stops after one additional certified executor rejection', async () => {
    const s = recentCleanupFixture();
    s.maxClient.deleteMessage.mockRejectedValue(executorProofRejection());
    const result = await s.service.deleteRecentTrackedMessages('chat-1', 'user-1', {
      botId: 'selected-bot',
    });
    expect(s.maxClient.deleteMessage).toHaveBeenCalledTimes(2);
    expect(result.deletedMessageIds).toEqual([]);
    expect(result.failedMessageIds).toEqual(['message-1']);
  });

  it.each([
    'unmarked',
    'copied',
    'wrong-code',
    'send-attempted',
    'member-attempted',
    'member-confirmed',
    'remote-503',
    'ambiguous',
  ])('does not retry %s effect evidence', async (kind) => {
    const s = recentCleanupFixture();
    let error = executorProofRejection(kind !== 'unmarked');
    if (kind === 'copied') error = Object.assign(new Error('copied proof error'), error);
    if (kind === 'wrong-code') Object.assign(error as object, { code: 'another_guard_rejected' });
    if (kind === 'send-attempted') markMaxMessageSendAttempted(error);
    if (kind === 'member-attempted') markMaxMemberMutationAttempted(error);
    if (kind === 'member-confirmed') markMaxMemberMutationConfirmed(error);
    if (kind === 'remote-503') Object.assign(error as object, { response: { status: 503 } });
    if (kind === 'ambiguous') Object.assign(error as object, { message: 'ambiguous MAX outcome' });
    s.maxClient.deleteMessage.mockRejectedValue(error);
    const result = await s.service.deleteRecentTrackedMessages('chat-1', 'user-1', {
      botId: 'selected-bot',
    });
    expect(s.maxClient.deleteMessage).toHaveBeenCalledTimes(1);
    expect(result.failedMessageIds).toEqual(['message-1']);
  });

  it('does not retry without an explicit executor', async () => {
    const s = recentCleanupFixture();
    s.maxClient.deleteMessage.mockRejectedValue(executorProofRejection());
    await s.service.deleteRecentTrackedMessages('chat-1', 'user-1');
    expect(s.maxClient.deleteMessage).toHaveBeenCalledTimes(1);
  });

  it('propagates lease loss before the additional attempt', async () => {
    const s = recentCleanupFixture();
    const lost = new ModerationSanctionStateLockLeaseLostError({
      chatId: 'chat-1',
      userId: 'user-1',
    });
    s.leaseGuard.assertOwned.mockResolvedValueOnce(undefined).mockRejectedValue(lost);
    s.maxClient.deleteMessage.mockRejectedValue(executorProofRejection());
    await expect(
      s.service.deleteRecentTrackedMessages('chat-1', 'user-1', {
        botId: 'selected-bot',
        leaseGuard: s.leaseGuard,
      }),
    ).rejects.toBe(lost);
    expect(s.maxClient.deleteMessage).toHaveBeenCalledTimes(1);
  });

  it('checks the lease at the final retry guard and preserves its ordering failure', async () => {
    const s = recentCleanupFixture();
    const lost = new ModerationSanctionStateLockLeaseLostError({
      chatId: 'chat-1',
      userId: 'user-1',
    });
    const httpDelete = jest.fn();
    s.maxClient.deleteMessage
      .mockRejectedValueOnce(executorProofRejection())
      .mockImplementationOnce(async (_chat, _message, options) => {
        s.leaseGuard.assertOwned.mockRejectedValue(lost);
        await options?.beforeImmediateDeleteMutation?.();
        httpDelete();
      });
    await expect(
      s.service.deleteRecentTrackedMessages('chat-1', 'user-1', {
        botId: 'selected-bot',
        leaseGuard: s.leaseGuard,
      }),
    ).rejects.toBe(lost);
    expect(s.maxClient.deleteMessage).toHaveBeenCalledTimes(2);
    expect(httpDelete).not.toHaveBeenCalled();
  });

  it('does not repeat shadow persistence after a direct executor rejection', async () => {
    const s = recentCleanupFixture();
    const deleteIntents = {
      getRolloutForRule: jest.fn().mockReturnValue('shadow'),
      ensureAndAttempt: jest.fn().mockResolvedValue({ kind: 'observed' }),
    };
    const service = new AdminManualMessageCleanupService(
      s.prisma as never,
      s.maxClient as never,
      deleteIntents as never,
    );
    s.maxClient.deleteMessage
      .mockRejectedValueOnce(executorProofRejection())
      .mockResolvedValueOnce(undefined);
    const result = await service.deleteRecentTrackedMessages('chat-1', 'user-1', {
      botId: 'selected-bot',
    });
    expect(result.deletedMessageIds).toEqual(['message-1']);
    expect(deleteIntents.ensureAndAttempt).toHaveBeenCalledTimes(1);
    expect(s.maxClient.deleteMessage).toHaveBeenCalledTimes(2);
  });

  it('keeps a durable executor failure fenced without direct recovery', async () => {
    const s = recentCleanupFixture();
    const error = executorProofRejection();
    const deleteIntents = {
      getRolloutForRule: jest.fn().mockReturnValue('execute'),
      ensureAndAttempt: jest.fn().mockRejectedValue(error),
    };
    const service = new AdminManualMessageCleanupService(
      s.prisma as never,
      s.maxClient as never,
      deleteIntents as never,
    );
    await expect(
      service.deleteRecentTrackedMessages('chat-1', 'user-1', { botId: 'selected-bot' }),
    ).rejects.toBe(error);
    expect(deleteIntents.ensureAndAttempt).toHaveBeenCalledTimes(1);
    expect(s.maxClient.deleteMessage).not.toHaveBeenCalled();
  });
});
