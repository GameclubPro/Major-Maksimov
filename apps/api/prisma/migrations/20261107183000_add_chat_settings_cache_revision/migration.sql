BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

CREATE TABLE public."chat_settings_cache_revisions" (
  "chat_id" TEXT NOT NULL,
  "revision" UUID NOT NULL,
  CONSTRAINT "chat_settings_cache_revisions_pkey" PRIMARY KEY ("chat_id"),
  CONSTRAINT "chat_settings_cache_revisions_chat_id_fkey"
    FOREIGN KEY ("chat_id") REFERENCES public."chat_settings" ("chat_id")
    ON DELETE CASCADE ON UPDATE CASCADE
);

-- FLAG: Every settings writer changes the cached-content proof, including old runtime
-- and raw SQL writers. Existing unchanged settings deliberately have no metadata row.
CREATE FUNCTION public."refresh_chat_settings_cache_revision"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW."chat_id" IS DISTINCT FROM OLD."chat_id" THEN
      -- FLAG: Move before upsert so correctness does not depend on the order of
      -- this trigger and PostgreSQL's internal ON UPDATE CASCADE trigger.
      UPDATE public."chat_settings_cache_revisions"
      SET "chat_id" = NEW."chat_id"
      WHERE "chat_id" = OLD."chat_id";
    END IF;
  END IF;

  INSERT INTO public."chat_settings_cache_revisions" ("chat_id", "revision")
  VALUES (NEW."chat_id", pg_catalog.gen_random_uuid())
  ON CONFLICT ("chat_id") DO UPDATE
  SET "revision" = EXCLUDED."revision";
  RETURN NULL;
END;
$$;

CREATE TRIGGER "chat_settings_cache_revision_trigger"
AFTER INSERT OR UPDATE ON public."chat_settings"
FOR EACH ROW EXECUTE FUNCTION public."refresh_chat_settings_cache_revision"();

COMMIT;
