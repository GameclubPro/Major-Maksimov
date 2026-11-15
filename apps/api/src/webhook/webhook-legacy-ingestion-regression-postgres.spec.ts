import { legacyReceiptSourceDigest } from './webhook-legacy-receipt-disposition';
import { buildWebhookSemanticEventKey } from './webhook-semantic-event-key';
import { buildWebhookReceiptSemanticKey } from './webhook-receipt-semantic-key';
import { ConfigService } from '@nestjs/config';
import { Queue, type ConnectionOptions } from 'bullmq';
import Redis from 'ioredis';
import { randomUUID } from 'node:crypto';
import type { MaxUpdate } from '@maxim/contracts';
import { WebhookPreparationDeferredError } from '../common/webhook-preparation-deferred.error';
import { HealthService } from '../health/health.service';
import {
  createPrismaClient,
  Prisma,
  WebhookStatus,
  type PrismaClient,
} from '../prisma/prisma-client';
import { RUNTIME_SERVICE_NAMES } from '../runtime/runtime-topology';
import { ActionHealthService } from '../system/action-health.service';
import { SystemModeService } from '../system/system-mode.service';
import { QueueMetricsService } from '../system/queue-metrics.service';
import { buildOldestPendingWebhookQuery } from '../system/webhook-oldest-pending';
import {
  buildLegacyRecoveryPreviewDigest,
  createLegacyColdCertificate,
  inspectLegacyRecoveryCandidate,
  installAndSealLegacyRecoveryBatch,
  materializeLegacyHeldReceiptPage,
  readLegacyRecoveryInstallation,
  legacySnapshotDigest,
  type LegacyRecoveryCandidate,
} from './webhook-legacy-cold-install';
import { WebhookLegacyHoldService } from './webhook-legacy-hold.service';
import { WebhookOutboxService } from './webhook-outbox.service';
import { WebhookParser } from './webhook.parser';
import { WEBHOOK_QUEUE_CRITICAL } from './webhook-queues';
import { WebhookService } from './webhook.service';

const databaseUrl = process.env.CHAT_ROUTING_POSTGRES_RACE_DATABASE_URL?.trim() ?? '';
const redisUrl = process.env.MAXIM_TEST_REDIS_URL?.trim() ?? '';
const native = databaseUrl && redisUrl ? describe : describe.skip;
const publisherBotId = 'publisher-held-fixture';

