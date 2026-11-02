SET lock_timeout = '5s';
SET statement_timeout = '2700s';
SET maintenance_work_mem = '256MB';
SET temp_file_limit = '8GB';
SET max_parallel_maintenance_workers = 0;

CREATE INDEX CONCURRENTLY "webhook_events_chat_queue_head_idx"
ON "webhook_events" (
  (COALESCE(
    NULLIF(BTRIM("normalized_payload"->'message'->>'chatId'), ''),
    NULLIF(BTRIM("normalized_payload"->>'chatId'), '')
  )),
  "queue_name",
  "created_at",
  "id"
)
WHERE (
    "status" = ANY(ARRAY['RECEIVED', 'QUEUED']::"WebhookStatus"[])
    OR (
      "status" = 'FAILED'::"WebhookStatus"
      AND (
        "next_enqueue_at" IS NOT NULL
        OR LEFT(
          COALESCE("error_message", ''),
          37
        ) = 'WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINED:'
      )
    )
  )
  AND LOWER(
    COALESCE(
      NULLIF(BTRIM("normalized_payload"->>'type'), ''),
      NULLIF(BTRIM("normalized_payload"->>'update_type'), '')
    )
  ) = ANY(ARRAY['message_created', 'message_edited']);

RESET max_parallel_maintenance_workers;
RESET temp_file_limit;
RESET maintenance_work_mem;
RESET statement_timeout;
RESET lock_timeout;
