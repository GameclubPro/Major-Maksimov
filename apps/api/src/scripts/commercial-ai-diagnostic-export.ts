import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  COMMERCIAL_AI_QUALITY_MAX_ENVELOPE_BYTES,
  commercialAiQualityProjectionSchema,
  type CommercialAiQualityAttempt,
  type CommercialAiQualityProjection,
} from '@maxim/contracts/commercial-ai-quality';
import { commercialReviewEvidenceMetadataSchema } from '@maxim/contracts/safety-desk';
import { Prisma } from '../prisma/prisma-client';
import {
  commercialLlmSourceKey,
  commercialLlmSourceSchema,
} from '../moderation/commercial/commercial-llm-enforcement.protocol';
import {
  commercialAiQualityCaptureSchema,
  commercialAiQualityDigest,
  type CommercialAiQualityCapture,
} from './commercial-ai-quality-report';
import { isCommercialCorpusTextSanitized } from './commercial-corpus-sanitization.util';

export const AI_DIAGNOSTIC_PAGE_CAP = 500;
export const AI_DIAGNOSTIC_ROW_CAP = 100_000;
export const AI_DIAGNOSTIC_BYTE_CAP = 48 * 1024 * 1024;
export const AI_DIAGNOSTIC_DEADLINE_MS = 120_000;
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const diagnosticMetadataSchema = commercialReviewEvidenceMetadataSchema.extend({
  logicalMessageKey: digest.nullable(),
  authorGroupId: digest.nullable(),
  campaignGroupId: digest.nullable(),
  campaignGroupIds: z.array(digest).max(32).default([]),
});
const iso = z.string().datetime();
const cursorSchema = z
  .object({ observedAt: iso, id: z.string().regex(/^[a-z0-9_-]{1,100}$/iu) })
  .strict();
export const commercialAiDiagnosticOptionsSchema = z
  .object({
    since: iso,
    until: iso,
    pageSize: z.number().int().min(1).max(AI_DIAGNOSTIC_PAGE_CAP).default(100),
    maxRows: z.number().int().min(1).max(AI_DIAGNOSTIC_ROW_CAP).default(5000),
    maxBytes: z
      .number()
      .int()
      .min(1024)
      .max(AI_DIAGNOSTIC_BYTE_CAP)
      .default(AI_DIAGNOSTIC_BYTE_CAP),
  })
  .strict()
  .refine((value) => {
    const span = Date.parse(value.until) - Date.parse(value.since);
    return span > 0 && span <= 14 * 86_400_000;
  }, 'A diagnostic window must be ordered and no longer than fourteen days.');
export type AiDiagnosticOptions = z.infer<typeof commercialAiDiagnosticOptionsSchema>;
export type AiDiagnosticCursor = z.infer<typeof cursorSchema>;
export type AiDiagnosticPageRequest = AiDiagnosticOptions & { cursor: AiDiagnosticCursor | null };
export type AiDiagnosticRow = {
  id: string;
  observedAt: Date;
  expiresAt: Date;
  updatedAt: Date;
  chatId: string;
  messageId: string;
  source: string;
  evidenceHash: string;
  excerpt: string | null;
  qualityMetadata: unknown;
  llmEnforcement: unknown;
  observationPresent: boolean;
  payloadOversized: boolean;
};

