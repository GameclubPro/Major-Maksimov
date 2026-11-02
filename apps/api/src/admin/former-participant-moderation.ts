import {
  manualModerationActionResultSchema,
  type ManualModerationActionResult,
} from '@maxim/contracts';
import type { PrismaService } from '../prisma/prisma.service';
import type {
  ModerationSanctionStateFence,
  ModerationSanctionStateFenceService,
} from '../moderation/moderation-sanction-state-fence.service';
import {
  ModerationSanctionStateChangedError,
  type ModerationSanctionStateLeaseGuard,
} from '../moderation/moderation-sanction-state-lock.service';
import {
  LOCAL_CHAT_BAN_MODE,
  readActiveLocalChatBan,
  readLatestChatSanctionState,
} from '../moderation/local-chat-ban';

export async function readLocalChatBanForRelease(
  prisma: Pick<PrismaService, '$queryRaw'>,
  fence: Pick<ModerationSanctionStateFenceService, 'isSanctionEventInvalidated'>,
  chatId: string,
  userId: string,
) {
  const latest = await readLatestChatSanctionState(prisma, chatId, userId);
  if (
    !latest ||
    latest.action !== 'BAN' ||
    latest.ruleCode !== 'MANUAL_BAN' ||
    latest.operator !== 'ADMIN' ||
    !latest.metadata ||
    typeof latest.metadata !== 'object' ||
    Array.isArray(latest.metadata) ||
    latest.metadata.mode !== LOCAL_CHAT_BAN_MODE
  )
    return null;
  const active = await readActiveLocalChatBan(prisma, fence, chatId, userId);
  // FLAG: A fenced or concurrently replaced local ban cannot fall through to
  // native unban, which can otherwise remove or restore the wrong participant.
  if (active?.id !== latest.id) throw new ModerationSanctionStateChangedError();
  return active;
}

export async function hasFormerParticipantHistory(
  prisma: Pick<PrismaService, 'chatMembershipActivityFeedItem' | 'moderationEvent'>,
  chatId: string,
  userId: string,
): Promise<boolean> {
  const membership = await prisma.chatMembershipActivityFeedItem.findFirst({
    where: { chatId, userId },
    select: { canonicalKey: true },
  });
  if (membership) return true;
  const event = await prisma.moderationEvent.findFirst({
    where: { chatId, userId, ruleCode: { not: 'SANCTION_STATE_FENCE' } },
    select: { id: true },
  });
  return event !== null;
}

type LocalBanTransition = {
  leaseGuard: ModerationSanctionStateLeaseGuard;
  prepare(action: 'BAN' | 'UNBAN'): Promise<ModerationSanctionStateFence>;
  record(action: 'BAN' | 'UNBAN', metadata: Record<string, unknown>): Promise<string>;
  commit(fence: ModerationSanctionStateFence, eventId: string): Promise<void>;
  abort(fence: ModerationSanctionStateFence): Promise<void>;
  onRecorded?(eventId: string): void;
};

// FLAG: LOCAL_REJOIN is a local sanction. Neither assignment nor release may issue
// a native member mutation; enforcement owns a separate guarded KICK for each return.
export async function applyFormerParticipantModeration(
  action: 'BAN' | 'UNBAN',
  userId: string,
  transition: LocalBanTransition,
  metadata: Record<string, unknown> = {},
): Promise<ManualModerationActionResult> {
  await transition.leaseGuard.assertOwned();
  const fence = await transition.prepare(action);
  let eventId: string;
  try {
    await transition.leaseGuard.assertOwned();
    eventId = await transition.record(action, {
      ...metadata,
      mode: LOCAL_CHAT_BAN_MODE,
      ...(action === 'BAN' ? { permanent: true } : {}),
    });
  } catch (error: unknown) {
    await transition.abort(fence);
    throw error;
  }
  await transition.commit(fence, eventId);
  transition.onRecorded?.(eventId);
  return manualModerationActionResultSchema.parse({
    ok: true,
    action,
    userId,
    muteDurationHours: null,
    muteExpiresAt: null,
    message: action === 'BAN' ? 'Бан при возвращении включён.' : 'Бан снят.',
  });
}
