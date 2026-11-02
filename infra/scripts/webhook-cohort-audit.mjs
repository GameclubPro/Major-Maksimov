import { pathToFileURL } from 'node:url';

export function buildWebhookCohortIndexSql() {
  return `SELECT EXISTS (
  SELECT 1 FROM pg_index i
  WHERE i.indexrelid = to_regclass('public.webhook_events_status_created_at_id_idx')
    AND i.indrelid = to_regclass('public.webhook_events')
    AND i.indisvalid AND i.indisready AND i.indislive
    AND i.indnkeyatts = 3 AND i.indnatts = 3
    AND i.indexprs IS NULL AND i.indpred IS NULL
    AND ARRAY(SELECT pg_get_indexdef(i.indexrelid, n, false)
      FROM generate_series(1, 3) n ORDER BY n) = ARRAY['status', 'created_at', 'id']
) AS webhook_cohort_index_ready \\gset
\\if :webhook_cohort_index_ready
\\else
\\echo MAXIM_WEBHOOK_COHORT_INDEX_UNAVAILABLE
SELECT 1 / 0;
\\endif
`;
}

// FLAG: Saved error classifiers are shared verbatim by bounded receipt reports.
// They establish a metadata family only, never an external effect or replay right.
function failureFamilySql(errorExpression) {
  return `CASE
        WHEN ${errorExpression} IS NULL THEN 'missing'
        WHEN ${errorExpression} ~ '^NO_EXECUTABLE_OWNER; deadline=[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$'
          THEN 'no_executable_owner'
        WHEN starts_with(${errorExpression}, 'WEBHOOK_HOT_PATH_TIMEOUT_TERMINAL_QUARANTINED:')
          THEN 'terminal_quarantine_marker'
        WHEN starts_with(${errorExpression}, 'WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINED:')
          THEN 'pending_quarantine_marker'
        WHEN ${errorExpression} ~ '^(Webhook preparation failed: )?Canonical webhook claim is not ready for .+'
          THEN 'canonical_not_ready'
        WHEN ${errorExpression} ~ '^(Webhook preparation failed: )?Canonical webhook business lease is busy for .+'
          THEN 'business_lease_busy'
        WHEN ${errorExpression} ~ '^(Webhook preparation failed: )?Canonical webhook business lease was lost (before completion|before unfenced timeout settlement|during timeout quarantine) for .+'
          THEN 'business_lease_lost'
        WHEN ${errorExpression} ~ '^(Webhook preparation failed: )?Canonical webhook business lease storage is unavailable for .+'
          THEN 'business_lease_unavailable'
        WHEN ${errorExpression} = 'Handler completion claim changed'
          THEN 'completion_claim_changed'
        WHEN ${errorExpression} = 'timeout exceeded when trying to connect'
          THEN 'connection_admission_timeout_text'
        ELSE 'other'
      END`;
}

function pendingQuarantineFamilySql(errorExpression) {
  return `CASE WHEN starts_with(${errorExpression},
      'WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINED:') THEN CASE
      WHEN ${errorExpression} = 'WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINED:LEGACY_EXECUTION_UNVERIFIED; exact effects proof required'
        THEN 'legacy_execution_unverified'
      WHEN ${errorExpression} = 'WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINED:CANONICAL_BUSINESS_ALREADY_STARTED; durable-effects recovery required'
        THEN 'canonical_business_started'
      WHEN ${errorExpression} ~ '^WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINED:[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}: Webhook user-facing hot path timed out after [1-9][0-9]*ms for (message_created|message_edited)([[:space:]]\\|[[:space:]]|;|$)'
        THEN 'detached_timeout'
      WHEN ${errorExpression} ~ '^WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINED:[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}: detached execution completed without a canonical claim: .+'
        THEN 'unclaimed_detached_completed'
      WHEN ${errorExpression} ~ '^WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINED:[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}: detached execution failed without a canonical claim: .+'
        THEN 'unclaimed_detached_failed'
      ELSE 'other_pending'
    END END`;
}

