import type { AdminService } from '../admin/admin.service';
import { createGroupCommandAuthorityMock } from '../common/group-command-authority.spec-support';
import {
  createAdminForwardedRulesUpdate,
  createAdminForwardedBanUpdate,
  createModerationServiceWithManualBridge,
  createSettings,
  createUpdate,
  type MaxUpdate,
} from './moderation.service.spec-support';

describe('mandatory GROUP command authority', () => {
  function fixture(authority = createGroupCommandAuthorityMock()) {
    const manualBridge = {
      applyManualChatSilenceCommand: jest
        .fn()
        .mockResolvedValue({ ok: true, message: 'Чат закрыт.' }),
      applyManualOpenChatCommand: jest
        .fn<
          ReturnType<AdminService['applyManualOpenChatCommand']>,
          Parameters<AdminService['applyManualOpenChatCommand']>
        >()
        .mockResolvedValue({ ok: true, message: 'Чат открыт.' }),
      adoptChatRulesFromMessage: jest.fn().mockResolvedValue({ text: 'Правила' }),
      enqueueManualGroupModerationCommand: jest.fn().mockResolvedValue(true),
      enqueueDeveloperSuperBanCommand: jest.fn().mockResolvedValue(true),
      isSuperBanDeveloperUserId: jest.fn().mockReturnValue(false),
    };
    const maxClient = {
      sendMessage: jest.fn(
        async (
          _chat: unknown,
          _text: unknown,
          _body: unknown,
          options: { beforeImmediateSendMutation?: () => Promise<void>; idempotencyKey?: string },
        ) => options.beforeImmediateSendMutation?.(),
      ),
    };
    const service = createModerationServiceWithManualBridge({
      prisma: {},
      ruleEngine: {},
      sanctionService: {},
      maxClient,
      manualBridge,
      groupCommandAuthority: authority,
    });
    const cleanup = jest.fn().mockResolvedValue(undefined);
    Object.assign(service, { deleteAdminCommandMessage: cleanup });
    const settings = createSettings();
    const handle = (update: MaxUpdate) =>
      (
        service as unknown as {
          handleAdminForwardedModerationCommand: (input: unknown) => Promise<boolean>;
        }
      ).handleAdminForwardedModerationCommand({
        update,
        settings,
        chatId: 'chat-1',
        senderId: 'admin-1',
        messageId: update.message!.messageId,
      });
    return { manualBridge, maxClient, service, authority, cleanup, handle };
  }

  it.each(['off', 'shadow'].flatMap((mode) => [1, 4, 9].map((bots) => ({ mode, bots }))))(
    'runs one settings mutation and one notice with $bots bots in canonical $mode',
    async ({ mode, bots }) => {
      const authority = createGroupCommandAuthorityMock();
      const peers = Array.from({ length: bots }, () => fixture(authority));
      for (const peer of peers)
        Object.assign(peer.service, {
          injectedWebhookCanonicalExecutionService: {
            isEnabledForChat: () => mode !== 'off',
            acquireExecution: jest.fn(() => {
              throw new Error('Optional canonical mode must not own GROUP commands');
            }),
          },
        });
      const base = createUpdate();
      const updates = peers.map((_, index) => ({
        ...base,
        botId: `bot-${index + 1}`,
        updateId: `mirror-${index}`,
        message: {
          ...base.message!,
          messageId: 'shared-silence-command',
          senderId: 'admin-1',
          text: 'тишина 12',
        },
      }));
      expect(await Promise.all(peers.map((peer, index) => peer.handle(updates[index]!)))).toEqual(
        Array(bots).fill(true),
      );
      expect(
        peers.reduce(
          (count, peer) =>
            count + peer.manualBridge.applyManualChatSilenceCommand.mock.calls.length,
          0,
        ),
      ).toBe(1);
      expect(
        peers.reduce((count, peer) => count + peer.maxClient.sendMessage.mock.calls.length, 0),
      ).toBe(1);
      expect(peers.reduce((count, peer) => count + peer.cleanup.mock.calls.length, 0)).toBe(1);
      expect(authority.prepareResult).toHaveBeenCalledTimes(1);
      expect(authority.complete).toHaveBeenCalledTimes(1);
    },
  );

  it.each(['тишина выкл', 'правило'])(
    'deduplicates %s side effects and notices for twelve replicas',
    async (text) => {
      const authority = createGroupCommandAuthorityMock();
      const peers = Array.from({ length: 12 }, () => fixture(authority));
      const base = text === 'правило' ? createAdminForwardedRulesUpdate() : createUpdate();
      await Promise.all(
        peers.map((peer, index) =>
          peer.handle({
            ...base,
            botId: `bot-${index + 1}`,
            updateId: `mirror-${index}`,
            message: { ...base.message!, text, senderId: 'admin-1' },
          }),
        ),
      );
      const calls = peers.reduce(
        (count, peer) =>
          count +
          (text === 'правило'
            ? peer.manualBridge.adoptChatRulesFromMessage.mock.calls.length
            : peer.manualBridge.applyManualOpenChatCommand.mock.calls.length),
        0,
      );
      expect(calls).toBe(1);
      expect(
        peers.reduce((count, peer) => count + peer.maxClient.sendMessage.mock.calls.length, 0),
      ).toBe(1);
    },
  );

  it.each(['бан', 'тишина 0'])(
    'publishes one missing-target or invalid-input notice for %s',
    async (text) => {
      const authority = createGroupCommandAuthorityMock();
      const peers = Array.from({ length: 9 }, () => fixture(authority));
      const base = createUpdate();
      await Promise.all(
        peers.map((peer, index) =>
          peer.handle({
            ...base,
            botId: `bot-${index + 1}`,
            updateId: `mirror-${index}`,
            message: { ...base.message!, text, senderId: 'admin-1' },
          }),
        ),
      );
      expect(
        peers.reduce((count, peer) => count + peer.maxClient.sendMessage.mock.calls.length, 0),
      ).toBe(1);
      expect(
        peers.reduce(
          (count, peer) =>
            count + peer.manualBridge.enqueueManualGroupModerationCommand.mock.calls.length,
          0,
        ),
      ).toBe(0);
    },
  );

  it.each([
    ['тишина 12', 'applyManualChatSilenceCommand'],
    ['тишина выкл', 'applyManualOpenChatCommand'],
  ] as const)(
    'keeps a failed %s command silent without claiming an outcome',
    async (text, method) => {
      const peer = fixture();
      const failure = new Error('settings transaction outcome unknown');
      peer.manualBridge[method].mockRejectedValueOnce(failure);
      const base = createUpdate();
      const update = {
        ...base,
        botId: 'bot-1',
        message: { ...base.message!, text, senderId: 'admin-1' },
      };

      await expect(peer.handle(update)).rejects.toBe(failure);

      expect(peer.cleanup).not.toHaveBeenCalled();
      expect(peer.maxClient.sendMessage).not.toHaveBeenCalled();
      expect(peer.authority.prepareResult).not.toHaveBeenCalled();
      expect(peer.authority.complete).not.toHaveBeenCalled();
      expect(peer.authority.release).toHaveBeenCalledTimes(1);
    },
  );

  it('resumes only the committed opening notice after the settings call loses its response', async () => {
    const authority = createGroupCommandAuthorityMock();
    const first = fixture(authority);
    const peer = fixture(authority);
    const message = 'Ручное закрытие снято. Чат остаётся закрыт по ночному расписанию.';
    const failure = new Error('connection lost after commit');
    first.manualBridge.applyManualOpenChatCommand.mockImplementationOnce(
      async (_chat, _actor, _source, permit) => {
        if (!permit) throw new Error('Missing GROUP identity');
        await authority.prepareResult(permit, {
          action: 'OPEN_CHAT',
          applied: true,
          noticeText: message,
        });
        throw failure;
      },
    );
    const base = createUpdate();
    const update = {
      ...base,
      botId: 'bot-1',
      message: { ...base.message!, text: 'тишина выкл', senderId: 'admin-1' },
    };

    await expect(first.handle(update)).rejects.toBe(failure);
    expect(first.maxClient.sendMessage).not.toHaveBeenCalled();
    await expect(peer.handle({ ...update, botId: 'bot-2' })).resolves.toBe(true);

    expect(peer.manualBridge.applyManualOpenChatCommand).not.toHaveBeenCalled();
    expect(peer.maxClient.sendMessage).toHaveBeenCalledTimes(1);
    expect(peer.maxClient.sendMessage.mock.calls[0]?.[1]).toBe(message);
    expect(authority.prepareResult).toHaveBeenCalledTimes(1);
    expect(authority.complete).toHaveBeenCalledTimes(1);
  });

  it('resumes a saved notice on the original token without replaying the settings mutation', async () => {
    const authority = createGroupCommandAuthorityMock();
    const first = fixture(authority);
    const peer = fixture(authority);
    first.maxClient.sendMessage.mockRejectedValueOnce(
      new Error('rate governor blocked before dispatch'),
    );
    const base = createUpdate();
    const update = {
      ...base,
      botId: 'bot-1',
      message: { ...base.message!, text: 'тишина 12', senderId: 'admin-1' },
    };
    await expect(first.handle(update)).rejects.toThrow('notice delivery remains pending');
    await expect(
      peer.handle({ ...update, botId: 'bot-2', updateId: 'resumed-notice' }),
    ).resolves.toBe(true);
    expect(first.manualBridge.applyManualChatSilenceCommand).toHaveBeenCalledTimes(1);
    expect(peer.manualBridge.applyManualChatSilenceCommand).not.toHaveBeenCalled();
    expect(peer.maxClient.sendMessage.mock.calls[0]?.[3]).toEqual(
      expect.objectContaining({
        botId: 'bot-1',
        candidateBotIds: ['bot-1'],
        routing: { purpose: 'send_message', requiredBotId: 'bot-1' },
        beforeImmediateSendMutation: expect.any(Function),
      }),
    );
    expect(first.maxClient.sendMessage.mock.calls[0]?.[3]).toEqual(
      expect.objectContaining({
        idempotencyKey: peer.maxClient.sendMessage.mock.calls[0]?.[3]?.idempotencyKey,
      }),
    );
    expect(authority.prepareResult).toHaveBeenCalledTimes(1);
    expect(authority.complete).toHaveBeenCalledTimes(1);
  });

  it.each([
    { text: 'бан', action: 'BAN' },
    { text: 'мут 2', action: 'MUTE' },
    { text: 'супер бан', action: 'SUPER_BAN' },
  ])('records one silent queued $action result for nine bot mirrors', async ({ text, action }) => {
    const authority = createGroupCommandAuthorityMock();
    const peers = Array.from({ length: 9 }, () => fixture(authority));
    for (const peer of peers) peer.manualBridge.isSuperBanDeveloperUserId.mockReturnValue(true);
    const base = createAdminForwardedBanUpdate(text);
    await Promise.all(
      peers.map((peer, index) =>
        peer.handle({ ...base, botId: `bot-${index + 1}`, updateId: `mirror-${index}` }),
      ),
    );
    expect(
      peers.reduce(
        (count, peer) =>
          count +
          peer.manualBridge.enqueueManualGroupModerationCommand.mock.calls.length +
          peer.manualBridge.enqueueDeveloperSuperBanCommand.mock.calls.length,
        0,
      ),
    ).toBe(1);
    expect(authority.prepareResult).toHaveBeenCalledTimes(1);
    expect(authority.prepareResult).toHaveBeenCalledWith(expect.anything(), {
      action,
      outcome: 'QUEUED',
      applied: false,
      noticeText: null,
    });
    expect(authority.complete).toHaveBeenCalledTimes(1);
    expect(
      peers.reduce((count, peer) => count + peer.maxClient.sendMessage.mock.calls.length, 0),
    ).toBe(0);
  });

  it('propagates result SQL failure after accepted enqueue without declaring success or sending failure', async () => {
    const authority = createGroupCommandAuthorityMock();
    const peer = fixture(authority);
    const sqlError = new Error('queue accepted; result database unavailable');
    authority.prepareResult.mockRejectedValueOnce(sqlError);
    await expect(peer.handle({ ...createAdminForwardedBanUpdate(), botId: 'bot-1' })).rejects.toBe(
      sqlError,
    );
    expect(peer.manualBridge.enqueueManualGroupModerationCommand).toHaveBeenCalledTimes(1);
    expect(authority.complete).not.toHaveBeenCalled();
    expect(authority.release).toHaveBeenCalledTimes(1);
    expect(peer.maxClient.sendMessage).not.toHaveBeenCalled();
  });

  it('records a declined enqueue as an unapplied notice without a queued result', async () => {
    const peer = fixture();
    peer.manualBridge.enqueueManualGroupModerationCommand.mockResolvedValue(false);
    await expect(peer.handle({ ...createAdminForwardedBanUpdate(), botId: 'bot-1' })).resolves.toBe(
      true,
    );
    expect(peer.authority.prepareQueuedResult).not.toHaveBeenCalled();
    expect(peer.authority.prepareResult).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'NOTICE', applied: false }),
    );
    expect(peer.authority.complete).toHaveBeenCalledTimes(1);
  });

  it('records a failed enqueue as a silent unapplied outcome', async () => {
    const peer = fixture();
    peer.manualBridge.enqueueManualGroupModerationCommand.mockRejectedValue(
      new Error('queue down'),
    );
    await expect(peer.handle({ ...createAdminForwardedBanUpdate(), botId: 'bot-1' })).resolves.toBe(
      true,
    );
    expect(peer.authority.prepareQueuedResult).not.toHaveBeenCalled();
    expect(peer.authority.prepareResult).toHaveBeenCalledWith(expect.anything(), {
      action: 'IGNORED',
      applied: false,
      noticeText: null,
    });
    expect(peer.authority.complete).toHaveBeenCalledTimes(1);
    expect(peer.maxClient.sendMessage).not.toHaveBeenCalled();
  });

  it('settles an ignored RULES command without claiming a rules mutation', async () => {
    const peer = fixture();
    const base = createUpdate();
    await expect(
      peer.handle({ ...base, botId: 'bot-1', message: { ...base.message!, text: 'правило' } }),
    ).resolves.toBe(false);
    expect(peer.authority.prepareResult).toHaveBeenCalledWith(expect.anything(), {
      action: 'IGNORED',
      applied: false,
      noticeText: null,
    });
    expect(peer.authority.complete).toHaveBeenCalledTimes(1);
    expect(peer.manualBridge.adoptChatRulesFromMessage).not.toHaveBeenCalled();
    expect(peer.maxClient.sendMessage).not.toHaveBeenCalled();
  });
});
