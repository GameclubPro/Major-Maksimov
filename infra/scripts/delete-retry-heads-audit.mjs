import { pathToFileURL } from 'node:url';

export function buildDeleteRetryHeadsIndexSql() {
  return `SELECT EXISTS (SELECT 1 FROM pg_index i
    WHERE i.indexrelid = to_regclass('public.moderation_delete_intents_due_idx')
      AND i.indrelid = to_regclass('public.moderation_delete_intents')
      AND i.indisvalid AND i.indisready AND i.indislive
      AND i.indnkeyatts = 3 AND i.indexprs IS NULL AND i.indpred IS NULL
      AND pg_get_indexdef(i.indexrelid, 1, false) = 'status'
      AND pg_get_indexdef(i.indexrelid, 2, false) = 'next_attempt_at'
      AND pg_get_indexdef(i.indexrelid, 3, false) = 'execute_at')
    AND EXISTS (SELECT 1 FROM pg_index i
    WHERE i.indexrelid = to_regclass('public.moderation_delete_intents_retention_idx')
      AND i.indrelid = to_regclass('public.moderation_delete_intents')
      AND i.indisvalid AND i.indisready AND i.indislive
      AND i.indnkeyatts = 2 AND i.indexprs IS NULL AND i.indpred IS NULL
      AND pg_get_indexdef(i.indexrelid, 1, false) = 'status'
      AND pg_get_indexdef(i.indexrelid, 2, false) = 'updated_at')
    AND EXISTS (SELECT 1 FROM pg_index i
    WHERE i.indexrelid = to_regclass('public.moderation_delete_intent_reasons_intent_reason_key')
      AND i.indrelid = to_regclass('public.moderation_delete_intent_reasons')
      AND i.indisvalid AND i.indisready AND i.indislive AND i.indisunique
      AND i.indnkeyatts = 2 AND i.indexprs IS NULL AND i.indpred IS NULL
      AND pg_get_indexdef(i.indexrelid, 1, false) = 'intent_id'
      AND pg_get_indexdef(i.indexrelid, 2, false) = 'reason_key') AS delete_retry_indexes_ready \\gset
\\if :delete_retry_indexes_ready
\\else
\\echo MAXIM_DELETE_RETRY_INDEX_UNAVAILABLE
-- FLAG: PostgreSQL 16 psql ignores a supplied exit code on \\quit. Refuse with
-- a SQL error under ON_ERROR_STOP so an empty report cannot look successful.
SELECT 1 / 0;
\\endif
`;
}