export function buildWebhookCohortAuditSql(explain = false, short = false) {
  if (typeof explain !== 'boolean' || typeof short !== 'boolean')
    throw new Error('Cohort options must be fixed boolean flags');
  // FLAG: A closed receipt-created window includes every status. Bound covered
  // index reads before primary-key metadata fetches; no bodies or identities leave SQL.
  // Cancellation and duplicates are never included in processed-only latency.
  // A short window reduces saturation without raising row, query or time budgets.
  const windowSeconds = short ? 5 : 30;
  const query = `WITH bounds AS MATERIALIZED (
  SELECT statement_timestamp() AT TIME ZONE 'UTC' AS observed_at,
    (statement_timestamp() AT TIME ZONE 'UTC') - interval '${30 + windowSeconds} seconds' AS from_at,
    (statement_timestamp() AT TIME ZONE 'UTC') - interval '30 seconds' AS until_at
), statuses(status) AS (VALUES
  ('RECEIVED'::"WebhookStatus"), ('QUEUED'::"WebhookStatus"),
  ('PROCESSED'::"WebhookStatus"), ('DUPLICATE'::"WebhookStatus"),
  ('FAILED'::"WebhookStatus"), ('NO_REPLAY_HELD'::"WebhookStatus"), ('CANCELLED'::"WebhookStatus"), ('QUARANTINED'::"WebhookStatus")
), candidates AS MATERIALIZED (
  SELECT statuses.status, head.id, head.created_at
  FROM statuses CROSS JOIN bounds
  LEFT JOIN LATERAL (
    SELECT id, created_at FROM webhook_events
    WHERE status = statuses.status AND created_at >= bounds.from_at AND created_at < bounds.until_at
    ORDER BY created_at, id LIMIT 513
  ) head ON true
), samples AS MATERIALIZED (
  SELECT * FROM (
    SELECT *, row_number() OVER (PARTITION BY status ORDER BY created_at, id) AS ordinal
    FROM candidates WHERE id IS NOT NULL
  ) ranked WHERE ordinal <= 512
), details AS MATERIALIZED (
  SELECT samples.status, samples.created_at, metadata.processed_at, metadata.queued_at,
    metadata.next_enqueue_at, metadata.timeout_quarantine_expires_at, metadata.execution_deadline_at,
    CASE WHEN samples.status = 'FAILED' THEN
      ${failureFamilySql('metadata.error_message')}
    END AS failure_family,
    -- FLAG: Exact saved markers distinguish legacy holds from observed timeouts;
    -- neither a marker nor a new receipt proves a new execution or permits replay.
    CASE WHEN samples.status = 'FAILED' THEN
      ${pendingQuarantineFamilySql('metadata.error_message')}
    END AS pending_quarantine_family
  FROM samples CROSS JOIN LATERAL (
    SELECT processed_at, queued_at, next_enqueue_at, timeout_quarantine_expires_at,
      execution_deadline_at, error_message
    FROM webhook_events WHERE id = samples.id OFFSET 0
  ) metadata
), failure_rows AS (
  -- FLAG: Saved text is untrusted diagnostic evidence, never replay authority.
  -- Classify only the already bounded primary-key samples; never emit raw errors.
  SELECT failure_family, count(*) AS sampled,
    count(*) FILTER (WHERE next_enqueue_at IS NOT NULL) AS retry_scheduled,
    count(*) FILTER (WHERE timeout_quarantine_expires_at IS NOT NULL) AS quarantine_timestamp_present,
    count(*) FILTER (WHERE execution_deadline_at <= created_at) AS deadline_elapsed_at_receipt,
    count(*) FILTER (WHERE execution_deadline_at <= bounds.observed_at) AS deadline_elapsed_at_observation
  FROM details CROSS JOIN bounds WHERE status = 'FAILED'
  GROUP BY failure_family
), grouped AS (
  SELECT statuses.status,
    (SELECT count(*) FROM candidates c WHERE c.status = statuses.status AND c.id IS NOT NULL) AS captured,
    count(details.created_at) AS sampled,
    CASE WHEN statuses.status IN ('RECEIVED', 'QUEUED')
      THEN max(extract(epoch FROM bounds.observed_at - details.created_at)) ELSE NULL END AS oldest_pending_age_seconds,
    count(*) FILTER (WHERE details.status = 'PROCESSED' AND
      (processed_at IS NULL OR processed_at < details.created_at OR processed_at > bounds.observed_at)) AS invalid_processed_clocks,
    count(*) FILTER (WHERE queued_at < details.created_at OR queued_at > bounds.observed_at) AS invalid_queued_clocks,
    percentile_cont(0.95) WITHIN GROUP (ORDER BY extract(epoch FROM processed_at - details.created_at) * 1000)
      FILTER (WHERE details.status = 'PROCESSED' AND processed_at >= details.created_at AND processed_at <= bounds.observed_at) AS processed_only_p95_ms,
    percentile_cont(0.99) WITHIN GROUP (ORDER BY extract(epoch FROM processed_at - details.created_at) * 1000)
      FILTER (WHERE details.status = 'PROCESSED' AND processed_at >= details.created_at AND processed_at <= bounds.observed_at) AS processed_only_p99_ms,
    percentile_cont(0.95) WITHIN GROUP (ORDER BY extract(epoch FROM queued_at - details.created_at) * 1000)
      FILTER (WHERE queued_at >= details.created_at AND queued_at <= bounds.observed_at) AS queued_sample_p95_ms,
    percentile_cont(0.99) WITHIN GROUP (ORDER BY extract(epoch FROM queued_at - details.created_at) * 1000)
      FILTER (WHERE queued_at >= details.created_at AND queued_at <= bounds.observed_at) AS queued_sample_p99_ms
  FROM statuses CROSS JOIN bounds LEFT JOIN details ON details.status = statuses.status
  GROUP BY statuses.status
)
SELECT json_build_object(
  'schema_version', 4, 'audit', 'closed_webhook_cohort', 'window_basis', 'receipt_created_at',
  'from', bounds.from_at, 'until', bounds.until_at, 'observed_at', bounds.observed_at,
  'window_seconds', ${windowSeconds},
  'cap_per_status', 512, 'sample_complete', NOT EXISTS (SELECT 1 FROM grouped WHERE captured > 512),
  'nonempty', EXISTS (SELECT 1 FROM samples), 'remote_effects_proven', false,
  'failure_classification_authority', 'saved_metadata_only',
  'pending_quarantine_families', coalesce((SELECT json_agg(json_build_object(
    'family', pending_quarantine_family, 'count_lower_bound', sampled
  ) ORDER BY pending_quarantine_family) FROM (
    SELECT pending_quarantine_family, count(*) AS sampled FROM details
    WHERE pending_quarantine_family IS NOT NULL GROUP BY pending_quarantine_family
  ) quarantine_rows), '[]'::json),
  'failure_families', coalesce((SELECT json_agg(json_build_object(
    'family', failure_family, 'count_lower_bound', sampled,
    'retry_scheduled', retry_scheduled, 'quarantine_timestamp_present', quarantine_timestamp_present,
    'deadline_elapsed_at_receipt', deadline_elapsed_at_receipt,
    'deadline_elapsed_at_observation', deadline_elapsed_at_observation
  ) ORDER BY failure_family) FROM failure_rows), '[]'::json),
  'rows', (SELECT json_agg(json_build_object(
    'status', status, 'count_lower_bound', sampled, 'truncated', captured > 512,
    'oldest_pending_age_seconds', oldest_pending_age_seconds,
    'invalid_processed_clocks', invalid_processed_clocks, 'invalid_queued_clocks', invalid_queued_clocks,
    'processed_only_p95_ms', processed_only_p95_ms, 'processed_only_p99_ms', processed_only_p99_ms,
    'queued_sample_p95_ms', queued_sample_p95_ms, 'queued_sample_p99_ms', queued_sample_p99_ms
  ) ORDER BY status) FROM grouped)
) FROM bounds;`;
  return `${explain ? 'EXPLAIN (FORMAT JSON) ' : ''}${query}\n`;
}

