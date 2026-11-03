import { Queue, type ConnectionOptions } from 'bullmq';
import { Redis } from 'ioredis';
import { Prisma, createPrismaClient } from '../prisma/prisma-client';
import type { MaxUpdate } from '@maxim/contracts';
import { backlogSource } from '../webhook/webhook-backlog-cancellation';
import { confirmEraserSourceHolds } from '../message-retention/eraser-source-hold-barrier';
import { LEGACY_RECOVERY_LIVE_QUEUE_NAMES } from './legacy-recovery-live-registry';
import {
  readLegacyActionSourceScopes,
  WebhookLegacyHoldService,
} from '../webhook/webhook-legacy-hold.service';
import type { MaxActionJob } from '../max/max-client.service';
import type { PrismaService } from '../prisma/prisma.service';

export type BacklogCancellationRequest = {
  id: string;
  cutoff: string;
  sourceSha: string;
  imageId: string;
};
type Database = ReturnType<typeof createPrismaClient>;
const statuses = ['RECEIVED', 'QUEUED', 'FAILED'] as const;
const pageSize = 200;
type PendingCursor = { id: string; at: Date; chatKey: string | null };

// FLAG: Walk only current message ordering heads, including NULL chat keys. Keep
// chat in both ORDER BY variants so PostgreSQL can use the complete ordered index;
// for NULL chat it is constant and leaves the (created_at,id) order unchanged.
export function backlogPendingReceiptPageSql(nullChat: boolean, cursor: PendingCursor | null) {
  const chat = Prisma.sql`COALESCE(NULLIF(BTRIM(normalized_payload->'message'->>'chatId'), ''), NULLIF(BTRIM(normalized_payload->>'chatId'), ''))`;
  return Prisma.sql`WITH page AS MATERIALIZED (
    SELECT id, created_at AS at, ${chat} AS "chatKey"
    FROM webhook_events
    WHERE (status = ANY(ARRAY['RECEIVED','QUEUED']::"WebhookStatus"[])
      OR (status = 'FAILED'::"WebhookStatus" AND (next_enqueue_at IS NOT NULL
        OR LEFT(COALESCE(error_message, ''), 37) = 'WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINED:')))
      AND LOWER(COALESCE(NULLIF(BTRIM(normalized_payload->>'type'), ''),
        NULLIF(BTRIM(normalized_payload->>'update_type'), ''))) = ANY(ARRAY['message_created','message_edited'])
      AND ${chat} IS ${Prisma.raw(nullChat ? 'NULL' : 'NOT NULL')}
      ${
        cursor
          ? nullChat
            ? Prisma.sql`AND (created_at,id) > (${cursor.at},${cursor.id})`
            : Prisma.sql`AND (${chat},created_at,id) > (${cursor.chatKey},${cursor.at},${cursor.id})`
          : Prisma.empty
      }
    ORDER BY ${chat},created_at,id LIMIT 200
  ) SELECT page.*, e.normalized_payload AS update, e.semantic_key AS "semanticKey",
      (e.legacy_disposition_id IS NULL AND e.source_disposition_id IS NULL) AS eligible
    FROM page CROSS JOIN LATERAL (SELECT * FROM webhook_events WHERE id=page.id OFFSET 0) e
    ORDER BY page."chatKey",page.at,page.id`;
}

export function backlogJobSnapshot(value: unknown): string {
  // FLAG: Preserve JSON bytes that PostgreSQL JSONB cannot encode (e.g. lone surrogates).
  return JSON.stringify({
    format: 'BULLMQ_JOB_JSON_UTF8_BASE64_V1',
    jsonUtf8Base64: Buffer.from(JSON.stringify(value), 'utf8').toString('base64'),
  });
}

