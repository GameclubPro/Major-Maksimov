BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

-- Additive fields preserve existing setup identities, requests and hashes.
ALTER TABLE "karavan_marketplace_connection_operations"
  ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'setup',
  ADD COLUMN "result" JSONB,
  ADD COLUMN "error_code" TEXT,
  DROP CONSTRAINT "karavan_marketplace_operation_state_check",
  ADD CONSTRAINT "karavan_marketplace_operation_state_check"
    CHECK ("state" IN ('pending','partial','complete','unknown','rejected','cancelled','superseded')) NOT VALID;

CREATE TABLE "karavan_marketplace_connection_scopes" (
  "chat_id" TEXT NOT NULL,
  "revision" INTEGER NOT NULL DEFAULT 0,
  "active_operation_id" UUID,
  "last_operation_id" UUID,
  "updated_at" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "karavan_marketplace_connection_scopes_pkey" PRIMARY KEY ("chat_id"),
  CONSTRAINT "karavan_connection_scope_revision_check" CHECK ("revision" >= 0),
  CONSTRAINT "karavan_connection_scope_active_operation_fkey" FOREIGN KEY ("active_operation_id")
    REFERENCES "karavan_marketplace_connection_operations"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "karavan_connection_scope_last_operation_fkey" FOREIGN KEY ("last_operation_id")
    REFERENCES "karavan_marketplace_connection_operations"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "karavan_connection_scope_active_operation_idx"
  ON "karavan_marketplace_connection_scopes"("active_operation_id");
CREATE INDEX "karavan_connection_scope_last_operation_idx"
  ON "karavan_marketplace_connection_scopes"("last_operation_id");
COMMIT;