// FLAG: These activation regressions use only newly owned native
// race-test stores. The low-level seal is test setup, never a production activation path.
// Admission, SQL selection, ordered sequencing, lag and readiness run their real methods.
// Independent work stops at the preparation boundary; no moderation worker or MAX exists.
native('legacy disposition production ingestion activation regressions', () => {
  jest.setTimeout(45_000);
  let prisma: PrismaClient;
  let redis: Redis;
  let queue: Queue;
  let ingress: WebhookService;
  let holds: WebhookLegacyHoldService;
  let outbox: WebhookOutboxService;
  let metrics: QueueMetricsService;
  let health: HealthService;
  let realMode: SystemModeService;
  let actionHealth: ActionHealthService;
  let cutoff: Date;
  const receipts: string[] = [];
  const certificates: string[] = [];
  const chats: string[] = [];
  const previousOffline = process.env.MAXIM_LEGACY_RECOVERY_OFFLINE;
  const deniedMax = jest.fn(() => {
    throw new Error('MAX transport is forbidden in this native regression');
  });

  beforeAll(async () => {
    for (const [value, database] of [
      [databaseUrl, true],
      [redisUrl, false],
    ] as const) {
      const url = new URL(value);
      if (
        !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
        (database && !url.pathname.includes('race_test'))
      )
        throw new Error('Only disposable loopback PostgreSQL/Redis stores are permitted');
    }
    prisma = createPrismaClient(databaseUrl, { max: 8, statement_timeout: 10_000 });
    const [identity] = await prisma.$queryRaw<Array<{ version: string; timezone: string }>>`
      SELECT version(), current_setting('TimeZone') AS timezone`;
    expect(identity?.version).toMatch(/^PostgreSQL 16\./u);
    expect(identity?.timezone).toBe('UTC');
    expect(process.env.TZ).toBe('UTC');
    cutoff = (
      await prisma.$queryRaw<Array<{ at: Date }>>`
      SELECT finished_at AS at FROM _prisma_migrations
      WHERE migration_name = '20261005020000_add_multibot_order_fences'
        AND finished_at IS NOT NULL AND rolled_back_at IS NULL
      ORDER BY finished_at DESC LIMIT 1`
    )[0]!.at;
    redis = new Redis(redisUrl, { maxRetriesPerRequest: null });
    queue = new Queue(`legacy-ingestion-${randomUUID()}`, {
      connection: redis as unknown as ConnectionOptions,
    });
    await queue.waitUntilReady();
    process.env.MAXIM_LEGACY_RECOVERY_OFFLINE = '1';
  });

  beforeEach(async () => {
    await redis.flushdb();
    holds = new WebhookLegacyHoldService(prisma as never);
    const config = new ConfigService({
      REDIS_URL: redisUrl,
      WEBHOOK_RAW_PAYLOAD_SAMPLE_RATE: 1,
      ENQUEUE_BATCH_SIZE: 64,
      ENQUEUE_CONCURRENCY: 1,
      READINESS_QUEUE_SNAPSHOT_MAX_AGE_MS: 0,
      MAX_PUBLISHER_BOT_ID: publisherBotId,
    });
    ingress = new WebhookService(prisma as never, config, {} as never);
    Object.assign(ingress, {
      legacyHolds: holds,
      maxClient: new Proxy({}, { get: () => deniedMax }),
    });
    const mode = {
      getEffectiveSnapshot: async () => ({
        mode: 'normal',
        queueLagSec: 0,
        updatedAt: new Date().toISOString(),
        action: { total: 0, success: 0, failure: 0, critical: 0, errorRate: 0, criticalRate: 0 },
      }),
      peekCachedSnapshot: () => ({ mode: 'normal' }),
    };
    outbox = new WebhookOutboxService(
      prisma as never,
      config,
      { get: () => queue } as never,
      { resolveQueueName: async () => WEBHOOK_QUEUE_CRITICAL } as never,
      ingress,
      queue as never,
      queue as never,
      queue as never,
      mode as never,
      holds,
    );
    metrics = new QueueMetricsService(
      prisma as never,
      {} as never,
      { get: () => undefined } as never,
      {} as never,
    );
    actionHealth = new ActionHealthService(config);
    realMode = new SystemModeService(config, metrics, actionHealth);
    health = new HealthService(prisma as never, metrics, realMode, config);
  });

  afterEach(async () => {
    // FLAG: Jest can start the next test after a timed-out hook. Capture this test's
    // identities before any await so late cleanup cannot delete the next fixture.
    const cleanupReceipts = receipts.splice(0);
    const cleanupCertificates = certificates.splice(0);
    const cleanupChats = chats.splice(0);
    await health?.onModuleDestroy();
    await realMode?.onModuleDestroy();
    await actionHealth?.onModuleDestroy();
    await ingress?.onModuleDestroy();
    jest.restoreAllMocks();
    expect(deniedMax).not.toHaveBeenCalled();
    // FLAG: Remove all owned referencing rows before their disposition proofs.
    // The proof FK has no reverse index; interleaved deletion repeatedly scans
    // the large live fixture. Production proofs remain retained, not bulk-deleted.
    const cleanupStartedAt = performance.now();
    const cleanupReceiptCount = cleanupReceipts.length;
    for (let offset = 0; offset < cleanupReceipts.length; offset += 200) {
      const ids = cleanupReceipts.slice(offset, offset + 200);
      await prisma.webhookExecutionClaim.deleteMany({ where: { webhookEventId: { in: ids } } });
      await prisma.webhookEvent.deleteMany({ where: { id: { in: ids } } });
    }
    if (cleanupReceiptCount >= 1000) {
      // FLAG: Only this disposable store is vacuumed, after the query-plan assertions.
      // Reclaim the removed fixture's dead pages before repeated FK checks.
      await prisma.$executeRaw`VACUUM (ANALYZE) webhook_events`;
    }
    const cleanupIndex = `fixture_legacy_cleanup_${randomUUID().replaceAll('-', '')}`;
    // FLAG: This index exists only during cleanup in the guarded disposable store,
    // after all production-plan assertions; remove it before the next test.
    if (cleanupReceiptCount >= 1000) {
      await prisma.$executeRawUnsafe(
        `CREATE INDEX "${cleanupIndex}" ON webhook_events (legacy_disposition_receipt_id, legacy_disposition_id)`,
      );
    }
    try {
      for (let offset = 0; offset < cleanupReceipts.length; offset += 200) {
        const ids = cleanupReceipts.slice(offset, offset + 200);
        await prisma.webhookLegacyReceiptDisposition.deleteMany({
          where: { receiptId: { in: ids } },
        });
      }
    } finally {
      if (cleanupReceiptCount >= 1000)
        await prisma.$executeRawUnsafe(`DROP INDEX "${cleanupIndex}"`);
    }
    for (const certificateId of cleanupCertificates) {
      await prisma.webhookLegacyMaterializationCursor.deleteMany({ where: { certificateId } });
      await prisma.webhookLegacySealedAuthority.deleteMany({ where: { certificateId } });
      await prisma.webhookLegacyChildHold.deleteMany({ where: { certificateId } });
      await prisma.webhookLegacyRecovery.deleteMany({ where: { certificateId } });
      await prisma.webhookLegacyQuiescenceCertificate.deleteMany({ where: { id: certificateId } });
    }
    await prisma.chat.deleteMany({ where: { id: { in: cleanupChats } } });
    if (cleanupReceiptCount >= 1000) {
      console.info('LEGACY_FIXTURE_CLEANUP_NATIVE_COST', {
        receipts: cleanupReceiptCount,
        elapsedMs: Math.round(performance.now() - cleanupStartedAt),
      });
    }
  });

  afterAll(async () => {
    if (previousOffline === undefined) delete process.env.MAXIM_LEGACY_RECOVERY_OFFLINE;
    else process.env.MAXIM_LEGACY_RECOVERY_OFFLINE = previousOffline;
    await queue?.obliterate({ force: false });
    await queue?.close();
    await redis?.quit();
    await prisma?.$disconnect();
  });

  function update(
    chatId: string,
    userId: string,
    options: {
      botId?: string;
      messageId?: string;
      at?: number;
      type?: 'message_created' | 'message_edited';
      forward?: boolean;
    } = {},
  ): MaxUpdate {
    const at = options.at ?? Date.now();
    const value = new WebhookParser().parse(
      {
        update_type: options.type ?? 'message_created',
        timestamp: at,
        message: {
          sender: { user_id: userId, name: 'Local fixture', is_bot: false },
          recipient: { chat_id: chatId, chat_type: 'chat' },
          timestamp: at,
          body: {
            mid: options.messageId ?? randomUUID(),
            text: options.forward ? '  ' : 'Ordinary human text',
          },
          ...(options.forward
            ? {
                link: {
                  type: 'forward',
                  chat_id: '-foreign-chat',
                  sender: { user_id: 'foreign-author', is_bot: false },
                  message: {
                    mid: 'foreign-image',
                    text: 'Ordinary\n  forwarded caption',
                    attachments: [
                      {
                        type: 'image',
                        payload: { photo_id: 42, url: 'https://i.oneme.ru/fixture' },
                      },
                    ],
                  },
                },
              }
            : {}),
        },
      },
      { botId: options.botId ?? 'major-1' },
    );
    value.updateId = randomUUID();
    return value;
  }

  async function store(value: MaxUpdate) {
    const receipt = await ingress.storeReceipt(value, null);
    expect(receipt.duplicate).toBe(false);
    expect(receipt.webhookEventId).toBeTruthy();
    receipts.push(receipt.webhookEventId!);
    return prisma.webhookEvent.findUniqueOrThrow({ where: { id: receipt.webhookEventId! } });
  }

  function rawEvidence(receipt: Awaited<ReturnType<typeof store>>) {
    const {
      id,
      botId,
      dedupKey,
      semanticKey,
      sourceIp,
      rawPayload,
      normalizedPayload,
      status,
      errorMessage,
      createdAt,
      processedAt,
      queueName,
      queuedAt,
      enqueueAttempts,
      nextEnqueueAt,
      executionDeadlineAt,
      timeoutQuarantineExpiresAt,
    } = receipt;
    return {
      id,
      botId,
      dedupKey,
      semanticKey,
      sourceIp,
      rawPayload,
      normalizedPayload,
      status,
      errorMessage,
      createdAt,
      processedAt,
      queueName,
      queuedAt,
      enqueueAttempts,
      nextEnqueueAt,
      executionDeadlineAt,
      timeoutQuarantineExpiresAt,
    };
  }

  async function owner(forward = false) {
    const chatId = `-legacy-ingestion-${randomUUID()}`;
    const userId = `human-${randomUUID()}`;
    chats.push(chatId);
    await prisma.chat.create({
      data: { id: chatId, entityType: 'CHAT', title: 'Local regression' },
    });
    const value = update(chatId, userId, { at: cutoff.getTime() - 5000, forward });
    const receipt = await store(value);
    const saved = await prisma.webhookEvent.update({
      where: { id: receipt.id },
      data: {
        status: 'FAILED',
        createdAt: new Date(cutoff.getTime() - 4000),
        errorMessage:
          'WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINED:LEGACY_EXECUTION_UNVERIFIED; exact effects proof required',
      },
    });
    await prisma.webhookExecutionClaim.create({
      data: {
        kind: 'EXECUTION',
        semanticKey: saved.semanticKey!,
        webhookEventId: saved.id,
        enforced: false,
        createdAt: saved.createdAt,
      },
    });
    const candidate = await inspectLegacyRecoveryCandidate(prisma, saved.id, ['major-1']);
    expect(candidate).not.toBeNull();
    return { candidate: candidate!, chatId, userId, value };
  }

  async function seal(
    input: LegacyRecoveryCandidate | LegacyRecoveryCandidate[],
    materialize = true,
  ) {
    const candidates = Array.isArray(input) ? input : [input];
    const sourceSha = 'b'.repeat(40);
    const imageId = `sha256:${'a'.repeat(64)}`;
    const certificate = await createLegacyColdCertificate(prisma, {
      version: 1,
      sourceSha,
      imageId,
      transitionJournalSha256: 'c'.repeat(64),
      previewSha256: buildLegacyRecoveryPreviewDigest(candidates, []),
      queueFenceNonce: 'disposable-local-only',
      roleSnapshots: RUNTIME_SERVICE_NAMES.filter((name) => name !== 'api-all').map(
        (serviceName) => ({
          serviceName,
          containerId: legacySnapshotDigest(serviceName),
          sourceSha,
          imageId,
          stopped: true,
        }),
      ),
    });
    certificates.push(certificate.id);
    await installAndSealLegacyRecoveryBatch(prisma, certificate.id, candidates, []);
    if (materialize) {
      for (const chatId of new Set(candidates.map((candidate) => candidate.source.chatId))) {
        const page = await materializeLegacyHeldReceiptPage(prisma, certificate.id, chatId);
        expect(page).toMatchObject({ complete: true, blocked: false });
      }
    }
    return certificate.id;
  }

  async function pollAndObserve(chatId: string) {
    const calls = jest.spyOn(ingress, 'preparePersistedWebhookEvent');
    const internals = outbox as unknown as {
      enqueueBatch(): Promise<void>;
      findOrderedWebhookHeadsForChats(chatIds: string[]): Promise<Map<string, { id: string }>>;
    };
    await internals.enqueueBatch();
    const heads = await internals.findOrderedWebhookHeadsForChats([chatId]);
    const lag = await metrics.getLagSnapshot({ maxAgeMs: 0 });
    await realMode.evaluateAutoMode();
    const ready = await health.ready();
    expect(ready.checks.database).toBe(true);
    expect(ready.checks.redis).toBe(true);
    expect(await queue.getJobCounts('wait', 'active', 'prioritized')).toEqual({
      wait: 0,
      active: 0,
      prioritized: 0,
    });
    return { calls, heads, lag, ready };
  }

  it('reports an empty native database and Redis as ready without synthetic queue metrics', async () => {
    const snapshot = await health.ready();
    expect(snapshot.checks.database).toBe(true);
    expect(snapshot.checks.redis).toBe(true);
    expect(snapshot.checks.queueLag).toMatchObject({ ok: true, rawOk: true, effectiveLagSec: 0 });
  });

  it.each(['RECEIVED', 'QUEUED'] as const)(
    'requires positive receipt materialization for a pre-seal held %s row',
    async (status) => {
      const source = await owner();
      const incoming = await store(
        update(source.chatId, source.userId, { at: Date.now() - 601_000 }),
      );
      const before = await prisma.webhookEvent.update({
        where: { id: incoming.id },
        data: {
          status,
          createdAt: new Date(Date.now() - 600_000),
          ...(status === 'QUEUED' ? { queuedAt: new Date(Date.now() - 600_000) } : {}),
        },
      });
      await seal(source.candidate);
      const observed = await pollAndObserve(source.chatId);
      expect(observed.calls).not.toHaveBeenCalled();
      expect(observed.heads.has(source.chatId)).toBe(false);
      const heldRow = await prisma.webhookEvent.findUniqueOrThrow({ where: { id: incoming.id } });
      const proof = await prisma.webhookLegacyReceiptDisposition.findUniqueOrThrow({
        where: { id: heldRow.legacyDispositionId! },
      });
      expect(heldRow.status).toBe('NO_REPLAY_HELD');
      expect(proof.originalStatus).toBe(status);
      expect(rawEvidence({ ...heldRow, status: proof.originalStatus })).toEqual(
        rawEvidence(before),
      );
      expect(
        rawEvidence(
          await prisma.webhookEvent.findUniqueOrThrow({ where: { id: source.candidate.owner.id } }),
        ),
      ).toEqual(rawEvidence(source.candidate.owner));
      expect(
        await prisma.webhookExecutionClaim.findUnique({ where: { id: source.candidate.claim.id } }),
      ).toEqual(source.candidate.claim);
      // A scope seal alone currently skips this row in ordering but leaves it in health.
      // The correction must install positive receipt authority, not rewrite raw evidence.
      expect({
        lag: observed.lag.effectiveLagSec,
        ready: observed.ready.checks.queueLag.ok,
      }).toEqual({ lag: 0, ready: true });
      expect((await realMode.getEffectiveSnapshot()).mode).toBe('normal');
    },
  );

  it.each([false, true])(
    'materializes post-seal ingress including nine mirrors/edits/future time (forward=%s)',
    async (forward) => {
      const source = await owner(forward);
      await seal(source.candidate);
      const messageId = randomUUID();
      const saved = [];
      for (let bot = 1; bot <= 9; bot++) {
        for (const type of ['message_created', 'message_edited'] as const)
          saved.push(
            await store(
              update(source.chatId, source.userId, {
                botId: `major-${bot}`,
                messageId,
                type,
                at: Date.now() + 60_000,
                forward,
              }),
            ),
          );
      }
      const observed = await pollAndObserve(source.chatId);
      expect(observed.calls).not.toHaveBeenCalled();
      expect(observed.heads.has(source.chatId)).toBe(false);
      for (const receipt of saved)
        expect(
          rawEvidence(await prisma.webhookEvent.findUniqueOrThrow({ where: { id: receipt.id } })),
        ).toEqual(rawEvidence(receipt));
      expect(observed.lag.oldestReceivedEventId).toBeNull();
    },
  );

  it('does not report successful receipt settlement when the exact target row is absent', async () => {
    const source = await owner();
    await seal(source.candidate);
    expect(await holds.settleHeldReceipt(randomUUID(), source.value)).toBe(false);
  });

  it.each([
    { caption: 'ordinary caption', alreadyDeferred: true },
    { caption: undefined, alreadyDeferred: false },
    { caption: null, alreadyDeferred: false },
    { caption: undefined, alreadyDeferred: true },
    { caption: null, alreadyDeferred: true },
  ])(
    'projects a held direct image without a caption or after its saved deferral ($caption, deferred=$alreadyDeferred)',
    async ({ caption, alreadyDeferred }) => {
      const source = await owner();
      await seal(source.candidate);
      const at = Date.now();
      const image = new WebhookParser().parse(
        {
          update_type: 'message_created',
          update_id: randomUUID(),
          timestamp: at,
          message: {
            sender: { user_id: source.userId, is_bot: false },
            recipient: { chat_id: source.chatId, chat_type: 'chat' },
            timestamp: at,
            body: {
              mid: randomUUID(),
              ...(caption === undefined ? {} : { text: caption }),
              attachments: [
                { type: 'image', payload: { photo_id: 42, url: 'https://i.oneme.ru/fixture' } },
              ],
            },
          },
        },
        { botId: 'major-1' },
      );
      const incoming = await prisma.webhookEvent.create({
        data: {
          botId: image.botId,
          dedupKey: `${image.botId}:${image.updateId}`,
          semanticKey: buildWebhookReceiptSemanticKey(image, publisherBotId),
          normalizedPayload: image as unknown as Prisma.InputJsonValue,
          rawPayload: image.raw as Prisma.InputJsonValue,
          ...(alreadyDeferred
            ? {
                errorMessage:
                  'Webhook preparation deferred: Legacy scope installation is not sealed',
                nextEnqueueAt: new Date(Date.now() - 1_000),
              }
            : {}),
        },
      });
      receipts.push(incoming.id);
      await expect(ingress.preparePersistedWebhookEvent(incoming.id)).resolves.toMatchObject({
        prepared: false,
        canonical: false,
        enforced: true,
      });
      const after = await prisma.webhookEvent.findUniqueOrThrow({ where: { id: incoming.id } });
      expect(after.status).toBe('NO_REPLAY_HELD');
      const proof = await prisma.webhookLegacyReceiptDisposition.findUniqueOrThrow({
        where: { id: after.legacyDispositionId! },
      });
      expect(proof).toMatchObject({ scopeKind: 'POST_SEAL_MEMBER', originalStatus: 'RECEIVED' });
      expect(rawEvidence({ ...after, status: proof.originalStatus })).toEqual(
        rawEvidence(incoming),
      );
      expect(await holds.isUpdateHeld(image)).toBe(true);
      expect(
        await prisma.webhookExecutionClaim.count({ where: { webhookEventId: incoming.id } }),
      ).toBe(0);
      expect((await metrics.getLagSnapshot({ maxAgeMs: 0 })).oldestReceivedEventId).toBeNull();
    },
  );

  it.each(
    ['major-1', publisherBotId].flatMap((botId) =>
      [false, true].flatMap((alreadyDeferred) =>
        [undefined, false, true].map((isChannel) => ({ botId, alreadyDeferred, isChannel })),
      ),
    ),
  )(
    'preserves a sealed member hold without endlessly retrying direct user_added ($botId, deferred=$alreadyDeferred, channel=$isChannel)',
    async ({ botId, alreadyDeferred, isChannel }) => {
      const source = await owner();
      await seal(source.candidate);
      const added = new WebhookParser().parse(
        {
          update_type: 'user_added',
          update_id: randomUUID(),
          timestamp: Date.now(),
          chat_id: source.chatId,
          ...(isChannel === undefined ? {} : { is_channel: isChannel }),
          user: { user_id: source.userId, name: 'Local held member', is_bot: false },
        },
        { botId },
      );
      // FLAG: Seed an older runtime's unprojected receipt; new ingress may already
      // install the exact disposition before returning from storeReceipt.
      const incoming = await prisma.webhookEvent.create({
        data: {
          botId: added.botId,
          dedupKey: `${added.botId}:${added.updateId}`,
          semanticKey: buildWebhookReceiptSemanticKey(added, publisherBotId),
          normalizedPayload: added as unknown as Prisma.InputJsonValue,
          rawPayload: {},
          ...(alreadyDeferred
            ? {
                errorMessage:
                  'Webhook preparation deferred: Legacy scope installation is not sealed',
                nextEnqueueAt: new Date(Date.now() - 1_000),
              }
            : {}),
        },
      });
      receipts.push(incoming.id);
      const before = await prisma.webhookEvent.findUniqueOrThrow({ where: { id: incoming.id } });
      await expect(ingress.preparePersistedWebhookEvent(incoming.id)).resolves.toMatchObject({
        prepared: false,
        canonical: false,
        enforced: true,
      });
      const after = await prisma.webhookEvent.findUniqueOrThrow({ where: { id: incoming.id } });
      expect(after.status).toBe('NO_REPLAY_HELD');
      expect(after.semanticKey).toBe(before.semanticKey);
      if (botId === publisherBotId)
        expect(after.semanticKey).not.toBe(buildWebhookSemanticEventKey(added));
      expect(await holds.materializeReceipt(incoming.id)).toBe('ALREADY_APPLIED_SAME_PROOF');
      const proof = await prisma.webhookLegacyReceiptDisposition.findUniqueOrThrow({
        where: { id: after.legacyDispositionId! },
      });
      expect(proof).toMatchObject({ scopeKind: 'POST_SEAL_MEMBER', originalStatus: 'RECEIVED' });
      expect(rawEvidence({ ...after, status: proof.originalStatus })).toEqual(rawEvidence(before));
      expect(await holds.isUpdateHeld(added)).toBe(true);
      expect(
        await prisma.webhookExecutionClaim.count({ where: { webhookEventId: incoming.id } }),
      ).toBe(0);
      expect(
        await prisma.webhookExecutionClaim.findUnique({ where: { id: source.candidate.claim.id } }),
      ).toEqual(source.candidate.claim);
      expect((await metrics.getLagSnapshot({ maxAgeMs: 0 })).oldestReceivedEventId).toBeNull();
    },
  );

  it('projects a fresh held join at ingress and preserves unrelated participant admission', async () => {
    const source = await owner();
    await seal(source.candidate);
    const added = new WebhookParser().parse(
      {
        update_type: 'user_added',
        timestamp: Date.now(),
        chat_id: source.chatId,
        user: { user_id: source.userId, is_bot: false },
      },
      { botId: 'major-1' },
    );
    const held = await store(added);
    expect(held.status).toBe('NO_REPLAY_HELD');
    expect(held.normalizedPayload).toEqual(added);
    expect(held.processedAt).toBeNull();
    const independent = await store(update(source.chatId, `independent-${randomUUID()}`));
    const admission = jest
      .spyOn(ingress, 'preparePersistedWebhookEvent')
      .mockImplementation(async () => {
        throw new WebhookPreparationDeferredError('local_test_preparation_boundary', 1000);
      });
    await (outbox as unknown as { enqueueBatch(): Promise<void> }).enqueueBatch();
    expect(admission.mock.calls.map(([id]) => id)).toEqual([independent.id]);
    expect(await holds.isUpdateHeld(added)).toBe(true);
    expect(await prisma.webhookExecutionClaim.count({ where: { webhookEventId: held.id } })).toBe(
      0,
    );
  });

  it.each([
    'raw_target',
    'unknown_shape',
    'normalized_target',
    'unknown_human',
    'unknown_error',
    'queued',
    'attempted',
    'claim',
    'semantic_key',
    'pre_seal_source',
    'future_source',
    'sampled_source',
    'nested_user_field',
    'string_timestamp',
    'invalid_channel_flag',
    'normalized_entity_type',
    'publisher_foreign_bot',
    'publisher_foreign_source',
    'publisher_unknown_version',
  ])('keeps a held join fenced when %s is unproved', async (mutation) => {
    const source = await owner();
    await seal(source.candidate);
    const raw = {
      update_type: 'user_added',
      update_id: randomUUID(),
      timestamp: Date.now(),
      chat_id: source.chatId,
      user: { user_id: source.userId, is_bot: false },
    };
    const added = new WebhookParser().parse(raw, { botId: 'major-1' });
    if (mutation === 'raw_target') raw.user.user_id = 'other-private-user';
    if (mutation === 'unknown_shape') Object.assign(raw, { callback: { callback_id: 'private' } });
    if (mutation === 'normalized_target') added.membership!.memberUserIds = ['other-private-user'];
    if (mutation === 'unknown_human') delete (raw.user as { is_bot?: boolean }).is_bot;
    if (mutation === 'pre_seal_source') raw.timestamp = cutoff.getTime() - 1_000;
    if (mutation === 'future_source') raw.timestamp = Date.now() + 60_000;
    if (mutation === 'nested_user_field') Object.assign(raw.user, { name: { user_id: 'other' } });
    if (mutation === 'string_timestamp') Object.assign(raw, { timestamp: String(raw.timestamp) });
    if (mutation === 'invalid_channel_flag') Object.assign(raw, { is_channel: 'true' });
    if (mutation === 'normalized_entity_type') added.message!.entityType = 'channel';
    added.raw = raw;
    const semanticKey = buildWebhookSemanticEventKey(added);
    const publisherKey = `publisher-observation:v1:${added.botId}:${semanticKey}`;
    const storedKey =
      mutation === 'publisher_foreign_bot'
        ? `publisher-observation:v1:other-bot:${semanticKey}`
        : mutation === 'publisher_foreign_source'
          ? `${publisherKey}:other-source`
          : mutation === 'publisher_unknown_version'
            ? publisherKey.replace(':v1:', ':v2:')
            : mutation === 'semantic_key'
              ? `private-other-${randomUUID()}`
              : semanticKey;
    const incoming = await prisma.webhookEvent.create({
      data: {
        botId: added.botId,
        dedupKey: `${added.botId}:${added.updateId}`,
        semanticKey: storedKey,
        normalizedPayload: added as unknown as Prisma.InputJsonValue,
        rawPayload: mutation === 'sampled_source' ? { ...raw, chat_id: '-other-private-chat' } : {},
        ...(mutation === 'unknown_error' ? { errorMessage: 'unknown prior attempt' } : {}),
        ...(mutation === 'queued'
          ? { status: 'QUEUED', queuedAt: new Date(), queueName: WEBHOOK_QUEUE_CRITICAL }
          : {}),
        ...(mutation === 'attempted' ? { enqueueAttempts: 1 } : {}),
      },
    });
    receipts.push(incoming.id);
    if (mutation === 'claim')
      await prisma.webhookExecutionClaim.create({
        data: {
          kind: 'EXECUTION',
          semanticKey: incoming.semanticKey!,
          webhookEventId: incoming.id,
          enforced: true,
          status: 'PENDING',
        },
      });
    const before = await prisma.webhookEvent.findUniqueOrThrow({ where: { id: incoming.id } });
    expect(await holds.materializeReceipt(incoming.id)).toBe('BLOCKED_UNKNOWN');
    expect(await prisma.webhookEvent.findUniqueOrThrow({ where: { id: incoming.id } })).toEqual(
      before,
    );
    expect(
      await prisma.webhookLegacyReceiptDisposition.count({ where: { receiptId: incoming.id } }),
    ).toBe(0);
    expect(await holds.isUpdateHeld(added)).toBe(true);
  });

  it('admits an unrelated participant through the real ordered sequence after held ingress', async () => {
    const source = await owner();
    await seal(source.candidate);
    const held = await store(update(source.chatId, source.userId));
    const independent = await store(update(source.chatId, `independent-${randomUUID()}`));
    const admission = jest
      .spyOn(ingress, 'preparePersistedWebhookEvent')
      .mockImplementation(async () => {
        throw new WebhookPreparationDeferredError('local_test_preparation_boundary', 1000);
      });
    const internals = outbox as unknown as { enqueueBatch(): Promise<void> };
    await internals.enqueueBatch();
    expect(admission.mock.calls.map(([id]) => id)).toEqual([independent.id]);
    expect(
      rawEvidence(await prisma.webhookEvent.findUniqueOrThrow({ where: { id: held.id } })),
    ).toEqual(rawEvidence(held));
    const lag = await metrics.getLagSnapshot({ maxAgeMs: 0 });
    expect(lag.oldestReceivedEventId).toBe(independent.id);
  });

  it('keeps independent admission and real system mode normal in a 10,000 chat catalogue', async () => {
    const source = await owner();
    const catalogue = Array.from({ length: 10_000 }, (_, i) => `-catalogue-${randomUUID()}-${i}`);
    chats.push(...catalogue);
    await prisma.chat.createMany({
      data: catalogue.map((id) => ({ id, entityType: 'CHAT' as const, title: 'Native catalogue' })),
    });
    await seal(source.candidate);
    await store(update(source.chatId, source.userId));
    const independent = await store(update(catalogue[9999]!, `independent-${randomUUID()}`));
    const admission = jest
      .spyOn(ingress, 'preparePersistedWebhookEvent')
      .mockImplementation(async () => {
        throw new WebhookPreparationDeferredError('local_test_preparation_boundary', 1000);
      });
    await (outbox as unknown as { enqueueBatch(): Promise<void> }).enqueueBatch();
    expect(admission.mock.calls.map(([id]) => id)).toEqual([independent.id]);
    await realMode.evaluateAutoMode();
    expect((await realMode.getEffectiveSnapshot()).mode).toBe('normal');
    expect((await metrics.getLagSnapshot({ maxAgeMs: 0 })).oldestReceivedEventId).toBe(
      independent.id,
    );
  });

  it('preserves quiet-chat admission with a poison head and hot backlog across 10,000 chats', async () => {
    const source = await owner();
    const catalogue = Array.from({ length: 10_000 }, (_, i) => `-pressure-${randomUUID()}-${i}`);
    chats.push(...catalogue);
    await prisma.chat.createMany({
      data: catalogue.map((id) => ({
        id,
        entityType: 'CHAT' as const,
        title: 'Native pressure catalogue',
      })),
    });
    const old = new Date(Date.now() - 600_000);
    const hot = Array.from({ length: 600 }, (_, i) => {
      const id = randomUUID();
      receipts.push(id);
      const value = update(source.chatId, `backlog-${i}`, { at: old.getTime() });
      return {
        id,
        dedupKey: id,
        botId: value.botId,
        status: 'RECEIVED' as const,
        normalizedPayload: JSON.parse(JSON.stringify(value)),
        rawPayload: {},
        createdAt: old,
      };
    });
    // The unknown original head predates every hot receipt, preserving its ordering fence.
    await prisma.webhookEvent.update({
      where: { id: source.candidate.owner.id },
      data: { createdAt: new Date(old.getTime() - 1000) },
    });
    await prisma.webhookEvent.createMany({ data: hot });
    const quiet = await store(update(catalogue[9999]!, `quiet-${randomUUID()}`));
    Object.assign(outbox, { systemModeService: realMode });
    await realMode.evaluateAutoMode();
    expect(await realMode.getEffectiveSnapshot()).toMatchObject({
      mode: 'degrade',
      condition: 'queue_backlog',
    });
    const internals = outbox as unknown as {
      resolveEnqueueAdmission(
        now: Date,
      ): Promise<{ degraded: boolean; batchSize: number; enqueueConcurrency: number }>;
      enqueueBatch(): Promise<void>;
    };
    expect(await internals.resolveEnqueueAdmission(new Date())).toMatchObject({
      degraded: false,
      batchSize: 64,
      enqueueConcurrency: 1,
    });
    const admission = jest
      .spyOn(ingress, 'preparePersistedWebhookEvent')
      .mockImplementation(async () => {
        throw new WebhookPreparationDeferredError('local_test_preparation_boundary', 1000);
      });
    await internals.enqueueBatch();
    expect(admission.mock.calls.map(([id]) => id)).toEqual([quiet.id]);
    expect((await health.ready()).checks.queueLag.ok).toBe(false);
    expect(
      (await prisma.webhookEvent.findUniqueOrThrow({ where: { id: source.candidate.owner.id } }))
        .legacyDispositionId,
    ).toBeNull();
  });

  it('materializes the permanent global-user hold in another chat without polluting lag', async () => {
    const source = await owner();
    await seal(source.candidate);
    const otherChat = `-global-scope-${randomUUID()}`;
    chats.push(otherChat);
    await prisma.chat.create({
      data: { id: otherChat, entityType: 'CHAT', title: 'Global hold fixture' },
    });
    const held = await store(update(otherChat, source.userId));
    expect(held.legacyDispositionId).not.toBeNull();
    const observed = await pollAndObserve(otherChat);
    expect(observed.calls).not.toHaveBeenCalled();
    expect(observed.lag.effectiveLagSec).toBe(0);
  });

  it('lazily projects a pre-seal global member in another chat through the actual outbox', async () => {
    const source = await owner();
    const otherChat = `-lazy-global-${randomUUID()}`;
    const incoming = await store(update(otherChat, source.userId, { at: Date.now() - 601_000 }));
    await prisma.webhookEvent.update({
      where: { id: incoming.id },
      data: { createdAt: new Date(Date.now() - 600_000) },
    });
    await seal(source.candidate);
    expect((await health.ready()).checks.queueLag.rawOk).toBe(false);
    const observed = await pollAndObserve(otherChat);
    expect(observed.calls.mock.calls.map(([id]) => id)).toEqual([incoming.id]);
    const held = await prisma.webhookEvent.findUniqueOrThrow({ where: { id: incoming.id } });
    expect(held.status).toBe('NO_REPLAY_HELD');
    expect(observed.lag.effectiveLagSec).toBe(0);
    expect(
      await prisma.webhookExecutionClaim.count({ where: { webhookEventId: incoming.id } }),
    ).toBe(0);
  });

  it('reconciles lost install output from exact source proof and finite cursor completion', async () => {
    const source = await owner();
    const expected = {
      sourceSha: 'b'.repeat(40),
      imageId: `sha256:${'a'.repeat(64)}`,
      previewSha256: buildLegacyRecoveryPreviewDigest([source.candidate], []),
      recoveries: 1,
      children: 0,
    };
    expect((await readLegacyRecoveryInstallation(prisma, randomUUID(), expected)).state).toBe(
      'ABSENT',
    );
    const certificateId = await seal(source.candidate, false);
    const installed = await prisma.webhookLegacyQuiescenceCertificate.findUniqueOrThrow({
      where: { id: certificateId },
    });
    const preallocatedId = randomUUID();
    const attestation = installed.attestation as unknown as Parameters<
      typeof createLegacyColdCertificate
    >[1];
    const unsealed = await createLegacyColdCertificate(prisma, attestation, preallocatedId);
    expect(unsealed.id).toBe(preallocatedId);
    await expect(
      createLegacyColdCertificate(prisma, attestation, preallocatedId),
    ).rejects.toThrow();
    for (const invalidId of [
      '',
      'not-a-uuid',
      ` ${preallocatedId}`,
      preallocatedId.toUpperCase(),
      '00000000-0000-0000-0000-000000000000',
    ]) {
      await expect(createLegacyColdCertificate(prisma, attestation, invalidId)).rejects.toThrow(
        'canonical UUID v4',
      );
    }
    certificates.push(unsealed.id);
    expect((await readLegacyRecoveryInstallation(prisma, unsealed.id, expected)).state).toBe(
      'UNSEALED',
    );
    expect(await readLegacyRecoveryInstallation(prisma, certificateId, expected)).toEqual({
      state: 'SEALED',
      completeChats: 0,
      requiredChats: 1,
    });
    await materializeLegacyHeldReceiptPage(prisma, certificateId, source.chatId);
    expect(await readLegacyRecoveryInstallation(prisma, certificateId, expected)).toEqual({
      state: 'MATERIALIZED',
      completeChats: 1,
      requiredChats: 1,
    });
    for (const mismatch of [
      { sourceSha: 'd'.repeat(40) },
      { imageId: `sha256:${'e'.repeat(64)}` },
      { previewSha256: 'f'.repeat(64) },
      { recoveries: 2 },
      { children: 1 },
    ]) {
      expect(
        (await readLegacyRecoveryInstallation(prisma, certificateId, { ...expected, ...mismatch }))
          .state,
      ).toBe('INVALID');
    }
    await prisma.webhookExecutionClaim.update({
      where: { id: source.candidate.claim.id },
      data: { businessStartedAt: new Date() },
    });
    expect((await readLegacyRecoveryInstallation(prisma, certificateId, expected)).state).toBe(
      'INVALID',
    );
  });

  it('retains original and pre-seal evidence while deleting bounded post-seal bodies but no tombstones', async () => {
    const source = await owner();
    const preSeal = await store(update(source.chatId, source.userId, { at: Date.now() - 1000 }));
    const certificateId = await seal(source.candidate);
    const template = await store(update(source.chatId, source.userId));
    await prisma.webhookExecutionClaim.create({
      data: { kind: 'EXECUTION', semanticKey: template.semanticKey!, webhookEventId: template.id },
    });
    const rows = Array.from({ length: 502 }, () => {
      const id = randomUUID();
      receipts.push(id);
      return {
        ...template,
        id,
        dedupKey: id,
        status: 'RECEIVED' as const,
        legacyDispositionId: null,
        legacyDispositionReceiptId: null,
      };
    });
    await prisma.webhookEvent.createMany({ data: JSON.parse(JSON.stringify(rows)) });
    await prisma.webhookLegacyReceiptDisposition.createMany({
      data: rows.map((row) => ({
        id: randomUUID(),
        receiptId: row.id,
        authorityId: certificateId,
        sourceDigest: legacyReceiptSourceDigest(row),
        originalStatus: row.status,
        originalSnapshot: { version: 1, receipt: { id: row.id, status: row.status }, claims: [] },
        scopeKind: 'POST_SEAL_MEMBER',
      })),
    });
    await prisma.$executeRaw`UPDATE webhook_events event SET status = 'NO_REPLAY_HELD', legacy_disposition_id = proof.id,
      legacy_disposition_receipt_id = event.id FROM webhook_legacy_receipt_dispositions proof
      WHERE proof.receipt_id = event.id AND proof.authority_id = ${certificateId} AND event.legacy_disposition_id IS NULL`;
    const internals = outbox as unknown as {
      deleteLegacyHeldWebhookBatch(cutoff: Date): Promise<{ removed: number; scanned: number }>;
    };
    const expiry = new Date(Date.now() + 1000);
    // FLAG: Earlier native suites retain permanent modern source proofs in this
    // disposable store. Retention scans them but must preserve every original byte.
    const retainedModernReceipts = await prisma.webhookEvent.findMany({
      where: {
        status: 'NO_REPLAY_HELD',
        createdAt: { lt: expiry },
        sourceDispositionId: { not: null },
      },
      orderBy: { id: 'asc' },
    });
    expect(retainedModernReceipts.length).toBeLessThan(496);
    const tail = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM webhook_events WHERE status = 'NO_REPLAY_HELD' ORDER BY created_at, id LIMIT 500 FOR UPDATE`;
      expect(await internals.deleteLegacyHeldWebhookBatch(expiry)).toEqual({
        scanned: 500,
        removed: 0,
      });
      const result = await internals.deleteLegacyHeldWebhookBatch(expiry);
      expect(result.scanned).toBe(4 + retainedModernReceipts.length);
      return result;
    });
    const revisited = await internals.deleteLegacyHeldWebhookBatch(expiry);
    expect(revisited.scanned).toBe(500);
    expect(revisited.removed + tail.removed).toBe(502);
    expect(
      await prisma.webhookEvent.findMany({
        where: { id: { in: retainedModernReceipts.map((receipt) => receipt.id) } },
        orderBy: { id: 'asc' },
      }),
    ).toEqual(retainedModernReceipts);
    expect(
      await prisma.webhookEvent.count({
        where: { id: { in: [source.candidate.owner.id, preSeal.id, template.id] } },
      }),
    ).toBe(3);
    expect(
      await prisma.webhookLegacyReceiptDisposition.count({ where: { authorityId: certificateId } }),
    ).toBe(505);
  });

  it.each(['Старт', '/ban', '$command', 'бан', 'блокируй'])(
    'preserves the new held-source command %s without claiming abandonment authority',
    async (text) => {
      const source = await owner();
      await seal(source.candidate);
      await prisma.chatSettings.create({
        data: { chatId: source.chatId, adminBanCommandName: 'блокируй' },
      });
      const value = update(source.chatId, source.userId);
      value.message!.text = text;
      (value.raw as { message: { body: { text: string } } }).message.body.text = text;
      const command = await store(value);
      expect(command.status).toBe('RECEIVED');
      expect(command.legacyDispositionId).toBeNull();
      expect(await holds.materializeReceipt(command.id)).toBe('BLOCKED_UNKNOWN');
      await expect(ingress.preparePersistedWebhookEvent(command.id)).rejects.toBeInstanceOf(
        WebhookPreparationDeferredError,
      );
      expect(
        await prisma.webhookExecutionClaim.count({ where: { webhookEventId: command.id } }),
      ).toBe(0);
    },
  );

  it('reconciles concurrent disposition retries against the same exact proof', async () => {
    const source = await owner();
    await seal(source.candidate);
    const held = await store(update(source.chatId, source.userId));
    const results = await Promise.all(
      Array.from({ length: 8 }, () => holds.materializeReceipt(held.id)),
    );
    expect(new Set(results)).toEqual(new Set(['ALREADY_APPLIED_SAME_PROOF']));
    expect(
      await prisma.webhookLegacyReceiptDisposition.count({ where: { receiptId: held.id } }),
    ).toBe(1);
  });

  it('rejects a disposition pointer borrowed from another receipt and immutable proof rewrites', async () => {
    const source = await owner();
    await seal(source.candidate);
    const held = await store(update(source.chatId, source.userId));
    const independent = await store(update(source.chatId, `independent-${randomUUID()}`));
    expect(held.legacyDispositionId).not.toBeNull();
    await expect(
      prisma.webhookEvent.update({
        where: { id: independent.id },
        data: { legacyDispositionId: held.legacyDispositionId },
      }),
    ).rejects.toThrow();
    await expect(
      prisma.webhookLegacyReceiptDisposition.update({
        where: { id: held.legacyDispositionId! },
        data: { sourceDigest: '0'.repeat(64) },
      }),
    ).rejects.toThrow();
    await expect(
      prisma.webhookEvent.update({ where: { id: held.id }, data: { status: 'PROCESSED' } }),
    ).rejects.toThrow();
    expect(
      rawEvidence(await prisma.webhookEvent.findUniqueOrThrow({ where: { id: held.id } })),
    ).toEqual(rawEvidence(held));
  });

  function observeCursorUpdates(fail = false) {
    const writes = jest.fn();
    const database = prisma.$extends({
      query: {
        webhookLegacyMaterializationCursor: {
          async update({ args, query }) {
            writes();
            if (fail) throw new Error('Synthetic cursor write failure');
            return query(args);
          },
        },
      },
    });
    return { database, writes };
  }

  it('materializes a long same-timestamp prefix in bounded resumable pages', async () => {
    const source = await owner();
    const createdAt = new Date(Date.now() - 600_000);
    const batch = Array.from({ length: 301 }, () => {
      const id = randomUUID();
      receipts.push(id);
      const value = update(source.chatId, source.userId, { at: createdAt.getTime() - 1 });
      return {
        id,
        dedupKey: id,
        botId: value.botId,
        status: 'RECEIVED' as const,
        normalizedPayload: JSON.parse(JSON.stringify(value)),
        rawPayload: JSON.parse(JSON.stringify(value.raw)),
        createdAt,
      };
    });
    await prisma.webhookEvent.createMany({ data: batch });
    const certificateId = await seal(source.candidate, false);
    const observedCursor = observeCursorUpdates();
    let total = 0;
    let complete = false;
    let pages = 0;
    const startedAt = performance.now();
    for (let page = 0; page < 10 && !complete; page++) {
      pages++;

      const result = await materializeLegacyHeldReceiptPage(
        observedCursor.database as never,
        certificateId,
        source.chatId,
        37,
      );
      expect(result.blocked).toBe(false);
      expect(result.scanned).toBeLessThanOrEqual(37);
      total += result.scanned;
      complete = result.complete;
    }
    expect({ total, complete }).toEqual({ total: 302, complete: true });
    expect(observedCursor.writes).toHaveBeenCalledTimes(pages);
    process.stdout.write(
      `LEGACY_CURSOR_NATIVE_COST ${JSON.stringify({ receipts: total, pages, cursorUpdates: observedCursor.writes.mock.calls.length, elapsedMs: Math.round(performance.now() - startedAt) })}\n`,
    );
    expect(
      await materializeLegacyHeldReceiptPage(prisma, certificateId, source.chatId, 37),
    ).toEqual({ complete: true, scanned: 0, applied: 0, blocked: false });
    const observed = await pollAndObserve(source.chatId);
    expect(observed.calls).not.toHaveBeenCalled();
    expect(observed.lag.effectiveLagSec).toBe(0);
  });

  it('classifies 200 unrelated receipts with a constant number of queries and no receipt mutation', async () => {
    const source = await owner();
    const createdAt = new Date(Date.now() - 1000);
    const batch = Array.from({ length: 200 }, () => {
      const id = randomUUID();
      receipts.push(id);
      const value = update(source.chatId, `independent-${randomUUID()}`, {
        at: createdAt.getTime() - 1,
      });
      return {
        id,
        dedupKey: id,
        botId: value.botId,
        status: 'RECEIVED' as const,
        normalizedPayload: JSON.parse(JSON.stringify(value)),
        rawPayload: JSON.parse(JSON.stringify(value.raw)),
        createdAt,
      };
    });
    await prisma.webhookEvent.createMany({ data: batch });
    const certificateId = await seal(source.candidate, false);
    expect(
      await materializeLegacyHeldReceiptPage(prisma, certificateId, source.chatId, 1),
    ).toMatchObject({ complete: false, scanned: 1, blocked: false });
    const operations: string[] = [];
    const database = prisma.$extends({
      query: {
        async $allOperations({ model, operation, args, query }) {
          operations.push(`${model ?? 'raw'}:${operation}`);
          return query(args);
        },
      },
    });
    const startedAt = performance.now();
    expect(
      await materializeLegacyHeldReceiptPage(database as never, certificateId, source.chatId, 200),
    ).toEqual({ complete: true, scanned: 200, applied: 0, blocked: false });
    expect(operations.length).toBeLessThanOrEqual(10);
    expect(operations.filter((operation) => operation.startsWith('WebhookEvent:'))).toEqual([]);
    expect(
      operations.filter((operation) => operation.startsWith('WebhookLegacyReceiptDisposition:')),
    ).toEqual([]);
    expect(
      await prisma.webhookEvent.count({
        where: {
          id: { in: batch.map((row) => row.id) },
          status: 'RECEIVED',
          legacyDispositionId: null,
        },
      }),
    ).toBe(200);
    process.stdout.write(
      `LEGACY_NOT_HELD_NATIVE_COST ${JSON.stringify({ receipts: 200, operations: operations.length, elapsedMs: Math.round(performance.now() - startedAt) })}\n`,
    );
  });

  it('retains global-user holds from another chat in the same complete certificate scope set', async () => {
    const first = await owner();
    const second = await owner();
    const held = await store(update(first.chatId, second.userId, { at: Date.now() - 1000 }));
    const independent = await store(update(first.chatId, `independent-${randomUUID()}`));
    const certificateId = await seal([first.candidate, second.candidate], false);
    expect(
      await materializeLegacyHeldReceiptPage(prisma, certificateId, first.chatId, 200),
    ).toEqual({ complete: true, scanned: 3, applied: 1, blocked: false });
    expect((await prisma.webhookEvent.findUniqueOrThrow({ where: { id: held.id } })).status).toBe(
      'NO_REPLAY_HELD',
    );
    expect(await prisma.webhookEvent.findUniqueOrThrow({ where: { id: independent.id } })).toEqual(
      independent,
    );
  });

  it('keeps unrelated receipt locks through the atomic cursor checkpoint', async () => {
    const source = await owner();
    const independent = await store(update(source.chatId, `independent-${randomUUID()}`));
    const certificateId = await seal(source.candidate, false);
    let attempted = false;
    const database = prisma.$extends({
      query: {
        webhookLegacyMaterializationCursor: {
          async update({ args, query }) {
            attempted = true;
            await expect(
              prisma.$transaction(async (tx) => {
                await tx.$executeRawUnsafe("SET LOCAL lock_timeout = '100ms'");
                await tx.webhookEvent.update({
                  where: { id: independent.id },
                  data: { errorMessage: 'concurrent mutation' },
                });
              }),
            ).rejects.toThrow(/lock timeout/u);
            return query(args);
          },
        },
      },
    });
    expect(
      await materializeLegacyHeldReceiptPage(database as never, certificateId, source.chatId, 200),
    ).toEqual({ complete: true, scanned: 2, applied: 0, blocked: false });
    expect(attempted).toBe(true);
    expect(await prisma.webhookEvent.findUniqueOrThrow({ where: { id: independent.id } })).toEqual(
      independent,
    );
  });

  it.each(['scope_oversize', 'invalid_proof'] as const)(
    'stops a mixed page at %s after proving only the unrelated prefix',
    async (fault) => {
      const source = await owner();
      const independent = await store(update(source.chatId, `independent-${randomUUID()}`));
      const unknown = await store(update(source.chatId, `unknown-${randomUUID()}`));
      const after = await store(update(source.chatId, `later-${randomUUID()}`));
      const beforeAt = new Date(Date.now() - 1000);
      await prisma.webhookEvent.update({
        where: { id: independent.id },
        data: { createdAt: beforeAt },
      });
      await prisma.webhookEvent.update({
        where: { id: unknown.id },
        data: {
          createdAt: new Date(beforeAt.getTime() + 1),
          status: 'FAILED',
          nextEnqueueAt: beforeAt,
          ...(fault === 'scope_oversize'
            ? {
                normalizedPayload: {
                  ...(unknown.normalizedPayload as object),
                  message: {
                    ...(unknown.normalizedPayload as unknown as MaxUpdate).message!,
                    senderId: 'x'.repeat(513),
                  },
                },
              }
            : {}),
        },
      });
      const certificateId = await seal(source.candidate, false);
      if (fault === 'invalid_proof') {
        const authority = await prisma.webhookLegacySealedAuthority.findUniqueOrThrow({
          where: { certificateId },
        });
        const proof = await prisma.webhookLegacyReceiptDisposition.create({
          data: {
            id: randomUUID(),
            receiptId: unknown.id,
            authorityId: authority.id,
            sourceDigest: '0'.repeat(64),
            originalStatus: 'FAILED',
            originalSnapshot: {},
            scopeKind: 'EXACT_OWNER',
          },
        });
        await prisma.webhookEvent.update({
          where: { id: unknown.id },
          data: {
            legacyDispositionId: proof.id,
            legacyDispositionReceiptId: unknown.id,
          },
        });
      }
      const savedUnknown = await prisma.webhookEvent.findUniqueOrThrow({
        where: { id: unknown.id },
      });
      expect(
        await materializeLegacyHeldReceiptPage(prisma, certificateId, source.chatId, 200),
      ).toEqual({ complete: false, scanned: 2, applied: 0, blocked: true });
      expect(
        await prisma.webhookLegacyMaterializationCursor.findUniqueOrThrow({
          where: { certificateId_chatId: { certificateId, chatId: source.chatId } },
        }),
      ).toMatchObject({ afterId: independent.id, scanned: 2, complete: false });
      expect(await prisma.webhookEvent.findUniqueOrThrow({ where: { id: unknown.id } })).toEqual(
        savedUnknown,
      );
      expect(await prisma.webhookEvent.findUniqueOrThrow({ where: { id: after.id } })).toEqual(
        after,
      );
    },
  );

  it('reads one indexed head despite 5,000 held receipts and a pending backlog', async () => {
    const source = await owner();
    const certificateId = await seal(source.candidate);
    const template = await store(update(source.chatId, source.userId));
    const rows = Array.from({ length: 5000 }, () => {
      const id = randomUUID();
      receipts.push(id);
      return {
        ...template,
        status: 'RECEIVED' as const,
        id,
        dedupKey: id,
        legacyDispositionId: null,
        legacyDispositionReceiptId: null,
      };
    });
    for (let offset = 0; offset < rows.length; offset += 500) {
      const page = rows.slice(offset, offset + 500);
      await prisma.webhookEvent.createMany({ data: JSON.parse(JSON.stringify(page)) });
      await prisma.webhookLegacyReceiptDisposition.createMany({
        data: page.map((row) => ({
          id: randomUUID(),
          receiptId: row.id,
          authorityId: certificateId,
          sourceDigest: legacyReceiptSourceDigest(row),
          originalStatus: row.status,
          originalSnapshot: { version: 1, receipt: { id: row.id, status: row.status }, claims: [] },
          scopeKind: 'POST_SEAL_MEMBER',
        })),
      });
    }
    // Native fixture installs the same exact immutable projection binding in one bounded batch.
    await prisma.$executeRaw`UPDATE webhook_events event SET status = 'NO_REPLAY_HELD', legacy_disposition_id = proof.id,
      legacy_disposition_receipt_id = event.id FROM webhook_legacy_receipt_dispositions proof
      WHERE proof.receipt_id = event.id AND proof.authority_id = ${certificateId}
        AND event.legacy_disposition_id IS NULL`;
    const independent = await store(update(source.chatId, randomUUID()));
    // FLAG: A lone RECEIVED row makes any status index equally bounded. Include a
    // later pending population so this test proves ordered admission under backlog
    // without forcing planner settings or weakening the exact one-row/index bounds.
    const laterPending = Array.from({ length: 1000 }, (_, index) => {
      const id = randomUUID();
      receipts.push(id);
      return {
        ...independent,
        id,
        dedupKey: id,
        createdAt: new Date(independent.createdAt.getTime() + index + 1),
      };
    });
    for (let offset = 0; offset < laterPending.length; offset += 500) {
      await prisma.webhookEvent.createMany({
        data: JSON.parse(JSON.stringify(laterPending.slice(offset, offset + 500))),
      });
    }
    // FLAG: Shared native suites leave dead index entries. Normalize this disposable fixture
    // so the live held-history work bound does not depend on autovacuum timing.
    await prisma.$executeRaw`VACUUM (ANALYZE) webhook_events`;
    type Plan = {
      'Node Type': string;
      'Relation Name'?: string;
      'Index Name'?: string;
      'Actual Rows'?: number;
      'Actual Loops'?: number;
      'Rows Removed by Filter'?: number;
      'Rows Removed by Index Recheck'?: number;
      'Lossy Heap Blocks'?: number;
      Plans?: Plan[];
    };
    // FLAG: Exercise the actual indexed head plus exact metadata lookup. A simplified
    // ORDER BY created_at query can choose a different plan and omits the stable ID tie-break.
    const query = buildOldestPendingWebhookQuery(WebhookStatus.RECEIVED);
    const plans = await prisma.$queryRaw<Array<{ 'QUERY PLAN': Array<{ Plan: Plan }> }>>(Prisma.sql`
      EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${query}`);
    const nodes: Plan[] = [];
    const walk = (node: Plan) => {
      nodes.push(node);
      for (const child of node.Plans ?? []) walk(child);
    };
    walk(plans[0]!['QUERY PLAN'][0]!.Plan);
    const scans = nodes.filter((node) => node['Relation Name'] === 'webhook_events');
    // FLAG: PostgreSQL may place the exact PK lookup in a Bitmap Index Scan child.
    // Keep the ordered head, both index identities and all row/work bounds mandatory.
    expect(scans).toHaveLength(2);
    expect(scans).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          'Node Type': 'Index Only Scan',
          'Index Name': 'webhook_events_status_created_at_id_idx',
        }),
      ]),
    );
    const indexScans = nodes.filter((node) => node['Index Name']);
    expect(indexScans.map((node) => node['Index Name']).sort()).toEqual([
      'webhook_events_pkey',
      'webhook_events_status_created_at_id_idx',
    ]);
    for (const scan of new Set([...scans, ...indexScans])) {
      expect(scan).toEqual(
        expect.objectContaining({
          'Node Type': expect.stringMatching(
            /^(Index Only Scan|Index Scan|Bitmap Heap Scan|Bitmap Index Scan)$/,
          ),
        }),
      );
      expect(scan['Actual Rows']).toBe(1);
      expect(scan['Rows Removed by Filter'] ?? 0).toBe(0);
      expect(scan['Rows Removed by Index Recheck'] ?? 0).toBe(0);
      expect(scan['Lossy Heap Blocks'] ?? 0).toBe(0);
      expect(scan['Actual Loops']).toBe(1);
    }
    expect((await metrics.getLagSnapshot({ maxAgeMs: 0 })).oldestReceivedEventId).toBe(
      independent.id,
    );
  });

  it('does not materialize a pre-seal command or advance its cursor past that unknown source', async () => {
    const source = await owner();
    const value = update(source.chatId, source.userId, { at: Date.now() - 1000 });
    value.message!.text = '/ban';
    const raw = value.raw as { message: { body: { text: string } } };
    raw.message.body.text = '/ban';
    const command = await store(value);
    const certificateId = await seal(source.candidate, false);
    const page = await materializeLegacyHeldReceiptPage(prisma, certificateId, source.chatId, 2);
    expect(page).toMatchObject({ complete: false, blocked: true });
    expect(
      (await prisma.webhookEvent.findUniqueOrThrow({ where: { id: command.id } }))
        .legacyDispositionId,
    ).toBeNull();
    expect(await holds.materializeReceipt(command.id)).toBe('BLOCKED_UNKNOWN');
    const again = await materializeLegacyHeldReceiptPage(prisma, certificateId, source.chatId, 2);
    expect(again).toMatchObject({ complete: false, scanned: 0, blocked: true });
  });

  it('rolls back receipt proofs and all cursor progress when the single page checkpoint fails', async () => {
    const source = await owner();
    const independent = await store(update(source.chatId, `independent-${randomUUID()}`));
    const receipt = await store(update(source.chatId, source.userId, { at: Date.now() - 1000 }));
    const certificateId = await seal(source.candidate, false);
    const failing = observeCursorUpdates(true);
    await expect(
      materializeLegacyHeldReceiptPage(
        failing.database as never,
        certificateId,
        source.chatId,
        200,
      ),
    ).rejects.toThrow('Synthetic cursor write failure');
    expect(failing.writes).toHaveBeenCalledTimes(1);
    expect(await prisma.webhookEvent.findUniqueOrThrow({ where: { id: independent.id } })).toEqual(
      independent,
    );
    expect(
      await prisma.webhookLegacyMaterializationCursor.findUnique({
        where: { certificateId_chatId: { certificateId, chatId: source.chatId } },
      }),
    ).toBeNull();
    expect(
      await prisma.webhookLegacyReceiptDisposition.findUnique({ where: { receiptId: receipt.id } }),
    ).toBeNull();
    expect(
      (await prisma.webhookEvent.findUniqueOrThrow({ where: { id: receipt.id } }))
        .legacyDispositionId,
    ).toBeNull();
    expect(
      await materializeLegacyHeldReceiptPage(prisma, certificateId, source.chatId, 200),
    ).toEqual({
      complete: true,
      scanned: 3,
      applied: 1,
      blocked: false,
    });
  });

  it('commits only the proved prefix before a middle-of-page unknown source', async () => {
    const source = await owner();
    const ordinary = await store(update(source.chatId, source.userId, { at: Date.now() - 2000 }));
    const commandValue = update(source.chatId, source.userId, { at: Date.now() - 1000 });
    commandValue.message!.text = '/ban';
    (commandValue.raw as { message: { body: { text: string } } }).message.body.text = '/ban';
    const command = await store(commandValue);
    const ordinaryCreatedAt = new Date(Date.now() - 1500);
    await prisma.webhookEvent.update({
      where: { id: ordinary.id },
      data: { createdAt: ordinaryCreatedAt },
    });
    const certificateId = await seal(source.candidate, false);
    const observed = observeCursorUpdates();
    const page = await materializeLegacyHeldReceiptPage(
      observed.database as never,
      certificateId,
      source.chatId,
      200,
    );
    expect(page).toEqual({ complete: false, scanned: 2, applied: 1, blocked: true });
    expect(observed.writes).toHaveBeenCalledTimes(1);
    const cursor = await prisma.webhookLegacyMaterializationCursor.findUniqueOrThrow({
      where: { certificateId_chatId: { certificateId, chatId: source.chatId } },
    });
    expect(cursor).toMatchObject({
      afterId: ordinary.id,
      afterCreatedAt: ordinaryCreatedAt,
      scanned: 2,
      complete: false,
    });
    expect(
      (await prisma.webhookEvent.findUniqueOrThrow({ where: { id: ordinary.id } })).status,
    ).toBe('NO_REPLAY_HELD');
    expect(
      (await prisma.webhookEvent.findUniqueOrThrow({ where: { id: command.id } }))
        .legacyDispositionId,
    ).toBeNull();
    expect(
      await materializeLegacyHeldReceiptPage(
        observed.database as never,
        certificateId,
        source.chatId,
        200,
      ),
    ).toEqual({
      complete: false,
      scanned: 0,
      applied: 0,
      blocked: true,
    });
    expect(observed.writes).toHaveBeenCalledTimes(1);
  });

  it('marks an empty page complete once without changing its last proved position', async () => {
    const source = await owner();
    const certificateId = await seal(source.candidate, false);
    const authority = await prisma.webhookLegacySealedAuthority.findUniqueOrThrow({
      where: { certificateId },
    });
    const afterCreatedAt = source.candidate.owner.createdAt;
    await prisma.webhookLegacyMaterializationCursor.create({
      data: {
        certificateId,
        chatId: source.chatId,
        horizon: authority.sealedAt,
        afterCreatedAt,
        afterId: source.candidate.owner.id,
        scanned: 1,
      },
    });
    const observed = observeCursorUpdates();
    for (let i = 0; i < 2; i++) {
      expect(
        await materializeLegacyHeldReceiptPage(
          observed.database as never,
          certificateId,
          source.chatId,
          200,
        ),
      ).toEqual({
        complete: true,
        scanned: 0,
        applied: 0,
        blocked: false,
      });
    }
    expect(observed.writes).toHaveBeenCalledTimes(1);
    expect(
      await prisma.webhookLegacyMaterializationCursor.findUniqueOrThrow({
        where: { certificateId_chatId: { certificateId, chatId: source.chatId } },
      }),
    ).toMatchObject({
      afterCreatedAt,
      afterId: source.candidate.owner.id,
      scanned: 1,
      complete: true,
    });
  });

  it('keeps the next unknown predecessor blocking after a different scope is sealed', async () => {
    const source = await owner();
    await seal(source.candidate);
    const unknown = await store(update(source.chatId, `unknown-${randomUUID()}`));
    await prisma.webhookEvent.update({
      where: { id: unknown.id },
      data: {
        status: 'FAILED',
        createdAt: new Date(Date.now() - 120_000),
        errorMessage:
          'WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINED:LEGACY_EXECUTION_UNVERIFIED; exact effects proof required',
      },
    });
    const waiting = await store(update(source.chatId, `independent-${randomUUID()}`));
    await prisma.webhookEvent.update({
      where: { id: waiting.id },
      data: {
        createdAt: new Date(Date.now() - 60_000),
      },
    });
    const observed = await pollAndObserve(source.chatId);
    expect(observed.heads.get(source.chatId)?.id).toBe(unknown.id);
    expect(observed.calls).not.toHaveBeenCalled();
    expect(observed.lag.oldestReceivedEventId).toBe(waiting.id);
    expect(observed.ready.checks.queueLag).toMatchObject({ ok: false, rawOk: false });
  });
});
