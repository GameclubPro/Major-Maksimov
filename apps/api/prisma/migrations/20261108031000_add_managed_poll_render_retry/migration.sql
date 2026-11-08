BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

-- FLAG: Additive retry metadata never changes poll/publication/access evidence.
-- Constant/nullable defaults avoid a retained-history rewrite; old readers ignore them.
ALTER TABLE "managed_polls"
  ADD COLUMN "render_retry_count" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "render_retry_at" TIMESTAMP(3),
  ADD COLUMN "render_retry_message_id" TEXT,
  ADD COLUMN "render_retry_bot_id" TEXT,
  ADD CONSTRAINT "managed_polls_render_retry_count_check"
    CHECK ("render_retry_count" BETWEEN 0 AND 8) NOT VALID;
COMMIT;
