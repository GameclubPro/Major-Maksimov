BEGIN;

ALTER TABLE "chat_settings" ADD COLUMN "link_rules_policy" JSONB;

-- FLAG: Every JSON policy change starts a new recovery baseline; equal JSONB is a no-op.
CREATE OR REPLACE FUNCTION "set_link_policy_recovery_baseline"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  active_policy BOOLEAN;
BEGIN
  active_policy := CASE
    WHEN NEW."link_rules_policy" IS NULL THEN NEW."link_policy" IN (
      CAST('ALLOWLIST_ONLY' AS "LinkPolicy"), CAST('BLOCKLIST_ONLY' AS "LinkPolicy")
    )
    ELSE jsonb_typeof(NEW."link_rules_policy") = 'object'
      AND NEW."link_rules_policy"->'version' = '1'::jsonb
      AND jsonb_typeof(NEW."link_rules_policy"->'rules') = 'array'
      AND NEW."link_rules_policy"->>'mode' IN ('DENY_SELECTED', 'ALLOW_SELECTED', 'DENY_ALL')
  END;

  IF TG_OP = 'INSERT' THEN
    IF active_policy THEN
      NEW."link_policy_revision" := GREATEST(NEW."link_policy_revision", 1);
      NEW."link_policy_effective_at" := COALESCE(NEW."link_policy_effective_at", CURRENT_TIMESTAMP);
    ELSE
      NEW."link_policy_effective_at" := NULL;
    END IF;
    RETURN NEW;
  END IF;

  IF NEW."link_rules_policy" IS DISTINCT FROM OLD."link_rules_policy"
     OR (NEW."link_rules_policy" IS NULL AND NEW."link_policy" IS DISTINCT FROM OLD."link_policy") THEN
    NEW."link_policy_revision" := OLD."link_policy_revision" + 1;
    NEW."link_policy_effective_at" := CASE WHEN active_policy THEN CURRENT_TIMESTAMP ELSE NULL END;
  ELSIF NEW."link_policy_revision" > OLD."link_policy_revision" THEN
    NEW."link_policy_revision" := OLD."link_policy_revision" + 1;
    NEW."link_policy_effective_at" := CASE
      WHEN active_policy THEN COALESCE(NEW."link_policy_effective_at", CURRENT_TIMESTAMP)
      ELSE NULL
    END;
  ELSE
    NEW."link_policy_revision" := OLD."link_policy_revision";
    NEW."link_policy_effective_at" := OLD."link_policy_effective_at";
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER "chat_settings_link_policy_recovery_baseline" ON "chat_settings";
CREATE TRIGGER "chat_settings_link_policy_recovery_baseline"
BEFORE INSERT OR UPDATE OF "link_policy", "link_rules_policy", "link_policy_revision", "link_policy_effective_at"
ON "chat_settings" FOR EACH ROW EXECUTE FUNCTION "set_link_policy_recovery_baseline"();

-- FLAG: A retired allowlist cannot change the recovery authority of an adopted JSON policy.
CREATE OR REPLACE FUNCTION "bump_link_policy_recovery_baseline_for_allowlist"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  affected_chat_id TEXT;
  previous_chat_id TEXT;
BEGIN
  IF TG_OP = 'DELETE' THEN affected_chat_id := OLD."chat_id";
  ELSE affected_chat_id := NEW."chat_id";
  END IF;
  IF TG_OP = 'UPDATE' AND NEW."chat_id" IS DISTINCT FROM OLD."chat_id" THEN previous_chat_id := OLD."chat_id";
  END IF;
  UPDATE "chat_settings"
  SET "link_policy_revision" = "link_policy_revision" + 1,
      "link_policy_effective_at" = CURRENT_TIMESTAMP
  WHERE "link_rules_policy" IS NULL
    AND "link_policy" = CAST('ALLOWLIST_ONLY' AS "LinkPolicy")
    AND ("chat_id" = affected_chat_id OR "chat_id" = previous_chat_id);
  RETURN NULL;
END;
$$;

COMMIT;
