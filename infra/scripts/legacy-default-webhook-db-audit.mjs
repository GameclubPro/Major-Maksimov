#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  MAX_LEGACY_JOBS,
  readPrivateSnapshotFile,
} = require('./legacy-default-webhook-queue-retirement.cjs');

const MAX_SUMMARY_BYTES = 16 * 1024;
const AUDIT_NAME = 'legacy_default_webhook_jobs';

export class LegacyDefaultWebhookDbAuditBlockedError extends Error {
  constructor(summary) {
    super('Legacy default webhook jobs still have live database state.');
    this.name = 'LegacyDefaultWebhookDbAuditBlockedError';
    this.summary = summary;
  }
}

function sqlLiteral(value) {
  return `'${value.replaceAll("'", "''")}'`;
}

export function buildLegacyDefaultWebhookDbAuditSql(snapshot) {
  const validated = readPrivateSnapshotFile(snapshot);
  const ids = validated.records.map((record) => record.id);
  const requestedCte =
    ids.length === 0
      ? 'SELECT NULL::text AS id WHERE false'
      : `VALUES\n    ${ids.map((id) => `(${sqlLiteral(id)}::text)`).join(',\n    ')}`;
  return `
SELECT CASE
  WHEN EXISTS (
    SELECT 1
    FROM pg_constraint AS primary_constraint
    JOIN pg_class AS table_relation
      ON table_relation.oid = primary_constraint.conrelid
    JOIN pg_namespace AS table_namespace
      ON table_namespace.oid = table_relation.relnamespace
    JOIN pg_class AS index_relation
      ON index_relation.oid = primary_constraint.conindid
    JOIN pg_index AS primary_index
      ON primary_index.indexrelid = index_relation.oid
      AND primary_index.indrelid = table_relation.oid
    JOIN pg_am AS index_access_method
      ON index_access_method.oid = index_relation.relam
    JOIN pg_attribute AS id_attribute
      ON id_attribute.attrelid = table_relation.oid
      AND id_attribute.attname = 'id'
      AND id_attribute.attnum > 0
      AND NOT id_attribute.attisdropped
    WHERE table_namespace.nspname = 'public'
      AND table_relation.relname = 'webhook_events'
      AND table_relation.relkind IN ('r', 'p')
      AND primary_constraint.conname = 'webhook_events_pkey'
      AND primary_constraint.contype = 'p'
      AND primary_constraint.convalidated
      AND primary_constraint.conkey = ARRAY[id_attribute.attnum]::smallint[]
      AND index_relation.relname = 'webhook_events_pkey'
      AND index_access_method.amname = 'btree'
      AND primary_index.indisprimary
      AND primary_index.indisunique
      AND primary_index.indisvalid
      AND primary_index.indisready
      AND primary_index.indislive
      AND primary_index.indnkeyatts = 1
      AND primary_index.indnatts = 1
      AND primary_index.indpred IS NULL
      AND primary_index.indexprs IS NULL
  ) THEN 'true'
  ELSE 'false'
END AS legacy_default_audit_index_ready \\gset
\\if :legacy_default_audit_index_ready
WITH requested(id) AS MATERIALIZED (
  ${requestedCte}
), matched AS MATERIALIZED (
  SELECT
    requested.id,
    webhook_events.status::text AS status,
    webhook_events.error_message,
    webhook_events.next_enqueue_at
  FROM requested
  LEFT JOIN public.webhook_events AS webhook_events ON webhook_events.id = requested.id
), summary AS (
  SELECT
    count(*)::bigint AS requested_count,
    count(*) FILTER (WHERE status IS NULL)::bigint AS absent_count,
    count(*) FILTER (WHERE status = 'PROCESSED')::bigint AS processed_count,
    count(*) FILTER (WHERE status = 'DUPLICATE')::bigint AS duplicate_count,
    count(*) FILTER (WHERE status = 'RECEIVED')::bigint AS received_count,
    count(*) FILTER (WHERE status = 'QUEUED')::bigint AS queued_count,
    count(*) FILTER (WHERE status = 'FAILED')::bigint AS failed_count,
    count(*) FILTER (
      WHERE status = 'FAILED'
        AND (
          left(coalesce(error_message, ''), 37) = 'WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINED:'
          OR left(coalesce(error_message, ''), 46) =
            'WEBHOOK_HOT_PATH_TIMEOUT_TERMINAL_QUARANTINED:'
        )
    )::bigint AS quarantined_count,
    count(*) FILTER (
      WHERE status = 'FAILED' AND next_enqueue_at IS NOT NULL
    )::bigint AS retryable_failed_count
  FROM matched
)
SELECT json_build_object(
  'schema_version', 1,
  'audit', '${AUDIT_NAME}',
  'requested_count', requested_count,
  'absent_count', absent_count,
  'processed_count', processed_count,
  'duplicate_count', duplicate_count,
  'received_count', received_count,
  'queued_count', queued_count,
  'failed_count', failed_count,
  'quarantined_count', quarantined_count,
  'retryable_failed_count', retryable_failed_count
)::text
FROM summary;
\\else
\\echo 'Required primary-key index is missing; refusing the legacy queue database audit.'
-- FLAG: PostgreSQL 16 psql ignores numeric \\quit arguments. Fail under ON_ERROR_STOP.
SELECT 1 / 0;
\\endif
`;
}

