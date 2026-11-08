import { UnrecoverableError } from 'bullmq';
import { buildNightModeTransitionScheduleFingerprint } from '../moderation/night-mode-transition-generation.util';
import {
  getNightModeTransitionAccessRecoveryMarker,
  markMaxSendDispatchLedgerFinalized,
  MAX_SEND_LEDGER_PREPARATION_ERROR_CODES,
  MaxActionLedgerService,
  prepareDefinitivelyRejectedNightModeOpenRetry,
  prepareDefinitivelyRejectedNightModeTransitionRetry,
} from './max-action-ledger.service';
import {
  ChatBotAccessState,
  ChatBotMembershipStatus,
  MaxActionLedgerStatus,
  Prisma,
} from '../prisma/prisma-client';
import {
  MAX_SEND_AUTO_DELETE_CONFIRMATION_KINDS,
  MAX_SEND_AUTO_DELETE_MARKER_VERSION,
  type MaxActionJob,
} from './max-client.service';
import {
  MAX_MEMBER_PRE_DISPATCH_GUARD_REJECTED_CODE,
  MAX_SEND_PRE_DISPATCH_GUARD_REJECTED_CODE,
  markMaxPreDispatchGuardRejected,
} from './max-action-pre-dispatch-guard';
import { markMaxMessageSendAttempted } from './max-mutation-outcome.util';
import {
  MAX_MEDIA_UPLOAD_VALIDATION_ERROR_CODES,
  MaxMediaUploadValidationError,
} from './max-media-upload-validation';
import { markMaxMemberMutationAttempted } from './max-member-error.util';
import { createMaxSendAutoDeleteVerificationError } from './max-send-auto-delete-verification-error';

const FUTURE_NIGHT_SCHEDULE_FINGERPRINT = buildNightModeTransitionScheduleFingerprint({
  nightModeEnabled: true,
  nightModeStartTimeMinutes: 23 * 60,
  nightModeEndTimeMinutes: 8 * 60,
  nightModeTimezone: 'Europe/Moscow',
});

function createJob(overrides: Partial<MaxActionJob> = {}): MaxActionJob {
  return {
    actionType: 'SEND_MESSAGE',
    chatId: 'chat-1',
    botId: 'bot-1',
    text: 'hello',
    attempt: 1,
    idempotencyKey: 'job-1',
    createdAt: '2026-07-06T20:00:00.000Z',
    ...overrides,
  } as MaxActionJob;
}

