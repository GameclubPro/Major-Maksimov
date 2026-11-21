import type { ModerationDeleteIntentService } from './moderation-delete-intent.service';
import type { ModerationRuleFollowupService } from './moderation-rule-followup.service';
import { ModerationRuleFollowupSourceExpiredError } from './moderation-rule-followup-persistence';
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
  createdAt: new Date().toISOString(),
  updateType: 'message_created',
  reason: 'Detected in 6 unique chats within 2 minutes',
};

function attachFollowupDoubles(service: ModerationService) {
  const ensure = jest
    .fn<
      ReturnType<ModerationDeleteIntentService['ensureIntentWithRuleFollowup']>,
      Parameters<ModerationDeleteIntentService['ensureIntentWithRuleFollowup']>
    >()
    .mockResolvedValue({ followupId: 'own-continuation' });
  const attempt = jest
    .fn<
      ReturnType<ModerationRuleFollowupService['attempt']>,
      Parameters<ModerationRuleFollowupService['attempt']>
    >()
    .mockResolvedValue(true);
  Object.assign(service, {
    moderationDeleteIntentService: { ensureIntentWithRuleFollowup: ensure },
    moderationRuleFollowupService: { attempt },
  });
  return { ensure, attempt };
}

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
  const { ensure, attempt } = attachFollowupDoubles(service);
  const execute = jest.spyOn(internal, 'executeModerationDelete').mockResolvedValue({
    accepted: true,
    gone: true,
    deleted: true,
    ownReasonVerified: true,
  });
  const claim = jest.spyOn(internal, 'claimMessageScopedModerationAction').mockResolvedValue(true);
  const kick = jest.spyOn(internal, 'kickAndLogKnownSpammerEvent').mockResolvedValue(true);
  return { internal, ensure, execute, claim, kick, attempt };
}

describe.each([
  'handleKnownSpammerSenderMessage',
  'handleLocalAdminBlockedSenderMessage',
  'deleteAndKickDetectedGlobalSpammer',
])('%s deletion ownership', (handler) => {
  it('registers before DELETE, then hands only the exact confirmed result to its continuation', async () => {
    const h = createHarness();
    await expect(h.internal[handler](message)).resolves.toBe(true);
    expect(h.ensure).toHaveBeenCalledWith(
      expect.objectContaining({
        messageId: message.messageId,
        sourceMessageAt: message.createdAt,
        subjectUserId: message.userId,
      }),
      expect.stringMatching(/^[0-9a-f]{64}$/u),
      expect.objectContaining({ version: 1, updateType: 'message_created' }),
    );
    expect(h.execute).toHaveBeenCalledTimes(1);
    expect(h.ensure.mock.invocationCallOrder[0]).toBeLessThan(
      h.execute.mock.invocationCallOrder[0],
    );
    expect(h.execute.mock.invocationCallOrder[0]).toBeLessThan(
      h.attempt.mock.invocationCallOrder[0],
    );
    expect(h.attempt).toHaveBeenCalledWith('own-continuation');
    expect(h.claim).not.toHaveBeenCalled();
    expect(h.kick).not.toHaveBeenCalled();
  });

  it('cannot attach a new KICK to an already settled DELETE', async () => {
    const h = createHarness();
    h.ensure.mockResolvedValue({ followupId: null });
    await expect(h.internal[handler](message)).resolves.toBe(true);
    expect(h.attempt).not.toHaveBeenCalled();
  });

  it('declines an expired source before deletion or dispatch', async () => {
    const h = createHarness();
    h.ensure.mockRejectedValue(new ModerationRuleFollowupSourceExpiredError('expired'));
    await expect(h.internal[handler](message)).resolves.toBe(false);
    expect(h.execute).not.toHaveBeenCalled();
    expect(h.attempt).not.toHaveBeenCalled();
  });

  it('continues other message checks when DELETE was not accepted', async () => {
    const h = createHarness();
    h.execute.mockResolvedValue({ accepted: false, gone: false, deleted: false });

    await expect(h.internal[handler](message)).resolves.toBe(false);

    expect(h.execute).toHaveBeenCalledTimes(1);
    expect(h.attempt).not.toHaveBeenCalled();
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
    expect(h.attempt).not.toHaveBeenCalled();
    expect(h.kick).not.toHaveBeenCalled();
  });

  it('does not acquire a sanction claim for an absent message or another reason’s deletion', async () => {
    const h = createHarness();
    h.execute.mockResolvedValue({ accepted: true, gone: true, deleted: true });
    await expect(h.internal[handler](message)).resolves.toBe(true);
    expect(h.attempt).not.toHaveBeenCalled();
    expect(h.kick).not.toHaveBeenCalled();
  });

  it('propagates intent persistence failure before any MAX action or sanction claim', async () => {
    const h = createHarness();
    h.ensure.mockRejectedValue(new Error('intent persistence unavailable'));

    await expect(h.internal[handler](message)).rejects.toThrow('intent persistence unavailable');

    expect(h.execute).not.toHaveBeenCalled();
    expect(h.attempt).not.toHaveBeenCalled();
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
    const persistence = createDeferred<{ followupId: string }>();
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

      persistence.resolve({ followupId: 'delayed-continuation' });
      await expect(operation).resolves.toEqual({ handled: true, skipKnownSpammerCheck: true });
      expect(h.execute).toHaveBeenCalledTimes(1);
      expect(h.attempt).toHaveBeenCalledWith('delayed-continuation');
      expect(h.kick).not.toHaveBeenCalled();
    } finally {
      persistence.resolve({ followupId: 'delayed-continuation' });
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
    attachFollowupDoubles(service);
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
