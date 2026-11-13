-- Additive private-card state. Existing suggestion/effect readers remain authoritative.
CREATE TABLE "suggestion_review_dialogs" (
  "delivery_id" TEXT PRIMARY KEY,
  "bot_id" TEXT NOT NULL,
  "actor_id" TEXT NOT NULL,
  "private_chat_id" TEXT NOT NULL,
  "card_message_id" TEXT NOT NULL,
  "profile" TEXT NOT NULL,
  "revision" INTEGER NOT NULL DEFAULT 0,
  "version" INTEGER NOT NULL DEFAULT 0,
  "mode" TEXT NOT NULL DEFAULT 'idle',
  "opened_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "draft" JSONB,
  "input_message_id" TEXT,
  "input_at" TIMESTAMP(3),
  "last_event_id" TEXT,
  "lock_token" TEXT,
  "locked_at" TIMESTAMP(3),
  "expires_at" TIMESTAMP(3) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "suggestion_review_dialog_delivery_fk" FOREIGN KEY ("delivery_id")
    REFERENCES "channel_suggestion_admin_deliveries" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "suggestion_review_dialog_card_key" ON "suggestion_review_dialogs"
  ("bot_id", "actor_id", "private_chat_id", "card_message_id");
CREATE INDEX "suggestion_review_dialog_input_idx" ON "suggestion_review_dialogs"
  ("bot_id", "actor_id", "private_chat_id", "input_message_id");
CREATE TABLE "suggestion_review_contacts" (
  "channel_id" TEXT PRIMARY KEY,
  "url" TEXT NOT NULL,
  "actor_id" TEXT NOT NULL,
  "updated_at" TIMESTAMP(3) NOT NULL
);
CREATE TABLE "suggestion_review_card_upgrades" (
  "profile" TEXT PRIMARY KEY,
  "cursor" TEXT NOT NULL DEFAULT '',
  "completed" BOOLEAN NOT NULL DEFAULT false,
  "updated_at" TIMESTAMP(3) NOT NULL
);
