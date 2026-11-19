SET lock_timeout = '5s';
ALTER TABLE "managed_giveaways" ADD COLUMN "archived_at" TIMESTAMP(3);

CREATE TABLE "managed_giveaway_results_sync" (
    "giveaway_id" TEXT NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "next_attempt_at" TIMESTAMP(3),
    "lease_token" TEXT,
    "lease_until" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "managed_giveaway_results_sync_pkey" PRIMARY KEY ("giveaway_id"),
    CONSTRAINT "managed_giveaway_results_sync_giveaway_id_fkey" FOREIGN KEY ("giveaway_id") REFERENCES "managed_giveaways"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "managed_giveaway_results_sync_due_idx" ON "managed_giveaway_results_sync" ("next_attempt_at", "giveaway_id");
RESET lock_timeout;
