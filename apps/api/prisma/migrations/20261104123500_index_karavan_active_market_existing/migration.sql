-- Protect cross-chat marketplace admission while compatible legacy operations remain active.
CREATE INDEX CONCURRENTLY "karavan_connection_operation_active_market_existing_idx"
  ON "karavan_marketplace_connection_operations"((lower(request ->> 'existingMarketplaceId')), "id")
  WHERE "state" IN ('pending','partial','unknown');
