import type { KaravanMarketplaceResolverService } from '../integrations/karavan-marketplace/karavan-marketplace-resolver.service';
import { UnrecoverableError } from 'bullmq';
import { buildNightModeTransitionScheduleFingerprint } from '../moderation/night-mode-transition-generation.util';
import {
  isMaxActionNoExecutableRouteError,
  isMaxActionRouteQuarantinedError,
  MaxActionDispatchService,
  MaxActionNoExecutableRouteError,
  MaxActionRouteQuarantinedError,
} from './max-action-dispatch.service';
import {
  markMaxPreDispatchGuardRejected,
  wasMaxPreDispatchGuardRejected,
} from './max-action-pre-dispatch-guard';
import {
  MAX_SEND_AUTO_DELETE_CONFIRMATION_KINDS,
  MAX_SEND_AUTO_DELETE_MARKER_VERSION,
  MaxApiCircuitOpenError,
  type MaxClientService,
  type MaxActionJob,
  type MaxActionLedgerContext,
} from './max-client.service';
import type { RecordManagedEntityAccessLostFromErrorResult } from './managed-entity-access-loss.service';
import {
  MAX_MEDIA_UPLOAD_VALIDATION_ERROR_CODES,
  MaxMediaUploadValidationError,
} from './max-media-upload-validation';
import { createMaxSendAutoDeleteVerificationError } from './max-send-auto-delete-verification-error';
import type { MaxBotLinkService } from './max-bot-link.service';
import type { StorageRuntimeMetricsService } from '../system/storage-runtime-metrics.service';
import { OptimizationRuntimeMetrics } from '../system/optimization-runtime-metrics';

const FUTURE_NIGHT_SCHEDULE_FINGERPRINT = buildNightModeTransitionScheduleFingerprint({
  nightModeEnabled: true,
  nightModeStartTimeMinutes: 23 * 60,
  nightModeEndTimeMinutes: 8 * 60,
  nightModeTimezone: 'Europe/Moscow',
});

function createMaxApiError(status: number, message: string, code?: string): Error {
  return Object.assign(new Error(message), {
    response: {
      status,
      data: {
        ...(code ? { code } : {}),
        message,
      },
    },
  });
}

function createSendAutoDeleteJob(): MaxActionJob {
  return {
    actionType: 'DELETE_MESSAGE',
    chatId: 'chat-sensitive',
    botId: 'bot-1',
    messageId: 'message-sensitive',
    sendAutoDelete: {
      version: MAX_SEND_AUTO_DELETE_MARKER_VERSION,
      sourceSendJobId: 'send-job-sensitive',
      sourceSendCompletedAt: '2026-09-03T08:00:00.000Z',
      requestedDelayMs: 60_000,
      originBotId: 'bot-1',
    },
    attempt: 1,
    idempotencyKey: 'auto-delete-job-sensitive',
    createdAt: '2026-09-03T08:01:00.000Z',
  } as MaxActionJob;
}

function createLegacyHoldFixture(
  karavan?: Pick<KaravanMarketplaceResolverService, 'assertDispatch'>,
) {
  const holds = {
    isMessageHeld: jest.fn().mockResolvedValue(false),
    isMemberHeld: jest.fn().mockResolvedValue(false),
    isGlobalUserHeld: jest.fn().mockResolvedValue(false),
    isLegacyChatSendHeld: jest.fn().mockResolvedValue(false),
    isOutboundJobHeld: jest.fn().mockResolvedValue(false),
  };
  const effect = jest.fn();
  const max = {
    executeActionJob: jest.fn(
      async (
        job: MaxActionJob,
        options?: {
          beforeSendMutation?: () => Promise<void>;
          beforeDeleteMutation?: () => Promise<void>;
          beforeMemberMutation?: () => Promise<void>;
        },
      ) => {
        const guard =
          job.actionType === 'SEND_MESSAGE'
            ? options?.beforeSendMutation
            : job.actionType === 'DELETE_MESSAGE'
              ? options?.beforeDeleteMutation
              : options?.beforeMemberMutation;
        await guard?.();
        effect();
      },
    ),
  };
  const ledger = {
    getCompletedSendDispatchResult: jest.fn().mockResolvedValue(null),
    assertCanExecute: jest.fn().mockResolvedValue(undefined),
    recordStarted: jest.fn().mockResolvedValue(undefined),
    recordPrepared: jest.fn().mockResolvedValue(undefined),
    recordSucceeded: jest.fn().mockResolvedValue(undefined),
    recordFailed: jest.fn(async (_job: MaxActionJob, _error: unknown) => {}),
  };
  const service = new MaxActionDispatchService(
    max as never,
    undefined,
    ledger as never,
    undefined,
    undefined,
    holds as never,
    karavan as never,
  );
  const job: MaxActionJob = {
    actionType: 'SEND_MESSAGE',
    chatId: 'held-chat',
    text: 'Fixture publication',
    botId: 'fixture-bot',
    attempt: 1,
    idempotencyKey: 'fixture-outbound',
    createdAt: new Date().toISOString(),
  };
  return { holds, effect, max, ledger, service, job };
}

