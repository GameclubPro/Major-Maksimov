import { Prisma } from '../prisma/prisma-client';
import type { EnsureModerationDeleteIntentInput } from './moderation-delete-intent.types';
import { WebhookParser } from '../webhook/webhook.parser';
import { readClosedChatMessageCreatedAt } from './closed-chat-message-source';
import {
  captureVoiceSourceInput,
  VOICE_SOURCE_LIFETIME_MS,
  type VoiceSourceInput,
} from './voice-webhook-source';

const parser = new WebhookParser();
const STATE_VOICE_RULES = new Set([
  'MUTE_ACTIVE_DELETE',
  'NIGHT_MODE_DELETE',
  'MANUAL_GROUP_CLOSE_DELETE',
]);
function isClosureReason(ruleCode: string | undefined) {
  return ruleCode === 'NIGHT_MODE_DELETE' || ruleCode === 'MANUAL_GROUP_CLOSE_DELETE';
}

type Reason = { ruleCode: string; reasonKey: string; metadata: unknown };

function metadata(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

// FLAG: This binding proves only the direct voice identity. Each state guard must still
// authorize its own current mute/closure, author, immunity and absolute deadline.
export function bindStateVoiceSource(
  intent: EnsureModerationDeleteIntentInput,
  source: VoiceSourceInput | null | undefined,
): EnsureModerationDeleteIntentInput {
  const createdAt = new Date(intent.sourceMessageAt ?? NaN).getTime();
  if (
    !STATE_VOICE_RULES.has(intent.ruleCode ?? '') ||
    source?.kind !== 'created' ||
    source.chatId !== intent.chatId ||
    source.messageId !== intent.messageId ||
    source.userId !== intent.subjectUserId ||
    !Number.isSafeInteger(createdAt) ||
    createdAt <= 0 ||
    (source.sourceAtMs !== createdAt && !isClosureReason(intent.ruleCode))
  )
    return intent;
  const deadline = createdAt + VOICE_SOURCE_LIFETIME_MS;
  return {
    ...intent,
    retryUntilAt: new Date(Math.min(deadline, source.deadlineAtMs)),
    event: {
      ...intent.event,
      metadata: {
        ...metadata(intent.event?.metadata),
        stateVoiceSourceVersion: 1,
        stateVoiceSourceRuleCode: intent.ruleCode,
        stateVoiceSourceAtMs: createdAt,
        stateVoiceSourceDeadlineAtMs: deadline,
        // FLAG: A v1 reader rejects split clocks because its compact source time differs from createdAt.
        ...(source.sourceAtMs !== createdAt
          ? { stateVoiceSourceEventAtMs: source.sourceAtMs }
          : {}),
      },
    },
  };
}

export function isStateVoiceReason(reason: Reason): boolean {
  return (
    STATE_VOICE_RULES.has(reason.ruleCode) &&
    metadata(reason.metadata).stateVoiceSourceVersion === 1
  );
}

type CompactVoiceSource = {
  userId: string | null;
  receiptId: string | null;
  sourceAt: Date | null;
  deadlineAt: Date | null;
  invalidatedAt: Date | null;
};
type ClosureVoiceSource = CompactVoiceSource & { receiptBotId: string | null; raw: unknown };

function matchesClosureReceipt(
  source: ClosureVoiceSource,
  params: { chatId: string; messageId: string },
  createdAt: number,
): boolean {
  const raw = source.raw;
  if (!source.receiptBotId || !raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
  try {
    const update = parser.parse(raw as Record<string, unknown>, { botId: source.receiptBotId });
    const voice = captureVoiceSourceInput(update);
    return (
      voice?.kind === 'created' &&
      voice.chatId === params.chatId &&
      voice.messageId === params.messageId &&
      voice.userId === source.userId &&
      voice.sourceAtMs === source.sourceAt?.getTime() &&
      readClosedChatMessageCreatedAt(update) === new Date(createdAt).toISOString()
    );
  } catch {
    return false;
  }
}

export function stateVoiceReasonDeadline(reason: Reason, createdAt: number): number {
  const eventAt = metadata(reason.metadata).stateVoiceSourceEventAtMs;
  return (
    Math.min(createdAt, typeof eventAt === 'number' ? eventAt : Infinity) + VOICE_SOURCE_LIFETIME_MS
  );
}

// FLAG: Never turn a missing MAX GET into proof. Only atomic authenticated ingress
// evidence qualifies; edits/removals, conflicting mirrors and expiry revoke it.
// Re-read after awaited authority work. Do not lend it to history cleanup or content rules.
export async function readStateVoiceReasonKeys(
  prisma: Pick<Prisma.TransactionClient, 'moderationVoiceSource' | '$queryRaw'>,
  params: {
    chatId: string;
    messageId: string;
    subjectUserId: string | null;
    sourceMessageAt?: Date | null;
  },
  reasons: readonly Reason[],
): Promise<string[]> {
  const createdAt = params.sourceMessageAt?.getTime();
  if (!createdAt || createdAt <= 0 || createdAt > Date.now() + 1_000) return [];
  // FLAG: Read revocation and the original authenticated receipt in one snapshot using their primary keys.
  // Raw payload sampling is independent; the exact retained normalized envelope owns its raw update.
  const closed = reasons.some((reason) => isClosureReason(reason.ruleCode));
  const receipt = closed
    ? (
        await prisma.$queryRaw<ClosureVoiceSource[]>(Prisma.sql`
        SELECT voice.user_id AS "userId", voice.receipt_id AS "receiptId",
               voice.source_at AS "sourceAt", voice.deadline_at AS "deadlineAt",
               voice.invalidated_at AS "invalidatedAt", receipt.bot_id AS "receiptBotId",
               receipt.normalized_payload->'raw' AS raw
        FROM moderation_voice_sources voice
        JOIN webhook_events receipt ON receipt.id = voice.receipt_id
        WHERE voice.chat_id = ${params.chatId} AND voice.message_id = ${params.messageId}
      `)
      )[0]
    : null;
  const source = closed
    ? receipt
    : await prisma.moderationVoiceSource.findUnique({
        where: { chatId_messageId: { chatId: params.chatId, messageId: params.messageId } },
      });
  const at = source?.sourceAt?.getTime();
  const deadline = source?.deadlineAt?.getTime();
  if (
    !source ||
    source.invalidatedAt ||
    !source.receiptId ||
    source.userId !== params.subjectUserId ||
    !at ||
    !deadline ||
    deadline !== at + VOICE_SOURCE_LIFETIME_MS ||
    at > Date.now() + 1_000 ||
    Date.now() >= deadline
  )
    return [];
  if (closed ? !receipt || !matchesClosureReceipt(receipt, params, createdAt) : at !== createdAt)
    return [];
  return reasons
    .filter((reason) => {
      const proof = metadata(reason.metadata);
      return (
        isStateVoiceReason(reason) &&
        proof.stateVoiceSourceRuleCode === reason.ruleCode &&
        proof.stateVoiceSourceAtMs === createdAt &&
        proof.stateVoiceSourceDeadlineAtMs === createdAt + VOICE_SOURCE_LIFETIME_MS &&
        (at === createdAt
          ? proof.stateVoiceSourceEventAtMs === undefined
          : isClosureReason(reason.ruleCode) && proof.stateVoiceSourceEventAtMs === at) &&
        Date.now() < stateVoiceReasonDeadline(reason, createdAt) &&
        proof.automaticMuteCleanupId === undefined
      );
    })
    .map((reason) => reason.reasonKey);
}
