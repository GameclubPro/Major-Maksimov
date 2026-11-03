import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { Queue, type ConnectionOptions } from 'bullmq';
import { Redis } from 'ioredis';
import { Prisma, createPrismaClient } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import type { MaxActionJob } from '../max/max-client.service';
import {
  backlogReceiptPageSql,
  backlogPendingReceiptPageSql,
  backlogJobSnapshot,
  readBacklogPage,
  captureBacklogReceipts,
  projectBacklogReceipts,
  visitBacklogQueues,
  type BacklogCancellationRequest,
} from '../scripts/cancel-webhook-backlog';
import { backlogSource, materializeBacklogCancellation } from './webhook-backlog-cancellation';
import {
  WebhookLegacyHoldService,
  assertLegacyActionAllowed,
  legacyUpdateHeldSql,
} from './webhook-legacy-hold.service';
import { buildWebhookSemanticEventKey } from './webhook-semantic-event-key';
import { WebhookOutboxService } from './webhook-outbox.service';
import { WebhookParser } from './webhook.parser';
import { MessageRetentionStore } from '../message-retention/message-retention-store.service';
import {
  createMultibotHarness,
  type MultibotHarness,
} from './webhook-multibot-fullpath.spec-support';

const databaseUrl = process.env.CHAT_ROUTING_POSTGRES_RACE_DATABASE_URL ?? '';
const redisUrl = process.env.MAXIM_TEST_REDIS_URL ?? '';
const native = databaseUrl && redisUrl ? describe : describe.skip;
jest.setTimeout(60_000);

