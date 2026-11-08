-- FLAG: Add observational scalar clocks only. Existing rows stay legacy/unknown;
-- no history scan, backfill, rewrite or execution-authority change is permitted.
ALTER TABLE "max_action_ledger"
  ADD COLUMN "scheduled_for_at" TIMESTAMP(3),
  ADD COLUMN "schedule_clock_state" TEXT;

ALTER TABLE "max_action_ledger"
  ADD CONSTRAINT "max_action_ledger_schedule_clock_shape_check" CHECK (
    ("schedule_clock_state" IS NULL AND "scheduled_for_at" IS NULL)
    OR ("schedule_clock_state" IS NOT NULL AND (
      ("schedule_clock_state" IN ('UNSCHEDULED', 'INVALID') AND "scheduled_for_at" IS NULL)
      OR ("schedule_clock_state" = 'VALID' AND "scheduled_for_at" IS NOT NULL
        AND isfinite("scheduled_for_at"))
    ))
  ) NOT VALID;
