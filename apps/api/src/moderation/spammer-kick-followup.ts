import { createHash } from 'node:crypto';
import { Prisma, type ModerationRuleFollowup } from '../prisma/prisma-client';
import type { PrismaService } from '../prisma/prisma.service';
import type { MaxClientService } from '../max/max-client.service';
import { MAX_MEMBER_ACTION_PRE_DISPATCH_RETRY_ERROR_CODES } from '../max/max-action-ledger.service';
import { wasMaxPreDispatchGuardRejected } from '../max/max-action-pre-dispatch-guard';
import { ModerationStateDeleteRejectedError } from './moderation-state-delete-guard.service';
import {
  buildMessageScopedModerationActionClaimKey,
  buildModerationMessageViolationProcessingClaimKey,
} from './moderation-message-action-claim';
import { readRuleFollowupEnvelope } from './moderation-rule-followup-persistence';

const globalRule = 'GLOBAL_SPAMMER_MESSAGE_DELETE';
const localRule = 'LOCAL_ADMIN_BLOCK_MESSAGE_DELETE';
const hash = (values: readonly string[]) =>
  createHash('sha256').update(JSON.stringify(values)).digest('hex');
export const isSpammerKickRule = (rule: string) => rule === globalRule || rule === localRule;

export function spammerMessageKickKey(chatId: string, userId: string, messageId: string) {
  return 'spammer-message-kick:v1:' + hash([chatId, userId, messageId]);
}

export function spammerKickPolicySha256(ruleCode: string) {
  return hash(['spammer-message-kick-policy:v1', ruleCode, 'deleteSpammersEnabled']);
}

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

function matchesSource(row: ModerationRuleFollowup, reason: unknown): boolean {
  if (row.ruleCode === localRule)
    return (
      row.reasonKey === 'LOCAL_ADMIN_BLOCK:message-delete' &&
      reason === 'Local admin block for this admin scope'
    );
  return (
    row.ruleCode === globalRule &&
    ((row.reasonKey === 'GLOBAL_SPAMMER:known-message-delete' &&
      reason === 'Sender exists in global spammer registry') ||
      (row.reasonKey === 'GLOBAL_SPAMMER:detected-message-delete' &&
        reason === 'Detected in 6 unique chats within 2 minutes'))
  );
}

type Status = 'COMPLETED' | 'CANCELLED' | 'EXPIRED' | 'AMBIGUOUS' | 'RETRYABLE';
export type SpammerKickDispatch = (
  key: string,
  assertFinalOwnership: () => Promise<void>,
) => Promise<void>;
type Dependencies = {
  db: PrismaService;
  max: Pick<MaxClientService, 'getExplicitActionJobId'>;
  dispatch: SpammerKickDispatch;
  isHeld: (tx: Prisma.TransactionClient) => Promise<boolean>;
};

