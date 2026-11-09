#!/usr/bin/env bash
set -euo pipefail
umask 077

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

AUDIT_MODE="${1:-all}"
AUDIT_WALL_TIMEOUT_SEC="${MAXIM_POSTGRES_AUDIT_WALL_TIMEOUT_SEC:-8}"
AUDIT_LOCK_FILE=/tmp/maxim-postgres-audit.lock
QUEUE_SAMPLE_CAP=2000
MONITOR_SAMPLE_CAP=2000
DUPLICATE_SETTINGS_SAMPLE_CAP=5000
DUPLICATE_EVENT_SAMPLE_CAP=5000
DUPLICATE_INTENT_SAMPLE_CAP_PER_STATUS=64
DUPLICATE_REASON_SAMPLE_CAP_PER_INTENT=8
POSTGRES_AUDIT_ROLE=maxim_audit
LEGACY_DEFAULT_DB_AUDIT_HELPER="$ROOT_DIR/infra/scripts/legacy-default-webhook-db-audit.mjs"
LEGACY_DEFAULT_SNAPSHOT_PATH=''
AUDIT_SQL_FILE=''
KARAVAN_CANDIDATE_ARGS=()
AUDIT_STDERR_FILE=''
AUDIT_BACKEND_MAY_EXIST=0
POSTGRES_AUDIT_APP_NAME="maxim-bounded-audit-$(date -u +%Y%m%dT%H%M%SZ)-${BASHPID}-${RANDOM}"
POSTGRES_AUDIT_OPTIONS='-c default_transaction_read_only=on -c statement_timeout=2500ms -c lock_timeout=250ms -c idle_in_transaction_session_timeout=4s -c idle_session_timeout=60s -c max_parallel_workers_per_gather=0 -c enable_seqscan=off -c enable_bitmapscan=off -c jit=off -c work_mem=1MB'

usage() {
  cat <<'USAGE' >&2
Usage:
  ./infra/scripts/vps-postgres-audit.sh [queue|activity|duplicate|publication-schema|storage|all]
  ./infra/scripts/vps-postgres-audit.sh queue [--explain]
  ./infra/scripts/vps-postgres-audit.sh webhook-cohort [--short] [--explain]
  ./infra/scripts/vps-postgres-audit.sh webhook-cohort --failed-window <UTC-minute> <UTC-minute> [--explain]
  ./infra/scripts/vps-postgres-audit.sh webhook-recovery-key-cohort <UTC-second> <private-chat-ID-CSV> [--explain]
  ./infra/scripts/vps-postgres-audit.sh webhook-workload [--explain]
  ./infra/scripts/vps-postgres-audit.sh legacy-order-candidates
  ./infra/scripts/vps-postgres-audit.sh legacy-order-window [--explain]
  ./infra/scripts/vps-postgres-audit.sh legacy-semantic-mirrors [--explain]
  ./infra/scripts/vps-postgres-audit.sh delete-retry-heads [--explain]
  ./infra/scripts/vps-postgres-audit.sh action-latency [--explain]
  ./infra/scripts/vps-postgres-audit.sh moderation-outcomes [--bot <bot-id>] [--explain]
  ./infra/scripts/vps-postgres-audit.sh chat-message-window <chat-id> <UTC-minute> [--slice <0..11>] [--explain]
  ./infra/scripts/vps-postgres-audit.sh chat-moderation <chat-id> [--explain]
  ./infra/scripts/vps-postgres-audit.sh duplicate [--status <STATUS>] [--explain]
  ./infra/scripts/vps-postgres-audit.sh poll-publication <poll-id> [--explain]
  ./infra/scripts/vps-postgres-audit.sh webhook-quarantine <UTC-minute> [--explain]
  ./infra/scripts/vps-postgres-audit.sh webhook-quarantine-proof <UTC-minute> [--explain] [--private-blocker-ids]
  ./infra/scripts/vps-postgres-audit.sh rules-cleanup <chat-id> [--explain]
  ./infra/scripts/vps-postgres-audit.sh publisher-comments <chat-id> [--explain]
  ./infra/scripts/vps-postgres-audit.sh publisher-publications [--explain]
  ./infra/scripts/vps-postgres-audit.sh publisher-slots <actor> <chat> <UTC-minute> [--explain]
  ./infra/scripts/vps-postgres-audit.sh publisher-slots --target <chat> <UTC-minute> [--explain]
  ./infra/scripts/vps-postgres-audit.sh publisher-access-census [--explain]
  ./infra/scripts/vps-postgres-audit.sh storage [--explain]
  ./infra/scripts/vps-postgres-audit.sh multibot-preparation [--explain]
  ./infra/scripts/vps-postgres-audit.sh webhook-owner-proof [--explain]
  ./infra/scripts/vps-postgres-audit.sh webhook-held-receipt [receipt-id] [--explain]
  ./infra/scripts/vps-postgres-audit.sh webhook-source-proof [--explain]
  ./infra/scripts/vps-postgres-audit.sh webhook-source-envelope <owner-receipt-id> [--explain]
  ./infra/scripts/vps-postgres-audit.sh webhook-retry-proof [--explain]
  ./infra/scripts/vps-postgres-audit.sh webhook-queued-proof [--explain]
  ./infra/scripts/vps-postgres-audit.sh commercial-quality [--explain]
  ./infra/scripts/vps-postgres-audit.sh network-statistics <negative-chat-ID-CSV, max 12> [--observations] [--membership=7d|30d] [--explain]
  ./infra/scripts/vps-postgres-audit.sh statistics-exchange <exact-actor-id> [--explain]
  ./infra/scripts/vps-postgres-audit.sh karavan-candidates [--after settings-id] [--limit 1..40] [--explain]
  ./infra/scripts/vps-postgres-audit.sh central-statistics <negative-chat-ID-CSV, max 12> [--explain]

The monitor-only mode is reserved for vps-monitor-readonly.sh:
  ./infra/scripts/vps-postgres-audit.sh monitor-signals <window-minutes>
USAGE
}

is_integer_between() {
  local value="$1"
  local minimum="$2"
  local maximum="$3"

  [[ "$value" =~ ^[1-9][0-9]*$ ]] && ((value >= minimum && value <= maximum))
}

if ! is_integer_between "$AUDIT_WALL_TIMEOUT_SEC" 1 8; then
  echo "MAXIM_POSTGRES_AUDIT_WALL_TIMEOUT_SEC must be an integer between 1 and 8." >&2
  exit 2
fi

