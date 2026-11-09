import type { PrismaService } from '../prisma/prisma.service';
import type { ParticipantModerationImmunityService } from './participant-moderation-immunity.service';
import { fingerprintModerationSettings } from './moderation-settings-fingerprint';

export type ModerationRuleSanctionAuthority = {
  chatId: string;
  messageId: string;
  userId: string;
  reasonKey: string;
  ruleCode: string;
  policySha256: string;
  deadlineAtMs: number;
};

export type ModerationRuleMemberAccess = {
  userId: string | null;
  isAdmin: boolean | null;
  isOwner: boolean | null;
} | null;

export class ModerationRuleSanctionRejectedError extends Error {
  readonly code = 'moderation_rule_sanction_no_longer_authorized';
}

export async function assertModerationRuleSanctionAuthority(
  prisma: Pick<
    PrismaService,
    'chatSettings' | 'moderationDeleteIntent' | 'moderationDeleteIntentReason'
  >,
  proof: ModerationRuleSanctionAuthority,
  dependencies: {
    isKnownBotUserId: (userId: string) => boolean;
    getMemberAccess: () => Promise<ModerationRuleMemberAccess>;
    consumeImmunity: ParticipantModerationImmunityService['consumeForMessage'];
    beforeFinalAuthority?: () => Promise<void>;
    assertFinalOwnership?: () => Promise<void>;
    profanityRolloutMode?: 'legacy' | 'on';
  },
): Promise<void> {
  const reject = (): never => {
    throw new ModerationRuleSanctionRejectedError();
  };
  if (
    dependencies.isKnownBotUserId(proof.userId) ||
    !Number.isSafeInteger(proof.deadlineAtMs) ||
    Date.now() >= proof.deadlineAtMs
  )
    return reject();
  const load = async () => {
    const settings = await prisma.chatSettings.findUnique({
      where: { chatId: proof.chatId },
      include: {
        chat: {
          select: {
            entityType: true,
            admins: { where: { userId: proof.userId }, select: { userId: true } },
          },
        },
      },
    });
    if (
      !settings ||
      settings.chat.entityType !== 'CHAT' ||
      settings.chat.admins.length ||
      fingerprintModerationSettings(settings, proof.ruleCode, dependencies.profanityRolloutMode) !==
        proof.policySha256
    )
      return reject();
    return settings;
  };
  const settings = await load();
  const access = await dependencies.getMemberAccess();
  if (!access || access.isAdmin === true || access.isOwner === true) return reject();
  if (access.userId !== proof.userId || access.isAdmin !== false || access.isOwner !== false)
    throw new Error('Moderation sanction author access unavailable');
  // FLAG: Two exact unique probes bound lookup work independently of retained history.
  // The original source deadline and this reason's own verified DELETE receipt authorize
  // follow-up effects; another reason's success cannot authorize this notice or sanction.
  const intent = await prisma.moderationDeleteIntent.findUnique({
    where: { chatId_messageId: { chatId: proof.chatId, messageId: proof.messageId } },
    select: { id: true, status: true, subjectUserId: true, sourceMessageAt: true },
  });
  const sourceAtMs = intent?.sourceMessageAt?.getTime() ?? NaN;
  if (
    !intent ||
    intent.status !== 'SUCCEEDED' ||
    intent.subjectUserId !== proof.userId ||
    !Number.isSafeInteger(sourceAtMs) ||
    sourceAtMs <= 0 ||
    sourceAtMs > Date.now() ||
    sourceAtMs + 5 * 60_000 !== proof.deadlineAtMs
  )
    return reject();
  const reason = await prisma.moderationDeleteIntentReason.findUnique({
    where: { intentId_reasonKey: { intentId: intent.id, reasonKey: proof.reasonKey } },
    select: { ruleCode: true, userId: true, metadata: true },
  });
  const metadata = reason?.metadata;
  if (
    !reason ||
    reason.ruleCode !== proof.ruleCode ||
    (reason.userId !== null && reason.userId !== proof.userId) ||
    !metadata ||
    typeof metadata !== 'object' ||
    Array.isArray(metadata) ||
    metadata.moderationDeleteVerified !== true
  )
    return reject();
  // FLAG: A verified older DELETE cannot lend its receipt to a newer quota algorithm.
  if (
    proof.ruleCode.replace(/_DELETE$/u, '') === 'MESSAGE_COUNT_LIMIT' &&
    metadata.messageLimitPolicySha256 !== proof.policySha256
  )
    return reject();
  const reasonDeadlineAtMs = metadata.messageLimitDeadlineAtMs;
  if (
    reasonDeadlineAtMs !== undefined &&
    (!Number.isSafeInteger(reasonDeadlineAtMs) ||
      Number(reasonDeadlineAtMs) <= sourceAtMs ||
      Number(reasonDeadlineAtMs) > proof.deadlineAtMs ||
      Date.now() >= Number(reasonDeadlineAtMs))
  )
    return reject();
  if (
    (await dependencies.consumeImmunity({
      chatId: proof.chatId,
      userId: proof.userId,
      messageId: proof.messageId,
      scope: 'moderation-rule-sanction:v1',
      nightModeTimezone: settings.nightModeTimezone,
    })) === 'granted'
  )
    return reject();
  await dependencies.beforeFinalAuthority?.();
  await load();
  // FLAG: A blocked final policy read cannot lend an expired execution lease to HTTP.
  // This ownership-only fence must not introduce another remote route/policy await.
  await dependencies.assertFinalOwnership?.();
  if (
    Date.now() >= proof.deadlineAtMs ||
    (reasonDeadlineAtMs !== undefined && Date.now() >= Number(reasonDeadlineAtMs))
  )
    return reject();
}
