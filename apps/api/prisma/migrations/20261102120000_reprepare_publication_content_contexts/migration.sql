-- FLAG: A frozen content change invalidates the prepared keyboard in the same bulk UPDATE.
-- No retained row is backfilled or scanned. v0 remains intent and cannot be claimed for SEND.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

CREATE FUNCTION "is_reprepared_publisher_context"(context JSONB, expected_bot TEXT, expected_chat TEXT)
RETURNS BOOLEAN LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $$
  SELECT COALESCE(
    public."is_pending_publisher_dialog_context"(context, expected_bot, expected_chat)
    AND context->'preparationRevision' = '2'::jsonb
    AND jsonb_typeof(context->'contentRevisionId') = 'string'
    AND length(context->>'contentRevisionId') > 0
    AND (
      (NOT context ? 'retryAuthorizedAtMs' AND NOT context ? 'retryExpiresAtMs')
      OR (jsonb_typeof(context->'retryAuthorizedAtMs') = 'number'
        AND jsonb_typeof(context->'retryExpiresAtMs') = 'number'
        AND context->>'retryAuthorizedAtMs' ~ '^[0-9]{1,16}$'
        AND context->>'retryExpiresAtMs' ~ '^[0-9]{1,16}$'
        AND (context->>'retryAuthorizedAtMs')::numeric > 0
        AND (context->>'retryExpiresAtMs')::numeric > (context->>'retryAuthorizedAtMs')::numeric
        AND (context->>'retryExpiresAtMs')::numeric <= 9007199254740991)
    ), false);
$$;

CREATE FUNCTION "is_current_reprepared_publisher_context"(
  context JSONB, occurrence_id TEXT, content_id TEXT, expected_bot TEXT, expected_chat TEXT,
  require_retry BOOLEAN
) RETURNS BOOLEAN LANGUAGE sql STABLE SET search_path = pg_catalog AS $$
  SELECT public."is_reprepared_publisher_context"(context, expected_bot, expected_chat)
    AND context->>'contentRevisionId' = content_id
    AND EXISTS (
      SELECT 1 FROM public."publication_occurrences" occurrence
      JOIN public."publication_schedules" schedule ON schedule."id" = occurrence."schedule_id"
      JOIN public."publications" publication ON publication."id" = occurrence."publication_id"
      JOIN public."publication_content_revisions" content ON content."id" = content_id
        AND content."publication_id" = publication."id"
      WHERE occurrence."id" = occurrence_id
        AND occurrence."content_revision_id" = content_id
        AND occurrence."dispatch_profile" = 'PUBLIK_V1'
        AND occurrence."required_bot_id" = expected_bot
        AND occurrence."status" IN ('SCHEDULED', 'IN_PROGRESS')
        AND schedule."status" = 'ACTIVE'
        AND schedule."revision" = occurrence."schedule_revision"
        AND publication."lifecycle" = 'ACTIVE'
        AND publication."dispatch_profile" = 'PUBLIK_V1'
        AND publication."required_bot_id" = expected_bot
        AND context->'customButtons' = content."buttons"
        AND EXISTS (SELECT 1 FROM public."publication_targets" target
          WHERE target."publication_id" = publication."id"
            AND target."target_chat_id" = expected_chat AND target."canceled_at" IS NULL)
        AND (CASE WHEN require_retry OR context ? 'retryAuthorizedAtMs' THEN
          occurrence."retry_authorized_at" <= statement_timestamp() AT TIME ZONE 'UTC'
          AND occurrence."retry_expires_at" > statement_timestamp() AT TIME ZONE 'UTC'
          AND occurrence."retry_expires_at" > occurrence."retry_authorized_at"
          AND to_jsonb((extract(epoch FROM occurrence."retry_authorized_at") * 1000)::bigint)
            = context->'retryAuthorizedAtMs'
          AND to_jsonb((extract(epoch FROM occurrence."retry_expires_at") * 1000)::bigint)
            = context->'retryExpiresAtMs'
        ELSE true END)
    );
$$;

