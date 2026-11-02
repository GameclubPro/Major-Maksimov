BEGIN;

SET LOCAL lock_timeout = '1s';
SET LOCAL statement_timeout = '5s';

-- FLAG: Existing ordered journals retain their saved deadline. A semantic-only
-- mirror has no original execution deadline; never invent or renew one.
LOCK TABLE "webhook_dependency_quarantines" IN ACCESS EXCLUSIVE MODE NOWAIT;

CREATE TYPE "WebhookDependencyKind" AS ENUM ('ORDERED', 'SEMANTIC_MIRROR');

ALTER TABLE "webhook_dependency_quarantines"
  ADD COLUMN "kind" "WebhookDependencyKind" NOT NULL DEFAULT 'ORDERED',
  ALTER COLUMN "deadline_at" DROP NOT NULL,
  ADD CONSTRAINT "webhook_dependency_quarantines_kind_deadline_check"
    CHECK (
      ("kind" = 'ORDERED' AND "deadline_at" IS NOT NULL)
      OR ("kind" = 'SEMANTIC_MIRROR' AND "deadline_at" IS NULL)
    ) NOT VALID;

COMMIT;