export function buildDeleteRetryHeadsAuditSql(explain = false) {
  // FLAG: Bound each indexed status head before payload/reason reads. These are
  // observations of retry clocks, not executable selection or replay authority.
  const branches = ['PENDING', 'RETRYABLE', 'WAITING_CAPABILITY', 'AMBIGUOUS', 'IN_PROGRESS'].map(
    (
      status,
    ) => `(SELECT id, status, next_attempt_at, updated_at, 'oldest_retry' AS sample_kind FROM moderation_delete_intents
      WHERE status = '${status}'::"ModerationDeleteIntentStatus"
      ORDER BY next_attempt_at LIMIT 33)`,
  );
  // FLAG: Recent observations use the status/update index independently of old retry heads.
  // Successful rows retain remote evidence; neither a status nor a saved failure proves
  // current access or authorizes replay. Every additional branch keeps the same sentinel cap.
  const recent = [
    'AMBIGUOUS',
    'RETRYABLE',
    'WAITING_CAPABILITY',
    'FAILED_TERMINAL',
    'SUCCEEDED',
  ].map(
    (
      status,
    ) => `(SELECT id, status, next_attempt_at, updated_at, 'recent_update' AS sample_kind FROM moderation_delete_intents
      WHERE status = '${status}'::"ModerationDeleteIntentStatus" ORDER BY updated_at DESC LIMIT 33)`,
  );
  return `${explain ? 'EXPLAIN (FORMAT JSON) ' : ''}WITH heads AS MATERIALIZED (
    ${[...branches, ...recent].join('\nUNION ALL\n')}
  ), samples AS MATERIALIZED (
    SELECT * FROM (SELECT *, row_number() OVER (PARTITION BY sample_kind, status ORDER BY
      CASE WHEN sample_kind = 'oldest_retry' THEN next_attempt_at END,
      CASE WHEN sample_kind = 'recent_update' THEN updated_at END DESC, id) AS ordinal
      FROM heads) ranked WHERE ordinal <= 32
  ), observations AS (
    SELECT md5(samples.id) AS intent_hash, samples.status, samples.sample_kind, samples.next_attempt_at,
      row.updated_at, row.source_message_at, row.attempt_count, row.last_attempt_at, row.retry_until_at,
      row.delete_dispatch_started_at IS NOT NULL AS dispatch_started,
      row.remote_delete_succeeded_at IS NOT NULL AS remote_success_marker,
      (row.remote_delete_succeeded_at <= statement_timestamp()
        AND nullif(btrim(row.remote_delete_succeeded_bot_id), '') IS NOT NULL)
        IS TRUE AS remote_success_pair_complete,
      row.lease_expires_at, row.last_status_code,
      CASE
        WHEN row.last_error_code = 'delete_pre_dispatch_guard_rejected'
          AND row.last_error = 'MAX direct message lookup returned a response without the requested id'
          THEN 'predispatch_exact_source_missing_id'
        -- FLAG: Classify only exact saved codes, never arbitrary error text or prefixes.
        -- These describe the saved failure, not its HTTP stage, current rights or replay safety.
        WHEN row.last_error_code IN ('ECONNABORTED', 'ETIMEDOUT') THEN 'transport_timeout'
        WHEN row.last_error_code = 'ECONNRESET' THEN 'transport_connection_reset'
        WHEN row.last_error_code = 'ECONNREFUSED' THEN 'transport_connection_refused'
        WHEN row.last_error_code = 'EPIPE' THEN 'transport_broken_pipe'
        WHEN row.last_error_code IN ('ENOTFOUND', 'EAI_AGAIN') THEN 'transport_dns_failure'
        WHEN row.last_error_code = 'MAX_API_INTERNAL_RATE_LIMIT' THEN 'max_internal_rate_limit'
        WHEN row.last_error_code IN ('MAX_API_CIRCUIT_OPEN', 'max_circuit_open') THEN 'max_circuit_open'
        WHEN row.last_error_code IN ('access.denied', 'chat.denied', 'permission.denied') THEN 'max_access_rejected'
        WHEN row.last_error_code = 'chat.not.found' THEN 'max_chat_not_found'
        WHEN row.last_error_code IN ('message.not.found', 'message_not_found', 'message.not_found') THEN 'max_message_not_found'
        WHEN row.last_error_code IN ('P1001', 'P1017', '08006') THEN 'database_connection_unavailable'
        WHEN row.last_error_code = 'P1002' THEN 'database_connection_timeout'
        WHEN row.last_error_code = 'P1008' THEN 'database_operation_timeout'
        WHEN row.last_error_code = 'P2010' THEN 'database_raw_query_error'
        WHEN row.last_error_code = 'P2024' THEN 'database_pool_timeout'
        WHEN row.last_error_code = 'P2028' THEN 'database_transaction_error'
        WHEN row.last_error_code = 'P2034' THEN 'database_write_conflict'
        WHEN row.last_error_code = '40001' THEN 'database_serialization_failure'
        WHEN row.last_error_code = '40P01' THEN 'database_deadlock'
        WHEN row.last_error_code = '55P03' THEN 'database_lock_unavailable'
        WHEN row.last_error_code = '57014' THEN 'database_statement_canceled'
        WHEN row.last_error_code IN (
          'delete_pre_dispatch_guard_rejected', 'max_action_executor_proof_rejected',
          'route_lookup_failed', 'unverified_message_not_found', 'delete_candidates_exhausted',
          'no_delete_capable_bot', 'predelete_presence_unknown', 'snapshot_missing',
          'not_admin_or_owner', 'entity_type_unknown', 'missing_chat_delete_permission',
          'missing_channel_delete_permission', 'chat_not_found', 'no_active_membership',
          'snapshot_stale', 'access_state_unconfirmed', 'access_denied', 'bot_not_actionable',
          'moderation_delete_reasons_no_longer_authorized', 'live_reason_invalid', 'live_policy_inactive',
          'live_policy_revision_changed', 'live_author_access_unknown', 'live_admin_immune',
          'live_message_identity_changed', 'live_violation_no_longer_present',
          'live_link_exact_source_unavailable')
          THEN row.last_error_code
        WHEN row.last_error_code IS NULL AND row.last_error IS NULL THEN 'none'
        ELSE 'other' END AS last_failure_family,
      (SELECT json_build_object('truncated', count(*) > 64,
        'codes', coalesce(json_agg(CASE WHEN reason.rule_code IN (
          'VOICE_BLOCKED_DELETE', 'BOT_MESSAGE_AUTO_DELETE', 'COMMERCIAL_OCR_DELETE',
          'LINK_BLOCKED_DELETE', 'LINK_HISTORY_RECOVERY', 'MUTE_ACTIVE_DELETE',
          'NIGHT_MODE_DELETE', 'MANUAL_GROUP_CLOSE_DELETE',
          'DUPLICATE_DELETE', 'REQUIRED_SUBSCRIPTION_DELETE', 'CHANNEL_AUTO_POST_FORWARD_REPLACEMENT_CLEANUP',
          'MESSAGE_TOO_LONG_DELETE', 'STICKER_RATE_LIMIT_DELETE', 'PHOTO_BLOCKED_DELETE',
          'VIDEO_BLOCKED_DELETE', 'FILE_BLOCKED_DELETE', 'MUTE_DELETE') THEN reason.rule_code ELSE 'other' END), '[]'::json))
       FROM (SELECT rule_code FROM moderation_delete_intent_reasons WHERE intent_id = samples.id
          ORDER BY reason_key LIMIT 65) reason) AS reasons
    FROM samples CROSS JOIN LATERAL (SELECT updated_at, source_message_at, attempt_count, last_attempt_at, retry_until_at,
      delete_dispatch_started_at, remote_delete_succeeded_at, remote_delete_succeeded_bot_id,
      lease_expires_at, last_status_code, last_error_code, last_error
      FROM moderation_delete_intents WHERE id = samples.id OFFSET 0) row
  ) SELECT json_build_object('schema_version',4,'audit','delete_retry_heads',
    'observed_at',statement_timestamp(),'policy_checked',false,'remote_effect_proven',false,
    'failure_classification_authority','saved_metadata_only',
    'per_group_cap',32,'sample_truncated',EXISTS (SELECT 1 FROM heads GROUP BY sample_kind, status HAVING count(*) > 32),
    'rows',coalesce((SELECT json_agg(observations ORDER BY status,next_attempt_at,intent_hash) FROM observations),'[]'::json));\n`;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const [option, ...rest] = process.argv.slice(2);
  if (rest.length || (option !== undefined && option !== '--explain'))
    throw new Error('Expected only --explain or no arguments');
  process.stdout.write(
    buildDeleteRetryHeadsIndexSql() + buildDeleteRetryHeadsAuditSql(option === '--explain'),
  );
}
