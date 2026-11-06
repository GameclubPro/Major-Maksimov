import { z } from 'zod';
import { Prisma } from '../prisma/prisma-client';
import { isManagedEntityHandshakeStartCommand } from '../common/managed-entity-handshake-command.util';
import { parseAdminForwardedModerationCommand } from '../moderation/admin-forwarded-command.util';
import {
  buildCommercialOcrJobId,
  COMMERCIAL_OCR_QUEUE,
  resolveCommercialOcrJobEventTimestamp,
} from '../moderation/commercial-ocr/commercial-ocr.queue';
import {
  buildPhotoDuplicateJobId,
  PHOTO_DUPLICATE_ALGORITHM_VERSION,
  PHOTO_DUPLICATE_QUEUE,
} from '../moderation/photo-duplicate/photo-duplicate.queue';
import {
  buildMessageDuplicateJobId,
  MESSAGE_DUPLICATE_JOB_VERSION,
  MESSAGE_DUPLICATE_QUEUE,
} from '../moderation/message-duplicate/message-duplicate.queue';
import { parseWebhookEventTimestampMs } from '../webhook/webhook-event-timestamp';
import { legacySnapshotDigest } from '../webhook/webhook-legacy-source';
import { buildWebhookSemanticEventKey } from '../webhook/webhook-semantic-event-key';
import { WebhookParser } from '../webhook/webhook.parser';
import type {
  LegacyRecoveryLiveIssue,
  LegacyRecoveryLivePlanProof,
} from './legacy-recovery-live-protocol';

export type LegacyRecoverySqlSourceInput = Readonly<{
  queueName: 'commercial-image-ocr' | 'photo-duplicates' | 'message-duplicates';
  jobId: string;
  jobPayloadDigest: string;
  data: unknown;
}>;
export type LegacyRecoverySqlSourceScope = Readonly<{
  chatId: string;
  messageId: string;
  userId: string;
  sourceAt: Date;
}>;
export type LegacyRecoverySqlSourceAllowance = Readonly<{
  pages: number;
  rows: number;
  probes: number;
  bytes: number;
  deadlineAtMs: number;
}>;
export type LegacyRecoverySqlSourceResult = Readonly<{
  decision: 'INDEPENDENT' | 'RELATED_UNSUPPORTED' | 'DENY';
  source?: Readonly<{
    webhookEventId: string;
    chatId: string;
    messageId: string;
    userId: string;
    sourceAt: string;
    receiptSha256: string;
  }>;
  proofSha256: string;
  cost: { pages: number; rows: number; probes: number; bytes: number };
  plans: readonly LegacyRecoveryLivePlanProof[];
  issues: readonly LegacyRecoveryLiveIssue[];
}>;
const PAYLOAD_BYTES = 256 * 1024;
const PLAN_BYTES = 64 * 1024;
const descriptor = 'sql:webhook_events:exact-job-source';
const identifier = z
  .string()
  .min(1)
  .max(512)
  .refine((s) => s === s.trim());
const iso = z.string().refine((s) => {
  const at = Date.parse(s);
  return Number.isSafeInteger(at) && at > 0 && new Date(at).toISOString() === s;
});
const sha256 = z.string().regex(/^[0-9a-f]{64}$/u);
const base = {
  webhookEventId: identifier,
  chatId: identifier,
  messageId: identifier,
  sourceCreatedAt: iso,
  actionEligible: z.boolean(),
  idempotencyKey: identifier,
  createdAt: iso,
};
const photoSchema = z
  .object({
    ...base,
    algorithmVersion: z.literal(PHOTO_DUPLICATE_ALGORITHM_VERSION),
    sourceTag: z.literal('photo-duplicate'),
    retryPolicyName: z.literal('photo-duplicate'),
  })
  .strict();
const ocrSchema = z
  .object({
    ...base,
    schemaVersion: z.union([z.literal(1), z.literal(2), z.literal(3)]),
    ocrVersion: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u),
    sourceTag: z.literal('commercial-image-ocr'),
    imageCount: z.number().int().min(1).max(10),
    eventTimestamp: iso.optional(),
    commercialScanRequested: z.boolean().optional(),
    imageTextScanRequested: z.boolean().optional(),
    sourceRetryNotBeforeAt: z.number().int().positive().safe().optional(),
  })
  .strict();
