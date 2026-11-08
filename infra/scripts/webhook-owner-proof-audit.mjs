import { pathToFileURL } from 'node:url';
import {
  ACTION_LATENCY_LEGACY_EXTENSION_COLUMNS,
  ACTION_LATENCY_SCHEDULE_COLUMNS,
} from './action-latency-audit.mjs';

export const OWNER_PROOF_COLUMNS = Object.freeze({
  webhook_execution_claims: Object.freeze([
    'id',
    'kind',
    'semantic_key',
    'webhook_event_id',
    'execution_bot_id',
    'enforced',
    'status',
    'prepared_at',
    'business_started_at',
    'completed_at',
    'lease_token',
    'lease_expires_at',
    'command_result',
  ]),
  max_action_ledger: Object.freeze([
    'chat_id',
    'action_type',
    'message_id',
    'status',
    'ambiguous',
    'terminal',
    'attempt_count',
    'dispatch_token',
    'dispatch_started_at',
    'dispatch_bot_id',
    'remote_message_id',
    'completed_at',
  ]),
});
const literal = (value) => `'${value.replaceAll("'", "''")}'`;
const ownerValues = Object.entries(OWNER_PROOF_COLUMNS)
  .flatMap(([table, columns]) => columns.map((column) => `(${literal(table)}, ${literal(column)})`))
  .join(',\n  ');

// FLAG: Preserve the exact legacy latency group through source sync and migration.
// Scalar grants form a separate all-or-none group requiring all six legacy columns;
// any latency access requires all original owner-proof columns. Counts never allow
// mixed six-column sets, partial groups, inherited excess or mutation privileges.
export function ownerProofPrivilegesSql(requireAll = false) {
  const values = (columns) =>
    columns.map((column) => `('max_action_ledger', ${literal(column)})`).join(',');
  return `WITH original(table_name, column_name) AS (VALUES ${ownerValues}),
legacy_extension(table_name, column_name) AS (VALUES ${values(ACTION_LATENCY_LEGACY_EXTENSION_COLUMNS)}),
schedule_extension(table_name, column_name) AS (VALUES ${values(ACTION_LATENCY_SCHEDULE_COLUMNS)}),
extension AS (SELECT * FROM legacy_extension UNION ALL SELECT * FROM schedule_extension),
allowed AS (SELECT * FROM original UNION ALL SELECT * FROM extension),
relations AS (SELECT DISTINCT table_name, to_regclass('public.' || table_name) AS oid FROM allowed),
attributes AS MATERIALIZED (
  SELECT r.table_name, r.oid, a.attnum, a.attname,
    has_column_privilege(current_user, r.oid, a.attnum, 'SELECT') AS readable,
    has_column_privilege(current_user, r.oid, a.attnum, 'INSERT,UPDATE,REFERENCES') AS writable
  FROM relations r JOIN pg_attribute a ON a.attrelid = r.oid
  WHERE a.attnum > 0 AND NOT a.attisdropped
), counts AS (
  SELECT (SELECT count(*) FROM attributes a JOIN original o
    ON o.table_name=a.table_name AND o.column_name=a.attname WHERE readable) AS original_count,
  (SELECT count(*) FROM attributes a JOIN legacy_extension e
    ON e.table_name=a.table_name AND e.column_name=a.attname WHERE readable) AS legacy_count,
  (SELECT count(*) FROM attributes a JOIN schedule_extension e
    ON e.table_name=a.table_name AND e.column_name=a.attname WHERE readable) AS schedule_count
)
SELECT NOT EXISTS (
  SELECT 1 FROM relations WHERE oid IS NOT NULL AND
    has_table_privilege(current_user, oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
) AND NOT EXISTS (
  SELECT 1 FROM attributes a WHERE writable OR (readable AND NOT EXISTS (
    SELECT 1 FROM allowed WHERE table_name = a.table_name AND column_name = a.attname))
) AND original_count ${requireAll ? '= 25' : 'IN (0, 25)'}
AND legacy_count IN (0, ${ACTION_LATENCY_LEGACY_EXTENSION_COLUMNS.length})
AND schedule_count IN (0, ${ACTION_LATENCY_SCHEDULE_COLUMNS.length})
AND (schedule_count = 0 OR legacy_count = ${ACTION_LATENCY_LEGACY_EXTENSION_COLUMNS.length})
AND ((legacy_count = 0 AND schedule_count = 0) OR original_count = 25)
AS owner_proof_privileges_ready FROM counts;`;
}

