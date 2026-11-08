-- FLAG: Build outside a transaction; bound waiting and preserve online writers.
SET lock_timeout = '5s';
SET statement_timeout = '10min';
CREATE INDEX CONCURRENTLY "managed_polls_render_due_v7_idx"
ON "managed_polls" ((CASE
  WHEN "render_retry_at" IS NOT NULL
    AND "render_retry_message_id" IS NOT DISTINCT FROM "publication_message_id"
    AND "render_retry_bot_id" IS NOT DISTINCT FROM "publication_bot_id"
    THEN "render_retry_at"
  WHEN "render_retry_at" IS NULL AND "last_render_error" IS NOT NULL
    THEN "updated_at" + INTERVAL '5 minutes'
  ELSE "updated_at"
END), "updated_at", "id")
WHERE "publication_message_id" IS NOT NULL
  AND ("rendered_revision" < "render_revision"
       OR "render_format_version" < 7
       OR "last_render_error" IS NOT NULL);
RESET statement_timeout;
RESET lock_timeout;
