SET lock_timeout = '5s';
SET statement_timeout = '30s';

ALTER TABLE "chat_settings"
  ADD COLUMN "night_mode_open_message_delete_on_first_message_enabled" BOOLEAN NOT NULL DEFAULT false;
