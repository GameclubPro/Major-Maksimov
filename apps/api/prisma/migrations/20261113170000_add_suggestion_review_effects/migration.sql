-- Additive journal. Existing suggestions remain authoritative and start at content revision zero.
CREATE TABLE "suggestion_review_effects" (
  "id" TEXT NOT NULL,
  "suggestion_id" TEXT NOT NULL,
  "profile" TEXT NOT NULL,
  "bot_id" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "revision" INTEGER NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "payload" JSONB NOT NULL,
  "next_attempt_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "locked_at" TIMESTAMP(3),
  "lock_token" TEXT,
  "attempted_at" TIMESTAMP(3),
  "remote_message_id" TEXT,
  "last_error" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "suggestion_review_effects_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "suggestion_review_effects_suggestion_id_fkey" FOREIGN KEY ("suggestion_id") REFERENCES "audit_logs"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "suggestion_review_effects_identity_key" ON "suggestion_review_effects"("suggestion_id", "kind", "revision", "bot_id");
CREATE INDEX "suggestion_review_effects_due_idx" ON "suggestion_review_effects"("profile", "status", "next_attempt_at", "id");
CREATE INDEX "suggestion_review_effects_stale_idx" ON "suggestion_review_effects"("profile", "status", "locked_at", "id");
