SET lock_timeout = '5s';
ALTER TABLE "managed_giveaways" ADD COLUMN "draft_revision" INTEGER NOT NULL DEFAULT 1;
RESET lock_timeout;