-- FLAG: This durable constraint is structural. An expired retry must remain cancellable;
-- live author/schedule/retry authority belongs to the transition trigger and worker CAS.
ALTER TABLE "managed_broadcast_deliveries"
  ADD CONSTRAINT "managed_broadcast_deliveries_reprepared_context_check" CHECK (
    ("dispatch_profile" = 'LEGACY_ROUTED' AND "publisher_dialog_context" IS NULL)
    OR ("dispatch_profile" = 'PUBLIK_V1' AND (
      COALESCE("is_valid_publisher_dialog_context"("publisher_dialog_context", "dialog_bot_id"), false)
      OR ("status" IN ('PENDING', 'FAILED', 'CANCELED')
        AND "remote_message_id" IS NULL AND "sent_at" IS NULL AND NOT "legacy_sent_without_remote_id"
        AND "is_pending_publisher_dialog_context"("publisher_dialog_context", "dialog_bot_id", "target_chat_id")
        AND ("attempt_count" = 0 OR ("attempt_count" > 0
          AND "locked_at" IS NULL AND "lock_token" IS NULL
          AND "remote_message_verified_at" IS NULL
          AND "remote_message_verification_attempted_at" IS NULL
          AND "remote_message_verification_attempt_count" = 0
          AND "remote_message_verification_absent_count" = 0
          AND "remote_message_verification_present_count" = 0
          AND "remote_message_verification_next_at" IS NULL
          AND "remote_message_verification_source" IS NULL
          AND "remote_message_verification_last_error" IS NULL
          AND "post_actions_token" IS NULL
          AND "is_reprepared_publisher_context"("publisher_dialog_context", "dialog_bot_id", "target_chat_id")
          AND "publisher_dialog_context" ? 'retryAuthorizedAtMs'
          AND "publisher_dialog_context"->>'contentRevisionId' = "content_revision_id"))
      )
    ))
  ) NOT VALID;

CREATE OR REPLACE FUNCTION "guard_publisher_delivery_route"()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE
  intent RECORD;
  rebound BOOLEAN := false;
  retry_intent BOOLEAN;
  clean_new BOOLEAN;
  clean_old BOOLEAN;
