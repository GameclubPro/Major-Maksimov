import { performance } from 'node:perf_hooks';
import { createRequire } from 'node:module';
import * as sourceStoreRuntime from './source-abandonment-store';
import { buildMaxActionIdempotencyKey } from '../max/max-action-idempotency';
import { MANAGED_HANDSHAKE_CONFIRMATION_AUTO_DELETE_DELAY_MS } from '../max/managed-handshake-confirmation';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Queue } from 'bullmq';
import Redis from 'ioredis';
import { buildGroupCommandKey } from '../common/group-command-key';
import { RUNTIME_SERVICE_NAMES } from '../runtime/runtime-topology';
import { createPrismaClient, Prisma, type PrismaClient } from '../prisma/prisma-client';
import { WebhookParser } from '../webhook/webhook.parser';
import { buildWebhookSemanticEventKey } from '../webhook/webhook-semantic-event-key';
import { buildWebhookReceiptSemanticKey } from '../webhook/webhook-receipt-semantic-key';
import {
  inspectSourceAbandonmentCandidate,
  inspectSourceAbandonmentReceiptCandidate,
  materializeSourceAbandonmentReceipt,
} from '../webhook/webhook-source-abandonment';
import {
  buildSourceAbandonmentInventoryDigest,
  executeSourceAbandonmentStore,
  parseSourceAbandonmentStoreRequest,
  sourceAbandonmentStorePoolConfig,
} from './source-abandonment-store';
import {
  collectSourceAbandonmentAdmission,
  collectSourceAbandonmentLiveEvidence,
} from './source-abandonment-collect';
import { LEGACY_RECOVERY_LIVE_QUEUE_NAMES } from './legacy-recovery-live-registry';
import * as sourceSql from './source-abandonment-live-sql';
import { isLegacyRecoveryWebhookQueue } from './legacy-recovery-queue-inventory';
import type { SourceAbandonmentRedisReader } from './source-abandonment-live-redis';
import {
  inventorySourceAbandonmentSql,
  SourceInventorySqlMeter,
} from './source-abandonment-live-sql';
import {
  SOURCE_ABANDONMENT_PROTOCOL,
  SOURCE_ABANDONMENT_CHANNEL_MARKER_QUEUE,
  sourceAbandonmentDigest,
  type SourceAbandonmentLiveOutput,
  type SourceAbandonmentLiveRequest,
  type SourceAbandonmentLiveSelection,
} from './source-abandonment-live-protocol';

const databaseUrl = process.env.CHAT_ROUTING_POSTGRES_RACE_DATABASE_URL?.trim() ?? '';
const redisUrl = process.env.MAXIM_TEST_REDIS_URL?.trim() ?? '';
const native = databaseUrl && redisUrl ? describe : describe.skip;
jest.setTimeout(60_000);