const messageSchema = z
  .object({
    ...base,
    version: z.literal(MESSAGE_DUPLICATE_JOB_VERSION),
    eventTimestampMs: z.number().int().positive().safe(),
    controlRevision: z.number().int().nonnegative().safe(),
    policyRevision: z.number().int().nonnegative().safe(),
    settingsDigest: sha256,
    deadlineAtMs: z.number().int().positive().safe(),
    cleanupOnly: z.enum(['completed', 'terminated']).optional(),
    comparison: z.enum(['TEXT', 'IMAGE']).optional(),
  })
  .strict();
function parseJob(input: LegacyRecoverySqlSourceInput) {
  if (
    !sha256.safeParse(input.jobPayloadDigest).success ||
    legacySnapshotDigest(input.data) !== input.jobPayloadDigest
  )
    throw new Error('job_digest');
  let data, jobId: string;
  switch (input.queueName) {
    case COMMERCIAL_OCR_QUEUE:
      data = ocrSchema.parse(input.data);
      if (
        data.schemaVersion >= 2 &&
        (typeof data.commercialScanRequested !== 'boolean' ||
          typeof data.imageTextScanRequested !== 'boolean' ||
          (!data.commercialScanRequested && !data.imageTextScanRequested))
      )
        throw new Error('job_purpose');
      resolveCommercialOcrJobEventTimestamp(data);
      jobId = buildCommercialOcrJobId(data);
      break;
    case PHOTO_DUPLICATE_QUEUE:
      data = photoSchema.parse(input.data);
      jobId = buildPhotoDuplicateJobId(data);
      break;
    case MESSAGE_DUPLICATE_QUEUE:
      data = messageSchema.parse(input.data);
      jobId = buildMessageDuplicateJobId(
        data.chatId,
        data.messageId,
        data.eventTimestampMs,
        data.comparison,
      );
      break;
    default:
      throw new Error('job_family');
  }
  if (input.jobId !== jobId || data.idempotencyKey !== jobId) throw new Error('job_identity');
  return data;
}
const rawIdentity = z.union([identifier, z.number().int().safe()]);
const photoPayload = z
  .object({
    photo_id: rawIdentity,
    url: z
      .string()
      .max(4096)
      .refine((s) => {
        try {
          const u = new URL(s);
          return u.protocol === 'https:' && !u.username && !u.password;
        } catch {
          return false;
        }
      })
      .optional(),
    token: z.string().min(1).max(4096).optional(),
  })
  .strict();
const rawSchema = z
  .object({
    update_type: z.literal('message_created'),
    update_id: rawIdentity.optional(),
    timestamp: z.number().int().positive().safe(),
    message: z
      .object({
        sender: z
          .object({
            user_id: rawIdentity,
            is_bot: z.literal(false),
            name: z.string().nullable().optional(),
            first_name: z.string().nullable().optional(),
            last_name: z.string().nullable().optional(),
            username: z.string().nullable().optional(),
            avatar_url: z.string().nullable().optional(),
            last_activity_time: z.number().int().safe().nullable().optional(),
          })
          .strict(),
        recipient: z.object({ chat_id: rawIdentity, chat_type: z.literal('chat') }).strict(),
        timestamp: z.number().int().positive().safe(),
        body: z
          .object({
            mid: rawIdentity,
            seq: z.number().int().safe().optional(),
            text: z.string().nullable().optional(),
            attachments: z
              .array(z.object({ type: z.literal('image'), payload: photoPayload }).strict())
              .max(10)
              .optional(),
          })
          .strict(),
      })
      .strict(),
  })
  .strict();
