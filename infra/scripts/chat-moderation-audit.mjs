import { pathToFileURL } from 'node:url';

export const CHAT_MODERATION_AUDIT_COLUMNS = {
  chat_settings: [
    'chat_id',
    'link_policy',
    'link_rules_policy',
    'link_policy_revision',
    'link_policy_effective_at',
    'russian_profanity_filter_enabled',
    'profanity_sensitivity',
    'updated_at',
  ],
  chat_admin_roster_states: [
    'chat_id',
    'completed_at',
    'complete_probe_started_at',
    'refresh_requested_at',
  ],
};

const sharedColumns = {
  chats: ['id', 'entity_type'],
  chat_settings: [
    'id',
    'anti_duplicate_enabled',
    'duplicate_photo_enabled',
    'duplicate_detection_preset',
    'duplicate_photo_match_preset',
    'duplicate_photo_scope',
    'duplicate_compare_mode',
    'duplicate_window_mode',
    'duplicate_start_time_minutes',
    'duplicate_end_time_minutes',
    'duplicate_timezone',
    ...CHAT_MODERATION_AUDIT_COLUMNS.chat_settings,
  ],
  chat_bot_memberships: [
    'chat_id',
    'bot_id',
    'status',
    'bot_access_state',
    'bot_access_checked_at',
    'bot_access_source',
    'lifecycle_event_at',
  ],
  chat_admin_roster_states: CHAT_MODERATION_AUDIT_COLUMNS.chat_admin_roster_states,
};
const values = (columns) =>
  Object.entries(columns)
    .flatMap(([table, names]) => names.map((column) => `('${table}','${column}')`))
    .join(',');
const extensionValues = values(CHAT_MODERATION_AUDIT_COLUMNS);
const allowedValues = values(sharedColumns);

export function parseChatModerationAuditArgs(args) {
  if (
    !Array.isArray(args) ||
    args.length < 1 ||
    args.length > 2 ||
    typeof args[0] !== 'string' ||
    !/^-[1-9][0-9]{0,19}$/u.test(args[0]) ||
    (args.length === 2 && args[1] !== '--explain')
  )
    throw new Error('Usage: chat-moderation <exact-negative-chat-id> [--explain]');
  return { chatId: args[0], explain: args.length === 2 };
}

function privilegesPredicate(requireAll) {
  return `WITH allowed(table_name,column_name) AS (VALUES ${allowedValues}),
    extension(table_name,column_name) AS (VALUES ${extensionValues}), effective AS (
      SELECT relation.relname AS table_name,attribute.attname AS column_name
      FROM pg_class relation JOIN pg_namespace ns ON ns.oid=relation.relnamespace
      JOIN pg_attribute attribute ON attribute.attrelid=relation.oid
      WHERE ns.nspname='public' AND relation.relname IN (SELECT table_name FROM allowed)
        AND attribute.attnum>0 AND NOT attribute.attisdropped
        AND has_column_privilege('maxim_audit',relation.oid,attribute.attnum,'SELECT')
    ) SELECT NOT EXISTS (SELECT * FROM effective EXCEPT SELECT * FROM allowed)
      AND (SELECT count(*) FROM effective JOIN extension USING(table_name,column_name))
        IN (${requireAll ? '' : '0,'}12)
      AND NOT EXISTS (SELECT 1 FROM pg_class relation JOIN pg_namespace ns ON ns.oid=relation.relnamespace
        WHERE ns.nspname='public' AND relation.relname IN (SELECT table_name FROM allowed)
          AND (has_table_privilege('maxim_audit',relation.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
            OR EXISTS (SELECT 1 FROM pg_attribute attribute WHERE attribute.attrelid=relation.oid
              AND attribute.attnum>0 AND NOT attribute.attisdropped
              AND has_column_privilege('maxim_audit',relation.oid,attribute.attnum,'INSERT,UPDATE,REFERENCES'))))`;
}

