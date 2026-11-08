import { pathToFileURL } from 'node:url';

export const ACTION_LATENCY_LEGACY_EXTENSION_COLUMNS = Object.freeze([
  'id',
  'source_tag',
  'traffic_class',
  'enqueued_at',
  'last_attempt_at',
  'metadata',
]);
export const ACTION_LATENCY_SCHEDULE_COLUMNS = Object.freeze([
  'scheduled_for_at',
  'schedule_clock_state',
]);
export const ACTION_LATENCY_EXTENSION_COLUMNS = Object.freeze([
  ...ACTION_LATENCY_LEGACY_EXTENSION_COLUMNS,
  ...ACTION_LATENCY_SCHEDULE_COLUMNS,
]);
export const ACTION_LATENCY_COLUMNS = Object.freeze([
  'id',
  'terminal',
  'completed_at',
  'action_type',
  'status',
  'source_tag',
  'traffic_class',
  'enqueued_at',
  'last_attempt_at',
  'scheduled_for_at',
  'schedule_clock_state',
  'metadata',
]);
const ACTIONS = [
  'DELETE_MESSAGE',
  'SEND_MESSAGE',
  'KICK_MEMBER',
  'BAN_MEMBER',
  'UNBAN_MEMBER',
  'TRY_UNBAN_MEMBER',
  'NOTIFY_MODERATORS',
];
const OUTCOMES = ['SUCCEEDED', 'SKIPPED', 'AMBIGUOUS', 'FAILED_RETRYABLE', 'FAILED_TERMINAL'];
export const ACTION_LATENCY_SOURCES = Object.freeze([
  'action_executor_preflight',
  'advertising_placement',
  'callback_answer',
  'channel_auto_post',
  'channel_stats_sync',
  'chat_auto_comment',
  'comment_button_count',
  'comment_notification',
  'commercial_image_ocr',
  'karavan_marketplace_authority',
  'karavan_marketplace_binding_status',
  'karavan_marketplace_publication',
  'karavan_storefront_relay',
  'link_history_recovery',
  'managed_broadcast',
  'managed_handshake',
  'managed_poll',
  'managed_refresh',
  'marketplace_access_refresh',
  'marketplace_history',
  'marketplace_milestone',
  'membership_prewarm',
  'message_duplicate_media',
  'message_retention',
  'moderation_delete',
  'moderation_notice',
  'moderation_sanction',
  'night_mode_transition',
  'publisher_auto_reply',
  'publisher_identity_attestation',
  'publisher_readiness',
  'publisher_start',
  'publisher_user_access',
  'publisher_webhook_reconcile',
  'required_subscription_membership',
  'required_subscription_metadata',
  'suggestion_delivery',
  'vk_parsing',
]);
const literal = (value) => `'${value.replaceAll("'", "''")}'`;
const literals = (values) => values.map(literal).join(',');

export function actionLatencyPrivilegesSql() {
  return `WITH required(column_name) AS (VALUES ${ACTION_LATENCY_COLUMNS.map((c) => `(${literal(c)})`).join(',')})
SELECT NOT EXISTS (
  SELECT 1 FROM required LEFT JOIN pg_attribute a
    ON a.attrelid = to_regclass('public.max_action_ledger')
      AND a.attname = required.column_name AND a.attnum > 0 AND NOT a.attisdropped
  WHERE a.attnum IS NULL OR NOT has_column_privilege(current_user, a.attrelid, a.attnum, 'SELECT')
) AS action_latency_privileges_ready;`;
}

