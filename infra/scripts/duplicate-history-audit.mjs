import { pathToFileURL } from 'node:url';

export function parseDuplicateHistoryArgs(args) {
  if (
    args.length < 1 ||
    args.length > 2 ||
    !/^-[1-9][0-9]{0,19}$/u.test(args[0]) ||
    (args.length === 2 && args[1] !== '--explain')
  )
    throw new Error('Usage: duplicate-history <exact-negative-chat-id> [--explain]');
  return { chatId: args[0], explain: args.length === 2 };
}

export function duplicateHistoryPrivilegePredicate(requireAll = false) {
  return `WITH columns AS (
    SELECT attribute.attname, has_column_privilege('maxim_audit', attribute.attrelid, attribute.attnum, 'SELECT') AS readable
    FROM pg_attribute attribute WHERE attribute.attrelid=to_regclass('public.duplicate_diagnostics_history')
      AND attribute.attnum>0 AND NOT attribute.attisdropped
  ) SELECT (SELECT count(*) FROM columns WHERE readable AND attname IN ('intent_id','chat_id','intent_created_at')) IN (${requireAll ? '' : '0,'}3)
    AND NOT EXISTS (SELECT 1 FROM columns WHERE readable AND attname NOT IN ('intent_id','chat_id','intent_created_at'))
    AND NOT EXISTS (SELECT 1 FROM pg_class relation WHERE relation.oid=to_regclass('public.duplicate_diagnostics_history')
      AND (has_table_privilege('maxim_audit',relation.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
      OR EXISTS (SELECT 1 FROM pg_attribute attribute WHERE attribute.attrelid=relation.oid AND attribute.attnum>0 AND NOT attribute.attisdropped
        AND has_column_privilege('maxim_audit',relation.oid,attribute.attnum,'INSERT,UPDATE,REFERENCES'))))`;
}

export function buildDuplicateHistoryPrivilegesSql(requireAll = false) {
  return `SELECT (${duplicateHistoryPrivilegePredicate(requireAll)}) AS duplicate_history_privileges_ready \\gset
\\if :duplicate_history_privileges_ready
\\else
\\echo MAXIM_DUPLICATE_HISTORY_PRIVILEGES_INVALID
SELECT 1/0;
\\endif
`;
}

export function buildDuplicateHistoryReadinessSql() {
  return `SELECT EXISTS (
    SELECT 1 FROM pg_index definition JOIN pg_class index_relation ON index_relation.oid=definition.indexrelid
    JOIN pg_am method ON method.oid=index_relation.relam
    WHERE definition.indexrelid=to_regclass('public.duplicate_diagnostics_history_chat_created_id_idx')
      AND definition.indrelid=to_regclass('public.duplicate_diagnostics_history')
      AND definition.indisvalid AND definition.indisready AND definition.indislive AND NOT definition.indcheckxmin
      AND method.amname='btree' AND definition.indnkeyatts=3 AND definition.indnatts=3
      AND definition.indpred IS NULL AND definition.indexprs IS NULL
      AND NOT definition.indisunique AND NOT definition.indisprimary AND NOT definition.indisexclusion
      AND pg_get_indexdef(definition.indexrelid,1,true)='chat_id'
      AND pg_get_indexdef(definition.indexrelid,2,true)='intent_created_at'
      AND pg_get_indexdef(definition.indexrelid,3,true)='intent_id'
      AND definition.indoption[0]=0 AND definition.indoption[1]=3 AND definition.indoption[2]=3
  ) AND EXISTS (
    SELECT 1 FROM pg_index definition WHERE definition.indexrelid=to_regclass('public.moderation_delete_intents_pkey')
      AND definition.indrelid=to_regclass('public.moderation_delete_intents') AND definition.indisprimary
      AND definition.indisvalid AND definition.indisready AND definition.indislive
      AND definition.indnkeyatts=1 AND definition.indnatts=1
      AND definition.indpred IS NULL AND definition.indexprs IS NULL
      AND pg_get_indexdef(definition.indexrelid,1,true)='id'
  ) AS duplicate_history_indexes_ready \\gset
\\if :duplicate_history_indexes_ready
\\else
\\echo MAXIM_DUPLICATE_HISTORY_INDEX_MISSING
SELECT 1/0;
\\endif
`;
}

