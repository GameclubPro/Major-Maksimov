import type { SafetyDeskGiveawayWinnerNotificationDeadEndItem } from '@maxim/contracts/safety-desk';

export function matchesGiveawayWinnerNotificationQuery(
  item: SafetyDeskGiveawayWinnerNotificationDeadEndItem,
  query: string,
): boolean {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) {
    return true;
  }

  return [
    item.notificationId,
    item.giveawayId,
    item.giveawayTitle,
    item.sourceChatId,
    item.winnerId,
    item.userId,
    item.botId ?? '',
    item.status,
    item.lastError ?? '',
  ]
    .join(' ')
    .toLowerCase()
    .includes(normalizedQuery);
}

export function giveawayWinnerNotificationEventAt(
  item: SafetyDeskGiveawayWinnerNotificationDeadEndItem,
): string {
  return item.ambiguousAt ?? item.dispatchedAt ?? item.updatedAt;
}