// FLAG: Index names and LIMIT alone do not bound retained history. Attest both
// exact access paths, column types, storage relation and default comparison semantics.
export const actionLatencyIndexesSql = `WITH required(column_name, type_name, modifier) AS (VALUES
  ('id','text',-1),('terminal','boolean',-1),('completed_at','timestamp without time zone',3),
  ('action_type','text',-1),('status','public."MaxActionLedgerStatus"',-1),('source_tag','text',-1),
  ('traffic_class','text',-1),('enqueued_at','timestamp without time zone',3),
  ('last_attempt_at','timestamp without time zone',3),('scheduled_for_at','timestamp without time zone',3),
  ('schedule_clock_state','text',-1),('metadata','jsonb',-1)
), expected(name, keys, options, is_unique, is_primary) AS (VALUES
  ('max_action_ledger_pkey',ARRAY['id'],ARRAY[0]::smallint[],true,true),
  ('max_action_ledger_terminal_completed_id_idx',ARRAY['terminal','completed_at','id'],ARRAY[0,3,3]::smallint[],false,false)
)
SELECT NOT EXISTS (
  SELECT 1 FROM required LEFT JOIN pg_attribute a
    ON a.attrelid = to_regclass('public.max_action_ledger') AND a.attname = required.column_name
      AND a.attnum > 0 AND NOT a.attisdropped
  WHERE a.attnum IS NULL OR a.atttypid IS DISTINCT FROM to_regtype(required.type_name) OR a.atttypmod <> required.modifier
) AND NOT EXISTS (
  SELECT 1 FROM expected e
  LEFT JOIN pg_class i ON i.oid = to_regclass('public.' || e.name)
  LEFT JOIN pg_index s ON s.indexrelid = i.oid
  LEFT JOIN pg_am m ON m.oid = i.relam
  LEFT JOIN pg_class parent ON parent.oid = s.indrelid
  WHERE NOT COALESCE(
    i.relkind = 'i' AND i.reltablespace = 0 AND i.reloptions IS NULL
    AND s.indrelid = to_regclass('public.max_action_ledger')
    AND parent.relkind = 'r' AND NOT parent.relrowsecurity AND NOT parent.relispartition
    AND NOT EXISTS (SELECT 1 FROM pg_inherits WHERE inhparent = parent.oid OR inhrelid = parent.oid)
    AND s.indisvalid AND s.indisready AND s.indislive AND NOT s.indisexclusion
    AND NOT s.indnullsnotdistinct AND s.indimmediate
    AND s.indisunique = e.is_unique AND s.indisprimary = e.is_primary
    AND m.amname = 'btree' AND s.indnkeyatts = cardinality(e.keys) AND s.indnatts = cardinality(e.keys)
    AND ARRAY(SELECT pg_get_indexdef(i.oid,n,false) FROM generate_series(1,s.indnkeyatts) n) = e.keys
    AND ARRAY(SELECT v FROM unnest(s.indoption::smallint[]) v) = e.options
    AND s.indexprs IS NULL AND s.indpred IS NULL
    AND NOT EXISTS (SELECT 1 FROM unnest(s.indclass::oid[]) c JOIN pg_opclass o ON o.oid=c
      WHERE NOT o.opcdefault OR o.opcnamespace <> 'pg_catalog'::regnamespace)
    AND NOT EXISTS (SELECT 1 FROM unnest(s.indkey::smallint[],s.indcollation::oid[]) k(attnum,collation_oid)
      JOIN pg_attribute a ON a.attrelid=s.indrelid AND a.attnum=k.attnum
      WHERE k.collation_oid <> a.attcollation),false)
) AS action_latency_indexes_ready;`;

const clocks = ['ready_to_last_attempt', 'last_attempt_to_terminal', 'ready_to_terminal'];
const aggregate = clocks
  .map(
    (clock) => `count(${clock}) AS ${clock}_count,
    percentile_disc(ARRAY[0.5,0.95,0.99]::double precision[]) WITHIN GROUP (ORDER BY ${clock}) AS ${clock}_percentiles`,
  )
  .join(',\n    ');
const clockObjects = clocks
  .map(
    (clock) => `${literal(clock)},json_build_object(
      'sample_count',${clock}_count,'excluded_count',row_count-${clock}_count,
      'p50_ms',${clock}_percentiles[1],'p95_ms',${clock}_percentiles[2],'p99_ms',${clock}_percentiles[3])`,
  )
  .join(',\n    ');
function dimension(column, values) {
  return `CASE WHEN ${column} IS NULL THEN 'MISSING'
    WHEN pg_column_compression(${column}) IS NULL AND pg_column_size(${column}) <= 80
      THEN CASE WHEN ${column} IN (${literals(values)}) THEN ${column} ELSE 'OTHER' END
    ELSE 'OTHER' END`;
}

