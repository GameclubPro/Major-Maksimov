import { REQUIRED_SUBSCRIPTION_MAX_CHANNELS } from '@maxim/contracts';
import type { PrismaService } from '../prisma/prisma.service';
import { WebhookParser } from '../webhook/webhook.parser';
import { parseWebhookEventTimestampMs } from '../webhook/webhook-event-timestamp';
import type { ParticipantModerationImmunityService } from './participant-moderation-immunity.service';
import type { ModerationRuleMemberAccess } from './moderation-rule-sanction-authority';
import { fingerprintModerationSettings } from './moderation-settings-fingerprint';

export type RequiredSubscriptionNoticeAuthority = {
  version: 1;
  chatId: string;
  messageId: string;
  userId: string;
  reasonKey: string;
  policySha256: string;
  sourceAtMs: number;
  deadlineAtMs: number;
};

export class RequiredSubscriptionNoticeRejectedError extends Error {
  readonly code = 'required_subscription_notice_no_longer_authorized';
}

// FLAG: Missing source evidence denies a notice; it never proves message deletion.
export class RequiredSubscriptionNoticeSourceUnavailableError extends Error {}

// FLAG: This allows only a durable, independently guarded SEND handoff.
// It grants no permission to dispatch, delete, or record delivered coverage itself.
export class RequiredSubscriptionNoticeReadDeferredError extends Error {}

// FLAG: Only the exact pre-send callback may establish that this handoff did not run.
// Unknown or attempted send failures must retain their existing execution fences.
export class RequiredSubscriptionNoticeNotDispatchedError extends Error {}

export function readRequiredSubscriptionNoticeAuthority(
  value: unknown,
): RequiredSubscriptionNoticeAuthority | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const keys = ['chatId', 'messageId', 'userId', 'reasonKey', 'policySha256'];
  if (
    row.version !== 1 ||
    row.reasonKey !== 'REQUIRED_SUBSCRIPTION:message-delete' ||
    Object.keys(row).length !== keys.length + 3 ||
    keys.some(
      (key) =>
        typeof row[key] !== 'string' ||
        !(row[key] as string).trim() ||
        (row[key] as string).length > 1_024,
    ) ||
    !/^[a-f0-9]{64}$/.test(String(row.policySha256)) ||
    !Number.isSafeInteger(row.sourceAtMs) ||
    Number(row.sourceAtMs) <= 0 ||
    !Number.isSafeInteger(row.deadlineAtMs) ||
    row.deadlineAtMs !== Number(row.sourceAtMs) + 5 * 60_000
  )
    return null;
  return row as RequiredSubscriptionNoticeAuthority;
}

export function buildRequiredSubscriptionNoticeAuthority(params: {
  chatId: string;
  messageId: string;
  userId: string;
  reasonKey: string;
  metadata: unknown;
}): RequiredSubscriptionNoticeAuthority {
  const metadata = asRecord(params.metadata);
  const proof = readRequiredSubscriptionNoticeAuthority({
    version: metadata.requiredSubscriptionGuardVersion,
    chatId: params.chatId,
    messageId: params.messageId,
    userId: params.userId,
    reasonKey: params.reasonKey,
    policySha256: metadata.requiredSubscriptionPolicySha256,
    sourceAtMs: metadata.requiredSubscriptionSourceAtMs,
    deadlineAtMs: metadata.requiredSubscriptionDeadlineAtMs,
  });
  if (!proof) throw new RequiredSubscriptionNoticeRejectedError();
  return proof;
}

