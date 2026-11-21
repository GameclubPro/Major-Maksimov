import {
  ModerationService,
  createDeferred,
  createSettings,
  createUpdate,
  GLOBAL_SPAMMER_CONFIRMED_FANOUT_EPISODE_THRESHOLD,
  GLOBAL_SPAMMER_HIGH_FANOUT_MIN_CHATS,
  GLOBAL_SPAMMER_TRACK_HOT_PATH_TIMEOUT_MS,
} from './moderation.service.spec-support';

const message = {
  chatId: 'chat-spammer-delete',
  userId: 'user-spammer-delete',
  messageId: 'message-spammer-delete',
  text: 'https://vk.me/123456789',
  createdAt: '2026-09-24T00:00:00.000Z',
  reason: 'Detected in 6 unique chats within 2 minutes',
};

function createHarness() {
  const prisma = {
    globalSpammer: { upsert: jest.fn().mockResolvedValue({}) },
  };
  const redis = {
    addToSetWithTtl: jest
      .fn()
      .mockResolvedValueOnce({ added: true, size: GLOBAL_SPAMMER_HIGH_FANOUT_MIN_CHATS })
      .mockResolvedValueOnce({ added: true, size: 1 }),
    incrementWithTtl: jest
      .fn()
      .mockResolvedValue(GLOBAL_SPAMMER_CONFIRMED_FANOUT_EPISODE_THRESHOLD),
  };
  const service = new ModerationService(
    prisma as never,
    {} as never,
    {} as never,
    {} as never,
    undefined,
    undefined,
    undefined,
    redis as never,
  );
  const internal = service as any;
  jest.spyOn(internal, 'isUserKnownGlobalSpammer').mockResolvedValue(true);
  jest.spyOn(internal.logger, 'warn').mockImplementation(() => undefined);
  const ensure = jest.spyOn(internal, 'ensureModerationDeleteIntent').mockResolvedValue(undefined);
  const execute = jest.spyOn(internal, 'executeModerationDelete').mockResolvedValue({
    accepted: true,
    gone: true,
    deleted: true,
    ownReasonVerified: true,
  });
  const claim = jest.spyOn(internal, 'claimMessageScopedModerationAction').mockResolvedValue(true);
  const kick = jest.spyOn(internal, 'kickAndLogKnownSpammerEvent').mockResolvedValue(true);
  return { internal, ensure, execute, claim, kick };
}

describe.each([
  'handleKnownSpammerSenderMessage',
  'handleLocalAdminBlockedSenderMessage',
  'deleteAndKickDetectedGlobalSpammer',
])('%s deletion ownership', (handler) => {
  it('retries deletion independently of an existing sanction claim', async () => {
    const h = createHarness();
    h.claim.mockResolvedValue(false);

    await expect(h.internal[handler](message)).resolves.toBe(true);

    expect(h.ensure).toHaveBeenCalledWith(
      expect.objectContaining({
        messageId: message.messageId,
        sourceMessageAt: message.createdAt,
      }),
    );
    expect(h.execute).toHaveBeenCalledTimes(1);
    expect(h.ensure.mock.invocationCallOrder[0]).toBeLessThan(
      h.execute.mock.invocationCallOrder[0],
    );
    expect(h.execute.mock.invocationCallOrder[0]).toBeLessThan(h.claim.mock.invocationCallOrder[0]);
    expect(h.kick).not.toHaveBeenCalled();
  });

  it.each([true, false])('does not treat a kick as deletion when claim=%s', async (claimed) => {
    const h = createHarness();
    h.claim.mockResolvedValue(claimed);
    h.execute.mockResolvedValue({ accepted: false, gone: false, deleted: false });

    await expect(h.internal[handler](message)).resolves.toBe(false);

    expect(h.execute).toHaveBeenCalledTimes(1);
    expect(h.claim).not.toHaveBeenCalled();
    expect(h.kick).not.toHaveBeenCalled();
  });

  it('continues independent moderation after an execution error without excluding the author', async () => {
    const h = createHarness();
    h.execute.mockRejectedValue(new Error('MAX delete unavailable'));

    await expect(h.internal[handler](message)).resolves.toBe(false);

    expect(h.kick).not.toHaveBeenCalled();
  });

  it('accepts durable pending deletion without claiming remote removal', async () => {
    const h = createHarness();
    h.execute.mockResolvedValue({ accepted: true, gone: false, deleted: false });
    await expect(h.internal[handler](message)).resolves.toBe(true);
    expect(h.claim).not.toHaveBeenCalled();
    expect(h.kick).not.toHaveBeenCalled();
  });

  it('does not acquire a sanction claim for an absent message or another reason’s deletion', async () => {
    const h = createHarness();
    h.execute.mockResolvedValue({ accepted: true, gone: true, deleted: true });
    await expect(h.internal[handler](message)).resolves.toBe(true);
    expect(h.claim).not.toHaveBeenCalled();
    expect(h.kick).not.toHaveBeenCalled();
  });

  it('propagates intent persistence failure before any MAX action or sanction claim', async () => {
    const h = createHarness();
    h.ensure.mockRejectedValue(new Error('intent persistence unavailable'));

    await expect(h.internal[handler](message)).rejects.toThrow('intent persistence unavailable');

    expect(h.execute).not.toHaveBeenCalled();
    expect(h.claim).not.toHaveBeenCalled();
    expect(h.kick).not.toHaveBeenCalled();
  });
});

