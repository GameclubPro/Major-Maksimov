-- FLAG: Every committed removal/denial supersedes an earlier rights request, including
-- repeated observations with the same status. This identity is separate from policy CAS.
ALTER TABLE eraser_policies
  ADD COLUMN connection_generation bigint NOT NULL DEFAULT 0 CHECK (connection_generation >= 0);
