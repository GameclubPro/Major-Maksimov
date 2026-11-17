import { MaxActionLedgerStatus, type MaxActionLedgerEntry } from '../prisma/prisma-client';
import { MAX_MEMBER_PRE_DISPATCH_GUARD_REJECTED_CODE } from '../max/max-action-pre-dispatch-guard';
import {
  buildMaxActionChannelSuggestionPublicationJobId,
  MAX_ACTION_CHANNEL_SUGGESTION_PUBLICATION_SOURCE_TAG,
} from '../max/max-action-ledger-keys';
import { MaxActionLedgerWatchdogService } from './max-action-ledger-watchdog.service';

function createCandidate(overrides: Partial<MaxActionLedgerEntry> = {}) {
  return {
    id: 'ledger-1',
    jobId: 'job-1',
    chatId: 'chat-1',
    actionType: 'SEND_MESSAGE',
    status: MaxActionLedgerStatus.ENQUEUED,
    ambiguous: false,
    terminal: false,
    attemptCount: 0,
    firstAttemptAt: null,
    lastAttemptAt: null,
    dispatchToken: null,
    dispatchStartedAt: null,
    dispatchBotId: null,
    remoteMessageId: null,
    botId: 'bot-1',
    messageId: null,
    userId: null,
    sourceTag: 'moderation',
    trafficClass: 'critical',
    actionHealthLane: 'critical',
    lastStatusCode: null,
    lastErrorCode: null,
    lastError: null,
    metadata: {
      createdAt: new Date(Date.now() - 12 * 60_000).toISOString(),
      candidateBotIds: ['bot-1', 'bot-2'],
      attemptedBotIds: ['bot-1'],
      routing: {
        purpose: 'moderation_action',
        primaryBotId: 'bot-1',
        action: 'moderate_member',
        routingVersion: 2,
      },
      ledgerContext: { source: 'participant_cleanup' },
      ignoreFailureMetricStatuses: [403, 404],
    },
    createdAt: new Date(Date.now() - 12 * 60_000),
    updatedAt: new Date(Date.now() - 10 * 60_000),
    ...overrides,
  };
}

function createHarness(
  options: {
    rows?: ReturnType<typeof createCandidate>[];
    job?: unknown;
    criticalJob?: unknown;
    interactiveJob?: unknown;
    backgroundJob?: unknown;
    lockToken?: string | null;
    mode?: 'default' | 'off' | 'shadow' | 'canary' | 'on';
    canaryPercent?: number;
    canaryEntityIds?: string;
    findMany?: jest.Mock;
    updateCount?: number;
    addError?: Error;
    persistedCursor?: { id: string; updatedAt: Date } | null;
  } = {},
) {
  const rows = options.rows ?? [];
  const prisma = {
    maxActionLedgerEntry: {
      findMany: options.findMany ?? jest.fn().mockResolvedValueOnce(rows).mockResolvedValueOnce([]),
      updateMany: jest.fn().mockResolvedValue({ count: options.updateCount ?? 1 }),
    },
  };
  const redis = {
    acquireLock: jest
      .fn()
      .mockResolvedValue(options.lockToken === undefined ? 'lock-1' : options.lockToken),
    renewLock: jest.fn().mockResolvedValue(true),
    releaseLock: jest.fn().mockResolvedValue(undefined),
    getString: jest.fn().mockImplementation(async (key: string) => {
      if (key.endsWith(':cursor:v1') && options.persistedCursor) {
        return JSON.stringify({
          id: options.persistedCursor.id,
          updatedAt: options.persistedCursor.updatedAt.toISOString(),
        });
      }
      return null;
    }),
    setStringWithTtl: jest.fn().mockResolvedValue(undefined),
  };
  const queue = {
    getJob: jest.fn().mockResolvedValue(options.job ?? null),
    add: jest.fn().mockResolvedValue({ remove: jest.fn().mockResolvedValue(undefined) }),
  };
  const criticalQueue = {
    getJob: jest.fn().mockResolvedValue(options.criticalJob ?? null),
    add: options.addError
      ? jest.fn().mockRejectedValue(options.addError)
      : jest.fn().mockResolvedValue({ remove: jest.fn().mockResolvedValue(undefined) }),
  };
  const interactiveQueue = {
    getJob: jest.fn().mockResolvedValue(options.interactiveJob ?? null),
    add: jest.fn().mockResolvedValue({ remove: jest.fn().mockResolvedValue(undefined) }),
  };
  const backgroundQueue = {
    getJob: jest.fn().mockResolvedValue(options.backgroundJob ?? null),
    add: jest.fn().mockResolvedValue({ remove: jest.fn().mockResolvedValue(undefined) }),
  };
  const config = {
    get: jest.fn((key: string) => {
      if (key === 'MAX_ACTION_LEDGER_WATCHDOG_MODE') {
        return options.mode === 'default' ? undefined : (options.mode ?? 'on');
      }
      if (key === 'MAX_ACTION_LEDGER_WATCHDOG_CANARY_PERCENT') {
        return options.canaryPercent ?? 1;
      }
      if (key === 'MAX_ACTION_LEDGER_WATCHDOG_CANARY_ENTITY_IDS') {
        return options.canaryEntityIds ?? '';
      }
      return undefined;
    }),
  };
  return {
    prisma,
    redis,
    queue,
    criticalQueue,
    interactiveQueue,
    backgroundQueue,
    service: new MaxActionLedgerWatchdogService(
      prisma as never,
      redis as never,
      queue as never,
      criticalQueue as never,
      interactiveQueue as never,
      backgroundQueue as never,
      config as never,
    ),
  };
}