const FAILED_WINDOW_USAGE =
  'Usage: webhook-cohort-audit.mjs [--short] [--explain] | --failed-window FROM UNTIL [--explain]';

export function validateWebhookFailedWindow(from, until) {
  const validMinute = (value) =>
    typeof value === 'string' &&
    /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:00Z$/u.test(value) &&
    !value.startsWith('0000-') &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value.replace('Z', '.000Z');
  if (!validMinute(from) || !validMinute(until))
    throw new Error('Failed window requires two real UTC minutes');
  const windowSeconds = (Date.parse(until) - Date.parse(from)) / 1000;
  if (windowSeconds <= 0 || windowSeconds > 1800)
    throw new Error('Failed window must span more than zero and at most 30 minutes');
  return { from, until, windowSeconds };
}

export function parseWebhookCohortArgs(args) {
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== 'string'))
    throw new Error(FAILED_WINDOW_USAGE);
  let explain = false;
  let short = false;
  let failedWindow = null;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--explain' && !explain) explain = true;
    else if (arg === '--short' && !short) short = true;
    else if (arg === '--failed-window' && failedWindow === null) {
      const from = args[index + 1];
      const until = args[index + 2];
      validateWebhookFailedWindow(from, until);
      failedWindow = { from, until };
      index += 2;
    } else throw new Error(FAILED_WINDOW_USAGE);
  }
  if (short && failedWindow !== null) throw new Error(FAILED_WINDOW_USAGE);
  return { explain, short, failedWindow };
}