function createService(row: unknown = null, legacyHolds?: unknown) {
  const prisma = {
    $transaction: jest.fn(),
    $executeRaw: jest.fn().mockResolvedValue(0),
    $queryRaw: jest.fn().mockResolvedValue([]),
    maxActionLedgerEntry: {
      findFirst: jest.fn().mockResolvedValue(row),
      findMany: jest.fn().mockResolvedValue(Array.isArray(row) ? row : row ? [row] : []),
      findUnique: jest.fn().mockResolvedValue(row),
      createMany: jest.fn().mockResolvedValue({ count: 1 }),
      deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
      upsert: jest.fn().mockResolvedValue(undefined),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
  };
  prisma.$transaction.mockImplementation(
    async (operation: (tx: typeof prisma) => Promise<unknown>) => operation(prisma),
  );
  return {
    prisma,
    service: new MaxActionLedgerService(prisma as never, legacyHolds as never),
  };
}

describe('MaxActionLedgerService', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it.each(
    (['BAN_MEMBER', 'KICK_MEMBER', 'TRY_UNBAN_MEMBER'] as const).flatMap((actionType) =>
      (['isMemberHeld', 'isGlobalUserHeld', 'isOutboundJobHeld'] as const).map((method) => ({
        actionType,
        method,
      })),
    ),
  )(
    'keeps $actionType behind a permanent $method hold before starting its ledger',
    async ({ actionType, method }) => {
      const holds = {
        isMessageHeld: jest.fn().mockResolvedValue(false),
        isMemberHeld: jest.fn().mockResolvedValue(false),
        isGlobalUserHeld: jest.fn().mockResolvedValue(false),
        isLegacyChatSendHeld: jest.fn().mockResolvedValue(false),
        isOutboundJobHeld: jest.fn().mockResolvedValue(false),
      };
      holds[method].mockResolvedValue(true);
      const { service, prisma } = createService(null, holds);
      const job = createJob({ actionType, userId: 'user-1', idempotencyKey: 'new-member-key' });
      await expect(service.recordStarted(job)).rejects.toMatchObject({
        code: 'webhook_legacy_effect_held',
      });
      expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
      expect(prisma.maxActionLedgerEntry.createMany).not.toHaveBeenCalled();
      expect(prisma.maxActionLedgerEntry.updateMany).not.toHaveBeenCalled();
      expect(holds[method]).toHaveBeenCalledWith(
        ...(method === 'isMemberHeld'
          ? [job.chatId, job.userId, prisma]
          : [method === 'isGlobalUserHeld' ? job.userId : job.idempotencyKey, prisma]),
      );
    },
  );

  it('fails closed on an authoritative hold lookup failure under the member SQL lock', async () => {
    const failure = new Error('Fixture legacy hold database unavailable');
    const holds = {
      isMessageHeld: jest.fn().mockResolvedValue(false),
      isMemberHeld: jest.fn().mockResolvedValue(false),
      isGlobalUserHeld: jest.fn().mockResolvedValue(false),
      isLegacyChatSendHeld: jest.fn().mockResolvedValue(false),
      isOutboundJobHeld: jest.fn().mockRejectedValue(failure),
    };
    const { service, prisma } = createService(null, holds);
    await expect(
      service.recordStarted(createJob({ actionType: 'BAN_MEMBER', userId: 'user-1' })),
    ).rejects.toBe(failure);
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
    expect(prisma.maxActionLedgerEntry.createMany).not.toHaveBeenCalled();
    expect(prisma.maxActionLedgerEntry.updateMany).not.toHaveBeenCalled();
  });

  it('does not create a second member execution after an unknown effect under another bot key', async () => {
    const { prisma, service } = createService();
    prisma.$queryRaw
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ job_id: 'legacy-bot-a-ban' }]);
    const job = createJob({
      actionType: 'KICK_MEMBER',
      userId: 'user-1',
      botId: 'reserve-last',
      idempotencyKey: 'new-kick',
    });
    await expect(service.recordStarted(job)).rejects.toThrow(
      'Retained member action requires settlement',
    );
    expect(prisma.maxActionLedgerEntry.createMany).not.toHaveBeenCalled();
    expect(prisma.maxActionLedgerEntry.updateMany).not.toHaveBeenCalled();
  });

  it('prepares only an exact definitively rejected night-mode open send for retry', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-08-21T10:00:00.000Z'));
    const tx = {
      chatBotMembership: {
        findFirst: jest.fn().mockResolvedValue({ id: 'membership-1' }),
      },
      maxActionLedgerEntry: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    const prisma = {
      $transaction: jest.fn(async (operation: (client: typeof tx) => Promise<unknown>) =>
        operation(tx),
      ),
    };

    await expect(
      prepareDefinitivelyRejectedNightModeOpenRetry(prisma as never, {
        chatId: ' chat-1 ',
        sessionKey: ' session-1 ',
        actionableBotIds: [' bot-1 ', 'bot-1'],
      }),
    ).resolves.toEqual({
      kind: 'ready',
      jobId: 'night-mode:open:chat-1:session:session-1',
    });

    expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
    });
    expect(tx.chatBotMembership.findFirst).toHaveBeenCalledWith({
      where: {
        chatId: 'chat-1',
        status: ChatBotMembershipStatus.ACTIVE,
        botAccessState: {
          in: [ChatBotAccessState.CONFIRMED_ADMIN, ChatBotAccessState.CONFIRMED_OWNER],
        },
        botAccessCheckedAt: { not: null },
        botId: { in: ['bot-1'] },
      },
      select: { id: true },
    });
    expect(tx.maxActionLedgerEntry.updateMany).toHaveBeenCalledWith({
      where: {
        jobId: 'night-mode:open:chat-1:session:session-1',
        actionType: 'SEND_MESSAGE',
        chatId: 'chat-1',
        sourceTag: 'night_mode_transition',
        ambiguous: false,
        dispatchToken: null,
        dispatchStartedAt: null,
        dispatchBotId: null,
        remoteMessageId: null,
        AND: [
          {
            OR: [
              { lastStatusCode: { in: [403, 404] } },
              {
                lastStatusCode: null,
                lastErrorCode: {
                  in: ['access.denied', 'chat.denied', 'chat.not.found'],
                },
              },
            ],
          },
          {
            OR: [
              {
                status: MaxActionLedgerStatus.FAILED_TERMINAL,
                terminal: true,
                attemptCount: { gte: 1 },
                firstAttemptAt: { not: null },
                lastAttemptAt: { not: null },
                completedAt: { not: null },
              },
              {
                status: MaxActionLedgerStatus.ENQUEUED,
                terminal: false,
                attemptCount: 0,
                enqueuedAt: { not: null },
                firstAttemptAt: null,
                lastAttemptAt: null,
                completedAt: null,
                lastError: 'Night mode open retry prepared after a definitive access rejection',
              },
            ],
          },
        ],
      },
      data: {
        status: MaxActionLedgerStatus.ENQUEUED,
        ambiguous: false,
        terminal: false,
        attemptCount: 0,
        enqueuedAt: new Date('2026-08-21T10:00:00.000Z'),
        firstAttemptAt: null,
        lastAttemptAt: null,
        completedAt: null,
        lastError: 'Night mode open retry prepared after a definitive access rejection',
        dispatchToken: null,
        dispatchStartedAt: null,
        dispatchBotId: null,
        remoteMessageId: null,
      },
    });
  });

  it('prepares an exact definitively rejected night-mode close send with its own marker', async () => {
    const tx = {
      chatBotMembership: {
        findFirst: jest.fn().mockResolvedValue({ id: 'membership-1' }),
      },
      maxActionLedgerEntry: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    const prisma = {
      $transaction: jest.fn(async (operation: (client: typeof tx) => Promise<unknown>) =>
        operation(tx),
      ),
    };

    await expect(
      prepareDefinitivelyRejectedNightModeTransitionRetry(prisma as never, {
        chatId: 'chat-1',
        sessionKey: 'session-1',
        transition: 'close',
        actionableBotIds: ['bot-1'],
      }),
    ).resolves.toEqual({
      kind: 'ready',
      jobId: 'night-mode:close:chat-1:session:session-1',
    });

    const closeMarker = getNightModeTransitionAccessRecoveryMarker('close');
    const update = tx.maxActionLedgerEntry.updateMany.mock.calls[0]?.[0];
    expect(update.where.jobId).toBe('night-mode:close:chat-1:session:session-1');
    expect(update.where.AND[1].OR[1]).toEqual(
      expect.objectContaining({
        status: MaxActionLedgerStatus.ENQUEUED,
        terminal: false,
        attemptCount: 0,
        lastError: closeMarker,
      }),
    );
    expect(update.data.lastError).toBe(closeMarker);
    expect(closeMarker).not.toBe(getNightModeTransitionAccessRecoveryMarker('open'));
  });

  it('keeps unknown-code HTTP 403/404 and status-less canonical access codes recoverable', async () => {
    const tx = {
      chatBotMembership: {
        findFirst: jest.fn().mockResolvedValue({ id: 'membership-1' }),
      },
      maxActionLedgerEntry: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    const prisma = {
      $transaction: jest.fn(async (operation: (client: typeof tx) => Promise<unknown>) =>
        operation(tx),
      ),
    };

    await prepareDefinitivelyRejectedNightModeOpenRetry(prisma as never, {
      chatId: 'chat-1',
      sessionKey: 'session-1',
      actionableBotIds: ['bot-1'],
    });

    const rejectionFilter = tx.maxActionLedgerEntry.updateMany.mock.calls[0]?.[0]?.where?.AND?.[0];
    expect(rejectionFilter).toEqual({
      OR: [
        { lastStatusCode: { in: [403, 404] } },
        {
          lastStatusCode: null,
          lastErrorCode: {
            in: ['access.denied', 'chat.denied', 'chat.not.found'],
          },
        },
      ],
    });
    expect(rejectionFilter.OR[0]).not.toHaveProperty('lastErrorCode');
    expect(rejectionFilter.OR).not.toContainEqual(
      expect.objectContaining({ lastStatusCode: { in: expect.arrayContaining([408]) } }),
    );
  });

  it.each([
    ['fresh access is absent', null, { count: 1 }, 'no_fresh_access'],
    [
      'the ledger CAS loses a race',
      { id: 'membership-1' },
      { count: 0 },
      'unsafe_prior_provenance',
    ],
  ])('fails closed when %s', async (_label, membership, updateResult, category) => {
    const tx = {
      chatBotMembership: {
        findFirst: jest.fn().mockResolvedValue(membership),
      },
      maxActionLedgerEntry: {
        updateMany: jest.fn().mockResolvedValue(updateResult),
      },
    };
    const prisma = {
      $transaction: jest.fn(async (operation: (client: typeof tx) => Promise<unknown>) =>
        operation(tx),
      ),
    };

    await expect(
      prepareDefinitivelyRejectedNightModeOpenRetry(prisma as never, {
        chatId: 'chat-1',
        sessionKey: 'session-1',
        actionableBotIds: ['bot-1'],
      }),
    ).resolves.toEqual({
      kind: 'blocked',
      jobId: 'night-mode:open:chat-1:session:session-1',
      category,
    });

    expect(tx.maxActionLedgerEntry.updateMany).toHaveBeenCalledTimes(membership ? 1 : 0);
  });

  it.each([
    ['an empty registry', []],
    ['only blank bot ids', [' ', '']],
    ['an unavailable registry', undefined],
    ['a null registry snapshot', null],
  ])('fails closed with %s before opening a transaction', async (_label, actionableBotIds) => {
    const prisma = { $transaction: jest.fn() };

    await expect(
      prepareDefinitivelyRejectedNightModeOpenRetry(prisma as never, {
        chatId: 'chat-1',
        sessionKey: 'session-1',
        actionableBotIds,
      }),
    ).resolves.toEqual({
      kind: 'blocked',
      jobId: 'night-mode:open:chat-1:session:session-1',
      category: 'no_fresh_access',
    });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('recognizes only a succeeded delete as confirmed exact message cleanup', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-07-16T12:00:00.000Z'));
    const { service, prisma } = createService({ id: 'delete-job-1' });

    await expect(service.hasSucceededDelete(' chat-1 ', ' message-1 ')).resolves.toBe(true);

    expect(prisma.maxActionLedgerEntry.findMany).toHaveBeenCalledWith({
      where: {
        chatId: 'chat-1',
        actionType: 'DELETE_MESSAGE',
        messageId: 'message-1',
        status: MaxActionLedgerStatus.SUCCEEDED,
        updatedAt: {
          gte: new Date('2026-07-16T10:00:00.000Z'),
        },
      },
      select: {
        id: true,
        metadata: true,
        sourceTag: true,
      },
      orderBy: {
        updatedAt: 'desc',
      },
      take: 20,
    });
  });

  it('does not claim delete ownership without a succeeded exact ledger row', async () => {
    const { service } = createService(null);

    await expect(service.hasSucceededDelete('chat-1', 'message-1')).resolves.toBe(false);
  });

  it('does not trust an unmarked legacy moderation-notice delete success', async () => {
    const { service } = createService({
      id: 'legacy-auto-delete-job-1',
      sourceTag: 'moderation_notice',
      metadata: {},
    });

    await expect(service.hasSucceededDelete('chat-1', 'message-1')).resolves.toBe(false);
  });

  it('preserves succeeded-delete ownership for other unmarked delete sources', async () => {
    const { service } = createService({
      id: 'ordinary-delete-job-1',
      sourceTag: 'moderation_delete',
      metadata: {},
    });

    await expect(service.hasSucceededDelete('chat-1', 'message-1')).resolves.toBe(true);
  });

  it('does not trust a marked auto-delete success without a confirmation receipt', async () => {
    const { service } = createService({
      id: 'delete-job-1',
      metadata: {
        sendAutoDelete: {
          version: 1,
          sourceSendJobId: 'send-job-1',
          sourceSendCompletedAt: '2026-08-31T12:00:00.000Z',
          requestedDelayMs: 60_000,
          originBotId: 'bot-1',
        },
      },
    });

    await expect(service.hasSucceededDelete('chat-1', 'message-1')).resolves.toBe(false);
  });

  it('trusts a v2 documented DELETE success receipt', async () => {
    const { service } = createService({
      id: 'delete-job-1',
      metadata: {
        sendAutoDelete: {
          version: MAX_SEND_AUTO_DELETE_MARKER_VERSION,
          sourceSendJobId: 'send-job-1',
          sourceSendCompletedAt: '2026-08-31T12:00:00.000Z',
          requestedDelayMs: 60_000,
          originBotId: 'bot-1',
          confirmedAt: '2026-08-31T12:01:00.000Z',
          confirmationKind: MAX_SEND_AUTO_DELETE_CONFIRMATION_KINDS.DOCUMENTED_DELETE_SUCCESS,
        },
      },
    });

    await expect(service.hasSucceededDelete('chat-1', 'message-1')).resolves.toBe(true);
  });

  it('trusts a legacy v1 post-delete receipt derived from documented DELETE success', async () => {
    const { service } = createService({
      id: 'delete-job-1',
      metadata: {
        sendAutoDelete: {
          version: 1,
          sourceSendJobId: 'send-job-1',
          sourceSendCompletedAt: '2026-08-31T12:00:00.000Z',
          requestedDelayMs: 60_000,
          originBotId: 'bot-1',
          exactAbsenceVerifiedAt: '2026-08-31T12:01:00.000Z',
          exactAbsenceVerificationPhase: 'post_delete',
        },
      },
    });

    await expect(service.hasSucceededDelete('chat-1', 'message-1')).resolves.toBe(true);
  });

  it('does not trust a legacy v1 preflight receipt that may come from access-masked 404', async () => {
    const { service } = createService({
      id: 'delete-job-1',
      metadata: {
        sendAutoDelete: {
          version: 1,
          sourceSendJobId: 'send-job-1',
          sourceSendCompletedAt: '2026-08-31T12:00:00.000Z',
          requestedDelayMs: 60_000,
          originBotId: 'bot-1',
          exactAbsenceVerifiedAt: '2026-08-31T12:01:00.000Z',
          exactAbsenceVerificationPhase: 'preflight',
        },
      },
    });

    await expect(service.hasSucceededDelete('chat-1', 'message-1')).resolves.toBe(false);
  });

  it('finds an older verified receipt behind a newer unverified legacy row', async () => {
    const { service } = createService([
      {
        id: 'legacy-auto-delete-newer',
        sourceTag: 'moderation_notice',
        metadata: {},
      },
      {
        id: 'verified-auto-delete-older',
        sourceTag: 'moderation_notice',
        metadata: {
          sendAutoDelete: {
            version: 1,
            sourceSendJobId: 'send-job-1',
            sourceSendCompletedAt: '2026-08-31T12:00:00.000Z',
            requestedDelayMs: 60_000,
            originBotId: 'bot-1',
            exactAbsenceVerifiedAt: '2026-08-31T12:01:00.000Z',
            exactAbsenceVerificationPhase: 'post_delete',
          },
        },
      },
    ]);

    await expect(service.hasSucceededDelete('chat-1', 'message-1')).resolves.toBe(true);
  });

  it('reconciles only the exact persisted verified auto-delete success', async () => {
    const sendAutoDelete = {
      version: MAX_SEND_AUTO_DELETE_MARKER_VERSION,
      sourceSendJobId: 'send-job-1',
      sourceSendCompletedAt: '2026-08-31T12:00:00.000Z',
      requestedDelayMs: 60_000,
      originBotId: 'bot-1',
      confirmedAt: '2026-08-31T12:01:00.000Z',
      confirmationKind: MAX_SEND_AUTO_DELETE_CONFIRMATION_KINDS.DOCUMENTED_DELETE_SUCCESS,
    };
    const { service, prisma } = createService({
      actionType: 'DELETE_MESSAGE',
      chatId: 'chat-1',
      messageId: 'message-1',
      status: MaxActionLedgerStatus.SUCCEEDED,
      ambiguous: false,
      terminal: true,
      metadata: { sendAutoDelete },
    });
    const job = createJob({
      actionType: 'DELETE_MESSAGE',
      messageId: 'message-1',
      text: undefined,
      idempotencyKey: 'delete-job-1',
      sendAutoDelete,
    });

    await expect(service.hasRecordedVerifiedSendAutoDeleteSuccess(job)).resolves.toBe(true);
    expect(prisma.maxActionLedgerEntry.findUnique).toHaveBeenCalledWith({
      where: { jobId: 'delete-job-1' },
      select: {
        actionType: true,
        chatId: true,
        messageId: true,
        status: true,
        ambiguous: true,
        terminal: true,
        metadata: true,
      },
    });

    await expect(
      service.hasRecordedVerifiedSendAutoDeleteSuccess({
        ...job,
        sendAutoDelete: { ...sendAutoDelete, confirmedAt: '2026-08-31T12:01:01.000Z' },
      }),
    ).resolves.toBe(false);
  });

  it('scopes proved nonambiguous terminal ban cleanup after a confirmed unban', async () => {
    const { service, prisma } = createService();

    await service.clearTerminalBanStateAfterUnban(' chat-1 ', ' user-1 ');

    expect(prisma.maxActionLedgerEntry.deleteMany).toHaveBeenCalledWith({
      where: expect.objectContaining({
        chatId: 'chat-1',
        userId: 'user-1',
        actionType: 'BAN_MEMBER',
        terminal: true,
        ambiguous: false,
        OR: expect.any(Array),
      }),
    });
  });

  it('clears only the exact legacy pre-dispatch no-route send failure', async () => {
    const job = createJob({
      chatId: 'chat-1',
      idempotencyKey: 'night-mode:open:chat-1:session:session-1',
    });
    const { service, prisma } = createService({
      status: MaxActionLedgerStatus.FAILED_TERMINAL,
      ambiguous: false,
      terminal: true,
      attemptCount: 1,
      firstAttemptAt: new Date('2026-07-06T20:00:00.000Z'),
      lastAttemptAt: new Date('2026-07-06T20:00:00.000Z'),
      lastStatusCode: null,
      lastErrorCode: null,
      lastError: 'MAX SEND_MESSAGE has no executable routed bot candidate for chat chat-1',
      dispatchToken: null,
      dispatchStartedAt: null,
      dispatchBotId: null,
      remoteMessageId: null,
    });

    await expect(service.assertCanExecute(job)).resolves.toBeUndefined();

    expect(prisma.maxActionLedgerEntry.deleteMany).toHaveBeenCalledWith({
      where: {
        jobId: 'night-mode:open:chat-1:session:session-1',
        actionType: 'SEND_MESSAGE',
        chatId: 'chat-1',
        status: MaxActionLedgerStatus.FAILED_TERMINAL,
        ambiguous: false,
        terminal: true,
        lastStatusCode: null,
        lastErrorCode: null,
        lastError: 'MAX SEND_MESSAGE has no executable routed bot candidate for chat chat-1',
        dispatchToken: null,
        dispatchStartedAt: null,
        dispatchBotId: null,
        remoteMessageId: null,
      },
    });
  });

  it('does not clear a terminal send with dispatch evidence even when its message resembles no-route', async () => {
    const { service, prisma } = createService({
      status: MaxActionLedgerStatus.FAILED_TERMINAL,
      ambiguous: false,
      terminal: true,
      attemptCount: 1,
      firstAttemptAt: new Date('2026-07-06T20:00:00.000Z'),
      lastAttemptAt: new Date('2026-07-06T20:00:00.000Z'),
      lastStatusCode: null,
      lastErrorCode: null,
      lastError: 'MAX SEND_MESSAGE has no executable routed bot candidate for chat chat-1',
      dispatchToken: 'retained-dispatch-token',
      dispatchStartedAt: new Date('2026-07-06T20:00:01.000Z'),
      dispatchBotId: 'bot-1',
      remoteMessageId: null,
    });

    await expect(service.assertCanExecute(createJob())).rejects.toBeInstanceOf(UnrecoverableError);
    expect(prisma.maxActionLedgerEntry.deleteMany).not.toHaveBeenCalled();
  });

  it.each([
    [null, 'Не удалось загрузить видео: MAX upload payload is missing'],
    [
      'ledger.watchdog.pre_dispatch_orphan',
      'Pre-dispatch MAX SEND_MESSAGE ledger entry has no retained dispatch fence; BullMQ states missing. The action was not requeued.',
    ],
  ])(
    'clears an exact historical managed-broadcast pre-dispatch video failure',
    async (lastErrorCode, lastError) => {
      const job = createJob({
        idempotencyKey:
          'managed-broadcast:send:broadcast-1:occurrence:1:target:chat-1:content:revision-1',
      });
      const { service, prisma } = createService({
        status: MaxActionLedgerStatus.FAILED_TERMINAL,
        ambiguous: false,
        terminal: true,
        attemptCount: 1,
        firstAttemptAt: new Date('2026-05-01T10:00:00.000Z'),
        lastAttemptAt: new Date('2026-05-01T10:00:00.000Z'),
        lastStatusCode: null,
        lastErrorCode,
        lastError,
        dispatchToken: null,
        dispatchStartedAt: null,
        dispatchBotId: null,
        remoteMessageId: null,
      });

      await expect(service.assertCanEnqueue(job)).resolves.toBeUndefined();
      expect(prisma.maxActionLedgerEntry.deleteMany).toHaveBeenCalledWith({
        where: expect.objectContaining({
          jobId: job.idempotencyKey,
          actionType: 'SEND_MESSAGE',
          chatId: 'chat-1',
          status: MaxActionLedgerStatus.FAILED_TERMINAL,
          ambiguous: false,
          terminal: true,
          lastStatusCode: null,
          dispatchToken: null,
          dispatchStartedAt: null,
          dispatchBotId: null,
          remoteMessageId: null,
          OR: expect.any(Array),
        }),
      });
    },
  );

  it('does not clear the historical upload error for an unrelated send job', async () => {
    const { service, prisma } = createService({
      status: MaxActionLedgerStatus.FAILED_TERMINAL,
      ambiguous: false,
      terminal: true,
      attemptCount: 1,
      firstAttemptAt: new Date('2026-05-01T10:00:00.000Z'),
      lastAttemptAt: new Date('2026-05-01T10:00:00.000Z'),
      lastStatusCode: null,
      lastErrorCode: null,
      lastError: 'не удалось загрузить видео: max upload payload is missing',
      dispatchToken: null,
      dispatchStartedAt: null,
      dispatchBotId: null,
      remoteMessageId: null,
    });

    await expect(service.assertCanExecute(createJob())).rejects.toBeInstanceOf(UnrecoverableError);
    expect(prisma.maxActionLedgerEntry.deleteMany).not.toHaveBeenCalled();
  });

  it.each([
    { dispatchToken: 'dispatch-token-1' },
    { dispatchStartedAt: new Date('2026-05-01T10:00:01.000Z') },
    { dispatchBotId: 'bot-1' },
  ])(
    'does not clear a managed-broadcast upload failure with dispatch evidence',
    async (evidence) => {
      const { service, prisma } = createService({
        status: MaxActionLedgerStatus.FAILED_TERMINAL,
        ambiguous: false,
        terminal: true,
        attemptCount: 1,
        firstAttemptAt: new Date('2026-05-01T10:00:00.000Z'),
        lastAttemptAt: new Date('2026-05-01T10:00:00.000Z'),
        lastStatusCode: null,
        lastErrorCode: null,
        lastError: 'не удалось загрузить видео: max upload payload is missing',
        dispatchToken: null,
        dispatchStartedAt: null,
        dispatchBotId: null,
        remoteMessageId: null,
        ...evidence,
      });
      const job = createJob({
        idempotencyKey:
          'managed-broadcast:send:broadcast-1:occurrence:1:target:chat-1:content:revision-1',
      });

      await expect(service.assertCanExecute(job)).rejects.toBeInstanceOf(UnrecoverableError);
      expect(prisma.maxActionLedgerEntry.deleteMany).not.toHaveBeenCalled();
    },
  );

  it('keeps a recovered managed-broadcast remote message id without clearing its ledger row', async () => {
    const { service, prisma } = createService({
      status: MaxActionLedgerStatus.FAILED_TERMINAL,
      ambiguous: false,
      terminal: true,
      lastStatusCode: null,
      lastErrorCode: null,
      lastError: 'не удалось загрузить видео: max upload payload is missing',
      dispatchToken: null,
      dispatchStartedAt: null,
      dispatchBotId: null,
      remoteMessageId: 'mid-1',
    });
    const job = createJob({
      idempotencyKey:
        'managed-broadcast:send:broadcast-1:occurrence:1:target:chat-1:content:revision-1',
    });

    await expect(service.assertCanExecute(job)).resolves.toBeUndefined();
    expect(prisma.maxActionLedgerEntry.deleteMany).not.toHaveBeenCalled();
  });

  it('blocks enqueue when an irreversible job is already quarantined as ambiguous', async () => {
    const { service } = createService({
      status: MaxActionLedgerStatus.AMBIGUOUS,
      ambiguous: true,
      terminal: true,
      lastError: 'ambiguous max send_message transport failure',
    });

    await expect(service.assertCanEnqueue(createJob())).rejects.toBeInstanceOf(UnrecoverableError);
  });

  it('does not block retryable or non-irreversible ledger rows', async () => {
    const { service: retryableService } = createService({
      status: MaxActionLedgerStatus.FAILED_RETRYABLE,
      ambiguous: false,
      terminal: false,
      lastError: 'server failure',
    });

    await expect(retryableService.assertCanEnqueue(createJob())).resolves.toBeUndefined();

    const { service: deleteService, prisma } = createService({
      status: MaxActionLedgerStatus.AMBIGUOUS,
      ambiguous: true,
      terminal: true,
      lastError: 'ambiguous max delete_message transport failure',
    });

    await expect(
      deleteService.assertCanEnqueue(
        createJob({
          actionType: 'DELETE_MESSAGE',
          messageId: 'mid-1',
          text: undefined,
        }),
      ),
    ).resolves.toBeUndefined();
    expect(prisma.maxActionLedgerEntry.findUnique).not.toHaveBeenCalled();
  });

  it('blocks terminal SEND_MESSAGE rows that have no recoverable remote message id', async () => {
    const { service } = createService({
      status: MaxActionLedgerStatus.FAILED_TERMINAL,
      ambiguous: false,
      terminal: true,
      dispatchToken: null,
      dispatchStartedAt: null,
      remoteMessageId: null,
    });

    await expect(service.assertCanEnqueue(createJob())).rejects.toThrow(
      'has no recoverable remote message id',
    );
  });

  it('blocks execution when a recovered BullMQ job races with terminal ledger state', async () => {
    const { service } = createService({
      status: MaxActionLedgerStatus.FAILED_TERMINAL,
      ambiguous: false,
      terminal: true,
      dispatchToken: null,
      dispatchStartedAt: null,
      remoteMessageId: null,
    });

    await expect(
      service.assertCanExecute(
        createJob({
          actionType: 'KICK_MEMBER',
          userId: 'user-1',
          text: undefined,
        }),
      ),
    ).rejects.toBeInstanceOf(UnrecoverableError);
  });

  it.each([
    ['BAN_MEMBER', 'max_api_internal_rate_limit'],
    ['KICK_MEMBER', 'max_api_circuit_open'],
    ['BAN_MEMBER', 'max_api_external_rate_limit'],
    ['BAN_MEMBER', 'moderation_sanction_state_lock_lease_lost'],
    ['KICK_MEMBER', 'moderation_sanction_state_lock_unavailable'],
    ['BAN_MEMBER', MAX_MEMBER_PRE_DISPATCH_GUARD_REJECTED_CODE],
  ] as const)(
    'allows %s execution after a proven pre-dispatch %s failure',
    async (actionType, lastErrorCode) => {
      const { service } = createService({
        status: MaxActionLedgerStatus.FAILED_RETRYABLE,
        ambiguous: false,
        terminal: false,
        attemptCount: 1,
        firstAttemptAt: new Date('2026-07-06T20:00:00.000Z'),
        lastAttemptAt: new Date('2026-07-06T20:00:00.000Z'),
        lastErrorCode,
        dispatchToken: null,
        dispatchStartedAt: null,
        dispatchBotId: null,
        remoteMessageId: null,
      });

      await expect(
        service.assertCanExecute(
          createJob({
            actionType,
            userId: 'user-1',
            text: undefined,
          }),
        ),
      ).resolves.toBeUndefined();
    },
  );

  it.each(['KICK_MEMBER', 'BAN_MEMBER'] as const)(
    'blocks a stalled %s ledger row from executing or being enqueued again',
    async (actionType) => {
      const row = {
        status: MaxActionLedgerStatus.IN_PROGRESS,
        ambiguous: false,
        terminal: false,
        attemptCount: 1,
        firstAttemptAt: new Date('2026-07-06T20:00:00.000Z'),
        lastAttemptAt: new Date('2026-07-06T20:00:00.000Z'),
        lastErrorCode: null,
        dispatchToken: null,
        dispatchStartedAt: null,
        dispatchBotId: null,
        remoteMessageId: null,
      };
      const job = createJob({ actionType, userId: 'user-1', text: undefined });

      await expect(createService(row).service.assertCanExecute(job)).rejects.toBeInstanceOf(
        UnrecoverableError,
      );
      await expect(createService(row).service.assertCanEnqueue(job)).rejects.toBeInstanceOf(
        UnrecoverableError,
      );
    },
  );

  it('blocks a generic post-dispatch retryable member failure', async () => {
    const { service } = createService({
      status: MaxActionLedgerStatus.FAILED_RETRYABLE,
      ambiguous: false,
      terminal: false,
      attemptCount: 1,
      firstAttemptAt: new Date('2026-07-06T20:00:00.000Z'),
      lastAttemptAt: new Date('2026-07-06T20:00:01.000Z'),
      lastErrorCode: 'server.failure',
      dispatchToken: null,
      dispatchStartedAt: null,
      dispatchBotId: null,
      remoteMessageId: null,
    });

    await expect(
      service.assertCanExecute(
        createJob({ actionType: 'KICK_MEMBER', userId: 'user-1', text: undefined }),
      ),
    ).rejects.toBeInstanceOf(UnrecoverableError);
  });

  it('allows one worker to claim a completely unattempted retryable member enqueue row', async () => {
    const { service } = createService({
      status: MaxActionLedgerStatus.FAILED_RETRYABLE,
      ambiguous: false,
      terminal: false,
      attemptCount: 0,
      firstAttemptAt: null,
      lastAttemptAt: null,
      lastErrorCode: 'econnreset',
      dispatchToken: null,
      dispatchStartedAt: null,
      dispatchBotId: null,
      remoteMessageId: null,
    });

    await expect(
      service.assertCanExecute(
        createJob({ actionType: 'BAN_MEMBER', userId: 'user-1', text: undefined }),
      ),
    ).resolves.toBeUndefined();
  });

  it('preserves ordinary in-progress SEND_MESSAGE retry behavior before its dispatch fence exists', async () => {
    const { service } = createService({
      status: MaxActionLedgerStatus.IN_PROGRESS,
      ambiguous: false,
      terminal: false,
      attemptCount: 1,
      firstAttemptAt: new Date('2026-07-06T20:00:00.000Z'),
      lastAttemptAt: new Date('2026-07-06T20:00:00.000Z'),
      lastErrorCode: null,
      dispatchToken: null,
      dispatchStartedAt: null,
      dispatchBotId: null,
      remoteMessageId: null,
    });

    await expect(service.assertCanExecute(createJob())).resolves.toBeUndefined();
  });

  it('records enqueue metadata without storing message text', async () => {
    const { service, prisma } = createService();
    const bullMqEnqueuedAt = new Date('2026-07-06T20:00:01.000Z');
    const job = createJob({
      sourceTag: 'interactive',
      trafficClass: 'critical',
      actionHealthLane: 'background',
      autoDeleteDelayMs: 60_000,
      candidateBotIds: ['bot-1', 'bot-2'],
      attemptedBotIds: ['bot-1'],
      routing: {
        purpose: 'send_message',
        primaryBotId: 'bot-1',
        reason: 'primary_confirmed',
        routingVersion: 3,
        sendRouteHalfOpenProbe: 'publication_exact_verification',
      },
    });

    await service.recordEnqueuedIfAbsent(job, bullMqEnqueuedAt);

    expect(prisma.maxActionLedgerEntry.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          jobId: 'job-1',
          actionType: 'SEND_MESSAGE',
          chatId: 'chat-1',
          botId: 'bot-1',
          sourceTag: 'interactive',
          metadata: expect.objectContaining({
            hasText: true,
            textLength: 5,
            autoDeleteDelayMs: 60_000,
            candidateBotIds: ['bot-1', 'bot-2'],
            attemptedBotIds: ['bot-1'],
            routing: expect.objectContaining({
              purpose: 'send_message',
              routingVersion: 3,
              sendRouteHalfOpenProbe: 'publication_exact_verification',
            }),
          }),
        }),
      ],
      skipDuplicates: true,
    });
    expect(prisma.maxActionLedgerEntry.updateMany).not.toHaveBeenCalled();
    const create = prisma.maxActionLedgerEntry.createMany.mock.calls[0][0].data[0];
    expect(create).toEqual(
      expect.objectContaining({
        status: MaxActionLedgerStatus.ENQUEUED,
        ambiguous: false,
        terminal: false,
        enqueuedAt: bullMqEnqueuedAt,
      }),
    );
    expect(JSON.stringify(create.metadata)).not.toContain('hello');
  });

  it('persists send-side auto-delete provenance in ledger metadata', async () => {
    const { service, prisma } = createService();
    const sendAutoDelete = {
      version: MAX_SEND_AUTO_DELETE_MARKER_VERSION,
      sourceSendJobId: 'source-send-1',
      sourceSendCompletedAt: '2026-08-31T12:00:00.000Z',
      requestedDelayMs: 60_000,
      originBotId: 'bot-1',
    };

    await service.recordEnqueuedIfAbsent(
      createJob({
        actionType: 'DELETE_MESSAGE',
        text: undefined,
        messageId: 'mid-auto-delete-1',
        sendAutoDelete,
      }),
    );

    expect(prisma.maxActionLedgerEntry.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          actionType: 'DELETE_MESSAGE',
          messageId: 'mid-auto-delete-1',
          metadata: expect.objectContaining({ sendAutoDelete }),
        }),
      ],
      skipDuplicates: true,
    });
  });

  it('refuses to mark a send-side auto-delete succeeded without a confirmation receipt', async () => {
    const { service, prisma } = createService();
    const job = createJob({
      actionType: 'DELETE_MESSAGE',
      text: undefined,
      messageId: 'mid-auto-delete-unverified-1',
      sendAutoDelete: {
        version: MAX_SEND_AUTO_DELETE_MARKER_VERSION,
        sourceSendJobId: 'source-send-1',
        sourceSendCompletedAt: '2026-08-31T12:00:00.000Z',
        requestedDelayMs: 60_000,
        originBotId: 'bot-1',
      },
    });

    await expect(service.recordSucceeded(job)).rejects.toThrow(
      'Refusing to mark unverified send-side auto-delete',
    );
    expect(prisma.maxActionLedgerEntry.upsert).not.toHaveBeenCalled();
  });

  it('persists the documented DELETE success receipt when a marked auto-delete succeeds', async () => {
    const { service, prisma } = createService();
    const sendAutoDelete = {
      version: MAX_SEND_AUTO_DELETE_MARKER_VERSION,
      sourceSendJobId: 'source-send-1',
      sourceSendCompletedAt: '2026-08-31T12:00:00.000Z',
      requestedDelayMs: 60_000,
      originBotId: 'bot-1',
      confirmedAt: '2026-08-31T12:01:01.000Z',
      confirmationKind: MAX_SEND_AUTO_DELETE_CONFIRMATION_KINDS.DOCUMENTED_DELETE_SUCCESS,
    };

    await service.recordSucceeded(
      createJob({
        actionType: 'DELETE_MESSAGE',
        text: undefined,
        messageId: 'mid-auto-delete-verified-1',
        sendAutoDelete,
      }),
    );

    expect(prisma.maxActionLedgerEntry.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          status: MaxActionLedgerStatus.SUCCEEDED,
          metadata: expect.objectContaining({ sendAutoDelete }),
        }),
        update: expect.objectContaining({
          status: MaxActionLedgerStatus.SUCCEEDED,
          metadata: expect.objectContaining({ sendAutoDelete }),
        }),
      }),
    );
  });

  it('treats a concurrent ledger insert as an idempotent enqueue success', async () => {
    const { service, prisma } = createService();
    prisma.maxActionLedgerEntry.createMany.mockResolvedValueOnce({ count: 0 });

    await expect(service.recordEnqueuedIfAbsent(createJob())).resolves.toBeUndefined();

    expect(prisma.maxActionLedgerEntry.createMany).toHaveBeenCalledWith(
      expect.objectContaining({ skipDuplicates: true }),
    );
    expect(prisma.maxActionLedgerEntry.updateMany).toHaveBeenCalledWith({
      where: {
        jobId: 'job-1',
        status: { in: [MaxActionLedgerStatus.FAILED_RETRYABLE] },
        ambiguous: false,
        terminal: false,
        attemptCount: 0,
        firstAttemptAt: null,
        lastAttemptAt: null,
        dispatchToken: null,
        dispatchStartedAt: null,
        dispatchBotId: null,
        remoteMessageId: null,
        completedAt: null,
      },
      data: expect.objectContaining({
        status: MaxActionLedgerStatus.ENQUEUED,
        ambiguous: false,
        terminal: false,
      }),
    });
  });

  it('records enqueue failure only when the worker has not created the ledger row', async () => {
    const { service, prisma } = createService();
    const error = Object.assign(new Error('redis unavailable'), { code: 'ECONNRESET' });

    await service.recordEnqueueFailedIfAbsent(createJob(), error);

    expect(prisma.maxActionLedgerEntry.createMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: [
          expect.objectContaining({
            status: MaxActionLedgerStatus.FAILED_RETRYABLE,
            terminal: false,
            lastErrorCode: 'econnreset',
            lastError: 'redis unavailable',
          }),
        ],
      }),
    );
  });

  it('records a stable fallback code for a member action enqueue failure without a code', async () => {
    const { service, prisma } = createService();

    await service.recordEnqueueFailedIfAbsent(
      createJob({ actionType: 'BAN_MEMBER', userId: 'user-1', text: undefined }),
      new Error('queue connection ended while publishing a sensitive member action'),
    );

    expect(prisma.maxActionLedgerEntry.createMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: [
          expect.objectContaining({
            lastErrorCode: 'max_ban_member_failed',
            lastError: 'queue connection ended while publishing a sensitive member action',
          }),
        ],
      }),
    );
  });

  it('quarantines ambiguous SEND_MESSAGE queue ownership without overwriting worker state', async () => {
    const { service, prisma } = createService();

    await service.recordEnqueueAmbiguousIfAbsent(
      createJob(),
      new Error('queue ownership is unknown'),
    );

    expect(prisma.maxActionLedgerEntry.createMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: [
          expect.objectContaining({
            status: MaxActionLedgerStatus.AMBIGUOUS,
            ambiguous: true,
            terminal: true,
            lastErrorCode: 'queue.enqueue_ambiguous',
          }),
        ],
      }),
    );
  });

  it('quarantines an existing unattempted enqueue after BullMQ ownership becomes unknown', async () => {
    const { service, prisma } = createService();
    prisma.maxActionLedgerEntry.createMany.mockResolvedValueOnce({ count: 0 });

    await service.recordEnqueueAmbiguousIfAbsent(
      createJob(),
      new Error('queue ownership is unknown'),
    );

    expect(prisma.maxActionLedgerEntry.updateMany).toHaveBeenCalledWith({
      where: {
        jobId: 'job-1',
        status: {
          in: [MaxActionLedgerStatus.ENQUEUED, MaxActionLedgerStatus.FAILED_RETRYABLE],
        },
        ambiguous: false,
        terminal: false,
        attemptCount: 0,
        firstAttemptAt: null,
        lastAttemptAt: null,
        dispatchToken: null,
        dispatchStartedAt: null,
        dispatchBotId: null,
        remoteMessageId: null,
        completedAt: null,
      },
      data: expect.objectContaining({
        status: MaxActionLedgerStatus.AMBIGUOUS,
        ambiguous: true,
        terminal: true,
        lastErrorCode: 'queue.enqueue_ambiguous',
      }),
    });
  });

  it('finds execution evidence produced after an ambiguous queue add', async () => {
    const { service, prisma } = createService({ id: 'ledger-1' });
    const since = new Date('2026-07-16T12:00:00.000Z');

    await expect(service.hasExecutionEvidenceSince(' job-1 ', since)).resolves.toBe(true);

    expect(prisma.maxActionLedgerEntry.findFirst).toHaveBeenCalledWith({
      where: {
        jobId: 'job-1',
        OR: [
          { firstAttemptAt: { gte: since } },
          { lastAttemptAt: { gte: since } },
          { dispatchStartedAt: { gte: since } },
        ],
      },
      select: { id: true },
    });
  });

  it('increments attempts when recording worker start after a concurrent ledger insert', async () => {
    const { service, prisma } = createService();
    const job = createJob({ attempt: 3 });
    prisma.maxActionLedgerEntry.createMany.mockResolvedValueOnce({ count: 0 });

    await service.recordStarted(job);

    expect(prisma.maxActionLedgerEntry.createMany).toHaveBeenCalledWith(
      expect.objectContaining({ skipDuplicates: true }),
    );
    expect(prisma.maxActionLedgerEntry.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          jobId: 'job-1',
          dispatchToken: null,
          remoteMessageId: null,
        }),
        data: expect.objectContaining({
          attemptCount: {
            increment: 1,
          },
          status: MaxActionLedgerStatus.IN_PROGRESS,
        }),
      }),
    );
  });

  it.each([
    { scheduledFor: undefined, state: 'UNSCHEDULED', at: null },
    {
      scheduledFor: '2026-11-08T19:00:00.1Z',
      state: 'VALID',
      at: new Date('2026-11-08T19:00:00.100Z'),
    },
    { scheduledFor: '2026-02-30T19:00:00.000Z', state: 'INVALID', at: null },
    { scheduledFor: '2026-11-08T19:00:00+03:00', state: 'INVALID', at: null },
  ])(
    'records $state scalar schedule on both enqueue creation and prepared update',
    async ({ scheduledFor, state, at }) => {
      const { service, prisma } = createService();
      const job = createJob({ scheduledFor });
      await service.recordEnqueuedIfAbsent(job, new Date('2026-11-08T18:00:00.000Z'));
      expect(prisma.maxActionLedgerEntry.createMany.mock.calls[0]?.[0]?.data?.[0]).toEqual(
        expect.objectContaining({ scheduleClockState: state, scheduledForAt: at }),
      );
      await service.recordPrepared(job);
      expect(prisma.maxActionLedgerEntry.updateMany.mock.calls.at(-1)?.[0]?.data).toEqual(
        expect.objectContaining({ scheduleClockState: state, scheduledForAt: at }),
      );
    },
  );

  it('does not manufacture enqueue time from job creation while recording a schedule', async () => {
    const { service, prisma } = createService();
    prisma.maxActionLedgerEntry.updateMany.mockResolvedValueOnce({ count: 0 });
    await service.recordStarted(createJob({ scheduledFor: '2026-11-08T19:00:00.000Z' }));
    const created = prisma.maxActionLedgerEntry.createMany.mock.calls[0]?.[0]?.data?.[0];
    expect(created).toMatchObject({
      scheduleClockState: 'VALID',
      scheduledForAt: new Date('2026-11-08T19:00:00.000Z'),
    });
    expect(created).not.toHaveProperty('enqueuedAt');
  });

  it('keeps the BullMQ creation timestamp when a fast worker creates and starts the ledger first', async () => {
    const attemptedAt = new Date('2026-07-06T20:00:05.000Z');
    const bullMqEnqueuedAt = new Date('2026-07-06T20:00:01.000Z');
    jest.useFakeTimers().setSystemTime(attemptedAt);
    const { service, prisma } = createService();
    prisma.maxActionLedgerEntry.updateMany
      .mockResolvedValueOnce({ count: 0 })
      .mockResolvedValueOnce({ count: 1 });

    await service.recordStarted(createJob(), bullMqEnqueuedAt);

    const created = prisma.maxActionLedgerEntry.createMany.mock.calls[0]?.[0]?.data?.[0];
    expect(created).toEqual(
      expect.objectContaining({
        enqueuedAt: bullMqEnqueuedAt,
        firstAttemptAt: attemptedAt,
      }),
    );
    const startMutation = prisma.maxActionLedgerEntry.updateMany.mock.calls.at(-1)?.[0]?.data;
    expect(startMutation).toEqual(
      expect.objectContaining({
        enqueuedAt: bullMqEnqueuedAt,
        lastAttemptAt: attemptedAt,
      }),
    );
    expect(startMutation).not.toHaveProperty('firstAttemptAt');
    expect(startMutation.enqueuedAt.getTime()).toBeLessThanOrEqual(
      created.firstAttemptAt.getTime(),
    );
  });

  it.each([
    ['send', createJob({ attempt: 2 })],
    [
      'delete',
      createJob({
        actionType: 'DELETE_MESSAGE',
        messageId: 'message-1',
        text: undefined,
        attempt: 2,
      }),
    ],
  ] as const)('keeps firstAttemptAt immutable on a %s retry', async (_label, job) => {
    const retriedAt = new Date('2026-07-06T20:00:10.000Z');
    jest.useFakeTimers().setSystemTime(retriedAt);
    const { service, prisma } = createService();
    prisma.maxActionLedgerEntry.createMany.mockResolvedValue({ count: 0 });
    prisma.maxActionLedgerEntry.updateMany
      .mockResolvedValueOnce({ count: 0 })
      .mockResolvedValueOnce({ count: 1 });

    await service.recordStarted(job);

    const [firstAttemptClaim, retryClaim] = prisma.maxActionLedgerEntry.updateMany.mock.calls;
    expect(firstAttemptClaim?.[0]).toEqual(
      expect.objectContaining({
        where: expect.objectContaining({ firstAttemptAt: null }),
        data: expect.objectContaining({
          firstAttemptAt: retriedAt,
          lastAttemptAt: retriedAt,
        }),
      }),
    );
    expect(retryClaim?.[0]).toEqual(
      expect.objectContaining({
        where: expect.objectContaining({ firstAttemptAt: { not: null } }),
        data: expect.objectContaining({ lastAttemptAt: retriedAt }),
      }),
    );
    expect(retryClaim?.[0]?.data).not.toHaveProperty('firstAttemptAt');
  });

  it('persists the BullMQ creation timestamp when the worker wins the member-ledger insert race', async () => {
    const attemptedAt = new Date('2026-07-06T20:00:05.000Z');
    const bullMqEnqueuedAt = new Date('2026-07-06T20:00:01.000Z');
    jest.useFakeTimers().setSystemTime(attemptedAt);
    const { service, prisma } = createService();
    prisma.maxActionLedgerEntry.updateMany
      .mockResolvedValueOnce({ count: 0 })
      .mockResolvedValueOnce({ count: 0 });

    await service.recordStarted(
      createJob({ actionType: 'BAN_MEMBER', userId: 'user-1', text: undefined }),
      bullMqEnqueuedAt,
    );

    const created = prisma.maxActionLedgerEntry.createMany.mock.calls[0]?.[0]?.data?.[0];
    expect(created).toEqual(
      expect.objectContaining({
        status: MaxActionLedgerStatus.IN_PROGRESS,
        enqueuedAt: bullMqEnqueuedAt,
        firstAttemptAt: attemptedAt,
        lastAttemptAt: attemptedAt,
      }),
    );
    expect(created.enqueuedAt.getTime()).toBeLessThanOrEqual(created.firstAttemptAt.getTime());
  });

  it.each([
    ['stalled', MaxActionLedgerStatus.IN_PROGRESS, null],
    ['terminal', MaxActionLedgerStatus.FAILED_TERMINAL, null],
    ['post-dispatch retryable', MaxActionLedgerStatus.FAILED_RETRYABLE, 'server.failure'],
  ] as const)(
    'does not revive a %s member action when recording worker start loses the CAS race',
    async (_label, status, lastErrorCode) => {
      const retainedRow = {
        status,
        ambiguous: false,
        terminal: status === MaxActionLedgerStatus.FAILED_TERMINAL,
        attemptCount: 1,
        firstAttemptAt: new Date('2026-07-06T20:00:00.000Z'),
        lastAttemptAt: new Date('2026-07-06T20:00:00.000Z'),
        lastErrorCode,
        dispatchToken: null,
        dispatchStartedAt: null,
        dispatchBotId: null,
        remoteMessageId: null,
      };
      const { service, prisma } = createService(retainedRow);
      prisma.maxActionLedgerEntry.updateMany.mockResolvedValue({ count: 0 });
      prisma.maxActionLedgerEntry.createMany.mockResolvedValue({ count: 0 });

      await expect(
        service.recordStarted(
          createJob({
            actionType: 'KICK_MEMBER',
            userId: 'user-1',
            text: undefined,
          }),
        ),
      ).rejects.toBeInstanceOf(UnrecoverableError);

      expect(prisma.maxActionLedgerEntry.upsert).not.toHaveBeenCalled();
      expect(prisma.maxActionLedgerEntry.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            terminal: false,
            ambiguous: false,
            OR: [
              { status: MaxActionLedgerStatus.ENQUEUED },
              expect.objectContaining({
                status: MaxActionLedgerStatus.FAILED_RETRYABLE,
              }),
            ],
          }),
        }),
      );
    },
  );

  it('atomically claims a retry after a proven pre-dispatch member failure', async () => {
    const { service, prisma } = createService();
    const job = createJob({
      actionType: 'BAN_MEMBER',
      userId: 'user-1',
      text: undefined,
    });

    await service.recordStarted(job);

    expect(prisma.maxActionLedgerEntry.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          jobId: 'job-1',
          OR: [
            { status: MaxActionLedgerStatus.ENQUEUED },
            expect.objectContaining({
              status: MaxActionLedgerStatus.FAILED_RETRYABLE,
              OR: expect.arrayContaining([
                expect.objectContaining({
                  lastErrorCode: {
                    in: [
                      'max_api_circuit_open',
                      'max_api_internal_rate_limit',
                      'max_api_external_rate_limit',
                      'moderation_sanction_state_lock_lease_lost',
                      'moderation_sanction_state_lock_unavailable',
                      'max_member_pre_dispatch_guard_rejected',
                    ],
                  },
                }),
              ]),
            }),
          ],
        }),
      }),
    );
  });

  it('persists prepared domain context before the SEND dispatch fence is claimed', async () => {
    const { service, prisma } = createService();
    const job = createJob({
      ledgerContext: {
        managedBroadcast: {
          commentDialogReference: {
            entityType: 'channel',
            threadId: 'thread-1',
            includeCommentsButton: true,
          },
        },
      },
    });

    await service.recordPrepared(job);

    expect(prisma.maxActionLedgerEntry.updateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({
        jobId: 'job-1',
        dispatchToken: null,
        dispatchStartedAt: null,
        remoteMessageId: null,
        terminal: false,
      }),
      data: expect.objectContaining({
        metadata: expect.objectContaining({
          ledgerContext: job.ledgerContext,
        }),
      }),
    });
  });

  it.each([
    ['the ledger row is missing', null, MAX_SEND_LEDGER_PREPARATION_ERROR_CODES.MISSING_ROW, false],
    [
      'the ledger row is terminal',
      {
        status: MaxActionLedgerStatus.FAILED_TERMINAL,
        ambiguous: false,
        terminal: true,
        dispatchToken: null,
        dispatchStartedAt: null,
        dispatchBotId: null,
        remoteMessageId: null,
      },
      MAX_SEND_LEDGER_PREPARATION_ERROR_CODES.TERMINAL_OR_AMBIGUOUS,
      true,
    ],
    [
      'the ledger row is ambiguous',
      {
        status: MaxActionLedgerStatus.AMBIGUOUS,
        ambiguous: true,
        terminal: true,
        dispatchToken: null,
        dispatchStartedAt: null,
        dispatchBotId: null,
        remoteMessageId: null,
      },
      MAX_SEND_LEDGER_PREPARATION_ERROR_CODES.TERMINAL_OR_AMBIGUOUS,
      true,
    ],
    [
      'an existing dispatch fence is retained',
      {
        status: MaxActionLedgerStatus.IN_PROGRESS,
        ambiguous: false,
        terminal: false,
        dispatchToken: 'prior-token',
        dispatchStartedAt: new Date('2026-07-13T12:00:00.000Z'),
        dispatchBotId: 'bot-1',
        remoteMessageId: null,
      },
      MAX_SEND_LEDGER_PREPARATION_ERROR_CODES.DISPATCH_FENCE_EXISTS,
      true,
    ],
    [
      'the retained ledger state is otherwise unexpected',
      {
        status: MaxActionLedgerStatus.ENQUEUED,
        ambiguous: false,
        terminal: false,
        dispatchToken: null,
        dispatchStartedAt: null,
        dispatchBotId: null,
        remoteMessageId: null,
      },
      MAX_SEND_LEDGER_PREPARATION_ERROR_CODES.UNEXPECTED_STATE,
      false,
    ],
  ])(
    'fails closed with a classified error when %s',
    async (_description, row, code, preserveExistingLedger) => {
      const { service, prisma } = createService(row);
      prisma.maxActionLedgerEntry.updateMany.mockResolvedValueOnce({ count: 0 });

      const error = await service.recordPrepared(createJob()).catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(UnrecoverableError);
      expect(error).toMatchObject({ code });
      if (preserveExistingLedger) {
        expect(error).toMatchObject({ maxSendDispatchLedgerFinalized: true });
      } else {
        expect(error).not.toHaveProperty('maxSendDispatchLedgerFinalized');
      }
      expect(prisma.maxActionLedgerEntry.findUnique).toHaveBeenCalledWith({
        where: {
          jobId: 'job-1',
        },
        select: {
          status: true,
          ambiguous: true,
          terminal: true,
          dispatchToken: true,
          dispatchStartedAt: true,
          dispatchBotId: true,
          remoteMessageId: true,
          completedAt: true,
        },
      });
    },
  );

  it('recovers a completion that appears during duplicate start creation without rewriting it', async () => {
    const terminalMetadata = Object.freeze({
      ledgerContext: {
        suggestionId: 'suggestion-late-start',
        contextDigest: 'persisted-context-digest',
      },
    });
    const completedRow = {
      status: MaxActionLedgerStatus.SUCCEEDED,
      ambiguous: false,
      terminal: true,
      dispatchToken: 'completed-token',
      dispatchStartedAt: new Date('2026-08-21T10:00:00.000Z'),
      dispatchBotId: 'required-bot',
      remoteMessageId: 'mid-late-start',
      metadata: terminalMetadata,
    };
    const { service, prisma } = createService(null);
    prisma.maxActionLedgerEntry.createMany.mockImplementationOnce(async () => {
      prisma.maxActionLedgerEntry.findUnique.mockResolvedValue(completedRow);
      return { count: 0 };
    });
    prisma.maxActionLedgerEntry.updateMany.mockResolvedValue({ count: 0 });
    const competingContext = {
      suggestionId: 'suggestion-late-start',
      contextDigest: 'different-prepared-context-digest',
    };
    const job = createJob({
      routing: { purpose: 'send_message', requiredBotId: 'required-bot' },
      ledgerContext: competingContext,
    });

    await expect(service.recordStarted(job)).resolves.toBeUndefined();
    await expect(service.recordPrepared(job)).resolves.toBeUndefined();

    expect(prisma.maxActionLedgerEntry.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          jobId: 'job-1',
          metadata: expect.objectContaining({ ledgerContext: competingContext }),
        }),
      ],
      skipDuplicates: true,
    });
    expect(prisma.maxActionLedgerEntry.updateMany).toHaveBeenCalledTimes(3);
    expect(prisma.maxActionLedgerEntry.upsert).not.toHaveBeenCalled();
    expect(completedRow.metadata).toBe(terminalMetadata);
    expect(completedRow.metadata.ledgerContext).not.toEqual(competingContext);
  });

  it('does not overwrite a retained SEND_MESSAGE dispatch fence after preparation is blocked', async () => {
    const { service, prisma } = createService({
      status: MaxActionLedgerStatus.IN_PROGRESS,
      ambiguous: false,
      terminal: false,
      dispatchToken: 'prior-token',
      dispatchStartedAt: new Date('2026-07-13T12:00:00.000Z'),
      dispatchBotId: 'bot-1',
      remoteMessageId: null,
    });
    prisma.maxActionLedgerEntry.updateMany.mockResolvedValueOnce({ count: 0 });

    const error = await service.recordPrepared(createJob()).catch((caught: unknown) => caught);
    await service.recordFailed(createJob(), error);

    expect(prisma.maxActionLedgerEntry.createMany).not.toHaveBeenCalled();
    expect(prisma.maxActionLedgerEntry.updateMany).toHaveBeenCalledTimes(1);
  });

  it('claims the first SEND_MESSAGE dispatch with an atomic token fence', async () => {
    const { service, prisma } = createService();

    const claim = await service.claimSendDispatch(createJob(), 'bot-1');

    expect(claim).toEqual({
      kind: 'claimed',
      dispatchToken: expect.any(String),
    });
    expect(prisma.maxActionLedgerEntry.updateMany).toHaveBeenCalledWith({
      where: {
        jobId: 'job-1',
        dispatchToken: null,
        dispatchStartedAt: null,
        dispatchBotId: null,
        remoteMessageId: null,
        ambiguous: false,
        terminal: false,
      },
      data: {
        dispatchToken: expect.any(String),
        dispatchStartedAt: expect.any(Date),
        dispatchBotId: 'bot-1',
      },
    });
  });

  it('quarantines an unresolved prior SEND_MESSAGE dispatch instead of claiming again', async () => {
    const { service, prisma } = createService({
      status: MaxActionLedgerStatus.IN_PROGRESS,
      ambiguous: false,
      terminal: false,
      dispatchToken: 'prior-token',
      dispatchStartedAt: new Date('2026-07-11T09:00:00.000Z'),
      dispatchBotId: 'bot-1',
      remoteMessageId: null,
    });
    prisma.maxActionLedgerEntry.updateMany
      .mockResolvedValueOnce({ count: 0 })
      .mockResolvedValueOnce({ count: 1 });

    await expect(service.claimSendDispatch(createJob(), 'bot-2')).rejects.toMatchObject({
      name: 'UnrecoverableError',
      maxSendDispatchLedgerFinalized: true,
    });
    expect(prisma.maxActionLedgerEntry.updateMany).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        where: {
          jobId: 'job-1',
          dispatchToken: 'prior-token',
          remoteMessageId: null,
        },
        data: expect.objectContaining({
          status: MaxActionLedgerStatus.AMBIGUOUS,
          ambiguous: true,
          terminal: true,
        }),
      }),
    );
  });

  it('recovers a persisted remote message id without taking another dispatch claim', async () => {
    const { service, prisma } = createService({
      status: MaxActionLedgerStatus.SUCCEEDED,
      ambiguous: false,
      terminal: true,
      dispatchToken: 'completed-token',
      dispatchStartedAt: new Date('2026-07-11T09:00:00.000Z'),
      dispatchBotId: 'bot-1',
      remoteMessageId: 'mid-remote-1',
    });
    prisma.maxActionLedgerEntry.updateMany.mockResolvedValueOnce({ count: 0 });

    await expect(service.claimSendDispatch(createJob(), 'bot-2')).resolves.toEqual({
      kind: 'recovered',
      remoteMessageId: 'mid-remote-1',
      dispatchBotId: 'bot-1',
      completedAt: null,
    });
    expect(prisma.maxActionLedgerEntry.updateMany).toHaveBeenCalledTimes(1);
  });

  it.each([
    { label: 'a foreign bot', dispatchBotId: 'foreign-bot' },
    { label: 'no persisted bot', dispatchBotId: null },
  ])('rejects a recovered required-bot claim bound to $label', async ({ dispatchBotId }) => {
    const { service, prisma } = createService({
      status: MaxActionLedgerStatus.SUCCEEDED,
      ambiguous: false,
      terminal: true,
      dispatchToken: 'completed-token',
      dispatchStartedAt: new Date('2026-08-21T09:00:00.000Z'),
      dispatchBotId,
      remoteMessageId: 'mid-required-1',
    });
    prisma.maxActionLedgerEntry.updateMany.mockResolvedValueOnce({ count: 0 });
    const job = createJob({
      routing: { purpose: 'send_message', requiredBotId: 'required-bot' },
    });

    await expect(service.claimSendDispatch(job, 'required-bot')).rejects.toBeInstanceOf(
      UnrecoverableError,
    );
  });

  it('recovers a required-bot claim only with the exact persisted dispatch bot', async () => {
    const { service, prisma } = createService({
      status: MaxActionLedgerStatus.SUCCEEDED,
      ambiguous: false,
      terminal: true,
      dispatchToken: 'completed-token',
      dispatchStartedAt: new Date('2026-08-21T09:00:00.000Z'),
      dispatchBotId: 'required-bot',
      remoteMessageId: 'mid-required-1',
    });
    prisma.maxActionLedgerEntry.updateMany.mockResolvedValueOnce({ count: 0 });
    const job = createJob({
      routing: { purpose: 'send_message', requiredBotId: 'required-bot' },
    });

    await expect(service.claimSendDispatch(job, 'required-bot')).resolves.toEqual({
      kind: 'recovered',
      remoteMessageId: 'mid-required-1',
      dispatchBotId: 'required-bot',
      completedAt: null,
    });
  });

  it('recovers the bot that actually authored a completed survivor dispatch', async () => {
    const completedAt = new Date('2026-07-11T09:00:01.000Z');
    const { service } = createService({
      status: MaxActionLedgerStatus.SUCCEEDED,
      ambiguous: false,
      terminal: true,
      dispatchToken: 'completed-token',
      dispatchStartedAt: new Date('2026-07-11T09:00:00.000Z'),
      dispatchBotId: 'bot-2',
      remoteMessageId: 'mid-survivor-1',
      completedAt,
    });

    await expect(service.getCompletedSendDispatchResult(createJob())).resolves.toEqual({
      remoteMessageId: 'mid-survivor-1',
      dispatchBotId: 'bot-2',
      completedAt,
    });
  });

  it('proves a completed close notice only from its exact raw night-mode ledger row', async () => {
    const completedAt = new Date('2026-08-21T09:01:00.000Z');
    const { service, prisma } = createService({
      actionType: 'SEND_MESSAGE',
      chatId: 'chat-1',
      sourceTag: 'night_mode_transition',
      status: MaxActionLedgerStatus.SUCCEEDED,
      ambiguous: false,
      terminal: true,
      completedAt,
      dispatchBotId: 'bot-survivor',
      remoteMessageId: 'mid-night-close-1',
      metadata: {
        routing: { sendRouteHalfOpenProbe: 'publication_exact_verification' },
      },
    });

    await expect(
      service.getExactCompletedNightModeCloseNoticeDispatch({
        chatId: ' chat-1 ',
        sessionKey: ' session-1 ',
        messageId: ' mid-night-close-1 ',
        dispatchBotId: ' bot-survivor ',
      }),
    ).resolves.toEqual({
      jobId: 'night-mode:close:chat-1:session:session-1',
      remoteMessageId: 'mid-night-close-1',
      dispatchBotId: 'bot-survivor',
      completedAt,
      routeHalfOpenProbe: true,
      stickyRouteHalfOpenProbe: false,
    });
    expect(prisma.maxActionLedgerEntry.findUnique).toHaveBeenCalledWith({
      where: { jobId: 'night-mode:close:chat-1:session:session-1' },
      select: {
        actionType: true,
        chatId: true,
        sourceTag: true,
        status: true,
        ambiguous: true,
        terminal: true,
        completedAt: true,
        dispatchBotId: true,
        remoteMessageId: true,
        metadata: true,
      },
    });
  });

  it('reads opening recovery only from its own exact terminal successful receipt', async () => {
    const row = {
      actionType: 'SEND_MESSAGE',
      chatId: 'chat-1',
      sourceTag: 'night_mode_transition',
      status: MaxActionLedgerStatus.SUCCEEDED,
      ambiguous: false,
      terminal: true,
      completedAt: new Date('2026-05-31T05:00:01.000Z'),
      dispatchBotId: 'bot-1',
      remoteMessageId: 'open-message',
    };
    const { service, prisma } = createService(row);
    await expect(
      service.inspectCompletedNightModeOpenNoticeDispatch({
        chatId: 'chat-1',
        sessionKey: 'session-1',
      }),
    ).resolves.toMatchObject({
      kind: 'completed',
      jobId: 'night-mode:open:chat-1:session:session-1',
      remoteMessageId: 'open-message',
    });
    expect(prisma.maxActionLedgerEntry.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { jobId: 'night-mode:open:chat-1:session:session-1' },
      }),
    );
    for (const override of [
      { ambiguous: true },
      { sourceTag: 'foreign-source' },
      { terminal: false },
      { remoteMessageId: null },
    ]) {
      const unsafe = createService({ ...row, ...override }).service;
      await expect(
        unsafe.inspectCompletedNightModeOpenNoticeDispatch({
          chatId: 'chat-1',
          sessionKey: 'session-1',
        }),
      ).resolves.toMatchObject({ kind: 'mismatch' });
    }
  });

  it('preserves exact future-night sticky probe provenance in the close ledger proof', async () => {
    const completedAt = new Date('2026-08-21T20:00:01.000Z');
    const failureBefore = '2026-08-21T20:00:00.000Z';
    const { service } = createService({
      actionType: 'SEND_MESSAGE',
      chatId: 'chat-1',
      sourceTag: 'night_mode_transition',
      status: MaxActionLedgerStatus.SUCCEEDED,
      ambiguous: false,
      terminal: true,
      completedAt,
      dispatchBotId: 'bot-1',
      remoteMessageId: 'mid-night-sticky-1',
      metadata: {
        routing: {
          sendRouteHalfOpenProbe: 'publication_exact_verification',
          sendRouteStickyProbe: {
            kind: 'future_night_close_v1',
            authorizedAt: '2026-08-21T19:55:00.000Z',
            failureBefore,
            sessionKey: 'v1:Europe/Moscow:23:00:08:00:2026-08-21',
            scheduleFingerprint: FUTURE_NIGHT_SCHEDULE_FINGERPRINT,
          },
        },
      },
    });

    await expect(
      service.getExactCompletedNightModeCloseNoticeDispatch({
        chatId: 'chat-1',
        sessionKey: 'v1:Europe/Moscow:23:00:08:00:2026-08-21',
        messageId: 'mid-night-sticky-1',
        dispatchBotId: 'bot-1',
      }),
    ).resolves.toEqual({
      jobId: 'night-mode:close:chat-1:session:v1:Europe/Moscow:23:00:08:00:2026-08-21',
      remoteMessageId: 'mid-night-sticky-1',
      dispatchBotId: 'bot-1',
      completedAt,
      routeHalfOpenProbe: true,
      stickyRouteHalfOpenProbe: true,
    });
  });

  it.each([
    ['foreign action', { actionType: 'DELETE_MESSAGE' }],
    ['foreign chat', { chatId: 'chat-2' }],
    ['foreign source', { sourceTag: 'managed_broadcast' }],
    ['non-success status', { status: MaxActionLedgerStatus.IN_PROGRESS }],
    ['ambiguous outcome', { ambiguous: true }],
    ['non-terminal outcome', { terminal: false }],
    ['missing completion time', { completedAt: null }],
    ['foreign message', { remoteMessageId: 'mid-other' }],
    ['foreign dispatch bot', { dispatchBotId: 'bot-other' }],
  ])('rejects close-event recovery proof from a %s ledger row', async (_label, override) => {
    const { service } = createService({
      actionType: 'SEND_MESSAGE',
      chatId: 'chat-1',
      sourceTag: 'night_mode_transition',
      status: MaxActionLedgerStatus.SUCCEEDED,
      ambiguous: false,
      terminal: true,
      completedAt: new Date('2026-08-21T09:01:00.000Z'),
      dispatchBotId: 'bot-1',
      remoteMessageId: 'mid-night-close-1',
      ...override,
    });

    await expect(
      service.getExactCompletedNightModeCloseNoticeDispatch({
        chatId: 'chat-1',
        sessionKey: 'session-1',
        messageId: 'mid-night-close-1',
        dispatchBotId: 'bot-1',
      }),
    ).resolves.toBeNull();
  });

  it('distinguishes a missing close ledger row from an unsafe persisted row', async () => {
    const missing = createService(null).service;
    const unsafe = createService({
      actionType: 'SEND_MESSAGE',
      chatId: 'chat-1',
      sourceTag: 'night_mode_transition',
      status: MaxActionLedgerStatus.SUCCEEDED,
      ambiguous: false,
      terminal: true,
      completedAt: new Date('2026-08-21T09:01:00.000Z'),
      dispatchBotId: null,
      remoteMessageId: 'mid-night-close-1',
    }).service;

    await expect(
      missing.inspectCompletedNightModeCloseNoticeDispatch({
        chatId: 'chat-1',
        sessionKey: 'session-1',
      }),
    ).resolves.toEqual({
      kind: 'missing',
      jobId: 'night-mode:close:chat-1:session:session-1',
    });
    await expect(
      unsafe.inspectCompletedNightModeCloseNoticeDispatch({
        chatId: 'chat-1',
        sessionKey: 'session-1',
      }),
    ).resolves.toEqual({
      kind: 'mismatch',
      jobId: 'night-mode:close:chat-1:session:session-1',
    });
  });

  it.each([
    { label: 'a foreign bot', dispatchBotId: 'foreign-bot' },
    { label: 'no persisted bot', dispatchBotId: null },
  ])('rejects a completed required-bot read bound to $label', async ({ dispatchBotId }) => {
    const { service } = createService({
      status: MaxActionLedgerStatus.SUCCEEDED,
      ambiguous: false,
      terminal: true,
      dispatchToken: 'completed-token',
      dispatchStartedAt: new Date('2026-08-21T09:00:00.000Z'),
      dispatchBotId,
      remoteMessageId: 'mid-required-1',
    });

    await expect(
      service.getCompletedSendDispatchResult(
        createJob({
          routing: { purpose: 'send_message', requiredBotId: 'required-bot' },
        }),
      ),
    ).rejects.toBeInstanceOf(UnrecoverableError);
  });

  it('reads a completed required-bot send only from its exact persisted bot', async () => {
    const { service } = createService({
      status: MaxActionLedgerStatus.SUCCEEDED,
      ambiguous: false,
      terminal: true,
      dispatchToken: 'completed-token',
      dispatchStartedAt: new Date('2026-08-21T09:00:00.000Z'),
      dispatchBotId: 'required-bot',
      remoteMessageId: 'mid-required-1',
    });

    await expect(
      service.getCompletedSendDispatchResult(
        createJob({
          routing: { purpose: 'send_message', requiredBotId: 'required-bot' },
        }),
      ),
    ).resolves.toEqual({
      remoteMessageId: 'mid-required-1',
      dispatchBotId: 'required-bot',
      completedAt: null,
    });
  });

  it('persists the remote message id and terminal success using token CAS', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-08-31T12:00:00.000Z'));
    const { service, prisma } = createService();

    const completedAt = await service.completeSendDispatch(
      createJob(),
      'dispatch-token',
      'mid-remote-1',
    );

    expect(completedAt).toEqual(new Date('2026-08-31T12:00:00.000Z'));
    expect(prisma.maxActionLedgerEntry.updateMany).toHaveBeenCalledWith({
      where: {
        jobId: 'job-1',
        dispatchToken: 'dispatch-token',
        remoteMessageId: null,
      },
      data: expect.objectContaining({
        remoteMessageId: 'mid-remote-1',
        status: MaxActionLedgerStatus.SUCCEEDED,
        ambiguous: false,
        terminal: true,
        completedAt,
      }),
    });
  });

  it('does not overwrite a completed send timestamp during generic success bookkeeping', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-08-31T12:05:00.000Z'));
    const { service, prisma } = createService({
      status: MaxActionLedgerStatus.SUCCEEDED,
      ambiguous: false,
      terminal: true,
      dispatchToken: 'dispatch-token',
      dispatchStartedAt: new Date('2026-08-31T12:00:00.000Z'),
      dispatchBotId: 'bot-1',
      remoteMessageId: 'mid-remote-1',
      completedAt: new Date('2026-08-31T12:00:01.000Z'),
    });

    await service.recordSucceeded(createJob());

    expect(prisma.maxActionLedgerEntry.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          jobId: 'job-1',
          remoteMessageId: null,
        },
      }),
    );
    expect(prisma.maxActionLedgerEntry.upsert).not.toHaveBeenCalled();
  });

  it('recovers success when the completion write committed but its database acknowledgement was lost', async () => {
    const completedAt = new Date('2026-07-11T09:00:01.000Z');
    const { service, prisma } = createService({
      status: MaxActionLedgerStatus.SUCCEEDED,
      ambiguous: false,
      terminal: true,
      dispatchToken: 'dispatch-token',
      dispatchStartedAt: new Date('2026-07-11T09:00:00.000Z'),
      dispatchBotId: 'bot-1',
      remoteMessageId: 'mid-remote-1',
      completedAt,
    });
    prisma.maxActionLedgerEntry.updateMany.mockRejectedValueOnce(
      new Error('database response lost after commit'),
    );

    await expect(
      service.completeSendDispatch(createJob(), 'dispatch-token', 'mid-remote-1'),
    ).resolves.toEqual(completedAt);
  });

  it('releases only the matching unresolved dispatch token after a definitive rejection', async () => {
    const { service, prisma } = createService();

    await service.releaseSendDispatch(createJob(), 'dispatch-token');

    expect(prisma.maxActionLedgerEntry.updateMany).toHaveBeenCalledWith({
      where: {
        jobId: 'job-1',
        dispatchToken: 'dispatch-token',
        remoteMessageId: null,
      },
      data: expect.objectContaining({
        dispatchToken: null,
        dispatchStartedAt: null,
        dispatchBotId: null,
        status: MaxActionLedgerStatus.IN_PROGRESS,
        ambiguous: false,
        terminal: false,
      }),
    });
  });

  it('does not overwrite a SEND_MESSAGE outcome already finalized by the dispatch fence', async () => {
    const { service, prisma } = createService();
    const error = markMaxSendDispatchLedgerFinalized(
      new UnrecoverableError('Ambiguous MAX SEND_MESSAGE transport failure'),
    );

    await service.recordFailed(createJob(), error);

    expect(prisma.maxActionLedgerEntry.createMany).not.toHaveBeenCalled();
    expect(prisma.maxActionLedgerEntry.updateMany).not.toHaveBeenCalled();
  });

  it('keeps a persisted SEND_MESSAGE success monotonic when a later failure is recorded', async () => {
    const { service, prisma } = createService({
      status: MaxActionLedgerStatus.SUCCEEDED,
      ambiguous: false,
      terminal: true,
      remoteMessageId: 'mid-remote-1',
    });
    prisma.maxActionLedgerEntry.updateMany.mockResolvedValueOnce({ count: 0 });

    await service.recordFailed(
      createJob(),
      new UnrecoverableError('Ambiguous MAX SEND_MESSAGE transport failure'),
    );

    expect(prisma.maxActionLedgerEntry.createMany).toHaveBeenCalledWith(
      expect.objectContaining({ skipDuplicates: true }),
    );
    expect(prisma.maxActionLedgerEntry.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          jobId: 'job-1',
          remoteMessageId: null,
          ambiguous: false,
          terminal: false,
        }),
      }),
    );
  });

  it('keeps terminal queue ambiguity monotonic when a later SEND_MESSAGE failure is recorded', async () => {
    const { service, prisma } = createService({
      status: MaxActionLedgerStatus.AMBIGUOUS,
      ambiguous: true,
      terminal: true,
      remoteMessageId: null,
    });
    prisma.maxActionLedgerEntry.createMany.mockResolvedValueOnce({ count: 0 });
    prisma.maxActionLedgerEntry.updateMany.mockResolvedValueOnce({ count: 0 });

    await service.recordFailed(createJob(), new Error('later worker failure'));

    expect(prisma.maxActionLedgerEntry.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          jobId: 'job-1',
          remoteMessageId: null,
          ambiguous: false,
          terminal: false,
        }),
      }),
    );
  });

  it.each([
    'moderation_sanction_state_lock_lease_lost',
    'moderation_sanction_state_lock_unavailable',
    MAX_MEMBER_PRE_DISPATCH_GUARD_REJECTED_CODE,
  ])('persists the proven pre-dispatch member failure code %s', async (code) => {
    const { service, prisma } = createService();
    const error = Object.assign(new Error('sanction state guard rejected the dispatch'), { code });

    await service.recordFailed(
      createJob({ actionType: 'BAN_MEMBER', userId: 'user-1', text: undefined }),
      error,
    );

    expect(prisma.maxActionLedgerEntry.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({
          status: MaxActionLedgerStatus.FAILED_RETRYABLE,
          ambiguous: false,
          terminal: false,
          lastErrorCode: code,
        }),
      }),
    );
  });

  it.each([403, 404, 503])(
    'stores only stable no-send evidence after a certified proof lookup HTTP %s rejection',
    async (status) => {
      const job = createJob();
      const { service, prisma } = createService();
      const response = { status, data: { code: 'chat.not.found' } };
      const error = markMaxPreDispatchGuardRejected(
        Object.assign(new Error('executor proof lookup failed'), {
          code: 'max_action_executor_proof_rejected',
          response,
        }),
        MAX_SEND_PRE_DISPATCH_GUARD_REJECTED_CODE,
      );
      await service.recordFailed(job, error);
      const mutation = prisma.maxActionLedgerEntry.updateMany.mock.calls[0]![0].data;
      expect(mutation).toMatchObject({
        status: MaxActionLedgerStatus.FAILED_RETRYABLE,
        ambiguous: false,
        terminal: false,
        lastStatusCode: null,
        lastErrorCode: MAX_SEND_PRE_DISPATCH_GUARD_REJECTED_CODE,
      });
      expect(error).toMatchObject({ code: 'max_action_executor_proof_rejected', response });
      const retry = createService({
        ...mutation,
        attemptCount: 1,
        firstAttemptAt: new Date(),
        lastAttemptAt: new Date(),
        dispatchToken: null,
        dispatchStartedAt: null,
        dispatchBotId: null,
        remoteMessageId: null,
      });
      await expect(retry.service.assertCanExecute(job)).resolves.toBeUndefined();
    },
  );

  it.each([404, 503])(
    'keeps an attempted nested SEND HTTP %s failure outside no-send normalization',
    async (status) => {
      const { service, prisma } = createService();
      const error = markMaxPreDispatchGuardRejected(
        markMaxMessageSendAttempted(
          Object.assign(new Error('nested SEND failed'), {
            response: { status, data: { code: 'chat.not.found' } },
          }),
        ),
        MAX_SEND_PRE_DISPATCH_GUARD_REJECTED_CODE,
      );
      await service.recordFailed(createJob(), error);
      expect(prisma.maxActionLedgerEntry.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status:
              status === 503
                ? MaxActionLedgerStatus.AMBIGUOUS
                : MaxActionLedgerStatus.FAILED_TERMINAL,
            ambiguous: status === 503,
            terminal: true,
            lastStatusCode: status,
            lastErrorCode: 'chat.not.found',
          }),
        }),
      );
    },
  );

  it.each([403, 404, 503])(
    'allows a member retry after a final proof lookup rejects with HTTP %s before mutation',
    async (status) => {
      const job = createJob({ actionType: 'BAN_MEMBER', userId: 'user-1', text: undefined });
      const { service, prisma } = createService();
      const error = markMaxPreDispatchGuardRejected(
        Object.assign(new Error('executor proof lookup failed'), {
          code: 'max_action_executor_proof_rejected',
          response: { status, data: { code: 'chat.denied' } },
        }),
        MAX_MEMBER_PRE_DISPATCH_GUARD_REJECTED_CODE,
      );
      await service.recordFailed(job, error);
      const mutation = prisma.maxActionLedgerEntry.upsert.mock.calls[0]![0].update;
      expect(mutation).toMatchObject({
        status: MaxActionLedgerStatus.FAILED_RETRYABLE,
        ambiguous: false,
        terminal: false,
        lastStatusCode: status,
        lastErrorCode: MAX_MEMBER_PRE_DISPATCH_GUARD_REJECTED_CODE,
      });
      const retry = createService({
        ...mutation,
        attemptCount: 1,
        firstAttemptAt: new Date(),
        lastAttemptAt: new Date(),
        dispatchToken: null,
        dispatchStartedAt: null,
        dispatchBotId: null,
        remoteMessageId: null,
      });
      await expect(retry.service.assertCanExecute(job)).resolves.toBeUndefined();
    },
  );

  it('persists member HTTP 429 as a retryable external rate-limit rejection', async () => {
    const job = createJob({
      actionType: 'KICK_MEMBER',
      userId: 'user-1',
      text: undefined,
    });
    const { service, prisma } = createService();
    const error = markMaxMemberMutationAttempted({
      response: {
        status: 429,
        data: { code: 'too.many.requests', message: 'Too many requests' },
      },
    });

    await service.recordFailed(job, error);

    expect(prisma.maxActionLedgerEntry.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({
          status: MaxActionLedgerStatus.FAILED_RETRYABLE,
          ambiguous: false,
          terminal: false,
          completedAt: null,
          lastStatusCode: 429,
          lastErrorCode: 'max_api_external_rate_limit',
        }),
      }),
    );

    const { service: retryService } = createService({
      status: MaxActionLedgerStatus.FAILED_RETRYABLE,
      ambiguous: false,
      terminal: false,
      attemptCount: 1,
      firstAttemptAt: new Date('2026-07-06T20:00:00.000Z'),
      lastAttemptAt: new Date('2026-07-06T20:00:01.000Z'),
      lastStatusCode: 429,
      lastErrorCode: 'max_api_external_rate_limit',
      lastError: 'too many requests',
      dispatchToken: null,
      dispatchStartedAt: null,
      dispatchBotId: null,
      remoteMessageId: null,
    });
    await expect(retryService.assertCanExecute(job)).resolves.toBeUndefined();
  });

  it('quarantines an attempted member HTTP 5xx response as ambiguous', async () => {
    const job = createJob({
      actionType: 'BAN_MEMBER',
      userId: 'user-1',
      text: undefined,
    });
    const { service, prisma } = createService();
    const error = markMaxMemberMutationAttempted({
      response: {
        status: 503,
        data: { code: 'server.failure', message: 'Server failure' },
      },
    });

    await service.recordFailed(job, error);

    expect(prisma.maxActionLedgerEntry.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({
          status: MaxActionLedgerStatus.AMBIGUOUS,
          ambiguous: true,
          terminal: true,
          completedAt: expect.any(Date),
          lastStatusCode: 503,
          lastErrorCode: 'server.failure',
        }),
      }),
    );

    const { service: retryService } = createService({
      status: MaxActionLedgerStatus.AMBIGUOUS,
      ambiguous: true,
      terminal: true,
      attemptCount: 1,
      firstAttemptAt: new Date('2026-07-06T20:00:00.000Z'),
      lastAttemptAt: new Date('2026-07-06T20:00:01.000Z'),
      lastStatusCode: 503,
      lastErrorCode: 'server.failure',
      lastError: 'server failure',
      dispatchToken: null,
      dispatchStartedAt: null,
      dispatchBotId: null,
      remoteMessageId: null,
    });
    await expect(retryService.assertCanExecute(job)).rejects.toBeInstanceOf(UnrecoverableError);
  });

  it.each([
    {
      label: 'structured MAX code',
      actionType: 'BAN_MEMBER' as const,
      error: {
        response: {
          status: 403,
          data: { code: 'CHAT.DENIED', message: 'Forbidden' },
        },
      },
      expectedCode: 'chat.denied',
      expectedStatus: 403,
    },
    {
      label: 'known definitive MAX message',
      actionType: 'KICK_MEMBER' as const,
      error: {
        response: {
          status: 200,
          data: { message: 'User already deleted or bot has insufficient rights' },
        },
      },
      expectedCode: 'max_member_already_deleted_or_insufficient_rights',
      expectedStatus: 200,
    },
    {
      label: 'HTTP status',
      actionType: 'BAN_MEMBER' as const,
      error: {
        response: {
          status: 503,
          data: { message: 'Upstream transport details that must not become a code' },
        },
      },
      expectedCode: 'max_http_503',
      expectedStatus: 503,
    },
    {
      label: 'bounded action fallback',
      actionType: 'KICK_MEMBER' as const,
      error: new Error('Raw transport details that must not become a code'),
      expectedCode: 'max_kick_member_failed',
      expectedStatus: null,
    },
  ])(
    'persists a stable non-null member failure code from $label',
    async ({ actionType, error, expectedCode, expectedStatus }) => {
      const { service, prisma } = createService();

      await service.recordFailed(
        createJob({ actionType, userId: 'user-1', text: undefined }),
        error,
      );

      expect(prisma.maxActionLedgerEntry.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          update: expect.objectContaining({
            lastStatusCode: expectedStatus,
            lastErrorCode: expectedCode,
          }),
        }),
      );
      const persistedCode = prisma.maxActionLedgerEntry.upsert.mock.calls[0]?.[0]?.update
        ?.lastErrorCode as string;
      expect(persistedCode).toBe(expectedCode);
      expect(persistedCode).not.toMatch(/\s/u);
      expect(persistedCode.length).toBeLessThanOrEqual(128);
    },
  );

  it('classifies ambiguous and retryable failures', async () => {
    const { service, prisma } = createService();

    await service.recordFailed(
      createJob({ idempotencyKey: 'job-ambiguous' }),
      new UnrecoverableError('Ambiguous MAX SEND_MESSAGE transport failure for chat chat-1'),
    );
    await service.recordFailed(createJob({ idempotencyKey: 'job-retryable' }), {
      response: {
        status: 500,
        data: {
          code: 'server.failure',
          message: 'server failure',
        },
      },
    });
    await service.recordFailed(
      createJob({ idempotencyKey: 'job-retryable-exhausted' }),
      {
        response: {
          status: 500,
          data: {
            code: 'server.failure',
            message: 'server failure',
          },
        },
      },
      { exhausted: true },
    );

    expect(prisma.maxActionLedgerEntry.createMany).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        data: [
          expect.objectContaining({
            status: MaxActionLedgerStatus.AMBIGUOUS,
            ambiguous: true,
            terminal: true,
          }),
        ],
      }),
    );
    expect(prisma.maxActionLedgerEntry.createMany).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        data: [
          expect.objectContaining({
            status: MaxActionLedgerStatus.FAILED_RETRYABLE,
            ambiguous: false,
            terminal: false,
            lastStatusCode: 500,
            lastErrorCode: 'server.failure',
          }),
        ],
      }),
    );
    expect(prisma.maxActionLedgerEntry.createMany).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        data: [
          expect.objectContaining({
            status: MaxActionLedgerStatus.FAILED_RETRYABLE,
            ambiguous: false,
            terminal: true,
            lastStatusCode: 500,
            lastErrorCode: 'server.failure',
            completedAt: expect.any(Date),
          }),
        ],
      }),
    );
  });

  it.each([
    {
      label: 'access-masked 404',
      cause: {
        response: {
          status: 404,
          data: { code: 'message.not.found', message: 'Message mid-private-1 not found' },
        },
      },
      expectedStatus: null,
      expectedCode: 'send_auto_delete_exact_verification_access_ambiguous',
      expectedMessage:
        'Send-side auto-delete exact presence verification failed (access_ambiguous)',
    },
    {
      label: 'upstream 502',
      cause: {
        response: {
          status: 502,
          data: { code: 'server.failure', message: 'Upstream unavailable' },
        },
      },
      expectedStatus: null,
      expectedCode: 'send_auto_delete_exact_verification_upstream_5xx',
      expectedMessage: 'Send-side auto-delete exact presence verification failed (upstream_5xx)',
    },
    {
      label: 'connection reset',
      cause: Object.assign(new Error('socket failed for private-message-1'), {
        code: 'ECONNRESET',
      }),
      expectedStatus: null,
      expectedCode: 'send_auto_delete_exact_verification_transport',
      expectedMessage: 'Send-side auto-delete exact presence verification failed (transport)',
    },
  ])(
    'persists privacy-safe send-side auto-delete diagnostics for $label without changing retryability',
    async ({ cause, expectedStatus, expectedCode, expectedMessage }) => {
      const { service, prisma } = createService();
      const job = createJob({
        actionType: 'DELETE_MESSAGE',
        text: undefined,
        messageId: 'mid-private-1',
        sendAutoDelete: {
          version: MAX_SEND_AUTO_DELETE_MARKER_VERSION,
          sourceSendJobId: 'send-private-1',
          sourceSendCompletedAt: '2026-09-02T01:00:00.000Z',
          requestedDelayMs: 60_000,
          originBotId: 'bot-1',
        },
      });

      await service.recordFailed(job, createMaxSendAutoDeleteVerificationError(cause));

      expect(prisma.maxActionLedgerEntry.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          update: expect.objectContaining({
            status: MaxActionLedgerStatus.FAILED_RETRYABLE,
            ambiguous: false,
            terminal: false,
            completedAt: null,
            lastStatusCode: expectedStatus,
            lastErrorCode: expectedCode,
            lastError: expectedMessage,
          }),
        }),
      );
      const persisted = prisma.maxActionLedgerEntry.upsert.mock.calls[0]?.[0]?.update;
      expect(
        JSON.stringify({
          lastStatusCode: persisted?.lastStatusCode,
          lastErrorCode: persisted?.lastErrorCode,
          lastError: persisted?.lastError,
        }),
      ).not.toMatch(/mid-private-1|send-private-1|private-message-1|upstream unavailable/iu);
    },
  );

  it('terminalizes an exhausted access-ambiguous auto-delete verification as repairable', async () => {
    const { service, prisma } = createService();
    const job = createJob({
      actionType: 'DELETE_MESSAGE',
      text: undefined,
      messageId: 'mid-private-exhausted',
      sendAutoDelete: {
        version: MAX_SEND_AUTO_DELETE_MARKER_VERSION,
        sourceSendJobId: 'send-private-exhausted',
        sourceSendCompletedAt: '2026-09-03T08:00:00.000Z',
        requestedDelayMs: 60_000,
        originBotId: 'bot-1',
      },
    });
    const verificationError = createMaxSendAutoDeleteVerificationError({
      response: {
        status: 404,
        data: { code: 'message.not.found', message: 'Message unavailable' },
      },
    });

    await service.recordFailed(job, verificationError, { exhausted: true });

    expect(prisma.maxActionLedgerEntry.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({
          status: MaxActionLedgerStatus.FAILED_RETRYABLE,
          ambiguous: false,
          terminal: true,
          completedAt: expect.any(Date),
          lastStatusCode: null,
          lastErrorCode: 'send_auto_delete_exact_verification_access_ambiguous',
          lastError: 'Send-side auto-delete exact presence verification failed (access_ambiguous)',
        }),
      }),
    );
  });

  it('terminally classifies deterministic local payload and definitive member failures', async () => {
    const { service, prisma } = createService();

    await service.recordFailed(
      createJob({ idempotencyKey: 'job-upload' }),
      new Error('MAX upload payload is missing'),
    );
    await service.recordFailed(
      createJob({
        idempotencyKey: 'job-member-absent',
        actionType: 'KICK_MEMBER',
        userId: 'user-1',
        text: undefined,
      }),
      {
        response: {
          status: 200,
          data: {
            message: 'User already deleted or bot has insufficient rights',
          },
        },
      },
    );
    await service.recordFailed(
      createJob({
        idempotencyKey: 'job-chat-missing',
        actionType: 'BAN_MEMBER',
        userId: 'user-1',
        text: undefined,
      }),
      {
        response: {
          status: 404,
          data: {
            code: 'chat.not.found',
            message: 'Chat not found',
          },
        },
      },
    );

    for (const call of prisma.maxActionLedgerEntry.createMany.mock.calls.slice(-3)) {
      expect(call[0]).toEqual(
        expect.objectContaining({
          data: [
            expect.objectContaining({
              status: MaxActionLedgerStatus.FAILED_TERMINAL,
              ambiguous: false,
              terminal: true,
              completedAt: expect.any(Date),
            }),
          ],
        }),
      );
    }
  });

  it('terminally classifies deterministic media validation failures', async () => {
    const { service, prisma } = createService();
    const error = new MaxMediaUploadValidationError(
      MAX_MEDIA_UPLOAD_VALIDATION_ERROR_CODES.INVALID_PAYLOAD,
      'image',
    );

    await service.recordFailed(createJob({ idempotencyKey: 'job-invalid-media' }), error);

    expect(prisma.maxActionLedgerEntry.createMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: [
          expect.objectContaining({
            status: MaxActionLedgerStatus.FAILED_TERMINAL,
            ambiguous: false,
            terminal: true,
            completedAt: expect.any(Date),
            lastErrorCode: 'max_media_upload_invalid_payload',
          }),
        ],
      }),
    );
  });

  it('does not treat an affirmative rights message as a terminal member failure', async () => {
    const { service, prisma } = createService();

    await service.recordFailed(
      createJob({
        actionType: 'KICK_MEMBER',
        userId: 'user-1',
        text: undefined,
      }),
      {
        response: {
          status: 200,
          data: { message: 'Bot has sufficient rights' },
        },
      },
    );

    expect(prisma.maxActionLedgerEntry.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({
          status: MaxActionLedgerStatus.FAILED_RETRYABLE,
          ambiguous: false,
          terminal: false,
          completedAt: null,
          lastErrorCode: 'max_http_200',
        }),
      }),
    );
  });
});