if [[ ! "$POSTGRES_AUDIT_APP_NAME" =~ ^[A-Za-z0-9-]+$ ]] ||
  ((${#POSTGRES_AUDIT_APP_NAME} > 63)); then
  echo "Could not construct a safe PostgreSQL audit application name." >&2
  exit 1
fi

for required_command in docker flock timeout; do
  if ! command -v "$required_command" >/dev/null 2>&1; then
    echo "$required_command is required for bounded PostgreSQL audits." >&2
    exit 1
  fi
done

exec {AUDIT_LOCK_FD}>>"$AUDIT_LOCK_FILE"
if ! flock -n "$AUDIT_LOCK_FD"; then
  echo "Another bounded PostgreSQL audit is already running." >&2
  exit 75
fi

SIGNAL_WINDOW_MIN=''
RULES_CLEANUP_CHAT_ID=''
RULES_CLEANUP_EXPLAIN=''
DUPLICATE_EXPLAIN=''
DUPLICATE_STATUS=''
MESSAGE_WINDOW_ARGS=()
CHAT_MODERATION_ARGS=()
WEBHOOK_COHORT_ARGS=()
RECOVERY_KEY_COHORT_ARGS=()
SOURCE_ENVELOPE_OWNER=''
PUBLISHER_SLOT_ARGS=()
MODERATION_OUTCOME_ARGS=()
NETWORK_STATISTICS_ARGS=()
STATISTICS_EXCHANGE_ARGS=()
CENTRAL_STATISTICS_ARGS=()
case "$AUDIT_MODE" in
  chat-moderation)
    CHAT_MODERATION_ARGS=("${@:2}")
    node "$ROOT_DIR/infra/scripts/chat-moderation-audit.mjs" --validate-scope "${CHAT_MODERATION_ARGS[@]}" >/dev/null || exit 2
    ;;
  central-statistics)
    CENTRAL_STATISTICS_ARGS=("${@:2}")
    node "$ROOT_DIR/infra/scripts/central-statistics-audit.mjs" --validate-scope "${CENTRAL_STATISTICS_ARGS[@]}" >/dev/null || exit 2
    ;;
  statistics-exchange)
    STATISTICS_EXCHANGE_ARGS=("${@:2}")
    node "$ROOT_DIR/infra/scripts/statistics-exchange-audit.mjs" --validate-scope "${STATISTICS_EXCHANGE_ARGS[@]}" >/dev/null || exit 2
    ;;
  karavan-candidates)
    KARAVAN_CANDIDATE_ARGS=("${@:2}")
    node "$ROOT_DIR/infra/scripts/karavan-candidates-audit.mjs" --validate-scope "${KARAVAN_CANDIDATE_ARGS[@]}" >/dev/null || exit 2
    ;;
  network-statistics)
    NETWORK_STATISTICS_ARGS=("${@:2}")
    node "$ROOT_DIR/infra/scripts/network-statistics-audit.mjs" "${NETWORK_STATISTICS_ARGS[@]}" >/dev/null || exit 2
    ;;
  chat-message-window)
    MESSAGE_WINDOW_ARGS=("${@:2}")
    node "$ROOT_DIR/infra/scripts/chat-message-window-audit.mjs" "${MESSAGE_WINDOW_ARGS[@]}" >/dev/null || exit 2
    ;;
  duplicate)
    shift
    if [[ "${1:-}" == '--status' ]]; then
      case "${2:-}" in
        OBSERVED|PENDING|IN_PROGRESS|RETRYABLE|WAITING_CAPABILITY|AMBIGUOUS|SUCCEEDED|ALREADY_ABSENT|EXPIRED|FAILED_TERMINAL)
          DUPLICATE_STATUS="$2" ;;
        *) usage; exit 2 ;;
      esac
      shift 2
    fi
    if [[ $# -gt 1 || ( $# -eq 1 && "$1" != '--explain' ) ]]; then
      usage
      exit 2
    fi
    DUPLICATE_EXPLAIN="${1:-}"
    ;;
  webhook-recovery-key-cohort)
    RECOVERY_KEY_COHORT_ARGS=("${@:2}")
    node "$ROOT_DIR/infra/scripts/webhook-recovery-key-cohort-audit.mjs" "${RECOVERY_KEY_COHORT_ARGS[@]}" >/dev/null || exit 2
    ;;
  webhook-cohort)
    WEBHOOK_COHORT_ARGS=("${@:2}")
    node "$ROOT_DIR/infra/scripts/webhook-cohort-audit.mjs" "${WEBHOOK_COHORT_ARGS[@]}" >/dev/null || exit 2
    ;;
  moderation-outcomes)
    MODERATION_OUTCOME_ARGS=("${@:2}")
    node "$ROOT_DIR/infra/scripts/moderation-outcomes-audit.mjs" "${MODERATION_OUTCOME_ARGS[@]}" >/dev/null || exit 2
    ;;
  webhook-held-receipt)
    HELD_RECEIPT_ARGS=("${@:2}")
    node "$ROOT_DIR/infra/scripts/webhook-held-receipt-audit.mjs" --validate-scope "${HELD_RECEIPT_ARGS[@]}" >/dev/null || exit 2
    ;;
  webhook-workload|delete-retry-heads|action-latency|queue|publisher-publications|publisher-access-census|commercial-quality|storage|multibot-preparation|webhook-owner-proof|webhook-source-proof|webhook-retry-proof|webhook-queued-proof|legacy-order-window|legacy-semantic-mirrors)
    if [[ $# -gt 2 || ( $# -eq 2 && "$2" != '--explain' ) ]]; then
      usage
      exit 2
    fi
    RULES_CLEANUP_EXPLAIN="${2:-}"
    ;;
  publisher-slots)
    PUBLISHER_SLOT_ARGS=("${@:2}")
    node "$ROOT_DIR/infra/scripts/publisher-slot-audit.mjs" "${PUBLISHER_SLOT_ARGS[@]}" >/dev/null || exit 2
    ;;
  webhook-source-envelope)
    if [[ $# -lt 2 || $# -gt 3 || ( $# -eq 3 && "$3" != '--explain' ) ]]; then usage; exit 2; fi
    node "$ROOT_DIR/infra/scripts/webhook-source-envelope-audit.mjs" "$2" --explain >/dev/null || exit 2
    SOURCE_ENVELOPE_OWNER="$2"
    RULES_CLEANUP_EXPLAIN="${3:-}"
    ;;
  webhook-quarantine-proof)
    QUARANTINE_PROOF_ARGS=("${@:2}")
    node "$ROOT_DIR/infra/scripts/webhook-quarantine-proof-audit.mjs" "${QUARANTINE_PROOF_ARGS[@]}" >/dev/null || exit 2
    ;;
  webhook-quarantine)
    if [[ $# -lt 2 || $# -gt 3 || ( $# -eq 3 && "$3" != '--explain' ) ]]; then usage; exit 2; fi
    node "$ROOT_DIR/infra/scripts/webhook-quarantine-audit.mjs" "$2" --explain >/dev/null || exit 2
    QUARANTINE_MINUTE="$2"
    RULES_CLEANUP_EXPLAIN="${3:-}"
    ;;
  poll-publication)
    if [[ $# -lt 2 || $# -gt 3 || ! "$2" =~ ^[A-Za-z0-9_-]{1,128}$ ||
          ( $# -eq 3 && "$3" != '--explain' ) ]]; then usage; exit 2; fi
    POLL_PUBLICATION_ID="$2"
    RULES_CLEANUP_EXPLAIN="${3:-}"
    ;;
  rules-cleanup|publisher-comments)
    if [[ $# -lt 2 || $# -gt 3 || ! "$2" =~ ^-[1-9][0-9]{0,19}$ ||
          ( $# -eq 3 && "$3" != '--explain' ) ]]; then
      usage
      exit 2
    fi
    RULES_CLEANUP_CHAT_ID="$2"
    RULES_CLEANUP_EXPLAIN="${3:-}"
    ;;
  activity|publication-schema|legacy-order-candidates|all)
    if [[ $# -gt 1 ]]; then
      usage
      exit 2
    fi
    ;;
  monitor-signals)
    if [[ $# -ne 2 ]] || ! is_integer_between "$2" 1 1440; then
      echo "monitor-signals window must be an integer between 1 and 1440 minutes." >&2
      usage
      exit 2
    fi
    SIGNAL_WINDOW_MIN="$2"
    ;;
  legacy-default-webhook-jobs)
    if [[ "${MAXIM_INTERNAL_LEGACY_DEFAULT_WEBHOOK_AUDIT:-}" != "1" || $# -ne 2 ||
          "$2" != /* || ! -f "$LEGACY_DEFAULT_DB_AUDIT_HELPER" ]]; then
      echo "Internal legacy default webhook audit invocation is invalid." >&2
      exit 2
    fi
    LEGACY_DEFAULT_SNAPSHOT_PATH="$2"
    node "$LEGACY_DEFAULT_DB_AUDIT_HELPER" \
      validate-snapshot "$LEGACY_DEFAULT_SNAPSHOT_PATH" >/dev/null
    ;;
  *)
    echo "Unknown PostgreSQL audit mode: $AUDIT_MODE" >&2
    usage
    exit 2
    ;;
esac

# FLAG: This report attests public relations. Pin resolution before the shared
# privilege admission as well as the report, including pg_temp last explicitly.
if [[ "$AUDIT_MODE" == 'chat-moderation' || "$AUDIT_MODE" == 'action-latency' || "$AUDIT_MODE" == 'publisher-slots' || "$AUDIT_MODE" == 'webhook-cohort' || "$AUDIT_MODE" == 'webhook-quarantine-proof' || "$AUDIT_MODE" == 'webhook-source-envelope' || "$AUDIT_MODE" == 'webhook-held-receipt' || "$AUDIT_MODE" == 'webhook-recovery-key-cohort' || "$AUDIT_MODE" == 'network-statistics' || "$AUDIT_MODE" == 'statistics-exchange' || "$AUDIT_MODE" == 'central-statistics' || "$AUDIT_MODE" == 'karavan-candidates' ]]; then
  POSTGRES_AUDIT_OPTIONS+=' -c search_path=pg_catalog,public,pg_temp'
fi
if [[ "$AUDIT_MODE" == 'chat-moderation' || "$AUDIT_MODE" == 'action-latency' || "$AUDIT_MODE" == 'statistics-exchange' || "$AUDIT_MODE" == 'central-statistics' || "$AUDIT_MODE" == 'karavan-candidates' ]]; then POSTGRES_AUDIT_OPTIONS+=' -c timezone=UTC'; fi

emit_prelude() {
  cat <<'SQL'
\set ON_ERROR_STOP on
BEGIN READ ONLY;
SELECT CASE
  WHEN session_user = 'maxim_audit'
    AND current_user = 'maxim_audit'
    AND current_setting('default_transaction_read_only') = 'on'
    AND current_setting('max_parallel_workers_per_gather')::integer = 0
    AND current_setting('enable_seqscan') = 'off'
    AND current_setting('enable_bitmapscan') = 'off'
    AND pg_size_bytes(current_setting('work_mem')) <= 1048576
    AND pg_size_bytes(current_setting('temp_file_limit')) BETWEEN 0 AND 8388608
    AND EXISTS (
      SELECT 1
      FROM pg_roles
      WHERE rolname = 'maxim_audit'
        AND rolcanlogin
        AND NOT rolsuper
        AND NOT rolcreatedb
        AND NOT rolcreaterole
        AND NOT rolreplication
        AND NOT rolbypassrls
        AND rolinherit
        AND rolconnlimit = 1
    )
    AND pg_has_role('maxim_audit', 'pg_read_all_stats', 'member')
    AND NOT pg_has_role('maxim_audit', 'pg_read_all_data', 'member')
    AND 1 = (
      SELECT count(*)
      FROM pg_auth_members memberships
      JOIN pg_roles granted_role ON granted_role.oid = memberships.roleid
      JOIN pg_roles member_role ON member_role.oid = memberships.member
      WHERE member_role.rolname = 'maxim_audit'
        AND granted_role.rolname = 'pg_read_all_stats'
    )
    AND NOT EXISTS (
      SELECT 1
      FROM pg_auth_members memberships
      JOIN pg_roles granted_role ON granted_role.oid = memberships.roleid
      JOIN pg_roles member_role ON member_role.oid = memberships.member
      WHERE member_role.rolname = 'maxim_audit'
        AND granted_role.rolname <> 'pg_read_all_stats'
    )
    AND has_schema_privilege('maxim_audit', 'public', 'USAGE')
    AND NOT has_schema_privilege('maxim_audit', 'public', 'CREATE')
    AND has_table_privilege('maxim_audit', 'public.webhook_events', 'SELECT')
    AND has_table_privilege('maxim_audit', 'public.moderation_events', 'SELECT')
    AND NOT has_table_privilege('maxim_audit', 'public.chat_settings', 'SELECT')
    AND NOT has_table_privilege('maxim_audit', 'public.chat_rules', 'SELECT')
    AND (
      SELECT count(DISTINCT (column_name, privilege_type))
      FROM information_schema.role_column_grants
      WHERE grantee = 'maxim_audit' AND table_schema = 'public'
        AND table_name = '_prisma_migrations'
    ) IN (0, 8)
    AND NOT EXISTS (
      SELECT 1 FROM information_schema.role_column_grants
      WHERE grantee = 'maxim_audit' AND table_schema = 'public'
        AND table_name = '_prisma_migrations'
        AND (privilege_type <> 'SELECT' OR column_name NOT IN (
          'id', 'migration_name', 'checksum', 'started_at', 'finished_at',
          'rolled_back_at', 'applied_steps_count', 'logs'
        ))
    )
    AND (
      SELECT count(*) FROM pg_attribute attribute
      WHERE attribute.attrelid = to_regclass('public._prisma_migrations')
        AND attribute.attnum > 0 AND NOT attribute.attisdropped
        AND has_column_privilege('maxim_audit', attribute.attrelid, attribute.attnum, 'SELECT')
    ) IN (0, 8)
    AND NOT EXISTS (
      SELECT 1 FROM pg_class relation
      WHERE relation.oid = to_regclass('public._prisma_migrations')
        AND has_table_privilege('maxim_audit', relation.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
    )
    AND NOT EXISTS (
      SELECT 1 FROM pg_attribute attribute
      WHERE attribute.attrelid = to_regclass('public._prisma_migrations')
        AND attribute.attnum > 0 AND NOT attribute.attisdropped
        AND (
          has_column_privilege('maxim_audit', attribute.attrelid, attribute.attnum, 'INSERT,UPDATE,REFERENCES')
          OR (has_column_privilege('maxim_audit', attribute.attrelid, attribute.attnum, 'SELECT')
            AND attribute.attname NOT IN (
              'id', 'migration_name', 'checksum', 'started_at', 'finished_at',
              'rolled_back_at', 'applied_steps_count', 'logs'
            ))
        )
    )
    AND (
      SELECT count(*) FROM information_schema.role_column_grants
      WHERE grantee = 'maxim_audit' AND table_schema = 'public' AND table_name = 'chat_rules'
    ) IN (0, 10)
    AND NOT EXISTS (
      SELECT 1 FROM pg_attribute attribute
      WHERE attribute.attrelid = 'public.chat_rules'::regclass
        AND attribute.attnum > 0 AND NOT attribute.attisdropped
        AND has_column_privilege('maxim_audit', attribute.attrelid, attribute.attnum, 'SELECT')
        AND attribute.attname NOT IN (
          'chat_id', 'published_message_id', 'published_bot_id', 'publish_operation_id',
          'publish_send_started_at', 'pending_cleanup_message_id', 'pending_cleanup_bot_id',
          'pending_cleanup_intent_id', 'pending_cleanup_kind', 'updated_at'
        )
    )
    AND NOT has_table_privilege('maxim_audit', 'public.moderation_delete_intents', 'SELECT')
    AND NOT EXISTS (
      SELECT 1
      FROM pg_class relation
      JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
      JOIN pg_attribute attribute ON attribute.attrelid = relation.oid
      WHERE namespace.nspname = 'public'
        AND relation.relname IN (
          'publisher_entity_bindings', 'publisher_entity_settings',
          'managed_entity_publication_policies'
        )
        AND attribute.attnum > 0 AND NOT attribute.attisdropped
        AND has_column_privilege('maxim_audit', relation.oid, attribute.attnum, 'SELECT')
        AND NOT (
          (relation.relname = 'publisher_entity_bindings' AND attribute.attname IN (
            'chat_id', 'status', 'bot_access_state', 'bot_access_checked_at',
            'bot_access_expires_at', 'send_route_quarantined_until', 'publisher_bot_id', 'last_webhook_at', 'bot_access_source'
          ))
          OR (relation.relname = 'publisher_entity_settings' AND attribute.attname IN (
            'chat_id', 'chat_comments_enabled', 'chat_comments_admins_enabled',
            'chat_comments_posts_enabled', 'channel_comments_enabled', 'updated_at'
          ))
          OR (relation.relname = 'managed_entity_publication_policies'
            AND attribute.attname IN ('chat_id', 'publik_enabled'))
        )
    )
    AND NOT has_table_privilege(
      'maxim_audit',
      'public.moderation_delete_intent_reasons',
      'SELECT'
    )
    AND 2 = (
      SELECT count(*)
      FROM information_schema.role_table_grants
      WHERE grantee = 'maxim_audit'
        AND table_schema = 'public'
        AND table_name IN ('webhook_events', 'moderation_events')
        AND privilege_type = 'SELECT'
    )
    AND NOT EXISTS (
      SELECT 1
      FROM information_schema.role_table_grants
      WHERE grantee = 'maxim_audit'
        AND NOT (
          table_schema = 'public'
          AND table_name IN ('webhook_events', 'moderation_events')
          AND privilege_type = 'SELECT'
        )
    )
    AND NOT EXISTS (
      SELECT 1
      FROM information_schema.role_column_grants
      WHERE grantee = 'maxim_audit'
        AND table_schema = 'public'
        AND table_name IN (
          'chat_settings',
          'moderation_delete_intents',
          'moderation_delete_intent_reasons'
        )
        AND NOT (
          privilege_type = 'SELECT'
          AND (
            (
              table_name = 'chat_settings'
              AND column_name IN (
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
                'chat_id', 'link_policy', 'link_rules_policy', 'link_policy_revision',
                'link_policy_effective_at', 'russian_profanity_filter_enabled',
                'profanity_sensitivity', 'updated_at'
              )
            )
            OR (
              table_name = 'moderation_delete_intents'
              AND column_name IN ('id', 'status', 'updated_at', 'chat_id', 'message_id', 'subject_user_id', 'source_message_at', 'attempt_count', 'leased_from_status', 'lease_token', 'lease_expires_at', 'delete_dispatch_started_at', 'delete_dispatch_started_bot_id', 'remote_delete_succeeded_at', 'remote_delete_succeeded_bot_id', 'completed_at', 'absence_verified_at', 'absence_verification_code', 'retry_until_at', 'next_attempt_at', 'first_attempt_at', 'last_attempt_at', 'last_status_code', 'last_error_code', 'last_error')
            )
            OR (
              table_name = 'moderation_delete_intent_reasons'
              AND column_name IN ('intent_id', 'reason_key', 'rule_code', 'metadata')
            )
          )
        )
    )
    AND (
      0 = (
        SELECT count(DISTINCT (table_name, column_name, privilege_type))
        FROM information_schema.role_column_grants
        WHERE grantee = 'maxim_audit'
          AND table_schema = 'public'
          AND table_name IN (
            'chat_settings',
            'moderation_delete_intents',
            'moderation_delete_intent_reasons'
          )
      )
      OR (
        (
          SELECT count(DISTINCT (table_name, column_name, privilege_type))
          FROM information_schema.role_column_grants
          WHERE grantee = 'maxim_audit'
            AND table_schema = 'public'
            AND table_name IN (
              'chat_settings',
              'moderation_delete_intents',
              'moderation_delete_intent_reasons'
            )
            AND privilege_type = 'SELECT'
        ) IN (40, 48)
      )
    )
    AND NOT EXISTS (
      SELECT 1
      FROM pg_class restricted_relation
      JOIN pg_namespace restricted_namespace
        ON restricted_namespace.oid = restricted_relation.relnamespace
      JOIN pg_attribute restricted_attribute
        ON restricted_attribute.attrelid = restricted_relation.oid
      WHERE restricted_namespace.nspname = 'public'
        AND restricted_relation.relname IN (
          'chat_settings',
          'moderation_delete_intents',
          'moderation_delete_intent_reasons'
        )
        AND restricted_attribute.attnum > 0
        AND NOT restricted_attribute.attisdropped
        AND has_column_privilege(
          'maxim_audit',
          restricted_relation.oid,
          restricted_attribute.attnum,
          'SELECT'
        )
        AND NOT (
          (
            restricted_relation.relname = 'chat_settings'
            AND restricted_attribute.attname IN (
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
              'chat_id', 'link_policy', 'link_rules_policy', 'link_policy_revision',
              'link_policy_effective_at', 'russian_profanity_filter_enabled',
              'profanity_sensitivity', 'updated_at'
            )
          )
          OR (
            restricted_relation.relname = 'moderation_delete_intents'
            AND restricted_attribute.attname IN ('id', 'status', 'updated_at', 'chat_id', 'message_id', 'subject_user_id', 'source_message_at', 'attempt_count', 'leased_from_status', 'lease_token', 'lease_expires_at', 'delete_dispatch_started_at', 'delete_dispatch_started_bot_id', 'remote_delete_succeeded_at', 'remote_delete_succeeded_bot_id', 'completed_at', 'absence_verified_at', 'absence_verification_code', 'retry_until_at', 'next_attempt_at', 'first_attempt_at', 'last_attempt_at', 'last_status_code', 'last_error_code', 'last_error')
          )
          OR (
            restricted_relation.relname = 'moderation_delete_intent_reasons'
            AND restricted_attribute.attname IN ('intent_id', 'reason_key', 'rule_code', 'metadata')
          )
        )
    )
    AND NOT EXISTS (
      SELECT 1
      FROM pg_class relation
      JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
      WHERE relation.relkind IN ('r', 'p', 'v', 'm', 'f')
        AND namespace.nspname NOT IN ('pg_catalog', 'information_schema')
        AND namespace.nspname !~ '^pg_toast'
        AND (
          (
            NOT (
              namespace.nspname = 'public'
              AND relation.relname IN (
              'webhook_events',
              'moderation_events',
              'publisher_entity_bindings',
              'publisher_entity_settings',
              'managed_entity_publication_policies',
              'chat_rules', 'managed_polls', 'chat_bot_memberships', 'chat_admin_roster_states', 'webhook_dependency_quarantines',
              'publications', 'publication_schedules', 'publication_occurrences',
              'publication_targets', 'managed_entity_access_edges', 'managed_bot_chat_catalog',
              'managed_broadcast_deliveries', 'managed_broadcasts', 'chats', 'commercial_review_samples', '_prisma_migrations',
              'webhook_execution_claims', 'max_action_ledger',
              'webhook_legacy_recoveries', 'webhook_legacy_sealed_authorities',
              'webhook_legacy_quiescence_certificates', 'webhook_source_abandonments',
              'webhook_backlog_receipts',
              'channel_audience_snapshots', 'channel_stats_sync_states', 'channel_posts', 'channel_post_view_snapshots',
              'managed_entity_audience_observations', 'channel_view_observation_states', 'channel_view_observed_intervals',
              'channel_view_archive_states', 'marketplace_bindings', 'chat_membership_activity_rollups', 'chat_membership_activity_feed_items',
              'stats_entities', 'stats_authorities', 'stats_measurements', 'stats_ingest_requests', 'stats_changes',
              'statistics_exchange_grants', 'statistics_exchange_entities', 'statistics_exchange_imports', 'statistics_exchange_generations',
              'karavan_marketplace_candidate_settings', 'karavan_marketplace_candidate_events',
                'chat_settings',
                'moderation_delete_intents',
                'moderation_delete_intent_reasons'
              )
            )
            AND (
              has_table_privilege('maxim_audit', relation.oid, 'SELECT')
              OR EXISTS (
                SELECT 1
                FROM pg_attribute attribute
                WHERE attribute.attrelid = relation.oid
                  AND attribute.attnum > 0
                  AND NOT attribute.attisdropped
                  AND has_column_privilege(
                    'maxim_audit',
                    relation.oid,
                    attribute.attnum,
                    'SELECT'
                  )
              )
            )
          )
          OR has_table_privilege(
            'maxim_audit',
            relation.oid,
            'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
          )
          OR EXISTS (
            SELECT 1
            FROM pg_attribute attribute
            WHERE attribute.attrelid = relation.oid
              AND attribute.attnum > 0
              AND NOT attribute.attisdropped
              AND has_column_privilege(
                'maxim_audit',
                relation.oid,
                attribute.attnum,
                'INSERT,UPDATE,REFERENCES'
              )
          )
        )
    ) THEN 'true'
  ELSE 'false'
END AS audit_session_ready \gset
\if :audit_session_ready
\else
-- FLAG: PostgreSQL 16 psql does not return a supplied exit code from \quit.
-- ON_ERROR_STOP must terminate with an actual SQL error before any report.
\echo MAXIM_POSTGRES_AUDIT_SESSION_INVALID
SELECT 1 / 0;
\endif
SQL
}

emit_queue_audit() {
  cat <<SQL
SELECT CASE
  WHEN EXISTS (
    SELECT 1 FROM pg_index index_state
    WHERE index_state.indexrelid = to_regclass('public.webhook_events_status_created_at_id_idx')
      AND index_state.indrelid = to_regclass('public.webhook_events')
      AND index_state.indisvalid AND index_state.indisready
      AND index_state.indnkeyatts = 3 AND index_state.indnatts = 3
      AND index_state.indexprs IS NULL AND index_state.indpred IS NULL
      AND ARRAY(
        SELECT pg_get_indexdef(index_state.indexrelid, key_position, false)
        FROM generate_series(1, index_state.indnkeyatts) AS key_position
        ORDER BY key_position
      ) = ARRAY['status', 'created_at', 'id']
  ) AND to_regclass('public.webhook_events_ordered_chat_head_idx') IS NOT NULL THEN 'true'
  ELSE 'false'
END AS queue_audit_index_ready \gset
\if :queue_audit_index_ready
SQL
  if [[ -n "$RULES_CLEANUP_EXPLAIN" ]]; then
    printf '%s\n' 'EXPLAIN (FORMAT JSON)'
  fi
  cat <<SQL
WITH queue_statuses(status) AS (
  VALUES
    ('RECEIVED'::"WebhookStatus"),
    ('QUEUED'::"WebhookStatus"),
    ('FAILED'::"WebhookStatus")
), bounded_events AS MATERIALIZED (
  SELECT queue_statuses.status, sample.created_at
  FROM queue_statuses
  LEFT JOIN LATERAL (
    SELECT webhook_events.created_at
    FROM webhook_events
    WHERE webhook_events.status = queue_statuses.status
    ORDER BY webhook_events.created_at ASC, webhook_events.id ASC
    LIMIT $((QUEUE_SAMPLE_CAP + 1))
  ) AS sample ON TRUE
), summary AS (
  SELECT
    status,
    count(created_at)::bigint AS sampled_count,
    min(created_at) AS oldest_created_at
  FROM bounded_events
  GROUP BY status
)
SELECT json_build_object(
  'schema_version', 1,
  'audit', 'webhook_queue',
  'sample_cap_per_status', $QUEUE_SAMPLE_CAP,
  'rows', json_agg(
    json_build_object(
      'status', status::text,
      'count_lower_bound', least(sampled_count, $QUEUE_SAMPLE_CAP),
      'saturated', sampled_count > $QUEUE_SAMPLE_CAP,
      'oldest_enqueue_attempts', oldest.enqueue_attempts,
      'oldest_retry_in_seconds', CASE
        WHEN oldest.next_enqueue_at IS NULL THEN NULL
        ELSE greatest(0, ceil(extract(epoch FROM oldest.next_enqueue_at - clock_timestamp()))::bigint)
      END,
      'oldest_preparation_state', oldest.preparation_state,
      'oldest_preparation_reason', oldest.preparation_reason,
      'oldest_ordering_fence', predecessor.fence,
      'oldest_ordering_predecessor', CASE WHEN predecessor.fence IS NULL THEN NULL ELSE
        json_build_object(
          'age_seconds', greatest(0, floor(extract(epoch FROM clock_timestamp() - predecessor.created_at))::bigint),
          'event_type', predecessor.event_type,
          'enqueue_attempts', predecessor.enqueue_attempts,
          'error_kind', predecessor.error_kind,
          'error_family', predecessor.error_family,
          'error_truncated', predecessor.error_truncated,
          'quarantine_subtype', predecessor.quarantine_subtype,
          'quarantine_deadline_present', predecessor.timeout_quarantine_expires_at IS NOT NULL,
          'quarantine_deadline_expired', CASE WHEN predecessor.timeout_quarantine_expires_at IS NULL THEN NULL ELSE
            predecessor.timeout_quarantine_expires_at <= clock_timestamp() END,
          'quarantine_deadline_in_seconds', CASE WHEN predecessor.timeout_quarantine_expires_at IS NULL THEN NULL ELSE
            greatest(0, ceil(extract(epoch FROM predecessor.timeout_quarantine_expires_at - clock_timestamp()))::bigint) END,
          'quarantine_deadline_overdue_seconds', CASE WHEN predecessor.timeout_quarantine_expires_at IS NULL THEN NULL ELSE
            greatest(0, floor(extract(epoch FROM clock_timestamp() - predecessor.timeout_quarantine_expires_at))::bigint) END,
          'source_marker', predecessor.source_marker,
          'raw_source_present', predecessor.raw_source_present,
          'direct_update_timestamp_shape', predecessor.direct_update_timestamp_shape,
          'direct_update_receipt_delta_seconds', CASE
            WHEN predecessor.direct_update_timestamp_shape IN ('numeric_seconds', 'numeric_milliseconds') THEN
              round((predecessor.direct_update_timestamp_ms / 1000) - extract(epoch FROM predecessor.created_at), 3)
            ELSE NULL END,
          'direct_message_shape', predecessor.direct_message_shape,
          'direct_message_timestamp_shape', predecessor.direct_message_timestamp_shape,
          'direct_message_receipt_delta_seconds', CASE
            WHEN predecessor.direct_message_timestamp_shape IN ('numeric_seconds', 'numeric_milliseconds') THEN
              round((predecessor.direct_message_timestamp_ms / 1000) - extract(epoch FROM predecessor.created_at), 3)
            ELSE NULL END,
          'webhook_service_line', predecessor.webhook_service_line,
          'retry_in_seconds', CASE WHEN predecessor.next_enqueue_at IS NULL THEN NULL ELSE
            greatest(0, ceil(extract(epoch FROM predecessor.next_enqueue_at - clock_timestamp()))::bigint) END,
          'retry_overdue_seconds', CASE WHEN predecessor.next_enqueue_at IS NULL THEN NULL ELSE
            greatest(0, floor(extract(epoch FROM clock_timestamp() - predecessor.next_enqueue_at))::bigint) END
        ) END,
      'oldest_age_seconds', CASE
        WHEN oldest_created_at IS NULL THEN 0
        ELSE greatest(
          0,
          floor(extract(epoch FROM clock_timestamp() - oldest_created_at))::bigint
        )
      END
    )
    ORDER BY status::text
  )
)::text
FROM summary
LEFT JOIN LATERAL (
  SELECT
    id,
    created_at,
    enqueue_attempts,
    next_enqueue_at,
    CASE
      WHEN LOWER(COALESCE(NULLIF(BTRIM(normalized_payload->>'type'), ''),
        NULLIF(BTRIM(normalized_payload->>'update_type'), '')))
        = ANY(ARRAY['message_created', 'message_edited'])
      THEN COALESCE(NULLIF(BTRIM(normalized_payload->'message'->>'chatId'), ''),
        NULLIF(BTRIM(normalized_payload->>'chatId'), ''))
      ELSE NULL
    END AS message_chat_id,
    -- FLAG: Only fixed error categories leave this bounded oldest-row lookup.
    CASE
      WHEN error_message IS NULL THEN 'pristine'
      WHEN error_message LIKE 'Webhook preparation deferred: canonical webhook preparation%'
        THEN 'canonical_pending'
      WHEN error_message LIKE 'Webhook preparation deferred: Committed membership denial cache%'
        THEN 'membership_cache_pending'
      WHEN error_message = 'Webhook preparation deferred: Webhook preparation capacity unavailable'
        THEN 'preparation_capacity'
      WHEN error_message LIKE 'Webhook preparation deferred:%' THEN 'preparation_deferred'
      WHEN error_message LIKE 'WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINED:%' THEN 'timeout_quarantined'
      WHEN error_message LIKE 'Webhook preparation failed:%' THEN 'preparation_failed'
      ELSE 'other'
    END AS preparation_state,
    -- FLAG: Exact source-defined reasons only; arbitrary error text and suffixes stay private.
    -- This describes the last deferral, never authority to settle, expire or replay the receipt.
    CASE error_message
      WHEN 'Webhook preparation deferred: Legacy scope installation is not sealed' THEN 'legacy_scope_unsealed'
      WHEN 'Webhook preparation deferred: Publisher receipt semantic namespace requires reviewed recovery' THEN 'publisher_namespace_recovery'
      WHEN 'Webhook preparation deferred: Publisher receipt semantic backfill changed' THEN 'publisher_namespace_changed'
      WHEN 'Webhook preparation deferred: Semantic execution authority storage unavailable' THEN 'claim_storage_unavailable'
      WHEN 'Webhook preparation deferred: Legacy semantic execution requires exact proof recovery' THEN 'legacy_execution_recovery'
      WHEN 'Webhook preparation deferred: Semantic execution authority changed' THEN 'claim_authority_changed'
      WHEN 'Webhook preparation deferred: Ownerless semantic execution proof incomplete' THEN 'ownerless_claim_incomplete'
      WHEN 'Webhook preparation deferred: Expired executor waiting proof changed' THEN 'expired_wait_changed'
      WHEN 'Webhook preparation deferred: Canonical receipt identity missing' THEN 'canonical_receipt_missing'
      WHEN 'Webhook preparation deferred: Canonical owner semantic proof unavailable' THEN 'canonical_source_unavailable'
      WHEN 'Webhook preparation deferred: Canonical owner retains timeout replay fence' THEN 'canonical_timeout_fence'
      WHEN 'Webhook preparation deferred: Terminal canonical owner requires proof recovery' THEN 'terminal_owner_recovery'
      WHEN 'Webhook preparation deferred: Canonical preparation lease pending' THEN 'canonical_lease_pending'
      WHEN 'Webhook preparation deferred: Canonical owner changed during preparation' THEN 'canonical_owner_changed'
      WHEN 'Webhook preparation deferred: Canonical owner disappeared' THEN 'canonical_owner_missing'
      WHEN 'Webhook preparation deferred: Canonical mirror proof pending' THEN 'canonical_mirror_pending'
      WHEN 'Webhook preparation deferred: Completed owning semantic authority proof incomplete' THEN 'completed_owner_incomplete'
      WHEN 'Webhook preparation deferred: Completed owning claim changed' THEN 'completed_claim_changed'
      WHEN 'Webhook preparation deferred: Completed owning receipt changed' THEN 'completed_receipt_changed'
      WHEN 'Webhook preparation deferred: Suggestion membership wake pending' THEN 'suggestion_membership_wake'
      WHEN 'Webhook preparation deferred: Membership cache invalidation pending' THEN 'membership_cache_invalidation'
      WHEN 'Webhook preparation deferred: Fresh command source proof changed' THEN 'fresh_command_source_changed'
      WHEN 'Webhook preparation deferred: Managed entity handshake preparation pending' THEN 'managed_handshake_pending'
      WHEN 'Webhook preparation deferred: Current execution owner probe pending' THEN 'current_owner_probe'
      WHEN 'Webhook preparation deferred: Incoming execution owner probe pending' THEN 'incoming_owner_probe'
      WHEN 'Webhook preparation deferred: Webhook read model persistence pending' THEN 'read_model_persistence'
      WHEN 'Webhook preparation deferred: Execution owner recheck pending' THEN 'owner_recheck_handoff'
      WHEN 'Webhook preparation deferred: Chat admin roster handoff pending' THEN 'admin_roster_handoff'
      WHEN 'Webhook preparation deferred: Webhook preparation capacity unavailable' THEN 'preparation_capacity'
      WHEN 'Webhook preparation deferred: canonical webhook preparation is still pending' THEN 'canonical_preparation_pending'
      WHEN 'Webhook preparation deferred: Canonical order proxy owner changed' THEN 'canonical_proxy_changed'
      ELSE 'unknown'
    END AS preparation_reason
  FROM webhook_events
  WHERE webhook_events.status = summary.status
  ORDER BY webhook_events.created_at ASC, webhook_events.id ASC
  LIMIT 1
) oldest ON TRUE
LEFT JOIN LATERAL (
  -- FLAG: Project only the indexed predecessor already selected below. Direct numeric
  -- timestamps are diagnostic scalars, never canonical source/cutoff or no-effects proof.
  -- Strings, alternative dates and nested/scored MAX messages remain unknown; do not cast them.
  SELECT numeric_source.*,
    CASE
      WHEN original_source IS NULL THEN 'shape_unknown'
      WHEN original_source->'timestamp' IS NULL OR original_source->'timestamp' = 'null'::jsonb THEN
        CASE WHEN original_source ?| ARRAY['created_at', 'createdAt', 'data', 'event', 'raw']
          THEN 'shape_unknown' ELSE 'missing' END
      WHEN jsonb_typeof(original_source->'timestamp') <> 'number' THEN 'shape_unknown'
      WHEN direct_update_number IS NULL OR direct_update_number <= 0
        OR direct_update_timestamp_ms < 1 OR direct_update_timestamp_ms > 8640000000000000
        THEN 'invalid_numeric'
      WHEN direct_update_number < 10000000000 THEN 'numeric_seconds'
      ELSE 'numeric_milliseconds'
    END AS direct_update_timestamp_shape,
    CASE
      WHEN original_source IS NULL THEN 'shape_unknown'
      WHEN jsonb_typeof(original_source->'message') = 'object' THEN 'object'
      WHEN original_source->'message' IS NULL OR original_source->'message' = 'null'::jsonb THEN
        CASE WHEN original_source ?| ARRAY['data', 'event', 'message_created', 'message_edited', 'raw']
          THEN 'shape_unknown' ELSE 'missing' END
      ELSE 'shape_unknown'
    END AS direct_message_shape,
    CASE
      WHEN original_source IS NULL THEN 'shape_unknown'
      WHEN jsonb_typeof(original_source->'message') IS DISTINCT FROM 'object' THEN
        CASE WHEN (original_source->'message' IS NULL OR original_source->'message' = 'null'::jsonb)
          AND NOT original_source ?| ARRAY['data', 'event', 'message_created', 'message_edited', 'raw']
          THEN 'missing' ELSE 'shape_unknown' END
      WHEN original_source#>'{message,timestamp}' IS NULL OR original_source#>'{message,timestamp}' = 'null'::jsonb THEN
        CASE WHEN original_source->'message' ?| ARRAY['created_at', 'createdAt']
          THEN 'shape_unknown' ELSE 'missing' END
      WHEN jsonb_typeof(original_source#>'{message,timestamp}') <> 'number' THEN 'shape_unknown'
      WHEN direct_message_number IS NULL OR direct_message_number <= 0
        OR direct_message_timestamp_ms < 1 OR direct_message_timestamp_ms > 8640000000000000
        THEN 'invalid_numeric'
      WHEN direct_message_number < 10000000000 THEN 'numeric_seconds'
      ELSE 'numeric_milliseconds'
    END AS direct_message_timestamp_shape
  FROM (
    SELECT guarded_source.*,
      trunc(CASE WHEN direct_update_number < 10000000000 THEN direct_update_number * 1000
        ELSE direct_update_number END) AS direct_update_timestamp_ms,
      trunc(CASE WHEN direct_message_number < 10000000000 THEN direct_message_number * 1000
        ELSE direct_message_number END) AS direct_message_timestamp_ms
    FROM (
      SELECT direct_source.*,
        -- FLAG: Cast only bounded JSON numbers whose complete decimal shape is known.
        -- Oversized/malformed values stay invalid or unknown without an unsafe SQL cast.
        CASE WHEN jsonb_typeof(original_source->'timestamp') = 'number'
          AND length(original_source->>'timestamp') <= 32
          AND original_source->>'timestamp' ~ '^[0-9]+([.][0-9]+)?$'
          THEN (original_source->>'timestamp')::numeric ELSE NULL END AS direct_update_number,
        CASE WHEN jsonb_typeof(original_source->'message') = 'object'
          AND jsonb_typeof(original_source#>'{message,timestamp}') = 'number'
          AND length(original_source#>>'{message,timestamp}') <= 32
          AND original_source#>>'{message,timestamp}' ~ '^[0-9]+([.][0-9]+)?$'
          THEN (original_source#>>'{message,timestamp}')::numeric ELSE NULL END AS direct_message_number
      FROM (
        SELECT saved_predecessor.*,
          CASE WHEN normalized_payload->'eventTimestampSource' IS NULL
            OR normalized_payload->'eventTimestampSource' = 'null'::jsonb
            OR (jsonb_typeof(normalized_payload->'eventTimestampSource') = 'string'
              AND BTRIM(normalized_payload->>'eventTimestampSource') = '') THEN 'missing'
            WHEN jsonb_typeof(normalized_payload->'eventTimestampSource') = 'string'
              AND LOWER(BTRIM(normalized_payload->>'eventTimestampSource')) IN ('payload', 'ingress')
              THEN LOWER(BTRIM(normalized_payload->>'eventTimestampSource'))
            ELSE 'other' END AS source_marker,
          COALESCE(jsonb_typeof(normalized_payload->'raw') = 'object', false) AS raw_source_present,
          CASE WHEN jsonb_typeof(normalized_payload->'raw') = 'object' THEN normalized_payload->'raw'
            WHEN jsonb_typeof(normalized_payload->'eventTimestampSource') = 'string'
              AND LOWER(BTRIM(normalized_payload->>'eventTimestampSource')) = 'payload'
              THEN normalized_payload
            ELSE NULL END AS original_source
        FROM (
  SELECT CASE
    WHEN status = 'FAILED'::"WebhookStatus"
      AND LEFT(COALESCE(error_message, ''), 37) = 'WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINED:'
      THEN 'timeout_quarantined'
    WHEN status = 'FAILED'::"WebhookStatus" THEN 'retry_pending'
    WHEN status = 'QUEUED'::"WebhookStatus" THEN 'queued_predecessor'
    ELSE 'received_predecessor'
  END AS fence,
    CASE LOWER(COALESCE(NULLIF(BTRIM(normalized_payload->>'type'), ''),
      NULLIF(BTRIM(normalized_payload->>'update_type'), '')))
      WHEN 'message_created' THEN 'message_created'
      WHEN 'message_edited' THEN 'message_edited'
      ELSE 'unknown'
    END AS event_type,
    created_at,
    enqueue_attempts,
    next_enqueue_at,
    timeout_quarantine_expires_at,
    normalized_payload,
    -- FLAG: Match complete fixed markers or anchored source-defined UUID envelopes only.
    -- These labels and deadline scalars describe saved evidence; none authorizes replay or release.
    CASE
      WHEN error_message = 'WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINED:LEGACY_EXECUTION_UNVERIFIED; exact effects proof required'
        THEN 'legacy_execution_unverified'
      WHEN error_message = 'WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINED:CANONICAL_BUSINESS_ALREADY_STARTED; durable-effects recovery required'
        THEN 'canonical_business_started'
      WHEN error_message ~ '^WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINED:[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}: Webhook user-facing hot path timed out after [1-9][0-9]*ms for (message_created|message_edited)([[:space:]]\|[[:space:]]|;|$)'
        THEN 'detached_timeout'
      WHEN error_message ~ '^WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINED:[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}: detached execution completed without a canonical claim: .+'
        THEN 'unclaimed_detached_completed'
      WHEN error_message ~ '^WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINED:[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}: detached execution failed without a canonical claim: .+'
        THEN 'unclaimed_detached_failed'
      WHEN LEFT(COALESCE(error_message, ''), 37) = 'WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINED:'
        THEN 'other_pending'
      ELSE NULL
    END AS quarantine_subtype,
    -- FLAG: Classify only the exact indexed predecessor; never return its error text or identity.
    CASE
      WHEN error_message IS NULL THEN 'pristine'
      WHEN error_message LIKE 'WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINED:%' THEN 'timeout_quarantined'
      WHEN error_message LIKE 'Webhook preparation deferred: canonical webhook preparation%'
        THEN 'canonical_pending'
      WHEN error_message LIKE 'Webhook preparation deferred: Committed membership denial cache%'
        THEN 'membership_cache_pending'
      WHEN error_message = 'Webhook preparation deferred: Webhook preparation capacity unavailable'
        THEN 'preparation_capacity'
      WHEN error_message LIKE 'Webhook preparation deferred:%' THEN 'preparation_deferred'
      WHEN error_message LIKE 'Webhook preparation failed:%' THEN 'preparation_failed'
      WHEN error_message LIKE 'Failed to retry existing failed job:%' THEN 'queue_retry_failed'
      ELSE 'other'
    END AS error_kind,
    -- FLAG: Error text is untrusted and may contain payloads. Emit fixed families only.
    CASE
      WHEN error_message IS NULL THEN 'none'
      WHEN error_message ~ '^(Webhook preparation failed: )?Canonical webhook claim is not ready for .+'
        THEN 'canonical_not_ready'
      WHEN error_message ~ '^(Webhook preparation failed: )?Canonical webhook business lease is busy for .+'
        THEN 'canonical_business_lease_busy'
      WHEN error_message ~ '^(Webhook preparation failed: )?Canonical webhook business lease was lost (before completion|before unfenced timeout settlement|during timeout quarantine) for .+'
        THEN 'canonical_business_lease_lost'
      WHEN error_message ~ '^(Webhook preparation failed: )?Canonical webhook business lease storage is unavailable for .+'
        THEN 'canonical_business_lease_unavailable'
      WHEN error_message IN (
        'Chat rules publication is in flight; retry own-bot message classification',
        'Webhook preparation failed: Chat rules publication is in flight; retry own-bot message classification'
      ) THEN 'rules_publication_fence'
      WHEN error_message ~ '^(Webhook preparation failed: )?No eligible moderation executor$'
        THEN 'no_eligible_executor'
      WHEN error_message ~ '^(Webhook preparation failed: )?Moderation job already exists but cannot be loaded$'
        THEN 'job_missing'
      WHEN error_message ~ '^(Webhook preparation failed: )?Moderation job exists in unsupported state: .+'
        THEN 'job_state_unsupported'
      WHEN error_message ILIKE '%preparation lease was lost%' THEN 'preparation_lease_lost'
      WHEN error_message ILIKE '%execution claim disappeared%' THEN 'execution_claim_missing'
      WHEN error_message ILIKE '%Publisher webhook lifecycle boundary is unavailable%'
        THEN 'publisher_boundary_unavailable'
      WHEN error_message ILIKE '%foreign key constraint%' THEN 'foreign_key'
      WHEN error_message ILIKE '%unique constraint%' OR error_message LIKE '%P2002%'
        THEN 'unique_constraint'
      WHEN error_message ILIKE '%record to update not found%' OR error_message LIKE '%P2025%'
        THEN 'record_missing'
      WHEN error_message ILIKE '%transaction already closed%' OR error_message LIKE '%P2028%'
        THEN 'transaction_expired'
      WHEN error_message ILIKE '%deadlock detected%' THEN 'deadlock'
      WHEN error_message ILIKE '%could not serialize access%' THEN 'serialization_conflict'
      WHEN error_message ILIKE '%statement timeout%' THEN 'statement_timeout'
      WHEN error_message ILIKE '%request failed with status code 400%' THEN 'http_400'
      WHEN error_message ILIKE '%request failed with status code 401%' THEN 'http_401'
      WHEN error_message ILIKE '%request failed with status code 403%' THEN 'http_403'
      WHEN error_message ILIKE '%request failed with status code 404%' THEN 'http_404'
      WHEN error_message ILIKE '%request failed with status code 429%' THEN 'http_429'
      WHEN error_message ILIKE '%cannot read properties of%' THEN 'invalid_object_state'
      WHEN error_message ILIKE '%circular structure%' THEN 'circular_json'
      WHEN error_message ILIKE '%invalid%invocation%' THEN 'prisma_invocation'
      WHEN error_message ILIKE '%timeout%' OR error_message ILIKE '%timed out%' THEN 'timeout'
      WHEN error_message ILIKE '%connection%' THEN 'connection'
      ELSE 'other'
    END AS error_family,
    length(COALESCE(error_message, '')) >= 500 AS error_truncated,
    substring(error_message FROM '/app/apps/api/dist/apps/api/src/webhook/webhook[.]service[.]js:([0-9]{1,7}):')::integer
      AS webhook_service_line
  FROM webhook_events
  -- FLAG: Match the ordered-chat-head partial index; this is one exact chat from one oldest row.
  WHERE (
    status = ANY(ARRAY['RECEIVED', 'QUEUED']::"WebhookStatus"[])
    OR (status = 'FAILED'::"WebhookStatus" AND (
      next_enqueue_at IS NOT NULL
      OR LEFT(COALESCE(error_message, ''), 37) = 'WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINED:'
    ))
  )
    AND LOWER(COALESCE(NULLIF(BTRIM(normalized_payload->>'type'), ''),
      NULLIF(BTRIM(normalized_payload->>'update_type'), '')))
      = ANY(ARRAY['message_created', 'message_edited'])
    AND COALESCE(NULLIF(BTRIM(normalized_payload->'message'->>'chatId'), ''),
      NULLIF(BTRIM(normalized_payload->>'chatId'), '')) = oldest.message_chat_id
    AND summary.status = 'RECEIVED'::"WebhookStatus"
    AND (created_at, id) < (oldest.created_at, oldest.id)
  ORDER BY created_at ASC, id ASC
  LIMIT 1
        ) saved_predecessor
      ) direct_source
    ) guarded_source
  ) numeric_source
) predecessor ON TRUE;
\else
\echo MAXIM_POSTGRES_QUEUE_AUDIT_INDEX_MISSING
SELECT 1 / 0;
\endif
SQL
}

emit_legacy_order_index_guard() {
  cat <<'SQL'
SELECT CASE
  WHEN (
    SELECT count(*) = 2
    FROM pg_index index_state
    JOIN pg_class index_relation ON index_relation.oid = index_state.indexrelid
    JOIN pg_am method ON method.oid = index_relation.relam
    WHERE index_state.indexrelid = ANY(ARRAY[
      to_regclass('public.webhook_events_status_created_at_id_idx'),
      to_regclass('public.webhook_events_ordered_chat_head_idx')
    ]::oid[])
      AND index_state.indrelid = to_regclass('public.webhook_events')
      AND index_relation.relkind = 'i' AND index_relation.reltablespace = 0
      AND index_relation.reloptions IS NULL
      AND index_state.indisvalid AND index_state.indisready AND index_state.indislive
      AND NOT index_state.indisunique AND NOT index_state.indisprimary AND NOT index_state.indisexclusion
      AND method.amname = 'btree'
      AND index_state.indnkeyatts = 3 AND index_state.indnatts = 3
      AND NOT EXISTS (SELECT 1 FROM unnest(index_state.indoption::smallint[]) option WHERE option <> 0)
      AND NOT EXISTS (SELECT 1 FROM unnest(index_state.indclass::oid[]) binding
        JOIN pg_opclass definition ON definition.oid = binding
        WHERE NOT definition.opcdefault OR definition.opcnamespace <> 'pg_catalog'::regnamespace)
      AND (index_state.indexrelid <> to_regclass('public.webhook_events_status_created_at_id_idx')
        OR (index_state.indexprs IS NULL AND index_state.indpred IS NULL
          AND ARRAY(SELECT pg_get_indexdef(index_relation.oid, ordinal, false)
            FROM generate_series(1, 3) ordinal) = ARRAY['status', 'created_at', 'id']))
      -- FLAG: A familiar index name is insufficient. Compare the immutable key expression,
      -- order and complete partial predicate before either bounded source probe can run.
      AND (index_state.indexrelid <> to_regclass('public.webhook_events_ordered_chat_head_idx')
        OR (ARRAY(SELECT pg_get_indexdef(index_relation.oid, ordinal, false)
            FROM generate_series(1, 3) ordinal) = ARRAY[
              $expression$COALESCE(NULLIF(btrim(((normalized_payload -> 'message'::text) ->> 'chatId'::text)), ''::text), NULLIF(btrim((normalized_payload ->> 'chatId'::text)), ''::text))$expression$,
              'created_at', 'id']
          AND pg_get_expr(index_state.indexprs, index_state.indrelid) =
            $expression$COALESCE(NULLIF(btrim(((normalized_payload -> 'message'::text) ->> 'chatId'::text)), ''::text), NULLIF(btrim((normalized_payload ->> 'chatId'::text)), ''::text))$expression$
          AND pg_get_expr(index_state.indpred, index_state.indrelid) =
            $predicate$(((status = ANY (ARRAY['RECEIVED'::"WebhookStatus", 'QUEUED'::"WebhookStatus"])) OR ((status = 'FAILED'::"WebhookStatus") AND ((next_enqueue_at IS NOT NULL) OR ("left"(COALESCE(error_message, ''::text), 37) = 'WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINED:'::text)))) AND (lower(COALESCE(NULLIF(btrim((normalized_payload ->> 'type'::text)), ''::text), NULLIF(btrim((normalized_payload ->> 'update_type'::text)), ''::text))) = ANY (ARRAY['message_created'::text, 'message_edited'::text])))$predicate$))
  ) THEN 'true'
  ELSE 'false'
END AS legacy_order_candidates_index_ready \gset
\if :legacy_order_candidates_index_ready
SQL
}

emit_legacy_order_candidates_audit() {
  emit_legacy_order_index_guard
  cat <<'SQL'
-- FLAG: Both source probes stop at the exact first row before eligibility filtering.
-- An earlier unknown fence must never be hidden by searching for a later eligible one.
WITH oldest_received AS MATERIALIZED (
  SELECT id, created_at, normalized_payload
  FROM webhook_events
  WHERE status = 'RECEIVED'::"WebhookStatus"
  ORDER BY created_at ASC, id ASC
  LIMIT 1
), received_source AS MATERIALIZED (
  SELECT id, created_at,
    CASE WHEN LOWER(COALESCE(NULLIF(BTRIM(normalized_payload->>'type'), ''),
      NULLIF(BTRIM(normalized_payload->>'update_type'), '')))
      = ANY(ARRAY['message_created', 'message_edited'])
      THEN COALESCE(NULLIF(BTRIM(normalized_payload->'message'->>'chatId'), ''),
        NULLIF(BTRIM(normalized_payload->>'chatId'), ''))
      ELSE NULL END AS message_chat_id
  FROM oldest_received
), bounded_predecessor AS MATERIALIZED (
  SELECT predecessor.*
  FROM received_source
  CROSS JOIN LATERAL (
    SELECT id, status, error_message, next_enqueue_at,
      timeout_quarantine_expires_at, processed_at, normalized_payload
    FROM webhook_events
    -- FLAG: Keep the exact ordered-chat-head partial-index predicate. Source identity
    -- stays join-only; neither this candidate nor a missing journal proves old effects.
    WHERE (
      status = ANY(ARRAY['RECEIVED', 'QUEUED']::"WebhookStatus"[])
      OR (status = 'FAILED'::"WebhookStatus" AND (
        next_enqueue_at IS NOT NULL
        OR LEFT(COALESCE(error_message, ''), 37) = 'WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINED:'
      ))
    )
      AND LOWER(COALESCE(NULLIF(BTRIM(normalized_payload->>'type'), ''),
        NULLIF(BTRIM(normalized_payload->>'update_type'), '')))
        = ANY(ARRAY['message_created', 'message_edited'])
      AND COALESCE(NULLIF(BTRIM(normalized_payload->'message'->>'chatId'), ''),
        NULLIF(BTRIM(normalized_payload->>'chatId'), '')) = received_source.message_chat_id
      AND (created_at, id) < (received_source.created_at, received_source.id)
    ORDER BY created_at ASC, id ASC
    LIMIT 1
  ) predecessor
), classified_candidate AS MATERIALIZED (
  SELECT id, normalized_payload,
    status = 'FAILED'::"WebhookStatus"
      AND error_message = 'WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINED:LEGACY_EXECUTION_UNVERIFIED; exact effects proof required'
      AND next_enqueue_at IS NULL AND timeout_quarantine_expires_at IS NULL
      AND processed_at IS NULL
      AND id ~ '^[a-zA-Z0-9_-]{1,128}$' AS eligible
  FROM bounded_predecessor
), candidate_source AS MATERIALIZED (
  -- FLAG: Inspect only the selected receipt. Bounded shape booleans are diagnostics,
  -- never source admission; no original field values or unknown key names leave SQL.
  SELECT id, eligible,
    octet_length(normalized_payload::text) > 262144 AS source_budget_exceeded,
    CASE WHEN eligible AND octet_length(normalized_payload::text) <= 262144
      THEN normalized_payload ELSE NULL END AS normalized
  FROM classified_candidate
), candidate_parts AS MATERIALIZED (
  SELECT *, normalized->'raw' AS raw,
    normalized->'message' AS normalized_message,
    normalized->'raw'->'message' AS original_message,
    normalized->'raw'->'message'->'sender' AS sender,
    normalized->'raw'->'message'->'recipient' AS recipient,
    normalized->'raw'->'message'->'body' AS original_body
  FROM candidate_source
)
SELECT json_build_object(
  'schema_version', 2,
  'audit', 'legacy_order_candidates',
  'scope', 'oldest_received_only',
  'receipt_sample_cap', 1,
  'predecessor_sample_cap', 1,
  'candidate_count', CASE WHEN COALESCE(candidate.eligible, false) THEN 1 ELSE 0 END,
  -- FLAG: This is the sole opt-in opaque identifier. Cold preview must prove ownership
  -- and every source/action fence; this report grants no replay or no-effects authority.
  'candidate_receipt_id', CASE WHEN candidate.eligible THEN candidate.id ELSE NULL END,
  'classification', CASE
    WHEN NOT EXISTS (SELECT 1 FROM oldest_received) THEN 'no_received'
    WHEN NOT EXISTS (SELECT 1 FROM received_source WHERE message_chat_id IS NOT NULL)
      THEN 'source_unknown'
    WHEN candidate.id IS NULL THEN 'no_predecessor'
    WHEN candidate.eligible THEN 'legacy_unverified_candidate'
    ELSE 'ineligible_predecessor' END,
  'source_shape', CASE WHEN candidate.eligible THEN jsonb_build_object(
    'diagnostics_only', true,
    'budget_exceeded', candidate.source_budget_exceeded,
    'normalized_kind', jsonb_typeof(candidate.normalized),
    'raw_kind', jsonb_typeof(candidate.raw),
    'original_kind', jsonb_typeof(candidate.original_message),
    'normalized_message_kind', jsonb_typeof(candidate.normalized_message),
    'receiver_present', jsonb_typeof(candidate.normalized->'botId') = 'string'
      AND COALESCE(candidate.normalized->>'botId', '') <> '',
    'event_kinds_match', candidate.normalized->>'type' = 'message_created'
      AND candidate.raw->>'update_type' = 'message_created',
    'membership_present', COALESCE(candidate.normalized->'membership' <> 'null'::jsonb, false),
    'ingress_clock', candidate.normalized->>'eventTimestampSource' = 'ingress',
    'group_kinds_match', candidate.normalized_message->>'entityType' = 'chat'
      AND candidate.recipient->>'chat_type' = 'chat',
    'actor_is_human', candidate.sender->'is_bot' = 'false'::jsonb,
    'actor_bot_flag_kind', jsonb_typeof(candidate.sender->'is_bot'),
    'raw_keys_supported', CASE WHEN jsonb_typeof(candidate.raw) = 'object' THEN
      candidate.raw - ARRAY['update_type', 'timestamp', 'message', 'update_id'] = '{}'::jsonb END,
    'original_keys_supported', CASE WHEN jsonb_typeof(candidate.original_message) = 'object' THEN
      candidate.original_message - ARRAY['sender', 'recipient', 'timestamp', 'body'] = '{}'::jsonb END,
    'original_metadata_keys_only', CASE WHEN jsonb_typeof(candidate.original_message) = 'object' THEN
      candidate.original_message - ARRAY['sender', 'recipient', 'timestamp', 'body', 'url', 'stat'] = '{}'::jsonb END,
    'original_flat_content_keys_only', CASE WHEN jsonb_typeof(candidate.original_message) = 'object' THEN
      candidate.original_message - ARRAY['sender', 'recipient', 'timestamp', 'body', 'text'] = '{}'::jsonb END,
    'original_url_kind', jsonb_typeof(candidate.original_message->'url'),
    'original_stat_kind', jsonb_typeof(candidate.original_message->'stat'),
    'original_link_kind', jsonb_typeof(candidate.original_message->'link'),
    'original_forward', candidate.original_message->'link'->>'type' = 'forward',
    'original_reply', candidate.original_message->'link'->>'type' = 'reply',
    'original_forward_keys_only', CASE WHEN jsonb_typeof(candidate.original_message) = 'object' THEN
      candidate.original_message - ARRAY['sender', 'recipient', 'timestamp', 'body', 'link'] = '{}'::jsonb END,
    'link_keys_supported', CASE WHEN jsonb_typeof(candidate.original_message->'link') = 'object' THEN
      (candidate.original_message->'link') - ARRAY['type', 'sender', 'chat_id', 'message'] = '{}'::jsonb END,
    'linked_actor_kind', jsonb_typeof(candidate.original_message->'link'->'sender'),
    'linked_content_kind', jsonb_typeof(candidate.original_message->'link'->'message'),
    'linked_keys_supported', CASE WHEN jsonb_typeof(candidate.original_message->'link'->'message') = 'object' THEN
      (candidate.original_message->'link'->'message') - ARRAY['mid', 'seq', 'text', 'attachments', 'markup'] = '{}'::jsonb END,
    'linked_text_kind', jsonb_typeof(candidate.original_message->'link'->'message'->'text'),
    'linked_nested_content_kind', jsonb_typeof(candidate.original_message->'link'->'message'->'body'),
    'linked_attachments_kind', jsonb_typeof(candidate.original_message->'link'->'message'->'attachments'),
    'linked_attachments_empty', candidate.original_message->'link'->'message'->'attachments' = '[]'::jsonb,
    'linked_media_shape_bounded', CASE WHEN jsonb_typeof(candidate.original_message->'link'->'message'->'attachments') = 'array' THEN
      jsonb_array_length(candidate.original_message->'link'->'message'->'attachments') <= 32 END,
    'linked_images_only', CASE WHEN jsonb_typeof(candidate.original_message->'link'->'message'->'attachments') = 'array' THEN
      CASE WHEN jsonb_array_length(candidate.original_message->'link'->'message'->'attachments') BETWEEN 1 AND 32 THEN
        NOT EXISTS (SELECT 1 FROM jsonb_array_elements(candidate.original_message->'link'->'message'->'attachments') attachment
          WHERE COALESCE(attachment->>'type', '') <> ALL(ARRAY['image', 'photo'])) END END,
    'linked_passive_media_only', CASE WHEN jsonb_typeof(candidate.original_message->'link'->'message'->'attachments') = 'array' THEN
      CASE WHEN jsonb_array_length(candidate.original_message->'link'->'message'->'attachments') BETWEEN 1 AND 32 THEN
        NOT EXISTS (SELECT 1 FROM jsonb_array_elements(candidate.original_message->'link'->'message'->'attachments') attachment
          WHERE COALESCE(attachment->>'type', '') <> ALL(ARRAY['image', 'photo', 'video', 'audio', 'file'])) END END,
    'linked_markup_kind', jsonb_typeof(candidate.original_message->'link'->'message'->'markup'),
    'linked_markup_empty', candidate.original_message->'link'->'message'->'markup' = '[]'::jsonb
  ) || jsonb_build_object(
    'actor_keys_supported', CASE WHEN jsonb_typeof(candidate.sender) = 'object' THEN
      candidate.sender - ARRAY['user_id', 'name', 'first_name', 'last_name', 'username',
        'is_bot', 'avatar_url', 'last_activity_time'] = '{}'::jsonb END,
    'recipient_keys_supported', CASE WHEN jsonb_typeof(candidate.recipient) = 'object' THEN
      candidate.recipient - ARRAY['chat_id', 'chat_type'] = '{}'::jsonb END,
    'recipient_nullable_actor', candidate.recipient->'user_id' = 'null'::jsonb,
    'content_keys_supported', CASE WHEN jsonb_typeof(candidate.original_body) = 'object' THEN
      candidate.original_body - ARRAY['mid', 'seq', 'text', 'attachments'] = '{}'::jsonb END,
    'content_markup_keys_only', CASE WHEN jsonb_typeof(candidate.original_body) = 'object' THEN
      candidate.original_body - ARRAY['mid', 'seq', 'text', 'attachments', 'markup'] = '{}'::jsonb END,
    'content_markup_kind', jsonb_typeof(candidate.original_body->'markup'),
    'content_markup_empty', candidate.original_body->'markup' = '[]'::jsonb,
    'content_markup_types', CASE WHEN jsonb_typeof(candidate.original_body->'markup') = 'array' THEN
      CASE WHEN jsonb_array_length(candidate.original_body->'markup') <= 64 THEN
        (SELECT jsonb_agg(CASE WHEN item->>'type' = ANY(ARRAY['strong', 'emphasized', 'monospaced', 'strikethrough', 'underline', 'link', 'user_mention'])
          THEN item->>'type' ELSE 'other' END) FROM jsonb_array_elements(candidate.original_body->'markup') item) END END,
    'content_attachment_types', CASE WHEN jsonb_typeof(candidate.original_body->'attachments') = 'array' THEN
      CASE WHEN jsonb_array_length(candidate.original_body->'attachments') <= 10 THEN
        (SELECT jsonb_agg(CASE WHEN item->>'type' = ANY(ARRAY['image', 'photo', 'video', 'audio', 'file', 'share', 'contact', 'location', 'sticker', 'inline_keyboard'])
          THEN item->>'type' ELSE 'other' END) FROM jsonb_array_elements(candidate.original_body->'attachments') item) END END,
    -- FLAG: One bounded source only. Known metadata types/shape flags expose no URL,
    -- token, text, target identity, arbitrary keys or attachment body values.
    'content_attachment_shapes', CASE WHEN jsonb_typeof(candidate.original_body->'attachments') = 'array' THEN
      CASE WHEN jsonb_array_length(candidate.original_body->'attachments') <= 10 THEN
        (SELECT jsonb_agg(jsonb_build_object(
          'item_kind', jsonb_typeof(item),
          'known_keys_only', CASE WHEN jsonb_typeof(item) = 'object' THEN
            item - ARRAY['type', 'payload', 'thumbnail', 'width', 'height', 'duration'] = '{}'::jsonb END,
          'payload_kind', jsonb_typeof(item->'payload'),
          'payload_known_keys_only', CASE WHEN jsonb_typeof(item->'payload') = 'object' THEN
            (item->'payload') - ARRAY['url', 'token'] = '{}'::jsonb END,
          'payload_video_id_kind', jsonb_typeof(item->'payload'->'video_id'),
          'payload_id_kind', jsonb_typeof(item->'payload'->'id'),
          'payload_video_id_only_extra', CASE WHEN jsonb_typeof(item->'payload') = 'object' THEN
            (item->'payload') - ARRAY['url', 'token', 'video_id'] = '{}'::jsonb END,
          'payload_id_only_extra', CASE WHEN jsonb_typeof(item->'payload') = 'object' THEN
            (item->'payload') - ARRAY['url', 'token', 'id'] = '{}'::jsonb END,
          'payload_metadata_only_extra', CASE WHEN jsonb_typeof(item->'payload') = 'object' THEN
            (item->'payload') - ARRAY['url', 'token', 'video_id', 'id', 'width', 'height', 'duration', 'thumbnail'] = '{}'::jsonb END,
          'payload_width_kind', jsonb_typeof(item->'payload'->'width'),
          'payload_height_kind', jsonb_typeof(item->'payload'->'height'),
          'payload_duration_kind', jsonb_typeof(item->'payload'->'duration'),
          'payload_thumbnail_kind', jsonb_typeof(item->'payload'->'thumbnail'),
          'payload_url_kind', jsonb_typeof(item->'payload'->'url'),
          'payload_token_kind', jsonb_typeof(item->'payload'->'token'),
          'payload_url_https', (item->'payload'->>'url') LIKE 'https://%',
          'payload_token_nonempty', length(item->'payload'->>'token') BETWEEN 1 AND 32768,
          'thumbnail_kind', jsonb_typeof(item->'thumbnail'),
          'thumbnail_url_kind', jsonb_typeof(item->'thumbnail'->'url'),
          'thumbnail_known_keys_only', CASE WHEN jsonb_typeof(item->'thumbnail') = 'object' THEN
            (item->'thumbnail') - ARRAY['url'] = '{}'::jsonb END,
          'width_kind', jsonb_typeof(item->'width'),
          'height_kind', jsonb_typeof(item->'height'),
          'duration_kind', jsonb_typeof(item->'duration')
        )) FROM jsonb_array_elements(candidate.original_body->'attachments') item) END END,
    'content_markup_shapes', CASE WHEN jsonb_typeof(candidate.original_body->'markup') = 'array' THEN
      CASE WHEN jsonb_array_length(candidate.original_body->'markup') <= 64 THEN
        (SELECT jsonb_agg(jsonb_build_object(
          'item_kind', jsonb_typeof(item),
          'known_keys_only', CASE WHEN jsonb_typeof(item) = 'object' THEN
            item - ARRAY['type', 'from', 'length'] = '{}'::jsonb END,
          'from_kind', jsonb_typeof(item->'from'),
          'length_kind', jsonb_typeof(item->'length'),
          'integer_nonnegative_from', CASE WHEN jsonb_typeof(item->'from') = 'number' THEN
            (item->>'from')::numeric >= 0 AND (item->>'from')::numeric = trunc((item->>'from')::numeric) END,
          'integer_positive_length', CASE WHEN jsonb_typeof(item->'length') = 'number' THEN
            (item->>'length')::numeric > 0 AND (item->>'length')::numeric = trunc((item->>'length')::numeric) END,
          'within_codepoint_text', CASE WHEN jsonb_typeof(item->'from') = 'number'
            AND jsonb_typeof(item->'length') = 'number' AND jsonb_typeof(candidate.original_body->'text') = 'string' THEN
            (item->>'from')::numeric + (item->>'length')::numeric <= length(candidate.original_body->>'text') END
        )) FROM jsonb_array_elements(candidate.original_body->'markup') item) END END,
    'content_images_at_most_ten', CASE WHEN jsonb_typeof(candidate.original_body->'attachments') = 'array' THEN
      CASE WHEN jsonb_array_length(candidate.original_body->'attachments') BETWEEN 1 AND 10 THEN
        NOT EXISTS (SELECT 1 FROM jsonb_array_elements(candidate.original_body->'attachments') attachment
          WHERE COALESCE(attachment->>'type', '') <> ALL(ARRAY['image', 'photo'])) END END,
    -- FLAG: Sequence is opaque MAX int64 metadata, never message identity. Emit only
    -- type/range facts for the one indexed candidate, without exposing its value.
    'sequence_kind', jsonb_typeof(candidate.original_body->'seq'),
    'sequence_integer', CASE WHEN jsonb_typeof(candidate.original_body->'seq') = 'number' THEN
      (candidate.original_body->>'seq')::numeric = trunc((candidate.original_body->>'seq')::numeric) END,
    'sequence_safe_integer', CASE WHEN jsonb_typeof(candidate.original_body->'seq') = 'number' THEN
      abs((candidate.original_body->>'seq')::numeric) <= 9007199254740991 END,
    'sequence_int64', CASE WHEN jsonb_typeof(candidate.original_body->'seq') = 'number' THEN
      (candidate.original_body->>'seq')::numeric BETWEEN -9223372036854775808 AND 9223372036854775808 END,
    'linked_sequence_kind', jsonb_typeof(candidate.original_message->'link'->'message'->'seq'),
    'linked_actor_bot_flag_kind', jsonb_typeof(candidate.original_message->'link'->'sender'->'is_bot'),
    'linked_media_at_most_ten', CASE WHEN jsonb_typeof(candidate.original_message->'link'->'message'->'attachments') = 'array' THEN
      jsonb_array_length(candidate.original_message->'link'->'message'->'attachments') BETWEEN 1 AND 10 END,
    'attachments_kind', jsonb_typeof(candidate.original_body->'attachments'),
    'attachments_empty', candidate.original_body->'attachments' = '[]'::jsonb,
    'content_matches', jsonb_typeof(candidate.original_body->'text') = 'string'
      AND candidate.original_body->'text' = candidate.normalized_message->'text',
    'original_content_kind', jsonb_typeof(candidate.original_body->'text'),
    'original_content_nonempty', jsonb_typeof(candidate.original_body->'text') = 'string'
      AND btrim(candidate.original_body->>'text', E' \t\n\r') <> '',
    'content_matches_ascii_trim', jsonb_typeof(candidate.original_body->'text') = 'string'
      AND btrim(candidate.original_body->>'text', E' \t\n\r') = candidate.normalized_message->>'text',
    'flat_content_matches', jsonb_typeof(candidate.original_message->'text') = 'string'
      AND candidate.original_message->'text' = candidate.normalized_message->'text',
    'event_clock_kind', jsonb_typeof(candidate.raw->'timestamp'),
    'original_clock_kind', jsonb_typeof(candidate.original_message->'timestamp'),
    'normalized_clock_kind', jsonb_typeof(candidate.normalized_message->'createdAt'),
    'chat_identity_matches', candidate.recipient->>'chat_id' = candidate.normalized_message->>'chatId',
    'message_identity_matches', candidate.original_body->>'mid' = candidate.normalized_message->>'messageId',
    'actor_identity_matches', candidate.sender->>'user_id' = candidate.normalized_message->>'senderId'
  ) ELSE NULL END
)::text
FROM (SELECT 1) singleton
LEFT JOIN candidate_parts candidate ON TRUE;
\else
\echo MAXIM_POSTGRES_LEGACY_ORDER_CANDIDATES_INDEX_UNAVAILABLE
SELECT 1 / 0;
\endif
SQL
}

emit_legacy_semantic_mirrors_audit() {
  emit_legacy_order_index_guard
  cat <<'SQL'
-- FLAG: A third exact index is mandatory before the bounded semantic mirror probe.
SELECT CASE WHEN EXISTS (
  SELECT 1 FROM pg_index index_state
  JOIN pg_class index_relation ON index_relation.oid = index_state.indexrelid
  JOIN pg_am method ON method.oid = index_relation.relam
  WHERE index_state.indexrelid = to_regclass('public.webhook_events_semantic_order_idx')
    AND index_state.indrelid = to_regclass('public.webhook_events')
    AND index_state.indisvalid AND index_state.indisready AND index_state.indislive
    AND index_relation.relkind = 'i' AND index_relation.reltablespace = 0
    AND index_relation.reloptions IS NULL AND method.amname = 'btree'
    AND NOT index_state.indisunique AND NOT index_state.indisprimary AND NOT index_state.indisexclusion
    AND index_state.indnkeyatts = 3 AND index_state.indnatts = 3
    AND index_state.indexprs IS NULL
    AND NOT EXISTS (SELECT 1 FROM unnest(index_state.indoption::smallint[]) option WHERE option <> 0)
    AND NOT EXISTS (SELECT 1 FROM unnest(index_state.indclass::oid[]) binding
      JOIN pg_opclass definition ON definition.oid = binding
      WHERE NOT definition.opcdefault OR definition.opcnamespace <> 'pg_catalog'::regnamespace)
    AND ARRAY(SELECT pg_get_indexdef(index_relation.oid, ordinal, false)
      FROM generate_series(1, 3) ordinal) = ARRAY['semantic_key', 'created_at', 'id']
    AND pg_get_expr(index_state.indpred, index_state.indrelid) = '(semantic_key IS NOT NULL)'
) THEN 'true' ELSE 'false' END AS legacy_semantic_mirrors_index_ready \gset
\if :legacy_semantic_mirrors_index_ready
SQL
  if [[ -n "$RULES_CLEANUP_EXPLAIN" ]]; then
    echo 'EXPLAIN (FORMAT JSON)'
  fi
  cat <<'SQL'
WITH oldest_received AS MATERIALIZED (
  SELECT id, created_at, normalized_payload
  FROM webhook_events
  WHERE status = 'RECEIVED'::"WebhookStatus"
  ORDER BY created_at ASC, id ASC
  LIMIT 1
), received_source AS MATERIALIZED (
  SELECT id, created_at,
    CASE WHEN LOWER(COALESCE(NULLIF(BTRIM(normalized_payload->>'type'), ''),
      NULLIF(BTRIM(normalized_payload->>'update_type'), '')))
      = ANY(ARRAY['message_created', 'message_edited'])
      THEN COALESCE(NULLIF(BTRIM(normalized_payload->'message'->>'chatId'), ''),
        NULLIF(BTRIM(normalized_payload->>'chatId'), ''))
      ELSE NULL END AS message_chat_id
  FROM oldest_received
), bounded_predecessor AS MATERIALIZED (
  SELECT predecessor.*
  FROM received_source
  CROSS JOIN LATERAL (
    SELECT id, status, error_message, next_enqueue_at,
      timeout_quarantine_expires_at, processed_at, normalized_payload, semantic_key
    FROM webhook_events
    -- FLAG: Keep the exact ordered-chat-head partial-index predicate. Source identity
    -- stays join-only; neither this candidate nor a missing journal proves old effects.
    WHERE (
      status = ANY(ARRAY['RECEIVED', 'QUEUED']::"WebhookStatus"[])
      OR (status = 'FAILED'::"WebhookStatus" AND (
        next_enqueue_at IS NOT NULL
        OR LEFT(COALESCE(error_message, ''), 37) = 'WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINED:'
      ))
    )
      AND LOWER(COALESCE(NULLIF(BTRIM(normalized_payload->>'type'), ''),
        NULLIF(BTRIM(normalized_payload->>'update_type'), '')))
        = ANY(ARRAY['message_created', 'message_edited'])
      AND COALESCE(NULLIF(BTRIM(normalized_payload->'message'->>'chatId'), ''),
        NULLIF(BTRIM(normalized_payload->>'chatId'), '')) = received_source.message_chat_id
      AND (created_at, id) < (received_source.created_at, received_source.id)
    ORDER BY created_at ASC, id ASC
    LIMIT 1
  ) predecessor
), classified_candidate AS MATERIALIZED (
  SELECT id, normalized_payload, semantic_key,
    status = 'FAILED'::"WebhookStatus"
      AND error_message = 'WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINED:LEGACY_EXECUTION_UNVERIFIED; exact effects proof required'
      AND next_enqueue_at IS NULL AND timeout_quarantine_expires_at IS NULL
      AND processed_at IS NULL
      AND id ~ '^[a-zA-Z0-9_-]{1,128}$' AS eligible
  FROM bounded_predecessor
), candidate_source AS MATERIALIZED (
  -- FLAG: Inspect only the selected receipt. Bounded shape booleans are diagnostics,
  -- never source admission; no original field values or unknown key names leave SQL.
  SELECT id, eligible, semantic_key,
    octet_length(normalized_payload::text) > 262144 AS source_budget_exceeded,
    CASE WHEN eligible AND octet_length(normalized_payload::text) <= 262144
      THEN normalized_payload ELSE NULL END AS normalized
  FROM classified_candidate
), candidate_parts AS MATERIALIZED (
  SELECT *, normalized->'raw' AS raw,
    normalized->'message' AS normalized_message,
    normalized->'raw'->'message' AS original_message,
    normalized->'raw'->'message'->'sender' AS sender,
    normalized->'raw'->'message'->'recipient' AS recipient,
    normalized->'raw'->'message'->'body' AS original_body
  FROM candidate_source
), bounded_mirrors AS MATERIALIZED (
  -- FLAG: Exact semantic prefix, at most eight observations and one sentinel.
  -- Eligibility cannot skip an earlier owner fence and payload values never leave SQL.
  SELECT mirror.*, candidate.id AS candidate_id
  FROM candidate_parts candidate
  CROSS JOIN LATERAL (
    SELECT id, bot_id, created_at, normalized_payload, raw_payload, semantic_key
    FROM webhook_events
    WHERE semantic_key IS NOT NULL AND semantic_key = candidate.semantic_key
    ORDER BY created_at, id LIMIT 9
  ) mirror
  WHERE candidate.eligible
), mirror_parts AS MATERIALIZED (
  SELECT id = candidate_id AS is_owner, bot_id, created_at, semantic_key,
    octet_length(normalized_payload::text) > 262144 AS budget_exceeded,
    CASE WHEN octet_length(normalized_payload::text) <= 262144 THEN normalized_payload END AS normalized,
    octet_length(raw_payload::text) > 262144 AS stored_raw_budget_exceeded,
    CASE WHEN octet_length(raw_payload::text) <= 262144 THEN raw_payload END AS stored_raw
  FROM bounded_mirrors ORDER BY created_at, id LIMIT 8
)
SELECT json_build_object(
  'schema_version', 1, 'audit', 'legacy_semantic_mirrors', 'diagnostics_only', true,
  'scope', 'oldest_received_only', 'mirror_sample_cap', 8,
  'candidate_receipt_id', CASE WHEN candidate.eligible THEN candidate.id END,
  'sampled', (SELECT count(*) FROM mirror_parts),
  'truncated', (SELECT count(*) > 8 FROM bounded_mirrors),
  'mirrors', (SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'is_owner', mirror.is_owner,
    'budget_exceeded', mirror.budget_exceeded,
    'raw_kind', jsonb_typeof(mirror.normalized->'raw'),
    'receipt_receiver_matches', mirror.normalized->>'botId' = mirror.bot_id,
    -- FLAG: Equality/type facts diagnose the independent source guard; neither raw
    -- payloads, source IDs, timestamps nor receiver identities leave this fixed audit.
    'source_guards', jsonb_build_object(
      'normalized_object', jsonb_typeof(mirror.normalized) = 'object',
      'normalized_message_object', jsonb_typeof(mirror.normalized->'message') = 'object',
      'raw_object', jsonb_typeof(mirror.normalized->'raw') = 'object',
      'stored_raw_kind', jsonb_typeof(mirror.stored_raw),
      'stored_raw_budget_exceeded', mirror.stored_raw_budget_exceeded,
      'stored_raw_empty', mirror.stored_raw = '{}'::jsonb,
      'stored_raw_matches', mirror.stored_raw IS NOT DISTINCT FROM mirror.normalized->'raw',
      'receiver_nonempty', jsonb_typeof(mirror.normalized->'botId') = 'string' AND btrim(mirror.bot_id) <> '',
      'event_kind_valid', mirror.normalized->>'type' = 'message_created' AND mirror.normalized->'raw'->>'update_type' = 'message_created',
      'membership_present', COALESCE(mirror.normalized->'membership' NOT IN ('null'::jsonb, 'false'::jsonb, '0'::jsonb, '""'::jsonb), false),
      'ingress_clock', mirror.normalized->>'eventTimestampSource' = 'ingress',
      'normalized_entity_chat', mirror.normalized->'message'->>'entityType' = 'chat',
      'normalized_chat_matches_raw', mirror.normalized->'message'->>'chatId' = mirror.normalized->'raw'->'message'->'recipient'->>'chat_id',
      'normalized_message_matches_raw', mirror.normalized->'message'->>'messageId' = mirror.normalized->'raw'->'message'->'body'->>'mid',
      'normalized_author_matches_raw', mirror.normalized->'message'->>'senderId' = mirror.normalized->'raw'->'message'->'sender'->>'user_id',
      'normalized_clock_kind', jsonb_typeof(mirror.normalized->'message'->'createdAt'),
      'normalized_clock_equals_owner', mirror.normalized->'message'->'createdAt' IS NOT DISTINCT FROM candidate.normalized_message->'createdAt',
      'event_clock_not_after_receipt', CASE WHEN jsonb_typeof(mirror.normalized->'raw'->'timestamp') = 'number' THEN
        CASE WHEN (mirror.normalized->'raw'->>'timestamp')::numeric > 0 THEN
          trunc((mirror.normalized->'raw'->>'timestamp')::numeric * CASE WHEN (mirror.normalized->'raw'->>'timestamp')::numeric < 10000000000 THEN 1000 ELSE 1 END)
            <= extract(epoch FROM mirror.created_at) * 1000 END END,
      'created_semantic_matches_receipt', CASE WHEN mirror.normalized->>'type' = 'message_created'
        AND jsonb_typeof(mirror.normalized->'message'->'chatId') = 'string'
        AND jsonb_typeof(mirror.normalized->'message'->'messageId') = 'string' THEN
          mirror.semantic_key = 'message:message_created:' || btrim(mirror.normalized->'message'->>'chatId') || ':' || btrim(mirror.normalized->'message'->>'messageId') END
    ),
    'same_receiver', mirror.normalized->'botId' IS NOT DISTINCT FROM candidate.normalized->'botId',
    'normalized_kind_equal', mirror.normalized->'type' IS NOT DISTINCT FROM candidate.normalized->'type',
    'normalized_text_equal', mirror.normalized->'message'->'text' IS NOT DISTINCT FROM candidate.normalized_message->'text',
    'raw_equal', mirror.normalized->'raw' IS NOT DISTINCT FROM candidate.raw,
    'raw_without_delivery_metadata_equal', (mirror.normalized->'raw') - ARRAY['timestamp', 'update_id'] IS NOT DISTINCT FROM candidate.raw - ARRAY['timestamp', 'update_id'],
    'event_clock_equal', mirror.normalized->'raw'->'timestamp' IS NOT DISTINCT FROM candidate.raw->'timestamp',
    'update_id_equal', mirror.normalized->'raw'->'update_id' IS NOT DISTINCT FROM candidate.raw->'update_id',
    'message_clock_equal', mirror.normalized->'raw'->'message'->'timestamp' IS NOT DISTINCT FROM candidate.original_message->'timestamp',
    'sender_equal', mirror.normalized->'raw'->'message'->'sender' IS NOT DISTINCT FROM candidate.sender,
    'sender_identity_equal', mirror.normalized->'raw'->'message'->'sender'->'user_id' IS NOT DISTINCT FROM candidate.sender->'user_id',
    'recipient_equal', mirror.normalized->'raw'->'message'->'recipient' IS NOT DISTINCT FROM candidate.recipient,
    'body_equal', mirror.normalized->'raw'->'message'->'body' IS NOT DISTINCT FROM candidate.original_body,
    'body_without_attachments_equal', (mirror.normalized->'raw'->'message'->'body') - 'attachments' IS NOT DISTINCT FROM candidate.original_body - 'attachments',
    'body_text_equal', mirror.normalized->'raw'->'message'->'body'->'text' IS NOT DISTINCT FROM candidate.original_body->'text',
    'message_id_equal', mirror.normalized->'raw'->'message'->'body'->'mid' IS NOT DISTINCT FROM candidate.original_body->'mid',
    'sequence_equal', mirror.normalized->'raw'->'message'->'body'->'seq' IS NOT DISTINCT FROM candidate.original_body->'seq',
    'markup_equal', mirror.normalized->'raw'->'message'->'body'->'markup' IS NOT DISTINCT FROM candidate.original_body->'markup',
    'attachments_equal', mirror.normalized->'raw'->'message'->'body'->'attachments' IS NOT DISTINCT FROM candidate.original_body->'attachments',
    'attachment_shapes', (SELECT jsonb_agg(jsonb_build_object(
      'item_equal', item IS NOT DISTINCT FROM candidate.original_body->'attachments'->((ordinal - 1)::int),
      'type_equal', item->'type' IS NOT DISTINCT FROM candidate.original_body->'attachments'->((ordinal - 1)::int)->'type',
      'payload_equal', item->'payload' IS NOT DISTINCT FROM candidate.original_body->'attachments'->((ordinal - 1)::int)->'payload',
      'payload_without_url_token_equal', (item->'payload') - ARRAY['url', 'token'] IS NOT DISTINCT FROM (candidate.original_body->'attachments'->((ordinal - 1)::int)->'payload') - ARRAY['url', 'token'],
      'payload_id_equal', item->'payload'->'id' IS NOT DISTINCT FROM candidate.original_body->'attachments'->((ordinal - 1)::int)->'payload'->'id',
      'payload_url_equal', item->'payload'->'url' IS NOT DISTINCT FROM candidate.original_body->'attachments'->((ordinal - 1)::int)->'payload'->'url',
      'payload_token_equal', item->'payload'->'token' IS NOT DISTINCT FROM candidate.original_body->'attachments'->((ordinal - 1)::int)->'payload'->'token',
      'thumbnail_equal', item->'thumbnail' IS NOT DISTINCT FROM candidate.original_body->'attachments'->((ordinal - 1)::int)->'thumbnail',
      'metadata_without_payload_preview_equal', item - ARRAY['payload', 'thumbnail'] IS NOT DISTINCT FROM (candidate.original_body->'attachments'->((ordinal - 1)::int)) - ARRAY['payload', 'thumbnail']
    )) FROM jsonb_array_elements(CASE WHEN jsonb_typeof(mirror.normalized->'raw'->'message'->'body'->'attachments') = 'array' THEN
      CASE WHEN jsonb_array_length(mirror.normalized->'raw'->'message'->'body'->'attachments') <= 10 THEN
        mirror.normalized->'raw'->'message'->'body'->'attachments' ELSE '[]'::jsonb END ELSE '[]'::jsonb END)
      WITH ORDINALITY attachment(item, ordinal))
  )), '[]'::jsonb) FROM mirror_parts mirror)
)::text FROM (SELECT 1) singleton LEFT JOIN candidate_parts candidate ON TRUE;
\else
\echo MAXIM_POSTGRES_LEGACY_SEMANTIC_MIRRORS_INDEX_UNAVAILABLE
SELECT 1 / 0;
\endif
\else
\echo MAXIM_POSTGRES_LEGACY_ORDER_CANDIDATES_INDEX_UNAVAILABLE
SELECT 1 / 0;
\endif
SQL
}

emit_legacy_order_window_audit() {
  emit_legacy_order_index_guard
  if [[ -n "$RULES_CLEANUP_EXPLAIN" ]]; then
    printf '%s\n' 'EXPLAIN (FORMAT JSON)'
  fi
  cat <<'SQL'
-- FLAG: Bound the status-index input BEFORE chat grouping; probe only the first
-- actual predecessor of each selected chat. Unknown earlier fences stay visible.
WITH receipt_window AS MATERIALIZED (
  SELECT id, created_at, normalized_payload FROM webhook_events
  WHERE status = 'RECEIVED'::"WebhookStatus"
  ORDER BY created_at, id LIMIT 129
), receipt_sources AS MATERIALIZED (
  SELECT id, created_at,
    CASE WHEN octet_length(normalized_payload::text) <= 262144
      AND LOWER(COALESCE(NULLIF(BTRIM(normalized_payload->>'type'), ''),
        NULLIF(BTRIM(normalized_payload->>'update_type'), ''))) = ANY(ARRAY['message_created','message_edited'])
      THEN COALESCE(NULLIF(BTRIM(normalized_payload->'message'->>'chatId'), ''),
        NULLIF(BTRIM(normalized_payload->>'chatId'), '')) END AS chat_id
  FROM receipt_window ORDER BY created_at, id LIMIT 128
), chat_sources AS MATERIALIZED (
  SELECT DISTINCT ON (chat_id) chat_id, id, created_at FROM receipt_sources
  WHERE chat_id IS NOT NULL ORDER BY chat_id, created_at, id
), selected_chats AS MATERIALIZED (
  SELECT * FROM chat_sources ORDER BY created_at, id LIMIT 32
), predecessors AS MATERIALIZED (
  SELECT selected_chats.created_at AS source_at, selected_chats.id AS source_id, predecessor.*
  FROM selected_chats LEFT JOIN LATERAL (
    SELECT id, status, error_message, next_enqueue_at, timeout_quarantine_expires_at, processed_at
    FROM webhook_events
    WHERE (status = ANY(ARRAY['RECEIVED','QUEUED']::"WebhookStatus"[]) OR
      (status = 'FAILED'::"WebhookStatus" AND (next_enqueue_at IS NOT NULL OR
        LEFT(COALESCE(error_message, ''), 37) = 'WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINED:')))
      AND LOWER(COALESCE(NULLIF(BTRIM(normalized_payload->>'type'), ''),
        NULLIF(BTRIM(normalized_payload->>'update_type'), ''))) = ANY(ARRAY['message_created','message_edited'])
      AND COALESCE(NULLIF(BTRIM(normalized_payload->'message'->>'chatId'), ''),
        NULLIF(BTRIM(normalized_payload->>'chatId'), '')) = selected_chats.chat_id
      AND (created_at, id) < (selected_chats.created_at, selected_chats.id)
    ORDER BY created_at, id LIMIT 1
  ) predecessor ON true
), classified AS MATERIALIZED (
  SELECT *, CASE WHEN id IS NULL THEN 'no_predecessor'
    WHEN status = 'FAILED'::"WebhookStatus"
      AND error_message = 'WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINED:LEGACY_EXECUTION_UNVERIFIED; exact effects proof required'
      AND next_enqueue_at IS NULL AND timeout_quarantine_expires_at IS NULL
      AND processed_at IS NULL AND id ~ '^[a-zA-Z0-9_-]{1,128}$'
      THEN 'legacy_unverified_candidate' ELSE 'ineligible_predecessor' END AS classification
  FROM predecessors
)
SELECT json_build_object(
  'schema_version', 1, 'audit', 'legacy_order_window', 'scope', 'bounded_oldest_received_window',
  'receipt_sample_cap', 128, 'chat_sample_cap', 32,
  'sampled_receipts', (SELECT count(*) FROM receipt_sources),
  'receipts_truncated', (SELECT count(*) > 128 FROM receipt_window),
  'unknown_sources', (SELECT count(*) FROM receipt_sources WHERE chat_id IS NULL),
  'chats_truncated', (SELECT count(*) > 32 FROM chat_sources),
  'candidates', COALESCE((SELECT json_agg(json_build_object(
    'classification', classification,
    'candidate_receipt_id', CASE WHEN classification = 'legacy_unverified_candidate' THEN id END
  ) ORDER BY source_at, source_id) FROM classified), '[]'::json)
)::text;
\else
\echo MAXIM_POSTGRES_LEGACY_ORDER_CANDIDATES_INDEX_UNAVAILABLE
SELECT 1 / 0;
\endif
SQL
}

emit_activity_audit() {
  cat <<'SQL'
WITH classified_activity AS MATERIALIZED (
  SELECT
    CASE
      WHEN application_name LIKE 'maxim-postgres-backup-%' THEN 'scheduled_backup'
      WHEN application_name LIKE 'maxim-live-backup-%' THEN 'live_backup'
      WHEN application_name LIKE 'maxim-bounded-audit-%' THEN 'bounded_audit'
      WHEN application_name = 'api-ingress' THEN 'ingress'
      WHEN application_name = 'api-enqueue' THEN 'enqueue'
      WHEN application_name = 'api-admin' THEN 'admin'
      WHEN application_name = 'api-action' THEN 'action'
      WHEN application_name = 'api-publisher' THEN 'publisher'
      WHEN application_name = 'api-media-analysis' THEN 'media_analysis'
      WHEN application_name IN (
        'api-moderation', 'api-moderation-critical', 'api-moderation-join',
        'api-moderation-realtime-b', 'api-moderation-realtime-c',
        'api-moderation-realtime-d', 'api-moderation-background'
      ) THEN 'moderation'
      WHEN application_name = '' THEN 'unspecified'
      ELSE 'other'
    END AS workload,
    -- FLAG: Classify only active query text into fixed labels; never project the text itself.
    CASE
      WHEN state IS DISTINCT FROM 'active' THEN 'inactive'
      WHEN query LIKE '%/* fair_enqueue_candidates */%' THEN 'webhook_enqueue_selection'
      WHEN query LIKE '%requested_chats%' AND query LIKE '%webhook_events%'
        THEN 'webhook_ordered_heads'
      WHEN query LIKE '%webhook_execution_claims%' THEN 'webhook_execution_claims'
      WHEN query LIKE '%webhook_events%' THEN 'webhook_events'
      WHEN query LIKE '%moderation_delete_intent%' THEN 'moderation_delete_intents'
      WHEN query LIKE '%max_action_ledger%' THEN 'max_action_ledger'
      WHEN query LIKE '%moderation_events%' THEN 'moderation_events'
      WHEN query LIKE '%chat_message_history%' THEN 'chat_message_history'
      WHEN query LIKE '%chat_settings%' THEN 'chat_settings'
      WHEN query LIKE '%chat_bot_memberships%' THEN 'chat_bot_memberships'
      WHEN query LIKE '%managed_entity_access%' THEN 'managed_entity_access'
      WHEN query LIKE '%managed_bot_chat_catalog%' THEN 'managed_bot_catalog'
      WHEN query LIKE '%night_mode_%' THEN 'night_mode'
      WHEN query LIKE '%spammer_%' OR query LIKE '%global_spammers%' THEN 'spammer_intelligence'
      WHEN query LIKE '%publication%' OR query LIKE '%publisher_%' THEN 'publisher'
      WHEN query LIKE '%managed_broadcast%' OR query LIKE '%managed_autopost%'
        THEN 'managed_publication'
      WHEN query LIKE '%managed_poll%' THEN 'managed_polls'
      WHEN query LIKE '%managed_giveaway%' THEN 'managed_giveaways'
      WHEN query LIKE '%vk_parsing_%' THEN 'vk_parsing'
      WHEN query LIKE '%channel_auto_post_attach_markers%'
        OR query LIKE '%chat_auto_comment_attach_markers%' THEN 'message_replacements'
      WHEN query LIKE '%chat_rules%' THEN 'chat_rules'
      WHEN query LIKE '%chat_user_display_names%' THEN 'user_display_names'
      WHEN query LIKE '%chat_moderation_%' OR query LIKE '%chat_membership_%'
        OR query LIKE '%channel_stat%' OR query LIKE '%channel_post%' THEN 'statistics'
      WHEN query LIKE '%audit_logs%' THEN 'audit_logs'
      WHEN query LIKE '%"commercial_ocr_guard_required"%'
        AND query LIKE '%"routing_policy"%' THEN 'moderation_delete_intent_projection'
      WHEN query LIKE '%"chats"%' THEN 'chats'
      WHEN query ~* '^\s*(vacuum|analyze|create index|reindex)' THEN 'maintenance'
      ELSE 'other'
    END AS query_family,
    CASE
      WHEN state IS DISTINCT FROM 'active' THEN 'not_applicable'
      WHEN query LIKE '%/* storage:delete_lease_renew */%' THEN 'delete_lease_renew'
      WHEN query LIKE '%/* storage:vk_import_upsert */%' THEN 'vk_import_upsert'
      WHEN query LIKE '%webhook_events%' AND query LIKE '%WITH filtered AS%'
        THEN 'webhook_type_metrics'
      WHEN query LIKE '%webhook_events%' AND query ~* '^\s*SELECT\s+COUNT\('
        THEN 'webhook_count'
      WHEN query LIKE '%webhook_events%' AND query LIKE '%readinessWaiting%'
        THEN 'webhook_operational_lag'
      WHEN query LIKE '%/* webhook_oldest_pending */%' THEN 'webhook_oldest_metadata'
      WHEN query LIKE 'SELECT "public"."webhook_events"."id", "public"."webhook_events"."created_at"%'
        AND query LIKE '%ORDER BY%' AND query LIKE '%LIMIT%'
        THEN 'webhook_oldest_metadata'
      WHEN query NOT LIKE '%audit_logs%' THEN 'not_applicable'
      WHEN query LIKE '%/* FLAG: publisher_suggestion_legacy_migration */%' THEN 'publisher_legacy_migration'
      WHEN query LIKE '%/* FLAG: publisher_suggestion_publication_recovery */%' THEN 'publisher_publication_recovery'
      WHEN query LIKE '%/* FLAG: publisher_suggestion_terminal_cleanup */%' THEN 'publisher_terminal_cleanup'
      WHEN query LIKE '%/* FLAG: publisher_suggestion_admission_cleanup */%' THEN 'publisher_admission_cleanup'
      WHEN query LIKE '%/* FLAG: publisher_suggestion_pending_cleanup */%' THEN 'publisher_pending_cleanup'
      WHEN query LIKE '%/* FLAG: publisher_suggestion_terminal_sync */%' THEN 'publisher_terminal_sync'
      WHEN query LIKE '%/* FLAG: publisher_suggestion_admin_recovery */%' THEN 'publisher_admin_recovery'
      WHEN query LIKE '%suggestion_recovery_candidates%' THEN 'suggestion_recovery'
      WHEN query LIKE '%admin_delivery_candidates%' THEN 'suggestion_admin_delivery'
      WHEN query LIKE '%previousPublishedMessageId%' THEN 'replacement_cleanup'
      WHEN query LIKE '%audit."payload"->>%' THEN 'audit_json_raw'
      WHEN query ~* '^\s*SELECT\s+COUNT\(' THEN 'audit_count'
      WHEN query LIKE 'SELECT "public"."audit_logs"."id", "public"."audit_logs"."chat_id", "public"."audit_logs"."payload", "public"."audit_logs"."created_at"%'
        THEN 'audit_recovery_page'
      WHEN query LIKE 'SELECT "public"."audit_logs"."chat_id", "public"."audit_logs"."payload"%'
        THEN 'audit_recovery_confirmation'
      WHEN query LIKE 'SELECT "public"."audit_logs"."payload"%' THEN 'audit_payload_lookup'
      WHEN query LIKE 'SELECT "public"."audit_logs"."id", "public"."audit_logs"."chat_id", "public"."audit_logs"."actor_user_id"%'
        THEN 'audit_full_row'
      ELSE 'audit_other'
    END AS query_shape,
    backend_type,
    coalesce(state, 'unknown') AS state,
    coalesce(wait_event_type, 'none') AS wait_event_type,
    coalesce(wait_event, 'none') AS wait_event,
    CASE
      WHEN state = 'active' AND query_start IS NOT NULL
        THEN greatest(0, floor(extract(epoch FROM clock_timestamp() - query_start))::bigint)
      ELSE 0
    END AS active_query_age_seconds,
    CASE
      WHEN xact_start IS NOT NULL
        THEN greatest(0, floor(extract(epoch FROM clock_timestamp() - xact_start))::bigint)
      ELSE 0
    END AS transaction_age_seconds
  FROM pg_stat_activity
  WHERE datname = current_database()
    AND pid <> pg_backend_pid()
), grouped_activity AS MATERIALIZED (
  SELECT
    workload,
    query_family,
    query_shape,
    backend_type,
    state,
    wait_event_type,
    wait_event,
    count(*)::bigint AS sessions,
    max(active_query_age_seconds) AS oldest_active_query_seconds,
    max(transaction_age_seconds) AS oldest_transaction_seconds
  FROM classified_activity
  GROUP BY workload, query_family, query_shape, backend_type, state, wait_event_type, wait_event
  ORDER BY sessions DESC, workload, query_family, query_shape, backend_type, state, wait_event_type, wait_event
  LIMIT 64
)
SELECT json_build_object(
  'schema_version', 1,
  'audit', 'postgres_activity',
  'rows', coalesce(
    json_agg(
      json_build_object(
        'workload', workload,
        'query_family', query_family,
        'query_shape', query_shape,
        'backend_type', backend_type,
        'state', state,
        'wait_event_type', wait_event_type,
        'wait_event', wait_event,
        'sessions', sessions,
        'oldest_active_query_seconds', oldest_active_query_seconds,
        'oldest_transaction_seconds', oldest_transaction_seconds
      )
      ORDER BY sessions DESC, workload, query_family, query_shape, backend_type, state, wait_event_type, wait_event
    ),
    '[]'::json
  )
)::text
FROM grouped_activity;
SQL
}

emit_monitor_signals_audit() {
  cat <<SQL
SELECT CASE
  WHEN to_regclass('public.webhook_events_status_created_at_idx') IS NOT NULL
    AND to_regclass('public.moderation_events_created_at_idx') IS NOT NULL THEN 'true'
  ELSE 'false'
END AS monitor_audit_indexes_ready \gset
\if :monitor_audit_indexes_ready
WITH webhook_statuses(status) AS (
  VALUES
    ('RECEIVED'::"WebhookStatus"),
    ('QUEUED'::"WebhookStatus"),
    ('PROCESSED'::"WebhookStatus"),
    ('DUPLICATE'::"WebhookStatus"),
    ('FAILED'::"WebhookStatus"),
    ('NO_REPLAY_HELD'::"WebhookStatus"),
    ('CANCELLED'::"WebhookStatus"),
    ('QUARANTINED'::"WebhookStatus")
), recent_webhooks AS MATERIALIZED (
  -- FLAG: Each literal status owns an ordered limited index walk. A parameterized
  -- lateral status can select Bitmap Heap Scan + Sort over an unbounded hot tail.
  (SELECT 'RECEIVED'::"WebhookStatus" AS status, created_at FROM webhook_events
    WHERE status = 'RECEIVED'::"WebhookStatus"
      AND created_at >= statement_timestamp() - make_interval(mins => $SIGNAL_WINDOW_MIN)
      AND created_at <= statement_timestamp()
    ORDER BY created_at DESC LIMIT $((MONITOR_SAMPLE_CAP + 1)))
  UNION ALL
  (SELECT 'QUEUED'::"WebhookStatus" AS status, created_at FROM webhook_events
    WHERE status = 'QUEUED'::"WebhookStatus"
      AND created_at >= statement_timestamp() - make_interval(mins => $SIGNAL_WINDOW_MIN)
      AND created_at <= statement_timestamp()
    ORDER BY created_at DESC LIMIT $((MONITOR_SAMPLE_CAP + 1)))
  UNION ALL
  (SELECT 'PROCESSED'::"WebhookStatus" AS status, created_at FROM webhook_events
    WHERE status = 'PROCESSED'::"WebhookStatus"
      AND created_at >= statement_timestamp() - make_interval(mins => $SIGNAL_WINDOW_MIN)
      AND created_at <= statement_timestamp()
    ORDER BY created_at DESC LIMIT $((MONITOR_SAMPLE_CAP + 1)))
  UNION ALL
  (SELECT 'DUPLICATE'::"WebhookStatus" AS status, created_at FROM webhook_events
    WHERE status = 'DUPLICATE'::"WebhookStatus"
      AND created_at >= statement_timestamp() - make_interval(mins => $SIGNAL_WINDOW_MIN)
      AND created_at <= statement_timestamp()
    ORDER BY created_at DESC LIMIT $((MONITOR_SAMPLE_CAP + 1)))
  UNION ALL
  (SELECT 'FAILED'::"WebhookStatus" AS status, created_at FROM webhook_events
    WHERE status = 'FAILED'::"WebhookStatus"
      AND created_at >= statement_timestamp() - make_interval(mins => $SIGNAL_WINDOW_MIN)
      AND created_at <= statement_timestamp()
    ORDER BY created_at DESC LIMIT $((MONITOR_SAMPLE_CAP + 1)))
  UNION ALL
  (SELECT 'NO_REPLAY_HELD'::"WebhookStatus" AS status, created_at FROM webhook_events
    WHERE status = 'NO_REPLAY_HELD'::"WebhookStatus"
      AND created_at >= statement_timestamp() - make_interval(mins => $SIGNAL_WINDOW_MIN)
      AND created_at <= statement_timestamp()
    ORDER BY created_at DESC LIMIT $((MONITOR_SAMPLE_CAP + 1)))
  UNION ALL
  (SELECT 'CANCELLED'::"WebhookStatus" AS status, created_at FROM webhook_events
    WHERE status = 'CANCELLED'::"WebhookStatus"
      AND created_at >= statement_timestamp() - make_interval(mins => $SIGNAL_WINDOW_MIN)
      AND created_at <= statement_timestamp()
    ORDER BY created_at DESC LIMIT $((MONITOR_SAMPLE_CAP + 1)))
  UNION ALL
  (SELECT 'QUARANTINED'::"WebhookStatus" AS status, created_at FROM webhook_events
    WHERE status = 'QUARANTINED'::"WebhookStatus"
      AND created_at >= statement_timestamp() - make_interval(mins => $SIGNAL_WINDOW_MIN)
      AND created_at <= statement_timestamp()
    ORDER BY created_at DESC LIMIT $((MONITOR_SAMPLE_CAP + 1)))
), webhook_summary AS (
  SELECT
    webhook_statuses.status,
    count(recent_webhooks.created_at)::bigint AS sampled_count,
    max(recent_webhooks.created_at) AS newest_created_at
  FROM webhook_statuses
  LEFT JOIN recent_webhooks ON recent_webhooks.status = webhook_statuses.status
  GROUP BY webhook_statuses.status
)
SELECT json_build_object(
  'schema_version', 2,
  'audit', 'recent_webhook_statuses',
  'window_minutes', $SIGNAL_WINDOW_MIN,
  'window_started_at', statement_timestamp() - make_interval(mins => $SIGNAL_WINDOW_MIN),
  'window_ended_at', statement_timestamp(),
  'sample_cap_per_status', $MONITOR_SAMPLE_CAP,
  'rows', json_agg(
    json_build_object(
      'status', status::text,
      'count_lower_bound', least(sampled_count, $MONITOR_SAMPLE_CAP),
      'saturated', sampled_count > $MONITOR_SAMPLE_CAP,
      'newest_age_seconds', CASE
        WHEN newest_created_at IS NULL THEN 0
        ELSE greatest(
          0,
          floor(extract(epoch FROM clock_timestamp() - newest_created_at))::bigint
        )
      END
    )
    ORDER BY status::text
  )
)::text
FROM webhook_summary;

WITH moderation_sample AS MATERIALIZED (
  -- FLAG: Reject compressed/oversized/non-object metadata before JSON inspection.
  -- Materialize only bounded scalar keys; even admitted objects stay out of the cohort.
  SELECT id, chat_id, rule_code, message_id, created_at,
    CASE WHEN metadata IS NULL THEN 'ABSENT'
      WHEN pg_column_compression(metadata) IS NOT NULL THEN 'COMPRESSED_NOT_INSPECTED'
      WHEN pg_column_size(metadata) > 32768 THEN 'OVERSIZED_NOT_INSPECTED'
      WHEN jsonb_typeof(metadata) <> 'object' THEN 'NON_OBJECT'
      ELSE 'BOUNDED_OBJECT' END AS metadata_admission,
    CASE WHEN pg_column_compression(metadata) IS NULL AND pg_column_size(metadata) <= 32768
      THEN CASE WHEN jsonb_typeof(metadata) = 'object'
        THEN CASE WHEN jsonb_typeof(metadata->'sessionKey') = 'string'
          AND octet_length(metadata->>'sessionKey') BETWEEN 1 AND 512
          AND btrim(metadata->>'sessionKey') <> '' THEN metadata->>'sessionKey' END
      END END AS session_key,
    CASE WHEN pg_column_compression(metadata) IS NULL AND pg_column_size(metadata) <= 32768
      THEN CASE WHEN jsonb_typeof(metadata) = 'object'
        THEN CASE WHEN jsonb_typeof(metadata->'originalEventId') = 'string'
          AND octet_length(metadata->>'originalEventId') BETWEEN 1 AND 512
          AND btrim(metadata->>'originalEventId') <> '' THEN metadata->>'originalEventId' END
      END END AS original_event_id
  FROM moderation_events
  WHERE created_at >= statement_timestamp() - make_interval(mins => $SIGNAL_WINDOW_MIN)
    AND created_at <= statement_timestamp()
  ORDER BY created_at DESC
  LIMIT $((MONITOR_SAMPLE_CAP + 1))
), sample_state AS (
  SELECT count(*)::bigint AS sampled_count
  FROM moderation_sample
), bounded_moderation AS MATERIALIZED (
  SELECT id, chat_id, rule_code, message_id, created_at,
    metadata_admission, session_key, original_event_id
  FROM moderation_sample
  ORDER BY created_at DESC
  LIMIT $MONITOR_SAMPLE_CAP
), metadata_summary AS (
  SELECT count(*)::bigint AS observed_sample_count,
    min(created_at) AS oldest_sample_at,
    max(created_at) AS newest_sample_at,
    count(*) FILTER (WHERE metadata_admission = 'ABSENT') AS absent,
    count(*) FILTER (WHERE metadata_admission = 'COMPRESSED_NOT_INSPECTED') AS compressed,
    count(*) FILTER (WHERE metadata_admission = 'OVERSIZED_NOT_INSPECTED') AS oversized,
    count(*) FILTER (WHERE metadata_admission = 'NON_OBJECT') AS non_object,
    count(*) FILTER (WHERE metadata_admission = 'BOUNDED_OBJECT') AS bounded_object,
    count(*) FILTER (WHERE metadata_admission <> 'BOUNDED_OBJECT') AS unavailable_metadata,
    count(*) FILTER (WHERE
      (rule_code IN ('NIGHT_MODE_CLOSE_NOTICE', 'NIGHT_MODE_OPEN_NOTICE') AND session_key IS NULL)
      OR (rule_code = 'NIGHT_MODE_CLOSE_NOTICE_RECOVERY_DELETE'
        AND (metadata_admission <> 'BOUNDED_OBJECT'
          OR (original_event_id IS NULL AND message_id IS NULL)))
    ) AS unavailable_night_proof
  FROM bounded_moderation
), close_events AS (
  SELECT
    id,
    chat_id,
    session_key,
    message_id,
    created_at,
    row_number() OVER (
      PARTITION BY chat_id, session_key
      ORDER BY created_at DESC, id DESC
    ) AS newest_rank,
    count(*) OVER (PARTITION BY chat_id, session_key) AS group_count
  FROM bounded_moderation
  WHERE rule_code = 'NIGHT_MODE_CLOSE_NOTICE'
    AND session_key IS NOT NULL
), unrecovered_extras AS (
  SELECT close_events.id, close_events.chat_id, close_events.session_key
  FROM close_events
  WHERE group_count > 1
    AND newest_rank > 1
    AND NOT EXISTS (
      SELECT 1
      FROM bounded_moderation recovery
      WHERE recovery.chat_id = close_events.chat_id
        AND recovery.rule_code = 'NIGHT_MODE_CLOSE_NOTICE_RECOVERY_DELETE'
        AND recovery.metadata_admission = 'BOUNDED_OBJECT'
        AND recovery.created_at >= close_events.created_at
        AND (
          recovery.message_id = close_events.message_id
          OR recovery.original_event_id = close_events.id
        )
    )
), night_mode_summary AS (
  SELECT
    rule_code,
    count(*)::bigint AS events,
    count(DISTINCT (chat_id, session_key)) FILTER (WHERE session_key IS NOT NULL)::bigint AS chat_sessions,
    count(*) FILTER (WHERE session_key IS NULL)::bigint AS unavailable_session_keys
  FROM bounded_moderation
  WHERE rule_code IN (
    'NIGHT_MODE_CLOSE_NOTICE',
    'NIGHT_MODE_OPEN_NOTICE',
    'NIGHT_MODE_CLOSE_NOTICE_RECOVERY_DELETE'
  )
  GROUP BY rule_code
), duplicate_summary AS (
  SELECT
    count(DISTINCT (chat_id, session_key))::bigint AS duplicate_groups,
    count(*)::bigint AS duplicate_extra_events
  FROM unrecovered_extras
)
SELECT json_build_object(
  'schema_version', 2,
  'audit', 'recent_night_mode_signals',
  'window_minutes', $SIGNAL_WINDOW_MIN,
  'window_started_at', statement_timestamp() - make_interval(mins => $SIGNAL_WINDOW_MIN),
  'window_ended_at', statement_timestamp(),
  'sample_cap', $MONITOR_SAMPLE_CAP,
  'sample_saturated', sample_state.sampled_count > $MONITOR_SAMPLE_CAP,
  'observed_sample_count', metadata_summary.observed_sample_count,
  'oldest_sample_at', metadata_summary.oldest_sample_at,
  'newest_sample_at', metadata_summary.newest_sample_at,
  -- FLAG: All-rule sampling cannot promise a complete night-rule history.
  -- Unknown metadata and an omitted tail never prove absence of duplicate notices.
  'night_rule_coverage', 'PARTIAL_GLOBAL_COHORT',
  'global_cohort_complete', sample_state.sampled_count <= $MONITOR_SAMPLE_CAP,
  'metadata_admission', json_build_object(
    'ABSENT', metadata_summary.absent,
    'COMPRESSED_NOT_INSPECTED', metadata_summary.compressed,
    'OVERSIZED_NOT_INSPECTED', metadata_summary.oversized,
    'NON_OBJECT', metadata_summary.non_object,
    'BOUNDED_OBJECT', metadata_summary.bounded_object
  ),
  'unavailable_night_proof_count', metadata_summary.unavailable_night_proof,
  'duplicate_evidence', 'UNRECOVERED_CANDIDATES_IN_SAMPLE',
  'duplicate_classification_complete', sample_state.sampled_count <= $MONITOR_SAMPLE_CAP
    AND metadata_summary.unavailable_metadata = 0 AND metadata_summary.unavailable_night_proof = 0,
  'duplicate_groups_in_sample', duplicate_summary.duplicate_groups,
  'duplicate_extra_events_in_sample', duplicate_summary.duplicate_extra_events,
  'rows', coalesce(
    (
      SELECT json_agg(
        json_build_object(
          'rule_code', rule_code,
          'events', events,
          'chat_sessions', chat_sessions,
          'unavailable_session_keys', unavailable_session_keys
        )
        ORDER BY rule_code
      )
      FROM night_mode_summary
    ),
    '[]'::json
  )
)::text
FROM sample_state
CROSS JOIN duplicate_summary
CROSS JOIN metadata_summary;
\else
\echo MAXIM_POSTGRES_MONITOR_AUDIT_INDEX_MISSING
SELECT 1 / 0;
\endif
SQL
}

emit_duplicate_intent_samples() {
  local status
  local status_order=0
  # FLAG: Literal predicates let PostgreSQL cost each status using its own skewed
  # statistics. Each independently ordered source retains its fixed sentinel cap.
  for status in OBSERVED PENDING IN_PROGRESS RETRYABLE WAITING_CAPABILITY \
    AMBIGUOUS SUCCEEDED ALREADY_ABSENT EXPIRED FAILED_TERMINAL; do
    if [[ -n "$DUPLICATE_STATUS" && "$status" != "$DUPLICATE_STATUS" ]]; then
      continue
    fi
    if ((status_order > 0)); then
      printf '%s\n' '  UNION ALL'
    fi
    status_order=$((status_order + 1))
    cat <<SQL
  SELECT $status_order AS status_order, recent.id, recent.status, recent.updated_at
  FROM (
    SELECT id, status, updated_at
    FROM moderation_delete_intents
    WHERE status = '$status'::"ModerationDeleteIntentStatus"
      AND updated_at >= statement_timestamp() - make_interval(mins => 1440)
    ORDER BY updated_at DESC
    LIMIT $((DUPLICATE_INTENT_SAMPLE_CAP_PER_STATUS + 1))
  ) AS recent
SQL
  done
}

emit_duplicate_audit() {
  cat <<SQL
WITH required_duplicate_indexes(
  index_name,
  table_name,
  key_columns,
  is_unique,
  is_primary
) AS (
  VALUES
    (
      'chat_settings_pkey',
      'chat_settings',
      ARRAY['id']::text[],
      true,
      true
    ),
    (
      'moderation_events_created_at_idx',
      'moderation_events',
      ARRAY['created_at']::text[],
      false,
      false
    ),
    (
      'moderation_delete_intents_retention_idx',
      'moderation_delete_intents',
      ARRAY['status', 'updated_at']::text[],
      false,
      false
    ),
    (
      'moderation_delete_intent_reasons_intent_reason_key',
      'moderation_delete_intent_reasons',
      ARRAY['intent_id', 'reason_key']::text[],
      true,
      false
    )
), exact_duplicate_indexes AS (
  SELECT required_duplicate_indexes.index_name
  FROM required_duplicate_indexes
  JOIN pg_namespace index_namespace
    ON index_namespace.nspname = 'public'
  JOIN pg_class index_relation
    ON index_relation.relnamespace = index_namespace.oid
    AND index_relation.relname = required_duplicate_indexes.index_name
  JOIN pg_index index_definition
    ON index_definition.indexrelid = index_relation.oid
  JOIN pg_class table_relation
    ON table_relation.oid = index_definition.indrelid
    AND table_relation.relname = required_duplicate_indexes.table_name
  JOIN pg_namespace table_namespace
    ON table_namespace.oid = table_relation.relnamespace
    AND table_namespace.nspname = 'public'
  JOIN pg_am access_method
    ON access_method.oid = index_relation.relam
    AND access_method.amname = 'btree'
  WHERE index_relation.relkind = 'i'
    AND table_relation.relkind IN ('r', 'p')
    AND index_definition.indisvalid
    AND index_definition.indisready
    AND index_definition.indislive
    AND NOT index_definition.indcheckxmin
    AND index_definition.indisunique = required_duplicate_indexes.is_unique
    AND index_definition.indisprimary = required_duplicate_indexes.is_primary
    AND NOT index_definition.indisexclusion
    AND index_definition.indimmediate
    AND index_definition.indexprs IS NULL
    AND index_definition.indpred IS NULL
    AND index_definition.indnatts = cardinality(required_duplicate_indexes.key_columns)
    AND index_definition.indnkeyatts = cardinality(required_duplicate_indexes.key_columns)
    AND 0 = ALL(index_definition.indoption)
    AND ARRAY(
      SELECT pg_get_indexdef(
        index_definition.indexrelid,
        key_position,
        false
      )
      FROM generate_series(1, index_definition.indnkeyatts) AS key_position
      ORDER BY key_position
    ) = required_duplicate_indexes.key_columns
)
SELECT CASE
  WHEN (
    SELECT count(DISTINCT (table_name, column_name, privilege_type))
    FROM information_schema.role_column_grants
    WHERE grantee = 'maxim_audit'
      AND table_schema = 'public'
      AND table_name IN (
        'chat_settings',
        'moderation_delete_intents',
        'moderation_delete_intent_reasons'
      )
      AND privilege_type = 'SELECT'
  ) IN (40, 48)
    AND 4 = (SELECT count(*) FROM exact_duplicate_indexes) THEN 'true'
  ELSE 'false'
END AS duplicate_audit_ready \gset
\if :duplicate_audit_ready
SQL
  if [[ -z "$DUPLICATE_EXPLAIN" && -z "$DUPLICATE_STATUS" ]]; then
    cat <<SQL
WITH settings_sample_plus AS MATERIALIZED (
  SELECT
    id,
    anti_duplicate_enabled,
    duplicate_photo_enabled,
    duplicate_detection_preset,
    duplicate_photo_match_preset,
    duplicate_photo_scope,
    duplicate_compare_mode,
    duplicate_window_mode,
    duplicate_start_time_minutes,
    duplicate_end_time_minutes,
    duplicate_timezone
  FROM chat_settings
  ORDER BY id ASC
  LIMIT $((DUPLICATE_SETTINGS_SAMPLE_CAP + 1))
), settings_sample AS MATERIALIZED (
  SELECT *
  FROM settings_sample_plus
  ORDER BY id ASC
  LIMIT $DUPLICATE_SETTINGS_SAMPLE_CAP
), valid_named_timezones AS MATERIALIZED (
  SELECT lower(name) AS name FROM pg_timezone_names
), saved_settings AS MATERIALIZED (
  SELECT *,
    duplicate_photo_scope::text IN ('SAME_AUTHOR', 'CHAT')
      AND (
        duplicate_window_mode = 'INTERVAL'
        OR (
          duplicate_window_mode = 'DAILY'
          AND duplicate_start_time_minutes BETWEEN 0 AND 1439
          AND duplicate_end_time_minutes BETWEEN 0 AND 1439
          AND duplicate_start_time_minutes <> duplicate_end_time_minutes
          AND (
            EXISTS (
              SELECT 1 FROM valid_named_timezones WHERE name = lower(btrim(duplicate_timezone))
            )
            OR btrim(duplicate_timezone) ~ '^[+-](0[0-9]|1[0-9]|2[0-3])(:?[0-5][0-9])?$'
          )
        )
      ) AS image_configuration_valid
  FROM settings_sample
), settings_state AS (
  SELECT
    count(*)::bigint AS sampled_count,
    (SELECT count(*) FROM settings_sample_plus) > $DUPLICATE_SETTINGS_SAMPLE_CAP
      AS sample_saturated,
    count(*) FILTER (WHERE anti_duplicate_enabled)::bigint AS master_enabled,
    count(*) FILTER (
      WHERE anti_duplicate_enabled AND image_configuration_valid
    )::bigint AS saved_image_eligible,
    -- FLAG: Preserve the schema-v2 field for the unified policy with no saved text-only mode.
    0::bigint AS saved_text_only,
    count(*) FILTER (
      WHERE anti_duplicate_enabled AND NOT image_configuration_valid
    )::bigint AS invalid_saved_image_configuration,
    count(*) FILTER (WHERE duplicate_photo_enabled)::bigint AS photo_toggle_enabled,
    count(*) FILTER (
      WHERE anti_duplicate_enabled AND duplicate_photo_enabled
    )::bigint AS legacy_photo_conjunction,
    count(*) FILTER (
      WHERE duplicate_photo_enabled AND NOT anti_duplicate_enabled
    )::bigint AS legacy_photo_without_master
  FROM saved_settings
), legacy_text_presets AS (
  SELECT duplicate_detection_preset::text AS preset, count(*)::bigint AS settings_count
  FROM settings_sample
  WHERE anti_duplicate_enabled
  GROUP BY duplicate_detection_preset
), legacy_photo_presets AS (
  SELECT
    duplicate_photo_match_preset::text AS preset,
    duplicate_photo_scope::text AS scope,
    count(*)::bigint AS settings_count
  FROM settings_sample
  WHERE anti_duplicate_enabled
    AND duplicate_photo_enabled
  GROUP BY duplicate_photo_match_preset, duplicate_photo_scope
), image_policies AS (
  SELECT duplicate_photo_scope::text AS scope,
    duplicate_window_mode AS window_mode,
    count(*)::bigint AS settings_count
  FROM saved_settings
  WHERE anti_duplicate_enabled AND image_configuration_valid
  GROUP BY duplicate_photo_scope, duplicate_window_mode
)
SELECT json_build_object(
  'schema_version', 2,
  'audit', 'duplicate_settings',
  'observed_at', statement_timestamp(),
  'sample_cap', $DUPLICATE_SETTINGS_SAMPLE_CAP,
  'sampled_count', settings_state.sampled_count,
  'sample_saturated', settings_state.sample_saturated,
  'complete', NOT settings_state.sample_saturated,
  'runtime_authority', 'not_observed_by_sql',
  'capability_freshness', 'not_observed_by_sql',
  'saved_eligibility', json_build_object(
    'basis', 'master_scope_schedule',
    'master_enabled_count_lower_bound', settings_state.master_enabled,
    'image_eligible_count_lower_bound', settings_state.saved_image_eligible,
    'text_only_count_lower_bound', settings_state.saved_text_only,
    'invalid_image_configuration_count_lower_bound',
      settings_state.invalid_saved_image_configuration,
    'daily_current_period', 'not_evaluated',
    'image_policies', coalesce(
      (SELECT json_agg(json_build_object(
        'scope', scope, 'window_mode', window_mode, 'count_lower_bound', settings_count
      ) ORDER BY scope, window_mode) FROM image_policies), '[]'::json
    )
  ),
  'legacy_compatibility', json_build_object(
    'controls_current_image_policy', false,
    'photo_toggle_enabled_count_lower_bound', settings_state.photo_toggle_enabled,
    'master_and_photo_toggle_count_lower_bound', settings_state.legacy_photo_conjunction,
    'photo_toggle_without_master_count_lower_bound', settings_state.legacy_photo_without_master,
    'text_presets', coalesce(
      (
        SELECT json_agg(
          json_build_object('preset', preset, 'count_lower_bound', settings_count)
          ORDER BY preset
        )
        FROM legacy_text_presets
      ),
      '[]'::json
    ),
    'photo_presets', coalesce(
      (
        SELECT json_agg(
          json_build_object(
            'preset', preset,
            'scope', scope,
            'count_lower_bound', settings_count
          )
          ORDER BY preset, scope
        )
        FROM legacy_photo_presets
      ),
      '[]'::json
    )
  )
)::text
FROM settings_state;

WITH event_sample_plus AS MATERIALIZED (
  SELECT rule_code, action, created_at
  FROM moderation_events
  WHERE created_at >= statement_timestamp() - make_interval(mins => 1440)
  ORDER BY created_at DESC
  LIMIT $((DUPLICATE_EVENT_SAMPLE_CAP + 1))
), event_sample AS MATERIALIZED (
  SELECT *
  FROM event_sample_plus
  ORDER BY created_at DESC
  LIMIT $DUPLICATE_EVENT_SAMPLE_CAP
), event_sample_state AS (
  SELECT
    count(*)::bigint AS candidate_count,
    count(*) > $DUPLICATE_EVENT_SAMPLE_CAP AS sample_saturated
  FROM event_sample_plus
), event_sample_bounds AS (
  SELECT min(created_at) AS oldest_created_at
  FROM event_sample
), audit_windows(window_minutes) AS (
  VALUES (60), (1440)
), event_windows AS (
  SELECT
    audit_windows.window_minutes,
    count(event_sample.created_at) FILTER (
      WHERE event_sample.rule_code IN (
        'DUPLICATE_DELETE',
        'DUPLICATE_WARN',
        'DUPLICATE_MUTE',
        'DUPLICATE_BAN'
      )
    )::bigint AS count_lower_bound,
    count(event_sample.created_at) FILTER (
      WHERE left(event_sample.rule_code, 10) = 'DUPLICATE_'
        AND event_sample.rule_code NOT IN (
          'DUPLICATE_DELETE',
          'DUPLICATE_WARN',
          'DUPLICATE_MUTE',
          'DUPLICATE_BAN'
        )
    )::bigint AS unrecognized_rule_count,
    count(event_sample.created_at)::bigint AS sampled_rows,
    event_sample_state.sample_saturated
      AND event_sample_bounds.oldest_created_at >=
        statement_timestamp() - make_interval(mins => audit_windows.window_minutes)
      AS sample_saturated,
    (
      NOT event_sample_state.sample_saturated
      OR event_sample_bounds.oldest_created_at <
        statement_timestamp() - make_interval(mins => audit_windows.window_minutes)
    ) AS complete
  FROM audit_windows
  CROSS JOIN event_sample_state
  CROSS JOIN event_sample_bounds
  LEFT JOIN event_sample
    ON event_sample.created_at >=
      statement_timestamp() - make_interval(mins => audit_windows.window_minutes)
  GROUP BY
    audit_windows.window_minutes,
    event_sample_state.sample_saturated,
    event_sample_bounds.oldest_created_at
), event_rows AS (
  SELECT
    audit_windows.window_minutes,
    event_sample.rule_code,
    event_sample.action::text AS action,
    count(*)::bigint AS count_lower_bound
  FROM audit_windows
  JOIN event_sample
    ON event_sample.created_at >=
      statement_timestamp() - make_interval(mins => audit_windows.window_minutes)
  WHERE event_sample.rule_code IN (
    'DUPLICATE_DELETE',
    'DUPLICATE_WARN',
    'DUPLICATE_MUTE',
    'DUPLICATE_BAN'
  )
  GROUP BY audit_windows.window_minutes, event_sample.rule_code, event_sample.action
)
SELECT json_build_object(
  'schema_version', 1,
  'audit', 'recent_duplicate_moderation',
  'sample_cap', $DUPLICATE_EVENT_SAMPLE_CAP,
  'windows', coalesce(
    (
      SELECT json_agg(
        json_build_object(
          'window_minutes', window_minutes,
          'sampled_rows', sampled_rows,
          'count_lower_bound', count_lower_bound,
          'unrecognized_rule_count', unrecognized_rule_count,
          'sample_saturated', sample_saturated,
          'complete', complete
        )
        ORDER BY window_minutes
      )
      FROM event_windows
    ),
    '[]'::json
  ),
  'rows', coalesce(
    (
      SELECT json_agg(
        json_build_object(
          'window_minutes', window_minutes,
          'rule_code', rule_code,
          'action', action,
          'count_lower_bound', count_lower_bound
        )
        ORDER BY window_minutes, rule_code, action
      )
      FROM event_rows
    ),
    '[]'::json
  )
)::text;

SQL
  elif [[ -n "$DUPLICATE_EXPLAIN" ]]; then
    printf '%s\n' 'EXPLAIN (FORMAT JSON)'
  fi
  cat <<SQL
WITH intent_statuses(status_order, status) AS (
  VALUES
    (1, 'OBSERVED'::"ModerationDeleteIntentStatus"),
    (2, 'PENDING'::"ModerationDeleteIntentStatus"),
    (3, 'IN_PROGRESS'::"ModerationDeleteIntentStatus"),
    (4, 'RETRYABLE'::"ModerationDeleteIntentStatus"),
    (5, 'WAITING_CAPABILITY'::"ModerationDeleteIntentStatus"),
    (6, 'AMBIGUOUS'::"ModerationDeleteIntentStatus"),
    (7, 'SUCCEEDED'::"ModerationDeleteIntentStatus"),
    (8, 'ALREADY_ABSENT'::"ModerationDeleteIntentStatus"),
    (9, 'EXPIRED'::"ModerationDeleteIntentStatus"),
    (10, 'FAILED_TERMINAL'::"ModerationDeleteIntentStatus")
), intent_sample_plus AS MATERIALIZED (
$(emit_duplicate_intent_samples)
), ranked_intents AS MATERIALIZED (
  SELECT
    intent_sample_plus.*,
    row_number() OVER (
      PARTITION BY status
      ORDER BY updated_at DESC
    ) AS sample_rank
  FROM intent_sample_plus
), intent_sample AS MATERIALIZED (
  SELECT status_order, id, status, updated_at
  FROM ranked_intents
  WHERE sample_rank <= $DUPLICATE_INTENT_SAMPLE_CAP_PER_STATUS
), intent_sample_counts AS (
  SELECT status, count(*)::bigint AS candidate_count
  FROM intent_sample_plus
  GROUP BY status
), intent_status_state AS (
  SELECT
    intent_statuses.status_order,
    intent_statuses.status,
    coalesce(intent_sample_counts.candidate_count, 0)::bigint AS candidate_count,
    min(intent_sample.updated_at) AS oldest_updated_at
  FROM intent_statuses
  LEFT JOIN intent_sample_counts ON intent_sample_counts.status = intent_statuses.status
  LEFT JOIN intent_sample ON intent_sample.status = intent_statuses.status
  GROUP BY
    intent_statuses.status_order,
    intent_statuses.status,
    intent_sample_counts.candidate_count
), intent_reason_summary AS MATERIALIZED (
  SELECT
    intent_sample.status,
    intent_sample.updated_at,
    coalesce(reason_sample.has_duplicate, false) AS has_duplicate,
    coalesce(reason_sample.sample_saturated, false) AS sample_saturated
  FROM intent_sample
  LEFT JOIN LATERAL (
    SELECT
      bool_or(bounded_reason.rule_code = 'DUPLICATE_DELETE') AS has_duplicate,
      count(*) > $DUPLICATE_REASON_SAMPLE_CAP_PER_INTENT AS sample_saturated
    FROM (
      SELECT reason_key, rule_code
      FROM moderation_delete_intent_reasons
      WHERE intent_id = intent_sample.id
      ORDER BY reason_key ASC
      LIMIT $((DUPLICATE_REASON_SAMPLE_CAP_PER_INTENT + 1))
    ) AS bounded_reason
  ) AS reason_sample ON TRUE
), audit_windows(window_minutes) AS (
  VALUES (60), (1440)
), intent_rows AS (
  SELECT
    audit_windows.window_minutes,
    intent_status_state.status_order,
    intent_status_state.status::text AS status,
    count(intent_reason_summary.updated_at)::bigint AS sampled_intents,
    count(intent_reason_summary.updated_at) FILTER (
      WHERE intent_reason_summary.has_duplicate
    )::bigint AS count_lower_bound,
    count(intent_reason_summary.updated_at) FILTER (
      WHERE intent_reason_summary.sample_saturated
    )::bigint AS saturated_reason_intents,
    intent_status_state.candidate_count > $DUPLICATE_INTENT_SAMPLE_CAP_PER_STATUS
      AND intent_status_state.oldest_updated_at >=
        statement_timestamp() - make_interval(mins => audit_windows.window_minutes)
      AS sample_saturated,
    (
      intent_status_state.candidate_count <= $DUPLICATE_INTENT_SAMPLE_CAP_PER_STATUS
      OR intent_status_state.oldest_updated_at <
        statement_timestamp() - make_interval(mins => audit_windows.window_minutes)
    ) AND count(intent_reason_summary.updated_at) FILTER (
      WHERE intent_reason_summary.sample_saturated
    ) = 0 AS complete
  FROM audit_windows
  CROSS JOIN intent_status_state
  LEFT JOIN intent_reason_summary
    ON intent_reason_summary.status = intent_status_state.status
    AND intent_reason_summary.updated_at >=
      statement_timestamp() - make_interval(mins => audit_windows.window_minutes)
  WHERE ('$DUPLICATE_STATUS' = '' OR intent_status_state.status::text = '$DUPLICATE_STATUS')
  GROUP BY
    audit_windows.window_minutes,
    intent_status_state.status_order,
    intent_status_state.status,
    intent_status_state.candidate_count,
    intent_status_state.oldest_updated_at
)
SELECT json_build_object(
  'schema_version', 1,
  'audit', 'recent_duplicate_delete_intents',
  'sampled_at', statement_timestamp(),
  'status_scope', '${DUPLICATE_STATUS:-all}',
  'window_basis', 'updated_at',
  'sample_cap_per_status', $DUPLICATE_INTENT_SAMPLE_CAP_PER_STATUS,
  'reason_sample_cap_per_intent', $DUPLICATE_REASON_SAMPLE_CAP_PER_INTENT,
  'rows', json_agg(
    json_build_object(
      'window_minutes', window_minutes,
      'status', status,
      'sampled_intents', sampled_intents,
      'count_lower_bound', count_lower_bound,
      'saturated_reason_intents', saturated_reason_intents,
      'sample_saturated', sample_saturated,
      'complete', complete
    )
    ORDER BY window_minutes, status_order
  )
)::text
FROM intent_rows;
\else
\echo MAXIM_POSTGRES_DUPLICATE_AUDIT_UNAVAILABLE
SELECT 1 / 0;
\endif
SQL
}

emit_legacy_default_webhook_audit() {
  node "$LEGACY_DEFAULT_DB_AUDIT_HELPER" emit-sql "$LEGACY_DEFAULT_SNAPSHOT_PATH"
}

emit_sql() {
  emit_prelude
  local chat_moderation_privilege_args=(--privileges)
  if [[ "$AUDIT_MODE" == 'chat-moderation' ]]; then chat_moderation_privilege_args+=(--require-all); fi
  node "$ROOT_DIR/infra/scripts/chat-moderation-audit.mjs" "${chat_moderation_privilege_args[@]}"
  local karavan_privilege_args=(--privileges)
  if [[ "$AUDIT_MODE" == 'karavan-candidates' ]]; then karavan_privilege_args+=(--require-all); fi
  node "$ROOT_DIR/infra/scripts/karavan-candidates-audit.mjs" "${karavan_privilege_args[@]}"
  local central_privilege_args=(--privileges)
  if [[ "$AUDIT_MODE" == 'central-statistics' ]]; then central_privilege_args+=(--require-all); fi
  node "$ROOT_DIR/infra/scripts/central-statistics-audit.mjs" "${central_privilege_args[@]}"
  local exchange_privilege_args=(--privileges)
  if [[ "$AUDIT_MODE" == 'statistics-exchange' ]]; then exchange_privilege_args+=(--require-all); fi
  node "$ROOT_DIR/infra/scripts/statistics-exchange-audit.mjs" "${exchange_privilege_args[@]}"
  local network_privilege_args=(--privileges)
  if [[ "$AUDIT_MODE" == 'network-statistics' || "$AUDIT_MODE" == 'central-statistics' ]]; then network_privilege_args+=(--require-all); fi
  if [[ "$AUDIT_MODE" == 'central-statistics' ]]; then network_privilege_args+=(--observations); fi
  local network_argument
  for network_argument in "${NETWORK_STATISTICS_ARGS[@]}"; do
    if [[ "$network_argument" == '--observations' ]]; then network_privilege_args+=(--observations); fi
    if [[ "$network_argument" == --membership=* ]]; then network_privilege_args+=(--membership); fi
  done
  node "$ROOT_DIR/infra/scripts/network-statistics-audit.mjs" "${network_privilege_args[@]}"
  local publication_privilege_args=(--privileges)
  if [[ "$AUDIT_MODE" == 'publisher-publications' || "$AUDIT_MODE" == 'publisher-slots' ]]; then
    publication_privilege_args+=(--require-all)
  fi
  node "$ROOT_DIR/infra/scripts/publisher-publications-audit.mjs" "${publication_privilege_args[@]}"
  local slot_privilege_args=(--privileges)
  if [[ "$AUDIT_MODE" == 'publisher-slots' ]]; then slot_privilege_args+=(--require-all); fi
  node "$ROOT_DIR/infra/scripts/publisher-slot-audit.mjs" "${slot_privilege_args[@]}"
  local commercial_privilege_args=(--privileges)
  if [[ "$AUDIT_MODE" == 'commercial-quality' ]]; then
    commercial_privilege_args+=(--require-all)
  fi
  node "$ROOT_DIR/infra/scripts/commercial-quality-audit.mjs" "${commercial_privilege_args[@]}"
  node "$ROOT_DIR/infra/scripts/webhook-owner-proof-audit.mjs" --privileges
  node "$ROOT_DIR/infra/scripts/webhook-held-receipt-audit.mjs" --privileges
  local poll_privilege_args=(--privileges)
  if [[ "$AUDIT_MODE" == 'poll-publication' ]]; then poll_privilege_args+=(--require-all); fi
  node "$ROOT_DIR/infra/scripts/poll-publication-audit.mjs" "${poll_privilege_args[@]}"
  local quarantine_privilege_args=(--privileges)
  if [[ "$AUDIT_MODE" == 'webhook-quarantine' ]]; then quarantine_privilege_args+=(--require-all); fi
  node "$ROOT_DIR/infra/scripts/webhook-quarantine-audit.mjs" "${quarantine_privilege_args[@]}"
  case "$AUDIT_MODE" in
    chat-moderation)
      node "$ROOT_DIR/infra/scripts/chat-moderation-audit.mjs" "${CHAT_MODERATION_ARGS[@]}"
      ;;
    karavan-candidates)
      node "$ROOT_DIR/infra/scripts/karavan-candidates-audit.mjs" "${KARAVAN_CANDIDATE_ARGS[@]}"
      ;;
    central-statistics)
      node "$ROOT_DIR/infra/scripts/central-statistics-audit.mjs" "${CENTRAL_STATISTICS_ARGS[@]}"
      ;;
    statistics-exchange)
      node "$ROOT_DIR/infra/scripts/statistics-exchange-audit.mjs" "${STATISTICS_EXCHANGE_ARGS[@]}"
      ;;
    network-statistics)
      node "$ROOT_DIR/infra/scripts/network-statistics-audit.mjs" "${NETWORK_STATISTICS_ARGS[@]}"
      ;;
    publisher-slots)
      node "$ROOT_DIR/infra/scripts/publisher-slot-audit.mjs" "${PUBLISHER_SLOT_ARGS[@]}"
      ;;
    webhook-source-envelope)
      local source_envelope_args=("$SOURCE_ENVELOPE_OWNER")
      if [[ -n "$RULES_CLEANUP_EXPLAIN" ]]; then source_envelope_args+=("$RULES_CLEANUP_EXPLAIN"); fi
      node "$ROOT_DIR/infra/scripts/webhook-source-envelope-audit.mjs" "${source_envelope_args[@]}"
      ;;
    webhook-held-receipt)
      node "$ROOT_DIR/infra/scripts/webhook-held-receipt-audit.mjs" "${HELD_RECEIPT_ARGS[@]}"
      ;;
    webhook-owner-proof|webhook-source-proof|webhook-retry-proof|webhook-queued-proof)
      local owner_proof_args=()
      if [[ "$AUDIT_MODE" == "webhook-source-proof" ]]; then
        owner_proof_args+=(--source)
      elif [[ "$AUDIT_MODE" == "webhook-queued-proof" ]]; then
        owner_proof_args+=(--queued)
      elif [[ "$AUDIT_MODE" == "webhook-retry-proof" ]]; then
        owner_proof_args+=(--retry)
      fi
      if [[ -n "$RULES_CLEANUP_EXPLAIN" ]]; then
        owner_proof_args+=("$RULES_CLEANUP_EXPLAIN")
      fi
      node "$ROOT_DIR/infra/scripts/webhook-owner-proof-audit.mjs" "${owner_proof_args[@]}"
      ;;
    queue|queue-active)
      emit_queue_audit
      ;;
    legacy-order-candidates)
      emit_legacy_order_candidates_audit
      ;;
    legacy-order-window)
      emit_legacy_order_window_audit
      ;;
    legacy-semantic-mirrors)
      emit_legacy_semantic_mirrors_audit
      ;;
    webhook-workload)
      node "$ROOT_DIR/infra/scripts/webhook-workload-audit.mjs" ${RULES_CLEANUP_EXPLAIN:+"$RULES_CLEANUP_EXPLAIN"}
      ;;
    webhook-cohort)
      node "$ROOT_DIR/infra/scripts/webhook-cohort-audit.mjs" "${WEBHOOK_COHORT_ARGS[@]}"
      ;;
    webhook-recovery-key-cohort)
      node "$ROOT_DIR/infra/scripts/webhook-recovery-key-cohort-audit.mjs" "${RECOVERY_KEY_COHORT_ARGS[@]}"
      ;;
    chat-message-window)
      node "$ROOT_DIR/infra/scripts/chat-message-window-audit.mjs" "${MESSAGE_WINDOW_ARGS[@]}"
      ;;
    action-latency)
      local action_latency_args=()
      if [[ -n "$RULES_CLEANUP_EXPLAIN" ]]; then action_latency_args+=("$RULES_CLEANUP_EXPLAIN"); fi
      node "$ROOT_DIR/infra/scripts/action-latency-audit.mjs" "${action_latency_args[@]}"
      ;;
    delete-retry-heads)
      local retry_head_args=()
      if [[ -n "$RULES_CLEANUP_EXPLAIN" ]]; then
        retry_head_args+=("$RULES_CLEANUP_EXPLAIN")
      fi
      node "$ROOT_DIR/infra/scripts/delete-retry-heads-audit.mjs" "${retry_head_args[@]}"
      ;;
    moderation-outcomes)
      node "$ROOT_DIR/infra/scripts/moderation-outcomes-audit.mjs" "${MODERATION_OUTCOME_ARGS[@]}"
      ;;
    activity)
      emit_activity_audit
      ;;
    duplicate)
      emit_duplicate_audit
      ;;
    publication-schema)
      node "$ROOT_DIR/infra/scripts/publication-post-actions-schema-audit.mjs"
      ;;
    storage)
      local storage_args=()
      if [[ -n "$RULES_CLEANUP_EXPLAIN" ]]; then
        storage_args+=("$RULES_CLEANUP_EXPLAIN")
      fi
      node "$ROOT_DIR/infra/scripts/postgres-storage-audit.mjs" "${storage_args[@]}"
      ;;
    multibot-preparation)
      local multibot_args=()
      if [[ -n "$RULES_CLEANUP_EXPLAIN" ]]; then
        multibot_args+=("$RULES_CLEANUP_EXPLAIN")
      fi
      node "$ROOT_DIR/infra/scripts/multibot-prepare-diagnostics.mjs" "${multibot_args[@]}"
      ;;
    webhook-quarantine)
      local quarantine_args=("$QUARANTINE_MINUTE")
      if [[ -n "$RULES_CLEANUP_EXPLAIN" ]]; then quarantine_args+=("$RULES_CLEANUP_EXPLAIN"); fi
      node "$ROOT_DIR/infra/scripts/webhook-quarantine-audit.mjs" "${quarantine_args[@]}"
      ;;
    webhook-quarantine-proof)
      node "$ROOT_DIR/infra/scripts/webhook-quarantine-proof-audit.mjs" "${QUARANTINE_PROOF_ARGS[@]}"
      ;;
    poll-publication)
      local poll_args=("$POLL_PUBLICATION_ID")
      if [[ -n "$RULES_CLEANUP_EXPLAIN" ]]; then poll_args+=("$RULES_CLEANUP_EXPLAIN"); fi
      node "$ROOT_DIR/infra/scripts/poll-publication-audit.mjs" "${poll_args[@]}"
      ;;
    rules-cleanup)
      local args=("$RULES_CLEANUP_CHAT_ID")
      if [[ -n "$RULES_CLEANUP_EXPLAIN" ]]; then
        args+=("$RULES_CLEANUP_EXPLAIN")
      fi
      node "$ROOT_DIR/infra/scripts/rules-cleanup-audit.mjs" "${args[@]}"
      ;;
    publisher-comments)
      local publisher_args=("$RULES_CLEANUP_CHAT_ID")
      if [[ -n "$RULES_CLEANUP_EXPLAIN" ]]; then
        publisher_args+=("$RULES_CLEANUP_EXPLAIN")
      fi
      node "$ROOT_DIR/infra/scripts/publisher-comments-audit.mjs" "${publisher_args[@]}"
      ;;
    publisher-publications)
      local publication_args=()
      if [[ -n "$RULES_CLEANUP_EXPLAIN" ]]; then
        publication_args+=("$RULES_CLEANUP_EXPLAIN")
      fi
      node "$ROOT_DIR/infra/scripts/publisher-publications-audit.mjs" "${publication_args[@]}"
      ;;
    commercial-quality)
      local quality_args=()
      if [[ -n "$RULES_CLEANUP_EXPLAIN" ]]; then
        quality_args+=("$RULES_CLEANUP_EXPLAIN")
      fi
      node "$ROOT_DIR/infra/scripts/commercial-quality-audit.mjs" "${quality_args[@]}"
      ;;
    publisher-access-census)
      local census_args=()
      if [[ -n "$RULES_CLEANUP_EXPLAIN" ]]; then
        census_args+=("$RULES_CLEANUP_EXPLAIN")
      fi
      node "$ROOT_DIR/infra/scripts/publisher-access-census.mjs" "${census_args[@]}"
      ;;
    all)
      emit_queue_audit
      emit_activity_audit
      emit_duplicate_audit
      ;;
    monitor-signals)
      emit_monitor_signals_audit
      ;;
    legacy-default-webhook-jobs)
      emit_legacy_default_webhook_audit
      ;;
  esac
  printf '%s\n' 'COMMIT;'
}