export async function readBacklogPage<T>(db: Database, query: Prisma.Sql): Promise<T> {
  return db.$transaction(
    async (tx) => {
      // FLAG: This maintenance session must walk the fully ordered index. Bitmap or
      // prefix-index sort plans can read all tied history before LIMIT. The final
      // materialized page sort is bounded; disable JIT for these small repeated reads.
      await tx.$executeRaw`SET LOCAL enable_bitmapscan = off`;
      await tx.$executeRaw`SET LOCAL enable_seqscan = off`;
      await tx.$executeRaw`SET LOCAL enable_sort = off`;
      await tx.$executeRaw`SET LOCAL enable_incremental_sort = off`;
      await tx.$executeRaw`SET LOCAL jit = off`;
      await tx.$executeRaw`SET LOCAL statement_timeout = '5s'`;
      return tx.$queryRaw<T>(query);
    },
    { timeout: 10_000 },
  );
}

export function validateBacklogCancellationRequest(value: BacklogCancellationRequest): void {
  if (
    !/^[a-f0-9-]{36}$/.test(value.id) ||
    !/^[a-f0-9]{40}$/.test(value.sourceSha) ||
    !/^sha256:[a-f0-9]{64}$/.test(value.imageId) ||
    !Number.isFinite(Date.parse(value.cutoff)) ||
    new Date(value.cutoff).toISOString() !== value.cutoff
  )
    throw new Error('Invalid cancellation identity');
}

export function backlogReceiptPageSql(
  status: (typeof statuses)[number],
  cutoff: Date,
  cursor: { id: string; at: Date } | null,
) {
  if (!statuses.includes(status)) throw new Error('Invalid cancellation status');
  return Prisma.sql`WITH page AS MATERIALIZED (
          SELECT id, created_at FROM webhook_events WHERE status = ${Prisma.raw(`'${status}'::"WebhookStatus"`)}
            AND created_at < ${cutoff}
            ${cursor ? Prisma.sql`AND (created_at, id) > (${cursor.at}, ${cursor.id})` : Prisma.empty}
          ORDER BY created_at, id LIMIT ${pageSize}
        ) SELECT e.id, e.created_at AS at, e.normalized_payload AS update, e.semantic_key AS "semanticKey",
          (e.legacy_disposition_id IS NULL AND e.source_disposition_id IS NULL
            AND (e.status <> 'FAILED' OR e.next_enqueue_at IS NOT NULL
              OR starts_with(COALESCE(e.error_message, ''), 'WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINED:'))) AS eligible
          FROM page CROSS JOIN LATERAL (SELECT * FROM webhook_events WHERE id = page.id OFFSET 0) e
          ORDER BY page.created_at, page.id`;
}