describe('MaxActionLedgerWatchdogService', () => {
  const previousRole = process.env.APP_ROLE;

  beforeEach(() => {
    process.env.APP_ROLE = 'action';
  });

  afterAll(() => {
    if (previousRole === undefined) {
      delete process.env.APP_ROLE;
    } else {
      process.env.APP_ROLE = previousRole;
    }
  });

  it('terminally fails a proven pre-dispatch orphan without recreating a job', async () => {
    const row = createCandidate();
    const { service, prisma, queue } = createHarness({ rows: [row] });

    await service.runNow();

    expect(queue.getJob).toHaveBeenCalledWith('job-1');
    expect(prisma.maxActionLedgerEntry.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'ledger-1',
        status: MaxActionLedgerStatus.ENQUEUED,
        terminal: false,
        updatedAt: row.updatedAt,
      },
      data: expect.objectContaining({
        status: MaxActionLedgerStatus.FAILED_TERMINAL,
        ambiguous: false,
        terminal: true,
        lastErrorCode: 'ledger.watchdog.pre_dispatch_orphan',
      }),
    });
    expect(queue.add).not.toHaveBeenCalled();

    const snapshot = await service.getSnapshot();
    expect(snapshot).toEqual(
      expect.objectContaining({
        staleCount: 1,
        staleEnqueuedCount: 1,
        staleInProgressCount: 0,
        lastReconciledCount: 1,
        lastTerminalFailedCount: 1,
        lastQuarantinedCount: 0,
        lastError: null,
      }),
    );
  });

  it.each(['max_api_internal_rate_limit', 'max_api_circuit_open'] as const)(
    'scans retryable rows and requeues a recent proven %s orphan in the critical lane',
    async (lastErrorCode) => {
      const row = createCandidate({
        actionType: 'KICK_MEMBER',
        status: MaxActionLedgerStatus.FAILED_RETRYABLE,
        userId: 'user-1',
        attemptCount: 1,
        firstAttemptAt: new Date(Date.now() - 11 * 60_000),
        lastAttemptAt: new Date(Date.now() - 10 * 60_000),
        lastErrorCode,
        lastError: 'local MAX pre-dispatch guard rejected the request',
      });
      const { service, prisma, criticalQueue } = createHarness({ rows: [row] });

      await service.runNow();

      expect(prisma.maxActionLedgerEntry.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            status: {
              in: [
                MaxActionLedgerStatus.ENQUEUED,
                MaxActionLedgerStatus.IN_PROGRESS,
                MaxActionLedgerStatus.FAILED_RETRYABLE,
              ],
            },
          }),
        }),
      );
      expect(criticalQueue.add).toHaveBeenCalledWith(
        'execute-max-action',
        expect.objectContaining({
          actionType: 'KICK_MEMBER',
          chatId: 'chat-1',
          userId: 'user-1',
          botId: 'bot-1',
          candidateBotIds: ['bot-1', 'bot-2'],
          idempotencyKey: 'job-1',
        }),
        expect.objectContaining({
          jobId: 'job-1',
          attempts: 5,
          removeOnComplete: true,
          backoff: { type: 'exponential', delay: 1_000 },
        }),
      );
      expect(prisma.maxActionLedgerEntry.updateMany).toHaveBeenCalledWith({
        where: {
          id: 'ledger-1',
          status: MaxActionLedgerStatus.FAILED_RETRYABLE,
          terminal: false,
          updatedAt: row.updatedAt,
        },
        data: expect.objectContaining({
          status: MaxActionLedgerStatus.ENQUEUED,
          terminal: false,
          enqueuedAt: expect.any(Date),
          lastErrorCode: null,
        }),
      });
      expect(await service.getSnapshot()).toEqual(
        expect.objectContaining({
          staleCount: 1,
          staleRetryableCount: 1,
          lastRequeuedCount: 1,
          lastReconciledCount: 1,
          lastRetryOrphanTerminalizedCount: 0,
        }),
      );
    },
  );

  describe('retained final member guard refusal', () => {
    function guardCandidate(overrides: Parameters<typeof createCandidate>[0] = {}) {
      return createCandidate({
        actionType: 'BAN_MEMBER',
        status: MaxActionLedgerStatus.FAILED_RETRYABLE,
        userId: 'user-1',
        attemptCount: 1,
        firstAttemptAt: new Date(Date.now() - 11 * 60_000),
        lastAttemptAt: new Date(Date.now() - 10 * 60_000),
        lastErrorCode: MAX_MEMBER_PRE_DISPATCH_GUARD_REJECTED_CODE,
        ...overrides,
      });
    }

    function failedJob(row: ReturnType<typeof guardCandidate>) {
      return {
        id: row.jobId,
        data: {
          actionType: row.actionType,
          chatId: row.chatId,
          userId: row.userId,
          botId: row.botId,
          idempotencyKey: row.jobId,
        },
        getState: jest.fn().mockResolvedValue('failed'),
        retry: jest.fn().mockResolvedValue(undefined),
        processedOn: Date.now() - 10 * 60_000,
        attemptsMade: 1,
      };
    }

    const cases = (['BAN_MEMBER', 'KICK_MEMBER'] as const).flatMap((actionType) =>
      ([null, 404] as const).flatMap((lastStatusCode) =>
        (['on', 'shadow', 'canary-selected', 'canary-unselected'] as const).flatMap((mode) =>
          (['missing', 'failed'] as const).map((jobState) => ({
            actionType,
            lastStatusCode,
            mode,
            jobState,
          })),
        ),
      ),
    );

    it.each(cases)(
      'defers $actionType/$lastStatusCode/$mode/$jobState without changing the row or queue',
      async ({ actionType, lastStatusCode, mode, jobState }) => {
        const row = guardCandidate({ actionType, lastStatusCode });
        const retained = failedJob(row);
        const h = createHarness({
          rows: [row],
          mode: mode.startsWith('canary') ? 'canary' : mode === 'on' ? 'on' : 'shadow',
          canaryPercent: 100,
          canaryEntityIds: mode === 'canary-selected' ? row.chatId : '',
          criticalJob: jobState === 'failed' ? retained : undefined,
        });

        await h.service.runNow();

        expect(h.prisma.maxActionLedgerEntry.findMany).toHaveBeenCalledWith(
          expect.objectContaining({
            select: expect.objectContaining({ ambiguous: true, terminal: true }),
          }),
        );
        expect(h.prisma.maxActionLedgerEntry.updateMany).not.toHaveBeenCalled();
        for (const queue of [h.queue, h.criticalQueue, h.interactiveQueue, h.backgroundQueue]) {
          expect(queue.add).not.toHaveBeenCalled();
        }
        expect(retained.retry).not.toHaveBeenCalled();
        expect(await h.service.getSnapshot()).toEqual(
          expect.objectContaining({
            lastError: null,
            lastDeferredCount: 1,
            lastDeferredByReason: expect.objectContaining({
              memberGuardRejected: { count: 1, oldestAgeSec: expect.any(Number) },
            }),
            lastReconciledCount: 0,
            lastQuarantinedCount: 0,
            lastTerminalFailedCount: 0,
            lastRequeuedCount: 0,
            lastWouldQuarantineCount: 0,
            lastWouldTerminalFailCount: 0,
            lastWouldRequeueCount: 0,
          }),
        );
      },
    );

    it.each([
      { ambiguous: true },
      { terminal: true },
      { actionType: 'TRY_UNBAN_MEMBER' },
      { actionType: 'UNBAN_MEMBER' },
      { status: MaxActionLedgerStatus.IN_PROGRESS },
      { status: MaxActionLedgerStatus.ENQUEUED },
      { botId: null },
      { botId: ' ' },
      { userId: null },
      { userId: ' ' },
      { chatId: ' ' },
      { jobId: ' ' },
      { dispatchToken: 'dispatch' },
      { dispatchToken: '' },
      { dispatchStartedAt: new Date(1) },
      { dispatchBotId: 'bot-1' },
      { dispatchBotId: '' },
      { remoteMessageId: 'receipt' },
      { remoteMessageId: '' },
      { lastErrorCode: 'other_guard' },
    ] satisfies Parameters<typeof createCandidate>[0][])(
      'keeps contradictory candidate %j on its existing fenced path',
      async (overrides) => {
        const h = createHarness({ rows: [guardCandidate(overrides)] });
        await h.service.runNow();
        const snapshot = await h.service.getSnapshot();
        expect(snapshot.lastDeferredCount).toBe(0);
        expect(snapshot.lastRequeuedCount).toBe(0);
        expect(h.criticalQueue.add).not.toHaveBeenCalled();
      },
    );

    it.each(['actionType', 'chatId', 'userId', 'botId', 'idempotencyKey'] as const)(
      'refuses a failed job with a different %s',
      async (field) => {
        const row = guardCandidate();
        const job = failedJob(row);
        job.data[field] = 'different';
        const h = createHarness({ rows: [row], criticalJob: job });
        await h.service.runNow();
        expect((await h.service.getSnapshot()).lastDeferredCount).toBe(0);
        expect(job.retry).not.toHaveBeenCalled();
        expect(h.criticalQueue.add).not.toHaveBeenCalled();
      },
    );

    it('refuses conflicting job identity and multiple retained owners', async () => {
      const row = guardCandidate();
      const wrongId = failedJob(row);
      wrongId.id = 'different';
      const one = createHarness({ rows: [row], criticalJob: wrongId });
      await one.service.runNow();
      expect((await one.service.getSnapshot()).lastDeferredCount).toBe(0);
      const two = createHarness({ rows: [row], criticalJob: failedJob(row), job: failedJob(row) });
      await two.service.runNow();
      expect((await two.service.getSnapshot()).lastDeferredCount).toBe(0);
      expect(two.criticalQueue.add).not.toHaveBeenCalled();
      expect(two.queue.add).not.toHaveBeenCalled();
    });

    it.each(['waiting', 'delayed', 'active', 'completed'] as const)(
      'preserves existing %s job handling ahead of the new classification',
      async (state) => {
        const row = guardCandidate();
        const job = failedJob(row);
        job.getState.mockResolvedValue(state);
        job.processedOn = Date.now();
        const h = createHarness({ rows: [row], criticalJob: job });
        await h.service.runNow();
        const snapshot = await h.service.getSnapshot();
        expect(job.retry).not.toHaveBeenCalled();
        expect(h.criticalQueue.add).not.toHaveBeenCalled();
        if (state === 'completed') {
          expect(snapshot.lastRecoveredSucceededCount).toBe(1);
          expect(snapshot.lastDeferredCount).toBe(0);
          expect(h.prisma.maxActionLedgerEntry.updateMany).toHaveBeenCalledWith(
            expect.objectContaining({
              data: expect.objectContaining({ status: MaxActionLedgerStatus.SUCCEEDED }),
            }),
          );
        } else {
          expect(snapshot.lastDeferredCount).toBe(1);
          expect(h.prisma.maxActionLedgerEntry.updateMany).not.toHaveBeenCalled();
        }
      },
    );
  });

  it('retries one matching retained failed BullMQ job instead of adding a duplicate', async () => {
    const row = createCandidate({
      actionType: 'BAN_MEMBER',
      status: MaxActionLedgerStatus.FAILED_RETRYABLE,
      userId: 'user-1',
      lastErrorCode: 'max_api_internal_rate_limit',
      lastError: 'per-chat MAX limiter is saturated',
    });
    const retainedJob = {
      data: {
        actionType: 'BAN_MEMBER',
        chatId: 'chat-1',
        userId: 'user-1',
        idempotencyKey: 'job-1',
      },
      getState: jest.fn().mockResolvedValue('failed'),
      retry: jest.fn().mockResolvedValue(undefined),
      processedOn: Date.now() - 10 * 60_000,
      attemptsMade: 1,
    };
    const { service, criticalQueue } = createHarness({
      rows: [row],
      criticalJob: retainedJob,
    });

    await service.runNow();

    expect(retainedJob.retry).toHaveBeenCalledTimes(1);
    expect(criticalQueue.add).not.toHaveBeenCalled();
    expect((await service.getSnapshot()).lastRequeuedCount).toBe(1);
  });

  it('classifies a recent limiter orphan in shadow mode without queue or database mutation', async () => {
    const row = createCandidate({
      actionType: 'UNBAN_MEMBER',
      status: MaxActionLedgerStatus.FAILED_RETRYABLE,
      userId: 'user-1',
      lastErrorCode: 'max_api_internal_rate_limit',
      lastError: 'per-chat MAX limiter is saturated',
    });
    const harness = createHarness({ rows: [row], mode: 'shadow' });

    await harness.service.runNow();

    expect(harness.criticalQueue.add).not.toHaveBeenCalled();
    expect(harness.prisma.maxActionLedgerEntry.updateMany).not.toHaveBeenCalled();
    expect(await harness.service.getSnapshot()).toEqual(
      expect.objectContaining({
        staleRetryableCount: 1,
        lastShadowClassifiedCount: 1,
        lastWouldRequeueCount: 1,
        lastRequeuedCount: 0,
      }),
    );
  });

  it('terminalizes an expired limiter orphan without historical replay', async () => {
    const row = createCandidate({
      actionType: 'KICK_MEMBER',
      status: MaxActionLedgerStatus.FAILED_RETRYABLE,
      userId: 'user-1',
      lastErrorCode: 'max_api_internal_rate_limit',
      lastError: 'per-chat MAX limiter is saturated',
      updatedAt: new Date(Date.now() - 31 * 60_000),
    });
    const { service, prisma, criticalQueue } = createHarness({ rows: [row] });

    await service.runNow();

    expect(criticalQueue.add).not.toHaveBeenCalled();
    expect(prisma.maxActionLedgerEntry.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: MaxActionLedgerStatus.FAILED_TERMINAL,
          lastErrorCode: 'ledger.watchdog.retry_orphan_expired',
        }),
      }),
    );
    expect(await service.getSnapshot()).toEqual(
      expect.objectContaining({
        lastRetryOrphanTerminalizedCount: 1,
        lastRequeuedCount: 0,
      }),
    );
  });

  it('never requeues a retryable SEND_MESSAGE orphan', async () => {
    const row = createCandidate({
      status: MaxActionLedgerStatus.FAILED_RETRYABLE,
      lastErrorCode: 'max_api_internal_rate_limit',
      lastError: 'MAX upload payload is missing',
    });
    const { service, prisma, interactiveQueue } = createHarness({ rows: [row] });

    await service.runNow();

    expect(interactiveQueue.add).not.toHaveBeenCalled();
    expect(prisma.maxActionLedgerEntry.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: MaxActionLedgerStatus.FAILED_TERMINAL,
        }),
      }),
    );
    expect((await service.getSnapshot()).lastRequeuedCount).toBe(0);
  });

  it('does not update the ledger when recovery queue ownership fails', async () => {
    const row = createCandidate({
      actionType: 'KICK_MEMBER',
      status: MaxActionLedgerStatus.FAILED_RETRYABLE,
      userId: 'user-1',
      lastErrorCode: 'max_api_internal_rate_limit',
      lastError: 'per-chat MAX limiter is saturated',
    });
    const { service, prisma } = createHarness({
      rows: [row],
      addError: new Error('queue add failed'),
    });

    await service.runNow();

    expect(prisma.maxActionLedgerEntry.updateMany).not.toHaveBeenCalled();
    expect((await service.getSnapshot()).lastError).toBe('queue add failed');
  });

  it('reports a CAS conflict after queue ownership without overwriting concurrent ledger state', async () => {
    const row = createCandidate({
      actionType: 'KICK_MEMBER',
      status: MaxActionLedgerStatus.FAILED_RETRYABLE,
      userId: 'user-1',
      lastErrorCode: 'max_api_internal_rate_limit',
      lastError: 'per-chat MAX limiter is saturated',
    });
    const { service, prisma, criticalQueue } = createHarness({ rows: [row], updateCount: 0 });

    await service.runNow();

    expect(criticalQueue.add).toHaveBeenCalledTimes(1);
    expect(prisma.maxActionLedgerEntry.updateMany).toHaveBeenCalledTimes(1);
    expect(await service.getSnapshot()).toEqual(
      expect.objectContaining({
        lastConflictCount: 1,
        lastRequeuedCount: 0,
      }),
    );
  });

  it('defaults rollout behavior to shadow classification without database mutations', async () => {
    const row = createCandidate({
      status: MaxActionLedgerStatus.IN_PROGRESS,
      attemptCount: 1,
      dispatchToken: 'dispatch-token-1',
      dispatchStartedAt: new Date(Date.now() - 10 * 60_000),
      dispatchBotId: 'bot-1',
    });
    const harness = createHarness({ rows: [row], mode: 'default' });

    await harness.service.runNow();

    expect(harness.prisma.maxActionLedgerEntry.updateMany).not.toHaveBeenCalled();
    expect(await harness.service.getSnapshot()).toEqual(
      expect.objectContaining({
        enabled: true,
        mode: 'shadow',
        lastReconciledCount: 0,
        lastShadowClassifiedCount: 1,
        lastWouldQuarantineCount: 1,
        lastWouldTerminalFailCount: 0,
      }),
    );
  });

  it('enforces canary mutations only for explicitly allowed ledger or chat ids', async () => {
    const allowed = createHarness({
      rows: [createCandidate()],
      mode: 'canary',
      canaryPercent: 100,
      canaryEntityIds: 'chat-1',
    });
    await allowed.service.runNow();
    expect(allowed.prisma.maxActionLedgerEntry.updateMany).toHaveBeenCalledTimes(1);

    const shadowed = createHarness({
      rows: [createCandidate({ id: 'ledger-2', jobId: 'job-2', chatId: 'chat-2' })],
      mode: 'canary',
      canaryPercent: 100,
      canaryEntityIds: 'chat-1',
    });
    await shadowed.service.runNow();
    expect(shadowed.prisma.maxActionLedgerEntry.updateMany).not.toHaveBeenCalled();
    expect((await shadowed.service.getSnapshot()).lastShadowClassifiedCount).toBe(1);
  });

  it('keeps an empty canary allowlist fully non-mutating', async () => {
    const harness = createHarness({
      rows: [createCandidate()],
      mode: 'canary',
      canaryPercent: 100,
      canaryEntityIds: '',
    });

    await harness.service.runNow();

    expect(harness.prisma.maxActionLedgerEntry.updateMany).not.toHaveBeenCalled();
    expect(await harness.service.getSnapshot()).toEqual(
      expect.objectContaining({
        lastReconciledCount: 0,
        lastShadowClassifiedCount: 1,
      }),
    );
  });

  it('does no scanning when rollout mode is off', async () => {
    const { service, prisma, redis } = createHarness({
      rows: [createCandidate()],
      mode: 'off',
    });

    await service.runNow();

    expect(redis.acquireLock).not.toHaveBeenCalled();
    expect(prisma.maxActionLedgerEntry.findMany).not.toHaveBeenCalled();
    expect(await service.getSnapshot()).toEqual(
      expect.objectContaining({
        enabled: false,
        mode: 'off',
      }),
    );
  });

  it.each([
    [MaxActionLedgerStatus.IN_PROGRESS, MaxActionLedgerStatus.AMBIGUOUS],
    [MaxActionLedgerStatus.FAILED_RETRYABLE, MaxActionLedgerStatus.AMBIGUOUS],
  ])(
    'never recovers an unban attempt with %s without its live guard',
    async (status, expectedStatus) => {
      const row = createCandidate({
        actionType: 'TRY_UNBAN_MEMBER',
        userId: 'user-1',
        status,
        attemptCount: 1,
        firstAttemptAt: new Date(Date.now() - 11 * 60_000),
        lastAttemptAt: new Date(Date.now() - 10 * 60_000),
        ...(status === MaxActionLedgerStatus.FAILED_RETRYABLE
          ? { lastErrorCode: 'max_api_internal_rate_limit' }
          : {}),
      });
      const { service, prisma, criticalQueue } = createHarness({ rows: [row] });
      await service.runNow();
      expect(criticalQueue.add).not.toHaveBeenCalled();
      expect(prisma.maxActionLedgerEntry.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ status: expectedStatus }) }),
      );
      expect((await service.getSnapshot()).lastRequeuedCount).toBe(0);
    },
  );

  it('quarantines a stale network mutation that may already have executed', async () => {
    const row = createCandidate({
      status: MaxActionLedgerStatus.IN_PROGRESS,
      attemptCount: 1,
      firstAttemptAt: new Date(Date.now() - 11 * 60_000),
      lastAttemptAt: new Date(Date.now() - 10 * 60_000),
      dispatchToken: 'dispatch-token-1',
      dispatchStartedAt: new Date(Date.now() - 10 * 60_000),
      dispatchBotId: 'bot-1',
    });
    const { service, prisma } = createHarness({ rows: [row] });

    await service.runNow();

    expect(prisma.maxActionLedgerEntry.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: MaxActionLedgerStatus.AMBIGUOUS,
          ambiguous: true,
          terminal: true,
          lastErrorCode: 'ledger.watchdog.ambiguous',
          lastError: expect.stringContaining('Manual review is required before retry'),
        }),
      }),
    );
    const snapshot = await service.getSnapshot();
    expect(snapshot.lastQuarantinedCount).toBe(1);
    expect(snapshot.staleInProgressCount).toBe(1);
  });

  it('terminally fails ordinary stale SEND_MESSAGE work that never acquired a dispatch fence', async () => {
    const row = createCandidate({
      status: MaxActionLedgerStatus.IN_PROGRESS,
      attemptCount: 2,
      firstAttemptAt: new Date(Date.now() - 11 * 60_000),
      lastAttemptAt: new Date(Date.now() - 10 * 60_000),
    });
    const { service, prisma } = createHarness({ rows: [row] });

    await service.runNow();

    expect(prisma.maxActionLedgerEntry.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: MaxActionLedgerStatus.FAILED_TERMINAL,
          ambiguous: false,
          lastErrorCode: 'ledger.watchdog.pre_dispatch_orphan',
        }),
      }),
    );
    expect((await service.getSnapshot()).lastQuarantinedCount).toBe(0);
  });

  it('defers a versioned channel-suggestion publication without a dispatch fence', async () => {
    const row = createCandidate({
      jobId: buildMaxActionChannelSuggestionPublicationJobId('suggestion-1'),
      sourceTag: MAX_ACTION_CHANNEL_SUGGESTION_PUBLICATION_SOURCE_TAG,
      status: MaxActionLedgerStatus.IN_PROGRESS,
      attemptCount: 1,
      firstAttemptAt: new Date(Date.now() - 11 * 60_000),
      lastAttemptAt: new Date(Date.now() - 10 * 60_000),
    });
    const { service, prisma } = createHarness({ rows: [row] });

    await service.runNow();

    expect(prisma.maxActionLedgerEntry.updateMany).not.toHaveBeenCalled();
    expect(await service.getSnapshot()).toEqual(
      expect.objectContaining({
        lastDeferredCount: 1,
        lastDeferredByReason: expect.objectContaining({
          ownedByPublication: { count: 1, oldestAgeSec: expect.any(Number) },
        }),
        lastTerminalFailedCount: 0,
        lastQuarantinedCount: 0,
      }),
    );
  });

  it('quarantines a versioned channel-suggestion publication with a retained fence', async () => {
    const row = createCandidate({
      jobId: buildMaxActionChannelSuggestionPublicationJobId('suggestion-1'),
      sourceTag: MAX_ACTION_CHANNEL_SUGGESTION_PUBLICATION_SOURCE_TAG,
      status: MaxActionLedgerStatus.IN_PROGRESS,
      attemptCount: 1,
      dispatchToken: 'suggestion-dispatch-token-1',
      dispatchStartedAt: new Date(Date.now() - 10 * 60_000),
      dispatchBotId: 'bot-1',
    });
    const { service, prisma } = createHarness({ rows: [row] });

    await service.runNow();

    expect(prisma.maxActionLedgerEntry.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: MaxActionLedgerStatus.AMBIGUOUS,
          ambiguous: true,
          terminal: true,
          lastErrorCode: 'ledger.watchdog.ambiguous',
          lastError: expect.stringContaining('Manual review is required before retry'),
        }),
      }),
    );
    expect(await service.getSnapshot()).toEqual(
      expect.objectContaining({
        lastDeferredCount: 0,
        lastTerminalFailedCount: 0,
        lastQuarantinedCount: 1,
      }),
    );
  });

  it('terminally fails an unconfirmed idempotent action without calling it ambiguous', async () => {
    const row = createCandidate({
      actionType: 'DELETE_MESSAGE',
      status: MaxActionLedgerStatus.IN_PROGRESS,
      attemptCount: 1,
    });
    const { service, prisma } = createHarness({ rows: [row] });

    await service.runNow();

    expect(prisma.maxActionLedgerEntry.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: MaxActionLedgerStatus.FAILED_TERMINAL,
          ambiguous: false,
          terminal: true,
          lastErrorCode: 'ledger.watchdog.unconfirmed_safe_action',
        }),
      }),
    );
    const snapshot = await service.getSnapshot();
    expect(snapshot.lastTerminalFailedCount).toBe(1);
    expect(snapshot.lastQuarantinedCount).toBe(0);
  });

  it('leaves retained waiting or delayed jobs to BullMQ', async () => {
    const row = createCandidate();
    const job = {
      getState: jest.fn().mockResolvedValue('delayed'),
      processedOn: undefined,
      attemptsMade: 0,
    };
    const { service, prisma } = createHarness({ rows: [row], job });

    await service.runNow();

    expect(prisma.maxActionLedgerEntry.updateMany).not.toHaveBeenCalled();
    const snapshot = await service.getSnapshot();
    expect(snapshot.staleCount).toBe(0);
    expect(snapshot.lastScannedCount).toBe(1);
    expect(snapshot.lastDeferredCount).toBe(1);
    expect(snapshot.lastDeferredByReason?.waitingInQueue).toEqual({
      count: 1,
      oldestAgeSec: expect.any(Number),
    });
    expect(snapshot.lastReconciledCount).toBe(0);
  });

  it('reports fresh execution separately from work still waiting in the queue', async () => {
    const row = createCandidate({ actionType: 'DELETE_MESSAGE' });
    const { service, prisma } = createHarness({
      rows: [row],
      job: {
        getState: jest.fn().mockResolvedValue('active'),
        processedOn: Date.now() - 1_000,
      },
    });

    await service.runNow();

    expect(prisma.maxActionLedgerEntry.updateMany).not.toHaveBeenCalled();
    const snapshot = await service.getSnapshot();
    expect(snapshot.lastDeferredCount).toBe(1);
    expect(snapshot.lastDeferredByReason?.waitingInQueue.count).toBe(0);
    expect(snapshot.lastDeferredByReason?.recentlyStarted.count).toBe(1);
  });

  it('does not infer a reason breakdown for a status written by an older worker', async () => {
    const { service, redis } = createHarness();
    redis.getString.mockResolvedValue(JSON.stringify({ lastDeferredCount: 4 }));

    const snapshot = await service.getSnapshot();
    expect(snapshot.lastDeferredCount).toBe(4);
    expect(snapshot.lastDeferredByReason).toBeNull();
  });

  it('finds retained jobs in a split action lane when legacy is empty', async () => {
    const row = createCandidate();
    const job = {
      getState: jest.fn().mockResolvedValue('waiting'),
      processedOn: undefined,
      attemptsMade: 0,
    };
    const { service, prisma, queue, interactiveQueue } = createHarness({
      rows: [row],
      interactiveJob: job,
    });

    await service.runNow();

    expect(queue.getJob).toHaveBeenCalledWith('job-1');
    expect(interactiveQueue.getJob).toHaveBeenCalledWith('job-1');
    expect(prisma.maxActionLedgerEntry.updateMany).not.toHaveBeenCalled();
    expect((await service.getSnapshot()).lastDeferredCount).toBe(1);
  });

  it('recovers a retained completed non-SEND BullMQ job as succeeded', async () => {
    const row = createCandidate({
      actionType: 'DELETE_MESSAGE',
      status: MaxActionLedgerStatus.IN_PROGRESS,
      attemptCount: 1,
    });
    const job = {
      getState: jest.fn().mockResolvedValue('completed'),
      processedOn: Date.now() - 10 * 60_000,
      attemptsMade: 1,
    };
    const { service, prisma } = createHarness({ rows: [row], job });

    await service.runNow();

    expect(prisma.maxActionLedgerEntry.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: MaxActionLedgerStatus.SUCCEEDED,
          ambiguous: false,
          terminal: true,
          lastErrorCode: null,
          lastError: null,
        }),
      }),
    );
    const snapshot = await service.getSnapshot();
    expect(snapshot.lastRecoveredSucceededCount).toBe(1);
  });

  it('does not mark completed SEND_MESSAGE work successful without a remote message id', async () => {
    const row = createCandidate({
      status: MaxActionLedgerStatus.IN_PROGRESS,
      attemptCount: 1,
    });
    const job = {
      getState: jest.fn().mockResolvedValue('completed'),
      processedOn: Date.now() - 10 * 60_000,
      attemptsMade: 1,
    };
    const { service, prisma } = createHarness({ rows: [row], job });

    await service.runNow();

    expect(prisma.maxActionLedgerEntry.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: MaxActionLedgerStatus.FAILED_TERMINAL,
          ambiguous: false,
          lastErrorCode: 'ledger.watchdog.send_completed_without_remote_id',
        }),
      }),
    );
    expect((await service.getSnapshot()).lastRecoveredSucceededCount).toBe(0);
  });

  it('recovers a versioned channel-suggestion publication from a durable remote message id', async () => {
    const row = createCandidate({
      jobId: buildMaxActionChannelSuggestionPublicationJobId('suggestion-1'),
      sourceTag: MAX_ACTION_CHANNEL_SUGGESTION_PUBLICATION_SOURCE_TAG,
      status: MaxActionLedgerStatus.IN_PROGRESS,
      attemptCount: 1,
      dispatchToken: 'dispatch-token-1',
      dispatchStartedAt: new Date(Date.now() - 10 * 60_000),
      dispatchBotId: 'bot-2',
      remoteMessageId: 'mid-1',
    });
    const { service, prisma } = createHarness({ rows: [row] });

    await service.runNow();

    expect(prisma.maxActionLedgerEntry.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: MaxActionLedgerStatus.SUCCEEDED,
          ambiguous: false,
          lastErrorCode: null,
        }),
      }),
    );
    expect((await service.getSnapshot()).lastRecoveredSucceededCount).toBe(1);
  });

  it('persists a rotating cursor after a truncated shadow scan', async () => {
    const updatedAt = new Date(Date.now() - 10 * 60_000);
    const rows = Array.from({ length: 1_000 }, (_, index) =>
      createCandidate({
        id: `ledger-${String(index + 1).padStart(4, '0')}`,
        jobId: `job-${index + 1}`,
        chatId: `chat-${index + 1}`,
        updatedAt,
      }),
    );
    const findMany = jest.fn().mockImplementation(async (args: any) => {
      const afterId = args.where.OR?.[1]?.id?.gt as string | undefined;
      const start = afterId ? rows.findIndex((row) => row.id === afterId) + 1 : 0;
      return rows.slice(start, start + args.take);
    });
    const { service, redis } = createHarness({ mode: 'shadow', findMany });

    await service.runNow();

    expect((await service.getSnapshot()).lastScanTruncated).toBe(true);
    expect(redis.setStringWithTtl).toHaveBeenCalledWith(
      'system:max-action-ledger:watchdog:cursor:v1',
      JSON.stringify({ id: 'ledger-1000', updatedAt: updatedAt.toISOString() }),
      expect.any(Number),
    );
  });

  it('resumes scanning after the persisted cursor', async () => {
    const cursorUpdatedAt = new Date(Date.now() - 11 * 60_000);
    const row = createCandidate({
      id: 'ledger-after-cursor',
      jobId: 'job-after-cursor',
      chatId: 'chat-after-cursor',
      updatedAt: new Date(Date.now() - 10 * 60_000),
    });
    const findMany = jest.fn().mockResolvedValueOnce([row]);
    const { service } = createHarness({
      rows: [row],
      findMany,
      persistedCursor: { id: 'ledger-1000', updatedAt: cursorUpdatedAt },
    });

    await service.runNow();

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: [
            { updatedAt: { gt: cursorUpdatedAt, lte: expect.any(Date) } },
            { updatedAt: cursorUpdatedAt, id: { gt: 'ledger-1000' } },
          ],
        }),
      }),
    );
  });

  it('does no database work when another runtime owns the Redis lock', async () => {
    const { service, prisma, redis } = createHarness({
      rows: [createCandidate()],
      lockToken: null,
    });

    await service.runNow();

    expect(prisma.maxActionLedgerEntry.findMany).not.toHaveBeenCalled();
    expect(prisma.maxActionLedgerEntry.updateMany).not.toHaveBeenCalled();
    expect(redis.releaseLock).not.toHaveBeenCalled();
  });

  it('surfaces queue inspection failures without mutating the ledger', async () => {
    const { service, prisma, queue } = createHarness({ rows: [createCandidate()] });
    queue.getJob.mockRejectedValueOnce(new Error('redis unavailable'));

    await service.runNow('scheduled');

    expect(prisma.maxActionLedgerEntry.updateMany).not.toHaveBeenCalled();
    const snapshot = await service.getSnapshot();
    expect(snapshot.lastError).toBe('redis unavailable');
    expect(snapshot.lastRunReason).toBe('scheduled');
    expect(snapshot.lastSuccessAt).toBeNull();
  });
});