native('operator backlog cancellation with native PostgreSQL and Redis', () => {
  let db: ReturnType<typeof createPrismaClient>, redis: Redis;
  beforeAll(async () => {
    if (
      !['localhost', '127.0.0.1'].includes(new URL(databaseUrl).hostname) ||
      !new URL(databaseUrl).pathname.includes('race_test') ||
      !['localhost', '127.0.0.1'].includes(new URL(redisUrl).hostname)
    )
      throw new Error('Disposable stores required');
    db = createPrismaClient(databaseUrl, { max: 2 });
    redis = new Redis(redisUrl, { maxRetriesPerRequest: 1 });
    await redis.ping();
  });
  afterAll(async () => {
    await redis?.quit();
    await db?.$disconnect();
  });

  function request(): BacklogCancellationRequest {
    return {
      id: randomUUID(),
      cutoff: new Date(Date.now() - 60_000).toISOString(),
      sourceSha: 'a'.repeat(40),
      imageId: `sha256:${'b'.repeat(64)}`,
    };
  }
  async function receipt(at: Date, status: 'RECEIVED' | 'FAILED' = 'RECEIVED') {
    const update = {
      type: 'message_created',
      updateId: randomUUID(),
      timestamp: at.toISOString(),
      botId: 'fixture',
      message: {
        chatId: `-${randomUUID()}`,
        messageId: randomUUID(),
        senderId: 'same-user',
        text: 'fixture',
      },
    };
    return db.webhookEvent.create({
      data: {
        dedupKey: randomUUID(),
        createdAt: at,
        status,
        errorMessage: status === 'FAILED' ? 'WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINED:uncertain' : null,
        semanticKey: buildWebhookSemanticEventKey(update),
        rawPayload: update,
        normalizedPayload: update,
      },
    });
  }
  async function seal(id: string) {
    await db.$executeRaw(Prisma.sql`UPDATE webhook_backlog_cancellations SET sealed_at = clock_timestamp() AT TIME ZONE 'UTC'
      WHERE id = ${id} AND sealed_at IS NULL`);
  }

  it('preserves Redis snapshots containing strings rejected by PostgreSQL JSONB', async () => {
    const { withPortableJobSnapshots } = createRequire(__filename)(
      '../../../../infra/scripts/backlog-cancellation-pending-client.cjs',
    );
    const operation = request();
    await db.webhookBacklogCancellation.create({
      data: {
        id: operation.id,
        cutoff: new Date(operation.cutoff),
        sourceSha: operation.sourceSha,
        imageId: operation.imageId,
      },
    });
    const key = randomUUID();
    const snapshot = JSON.stringify({
      opts: { legacyLabel: '\ud800' },
      data: { value: 'unchanged' },
    });
    const query = Prisma.sql`INSERT INTO webhook_backlog_children (kind,child_key,cancellation_id,original_snapshot)
      VALUES ('MAX_ACTION',${key},${operation.id},${snapshot}::jsonb) ON CONFLICT (kind,child_key) DO NOTHING`;
    await expect(db.$executeRaw(query)).rejects.toThrow();
    await withPortableJobSnapshots(db, Prisma).$executeRaw(query);
    const row = await db.webhookBacklogChild.findUniqueOrThrow({
      where: { kind_childKey: { kind: 'MAX_ACTION', childKey: key } },
    });
    const encoded = row.originalSnapshot as { format: string; jsonUtf8Base64: string };
    expect(encoded.format).toBe('BULLMQ_JOB_JSON_UTF8_BASE64_V1');
    expect(Buffer.from(encoded.jsonUtf8Base64, 'base64').toString('utf8')).toBe(snapshot);
    const nativeEnvelope = backlogJobSnapshot(JSON.parse(snapshot));
    expect(JSON.parse(nativeEnvelope)).toEqual(encoded);
    await db.$executeRaw(Prisma.sql`INSERT INTO webhook_backlog_children (kind,child_key,cancellation_id,original_snapshot)
      VALUES ('MAX_ACTION',${randomUUID()},${operation.id},${nativeEnvelope}::jsonb)`);
  });

  it('continues captured cancellation through pending heads without scanning terminal failed history', async () => {
    const { capturePending, pendingPageSql, assertPendingPlan } = createRequire(__filename)(
      '../../../../infra/scripts/backlog-cancellation-pending-client.cjs',
    );
    const operation = request();
    await db.webhookBacklogCancellation.create({
      data: {
        id: operation.id,
        cutoff: new Date(operation.cutoff),
        sourceSha: operation.sourceSha,
        imageId: operation.imageId,
      },
    });
    const old = await receipt(new Date(Date.now() - 120_000), 'FAILED');
    const retry = await receipt(old.createdAt, 'FAILED');
    await db.webhookEvent.update({
      where: { id: retry.id },
      data: { errorMessage: 'retry', nextEnqueueAt: new Date() },
    });
    const nullChat = await db.webhookEvent.create({
      data: {
        dedupKey: randomUUID(),
        status: 'FAILED',
        createdAt: old.createdAt,
        errorMessage: 'WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINED:uncertain',
        rawPayload: {},
        normalizedPayload: { type: 'message_created' },
      },
    });
    const fresh = await receipt(new Date());
    const prefix = randomUUID();
    await db.webhookEvent.createMany({
      data: Array.from({ length: 10000 }, (_, i) => ({
        id: `${prefix}-${i}`,
        dedupKey: `${prefix}-${i}`,
        status: 'FAILED' as const,
        createdAt: old.createdAt,
        rawPayload: {},
        normalizedPayload: old.normalizedPayload as Prisma.InputJsonValue,
        errorMessage: 'terminal historical failure',
      })),
    });
    try {
      await db.$executeRaw`ANALYZE webhook_events`;
      for (const missingChat of [false, true]) {
        const currentPlan = await readBacklogPage<any[]>(
          db,
          Prisma.sql`EXPLAIN (ANALYZE, FORMAT JSON) ${backlogPendingReceiptPageSql(missingChat, null)}`,
        );
        assertPendingPlan(currentPlan);
        const plan = await readBacklogPage<any[]>(
          db,
          Prisma.sql`EXPLAIN (ANALYZE, FORMAT JSON) ${pendingPageSql(Prisma, missingChat, null)}`,
        );
        assertPendingPlan(plan);
        const scans: any[] = [];
        const walk = (node: any) => {
          if (node['Relation Name']) scans.push(node);
          for (const child of node.Plans ?? []) walk(child);
        };
        walk(plan[0]['QUERY PLAN'][0].Plan);
        walk(currentPlan[0]['QUERY PLAN'][0].Plan);
        for (const scan of scans) {
          expect(Number(scan['Actual Rows']) * Number(scan['Actual Loops'])).toBeLessThanOrEqual(
            200,
          );
          expect(Number(scan['Rows Removed by Filter'] ?? 0)).toBe(0);
        }
      }
      const progress: Array<{ scanned?: number }> = [];
      await captureBacklogReceipts(db, operation, (value) => progress.push(value));
      expect(Math.max(...progress.map((value) => value.scanned ?? 0))).toBeLessThan(40);
      expect(
        await db.webhookBacklogReceipt.count({ where: { cancellationId: operation.id } }),
      ).toBe(3);
      const dependencies = { Prisma, readBacklogPage, backlogSource };
      const result = await capturePending(db, operation, dependencies);
      expect(result.scanned).toBeLessThan(20);
      expect(result.captured).toBe(0);
      expect((await capturePending(db, operation, dependencies)).captured).toBe(0);
      await seal(operation.id);
      await projectBacklogReceipts(db, operation.id);
      for (const id of [old.id, retry.id, nullChat.id])
        expect((await db.webhookEvent.findUniqueOrThrow({ where: { id } })).status).toBe(
          'CANCELLED',
        );
      expect((await db.webhookEvent.findUniqueOrThrow({ where: { id: fresh.id } })).status).toBe(
        'RECEIVED',
      );
      expect(
        await db.webhookEvent.count({ where: { id: { startsWith: prefix }, status: 'FAILED' } }),
      ).toBe(10000);
    } finally {
      await db.webhookEvent.deleteMany({ where: { id: { startsWith: prefix } } });
      await db.webhookEvent.delete({ where: { id: fresh.id } });
    }
  });

  it('keeps both pending readers bounded across null-chat queue skew and cursor pages', async () => {
    const { pendingPageSql, assertPendingPlan } = createRequire(__filename)(
      '../../../../infra/scripts/backlog-cancellation-pending-client.cjs',
    );
    const prefix = `cancel-plan-${randomUUID()}-`;
    try {
      await db.$executeRaw(Prisma.sql`INSERT INTO webhook_events
        (id,dedup_key,status,queue_name,raw_payload,normalized_payload,created_at)
        SELECT ${prefix} || lpad(n::text, 5, '0'), ${prefix} || lpad(n::text, 5, '0'),
          'RECEIVED'::"WebhookStatus",
          CASE n % 4 WHEN 0 THEN NULL WHEN 1 THEN 'unknown' WHEN 2 THEN 'default' ELSE 'other' END,
          '{}'::jsonb, CASE WHEN n <= 4000 THEN '{"type":"message_created"}'::jsonb
            ELSE jsonb_build_object('type','message_created','message',jsonb_build_object('chatId',${prefix}::text)) END,
          '1900-01-01'::timestamp + (n / 4) * interval '1 second'
        FROM generate_series(1,4500) n`);
      await db.$executeRaw`ANALYZE webhook_events`;
      for (const missingChat of [true, false]) {
        for (const query of [
          (cursor: { id: string; at: Date; chatKey: string | null } | null) =>
            backlogPendingReceiptPageSql(missingChat, cursor),
          (cursor: { id: string; at: Date; chatKey: string | null } | null) =>
            pendingPageSql(Prisma, missingChat, cursor),
        ]) {
          let cursor: { id: string; at: Date; chatKey: string | null } | null = null;
          const seen = new Set<string>();
          for (let page = 0; page < 2; page++) {
            const statement = query(cursor);
            const plan = await readBacklogPage<any[]>(
              db,
              Prisma.sql`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${statement}`,
            );
            assertPendingPlan(plan);
            const nodes: any[] = [];
            const walk = (node: any) => {
              nodes.push(node);
              for (const child of node.Plans ?? []) walk(child);
            };
            walk(plan[0]['QUERY PLAN'][0].Plan);
            const pageRoot = nodes.find((node) => node['Subplan Name'] === 'CTE page');
            expect(pageRoot).toBeDefined();
            const pageNodes: any[] = [];
            const visitPage = (node: any) => {
              pageNodes.push(node);
              for (const child of node.Plans ?? []) visitPage(child);
            };
            visitPage(pageRoot);
            expect(
              pageNodes.some((node) => ['Sort', 'Incremental Sort'].includes(node['Node Type'])),
            ).toBe(false);
            const scan = pageNodes.find(
              (node) => node['Index Name'] === 'webhook_events_ordered_chat_head_idx',
            );
            expect(scan).toBeDefined();
            expect(Number(scan['Actual Rows']) * Number(scan['Actual Loops'])).toBeLessThanOrEqual(
              200,
            );
            expect(Number(scan['Rows Removed by Filter'] ?? 0)).toBe(0);
            if (cursor) expect(String(scan['Index Cond'])).toContain('created_at');
            const rows = await readBacklogPage<
              Array<{ id: string; at: Date; chatKey: string | null }>
            >(db, statement);
            expect(rows).toHaveLength(200);
            for (const item of rows) {
              expect(item.id.startsWith(prefix)).toBe(true);
              expect(seen.has(item.id)).toBe(false);
              seen.add(item.id);
            }
            cursor = rows[rows.length - 1]!;
          }
        }
      }
    } finally {
      await db.webhookEvent.deleteMany({ where: { id: { startsWith: prefix } } });
    }
  });

  it('bounds each SQL page even across retained failed history and tied timestamps', async () => {
    const at = new Date(Date.now() - 3600_000);
    const prefix = randomUUID();
    await db.webhookEvent.createMany({
      data: Array.from({ length: 2000 }, (_, i) => ({
        id: `${prefix}-${String(i).padStart(4, '0')}`,
        dedupKey: `${prefix}-${i}`,
        status: 'FAILED' as const,
        createdAt: at,
        rawPayload: {},
        normalizedPayload: {},
        errorMessage: 'retained terminal failure',
      })),
    });
    try {
      await db.$executeRaw`ANALYZE webhook_events`;
      const query = backlogReceiptPageSql('FAILED', new Date(), { at, id: `${prefix}-0500` });
      const plan = await readBacklogPage<
        Array<{ 'QUERY PLAN': Array<{ Plan: Record<string, unknown> }> }>
      >(db, Prisma.sql`EXPLAIN (ANALYZE, FORMAT JSON) ${query}`);
      const nodes: Array<Record<string, unknown>> = [];
      const walk = (node: Record<string, unknown>) => {
        nodes.push(node);
        for (const child of (node.Plans ?? []) as Array<Record<string, unknown>>) walk(child);
      };
      walk(plan[0]!['QUERY PLAN'][0]!.Plan);
      const scans = nodes.filter((node) => node['Relation Name'] === 'webhook_events');
      expect(scans.length).toBe(2);
      for (const scan of scans) {
        expect(scan['Node Type']).toMatch(/Index/);
        expect(Number(scan['Actual Rows']) * Number(scan['Actual Loops'])).toBeLessThanOrEqual(200);
        expect(Number(scan['Rows Removed by Filter'] ?? 0)).toBe(0);
      }
      const page = await readBacklogPage<Array<{ id: string; eligible: boolean }>>(db, query);
      expect(page).toHaveLength(200);
      expect(page.every((row) => !row.eligible)).toBe(true);
    } finally {
      await db.webhookEvent.deleteMany({ where: { id: { startsWith: prefix } } });
    }
  });

  it('resumes after capture and after sealing, retains uncertainty, denies replay and leaves fresh messages eligible', async () => {
    const operation = request();
    const old = await receipt(new Date(Date.now() - 120_000), 'FAILED');
    const fresh = await receipt(new Date());
    const claim = await db.webhookExecutionClaim.create({
      data: {
        semanticKey: old.semanticKey!,
        webhookEventId: old.id,
        status: 'READY',
        enforced: true,
        businessStartedAt: old.createdAt,
        preparedAt: old.createdAt,
        commandResult: { ambiguous: true },
      },
    });
    await captureBacklogReceipts(db, operation);
    await captureBacklogReceipts(db, operation);
    expect(await db.$transaction((tx) => materializeBacklogCancellation(tx, old.id))).toBe(
      'BLOCKED_UNKNOWN',
    );
    await seal(operation.id);
    await projectBacklogReceipts(db, operation.id);
    await projectBacklogReceipts(db, operation.id);
    expect(await db.webhookExecutionClaim.findUnique({ where: { id: claim.id } })).toEqual(claim);
    expect(await db.webhookEvent.findUnique({ where: { id: old.id } })).toEqual({
      ...old,
      status: 'CANCELLED',
    });
    expect(await db.webhookEvent.findUnique({ where: { id: fresh.id } })).toEqual(fresh);
    await expect(
      db.webhookEvent.update({ where: { id: old.id }, data: { status: 'RECEIVED' } }),
    ).rejects.toThrow();
    await expect(
      db.webhookExecutionClaim.update({
        where: { id: claim.id },
        data: { businessStartedAt: null },
      }),
    ).rejects.toThrow();
    const holds = new WebhookLegacyHoldService(db as unknown as PrismaService);
    const update = old.normalizedPayload as never;
    expect(await holds.isUpdateHeld(update)).toBe(true);
    expect(
      await holds.isMemberHeld(
        (old.normalizedPayload as { message: { chatId: string } }).message.chatId,
        'same-user',
      ),
    ).toBe(false);
    expect(await holds.isGlobalUserHeld('same-user')).toBe(false);
    expect(await holds.isUpdateHeld(fresh.normalizedPayload as never)).toBe(false);
    for (const type of [
      'message_created',
      'message_edited',
      'message_removed',
      'message_callback',
    ]) {
      const candidate = { ...(old.normalizedPayload as object), type };
      const check = await db.webhookEvent.create({
        data: {
          dedupKey: randomUUID(),
          semanticKey: buildWebhookSemanticEventKey(candidate),
          normalizedPayload: candidate,
          rawPayload: {},
        },
      });
      const [sql] = await db.$queryRaw<Array<{ held: boolean }>>(Prisma.sql`
        SELECT ${legacyUpdateHeldSql('event')} AS held FROM webhook_events event WHERE id = ${check.id}
      `);
      const objectHeld = await holds.isUpdateHeld(candidate as never);
      expect(sql!.held).toBe(objectHeld);
      expect(objectHeld).toBe(type === 'message_created' || type === 'message_edited');
      await db.webhookEvent.delete({ where: { id: check.id } });
    }
    const mirror = await db.webhookEvent.create({
      data: {
        dedupKey: randomUUID(),
        semanticKey: old.semanticKey,
        rawPayload: old.rawPayload as Prisma.InputJsonValue,
        normalizedPayload: old.normalizedPayload as Prisma.InputJsonValue,
      },
    });
    expect(await db.$transaction((tx) => materializeBacklogCancellation(tx, mirror.id))).toBe(
      'APPLIED_WITH_PROOF',
    );
    expect((await db.webhookEvent.findUniqueOrThrow({ where: { id: mirror.id } })).status).toBe(
      'CANCELLED',
    );
    expect(await holds.readFreshCommandReceipt(mirror.id, update)).toBeNull();
    await expect(
      db.webhookBacklogReceipt.delete({ where: { receiptId: old.id } }),
    ).rejects.toThrow();
    await db.webhookEvent.delete({ where: { id: fresh.id } });
  });

  it.each(['message_removed', 'message_callback'])(
    'retains exact semantic cancellation for %s',
    async (type) => {
      const at = new Date(Date.now() - 120_000);
      const original = await receipt(at);
      const update = {
        ...(original.normalizedPayload as object),
        type,
        callback: { callbackId: randomUUID(), payload: 'fixture' },
      };
      const semanticKey = buildWebhookSemanticEventKey(update);
      await db.webhookEvent.update({
        where: { id: original.id },
        data: {
          semanticKey,
          normalizedPayload: update,
        },
      });
      const operation = request();
      await captureBacklogReceipts(db, operation);
      await seal(operation.id);
      await projectBacklogReceipts(db, operation.id);
      const mirror = await db.webhookEvent.create({
        data: {
          dedupKey: randomUUID(),
          semanticKey,
          normalizedPayload: update,
          rawPayload: {},
        },
      });
      const holds = new WebhookLegacyHoldService(db as unknown as PrismaService);
      expect(await holds.isUpdateHeld(update as never)).toBe(true);
      const [sql] = await db.$queryRaw<Array<{ held: boolean }>>(Prisma.sql`
      SELECT ${legacyUpdateHeldSql('event')} AS held FROM webhook_events event WHERE id = ${mirror.id}
    `);
      expect(sql!.held).toBe(true);
      expect(await db.$transaction((tx) => materializeBacklogCancellation(tx, mirror.id))).toBe(
        'APPLIED_WITH_PROOF',
      );
      expect((await db.webhookEvent.findUniqueOrThrow({ where: { id: mirror.id } })).status).toBe(
        'CANCELLED',
      );
    },
  );

  it('retains a completed original behind a cancelled mirror without blocking unrelated history cleanup', async () => {
    const original = await receipt(new Date(Date.now() - 120_000));
    await db.webhookEvent.update({
      where: { id: original.id },
      data: { status: 'PROCESSED', processedAt: new Date() },
    });
    const claim = await db.webhookExecutionClaim.create({
      data: {
        semanticKey: original.semanticKey!,
        webhookEventId: original.id,
        status: 'COMPLETED',
        enforced: true,
        preparedAt: original.createdAt,
        completedAt: new Date(),
      },
    });
    await db.webhookEvent.create({
      data: {
        dedupKey: randomUUID(),
        semanticKey: original.semanticKey,
        createdAt: original.createdAt,
        rawPayload: original.rawPayload as Prisma.InputJsonValue,
        normalizedPayload: original.normalizedPayload as Prisma.InputJsonValue,
      },
    });
    const unrelated = await receipt(original.createdAt);
    await db.webhookEvent.update({
      where: { id: unrelated.id },
      data: { status: 'PROCESSED', processedAt: new Date() },
    });
    const operation = request();
    await captureBacklogReceipts(db, operation);
    await seal(operation.id);
    await projectBacklogReceipts(db, operation.id);
    const retention = Object.assign(Object.create(WebhookOutboxService.prototype), {
      prisma: db,
      webhookRetentionCursors: new Map(),
    }) as { deleteCompletedWebhookBatch(cutoff: Date): Promise<unknown> };
    await retention.deleteCompletedWebhookBatch(new Date());
    expect(await db.webhookEvent.findUnique({ where: { id: original.id } })).not.toBeNull();
    expect(await db.webhookExecutionClaim.findUnique({ where: { id: claim.id } })).toEqual(claim);
    expect(await db.webhookEvent.findUnique({ where: { id: unrelated.id } })).toBeNull();
  });

  it('removes cancelled webhook/action jobs, keeps future publications and rejects reintroduced action IDs', async () => {
    const operation = request();
    const old = await receipt(new Date(Date.now() - 120_000));
    const webhook = new Queue('moderation-default-0', {
      connection: redis as unknown as ConnectionOptions,
    });
    const actions = new Queue('max-actions-background', {
      connection: redis as unknown as ConnectionOptions,
    });
    const schedules = new Queue('publisher-publication-wakeup', {
      connection: redis as unknown as ConnectionOptions,
    });
    try {
      const webhookJob = await webhook.add('fixture', { webhookEventId: old.id });
      const data = {
        actionType: 'SEND_MESSAGE' as const,
        chatId: '-fixture',
        idempotencyKey: randomUUID(),
        createdAt: old.createdAt.toISOString(),
        attempt: 0,
      };
      const action = await actions.add('fixture', data, { timestamp: old.createdAt.getTime() });
      const publication = await actions.add(
        'fixture',
        { ...data, idempotencyKey: randomUUID(), sourceTag: 'managed_broadcast' },
        { timestamp: old.createdAt.getTime() },
      );
      const future = await schedules.add(
        'fixture',
        { occurrenceId: randomUUID() },
        { delay: 3600_000 },
      );
      await captureBacklogReceipts(db, operation);
      await visitBacklogQueues(db, redis, operation, false);
      await seal(operation.id);
      await projectBacklogReceipts(db, operation.id);
      await visitBacklogQueues(db, redis, operation, true);
      expect(await webhook.getJob(webhookJob.id!)).toBeUndefined();
      expect(await actions.getJob(action.id!)).toBeUndefined();
      expect(await actions.getJob(publication.id!)).toBeDefined();
      expect(await schedules.getJob(future.id!)).toBeDefined();
      const holds = new WebhookLegacyHoldService(db as unknown as PrismaService);
      await expect(assertLegacyActionAllowed(holds, data)).rejects.toThrow();
      await publication.remove();
      await future.remove();
    } finally {
      await webhook.close();
      await actions.close();
      await schedules.close();
    }
  });

  it('unblocks fresh same-chat moderation while retaining started unknown effects and confirmed receipts', async () => {
    let h: MultibotHarness | undefined;
    try {
      h = await createMultibotHarness({ databaseUrl, redisUrl, bots: 2, mode: 'on' });
      await h.pause();
      const [chatId] = await h.seedCatalog(1, {
        maxMessageLengthEnabled: true,
        maxMessageLength: 20,
      });
      const settings = await h.prisma.chatSettings.findUniqueOrThrow({
        where: { chatId: chatId! },
      });
      const chat = await h.prisma.chat.findUniqueOrThrow({ where: { id: chatId! } });
      const oldMessageId = randomUUID();
      const oldId = await h.ingest({
        chatId: chatId!,
        messageId: oldMessageId,
        text: 'old',
        botId: h.bots[0]!.id,
      });
      await h.ingress.preparePersistedWebhookEvent(oldId);
      const started = await h.canonical.prepareExecution(oldId, h.bots[0]!.id);
      expect(started?.businessLeaseToken).toEqual(expect.any(String));
      const source = { chatId: chatId!, messageId: oldMessageId, userId: 'fixture-user' };
      const confirmedSend: MaxActionJob = {
        actionType: 'SEND_MESSAGE',
        chatId: chatId!,
        botId: h.bots[0]!.id,
        text: 'Confirmed fixture',
        idempotencyKey: `cancel-confirmed-${randomUUID()}`,
        attempt: 1,
        createdAt: new Date().toISOString(),
        ledgerContext: { moderationSource: source },
      };
      await h.ledger.recordStarted(confirmedSend);
      await h.max.executeActionJob(confirmedSend);
      const confirmedReceipt = await h.prisma.maxActionLedgerEntry.findUniqueOrThrow({
        where: { jobId: confirmedSend.idempotencyKey },
      });
      expect(confirmedReceipt).toMatchObject({
        status: 'SUCCEEDED',
        remoteMessageId: expect.any(String),
        dispatchBotId: h.bots[0]!.id,
        completedAt: expect.any(Date),
      });
      const pendingSend: MaxActionJob = {
        ...confirmedSend,
        idempotencyKey: `cancel-pending-${randomUUID()}`,
      };
      await h.ledger.recordStarted(pendingSend);
      await h.ledger.recordPrepared(pendingSend);
      h.ambiguousNextMemberMutation();
      await expect(
        h.max.banMember(chatId!, 'fixture-user', {
          immediate: true,
          botId: h.bots[0]!.id,
          ledgerContext: { moderationSource: source },
        }),
      ).rejects.toThrow('Ambiguous MAX BAN_MEMBER');
      const unknownMember = await h.prisma.maxActionLedgerEntry.findFirstOrThrow({
        where: { chatId: chatId!, actionType: 'BAN_MEMBER' },
      });
      expect(unknownMember).toMatchObject({
        status: 'AMBIGUOUS',
        ambiguous: true,
        attemptCount: 1,
      });
      await h.canonical.failExecution(started!, {
        errorMessage: 'WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINED:uncertain',
        terminal: true,
      });
      await h.prisma.webhookEvent.update({
        where: { id: oldId },
        data: {
          createdAt: new Date(Date.now() - 120_000),
        },
      });
      const old = await h.prisma.webhookEvent.findUniqueOrThrow({ where: { id: oldId } });
      const claim = await h.prisma.webhookExecutionClaim.findFirstOrThrow({
        where: { webhookEventId: oldId, kind: 'EXECUTION' },
      });
      expect(claim).toMatchObject({
        enforced: true,
        status: 'READY',
        businessStartedAt: expect.any(Date),
        completedAt: null,
        leaseToken: null,
        leaseExpiresAt: null,
      });
      const priorEffects = [...h.effects];
      const handler = jest.spyOn(h.moderation, 'handleUpdate');
      const freshMessageId = randomUUID();
      const freshId = await h.ingest({
        chatId: chatId!,
        messageId: freshMessageId,
        text: 'Fresh fixture message that exceeds the configured message length',
        botId: h.bots[0]!.id,
      });
      await expect(h.ingress.preparePersistedWebhookEvent(freshId)).resolves.toMatchObject({
        canonical: true,
        prepared: true,
      });
      await expect(h.canonical.prepareExecution(freshId, h.bots[0]!.id)).rejects.toMatchObject({
        code: 'WEBHOOK_ORDERED_PREDECESSOR_PENDING',
        webhookEventId: freshId,
        predecessorWebhookEventId: oldId,
      });
      const operation = request();
      await captureBacklogReceipts(db, operation);
      expect(await db.$transaction((tx) => materializeBacklogCancellation(tx, oldId))).toBe(
        'BLOCKED_UNKNOWN',
      );
      await seal(operation.id);
      await projectBacklogReceipts(db, operation.id);
      await projectBacklogReceipts(db, operation.id);
      await h.moderation.processWebhookEvent(oldId);
      await expect(h.max.executeActionJob(confirmedSend)).resolves.toMatchObject({
        messageId: confirmedReceipt.remoteMessageId,
        recoveredSendDispatch: { dispatchBotId: confirmedReceipt.dispatchBotId },
      });
      await expect(h.max.executeActionJob(pendingSend)).rejects.toThrow('Unverified legacy effect');
      await expect(
        h.max.kickMember(chatId!, 'fixture-user', {
          immediate: true,
          botId: h.bots[1]!.id,
        }),
      ).rejects.toThrow('Retained member action requires settlement');
      expect(handler).not.toHaveBeenCalled();
      expect(h.effects).toEqual(priorEffects);
      expect(await db.webhookEvent.findUnique({ where: { id: oldId } })).toEqual({
        ...old,
        status: 'CANCELLED',
      });
      await h.resume();
      await h.drain();
      await h.pumpWork();
      await h.drain();
      expect((await db.webhookEvent.findUniqueOrThrow({ where: { id: freshId } })).status).toBe(
        'PROCESSED',
      );
      expect((await db.webhookEvent.findUniqueOrThrow({ where: { id: oldId } })).status).toBe(
        'CANCELLED',
      );
      expect(await db.chatSettings.findUnique({ where: { chatId: chatId! } })).toEqual(settings);
      expect(await db.chat.findUnique({ where: { id: chatId! } })).toMatchObject({
        id: chat.id,
        primaryBotId: chat.primaryBotId,
        botId: chat.botId,
      });
      expect(h.processedIds.filter((id) => id === freshId)).toHaveLength(1);
      expect(handler.mock.calls.map(([update]) => update.message?.messageId)).toEqual([
        freshMessageId,
      ]);
      expect(h.effects.slice(priorEffects.length)).toEqual([
        expect.objectContaining({ method: 'delete', path: '/messages', messageId: freshMessageId }),
      ]);
      expect(await db.webhookExecutionClaim.findUnique({ where: { id: claim.id } })).toEqual(claim);
      expect(await db.maxActionLedgerEntry.findUnique({ where: { id: unknownMember.id } })).toEqual(
        unknownMember,
      );
      expect(
        await db.maxActionLedgerEntry.findUnique({ where: { id: confirmedReceipt.id } }),
      ).toEqual(confirmedReceipt);
      const original = await db.webhookEvent.findUniqueOrThrow({ where: { id: oldId } });
      const originalMessageId = (original.normalizedPayload as { message: { messageId: string } })
        .message.messageId;
      Object.assign(h.ingress, {
        messageRetention: new MessageRetentionStore(h.prisma as never, h.config, h.legacyHolds),
      });
      const removal = new WebhookParser().parse(
        {
          update_type: 'message_removed',
          update_id: randomUUID(),
          timestamp: Date.now(),
          chat_id: chatId,
          message_id: originalMessageId,
          user_id: 'fixture-user',
        },
        { botId: h.bots[0]!.id },
      );
      const removedId = (await h.ingress.storeReceipt(removal, null)).webhookEventId!;
      h.receiptIds.push(removedId);
      const revoke = jest.spyOn(h.history, 'remove');
      const beforeEffects = h.effects.length;
      expect(await h.legacyHolds.isUpdateHeld(removal)).toBe(false);
      await expect(h.ingress.preparePersistedWebhookEvent(removedId)).resolves.toMatchObject({
        canonical: true,
        prepared: true,
      });
      await h.drain();
      expect((await db.webhookEvent.findUniqueOrThrow({ where: { id: removedId } })).status).toBe(
        'PROCESSED',
      );
      // FLAG: The observation settles, but the original message-family hold still
      // denies whole-engine state changes, including duplicate history mutation.
      expect(await h.legacyHolds.isMessageHeld(chatId!, originalMessageId)).toBe(true);
      expect(revoke).not.toHaveBeenCalled();
      expect(h.effects).toHaveLength(beforeEffects);
      expect(await db.webhookEvent.findUnique({ where: { id: oldId } })).toEqual(original);
    } finally {
      if (h) {
        // FLAG: Permanent cancellation fixtures live until the disposable database is dropped.
        const cancelled = await db.webhookBacklogReceipt.findMany({
          where: { receiptId: { in: h.receiptIds } },
          select: { receiptId: true },
        });
        for (const row of cancelled) h.receiptIds.splice(h.receiptIds.indexOf(row.receiptId), 1);
        await h.dispose();
      }
    }
  });
});
