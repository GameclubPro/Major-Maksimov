-- Independent advisory retry budget. Existing effect and cooldown readers stay authoritative.
ALTER TABLE eraser_policies
  ADD COLUMN IF NOT EXISTS rights_failure_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS rights_retry_at timestamptz;
