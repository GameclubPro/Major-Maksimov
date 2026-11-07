import { pathToFileURL } from 'node:url';
import { PUBLISHER_SLOT_AUDIT_COLUMNS } from './publisher-slot-audit.mjs';

export const PUBLISHER_PUBLICATION_AUDIT_COLUMNS = {
  publications: [
    'id',
    'actor_user_id',
    'lifecycle',
    'audience_mode',
    'audience_selection',
    'dispatch_profile',
    'required_bot_id',
  ],
  publication_schedules: ['id', 'mode', 'status', 'revision'],
  publication_occurrences: [
    'id',
    'publication_id',
    'schedule_id',
    'status',
    'scheduled_at',
    'dispatch_profile',
    'required_bot_id',
    'dispatch_blocker_code',
  ],
  publication_targets: ['publication_id', 'target_chat_id', 'entity_type', 'position'],
  managed_entity_access_edges: [
    'chat_id',
    'user_id',
    'bot_id',
    'state',
    'user_role',
    'entity_type',
    'checked_at',
    'expires_at',
    'denied_reason',
  ],
  managed_bot_chat_catalog: ['bot_id', 'chat_id', 'status', 'entity_type'],
  managed_broadcast_deliveries: [
    'publication_occurrence_id',
    'created_at',
    'status',
    'attempt_count',
    'remote_message_id',
  ],
  chats: ['id', 'entity_type'],
};

export function buildPublisherPublicationPrivilegesSql(requireAll = false) {
  const allowedColumns = Object.fromEntries(
    [
      ...new Set([
        ...Object.keys(PUBLISHER_PUBLICATION_AUDIT_COLUMNS),
        ...Object.keys(PUBLISHER_SLOT_AUDIT_COLUMNS),
      ]),
    ].map((table) => [
      table,
      [
        ...(PUBLISHER_PUBLICATION_AUDIT_COLUMNS[table] ?? []),
        ...(PUBLISHER_SLOT_AUDIT_COLUMNS[table] ?? []),
      ],
    ]),
  );
  const allowed = Object.entries(allowedColumns)
    .flatMap(([table, columns]) => columns.map((column) => `('${table}', '${column}')`))
    .join(',\n');
  const required = Object.entries(PUBLISHER_PUBLICATION_AUDIT_COLUMNS)
    .flatMap(([table, columns]) => columns.map((column) => `('${table}', '${column}')`))
    .join(',');
  return `WITH allowed(table_name, column_name) AS (VALUES ${allowed}), required(table_name, column_name) AS (VALUES ${required})
SELECT NOT EXISTS (
  SELECT 1 FROM pg_class relation
  JOIN pg_namespace ns ON ns.oid = relation.relnamespace
  JOIN pg_attribute attribute ON attribute.attrelid = relation.oid
  WHERE ns.nspname = 'public' AND relation.relname IN (SELECT table_name FROM allowed)
    AND attribute.attnum > 0 AND NOT attribute.attisdropped
    AND has_column_privilege('maxim_audit', relation.oid, attribute.attnum, 'SELECT')
    AND NOT EXISTS (SELECT 1 FROM allowed
      WHERE table_name = relation.relname AND column_name = attribute.attname)
) AND (${requireAll ? 'true' : 'false'} = false OR NOT EXISTS (
  SELECT 1 FROM required allowed
  LEFT JOIN pg_class relation ON relation.oid = to_regclass('public.' || allowed.table_name)
  LEFT JOIN pg_attribute attribute ON attribute.attrelid = relation.oid
    AND attribute.attname = allowed.column_name AND NOT attribute.attisdropped
  WHERE attribute.attnum IS NULL OR NOT has_column_privilege('maxim_audit', relation.oid, attribute.attnum, 'SELECT')
)) AS publisher_publication_audit_ready \\gset
\\if :publisher_publication_audit_ready
\\else
\\echo 'Publisher publication metadata privileges are missing or excessive; refusing diagnostics.'
-- FLAG: PostgreSQL 16 psql ignores numeric \\quit arguments. Fail under ON_ERROR_STOP.
SELECT 1 / 0;
\\endif
`;
}

