import {
  isSpammerKickRule,
  matchesSpammerKickReason,
  spammerKickPolicySha256,
} from './spammer-kick-source';
import { createHash } from 'node:crypto';
import { Prisma } from '../prisma/prisma-client';
import type { EnsureModerationDeleteIntentInput } from './moderation-delete-intent.types';
import type { ModerationRuleFollowupEnvelope } from './moderation-rule-followup.contract';
import { MESSAGE_LIMITS_GUARDED_RULES } from './message-limits-delete-guard.service';
import { STOP_WORDS_DELETE_RULE_CODES } from './stop-words/stop-words-delete-guard.service';

export const DURABLE_RULE_FOLLOWUP_RULES = new Set([
  ...MESSAGE_LIMITS_GUARDED_RULES,
  ...STOP_WORDS_DELETE_RULE_CODES,
]);

// FLAG: Expected source expiry is distinct from malformed authority and must roll back new work.
export class ModerationRuleFollowupSourceExpiredError extends Error {}

export function assertRuleFollowupSourceCurrent(
  input: EnsureModerationDeleteIntentInput,
  policySha256: string,
  envelope: ModerationRuleFollowupEnvelope,
  nowMs = Date.now(),
): Date {
  const rule = input.ruleCode ?? '';
  const metadata = input.event?.metadata;
  const expectedSpammerSource =
    isSpammerKickRule(rule) &&
    input.entityType === 'CHAT' &&
    input.messageAuthorKind === 'user' &&
    input.event?.userId === input.subjectUserId &&
    envelope.originBotId === (input.originBotId ?? null) &&
    policySha256 === spammerKickPolicySha256(rule) &&
    metadata &&
    typeof metadata === 'object' &&
    !Array.isArray(metadata) &&
    matchesSpammerKickReason(rule, input.reasonKey, (metadata as Record<string, unknown>).reason);
  if (
    (!DURABLE_RULE_FOLLOWUP_RULES.has(rule) && !expectedSpammerSource) ||
    !input.chatId.trim() ||
    !input.messageId.trim() ||
    !input.reasonKey.trim() ||
    !input.subjectUserId?.trim() ||
    !input.sourceMessageAt
  )
    throw new Error('Durable rule follow-up requires guarded exact source');
  const sourceAt = new Date(input.sourceMessageAt);
  if (
    !Number.isSafeInteger(sourceAt.getTime()) ||
    sourceAt.getTime() <= 0 ||
    sourceAt.getTime() > nowMs ||
    !/^[a-f0-9]{64}$/u.test(policySha256) ||
    !readRuleFollowupEnvelope(envelope)
  )
    throw new Error('Invalid durable rule follow-up binding');
  if (nowMs >= sourceAt.getTime() + 300_000)
    throw new ModerationRuleFollowupSourceExpiredError('Durable rule follow-up source expired');
  return sourceAt;
}