describe('global spammer tracking handoff', () => {
  const tracking = { ...message, deleteSpammersEnabled: true, exemptFromEnforcement: false };

  it('only produces an enforcement decision inside the budgeted observation stage', async () => {
    const h = createHarness();

    await expect(h.internal.trackAndRegisterGlobalSpammer(tracking)).resolves.toEqual({
      handled: false,
      skipKnownSpammerCheck: true,
      enforcementReady: true,
    });

    expect(h.ensure).not.toHaveBeenCalled();
    expect(h.execute).not.toHaveBeenCalled();
    expect(h.kick).not.toHaveBeenCalled();
  });

  it('keeps enforcement awaited beyond the observation timeout', async () => {
    jest.useFakeTimers();
    const h = createHarness();
    const persistence = createDeferred<void>();
    const started = createDeferred<void>();
    h.ensure.mockImplementation(() => {
      started.resolve();
      return persistence.promise;
    });
    let settled = false;
    try {
      const operation = h.internal.trackAndRegisterGlobalSpammerWithHotPathBudget(tracking);
      void operation.then(() => {
        settled = true;
      });
      await started.promise;
      await jest.advanceTimersByTimeAsync(GLOBAL_SPAMMER_TRACK_HOT_PATH_TIMEOUT_MS * 2);
      expect(settled).toBe(false);
      expect(h.execute).not.toHaveBeenCalled();

      persistence.resolve();
      await expect(operation).resolves.toEqual({ handled: true, skipKnownSpammerCheck: true });
      expect(h.execute).toHaveBeenCalledTimes(1);
      expect(h.kick).toHaveBeenCalledTimes(1);
    } finally {
      persistence.resolve();
      jest.useRealTimers();
    }
  });

  it('does not acknowledge the webhook when detected-spammer intent persistence fails', async () => {
    const h = createHarness();
    h.ensure.mockRejectedValue(new Error('intent persistence unavailable'));

    await expect(
      h.internal.trackAndRegisterGlobalSpammerWithHotPathBudget(tracking),
    ).rejects.toThrow('intent persistence unavailable');

    expect(h.execute).not.toHaveBeenCalled();
    expect(h.kick).not.toHaveBeenCalled();
  });

  it('keeps later link checks available when detected-spammer deletion is not accepted', async () => {
    const h = createHarness();
    h.execute.mockResolvedValue({ accepted: false, gone: false, deleted: false });

    await expect(
      h.internal.trackAndRegisterGlobalSpammerWithHotPathBudget(tracking),
    ).resolves.toEqual({ handled: false, skipKnownSpammerCheck: true });
  });
});

describe('spammer deletion in the message pipeline', () => {
  function pipelineHarness() {
    const ruleEngine = { detect: jest.fn().mockResolvedValue({ violations: [] }) };
    const service = new ModerationService(
      {
        chat: {
          upsert: jest.fn().mockResolvedValue({
            id: 'chat-1',
            title: 'Chat 1',
            settings: createSettings({ deleteSpammersEnabled: true }),
            domains: [],
            admins: [],
          }),
        },
        moderationEvent: { findFirst: jest.fn().mockResolvedValue(null) },
        webhookEvent: { findUnique: jest.fn(), update: jest.fn() },
      } as never,
      ruleEngine as never,
      {} as never,
      {} as never,
    );
    const internal = service as any;
    jest.spyOn(internal, 'isUserKnownGlobalSpammer').mockResolvedValue(true);
    jest.spyOn(internal, 'ensureModerationDeleteIntent').mockResolvedValue(undefined);
    jest.spyOn(internal, 'executeModerationDelete').mockResolvedValue({
      accepted: false,
      gone: false,
      deleted: false,
    });
    jest.spyOn(internal, 'claimMessageScopedModerationAction').mockResolvedValue(true);
    const kick = jest.spyOn(internal, 'kickAndLogKnownSpammerEvent').mockResolvedValue(true);
    return { service, internal, ruleEngine, kick };
  }

  it.each(['known', 'local'])(
    'still checks links after a %s-spammer deletion is rejected',
    async (source) => {
      const h = pipelineHarness();
      jest
        .spyOn(h.internal, 'resolveGlobalSpammerAdminDecisionsWithHotPathBudget')
        .mockResolvedValue(new Map(source === 'local' ? [['user-1', 'BLOCK']] : []));

      await h.service.handleUpdate(createUpdate());

      expect(h.kick).not.toHaveBeenCalled();
      expect(h.ruleEngine.detect).toHaveBeenCalledTimes(1);
    },
  );
});