// FLAG: Apply LIMIT to the neutral indexed raw scan, before JSON, source or expiry filtering.
// Rejected/empty output pages still advance using the last raw observedAt/id pair.
export function buildAiDiagnosticPageSql(input: AiDiagnosticPageRequest): Prisma.Sql {
  const { cursor: rawCursor, ...rawOptions } = input;
  const options = commercialAiDiagnosticOptionsSchema.parse(rawOptions);
  const cursor = rawCursor === null ? null : cursorSchema.parse(rawCursor);
  if (
    cursor &&
    (Date.parse(cursor.observedAt) < Date.parse(options.since) ||
      Date.parse(cursor.observedAt) >= Date.parse(options.until))
  )
    throw new Error('Invalid diagnostic cursor window');
  const after = cursor
    ? Prisma.sql`AND (observed_at, id) > (${new Date(cursor.observedAt)}, ${cursor.id})`
    : Prisma.sql``;
  return Prisma.sql`WITH scan_page AS MATERIALIZED (
    SELECT id, observed_at, expires_at, updated_at, chat_id, message_id, source,
      evidence_hash, evidence, quality_metadata, llm_enforcement
    FROM commercial_review_samples
    WHERE observed_at >= ${new Date(options.since)} AND observed_at < ${new Date(options.until)}
      ${after}
    ORDER BY observed_at ASC, id ASC LIMIT ${options.pageSize}
  ) SELECT id, observed_at AS "observedAt", expires_at AS "expiresAt", updated_at AS "updatedAt",
      chat_id AS "chatId", message_id AS "messageId", source, evidence_hash AS "evidenceHash",
      CASE WHEN octet_length(evidence ->> 'excerpt') <= 10000 THEN evidence ->> 'excerpt' ELSE NULL END AS excerpt,
      CASE WHEN octet_length(quality_metadata::text) <= 32768 THEN quality_metadata ELSE NULL END AS "qualityMetadata",
      CASE WHEN octet_length(llm_enforcement::text) <= ${COMMERCIAL_AI_QUALITY_MAX_ENVELOPE_BYTES}
        THEN llm_enforcement ELSE NULL END AS "llmEnforcement",
      llm_enforcement IS NOT NULL AS "observationPresent",
      COALESCE(octet_length(evidence ->> 'excerpt') > 10000, false)
        OR COALESCE(octet_length(quality_metadata::text) > 32768, false)
        OR COALESCE(octet_length(llm_enforcement::text) > ${COMMERCIAL_AI_QUALITY_MAX_ENVELOPE_BYTES}, false)
        AS "payloadOversized"
    FROM scan_page ORDER BY observed_at ASC, id ASC`;
}

const omission = z.enum([
  'EXPIRED',
  'UNSUPPORTED_SOURCE',
  'OVERSIZED_PAYLOAD',
  'METADATA_UNAVAILABLE',
  'SOURCE_INCOMPLETE',
  'TEXT_UNAVAILABLE',
  'PRIVACY_WITHHELD',
  'INVALID_OBSERVATION',
  'SOURCE_BINDING_MISMATCH',
  'INPUT_HASH_MISMATCH',
]);
export const commercialAiDiagnosticLinkSchema = z
  .object({
    captureKey: digest,
    reviewId: z.string().uuid().nullable(),
    observedAt: iso,
    rowUpdatedAt: iso,
    readAt: iso,
    expiresAt: iso,
    sourceSnapshotSha256: digest.nullable(),
    logicalMessageKey: digest.nullable(),
    excerptSha256: digest.nullable(),
    inputBinding: z.enum(['EXACT', 'NO_OBSERVED_INPUT', 'UNAVAILABLE']),
    omission: omission.nullable(),
  })
  .strict();
export type AiDiagnosticLink = z.infer<typeof commercialAiDiagnosticLinkSchema>;
export const commercialAiBlindSourceSchema = z
  .object({
    reviewId: z.string().uuid(),
    text: z.string().min(1).max(2500),
  })
  .strict();
export type AiBlindSource = z.infer<typeof commercialAiBlindSourceSchema>;
export const commercialAiDiagnosticRecordSchema = z
  .object({
    schemaVersion: z.literal('commercial-ai-diagnostic-record/v1'),
    scope: z.literal('RETAINED_CAPTURE_DIAGNOSTIC'),
    populationCoverageAvailable: z.literal(false),
    capture: commercialAiQualityCaptureSchema,
    linkage: commercialAiDiagnosticLinkSchema,
  })
  .strict();

