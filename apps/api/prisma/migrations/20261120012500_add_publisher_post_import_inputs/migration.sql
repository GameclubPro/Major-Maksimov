SET lock_timeout = '5s';

ALTER TABLE "publisher_post_import_sessions"
    ADD COLUMN "input_mode" TEXT NOT NULL DEFAULT 'forward',
    ADD COLUMN "input_opened_at" TIMESTAMP(3),
    ADD COLUMN "input_messages" JSONB NOT NULL DEFAULT '[]',
    ADD COLUMN "warnings" JSONB NOT NULL DEFAULT '[]';

RESET lock_timeout;
