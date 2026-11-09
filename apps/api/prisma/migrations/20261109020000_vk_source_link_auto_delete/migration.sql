ALTER TABLE "vk_parsing_settings"
  ADD COLUMN "source_link_enabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "source_link_url" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "delete_after_minutes" INTEGER;
ALTER TABLE "vk_parsing_settings" ADD CONSTRAINT "vk_parsing_settings_delete_delay_check"
  CHECK ("delete_after_minutes" BETWEEN 1 AND 43200) NOT VALID;
ALTER TABLE "vk_parsing_posts" ADD COLUMN "auto_delete_at" TIMESTAMP(3);

-- Timer candidates stay separate from deletion intents and retained history.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "vk_parsing_posts_auto_delete_due_idx"
  ON "vk_parsing_posts" ("owner_bot_id", "auto_delete_at", "id")
  WHERE "owner_profile" = 'PUBLISHER' AND "dispatch_profile" = 'PUBLIK_V1'
    AND "auto_delete_at" IS NOT NULL
    AND "rollback_queued_at" IS NULL AND "rollback_deleted_at" IS NULL;
