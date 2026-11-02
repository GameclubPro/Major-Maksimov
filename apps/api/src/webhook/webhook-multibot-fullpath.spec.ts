import { randomUUID } from 'node:crypto';
import type { MaxUpdate } from '@maxim/contracts';
import { Queue, QueueEvents, Worker, type ConnectionOptions, type Job } from 'bullmq';
import {
  createMultibotHarness,
  type MultibotHarness,
} from './webhook-multibot-fullpath.spec-support';
import { AdminService } from '../admin/admin.service';
import { MaxApiInternalRateLimitError, type MaxActionJob } from '../max/max-client.service';
import { MaxActionDispatchService } from '../max/max-action-dispatch.service';
import { MaxActionLedgerService } from '../max/max-action-ledger.service';
import { MaxActionProcessor } from '../max/max-action.processor';
import { ManagedEntityAccessLossService } from '../max/managed-entity-access-loss.service';
import { MessageRetentionStore } from '../message-retention/message-retention-store.service';
import { DefaultWebhookLeaseManagerService } from '../moderation/default-webhook-lease-manager.service';
import { WebhookCanonicalExecutionService } from '../moderation/webhook-canonical-execution.service';
import { digestDuplicateContent } from '../moderation/message-duplicate/message-duplicate-content';
import { MESSAGE_DUPLICATE_HISTORY_FENCE_STORAGE_VERSION } from '../moderation/message-duplicate/message-duplicate-window.script';
import {
  BackgroundWebhookProcessor,
  JOIN_WEBHOOK_SHARD_PROCESSORS,
} from '../moderation/moderation.service';
import type { WebhookHotPathProfile } from '../moderation/moderation.service.support';
import { Prisma } from '../prisma/prisma-client';
import { MULTIBOT_EXECUTION_AUTHORITY_VERSION } from './webhook-semantic-authority';
import { buildWebhookSemanticEventKey } from './webhook-semantic-event-key';
import { DORMANT_BOT_OBSERVATION_MARKER } from './webhook-dormant-observation';
import { WebhookParser } from './webhook.parser';
import type { ProcessWebhookJob } from './webhook-queues';
import type { QueueMetricsService } from '../system/queue-metrics.service';

const databaseUrl = process.env.CHAT_ROUTING_POSTGRES_RACE_DATABASE_URL?.trim() ?? '';
const redisUrl = process.env.MAXIM_TEST_REDIS_URL?.trim() ?? '';
const describeStores = databaseUrl && redisUrl ? describe : describe.skip;
jest.setTimeout(60_000);