BEGIN
  IF NEW."broadcast_id" IS DISTINCT FROM OLD."broadcast_id"
    OR NEW."publication_occurrence_id" IS DISTINCT FROM OLD."publication_occurrence_id"
    OR NEW."dispatch_profile" IS DISTINCT FROM OLD."dispatch_profile"
    OR NEW."required_bot_id" IS DISTINCT FROM OLD."required_bot_id"
    OR NEW."dialog_bot_id" IS DISTINCT FROM OLD."dialog_bot_id"
    OR NEW."publication_policy_revision" IS DISTINCT FROM OLD."publication_policy_revision"
  THEN
    RAISE EXCEPTION 'publication delivery route is immutable'
      USING ERRCODE = '23514', CONSTRAINT = 'managed_broadcast_deliveries_publisher_route_immutable';
  END IF;

  clean_new := NEW."remote_message_id" IS NULL AND NEW."sent_at" IS NULL
    AND NOT NEW."legacy_sent_without_remote_id"
    AND NEW."locked_at" IS NULL AND NEW."lock_token" IS NULL
    AND NEW."remote_message_verified_at" IS NULL
    AND NEW."remote_message_verification_attempted_at" IS NULL
    AND NEW."remote_message_verification_attempt_count" = 0
    AND NEW."remote_message_verification_absent_count" = 0
    AND NEW."remote_message_verification_present_count" = 0
    AND NEW."remote_message_verification_next_at" IS NULL
    AND NEW."remote_message_verification_source" IS NULL
    AND NEW."remote_message_verification_last_error" IS NULL
    AND NEW."post_actions_token" IS NULL;
  clean_old := OLD."remote_message_id" IS NULL AND OLD."sent_at" IS NULL
    AND NOT OLD."legacy_sent_without_remote_id"
    AND OLD."locked_at" IS NULL AND OLD."lock_token" IS NULL
    AND OLD."remote_message_verified_at" IS NULL
    AND OLD."remote_message_verification_attempted_at" IS NULL
    AND OLD."remote_message_verification_attempt_count" = 0
    AND OLD."remote_message_verification_absent_count" = 0
    AND OLD."remote_message_verification_present_count" = 0
    AND OLD."remote_message_verification_next_at" IS NULL
    AND OLD."remote_message_verification_source" IS NULL
    AND OLD."remote_message_verification_last_error" IS NULL
    AND OLD."post_actions_token" IS NULL;

  IF OLD."dispatch_profile" = 'PUBLIK_V1' AND NEW."status" = 'PENDING'
    AND NEW."content_revision_id" IS NOT NULL
    AND (NEW."content_revision_id" IS DISTINCT FROM OLD."content_revision_id"
      OR (OLD."publisher_dialog_context"->'version' = '0'::jsonb
        AND OLD."publisher_dialog_context"->'preparationRevision' = '2'::jsonb
        AND OLD."status" = 'FAILED'
        AND NEW."publisher_dialog_context" IS NOT DISTINCT FROM OLD."publisher_dialog_context"))
  THEN
    SELECT occurrence."status", occurrence."retry_authorized_at", occurrence."retry_expires_at",
      lower(broadcast."entity_type"::text) AS entity_type, content."buttons"
    INTO intent
    FROM public."publication_occurrences" occurrence
    JOIN public."publication_content_revisions" content ON content."id" = NEW."content_revision_id"
      AND content."publication_id" = occurrence."publication_id"
    JOIN public."managed_broadcasts" broadcast ON broadcast."id" = NEW."broadcast_id"
    WHERE occurrence."id" = NEW."publication_occurrence_id"
      AND occurrence."content_revision_id" = NEW."content_revision_id";
    retry_intent := OLD."status" = 'FAILED' OR intent."status" = 'IN_PROGRESS';
    -- FLAG: An exact human mark_failed is the reviewed exception to old receipt presence.
    -- Automated absence/AMBIGUOUS/SENT never become proof of a safe new publication effect.
    IF NOT FOUND OR NOT clean_new OR NEW."attempt_count" <> OLD."attempt_count"
      OR NEW."target_chat_id" <> OLD."target_chat_id"
      OR NOT COALESCE((OLD."status" = 'PENDING' AND OLD."attempt_count" = 0 AND clean_old)
        OR (OLD."status" = 'FAILED' AND (clean_old
          OR OLD."last_error" = 'Администратор подтвердил, что сообщение не было опубликовано.')), false)
    THEN
      RAISE EXCEPTION 'publication content preparation is not safely retryable'
        USING ERRCODE = '23514', CONSTRAINT = 'managed_broadcast_deliveries_publisher_route_immutable';
    END IF;
    NEW."publisher_dialog_context" := jsonb_build_object(
      'version', 0, 'preparation', 'pending', 'preparationRevision', 2,
      'chatId', NEW."target_chat_id", 'entityType', intent."entity_type",
      'dialogBotId', NEW."required_bot_id", 'contentRevisionId', NEW."content_revision_id",
      'customButtons', intent."buttons"
    ) || CASE WHEN retry_intent THEN jsonb_build_object(
      'retryAuthorizedAtMs', (extract(epoch FROM intent."retry_authorized_at") * 1000)::bigint,
      'retryExpiresAtMs', (extract(epoch FROM intent."retry_expires_at") * 1000)::bigint
    ) ELSE '{}'::jsonb END;
    IF NOT COALESCE(public."is_current_reprepared_publisher_context"(
      NEW."publisher_dialog_context", NEW."publication_occurrence_id", NEW."content_revision_id",
      NEW."required_bot_id", NEW."target_chat_id", retry_intent), false)
    THEN
      RAISE EXCEPTION 'publication content preparation authority changed'
        USING ERRCODE = '23514', CONSTRAINT = 'managed_broadcast_deliveries_publisher_route_immutable';
    END IF;
    rebound := true;
  END IF;

  IF NEW."publisher_dialog_context" IS DISTINCT FROM OLD."publisher_dialog_context" AND NOT rebound
    AND NOT (
      OLD."dispatch_profile" = 'PUBLIK_V1'
      AND OLD."status" = 'PENDING' AND NEW."status" = 'PENDING'
      AND NEW."attempt_count" = OLD."attempt_count" AND clean_old AND clean_new
      AND NEW."target_chat_id" = OLD."target_chat_id"
      AND NEW."content_revision_id" IS NOT DISTINCT FROM OLD."content_revision_id"
      AND public."is_pending_publisher_dialog_context"(OLD."publisher_dialog_context", OLD."dialog_bot_id", OLD."target_chat_id")
      AND COALESCE(public."is_valid_publisher_dialog_context"(NEW."publisher_dialog_context", NEW."dialog_bot_id"), false)
      AND (CASE WHEN OLD."publisher_dialog_context" ? 'preparationRevision' THEN
        COALESCE(public."is_current_reprepared_publisher_context"(
          OLD."publisher_dialog_context", OLD."publication_occurrence_id", OLD."content_revision_id",
          OLD."required_bot_id", OLD."target_chat_id", OLD."attempt_count" > 0), false)
        ELSE OLD."attempt_count" = 0 END)
    )
  THEN
    RAISE EXCEPTION 'publication delivery route is immutable'
      USING ERRCODE = '23514', CONSTRAINT = 'managed_broadcast_deliveries_publisher_route_immutable';
  END IF;
  RETURN NEW;
END;
$$;

-- FLAG: Include the existing bulk content writes; trigger-side invalidation is atomic per row.
DROP TRIGGER "managed_broadcast_deliveries_publisher_route_immutable" ON "managed_broadcast_deliveries";
CREATE TRIGGER "managed_broadcast_deliveries_publisher_route_immutable"
BEFORE UPDATE OF "broadcast_id", "publication_occurrence_id", "dispatch_profile", "required_bot_id",
  "dialog_bot_id", "publisher_dialog_context", "publication_policy_revision", "content_revision_id"
ON "managed_broadcast_deliveries" FOR EACH ROW EXECUTE FUNCTION "guard_publisher_delivery_route"();
ALTER TABLE "managed_broadcast_deliveries"
  DROP CONSTRAINT "managed_broadcast_deliveries_prepared_context_check";
ALTER TABLE "managed_broadcast_deliveries"
  RENAME CONSTRAINT "managed_broadcast_deliveries_reprepared_context_check"
  TO "managed_broadcast_deliveries_prepared_context_check";
COMMIT;