export async function assertRequiredSubscriptionNoticeAuthority(
  prisma: Pick<
    PrismaService,
    'chatSettings' | 'moderationDeleteIntent' | 'moderationDeleteIntentReason'
  >,
  proof: RequiredSubscriptionNoticeAuthority,
  dependencies: {
    isKnownBotUserId: (userId: string) => boolean;
    getMemberAccess: () => Promise<ModerationRuleMemberAccess>;
    getSource: () => Promise<Record<string, unknown> | null>;
    getMembership: (targetId: string) => Promise<boolean>;
    consumeImmunity: ParticipantModerationImmunityService['consumeForMessage'];
    beforeFinalAuthority?: () => Promise<void>;
  },
): Promise<void> {
  const reject = (): never => {
    throw new RequiredSubscriptionNoticeRejectedError();
  };
  const assertDeadline = () => {
    if (
      !readRequiredSubscriptionNoticeAuthority(proof) ||
      proof.sourceAtMs > Date.now() ||
      Date.now() >= proof.deadlineAtMs
    )
      return reject();
  };
  assertDeadline();
  if (dependencies.isKnownBotUserId(proof.userId)) return reject();
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
      !settings.requiredSubscriptionEnabled ||
      fingerprintModerationSettings(settings, 'REQUIRED_SUBSCRIPTION') !== proof.policySha256
    )
      return reject();
    return settings;
  };
  const settings = await load();
  const values = settings.requiredSubscriptionChannelIds;
  if (
    !Array.isArray(values) ||
    values.some((target) => typeof target !== 'string' || !target.trim())
  )
    return reject();
  const targets = [...new Set(values.map((target) => String(target).trim()))];
  if (!targets.length || targets.length > REQUIRED_SUBSCRIPTION_MAX_CHANNELS) return reject();
  const access = await dependencies.getMemberAccess();
  if (!access || access.isAdmin === true || access.isOwner === true) return reject();
  if (access.userId !== proof.userId || access.isAdmin !== false || access.isOwner !== false)
    throw new Error('Required subscription notice author access unavailable');
  let source: Record<string, unknown> | null;
  let unavailable: RequiredSubscriptionNoticeSourceUnavailableError | undefined;
  try {
    source = await dependencies.getSource();
  } catch (error) {
    if (!(error instanceof RequiredSubscriptionNoticeSourceUnavailableError)) throw error;
    // FLAG: Unavailable source evidence is never absence. Only this exact reason's
    // independently committed DELETE receipt can supply the missing source authority.
    unavailable = error;
    source = null;
  }
  if (source) {
    const message = new WebhookParser().parse({
      type: 'message_created',
      updateId: 'required-subscription-notice-final',
      message: source,
    }).message;
    const createdAt =
      asRecord(source).timestamp ?? asRecord(source).createdAt ?? asRecord(source).created_at;
    const sourceCreatedAtMs = parseWebhookEventTimestampMs(createdAt);
    // FLAG: sourceAtMs is the immutable webhook event time, including edits. MAX
    // retains the message creation time; an older creation cannot renew this deadline.
    if (
      !message ||
      message.chatId !== proof.chatId ||
      message.messageId !== proof.messageId ||
      message.senderId !== proof.userId ||
      message.entityType === 'channel' ||
      sourceCreatedAtMs === null ||
      sourceCreatedAtMs <= 0 ||
      sourceCreatedAtMs > proof.sourceAtMs
    )
      return reject();
  } else {
    // FLAG: Queued notice handoff precedes DELETE. A missing source is authorized only by
    // this original reason's own receipt; another album member cannot lend source or time.
    const rejectSource = (): never => {
      if (unavailable) throw unavailable;
      return reject();
    };
    const intent = await prisma.moderationDeleteIntent.findUnique({
      where: { chatId_messageId: { chatId: proof.chatId, messageId: proof.messageId } },
      select: { id: true, status: true, subjectUserId: true, sourceMessageAt: true },
    });
    if (
      !intent ||
      intent.status !== 'SUCCEEDED' ||
      intent.subjectUserId !== proof.userId ||
      intent.sourceMessageAt?.getTime() !== proof.sourceAtMs
    )
      return rejectSource();
    const reason = await prisma.moderationDeleteIntentReason.findUnique({
      where: { intentId_reasonKey: { intentId: intent.id, reasonKey: proof.reasonKey } },
      select: { ruleCode: true, userId: true, metadata: true },
    });
    const binding = asRecord(reason?.metadata);
    if (
      !reason ||
      reason.ruleCode !== 'REQUIRED_SUBSCRIPTION_DELETE' ||
      (reason.userId !== null && reason.userId !== proof.userId) ||
      binding.moderationDeleteVerified !== true ||
      binding.requiredSubscriptionGuardVersion !== 1 ||
      binding.requiredSubscriptionPolicySha256 !== proof.policySha256 ||
      binding.requiredSubscriptionSourceAtMs !== proof.sourceAtMs ||
      binding.requiredSubscriptionDeadlineAtMs !== proof.deadlineAtMs
    )
      return rejectSource();
  }
  let missing = false;
  // FLAG: Bound target fanout, query every configured target freshly, and propagate unknown
  // access/transport errors. A successful negative is the only missing-subscription proof.
  for (let offset = 0; offset < targets.length; offset += 2) {
    assertDeadline();
    const results = await Promise.all(
      targets.slice(offset, offset + 2).map((target) => dependencies.getMembership(target)),
    );
    if (results.some((member) => typeof member !== 'boolean'))
      throw new Error('Required subscription notice fresh membership unavailable');
    if (results.some((member) => !member)) missing = true;
  }
  if (!missing) return reject();
  if (
    (await dependencies.consumeImmunity({
      chatId: proof.chatId,
      userId: proof.userId,
      messageId: proof.messageId,
      scope: 'required-subscription-final:v1',
      nightModeTimezone: settings.nightModeTimezone,
    })) === 'granted'
  )
    return reject();
  await dependencies.beforeFinalAuthority?.();
  await load();
  assertDeadline();
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
