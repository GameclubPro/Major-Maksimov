import { Prisma, type PrismaClient } from '../prisma/prisma-client';

export type BotAutoDeleteReceiptIdentity = {
  id: string;
  chatId: string;
  messageId: string;
  originBotId: string | null;
  remoteDeleteSucceededAt: Date | null;
  remoteDeleteSucceededBotId: string | null;
};

// FLAG: These columns were written only after validated DELETE success=true, including
// before the old absence-verification branch. A complete receipt confirms the exact
// mutation, never absence, a new reason, permission, or an unknown dispatch.
export async function settleBotAutoDeleteReceipt(
  prisma: Pick<PrismaClient, '$transaction'>,
  identity: BotAutoDeleteReceiptIdentity,
  leaseToken: string,
  materialize: (tx: Prisma.TransactionClient) => Promise<void>,
): Promise<boolean> {
  const acknowledgedAt = identity.remoteDeleteSucceededAt;
  const botId = identity.remoteDeleteSucceededBotId;
  if (
    !acknowledgedAt ||
    !Number.isFinite(acknowledgedAt.getTime()) ||
    !botId?.trim() ||
    botId !== identity.originBotId
  )
    return false;
  return prisma.$transaction(
    async (tx) => {
      // FLAG: Parent first, then a new READ COMMITTED snapshot. All reason writers lock
      // this parent; a reason committed while we waited must veto receipt-only settlement.
      const locked = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT "id" FROM "moderation_delete_intents"
      WHERE "id" = ${identity.id} AND "status" = 'IN_PROGRESS'
        AND "lease_token" = ${leaseToken}
      FOR UPDATE
    `);
      if (!locked.length) return false;
      const changed = await tx.$executeRaw(Prisma.sql`
      WITH reasons AS MATERIALIZED (
        SELECT "rule_code", "created_at" FROM "moderation_delete_intent_reasons"
        WHERE "intent_id" = ${identity.id} LIMIT 65
      )
      UPDATE "moderation_delete_intents" intent
      SET "status" = 'SUCCEEDED', "succeeded_bot_id" = ${botId}, "last_bot_id" = ${botId},
        "last_status_code" = NULL, "last_error_code" = NULL, "last_error" = NULL,
        "completed_at" = CURRENT_TIMESTAMP, "updated_at" = CURRENT_TIMESTAMP,
        "lease_token" = NULL, "lease_expires_at" = NULL, "leased_from_status" = NULL
      WHERE intent."id" = ${identity.id} AND intent."chat_id" = ${identity.chatId}
        AND intent."message_id" = ${identity.messageId} AND intent."origin_bot_id" = ${botId}
        AND intent."status" = 'IN_PROGRESS' AND intent."lease_token" = ${leaseToken}
        AND intent."lease_expires_at" > (clock_timestamp() AT TIME ZONE 'UTC')
        AND intent."entity_type" = 'CHAT' AND intent."message_author_kind" = 'bot'
        AND intent."routing_policy" = 'origin_only' AND NOT intent."retention_owned"
        AND NOT intent."commercial_ocr_guard_required"
        AND intent."delete_dispatch_started_at" IS NULL
        AND intent."delete_dispatch_started_bot_id" IS NULL
        AND intent."remote_delete_succeeded_at" = ${acknowledgedAt}
        AND intent."remote_delete_succeeded_bot_id" = ${botId}
        AND isfinite(intent."remote_delete_succeeded_at")
        AND intent."remote_delete_succeeded_at" <= (clock_timestamp() AT TIME ZONE 'UTC')
        AND (SELECT count(*) FROM reasons) BETWEEN 1 AND 64
        AND NOT EXISTS (SELECT 1 FROM reasons WHERE "rule_code" <> 'BOT_MESSAGE_AUTO_DELETE'
          OR "created_at" > intent."remote_delete_succeeded_at")
    `);
      if (changed !== 1) return false;
      await tx.$executeRaw(Prisma.sql`
      UPDATE "moderation_delete_intent_reasons"
      SET "metadata" = COALESCE("metadata", '{}'::jsonb) || jsonb_build_object(
          'botAutoDeleteConfirmation', jsonb_build_object('version', 1,
            'kind', 'documented_delete_success', 'botId', CAST(${botId} AS text),
            'acknowledgedAt', CAST(${acknowledgedAt.toISOString()} AS text))),
        "updated_at" = CURRENT_TIMESTAMP
      WHERE "intent_id" = ${identity.id}
    `);
      // FLAG: Only the already-proved auto-delete event is materialized. No rule followup,
      // replacement cleanup, remote request, or new effect is activated here.
      await materialize(tx);
      return true;
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
  );
}
