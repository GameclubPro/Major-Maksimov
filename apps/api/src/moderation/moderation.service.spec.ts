import {
  WebhookParser,
  ChatRulesPublishFenceRetryError,
  ModerationService,
  WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINE_PREFIX,
  WebhookCanonicalExecutionService,
  WebhookOrderedPredecessorPendingError,
  WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINE_HEARTBEAT_MS,
  WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINE_MAX_LIFETIME_MS,
  WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINE_PERSIST_RETRY_MS,
  WEBHOOK_HOT_PATH_TIMEOUT_TERMINAL_QUARANTINE_PREFIX,
  DEVELOPER_FORCED_GLOBAL_SPAMMER_HOT_PATH_TIMEOUT_MS,
  GLOBAL_SPAMMER_CONFIRMED_FANOUT_EPISODE_THRESHOLD,
  GLOBAL_SPAMMER_EXEMPTION_HOT_PATH_TIMEOUT_MS,
  GLOBAL_SPAMMER_EXEMPTION_HOT_PATH_MAX_ADMIN_IDS,
  GLOBAL_SPAMMER_HIGH_FANOUT_MIN_CHATS,
  GLOBAL_SPAMMER_TRACK_HOT_PATH_TIMEOUT_MS,
  SHARED_CHAT_EXECUTION_LOCK_AMBIGUOUS_RETRY_AFTER_MS,
  createDeferred,
  createMaxApiError,
  createUpdate,
  installImmediateTimeoutForDelay,
  createPrivateCallbackUpdate,
  withCanonicalWebhookFixture,
} from './moderation.service.spec-support';
import { buildWebhookSemanticEventKey } from '../webhook/webhook-semantic-event-key';
import { WebhookPreparationDeferredError } from '../common/webhook-preparation-deferred.error';
import { WebhookPreparationRetryError } from './webhook-preparation-retry';
import { WebhookFinishPersistenceError } from './webhook-canonical-execution.service';