describeStores('native multibot ingress → outbox → moderation → guarded simulated MAX', () => {
  let h: MultibotHarness | undefined;
  afterEach(async () => {
    await h?.dispose();
    h = undefined;
  });

  async function fixture(
    bots: number,
    mode: 'off' | 'shadow' | 'on' = 'shadow',
    recoverDueDeletes = false,
  ) {
    h = await createMultibotHarness({ databaseUrl, redisUrl, bots, mode, recoverDueDeletes });
    return h;
  }

  async function mirrors(
    harness: MultibotHarness,
    chatId: string,
    messageId: string,
    text: string,
    type: 'message_created' | 'message_edited' = 'message_created',
    at = Date.now(),
  ) {
    return Promise.all(
      harness.bots.map((bot) =>
        harness.ingest({ chatId, messageId, text, botId: bot.id, type, at }),
      ),
    );
  }

  it('keeps a persisted chat shard and drains independent work while advisory metrics hang', async () => {
    const s = await fixture(2, 'on');
    await s.pause();
    const [chatId, independentChatId] = await s.seedCatalog(2, { maxMessageLengthEnabled: false });
    const owner = await s.ingest({
      chatId: chatId!,
      messageId: randomUUID(),
      text: 'Fixture owner',
      botId: s.bots[0]!.id,
    });
    await s.pumpWork();
    const queued = await s.prisma.webhookEvent.findUniqueOrThrow({ where: { id: owner } });
    expect(queued.status).toBe('QUEUED');
    expect(queued.queueName).toBeTruthy();
    const state = s.routing as unknown as {
      queueMetricsService: Pick<QueueMetricsService, 'getWebhookDefaultShardSnapshot'>;
      removeAssignment(key: string): void;
    };
    state.removeAssignment(`chat:${chatId!}`);
    const metrics = jest
      .spyOn(state.queueMetricsService, 'getWebhookDefaultShardSnapshot')
      .mockImplementation(() => new Promise(() => undefined));
    try {
      const following = await s.ingest({
        chatId: chatId!,
        messageId: randomUUID(),
        text: 'Fixture following',
        botId: s.bots[0]!.id,
      });
      const pending = await s.prisma.webhookEvent.findUniqueOrThrow({ where: { id: following } });
      await expect(s.routing.resolveQueueName(following, pending.normalizedPayload)).resolves.toBe(
        queued.queueName,
      );
      expect(metrics).not.toHaveBeenCalled();
      const independent = await s.ingest({
        chatId: independentChatId!,
        messageId: randomUUID(),
        text: 'Fixture independent',
        botId: s.bots[0]!.id,
      });
      await s.resume();
      await s.drain();
      const receipts = await s.prisma.webhookEvent.findMany({
        where: { id: { in: [owner, following, independent] } },
        select: { id: true, status: true },
      });
      expect(receipts).toHaveLength(3);
      expect(receipts.every((row) => row.status === 'PROCESSED')).toBe(true);
      for (const id of [owner, following, independent])
        expect(s.processedIds.filter((processed) => processed === id)).toHaveLength(1);
      expect(metrics).toHaveBeenCalledTimes(1);
    } finally {
      metrics.mockRestore();
    }
  });

  it.each(['before', 'after'] as const)(
    'completes an owner and mirror when an optional duplicate explanation fails %s its budget',
    async (failureTiming) => {
      const s = await fixture(2, 'on');
      await s.pause();
      const [chatId, independentChatId] = await s.seedCatalog(2, {
        maxMessageLengthEnabled: false,
      });
      const messageId = randomUUID();
      const at = Date.now();
      const ownerId = await s.ingest({
        chatId: chatId!,
        messageId,
        text: 'Fixture duplicate',
        botId: s.bots[0]!.id,
        at,
      });
      const mirrorId = await s.ingest({
        chatId: chatId!,
        messageId,
        text: 'Fixture duplicate',
        botId: s.bots[1]!.id,
        at,
      });
      await s.ingress.preparePersistedWebhookEvent(ownerId);
      const claim = await s.prisma.webhookExecutionClaim.findFirstOrThrow({
        where: { kind: 'EXECUTION', webhookEventId: ownerId },
      });
      const optionalError = new Error('Fixture duplicate explanation failure');
      let rejectExplanation!: (error: Error) => void;
      const pendingExplanation = new Promise<void>((_resolve, reject) => {
        rejectExplanation = reject;
      });
      const explanation = jest.fn(() =>
        failureTiming === 'before' ? Promise.reject(optionalError) : pendingExplanation,
      );
      const confirmedDeletion = jest.fn().mockResolvedValue({ success: true });
      const helper = s.moderation as unknown as {
        runWebhookFollowUpWithBudget(params: {
          stage: string;
          hotPathProfile: WebhookHotPathProfile;
          chatId: string;
          messageId: string;
          maxWaitMs: number;
          task: () => Promise<void>;
        }): Promise<void>;
      };
      const handleUpdate = s.moderation.handleUpdate.bind(s.moderation);
      const handler = jest
        .spyOn(s.moderation, 'handleUpdate')
        .mockImplementation(async (...args) => {
          const [update, profile] = args;
          if (update.message?.messageId !== messageId) return handleUpdate(...args);
          // FLAG: This fixture isolates completion after confirmed core work. It invokes the
          // real budget helper and canonical SQL path, without dispatching a live MAX action.
          await confirmedDeletion();
          expect(profile).toBeDefined();
          profile!.successBoundaryReached = true;
          profile!.successBoundaryStage = 'duplicate-delete';
          await helper.runWebhookFollowUpWithBudget({
            stage: 'duplicate-follow-up',
            hotPathProfile: profile!,
            chatId: chatId!,
            messageId,
            maxWaitMs: 5,
            task: explanation,
          });
        });

      try {
        await expect(s.moderation.processWebhookEvent(ownerId)).resolves.toBeUndefined();
        if (failureTiming === 'after') {
          rejectExplanation(optionalError);
          await pendingExplanation.catch(() => undefined);
        }
        await s.ingress.preparePersistedWebhookEvent(mirrorId);
        await s.moderation.processWebhookEvent(mirrorId);
        await s.moderation.processWebhookEvent(ownerId);
        await s.moderation.processWebhookEvent(mirrorId);

        expect(
          await s.prisma.webhookEvent.findUniqueOrThrow({ where: { id: ownerId } }),
        ).toMatchObject({
          status: 'PROCESSED',
          errorMessage: null,
          nextEnqueueAt: null,
        });
        expect(
          await s.prisma.webhookEvent.findUniqueOrThrow({ where: { id: mirrorId } }),
        ).toMatchObject({
          status: 'DUPLICATE',
          nextEnqueueAt: null,
        });
        expect(
          await s.prisma.webhookExecutionClaim.findUniqueOrThrow({ where: { id: claim.id } }),
        ).toMatchObject({
          status: 'COMPLETED',
          preparedAt: claim.preparedAt,
          businessStartedAt: expect.any(Date),
          completedAt: expect.any(Date),
          leaseToken: null,
          leaseExpiresAt: null,
          commandResult: { kind: 'EXECUTION_FINISHED' },
        });
        expect(handler).toHaveBeenCalledTimes(1);
        expect(confirmedDeletion).toHaveBeenCalledTimes(1);
        expect(explanation).toHaveBeenCalledTimes(1);

        for (const nextChatId of [chatId!, independentChatId!]) {
          const nextId = await s.ingest({
            chatId: nextChatId,
            messageId: randomUUID(),
            text: 'Next message',
            at: at + 1,
          });
          await s.ingress.preparePersistedWebhookEvent(nextId);
          await s.moderation.processWebhookEvent(nextId);
          expect(
            await s.prisma.webhookEvent.findUniqueOrThrow({ where: { id: nextId } }),
          ).toMatchObject({
            status: 'PROCESSED',
          });
        }
        expect(handler).toHaveBeenCalledTimes(3);
        expect(confirmedDeletion).toHaveBeenCalledTimes(1);
        expect(explanation).toHaveBeenCalledTimes(1);
        expect(s.effects).toEqual([]);
      } finally {
        if (failureTiming === 'after') {
          rejectExplanation(optionalError);
          await pendingExplanation.catch(() => undefined);
        }
        handler.mockRestore();
      }
    },
  );

  async function adminCommandFixture(at = Date.now(), savedDeadlineMs?: number) {
    const s = await fixture(9);
    const [chatId] = await s.seedCatalog(1);
    s.allowAdminUser('fixture-user');
    await s.prisma.chatAdminAllowlist.create({ data: { chatId: chatId!, userId: 'fixture-user' } });
    const admin = Object.create(AdminService.prototype) as AdminService;
    Object.assign(admin, {
      prisma: s.prisma,
      chatContextCache: s.cache,
      superBanDeveloperUserIds: new Set(),
      assertChatAdmin: async () => undefined,
      ensureEntityType: async () => undefined,
      scheduleDestructiveModerationAdminRosterWarmup: () => undefined,
    });
    Object.assign(s.moderation, { injectedManualModerationService: admin });
    await s.pause();
    const receipts = await mirrors(
      s,
      chatId!,
      `silence-${randomUUID()}`,
      'тишина 12',
      'message_created',
      at,
    );
    if (savedDeadlineMs !== undefined) {
      await s.prisma.webhookEvent.updateMany({
        where: { id: { in: receipts } },
        data: { executionDeadlineAt: new Date(Date.now() + savedDeadlineMs) },
      });
    }
    await s.ingress.preparePersistedWebhookEvent(receipts[0]!);
    const handler = jest.spyOn(s.moderation, 'handleUpdate');
    const assert = s.groupCommands.assertOwned.bind(s.groupCommands);
    let guards = 0;
    const guardFailure = jest
      .spyOn(s.groupCommands, 'assertOwned')
      .mockImplementation(async (...args) => {
        guards += 1;
        if (guards === 2) throw new Error('Fixture predispatch command lease rejection');
        await assert(...args);
      });
    await expect(s.moderation.processWebhookEvent(receipts[0]!)).rejects.toThrow(
      'notice delivery remains pending',
    );
    guardFailure.mockRestore();
    const started = await s.prisma.webhookExecutionClaim.findFirstOrThrow({
      where: {
        kind: 'EXECUTION',
        webhookEventId: receipts[0],
      },
    });
    expect(started.commandResult).toMatchObject({ kind: 'COMMAND_NOTICE_PENDING' });
    expect(s.effects.filter((effect) => effect.method === 'post')).toEqual([]);
    return { s, chatId: chatId!, receipts, handler, started };
  }

  async function privateDialogFixture(
    type = 'message_callback',
    options: { chatId?: string; entityType?: 'chat' | 'channel'; prepare?: boolean } = {},
  ) {
    const s = await fixture(2, 'on');
    await s.pause();
    const chatId =
      options.chatId ?? String(BigInt(`0x${randomUUID().replaceAll('-', '').slice(0, 12)}`) + 1n);
    const botId = s.bots[1]!.id;
    const id = await s.ingest({ chatId, messageId: randomUUID(), text: '/start', botId });
    const receipt = await s.prisma.webhookEvent.findUniqueOrThrow({ where: { id } });
    const stored = receipt.normalizedPayload as unknown as MaxUpdate;
    const update = {
      ...stored,
      type,
      message: {
        ...stored.message!,
        ...(options.entityType ? { entityType: options.entityType } : {}),
      },
      raw: {
        ...(stored.raw as Record<string, unknown>),
        update_type: type,
        ...(type === 'message_callback' ? { callback: { callback_id: randomUUID() } } : {}),
      },
    } as MaxUpdate;
    const semanticKey = buildWebhookSemanticEventKey(update)!;
    expect(semanticKey).toEqual(expect.any(String));
    await s.prisma.webhookEvent.update({
      where: { id },
      data: {
        normalizedPayload: update as unknown as Prisma.InputJsonValue,
        rawPayload: update.raw as Prisma.InputJsonValue,
        semanticKey,
        executionDeadlineAt: null,
      },
    });
    if (options.prepare !== false) {
      await expect(s.ingress.preparePersistedWebhookEvent(id)).resolves.toMatchObject({
        canonical: true,
        prepared: true,
        executionBotId: botId,
      });
    } else {
      await s.prisma.webhookExecutionClaim.create({
        data: {
          kind: 'EXECUTION',
          semanticKey,
          webhookEventId: id,
          executionBotId: botId,
          enforced: true,
          status: 'READY',
          preparedAt: new Date(),
        },
      });
    }
    await s.prisma.webhookEvent.update({ where: { id }, data: { status: 'QUEUED' } });
    return { s, id, botId, chatId, semanticKey };
  }

  it.each(
    ['bot_started', 'bot_stopped', 'dialog_removed', 'message_callback', 'message_created'].flatMap(
      (type) => [false, true].map((nullExecutor) => ({ type, nullExecutor })),
    ),
  )(
    'completes private dialog $type with null executor=$nullExecutor once without group readiness',
    async ({ type, nullExecutor }) => {
      const f = await privateDialogFixture(type);
      const readiness = jest.spyOn(f.s.readiness, 'ensureReady').mockResolvedValue(null);
      if (nullExecutor)
        await f.s.prisma.webhookExecutionClaim.updateMany({
          where: { webhookEventId: f.id },
          data: { executionBotId: null },
        });
      const context = await f.s.canonical.prepareExecution(f.id, f.s.bots[0]!.id);
      expect(context).toMatchObject({
        activeBotId: f.botId,
        businessLeaseToken: expect.any(String),
      });
      expect(
        await f.s.prisma.webhookExecutionClaim.findFirstOrThrow({
          where: { webhookEventId: f.id },
        }),
      ).toMatchObject({
        executionBotId: f.botId,
        businessStartedAt: expect.any(Date),
        enforced: true,
      });
      await f.s.canonical.completeExecution(context!);
      expect(
        await f.s.prisma.webhookEvent.findUniqueOrThrow({ where: { id: f.id } }),
      ).toMatchObject({ status: 'PROCESSED' });
      expect(
        await f.s.prisma.webhookExecutionClaim.findFirstOrThrow({
          where: { webhookEventId: f.id },
        }),
      ).toMatchObject({
        status: 'COMPLETED',
        executionBotId: f.botId,
        leaseToken: null,
        leaseExpiresAt: null,
        commandResult: expect.objectContaining({
          kind: 'EXECUTION_FINISHED',
          executionBotId: f.botId,
        }),
      });
      await expect(f.s.canonical.prepareExecution(f.id, f.s.bots[0]!.id)).resolves.toBeNull();
      expect(readiness).not.toHaveBeenCalled();
      expect(await f.s.prisma.chatBotMembership.count({ where: { chatId: f.chatId } })).toBe(0);
      expect(f.s.effects).toEqual([]);
    },
  );

  it.each([
    { chatId: '-10101', entityType: 'chat' as const },
    { chatId: '-10102', entityType: 'channel' as const },
    { chatId: '10103', entityType: 'channel' as const },
    { chatId: 'unknown-private-id', entityType: undefined },
    { chatId: '0', entityType: undefined },
  ])('keeps private dialog exception closed for $chatId / $entityType', async (options) => {
    const f = await privateDialogFixture('message_callback', { ...options, prepare: false });
    const readiness = jest.spyOn(f.s.readiness, 'ensureReady').mockResolvedValue(null);
    await expect(f.s.canonical.prepareExecution(f.id, f.botId)).rejects.toThrow(
      'No eligible moderation executor',
    );
    expect(readiness).toHaveBeenCalledWith({ chatId: f.chatId, preferredBotId: f.botId });
    expect(
      await f.s.prisma.webhookExecutionClaim.findFirstOrThrow({ where: { webhookEventId: f.id } }),
    ).toMatchObject({
      businessStartedAt: null,
      leaseToken: null,
      leaseExpiresAt: null,
    });
  });

  it.each([false, true])(
    'expires a queued callback without an executor with existing waiting checkpoint=%s',
    async (checkpoint) => {
      const f = await privateDialogFixture('message_callback', {
        chatId: '-10104',
        entityType: 'chat',
        prepare: false,
      });
      const receivedAt = new Date(Date.now() - 10 * 60_000);
      const deadline = new Date(receivedAt.getTime() + (checkpoint ? 4 : 5) * 60_000);
      const [migration] = await f.s.prisma.$queryRaw<Array<{ id: string; finishedAt: Date }>>`
        SELECT id, finished_at AS "finishedAt" FROM _prisma_migrations
        WHERE migration_name = '20261005020000_add_multibot_order_fences'
          AND rolled_back_at IS NULL AND finished_at IS NOT NULL
        ORDER BY finished_at DESC LIMIT 1
      `;
      if (!migration) throw new Error('Expected native fixture authority migration');
      // FLAG: Model an old post-migration receipt in the disposable database, then restore
      // its migration cutoff. The real legacy authority reader and SQL clocks stay active.
      await f.s.prisma.$executeRaw`
        UPDATE _prisma_migrations SET finished_at = ${new Date(receivedAt.getTime() - 60_000)}
        WHERE id = ${migration.id}
      `;
      try {
        const stored = await f.s.prisma.webhookEvent.findUniqueOrThrow({ where: { id: f.id } });
        const payload = stored.normalizedPayload as unknown as MaxUpdate;
        const raw = {
          ...(payload.raw as Record<string, unknown>),
          timestamp: receivedAt.getTime(),
        };
        await f.s.prisma.webhookEvent.update({
          where: { id: f.id },
          data: {
            createdAt: receivedAt,
            executionDeadlineAt: checkpoint ? deadline : null,
            rawPayload: raw as Prisma.InputJsonValue,
            normalizedPayload: { ...payload, raw } as unknown as Prisma.InputJsonValue,
          },
        });
        await f.s.prisma.webhookExecutionClaim.updateMany({
          where: { webhookEventId: f.id },
          data: {
            executionBotId: null,
            ...(checkpoint
              ? {
                  commandResult: {
                    kind: 'EXECUTION_WAITING',
                    authorityVersion: MULTIBOT_EXECUTION_AUTHORITY_VERSION,
                    webhookEventId: f.id,
                    semanticKey: f.semanticKey,
                    deadlineAt: deadline.toISOString(),
                  },
                }
              : {}),
          },
        });
        const readiness = jest.spyOn(f.s.readiness, 'ensureReady').mockResolvedValue(null);
        const handler = jest.spyOn(f.s.moderation, 'handleUpdate');

        await expect(f.s.moderation.processWebhookEvent(f.id)).resolves.toBeUndefined();
        const event = await f.s.prisma.webhookEvent.findUniqueOrThrow({ where: { id: f.id } });
        expect(event).toMatchObject({
          executionDeadlineAt: deadline,
          status: 'PROCESSED',
          queueName: null,
          nextEnqueueAt: null,
          normalizedPayload: {
            executionOutcome: { code: 'NO_EXECUTABLE_OWNER', deadlineAt: deadline.toISOString() },
          },
        });
        expect(
          await f.s.prisma.webhookExecutionClaim.findFirstOrThrow({
            where: { webhookEventId: f.id },
          }),
        ).toMatchObject({
          status: 'COMPLETED',
          businessStartedAt: null,
          executionBotId: null,
          leaseToken: null,
          leaseExpiresAt: null,
        });
        await expect(f.s.moderation.processWebhookEvent(f.id)).resolves.toBeUndefined();
        expect(readiness).toHaveBeenCalledTimes(checkpoint ? 0 : 1);
        if (!checkpoint)
          expect(readiness).toHaveBeenCalledWith({ chatId: f.chatId, preferredBotId: f.botId });
        expect(handler).not.toHaveBeenCalled();
        expect(f.s.effects).toEqual([]);
      } finally {
        await f.s.prisma.$executeRaw`
          UPDATE _prisma_migrations SET finished_at = ${migration.finishedAt} WHERE id = ${migration.id}
        `;
      }
    },
  );

  it('persists the original callback deadline across readiness retries', async () => {
    const f = await privateDialogFixture('message_callback', {
      chatId: '-10105',
      entityType: 'chat',
      prepare: false,
    });
    const before = await f.s.prisma.webhookEvent.findUniqueOrThrow({ where: { id: f.id } });
    const deadline = new Date(before.createdAt.getTime() + 5 * 60_000);
    await f.s.prisma.webhookExecutionClaim.updateMany({
      where: { webhookEventId: f.id },
      data: { executionBotId: null },
    });
    const readiness = jest.spyOn(f.s.readiness, 'ensureReady').mockResolvedValue(null);
    const handler = jest.spyOn(f.s.moderation, 'handleUpdate');
    for (let attempt = 0; attempt < 2; attempt++) {
      await expect(f.s.moderation.processWebhookEvent(f.id)).rejects.toThrow(
        'No eligible moderation executor',
      );
      expect(
        await f.s.prisma.webhookEvent.findUniqueOrThrow({ where: { id: f.id } }),
      ).toMatchObject({
        status: 'QUEUED',
        executionDeadlineAt: deadline,
      });
      expect(
        await f.s.prisma.webhookExecutionClaim.findFirstOrThrow({
          where: { webhookEventId: f.id },
        }),
      ).toMatchObject({
        status: 'READY',
        businessStartedAt: null,
        executionBotId: null,
        leaseToken: null,
        leaseExpiresAt: null,
        commandResult: {
          kind: 'EXECUTION_WAITING',
          authorityVersion: MULTIBOT_EXECUTION_AUTHORITY_VERSION,
          webhookEventId: f.id,
          semanticKey: f.semanticKey,
          deadlineAt: deadline.toISOString(),
        },
      });
    }
    expect(readiness).toHaveBeenCalledTimes(2);
    expect(handler).not.toHaveBeenCalled();
    expect(f.s.effects).toEqual([]);
  });

  it.each(['receipt', 'claim'] as const)(
    'refuses private dialog %s identity mismatches before execution',
    async (changed) => {
      const f = await privateDialogFixture();
      if (changed === 'receipt')
        await f.s.prisma.webhookEvent.update({
          where: { id: f.id },
          data: { botId: f.s.bots[0]!.id },
        });
      else
        await f.s.prisma.webhookExecutionClaim.updateMany({
          where: { webhookEventId: f.id },
          data: { executionBotId: f.s.bots[0]!.id },
        });
      await expect(f.s.canonical.prepareExecution(f.id, f.botId)).rejects.toThrow(
        'Private dialog executor must match receiving bot',
      );
      expect(
        await f.s.prisma.webhookExecutionClaim.findFirstOrThrow({
          where: { webhookEventId: f.id },
        }),
      ).toMatchObject({ businessStartedAt: null, leaseToken: null });
    },
  );

  it('retains private dialog quarantine fences', async () => {
    const f = await privateDialogFixture();
    const readiness = jest.spyOn(f.s.readiness, 'ensureReady');
    await f.s.prisma.webhookEvent.update({
      where: { id: f.id },
      data: {
        status: 'FAILED',
        timeoutQuarantineExpiresAt: new Date(Date.now() + 60_000),
        errorMessage: 'WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINED:fixture: retained',
      },
    });
    await expect(f.s.canonical.prepareExecution(f.id, f.botId)).resolves.toBeNull();
    expect(readiness).not.toHaveBeenCalled();
    expect(
      await f.s.prisma.webhookExecutionClaim.findFirstOrThrow({ where: { webhookEventId: f.id } }),
    ).toMatchObject({ businessStartedAt: null, leaseToken: null });
  });

  it('defers private dialog execution if its null executor changes before the start CAS', async () => {
    const f = await privateDialogFixture();
    await f.s.prisma.webhookExecutionClaim.updateMany({
      where: { webhookEventId: f.id },
      data: { executionBotId: null },
    });
    const originalTransaction = f.s.prisma.$transaction.bind(f.s.prisma);
    const transaction = jest
      .spyOn(f.s.prisma, '$transaction')
      .mockImplementationOnce(async (...args: unknown[]) => {
        await f.s.prisma.webhookExecutionClaim.updateMany({
          where: { webhookEventId: f.id },
          data: { executionBotId: f.s.bots[0]!.id },
        });
        return originalTransaction(...(args as Parameters<typeof originalTransaction>));
      });
    await expect(f.s.canonical.prepareExecution(f.id, f.botId)).rejects.toThrow(
      'Canonical business-start fence changed',
    );
    transaction.mockRestore();
    expect(
      await f.s.prisma.webhookExecutionClaim.findFirstOrThrow({ where: { webhookEventId: f.id } }),
    ).toMatchObject({
      executionBotId: f.s.bots[0]!.id,
      businessStartedAt: null,
      leaseToken: null,
      leaseExpiresAt: null,
    });
  });

  it('defers private dialog execution if its receipt changes before the start CAS', async () => {
    const f = await privateDialogFixture();
    const originalTransaction = f.s.prisma.$transaction.bind(f.s.prisma);
    const transaction = jest
      .spyOn(f.s.prisma, '$transaction')
      .mockImplementationOnce(async (...args: unknown[]) => {
        await f.s.prisma.webhookEvent.update({
          where: { id: f.id },
          data: { botId: f.s.bots[0]!.id },
        });
        return originalTransaction(...(args as Parameters<typeof originalTransaction>));
      });
    await expect(f.s.canonical.prepareExecution(f.id, f.botId)).rejects.toThrow(
      'Canonical business-start fence changed',
    );
    transaction.mockRestore();
    expect(
      await f.s.prisma.webhookExecutionClaim.findFirstOrThrow({ where: { webhookEventId: f.id } }),
    ).toMatchObject({
      executionBotId: f.botId,
      businessStartedAt: null,
      leaseToken: null,
      leaseExpiresAt: null,
    });
  });

  it.each([false, true])(
    'settles actual bot_removed after the last membership is revoked, local preparation retry=%s',
    async (retryPreparation) => {
      const s = await fixture(1, 'on');
      await s.pause();
      const chatId = (await s.seedCatalog(1))[0]!;
      const botId = s.bots[0]!.id;
      const removedAt = Date.now();
      await seedRemovalAccess(s, chatId, botId, removedAt);
      await s.prisma.managedBotChatCatalog.create({
        data: { chatId, botId, status: 'ACTIVE', lastSeenAt: new Date(removedAt - 1_000) },
      });
      const cleanupQueue = { add: jest.fn().mockResolvedValue({}) };
      const roster = { scheduleChatAdminRosterSync: jest.fn().mockResolvedValue(undefined) };
      Object.assign(s.ingress, {
        chatContextCache: s.cache,
        membershipLookupService: s.membership,
        maxChatAdminRosterSyncService: roster,
        managedEntityAccessLossService: new ManagedEntityAccessLossService(
          s.prisma as never,
          s.links,
          s.cache,
          undefined,
          cleanupQueue as never,
        ),
      });
      const update = new WebhookParser().parse(
        {
          update_id: randomUUID(),
          update_type: 'bot_removed',
          chat_id: chatId,
          timestamp: removedAt,
          user: { user_id: 'fixture-user', first_name: 'Fixture actor' },
          callback: {
            callback_id: randomUUID(),
            payload: 'injected-poll-callback',
            user: { user_id: 'fixture-user' },
          },
        },
        { botId },
      );
      expect(update.membership).toEqual({ action: 'removed', memberUserIds: [botId] });
      const id = (await s.ingress.storeReceipt(update, null)).webhookEventId!;
      s.receiptIds.push(id);
      const handler = jest.spyOn(s.moderation, 'handleUpdate');
      const poll = {
        tryHandleCallback: jest
          .fn()
          .mockRejectedValue(new Error('Removed bot cannot dispatch poll effects')),
      };
      Object.assign(s.moderation, { managedPollService: poll });
      if (retryPreparation) {
        const readModels = jest
          .spyOn(
            s.ingress as unknown as { persistAdminReadModels(update: MaxUpdate): Promise<void> },
            'persistAdminReadModels',
          )
          .mockRejectedValueOnce(new Error('Fixture local read models pending'));
        await expect(s.ingress.preparePersistedWebhookEvent(id)).rejects.toThrow(
          'Fixture local read models pending',
        );
        expect(
          await s.prisma.webhookExecutionClaim.findFirstOrThrow({
            where: { webhookEventId: id, kind: 'EXECUTION' },
          }),
        ).toMatchObject({ status: 'PENDING', preparedAt: null, businessStartedAt: null });
        expect(
          await s.prisma.chatBotMembership.findUniqueOrThrow({
            where: { chatId_botId: { chatId, botId } },
          }),
        ).toMatchObject({ status: 'REMOVED', lifecycleEventType: 'bot_removed' });
        await expect(s.moderation.processWebhookEvent(id)).rejects.toThrow(
          'Canonical webhook claim is not ready',
        );
        expect(handler).not.toHaveBeenCalled();
        expect(s.effects).toEqual([]);
        readModels.mockRestore();
      }
      await expect(s.ingress.preparePersistedWebhookEvent(id)).resolves.toMatchObject({
        canonical: true,
        prepared: true,
        executionBotId: null,
      });
      const prepared = await s.prisma.webhookExecutionClaim.findFirstOrThrow({
        where: { webhookEventId: id, kind: 'EXECUTION' },
      });
      expect(prepared).toMatchObject({
        status: 'READY',
        preparedAt: expect.any(Date),
        businessStartedAt: null,
        executionBotId: null,
        commandResult: null,
      });
      const removedMembership = await s.prisma.chatBotMembership.findUniqueOrThrow({
        where: { chatId_botId: { chatId, botId } },
      });
      expect(removedMembership).toMatchObject({
        status: 'REMOVED',
        role: 'STANDBY',
        lifecycleEventAt: new Date(removedAt),
        lifecycleEventType: 'bot_removed',
        lifecycleSource: 'webhook',
      });
      expect(await s.prisma.chat.findUniqueOrThrow({ where: { id: chatId } })).toMatchObject({
        primaryBotId: null,
        botId: null,
        routingState: 'NO_ELIGIBLE_BOT',
      });
      expect(
        await s.prisma.managedEntityAccessEdge.findUniqueOrThrow({
          where: { chatId_userId_botId: { chatId, userId: 'fixture-user', botId } },
        }),
      ).toMatchObject({ state: 'BOT_DENIED', deniedReason: 'bot_removed' });
      expect(await s.prisma.managedEntityAdminMember.count({ where: { chatId } })).toBe(0);
      expect(
        await s.prisma.managedBotChatCatalog.findUniqueOrThrow({
          where: { botId_chatId: { chatId, botId } },
        }),
      ).toMatchObject({ status: 'REMOVED' });
      expect(cleanupQueue.add).toHaveBeenCalled();
      expect(roster.scheduleChatAdminRosterSync).toHaveBeenCalled();
      expect(await s.readiness.ensureReady({ chatId })).toBeNull();
      const readiness = jest.spyOn(s.readiness, 'ensureReady');
      await s.moderation.processWebhookEvent(id);
      await s.moderation.processWebhookEvent(id);
      expect(await s.prisma.webhookEvent.findUniqueOrThrow({ where: { id } })).toMatchObject({
        status: 'PROCESSED',
      });
      expect(
        await s.prisma.webhookExecutionClaim.findUniqueOrThrow({ where: { id: prepared.id } }),
      ).toMatchObject({
        status: 'COMPLETED',
        preparedAt: prepared.preparedAt,
        businessStartedAt: expect.any(Date),
        executionBotId: botId,
        commandResult: expect.objectContaining({ kind: 'EXECUTION_FINISHED' }),
        leaseToken: null,
        leaseExpiresAt: null,
      });
      expect(
        await s.prisma.chatBotMembership.findUniqueOrThrow({
          where: { chatId_botId: { chatId, botId } },
        }),
      ).toEqual(removedMembership);
      expect(readiness).not.toHaveBeenCalled();
      expect(handler).not.toHaveBeenCalled();
      expect(poll.tryHandleCallback).not.toHaveBeenCalled();
      expect(s.effects).toEqual([]);
    },
  );

  async function seedRemovalAccess(
    s: MultibotHarness,
    chatId: string,
    botId: string,
    removedAt: number,
  ) {
    const checkedAt = new Date(removedAt - 1_000);
    await s.prisma.chatAdminAllowlist.create({ data: { chatId, userId: 'fixture-user' } });
    await s.prisma.managedEntityAccessEdge.create({
      data: {
        chatId,
        userId: 'fixture-user',
        botId,
        state: 'GRANTED',
        userRole: 'ADMIN',
        botRole: 'ADMIN',
        checkedAt,
      },
    });
    await s.prisma.managedEntityAdminMember.create({
      data: { chatId, userId: 'fixture-user', observedByBotId: botId, checkedAt },
    });
  }

  it.each([false, true])(
    'persists user_removed denial without probing a dormant sole bot, stored owner=%s',
    async (keepStoredOwner) => {
      const s = await fixture(1, 'on');
      await s.pause();
      const chatId = (await s.seedCatalog(1))[0]!;
      const botId = s.bots[0]!.id;
      await s.demote(chatId, botId);
      expect(await s.readiness.ensureReady({ chatId })).toBeNull();
      if (keepStoredOwner)
        await s.prisma.chat.update({
          where: { id: chatId },
          data: { primaryBotId: botId, botId, routingState: 'READY' },
        });
      const removedAt = Date.now();
      await seedRemovalAccess(s, chatId, botId, removedAt);
      const update = new WebhookParser().parse(
        {
          update_id: randomUUID(),
          update_type: 'user_removed',
          chat_id: chatId,
          timestamp: removedAt,
          user: { user_id: 'fixture-user', first_name: 'Fixture removed' },
          callback: {
            callback_id: randomUUID(),
            payload: 'injected-poll-callback',
            user: { user_id: 'fixture-user' },
          },
        },
        { botId },
      );
      const id = (await s.ingress.storeReceipt(update, null)).webhookEventId!;
      s.receiptIds.push(id);
      const readiness = jest.spyOn(s.readiness, 'ensureReady');
      const handler = jest.spyOn(s.moderation, 'handleUpdate');
      const cachePublication = jest.spyOn(s.cache, 'applyAdminAccessEpochMutation');
      const roster = {
        scheduleChatAdminRosterSync: jest.fn().mockResolvedValue(undefined),
      };
      const poll = { tryHandleCallback: jest.fn() };
      Object.assign(s.ingress, {
        chatContextCache: s.cache,
        membershipLookupService: s.membership,
        maxChatAdminRosterSyncService: roster,
      });
      Object.assign(s.moderation, { managedPollService: poll });
      const requestCount = s.requests.length;
      const dormantMembership = await s.prisma.chatBotMembership.findUniqueOrThrow({
        where: { chatId_botId: { chatId, botId } },
      });
      await expect(s.ingress.preparePersistedWebhookEvent(id)).resolves.toMatchObject({
        canonical: true,
        prepared: true,
        executionBotId: null,
      });
      expect(
        await s.prisma.webhookExecutionClaim.findFirstOrThrow({ where: { webhookEventId: id } }),
      ).toMatchObject({
        status: 'READY',
        preparedAt: expect.any(Date),
        businessStartedAt: null,
      });
      expect(
        await s.prisma.managedEntityAccessEdge.findUniqueOrThrow({
          where: { chatId_userId_botId: { chatId, userId: 'fixture-user', botId } },
        }),
      ).toMatchObject({
        state: 'USER_DENIED',
        checkedAt: new Date(removedAt),
        source: 'webhook_user_removed',
      });
      expect(await s.prisma.chatAdminAllowlist.count({ where: { chatId } })).toBe(0);
      expect(await s.prisma.managedEntityAdminMember.count({ where: { chatId } })).toBe(0);
      expect(cachePublication).toHaveBeenCalledWith(
        expect.objectContaining({ chatId, userId: 'fixture-user', state: 'user_denied' }),
        expect.any(Object),
      );
      await expect(s.ingress.preparePersistedWebhookEvent(id)).resolves.toMatchObject({
        canonical: true,
        prepared: true,
        executionBotId: null,
      });
      expect(
        await s.prisma.chatMembershipActivityEvent.count({
          where: { chatId, userId: 'fixture-user', eventType: 'user_removed' },
        }),
      ).toBe(1);
      expect(
        await s.prisma.chatUserDisplayName.findUniqueOrThrow({
          where: { chatId_userId: { chatId, userId: 'fixture-user' } },
        }),
      ).toMatchObject({ displayName: 'Fixture removed', observedAt: new Date(removedAt) });
      const membership = await s.prisma.chatBotMembership.findUniqueOrThrow({
        where: { chatId_botId: { chatId, botId } },
      });
      expect(membership).toEqual(dormantMembership);
      await s.moderation.processWebhookEvent(id);
      await s.moderation.processWebhookEvent(id);
      expect(await s.prisma.webhookEvent.findUniqueOrThrow({ where: { id } })).toMatchObject({
        status: 'PROCESSED',
      });
      expect(
        await s.prisma.webhookExecutionClaim.findFirstOrThrow({ where: { webhookEventId: id } }),
      ).toMatchObject({
        status: 'COMPLETED',
        executionBotId: botId,
        preparedAt: expect.any(Date),
        commandResult: expect.objectContaining({ kind: 'EXECUTION_FINISHED' }),
      });
      expect(
        await s.prisma.chatBotMembership.findUniqueOrThrow({
          where: { chatId_botId: { chatId, botId } },
        }),
      ).toEqual(membership);
      expect(roster.scheduleChatAdminRosterSync).not.toHaveBeenCalled();
      expect(readiness).not.toHaveBeenCalled();
      expect(handler).not.toHaveBeenCalled();
      expect(poll.tryHandleCallback).not.toHaveBeenCalled();
      expect(s.requests).toHaveLength(requestCount);
      expect(s.effects).toEqual([]);
    },
  );

  async function botAddedObservationFixture() {
    const s = await fixture(2, 'on');
    await s.pause();
    const chatId = (await s.seedCatalog(1))[0]!;
    const botId = s.bots[1]!.id;
    await s.prisma.chatBotMembership.deleteMany({ where: { chatId } });
    await s.prisma.chat.update({
      where: { id: chatId },
      data: { primaryBotId: null, botId: null, routingState: 'NO_ELIGIBLE_BOT' },
    });
    const update = new WebhookParser().parse(
      {
        update_id: randomUUID(),
        update_type: 'bot_added',
        chat_id: chatId,
        timestamp: Date.now(),
        user: { user_id: 'fixture-user', first_name: 'Fixture administrator' },
        callback: { callback_id: randomUUID(), payload: 'injected-poll-callback' },
        new_members: [{ user_id: 'injected-member', is_bot: false }],
      },
      { botId },
    );
    const id = (await s.ingress.storeReceipt(update, null)).webhookEventId!;
    s.receiptIds.push(id);
    const readiness = jest.spyOn(s.readiness, 'ensureReady');
    await s.ingress.preparePersistedWebhookEvent(id);
    expect(readiness).not.toHaveBeenCalled();
    expect(s.requests).toEqual([]);
    await s.prisma.webhookEvent.update({ where: { id }, data: { status: 'QUEUED' } });
    expect(await s.readiness.ensureReady({ chatId })).toBeNull();
    readiness.mockClear();
    const handler = jest.spyOn(s.moderation, 'handleUpdate');
    const poll = { tryHandleCallback: jest.fn().mockResolvedValue(false) };
    Object.assign(s.moderation, { managedPollService: poll });
    return { s, id, chatId, botId, readiness, handler, poll };
  }

  it.each(['receiving', 'null', 'peer'] as const)(
    'settles prepared bot_added without activating its dormant receiving bot, executor=%s',
    async (executor) => {
      const f = await botAddedObservationFixture();
      const claim = await f.s.prisma.webhookExecutionClaim.findFirstOrThrow({
        where: { webhookEventId: f.id, kind: 'EXECUTION' },
      });
      await f.s.prisma.webhookExecutionClaim.update({
        where: { id: claim.id },
        data: {
          executionBotId:
            executor === 'receiving' ? f.botId : executor === 'peer' ? f.s.bots[0]!.id : null,
        },
      });
      const membership = await f.s.prisma.chatBotMembership.findMany({
        where: { chatId: f.chatId },
      });
      const requests = f.s.requests.length;
      await f.s.moderation.processWebhookEvent(f.id);
      await f.s.moderation.processWebhookEvent(f.id);
      expect(
        await f.s.prisma.webhookEvent.findUniqueOrThrow({ where: { id: f.id } }),
      ).toMatchObject({ status: 'PROCESSED', executionDeadlineAt: null });
      expect(
        await f.s.prisma.webhookExecutionClaim.findUniqueOrThrow({ where: { id: claim.id } }),
      ).toMatchObject({
        status: 'COMPLETED',
        executionBotId: f.botId,
        preparedAt: claim.preparedAt,
        businessStartedAt: expect.any(Date),
        leaseToken: null,
        leaseExpiresAt: null,
        commandResult: expect.objectContaining({ kind: 'EXECUTION_FINISHED' }),
      });
      expect(await f.s.prisma.chatBotMembership.findMany({ where: { chatId: f.chatId } })).toEqual(
        membership,
      );
      expect(f.handler).toHaveBeenCalledTimes(1);
      expect(f.readiness).not.toHaveBeenCalled();
      expect(f.poll.tryHandleCallback).not.toHaveBeenCalled();
      expect(f.s.requests).toHaveLength(requests);
      expect(f.s.effects).toEqual([]);
    },
  );

  it('preserves the explicit bot_added join denylist on the exact receiving bot', async () => {
    const f = await botAddedObservationFixture();
    const leave = jest.spyOn(f.s.max, 'leaveCurrentChat').mockResolvedValue(undefined);
    Object.assign(f.s.moderation, { blockedJoinChatIds: new Set([f.chatId]) });
    await f.s.prisma.webhookExecutionClaim.updateMany({
      where: { webhookEventId: f.id, kind: 'EXECUTION' },
      data: { executionBotId: f.s.bots[0]!.id },
    });
    await f.s.moderation.processWebhookEvent(f.id);
    await f.s.moderation.processWebhookEvent(f.id);
    expect(leave).toHaveBeenCalledTimes(1);
    expect(leave).toHaveBeenCalledWith(f.chatId, { botId: f.botId });
    expect(await f.s.prisma.webhookEvent.findUniqueOrThrow({ where: { id: f.id } })).toMatchObject({
      status: 'PROCESSED',
    });
    expect(f.readiness).not.toHaveBeenCalled();
    expect(f.poll.tryHandleCallback).not.toHaveBeenCalled();
  });

  it.each(['unprepared', 'result', 'identity', 'subject', 'started', 'quarantined'] as const)(
    'retains bot_added observation fences for %s authority',
    async (caseName) => {
      const f = await botAddedObservationFixture();
      const claim = await f.s.prisma.webhookExecutionClaim.findFirstOrThrow({
        where: { webhookEventId: f.id },
      });
      if (caseName === 'unprepared')
        await f.s.prisma.webhookExecutionClaim.update({
          where: { id: claim.id },
          data: { preparedAt: null },
        });
      if (caseName === 'result')
        await f.s.prisma.webhookExecutionClaim.update({
          where: { id: claim.id },
          data: { commandResult: { kind: 'UNVERIFIED_EFFECT' } },
        });
      if (caseName === 'identity')
        await f.s.prisma.webhookEvent.update({
          where: { id: f.id },
          data: { botId: f.s.bots[0]!.id },
        });
      if (caseName === 'subject') {
        const event = await f.s.prisma.webhookEvent.findUniqueOrThrow({ where: { id: f.id } });
        const update = {
          ...(event.normalizedPayload as unknown as MaxUpdate),
          membership: { action: 'added' as const, memberUserIds: ['unrelated-member'] },
        };
        const semanticKey = buildWebhookSemanticEventKey(update)!;
        await f.s.prisma.webhookEvent.update({
          where: { id: f.id },
          data: { normalizedPayload: update as unknown as Prisma.InputJsonValue, semanticKey },
        });
        await f.s.prisma.webhookExecutionClaim.update({
          where: { id: claim.id },
          data: { semanticKey },
        });
      }
      if (caseName === 'started')
        await f.s.prisma.webhookExecutionClaim.update({
          where: { id: claim.id },
          data: { businessStartedAt: new Date() },
        });
      if (caseName === 'quarantined')
        await f.s.prisma.webhookEvent.update({
          where: { id: f.id },
          data: {
            status: 'FAILED',
            errorMessage: 'WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINED:fixture: retained',
          },
        });
      if (caseName === 'started' || caseName === 'quarantined')
        await expect(f.s.moderation.processWebhookEvent(f.id)).resolves.toBeUndefined();
      else
        await expect(f.s.moderation.processWebhookEvent(f.id)).rejects.toThrow(
          'Bot addition observation preparation proof incomplete',
        );
      expect(
        (await f.s.prisma.webhookEvent.findUniqueOrThrow({ where: { id: f.id } })).status,
      ).not.toBe('PROCESSED');
      expect(
        (await f.s.prisma.webhookExecutionClaim.findUniqueOrThrow({ where: { id: claim.id } }))
          .status,
      ).not.toBe('COMPLETED');
      expect(f.handler).not.toHaveBeenCalled();
      expect(f.readiness).not.toHaveBeenCalled();
      expect(f.poll.tryHandleCallback).not.toHaveBeenCalled();
      expect(f.s.effects).toEqual([]);
    },
  );

  it.each(['executor', 'preparation', 'receipt'] as const)(
    'denies prepared bot_added observation %s races at the start CAS',
    async (changed) => {
      const f = await botAddedObservationFixture();
      const claim = await f.s.prisma.webhookExecutionClaim.findFirstOrThrow({
        where: { webhookEventId: f.id },
      });
      await f.s.prisma.webhookExecutionClaim.update({
        where: { id: claim.id },
        data: { executionBotId: null },
      });
      const originalTransaction = f.s.prisma.$transaction.bind(f.s.prisma);
      const transaction = jest
        .spyOn(f.s.prisma, '$transaction')
        .mockImplementationOnce(async (...args: unknown[]) => {
          if (changed === 'receipt')
            await f.s.prisma.webhookEvent.update({
              where: { id: f.id },
              data: { botId: f.s.bots[0]!.id },
            });
          else
            await f.s.prisma.webhookExecutionClaim.update({
              where: { id: claim.id },
              data:
                changed === 'executor' ? { executionBotId: f.s.bots[0]!.id } : { preparedAt: null },
            });
          return originalTransaction(...(args as Parameters<typeof originalTransaction>));
        });
      await expect(f.s.canonical.prepareExecution(f.id, f.s.bots[0]!.id)).rejects.toThrow(
        'Canonical business-start fence changed',
      );
      transaction.mockRestore();
      expect(
        await f.s.prisma.webhookExecutionClaim.findUniqueOrThrow({ where: { id: claim.id } }),
      ).toMatchObject({ businessStartedAt: null, completedAt: null, leaseToken: null });
      expect(f.s.effects).toEqual([]);
    },
  );

  async function messageRemovalObservationFixture(clearPrimary = false) {
    const s = await fixture(2, 'on');
    await s.pause();
    Object.assign(s.ingress, {
      messageRetention: new MessageRetentionStore(s.prisma as never, s.config, s.legacyHolds),
    });
    const chatId = (await s.seedCatalog(1))[0]!;
    for (const bot of s.bots) s.denyBot(bot.id);
    await s.prisma.chatBotMembership.updateMany({
      where: { chatId },
      data: { status: 'REMOVED', botAccessState: 'DENIED' },
    });
    if (clearPrimary)
      await s.prisma.chat.update({
        where: { id: chatId },
        data: { primaryBotId: null, botId: null, routingState: 'NO_ELIGIBLE_BOT' },
      });
    const messageId = randomUUID();
    const raw = {
      update_type: 'message_removed',
      chat_id: chatId,
      message_id: messageId,
      user_id: 'fixture-user',
      timestamp: Date.now(),
      callback: { callback_id: randomUUID(), payload: 'injected-poll-callback' },
    };
    const ingestRemoval = async (botId: string) => {
      const update = new WebhookParser().parse({ ...raw, update_id: randomUUID() }, { botId });
      const receiptId = (await s.ingress.storeReceipt(update, null)).webhookEventId!;
      s.receiptIds.push(receiptId);
      return receiptId;
    };
    const readiness = jest
      .spyOn(s.readiness, 'ensureReady')
      .mockRejectedValue(new Error('A local removal cannot require a moderation executor'));
    const id = await ingestRemoval(s.bots[0]!.id);
    await s.ingress.preparePersistedWebhookEvent(id);
    await s.prisma.webhookEvent.update({ where: { id }, data: { status: 'QUEUED' } });
    const handler = jest.spyOn(s.moderation, 'handleUpdate');
    const remove = jest.spyOn(s.history, 'remove');
    const poll = {
      tryHandleCallback: jest.fn().mockRejectedValue(new Error('Unexpected callback')),
    };
    Object.assign(s.moderation, { managedPollService: poll });
    const tombstone = `dup:window:v1:${digestDuplicateContent(chatId)}:${MESSAGE_DUPLICATE_HISTORY_FENCE_STORAGE_VERSION}:removed:${digestDuplicateContent(messageId)}`;
    return { s, id, chatId, messageId, ingestRemoval, readiness, handler, remove, poll, tombstone };
  }

  it.each([false, true])(
    'settles message_removed and revokes duplicate history without a live route, missing primary=%s',
    async (clearPrimary) => {
      const f = await messageRemovalObservationFixture(clearPrimary);
      const claim = await f.s.prisma.webhookExecutionClaim.findFirstOrThrow({
        where: { webhookEventId: f.id, kind: 'EXECUTION' },
      });
      expect(await f.s.redis.get(f.tombstone)).toBeNull();
      await f.s.moderation.processWebhookEvent(f.id);
      expect(await f.s.redis.get(f.tombstone)).toBe('true');
      const expiry = await f.s.redis.pexpiretime(f.tombstone);
      expect(expiry).toBeGreaterThan(Date.now());
      await f.s.moderation.processWebhookEvent(f.id);
      const mirrorId = await f.ingestRemoval(f.s.bots[1]!.id);
      await f.s.ingress.preparePersistedWebhookEvent(mirrorId);
      await f.s.moderation.processWebhookEvent(mirrorId);
      expect(await f.s.redis.pexpiretime(f.tombstone)).toBe(expiry);
      expect(f.remove).toHaveBeenCalledTimes(1);
      expect(f.remove).toHaveBeenCalledWith(f.chatId, f.messageId);
      expect(f.handler).toHaveBeenCalledTimes(1);
      expect(
        await f.s.prisma.webhookEvent.findUniqueOrThrow({ where: { id: f.id } }),
      ).toMatchObject({
        status: 'PROCESSED',
        executionDeadlineAt: null,
      });
      expect(
        await f.s.prisma.webhookEvent.findUniqueOrThrow({ where: { id: mirrorId } }),
      ).toMatchObject({
        status: 'DUPLICATE',
      });
      expect(
        await f.s.prisma.webhookExecutionClaim.findUniqueOrThrow({ where: { id: claim.id } }),
      ).toMatchObject({
        status: 'COMPLETED',
        preparedAt: claim.preparedAt,
        businessStartedAt: expect.any(Date),
        leaseToken: null,
        leaseExpiresAt: null,
        commandResult: expect.objectContaining({ kind: 'EXECUTION_FINISHED' }),
      });
      expect(
        await f.s.prisma.chatBotMembership.count({ where: { chatId: f.chatId, status: 'ACTIVE' } }),
      ).toBe(0);
      expect(f.readiness).not.toHaveBeenCalled();
      expect(f.poll.tryHandleCallback).not.toHaveBeenCalled();
      expect(f.s.requests).toEqual([]);
      expect(f.s.effects).toEqual([]);
    },
  );

  it.each(['unprepared', 'identity', 'result', 'started'] as const)(
    'keeps message_removed history unchanged for %s canonical authority',
    async (fault) => {
      const f = await messageRemovalObservationFixture();
      const claim = await f.s.prisma.webhookExecutionClaim.findFirstOrThrow({
        where: { webhookEventId: f.id, kind: 'EXECUTION' },
      });
      if (fault === 'identity')
        await f.s.prisma.webhookEvent.update({
          where: { id: f.id },
          data: { botId: f.s.bots[1]!.id },
        });
      else
        await f.s.prisma.webhookExecutionClaim.update({
          where: { id: claim.id },
          data:
            fault === 'unprepared'
              ? { preparedAt: null }
              : fault === 'result'
                ? { commandResult: { kind: 'UNVERIFIED_EFFECT' } }
                : { businessStartedAt: new Date() },
        });
      if (fault === 'started') await f.s.moderation.processWebhookEvent(f.id);
      else
        await expect(f.s.moderation.processWebhookEvent(f.id)).rejects.toThrow(
          'Message removal observation preparation proof incomplete',
        );
      expect(await f.s.redis.get(f.tombstone)).toBeNull();
      expect(f.remove).not.toHaveBeenCalled();
      expect(f.handler).not.toHaveBeenCalled();
      expect(
        (await f.s.prisma.webhookEvent.findUniqueOrThrow({ where: { id: f.id } })).status,
      ).not.toBe('PROCESSED');
      expect(f.s.requests).toEqual([]);
      expect(f.s.effects).toEqual([]);
    },
  );

  async function removedObservationFixture() {
    const s = await fixture(2, 'on');
    await s.pause();
    const chatId = (await s.seedCatalog(1))[0]!;
    await s.prisma.chatAdminAllowlist.create({ data: { chatId, userId: 'fixture-user' } });
    const id = await s.ingest({ chatId, messageId: randomUUID(), text: '', botId: s.bots[1]!.id });
    const event = await s.prisma.webhookEvent.findUniqueOrThrow({ where: { id } });
    const stored = event.normalizedPayload as unknown as MaxUpdate;
    const update: MaxUpdate = {
      ...stored,
      type: 'user_removed',
      membership: { action: 'removed', memberUserIds: ['fixture-user'] },
      raw: {
        ...(stored.raw as Record<string, unknown>),
        update_type: 'user_removed',
        callback: {
          callback_id: randomUUID(),
          payload: 'injected-poll-callback',
          user: { user_id: 'fixture-user' },
        },
      },
    };
    const semanticKey = buildWebhookSemanticEventKey(update)!;
    await s.prisma.webhookEvent.update({
      where: { id },
      data: {
        semanticKey,
        normalizedPayload: update as unknown as Prisma.InputJsonValue,
        rawPayload: update.raw as Prisma.InputJsonValue,
        executionDeadlineAt: null,
      },
    });
    await expect(s.ingress.preparePersistedWebhookEvent(id)).resolves.toMatchObject({
      canonical: true,
      prepared: true,
    });
    expect(
      await s.prisma.chatAdminAllowlist.count({ where: { chatId, userId: 'fixture-user' } }),
    ).toBe(0);
    expect(
      await s.prisma.chatMembershipActivityEvent.count({
        where: { chatId, userId: 'fixture-user', eventType: 'user_removed' },
      }),
    ).toBe(1);
    await s.prisma.webhookEvent.update({ where: { id }, data: { status: 'QUEUED' } });
    await s.prisma.chatBotMembership.updateMany({
      where: { chatId },
      data: { status: 'REMOVED', botAccessState: 'DENIED' },
    });
    const readiness = jest.spyOn(s.readiness, 'ensureReady').mockResolvedValue(null);
    const handler = jest.spyOn(s.moderation, 'handleUpdate');
    const poll = {
      tryHandleCallback: jest
        .fn()
        .mockRejectedValue(new Error('Observation cannot dispatch poll effects')),
    };
    Object.assign(s.moderation, { managedPollService: poll });
    return { s, id, chatId, semanticKey, readiness, handler, poll };
  }

  it.each([false, true])(
    'settles prepared user_removed observation without an eligible route, null executor=%s',
    async (nullExecutor) => {
      const f = await removedObservationFixture();
      const before = await f.s.prisma.webhookExecutionClaim.findFirstOrThrow({
        where: { webhookEventId: f.id },
      });
      if (nullExecutor)
        await f.s.prisma.webhookExecutionClaim.update({
          where: { id: before.id },
          data: { executionBotId: null },
        });
      await f.s.moderation.processWebhookEvent(f.id);
      await f.s.moderation.processWebhookEvent(f.id);
      expect(
        await f.s.prisma.webhookEvent.findUniqueOrThrow({ where: { id: f.id } }),
      ).toMatchObject({ status: 'PROCESSED' });
      expect(
        await f.s.prisma.webhookExecutionClaim.findUniqueOrThrow({ where: { id: before.id } }),
      ).toMatchObject({
        status: 'COMPLETED',
        preparedAt: before.preparedAt,
        businessStartedAt: expect.any(Date),
        executionBotId: nullExecutor ? f.s.bots[1]!.id : before.executionBotId,
        leaseToken: null,
        leaseExpiresAt: null,
        commandResult: expect.objectContaining({ kind: 'EXECUTION_FINISHED' }),
      });
      expect(f.readiness).not.toHaveBeenCalled();
      expect(f.handler).not.toHaveBeenCalled();
      expect(f.poll.tryHandleCallback).not.toHaveBeenCalled();
      expect(f.s.effects).toEqual([]);
    },
  );

  it.each(['unprepared', 'result', 'identity', 'semantic', 'started', 'quarantined'] as const)(
    'retains prepared user_removed observation fences for %s authority',
    async (caseName) => {
      const f = await removedObservationFixture();
      const claim = await f.s.prisma.webhookExecutionClaim.findFirstOrThrow({
        where: { webhookEventId: f.id },
      });
      if (caseName === 'unprepared')
        await f.s.prisma.webhookExecutionClaim.update({
          where: { id: claim.id },
          data: { preparedAt: null },
        });
      if (caseName === 'result')
        await f.s.prisma.webhookExecutionClaim.update({
          where: { id: claim.id },
          data: { commandResult: { kind: 'UNVERIFIED_EFFECT' } },
        });
      if (caseName === 'identity')
        await f.s.prisma.webhookEvent.update({
          where: { id: f.id },
          data: { botId: f.s.bots[0]!.id },
        });
      if (caseName === 'semantic')
        await f.s.prisma.webhookEvent.update({
          where: { id: f.id },
          data: { semanticKey: 'different-semantic-authority' },
        });
      if (caseName === 'started')
        await f.s.prisma.webhookExecutionClaim.update({
          where: { id: claim.id },
          data: { businessStartedAt: new Date() },
        });
      if (caseName === 'quarantined')
        await f.s.prisma.webhookEvent.update({
          where: { id: f.id },
          data: {
            status: 'FAILED',
            errorMessage: 'WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINED:fixture: retained',
          },
        });
      if (caseName === 'started' || caseName === 'quarantined')
        await expect(f.s.moderation.processWebhookEvent(f.id)).resolves.toBeUndefined();
      else
        await expect(f.s.moderation.processWebhookEvent(f.id)).rejects.toThrow(
          'Membership removal observation preparation proof incomplete',
        );
      expect(
        (await f.s.prisma.webhookEvent.findUniqueOrThrow({ where: { id: f.id } })).status,
      ).not.toBe('PROCESSED');
      expect(
        (await f.s.prisma.webhookExecutionClaim.findUniqueOrThrow({ where: { id: claim.id } }))
          .status,
      ).not.toBe('COMPLETED');
      expect(f.handler).not.toHaveBeenCalled();
      expect(f.poll.tryHandleCallback).not.toHaveBeenCalled();
      expect(f.s.effects).toEqual([]);
    },
  );

  it.each(['executor', 'preparation', 'receipt'] as const)(
    'denies prepared user_removed observation %s races at the start CAS',
    async (changed) => {
      const f = await removedObservationFixture();
      const claim = await f.s.prisma.webhookExecutionClaim.findFirstOrThrow({
        where: { webhookEventId: f.id },
      });
      await f.s.prisma.webhookExecutionClaim.update({
        where: { id: claim.id },
        data: { executionBotId: null },
      });
      const originalTransaction = f.s.prisma.$transaction.bind(f.s.prisma);
      const transaction = jest
        .spyOn(f.s.prisma, '$transaction')
        .mockImplementationOnce(async (...args: unknown[]) => {
          if (changed === 'receipt')
            await f.s.prisma.webhookEvent.update({
              where: { id: f.id },
              data: { botId: f.s.bots[0]!.id },
            });
          else
            await f.s.prisma.webhookExecutionClaim.update({
              where: { id: claim.id },
              data:
                changed === 'executor' ? { executionBotId: f.s.bots[0]!.id } : { preparedAt: null },
            });
          return originalTransaction(...(args as Parameters<typeof originalTransaction>));
        });
      await expect(f.s.canonical.prepareExecution(f.id, f.s.bots[0]!.id)).rejects.toThrow(
        'Canonical business-start fence changed',
      );
      transaction.mockRestore();
      expect(
        await f.s.prisma.webhookExecutionClaim.findUniqueOrThrow({ where: { id: claim.id } }),
      ).toMatchObject({ businessStartedAt: null, completedAt: null, leaseToken: null });
      expect(f.s.effects).toEqual([]);
    },
  );

  it.each(
    (['off', 'shadow', 'on'] as const).flatMap((mode) =>
      [1, 3, 4, 6, 9, 12].map((bots) => ({ mode, bots })),
    ),
  )('enforces length once with $bots bots in $mode mode', async ({ bots, mode }) => {
    const s = await fixture(bots, mode);
    const [chatId] = await s.seedCatalog(1);
    const messageId = `length-${randomUUID()}`;
    const inlineDelete = jest.spyOn(s.intents, 'ensureAndAttempt');
    const receipts = await mirrors(
      s,
      chatId!,
      messageId,
      'A long message that exceeds the configured twenty character limit',
    );
    await s.drain();
    expect(
      await s.prisma.webhookEvent.count({ where: { id: { in: receipts }, status: 'PROCESSED' } }),
    ).toBe(1);
    expect(
      await s.prisma.webhookEvent.count({ where: { id: { in: receipts }, status: 'DUPLICATE' } }),
    ).toBe(bots - 1);
    expect(
      await s.prisma.webhookExecutionClaim.count({
        where: { kind: 'EXECUTION', webhookEventId: { in: receipts }, status: 'COMPLETED' },
      }),
    ).toBe(1);
    expect(
      await s.prisma.moderationDeleteIntent.findUnique({
        where: { chatId_messageId: { chatId: chatId!, messageId } },
        select: { status: true, lastErrorCode: true, lastError: true },
      }),
    ).toMatchObject({ status: 'SUCCEEDED' });
    expect(await inlineDelete.mock.results[0]?.value).toMatchObject({
      kind: 'confirmed',
      verifiedReasonKeys: ['MESSAGE_TOO_LONG:violation-delete'],
    });
    expect(await s.prisma.violation.count({ where: { chatId } })).toBe(1);
    expect(
      await s.prisma.moderationDeleteIntent.count({
        where: { chatId, messageId, status: 'SUCCEEDED' },
      }),
    ).toBe(1);
    expect(
      s.effects.filter((effect) => effect.method === 'delete' && effect.messageId === messageId),
    ).toHaveLength(1);
    expect(s.failures).toEqual([]);
  });

  it.each([1, 3, 4, 6, 9, 12])(
    'does not count %i mirrors as repeated user messages',
    async (bots) => {
      const s = await fixture(bots);
      const [chatId] = await s.seedCatalog(1, {
        maxMessageLengthEnabled: false,
        antiDuplicateEnabled: true,
        duplicateCompareMode: 'TEXT',
        duplicateWarnMaxCount: 1,
      });
      const first = `duplicate-original-${randomUUID()}`;
      await mirrors(s, chatId!, first, 'One repeated text');
      await s.drain();
      expect(s.effects.filter((effect) => effect.method === 'delete')).toEqual([]);
      const repeat = `duplicate-repeat-${randomUUID()}`;
      await mirrors(s, chatId!, repeat, 'One repeated text');
      await s.drain();
      expect(
        s.effects.filter((effect) => effect.method === 'delete' && effect.messageId === first),
      ).toEqual([]);
      expect(
        s.effects.filter((effect) => effect.method === 'delete' && effect.messageId === repeat),
      ).toHaveLength(1);
      expect(
        await s.prisma.moderationDeleteIntent.count({
          where: { chatId, messageId: repeat, reasons: { some: { ruleCode: 'DUPLICATE_DELETE' } } },
        }),
      ).toBe(1);
      const intent = await s.prisma.moderationDeleteIntent.findUniqueOrThrow({
        where: { chatId_messageId: { chatId: chatId!, messageId: repeat } },
        include: { reasons: true },
      });
      expect(
        intent.reasons.filter((reason) => reason.ruleCode === 'DUPLICATE_DELETE'),
      ).toHaveLength(1);
      expect(
        intent.reasons.find((reason) => reason.ruleCode === 'DUPLICATE_DELETE')?.metadata,
      ).toMatchObject({ moderationDeleteVerified: true });
    },
  );

  it('keeps edit identity separate and length enforcement independent of duplicate lifecycle', async () => {
    const s = await fixture(9);
    const [chatId] = await s.seedCatalog(1, {
      antiDuplicateEnabled: true,
      duplicateCompareMode: 'TEXT',
    });
    const messageId = `edit-${randomUUID()}`;
    const originalAt = Date.now();
    await mirrors(s, chatId!, messageId, 'short', 'message_created', originalAt);
    await s.drain();
    await mirrors(
      s,
      chatId!,
      messageId,
      'Edited text is now longer than the maximum length',
      'message_edited',
      Math.max(Date.now(), originalAt + 1),
    );
    await s.drain();
    expect(
      await s.prisma.webhookExecutionClaim.count({
        where: { kind: 'EXECUTION', webhookEventId: { in: s.receiptIds }, status: 'COMPLETED' },
      }),
    ).toBe(2);
    expect(await s.prisma.violation.count({ where: { chatId } })).toBe(1);
    expect(
      s.effects.filter((effect) => effect.method === 'delete' && effect.messageId === messageId),
    ).toHaveLength(1);
  });

  it('adopts the surviving peer before business without replacing receipt or deadline', async () => {
    const s = await fixture(12);
    const [chatId] = await s.seedCatalog(1);
    await s.pause();
    const messageId = `demotion-${randomUUID()}`;
    const receipts = await mirrors(
      s,
      chatId!,
      messageId,
      'The first bot is demoted while this long message waits',
    );
    await s.ingress.preparePersistedWebhookEvent(receipts[0]!);
    const before = await s.prisma.webhookExecutionClaim.findFirstOrThrow({
      where: {
        kind: 'EXECUTION',
        webhookEventId: { in: receipts },
      },
      include: { webhookEvent: true },
    });
    for (const bot of s.bots.slice(0, -1)) await s.demote(chatId!, bot.id);
    await s.resume();
    await s.drain();
    const after = await s.prisma.webhookExecutionClaim.findUniqueOrThrow({
      where: { id: before.id },
      include: { webhookEvent: true },
    });
    expect(after.webhookEventId).toBe(before.webhookEventId);
    expect(after.webhookEvent?.executionDeadlineAt).toEqual(
      before.webhookEvent?.executionDeadlineAt,
    );
    expect(after.executionBotId).toBe(s.bots.at(-1)!.id);
    expect(after.status).toBe('COMPLETED');
    expect(
      s.effects.filter((effect) => effect.method === 'delete' && effect.messageId === messageId),
    ).toMatchObject([{ botId: s.bots.at(-1)!.id }]);
  });

  it.each(['successful readiness', 'claim row lock'] as const)(
    'expires the original readiness wait when its deadline crosses during %s',
    async (crossing) => {
      const s = await fixture(4);
      const [chatId] = await s.seedCatalog(1);
      await s.pause();
      const receiptId = await s.ingest({
        chatId: chatId!,
        messageId: `deadline-crossing-${randomUUID()}`,
        text: 'This long message must never enter the engine after its readiness wait expires',
        botId: s.bots[0]!.id,
      });
      // Keep the MAX source genuinely new; exercise the saved narrower SQL deadline.
      await s.prisma.webhookEvent.update({
        where: { id: receiptId },
        data: { executionDeadlineAt: new Date(Date.now() + 1_500) },
      });
      await s.ingress.preparePersistedWebhookEvent(receiptId);
      const claim = await s.prisma.webhookExecutionClaim.findFirstOrThrow({
        where: { kind: 'EXECUTION', webhookEventId: receiptId },
        include: { webhookEvent: true },
      });
      const deadline = claim.webhookEvent!.executionDeadlineAt!;
      expect(deadline.getTime()).toBeGreaterThan(Date.now());
      await s.prisma.webhookExecutionClaim.update({
        where: { id: claim.id },
        data: {
          commandResult: {
            kind: 'EXECUTION_WAITING',
            authorityVersion: MULTIBOT_EXECUTION_AUTHORITY_VERSION,
            webhookEventId: receiptId,
            semanticKey: claim.semanticKey,
            deadlineAt: deadline.toISOString(),
          },
        },
      });
      const handler = jest.spyOn(s.moderation, 'handleUpdate');
      const ensureReady = s.readiness.ensureReady.bind(s.readiness);
      let blocker: Promise<unknown> | undefined;
      let releaseLock: (() => void) | undefined;
      let lockAcquired: (() => void) | undefined;
      const locked = new Promise<void>((resolve) => {
        lockAcquired = resolve;
      });
      const released = new Promise<void>((resolve) => {
        releaseLock = resolve;
      });
      const readiness = jest.spyOn(s.readiness, 'ensureReady').mockImplementation(async (input) => {
        const proof = await ensureReady(input);
        if (crossing === 'claim row lock') {
          blocker = s.prisma.$transaction(
            async (tx) => {
              await tx.$queryRaw(Prisma.sql`
                SELECT "id" FROM "webhook_execution_claims" WHERE "id" = ${claim.id} FOR UPDATE
              `);
              lockAcquired!();
              await released;
            },
            { timeout: 10_000 },
          );
          await locked;
        } else {
          await new Promise((resolve) =>
            setTimeout(resolve, Math.max(0, deadline.getTime() - Date.now()) + 30),
          );
        }
        return proof;
      });
      try {
        const processing = s.moderation.processWebhookEvent(receiptId);
        if (crossing === 'claim row lock') {
          await locked;
          await new Promise((resolve) =>
            setTimeout(resolve, Math.max(0, deadline.getTime() - Date.now()) + 30),
          );
          releaseLock!();
          await blocker;
        }
        await processing;
        const expired = await s.prisma.webhookExecutionClaim.findUniqueOrThrow({
          where: { id: claim.id },
          include: { webhookEvent: true },
        });
        expect(expired.status).toBe('COMPLETED');
        expect(expired.businessStartedAt).toBeNull();
        expect(expired.webhookEvent?.normalizedPayload).toMatchObject({
          executionOutcome: { code: 'NO_EXECUTABLE_OWNER', deadlineAt: deadline.toISOString() },
        });
        expect(handler).not.toHaveBeenCalled();
        expect(s.effects).toEqual([]);
      } finally {
        releaseLock!();
        await blocker;
        readiness.mockRestore();
      }
    },
  );

  it('expires a pending readiness wait after successful preparation crosses its deadline', async () => {
    const s = await fixture(4);
    const [chatId] = await s.seedCatalog(1);
    await s.pause();
    const receiptId = await s.ingest({
      chatId: chatId!,
      messageId: `preparation-deadline-${randomUUID()}`,
      text: 'This waiting preparation must expire even when the last access check succeeds',
      botId: s.bots[0]!.id,
    });
    const event = await s.prisma.webhookEvent.findUniqueOrThrow({ where: { id: receiptId } });
    const deadline = new Date(Date.now() + 1_500);
    expect(deadline.getTime()).toBeLessThan(event.executionDeadlineAt!.getTime());
    await s.prisma.webhookEvent.update({
      where: { id: receiptId },
      data: { executionDeadlineAt: deadline },
    });
    expect(deadline.getTime()).toBeGreaterThan(Date.now());
    const claim = await s.prisma.webhookExecutionClaim.create({
      data: {
        kind: 'EXECUTION',
        semanticKey: event.semanticKey!,
        webhookEventId: receiptId,
        enforced: true,
        commandResult: {
          kind: 'EXECUTION_WAITING',
          authorityVersion: MULTIBOT_EXECUTION_AUTHORITY_VERSION,
          webhookEventId: receiptId,
          semanticKey: event.semanticKey!,
          deadlineAt: deadline.toISOString(),
        },
      },
    });
    const ensureReady = s.readiness.ensureReady.bind(s.readiness);
    const readiness = jest.spyOn(s.readiness, 'ensureReady').mockImplementation(async (input) => {
      const proof = await ensureReady(input);
      await new Promise((resolve) =>
        setTimeout(resolve, Math.max(0, deadline.getTime() - Date.now()) + 30),
      );
      return proof;
    });
    try {
      await expect(s.ingress.preparePersistedWebhookEvent(receiptId)).resolves.toMatchObject({
        canonical: false,
        prepared: true,
        executionBotId: null,
      });
      const expired = await s.prisma.webhookExecutionClaim.findUniqueOrThrow({
        where: { id: claim.id },
        include: { webhookEvent: true },
      });
      expect(expired.status).toBe('COMPLETED');
      expect(expired.businessStartedAt).toBeNull();
      expect(expired.webhookEvent?.normalizedPayload).toMatchObject({
        executionOutcome: { code: 'NO_EXECUTABLE_OWNER', deadlineAt: deadline.toISOString() },
      });
      expect(s.effects).toEqual([]);
    } finally {
      readiness.mockRestore();
    }
  });

  it('rejects an expired business lease after a successful executor proof', async () => {
    const s = await fixture(4);
    const [chatId] = await s.seedCatalog(1);
    await s.pause();
    const receiptId = await s.ingest({
      chatId: chatId!,
      messageId: `lease-expired-${randomUUID()}`,
      text: 'An expired lease must never start this long message',
      botId: s.bots[0]!.id,
    });
    await s.ingress.preparePersistedWebhookEvent(receiptId);
    const handler = jest.spyOn(s.moderation, 'handleUpdate');
    const ensureReady = s.readiness.ensureReady.bind(s.readiness);
    const readiness = jest.spyOn(s.readiness, 'ensureReady').mockImplementation(async (input) => {
      const proof = await ensureReady(input);
      await s.prisma.webhookExecutionClaim.updateMany({
        where: { kind: 'EXECUTION', webhookEventId: receiptId },
        data: { leaseExpiresAt: new Date(Date.now() - 1_000) },
      });
      return proof;
    });
    try {
      await expect(s.moderation.processWebhookEvent(receiptId)).rejects.toThrow(
        'business-start fence changed',
      );
      const claim = await s.prisma.webhookExecutionClaim.findFirstOrThrow({
        where: { kind: 'EXECUTION', webhookEventId: receiptId },
      });
      expect(claim.businessStartedAt).toBeNull();
      expect(claim.status).toBe('READY');
      expect(handler).not.toHaveBeenCalled();
      expect(s.effects).toEqual([]);
    } finally {
      readiness.mockRestore();
    }
  });

  it('refuses READY publication when the preparation lease expires during its awaited work', async () => {
    const s = await fixture(4);
    const [chatId] = await s.seedCatalog(1);
    await s.pause();
    const receiptId = await s.ingest({
      chatId: chatId!,
      messageId: `preparation-expired-${randomUUID()}`,
      text: 'A preparation result requires a live lease before it becomes executable',
      botId: s.bots[0]!.id,
    });
    const ensureReady = s.readiness.ensureReady.bind(s.readiness);
    const readiness = jest.spyOn(s.readiness, 'ensureReady').mockImplementation(async (input) => {
      const proof = await ensureReady(input);
      await s.prisma.webhookExecutionClaim.updateMany({
        where: { kind: 'EXECUTION', webhookEventId: receiptId },
        data: { leaseExpiresAt: new Date(Date.now() - 1_000) },
      });
      return proof;
    });
    try {
      await expect(s.ingress.preparePersistedWebhookEvent(receiptId)).rejects.toThrow(
        'lease was lost before READY',
      );
      const claim = await s.prisma.webhookExecutionClaim.findFirstOrThrow({
        where: { kind: 'EXECUTION', webhookEventId: receiptId },
      });
      expect(claim.preparedAt).toBeNull();
      expect(claim.businessStartedAt).toBeNull();
      expect(claim.status).toBe('PENDING');
      expect(s.effects).toEqual([]);
    } finally {
      readiness.mockRestore();
    }
  });

  it('dispatches a later physical owner through its earlier mirror before the next logical message', async () => {
    const s = await fixture(4);
    const [chatId] = await s.seedCatalog(1);
    await s.pause();
    const firstId = `first-${randomUUID()}`;
    const secondId = `second-${randomUUID()}`;
    const at = Date.now();
    const earlyMirror = await s.ingest({
      chatId: chatId!,
      messageId: firstId,
      text: 'The oldest logical message is longer than the limit',
      botId: s.bots[0]!.id,
      at,
    });
    await s.ingest({
      chatId: chatId!,
      messageId: secondId,
      text: 'The second logical message is longer than the limit',
      botId: s.bots[0]!.id,
      at: at + 1,
    });
    const owner = await s.ingest({
      chatId: chatId!,
      messageId: firstId,
      text: 'The oldest logical message is longer than the limit',
      botId: s.bots[1]!.id,
      at,
    });
    await s.ingress.preparePersistedWebhookEvent(owner);
    await s.resume();
    await s.drain();
    expect(s.processedIds.indexOf(owner)).toBeLessThan(
      s.processedIds.findIndex((id) => id !== owner && id !== earlyMirror),
    );
    expect(
      s.effects.filter((effect) => effect.method === 'delete').map((effect) => effect.messageId),
    ).toEqual([firstId, secondId]);
  });

  it.each([
    { fault: 'route', kind: 'static', type: 'message_edited' },
    { fault: 'route', kind: 'static', type: 'user_added' },
    { fault: 'route', kind: 'dynamic', type: 'message_created' },
    { fault: 'lease', kind: 'static', type: 'message_edited' },
    { fault: 'lease', kind: 'static', type: 'message_removed' },
    { fault: 'lease', kind: 'static', type: 'user_added' },
    { fault: 'lease', kind: 'dynamic', type: 'message_created' },
  ] as const)(
    'retries a refused $fault proof in the same native $kind job for $type',
    async ({ fault, kind, type }) => {
      const s = await fixture(2, 'on');
      await s.pause();
      if (type === 'message_removed')
        Object.assign(s.ingress, {
          messageRetention: new MessageRetentionStore(s.prisma as never, s.config, s.legacyHolds),
        });
      const [chatId, independentChatId] = await s.seedCatalog(2, {
        maxMessageLengthEnabled: false,
      });
      const botId = s.bots[0]!.id;
      const messageId = randomUUID();
      let id: string;
      if (type !== 'user_added' && type !== 'message_removed') {
        id = await s.ingest({ chatId: chatId!, messageId, text: 'Fixture', botId, type });
      } else {
        const update = new WebhookParser().parse(
          {
            update_id: randomUUID(),
            update_type: type,
            chat_id: chatId,
            ...(type === 'message_removed'
              ? { message_id: messageId, user_id: 'fixture-user' }
              : {}),
            timestamp: Date.now(),
            user: { user_id: 'fixture-user', first_name: 'Fixture' },
          },
          { botId },
        );
        id = (await s.ingress.storeReceipt(update, null)).webhookEventId!;
        s.receiptIds.push(id);
      }
      await s.ingress.preparePersistedWebhookEvent(id);
      const originalReceipt = await s.prisma.webhookEvent.update({
        where: { id },
        data: { status: 'QUEUED', queuedAt: new Date(), enqueueAttempts: 1 },
      });
      const originalClaim = await s.prisma.webhookExecutionClaim.findFirstOrThrow({
        where: { webhookEventId: id, kind: 'EXECUTION' },
      });
      const competingLease = {
        leaseToken: randomUUID(),
        leaseExpiresAt: new Date(Date.now() + 60_000),
      };
      if (fault === 'lease') {
        // FLAG: Represent another unstarted worker with a real SQL lease. The
        // worker under test must lose its real CAS without releasing that lease.
        expect(
          await s.prisma.webhookExecutionClaim.updateMany({
            where: { id: originalClaim.id, status: 'READY', businessStartedAt: null },
            data: competingLease,
          }),
        ).toEqual({ count: 1 });
      }
      const ensureReady = s.readiness.ensureReady.bind(s.readiness);
      let allowStableProof = false;
      let proofRevision = 0;
      const readiness = jest.spyOn(s.readiness, 'ensureReady').mockImplementation(async (p) => {
        const proof = await ensureReady(p);
        expect(proof).not.toBeNull();
        // FLAG: Change the real SQL proof only after readiness accepted it. The
        // production adoption fence must reject this unstarted attempt itself.
        // Keep this chat pending until independent work completes, even on slow CI.
        if (fault === 'route' && p.chatId === chatId && !allowStableProof) {
          await s.prisma.chatBotMembership.update({
            where: { chatId_botId: { chatId: chatId!, botId: proof!.botId } },
            data: { botAccessSource: `fixture-proof-${++proofRevision}` },
          });
        }
        return proof;
      });
      const handler = jest.spyOn(s.moderation, 'handleUpdate');
      type Processor = (job: Job<ProcessWebhookJob>, token?: string) => Promise<void>;
      let processJob: Processor;
      if (kind === 'static') {
        const ProcessorClass = (type === 'user_added'
          ? JOIN_WEBHOOK_SHARD_PROCESSORS[0]!
          : BackgroundWebhookProcessor) as unknown as new (service: unknown) => {
          process: Processor;
        };
        const processor = new ProcessorClass(s.moderation);
        processJob = processor.process.bind(processor);
      } else {
        const manager = Object.create(DefaultWebhookLeaseManagerService.prototype) as {
          createWebhookJobProcessor(): Processor;
        };
        Object.assign(manager, { moderationExecutionService: s.moderation });
        processJob = manager.createWebhookJobProcessor();
      }
      const queue = new Queue<ProcessWebhookJob>(`preparation-retry-${randomUUID()}`, {
        connection: s.redis as unknown as ConnectionOptions,
      });
      const eventsRedis = s.redis.duplicate();
      const workerRedis = s.redis.duplicate();
      const events = new QueueEvents(queue.name, {
        connection: eventsRedis as unknown as ConnectionOptions,
      });
      const previousRole = process.env.APP_ROLE;
      process.env.APP_ROLE = 'moderation';
      const worker = new Worker<ProcessWebhookJob>(queue.name, processJob, {
        connection: workerRedis as unknown as ConnectionOptions,
        concurrency: 1,
      });
      const failed = jest.fn();
      const completedIds: string[] = [];
      events.on('failed', failed);
      events.on('completed', ({ jobId }) => completedIds.push(jobId));
      let delayedTimer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.all([
          queue.waitUntilReady(),
          events.waitUntilReady(),
          worker.waitUntilReady(),
        ]);
        const delayed = new Promise<void>((resolve, reject) => {
          delayedTimer = setTimeout(() => reject(new Error('Preparation was not delayed')), 5_000);
          events.on('delayed', ({ jobId }) => {
            if (jobId === id) {
              clearTimeout(delayedTimer);
              resolve();
            }
          });
        });
        const job = await queue.add(
          'process-webhook',
          { webhookEventId: id },
          {
            jobId: id,
            attempts: 1,
          },
        );
        await delayed;
        expect(await job.getState()).toBe('delayed');
        expect((await queue.getJob(id))?.attemptsMade).toBe(0);
        expect(handler).not.toHaveBeenCalled();
        expect(s.effects).toEqual([]);
        expect(
          await s.prisma.webhookExecutionClaim.findUniqueOrThrow({
            where: { id: originalClaim.id },
          }),
        ).toMatchObject({
          status: 'READY',
          preparedAt: originalClaim.preparedAt,
          businessStartedAt: null,
          ...(fault === 'lease' ? competingLease : { leaseToken: null, leaseExpiresAt: null }),
          commandResult: null,
        });
        expect(await s.prisma.webhookEvent.findUniqueOrThrow({ where: { id } })).toMatchObject({
          status: 'QUEUED',
          executionDeadlineAt: originalReceipt.executionDeadlineAt,
          queuedAt: originalReceipt.queuedAt,
          enqueueAttempts: originalReceipt.enqueueAttempts,
          errorMessage: null,
          nextEnqueueAt: null,
        });
        const independentId = await s.ingest({
          chatId: independentChatId!,
          messageId: randomUUID(),
          text: 'Independent',
          botId,
        });
        await s.ingress.preparePersistedWebhookEvent(independentId);
        const independent = await queue.add(
          'process-webhook',
          { webhookEventId: independentId },
          {
            jobId: independentId,
            attempts: 1,
          },
        );
        await independent.waitUntilFinished(events, 10_000);
        expect(completedIds).toEqual([independentId]);
        allowStableProof = true;
        if (fault === 'lease') {
          expect(
            await s.prisma.webhookExecutionClaim.updateMany({
              where: {
                id: originalClaim.id,
                status: 'READY',
                businessStartedAt: null,
                ...competingLease,
              },
              data: { leaseToken: null, leaseExpiresAt: null },
            }),
          ).toEqual({ count: 1 });
        }
        await job.waitUntilFinished(events, 10_000);
        expect(completedIds).toEqual([independentId, id]);
        expect(failed).not.toHaveBeenCalled();
        expect(await queue.getFailedCount()).toBe(0);
        expect((await queue.getJob(id))?.attemptsMade).toBe(1);
        expect((await queue.getJob(id))?.id).toBe(id);
        expect(await s.prisma.webhookEvent.findUniqueOrThrow({ where: { id } })).toMatchObject({
          status: 'PROCESSED',
          executionDeadlineAt: originalReceipt.executionDeadlineAt,
          enqueueAttempts: originalReceipt.enqueueAttempts,
        });
        expect(
          await s.prisma.webhookExecutionClaim.findUniqueOrThrow({
            where: { id: originalClaim.id },
          }),
        ).toMatchObject({ status: 'COMPLETED', businessStartedAt: expect.any(Date) });
        await s.moderation.processWebhookEvent(id);
        expect(
          handler.mock.calls.filter(([update]) => update.message?.chatId === chatId),
        ).toHaveLength(1);
        expect(s.effects).toEqual([]);
      } finally {
        clearTimeout(delayedTimer);
        readiness.mockRestore();
        handler.mockRestore();
        if (previousRole === undefined) delete process.env.APP_ROLE;
        else process.env.APP_ROLE = previousRole;
        await worker.close();
        await workerRedis.quit();
        await events.close();
        await eventsRedis.quit();
        await queue.obliterate({ force: true });
        await queue.close();
      }
    },
  );

  it('settles a prepared mirror concurrently with checkpoint recovery without a claim/receipt deadlock', async () => {
    const s = await fixture(2, 'on');
    await s.pause();
    const [chatId, independentChatId] = await s.seedCatalog(2, { maxMessageLengthEnabled: false });
    const messageId = randomUUID();
    const at = Date.now();
    const ownerId = await s.ingest({
      chatId: chatId!,
      messageId,
      text: 'Fixture',
      botId: s.bots[0]!.id,
      at,
    });
    await s.ingress.preparePersistedWebhookEvent(ownerId);
    await s.prisma.webhookEvent.update({ where: { id: ownerId }, data: { status: 'QUEUED' } });
    const handler = jest.spyOn(s.moderation, 'handleUpdate');
    const completion = jest
      .spyOn(s.canonical, 'completeExecution')
      .mockImplementation(async (context) => {
        // FLAG: Stop only after the real handler saved its exact finished checkpoint.
        // Recovery below must settle this proof without repeating the handler.
        await (
          s.canonical as unknown as {
            markExecutionHandlerFinished(value: typeof context): Promise<void>;
          }
        ).markExecutionHandlerFinished(context);
      });
    try {
      await s.moderation.processWebhookEvent(ownerId);
    } finally {
      completion.mockRestore();
    }
    const mirrorId = await s.ingest({
      chatId: chatId!,
      messageId,
      text: 'Fixture',
      botId: s.bots[1]!.id,
      at,
    });
    const owner = await s.prisma.webhookEvent.findUniqueOrThrow({ where: { id: ownerId } });
    const claim = await s.prisma.webhookExecutionClaim.findFirstOrThrow({
      where: { webhookEventId: ownerId, kind: 'EXECUTION' },
    });
    const mirror = await s.prisma.webhookEvent.findUniqueOrThrow({ where: { id: mirrorId } });
    const independentId = await s.ingest({
      chatId: independentChatId!,
      messageId: randomUUID(),
      text: 'Independent',
      botId: s.bots[0]!.id,
    });
    await s.ingress.preparePersistedWebhookEvent(independentId);
    let locked!: () => void;
    const claimLocked = new Promise<void>((resolve) => {
      locked = resolve;
    });
    let attempting!: () => void;
    const mirrorAttemptsClaim = new Promise<void>((resolve) => {
      attempting = resolve;
    });
    const recovery = s.prisma.$transaction(async (tx) => {
      await tx.$queryRaw(
        Prisma.sql`SELECT id FROM webhook_execution_claims WHERE id = ${claim.id} FOR UPDATE`,
      );
      locked();
      await mirrorAttemptsClaim;
      await s.moderation.processWebhookEvent(independentId);
      expect(
        await s.prisma.webhookEvent.findUniqueOrThrow({ where: { id: independentId } }),
      ).toMatchObject({ status: 'PROCESSED' });
      return WebhookCanonicalExecutionService.tryRecoverFinishedExecutionWithClient(
        tx as never,
        owner,
        claim,
      );
    });
    await claimLocked;
    const settleMirror = s.prisma.$transaction((tx) => {
      const client = {
        $queryRaw: tx.$queryRaw.bind(tx),
        webhookEvent: tx.webhookEvent,
        webhookExecutionClaim: {
          findUnique: tx.webhookExecutionClaim.findUnique.bind(tx.webhookExecutionClaim),
          updateMany: async (args: Parameters<typeof tx.webhookExecutionClaim.updateMany>[0]) => {
            attempting();
            return tx.webhookExecutionClaim.updateMany(args);
          },
        },
      };
      return WebhookCanonicalExecutionService.trySettlePreparedMirrorWithClient(
        client as never,
        {
          webhookEvent: mirror,
          update: mirror.normalizedPayload as unknown as MaxUpdate,
          businessLeaseToken: null,
        },
        { id: mirror.id, status: mirror.status, timeoutQuarantineExpiresAt: null },
      );
    });
    const results = await Promise.allSettled([recovery, settleMirror]);
    expect(results).toEqual([
      { status: 'fulfilled', value: true },
      { status: 'fulfilled', value: 'retry' },
    ]);
    await s.moderation.processWebhookEvent(mirrorId);
    await s.moderation.processWebhookEvent(ownerId);
    expect(
      await s.prisma.webhookEvent.findUniqueOrThrow({ where: { id: mirrorId } }),
    ).toMatchObject({ status: 'DUPLICATE' });
    expect(handler.mock.calls.filter(([update]) => update.message?.chatId === chatId)).toHaveLength(
      1,
    );
    expect(s.effects).toEqual([]);
    handler.mockRestore();
  });

  it('retains the business replay fence after the worker lease expires', async () => {
    const s = await fixture(9);
    const [chatId] = await s.seedCatalog(1);
    await s.pause();
    const receipts = await mirrors(
      s,
      chatId!,
      `crash-${randomUUID()}`,
      'A long message whose first business worker disappears',
    );
    await s.ingress.preparePersistedWebhookEvent(receipts[0]!);
    const execution = await s.canonical.prepareExecution(receipts[0]!, s.bots[0]!.id);
    expect(execution).not.toBeNull();
    const before = await s.prisma.webhookExecutionClaim.findFirstOrThrow({
      where: {
        kind: 'EXECUTION',
        webhookEventId: receipts[0],
      },
    });
    await s.prisma.webhookExecutionClaim.update({
      where: { id: before.id },
      data: { leaseExpiresAt: new Date(Date.now() - 1_000) },
    });
    await s.moderation.processWebhookEvent(receipts[0]!);
    const after = await s.prisma.webhookExecutionClaim.findUniqueOrThrow({
      where: { id: before.id },
    });
    const receipt = await s.prisma.webhookEvent.findUniqueOrThrow({ where: { id: receipts[0] } });
    expect(after.businessStartedAt).toEqual(before.businessStartedAt);
    expect(after.executionBotId).toBe(before.executionBotId);
    expect(receipt.errorMessage).toContain('CANONICAL_BUSINESS_ALREADY_STARTED');
    expect(await s.prisma.violation.count({ where: { chatId } })).toBe(0);
    expect(s.effects).toEqual([]);
  });

  it('keeps an ambiguous routed SEND fenced when a peer attempts the same logical key', async () => {
    const s = await fixture(4);
    const [chatId] = await s.seedCatalog(1);
    const idempotencyKey = `unknown-send-${randomUUID()}`;
    s.ambiguousNextSend();
    await expect(
      s.max.sendMessage(chatId!, 'Local ambiguous-send fixture', undefined, {
        immediate: true,
        botId: s.bots[0]!.id,
        idempotencyKey,
        routing: { purpose: 'send_message' },
        candidateBotIds: [s.bots[0]!.id],
      }),
    ).rejects.toThrow();
    await expect(
      s.max.sendMessage(chatId!, 'Local ambiguous-send fixture', undefined, {
        immediate: true,
        botId: s.bots[1]!.id,
        idempotencyKey,
        routing: { purpose: 'send_message' },
        candidateBotIds: [s.bots[1]!.id],
      }),
    ).rejects.toThrow();
    expect(
      s.effects.filter((effect) => effect.method === 'post' && effect.path === '/messages'),
    ).toHaveLength(1);
    expect(await s.prisma.maxActionLedgerEntry.count({ where: { chatId, ambiguous: true } })).toBe(
      1,
    );
  });

  it.each(
    (['BAN_MEMBER', 'KICK_MEMBER'] as const).flatMap((actionType) =>
      (['AMBIGUOUS', 'IN_PROGRESS'] as const).map((journalStatus) => ({
        actionType,
        journalStatus,
      })),
    ),
  )(
    'fences an unknown $actionType after a worker restart with $journalStatus journal',
    async ({ actionType, journalStatus }) => {
      const s = await fixture(4);
      const [chatId] = await s.seedCatalog(1);
      const idempotencyKey = `unknown-member-${randomUUID()}`;
      const data: MaxActionJob = {
        actionType,
        chatId: chatId!,
        userId: 'fixture-user',
        botId: s.bots[0]!.id,
        candidateBotIds: s.bots.map((bot) => bot.id),
        routing: { purpose: 'moderation_action', action: 'moderate_member' },
        idempotencyKey,
        createdAt: new Date().toISOString(),
        attempt: 1,
      };
      const queue = new Queue<MaxActionJob>(`member-action-${randomUUID()}`, {
        connection: s.redis as unknown as ConnectionOptions,
      });
      const eventsRedis = s.redis.duplicate();
      const events = new QueueEvents(queue.name, {
        connection: eventsRedis as unknown as ConnectionOptions,
      });
      let workerRedis = s.redis.duplicate();
      const startWorker = (ledger: MaxActionLedgerService) => {
        const dispatch = new MaxActionDispatchService(s.max, undefined, ledger, s.links, s.config);
        const processor = new MaxActionProcessor(dispatch);
        return new Worker<MaxActionJob>(queue.name, (job) => processor.process(job), {
          connection: workerRedis as unknown as ConnectionOptions,
          concurrency: 1,
        });
      };
      const previousRole = process.env.APP_ROLE;
      process.env.APP_ROLE = 'action';
      let worker = startWorker(s.ledger);
      const lostFinalJournal =
        journalStatus === 'IN_PROGRESS'
          ? jest.spyOn(s.ledger, 'recordFailed').mockRejectedValueOnce(
              // Simulate loss of the final write after MAX received the mutation.
              new Error('Simulated worker loss before final member journal write'),
            )
          : undefined;
      try {
        await Promise.all([
          queue.waitUntilReady(),
          events.waitUntilReady(),
          worker.waitUntilReady(),
        ]);
        await s.ledger.recordEnqueuedIfAbsent(data);
        s.ambiguousNextMemberMutation();
        const first = await queue.add('execute-max-action', data, {
          jobId: idempotencyKey,
          attempts: 5,
          backoff: { type: 'fixed', delay: 10 },
        });
        await expect(first.waitUntilFinished(events, 10_000)).rejects.toThrow(
          `Ambiguous MAX ${actionType} transport failure`,
        );
        expect((await queue.getJob(first.id!))?.attemptsMade).toBe(1);
        expect(await first.getState()).toBe('failed');
        const before = await s.prisma.maxActionLedgerEntry.findUniqueOrThrow({
          where: { jobId: idempotencyKey },
        });
        expect(before).toMatchObject({
          actionType,
          chatId,
          userId: data.userId,
          botId: data.botId,
          status: journalStatus,
          ambiguous: journalStatus === 'AMBIGUOUS',
          terminal: journalStatus === 'AMBIGUOUS',
          attemptCount: 1,
          firstAttemptAt: expect.any(Date),
          lastAttemptAt: expect.any(Date),
          completedAt: journalStatus === 'AMBIGUOUS' ? expect.any(Date) : null,
        });
        if (journalStatus === 'AMBIGUOUS') {
          expect(before).toMatchObject({ lastStatusCode: null, lastErrorCode: 'econnaborted' });
          expect(before.metadata).toMatchObject({ attemptedBotIds: [data.botId] });
        } else {
          expect(lostFinalJournal).toHaveBeenCalledTimes(1);
        }

        await worker.close();
        await workerRedis.quit();
        lostFinalJournal?.mockRestore();
        await s.demote(chatId!, data.botId!);
        const peerRoute = await s.links.resolveBotRoute({
          chatId: chatId!,
          purpose: 'moderation_action',
          action: 'moderate_member',
        });
        expect(peerRoute.candidateBotIds).toContain(s.bots[1]!.id);
        workerRedis = s.redis.duplicate();
        worker = startWorker(new MaxActionLedgerService(s.prisma as never));
        await worker.waitUntilReady();
        const replay = await queue.add(
          'execute-max-action',
          { ...data, botId: s.bots[1]!.id, candidateBotIds: peerRoute.candidateBotIds },
          { jobId: `peer-replay-${randomUUID()}`, attempts: 5 },
        );
        expect(replay.id).not.toBe(first.id);
        await expect(replay.waitUntilFinished(events, 10_000)).rejects.toThrow(
          `is no longer executable (${journalStatus})`,
        );
        expect((await queue.getJob(replay.id!))?.attemptsMade).toBe(1);
        expect(await replay.getState()).toBe('failed');
        expect(
          s.effects.filter(
            (effect) => effect.method === 'delete' && effect.path === `/chats/${chatId}/members`,
          ),
        ).toEqual([
          expect.objectContaining({
            botId: data.botId,
            params: {
              user_id: data.userId,
              ...(actionType === 'BAN_MEMBER' ? { block: true } : {}),
            },
          }),
        ]);
        expect(await s.prisma.maxActionLedgerEntry.count({ where: { chatId } })).toBe(1);
        expect(
          await s.prisma.maxActionLedgerEntry.findUniqueOrThrow({
            where: { jobId: idempotencyKey },
          }),
        ).toEqual(before);
      } finally {
        lostFinalJournal?.mockRestore();
        if (previousRole === undefined) delete process.env.APP_ROLE;
        else process.env.APP_ROLE = previousRole;
        await worker.close();
        await workerRedis.quit();
        await events.close();
        await eventsRedis.quit();
        await queue.obliterate({ force: true });
        await queue.close();
      }
    },
  );

  it('resumes only the immutable command notice after proven predispatch rejection', async () => {
    const { s, chatId, receipts, handler, started } = await adminCommandFixture();
    const deadline = (await s.prisma.webhookEvent.findUniqueOrThrow({ where: { id: receipts[0] } }))
      .executionDeadlineAt;
    await s.prisma.webhookEvent.update({
      where: { id: receipts[0] },
      data: { nextEnqueueAt: new Date() },
    });
    await s.resume();
    await s.drain();
    expect(handler).toHaveBeenCalledTimes(1);
    expect(
      await s.prisma.auditLog.count({ where: { chatId, action: 'MANUAL_CHAT_SILENCE' } }),
    ).toBe(1);
    const finished = await s.prisma.webhookExecutionClaim.findUniqueOrThrow({
      where: { id: started.id },
    });
    expect(finished).toMatchObject({
      status: 'COMPLETED',
      executionBotId: started.executionBotId,
      businessStartedAt: started.businessStartedAt,
      leaseToken: null,
      leaseExpiresAt: null,
    });
    expect(
      (await s.prisma.webhookEvent.findUniqueOrThrow({ where: { id: receipts[0] } }))
        .executionDeadlineAt,
    ).toEqual(deadline);
    expect(s.effects.filter((effect) => effect.method === 'post')).toMatchObject([
      { botId: started.executionBotId },
    ]);
  });

  it('settles the saved command through SQL after successful SEND and a completion crash', async () => {
    const { s, chatId, receipts, handler } = await adminCommandFixture();
    const complete = jest
      .spyOn(s.groupCommands, 'complete')
      .mockRejectedValueOnce(new Error('Fixture crash after successful SEND'));
    await expect(s.moderation.processWebhookEvent(receipts[0]!)).rejects.toThrow(
      'Fixture crash after successful SEND',
    );
    complete.mockRestore();
    const sent = s.effects.filter((effect) => effect.method === 'post');
    expect(sent).toHaveLength(1);
    const deadline = (await s.prisma.webhookEvent.findUniqueOrThrow({ where: { id: receipts[0] } }))
      .executionDeadlineAt!;
    const elapsed = jest.spyOn(Date, 'now').mockReturnValue(deadline.getTime() + 1);
    try {
      await s.moderation.processWebhookEvent(receipts[0]!);
    } finally {
      elapsed.mockRestore();
    }
    await s.resume();
    await s.drain();
    expect(handler).toHaveBeenCalledTimes(1);
    expect(
      await s.prisma.auditLog.count({ where: { chatId, action: 'MANUAL_CHAT_SILENCE' } }),
    ).toBe(1);
    expect(s.effects.filter((effect) => effect.method === 'post')).toHaveLength(1);
    expect(
      await s.prisma.webhookEvent.findUniqueOrThrow({ where: { id: receipts[0] } }),
    ).toMatchObject({ status: 'PROCESSED', errorMessage: null });
  });

  it('keeps an attempted unknown command SEND fenced without whole-engine replay', async () => {
    const { s, receipts, handler } = await adminCommandFixture();
    s.ambiguousNextSend();
    await expect(s.moderation.processWebhookEvent(receipts[0]!)).rejects.toThrow(
      'notice delivery remains pending',
    );
    await s.moderation.processWebhookEvent(receipts[0]!);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(s.effects.filter((effect) => effect.method === 'post')).toHaveLength(1);
    expect(
      (await s.prisma.webhookEvent.findUniqueOrThrow({ where: { id: receipts[0] } })).errorMessage,
    ).toContain('CANONICAL_BUSINESS_ALREADY_STARTED');
  });

  it('hands off only an unattempted saved notice when the original command executor is demoted', async () => {
    const { s, chatId, receipts, handler, started } = await adminCommandFixture();
    const beforeCommand = await s.prisma.webhookExecutionClaim.findFirstOrThrow({
      where: {
        kind: 'COMMAND',
        webhookEventId: receipts[0],
      },
    });
    await s.demote(chatId, started.executionBotId!);
    await s.moderation.processWebhookEvent(receipts[0]!);
    const afterCommand = await s.prisma.webhookExecutionClaim.findUniqueOrThrow({
      where: { id: beforeCommand.id },
    });
    const afterExecution = await s.prisma.webhookExecutionClaim.findUniqueOrThrow({
      where: { id: started.id },
    });
    expect(afterCommand.executionBotId).not.toBe(beforeCommand.executionBotId);
    expect(afterCommand.commandResult).toEqual(beforeCommand.commandResult);
    expect(afterCommand.webhookEventId).toBe(beforeCommand.webhookEventId);
    expect(afterExecution.executionBotId).toBe(started.executionBotId);
    expect(afterExecution.businessStartedAt).toEqual(started.businessStartedAt);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(
      await s.prisma.auditLog.count({ where: { chatId, action: 'MANUAL_CHAT_SILENCE' } }),
    ).toBe(1);
    expect(s.effects.filter((effect) => effect.method === 'post')).toMatchObject([
      { botId: afterCommand.executionBotId },
    ]);
  });

  it('does not send a saved notice beyond its immutable saved deadline', async () => {
    const { s, receipts, handler, started } = await adminCommandFixture(Date.now(), 1_000);
    const journal = started.commandResult as { deadlineAt: string };
    await new Promise((resolve) =>
      setTimeout(resolve, Math.max(0, Date.parse(journal.deadlineAt) - Date.now()) + 30),
    );
    const before = await s.prisma.webhookExecutionClaim.findFirstOrThrow({
      where: {
        kind: 'COMMAND',
        webhookEventId: receipts[0],
      },
    });
    await s.moderation.processWebhookEvent(receipts[0]!);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(s.effects.filter((effect) => effect.method === 'post')).toEqual([]);
    const after = await s.prisma.webhookExecutionClaim.findUniqueOrThrow({
      where: { id: before.id },
    });
    expect(after).toMatchObject({
      status: 'COMPLETED',
      commandResult: before.commandResult,
      leaseToken: null,
      leaseExpiresAt: null,
    });
    expect(
      (await s.prisma.webhookExecutionClaim.findUniqueOrThrow({ where: { id: started.id } }))
        .commandResult,
    ).toMatchObject({ kind: 'COMMAND_NOTICE_EXPIRED' });
    expect(
      await s.prisma.webhookEvent.findUniqueOrThrow({ where: { id: receipts[0] } }),
    ).toMatchObject({ status: 'PROCESSED', errorMessage: null, nextEnqueueAt: null });
    expect(
      await s.prisma.maxActionLedgerEntry.findMany({
        where: { chatId: h!.chatIds[0], actionType: 'SEND_MESSAGE' },
      }),
    ).toMatchObject([
      {
        status: 'FAILED_TERMINAL',
        ambiguous: false,
        terminal: true,
        lastErrorCode: 'COMMAND_NOTICE_EXPIRED',
        dispatchToken: null,
        dispatchStartedAt: null,
        remoteMessageId: null,
      },
    ]);
    await s.resume();
    await s.drain();
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('refreshes a changed normalized predispatch code without replaying command mutation', async () => {
    const { s, receipts, handler, started } = await adminCommandFixture();
    const verify = s.links.verifyChatExecutionProof.bind(s.links);
    let checks = 0;
    const rejected = jest
      .spyOn(s.links, 'verifyChatExecutionProof')
      .mockImplementation(async (proof) => {
        checks += 1;
        if (checks === 2)
          throw Object.assign(new Error('Fixture second predispatch rejection'), {
            code: 'TEMP_SECOND_REJECTION',
          });
        return verify(proof);
      });
    await expect(s.moderation.processWebhookEvent(receipts[0]!)).rejects.toThrow(
      'notice delivery remains pending',
    );
    rejected.mockRestore();
    expect(
      (await s.prisma.webhookExecutionClaim.findUniqueOrThrow({ where: { id: started.id } }))
        .commandResult,
    ).toMatchObject({
      kind: 'COMMAND_NOTICE_PENDING',
      failureCode: 'max_send_pre_dispatch_guard_rejected',
    });
    await s.moderation.processWebhookEvent(receipts[0]!);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(s.effects.filter((effect) => effect.method === 'post')).toHaveLength(1);
  });

  it('rejects a notice when the final SQL proof crosses its source deadline', async () => {
    const { s, receipts, handler, started } = await adminCommandFixture();
    const deadline = (await s.prisma.webhookEvent.findUniqueOrThrow({ where: { id: receipts[0] } }))
      .executionDeadlineAt!;
    const verify = s.links.verifyChatExecutionProof.bind(s.links);
    let checks = 0;
    let elapsed: jest.SpyInstance | undefined;
    const delayed = jest
      .spyOn(s.links, 'verifyChatExecutionProof')
      .mockImplementation(async (proof) => {
        const result = await verify(proof);
        checks += 1;
        if (checks === 2) elapsed = jest.spyOn(Date, 'now').mockReturnValue(deadline.getTime() + 1);
        return result;
      });
    try {
      await expect(s.moderation.processWebhookEvent(receipts[0]!)).rejects.toThrow(
        'notice delivery remains pending',
      );
      delayed.mockRestore();
      await s.moderation.processWebhookEvent(receipts[0]!);
    } finally {
      delayed.mockRestore();
      elapsed?.mockRestore();
    }
    expect(handler).toHaveBeenCalledTimes(1);
    expect(s.effects.filter((effect) => effect.method === 'post')).toEqual([]);
    expect(
      (await s.prisma.webhookExecutionClaim.findUniqueOrThrow({ where: { id: started.id } }))
        .commandResult,
    ).toMatchObject({ kind: 'COMMAND_NOTICE_EXPIRED' });
  });

  it.each([3, 6, 9, 12])(
    'observes read-only and write-only receipts without authority or MAX calls among %i bots',
    async (bots) => {
      const s = await fixture(bots);
      for (const bot of s.bots) s.setBotPermissions(bot.id, ['read_all_messages']);
      s.setBotPermissions(s.bots.at(-1)!.id, ['write']);
      const [chatId] = await s.seedCatalog(1);
      const memberships = await s.prisma.chatBotMembership.findMany({
        where: { chatId },
        orderBy: { botId: 'asc' },
      });
      const requestCount = s.requests.length;
      const handler = jest.spyOn(s.moderation, 'handleUpdate');
      const messageId = `split-permissions-${randomUUID()}`;
      const receipts = await mirrors(
        s,
        chatId!,
        messageId,
        'No bot has both mandatory chat capabilities to moderate this long message',
      );
      await s.drain();
      expect(
        await s.prisma.webhookEvent.findMany({
          where: { id: { in: receipts } },
          select: { status: true, errorMessage: true },
        }),
      ).toEqual(
        Array.from({ length: bots }, () => ({
          status: 'PROCESSED',
          errorMessage: DORMANT_BOT_OBSERVATION_MARKER,
        })),
      );
      expect(
        await s.prisma.webhookExecutionClaim.count({
          where: { webhookEventId: { in: receipts } },
        }),
      ).toBe(0);
      expect(await s.prisma.violation.count({ where: { chatId } })).toBe(0);
      expect(await s.prisma.moderationDeleteIntent.count({ where: { chatId } })).toBe(0);
      expect(
        await s.prisma.chatBotMembership.findMany({
          where: { chatId },
          orderBy: { botId: 'asc' },
        }),
      ).toEqual(memberships);
      expect(handler).not.toHaveBeenCalled();
      expect(s.requests).toHaveLength(requestCount);
      expect(s.effects).toEqual([]);
    },
  );

  it.each([3, 6, 9, 12])(
    'executes through the last full-baseline peer after dormant candidates among %i bots',
    async (bots) => {
      const s = await fixture(bots);
      for (const [index, bot] of s.bots.entries())
        s.setBotPermissions(bot.id, index % 2 ? ['write'] : ['read_all_messages']);
      const healthyBotId = s.bots.at(-1)!.id;
      s.setBotPermissions(healthyBotId, ['read_all_messages', 'write']);
      const [chatId] = await s.seedCatalog(1);
      const dormantBotIds = s.bots.slice(0, -1).map((bot) => bot.id);
      const readDormantAccess = () =>
        s.prisma.chatBotMembership.findMany({
          where: { chatId, botId: { in: dormantBotIds } },
          orderBy: { botId: 'asc' },
          select: {
            botId: true,
            status: true,
            capabilities: true,
            botAccessState: true,
            botAccessCheckedAt: true,
            botAccessExpiresAt: true,
            botAccessSource: true,
            permissionsSnapshot: true,
            permissionsHash: true,
            lifecycleEventAt: true,
            lifecycleEventType: true,
            lifecycleSource: true,
          },
        });
      const dormantAccess = await readDormantAccess();
      const handler = jest.spyOn(s.moderation, 'handleUpdate');
      const requestCount = s.requests.length;
      const messageId = `healthy-last-peer-${randomUUID()}`;
      const receipts = await mirrors(
        s,
        chatId!,
        messageId,
        'Only the final peer has both mandatory chat capabilities to moderate this long message',
      );
      await s.drain();
      const claims = await s.prisma.webhookExecutionClaim.findMany({
        where: {
          kind: 'EXECUTION',
          webhookEventId: { in: receipts },
        },
      });
      expect(claims).toHaveLength(1);
      expect(claims[0]).toMatchObject({
        executionBotId: healthyBotId,
        status: 'COMPLETED',
      });
      expect(await s.prisma.chat.findUniqueOrThrow({ where: { id: chatId } })).toMatchObject({
        primaryBotId: healthyBotId,
      });
      expect(await readDormantAccess()).toEqual(dormantAccess);
      expect(handler).toHaveBeenCalledTimes(1);
      expect(
        s.requests.slice(requestCount).every((request) => request.botId === healthyBotId),
      ).toBe(true);
      expect(
        s.effects.filter((effect) => effect.method === 'delete' && effect.messageId === messageId),
      ).toMatchObject([{ botId: healthyBotId }]);
      expect(await s.prisma.violation.count({ where: { chatId } })).toBe(1);
    },
  );

  it('finishes the original engine and recovers a future SQL DELETE retry with no BullMQ job', async () => {
    const s = await fixture(9, 'shadow', true);
    const [chatId] = await s.seedCatalog(1);
    await s.pause();
    const wakeup = jest.spyOn(s.intents as any, 'enqueueWakeup').mockResolvedValue(undefined);
    const messageId = `quota-guard-${randomUUID()}`;
    const receipts = await mirrors(
      s,
      chatId!,
      messageId,
      'This long message exceeds the configured text limit',
    );
    await s.ingress.preparePersistedWebhookEvent(receipts[0]!);
    const execution = await s.prisma.webhookExecutionClaim.findFirstOrThrow({
      where: {
        kind: 'EXECUTION',
        webhookEventId: { in: receipts },
      },
    });
    const ownerId = execution.webhookEventId!;
    const handler = jest.spyOn(s.moderation, 'handleUpdate');
    const originalExact = s.max.getExactMessageRow.bind(s.max);
    let quotaFailure: unknown;
    const exact = jest
      .spyOn(s.max, 'getExactMessageRow')
      .mockImplementationOnce(async (...args) => {
        const wait = jest
          .spyOn(s.max as any, 'resolveTrafficClassRateLimitWaitMs')
          .mockReturnValue(0);
        const reserve = jest.spyOn(s.max as any, 'tryReserveRateLimitSlot').mockResolvedValueOnce({
          ok: false,
          retryAfterMs: 76,
          reason: 'Fixture native final-guard quota rejection',
        });
        try {
          return await originalExact(...args);
        } catch (error) {
          quotaFailure = error;
          throw error;
        } finally {
          reserve.mockRestore();
          wait.mockRestore();
        }
      });
    try {
      await s.moderation.processWebhookEvent(ownerId);
    } finally {
      exact.mockRestore();
      wakeup.mockRestore();
    }
    expect(quotaFailure).toBeInstanceOf(MaxApiInternalRateLimitError);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(await s.prisma.webhookEvent.findUniqueOrThrow({ where: { id: ownerId } })).toMatchObject(
      { status: 'PROCESSED', errorMessage: null },
    );
    expect(
      await s.prisma.webhookExecutionClaim.findFirstOrThrow({
        where: {
          kind: 'EXECUTION',
          webhookEventId: ownerId,
        },
      }),
    ).toMatchObject({ status: 'COMPLETED', commandResult: { kind: 'EXECUTION_FINISHED' } });
    const retry = await s.prisma.moderationDeleteIntent.findUniqueOrThrow({
      where: {
        chatId_messageId: { chatId: chatId!, messageId },
      },
    });
    expect(retry).toMatchObject({
      status: 'RETRYABLE',
      deleteDispatchStartedAt: null,
      deleteDispatchStartedBotId: null,
      leaseToken: null,
      lastErrorCode: 'MAX_API_INTERNAL_RATE_LIMIT',
    });
    expect(s.effects.filter((effect) => effect.method === 'delete')).toEqual([]);
    for (const receipt of receipts)
      if (receipt !== ownerId) await s.ingress.preparePersistedWebhookEvent(receipt);
    expect(
      await s.prisma.webhookEvent.count({
        where: { id: { in: receipts }, status: { in: ['RECEIVED', 'QUEUED', 'FAILED'] } },
      }),
    ).toBe(0);
    expect(await s.deleteQueue.getJobCounts('waiting', 'active', 'delayed')).toMatchObject({
      waiting: 0,
      active: 0,
      delayed: 0,
    });
    const dueAt = new Date(Date.now() + 250);
    await s.prisma.moderationDeleteIntent.update({
      where: { id: retry.id },
      data: { nextAttemptAt: dueAt },
    });
    const sweeper = jest.spyOn(s.intents, 'sweepDueIntents');
    expect(await s.pumpOnce()).toBe(1);
    expect(sweeper).toHaveBeenCalledTimes(1);
    expect(s.effects.filter((effect) => effect.method === 'delete')).toEqual([]);
    await s.resume();
    await s.drain();
    expect(sweeper.mock.calls.length).toBeGreaterThanOrEqual(2);
    sweeper.mockRestore();
    expect(Date.now()).toBeGreaterThanOrEqual(dueAt.getTime());
    expect(
      await s.prisma.moderationDeleteIntent.findUniqueOrThrow({ where: { id: retry.id } }),
    ).toMatchObject({
      status: 'SUCCEEDED',
    });
    await s.moderation.processWebhookEvent(ownerId);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(await s.prisma.violation.count({ where: { chatId } })).toBe(1);
    expect(
      s.effects.filter((effect) => effect.method === 'delete' && effect.messageId === messageId),
    ).toHaveLength(1);
  });
});
