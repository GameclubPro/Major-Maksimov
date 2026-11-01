-- FLAG: Both adjudication kinds share one immutable third-review slot.
CREATE UNIQUE INDEX CONCURRENTLY "commercial_review_ratings_one_final_review_key"
  ON "commercial_review_ratings" ("sample_id")
  WHERE "kind" IN ('ADJUDICATION', 'SEMANTIC_ADJUDICATION');