export function buildChatModerationPrivilegesSql(requireAll = false) {
  return `${privilegesPredicate(requireAll)} AS chat_moderation_privileges_ready \\gset
\\if :chat_moderation_privileges_ready
\\else
\\echo MAXIM_CHAT_MODERATION_PRIVILEGES_INVALID
SELECT 1/0;
\\endif
`;
}

export function buildChatModerationProvisionSql() {
  return `-- FLAG: This optional exact-chat metadata extension grants all twelve columns or none.
DO $chat_moderation_grants$
BEGIN
  IF NOT EXISTS (
    WITH extension(table_name,column_name) AS (VALUES ${extensionValues})
    SELECT 1 FROM extension LEFT JOIN pg_attribute attribute
      ON attribute.attrelid=to_regclass('public.'||extension.table_name)
      AND attribute.attname=extension.column_name AND attribute.attnum>0 AND NOT attribute.attisdropped
    WHERE attribute.attnum IS NULL
  ) THEN
${Object.entries(CHAT_MODERATION_AUDIT_COLUMNS)
  .map(
    ([table, columns]) =>
      `    GRANT SELECT (${columns.join(',')}) ON TABLE public.${table} TO maxim_audit;`,
  )
  .join('\n')}
  END IF;
  IF NOT (${privilegesPredicate(false)}) THEN
    RAISE EXCEPTION 'maxim_audit chat-moderation metadata privileges are not exact';
  END IF;
END
$chat_moderation_grants$;
`;
}

export function buildChatModerationIndexReadinessSql() {
  return `WITH required(name,relation,keys) AS (VALUES
    ('chats_pkey','chats',ARRAY['id']),
    ('chat_settings_chat_id_key','chat_settings',ARRAY['chat_id']),
    ('chat_bot_memberships_chat_id_bot_id_key','chat_bot_memberships',ARRAY['chat_id','bot_id']),
    ('chat_admin_roster_states_pkey','chat_admin_roster_states',ARRAY['chat_id'])
  ) SELECT NOT EXISTS (SELECT 1 FROM required LEFT JOIN pg_index idx
    ON idx.indexrelid=to_regclass('public.'||required.name)
      AND idx.indrelid=to_regclass('public.'||required.relation)
      AND idx.indisvalid AND idx.indisready AND idx.indislive AND idx.indisunique
      AND NOT idx.indisexclusion AND idx.indimmediate
      AND idx.indpred IS NULL AND idx.indexprs IS NULL
      AND idx.indnkeyatts=cardinality(required.keys) AND idx.indnatts=cardinality(required.keys)
      AND NOT EXISTS (SELECT 1 FROM unnest(idx.indoption::smallint[]) option WHERE option<>0)
      AND NOT EXISTS (
        SELECT 1 FROM unnest(idx.indkey::smallint[],idx.indcollation::oid[])
          AS index_key(attnum,collation_oid)
        LEFT JOIN pg_attribute attribute ON attribute.attrelid=idx.indrelid
          AND attribute.attnum=index_key.attnum
        WHERE attribute.attnum IS NULL OR attribute.attisdropped
          OR index_key.collation_oid<>attribute.attcollation)
      AND EXISTS (SELECT 1 FROM pg_class index_relation JOIN pg_am method ON method.oid=index_relation.relam
        JOIN pg_class parent ON parent.oid=idx.indrelid
        WHERE index_relation.oid=idx.indexrelid AND method.amname='btree' AND parent.relkind='r'
          AND NOT parent.relrowsecurity AND NOT parent.relispartition
          AND NOT EXISTS (SELECT 1 FROM pg_inherits WHERE inhparent=parent.oid OR inhrelid=parent.oid))
      AND NOT EXISTS (SELECT 1 FROM unnest(idx.indclass::oid[]) c JOIN pg_opclass op ON op.oid=c
        WHERE NOT op.opcdefault OR op.opcnamespace<>'pg_catalog'::regnamespace)
      AND ARRAY(SELECT pg_get_indexdef(idx.indexrelid,pos,false)
        FROM generate_series(1,idx.indnkeyatts) AS pos ORDER BY pos)=required.keys
    WHERE idx.indexrelid IS NULL) AS chat_moderation_indexes_ready \\gset
\\if :chat_moderation_indexes_ready
\\else
\\echo MAXIM_CHAT_MODERATION_INDEXES_INVALID
SELECT 1/0;
\\endif
`;
}

