import type {
  ChatParticipantDetails,
  ChatParticipantItem,
  LogsDashboardRange,
} from '@maxim/contracts';

export function participantCapabilities(
  item: ChatParticipantItem | ChatParticipantDetails,
  detailsReady: boolean,
): { canManage: boolean; canMute: boolean; canBan: boolean } {
  const verified =
    detailsReady &&
    !item.isBot &&
    item.role !== 'admin' &&
    item.role !== 'owner' &&
    (!('membershipStatus' in item) || item.membershipStatus !== 'unknown');
  const canManage =
    verified &&
    (!('membershipStatus' in item) || item.membershipStatus === 'member') &&
    ('canManage' in item ? item.canManage : item.role === 'member');
  return {
    canManage,
    canMute: verified && ('canMute' in item ? (item.canMute ?? canManage) : canManage),
    canBan: verified && ('canBan' in item ? (item.canBan ?? canManage) : canManage),
  };
}

export type ParticipantCardTarget = Pick<ChatParticipantItem, 'userId' | 'userDisplayName'> & {
  chatId: string;
  avatarUrl?: string | null;
  username?: string | null;
  profileUrl?: string | null;
  profileHandoffUrl?: string | null;
  origin?: { title: string; date?: string; reason?: string | null };
};

export const participantDetailsKey = (
  chatId: string,
  userId: string,
  range?: LogsDashboardRange,
) =>
  range ? ['participant-details', chatId, userId, range] : ['participant-details', chatId, userId];