export function buildDuplicateHistoryAuditSql(chatId, explain = false) {
  parseDuplicateHistoryArgs([chatId]);
  const target = explain ? '$1' : `'${chatId}'`;
  // FLAG: Bound the duplicate-only indexed page before point reads of intent outcomes.
  // A projected sample is not fleet coverage, and status alone never proves our DELETE.
  const query = `WITH candidates AS MATERIALIZED (
    SELECT intent_id, intent_created_at FROM duplicate_diagnostics_history
    WHERE chat_id=${target} AND intent_created_at>=statement_timestamp()-interval '24 hours'
      AND intent_created_at<=statement_timestamp()
    ORDER BY intent_created_at DESC,intent_id DESC LIMIT 129
  ), recent AS MATERIALIZED (
    SELECT * FROM candidates ORDER BY intent_created_at DESC,intent_id DESC LIMIT 128
  ), outcomes AS MATERIALIZED (
    SELECT recent.intent_created_at, intent.status,
      CASE WHEN intent.remote_delete_succeeded_at IS NOT NULL THEN 'CONFIRMED_DELETE'
        WHEN intent.absence_verified_at IS NOT NULL THEN 'CONFIRMED_ABSENCE'
        WHEN intent.status='AMBIGUOUS' THEN 'UNCONFIRMED'
        WHEN intent.status IN ('PENDING','IN_PROGRESS','RETRYABLE','WAITING_CAPABILITY') THEN 'PENDING'
        WHEN intent.status='EXPIRED' THEN 'EXPIRED'
        WHEN intent.status='OBSERVED' THEN 'OBSERVED' ELSE 'UNCONFIRMED' END AS outcome,
      CASE WHEN intent.last_error_code IN ('message_duplicate_author_immune','message_duplicate_author_not_member') THEN 'AUTHOR_PROTECTED_OR_ABSENT'
        WHEN intent.last_error_code IN ('message_duplicate_content_changed','message_duplicate_original_changed','message_duplicate_original_missing','message_duplicate_history_changed') THEN 'EVIDENCE_CHANGED'
        WHEN intent.last_error_code IN ('message_duplicate_policy_changed','message_duplicate_settings_changed','message_duplicate_schedule_closed') THEN 'POLICY_CHANGED'
        WHEN intent.last_error_code IS NULL THEN 'NONE' ELSE 'OTHER' END AS reason
    FROM recent JOIN moderation_delete_intents intent ON intent.id=recent.intent_id AND intent.chat_id=${target}
  ), groups AS (
    SELECT status,outcome,reason,count(*)::integer AS messages FROM outcomes GROUP BY status,outcome,reason
  ) SELECT json_build_object('schema_version',1,'audit','duplicate_message_outcomes',
    'sampled_at',statement_timestamp(),'basis','MESSAGES','coverage','PROJECTED_ONLY',
    'complete',false,'sample_cap',128,'sampled_messages',(SELECT count(*) FROM outcomes),
    'sample_saturated',(SELECT count(*)>128 FROM candidates),
    'missing_intents',(SELECT count(*) FROM recent)-(SELECT count(*) FROM outcomes),
    'oldest_created_at',(SELECT min(intent_created_at) FROM recent),
    'newest_created_at',(SELECT max(intent_created_at) FROM recent),
    'rows',coalesce((SELECT json_agg(groups ORDER BY status,outcome,reason) FROM groups),'[]'::json));
`;
  // FLAG: The operator's exact scope must not appear in the emitted plan. A generic
  // prepared parameter keeps both index probes scoped without exposing that identifier.
  return explain
    ? `SET LOCAL plan_cache_mode=force_generic_plan;
PREPARE maxim_duplicate_history(text) AS ${query}
EXPLAIN (FORMAT JSON) EXECUTE maxim_duplicate_history('${chatId}');
DEALLOCATE maxim_duplicate_history;
`
    : query;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = process.argv.slice(2);
    if (args[0] === '--privileges') {
      if (args.length > 2 || (args[1] && args[1] !== '--require-all'))
        throw new Error('Invalid privilege arguments');
      process.stdout.write(buildDuplicateHistoryPrivilegesSql(args[1] === '--require-all'));
    } else {
      const validateOnly = args[0] === '--validate-scope';
      const scope = parseDuplicateHistoryArgs(validateOnly ? args.slice(1) : args);
      if (!validateOnly)
        process.stdout.write(
          buildDuplicateHistoryReadinessSql() +
            buildDuplicateHistoryAuditSql(scope.chatId, scope.explain),
        );
    }
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
  }
}
