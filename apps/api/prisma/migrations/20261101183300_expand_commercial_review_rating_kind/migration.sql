-- FLAG: Widen the finite allowlist atomically; retain every existing row and kind.
ALTER TABLE "commercial_review_ratings"
  DROP CONSTRAINT "commercial_review_ratings_kind_check",
  ADD CONSTRAINT "commercial_review_ratings_kind_check"
    CHECK ("kind" IN ('INDEPENDENT', 'ADJUDICATION', 'SEMANTIC_ADJUDICATION')) NOT VALID;
