-- FLAG: Keep online writers and the existing indexes. Tuple continuation must seek
-- through tied due times without scanning a retained or locked prefix.
SET lock_timeout = '5s';
SET statement_timeout = '90s';
SET maintenance_work_mem = '64MB';
SET max_parallel_maintenance_workers = 0;
SET temp_file_limit = '512MB';
CREATE INDEX CONCURRENTLY "managed_giveaways_status_starts_at_id_idx"
ON "managed_giveaways" ("status", "starts_at", "id");
RESET temp_file_limit;
RESET max_parallel_maintenance_workers;
RESET maintenance_work_mem;
RESET statement_timeout;
RESET lock_timeout;
