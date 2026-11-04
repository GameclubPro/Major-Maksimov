-- Exact active-anchor lookup protects operations created by the compatible legacy writer.
CREATE INDEX CONCURRENTLY "karavan_connection_operation_active_anchor_idx"
  ON "karavan_marketplace_connection_operations"("anchor_chat_id", "id")
  WHERE "state" IN ('pending','partial','unknown');