export function aiDiagnosticInputSha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export function mapAiDiagnosticRow(row: AiDiagnosticRow, readAt: number) {
  const metadataResult = diagnosticMetadataSchema.safeParse(row.qualityMetadata);
  const metadata = metadataResult.success ? metadataResult.data : null;
  const parsed = commercialAiQualityProjectionSchema.safeParse(row.llmEnforcement);
  const projection: CommercialAiQualityProjection | null = !row.observationPresent
    ? null
    : parsed.success
      ? parsed.data
      : { schemaVersion: 1, captureState: 'INVALID', coverageIncomplete: true };
  const capture = commercialAiQualityCaptureSchema.parse({
    captureKey: commercialAiQualityDigest(row.id),
    sourceSnapshotSha256: metadata?.sourceSnapshotSha256 ?? null,
    metadata,
    llmEnforcement: projection,
    diagnosticResult: null,
    diagnosticStatus: 'NOT_OBSERVED',
  });
  let reason: z.infer<typeof omission> | null = null;
  if (row.expiresAt.getTime() <= readAt) reason = 'EXPIRED';
  else if (row.source !== 'TEXT') reason = 'UNSUPPORTED_SOURCE';
  else if (row.payloadOversized) reason = 'OVERSIZED_PAYLOAD';
  else if (!metadata?.sourceSnapshotSha256 || !metadata.logicalMessageKey)
    reason = 'METADATA_UNAVAILABLE';
  else if (metadata.sourceExcerptComplete !== true) reason = 'SOURCE_INCOMPLETE';
  else if (!row.excerpt?.trim() || row.excerpt.length > 2500) reason = 'TEXT_UNAVAILABLE';
  else if (!isCommercialCorpusTextSanitized(row.excerpt)) reason = 'PRIVACY_WITHHELD';
  else if (projection?.captureState === 'INVALID') reason = 'INVALID_OBSERVATION';
  const excerptSha256 = reason === null ? aiDiagnosticInputSha256(row.excerpt!) : null;
  if (reason === null && projection?.captureState === 'OBSERVED') {
    const source = projection.source;
    if (
      source.evidenceHash !== row.evidenceHash ||
      source.sourceSnapshotSha256 !== metadata?.sourceSnapshotSha256 ||
      source.logicalMessageKey !== metadata?.logicalMessageKey ||
      source.messageCreatedAt !== metadata?.messageCreatedAt
    )
      reason = 'SOURCE_BINDING_MISMATCH';
    else if (
      source.excerptSha256 !== excerptSha256 ||
      projection.attempts.some((attempt) => attempt.inputSha256 !== excerptSha256)
    )
      reason = 'INPUT_HASH_MISMATCH';
  }
  const link = commercialAiDiagnosticLinkSchema.parse({
    captureKey: capture.captureKey,
    reviewId: null,
    observedAt: row.observedAt.toISOString(),
    rowUpdatedAt: row.updatedAt.toISOString(),
    readAt: new Date(readAt).toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    sourceSnapshotSha256: metadata?.sourceSnapshotSha256 ?? null,
    logicalMessageKey: metadata?.logicalMessageKey ?? null,
    excerptSha256,
    inputBinding:
      reason !== null
        ? 'UNAVAILABLE'
        : projection?.captureState === 'OBSERVED'
          ? 'EXACT'
          : 'NO_OBSERVED_INPUT',
    omission: reason,
  });
  // FLAG: Expired source/decision contents are never exported merely because pruning is late.
  if (reason === 'EXPIRED') {
    capture.metadata = null;
    capture.llmEnforcement = null;
  }
  return { capture, link, text: reason === null ? row.excerpt! : null };
}

export type AiOwnReceiptRequest = {
  captureKey: string;
  chatId: string;
  messageId: string;
  evidenceHash: string;
  attempt: CommercialAiQualityAttempt;
};
export type AiOwnReceiptRow = {
  captureKey: string;
  sourceKey: string;
  intentId: string;
  reasonKey: string;
  ruleCode: string;
  remoteDeleteSucceededAt: Date | null;
  remoteDeleteSucceededBotId: string | null;
  source: unknown;
  observation: unknown;
  moderationDeleteVerified: unknown;
};

