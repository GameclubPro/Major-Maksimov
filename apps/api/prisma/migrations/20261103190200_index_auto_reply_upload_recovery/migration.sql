-- FLAG: Include the unique suffix so a locked timestamp tie cannot starve the upload tail.
-- Additive online index only; READY data and newer lease ownership stay authoritative.
SET lock_timeout = '5s';
SET statement_timeout = '600s';
SET maintenance_work_mem = '128MB';
SET max_parallel_maintenance_workers = 0;
SET temp_file_limit = '512MB';
CREATE INDEX CONCURRENTLY "publisher_auto_reply_asset_uploads_active_recovery_idx"
ON "public"."publisher_auto_reply_asset_uploads" ("locked_at", "updated_at", "id")
WHERE "status" = 'UPLOADING';
RESET temp_file_limit;
RESET max_parallel_maintenance_workers;
RESET maintenance_work_mem;
RESET statement_timeout;
RESET lock_timeout;
