-- Optional observations only. Nullable/no default avoids rewriting retained review history.
SET lock_timeout = '3s';
ALTER TABLE "commercial_review_samples" ADD COLUMN "llm_enforcement" JSONB;