describe('MaxActionDispatchService', () => {
  it('separates scheduled first attempts and retry age while preserving rejected dispatch', async () => {
    const f = createLegacyHoldFixture();
    const metrics = { optimization: new OptimizationRuntimeMetrics() } satisfies Pick<
      StorageRuntimeMetricsService,
      'optimization'
    >;
    Object.defineProperty(f.service, 'metrics', { value: metrics });
    const now = Date.now();
    const clock = jest.spyOn(Date, 'now').mockReturnValue(now);
    try {
      await f.service.execute(
        { ...f.job, scheduledFor: new Date(now - 100).toISOString() },
        { enqueuedAt: new Date(now - 20000) },
      );
      const error = new Error('exact admission failure');
      f.ledger.assertCanExecute.mockRejectedValueOnce(error);
      await expect(
        f.service.execute({ ...f.job, attempt: 2 }, { enqueuedAt: new Date(now - 16000) }),
      ).rejects.toBe(error);
      const timings = metrics.optimization.snapshot()!.timings;
      expect(timings.sendFirstQueue).toMatchObject({ calls: 1, totalMs: 100 });
      expect(timings.sendRetryQueue).toMatchObject({ calls: 1, totalMs: 16000 });
      expect(timings.sendDispatch).toMatchObject({ calls: 2, errors: 1 });
      expect(timings.sendLedger).toMatchObject({ calls: 1, errors: 0 });
      expect(f.effect).toHaveBeenCalledTimes(1);
    } finally {
      clock.mockRestore();
    }
  });

  it.each(['metadata', 'source-tag'])(
    'rechecks retirement for an old queued relay identified by %s',
    async (kind) => {
      const guard = { assertDispatch: jest.fn().mockRejectedValue(new Error('Legacy retired')) };
      const f = createLegacyHoldFixture(guard);
      await expect(
        f.service.execute({
          ...f.job,
          ...(kind === 'metadata'
            ? { ledgerContext: { karavanStorefrontRelay: { variant: 'directory' } } }
            : { sourceTag: 'karavan_storefront_relay' }),
        }),
      ).rejects.toThrow('Legacy retired');
      expect(guard.assertDispatch).toHaveBeenCalled();
      expect(f.effect).not.toHaveBeenCalled();
    },
  );
  it('runs persisted Karavan scope validation at the final queued SEND_MESSAGE boundary', async () => {
    const guard = {
      assertDispatch: jest.fn().mockRejectedValue(new Error('Synthetic listing revoked')),
    };
    const f = createLegacyHoldFixture(guard);
    const job = {
      ...f.job,
      ledgerContext: { karavanMarketplacePublication: { marketplaceId: 'synthetic' } },
    };
    await expect(f.service.execute(job)).rejects.toThrow('Synthetic listing revoked');
    expect(guard.assertDispatch).toHaveBeenCalledWith(
      expect.objectContaining({ ledgerContext: job.ledgerContext }),
      'fixture-bot',
    );
    expect(f.effect).not.toHaveBeenCalled();
  });
  it('rejects a scoped queued send when its mandatory marketplace guard is absent', async () => {
    const f = createLegacyHoldFixture();
    await expect(
      f.service.execute({
        ...f.job,
        ledgerContext: { karavanMarketplacePublication: { marketplaceId: 'synthetic' } },
      }),
    ).rejects.toThrow('Karavan marketplace dispatch guard unavailable');
    expect(f.effect).not.toHaveBeenCalled();
  });

  it.each(['SEND_MESSAGE', 'DELETE_MESSAGE', 'BAN_MEMBER', 'KICK_MEMBER'] as const)(
    'denies an exact permanently held %s job before preparing another attempt',
    async (actionType) => {
      const f = createLegacyHoldFixture();
      f.holds.isOutboundJobHeld.mockResolvedValue(true);
      await expect(
        f.service.execute({
          ...f.job,
          actionType,
          messageId: 'source-message',
          userId: 'source-user',
        }),
      ).rejects.toMatchObject({ code: 'webhook_legacy_effect_held' });
      expect(f.ledger.recordStarted).not.toHaveBeenCalled();
      expect(f.max.executeActionJob).not.toHaveBeenCalled();
      expect(f.effect).not.toHaveBeenCalled();
    },
  );

  it.each(['SEND_MESSAGE', 'DELETE_MESSAGE', 'BAN_MEMBER', 'KICK_MEMBER'] as const)(
    'rechecks a new permanent %s hold after asynchronous preparation at the mutation boundary',
    async (actionType) => {
      const f = createLegacyHoldFixture();
      await expect(
        f.service.execute(
          { ...f.job, actionType, messageId: 'source-message', userId: 'source-user' },
          {
            onDispatchAttempt: async () => {
              f.holds.isOutboundJobHeld.mockResolvedValue(true);
            },
          },
        ),
      ).rejects.toMatchObject({ code: 'webhook_legacy_effect_held' });
      expect(f.ledger.recordStarted).toHaveBeenCalledTimes(1);
      expect(f.max.executeActionJob).toHaveBeenCalledTimes(1);
      expect(f.effect).not.toHaveBeenCalled();
      expect(f.ledger.recordSucceeded).not.toHaveBeenCalled();
      const rejection = f.ledger.recordFailed.mock.calls[0]?.[1];
      expect(wasMaxPreDispatchGuardRejected(rejection)).toBe(true);
    },
  );

  it('denies an unbound send from a held pre-certificate chat', async () => {
    const f = createLegacyHoldFixture();
    f.holds.isLegacyChatSendHeld.mockResolvedValue(true);
    await expect(f.service.execute(f.job)).rejects.toMatchObject({
      code: 'webhook_legacy_effect_held',
    });
    expect(f.effect).not.toHaveBeenCalled();
    expect(f.ledger.recordStarted).not.toHaveBeenCalled();
  });

  it.each(
    (
      [
        'moderationSource',
        'moderationRuleNotice',
        'requiredSubscriptionNotice',
        'duplicateNotice',
      ] as const
    ).flatMap((contextKey) =>
      (['isMessageHeld', 'isMemberHeld', 'isGlobalUserHeld'] as const).map((holdMethod) => ({
        contextKey,
        holdMethod,
      })),
    ),
  )(
    'denies a new $contextKey send using its original $holdMethod source',
    async ({ contextKey, holdMethod }) => {
      const f = createLegacyHoldFixture();
      f.holds[holdMethod].mockResolvedValue(true);
      const source: MaxActionLedgerContext[string] =
        contextKey === 'duplicateNotice'
          ? {
              version: 3,
              chatId: 'source-chat',
              binding: { messageId: 'source-message', senderId: 'source-user' },
            }
          : {
              version: 1,
              chatId: 'source-chat',
              messageId: 'source-message',
              userId: 'source-user',
            };
      await expect(
        f.service.execute({
          ...f.job,
          idempotencyKey: 'new-notice-from-another-bot',
          botId: 'surviving-bot',
          ledgerContext: { [contextKey]: source },
        }),
      ).rejects.toMatchObject({ code: 'webhook_legacy_effect_held' });
      expect(f.holds[holdMethod]).toHaveBeenCalledWith(
        ...(holdMethod === 'isMessageHeld'
          ? ['source-chat', 'source-message', undefined]
          : holdMethod === 'isMemberHeld'
            ? ['source-chat', 'source-user', undefined]
            : ['source-user', undefined]),
      );
      expect(f.max.executeActionJob).not.toHaveBeenCalled();
      expect(f.ledger.recordStarted).not.toHaveBeenCalled();
      expect(f.effect).not.toHaveBeenCalled();
    },
  );

  it('rechecks the attributed source introduced during send preparation', async () => {
    const f = createLegacyHoldFixture();
    f.holds.isMessageHeld.mockResolvedValue(true);
    const beforeSendMutation = jest.fn();
    await expect(
      f.service.execute(f.job, {
        prepareAttempt: async () => ({
          ledgerContext: {
            moderationSource: {
              version: 1,
              chatId: 'source-chat',
              messageId: 'source-message',
              userId: 'source-user',
            },
          },
        }),
        beforeSendMutation,
      }),
    ).rejects.toMatchObject({ code: 'webhook_legacy_effect_held' });
    expect(f.ledger.recordPrepared).toHaveBeenCalledTimes(1);
    expect(f.ledger.recordSucceeded).not.toHaveBeenCalled();
    expect(beforeSendMutation).not.toHaveBeenCalled();
    expect(f.effect).not.toHaveBeenCalled();
  });

  it('fails closed when an authoritative hold lookup is unavailable', async () => {
    const f = createLegacyHoldFixture();
    const failure = new Error('Fixture authoritative legacy hold lookup failed');
    f.holds.isOutboundJobHeld.mockRejectedValue(failure);
    await expect(f.service.execute(f.job)).rejects.toBe(failure);
    expect(f.max.executeActionJob).not.toHaveBeenCalled();
    expect(f.ledger.recordStarted).not.toHaveBeenCalled();
  });

  it('does not manufacture live unban authority from the shared hold or send guards', async () => {
    const f = createLegacyHoldFixture();
    const beforeSendMutation = jest.fn();
    f.max.executeActionJob.mockImplementation(async (_job, options) => {
      if (!options?.beforeMemberMutation) {
        throw new Error('TRY_UNBAN_MEMBER requires a live guard');
      }
      f.effect();
    });
    await expect(
      f.service.execute(
        { ...f.job, actionType: 'TRY_UNBAN_MEMBER', userId: 'source-user' },
        { beforeSendMutation },
      ),
    ).rejects.toThrow('TRY_UNBAN_MEMBER requires a live guard');
    expect(f.max.executeActionJob).toHaveBeenCalledTimes(1);
    expect(f.max.executeActionJob).toHaveBeenCalledWith(
      expect.objectContaining({ actionType: 'TRY_UNBAN_MEMBER', userId: 'source-user' }),
    );
    expect(beforeSendMutation).not.toHaveBeenCalled();
    expect(f.effect).not.toHaveBeenCalled();
    expect(f.ledger.recordSucceeded).not.toHaveBeenCalled();
  });

  it('settles an exact confirmed send before consulting permanent holds', async () => {
    const f = createLegacyHoldFixture();
    f.ledger.getCompletedSendDispatchResult.mockResolvedValue({
      remoteMessageId: 'confirmed-send',
      dispatchBotId: 'original-bot',
      completedAt: new Date(),
    });
    f.holds.isOutboundJobHeld.mockResolvedValue(true);
    await expect(f.service.execute(f.job)).resolves.toMatchObject({
      messageId: 'confirmed-send',
      botId: 'original-bot',
    });
    expect(f.holds.isOutboundJobHeld).not.toHaveBeenCalled();
    expect(f.ledger.recordStarted).not.toHaveBeenCalled();
    expect(f.effect).not.toHaveBeenCalled();
  });

  it('settles a send receipt committed during a competing permanent-hold lookup', async () => {
    const f = createLegacyHoldFixture();
    f.holds.isOutboundJobHeld.mockImplementation(async () => {
      f.ledger.getCompletedSendDispatchResult.mockResolvedValue({
        remoteMessageId: 'late-confirmed-send',
        dispatchBotId: 'original-bot',
        completedAt: new Date(),
      });
      return true;
    });
    await expect(f.service.execute(f.job)).resolves.toMatchObject({
      messageId: 'late-confirmed-send',
      botId: 'original-bot',
    });
    expect(f.ledger.recordStarted).not.toHaveBeenCalled();
    expect(f.ledger.recordSucceeded).not.toHaveBeenCalled();
    expect(f.effect).not.toHaveBeenCalled();
  });

  it('checks shared holds before the caller final feature guard', async () => {
    const f = createLegacyHoldFixture();
    const order: string[] = [];
    f.holds.isOutboundJobHeld.mockImplementation(async () => {
      order.push('hold');
      return false;
    });
    f.effect.mockImplementation(() => {
      order.push('effect');
    });
    await f.service.execute(f.job, {
      onDispatchAttempt: async () => {
        order.length = 0;
      },
      beforeSendMutation: async () => {
        order.push('feature');
      },
    });
    expect(order).toEqual(['hold', 'feature', 'effect']);
  });

  it.each([1, 4, 9, 3, 6, 12])(
    'rechecks a definite capability rejection across %i bots and chooses the last eligible reserve',
    async (count) => {
      const botIds = Array.from({ length: count }, (_, i) => `bot-${i + 1}`);
      let denied = false;
      const rejection = createMaxApiError(403, 'insufficient rights');
      const maxClient = {
        executeActionJob: jest.fn(async (job: MaxActionJob) => {
          if (job.botId === botIds[0]) throw rejection;
        }),
        getCurrentChatMemberAccess: jest
          .fn()
          .mockResolvedValue({ isAdmin: false, isOwner: false, permissions: [] }),
      };
      const link = {
        getExecutableBotById: jest.fn((id: string) => ({ id })),
        isBotAccessSnapshotStale: jest.fn().mockResolvedValue(false),
        recordBotAccessProbe: jest.fn(async () => {
          denied = true;
          return true;
        }),
        resolveBotRoute: jest.fn(async () => ({
          purpose: 'moderation_action',
          action: 'moderate_member',
          chatId: 'chat-1',
          primaryBotId: botIds[0],
          botId: denied ? botIds.at(-1) : botIds[0],
          candidateBotIds: denied ? (count > 1 ? [botIds.at(-1)] : []) : botIds,
          reason: 'primary_confirmed',
          routingVersion: 1,
        })),
      };
      const service = new MaxActionDispatchService(
        maxClient as never,
        undefined,
        undefined,
        link as never,
        { get: (key: string) => (key === 'MAX_ROUTED_MUTATIONS_MODE' ? 'on' : undefined) } as never,
      );
      const task: MaxActionJob = {
        actionType: 'BAN_MEMBER',
        chatId: 'chat-1',
        userId: 'user-1',
        botId: botIds[0],
        candidateBotIds: botIds,
        routing: { purpose: 'moderation_action', action: 'moderate_member', routingVersion: 1 },
        attempt: 1,
        createdAt: new Date().toISOString(),
        idempotencyKey: 'one-logical-ban',
      };
      if (count === 1) await expect(service.execute(task)).rejects.toBe(rejection);
      else await expect(service.execute(task)).resolves.toBeUndefined();
      expect(maxClient.executeActionJob).toHaveBeenCalledTimes(count === 1 ? 1 : 2);
      if (count > 1)
        expect(maxClient.executeActionJob).toHaveBeenLastCalledWith(
          expect.objectContaining({
            botId: botIds.at(-1),
            idempotencyKey: 'one-logical-ban',
          }),
        );
      expect(maxClient.getCurrentChatMemberAccess).toHaveBeenCalledTimes(1);
    },
  );

  it.each(['SEND_MESSAGE', 'BAN_MEMBER', 'KICK_MEMBER'] as const)(
    'never dispatches a second %s after ambiguous access text',
    async (actionType) => {
      const error = createMaxApiError(500, 'not accessible: insufficient rights', 'chat.denied');
      const client = { executeActionJob: jest.fn().mockRejectedValue(error) };
      const accessLoss = {
        recordIfManagedEntityAccessLost: jest.fn().mockResolvedValue({ reason: 'bot_denied' }),
      };
      const link = {
        resolveBotRoute: jest.fn().mockResolvedValue({
          purpose: actionType === 'SEND_MESSAGE' ? 'send_message' : 'moderation_action',
          primaryBotId: 'bot-1',
          botId: 'bot-1',
          candidateBotIds: ['bot-1', 'bot-2'],
          routingVersion: 1,
        }),
        getExecutableBotById: (id: string) => ({ id }),
      };
      const service = new MaxActionDispatchService(
        client as never,
        accessLoss as never,
        undefined,
        link as never,
        { get: (key: string) => (key === 'MAX_ROUTED_MUTATIONS_MODE' ? 'on' : undefined) } as never,
      );
      await expect(
        service.execute({
          actionType,
          chatId: 'chat-1',
          botId: 'bot-1',
          userId: 'u',
          text: 'notice',
          candidateBotIds: ['bot-1', 'bot-2'],
          routing:
            actionType === 'SEND_MESSAGE'
              ? { purpose: 'send_message' }
              : { purpose: 'moderation_action', action: 'moderate_member' },
          attempt: 1,
          idempotencyKey: 'unknown-operation',
          createdAt: new Date().toISOString(),
        }),
      ).rejects.toBe(error);
      expect(client.executeActionJob).toHaveBeenCalledTimes(1);
      expect(accessLoss.recordIfManagedEntityAccessLost).not.toHaveBeenCalled();
    },
  );

  afterEach(() => {
    jest.useRealTimers();
  });

  it('executes queued MAX action jobs through the client boundary', async () => {
    const maxClient = {
      executeActionJob: jest.fn().mockResolvedValue(undefined),
    };
    const service = new MaxActionDispatchService(maxClient as never);
    const job = {
      actionType: 'DELETE_MESSAGE',
      chatId: 'chat-1',
      messageId: 'message-1',
      attempt: 2,
      idempotencyKey: 'job-1',
      createdAt: '2026-05-16T20:00:00.000Z',
    } as MaxActionJob;

    await service.execute(job);

    expect(maxClient.executeActionJob).toHaveBeenCalledWith(job);
  });

  it('executes a publisher exact send without ownership refresh or generic access-loss writes', async () => {
    const maxError = createMaxApiError(403, 'publisher lost entity access');
    const maxClient = {
      executeActionJob: jest.fn().mockRejectedValue(maxError),
    };
    const managedEntityAccessLossService = {
      recordIfManagedEntityAccessLost: jest.fn(),
    };
    const maxBotLinkService = {
      getExecutableBotById: jest.fn().mockReturnValue({ id: 'publisher-bot' }),
      resolveBotRoute: jest.fn(),
      isBotAccessSnapshotStale: jest.fn(),
      recordBotAccessProbe: jest.fn(),
    };
    const service = new MaxActionDispatchService(
      maxClient as never,
      managedEntityAccessLossService as never,
      undefined,
      maxBotLinkService as never,
    );
    const job = {
      actionType: 'SEND_MESSAGE',
      chatId: 'channel-1',
      botId: 'publisher-bot',
      candidateBotIds: ['publisher-bot'],
      routing: {
        purpose: 'publisher_exact_send',
        requiredBotId: 'publisher-bot',
      },
      text: 'VK post',
      attempt: 1,
      idempotencyKey: 'vk-parsing:publisher:post-1',
      createdAt: '2026-08-26T10:00:00.000Z',
    } as MaxActionJob;

    await expect(service.execute(job)).rejects.toBe(maxError);

    expect(maxClient.executeActionJob).toHaveBeenCalledWith(
      expect.objectContaining({ botId: 'publisher-bot' }),
    );
    expect(maxBotLinkService.resolveBotRoute).not.toHaveBeenCalled();
    expect(maxBotLinkService.isBotAccessSnapshotStale).not.toHaveBeenCalled();
    expect(managedEntityAccessLossService.recordIfManagedEntityAccessLost).not.toHaveBeenCalled();
  });

  it('records queued MAX action start and success in the ledger', async () => {
    const maxClient = {
      executeActionJob: jest.fn().mockResolvedValue(undefined),
    };
    const actionLedgerService = {
      recordStarted: jest.fn().mockResolvedValue(undefined),
      recordSucceeded: jest.fn().mockResolvedValue(undefined),
      recordSkipped: jest.fn().mockResolvedValue(undefined),
      recordFailed: jest.fn().mockResolvedValue(undefined),
    };
    const service = new MaxActionDispatchService(
      maxClient as never,
      undefined,
      actionLedgerService as never,
    );
    const job = {
      actionType: 'BAN_MEMBER',
      chatId: 'chat-1',
      botId: 'bot-1',
      userId: 'user-1',
      attempt: 2,
      idempotencyKey: 'job-ban-1',
      createdAt: '2026-07-06T20:00:00.000Z',
    } as MaxActionJob;

    await service.execute(job);

    expect(actionLedgerService.recordStarted).toHaveBeenCalledWith(job);
    expect(actionLedgerService.recordSucceeded).toHaveBeenCalledWith(job);
    expect(actionLedgerService.recordSkipped).not.toHaveBeenCalled();
    expect(actionLedgerService.recordFailed).not.toHaveBeenCalled();
  });

  it('forwards the BullMQ enqueue baseline to the ledger start transition', async () => {
    const maxClient = {
      executeActionJob: jest.fn().mockResolvedValue(undefined),
    };
    const actionLedgerService = {
      recordStarted: jest.fn().mockResolvedValue(undefined),
      recordSucceeded: jest.fn().mockResolvedValue(undefined),
    };
    const service = new MaxActionDispatchService(
      maxClient as never,
      undefined,
      actionLedgerService as never,
    );
    const job = {
      actionType: 'BAN_MEMBER',
      chatId: 'chat-1',
      botId: 'bot-1',
      userId: 'user-1',
      attempt: 1,
      idempotencyKey: 'job-ban-with-baseline',
      createdAt: '2026-07-06T20:00:00.000Z',
    } as MaxActionJob;
    const enqueuedAt = new Date('2026-07-06T20:00:01.000Z');

    await service.execute(job, { enqueuedAt });

    expect(actionLedgerService.recordStarted).toHaveBeenCalledWith(job, enqueuedAt);
  });

  it('does not reach MAX when ledger execution guard rejects a terminal race', async () => {
    const maxClient = {
      executeActionJob: jest.fn(),
    };
    const terminalRace = new UnrecoverableError('ledger is terminal');
    const actionLedgerService = {
      getCompletedSendDispatchResult: jest.fn().mockResolvedValue(null),
      assertCanExecute: jest.fn().mockRejectedValue(terminalRace),
      recordStarted: jest.fn(),
      recordSucceeded: jest.fn(),
      recordSkipped: jest.fn(),
      recordFailed: jest.fn(),
    };
    const service = new MaxActionDispatchService(
      maxClient as never,
      undefined,
      actionLedgerService as never,
    );
    const job = {
      actionType: 'KICK_MEMBER',
      chatId: 'chat-1',
      botId: 'bot-1',
      userId: 'user-1',
      attempt: 2,
      idempotencyKey: 'job-kick-terminal-race',
      createdAt: '2026-07-06T20:00:00.000Z',
    } as MaxActionJob;

    await expect(service.execute(job)).rejects.toBe(terminalRace);

    expect(actionLedgerService.assertCanExecute).toHaveBeenCalledWith(job);
    expect(actionLedgerService.recordStarted).not.toHaveBeenCalled();
    expect(maxClient.executeActionJob).not.toHaveBeenCalled();
  });

  it('keeps an ambiguous member mutation quarantined before a second MAX dispatch', async () => {
    const ambiguousError = new UnrecoverableError(
      'Ambiguous MAX BAN_MEMBER transport failure for chat chat-1 user user-1',
    );
    let quarantined = false;
    const maxClient = {
      executeActionJob: jest.fn().mockRejectedValue(ambiguousError),
    };
    const actionLedgerService = {
      getCompletedSendDispatchResult: jest.fn().mockResolvedValue(null),
      assertCanExecute: jest.fn().mockImplementation(async () => {
        if (quarantined) {
          throw new UnrecoverableError('ledger outcome requires manual review');
        }
      }),
      recordStarted: jest.fn().mockResolvedValue(undefined),
      recordFailed: jest.fn().mockImplementation(async () => {
        quarantined = true;
      }),
    };
    const service = new MaxActionDispatchService(
      maxClient as never,
      undefined,
      actionLedgerService as never,
    );
    const job = {
      actionType: 'BAN_MEMBER',
      chatId: 'chat-1',
      botId: 'bot-1',
      userId: 'user-1',
      attempt: 1,
      idempotencyKey: 'job-ban-http-500',
      createdAt: '2026-07-06T20:00:00.000Z',
    } as MaxActionJob;

    await expect(service.execute(job)).rejects.toBe(ambiguousError);
    await expect(service.execute({ ...job, attempt: 2 })).rejects.toThrow(
      'ledger outcome requires manual review',
    );

    expect(maxClient.executeActionJob).toHaveBeenCalledTimes(1);
    expect(actionLedgerService.recordFailed).toHaveBeenCalledTimes(1);
  });

  it('returns deterministic media preparation failures as terminal BullMQ errors', async () => {
    const validationError = new MaxMediaUploadValidationError(
      MAX_MEDIA_UPLOAD_VALIDATION_ERROR_CODES.INVALID_PAYLOAD,
      'image',
    );
    const maxClient = {
      executeActionJob: jest.fn(),
    };
    const actionLedgerService = {
      recordStarted: jest.fn().mockResolvedValue(undefined),
      recordFailed: jest.fn().mockResolvedValue(undefined),
    };
    const service = new MaxActionDispatchService(
      maxClient as never,
      undefined,
      actionLedgerService as never,
    );
    const job = {
      actionType: 'SEND_MESSAGE',
      chatId: 'chat-1',
      text: 'hello',
      attempt: 1,
      idempotencyKey: 'job-invalid-media',
      createdAt: '2026-07-06T20:00:00.000Z',
    } as MaxActionJob;

    await expect(
      service.execute(job, {
        prepareAttempt: jest.fn().mockRejectedValue(validationError),
      }),
    ).rejects.toBe(validationError);

    expect(validationError).toBeInstanceOf(UnrecoverableError);
    expect(maxClient.executeActionJob).not.toHaveBeenCalled();
    expect(actionLedgerService.recordFailed).toHaveBeenCalledWith(job, validationError, {
      exhausted: false,
    });
  });

  it('does not retry an already executed action when success ledger recording fails', async () => {
    const maxClient = {
      executeActionJob: jest.fn().mockResolvedValue(undefined),
    };
    const actionLedgerService = {
      recordStarted: jest.fn().mockResolvedValue(undefined),
      recordSucceeded: jest.fn().mockRejectedValue(new Error('ledger write failed')),
      recordSkipped: jest.fn().mockResolvedValue(undefined),
      recordFailed: jest.fn().mockResolvedValue(undefined),
    };
    const service = new MaxActionDispatchService(
      maxClient as never,
      undefined,
      actionLedgerService as never,
    );

    await expect(
      service.execute({
        actionType: 'SEND_MESSAGE',
        chatId: 'chat-1',
        botId: 'bot-1',
        text: 'hello',
        attempt: 1,
        idempotencyKey: 'job-send-ledger-fail',
        createdAt: '2026-07-06T20:00:00.000Z',
      } as MaxActionJob),
    ).resolves.toBeUndefined();

    expect(maxClient.executeActionJob).toHaveBeenCalledTimes(1);
    expect(actionLedgerService.recordFailed).not.toHaveBeenCalled();
  });

  it('stops access-ambiguous auto-delete retries only after terminal ledger persistence', async () => {
    const verificationError = createMaxSendAutoDeleteVerificationError(
      createMaxApiError(404, 'Message message-sensitive not found', 'message.not.found'),
    );
    const maxClient = {
      executeActionJob: jest.fn().mockRejectedValue(verificationError),
    };
    const actionLedgerService = {
      recordStarted: jest.fn().mockResolvedValue(undefined),
      recordFailed: jest.fn().mockResolvedValue(undefined),
    };
    const service = new MaxActionDispatchService(
      maxClient as never,
      undefined,
      actionLedgerService as never,
    );
    const job = createSendAutoDeleteJob();

    let thrown: unknown;
    try {
      await service.execute(job);
    } catch (error: unknown) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(UnrecoverableError);
    expect((thrown as Error).message).toBe(
      'MAX send-side auto-delete exact presence verification is access-ambiguous',
    );
    expect((thrown as Error).message).not.toMatch(
      /chat-sensitive|message-sensitive|send-job-sensitive/,
    );
    expect(maxClient.executeActionJob).toHaveBeenCalledTimes(1);
    expect(actionLedgerService.recordFailed).toHaveBeenCalledWith(job, verificationError, {
      exhausted: true,
    });
  });

  it('keeps access-ambiguous auto-delete verification retryable without a ledger service', async () => {
    const verificationError = createMaxSendAutoDeleteVerificationError(
      createMaxApiError(403, 'Access denied', 'access.denied'),
    );
    const maxClient = {
      executeActionJob: jest.fn().mockRejectedValue(verificationError),
    };
    const service = new MaxActionDispatchService(maxClient as never);

    await expect(service.execute(createSendAutoDeleteJob())).rejects.toBe(verificationError);
    expect(maxClient.executeActionJob).toHaveBeenCalledTimes(1);
  });

  it('keeps access-ambiguous auto-delete verification retryable when ledger persistence fails', async () => {
    const verificationError = createMaxSendAutoDeleteVerificationError(
      createMaxApiError(404, 'Message unavailable', 'message.not.found'),
    );
    const maxClient = {
      executeActionJob: jest.fn().mockRejectedValue(verificationError),
    };
    const actionLedgerService = {
      recordStarted: jest.fn().mockResolvedValue(undefined),
      recordFailed: jest.fn().mockRejectedValue(new Error('ledger unavailable')),
    };
    const service = new MaxActionDispatchService(
      maxClient as never,
      undefined,
      actionLedgerService as never,
    );
    jest.spyOn((service as any).logger, 'warn').mockImplementation(() => undefined);
    const job = createSendAutoDeleteJob();

    await expect(service.execute(job)).rejects.toBe(verificationError);
    expect(actionLedgerService.recordFailed).toHaveBeenCalledWith(job, verificationError, {
      exhausted: true,
    });
    expect(maxClient.executeActionJob).toHaveBeenCalledTimes(1);
  });

  it('keeps a branded access-ambiguous ordinary DELETE retryable', async () => {
    const verificationError = createMaxSendAutoDeleteVerificationError(
      createMaxApiError(404, 'Message unavailable', 'message.not.found'),
    );
    const maxClient = {
      executeActionJob: jest.fn().mockRejectedValue(verificationError),
    };
    const actionLedgerService = {
      recordStarted: jest.fn().mockResolvedValue(undefined),
      recordFailed: jest.fn().mockResolvedValue(undefined),
    };
    const service = new MaxActionDispatchService(
      maxClient as never,
      undefined,
      actionLedgerService as never,
    );
    const job = {
      actionType: 'DELETE_MESSAGE',
      chatId: 'chat-1',
      botId: 'bot-1',
      messageId: 'message-1',
      attempt: 1,
      idempotencyKey: 'ordinary-delete-job',
      createdAt: '2026-09-03T08:01:00.000Z',
    } as MaxActionJob;

    await expect(service.execute(job)).rejects.toBe(verificationError);
    expect(verificationError).not.toBeInstanceOf(UnrecoverableError);
    expect(actionLedgerService.recordFailed).toHaveBeenCalledWith(job, verificationError, {
      exhausted: false,
    });
  });

  it.each([
    {
      label: 'upstream 502',
      cause: createMaxApiError(502, 'Upstream unavailable', 'server.failure'),
      expectedKind: 'upstream_5xx',
    },
    {
      label: 'timeout',
      cause: Object.assign(new Error('request timed out'), { code: 'ETIMEDOUT' }),
      expectedKind: 'timeout',
    },
    {
      label: 'rate limit 429',
      cause: createMaxApiError(429, 'Too many requests', 'too.many.requests'),
      expectedKind: 'rate_limit',
    },
    {
      label: 'open circuit',
      cause: new MaxApiCircuitOpenError('bot-1', 750),
      expectedKind: 'circuit_open',
    },
  ])(
    'keeps $label auto-delete verification failures retryable',
    async ({ cause, expectedKind }) => {
      const verificationError = createMaxSendAutoDeleteVerificationError(cause);
      const maxClient = {
        executeActionJob: jest.fn().mockRejectedValue(verificationError),
      };
      const actionLedgerService = {
        recordStarted: jest.fn().mockResolvedValue(undefined),
        recordFailed: jest.fn().mockResolvedValue(undefined),
      };
      const service = new MaxActionDispatchService(
        maxClient as never,
        undefined,
        actionLedgerService as never,
      );
      const job = createSendAutoDeleteJob();

      await expect(service.execute(job)).rejects.toBe(verificationError);
      expect(verificationError).not.toBeInstanceOf(UnrecoverableError);
      expect(verificationError.maxSendAutoDeleteVerificationDiagnostic.kind).toBe(expectedKind);
      expect(actionLedgerService.recordFailed).toHaveBeenCalledWith(job, verificationError, {
        exhausted: false,
      });
    },
  );

  it('retries a DELETE-confirmed auto-delete when its durable v2 receipt cannot be recorded', async () => {
    const ledgerError = new Error('ledger write failed');
    const maxClient = {
      executeActionJob: jest.fn().mockImplementation(async (attemptJob: MaxActionJob) => {
        Object.assign(attemptJob.sendAutoDelete!, {
          version: MAX_SEND_AUTO_DELETE_MARKER_VERSION,
          confirmedAt: '2026-08-31T12:01:00.000Z',
          confirmationKind: MAX_SEND_AUTO_DELETE_CONFIRMATION_KINDS.DOCUMENTED_DELETE_SUCCESS,
        });
      }),
    };
    const actionLedgerService = {
      recordStarted: jest.fn().mockResolvedValue(undefined),
      recordSucceeded: jest.fn().mockRejectedValue(ledgerError),
      hasRecordedVerifiedSendAutoDeleteSuccess: jest.fn().mockResolvedValue(false),
      recordFailed: jest.fn().mockResolvedValue(undefined),
    };
    const service = new MaxActionDispatchService(
      maxClient as never,
      undefined,
      actionLedgerService as never,
    );
    const job = {
      actionType: 'DELETE_MESSAGE',
      chatId: 'chat-1',
      botId: 'bot-1',
      messageId: 'message-1',
      sendAutoDelete: {
        version: MAX_SEND_AUTO_DELETE_MARKER_VERSION,
        sourceSendJobId: 'send-job-1',
        sourceSendCompletedAt: '2026-08-31T12:00:00.000Z',
        requestedDelayMs: 60_000,
        originBotId: 'bot-1',
      },
      attempt: 1,
      idempotencyKey: 'job-auto-delete-ledger-fail',
      createdAt: '2026-08-31T12:01:00.000Z',
    } as MaxActionJob;

    await expect(service.execute(job)).rejects.toBe(ledgerError);

    expect(actionLedgerService.hasRecordedVerifiedSendAutoDeleteSuccess).toHaveBeenCalledWith(job);
    expect(job.sendAutoDelete).toMatchObject({
      version: MAX_SEND_AUTO_DELETE_MARKER_VERSION,
      confirmedAt: '2026-08-31T12:01:00.000Z',
      confirmationKind: MAX_SEND_AUTO_DELETE_CONFIRMATION_KINDS.DOCUMENTED_DELETE_SUCCESS,
    });
    expect(actionLedgerService.recordFailed).toHaveBeenCalledWith(job, ledgerError, {
      exhausted: false,
    });
  });

  it('accepts an ambiguously acknowledged receipt write only after exact ledger reconciliation', async () => {
    const maxClient = {
      executeActionJob: jest.fn().mockResolvedValue(undefined),
    };
    const actionLedgerService = {
      recordStarted: jest.fn().mockResolvedValue(undefined),
      recordSucceeded: jest.fn().mockRejectedValue(new Error('ambiguous ledger response')),
      hasRecordedVerifiedSendAutoDeleteSuccess: jest.fn().mockResolvedValue(true),
      recordFailed: jest.fn().mockResolvedValue(undefined),
    };
    const service = new MaxActionDispatchService(
      maxClient as never,
      undefined,
      actionLedgerService as never,
    );
    const job = {
      actionType: 'DELETE_MESSAGE',
      chatId: 'chat-1',
      botId: 'bot-1',
      messageId: 'message-1',
      sendAutoDelete: {
        version: MAX_SEND_AUTO_DELETE_MARKER_VERSION,
        sourceSendJobId: 'send-job-1',
        sourceSendCompletedAt: '2026-08-31T12:00:00.000Z',
        requestedDelayMs: 60_000,
        originBotId: 'bot-1',
        confirmedAt: '2026-08-31T12:01:00.000Z',
        confirmationKind: MAX_SEND_AUTO_DELETE_CONFIRMATION_KINDS.EXACT_ABSENCE_PREFLIGHT,
      },
      attempt: 1,
      idempotencyKey: 'job-auto-delete-ledger-reconciled',
      createdAt: '2026-08-31T12:01:00.000Z',
    } as MaxActionJob;

    await expect(service.execute(job)).resolves.toBeUndefined();

    expect(actionLedgerService.hasRecordedVerifiedSendAutoDeleteSuccess).toHaveBeenCalledWith(job);
    expect(actionLedgerService.recordFailed).not.toHaveBeenCalled();
  });

  it('recovers a completed SEND_MESSAGE before route resolution or bot execution', async () => {
    const maxClient = {
      executeActionJob: jest.fn(),
      ensureSendAutoDeleteScheduled: jest.fn(),
    };
    const actionLedgerService = {
      getCompletedSendDispatchResult: jest.fn().mockResolvedValue({
        remoteMessageId: 'mid-recovered-1',
        dispatchBotId: 'survivor-bot',
      }),
      getCompletedSendDispatch: jest.fn(),
      recordStarted: jest.fn(),
      recordSucceeded: jest.fn(),
      recordSkipped: jest.fn(),
      recordFailed: jest.fn(),
    };
    const maxBotLinkService = {
      resolveBotRoute: jest.fn().mockRejectedValue(new Error('route unavailable')),
    };
    const service = new MaxActionDispatchService(
      maxClient as never,
      undefined,
      actionLedgerService as never,
      maxBotLinkService as never,
    );

    await expect(
      service.execute({
        actionType: 'SEND_MESSAGE',
        chatId: 'chat-1',
        botId: 'removed-bot',
        candidateBotIds: [],
        routing: { purpose: 'send_message' },
        text: 'hello',
        attempt: 2,
        idempotencyKey: 'job-send-recovered-before-route',
        createdAt: '2026-07-11T10:00:00.000Z',
      }),
    ).resolves.toEqual({
      messageId: 'mid-recovered-1',
      url: null,
      botId: 'survivor-bot',
    });

    expect(maxBotLinkService.resolveBotRoute).not.toHaveBeenCalled();
    expect(maxClient.executeActionJob).not.toHaveBeenCalled();
    expect(maxClient.ensureSendAutoDeleteScheduled).not.toHaveBeenCalled();
    expect(actionLedgerService.recordStarted).not.toHaveBeenCalled();
    expect(actionLedgerService.getCompletedSendDispatch).not.toHaveBeenCalled();
  });

  it('propagates auto-delete enqueue failure while recovering a completed send', async () => {
    const enqueueError = new Error('auto-delete queue unavailable');
    const completedAt = new Date('2026-08-31T12:00:00.000Z');
    const maxClient = {
      executeActionJob: jest.fn(),
      ensureSendAutoDeleteScheduled: jest.fn().mockRejectedValue(enqueueError),
    };
    const actionLedgerService = {
      getCompletedSendDispatchResult: jest.fn().mockResolvedValue({
        remoteMessageId: 'mid-recovered-auto-delete-1',
        dispatchBotId: 'survivor-bot',
        completedAt,
      }),
      recordStarted: jest.fn(),
      recordSucceeded: jest.fn(),
      recordSkipped: jest.fn(),
      recordFailed: jest.fn(),
    };
    const maxBotLinkService = {
      resolveBotRoute: jest.fn(),
    };
    const service = new MaxActionDispatchService(
      maxClient as never,
      undefined,
      actionLedgerService as never,
      maxBotLinkService as never,
    );
    const job = {
      actionType: 'SEND_MESSAGE',
      chatId: 'chat-1',
      botId: 'survivor-bot',
      routing: { purpose: 'send_message' },
      text: 'hello',
      autoDeleteDelayMs: 60_000,
      attempt: 2,
      idempotencyKey: 'job-send-recovered-auto-delete',
      createdAt: '2026-08-31T12:00:00.000Z',
    } as MaxActionJob;

    await expect(service.execute(job)).rejects.toBe(enqueueError);

    expect(maxClient.ensureSendAutoDeleteScheduled).toHaveBeenCalledWith(job, {
      remoteMessageId: 'mid-recovered-auto-delete-1',
      dispatchBotId: 'survivor-bot',
      completedAt,
    });
    expect(maxClient.executeActionJob).not.toHaveBeenCalled();
    expect(maxBotLinkService.resolveBotRoute).not.toHaveBeenCalled();
    expect(actionLedgerService.recordStarted).not.toHaveBeenCalled();
    expect(actionLedgerService.recordFailed).not.toHaveBeenCalled();
  });

  it.each(['held', 'lookup_outage'] as const)(
    'prevents confirmed SEND child creation when parent admission is %s',
    async (admission) => {
      const maxClient = {
        executeActionJob: jest.fn(),
        ensureSendAutoDeleteScheduled: jest.fn(),
      };
      const ledger = {
        getCompletedSendDispatchResult: jest.fn().mockResolvedValue({
          remoteMessageId: 'confirmed-parent',
          dispatchBotId: 'origin-bot',
          completedAt: new Date(),
        }),
        recordStarted: jest.fn(),
        recordSucceeded: jest.fn(),
        recordFailed: jest.fn(),
      };
      const holds = {
        isOutboundJobHeld: jest.fn().mockResolvedValue(admission === 'held'),
        isMessageHeld: jest.fn().mockResolvedValue(false),
        isMemberHeld: jest.fn().mockResolvedValue(false),
        isGlobalUserHeld: jest.fn().mockResolvedValue(false),
        isLegacyChatSendHeld: jest.fn().mockResolvedValue(false),
      };
      const outage = new Error('Hold authority unavailable');
      if (admission === 'lookup_outage') holds.isOutboundJobHeld.mockRejectedValue(outage);
      const service = new MaxActionDispatchService(
        maxClient as never,
        undefined,
        ledger as never,
        undefined,
        undefined,
        holds as never,
      );
      const result = service.execute({
        actionType: 'SEND_MESSAGE',
        chatId: 'source-chat',
        botId: 'origin-bot',
        userId: 'source-user',
        messageId: 'source-message',
        text: 'notice',
        autoDeleteDelayMs: 60_000,
        attempt: 2,
        idempotencyKey: 'confirmed-parent-job',
        createdAt: '2026-10-05T00:00:00.000Z',
      });
      if (admission === 'lookup_outage') await expect(result).rejects.toBe(outage);
      else await expect(result).resolves.toMatchObject({ messageId: 'confirmed-parent' });
      expect(maxClient.ensureSendAutoDeleteScheduled).not.toHaveBeenCalled();
      expect(maxClient.executeActionJob).not.toHaveBeenCalled();
      expect(ledger.recordStarted).not.toHaveBeenCalled();
      expect(ledger.recordSucceeded).not.toHaveBeenCalled();
      expect(ledger.recordFailed).not.toHaveBeenCalled();
    },
  );

  it.each([
    { label: 'another bot', dispatchBotId: 'foreign-bot' },
    { label: 'no persisted bot', dispatchBotId: null },
  ])('refuses required-bot recovery bound to $label', async ({ dispatchBotId }) => {
    const actionLedgerService = {
      getCompletedSendDispatchResult: jest.fn().mockResolvedValue({
        remoteMessageId: 'mid-required-recovered',
        dispatchBotId,
      }),
    };
    const service = new MaxActionDispatchService(
      { executeActionJob: jest.fn() } as never,
      undefined,
      actionLedgerService as never,
    );

    await expect(
      service.recoverCompletedSend({
        actionType: 'SEND_MESSAGE',
        chatId: 'channel-1',
        botId: 'media-bot',
        routing: { purpose: 'send_message', requiredBotId: 'media-bot' },
        text: 'video',
        attempt: 2,
        idempotencyKey: 'channel-suggestion:publish:v1:suggestion-required-recovery',
        createdAt: '2026-08-21T00:00:00.000Z',
      }),
    ).rejects.toBeInstanceOf(UnrecoverableError);
  });

  it('recovers a completed send only from the exact required persisted bot', async () => {
    const actionLedgerService = {
      getCompletedSendDispatchResult: jest.fn().mockResolvedValue({
        remoteMessageId: 'mid-required-recovered',
        dispatchBotId: 'media-bot',
      }),
    };
    const service = new MaxActionDispatchService(
      { executeActionJob: jest.fn() } as never,
      undefined,
      actionLedgerService as never,
    );

    await expect(
      service.recoverCompletedSend({
        actionType: 'SEND_MESSAGE',
        chatId: 'channel-1',
        botId: 'foreign-fallback-must-not-be-used',
        routing: { purpose: 'send_message', requiredBotId: 'media-bot' },
        text: 'video',
        attempt: 2,
        idempotencyKey: 'channel-suggestion:publish:v1:suggestion-required-recovery',
        createdAt: '2026-08-21T00:00:00.000Z',
      }),
    ).resolves.toEqual({
      messageId: 'mid-required-recovered',
      url: null,
      botId: 'media-bot',
    });
  });

  it('preserves terminal identity when completion appears before the client early read', async () => {
    const persistedLedgerContext = Object.freeze({
      suggestionId: 'suggestion-late-completion',
      contextDigest: 'persisted-context-digest',
    });
    const competingLedgerContext = {
      suggestionId: 'suggestion-late-completion',
      contextDigest: 'different-prepared-context-digest',
    };
    let completed: {
      remoteMessageId: string;
      dispatchBotId: string | null;
      metadata: unknown;
    } | null = null;
    let signalClientReadEntered: (() => void) | undefined;
    const clientReadEntered = new Promise<void>((resolve) => {
      signalClientReadEntered = resolve;
    });
    let releaseClientRead: (() => void) | undefined;
    const clientReadBarrier = new Promise<void>((resolve) => {
      releaseClientRead = resolve;
    });
    const httpRequest = jest.fn();
    const actionLedgerService = {
      getCompletedSendDispatchResult: jest.fn().mockImplementation(async () =>
        completed
          ? {
              remoteMessageId: completed.remoteMessageId,
              dispatchBotId: completed.dispatchBotId,
            }
          : null,
      ),
      assertCanExecute: jest.fn().mockResolvedValue(undefined),
      recordStarted: jest.fn().mockResolvedValue(undefined),
      recordPrepared: jest.fn().mockResolvedValue(undefined),
      recordSucceeded: jest.fn().mockImplementation(async (attemptJob: MaxActionJob) => {
        if (completed) {
          completed.metadata = attemptJob.ledgerContext;
        }
      }),
      recordFailed: jest.fn(),
    };
    const maxClient = {
      executeActionJob: jest.fn().mockImplementation(async (attemptJob: MaxActionJob) => {
        signalClientReadEntered?.();
        await clientReadBarrier;
        const recovered = await actionLedgerService.getCompletedSendDispatchResult(attemptJob);
        if (!recovered) {
          await httpRequest();
          throw new Error('expected the completion barrier to publish a ledger result');
        }
        return {
          messageId: recovered.remoteMessageId,
          url: null,
          recoveredSendDispatch: {
            dispatchBotId: recovered.dispatchBotId,
          },
        };
      }),
    };
    const service = new MaxActionDispatchService(
      maxClient as never,
      undefined,
      actionLedgerService as never,
    );
    const job = {
      actionType: 'SEND_MESSAGE' as const,
      chatId: 'channel-1',
      botId: 'required-bot',
      routing: { purpose: 'send_message' as const, requiredBotId: 'required-bot' },
      text: 'original publication',
      attempt: 2,
      idempotencyKey: 'channel-suggestion:publish:v1:suggestion-late-completion',
      createdAt: '2026-08-21T10:00:00.000Z',
    };

    const execution = service.execute(job, {
      prepareAttempt: jest.fn().mockResolvedValue({
        text: 'competing prepared publication',
        ledgerContext: competingLedgerContext,
      }),
    });
    await clientReadEntered;
    completed = {
      remoteMessageId: 'mid-late-completion',
      dispatchBotId: 'required-bot',
      metadata: persistedLedgerContext,
    };
    releaseClientRead?.();

    await expect(execution).resolves.toEqual({
      messageId: 'mid-late-completion',
      url: null,
      botId: 'required-bot',
    });
    expect(actionLedgerService.getCompletedSendDispatchResult).toHaveBeenCalledTimes(2);
    expect(actionLedgerService.recordSucceeded).not.toHaveBeenCalled();
    expect(completed.metadata).toBe(persistedLedgerContext);
    expect(completed.metadata).not.toEqual(competingLedgerContext);
    expect(httpRequest).not.toHaveBeenCalled();
  });

  it.each([
    { label: 'a foreign persisted bot', dispatchBotId: 'foreign-bot' },
    { label: 'no persisted bot', dispatchBotId: null },
  ])(
    'does not mutate terminal metadata for late recovery from $label',
    async ({ dispatchBotId }) => {
      const terminalMetadata = { contextDigest: 'immutable-terminal-context' };
      const actionLedgerService = {
        getCompletedSendDispatchResult: jest.fn().mockResolvedValue(null),
        assertCanExecute: jest.fn().mockResolvedValue(undefined),
        recordStarted: jest.fn().mockResolvedValue(undefined),
        recordSucceeded: jest.fn().mockImplementation(async () => {
          terminalMetadata.contextDigest = 'mutated';
        }),
        recordFailed: jest.fn(),
      };
      const maxClient = {
        executeActionJob: jest
          .fn()
          .mockRejectedValue(
            new UnrecoverableError(
              `Completed MAX SEND_MESSAGE late-invalid is not bound to required bot required-bot (${dispatchBotId ?? 'null'})`,
            ),
          ),
      };
      const service = new MaxActionDispatchService(
        maxClient as never,
        undefined,
        actionLedgerService as never,
      );

      await expect(
        service.execute({
          actionType: 'SEND_MESSAGE',
          chatId: 'channel-1',
          botId: 'required-bot',
          routing: { purpose: 'send_message', requiredBotId: 'required-bot' },
          text: 'publication',
          attempt: 2,
          idempotencyKey: 'late-invalid',
          createdAt: '2026-08-21T10:00:00.000Z',
        }),
      ).rejects.toBeInstanceOf(UnrecoverableError);
      expect(actionLedgerService.recordSucceeded).not.toHaveBeenCalled();
      expect(terminalMetadata).toEqual({ contextDigest: 'immutable-terminal-context' });
    },
  );

  it('records queued send access loss and stops BullMQ retries', async () => {
    const dispatchAttemptStartedAt = new Date('2026-08-20T12:00:00.123Z');
    jest.useFakeTimers().setSystemTime(dispatchAttemptStartedAt);
    const error = createMaxApiError(403, 'chat denied', 'chat.denied');
    const maxClient = {
      executeActionJob: jest.fn().mockImplementation(async () => {
        jest.setSystemTime(new Date('2026-08-20T12:00:05.000Z'));
        throw error;
      }),
    };
    const managedEntityAccessLossService = {
      recordIfManagedEntityAccessLost: jest.fn().mockResolvedValue({
        classification: {
          kind: 'managed_entity_access_lost',
          reason: 'bot_denied',
          statusCode: 403,
          code: 'chat.denied',
          message: 'chat denied',
        },
        reason: 'bot_denied',
        recorded: null,
      } satisfies RecordManagedEntityAccessLostFromErrorResult),
    };
    const service = new MaxActionDispatchService(
      maxClient as never,
      managedEntityAccessLossService as never,
    );
    const job = {
      actionType: 'SEND_MESSAGE',
      chatId: 'chat-1',
      botId: 'bot-1',
      text: 'hello',
      attempt: 1,
      idempotencyKey: 'job-send-denied',
      createdAt: '2026-05-16T20:00:00.000Z',
    } as MaxActionJob;

    await expect(service.execute(job)).rejects.toBeInstanceOf(UnrecoverableError);

    expect(managedEntityAccessLossService.recordIfManagedEntityAccessLost).toHaveBeenCalledWith({
      chatId: 'chat-1',
      botId: 'bot-1',
      operation: 'send',
      source: 'max_action:send_message',
      error,
      lifecycleEventAt: dispatchAttemptStartedAt,
      lifecycleEventType: 'live_probe',
      lifecycleSource: 'live_probe',
    });
  });

  it('fails over a routed send to a surviving bot after a definitive 403 rejection', async () => {
    const denied = createMaxApiError(403, 'chat denied', 'chat.denied');
    const maxClient = {
      executeActionJob: jest.fn().mockImplementation(async (job: MaxActionJob) => {
        if (job.botId === 'bot-1') {
          throw denied;
        }
      }),
    };
    const managedEntityAccessLossService = {
      recordIfManagedEntityAccessLost: jest.fn().mockResolvedValue({
        classification: {
          kind: 'managed_entity_access_lost',
          reason: 'bot_denied',
          statusCode: 403,
          code: 'chat.denied',
          message: 'chat denied',
        },
        reason: 'bot_denied',
        recorded: {
          chatId: 'chat-1',
          botId: 'bot-1',
          nextOwnerBotId: 'bot-2',
          updatedAccessEdges: 1,
          cleanup: {
            nightModeJobsCleared: false,
            canceledBroadcasts: null,
            canceledBroadcastDeliveries: null,
            canceledBroadcastOccurrences: null,
            clearedVkPublishPosts: null,
            pausedVkSources: null,
            removedRosterSyncJobs: null,
          },
        },
      } satisfies RecordManagedEntityAccessLostFromErrorResult),
    };
    const maxBotLinkService = {
      resolveBotRoute: jest.fn().mockResolvedValue({
        purpose: 'send_message',
        chatId: 'chat-1',
        primaryBotId: 'bot-1',
        botId: 'bot-1',
        candidateBotIds: ['bot-1', 'bot-2'],
        reason: 'primary_confirmed',
      }),
      getExecutableBotById: jest.fn((botId: string) => ({ id: botId })),
    };
    const service = new MaxActionDispatchService(
      maxClient as never,
      managedEntityAccessLossService as never,
      undefined,
      maxBotLinkService as never,
      {
        get: jest.fn((key: string) => (key === 'MAX_ROUTED_MUTATIONS_MODE' ? 'on' : undefined)),
      } as never,
    );

    await expect(
      service.execute({
        actionType: 'SEND_MESSAGE',
        chatId: 'chat-1',
        botId: 'bot-1',
        candidateBotIds: ['bot-1', 'bot-2'],
        routing: {
          purpose: 'send_message',
          primaryBotId: 'bot-1',
          reason: 'primary_confirmed',
        },
        text: 'hello',
        attempt: 1,
        idempotencyKey: 'logical-send-1',
        createdAt: '2026-07-11T10:00:00.000Z',
      }),
    ).resolves.toBeUndefined();

    expect(maxClient.executeActionJob).toHaveBeenCalledTimes(2);
    expect(maxClient.executeActionJob).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ botId: 'bot-1', attemptedBotIds: ['bot-1'] }),
    );
    expect(maxClient.executeActionJob).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ botId: 'bot-2', attemptedBotIds: ['bot-1', 'bot-2'] }),
    );
  });

  it('re-prepares bot-scoped publication media for a survivor after a pre-send 403', async () => {
    const denied = createMaxApiError(403, 'chat denied', 'chat.denied');
    const maxClient = {
      executeActionJob: jest.fn().mockResolvedValue({
        messageId: 'mid-survivor-1',
        url: null,
      }),
    };
    const managedEntityAccessLossService = {
      recordIfManagedEntityAccessLost: jest.fn(),
    };
    const maxBotLinkService = {
      resolveBotRoute: jest.fn().mockResolvedValue({
        purpose: 'send_message',
        chatId: 'chat-1',
        primaryBotId: 'bot-1',
        botId: 'bot-1',
        candidateBotIds: ['bot-1', 'bot-2'],
        reason: 'primary_confirmed',
      }),
      getExecutableBotById: jest.fn((botId: string) => ({ id: botId })),
    };
    const service = new MaxActionDispatchService(
      maxClient as never,
      managedEntityAccessLossService as never,
      undefined,
      maxBotLinkService as never,
      {
        get: jest.fn((key: string) => (key === 'MAX_ROUTED_MUTATIONS_MODE' ? 'on' : undefined)),
      } as never,
    );
    const prepareAttempt = jest.fn().mockImplementation(async ({ botId }: { botId: string }) => {
      if (botId === 'bot-1') {
        throw denied;
      }
      return { options: { imagePayload: { token: `${botId}-upload` } } };
    });

    await expect(
      service.execute(
        {
          actionType: 'SEND_MESSAGE',
          chatId: 'chat-1',
          botId: 'bot-1',
          candidateBotIds: ['bot-1', 'bot-2'],
          routing: { purpose: 'send_message' },
          text: 'publication',
          attempt: 1,
          idempotencyKey: 'logical-publication-1',
          createdAt: '2026-07-11T10:00:00.000Z',
        },
        { prepareAttempt },
      ),
    ).resolves.toEqual({
      messageId: 'mid-survivor-1',
      url: null,
      botId: 'bot-2',
    });

    expect(prepareAttempt).toHaveBeenNthCalledWith(1, expect.objectContaining({ botId: 'bot-1' }));
    expect(prepareAttempt).toHaveBeenNthCalledWith(2, expect.objectContaining({ botId: 'bot-2' }));
    expect(maxClient.executeActionJob).toHaveBeenCalledTimes(1);
    expect(maxClient.executeActionJob).toHaveBeenCalledWith(
      expect.objectContaining({
        botId: 'bot-2',
        idempotencyKey: 'logical-publication-1',
        options: { imagePayload: { token: 'bot-2-upload' } },
      }),
    );
    expect(managedEntityAccessLossService.recordIfManagedEntityAccessLost).not.toHaveBeenCalled();
  });

  it('persists prepared publication context before starting the MAX SEND request', async () => {
    const maxClient = {
      executeActionJob: jest.fn().mockResolvedValue({ messageId: 'mid-1', url: null }),
    };
    const actionLedgerService = {
      getCompletedSendDispatchResult: jest.fn().mockResolvedValue(null),
      recordStarted: jest.fn().mockResolvedValue(undefined),
      recordPrepared: jest.fn().mockResolvedValue(undefined),
      recordSucceeded: jest.fn().mockResolvedValue(undefined),
      recordSkipped: jest.fn().mockResolvedValue(undefined),
      recordFailed: jest.fn().mockResolvedValue(undefined),
    };
    const maxBotLinkService = {
      resolveBotRoute: jest.fn().mockResolvedValue({
        purpose: 'send_message',
        chatId: 'chat-1',
        primaryBotId: 'bot-1',
        botId: 'bot-1',
        candidateBotIds: ['bot-1'],
        reason: 'primary_confirmed',
      }),
      getExecutableBotById: jest.fn((botId: string) => ({ id: botId })),
    };
    const service = new MaxActionDispatchService(
      maxClient as never,
      undefined,
      actionLedgerService as never,
      maxBotLinkService as never,
      {
        get: jest.fn((key: string) => (key === 'MAX_ROUTED_MUTATIONS_MODE' ? 'on' : undefined)),
      } as never,
    );
    const ledgerContext = {
      managedBroadcast: {
        commentDialogReference: {
          entityType: 'channel',
          threadId: 'thread-1',
          includeCommentsButton: true,
        },
      },
    } as const;

    await service.execute(
      {
        actionType: 'SEND_MESSAGE',
        chatId: 'chat-1',
        botId: 'bot-1',
        candidateBotIds: ['bot-1'],
        routing: { purpose: 'send_message' },
        text: 'publication',
        attempt: 1,
        idempotencyKey: 'logical-publication-context-1',
        createdAt: '2026-07-11T10:00:00.000Z',
      } as MaxActionJob,
      {
        prepareAttempt: jest.fn().mockResolvedValue({ ledgerContext }),
      },
    );

    expect(actionLedgerService.recordPrepared).toHaveBeenCalledWith(
      expect.objectContaining({
        botId: 'bot-1',
        ledgerContext,
      }),
    );
    expect(actionLedgerService.recordPrepared.mock.invocationCallOrder[0]).toBeLessThan(
      maxClient.executeActionJob.mock.invocationCallOrder[0],
    );
  });

  it('does not mark access loss or try a survivor after a pre-send 429', async () => {
    const rateLimited = createMaxApiError(429, 'too many requests');
    const maxClient = { executeActionJob: jest.fn() };
    const managedEntityAccessLossService = {
      recordIfManagedEntityAccessLost: jest.fn().mockResolvedValue(null),
    };
    const maxBotLinkService = {
      resolveBotRoute: jest.fn().mockResolvedValue({
        purpose: 'send_message',
        chatId: 'chat-1',
        primaryBotId: 'bot-1',
        botId: 'bot-1',
        candidateBotIds: ['bot-1', 'bot-2'],
        reason: 'primary_confirmed',
      }),
      getExecutableBotById: jest.fn((botId: string) => ({ id: botId })),
    };
    const service = new MaxActionDispatchService(
      maxClient as never,
      managedEntityAccessLossService as never,
      undefined,
      maxBotLinkService as never,
      {
        get: jest.fn((key: string) => (key === 'MAX_ROUTED_MUTATIONS_MODE' ? 'on' : undefined)),
      } as never,
    );
    const prepareAttempt = jest.fn().mockRejectedValue(rateLimited);

    await expect(
      service.execute(
        {
          actionType: 'SEND_MESSAGE',
          chatId: 'chat-1',
          botId: 'bot-1',
          candidateBotIds: ['bot-1', 'bot-2'],
          routing: { purpose: 'send_message' },
          text: 'publication',
          attempt: 1,
          idempotencyKey: 'logical-publication-429',
          createdAt: '2026-07-11T10:00:00.000Z',
        },
        { prepareAttempt },
      ),
    ).rejects.toBe(rateLimited);

    expect(prepareAttempt).toHaveBeenCalledTimes(1);
    expect(maxClient.executeActionJob).not.toHaveBeenCalled();
    expect(managedEntityAccessLossService.recordIfManagedEntityAccessLost).not.toHaveBeenCalled();
  });

  it('refreshes a routed send snapshot after 15 minutes and skips a bot that lost capability', async () => {
    const accessProbeStartedAt = new Date('2026-08-20T10:10:00.000Z');
    jest.useFakeTimers().setSystemTime(accessProbeStartedAt);
    const maxClient = {
      getCurrentChatMemberAccess: jest.fn().mockImplementation(async () => {
        jest.setSystemTime(new Date('2026-08-20T10:10:05.000Z'));
        return {
          userId: 'bot-1',
          isAdmin: false,
          isOwner: false,
          permissions: [],
        };
      }),
      executeActionJob: jest.fn().mockResolvedValue(undefined),
    };
    const maxBotLinkService = {
      resolveBotRoute: jest
        .fn()
        .mockResolvedValueOnce({
          purpose: 'send_message',
          chatId: 'chat-1',
          primaryBotId: 'bot-1',
          botId: 'bot-1',
          candidateBotIds: ['bot-1', 'bot-2'],
          reason: 'primary_confirmed',
        })
        .mockResolvedValue({
          purpose: 'send_message',
          chatId: 'chat-1',
          primaryBotId: 'bot-2',
          botId: 'bot-2',
          candidateBotIds: ['bot-2'],
          reason: 'primary_confirmed',
        }),
      getExecutableBotById: jest.fn((botId: string) => ({ id: botId })),
      isBotAccessSnapshotStale: jest.fn().mockResolvedValueOnce(true).mockResolvedValue(false),
      recordBotAccessProbe: jest.fn().mockResolvedValue(true),
    };
    const service = new MaxActionDispatchService(
      maxClient as never,
      undefined,
      undefined,
      maxBotLinkService as never,
      {
        get: jest.fn((key: string) => (key === 'MAX_ROUTED_MUTATIONS_MODE' ? 'on' : undefined)),
      } as never,
    );

    await service.execute({
      actionType: 'SEND_MESSAGE',
      chatId: 'chat-1',
      botId: 'bot-1',
      candidateBotIds: ['bot-1', 'bot-2'],
      routing: { purpose: 'send_message', primaryBotId: 'bot-1' },
      text: 'hello',
      attempt: 1,
      idempotencyKey: 'logical-send-stale-access',
      createdAt: '2026-07-11T10:00:00.000Z',
    });

    expect(maxBotLinkService.isBotAccessSnapshotStale).toHaveBeenNthCalledWith(1, {
      chatId: 'chat-1',
      botId: 'bot-1',
      maxAgeMs: 15 * 60_000,
    });
    expect(maxBotLinkService.recordBotAccessProbe).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: 'chat-1',
        botId: 'bot-1',
        source: 'routed_action_preflight',
        checkedAt: accessProbeStartedAt,
      }),
    );
    expect(maxClient.executeActionJob).toHaveBeenCalledTimes(1);
    expect(maxClient.executeActionJob).toHaveBeenCalledWith(
      expect.objectContaining({ botId: 'bot-2' }),
    );
  });

  it.each([401, 403, 404])(
    'aborts an opaque own-member HTTP %s before dispatch without revoking the grant',
    async (status) => {
      const lookupFailure = createMaxApiError(status, 'chat not found; forbidden');
      const getCurrentChatMemberAccess: jest.MockedFunction<
        MaxClientService['getCurrentChatMemberAccess']
      > = jest.fn().mockRejectedValue(lookupFailure);
      const recordBotAccessProbe: jest.MockedFunction<MaxBotLinkService['recordBotAccessProbe']> =
        jest.fn();
      const maxClient = {
        getCurrentChatMemberAccess,
        executeActionJob: jest.fn(),
      };
      const maxBotLinkService = {
        resolveBotRoute: jest.fn().mockResolvedValue({
          purpose: 'send_message',
          chatId: 'chat-lookup-unknown',
          primaryBotId: 'bot-1',
          botId: 'bot-1',
          candidateBotIds: ['bot-1'],
          reason: 'primary_confirmed',
        }),
        getExecutableBotById: jest.fn((botId: string) => ({ id: botId })),
        isBotAccessSnapshotStale: jest.fn().mockResolvedValue(true),
        recordBotAccessProbe,
      };
      const managedEntityAccessLossService = {
        recordIfManagedEntityAccessLost: jest.fn(),
      };
      const service = new MaxActionDispatchService(
        maxClient as never,
        managedEntityAccessLossService as never,
        undefined,
        maxBotLinkService as never,
        {
          get: jest.fn((key: string) => (key === 'MAX_ROUTED_MUTATIONS_MODE' ? 'on' : undefined)),
        } as never,
      );
      await expect(
        service.execute({
          actionType: 'SEND_MESSAGE',
          chatId: 'chat-lookup-unknown',
          botId: 'bot-1',
          candidateBotIds: ['bot-1'],
          routing: { purpose: 'send_message', primaryBotId: 'bot-1' },
          text: 'hello',
          attempt: 1,
          idempotencyKey: 'logical-send-lookup-unknown',
          createdAt: '2026-08-20T10:00:00.000Z',
        }),
      ).rejects.toBe(lookupFailure);
      expect(maxBotLinkService.recordBotAccessProbe).not.toHaveBeenCalled();
      expect(managedEntityAccessLossService.recordIfManagedEntityAccessLost).not.toHaveBeenCalled();
      expect(maxClient.executeActionJob).not.toHaveBeenCalled();
    },
  );

  it('persists a terminal access lookup failure and dispatches through the surviving route', async () => {
    const accessProbeStartedAt = new Date('2026-08-20T10:10:00.000Z');
    jest.useFakeTimers().setSystemTime(accessProbeStartedAt);
    const lookupFailure = createMaxApiError(404, 'chat not found', 'chat.not.found');
    const maxClient = {
      getCurrentChatMemberAccess: jest.fn().mockRejectedValue(lookupFailure),
      executeActionJob: jest.fn().mockResolvedValue(undefined),
    };
    const maxBotLinkService = {
      resolveBotRoute: jest
        .fn()
        .mockResolvedValueOnce({
          purpose: 'send_message',
          chatId: 'chat-lookup-denied',
          primaryBotId: 'bot-1',
          botId: 'bot-1',
          candidateBotIds: ['bot-1', 'bot-2'],
          reason: 'primary_confirmed',
        })
        .mockResolvedValue({
          purpose: 'send_message',
          chatId: 'chat-lookup-denied',
          primaryBotId: 'bot-2',
          botId: 'bot-2',
          candidateBotIds: ['bot-2'],
          reason: 'primary_confirmed',
        }),
      getExecutableBotById: jest.fn((botId: string) => ({ id: botId })),
      isBotAccessSnapshotStale: jest.fn().mockResolvedValueOnce(true).mockResolvedValue(false),
      recordBotAccessProbe: jest.fn().mockResolvedValue(true),
    };
    const managedEntityAccessLossService = {
      recordIfManagedEntityAccessLost: jest.fn().mockResolvedValue(null),
    };
    const service = new MaxActionDispatchService(
      maxClient as never,
      managedEntityAccessLossService as never,
      undefined,
      maxBotLinkService as never,
      {
        get: jest.fn((key: string) => (key === 'MAX_ROUTED_MUTATIONS_MODE' ? 'on' : undefined)),
      } as never,
    );

    await expect(
      service.execute({
        actionType: 'SEND_MESSAGE',
        chatId: 'chat-lookup-denied',
        botId: 'bot-1',
        candidateBotIds: ['bot-1', 'bot-2'],
        routing: { purpose: 'send_message', primaryBotId: 'bot-1' },
        text: 'hello',
        attempt: 1,
        idempotencyKey: 'logical-send-lookup-denied',
        createdAt: '2026-08-20T10:00:00.000Z',
      }),
    ).resolves.toBeUndefined();

    expect(maxBotLinkService.recordBotAccessProbe).toHaveBeenCalledWith({
      chatId: 'chat-lookup-denied',
      botId: 'bot-1',
      access: null,
      source: 'routed_action_preflight',
      checkedAt: accessProbeStartedAt,
      lastErrorCode: 'chat.not.found',
    });
    expect(managedEntityAccessLossService.recordIfManagedEntityAccessLost).toHaveBeenCalledWith({
      chatId: 'chat-lookup-denied',
      botId: 'bot-1',
      operation: 'lookup',
      source: 'max_action:routed_access_preflight',
      error: lookupFailure,
      lifecycleEventAt: accessProbeStartedAt,
      lifecycleEventType: 'live_probe',
      lifecycleSource: 'live_probe',
    });
    expect(maxClient.executeActionJob).toHaveBeenCalledTimes(1);
    expect(maxClient.executeActionJob).toHaveBeenCalledWith(
      expect.objectContaining({ botId: 'bot-2' }),
    );
  });

  it('replaces stale queued candidates after an authoritative route refresh', async () => {
    const maxClient = {
      getCurrentChatMemberAccess: jest.fn().mockResolvedValue({
        userId: 'bot-1',
        isAdmin: false,
        isOwner: false,
        permissions: [],
      }),
      executeActionJob: jest.fn().mockResolvedValue(undefined),
    };
    const maxBotLinkService = {
      resolveBotRoute: jest
        .fn()
        .mockResolvedValueOnce({
          purpose: 'send_message',
          chatId: 'chat-authoritative-refresh',
          primaryBotId: 'bot-1',
          botId: 'bot-1',
          candidateBotIds: ['bot-1', 'bot-2'],
          reason: 'primary_confirmed',
        })
        .mockResolvedValue({
          purpose: 'send_message',
          chatId: 'chat-authoritative-refresh',
          primaryBotId: 'bot-3',
          botId: 'bot-3',
          candidateBotIds: ['bot-3'],
          reason: 'primary_confirmed',
        }),
      getExecutableBotById: jest.fn((botId: string) => ({ id: botId })),
      isBotAccessSnapshotStale: jest.fn().mockResolvedValueOnce(true).mockResolvedValue(false),
      recordBotAccessProbe: jest.fn().mockResolvedValue(true),
    };
    const service = new MaxActionDispatchService(
      maxClient as never,
      undefined,
      undefined,
      maxBotLinkService as never,
      {
        get: jest.fn((key: string) => (key === 'MAX_ROUTED_MUTATIONS_MODE' ? 'on' : undefined)),
      } as never,
    );

    await service.execute({
      actionType: 'SEND_MESSAGE',
      chatId: 'chat-authoritative-refresh',
      botId: 'bot-1',
      candidateBotIds: ['bot-1', 'bot-2'],
      routing: { purpose: 'send_message', primaryBotId: 'bot-1' },
      text: 'hello',
      attempt: 1,
      idempotencyKey: 'logical-send-authoritative-refresh',
      createdAt: '2026-08-20T10:00:00.000Z',
    });

    expect(maxClient.executeActionJob).toHaveBeenCalledTimes(1);
    expect(maxClient.executeActionJob).toHaveBeenCalledWith(
      expect.objectContaining({ botId: 'bot-3' }),
    );
    expect(maxClient.executeActionJob).not.toHaveBeenCalledWith(
      expect.objectContaining({ botId: 'bot-2' }),
    );
  });

  it('uses a newer persisted grant when its own access CAS is superseded', async () => {
    const maxClient = {
      getCurrentChatMemberAccess: jest.fn().mockResolvedValue({
        userId: 'bot-1',
        isAdmin: true,
        isOwner: false,
        permissions: ['write'],
      }),
      executeActionJob: jest.fn(),
    };
    const route = {
      purpose: 'send_message',
      chatId: 'chat-superseded-action',
      primaryBotId: 'bot-1',
      botId: 'bot-1',
      candidateBotIds: ['bot-1'],
      reason: 'primary_confirmed',
    };
    const maxBotLinkService = {
      resolveBotRoute: jest.fn().mockResolvedValue(route),
      getExecutableBotById: jest.fn((botId: string) => ({ id: botId })),
      isBotAccessSnapshotStale: jest.fn().mockResolvedValue(true),
      recordBotAccessProbe: jest.fn().mockResolvedValue(false),
    };
    const service = new MaxActionDispatchService(
      maxClient as never,
      undefined,
      undefined,
      maxBotLinkService as never,
      {
        get: jest.fn((key: string) => (key === 'MAX_ROUTED_MUTATIONS_MODE' ? 'on' : undefined)),
      } as never,
    );

    await expect(
      service.execute({
        actionType: 'SEND_MESSAGE',
        chatId: 'chat-superseded-action',
        botId: 'bot-1',
        candidateBotIds: ['bot-1'],
        routing: { purpose: 'send_message', primaryBotId: 'bot-1' },
        text: 'hello',
        attempt: 1,
        idempotencyKey: 'logical-send-superseded-access',
        createdAt: '2026-07-11T10:00:00.000Z',
      }),
    ).resolves.toBeUndefined();

    expect(maxBotLinkService.recordBotAccessProbe).toHaveBeenCalledTimes(1);
    expect(maxBotLinkService.resolveBotRoute).toHaveBeenCalledTimes(2);
    expect(maxClient.executeActionJob).toHaveBeenCalledTimes(1);
  });

  it('keeps a routed action closed when a lifecycle write supersedes its access CAS', async () => {
    const maxClient = {
      getCurrentChatMemberAccess: jest.fn().mockResolvedValue({
        userId: 'bot-1',
        isAdmin: true,
        isOwner: false,
        permissions: ['write'],
      }),
      executeActionJob: jest.fn(),
    };
    const route = {
      purpose: 'send_message',
      chatId: 'chat-superseded-removal',
      primaryBotId: 'bot-1',
      botId: 'bot-1',
      candidateBotIds: ['bot-1'],
      reason: 'primary_confirmed',
    };
    const maxBotLinkService = {
      resolveBotRoute: jest
        .fn()
        .mockResolvedValueOnce(route)
        .mockResolvedValueOnce({
          ...route,
          botId: null,
          candidateBotIds: [],
          reason: null,
        }),
      getExecutableBotById: jest.fn((botId: string) => ({ id: botId })),
      isBotAccessSnapshotStale: jest.fn().mockResolvedValue(true),
      recordBotAccessProbe: jest.fn().mockResolvedValue(false),
    };
    const service = new MaxActionDispatchService(
      maxClient as never,
      undefined,
      undefined,
      maxBotLinkService as never,
      {
        get: jest.fn((key: string) => (key === 'MAX_ROUTED_MUTATIONS_MODE' ? 'on' : undefined)),
      } as never,
    );

    await expect(
      service.execute({
        actionType: 'SEND_MESSAGE',
        chatId: 'chat-superseded-removal',
        botId: 'bot-1',
        candidateBotIds: ['bot-1'],
        routing: { purpose: 'send_message', primaryBotId: 'bot-1' },
        text: 'hello',
        attempt: 1,
        idempotencyKey: 'logical-send-superseded-removal',
        createdAt: '2026-07-11T10:00:00.000Z',
      }),
    ).rejects.toBeInstanceOf(UnrecoverableError);

    expect(maxBotLinkService.recordBotAccessProbe).toHaveBeenCalledTimes(1);
    expect(maxBotLinkService.resolveBotRoute).toHaveBeenCalledTimes(2);
    expect(maxClient.executeActionJob).not.toHaveBeenCalled();
  });

  it('claims a route that becomes half-open after a persisted access refresh', async () => {
    const claimedUntil = new Date('2026-08-20T11:00:00.000Z');
    const maxClient = {
      getCurrentChatMemberAccess: jest.fn().mockResolvedValue({
        userId: 'bot-1',
        isAdmin: true,
        isOwner: false,
        permissions: ['write'],
      }),
      executeActionJob: jest.fn().mockResolvedValue({ messageId: 'message-1', url: null }),
    };
    const initialRoute = {
      purpose: 'send_message',
      chatId: 'chat-half-open-refresh',
      primaryBotId: 'bot-1',
      botId: 'bot-1',
      candidateBotIds: ['bot-1'],
      quarantinedCandidateBotIds: [],
      halfOpenCandidateBotIds: [],
      retryAt: null,
      reason: 'primary_confirmed',
    };
    const maxBotLinkService = {
      resolveBotRoute: jest
        .fn()
        .mockResolvedValueOnce(initialRoute)
        .mockResolvedValueOnce({
          ...initialRoute,
          halfOpenCandidateBotIds: ['bot-1'],
        }),
      getExecutableBotById: jest.fn((botId: string) => ({ id: botId })),
      isBotAccessSnapshotStale: jest.fn().mockResolvedValue(true),
      recordBotAccessProbe: jest.fn().mockResolvedValue(true),
      claimSendRouteHalfOpen: jest.fn().mockResolvedValue(claimedUntil),
    };
    const service = new MaxActionDispatchService(
      maxClient as never,
      undefined,
      undefined,
      maxBotLinkService as never,
      {
        get: jest.fn((key: string) => (key === 'MAX_ROUTED_MUTATIONS_MODE' ? 'on' : undefined)),
      } as never,
    );

    await expect(
      service.execute({
        actionType: 'SEND_MESSAGE',
        chatId: 'chat-half-open-refresh',
        botId: 'bot-1',
        candidateBotIds: ['bot-1'],
        routing: {
          purpose: 'send_message',
          primaryBotId: 'bot-1',
          sendRouteHalfOpenProbe: 'publication_exact_verification',
        },
        text: 'hello',
        attempt: 1,
        idempotencyKey: 'logical-send-half-open-refresh',
        createdAt: '2026-08-20T10:00:00.000Z',
      }),
    ).resolves.toEqual({ messageId: 'message-1', url: null, botId: 'bot-1' });

    expect(maxBotLinkService.resolveBotRoute).toHaveBeenCalledTimes(2);
    expect(maxBotLinkService.claimSendRouteHalfOpen).toHaveBeenCalledWith({
      chatId: 'chat-half-open-refresh',
      botId: 'bot-1',
    });
    expect(maxClient.executeActionJob).toHaveBeenCalledWith(
      expect.objectContaining({ botId: 'bot-1' }),
    );
  });

  it('claims a replacement half-open route after its access CAS is superseded', async () => {
    const claimedUntil = new Date('2026-08-20T11:00:00.000Z');
    const maxClient = {
      getCurrentChatMemberAccess: jest.fn().mockResolvedValue({
        userId: 'bot-1',
        isAdmin: true,
        isOwner: false,
        permissions: ['write'],
      }),
      executeActionJob: jest.fn().mockResolvedValue({ messageId: 'message-2', url: null }),
    };
    const initialRoute = {
      purpose: 'send_message',
      chatId: 'chat-half-open-replacement',
      primaryBotId: 'bot-1',
      botId: 'bot-1',
      candidateBotIds: ['bot-1'],
      quarantinedCandidateBotIds: [],
      halfOpenCandidateBotIds: [],
      retryAt: null,
      reason: 'primary_confirmed',
    };
    const refreshedRetryAt = new Date('2026-08-20T10:30:00.000Z');
    const maxBotLinkService = {
      resolveBotRoute: jest
        .fn()
        .mockResolvedValueOnce(initialRoute)
        .mockResolvedValueOnce({
          ...initialRoute,
          primaryBotId: 'bot-2',
          botId: 'bot-2',
          candidateBotIds: ['bot-2'],
          halfOpenCandidateBotIds: ['bot-2'],
          retryAt: refreshedRetryAt,
        }),
      getExecutableBotById: jest.fn((botId: string) => ({ id: botId })),
      isBotAccessSnapshotStale: jest.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false),
      recordBotAccessProbe: jest.fn().mockResolvedValue(false),
      claimSendRouteHalfOpen: jest.fn().mockResolvedValue(claimedUntil),
    };
    const service = new MaxActionDispatchService(
      maxClient as never,
      undefined,
      undefined,
      maxBotLinkService as never,
      {
        get: jest.fn((key: string) => (key === 'MAX_ROUTED_MUTATIONS_MODE' ? 'on' : undefined)),
      } as never,
    );

    await expect(
      service.execute({
        actionType: 'SEND_MESSAGE',
        chatId: 'chat-half-open-replacement',
        botId: 'bot-1',
        candidateBotIds: ['bot-1'],
        routing: {
          purpose: 'send_message',
          primaryBotId: 'bot-1',
          sendRouteHalfOpenProbe: 'publication_exact_verification',
        },
        text: 'hello',
        attempt: 1,
        idempotencyKey: 'logical-send-half-open-replacement',
        createdAt: '2026-08-20T10:00:00.000Z',
      }),
    ).resolves.toEqual({ messageId: 'message-2', url: null, botId: 'bot-2' });

    expect(maxBotLinkService.recordBotAccessProbe).toHaveBeenCalledTimes(1);
    expect(maxBotLinkService.resolveBotRoute).toHaveBeenCalledTimes(2);
    expect(maxBotLinkService.claimSendRouteHalfOpen).toHaveBeenCalledWith({
      chatId: 'chat-half-open-replacement',
      botId: 'bot-2',
    });
    expect(maxClient.executeActionJob).toHaveBeenCalledWith(
      expect.objectContaining({ botId: 'bot-2' }),
    );
  });

  it('uses a five minute access freshness threshold for routed member moderation', async () => {
    const maxClient = {
      getCurrentChatMemberAccess: jest.fn().mockResolvedValue({
        userId: 'bot-1',
        isAdmin: true,
        isOwner: false,
        permissions: ['add_remove_members'],
      }),
      executeActionJob: jest.fn().mockResolvedValue(undefined),
    };
    const route = {
      purpose: 'moderation_action',
      chatId: 'chat-1',
      primaryBotId: 'bot-1',
      botId: 'bot-1',
      candidateBotIds: ['bot-1'],
      reason: 'primary_confirmed',
      action: 'moderate_member',
    };
    const maxBotLinkService = {
      resolveBotRoute: jest.fn().mockResolvedValue(route),
      getExecutableBotById: jest.fn((botId: string) => ({ id: botId })),
      isBotAccessSnapshotStale: jest.fn().mockResolvedValue(true),
      recordBotAccessProbe: jest.fn().mockResolvedValue(true),
    };
    const service = new MaxActionDispatchService(
      maxClient as never,
      undefined,
      undefined,
      maxBotLinkService as never,
      {
        get: jest.fn((key: string) => (key === 'MAX_ROUTED_MUTATIONS_MODE' ? 'on' : undefined)),
      } as never,
    );

    await service.execute({
      actionType: 'BAN_MEMBER',
      chatId: 'chat-1',
      botId: 'bot-1',
      candidateBotIds: ['bot-1'],
      routing: {
        purpose: 'moderation_action',
        primaryBotId: 'bot-1',
        action: 'moderate_member',
      },
      userId: 'user-1',
      attempt: 1,
      idempotencyKey: 'logical-ban-stale-access',
      createdAt: '2026-07-11T10:00:00.000Z',
    });

    expect(maxBotLinkService.isBotAccessSnapshotStale).toHaveBeenCalledWith({
      chatId: 'chat-1',
      botId: 'bot-1',
      maxAgeMs: 5 * 60_000,
    });
    expect(maxClient.executeActionJob).toHaveBeenCalledTimes(1);
  });

  it('skips a routed bot with an open shared circuit only when enforcement is on', async () => {
    const circuitOpen = new MaxApiCircuitOpenError('bot-1', 750);
    const maxClient = {
      executeActionJob: jest.fn().mockImplementation(async (job: MaxActionJob) => {
        if (job.botId === 'bot-1') {
          throw circuitOpen;
        }
      }),
    };
    const managedEntityAccessLossService = {
      recordIfManagedEntityAccessLost: jest.fn(),
    };
    const maxBotLinkService = {
      resolveBotRoute: jest.fn().mockResolvedValue({
        purpose: 'send_message',
        chatId: 'chat-1',
        primaryBotId: 'bot-1',
        botId: 'bot-1',
        candidateBotIds: ['bot-1', 'bot-2'],
        reason: 'primary_confirmed',
      }),
      getExecutableBotById: jest.fn((botId: string) => ({ id: botId })),
    };
    const service = new MaxActionDispatchService(
      maxClient as never,
      managedEntityAccessLossService as never,
      undefined,
      maxBotLinkService as never,
      {
        get: jest.fn((key: string) => (key === 'MAX_ROUTED_MUTATIONS_MODE' ? 'on' : undefined)),
      } as never,
    );

    await expect(
      service.execute({
        actionType: 'SEND_MESSAGE',
        chatId: 'chat-1',
        botId: 'bot-1',
        candidateBotIds: ['bot-1', 'bot-2'],
        routing: { purpose: 'send_message' },
        text: 'hello',
        attempt: 1,
        idempotencyKey: 'logical-send-circuit',
        createdAt: '2026-07-11T10:00:00.000Z',
      }),
    ).resolves.toBeUndefined();

    expect(maxClient.executeActionJob).toHaveBeenCalledTimes(2);
    expect(maxClient.executeActionJob).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ botId: 'bot-2' }),
    );
    expect(managedEntityAccessLossService.recordIfManagedEntityAccessLost).not.toHaveBeenCalled();
  });

  it('keeps routed circuit failover disabled in the default shadow mode', async () => {
    const circuitOpen = new MaxApiCircuitOpenError('bot-1', 750);
    const maxClient = {
      executeActionJob: jest.fn().mockRejectedValue(circuitOpen),
    };
    const managedEntityAccessLossService = {
      recordIfManagedEntityAccessLost: jest.fn(),
    };
    const maxBotLinkService = {
      resolveBotRoute: jest.fn().mockResolvedValue({
        purpose: 'send_message',
        chatId: 'chat-1',
        primaryBotId: 'bot-1',
        botId: 'bot-1',
        candidateBotIds: ['bot-1', 'bot-2'],
        reason: 'primary_confirmed',
      }),
      getExecutableBotById: jest.fn((botId: string) => ({ id: botId })),
    };
    const service = new MaxActionDispatchService(
      maxClient as never,
      managedEntityAccessLossService as never,
      undefined,
      maxBotLinkService as never,
    );

    await expect(
      service.execute({
        actionType: 'SEND_MESSAGE',
        chatId: 'chat-1',
        botId: 'bot-1',
        candidateBotIds: ['bot-1', 'bot-2'],
        routing: { purpose: 'send_message' },
        text: 'hello',
        attempt: 1,
        idempotencyKey: 'logical-send-circuit-shadow',
        createdAt: '2026-07-11T10:00:00.000Z',
      }),
    ).rejects.toBe(circuitOpen);

    expect(maxClient.executeActionJob).toHaveBeenCalledTimes(1);
    expect(managedEntityAccessLossService.recordIfManagedEntityAccessLost).not.toHaveBeenCalled();
  });

  it('keeps cross-bot delete failover disabled even when routed mutations are on', async () => {
    const circuitOpen = new MaxApiCircuitOpenError('bot-1', 750);
    const maxClient = {
      executeActionJob: jest.fn().mockRejectedValue(circuitOpen),
    };
    const maxBotLinkService = {
      resolveBotRoute: jest.fn().mockResolvedValue({
        purpose: 'moderation_action',
        chatId: 'chat-1',
        primaryBotId: 'bot-1',
        botId: 'bot-1',
        candidateBotIds: ['bot-1', 'bot-2'],
        reason: 'primary_confirmed',
      }),
      getExecutableBotById: jest.fn((botId: string) => ({ id: botId })),
    };
    const service = new MaxActionDispatchService(
      maxClient as never,
      undefined,
      undefined,
      maxBotLinkService as never,
      {
        get: jest.fn((key: string) => {
          if (key === 'MAX_ROUTED_MUTATIONS_MODE') {
            return 'on';
          }
          if (key === 'MAX_CROSS_BOT_EDIT_DELETE_ENABLED') {
            return false;
          }
          return undefined;
        }),
      } as never,
    );

    await expect(
      service.execute({
        actionType: 'DELETE_MESSAGE',
        chatId: 'chat-1',
        botId: 'bot-1',
        candidateBotIds: ['bot-1', 'bot-2'],
        routing: { purpose: 'moderation_action', action: 'delete_message' },
        messageId: 'mid-1',
        attempt: 1,
        idempotencyKey: 'logical-delete-circuit',
        createdAt: '2026-07-11T10:00:00.000Z',
      }),
    ).rejects.toBe(circuitOpen);

    expect(maxClient.executeActionJob).toHaveBeenCalledTimes(1);
    expect(maxClient.executeActionJob).toHaveBeenCalledWith(
      expect.objectContaining({ botId: 'bot-1' }),
    );
  });

  it('allows cross-bot delete failover only behind its explicit flag', async () => {
    const circuitOpen = new MaxApiCircuitOpenError('bot-1', 750);
    const maxClient = {
      executeActionJob: jest.fn().mockImplementation(async (job: MaxActionJob) => {
        if (job.botId === 'bot-1') {
          throw circuitOpen;
        }
      }),
    };
    const maxBotLinkService = {
      resolveBotRoute: jest.fn().mockResolvedValue({
        purpose: 'moderation_action',
        chatId: 'chat-1',
        primaryBotId: 'bot-1',
        botId: 'bot-1',
        candidateBotIds: ['bot-1', 'bot-2'],
        reason: 'primary_confirmed',
      }),
      getExecutableBotById: jest.fn((botId: string) => ({ id: botId })),
    };
    const service = new MaxActionDispatchService(
      maxClient as never,
      undefined,
      undefined,
      maxBotLinkService as never,
      {
        get: jest.fn((key: string) => {
          if (key === 'MAX_ROUTED_MUTATIONS_MODE') {
            return 'on';
          }
          if (key === 'MAX_CROSS_BOT_EDIT_DELETE_ENABLED') {
            return true;
          }
          return undefined;
        }),
      } as never,
    );

    await expect(
      service.execute({
        actionType: 'DELETE_MESSAGE',
        chatId: 'chat-1',
        botId: 'bot-1',
        candidateBotIds: ['bot-1', 'bot-2'],
        routing: { purpose: 'moderation_action', action: 'delete_message' },
        messageId: 'mid-1',
        attempt: 1,
        idempotencyKey: 'logical-delete-circuit-enabled',
        createdAt: '2026-07-11T10:00:00.000Z',
      }),
    ).resolves.toBeUndefined();

    expect(maxClient.executeActionJob).toHaveBeenCalledTimes(2);
    expect(maxClient.executeActionJob).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ botId: 'bot-2' }),
    );
  });

  it('selects routed mutation canaries deterministically by logical action and chat', () => {
    const service = new MaxActionDispatchService(
      { executeActionJob: jest.fn() } as never,
      undefined,
      undefined,
      undefined,
      {
        get: jest.fn((key: string) => {
          if (key === 'MAX_ROUTED_MUTATIONS_MODE') {
            return 'canary';
          }
          if (key === 'MAX_ROUTED_MUTATIONS_CANARY_PERCENT') {
            return 50;
          }
          if (key === 'MAX_ROUTED_MUTATIONS_CANARY_ENTITY_IDS') {
            return '*';
          }
          return undefined;
        }),
      } as never,
    );
    const buildJob = (idempotencyKey: string) =>
      ({
        actionType: 'DELETE_MESSAGE',
        chatId: 'chat-1',
        botId: 'bot-1',
        candidateBotIds: ['bot-1', 'bot-2'],
        routing: { purpose: 'moderation_action' },
        messageId: 'mid-1',
        attempt: 1,
        idempotencyKey,
        createdAt: '2026-07-11T10:00:00.000Z',
      }) as MaxActionJob;
    const decisions = Array.from({ length: 100 }, (_, index) =>
      (service as any).shouldEnforceRoutedFailover(buildJob(`canary-${index}`)),
    );

    expect(decisions).toContain(true);
    expect(decisions).toContain(false);
    expect((service as any).shouldEnforceRoutedFailover(buildJob('canary-42'))).toBe(
      (service as any).shouldEnforceRoutedFailover(buildJob('canary-42')),
    );
  });

  it('recalculates a queued route when the stored routing version is stale', async () => {
    const maxClient = {
      executeActionJob: jest.fn().mockResolvedValue(undefined),
    };
    const maxBotLinkService = {
      resolveBotRoute: jest.fn().mockResolvedValue({
        purpose: 'send_message',
        chatId: 'chat-1',
        primaryBotId: 'bot-2',
        botId: 'bot-2',
        candidateBotIds: ['bot-2'],
        reason: 'primary_confirmed',
        routingVersion: 8,
      }),
      getExecutableBotById: jest.fn((botId: string) => ({ id: botId })),
    };
    const service = new MaxActionDispatchService(
      maxClient as never,
      undefined,
      undefined,
      maxBotLinkService as never,
      {
        get: jest.fn((key: string) => (key === 'MAX_ROUTED_MUTATIONS_MODE' ? 'on' : undefined)),
      } as never,
    );

    await service.execute({
      actionType: 'SEND_MESSAGE',
      chatId: 'chat-1',
      botId: 'bot-1',
      candidateBotIds: ['bot-1'],
      routing: {
        purpose: 'send_message',
        primaryBotId: 'bot-1',
        routingVersion: 7,
      },
      text: 'hello',
      attempt: 1,
      idempotencyKey: 'stale-route-send',
      createdAt: '2026-07-11T10:00:00.000Z',
    });

    expect(maxClient.executeActionJob).toHaveBeenCalledWith(
      expect.objectContaining({
        botId: 'bot-2',
        attemptedBotIds: ['bot-2'],
      }),
    );
  });

  it('uses the fresh owner for a stale routing version while failover remains shadowed', async () => {
    const maxClient = {
      executeActionJob: jest.fn().mockResolvedValue({ messageId: 'mid-fresh-owner', url: null }),
    };
    const maxBotLinkService = {
      resolveBotRoute: jest.fn().mockResolvedValue({
        purpose: 'send_message',
        chatId: 'chat-1',
        primaryBotId: 'bot-2',
        botId: 'bot-2',
        candidateBotIds: ['bot-2', 'bot-3'],
        reason: 'primary_confirmed',
        routingVersion: 8,
      }),
      getExecutableBotById: jest.fn((botId: string) => ({ id: botId })),
    };
    const service = new MaxActionDispatchService(
      maxClient as never,
      undefined,
      undefined,
      maxBotLinkService as never,
      {
        get: jest.fn((key: string) => (key === 'MAX_ROUTED_MUTATIONS_MODE' ? 'shadow' : undefined)),
      } as never,
    );

    await expect(
      service.execute({
        actionType: 'SEND_MESSAGE',
        chatId: 'chat-1',
        botId: 'bot-1',
        candidateBotIds: ['bot-1'],
        routing: {
          purpose: 'send_message',
          primaryBotId: 'bot-1',
          routingVersion: 7,
        },
        text: 'fresh owner only',
        attempt: 1,
        idempotencyKey: 'stale-route-shadow-send',
        createdAt: '2026-07-11T10:00:00.000Z',
      }),
    ).resolves.toEqual({
      messageId: 'mid-fresh-owner',
      url: null,
      botId: 'bot-2',
    });

    expect(maxClient.executeActionJob).toHaveBeenCalledTimes(1);
    expect(maxClient.executeActionJob).toHaveBeenCalledWith(
      expect.objectContaining({ botId: 'bot-2', attemptedBotIds: ['bot-2'] }),
    );
  });

  it('keeps a required bot constraint when refreshing a routed publication', async () => {
    const maxClient = {
      executeActionJob: jest.fn().mockResolvedValue({ messageId: 'mid-required-1', url: null }),
    };
    const maxBotLinkService = {
      resolveBotRoute: jest.fn().mockResolvedValue({
        purpose: 'send_message',
        chatId: 'channel-1',
        primaryBotId: 'bot-2',
        botId: 'bot-2',
        candidateBotIds: ['bot-2', 'media-bot'],
        reason: 'primary_confirmed',
        routingVersion: 12,
      }),
      getExecutableBotById: jest.fn((botId: string) => ({ id: botId })),
    };
    const service = new MaxActionDispatchService(
      maxClient as never,
      undefined,
      undefined,
      maxBotLinkService as never,
    );

    await expect(
      service.execute({
        actionType: 'SEND_MESSAGE',
        chatId: 'channel-1',
        botId: 'media-bot',
        candidateBotIds: ['media-bot'],
        routing: {
          purpose: 'send_message',
          routingVersion: 11,
          requiredBotId: 'media-bot',
        },
        text: 'video',
        attempt: 1,
        idempotencyKey: 'channel-suggestion:publish:v1:suggestion-required-1',
        createdAt: '2026-08-21T00:00:00.000Z',
      }),
    ).resolves.toEqual({ messageId: 'mid-required-1', url: null, botId: 'media-bot' });

    expect(maxClient.executeActionJob).toHaveBeenCalledTimes(1);
    expect(maxClient.executeActionJob).toHaveBeenCalledWith(
      expect.objectContaining({ botId: 'media-bot', attemptedBotIds: ['media-bot'] }),
    );
  });

  it('does not cross a required bot fence after a definitive access-loss replacement', async () => {
    const denied = createMaxApiError(403, 'chat denied', 'chat.denied');
    const maxClient = {
      executeActionJob: jest.fn().mockRejectedValue(denied),
    };
    const managedEntityAccessLossService = {
      recordIfManagedEntityAccessLost: jest.fn().mockResolvedValue({
        classification: {
          kind: 'managed_entity_access_lost',
          reason: 'bot_denied',
          statusCode: 403,
          code: 'chat.denied',
          message: 'chat denied',
        },
        reason: 'bot_denied',
        recorded: {
          chatId: 'channel-1',
          botId: 'media-bot',
          nextOwnerBotId: 'survivor-bot',
          updatedAccessEdges: 1,
          cleanup: {
            nightModeJobsCleared: false,
            canceledBroadcasts: null,
            canceledBroadcastDeliveries: null,
            canceledBroadcastOccurrences: null,
            clearedVkPublishPosts: null,
            pausedVkSources: null,
            removedRosterSyncJobs: null,
          },
        },
      }),
    };
    const maxBotLinkService = {
      resolveBotRoute: jest.fn().mockResolvedValue({
        purpose: 'send_message',
        chatId: 'channel-1',
        primaryBotId: 'media-bot',
        botId: 'media-bot',
        candidateBotIds: ['media-bot', 'survivor-bot'],
        reason: 'primary_confirmed',
      }),
      getExecutableBotById: jest.fn((botId: string) => ({ id: botId })),
    };
    const service = new MaxActionDispatchService(
      maxClient as never,
      managedEntityAccessLossService as never,
      undefined,
      maxBotLinkService as never,
      {
        get: jest.fn((key: string) => (key === 'MAX_ROUTED_MUTATIONS_MODE' ? 'on' : undefined)),
      } as never,
    );

    await expect(
      service.execute({
        actionType: 'SEND_MESSAGE',
        chatId: 'channel-1',
        botId: 'media-bot',
        candidateBotIds: ['media-bot'],
        routing: {
          purpose: 'send_message',
          requiredBotId: 'media-bot',
        },
        text: 'video',
        attempt: 1,
        idempotencyKey: 'channel-suggestion:publish:v1:suggestion-required-denied',
        createdAt: '2026-08-21T00:00:00.000Z',
      }),
    ).rejects.toBeInstanceOf(UnrecoverableError);

    expect(maxClient.executeActionJob).toHaveBeenCalledTimes(1);
    expect(maxClient.executeActionJob).toHaveBeenCalledWith(
      expect.objectContaining({ botId: 'media-bot' }),
    );
    expect(maxClient.executeActionJob).not.toHaveBeenCalledWith(
      expect.objectContaining({ botId: 'survivor-bot' }),
    );
  });

  it('fails closed on a fresh empty managed route even while routed mutations are shadowed', async () => {
    const maxClient = {
      executeActionJob: jest.fn(),
    };
    const actionLedgerService = {
      getCompletedSendDispatchResult: jest.fn().mockResolvedValue(null),
      assertCanExecute: jest.fn().mockResolvedValue(undefined),
      recordStarted: jest.fn(),
      recordSucceeded: jest.fn(),
      recordSkipped: jest.fn(),
      recordFailed: jest.fn(),
    };
    const maxBotLinkService = {
      resolveBotRoute: jest.fn().mockResolvedValue({
        purpose: 'send_message',
        chatId: 'chat-1',
        primaryBotId: null,
        botId: null,
        candidateBotIds: [],
        reason: null,
        routingVersion: 8,
      }),
      getExecutableBotById: jest.fn((botId: string) => ({ id: botId })),
    };
    const service = new MaxActionDispatchService(
      maxClient as never,
      undefined,
      actionLedgerService as never,
      maxBotLinkService as never,
      {
        get: jest.fn((key: string) => (key === 'MAX_ROUTED_MUTATIONS_MODE' ? 'shadow' : undefined)),
      } as never,
    );

    const thrown = await service
      .execute({
        actionType: 'SEND_MESSAGE',
        chatId: 'chat-1',
        botId: 'bot-1',
        candidateBotIds: ['bot-1'],
        routing: {
          purpose: 'send_message',
          primaryBotId: 'bot-1',
          routingVersion: 7,
        },
        text: 'must not send',
        attempt: 1,
        idempotencyKey: 'stale-route-no-eligible-send',
        createdAt: '2026-07-11T10:00:00.000Z',
      })
      .then(
        () => null,
        (error: unknown) => error,
      );

    expect(thrown).toBeInstanceOf(MaxActionNoExecutableRouteError);
    expect(isMaxActionNoExecutableRouteError(thrown)).toBe(true);
    expect(maxClient.executeActionJob).not.toHaveBeenCalled();
    expect(actionLedgerService.recordStarted).not.toHaveBeenCalled();
    expect(actionLedgerService.recordFailed).not.toHaveBeenCalled();
  });

  it('returns a retryable pre-dispatch quarantine instead of permanent no-route', async () => {
    const retryAt = new Date('2026-07-27T12:15:00.000Z');
    const maxClient = { executeActionJob: jest.fn() };
    const actionLedgerService = {
      getCompletedSendDispatchResult: jest.fn().mockResolvedValue(null),
      assertCanExecute: jest.fn().mockResolvedValue(undefined),
      recordStarted: jest.fn(),
      recordFailed: jest.fn(),
    };
    const maxBotLinkService = {
      resolveBotRoute: jest.fn().mockResolvedValue({
        purpose: 'send_message',
        chatId: 'chat-1',
        primaryBotId: 'bot-1',
        botId: null,
        candidateBotIds: [],
        quarantinedCandidateBotIds: ['bot-1'],
        retryAt,
        reason: null,
        routingVersion: 8,
      }),
      getExecutableBotById: jest.fn((botId: string) => ({ id: botId })),
    };
    const service = new MaxActionDispatchService(
      maxClient as never,
      undefined,
      actionLedgerService as never,
      maxBotLinkService as never,
    );

    const thrown = await service
      .execute({
        actionType: 'SEND_MESSAGE',
        chatId: 'chat-1',
        botId: 'bot-1',
        candidateBotIds: ['bot-1'],
        routing: { purpose: 'send_message', routingVersion: 7 },
        text: 'must wait',
        attempt: 1,
        idempotencyKey: 'quarantined-route-send',
        createdAt: '2026-07-27T12:00:00.000Z',
      })
      .then(
        () => null,
        (error: unknown) => error,
      );

    expect(thrown).toBeInstanceOf(MaxActionRouteQuarantinedError);
    expect(isMaxActionRouteQuarantinedError(thrown)).toBe(true);
    expect(thrown).toEqual(
      expect.objectContaining({
        retryAt,
        quarantinedCandidateBotIds: ['bot-1'],
        preDispatch: true,
      }),
    );
    expect(maxClient.executeActionJob).not.toHaveBeenCalled();
    expect(actionLedgerService.recordStarted).not.toHaveBeenCalled();
    expect(actionLedgerService.recordFailed).not.toHaveBeenCalled();
  });

  it('does not expose a half-open send route to a generic routed action', async () => {
    const maxClient = { executeActionJob: jest.fn() };
    const maxBotLinkService = {
      resolveBotRoute: jest.fn().mockResolvedValue({
        purpose: 'send_message',
        chatId: 'chat-1',
        primaryBotId: 'bot-1',
        botId: 'bot-1',
        candidateBotIds: ['bot-1'],
        quarantinedCandidateBotIds: [],
        halfOpenCandidateBotIds: ['bot-1'],
        retryAt: null,
        reason: 'primary_confirmed',
      }),
      claimSendRouteHalfOpen: jest.fn(),
      getExecutableBotById: jest.fn((botId: string) => ({ id: botId })),
    };
    const service = new MaxActionDispatchService(
      maxClient as never,
      undefined,
      undefined,
      maxBotLinkService as never,
    );

    await expect(
      service.execute({
        actionType: 'SEND_MESSAGE',
        chatId: 'chat-1',
        routing: { purpose: 'send_message' },
        text: 'generic message',
        attempt: 1,
        idempotencyKey: 'generic-half-open-send',
        createdAt: '2026-07-27T12:00:00.000Z',
      }),
    ).rejects.toBeInstanceOf(MaxActionRouteQuarantinedError);

    expect(maxBotLinkService.resolveBotRoute).toHaveBeenCalledWith({
      purpose: 'send_message',
      chatId: 'chat-1',
      fallbackToPrimary: true,
      allowHalfOpenProbe: false,
    });
    expect(maxBotLinkService.claimSendRouteHalfOpen).not.toHaveBeenCalled();
    expect(maxClient.executeActionJob).not.toHaveBeenCalled();
  });

  it('never falls back to an unclaimed stored half-open candidate after route refresh fails', async () => {
    const routeError = new Error('route refresh unavailable');
    const maxClient = { executeActionJob: jest.fn() };
    const maxBotLinkService = {
      resolveBotRoute: jest.fn().mockRejectedValue(routeError),
      claimSendRouteHalfOpen: jest.fn(),
      getExecutableBotById: jest.fn((botId: string) => ({ id: botId })),
    };
    const service = new MaxActionDispatchService(
      maxClient as never,
      undefined,
      undefined,
      maxBotLinkService as never,
    );

    await expect(
      service.execute({
        actionType: 'SEND_MESSAGE',
        chatId: 'chat-1',
        botId: 'bot-1',
        candidateBotIds: ['bot-1'],
        routing: {
          purpose: 'send_message',
          sendRouteHalfOpenProbe: 'publication_exact_verification',
        },
        text: 'night close',
        attempt: 1,
        idempotencyKey: 'night-mode:close:chat-1:session:session-1',
        createdAt: '2026-07-27T20:00:01.000Z',
      }),
    ).rejects.toBe(routeError);

    expect(maxBotLinkService.claimSendRouteHalfOpen).not.toHaveBeenCalled();
    expect(maxClient.executeActionJob).not.toHaveBeenCalled();
  });

  it('claims a half-open route only after a Publication attempt is prepared', async () => {
    const claimedUntil = new Date('2026-07-27T18:00:00.000Z');
    const maxClient = {
      executeActionJob: jest.fn().mockResolvedValue({ messageId: 'mid-1', url: null }),
    };
    const maxBotLinkService = {
      resolveBotRoute: jest.fn().mockResolvedValue({
        purpose: 'send_message',
        chatId: 'chat-1',
        primaryBotId: 'bot-1',
        botId: 'bot-1',
        candidateBotIds: ['bot-1'],
        quarantinedCandidateBotIds: [],
        halfOpenCandidateBotIds: ['bot-1'],
        retryAt: null,
        reason: 'primary_confirmed',
      }),
      claimSendRouteHalfOpen: jest.fn().mockResolvedValue(claimedUntil),
      releaseSendRouteHalfOpen: jest.fn(),
      getExecutableBotById: jest.fn((botId: string) => ({ id: botId })),
    };
    const service = new MaxActionDispatchService(
      maxClient as never,
      undefined,
      undefined,
      maxBotLinkService as never,
    );
    const prepareAttempt = jest.fn().mockResolvedValue({ text: 'prepared publication' });

    await expect(
      service.execute(
        {
          actionType: 'SEND_MESSAGE',
          chatId: 'chat-1',
          routing: {
            purpose: 'send_message',
            sendRouteHalfOpenProbe: 'publication_exact_verification',
          },
          text: 'publication',
          attempt: 1,
          idempotencyKey: 'publication-half-open-send',
          createdAt: '2026-07-27T12:00:00.000Z',
        },
        { prepareAttempt },
      ),
    ).resolves.toEqual({ messageId: 'mid-1', url: null, botId: 'bot-1' });

    expect(maxBotLinkService.resolveBotRoute).toHaveBeenCalledWith(
      expect.objectContaining({ allowHalfOpenProbe: true }),
    );
    expect(prepareAttempt.mock.invocationCallOrder[0]).toBeLessThan(
      maxBotLinkService.claimSendRouteHalfOpen.mock.invocationCallOrder[0],
    );
    expect(maxBotLinkService.claimSendRouteHalfOpen).toHaveBeenCalledWith({
      chatId: 'chat-1',
      botId: 'bot-1',
    });
    expect(maxClient.executeActionJob).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'prepared publication', botId: 'bot-1' }),
    );
    expect(maxBotLinkService.releaseSendRouteHalfOpen).not.toHaveBeenCalled();
  });

  it('propagates a validated future night boundary through route refresh and sticky claim', async () => {
    const failureBefore = '2026-07-27T20:00:00.000Z';
    const claimedUntil = new Date('2026-07-28T02:00:01.000Z');
    const maxClient = {
      executeActionJob: jest.fn().mockResolvedValue({ messageId: 'mid-night-1', url: null }),
    };
    const maxBotLinkService = {
      resolveBotRoute: jest.fn().mockResolvedValue({
        purpose: 'send_message',
        chatId: 'chat-1',
        primaryBotId: 'bot-1',
        botId: 'bot-1',
        candidateBotIds: ['bot-1'],
        quarantinedCandidateBotIds: [],
        halfOpenCandidateBotIds: ['bot-1'],
        retryAt: null,
        reason: 'primary_confirmed',
      }),
      claimSendRouteHalfOpen: jest.fn().mockResolvedValue(claimedUntil),
      releaseSendRouteHalfOpen: jest.fn(),
      getExecutableBotById: jest.fn((botId: string) => ({ id: botId })),
    };
    const service = new MaxActionDispatchService(
      maxClient as never,
      undefined,
      undefined,
      maxBotLinkService as never,
    );

    await expect(
      service.execute({
        actionType: 'SEND_MESSAGE',
        chatId: 'chat-1',
        routing: {
          purpose: 'send_message',
          sendRouteHalfOpenProbe: 'publication_exact_verification',
          sendRouteStickyProbe: {
            kind: 'future_night_close_v1',
            authorizedAt: '2026-07-27T19:55:00.000Z',
            failureBefore,
            sessionKey: 'v1:Europe/Moscow:23:00:08:00:2026-07-27',
            scheduleFingerprint: FUTURE_NIGHT_SCHEDULE_FINGERPRINT,
          },
        },
        sourceTag: 'night_mode_transition',
        text: 'night close',
        attempt: 1,
        idempotencyKey: 'night-mode:close:chat-1:session:v1:Europe/Moscow:23:00:08:00:2026-07-27',
        createdAt: '2026-07-27T20:00:01.000Z',
      }),
    ).resolves.toEqual({ messageId: 'mid-night-1', url: null, botId: 'bot-1' });

    expect(maxBotLinkService.resolveBotRoute).toHaveBeenCalledWith({
      purpose: 'send_message',
      chatId: 'chat-1',
      fallbackToPrimary: true,
      allowHalfOpenProbe: true,
      stickyHalfOpenProbeFailureBefore: failureBefore,
    });
    expect(maxBotLinkService.claimSendRouteHalfOpen).toHaveBeenCalledWith({
      chatId: 'chat-1',
      botId: 'bot-1',
      stickyProbeFailureBefore: failureBefore,
    });
    expect(maxBotLinkService.releaseSendRouteHalfOpen).not.toHaveBeenCalled();
  });

  it('does not grant sticky probing to a non-night action with forged route metadata', async () => {
    const maxClient = {
      executeActionJob: jest.fn().mockResolvedValue({ messageId: 'mid-generic-1', url: null }),
    };
    const maxBotLinkService = {
      resolveBotRoute: jest.fn().mockResolvedValue({
        purpose: 'send_message',
        chatId: 'chat-1',
        primaryBotId: 'bot-1',
        botId: 'bot-1',
        candidateBotIds: ['bot-1'],
        quarantinedCandidateBotIds: [],
        halfOpenCandidateBotIds: [],
        retryAt: null,
        reason: 'primary_confirmed',
      }),
      claimSendRouteHalfOpen: jest.fn(),
      getExecutableBotById: jest.fn((botId: string) => ({ id: botId })),
    };
    const service = new MaxActionDispatchService(
      maxClient as never,
      undefined,
      undefined,
      maxBotLinkService as never,
    );

    await expect(
      service.execute({
        actionType: 'SEND_MESSAGE',
        chatId: 'chat-1',
        routing: {
          purpose: 'send_message',
          sendRouteHalfOpenProbe: 'publication_exact_verification',
          sendRouteStickyProbe: {
            kind: 'future_night_close_v1',
            authorizedAt: '2026-07-27T19:55:00.000Z',
            failureBefore: '2026-07-27T20:00:00.000Z',
            sessionKey: 'v1:Europe/Moscow:23:00:08:00:2026-07-27',
            scheduleFingerprint: FUTURE_NIGHT_SCHEDULE_FINGERPRINT,
          },
        },
        sourceTag: 'managed_broadcast',
        text: 'generic message',
        attempt: 1,
        idempotencyKey: 'generic-message-1',
        createdAt: '2026-07-27T20:00:01.000Z',
      }),
    ).resolves.toEqual({ messageId: 'mid-generic-1', url: null, botId: 'bot-1' });

    expect(maxBotLinkService.resolveBotRoute).toHaveBeenCalledWith({
      purpose: 'send_message',
      chatId: 'chat-1',
      fallbackToPrimary: true,
      allowHalfOpenProbe: true,
    });
    expect(maxBotLinkService.claimSendRouteHalfOpen).not.toHaveBeenCalled();
  });

  it('releases a claimed Publication half-open route after a proven pre-dispatch failure', async () => {
    const claimedUntil = new Date('2026-07-27T18:00:00.000Z');
    const maxClient = { executeActionJob: jest.fn() };
    const maxBotLinkService = {
      resolveBotRoute: jest.fn().mockResolvedValue({
        purpose: 'send_message',
        chatId: 'chat-1',
        primaryBotId: 'bot-1',
        botId: 'bot-1',
        candidateBotIds: ['bot-1'],
        quarantinedCandidateBotIds: [],
        halfOpenCandidateBotIds: ['bot-1'],
        retryAt: null,
        reason: 'primary_confirmed',
      }),
      claimSendRouteHalfOpen: jest.fn().mockResolvedValue(claimedUntil),
      releaseSendRouteHalfOpen: jest.fn().mockResolvedValue(true),
      getExecutableBotById: jest.fn((botId: string) => ({ id: botId })),
    };
    const service = new MaxActionDispatchService(
      maxClient as never,
      undefined,
      undefined,
      maxBotLinkService as never,
    );
    const preDispatchError = new Error('dispatch callback failed before MAX');

    await expect(
      service.execute(
        {
          actionType: 'SEND_MESSAGE',
          chatId: 'chat-1',
          routing: {
            purpose: 'send_message',
            sendRouteHalfOpenProbe: 'publication_exact_verification',
          },
          text: 'publication',
          attempt: 1,
          idempotencyKey: 'publication-half-open-release',
          createdAt: '2026-07-27T12:00:00.000Z',
        },
        {
          prepareAttempt: jest.fn().mockResolvedValue({}),
          onDispatchAttempt: async () => {
            await Promise.resolve();
            throw preDispatchError;
          },
        },
      ),
    ).rejects.toBe(preDispatchError);

    expect(maxBotLinkService.releaseSendRouteHalfOpen).toHaveBeenCalledWith({
      chatId: 'chat-1',
      botId: 'bot-1',
      claimedUntil,
    });
    expect(maxClient.executeActionJob).not.toHaveBeenCalled();
  });

  it('releases a half-open route when the final send guard rejects before HTTP', async () => {
    const claimedUntil = new Date('2026-08-21T18:00:00.000Z');
    const guardError = markMaxPreDispatchGuardRejected(
      new Error('suggestion claim changed'),
      'max_send_pre_dispatch_guard_rejected',
    );
    const maxClient = {
      executeActionJob: jest
        .fn()
        .mockImplementation(
          async (_job: unknown, executionOptions: { beforeSendMutation: () => Promise<void> }) => {
            await executionOptions.beforeSendMutation();
          },
        ),
    };
    const maxBotLinkService = {
      resolveBotRoute: jest.fn().mockResolvedValue({
        purpose: 'send_message',
        chatId: 'channel-1',
        primaryBotId: 'bot-1',
        botId: 'bot-1',
        candidateBotIds: ['bot-1'],
        quarantinedCandidateBotIds: [],
        halfOpenCandidateBotIds: ['bot-1'],
        retryAt: null,
        reason: 'primary_confirmed',
      }),
      claimSendRouteHalfOpen: jest.fn().mockResolvedValue(claimedUntil),
      releaseSendRouteHalfOpen: jest.fn().mockResolvedValue(true),
      getExecutableBotById: jest.fn((botId: string) => ({ id: botId })),
    };
    const service = new MaxActionDispatchService(
      maxClient as never,
      undefined,
      undefined,
      maxBotLinkService as never,
    );

    await expect(
      service.execute(
        {
          actionType: 'SEND_MESSAGE',
          chatId: 'channel-1',
          routing: {
            purpose: 'send_message',
            sendRouteHalfOpenProbe: 'publication_exact_verification',
          },
          text: 'publication',
          attempt: 1,
          idempotencyKey: 'publication-half-open-send-guard',
          createdAt: '2026-08-21T12:00:00.000Z',
        },
        {
          prepareAttempt: jest.fn().mockResolvedValue({}),
          beforeSendMutation: jest.fn().mockRejectedValue(guardError),
        },
      ),
    ).rejects.toBe(guardError);

    expect(maxBotLinkService.releaseSendRouteHalfOpen).toHaveBeenCalledWith({
      chatId: 'channel-1',
      botId: 'bot-1',
      claimedUntil,
    });
  });

  it('returns the typed pre-dispatch outcome when every routed candidate is non-executable', async () => {
    const maxClient = {
      executeActionJob: jest.fn(),
    };
    const actionLedgerService = {
      getCompletedSendDispatchResult: jest.fn().mockResolvedValue(null),
      assertCanExecute: jest.fn().mockResolvedValue(undefined),
      recordStarted: jest.fn(),
      recordFailed: jest.fn(),
    };
    const maxBotLinkService = {
      resolveBotRoute: jest.fn().mockResolvedValue({
        purpose: 'send_message',
        chatId: 'chat-1',
        primaryBotId: 'retired-bot',
        botId: 'retired-bot',
        candidateBotIds: ['retired-bot'],
        reason: 'primary_confirmed',
        routingVersion: 8,
      }),
      getExecutableBotById: jest.fn().mockReturnValue(null),
    };
    const service = new MaxActionDispatchService(
      maxClient as never,
      undefined,
      actionLedgerService as never,
      maxBotLinkService as never,
    );

    await expect(
      service.execute({
        actionType: 'SEND_MESSAGE',
        chatId: 'chat-1',
        botId: 'retired-bot',
        candidateBotIds: ['retired-bot'],
        routing: { purpose: 'send_message' },
        text: 'must not send',
        attempt: 1,
        idempotencyKey: 'no-executable-send',
        createdAt: '2026-07-11T10:00:00.000Z',
      }),
    ).rejects.toBeInstanceOf(MaxActionNoExecutableRouteError);

    expect(actionLedgerService.recordStarted).not.toHaveBeenCalled();
    expect(actionLedgerService.recordFailed).not.toHaveBeenCalled();
    expect(maxClient.executeActionJob).not.toHaveBeenCalled();
  });

  it('does not try a standby after an ambiguous routed send failure', async () => {
    const ambiguous = new UnrecoverableError(
      'Ambiguous MAX SEND_MESSAGE transport failure for chat chat-1: server failure',
    );
    const maxClient = {
      executeActionJob: jest.fn().mockRejectedValue(ambiguous),
    };
    const managedEntityAccessLossService = {
      recordIfManagedEntityAccessLost: jest.fn().mockResolvedValue(null),
    };
    const maxBotLinkService = {
      resolveBotRoute: jest.fn().mockResolvedValue({
        purpose: 'send_message',
        chatId: 'chat-1',
        primaryBotId: 'bot-1',
        botId: 'bot-1',
        candidateBotIds: ['bot-1', 'bot-2'],
        reason: 'primary_confirmed',
      }),
      getExecutableBotById: jest.fn((botId: string) => ({ id: botId })),
    };
    const service = new MaxActionDispatchService(
      maxClient as never,
      managedEntityAccessLossService as never,
      undefined,
      maxBotLinkService as never,
    );

    await expect(
      service.execute({
        actionType: 'SEND_MESSAGE',
        chatId: 'chat-1',
        botId: 'bot-1',
        candidateBotIds: ['bot-1', 'bot-2'],
        routing: { purpose: 'send_message' },
        text: 'hello',
        attempt: 1,
        idempotencyKey: 'logical-send-ambiguous',
        createdAt: '2026-07-11T10:00:00.000Z',
      }),
    ).rejects.toBe(ambiguous);

    expect(maxClient.executeActionJob).toHaveBeenCalledTimes(1);
    expect(maxClient.executeActionJob).toHaveBeenCalledWith(
      expect.objectContaining({ botId: 'bot-1' }),
    );
  });

  it('records terminal queued access loss in the ledger before stopping BullMQ retries', async () => {
    const error = createMaxApiError(403, 'chat denied', 'chat.denied');
    const maxClient = {
      executeActionJob: jest.fn().mockRejectedValue(error),
    };
    const managedEntityAccessLossService = {
      recordIfManagedEntityAccessLost: jest.fn().mockResolvedValue({
        classification: {
          kind: 'managed_entity_access_lost',
          reason: 'bot_denied',
          statusCode: 403,
          code: 'chat.denied',
          message: 'chat denied',
        },
        reason: 'bot_denied',
        recorded: null,
      } satisfies RecordManagedEntityAccessLostFromErrorResult),
    };
    const actionLedgerService = {
      recordStarted: jest.fn().mockResolvedValue(undefined),
      recordSucceeded: jest.fn().mockResolvedValue(undefined),
      recordSkipped: jest.fn().mockResolvedValue(undefined),
      recordFailed: jest.fn().mockResolvedValue(undefined),
    };
    const service = new MaxActionDispatchService(
      maxClient as never,
      managedEntityAccessLossService as never,
      actionLedgerService as never,
    );
    const job = {
      actionType: 'SEND_MESSAGE',
      chatId: 'chat-1',
      botId: 'bot-1',
      text: 'hello',
      attempt: 1,
      idempotencyKey: 'job-send-denied-ledger',
      createdAt: '2026-05-16T20:00:00.000Z',
    } as MaxActionJob;

    const thrown = await service.execute(job).then(
      () => null,
      (executeError: unknown) => executeError,
    );

    expect(thrown).toBeInstanceOf(UnrecoverableError);
    expect(thrown).toHaveProperty(
      'message',
      'MAX SEND_MESSAGE cannot be retried for chat chat-1: bot_denied',
    );
    expect(actionLedgerService.recordStarted).toHaveBeenCalledWith(job);
    expect(actionLedgerService.recordFailed).toHaveBeenCalledWith(job, thrown);
    expect(actionLedgerService.recordFailed.mock.invocationCallOrder[0]).toBeGreaterThan(
      actionLedgerService.recordStarted.mock.invocationCallOrder[0],
    );
    expect(actionLedgerService.recordSkipped).not.toHaveBeenCalled();
    expect(actionLedgerService.recordSucceeded).not.toHaveBeenCalled();
    expect((thrown as { response?: unknown }).response).toBe(
      (error as { response?: unknown }).response,
    );
  });

  it('treats queued delete message.not.found as idempotent success', async () => {
    const dispatchAttemptStartedAt = new Date('2026-08-20T12:00:00.123Z');
    jest.useFakeTimers().setSystemTime(dispatchAttemptStartedAt);
    const error = createMaxApiError(404, 'message not found', 'message.not.found');
    const maxClient = {
      executeActionJob: jest.fn().mockRejectedValue(error),
    };
    const managedEntityAccessLossService = {
      recordIfManagedEntityAccessLost: jest.fn().mockResolvedValue({
        classification: {
          kind: 'message_not_found',
          statusCode: 404,
          code: 'message.not.found',
          message: 'message not found',
        },
        reason: null,
        recorded: null,
      } satisfies RecordManagedEntityAccessLostFromErrorResult),
    };
    const service = new MaxActionDispatchService(
      maxClient as never,
      managedEntityAccessLossService as never,
    );

    await expect(
      service.execute({
        actionType: 'DELETE_MESSAGE',
        chatId: 'chat-1',
        messageId: 'message-1',
        attempt: 1,
        idempotencyKey: 'job-delete-missing',
        createdAt: '2026-05-16T20:00:00.000Z',
      } as MaxActionJob),
    ).resolves.toBeUndefined();

    expect(managedEntityAccessLossService.recordIfManagedEntityAccessLost).toHaveBeenCalledWith({
      chatId: 'chat-1',
      botId: undefined,
      operation: 'delete',
      source: 'max_action:delete_message',
      error,
      lifecycleEventAt: dispatchAttemptStartedAt,
      lifecycleEventType: 'live_probe',
      lifecycleSource: 'live_probe',
    });
  });

  it('records idempotent access-loss skips in the ledger', async () => {
    const error = createMaxApiError(404, 'message not found', 'message.not.found');
    const maxClient = {
      executeActionJob: jest.fn().mockRejectedValue(error),
    };
    const managedEntityAccessLossService = {
      recordIfManagedEntityAccessLost: jest.fn().mockResolvedValue({
        classification: {
          kind: 'message_not_found',
          statusCode: 404,
          code: 'message.not.found',
          message: 'message not found',
        },
        reason: null,
        recorded: null,
      } satisfies RecordManagedEntityAccessLostFromErrorResult),
    };
    const actionLedgerService = {
      recordStarted: jest.fn().mockResolvedValue(undefined),
      recordSucceeded: jest.fn().mockResolvedValue(undefined),
      recordSkipped: jest.fn().mockResolvedValue(undefined),
      recordFailed: jest.fn().mockResolvedValue(undefined),
    };
    const service = new MaxActionDispatchService(
      maxClient as never,
      managedEntityAccessLossService as never,
      actionLedgerService as never,
    );
    const job = {
      actionType: 'DELETE_MESSAGE',
      chatId: 'chat-1',
      messageId: 'message-1',
      attempt: 1,
      idempotencyKey: 'job-delete-missing-ledger',
      createdAt: '2026-05-16T20:00:00.000Z',
    } as MaxActionJob;

    await service.execute(job);

    expect(actionLedgerService.recordStarted).toHaveBeenCalledWith(job);
    expect(actionLedgerService.recordSkipped).toHaveBeenCalledWith(job, 'message not found');
    expect(actionLedgerService.recordSucceeded).not.toHaveBeenCalled();
    expect(actionLedgerService.recordFailed).not.toHaveBeenCalled();
  });

  it('keeps non-terminal queued action failures retryable', async () => {
    const error = createMaxApiError(500, 'server failure');
    const maxClient = {
      executeActionJob: jest.fn().mockRejectedValue(error),
    };
    const managedEntityAccessLossService = {
      recordIfManagedEntityAccessLost: jest.fn().mockResolvedValue(null),
    };
    const service = new MaxActionDispatchService(
      maxClient as never,
      managedEntityAccessLossService as never,
    );

    await expect(
      service.execute({
        actionType: 'SEND_MESSAGE',
        chatId: 'chat-1',
        text: 'hello',
        attempt: 1,
        idempotencyKey: 'job-send-500',
        createdAt: '2026-05-16T20:00:00.000Z',
      } as MaxActionJob),
    ).rejects.toBe(error);
  });

  it('records retryable queued action failures in the ledger', async () => {
    const error = createMaxApiError(500, 'server failure');
    const maxClient = {
      executeActionJob: jest.fn().mockRejectedValue(error),
    };
    const managedEntityAccessLossService = {
      recordIfManagedEntityAccessLost: jest.fn().mockResolvedValue(null),
    };
    const actionLedgerService = {
      recordStarted: jest.fn().mockResolvedValue(undefined),
      recordSucceeded: jest.fn().mockResolvedValue(undefined),
      recordSkipped: jest.fn().mockResolvedValue(undefined),
      recordFailed: jest.fn().mockResolvedValue(undefined),
    };
    const service = new MaxActionDispatchService(
      maxClient as never,
      managedEntityAccessLossService as never,
      actionLedgerService as never,
    );
    const job = {
      actionType: 'SEND_MESSAGE',
      chatId: 'chat-1',
      text: 'hello',
      attempt: 1,
      idempotencyKey: 'job-send-500-ledger',
      createdAt: '2026-05-16T20:00:00.000Z',
    } as MaxActionJob;

    await expect(service.execute(job)).rejects.toBe(error);

    expect(actionLedgerService.recordStarted).toHaveBeenCalledWith(job);
    expect(actionLedgerService.recordFailed).toHaveBeenCalledWith(job, error, {
      exhausted: false,
    });
    expect(actionLedgerService.recordSucceeded).not.toHaveBeenCalled();
    expect(actionLedgerService.recordSkipped).not.toHaveBeenCalled();
  });

  it('marks final retryable queued action failures as exhausted in the ledger', async () => {
    const error = createMaxApiError(500, 'server failure');
    const maxClient = {
      executeActionJob: jest.fn().mockRejectedValue(error),
    };
    const managedEntityAccessLossService = {
      recordIfManagedEntityAccessLost: jest.fn().mockResolvedValue(null),
    };
    const actionLedgerService = {
      recordStarted: jest.fn().mockResolvedValue(undefined),
      recordSucceeded: jest.fn().mockResolvedValue(undefined),
      recordSkipped: jest.fn().mockResolvedValue(undefined),
      recordFailed: jest.fn().mockResolvedValue(undefined),
    };
    const service = new MaxActionDispatchService(
      maxClient as never,
      managedEntityAccessLossService as never,
      actionLedgerService as never,
    );
    const job = {
      actionType: 'SEND_MESSAGE',
      chatId: 'chat-1',
      text: 'hello',
      attempt: 5,
      idempotencyKey: 'job-send-500-final-ledger',
      createdAt: '2026-05-16T20:00:00.000Z',
    } as MaxActionJob;

    await expect(service.execute(job, { finalAttempt: true })).rejects.toBe(error);

    expect(actionLedgerService.recordStarted).toHaveBeenCalledWith(job);
    expect(actionLedgerService.recordFailed).toHaveBeenCalledWith(job, error, {
      exhausted: true,
    });
    expect(actionLedgerService.recordSucceeded).not.toHaveBeenCalled();
    expect(actionLedgerService.recordSkipped).not.toHaveBeenCalled();
  });
});