// FLAG: The host stops every writer before invoking this bounded, resumable writer.
// Source/claim uncertainty is retained; cancellation never fabricates absence or success.
export async function captureBacklogReceipts(
  db: Database,
  request: BacklogCancellationRequest,
  progress: (value: object) => void = () => {},
  deadline = Date.now() + 600_000,
) {
  validateBacklogCancellationRequest(request);
  const cutoff = new Date(request.cutoff);
  // FLAG: Inspect the live plan without executing it. Each history scan is capped
  // before payload reads; runtime changes must not turn it into a primary-table scan.
  const scansToRun = [
    ...(['RECEIVED', 'QUEUED'] as const).map((status) => ({
      name: status,
      query: (cursor: PendingCursor | null) => backlogReceiptPageSql(status, cutoff, cursor),
      index: 'webhook_events_status_created_at_id_idx',
    })),
    ...[false, true].map((nullChat) => ({
      name: nullChat ? 'PENDING_MESSAGE_NULL_CHAT' : 'PENDING_MESSAGE',
      query: (cursor: PendingCursor | null) => backlogPendingReceiptPageSql(nullChat, cursor),
      index: 'webhook_events_ordered_chat_head_idx',
    })),
  ];
  for (const scan of scansToRun) {
    const plans = await readBacklogPage<
      Array<{ 'QUERY PLAN': Array<{ Plan: Record<string, unknown> }> }>
    >(db, Prisma.sql`EXPLAIN (FORMAT JSON) ${scan.query(null)}`);
    const scans: Array<Record<string, unknown>> = [];
    const visit = (node: Record<string, unknown>) => {
      if (node['Relation Name'] === 'webhook_events') scans.push(node);
      for (const child of (node.Plans ?? []) as Array<Record<string, unknown>>) visit(child);
    };
    visit(plans[0]!['QUERY PLAN'][0]!.Plan);
    if (
      scans.length !== 2 ||
      scans.some(
        (node) => !['Index Scan', 'Index Only Scan'].includes(String(node['Node Type'])),
      ) ||
      !scans.some((node) => node['Index Name'] === scan.index) ||
      !scans.some((node) => node['Index Name'] === 'webhook_events_pkey')
    )
      throw new Error(
        `Cancellation ${scan.name} requires indexed page and primary-key reads: ${scans
          .map((node) => `${node['Node Type']}:${node['Index Name']}`)
          .join(',')}`,
      );
  }
  await db.$executeRaw(Prisma.sql`INSERT INTO webhook_backlog_cancellations (id, cutoff, source_sha, image_id)
    VALUES (${request.id}, ${cutoff}, ${request.sourceSha}, ${request.imageId}) ON CONFLICT (id) DO NOTHING`);
  const operation = await db.webhookBacklogCancellation.findUniqueOrThrow({
    where: { id: request.id },
  });
  if (
    operation.cutoff.getTime() !== cutoff.getTime() ||
    operation.sourceSha !== request.sourceSha ||
    operation.imageId !== request.imageId
  )
    throw new Error('Cancellation identity changed');
  if (operation.sealedAt) return;
  let scanned = 0,
    captured = 0;
  for (const scan of scansToRun) {
    let cursor: PendingCursor | null = null;
    while (true) {
      if (Date.now() >= deadline || scanned >= 500_000)
        throw new Error('Cancellation capture budget exhausted');
      const page: Array<{
        id: string;
        at: Date;
        update: MaxUpdate;
        semanticKey: string | null;
        eligible: boolean;
        chatKey?: string | null;
      }> = await readBacklogPage(db, scan.query(cursor));
      if (!page.length) break;
      scanned += page.length;
      await confirmEraserSourceHolds(
        db,
        page
          .filter((row) => row.eligible && row.at < cutoff)
          .map((row) => backlogSource(row.update))
          .flatMap((source) =>
            source.chatId && source.messageId
              ? [{ chatId: source.chatId, messageId: source.messageId }]
              : [],
          ),
      );
      await db.$transaction(
        async (tx) => {
          await tx.$executeRaw`SET LOCAL lock_timeout = '1s'`;
          await tx.$executeRaw`SET LOCAL statement_timeout = '5s'`;
          for (const row of page) {
            if (!row.eligible || row.at >= cutoff) continue;
            const source = backlogSource(row.update);
            captured += await tx.$executeRaw(Prisma.sql`INSERT INTO webhook_backlog_receipts
            (receipt_id, cancellation_id, semantic_key, chat_id, message_id, original_snapshot)
            SELECT id, ${request.id}, ${row.semanticKey ?? source.semanticKey}, ${source.chatId}, ${source.messageId}, to_jsonb(e)
            FROM webhook_events e WHERE id = ${row.id} ON CONFLICT (receipt_id) DO NOTHING`);
          }
        },
        { timeout: 15_000 },
      );
      const last = page[page.length - 1]!;
      cursor = { id: last.id, at: last.at, chatKey: last.chatKey ?? null };
      progress({ phase: 'CAPTURING', status: scan.name, scanned, captured });
    }
  }
}

