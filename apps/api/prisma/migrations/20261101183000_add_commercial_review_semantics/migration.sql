-- Nullable independent semantic evidence; historical ratings remain unannotated.
ALTER TABLE "commercial_review_ratings" ADD COLUMN "semantic_annotation" JSONB;
ALTER TABLE "commercial_review_samples" ADD COLUMN "human_review_evidence_hash" TEXT;
ALTER TABLE "commercial_review_samples" ADD COLUMN "semantic_review_state" TEXT;

