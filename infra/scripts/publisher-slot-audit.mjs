import { pathToFileURL } from 'node:url';

export const PUBLISHER_SLOT_AUDIT_COLUMNS = {
  publication_occurrences: [
    'content_revision_id',
    'schedule_revision',
    'delivery_deadline_at',
    'dispatch_blocked_at',
    'retry_authorized_at',
    'retry_expires_at',
    'created_at',
    'updated_at',
  ],
  managed_broadcast_deliveries: [
    'id',
    'broadcast_id',
    'content_revision_id',
    'target_chat_id',
    'bot_id',
    'required_bot_id',
    'dispatch_profile',
    'next_attempt_at',
    'wait_reason',
    'dispatch_blocker_code',
    'locked_at',
    'lock_token',
    'sent_at',
    'last_error_code',
  ],
  managed_broadcasts: [
    'id',
    'publication_occurrence_id',
    'publication_content_revision_id',
    'status',
    'next_send_at',
    'locked_at',
    'lock_token',
    'dispatch_profile',
    'required_bot_id',
  ],
};
const statuses = ['SCHEDULED', 'IN_PROGRESS', 'SENT', 'PARTIAL', 'FAILED', 'AMBIGUOUS', 'CANCELED'];
const codes = [
  'PUBLISHER_ACTOR_ACCESS_REQUIRED',
  'PUBLISHER_RUNTIME_UNAVAILABLE',
  'PUBLISHER_AUTH_PAUSED',
  'PUBLISHER_MISSED_WINDOW_REVIEW',
  'PUBLISHER_EXPLICIT_RETRY',
  'PUBLISHER_WINDOW_EXPIRED',
  'PUBLIK_LEDGER_DISPATCH_V1',
  'policy_disabled',
  'bot_not_connected',
  'bot_access_expired',
  'bot_access_unconfirmed',
  'bot_not_admin',
  'write_permission_missing',
  'route_quarantined',
  'publisher_bot_changed',
  'module_disabled',
  'publisher_runtime_unavailable',
  'catalog_unconfirmed',
  'audience_empty',
];
const literal = (value) => `'${value.replaceAll("'", "''")}'`;
const reason = (column) =>
  `CASE WHEN ${column} IS NULL THEN 'none' WHEN ${column} IN (${codes.map(literal).join(',')}) THEN ${column} ELSE 'other' END`;

export function validatePublisherSlotArgs(actor, chat, minute) {
  if (
    !/^[1-9][0-9]{0,19}$/u.test(actor ?? '') ||
    !/^-[1-9][0-9]{0,19}$/u.test(chat ?? '') ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00Z$/u.test(minute ?? '') ||
    !Number.isFinite(Date.parse(minute)) ||
    new Date(minute).toISOString() !== minute.replace('Z', '.000Z')
  )
    throw new Error(
      'Expected exact numeric actor, negative chat ID and UTC minute; scope is two minutes.',
    );
}

export function buildPublisherSlotPrivilegesSql(requireAll = false) {
  const columns = Object.entries(PUBLISHER_SLOT_AUDIT_COLUMNS)
    .flatMap(([table, fields]) => fields.map((column) => `('${table}','${column}')`))
    .join(',');
  return `WITH required(table_name,column_name) AS (VALUES ${columns}), grants AS (
    SELECT count(*) FILTER (WHERE a.attnum IS NOT NULL AND has_column_privilege('maxim_audit',r.oid,a.attnum,'SELECT')) AS present
    FROM required LEFT JOIN pg_class r ON r.oid=to_regclass('public.'||required.table_name)
    LEFT JOIN pg_attribute a ON a.attrelid=r.oid AND a.attname=required.column_name AND NOT a.attisdropped
  ) SELECT present ${requireAll ? '= 31' : 'IN (0,31)'} AS publisher_slot_privileges_ready FROM grants \\gset
\\if :publisher_slot_privileges_ready
\\else
\\echo MAXIM_PUBLISHER_SLOT_PRIVILEGES_UNAVAILABLE
-- FLAG: PostgreSQL 16 psql ignores numeric \\quit arguments. Fail under ON_ERROR_STOP.
SELECT 1 / 0;
\\endif
`;
}