const chatExpression = `COALESCE(NULLIF(btrim(((normalized_payload -> 'message'::text) ->> 'chatId'::text)), ''::text), NULLIF(btrim((normalized_payload ->> 'chatId'::text)), ''::text))`;
const headPredicate = `(((status = ANY (ARRAY['RECEIVED'::"WebhookStatus", 'QUEUED'::"WebhookStatus"])) OR ((status = 'FAILED'::"WebhookStatus") AND ((next_enqueue_at IS NOT NULL) OR ("left"(COALESCE(error_message, ''::text), 37) = 'WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINED:'::text)))) AND (lower(COALESCE(NULLIF(btrim((normalized_payload ->> 'type'::text)), ''::text), NULLIF(btrim((normalized_payload ->> 'update_type'::text)), ''::text))) = ANY (ARRAY['message_created'::text, 'message_edited'::text])))`;
const indexes = [
  ['webhook_events_pkey', 'webhook_events', ['id'], true, true, null, null],
  [
    'webhook_events_status_created_at_id_idx',
    'webhook_events',
    ['status', 'created_at', 'id'],
    false,
    false,
    null,
    null,
  ],
  [
    'webhook_events_ordered_chat_head_idx',
    'webhook_events',
    [chatExpression, 'created_at', 'id'],
    false,
    false,
    chatExpression,
    headPredicate,
  ],
  [
    'webhook_events_status_next_enqueue_at_created_at_idx',
    'webhook_events',
    ['status', 'next_enqueue_at', 'created_at'],
    false,
    false,
    null,
    null,
  ],
  ['webhook_execution_claims_pkey', 'webhook_execution_claims', ['id'], true, true, null, null],
  [
    'webhook_execution_claims_kind_semantic_key',
    'webhook_execution_claims',
    ['kind', 'semantic_key'],
    true,
    false,
    null,
    null,
  ],
  [
    'webhook_execution_claims_event_kind_idx',
    'webhook_execution_claims',
    ['webhook_event_id', 'kind'],
    false,
    false,
    null,
    null,
  ],
  [
    'max_action_ledger_delete_owner_lookup_idx',
    'max_action_ledger',
    ['chat_id', 'action_type', 'message_id', 'status'],
    false,
    false,
    null,
    null,
  ],
];

// FLAG: A matching name or LIMIT cannot prove bounded work. Attest every lookup's
// complete index definition, including partial predicate, collation and live state.
export const ownerProofIndexesSql = `WITH expected(name, parent, keys, is_unique, is_primary, expression, predicate) AS (VALUES
${indexes
  .map(
    ([name, parent, keys, unique, primary, expression, predicate]) =>
      `(${literal(name)}, ${literal(parent)}, ARRAY[${keys.map(literal)}], ${unique}, ${primary}, ${expression === null ? 'NULL' : literal(expression)}, ${predicate === null ? 'NULL' : literal(predicate)})`,
  )
  .join(',\n')}
)
SELECT NOT EXISTS (
  SELECT 1 FROM expected e
  LEFT JOIN pg_class i ON i.oid = to_regclass('public.' || e.name)
  LEFT JOIN pg_index s ON s.indexrelid = i.oid
  LEFT JOIN pg_am m ON m.oid = i.relam
  LEFT JOIN pg_class parent ON parent.oid = s.indrelid
  WHERE NOT COALESCE(
    i.relkind = 'i' AND i.reltablespace = 0 AND i.reloptions IS NULL
    AND s.indrelid = to_regclass('public.' || e.parent)
    AND parent.relkind = 'r' AND NOT parent.relrowsecurity AND NOT parent.relispartition
    AND NOT EXISTS (SELECT 1 FROM pg_inherits WHERE inhparent = parent.oid OR inhrelid = parent.oid)
    AND s.indisvalid AND s.indisready AND s.indislive AND NOT s.indisexclusion
    AND NOT s.indnullsnotdistinct AND s.indimmediate
    AND s.indisunique = e.is_unique AND s.indisprimary = e.is_primary
    AND m.amname = 'btree' AND s.indnkeyatts = cardinality(e.keys) AND s.indnatts = cardinality(e.keys)
    AND ARRAY(SELECT pg_get_indexdef(i.oid, n, false) FROM generate_series(1, s.indnkeyatts) n) = e.keys
    AND pg_get_expr(s.indexprs, s.indrelid) IS NOT DISTINCT FROM e.expression
    AND pg_get_expr(s.indpred, s.indrelid) IS NOT DISTINCT FROM e.predicate
    AND NOT EXISTS (SELECT 1 FROM unnest(s.indoption::smallint[]) v WHERE v <> 0)
    AND NOT EXISTS (SELECT 1 FROM unnest(s.indclass::oid[]) c
      JOIN pg_opclass o ON o.oid = c WHERE NOT o.opcdefault OR o.opcnamespace <> 'pg_catalog'::regnamespace)
    AND NOT EXISTS (SELECT 1 FROM unnest(s.indkey::smallint[], s.indcollation::oid[]) k(attnum, collation_oid)
      LEFT JOIN pg_attribute a ON a.attrelid = s.indrelid AND a.attnum = k.attnum
      WHERE k.collation_oid <> CASE WHEN k.attnum = 0 THEN
        (SELECT typcollation FROM pg_type WHERE oid = 'text'::regtype) ELSE a.attcollation END), false)
) AS owner_proof_indexes_ready;`;

