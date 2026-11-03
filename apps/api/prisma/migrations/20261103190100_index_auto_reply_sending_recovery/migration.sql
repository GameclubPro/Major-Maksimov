-- FLAG: Stale SEND leases need their own bounded range; due history must not hide them.
-- Additive online index only; recovery must retain exact token/time and started-SEND fences.
SET lock_timeout = '5s';
SET statement_timeout = '600s';
SET maintenance_work_mem = '128MB';
SET max_parallel_maintenance_workers = 0;
SET temp_file_limit = '512MB';
CREATE INDEX CONCURRENTLY "publisher_auto_reply_deliveries_sending_recovery_idx"
ON "public"."publisher_auto_reply_deliveries" ("locked_at", "id")
WHERE "status" = 'SENDING';
RESET temp_file_limit;
RESET max_parallel_maintenance_workers;
RESET maintenance_work_mem;
RESET statement_timeout;
RESET lock_timeout;
