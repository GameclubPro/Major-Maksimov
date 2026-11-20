import type { PrivateSession } from './private-control.types';

export type PrivateHandoffKind = 'broadcast' | 'giveaway' | 'rules' | 'profileMention';

type DeliveredHandoffState = {
  chatId: string | null;
  deliveredAt: number | null;
};

export function wasPrivateHandoffRecentlyDelivered(
  session: PrivateSession,
  kind: PrivateHandoffKind,
  chatId: string,
  windowMs: number,
  nowMs = Date.now(),
): boolean {
  const state = readDeliveredHandoffState(session, kind);
  if (!state.chatId || state.chatId !== chatId) {
    return false;
  }

  if (typeof state.deliveredAt !== 'number') {
    return false;
  }

  return nowMs - state.deliveredAt < windowMs;
}

export function clearPrivateHandoffDelivery(
  session: PrivateSession,
  kind: PrivateHandoffKind,
): void {
  writeDeliveredHandoffState(session, kind, {
    chatId: null,
    deliveredAt: null,
  });
}

export function markPrivateHandoffDelivered(
  session: PrivateSession,
  kind: PrivateHandoffKind,
  chatId: string | null,
  deliveredAtMs = Date.now(),
): void {
  writeDeliveredHandoffState(session, kind, {
    chatId,
    deliveredAt: deliveredAtMs,
  });
}

export function rememberPendingPrivateProfileMentionHandoff(
  session: PrivateSession,
  payload: { chatId: string; userId: string; displayName: string },
): void {
  session.pendingProfileMentionChatId = payload.chatId.trim() || null;
  session.pendingProfileMentionUserId = payload.userId.trim() || null;
  session.pendingProfileMentionDisplayName = payload.displayName.trim() || null;
}

export function readPendingPrivateProfileMentionDisplayName(
  session: PrivateSession,
  chatId: string,
  userId: string,
): string | null {
  if (
    session.pendingProfileMentionChatId !== chatId ||
    session.pendingProfileMentionUserId !== userId
  ) {
    return null;
  }

  return session.pendingProfileMentionDisplayName?.trim() || null;
}

export function clearPendingPrivateProfileMentionHandoff(session: PrivateSession): void {
  session.pendingProfileMentionChatId = null;
  session.pendingProfileMentionUserId = null;
  session.pendingProfileMentionDisplayName = null;
  session.pendingProfileMentionExpiresAt = null;
  session.pendingProfileMentionBotId = null;
}

function readDeliveredHandoffState(
  session: PrivateSession,
  kind: PrivateHandoffKind,
): DeliveredHandoffState {
  switch (kind) {
    case 'broadcast':
      return {
        chatId: session.lastBroadcastHandoffDeliveredChatId,
        deliveredAt: session.lastBroadcastHandoffDeliveredAt,
      };
    case 'giveaway':
      return {
        chatId: session.lastGiveawayHandoffDeliveredChatId,
        deliveredAt: session.lastGiveawayHandoffDeliveredAt,
      };
    case 'rules':
      return {
        chatId: session.lastRulesHandoffDeliveredChatId,
        deliveredAt: session.lastRulesHandoffDeliveredAt,
      };
    case 'profileMention':
      return {
        chatId: session.lastProfileMentionHandoffDeliveredChatId,
        deliveredAt: session.lastProfileMentionHandoffDeliveredAt,
      };
  }
}

function writeDeliveredHandoffState(
  session: PrivateSession,
  kind: PrivateHandoffKind,
  state: DeliveredHandoffState,
): void {
  switch (kind) {
    case 'broadcast':
      session.lastBroadcastHandoffDeliveredChatId = state.chatId;
      session.lastBroadcastHandoffDeliveredAt = state.deliveredAt;
      return;
    case 'giveaway':
      session.lastGiveawayHandoffDeliveredChatId = state.chatId;
      session.lastGiveawayHandoffDeliveredAt = state.deliveredAt;
      return;
    case 'rules':
      session.lastRulesHandoffDeliveredChatId = state.chatId;
      session.lastRulesHandoffDeliveredAt = state.deliveredAt;
      return;
    case 'profileMention':
      session.lastProfileMentionHandoffDeliveredChatId = state.chatId;
      session.lastProfileMentionHandoffDeliveredAt = state.deliveredAt;
      return;
  }
}
