import { ConfigService } from '@nestjs/config';
import { WebhookService } from './webhook.service';
import { WebhookPreparationDeferredError } from '../common/webhook-preparation-deferred.error';
import {
  WebhookCanonicalExecutionService,
  WebhookFinishPersistenceError,
} from '../moderation/webhook-canonical-execution.service';
import { WebhookOrderedPredecessorPendingError } from '../moderation/webhook-ordered-predecessor-fence';
import { buildBotAccessSnapshotPersistence } from '../max/bot-access-snapshot.util';
import { holdUnverifiedLegacyExecution } from './webhook-legacy-authority';
import { buildWebhookExecutionDeadlineAt } from './webhook-execution-deadline';
import { randomUUID } from 'node:crypto';

import {
  createPrismaClient,
  Prisma,
  type PrismaClient,
  WebhookExecutionClaimStatus,
  WebhookStatus,
} from '../prisma/prisma-client';
import { WebhookOutboxService } from './webhook-outbox.service';
import { writeWebhookPayload } from './webhook-payload-write';
import { writeWebhookEnqueueState, type WebhookEnqueueSnapshot } from './webhook-receipt-write';
import { Client } from 'pg';
import { buildWebhookSemanticEventKey } from './webhook-semantic-event-key';
import { WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINE_PREFIX } from './webhook-timeout-quarantine';
import { WEBHOOK_QUEUE_CRITICAL } from './webhook-queues';

const databaseUrl = process.env.CHAT_ROUTING_POSTGRES_RACE_DATABASE_URL?.trim() ?? '';
const describePostgres = databaseUrl ? describe : describe.skip;

type OrderedWebhookHead = {
  id: string;
  createdAt: Date;
};

type OrderedWebhookHeadReader = {
  findOrderedWebhookHeadsForChats: (
    chatIds: readonly string[],
  ) => Promise<Map<string, OrderedWebhookHead>>;
  selectEnqueueCandidates: (
    now: Date,
    admission?: {
      degraded: boolean;
      batchSize: number;
      enqueueConcurrency: number;
      includeQueuedRepair: boolean;
      includeCompletedTimeoutRepair: boolean;
      expandSelectedChats: boolean;
    },
  ) => Promise<
    Array<{
      id: string;
      status: WebhookStatus;
      createdAt: Date;
      normalizedPayload: unknown;
    }>
  >;
  expandSelectedChatCandidates: (
    candidates: Array<{
      id: string;
      status: WebhookStatus;
      createdAt: Date;
      normalizedPayload: unknown;
      priority: number;
    }>,
    now: Date,
  ) => Promise<
    Array<{
      id: string;
      status: WebhookStatus;
      createdAt: Date;
      normalizedPayload: unknown;
      priority: number;
    }>
  >;
};

function collectExplainNodes(value: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(value)) {
    return value.flatMap(collectExplainNodes);
  }
  if (!value || typeof value !== 'object') {
    return [];
  }

  const record = value as Record<string, unknown>;
  return [record, ...Object.values(record).flatMap(collectExplainNodes)];
}

