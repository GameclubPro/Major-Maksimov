import type { SuggestionNativeJob } from '../publisher/suggestion-native.queue';
import type { QueueJobEnvelope, QueueRetryPolicyName } from '../common/queue-job-envelope';

export const ADMIN_SUGGESTION_DELIVERY_QUEUE = 'admin-suggestion-delivery';

export type AdminSuggestionDeliveryJob =
  | SuggestionNativeJob
  | { kind: 'review-effect'; effectId: string }
  | QueueJobEnvelope<
      {
        auditLogId: string;
      },
      {
        retryPolicyName?: Extract<QueueRetryPolicyName, 'suggestion-delivery'>;
      }
    >;