const sourceColumns =
  'id, semantic_key, status, created_at, normalized_payload, processed_at, next_enqueue_at, timeout_quarantine_expires_at, error_message, execution_deadline_at, queue_name, queued_at, enqueue_attempts';
const claimColumns = OWNER_PROOF_COLUMNS.webhook_execution_claims.map((c) => `c.${c}`).join(', ');
const normalizedChat = (alias) =>
  `COALESCE(NULLIF(BTRIM(${alias}.normalized_payload->'message'->>'chatId'), ''), NULLIF(BTRIM(${alias}.normalized_payload->>'chatId'), ''))`;

// FLAG: Inspect only the selected receipt's direct original timestamp. This is clock
// diagnostics, never complete source/cutoff proof; unknown shapes cannot authorize replay.
const sourceClock = (alias) => `(SELECT json_build_object(
  'source_marker', CASE WHEN LOWER(BTRIM(${alias}.normalized_payload->>'eventTimestampSource'))
    IN ('payload','ingress') THEN LOWER(BTRIM(${alias}.normalized_payload->>'eventTimestampSource'))
    ELSE 'unknown' END,
  'raw_object', COALESCE(jsonb_typeof(${alias}.normalized_payload->'raw') = 'object', false),
  'direct_timestamp_shape', CASE WHEN source IS NULL THEN 'unknown'
    WHEN source->'timestamp' IS NULL OR source->'timestamp' = 'null'::jsonb THEN 'missing'
    WHEN jsonb_typeof(source->'timestamp') <> 'number' THEN 'unknown'
    WHEN ms IS NULL OR ms < 1 OR ms > 8640000000000000 THEN 'invalid_numeric'
    ELSE 'numeric' END,
  'direct_receipt_delta_seconds', CASE WHEN ms >= 1 AND ms <= 8640000000000000
    THEN round(ms / 1000 - extract(epoch FROM ${alias}.created_at), 3) ELSE NULL END
) FROM (
  SELECT source, trunc(CASE WHEN n < 10000000000 THEN n * 1000 ELSE n END) AS ms FROM (
    SELECT source, CASE WHEN jsonb_typeof(source->'timestamp') = 'number'
      AND length(source->>'timestamp') <= 32
      AND source->>'timestamp' ~ '^[0-9]+([.][0-9]+)?$'
      THEN (source->>'timestamp')::numeric ELSE NULL END AS n FROM (
      SELECT CASE WHEN jsonb_typeof(${alias}.normalized_payload->'raw') = 'object'
        THEN ${alias}.normalized_payload->'raw'
        WHEN LOWER(BTRIM(${alias}.normalized_payload->>'eventTimestampSource')) = 'payload'
        THEN ${alias}.normalized_payload ELSE NULL END AS source
    ) original
  ) guarded
) clock)`;

