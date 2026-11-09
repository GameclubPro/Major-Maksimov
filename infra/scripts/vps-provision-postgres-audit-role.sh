#!/usr/bin/env bash
set -euo pipefail
umask 077

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

AUDIT_LOCK_FILE=/tmp/maxim-postgres-audit.lock

if [[ "${1:-}" != '--apply' ]]; then
  if [[ $# -ne 0 ]]; then
    echo "Usage: $0 [--apply]" >&2
    exit 2
  fi
  cat <<'PREVIEW'
Preview only; no database state changed.

The apply step creates or hardens the passwordless maxim_audit login intended for
local Docker-socket access under the production pg_hba rules, with:
  - NOSUPERUSER, NOCREATEDB, NOCREATEROLE, NOREPLICATION, NOBYPASSRLS
  - connection limit 1 and no password
  - table SELECT only on webhook_events/moderation_events
  - exact Antiduplicate column SELECT grants and pg_read_all_stats membership
  - 21 additional delete-intent/verified-reason metadata columns for bounded owner proof;
    identities, lease tokens and reason metadata are check-only and never report output
  - two delete failure columns, classified in SQL; raw error text is never reported
  - nineteen exact poll/original-bot metadata columns; no question, images, voters or permissions
  - eight quarantine-journal metadata columns; no identities or raw errors in report output
  - ten rules-publication metadata columns; no rules text, media, links, or settings
  - seventeen Publisher binding/comment metadata columns
  - forty-three publication/access metadata columns; IDs are join-only and never report output
  - thirty-one additive scheduled-slot metadata columns when the complete group exists;
    recipient IDs and lock tokens are join/check-only and never report output
  - eight commercial-review metadata columns only; no evidence, captions or user/message IDs
  - fifteen channel-statistics metadata columns; no post bodies, authors or reactions
  - forty-five optional network-observation/archive/collector metadata columns;
    no actor/bot/binding IDs, cursor signatures or lease tokens
  - eight optional network-membership rollup/feed metadata columns;
    no canonical/source, actor, user or bot identities
  - thirty-seven optional exchange measurement/authorization metadata columns;
    IDs are join-only, errors are booleans, no message content or tokens
  - thirty-six optional central statistics metadata columns; join keys stay inside SQL,
    no measurement values, coverage payloads, hashes or receipt results
  - eight fixed migration receipt columns; errors classified in SQL, raw logs never reported
  - 25 owner-proof columns across execution claims and action ledger; source keys,
    lease/dispatch tokens and command journal are join/check-only and never report output
  - six optional bounded action-latency ledger columns and a separate pair of schedule clocks,
    only with the complete owner-proof group;
    IDs and admitted schedule metadata stay inside SQL, with no bot/error grants
  - 28 optional held-receipt scalar metadata columns; identities and seal bindings
    are join/check-only, with no payload, snapshot, attestation or effect authority
  - thirteen optional Karavan inventory projection columns; chat IDs/titles only in the private report, no actor IDs or raw audit payloads
  - twelve optional exact-group moderation settings/roster metadata columns;
    no user IDs, configured words/domains, message content or permissions in output
  - no publication content, media, tokens or raw permission payloads
  - INHERIT only so the pg_read_all_stats membership takes effect
  - read-only/time/parallel/memory/temp defaults used as a server-side backstop

Run with --apply during a reviewed maintenance step.
PREVIEW
  exit 0
fi

if [[ $# -ne 1 ]]; then
  echo "Usage: $0 [--apply]" >&2
  exit 2
fi

for required_command in docker flock timeout; do
  if ! command -v "$required_command" >/dev/null 2>&1; then
    echo "$required_command is required to provision the PostgreSQL audit role." >&2
    exit 1
  fi
done

exec {AUDIT_LOCK_FD}>>"$AUDIT_LOCK_FILE"
if ! flock -n "$AUDIT_LOCK_FD"; then
  echo "Refusing to change the PostgreSQL audit role while a bounded audit is running." >&2
  exit 75
fi

timeout --signal=TERM --kill-after=2s 12s \
  docker compose --env-file .env -p infra -f infra/docker-compose.yml exec -T postgres \
    env PGAPPNAME=maxim-audit-role-provision \
      PGOPTIONS='-c statement_timeout=5s -c lock_timeout=1s -c idle_in_transaction_session_timeout=5s' \
    psql -X --no-password -v ON_ERROR_STOP=1 -U maxim -d maxim <<'SQL'
BEGIN;

DO $provision$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'maxim_audit') THEN
    CREATE ROLE maxim_audit
      LOGIN
      NOSUPERUSER
      INHERIT
      NOCREATEDB
      NOCREATEROLE
      NOREPLICATION
      NOBYPASSRLS
      CONNECTION LIMIT 1
      PASSWORD NULL;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_auth_members memberships
    JOIN pg_roles granted_role ON granted_role.oid = memberships.roleid
    JOIN pg_roles member_role ON member_role.oid = memberships.member
    WHERE member_role.rolname = 'maxim_audit'
      AND granted_role.rolname NOT IN ('pg_read_all_data', 'pg_read_all_stats')
  ) THEN
    RAISE EXCEPTION 'maxim_audit has unexpected role memberships; review manually';
  END IF;
END
$provision$;

ALTER ROLE maxim_audit
  LOGIN
  NOSUPERUSER
  INHERIT
  NOCREATEDB
  NOCREATEROLE
  NOREPLICATION
  NOBYPASSRLS
  CONNECTION LIMIT 1
  PASSWORD NULL;

REVOKE pg_read_all_data FROM maxim_audit;
REVOKE ALL PRIVILEGES ON DATABASE maxim FROM maxim_audit;
REVOKE ALL PRIVILEGES ON SCHEMA public FROM maxim_audit;
REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM maxim_audit;
REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM maxim_audit;

DO $revoke_audit_columns$
DECLARE
  target RECORD;
BEGIN
  FOR target IN
    SELECT
      table_name,
      string_agg(format('%I', column_name), ', ' ORDER BY ordinal_position) AS column_list
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name IN (
        'publisher_entity_bindings',
        'publisher_entity_settings',
        'managed_entity_publication_policies',
        'chat_rules', 'managed_polls', 'chat_bot_memberships', 'chat_admin_roster_states', 'webhook_dependency_quarantines',
        'chat_settings',
        'moderation_delete_intents',
        'moderation_delete_intent_reasons',
        'publications', 'publication_schedules', 'publication_occurrences',
        'publication_targets', 'managed_entity_access_edges', 'managed_bot_chat_catalog',
        'managed_broadcast_deliveries', 'managed_broadcasts', 'chats', 'commercial_review_samples', '_prisma_migrations',
        'webhook_execution_claims', 'max_action_ledger',
        'webhook_legacy_recoveries', 'webhook_legacy_sealed_authorities',
        'webhook_legacy_quiescence_certificates', 'webhook_source_abandonments',
        'webhook_backlog_receipts'
        , 'channel_audience_snapshots', 'channel_stats_sync_states', 'channel_posts', 'channel_post_view_snapshots',
        'managed_entity_audience_observations', 'channel_view_observation_states', 'channel_view_observed_intervals',
        'channel_view_archive_states', 'marketplace_bindings', 'chat_membership_activity_rollups', 'chat_membership_activity_feed_items',
        'stats_entities', 'stats_authorities', 'stats_measurements', 'stats_ingest_requests', 'stats_changes',
        'statistics_exchange_grants', 'statistics_exchange_entities', 'statistics_exchange_imports', 'statistics_exchange_generations',
        'karavan_marketplace_candidate_settings', 'karavan_marketplace_candidate_events'
      )
    GROUP BY table_name
  LOOP
    EXECUTE format(
      'REVOKE SELECT (%1$s), INSERT (%1$s), UPDATE (%1$s), REFERENCES (%1$s) '
        || 'ON TABLE public.%2$I FROM maxim_audit',
      target.column_list,
      target.table_name
    );
  END LOOP;
END
$revoke_audit_columns$;

DO $karavan_candidates$ BEGIN
    IF to_regclass('public.karavan_marketplace_candidate_settings') IS NOT NULL AND to_regclass('public.karavan_marketplace_candidate_events') IS NOT NULL THEN
      GRANT SELECT(settings_id,chat_id,chat_title,entity_type,enabled,admins_only) ON public.karavan_marketplace_candidate_settings TO maxim_audit;
      GRANT SELECT(id,chat_id,action,created_at,storefront_field_touched,relay_status,relay_sent_confirmed) ON public.karavan_marketplace_candidate_events TO maxim_audit;
    END IF;
  END $karavan_candidates$;

DO $karavan_candidate_privileges$ BEGIN IF NOT (WITH allowed(table_name,column_name) AS (VALUES ('karavan_marketplace_candidate_settings','settings_id'),('karavan_marketplace_candidate_settings','chat_id'),('karavan_marketplace_candidate_settings','chat_title'),('karavan_marketplace_candidate_settings','entity_type'),('karavan_marketplace_candidate_settings','enabled'),('karavan_marketplace_candidate_settings','admins_only'),('karavan_marketplace_candidate_events','id'),('karavan_marketplace_candidate_events','chat_id'),('karavan_marketplace_candidate_events','action'),('karavan_marketplace_candidate_events','created_at'),('karavan_marketplace_candidate_events','storefront_field_touched'),('karavan_marketplace_candidate_events','relay_status'),('karavan_marketplace_candidate_events','relay_sent_confirmed')), effective AS (
    SELECT relation.relname AS table_name,attribute.attname AS column_name FROM pg_class relation
    JOIN pg_namespace ns ON ns.oid=relation.relnamespace JOIN pg_attribute attribute ON attribute.attrelid=relation.oid
    WHERE ns.nspname='public' AND relation.relname IN (SELECT table_name FROM allowed)
      AND attribute.attnum>0 AND NOT attribute.attisdropped
      AND has_column_privilege('maxim_audit',relation.oid,attribute.attnum,'SELECT')
  ) SELECT NOT EXISTS(SELECT * FROM effective EXCEPT SELECT * FROM allowed)
    AND (SELECT count(*) FROM effective) IN (0,13)
    AND NOT has_table_privilege('maxim_audit','public.audit_logs','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
    AND NOT EXISTS(SELECT 1 FROM pg_attribute a WHERE a.attrelid='public.audit_logs'::regclass AND a.attnum>0 AND NOT a.attisdropped AND has_column_privilege('maxim_audit',a.attrelid,a.attnum,'SELECT,INSERT,UPDATE,REFERENCES'))
    AND NOT EXISTS(SELECT 1 FROM pg_class r JOIN pg_namespace ns ON ns.oid=r.relnamespace WHERE ns.nspname='public' AND r.relname IN (SELECT table_name FROM allowed)
      AND (has_table_privilege('maxim_audit',r.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') OR EXISTS(SELECT 1 FROM pg_attribute a WHERE a.attrelid=r.oid AND a.attnum>0 AND NOT a.attisdropped AND has_column_privilege('maxim_audit',r.oid,a.attnum,'INSERT,UPDATE,REFERENCES'))))
   ) THEN RAISE EXCEPTION 'maxim_audit Karavan candidate privileges are not exact'; END IF; END $karavan_candidate_privileges$;

-- FLAG: This optional exact-chat metadata extension grants all twelve columns or none.
DO $chat_moderation_grants$
BEGIN
  IF NOT EXISTS (
    WITH extension(table_name,column_name) AS (VALUES ('chat_settings','chat_id'),('chat_settings','link_policy'),('chat_settings','link_rules_policy'),('chat_settings','link_policy_revision'),('chat_settings','link_policy_effective_at'),('chat_settings','russian_profanity_filter_enabled'),('chat_settings','profanity_sensitivity'),('chat_settings','updated_at'),('chat_admin_roster_states','chat_id'),('chat_admin_roster_states','completed_at'),('chat_admin_roster_states','complete_probe_started_at'),('chat_admin_roster_states','refresh_requested_at'))
    SELECT 1 FROM extension LEFT JOIN pg_attribute attribute
      ON attribute.attrelid=to_regclass('public.'||extension.table_name)
      AND attribute.attname=extension.column_name AND attribute.attnum>0 AND NOT attribute.attisdropped
    WHERE attribute.attnum IS NULL
  ) THEN
    GRANT SELECT (chat_id,link_policy,link_rules_policy,link_policy_revision,link_policy_effective_at,russian_profanity_filter_enabled,profanity_sensitivity,updated_at) ON TABLE public.chat_settings TO maxim_audit;
    GRANT SELECT (chat_id,completed_at,complete_probe_started_at,refresh_requested_at) ON TABLE public.chat_admin_roster_states TO maxim_audit;
  END IF;
  IF NOT (WITH allowed(table_name,column_name) AS (VALUES ('chats','id'),('chats','entity_type'),('chat_settings','id'),('chat_settings','anti_duplicate_enabled'),('chat_settings','duplicate_photo_enabled'),('chat_settings','duplicate_detection_preset'),('chat_settings','duplicate_photo_match_preset'),('chat_settings','duplicate_photo_scope'),('chat_settings','duplicate_compare_mode'),('chat_settings','duplicate_window_mode'),('chat_settings','duplicate_start_time_minutes'),('chat_settings','duplicate_end_time_minutes'),('chat_settings','duplicate_timezone'),('chat_settings','chat_id'),('chat_settings','link_policy'),('chat_settings','link_rules_policy'),('chat_settings','link_policy_revision'),('chat_settings','link_policy_effective_at'),('chat_settings','russian_profanity_filter_enabled'),('chat_settings','profanity_sensitivity'),('chat_settings','updated_at'),('chat_bot_memberships','chat_id'),('chat_bot_memberships','bot_id'),('chat_bot_memberships','status'),('chat_bot_memberships','bot_access_state'),('chat_bot_memberships','bot_access_checked_at'),('chat_bot_memberships','bot_access_source'),('chat_bot_memberships','lifecycle_event_at'),('chat_admin_roster_states','chat_id'),('chat_admin_roster_states','completed_at'),('chat_admin_roster_states','complete_probe_started_at'),('chat_admin_roster_states','refresh_requested_at')),
    extension(table_name,column_name) AS (VALUES ('chat_settings','chat_id'),('chat_settings','link_policy'),('chat_settings','link_rules_policy'),('chat_settings','link_policy_revision'),('chat_settings','link_policy_effective_at'),('chat_settings','russian_profanity_filter_enabled'),('chat_settings','profanity_sensitivity'),('chat_settings','updated_at'),('chat_admin_roster_states','chat_id'),('chat_admin_roster_states','completed_at'),('chat_admin_roster_states','complete_probe_started_at'),('chat_admin_roster_states','refresh_requested_at')), effective AS (
      SELECT relation.relname AS table_name,attribute.attname AS column_name
      FROM pg_class relation JOIN pg_namespace ns ON ns.oid=relation.relnamespace
      JOIN pg_attribute attribute ON attribute.attrelid=relation.oid
      WHERE ns.nspname='public' AND relation.relname IN (SELECT table_name FROM allowed)
        AND attribute.attnum>0 AND NOT attribute.attisdropped
        AND has_column_privilege('maxim_audit',relation.oid,attribute.attnum,'SELECT')
    ) SELECT NOT EXISTS (SELECT * FROM effective EXCEPT SELECT * FROM allowed)
      AND (SELECT count(*) FROM effective JOIN extension USING(table_name,column_name))
        IN (0,12)
      AND NOT EXISTS (SELECT 1 FROM pg_class relation JOIN pg_namespace ns ON ns.oid=relation.relnamespace
        WHERE ns.nspname='public' AND relation.relname IN (SELECT table_name FROM allowed)
          AND (has_table_privilege('maxim_audit',relation.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
            OR EXISTS (SELECT 1 FROM pg_attribute attribute WHERE attribute.attrelid=relation.oid
              AND attribute.attnum>0 AND NOT attribute.attisdropped
              AND has_column_privilege('maxim_audit',relation.oid,attribute.attnum,'INSERT,UPDATE,REFERENCES'))))) THEN
    RAISE EXCEPTION 'maxim_audit chat-moderation metadata privileges are not exact';
  END IF;
END
$chat_moderation_grants$;

GRANT CONNECT ON DATABASE maxim TO maxim_audit;
GRANT USAGE ON SCHEMA public TO maxim_audit;
GRANT SELECT ON TABLE public.webhook_events, public.moderation_events TO maxim_audit;
GRANT SELECT (
  chat_id, status, bot_access_state, bot_access_checked_at,
  bot_access_expires_at, send_route_quarantined_until, publisher_bot_id, last_webhook_at, bot_access_source
) ON TABLE public.publisher_entity_bindings TO maxim_audit;
GRANT SELECT (
  chat_id, chat_comments_enabled, chat_comments_admins_enabled,
  chat_comments_posts_enabled, channel_comments_enabled, updated_at
) ON TABLE public.publisher_entity_settings TO maxim_audit;
GRANT SELECT (
  chat_id, publik_enabled
) ON TABLE public.managed_entity_publication_policies TO maxim_audit;
GRANT SELECT (
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
) ON TABLE public.chat_settings TO maxim_audit;
GRANT SELECT (
  id,
  status,
  updated_at,
  chat_id,
  message_id,
  subject_user_id,
  source_message_at,
  attempt_count,
  leased_from_status,
  lease_token,
  lease_expires_at,
  delete_dispatch_started_at,
  delete_dispatch_started_bot_id,
  remote_delete_succeeded_at,
  remote_delete_succeeded_bot_id,
  completed_at,
  absence_verified_at,
  absence_verification_code,
  retry_until_at,
  next_attempt_at,
  first_attempt_at,
  last_attempt_at,
  last_status_code,
  last_error_code,
  last_error
) ON TABLE public.moderation_delete_intents TO maxim_audit;
GRANT SELECT (
  chat_id, published_message_id, published_bot_id, publish_operation_id,
  publish_send_started_at, pending_cleanup_message_id, pending_cleanup_bot_id,
  pending_cleanup_intent_id, pending_cleanup_kind, updated_at
) ON TABLE public.chat_rules TO maxim_audit;
-- FLAG: Partial legacy catalogs receive neither poll metadata group.
DO $poll_metadata_grants$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM (VALUES ('managed_polls', ARRAY['id','chat_id','status','publication_message_id','publication_bot_id',
        'render_revision','rendered_revision','render_format_version','last_render_error',
        'published_at','closed_at','updated_at']),
      ('chat_bot_memberships', ARRAY['chat_id','bot_id','status','bot_access_state',
        'bot_access_checked_at','bot_access_source','lifecycle_event_at'])) required(table_name, columns)
    CROSS JOIN LATERAL unnest(required.columns) expected(column_name)
    LEFT JOIN pg_attribute attribute ON attribute.attrelid = to_regclass('public.' || required.table_name)
      AND attribute.attname = expected.column_name AND attribute.attnum > 0 AND NOT attribute.attisdropped
    WHERE attribute.attnum IS NULL
  ) THEN
GRANT SELECT (id, chat_id, status, publication_message_id, publication_bot_id,
  render_revision, rendered_revision, render_format_version, last_render_error,
  published_at, closed_at, updated_at) ON TABLE public.managed_polls TO maxim_audit;
GRANT SELECT (chat_id, bot_id, status, bot_access_state, bot_access_checked_at,
  bot_access_source, lifecycle_event_at) ON TABLE public.chat_bot_memberships TO maxim_audit;
  END IF;
END
$poll_metadata_grants$;
DO $quarantine_metadata_grants$
BEGIN
  IF 8 = (SELECT count(*) FROM pg_attribute WHERE
      attrelid = to_regclass('public.webhook_dependency_quarantines') AND attnum > 0 AND NOT attisdropped
      AND attname IN ('receipt_id','blocker_id','anchor_id','state','deadline_at','created_at','next_check_at','resolved_at')) THEN
    GRANT SELECT (receipt_id, blocker_id, anchor_id, state, deadline_at, created_at, next_check_at, resolved_at)
      ON TABLE public.webhook_dependency_quarantines TO maxim_audit;
  END IF;
END
$quarantine_metadata_grants$;
GRANT SELECT (
  intent_id,
  reason_key,
  rule_code,
  metadata
) ON TABLE public.moderation_delete_intent_reasons TO maxim_audit;
GRANT SELECT (id, actor_user_id, lifecycle, audience_mode, audience_selection, dispatch_profile, required_bot_id)
  ON TABLE public.publications TO maxim_audit;
GRANT SELECT (id, mode, status, revision) ON TABLE public.publication_schedules TO maxim_audit;
GRANT SELECT (id, publication_id, schedule_id, status, scheduled_at, dispatch_profile, required_bot_id, dispatch_blocker_code)
  ON TABLE public.publication_occurrences TO maxim_audit;
GRANT SELECT (publication_id, target_chat_id, entity_type, position) ON TABLE public.publication_targets TO maxim_audit;
GRANT SELECT (chat_id, user_id, bot_id, state, user_role, entity_type, checked_at, expires_at, denied_reason)
  ON TABLE public.managed_entity_access_edges TO maxim_audit;
GRANT SELECT (bot_id, chat_id, status, entity_type) ON TABLE public.managed_bot_chat_catalog TO maxim_audit;
GRANT SELECT (publication_occurrence_id, created_at, status, attempt_count, remote_message_id)
  ON TABLE public.managed_broadcast_deliveries TO maxim_audit;
-- FLAG: Older schemas keep zero slot access. Grant only the complete metadata group;
-- lock tokens and recipient identifiers are comparison-only, never report output.
DO $publisher_slot_grants$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM (VALUES
      ('publication_occurrences', ARRAY['content_revision_id', 'schedule_revision', 'delivery_deadline_at',
        'dispatch_blocked_at', 'retry_authorized_at', 'retry_expires_at', 'created_at', 'updated_at']),
      ('managed_broadcast_deliveries', ARRAY['id', 'broadcast_id', 'content_revision_id', 'target_chat_id', 'bot_id', 'required_bot_id',
        'dispatch_profile', 'next_attempt_at', 'wait_reason', 'dispatch_blocker_code',
        'locked_at', 'lock_token', 'sent_at', 'last_error_code']),
      ('managed_broadcasts', ARRAY['id', 'publication_occurrence_id', 'publication_content_revision_id',
        'status', 'next_send_at', 'locked_at', 'lock_token', 'dispatch_profile', 'required_bot_id'])
    ) required(table_name, columns)
    CROSS JOIN LATERAL unnest(required.columns) expected(column_name)
    LEFT JOIN pg_attribute attribute ON attribute.attrelid = to_regclass('public.' || required.table_name)
      AND attribute.attname = expected.column_name AND attribute.attnum > 0 AND NOT attribute.attisdropped
    WHERE attribute.attnum IS NULL
  ) THEN
    GRANT SELECT (content_revision_id, schedule_revision, delivery_deadline_at, dispatch_blocked_at,
      retry_authorized_at, retry_expires_at, created_at, updated_at)
      ON TABLE public.publication_occurrences TO maxim_audit;
    GRANT SELECT (id, broadcast_id, content_revision_id, target_chat_id, bot_id, required_bot_id, dispatch_profile, next_attempt_at,
      wait_reason, dispatch_blocker_code, locked_at, lock_token, sent_at, last_error_code)
      ON TABLE public.managed_broadcast_deliveries TO maxim_audit;
    GRANT SELECT (id, publication_occurrence_id, publication_content_revision_id, status, next_send_at,
      locked_at, lock_token, dispatch_profile, required_bot_id) ON TABLE public.managed_broadcasts TO maxim_audit;
  END IF;
END
$publisher_slot_grants$;
GRANT SELECT (id, entity_type) ON TABLE public.chats TO maxim_audit;
-- FLAG: Optional central metadata grants are exact and all-or-none. Join keys
-- stay inside SQL; values, payloads, hashes and native permission fields are excluded.
DO $central_statistics_grants$
BEGIN
  IF NOT EXISTS (
    WITH allowed(table_name,column_name) AS (VALUES ('stats_entities','id'),('stats_entities','kind'),('stats_entities','max_id'),('stats_entities','data_revision'),('stats_authorities','entity_id'),('stats_authorities','issuer'),('stats_authorities','role'),('stats_authorities','producer'),('stats_authorities','consumer'),('stats_authorities','actor_max_id'),('stats_authorities','bot_ref'),('stats_authorities','purpose'),('stats_authorities','state'),('stats_authorities','superseded_by'),('stats_authorities','peer_valid_until'),('stats_authorities','checked_at'),('stats_measurements','entity_id'),('stats_measurements','producer'),('stats_measurements','metric'),('stats_measurements','horizon'),('stats_measurements','method_id'),('stats_measurements','day'),('stats_measurements','deleted'),('stats_measurements','observed_from'),('stats_measurements','observed_to'),('stats_measurements','updated_at'),('stats_ingest_requests','producer'),('stats_ingest_requests','producer_epoch'),('stats_ingest_requests','record_kind'),('stats_ingest_requests','operation_key'),('stats_ingest_requests','created_at'),('stats_changes','id'),('stats_changes','cause'),('stats_changes','created_at'),('stats_changes','published_seq'),('stats_changes','published_at'))
    SELECT 1 FROM allowed LEFT JOIN pg_attribute attribute
      ON attribute.attrelid=to_regclass('public.'||allowed.table_name)
      AND attribute.attname=allowed.column_name AND attribute.attnum>0 AND NOT attribute.attisdropped
    WHERE attribute.attnum IS NULL
  ) THEN
    GRANT SELECT (id,kind,max_id,data_revision) ON TABLE public.stats_entities TO maxim_audit;
    GRANT SELECT (entity_id,issuer,role,producer,consumer,actor_max_id,bot_ref,purpose,state,superseded_by,peer_valid_until,checked_at) ON TABLE public.stats_authorities TO maxim_audit;
    GRANT SELECT (entity_id,producer,metric,horizon,method_id,day,deleted,observed_from,observed_to,updated_at) ON TABLE public.stats_measurements TO maxim_audit;
    GRANT SELECT (producer,producer_epoch,record_kind,operation_key,created_at) ON TABLE public.stats_ingest_requests TO maxim_audit;
    GRANT SELECT (id,cause,created_at,published_seq,published_at) ON TABLE public.stats_changes TO maxim_audit;
  END IF;
  IF EXISTS (
    WITH allowed(table_name,column_name) AS (VALUES ('stats_entities','id'),('stats_entities','kind'),('stats_entities','max_id'),('stats_entities','data_revision'),('stats_authorities','entity_id'),('stats_authorities','issuer'),('stats_authorities','role'),('stats_authorities','producer'),('stats_authorities','consumer'),('stats_authorities','actor_max_id'),('stats_authorities','bot_ref'),('stats_authorities','purpose'),('stats_authorities','state'),('stats_authorities','superseded_by'),('stats_authorities','peer_valid_until'),('stats_authorities','checked_at'),('stats_measurements','entity_id'),('stats_measurements','producer'),('stats_measurements','metric'),('stats_measurements','horizon'),('stats_measurements','method_id'),('stats_measurements','day'),('stats_measurements','deleted'),('stats_measurements','observed_from'),('stats_measurements','observed_to'),('stats_measurements','updated_at'),('stats_ingest_requests','producer'),('stats_ingest_requests','producer_epoch'),('stats_ingest_requests','record_kind'),('stats_ingest_requests','operation_key'),('stats_ingest_requests','created_at'),('stats_changes','id'),('stats_changes','cause'),('stats_changes','created_at'),('stats_changes','published_seq'),('stats_changes','published_at')), effective AS (
      SELECT relation.relname AS table_name,attribute.attname AS column_name
      FROM pg_class relation JOIN pg_namespace ns ON ns.oid=relation.relnamespace
      JOIN pg_attribute attribute ON attribute.attrelid=relation.oid
      WHERE ns.nspname='public' AND relation.relname IN (SELECT table_name FROM allowed)
        AND attribute.attnum>0 AND NOT attribute.attisdropped
        AND has_column_privilege('maxim_audit',relation.oid,attribute.attnum,'SELECT')
    ) SELECT 1 WHERE EXISTS (SELECT * FROM effective EXCEPT SELECT * FROM allowed)
      OR (SELECT count(*) FROM effective) NOT IN (0,36)
      OR EXISTS (SELECT 1 FROM pg_class relation JOIN pg_namespace ns ON ns.oid=relation.relnamespace
        WHERE ns.nspname='public' AND relation.relname IN (SELECT table_name FROM allowed)
          AND (has_table_privilege('maxim_audit',relation.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
            OR EXISTS (SELECT 1 FROM pg_attribute attribute WHERE attribute.attrelid=relation.oid
              AND attribute.attnum>0 AND NOT attribute.attisdropped
              AND has_column_privilege('maxim_audit',relation.oid,attribute.attnum,'INSERT,UPDATE,REFERENCES'))))
  ) THEN RAISE EXCEPTION 'maxim_audit central-statistics metadata privileges are not exact'; END IF;
END
$central_statistics_grants$;

-- FLAG: Optional exchange metadata grants are all-or-none; JSON is measurement
-- transport, never message content. Join keys and raw errors never leave the report.
DO $statistics_exchange_grants$
BEGIN
  IF NOT EXISTS (
    WITH allowed(table_name,column_name) AS (VALUES ('statistics_exchange_grants','id'),('statistics_exchange_grants','actor_user_id'),('statistics_exchange_grants','revision'),('statistics_exchange_grants','state'),('statistics_exchange_grants','updated_at'),('statistics_exchange_grants','next_pull_at'),('statistics_exchange_grants','last_pull_at'),('statistics_exchange_grants','last_error'),('statistics_exchange_grants','producer_revision'),('statistics_exchange_grants','last_remote_access_at'),('statistics_exchange_grants','remote_access_error'),('statistics_exchange_entities','grant_id'),('statistics_exchange_entities','entity_id'),('statistics_exchange_entities','kind'),('statistics_exchange_entities','binding_id'),('statistics_exchange_entities','error'),('statistics_exchange_entities','remote_valid_until'),('statistics_exchange_entities','remote_binding_id'),('statistics_exchange_imports','grant_id'),('statistics_exchange_imports','grant_revision'),('statistics_exchange_imports','entity_id'),('statistics_exchange_imports','kind'),('statistics_exchange_imports','producer_revision'),('statistics_exchange_imports','manifest'),('statistics_exchange_imports','rows'),('statistics_exchange_imports','updated_at'),('statistics_exchange_imports','remote_valid_until'),('statistics_exchange_generations','id'),('statistics_exchange_generations','grant_id'),('statistics_exchange_generations','grant_revision'),('statistics_exchange_generations','entity_id'),('statistics_exchange_generations','kind'),('statistics_exchange_generations','origin'),('statistics_exchange_generations','producer_revision'),('statistics_exchange_generations','manifest'),('statistics_exchange_generations','rows'),('statistics_exchange_generations','created_at'))
    SELECT 1 FROM allowed LEFT JOIN pg_attribute attribute
      ON attribute.attrelid=to_regclass('public.'||allowed.table_name)
      AND attribute.attname=allowed.column_name AND attribute.attnum>0 AND NOT attribute.attisdropped
    WHERE attribute.attnum IS NULL
  ) THEN
    GRANT SELECT (id,actor_user_id,revision,state,updated_at,next_pull_at,last_pull_at,last_error,producer_revision,last_remote_access_at,remote_access_error) ON TABLE public.statistics_exchange_grants TO maxim_audit;
    GRANT SELECT (grant_id,entity_id,kind,binding_id,error,remote_valid_until,remote_binding_id) ON TABLE public.statistics_exchange_entities TO maxim_audit;
    GRANT SELECT (grant_id,grant_revision,entity_id,kind,producer_revision,manifest,rows,updated_at,remote_valid_until) ON TABLE public.statistics_exchange_imports TO maxim_audit;
    GRANT SELECT (id,grant_id,grant_revision,entity_id,kind,origin,producer_revision,manifest,rows,created_at) ON TABLE public.statistics_exchange_generations TO maxim_audit;
  END IF;
  IF EXISTS (
    WITH allowed(table_name,column_name) AS (VALUES ('statistics_exchange_grants','id'),('statistics_exchange_grants','actor_user_id'),('statistics_exchange_grants','revision'),('statistics_exchange_grants','state'),('statistics_exchange_grants','updated_at'),('statistics_exchange_grants','next_pull_at'),('statistics_exchange_grants','last_pull_at'),('statistics_exchange_grants','last_error'),('statistics_exchange_grants','producer_revision'),('statistics_exchange_grants','last_remote_access_at'),('statistics_exchange_grants','remote_access_error'),('statistics_exchange_entities','grant_id'),('statistics_exchange_entities','entity_id'),('statistics_exchange_entities','kind'),('statistics_exchange_entities','binding_id'),('statistics_exchange_entities','error'),('statistics_exchange_entities','remote_valid_until'),('statistics_exchange_entities','remote_binding_id'),('statistics_exchange_imports','grant_id'),('statistics_exchange_imports','grant_revision'),('statistics_exchange_imports','entity_id'),('statistics_exchange_imports','kind'),('statistics_exchange_imports','producer_revision'),('statistics_exchange_imports','manifest'),('statistics_exchange_imports','rows'),('statistics_exchange_imports','updated_at'),('statistics_exchange_imports','remote_valid_until'),('statistics_exchange_generations','id'),('statistics_exchange_generations','grant_id'),('statistics_exchange_generations','grant_revision'),('statistics_exchange_generations','entity_id'),('statistics_exchange_generations','kind'),('statistics_exchange_generations','origin'),('statistics_exchange_generations','producer_revision'),('statistics_exchange_generations','manifest'),('statistics_exchange_generations','rows'),('statistics_exchange_generations','created_at')), effective AS (
      SELECT relation.relname AS table_name,attribute.attname AS column_name
      FROM pg_class relation JOIN pg_namespace ns ON ns.oid=relation.relnamespace
      JOIN pg_attribute attribute ON attribute.attrelid=relation.oid
      WHERE ns.nspname='public' AND relation.relname IN (SELECT table_name FROM allowed)
        AND attribute.attnum>0 AND NOT attribute.attisdropped
        AND has_column_privilege('maxim_audit',relation.oid,attribute.attnum,'SELECT')
    ) SELECT 1 WHERE EXISTS (SELECT * FROM effective EXCEPT SELECT * FROM allowed)
      OR (SELECT count(*) FROM effective) NOT IN (0,37)
      OR EXISTS (SELECT 1 FROM pg_class relation JOIN pg_namespace ns ON ns.oid=relation.relnamespace
        WHERE ns.nspname='public' AND relation.relname IN (SELECT table_name FROM allowed)
          AND (has_table_privilege('maxim_audit',relation.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
            OR EXISTS (SELECT 1 FROM pg_attribute attribute WHERE attribute.attrelid=relation.oid
              AND attribute.attnum>0 AND NOT attribute.attisdropped
              AND has_column_privilege('maxim_audit',relation.oid,attribute.attnum,'INSERT,UPDATE,REFERENCES'))))
  ) THEN RAISE EXCEPTION 'maxim_audit statistics-exchange metadata privileges are not exact'; END IF;
END
$statistics_exchange_grants$;

-- FLAG: The pre-release statistics collector works on the existing schema. Only
-- the complete fifteen-column metadata group is granted; partial catalogs get none.
DO $network_statistics_grants$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM (VALUES
      ('channel_audience_snapshots', ARRAY['chat_id','participants_count','captured_at']),
      ('channel_stats_sync_states', ARRAY['chat_id','membership_coverage_from','views_coverage_from',
        'last_audience_sync_at','last_views_sync_at','last_views_discovery_at']),
      ('channel_posts', ARRAY['id','chat_id','published_at','latest_snapshot_at']),
      ('channel_post_view_snapshots', ARRAY['channel_post_id','captured_at'])
    ) required(table_name,columns)
    CROSS JOIN LATERAL unnest(required.columns) expected(column_name)
    LEFT JOIN pg_attribute attribute ON attribute.attrelid=to_regclass('public.'||required.table_name)
      AND attribute.attname=expected.column_name AND attribute.attnum>0 AND NOT attribute.attisdropped
    WHERE attribute.attnum IS NULL
  ) THEN
    GRANT SELECT (chat_id, participants_count, captured_at) ON TABLE public.channel_audience_snapshots TO maxim_audit;
    GRANT SELECT (chat_id, membership_coverage_from, views_coverage_from, last_audience_sync_at,
      last_views_sync_at, last_views_discovery_at) ON TABLE public.channel_stats_sync_states TO maxim_audit;
    GRANT SELECT (id, chat_id, published_at, latest_snapshot_at) ON TABLE public.channel_posts TO maxim_audit;
    GRANT SELECT (channel_post_id, captured_at) ON TABLE public.channel_post_view_snapshots TO maxim_audit;
  END IF;
END
$network_statistics_grants$;
-- FLAG: Observation evidence is optional until the additive foundation is installed.
-- Grant this complete metadata group or none, and reject inherited/public overgrants.
DO $network_statistics_observation_grants$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM (VALUES
      ('managed_entity_audience_observations', ARRAY['chat_id','entity_type','participants_count','observed_at','source']),
      ('channel_view_observation_states', ARRAY['channel_post_id','baseline_at','observed_at','observed_views','high_water_views','anomaly_at','source']),
      ('channel_view_observed_intervals', ARRAY['channel_post_id','chat_id','from_at','to_at','delta','quality','source']),
      ('channel_view_archive_states', ARRAY['chat_id','cursor_at','discovered_from','discovery_complete_at','last_attempt_at','last_success_at',
        'full_refresh_at','stalled_at','observed_post_count','first_observed_at','last_observed_at']),
      ('marketplace_bindings', ARRAY['entity_id','kind','profile','state','statistics_consent','collection_owner','collection_metrics',
        'checked_at','valid_until','lease_until','history_complete','history_anomaly','native_history_checked_at','native_full_checked_at','native_audience_checked_at'])
    ) required(table_name,columns)
    CROSS JOIN LATERAL unnest(required.columns) expected(column_name)
    LEFT JOIN pg_attribute attribute ON attribute.attrelid=to_regclass('public.'||required.table_name)
      AND attribute.attname=expected.column_name AND attribute.attnum>0 AND NOT attribute.attisdropped
    WHERE attribute.attnum IS NULL
  ) THEN
    GRANT SELECT (chat_id,entity_type,participants_count,observed_at,source)
      ON TABLE public.managed_entity_audience_observations TO maxim_audit;
    GRANT SELECT (channel_post_id,baseline_at,observed_at,observed_views,high_water_views,anomaly_at,source)
      ON TABLE public.channel_view_observation_states TO maxim_audit;
    GRANT SELECT (channel_post_id,chat_id,from_at,to_at,delta,quality,source)
      ON TABLE public.channel_view_observed_intervals TO maxim_audit;
    GRANT SELECT (chat_id,cursor_at,discovered_from,discovery_complete_at,last_attempt_at,last_success_at,
      full_refresh_at,stalled_at,observed_post_count,first_observed_at,last_observed_at)
      ON TABLE public.channel_view_archive_states TO maxim_audit;
    GRANT SELECT (entity_id,kind,profile,state,statistics_consent,collection_owner,collection_metrics,
      checked_at,valid_until,lease_until,history_complete,history_anomaly,native_history_checked_at,native_full_checked_at,native_audience_checked_at)
      ON TABLE public.marketplace_bindings TO maxim_audit;
  END IF;
  IF EXISTS (
    WITH required(table_name,columns) AS (VALUES
      ('managed_entity_audience_observations', ARRAY['chat_id','entity_type','participants_count','observed_at','source']),
      ('channel_view_observation_states', ARRAY['channel_post_id','baseline_at','observed_at','observed_views','high_water_views','anomaly_at','source']),
      ('channel_view_observed_intervals', ARRAY['channel_post_id','chat_id','from_at','to_at','delta','quality','source']),
      ('channel_view_archive_states', ARRAY['chat_id','cursor_at','discovered_from','discovery_complete_at','last_attempt_at','last_success_at',
        'full_refresh_at','stalled_at','observed_post_count','first_observed_at','last_observed_at']),
      ('marketplace_bindings', ARRAY['entity_id','kind','profile','state','statistics_consent','collection_owner','collection_metrics',
        'checked_at','valid_until','lease_until','history_complete','history_anomaly','native_history_checked_at','native_full_checked_at','native_audience_checked_at'])
    ), allowed AS (SELECT table_name,unnest(columns) AS column_name FROM required), effective AS (
      SELECT relation.relname AS table_name,attribute.attname AS column_name
      FROM pg_class relation JOIN pg_namespace ns ON ns.oid=relation.relnamespace
      JOIN pg_attribute attribute ON attribute.attrelid=relation.oid
      WHERE ns.nspname='public' AND relation.relname IN (SELECT table_name FROM required)
        AND attribute.attnum>0 AND NOT attribute.attisdropped
        AND has_column_privilege('maxim_audit',relation.oid,attribute.attnum,'SELECT')
    ) SELECT 1 WHERE EXISTS (SELECT * FROM effective EXCEPT SELECT * FROM allowed)
      OR (SELECT count(*) FROM effective) NOT IN (0,45)
      OR EXISTS (SELECT 1 FROM pg_class relation JOIN pg_namespace ns ON ns.oid=relation.relnamespace
        WHERE ns.nspname='public' AND relation.relname IN (SELECT table_name FROM required)
          AND (has_table_privilege('maxim_audit',relation.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
            OR EXISTS (SELECT 1 FROM pg_attribute attribute WHERE attribute.attrelid=relation.oid
              AND attribute.attnum>0 AND NOT attribute.attisdropped
              AND has_column_privilege('maxim_audit',relation.oid,attribute.attnum,'INSERT,UPDATE,REFERENCES'))))
  ) THEN
    RAISE EXCEPTION 'maxim_audit network-statistics observation metadata privileges are not exact';
  END IF;
END
$network_statistics_observation_grants$;
-- FLAG: Membership evidence is an independent eight-column group. A partial
-- schema grants nothing; inherited/private/table/mutation access fails closed.
DO $network_statistics_membership_grants$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM (VALUES
      ('chat_membership_activity_rollups', ARRAY['chat_id','bucket_start','joined_users','left_users','updated_at']),
      ('chat_membership_activity_feed_items', ARRAY['chat_id','event_type','event_at'])
    ) required(table_name,columns) CROSS JOIN LATERAL unnest(required.columns) AS expected(column_name)
    LEFT JOIN pg_attribute attribute ON attribute.attrelid=to_regclass('public.'||required.table_name)
      AND attribute.attname=expected.column_name AND attribute.attnum>0 AND NOT attribute.attisdropped
    WHERE attribute.attnum IS NULL
  ) THEN
    GRANT SELECT (chat_id,bucket_start,joined_users,left_users,updated_at)
      ON TABLE public.chat_membership_activity_rollups TO maxim_audit;
    GRANT SELECT (chat_id,event_type,event_at)
      ON TABLE public.chat_membership_activity_feed_items TO maxim_audit;
  END IF;
  IF EXISTS (
    WITH required(table_name,columns) AS (VALUES
      ('chat_membership_activity_rollups', ARRAY['chat_id','bucket_start','joined_users','left_users','updated_at']),
      ('chat_membership_activity_feed_items', ARRAY['chat_id','event_type','event_at'])
    ), allowed AS (SELECT table_name,unnest(columns) AS column_name FROM required), effective AS (
      SELECT relation.relname AS table_name,attribute.attname AS column_name
      FROM pg_class relation JOIN pg_namespace ns ON ns.oid=relation.relnamespace
      JOIN pg_attribute attribute ON attribute.attrelid=relation.oid
      WHERE ns.nspname='public' AND relation.relname IN (SELECT table_name FROM required)
        AND attribute.attnum>0 AND NOT attribute.attisdropped
        AND has_column_privilege('maxim_audit',relation.oid,attribute.attnum,'SELECT')
    ) SELECT 1 WHERE EXISTS (SELECT * FROM effective EXCEPT SELECT * FROM allowed)
      OR (SELECT count(*) FROM effective) NOT IN (0,8)
      OR EXISTS (SELECT 1 FROM pg_class relation JOIN pg_namespace ns ON ns.oid=relation.relnamespace
        WHERE ns.nspname='public' AND relation.relname IN (SELECT table_name FROM required)
          AND (has_table_privilege('maxim_audit',relation.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
            OR EXISTS (SELECT 1 FROM pg_attribute attribute WHERE attribute.attrelid=relation.oid
              AND attribute.attnum>0 AND NOT attribute.attisdropped
              AND has_column_privilege('maxim_audit',relation.oid,attribute.attnum,'INSERT,UPDATE,REFERENCES'))))
  ) THEN
    RAISE EXCEPTION 'maxim_audit network-statistics membership metadata privileges are not exact';
  END IF;
END
$network_statistics_membership_grants$;
-- FLAG: Existing catalogs remain compatible before the additive review migration. The new
-- mode requires all eight columns; no partial grant or evidence/text access is permitted.
DO $commercial_quality_grants$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM (VALUES ('id'), ('observed_at'), ('expires_at'), ('source'),
      ('independent_label'), ('independent_review_count'), ('review_state'), ('quality_metadata')) required(column_name)
    LEFT JOIN pg_attribute attribute ON attribute.attrelid = to_regclass('public.commercial_review_samples')
      AND attribute.attname = required.column_name AND NOT attribute.attisdropped
    WHERE attribute.attnum IS NULL
  ) THEN
    GRANT SELECT (id, observed_at, expires_at, source, independent_label,
      independent_review_count, review_state, quality_metadata)
      ON TABLE public.commercial_review_samples TO maxim_audit;
  END IF;
END
$commercial_quality_grants$;
-- FLAG: Older/partial catalogs retain zero receipt access. Grant only the complete
-- eight-column metadata group; generic reports do not require this opt-in group.
DO $multibot_preparation_grants$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM (VALUES ('id'), ('migration_name'), ('checksum'), ('started_at'),
      ('finished_at'), ('rolled_back_at'), ('applied_steps_count'), ('logs')) required(column_name)
    LEFT JOIN pg_attribute attribute ON attribute.attrelid = to_regclass('public._prisma_migrations')
      AND attribute.attname = required.column_name AND NOT attribute.attisdropped
    WHERE attribute.attnum IS NULL
  ) THEN
    GRANT SELECT (
      id, migration_name, checksum, started_at, finished_at,
      rolled_back_at, applied_steps_count, logs
    ) ON TABLE public._prisma_migrations TO maxim_audit;
  END IF;
END
$multibot_preparation_grants$;
-- FLAG: The fixed owner-proof report needs both complete column groups. Older schemas
-- get neither; tokens/journal are comparison-only, never report output or write authority.
DO $webhook_owner_proof_grants$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM (VALUES
      ('webhook_execution_claims', ARRAY['id', 'kind', 'semantic_key', 'webhook_event_id',
        'execution_bot_id', 'enforced', 'status', 'prepared_at', 'business_started_at',
        'completed_at', 'lease_token', 'lease_expires_at', 'command_result']),
      ('max_action_ledger', ARRAY['chat_id', 'action_type', 'message_id', 'status', 'ambiguous',
        'terminal', 'attempt_count', 'dispatch_token', 'dispatch_started_at', 'dispatch_bot_id',
        'remote_message_id', 'completed_at'])
    ) required(table_name, columns)
    CROSS JOIN LATERAL unnest(required.columns) expected(column_name)
    LEFT JOIN pg_attribute attribute ON attribute.attrelid = to_regclass('public.' || required.table_name)
      AND attribute.attname = expected.column_name AND attribute.attnum > 0 AND NOT attribute.attisdropped
    WHERE attribute.attnum IS NULL
  ) THEN
    GRANT SELECT (id, kind, semantic_key, webhook_event_id, execution_bot_id, enforced,
      status, prepared_at, business_started_at, completed_at, lease_token, lease_expires_at,
      command_result) ON TABLE public.webhook_execution_claims TO maxim_audit;
    GRANT SELECT (chat_id, action_type, message_id, status, ambiguous, terminal, attempt_count,
      dispatch_token, dispatch_started_at, dispatch_bot_id, remote_message_id, completed_at)
      ON TABLE public.max_action_ledger TO maxim_audit;
  END IF;
END
$webhook_owner_proof_grants$;
-- FLAG: Optional latency access extends, never replaces, the complete owner-proof
-- group. Preserve the complete legacy six on older schemas; the two scalar clocks
-- are a separate complete pair. Only fixed aggregates leave SQL.
DO $action_latency_grants$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM (VALUES
      ('webhook_execution_claims', ARRAY['id', 'kind', 'semantic_key', 'webhook_event_id',
        'execution_bot_id', 'enforced', 'status', 'prepared_at', 'business_started_at',
        'completed_at', 'lease_token', 'lease_expires_at', 'command_result']),
      ('max_action_ledger', ARRAY['chat_id', 'action_type', 'message_id', 'status', 'ambiguous',
        'terminal', 'attempt_count', 'dispatch_token', 'dispatch_started_at', 'dispatch_bot_id',
        'remote_message_id', 'completed_at', 'id', 'source_tag', 'traffic_class',
        'enqueued_at', 'last_attempt_at', 'metadata'])
    ) required(table_name, columns)
    CROSS JOIN LATERAL unnest(required.columns) expected(column_name)
    LEFT JOIN pg_attribute attribute ON attribute.attrelid = to_regclass('public.' || required.table_name)
      AND attribute.attname = expected.column_name AND attribute.attnum > 0 AND NOT attribute.attisdropped
    WHERE attribute.attnum IS NULL
  ) THEN
    GRANT SELECT (id, source_tag, traffic_class, enqueued_at, last_attempt_at, metadata)
      ON TABLE public.max_action_ledger TO maxim_audit;
    IF NOT EXISTS (
      SELECT 1 FROM (VALUES ('scheduled_for_at'), ('schedule_clock_state')) expected(column_name)
      LEFT JOIN pg_attribute attribute ON attribute.attrelid = to_regclass('public.max_action_ledger')
        AND attribute.attname = expected.column_name AND attribute.attnum > 0 AND NOT attribute.attisdropped
      WHERE attribute.attnum IS NULL
    ) THEN
      GRANT SELECT (scheduled_for_at, schedule_clock_state)
        ON TABLE public.max_action_ledger TO maxim_audit;
    END IF;
  END IF;
END
$action_latency_grants$;
-- FLAG: Grant the complete scalar-only group or none. Scope and seal matches are
-- diagnostics; snapshots, attestation JSON and source/effect evidence stay unreadable.
DO $webhook_held_receipt_grants$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM (VALUES
      ('webhook_legacy_recoveries', ARRAY['id', 'chat_id', 'message_id', 'user_id',
        'owner_webhook_event_id', 'certificate_id', 'authority_version', 'disposition']),
      ('webhook_legacy_sealed_authorities', ARRAY['id', 'certificate_id', 'authority_version',
        'source_sha', 'image_id', 'attestation_digest', 'preview_sha256', 'sealed_at']),
      ('webhook_legacy_quiescence_certificates', ARRAY['id', 'authority_version', 'source_sha',
        'image_id', 'attestation_digest', 'preview_sha256', 'quiesced_at', 'sealed_at']),
      ('webhook_source_abandonments', ARRAY['chat_id', 'message_id']),
      ('webhook_backlog_receipts', ARRAY['receipt_id', 'semantic_key'])
    ) required(table_name, columns)
    CROSS JOIN LATERAL unnest(required.columns) expected(column_name)
    LEFT JOIN pg_attribute attribute ON attribute.attrelid = to_regclass('public.' || required.table_name)
      AND attribute.attname = expected.column_name AND attribute.attnum > 0 AND NOT attribute.attisdropped
    WHERE attribute.attnum IS NULL
  ) THEN
    GRANT SELECT (id, chat_id, message_id, user_id, owner_webhook_event_id,
      certificate_id, authority_version, disposition)
      ON TABLE public.webhook_legacy_recoveries TO maxim_audit;
    GRANT SELECT (id, certificate_id, authority_version, source_sha, image_id,
      attestation_digest, preview_sha256, sealed_at)
      ON TABLE public.webhook_legacy_sealed_authorities TO maxim_audit;
    GRANT SELECT (id, authority_version, source_sha, image_id, attestation_digest,
      preview_sha256, quiesced_at, sealed_at)
      ON TABLE public.webhook_legacy_quiescence_certificates TO maxim_audit;
    GRANT SELECT (chat_id, message_id) ON TABLE public.webhook_source_abandonments TO maxim_audit;
    GRANT SELECT (receipt_id, semantic_key) ON TABLE public.webhook_backlog_receipts TO maxim_audit;
  END IF;
END
$webhook_held_receipt_grants$;
GRANT pg_read_all_stats TO maxim_audit;

ALTER ROLE maxim_audit RESET ALL;
ALTER ROLE maxim_audit IN DATABASE maxim RESET ALL;
ALTER ROLE maxim_audit SET default_transaction_read_only = on;
ALTER ROLE maxim_audit SET statement_timeout = '5s';
ALTER ROLE maxim_audit SET lock_timeout = '1s';
ALTER ROLE maxim_audit SET idle_in_transaction_session_timeout = '5s';
ALTER ROLE maxim_audit SET idle_session_timeout = '60s';
ALTER ROLE maxim_audit SET max_parallel_workers_per_gather = 0;
ALTER ROLE maxim_audit SET enable_bitmapscan = off;
ALTER ROLE maxim_audit SET jit = off;
ALTER ROLE maxim_audit SET work_mem = '1MB';
ALTER ROLE maxim_audit SET temp_file_limit = '8MB';

DO $verify$
BEGIN
  IF NOT pg_has_role('maxim_audit', 'pg_read_all_stats', 'member')
    OR pg_has_role('maxim_audit', 'pg_read_all_data', 'member')
    OR NOT has_schema_privilege('maxim_audit', 'public', 'USAGE')
    OR has_schema_privilege('maxim_audit', 'public', 'CREATE')
    OR NOT has_table_privilege('maxim_audit', 'public.webhook_events', 'SELECT')
    OR NOT has_table_privilege('maxim_audit', 'public.moderation_events', 'SELECT')
    OR has_table_privilege('maxim_audit', 'public.chat_settings', 'SELECT')
    OR has_table_privilege('maxim_audit', 'public.moderation_delete_intents', 'SELECT')
    OR has_table_privilege(
      'maxim_audit',
      'public.moderation_delete_intent_reasons',
      'SELECT'
    )
  THEN
    RAISE EXCEPTION 'maxim_audit privilege attestation failed';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_auth_members memberships
    JOIN pg_roles granted_role ON granted_role.oid = memberships.roleid
    JOIN pg_roles member_role ON member_role.oid = memberships.member
    WHERE member_role.rolname = 'maxim_audit'
      AND granted_role.rolname <> 'pg_read_all_stats'
  ) THEN
    RAISE EXCEPTION 'maxim_audit has unexpected role memberships after provisioning';
  END IF;

  -- FLAG: Quarantine evidence is diagnostic only. Retain exact metadata grants.
  IF coalesce(has_table_privilege('maxim_audit', to_regclass('public.webhook_dependency_quarantines'), 'SELECT'), false)
    OR (SELECT count(*) FROM information_schema.role_column_grants
      WHERE grantee = 'maxim_audit' AND table_schema = 'public'
        AND table_name = 'webhook_dependency_quarantines' AND privilege_type = 'SELECT') NOT IN (0, 8)
    OR EXISTS (SELECT 1 FROM pg_attribute attribute
      WHERE attribute.attrelid = to_regclass('public.webhook_dependency_quarantines')
        AND attribute.attnum > 0 AND NOT attribute.attisdropped
        AND has_column_privilege('maxim_audit', attribute.attrelid, attribute.attnum, 'SELECT')
        AND attribute.attname NOT IN ('receipt_id','blocker_id','anchor_id','state','deadline_at','created_at','next_check_at','resolved_at'))
  THEN RAISE EXCEPTION 'maxim_audit quarantine metadata privileges are not exact'; END IF;

  -- FLAG: The original-bot poll report sees only nineteen exact metadata columns.
  IF EXISTS (
    SELECT 1 FROM (VALUES
      ('managed_polls', ARRAY['id','chat_id','status','publication_message_id','publication_bot_id',
        'render_revision','rendered_revision','render_format_version','last_render_error',
        'published_at','closed_at','updated_at']),
      ('chat_bot_memberships', ARRAY['chat_id','bot_id','status','bot_access_state',
        'bot_access_checked_at','bot_access_source','lifecycle_event_at'])
    ) allowed(table_name, columns)
    WHERE has_table_privilege('maxim_audit', to_regclass('public.' || allowed.table_name), 'SELECT')
      OR (
        SELECT count(*) FROM information_schema.role_column_grants grants
        WHERE grants.grantee = 'maxim_audit' AND grants.table_schema = 'public'
          AND grants.table_name = allowed.table_name AND grants.privilege_type = 'SELECT'
      ) NOT IN (0, cardinality(allowed.columns))
      OR EXISTS (
        SELECT 1 FROM pg_attribute attribute
        WHERE attribute.attrelid = to_regclass('public.' || allowed.table_name)
          AND attribute.attnum > 0 AND NOT attribute.attisdropped
          AND has_column_privilege('maxim_audit', attribute.attrelid, attribute.attnum, 'SELECT')
          AND NOT (attribute.attname = ANY(allowed.columns))
      )
  ) THEN RAISE EXCEPTION 'maxim_audit poll metadata privileges are not exact'; END IF;

  IF has_table_privilege('maxim_audit', 'public.chat_rules', 'SELECT')
    OR 10 <> (
      SELECT count(*) FROM information_schema.role_column_grants
      WHERE grantee = 'maxim_audit' AND table_schema = 'public' AND table_name = 'chat_rules'
        AND privilege_type = 'SELECT'
    )
    OR EXISTS (
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
  THEN
    RAISE EXCEPTION 'maxim_audit rules metadata privileges are not exact';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM information_schema.role_table_grants
    WHERE grantee = 'maxim_audit'
      AND NOT (
        table_schema = 'public'
        AND table_name IN ('webhook_events', 'moderation_events')
        AND privilege_type = 'SELECT'
      )
  ) THEN
    RAISE EXCEPTION 'maxim_audit has unexpected direct table privileges';
  END IF;

  IF (
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
  ) NOT IN (40, 48) OR EXISTS (
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
  ) THEN
    RAISE EXCEPTION 'maxim_audit Antiduplicate column privileges are not exact';
  END IF;

  IF EXISTS (
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
  ) THEN
    RAISE EXCEPTION 'maxim_audit has unexpected effective Antiduplicate column privileges';
  END IF;

  -- FLAG: Provisioning must roll back on PUBLIC/inherited excess or mutation grants,
  -- rather than waiting for the first diagnostic to discover an unsafe audit role.
  IF (
    WITH original(table_name, columns) AS (VALUES
      ('webhook_execution_claims', ARRAY['id', 'kind', 'semantic_key', 'webhook_event_id',
        'execution_bot_id', 'enforced', 'status', 'prepared_at', 'business_started_at',
        'completed_at', 'lease_token', 'lease_expires_at', 'command_result']),
      ('max_action_ledger', ARRAY['chat_id', 'action_type', 'message_id', 'status', 'ambiguous',
        'terminal', 'attempt_count', 'dispatch_token', 'dispatch_started_at', 'dispatch_bot_id',
        'remote_message_id', 'completed_at'])
    ), legacy_extension(table_name, column_name) AS (
      SELECT 'max_action_ledger', unnest(ARRAY['id', 'source_tag', 'traffic_class',
        'enqueued_at', 'last_attempt_at', 'metadata'])
    ), schedule_extension(table_name, column_name) AS (
      SELECT 'max_action_ledger', unnest(ARRAY['scheduled_for_at', 'schedule_clock_state'])
    ), original_columns AS (
      SELECT table_name, unnest(columns) AS column_name FROM original
    ), allowed AS (
      SELECT * FROM original_columns UNION ALL SELECT * FROM legacy_extension
      UNION ALL SELECT * FROM schedule_extension
    ),
    relations AS (
      SELECT DISTINCT table_name, to_regclass('public.' || table_name) AS oid FROM allowed
    ), attributes AS MATERIALIZED (
      SELECT r.table_name, r.oid, a.attnum, a.attname,
        has_column_privilege('maxim_audit', r.oid, a.attnum, 'SELECT') AS readable,
        has_column_privilege('maxim_audit', r.oid, a.attnum, 'INSERT,UPDATE,REFERENCES') AS writable
      FROM relations r JOIN pg_attribute a ON a.attrelid = r.oid
      WHERE a.attnum > 0 AND NOT a.attisdropped
    ), counts AS (
      SELECT (SELECT count(*) FROM attributes a JOIN original_columns o
        ON o.table_name=a.table_name AND o.column_name=a.attname WHERE readable) AS original_count,
      (SELECT count(*) FROM attributes a JOIN legacy_extension e
        ON e.table_name=a.table_name AND e.column_name=a.attname WHERE readable) AS legacy_count,
      (SELECT count(*) FROM attributes a JOIN schedule_extension e
        ON e.table_name=a.table_name AND e.column_name=a.attname WHERE readable) AS schedule_count
    )
    SELECT original_count NOT IN (0, 25) OR legacy_count NOT IN (0, 6)
      OR schedule_count NOT IN (0, 2)
      OR (schedule_count > 0 AND legacy_count <> 6)
      OR ((legacy_count > 0 OR schedule_count > 0) AND original_count <> 25)
      OR EXISTS (SELECT 1 FROM relations r WHERE r.oid IS NOT NULL
        AND has_table_privilege('maxim_audit', r.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'))
      OR EXISTS (SELECT 1 FROM attributes a WHERE writable OR (readable AND NOT EXISTS (
        SELECT 1 FROM allowed WHERE table_name=a.table_name AND column_name=a.attname)))
    FROM counts
  ) THEN
    RAISE EXCEPTION 'maxim_audit owner proof column privileges are not exact';
  END IF;

  -- FLAG: Effective PUBLIC/inherited excess and every mutation privilege must fail
  -- provisioning before a held-receipt report can admit the optional scalar group.
  IF (
    WITH allowed(table_name, columns) AS (VALUES
      ('webhook_legacy_recoveries', ARRAY['id', 'chat_id', 'message_id', 'user_id',
        'owner_webhook_event_id', 'certificate_id', 'authority_version', 'disposition']),
      ('webhook_legacy_sealed_authorities', ARRAY['id', 'certificate_id', 'authority_version',
        'source_sha', 'image_id', 'attestation_digest', 'preview_sha256', 'sealed_at']),
      ('webhook_legacy_quiescence_certificates', ARRAY['id', 'authority_version', 'source_sha',
        'image_id', 'attestation_digest', 'preview_sha256', 'quiesced_at', 'sealed_at']),
      ('webhook_source_abandonments', ARRAY['chat_id', 'message_id']),
      ('webhook_backlog_receipts', ARRAY['receipt_id', 'semantic_key'])
    ), relations AS (
      SELECT table_name, columns, to_regclass('public.' || table_name) AS oid FROM allowed
    )
    SELECT
      (SELECT count(*) FROM relations r JOIN pg_attribute a ON a.attrelid = r.oid
        WHERE a.attnum > 0 AND NOT a.attisdropped
          AND has_column_privilege('maxim_audit', r.oid, a.attnum, 'SELECT')) NOT IN (0, 28)
      OR EXISTS (SELECT 1 FROM relations r WHERE r.oid IS NOT NULL
        AND has_table_privilege('maxim_audit', r.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'))
      OR EXISTS (SELECT 1 FROM relations r JOIN pg_attribute a ON a.attrelid = r.oid
        WHERE a.attnum > 0 AND NOT a.attisdropped
          AND (has_column_privilege('maxim_audit', r.oid, a.attnum, 'INSERT,UPDATE,REFERENCES')
            OR (has_column_privilege('maxim_audit', r.oid, a.attnum, 'SELECT')
              AND NOT (a.attname = ANY(r.columns)))))
  ) THEN
    RAISE EXCEPTION 'maxim_audit held receipt column privileges are not exact';
  END IF;

  -- FLAG: Zero or all eight effective receipt SELECTs preserve old catalogs and
  -- reject partial, inherited, PUBLIC, table-level and mutation privileges.
  IF (
    SELECT count(DISTINCT (column_name, privilege_type))
    FROM information_schema.role_column_grants
    WHERE grantee = 'maxim_audit' AND table_schema = 'public'
      AND table_name = '_prisma_migrations'
  ) NOT IN (0, 8) OR EXISTS (
    SELECT 1 FROM information_schema.role_column_grants
    WHERE grantee = 'maxim_audit' AND table_schema = 'public'
      AND table_name = '_prisma_migrations'
      AND (privilege_type <> 'SELECT' OR column_name NOT IN (
        'id', 'migration_name', 'checksum', 'started_at', 'finished_at',
        'rolled_back_at', 'applied_steps_count', 'logs'
      ))
  ) OR (
    SELECT count(*) FROM pg_attribute attribute
    WHERE attribute.attrelid = to_regclass('public._prisma_migrations')
      AND attribute.attnum > 0 AND NOT attribute.attisdropped
      AND has_column_privilege('maxim_audit', attribute.attrelid, attribute.attnum, 'SELECT')
  ) NOT IN (0, 8) OR EXISTS (
    SELECT 1 FROM pg_class relation
    WHERE relation.oid = to_regclass('public._prisma_migrations')
      AND has_table_privilege('maxim_audit', relation.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
  ) OR EXISTS (
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
  ) THEN
    RAISE EXCEPTION 'maxim_audit multibot receipt metadata privileges are not exact';
  END IF;

  IF EXISTS (
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
  ) OR 17 <> (
    SELECT count(*) FROM information_schema.role_column_grants
    WHERE grantee = 'maxim_audit' AND table_schema = 'public'
      AND table_name IN (
        'publisher_entity_bindings', 'publisher_entity_settings',
        'managed_entity_publication_policies'
      ) AND privilege_type = 'SELECT'
  ) THEN
    RAISE EXCEPTION 'maxim_audit Publisher metadata privileges are not exact';
  END IF;

  IF (
    SELECT count(*) FROM information_schema.role_column_grants
    WHERE grantee = 'maxim_audit' AND table_schema = 'public' AND privilege_type = 'SELECT'
      AND table_name IN ('publications', 'publication_schedules', 'publication_occurrences',
        'publication_targets', 'managed_entity_access_edges', 'managed_bot_chat_catalog',
        'managed_broadcast_deliveries', 'managed_broadcasts', 'chats')
  ) NOT IN (43, 74) OR (
    SELECT count(*) FROM (VALUES
      ('publication_occurrences', ARRAY['content_revision_id', 'schedule_revision', 'delivery_deadline_at',
        'dispatch_blocked_at', 'retry_authorized_at', 'retry_expires_at', 'created_at', 'updated_at']),
      ('managed_broadcast_deliveries', ARRAY['id', 'broadcast_id', 'content_revision_id', 'target_chat_id', 'bot_id', 'required_bot_id',
        'dispatch_profile', 'next_attempt_at', 'wait_reason', 'dispatch_blocker_code',
        'locked_at', 'lock_token', 'sent_at', 'last_error_code']),
      ('managed_broadcasts', ARRAY['id', 'publication_occurrence_id', 'publication_content_revision_id',
        'status', 'next_send_at', 'locked_at', 'lock_token', 'dispatch_profile', 'required_bot_id'])
    ) required(table_name, columns)
    CROSS JOIN LATERAL unnest(required.columns) expected(column_name)
    JOIN pg_attribute attribute ON attribute.attrelid = to_regclass('public.' || required.table_name)
      AND attribute.attname = expected.column_name AND attribute.attnum > 0 AND NOT attribute.attisdropped
    WHERE has_column_privilege('maxim_audit', attribute.attrelid, attribute.attnum, 'SELECT')
  ) NOT IN (0, 31) OR EXISTS (
    SELECT 1 FROM pg_class relation
    JOIN pg_namespace ns ON ns.oid = relation.relnamespace
    JOIN pg_attribute attribute ON attribute.attrelid = relation.oid
    WHERE ns.nspname = 'public' AND relation.relname IN (
      'publications', 'publication_schedules', 'publication_occurrences', 'publication_targets',
      'managed_entity_access_edges', 'managed_bot_chat_catalog', 'managed_broadcast_deliveries', 'managed_broadcasts', 'chats')
      AND attribute.attnum > 0 AND NOT attribute.attisdropped
      AND has_column_privilege('maxim_audit', relation.oid, attribute.attnum, 'SELECT')
      AND NOT (
        (relation.relname = 'publications' AND attribute.attname IN
          ('id', 'actor_user_id', 'lifecycle', 'audience_mode', 'audience_selection', 'dispatch_profile', 'required_bot_id'))
        OR (relation.relname = 'publication_schedules' AND attribute.attname IN ('id', 'mode', 'status', 'revision'))
        OR (relation.relname = 'publication_occurrences' AND attribute.attname IN
          ('id', 'publication_id', 'schedule_id', 'status', 'scheduled_at', 'dispatch_profile', 'required_bot_id', 'dispatch_blocker_code',
           'content_revision_id', 'schedule_revision', 'delivery_deadline_at', 'dispatch_blocked_at', 'retry_authorized_at', 'retry_expires_at', 'created_at', 'updated_at'))
        OR (relation.relname = 'publication_targets' AND attribute.attname IN
          ('publication_id', 'target_chat_id', 'entity_type', 'position'))
        OR (relation.relname = 'managed_entity_access_edges' AND attribute.attname IN
          ('chat_id', 'user_id', 'bot_id', 'state', 'user_role', 'entity_type', 'checked_at', 'expires_at', 'denied_reason'))
        OR (relation.relname = 'managed_bot_chat_catalog' AND attribute.attname IN ('bot_id', 'chat_id', 'status', 'entity_type'))
        OR (relation.relname = 'managed_broadcast_deliveries' AND attribute.attname IN
          ('publication_occurrence_id', 'created_at', 'status', 'attempt_count', 'remote_message_id',
           'id', 'broadcast_id', 'content_revision_id', 'target_chat_id', 'bot_id', 'required_bot_id', 'dispatch_profile', 'next_attempt_at',
           'wait_reason', 'dispatch_blocker_code', 'locked_at', 'lock_token', 'sent_at', 'last_error_code'))
        OR (relation.relname = 'managed_broadcasts' AND attribute.attname IN
          ('id', 'publication_occurrence_id', 'publication_content_revision_id', 'status', 'next_send_at',
           'locked_at', 'lock_token', 'dispatch_profile', 'required_bot_id'))
        OR (relation.relname = 'chats' AND attribute.attname IN ('id', 'entity_type'))
      )
  ) THEN
    RAISE EXCEPTION 'maxim_audit publication metadata privileges are not exact';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_attribute attribute
    WHERE attribute.attrelid = to_regclass('public.commercial_review_samples')
      AND attribute.attnum > 0 AND NOT attribute.attisdropped
      AND has_column_privilege('maxim_audit', attribute.attrelid, attribute.attnum, 'SELECT')
      AND attribute.attname NOT IN ('id', 'observed_at', 'expires_at', 'source',
        'independent_label', 'independent_review_count', 'review_state', 'quality_metadata')
  ) OR (SELECT count(*) FROM information_schema.role_column_grants
    WHERE grantee = 'maxim_audit' AND table_schema = 'public'
      AND table_name = 'commercial_review_samples' AND privilege_type = 'SELECT') NOT IN (0, 8)
  THEN
    RAISE EXCEPTION 'maxim_audit commercial-review metadata privileges are not exact';
  END IF;

  -- FLAG: This opt-in group is zero or all fifteen metadata SELECTs. Table-level,
  -- inherited/public overgrants and any mutation privilege fail provisioning.
  IF EXISTS (
    WITH allowed(table_name,column_name) AS (VALUES
      ('channel_audience_snapshots','chat_id'),('channel_audience_snapshots','participants_count'),('channel_audience_snapshots','captured_at'),
      ('channel_stats_sync_states','chat_id'),('channel_stats_sync_states','membership_coverage_from'),('channel_stats_sync_states','views_coverage_from'),
      ('channel_stats_sync_states','last_audience_sync_at'),('channel_stats_sync_states','last_views_sync_at'),('channel_stats_sync_states','last_views_discovery_at'),
      ('channel_posts','id'),('channel_posts','chat_id'),('channel_posts','published_at'),('channel_posts','latest_snapshot_at'),
      ('channel_post_view_snapshots','channel_post_id'),('channel_post_view_snapshots','captured_at')
    ), effective AS (
      SELECT relation.relname AS table_name,attribute.attname AS column_name
      FROM pg_class relation JOIN pg_namespace ns ON ns.oid=relation.relnamespace
      JOIN pg_attribute attribute ON attribute.attrelid=relation.oid
      WHERE ns.nspname='public' AND relation.relname IN (SELECT table_name FROM allowed)
        AND attribute.attnum>0 AND NOT attribute.attisdropped
        AND has_column_privilege('maxim_audit',relation.oid,attribute.attnum,'SELECT')
    ) SELECT 1 WHERE EXISTS (SELECT * FROM effective EXCEPT SELECT * FROM allowed)
      OR (SELECT count(*) FROM effective) NOT IN (0,15)
      OR EXISTS (SELECT 1 FROM pg_class relation JOIN pg_namespace ns ON ns.oid=relation.relnamespace
        WHERE ns.nspname='public' AND relation.relname IN (SELECT table_name FROM allowed)
          AND (has_table_privilege('maxim_audit',relation.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
            OR EXISTS (SELECT 1 FROM pg_attribute attribute WHERE attribute.attrelid=relation.oid
              AND attribute.attnum>0 AND NOT attribute.attisdropped
              AND has_column_privilege('maxim_audit',relation.oid,attribute.attnum,'INSERT,UPDATE,REFERENCES'))))
  ) THEN
    RAISE EXCEPTION 'maxim_audit network-statistics metadata privileges are not exact';
  END IF;

  IF EXISTS (
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
  ) THEN
    RAISE EXCEPTION 'maxim_audit has unexpected effective user-relation privileges';
  END IF;
END
$verify$;

COMMIT;
SQL

echo 'PostgreSQL audit role is provisioned with bounded read-only defaults.'