export function buildPublisherPublicationIndexReadinessSql() {
  const indexes = [
    ['publication_occurrences_dispatch_status_scheduled_idx', 'publication_occurrences'],
    ['publications_pkey', 'publications'],
    ['publication_schedules_pkey', 'publication_schedules'],
    ['publication_targets_publication_position_key', 'publication_targets'],
    ['managed_entity_access_edges_pkey', 'managed_entity_access_edges'],
    ['managed_bot_chat_catalog_pkey', 'managed_bot_chat_catalog'],
    ['publisher_entity_bindings_pkey', 'publisher_entity_bindings'],
    ['managed_entity_publication_policies_pkey', 'managed_entity_publication_policies'],
    ['chats_pkey', 'chats'],
    ['managed_broadcast_deliveries_pub_occurrence_created_id_idx', 'managed_broadcast_deliveries'],
  ];
  return `WITH required(index_name, table_name) AS (VALUES ${indexes.map(([index, table]) => `('${index}', '${table}')`).join(',')})
SELECT NOT EXISTS (
  SELECT 1 FROM required LEFT JOIN pg_index definition
    ON definition.indexrelid = to_regclass('public.' || required.index_name)
      AND definition.indrelid = to_regclass('public.' || required.table_name)
      AND definition.indisvalid AND definition.indisready
  WHERE definition.indexrelid IS NULL
) AS publisher_publication_indexes_ready \\gset
\\if :publisher_publication_indexes_ready
\\else
\\echo 'Required publication audit indexes are unavailable; refusing an unindexed scan.'
-- FLAG: PostgreSQL 16 psql ignores numeric \\quit arguments. Fail under ON_ERROR_STOP.
SELECT 1 / 0;
\\endif
`;
}