export async function projectBacklogReceipts(
  db: Database,
  id: string,
  progress: (value: object) => void = () => {},
  deadline = Date.now() + 600_000,
) {
  let cursor = '',
    projected = 0;
  while (true) {
    if (Date.now() >= deadline) throw new Error('Cancellation projection deadline');
    const page = await db.webhookBacklogReceipt.findMany({
      where: { cancellationId: id, receiptId: { gt: cursor } },
      orderBy: { receiptId: 'asc' },
      take: pageSize,
      select: { receiptId: true },
    });
    if (!page.length) break;
    // FLAG: Snapshot equality and the sealed operation are independently enforced by
    // PostgreSQL. No payload, claim, lease, error or business table is overwritten.
    projected += await db.$executeRaw(Prisma.sql`UPDATE webhook_events SET status = 'CANCELLED'
      WHERE id IN (${Prisma.join(page.map((row) => row.receiptId))}) AND status <> 'CANCELLED'`);
    const verified = await db.webhookEvent.findMany({
      where: { id: { in: page.map((row) => row.receiptId) } },
      select: { id: true, status: true },
    });
    if (verified.length !== page.length || verified.some((row) => row.status !== 'CANCELLED'))
      throw new Error('Cancellation readback mismatch');
    cursor = page[page.length - 1]!.receiptId;
    progress({ phase: 'PROJECTING', projected });
  }
  return projected;
}

export function actionIsOldUnscheduledBacklog(
  job: { timestamp: number; delay?: number; data: MaxActionJob },
  cutoff: number,
) {
  const data = job.data;
  // FLAG: Publication and timed actions retain their original queues and authority.
  // Unknown/future clocks are never treated as an expired schedule.
  if (
    data.sourceTag === 'managed_broadcast' ||
    data.ledgerContext?.managedBroadcast ||
    data.sourceTag?.includes('publication') ||
    data.ledgerContext?.publication ||
    data.scheduledFor ||
    (job.delay ?? 0) > 0 ||
    data.sendAutoDelete
  )
    return false;
  return (
    Number.isFinite(job.timestamp) &&
    job.timestamp < cutoff &&
    Number.isFinite(Date.parse(data.createdAt)) &&
    Date.parse(data.createdAt) < cutoff
  );
}

