CREATE INDEX CONCURRENTLY "spammer_observation_projection_due_idx" ON "spammer_observations" ("projection_due_at", "id") WHERE "projection_due_at" IS NOT NULL;
