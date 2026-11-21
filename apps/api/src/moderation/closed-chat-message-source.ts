import type { MaxUpdate } from '@maxim/contracts';
import { selectMaxMessageCandidate } from '../max/max-message-candidate.util';
import { parseWebhookEventTimestampMs } from '../webhook/webhook-event-timestamp';

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function matches(value: unknown, expected: string | undefined): boolean {
  return (
    !!expected &&
    (typeof value === 'string' || typeof value === 'number') &&
    String(value) === expected
  );
}

// FLAG: Only the named outer message proves when a participant actually posted.
// Edits, linked messages and the clock of a delayed update cannot authorize a DELETE.
export function readClosedChatMessageCreatedAt(update: MaxUpdate): string | null {
  const message = update.message;
  if (
    update.type !== 'message_created' ||
    !message ||
    message.entityType === 'channel' ||
    !update.raw
  )
    return null;
  const candidate = selectMaxMessageCandidate(update.raw, update.type);
  if (
    !candidate ||
    !/^(?:message|message_created|(?:message_created|data|event)(?:\.data)?\.message)$/u.test(
      candidate.path,
    )
  )
    return null;
  const row = candidate.node;
  const body = record(row.body);
  const recipient = record(row.recipient);
  const sender = record(row.sender);
  if (
    recipient?.chat_type === 'channel' ||
    !matches(
      body?.mid ?? row.message_id ?? row.messageId ?? row.mid ?? row.id,
      message.messageId,
    ) ||
    !matches(
      recipient?.chat_id ?? recipient?.chatId ?? row.chat_id ?? row.chatId,
      message.chatId,
    ) ||
    !matches(sender?.user_id ?? sender?.id ?? row.sender_id ?? row.senderId, message.senderId)
  )
    return null;
  const at = parseWebhookEventTimestampMs(row.timestamp ?? row.created_at ?? row.createdAt);
  return at === null ? null : new Date(at).toISOString();
}
