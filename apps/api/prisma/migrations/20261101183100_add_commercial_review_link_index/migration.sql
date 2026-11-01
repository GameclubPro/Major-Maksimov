-- FLAG: Reviewed evidence joins use an exact hash seek with a two-row ambiguity sentinel.
CREATE INDEX CONCURRENTLY "commercial_review_samples_human_evidence_idx"
  ON "commercial_review_samples" ("human_review_evidence_hash", "observed_at" DESC, "id" DESC);
