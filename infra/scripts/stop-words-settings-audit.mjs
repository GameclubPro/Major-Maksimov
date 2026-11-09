import { pathToFileURL } from 'node:url';
import {
  SOURCE_ENVELOPE_MAX_BYTES,
  SOURCE_ENVELOPE_PGLZ_MAX_PHYSICAL_BYTES,
  SOURCE_ENVELOPE_LZ4_MAX_PHYSICAL_BYTES,
} from './webhook-source-envelope-audit.mjs';

export const STOP_WORDS_AUDIT_COLUMNS = {
  chat_settings: ['chat_id', 'stop_words_policy', 'stop_words_revision', 'updated_at'],
  chat_admin_allowlist: ['chat_id', 'user_id'],
  managed_entity_admin_members: ['chat_id', 'user_id', 'checked_at', 'expires_at', 'role'],
  chat_participant_moderation_immunities: [
    'chat_id',
    'user_id',
    'expires_at',
    'daily_violation_limit',
    'daily_violation_usage',
    'usage_date_key',
    'updated_at',
  ],
};
const oldSettingsColumns = [
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
];
const literal = (value) => `'${value.replaceAll("'", "''")}'`;
const pairs = (columns) =>
  Object.entries(columns)
    .flatMap(([table, names]) => names.map((name) => `(${literal(table)},${literal(name)})`))
    .join(',');
const columnCount = Object.values(STOP_WORDS_AUDIT_COLUMNS).flat().length;

export function parseStopWordsSettingsArgs(args) {
  if (!/^-[1-9][0-9]{0,18}$/u.test(args[0] ?? ''))
    throw new Error('Expected one exact negative chat ID');
  const result = { chatId: args[0], wordHash: null, senderHash: null, explain: false };
  const seen = new Set();
  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (seen.has(arg)) throw new Error('Duplicate stop-word audit argument');
    seen.add(arg);
    if (arg === '--explain') result.explain = true;
    else if (arg === '--word-hash' || arg === '--sender-hash') {
      const value = args[++i];
      if (!/^[a-f0-9]{32}$/u.test(value ?? '')) throw new Error('Expected a lowercase MD5 digest');
      result[arg === '--word-hash' ? 'wordHash' : 'senderHash'] = value;
    } else throw new Error('Unknown stop-word audit argument');
  }
  return result;
}

export function stopWordsSettingsPrivilegesCondition(requireAll = false) {
  return `(WITH added(table_name,column_name) AS (VALUES ${pairs(STOP_WORDS_AUDIT_COLUMNS)}),
    allowed(table_name,column_name) AS (
      SELECT * FROM added UNION ALL VALUES ${pairs({ chat_settings: oldSettingsColumns })}
    ), effective AS (
      SELECT r.relname AS table_name,a.attname AS column_name FROM pg_class r
      JOIN pg_namespace ns ON ns.oid=r.relnamespace JOIN pg_attribute a ON a.attrelid=r.oid
      WHERE ns.nspname='public' AND r.relname IN (SELECT table_name FROM added)
        AND a.attnum>0 AND NOT a.attisdropped
        AND has_column_privilege('maxim_audit',r.oid,a.attnum,'SELECT')
    ) SELECT NOT EXISTS(SELECT * FROM effective EXCEPT SELECT * FROM allowed)
      AND (SELECT count(*) FROM effective JOIN added USING(table_name,column_name)) IN (${requireAll ? '' : '0,'}${columnCount})
      AND NOT EXISTS(SELECT 1 FROM pg_class r JOIN pg_namespace ns ON ns.oid=r.relnamespace
        WHERE ns.nspname='public' AND r.relname IN (SELECT table_name FROM added)
          AND (has_table_privilege('maxim_audit',r.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
            OR EXISTS(SELECT 1 FROM pg_attribute a WHERE a.attrelid=r.oid AND a.attnum>0 AND NOT a.attisdropped
              AND has_column_privilege('maxim_audit',r.oid,a.attnum,'INSERT,UPDATE,REFERENCES')))))`;
}
export function buildStopWordsSettingsPrivilegesSql(requireAll = false) {
  return `SELECT ${stopWordsSettingsPrivilegesCondition(requireAll)} AS stop_words_settings_privileges_ready \\gset
\\if :stop_words_settings_privileges_ready
\\else
\\echo MAXIM_STOP_WORDS_SETTINGS_PRIVILEGES_UNAVAILABLE
SELECT 1 / 0;
\\endif\n`;
}
export function buildStopWordsSettingsVerificationSql() {
  return `IF NOT ${stopWordsSettingsPrivilegesCondition(false)} THEN
    RAISE EXCEPTION 'Stop-word audit privileges are not exact';
  END IF;`;
}
export function buildStopWordsSettingsProvisionSql() {
  return `DO $stop_words_settings$ BEGIN
    IF (WITH required(table_name,column_name) AS (VALUES ${pairs(STOP_WORDS_AUDIT_COLUMNS)})
      SELECT count(*)=${columnCount} FROM required JOIN information_schema.columns c
        USING(table_name,column_name) WHERE c.table_schema='public') THEN
      ${Object.entries(STOP_WORDS_AUDIT_COLUMNS)
        .map(
          ([table, columns]) =>
            `GRANT SELECT(${columns.join(',')}) ON public.${table} TO maxim_audit;`,
        )
        .join('\n      ')}
      IF NOT ${stopWordsSettingsPrivilegesCondition(true)} THEN
        RAISE EXCEPTION 'Stop-word audit privileges are not exact';
      END IF;
    ELSIF NOT ${stopWordsSettingsPrivilegesCondition(false)} THEN
      RAISE EXCEPTION 'Partial stop-word audit privileges';
    END IF;
  END $stop_words_settings$;\n`;
}

