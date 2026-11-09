import { UnrecoverableError } from 'bullmq';
import { AsyncLocalStorage } from 'node:async_hooks';
import { readMessageDuplicateNoticeProof } from '../moderation/message-duplicate/message-duplicate-notice-proof';
import { readRequiredSubscriptionNoticeAuthority } from '../moderation/required-subscription-notice-authority';
import { wasMaxPreDispatchGuardRejected } from './max-action-pre-dispatch-guard';
import { MaxApiInternalRateLimitError } from './max-api-internal-rate-limit.error';
import type { MaxActionJob } from './max-client.service';
import { MaxModerationApiBudgetError } from './max-moderation-api-budget';
import { readMaxModerationRuleNoticeProof } from './max-moderation-rule-notice-proof';
import {
  isMaxMutationOutcomeAmbiguous,
  wasMaxMessageSendAttempted,
} from './max-mutation-outcome.util';

type SendCapacityAttempt = { action: MaxActionJob; botId: string };
const currentSend = new AsyncLocalStorage<SendCapacityAttempt>();
const limiterRefusals = new WeakMap<object, SendCapacityAttempt>();
const sendRefusals = new WeakMap<object, { jobId: string; chatId: string; botId: string }>();
const issuedDeferrals = new WeakMap<
  object,
  { jobId: string; chatId: string; retryAtMs: number; deadlineAtMs: number }
>();
const MIN_CAPACITY_DELAY_MS = 250;

function isCapacityRefusal(error: unknown): error is MaxApiInternalRateLimitError {
  return (
    error instanceof MaxApiInternalRateLimitError &&
    !(error instanceof MaxModerationApiBudgetError) &&
    error.limitScope !== 'moderation_protection' &&
    Number.isSafeInteger(error.retryAfterMs) &&
    error.retryAfterMs > 0 &&
    !(error as { response?: unknown }).response &&
    !wasMaxMessageSendAttempted(error) &&
    !isMaxMutationOutcomeAmbiguous(error)
  );
}

// FLAG: Each POST gets its own invocation identity. Nested GET reservations may
// share this scope but cannot nominate a SEND capacity refusal.
export function runWithMaxSendCapacityAttempt<T>(
  action: MaxActionJob,
  botId: string,
  run: () => Promise<T>,
): Promise<T> {
  return currentSend.run({ action, botId }, run);
}

// FLAG: Called only where the shared limiter actually refuses admission. Error
// shape, code and diagnostic scope cannot nominate a new SEND attempt themselves.
export function markMaxApiCapacityRefusal<T>(
  error: T,
  reservation: { botId: string; chatId: string | null; operation?: string },
): T {
  const scope = currentSend.getStore();
  if (
    scope &&
    reservation.operation === 'send' &&
    scope.botId === reservation.botId &&
    scope.action.chatId === reservation.chatId &&
    isCapacityRefusal(error)
  )
    limiterRefusals.set(error, scope);
  return error;
}

// FLAG: The SEND caller certifies only after releasing its exact unattempted
// dispatch fence, or before acquiring one. An unknown release never reaches here.
export function certifyMaxSendCapacityDeferral(
  error: unknown,
  action: MaxActionJob,
  botId: string,
): void {
  const origin = error && typeof error === 'object' ? limiterRefusals.get(error) : undefined;
  if (error && typeof error === 'object') {
    limiterRefusals.delete(error);
    sendRefusals.delete(error);
  }
  if (
    !isCapacityRefusal(error) ||
    origin?.action !== action ||
    origin.botId !== botId ||
    !wasMaxPreDispatchGuardRejected(error) ||
    action.actionType !== 'SEND_MESSAGE' ||
    !action.idempotencyKey.trim() ||
    !action.chatId.trim() ||
    !botId.trim()
  )
    return;
  sendRefusals.set(error, {
    jobId: action.idempotencyKey,
    chatId: action.chatId,
    botId,
  });
}