export function buildWebhookFailedWindowGuardSql(from, until) {
  validateWebhookFailedWindow(from, until);
  // FLAG: This executed server-clock refusal precedes index admission and EXPLAIN.
  // A WHERE-only clock condition would silently disappear from plain plan admission.
  return `SELECT '${until}'::timestamp <=
    (statement_timestamp() AT TIME ZONE 'UTC') - interval '30 seconds'
    AS webhook_failed_window_closed \\gset
\\if :webhook_failed_window_closed
\\else
\\echo MAXIM_WEBHOOK_FAILED_WINDOW_NOT_CLOSED
SELECT 1 / 0;
\\endif
`;
}

export function buildWebhookFailedWindowIndexSql() {
  // FLAG: Both bounded walks require their exact trusted indexes. Never accept a
  // status-only head, non-PK metadata fallback, INCLUDE, expression or partial index.
  return `WITH expected(name, keys, is_unique, is_primary) AS (VALUES
    ('webhook_events_status_created_at_id_idx', ARRAY['status','created_at','id'], false, false),
    ('webhook_events_pkey', ARRAY['id'], true, true)
  )
SELECT NOT EXISTS (
  SELECT 1 FROM expected e
  LEFT JOIN pg_class i ON i.oid = to_regclass('public.' || e.name)
  LEFT JOIN pg_index s ON s.indexrelid = i.oid
  LEFT JOIN pg_am m ON m.oid = i.relam
  LEFT JOIN pg_class parent ON parent.oid = s.indrelid
  WHERE NOT COALESCE(
    i.relkind = 'i' AND i.reltablespace = 0 AND i.reloptions IS NULL
    AND s.indrelid = to_regclass('public.webhook_events')
    AND parent.relkind = 'r' AND NOT parent.relrowsecurity AND NOT parent.relispartition
    AND NOT EXISTS (SELECT 1 FROM pg_inherits WHERE inhparent = parent.oid OR inhrelid = parent.oid)
    AND s.indisvalid AND s.indisready AND s.indislive AND NOT s.indisexclusion
    AND NOT s.indnullsnotdistinct AND s.indimmediate
    AND s.indisunique = e.is_unique AND s.indisprimary = e.is_primary
    AND m.amname = 'btree' AND s.indnkeyatts = cardinality(e.keys) AND s.indnatts = cardinality(e.keys)
    AND ARRAY(SELECT pg_get_indexdef(i.oid, n, false)
      FROM generate_series(1, s.indnkeyatts) n ORDER BY n) = e.keys
    AND s.indexprs IS NULL AND s.indpred IS NULL
    AND NOT EXISTS (SELECT 1 FROM unnest(s.indoption::smallint[]) v WHERE v <> 0)
    AND NOT EXISTS (SELECT 1 FROM unnest(s.indclass::oid[]) c
      JOIN pg_opclass o ON o.oid = c WHERE NOT o.opcdefault OR o.opcnamespace <> 'pg_catalog'::regnamespace)
    AND NOT EXISTS (SELECT 1 FROM unnest(s.indkey::smallint[], s.indcollation::oid[]) k(attnum, collation_oid)
      LEFT JOIN pg_attribute a ON a.attrelid = s.indrelid AND a.attnum = k.attnum
      WHERE k.collation_oid <> a.attcollation), false)
) AS webhook_failed_window_indexes_ready \\gset
\\if :webhook_failed_window_indexes_ready
\\else
\\echo MAXIM_WEBHOOK_FAILED_WINDOW_INDEX_UNAVAILABLE
SELECT 1 / 0;
\\endif
`;
}