// FLAG: Diagnose exactly the first predecessor, including unknown/ineligible heads.
// No historical age, missing claim or missing effect row creates replay authority.
export function buildOwnerProofAuditSql(source = false, retry = false, queued = false) {
  return `WITH oldest_received AS MATERIALIZED (
  SELECT id, created_at, normalized_payload FROM webhook_events
  WHERE ${retry ? `status = 'FAILED'::"WebhookStatus" AND next_enqueue_at IS NOT NULL ORDER BY next_enqueue_at, created_at` : `status = '${queued ? 'QUEUED' : 'RECEIVED'}'::"WebhookStatus" ORDER BY created_at, id`} LIMIT 1
), received_source AS MATERIALIZED (
  SELECT id, created_at, CASE WHEN LOWER(COALESCE(NULLIF(BTRIM(normalized_payload->>'type'), ''),
    NULLIF(BTRIM(normalized_payload->>'update_type'), ''))) = ANY(ARRAY['message_created','message_edited'])
    THEN ${normalizedChat('oldest_received')} ELSE NULL END AS chat_id FROM oldest_received
), predecessor AS MATERIALIZED (
  ${
    source
      ? `SELECT ${sourceColumns} FROM webhook_events WHERE id = (SELECT id FROM oldest_received)`
      : `SELECT p.* FROM received_source r CROSS JOIN LATERAL (
    SELECT ${sourceColumns} FROM webhook_events
    WHERE (
      status = ANY(ARRAY['RECEIVED','QUEUED']::"WebhookStatus"[])
      OR (status = 'FAILED'::"WebhookStatus" AND (next_enqueue_at IS NOT NULL
        OR LEFT(COALESCE(error_message, ''), 37) = 'WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINED:'))
    ) AND LOWER(COALESCE(NULLIF(BTRIM(normalized_payload->>'type'), ''),
      NULLIF(BTRIM(normalized_payload->>'update_type'), ''))) = ANY(ARRAY['message_created','message_edited'])
      AND ${chatExpression} = r.chat_id AND (created_at, id) < (r.created_at, r.id)
    ORDER BY created_at, id LIMIT 1
  ) p`
  }
), semantic_claim AS MATERIALIZED (
  SELECT c.id FROM predecessor p JOIN webhook_execution_claims c
    ON c.kind = 'EXECUTION' AND c.semantic_key = p.semantic_key
), linked_claims AS MATERIALIZED (
  SELECT linked.id FROM predecessor p CROSS JOIN LATERAL (
    SELECT id FROM webhook_execution_claims
    WHERE webhook_event_id = p.id AND kind = 'EXECUTION' LIMIT 2
  ) linked
), chosen_claim AS MATERIALIZED (
  SELECT id FROM semantic_claim UNION ALL
  SELECT id FROM linked_claims WHERE NOT EXISTS (SELECT 1 FROM semantic_claim)
    AND (SELECT count(*) FROM linked_claims) = 1
), claim AS MATERIALIZED (
  SELECT ${claimColumns} FROM chosen_claim k JOIN webhook_execution_claims c ON c.id = k.id
), owner AS MATERIALIZED (
  SELECT ${sourceColumns
    .split(', ')
    .map((c) => `e.${c}`)
    .join(', ')}
  FROM claim c JOIN webhook_events e ON e.id = c.webhook_event_id
), effect_source AS MATERIALIZED (
  SELECT ${normalizedChat('p')} AS chat_id,
    COALESCE(NULLIF(BTRIM(p.normalized_payload->'message'->>'messageId'), ''),
      NULLIF(BTRIM(p.normalized_payload->'message'->>'message_id'), ''),
      NULLIF(BTRIM(p.normalized_payload->>'messageId'), ''),
      NULLIF(BTRIM(p.normalized_payload->>'message_id'), '')) AS message_id
  FROM predecessor p
), delete_observations AS MATERIALIZED (
  SELECT l.* FROM effect_source s CROSS JOIN LATERAL (
    SELECT status, ambiguous, terminal, attempt_count, dispatch_token IS NOT NULL AS dispatch_token_present,
      dispatch_started_at, dispatch_bot_id IS NOT NULL AS dispatch_bot_present,
      remote_message_id IS NOT NULL AS remote_receipt_present, completed_at
    FROM max_action_ledger WHERE chat_id = s.chat_id AND action_type = 'DELETE_MESSAGE'
      AND message_id = s.message_id LIMIT 17
  ) l
), checks AS MATERIALIZED (
  SELECT p.id AS predecessor_id, p.semantic_key AS predecessor_semantic_key,
    c.*, o.id AS owner_id, o.status AS owner_status, o.processed_at AS owner_processed_at,
    o.semantic_key AS owner_semantic_key,
    COALESCE(jsonb_typeof(c.command_result) = 'object', false) AS journal_object,
    COALESCE(c.command_result->>'kind' = 'EXECUTION_FINISHED', false) AS journal_kind_matches,
    COALESCE(c.command_result->>'authorityVersion' = 'semantic-owner-lease-v1', false) AS journal_version_matches,
    COALESCE(c.command_result->'webhookEventId' = to_jsonb(o.id), false) AS journal_owner_matches,
    COALESCE(c.command_result->'semanticKey' = to_jsonb(c.semantic_key), false) AS journal_semantic_matches,
    COALESCE(c.command_result->'executionBotId' = COALESCE(to_jsonb(c.execution_bot_id), 'null'::jsonb), false) AS journal_executor_matches,
    COALESCE(c.command_result->'businessStartedAt' = to_jsonb(to_char(c.business_started_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')), false) AS journal_started_matches,
    COALESCE(jsonb_typeof(c.command_result->'finishedAt') = 'string', false) AS journal_finished_string,
    ((c.lease_token IS NULL) = (c.lease_expires_at IS NULL))
      AND (c.lease_token IS NULL OR BTRIM(c.lease_token) <> '') AS lease_pair_valid
  FROM predecessor p LEFT JOIN claim c ON TRUE LEFT JOIN owner o ON TRUE
)
SELECT json_build_object(
  'schema_version', 1, 'audit', 'webhook_owner_proof', 'sampled_at', statement_timestamp(),
  'read_only', current_setting('transaction_read_only') = 'on',
  'scope', '${queued ? 'oldest_queued_own_claim' : retry ? 'earliest_scheduled_retry_own_claim' : source ? 'oldest_received_own_claim' : 'oldest_received_first_predecessor'}', 'authority', 'DIAGNOSTICS_ONLY',
  'settlement_authorized', false, 'semantic_source_rebuild', 'not_evaluated',
  'finished_timestamp_validation', 'not_evaluated', 'effect_completeness', 'unknown',
  'sample_caps', json_build_object('received', 1, 'predecessor', 1, 'semantic_claim', 1,
    'linked_claims', 2, 'owner', 1, 'delete_observations', 16),
  'classification', CASE
    WHEN NOT EXISTS (SELECT 1 FROM oldest_received) THEN '${queued ? 'no_queued' : retry ? 'no_scheduled_retry' : 'no_received'}'
    WHEN ${source ? 'false' : 'true'} AND NOT EXISTS (SELECT 1 FROM received_source WHERE chat_id IS NOT NULL) THEN 'source_unknown'
    WHEN x.predecessor_id IS NULL THEN 'no_predecessor'
    WHEN (SELECT count(*) FROM linked_claims) > 1 THEN 'multiple_linked_claims'
    WHEN x.id IS NULL THEN 'claim_missing'
    WHEN x.owner_id IS NULL THEN 'owner_missing'
    WHEN x.owner_id <> x.predecessor_id THEN 'different_canonical_owner'
    WHEN x.predecessor_semantic_key IS NULL OR x.owner_semantic_key IS DISTINCT FROM x.semantic_key THEN 'stored_semantic_mismatch'
    WHEN x.enforced IS NOT TRUE THEN 'unenforced_claim'
    WHEN x.status = 'COMPLETED' THEN 'claim_completed_requires_receipt_reconciliation'
    WHEN x.business_started_at IS NULL THEN 'business_start_unrecorded'
    WHEN x.status IS DISTINCT FROM 'READY' OR x.completed_at IS NOT NULL THEN 'claim_not_ready'
    WHEN x.prepared_at IS NULL OR NOT isfinite(x.prepared_at) OR NOT isfinite(x.business_started_at)
      OR NOT x.lease_pair_valid OR (x.lease_expires_at IS NOT NULL AND NOT isfinite(x.lease_expires_at))
      OR (x.execution_bot_id IS NOT NULL AND BTRIM(x.execution_bot_id) = '') THEN 'preparation_or_lease_invalid'
    WHEN x.owner_status IS NULL OR x.owner_status NOT IN ('RECEIVED','QUEUED','FAILED') OR x.owner_processed_at IS NOT NULL THEN 'receipt_not_unsettled'
    WHEN NOT (x.journal_object AND x.journal_kind_matches AND x.journal_version_matches
      AND x.journal_owner_matches AND x.journal_semantic_matches AND x.journal_executor_matches
      AND x.journal_started_matches AND x.journal_finished_string) THEN 'finished_checkpoint_missing_or_mismatched'
    ELSE 'finished_checkpoint_candidate_requires_runtime_validation' END,
  'predecessor', (SELECT json_build_object(
    'receipt_semantic_family', CASE
      WHEN starts_with(semantic_key, 'publisher-observation:v1:') THEN 'publisher_observation'
      WHEN starts_with(semantic_key, 'message:message_created:') OR
        starts_with(semantic_key, 'message:message_edited:') THEN 'moderation_message'
      ELSE 'other_or_missing' END,
    'event_type', CASE WHEN normalized_payload->>'type' IN ('message_created','message_edited','user_added','user_removed','message_callback','chat_title_changed','bot_added','bot_removed','message_removed') THEN normalized_payload->>'type' ELSE 'other' END,
    'next_retry_at', next_enqueue_at,
    'execution_deadline_at', execution_deadline_at, 'queued_at', queued_at,
    'enqueue_attempts', enqueue_attempts,
    'deadline_elapsed', execution_deadline_at <= statement_timestamp(),
    'queue_family', CASE
      WHEN queue_name LIKE 'moderation-join%' THEN 'moderation-join'
      WHEN queue_name LIKE 'moderation-critical%' THEN 'moderation-critical'
      WHEN queue_name LIKE 'moderation-default%' THEN 'moderation-default'
      WHEN queue_name LIKE 'moderation-realtime%' THEN 'moderation-realtime'
      WHEN queue_name IS NULL THEN 'absent' ELSE 'other' END,
    'created_at', created_at, 'status', CASE WHEN status::text IN ('RECEIVED','QUEUED','FAILED') THEN status::text ELSE 'unknown' END,
    'legacy_unverified_marker', error_message = 'WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINED:LEGACY_EXECUTION_UNVERIFIED; exact effects proof required',
    'retry_scheduled', next_enqueue_at IS NOT NULL, 'timeout_quarantine_present', timeout_quarantine_expires_at IS NOT NULL,
    'processed', processed_at IS NOT NULL,
    'preparation_lease_failure', error_message LIKE 'Webhook preparation failed: Webhook preparation lease was lost before READY%',
    'ambiguous_error_marker', COALESCE(error_message, '') ILIKE '%ambiguous%') FROM predecessor),
  'canonical_owner', (SELECT json_build_object(
    'status', status::text, 'created_at', created_at,
    'source_clock', ${sourceClock('owner')},
    'legacy_unverified_marker', error_message = 'WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINED:LEGACY_EXECUTION_UNVERIFIED; exact effects proof required',
    'processed', processed_at IS NOT NULL,
    'retry_scheduled', next_enqueue_at IS NOT NULL,
    'timeout_quarantine_present', timeout_quarantine_expires_at IS NOT NULL,
    'ambiguous_error_marker', COALESCE(error_message, '') ILIKE '%ambiguous%',
    'preparation_lease_failure', error_message LIKE 'Webhook preparation failed: Webhook preparation lease was lost before READY%',
    'error_family', CASE
      WHEN error_message IS NULL THEN 'absent'
      WHEN error_message LIKE 'Webhook preparation deferred: Terminal canonical owner requires proof recovery%' THEN 'terminal_canonical_owner'
      WHEN error_message LIKE 'Webhook preparation failed:%' THEN 'preparation_failed'
      WHEN error_message LIKE 'Webhook preparation deferred:%' THEN 'preparation_deferred'
      WHEN error_message LIKE 'WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINED:%' THEN 'timeout_quarantined'
      ELSE 'other' END) FROM owner),
  'claim', json_build_object('present', x.id IS NOT NULL, 'owner_present', x.owner_id IS NOT NULL,
    'owner_same_as_predecessor', x.owner_id = x.predecessor_id,
    'owner_semantic_matches', x.owner_semantic_key = x.semantic_key,
    'source_semantic_matches', x.predecessor_semantic_key = x.semantic_key,
    'linked_count_lower_bound', (SELECT count(*) FROM linked_claims),
    'linked_limit_reached', (SELECT count(*) FROM linked_claims) = 2,
    'enforced', x.enforced, 'status', CASE WHEN x.status::text IN ('PENDING','READY','COMPLETED') THEN x.status::text ELSE 'unknown' END,
    'prepared', x.prepared_at IS NOT NULL, 'business_started', x.business_started_at IS NOT NULL,
    'completed', x.completed_at IS NOT NULL,
    'business_started_at', x.business_started_at,
    'execution_waiting_marker', COALESCE(x.command_result->>'kind' = 'EXECUTION_WAITING', false),
    'executor_valid', x.execution_bot_id IS NULL OR BTRIM(x.execution_bot_id) <> '',
    'lease', CASE WHEN x.id IS NULL THEN 'unknown' WHEN NOT x.lease_pair_valid THEN 'malformed'
      WHEN x.lease_token IS NULL THEN 'absent' WHEN x.lease_expires_at > statement_timestamp() THEN 'live' ELSE 'expired' END),
  'checkpoint', json_build_object('object', x.journal_object, 'kind_matches', x.journal_kind_matches,
    'version_matches', x.journal_version_matches, 'owner_matches', x.journal_owner_matches,
    'semantic_matches', x.journal_semantic_matches, 'executor_matches', x.journal_executor_matches,
    'business_started_matches', x.journal_started_matches, 'finished_at_string', x.journal_finished_string),
  'delete_effect_observations', json_build_object(
    'scope', 'predecessor_message_not_exact_execution',
    'source_available', EXISTS (SELECT 1 FROM effect_source WHERE chat_id IS NOT NULL AND message_id IS NOT NULL),
    'row_count_lower_bound', (SELECT count(*) FROM delete_observations),
    'truncated', (SELECT count(*) > 16 FROM delete_observations),
    'any_succeeded', EXISTS (SELECT 1 FROM delete_observations WHERE status = 'SUCCEEDED'),
    'any_ambiguous', EXISTS (SELECT 1 FROM delete_observations WHERE ambiguous OR status = 'AMBIGUOUS'),
    'any_dispatch_fence', EXISTS (SELECT 1 FROM delete_observations WHERE dispatch_token_present OR dispatch_started_at IS NOT NULL OR dispatch_bot_present),
    'any_remote_receipt', EXISTS (SELECT 1 FROM delete_observations WHERE remote_receipt_present),
    'any_completed', EXISTS (SELECT 1 FROM delete_observations WHERE completed_at IS NOT NULL),
    'any_attempted', EXISTS (SELECT 1 FROM delete_observations WHERE attempt_count > 0),
    'any_terminal', EXISTS (SELECT 1 FROM delete_observations WHERE terminal),
    'absence_proves_no_effects', false),
  'send_and_sanction_coverage', 'unavailable_without_exact_action_keys'
) FROM (SELECT 1) singleton LEFT JOIN checks x ON TRUE;`;
}

