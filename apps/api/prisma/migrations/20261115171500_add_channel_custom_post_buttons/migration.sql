ALTER TABLE "channel_settings"
  ADD COLUMN "custom_post_buttons_enabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "custom_post_buttons" JSONB NOT NULL DEFAULT '[]',
  ADD COLUMN "custom_post_buttons_since" TIMESTAMPTZ(3);