// FLAG: Each lookup is an exact unique chat/message intent followed by its exact unique own reason.
// Ordered seeks read at most one indexed candidate; equality outside LIMIT rejects the next key.
// No moderation history scan, shared-success inference, MAX call or persistence occurs here.
export function buildAiOwnReceiptSql(
  requests: (Pick<AiOwnReceiptRequest, 'captureKey' | 'chatId' | 'messageId'> & {
    attempt: Pick<CommercialAiQualityAttempt, 'sourceKey'>;
  })[],
): Prisma.Sql {
  if (!requests.length || requests.length > AI_DIAGNOSTIC_PAGE_CAP * 8)
    throw new Error('Invalid bounded own-receipt request');
  const values = Prisma.join(
    requests.map(
      (request) =>
        Prisma.sql`(${request.captureKey}, ${request.chatId}, ${request.messageId}, ${request.attempt.sourceKey})`,
    ),
  );
  return Prisma.sql`WITH requested(capture_key, chat_id, message_id, source_key) AS (VALUES ${values})
    SELECT requested.capture_key AS "captureKey", requested.source_key AS "sourceKey",
      intent.id AS "intentId", reason.reason_key AS "reasonKey", reason.rule_code AS "ruleCode",
      intent.remote_delete_succeeded_at AS "remoteDeleteSucceededAt",
      intent.remote_delete_succeeded_bot_id AS "remoteDeleteSucceededBotId",
      CASE WHEN octet_length(reason.metadata::text) <= 16384 THEN reason.metadata -> 'commercialLlmSource' ELSE NULL END AS source,
      CASE WHEN octet_length(reason.metadata::text) <= 16384 THEN reason.metadata -> 'commercialAiObservation' ELSE NULL END AS observation,
      reason.metadata -> 'moderationDeleteVerified' AS "moderationDeleteVerified"
    FROM requested
    JOIN LATERAL (SELECT id, chat_id, message_id, remote_delete_succeeded_at, remote_delete_succeeded_bot_id
      FROM moderation_delete_intents WHERE (chat_id, message_id) >= (requested.chat_id, requested.message_id)
      ORDER BY chat_id ASC, message_id ASC LIMIT 1) intent
      ON intent.chat_id = requested.chat_id AND intent.message_id = requested.message_id
    JOIN LATERAL (SELECT intent_id, reason_key, rule_code, metadata FROM moderation_delete_intent_reasons
      WHERE (intent_id, reason_key) >= (intent.id, 'COMMERCIAL_LLM_DELETE:' || requested.source_key)
      ORDER BY intent_id ASC, reason_key ASC LIMIT 1) reason
      ON reason.intent_id = intent.id AND reason.reason_key = 'COMMERCIAL_LLM_DELETE:' || requested.source_key`;
}

export function buildAiDiagnosticExplainSql(options: AiDiagnosticOptions) {
  const page = buildAiDiagnosticPageSql({ ...options, cursor: null });
  const receipt = buildAiOwnReceiptSql([
    {
      captureKey: '0'.repeat(64),
      chatId: 'DIAGNOSTIC_PLAN_CHAT',
      messageId: 'DIAGNOSTIC_PLAN_MESSAGE',
      attempt: { sourceKey: '1'.repeat(64) },
    },
  ]);
  // FLAG: Plain EXPLAIN never executes these exact collection templates or reads source rows.
  return [
    { name: 'neutral-page', sql: Prisma.sql`EXPLAIN (FORMAT JSON) ${page}` },
    { name: 'own-receipt-template', sql: Prisma.sql`EXPLAIN (FORMAT JSON) ${receipt}` },
  ];
}