describe('negative night-mode member aliases', () => {
  it.each(['close', 'open'] as const)(
    'blocks an existing %s member identity without moving its receipt',
    async (transition) => {
      const { service, prisma } = createService({ id: 'prior-member' });
      const sessionKey = 'v1:Europe/Berlin:03:00:02:30:2026-03-28';
      await expect(
        service.hasNightModeAliasSendProvenance({ chatId: 'chat-1', transition, sessionKey }),
      ).resolves.toBe(true);
      expect(prisma.maxActionLedgerEntry.findFirst).toHaveBeenCalledWith({
        where: {
          jobId: {
            in: [`night-mode:${transition}:chat-1:session:v1:Europe/Berlin:03:00:02:30:2026-03-29`],
          },
        },
        select: { id: true },
      });
      expect(prisma.maxActionLedgerEntry.updateMany).not.toHaveBeenCalled();
      expect(prisma.maxActionLedgerEntry.upsert).not.toHaveBeenCalled();
    },
  );
  it('adds no alias lookup to an ordinary session', async () => {
    const { service, prisma } = createService();
    await expect(
      service.hasNightModeAliasSendProvenance({
        chatId: 'chat-1',
        transition: 'open',
        sessionKey: 'v1:Europe/Moscow:23:00:08:00:2026-10-29',
      }),
    ).resolves.toBe(false);
    expect(prisma.maxActionLedgerEntry.findFirst).not.toHaveBeenCalled();
  });
});