export function buildPublisherPublicationsAuditSql(explain = false) {
  // FLAG: Bound every source before filtering or aggregating. No content, identifiers,
  // free-form errors or permission payloads may leave this fixed catalog query.
  const query = `WITH statuses(status) AS (
  VALUES ('SCHEDULED'::"PublicationOccurrenceStatus"), ('IN_PROGRESS'::"PublicationOccurrenceStatus"),
    ('AMBIGUOUS'::"PublicationOccurrenceStatus"), ('FAILED'::"PublicationOccurrenceStatus")
), occurrence_candidates AS MATERIALIZED (
  SELECT sample.* FROM statuses
  CROSS JOIN LATERAL (
    SELECT id, publication_id, schedule_id, status, scheduled_at,
      required_bot_id, dispatch_blocker_code
    FROM publication_occurrences
    WHERE dispatch_profile = 'PUBLIK_V1'::"PublicationDispatchProfile"
      AND status = statuses.status AND scheduled_at <= (statement_timestamp() AT TIME ZONE 'UTC')
    ORDER BY scheduled_at ASC
    LIMIT 33
  ) sample
), occurrence_sample AS MATERIALIZED (
  SELECT * FROM (
    SELECT *, row_number() OVER (PARTITION BY status ORDER BY scheduled_at, id) AS sample_rank
    FROM occurrence_candidates
  ) ranked WHERE sample_rank <= 32
), scoped AS MATERIALIZED (
  SELECT o.*, p.actor_user_id, p.lifecycle, p.audience_mode, p.audience_selection,
    p.dispatch_profile AS publication_profile, p.required_bot_id AS publication_bot_id,
    s.status AS schedule_status, s.mode AS schedule_mode
  FROM occurrence_sample o
  LEFT JOIN publications p ON p.id = o.publication_id
  LEFT JOIN publication_schedules s ON s.id = o.schedule_id
), target_candidates AS MATERIALIZED (
  SELECT o.id AS occurrence_id, o.actor_user_id, o.required_bot_id,
    o.status AS occurrence_status, o.lifecycle,
    CASE WHEN o.dispatch_blocker_code = 'PUBLISHER_ACTOR_ACCESS_REQUIRED'
      THEN 'actor_access' WHEN o.dispatch_blocker_code = 'PUBLISHER_MISSED_WINDOW_REVIEW'
      THEN 'missed_window' WHEN o.dispatch_blocker_code IS NULL THEN 'none' ELSE 'other' END AS blocker,
    target.target_chat_id, target.entity_type, target.position
  FROM scoped o
  CROSS JOIN LATERAL (
    SELECT target_chat_id, entity_type, position FROM publication_targets
    WHERE publication_id = o.publication_id
    ORDER BY position ASC LIMIT 9
  ) target
), target_sample AS MATERIALIZED (
  SELECT * FROM (
    SELECT *, row_number() OVER (PARTITION BY occurrence_id ORDER BY position) AS target_rank
    FROM target_candidates
  ) ranked WHERE target_rank <= 8
), classified_targets AS MATERIALIZED (
  SELECT t.occurrence_id, t.occurrence_status, t.lifecycle, t.blocker,
    CASE
      WHEN t.required_bot_id IS NULL OR b.publisher_bot_id IS DISTINCT FROM t.required_bot_id
        THEN 'binding_missing_or_wrong_bot'
      WHEN b.status::text IS DISTINCT FROM 'ACTIVE' OR (
        b.bot_access_state::text IN ('CONFIRMED_MEMBER', 'CONFIRMED_ADMIN', 'CONFIRMED_OWNER')
        OR (b.bot_access_state::text = 'UNKNOWN' AND b.last_webhook_at IS NOT NULL)
      ) IS NOT TRUE THEN 'binding_not_connected'
      WHEN policy.publik_enabled = false THEN 'policy_disabled'
      WHEN c.chat_id IS NULL OR c.status <> 'ACTIVE' THEN 'catalog_missing_or_inactive'
      WHEN c.entity_type IS DISTINCT FROM t.entity_type THEN 'catalog_type_mismatch'
      WHEN e.chat_id IS NULL THEN 'actor_edge_missing'
      WHEN e.state::text <> 'GRANTED' THEN 'actor_denied'
      WHEN e.user_role::text NOT IN ('OWNER', 'ADMIN') THEN 'actor_not_admin'
      WHEN e.entity_type IS DISTINCT FROM t.entity_type THEN 'actor_edge_type_mismatch'
      WHEN chat.entity_type IS DISTINCT FROM t.entity_type THEN 'chat_type_mismatch'
      WHEN b.bot_access_state::text NOT IN ('CONFIRMED_ADMIN', 'CONFIRMED_OWNER')
        THEN 'bot_not_admin'
      WHEN b.bot_access_checked_at IS NULL OR b.bot_access_checked_at > (statement_timestamp() AT TIME ZONE 'UTC')
        THEN 'bot_access_unconfirmed'
      WHEN b.send_route_quarantined_until > (statement_timestamp() AT TIME ZONE 'UTC') THEN 'route_quarantined'
      ELSE 'metadata_ready'
    END AS reason,
    CASE WHEN e.denied_reason IN (
      'publisher_user_not_admin', 'publisher_user_access_unavailable', 'publisher_actor_is_bot',
      'publisher_actor_type_unverified', 'publisher_bot_not_admin', 'publisher_candidate_pending'
    ) THEN e.denied_reason WHEN e.denied_reason IS NULL THEN 'none' ELSE 'other' END AS denial,
    e.expires_at > (statement_timestamp() AT TIME ZONE 'UTC') AS edge_unexpired
  FROM target_sample t
  LEFT JOIN publisher_entity_bindings b ON b.chat_id = t.target_chat_id
  LEFT JOIN managed_entity_publication_policies policy ON policy.chat_id = t.target_chat_id
  LEFT JOIN LATERAL (
    SELECT chat_id,status,entity_type FROM managed_bot_chat_catalog
    WHERE (bot_id,chat_id)>=(t.required_bot_id,t.target_chat_id)
      AND (bot_id,chat_id)<=(t.required_bot_id,t.target_chat_id)
    ORDER BY bot_id,chat_id LIMIT 1 OFFSET 0
  ) c ON true
  LEFT JOIN managed_entity_access_edges e ON e.chat_id = t.target_chat_id
    AND e.user_id = t.actor_user_id AND e.bot_id = t.required_bot_id
  LEFT JOIN chats chat ON chat.id = t.target_chat_id
), delivery_candidates AS MATERIALIZED (
  SELECT o.id AS occurrence_id, d.status, d.attempt_count, d.created_at, d.remote_message_id IS NOT NULL AS has_remote_id
  FROM scoped o CROSS JOIN LATERAL (
    SELECT status, attempt_count, remote_message_id, created_at FROM managed_broadcast_deliveries
    WHERE publication_occurrence_id = o.id
    ORDER BY created_at DESC LIMIT 9
  ) d
), delivery_sample AS MATERIALIZED (
  SELECT * FROM (
    SELECT *, row_number() OVER (PARTITION BY occurrence_id ORDER BY created_at DESC) AS delivery_rank
    FROM delivery_candidates
  ) ranked WHERE delivery_rank <= 8
), occurrence_counts AS (
  SELECT status, least(count(*), 32) AS sampled, count(*) > 32 AS saturated,
    max((statement_timestamp() AT TIME ZONE 'UTC') - scheduled_at) AS oldest_age
  FROM occurrence_candidates GROUP BY status
), blocker_counts AS (
  SELECT status AS occurrence_status,
    CASE WHEN dispatch_blocker_code = 'PUBLISHER_MISSED_WINDOW_REVIEW'
    THEN 'missed_window' WHEN dispatch_blocker_code IN (
    'PUBLISHER_ACTOR_ACCESS_REQUIRED', 'PUBLISHER_RUNTIME_UNAVAILABLE', 'PUBLISHER_AUTH_PAUSED',
    'policy_disabled', 'bot_not_connected', 'bot_access_expired', 'bot_access_unconfirmed',
    'bot_not_admin', 'write_permission_missing', 'route_quarantined', 'publisher_bot_changed'
  ) THEN dispatch_blocker_code WHEN dispatch_blocker_code IS NULL THEN 'none' ELSE 'other' END AS blocker,
    lifecycle, schedule_status, schedule_mode, audience_mode, count(*) AS occurrences
  FROM scoped GROUP BY 1, 2, 3, 4, 5, 6
), target_counts AS (
  SELECT occurrence_status, lifecycle, blocker, reason, denial, edge_unexpired, count(*) AS targets
  FROM classified_targets GROUP BY 1, 2, 3, 4, 5, 6
), delivery_counts AS (
  SELECT o.status AS occurrence_status, o.schedule_status,
    d.status, d.has_remote_id, d.attempt_count > 0 AS attempted, count(*) AS deliveries
  FROM delivery_sample d JOIN scoped o ON o.id = d.occurrence_id
  GROUP BY 1, 2, 3, 4, 5
)
SELECT json_build_object(
  'schema_version', 2, 'audit', 'publisher_publications',
  'readiness_scope', 'metadata_only', 'capabilities_and_activation_checked', false,
  'occurrence_sample_cap_per_status', 32, 'target_sample_cap_per_occurrence', 8,
  'delivery_sample_cap_per_occurrence', 8,
  'occurrences', coalesce((SELECT json_agg(json_build_object(
    'status', status, 'sampled', sampled, 'saturated', saturated,
    'oldest_age_seconds', greatest(0, floor(extract(epoch FROM oldest_age)))
  ) ORDER BY status::text) FROM occurrence_counts), '[]'::json),
  'target_samples_truncated', (SELECT count(*) FROM (
    SELECT occurrence_id FROM target_candidates GROUP BY occurrence_id HAVING count(*) > 8
  ) capped),
  'delivery_samples_truncated', (SELECT count(*) FROM (
    SELECT occurrence_id FROM delivery_candidates GROUP BY occurrence_id HAVING count(*) > 8
  ) capped),
  'blockers', coalesce((SELECT json_agg(blocker_counts ORDER BY occurrence_status::text, blocker, schedule_mode::text) FROM blocker_counts), '[]'::json),
  'target_reasons', coalesce((SELECT json_agg(target_counts ORDER BY reason, denial) FROM target_counts), '[]'::json),
  'delivery_states', coalesce((SELECT json_agg(delivery_counts ORDER BY occurrence_status::text, schedule_status::text, status::text) FROM delivery_counts), '[]'::json)
);`;
  return `${explain ? 'EXPLAIN (FORMAT JSON) ' : ''}${query}\n`;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const args = process.argv.slice(2);
  if (
    args[0] === '--privileges' &&
    args.length <= 2 &&
    (args.length === 1 || args[1] === '--require-all')
  ) {
    process.stdout.write(buildPublisherPublicationPrivilegesSql(args[1] === '--require-all'));
    process.exit(0);
  }
  if (args.length > 1 || (args.length === 1 && args[0] !== '--explain')) {
    throw new Error('Usage: publisher-publications-audit.mjs [--explain]');
  }
  process.stdout.write(
    buildPublisherPublicationIndexReadinessSql() +
      buildPublisherPublicationsAuditSql(args[0] === '--explain'),
  );
}