export function verifyAiOwnReceipt(request: AiOwnReceiptRequest, row: AiOwnReceiptRow) {
  const source = commercialLlmSourceSchema.safeParse(row.source);
  const observation = z
    .object({ evidenceHash: digest, inputSha256: digest })
    .strict()
    .safeParse(row.observation);
  const attempt = request.attempt;
  if (
    !source.success ||
    !observation.success ||
    row.captureKey !== request.captureKey ||
    row.sourceKey !== attempt.sourceKey ||
    row.reasonKey !== `COMMERCIAL_LLM_DELETE:${attempt.sourceKey}` ||
    row.ruleCode !== 'COMMERCIAL_LLM_DELETE' ||
    row.moderationDeleteVerified !== true ||
    !row.remoteDeleteSucceededAt ||
    !Number.isFinite(row.remoteDeleteSucceededAt.getTime()) ||
    !row.remoteDeleteSucceededBotId ||
    attempt.registration.state !== 'REGISTERED' ||
    attempt.registration.intentIdSha256 !== aiDiagnosticInputSha256(row.intentId) ||
    attempt.analysis.policyDeleteEligible !== true ||
    source.data.chatId !== request.chatId ||
    source.data.messageId !== request.messageId ||
    commercialLlmSourceKey(source.data) !== attempt.sourceKey ||
    source.data.version !== attempt.sourceVersion ||
    source.data.nonce !== attempt.nonce ||
    source.data.sourceSha256 !== attempt.sourceSha256 ||
    source.data.settingsSha256 !== attempt.settingsSha256 ||
    source.data.classifierSha256 !== attempt.classifierIdentitySha256 ||
    source.data.eventAtMs !== attempt.eventAtMs ||
    source.data.deadlineAtMs !== attempt.deadlineAtMs ||
    observation.data.evidenceHash !== request.evidenceHash ||
    observation.data.inputSha256 !== attempt.inputSha256
  )
    return null;
  return {
    captureKey: request.captureKey,
    sourceKey: attempt.sourceKey,
    state: 'CONFIRMED_DELETE' as const,
    observedAt: row.remoteDeleteSucceededAt.toISOString(),
    receiptSha256: commercialAiQualityDigest([
      row.intentId,
      row.remoteDeleteSucceededAt.toISOString(),
      row.remoteDeleteSucceededBotId,
    ]),
  };
}

export type AiDiagnosticProgress = {
  runId: string;
  startedAt: string;
  heartbeatAt: string;
  lastSuccessfulSampleAt: string | null;
  scannedRows: number;
  capturedRows: number;
  exportedSources: number;
  bytes: number;
};
export type AiDiagnosticDependencies = {
  loadPage(request: AiDiagnosticPageRequest): Promise<AiDiagnosticRow[]>;
  loadOwnReceipts(requests: AiOwnReceiptRequest[]): Promise<AiOwnReceiptRow[]>;
  append(kind: 'sources' | 'linkage' | 'receipts', value: unknown): Promise<void>;
  progress(value: AiDiagnosticProgress): Promise<void>;
  assertHeld(): void;
  now?(): number;
  reviewId?(): string;
};