export async function visitBacklogQueues(
  db: Database,
  redis: Redis,
  request: BacklogCancellationRequest,
  remove: boolean,
  progress: (value: object) => void = () => {},
  deadline = Date.now() + 600_000,
) {
  const holds = new WebhookLegacyHoldService(db as unknown as PrismaService);
  let removed = 0,
    captured = 0,
    retainedLocked = 0,
    scanned = 0;
  const webhookQueues = LEGACY_RECOVERY_LIVE_QUEUE_NAMES.filter(
    (name) =>
      name === 'moderation' ||
      name === 'moderation-critical' ||
      name === 'moderation-background' ||
      name === 'moderation-default' ||
      /^moderation-(join|default)-\d+$/.test(name),
  );
  const actionQueues = [
    'moderation-actions',
    'max-actions-critical',
    'max-actions-interactive',
    'max-actions-background',
  ];
  for (const name of [...webhookQueues, ...actionQueues]) {
    const queue = new Queue(name, { connection: redis as unknown as ConnectionOptions });
    try {
      // Read each state independently; removing a job keeps the current offset stable.
      for (const state of [
        'wait',
        'paused',
        'active',
        'delayed',
        'prioritized',
        'failed',
      ] as const) {
        let offset = 0;
        while (true) {
          if (Date.now() >= deadline || scanned >= 500_000)
            throw new Error('Cancellation queue budget exhausted');
          const jobs = await queue.getJobs([state], offset, offset + 99, true);
          if (!jobs.length) break;
          let removedPage = 0;
          for (const job of jobs) {
            scanned++;
            let selected = false;
            if (webhookQueues.includes(name as (typeof webhookQueues)[number])) {
              const eventId = job.data?.webhookEventId;
              if (typeof eventId === 'string')
                selected = Boolean(
                  await db.webhookBacklogReceipt.findUnique({
                    where: { receiptId: eventId },
                    select: { receiptId: true },
                  }),
                );
            } else {
              const data = job.data as MaxActionJob;
              if (typeof data.idempotencyKey !== 'string')
                throw new Error('Unidentified action job');
              if (remove)
                selected = Boolean(
                  await db.webhookBacklogChild.findUnique({
                    where: { kind_childKey: { kind: 'MAX_ACTION', childKey: data.idempotencyKey } },
                  }),
                );
              else {
                selected = actionIsOldUnscheduledBacklog(job, Date.parse(request.cutoff));
                // Exact original SEND keys cover cleanup children even with no source body.
                if (
                  data.sendAutoDelete &&
                  (await holds.isOutboundJobHeld(data.sendAutoDelete.sourceSendJobId))
                )
                  selected = true;
                try {
                  for (const scope of readLegacyActionSourceScopes(data)) {
                    if (
                      scope.messageId &&
                      (await holds.isMessageHeld(scope.chatId, scope.messageId))
                    )
                      selected = true;
                  }
                } catch {
                  // An unattributable scheduled child is retained, never guessed from a user ID.
                }
                if (selected)
                  captured += await db.$executeRaw(Prisma.sql`INSERT INTO webhook_backlog_children
                  (kind, child_key, cancellation_id, original_snapshot)
                  VALUES ('MAX_ACTION', ${data.idempotencyKey}, ${request.id}, ${backlogJobSnapshot(job.toJSON())}::jsonb)
                  ON CONFLICT (kind, child_key) DO NOTHING`);
              }
            }
            if (remove && selected) {
              if (job.parentKey || job.opts.repeat)
                throw new Error('Cancellation does not remove flow or repeat jobs');
              try {
                await job.remove();
                removed++;
                removedPage++;
              } catch (error) {
                if (!(error instanceof Error) || !error.message.includes('locked')) throw error;
                retainedLocked++;
              }
            }
          }
          offset += jobs.length - removedPage;
          progress({
            phase: remove ? 'REMOVING_JOBS' : 'CAPTURING_JOBS',
            queue: name,
            scanned,
            captured,
            removed,
            retainedLocked,
          });
        }
      }
    } finally {
      await queue.close();
    }
  }
  return { captured, removed, retainedLocked };
}

async function main() {
  const request = JSON.parse(process.argv[2] ?? '') as BacklogCancellationRequest;
  validateBacklogCancellationRequest(request);
  if (process.env.MAXIM_BACKLOG_COLD_OPERATION !== request.id)
    throw new Error('Cold host binding required');
  const deadline = Date.now() + 900_000;
  const db = createPrismaClient(process.env.DATABASE_URL, {
    max: 1,
    application_name: `maxim_backlog_cancel_${request.id}`,
    statement_timeout: 10_000,
    options: '-c timezone=UTC -c max_parallel_workers_per_gather=0 -c lock_timeout=1000',
  });
  const redis = new Redis(process.env.REDIS_URL!, {
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    lazyConnect: true,
  });
  const progress = (value: object) => process.stdout.write(`${JSON.stringify(value)}\n`);
  try {
    await redis.connect();
    await captureBacklogReceipts(db, request, progress, deadline);
    await visitBacklogQueues(db, redis, request, false, progress, deadline);
    await db.$executeRaw(Prisma.sql`UPDATE webhook_backlog_cancellations SET sealed_at = clock_timestamp() AT TIME ZONE 'UTC'
      WHERE id = ${request.id} AND sealed_at IS NULL`);
    const projected = await projectBacklogReceipts(db, request.id, progress, deadline);
    const jobs = await visitBacklogQueues(db, redis, request, true, progress, deadline);
    progress({ phase: 'COMPLETE', operation: request.id, projected, ...jobs });
  } finally {
    await redis.quit();
    await db.$disconnect();
  }
}

if (require.main === module)
  main().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message.replace(/postgres(?:ql)?:\/\/\S+/g, '[redacted]') : 'Cancellation failed'}\n`,
    );
    process.exitCode = 1;
  });