describe('ModerationService', () => {
  it.each(['unexpected', 'preparation', 'ordering'] as const)(
    'preserves preparation failures and diagnoses only unexpected errors, kind=%s',
    async (kind) => {
      const error =
        kind === 'preparation'
          ? new WebhookPreparationDeferredError('private-receipt', 1_000)
          : kind === 'ordering'
            ? new WebhookOrderedPredecessorPendingError('private-receipt', 'private-owner')
            : Object.assign(new Error('private-receipt secret'), { code: 'P2028' });
      const canonical = {
        prepareExecution: jest.fn().mockRejectedValue(error),
        failExecution: jest.fn(),
      };
      const service = new ModerationService({} as never, {} as never, {} as never, {} as never);
      const warn = jest.fn();
      Object.assign(service, {
        injectedWebhookCanonicalExecutionService: canonical,
        logger: { warn },
      });
      const handler = jest.spyOn(service, 'handleUpdate');
      if (kind === 'preparation') {
        await expect(service.processWebhookEvent('private-receipt')).rejects.toBeInstanceOf(
          WebhookPreparationRetryError,
        );
        expect(warn).not.toHaveBeenCalled();
      } else if (kind === 'ordering') {
        await expect(service.processWebhookEvent('private-receipt')).rejects.toBe(error);
        expect(warn).not.toHaveBeenCalled();
      } else {
        await expect(service.processWebhookEvent('private-receipt')).rejects.toBe(error);
        expect(warn).toHaveBeenCalledWith(
          expect.objectContaining({ stage: 'preparation', errorCode: 'P2028' }),
          'Webhook execution failed before recovery settlement',
        );
        expect(JSON.stringify(warn.mock.calls)).not.toMatch(/private-receipt|secret/u);
      }
      expect(handler).not.toHaveBeenCalled();
      expect(canonical.failExecution).not.toHaveBeenCalled();
    },
  );

  it('fails closed for an official callback whose source message was deleted', async () => {
    const update = new WebhookParser().parse(
      {
        update_type: 'message_callback',
        timestamp: 1772249118580,
        callback: {
          timestamp: 1772249118580,
          callback_id: 'callback-deleted-message-1',
          payload: 'pc2|broadcast_send',
          user: { user_id: 891 },
        },
        message: null,
        user_locale: 'ru-RU',
      },
      { botId: 'bot-1' },
    );
    const maxClient = {
      answerCallback: jest.fn().mockResolvedValue(undefined),
    };
    const privateControlService = {
      handleUpdate: jest.fn().mockResolvedValue(undefined),
    };
    const managedPollService = {
      tryHandleCallback: jest.fn().mockResolvedValue(false),
    };
    const service = new ModerationService(
      {} as never,
      { detect: jest.fn() } as never,
      { resolveAction: jest.fn() } as never,
      maxClient as never,
      undefined,
      undefined,
      undefined,
      undefined,
      privateControlService as never,
    );
    (service as any).managedPollService = managedPollService;

    await expect(service.handleUpdate(update)).resolves.toBeUndefined();

    expect(maxClient.answerCallback).toHaveBeenCalledWith(
      'callback-deleted-message-1',
      'Кнопка устарела',
      undefined,
      expect.objectContaining({
        botId: 'bot-1',
        ignoreFailureMetricStatuses: expect.any(Array),
      }),
    );
    expect(privateControlService.handleUpdate).not.toHaveBeenCalled();
    expect(managedPollService.tryHandleCallback).not.toHaveBeenCalled();

    await expect(service.handleUpdate({ ...update, botId: undefined })).resolves.toBeUndefined();
    expect(maxClient.answerCallback).toHaveBeenCalledTimes(1);
  });

  it('delivers an official pure forward from the persisted worker to private control', async () => {
    const update = new WebhookParser().parse(
      {
        update_type: 'message_created',
        timestamp: '2026-08-01T10:00:00.000Z',
        message: {
          sender: { user_id: 195_714_583, name: 'Тестовый пользователь' },
          recipient: { chat_id: 195_714_583, chat_type: 'dialog' },
          body: null,
          link: {
            type: 'forward',
            chat_id: -70_000_000_000_001,
            message: { mid: 'mid-forwarded-worker-source-1', text: 'Исходный пост' },
          },
        },
      },
      { botId: 'bot-1' },
    );
    const prisma = {
      webhookEvent: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'event-pure-forward-worker-1',
          status: 'QUEUED',
          botId: 'bot-1',
          normalizedPayload: update,
        }),
        update: jest.fn().mockResolvedValue(undefined),
      },
    };
    const privateControlService = {
      handleUpdate: jest.fn().mockResolvedValue(undefined),
    };
    const persisted = withCanonicalWebhookFixture(prisma);
    const service = new ModerationService(
      prisma as never,
      { detect: jest.fn() } as never,
      { resolveAction: jest.fn() } as never,
      {} as never,
      undefined,
      undefined,
      undefined,
      undefined,
      privateControlService as never,
    );
    const completeWebhookExecution = jest.spyOn(
      (service as any).webhookCanonicalExecutionService,
      'completeExecution',
    );
    const commercialOcrEnqueueService = {
      activatePendingBatch: jest.fn().mockResolvedValue(undefined),
      suppressPendingBatch: jest.fn().mockResolvedValue(undefined),
    };
    (service as any).commercialOcrEnqueueService = commercialOcrEnqueueService;

    await expect(
      service.processWebhookEvent('event-pure-forward-worker-1'),
    ).resolves.toBeUndefined();

    expect(update.message?.messageId).toBe(`message_created:${update.updateId}`);
    expect(privateControlService.handleUpdate).toHaveBeenCalledWith(update);
    expect(persisted.webhookEvent.updateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({ id: 'event-pure-forward-worker-1' }),
      data: expect.objectContaining({
        status: 'PROCESSED',
        errorMessage: null,
        nextEnqueueAt: null,
      }),
    });
    expect(completeWebhookExecution.mock.invocationCallOrder[0]).toBeLessThan(
      commercialOcrEnqueueService.activatePendingBatch.mock.invocationCallOrder[0]!,
    );
  });

  it('does not re-run an already processed webhook event', async () => {
    const prisma = {
      webhookEvent: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'event-processed-1',
          status: 'PROCESSED',
          botId: 'bot-1',
          normalizedPayload: createUpdate(),
        }),
        update: jest.fn(),
      },
    };
    const service = new ModerationService(
      prisma as never,
      { detect: jest.fn() } as never,
      { resolveAction: jest.fn() } as never,
      {} as never,
    );
    const handleUpdate = jest.spyOn(service, 'handleUpdate');

    await expect(service.processWebhookEvent('event-processed-1')).resolves.toBeUndefined();

    expect(handleUpdate).not.toHaveBeenCalled();
    expect(prisma.webhookEvent.update).not.toHaveBeenCalled();
  });

  it.each([
    [true, 'QUEUED'],
    [true, 'FAILED'],
    [false, 'QUEUED'],
    [false, 'FAILED'],
  ])(
    'does not re-run a completed owning webhook claim (enforced=%s, status=%s)',
    async (enforced, eventStatus) => {
      const update = createUpdate();
      const completedAt = new Date('2026-08-31T09:40:00.000Z');
      const prisma = {
        $queryRaw: jest.fn(),
        webhookEvent: {
          findUnique: jest.fn().mockResolvedValue({
            id: 'event-completed-owner-1',
            status: eventStatus,
            queueName: 'moderation-default-3',
            botId: 'bot-1',
            normalizedPayload: update,
          }),
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
          update: jest.fn(),
        },
        webhookExecutionClaim: {
          findUnique: jest.fn().mockResolvedValue({
            id: 'claim-completed-owner-1',
            webhookEventId: 'event-completed-owner-1',
            executionBotId: 'bot-1',
            enforced,
            status: 'COMPLETED',
            preparedAt: new Date('2026-08-31T09:39:00.000Z'),
            completedAt,
            leaseToken: null,
            leaseExpiresAt: null,
          }),
          updateMany: jest.fn(),
        },
      };
      withCanonicalWebhookFixture(prisma);
      const service = new ModerationService(
        prisma as never,
        { detect: jest.fn() } as never,
        { resolveAction: jest.fn() } as never,
        {} as never,
      );
      const handleUpdate = jest.spyOn(service, 'handleUpdate');

      await expect(service.processWebhookEvent('event-completed-owner-1')).resolves.toBeUndefined();

      expect(handleUpdate).not.toHaveBeenCalled();
      expect(prisma.$queryRaw).toHaveBeenCalledTimes(2);
      expect(prisma.$queryRaw.mock.calls[0]?.[0]?.strings.join(' ')).toContain(
        'WITH authority_ids AS MATERIALIZED',
      );
      expect(prisma.webhookExecutionClaim.updateMany).toHaveBeenCalledTimes(enforced ? 1 : 2);
      expect(prisma.webhookExecutionClaim.updateMany).toHaveBeenLastCalledWith({
        where: expect.objectContaining({
          id: 'claim-completed-owner-1',
          semanticKey: buildWebhookSemanticEventKey(update),
          enforced: true,
          status: 'COMPLETED',
          completedAt,
          leaseToken: null,
          leaseExpiresAt: null,
        }),
        data: { enforced: true },
      });
      expect(prisma.webhookEvent.updateMany).toHaveBeenCalledWith({
        where: {
          id: 'event-completed-owner-1',
          status: eventStatus,
          normalizedPayload: { equals: update },
          errorMessage: null,
          nextEnqueueAt: null,
          timeoutQuarantineExpiresAt: null,
        },
        data: {
          status: 'PROCESSED',
          processedAt: completedAt,
          queueName: null,
          errorMessage: null,
          nextEnqueueAt: null,
        },
      });
      expect(prisma.webhookEvent.update).not.toHaveBeenCalled();
    },
  );

  it('allows only one overlapping worker to hold an enforced canonical business lease', async () => {
    let leaseHeld = false;
    let releaseHandleUpdate!: () => void;
    const handleUpdateGate = new Promise<void>((resolve) => {
      releaseHandleUpdate = resolve;
    });
    const update = createUpdate();
    const prisma = {
      webhookEvent: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'event-canonical-lease-1',
          status: 'QUEUED',
          botId: 'bot-1',
          normalizedPayload: update,
        }),
        update: jest.fn().mockResolvedValue(undefined),
      },
      webhookExecutionClaim: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'claim-canonical-lease-1',
          webhookEventId: 'event-canonical-lease-1',
          executionBotId: 'bot-1',
          enforced: true,
          status: 'READY',
          leaseToken: null,
          leaseExpiresAt: null,
        }),
        updateMany: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
          if (typeof data.leaseToken === 'string') {
            if (leaseHeld) {
              return { count: 0 };
            }
            leaseHeld = true;
            return { count: 1 };
          }
          if (data.status === 'COMPLETED') {
            leaseHeld = false;
          }
          return { count: 1 };
        }),
      },
    };
    withCanonicalWebhookFixture(prisma);
    const service = new ModerationService(
      prisma as never,
      { detect: jest.fn() } as never,
      { resolveAction: jest.fn() } as never,
      {} as never,
    );
    const handleUpdate = jest.spyOn(service, 'handleUpdate').mockReturnValue(handleUpdateGate);

    const firstWorker = service.processWebhookEvent('event-canonical-lease-1');
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(handleUpdate).toHaveBeenCalledTimes(1);

    await expect(service.processWebhookEvent('event-canonical-lease-1')).rejects.toThrow(
      'Canonical business already running',
    );
    expect(handleUpdate).toHaveBeenCalledTimes(1);

    releaseHandleUpdate();
    await expect(firstWorker).resolves.toBeUndefined();
  });

  it('leases an enforced receipt-fallback claim when no semantic event key exists', async () => {
    const receipt = {
      id: 'event-fallback-lease-1',
      dedupKey: 'bot-1:fallback-without-semantic-subject',
      semanticKey: null,
      executionDeadlineAt: null,
      createdAt: new Date(),
      status: 'QUEUED',
      botId: 'bot-1',
      errorMessage: null,
      timeoutQuarantineExpiresAt: null,
      normalizedPayload: {
        updateId: 'fallback-without-semantic-subject',
        type: 'unknown_update',
        botId: 'bot-1',
      },
    };
    const claim = {
      id: 'claim-fallback-lease-1',
      kind: 'EXECUTION',
      semanticKey: `receipt:${receipt.dedupKey}`,
      webhookEventId: receipt.id,
      executionBotId: 'bot-1',
      enforced: true,
      status: 'READY',
      createdAt: new Date(),
      preparedAt: new Date(),
      businessStartedAt: null as Date | null,
      completedAt: null,
      commandResult: null,
      leaseToken: null as string | null,
      leaseExpiresAt: null as Date | null,
    };
    const prisma = {
      webhookEvent: {
        findUnique: jest.fn(async () => ({ ...receipt })),
      },
      webhookExecutionClaim: {
        findUnique: jest.fn(),
        findFirst: jest.fn(async () => ({ ...claim })),
        updateMany: jest.fn(
          async ({
            where,
            data,
          }: {
            where: Record<string, unknown>;
            data: Record<string, unknown>;
          }) => {
            if (
              where.id !== claim.id ||
              where.status !== claim.status ||
              where.businessStartedAt !== claim.businessStartedAt ||
              (claim.leaseExpiresAt && claim.leaseExpiresAt.getTime() >= Date.now())
            )
              return { count: 0 };
            Object.assign(claim, data);
            return { count: 1 };
          },
        ),
      },
      $queryRaw: jest.fn(
        async (query: { strings: readonly string[]; values: readonly unknown[] }) => {
          const sql = query.strings.join('?');
          if (!sql.includes('RETURNING claim."id" AS "claimId"')) return [];
          expect(sql).toContain('"business_started_at" = instant."now"');
          const valueAfter = (fragment: string) =>
            query.values[query.strings.findIndex((part) => part.includes(fragment))];
          if (
            valueAfter('claim."id" = ') !== claim.id ||
            valueAfter('claim."semantic_key" = ') !== claim.semanticKey ||
            valueAfter('event."id" = ') !== receipt.id ||
            valueAfter('claim."status"::text = ') !== claim.status ||
            valueAfter('claim."lease_token" = ') !== claim.leaseToken ||
            !claim.leaseToken ||
            !claim.leaseExpiresAt ||
            claim.leaseExpiresAt.getTime() <= Date.now() ||
            claim.businessStartedAt !== null ||
            claim.completedAt !== null ||
            valueAfter('event."execution_deadline_at" IS NOT DISTINCT FROM ') !== null
          )
            return [];
          claim.businessStartedAt = new Date();
          return [{ ...claim, claimId: claim.id, commandResultIsSqlNull: true }];
        },
      ),
      $transaction: jest.fn(),
    };
    prisma.$transaction.mockImplementation(async (run: (tx: typeof prisma) => Promise<unknown>) =>
      run(prisma),
    );
    const service = new WebhookCanonicalExecutionService(prisma as never);

    const first = await service.prepareExecution('event-fallback-lease-1', null);
    expect(first?.businessLeaseToken).toEqual(expect.any(String));
    expect(claim.leaseToken).toBe(first?.businessLeaseToken);
    expect(claim.businessStartedAt).toEqual(expect.any(Date));
    expect(
      prisma.$queryRaw.mock.calls.filter(([query]) =>
        query.strings.join(' ').includes('RETURNING claim."id" AS "claimId"'),
      ),
    ).toHaveLength(1);
    expect(buildWebhookSemanticEventKey(receipt.normalizedPayload)).toBeNull();
    expect(receipt.semanticKey).toBeNull();
    await expect(service.prepareExecution('event-fallback-lease-1', null)).rejects.toThrow(
      'Canonical business already running',
    );
    expect(
      prisma.$queryRaw.mock.calls.filter(([query]) =>
        query.strings.join(' ').includes('RETURNING claim."id" AS "claimId"'),
      ),
    ).toHaveLength(1);
    expect(prisma.webhookExecutionClaim.updateMany).toHaveBeenCalledTimes(1);
    expect(prisma.webhookExecutionClaim.findFirst).toHaveBeenCalledTimes(2);
    expect(prisma.webhookExecutionClaim.findUnique).not.toHaveBeenCalled();
  });

  it('does not reacquire a hot-path timeout quarantine after its business lease expires', async () => {
    const prisma = {
      webhookEvent: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'event-timeout-quarantine-1',
          status: 'FAILED',
          botId: 'bot-1',
          normalizedPayload: createUpdate(),
          nextEnqueueAt: null,
          errorMessage: `${WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINE_PREFIX}: awaiting manual review`,
        }),
      },
      webhookExecutionClaim: {
        findUnique: jest.fn(),
        updateMany: jest.fn(),
      },
    };
    const service = new WebhookCanonicalExecutionService(prisma as never);

    await expect(
      service.prepareExecution('event-timeout-quarantine-1', 'bot-1'),
    ).resolves.toBeNull();

    expect(prisma.webhookExecutionClaim.findUnique).not.toHaveBeenCalled();
    expect(prisma.webhookExecutionClaim.updateMany).not.toHaveBeenCalled();
  });

  it('rejects a prequeued message before business execution when an older chat head exists', async () => {
    const sourceDate = new Date('2026-08-15T12:00:00.000Z');
    const sourceUpdate = createUpdate(sourceDate);
    const update = {
      ...sourceUpdate,
      message: {
        ...sourceUpdate.message,
        chatId: '-ordered-chat-1',
      },
    };
    const prisma = {
      $queryRaw: jest.fn().mockResolvedValue([{ id: 'event-ordered-a' }]),
      webhookEvent: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'event-ordered-b',
          status: 'QUEUED',
          botId: 'bot-1',
          normalizedPayload: update,
          createdAt: new Date('2026-08-15T12:00:01.000Z'),
        }),
      },
      webhookExecutionClaim: {
        findUnique: jest.fn().mockResolvedValue(null),
        findFirst: jest.fn().mockResolvedValue(null),
        updateMany: jest.fn(),
      },
    };
    withCanonicalWebhookFixture(prisma);
    const service = new WebhookCanonicalExecutionService(prisma as never);

    await expect(service.prepareExecution('event-ordered-b', 'bot-1')).rejects.toBeInstanceOf(
      WebhookOrderedPredecessorPendingError,
    );
    const predecessorCalls = prisma.$queryRaw.mock.calls.filter(
      (call) =>
        call[0]?.strings &&
        !call[0].strings.join(' ').includes('WITH authority_ids AS MATERIALIZED') &&
        !call[0].strings
          .join(' ')
          .includes('SELECT claim.id, claim.webhook_event_id AS "ownerId"') &&
        !call[0].strings.join(' ').includes('FROM "webhook_events" AS "prior"'),
    );
    expect(predecessorCalls).toHaveLength(1);
    const predecessorQuery = predecessorCalls[0]?.[0] as
      | { strings?: readonly string[]; values?: readonly unknown[] }
      | undefined;
    const predecessorSql = predecessorQuery?.strings?.join('?').replace(/\s+/gu, ' ') ?? '';
    expect(predecessorSql).toContain(
      `LEFT( COALESCE("error_message", ''), 37 ) = 'WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINED:'`,
    );
    expect(predecessorQuery?.values).not.toContain(37);
    expect(predecessorQuery?.values).not.toContain('WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINED:');
    expect(predecessorQuery?.values).toContain('-ordered-chat-1');
    expect(prisma.webhookExecutionClaim.updateMany).not.toHaveBeenCalled();
  });

  it('rechecks a timeout quarantine after acquiring a stale canonical business lease', async () => {
    const queuedEvent = {
      id: 'event-stale-timeout-claim-1',
      status: 'QUEUED',
      botId: 'bot-1',
      normalizedPayload: createUpdate(),
      nextEnqueueAt: null,
      errorMessage: null,
    };
    const quarantinedEvent = {
      ...queuedEvent,
      status: 'FAILED',
      errorMessage: `${WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINE_PREFIX}: detached work is unresolved`,
    };
    const prisma = {
      webhookEvent: {
        findUnique: jest
          .fn()
          .mockResolvedValueOnce(queuedEvent)
          .mockResolvedValueOnce(quarantinedEvent),
      },
      webhookExecutionClaim: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'claim-stale-timeout-claim-1',
          webhookEventId: queuedEvent.id,
          executionBotId: 'bot-1',
          enforced: true,
          status: 'READY',
          leaseToken: null,
          leaseExpiresAt: null,
        }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    withCanonicalWebhookFixture(prisma);
    const service = new WebhookCanonicalExecutionService(prisma as never);

    await expect(service.prepareExecution(queuedEvent.id, 'bot-1')).resolves.toBeNull();

    expect(prisma.webhookEvent.findUnique).toHaveBeenCalledTimes(2);
    expect(prisma.webhookExecutionClaim.updateMany).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        where: expect.objectContaining({
          webhookEventId: queuedEvent.id,
          kind: 'EXECUTION',
          leaseToken: expect.any(String),
          status: 'READY',
        }),
        data: {
          leaseToken: null,
          leaseExpiresAt: null,
        },
      }),
    );
  });

  it('persists a timeout quarantine before releasing its canonical business lease', async () => {
    const operations: string[] = [];
    const deadlineAt = new Date(Date.now() + 60_000);
    const pendingErrorMessage = `${WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINE_PREFIX}:nonce: timed out`;
    const prisma = {
      webhookEvent: {
        updateMany: jest.fn().mockImplementation(async () => {
          operations.push('quarantine');
          return { count: 1 };
        }),
      },
      webhookExecutionClaim: {
        updateMany: jest.fn().mockImplementation(async () => {
          operations.push('release');
          return { count: 1 };
        }),
      },
    };
    const service = new WebhookCanonicalExecutionService(prisma as never);

    await service.failTimedOutExecution(
      {
        webhookEvent: {
          id: 'event-timeout-release-order-1',
        } as never,
        update: createUpdate(),
        activeBotId: 'bot-1',
        businessLeaseToken: 'lease-token-1',
      },
      {
        errorMessage: pendingErrorMessage,
        deadlineAt,
      },
      { errorMessage: 'timed out' },
    );

    expect(operations).toEqual(['quarantine', 'release']);
  });

  it('does not release an unfenced canonical lease when terminal event persistence fails', async () => {
    const eventWriteError = new Error('terminal event persistence unavailable');
    const webhookEventUpdateMany = jest.fn().mockRejectedValue(eventWriteError);
    const executionClaimUpdateMany = jest.fn().mockResolvedValue({ count: 1 });
    const prisma: {
      webhookEvent: { updateMany: jest.Mock };
      webhookExecutionClaim: { updateMany: jest.Mock };
      $transaction?: jest.Mock;
    } = {
      webhookEvent: { updateMany: webhookEventUpdateMany },
      webhookExecutionClaim: { updateMany: executionClaimUpdateMany },
    };
    prisma.$transaction = jest.fn(async (operation) => operation(prisma));
    const service = new WebhookCanonicalExecutionService(prisma as never);

    await expect(
      service.settleUnquarantinedTimedOutExecution(
        {
          webhookEvent: { id: 'event-timeout-unfenced-terminal-write-1' } as never,
          update: createUpdate(),
          activeBotId: 'bot-1',
          businessLeaseToken: 'lease-token-terminal-write-1',
        },
        { kind: 'failed', error: 'detached execution failed' },
      ),
    ).rejects.toBe(eventWriteError);

    expect(webhookEventUpdateMany).toHaveBeenCalledTimes(1);
    expect(executionClaimUpdateMany).not.toHaveBeenCalled();
  });

  it('bounds timeout settlement transactions and keeps the quarantine fail-closed on expiry', async () => {
    const transactionExpiry = new Error('Transaction already closed after timeout');
    const webhookEventUpdateMany = jest.fn().mockRejectedValue(transactionExpiry);
    const executionClaimUpdateMany = jest.fn().mockResolvedValue({ count: 1 });
    const prisma: {
      webhookEvent: { updateMany: jest.Mock };
      webhookExecutionClaim: { updateMany: jest.Mock };
      $transaction?: jest.Mock;
    } = {
      webhookEvent: { updateMany: webhookEventUpdateMany },
      webhookExecutionClaim: { updateMany: executionClaimUpdateMany },
    };
    prisma.$transaction = jest.fn(async (operation) => operation(prisma));
    const service = new WebhookCanonicalExecutionService(prisma as never);

    await expect(
      service.completeTimedOutExecution(
        {
          webhookEvent: { id: 'event-timeout-transaction-expiry-1' } as never,
          update: createUpdate(),
          activeBotId: 'bot-1',
          businessLeaseToken: 'lease-token-transaction-expiry-1',
        },
        {
          errorMessage: `${WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINE_PREFIX}:nonce-transaction-expiry: pending`,
          deadlineAt: new Date(Date.now() + 30_000),
        },
      ),
    ).rejects.toBe(transactionExpiry);

    expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), {
      maxWait: 10_000,
      timeout: 30_000,
    });
    expect(webhookEventUpdateMany).toHaveBeenCalledTimes(1);
    expect(executionClaimUpdateMany).not.toHaveBeenCalled();
  });

  it('retains an ordered-head timeout quarantine when no semantic claim can fence mirrors', async () => {
    const operations: string[] = [];
    const webhookEventUpdateMany = jest.fn().mockImplementation(async () => {
      operations.push('quarantine');
      return { count: 1 };
    });
    const executionClaimUpdateMany = jest.fn().mockImplementation(async () => {
      operations.push('claim-missing');
      return { count: 0 };
    });
    const prisma: {
      webhookEvent: { updateMany: jest.Mock };
      webhookExecutionClaim: { updateMany: jest.Mock };
      $transaction?: jest.Mock;
    } = {
      webhookEvent: { updateMany: webhookEventUpdateMany },
      webhookExecutionClaim: { updateMany: executionClaimUpdateMany },
    };
    prisma.$transaction = jest.fn(async (operation) => operation(prisma));
    const service = new WebhookCanonicalExecutionService(prisma as never);

    await expect(
      service.settleUnquarantinedTimedOutExecution(
        {
          webhookEvent: { id: 'event-timeout-unfenced-no-claim-1' } as never,
          update: createUpdate(),
          activeBotId: 'bot-1',
          businessLeaseToken: null,
        },
        { kind: 'failed', error: 'detached execution failed' },
      ),
    ).resolves.toBe('quarantined');

    expect(operations).toEqual(['claim-missing', 'quarantine']);
    expect(webhookEventUpdateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({ id: 'event-timeout-unfenced-no-claim-1' }),
      data: expect.objectContaining({
        status: 'FAILED',
        errorMessage: expect.stringMatching(
          new RegExp(`^${WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINE_PREFIX}:`),
        ),
        nextEnqueueAt: null,
        timeoutQuarantineExpiresAt: null,
      }),
    });
  });

  it('does not clear a claim that became enforced after a shadow execution started', async () => {
    const webhookEventUpdateMany = jest.fn().mockResolvedValue({ count: 1 });
    const executionClaimUpdateMany = jest.fn().mockResolvedValue({ count: 0 });
    const prisma: {
      webhookEvent: { updateMany: jest.Mock };
      webhookExecutionClaim: { updateMany: jest.Mock };
      $transaction?: jest.Mock;
    } = {
      webhookEvent: { updateMany: webhookEventUpdateMany },
      webhookExecutionClaim: { updateMany: executionClaimUpdateMany },
    };
    prisma.$transaction = jest.fn(async (operation) => operation(prisma));
    const service = new WebhookCanonicalExecutionService(prisma as never);

    await expect(
      service.settleUnquarantinedTimedOutExecution(
        {
          webhookEvent: { id: 'event-timeout-shadow-promoted-1' } as never,
          update: createUpdate(),
          activeBotId: 'bot-1',
          businessLeaseToken: null,
        },
        { kind: 'completed', timeoutErrorMessage: 'webhook hot-path timeout' },
      ),
    ).resolves.toBe('quarantined');

    expect(executionClaimUpdateMany).toHaveBeenCalledWith({
      where: {
        webhookEventId: 'event-timeout-shadow-promoted-1',
        kind: 'EXECUTION',
        enforced: false,
        status: 'READY',
        leaseToken: null,
        leaseExpiresAt: null,
      },
      data: expect.objectContaining({
        enforced: true,
        status: 'COMPLETED',
        leaseToken: null,
        leaseExpiresAt: null,
      }),
    });
    expect(webhookEventUpdateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({ id: 'event-timeout-shadow-promoted-1' }),
      data: expect.objectContaining({
        status: 'FAILED',
        errorMessage: expect.stringMatching(
          new RegExp(`^${WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINE_PREFIX}:`),
        ),
        nextEnqueueAt: null,
        timeoutQuarantineExpiresAt: null,
      }),
    });
  });

  it('heartbeats a timeout quarantine with an exact marker and deadline CAS', async () => {
    const previousDeadline = new Date(Date.now() + 30_000);
    const pendingErrorMessage = `${WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINE_PREFIX}:nonce-heartbeat: pending`;
    const webhookEventUpdateMany = jest.fn().mockResolvedValue({ count: 1 });
    const prisma: {
      webhookEvent: { updateMany: jest.Mock };
      $transaction?: jest.Mock;
    } = {
      webhookEvent: { updateMany: webhookEventUpdateMany },
    };
    prisma.$transaction = jest.fn(async (operation) => operation(prisma));
    const service = new WebhookCanonicalExecutionService(prisma as never);
    const context = {
      webhookEvent: { id: 'event-timeout-heartbeat-1' } as never,
      update: createUpdate(),
      activeBotId: 'bot-1',
      businessLeaseToken: null,
    };

    const refreshed = await service.refreshTimedOutExecutionQuarantine(context, {
      errorMessage: pendingErrorMessage,
      deadlineAt: previousDeadline,
    });

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(webhookEventUpdateMany).toHaveBeenCalledWith({
      where: {
        id: 'event-timeout-heartbeat-1',
        status: 'FAILED',
        errorMessage: pendingErrorMessage,
        nextEnqueueAt: null,
        timeoutQuarantineExpiresAt: previousDeadline,
      },
      data: {
        timeoutQuarantineExpiresAt: expect.any(Date),
      },
    });
    expect(refreshed?.errorMessage).toBe(pendingErrorMessage);
    expect(refreshed!.deadlineAt.getTime()).toBeGreaterThan(previousDeadline.getTime());
  });

  it('stops a timeout heartbeat without awaiting a hung Prisma refresh', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-08-15T12:00:00.000Z'));
    const pendingErrorMessage = `${WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINE_PREFIX}:nonce-hung-refresh: pending`;
    const initialLease = {
      errorMessage: pendingErrorMessage,
      deadlineAt: new Date(Date.now() + 30_000),
    };
    const refreshGate = createDeferred<{ count: number }>();
    const webhookEventUpdateMany = jest.fn().mockReturnValue(refreshGate.promise);
    const service = new WebhookCanonicalExecutionService({
      webhookEvent: { updateMany: webhookEventUpdateMany },
    } as never);
    const refresh = jest.spyOn(service, 'refreshTimedOutExecutionQuarantine');
    const heartbeat = service.startTimedOutExecutionHeartbeat(
      {
        webhookEvent: { id: 'event-timeout-hung-refresh-1' } as never,
        update: createUpdate(),
        activeBotId: 'bot-1',
        businessLeaseToken: null,
      },
      initialLease,
    );

    try {
      await jest.advanceTimersByTimeAsync(WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINE_HEARTBEAT_MS);
      expect(webhookEventUpdateMany).toHaveBeenCalledTimes(1);
      await expect(heartbeat.stop()).resolves.toEqual(initialLease);
    } finally {
      refreshGate.resolve({ count: 0 });
      const refreshResult = refresh.mock.results[0];
      if (refreshResult?.type === 'return') {
        await refreshResult.value;
      }
      await Promise.resolve();
      refresh.mockRestore();
      jest.useRealTimers();
    }
  });

  it('keeps the hard settlement watchdog after heartbeat CAS loss', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-08-15T12:00:00.000Z'));
    const service = new ModerationService(
      {} as never,
      { detect: jest.fn() } as never,
      { resolveAction: jest.fn() } as never,
      {} as never,
    );
    const canonicalExecutionService = (service as any).webhookCanonicalExecutionService;
    const refresh = jest
      .spyOn(canonicalExecutionService, 'refreshTimedOutExecutionQuarantine')
      .mockResolvedValue(null);
    const detachedTask = createDeferred<void>();
    const settlementStarted = createDeferred<void>();
    const persistSettlement = jest
      .spyOn(service as any, 'persistWebhookTimeoutSettlementWithRetry')
      .mockImplementation(async () => {
        settlementStarted.resolve();
        return null;
      });
    const processExit = jest.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const settlementWatchdog = (service as any).startWebhookTimeoutSettlementWatchdog(
      'event-timeout-heartbeat-cas-lost-1',
    );

    try {
      (service as any).observeTimedOutWebhookExecution({
        execution: {
          webhookEvent: { id: 'event-timeout-heartbeat-cas-lost-1' },
          update: createUpdate(),
          activeBotId: null,
          businessLeaseToken: null,
        },
        detachedTask: detachedTask.promise,
        quarantineLease: {
          errorMessage: `${WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINE_PREFIX}:nonce-cas-lost: pending`,
          deadlineAt: new Date(Date.now() + 30_000),
        },
        commercialOcrPendingActivations: [],
        settlementWatchdog,
      });

      await jest.advanceTimersByTimeAsync(WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINE_HEARTBEAT_MS);
      expect(refresh).toHaveBeenCalledTimes(1);
      expect(processExit).not.toHaveBeenCalled();

      await jest.advanceTimersByTimeAsync(
        WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINE_MAX_LIFETIME_MS -
          WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINE_HEARTBEAT_MS,
      );
      expect(processExit).toHaveBeenCalledWith(1);
    } finally {
      detachedTask.resolve();
      await settlementStarted.promise;
      await Promise.resolve();
      settlementWatchdog.stop();
      persistSettlement.mockRestore();
      refresh.mockRestore();
      processExit.mockRestore();
      jest.useRealTimers();
    }
  });

  it('fires the hard settlement watchdog while a Prisma settlement promise is hung', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-08-15T12:00:00.000Z'));
    const service = new ModerationService(
      {} as never,
      { detect: jest.fn() } as never,
      { resolveAction: jest.fn() } as never,
      {} as never,
    );
    const processExit = jest.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const settlementWatchdog = (service as any).startWebhookTimeoutSettlementWatchdog(
      'event-timeout-hung-settlement-1',
    );
    const prismaSettlement = createDeferred<boolean>();
    const hungPrismaSettlement = jest.fn().mockReturnValue(prismaSettlement.promise);
    let settlementOperation: Promise<unknown> | null = null;

    try {
      settlementOperation = (service as any).persistWebhookTimeoutSettlementWithRetry({
        webhookEventId: 'event-timeout-hung-settlement-1',
        outcome: 'completed',
        settlementWatchdog,
        persist: hungPrismaSettlement,
        isDurable: (settled: boolean) => settled,
        logMessage: 'hung settlement test',
      });
      await Promise.resolve();
      expect(hungPrismaSettlement).toHaveBeenCalledTimes(1);

      await jest.advanceTimersByTimeAsync(WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINE_MAX_LIFETIME_MS);
      expect(processExit).toHaveBeenCalledWith(1);
    } finally {
      prismaSettlement.resolve(true);
      await settlementOperation;
      settlementWatchdog.stop();
      processExit.mockRestore();
      jest.useRealTimers();
    }
  });

  it('does not complete detached work after its timeout quarantine CAS is lost', async () => {
    const executionClaimUpdateMany = jest.fn().mockResolvedValue({ count: 1 });
    const prisma = {
      webhookEvent: {
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
      webhookExecutionClaim: {
        updateMany: executionClaimUpdateMany,
      },
    };
    const service = new WebhookCanonicalExecutionService(prisma as never);

    await expect(
      service.completeTimedOutExecution(
        {
          webhookEvent: { id: 'event-timeout-cas-lost-1' } as never,
          update: createUpdate(),
          activeBotId: 'bot-1',
          businessLeaseToken: null,
        },
        {
          errorMessage: `${WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINE_PREFIX}:nonce-lost: pending`,
          deadlineAt: new Date(Date.now() - 1_000),
        },
      ),
    ).resolves.toBe('retry');
    expect(executionClaimUpdateMany).not.toHaveBeenCalled();
  });

  it('promotes an exact shadow claim when completing a timeout quarantine', async () => {
    const webhookEventUpdateMany = jest.fn().mockResolvedValue({ count: 1 });
    const executionClaimUpdateMany = jest.fn().mockResolvedValue({ count: 1 });
    const prisma: {
      webhookEvent: { updateMany: jest.Mock };
      webhookExecutionClaim: { updateMany: jest.Mock };
      $transaction?: jest.Mock;
    } = {
      webhookEvent: { updateMany: webhookEventUpdateMany },
      webhookExecutionClaim: { updateMany: executionClaimUpdateMany },
    };
    prisma.$transaction = jest.fn(async (operation) => operation(prisma));
    const service = new WebhookCanonicalExecutionService(prisma as never);

    await expect(
      service.completeTimedOutExecution(
        {
          webhookEvent: { id: 'event-timeout-shadow-completion-1' } as never,
          update: createUpdate(),
          activeBotId: 'bot-1',
          businessLeaseToken: null,
        },
        {
          errorMessage: `${WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINE_PREFIX}:nonce-shadow-completion: pending`,
          deadlineAt: new Date(Date.now() + 30_000),
        },
      ),
    ).resolves.toBe('settled');

    expect(executionClaimUpdateMany).toHaveBeenCalledWith({
      where: {
        webhookEventId: 'event-timeout-shadow-completion-1',
        kind: 'EXECUTION',
        enforced: false,
        status: 'READY',
        leaseToken: null,
        leaseExpiresAt: null,
      },
      data: {
        enforced: true,
        status: 'COMPLETED',
        completedAt: expect.any(Date),
        leaseToken: null,
        leaseExpiresAt: null,
      },
    });
  });

  it('retains a durable timeout fence after an exact shadow claim CAS miss', async () => {
    const pendingErrorMessage = `${WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINE_PREFIX}:nonce-shadow-foreign: pending`;
    const webhookEventUpdateMany = jest.fn().mockResolvedValue({ count: 1 });
    const executionClaimUpdateMany = jest.fn().mockResolvedValue({ count: 0 });
    const prisma: {
      webhookEvent: { updateMany: jest.Mock };
      webhookExecutionClaim: { updateMany: jest.Mock };
      $transaction?: jest.Mock;
    } = {
      webhookEvent: { updateMany: webhookEventUpdateMany },
      webhookExecutionClaim: { updateMany: executionClaimUpdateMany },
    };
    prisma.$transaction = jest.fn(async (operation) => operation(prisma));
    const service = new WebhookCanonicalExecutionService(prisma as never);

    await expect(
      service.completeTimedOutExecution(
        {
          webhookEvent: { id: 'event-timeout-shadow-foreign-lease-1' } as never,
          update: createUpdate(),
          activeBotId: 'bot-1',
          businessLeaseToken: null,
        },
        {
          errorMessage: pendingErrorMessage,
          deadlineAt: new Date(Date.now() + 30_000),
        },
      ),
    ).resolves.toBe('quarantined');

    expect(executionClaimUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          webhookEventId: 'event-timeout-shadow-foreign-lease-1',
          kind: 'EXECUTION',
          enforced: false,
          status: 'READY',
          leaseToken: null,
          leaseExpiresAt: null,
        },
      }),
    );
    expect(webhookEventUpdateMany).toHaveBeenLastCalledWith({
      where: {
        id: 'event-timeout-shadow-foreign-lease-1',
        status: 'PROCESSED',
        processedAt: expect.any(Date),
        errorMessage: null,
        nextEnqueueAt: null,
        timeoutQuarantineExpiresAt: null,
      },
      data: {
        status: 'FAILED',
        processedAt: null,
        errorMessage: pendingErrorMessage,
        nextEnqueueAt: null,
        timeoutQuarantineExpiresAt: null,
      },
    });
  });

  it('converges a timed-out shadow mirror on its completed semantic owner', async () => {
    const update = createUpdate();
    const semanticKey = buildWebhookSemanticEventKey(update);
    if (!semanticKey) {
      throw new Error('Expected the test webhook to have a semantic key');
    }
    const ownerPreparedAt = new Date('2026-08-15T12:00:00.000Z');
    const ownerCompletedAt = new Date('2026-08-15T12:00:01.000Z');
    const ownerProcessedAt = new Date('2026-08-15T12:00:01.100Z');
    const webhookEventUpdateMany = jest
      .fn()
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 1 });
    const executionClaimUpdateMany = jest
      .fn()
      .mockResolvedValueOnce({ count: 0 })
      .mockResolvedValueOnce({ count: 1 });
    const prisma: {
      webhookEvent: { findUnique: jest.Mock; updateMany: jest.Mock };
      webhookExecutionClaim: { findUnique: jest.Mock; updateMany: jest.Mock };
      $transaction?: jest.Mock;
    } = {
      webhookEvent: {
        findUnique: jest
          .fn()
          .mockResolvedValueOnce({
            id: 'event-timeout-shadow-mirror-1',
            status: 'PROCESSED',
            normalizedPayload: update,
            errorMessage: null,
            processedAt: ownerProcessedAt,
            nextEnqueueAt: null,
            timeoutQuarantineExpiresAt: null,
          })
          .mockResolvedValue({
            id: 'event-timeout-shadow-owner-1',
            status: 'PROCESSED',
            normalizedPayload: update,
            errorMessage: null,
            processedAt: ownerProcessedAt,
            nextEnqueueAt: null,
            timeoutQuarantineExpiresAt: null,
          }),
        updateMany: webhookEventUpdateMany,
      },
      webhookExecutionClaim: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'claim-timeout-shadow-owner-1',
          semanticKey,
          webhookEventId: 'event-timeout-shadow-owner-1',
          executionBotId: 'bot-1',
          enforced: false,
          status: 'COMPLETED',
          preparedAt: ownerPreparedAt,
          completedAt: ownerCompletedAt,
          leaseToken: null,
          leaseExpiresAt: null,
        }),
        updateMany: executionClaimUpdateMany,
      },
    };
    prisma.$transaction = jest.fn(async (operation) => operation(prisma));
    const service = new WebhookCanonicalExecutionService(prisma as never);

    await expect(
      service.completeTimedOutExecution(
        {
          webhookEvent: { id: 'event-timeout-shadow-mirror-1' } as never,
          update,
          activeBotId: 'bot-1',
          businessLeaseToken: null,
        },
        {
          errorMessage: `${WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINE_PREFIX}:nonce-shadow-mirror: pending`,
          deadlineAt: new Date('2026-08-15T12:05:00.000Z'),
        },
      ),
    ).resolves.toBe('duplicate');

    expect(executionClaimUpdateMany).toHaveBeenNthCalledWith(2, {
      where: {
        id: 'claim-timeout-shadow-owner-1',
        kind: 'EXECUTION',
        semanticKey,
        webhookEventId: 'event-timeout-shadow-owner-1',
        enforced: false,
        status: 'COMPLETED',
        preparedAt: ownerPreparedAt,
        completedAt: ownerCompletedAt,
        leaseToken: null,
        leaseExpiresAt: null,
      },
      data: {
        enforced: true,
        status: 'COMPLETED',
        completedAt: ownerCompletedAt,
        leaseToken: null,
        leaseExpiresAt: null,
      },
    });
    expect(webhookEventUpdateMany).toHaveBeenLastCalledWith({
      where: {
        id: 'event-timeout-shadow-mirror-1',
        status: 'PROCESSED',
        processedAt: expect.any(Date),
        errorMessage: null,
        nextEnqueueAt: null,
        timeoutQuarantineExpiresAt: null,
        normalizedPayload: { equals: update },
      },
      data: {
        status: 'DUPLICATE',
        processedAt: ownerCompletedAt,
        errorMessage: null,
        queueName: null,
        nextEnqueueAt: null,
        timeoutQuarantineExpiresAt: null,
      },
    });
  });

  it('converges multiple timed-out mirrors after the semantic owner is already enforced', async () => {
    const update = createUpdate();
    const semanticKey = buildWebhookSemanticEventKey(update);
    if (!semanticKey) {
      throw new Error('Expected the test webhook to have a semantic key');
    }
    const ownerPreparedAt = new Date('2026-08-15T12:00:00.000Z');
    const ownerCompletedAt = new Date('2026-08-15T12:00:01.000Z');
    const ownerProcessedAt = new Date('2026-08-15T12:00:01.100Z');
    let ownerEnforced = false;
    const webhookEventUpdateMany = jest.fn().mockResolvedValue({ count: 1 });
    const executionClaimUpdateMany = jest.fn().mockImplementation(async ({ where }) => {
      if (!where.id) {
        return { count: 0 };
      }
      if (where.enforced !== ownerEnforced) {
        return { count: 0 };
      }
      ownerEnforced = true;
      return { count: 1 };
    });
    const prisma: {
      webhookEvent: { findUnique: jest.Mock; updateMany: jest.Mock };
      webhookExecutionClaim: { findUnique: jest.Mock; updateMany: jest.Mock };
      $transaction?: jest.Mock;
    } = {
      webhookEvent: {
        findUnique: jest.fn().mockImplementation(async ({ where }) => ({
          id: where.id,
          status: 'PROCESSED',
          normalizedPayload: update,
          errorMessage: null,
          processedAt: ownerProcessedAt,
          nextEnqueueAt: null,
          timeoutQuarantineExpiresAt: null,
        })),
        updateMany: webhookEventUpdateMany,
      },
      webhookExecutionClaim: {
        findUnique: jest.fn().mockImplementation(async () => ({
          id: 'claim-timeout-shadow-owner-multiple-1',
          semanticKey,
          webhookEventId: 'event-timeout-shadow-owner-multiple-1',
          executionBotId: 'bot-1',
          enforced: ownerEnforced,
          status: 'COMPLETED',
          preparedAt: ownerPreparedAt,
          completedAt: ownerCompletedAt,
          leaseToken: null,
          leaseExpiresAt: null,
        })),
        updateMany: executionClaimUpdateMany,
      },
    };
    prisma.$transaction = jest.fn(async (operation) => operation(prisma));
    const service = new WebhookCanonicalExecutionService(prisma as never);

    for (const mirrorId of [
      'event-timeout-shadow-mirror-multiple-1',
      'event-timeout-shadow-mirror-multiple-2',
    ]) {
      await expect(
        service.completeTimedOutExecution(
          {
            webhookEvent: { id: mirrorId } as never,
            update,
            activeBotId: 'bot-1',
            businessLeaseToken: null,
          },
          {
            errorMessage: `${WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINE_PREFIX}:nonce-${mirrorId}: pending`,
            deadlineAt: new Date('2026-08-15T12:05:00.000Z'),
          },
        ),
      ).resolves.toBe('duplicate');
    }

    const promotionCalls = executionClaimUpdateMany.mock.calls.filter(
      ([args]) => args.where.id === 'claim-timeout-shadow-owner-multiple-1',
    );
    expect(promotionCalls).toHaveLength(2);
    expect(promotionCalls[0]?.[0].where.enforced).toBe(false);
    expect(promotionCalls[1]?.[0].where.enforced).toBe(true);
  });

  it.each(['PENDING', 'READY'] as const)(
    'retries a timed-out mirror while its semantic owner claim is %s',
    async (ownerClaimStatus) => {
      const update = createUpdate();
      const semanticKey = buildWebhookSemanticEventKey(update);
      if (!semanticKey) {
        throw new Error('Expected the test webhook to have a semantic key');
      }
      const webhookEventUpdateMany = jest
        .fn()
        .mockResolvedValueOnce({ count: 1 })
        .mockResolvedValueOnce({ count: 0 });
      const prisma: {
        webhookEvent: { findUnique: jest.Mock; updateMany: jest.Mock };
        webhookExecutionClaim: { findUnique: jest.Mock; updateMany: jest.Mock };
        $transaction?: jest.Mock;
      } = {
        webhookEvent: {
          findUnique: jest.fn().mockResolvedValue({
            id: 'event-timeout-shadow-transitional-1',
            status: 'PROCESSED',
            normalizedPayload: update,
            errorMessage: null,
            processedAt: new Date('2026-08-15T12:00:01.000Z'),
            nextEnqueueAt: null,
            timeoutQuarantineExpiresAt: null,
          }),
          updateMany: webhookEventUpdateMany,
        },
        webhookExecutionClaim: {
          findUnique: jest.fn().mockResolvedValue({
            id: 'claim-timeout-shadow-transitional-owner-1',
            semanticKey,
            webhookEventId: 'event-timeout-shadow-transitional-owner-1',
            executionBotId: 'bot-1',
            enforced: ownerClaimStatus === 'READY',
            status: ownerClaimStatus,
            preparedAt: ownerClaimStatus === 'READY' ? new Date('2026-08-15T12:00:00.000Z') : null,
            completedAt: null,
            leaseToken: ownerClaimStatus === 'READY' ? 'owner-lease' : null,
            leaseExpiresAt:
              ownerClaimStatus === 'READY' ? new Date('2026-08-15T12:05:00.000Z') : null,
          }),
          updateMany: jest.fn().mockResolvedValue({ count: 0 }),
        },
      };
      prisma.$transaction = jest.fn(async (operation) => operation(prisma));
      const service = new WebhookCanonicalExecutionService(prisma as never);

      await expect(
        service.completeTimedOutExecution(
          {
            webhookEvent: { id: 'event-timeout-shadow-transitional-1' } as never,
            update,
            activeBotId: 'bot-1',
            businessLeaseToken: null,
          },
          {
            errorMessage: `${WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINE_PREFIX}:nonce-transitional: pending`,
            deadlineAt: new Date('2026-08-15T12:05:00.000Z'),
          },
        ),
      ).resolves.toBe('retry');

      expect(webhookEventUpdateMany).toHaveBeenCalledTimes(1);
    },
  );

  it('retries a timed-out mirror until its completed owner event becomes processed', async () => {
    const update = createUpdate();
    const semanticKey = buildWebhookSemanticEventKey(update);
    if (!semanticKey) {
      throw new Error('Expected the test webhook to have a semantic key');
    }
    const ownerPreparedAt = new Date('2026-08-15T12:00:00.000Z');
    const ownerCompletedAt = new Date('2026-08-15T12:00:01.000Z');
    let ownerReadCount = 0;
    const webhookEventUpdateMany = jest.fn().mockResolvedValue({ count: 1 });
    const executionClaimUpdateMany = jest.fn().mockImplementation(async ({ where }) => ({
      count: where.id ? 1 : 0,
    }));
    const prisma: {
      webhookEvent: { findUnique: jest.Mock; updateMany: jest.Mock };
      webhookExecutionClaim: { findUnique: jest.Mock; updateMany: jest.Mock };
      $transaction?: jest.Mock;
    } = {
      webhookEvent: {
        findUnique: jest.fn().mockImplementation(async ({ where }) => {
          if (where.id === 'event-timeout-shadow-owner-later-1') {
            ownerReadCount += 1;
            return {
              id: where.id,
              status: ownerReadCount === 1 ? 'QUEUED' : 'PROCESSED',
              normalizedPayload: update,
              errorMessage: null,
              processedAt: ownerReadCount === 1 ? null : ownerCompletedAt,
              nextEnqueueAt: null,
              timeoutQuarantineExpiresAt: null,
            };
          }
          return {
            id: where.id,
            status: 'PROCESSED',
            normalizedPayload: update,
            errorMessage: null,
            processedAt: ownerCompletedAt,
            nextEnqueueAt: null,
            timeoutQuarantineExpiresAt: null,
          };
        }),
        updateMany: webhookEventUpdateMany,
      },
      webhookExecutionClaim: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'claim-timeout-shadow-owner-later-1',
          semanticKey,
          webhookEventId: 'event-timeout-shadow-owner-later-1',
          executionBotId: 'bot-1',
          enforced: true,
          status: 'COMPLETED',
          preparedAt: ownerPreparedAt,
          completedAt: ownerCompletedAt,
          leaseToken: null,
          leaseExpiresAt: null,
        }),
        updateMany: executionClaimUpdateMany,
      },
    };
    prisma.$transaction = jest.fn(async (operation) => operation(prisma));
    const service = new WebhookCanonicalExecutionService(prisma as never);
    const context = {
      webhookEvent: { id: 'event-timeout-shadow-owner-later-mirror-1' } as never,
      update,
      activeBotId: 'bot-1',
      businessLeaseToken: null,
    };
    const lease = {
      errorMessage: `${WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINE_PREFIX}:nonce-owner-later: pending`,
      deadlineAt: new Date('2026-08-15T12:05:00.000Z'),
    };

    await expect(service.completeTimedOutExecution(context, lease)).resolves.toBe('retry');
    await expect(service.completeTimedOutExecution(context, lease)).resolves.toBe('duplicate');
  });

  it('retries convergence when the completed owner changes before its CAS fence', async () => {
    const update = createUpdate();
    const semanticKey = buildWebhookSemanticEventKey(update);
    if (!semanticKey) {
      throw new Error('Expected the test webhook to have a semantic key');
    }
    const completedAt = new Date('2026-08-15T12:00:01.000Z');
    const webhookEventUpdateMany = jest
      .fn()
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 });
    const prisma: {
      webhookEvent: { findUnique: jest.Mock; updateMany: jest.Mock };
      webhookExecutionClaim: { findUnique: jest.Mock; updateMany: jest.Mock };
      $transaction?: jest.Mock;
    } = {
      webhookEvent: {
        findUnique: jest
          .fn()
          .mockResolvedValueOnce({
            id: 'event-timeout-shadow-owner-cas-mirror-1',
            status: 'PROCESSED',
            normalizedPayload: update,
            errorMessage: null,
            processedAt: completedAt,
            nextEnqueueAt: null,
            timeoutQuarantineExpiresAt: null,
          })
          .mockResolvedValueOnce({
            id: 'event-timeout-shadow-owner-cas-1',
            status: 'PROCESSED',
            normalizedPayload: update,
            errorMessage: null,
            processedAt: completedAt,
            nextEnqueueAt: null,
            timeoutQuarantineExpiresAt: null,
          }),
        updateMany: webhookEventUpdateMany,
      },
      webhookExecutionClaim: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'claim-timeout-shadow-owner-cas-1',
          semanticKey,
          webhookEventId: 'event-timeout-shadow-owner-cas-1',
          executionBotId: 'bot-1',
          enforced: true,
          status: 'COMPLETED',
          preparedAt: new Date('2026-08-15T12:00:00.000Z'),
          completedAt,
          leaseToken: null,
          leaseExpiresAt: null,
        }),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
    };
    prisma.$transaction = jest.fn(async (operation) => operation(prisma));
    const service = new WebhookCanonicalExecutionService(prisma as never);

    await expect(
      service.completeTimedOutExecution(
        {
          webhookEvent: { id: 'event-timeout-shadow-owner-cas-mirror-1' } as never,
          update,
          activeBotId: 'bot-1',
          businessLeaseToken: null,
        },
        {
          errorMessage: `${WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINE_PREFIX}:nonce-owner-cas: pending`,
          deadlineAt: new Date('2026-08-15T12:05:00.000Z'),
        },
      ),
    ).resolves.toBe('retry');

    expect(webhookEventUpdateMany).toHaveBeenCalledTimes(2);
    expect(webhookEventUpdateMany).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'FAILED' }) }),
    );
  });

  it.each([
    { caseName: 'the foreign claim was never prepared', preparedAt: null, corruptOwner: false },
    {
      caseName: 'the owner payload no longer derives the claimed semantic key',
      preparedAt: new Date('2026-08-15T12:00:00.000Z'),
      corruptOwner: true,
    },
  ])('retains the timeout fence when $caseName', async ({ preparedAt, corruptOwner }) => {
    const update = createUpdate();
    const semanticKey = buildWebhookSemanticEventKey(update);
    if (!semanticKey) {
      throw new Error('Expected the test webhook to have a semantic key');
    }
    const ownerPayload = corruptOwner
      ? {
          ...update,
          message: {
            ...update.message,
            messageId: 'different-owner-message',
          },
        }
      : update;
    if (corruptOwner && buildWebhookSemanticEventKey(ownerPayload) === semanticKey) {
      throw new Error('Expected the corrupted owner payload to derive a different semantic key');
    }
    const completedAt = new Date('2026-08-15T12:00:01.000Z');
    const pendingErrorMessage = `${WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINE_PREFIX}:nonce-shadow-invalid-owner: pending`;
    const webhookEventUpdateMany = jest
      .fn()
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 1 });
    const executionClaimUpdateMany = jest.fn().mockResolvedValueOnce({ count: 0 });
    const prisma: {
      webhookEvent: { findUnique: jest.Mock; updateMany: jest.Mock };
      webhookExecutionClaim: { findUnique: jest.Mock; updateMany: jest.Mock };
      $transaction?: jest.Mock;
    } = {
      webhookEvent: {
        findUnique: jest
          .fn()
          .mockResolvedValueOnce({
            id: 'event-timeout-shadow-invalid-mirror-1',
            status: 'PROCESSED',
            normalizedPayload: update,
            errorMessage: null,
            processedAt: completedAt,
            nextEnqueueAt: null,
            timeoutQuarantineExpiresAt: null,
          })
          .mockResolvedValue({
            id: 'event-timeout-shadow-invalid-owner-1',
            status: 'PROCESSED',
            normalizedPayload: ownerPayload,
            errorMessage: null,
            processedAt: completedAt,
            nextEnqueueAt: null,
            timeoutQuarantineExpiresAt: null,
          }),
        updateMany: webhookEventUpdateMany,
      },
      webhookExecutionClaim: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'claim-timeout-shadow-invalid-owner-1',
          semanticKey,
          webhookEventId: 'event-timeout-shadow-invalid-owner-1',
          enforced: false,
          status: 'COMPLETED',
          preparedAt,
          completedAt,
          leaseToken: null,
          leaseExpiresAt: null,
        }),
        updateMany: executionClaimUpdateMany,
      },
    };
    prisma.$transaction = jest.fn(async (operation) => operation(prisma));
    const service = new WebhookCanonicalExecutionService(prisma as never);

    await expect(
      service.completeTimedOutExecution(
        {
          webhookEvent: { id: 'event-timeout-shadow-invalid-mirror-1' } as never,
          update,
          activeBotId: 'bot-1',
          businessLeaseToken: null,
        },
        {
          errorMessage: pendingErrorMessage,
          deadlineAt: new Date('2026-08-15T12:05:00.000Z'),
        },
      ),
    ).resolves.toBe('quarantined');

    expect(executionClaimUpdateMany).toHaveBeenCalledTimes(1);
    expect(webhookEventUpdateMany).toHaveBeenLastCalledWith({
      where: expect.objectContaining({
        id: 'event-timeout-shadow-invalid-mirror-1',
        status: 'PROCESSED',
      }),
      data: {
        status: 'FAILED',
        processedAt: null,
        errorMessage: pendingErrorMessage,
        nextEnqueueAt: null,
        timeoutQuarantineExpiresAt: null,
      },
    });
  });

  it('promotes an exact shadow claim when failing a timeout quarantine', async () => {
    const webhookEventUpdateMany = jest.fn().mockResolvedValue({ count: 1 });
    const executionClaimUpdateMany = jest.fn().mockResolvedValue({ count: 1 });
    const prisma: {
      webhookEvent: { updateMany: jest.Mock };
      webhookExecutionClaim: { updateMany: jest.Mock };
      $transaction?: jest.Mock;
    } = {
      webhookEvent: { updateMany: webhookEventUpdateMany },
      webhookExecutionClaim: { updateMany: executionClaimUpdateMany },
    };
    prisma.$transaction = jest.fn(async (operation) => operation(prisma));
    const service = new WebhookCanonicalExecutionService(prisma as never);

    await expect(
      service.failTimedOutExecution(
        {
          webhookEvent: { id: 'event-timeout-shadow-failure-1' } as never,
          update: createUpdate(),
          activeBotId: 'bot-1',
          businessLeaseToken: null,
        },
        {
          errorMessage: `${WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINE_PREFIX}:nonce-shadow-failure: pending`,
          deadlineAt: new Date(Date.now() + 30_000),
        },
        { errorMessage: 'detached shadow execution failed' },
      ),
    ).resolves.toBe('settled');

    expect(executionClaimUpdateMany).toHaveBeenCalledWith({
      where: {
        webhookEventId: 'event-timeout-shadow-failure-1',
        kind: 'EXECUTION',
        enforced: false,
        status: 'READY',
        leaseToken: null,
        leaseExpiresAt: null,
      },
      data: {
        enforced: true,
        status: 'READY',
        completedAt: null,
        leaseToken: null,
        leaseExpiresAt: null,
      },
    });
  });

  it.each(['completed', 'failed'] as const)(
    'recognizes an already committed durable timeout fence after detached work %s',
    async (outcome) => {
      const webhookEventId = `event-timeout-fence-retry-${outcome}-1`;
      const pendingErrorMessage = `${WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINE_PREFIX}:nonce-fence-retry-${outcome}: pending`;
      const webhookEventUpdateMany = jest
        .fn()
        .mockResolvedValueOnce({ count: 0 })
        .mockResolvedValueOnce({ count: 0 })
        .mockResolvedValueOnce({ count: 1 });
      const executionClaimUpdateMany = jest.fn();
      const prisma: {
        webhookEvent: { updateMany: jest.Mock };
        webhookExecutionClaim: { updateMany: jest.Mock };
        $transaction?: jest.Mock;
      } = {
        webhookEvent: { updateMany: webhookEventUpdateMany },
        webhookExecutionClaim: { updateMany: executionClaimUpdateMany },
      };
      prisma.$transaction = jest.fn(async (operation) => operation(prisma));
      const service = new WebhookCanonicalExecutionService(prisma as never);
      const context = {
        webhookEvent: { id: webhookEventId } as never,
        update: createUpdate(),
        activeBotId: 'bot-1',
        businessLeaseToken: null,
      };
      const lease = {
        errorMessage: pendingErrorMessage,
        deadlineAt: new Date(Date.now() - 30_000),
      };

      const settlement =
        outcome === 'completed'
          ? service.completeTimedOutExecution(context, lease)
          : service.failTimedOutExecution(context, lease, {
              errorMessage: 'detached execution failed',
            });

      await expect(settlement).resolves.toBe('quarantined');
      expect(webhookEventUpdateMany).toHaveBeenNthCalledWith(3, {
        where: {
          id: webhookEventId,
          status: 'FAILED',
          processedAt: null,
          errorMessage: pendingErrorMessage,
          nextEnqueueAt: null,
          timeoutQuarantineExpiresAt: null,
        },
        data: {
          status: 'FAILED',
          processedAt: null,
          errorMessage: pendingErrorMessage,
          nextEnqueueAt: null,
          timeoutQuarantineExpiresAt: null,
        },
      });
      expect(executionClaimUpdateMany).not.toHaveBeenCalled();
    },
  );

  it.each(['completed', 'failed'] as const)(
    'recognizes an already committed shadow-mirror duplicate after detached work %s',
    async (outcome) => {
      const webhookEventId = `event-timeout-duplicate-retry-${outcome}-1`;
      const webhookEventUpdateMany = jest
        .fn()
        .mockResolvedValueOnce({ count: 0 })
        .mockResolvedValueOnce({ count: 1 });
      const prisma: {
        webhookEvent: { updateMany: jest.Mock };
        webhookExecutionClaim: { updateMany: jest.Mock };
        $transaction?: jest.Mock;
      } = {
        webhookEvent: { updateMany: webhookEventUpdateMany },
        webhookExecutionClaim: { updateMany: jest.fn() },
      };
      prisma.$transaction = jest.fn(async (operation) => operation(prisma));
      const service = new WebhookCanonicalExecutionService(prisma as never);
      const context = {
        webhookEvent: { id: webhookEventId } as never,
        update: createUpdate(),
        activeBotId: 'bot-1',
        businessLeaseToken: null,
      };
      const lease = {
        errorMessage: `${WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINE_PREFIX}:nonce-duplicate-retry: pending`,
        deadlineAt: new Date(Date.now() - 30_000),
      };

      const settlement =
        outcome === 'completed'
          ? service.completeTimedOutExecution(context, lease)
          : service.failTimedOutExecution(context, lease, {
              errorMessage: 'detached execution failed',
            });

      await expect(settlement).resolves.toBe('duplicate');
      expect(webhookEventUpdateMany).toHaveBeenNthCalledWith(2, {
        where: {
          id: webhookEventId,
          status: 'DUPLICATE',
          processedAt: { not: null },
          errorMessage: null,
          queueName: null,
          nextEnqueueAt: null,
          timeoutQuarantineExpiresAt: null,
        },
        data: {
          status: 'DUPLICATE',
          errorMessage: null,
          queueName: null,
          nextEnqueueAt: null,
          timeoutQuarantineExpiresAt: null,
        },
      });
      expect(prisma.webhookExecutionClaim.updateMany).not.toHaveBeenCalled();
    },
  );

  it('recognizes an already committed timeout completion on persistence retry', async () => {
    const webhookEventUpdateMany = jest
      .fn()
      .mockResolvedValueOnce({ count: 0 })
      .mockResolvedValueOnce({ count: 0 })
      .mockResolvedValueOnce({ count: 0 })
      .mockResolvedValueOnce({ count: 1 });
    const executionClaimUpdateMany = jest.fn().mockResolvedValue({ count: 1 });
    const prisma: {
      webhookEvent: { updateMany: jest.Mock };
      webhookExecutionClaim: { updateMany: jest.Mock };
      $transaction?: jest.Mock;
    } = {
      webhookEvent: { updateMany: webhookEventUpdateMany },
      webhookExecutionClaim: { updateMany: executionClaimUpdateMany },
    };
    prisma.$transaction = jest.fn(async (operation) => operation(prisma));
    const service = new WebhookCanonicalExecutionService(prisma as never);

    await expect(
      service.completeTimedOutExecution(
        {
          webhookEvent: { id: 'event-timeout-completion-retry-1' } as never,
          update: createUpdate(),
          activeBotId: 'bot-1',
          businessLeaseToken: 'lease-token-before-ambiguous-commit',
        },
        {
          errorMessage: `${WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINE_PREFIX}:nonce-completion-retry: pending`,
          deadlineAt: new Date(Date.now() - 30_000),
        },
      ),
    ).resolves.toBe('settled');

    expect(webhookEventUpdateMany).toHaveBeenNthCalledWith(4, {
      where: {
        id: 'event-timeout-completion-retry-1',
        status: 'PROCESSED',
        processedAt: { not: null },
        errorMessage: null,
        nextEnqueueAt: null,
        timeoutQuarantineExpiresAt: null,
      },
      data: {
        status: 'PROCESSED',
        errorMessage: null,
        nextEnqueueAt: null,
        timeoutQuarantineExpiresAt: null,
      },
    });
    expect(executionClaimUpdateMany).toHaveBeenCalledWith({
      where: {
        webhookEventId: 'event-timeout-completion-retry-1',
        kind: 'EXECUTION',
        enforced: true,
        status: 'COMPLETED',
        completedAt: { not: null },
        leaseToken: null,
        leaseExpiresAt: null,
      },
      data: {
        enforced: true,
        status: 'COMPLETED',
        leaseToken: null,
        leaseExpiresAt: null,
      },
    });
  });

  it('recognizes an already committed timeout failure on persistence retry', async () => {
    const webhookEventUpdateMany = jest
      .fn()
      .mockResolvedValueOnce({ count: 0 })
      .mockResolvedValueOnce({ count: 0 })
      .mockResolvedValueOnce({ count: 0 })
      .mockResolvedValueOnce({ count: 1 });
    const executionClaimUpdateMany = jest.fn().mockResolvedValue({ count: 1 });
    const prisma: {
      webhookEvent: { updateMany: jest.Mock };
      webhookExecutionClaim: { updateMany: jest.Mock };
      $transaction?: jest.Mock;
    } = {
      webhookEvent: { updateMany: webhookEventUpdateMany },
      webhookExecutionClaim: { updateMany: executionClaimUpdateMany },
    };
    prisma.$transaction = jest.fn(async (operation) => operation(prisma));
    const service = new WebhookCanonicalExecutionService(prisma as never);

    await expect(
      service.failTimedOutExecution(
        {
          webhookEvent: { id: 'event-timeout-failure-retry-1' } as never,
          update: createUpdate(),
          activeBotId: 'bot-1',
          businessLeaseToken: 'lease-token-before-ambiguous-failure',
        },
        {
          errorMessage: `${WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINE_PREFIX}:nonce-failure-retry: pending`,
          deadlineAt: new Date(Date.now() - 30_000),
        },
        { errorMessage: 'detached execution failed' },
      ),
    ).resolves.toBe('settled');

    expect(webhookEventUpdateMany).toHaveBeenNthCalledWith(4, {
      where: {
        id: 'event-timeout-failure-retry-1',
        status: 'FAILED',
        errorMessage: `${WEBHOOK_HOT_PATH_TIMEOUT_TERMINAL_QUARANTINE_PREFIX}: detached execution failed`,
        nextEnqueueAt: null,
        timeoutQuarantineExpiresAt: null,
      },
      data: {
        status: 'FAILED',
        errorMessage: `${WEBHOOK_HOT_PATH_TIMEOUT_TERMINAL_QUARANTINE_PREFIX}: detached execution failed`,
        nextEnqueueAt: null,
        timeoutQuarantineExpiresAt: null,
      },
    });
    expect(executionClaimUpdateMany).toHaveBeenCalledWith({
      where: {
        webhookEventId: 'event-timeout-failure-retry-1',
        kind: 'EXECUTION',
        enforced: true,
        status: 'READY',
        completedAt: null,
        leaseToken: null,
        leaseExpiresAt: null,
      },
      data: {
        enforced: true,
        status: 'READY',
        completedAt: null,
        leaseToken: null,
        leaseExpiresAt: null,
      },
    });
  });

  it('does not mark a webhook processed after losing its canonical business lease', async () => {
    const update = createUpdate();
    const webhookUpdate = jest.fn().mockResolvedValue({ count: 1 });
    const prisma = {
      webhookEvent: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'event-canonical-lease-lost-1',
          status: 'QUEUED',
          botId: 'bot-1',
          normalizedPayload: update,
        }),
        updateMany: webhookUpdate,
      },
      webhookExecutionClaim: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'claim-canonical-lease-lost-1',
          webhookEventId: 'event-canonical-lease-lost-1',
          executionBotId: 'bot-1',
          enforced: true,
          status: 'READY',
          leaseToken: null,
          leaseExpiresAt: null,
        }),
        updateMany: jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({
          count: data.status === 'COMPLETED' ? 0 : 1,
        })),
      },
    };
    withCanonicalWebhookFixture(prisma);
    const service = new ModerationService(
      prisma as never,
      { detect: jest.fn() } as never,
      { resolveAction: jest.fn() } as never,
      {} as never,
    );
    jest.spyOn(service, 'handleUpdate').mockResolvedValue(undefined);

    await expect(service.processWebhookEvent('event-canonical-lease-lost-1')).rejects.toMatchObject(
      {
        outcome: 'authority_changed',
        phase: 'settlement',
      } satisfies Partial<WebhookFinishPersistenceError>,
    );

    expect(webhookUpdate.mock.calls.filter(([args]) => args.data.status === 'FAILED')).toHaveLength(
      0,
    );
    expect(webhookUpdate).not.toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'PROCESSED' }),
      }),
    );
  });

  it('repairs a webhook event left QUEUED after its canonical claim already completed', async () => {
    const completedAt = new Date('2026-07-11T10:00:00.000Z');
    const prisma = {
      webhookEvent: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'event-canonical-completed-1',
          status: 'QUEUED',
          botId: 'bot-1',
          normalizedPayload: createUpdate(),
        }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      webhookExecutionClaim: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'claim-canonical-completed-1',
          webhookEventId: 'event-canonical-completed-1',
          executionBotId: 'bot-1',
          enforced: true,
          status: 'COMPLETED',
          completedAt,
          leaseToken: null,
          leaseExpiresAt: null,
        }),
      },
    };
    withCanonicalWebhookFixture(prisma);
    const service = new ModerationService(
      prisma as never,
      { detect: jest.fn() } as never,
      { resolveAction: jest.fn() } as never,
      {} as never,
    );
    const handleUpdate = jest.spyOn(service, 'handleUpdate');

    await expect(
      service.processWebhookEvent('event-canonical-completed-1'),
    ).resolves.toBeUndefined();

    expect(handleUpdate).not.toHaveBeenCalled();
    expect(prisma.webhookEvent.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'event-canonical-completed-1',
        status: 'QUEUED',
        normalizedPayload: { equals: expect.any(Object) },
        errorMessage: null,
        nextEnqueueAt: null,
        timeoutQuarantineExpiresAt: null,
      },
      data: {
        status: 'PROCESSED',
        processedAt: completedAt,
        queueName: null,
        errorMessage: null,
        nextEnqueueAt: null,
      },
    });
  });

  it('does not schedule re-enqueue for terminal MAX processing errors', async () => {
    const prisma = {
      webhookEvent: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'event-1',
          botId: null,
          normalizedPayload: createUpdate(),
        }),
        update: jest.fn().mockResolvedValue(undefined),
      },
    };
    const persisted = withCanonicalWebhookFixture(prisma);
    const service = new ModerationService(
      prisma as never,
      { detect: jest.fn() } as never,
      { resolveAction: jest.fn() } as never,
      {} as never,
    );
    jest
      .spyOn(service, 'handleUpdate')
      .mockRejectedValue(
        createMaxApiError(404, 'Request failed with status code 404', 'message.not.found'),
      );

    await expect(service.processWebhookEvent('event-1')).rejects.toThrow(
      'Request failed with status code 404',
    );

    expect(persisted.webhookEvent.updateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({ id: 'event-1' }),
      data: expect.objectContaining({
        status: 'FAILED',
        errorMessage: 'Request failed with status code 404',
        nextEnqueueAt: null,
      }),
    });
  });

  it('retains a transient handler failure without scheduling a forbidden whole-handler retry', async () => {
    const prisma = {
      webhookEvent: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'event-2',
          botId: null,
          normalizedPayload: createUpdate(),
        }),
        update: jest.fn().mockResolvedValue(undefined),
      },
    };
    const persisted = withCanonicalWebhookFixture(prisma);
    const service = new ModerationService(
      prisma as never,
      { detect: jest.fn() } as never,
      { resolveAction: jest.fn() } as never,
      {} as never,
    );
    jest
      .spyOn(service, 'handleUpdate')
      .mockRejectedValue(new Error('MAX API interactive rate limit exceeded'));

    await expect(service.processWebhookEvent('event-2')).rejects.toThrow(
      'MAX API interactive rate limit exceeded',
    );

    expect(persisted.webhookEvent.updateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({ id: 'event-2' }),
      data: expect.objectContaining({
        status: 'FAILED',
        errorMessage: 'MAX API interactive rate limit exceeded',
        nextEnqueueAt: null,
        queueName: null,
      }),
    });
  });

  it('retains an ambiguous handler lock failure without restarting the already started handler', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-07-17T12:00:00.000Z'));
    const prisma = {
      webhookEvent: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'event-shared-lock-timeout-1',
          botId: null,
          normalizedPayload: createUpdate(),
        }),
        update: jest.fn().mockResolvedValue(undefined),
      },
    };
    const persisted = withCanonicalWebhookFixture(prisma);
    const service = new ModerationService(
      prisma as never,
      { detect: jest.fn() } as never,
      { resolveAction: jest.fn() } as never,
      {} as never,
    );
    const lockError = Object.assign(new Error('shared lock acquisition was ambiguous'), {
      retryAfterMs: SHARED_CHAT_EXECUTION_LOCK_AMBIGUOUS_RETRY_AFTER_MS,
      sharedChatExecutionLockRetryable: true,
    });
    jest.spyOn(service, 'handleUpdate').mockRejectedValue(lockError);

    try {
      await expect(service.processWebhookEvent('event-shared-lock-timeout-1')).rejects.toThrow(
        'shared lock acquisition was ambiguous',
      );

      expect(persisted.webhookEvent.updateMany).toHaveBeenCalledWith({
        where: expect.objectContaining({ id: 'event-shared-lock-timeout-1' }),
        data: expect.objectContaining({
          status: 'FAILED',
          errorMessage: 'shared lock acquisition was ambiguous',
          nextEnqueueAt: null,
          queueName: null,
        }),
      });
    } finally {
      jest.useRealTimers();
    }
  });

  it('does not apply arbitrary domain retryAfterMs values to webhook re-enqueue', () => {
    const service = new ModerationService(
      {} as never,
      { detect: jest.fn() } as never,
      { resolveAction: jest.fn() } as never,
      {} as never,
    );

    expect(
      (service as any).readWebhookProcessingRetryAfterMs({ retryAfterMs: 180_000 }),
    ).toBeUndefined();
  });

  it('accepts only the typed chat-rules publish-fence retry delay', () => {
    const service = new ModerationService(
      {} as never,
      { detect: jest.fn() } as never,
      { resolveAction: jest.fn() } as never,
      {} as never,
    );
    const retryError = new ChatRulesPublishFenceRetryError(12_345);

    expect((service as any).isTerminalWebhookProcessingError(retryError)).toBe(false);
    expect((service as any).readWebhookProcessingRetryAfterMs(retryError)).toBe(12_345);
    expect(
      (service as any).readWebhookProcessingRetryAfterMs({
        chatRulesPublishFenceRetryable: true,
        retryAfterMs: 12_345,
      }),
    ).toBeUndefined();
  });

  it('quarantines a hot-path timeout until detached work completes successfully', async () => {
    const update = {
      ...createUpdate(),
      message: {
        ...createUpdate().message,
        chatId: '-chat-42',
      },
    };
    let resolveHandleUpdate!: () => void;
    const handleUpdateGate = new Promise<void>((resolve) => {
      resolveHandleUpdate = resolve;
    });
    const executionClaimUpdateMany = jest.fn().mockResolvedValue({ count: 1 });
    const webhookEventUpdateMany = jest.fn().mockResolvedValue({ count: 1 });
    const prisma = {
      webhookEvent: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'event-timeout-1',
          status: 'QUEUED',
          botId: 'id613002203036_bot',
          normalizedPayload: update,
        }),
        update: jest.fn().mockResolvedValue(undefined),
        updateMany: webhookEventUpdateMany,
      },
      webhookExecutionClaim: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'claim-timeout-1',
          webhookEventId: 'event-timeout-1',
          executionBotId: 'id613002203036_bot',
          enforced: true,
          status: 'READY',
          leaseToken: null,
          leaseExpiresAt: null,
        }),
        updateMany: executionClaimUpdateMany,
      },
    };
    withCanonicalWebhookFixture(prisma);
    const service = new ModerationService(
      prisma as never,
      { detect: jest.fn() } as never,
      { resolveAction: jest.fn() } as never,
      {} as never,
    );
    const commercialOcrEnqueueService = {
      activatePendingBatch: jest.fn().mockResolvedValue(undefined),
      suppressPendingBatch: jest.fn().mockResolvedValue(undefined),
    };
    (service as any).commercialOcrEnqueueService = commercialOcrEnqueueService;
    const completeWebhookExecution = jest.spyOn(
      (service as any).webhookCanonicalExecutionService,
      'completeTimedOutExecution',
    );
    (service as any).webhookUserFacingTimeoutMs = 10;
    jest.spyOn(service, 'handleUpdate').mockReturnValue(handleUpdateGate);
    const setTimeoutSpy = installImmediateTimeoutForDelay(10);

    try {
      await expect(service.processWebhookEvent('event-timeout-1')).resolves.toBeUndefined();

      expect(webhookEventUpdateMany).toHaveBeenCalledWith({
        where: expect.objectContaining({ id: 'event-timeout-1' }),
        data: expect.objectContaining({
          status: 'FAILED',
          errorMessage: expect.stringMatching(
            new RegExp(`^${WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINE_PREFIX}:`),
          ),
          nextEnqueueAt: null,
          timeoutQuarantineExpiresAt: expect.any(Date),
        }),
      });
      expect(executionClaimUpdateMany).toHaveBeenCalledTimes(2);

      resolveHandleUpdate();
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(webhookEventUpdateMany).toHaveBeenLastCalledWith({
        where: expect.objectContaining({
          id: 'event-timeout-1',
          status: 'FAILED',
          errorMessage: expect.stringMatching(
            new RegExp(`^${WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINE_PREFIX}:`),
          ),
          nextEnqueueAt: null,
          timeoutQuarantineExpiresAt: expect.any(Date),
        }),
        data: expect.objectContaining({
          status: 'PROCESSED',
          errorMessage: null,
          nextEnqueueAt: null,
          processedAt: expect.any(Date),
        }),
      });
      expect(executionClaimUpdateMany).toHaveBeenCalledWith({
        where: {
          webhookEventId: 'event-timeout-1',
          kind: 'EXECUTION',
          enforced: true,
          leaseToken: expect.any(String),
          status: 'READY',
        },
        data: {
          enforced: true,
          status: 'COMPLETED',
          completedAt: expect.any(Date),
          leaseToken: null,
          leaseExpiresAt: null,
        },
      });
      expect(commercialOcrEnqueueService.activatePendingBatch).toHaveBeenCalledTimes(1);
      expect(completeWebhookExecution.mock.invocationCallOrder[0]).toBeLessThan(
        commercialOcrEnqueueService.activatePendingBatch.mock.invocationCallOrder[0]!,
      );
      expect(commercialOcrEnqueueService.suppressPendingBatch).not.toHaveBeenCalled();
    } finally {
      setTimeoutSpy.mockRestore();
    }
  });

  it.each(['QUEUED', 'FAILED'] as const)(
    'settles a shadow mirror in %s state on its completed owner without starting the engine',
    async (status) => {
      const webhookEventId = `event-shadow-mirror-${status}-1`;
      const ownerId = 'event-shadow-owner-1';
      const update = createUpdate();
      const semanticKey = buildWebhookSemanticEventKey(update);
      const completedAt = new Date('2026-08-15T12:00:01.000Z');
      const mirror = {
        id: webhookEventId,
        status,
        botId: 'bot-1',
        normalizedPayload: update,
        errorMessage: null,
        processedAt: null,
        nextEnqueueAt: null,
        timeoutQuarantineExpiresAt: null,
      };
      const owner = {
        ...mirror,
        id: ownerId,
        status: 'PROCESSED',
        processedAt: completedAt,
      };
      const prisma = {
        webhookEvent: {
          findUnique: jest.fn(async ({ where }) => (where.id === ownerId ? owner : mirror)),
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        },
        webhookExecutionClaim: {
          findUnique: jest.fn().mockResolvedValue({
            id: 'claim-shadow-owner-1',
            semanticKey,
            webhookEventId: ownerId,
            executionBotId: 'bot-1',
            enforced: false,
            status: 'COMPLETED',
            preparedAt: new Date('2026-08-15T12:00:00.000Z'),
            completedAt,
            leaseToken: null,
            leaseExpiresAt: null,
          }),
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        },
      };
      withCanonicalWebhookFixture(prisma);
      const service = new ModerationService(
        prisma as never,
        { detect: jest.fn() } as never,
        { resolveAction: jest.fn() } as never,
        {} as never,
      );
      const handler = jest.spyOn(service, 'handleUpdate');
      const watchdog = jest.spyOn(service as any, 'startWebhookTimeoutSettlementWatchdog');
      const commercialOcrEnqueueService = {
        activatePendingBatch: jest.fn(),
        suppressPendingBatch: jest.fn(),
      };
      Object.assign(service, { commercialOcrEnqueueService });

      await expect(service.processWebhookEvent(webhookEventId)).resolves.toBeUndefined();

      expect(handler).not.toHaveBeenCalled();
      expect(watchdog).not.toHaveBeenCalled();
      expect(prisma.webhookExecutionClaim.updateMany).toHaveBeenCalledTimes(2);
      expect(prisma.webhookExecutionClaim.updateMany).toHaveBeenLastCalledWith({
        where: expect.objectContaining({
          id: 'claim-shadow-owner-1',
          semanticKey,
          webhookEventId: ownerId,
          enforced: true,
          status: 'COMPLETED',
          completedAt,
          leaseToken: null,
          leaseExpiresAt: null,
        }),
        data: expect.objectContaining({ enforced: true, status: 'COMPLETED' }),
      });
      expect(prisma.webhookEvent.updateMany).toHaveBeenLastCalledWith({
        where: expect.objectContaining({
          id: webhookEventId,
          status,
          normalizedPayload: { equals: update },
        }),
        data: {
          status: 'DUPLICATE',
          processedAt: completedAt,
          errorMessage: null,
          queueName: null,
          nextEnqueueAt: null,
          timeoutQuarantineExpiresAt: null,
        },
      });
      expect(commercialOcrEnqueueService.activatePendingBatch).not.toHaveBeenCalled();
      expect(commercialOcrEnqueueService.suppressPendingBatch).not.toHaveBeenCalled();
    },
  );

  it('keeps a hot-path timeout quarantined when detached work later fails', async () => {
    const update = {
      ...createUpdate(),
      message: {
        ...createUpdate().message,
        chatId: '-chat-42',
      },
    };
    let rejectHandleUpdate!: (error: Error) => void;
    const handleUpdateGate = new Promise<void>((_resolve, reject) => {
      rejectHandleUpdate = reject;
    });
    const webhookEventUpdateMany = jest
      .fn()
      .mockResolvedValueOnce({ count: 1 })
      .mockRejectedValueOnce(new Error('transient terminal settlement failure'))
      .mockResolvedValue({ count: 1 });
    const executionClaimUpdateMany = jest.fn().mockResolvedValue({ count: 1 });
    const prisma = {
      webhookEvent: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'event-timeout-late-failure-1',
          status: 'QUEUED',
          botId: 'id613002203036_bot',
          normalizedPayload: update,
        }),
        update: jest.fn().mockResolvedValue(undefined),
        updateMany: webhookEventUpdateMany,
      },
      webhookExecutionClaim: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'claim-timeout-late-failure-1',
          webhookEventId: 'event-timeout-late-failure-1',
          executionBotId: 'id613002203036_bot',
          enforced: true,
          status: 'READY',
          leaseToken: null,
          leaseExpiresAt: null,
        }),
        updateMany: executionClaimUpdateMany,
      },
    };
    withCanonicalWebhookFixture(prisma);
    const service = new ModerationService(
      prisma as never,
      { detect: jest.fn() } as never,
      { resolveAction: jest.fn() } as never,
      {} as never,
    );
    const commercialOcrEnqueueService = {
      activatePendingBatch: jest.fn().mockResolvedValue(undefined),
      suppressPendingBatch: jest.fn().mockResolvedValue(undefined),
    };
    (service as any).commercialOcrEnqueueService = commercialOcrEnqueueService;
    (service as any).webhookUserFacingTimeoutMs = 10;
    jest.spyOn(service, 'handleUpdate').mockReturnValue(handleUpdateGate);
    const retryWait = jest
      .spyOn(service as any, 'waitForWebhookTimeoutPersistenceRetry')
      .mockResolvedValue(undefined);
    const setTimeoutSpy = installImmediateTimeoutForDelay(10);

    try {
      await expect(
        service.processWebhookEvent('event-timeout-late-failure-1'),
      ).resolves.toBeUndefined();

      rejectHandleUpdate(new Error('late detached webhook failure'));
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(webhookEventUpdateMany).not.toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: 'PROCESSED' }),
        }),
      );
      expect(webhookEventUpdateMany).toHaveBeenLastCalledWith({
        where: expect.objectContaining({
          id: 'event-timeout-late-failure-1',
          status: 'FAILED',
          errorMessage: expect.stringMatching(
            new RegExp(`^${WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINE_PREFIX}:`),
          ),
          nextEnqueueAt: null,
          timeoutQuarantineExpiresAt: expect.any(Date),
        }),
        data: expect.objectContaining({
          status: 'FAILED',
          errorMessage: expect.stringMatching(
            new RegExp(
              `^${WEBHOOK_HOT_PATH_TIMEOUT_TERMINAL_QUARANTINE_PREFIX}: late detached webhook failure$`,
            ),
          ),
          nextEnqueueAt: null,
        }),
      });
      expect(webhookEventUpdateMany).toHaveBeenCalledTimes(3);
      expect(executionClaimUpdateMany).toHaveBeenCalledTimes(3);
      expect(executionClaimUpdateMany).toHaveBeenLastCalledWith({
        where: {
          webhookEventId: 'event-timeout-late-failure-1',
          kind: 'EXECUTION',
          enforced: true,
          status: 'READY',
          leaseToken: expect.any(String),
        },
        data: {
          enforced: true,
          status: 'READY',
          completedAt: null,
          leaseToken: null,
          leaseExpiresAt: null,
        },
      });
      expect(retryWait).toHaveBeenCalledWith(WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINE_PERSIST_RETRY_MS);
      expect(commercialOcrEnqueueService.suppressPendingBatch).toHaveBeenCalledTimes(1);
      expect(commercialOcrEnqueueService.activatePendingBatch).not.toHaveBeenCalled();
    } finally {
      setTimeoutSpy.mockRestore();
    }
  });

  it('falls back to a fenced quarantine when the first timeout persistence write fails', async () => {
    const update = {
      ...createUpdate(),
      message: {
        ...createUpdate().message,
        chatId: '-chat-42',
      },
    };
    let resolveHandleUpdate!: () => void;
    const handleUpdateGate = new Promise<void>((resolve) => {
      resolveHandleUpdate = resolve;
    });
    const executionClaimUpdateMany = jest.fn().mockResolvedValue({ count: 1 });
    const webhookEventUpdateMany = jest
      .fn()
      .mockRejectedValueOnce(new Error('initial timeout quarantine database failure'))
      .mockResolvedValue({ count: 1 });
    const prisma = {
      webhookEvent: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'event-timeout-persistence-failure-1',
          status: 'QUEUED',
          botId: 'id613002203036_bot',
          normalizedPayload: update,
        }),
        update: jest.fn().mockResolvedValue(undefined),
        updateMany: webhookEventUpdateMany,
      },
      webhookExecutionClaim: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'claim-timeout-persistence-failure-1',
          webhookEventId: 'event-timeout-persistence-failure-1',
          executionBotId: 'id613002203036_bot',
          enforced: true,
          status: 'READY',
          leaseToken: null,
          leaseExpiresAt: null,
        }),
        updateMany: executionClaimUpdateMany,
      },
    };
    withCanonicalWebhookFixture(prisma);
    const service = new ModerationService(
      prisma as never,
      { detect: jest.fn() } as never,
      { resolveAction: jest.fn() } as never,
      {} as never,
    );
    (service as any).webhookUserFacingTimeoutMs = 10;
    jest.spyOn(service, 'handleUpdate').mockReturnValue(handleUpdateGate);
    const setTimeoutSpy = installImmediateTimeoutForDelay(10);

    try {
      await expect(
        service.processWebhookEvent('event-timeout-persistence-failure-1'),
      ).resolves.toBeUndefined();

      expect(webhookEventUpdateMany).toHaveBeenLastCalledWith({
        where: expect.objectContaining({ id: 'event-timeout-persistence-failure-1' }),
        data: expect.objectContaining({
          status: 'FAILED',
          errorMessage: expect.stringMatching(
            new RegExp(
              `^${WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINE_PREFIX}:[^:]+: .*initial timeout quarantine database failure`,
            ),
          ),
          nextEnqueueAt: null,
          timeoutQuarantineExpiresAt: expect.any(Date),
        }),
      });
      expect(executionClaimUpdateMany).toHaveBeenCalledTimes(2);

      resolveHandleUpdate();
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(webhookEventUpdateMany).toHaveBeenLastCalledWith({
        where: expect.objectContaining({
          id: 'event-timeout-persistence-failure-1',
          status: 'FAILED',
          errorMessage: expect.stringMatching(
            new RegExp(`^${WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINE_PREFIX}:`),
          ),
          nextEnqueueAt: null,
          timeoutQuarantineExpiresAt: expect.any(Date),
        }),
        data: expect.objectContaining({
          status: 'PROCESSED',
          errorMessage: null,
          nextEnqueueAt: null,
          processedAt: expect.any(Date),
        }),
      });
      expect(executionClaimUpdateMany).toHaveBeenCalledWith({
        where: {
          webhookEventId: 'event-timeout-persistence-failure-1',
          kind: 'EXECUTION',
          enforced: true,
          leaseToken: expect.any(String),
          status: 'READY',
        },
        data: {
          enforced: true,
          status: 'COMPLETED',
          completedAt: expect.any(Date),
          leaseToken: null,
          leaseExpiresAt: null,
        },
      });
    } finally {
      setTimeoutSpy.mockRestore();
    }
  });

  it('retains the BullMQ execution until detached work settles when quarantine persistence is unavailable', async () => {
    const update = {
      ...createUpdate(),
      message: {
        ...createUpdate().message,
        chatId: '-chat-timeout-unfenced',
      },
    };
    let resolveHandleUpdate!: () => void;
    const handleUpdateGate = new Promise<void>((resolve) => {
      resolveHandleUpdate = resolve;
    });
    const webhookEventUpdate = jest.fn().mockResolvedValue(undefined);
    const webhookEventUpdateMany = jest
      .fn()
      .mockRejectedValueOnce(new Error('initial quarantine write failed'))
      .mockRejectedValueOnce(new Error('fallback quarantine write failed'))
      .mockResolvedValue({ count: 1 });
    const executionClaimUpdateMany = jest.fn().mockResolvedValue({ count: 1 });
    const prisma = {
      webhookEvent: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'event-timeout-unfenced-1',
          status: 'QUEUED',
          botId: 'id613002203036_bot',
          normalizedPayload: update,
        }),
        update: webhookEventUpdate,
        updateMany: webhookEventUpdateMany,
      },
      webhookExecutionClaim: {
        updateMany: executionClaimUpdateMany,
      },
    };
    withCanonicalWebhookFixture(prisma);
    const service = new ModerationService(
      prisma as never,
      { detect: jest.fn() } as never,
      { resolveAction: jest.fn() } as never,
      {} as never,
    );
    (service as any).webhookUserFacingTimeoutMs = 10;
    jest.spyOn(service, 'handleUpdate').mockReturnValue(handleUpdateGate);
    const setTimeoutSpy = installImmediateTimeoutForDelay(10);

    try {
      let processorSettled = false;
      const processing = service.processWebhookEvent('event-timeout-unfenced-1').finally(() => {
        processorSettled = true;
      });
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(webhookEventUpdateMany).toHaveBeenCalledTimes(2);
      expect(processorSettled).toBe(false);
      expect(webhookEventUpdate).not.toHaveBeenCalled();

      resolveHandleUpdate();
      await expect(processing).resolves.toBeUndefined();

      expect(processorSettled).toBe(true);
      const originalLeaseToken = executionClaimUpdateMany.mock.calls[0][0].data.leaseToken;
      expect(originalLeaseToken).toEqual(expect.any(String));
      expect(executionClaimUpdateMany).toHaveBeenNthCalledWith(1, {
        where: {
          id: 'claim:event-timeout-unfenced-1',
          status: 'READY',
          businessStartedAt: null,
          OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lt: expect.any(Date) } }],
        },
        data: {
          leaseToken: originalLeaseToken,
          leaseExpiresAt: expect.any(Date),
        },
      });
      expect(executionClaimUpdateMany).toHaveBeenNthCalledWith(2, {
        where: {
          webhookEventId: 'event-timeout-unfenced-1',
          kind: 'EXECUTION',
          OR: [
            { leaseToken: originalLeaseToken, status: 'READY' },
            { leaseToken: null, status: 'COMPLETED' },
          ],
        },
        data: {
          enforced: true,
          status: 'COMPLETED',
          completedAt: expect.any(Date),
          leaseToken: null,
          leaseExpiresAt: null,
        },
      });
      expect(webhookEventUpdateMany).toHaveBeenLastCalledWith({
        where: expect.objectContaining({ id: 'event-timeout-unfenced-1' }),
        data: expect.objectContaining({
          status: 'PROCESSED',
          errorMessage: null,
          nextEnqueueAt: null,
          timeoutQuarantineExpiresAt: null,
        }),
      });
      expect(webhookEventUpdate).not.toHaveBeenCalled();
    } finally {
      setTimeoutSpy.mockRestore();
    }
  });

  it('retains an unfenced completed webhook until durable completion persistence recovers', async () => {
    let releaseRetry!: () => void;
    const retryGate = new Promise<void>((resolve) => {
      releaseRetry = resolve;
    });
    let resolvePersistence!: () => void;
    const persistenceGate = new Promise<'settled'>((resolve) => {
      resolvePersistence = () => resolve('settled');
    });
    const service = new ModerationService(
      {} as never,
      { detect: jest.fn() } as never,
      { resolveAction: jest.fn() } as never,
      {} as never,
    );
    const canonicalExecutionService = (service as any).webhookCanonicalExecutionService;
    const settleExecution = jest
      .spyOn(canonicalExecutionService, 'settleUnquarantinedTimedOutExecution')
      .mockRejectedValueOnce(new Error('completion persistence unavailable'))
      .mockReturnValueOnce(persistenceGate);
    const retryWait = jest
      .spyOn(service as any, 'waitForWebhookTimeoutPersistenceRetry')
      .mockReturnValue(retryGate);
    const commercialOcrEnqueueService = {
      activatePendingBatch: jest.fn().mockResolvedValue(undefined),
      suppressPendingBatch: jest.fn().mockResolvedValue(undefined),
    };
    (service as any).commercialOcrEnqueueService = commercialOcrEnqueueService;
    const errorLog = jest
      .spyOn((service as any).logger, 'error')
      .mockImplementation(() => undefined);
    const settlementWatchdog = {
      deadlineAtMs: Date.now() + WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINE_MAX_LIFETIME_MS,
      isExpired: jest.fn().mockReturnValue(false),
      stop: jest.fn(),
    };
    let processorSettled = false;
    const processing = (service as any)
      .recoverTimedOutWebhookWithoutDurableQuarantine({
        execution: {
          webhookEvent: { id: 'event-timeout-unfenced-completed-1' },
          update: createUpdate(),
          activeBotId: null,
          businessLeaseToken: null,
        },
        detachedTask: Promise.resolve(),
        timeoutErrorMessage: 'webhook hot-path timeout',
        persistenceError: new Error('quarantine persistence unavailable'),
        commercialOcrPendingActivations: [],
        settlementWatchdog,
      })
      .finally(() => {
        processorSettled = true;
      });

    try {
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(settleExecution).toHaveBeenCalledTimes(1);
      expect(settleExecution).toHaveBeenLastCalledWith(
        expect.objectContaining({
          webhookEvent: expect.objectContaining({ id: 'event-timeout-unfenced-completed-1' }),
        }),
        {
          kind: 'completed',
          timeoutErrorMessage: 'webhook hot-path timeout',
        },
      );
      expect(processorSettled).toBe(false);
      expect(commercialOcrEnqueueService.activatePendingBatch).not.toHaveBeenCalled();
      expect(errorLog).toHaveBeenCalledWith(
        expect.objectContaining({
          webhookEventId: 'event-timeout-unfenced-completed-1',
          outcome: 'completed',
          persistenceAttempt: 1,
          retryDelayMs: WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINE_PERSIST_RETRY_MS,
        }),
        'Could not persist unfenced webhook settlement; the BullMQ job remains active',
      );

      expect(retryWait).toHaveBeenCalledWith(WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINE_PERSIST_RETRY_MS);
      releaseRetry();
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(settleExecution).toHaveBeenCalledTimes(2);
      expect(processorSettled).toBe(false);

      resolvePersistence();
      await expect(processing).resolves.toBeNull();

      expect(commercialOcrEnqueueService.activatePendingBatch).toHaveBeenCalledTimes(1);
      expect(commercialOcrEnqueueService.suppressPendingBatch).not.toHaveBeenCalled();
      expect(settlementWatchdog.stop).toHaveBeenCalledTimes(1);
    } finally {
      releaseRetry();
      resolvePersistence();
      errorLog.mockRestore();
    }
  });

  it('retains an unfenced failed webhook until durable terminal persistence recovers', async () => {
    let releaseRetry!: () => void;
    const retryGate = new Promise<void>((resolve) => {
      releaseRetry = resolve;
    });
    let resolvePersistence!: () => void;
    const persistenceGate = new Promise<'settled'>((resolve) => {
      resolvePersistence = () => resolve('settled');
    });
    const service = new ModerationService(
      {} as never,
      { detect: jest.fn() } as never,
      { resolveAction: jest.fn() } as never,
      {} as never,
    );
    const canonicalExecutionService = (service as any).webhookCanonicalExecutionService;
    const settleExecution = jest
      .spyOn(canonicalExecutionService, 'settleUnquarantinedTimedOutExecution')
      .mockRejectedValueOnce(new Error('terminal persistence unavailable'))
      .mockReturnValueOnce(persistenceGate);
    const retryWait = jest
      .spyOn(service as any, 'waitForWebhookTimeoutPersistenceRetry')
      .mockReturnValue(retryGate);
    const commercialOcrEnqueueService = {
      activatePendingBatch: jest.fn().mockResolvedValue(undefined),
      suppressPendingBatch: jest.fn().mockResolvedValue(undefined),
    };
    (service as any).commercialOcrEnqueueService = commercialOcrEnqueueService;
    const errorLog = jest
      .spyOn((service as any).logger, 'error')
      .mockImplementation(() => undefined);
    const settlementWatchdog = {
      deadlineAtMs: Date.now() + WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINE_MAX_LIFETIME_MS,
      isExpired: jest.fn().mockReturnValue(false),
      stop: jest.fn(),
    };
    let processorSettled = false;
    const processing = (service as any)
      .recoverTimedOutWebhookWithoutDurableQuarantine({
        execution: {
          webhookEvent: { id: 'event-timeout-unfenced-failed-1' },
          update: createUpdate(),
          activeBotId: null,
          businessLeaseToken: null,
        },
        detachedTask: Promise.reject(new Error('detached side effect failed')),
        timeoutErrorMessage: 'webhook hot-path timeout',
        persistenceError: new Error('quarantine persistence unavailable'),
        commercialOcrPendingActivations: [],
        settlementWatchdog,
      })
      .finally(() => {
        processorSettled = true;
      });

    try {
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(settleExecution).toHaveBeenCalledTimes(1);
      expect(settleExecution).toHaveBeenLastCalledWith(
        expect.objectContaining({
          webhookEvent: expect.objectContaining({ id: 'event-timeout-unfenced-failed-1' }),
        }),
        {
          error: 'detached side effect failed',
          kind: 'failed',
        },
      );
      expect(processorSettled).toBe(false);
      expect(commercialOcrEnqueueService.suppressPendingBatch).not.toHaveBeenCalled();

      expect(retryWait).toHaveBeenCalledWith(WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINE_PERSIST_RETRY_MS);
      releaseRetry();
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(settleExecution).toHaveBeenCalledTimes(2);
      expect(processorSettled).toBe(false);

      resolvePersistence();
      await expect(processing).resolves.toBeNull();

      expect(commercialOcrEnqueueService.suppressPendingBatch).toHaveBeenCalledTimes(1);
      expect(commercialOcrEnqueueService.activatePendingBatch).not.toHaveBeenCalled();
      expect(settlementWatchdog.stop).toHaveBeenCalledTimes(1);
    } finally {
      releaseRetry();
      resolvePersistence();
      errorLog.mockRestore();
    }
  });

  it('does not put a chat into hot-timeout backoff when only violation follow-up times out', () => {
    const update = {
      ...createUpdate(),
      message: {
        ...createUpdate().message,
        chatId: '-chat-1',
      },
    };
    const service = new ModerationService(
      {} as never,
      { detect: jest.fn() } as never,
      { resolveAction: jest.fn() } as never,
      {} as never,
    );

    (service as any).createWebhookHotPathTimeoutError({
      webhookEventId: 'event-timeout-follow-up',
      update,
      activeBotId: 'id613002203036_bot',
      timeoutMs: 10_000,
      timeoutContext: {
        latestStage: 'violation-follow-up',
        elapsedMs: 10_001,
      },
    });

    expect((service as any).isWebhookHotTimeoutChatBackoffActive('-chat-1')).toBe(false);
  });

  it.each(['required-subscription', 'violation-delete', 'violation-follow-up.authority'])(
    'keeps existing hot-timeout backoff at %s',
    (latestStage) => {
      const update = {
        ...createUpdate(),
        message: {
          ...createUpdate().message,
          chatId: '-chat-1',
        },
      };
      const service = new ModerationService(
        {} as never,
        { detect: jest.fn() } as never,
        { resolveAction: jest.fn() } as never,
        {} as never,
      );

      (service as any).createWebhookHotPathTimeoutError({
        webhookEventId: 'event-timeout-required-subscription',
        update,
        activeBotId: 'id613002203036_bot',
        timeoutMs: 10_000,
        timeoutContext: {
          latestStage,
          elapsedMs: 10_001,
        },
      });

      expect((service as any).isWebhookHotTimeoutChatBackoffActive('-chat-1')).toBe(true);
    },
  );

  it('returns a quarantine outcome for stuck user-facing message_created events', async () => {
    const update = {
      ...createUpdate(),
      message: {
        ...createUpdate().message,
        chatId: '-chat-1',
      },
    };
    const service = new ModerationService(
      {} as never,
      { detect: jest.fn() } as never,
      { resolveAction: jest.fn() } as never,
      {} as never,
      undefined,
      undefined,
      {
        get: jest.fn((key: string) => (key === 'WEBHOOK_USER_FACING_TIMEOUT_MS' ? 10 : undefined)),
      } as never,
    );
    (service as any).webhookUserFacingTimeoutMs = 10;
    const setTimeoutSpy = jest.spyOn(global, 'setTimeout').mockImplementation(((
      callback: TimerHandler,
    ) => {
      if (typeof callback === 'function') {
        callback();
      }
      return {
        unref() {
          return this;
        },
      } as unknown as NodeJS.Timeout;
    }) as unknown as typeof setTimeout);
    const taskGate = createDeferred<void>();
    let detachedTask: Promise<void> | null = null;

    try {
      const guardResult = await (service as any).executeWebhookUpdateWithGuard(
        'event-3',
        update,
        null,
        () => taskGate.promise,
      );
      expect(guardResult).toMatchObject({ kind: 'timed_out' });
      detachedTask = guardResult.detachedTask;
      expect(
        (service as any).isTerminalWebhookProcessingError(
          (service as any).createWebhookHotPathTimeoutError({
            webhookEventId: 'event-3',
            update,
            activeBotId: null,
            timeoutMs: 10,
          }),
        ),
      ).toBe(false);
    } finally {
      taskGate.resolve();
      await detachedTask;
      setTimeoutSpy.mockRestore();
    }
  });

  it('records total user-facing duration for slow webhook completions', async () => {
    const update = {
      ...createUpdate(),
      message: {
        ...createUpdate().message,
        chatId: '-chat-1',
      },
    };
    const runtimeDiagnosticsService = {
      recordHotPathStageOutcome: jest.fn(),
      recordHotPathProfile: jest.fn(),
    };
    const service = new ModerationService(
      {} as never,
      { detect: jest.fn() } as never,
      { resolveAction: jest.fn() } as never,
      {} as never,
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
    let nowCalls = 0;
    const dateNowSpy = jest.spyOn(Date, 'now').mockImplementation(() => {
      nowCalls += 1;
      return nowCalls === 1 ? 0 : 6_000;
    });

    try {
      await (service as any).executeWebhookUpdateWithGuard(
        'event-slow',
        update,
        null,
        async () => undefined,
        () => ({
          latestStage: 'admin-command',
          stageDurations: {
            'admin-command': 0,
          },
        }),
      );
    } finally {
      dateNowSpy.mockRestore();
    }

    expect(runtimeDiagnosticsService.recordHotPathProfile).toHaveBeenCalledWith({
      snapshot: expect.objectContaining({
        latestStage: 'admin-command',
      }),
    });
    expect(runtimeDiagnosticsService.recordHotPathProfile).toHaveBeenCalledWith({
      snapshot: {
        latestStage: 'user-facing-total',
        stageDurations: {
          'user-facing-total': 6_000,
        },
      },
    });
  });

  it('returns a quarantine outcome for violation follow-up timeouts after the action boundary', async () => {
    const update = {
      ...createUpdate(),
      message: {
        ...createUpdate().message,
        chatId: '-chat-1',
      },
    };
    const runtimeDiagnosticsService = {
      recordHotPathStageOutcome: jest.fn(),
      recordHotPathProfile: jest.fn(),
    };
    const service = new ModerationService(
      {} as never,
      { detect: jest.fn() } as never,
      { resolveAction: jest.fn() } as never,
      {} as never,
      undefined,
      undefined,
      {
        get: jest.fn((key: string) => (key === 'WEBHOOK_USER_FACING_TIMEOUT_MS' ? 10 : undefined)),
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
    (service as any).webhookUserFacingTimeoutMs = 10;
    const setTimeoutSpy = jest.spyOn(global, 'setTimeout').mockImplementation(((
      callback: TimerHandler,
    ) => {
      if (typeof callback === 'function') {
        callback();
      }
      return {
        unref() {
          return this;
        },
      } as unknown as NodeJS.Timeout;
    }) as unknown as typeof setTimeout);
    const taskGate = createDeferred<void>();
    let detachedTask: Promise<void> | null = null;

    try {
      const guardResult = await (service as any).executeWebhookUpdateWithGuard(
        'event-follow-up-detached',
        update,
        'id613002203036_bot',
        () => taskGate.promise,
        () => ({
          latestStage: 'violation-follow-up',
          elapsedMs: 10,
          successBoundaryReached: true,
          successBoundaryStage: 'violation-delete',
        }),
      );
      expect(guardResult).toMatchObject({ kind: 'timed_out' });
      detachedTask = guardResult.detachedTask;

      expect(runtimeDiagnosticsService.recordHotPathStageOutcome).toHaveBeenCalledWith({
        stage: 'violation-follow-up',
        outcome: 'timeout',
        failOpen: false,
      });
    } finally {
      taskGate.resolve();
      await detachedTask;
      setTimeoutSpy.mockRestore();
    }
  });

  it('detaches required subscription follow-up earlier after delete boundary', () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-07-03T10:00:00.000Z'));
    const runtimeDiagnosticsService = {
      recordHotPathStageOutcome: jest.fn(),
    };
    const service = new ModerationService(
      {} as never,
      { detect: jest.fn() } as never,
      { resolveAction: jest.fn() } as never,
      {} as never,
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
    const hotPathProfile = {
      startedAtMs: Date.now() - 6_700,
      lastMarkedAtMs: Date.now() - 10,
      latestStage: 'required-subscription.follow-up',
      stages: new Map<string, number>(),
      stageTimelineMs: new Map<string, number>(),
      successBoundaryReached: true,
      successBoundaryStage: 'required-subscription.delete',
    };

    expect(
      (service as any).shouldDetachFollowUpForBudget(
        hotPathProfile,
        'required-subscription.follow-up',
        3_500,
      ),
    ).toBe(true);
    expect(runtimeDiagnosticsService.recordHotPathStageOutcome).toHaveBeenCalledWith({
      stage: 'required-subscription.follow-up.deferred',
      outcome: 'skip',
      failOpen: true,
    });

    jest.useRealTimers();
  });

  it('budgets a hanging webhook follow-up even before the destructive boundary', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-07-03T10:00:00.000Z'));
    const runtimeDiagnosticsService = {
      recordHotPathStageOutcome: jest.fn(),
    };
    const service = new ModerationService(
      {} as never,
      { detect: jest.fn() } as never,
      { resolveAction: jest.fn() } as never,
      {} as never,
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
    const taskGate = createDeferred<void>();
    const task = jest.fn(() => taskGate.promise);
    const hotPathProfile = {
      startedAtMs: Date.now() - 1_000,
      lastMarkedAtMs: Date.now() - 100,
      latestStage: 'violation-follow-up',
      stages: new Map<string, number>(),
      stageTimelineMs: new Map<string, number>(),
      successBoundaryReached: false,
      successBoundaryStage: null,
    };

    try {
      const result = (service as any).runWebhookFollowUpWithBudget({
        stage: 'violation-follow-up',
        hotPathProfile,
        chatId: 'chat-1',
        userId: 'user-1',
        messageId: 'message-1',
        maxWaitMs: 2_000,
        task,
      });

      await Promise.resolve();
      expect(task).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(2_000);
      await expect(result).resolves.toBeUndefined();

      expect(runtimeDiagnosticsService.recordHotPathStageOutcome).toHaveBeenCalledWith({
        stage: 'violation-follow-up.deferred',
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
          stage: 'violation-follow-up',
          chatId: 'chat-1',
          userId: 'user-1',
          messageId: 'message-1',
          timeoutMs: 2_000,
        }),
        'Detached webhook follow-up after hot-path budget window',
      );
    } finally {
      taskGate.resolve();
      await taskGate.promise;
      await Promise.resolve();
      debugSpy.mockRestore();
      jest.useRealTimers();
    }
  });

  it('does not mark fast webhook follow-up work as deferred', async () => {
    const runtimeDiagnosticsService = {
      recordHotPathStageOutcome: jest.fn(),
    };
    const service = new ModerationService(
      {} as never,
      { detect: jest.fn() } as never,
      { resolveAction: jest.fn() } as never,
      {} as never,
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
    const task = jest.fn(async () => undefined);

    await expect(
      (service as any).runWebhookFollowUpWithBudget({
        stage: 'violation-follow-up',
        hotPathProfile: null,
        chatId: 'chat-1',
        userId: 'user-1',
        messageId: 'message-1',
        maxWaitMs: 2_000,
        task,
      }),
    ).resolves.toBeUndefined();

    expect(task).toHaveBeenCalledTimes(1);
    expect(runtimeDiagnosticsService.recordHotPathStageOutcome).not.toHaveBeenCalledWith({
      stage: 'violation-follow-up.deferred',
      outcome: 'skip',
      failOpen: true,
    });
    expect(runtimeDiagnosticsService.recordHotPathStageOutcome).not.toHaveBeenCalledWith({
      stage: 'follow_up_deferred',
      outcome: 'skip',
      failOpen: true,
    });
  });

  it('returns a quarantine outcome for stuck message_callback events', async () => {
    const update = createPrivateCallbackUpdate('pc2|broadcast_send');
    const service = new ModerationService(
      {} as never,
      { detect: jest.fn() } as never,
      { resolveAction: jest.fn() } as never,
      {} as never,
      undefined,
      undefined,
      {
        get: jest.fn((key: string) => (key === 'WEBHOOK_USER_FACING_TIMEOUT_MS' ? 10 : undefined)),
      } as never,
    );
    (service as any).webhookUserFacingTimeoutMs = 10;
    const setTimeoutSpy = jest.spyOn(global, 'setTimeout').mockImplementation(((
      callback: TimerHandler,
    ) => {
      if (typeof callback === 'function') {
        callback();
      }
      return {
        unref() {
          return this;
        },
      } as unknown as NodeJS.Timeout;
    }) as unknown as typeof setTimeout);
    const taskGate = createDeferred<void>();
    let detachedTask: Promise<void> | null = null;

    try {
      const guardResult = await (service as any).executeWebhookUpdateWithGuard(
        'event-callback-1',
        update,
        null,
        () => taskGate.promise,
      );
      expect(guardResult).toMatchObject({ kind: 'timed_out' });
      detachedTask = guardResult.detachedTask;
      expect(
        (service as any).isTerminalWebhookProcessingError(
          (service as any).createWebhookHotPathTimeoutError({
            webhookEventId: 'event-callback-1',
            update,
            activeBotId: null,
            timeoutMs: 10,
          }),
        ),
      ).toBe(false);
    } finally {
      taskGate.resolve();
      await detachedTask;
      setTimeoutSpy.mockRestore();
    }
  });

  it('clears the user-facing watchdog after a successful hot-path completion', async () => {
    jest.useFakeTimers();
    try {
      const update = {
        ...createUpdate(),
        message: {
          ...createUpdate().message,
          chatId: '-chat-1',
        },
      };
      const service = new ModerationService(
        {} as never,
        { detect: jest.fn() } as never,
        { resolveAction: jest.fn() } as never,
        {} as never,
        undefined,
        undefined,
        {
          get: jest.fn((key: string) =>
            key === 'WEBHOOK_USER_FACING_TIMEOUT_MS' ? 10 : undefined,
          ),
        } as never,
      );
      (service as any).webhookUserFacingTimeoutMs = 10;

      const timeoutErrorSpy = jest.spyOn(service as any, 'createWebhookHotPathTimeoutError');
      const promise = (service as any).executeWebhookUpdateWithGuard(
        'event-4',
        update,
        null,
        async () => {
          await Promise.resolve();
        },
      );

      await promise;
      await jest.advanceTimersByTimeAsync(20);

      expect(timeoutErrorSpy).not.toHaveBeenCalled();
      expect((service as any).isWebhookHotTimeoutChatBackoffActive('-chat-1')).toBe(false);
    } finally {
      jest.useRealTimers();
    }
  });

  it('reports hot-path stage durations as deltas and keeps a cumulative timeline', () => {
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
    let now = 1_000;
    dateNowSpy.mockImplementation(() => now);

    try {
      const profile = (service as any).createWebhookHotPathProfile();
      now = 1_015;
      (service as any).markWebhookHotPathStage(profile, 'global-spammer-exempt');
      now = 1_055;
      (service as any).markWebhookHotPathStage(profile, 'global-spammer-track');
      now = 1_080;
      (service as any).markWebhookHotPathStage(profile, 'rule-engine');

      const snapshot = (service as any).readWebhookHotPathProfileSnapshot(profile);

      expect(snapshot).toMatchObject({
        latestStage: 'rule-engine',
        elapsedMs: 80,
        stageDurations: {
          'global-spammer-exempt': 15,
          'global-spammer-track': 40,
          'rule-engine': 25,
        },
        stageTimelineMs: {
          'global-spammer-exempt': 15,
          'global-spammer-track': 55,
          'rule-engine': 80,
        },
      });
    } finally {
      dateNowSpy.mockRestore();
    }
  });

  it('fails open when global spammer tracking exceeds the hot-path budget', async () => {
    jest.useFakeTimers();
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
    const trackSpy = jest
      .spyOn(service as any, 'trackAndRegisterGlobalSpammer')
      .mockReturnValue(new Promise(() => undefined));
    const debugSpy = jest
      .spyOn((service as any).logger, 'debug')
      .mockImplementation(() => undefined);

    try {
      const resultPromise = (service as any).trackAndRegisterGlobalSpammerWithHotPathBudget({
        chatId: '-chat-1',
        userId: 'user-1',
        messageId: 'message-1',
        text: 'fanout text',
        deleteSpammersEnabled: true,
        exemptFromEnforcement: false,
      });

      await jest.advanceTimersByTimeAsync(GLOBAL_SPAMMER_TRACK_HOT_PATH_TIMEOUT_MS);

      await expect(resultPromise).resolves.toEqual({
        handled: false,
        skipKnownSpammerCheck: false,
      });
      expect(trackSpy).toHaveBeenCalledTimes(1);
      expect(debugSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          chatId: '-chat-1',
          userId: 'user-1',
          messageId: 'message-1',
          timeoutMs: GLOBAL_SPAMMER_TRACK_HOT_PATH_TIMEOUT_MS,
        }),
        'Global spammer tracking exceeded hot-path budget; continuing fail-open',
      );
    } finally {
      jest.useRealTimers();
    }
  });

  it('does not run detected global spammer destructive side effects after tracking budget timeout', async () => {
    jest.useFakeTimers();
    const runtimeDiagnosticsService = {
      recordHotPathStageOutcome: jest.fn(),
    };
    let releaseUniqueChatState!: (value: { added: boolean; size: number }) => void;
    const delayedUniqueChatState = new Promise<{ added: boolean; size: number }>((resolve) => {
      releaseUniqueChatState = resolve;
    });
    const prisma = {
      globalSpammer: {
        upsert: jest.fn().mockResolvedValue({}),
      },
      moderationEvent: {
        create: jest.fn(),
      },
    };
    const redisCounter = {
      addToSetWithTtl: jest
        .fn()
        .mockReturnValueOnce(delayedUniqueChatState)
        .mockResolvedValueOnce({ added: true, size: 1 }),
      incrementWithTtl: jest
        .fn()
        .mockResolvedValue(GLOBAL_SPAMMER_CONFIRMED_FANOUT_EPISODE_THRESHOLD),
    };
    const maxClient = {
      deleteMessage: jest.fn(),
      kickMember: jest.fn(),
    };
    const service = new ModerationService(
      prisma as never,
      { detect: jest.fn() } as never,
      { resolveAction: jest.fn() } as never,
      maxClient as never,
      undefined,
      undefined,
      {
        get: jest.fn(),
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
    const debugSpy = jest
      .spyOn((service as any).logger, 'debug')
      .mockImplementation(() => undefined);

    try {
      const resultPromise = (service as any).trackAndRegisterGlobalSpammerWithHotPathBudget({
        chatId: '-chat-1',
        userId: 'user-1',
        messageId: 'message-1',
        text: 'fanout text',
        deleteSpammersEnabled: true,
        exemptFromEnforcement: false,
      });

      await Promise.resolve();
      await jest.advanceTimersByTimeAsync(GLOBAL_SPAMMER_TRACK_HOT_PATH_TIMEOUT_MS);
      await expect(resultPromise).resolves.toEqual({
        handled: false,
        skipKnownSpammerCheck: false,
      });

      releaseUniqueChatState({
        added: true,
        size: GLOBAL_SPAMMER_HIGH_FANOUT_MIN_CHATS,
      });
      for (let i = 0; i < 10; i += 1) {
        await Promise.resolve();
      }

      expect(prisma.globalSpammer.upsert).toHaveBeenCalledTimes(1);
      expect(maxClient.deleteMessage).not.toHaveBeenCalled();
      expect(maxClient.kickMember).not.toHaveBeenCalled();
      expect(runtimeDiagnosticsService.recordHotPathStageOutcome).toHaveBeenCalledWith({
        stage: 'global-spammer-track.side-effect.skipped-after-timeout',
        outcome: 'skip',
        failOpen: true,
      });
      expect(debugSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          chatId: '-chat-1',
          userId: 'user-1',
          messageId: 'message-1',
        }),
        'Skipped detected global spammer destructive side effect after hot-path budget expired',
      );
    } finally {
      debugSpy.mockRestore();
      jest.useRealTimers();
    }
  });

  it('fails open when global spammer admin exemption lookup exceeds the hot-path budget', async () => {
    jest.useFakeTimers();
    const runtimeDiagnosticsService = {
      recordHotPathStageOutcome: jest.fn(),
    };
    const lookupGate = createDeferred<unknown[]>();
    const prisma = {
      adminGlobalSpammerExemption: {
        findMany: jest.fn(() => lookupGate.promise),
      },
    };
    const service = new ModerationService(
      prisma as never,
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
      undefined,
      undefined,
      undefined,
      runtimeDiagnosticsService as never,
    );
    const debugSpy = jest
      .spyOn((service as any).logger, 'debug')
      .mockImplementation(() => undefined);
    const resolveAdminDecisions = jest.spyOn(service as any, 'resolveGlobalSpammerAdminDecisions');

    try {
      const resultPromise = (service as any).resolveGlobalSpammerAdminDecisionsWithHotPathBudget(
        ['user-1'],
        ['owner-1'],
        {
          chatId: 'chat-1',
          userId: 'user-1',
          messageId: 'message-1',
        },
      );

      await Promise.resolve();
      await Promise.resolve();
      expect(prisma.adminGlobalSpammerExemption.findMany).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(GLOBAL_SPAMMER_EXEMPTION_HOT_PATH_TIMEOUT_MS);

      await expect(resultPromise).resolves.toEqual(new Map());
      expect(runtimeDiagnosticsService.recordHotPathStageOutcome).toHaveBeenCalledWith({
        stage: 'global-spammer-exempt.budget',
        outcome: 'timeout',
        failOpen: true,
      });
      expect(debugSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          chatId: 'chat-1',
          userId: 'user-1',
          messageId: 'message-1',
          timeoutMs: GLOBAL_SPAMMER_EXEMPTION_HOT_PATH_TIMEOUT_MS,
        }),
        'Global spammer admin exemption lookup exceeded hot-path budget; continuing fail-open',
      );
    } finally {
      lookupGate.resolve([]);
      const lookupResult = resolveAdminDecisions.mock.results[0];
      if (lookupResult?.type === 'return') {
        await lookupResult.value;
      }
      resolveAdminDecisions.mockRestore();
      debugSpy.mockRestore();
      jest.useRealTimers();
    }
  });

  it('skips global spammer admin exemption lookup when the admin roster is too large for the hot path', async () => {
    const runtimeDiagnosticsService = {
      recordHotPathStageOutcome: jest.fn(),
    };
    const prisma = {
      adminGlobalSpammerExemption: {
        findMany: jest.fn(),
      },
    };
    const service = new ModerationService(
      prisma as never,
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
      undefined,
      undefined,
      undefined,
      runtimeDiagnosticsService as never,
    );
    const debugSpy = jest
      .spyOn((service as any).logger, 'debug')
      .mockImplementation(() => undefined);
    const adminUserIds = Array.from(
      { length: GLOBAL_SPAMMER_EXEMPTION_HOT_PATH_MAX_ADMIN_IDS + 1 },
      (_, index) => `admin-${index}`,
    );

    try {
      await expect(
        (service as any).resolveGlobalSpammerAdminDecisionsWithHotPathBudget(
          ['user-1'],
          adminUserIds,
          {
            chatId: 'chat-1',
            userId: 'user-1',
            messageId: 'message-1',
          },
        ),
      ).resolves.toEqual(new Map());

      expect(prisma.adminGlobalSpammerExemption.findMany).not.toHaveBeenCalled();
      expect(runtimeDiagnosticsService.recordHotPathStageOutcome).toHaveBeenCalledWith({
        stage: 'global-spammer-exempt.budget',
        outcome: 'skip',
        failOpen: true,
      });
      expect(debugSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          chatId: 'chat-1',
          userId: 'user-1',
          messageId: 'message-1',
          adminCount: GLOBAL_SPAMMER_EXEMPTION_HOT_PATH_MAX_ADMIN_IDS + 1,
        }),
        'Skipped global spammer admin exemption lookup because the admin roster is too large for the hot path',
      );
    } finally {
      debugSpy.mockRestore();
    }
  });

  it('fails open when developer-forced global spammer cache lookup exceeds the hot-path budget', async () => {
    jest.useFakeTimers();
    const runtimeDiagnosticsService = {
      recordHotPathStageOutcome: jest.fn(),
    };
    const cacheLookupGate = createDeferred<string | null>();
    const redisCounter = {
      getString: jest.fn(() => cacheLookupGate.promise),
    };
    const service = new ModerationService(
      { globalSpammer: { findFirst: jest.fn().mockResolvedValue(null) } } as never,
      { detect: jest.fn() } as never,
      { resolveAction: jest.fn() } as never,
      {} as never,
      undefined,
      undefined,
      undefined,
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
    const debugSpy = jest
      .spyOn((service as any).logger, 'debug')
      .mockImplementation(() => undefined);
    const resolveCachedSpammer = jest.spyOn(service as any, 'isDeveloperForcedGlobalSpammerCached');

    try {
      const resultPromise = (service as any).isDeveloperForcedGlobalSpammerCachedWithHotPathBudget(
        'user-1',
        {
          chatId: 'chat-1',
          messageId: 'message-1',
        },
      );

      await jest.advanceTimersByTimeAsync(0);
      expect(redisCounter.getString).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(DEVELOPER_FORCED_GLOBAL_SPAMMER_HOT_PATH_TIMEOUT_MS);

      await expect(resultPromise).resolves.toBe(false);
      expect(runtimeDiagnosticsService.recordHotPathStageOutcome).toHaveBeenCalledWith({
        stage: 'developer-forced-global-spammer.budget',
        outcome: 'timeout',
        failOpen: true,
      });
      expect(debugSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          chatId: 'chat-1',
          userId: 'user-1',
          messageId: 'message-1',
          timeoutMs: DEVELOPER_FORCED_GLOBAL_SPAMMER_HOT_PATH_TIMEOUT_MS,
        }),
        'Developer-forced global spammer lookup exceeded hot-path budget; continuing fail-open',
      );
    } finally {
      cacheLookupGate.resolve(null);
      const cacheLookupResult = resolveCachedSpammer.mock.results[0];
      if (cacheLookupResult?.type === 'return') {
        await cacheLookupResult.value;
      }
      resolveCachedSpammer.mockRestore();
      debugSpy.mockRestore();
      jest.useRealTimers();
    }
  });
});
