BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

CREATE TABLE public."chat_admin_roster_states" (
  "chat_id" TEXT NOT NULL,
  "revision" UUID NOT NULL DEFAULT pg_catalog.gen_random_uuid(),
  "complete_probe_started_at" TIMESTAMP(3),
  "completed_at" TIMESTAMP(3),
  "refresh_requested_at" TIMESTAMP(3),
  CONSTRAINT "chat_admin_roster_states_pkey" PRIMARY KEY ("chat_id"),
  CONSTRAINT "chat_admin_roster_states_chat_id_fkey"
    FOREIGN KEY ("chat_id") REFERENCES public."chats" ("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);

-- FLAG: Old runtime and raw SQL writers also invalidate the saved protection proof.
-- A targeted allowlist change never fabricates a complete administrator observation.
CREATE FUNCTION public."refresh_chat_admin_roster_revision"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW."chat_id" IS NOT DISTINCT FROM OLD."chat_id"
    AND NEW."user_id" IS NOT DISTINCT FROM OLD."user_id" THEN
    RETURN NULL;
  END IF;

  IF TG_OP <> 'INSERT' THEN
    -- FLAG: Parent deletion cascades must not recreate a child after its chat disappears.
    INSERT INTO public."chat_admin_roster_states" ("chat_id", "revision")
    SELECT "id", pg_catalog.gen_random_uuid() FROM public."chats" WHERE "id" = OLD."chat_id"
    ON CONFLICT ("chat_id") DO UPDATE SET "revision" = EXCLUDED."revision";
  END IF;
  IF TG_OP <> 'DELETE' THEN
    INSERT INTO public."chat_admin_roster_states" ("chat_id", "revision")
    SELECT "id", pg_catalog.gen_random_uuid() FROM public."chats" WHERE "id" = NEW."chat_id"
    ON CONFLICT ("chat_id") DO UPDATE SET "revision" = EXCLUDED."revision";
  END IF;
  RETURN NULL;
END;
$$;

CREATE TRIGGER "chat_admin_roster_revision_trigger"
AFTER INSERT OR UPDATE OR DELETE ON public."chat_admin_allowlist"
FOR EACH ROW EXECUTE FUNCTION public."refresh_chat_admin_roster_revision"();

COMMIT;
