export const CHAT_CONTEXT_INVALIDATION_REASONS = [
  'explicit',
  'access_granted',
  'access_denied',
  'access_grant_reused',
  'admin_list_changed',
  'title_changed',
  'legacy',
] as const;

export type ChatContextInvalidationReason = (typeof CHAT_CONTEXT_INVALIDATION_REASONS)[number];

export const CHAT_CONTEXT_ACTIVITY_FIELDS = [
  'coalescedLoads',
  'redisReads',
  'redisHits',
  'redisMisses',
  'redisReadUnavailable',
  'redisRevisionMisses',
  'redisDecodeFailures',
  'redisIncompatiblePayloads',
  'sourceLoads',
  'localInvalidationCalls',
  'remoteInvalidationCalls',
  'denialReplays',
  'grantsReused',
] as const;

export type ChatContextCacheActivitySnapshot = Record<
  (typeof CHAT_CONTEXT_ACTIVITY_FIELDS)[number],
  number
> & {
  invalidationsByReason: Record<
    ChatContextInvalidationReason,
    { events: number; evictedEntries: number }
  >;
};

export function createChatContextCacheActivity(): ChatContextCacheActivitySnapshot {
  return {
    ...Object.fromEntries(CHAT_CONTEXT_ACTIVITY_FIELDS.map((field) => [field, 0])),
    invalidationsByReason: Object.fromEntries(
      CHAT_CONTEXT_INVALIDATION_REASONS.map((reason) => [reason, { events: 0, evictedEntries: 0 }]),
    ),
  } as ChatContextCacheActivitySnapshot;
}

export function parseChatContextInvalidationReason(value: unknown): ChatContextInvalidationReason {
  return CHAT_CONTEXT_INVALIDATION_REASONS.includes(value as ChatContextInvalidationReason)
    ? (value as ChatContextInvalidationReason)
    : 'legacy';
}
