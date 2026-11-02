-- FLAG: Exact-user invalidation reads retain every fence phase and intended action.
CREATE INDEX CONCURRENTLY "moderation_events_sanction_user_fence_idx"
  ON "moderation_events" ("chat_id", "user_id", "created_at" DESC, "id" DESC)
  WHERE "rule_code" = 'SANCTION_STATE_FENCE';