type Receipt = {
  id: string;
  botId: string | null;
  createdAt: Date;
  semanticKey: string | null;
  payloadBytes: number;
  rawPayload: unknown;
  normalizedPayload: unknown;
};
function inspectReceipt(
  row: Receipt,
  input: LegacyRecoverySqlSourceInput,
  job: ReturnType<typeof parseJob>,
) {
  if (
    row.id !== job.webhookEventId ||
    !identifier.safeParse(row.botId).success ||
    !(row.createdAt instanceof Date) ||
    !Number.isFinite(row.createdAt.getTime())
  )
    throw new Error('receipt_identity');
  // FLAG: Validate the concrete original MAX shape, including every media member.
  // Forward/reply/album/unknown secondary ancestry cannot be inferred from a destination.
  const raw = rawSchema.parse(row.rawPayload);
  const parsed = new WebhookParser().parse(raw, { botId: row.botId! });
  if (
    legacySnapshotDigest(parsed) !== legacySnapshotDigest(row.normalizedPayload) ||
    buildWebhookSemanticEventKey(parsed) !== row.semanticKey
  )
    throw new Error('receipt_projection');
  const chatId = String(raw.message.recipient.chat_id),
    messageId = String(raw.message.body.mid),
    userId = String(raw.message.sender.user_id);
  const sourceAt = parseWebhookEventTimestampMs(raw.message.timestamp),
    eventAt = parseWebhookEventTimestampMs(raw.timestamp);
  if (
    !chatId.startsWith('-') ||
    job.chatId !== chatId ||
    job.messageId !== messageId ||
    sourceAt === null ||
    eventAt === null ||
    sourceAt > eventAt ||
    eventAt > row.createdAt.getTime() ||
    parsed.message?.senderId !== userId ||
    parsed.eventTimestampSource !== 'payload'
  )
    throw new Error('receipt_clock_or_sender');
  const text = raw.message.body.text ?? '';
  if (
    isManagedEntityHandshakeStartCommand(parsed) ||
    /^[/$]/u.test(text.trim()) ||
    parseAdminForwardedModerationCommand(text)
  )
    throw new Error('command_source');
  const photos = raw.message.body.attachments ?? [];
  if (new Set(photos.map((photo) => String(photo.payload.photo_id))).size !== photos.length)
    throw new Error('media_identity');
  if (input.queueName === COMMERCIAL_OCR_QUEUE) {
    const ocr = ocrSchema.parse(job);
    if (
      !photos.length ||
      ocr.imageCount !== photos.length ||
      Date.parse(ocr.sourceCreatedAt) !== sourceAt ||
      Date.parse(resolveCommercialOcrJobEventTimestamp(ocr)) !== eventAt
    )
      throw new Error('ocr_source');
  } else {
    if (Date.parse(job.sourceCreatedAt) !== eventAt) throw new Error('job_source_clock');
    if (input.queueName === PHOTO_DUPLICATE_QUEUE && !photos.length)
      throw new Error('photo_source');
    if (input.queueName === MESSAGE_DUPLICATE_QUEUE) {
      const duplicate = messageSchema.parse(job);
      if (
        duplicate.eventTimestampMs !== eventAt ||
        (duplicate.comparison === 'IMAGE' && !photos.length)
      )
        throw new Error('duplicate_source');
    }
  }
  return {
    webhookEventId: row.id,
    chatId,
    messageId,
    userId,
    sourceAt: new Date(sourceAt).toISOString(),
    receiptSha256: legacySnapshotDigest({
      id: row.id,
      botId: row.botId,
      createdAt: row.createdAt,
      semanticKey: row.semanticKey,
      rawPayload: row.rawPayload,
      normalizedPayload: row.normalizedPayload,
    }),
  };
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('plan_shape');
  return value as Record<string, unknown>;
}
// FLAG: This single-table PK query has no joins/subplans/filters. A pkey label alone
// is insufficient: equality must contain the exact requested ID, before execution.
function exactPlan(value: unknown, id: string) {
  if (!Array.isArray(value) || value.length !== 1) throw new Error('plan_shape');
  const wrapper = object(value[0]),
    root = object(wrapper.Plan);
  const expected = `(id = '${id.replace(/'/gu, "''")}'::text)`;
  if (
    !['Index Scan', 'Index Only Scan'].includes(String(root['Node Type'])) ||
    root['Relation Name'] !== 'webhook_events' ||
    root['Index Name'] !== 'webhook_events_pkey' ||
    root['Index Cond'] !== expected ||
    root.Filter !== undefined ||
    root.Plans !== undefined ||
    root['Scan Direction'] !== 'Forward'
  )
    throw new Error('history_plan');
  return { wrapper, root };
}
function quantity(value: unknown) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0)
    throw new Error('plan_measurement');
  return value;
}
function stablePlan(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stablePlan);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !/Time|Cost/iu.test(key))
      .map(([key, v]) => [key, stablePlan(v)]),
  );
}