export function buildPublisherSlotIndexSql() {
  const indexes = [
    [
      'publication_occurrences_dispatch_status_scheduled_idx',
      'publication_occurrences',
      ['dispatch_profile', 'status', 'scheduled_at'],
      false,
      [0, 0, 0],
    ],
    ['publications_pkey', 'publications', ['id'], true, [0]],
    ['publication_schedules_pkey', 'publication_schedules', ['id'], true, [0]],
    ['managed_broadcasts_pkey', 'managed_broadcasts', ['id'], true, [0]],
    [
      'publication_targets_publication_target_key',
      'publication_targets',
      ['publication_id', 'target_chat_id'],
      true,
      [0, 0],
    ],
    [
      'managed_broadcast_deliveries_pub_occurrence_created_id_idx',
      'managed_broadcast_deliveries',
      ['publication_occurrence_id', 'created_at', 'id'],
      false,
      [0, 3, 3],
    ],
    ['publisher_entity_bindings_pkey', 'publisher_entity_bindings', ['chat_id'], true, [0]],
    [
      'managed_entity_publication_policies_pkey',
      'managed_entity_publication_policies',
      ['chat_id'],
      true,
      [0],
    ],
    [
      'managed_entity_access_edges_pkey',
      'managed_entity_access_edges',
      ['chat_id', 'user_id', 'bot_id'],
      true,
      [0, 0, 0],
    ],
    [
      'managed_bot_chat_catalog_pkey',
      'managed_bot_chat_catalog',
      ['bot_id', 'chat_id'],
      true,
      [0, 0],
    ],
  ];
  return `WITH required(index_name,table_name,columns,is_unique,options) AS (VALUES ${indexes
    .map(
      ([name, table, columns, unique, options]) =>
        `(${literal(name)},${literal(table)},ARRAY[${columns.map(literal).join(',')}],${unique},ARRAY[${options.join(',')}]::smallint[])`,
    )
    .join(',')})
  SELECT bool_and(EXISTS (SELECT 1 FROM pg_index i JOIN pg_class p ON p.oid=i.indrelid
    JOIN pg_class idx ON idx.oid=i.indexrelid JOIN pg_am am ON am.oid=idx.relam
    WHERE i.indexrelid=to_regclass('public.'||required.index_name) AND i.indrelid=to_regclass('public.'||required.table_name)
      AND i.indisvalid AND i.indisready AND i.indislive AND i.indisunique=required.is_unique
      AND am.amname='btree' AND i.indnkeyatts=cardinality(required.columns) AND i.indnatts=i.indnkeyatts
      AND i.indexprs IS NULL AND i.indpred IS NULL AND p.relkind='r' AND NOT p.relrowsecurity
      AND NOT p.relispartition AND NOT EXISTS (SELECT 1 FROM pg_inherits WHERE inhparent=p.oid OR inhrelid=p.oid)
      AND NOT EXISTS (SELECT 1 FROM unnest(i.indclass::oid[]) c JOIN pg_opclass op ON op.oid=c
        WHERE NOT op.opcdefault OR op.opcnamespace<>'pg_catalog'::regnamespace)
      AND NOT EXISTS (SELECT 1 FROM unnest(i.indkey::smallint[]) WITH ORDINALITY k(attnum,n)
        JOIN pg_attribute a ON a.attrelid=p.oid AND a.attnum=k.attnum
        WHERE a.attcollation<>i.indcollation[(k.n-1)::integer]
          OR a.atttypid IS DISTINCT FROM CASE
            WHEN required.table_name='publication_occurrences' AND a.attname='status' THEN to_regtype('public."PublicationOccurrenceStatus"')
            WHEN a.attname='dispatch_profile' THEN to_regtype('public."PublicationDispatchProfile"')
            WHEN a.attname IN ('created_at','scheduled_at') THEN 'timestamp without time zone'::regtype
            ELSE 'text'::regtype END)
      AND ARRAY(SELECT unnest(i.indoption::smallint[]))=required.options
      AND ARRAY(SELECT a.attname::text FROM unnest(i.indkey::smallint[]) WITH ORDINALITY k(attnum,n)
        JOIN pg_attribute a ON a.attrelid=p.oid AND a.attnum=k.attnum ORDER BY k.n)=required.columns
  )) AND (SELECT array_agg(e.enumlabel::text ORDER BY e.enumlabel::text)
      FROM pg_enum e WHERE e.enumtypid=to_regtype('public."PublicationOccurrenceStatus"'))=
      ARRAY[${[...statuses].sort().map(literal).join(',')}] AS publisher_slot_indexes_ready FROM required \\gset
\\if :publisher_slot_indexes_ready
\\else
\\echo MAXIM_PUBLISHER_SLOT_INDEX_UNAVAILABLE
-- FLAG: PostgreSQL 16 psql ignores numeric \\quit arguments. Fail under ON_ERROR_STOP.
SELECT 1 / 0;
\\endif
`;
}

