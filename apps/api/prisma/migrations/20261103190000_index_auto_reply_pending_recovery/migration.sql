-- FLAG: Bound due recovery by its own status and unique keyset, including timestamp ties.
-- Additive online index only; existing receipts, leases and SEND fences stay unchanged.
SET lock_timeout = '5s';
SET statement_timeout = '600s';
SET maintenance_work_mem = '128MB';
SET max_parallel_maintenance_workers = 0;
SET temp_file_limit = '512MB';
CREATE INDEX CONCURRENTLY "publisher_auto_reply_deliveries_pending_recovery_idx"
ON "public"."publisher_auto_reply_deliveries" ("due_at", "id")
WHERE "status" = 'PENDING';
RESET temp_file_limit;
RESET max_parallel_maintenance_workers;
RESET maintenance_work_mem;
RESET statement_timeout;
RESET lock_timeout;