function readInteger(value, field) {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_LEGACY_JOBS) {
    throw new Error(`Legacy default webhook database audit returned invalid ${field}.`);
  }
  return value;
}

function readOwnInteger(record, field) {
  if (!Object.hasOwn(record, field)) {
    throw new Error(`Legacy default webhook database audit omitted ${field}.`);
  }
  return readInteger(record[field], field);
}

export function normalizeLegacyDefaultWebhookDbAuditSummary(raw, expectedCount) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Legacy default webhook database audit returned an invalid summary.');
  }
  if (
    !Object.hasOwn(raw, 'schema_version') ||
    !Object.hasOwn(raw, 'audit') ||
    raw.schema_version !== 1 ||
    raw.audit !== AUDIT_NAME
  ) {
    throw new Error('Legacy default webhook database audit schema is invalid.');
  }
  const summary = Object.freeze({
    schemaVersion: 1,
    audit: AUDIT_NAME,
    requestedCount: readOwnInteger(raw, 'requested_count'),
    absentCount: readOwnInteger(raw, 'absent_count'),
    processedCount: readOwnInteger(raw, 'processed_count'),
    duplicateCount: readOwnInteger(raw, 'duplicate_count'),
    receivedCount: readOwnInteger(raw, 'received_count'),
    queuedCount: readOwnInteger(raw, 'queued_count'),
    failedCount: readOwnInteger(raw, 'failed_count'),
    quarantinedCount: readOwnInteger(raw, 'quarantined_count'),
    retryableFailedCount: readOwnInteger(raw, 'retryable_failed_count'),
  });
  if (
    summary.requestedCount !== expectedCount ||
    summary.absentCount +
      summary.processedCount +
      summary.duplicateCount +
      summary.receivedCount +
      summary.queuedCount +
      summary.failedCount !==
      summary.requestedCount ||
    summary.quarantinedCount > summary.failedCount ||
    summary.retryableFailedCount > summary.failedCount
  ) {
    throw new Error('Legacy default webhook database audit counts are inconsistent.');
  }
  if (
    summary.receivedCount !== 0 ||
    summary.queuedCount !== 0 ||
    summary.failedCount !== 0 ||
    summary.quarantinedCount !== 0 ||
    summary.retryableFailedCount !== 0
  ) {
    throw new LegacyDefaultWebhookDbAuditBlockedError(summary);
  }
  return summary;
}

function readBoundedStdin() {
  const input = readFileSync(0);
  if (input.byteLength === 0 || input.byteLength > MAX_SUMMARY_BYTES) {
    throw new Error('Legacy default webhook database audit output is empty or oversized.');
  }
  return JSON.parse(input.toString('utf8'));
}

function main(argv = process.argv.slice(2)) {
  const [command, snapshotPath] = argv;
  if (!snapshotPath || argv.length !== 2) {
    throw new Error('Legacy default webhook database audit invocation is invalid.');
  }
  if (command === 'validate-snapshot') {
    readPrivateSnapshotFile(snapshotPath);
    return;
  }
  if (command === 'emit-sql') {
    process.stdout.write(buildLegacyDefaultWebhookDbAuditSql(snapshotPath));
    return;
  }
  if (command === 'validate-summary') {
    const snapshot = readPrivateSnapshotFile(snapshotPath);
    const summary = normalizeLegacyDefaultWebhookDbAuditSummary(
      readBoundedStdin(),
      snapshot.records.length,
    );
    process.stdout.write(`${JSON.stringify(summary)}\n`);
    return;
  }
  throw new Error('Unknown legacy default webhook database audit command.');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    main();
  } catch (error) {
    if (error instanceof LegacyDefaultWebhookDbAuditBlockedError) {
      process.stdout.write(`${JSON.stringify(error.summary)}\n`);
      process.exitCode = 3;
    } else {
      process.stderr.write('Legacy default webhook database audit failed closed.\n');
      process.exitCode = 1;
    }
  }
}