export async function persistRuleFollowupBeforeDelete(
  tx: Prisma.TransactionClient,
  intentId: string,
  input: EnsureModerationDeleteIntentInput,
  policySha256: string,
  envelope: ModerationRuleFollowupEnvelope,
): Promise<string | null> {
  const sourceAt = assertRuleFollowupSourceCurrent(input, policySha256, envelope);
  const id = `mrf-v1-${createHash('sha256')
    .update(JSON.stringify([intentId, input.reasonKey]))
    .digest('hex')}`;
  // FLAG: The envelope and new primary DELETE commit together. An old dispatch/success
  // cannot gain fresh authority, and replay never changes the saved envelope or deadline.
  const inserted = await tx.$executeRaw(Prisma.sql`
    INSERT INTO "moderation_rule_followups" ("id", "intent_id", "reason_key", "chat_id", "user_id",
      "message_id", "rule_code", "source_at", "deadline_at", "policy_sha256", "envelope", "updated_at")
    SELECT ${id}, intent."id", ${input.reasonKey}, ${input.chatId}, ${input.subjectUserId},
      ${input.messageId}, ${input.ruleCode!}, ${sourceAt}, ${new Date(sourceAt.getTime() + 300_000)},
      ${policySha256}, ${JSON.stringify(envelope)}::jsonb, (clock_timestamp() AT TIME ZONE 'UTC')
    FROM "moderation_delete_intents" intent
    WHERE intent."id" = ${intentId} AND intent."chat_id" = ${input.chatId}
      AND intent."message_id" = ${input.messageId} AND intent."subject_user_id" = ${input.subjectUserId}
      AND intent."source_message_at" = ${sourceAt}
      AND intent."status" IN ('PENDING', 'RETRYABLE', 'WAITING_CAPABILITY')
      AND intent."delete_dispatch_started_at" IS NULL AND intent."remote_delete_succeeded_at" IS NULL
      ${isSpammerKickRule(input.ruleCode ?? '') ? Prisma.sql`AND intent."attempt_count" = 0 AND intent."first_attempt_at" IS NULL` : Prisma.empty}
      AND (clock_timestamp() AT TIME ZONE 'UTC') < ${new Date(sourceAt.getTime() + 300_000)}
    ON CONFLICT ("intent_id", "reason_key") DO NOTHING
  `);
  if (inserted > 0) return id;
  // FLAG: If expiry wins the SQL insert race, undo the new intent/reason in the caller's
  // transaction. A null follow-up must never leave newly created expired action work behind.
  const [clock] = await tx.$queryRaw<{ expired: boolean }[]>(Prisma.sql`
    SELECT (clock_timestamp() AT TIME ZONE 'UTC') >= ${new Date(sourceAt.getTime() + 300_000)} AS expired
  `);
  if (clock?.expired)
    throw new ModerationRuleFollowupSourceExpiredError('Durable rule follow-up source expired');
  const existing = await tx.moderationRuleFollowup.findUnique({
    where: { intentId_reasonKey: { intentId, reasonKey: input.reasonKey } },
  });
  if (
    !existing ||
    existing.chatId !== input.chatId ||
    existing.userId !== input.subjectUserId ||
    existing.messageId !== input.messageId ||
    existing.ruleCode !== input.ruleCode ||
    existing.sourceAt.getTime() !== sourceAt.getTime() ||
    existing.policySha256 !== policySha256
  )
    return null;
  return existing.id;
}

export async function activateOwnedRuleFollowups(
  tx: Prisma.TransactionClient,
  intentId: string,
): Promise<void> {
  // FLAG: READY is minted only from the same transaction's exact own confirmed receipt.
  await tx.$executeRaw(Prisma.sql`
    UPDATE "moderation_rule_followups" followup
    SET "status" = 'READY', "next_attempt_at" = (clock_timestamp() AT TIME ZONE 'UTC'), "updated_at" = (clock_timestamp() AT TIME ZONE 'UTC')
    FROM "moderation_delete_intents" intent, "moderation_delete_intent_reasons" reason
    WHERE followup."intent_id" = ${intentId} AND intent."id" = followup."intent_id"
      AND reason."intent_id" = followup."intent_id" AND reason."reason_key" = followup."reason_key"
      AND followup."status" = 'WAITING_DELETE' AND intent."status" = 'SUCCEEDED'
      AND intent."subject_user_id" = followup."user_id" AND intent."source_message_at" = followup."source_at"
      AND intent."chat_id" = followup."chat_id" AND intent."message_id" = followup."message_id"
      AND reason."rule_code" = followup."rule_code"
      AND (reason."user_id" IS NULL OR reason."user_id" = followup."user_id")
      AND reason."metadata"->'moderationDeleteVerified' = 'true'::jsonb
      AND (clock_timestamp() AT TIME ZONE 'UTC') < followup."deadline_at"
  `);
}

export function readRuleFollowupEnvelope(value: unknown): ModerationRuleFollowupEnvelope | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const bounded = (v: unknown, max: number, nullable = false): boolean =>
    (nullable && v === null) || (typeof v === 'string' && v.length <= max);
  const allowedKeys = [
    'version',
    'updateType',
    'originBotId',
    'userLabel',
    'effectiveMessageLength',
    'rulesPublishedUrl',
    'rulesPublishedMessageId',
  ];
  if (
    Object.keys(record).length !== allowedKeys.length ||
    Object.keys(record).some((key) => !allowedKeys.includes(key)) ||
    !['message_created', 'message_edited'].includes(String(record.updateType)) ||
    record.version !== 1 ||
    !bounded(record.updateType, 32) ||
    !bounded(record.originBotId, 128, true) ||
    !bounded(record.userLabel, 1024) ||
    !bounded(record.rulesPublishedUrl, 4096, true) ||
    !bounded(record.rulesPublishedMessageId, 256, true) ||
    !Number.isSafeInteger(record.effectiveMessageLength) ||
    (record.effectiveMessageLength as number) < 0 ||
    Buffer.byteLength(JSON.stringify(value)) > 16384
  )
    return null;
  return record as ModerationRuleFollowupEnvelope;
}
