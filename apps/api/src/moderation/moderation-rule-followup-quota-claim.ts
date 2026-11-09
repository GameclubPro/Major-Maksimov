import { createHash } from 'node:crypto';
import { MESSAGE_COUNT_QUOTA_POLICY_VERSION } from './message-count-quota-policy';
import { ModerationRuleSanctionRejectedError } from './moderation-rule-sanction-authority';

export function buildMessageCountQuotaFollowupClaim(input: {
  chatId: string;
  userId: string;
  policySha256: string;
  metadata: unknown;
  nowMs: number;
}): { dedupeKey?: string; deadlineAtMs?: number } {
  const proof =
    input.metadata && typeof input.metadata === 'object' && !Array.isArray(input.metadata)
      ? (input.metadata as Record<string, unknown>)
      : {};
  if (
    proof.quotaPolicyVersion !== MESSAGE_COUNT_QUOTA_POLICY_VERSION ||
    proof.messageLimitEvidenceVersion !== 1 ||
    proof.messageLimitPolicySha256 !== input.policySha256
  )
    throw new ModerationRuleSanctionRejectedError();
  if (proof.quotaPublicationId === undefined) return {};
  const publicationId = proof.quotaPublicationId;
  const anchor = proof.quotaAnchorTimestampMs;
  const eventAt = proof.messageLimitEventTimestampMs;
  if (
    typeof publicationId !== 'string' ||
    !publicationId.trim() ||
    publicationId !== publicationId.trim() ||
    publicationId.length > 256 ||
    typeof anchor !== 'number' ||
    !Number.isSafeInteger(anchor) ||
    anchor <= 0 ||
    typeof eventAt !== 'number' ||
    !Number.isSafeInteger(eventAt) ||
    anchor > eventAt ||
    eventAt > input.nowMs ||
    input.nowMs >= anchor + 300_000
  )
    throw new ModerationRuleSanctionRejectedError();
  // FLAG: Only a verified stored quota source shares strike ownership across real messages.
  // Redis replay status cannot decide which successfully deleted album part owns the plan.
  // The original anchor distinguishes a fresh generation after its album ID is reused.
  const hash = createHash('sha256')
    .update(
      JSON.stringify([input.chatId, input.userId, 'MESSAGE_COUNT_LIMIT', publicationId, anchor]),
    )
    .digest('hex');
  return { dedupeKey: `quota-publication:v3:${hash}`, deadlineAtMs: anchor + 300_000 };
}
