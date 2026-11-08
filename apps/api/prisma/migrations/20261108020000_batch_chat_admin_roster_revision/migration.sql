BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

-- FLAG: Replace the row trigger atomically; legacy/raw writers retain revision invalidation.
DROP TRIGGER "chat_admin_roster_revision_trigger" ON public."chat_admin_allowlist";
DROP FUNCTION public."refresh_chat_admin_roster_revision"();

CREATE FUNCTION public."refresh_chat_admin_roster_revision_insert"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  -- FLAG: Deduplicate chat IDs before UUID generation; parent cascades must not recreate state.
  INSERT INTO public."chat_admin_roster_states" ("chat_id", "revision")
  SELECT affected."chat_id", pg_catalog.gen_random_uuid()
  FROM (SELECT DISTINCT "chat_id" FROM new_admin_rows) AS affected
  JOIN public."chats" AS chat ON chat."id" = affected."chat_id"
  ORDER BY affected."chat_id"
  ON CONFLICT ("chat_id") DO UPDATE SET "revision" = EXCLUDED."revision";
  RETURN NULL;
END;
$$;

CREATE FUNCTION public."refresh_chat_admin_roster_revision_delete"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  INSERT INTO public."chat_admin_roster_states" ("chat_id", "revision")
  SELECT affected."chat_id", pg_catalog.gen_random_uuid()
  FROM (SELECT DISTINCT "chat_id" FROM old_admin_rows) AS affected
  JOIN public."chats" AS chat ON chat."id" = affected."chat_id"
  ORDER BY affected."chat_id"
  ON CONFLICT ("chat_id") DO UPDATE SET "revision" = EXCLUDED."revision";
  RETURN NULL;
END;
$$;

CREATE FUNCTION public."refresh_chat_admin_roster_revision_update"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  -- FLAG: Only a changed membership set invalidates proof; timestamps/no-op updates preserve it.
  INSERT INTO public."chat_admin_roster_states" ("chat_id", "revision")
  SELECT affected."chat_id", pg_catalog.gen_random_uuid()
  FROM (
    SELECT DISTINCT "chat_id" FROM (
      (SELECT "chat_id", "user_id" FROM new_admin_rows
       EXCEPT SELECT "chat_id", "user_id" FROM old_admin_rows)
      UNION
      (SELECT "chat_id", "user_id" FROM old_admin_rows
       EXCEPT SELECT "chat_id", "user_id" FROM new_admin_rows)
    ) AS changed
  ) AS affected
  JOIN public."chats" AS chat ON chat."id" = affected."chat_id"
  ORDER BY affected."chat_id"
  ON CONFLICT ("chat_id") DO UPDATE SET "revision" = EXCLUDED."revision";
  RETURN NULL;
END;
$$;

CREATE TRIGGER "chat_admin_roster_revision_insert"
AFTER INSERT ON public."chat_admin_allowlist"
REFERENCING NEW TABLE AS new_admin_rows
FOR EACH STATEMENT EXECUTE FUNCTION public."refresh_chat_admin_roster_revision_insert"();

CREATE TRIGGER "chat_admin_roster_revision_delete"
AFTER DELETE ON public."chat_admin_allowlist"
REFERENCING OLD TABLE AS old_admin_rows
FOR EACH STATEMENT EXECUTE FUNCTION public."refresh_chat_admin_roster_revision_delete"();

CREATE TRIGGER "chat_admin_roster_revision_update"
AFTER UPDATE ON public."chat_admin_allowlist"
REFERENCING OLD TABLE AS old_admin_rows NEW TABLE AS new_admin_rows
FOR EACH STATEMENT EXECUTE FUNCTION public."refresh_chat_admin_roster_revision_update"();

COMMIT;
