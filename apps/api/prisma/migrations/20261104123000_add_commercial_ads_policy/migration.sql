SET lock_timeout = '5s';
SET statement_timeout = '30s';

-- NULL preserves existing moderation. Only an explicit administrator save adopts category rules.
ALTER TABLE "chat_settings" ADD COLUMN "commercial_ads_policy" JSONB;
