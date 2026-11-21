export const ACTIVE_MUTE_NEGATIVE_CACHE_TTL_SEC = 10;
export const ACTIVE_MUTE_CACHE_SLACK_SEC = 60;
export const PERMANENT_ACTIVE_MUTE_CACHE_TTL_SEC = 24 * 60 * 60;

export type CachedActiveMuteState = {
  eventId: string;
  issuedAt: string;
  expiresAt: string | null;
  durationHours: number | null;
  permanent?: boolean;
  ordinaryManualMuteVerified?: true;
  ruleCode?: string | null;
};

export function buildActiveMuteStateKey(chatId: string, userId: string): string {
  return `moderation:active-mute:v1:${chatId}:${userId}`;
}