export const ownerProofAuditSql = buildOwnerProofAuditSql();

function guard(sql, variable, failure) {
  return `${sql.replace(/;$/u, '')}\n\\gset\n\\if :${variable}\n\\else\n\\echo ${failure}\nSELECT 1 / 0;\n\\endif\n`;
}

export function emitOwnerProofPrivilegesSql(requireAll = false) {
  return guard(
    ownerProofPrivilegesSql(requireAll),
    'owner_proof_privileges_ready',
    'WEBHOOK_OWNER_PROOF_PRIVILEGES_INVALID',
  );
}

export function emitOwnerProofAuditSql(
  explain = false,
  source = false,
  retry = false,
  queued = false,
) {
  return `SET LOCAL timezone = 'UTC';\n${emitOwnerProofPrivilegesSql(true)}${guard(ownerProofIndexesSql, 'owner_proof_indexes_ready', 'WEBHOOK_OWNER_PROOF_INDEXES_INVALID')}${explain ? 'EXPLAIN (FORMAT JSON) ' : ''}${buildOwnerProofAuditSql(source, retry, queued)}\n`;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const args = process.argv.slice(2);
  if (
    args.length > 2 ||
    new Set(args).size !== args.length ||
    args.some(
      (arg) => !['--explain', '--privileges', '--source', '--retry', '--queued'].includes(arg),
    ) ||
    (args.includes('--privileges') && args.length !== 1) ||
    args.filter((arg) => ['--source', '--retry', '--queued'].includes(arg)).length > 1
  ) {
    process.stderr.write(
      'Usage: webhook-owner-proof-audit.mjs [--source|--retry|--queued] [--explain] | --privileges\n',
    );
    process.exitCode = 2;
  } else {
    process.stdout.write(
      args[0] === '--privileges'
        ? emitOwnerProofPrivilegesSql()
        : emitOwnerProofAuditSql(
            args.includes('--explain'),
            args.includes('--source') || args.includes('--retry') || args.includes('--queued'),
            args.includes('--retry'),
            args.includes('--queued'),
          ),
    );
  }
}
