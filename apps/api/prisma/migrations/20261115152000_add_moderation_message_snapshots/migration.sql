CREATE TABLE "moderation_message_snapshots" (
  "reason_id" TEXT NOT NULL,
  "content" JSONB,
  "source_at" TIMESTAMP(3) NOT NULL,
  "expires_at" TIMESTAMP(3) NOT NULL,
  "purged_at" TIMESTAMP(3),
  CONSTRAINT "moderation_message_snapshots_pkey" PRIMARY KEY ("reason_id"),
  CONSTRAINT "moderation_message_snapshots_reason_id_fkey" FOREIGN KEY ("reason_id")
    REFERENCES "moderation_delete_intent_reasons"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "moderation_message_snapshots_purge_idx"
  ON "moderation_message_snapshots"("purged_at", "expires_at", "reason_id");
