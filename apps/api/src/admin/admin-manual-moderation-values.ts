import { readObjectPayloadOrNull } from './admin-value-readers';
export { readObjectPayloadOrNull } from './admin-value-readers';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { BotCapabilityRequiredException } from './bot-capability-required.error';
import {
  manualModerationActionResultSchema,
  type ManualModerationActionResult,
} from '@maxim/contracts';
import { createHash } from 'node:crypto';
import { wasMaxMemberMutationAttempted } from '../max/max-client.service';
import { isAmbiguousMaxMutationError } from '../max/max-send-ambiguity.util';
import {
  ModerationSanctionStateChangedError,
  ModerationSanctionStateLockBusyError,
  ModerationSanctionStateLockLeaseLostError,
  ModerationSanctionStateLockUnavailableError,
} from '../moderation/moderation-sanction-state-lock.service';
import {
  extractMaxErrorStatus,
  isMaxApiThrottleError,
  isMaxApiTimeoutError,
  readTrimmedString,
} from './admin-legacy-utils';
import { extractMaxApiErrorMessage } from './admin-chat-rules';
import { toIsoString } from './admin-statistics-values';
import type { ManualModerationFanoutLedgerOperation } from './admin-manual-moderation-runtime-context';

export function resolveManualMuteResultFromLedger(
  row: { metadata?: unknown },
  fallback: {
    userId: string;
    muteDurationHours: number | null;
    muteExpiresAt: Date | null;
    mutePermanent: boolean;
  },
): ManualModerationActionResult {
  const metadata = readObjectPayloadOrNull(row.metadata);
  const mutePermanent =
    typeof metadata?.mutePermanent === 'boolean' ? metadata.mutePermanent : fallback.mutePermanent;
  const muteDurationHours = mutePermanent
    ? null
    : typeof metadata?.muteDurationHours === 'number' && Number.isFinite(metadata.muteDurationHours)
      ? metadata.muteDurationHours
      : fallback.muteDurationHours;
  const muteExpiresAt = mutePermanent
    ? null
    : (toIsoString(metadata?.muteExpiresAt) ??
      (fallback.muteExpiresAt ? fallback.muteExpiresAt.toISOString() : null));
  return manualModerationActionResultSchema.parse({
    ok: true,
    action: 'MUTE',
    userId: fallback.userId,
    muteDurationHours,
    muteExpiresAt,
    message: mutePermanent ? 'Мут включён без срока.' : `Мут включён на ${muteDurationHours} ч.`,
  });
}

export function isAmbiguousAttemptedMaxMemberMutation(error: unknown): boolean {
  if (!wasMaxMemberMutationAttempted(error)) {
    return false;
  }

  const cause = readObjectPayloadOrNull(error)?.cause;
  return isAmbiguousMaxMutationError(error) || isAmbiguousMaxMutationError(cause);
}

export function isManualModerationTransientMaxError(error: unknown): boolean {
  const status = extractMaxErrorStatus(error);
  if (
    (status !== null && status >= 500 && status <= 599) ||
    isMaxApiThrottleError(error) ||
    isMaxApiTimeoutError(error)
  ) {
    return true;
  }

  const message = (
    extractMaxApiErrorMessage(error) ||
    extractHttpErrorMessage(error) ||
    (error instanceof Error ? error.message : String(error))
  )
    .trim()
    .toLowerCase();

  return (
    message.includes('rate limit exceeded') ||
    message.includes('circuit breaker') ||
    message.includes('timeout') ||
    message.includes('временно огранич') ||
    (message.includes('max') && message.includes('повторите'))
  );
}

export function isRetryableManualFanoutPreparationError(error: unknown): boolean {
  return !(
    error instanceof BadRequestException ||
    error instanceof ForbiddenException ||
    error instanceof BotCapabilityRequiredException
  );
}

export function isManualModerationOrderingFailure(error: unknown): boolean {
  return (
    error instanceof ModerationSanctionStateChangedError ||
    error instanceof ModerationSanctionStateLockBusyError ||
    error instanceof ModerationSanctionStateLockLeaseLostError ||
    error instanceof ModerationSanctionStateLockUnavailableError
  );
}

export function summarizeManualModerationCleanup(result: {
  candidateMessageIds: string[];
  deletedMessageIds: string[];
  pendingMessageIds: string[];
  failedMessageIds: string[];
}) {
  return {
    candidateCount: result.candidateMessageIds.length,
    deletedCount: result.deletedMessageIds.length,
    pendingCount: result.pendingMessageIds.length,
    failedCount: result.failedMessageIds.length,
  };
}

export function summarizeManualMuteFanout(result: {
  mutedChatIds: string[];
  skippedChatIds: string[];
  failedChatIds: string[];
}) {
  return {
    mutedChatsCount: result.mutedChatIds.length,
    mutedChatIds: result.mutedChatIds,
    skippedChatsCount: result.skippedChatIds.length,
    skippedChatIds: result.skippedChatIds,
    failedChatsCount: result.failedChatIds.length,
    failedChatIds: result.failedChatIds,
  };
}

export function summarizeManualBanFanout(result: {
  removedChatIds: string[];
  skippedChatIds: string[];
  failedChatIds: string[];
  deletedMessageCount: number;
  failedMessageDeleteCount: number;
}) {
  return {
    removedChatsCount: result.removedChatIds.length,
    removedChatIds: result.removedChatIds,
    skippedChatsCount: result.skippedChatIds.length,
    skippedChatIds: result.skippedChatIds,
    failedChatsCount: result.failedChatIds.length,
    failedChatIds: result.failedChatIds,
    deletedMessageCount: result.deletedMessageCount,
    failedMessageDeleteCount: result.failedMessageDeleteCount,
  };
}

export function buildManualModerationFanoutOperationKey(params: {
  operation: ManualModerationFanoutLedgerOperation;
  sourceChatId: string;
  targetChatId: string;
  targetUserId: string;
  jobId?: string | null;
  rootIntentKey?: string | null;
  extra?: Array<string | number | boolean | null | undefined>;
}): string {
  const rootKey =
    readTrimmedString(params.rootIntentKey) ?? readTrimmedString(params.jobId) ?? 'direct';
  const digest = createHash('sha256')
    .update(
      [
        rootKey,
        params.operation,
        params.sourceChatId.trim(),
        params.targetChatId.trim(),
        params.targetUserId.trim(),
        ...(params.extra ?? []).map((value) => String(value ?? '')),
      ].join('\n'),
    )
    .digest('hex')
    .slice(0, 32);
  return `manual_moderation_fanout:v1:${params.operation}:${digest}`;
}

export function extractHttpErrorMessage(error: unknown): string {
  const response = (error as { response?: unknown })?.response;
  if (typeof response === 'string' && response.trim()) {
    return response.trim();
  }

  const responseMessage = (error as { response?: { message?: unknown } })?.response?.message;
  if (typeof responseMessage === 'string' && responseMessage.trim()) {
    return responseMessage.trim();
  }

  if (error instanceof Error && error.message.trim()) {
    return error.message.trim();
  }

  return '';
}

export function escapeMarkdownPlainText(value: string): string {
  return value.replace(/([\\`*_[\]()~+#])/g, '\\$1');
}
