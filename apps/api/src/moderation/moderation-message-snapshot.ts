import { Prisma } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import type { WebhookEffectOrigin } from './webhook-effect-origin-context';

// FLAG: Observation only. Capture the first exact source with its reason, before any DELETE;
// duplicate receipts cannot replace the text, renew retention or grant execution authority.
export function captureModerationMessageSql(input: {
  reasonId: string;
  chatId: string;
  messageId: string;
  userId: string | null;
  origin: WebhookEffectOrigin | null;
}): Prisma.Sql {
  const origin = input.origin;
  return Prisma.sql`
    INSERT INTO moderation_message_snapshots (reason_id, content, source_at, expires_at)
    SELECT inserted.id,
      jsonb_build_object(
        'text', LEFT(COALESCE(receipt.normalized_payload #>> '{message,text}', ''), 16000),
        'truncated', LENGTH(COALESCE(receipt.normalized_payload #>> '{message,text}', '')) > 16000,
        'attachments', COALESCE((
          SELECT jsonb_agg(CASE
            WHEN attachment->>'type' IN ('image', 'video', 'audio', 'file', 'sticker', 'contact', 'location')
              THEN attachment->>'type' ELSE 'other' END ORDER BY ordinal)
          FROM jsonb_array_elements(CASE
            WHEN jsonb_typeof(receipt.normalized_payload #> '{raw,message,body,attachments}') = 'array'
              THEN receipt.normalized_payload #> '{raw,message,body,attachments}'
            WHEN jsonb_typeof(receipt.normalized_payload #> '{raw,message,attachments}') = 'array'
              THEN receipt.normalized_payload #> '{raw,message,attachments}'
            ELSE '[]'::jsonb END) WITH ORDINALITY AS media(attachment, ordinal)
          WHERE ordinal <= 32
        ), '[]'::jsonb)
      ), ${origin?.sourceEventAt ?? null}, ${origin?.sourceEventAt ?? null}::timestamp + INTERVAL '14 days'
    FROM changed_reason inserted
    JOIN webhook_events receipt ON receipt.id = ${origin?.sourceWebhookEventId ?? null}
    WHERE inserted.id = ${input.reasonId}
      AND ${origin !== null}
      AND receipt.bot_id = ${origin?.sourceReceivingBotId ?? null}
      AND receipt.normalized_payload #>> '{message,chatId}' = ${input.chatId}
      AND receipt.normalized_payload #>> '{message,messageId}' = ${input.messageId}
      AND receipt.normalized_payload #>> '{message,senderId}' = ${input.userId}
      AND receipt.normalized_payload->>'type' IN ('message_created', 'message_edited')
      AND jsonb_typeof(receipt.normalized_payload #> '{message,text}') = 'string'
      AND ${origin?.sourceEventAt ?? null}::timestamp > CURRENT_TIMESTAMP - INTERVAL '14 days'
    ON CONFLICT (reason_id) DO NOTHING
  `;
}

// FLAG: Purge only content; its tombstone distinguishes expiry from a missing capture.
// The indexed bounded batch never changes reasons, receipts or moderation authority.
export async function purgeModerationMessageSnapshots(prisma: PrismaService): Promise<number> {
  return prisma.$executeRaw(Prisma.sql`
    WITH expired AS (
      SELECT reason_id FROM moderation_message_snapshots
      WHERE purged_at IS NULL AND expires_at <= CURRENT_TIMESTAMP
      ORDER BY expires_at, reason_id LIMIT ${250} FOR UPDATE SKIP LOCKED
    )
    UPDATE moderation_message_snapshots snapshot
    SET content = NULL, purged_at = CURRENT_TIMESTAMP
    FROM expired WHERE snapshot.reason_id = expired.reason_id
  `);
}
