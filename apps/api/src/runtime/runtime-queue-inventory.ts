// FLAG: This is an import-free boundary shared by MAX transport and metrics.
// Importing decorated queue modules here creates a transport initialization cycle.
// runtime-queue-inventory.spec.ts verifies these names against their owning exports.
export const AUXILIARY_QUEUE_NAMES = [
  'message-retention',
  'admin-managed-entities-refresh',
  'vk-parsing-sync',
  'vk-parsing-publisher',
  'publisher-binding-refresh',
  'publisher-chat-comments',
  'publisher-post-import',
  'publisher-auto-replies',
  'publisher-auto-reply-authoring',
  'publisher-suggestion-publication',
  'publisher-publication-wakeup',
  'publisher-suggestion-admin',
  'publisher-start',
  'publisher-video-upload',
  'night-mode-transitions',
  'max-chat-admin-roster-sync',
  'admin-manual-fanout',
  'admin-manual-commands',
  'admin-super-ban',
  'admin-suggestion-delivery',
  'moderation-delete-intents',
  'message-duplicates',
  'commercial-image-ocr',
] as const;
export type AuxiliaryQueueName = (typeof AUXILIARY_QUEUE_NAMES)[number];

// FLAG: Dashboard omission is not cleanup admission. These queues still own work,
// including retired photo jobs whose drain performs bounded database settlement.
export const RETENTION_PRIORITY_ADDITIONAL_QUEUE_NAMES = [
  'marketplace-publisher-access',
  'photo-duplicates',
] as const;