export function buildPublisherSlotAuditSql(actor, chat, minute, explain = false) {
  // FLAG: Null is an explicit target-only scope, never a wildcard accepted as an actor ID.
  validatePublisherSlotArgs(actor === null ? '1' : actor, chat, minute);
  const start = Date.parse(minute);
  // FLAG: Cap all fourteen literal status/minute index heads before actor, target or parent filters.
  // Ties are intentionally unordered: ordering by id would sort an unbounded equal-time population.
  const heads = [0, 1]
    .flatMap((slot) =>
      statuses.map(
        (status) => `(SELECT ${slot} AS slot,
    id,publication_id,schedule_id,status,scheduled_at,required_bot_id,dispatch_blocker_code,
    content_revision_id,schedule_revision,delivery_deadline_at,dispatch_blocked_at,retry_authorized_at,retry_expires_at,created_at,updated_at
    FROM public.publication_occurrences
    WHERE (dispatch_profile,status,scheduled_at)>=('PUBLIK_V1'::"PublicationDispatchProfile",${literal(status)}::"PublicationOccurrenceStatus",
      ${literal(new Date(start + slot * 60_000).toISOString())}::timestamptz AT TIME ZONE 'UTC')
      AND (dispatch_profile,status,scheduled_at)<('PUBLIK_V1'::"PublicationDispatchProfile",${literal(status)}::"PublicationOccurrenceStatus",
      ${literal(new Date(start + (slot + 1) * 60_000).toISOString())}::timestamptz AT TIME ZONE 'UTC')
    ORDER BY dispatch_profile,status,scheduled_at LIMIT 33)`,
      ),
    )
    .join('\nUNION ALL\n');
  const actorParam = '(SELECT actor FROM scope_params)';
  const chatParam = '(SELECT chat FROM scope_params)';
  // FLAG: Both catalog tuple bounds and their matching order keep a competing chat/status
  // index from filtering other bots before LIMIT. Compare saved Prisma clocks as UTC timestamps.
  const actorDiagnostics =
    actor === null
      ? ''
      : `'actor_matched_occurrences',(SELECT count(*) FROM owned),
    'actor_candidates',coalesce((SELECT json_agg(json_build_object('slot',slot,'status',status,'blocker',${reason('dispatch_blocker_code')},
      'lifecycle',lifecycle,'schedule_mode',mode,'schedule_status',schedule_status,'audience_mode',audience_mode,
      'audience_selection',audience_selection,'has_saved_target',has_saved_target,'scheduled_at',scheduled_at) ORDER BY slot,scheduled_at,status::text) FROM facts),'[]'::json),`;
  const query = `WITH scope_params AS MATERIALIZED (SELECT ${actor === null ? 'NULL' : literal(actor)}::text AS actor,${literal(chat)}::text AS chat), heads AS MATERIALIZED (${heads}), counts AS MATERIALIZED (
    SELECT slot,status,least(count(*),32)::integer AS sampled,count(*)>32 AS truncated FROM heads GROUP BY slot,status
  ), samples AS MATERIALIZED (SELECT * FROM (SELECT *,row_number() OVER(PARTITION BY slot,status ORDER BY scheduled_at) AS ordinal FROM heads) ranked WHERE ordinal<=32),
  owned AS MATERIALIZED (SELECT o.*,p.actor_user_id AS scoped_actor,p.lifecycle,p.audience_mode,p.audience_selection,p.dispatch_profile AS parent_profile,p.required_bot_id AS parent_bot
    FROM samples o CROSS JOIN LATERAL (SELECT actor_user_id,lifecycle,audience_mode,audience_selection,dispatch_profile,required_bot_id
      FROM public.publications WHERE id=o.publication_id LIMIT 1 OFFSET 0) p${actor === null ? '' : ` WHERE p.actor_user_id=${actorParam}`}),
  scoped AS MATERIALIZED (SELECT o.*,target.entity_type,coalesce(target.present,false) AS has_saved_target FROM owned o LEFT JOIN LATERAL (
    SELECT entity_type,true AS present FROM public.publication_targets WHERE publication_id=o.publication_id AND target_chat_id=${chatParam} LIMIT 1 OFFSET 0) target ON true${actor === null ? ' WHERE target.present' : ''}),
  facts AS MATERIALIZED (SELECT o.*,s.mode,s.status AS schedule_status,s.revision AS current_revision,
    CASE WHEN NOT o.has_saved_target THEN 'saved_target_missing'
      WHEN o.parent_profile IS DISTINCT FROM 'PUBLIK_V1' OR o.required_bot_id IS DISTINCT FROM o.parent_bot THEN 'invalid_parent_binding'
      WHEN b.publisher_bot_id IS DISTINCT FROM o.required_bot_id THEN 'binding_missing_or_wrong_bot'
      WHEN b.status::text IS DISTINCT FROM 'ACTIVE' THEN 'binding_not_connected'
      WHEN policy.publik_enabled=false THEN 'policy_disabled'
      WHEN c.status IS DISTINCT FROM 'ACTIVE' THEN 'catalog_missing_or_inactive'
      WHEN c.entity_type IS DISTINCT FROM o.entity_type THEN 'catalog_type_mismatch'
      WHEN e.chat_id IS NULL THEN 'actor_edge_missing' WHEN e.state::text IS DISTINCT FROM 'GRANTED' THEN 'actor_denied'
      WHEN e.user_role IS NULL OR e.user_role::text NOT IN ('ADMIN','OWNER') THEN 'actor_not_admin'
      WHEN e.entity_type IS DISTINCT FROM o.entity_type THEN 'actor_edge_type_mismatch'
      WHEN b.bot_access_state IS NULL OR b.bot_access_state::text NOT IN ('CONFIRMED_ADMIN','CONFIRMED_OWNER') THEN 'bot_not_admin'
      WHEN b.bot_access_checked_at IS NULL OR b.bot_access_checked_at>(statement_timestamp() AT TIME ZONE 'UTC') THEN 'bot_access_unconfirmed'
      WHEN b.send_route_quarantined_until>(statement_timestamp() AT TIME ZONE 'UTC') THEN 'route_quarantined' ELSE 'metadata_ready' END AS access_reason
    FROM scoped o LEFT JOIN LATERAL (SELECT mode,status,revision FROM public.publication_schedules WHERE id=o.schedule_id LIMIT 1 OFFSET 0) s ON true
    LEFT JOIN LATERAL (SELECT publisher_bot_id,status,bot_access_state,bot_access_checked_at,send_route_quarantined_until FROM public.publisher_entity_bindings WHERE chat_id=${chatParam} LIMIT 1 OFFSET 0) b ON true
    LEFT JOIN LATERAL (SELECT publik_enabled FROM public.managed_entity_publication_policies WHERE chat_id=${chatParam} LIMIT 1 OFFSET 0) policy ON true
    LEFT JOIN LATERAL (SELECT status,entity_type FROM public.managed_bot_chat_catalog
      WHERE (bot_id,chat_id)>=(o.required_bot_id,${chatParam}) AND (bot_id,chat_id)<=(o.required_bot_id,${chatParam})
      ORDER BY bot_id,chat_id LIMIT 1 OFFSET 0) c ON true
    LEFT JOIN LATERAL (SELECT chat_id,state,user_role,entity_type FROM public.managed_entity_access_edges WHERE chat_id=${chatParam} AND user_id=o.scoped_actor AND bot_id=o.required_bot_id LIMIT 1 OFFSET 0) e ON true),
  delivery_heads AS MATERIALIZED (SELECT o.id AS occurrence_id,o.required_bot_id AS occurrence_bot,o.content_revision_id AS occurrence_content,d.* FROM scoped o CROSS JOIN LATERAL (
    SELECT id,broadcast_id,content_revision_id,target_chat_id,status,attempt_count,remote_message_id,created_at,bot_id,required_bot_id,dispatch_profile,
      next_attempt_at,wait_reason,dispatch_blocker_code,locked_at,lock_token,sent_at,last_error_code
    FROM public.managed_broadcast_deliveries WHERE publication_occurrence_id=o.id ORDER BY created_at DESC,id DESC LIMIT 9) d WHERE o.has_saved_target),
  delivery_counts AS MATERIALIZED (SELECT occurrence_id,count(*)>8 AS truncated,least(count(*),8)::integer AS sampled FROM delivery_heads GROUP BY occurrence_id),
  delivery_sample AS MATERIALIZED (SELECT * FROM (SELECT *,row_number() OVER(PARTITION BY occurrence_id ORDER BY created_at DESC,id DESC) AS ordinal FROM delivery_heads) ranked WHERE ordinal<=8),
  deliveries AS MATERIALIZED (SELECT d.occurrence_id,d.status,d.attempt_count,d.remote_message_id IS NOT NULL AS has_remote_id,d.sent_at,
    d.created_at,d.next_attempt_at,d.locked_at,d.lock_token IS NOT NULL AS has_lock,
    ${reason('d.dispatch_blocker_code')} AS blocker,${reason('d.last_error_code')} AS saved_reason,
    CASE WHEN wait_reason IS NULL THEN 'none' WHEN wait_reason IN ('local_capacity','max_rate_limit','circuit_open') THEN wait_reason ELSE 'other' END AS waiting,
    coalesce(d.bot_id IS NOT NULL AND d.bot_id=d.required_bot_id AND d.bot_id=d.occurrence_bot AND d.dispatch_profile='PUBLIK_V1',false) AS route_metadata_matches,
    b.id IS NOT NULL AS envelope_present,b.status AS envelope_status,b.next_send_at AS envelope_next_send_at,
    b.locked_at AS envelope_locked_at,b.lock_token IS NOT NULL AS envelope_has_lock,
    extract(epoch FROM ((statement_timestamp() AT TIME ZONE 'UTC')-b.locked_at)) AS envelope_lock_age_seconds,
    coalesce(b.dispatch_profile='PUBLIK_V1',false) AS envelope_profile_matches,
    coalesce(b.required_bot_id=d.occurrence_bot,false) AS envelope_bot_matches,
    coalesce(b.publication_occurrence_id=d.occurrence_id,false) AS envelope_occurrence_matches,
    coalesce(b.publication_content_revision_id=d.occurrence_content AND d.content_revision_id=d.occurrence_content,false) AS content_revision_matches
    FROM delivery_sample d LEFT JOIN LATERAL (SELECT id,publication_occurrence_id,publication_content_revision_id,
      status,next_send_at,locked_at,lock_token,dispatch_profile,required_bot_id
      FROM public.managed_broadcasts WHERE id=d.broadcast_id LIMIT 1 OFFSET 0) b ON true
    WHERE d.target_chat_id=${chatParam}),
  report AS (SELECT f.slot,f.status,${reason('f.dispatch_blocker_code')} AS blocker,f.lifecycle,f.mode,f.schedule_status,
    f.schedule_revision=f.current_revision AS current_schedule_revision,f.access_reason,f.scheduled_at,f.created_at,f.updated_at,
    f.delivery_deadline_at,f.dispatch_blocked_at,f.retry_authorized_at,f.retry_expires_at,
    coalesce(dc.truncated,false) AS deliveries_truncated,coalesce(dc.sampled,0) AS delivery_sampled,
    coalesce((SELECT json_agg(json_build_object('status',d.status,'attempt_count',d.attempt_count,'has_recorded_remote_id',d.has_remote_id,
      'sent_at',d.sent_at,'created_at',d.created_at,'next_attempt_at',d.next_attempt_at,'locked_at',d.locked_at,'has_lock',d.has_lock,
      'blocker',d.blocker,'saved_reason',d.saved_reason,'waiting',d.waiting,'route_metadata_matches',d.route_metadata_matches,
      'envelope_present',d.envelope_present,'envelope_status',d.envelope_status,'envelope_next_send_at',d.envelope_next_send_at,
      'envelope_locked_at',d.envelope_locked_at,'envelope_has_lock',d.envelope_has_lock,'envelope_lock_age_seconds',d.envelope_lock_age_seconds,
      'envelope_profile_matches',d.envelope_profile_matches,'envelope_bot_matches',d.envelope_bot_matches,
      'envelope_occurrence_matches',d.envelope_occurrence_matches,'content_revision_matches',d.content_revision_matches))
      FROM deliveries d WHERE d.occurrence_id=f.id),'[]'::json) AS target_deliveries
    FROM facts f LEFT JOIN delivery_counts dc ON dc.occurrence_id=f.id WHERE f.has_saved_target)
  SELECT json_build_object('schema_version',2,'audit','publisher_slots','observed_at',statement_timestamp() AT TIME ZONE 'UTC',
    'window_start',${literal(minute)},'window_minutes',2,'read_only',true,'readiness_scope','metadata_only','client_visibility','not_observed','capabilities_and_activation_checked',false,
    'occurrence_cap_per_status_minute',32,'delivery_cap_per_occurrence',8,
    'source_complete',NOT EXISTS(SELECT 1 FROM counts WHERE truncated),'deliveries_complete',NOT EXISTS(SELECT 1 FROM delivery_counts WHERE truncated),
    'source_heads',coalesce((SELECT json_agg(counts ORDER BY slot,status::text) FROM counts),'[]'::json),
    'selection_scope',${literal(actor === null ? 'target' : 'actor_and_target')},
    'matched_occurrences',(SELECT count(*) FROM scoped WHERE has_saved_target),${actorDiagnostics}
    'rows',coalesce((SELECT json_agg(report ORDER BY slot,scheduled_at,status::text) FROM report),'[]'::json));`;
  return `${explain ? 'EXPLAIN (FORMAT JSON) ' : ''}${query}\n`;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const args = process.argv.slice(2);
  if (args[0] === '--privileges' && args.length <= 2 && (!args[1] || args[1] === '--require-all')) {
    process.stdout.write(buildPublisherSlotPrivilegesSql(args[1] === '--require-all'));
  } else {
    if (args.length < 3 || args.length > 4 || (args[3] && args[3] !== '--explain'))
      throw new Error(
        'Usage: publisher-slot-audit.mjs <actor|--target> <chat> <UTC-minute> [--explain]',
      );
    process.stdout.write(
      buildPublisherSlotIndexSql() +
        buildPublisherSlotAuditSql(
          args[0] === '--target' ? null : args[0],
          args[1],
          args[2],
          args[3] === '--explain',
        ),
    );
  }
}