export const STOP_WORDS_AUDIT_INDEXES = [
  ['chat_settings_chat_id_key', 'chat_settings', ['chat_id'], [0], true],
  ['chat_admin_allowlist_pkey', 'chat_admin_allowlist', ['chat_id', 'user_id'], [0, 0], true],
  [
    'managed_entity_admin_members_chat_checked_idx',
    'managed_entity_admin_members',
    ['chat_id', 'checked_at'],
    [0, 3],
    false,
  ],
  [
    'chat_participant_moderation_immunities_chat_id_user_id_key',
    'chat_participant_moderation_immunities',
    ['chat_id', 'user_id'],
    [0, 0],
    true,
  ],
];
export function stopWordsSettingsIndexCondition() {
  return STOP_WORDS_AUDIT_INDEXES.map(
    ([name, table, columns, options, unique]) => `EXISTS(
    SELECT 1 FROM pg_index i JOIN pg_class idx ON idx.oid=i.indexrelid
    JOIN pg_namespace ns ON ns.oid=idx.relnamespace JOIN pg_class r ON r.oid=i.indrelid
    JOIN pg_am am ON am.oid=idx.relam
    WHERE ns.nspname='public' AND idx.relname='${name}' AND r.oid='public.${table}'::regclass
      AND am.amname='btree' AND i.indisvalid AND i.indisready AND i.indislive
      AND i.indisunique=${unique} AND i.indpred IS NULL AND i.indexprs IS NULL
      AND i.indnkeyatts=${columns.length} AND i.indnatts=${columns.length}
      AND (SELECT array_agg(a.attname::text ORDER BY key.ordinality)
        FROM unnest(i.indkey::smallint[]) WITH ORDINALITY key(attnum,ordinality)
        JOIN pg_attribute a ON a.attrelid=r.oid AND a.attnum=key.attnum)
        = ARRAY[${columns.map(literal).join(',')}]
      AND i.indoption::smallint[] = '${`[0:${options.length - 1}]={${options.join(',')}}`}'::smallint[]
  )`,
  ).join(' AND ');
}
export function buildStopWordsSettingsQuery(args) {
  const { chatId, wordHash, senderHash } = parseStopWordsSettingsArgs(args);
  const word = wordHash ? literal(wordHash) : 'NULL::text';
  const sender = senderHash ? literal(senderHash) : 'NULL::text';
  // FLAG: Bound the original datum before JSON operations. These PG16 compression
  // bounds use the same coherent-storage assumption as the source-envelope audit.
  // The report is metadata only; its shape checks do not attest runtime Zod validity.
  return `WITH settings AS MATERIALIZED (
    SELECT stop_words_revision,updated_at,stop_words_policy IS NULL AS legacy,
      CASE WHEN stop_words_policy IS NULL THEN NULL
        WHEN pg_column_compression(stop_words_policy) IS NULL THEN
          CASE WHEN pg_column_size(stop_words_policy)<=${SOURCE_ENVELOPE_MAX_BYTES} THEN stop_words_policy END
        WHEN current_setting('server_version_num')::integer / 10000=16 THEN
          CASE WHEN (pg_column_compression(stop_words_policy)='pglz' AND pg_column_size(stop_words_policy)<=${SOURCE_ENVELOPE_PGLZ_MAX_PHYSICAL_BYTES})
            OR (pg_column_compression(stop_words_policy)='lz4' AND pg_column_size(stop_words_policy)<=${SOURCE_ENVELOPE_LZ4_MAX_PHYSICAL_BYTES})
            THEN stop_words_policy END END AS policy
    FROM public.chat_settings WHERE chat_id='${chatId}' LIMIT 1
  ), rules AS MATERIALIZED (
    SELECT value AS rule FROM settings CROSS JOIN LATERAL jsonb_array_elements(
      CASE WHEN jsonb_typeof(policy->'rules')='array' THEN
        CASE WHEN jsonb_array_length(policy->'rules')<=999 THEN policy->'rules' ELSE '[]'::jsonb END
        ELSE '[]'::jsonb END) r(value)
  ), allowlist_probe AS MATERIALIZED (
    SELECT user_id FROM public.chat_admin_allowlist WHERE chat_id='${chatId}' ORDER BY user_id LIMIT 129
  ), members_probe AS MATERIALIZED (
    SELECT user_id,checked_at,expires_at,role FROM public.managed_entity_admin_members
      WHERE chat_id='${chatId}' ORDER BY checked_at DESC LIMIT 129
  ), immunity_probe AS MATERIALIZED (
    SELECT user_id,expires_at,daily_violation_limit,daily_violation_usage,usage_date_key,updated_at
      FROM public.chat_participant_moderation_immunities WHERE chat_id='${chatId}' ORDER BY user_id LIMIT 129
  ) SELECT jsonb_build_object('report','stop_words_settings','schemaVersion',1,'readOnly',true,
    'sampledAt',statement_timestamp(),'settingsFound',EXISTS(SELECT 1 FROM settings),
    'historicalStateProven',false,'runtimePolicyValidation','not_performed','rosterProbeLimit',129,
    'policy',(SELECT jsonb_build_object('revision',stop_words_revision,'settingsUpdatedAt',updated_at,
      'inspection',CASE WHEN legacy THEN 'legacy' WHEN policy IS NULL THEN 'storage_bound_refused' ELSE 'metadata_only' END,
      'masterEnabled',CASE WHEN jsonb_typeof(policy)='object' THEN
        CASE WHEN policy->'enabled' IS NULL THEN false WHEN jsonb_typeof(policy->'enabled')='boolean' THEN (policy->>'enabled')::boolean END END,
      'rulesWithinBound',CASE WHEN jsonb_typeof(policy->'rules')='array' THEN jsonb_array_length(policy->'rules')<=999 END,
      'rulesInspected',(SELECT count(*) FROM rules),
      'wordHashRequested',${word} IS NOT NULL,
      'matchingValueRules',(SELECT count(*) FROM rules WHERE jsonb_typeof(rule->'value')='string' AND md5(rule->>'value')=${word}),
      'matchingEnabledRules',(SELECT count(*) FROM rules WHERE md5(rule->>'value')=${word} AND (rule->'enabled' IS NULL OR rule->'enabled'='true'::jsonb)),
      'matchingExactRules',(SELECT count(*) FROM rules WHERE md5(rule->>'value')=${word} AND (rule->'matchMode' IS NULL OR rule->>'matchMode'='EXACT')),
      'matchingMaskedRules',(SELECT count(*) FROM rules WHERE md5(rule->>'value')=${word} AND rule->>'matchMode'='MASKED')
    ) FROM settings),
    'sender',jsonb_build_object('hashRequested',${sender} IS NOT NULL,
      'allowlistCapped',(SELECT count(*)>128 FROM allowlist_probe),
      'allowlistMatchObserved',EXISTS(SELECT 1 FROM allowlist_probe WHERE md5(user_id)=${sender}),
      'adminRosterCapped',(SELECT count(*)>128 FROM members_probe),
      'adminRosterMatches',(SELECT count(*) FROM members_probe WHERE md5(user_id)=${sender}),
      'latestAdminCheckAt',(SELECT max(checked_at) FROM members_probe WHERE md5(user_id)=${sender}),
      'unexpiredAdminMatchObserved',EXISTS(SELECT 1 FROM members_probe WHERE md5(user_id)=${sender}
        AND role::text IN ('OWNER','ADMIN') AND (expires_at IS NULL OR expires_at>statement_timestamp())),
      'immunitiesCapped',(SELECT count(*)>128 FROM immunity_probe),
      'immunity',(SELECT jsonb_build_object('expiresAt',expires_at,'dailyViolationLimit',daily_violation_limit,
        'dailyViolationUsage',daily_violation_usage,'usageDateKey',usage_date_key,'updatedAt',updated_at)
        FROM immunity_probe WHERE md5(user_id)=${sender} LIMIT 1)
    )) AS report`;
}
export function buildStopWordsSettingsAuditSql(args) {
  const { explain } = parseStopWordsSettingsArgs(args);
  return `SELECT ${stopWordsSettingsIndexCondition()} AS stop_words_settings_indexes_ready \\gset
\\if :stop_words_settings_indexes_ready
\\else
\\echo MAXIM_STOP_WORDS_SETTINGS_INDEXES_UNAVAILABLE
SELECT 1 / 0;
\\endif
${explain ? 'EXPLAIN (FORMAT JSON)\n' : ''}${buildStopWordsSettingsQuery(args)};\n`;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = process.argv.slice(2);
    if (
      args[0] === '--privileges' &&
      (args.length === 1 || (args.length === 2 && args[1] === '--require-all'))
    )
      process.stdout.write(buildStopWordsSettingsPrivilegesSql(args.length === 2));
    else if (args.length === 1 && args[0] === '--provision')
      process.stdout.write(buildStopWordsSettingsProvisionSql());
    else if (args[0] === '--validate-scope') parseStopWordsSettingsArgs(args.slice(1));
    else process.stdout.write(buildStopWordsSettingsAuditSql(args));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 2;
  }
}