native('modern exact-source offline inventory and store PostgreSQL authority', () => {
  let db: PrismaClient;
  let readonlyDb: PrismaClient;
  let chatId: string;
  let ownerId: string;
  let selection: SourceAbandonmentLiveSelection;
  let liveRequest: SourceAbandonmentLiveRequest;
  let redis: Redis;
  let fixtureRedisUrl: string;
  let ownsRedis = false;
  let historyWebhookIds: string[] = [];
  const publisherReceiptIds: string[] = [];
  const queues: Queue[] = [];

  beforeAll(async () => {
    const url = new URL(databaseUrl);
    if (
      !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
      !url.pathname.includes('race_test')
    ) {
      throw new Error('Disposable loopback PostgreSQL required');
    }
    db = createPrismaClient(databaseUrl, { max: 4, statement_timeout: 15_000 });
    readonlyDb = createPrismaClient(databaseUrl, sourceAbandonmentStorePoolConfig(true));
    const [identity] = await db.$queryRaw<Array<{ version: string; timezone: string }>>`
      SELECT version(), current_setting('TimeZone') AS timezone`;
    expect(identity?.version).toMatch(/^PostgreSQL 16\./u);
    expect(identity?.timezone).toBe('UTC');
    const redisTarget = new URL(redisUrl);
    if (!['localhost', '127.0.0.1', '[::1]'].includes(redisTarget.hostname))
      throw new Error('Disposable loopback Redis required');
    redisTarget.pathname = '/14';
    fixtureRedisUrl = redisTarget.toString();
    redis = new Redis(fixtureRedisUrl, { maxRetriesPerRequest: 1, commandTimeout: 10_000 });
    expect(await redis.info('server')).toMatch(/^redis_version:7\./mu);
    if (await redis.dbsize()) throw new Error('Disposable native Redis database is occupied');
    ownsRedis = true;
  });
  afterAll(async () => {
    await readonlyDb?.$disconnect();
    await db?.$disconnect();
    redis?.disconnect();
  });
  beforeEach(async () => {
    chatId = `-source-store-${randomUUID()}`;
    ownerId = randomUUID();
    await db.chat.create({
      data: { id: chatId, title: 'Native source inventory', entityType: 'CHAT' },
    });
    await db.chatSettings.create({ data: { chatId } });
    const [clock] = await db.$queryRaw<Array<{ at: Date; migrationAt: Date }>>`
      SELECT clock_timestamp() AT TIME ZONE 'UTC' AS at, finished_at AS "migrationAt"
      FROM _prisma_migrations WHERE migration_name = '20261005020000_add_multibot_order_fences'
        AND finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY finished_at DESC LIMIT 1`;
    expect(clock!.at.getTime()).toBeGreaterThan(clock!.migrationAt.getTime());
    const at = clock!.at.getTime();
    const update = new WebhookParser().parse(
      {
        update_type: 'message_created',
        update_id: randomUUID(),
        timestamp: at,
        message: {
          sender: { user_id: 'fixture-source-user', is_bot: false },
          recipient: { chat_id: chatId, chat_type: 'chat' },
          timestamp: at,
          body: { mid: `source-${randomUUID()}`, text: 'Original plain source' },
        },
      },
      { botId: 'major-1' },
    );
    const owner = await db.webhookEvent.create({
      data: {
        id: ownerId,
        botId: 'major-1',
        dedupKey: ownerId,
        semanticKey: buildWebhookSemanticEventKey(update),
        normalizedPayload: JSON.parse(JSON.stringify(update)),
        rawPayload: update.raw!,
        status: 'FAILED',
        errorMessage: 'CANONICAL_BUSINESS_ALREADY_STARTED',
        executionDeadlineAt: new Date(at + 300_000),
      },
    });
    const [started] = await db.$queryRaw<
      Array<{ at: Date }>
    >`SELECT clock_timestamp() AT TIME ZONE 'UTC' AS at`;
    await db.webhookExecutionClaim.create({
      data: {
        kind: 'EXECUTION',
        semanticKey: owner.semanticKey!,
        webhookEventId: ownerId,
        enforced: true,
        executionBotId: 'major-1',
        status: 'READY',
        createdAt: owner.createdAt,
        preparedAt: started!.at,
        businessStartedAt: started!.at,
      },
    });
    // FLAG: Own the representative distribution and statistics for every competing
    // chat-prefix index; prior suites' empty-table plans are not source-scope proof.
    historyWebhookIds = Array.from({ length: 512 }, () => randomUUID());
    await db.webhookEvent.createMany({
      data: historyWebhookIds.map((id, index) => {
        const historyUpdate = new WebhookParser().parse(
          {
            update_type: 'message_created',
            update_id: id,
            timestamp: at,
            message: {
              sender: { user_id: 'fixture-source-user', is_bot: false },
              recipient: { chat_id: chatId, chat_type: 'chat' },
              timestamp: at,
              body: { mid: `unrelated-history-${index}`, text: 'Independent pending source' },
            },
          },
          { botId: 'major-1' },
        );
        return {
          id,
          botId: 'major-1',
          dedupKey: id,
          semanticKey: buildWebhookSemanticEventKey(historyUpdate),
          normalizedPayload: JSON.parse(JSON.stringify(historyUpdate)),
          rawPayload: historyUpdate.raw!,
          status: 'FAILED' as const,
          errorMessage: 'NATIVE_UNRELATED_PREPARATION_FAILURE',
          createdAt: owner.createdAt,
          executionDeadlineAt: owner.executionDeadlineAt,
        };
      }),
    });
    // FLAG: Earlier suites can leave a tiny, bloated claims relation whose cheaper
    // kind-only scan correctly fails the collector's full-identity plan proof.
    // Own representative history for both common kinds and analyze it every time.
    await db.webhookExecutionClaim.createMany({
      data: historyWebhookIds.map((id, index) => ({
        kind: index % 2 === 0 ? 'EXECUTION' : 'COMMAND',
        semanticKey:
          index % 2 === 0
            ? `message:message_created:${chatId}:unrelated-history-${index}`
            : buildGroupCommandKey(chatId, `unrelated-history-${index}`),
        webhookEventId: id,
        status: 'COMPLETED' as const,
        createdAt: owner.createdAt,
        completedAt: started!.at,
      })),
    });
    await db.moderationEvent.createMany({
      data: Array.from({ length: 512 }, (_, index) => ({
        chatId,
        userId: 'unrelated-history-user',
        messageId: `unrelated-history-${index}`,
        eventType: 'MESSAGE' as const,
        ruleCode: 'NATIVE_HISTORY',
        action: 'NONE' as const,
      })),
    });
    await db.moderationViolationMessageClaim.createMany({
      data: Array.from({ length: 512 }, (_, index) => ({
        dedupeKey: `history-${ownerId}-${index}`,
        chatId,
        userId: 'unrelated-history-user',
        messageId: `unrelated-history-${index}`,
        ruleCode: 'NATIVE_HISTORY',
        updateType: 'message_created',
      })),
    });
    await db.spammerObservation.createMany({
      data: Array.from({ length: 512 }, (_, index) => ({
        chatId,
        userId: 'unrelated-history-user',
        messageId: `unrelated-history-${index}`,
        source: 'NATIVE_HISTORY',
        score: 0,
        reason: 'Unrelated native fixture',
        evidenceHash: sourceAbandonmentDigest(`history-${ownerId}-${index}`),
        expiresAt: new Date(at + 86_400_000),
      })),
    });
    await db.moderationDeleteIntent.createMany({
      data: Array.from({ length: 512 }, (_, index) => ({
        id: `history-${ownerId}-${index}`,
        chatId,
        messageId: `unrelated-history-${index}`,
        status: 'SUCCEEDED' as const,
        executeAt: new Date(at - 2000),
        retryUntilAt: new Date(at - 1000),
        completedAt: new Date(at - 1000),
      })),
    });
    await db.$executeRaw`ANALYZE webhook_events`;
    await db.$executeRaw`ANALYZE webhook_execution_claims`;
    await db.$executeRaw`ANALYZE moderation_events`;
    await db.$executeRaw`ANALYZE moderation_violation_message_claims`;
    await db.$executeRaw`ANALYZE spammer_observations`;
    await db.$executeRaw`ANALYZE moderation_delete_intents`;
    const [cutoff] = await db.$queryRaw<
      Array<{ at: Date }>
    >`SELECT clock_timestamp() AT TIME ZONE 'UTC' AS at`;
    selection = {
      protocol: SOURCE_ABANDONMENT_PROTOCOL,
      abandonBefore: cutoff!.at.toISOString(),
      ownerWebhookEventIds: [ownerId],
      majorBotIds: ['major-1'],
    };
    const sourceSha = 'a'.repeat(40),
      imageId = `sha256:${'b'.repeat(64)}`;
    liveRequest = {
      version: 1,
      operation: 'inventory_preview',
      selection,
      binding: {
        maintenanceId: randomUUID(),
        queueFenceNonce: randomUUID(),
        transitionJournalSha256: sourceAbandonmentDigest('native-store-journal'),
        sourceSha,
        imageId,
        stoppedGenerations: [
          ...RUNTIME_SERVICE_NAMES.filter((name) => name !== 'api-all'),
          'ocr-native-sandbox',
          'photo-native-sandbox',
        ].map((serviceName) => ({
          serviceName,
          containerId: sourceAbandonmentDigest(serviceName),
          sourceSha,
          imageId,
          stopped: true as const,
        })),
      },
    };
    // FLAG: This fixture owns only the empty disposable Redis database above.
    // The collector receives EVAL_RO; no production stop or restart is simulated.
    const pipeline = redis.pipeline();
    for (const name of LEGACY_RECOVERY_LIVE_QUEUE_NAMES.filter(isLegacyRecoveryWebhookQueue))
      pipeline.hset(`bull:${name}:meta`, 'paused', '1');
    pipeline.set(
      'maxim:webhook-rollout:pause-owner:v1',
      `rollout:${liveRequest.binding.queueFenceNonce}`,
    );
    await pipeline.exec();
  });
  afterEach(async () => {
    for (const queue of queues.splice(0)) await queue.close();
    if (ownsRedis) await redis.flushdb();
    // FLAG: Sealed receipt proofs stay immutable until disposable-store teardown.
    // Remove only this test's unheld Publisher fixtures and their claim aliases.
    const receiptIds = publisherReceiptIds.splice(0);
    await db.webhookExecutionClaim.deleteMany({ where: { webhookEventId: { in: receiptIds } } });
    await db.webhookEvent.deleteMany({
      where: { id: { in: receiptIds }, sourceDispositionId: null },
    });
    const held = await db.webhookSourceAbandonment.findUnique({
      where: { ownerWebhookEventId: ownerId },
    });
    if (!held) {
      await db.webhookExecutionClaim.deleteMany({ where: { webhookEventId: ownerId } });
      await db.webhookEvent.deleteMany({ where: { id: ownerId } });
    }
    const historyIds = historyWebhookIds.splice(0);
    await db.webhookExecutionClaim.deleteMany({ where: { webhookEventId: { in: historyIds } } });
    await db.webhookEvent.deleteMany({ where: { id: { in: historyIds } } });
    await db.spammerObservation.deleteMany({ where: { chatId } });
    // FLAG: An immutable channel marker retains its chat, so chat cascade cleanup
    // cannot own unrelated planner history. Remove only this fixture's history.
    const historyMessageIds = Array.from(
      { length: 512 },
      (_, index) => `unrelated-history-${index}`,
    );
    await db.moderationDeleteIntent.deleteMany({
      where: { chatId, id: { startsWith: `history-${ownerId}-` } },
    });
    await db.moderationEvent.deleteMany({
      where: { chatId, messageId: { in: historyMessageIds } },
    });
    await db.moderationViolationMessageClaim.deleteMany({
      where: { chatId, messageId: { in: historyMessageIds } },
    });
    await db.channelAutoPostAttachMarker.deleteMany({
      where: { chatId, messageId: { startsWith: `marker-history-${ownerId}-` } },
    });
    // FLAG: Authorless source markers remain immutable, including their chat FK.
    // Disposable-store teardown owns these retained fixture rows after readback.
    if (held?.sourceProfile !== 'CHANNEL_AUTHORLESS_V1')
      await db.chat.deleteMany({ where: { id: chatId } });
    await db.maxActionLedgerEntry.deleteMany({ where: { chatId } });
  });

  function inventory() {
    return db.$transaction(
      (tx) =>
        inventorySourceAbandonmentSql(tx, selection, {
          pages: 512,
          rows: 10_000,
          probes: 50_000,
          bytes: 8 * 1024 * 1024,
          deadlineAtMs: Date.now() + 30_000,
        }),
      { timeout: 30_000 },
    );
  }

  function collect(reader: SourceAbandonmentRedisReader = redis) {
    return db.$transaction((tx) => collectSourceAbandonmentLiveEvidence(tx, reader, liveRequest), {
      timeout: 30_000,
      isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
    });
  }

  async function candidateMeter(tx: Prisma.TransactionClient, pages = 512) {
    await tx.$executeRaw`SET LOCAL enable_seqscan = off`;
    await tx.$executeRaw`SET LOCAL enable_bitmapscan = off`;
    return new SourceInventorySqlMeter(tx, {
      pages,
      rows: 10_000,
      probes: 50_000,
      bytes: 8 * 1024 * 1024,
      deadlineAtMs: Date.now() + 30_000,
    });
  }

  it('proves every mirror while reading shared claim and settings evidence only twice', async () => {
    const owner = await db.webhookEvent.findUniqueOrThrow({ where: { id: ownerId } });
    const mirrorIds = Array.from({ length: 6 }, () => randomUUID());
    try {
      await db.webhookEvent.createMany({
        data: mirrorIds.map((id) => ({
          id,
          botId: owner.botId,
          dedupKey: id,
          semanticKey: owner.semanticKey,
          rawPayload: owner.rawPayload as Prisma.InputJsonValue,
          normalizedPayload: owner.normalizedPayload as Prisma.InputJsonValue,
          status: 'RECEIVED' as const,
        })),
      });
      const result = await inventory();
      expect(result.issues).toEqual([]);
      expect(result.selectedOwners).toHaveLength(1);
      expect(
        result.plans.filter((plan) => plan.descriptor === 'sql:exact-source-family'),
      ).toHaveLength(1);
      // FLAG: Every distinct receipt still pays for its own size and exact PK proof.
      // Shared settings and all kind-prefix sentinels get one independent final reread.
      expect(result.plans.filter((plan) => plan.descriptor === 'sql:source-size')).toHaveLength(
        mirrorIds.length + 2,
      );
      expect(result.plans.filter((plan) => plan.descriptor === 'sql:webhook_events')).toHaveLength(
        mirrorIds.length + 2,
      );
      expect(result.plans.filter((plan) => plan.descriptor === 'sql:chat_settings')).toHaveLength(
        2,
      );
      const prefixes = result.plans.filter((plan) => plan.descriptor === 'sql:claim-kind-prefix');
      expect(prefixes.length).toBeGreaterThan(0);
      for (const digest of new Set(prefixes.map((plan) => plan.querySha256)))
        expect(prefixes.filter((plan) => plan.querySha256 === digest)).toHaveLength(2);
      const claims = result.plans.filter(
        (plan) => plan.descriptor === 'sql:webhook_execution_claims',
      );
      expect(claims.length).toBeGreaterThan(mirrorIds.length);
      for (const digest of new Set(claims.map((plan) => plan.querySha256)))
        expect(claims.filter((plan) => plan.querySha256 === digest).length).toBeLessThanOrEqual(2);
      expect(result.cost.pages).toBe(result.plans.length * 2 + 2);
      expect(result.cost.probes).toBe(result.cost.pages);
      expect((await inventory()).stableDigest).toBe(result.stableDigest);
    } finally {
      await db.webhookEvent.deleteMany({ where: { id: { in: mirrorIds } } });
    }
  });

  it('keeps cached evidence detached from caller mutations, including Date and claim arrays', async () => {
    await db.$transaction(async (tx) => {
      const meter = await candidateMeter(tx);
      const first = await meter
        .candidateReader()
        .webhookEvent.findUnique({ where: { id: ownerId } });
      const original = structuredClone(first);
      expect(first!.createdAt).toBeInstanceOf(Date);
      first!.createdAt.setTime(0);
      (first!.normalizedPayload as Prisma.JsonObject).type = 'forged';
      const claims = await meter.candidateReader().webhookExecutionClaim.findMany({
        where: { webhookEventId: ownerId },
      });
      const originalClaims = structuredClone(claims);
      claims[0]!.kind = 'FORGED';
      claims.push({ ...claims[0]! });
      expect(
        await meter.candidateReader().webhookEvent.findUnique({ where: { id: ownerId } }),
      ).toEqual(original);
      expect(
        await meter.candidateReader().webhookExecutionClaim.findMany({
          where: { webhookEventId: ownerId },
        }),
      ).toEqual(originalClaims);
      await expect(meter.verifyCandidateReads()).resolves.toBeUndefined();
      expect(meter.plans.filter((plan) => plan.descriptor === 'sql:webhook_events')).toHaveLength(
        2,
      );
      expect(
        meter.plans.filter((plan) => plan.descriptor === 'sql:webhook_execution_claims'),
      ).toHaveLength(2);
    });
  });

  it('fits eight selected owners with two mirrors each inside the unchanged SQL budget', async () => {
    const owner = await db.webhookEvent.findUniqueOrThrow({ where: { id: ownerId } });
    const claim = await db.webhookExecutionClaim.findFirstOrThrow({
      where: { webhookEventId: ownerId, kind: 'EXECUTION' },
    });
    const addedIds: string[] = [];
    const selectedIds = [ownerId];
    try {
      for (let index = 0; index < 8; index++) {
        let sourceOwner = owner;
        if (index > 0) {
          const id = randomUUID();
          const raw = structuredClone(owner.rawPayload) as {
            update_id: string;
            message: { body: { mid: string } };
          };
          raw.update_id = id;
          raw.message.body.mid = `batch-source-${id}`;
          const update = new WebhookParser().parse(raw, { botId: owner.botId! });
          sourceOwner = await db.webhookEvent.create({
            data: {
              id,
              botId: owner.botId,
              dedupKey: id,
              semanticKey: buildWebhookSemanticEventKey(update),
              rawPayload: raw,
              normalizedPayload: JSON.parse(JSON.stringify(update)),
              status: 'FAILED',
              errorMessage: owner.errorMessage,
              executionDeadlineAt: owner.executionDeadlineAt,
              createdAt: owner.createdAt,
            },
          });
          addedIds.push(id);
          selectedIds.push(id);
          await db.webhookExecutionClaim.create({
            data: {
              kind: 'EXECUTION',
              semanticKey: sourceOwner.semanticKey!,
              webhookEventId: id,
              enforced: true,
              executionBotId: owner.botId,
              status: 'READY',
              createdAt: claim.createdAt,
              preparedAt: claim.preparedAt,
              businessStartedAt: claim.businessStartedAt,
            },
          });
        }
        const mirrorIds = [randomUUID(), randomUUID()];
        await db.webhookEvent.createMany({
          data: mirrorIds.map((id) => ({
            id,
            botId: sourceOwner.botId,
            dedupKey: id,
            semanticKey: sourceOwner.semanticKey,
            rawPayload: sourceOwner.rawPayload as Prisma.InputJsonValue,
            normalizedPayload: sourceOwner.normalizedPayload as Prisma.InputJsonValue,
            status: 'RECEIVED' as const,
          })),
        });
        addedIds.push(...mirrorIds);
      }
      selection = { ...selection, ownerWebhookEventIds: selectedIds };
      const result = await inventory();
      expect(result.issues).toEqual([]);
      expect(result.selectedOwners).toHaveLength(8);
      expect(result.cost.pages).toBeLessThanOrEqual(512);
      expect(
        result.plans.filter((plan) => plan.descriptor === 'sql:exact-source-family'),
      ).toHaveLength(8);
      expect(result.plans.filter((plan) => plan.descriptor === 'sql:source-size')).toHaveLength(32);
      expect((await inventory()).stableDigest).toBe(result.stableDigest);
    } finally {
      await db.webhookExecutionClaim.deleteMany({ where: { webhookEventId: { in: addedIds } } });
      await db.webhookEvent.deleteMany({ where: { id: { in: addedIds } } });
    }
  });

  it('runs seven-owner seven-chat positive stock batches with independent seals and advisory SQL phase timings', async () => {
    const baseOwner = await db.webhookEvent.findUniqueOrThrow({ where: { id: ownerId } });
    const baseClaim = await db.webhookExecutionClaim.findFirstOrThrow({
      where: { webhookEventId: ownerId, kind: 'EXECUTION' },
    });
    const selectedIds = [ownerId];
    const addedChatIds: string[] = [];
    const addedReceiptIds: string[] = [];
    try {
      for (let index = 0; index < 7; index++) {
        let sourceOwner = baseOwner;
        if (index > 0) {
          const id = randomUUID();
          const selectedChatId = `-source-batch-${randomUUID()}`;
          addedChatIds.push(selectedChatId);
          await db.chat.create({
            data: { id: selectedChatId, title: 'Native seven-chat batch', entityType: 'CHAT' },
          });
          await db.chatSettings.create({ data: { chatId: selectedChatId } });
          // FLAG: The base fixture owns representative same-chat history in every
          // competing chat-prefix index. Give each added chat the same distribution;
          // an empty new chat can otherwise choose a chat-only seek plus post-filter.
          const history = Array.from({ length: 512 }, (_, historyIndex) => ({
            chatId: selectedChatId,
            userId: 'unrelated-history-user',
            messageId: `seven-chat-unrelated-history-${historyIndex}`,
          }));
          await db.moderationEvent.createMany({
            data: history.map((row) => ({
              ...row,
              eventType: 'MESSAGE' as const,
              ruleCode: 'NATIVE_HISTORY',
              action: 'NONE' as const,
            })),
          });
          await db.moderationViolationMessageClaim.createMany({
            data: history.map((row, historyIndex) => ({
              ...row,
              dedupeKey: `seven-chat-history-${id}-${historyIndex}`,
              ruleCode: 'NATIVE_HISTORY',
              updateType: 'message_created',
            })),
          });
          await db.spammerObservation.createMany({
            data: history.map((row, historyIndex) => ({
              ...row,
              source: 'NATIVE_HISTORY',
              score: 0,
              reason: 'Unrelated native seven-chat fixture',
              evidenceHash: sourceAbandonmentDigest(`seven-chat-history-${id}-${historyIndex}`),
              expiresAt: new Date(baseOwner.createdAt.getTime() + 86_400_000),
            })),
          });
          await db.moderationDeleteIntent.createMany({
            data: history.map((row, historyIndex) => ({
              id: `seven-chat-history-${id}-${historyIndex}`,
              chatId: row.chatId,
              messageId: row.messageId,
              status: 'SUCCEEDED' as const,
              executeAt: new Date(baseOwner.createdAt.getTime() - 2000),
              retryUntilAt: new Date(baseOwner.createdAt.getTime() - 1000),
              completedAt: new Date(baseOwner.createdAt.getTime() - 1000),
            })),
          });
          const raw = structuredClone(baseOwner.rawPayload) as {
            update_id: string;
            message: { recipient: { chat_id: string }; body: { mid: string } };
          };
          raw.update_id = id;
          raw.message.recipient.chat_id = selectedChatId;
          raw.message.body.mid = `seven-owner-source-${id}`;
          const update = new WebhookParser().parse(raw, { botId: baseOwner.botId! });
          sourceOwner = await db.webhookEvent.create({
            data: {
              id,
              botId: baseOwner.botId,
              dedupKey: id,
              semanticKey: buildWebhookSemanticEventKey(update),
              rawPayload: raw,
              normalizedPayload: JSON.parse(JSON.stringify(update)),
              status: 'FAILED',
              errorMessage: baseOwner.errorMessage,
              executionDeadlineAt: baseOwner.executionDeadlineAt,
              createdAt: baseOwner.createdAt,
            },
          });
          selectedIds.push(id);
          addedReceiptIds.push(id);
          await db.webhookExecutionClaim.create({
            data: {
              kind: 'EXECUTION',
              semanticKey: sourceOwner.semanticKey!,
              webhookEventId: id,
              enforced: true,
              executionBotId: baseOwner.botId,
              status: 'READY',
              createdAt: baseClaim.createdAt,
              preparedAt: baseClaim.preparedAt,
              businessStartedAt: baseClaim.businessStartedAt,
            },
          });
        }
        const mirrors = [randomUUID(), randomUUID()];
        addedReceiptIds.push(...mirrors);
        await db.webhookEvent.createMany({
          data: mirrors.map((id) => ({
            id,
            botId: sourceOwner.botId,
            dedupKey: id,
            semanticKey: sourceOwner.semanticKey,
            rawPayload: sourceOwner.rawPayload as Prisma.InputJsonValue,
            normalizedPayload: sourceOwner.normalizedPayload as Prisma.InputJsonValue,
            status: 'RECEIVED' as const,
          })),
        });
      }
      await db.$executeRaw`ANALYZE moderation_events`;
      await db.$executeRaw`ANALYZE moderation_violation_message_claims`;
      await db.$executeRaw`ANALYZE spammer_observations`;
      await db.$executeRaw`ANALYZE moderation_delete_intents`;
      selection = { ...selection, ownerWebhookEventIds: selectedIds };
      liveRequest = { ...liveRequest, selection };
      const ownersBefore = await db.webhookEvent.findMany({
        where: { id: { in: selectedIds } },
        orderBy: { id: 'asc' },
      });
      const claimsBefore = await db.webhookExecutionClaim.findMany({
        where: { webhookEventId: { in: selectedIds } },
        orderBy: { id: 'asc' },
      });
      const { request, bytes } = await storeFixture();
      type StoreResult = Awaited<ReturnType<typeof executeSourceAbandonmentStore>>;
      type Phase = 'install' | 'materialize' | 'readback';
      type BatchOutput = {
        results: Array<{ result: StoreResult; pages?: StoreResult[] }>;
      };
      type Dependencies = {
        stock: typeof sourceStoreRuntime;
        env: NodeJS.ProcessEnv;
        readInventory(index: number): Buffer;
        createPrismaClient(
          url: string,
          config: Parameters<typeof createPrismaClient>[1],
        ): Pick<PrismaClient, '$transaction' | '$disconnect' | '$queryRaw'>;
      };
      const loadBatch = createRequire(__filename);
      const batch = loadBatch(
        resolve(__dirname, '../../../../infra/scripts/source-abandonment-session-store-batch.cjs'),
      ) as {
        STORE_BATCH_LIMITS: { phaseMs: Record<Phase, number> };
        runSourceAbandonmentStoreBatch(
          input: unknown,
          dependencies: Dependencies,
        ): Promise<BatchOutput>;
      };
      const operations: Array<Parameters<typeof executeSourceAbandonmentStore>[1]['operation']> =
        [];
      const poolModes: boolean[] = [];
      let disconnectedPools = 0;
      const timings: Array<{ phase: string; elapsedMs: number; stockCalls: number }> = [];
      const dependencies: Dependencies = {
        stock: {
          ...sourceStoreRuntime,
          executeSourceAbandonmentStore: async (
            ...args: Parameters<typeof executeSourceAbandonmentStore>
          ) => {
            operations.push(args[1].operation);
            return executeSourceAbandonmentStore(...args);
          },
        },
        env: {
          DATABASE_URL: databaseUrl,
          MAXIM_SOURCE_ABANDONMENT_OFFLINE: '1',
          MAXIM_SOURCE_ABANDONMENT_PROTOCOL: 'source-abandonment-v1',
          APP_SERVICE_NAME: 'source-abandonment-store',
          APP_SOURCE_SHA: request.binding.sourceSha,
          MAXIM_SOURCE_ABANDONMENT_IMAGE_ID: request.binding.imageId,
          TZ: 'UTC',
        },
        readInventory(index) {
          expect(index).toBe(0);
          return bytes;
        },
        createPrismaClient(url, config) {
          expect(url).toBe(databaseUrl);
          expect(config?.max).toBe(1);
          poolModes.push(config?.options?.includes('default_transaction_read_only=on') === true);
          const pool = createPrismaClient(url, config);
          return {
            $transaction: pool.$transaction.bind(pool),
            $queryRaw: pool.$queryRaw.bind(pool),
            async $disconnect() {
              try {
                await pool.$disconnect();
              } finally {
                disconnectedPools++;
              }
            },
          };
        },
      };
      const invoke = async (phase: Phase, label: string) => {
        dependencies.env.MAXIM_SOURCE_ABANDONMENT_STORE_MODE =
          phase === 'readback' ? 'readback' : 'writer';
        const operationCount = operations.length;
        const started = performance.now();
        const output = await batch.runSourceAbandonmentStoreBatch(
          {
            version: 1,
            kind: 'source_abandonment_session_store_batch',
            phase,
            deadlineAtMs: Date.now() + batch.STORE_BATCH_LIMITS.phaseMs[phase],
            items: [{ inventoryIndex: 0, request: { ...request, operation: 'readback' } }],
          },
          dependencies,
        );
        timings.push({
          phase: label,
          elapsedMs: performance.now() - started,
          stockCalls: operations.length - operationCount,
        });
        expect(output.results).toHaveLength(1);
        expect(disconnectedPools).toBe(poolModes.length);
        return output.results[0]!;
      };
      expect((await invoke('readback', 'absent')).result).toMatchObject({ state: 'ABSENT' });
      expect((await invoke('install', 'install')).result).toMatchObject({
        state: 'SEALED',
        requiredChats: 7,
        completeChats: 0,
      });
      expect((await invoke('readback', 'installed_seal')).result).toMatchObject({
        state: 'SEALED',
        requiredChats: 7,
        completeChats: 0,
      });
      const materialized = await invoke('materialize', 'materialize');
      expect(materialized.pages).toHaveLength(7);
      expect(materialized.pages?.map((page) => ('page' in page ? page.page : null))).toEqual(
        Array.from({ length: 7 }, () => ({
          complete: true,
          scanned: 2,
          applied: 2,
          blocked: false,
        })),
      );
      for (const label of ['materialized_seal', 'final_readback_1', 'final_readback_2']) {
        expect((await invoke('readback', label)).result).toMatchObject({
          state: 'MATERIALIZED',
          requiredChats: 7,
          completeChats: 7,
        });
      }
      expect(operations).toEqual([
        'readback',
        'certificate_create',
        'install',
        'readback',
        ...Array.from({ length: 7 }, () => 'materialize'),
        'readback',
        'readback',
        'readback',
      ]);
      expect(poolModes).toEqual([true, false, true, false, true, true, true]);
      expect(disconnectedPools).toBe(7);
      expect(
        await db.webhookExecutionClaim.findMany({
          where: { webhookEventId: { in: selectedIds } },
          orderBy: { id: 'asc' },
        }),
      ).toEqual(claimsBefore);
      expect(
        await db.webhookEvent.findMany({
          where: { id: { in: selectedIds } },
          orderBy: { id: 'asc' },
        }),
      ).toEqual(
        ownersBefore.map((owner) => ({
          ...owner,
          sourceDispositionId: expect.any(String),
          sourceDispositionReceiptId: owner.id,
        })),
      );
      expect(
        await db.webhookEvent.count({
          where: {
            id: { in: addedReceiptIds.filter((id) => !selectedIds.includes(id)) },
            status: 'NO_REPLAY_HELD',
            sourceDispositionId: { not: null },
          },
        }),
      ).toBe(14);
      expect(
        await db.webhookEvent.count({
          where: { id: { in: historyWebhookIds }, sourceDispositionId: null, status: 'FAILED' },
        }),
      ).toBe(512);
      const historyScope = { chatId: { in: addedChatIds } };
      expect(await db.moderationEvent.count({ where: historyScope })).toBe(6 * 512);
      expect(await db.moderationViolationMessageClaim.count({ where: historyScope })).toBe(6 * 512);
      expect(await db.spammerObservation.count({ where: historyScope })).toBe(6 * 512);
      expect(
        await db.moderationDeleteIntent.count({ where: { ...historyScope, status: 'SUCCEEDED' } }),
      ).toBe(6 * 512);
      // FLAG: SQL lifecycle timings are advisory local observations; no CPU/cgroup,
      // Docker/process startup, production latency or accepted downtime is measured.
      process.stdout.write(
        `${JSON.stringify({ native: true, audit: 'positive_seven_chat_stock_batch', selectedOwners: 7, selectedChats: 7, sourceMirrors: 14, materializationPages: 7, materializedReceipts: 14, stockCalls: operations.length, poolOpens: poolModes.length, poolDisconnects: disconnectedPools, independentFinalReadbackPools: 2, timings })}\n`,
      );
    } finally {
      for (const id of selectedIds.slice(1)) {
        if (
          !(await db.webhookSourceAbandonment.findUnique({ where: { ownerWebhookEventId: id } }))
        ) {
          await db.webhookExecutionClaim.deleteMany({ where: { webhookEventId: id } });
        }
      }
      await db.webhookEvent.deleteMany({
        where: { id: { in: addedReceiptIds }, sourceDispositionId: null },
      });
      await db.spammerObservation.deleteMany({ where: { chatId: { in: addedChatIds } } });
      // FLAG: Immutable positive holds/proofs remain for disposable-store teardown.
      // Added chats cascade only their unrelated history; no held source has a chat FK.
      await db.chat.deleteMany({ where: { id: { in: addedChatIds } } });
    }
  });

  it('keeps the complete-family saturation sentinel outside memoization', async () => {
    const owner = await db.webhookEvent.findUniqueOrThrow({ where: { id: ownerId } });
    const mirrorIds = Array.from({ length: 200 }, () => randomUUID());
    try {
      await db.webhookEvent.createMany({
        data: mirrorIds.map((id) => ({
          id,
          botId: owner.botId,
          dedupKey: id,
          semanticKey: owner.semanticKey,
          rawPayload: owner.rawPayload as Prisma.InputJsonValue,
          normalizedPayload: owner.normalizedPayload as Prisma.InputJsonValue,
          status: 'RECEIVED' as const,
        })),
      });
      const result = await inventory();
      expect(result.issues).toContainEqual({
        code: 'source_family_saturated_or_missing',
        descriptor: 'sql:exact-source-family',
      });
      expect(result.plans.filter((plan) => plan.descriptor === 'sql:exact-source-family')).toEqual([
        expect.objectContaining({ returnedRows: 201 }),
      ]);
    } finally {
      await db.webhookEvent.deleteMany({ where: { id: { in: mirrorIds } } });
    }
  });

  it.each(['settings', 'owner', 'command', 'kind'] as const)(
    'refuses a concurrent %s change before accepting reused READ COMMITTED proof',
    async (changed) => {
      const addedClaimIds: string[] = [];
      try {
        await db.$transaction(
          async (tx) => {
            const meter = await candidateMeter(tx);
            const reader = meter.candidateReader();
            if (changed === 'settings') {
              await reader.chatSettings.findUnique({ where: { chatId } });
              await reader.chatSettings.findUnique({ where: { chatId } });
              await db.chatSettings.update({
                where: { chatId },
                data: { adminBanCommandName: 'особое' },
              });
            } else if (changed === 'owner') {
              await reader.webhookEvent.findUnique({ where: { id: ownerId } });
              await reader.webhookEvent.findUnique({ where: { id: ownerId } });
              await db.webhookEvent.update({
                where: { id: ownerId },
                data: { errorMessage: 'Changed source evidence' },
              });
            } else {
              const owner = await db.webhookEvent.findUniqueOrThrow({ where: { id: ownerId } });
              let kind = 'COMMAND';
              let semanticKey = buildGroupCommandKey(
                chatId,
                (
                  owner.normalizedPayload as {
                    message: { messageId: string };
                  }
                ).message.messageId,
              );
              if (changed === 'kind') {
                const last = await db.webhookExecutionClaim.findFirstOrThrow({
                  orderBy: { kind: 'desc' },
                });
                const where = { kind: { gt: last.kind } };
                expect(await reader.webhookExecutionClaim.findFirst({ where })).toBeNull();
                expect(await reader.webhookExecutionClaim.findFirst({ where })).toBeNull();
                kind = `${last.kind}~memo-${randomUUID()}`;
                semanticKey = owner.semanticKey!;
              } else {
                const where = { kind_semanticKey: { kind, semanticKey } };
                expect(await reader.webhookExecutionClaim.findUnique({ where })).toBeNull();
                expect(await reader.webhookExecutionClaim.findUnique({ where })).toBeNull();
              }
              const claim = await db.webhookExecutionClaim.create({
                data: { kind, semanticKey, webhookEventId: ownerId },
              });
              addedClaimIds.push(claim.id);
            }
            await expect(meter.verifyCandidateReads()).rejects.toMatchObject({
              code: 'sql_candidate_proof_changed',
            });
          },
          { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, timeout: 30_000 },
        );
      } finally {
        await db.webhookExecutionClaim.deleteMany({ where: { id: { in: addedClaimIds } } });
      }
    },
  );

  it('never reuses proof across inventory calls within the same transaction', async () => {
    await db.$transaction(
      async (tx) => {
        const meter = await candidateMeter(tx);
        const first = await inventorySourceAbandonmentSql(tx, selection, meter.allowance);
        expect(first.issues).toEqual([]);
        const claim = await tx.webhookExecutionClaim.create({
          data: {
            kind: `INDEPENDENT-${randomUUID()}`,
            semanticKey: first.candidates[0]!.claim.semanticKey,
            webhookEventId: ownerId,
          },
        });
        try {
          const second = await inventorySourceAbandonmentSql(tx, selection, meter.allowance);
          expect(second.issues).toContainEqual({
            code: 'source_started_claim_unproved',
            descriptor: 'sql:selected-source',
          });
          expect(second.candidates).toEqual([]);
        } finally {
          await tx.webhookExecutionClaim.delete({ where: { id: claim.id } });
        }
      },
      { timeout: 30_000 },
    );
  });

  it('charges the independent verification against the original page cap', async () => {
    await db.$transaction(async (tx) => {
      const meter = await candidateMeter(tx, 2);
      const reader = meter.candidateReader();
      await reader.chatSettings.findUnique({ where: { chatId } });
      await reader.chatSettings.findUnique({ where: { chatId } });
      expect(meter.cost.pages).toBe(2);
      await expect(meter.verifyCandidateReads()).rejects.toMatchObject({
        code: 'sql_budget_exceeded',
      });
      expect(meter.cost.pages).toBe(2);
    });
  });

  it.each([
    [19_000, 0, 'READY_FOR_COLD_REVIEW'],
    [19_000, 4_000, 'DENY'],
    [20_001, 0, 'DENY'],
  ] as const)(
    'bounds two catalog passes at %i ms and final SQL at %i ms: %s',
    async (catalogMs, childSqlMs, decision) => {
      const startedAt = Date.now();
      let elapsed = 0;
      const clock = jest.spyOn(Date, 'now').mockImplementation(() => startedAt + elapsed);
      const originalSql = sourceSql.inventorySourceAbandonmentSql;
      const originalChildSql = sourceSql.inventorySourceAbandonmentChildSql;
      const sql = jest
        .spyOn(sourceSql, 'inventorySourceAbandonmentSql')
        .mockImplementation(async (...args) => {
          const result = await originalSql(...args);
          elapsed += 3_000;
          return result;
        });
      const childSql = jest
        .spyOn(sourceSql, 'inventorySourceAbandonmentChildSql')
        .mockImplementation(async (...args) => {
          const result = await originalChildSql(...args);
          elapsed += childSqlMs;
          return result;
        });
      let catalogReads = 0;
      const reader: SourceAbandonmentRedisReader = {
        eval_ro: redis.eval_ro.bind(redis),
        multi() {
          const transaction = redis.multi();
          const exec = transaction.exec.bind(transaction);
          transaction.exec = async () => {
            const result = await exec();
            // FLAG: Only the collector wall clock is virtual. Native SQL, Redis
            // EVAL_RO, commandstats measurements and proof parsing stay real.
            elapsed += catalogMs;
            catalogReads++;
            return result;
          };
          return transaction;
        },
      };
      try {
        const evidence = await db.$transaction(
          (tx) =>
            collectSourceAbandonmentAdmission(tx, reader, {
              version: 1,
              operation: 'admission_preview',
              sourceSha: liveRequest.binding.sourceSha,
              imageId: liveRequest.binding.imageId,
              selection,
            }),
          { timeout: 50_000, isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
        );
        expect(evidence.decision).toBe(decision);
        expect(catalogReads).toBe(2);
        expect(evidence.redisCatalogs).toHaveLength(2);
        if (catalogMs > 20_000) {
          expect(evidence.redisCatalogs.every((proof) => !proof.complete)).toBe(true);
          expect(evidence.issues).toContainEqual({
            code: 'CATALOG_DEADLINE_EXCEEDED',
            descriptor: 'redis:namespace-catalog',
          });
        } else {
          expect(evidence.redisCatalogs.every((proof) => proof.complete)).toBe(true);
          expect(elapsed).toBe(41_000 + childSqlMs);
          expect(childSql).toHaveBeenCalledTimes(1);
          expect(evidence.issues).toEqual(
            childSqlMs
              ? [{ code: 'inventory_store_or_budget_refused', descriptor: 'inventory' }]
              : [],
          );
        }
      } finally {
        childSql.mockRestore();
        sql.mockRestore();
        clock.mockRestore();
      }
    },
  );

  it.each(['', '2027-01-02T03:04:05.000Z'])(
    'reads only command settings despite large unrelated media and string expiry %j',
    async (requiredSubscriptionExpiresAt) => {
      const settings = await db.chatSettings.update({
        where: { chatId },
        data: {
          requiredSubscriptionExpiresAt,
          botSpeechMedia: { fixture: 'x'.repeat(600_000) },
        },
      });
      const restored = await db.$transaction(async (tx) => {
        await tx.$executeRaw`SET LOCAL enable_seqscan = off`;
        await tx.$executeRaw`SET LOCAL enable_bitmapscan = off`;
        const meter = new SourceInventorySqlMeter(tx, {
          pages: 4,
          rows: 4,
          probes: 4,
          bytes: 2 * 1024 * 1024,
          deadlineAtMs: Date.now() + 10_000,
        });
        return meter.candidateReader().chatSettings.findUnique({ where: { chatId } });
      });
      expect(restored).toEqual({
        chatId,
        sourceInventoryRowVersion: expect.stringMatching(/^\d+:\(\d+,\d+\)$/u),
        adminBanCommandName: settings.adminBanCommandName,
        adminBanAllCommandName: settings.adminBanAllCommandName,
        adminMuteCommandName: settings.adminMuteCommandName,
        adminPermanentMuteCommandName: settings.adminPermanentMuteCommandName,
        adminRulesCommandName: settings.adminRulesCommandName,
        adminSilenceCommandName: settings.adminSilenceCommandName,
        adminOpenChatCommandName: settings.adminOpenChatCommandName,
      });
      const evidence = await db.$transaction(
        (tx) =>
          collectSourceAbandonmentAdmission(tx, redis, {
            version: 1,
            operation: 'admission_preview',
            sourceSha: liveRequest.binding.sourceSha,
            imageId: liveRequest.binding.imageId,
            selection,
          }),
        { timeout: 30_000, isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
      );
      expect(evidence.issues).toEqual([]);
      expect(evidence.decision).toBe('READY_FOR_COLD_REVIEW');
      expect(evidence.sourceCoverageComplete).toBe(true);
      expect(evidence.selectedOwners).toHaveLength(1);
    },
  );

  it.each([
    ['missing', Prisma.TransactionIsolationLevel.RepeatableRead, 'DENY'],
    ['pending', Prisma.TransactionIsolationLevel.RepeatableRead, 'DENY'],
    ['missing', Prisma.TransactionIsolationLevel.ReadCommitted, 'READY_FOR_COLD_REVIEW'],
    ['pending', Prisma.TransactionIsolationLevel.ReadCommitted, 'READY_FOR_COLD_REVIEW'],
  ] as const)(
    'reproduces a post-snapshot cleanup parent %s under %s as %s',
    async (initialParent, isolationLevel, decision) => {
      const suffix = randomUUID();
      const parentKey = `snapshot-parent-${suffix}`;
      const childKey = `snapshot-cleanup-${suffix}`;
      const cleanupChat = '-200';
      const createdAt = new Date(Date.now() - 1000).toISOString();
      const completedAt = new Date().toISOString();
      const context = { moderationNoticeEnvelope: { version: 1 } };
      const metadata = {
        createdAt,
        autoDeleteDelayMs: 60_000,
        sendAutoDelete: null,
        hasOptions: true,
        optionKeys: ['textFormat'],
        ledgerContext: context,
      };
      const parent = {
        jobId: parentKey,
        chatId: cleanupChat,
        actionType: 'SEND_MESSAGE',
        messageId: null,
        userId: null,
        sourceTag: 'moderation_notice',
        status: 'SUCCEEDED' as const,
        terminal: true,
        ambiguous: false,
        remoteMessageId: `confirmed-${suffix}`,
        dispatchBotId: 'major-1',
        completedAt: new Date(completedAt),
        metadata,
      };
      const historyKeys = Array.from({ length: 512 }, (_, index) => `snapshot-${suffix}-${index}`);
      const queue = await actionQueue();
      try {
        // FLAG: Representative committed history keeps the actual metered resolver's
        // exact unique-index proof valid without changing production planner flags.
        await db.maxActionLedgerEntry.createMany({
          data: historyKeys.map((jobId) => ({ ...parent, jobId })),
        });
        if (initialParent === 'pending')
          await db.maxActionLedgerEntry.create({
            data: {
              ...parent,
              status: 'IN_PROGRESS',
              terminal: false,
              remoteMessageId: null,
              completedAt: null,
            },
          });
        await db.$executeRaw`ANALYZE max_action_ledger`;
        let interleaved = false;
        const reader: SourceAbandonmentRedisReader = {
          eval_ro: (script, keys, ...args) => redis.eval_ro(script, keys, ...args),
          multi() {
            const transaction = redis.multi();
            const measured = {
              eval_ro(script: string, keys: number, ...args: string[]) {
                transaction.eval_ro(script, keys, ...args);
                return measured;
              },
              async exec() {
                if (!interleaved) {
                  interleaved = true;
                  // FLAG: The actual collector has completed its initial SQL inventory here.
                  // Commit on an independent connection before publishing the cleanup.
                  if (initialParent === 'missing')
                    await db.maxActionLedgerEntry.create({ data: parent });
                  else
                    await db.maxActionLedgerEntry.update({
                      where: { jobId: parentKey },
                      data: parent,
                    });
                  await queue.add(
                    'action',
                    {
                      actionType: 'DELETE_MESSAGE',
                      idempotencyKey: childKey,
                      chatId: cleanupChat,
                      messageId: parent.remoteMessageId,
                      botId: 'major-1',
                      sourceTag: 'moderation_notice',
                      ledgerContext: context,
                      sendAutoDelete: {
                        version: 2,
                        sourceSendJobId: parentKey,
                        sourceChatId: cleanupChat,
                        sourceMessageId: null,
                        sourceUserId: null,
                        sourceCreatedAt: createdAt,
                        sourceSendCompletedAt: completedAt,
                        requestedDelayMs: 60_000,
                        originBotId: 'major-1',
                      },
                    },
                    { jobId: childKey, delay: 60_000 },
                  );
                }
                return transaction.exec();
              },
            };
            return measured;
          },
        };
        const result = await readonlyDb.$transaction(
          async (tx) => {
            await tx.$executeRaw`SET TRANSACTION READ ONLY`;
            return collectSourceAbandonmentAdmission(tx, reader, {
              version: 1,
              operation: 'admission_preview',
              sourceSha: liveRequest.binding.sourceSha,
              imageId: liveRequest.binding.imageId,
              selection,
            });
          },
          { timeout: 30_000, isolationLevel },
        );
        expect(interleaved).toBe(true);
        expect(result.selectedOwners).toHaveLength(1);
        expect(result.redisCatalogs).toHaveLength(2);
        expect(result.redisCatalogs.every((catalog) => catalog.complete && !catalog.issue)).toBe(
          true,
        );
        expect(result.decision).toBe(decision);
        expect(result.issues).toEqual(
          decision === 'DENY'
            ? [
                {
                  code: 'CLEANUP_ORIGINAL_SOURCE_UNPROVED',
                  descriptor: 'redis:max-actions-background',
                },
              ]
            : [],
        );
        expect(result.stoppingAuthorized).toBe(false);
        expect(result.activationAuthorized).toBe(false);
        expect(
          await db.maxActionLedgerEntry.findUniqueOrThrow({ where: { jobId: parentKey } }),
        ).toMatchObject(parent);
        expect(await redis.zcard('bull:max-actions-background:delayed')).toBe(1);
        expect(
          await db.webhookSourceAbandonment.findUnique({ where: { ownerWebhookEventId: ownerId } }),
        ).toBeNull();
      } finally {
        await db.maxActionLedgerEntry.deleteMany({
          where: { jobId: { in: [parentKey, ...historyKeys] } },
        });
      }
    },
  );

  it.each([
    ['major', 'admission_preview'],
    ['major', 'inventory_preview'],
    ['publisher', 'admission_preview'],
    ['publisher', 'inventory_preview'],
    ['publisher-missing-catalog', 'admission_preview'],
    ['publisher-missing-catalog', 'inventory_preview'],
    ['required-subscription', 'admission_preview'],
    ['required-subscription', 'inventory_preview'],
    ['required-subscription-invalid', 'admission_preview'],
    ['required-subscription-invalid', 'inventory_preview'],
    ['notice-source', 'admission_preview'],
    ['notice-source', 'inventory_preview'],
    ['notice-rule', 'admission_preview'],
    ['notice-rule', 'inventory_preview'],
    ['notice-rule-source', 'admission_preview'],
    ['notice-rule-source', 'inventory_preview'],
    ['notice-rule-followup', 'admission_preview'],
    ['notice-rule-followup', 'inventory_preview'],
    ['notice-rule-followup-source', 'admission_preview'],
    ['notice-rule-followup-source', 'inventory_preview'],
    ['notice-rule-source-conflict', 'admission_preview'],
    ['notice-rule-source-conflict', 'inventory_preview'],
    ['notice-followup-only', 'admission_preview'],
    ['notice-followup-only', 'inventory_preview'],
  ] as const)(
    'proves exact completed %s notice cleanup through %s without changing it',
    async (origin, operation) => {
      const suffix = randomUUID();
      const publisher = origin.startsWith('publisher');
      const requiredSubscription = origin.startsWith('required-subscription');
      const finiteNotice = origin.startsWith('notice-');
      const botId = publisher ? 'publisher-1' : 'major-1';
      const followupId = `notice-followup-${suffix}`;
      const publisherBotId = origin === 'publisher' ? botId : undefined;
      const cleanupChat = '-200';
      const parentKey = buildMaxActionIdempotencyKey('explicit', [
        ...(publisher ? [botId] : []),
        'SEND_MESSAGE',
        origin.includes('followup')
          ? `${followupId}:explanation`
          : publisher
            ? `publisher-handshake-start:${cleanupChat}:${suffix}`
            : `managed-handshake-start:groupcmd:v1:${suffix}`,
      ]);
      const childKey = `handshake-cleanup-${suffix}`;
      const createdAt = new Date(Date.now() - 1000).toISOString();
      const completedAt = new Date().toISOString();
      const sourceTag =
        requiredSubscription || finiteNotice ? 'moderation_notice' : 'managed_handshake';
      let context: Record<string, Prisma.InputJsonValue> | null = requiredSubscription
        ? {
            moderationNoticeEnvelope: { version: 1 },
            requiredSubscriptionNotice: {
              version: origin === 'required-subscription-invalid' ? 2 : 1,
              chatId: cleanupChat,
              messageId: `original-${suffix}`,
              userId: 'original-user',
              reasonKey: 'REQUIRED_SUBSCRIPTION:message-delete',
              policySha256: 'a'.repeat(64),
              sourceAtMs: Date.parse(createdAt) - 1_000,
              deadlineAtMs: Date.parse(createdAt) - 1_000 + 5 * 60_000,
            },
          }
        : null;
      if (finiteNotice) {
        context = { moderationNoticeEnvelope: { version: 1 } };
        const sourceAtMs = Date.parse(createdAt) - 1_000;
        if (origin.includes('rule'))
          context.moderationRuleNotice = {
            version: 1,
            chatId: cleanupChat,
            messageId: `original-${suffix}`,
            userId: 'original-user',
            reasonKey: 'LINK_BLOCKED:message-delete',
            ruleCode: 'LINK_BLOCKED',
            policySha256: 'a'.repeat(64),
            deadlineAtMs: sourceAtMs + 300_000,
          };
        if (origin.includes('source'))
          context.moderationSource = {
            version: 1,
            chatId: cleanupChat,
            userId: 'original-user',
            messageId: origin.endsWith('conflict') ? 'conflicting-original' : `original-${suffix}`,
          };
        if (origin.includes('followup'))
          context.moderationRuleFollowup = {
            version: 1,
            id: followupId,
            issuedAtMs: sourceAtMs + 500,
          };
      }
      const delay = MANAGED_HANDSHAKE_CONFIRMATION_AUTO_DELETE_DELAY_MS;
      const metadata = {
        createdAt,
        hasText: true,
        textLength: 42,
        autoDeleteDelayMs: delay,
        sendAutoDelete: null,
        hasOptions: true,
        optionKeys: ['buttons'],
        ledgerContext: context,
      };
      const parent = {
        jobId: parentKey,
        chatId: cleanupChat,
        actionType: 'SEND_MESSAGE',
        messageId: null,
        userId: null,
        sourceTag,
        status: 'SUCCEEDED' as const,
        terminal: true,
        ambiguous: false,
        remoteMessageId: `confirmed-${suffix}`,
        dispatchBotId: botId,
        completedAt: new Date(completedAt),
        metadata,
      };
      const historyKeys = Array.from(
        { length: 512 },
        (_, index) => `handshake-history-${suffix}-${index}`,
      );
      const queueName = finiteNotice ? 'max-actions-background' : 'max-actions-interactive';
      const queue = new Queue(queueName, { connection: { url: fixtureRedisUrl } });
      queues.push(queue);
      await queue.pause();
      try {
        // FLAG: The fixture owns these exact rows and an empty disposable queue only.
        // Retained history exercises the unchanged exact-index parent resolver.
        await db.maxActionLedgerEntry.createMany({
          data: [parent, ...historyKeys.map((jobId) => ({ ...parent, jobId }))],
        });
        await db.$executeRaw`ANALYZE max_action_ledger`;
        await queue.add(
          'action',
          {
            actionType: 'DELETE_MESSAGE',
            idempotencyKey: childKey,
            chatId: cleanupChat,
            messageId: parent.remoteMessageId,
            botId,
            sourceTag,
            ...(context ? { ledgerContext: context } : {}),
            sendAutoDelete: {
              version: 2,
              sourceSendJobId: parentKey,
              sourceChatId: cleanupChat,
              sourceMessageId: null,
              sourceUserId: null,
              sourceCreatedAt: createdAt,
              sourceSendCompletedAt: completedAt,
              requestedDelayMs: delay,
              originBotId: botId,
            },
          },
          { jobId: childKey, delay },
        );
        // FLAG: Redis may serialize identical hash fields in a different RDB order.
        // Compare every BullMQ job field and its delayed score, not DUMP encoding bytes.
        const queueBefore = await redis.hgetall(`bull:${queueName}:${childKey}`);
        const delayedScoreBefore = await redis.zscore(`bull:${queueName}:delayed`, childKey);
        expect(Object.keys(queueBefore).length).toBeGreaterThan(0);
        expect(delayedScoreBefore).not.toBeNull();
        const parentBefore = await db.maxActionLedgerEntry.findUniqueOrThrow({
          where: { jobId: parentKey },
        });
        const result = await readonlyDb.$transaction(
          async (tx) => {
            await tx.$executeRaw`SET TRANSACTION READ ONLY`;
            return operation === 'admission_preview'
              ? collectSourceAbandonmentAdmission(tx, redis, {
                  version: 1,
                  operation,
                  sourceSha: liveRequest.binding.sourceSha,
                  imageId: liveRequest.binding.imageId,
                  selection,
                  ...(publisherBotId ? { publisherBotId } : {}),
                })
              : collectSourceAbandonmentLiveEvidence(tx, redis, {
                  ...liveRequest,
                  binding: {
                    ...liveRequest.binding,
                    ...(publisherBotId ? { publisherBotId } : {}),
                  },
                });
          },
          {
            timeout: 30_000,
            isolationLevel:
              operation === 'admission_preview'
                ? Prisma.TransactionIsolationLevel.ReadCommitted
                : Prisma.TransactionIsolationLevel.RepeatableRead,
          },
        );
        const denied =
          origin === 'publisher-missing-catalog' ||
          origin === 'required-subscription-invalid' ||
          origin === 'notice-rule-source-conflict' ||
          origin === 'notice-followup-only';
        expect(result.decision).toBe(
          denied
            ? 'DENY'
            : operation === 'admission_preview'
              ? 'READY_FOR_COLD_REVIEW'
              : 'READY_TO_INSTALL',
        );
        expect(result.issues).toEqual(
          denied
            ? [
                {
                  code: 'CLEANUP_ORIGINAL_SOURCE_UNPROVED',
                  descriptor: `redis:${queueName}`,
                },
              ]
            : [],
        );
        expect(result.selectedOwners).toHaveLength(1);
        expect(result.activationAuthorized).toBe(false);
        expect(result.applied).toBe(false);
        expect(result.selectionSha256).toBe(sourceAbandonmentDigest(selection));
        expect(result.redisCatalogs).toHaveLength(2);
        if ('children' in result) {
          expect(result.children).toEqual([]);
          expect(result.binding.publisherBotId).toBe(publisherBotId);
        }
        expect(
          await db.maxActionLedgerEntry.findUniqueOrThrow({ where: { jobId: parentKey } }),
        ).toEqual(parentBefore);
        expect(await redis.hgetall(`bull:${queueName}:${childKey}`)).toEqual(queueBefore);
        expect(await redis.zscore(`bull:${queueName}:delayed`, childKey)).toBe(delayedScoreBefore);
        expect(await redis.zcard(`bull:${queueName}:delayed`)).toBe(1);
        expect(
          await db.webhookSourceAbandonment.findUnique({ where: { ownerWebhookEventId: ownerId } }),
        ).toBeNull();
      } finally {
        await db.maxActionLedgerEntry.deleteMany({
          where: { jobId: { in: [parentKey, ...historyKeys] } },
        });
      }
    },
  );

  async function actionQueue() {
    const queue = new Queue('max-actions-background', { connection: { url: fixtureRedisUrl } });
    queues.push(queue);
    await queue.pause();
    return queue;
  }

  it('bounds two independent passes of 80 cleanup actions and parents within the unchanged page cap', async () => {
    const suffix = randomUUID();
    const cleanupChat = '-200';
    const createdAt = new Date(Date.now() - 1000).toISOString();
    const completedAt = new Date().toISOString();
    const delay = MANAGED_HANDSHAKE_CONFIRMATION_AUTO_DELETE_DELAY_MS;
    const actions = Array.from({ length: 80 }, (_, index) => ({
      parentKey: buildMaxActionIdempotencyKey('explicit', [
        'SEND_MESSAGE',
        `managed-handshake-start:groupcmd:v1:${suffix}-${index}`,
      ]),
      childKey: `batch-cleanup-${suffix}-${index}`,
      remoteMessageId: `batch-confirmed-${suffix}-${index}`,
    }));
    const historyKeys = Array.from(
      { length: 1024 },
      (_, index) => `batch-history-${suffix}-${index}`,
    );
    const ownedKeys = [
      ...historyKeys,
      ...actions.flatMap(({ parentKey, childKey }) => [parentKey, childKey]),
    ];
    const metadata = {
      createdAt,
      hasText: true,
      textLength: 42,
      autoDeleteDelayMs: delay,
      sendAutoDelete: null,
      hasOptions: true,
      optionKeys: ['buttons'],
      ledgerContext: null,
    };
    const queue = await actionQueue();
    try {
      // FLAG: This disposable retained-history/skew fixture requires every action
      // and completed parent on both fresh passes. Point lookups alone cost 640
      // pages before headers/source proof, exceeding the unchanged 512-page cap.
      await db.maxActionLedgerEntry.createMany({
        data: [
          ...actions.map(({ parentKey, remoteMessageId }) => ({
            jobId: parentKey,
            chatId: cleanupChat,
            actionType: 'SEND_MESSAGE',
            messageId: null,
            userId: null,
            sourceTag: 'managed_handshake',
            status: 'SUCCEEDED' as const,
            terminal: true,
            ambiguous: false,
            remoteMessageId,
            dispatchBotId: 'major-1',
            completedAt: new Date(completedAt),
            metadata,
          })),
          ...actions.map(({ childKey, remoteMessageId }) => ({
            jobId: childKey,
            chatId: cleanupChat,
            actionType: 'DELETE_MESSAGE',
            messageId: remoteMessageId,
            status: 'ENQUEUED' as const,
          })),
          ...historyKeys.map((jobId) => ({
            jobId,
            chatId: cleanupChat,
            actionType: 'SEND_MESSAGE',
            status: 'SUCCEEDED' as const,
            terminal: true,
          })),
        ] satisfies Prisma.MaxActionLedgerEntryCreateManyInput[],
      });
      await db.$executeRaw`ANALYZE max_action_ledger`;
      await queue.addBulk(
        actions.map(({ parentKey, childKey, remoteMessageId }) => ({
          name: 'action',
          data: {
            actionType: 'DELETE_MESSAGE',
            idempotencyKey: childKey,
            chatId: cleanupChat,
            messageId: remoteMessageId,
            botId: 'major-1',
            sourceTag: 'managed_handshake',
            sendAutoDelete: {
              version: 2,
              sourceSendJobId: parentKey,
              sourceChatId: cleanupChat,
              sourceMessageId: null,
              sourceUserId: null,
              sourceCreatedAt: createdAt,
              sourceSendCompletedAt: completedAt,
              requestedDelayMs: delay,
              originBotId: 'major-1',
            },
          },
          opts: { jobId: childKey, delay },
        })),
      );
      const result = await readonlyDb.$transaction(
        async (tx) => {
          await tx.$executeRaw`SET TRANSACTION READ ONLY`;
          return collectSourceAbandonmentAdmission(tx, redis, {
            version: 1,
            operation: 'admission_preview',
            sourceSha: liveRequest.binding.sourceSha,
            imageId: liveRequest.binding.imageId,
            selection,
          });
        },
        { timeout: 50_000, isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
      );
      expect(result.issues).toEqual([]);
      expect(result.decision).toBe('READY_FOR_COLD_REVIEW');
      expect(result.selectedOwners).toHaveLength(1);
      expect(result.redisCatalogs).toHaveLength(2);
      expect(result.redisCatalogs.every((catalog) => catalog.complete && !catalog.issue)).toBe(
        true,
      );
      const plans = result.sqlPlans.filter((plan) => plan.descriptor === 'sql:max_action_ledger');
      expect(plans).toHaveLength(20);
      expect(plans.every((plan) => plan.indexes.includes('max_action_ledger_job_id_key'))).toBe(
        true,
      );
      expect(result.cost.pages).toBeLessThan(256);
      expect(result.activationAuthorized).toBe(false);
      expect(result.stoppingAuthorized).toBe(false);
      expect(result.applied).toBe(false);
      expect(await redis.zcard('bull:max-actions-background:delayed')).toBe(actions.length);
      expect(await db.maxActionLedgerEntry.count({ where: { jobId: { in: ownedKeys } } })).toBe(
        ownedKeys.length,
      );
      expect(
        await db.webhookSourceAbandonment.findUnique({ where: { ownerWebhookEventId: ownerId } }),
      ).toBeNull();
    } finally {
      await db.maxActionLedgerEntry.deleteMany({ where: { jobId: { in: ownedKeys } } });
    }
  });

  function resolverAllowance(overrides: Partial<sourceSql.SourceInventoryAllowance> = {}) {
    return {
      pages: 512,
      rows: 10_000,
      probes: 50_000,
      bytes: 8 * 1024 * 1024,
      deadlineAtMs: Date.now() + 30_000,
      ...overrides,
    } satisfies sourceSql.SourceInventoryAllowance;
  }

  async function prepareResolverTransaction(tx: Prisma.TransactionClient) {
    // FLAG: The real collector and store set these transaction preferences before
    // calling the resolver. Reproduce that caller context for direct batch reads;
    // retained history and strict EXPLAIN identity/scan guards remain required.
    await tx.$executeRaw`SET LOCAL enable_seqscan = off`;
    await tx.$executeRaw`SET LOCAL enable_bitmapscan = off`;
  }

  it.each(['action', 'observation'] as const)(
    'resolves fresh bounded %s batches with exact missing and Date evidence',
    async (kind) => {
      const suffix = randomUUID();
      const keys = Array.from({ length: 16 }, (_, index) => `batch-${suffix}-${index}`);
      const completedAt = new Date('2026-01-02T03:04:05.000Z');
      const actionData = (jobId: string) => ({
        jobId,
        chatId,
        actionType: 'SEND_MESSAGE',
        status: 'SUCCEEDED' as const,
        completedAt,
      });
      const observationData = (id: string) => ({
        id,
        chatId,
        userId: `batch-user-${suffix}`,
        source: 'FANOUT_HIGH',
        score: 1,
        reason: 'Native batch source proof',
        evidenceHash: id,
        expiresAt: new Date(Date.now() + 60_000),
        observedAt: completedAt,
      });
      if (kind === 'action') {
        await db.maxActionLedgerEntry.createMany({
          data: [
            keys[0]!,
            keys[1]!,
            ...Array.from({ length: 512 }, (_, index) => `skew-${suffix}-${index}`),
          ].map(actionData),
        });
        await db.$executeRaw`ANALYZE max_action_ledger`;
      } else {
        await db.spammerObservation.createMany({ data: keys.slice(0, 2).map(observationData) });
        await db.$executeRaw`ANALYZE spammer_observations`;
      }
      const expected =
        kind === 'action'
          ? await db.maxActionLedgerEntry.findUniqueOrThrow({ where: { jobId: keys[0] } })
          : await db.spammerObservation.findUniqueOrThrow({ where: { id: keys[0] } });
      await readonlyDb.$transaction(
        async (tx) => {
          await tx.$executeRaw`SET TRANSACTION READ ONLY`;
          await prepareResolverTransaction(tx);
          const resolveRows = sourceSql.sourceAbandonmentSqlResolver(tx);
          const first = await resolveRows(kind, keys, resolverAllowance());
          expect(first.issue).toBeNull();
          expect(first.rows.map((row) => row.key)).toEqual(keys);
          expect(first.rows[0]).toEqual({
            key: keys[0],
            row: expected,
            digest: sourceAbandonmentDigest([expected]),
          });
          expect(
            first.rows
              .slice(2)
              .every((row) => row.row === null && row.digest === sourceAbandonmentDigest([])),
          ).toBe(true);
          expect(
            first.rows[0]!.row![kind === 'action' ? 'completedAt' : 'observedAt'],
          ).toBeInstanceOf(Date);
          expect(first.cost.pages).toBe(2);
          expect(first.cost.rows).toBe(18);
          expect(first.plans).toHaveLength(1);
          expect(first.plans[0]!.indexes).toContain(
            kind === 'action' ? 'max_action_ledger_job_id_key' : 'spammer_observations_pkey',
          );
          expect(first.plans[0]!.examinedRows).toBe(32);

          // FLAG: Commit mutations on a separate connection between fresh calls
          // through the same resolver. A missing row and a deleted/updated parent
          // must never survive as cached READ COMMITTED evidence.
          if (kind === 'action') {
            await db.maxActionLedgerEntry.update({
              where: { jobId: keys[0] },
              data: { status: 'FAILED_TERMINAL' },
            });
            await db.maxActionLedgerEntry.delete({ where: { jobId: keys[1] } });
            await db.maxActionLedgerEntry.create({ data: actionData(keys[2]!) });
          } else {
            await db.spammerObservation.update({
              where: { id: keys[0] },
              data: { reason: 'Changed committed proof' },
            });
            await db.spammerObservation.delete({ where: { id: keys[1] } });
            await db.spammerObservation.create({ data: observationData(keys[2]!) });
          }
          const second = await resolveRows(kind, keys, resolverAllowance());
          expect(second.issue).toBeNull();
          expect(second.rows[0]!.digest).not.toBe(first.rows[0]!.digest);
          expect(second.rows[1]).toEqual({
            key: keys[1],
            row: null,
            digest: sourceAbandonmentDigest([]),
          });
          expect(second.rows[2]!.row).not.toBeNull();
          expect(second.cost.pages).toBe(2);
          expect(second.plans).toHaveLength(1);
        },
        { timeout: 30_000, isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
      );
    },
  );

  it('suppresses a whole oversized batch before transferring individually bounded row payloads', async () => {
    const suffix = randomUUID();
    const keys = [`batch-large-${suffix}-0`, `batch-large-${suffix}-1`];
    await db.maxActionLedgerEntry.createMany({
      data: [
        ...keys.map((jobId) => ({
          jobId,
          chatId,
          actionType: 'SEND_MESSAGE',
          metadata: { fixture: 'x'.repeat(280_000) },
        })),
        ...Array.from({ length: 512 }, (_, index) => ({
          jobId: `batch-large-history-${suffix}-${index}`,
          chatId,
          actionType: 'SEND_MESSAGE',
        })),
      ],
    });
    await db.$executeRaw`ANALYZE max_action_ledger`;
    await db.$transaction(async (tx) => {
      await prepareResolverTransaction(tx);
      const resolveRows = sourceSql.sourceAbandonmentSqlResolver(tx);
      for (const key of keys) {
        const single = await resolveRows('action', [key], resolverAllowance());
        expect(single.issue).toBeNull();
        expect(single.rows[0]!.row).not.toBeNull();
      }
      const combined = await resolveRows('action', keys, resolverAllowance());
      expect(combined.rows).toEqual([]);
      expect(combined.issue).toEqual({
        code: 'sql_page_saturated_or_oversize',
        descriptor: 'sql:max_action_ledger',
      });
      expect(combined.cost.pages).toBe(2);
      expect(combined.cost.bytes).toBeLessThan(64 * 1024);
      expect(combined.plans).toHaveLength(1);
    });
  });

  it('refuses malformed batches and exhausted pre-query limits without SQL reads', async () => {
    await db.$transaction(async (tx) => {
      const query = jest.spyOn(tx, '$queryRaw');
      try {
        const resolveRows = sourceSql.sourceAbandonmentSqlResolver(tx);
        const malformed: unknown[] = [
          [],
          ['same', 'same'],
          Array.from({ length: 17 }, (_, index) => `key-${index}`),
          [''],
          [' surrounding '],
          ['line\nbreak'],
          ['x'.repeat(513)],
          [null],
          null,
        ];
        for (const keys of malformed) {
          const result = await resolveRows(
            'action',
            keys as readonly string[],
            resolverAllowance(),
          );
          expect(result).toEqual({
            rows: [],
            cost: { pages: 0, rows: 0, probes: 0, bytes: 0 },
            plans: [],
            issue: { code: 'sql_batch_request_invalid', descriptor: 'sql:resolver' },
          });
        }
        expect(
          (await resolveRows('unknown' as 'action', ['key'], resolverAllowance())).issue,
        ).toEqual({ code: 'sql_batch_request_invalid', descriptor: 'sql:resolver' });
        for (const allowance of [
          { pages: 1 },
          { probes: 1 },
          { rows: 2 },
          { bytes: 64 * 1024 },
          { deadlineAtMs: Date.now() - 1 },
        ]) {
          const result = await resolveRows('action', ['key'], resolverAllowance(allowance));
          expect(result.rows).toEqual([]);
          expect(result.cost).toEqual({ pages: 0, rows: 0, probes: 0, bytes: 0 });
          expect(result.plans).toEqual([]);
          expect(result.issue).toEqual({
            code: 'deadlineAtMs' in allowance ? 'sql_deadline_exceeded' : 'sql_budget_exceeded',
            descriptor: 'sql:max_action_ledger',
          });
        }
        expect(query).not.toHaveBeenCalled();
      } finally {
        query.mockRestore();
      }
    });
  });

  it('retains completed batch SQL cost when plans, cardinality or row envelopes are refused', async () => {
    const key = `batch-refusal-${randomUUID()}`;
    await db.maxActionLedgerEntry.createMany({
      data: [key, ...Array.from({ length: 512 }, (_, index) => `${key}-history-${index}`)].map(
        (jobId) => ({ jobId, chatId, actionType: 'SEND_MESSAGE' }),
      ),
    });
    await db.$executeRaw`ANALYZE max_action_ledger`;
    await db.$transaction(async (tx) => {
      await prepareResolverTransaction(tx);
      const query = jest.spyOn(tx, '$queryRaw');
      try {
        const resolveRows = sourceSql.sourceAbandonmentSqlResolver(tx);
        const first = await resolveRows('action', [key], resolverAllowance());
        expect(first.issue).toBeNull();
        const plan = await query.mock.results[0]!.value;
        const raw = (await query.mock.results[1]!.value) as Array<{
          ordinal: number;
          key: string;
          count: number;
          bytes: number;
          rows: Record<string, unknown>[];
        }>;
        const page = raw[0]!;
        const cases = [
          { rows: [], code: 'sql_batch_identity_unproved' },
          { rows: [{ ...page, key: 'unrequested-key' }], code: 'sql_batch_identity_unproved' },
          { rows: [{ ...page, ordinal: 1 }], code: 'sql_batch_identity_unproved' },
          {
            rows: [{ ...page, count: 2, rows: [page.rows[0], page.rows[0]] }],
            code: 'sql_page_saturated_or_oversize',
          },
          {
            rows: [{ ...page, bytes: 524289, rows: null }],
            code: 'sql_page_saturated_or_oversize',
          },
          {
            rows: [{ ...page, rows: [{ ...page.rows[0], job_id: 'wrong-row-key' }] }],
            code: 'sql_batch_identity_unproved',
          },
        ];
        for (const refused of cases) {
          query.mockResolvedValueOnce(plan).mockResolvedValueOnce(refused.rows);
          const result = await resolveRows('action', [key], resolverAllowance());
          expect(result.rows).toEqual([]);
          expect(result.issue).toEqual({ code: refused.code, descriptor: 'sql:max_action_ledger' });
          expect(result.cost.pages).toBe(2);
          expect(result.cost.probes).toBe(2);
          expect(result.cost.bytes).toBeGreaterThan(0);
          expect(result.plans).toHaveLength(1);
        }
        for (const rejectedPlan of [
          { 'Node Type': 'Seq Scan', 'Relation Name': 'max_action_ledger' },
          {
            'Node Type': 'Bitmap Heap Scan',
            'Relation Name': 'max_action_ledger',
            Plans: [
              { 'Node Type': 'Bitmap Index Scan', 'Index Name': 'max_action_ledger_job_id_key' },
            ],
          },
        ]) {
          query.mockResolvedValueOnce([{ 'QUERY PLAN': [{ Plan: rejectedPlan }] }]);
          const beforePlanRefusal = query.mock.calls.length;
          const refused = await resolveRows('action', [key], resolverAllowance());
          expect(refused.rows).toEqual([]);
          expect(refused.issue).toEqual({
            code: 'sql_residual_work_unproved',
            descriptor: 'sql:max_action_ledger',
          });
          expect(refused.cost.pages).toBe(1);
          expect(refused.cost.probes).toBe(1);
          expect(refused.plans).toEqual([]);
          expect(query.mock.calls.length - beforePlanRefusal).toBe(1);
        }
      } finally {
        query.mockRestore();
      }
    });
  });

  async function storeFixture(observed?: SourceAbandonmentLiveOutput) {
    const output = observed ?? (await collect());
    expect(output.issues).toEqual([]);
    expect(output.decision).toBe('READY_TO_INSTALL');
    expect(output.redisEvidenceSha256).toMatch(/^[a-f0-9]{64}$/u);
    const inventorySha256 = buildSourceAbandonmentInventoryDigest(output);
    const bytes = Buffer.from(JSON.stringify({ ...output, inventorySha256 }));
    const request = parseSourceAbandonmentStoreRequest(
      JSON.stringify({
        version: 1,
        operation: 'certificate_create',
        certificateId: randomUUID(),
        binding: liveRequest.binding,
        selection,
        expected: {
          inventorySha256,
          inventoryArtifactSha256: createHash('sha256').update(bytes).digest('hex'),
          previewSha256: output.previewSha256,
        },
      }),
    );
    return { request, bytes };
  }

  const publisherBotId = 'fixture-source-publisher';
  async function publisherReceipt(keepRaw = true, botId = publisherBotId) {
    const owner = await db.webhookEvent.findUniqueOrThrow({ where: { id: ownerId } });
    const update = new WebhookParser().parse(
      (owner.normalizedPayload as { raw: Record<string, unknown> }).raw,
      { botId },
    );
    const receipt = await db.webhookEvent.create({
      data: {
        botId,
        dedupKey: randomUUID(),
        semanticKey: buildWebhookReceiptSemanticKey(update, publisherBotId),
        rawPayload: keepRaw ? (update.raw as Prisma.InputJsonValue) : {},
        normalizedPayload: JSON.parse(JSON.stringify(update)),
        status: 'RECEIVED',
      },
    });
    publisherReceiptIds.push(receipt.id);
    return receipt;
  }

  it.each([
    ['CHAT', true],
    ['CHAT', false],
    ['CHANNEL', true],
    ['CHANNEL', false],
  ] as const)(
    'proves separate Publisher and moderation receipts through %s inventory, store and late materialization (raw sample: %s)',
    async (entityType, keepRaw) => {
      if (entityType === 'CHANNEL') {
        const owner = await db.webhookEvent.findUniqueOrThrow({ where: { id: ownerId } });
        const raw = JSON.parse(JSON.stringify(owner.rawPayload));
        delete raw.message.sender;
        raw.message.recipient.chat_type = 'channel';
        const update = new WebhookParser().parse(raw, { botId: owner.botId! });
        await db.webhookEvent.update({
          where: { id: ownerId },
          data: { rawPayload: raw, normalizedPayload: JSON.parse(JSON.stringify(update)) },
        });
        await db.chat.update({ where: { id: chatId }, data: { entityType } });
        // FLAG: Preserve the stock exact-index guard with representative same-chat
        // retained marker history, as in the existing channel store fixtures.
        await db.channelAutoPostAttachMarker.createMany({
          data: Array.from({ length: 512 }, (_, index) => ({
            chatId,
            messageId: `marker-history-${ownerId}-${index}`,
            source: 'poll',
            status: 'SKIPPED' as const,
          })),
        });
        await db.$executeRaw`ANALYZE channel_auto_post_attach_markers`;
      }
      // FLAG: Initial channel owners retain the original under the immutable SQL
      // seal guard. Unsampled initial/late mirrors exercise the ingress contract.
      if (!keepRaw && entityType === 'CHAT')
        await db.webhookEvent.update({ where: { id: ownerId }, data: { rawPayload: {} } });
      const receipt = await publisherReceipt(keepRaw);
      const mirror = await publisherReceipt(keepRaw, 'major-1');
      const owner = await db.webhookEvent.findUniqueOrThrow({ where: { id: ownerId } });
      const claims = await db.webhookExecutionClaim.findMany({
        where: { webhookEventId: ownerId },
      });
      expect(receipt.semanticKey).not.toBe(owner.semanticKey);
      expect((await collect()).decision).toBe('DENY');
      liveRequest = { ...liveRequest, binding: { ...liveRequest.binding, publisherBotId } };
      const admission = await db.$transaction(
        (tx) =>
          collectSourceAbandonmentAdmission(tx, redis, {
            version: 1,
            operation: 'admission_preview',
            selection,
            publisherBotId,
            sourceSha: liveRequest.binding.sourceSha,
            imageId: liveRequest.binding.imageId,
          }),
        { timeout: 30_000 },
      );
      expect(admission.issues).toEqual([]);
      expect(admission.decision).toBe('READY_FOR_COLD_REVIEW');
      const { request, bytes } = await storeFixture();
      await executeSourceAbandonmentStore(db, request, bytes);
      expect(
        await executeSourceAbandonmentStore(db, { ...request, operation: 'install' }, bytes),
      ).toMatchObject({ state: 'SEALED', completeChats: 0, requiredChats: 1 });
      expect(
        await executeSourceAbandonmentStore(
          db,
          {
            ...request,
            operation: 'materialize',
            page: { chatId, pageSize: 10 },
          },
          bytes,
        ),
      ).toMatchObject({ page: { complete: true, applied: 2, blocked: false } });
      expect(
        await executeSourceAbandonmentStore(
          readonlyDb,
          { ...request, operation: 'readback' },
          bytes,
        ),
      ).toMatchObject({ state: 'MATERIALIZED', completeChats: 1, requiredChats: 1 });
      const late = await publisherReceipt(keepRaw);
      const lateMirror = await publisherReceipt(keepRaw, 'major-1');
      expect(await db.$transaction((tx) => materializeSourceAbandonmentReceipt(tx, late.id))).toBe(
        'APPLIED_WITH_PROOF',
      );
      expect(
        await db.$transaction((tx) => materializeSourceAbandonmentReceipt(tx, lateMirror.id)),
      ).toBe('APPLIED_WITH_PROOF');
      for (const before of [receipt, mirror, late, lateMirror]) {
        expect(await db.webhookEvent.findUniqueOrThrow({ where: { id: before.id } })).toEqual({
          ...before,
          status: 'NO_REPLAY_HELD',
          sourceDispositionId: expect.any(String),
          sourceDispositionReceiptId: before.id,
        });
      }
      expect(await db.webhookEvent.findUniqueOrThrow({ where: { id: ownerId } })).toEqual({
        ...owner,
        sourceDispositionId: expect.any(String),
        sourceDispositionReceiptId: ownerId,
      });
      expect(
        await db.webhookExecutionClaim.findMany({ where: { webhookEventId: ownerId } }),
      ).toEqual(claims);
      expect(
        await db.webhookExecutionClaim.count({
          where: { webhookEventId: { in: [receipt.id, late.id] } },
        }),
      ).toBe(0);
    },
  );

  it.each([
    'null-key',
    'shared-key',
    'wrong-prefix',
    'wrong-bot',
    'wrong-catalog',
    'different-source',
  ])('refuses Publisher %s without rewriting the receipt or canonical claim', async (fault) => {
    const receipt = await publisherReceipt();
    const owner = await db.webhookEvent.findUniqueOrThrow({ where: { id: ownerId } });
    if (fault === 'null-key' || fault === 'shared-key' || fault === 'wrong-prefix')
      await db.webhookEvent.update({
        where: { id: receipt.id },
        data: {
          semanticKey:
            fault === 'null-key'
              ? null
              : fault === 'shared-key'
                ? owner.semanticKey
                : `publisher-observation:v1:other-publisher:${owner.semanticKey}`,
        },
      });
    if (fault === 'wrong-bot')
      await db.webhookEvent.update({
        where: { id: receipt.id },
        data: { botId: 'other-publisher' },
      });
    if (fault === 'different-source') {
      const raw = JSON.parse(JSON.stringify(receipt.rawPayload));
      raw.message.timestamp += 1;
      const update = new WebhookParser().parse(raw, { botId: publisherBotId });
      await db.webhookEvent.update({
        where: { id: receipt.id },
        data: {
          rawPayload: raw,
          normalizedPayload: JSON.parse(JSON.stringify(update)),
        },
      });
    }
    const before = await db.webhookEvent.findUniqueOrThrow({ where: { id: receipt.id } });
    const candidate = await inspectSourceAbandonmentCandidate(db, ownerId, {
      majorBotIds: selection.majorBotIds,
      abandonBefore: new Date(selection.abandonBefore),
    });
    expect(candidate).not.toBeNull();
    const reasons: string[] = [];
    expect(
      await inspectSourceAbandonmentReceiptCandidate(
        db,
        receipt.id,
        candidate!,
        (reason) => reasons.push(reason),
        fault === 'wrong-catalog' ? 'other-publisher' : publisherBotId,
      ),
    ).toBeNull();
    expect(reasons).toContain('source_receipt_provenance_unproved');
    expect(await db.webhookEvent.findUniqueOrThrow({ where: { id: receipt.id } })).toEqual(before);
    expect(await db.webhookExecutionClaim.findMany({ where: { webhookEventId: ownerId } })).toEqual(
      [candidate!.claim],
    );
  });

  it.each(['publisher-key', 'canonical-key', 'linked-event', 'command'])(
    'retains every independent Publisher %s claim fence',
    async (scope) => {
      const receipt = await publisherReceipt();
      const candidate = await inspectSourceAbandonmentCandidate(db, ownerId, {
        majorBotIds: selection.majorBotIds,
        abandonBefore: new Date(selection.abandonBefore),
      });
      expect(candidate).not.toBeNull();
      const alias = await db.webhookExecutionClaim.create({
        data: {
          kind: scope === 'command' ? 'COMMAND' : 'NATIVE_PUBLISHER_UNKNOWN',
          semanticKey:
            scope === 'publisher-key'
              ? receipt.semanticKey!
              : scope === 'canonical-key'
                ? candidate!.claim.semanticKey
                : scope === 'command'
                  ? buildGroupCommandKey(candidate!.source.chatId, candidate!.source.messageId)
                  : randomUUID(),
          webhookEventId: scope === 'linked-event' ? receipt.id : ownerId,
        },
      });
      try {
        const reasons: string[] = [];
        expect(
          await inspectSourceAbandonmentReceiptCandidate(
            db,
            receipt.id,
            candidate!,
            (reason) => reasons.push(reason),
            publisherBotId,
          ),
        ).toBeNull();
        expect(reasons).toContain('source_receipt_independent_claim');
        expect(
          await db.webhookExecutionClaim.findUniqueOrThrow({ where: { id: alias.id } }),
        ).toEqual(alias);
        expect(await db.webhookEvent.findUniqueOrThrow({ where: { id: receipt.id } })).toEqual(
          receipt,
        );
      } finally {
        await db.webhookExecutionClaim.delete({ where: { id: alias.id } });
      }
    },
  );

  it('does not infer Publisher authority for a late receipt from an older certificate', async () => {
    const { request, bytes } = await storeFixture();
    await executeSourceAbandonmentStore(db, request, bytes);
    await executeSourceAbandonmentStore(db, { ...request, operation: 'install' }, bytes);
    const late = await publisherReceipt();
    expect(await db.$transaction((tx) => materializeSourceAbandonmentReceipt(tx, late.id))).toBe(
      'BLOCKED_UNKNOWN',
    );
    expect(await db.webhookEvent.findUniqueOrThrow({ where: { id: late.id } })).toEqual(late);
  });

  it('rechecks an absent independent Publisher alias after a concurrent detached claim appears', async () => {
    const receipt = await publisherReceipt();
    const kind = 'NATIVE_PUBLISHER_DETACHED';
    const ids: string[] = [];
    try {
      ids.push(
        (
          await db.webhookExecutionClaim.create({
            data: {
              kind,
              semanticKey: randomUUID(),
              webhookEventId: historyWebhookIds[0]!,
            },
          })
        ).id,
      );
      await db.$transaction(
        async (tx) => {
          const meter = await candidateMeter(tx);
          const reader = meter.candidateReader();
          const candidate = await inspectSourceAbandonmentCandidate(reader, ownerId, {
            majorBotIds: selection.majorBotIds,
            abandonBefore: new Date(selection.abandonBefore),
          });
          expect(candidate).not.toBeNull();
          for (let pass = 0; pass < 2; pass++)
            expect(
              await inspectSourceAbandonmentReceiptCandidate(
                reader,
                receipt.id,
                candidate!,
                undefined,
                publisherBotId,
              ),
            ).not.toBeNull();
          ids.push(
            (
              await db.webhookExecutionClaim.create({
                data: {
                  kind,
                  semanticKey: receipt.semanticKey!,
                  webhookEventId: historyWebhookIds[0]!,
                },
              })
            ).id,
          );
          await expect(meter.verifyCandidateReads()).rejects.toMatchObject({
            code: 'sql_candidate_proof_changed',
          });
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, timeout: 30_000 },
      );
    } finally {
      await db.webhookExecutionClaim.deleteMany({ where: { id: { in: ids } } });
    }
  });

  it.each(['publisher', 'catalog', 'source', 'image', 'cutoff'] as const)(
    'rejects inconsistent sealed Publisher %s provenance even with a matching attestation digest',
    async (fault) => {
      liveRequest = { ...liveRequest, binding: { ...liveRequest.binding, publisherBotId } };
      const { request, bytes } = await storeFixture();
      await executeSourceAbandonmentStore(db, request, bytes);
      await executeSourceAbandonmentStore(db, { ...request, operation: 'install' }, bytes);
      const late = await publisherReceipt();
      const reasons: string[] = [];
      // FLAG: Database immutability prevents editing real certificates. Substitute
      // only this read result to prove semantic binding checks beyond its digest;
      // all receipt/owner/claim reads and transaction behavior remain native.
      const result = await db.$transaction(async (tx) => {
        const guarded = new Proxy(tx, {
          get(target, key) {
            if (key !== 'webhookSourceAbandonment') return Reflect.get(target, key);
            return {
              findUnique: async (
                args: Parameters<typeof tx.webhookSourceAbandonment.findUnique>[0],
              ) => {
                const row = await tx.webhookSourceAbandonment.findUnique({
                  ...args,
                  include: { certificate: true },
                });
                if (!row) return row;
                const attestation = JSON.parse(JSON.stringify(row.certificate.attestation));
                if (fault === 'publisher') attestation.binding.publisherBotId = 'invalid publisher';
                if (fault === 'catalog') attestation.selection.majorBotIds.push(publisherBotId);
                if (fault === 'source') attestation.binding.sourceSha = 'c'.repeat(40);
                if (fault === 'image') attestation.binding.imageId = `sha256:${'d'.repeat(64)}`;
                if (fault === 'cutoff')
                  attestation.selection.abandonBefore = '2026-10-01T00:00:00.000Z';
                return {
                  ...row,
                  certificate: {
                    ...row.certificate,
                    attestation,
                    attestationDigest: sourceAbandonmentDigest(attestation),
                  },
                };
              },
            };
          },
        });
        return materializeSourceAbandonmentReceipt(guarded, late.id, {
          onRefusal: (reason) => reasons.push(reason),
        });
      });
      expect(result).toBe('BLOCKED_UNKNOWN');
      expect(reasons).toContain('source_receipt_publisher_unproved');
      expect(await db.webhookEvent.findUniqueOrThrow({ where: { id: late.id } })).toEqual(late);
    },
  );

  it('inspects the actual indexed source family without rewriting started evidence', async () => {
    const before = await db.webhookEvent.findUniqueOrThrow({ where: { id: ownerId } });
    const claims = await db.webhookExecutionClaim.findMany({ where: { webhookEventId: ownerId } });
    const result = await inventory();
    expect(result.issues).toEqual([]);
    expect(result.candidates).toHaveLength(1);
    expect(result.selectedOwners).toHaveLength(1);
    expect(result.children).toEqual([]);
    expect(result.plans.length).toBeGreaterThan(0);
    expect(result.plans.flatMap((plan) => plan.indexes)).toContain(
      'webhook_events_source_family_pending_idx',
    );
    expect(
      result.plans
        .filter((plan) => plan.descriptor === 'sql:webhook_execution_claims')
        .flatMap((plan) => plan.indexes),
    ).toEqual(
      expect.arrayContaining([
        'webhook_execution_claims_event_kind_idx',
        'webhook_execution_claims_kind_semantic_key',
      ]),
    );
    expect(await db.webhookEvent.findUniqueOrThrow({ where: { id: ownerId } })).toEqual(before);
    expect(await db.webhookExecutionClaim.findMany({ where: { webhookEventId: ownerId } })).toEqual(
      claims,
    );
  });

  it('retains a source-less historical ambiguous member ledger without claiming its attribution', async () => {
    const ledger = await db.maxActionLedgerEntry.create({
      data: {
        jobId: `old-unknown-member-${randomUUID()}`,
        chatId,
        userId: 'fixture-source-user',
        actionType: 'BAN_MEMBER',
        status: 'AMBIGUOUS',
        ambiguous: true,
        attemptCount: 1,
        dispatchStartedAt: new Date(),
      },
    });
    const result = await inventory();
    expect(result.issues).toEqual([]);
    expect(result.children).toEqual([]);
    expect(await db.maxActionLedgerEntry.findUniqueOrThrow({ where: { id: ledger.id } })).toEqual(
      ledger,
    );
  });

  it.each(['audio', 'sticker'] as const)(
    'reports strict forwarded %s through native admission without changing uncertainty or source authority',
    async (kind) => {
      const original = await db.webhookEvent.findUniqueOrThrow({ where: { id: ownerId } });
      const raw = structuredClone(original.rawPayload) as Record<string, unknown>;
      const message = raw.message as Record<string, unknown>;
      message.link = {
        type: 'forward',
        chat_id: '-independent-linked-chat',
        sender: { user_id: 'independent-linked-author', is_bot: false },
        message: {
          mid: 'independent-linked-message',
          text: '',
          attachments: [
            kind === 'audio'
              ? {
                  type: 'audio',
                  payload: { url: 'https://example.com/audio', token: 'opaque-audio', id: 42 },
                }
              : {
                  type: 'sticker',
                  payload: { url: 'https://example.com/sticker', code: 'opaque-sticker' },
                  width: 256,
                  height: 256,
                },
          ],
        },
      };
      const update = new WebhookParser().parse(raw, { botId: original.botId! });
      expect(buildWebhookSemanticEventKey(update)).toBe(original.semanticKey);
      const before = await db.webhookEvent.update({
        where: { id: ownerId },
        data: {
          rawPayload: raw as Prisma.InputJsonValue,
          normalizedPayload: JSON.parse(JSON.stringify(update)),
        },
      });
      const claims = await db.webhookExecutionClaim.findMany({
        where: { webhookEventId: ownerId },
      });
      const redisKeys = await redis.dbsize();
      const admission = await db.$transaction(
        (tx) =>
          collectSourceAbandonmentAdmission(tx, redis, {
            version: 1,
            operation: 'admission_preview',
            selection,
            publisherBotId,
            sourceSha: liveRequest.binding.sourceSha,
            imageId: liveRequest.binding.imageId,
          }),
        { timeout: 30_000 },
      );
      expect(admission).toMatchObject({
        decision: 'DENY',
        sourceCoverageComplete: false,
        applied: false,
        activationAuthorized: false,
        stoppingAuthorized: false,
        selectedOwners: [],
      });
      expect(admission.issues).toEqual(
        expect.arrayContaining([
          { code: `source_forward_linked_media_${kind}_strict`, descriptor: 'sql:selected-source' },
          { code: 'source_content_unproved', descriptor: 'sql:selected-source' },
          { code: 'selected_owner_proof_incomplete', descriptor: 'sql:selected-source' },
        ]),
      );
      expect(await db.webhookEvent.findUniqueOrThrow({ where: { id: ownerId } })).toEqual(before);
      expect(
        await db.webhookExecutionClaim.findMany({ where: { webhookEventId: ownerId } }),
      ).toEqual(claims);
      expect(
        await db.webhookSourceAbandonment.count({ where: { ownerWebhookEventId: ownerId } }),
      ).toBe(0);
      expect(await redis.dbsize()).toBe(redisKeys);
    },
  );

  it.each([false, true])(
    'installs once and reconciles immutable source proofs through a read-only SQL connection (forward=%s)',
    async (forward) => {
      if (forward) {
        const owner = await db.webhookEvent.findUniqueOrThrow({ where: { id: ownerId } });
        const raw = structuredClone(owner.rawPayload) as Record<string, unknown>;
        const message = raw.message as Record<string, unknown>;
        message.link = {
          type: 'forward',
          chat_id: '-independent-linked-chat',
          sender: { user_id: 'independent-linked-author', is_bot: false },
          message: {
            mid: 'independent-linked-message',
            text: 'A strict flat forwarded photo caption',
            attachments: [
              {
                type: 'image',
                payload: { photo_id: 41, url: 'https://i.oneme.ru/native-forward-one' },
              },
              {
                type: 'image',
                payload: { photo_id: 42, url: 'https://i.oneme.ru/native-forward-two' },
              },
            ],
          },
        };
        const update = new WebhookParser().parse(raw, { botId: owner.botId! });
        await db.webhookEvent.update({
          where: { id: ownerId },
          data: {
            rawPayload: raw as Prisma.InputJsonValue,
            normalizedPayload: JSON.parse(JSON.stringify(update)),
          },
        });
      }
      const before = await db.webhookEvent.findUniqueOrThrow({ where: { id: ownerId } });
      const claims = await db.webhookExecutionClaim.findMany({
        where: { webhookEventId: ownerId },
      });
      const { request, bytes } = await storeFixture();
      expect(await executeSourceAbandonmentStore(db, request, bytes)).toMatchObject({
        state: 'UNSEALED',
        activationAuthorized: false,
      });
      expect(
        await executeSourceAbandonmentStore(
          readonlyDb,
          { ...request, operation: 'readback' },
          bytes,
        ),
      ).toMatchObject({ state: 'UNSEALED' });
      expect(
        await executeSourceAbandonmentStore(db, { ...request, operation: 'install' }, bytes),
      ).toMatchObject({
        state: 'MATERIALIZED',
        completeChats: 1,
        requiredChats: 1,
        activationAuthorized: false,
      });
      expect(
        await executeSourceAbandonmentStore(
          readonlyDb,
          { ...request, operation: 'readback' },
          bytes,
        ),
      ).toMatchObject({
        state: 'MATERIALIZED',
        completeChats: 1,
        requiredChats: 1,
      });
      expect(await db.webhookEvent.findUniqueOrThrow({ where: { id: ownerId } })).toEqual({
        ...before,
        sourceDispositionId: expect.any(String),
        sourceDispositionReceiptId: ownerId,
      });
      expect(
        await db.webhookExecutionClaim.findMany({ where: { webhookEventId: ownerId } }),
      ).toEqual(claims);
      expect(await db.webhookLegacyRecovery.count({ where: { chatId } })).toBe(0);
      expect(
        await db.webhookSourceAbandonment.findFirstOrThrow({
          where: { ownerWebhookEventId: ownerId },
        }),
      ).toMatchObject({
        chatId,
        messageId: (before.normalizedPayload as { message: { messageId: string } }).message
          .messageId,
        subjectUserId: 'fixture-source-user',
      });
      expect(
        await db.webhookEvent.count({
          where: {
            id: { in: historyWebhookIds },
            status: 'FAILED',
            processedAt: null,
            sourceDispositionId: null,
            sourceDispositionReceiptId: null,
          },
        }),
      ).toBe(historyWebhookIds.length);
      await expect(
        executeSourceAbandonmentStore(db, { ...request, operation: 'install' }, bytes),
      ).rejects.toThrow('cannot be replayed');
      expect(
        await executeSourceAbandonmentStore(
          readonlyDb,
          { ...request, operation: 'readback' },
          bytes,
        ),
      ).toMatchObject({ state: 'MATERIALIZED' });
    },
  );

  it.each(['message_created', 'message_edited'])(
    'installs and positively reads back an authorless %s source with exact marker and userless action children',
    async (type) => {
      const old = await db.webhookEvent.findUniqueOrThrow({ where: { id: ownerId } });
      const raw = structuredClone(old.rawPayload) as Record<string, unknown>;
      const message = raw.message as Record<string, unknown>;
      delete message.sender;
      (message.recipient as Record<string, unknown>).chat_type = 'channel';
      raw.update_type = type;
      (message.body as Record<string, unknown>).attachments = [
        type === 'message_edited'
          ? { type: 'image', payload: { photo_id: 42, url: 'https://example.com/native-image' } }
          : {
              type: 'video',
              payload: {
                id: 42,
                token: 'synthetic-video-token',
                url: 'https://example.com/native-video',
              },
            },
        {
          type: 'inline_keyboard',
          payload: {
            buttons:
              type === 'message_edited'
                ? [
                    [{ type: 'link', text: 'First', url: 'https://example.com/a' }],
                    [{ type: 'link', text: 'Second', url: 'https://example.com/b' }],
                  ]
                : [
                    [
                      {
                        type: 'open_app',
                        text: 'App',
                        contact_id: 12345,
                        web_app: 'https://example.com/app',
                        payload: 'opaque-start',
                      },
                    ],
                  ],
          },
        },
      ];
      const update = new WebhookParser().parse(raw, { botId: old.botId! });
      const semanticKey = buildWebhookSemanticEventKey(update)!;
      await db.webhookExecutionClaim.updateMany({
        where: { webhookEventId: ownerId },
        data: { semanticKey },
      });
      const before = await db.webhookEvent.update({
        where: { id: ownerId },
        data: {
          semanticKey,
          rawPayload: raw as Prisma.InputJsonValue,
          normalizedPayload: JSON.parse(JSON.stringify(update)),
        },
      });
      await db.chat.update({ where: { id: chatId }, data: { entityType: 'CHANNEL' } });
      const messageId = update.message!.messageId;
      const marker = await db.channelAutoPostAttachMarker.create({
        data: {
          chatId,
          messageId,
          source: 'webhook',
          botId: old.botId,
          lockedAt: old.createdAt,
          lockToken: 'retained-ambiguous-marker-lock',
          replacementSendStartedAt: old.createdAt,
          lastError: 'Synthetic uncertain dispatch',
        },
      });
      // FLAG: Exact marker and PK child resolvers must prove bounded indexed reads
      // against representative same-chat history, not an empty-table mock plan.
      await db.channelAutoPostAttachMarker.createMany({
        data: Array.from({ length: 512 }, (_, index) => ({
          chatId,
          messageId: `marker-history-${ownerId}-${index}`,
          source: 'poll',
          status: 'SKIPPED' as const,
        })),
      });
      await db.$executeRaw`ANALYZE channel_auto_post_attach_markers`;
      const queue = await actionQueue();
      const action = {
        actionType: 'DELETE_MESSAGE',
        idempotencyKey: `channel-action-${randomUUID()}`,
        chatId,
        messageId,
        attempt: 0,
      };
      await queue.add('action', action, { jobId: action.idempotencyKey });
      const actionBefore = await redis.hgetall(
        `bull:max-actions-background:${action.idempotencyKey}`,
      );
      const claims = await db.webhookExecutionClaim.findMany({
        where: { webhookEventId: ownerId },
      });
      const output = await collect();
      expect(output.issues).toEqual([]);
      expect(output.selectedOwners).toEqual([
        expect.objectContaining({
          ownerWebhookEventId: ownerId,
          sourceProfile: 'CHANNEL_AUTHORLESS_V1',
          userId: null,
          chatId,
          messageId,
        }),
      ]);
      expect(output.children).toHaveLength(2);
      expect(output.children).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            queueName: SOURCE_ABANDONMENT_CHANNEL_MARKER_QUEUE,
            jobKey: marker.id,
            chatId,
            messageId,
            jobPayloadDigest: sourceAbandonmentDigest(marker),
          }),
          expect.objectContaining({
            queueName: 'max-actions-background',
            jobKey: action.idempotencyKey,
            chatId,
            messageId,
          }),
        ]),
      );
      for (const child of output.children) expect(child).not.toHaveProperty('userId');
      const { request, bytes } = await storeFixture(output);
      expect(await executeSourceAbandonmentStore(db, request, bytes)).toMatchObject({
        state: 'UNSEALED',
      });
      expect(
        await executeSourceAbandonmentStore(db, { ...request, operation: 'install' }, bytes),
      ).toMatchObject({
        state: 'MATERIALIZED',
        completeChats: 1,
        requiredChats: 1,
        activationAuthorized: false,
      });
      for (let i = 0; i < 2; i += 1)
        expect(
          await executeSourceAbandonmentStore(
            readonlyDb,
            { ...request, operation: 'readback' },
            bytes,
          ),
        ).toMatchObject({ state: 'MATERIALIZED', completeChats: 1, requiredChats: 1 });
      expect(
        await db.webhookSourceAbandonment.findUnique({ where: { ownerWebhookEventId: ownerId } }),
      ).toMatchObject({
        sourceProfile: 'CHANNEL_AUTHORLESS_V1',
        subjectUserId: null,
        chatId,
        messageId,
      });
      expect(
        await db.webhookSourceChildHold.findMany({
          where: { abandonment: { certificateId: request.certificateId } },
        }),
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ kind: 'CHANNEL_AUTO_POST', childKey: marker.id }),
          expect.objectContaining({ kind: 'MAX_ACTION', childKey: action.idempotencyKey }),
        ]),
      );
      expect(await db.webhookEvent.findUnique({ where: { id: ownerId } })).toEqual({
        ...before,
        sourceDispositionId: expect.any(String),
        sourceDispositionReceiptId: ownerId,
      });
      expect(
        await db.webhookExecutionClaim.findMany({ where: { webhookEventId: ownerId } }),
      ).toEqual(claims);
      expect(await db.channelAutoPostAttachMarker.findUnique({ where: { id: marker.id } })).toEqual(
        marker,
      );
      expect(await redis.hgetall(`bull:max-actions-background:${action.idempotencyKey}`)).toEqual(
        actionBefore,
      );
      expect(await db.webhookLegacyRecovery.count({ where: { chatId } })).toBe(0);
    },
  );

  it('installs a strictly bound EXECUTION_WAITING checkpoint without changing the started claim', async () => {
    const owner = await db.webhookEvent.findUniqueOrThrow({ where: { id: ownerId } });
    const originalClaim = await db.webhookExecutionClaim.findFirstOrThrow({
      where: { webhookEventId: ownerId, kind: 'EXECUTION' },
    });
    const claim = await db.webhookExecutionClaim.update({
      where: { id: originalClaim.id },
      data: {
        commandResult: {
          kind: 'EXECUTION_WAITING',
          authorityVersion: 'semantic-owner-lease-v1',
          webhookEventId: owner.id,
          semanticKey: owner.semanticKey!,
          deadlineAt: owner.executionDeadlineAt!.toISOString(),
        },
      },
    });
    const { request, bytes } = await storeFixture();
    await executeSourceAbandonmentStore(db, request, bytes);
    expect(
      await executeSourceAbandonmentStore(db, { ...request, operation: 'install' }, bytes),
    ).toMatchObject({ state: 'MATERIALIZED', completeChats: 1, requiredChats: 1 });
    expect(
      await executeSourceAbandonmentStore(readonlyDb, { ...request, operation: 'readback' }, bytes),
    ).toMatchObject({ state: 'MATERIALIZED' });
    expect(await db.webhookExecutionClaim.findUnique({ where: { id: claim.id } })).toEqual(claim);
    expect(await db.webhookEvent.findUnique({ where: { id: owner.id } })).toEqual({
      ...owner,
      sourceDispositionId: expect.any(String),
      sourceDispositionReceiptId: owner.id,
    });
  });

  it('denies settings drift between certificate creation and atomic installation', async () => {
    const { request, bytes } = await storeFixture();
    await executeSourceAbandonmentStore(db, request, bytes);
    await db.chatSettings.update({
      where: { chatId },
      data: { maxMessageLengthEnabled: true, maxMessageLength: 15 },
    });
    await expect(
      executeSourceAbandonmentStore(db, { ...request, operation: 'install' }, bytes),
    ).rejects.toThrow('evidence changed');
    expect(
      await db.webhookSourceAbandonment.count({ where: { certificateId: request.certificateId } }),
    ).toBe(0);
    expect(await db.webhookEvent.findUniqueOrThrow({ where: { id: ownerId } })).toMatchObject({
      status: 'FAILED',
      sourceDispositionId: null,
      sourceDispositionReceiptId: null,
    });
    expect(
      await db.webhookSourceAbandonmentCertificate.findUniqueOrThrow({
        where: { id: request.certificateId },
      }),
    ).toMatchObject({ sealedAt: null });
  });

  it('rejects altered artifact bytes before installing a certificate', async () => {
    const { request, bytes } = await storeFixture();
    await expect(
      executeSourceAbandonmentStore(db, request, Buffer.concat([bytes, Buffer.from(' ')])),
    ).rejects.toThrow('artifact mismatch');
    expect(
      await db.webhookSourceAbandonmentCertificate.findUnique({
        where: { id: request.certificateId },
      }),
    ).toBeNull();
  });

  it('collects an exact BullMQ child, preserves an independent same-user job, and installs only the exact child hold', async () => {
    const sql = await inventory();
    expect(sql.issues).toEqual([]);
    const source = sql.candidates[0]!.source;
    const queue = await actionQueue();
    const child = {
      actionType: 'DELETE_MESSAGE',
      chatId: source.chatId,
      messageId: source.messageId,
      userId: source.userId,
      idempotencyKey: `child-${randomUUID()}`,
      attempt: 0,
    };
    const independent = {
      ...child,
      messageId: 'another-source',
      idempotencyKey: `independent-${randomUUID()}`,
    };
    await queue.add('action', child, { jobId: child.idempotencyKey });
    await queue.add('action', independent, { jobId: independent.idempotencyKey });
    const before = await redis.hgetall(`bull:max-actions-background:${child.idempotencyKey}`);
    const output = await collect();
    expect(output.issues).toEqual([]);
    expect(output.children).toEqual([
      expect.objectContaining({
        jobKey: child.idempotencyKey,
        queueName: 'max-actions-background',
        chatId: source.chatId,
        messageId: source.messageId,
        userId: source.userId,
      }),
    ]);
    const { request, bytes } = await storeFixture(output);
    await executeSourceAbandonmentStore(db, request, bytes);
    await executeSourceAbandonmentStore(db, { ...request, operation: 'install' }, bytes);
    expect(
      await db.webhookSourceChildHold.findMany({
        where: { abandonment: { certificateId: request.certificateId } },
        include: { abandonment: true },
      }),
    ).toEqual([
      expect.objectContaining({
        childKey: child.idempotencyKey,
        kind: 'MAX_ACTION',
        abandonment: expect.objectContaining({
          chatId: source.chatId,
          messageId: source.messageId,
        }),
      }),
    ]);
    expect(await redis.hgetall(`bull:max-actions-background:${child.idempotencyKey}`)).toEqual(
      before,
    );
    expect(await queue.getJobCounts('paused')).toEqual({ paused: 2 });
    expect(await db.maxActionLedgerEntry.count({ where: { chatId } })).toBe(0);
  });

  it('denies an actionable source-less member job while retaining independently fenced ambiguous history', async () => {
    const queue = await actionQueue();
    const data = {
      actionType: 'BAN_MEMBER',
      chatId,
      userId: 'fixture-source-user',
      idempotencyKey: `unknown-${randomUUID()}`,
      attempt: 0,
    };
    await queue.add('action', data, { jobId: data.idempotencyKey });
    const denied = await collect();
    expect(denied.decision).toBe('DENY');
    expect(denied.issues).toContainEqual(
      expect.objectContaining({ code: 'ACTION_SOURCE_UNPROVED' }),
    );
    expect(denied.inventorySha256).toBeNull();
    const ledger = await db.maxActionLedgerEntry.create({
      data: {
        jobId: data.idempotencyKey,
        chatId,
        userId: data.userId,
        actionType: 'BAN_MEMBER',
        status: 'AMBIGUOUS',
        ambiguous: true,
        attemptCount: 1,
        dispatchStartedAt: new Date(),
      },
    });
    const fenced = await collect();
    expect(fenced.issues).toEqual([]);
    expect(fenced.decision).toBe('READY_TO_INSTALL');
    expect(fenced.children).toEqual([]);
    expect(await db.maxActionLedgerEntry.findUniqueOrThrow({ where: { id: ledger.id } })).toEqual(
      ledger,
    );
    expect(await queue.getJobCounts('paused')).toEqual({ paused: 1 });
  });

  it('rechecks and installs the original offline artifact after independent Publisher auxiliary TTL expiry', async () => {
    const names = ['publisher-start', 'publisher-binding-refresh'];
    for (const name of names) {
      await redis.hset(`bull:${name}:meta`, 'version', 'fixture');
      await redis.set(`bull:${name}:stalled-check`, '1', 'PX', 60_000);
    }
    const reviewed = await collect();
    expect(reviewed.issues).toEqual([]);
    expect(reviewed.decision).toBe('READY_TO_INSTALL');
    for (const name of names) await redis.pexpire(`bull:${name}:stalled-check`, 1);
    await new Promise((done) => setTimeout(done, 20));
    for (const name of names) expect(await redis.exists(`bull:${name}:stalled-check`)).toBe(0);
    const rechecked = await db.$transaction(
      (tx) =>
        collectSourceAbandonmentLiveEvidence(tx, redis, {
          ...liveRequest,
          expectedInventorySha256: reviewed.inventorySha256!,
        }),
      { timeout: 30_000, isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
    expect(rechecked.issues).toEqual([]);
    expect(rechecked.decision).toBe('READY_TO_INSTALL');
    expect(rechecked.redisEvidenceSha256).toBe(reviewed.redisEvidenceSha256);
    expect(rechecked.inventorySha256).toBe(reviewed.inventorySha256);
    for (const name of names) {
      expect(reviewed.redisCatalogs[0]!.namespaceKeyCounts[name]).toBe(2);
      expect(rechecked.redisCatalogs[0]!.namespaceKeyCounts[name]).toBe(1);
    }
    for (const inventory of [reviewed, rechecked]) {
      expect(inventory.redisCatalogs).toHaveLength(2);
      expect(inventory.redisCatalogs.every((catalog) => catalog.complete && !catalog.issue)).toBe(
        true,
      );
      expect(inventory.redisCatalogs[0]!.namespaceKeyCounts).toEqual(
        inventory.redisCatalogs[1]!.namespaceKeyCounts,
      );
    }
    // FLAG: Exercise the actual host recheck against native store evidence. The
    // local child only writes temporary artifacts; PostgreSQL apply uses the
    // reviewed artifact bytes returned unchanged by that adapter below.
    const bridge = JSON.parse(
      execFileSync(
        process.execPath,
        [
          '--input-type=module',
          '--eval',
          `
            import assert from 'node:assert/strict';
            import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
            import { join } from 'node:path';
            import { tmpdir } from 'node:os';
            import { randomUUID } from 'node:crypto';
            const { createLegacyColdStoreAdapter } = await import(process.argv[1]);
            const { legacyColdDigest } = await import(new URL('./legacy-cold-journal.mjs', process.argv[1]));
            const { reviewed, rechecked, selection } = JSON.parse(readFileSync(0, 'utf8'));
            const dir = mkdtempSync(join(tmpdir(), 'maxim-source-native-recheck-'));
            try {
              const inventoryPath = join(dir, 'inventory.json');
              const originalBytes = JSON.stringify(reviewed) + '\\n';
              writeFileSync(inventoryPath, originalBytes, { mode: 0o600, flag: 'wx' });
              const bindings = {
                targetSha: reviewed.binding.sourceSha,
                targetImageId: reviewed.binding.imageId,
                controllerNonce: reviewed.binding.maintenanceId,
                certificateId: randomUUID(),
                selectionDigest: legacyColdDigest(selection),
              };
              const prior = {
                version: 1, complete: true,
                sourceSha: bindings.targetSha, imageId: bindings.targetImageId,
                controllerNonce: bindings.controllerNonce, selectionDigest: bindings.selectionDigest,
                inventoryDigest: reviewed.inventorySha256, previewDigest: reviewed.previewSha256,
                inventoryArtifactSha256: legacyColdDigest(originalBytes),
                unknownSources: 0, saturated: false, inventory: reviewed,
              };
              let freshProof;
              let inventories = 0;
              const adapter = createLegacyColdStoreAdapter({
                bindings, selection, inventoryPath, publisherBotId: reviewed.binding.publisherBotId,
                runtime: { readStoppedRuntime: () => ({ services: [], auxiliaries: [] }) },
                store: {
                  read: () => ({ journal: { proofs: { pendingInventory: legacyColdDigest(prior) } } }),
                  readProof: (name) => { assert.equal(name, 'pendingInventory'); return prior; },
                  recordProof: (value) => {
                    assert.deepEqual(value, rechecked);
                    freshProof = JSON.stringify(value) + '\\n';
                    writeFileSync(join(dir, 'recheck.json'), freshProof, { mode: 0o600, flag: 'wx' });
                    return legacyColdDigest(freshProof);
                  },
                },
                client: {
                  invoke: (kind, request) => {
                    assert.equal(kind, 'inventory');
                    assert.equal(request.operation, 'inventory_preview');
                    assert.equal(request.expectedInventorySha256, reviewed.inventorySha256);
                    assert.deepEqual(request.binding, reviewed.binding);
                    assert.deepEqual(request.selection, selection);
                    inventories += 1;
                    return rechecked;
                  },
                },
              });
              const { recheckProof, ...retained } = adapter.snapshotPending();
              assert.equal(inventories, 1);
              assert.deepEqual(retained, prior);
              assert.equal(readFileSync(inventoryPath, 'utf8'), originalBytes);
              assert.equal(readFileSync(join(dir, 'recheck.json'), 'utf8'), freshProof);
              assert.equal(recheckProof, legacyColdDigest(freshProof));
              assert.notEqual(recheckProof, prior.inventoryArtifactSha256);
              process.stdout.write(JSON.stringify({
                bytes: readFileSync(inventoryPath).toString('base64'),
                recheckProof,
                request: {
                  version: 1, operation: 'certificate_create', certificateId: bindings.certificateId,
                  binding: retained.inventory.binding, selection,
                  expected: {
                    inventorySha256: retained.inventoryDigest,
                    previewSha256: retained.previewDigest,
                    inventoryArtifactSha256: retained.inventoryArtifactSha256,
                  },
                },
              }));
            } finally { rmSync(dir, { recursive: true, force: true }); }
          `,
          pathToFileURL(
            resolve(__dirname, '../../../../infra/scripts/legacy-cold-store-adapter.mjs'),
          ).href,
        ],
        {
          input: JSON.stringify({ reviewed, rechecked, selection }),
          encoding: 'utf8',
          timeout: 15_000,
          maxBuffer: 8 * 1024 * 1024,
        },
      ),
    ) as { bytes: string; recheckProof: string; request: unknown };
    const bytes = Buffer.from(bridge.bytes, 'base64');
    expect(bytes.toString('utf8')).toBe(`${JSON.stringify(reviewed)}\n`);
    expect(bridge.recheckProof).toBe(
      createHash('sha256')
        .update(`${JSON.stringify(rechecked)}\n`)
        .digest('hex'),
    );
    const request = parseSourceAbandonmentStoreRequest(JSON.stringify(bridge.request));
    expect(request.expected.inventoryArtifactSha256).toBe(
      createHash('sha256').update(bytes).digest('hex'),
    );
    const before = await db.webhookEvent.findUniqueOrThrow({ where: { id: ownerId } });
    const claims = await db.webhookExecutionClaim.findMany({ where: { webhookEventId: ownerId } });
    expect(
      await executeSourceAbandonmentStore(readonlyDb, { ...request, operation: 'readback' }, bytes),
    ).toMatchObject({ state: 'ABSENT', activationAuthorized: false });
    expect(await executeSourceAbandonmentStore(db, request, bytes)).toMatchObject({
      state: 'UNSEALED',
      activationAuthorized: false,
    });
    expect(
      await executeSourceAbandonmentStore(db, { ...request, operation: 'install' }, bytes),
    ).toMatchObject({
      state: 'MATERIALIZED',
      completeChats: 1,
      requiredChats: 1,
      activationAuthorized: false,
    });
    expect(
      await executeSourceAbandonmentStore(readonlyDb, { ...request, operation: 'readback' }, bytes),
    ).toMatchObject({ state: 'MATERIALIZED', completeChats: 1, requiredChats: 1 });
    expect(await db.webhookEvent.findUniqueOrThrow({ where: { id: ownerId } })).toEqual({
      ...before,
      sourceDispositionId: expect.any(String),
      sourceDispositionReceiptId: ownerId,
    });
    expect(await db.webhookExecutionClaim.findMany({ where: { webhookEventId: ownerId } })).toEqual(
      claims,
    );
    expect(bytes.toString('utf8')).toBe(`${JSON.stringify(reviewed)}\n`);
  });

  it('denies Publisher auxiliary expiry between the two complete reads of one cold inventory', async () => {
    const key = 'bull:publisher-binding-refresh:stalled-check';
    await redis.hset('bull:publisher-binding-refresh:meta', 'version', 'fixture');
    await redis.set(key, '1', 'PX', 60_000);
    let headers = 0;
    const reader: SourceAbandonmentRedisReader = {
      multi: () => redis.multi(),
      async eval_ro(script, keyCount, ...args) {
        const result = await redis.eval_ro(script, keyCount, ...args);
        if (script.startsWith('-- source-abandonment:headers') && ++headers === 2) {
          await redis.pexpire(key, 1);
          await new Promise((done) => setTimeout(done, 20));
          expect(await redis.exists(key)).toBe(0);
        }
        return result;
      },
    };
    const result = await collect(reader);
    expect(headers).toBe(4);
    expect(result.redisCatalogs).toHaveLength(2);
    expect(result.redisCatalogs.every((catalog) => catalog.complete && !catalog.issue)).toBe(true);
    expect(result.decision).toBe('DENY');
    expect(result.issues).toContainEqual({
      code: 'redis_inventory_changed',
      descriptor: 'redis:all',
    });
    expect(result.inventorySha256).toBeNull();
  });

  it('denies a cold inventory when a real Redis job changes between the two complete reads', async () => {
    const sql = await inventory();
    expect(sql.issues).toEqual([]);
    const source = sql.candidates[0]!.source;
    const queue = await actionQueue();
    const key = `changing-${randomUUID()}`;
    await queue.add(
      'action',
      {
        actionType: 'DELETE_MESSAGE',
        chatId: source.chatId,
        messageId: source.messageId,
        userId: source.userId,
        idempotencyKey: key,
        attempt: 0,
      },
      { jobId: key },
    );
    let headers = 0;
    const reader: SourceAbandonmentRedisReader = {
      multi: () => redis.multi(),
      async eval_ro(script, keyCount, ...args) {
        const result = await redis.eval_ro(script, keyCount, ...args);
        if (script.startsWith('-- source-abandonment:headers') && ++headers === 2)
          await redis.hset(`bull:max-actions-background:${key}`, 'progress', '1');
        return result;
      },
    };
    const result = await collect(reader);
    expect(headers).toBe(4);
    expect(result.decision).toBe('DENY');
    expect(result.issues).toContainEqual({
      code: 'redis_inventory_changed',
      descriptor: 'redis:all',
    });
    expect(result.inventorySha256).toBeNull();
    expect(
      await db.webhookSourceAbandonment.findUnique({ where: { ownerWebhookEventId: ownerId } }),
    ).toBeNull();
  });
});