// FLAG: Inline and durable owners share the original message_action unique constraint.
// A claim left by another rule, an old process or another reason is never adopted.
export async function executeSpammerKickFollowup(
  row: ModerationRuleFollowup,
  leaseToken: string,
  receiptOnly: boolean,
  { db, max, dispatch, isHeld }: Dependencies,
): Promise<Status> {
  const key = spammerMessageKickKey(row.chatId, row.userId, row.messageId);
  const claimInput = {
    chatId: row.chatId,
    userId: row.userId,
    messageId: row.messageId,
    ruleCode: row.ruleCode === localRule ? 'LOCAL_ADMIN_BLOCK' : 'GLOBAL_SPAMMER_KICK',
    updateType: 'message_action',
  };
  const messageActionKey = buildMessageScopedModerationActionClaimKey(row.chatId, row.messageId);
  const dedupeKey = buildModerationMessageViolationProcessingClaimKey(claimInput).dedupeKey;
  const claimId = row.id + ':kick-claim';
  const eventId = row.id + ':decision';
  const expectedId = 'mrf-v1-' + hash([row.intentId, row.reasonKey]);
  const phase = asRecord(row.effects).phase ?? 'UNSTARTED';
  const historical = phase !== 'UNSTARTED';
  const unavailable: Status = historical ? 'AMBIGUOUS' : 'CANCELLED';
  if (
    row.id !== expectedId ||
    row.policySha256 !== spammerKickPolicySha256(row.ruleCode) ||
    row.deadlineAt.getTime() !== row.sourceAt.getTime() + 300000 ||
    !readRuleFollowupEnvelope(row.envelope)
  )
    return unavailable;

  async function exactDeletion(tx: Prisma.TransactionClient) {
    const owned = await tx.moderationDeleteIntent.findUnique({
      where: { id: row.intentId },
      select: {
        chatId: true,
        messageId: true,
        subjectUserId: true,
        sourceMessageAt: true,
        entityType: true,
        messageAuthorKind: true,
        status: true,
        remoteDeleteSucceededAt: true,
        remoteDeleteSucceededBotId: true,
        reasons: {
          where: { reasonKey: row.reasonKey },
          select: { userId: true, ruleCode: true, metadata: true },
        },
      },
    });
    const reason = owned?.reasons[0],
      metadata = asRecord(reason?.metadata);
    return (
      owned?.status === 'SUCCEEDED' &&
      owned.chatId === row.chatId &&
      owned.messageId === row.messageId &&
      owned.subjectUserId === row.userId &&
      owned.sourceMessageAt?.getTime() === row.sourceAt.getTime() &&
      owned.entityType === 'CHAT' &&
      owned.messageAuthorKind === 'user' &&
      !!owned.remoteDeleteSucceededAt &&
      row.createdAt >= row.sourceAt &&
      row.createdAt <= owned.remoteDeleteSucceededAt &&
      owned.remoteDeleteSucceededAt <= row.deadlineAt &&
      !!owned.remoteDeleteSucceededBotId &&
      reason?.userId === row.userId &&
      reason.ruleCode === row.ruleCode &&
      metadata.moderationDeleteVerified === true &&
      matchesSource(row, metadata.reason)
    );
  }
  async function lockOwned(tx: Prisma.TransactionClient, fresh: boolean) {
    const owned = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`
      SELECT id FROM moderation_rule_followups WHERE id=${row.id} AND status='IN_PROGRESS' AND lease_token=${leaseToken}
        AND lease_expires_at > (clock_timestamp() AT TIME ZONE 'UTC')
        ${fresh ? Prisma.sql`AND deadline_at > (clock_timestamp() AT TIME ZONE 'UTC')` : Prisma.empty}
        FOR UPDATE`);
    if (!owned.length) throw new Error('Spammer KICK lease or source deadline lost');
  }
  async function ownsClaim(tx: Prisma.TransactionClient) {
    const claim = await tx.moderationViolationMessageClaim.findUnique({
      where: { messageActionKey },
    });
    return (
      claim?.id === claimId &&
      claim.dedupeKey === dedupeKey &&
      claim.userId === row.userId &&
      claim.chatId === row.chatId &&
      claim.messageId === row.messageId &&
      claim.ruleCode === claimInput.ruleCode &&
      claim.updateType === claimInput.updateType
    );
  }
  const plan = asRecord(row.actionPlan);
  const validPlan = plan.version === 1 && plan.action === 'KICK' && plan.actionKey === key;
  if (row.actionPlan !== null && !validPlan) return unavailable;
  if (
    !['UNSTARTED', 'KICK_STARTED', 'UNKNOWN', 'SETTLED'].includes(String(phase)) ||
    (historical && (!validPlan || asRecord(row.effects).actionKey !== key))
  )
    return unavailable;

  const start = await db.$transaction(async (tx) => {
    await lockOwned(tx, false);
    if (!(await exactDeletion(tx)) || (await isHeld(tx))) return unavailable;
    if (row.actionPlan !== null && !(await ownsClaim(tx))) return unavailable;
    if (historical) return 'RECOVER';
    if (receiptOnly || Date.now() >= row.deadlineAt.getTime()) return 'EXPIRED';
    if (row.actionPlan === null) {
      const inserted = await tx.moderationViolationMessageClaim.createMany({
        data: [{ ...claimInput, id: claimId, messageActionKey, dedupeKey }],
        skipDuplicates: true,
      });
      if (!inserted.count) return 'CANCELLED';
    }
    await lockOwned(tx, true);
    await tx.moderationRuleFollowup.update({
      where: { id: row.id },
      data: {
        actionPlan: { version: 1, action: 'KICK', actionKey: key },
        effects: { phase: 'KICK_STARTED', actionKey: key },
      },
    });
    return 'DISPATCH';
  });
  if (start !== 'DISPATCH' && start !== 'RECOVER') return start;

  async function checkpoint(nextPhase: string) {
    await db.$transaction(async (tx) => {
      await lockOwned(tx, false);
      await tx.moderationRuleFollowup.update({
        where: { id: row.id },
        data: { effects: { phase: nextPhase, actionKey: key } },
      });
    });
  }
  let rejectedBeforeDispatch = false;
  let authorityRevoked = false;
  if (start === 'DISPATCH') {
    try {
      await dispatch(key, async () =>
        db.$transaction(async (tx) => {
          await lockOwned(tx, true);
          if (!(await ownsClaim(tx)) || !(await exactDeletion(tx)) || (await isHeld(tx)))
            throw new ModerationStateDeleteRejectedError();
        }),
      );
    } catch (error) {
      rejectedBeforeDispatch = wasMaxPreDispatchGuardRejected(error);
      authorityRevoked = error instanceof ModerationStateDeleteRejectedError;
    }
  }

  // FLAG: Missing ledger or current membership is not a KICK receipt. UNKNOWN can only
  // settle from the exact positive ledger. Membership changes never authorize a replay.
  const ledger = await db.maxActionLedgerEntry.findUnique({
    where: { jobId: max.getExplicitActionJobId('KICK_MEMBER', key) },
  });
  const exact =
    ledger?.actionType === 'KICK_MEMBER' &&
    ledger.chatId === row.chatId &&
    ledger.userId === row.userId;
  const botId = ledger?.dispatchBotId ?? ledger?.botId;
  if (exact && ledger.status === 'SUCCEEDED' && ledger.completedAt && !ledger.ambiguous && botId) {
    const completedAt = ledger.completedAt;
    return db.$transaction(async (tx) => {
      await lockOwned(tx, false);
      if (!(await ownsClaim(tx)) || !(await exactDeletion(tx)) || (await isHeld(tx)))
        return 'AMBIGUOUS';
      await tx.moderationEvent.createMany({
        data: [
          {
            id: eventId,
            chatId: row.chatId,
            userId: row.userId,
            messageId: row.messageId,
            botId,
            ruleCode: claimInput.ruleCode,
            action: 'KICK',
            operator: 'BOT',
            eventType: 'MEMBER_ACTION',
            score: 0.95,
            createdAt: completedAt,
            metadata: { spammerKickFollowupId: row.id, sourceReasonKey: row.reasonKey },
          },
        ],
        skipDuplicates: true,
      });
      const event = await tx.moderationEvent.findUniqueOrThrow({ where: { id: eventId } });
      if (
        event.action !== 'KICK' ||
        event.eventType !== 'MEMBER_ACTION' ||
        event.operator !== 'BOT' ||
        event.botId !== botId ||
        event.chatId !== row.chatId ||
        event.userId !== row.userId ||
        event.messageId !== row.messageId ||
        event.ruleCode !== claimInput.ruleCode ||
        asRecord(event.metadata).spammerKickFollowupId !== row.id
      )
        throw new Error('Spammer KICK event receipt conflict');
      await tx.moderationRuleFollowup.update({
        where: { id: row.id },
        data: { effects: { phase: 'SETTLED', actionKey: key, eventId } },
      });
      return 'COMPLETED';
    });
  }
  const provenNoEffect =
    exact &&
    !ledger.ambiguous &&
    !ledger.dispatchStartedAt &&
    !!ledger.lastErrorCode &&
    MAX_MEMBER_ACTION_PRE_DISPATCH_RETRY_ERROR_CODES.includes(ledger.lastErrorCode as never);
  if (
    !receiptOnly &&
    phase !== 'UNKNOWN' &&
    phase !== 'SETTLED' &&
    (provenNoEffect || (rejectedBeforeDispatch && !ledger))
  ) {
    await checkpoint('UNSTARTED');
    if (authorityRevoked) return 'CANCELLED';
    return Date.now() >= row.deadlineAt.getTime() ? 'EXPIRED' : 'RETRYABLE';
  }
  await checkpoint('UNKNOWN');
  return 'AMBIGUOUS';
}