export async function collectAiDiagnosticEvidence(
  input: AiDiagnosticOptions,
  dependencies: AiDiagnosticDependencies,
) {
  const options = commercialAiDiagnosticOptionsSchema.parse(input);
  const now = dependencies.now ?? Date.now;
  const started = now();
  if (Date.parse(options.until) > started)
    throw new Error('Diagnostic window must already be closed');
  const deadline = started + AI_DIAGNOSTIC_DEADLINE_MS;
  const runId = randomUUID();
  let cursor: AiDiagnosticCursor | null = null;
  let scannedRows = 0,
    bytes = 0;
  let lastSuccessfulSampleAt: string | null = null;
  let stop: 'COMPLETE' | 'ROW_CAP' | 'BYTE_CAP' | 'DEADLINE' = 'COMPLETE';
  const captures: CommercialAiQualityCapture[] = [];
  const omissions: Record<string, number> = {};
  const sourceRevisions = new Map<string, { hash: string; reviewId: string }>();
  const logicalSources = new Set<string>();
  let duplicateBindingRows = 0,
    ownReceiptReasonProofs = 0,
    ownReceiptLookups = 0,
    ownReceiptsWithheld = 0;
  const physicalReceipts = new Set<string>();
  const progress = () =>
    dependencies.progress({
      runId,
      startedAt: new Date(started).toISOString(),
      heartbeatAt: new Date(now()).toISOString(),
      lastSuccessfulSampleAt,
      scannedRows,
      capturedRows: captures.length,
      exportedSources: sourceRevisions.size,
      bytes,
    });
  await progress();
  while (true) {
    dependencies.assertHeld();
    if (now() >= deadline) {
      stop = 'DEADLINE';
      break;
    }
    if (scannedRows >= options.maxRows) {
      stop = 'ROW_CAP';
      break;
    }
    const pageSize = Math.min(options.pageSize, options.maxRows - scannedRows);
    const rows = await dependencies.loadPage({ ...options, pageSize, cursor });
    dependencies.assertHeld();
    if (rows.length > pageSize) throw new Error('Diagnostic raw page exceeded its limit');
    if (!rows.length) break;
    for (const row of rows) {
      const key = cursorSchema.parse({ observedAt: row.observedAt.toISOString(), id: row.id });
      if (
        Date.parse(key.observedAt) < Date.parse(options.since) ||
        Date.parse(key.observedAt) >= Date.parse(options.until) ||
        (cursor &&
          (key.observedAt < cursor.observedAt ||
            (key.observedAt === cursor.observedAt && key.id <= cursor.id)))
      )
        throw new Error('Diagnostic raw cursor failed to advance');
      cursor = key;
    }
    scannedRows += rows.length;
    const receiptRequests: AiOwnReceiptRequest[] = [];
    for (const row of rows) {
      if (now() >= deadline) {
        stop = 'DEADLINE';
        break;
      }
      const mapped = mapAiDiagnosticRow(row, now());
      const revision = mapped.link.sourceSnapshotSha256;
      if (mapped.text !== null && revision) {
        const previous = sourceRevisions.get(revision);
        if (previous && previous.hash !== mapped.link.excerptSha256)
          throw new Error('Conflicting exact diagnostic source binding');
        mapped.link.reviewId = previous?.reviewId ?? (dependencies.reviewId ?? randomUUID)();
      }
      const record = commercialAiDiagnosticRecordSchema.parse({
        schemaVersion: 'commercial-ai-diagnostic-record/v1',
        scope: 'RETAINED_CAPTURE_DIAGNOSTIC',
        populationCoverageAvailable: false,
        capture: mapped.capture,
        linkage: mapped.link,
      });
      const blindSource =
        mapped.text !== null && revision && !sourceRevisions.has(revision)
          ? commercialAiBlindSourceSchema.parse({
              reviewId: mapped.link.reviewId,
              text: mapped.text,
            })
          : null;
      const payloadBytes =
        Buffer.byteLength(JSON.stringify(mapped.capture)) +
        1 +
        Buffer.byteLength(JSON.stringify(record)) +
        1 +
        (blindSource === null ? 0 : Buffer.byteLength(JSON.stringify(blindSource)) + 1);
      if (bytes + payloadBytes > options.maxBytes) {
        stop = 'BYTE_CAP';
        break;
      }
      bytes += payloadBytes;
      if (mapped.link.logicalMessageKey) logicalSources.add(mapped.link.logicalMessageKey);
      if (mapped.text !== null && revision && sourceRevisions.has(revision)) duplicateBindingRows++;
      if (mapped.link.omission)
        omissions[mapped.link.omission] = (omissions[mapped.link.omission] ?? 0) + 1;
      if (mapped.text !== null && revision && !sourceRevisions.has(revision)) {
        sourceRevisions.set(revision, {
          hash: mapped.link.excerptSha256!,
          reviewId: mapped.link.reviewId!,
        });
        await dependencies.append('sources', blindSource!);
      }
      captures.push(mapped.capture);
      await dependencies.append('linkage', record);
      if (
        mapped.link.inputBinding === 'EXACT' &&
        mapped.capture.llmEnforcement?.captureState === 'OBSERVED'
      )
        for (const attempt of mapped.capture.llmEnforcement.attempts)
          if (attempt.registration.state === 'REGISTERED')
            receiptRequests.push({
              captureKey: mapped.capture.captureKey,
              chatId: row.chatId,
              messageId: row.messageId,
              evidenceHash: row.evidenceHash,
              attempt,
            });
    }
    if (receiptRequests.length && now() < deadline) {
      const receipts = await dependencies.loadOwnReceipts(receiptRequests);
      dependencies.assertHeld();
      if (receipts.length > receiptRequests.length)
        throw new Error('Own-receipt lookup exceeded its exact bounds');
      ownReceiptLookups += receiptRequests.length;
      const requests = new Map(
        receiptRequests.map((request) => [
          `${request.captureKey}:${request.attempt.sourceKey}`,
          request,
        ]),
      );
      const seen = new Set<string>();
      for (const receipt of receipts) {
        const key = `${receipt.captureKey}:${receipt.sourceKey}`;
        const request = requests.get(key);
        if (!request || seen.has(key)) throw new Error('Unexpected duplicate own-receipt lookup');
        seen.add(key);
        const verified = verifyAiOwnReceipt(request, receipt);
        if (verified) {
          const receiptBytes = Buffer.byteLength(JSON.stringify(verified)) + 1;
          if (bytes + receiptBytes > options.maxBytes) {
            ownReceiptsWithheld++;
            stop = 'BYTE_CAP';
            continue;
          }
          bytes += receiptBytes;
          ownReceiptReasonProofs++;
          physicalReceipts.add(verified.receiptSha256);
          await dependencies.append('receipts', verified);
        }
      }
    } else if (receiptRequests.length) {
      ownReceiptsWithheld += receiptRequests.length;
      stop = 'DEADLINE';
    }
    lastSuccessfulSampleAt = new Date(now()).toISOString();
    await progress();
    if (stop !== 'COMPLETE' || rows.length < pageSize) break;
  }
  const finishedAt = new Date(now()).toISOString();
  const evidence = {
    schemaVersion: 'commercial-ai-quality-evidence/v1' as const,
    mode: 'CAPTURE_DIAGNOSTIC' as const,
    evaluatedAt: finishedAt,
    manifest: null,
    manifestSha256: null,
    captures,
    aiReferences: [],
    development: [],
    holdout: [],
    developmentFrame: [],
    holdoutFrame: [],
  };
  return {
    evidence,
    manifest: {
      schemaVersion: 'commercial-ai-diagnostic-export/v1',
      scope: 'RETAINED_CAPTURE_DIAGNOSTIC',
      runId,
      since: options.since,
      until: options.until,
      startedAt: new Date(started).toISOString(),
      finishedAt,
      readConsistency: 'PER_PAGE_READ_ONLY',
      populationCoverageAvailable: false,
      independentHumanEvidence: false,
      scannedRows,
      capturedRows: captures.length,
      uniqueLogicalSources: logicalSources.size,
      uniqueExportedSourceRevisions: sourceRevisions.size,
      duplicateBindingRows,
      omissions,
      ownReceiptLookups,
      ownReceiptsVerified: physicalReceipts.size,
      ownReceiptReasonProofs,
      ownReceiptsWithheld,
      unexportedScannedRows: scannedRows - captures.length,
      bytes,
      stop,
      complete: stop === 'COMPLETE',
      nextCursor: cursor,
      diagnosticReportEffectsRemainUnboundWithoutQualityManifest: true,
    },
  };
}