/** FLAG: Read-only evidence only. INDEPENDENT never authorizes dropping or replaying a job. */
export async function resolveLegacyRecoverySqlSource(
  tx: Prisma.TransactionClient,
  input: LegacyRecoverySqlSourceInput,
  selectedSources: readonly LegacyRecoverySqlSourceScope[],
  allowance: LegacyRecoverySqlSourceAllowance,
): Promise<LegacyRecoverySqlSourceResult> {
  const cost = { pages: 0, rows: 0, probes: 0, bytes: 0 };
  const plans: LegacyRecoveryLivePlanProof[] = [];
  const issues: LegacyRecoveryLiveIssue[] = [];
  let source: LegacyRecoverySqlSourceResult['source'];
  let decision: LegacyRecoverySqlSourceResult['decision'] = 'DENY';
  let scopeDigest: string | null = null;
  let phase = 'input';
  let queryTimeoutMs = 0;
  const check = () => {
    if (
      !Number.isSafeInteger(allowance.deadlineAtMs) ||
      Date.now() + queryTimeoutMs >= allowance.deadlineAtMs
    )
      throw new Error('deadline');
    for (const key of ['pages', 'rows', 'probes', 'bytes'] as const)
      if (!Number.isSafeInteger(allowance[key]) || allowance[key] < 0 || cost[key] > allowance[key])
        throw new Error('budget');
  };
  try {
    check();
    if (
      allowance.pages < 4 ||
      allowance.rows < 3 ||
      allowance.probes < 3 ||
      allowance.bytes < 16384
    )
      throw new Error('budget');
    const job = parseJob(input);
    if (
      !selectedSources.length ||
      selectedSources.length > 200 ||
      selectedSources.some(
        (scope) =>
          !identifier.safeParse(scope.chatId).success ||
          !identifier.safeParse(scope.messageId).success ||
          !identifier.safeParse(scope.userId).success ||
          !(scope.sourceAt instanceof Date) ||
          !Number.isFinite(scope.sourceAt.getTime()),
      )
    )
      throw new Error('selection');
    scopeDigest = legacySnapshotDigest(
      selectedSources.map((scope) => legacySnapshotDigest(scope)).sort(),
    );
    phase = 'transaction';
    cost.pages++;
    cost.rows++;
    cost.probes++;
    const context = await tx.$queryRaw<
      Array<{ readonly: string; isolation: string; timeout: string }>
    >`
      SELECT current_setting('transaction_read_only') AS readonly,
        current_setting('transaction_isolation') AS isolation,
        current_setting('statement_timeout') AS timeout`;
    cost.bytes += Buffer.byteLength(JSON.stringify(context));
    const timeout = /^(\d+)(ms|s)?$/u.exec(context[0]?.timeout ?? '');
    queryTimeoutMs = timeout ? Number(timeout[1]) * (timeout[2] === 's' ? 1000 : 1) : 0;
    if (
      context.length !== 1 ||
      context[0]?.readonly !== 'on' ||
      context[0]?.isolation !== 'repeatable read' ||
      queryTimeoutMs < 1 ||
      queryTimeoutMs > 5000
    )
      throw new Error('transaction');
    check();
    // FLAG: Never return an oversized body from PostgreSQL; no broad history predicates.
    const statement = Prisma.sql`SELECT id, bot_id AS "botId", created_at AS "createdAt", semantic_key AS "semanticKey",
      (octet_length(raw_payload::text) + octet_length(normalized_payload::text)) AS "payloadBytes",
      CASE WHEN octet_length(raw_payload::text) + octet_length(normalized_payload::text) <= ${PAYLOAD_BYTES}
        THEN raw_payload ELSE NULL END AS "rawPayload",
      CASE WHEN octet_length(raw_payload::text) + octet_length(normalized_payload::text) <= ${PAYLOAD_BYTES}
        THEN normalized_payload ELSE NULL END AS "normalizedPayload"
      FROM webhook_events WHERE id = ${job.webhookEventId}`;
    const querySha256 = legacySnapshotDigest({ sql: statement.sql, values: statement.values });
    phase = 'plan';
    cost.pages++;
    const preflight = await tx.$queryRaw<Array<{ 'QUERY PLAN': unknown }>>(
      Prisma.sql`EXPLAIN (FORMAT JSON) ${statement}`,
    );
    const preflightBytes = Buffer.byteLength(JSON.stringify(preflight));
    cost.bytes += preflightBytes;
    if (preflightBytes > PLAN_BYTES) throw new Error('plan_size');
    exactPlan(preflight[0]?.['QUERY PLAN'], job.webhookEventId);
    check();
    phase = 'measurement';
    cost.pages++;
    const explained = await tx.$queryRaw<Array<{ 'QUERY PLAN': unknown }>>(
      Prisma.sql`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${statement}`,
    );
    const planBytes = Buffer.byteLength(JSON.stringify(explained));
    cost.bytes += planBytes;
    if (planBytes > PLAN_BYTES) throw new Error('plan_size');
    const plan = explained[0]?.['QUERY PLAN'];
    const { root, wrapper } = exactPlan(plan, job.webhookEventId);
    const loops = quantity(root['Actual Loops']);
    const returnedRows = quantity(root['Actual Rows']) * loops;
    const examinedRows =
      (quantity(root['Actual Rows']) +
        quantity(root['Rows Removed by Filter'] ?? 0) +
        quantity(root['Rows Removed by Index Recheck'] ?? 0)) *
      loops;
    const bufferKeys = [
      'Shared Hit Blocks',
      'Shared Read Blocks',
      'Shared Dirtied Blocks',
      'Shared Written Blocks',
      'Local Hit Blocks',
      'Local Read Blocks',
      'Local Dirtied Blocks',
      'Local Written Blocks',
      'Temp Read Blocks',
      'Temp Written Blocks',
    ];
    let blocks = 0;
    for (const row of [root, object(wrapper.Planning ?? {})])
      for (const key of bufferKeys) blocks += quantity(row[key] ?? 0);
    // Charge both ANALYZE and the identical read in this same snapshot, including buffers.
    cost.rows += Math.ceil(examinedRows) * 2;
    cost.probes += Math.ceil(loops) * 2;
    cost.bytes += Math.ceil(blocks * 8192) * 2;
    plans.push({
      descriptor,
      querySha256,
      planSha256: legacySnapshotDigest(stablePlan(plan)),
      indexes: ['webhook_events_pkey'],
      returnedRows,
      examinedRows,
      probes: loops,
    });
    check();
    if (loops !== 1 || returnedRows !== 1 || examinedRows !== 1)
      throw new Error('source_absent_or_unbounded');
    phase = 'source';
    cost.pages++;
    const rows = await tx.$queryRaw<Receipt[]>(statement);
    cost.bytes += Buffer.byteLength(JSON.stringify(rows));
    check();
    const row = rows[0];
    if (
      rows.length !== 1 ||
      !row ||
      !Number.isSafeInteger(row.payloadBytes) ||
      row.payloadBytes < 1 ||
      row.payloadBytes > PAYLOAD_BYTES ||
      row.rawPayload === null ||
      row.normalizedPayload === null
    )
      throw new Error('source_size');
    source = inspectReceipt(row, input, job);
    // FLAG: A global held participant remains related in every chat. Check every scope;
    // status, destination differences, age and missing rows are never independence evidence.
    decision = selectedSources.some(
      (selected) =>
        selected.userId === source!.userId ||
        (selected.chatId === source!.chatId && selected.messageId === source!.messageId),
    )
      ? 'RELATED_UNSUPPORTED'
      : 'INDEPENDENT';
    check();
  } catch {
    decision = 'DENY';
    issues.push({ code: 'SQL_SOURCE_UNPROVED', descriptor: `${descriptor}:${phase}` });
  }
  return {
    decision,
    ...(source ? { source } : {}),
    cost,
    plans,
    issues,
    proofSha256: legacySnapshotDigest({
      version: 1,
      queueName: input.queueName,
      jobId: input.jobId,
      jobPayloadDigest: input.jobPayloadDigest,
      selectionSha256: scopeDigest,
      source: source ?? null,
      decision,
    }),
  };
}
