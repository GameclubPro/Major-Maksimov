-- FLAG: Legacy multi-chat commands reserve every target, including non-anchor chats.
-- Keep the expression and literal active-state predicate aligned with journal probes.
CREATE INDEX CONCURRENTLY "karavan_connection_operation_active_chats_idx"
  ON "karavan_marketplace_connection_operations" USING GIN (("request" -> 'chatIds'))
  WHERE "state" IN ('pending','partial','unknown');