function assertDisposableDatabaseUrl(value: string): void {
  const parsed = new URL(value);
  const databaseName = parsed.pathname.replace(/^\//u, '');
  if (
    !['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname) ||
    !databaseName.includes('race_test')
  ) {
    throw new Error(
      'CHAT_ROUTING_POSTGRES_RACE_DATABASE_URL must target a local database containing race_test',
    );
  }
}

describePostgres('PostgreSQL webhook outbox queries', () => {
  let prisma: PrismaClient;
  let reader: OrderedWebhookHeadReader;
  let executionCutoverAt: Date;
  const createdEventIds: string[] = [];
  const createdClaimIds: string[] = [];
  const createdChatIds: string[] = [];

  beforeAll(async () => {
    assertDisposableDatabaseUrl(databaseUrl);
    prisma = createPrismaClient(databaseUrl, { max: 2 });
    await prisma.$connect();
    const [cutover] = await prisma.$queryRaw<Array<{ finishedAt: Date }>>`
      SELECT finished_at AS "finishedAt" FROM _prisma_migrations
      WHERE migration_name = '20261005020000_add_multibot_order_fences'
        AND rolled_back_at IS NULL AND finished_at IS NOT NULL
      ORDER BY finished_at DESC LIMIT 1
    `;
    if (!(cutover?.finishedAt instanceof Date) || !Number.isFinite(cutover.finishedAt.getTime()))
      throw new Error(
        'Native authority fixtures require the successful multibot cutover migration',
      );
    executionCutoverAt = cutover.finishedAt;
    const service = Object.create(WebhookOutboxService.prototype) as object;
    Object.defineProperty(service, 'prisma', { value: prisma });
    Object.defineProperty(service, 'batchSize', { value: 100 });
    Object.defineProperty(service, 'manualClosePriorityCache', { value: new Map() });
    reader = service as OrderedWebhookHeadReader;
  });

  afterEach(async () => {
    if (createdEventIds.length === 0) {
      return;
    }
    const ids = createdEventIds.splice(0);
    await prisma.webhookExecutionClaim.deleteMany({
      where: { OR: [{ webhookEventId: { in: ids } }, { id: { in: createdClaimIds.splice(0) } }] },
    });
    await prisma.webhookEvent.deleteMany({ where: { id: { in: ids } } });
    await prisma.chat.deleteMany({ where: { id: { in: createdChatIds.splice(0) } } });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  function preparationService() {
    return new WebhookService(
      prisma as never,
      new ConfigService({ WEBHOOK_CANONICAL_EXECUTION_MODE: 'on' }),
      {
        getStoredChatPrimaryBotId: async () => 'preparation-bot',
        observeStoredChatBotWebhook: async () => undefined,
      } as never,
    );
  }
  async function preparationReceipt() {
    const id = `preparation-${randomUUID()}`;
    const update = {
      updateId: id,
      botId: 'preparation-bot',
      type: 'message_created',
      eventTimestampSource: 'payload' as const,
      message: {
        chatId: `-${randomUUID()}`,
        messageId: `message-${id}`,
        senderId: '',
        text: '',
        createdAt: new Date().toISOString(),
      },
    };
    createdEventIds.push(id);
    await prisma.webhookEvent.create({
      data: { id, dedupKey: id, botId: update.botId, rawPayload: {}, normalizedPayload: update },
    });
    return { id, update };
  }

  async function semanticReceipt(params: {
    id?: string;
    chatId: string;
    messageId: string;
    createdAt: Date;
    sourceAt?: Date;
    botId?: string;
  }) {
    const id = params.id ?? `semantic-${randomUUID()}`;
    const update = {
      updateId: id,
      botId: params.botId ?? 'preparation-bot',
      type: 'message_created',
      eventTimestampSource: 'payload' as const,
      message: {
        chatId: params.chatId,
        messageId: params.messageId,
        senderId: '',
        text: 'same message',
        createdAt: (params.sourceAt ?? params.createdAt).toISOString(),
      },
    };
    const semanticKey = buildWebhookSemanticEventKey(update)!;
    createdEventIds.push(id);
    const event = await prisma.webhookEvent.create({
      data: {
        id,
        dedupKey: id,
        botId: update.botId,
        semanticKey,
        createdAt: params.createdAt,
        rawPayload: {},
        normalizedPayload: update,
      },
    });
    return { event, update, semanticKey };
  }

  async function readyClaim(
    source: Awaited<ReturnType<typeof semanticReceipt>>,
    extra: Record<string, unknown> = {},
  ) {
    const claim = await prisma.webhookExecutionClaim.create({
      data: {
        kind: 'EXECUTION',
        semanticKey: source.semanticKey,
        webhookEventId: source.event.id,
        executionBotId: 'preparation-bot',
        enforced: true,
        status: 'READY',
        createdAt: new Date(),
        preparedAt: new Date(),
        ...extra,
      },
    });
    createdClaimIds.push(claim.id);
    return claim;
  }

  async function finishedCheckpoint() {
    const source = await semanticReceipt({
      chatId: `-${randomUUID()}`,
      messageId: 'finished-checkpoint',
      createdAt: new Date(),
    });
    const claim = await readyClaim(source);
    const worker = new WebhookCanonicalExecutionService(prisma as never);
    const context = await worker.prepareExecution(source.event.id, 'preparation-bot');
    expect(context).not.toBeNull();
    await (
      worker as unknown as {
        markExecutionHandlerFinished: (
          finishedContext: NonNullable<typeof context>,
        ) => Promise<void>;
      }
    ).markExecutionHandlerFinished(context!);
    const event = await prisma.webhookEvent.update({
      where: { id: source.event.id },
      data: {
        status: 'FAILED',
        nextEnqueueAt: null,
        errorMessage: `${WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINE_PREFIX}:finished-checkpoint: interrupted completion`,
      },
    });
    return {
      source,
      event,
      claim: await prisma.webhookExecutionClaim.findUniqueOrThrow({ where: { id: claim.id } }),
    };
  }

  function freshOutbox() {
    const queue = { getJob: jest.fn().mockResolvedValue(null), add: jest.fn() };
    const prepare = preparationService();
    const prepareCore = jest.spyOn(
      prepare as unknown as { prepareWebhookEventCore: (...args: unknown[]) => Promise<never> },
      'prepareWebhookEventCore',
    );
    const service = new WebhookOutboxService(
      prisma as never,
      new ConfigService({ ENQUEUE_BATCH_SIZE: 100, ENQUEUE_CONCURRENCY: 1 }),
      { get: () => queue } as never,
      { resolveQueueName: async () => WEBHOOK_QUEUE_CRITICAL } as never,
      prepare,
      queue as never,
      queue as never,
      queue as never,
      {
        getEffectiveSnapshot: async () => undefined,
        peekCachedSnapshot: () => ({ mode: 'normal' }),
      } as never,
    );
    return {
      service,
      queue,
      prepareCore,
      poll: () => (service as unknown as { enqueueBatch: () => Promise<void> }).enqueueBatch(),
    };
  }

  it.each([
    { withMirror: false, finishAfterSelection: false },
    { withMirror: true, finishAfterSelection: false },
    { withMirror: true, finishAfterSelection: true },
  ])(
    'continues exact ordered successors during slow selection using real fences (earlier mirror=$withMirror, late completion=$finishAfterSelection)',
    async ({ withMirror, finishAfterSelection }) => {
      const chatId = `-${randomUUID()}`;
      const base = Math.max(Date.now(), executionCutoverAt.getTime() + 1);
      const sources: Array<Awaited<ReturnType<typeof semanticReceipt>>> = [];
      for (let index = 0; index < 11; index++) {
        const source = await semanticReceipt({
          chatId,
          messageId: `continuation-${index}`,
          createdAt: new Date(base + index * 10),
        });
        await readyClaim(source);
        sources.push(source);
      }
      const mirror = withMirror
        ? await semanticReceipt({
            chatId,
            messageId: 'continuation-1',
            createdAt: new Date(base + 5),
            sourceAt: sources[1]!.event.createdAt,
            botId: 'mirror-bot',
          })
        : null;
      const expectedCompletions = withMirror ? 3 : 4;
      const worker = new WebhookCanonicalExecutionService(prisma as never);
      const initial = await worker.prepareExecution(sources[0]!.event.id, 'preparation-bot');
      expect(initial).not.toBeNull();
      await worker.completeExecution(initial!);
      const { service, queue, poll, prepareCore } = freshOutbox();
      const internal = service as unknown as {
        rememberEnqueuedChat(chatId: string, id: string): void;
        selectEnqueueCandidates(...args: unknown[]): Promise<unknown[]>;
      };
      internal.rememberEnqueuedChat(chatId, sources[0]!.event.id);
      const select = internal.selectEnqueueCandidates.bind(internal);
      const selector = jest
        .spyOn(internal, 'selectEnqueueCandidates')
        .mockImplementation(async (...args) => {
          const selected = await select(...args);
          await prisma.$queryRaw`SELECT 1 FROM pg_sleep(0.8)`;
          return selected;
        });
      const completed: string[] = [];
      const workers: Promise<void>[] = [];
      const errors: unknown[] = [];
      let releaseWorker!: () => void;
      const workerGate = new Promise<void>((resolve) => {
        releaseWorker = resolve;
      });
      queue.add.mockImplementation(async (_name: string, job: { webhookEventId: string }) => {
        const index = sources.findIndex((source) => source.event.id === job.webhookEventId);
        const previous = await prisma.webhookEvent.findUniqueOrThrow({
          where: { id: sources[index - 1]!.event.id },
        });
        expect(previous.status).toBe(WebhookStatus.PROCESSED);
        workers.push(
          (async () => {
            if (finishAfterSelection) await workerGate;
            else await new Promise((resolve) => setTimeout(resolve, 20));
            const context = await worker.prepareExecution(job.webhookEventId, 'preparation-bot');
            expect(context).not.toBeNull();
            await worker.completeExecution(context!);
            completed.push(job.webhookEventId);
          })().catch((error: unknown) => {
            errors.push(error);
          }),
        );
      });
      try {
        await poll();
        releaseWorker();
        await Promise.all(workers);
        expect(errors).toEqual([]);
        expect(selector).toHaveBeenCalledTimes(1);
        // FLAG: Real SQL and scheduler latency may consume the finite dispatch budget.
        // Require a nonempty ordered prefix within the unchanged four-pass cap; exact
        // cap saturation is covered by the deterministic outbox unit regression.
        const completedCount = completed.length;
        expect(completedCount).toBeGreaterThan(0);
        expect(completedCount).toBeLessThanOrEqual(expectedCompletions);
        if (finishAfterSelection) expect(completedCount).toBe(1);
        expect(completed).toEqual(
          sources.slice(1, completedCount + 1).map((source) => source.event.id),
        );
        expect(queue.add).toHaveBeenCalledTimes(completedCount);
        expect(prepareCore).not.toHaveBeenCalled();
        if (mirror) {
          const receipt = await prisma.webhookEvent.findUniqueOrThrow({
            where: { id: mirror.event.id },
          });
          expect(receipt.enqueueAttempts).toBe(0);
          // FLAG: Owner completion after selection cannot retroactively settle its mirror.
          // A following logical source, however, requires that ordering head to be settled.
          if (finishAfterSelection) expect(receipt.status).toBe(WebhookStatus.RECEIVED);
          else if (completedCount > 1) expect(receipt.status).toBe(WebhookStatus.DUPLICATE);
          else expect([WebhookStatus.RECEIVED, WebhookStatus.DUPLICATE]).toContain(receipt.status);
        }
        const rows = await prisma.webhookEvent.findMany({
          where: { id: { in: sources.map((source) => source.event.id) } },
          orderBy: { createdAt: 'asc' },
        });
        expect(
          rows.slice(0, completedCount + 1).every((row) => row.status === WebhookStatus.PROCESSED),
        ).toBe(true);
        expect(
          rows
            .slice(completedCount + 1)
            .every((row) => row.status === WebhookStatus.RECEIVED && row.enqueueAttempts === 0),
        ).toBe(true);
        expect(rows.slice(1, completedCount + 1).every((row) => row.enqueueAttempts === 1)).toBe(
          true,
        );
        if (mirror) {
          selector.mockImplementation(select);
          await poll();
          await Promise.all(workers);
          expect(errors).toEqual([]);
          expect(
            await prisma.webhookEvent.findUniqueOrThrow({ where: { id: mirror.event.id } }),
          ).toMatchObject({ status: WebhookStatus.DUPLICATE, enqueueAttempts: 0 });
          expect(completed).toEqual(
            sources.slice(1, completed.length + 1).map((source) => source.event.id),
          );
          expect(new Set(completed).size).toBe(completed.length);
          expect(queue.add).toHaveBeenCalledTimes(completed.length);
          expect(prepareCore).not.toHaveBeenCalled();
        }
      } finally {
        releaseWorker();
        await Promise.all(workers);
        selector.mockRestore();
        await service.onModuleDestroy();
      }
    },
  );

  it('bounds continuation discovery to one indexed raw head per chat under retained skew', async () => {
    const suffix = randomUUID();
    const chatIds = Array.from(
      { length: 16 },
      (_, index) => `-continuation-plan-${suffix}-${index}`,
    );
    const rows = Array.from({ length: 4_111 }, (_, index) => ({
      id: `continuation-plan-${suffix}-${index}`,
      dedupKey: `continuation-plan-${suffix}-${index}`,
      status: WebhookStatus.RECEIVED,
      createdAt: new Date(1_760_000_000_000 + index),
      rawPayload: {},
      normalizedPayload: {
        type: 'message_created',
        message: {
          chatId: chatIds[index < 4_096 ? 0 : index - 4_095],
          messageId: `message-${index}`,
        },
      },
    }));
    createdEventIds.push(...rows.map((row) => row.id));
    await prisma.webhookEvent.createMany({ data: rows });
    await prisma.$executeRaw`ANALYZE webhook_events`;
    const { service } = freshOutbox();
    const query = (
      service as unknown as { continuationRawHeadsQuery(chatIds: string[]): Prisma.Sql }
    ).continuationRawHeadsQuery(chatIds);
    const heads = await prisma.$queryRaw<Array<{ id: string }>>(query);
    expect(heads).toHaveLength(16);
    expect(heads.map((head) => head.id)).toContain(rows[0]!.id);
    const explained = await prisma.$queryRaw<Array<{ 'QUERY PLAN': unknown }>>(
      Prisma.sql`EXPLAIN (ANALYZE, FORMAT JSON) ${query}`,
    );
    const probes = collectExplainNodes(explained).filter(
      (node) => node['Relation Name'] === 'webhook_events',
    );
    expect(probes).toHaveLength(1);
    expect(probes[0]).toMatchObject({
      'Index Name': 'webhook_events_ordered_chat_head_idx',
      'Actual Loops': 16,
      'Actual Rows': 1,
    });
    expect(Number(probes[0]!['Rows Removed by Filter'] ?? 0)).toBe(0);
    expect(query.strings.join(' ')).not.toMatch(
      /legacy_disposition|source_disposition|webhook_legacy_recoveries/,
    );
  });

  it('keeps a permanent completed semantic tombstone after owner body retention', async () => {
    const chatId = `-${randomUUID()}`;
    const owner = await semanticReceipt({
      chatId,
      messageId: 'late-mirror',
      createdAt: new Date(Date.now() - 30_000),
    });
    const claim = await readyClaim(owner, { status: 'COMPLETED', completedAt: new Date() });
    await prisma.webhookEvent.delete({ where: { id: owner.event.id } });
    expect(
      await prisma.webhookExecutionClaim.findUnique({ where: { id: claim.id } }),
    ).toMatchObject({ id: claim.id, webhookEventId: null, status: 'COMPLETED' });
    const late = await semanticReceipt({
      chatId,
      messageId: 'late-mirror',
      createdAt: new Date(),
      botId: 'late-peer',
    });
    expect(await preparationService().preparePersistedWebhookEvent(late.event.id)).toMatchObject({
      canonical: false,
      prepared: true,
    });
    expect((await prisma.webhookEvent.findUnique({ where: { id: late.event.id } }))!.status).toBe(
      'DUPLICATE',
    );
    expect(
      await new WebhookCanonicalExecutionService(prisma as never).prepareExecution(
        late.event.id,
        'late-peer',
      ),
    ).toBeNull();
    expect(
      (await prisma.webhookExecutionClaim.findUnique({ where: { id: claim.id } }))!.executionBotId,
    ).toBe('preparation-bot');
  });

  it('executes a later physical owner through the earlier mirror order anchor', async () => {
    const chatId = `-${randomUUID()}`;
    const now = Math.max(Date.now(), executionCutoverAt.getTime() + 3);
    const mirror = await semanticReceipt({
      chatId,
      messageId: 'first',
      createdAt: new Date(Math.max(now - 3_000, executionCutoverAt.getTime() + 1)),
      botId: 'observer-bot',
    });
    const laterMessage = await semanticReceipt({
      chatId,
      messageId: 'second',
      createdAt: new Date(Math.max(now - 2_000, executionCutoverAt.getTime() + 2)),
    });
    const owner = await semanticReceipt({
      chatId,
      messageId: 'first',
      createdAt: new Date(Math.max(now - 1_000, executionCutoverAt.getTime() + 3)),
    });
    await readyClaim(owner);
    await readyClaim(laterMessage);
    const worker = new WebhookCanonicalExecutionService(prisma as never);
    await expect(
      worker.prepareExecution(laterMessage.event.id, 'preparation-bot'),
    ).rejects.toBeInstanceOf(WebhookOrderedPredecessorPendingError);
    const execution = await worker.prepareExecution(owner.event.id, 'preparation-bot');
    expect(execution?.webhookEvent.id).toBe(owner.event.id);
    await worker.completeExecution(execution!);
    expect(await preparationService().preparePersistedWebhookEvent(mirror.event.id)).toMatchObject({
      canonical: false,
      prepared: true,
    });
    const next = await worker.prepareExecution(laterMessage.event.id, 'preparation-bot');
    expect(next?.webhookEvent.id).toBe(laterMessage.event.id);
    await worker.completeExecution(next!);
  });

  it('expires only an exact unstarted readiness lease and keeps narrower source windows', async () => {
    const source = await semanticReceipt({
      chatId: `-${randomUUID()}`,
      messageId: 'expired',
      createdAt: new Date(Date.now() - 6 * 60_000),
    });
    const deadline = buildWebhookExecutionDeadlineAt(source.update, source.event.createdAt)!;
    await prisma.webhookEvent.update({
      where: { id: source.event.id },
      data: { executionDeadlineAt: deadline },
    });
    const claim = await readyClaim(source, {
      leaseToken: 'expiry-token',
      leaseExpiresAt: new Date(Date.now() + 30_000),
    });
    const params = {
      webhookEventId: source.event.id,
      semanticKey: source.semanticKey,
      claimId: claim.id,
      leaseToken: 'expiry-token',
    };
    expect(
      await prisma.$transaction((tx) =>
        WebhookCanonicalExecutionService.tryExpireUnstartedOwnerWithClient(tx, {
          ...params,
          leaseToken: 'wrong-token',
        }),
      ),
    ).toBe(false);
    expect(
      await prisma.$transaction((tx) =>
        WebhookCanonicalExecutionService.tryExpireUnstartedOwnerWithClient(tx, params),
      ),
    ).toBe(false);
    await prisma.webhookExecutionClaim.update({
      where: { id: claim.id },
      data: {
        commandResult: {
          kind: 'EXECUTION_WAITING',
          authorityVersion: 'semantic-owner-lease-v1',
          webhookEventId: source.event.id,
          semanticKey: source.semanticKey,
          deadlineAt: deadline.toISOString(),
        },
      },
    });
    expect(
      await prisma.$transaction((tx) =>
        WebhookCanonicalExecutionService.tryExpireUnstartedOwnerWithClient(tx, params),
      ),
    ).toBe(true);
    const row = await prisma.webhookEvent.findUnique({ where: { id: source.event.id } });
    expect(row).toMatchObject({
      status: 'PROCESSED',
      executionDeadlineAt: deadline,
      normalizedPayload: {
        executionOutcome: { code: 'NO_EXECUTABLE_OWNER', deadlineAt: deadline.toISOString() },
      },
    });
    expect(
      (await prisma.webhookExecutionClaim.findUnique({ where: { id: claim.id } }))!
        .businessStartedAt,
    ).toBeNull();
  });

  it('never reclaims a started engine after a restart or executor change', async () => {
    const source = await semanticReceipt({
      chatId: `-${randomUUID()}`,
      messageId: 'started',
      createdAt: new Date(),
    });
    const claim = await readyClaim(source, { businessStartedAt: new Date(Date.now() - 1_000) });
    expect(
      await new WebhookCanonicalExecutionService(prisma as never).prepareExecution(
        source.event.id,
        'new-executor',
      ),
    ).toBeNull();
    expect(
      await prisma.webhookExecutionClaim.findUnique({ where: { id: claim.id } }),
    ).toMatchObject({ status: 'READY', executionBotId: 'preparation-bot' });
    expect(
      (await prisma.webhookEvent.findUnique({ where: { id: source.event.id } }))!.errorMessage,
    ).toContain('CANONICAL_BUSINESS_ALREADY_STARTED');
  });

  it('recovers a proven finished handler without rerunning business and releases later messages', async () => {
    const chatId = `-${randomUUID()}`;
    const source = await semanticReceipt({
      chatId,
      messageId: 'finished',
      createdAt: new Date(Date.now() - 3_000),
    });
    const businessStartedAt = new Date(Date.now() - 2_000);
    const finishedAt = new Date(Date.now() - 1_000).toISOString();
    const claim = await readyClaim(source, {
      businessStartedAt,
      commandResult: {
        kind: 'EXECUTION_FINISHED',
        authorityVersion: 'semantic-owner-lease-v1',
        webhookEventId: source.event.id,
        semanticKey: source.semanticKey,
        executionBotId: 'preparation-bot',
        businessStartedAt: businessStartedAt.toISOString(),
        finishedAt,
      },
    });
    const next = await semanticReceipt({ chatId, messageId: 'next', createdAt: new Date() });
    await readyClaim(next);
    const worker = new WebhookCanonicalExecutionService(prisma as never);
    expect(await worker.prepareExecution(source.event.id, 'new-executor')).toBeNull();
    expect(
      await prisma.webhookExecutionClaim.findUnique({ where: { id: claim.id } }),
    ).toMatchObject({
      status: 'COMPLETED',
      executionBotId: 'preparation-bot',
      completedAt: new Date(finishedAt),
    });
    expect((await prisma.webhookEvent.findUnique({ where: { id: source.event.id } }))!.status).toBe(
      'PROCESSED',
    );
    expect((await worker.prepareExecution(next.event.id, 'preparation-bot'))?.webhookEvent.id).toBe(
      next.event.id,
    );
  });

  it.each([false, true])(
    'recovers an interrupted finished owner through a fresh outbox poll before its earlier mirror (same time=%s)',
    async (sameTime) => {
      const suffix = randomUUID();
      const chatId = `-${suffix}`;
      const base = new Date(Math.max(Date.now(), executionCutoverAt.getTime() + 1));
      const mirror = await semanticReceipt({
        id: `finished-poll-${suffix}-a`,
        chatId,
        messageId: 'first',
        createdAt: base,
        botId: 'observer-bot',
      });
      const next = await semanticReceipt({
        id: `finished-poll-${suffix}-b`,
        chatId,
        messageId: 'second',
        createdAt: new Date(base.getTime() + (sameTime ? 0 : 1)),
      });
      const owner = await semanticReceipt({
        id: `finished-poll-${suffix}-c`,
        chatId,
        messageId: 'first',
        createdAt: new Date(base.getTime() + (sameTime ? 0 : 2)),
        sourceAt: base,
      });
      const claim = await readyClaim(owner);
      await readyClaim(next);
      const worker = new WebhookCanonicalExecutionService(prisma as never);
      const context = await worker.prepareExecution(owner.event.id, 'preparation-bot');
      expect(context).not.toBeNull();
      // FLAG: Persist the real handler checkpoint, then interrupt before receipt settlement.
      // The fresh outbox below recovers saved SQL state without starting this handler again.
      await (
        worker as unknown as {
          markExecutionHandlerFinished: (
            finishedContext: NonNullable<typeof context>,
          ) => Promise<void>;
        }
      ).markExecutionHandlerFinished(context!);
      const before = await prisma.webhookExecutionClaim.findUniqueOrThrow({
        where: { id: claim.id },
      });
      await prisma.webhookEvent.update({
        where: { id: owner.event.id },
        data: {
          status: 'FAILED',
          nextEnqueueAt: null,
          errorMessage: `${WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINE_PREFIX}:finished-poll: interrupted completion`,
        },
      });
      const rawBefore = (
        await prisma.webhookEvent.findUniqueOrThrow({
          where: { id: owner.event.id },
        })
      ).rawPayload;
      const { queue, prepareCore, poll } = freshOutbox();
      await poll();
      await poll();
      const after = await prisma.webhookExecutionClaim.findUniqueOrThrow({
        where: { id: claim.id },
      });
      expect(after).toMatchObject({
        status: 'COMPLETED',
        executionBotId: before.executionBotId,
        businessStartedAt: before.businessStartedAt,
        commandResult: before.commandResult,
        leaseToken: null,
        leaseExpiresAt: null,
      });
      expect(
        await prisma.webhookEvent.findUniqueOrThrow({ where: { id: owner.event.id } }),
      ).toMatchObject({
        status: 'PROCESSED',
        rawPayload: rawBefore,
      });
      expect(
        (await prisma.webhookEvent.findUniqueOrThrow({ where: { id: mirror.event.id } })).status,
      ).toBe('DUPLICATE');
      expect(queue.add).toHaveBeenCalledTimes(1);
      expect(queue.add).toHaveBeenCalledWith(
        'process-webhook-event',
        { webhookEventId: next.event.id },
        expect.anything(),
      );
      expect(prepareCore).not.toHaveBeenCalled();
    },
  );

  it.each(['lease renewal', 'receipt edit'] as const)(
    'preserves an interrupted checkpoint when a concurrent %s wins its final CAS',
    async (changedState) => {
      const { event, claim } = await finishedCheckpoint();
      const competitor = createPrismaClient(databaseUrl, { max: 1 });
      let release!: () => void;
      let reached!: () => void;
      const waiting = new Promise<void>((resolve) => {
        release = resolve;
      });
      const atCas = new Promise<void>((resolve) => {
        reached = resolve;
      });
      const recovery = prisma
        .$transaction(
          async (tx) => {
            const client = {
              webhookExecutionClaim: {
                updateMany: async (args: Prisma.WebhookExecutionClaimUpdateManyArgs) => {
                  if (changedState === 'lease renewal') {
                    reached();
                    await waiting;
                  }
                  return tx.webhookExecutionClaim.updateMany(args);
                },
              },
              webhookEvent: {
                updateMany: async (args: Prisma.WebhookEventUpdateManyArgs) => {
                  if (changedState === 'receipt edit') {
                    reached();
                    await waiting;
                  }
                  return tx.webhookEvent.updateMany(args);
                },
              },
            };
            return WebhookCanonicalExecutionService.tryRecoverFinishedExecutionWithClient(
              client as never,
              event,
              claim,
            );
          },
          { timeout: 5_000 },
        )
        .then(
          (value) => ({ value, error: null }),
          (error: unknown) => ({ value: null, error }),
        );
      try {
        expect(
          await Promise.race([atCas.then(() => 'at-cas'), recovery.then(() => 'settled')]),
        ).toBe('at-cas');
        if (changedState === 'lease renewal') {
          await competitor.webhookExecutionClaim.update({
            where: { id: claim.id },
            data: {
              leaseToken: 'concurrent-renewal',
              leaseExpiresAt: new Date(Date.now() + 60_000),
            },
          });
        } else {
          await competitor.webhookEvent.update({
            where: { id: event.id },
            data: {
              normalizedPayload: { ...(event.normalizedPayload as object), concurrentEdit: true },
            },
          });
        }
      } finally {
        release();
        await competitor.$disconnect();
      }
      const outcome = await recovery;
      if (changedState === 'lease renewal') expect(outcome).toEqual({ value: false, error: null });
      else expect(outcome.error).toBeInstanceOf(WebhookPreparationDeferredError);
      const after = await prisma.webhookExecutionClaim.findUniqueOrThrow({
        where: { id: claim.id },
      });
      expect(after).toMatchObject({
        status: 'READY',
        businessStartedAt: claim.businessStartedAt,
        commandResult: claim.commandResult,
        executionBotId: claim.executionBotId,
        completedAt: null,
        leaseToken: changedState === 'lease renewal' ? 'concurrent-renewal' : claim.leaseToken,
      });
      expect(
        await prisma.webhookEvent.findUniqueOrThrow({ where: { id: event.id } }),
      ).toMatchObject({
        status: event.status,
        rawPayload: event.rawPayload,
        errorMessage: event.errorMessage,
      });
    },
  );

  it('settles only the finished handler after a same-key edit and preserves ambiguous independent actions', async () => {
    const { event, claim, source } = await finishedCheckpoint();
    const edited = {
      ...source.update,
      message: { ...source.update.message, text: 'edited after handler completion' },
    };
    expect(buildWebhookSemanticEventKey(edited)).toBe(source.semanticKey);
    await prisma.webhookEvent.update({
      where: { id: event.id },
      data: { normalizedPayload: edited, rawPayload: { originalReceipt: true } },
    });
    const action = await prisma.maxActionLedgerEntry.create({
      data: {
        jobId: `finished-ambiguous-${randomUUID()}`,
        actionType: 'SEND',
        chatId: source.update.message.chatId,
        botId: 'preparation-bot',
        status: 'AMBIGUOUS',
        ambiguous: true,
        attemptCount: 1,
        dispatchToken: 'original-send-token',
        dispatchStartedAt: claim.businessStartedAt,
        dispatchBotId: 'preparation-bot',
        metadata: { webhookEventId: event.id, contentRevision: 'original-content' },
      },
    });
    try {
      const { service, queue, prepareCore } = freshOutbox();
      // FLAG: This checkpoint certifies that the original handler finished, not that edited
      // content or an ambiguous SEND may execute. The independent action journal stays intact.
      expect(
        await (
          service as unknown as {
            recoverFinishedOrderedHeads: (
              heads: ReadonlyMap<string, OrderedWebhookHead>,
            ) => Promise<number>;
          }
        ).recoverFinishedOrderedHeads(new Map([[source.update.message.chatId, event]])),
      ).toBe(1);
      expect(
        await prisma.webhookExecutionClaim.findUniqueOrThrow({ where: { id: claim.id } }),
      ).toMatchObject({
        status: 'COMPLETED',
        commandResult: claim.commandResult,
        executionBotId: claim.executionBotId,
        businessStartedAt: claim.businessStartedAt,
      });
      expect(
        await prisma.webhookEvent.findUniqueOrThrow({ where: { id: event.id } }),
      ).toMatchObject({
        status: 'PROCESSED',
        normalizedPayload: edited,
        rawPayload: { originalReceipt: true },
      });
      expect(
        await prisma.maxActionLedgerEntry.findUniqueOrThrow({ where: { id: action.id } }),
      ).toEqual(action);
      expect(queue.add).not.toHaveBeenCalled();
      expect(prepareCore).not.toHaveBeenCalled();
    } finally {
      await prisma.maxActionLedgerEntry.delete({ where: { id: action.id } });
    }
  });

  it.each(['missing journal', 'wrong owner', 'wrong source', 'malformed date'] as const)(
    'keeps a live or unknown head blocked through a fresh poll with %s',
    async (variant) => {
      const { event, claim, source } = await finishedCheckpoint();
      const journal = claim.commandResult as Record<string, unknown>;
      if (variant === 'wrong source') {
        await prisma.webhookEvent.update({
          where: { id: event.id },
          data: {
            normalizedPayload: {
              ...source.update,
              message: { ...source.update.message, messageId: 'changed-source' },
            },
          },
        });
      } else {
        await prisma.webhookExecutionClaim.update({
          where: { id: claim.id },
          data: {
            commandResult:
              variant === 'missing journal'
                ? Prisma.DbNull
                : {
                    ...journal,
                    ...(variant === 'wrong owner'
                      ? { webhookEventId: 'different-owner' }
                      : { finishedAt: 'invalid' }),
                  },
          },
        });
      }
      const next = await semanticReceipt({
        chatId: source.update.message.chatId,
        messageId: 'distinct-next',
        createdAt: new Date(),
      });
      await readyClaim(next);
      const before = await prisma.webhookExecutionClaim.findUniqueOrThrow({
        where: { id: claim.id },
      });
      const { poll, queue, prepareCore } = freshOutbox();
      await poll();
      expect(
        await prisma.webhookExecutionClaim.findUniqueOrThrow({ where: { id: claim.id } }),
      ).toEqual(before);
      expect(
        (await prisma.webhookEvent.findUniqueOrThrow({ where: { id: event.id } })).status,
      ).toBe('FAILED');
      expect(queue.add).not.toHaveBeenCalled();
      expect(prepareCore).not.toHaveBeenCalled();
    },
  );

  it('bounds finished proof probes to current selected heads instead of retained history', async () => {
    const suffix = randomUUID();
    const createdAt = new Date('2020-01-01T00:00:00Z');
    const rows = Array.from({ length: 4_250 }, (_, index) => ({
      id: `finished-probe-${suffix}-${index}`,
      dedupKey: `finished-probe-${suffix}-${index}`,
      status: WebhookStatus.FAILED,
      createdAt,
      semanticKey: `message:message_created:probe-${suffix}-${index}:message`,
      rawPayload: {},
      normalizedPayload: {
        type: 'message_created',
        message: { chatId: `probe-${suffix}-${index}`, messageId: 'message' },
      },
      errorMessage: `${WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINE_PREFIX}:probe: retained`,
    }));
    createdEventIds.push(...rows.map(({ id }) => id));
    await prisma.webhookEvent.createMany({ data: rows });
    await prisma.webhookExecutionClaim.createMany({
      data: rows.slice(-250).map((row) => ({
        kind: 'EXECUTION',
        semanticKey: row.semanticKey,
        webhookEventId: row.id,
        enforced: true,
        status: WebhookExecutionClaimStatus.READY,
        preparedAt: createdAt,
        businessStartedAt: createdAt,
        executionBotId: 'preparation-bot',
      })),
    });
    await prisma.$executeRaw`ANALYZE webhook_events`;
    await prisma.$executeRaw`ANALYZE webhook_execution_claims`;
    const heads = new Map(
      rows.slice(-250).map((row) => [row.semanticKey, { id: row.id, createdAt }]),
    );
    const { service, queue } = freshOutbox();
    const internals = service as unknown as {
      recoverFinishedOrderedHeads: (
        heads: ReadonlyMap<string, OrderedWebhookHead>,
      ) => Promise<number>;
      selectFinishedOrderedHeadOwners: (
        headIds: readonly string[],
      ) => Promise<Array<{ ownerId: string }>>;
      finishedOrderedHeadOwnersQuery: (headIds: readonly string[]) => Prisma.Sql;
    };
    const capture = jest.spyOn(internals, 'selectFinishedOrderedHeadOwners');
    let selectedIds!: readonly string[];
    try {
      expect(await internals.recoverFinishedOrderedHeads(heads)).toBe(0);
      expect(capture).toHaveBeenCalledTimes(1);
      selectedIds = capture.mock.calls[0]![0];
      expect(selectedIds).toHaveLength(200);
    } finally {
      capture.mockRestore();
    }
    const query = internals.finishedOrderedHeadOwnersQuery(selectedIds);
    const explained = await prisma.$queryRaw<Array<{ 'QUERY PLAN': unknown }>>(
      Prisma.sql`EXPLAIN (ANALYZE, FORMAT JSON) ${query}`,
    );
    const probes = collectExplainNodes(explained).filter((node) =>
      ['webhook_events', 'webhook_execution_claims'].includes(String(node['Relation Name'])),
    );
    expect(probes).toHaveLength(2);
    expect(
      probes.every(
        (node) =>
          Number(node['Actual Loops']) <= 200 &&
          Number(node['Actual Rows']) + Number(node['Rows Removed by Filter'] ?? 0) <= 1 &&
          Number(node['Rows Removed by Index Recheck'] ?? 0) === 0,
      ),
    ).toBe(true);
    // FLAG: A bitmap heap probe carries its unique index in a child plan. Require
    // the same exact indexes and bounded rows without depending on that placement.
    expect(collectExplainNodes(probes).map((node) => node['Index Name'])).toEqual(
      expect.arrayContaining(['webhook_events_pkey', 'webhook_execution_claims_kind_semantic_key']),
    );
    expect(queue.add).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    'restores fresh waiting ownership only before its saved deadline (expired=%s)',
    async (expired) => {
      const chatId = `-${randomUUID()}`;
      const source = await semanticReceipt({
        chatId,
        messageId: 'waiting',
        createdAt: new Date(),
      });
      // A fresh migration must not turn this readiness test into a legacy-source test.
      // Exercise the immutable saved deadline separately, including an earlier expiry.
      const deadline = expired
        ? new Date(Date.now() - 1_000)
        : buildWebhookExecutionDeadlineAt(source.update, source.event.createdAt)!;
      await prisma.webhookEvent.update({
        where: { id: source.event.id },
        data: { executionDeadlineAt: deadline },
      });
      const claim = await readyClaim(source, {
        commandResult: {
          kind: 'EXECUTION_WAITING',
          authorityVersion: 'semantic-owner-lease-v1',
          webhookEventId: source.event.id,
          semanticKey: source.semanticKey,
          deadlineAt: deadline.toISOString(),
        },
      });
      const checkedAt = new Date();
      createdChatIds.push(chatId);
      await prisma.chat.create({
        data: {
          id: chatId,
          title: 'Waiting readiness fixture',
          primaryBotId: 'recovered-bot',
          routingVersion: 8,
          botMemberships: {
            create: {
              botId: 'recovered-bot',
              ...buildBotAccessSnapshotPersistence(
                {
                  isAdmin: true,
                  isOwner: false,
                  permissionsKnown: true,
                  permissions: ['read_all_messages', 'write'],
                },
                { source: 'recovery', now: checkedAt },
              ),
            },
          },
        },
      });
      const readiness = {
        ensureReady: jest.fn(async () => ({
          botId: 'recovered-bot',
          routingVersion: 8,
          accessEpoch: { checkedAt, source: 'recovery' },
          changed: true,
        })),
      };
      const worker = new WebhookCanonicalExecutionService(prisma as never, readiness as never);
      const context = await worker.prepareExecution(source.event.id, 'preparation-bot');
      const stored = await prisma.webhookExecutionClaim.findUnique({ where: { id: claim.id } });
      if (expired) {
        expect(context).toBeNull();
        expect(readiness.ensureReady).not.toHaveBeenCalled();
        expect(stored).toMatchObject({
          status: 'COMPLETED',
          businessStartedAt: null,
          executionBotId: 'preparation-bot',
        });
        expect(
          (await prisma.webhookEvent.findUnique({ where: { id: source.event.id } }))!
            .normalizedPayload,
        ).toMatchObject({ executionOutcome: { code: 'NO_EXECUTABLE_OWNER' } });
      } else {
        expect(context?.activeBotId).toBe('recovered-bot');
        expect(stored).toMatchObject({
          id: claim.id,
          webhookEventId: source.event.id,
          semanticKey: source.semanticKey,
          executionBotId: 'recovered-bot',
        });
        expect(stored!.businessStartedAt).not.toBeNull();
        await worker.completeExecution(context!);
      }
      expect(
        (await prisma.webhookEvent.findUnique({ where: { id: source.event.id } }))!
          .executionDeadlineAt,
      ).toEqual(deadline);
    },
  );

  it.each(
    (['exact', 'changed journal', 'changed receipt', 'unsettled receipt'] as const).flatMap(
      (proofState) => [0, 1].map((sqlClockLeadMs) => ({ proofState, sqlClockLeadMs })),
    ),
  )(
    'accepts concurrent finished recovery only with an $proofState checkpoint and $sqlClockLeadMs ms SQL clock lead without regressing on late failure',
    async ({ proofState, sqlClockLeadMs }) => {
      const source = await semanticReceipt({
        chatId: `-${randomUUID()}`,
        messageId: 'completion-race',
        createdAt: new Date(),
      });
      const claim = await readyClaim(source);
      const worker = new WebhookCanonicalExecutionService(prisma as never);
      const context = await worker.prepareExecution(source.event.id, 'preparation-bot');
      if (sqlClockLeadMs) {
        const started = await prisma.webhookExecutionClaim.findUniqueOrThrow({
          where: { id: claim.id },
        });
        const originalDate = Date;
        const observedAt = started.businessStartedAt!.getTime() - sqlClockLeadMs;
        // FLAG: Only finish observation uses this clock; native SQL and timers stay real.
        globalThis.Date = new Proxy(originalDate, {
          construct(target, args) {
            return Reflect.construct(target, args.length ? args : [observedAt]);
          },
          get(target, key, receiver) {
            return key === 'now' ? () => observedAt : Reflect.get(target, key, receiver);
          },
        });
        try {
          (
            worker as unknown as { observeAwaitedFinish: (value: typeof context) => unknown }
          ).observeAwaitedFinish(context);
        } finally {
          globalThis.Date = originalDate;
        }
      }
      await (
        worker as unknown as {
          markExecutionHandlerFinished: (
            context: NonNullable<
              Awaited<ReturnType<WebhookCanonicalExecutionService['prepareExecution']>>
            >,
          ) => Promise<void>;
        }
      ).markExecutionHandlerFinished(context!);
      let release!: () => void;
      let reached!: () => void;
      const waiting = new Promise<void>((resolve) => {
        release = resolve;
      });
      const atCas = new Promise<void>((resolve) => {
        reached = resolve;
      });
      const pausedCompletion = prisma.$extends({
        query: {
          webhookExecutionClaim: {
            async updateMany({ args, query }) {
              if (args.data.status === 'COMPLETED') {
                reached();
                await waiting;
              }
              return query(args);
            },
          },
        },
      });
      // FLAG: Make recovery win after the original completion reads READY and before its CAS.
      // Both paths settle the saved handler checkpoint; neither may run business again.
      const completing = new WebhookCanonicalExecutionService(pausedCompletion as never)
        .completeExecution(context!)
        .then(
          () => ({ error: null }),
          (error: unknown) => ({ error }),
        );
      try {
        const entry = await Promise.race([
          atCas.then(() => ({ phase: 'at-cas' as const })),
          completing.then((result) => ({ phase: 'settled' as const, result })),
        ]);
        if (entry.phase === 'settled' && entry.result.error) throw entry.result.error;
        expect(entry.phase).toBe('at-cas');
        expect(
          await new WebhookCanonicalExecutionService(prisma as never).prepareExecution(
            source.event.id,
            'other-bot',
          ),
        ).toBeNull();
        if (proofState === 'changed journal') {
          const recovered = await prisma.webhookExecutionClaim.findUniqueOrThrow({
            where: { id: claim.id },
          });
          await prisma.webhookExecutionClaim.update({
            where: { id: claim.id },
            data: {
              commandResult: {
                ...(recovered.commandResult as Prisma.JsonObject),
                changedProof: true,
              },
            },
          });
        } else if (proofState === 'changed receipt') {
          await prisma.webhookEvent.update({
            where: { id: source.event.id },
            data: {
              normalizedPayload: {
                ...(context!.webhookEvent.normalizedPayload as Prisma.JsonObject),
                changedAfterRecovery: true,
              },
            },
          });
        } else if (proofState === 'unsettled receipt') {
          await prisma.webhookEvent.update({
            where: { id: source.event.id },
            data: { status: 'FAILED', processedAt: null },
          });
        }
      } finally {
        release();
      }
      const completion = await completing;
      const after = await prisma.webhookExecutionClaim.findUnique({ where: { id: claim.id } });
      expect(after).toMatchObject({
        status: 'COMPLETED',
        executionBotId: 'preparation-bot',
        leaseToken: null,
        leaseExpiresAt: null,
      });
      await worker.failExecution(context!, {
        errorMessage: 'late failing worker',
        terminal: false,
      });
      expect(
        (await prisma.webhookEvent.findUnique({ where: { id: source.event.id } }))!.status,
      ).toBe(proofState === 'unsettled receipt' ? 'FAILED' : 'PROCESSED');
      expect(
        (await prisma.webhookExecutionClaim.findUnique({ where: { id: claim.id } }))!.commandResult,
      ).toMatchObject({ kind: 'EXECUTION_FINISHED' });
      if (proofState === 'exact') expect(completion).toEqual({ error: null });
      else {
        expect(completion.error).toBeInstanceOf(WebhookFinishPersistenceError);
        expect(completion.error).toMatchObject({
          outcome: 'authority_changed',
          phase: 'settlement',
          cause: { message: 'Handler completion claim changed' },
        });
      }
    },
  );

  it('refuses a finish observation more than one millisecond before its original SQL start', async () => {
    const source = await semanticReceipt({
      chatId: `-${randomUUID()}`,
      messageId: 'finish-clock-skew',
      createdAt: new Date(),
    });
    const claim = await readyClaim(source);
    const worker = new WebhookCanonicalExecutionService(prisma as never);
    const context = await worker.prepareExecution(source.event.id, 'preparation-bot');
    const started = await prisma.webhookExecutionClaim.findUniqueOrThrow({
      where: { id: claim.id },
    });
    const originalDate = Date;
    const observedAt = started.businessStartedAt!.getTime() - 2;
    globalThis.Date = new Proxy(originalDate, {
      construct(target, args) {
        return Reflect.construct(target, args.length ? args : [observedAt]);
      },
      get(target, key, receiver) {
        return key === 'now' ? () => observedAt : Reflect.get(target, key, receiver);
      },
    });
    let completion: Promise<void>;
    try {
      completion = worker.completeExecution(context!);
    } finally {
      globalThis.Date = originalDate;
    }
    await expect(completion!).rejects.toMatchObject({
      outcome: 'authority_changed',
      phase: 'checkpoint',
      cause: { message: 'Handler finish precedes original SQL start' },
    });
    expect(
      await prisma.webhookExecutionClaim.findUnique({ where: { id: claim.id } }),
    ).toMatchObject({ status: 'READY', commandResult: null, completedAt: null });
  });

  it('rejects a persisted finished journal earlier than its original SQL business start', async () => {
    const source = await semanticReceipt({
      chatId: `-${randomUUID()}`,
      messageId: 'invalid-finished-time',
      createdAt: new Date(),
    });
    const claim = await readyClaim(source);
    const worker = new WebhookCanonicalExecutionService(prisma as never);
    const context = await worker.prepareExecution(source.event.id, 'preparation-bot');
    await (
      worker as unknown as {
        markExecutionHandlerFinished: (value: typeof context) => Promise<void>;
      }
    ).markExecutionHandlerFinished(context);
    const saved = await prisma.webhookExecutionClaim.findUniqueOrThrow({
      where: { id: claim.id },
    });
    await prisma.webhookExecutionClaim.update({
      where: { id: claim.id },
      data: {
        commandResult: {
          ...(saved.commandResult as Prisma.JsonObject),
          finishedAt: new Date(saved.businessStartedAt!.getTime() - 1).toISOString(),
        },
      },
    });
    await expect(worker.completeExecution(context!)).rejects.toMatchObject({
      outcome: 'authority_changed',
      phase: 'checkpoint',
      cause: { message: 'Handler-finished journal changed' },
    });
    expect(
      await prisma.webhookExecutionClaim.findUnique({ where: { id: claim.id } }),
    ).toMatchObject({ status: 'READY', completedAt: null });
  });

  it.each([
    ['PENDING', new Date(Date.UTC(2020, 0, 1))],
    ['READY', new Date(Date.UTC(2020, 0, 1))],
    ['READY', new Date()],
  ] as const)(
    'holds an unenforced %s claim written at %s without inventing no-effects proof',
    async (status, claimCreatedAt) => {
      const source = await semanticReceipt({
        chatId: `-${randomUUID()}`,
        messageId: 'legacy',
        createdAt: new Date(Date.UTC(2020, 0, 1)),
      });
      const claim = await readyClaim(source, {
        createdAt: claimCreatedAt,
        enforced: false,
        status,
        ...(status === 'PENDING' ? { preparedAt: null } : {}),
      });
      expect(await holdUnverifiedLegacyExecution(prisma as never, claim)).toBe(true);
      await expect(
        new WebhookCanonicalExecutionService(prisma as never).prepareExecution(
          source.event.id,
          'peer',
        ),
      ).resolves.toBeNull();
      expect(
        (await prisma.webhookExecutionClaim.findUnique({ where: { id: claim.id } }))!.enforced,
      ).toBe(false);
      expect(
        (await prisma.webhookEvent.findUnique({ where: { id: source.event.id } }))!.errorMessage,
      ).toContain('LEGACY_EXECUTION_UNVERIFIED');
    },
  );

  it.each(
    (['PENDING', 'READY'] as const).flatMap((status) =>
      (['preparation', 'worker'] as const).map((path) => ({ status, path })),
    ),
  )('holds old enforced $status authority at the $path boundary', async ({ status, path }) => {
    const source = await semanticReceipt({
      chatId: `-${randomUUID()}`,
      messageId: 'historical-enforced',
      createdAt: new Date(executionCutoverAt.getTime() - 2_000),
    });
    const claim = await readyClaim(source, {
      createdAt: new Date(executionCutoverAt.getTime() - 1),
      enforced: true,
      status,
      ...(status === 'PENDING' ? { preparedAt: null } : {}),
    });
    const worker = new WebhookCanonicalExecutionService(prisma as never);
    const attempt =
      path === 'preparation'
        ? preparationService().preparePersistedWebhookEvent(source.event.id)
        : worker.prepareExecution(source.event.id, 'preparation-bot');
    await expect(attempt).rejects.toBeInstanceOf(WebhookPreparationDeferredError);
    expect(
      await prisma.webhookEvent.findUniqueOrThrow({ where: { id: source.event.id } }),
    ).toMatchObject({
      status: 'FAILED',
      nextEnqueueAt: null,
      errorMessage: expect.stringContaining('LEGACY_EXECUTION_UNVERIFIED'),
    });
    expect(
      await prisma.webhookExecutionClaim.findUniqueOrThrow({ where: { id: claim.id } }),
    ).toMatchObject({
      enforced: true,
      status,
      businessStartedAt: null,
      leaseToken: null,
      leaseExpiresAt: null,
    });
    await expect(worker.prepareExecution(source.event.id, 'peer')).resolves.toBeNull();
  });

  it.each([WebhookStatus.FAILED, WebhookStatus.QUEUED])(
    'holds an old off-mode %s receipt when new preparation creates its first enforced claim',
    async (status) => {
      const source = await semanticReceipt({
        chatId: `-${randomUUID()}`,
        messageId: 'old-off-attempt',
        createdAt: new Date(executionCutoverAt.getTime() - 1),
      });
      await prisma.webhookEvent.update({
        where: { id: source.event.id },
        data: {
          semanticKey: null,
          status,
          nextEnqueueAt: new Date(),
          queueName: 'moderation-background',
          errorMessage: 'old off-mode attempt may have partial effects',
        },
      });
      expect(
        await prisma.webhookExecutionClaim.findUnique({
          where: { kind_semanticKey: { kind: 'EXECUTION', semanticKey: source.semanticKey } },
        }),
      ).toBeNull();
      await expect(
        preparationService().preparePersistedWebhookEvent(source.event.id),
      ).rejects.toBeInstanceOf(WebhookPreparationDeferredError);
      const claim = await prisma.webhookExecutionClaim.findUniqueOrThrow({
        where: { kind_semanticKey: { kind: 'EXECUTION', semanticKey: source.semanticKey } },
      });
      expect(claim.createdAt.getTime()).toBeGreaterThan(executionCutoverAt.getTime());
      expect(claim).toMatchObject({
        enforced: true,
        businessStartedAt: null,
        leaseToken: null,
        leaseExpiresAt: null,
      });
      expect(
        await prisma.webhookEvent.findUniqueOrThrow({ where: { id: source.event.id } }),
      ).toMatchObject({
        status: 'FAILED',
        nextEnqueueAt: null,
        queueName: null,
        errorMessage: expect.stringContaining('LEGACY_EXECUTION_UNVERIFIED'),
      });
      await expect(
        new WebhookCanonicalExecutionService(prisma as never).prepareExecution(
          source.event.id,
          'preparation-bot',
        ),
      ).resolves.toBeNull();
    },
  );

  it.each([false, true])(
    'holds a late fresh owner of an old off-mode mirror (older semantic index entry=%s)',
    async (indexed) => {
      const chatId = `-${randomUUID()}`;
      const old = await semanticReceipt({
        chatId,
        messageId: 'old-off-mirror',
        createdAt: new Date(executionCutoverAt.getTime() - 1),
        botId: 'old-bot',
      });
      await prisma.webhookEvent.update({
        where: { id: old.event.id },
        data: {
          semanticKey: indexed ? old.semanticKey : null,
          status: 'FAILED',
          errorMessage: 'old off-mode partial attempt',
        },
      });
      const lateCreatedAt = new Date();
      const late = await semanticReceipt({
        chatId,
        messageId: 'old-off-mirror',
        createdAt: lateCreatedAt,
        // Known older index rows must also fence a conflicting newer source time.
        sourceAt: indexed ? lateCreatedAt : old.event.createdAt,
        botId: 'preparation-bot',
      });
      await expect(
        preparationService().preparePersistedWebhookEvent(late.event.id),
      ).rejects.toBeInstanceOf(WebhookPreparationDeferredError);
      const claim = await prisma.webhookExecutionClaim.findUniqueOrThrow({
        where: { kind_semanticKey: { kind: 'EXECUTION', semanticKey: late.semanticKey } },
      });
      expect(claim).toMatchObject({
        webhookEventId: late.event.id,
        enforced: true,
        businessStartedAt: null,
      });
      expect(claim.createdAt.getTime()).toBeGreaterThan(executionCutoverAt.getTime());
      expect(
        await prisma.webhookEvent.findUniqueOrThrow({ where: { id: old.event.id } }),
      ).toMatchObject({
        semanticKey: indexed ? old.semanticKey : null,
        status: 'FAILED',
        errorMessage: 'old off-mode partial attempt',
      });
      expect(
        await prisma.webhookEvent.findUniqueOrThrow({ where: { id: late.event.id } }),
      ).toMatchObject({
        status: 'FAILED',
        errorMessage: expect.stringContaining('LEGACY_EXECUTION_UNVERIFIED'),
      });
    },
  );

  it.each(['ingress', 'unknown', 'invalid', 'future', 'old-message-creation'])(
    'holds a fresh shared receipt with %s source proof without acquiring a business lease',
    async (variant) => {
      const source = await semanticReceipt({
        chatId: `-${randomUUID()}`,
        messageId: `unverified-source-${variant}`,
        createdAt: new Date(),
      });
      const payload = source.update as Record<string, unknown>;
      if (variant === 'ingress') payload.eventTimestampSource = 'ingress';
      if (variant === 'unknown') delete payload.eventTimestampSource;
      if (variant === 'invalid') payload.raw = { timestamp: 'invalid' };
      if (variant === 'future') payload.raw = { timestamp: Date.now() + 60_000 };
      if (variant === 'old-message-creation')
        payload.raw = {
          timestamp: source.event.createdAt.getTime(),
          message: { timestamp: executionCutoverAt.getTime() - 1 },
        };
      await prisma.webhookEvent.update({
        where: { id: source.event.id },
        data: { normalizedPayload: payload as Prisma.InputJsonValue },
      });
      const claim = await readyClaim(source);
      await expect(
        new WebhookCanonicalExecutionService(prisma as never).prepareExecution(
          source.event.id,
          'preparation-bot',
        ),
      ).rejects.toBeInstanceOf(WebhookPreparationDeferredError);
      expect(
        await prisma.webhookExecutionClaim.findUniqueOrThrow({ where: { id: claim.id } }),
      ).toMatchObject({ businessStartedAt: null, leaseToken: null, leaseExpiresAt: null });
    },
  );

  it.each([0, 4, 1_000])(
    'permits a new enforced source with %i ms clock lead to execute once',
    async (leadMs) => {
      const receiptAt = new Date();
      const source = await semanticReceipt({
        chatId: `-${randomUUID()}`,
        messageId: 'new-enforced',
        createdAt: receiptAt,
        sourceAt: new Date(receiptAt.getTime() + leadMs),
      });
      const claim = await readyClaim(source);
      expect(claim.createdAt.getTime()).toBeGreaterThan(executionCutoverAt.getTime());
      await expect(holdUnverifiedLegacyExecution(prisma as never, claim)).resolves.toBe(false);
      const worker = new WebhookCanonicalExecutionService(prisma as never);
      const context = await worker.prepareExecution(source.event.id, 'preparation-bot');
      expect(context?.businessLeaseToken).toEqual(expect.any(String));
      await worker.completeExecution(context!);
      await expect(worker.prepareExecution(source.event.id, 'peer')).resolves.toBeNull();
      expect(
        await prisma.webhookExecutionClaim.findUniqueOrThrow({ where: { id: claim.id } }),
      ).toMatchObject({
        status: 'COMPLETED',
        businessStartedAt: expect.any(Date),
        commandResult: expect.objectContaining({ kind: 'EXECUTION_FINISHED' }),
      });
    },
  );

  it.each(['PENDING', 'READY', 'COMPLETED'] as const)(
    'rejects an ownerless incomplete %s claim',
    async (status) => {
      const source = await semanticReceipt({
        chatId: `-${randomUUID()}`,
        messageId: 'bad-tombstone',
        createdAt: new Date(),
      });
      const claim = await readyClaim(source, {
        status,
        ...(status === 'COMPLETED' ? { completedAt: null } : {}),
      });
      await prisma.webhookEvent.delete({ where: { id: source.event.id } });
      const mirror = await semanticReceipt({
        chatId: source.update.message.chatId,
        messageId: 'bad-tombstone',
        createdAt: new Date(),
      });
      await expect(
        preparationService().preparePersistedWebhookEvent(mirror.event.id),
      ).rejects.toBeInstanceOf(WebhookPreparationDeferredError);
      expect(
        (await prisma.webhookExecutionClaim.findUnique({ where: { id: claim.id } }))!
          .webhookEventId,
      ).toBeNull();
      expect(
        (await prisma.webhookEvent.findUnique({ where: { id: mirror.event.id } }))!.status,
      ).toBe('RECEIVED');
    },
  );

  it('advances bounded retention scans past a full page of pinned legacy bodies', async () => {
    const service = Object.create(WebhookOutboxService.prototype) as {
      deleteCompletedWebhookBatch: (cutoff: Date) => Promise<{ removed: number; scanned: number }>;
    };
    Object.defineProperty(service, 'prisma', { value: prisma });
    Object.defineProperty(service, 'webhookRetentionCursors', { value: new Map() });
    const prefix = `retention-pinned-${randomUUID()}`;
    const ids = Array.from(
      { length: 501 },
      (_, index) => `${prefix}-${String(index).padStart(3, '0')}`,
    );
    createdEventIds.push(...ids);
    await prisma.webhookEvent.createMany({
      data: ids.map((id, index) => ({
        id,
        dedupKey: id,
        createdAt: new Date(Date.UTC(2020, 0, 1) + index),
        status: WebhookStatus.PROCESSED,
        semanticKey: index === 500 ? `message:message_created:${prefix}:eligible` : null,
        normalizedPayload: {},
        rawPayload: {},
      })),
    });
    expect(await service.deleteCompletedWebhookBatch(new Date('2021-01-01T00:00:00Z'))).toEqual({
      removed: 0,
      scanned: 500,
    });
    expect(await service.deleteCompletedWebhookBatch(new Date('2021-01-01T00:00:00Z'))).toEqual({
      removed: 1,
      scanned: 1,
    });
    expect(await prisma.webhookEvent.count({ where: { id: { in: ids } } })).toBe(500);
  });

  it.each(['completed', 'failed'] as const)(
    'advances the %s cursor past a partially locked pinned head and revisits it after wrap',
    async (phase) => {
      const service = Object.create(WebhookOutboxService.prototype) as {
        deleteCompletedWebhookBatch(cutoff: Date): Promise<{ removed: number; scanned: number }>;
        deleteTerminalFailedWebhookBatch(
          cutoff: Date,
        ): Promise<{ removed: number; scanned: number }>;
      };
      Object.defineProperty(service, 'prisma', { value: prisma });
      Object.defineProperty(service, 'webhookRetentionCursors', { value: new Map() });
      const prefix = `retention-locked-${randomUUID()}`;
      const ids = Array.from({ length: 501 }, (_, i) => `${prefix}-${String(i).padStart(3, '0')}`);
      createdEventIds.push(...ids);
      await prisma.webhookEvent.createMany({
        data: ids.map((id, index) => ({
          id,
          dedupKey: id,
          createdAt: new Date(Date.UTC(2020, 0, 1) + index),
          status: phase === 'completed' ? WebhookStatus.PROCESSED : WebhookStatus.FAILED,
          semanticKey: index === 0 || index === 500 ? `${prefix}-semantic-${index}` : null,
          normalizedPayload: {},
          rawPayload: {},
        })),
      });
      const read = () =>
        phase === 'completed'
          ? service.deleteCompletedWebhookBatch(new Date('2021-01-01T00:00:00Z'))
          : service.deleteTerminalFailedWebhookBatch(new Date('2021-01-01T00:00:00Z'));
      await prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM webhook_events WHERE id = ${ids[0]} FOR UPDATE`;
        expect(await read()).toEqual({ removed: 0, scanned: 500 });
        expect(await read()).toEqual({ removed: 1, scanned: 1 });
        expect(await tx.webhookEvent.findUnique({ where: { id: ids[0] } })).not.toBeNull();
      });
      expect(await read()).toEqual({ removed: 1, scanned: 500 });
      expect(await prisma.webhookEvent.count({ where: { id: { in: ids } } })).toBe(499);
    },
  );

  it('retains unfinished and ambiguous proof bodies while settled command and execution tombstones survive cleanup', async () => {
    const cutoff = new Date('2021-01-01T00:00:00Z');
    const old = new Date('2020-01-01T00:00:00Z');
    const settled = await semanticReceipt({
      chatId: `-${randomUUID()}`,
      messageId: 'settled-retention',
      createdAt: old,
    });
    const unfinished = await semanticReceipt({
      chatId: `-${randomUUID()}`,
      messageId: 'unfinished-retention',
      createdAt: old,
    });
    const ambiguous = await semanticReceipt({
      chatId: `-${randomUUID()}`,
      messageId: 'ambiguous-retention',
      createdAt: old,
    });
    const mirrored = await semanticReceipt({
      chatId: `-${randomUUID()}`,
      messageId: 'mirrored-retention',
      createdAt: old,
    });
    const pendingMirror = await semanticReceipt({
      chatId: mirrored.update.message.chatId,
      messageId: 'mirrored-retention',
      createdAt: old,
    });
    await prisma.webhookEvent.updateMany({
      where: {
        id: { in: [settled.event.id, unfinished.event.id, ambiguous.event.id, mirrored.event.id] },
      },
      data: { status: 'PROCESSED', processedAt: old },
    });
    await prisma.webhookEvent.update({
      where: { id: ambiguous.event.id },
      data: { errorMessage: 'ambiguous remote mutation' },
    });
    const settledClaim = await readyClaim(settled, { status: 'COMPLETED', completedAt: old });
    await readyClaim(unfinished);
    await readyClaim(ambiguous, { status: 'COMPLETED', completedAt: old });
    await readyClaim(mirrored, { status: 'COMPLETED', completedAt: old });
    const command = await prisma.webhookExecutionClaim.create({
      data: {
        kind: 'COMMAND',
        semanticKey: `command-${randomUUID()}`,
        webhookEventId: settled.event.id,
        executionBotId: 'preparation-bot',
        enforced: true,
        status: 'COMPLETED',
        preparedAt: old,
        completedAt: old,
        commandResult: { action: 'NOTICE', applied: true, noticeText: 'Saved completed result' },
      },
    });
    createdClaimIds.push(command.id);
    const service = Object.create(WebhookOutboxService.prototype) as {
      deleteCompletedWebhookBatch: (cutoff: Date) => Promise<{ removed: number; scanned: number }>;
    };
    Object.defineProperty(service, 'prisma', { value: prisma });
    Object.defineProperty(service, 'webhookRetentionCursors', { value: new Map() });
    expect((await service.deleteCompletedWebhookBatch(cutoff)).removed).toBe(1);
    expect(await prisma.webhookEvent.findUnique({ where: { id: settled.event.id } })).toBeNull();
    expect(
      await prisma.webhookExecutionClaim.findUnique({ where: { id: settledClaim.id } }),
    ).toMatchObject({ webhookEventId: null, status: 'COMPLETED' });
    expect(
      await prisma.webhookExecutionClaim.findUnique({ where: { id: command.id } }),
    ).toMatchObject({
      webhookEventId: null,
      status: 'COMPLETED',
      commandResult: { action: 'NOTICE', applied: true },
    });
    expect(
      await prisma.webhookEvent.count({
        where: {
          id: {
            in: [
              unfinished.event.id,
              ambiguous.event.id,
              mirrored.event.id,
              pendingMirror.event.id,
            ],
          },
        },
      }),
    ).toBe(4);
  });

  it('keeps retention plans bounded across more than 10000 pinned rows and timestamp ties', async () => {
    const prefix = `retention-plan-${randomUUID()}`;
    const ids = Array.from(
      { length: 36_000 },
      (_, index) => `${prefix}-${String(index).padStart(5, '0')}`,
    );
    createdEventIds.push(...ids);
    for (let offset = 0; offset < ids.length; offset += 1_000) {
      await prisma.webhookEvent.createMany({
        data: ids.slice(offset, offset + 1_000).map((id, local) => {
          const index = offset + local;
          return {
            id,
            dedupKey: id,
            createdAt: new Date('2020-01-01T00:00:00Z'),
            status:
              index < 12_000
                ? WebhookStatus.PROCESSED
                : index < 24_000
                  ? WebhookStatus.DUPLICATE
                  : WebhookStatus.FAILED,
            semanticKey:
              index < 24_000 ? `${prefix}-terminal-semantic` : `${prefix}-quarantine-semantic`,
            errorMessage: index >= 24_000 ? 'WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINED:retain' : null,
            normalizedPayload: {},
            rawPayload: {},
          };
        }),
      });
    }
    await prisma.$executeRawUnsafe('ANALYZE webhook_events');
    for (const semanticKey of [
      `${prefix}-terminal-semantic`,
      `${prefix}-quarantine-semantic`,
      `${prefix}-absent-semantic`,
    ]) {
      const plan = await prisma.$queryRaw`
        EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
        SELECT id FROM webhook_events
        WHERE semantic_key = ${semanticKey} AND created_at <= ${executionCutoverAt}
        ORDER BY created_at ASC, id ASC LIMIT 1
      `;
      const nodes = collectExplainNodes(plan);
      const scans = nodes.filter((node) => node['Relation Name'] === 'webhook_events');
      expect(scans.some((node) => node['Node Type'] === 'Seq Scan')).toBe(false);
      expect(scans.some((node) => node['Index Name'] === 'webhook_events_semantic_order_idx')).toBe(
        true,
      );
      expect(nodes.some((node) => node['Node Type'] === 'Sort')).toBe(false);
      expect(
        scans.reduce(
          (visited, node) =>
            visited +
            Number(node['Actual Rows'] ?? 0) +
            Number(node['Rows Removed by Filter'] ?? 0),
          0,
        ),
      ).toBeLessThanOrEqual(1);
    }
    for (const phase of ['completed', 'failed'] as const) {
      let captured!: Prisma.Sql;
      const service = Object.create(WebhookOutboxService.prototype) as {
        deleteCompletedWebhookBatch: (cutoff: Date) => Promise<unknown>;
        deleteTerminalFailedWebhookBatch: (cutoff: Date) => Promise<unknown>;
      };
      Object.defineProperty(service, 'prisma', {
        value: {
          $transaction: (queries: Promise<unknown>[]) => Promise.all(queries),
          $executeRaw: async () => 0,
          $queryRaw: async (query: Prisma.Sql) => {
            captured = query;
            return [{ removed: 0, scanned: 0, lastId: null, lastCreatedAt: null }];
          },
        },
      });
      Object.defineProperty(service, 'webhookRetentionCursors', {
        value: new Map([
          [
            phase,
            {
              createdAt: new Date('2020-01-01T00:00:00Z'),
              id: ids[phase === 'completed' ? 8_000 : 28_000]!,
            },
          ],
        ]),
      });
      await (phase === 'completed'
        ? service.deleteCompletedWebhookBatch(new Date('2021-01-01T00:00:00Z'))
        : service.deleteTerminalFailedWebhookBatch(new Date('2021-01-01T00:00:00Z')));
      let plan: unknown;
      const rollback = new Error('rollback explained retention deletion');
      await expect(
        prisma.$transaction(
          async (tx) => {
            if (phase === 'failed') {
              await tx.$executeRaw`SET LOCAL enable_incremental_sort = off`;
              await tx.$executeRaw`SET LOCAL enable_bitmapscan = off`;
            }
            plan = await tx.$queryRaw(
              Prisma.sql`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${captured}`,
            );
            throw rollback;
          },
          { timeout: 30_000 },
        ),
      ).rejects.toBe(rollback);
      const nodes = collectExplainNodes(plan);
      const scans = nodes.filter((node) => node['Relation Name'] === 'webhook_events');
      expect(scans.some((node) => node['Node Type'] === 'Seq Scan')).toBe(false);
      if (phase === 'completed') {
        const terminalScan = scans.find(
          (node) => node['Index Name'] === 'webhook_events_retention_completed_created_id_idx',
        );
        expect(terminalScan).toBeDefined();
        expect(terminalScan!['Rows Removed by Filter'] ?? 0).toBe(0);
      }
      const visited = scans.reduce(
        (sum, node) =>
          sum +
          (Number(node['Actual Rows'] ?? 0) + Number(node['Rows Removed by Filter'] ?? 0)) *
            Number(node['Actual Loops'] ?? 0),
        0,
      );
      if (visited > 2_000)
        throw new Error(`Retention ${phase} visits=${visited}: ${JSON.stringify(scans)}`);
      expect(visited).toBeLessThanOrEqual(2_000);
      expect(
        nodes
          .filter((node) => node['Node Type'] === 'Sort')
          .every((node) => Number(node['Actual Rows'] ?? 0) <= 1_000),
      ).toBe(true);
    }
  }, 60_000);

  it.each([
    'persistAdminReadModels',
    'stageManagedEntityPendingBootstrap',
    'schedulePendingExecutionOwnerFailoverRecheck',
    'completeManagedEntityHandshake',
  ])('recovers the same durable receipt after failure in %s before READY', async (stage) => {
    const { id, update } = await preparationReceipt();
    const first = preparationService();
    jest
      .spyOn(first as never, stage as never)
      .mockRejectedValueOnce(new WebhookPreparationDeferredError('retry fixture', 1_000) as never);
    await expect(first.preparePersistedWebhookEvent(id, update)).rejects.toBeInstanceOf(
      WebhookPreparationDeferredError,
    );
    const pending = await prisma.webhookExecutionClaim.findFirst({ where: { webhookEventId: id } });
    expect(pending).toMatchObject({ status: 'PENDING', preparedAt: null, leaseToken: null });
    expect((await prisma.webhookEvent.findUnique({ where: { id } }))!.status).toBe('RECEIVED');
    const restarted = preparationService();
    expect((await restarted.preparePersistedWebhookEvent(id, update)).prepared).toBe(true);
    const ready = await prisma.webhookExecutionClaim.findFirst({ where: { webhookEventId: id } });
    expect(ready).toMatchObject({ id: pending!.id, status: 'READY', leaseToken: null });
    expect(ready!.preparedAt).not.toBeNull();
    await first.onModuleDestroy();
    await restarted.onModuleDestroy();
  });

  it('drains admitted preparation before shutdown and rejects new work without creating a claim', async () => {
    const { id, update } = await preparationReceipt();
    const service = preparationService();
    let reached!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    jest
      .spyOn(
        service as unknown as { completeManagedEntityHandshake: () => Promise<void> },
        'completeManagedEntityHandshake',
      )
      .mockImplementation(async () => {
        reached();
        await gate;
      });
    const running = service.preparePersistedWebhookEvent(id, update);
    await started;
    expect(
      await prisma.webhookExecutionClaim.findFirst({ where: { webhookEventId: id } }),
    ).toMatchObject({ preparedAt: null, status: 'PENDING' });
    const workers = service.stopWorkerAdmission();
    let drained = false;
    const draining = workers[0]!.pause(false).then(() => {
      drained = true;
    });
    await expect(
      service.preparePersistedWebhookEvent('not-admitted', update),
    ).rejects.toBeInstanceOf(WebhookPreparationDeferredError);
    expect(
      await prisma.webhookExecutionClaim.count({ where: { webhookEventId: 'not-admitted' } }),
    ).toBe(0);
    expect(drained).toBe(false);
    release();
    await Promise.all([running, draining]);
    expect(drained).toBe(true);
    expect(
      await prisma.webhookExecutionClaim.findFirst({ where: { webhookEventId: id } }),
    ).toMatchObject({ status: 'READY' });
  });

  it('does not replay completed preparation for a mirrored receipt', async () => {
    const { id, update } = await preparationReceipt();
    const service = preparationService();
    await service.preparePersistedWebhookEvent(id, update);
    const mirrorId = `preparation-mirror-${randomUUID()}`;
    createdEventIds.push(mirrorId);
    const mirror = { ...update, updateId: mirrorId, botId: 'mirror-bot' };
    await prisma.webhookEvent.create({
      data: {
        id: mirrorId,
        dedupKey: mirrorId,
        botId: mirror.botId,
        rawPayload: {},
        normalizedPayload: mirror,
      },
    });
    const core = jest.spyOn(service as never, 'prepareWebhookEventCore' as never);
    expect((await service.preparePersistedWebhookEvent(mirrorId, mirror)).canonical).toBe(false);
    expect(core).not.toHaveBeenCalled();
    expect(await prisma.webhookEvent.findUnique({ where: { id: mirrorId } })).toMatchObject({
      status: 'DUPLICATE',
    });
    await service.onModuleDestroy();
  });

  it('skips identical prepared JSON without changing the heap tuple and persists a changed owner', async () => {
    const id = `payload-noop-${randomUUID()}`;
    createdEventIds.push(id);
    const payload = { type: 'message_created', raw: { text: 'kept', attachments: [] } };
    await prisma.webhookEvent.create({
      data: {
        id,
        dedupKey: id,
        rawPayload: {},
        normalizedPayload: payload,
      },
    });
    const tuple = () => prisma.$queryRaw<Array<{ version: string }>>`
      SELECT xmin::text AS version FROM webhook_events WHERE id = ${id}
    `;
    const before = await tuple();
    // JSONB equality is semantic, including object key ordering.
    await expect(
      writeWebhookPayload(prisma, id, {
        raw: { attachments: [], text: 'kept' },
        type: 'message_created',
      }),
    ).resolves.toEqual({ count: 0 });
    expect(await tuple()).toEqual(before);
    const changed = { ...payload, executionOwnerBotId: 'owner' };
    await expect(writeWebhookPayload(prisma, id, changed)).resolves.toEqual({ count: 1 });
    expect(
      (await prisma.webhookEvent.findUniqueOrThrow({ where: { id } })).normalizedPayload,
    ).toEqual(changed);
    await prisma.webhookEvent.update({ where: { id }, data: { status: WebhookStatus.PROCESSED } });
    await expect(writeWebhookPayload(prisma, id, payload)).resolves.toEqual({ count: 0 });
    expect(
      (await prisma.webhookEvent.findUniqueOrThrow({ where: { id } })).normalizedPayload,
    ).toEqual(changed);
  });

  it('commits payload and queue activation with one SQL statement each and only one race winner', async () => {
    const { id } = await preparationReceipt();
    const event = await prisma.webhookEvent.findUniqueOrThrow({ where: { id } });
    const data = {
      status: WebhookStatus.QUEUED,
      queueName: 'moderation-critical',
      queuedAt: new Date(),
      nextEnqueueAt: null,
      timeoutQuarantineExpiresAt: null,
      errorMessage: null,
      enqueueAttempts: { increment: 1 },
    } as const;
    const queries = jest.spyOn(Client.prototype, 'query');
    try {
      await expect(
        writeWebhookPayload(prisma, id, { type: 'message_created', text: 'changed' }),
      ).resolves.toEqual({ count: 1 });
      // The pg adapter must receive a single atomic UPDATE, with no ORM transaction envelope.
      expect(queries).toHaveBeenCalledTimes(1);
      queries.mockClear();
      await expect(writeWebhookEnqueueState(prisma, event, data)).resolves.toEqual({ count: 1 });
      expect(queries).toHaveBeenCalledTimes(1);
    } finally {
      queries.mockRestore();
    }
    const queued = await prisma.webhookEvent.findUniqueOrThrow({ where: { id } });
    const race = await Promise.all([
      writeWebhookEnqueueState(prisma, queued, { ...data, enqueueAttempts: { increment: 1 } }),
      writeWebhookEnqueueState(prisma, queued, { ...data, enqueueAttempts: { increment: 1 } }),
    ]);
    expect(race.map((row) => row.count).sort()).toEqual([0, 1]);
    const current = await prisma.webhookEvent.findUniqueOrThrow({ where: { id } });
    expect(current.enqueueAttempts).toBe(2);
    expect(current.queuedAt).toEqual(data.queuedAt);
    expect(current.rawPayload).toEqual(event.rawPayload);
  });

  it.each([
    ['status', WebhookStatus.FAILED],
    ['queueName', 'changed'],
    ['enqueueAttempts', 4],
    ['queuedAt', new Date(1000)],
    ['nextEnqueueAt', new Date(2000)],
    ['timeoutQuarantineExpiresAt', new Date(3000)],
    ['errorMessage', 'changed'],
  ] as const)('rejects a stale %s snapshot without changing the receipt', async (field, value) => {
    const { id } = await preparationReceipt();
    const event = await prisma.webhookEvent.findUniqueOrThrow({ where: { id } });
    const stale = { ...event, [field]: value } as WebhookEnqueueSnapshot;
    await expect(
      writeWebhookEnqueueState(prisma, stale, {
        status: WebhookStatus.QUEUED,
        queueName: 'moderation-critical',
        queuedAt: new Date(),
        nextEnqueueAt: null,
        timeoutQuarantineExpiresAt: null,
        errorMessage: null,
        enqueueAttempts: { increment: 1 },
      }),
    ).resolves.toEqual({ count: 0 });
    expect(await prisma.webhookEvent.findUniqueOrThrow({ where: { id } })).toEqual(event);
  });

  it('executes the bulk ordered-head query and returns the oldest event per chat', async () => {
    const suffix = randomUUID();
    const chatA = `outbox-chat-a-${suffix}`;
    const chatB = `outbox-chat-b-${suffix}`;
    const emptyChat = `outbox-chat-empty-${suffix}`;
    const firstCreatedAt = new Date('2026-08-15T08:00:00.000Z');
    const secondCreatedAt = new Date('2026-08-15T08:00:01.000Z');
    const eventAFirst = `outbox-a-1-${suffix}`;
    const eventASecond = `outbox-a-2-${suffix}`;
    const eventB = `outbox-b-1-${suffix}`;
    createdEventIds.push(eventAFirst, eventASecond, eventB);

    await prisma.webhookEvent.createMany({
      data: [
        {
          id: eventASecond,
          dedupKey: `outbox-dedup-a-2-${suffix}`,
          status: WebhookStatus.RECEIVED,
          rawPayload: {},
          normalizedPayload: {
            type: 'message_created',
            message: { chatId: chatA },
          },
          createdAt: secondCreatedAt,
        },
        {
          id: eventAFirst,
          dedupKey: `outbox-dedup-a-1-${suffix}`,
          status: WebhookStatus.RECEIVED,
          rawPayload: {},
          normalizedPayload: {
            type: 'message_edited',
            message: { chatId: chatA },
          },
          createdAt: firstCreatedAt,
        },
        {
          id: eventB,
          dedupKey: `outbox-dedup-b-1-${suffix}`,
          status: WebhookStatus.FAILED,
          rawPayload: {},
          normalizedPayload: {
            type: 'message_created',
            message: { chatId: chatB },
          },
          nextEnqueueAt: secondCreatedAt,
          createdAt: secondCreatedAt,
        },
      ],
    });

    const heads = await reader.findOrderedWebhookHeadsForChats([chatA, chatB, emptyChat]);

    expect(heads).toEqual(
      new Map([
        [chatA, { id: eventAFirst, createdAt: firstCreatedAt, quarantined: false }],
        [chatB, { id: eventB, createdAt: secondCreatedAt, quarantined: false }],
      ]),
    );
  });

  it.each(
    [false, true]
      .flatMap((degraded) =>
        ['received', 'failed', 'queued', 'background'].map((lane) => ({
          degraded,
          lane,
          batchSize: degraded ? 40 : 100,
        })),
      )
      .concat([{ degraded: true, lane: 'received', batchSize: 1 }]),
  )(
    'reaches middle backlog despite a blocked hot head and a growing tail (degraded=$degraded, lane=$lane, batch=$batchSize)',
    async ({ degraded, lane, batchSize }) => {
      Object.defineProperty(reader, 'enqueueScans', {
        value: new Map(),
        configurable: true,
        writable: true,
      });
      const suffix = randomUUID();
      const hotChat = `middle-hot-${suffix}`;
      const middleId = `middle-independent-${suffix}`;
      const half = degraded ? 1200 : 6000;
      const base = Date.parse('2026-08-16T00:00:00.000Z');
      const now = new Date(base + 100_000_000);
      const row = (index: number) => ({
        id: `middle-${String(index).padStart(6, '0')}-${suffix}`,
        dedupKey: `middle-${index}-${suffix}`,
        status:
          lane === 'received'
            ? WebhookStatus.RECEIVED
            : lane === 'failed'
              ? WebhookStatus.FAILED
              : WebhookStatus.QUEUED,
        nextEnqueueAt: lane === 'failed' ? new Date(base) : null,
        queueName: lane === 'background' ? 'moderation-background' : null,
        createdAt: new Date(base + index * 1000),
        rawPayload: {},
        normalizedPayload: { type: 'message_created', message: { chatId: hotChat } },
      });
      const rows = Array.from({ length: half * 2 + 1 }, (_, index) => row(index));
      rows[half] = {
        ...rows[half]!,
        id: middleId,
        normalizedPayload: {
          type: 'message_created',
          message: { chatId: `independent-${suffix}` },
        },
      };
      createdEventIds.push(...rows.map(({ id }) => id));
      for (let start = 0; start < rows.length; start += 1000)
        await prisma.webhookEvent.createMany({ data: rows.slice(start, start + 1000) });
      await prisma.webhookEvent.update({
        where: { id: rows[0]!.id },
        data: { nextEnqueueAt: new Date(now.getTime() + 60_000) },
      });
      let observed = false;
      for (let pass = 0; pass < 8; pass += 1) {
        const tail = { ...row(half * 2 + 1 + pass), createdAt: new Date(now.getTime() + pass + 1) };
        createdEventIds.push(tail.id);
        await prisma.webhookEvent.create({ data: tail });
        const candidates = await reader.selectEnqueueCandidates(
          new Date(now.getTime() + pass + 1),
          {
            degraded,
            batchSize,
            enqueueConcurrency: 2,
            includeQueuedRepair: true,
            includeCompletedTimeoutRepair: true,
            expandSelectedChats: false,
          },
        );
        observed ||= candidates.some(({ id }) => id === middleId);
      }
      expect(observed).toBe(true);
      if (!degraded && lane === 'received') {
        // FLAG: Model the settled receipt history when checking planner selectivity. A
        // tiny all-pending heap can correctly favor a sequential scan for a broad page.
        for (let offset = 0; offset < 50_000; offset += 1_000) {
          const history = Array.from({ length: 1_000 }, (_, index) => ({
            ...row(offset + index),
            id: `settled-${offset + index}-${suffix}`,
            dedupKey: `settled-${offset + index}-${suffix}`,
            status: WebhookStatus.PROCESSED,
            createdAt: new Date(base - 60_000),
          }));
          createdEventIds.push(...history.map(({ id }) => id));
          await prisma.webhookEvent.createMany({ data: history });
        }
        await prisma.$executeRaw`ANALYZE webhook_events`;
        const capture = jest.spyOn(prisma, '$queryRaw');
        await reader.selectEnqueueCandidates(now);
        const query = capture.mock.calls[0]![0] as Prisma.Sql;
        capture.mockRestore();
        const explained = await prisma.$queryRaw<Array<{ 'QUERY PLAN': unknown }>>(
          Prisma.sql`EXPLAIN (ANALYZE, FORMAT JSON) ${query}`,
        );
        const nodes = collectExplainNodes(explained);
        const pools = nodes.filter((node) => node['Subplan Name'] === 'CTE page_pool');
        expect(pools).toHaveLength(5);
        expect(pools.every((node) => Number(node['Actual Rows']) <= 2500)).toBe(true);
        expect(
          nodes
            .filter(
              (node) =>
                node['Node Type'] === 'Seq Scan' && node['Relation Name'] === 'webhook_events',
            )
            .map((node) => ({
              node: node['Node Type'],
              rows: node['Actual Rows'],
              removed: node['Rows Removed by Filter'],
            })),
        ).toEqual([]);
        expect(query.sql).not.toMatch(/\bOFFSET\b/);
      }

      expect((await reader.findOrderedWebhookHeadsForChats([hotChat])).get(hotChat)?.id).toBe(
        rows[0]!.id,
      );
    },
    30_000,
  );

  it('does not skip capped distinct pages and safely repeats after cursor loss or a failed query', async () => {
    const service = reader as unknown as {
      enqueueScans?: Map<string, unknown>;
      prisma: PrismaClient;
    };
    service.enqueueScans = new Map();
    const suffix = randomUUID();
    const base = Date.parse('2026-08-17T00:00:00Z');
    const rows = Array.from({ length: 800 }, (_, index) => ({
      id: `scan-cap-${String(index).padStart(4, '0')}-${suffix}`,
      dedupKey: `scan-cap-${index}-${suffix}`,
      createdAt: new Date(base + index),
      status: WebhookStatus.RECEIVED,
      rawPayload: {},
      normalizedPayload: {
        type: 'message_created',
        message: { chatId: `scan-chat-${index}-${suffix}` },
      },
    }));
    createdEventIds.push(...rows.map(({ id }) => id));
    await prisma.webhookEvent.createMany({ data: rows });
    const now = new Date(base + 10_000);
    const observed = new Set<string>();
    for (let pass = 0; pass < 80; pass++) {
      const candidates = await reader.selectEnqueueCandidates(now);
      const prioritized = await (
        reader as unknown as {
          prioritizeCandidates(
            candidates: unknown[],
            now: Date,
            take: number,
          ): Promise<Array<{ id: string }>>;
        }
      ).prioritizeCandidates(candidates, now, 100);
      for (const candidate of prioritized) observed.add(candidate.id);
      if (pass === 1) {
        const state = JSON.stringify([...service.enqueueScans.entries()]);
        const failure = jest
          .spyOn(prisma, '$queryRaw')
          .mockRejectedValueOnce(new Error('SQL unavailable'));
        await expect(reader.selectEnqueueCandidates(now)).rejects.toThrow('SQL unavailable');
        expect(JSON.stringify([...service.enqueueScans.entries()])).toBe(state);
        failure.mockRestore();
        service.enqueueScans = new Map(); // Process restart: durable rows are not advanced or removed.
      }
    }
    expect(rows.every(({ id }) => observed.has(id))).toBe(true);
  });

  it('collapses a 4k hot chat inside bounded lane scans without probing every global head', async () => {
    const suffix = randomUUID();
    const poisonChat = `outbox-poison-${suffix}`;
    const fencedChat = `outbox-fenced-${suffix}`;
    const lifecycleEventId = `outbox-lifecycle-${suffix}`;
    const [fencedHeadId, fencedNewerId] = [randomUUID(), randomUUID()].sort();
    const baseCreatedAt = new Date('2026-08-15T09:00:00.000Z');
    const tiedCreatedAt = new Date(baseCreatedAt.getTime() + 4_100_000);
    const now = new Date('2026-08-15T12:00:00.000Z');
    const poisonRows = Array.from({ length: 4_000 }, (_, index) => ({
      id: `outbox-poison-${String(index).padStart(4, '0')}-${suffix}`,
      dedupKey: `outbox-poison-dedup-${index}-${suffix}`,
      status: WebhookStatus.RECEIVED,
      rawPayload: {},
      normalizedPayload: {
        updateId: `outbox-poison-update-${index}-${suffix}`,
        type: 'message_created',
        message: {
          chatId: poisonChat,
          messageId: `outbox-poison-message-${index}-${suffix}`,
        },
      },
      createdAt: new Date(baseCreatedAt.getTime() + index * 1_000),
    }));
    createdEventIds.push(
      ...poisonRows.map((row) => row.id),
      lifecycleEventId,
      fencedHeadId,
      fencedNewerId,
    );

    await prisma.webhookEvent.createMany({
      data: [
        ...poisonRows,
        {
          id: lifecycleEventId,
          dedupKey: `outbox-lifecycle-dedup-${suffix}`,
          status: WebhookStatus.RECEIVED,
          rawPayload: {},
          normalizedPayload: {
            updateId: `outbox-lifecycle-update-${suffix}`,
            type: 'user_removed',
            chatId: fencedChat,
          },
          createdAt: tiedCreatedAt,
        },
        {
          id: fencedHeadId,
          dedupKey: `outbox-fenced-head-dedup-${suffix}`,
          status: WebhookStatus.FAILED,
          rawPayload: {},
          normalizedPayload: {
            updateId: `outbox-fenced-head-update-${suffix}`,
            type: 'message_created',
            message: { chatId: fencedChat, messageId: `fenced-head-${suffix}` },
          },
          nextEnqueueAt: new Date(now.getTime() + 60_000),
          createdAt: tiedCreatedAt,
        },
        {
          id: fencedNewerId,
          dedupKey: `outbox-fenced-newer-dedup-${suffix}`,
          status: WebhookStatus.RECEIVED,
          rawPayload: {},
          normalizedPayload: {
            updateId: `outbox-fenced-newer-update-${suffix}`,
            type: 'message_edited',
            message: { chatId: fencedChat, messageId: `fenced-newer-${suffix}` },
          },
          createdAt: tiedCreatedAt,
        },
      ],
    });

    // FLAG: This plan owns its settled-history skew and statistics. Prior cases delete their
    // fixtures after ANALYZE; inherited statistics or autoanalyze timing cannot model this case.
    for (let offset = 0; offset < 10_000; offset += 1_000) {
      const history = Array.from({ length: 1_000 }, (_, index) => ({
        ...poisonRows[0]!,
        id: `outbox-settled-${offset + index}-${suffix}`,
        dedupKey: `outbox-settled-${offset + index}-${suffix}`,
        status: WebhookStatus.PROCESSED,
        createdAt: new Date(baseCreatedAt.getTime() - 60_000),
        processedAt: baseCreatedAt,
      }));
      createdEventIds.push(...history.map(({ id }) => id));
      await prisma.webhookEvent.createMany({ data: history });
    }
    await prisma.$executeRaw`ANALYZE webhook_events`;

    const candidates = await reader.selectEnqueueCandidates(now);
    const selectedTestIds = candidates
      .map((candidate) => candidate.id)
      .filter((id) => createdEventIds.includes(id));

    expect(selectedTestIds).toContain(poisonRows[0]!.id);
    expect(selectedTestIds).toContain(lifecycleEventId);
    expect(selectedTestIds.filter((id) => id.startsWith('outbox-poison-'))).toEqual([
      poisonRows[0]!.id,
    ]);
    expect(selectedTestIds).not.toContain(fencedHeadId);
    expect(selectedTestIds).toContain(fencedNewerId);
    await expect(reader.findOrderedWebhookHeadsForChats([fencedChat])).resolves.toEqual(
      new Map([[fencedChat, { id: fencedHeadId, createdAt: tiedCreatedAt, quarantined: false }]]),
    );

    await prisma.webhookEvent.update({
      where: { id: fencedHeadId },
      data: { nextEnqueueAt: now },
    });
    const dueCandidates = await reader.selectEnqueueCandidates(now);
    const dueSelectedTestIds = dueCandidates
      .map((candidate) => candidate.id)
      .filter((id) => createdEventIds.includes(id));
    expect(dueSelectedTestIds).toContain(fencedHeadId);
    expect(dueSelectedTestIds).not.toContain(fencedNewerId);
    expect(dueSelectedTestIds).toContain(lifecycleEventId);

    const dueHead = dueCandidates.find((candidate) => candidate.id === fencedHeadId);
    if (!dueHead) {
      throw new Error('Expected the due ordered head to be selected');
    }
    const expandedCandidates = await reader.expandSelectedChatCandidates(
      [{ ...dueHead, priority: 5 }],
      now,
    );
    const expandedTestIds = expandedCandidates
      .map((candidate) => candidate.id)
      .filter((id) => createdEventIds.includes(id));
    expect(expandedTestIds).toContain(fencedHeadId);
    expect(expandedTestIds).toContain(fencedNewerId);
    expect(expandedTestIds).not.toContain(lifecycleEventId);

    const hotHead = dueCandidates.find((candidate) => candidate.id === poisonRows[0]!.id)!;
    const hotExpansion = await reader.expandSelectedChatCandidates(
      [
        { ...hotHead, priority: 5 },
        { ...dueHead, priority: 5 },
      ],
      now,
    );
    expect(
      hotExpansion.filter((candidate) => candidate.id.startsWith('outbox-poison-')),
    ).toHaveLength(16);
    expect(hotExpansion.map((candidate) => candidate.id)).toContain(fencedNewerId);

    let capturedExpansionQuery: Prisma.Sql | null = null;
    const expansionCaptureService = Object.create(WebhookOutboxService.prototype) as object;
    Object.defineProperty(expansionCaptureService, 'batchSize', { value: 100 });
    Object.defineProperty(expansionCaptureService, 'prisma', {
      value: {
        $transaction: async (operation: (tx: unknown) => Promise<unknown>) =>
          operation({
            $executeRaw: async () => 0,
            $queryRaw: async (query: Prisma.Sql) => {
              capturedExpansionQuery = query;
              return [];
            },
          }),
      },
    });
    await (expansionCaptureService as OrderedWebhookHeadReader).expandSelectedChatCandidates(
      [
        { ...hotHead, priority: 5 },
        { ...dueHead, priority: 5 },
      ],
      now,
    );
    expect(capturedExpansionQuery).not.toBeNull();
    expect(capturedExpansionQuery!.sql).toContain('selected_chat_heads AS MATERIALIZED');
    expect(capturedExpansionQuery!.values.filter((value) => typeof value === 'number')).toEqual([
      16, 300,
    ]);
    const expansionPlan = await prisma.$queryRaw<Array<{ 'QUERY PLAN': unknown }>>(
      Prisma.sql`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${capturedExpansionQuery!}`,
    );
    const expansionNodes = collectExplainNodes(expansionPlan);
    try {
      expect(expansionNodes.map((node) => node['Index Name'])).toContain(
        'webhook_events_ordered_chat_head_idx',
      );
      expect(
        expansionNodes.some(
          (node) => node['Node Type'] === 'Seq Scan' && node['Relation Name'] === 'webhook_events',
        ),
      ).toBe(false);
      const scans = expansionNodes.filter(
        (node) => node['Relation Name'] === 'webhook_events' && Number(node['Actual Loops']) > 0,
      );
      expect(scans).toHaveLength(1);
      expect(scans[0]).toMatchObject({
        'Index Name': 'webhook_events_ordered_chat_head_idx',
        'Actual Loops': 2,
      });
      // FLAG: LIMIT output alone is not a work bound: include rows discarded by the scan.
      const scannedRows =
        Number(scans[0]!['Actual Loops']) *
        (Number(scans[0]!['Actual Rows']) +
          Number(scans[0]!['Rows Removed by Filter'] ?? 0) +
          Number(scans[0]!['Rows Removed by Index Recheck'] ?? 0));
      expect(scannedRows).toBeGreaterThan(0);
      expect(scannedRows).toBeLessThanOrEqual(2 * 16);
    } catch (error) {
      throw new Error(`Selected-chat expansion plan: ${JSON.stringify(expansionPlan)}`, {
        cause: error,
      });
    }

    // Ineligible heads must consume the window, not trigger an unbounded search for due rows.
    await prisma.webhookEvent.updateMany({
      where: { id: { in: poisonRows.slice(0, 16).map((row) => row.id) } },
      data: { nextEnqueueAt: new Date(now.getTime() + 60_000) },
    });
    const fencedExpansion = await reader.expandSelectedChatCandidates(
      [
        { ...hotHead, priority: 5 },
        { ...dueHead, priority: 5 },
      ],
      now,
    );
    expect(
      fencedExpansion.filter((candidate) => candidate.id.startsWith('outbox-poison-')),
    ).toEqual([{ ...hotHead, priority: 5 }]);
    expect(fencedExpansion.map((candidate) => candidate.id)).toContain(fencedNewerId);

    let capturedSelectionQuery: Prisma.Sql | null = null;
    const captureService = Object.create(WebhookOutboxService.prototype) as object;
    Object.defineProperty(captureService, 'batchSize', { value: 100 });
    Object.defineProperty(captureService, 'prisma', {
      value: {
        $queryRaw: async (query: Prisma.Sql) => {
          capturedSelectionQuery = query;
          return [];
        },
      },
    });
    await (captureService as OrderedWebhookHeadReader).selectEnqueueCandidates(now);
    expect(capturedSelectionQuery).not.toBeNull();
    expect(capturedSelectionQuery!.sql).not.toContain('LATERAL');
    expect(capturedSelectionQuery!.values.filter((value) => value === 5_000)).toHaveLength(1);
    // Three unchanged oldest lanes split 5k; FAILED shares 4,800 due + 200 recovery rows.
    expect(capturedSelectionQuery!.values.filter((value) => value === 2_500)).toHaveLength(9);

    const plan = await prisma.$transaction(async (transaction) => {
      await transaction.$executeRaw`SET LOCAL enable_seqscan = off`;
      return transaction.$queryRaw<Array<{ 'QUERY PLAN': unknown }>>(
        Prisma.sql`EXPLAIN (FORMAT JSON) ${capturedSelectionQuery!}`,
      );
    });
    const planNodes = collectExplainNodes(plan);
    expect(planNodes.some((node) => node['Subplan Name'] === 'CTE ordered_message_head_ids')).toBe(
      false,
    );
    expect(planNodes.some((node) => node['Alias'] === 'ordered_chat_head_event')).toBe(false);
    expect(planNodes.filter((node) => node['Node Type'] === 'Limit').length).toBeGreaterThanOrEqual(
      5,
    );
  });

  it('cancels blocked optional expansion in PostgreSQL and releases its connection', async () => {
    let releaseLock!: () => void;
    let markLocked!: () => void;
    const lockHeld = new Promise<void>((resolve) => {
      markLocked = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    const blocker = prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`LOCK TABLE webhook_events IN ACCESS EXCLUSIVE MODE`;
        markLocked();
        await release;
      },
      { timeout: 5_000 },
    );
    try {
      await Promise.race([
        lockHeld,
        blocker.then(() => {
          throw new Error('Lock was not held');
        }),
      ]);
      await expect(
        reader.expandSelectedChatCandidates(
          [
            {
              id: randomUUID(),
              status: WebhookStatus.RECEIVED,
              createdAt: new Date(),
              normalizedPayload: {
                type: 'message_created',
                message: { chatId: 'expansion-timeout' },
              },
              priority: 5,
            },
          ],
          new Date(),
        ),
      ).rejects.toThrow(/statement timeout/u);
    } finally {
      releaseLock();
      await blocker;
    }
    await expect(prisma.$queryRaw`SELECT 1 AS ok`).resolves.toEqual([{ ok: 1 }]);
  });

  it('bounds timeout proof probes before filtering history while live receipts and due retries progress', async () => {
    (reader as unknown as { enqueueScans: Map<string, unknown> }).enqueueScans = new Map();
    const suffix = randomUUID();
    const base = Date.parse('2026-09-01T00:00:00Z');
    const now = new Date(base + 60_000);
    const history = Array.from({ length: 1_201 }, (_, index) => ({
      id: `timeout-bound-${String(index).padStart(4, '0')}-${suffix}`,
      dedupKey: `timeout-bound-${index}-${suffix}`,
      createdAt: new Date(base + index),
      status: WebhookStatus.FAILED,
      rawPayload: {},
      errorMessage: `${WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINE_PREFIX}:fixture: retained`,
      normalizedPayload: {
        type: 'message_created',
        message: { chatId: `timeout-chat-${index}-${suffix}`, messageId: `message-${index}` },
      },
    }));
    const repair = history.at(-1)!;
    const due = {
      ...repair,
      id: `due-${suffix}`,
      dedupKey: `due-${suffix}`,
      nextEnqueueAt: now,
      normalizedPayload: { type: 'message_created', message: { chatId: `due-${suffix}` } },
    };
    const live = {
      ...due,
      id: `live-${suffix}`,
      dedupKey: `live-${suffix}`,
      status: WebhookStatus.RECEIVED,
      normalizedPayload: { type: 'message_created', message: { chatId: `live-${suffix}` } },
    };
    createdEventIds.push(...history.map(({ id }) => id), due.id, live.id);
    await prisma.webhookEvent.createMany({ data: [...history, due, live] });
    await prisma.webhookExecutionClaim.create({
      data: {
        id: `claim-${suffix}`,
        kind: 'EXECUTION',
        semanticKey: `timeout-bound-${suffix}`,
        webhookEventId: repair.id,
        status: WebhookExecutionClaimStatus.COMPLETED,
        preparedAt: now,
        completedAt: now,
      },
    });
    const capture = jest.spyOn(prisma, '$queryRaw');
    let query: Prisma.Sql;
    try {
      const first = await reader.selectEnqueueCandidates(now);
      query = capture.mock.calls[0]![0] as Prisma.Sql;
      expect(first.map(({ id }) => id)).toEqual(expect.arrayContaining([due.id, live.id]));
      // The completed row lies beyond the first physical recovery page. Checking all
      // historical claims before LIMIT would incorrectly reach it in this first pass.
      expect(first.map(({ id }) => id)).not.toContain(repair.id);
    } finally {
      capture.mockRestore();
    }
    const explained = await prisma.$queryRaw<Array<{ 'QUERY PLAN': unknown }>>(
      Prisma.sql`EXPLAIN (ANALYZE, FORMAT JSON) ${query!}`,
    );
    const nodes = collectExplainNodes(explained);
    const rawPools = nodes.filter((node) =>
      ['CTE head_source', 'CTE page_source'].includes(String(node['Subplan Name'])),
    );
    expect(rawPools).toHaveLength(2);
    expect(rawPools.every((node) => Number(node['Actual Rows']) <= 100)).toBe(true);
    expect(
      nodes
        .filter((node) => node['Relation Name'] === 'webhook_execution_claims')
        .every((node) => Number(node['Actual Loops']) <= 200),
    ).toBe(true);
    let recovered = false;
    for (let pass = 0; pass < 14; pass++) {
      const candidates = await reader.selectEnqueueCandidates(now);
      expect(candidates.map(({ id }) => id)).toEqual(expect.arrayContaining([due.id, live.id]));
      recovered ||= candidates.some(({ id }) => id === repair.id);
      expect(candidates.every(({ id }) => [due.id, live.id, repair.id].includes(id))).toBe(true);
    }
    expect(recovered).toBe(true);
  });

  it('selects a retained snake-case mirror only from a clean completed semantic owner', async () => {
    const suffix = randomUUID();
    const chatId = `outbox-semantic-chat-${suffix}`;
    const messageId = `outbox-semantic-message-${suffix}`;
    const ownerId = `outbox-semantic-owner-${suffix}`;
    const mirrorId = `outbox-semantic-mirror-${suffix}`;
    const claimId = `outbox-semantic-claim-${suffix}`;
    const ownerCompletedAt = new Date('2026-08-15T11:00:01.000Z');
    const now = new Date('2026-08-15T12:00:00.000Z');
    const mirrorPayload = {
      update_id: `mirror-update-${suffix}`,
      bot_id: 'bot-mirror',
      type: 'message_created',
      message: { chat_id: chatId, message_id: messageId },
    };
    const ownerPayload = {
      update_id: `owner-update-${suffix}`,
      bot_id: 'bot-owner',
      type: 'message_created',
      message: { chat_id: chatId, message_id: messageId },
    };
    const semanticKey = buildWebhookSemanticEventKey(mirrorPayload);
    if (!semanticKey || semanticKey !== buildWebhookSemanticEventKey(ownerPayload)) {
      throw new Error('Expected snake-case bot envelopes to share one semantic key');
    }
    createdEventIds.push(ownerId, mirrorId);

    await prisma.webhookEvent.createMany({
      data: [
        {
          id: ownerId,
          dedupKey: `outbox-semantic-owner-dedup-${suffix}`,
          status: WebhookStatus.PROCESSED,
          botId: 'bot-owner',
          rawPayload: {},
          normalizedPayload: ownerPayload,
          processedAt: ownerCompletedAt,
          createdAt: new Date('2026-08-15T11:00:00.000Z'),
        },
        {
          id: mirrorId,
          dedupKey: `outbox-semantic-mirror-dedup-${suffix}`,
          status: WebhookStatus.FAILED,
          botId: 'bot-mirror',
          queueName: 'moderation-default-2',
          enqueueAttempts: 1,
          rawPayload: {},
          normalizedPayload: mirrorPayload,
          errorMessage: `${WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINE_PREFIX}:nonce-${suffix}: detached execution failed without a canonical claim`,
          queuedAt: new Date('2026-08-15T11:00:02.000Z'),
          createdAt: new Date('2026-08-15T11:00:00.100Z'),
        },
      ],
    });
    await prisma.webhookExecutionClaim.create({
      data: {
        id: claimId,
        kind: 'EXECUTION',
        semanticKey,
        webhookEventId: ownerId,
        status: WebhookExecutionClaimStatus.READY,
        preparedAt: new Date('2026-08-15T11:00:00.500Z'),
        leaseToken: `lease-${suffix}`,
        leaseExpiresAt: new Date('2026-08-15T11:05:00.000Z'),
      },
    });

    const transitionalCandidates = await reader.selectEnqueueCandidates(now);
    expect(transitionalCandidates.map(({ id }) => id)).not.toContain(mirrorId);

    await prisma.webhookExecutionClaim.update({
      where: { id: claimId },
      data: {
        status: WebhookExecutionClaimStatus.COMPLETED,
        completedAt: ownerCompletedAt,
        leaseToken: null,
        leaseExpiresAt: null,
      },
    });
    const completedCandidates = await reader.selectEnqueueCandidates(now);
    expect(completedCandidates.map(({ id }) => id)).toContain(mirrorId);

    const admissionWithoutTimeoutScan = {
      degraded: false,
      batchSize: 100,
      enqueueConcurrency: 4,
      includeQueuedRepair: true,
      includeCompletedTimeoutRepair: false,
      expandSelectedChats: true,
    };
    const pacedCandidates = await reader.selectEnqueueCandidates(now, admissionWithoutTimeoutScan);
    expect(pacedCandidates.map(({ id }) => id)).not.toContain(mirrorId);

    await prisma.webhookEvent.update({
      where: { id: mirrorId },
      data: { nextEnqueueAt: now },
    });
    const dueRetryCandidates = await reader.selectEnqueueCandidates(
      now,
      admissionWithoutTimeoutScan,
    );
    expect(dueRetryCandidates.map(({ id }) => id)).toContain(mirrorId);
    await prisma.webhookEvent.update({
      where: { id: mirrorId },
      data: { nextEnqueueAt: null },
    });

    await prisma.webhookEvent.update({
      where: { id: ownerId },
      data: {
        normalizedPayload: {
          ...ownerPayload,
          message: { chat_id: chatId, message_id: `different-${messageId}` },
        },
      },
    });
    const invalidOwnerCandidates = await reader.selectEnqueueCandidates(now);
    expect(invalidOwnerCandidates.map(({ id }) => id)).not.toContain(mirrorId);
  });
});
