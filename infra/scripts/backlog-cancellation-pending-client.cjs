'use strict';
const path = require('node:path');

// FLAG: Continue the frozen operation through the existing ordered-head index.
// Include the constant NULL chat key in ordering so the full index remains usable.
// Historical terminal failures are outside its predicate. Never change the cutoff,
// installed image, original snapshots, claim evidence or cancellation semantics.
function pendingPageSql(Prisma, nullChat, cursor) {
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
      e.legacy_disposition_id AS "legacyDispositionId", e.source_disposition_id AS "sourceDispositionId"
    FROM page CROSS JOIN LATERAL (SELECT * FROM webhook_events WHERE id=page.id OFFSET 0) e
    ORDER BY page."chatKey",page.at,page.id`;
}

function assertPendingPlan(raw) {
  const scans = [];
  const visit = (node) => {
    if (node['Relation Name']) scans.push(node);
    for (const child of node.Plans ?? []) visit(child);
  };
  visit(raw[0]['QUERY PLAN'][0].Plan);
  if (
    scans.length !== 2 ||
    scans.some((n) => !['Index Scan', 'Index Only Scan'].includes(n['Node Type'])) ||
    !scans.some((n) => n['Index Name'] === 'webhook_events_ordered_chat_head_idx') ||
    !scans.some((n) => n['Index Name'] === 'webhook_events_pkey')
  )
    throw Error('Pending continuation index plan refused');
}

async function capturePending(
  db,
  request,
  dependencies,
  progress = () => {},
  deadline = Date.now() + 300000,
) {
  const { Prisma, readBacklogPage, backlogSource } = dependencies;
  let scanned = 0,
    captured = 0;
  const operation = await db.webhookBacklogCancellation.findUniqueOrThrow({
    where: { id: request.id },
  });
  if (
    operation.sourceSha !== request.sourceSha ||
    operation.imageId !== request.imageId ||
    operation.cutoff.toISOString() !== request.cutoff
  )
    throw Error('Frozen operation mismatch');
  if (operation.sealedAt) return { scanned, captured };
  for (const nullChat of [false, true]) {
    assertPendingPlan(
      await readBacklogPage(
        db,
        Prisma.sql`EXPLAIN (FORMAT JSON) ${pendingPageSql(Prisma, nullChat, null)}`,
      ),
    );
    let cursor = null;
    for (;;) {
      if (Date.now() >= deadline || scanned >= 100000)
        throw Error('Pending continuation budget exhausted');
      const page = await readBacklogPage(db, pendingPageSql(Prisma, nullChat, cursor));
      if (!page.length) break;
      scanned += page.length;
      await db.$transaction(
        async (tx) => {
          await tx.$executeRaw`SET LOCAL lock_timeout = '1s'`;
          await tx.$executeRaw`SET LOCAL statement_timeout = '5s'`;
          for (const row of page) {
            if (row.at >= operation.cutoff || row.legacyDispositionId || row.sourceDispositionId)
              continue;
            const source = backlogSource(row.update);
            captured += await tx.$executeRaw(Prisma.sql`INSERT INTO webhook_backlog_receipts
            (receipt_id,cancellation_id,semantic_key,chat_id,message_id,original_snapshot)
            SELECT id,${request.id},${row.semanticKey ?? source.semanticKey},${source.chatId},${source.messageId},to_jsonb(e)
            FROM webhook_events e WHERE id=${row.id} ON CONFLICT(receipt_id) DO NOTHING`);
          }
        },
        { timeout: 15000 },
      );
      cursor = page[page.length - 1];
      progress({ phase: 'CAPTURING_PENDING', nullChat, scanned, captured });
    }
  }
  return { scanned, captured };
}

async function main() {
  const root = path.join(process.cwd(), 'apps/api/dist/apps/api/src');
  const { Prisma, createPrismaClient } = require(path.join(root, 'prisma/prisma-client.js'));
  const original = require(path.join(root, 'scripts/cancel-webhook-backlog.js'));
  const { backlogSource } = require(path.join(root, 'webhook/webhook-backlog-cancellation.js'));
  const Redis = require('ioredis');
  const request = JSON.parse(process.argv[2] ?? '');
  original.validateBacklogCancellationRequest(request);
  if (process.env.MAXIM_BACKLOG_COLD_OPERATION !== request.id) throw Error('Cold binding required');
  const deadline = Date.now() + 900000;
  const db = createPrismaClient(process.env.DATABASE_URL, {
    max: 1,
    statement_timeout: 10000,
    application_name: `maxim_backlog_cancel_${request.id}`,
    options: '-c timezone=UTC -c max_parallel_workers_per_gather=0 -c lock_timeout=1000',
  });
  const redis = new Redis(process.env.REDIS_URL, {
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    lazyConnect: true,
  });
  const progress = (value) => process.stdout.write(JSON.stringify(value) + '\n');
  try {
    await redis.connect();
    await capturePending(
      db,
      request,
      { Prisma, readBacklogPage: original.readBacklogPage, backlogSource },
      progress,
      deadline,
    );
    await original.visitBacklogQueues(
      withPortableJobSnapshots(db, Prisma),
      redis,
      request,
      false,
      progress,
      deadline,
    );
    await db.$executeRaw(Prisma.sql`UPDATE webhook_backlog_cancellations SET sealed_at=clock_timestamp() AT TIME ZONE 'UTC'
      WHERE id=${request.id} AND sealed_at IS NULL`);
    const projected = await original.projectBacklogReceipts(db, request.id, progress, deadline);
    const jobs = await original.visitBacklogQueues(db, redis, request, true, progress, deadline);
    progress({
      phase: 'COMPLETE',
      operation: request.id,
      projected,
      ...jobs,
      scope: 'captured_backlog_and_all_pre_cutoff_ordered_message_heads',
      historicalNonmessageFailuresNotScanned: true,
    });
  } finally {
    redis.disconnect();
    await db.$disconnect();
  }
}
// FLAG: Redis job metadata can contain lone UTF-16 surrogates accepted by JSON.parse
// but rejected by PostgreSQL JSONB. Preserve the exact serialized JSON bytes in an
// explicit envelope; source identity, eligibility and all claim evidence stay intact.
function withPortableJobSnapshots(db, Prisma) {
  return new Proxy(db, {
    get(target, property) {
      if (property === '$executeRaw')
        return async (query) => {
          if (query?.sql?.includes('INSERT INTO webhook_backlog_children')) {
            if (query.values.length !== 3 || typeof query.values[2] !== 'string')
              throw Error('Unexpected child snapshot query');
            JSON.parse(query.values[2]);
            const snapshot = JSON.stringify({
              format: 'BULLMQ_JOB_JSON_UTF8_BASE64_V1',
              jsonUtf8Base64: Buffer.from(query.values[2], 'utf8').toString('base64'),
            });
            return target.$executeRaw(Prisma.sql`INSERT INTO webhook_backlog_children
          (kind,child_key,cancellation_id,original_snapshot)
          VALUES ('MAX_ACTION',${query.values[0]},${query.values[1]},${snapshot}::jsonb)
          ON CONFLICT (kind,child_key) DO NOTHING`);
          }
          return target.$executeRaw(query);
        };
      const value = target[property];
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
module.exports = { pendingPageSql, assertPendingPlan, capturePending, withPortableJobSnapshots };
if (require.main === module)
  main().catch((error) => {
    const known = [
      'Unidentified action job',
      'Cancellation does not remove flow or repeat jobs',
      'Cancellation queue budget exhausted',
      'Cancellation projection deadline',
      'Cancellation readback mismatch',
      'Pending continuation index plan refused',
      'Pending continuation budget exhausted',
      'Frozen operation mismatch',
    ];
    const code = known.includes(error?.message)
      ? error.message
      : /^P[0-9]{4}$/.test(error?.code ?? '')
        ? error.code
        : 'unknown';
    const strings = [];
    const codes = [];
    const inspect = (value, depth = 0, key = '') => {
      if (depth > 8) return;
      if (typeof value === 'string') {
        strings.push(value);
        if (/code/i.test(key) && /^[A-Z0-9]{5}$/.test(value)) codes.push(value);
      } else if (value && typeof value === 'object') {
        for (const name of Object.getOwnPropertyNames(value).slice(0, 30))
          inspect(value[name], depth + 1, name);
      }
    };
    inspect(error);
    const databaseCode = codes;
    const databaseFailure =
      [
        'canceling statement due to statement timeout',
        'unsupported Unicode escape sequence',
        'invalid input syntax for type json',
        'violates check constraint',
        'index row requires',
        'Cancellation evidence is permanent',
        'invalid byte sequence',
        'value too long',
        'violates foreign key constraint',
        'cannot be converted to text',
      ].find((value) => strings.some((message) => message.includes(value))) ?? null;
    process.stderr.write(
      JSON.stringify({ phase: 'FAILED', code, databaseCode, databaseFailure }) + '\n',
    );
    process.exitCode = 1;
  });