// FLAG: Inspect JSON only after a physical storage bound, including worst-case PG16 compression.
// Oversized/unsupported data stays unknown. Envelope inspection never claims JS URL validation.
const admittedPolicy = `CASE
  WHEN link_rules_policy IS NULL THEN false
  WHEN pg_column_compression(link_rules_policy) IS NULL THEN pg_column_size(link_rules_policy)<=65536
  WHEN current_setting('server_version_num')::integer/10000<>16 THEN false
  WHEN pg_column_compression(link_rules_policy)='pglz' THEN pg_column_size(link_rules_policy)<=720
  WHEN pg_column_compression(link_rules_policy)='lz4' THEN pg_column_size(link_rules_policy)<=256
  ELSE false END`;

export function buildChatModerationAuditSql(args) {
  const { chatId, explain } = parseChatModerationAuditArgs(args);
  const target = explain ? '$1' : `'${chatId}'`;
  const query = `WITH target AS MATERIALIZED (SELECT ${target}::text AS chat_id),
  chat AS MATERIALIZED (SELECT id,entity_type FROM public.chats WHERE id=${target} LIMIT 1),
  settings AS MATERIALIZED (
    SELECT chat_id,link_policy,link_policy_revision,link_policy_effective_at,
      russian_profanity_filter_enabled,profanity_sensitivity,updated_at,
      link_rules_policy IS NULL AS legacy_policy,
      CASE WHEN ${admittedPolicy} THEN link_rules_policy ELSE NULL END AS policy
    FROM public.chat_settings WHERE chat_id=${target} LIMIT 1
  ), roster AS MATERIALIZED (
    SELECT chat_id,completed_at,complete_probe_started_at,refresh_requested_at
    FROM public.chat_admin_roster_states WHERE chat_id=${target} LIMIT 1
  ), membership_probe AS MATERIALIZED (
    SELECT bot_id,status,bot_access_state,bot_access_checked_at,lifecycle_event_at
    FROM public.chat_bot_memberships WHERE chat_id=${target} ORDER BY bot_id LIMIT 9
  ), memberships AS MATERIALIZED (
    SELECT bot_id,status,bot_access_state,bot_access_checked_at,lifecycle_event_at
    FROM membership_probe ORDER BY bot_id LIMIT 8
  ), classified AS MATERIALIZED (
    SELECT settings.*,CASE
      WHEN legacy_policy THEN 'legacy'
      WHEN policy IS NULL THEN 'uninspected_storage'
      WHEN jsonb_typeof(policy)<>'object' THEN 'invalid_envelope'
      WHEN NOT (policy ?& ARRAY['version','mode','rules']) OR
        policy - ARRAY['version','mode','rules'] <> '{}'::jsonb OR
        policy->'version'<>'1'::jsonb OR
        coalesce(policy->>'mode','') NOT IN ('ALLOW_ALL','DENY_SELECTED','ALLOW_SELECTED','DENY_ALL')
        THEN 'invalid_envelope'
      WHEN jsonb_typeof(policy->'rules')<>'array' THEN 'invalid_envelope'
      WHEN jsonb_array_length(policy->'rules')>300 THEN 'invalid_envelope'
      WHEN jsonb_array_length(policy->'rules')=0 THEN 'valid_empty_rules'
      ELSE 'runtime_validation_required' END AS policy_state
    FROM settings
  ) SELECT json_build_object(
    'audit','chat_moderation','schema_version',1,'observed_at',statement_timestamp(),
    'scope','exact_chat_metadata','chat_present',chat.id IS NOT NULL,
    'entity_type',chat.entity_type,'chat_moderation_applicable',chat.entity_type='CHAT',
    'settings_present',s.chat_id IS NOT NULL,'settings_updated_at',s.updated_at,
    'legacy_link_policy',s.link_policy,'link_policy_revision',s.link_policy_revision,
    'link_policy_effective_at',s.link_policy_effective_at,
    'link_policy_state',coalesce(s.policy_state,'missing_settings'),
    'link_rules_mode',CASE WHEN s.policy_state IN ('valid_empty_rules','runtime_validation_required')
      THEN s.policy->>'mode' END,
    'link_rule_count',CASE WHEN s.policy_state IN ('valid_empty_rules','runtime_validation_required')
      THEN jsonb_array_length(s.policy->'rules') END,
    'link_filter_configured',CASE WHEN chat.entity_type<>'CHAT' THEN 'not_applicable'
      WHEN chat.id IS NULL OR s.chat_id IS NULL THEN 'unknown'
      WHEN s.policy_state='legacy' THEN CASE WHEN s.link_policy='ALERT_ONLY' THEN 'disabled' ELSE 'enabled' END
      WHEN s.policy_state='valid_empty_rules' THEN CASE WHEN s.policy->>'mode' IN ('ALLOW_ALL','DENY_SELECTED')
        THEN 'disabled' ELSE 'enabled' END ELSE 'unknown' END,
    'profanity_filter_enabled',s.russian_profanity_filter_enabled,
    'profanity_sensitivity',s.profanity_sensitivity,
    'admin_roster_present',roster.chat_id IS NOT NULL,
    'admin_roster_initialized',CASE WHEN roster.chat_id IS NOT NULL THEN
      roster.completed_at IS NOT NULL AND roster.complete_probe_started_at IS NOT NULL END,
    'admin_roster_completed_at',roster.completed_at,
    'admin_roster_refresh_requested_at',roster.refresh_requested_at,
    'memberships_truncated',(SELECT count(*) FROM membership_probe)>8,
    'memberships',coalesce((SELECT json_agg(json_build_object(
      'bot_id',bot_id,'status',status,'access_state',bot_access_state,
      'access_checked_at',bot_access_checked_at,'lifecycle_event_at',lifecycle_event_at
    ) ORDER BY bot_id) FROM memberships),'[]'::json),
    'limitations',json_build_array('Settings are current metadata, not historical behavior.',
      'Membership metadata does not prove current remote rights or a DELETE outcome.',
      'No author role, participant immunity, webhook processing or message content was inspected.')
  ) FROM target LEFT JOIN chat ON chat.id=target.chat_id
    LEFT JOIN classified s ON s.chat_id=target.chat_id LEFT JOIN roster ON roster.chat_id=target.chat_id;`;
  return explain
    ? `SET LOCAL plan_cache_mode=force_generic_plan;
PREPARE maxim_chat_moderation(text) AS ${query}
EXPLAIN (FORMAT JSON) EXECUTE maxim_chat_moderation('${chatId}');
DEALLOCATE maxim_chat_moderation;
`
    : `${query}\n`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = process.argv.slice(2);
    if (args[0] === '--validate-scope') {
      parseChatModerationAuditArgs(args.slice(1));
    } else if (
      args[0] === '--privileges' &&
      (args.length === 1 || (args.length === 2 && args[1] === '--require-all'))
    ) {
      process.stdout.write(buildChatModerationPrivilegesSql(args.length === 2));
    } else if (args.length === 1 && args[0] === '--provision') {
      process.stdout.write(buildChatModerationProvisionSql());
    } else {
      process.stdout.write(
        buildChatModerationIndexReadinessSql() + buildChatModerationAuditSql(args),
      );
    }
  } catch {
    process.stderr.write('Invalid chat-moderation audit arguments.\n');
    process.exitCode = 2;
  }
}