// FLAG: A parsed deadline is a scheduling ceiling, never execution authority.
// The existing final SQL/source/policy guards still run on every worker entry.
export function readMaxSendCapacityDeadline(action: MaxActionJob): number | null {
  if (action.actionType !== 'SEND_MESSAGE' || action.sourceTag !== 'moderation_notice') return null;
  const context = action.ledgerContext;
  if (!context) return null;
  const deadlines: number[] = [];
  if (Object.hasOwn(context, 'moderationRuleNotice')) {
    const proof = readMaxModerationRuleNoticeProof(context.moderationRuleNotice);
    if (!proof || proof.chatId !== action.chatId || proof.deadlineAtMs <= 0) return null;
    deadlines.push(proof.deadlineAtMs);
  }
  if (Object.hasOwn(context, 'requiredSubscriptionNotice')) {
    const proof = readRequiredSubscriptionNoticeAuthority(context.requiredSubscriptionNotice);
    if (!proof || proof.chatId !== action.chatId) return null;
    deadlines.push(proof.deadlineAtMs);
  }
  if (Object.hasOwn(context, 'duplicateNotice')) {
    const proof = readMessageDuplicateNoticeProof(context.duplicateNotice);
    const sourceAtMs = proof?.binding.authorization?.eventTimestampMs;
    if (
      !proof ||
      proof.chatId !== action.chatId ||
      !Number.isSafeInteger(sourceAtMs) ||
      proof.deadlineAtMs > Number(sourceAtMs) + 10 * 60_000
    )
      return null;
    deadlines.push(proof.deadlineAtMs);
  }
  return deadlines.length ? Math.min(...deadlines) : null;
}

export class MaxSendCapacityDeferralError extends Error {
  constructor(
    readonly jobId: string,
    readonly retryAtMs: number,
    readonly deadlineAtMs: number,
  ) {
    super('Unattempted MAX notice SEND is waiting for shared transport capacity');
    this.name = 'MaxSendCapacityDeferralError';
  }
}

export class MaxSendCapacityDeadlineError extends UnrecoverableError {
  constructor() {
    super('MAX notice SEND has no remaining source lifetime after capacity refusal');
    this.name = 'MaxSendCapacityDeadlineError';
  }
}

export function readMaxSendCapacityDeferral(
  error: unknown,
  action: MaxActionJob,
  now = Date.now(),
): MaxSendCapacityDeferralError | MaxSendCapacityDeadlineError | null {
  if (!isCapacityRefusal(error) || !wasMaxPreDispatchGuardRejected(error)) return null;
  const proof = sendRefusals.get(error);
  sendRefusals.delete(error);
  if (
    !proof ||
    proof.jobId !== action.idempotencyKey ||
    proof.chatId !== action.chatId ||
    proof.botId !== action.botId
  )
    return null;
  const deadlineAtMs = readMaxSendCapacityDeadline(action);
  if (deadlineAtMs === null) return null;
  const retryAtMs = now + Math.max(MIN_CAPACITY_DELAY_MS, error.retryAfterMs);
  // FLAG: Never shorten Retry-After to fit the deadline or renew source lifetime.
  if (!Number.isSafeInteger(retryAtMs) || retryAtMs >= deadlineAtMs)
    return new MaxSendCapacityDeadlineError();
  const deferral = new MaxSendCapacityDeferralError(action.idempotencyKey, retryAtMs, deadlineAtMs);
  issuedDeferrals.set(deferral, {
    jobId: action.idempotencyKey,
    chatId: action.chatId,
    retryAtMs,
    deadlineAtMs,
  });
  return deferral;
}

// FLAG: The public error constructor carries no scheduling authority. Consume the
// exact helper-issued, immutable bounds once, for this original notice job only.
// A slow persistence write may outlive the deadline: retain the original past-due
// transfer so final expiry guards settle the same job, without renewing SEND authority.
export function consumeMaxSendCapacityDeferral(
  error: unknown,
  action: MaxActionJob,
): error is MaxSendCapacityDeferralError {
  if (!(error instanceof MaxSendCapacityDeferralError)) return false;
  const proof = issuedDeferrals.get(error);
  issuedDeferrals.delete(error);
  return (
    !!proof &&
    proof.jobId === action.idempotencyKey &&
    proof.chatId === action.chatId &&
    error.jobId === proof.jobId &&
    error.retryAtMs === proof.retryAtMs &&
    error.deadlineAtMs === proof.deadlineAtMs &&
    proof.retryAtMs < proof.deadlineAtMs &&
    readMaxSendCapacityDeadline(action) === proof.deadlineAtMs
  );
}