export function buildActionLatencyAuditSql(explain = false) {
  // FLAG: Bound the global completion head before any detail or metadata read.
  // Grouping happens after the sentinel and never filters away global saturation.
  // FLAG: Storage admission must surround every JSON operation, including shape
  // checks. Scalar schedule clocks avoid payload inspection; legacy compressed/oversized
  // bodies remain unknown, with no enqueue-time fallback.
  const query = `WITH clock AS MATERIALIZED (SELECT transaction_timestamp() AS observed_at),
heads AS MATERIALIZED (
  SELECT id,completed_at FROM public.max_action_ledger
  WHERE terminal=true
    AND completed_at >= (SELECT observed_at AT TIME ZONE 'UTC' FROM clock)-interval '15 minutes'
    AND completed_at <= (SELECT observed_at AT TIME ZONE 'UTC' FROM clock)
  ORDER BY completed_at DESC,id DESC LIMIT 5001
), samples AS MATERIALIZED (
  SELECT id,completed_at FROM heads ORDER BY completed_at DESC,id DESC LIMIT 5000
), inspected AS MATERIALIZED (
  SELECT samples.completed_at,details.enqueued_at,details.last_attempt_at,details.scheduled_for_at,
    ${dimension('details.action_type', ACTIONS)} AS action,
    CASE WHEN details.status::text IN (${literals(OUTCOMES)}) THEN details.status::text ELSE 'OTHER' END AS outcome,
    ${dimension('details.source_tag', ACTION_LATENCY_SOURCES)} AS source,
    ${dimension('details.traffic_class', ['critical', 'interactive', 'background'])} AS traffic_class,
    CASE WHEN details.schedule_clock_state IS NOT NULL THEN
      CASE WHEN pg_column_compression(details.schedule_clock_state) IS NOT NULL
        OR pg_column_size(details.schedule_clock_state) > 80 THEN 'INVALID_SCALAR_CLOCK'
      ELSE CASE
        WHEN details.schedule_clock_state='UNSCHEDULED' AND details.scheduled_for_at IS NULL THEN 'SCALAR_UNSCHEDULED'
        WHEN details.schedule_clock_state='VALID' AND details.scheduled_for_at IS NOT NULL
          AND isfinite(details.scheduled_for_at) THEN 'SCALAR_VALID'
        WHEN details.schedule_clock_state='INVALID' AND details.scheduled_for_at IS NULL THEN 'SCALAR_INVALID'
        ELSE 'INVALID_SCALAR_CLOCK' END END
      WHEN details.scheduled_for_at IS NOT NULL THEN 'INVALID_SCALAR_CLOCK'
      WHEN details.metadata IS NULL THEN 'ABSENT'
      WHEN pg_column_compression(details.metadata) IS NOT NULL THEN 'COMPRESSED_NOT_INSPECTED'
      WHEN pg_column_size(details.metadata) > 8192 THEN 'OVERSIZED_NOT_INSPECTED'
      ELSE CASE WHEN jsonb_typeof(details.metadata)='object' THEN
        CASE WHEN details.metadata->'scheduledFor' IS NULL OR details.metadata->'scheduledFor'='null'::jsonb THEN 'UNSCHEDULED'
          WHEN jsonb_typeof(details.metadata->'scheduledFor')='string'
            THEN CASE WHEN octet_length(details.metadata->>'scheduledFor') <= 80 THEN 'BOUNDED_SCHEDULE' ELSE 'INVALID_SCHEDULE_SHAPE' END
          ELSE 'INVALID_SCHEDULE_SHAPE' END
        ELSE 'INVALID_METADATA_SHAPE' END END AS metadata_state,
    CASE WHEN details.schedule_clock_state IS NULL AND details.scheduled_for_at IS NULL
      AND pg_column_compression(details.metadata) IS NULL AND pg_column_size(details.metadata) <= 8192
      THEN CASE WHEN jsonb_typeof(details.metadata)='object'
        THEN CASE WHEN jsonb_typeof(details.metadata->'scheduledFor')='string'
          THEN CASE WHEN octet_length(details.metadata->>'scheduledFor') <= 80
            THEN details.metadata->>'scheduledFor' END END END END AS scheduled_for
  FROM samples CROSS JOIN LATERAL (
    SELECT action_type,status,source_tag,traffic_class,enqueued_at,last_attempt_at,scheduled_for_at,schedule_clock_state,metadata
    FROM public.max_action_ledger WHERE id=samples.id OFFSET 0
  ) details
), scheduled AS MATERIALIZED (
  SELECT inspected.*,
    CASE WHEN metadata_state='SCALAR_VALID' THEN scheduled_for_at
      WHEN scheduled_for ~ '^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]([.][0-9]{1,3})?Z$'
      AND left(scheduled_for,4) <> '0000'
      THEN CASE WHEN pg_input_is_valid(scheduled_for,'timestamp with time zone')
        THEN scheduled_for::timestamptz AT TIME ZONE 'UTC' END END AS scheduled_at
  FROM inspected
), readiness AS MATERIALIZED (
  SELECT scheduled.*,
    CASE WHEN enqueued_at IS NULL OR NOT isfinite(enqueued_at) THEN NULL
      WHEN metadata_state IN ('ABSENT','UNSCHEDULED','SCALAR_UNSCHEDULED') THEN enqueued_at
      WHEN metadata_state IN ('BOUNDED_SCHEDULE','SCALAR_VALID') AND scheduled_at IS NOT NULL
        THEN greatest(enqueued_at,scheduled_at) END AS ready_at
  FROM scheduled
), observations AS MATERIALIZED (
  SELECT action,outcome,source,traffic_class,metadata_state,
    CASE WHEN metadata_state='INVALID_SCALAR_CLOCK' THEN 'INVALID_READY_CLOCK'
      WHEN metadata_state='SCALAR_INVALID' THEN 'INVALID_SCHEDULE'
      WHEN metadata_state NOT IN ('ABSENT','UNSCHEDULED','BOUNDED_SCHEDULE','SCALAR_UNSCHEDULED','SCALAR_VALID') THEN 'UNKNOWN_METADATA'
      WHEN metadata_state='BOUNDED_SCHEDULE' AND scheduled_at IS NULL THEN 'INVALID_SCHEDULE'
      WHEN enqueued_at IS NOT NULL AND NOT isfinite(enqueued_at) THEN 'INVALID_READY_CLOCK'
      WHEN ready_at IS NULL THEN 'MISSING_READY_CLOCK'
      WHEN NOT isfinite(ready_at) OR (enqueued_at IS NOT NULL AND NOT isfinite(enqueued_at)) OR ready_at > completed_at THEN 'INVALID_READY_CLOCK'
      ELSE 'KNOWN' END AS readiness_state,
    CASE WHEN isfinite(ready_at) AND isfinite(enqueued_at)
      AND ready_at <= last_attempt_at AND isfinite(last_attempt_at) AND last_attempt_at <= completed_at
      THEN floor(extract(epoch FROM (last_attempt_at-ready_at))*1000)::bigint END AS ready_to_last_attempt,
    CASE WHEN isfinite(last_attempt_at) AND last_attempt_at <= completed_at
      THEN floor(extract(epoch FROM (completed_at-last_attempt_at))*1000)::bigint END AS last_attempt_to_terminal,
    CASE WHEN isfinite(ready_at) AND isfinite(enqueued_at) AND ready_at <= completed_at
      THEN floor(extract(epoch FROM (completed_at-ready_at))*1000)::bigint END AS ready_to_terminal
  FROM readiness
), grouped AS (
  SELECT 'overall'::text AS dimension,'all'::text AS key,count(*) AS row_count,${aggregate}
  FROM observations
  UNION ALL
  SELECT d.dimension,d.key,count(*) AS row_count,${aggregate}
  FROM observations CROSS JOIN LATERAL (VALUES
    ('action',action),('outcome',outcome),('source',source),('traffic_class',traffic_class)
  ) d(dimension,key) GROUP BY d.dimension,d.key
)
SELECT json_build_object('schema_version',1,'audit','action_latency',
  'basis','terminal_outcomes','window_basis','completed_at','action_start_basis','max_enqueued_at_scheduled_for',
  'window_started_at',clock.observed_at-interval '15 minutes','window_ended_at',clock.observed_at,
  'sample_cap',5000,'sample_count',(SELECT count(*) FROM samples),'sample_complete',(SELECT count(*)<=5000 FROM heads),
  'sampled_from',(SELECT min(completed_at) AT TIME ZONE 'UTC' FROM samples),
  'schedule_clock_basis','scalar_with_bounded_legacy_fallback',
  'enqueue_clock_basis','latest_accepted_queue_or_direct_invocation',
  'metadata_max_bytes',8192,'schedule_format','UTC_ISO_8601_MILLISECONDS',
  'metadata_admission',coalesce((SELECT json_agg(x ORDER BY state) FROM
    (SELECT metadata_state AS state,count(*) AS count FROM observations GROUP BY metadata_state)x),'[]'::json),
  'readiness',coalesce((SELECT json_agg(x ORDER BY state) FROM
    (SELECT readiness_state AS state,count(*) AS count FROM observations GROUP BY readiness_state)x),'[]'::json),
  'groups',(SELECT json_agg(json_build_object('dimension',dimension,'key',key,'row_count',row_count,
    ${clockObjects}) ORDER BY dimension,key) FROM grouped),
  'pending_actions_observed',false,'retry_authority',false,'remote_effect_proven',false
) FROM clock;`;
  return `${explain ? 'EXPLAIN (FORMAT JSON) ' : ''}${query}\n`;
}

function guard(sql, variable, failure) {
  return `${sql.replace(/;$/u, '')}\n\\gset\n\\if :${variable}\n\\else\n\\echo ${failure}\nSELECT 1 / 0;\n\\endif\n`;
}
export function emitActionLatencyAuditSql(explain = false) {
  return (
    guard(
      actionLatencyPrivilegesSql(),
      'action_latency_privileges_ready',
      'ACTION_LATENCY_PRIVILEGES_INVALID',
    ) +
    guard(
      actionLatencyIndexesSql,
      'action_latency_indexes_ready',
      'ACTION_LATENCY_INDEXES_INVALID',
    ) +
    buildActionLatencyAuditSql(explain)
  );
}
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length === 1 && args[0] !== '--explain')) {
    process.stderr.write('Usage: action-latency-audit.mjs [--explain]\n');
    process.exitCode = 2;
  } else process.stdout.write(emitActionLatencyAuditSql(args[0] === '--explain'));
}