export function buildWebhookFailedWindowAuditSql(from, until, explain = false) {
  const { windowSeconds } = validateWebhookFailedWindow(from, until);
  if (typeof explain !== 'boolean') throw new Error('Failed window explain must be a boolean flag');
  // FLAG: Select at most 513 covered FAILED keys before 512 exact PK reads.
  // On the original table value, inspect compression/physical size before any
  // materialization or text operation: compressed physical size cannot bound decoding.
  // Only admitted text leaves the PK projection; saved metadata grants no replay right.
  const query = `WITH bounds AS MATERIALIZED (
  SELECT '${from}'::timestamp AS from_at, '${until}'::timestamp AS until_at,
    statement_timestamp() AT TIME ZONE 'UTC' AS observed_at
), candidates AS MATERIALIZED (
  SELECT id, created_at FROM public.webhook_events
  WHERE status = 'FAILED'::public."WebhookStatus"
    AND created_at >= '${from}'::timestamp AND created_at < '${until}'::timestamp
  ORDER BY created_at, id LIMIT 513
), samples AS MATERIALIZED (
  SELECT id, created_at FROM candidates ORDER BY created_at, id LIMIT 512
), details AS MATERIALIZED (
  SELECT samples.created_at, metadata.next_enqueue_at, metadata.timeout_quarantine_expires_at,
    metadata.execution_deadline_at, metadata.error_admission,
    CASE WHEN metadata.error_admission IN ('compressed_not_inspected', 'oversized_not_inspected')
      THEN metadata.error_admission
      ELSE ${failureFamilySql('metadata.bounded_error')} END AS failure_family,
    ${pendingQuarantineFamilySql('metadata.bounded_error')} AS pending_quarantine_family
  FROM samples CROSS JOIN LATERAL (
    SELECT next_enqueue_at, timeout_quarantine_expires_at, execution_deadline_at,
      CASE WHEN error_message IS NULL THEN 'null'
        WHEN pg_column_compression(error_message) IS NOT NULL THEN 'compressed_not_inspected'
        WHEN pg_column_size(error_message) > 8192 THEN 'oversized_not_inspected'
        ELSE 'bounded' END AS error_admission,
      CASE WHEN pg_column_compression(error_message) IS NULL
        AND pg_column_size(error_message) <= 8192 THEN error_message
        ELSE NULL END AS bounded_error
    FROM public.webhook_events WHERE id = samples.id OFFSET 0
  ) metadata
), counts AS (
  SELECT (SELECT count(*) FROM candidates) AS captured,
    count(*) AS sampled,
    count(*) FILTER (WHERE error_admission IN
      ('compressed_not_inspected', 'oversized_not_inspected')) AS refused
  FROM details
), failure_rows AS (
  SELECT failure_family, count(*) AS sampled,
    count(*) FILTER (WHERE next_enqueue_at IS NOT NULL) AS retry_scheduled,
    count(*) FILTER (WHERE timeout_quarantine_expires_at IS NOT NULL) AS quarantine_timestamp_present,
    count(*) FILTER (WHERE execution_deadline_at <= created_at) AS deadline_elapsed_at_receipt,
    count(*) FILTER (WHERE execution_deadline_at <= bounds.observed_at) AS deadline_elapsed_at_observation
  FROM details CROSS JOIN bounds GROUP BY failure_family
)
SELECT json_build_object(
  'schema_version', 1, 'audit', 'failed_webhook_window', 'window_basis', 'receipt_created_at',
  'status_scope', 'FAILED', 'from', bounds.from_at, 'until', bounds.until_at,
  'observed_at', bounds.observed_at, 'window_seconds', ${windowSeconds}, 'cap', 512,
  'sampled_count', counts.sampled, 'captured_count_lower_bound', counts.captured,
  'truncated', counts.captured > 512, 'sample_complete', counts.captured <= 512,
  'nonempty', counts.sampled > 0, 'inspection_refused_count', counts.refused,
  'inspection_complete', counts.refused = 0, 'sample_classification_complete', counts.refused = 0,
  'classification_complete', counts.captured <= 512 AND counts.refused = 0,
  'classification_authority', 'saved_metadata_only', 'remote_effects_proven', false,
  'inspection_families', coalesce((SELECT json_agg(json_build_object(
    'family', error_admission, 'count_lower_bound', sampled
  ) ORDER BY error_admission) FROM (
    SELECT error_admission, count(*) AS sampled FROM details GROUP BY error_admission
  ) inspection_rows), '[]'::json),
  'failure_families', coalesce((SELECT json_agg(json_build_object(
    'family', failure_family, 'count_lower_bound', sampled,
    'retry_scheduled', retry_scheduled, 'quarantine_timestamp_present', quarantine_timestamp_present,
    'deadline_elapsed_at_receipt', deadline_elapsed_at_receipt,
    'deadline_elapsed_at_observation', deadline_elapsed_at_observation
  ) ORDER BY failure_family) FROM failure_rows), '[]'::json),
  'pending_quarantine_families', coalesce((SELECT json_agg(json_build_object(
    'family', pending_quarantine_family, 'count_lower_bound', sampled
  ) ORDER BY pending_quarantine_family) FROM (
    SELECT pending_quarantine_family, count(*) AS sampled FROM details
    WHERE pending_quarantine_family IS NOT NULL GROUP BY pending_quarantine_family
  ) quarantine_rows), '[]'::json)
) FROM bounds CROSS JOIN counts;`;
  return `${explain ? 'EXPLAIN (FORMAT JSON) ' : ''}${query}\n`;
}

export function buildWebhookCohortCommandSql(args) {
  const { explain, short, failedWindow } = parseWebhookCohortArgs(args);
  if (failedWindow !== null) {
    const { from, until } = failedWindow;
    return (
      buildWebhookFailedWindowGuardSql(from, until) +
      buildWebhookFailedWindowIndexSql() +
      buildWebhookFailedWindowAuditSql(from, until, explain)
    );
  }
  return buildWebhookCohortIndexSql() + buildWebhookCohortAuditSql(explain, short);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.stdout.write(buildWebhookCohortCommandSql(process.argv.slice(2)));
}
