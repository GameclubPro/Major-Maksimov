-- FLAG: Build separately outside a transaction. Exact names deliberately refuse
-- an existing invalid artifact; timeout recovery must preserve its failed receipt.
SET lock_timeout = '5s';
SET statement_timeout = '90s';
SET maintenance_work_mem = '64MB';
SET max_parallel_maintenance_workers = 0;
SET temp_file_limit = '512MB';
CREATE INDEX CONCURRENTLY "managed_giveaways_status_ends_at_id_idx"
ON "managed_giveaways" ("status", "ends_at", "id");
RESET temp_file_limit;
RESET max_parallel_maintenance_workers;
RESET maintenance_work_mem;
RESET statement_timeout;
RESET lock_timeout;