prepare_audit_sql() {
  local temp_root="${TMPDIR:-/tmp}"

  if [[ "$temp_root" != /* || ! -d "$temp_root" || "$temp_root" == *$'\n'* ]]; then
    echo "TMPDIR must be an existing absolute directory." >&2
    return 1
  fi
  AUDIT_SQL_FILE="$(mktemp "$temp_root/maxim-postgres-audit-sql.XXXXXXXX")" || {
    echo "Could not create the private PostgreSQL audit input." >&2
    return 1
  }
  chmod 0600 "$AUDIT_SQL_FILE"
  if ! emit_sql >"$AUDIT_SQL_FILE"; then
    echo "Could not generate the bounded PostgreSQL audit." >&2
    return 1
  fi
  if [[ ! -s "$AUDIT_SQL_FILE" || -L "$AUDIT_SQL_FILE" ]]; then
    echo "Generated PostgreSQL audit input is invalid." >&2
    return 1
  fi
  if [[ "$AUDIT_MODE" == "legacy-default-webhook-jobs" || "$AUDIT_MODE" == "webhook-quarantine-proof" || "$AUDIT_MODE" == "webhook-source-envelope" || "$AUDIT_MODE" == "webhook-held-receipt" || "$AUDIT_MODE" == "webhook-recovery-key-cohort" || ( "$AUDIT_MODE" == "webhook-owner-proof" || "$AUDIT_MODE" == "webhook-source-proof" || "$AUDIT_MODE" == "webhook-retry-proof" || "$AUDIT_MODE" == "webhook-queued-proof" ) || ( "$AUDIT_MODE" == "action-latency" || "$AUDIT_MODE" == "delete-retry-heads" || "$AUDIT_MODE" == "chat-message-window" || "$AUDIT_MODE" == "chat-moderation" || "$AUDIT_MODE" == "moderation-outcomes" || "$AUDIT_MODE" == "webhook-cohort" || "$AUDIT_MODE" == "webhook-workload" ) || ( "$AUDIT_MODE" == "legacy-order-candidates" || "$AUDIT_MODE" == "legacy-order-window" || "$AUDIT_MODE" == "legacy-semantic-mirrors" ) ]]; then
    AUDIT_STDERR_FILE="$(mktemp "$temp_root/maxim-postgres-audit-stderr.XXXXXXXX")" || {
      echo "Could not create the private PostgreSQL audit diagnostics file." >&2
      return 1
    }
    chmod 0600 "$AUDIT_STDERR_FILE"
  fi
}

psql_command=(
  docker compose --env-file .env -p infra -f infra/docker-compose.yml
  exec -T
  -e "PGAPPNAME=$POSTGRES_AUDIT_APP_NAME"
  -e "PGOPTIONS=$POSTGRES_AUDIT_OPTIONS"
  postgres
  psql -X --no-password -qAt -v ON_ERROR_STOP=1 -v ECHO=none -v VERBOSITY=terse -v SHOW_CONTEXT=never
  -U "$POSTGRES_AUDIT_ROLE" -d maxim
)

# Reached through the EXIT/signal cleanup path.
# shellcheck disable=SC2317,SC2329
cleanup_backend() {
  local cleanup_sql

  cleanup_sql="$(cat <<SQL
WITH candidate AS MATERIALIZED (
  SELECT pid, backend_start
  FROM pg_stat_activity
  WHERE application_name = '$POSTGRES_AUDIT_APP_NAME'
    AND pid <> pg_backend_pid()
  ORDER BY pid, backend_start
  LIMIT 2
), singleton AS (
  SELECT min(pid) AS pid, min(backend_start) AS backend_start
  FROM candidate
  HAVING count(*) = 1
)
SELECT pg_terminate_backend(live.pid)
FROM singleton
JOIN pg_stat_activity live
  ON live.pid = singleton.pid
  AND live.backend_start = singleton.backend_start
  AND live.application_name = '$POSTGRES_AUDIT_APP_NAME'
SQL
)"
  timeout --signal=TERM --kill-after=1s 4s \
    docker compose --env-file .env -p infra -f infra/docker-compose.yml \
    exec -T \
    -e PGAPPNAME=maxim-bounded-audit-cleanup \
    -e 'PGOPTIONS=-c statement_timeout=2s -c lock_timeout=250ms -c idle_session_timeout=10s -c max_parallel_workers_per_gather=0 -c jit=off' \
    postgres \
      psql -X --no-password -qAt -v ON_ERROR_STOP=1 \
      -U maxim -d maxim -c "$cleanup_sql" \
    >/dev/null 2>&1 || true
}

AUDIT_PROCESS_PID=''

# Reached through the EXIT/signal cleanup path.
# shellcheck disable=SC2317,SC2329
terminate_local_audit() {
  local pid="$AUDIT_PROCESS_PID"

  if [[ ! "$pid" =~ ^[1-9][0-9]*$ ]]; then
    return 0
  fi
  if kill -0 "$pid" 2>/dev/null; then
    kill -TERM "$pid" 2>/dev/null || true
    for _ in {1..20}; do
      if ! kill -0 "$pid" 2>/dev/null; then
        break
      fi
      sleep 0.05
    done
    if kill -0 "$pid" 2>/dev/null; then
      kill -KILL "$pid" 2>/dev/null || true
    fi
  fi
  wait "$pid" 2>/dev/null || true
  AUDIT_PROCESS_PID=''
}

# Invoked indirectly by the shell traps below.
# shellcheck disable=SC2317,SC2329
cleanup() {
  local status=$?

  trap - EXIT HUP INT TERM
  terminate_local_audit
  if [[ "$AUDIT_BACKEND_MAY_EXIST" -eq 1 ]]; then
    cleanup_backend
  fi
  if [[ -n "$AUDIT_SQL_FILE" && -f "$AUDIT_SQL_FILE" && ! -L "$AUDIT_SQL_FILE" ]]; then
    rm -f -- "$AUDIT_SQL_FILE"
  fi
  AUDIT_SQL_FILE=''
KARAVAN_CANDIDATE_ARGS=()
  if [[ -n "$AUDIT_STDERR_FILE" && -f "$AUDIT_STDERR_FILE" && ! -L "$AUDIT_STDERR_FILE" ]]; then
    rm -f -- "$AUDIT_STDERR_FILE"
  fi
  AUDIT_STDERR_FILE=''
  exit "$status"
}

trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

prepare_audit_sql
AUDIT_BACKEND_MAY_EXIST=1
if [[ "$AUDIT_MODE" == "legacy-default-webhook-jobs" || "$AUDIT_MODE" == "webhook-quarantine-proof" || "$AUDIT_MODE" == "webhook-source-envelope" || "$AUDIT_MODE" == "webhook-held-receipt" || "$AUDIT_MODE" == "webhook-recovery-key-cohort" || ( "$AUDIT_MODE" == "webhook-owner-proof" || "$AUDIT_MODE" == "webhook-source-proof" || "$AUDIT_MODE" == "webhook-retry-proof" || "$AUDIT_MODE" == "webhook-queued-proof" ) || ( "$AUDIT_MODE" == "action-latency" || "$AUDIT_MODE" == "delete-retry-heads" || "$AUDIT_MODE" == "chat-message-window" || "$AUDIT_MODE" == "chat-moderation" || "$AUDIT_MODE" == "moderation-outcomes" || "$AUDIT_MODE" == "webhook-cohort" || "$AUDIT_MODE" == "webhook-workload" ) || ( "$AUDIT_MODE" == "legacy-order-candidates" || "$AUDIT_MODE" == "legacy-order-window" || "$AUDIT_MODE" == "legacy-semantic-mirrors" ) ]]; then
  timeout --signal=TERM --kill-after=2s \
    "$AUDIT_WALL_TIMEOUT_SEC" "${psql_command[@]}" <"$AUDIT_SQL_FILE" \
    2>"$AUDIT_STDERR_FILE" &
else
  timeout --signal=TERM --kill-after=2s \
    "$AUDIT_WALL_TIMEOUT_SEC" "${psql_command[@]}" <"$AUDIT_SQL_FILE" &
fi
AUDIT_PROCESS_PID=$!
set +e
wait "$AUDIT_PROCESS_PID"
status=$?
set -e
AUDIT_PROCESS_PID=''

if [[ "$status" -ne 0 && "$AUDIT_MODE" == "webhook-held-receipt" ]]; then
  echo "Bounded webhook held receipt audit failed closed (held_receipt_unavailable)." >&2
elif [[ "$status" -eq 124 ]]; then
  echo "Bounded PostgreSQL audit exceeded ${AUDIT_WALL_TIMEOUT_SEC}s and was terminated." >&2
elif [[ "$status" -ne 0 && "$AUDIT_MODE" == "webhook-recovery-key-cohort" ]]; then
  echo "Bounded webhook recovery key cohort audit failed closed (recovery_key_cohort_unavailable)." >&2
elif [[ "$status" -ne 0 && "$AUDIT_MODE" == "webhook-source-envelope" ]]; then
  echo "Bounded webhook source envelope audit failed closed (source_envelope_unavailable)." >&2
elif [[ "$status" -ne 0 && "$AUDIT_MODE" == "webhook-quarantine-proof" ]]; then
  echo "Bounded webhook quarantine proof audit failed closed (quarantine_proof_unavailable)." >&2
elif [[ "$status" -ne 0 && ( "$AUDIT_MODE" == "webhook-owner-proof" || "$AUDIT_MODE" == "webhook-source-proof" || "$AUDIT_MODE" == "webhook-retry-proof" || "$AUDIT_MODE" == "webhook-queued-proof" ) ]]; then
  echo "Bounded webhook owner proof audit failed closed (owner_proof_unavailable)." >&2
elif [[ "$status" -ne 0 && "$AUDIT_MODE" == "legacy-default-webhook-jobs" ]]; then
  echo "Bounded legacy default webhook database audit failed closed." >&2
elif [[ "$status" -ne 0 && ( "$AUDIT_MODE" == "legacy-order-candidates" || "$AUDIT_MODE" == "legacy-order-window" || "$AUDIT_MODE" == "legacy-semantic-mirrors" ) ]]; then
  echo "Bounded legacy order candidate audit failed closed." >&2
elif [[ "$status" -ne 0 && "$AUDIT_MODE" == "action-latency" ]]; then
  echo "Bounded action latency audit failed closed; private SQL details withheld." >&2
elif [[ "$status" -ne 0 && "$AUDIT_MODE" == "delete-retry-heads" ]]; then
  echo "Bounded delete retry heads audit failed closed." >&2
elif [[ "$status" -ne 0 && "$AUDIT_MODE" == "chat-moderation" ]]; then
  echo "Bounded chat moderation audit failed closed; private SQL details withheld." >&2
elif [[ "$status" -ne 0 && "$AUDIT_MODE" == "chat-message-window" ]]; then
  echo "Bounded chat message window audit failed closed." >&2
elif [[ "$status" -ne 0 && "$AUDIT_MODE" == "moderation-outcomes" ]]; then
  echo "Bounded moderation outcomes audit failed closed." >&2
elif [[ "$status" -ne 0 && "$AUDIT_MODE" == "webhook-workload" ]]; then
  echo "Bounded webhook workload audit failed closed; private SQL details withheld." >&2
elif [[ "$status" -ne 0 && "$AUDIT_MODE" == "webhook-cohort" ]]; then
  echo "Bounded webhook cohort audit failed closed." >&2
fi
exit "$status"
