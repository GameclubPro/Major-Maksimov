import type { QueueJobEnvelope, QueueRetryPolicyName } from '../common/queue-job-envelope';

export const MAX_CHAT_ADMIN_ROSTER_SYNC_QUEUE = 'max-chat-admin-roster-sync';

export const MANAGED_ENTITY_ACCESS_LOSS_CLEANUP_JOB_KIND =
  'managed_entity_access_loss_cleanup' as const;

export type ManagedEntityAccessLossCleanupReason =
  | 'chat_not_found'
  | 'bot_denied'
  | 'bot_removed'
  | 'chat_inaccessible';

export type MaxChatAdminRosterSyncJob = QueueJobEnvelope<
  {
    chatId: string;
    targetUserId?: string;
    requiredCheckedAfter?: string;
    botIds?: string[];
    title?: string | null;
    entityType?: 'chat' | 'channel' | null;
    source?:
      | 'webhook_bot_added'
      | 'webhook_bot_removed'
      | 'webhook_chat_title_changed'
      | 'webhook_membership_churn'
      | 'handshake_start'
      | 'moderation_destructive_path'
      | 'admin_access_validation'
      | 'active_chat'
      | 'discovery_snapshot'
      | null;
    retryUntilMs?: number | null;
  },
  {
    retryPolicyName?: Extract<QueueRetryPolicyName, 'chat-admin-roster-sync'>;
  }
>;

export type ManagedEntityAccessLossCleanupJob = QueueJobEnvelope<{
  kind: typeof MANAGED_ENTITY_ACCESS_LOSS_CLEANUP_JOB_KIND;
  chatId: string;
  botId: string;
  lifecycleEventAt: string;
  lifecycleEventType: string;
  lifecycleSource: string;
  reason: ManagedEntityAccessLossCleanupReason;
  source: string;
}>;

export type MaxChatAdminRosterQueueJob =
  | MaxChatAdminRosterSyncJob
  | ManagedEntityAccessLossCleanupJob;

export function isManagedEntityAccessLossCleanupJob(
  job: MaxChatAdminRosterQueueJob,
): job is ManagedEntityAccessLossCleanupJob {
  return 'kind' in job && job.kind === MANAGED_ENTITY_ACCESS_LOSS_CLEANUP_JOB_KIND;
}
