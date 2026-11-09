import { Prisma } from '../prisma/prisma-client';

export const VK_AUTO_DELETE_BATCH_SIZE = 50;
export type VkAutoDeleteCursor = { id: string; autoDeleteAt: Date };

export function vkAutoDeleteCandidatesQuery(
  ownerBotId: string,
  now: Date,
  cursor: VkAutoDeleteCursor | null,
): Prisma.Sql {
  // FLAG: Match the partial index; limit keys before loading publication metadata.
  return Prisma.sql`
    SELECT "id", "auto_delete_at" AS "autoDeleteAt"
    FROM "vk_parsing_posts"
    WHERE "owner_profile" = 'PUBLISHER' AND "dispatch_profile" = 'PUBLIK_V1'
      AND "owner_bot_id" = ${ownerBotId}
      AND "auto_delete_at" IS NOT NULL AND "auto_delete_at" <= ${now}
      AND "rollback_queued_at" IS NULL AND "rollback_deleted_at" IS NULL
      ${cursor ? Prisma.sql`AND ("auto_delete_at", "id") > (${cursor.autoDeleteAt}, ${cursor.id})` : Prisma.empty}
    ORDER BY "auto_delete_at", "id"
    LIMIT ${VK_AUTO_DELETE_BATCH_SIZE}
  `;
}

export const vkAutoDeletePostSelect = {
  id: true,
  chatId: true,
  ownerProfile: true,
  ownerBotId: true,
  dispatchProfile: true,
  requiredBotId: true,
  publishedBotId: true,
  publishedMessageId: true,
  publishIdempotencyKey: true,
  publishLockedAt: true,
  publishQueuedAt: true,
  publishReason: true,
  publishScheduledAt: true,
  rollbackQueuedAt: true,
  rollbackLockedAt: true,
  rollbackIdempotencyKey: true,
  rollbackDeletedAt: true,
  autoDeleteAt: true,
  status: true,
} satisfies Prisma.VkParsingPostSelect;
