import { ModerationRuleSanctionRejectedError } from './moderation-rule-sanction-authority';
import { deliverSanctionNotice } from './moderation-sanction-notice-delivery';
import { ModerationService, createSettings, createUpdate } from './moderation.service.spec-support';
import type { MaxUpdate } from '@maxim/contracts';
import type { FreshHeldCommandReceipt } from '../webhook/webhook-legacy-fresh-command';
import { WebhookParser } from '../webhook/webhook.parser';
import { buildWebhookSemanticEventKey } from '../webhook/webhook-semantic-event-key';

describe('permanent legacy moderation hold', () => {
  function fixture() {
    const service = Object.create(ModerationService.prototype) as ModerationService;
    const create = jest.fn();
    const legacyHolds = {
      isMessageHeld: jest.fn().mockResolvedValue(false),
      isMemberHeld: jest.fn().mockResolvedValue(true),
      isGlobalUserHeld: jest.fn().mockResolvedValue(false),
    };
    Object.assign(service, { legacyHolds, prisma: { moderationEvent: { create } } });
    return { service: service as any, create, legacyHolds };
  }

  function messageFixture() {
    const settings = createSettings({ deleteSpammersEnabled: false });
    const detect = jest.fn().mockResolvedValue({ violations: [] });
    const service = new ModerationService(
      {
        chat: {
          upsert: jest.fn().mockResolvedValue({ id: 'chat-1', settings, domains: [] }),
        },
        chatSettings: { findUnique: jest.fn().mockResolvedValue(settings) },
        moderationEvent: { findFirst: jest.fn().mockResolvedValue(null) },
      } as never,
      { detect } as never,
      {} as never,
      {} as never,
    );
    const legacyHolds = {
      isMessageHeld: jest.fn().mockResolvedValue(false),
      isMemberHeld: jest.fn().mockResolvedValue(false),
      isGlobalUserHeld: jest.fn((userId: string) => Promise.resolve(userId === 'user-1')),
      isUpdateHeld: jest.fn(async (update: MaxUpdate) => update.message?.senderId === 'user-1'),
      readFreshCommandReceipt: jest.fn(async (): Promise<FreshHeldCommandReceipt | null> => null),
    };
    const admin = jest.fn().mockResolvedValue({ isAdmin: false, source: 'remote' });
    const adminCommand = jest.fn().mockResolvedValue(true);
    const observeLifecycle = jest.fn();
    const maxClient = {
      getCurrentChatMemberAccess: jest.fn().mockResolvedValue({ isAdmin: true }),
      getChatMemberAccess: jest.fn().mockResolvedValue({ isAdmin: true }),
    };
    Object.assign(service, {
      legacyHolds,
      maxClient,
      messageDuplicateService: {
        observeLifecycle,
        isAuthoritative: jest.fn().mockResolvedValue(false),
      },
      resolveSenderChatAdminCheck: admin,
      handleChatAdminModerationBypass: jest.fn().mockResolvedValue(undefined),
      handleAdminForwardedModerationCommand: adminCommand,
    });
    return { service, detect, legacyHolds, admin, adminCommand, observeLifecycle, maxClient };
  }

  function freshCommand(text = 'тишина выкл') {
    const at = Date.now() - 1000;
    const raw = {
      update_type: 'message_created',
      update_id: 'fresh-command',
      timestamp: at,
      message: {
        sender: { user_id: 'user-1', is_bot: false },
        recipient: { chat_id: '-chat-1', chat_type: 'chat' },
        timestamp: at,
        body: { mid: 'fresh-message', text },
      },
    };
    const source = new WebhookParser().parse(raw, { botId: 'major-1' });
    const proof: FreshHeldCommandReceipt = {
      receiptId: 'fresh-receipt',
      kind: 'ADMIN',
      chatId: source.message!.chatId,
      messageId: source.message!.messageId,
      userId: source.message!.senderId,
      sourceAt: new Date(at),
      deadlineAt: new Date(at + 300_000),
      receiptCreatedAt: new Date(at + 1),
      botId: 'major-1',
      semanticKey: buildWebhookSemanticEventKey(source)!,
      normalizedPayload: JSON.parse(JSON.stringify(source)),
      rawPayload: raw,
    };
    Object.assign(source, { executionOwnerBotId: 'major-1' });
    return { source, proof };
  }

  it('denies a late edited message before any whole-engine or duplicate state mutation', async () => {
    const { service, legacyHolds } = fixture();
    legacyHolds.isMessageHeld.mockResolvedValue(true);
    const observeLifecycle = jest.fn();
    Object.assign(service, { messageDuplicateService: { observeLifecycle } });
    await service.handleUpdate({
      type: 'message_edited',
      message: { chatId: 'chat', messageId: 'old', senderId: 'actor' },
    });
    expect(observeLifecycle).not.toHaveBeenCalled();
  });

  it('denies new strikes and local WARN/MUTE persistence for the held participant', async () => {
    const { service, create } = fixture();
    await expect(
      service.claimMessageViolationProcessing({
        chatId: 'chat',
        userId: 'actor',
        messageId: 'new',
        ruleCode: 'MESSAGE_TOO_LONG',
      }),
    ).resolves.toBe(false);
    await expect(
      service.createBotModerationEvent({
        data: {
          chatId: 'chat',
          userId: 'actor',
          messageId: 'new',
          action: 'MUTE',
          ruleCode: 'MESSAGE_TOO_LONG',
        },
      }),
    ).rejects.toBeInstanceOf(ModerationRuleSanctionRejectedError);
    expect(create).not.toHaveBeenCalled();
  });

  it('fails closed when the participant lookup fails', async () => {
    const { service, create, legacyHolds } = fixture();
    legacyHolds.isMemberHeld.mockRejectedValue(new Error('Hold store unavailable'));
    await expect(
      service.createBotModerationEvent({
        data: {
          chatId: 'chat',
          userId: 'actor',
          messageId: 'new',
          action: 'WARN',
          ruleCode: 'MESSAGE_TOO_LONG',
        },
      }),
    ).rejects.toThrow('Hold store unavailable');
    expect(create).not.toHaveBeenCalled();
  });

  it('denies another-chat strikes, immunity and local sanctions for a globally held author', async () => {
    const { service, create, legacyHolds } = fixture();
    legacyHolds.isMemberHeld.mockResolvedValue(false);
    legacyHolds.isGlobalUserHeld.mockImplementation(async (userId: string) => userId === 'held');
    const consumeForMessage = jest.fn().mockResolvedValue('granted');
    const underLock = jest.fn();
    Object.assign(service, {
      participantImmunity: { consumeForMessage },
      applySanctionActionUnderLock: underLock,
    });
    const source = { chatId: 'other-chat', userId: 'held', messageId: 'fresh' };
    expect(
      await service.claimMessageViolationProcessing({ ...source, ruleCode: 'MESSAGE_TOO_LONG' }),
    ).toBe(false);
    expect(
      await service.consumeChatParticipantModerationImmunity({
        ...source,
        nightModeTimezone: 'UTC',
      }),
    ).toBe(true);
    await expect(service.applySanctionAction({ ...source, action: 'WARN' })).rejects.toBeInstanceOf(
      ModerationRuleSanctionRejectedError,
    );
    await expect(
      service.createBotModerationEvent({ data: { ...source, action: 'WARN' } }),
    ).rejects.toBeInstanceOf(ModerationRuleSanctionRejectedError);
    expect(create).not.toHaveBeenCalled();
    expect(consumeForMessage).not.toHaveBeenCalled();
    expect(underLock).not.toHaveBeenCalled();

    await service.createBotModerationEvent({
      data: { ...source, userId: 'independent', action: 'WARN' },
    });
    expect(create).toHaveBeenCalledTimes(1);
    expect(
      await service.consumeChatParticipantModerationImmunity({
        ...source,
        userId: 'independent',
        nightModeTimezone: 'UTC',
      }),
    ).toBe(true);
    expect(consumeForMessage).toHaveBeenCalledTimes(1);
  });

  it('fails closed on a global-user hold reader outage before any local event', async () => {
    const { service, create, legacyHolds } = fixture();
    legacyHolds.isMemberHeld.mockResolvedValue(false);
    legacyHolds.isGlobalUserHeld.mockRejectedValue(new Error('Global hold reader unavailable'));
    await expect(
      service.createBotModerationEvent({
        data: { chatId: 'other-chat', userId: 'held', messageId: 'fresh', action: 'WARN' },
      }),
    ).rejects.toThrow('Global hold reader unavailable');
    expect(create).not.toHaveBeenCalled();
  });

  it('stops automatic detection for a globally held author and admits an independent author', async () => {
    const { service, detect, legacyHolds, observeLifecycle, adminCommand } = messageFixture();
    const held = createUpdate();
    await service.handleUpdate(held);
    expect(legacyHolds.isUpdateHeld).toHaveBeenCalledWith(held);
    expect(legacyHolds.readFreshCommandReceipt).not.toHaveBeenCalled();
    expect(observeLifecycle).not.toHaveBeenCalled();
    expect(adminCommand).not.toHaveBeenCalled();
    expect(detect).not.toHaveBeenCalled();
    const independent = createUpdate();
    independent.message!.senderId = 'independent';
    await service.handleUpdate(independent);
    expect(detect).toHaveBeenCalledTimes(1);
    expect(observeLifecycle).toHaveBeenCalledTimes(1);
  });

  it('admits only the exact fresh persisted admin command after current bot and actor checks', async () => {
    const { service, detect, legacyHolds, admin, adminCommand, observeLifecycle, maxClient } =
      messageFixture();
    const { source, proof } = freshCommand();
    await service.handleUpdate(source, undefined, proof.receiptId);
    expect(adminCommand).not.toHaveBeenCalled();
    expect(maxClient.getChatMemberAccess).not.toHaveBeenCalled();
    legacyHolds.readFreshCommandReceipt.mockResolvedValue(proof);
    await service.handleUpdate(source, undefined, proof.receiptId);
    expect(legacyHolds.readFreshCommandReceipt).toHaveBeenLastCalledWith(proof.receiptId, source);
    expect(maxClient.getCurrentChatMemberAccess).toHaveBeenCalledWith(
      proof.chatId,
      expect.objectContaining({ botId: 'major-1', bypassCache: true }),
    );
    expect(maxClient.getChatMemberAccess).toHaveBeenCalledWith(
      proof.chatId,
      proof.userId,
      expect.objectContaining({ botId: 'major-1', bypassCache: true }),
    );
    expect(adminCommand).toHaveBeenCalledTimes(1);
    expect(adminCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        update: source,
        senderId: proof.userId,
        messageId: proof.messageId,
      }),
    );
    expect(admin).not.toHaveBeenCalled();
    expect(observeLifecycle).not.toHaveBeenCalled();
    expect(detect).not.toHaveBeenCalled();
  });

  it.each(['expired', 'start', 'bot-denied', 'actor-denied'] as const)(
    'does not admit %s held command evidence into ordinary moderation',
    async (reason) => {
      const { service, detect, legacyHolds, adminCommand, observeLifecycle, maxClient } =
        messageFixture();
      const { source, proof } = freshCommand(reason === 'start' ? 'Старт' : 'тишина выкл');
      if (reason === 'expired') proof.deadlineAt = new Date(Date.now() - 1);
      if (reason === 'start') proof.kind = 'START';
      if (reason === 'bot-denied')
        maxClient.getCurrentChatMemberAccess.mockResolvedValue({ isAdmin: false });
      if (reason === 'actor-denied')
        maxClient.getChatMemberAccess.mockResolvedValue({ isAdmin: false });
      legacyHolds.readFreshCommandReceipt.mockResolvedValue(proof);
      await service.handleUpdate(source, undefined, proof.receiptId);
      expect(adminCommand).not.toHaveBeenCalled();
      expect(observeLifecycle).not.toHaveBeenCalled();
      expect(detect).not.toHaveBeenCalled();
    },
  );

  it('denies a held callback and preserves an independent callback', async () => {
    const { service, detect, legacyHolds } = messageFixture();
    const tryHandleCallback = jest.fn().mockResolvedValue(true);
    Object.assign(service, { managedPollService: { tryHandleCallback } });
    const callback = createUpdate();
    callback.type = 'message_callback';
    await service.handleUpdate(callback);
    expect(tryHandleCallback).not.toHaveBeenCalled();
    const independent = structuredClone(callback);
    independent.message!.senderId = 'independent';
    await service.handleUpdate(independent);
    expect(tryHandleCallback).toHaveBeenCalledTimes(1);
    expect(tryHandleCallback).toHaveBeenCalledWith(independent);
    expect(legacyHolds.isGlobalUserHeld).not.toHaveBeenCalled();
    expect(detect).not.toHaveBeenCalled();
  });

  it('preserves exact source attribution when a generic sanction notice reaches durable SEND', async () => {
    const send = jest.fn().mockResolvedValue(true);
    await deliverSanctionNotice({
      notice: {
        chatId: 'chat',
        userId: 'actor',
        messageId: 'original',
        userLabel: 'User',
        deleteBotMessagesEnabled: false,
        deleteBotMessagesDelayMinutes: 0,
        botSpeechStyle: null,
        ledgerContext: { moderationNoticeEnvelope: { version: 1 } },
      },
      action: 'UNMUTE',
      text: 'Existing product notice',
      send,
      logger: { warn: jest.fn() },
    });
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        ledgerContext: {
          moderationNoticeEnvelope: { version: 1 },
          moderationSource: { version: 1, chatId: 'chat', userId: 'actor', messageId: 'original' },
        },
      }),
    );
  });
});
