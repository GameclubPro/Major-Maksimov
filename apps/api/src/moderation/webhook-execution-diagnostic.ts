import type { Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { describeWebhookPreparationFailure } from '../webhook/webhook-preparation-diagnostic';
import { readDuplicateLookupFailure } from './message-duplicate/message-duplicate-lookup-diagnostic';
import { readModerationGuardFailure } from './moderation-guard-failure-diagnostic';

export type WebhookExecutionFailureStage =
  | 'preparation'
  | 'handler'
  | 'completion'
  | 'ocr_activation';

export function logWebhookExecutionFailure(
  logger: Pick<Logger, 'warn'>,
  stage: WebhookExecutionFailureStage,
  error: unknown,
  hotPathStage?: unknown,
  webhookEventId?: unknown,
): void {
  logger.warn(
    {
      stage,
      eventRef: webhookDiagnosticReference(webhookEventId),
      ...describeWebhookExecutionFailure(error, hotPathStage),
    },
    'Webhook execution failed before recovery settlement',
  );
}

// FLAG: Correlate the first failure with later settlement without emitting receipt,
// participant or chat identities, source text, tokens or arbitrary exception fields.
export function webhookDiagnosticReference(webhookEventId: unknown): string | null {
  if (
    typeof webhookEventId !== 'string' ||
    webhookEventId.length === 0 ||
    webhookEventId.length > 128
  )
    return null;
  return createHash('sha256').update(webhookEventId).digest('hex').slice(0, 24);
}

const HOT_PATH_STAGES = new Set([
  'start',
  'active-mute',
  'admin-check',
  'admin-command',
  'chat-context',
  'developer-forced-global-spammer',
  'duplicate-admin-recheck',
  'duplicate-delete',
  'duplicate-follow-up',
  'duplicate-sanction',
  'global-spammer-exempt',
  'global-spammer-track',
  'invitation-access',
  'invitation-access.delete',
  'known-spammer-check',
  'message-duplicate.observe',
  'message-duplicate.complete',
  'report-submission',
  'report-submission.complete',
  'required-subscription',
  'required-subscription.delete',
  'required-subscription.delete-authority',
  'required-subscription.follow-up',
  'required-subscription.sanction',
  'required-subscription.notice-plan',
  'required-subscription.notice-handoff',
  'required-subscription.initial-authority',
  'required-subscription.membership',
  'rule-engine',
  'rule-engine.detect',
  'rule-engine.commercial-campaign',
  'system-mode',
  'violation-admin-recheck',
  'violation-delete',
  'violation-follow-up',
  'violation-record',
  'violation-rule-followup.persist',
  'violation-rule-followup.complete',
]);

const LOCAL_FAILURES = new Map([
  ['MAX_API_INTERNAL_RATE_LIMIT', 'max_internal_rate_limit'],
  ['MAX_API_CIRCUIT_OPEN', 'max_circuit_open'],
  ['max_action_executor_proof_rejected', 'executor_proof_rejected'],
  ['Message limit state deadline exceeded', 'message_limit_state_deadline'],
  ['Media cooldown state deadline exceeded', 'media_cooldown_state_deadline'],
  ['DUPLICATE_STATE_BUDGET_EXCEEDED', 'duplicate_state_budget'],
  ['DUPLICATE_WINDOW_CAPACITY_EXCEEDED', 'duplicate_history_local_capacity'],
  ['Message duplicate history deadline exceeded', 'duplicate_history_reply_deadline'],
  ['Message duplicate window deadline exceeded', 'duplicate_history_admission_deadline'],
  ['required_subscription_no_longer_authorized', 'subscription_authority_rejected'],
  ['required_subscription_notice_no_longer_authorized', 'subscription_authority_rejected'],
  ['Required subscription source no longer actionable', 'subscription_source_unavailable'],
  ['Required subscription fresh membership unavailable', 'subscription_membership_unavailable'],
  [
    'Required subscription notice fresh membership unavailable',
    'subscription_membership_unavailable',
  ],
  ['Required subscription author access unavailable', 'subscription_author_unavailable'],
  ['Required subscription notice author access unavailable', 'subscription_author_unavailable'],
  ['Required subscription execution guard unavailable', 'subscription_guard_unavailable'],
]);
const MAX_FAILURE_CODES = new Map([
  ['not.found', 'generic_not_found'],
  ['message.not.found', 'message_not_found'],
  ['message_not_found', 'message_not_found'],
  ['message.not_found', 'message_not_found'],
  ['chat.denied', 'chat_denied'],
  ['chat.not.found', 'chat_not_found'],
]);

export function describeWebhookExecutionFailure(error: unknown, hotPathStage?: unknown) {
  const basic = describeWebhookPreparationFailure(error);
  let requestOperation = 'unknown';
  let requestTarget = 'unknown';
  let failureReason = 'unknown';
  let maxFailureCode = 'unknown';
  const locations: Record<string, { format: string; line: number; column: number }> = {};
  try {
    // FLAG: Only exact local reasons and known MAX codes may leave the original error.
    // Unknown message/body fields remain private and must never become diagnostic labels.
    const record = error as {
      code?: unknown;
      message?: unknown;
      response?: { data?: { code?: unknown; error?: { code?: unknown } } };
    } | null;
    for (const value of [record?.code, record?.message]) {
      if (typeof value === 'string' && LOCAL_FAILURES.has(value)) {
        failureReason = LOCAL_FAILURES.get(value)!;
        break;
      }
    }
    const body = record?.response?.data;
    if (body && !Array.isArray(body)) {
      const code = body.code ?? body.error?.code;
      if (typeof code === 'string') maxFailureCode = MAX_FAILURE_CODES.get(code) ?? 'unknown';
    }
  } catch {
    // Diagnostic reads never replace the original failure.
  }
  try {
    // FLAG: Preserve the first failure without logging messages, identities, arbitrary paths
    // or stack text. Later canonical recovery may replace the receipt's original error.
    const stack =
      error instanceof Error && typeof error.stack === 'string' ? error.stack.slice(0, 16_384) : '';
    const knownSources = {
      handler: /\/moderation\/moderation\.service\.legacy\.(js|ts):([0-9]{1,7}):([0-9]{1,5})\b/u,
      canonical:
        /\/moderation\/webhook-canonical-execution\.service\.(js|ts):([0-9]{1,7}):([0-9]{1,5})\b/u,
      channelMarker:
        /\/moderation\/replacement-attach-marker\.store\.(js|ts):([0-9]{1,7}):([0-9]{1,5})\b/u,
      subscriptionGuard:
        /\/moderation\/required-subscription-execution-guard\.service\.(js|ts):([0-9]{1,7}):([0-9]{1,5})\b/u,
      guardCallbacks:
        /\/moderation\/moderation-execution-guard-callbacks\.(js|ts):([0-9]{1,7}):([0-9]{1,5})\b/u,
      ruleEngine: /\/moderation\/rule-engine\.service\.impl\.(js|ts):([0-9]{1,7}):([0-9]{1,5})\b/u,
      messageLimits:
        /\/moderation\/rule-engine-message-limits\.detector\.(js|ts):([0-9]{1,7}):([0-9]{1,5})\b/u,
      duplicateState:
        /\/moderation\/rule-engine-duplicate-detector\.(js|ts):([0-9]{1,7}):([0-9]{1,5})\b/u,
      duplicateHistory:
        /\/moderation\/message-duplicate\/message-duplicate-history\.service\.(js|ts):([0-9]{1,7}):([0-9]{1,5})\b/u,
      redisCounter: /\/moderation\/redis-counter\.service\.(js|ts):([0-9]{1,7}):([0-9]{1,5})\b/u,
      maxClient: /\/max\/max-client\.service\.(js|ts):([0-9]{1,7}):([0-9]{1,5})\b/u,
      actionLedger: /\/max\/max-action-ledger\.service\.(js|ts):([0-9]{1,7}):([0-9]{1,5})\b/u,
      deleteIntent:
        /\/moderation\/moderation-delete-intent\.service\.(js|ts):([0-9]{1,7}):([0-9]{1,5})\b/u,
    };
    for (const [name, pattern] of Object.entries(knownSources)) {
      const match = pattern.exec(stack);
      if (match)
        locations[name] = { format: match[1], line: Number(match[2]), column: Number(match[3]) };
    }
    // Axios stacks may contain only HTTP-library frames. Classify its route in memory;
    // never retain URLs, parameters, headers, bodies or remote identifiers.
    const config = (error as { config?: { method?: unknown; url?: unknown } } | null)?.config;
    if (
      typeof config?.method === 'string' &&
      typeof config.url === 'string' &&
      config.url.length <= 2048
    ) {
      const method = config.method.toUpperCase();
      const path = new URL(config.url, 'https://platform-api.max.ru').pathname;
      const route = /^\/messages(?:\/[^/]+)?$/u.test(path)
        ? 'messages'
        : /^\/chats\/[^/]+\/members(?:\/[^/]+)?$/u.test(path)
          ? 'members'
          : /^\/chats\/[^/]+$/u.test(path)
            ? 'chat'
            : null;
      if (route && ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
        requestOperation = `${method.toLowerCase()}_${route}`;
        if (route === 'messages') requestTarget = path === '/messages' ? 'collection' : 'single';
      }
    }
  } catch {
    // Error getters must not replace the original failure or interfere with settlement.
  }
  return {
    ...basic,
    ...readDuplicateLookupFailure(error),
    ...readModerationGuardFailure(error),
    locations,
    requestOperation,
    requestTarget,
    failureReason,
    maxFailureCode,
    hotPathStage:
      typeof hotPathStage === 'string' && HOT_PATH_STAGES.has(hotPathStage)
        ? hotPathStage
        : 'unknown',
  };
}
