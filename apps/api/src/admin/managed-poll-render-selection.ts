import { Prisma } from '../prisma/prisma-client';

export const MANAGED_POLL_RENDER_FORMAT_VERSION = 7;

// FLAG: This expression and the format floor match the concurrent migration's partial index.
// A presentation-version upgrade must migrate the index and retain native history-plan coverage.
const retryAt = Prisma.sql`CASE
  WHEN "render_retry_at" IS NOT NULL
    AND "render_retry_message_id" IS NOT DISTINCT FROM "publication_message_id"
    AND "render_retry_bot_id" IS NOT DISTINCT FROM "publication_bot_id"
    THEN "render_retry_at"
  WHEN "render_retry_at" IS NULL AND "last_render_error" IS NOT NULL
    THEN "updated_at" + INTERVAL '5 minutes'
  ELSE "updated_at"
END`;

export function managedPollRenderSelection(now: Date, formatVersion: number, limit: number) {
  return Prisma.sql`
    SELECT "id", "chat_id" AS "chatId"
    FROM "managed_polls"
    WHERE "publication_message_id" IS NOT NULL
      AND (
        "rendered_revision" < "render_revision"
        OR "render_format_version" < ${formatVersion}
        OR "last_render_error" IS NOT NULL
      )
      AND ${retryAt} <= ${now}
    ORDER BY ${retryAt} ASC, "updated_at" ASC, "id" ASC
    LIMIT ${limit}
  `;
}
