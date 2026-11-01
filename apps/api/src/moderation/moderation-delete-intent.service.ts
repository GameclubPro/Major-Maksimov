import {
  finalizeDeleteAuthority,
  prepareDeleteAuthority,
  prepareDeleteAuthorityRecheck,
  isPreparedDeleteAuthority,
  type DeleteAuthorityPreparation,
  type PreparedDeleteAuthority,
} from './moderation-delete-authority-preparation';
import { DURABLE_USER_DELETE_RULES } from './durable-user-delete-rules';
import { COMMERCIAL_LLM_DELETE_RULE_CODE } from './commercial/commercial-llm-enforcement.protocol';
import {
  CommercialLlmDeleteGuardService,
  CommercialLlmGuardRejectedError,
} from './commercial/commercial-llm-delete-guard.service';
import { readExactDeleteOrigin } from './webhook-effect-origin-context';
import { readCommercialLlmEffectOrigin } from './commercial/commercial-llm-effect-origin';
import {
  persistRuleFollowupBeforeDelete,
  activateOwnedRuleFollowups,
  assertRuleFollowupSourceCurrent,
} from './moderation-rule-followup-persistence';
import { readLegacyBotCleanupSourceAt } from './legacy-bot-message-cleanup-source';
import type { ModerationRuleFollowupEnvelope } from './moderation-rule-followup.contract';
import {
  MessageDuplicateMetricsService,
  measureDuplicatePhase,
} from './message-duplicate/message-duplicate-metrics.service';
import {
  registerDuplicateClaimCleanup,
  assertDuplicateCleanupBinding,
  type DuplicateCleanupBinding,
  releaseUnusedDuplicateClaim,
  reconcileDuplicateClaimCleanup,
  DUPLICATE_CLEANUP_BATCH_SIZE,
  type DuplicateCleanupSample,
} from './message-duplicate/message-duplicate-claim-cleanup';
import { isValidDeleteBotMessagesDelayMinutes } from '@maxim/contracts/settings';
import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Queue } from 'bullmq';
import { createHash, randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import {
  SuggestionSubscriptionService,
  SUGGESTION_SUBSCRIPTION_DELETE_RULE,
} from '../suggestions/suggestion-subscription.service';
import {
  STOP_WORDS_DELETE_RULE_CODES,
  StopWordsDeleteGuardService,
  StopWordsDeleteGuardRejectedError,
  type StopWordsGuardRejectionReason,
} from './stop-words/stop-words-delete-guard.service';
import {
  isStopWordsImageScanEnabled,
  isStopWordsDecisionConfigured,
} from './stop-words/stop-words.policy';

import { MaxBotLinkService, type MaxDeleteMessageBotRoute } from '../max/max-bot-link.service';
import { normalizeMembershipAccessSnapshot } from '../max/max-bot-access-policy.util';
import { hasConfirmedDeleteMessageAccess } from '../max/max-delete-message-access.util';
import { resolveExplicitMembershipAccessDenial } from '../max/max-membership-access-error';
import {
  wasMaxPreDispatchGuardRejected,
  withMaxFinalAuthorityCheckpoint,
} from '../max/max-action-pre-dispatch-guard';
import { readMaxRetryAfterMs } from '../max/max-retry-after';
import { MaxModerationApiBudgetError } from '../max/max-moderation-api-budget';
import {
  isMaxApiCircuitOpenError,
  MAX_API_SOURCE_TAGS,
  MaxApiInternalRateLimitError,
  MaxClientService,
} from '../max/max-client.service';
import {
  MAX_SEND_AMBIGUOUS_ERROR_PREFIX,
  MAX_SEND_FENCE_STALE_MS,
} from '../max/max-send-ambiguity.util';
import {
  isMaxSendAutoDeleteMarker,
  MAX_SEND_AUTO_DELETE_MARKER_VERSION,
  readMaxSendAutoDeleteConfirmation,
} from '../max/max-send-auto-delete-marker';
import { Prisma } from '../prisma/prisma-client';
import { PrismaService } from '../prisma/prisma.service';
import {
  WebhookLegacyHoldService,
  WebhookLegacyHoldRejectedError,
} from '../webhook/webhook-legacy-hold.service';
import {
  STORAGE_DELETE_DUE_SWEEP_STAGES,
  StorageRuntimeMetricsService,
} from '../system/storage-runtime-metrics.service';
import { checkOrRenewDeleteIntentLease } from './moderation-delete-intent-lease';
import {
  buildMessageScopedModerationActionClaimKey,
  claimDurableModerationMessageAction,
  type ModerationMessageActionClaimData,
  type ModerationMessageActionClaimModel,
} from './moderation-message-action-claim';
import { buildManagedPublicationAutoDeleteFenceWhere } from './managed-publication-auto-delete-fence';
import { findManagedHandshakeAutoDeleteOwner } from './managed-handshake-auto-delete-fence';
import { MODERATION_CHAT_ACTION_TERMINAL_FAILURE_METRIC_STATUSES } from './moderation.service.support';
import {
  MODERATION_DELETE_INTENT_QUEUE,
  type ModerationDeleteIntentJob,
} from './moderation-delete-intent.queue';
import {
  normalizeModerationDeleteIntentMode,
  parseModerationDeleteIntentCanaryChatIds,
  resolveModerationDeleteIntentRollout,
} from './moderation-delete-intent-rollout.util';
import type {
  EnsureModerationDeleteIntentInput,
  EnsureClaimedModerationDeleteIntentResult,
  EnsureModerationDeleteIntentResult,
  ModerationDeleteAttemptResult,
  ModerationDeleteIntentMode,
  ModerationDeleteIntentRollout,
  ModerationDeleteIntentSnapshot,
  ModerationDeleteIntentStatus,
  ModerationDeletePreDispatchPhase,
} from './moderation-delete-intent.types';
import {
  BOT_MESSAGE_EXPLICIT_OPERATOR_CLEANUP_EVIDENCE_SOURCE,
  BOT_MESSAGE_EXPLICIT_OPERATOR_CLEANUP_EVIDENCE_VERSION,
  BOT_MESSAGE_EXPLICIT_OPERATOR_CLEANUP_REASON,
  isValidBotMessageExplicitOperatorCleanupReason,
} from './bot-message-explicit-operator-cleanup.constants';
import { NIGHT_MODE_TRANSITION_NOTICE_RULE_CODES } from './night-mode-transition-notice-persistence-error';
import {
  NIGHT_MODE_CLOSE_NOTICE_CLEANUP_RULE_CODE,
  parseNightModeCloseNoticeCleanupBinding,
  type NightModeCloseNoticeCleanupBinding,
} from './night-mode-close-notice-cleanup-binding';
import {
  buildNightModeTransitionScheduleFingerprint,
  buildNightModeTransitionSideEffectFingerprint,
} from './night-mode-transition-generation.util';
import {
  resolveManualChatClosure,
  resolveNightModeTransitionSnapshot,
} from './night-mode-transition-time.util';
import {
  ClosedChatDeleteGuardService,
  ClosedChatDeleteGuardRejectedError,
  CLOSED_CHAT_DELETE_RULE_CODES,
} from './closed-chat-delete-guard.service';
import {
  ModerationStateDeleteGuardService,
  ModerationStateDeleteRejectedError,
  MODERATION_STATE_DELETE_RULES,
} from './moderation-state-delete-guard.service';
import {
  RequiredSubscriptionExecutionGuardService,
  RequiredSubscriptionExecutionRejectedError,
} from './required-subscription-execution-guard.service';
import {
  MESSAGE_LIMITS_GUARDED_RULES,
  MessageLimitsDeleteGuardService,
  MessageLimitsDeleteGuardRejectedError,
} from './message-limits-delete-guard.service';
import {
  LinkHistoryDeleteGuardService,
  LinkHistoryDeleteGuardRejectedError,
} from './link-history-delete-guard.service';
import {
  TrafficProtectionDeleteGuardService,
  TrafficProtectionGuardRejectedError,
} from './traffic-protection-delete-guard.service';
import { TRAFFIC_PROTECTION_DELETE_RULE_CODES } from './traffic-protection';
import {
  MessageDuplicateDeleteGuardService,
  MessageDuplicateGuardRejectedError,
} from './message-duplicate/message-duplicate-delete-guard.service';
import { MessageDuplicateInitialSourceUnavailableError } from './message-duplicate/message-duplicate-guard.contract';
import {
  MESSAGE_DUPLICATE_CLAIM_PREFIX,
  messageDuplicateEnforcementScope,
  type MessageDuplicateBinding,
  MESSAGE_DUPLICATE_SOURCE,
  parseMessageDuplicateBinding,
  isBoundMessageDuplicateDelete,
} from './message-duplicate/message-duplicate-state';
import { duplicateRevocationKey } from './message-duplicate/message-duplicate-authorization.service';
import { buildMessageDuplicateJobId } from './message-duplicate/message-duplicate.queue';
import { digestDuplicateContent } from './message-duplicate/message-duplicate-content';
import {
  PROFANITY_DELETE_RULE_CODE,
  ProfanityDeleteGuardRejectedError,
  ProfanityDeleteGuardService,
} from './profanity/profanity-delete-guard.service';
import {
  COMMERCIAL_TEXT_DELETE_RULE_CODE,
  fingerprintCommercialDeleteReasons,
  readCommercialTextDeleteBinding,
} from './commercial/commercial-delete-binding';
import {
  CommercialReviewService,
  readCommercialReviewExecutionBinding,
} from './commercial/commercial-review.service';
import { ReportDeleteGuardService } from './reports/report-delete-guard.service';
import {
  MessageRetentionDeleteGuard,
  MessageRetentionGuardError,
} from '../message-retention/message-retention-delete-guard.service';
import {
  MESSAGE_RETENTION_RULE,
  retentionModeAllows,
} from '../message-retention/message-retention.policy';
import { getAppRole } from '../runtime/app-role';
import type { MessageRetentionCandidate } from '../prisma/prisma-client';
import {
  REPORT_COUNTER_RULE,
  REPORT_COMMAND_RULE,
  REPORT_DELETE_RULE,
  REPORT_GUARDED_RULES,
  ReportRejectedError,
} from './reports/report.util';
import {
  CommercialDeleteGuardService,
  CommercialDeleteGuardRejectedError,
  COMMERCIAL_TEXT_MAX_INTENT_REASONS,
} from './commercial/commercial-delete-guard.service';
import {
  LINK_BLOCKED_DELETE_RULE_CODE,
  LINK_HISTORY_RECOVERY_RULE_CODE,
  fingerprintLinkDeleteReasons,
} from './link-history-recovery.util';
import {
  isPhotoDuplicateMatchKindAllowed,
  PHOTO_DUPLICATE_MATCH_KINDS,
  type PhotoDuplicateMatchKind,
  type PhotoDuplicateMatchPreset,
  type PhotoDuplicateScope,
} from './photo-duplicate/photo-duplicate.runtime';
import { PhotoDuplicateRuntimePolicyService } from './photo-duplicate/photo-duplicate-runtime-policy.service';
import { ParticipantModerationImmunityService } from './participant-moderation-immunity.service';
import {
  COMMERCIAL_OCR_DELETE_RULE_CODE,
  COMMERCIAL_OCR_MESSAGE_ACTION_RULE_CODE,
  CommercialOcrDeleteGuardRejectedError,
  CommercialOcrDeleteGuardService,
  extractCommercialOcrExactMessageSource,
  parseCommercialOcrDeleteBinding,
} from './commercial-ocr/commercial-ocr-delete-guard.service';
import {
  fingerprintImageTextStopListPolicy,
  IMAGE_TEXT_STOP_LIST_ACTION_DEDUPE_PREFIX,
  IMAGE_TEXT_STOP_LIST_MESSAGE_ACTION_RULE_CODE,
  IMAGE_TEXT_STOP_LIST_PARTICIPANT_IMMUNITY_SCOPE,
  imageTextStopListSourceMatchesBinding,
  parseImageTextStopListBinding,
  type ImageTextStopListBinding,
} from './commercial-ocr/image-text-stop-list-binding';
import { resolveImageTextStopListOcrRuntimePolicy } from './commercial-ocr/image-text-stop-list.runtime';
import { COMMERCIAL_OCR_DEFAULT_VERSION } from './commercial-ocr/commercial-ocr.queue';
import {
  resolveExpectedCommercialOcrProductionBehaviorIdentity,
  type CommercialOcrNativeBehaviorIdentity,
} from './commercial-ocr/commercial-ocr-behavior-identity';

const DEFAULT_RETRY_HORIZON_MS = 24 * 60 * 60_000;
const DEFAULT_RETRY_BASE_MS = 5_000;
const DEFAULT_RETRY_MAX_MS = 5 * 60_000;
const DEFAULT_CAPABILITY_RETRY_MS = 30_000;
const DEFAULT_LEASE_MS = 60_000;
const DEFAULT_SWEEP_BATCH_SIZE = 100;
const DEFAULT_RECOVERY_BATCH_SIZE = 10;
const DEFAULT_PURGE_MAX_BATCHES = 40;
const DEFAULT_DELETE_TIMEOUT_MS = 5_000;
const DEFAULT_RETENTION_DAYS = 90;
const BOT_MESSAGE_AUTO_DELETE_MAX_EXTERNAL_ATTEMPTS = 5;
const BOT_MESSAGE_AUTO_DELETE_EXPIRED_VERIFICATION_RETRY_MS = 60 * 60_000;
const BOT_MESSAGE_AUTO_DELETE_RETRY_LIMIT_ERROR_CODE =
  'bot_message_auto_delete_retry_limit_reached';
const BOT_MESSAGE_AUTO_DELETE_SUCCESS_VERIFICATION_PENDING_ERROR_CODE =
  'bot_message_auto_delete_success_verification_pending';
const BOT_MESSAGE_AUTO_DELETE_SUCCESS_STILL_PRESENT_ERROR_CODE =
  'bot_message_auto_delete_success_still_present';
export const BOT_MESSAGE_AUTO_DELETE_REPAIR_INTENT_AUDIT_ACTION =
  'OPERATOR_CREATE_MISSING_BOT_MESSAGE_AUTO_DELETE_INTENT';
export const BOT_MESSAGE_EXPLICIT_OPERATOR_CLEANUP_INTENT_AUDIT_ACTION =
  'OPERATOR_CREATE_EXPLICIT_BOT_MESSAGE_CLEANUP_INTENT';
export const BOT_MESSAGE_AUTO_DELETE_ACCESS_AMBIGUOUS_LEDGER_EVIDENCE_SOURCE =
  'terminal_auto_delete_access_ambiguous_ledger';
export const BOT_MESSAGE_AUTO_DELETE_ACCESS_AMBIGUOUS_LEDGER_EVIDENCE_VERSION = 1;
export const BOT_MESSAGE_AUTO_DELETE_ACCESS_AMBIGUOUS_LEDGER_ERROR_CODE =
  'send_auto_delete_exact_verification_access_ambiguous';
export const BOT_MESSAGE_AUTO_DELETE_ACCESS_AMBIGUOUS_HANDOFF_ERROR_CODE =
  'send_auto_delete_access_ambiguous_operator_handoff';
export const BOT_MESSAGE_AUTO_DELETE_ACCESS_AMBIGUOUS_HANDOFF_AUDIT_ACTION =
  'OPERATOR_ACK_AUTO_DELETE_ACCESS_AMBIGUOUS_HANDOFF';
const NIGHT_MODE_CLOSE_NOTICE_CLEANUP_STALE_ERROR_CODE = 'night_mode_close_notice_cleanup_stale';
const DELETE_QUEUE_PRIORITY_INTERACTIVE = 1;
const DELETE_QUEUE_PRIORITY_BACKGROUND = 10;
const CHANNEL_AUTO_POST_FORWARD_REPLACEMENT_CLEANUP_RULE_CODE =
  'CHANNEL_AUTO_POST_FORWARD_REPLACEMENT_CLEANUP';
const CHANNEL_AUTO_POST_CLEANUP_ENTITY_MISMATCH_ERROR_CODE =
  'channel_auto_post_cleanup_entity_mismatch';
const CHANNEL_AUTO_POST_CLEANUP_SENDER_REJECTED_ERROR_CODE =
  'channel_auto_post_cleanup_sender_not_admin';
export const MODERATION_DELETE_INTENT_REPLACEMENT_CLEANUP_RULE_CODES = [
  CHANNEL_AUTO_POST_FORWARD_REPLACEMENT_CLEANUP_RULE_CODE,
  'CHAT_AUTO_COMMENT_ADMIN_MESSAGE_REPLACEMENT_CLEANUP',
  'CHAT_RULES_REPUBLISH_PREVIOUS_MESSAGE_CLEANUP',
] as const;
const BOT_MESSAGE_AUTO_DELETE_RULE_CODE = 'BOT_MESSAGE_AUTO_DELETE';
const REQUIRED_SUBSCRIPTION_DELETE_RULE_CODE = 'REQUIRED_SUBSCRIPTION_DELETE';
type DeleteDueSweepStage = (typeof STORAGE_DELETE_DUE_SWEEP_STAGES)[number];

function createDueSweepStageCounters() {
  return {
    calls: 0,
    succeeded: 0,
    errors: 0,
    returnedCount: 0,
    totalDurationMs: 0,
    maxDurationMs: 0,
    durationBuckets: { under100Ms: 0, under500Ms: 0, under2000Ms: 0, atLeast2000Ms: 0 },
  };
}

function addDueSweepCount(value: number, amount = 1): number {
  return Math.min(Number.MAX_SAFE_INTEGER, value + amount);
}

const REPLACEMENT_CLEANUP_RULE_CODE_SET: ReadonlySet<string> = new Set(
  MODERATION_DELETE_INTENT_REPLACEMENT_CLEANUP_RULE_CODES,
);

const TERMINAL_STATUSES = new Set<ModerationDeleteIntentStatus>([
  'OBSERVED',
  'SUCCEEDED',
  'ALREADY_ABSENT',
  'EXPIRED',
  'FAILED_TERMINAL',
]);

type VerifiedDeleteReasonDeadline = { reasonKey: string; deadlineAtMs: number };

type GuardedDeleteAuthorityProof = {
  profanityVerified: boolean;
  commercialVerifiedReasonKeys: string[];
  messageDuplicateVerified: boolean;
  independentVerified: boolean;
  independentAuthorityDeadlineAtMs: number | null;
  guardedReasonFingerprint: string;
  verifiedReasonKeys: string[];
  verifiedReasonDeadlines: VerifiedDeleteReasonDeadline[];
  independentRecheck?: PreparedDeleteAuthority<GuardedDeleteAuthorityProof>;
};

type IntentRow = {
  suggestionSubscriptionId?: string | null;
  id: string;
  chatId: string;
  messageId: string;
  subjectUserId: string | null;
  sourceMessageAt: Date | null;
  entityType: 'CHAT' | 'CHANNEL' | null;
  messageAuthorKind: string | null;
  originBotId: string | null;
  routingPolicy: string;
  retentionOwned?: boolean;
  commercialOcrGuardRequired: boolean;
  commercialOcrDeadlineAt: Date | null;
  status: ModerationDeleteIntentStatus;
  executeAt: Date;
  nextAttemptAt: Date;
  retryUntilAt: Date;
  attemptCount: number;
  lastBotId: string | null;
  succeededBotId: string | null;
  deleteDispatchStartedAt: Date | null;
  deleteDispatchStartedBotId: string | null;
  remoteDeleteSucceededAt: Date | null;
  remoteDeleteSucceededBotId: string | null;
  candidateFailures: unknown;
  lastStatusCode: number | null;
  lastErrorCode: string | null;
  lastError: string | null;
  leaseToken: string | null;
  leaseExpiresAt: Date | null;
  leasedFromStatus: ModerationDeleteIntentStatus | null;
  replacementCleanup?: boolean;
  nonChannelReplacementCleanup?: boolean;
  channelAutoPostCleanupReason?: boolean;
  channelAutoPostCleanupOnly?: boolean;
  botMessageAutoDeleteReason?: boolean;
  botMessageAutoDeleteOnly?: boolean;
  activeMuteDeleteReason?: boolean;
  requiredSubscriptionDeleteReason?: boolean;
  commercialOcrDeleteReason?: boolean;
  standardCommercialOcrDeleteReason?: boolean;
  nonCommercialOcrDeleteReason?: boolean;
  durableUserDeleteReason?: boolean;
  reportDeleteReason?: boolean;
  reportCounterCleanupReason?: boolean;
  reportHistoryOnly?: boolean;
  linkFamilyDeleteOnly?: boolean;
  photoDuplicateDeleteOnly?: boolean;
  messageDuplicateOwned?: boolean;
  imageTextStopListDeleteReason?: boolean;
  imageTextStopListDeleteOnly?: boolean;
  nightModeCloseNoticeCleanupReason?: boolean;
  nightModeCloseNoticeCleanupOnly?: boolean;
  nightModeCloseNoticeCleanupBinding?: unknown;
};

type ImageTextStopListGuardContext = {
  entityType: 'CHAT' | 'CHANNEL';
  settings: {
    messageLimitsImageTextScanEnabled: boolean;
    stopWordsPolicy?: unknown;
    stopWordsRevision?: number;
    messageLimitsBlockedWords: string[];
    messageLimitsBlockedDomains: string[];
    nightModeTimezone: string;
  } | null;
  admins: Array<{ userId: string }>;
  domains: Array<{ domain: string }>;
};

type PhotoDuplicateDeleteReasonFence = {
  matchKind: PhotoDuplicateMatchKind;
  preset: PhotoDuplicateMatchPreset;
  scope: PhotoDuplicateScope;
};

type ManagedBotMessageOwner = {
  id: string;
  kind:
    | 'managed_handshake'
    | 'managed_handshake_in_flight'
    | 'managed_publication'
    | 'managed_publication_in_flight'
    | 'managed_giveaway_publication'
    | 'managed_giveaway_results'
    | 'vk_parsing_post'
    | 'published_chat_rules'
    | 'chat_auto_comment_replacement'
    | 'chat_auto_comment_reply'
    | 'night_mode_transition_notice';
};

export type ModerationDeleteIntentRoutingContext = {
  chatId: string;
  entityType: 'CHAT' | 'CHANNEL' | null;
  messageAuthorKind: string | null;
  routingPolicy: string;
  replacementCleanup?: boolean;
};

type CandidateFailure = {
  failedAt: string;
  retryAt: string;
  errorCode: string;
  statusCode: number | null;
};

type IntentLeaseHeartbeat = {
  renew: (minimumRemainingMs?: number) => Promise<boolean>;
  hasRemainingBudget: (minimumRemainingMs: number) => boolean;
  stop: () => void;
};

type BotMessageAutoDeleteRetryLimitOutcome =
  | { kind: 'continue'; intent: IntentRow }
  | { kind: 'terminal'; intent: IntentRow }
  | { kind: 'lease_lost' };

type BotMessageAutoDeleteRepairActiveStatus = Extract<
  ModerationDeleteIntentStatus,
  'PENDING' | 'RETRYABLE' | 'WAITING_CAPABILITY' | 'AMBIGUOUS'
>;

type BotMessageAutoDeleteRepairIntentAuditBaseOptions = {
  actorUserId: string;
  auditPayload: Prisma.InputJsonObject;
};

export type BotMessageAutoDeleteExplicitOperatorCleanupPolicy = {
  settingsId: string;
  chatId: string;
  deleteBotMessagesEnabled: true;
  deleteBotMessagesDelayMinutes: number;
  createdAt: Date;
  updatedAt: Date;
  sendJobCreatedAt: Date;
};

export type BotMessageAutoDeleteExplicitOperatorCleanupSendEvidence = {
  ledgerId: string;
  jobId: string;
  chatId: string;
  messageId: string;
  dispatchBotId: string;
  trafficClass: string | null;
  actionHealthLane: string | null;
  enqueuedAt: Date;
  completedAt: Date;
  createdAt: Date;
  updatedAt: Date;
  jobCreatedAt: Date;
};

export type BotMessageAutoDeleteAccessAmbiguousLedgerEvidence = {
  deleteLedgerId: string;
  deleteJobId: string;
  chatId: string;
  messageId: string;
  originBotId: string;
  sourceTag: string | null;
  trafficClass: string | null;
  actionHealthLane: string | null;
  attemptCount: number;
  enqueuedAt: Date;
  firstAttemptAt: Date;
  lastAttemptAt: Date;
  completedAt: Date;
  createdAt: Date;
  updatedAt: Date;
  sourceSendLedgerId: string;
  sourceSendJobId: string;
  sourceSendEnqueuedAt: Date;
  sourceSendCompletedAt: Date;
  sourceSendCreatedAt: Date;
  sourceSendUpdatedAt: Date;
  requestedDelayMs: number;
};

export type BotMessageAutoDeleteRepairIntentAuditOptions =
  | (BotMessageAutoDeleteRepairIntentAuditBaseOptions & {
      kind?: 'legacy_missing_intent';
      operatorReason?: never;
      expectedPolicy?: never;
    })
  | (BotMessageAutoDeleteRepairIntentAuditBaseOptions & {
      kind: 'explicit_operator_cleanup';
      operatorReason: string;
      expectedPolicy: BotMessageAutoDeleteExplicitOperatorCleanupPolicy;
      expectedSend: BotMessageAutoDeleteExplicitOperatorCleanupSendEvidence;
    })
  | (BotMessageAutoDeleteRepairIntentAuditBaseOptions & {
      kind: 'access_ambiguous_ledger';
      expectedLedger: BotMessageAutoDeleteAccessAmbiguousLedgerEvidence;
      operatorReason?: never;
      expectedPolicy?: never;
    });

export type EnsureBotMessageAutoDeleteRepairIntentResult = {
  created: boolean;
  intentId: string;
  rollout: 'execute';
  status: BotMessageAutoDeleteRepairActiveStatus;
};

export type BotMessageAutoDeleteAccessAmbiguousHandoffResult =
  | 'created'
  | 'reconciled_existing'
  | 'reopened'
  | 'already_absent';

export type ModerationDeleteIntentAttemptOptions = {
  /** Fences this inline attempt only; the persisted intent remains the durable recovery owner. */
  beforeDeleteMutation?: (phase?: ModerationDeletePreDispatchPhase) => Promise<void>;
  /** Retention callers must not execute a concurrent ordinary-moderation takeover. */
  retentionOnly?: boolean;
  /** Internal inline caller: a committed built-in guard retry may outlive the webhook. */
  deferGuardFailure?: boolean;
};

export type RetentionIntentAttemptResult = {
  retentionOwned: boolean;
  status: IntentRow['status'];
  lastErrorCode: string | null;
  nextAttemptAt: Date;
  guardDisposition?: 'skip' | 'retry';
  reasonCode?: string;
};

export class BotMessageAutoDeleteExplicitCleanupConflictError extends Error {
  readonly code = 'explicit_operator_cleanup_conflict';

  constructor(message = 'Explicit bot-message cleanup authorization changed before commit') {
    super(message);
    this.name = 'BotMessageAutoDeleteExplicitCleanupConflictError';
  }
}

export class BotMessageAutoDeleteExplicitCleanupPolicyConflictError extends BotMessageAutoDeleteExplicitCleanupConflictError {
  constructor() {
    super('Current bot-message cleanup policy no longer matches the authorized snapshot');
    this.name = 'BotMessageAutoDeleteExplicitCleanupPolicyConflictError';
  }
}

export class BotMessageAutoDeleteAccessAmbiguousLedgerConflictError extends Error {
  readonly code = 'access_ambiguous_ledger_conflict';

  constructor() {
    super('Terminal auto-delete access-ambiguous ledger evidence changed before commit');
    this.name = 'BotMessageAutoDeleteAccessAmbiguousLedgerConflictError';
  }
}

class ModerationDeleteIntentLeaseLostError extends Error {
  constructor() {
    super('Moderation delete intent lease ownership was lost');
    this.name = 'ModerationDeleteIntentLeaseLostError';
  }
}

class ModerationDeletePreDispatchGuardError extends Error {
  constructor(
    readonly guardError: unknown,
    readonly origin: 'guard' | 'caller' = 'guard',
  ) {
    super('Moderation delete pre-dispatch guard rejected the mutation', { cause: guardError });
    this.name = 'ModerationDeletePreDispatchGuardError';
  }
}

type GuardedDeleteReason = {
  ruleCode: string;
  reasonKey: string;
  score: number;
  metadata: unknown;
};

function fingerprintGuardedDeleteReasons(reasons: readonly GuardedDeleteReason[]): string {
  return createHash('sha256').update(JSON.stringify(reasons)).digest('hex');
}

class ModerationDeleteReasonsRejectedError extends Error {
  readonly code = 'moderation_delete_reasons_no_longer_authorized';
  constructor(
    readonly reasonFingerprint: string,
    readonly stopWordsRejectionReason?: StopWordsGuardRejectionReason,
  ) {
    super('No current guarded reason authorizes this deletion');
  }
}

class ModerationDeleteReasonMissingError extends Error {
  readonly code = 'moderation_delete_reason_missing';

  constructor() {
    super('Moderation delete intent has no durable reason');
    this.name = 'ModerationDeleteReasonMissingError';
  }
}

class NightModeCloseNoticeCleanupGuardRejectedError extends Error {
  readonly code = NIGHT_MODE_CLOSE_NOTICE_CLEANUP_STALE_ERROR_CODE;

  constructor(message: string) {
    super(message);
    this.name = 'NightModeCloseNoticeCleanupGuardRejectedError';
  }
}

class ChannelAutoPostCleanupEntityGuardRejectedError extends Error {
  readonly code = CHANNEL_AUTO_POST_CLEANUP_ENTITY_MISMATCH_ERROR_CODE;

  constructor(chatId: string, entityType: string | null) {
    super(
      `Channel auto-post cleanup for ${chatId} cannot run against ${entityType ?? 'a missing entity'}`,
    );
    this.name = 'ChannelAutoPostCleanupEntityGuardRejectedError';
  }
}

class ChannelAutoPostCleanupSenderGuardRejectedError extends Error {
  readonly code = CHANNEL_AUTO_POST_CLEANUP_SENDER_REJECTED_ERROR_CODE;

  constructor(chatId: string, userId: string | null) {
    super(
      `Channel auto-post cleanup for ${chatId} cannot delete a message from ${userId ?? 'an unknown sender'}`,
    );
    this.name = 'ChannelAutoPostCleanupSenderGuardRejectedError';
  }
}

class ModerationDeleteProtectedMessageError extends Error {
  constructor(readonly protectedIntent: IntentRow) {
    super('Managed bot message became protected before delete dispatch');
    this.name = 'ModerationDeleteProtectedMessageError';
  }
}

class ModerationDeleteGuardedMessageAbsentError extends Error {
  constructor(
    readonly verificationCode:
      | 'guarded_current_message_absence'
      | 'guarded_traffic_protection_absence'
      | 'guarded_report_absence'
      | 'guarded_stop_words_absence'
      | 'guarded_link_predispatch_exact_absence'
      | 'guarded_commercial_ocr_predispatch_exact_absence'
      | 'guarded_profanity_predispatch_exact_absence'
      | 'guarded_commercial_text_absence'
      | 'guarded_message_duplicate_absence'
      | 'guarded_image_text_stop_list_predispatch_exact_absence',
  ) {
    super('MAX confirmed that the guarded message is absent');
    this.name = 'ModerationDeleteGuardedMessageAbsentError';
  }
}

export class PhotoDuplicateDeleteIntentGuardRejectedError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'PhotoDuplicateDeleteIntentGuardRejectedError';
  }
}

export class ImageTextStopListDeleteIntentGuardRejectedError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ImageTextStopListDeleteIntentGuardRejectedError';
  }
}

type DeleteErrorDetails = {
  status: 'RETRYABLE' | 'WAITING_CAPABILITY' | 'AMBIGUOUS' | 'EXPIRED' | 'FAILED_TERMINAL';
  statusCode: number | null;
  errorCode: string;
  message: string;
  retryDelayMs: number | null;
  certifiedCapabilityLoss?: true;
};

type ReplacementCleanupRecoveryCandidate = {
  sourceId: string;
  source: 'channel_auto_post' | 'chat_auto_comment' | 'chat_rules_state' | 'chat_rules_republish';
  chatId: string;
  messageId: string;
  originBotId: string | null;
  entityType: 'CHAT' | 'CHANNEL';
  messageAuthorKind: 'user' | 'bot';
  routingPolicy: 'origin_first' | 'origin_only';
  existingIntentId: string | null;
  existingIntentStatus: ModerationDeleteIntentStatus | null;
  createdAt: Date;
};

@Injectable()
export class ModerationDeleteIntentService {
  private readonly logger = new Logger(ModerationDeleteIntentService.name);
  private readonly mode: ModerationDeleteIntentMode;
  private readonly canaryChatIds: ReadonlySet<string>;
  private readonly commercialOcrMode: ModerationDeleteIntentMode;
  private readonly commercialOcrCanaryChatIds: ReadonlySet<string>;
  private readonly crossBotCanaryChatIds: ReadonlySet<string>;
  private readonly replacementCleanupEnabled: boolean;
  private readonly requiredSubscriptionDeleteEnabled: boolean;
  private readonly retryHorizonMs: number;
  private readonly retryBaseMs: number;
  private readonly retryMaxMs: number;
  private readonly capabilityRetryMs: number;
  private readonly leaseMs: number;
  private readonly sweepBatchSize: number;
  private readonly recoveryBatchSize: number;
  private readonly deleteTimeoutMs: number;
  private readonly retentionDays: number;
  private readonly purgeMaxBatches: number;
  private readonly expectedImageOcrNativeBehavior: CommercialOcrNativeBehaviorIdentity;
  private readonly dueSweepMetrics = {
    calls: 0,
    completed: 0,
    errors: 0,
    executionDisabled: 0,
    selectedCount: 0,
    handoffAttemptedCount: 0,
    handoffAcknowledgedCount: 0,
    handoffErrorCount: 0,
    handoffInsertionUnknownCount: 0,
    stages: {
      expire: createDueSweepStageCounters(),
      select: createDueSweepStageCounters(),
      handoff: createDueSweepStageCounters(),
    },
  };

  constructor(
    private readonly prisma: PrismaService,
    private readonly maxClient: MaxClientService,
    private readonly maxBotLinkService: MaxBotLinkService,
    @InjectQueue(MODERATION_DELETE_INTENT_QUEUE)
    private readonly queue: Queue<ModerationDeleteIntentJob>,
    private readonly configService: ConfigService,
    private readonly linkHistoryDeleteGuard: LinkHistoryDeleteGuardService,
    private readonly photoDuplicateRuntimePolicy: PhotoDuplicateRuntimePolicyService,
    private readonly commercialOcrDeleteGuard: CommercialOcrDeleteGuardService,
    private readonly profanityDeleteGuard: ProfanityDeleteGuardService,
    @Optional()
    private readonly participantImmunity?: ParticipantModerationImmunityService,
    @Optional() private readonly messageDuplicateDeleteGuard?: MessageDuplicateDeleteGuardService,
    @Optional() private readonly stopWordsDeleteGuard?: StopWordsDeleteGuardService,
    @Optional() private readonly trafficProtectionDeleteGuard?: TrafficProtectionDeleteGuardService,
    @Optional() private readonly commercialDeleteGuard?: CommercialDeleteGuardService,
    @Optional() private readonly reportDeleteGuard?: ReportDeleteGuardService,
    @Optional() private readonly messageRetentionGuard?: MessageRetentionDeleteGuard,
    @Optional() private readonly suggestionSubscriptions?: SuggestionSubscriptionService,
    @Optional() private readonly storageRuntimeMetrics?: StorageRuntimeMetricsService,
    @Optional() private readonly duplicateMetrics?: MessageDuplicateMetricsService,
    @Optional() private readonly commercialReview?: CommercialReviewService,
    @Optional() private readonly messageLimitsDeleteGuard?: MessageLimitsDeleteGuardService,
    @Optional() private readonly closedChatDeleteGuard?: ClosedChatDeleteGuardService,
    @Optional() private readonly moderationStateDeleteGuard?: ModerationStateDeleteGuardService,
    @Optional()
    private readonly requiredSubscriptionExecutionGuard?: RequiredSubscriptionExecutionGuardService,
    @Optional() private readonly legacyHolds?: WebhookLegacyHoldService,
    @Optional() private readonly commercialLlmGuard?: CommercialLlmDeleteGuardService,
  ) {
    this.expectedImageOcrNativeBehavior =
      resolveExpectedCommercialOcrProductionBehaviorIdentity(configService).identity;
    this.mode = normalizeModerationDeleteIntentMode(
      configService.get('MODERATION_DELETE_INTENT_MODE'),
    );
    this.canaryChatIds = parseModerationDeleteIntentCanaryChatIds(
      configService.get('MODERATION_DELETE_INTENT_CANARY_CHAT_IDS'),
    );
    const commercialOcrMode = configService.get('COMMERCIAL_OCR_ROLLOUT_MODE');
    // FLAG: Baseline admits only commercial OCR candidates; their v5 guard owns fresh authority.
    // Keep the generic delete-intent and separate image stop-list ceilings unchanged.
    this.commercialOcrMode =
      commercialOcrMode === 'baseline'
        ? 'on'
        : normalizeModerationDeleteIntentMode(commercialOcrMode);
    this.commercialOcrCanaryChatIds = new Set(
      [
        ...parseModerationDeleteIntentCanaryChatIds(
          configService.get('COMMERCIAL_OCR_CANARY_CHAT_IDS'),
        ),
      ].filter((chatId) => chatId !== '*'),
    );
    this.crossBotCanaryChatIds = parseModerationDeleteIntentCanaryChatIds(
      configService.get('MODERATION_DELETE_CROSS_BOT_CANARY_CHAT_IDS'),
    );
    this.replacementCleanupEnabled = this.readBoolean(
      configService.get('MODERATION_DELETE_INTENT_REPLACEMENT_CLEANUP_ENABLED'),
      true,
    );
    this.requiredSubscriptionDeleteEnabled = this.readBoolean(
      configService.get('MODERATION_DELETE_INTENT_REQUIRED_SUBSCRIPTION_ENABLED'),
      true,
    );
    this.retryHorizonMs = this.readPositiveInt(
      configService.get('MODERATION_DELETE_INTENT_RETRY_HORIZON_MS'),
      DEFAULT_RETRY_HORIZON_MS,
    );
    this.retryBaseMs = this.readPositiveInt(
      configService.get('MODERATION_DELETE_INTENT_RETRY_BASE_MS'),
      DEFAULT_RETRY_BASE_MS,
    );
    this.retryMaxMs = this.readPositiveInt(
      configService.get('MODERATION_DELETE_INTENT_RETRY_MAX_MS'),
      DEFAULT_RETRY_MAX_MS,
    );
    this.capabilityRetryMs = this.readPositiveInt(
      configService.get('MODERATION_DELETE_INTENT_CAPABILITY_RETRY_MS'),
      DEFAULT_CAPABILITY_RETRY_MS,
    );
    this.leaseMs = this.readPositiveInt(
      configService.get('MODERATION_DELETE_INTENT_LEASE_MS'),
      DEFAULT_LEASE_MS,
    );
    this.sweepBatchSize = this.readPositiveInt(
      configService.get('MODERATION_DELETE_INTENT_SWEEP_BATCH_SIZE'),
      DEFAULT_SWEEP_BATCH_SIZE,
    );
    this.recoveryBatchSize = this.readPositiveInt(
      configService.get('MODERATION_DELETE_INTENT_RECOVERY_BATCH_SIZE'),
      DEFAULT_RECOVERY_BATCH_SIZE,
    );
    this.deleteTimeoutMs = this.readPositiveInt(
      configService.get('MODERATION_DELETE_INTENT_TIMEOUT_MS'),
      DEFAULT_DELETE_TIMEOUT_MS,
    );
    this.retentionDays = this.readPositiveInt(
      configService.get('MODERATION_DELETE_INTENT_RETENTION_DAYS'),
      DEFAULT_RETENTION_DAYS,
    );
    this.purgeMaxBatches = this.readPositiveInt(
      configService.get('MODERATION_DELETE_INTENT_PURGE_MAX_BATCHES'),
      DEFAULT_PURGE_MAX_BATCHES,
    );
    storageRuntimeMetrics?.registerDeleteDueSweepSnapshot(() => this.getDueSweepRuntimeSnapshot());
  }

  get rolloutMode(): ModerationDeleteIntentMode {
    return this.mode;
  }

  get replacementCleanupRolloutEnabled(): boolean {
    return this.replacementCleanupEnabled;
  }

  getRolloutForChat(chatId: string): ModerationDeleteIntentRollout {
    return resolveModerationDeleteIntentRollout({
      mode: this.mode,
      canaryChatIds: this.canaryChatIds,
      chatId,
    });
  }

  getRolloutForRule(chatId: string, ruleCode: string): ModerationDeleteIntentRollout {
    return this.getRolloutForRuleCodes(chatId, [ruleCode]);
  }

  getRolloutForInput(
    input: Pick<EnsureModerationDeleteIntentInput, 'chatId' | 'reasonKey' | 'ruleCode' | 'event'>,
  ): ModerationDeleteIntentRollout {
    // FLAG: Message duplicates have their own runtime authority and mandatory final guard.
    // Do not promote unrelated legacy reasons through the base delete-intent canary.
    if (isBoundMessageDuplicateDelete(input)) return 'execute';
    if (parseImageTextStopListBinding(input.event?.metadata)) {
      return this.getImageTextStopListRollout();
    }
    return this.getRolloutForRule(input.chatId, input.ruleCode ?? input.reasonKey);
  }

  private getImageTextStopListRollout(): ModerationDeleteIntentRollout {
    const policy = resolveImageTextStopListOcrRuntimePolicy({
      configService: this.configService,
      // The trusted writer's strict binding proves sandbox use; action roles do not mount its UDS.
      sandboxBoundaryVerified: true,
    });
    if (!policy.process) return 'off';
    return policy.enforce ? 'execute' : 'observed';
  }

  getRolloutForRuleCodes(
    chatId: string,
    ruleCodes: readonly string[],
  ): ModerationDeleteIntentRollout {
    const normalizedRuleCodes = ruleCodes.map((ruleCode) => ruleCode.trim());
    if (normalizedRuleCodes.some((rule) => DURABLE_USER_DELETE_RULES.has(rule))) return 'execute';
    if (normalizedRuleCodes.includes(SUGGESTION_SUBSCRIPTION_DELETE_RULE)) return 'execute';
    // FLAG: Counter ownership survives admission disable; sanctions use their own exact-chat ceiling.
    if (normalizedRuleCodes.includes(REPORT_COUNTER_RULE)) return 'execute';
    if (normalizedRuleCodes.some((rule) => REPORT_GUARDED_RULES.has(rule))) {
      if (this.reportsEnabled(chatId)) return 'execute';
      const independent = normalizedRuleCodes.filter((rule) => !REPORT_GUARDED_RULES.has(rule));
      return independent.length ? this.getRolloutForRuleCodes(chatId, independent) : 'off';
    }
    // FLAG: Opt-in traffic policies never fall back to an unguarded legacy delete.
    if (normalizedRuleCodes.some((rule) => TRAFFIC_PROTECTION_DELETE_RULE_CODES.has(rule)))
      return 'execute';
    // FLAG: Required-subscription enforcement deletion must retain durable retry ownership.
    if (
      this.requiredSubscriptionDeleteEnabled &&
      normalizedRuleCodes.some((ruleCode) => ruleCode === REQUIRED_SUBSCRIPTION_DELETE_RULE_CODE)
    ) {
      return 'execute';
    }
    if (normalizedRuleCodes.some((ruleCode) => ruleCode === BOT_MESSAGE_AUTO_DELETE_RULE_CODE)) {
      return 'execute';
    }
    if (
      this.replacementCleanupEnabled &&
      normalizedRuleCodes.some((ruleCode) => this.isReplacementCleanupRuleCode(ruleCode))
    ) {
      return 'execute';
    }

    const rollouts: ModerationDeleteIntentRollout[] = [];
    if (normalizedRuleCodes.includes(COMMERCIAL_OCR_DELETE_RULE_CODE)) {
      rollouts.push(this.getCommercialOcrRolloutForChat(chatId));
    }
    if (
      normalizedRuleCodes.length === 0 ||
      normalizedRuleCodes.some((ruleCode) => ruleCode !== COMMERCIAL_OCR_DELETE_RULE_CODE)
    ) {
      rollouts.push(this.getRolloutForChat(chatId));
    }
    if (rollouts.includes('execute')) {
      return 'execute';
    }
    return rollouts.includes('observed') ? 'observed' : 'off';
  }

  resolveEffectiveRoutingPolicy(
    intent: ModerationDeleteIntentRoutingContext,
  ): 'delete_capable' | 'origin_first' | 'origin_only' {
    const userAuthoredChat = intent.entityType === 'CHAT' && intent.messageAuthorKind === 'user';
    const crossBotCanaryEnabled =
      this.crossBotCanaryChatIds.has('*') || this.crossBotCanaryChatIds.has(intent.chatId);
    const replacementCleanupCrossBotEnabled =
      this.replacementCleanupEnabled &&
      intent.replacementCleanup === true &&
      intent.routingPolicy !== 'origin_only';
    if (!userAuthoredChat || (!crossBotCanaryEnabled && !replacementCleanupCrossBotEnabled)) {
      return 'origin_only';
    }
    return intent.routingPolicy === 'delete_capable' ? 'delete_capable' : 'origin_first';
  }

  async ensureIntent(
    input: EnsureModerationDeleteIntentInput,
    options?: { enqueue?: boolean },
  ): Promise<EnsureModerationDeleteIntentResult> {
    return this.persistIntent(input, options?.enqueue !== false);
  }

  // FLAG: A target is linked durably before mute; its final guard waits for the persisted mute decision.
  async prepareReportTargetIntent(
    input: EnsureModerationDeleteIntentInput,
  ): Promise<EnsureModerationDeleteIntentResult> {
    const metadata = this.asRecord(input.event?.metadata);
    if (
      input.ruleCode !== REPORT_DELETE_RULE ||
      metadata?.reportTargetMessageId !== input.messageId
    )
      throw new Error('Report target binding required');
    return this.persistIntent(input, false);
  }

  // FLAG: Only bound historical report work may request lower-priority materialization.
  async ensureReportHistoryIntent(
    input: EnsureModerationDeleteIntentInput,
  ): Promise<EnsureModerationDeleteIntentResult> {
    const metadata = this.asRecord(input.event?.metadata);
    if (
      input.ruleCode !== REPORT_DELETE_RULE ||
      typeof metadata?.reportCaseId !== 'string' ||
      typeof metadata.reportTargetMessageId !== 'string' ||
      metadata.reportTargetMessageId === input.messageId
    )
      throw new Error('Report history binding required');
    return this.persistIntent(input, true, undefined, DELETE_QUEUE_PRIORITY_BACKGROUND);
  }

  // FLAG: Retain the rollback-safe mute rule. Older readers reject pre-mute sources.
  async ensureAutomaticMuteHistoryIntent(
    input: EnsureModerationDeleteIntentInput,
  ): Promise<EnsureModerationDeleteIntentResult> {
    const metadata = this.asRecord(input.event?.metadata);
    if (
      input.ruleCode !== 'MUTE_ACTIVE_DELETE' ||
      !input.sourceMessageAt ||
      typeof metadata?.automaticMuteCleanupId !== 'string' ||
      metadata.automaticMuteCleanupId !== metadata.muteEventId
    )
      throw new Error('Automatic mute history binding required');
    return this.persistIntent(input, true, undefined, DELETE_QUEUE_PRIORITY_BACKGROUND);
  }

  async ensureRetentionIntent(candidate: MessageRetentionCandidate): Promise<string> {
    // FLAG: Never append a retention reason to another module's intent: several guards
    // intentionally yield to independent reasons. Normal writers atomically take ownership.
    return this.prisma.$transaction(async (tx) => {
      // FLAG: Exact positive receipts remain readable before effect admission. Returning
      // their identity never creates a new reason or attaches/rearms automatic work.
      const receipt = await tx.moderationDeleteIntent.findUnique({
        where: {
          chatId_messageId: { chatId: candidate.chatId, messageId: candidate.messageId },
        },
        select: {
          id: true,
          status: true,
          remoteDeleteSucceededAt: true,
          remoteDeleteSucceededBotId: true,
        },
      });
      if (
        receipt &&
        (receipt.status === 'SUCCEEDED' ||
          receipt.status === 'ALREADY_ABSENT' ||
          (receipt.remoteDeleteSucceededAt && receipt.remoteDeleteSucceededBotId))
      )
        return receipt.id;
      const assertSourceAllowed = async () => {
        if (
          (await this.legacyHolds?.isMessageHeld(candidate.chatId, candidate.messageId, tx)) ||
          (await this.legacyHolds?.isMemberHeld(candidate.chatId, candidate.authorId, tx)) ||
          (await this.legacyHolds?.isGlobalUserHeld(candidate.authorId, tx))
        )
          throw new WebhookLegacyHoldRejectedError();
      };
      await assertSourceAllowed();
      const id = randomUUID();
      const created = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        INSERT INTO "moderation_delete_intents" (
          "id", "chat_id", "message_id", "subject_user_id", "source_message_at",
          "entity_type", "message_author_kind", "origin_bot_id", "routing_policy", "retention_owned",
          "status", "execute_at", "next_attempt_at", "retry_until_at", "created_at", "updated_at"
        ) VALUES (${id}, ${candidate.chatId}, ${candidate.messageId}, ${candidate.authorId}, ${candidate.sourceAt},
          'CHAT', 'user', ${candidate.originBotId}, 'origin_first', TRUE, 'PENDING',
          CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, TIMESTAMP '9999-01-01', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        ON CONFLICT ("chat_id", "message_id") DO NOTHING RETURNING "id"
      `);
      const intent =
        created[0] ??
        (await tx.moderationDeleteIntent.findUniqueOrThrow({
          where: { chatId_messageId: { chatId: candidate.chatId, messageId: candidate.messageId } },
          select: { id: true },
        }));
      if (created.length) {
        await assertSourceAllowed();
        await tx.moderationDeleteIntentReason.create({
          data: {
            id: randomUUID(),
            intentId: intent.id,
            reasonKey: MESSAGE_RETENTION_RULE,
            ruleCode: MESSAGE_RETENTION_RULE,
            userId: candidate.authorId,
          },
        });
      }
      // FLAG: Cancellation may win while the intent insert waits. Never attach work
      // using an old candidate snapshot or resurrect an ended activation.
      await tx.$queryRaw`SELECT "chat_id" FROM "message_retention_policies" WHERE "chat_id" = ${candidate.chatId} FOR UPDATE`;
      const current = await tx.messageRetentionCandidate.findUnique({
        where: {
          chatId_messageId: { chatId: candidate.chatId, messageId: candidate.messageId },
        },
        include: { policy: true },
      });
      if (
        !current ||
        !['pending', 'retry'].includes(current.status) ||
        current.activationId !== candidate.activationId ||
        !current.policy.enabled ||
        current.policy.activationId !== current.activationId
      )
        throw new MessageRetentionGuardError(
          'skip',
          'Retention activation ended',
          'activation_ended',
        );
      await assertSourceAllowed();
      const attached = await tx.messageRetentionCandidate.updateMany({
        where: {
          chatId: candidate.chatId,
          messageId: candidate.messageId,
          activationId: candidate.activationId,
          status: { in: ['pending', 'retry'] },
        },
        data: { intentId: intent.id },
      });
      if (!attached.count)
        throw new MessageRetentionGuardError(
          'skip',
          'Retention candidate changed',
          'candidate_inactive',
        );
      return intent.id;
    });
  }

  async ensureBotMessageAutoDeleteRepairIntentWithAudit(
    input: EnsureModerationDeleteIntentInput,
    options: BotMessageAutoDeleteRepairIntentAuditOptions,
  ): Promise<EnsureBotMessageAutoDeleteRepairIntentResult> {
    const normalized = this.normalizeInput(input);
    const actorUserId = options.actorUserId.trim();
    const repairKind = options.kind ?? 'legacy_missing_intent';
    if (!actorUserId) {
      throw new Error('actorUserId is required for bot-message auto-delete intent repair');
    }
    if (
      !options.auditPayload ||
      typeof options.auditPayload !== 'object' ||
      Array.isArray(options.auditPayload)
    ) {
      throw new Error('auditPayload must be a JSON object for bot-message auto-delete repair');
    }
    if (
      repairKind !== 'legacy_missing_intent' &&
      repairKind !== 'explicit_operator_cleanup' &&
      repairKind !== 'access_ambiguous_ledger'
    ) {
      throw new Error('Unsupported bot-message auto-delete repair kind');
    }
    if (
      normalized.reasonKey !== BOT_MESSAGE_AUTO_DELETE_RULE_CODE ||
      normalized.ruleCode !== BOT_MESSAGE_AUTO_DELETE_RULE_CODE ||
      normalized.entityType !== 'CHAT' ||
      normalized.messageAuthorKind !== 'bot' ||
      input.routingPolicy !== 'origin_only' ||
      normalized.routingPolicy !== 'origin_only' ||
      !normalized.originBotId ||
      !normalized.subjectUserId ||
      !normalized.sourceMessageAt ||
      this.optionalString(input.event?.userId) !== normalized.subjectUserId ||
      input.event?.eventType !== 'MESSAGE'
    ) {
      throw new Error(
        'Bot-message auto-delete repair requires exact BOT_MESSAGE_AUTO_DELETE CHAT/bot/origin_only identity and MESSAGE author evidence',
      );
    }
    const expectedSourceMessageAt = normalized.sourceMessageAt;
    const explicitCleanup =
      options.kind === 'explicit_operator_cleanup'
        ? {
            operatorReason: options.operatorReason.trim(),
            expectedPolicy: options.expectedPolicy,
            expectedSend: options.expectedSend,
          }
        : null;
    const accessAmbiguousLedger =
      options.kind === 'access_ambiguous_ledger' ? options.expectedLedger : null;
    if (explicitCleanup) {
      const policy = explicitCleanup.expectedPolicy;
      const send = explicitCleanup.expectedSend;
      const metadata =
        input.event?.metadata &&
        typeof input.event.metadata === 'object' &&
        !Array.isArray(input.event.metadata)
          ? (input.event.metadata as Record<string, unknown>)
          : null;
      if (!isValidBotMessageExplicitOperatorCleanupReason(explicitCleanup.operatorReason)) {
        throw new Error('Explicit operator cleanup reason must be 8..256 printable characters');
      }
      if (
        !policy.settingsId.trim() ||
        policy.chatId !== normalized.chatId ||
        policy.deleteBotMessagesEnabled !== true ||
        !isValidDeleteBotMessagesDelayMinutes(policy.deleteBotMessagesDelayMinutes) ||
        !Number.isFinite(policy.createdAt.getTime()) ||
        !Number.isFinite(policy.updatedAt.getTime()) ||
        !Number.isFinite(policy.sendJobCreatedAt.getTime()) ||
        policy.createdAt > policy.updatedAt ||
        (policy.createdAt <= policy.sendJobCreatedAt && policy.updatedAt <= policy.sendJobCreatedAt)
      ) {
        throw new Error('Explicit operator cleanup requires a valid newer enabled policy snapshot');
      }
      if (
        !send.ledgerId.trim() ||
        !send.jobId.trim() ||
        send.chatId !== normalized.chatId ||
        send.messageId !== normalized.messageId ||
        send.dispatchBotId !== normalized.originBotId ||
        !Number.isFinite(send.enqueuedAt.getTime()) ||
        !Number.isFinite(send.completedAt.getTime()) ||
        !Number.isFinite(send.createdAt.getTime()) ||
        !Number.isFinite(send.updatedAt.getTime()) ||
        !Number.isFinite(send.jobCreatedAt.getTime()) ||
        send.jobCreatedAt.getTime() !== policy.sendJobCreatedAt.getTime() ||
        Math.abs(send.jobCreatedAt.getTime() - send.createdAt.getTime()) > 60_000 ||
        send.enqueuedAt.getTime() + 60_000 < send.jobCreatedAt.getTime() ||
        send.enqueuedAt > send.completedAt
      ) {
        throw new Error('Explicit operator cleanup requires valid exact SEND ledger evidence');
      }
      if (
        !metadata ||
        metadata.reason !== BOT_MESSAGE_EXPLICIT_OPERATOR_CLEANUP_REASON ||
        metadata.repairSource !== BOT_MESSAGE_EXPLICIT_OPERATOR_CLEANUP_EVIDENCE_SOURCE ||
        metadata.evidenceSource !== BOT_MESSAGE_EXPLICIT_OPERATOR_CLEANUP_EVIDENCE_SOURCE ||
        metadata.evidenceVersion !== BOT_MESSAGE_EXPLICIT_OPERATOR_CLEANUP_EVIDENCE_VERSION ||
        metadata.sourceSendAutoDeleteDelayMs !== null
      ) {
        throw new Error(
          'Explicit operator cleanup requires exact durable explicit-cleanup reason metadata',
        );
      }
    }
    if (accessAmbiguousLedger) {
      const evidence = accessAmbiguousLedger;
      if (
        !evidence.deleteLedgerId.trim() ||
        !evidence.deleteJobId.trim() ||
        evidence.chatId !== normalized.chatId ||
        evidence.messageId !== normalized.messageId ||
        evidence.originBotId !== normalized.originBotId ||
        evidence.sourceTag !== MAX_API_SOURCE_TAGS.MODERATION_NOTICE ||
        evidence.attemptCount < 1 ||
        !evidence.sourceSendLedgerId.trim() ||
        !evidence.sourceSendJobId.trim() ||
        !isValidDeleteBotMessagesDelayMinutes(evidence.requestedDelayMs / 60_000) ||
        [
          evidence.enqueuedAt,
          evidence.firstAttemptAt,
          evidence.lastAttemptAt,
          evidence.completedAt,
          evidence.createdAt,
          evidence.updatedAt,
          evidence.sourceSendEnqueuedAt,
          evidence.sourceSendCompletedAt,
          evidence.sourceSendCreatedAt,
          evidence.sourceSendUpdatedAt,
        ].some((value) => !Number.isFinite(value.getTime()))
      ) {
        throw new Error(
          'Access-ambiguous repair requires valid exact DELETE and SEND ledger evidence',
        );
      }
    }

    // FLAG: Only exact legacy evidence, exact terminal access-ambiguous ledger evidence, or an
    // explicit operator-authorized cleanup may create deletion ownership. Evidence/policy
    // fencing, persistence, classifier verification, and audit must remain one transaction.
    return this.runSerializableTransaction(async (tx) => {
      if (accessAmbiguousLedger) {
        await this.assertAccessAmbiguousLedgerEvidenceUnchanged(tx, accessAmbiguousLedger);
      }
      if (explicitCleanup) {
        const expectedPolicy = explicitCleanup.expectedPolicy;
        const policyRows = await tx.$queryRaw<
          Array<{
            settingsId: string;
            chatId: string;
            deleteBotMessagesEnabled: boolean;
            deleteBotMessagesDelayMinutes: number;
            createdAt: Date;
            updatedAt: Date;
          }>
        >(Prisma.sql`
          SELECT
            settings."id" AS "settingsId",
            settings."chat_id" AS "chatId",
            settings."delete_bot_messages_enabled" AS "deleteBotMessagesEnabled",
            settings."delete_bot_messages_delay_minutes" AS "deleteBotMessagesDelayMinutes",
            settings."created_at" AS "createdAt",
            settings."updated_at" AS "updatedAt"
          FROM "chat_settings" settings
          WHERE settings."chat_id" = ${normalized.chatId}
          LIMIT 1
          FOR UPDATE
        `);
        const currentPolicy = policyRows[0];
        if (
          !currentPolicy ||
          currentPolicy.settingsId !== expectedPolicy.settingsId ||
          currentPolicy.chatId !== expectedPolicy.chatId ||
          currentPolicy.deleteBotMessagesEnabled !== true ||
          currentPolicy.deleteBotMessagesDelayMinutes !==
            expectedPolicy.deleteBotMessagesDelayMinutes ||
          currentPolicy.createdAt.getTime() !== expectedPolicy.createdAt.getTime() ||
          currentPolicy.updatedAt.getTime() !== expectedPolicy.updatedAt.getTime()
        ) {
          throw new BotMessageAutoDeleteExplicitCleanupPolicyConflictError();
        }

        const expectedSend = explicitCleanup.expectedSend;
        const sendRows = await tx.$queryRaw<
          Array<{
            ledgerId: string;
            jobId: string;
            actionType: string;
            chatId: string;
            remoteMessageId: string | null;
            sourceTag: string | null;
            trafficClass: string | null;
            actionHealthLane: string | null;
            status: string;
            ambiguous: boolean;
            terminal: boolean;
            dispatchBotId: string | null;
            enqueuedAt: Date | null;
            completedAt: Date | null;
            createdAt: Date;
            updatedAt: Date;
            hasAutoDeleteDelayMs: boolean;
            autoDeleteDelayType: string | null;
            jobCreatedAt: string | null;
          }>
        >(Prisma.sql`
          SELECT
            send."id" AS "ledgerId",
            send."job_id" AS "jobId",
            send."action_type" AS "actionType",
            send."chat_id" AS "chatId",
            send."remote_message_id" AS "remoteMessageId",
            send."source_tag" AS "sourceTag",
            send."traffic_class" AS "trafficClass",
            send."action_health_lane" AS "actionHealthLane",
            send."status"::text AS "status",
            send."ambiguous" AS "ambiguous",
            send."terminal" AS "terminal",
            send."dispatch_bot_id" AS "dispatchBotId",
            send."enqueued_at" AS "enqueuedAt",
            send."completed_at" AS "completedAt",
            send."created_at" AS "createdAt",
            send."updated_at" AS "updatedAt",
            send."metadata" ? 'autoDeleteDelayMs' AS "hasAutoDeleteDelayMs",
            jsonb_typeof(send."metadata"->'autoDeleteDelayMs') AS "autoDeleteDelayType",
            send."metadata"->>'createdAt' AS "jobCreatedAt"
          FROM "max_action_ledger" send
          WHERE send."id" = ${expectedSend.ledgerId}
          LIMIT 1
          FOR UPDATE
        `);
        const currentSend = sendRows[0];
        if (
          !currentSend ||
          currentSend.ledgerId !== expectedSend.ledgerId ||
          currentSend.jobId !== expectedSend.jobId ||
          currentSend.actionType !== 'SEND_MESSAGE' ||
          currentSend.chatId !== expectedSend.chatId ||
          currentSend.remoteMessageId !== expectedSend.messageId ||
          currentSend.sourceTag !== MAX_API_SOURCE_TAGS.MODERATION_NOTICE ||
          currentSend.trafficClass !== expectedSend.trafficClass ||
          currentSend.actionHealthLane !== expectedSend.actionHealthLane ||
          currentSend.status !== 'SUCCEEDED' ||
          currentSend.ambiguous ||
          !currentSend.terminal ||
          currentSend.dispatchBotId !== expectedSend.dispatchBotId ||
          currentSend.enqueuedAt?.getTime() !== expectedSend.enqueuedAt.getTime() ||
          currentSend.completedAt?.getTime() !== expectedSend.completedAt.getTime() ||
          currentSend.createdAt.getTime() !== expectedSend.createdAt.getTime() ||
          currentSend.updatedAt.getTime() !== expectedSend.updatedAt.getTime() ||
          currentSend.hasAutoDeleteDelayMs !== true ||
          currentSend.autoDeleteDelayType !== 'null' ||
          currentSend.jobCreatedAt !== expectedSend.jobCreatedAt.toISOString()
        ) {
          throw new BotMessageAutoDeleteExplicitCleanupConflictError(
            'Exact SEND ledger evidence changed after explicit-cleanup preflight',
          );
        }

        const deleteOwners = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
          SELECT deletion."id"
          FROM "max_action_ledger" deletion
          WHERE deletion."chat_id" = ${normalized.chatId}
            AND deletion."action_type" = 'DELETE_MESSAGE'
            AND deletion."message_id" = ${normalized.messageId}
          LIMIT 1
          FOR UPDATE
        `);
        if (deleteOwners[0]) {
          throw new BotMessageAutoDeleteExplicitCleanupConflictError(
            'A DELETE ledger owner appeared after explicit-cleanup preflight',
          );
        }
      }

      const existingRows = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT intent."id"
        FROM "moderation_delete_intents" intent
        WHERE intent."chat_id" = ${normalized.chatId}
          AND intent."message_id" = ${normalized.messageId}
        LIMIT 1
      `);
      const existingIntentId = existingRows[0]?.id ?? null;
      if (explicitCleanup && existingIntentId) {
        throw new BotMessageAutoDeleteExplicitCleanupConflictError(
          'A moderation delete intent appeared after explicit-cleanup preflight',
        );
      }
      const ensured = await this.persistIntent(input, false, tx);
      if (!ensured.intentId) {
        throw new Error('Bot-message auto-delete repair did not persist an intent');
      }

      const currentRows = await tx.$queryRaw<IntentRow[]>(Prisma.sql`
        SELECT ${this.intentSelectSql('intent')}
        FROM "moderation_delete_intents" intent
        WHERE intent."id" = ${ensured.intentId}
        LIMIT 1
      `);
      const current = currentRows[0];
      const activeStatuses: ReadonlySet<ModerationDeleteIntentStatus> = new Set([
        'PENDING',
        'RETRYABLE',
        'WAITING_CAPABILITY',
        'AMBIGUOUS',
      ]);
      const matchingSubject = current?.subjectUserId === normalized.subjectUserId;
      const matchingSource =
        current?.sourceMessageAt?.getTime() === expectedSourceMessageAt.getTime();
      if (
        !current ||
        current.id !== ensured.intentId ||
        current.chatId !== normalized.chatId ||
        current.messageId !== normalized.messageId ||
        current.entityType !== 'CHAT' ||
        current.messageAuthorKind !== 'bot' ||
        current.originBotId !== normalized.originBotId ||
        current.routingPolicy !== 'origin_only' ||
        !matchingSubject ||
        !matchingSource ||
        current.botMessageAutoDeleteReason !== true ||
        !this.isBotMessageAutoDeleteOnlyReason(current) ||
        ensured.rollout !== 'execute' ||
        ensured.status !== current.status ||
        !activeStatuses.has(current.status) ||
        !this.isExecutionEnabledForIntent(current)
      ) {
        throw new Error(
          `Persisted moderation delete intent ${ensured.intentId} is not an active matching BOT_MESSAGE_AUTO_DELETE-only repair intent`,
        );
      }

      const created = existingIntentId === null;
      if (created) {
        await tx.auditLog.create({
          data: {
            chatId: current.chatId,
            actorUserId,
            action:
              repairKind === 'explicit_operator_cleanup'
                ? BOT_MESSAGE_EXPLICIT_OPERATOR_CLEANUP_INTENT_AUDIT_ACTION
                : BOT_MESSAGE_AUTO_DELETE_REPAIR_INTENT_AUDIT_ACTION,
            payload: {
              ...options.auditPayload,
              repairVersion: 1,
              ...(explicitCleanup
                ? {
                    evidenceVersion: BOT_MESSAGE_EXPLICIT_OPERATOR_CLEANUP_EVIDENCE_VERSION,
                    evidenceSource: BOT_MESSAGE_EXPLICIT_OPERATOR_CLEANUP_EVIDENCE_SOURCE,
                    sendLedgerId: explicitCleanup.expectedSend.ledgerId,
                    sendLedgerJobId: explicitCleanup.expectedSend.jobId,
                    sendLedgerStatus: 'SUCCEEDED',
                    sendLedgerSourceTag: MAX_API_SOURCE_TAGS.MODERATION_NOTICE,
                    sendLedgerDispatchBotId: explicitCleanup.expectedSend.dispatchBotId,
                    sendLedgerTrafficClass: explicitCleanup.expectedSend.trafficClass,
                    sendLedgerActionHealthLane: explicitCleanup.expectedSend.actionHealthLane,
                    sendLedgerEnqueuedAt: explicitCleanup.expectedSend.enqueuedAt.toISOString(),
                    sendLedgerCompletedAt: explicitCleanup.expectedSend.completedAt.toISOString(),
                    sendLedgerCreatedAt: explicitCleanup.expectedSend.createdAt.toISOString(),
                    sendLedgerUpdatedAt: explicitCleanup.expectedSend.updatedAt.toISOString(),
                    sendLedgerAutoDeleteDelayMs: null,
                    operatorReason: explicitCleanup.operatorReason,
                    policySettingsId: explicitCleanup.expectedPolicy.settingsId,
                    policyEnabled: true,
                    policyDelayMinutes:
                      explicitCleanup.expectedPolicy.deleteBotMessagesDelayMinutes,
                    policyCreatedAt: explicitCleanup.expectedPolicy.createdAt.toISOString(),
                    policyUpdatedAt: explicitCleanup.expectedPolicy.updatedAt.toISOString(),
                    sendJobCreatedAt: explicitCleanup.expectedPolicy.sendJobCreatedAt.toISOString(),
                  }
                : {}),
              ...(accessAmbiguousLedger
                ? {
                    evidenceVersion:
                      BOT_MESSAGE_AUTO_DELETE_ACCESS_AMBIGUOUS_LEDGER_EVIDENCE_VERSION,
                    evidenceSource: BOT_MESSAGE_AUTO_DELETE_ACCESS_AMBIGUOUS_LEDGER_EVIDENCE_SOURCE,
                    deleteLedgerId: accessAmbiguousLedger.deleteLedgerId,
                    deleteLedgerJobId: accessAmbiguousLedger.deleteJobId,
                    deleteLedgerStatus: 'FAILED_RETRYABLE',
                    deleteLedgerErrorCode:
                      BOT_MESSAGE_AUTO_DELETE_ACCESS_AMBIGUOUS_LEDGER_ERROR_CODE,
                    sourceSendLedgerId: accessAmbiguousLedger.sourceSendLedgerId,
                    sourceSendLedgerJobId: accessAmbiguousLedger.sourceSendJobId,
                  }
                : {}),
              repairKind,
              intentId: current.id,
              messageId: current.messageId,
              ruleCode: BOT_MESSAGE_AUTO_DELETE_RULE_CODE,
              originBotId: current.originBotId,
            },
          },
        });
      }

      return {
        created,
        intentId: current.id,
        rollout: 'execute',
        status: current.status as BotMessageAutoDeleteRepairActiveStatus,
      };
    });
  }

  async acknowledgeBotMessageAutoDeleteAccessAmbiguousHandoff(
    expected: BotMessageAutoDeleteAccessAmbiguousLedgerEvidence,
    params: {
      actorUserId: string;
      result: BotMessageAutoDeleteAccessAmbiguousHandoffResult;
      intentId: string | null;
    },
  ): Promise<void> {
    const actorUserId = params.actorUserId.trim();
    if (!actorUserId) {
      throw new Error('actorUserId is required for access-ambiguous ledger acknowledgement');
    }

    await this.runSerializableTransaction(async (tx) => {
      await this.assertAccessAmbiguousLedgerEvidenceUnchanged(tx, expected);
      const acknowledged = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        UPDATE "max_action_ledger" ledger
        SET
          "last_error_code" = ${BOT_MESSAGE_AUTO_DELETE_ACCESS_AMBIGUOUS_HANDOFF_ERROR_CODE},
          "last_error" = 'Terminal access-ambiguous auto-delete handed off to operator repair',
          "updated_at" = CURRENT_TIMESTAMP
        WHERE ledger."id" = ${expected.deleteLedgerId}
          AND ledger."status" = CAST('FAILED_RETRYABLE' AS "MaxActionLedgerStatus")
          AND ledger."terminal" = TRUE
          AND ledger."ambiguous" = FALSE
          AND ledger."last_error_code" = ${BOT_MESSAGE_AUTO_DELETE_ACCESS_AMBIGUOUS_LEDGER_ERROR_CODE}
        RETURNING ledger."id"
      `);
      if (acknowledged[0]?.id !== expected.deleteLedgerId) {
        throw new BotMessageAutoDeleteAccessAmbiguousLedgerConflictError();
      }

      await tx.auditLog.create({
        data: {
          chatId: expected.chatId,
          actorUserId,
          action: BOT_MESSAGE_AUTO_DELETE_ACCESS_AMBIGUOUS_HANDOFF_AUDIT_ACTION,
          payload: {
            evidenceVersion: BOT_MESSAGE_AUTO_DELETE_ACCESS_AMBIGUOUS_LEDGER_EVIDENCE_VERSION,
            evidenceSource: BOT_MESSAGE_AUTO_DELETE_ACCESS_AMBIGUOUS_LEDGER_EVIDENCE_SOURCE,
            deleteLedgerId: expected.deleteLedgerId,
            deleteLedgerJobId: expected.deleteJobId,
            sourceSendLedgerId: expected.sourceSendLedgerId,
            sourceSendLedgerJobId: expected.sourceSendJobId,
            previousStatus: 'FAILED_RETRYABLE',
            previousErrorCode: BOT_MESSAGE_AUTO_DELETE_ACCESS_AMBIGUOUS_LEDGER_ERROR_CODE,
            handoffErrorCode: BOT_MESSAGE_AUTO_DELETE_ACCESS_AMBIGUOUS_HANDOFF_ERROR_CODE,
            result: params.result,
            intentId: params.intentId,
          },
        },
      });
    });
  }

  private async assertAccessAmbiguousLedgerEvidenceUnchanged(
    tx: Prisma.TransactionClient,
    expected: BotMessageAutoDeleteAccessAmbiguousLedgerEvidence,
  ): Promise<void> {
    const deleteRows = await tx.$queryRaw<
      Array<{
        id: string;
        jobId: string;
        actionType: string;
        chatId: string;
        botId: string | null;
        messageId: string | null;
        sourceTag: string | null;
        trafficClass: string | null;
        actionHealthLane: string | null;
        status: string;
        ambiguous: boolean;
        terminal: boolean;
        attemptCount: number;
        lastStatusCode: number | null;
        lastErrorCode: string | null;
        metadata: Prisma.JsonValue | null;
        enqueuedAt: Date | null;
        firstAttemptAt: Date | null;
        lastAttemptAt: Date | null;
        completedAt: Date | null;
        createdAt: Date;
        updatedAt: Date;
      }>
    >(Prisma.sql`
      SELECT
        ledger."id",
        ledger."job_id" AS "jobId",
        ledger."action_type" AS "actionType",
        ledger."chat_id" AS "chatId",
        ledger."bot_id" AS "botId",
        ledger."message_id" AS "messageId",
        ledger."source_tag" AS "sourceTag",
        ledger."traffic_class" AS "trafficClass",
        ledger."action_health_lane" AS "actionHealthLane",
        ledger."status"::text AS "status",
        ledger."ambiguous",
        ledger."terminal",
        ledger."attempt_count" AS "attemptCount",
        ledger."last_status_code" AS "lastStatusCode",
        ledger."last_error_code" AS "lastErrorCode",
        ledger."metadata",
        ledger."enqueued_at" AS "enqueuedAt",
        ledger."first_attempt_at" AS "firstAttemptAt",
        ledger."last_attempt_at" AS "lastAttemptAt",
        ledger."completed_at" AS "completedAt",
        ledger."created_at" AS "createdAt",
        ledger."updated_at" AS "updatedAt"
      FROM "max_action_ledger" ledger
      WHERE ledger."id" = ${expected.deleteLedgerId}
      LIMIT 1
      FOR UPDATE
    `);
    const deletion = deleteRows[0];
    const deleteMetadata =
      deletion?.metadata &&
      typeof deletion.metadata === 'object' &&
      !Array.isArray(deletion.metadata)
        ? (deletion.metadata as Record<string, unknown>)
        : null;
    const marker = deleteMetadata?.sendAutoDelete;
    if (
      !deletion ||
      deletion.id !== expected.deleteLedgerId ||
      deletion.jobId !== expected.deleteJobId ||
      deletion.actionType !== 'DELETE_MESSAGE' ||
      deletion.chatId !== expected.chatId ||
      deletion.botId !== expected.originBotId ||
      deletion.messageId !== expected.messageId ||
      deletion.sourceTag !== expected.sourceTag ||
      deletion.trafficClass !== expected.trafficClass ||
      deletion.actionHealthLane !== expected.actionHealthLane ||
      deletion.status !== 'FAILED_RETRYABLE' ||
      deletion.ambiguous ||
      !deletion.terminal ||
      deletion.attemptCount !== expected.attemptCount ||
      deletion.lastStatusCode !== null ||
      deletion.lastErrorCode !== BOT_MESSAGE_AUTO_DELETE_ACCESS_AMBIGUOUS_LEDGER_ERROR_CODE ||
      deletion.enqueuedAt?.getTime() !== expected.enqueuedAt.getTime() ||
      deletion.firstAttemptAt?.getTime() !== expected.firstAttemptAt.getTime() ||
      deletion.lastAttemptAt?.getTime() !== expected.lastAttemptAt.getTime() ||
      deletion.completedAt?.getTime() !== expected.completedAt.getTime() ||
      deletion.createdAt.getTime() !== expected.createdAt.getTime() ||
      deletion.updatedAt.getTime() !== expected.updatedAt.getTime() ||
      !isMaxSendAutoDeleteMarker(marker) ||
      marker.version !== MAX_SEND_AUTO_DELETE_MARKER_VERSION ||
      readMaxSendAutoDeleteConfirmation(marker) !== null ||
      marker.sourceSendJobId !== expected.sourceSendJobId ||
      marker.sourceSendCompletedAt !== expected.sourceSendCompletedAt.toISOString() ||
      marker.requestedDelayMs !== expected.requestedDelayMs ||
      marker.originBotId !== expected.originBotId
    ) {
      throw new BotMessageAutoDeleteAccessAmbiguousLedgerConflictError();
    }

    const sendRows = await tx.$queryRaw<
      Array<{
        id: string;
        jobId: string;
        actionType: string;
        chatId: string;
        remoteMessageId: string | null;
        sourceTag: string | null;
        status: string;
        ambiguous: boolean;
        terminal: boolean;
        dispatchBotId: string | null;
        metadata: Prisma.JsonValue | null;
        enqueuedAt: Date | null;
        completedAt: Date | null;
        createdAt: Date;
        updatedAt: Date;
      }>
    >(Prisma.sql`
      SELECT
        ledger."id",
        ledger."job_id" AS "jobId",
        ledger."action_type" AS "actionType",
        ledger."chat_id" AS "chatId",
        ledger."remote_message_id" AS "remoteMessageId",
        ledger."source_tag" AS "sourceTag",
        ledger."status"::text AS "status",
        ledger."ambiguous",
        ledger."terminal",
        ledger."dispatch_bot_id" AS "dispatchBotId",
        ledger."metadata",
        ledger."enqueued_at" AS "enqueuedAt",
        ledger."completed_at" AS "completedAt",
        ledger."created_at" AS "createdAt",
        ledger."updated_at" AS "updatedAt"
      FROM "max_action_ledger" ledger
      WHERE ledger."id" = ${expected.sourceSendLedgerId}
      LIMIT 1
      FOR UPDATE
    `);
    const send = sendRows[0];
    const sendMetadata =
      send?.metadata && typeof send.metadata === 'object' && !Array.isArray(send.metadata)
        ? (send.metadata as Record<string, unknown>)
        : null;
    if (
      !send ||
      send.id !== expected.sourceSendLedgerId ||
      send.jobId !== expected.sourceSendJobId ||
      send.actionType !== 'SEND_MESSAGE' ||
      send.chatId !== expected.chatId ||
      send.remoteMessageId !== expected.messageId ||
      send.sourceTag !== MAX_API_SOURCE_TAGS.MODERATION_NOTICE ||
      send.status !== 'SUCCEEDED' ||
      send.ambiguous ||
      !send.terminal ||
      send.dispatchBotId !== expected.originBotId ||
      sendMetadata?.autoDeleteDelayMs !== expected.requestedDelayMs ||
      send.enqueuedAt?.getTime() !== expected.sourceSendEnqueuedAt.getTime() ||
      send.completedAt?.getTime() !== expected.sourceSendCompletedAt.getTime() ||
      send.createdAt.getTime() !== expected.sourceSendCreatedAt.getTime() ||
      send.updatedAt.getTime() !== expected.sourceSendUpdatedAt.getTime()
    ) {
      throw new BotMessageAutoDeleteAccessAmbiguousLedgerConflictError();
    }
  }

  async claimMessageActionBeforeQualification(
    claim: ModerationMessageActionClaimData,
    binding: DuplicateCleanupBinding,
  ): Promise<'claimed' | 'resumed' | 'blocked'> {
    assertDuplicateCleanupBinding(claim, binding);
    if (
      this.getRolloutForRule(claim.chatId, 'DUPLICATE_DELETE') === 'off' ||
      Date.now() >= binding.authorization!.deadlineAtMs
    )
      return 'blocked';
    const registrationRejected = new Error('Duplicate cleanup generation changed');
    try {
      return await this.runSerializableTransaction(async (tx) => {
        const result = await claimDurableModerationMessageAction({
          model: tx.moderationViolationMessageClaim as unknown as ModerationMessageActionClaimModel,
          data: claim,
          resumeKnownOwner: true,
          inTransaction: true,
        });
        if (result === 'blocked') return result;
        // FLAG: Claim and its original cleanup deadline commit together. Rejecting
        // a generation also rolls back a newly created claim, never leaving an orphan.
        if (!(await registerDuplicateClaimCleanup(tx, claim, binding))) throw registrationRejected;
        return result;
      });
    } catch (error) {
      if (error === registrationRejected) return 'blocked';
      throw error;
    }
  }

  async releaseUnmaterializedMessageAction(params: {
    claim: ModerationMessageActionClaimData;
    owner?: { id: string; createdAt: Date };
    binding: Pick<
      MessageDuplicateBinding,
      'messageId' | 'senderId' | 'eventTimestampMs' | 'authorization'
    >;
  }): Promise<boolean> {
    const { claim, binding } = params;
    if (
      claim.ruleCode !== 'DUPLICATE_MESSAGE_ACTION' ||
      claim.messageId !== binding.messageId ||
      claim.userId !== binding.senderId ||
      !binding.authorization
    )
      throw new Error('Invalid unmaterialized duplicate action claim');
    return this.runSerializableTransaction((tx) => releaseUnusedDuplicateClaim(tx, params));
  }

  async reconcileExpiredMessageDuplicateActions(
    report?: (sample: DuplicateCleanupSample) => void,
  ): Promise<number> {
    const dueAt = new Date();
    // FLAG: A dedicated due index bounds candidate selection independently of
    // retained claims and BullMQ. Each exact obligation is settled separately.
    const candidates = await this.prisma.messageDuplicateClaimCleanup.findMany({
      where: { deadlineAt: { lte: dueAt } },
      orderBy: [{ deadlineAt: 'asc' }, { claimId: 'asc' }],
      take: DUPLICATE_CLEANUP_BATCH_SIZE,
      select: { claimId: true, deadlineAt: true },
    });
    let released = 0;
    for (const candidate of candidates) {
      if (
        await this.runSerializableTransaction((tx) =>
          reconcileDuplicateClaimCleanup(tx, candidate.claimId, dueAt),
        )
      )
        released += 1;
    }
    // FLAG: Reuse only the bounded due selection. This is a lower bound at selection
    // time, never total queue depth or authority; observer faults cannot undo cleanup.
    try {
      report?.({
        sampledDue: candidates.length,
        sampleLimit: DUPLICATE_CLEANUP_BATCH_SIZE,
        sampleLimitReached: candidates.length === DUPLICATE_CLEANUP_BATCH_SIZE,
        oldestDueAgeMs: candidates[0]
          ? Math.max(0, dueAt.getTime() - candidates[0].deadlineAt.getTime())
          : null,
        released,
      });
    } catch {
      // FLAG: Diagnostics cannot replace an already committed cleanup outcome.
    }
    return released;
  }

  async releaseTerminatedMessageDuplicateAction(input: {
    chatId: string;
    messageId: string;
    eventTimestampMs: number;
    deadlineAtMs: number;
    idempotencyKey: string;
    comparison?: 'IMAGE';
  }): Promise<boolean> {
    if (
      input.idempotencyKey !==
        buildMessageDuplicateJobId(
          input.chatId,
          input.messageId,
          input.eventTimestampMs,
          input.comparison,
        ) ||
      input.deadlineAtMs > input.eventTimestampMs + 600000
    )
      throw new Error('Invalid terminated duplicate job identity');
    const messageActionKey = buildMessageScopedModerationActionClaimKey(
      input.chatId,
      input.messageId,
    );
    const claim = await this.prisma.moderationViolationMessageClaim.findUnique({
      where: { messageActionKey },
    });
    if (
      !claim ||
      claim.ruleCode !== 'DUPLICATE_MESSAGE_ACTION' ||
      claim.updateType !== 'message_action' ||
      claim.createdAt.getTime() > input.deadlineAtMs ||
      claim.dedupeKey !==
        `${MESSAGE_DUPLICATE_CLAIM_PREFIX}${digestDuplicateContent([input.chatId, claim.userId, input.messageId])}`
    )
      return false;
    return this.releaseUnmaterializedMessageAction({
      owner: { id: claim.id, createdAt: claim.createdAt },
      claim: {
        dedupeKey: claim.dedupeKey,
        messageActionKey,
        chatId: input.chatId,
        messageId: input.messageId,
        userId: claim.userId,
        ruleCode: claim.ruleCode,
        updateType: 'message_action',
      },
      binding: {
        messageId: input.messageId,
        senderId: claim.userId,
        eventTimestampMs: input.eventTimestampMs,
        authorization: {
          eventTimestampMs: input.eventTimestampMs,
          deadlineAtMs: input.deadlineAtMs,
        },
      },
    });
  }

  async ensureIntentWithMessageActionClaim(params: {
    claim: ModerationMessageActionClaimData;
    intent: EnsureModerationDeleteIntentInput;
  }): Promise<EnsureClaimedModerationDeleteIntentResult> {
    this.assertClaimMatchesIntent(params.claim, params.intent);
    if (this.getRolloutForInput(params.intent) === 'off') {
      return { claim: 'blocked', intent: null };
    }

    const result = await this.runSerializableTransaction(async (tx) => {
      const binding = parseMessageDuplicateBinding(params.intent.event?.metadata);
      if (binding?.version === 3 && binding.authorization) {
        const denied = await tx.moderationViolationMessageClaim.findFirst({
          where: {
            dedupeKey: {
              in: [
                ...new Set([binding.eventTimestampMs, binding.authorization.eventTimestampMs]),
              ].map((timestamp) =>
                duplicateRevocationKey(params.intent.chatId, binding.messageId, timestamp),
              ),
            },
          },
          select: { id: true },
        });
        if (denied) return { claim: 'blocked', intent: null } as const;
      }
      const claim = await claimDurableModerationMessageAction({
        model: tx.moderationViolationMessageClaim as unknown as ModerationMessageActionClaimModel,
        data: params.claim,
        resumeKnownOwner: true,
        inTransaction: true,
      });
      if (claim === 'blocked') {
        return { claim, intent: null } as const;
      }
      const intent = await this.persistIntent(params.intent, false, tx);
      if (!intent.intentId) {
        throw new Error('Claimed moderation message action did not materialize a delete intent');
      }
      if (binding?.version === 3) {
        // FLAG: Durable intent ownership replaces preclaim cleanup atomically.
        // The due queue contains abandoned work, not every successful deletion.
        await tx.messageDuplicateClaimCleanup.deleteMany({
          where: {
            claim: {
              dedupeKey: params.claim.dedupeKey,
              messageActionKey: params.claim.messageActionKey,
            },
          },
        });
      }
      return { claim, intent } as const;
    });

    if (result.intent?.rollout === 'execute' && result.intent.intentId) {
      try {
        await this.enqueueCurrentWakeup(result.intent.intentId, DELETE_QUEUE_PRIORITY_INTERACTIVE);
      } catch (error: unknown) {
        this.logger.warn(
          { intentId: result.intent.intentId, err: this.errorMessage(error) },
          'Failed to enqueue atomically persisted moderation delete intent; DB sweeper will retry',
        );
      }
    }
    return result;
  }

  async ensureIntentWithRuleFollowup(
    input: EnsureModerationDeleteIntentInput,
    policySha256: string,
    envelope: ModerationRuleFollowupEnvelope,
  ): Promise<{ followupId: string | null }> {
    return this.prisma.$transaction(async (tx) => {
      const now = new Date();
      // FLAG: Explicitly malformed scheduling remains an error. Only a valid original
      // source's elapsed five-minute authority window may stop initial registration normally.
      this.toNullableDate(input.executeAt);
      this.toNullableDate(input.retryUntilAt);
      if (input.executeAt != null && input.retryUntilAt != null) this.normalizeInput(input);
      assertRuleFollowupSourceCurrent(input, policySha256, envelope, now.getTime());
      const intent = await this.persistIntent(
        { ...input, executeAt: input.executeAt ?? now },
        false,
        tx,
      );
      if (intent.rollout !== 'execute' || !intent.intentId) return { followupId: null };
      return {
        followupId: await persistRuleFollowupBeforeDelete(
          tx,
          intent.intentId,
          input,
          policySha256,
          envelope,
        ),
      };
    });
  }

  async ensureAndAttempt(
    input: EnsureModerationDeleteIntentInput,
    options?: ModerationDeleteIntentAttemptOptions,
  ): Promise<ModerationDeleteAttemptResult> {
    const ensured = await this.persistIntent(input, false);
    if (ensured.rollout === 'off' || !ensured.intentId) {
      return { kind: 'off', confirmed: false, intentId: null, status: null };
    }
    if (ensured.rollout === 'observed') {
      return {
        kind: 'observed',
        confirmed: false,
        intentId: ensured.intentId,
        status: ensured.status ?? 'OBSERVED',
      };
    }

    const result = await this.observeConcurrentInlineReceipt(
      input,
      await this.attemptIntent(
        ensured.intentId,
        DURABLE_USER_DELETE_RULES.has(input.ruleCode ?? input.reasonKey)
          ? { ...options, deferGuardFailure: true }
          : options,
      ),
    );
    if (!result.confirmed) {
      await this.enqueueCurrentWakeup(ensured.intentId);
    }
    return this.recoverKnownOwnReasonReceipt(input, result);
  }

  private async observeConcurrentInlineReceipt(
    input: EnsureModerationDeleteIntentInput,
    result: ModerationDeleteAttemptResult,
  ): Promise<ModerationDeleteAttemptResult> {
    const sourceAt = this.toNullableDate(input.sourceMessageAt);
    if (
      result.kind !== 'pending' ||
      result.status !== 'IN_PROGRESS' ||
      !sourceAt ||
      !input.subjectUserId ||
      (!MESSAGE_LIMITS_GUARDED_RULES.has(input.ruleCode ?? '') &&
        !STOP_WORDS_DELETE_RULE_CODES.has(input.ruleCode ?? ''))
    )
      return result;
    // FLAG: The sweeper can win an inline caller's lease even without an early
    // queue wakeup. Observe only that exact active worker's committed outcome,
    // with bounded unique reads; never replay the engine or treat a live lease as success.
    const deadlineAtMs = Math.min(
      sourceAt.getTime() + 5 * 60_000,
      Date.now() + Math.min(this.deleteTimeoutMs + 1_000, 10_000),
    );
    for (let read = 0; read < 16 && Date.now() < deadlineAtMs; read += 1) {
      const current = await this.prisma.moderationDeleteIntent.findUnique({
        where: { id: result.intentId },
        select: {
          id: true,
          status: true,
          chatId: true,
          messageId: true,
          subjectUserId: true,
          sourceMessageAt: true,
          leaseExpiresAt: true,
          succeededBotId: true,
        },
      });
      if (
        !current ||
        current.chatId !== input.chatId ||
        current.messageId !== input.messageId ||
        current.subjectUserId !== input.subjectUserId ||
        current.sourceMessageAt?.getTime() !== sourceAt.getTime()
      )
        return result;
      if (current.status !== 'IN_PROGRESS') return this.toAttemptResult(current);
      const remainingMs = Math.min(
        deadlineAtMs - Date.now(),
        (current.leaseExpiresAt?.getTime() ?? 0) - Date.now(),
      );
      if (remainingMs <= 0) return result;
      await new Promise((resolve) =>
        setTimeout(resolve, Math.min(20 * 2 ** read, 500, remainingMs)),
      );
    }
    return result;
  }

  private async recoverKnownOwnReasonReceipt(
    input: EnsureModerationDeleteIntentInput,
    result: ModerationDeleteAttemptResult,
  ): Promise<ModerationDeleteAttemptResult> {
    const sourceAt = this.toNullableDate(input.sourceMessageAt);
    const ruleCode = input.ruleCode ?? input.reasonKey;
    if (
      result.kind !== 'confirmed' ||
      !sourceAt ||
      !input.subjectUserId ||
      result.verifiedReasonKeys?.includes(input.reasonKey) ||
      ![
        ...MESSAGE_LIMITS_GUARDED_RULES,
        ...STOP_WORDS_DELETE_RULE_CODES,
        ...MODERATION_STATE_DELETE_RULES,
        ...CLOSED_CHAT_DELETE_RULE_CODES,
        REQUIRED_SUBSCRIPTION_DELETE_RULE_CODE,
      ].includes(ruleCode)
    )
      return result;
    // FLAG: A queue worker can finish the exact DELETE before its webhook's inline
    // attempt. Recover only this caller's immutable own receipt; never count a retry
    // again, borrow another reason, or grant profanity/commercial execution proof.
    const receipt = await this.prisma.moderationDeleteIntentReason.findUnique({
      where: { intentId_reasonKey: { intentId: result.intentId, reasonKey: input.reasonKey } },
      select: {
        ruleCode: true,
        userId: true,
        metadata: true,
        intent: {
          select: {
            status: true,
            chatId: true,
            messageId: true,
            subjectUserId: true,
            sourceMessageAt: true,
            succeededBotId: true,
          },
        },
      },
    });
    if (
      !receipt ||
      receipt.ruleCode !== ruleCode ||
      (receipt.userId !== null && receipt.userId !== input.subjectUserId) ||
      this.asRecord(receipt.metadata)?.moderationDeleteVerified !== true ||
      receipt.intent.status !== 'SUCCEEDED' ||
      receipt.intent.chatId !== input.chatId ||
      receipt.intent.messageId !== input.messageId ||
      receipt.intent.subjectUserId !== input.subjectUserId ||
      receipt.intent.sourceMessageAt?.getTime() !== sourceAt.getTime() ||
      receipt.intent.succeededBotId !== result.botId
    )
      return result;
    return {
      ...result,
      verifiedReasonKeys: [...(result.verifiedReasonKeys ?? []), input.reasonKey],
    };
  }

  async attemptIntent(
    intentId: string,
    options?: ModerationDeleteIntentAttemptOptions,
  ): Promise<ModerationDeleteAttemptResult> {
    const existing = await this.loadIntent(intentId);
    if (!existing) {
      throw new Error(`Moderation delete intent ${intentId} does not exist`);
    }
    // FLAG: Source abandonment never reclaims a lease, increments an attempt or
    // fabricates a terminal/success outcome. A saved exact remote receipt may settle.
    if (
      !(existing.remoteDeleteSucceededAt && existing.remoteDeleteSucceededBotId) &&
      (await this.legacyHolds?.isSourceAbandoned?.(existing.chatId, existing.messageId))
    )
      return this.toAttemptResult(existing);
    if (
      (options?.retentionOnly && !existing.retentionOwned) ||
      !this.isExecutionEnabledForIntent(existing)
    ) {
      return this.toAttemptResult(existing);
    }

    const claimed = await this.claimOne(intentId, options?.retentionOnly === true);
    if (!claimed) {
      await this.expireIntentIfDue(intentId);
      const current = await this.loadRequiredIntent(intentId);
      return this.toAttemptResult(current);
    }
    return this.executeLeasedIntent(claimed.id, claimed.leaseToken!, options);
  }

  async attemptRetentionIntent(intentId: string): Promise<RetentionIntentAttemptResult> {
    let guard: MessageRetentionGuardError | undefined;
    try {
      await this.attemptIntent(intentId, { retentionOnly: true });
    } catch (error: unknown) {
      const cause =
        error instanceof ModerationDeletePreDispatchGuardError ? error.guardError : error;
      if (!(cause instanceof MessageRetentionGuardError)) throw error;
      guard = cause;
    }
    const current = await this.prisma.moderationDeleteIntent.findUniqueOrThrow({
      where: { id: intentId },
      select: { retentionOwned: true, status: true, lastErrorCode: true, nextAttemptAt: true },
    });
    const reasonCode =
      guard?.reasonCode ??
      (current.lastErrorCode?.startsWith('message_retention_guard:')
        ? current.lastErrorCode.slice('message_retention_guard:'.length)
        : undefined);
    return {
      ...current,
      ...(guard || reasonCode
        ? {
            guardDisposition:
              guard?.disposition ?? (TERMINAL_STATUSES.has(current.status) ? 'skip' : 'retry'),
            reasonCode,
          }
        : {}),
    };
  }

  async reconcileRetentionIntent(
    intentId: string,
    options: { allowRead: boolean; canRead?: () => Promise<boolean> },
  ): Promise<ModerationDeleteAttemptResult | null> {
    if (getAppRole() !== 'message-retention' && getAppRole() !== 'all') return null;
    const existing = await this.loadIntent(intentId);
    if (!existing?.retentionOwned) return null;
    if (
      existing.status === 'SUCCEEDED' ||
      existing.status === 'ALREADY_ABSENT' ||
      (TERMINAL_STATUSES.has(existing.status) && !this.hasDeleteMutationEvidence(existing))
    )
      return this.toAttemptResult(existing);
    if (!this.hasDeleteMutationEvidence(existing)) return null;
    const hasSuccess = Boolean(
      existing.remoteDeleteSucceededAt && existing.remoteDeleteSucceededBotId,
    );
    // FLAG: Mode off allows database-only receipt settlement. Recovery never dispatches DELETE.
    if (!hasSuccess && !options.allowRead) return this.toAttemptResult(existing);
    const intent = await this.claimOne(intentId, true, true);
    if (!intent?.retentionOwned || !intent.leaseToken) return this.toAttemptResult(existing);
    const leaseToken = intent.leaseToken;
    const heartbeat = this.startLeaseHeartbeat(intent.id, leaseToken);
    try {
      if (intent.remoteDeleteSucceededAt && intent.remoteDeleteSucceededBotId)
        return this.finalizeRecordedRemoteSuccess(
          intent,
          leaseToken,
          intent.remoteDeleteSucceededBotId,
        );
      if (!options.allowRead)
        return this.finishRetentionReconciliationDeferred(
          intent,
          leaseToken,
          'retention_reconciliation_paused',
        );
      const canRead = async () =>
        options.allowRead &&
        retentionModeAllows(
          this.configService.get('MESSAGE_RETENTION_MODE'),
          this.configService.get('MESSAGE_RETENTION_CANARY_CHAT_IDS'),
          intent.chatId,
          true,
        ) &&
        Boolean(options.canRead && (await options.canRead()));
      if (!(await canRead()))
        return this.finishRetentionReconciliationDeferred(
          intent,
          leaseToken,
          'retention_reconciliation_paused',
        );
      const route = await this.resolveDeleteRouteWithRefresh(intent, heartbeat, canRead);
      const botId = this.filterAndOrderRouteCandidates(intent, route)[0];
      if (!botId)
        return this.finishRetentionReconciliationDeferred(
          intent,
          leaseToken,
          'retention_reconciliation_no_access',
        );
      const absence = await this.verifyMessageAbsence(intent, botId, heartbeat, canRead);
      if (absence === 'verified_absent')
        return this.toAttemptResult(
          await this.completeAlreadyAbsent(
            intent.id,
            leaseToken,
            botId,
            'retention_reconciliation_absence',
          ),
        );
      if (absence === 'message_present') {
        // FLAG: Exact presence settles the old unknown dispatch without rearming its cancelled policy.
        await this.prisma.$executeRaw(Prisma.sql`
          UPDATE "moderation_delete_intents" SET
            "status" = CAST('FAILED_TERMINAL' AS "ModerationDeleteIntentStatus"),
            "last_error_code" = 'retention_reconciliation_present',
            "last_error" = 'Exact message presence confirmed; cancelled retention dispatch will not be retried',
            "delete_dispatch_started_at" = NULL, "delete_dispatch_started_bot_id" = NULL,
            "completed_at" = CURRENT_TIMESTAMP, "lease_token" = NULL,
            "lease_expires_at" = NULL, "leased_from_status" = NULL, "updated_at" = CURRENT_TIMESTAMP
          WHERE "id" = ${intent.id} AND "retention_owned" = TRUE
            AND "status" = CAST('IN_PROGRESS' AS "ModerationDeleteIntentStatus")
            AND "lease_token" = ${leaseToken}
            AND "remote_delete_succeeded_at" IS NULL AND "remote_delete_succeeded_bot_id" IS NULL
        `);
        return this.toAttemptResult(await this.loadRequiredIntent(intent.id));
      }
      return this.finishRetentionReconciliationDeferred(
        intent,
        leaseToken,
        'retention_reconciliation_unknown',
      );
    } catch (error: unknown) {
      if (error instanceof ModerationDeleteIntentLeaseLostError)
        return this.toAttemptResult(await this.loadRequiredIntent(intent.id));
      return this.finishRetentionReconciliationDeferred(
        intent,
        leaseToken,
        'retention_reconciliation_unknown',
      );
    } finally {
      await heartbeat.stop();
    }
  }

  private async finishRetentionReconciliationDeferred(
    intent: IntentRow,
    leaseToken: string,
    errorCode: string,
  ): Promise<ModerationDeleteAttemptResult> {
    return this.finishRetryableAttempt(intent, leaseToken, {
      status: 'AMBIGUOUS',
      statusCode: null,
      errorCode,
      message: 'Retention receipt requires read-only reconciliation',
      retryDelayMs: 5 * 60_000,
    });
  }

  async enqueueCurrentIntentWakeupStrict(intentId: string): Promise<void> {
    const intent = await this.loadRequiredIntent(intentId);
    if (await this.isAbandonedIntentWithoutReceipt(intent)) return;
    const eligibility = this.classifyIntentWakeupEligibility(intent);
    switch (eligibility) {
      case 'eligible':
        await this.enqueueIntentJob(
          intent.id,
          intent.reportHistoryOnly
            ? DELETE_QUEUE_PRIORITY_BACKGROUND
            : DELETE_QUEUE_PRIORITY_INTERACTIVE,
        );
        return;
      case 'settled_or_in_progress':
        return;
      case 'execution_disabled':
        throw new Error(
          `Moderation delete intent ${intent.id} is not executable in the current rollout`,
        );
      case 'retry_window_exhausted':
        throw new Error(
          `Moderation delete intent ${intent.id} has no mutation evidence and its retry window is exhausted`,
        );
      case 'not_due':
        throw new Error(`Moderation delete intent ${intent.id} is not due for enqueue`);
    }
  }

  async retryTerminalIntent(
    intentId: string,
    expectedStatus: 'EXPIRED' | 'FAILED_TERMINAL',
    expectedVersion: { updatedAt: Date; attemptCount: number },
    options?: { actorUserId: string },
  ): Promise<{ reopened: boolean; intent: ModerationDeleteIntentSnapshot }> {
    const existing = await this.loadRequiredIntent(intentId);
    if (await this.legacyHolds?.isSourceAbandoned?.(existing.chatId, existing.messageId))
      return { reopened: false, intent: this.toSnapshot(existing) };
    if (!this.isExecutionEnabledForIntent(existing)) {
      return { reopened: false, intent: this.toSnapshot(existing) };
    }
    if (existing.imageTextStopListDeleteOnly === true) {
      return { reopened: false, intent: this.toSnapshot(existing) };
    }
    const independentNonCommercialOcrExecution = this.hasExecutableNonCommercialOcrReason(existing);
    const resetBotMessageAutoDeleteRetryLimit =
      existing.status === 'FAILED_TERMINAL' &&
      existing.lastErrorCode === BOT_MESSAGE_AUTO_DELETE_RETRY_LIMIT_ERROR_CODE &&
      !this.hasDeleteMutationEvidence(existing);

    const now = new Date();
    const retryUntilAt = new Date(now.getTime() + this.retryHorizonMs);
    const reopened = await this.runSerializableTransaction(async (tx) => {
      const rows = await tx.$queryRaw<IntentRow[]>(Prisma.sql`
        UPDATE "moderation_delete_intents"
        SET
          "status" = CASE
            WHEN "remote_delete_succeeded_at" IS NOT NULL
              OR "remote_delete_succeeded_bot_id" IS NOT NULL
              OR "delete_dispatch_started_at" IS NOT NULL
              OR "delete_dispatch_started_bot_id" IS NOT NULL
            THEN CAST('AMBIGUOUS' AS "ModerationDeleteIntentStatus")
            ELSE CAST('PENDING' AS "ModerationDeleteIntentStatus")
          END,
          "execute_at" = LEAST("execute_at", ${now}),
          "next_attempt_at" = ${now},
          "attempt_count" = CASE
            WHEN ${resetBotMessageAutoDeleteRetryLimit} THEN 0
            ELSE "attempt_count"
          END,
          "commercial_ocr_guard_required" = (
            "commercial_ocr_guard_required"
            OR EXISTS (
              SELECT 1
              FROM "moderation_delete_intent_reasons" existing_ocr_reason
              WHERE existing_ocr_reason."intent_id" = "moderation_delete_intents"."id"
                AND existing_ocr_reason."rule_code" = ${COMMERCIAL_OCR_DELETE_RULE_CODE}
            )
          ),
          "commercial_ocr_deadline_at" = CASE
            WHEN "commercial_ocr_guard_required" OR EXISTS (
              SELECT 1
              FROM "moderation_delete_intent_reasons" existing_ocr_reason
              WHERE existing_ocr_reason."intent_id" = "moderation_delete_intents"."id"
                AND existing_ocr_reason."rule_code" = ${COMMERCIAL_OCR_DELETE_RULE_CODE}
            )
            THEN COALESCE("commercial_ocr_deadline_at", "retry_until_at")
            ELSE "commercial_ocr_deadline_at"
          END,
          "retry_until_at" = CASE
            WHEN NOT ${independentNonCommercialOcrExecution} AND (
              "commercial_ocr_guard_required" OR EXISTS (
                SELECT 1
                FROM "moderation_delete_intent_reasons" existing_ocr_reason
                WHERE existing_ocr_reason."intent_id" = "moderation_delete_intents"."id"
                  AND existing_ocr_reason."rule_code" = ${COMMERCIAL_OCR_DELETE_RULE_CODE}
              )
            )
            THEN LEAST(
              GREATEST("retry_until_at", ${retryUntilAt}),
              COALESCE("commercial_ocr_deadline_at", "retry_until_at")
            )
            ELSE GREATEST("retry_until_at", ${retryUntilAt})
          END,
          "completed_at" = NULL,
          "last_status_code" = CASE
            WHEN ${resetBotMessageAutoDeleteRetryLimit} THEN NULL
            ELSE "last_status_code"
          END,
          "last_error_code" = CASE
            WHEN ${resetBotMessageAutoDeleteRetryLimit} THEN NULL
            ELSE "last_error_code"
          END,
          "last_error" = CASE
            WHEN ${resetBotMessageAutoDeleteRetryLimit} THEN NULL
            ELSE "last_error"
          END,
          "lease_token" = NULL,
          "lease_expires_at" = NULL,
          "leased_from_status" = NULL,
          "updated_at" = CURRENT_TIMESTAMP
        WHERE "id" = ${intentId}
          AND (NOT EXISTS (SELECT 1 FROM "webhook_source_abandonments" held
            WHERE held."chat_id" = "moderation_delete_intents"."chat_id"
              AND held."message_id" = "moderation_delete_intents"."message_id") AND NOT EXISTS (SELECT 1 FROM "webhook_backlog_receipts" cancelled
            WHERE cancelled."chat_id" = "moderation_delete_intents"."chat_id"
              AND cancelled."message_id" = "moderation_delete_intents"."message_id"))
          AND "status" = CAST(${expectedStatus} AS "ModerationDeleteIntentStatus")
          AND "updated_at" = ${expectedVersion.updatedAt}
          AND "attempt_count" = ${expectedVersion.attemptCount}
          AND (
            ${independentNonCommercialOcrExecution}
            OR
            NOT (
              "commercial_ocr_guard_required"
              OR EXISTS (
                SELECT 1
                FROM "moderation_delete_intent_reasons" existing_ocr_reason
                WHERE existing_ocr_reason."intent_id" = "moderation_delete_intents"."id"
                  AND existing_ocr_reason."rule_code" = ${COMMERCIAL_OCR_DELETE_RULE_CODE}
              )
            )
            OR COALESCE("commercial_ocr_deadline_at", "retry_until_at") > ${now}
          )
        RETURNING ${this.intentReturningSql()}
      `);
      const updated = rows[0] ?? null;
      if (updated && options?.actorUserId) {
        await tx.auditLog.create({
          data: {
            chatId: existing.chatId,
            actorUserId: options.actorUserId,
            action: 'SAFETY_DESK_REOPEN_DELETE_INTENT',
            payload: {
              intentId: existing.id,
              messageId: existing.messageId,
              previousStatus: expectedStatus,
              previousErrorCode: existing.lastErrorCode,
              previousStatusCode: existing.lastStatusCode,
              dispatchStartedAt: existing.deleteDispatchStartedAt?.toISOString() ?? null,
              dispatchStartedBotId: existing.deleteDispatchStartedBotId,
              retryUntilAt: updated.retryUntilAt.toISOString(),
            },
          },
        });
      }
      return updated;
    });
    if (!reopened) {
      return { reopened: false, intent: this.toSnapshot(await this.loadRequiredIntent(intentId)) };
    }
    reopened.replacementCleanup = existing.replacementCleanup;
    reopened.botMessageAutoDeleteReason = existing.botMessageAutoDeleteReason;
    reopened.botMessageAutoDeleteOnly = existing.botMessageAutoDeleteOnly;
    reopened.requiredSubscriptionDeleteReason = existing.requiredSubscriptionDeleteReason;
    reopened.commercialOcrDeleteReason = existing.commercialOcrDeleteReason;
    reopened.nonCommercialOcrDeleteReason = existing.nonCommercialOcrDeleteReason;
    reopened.durableUserDeleteReason = existing.durableUserDeleteReason;
    reopened.messageDuplicateOwned = existing.messageDuplicateOwned;
    await this.enqueueWakeup(reopened, DELETE_QUEUE_PRIORITY_INTERACTIVE);
    return { reopened: true, intent: this.toSnapshot(reopened) };
  }

  async executeLeasedIntent(
    intentId: string,
    leaseToken: string,
    options?: ModerationDeleteIntentAttemptOptions,
  ): Promise<ModerationDeleteAttemptResult> {
    const intent = await this.loadIntent(intentId);
    if (!intent) {
      throw new Error(`Moderation delete intent ${intentId} does not exist`);
    }
    // FLAG: A retained queued lease cannot mutate the abandoned source journal.
    // Only a complete saved remote-success receipt permits database settlement.
    if (await this.isAbandonedIntentWithoutReceipt(intent)) return this.toAttemptResult(intent);
    if (
      intent.status !== 'IN_PROGRESS' ||
      intent.leaseToken !== leaseToken ||
      !intent.leaseExpiresAt ||
      intent.leaseExpiresAt.getTime() <= Date.now()
    ) {
      return this.toAttemptResult(intent);
    }
    if (options?.retentionOnly && !intent.retentionOwned)
      return this.finishRetryableAttempt(intent, leaseToken, {
        status: 'RETRYABLE',
        statusCode: null,
        errorCode: 'retention_ownership_changed',
        message: 'Ordinary moderation owns this intent',
        retryDelayMs: 1_000,
      });
    if (!this.isExecutionEnabledForIntent(intent)) {
      await this.releasePausedLease(intent.id, leaseToken);
      return this.toAttemptResult(await this.loadRequiredIntent(intent.id));
    }
    // FLAG: A queued historical job may already be above the sweep cap. Terminalize it before
    // starting a heartbeat or making any MAX access, presence, or delete call.
    if (
      this.isBotMessageAutoDeleteRetryLimitApplicable(intent) &&
      intent.attemptCount > BOT_MESSAGE_AUTO_DELETE_MAX_EXTERNAL_ATTEMPTS
    ) {
      const retryLimitOutcome = await this.enforceBotMessageAutoDeleteRetryLimit(
        intent,
        leaseToken,
        true,
      );
      if (retryLimitOutcome.kind === 'terminal') {
        return this.toAttemptResult(retryLimitOutcome.intent);
      }
      if (retryLimitOutcome.kind === 'lease_lost') {
        return this.toAttemptResult(await this.loadRequiredIntent(intent.id));
      }
      Object.assign(intent, retryLimitOutcome.intent);
    }
    const heartbeat = this.startLeaseHeartbeat(intent.id, leaseToken);
    const execute = async (): Promise<ModerationDeleteAttemptResult> => {
      if (!this.hasDeleteMutationEvidence(intent)) {
        await this.assertLeaseForExternalCall(heartbeat);
        const protectedIntent = await this.finishProtectedManagedBotMessageAutoDelete(
          intent,
          leaseToken,
        );
        if (protectedIntent) {
          return this.toAttemptResult(protectedIntent);
        }
      }

      let route: MaxDeleteMessageBotRoute;
      try {
        route = await this.resolveDeleteRouteWithRefresh(intent, heartbeat);
      } catch (error: unknown) {
        if (error instanceof MaxModerationApiBudgetError) throw error;
        if (error instanceof ModerationDeleteIntentLeaseLostError) {
          throw error;
        }
        const details = this.describeError(error, 'route_lookup_failed');
        return this.finishRetryableAttempt(intent, leaseToken, {
          ...details,
          status: 'RETRYABLE',
          retryDelayMs: this.retryDelayMs(intent.attemptCount),
        });
      }

      const candidateBotIds = this.filterAndOrderRouteCandidates(intent, route);
      if (candidateBotIds.length === 0) {
        return this.finishRetryableAttempt(intent, leaseToken, {
          status: 'WAITING_CAPABILITY',
          statusCode: null,
          errorCode: route.capabilityReason || 'no_delete_capable_bot',
          message: `No active bot has fresh confirmed delete permission (${route.capabilityReason})`,
          retryDelayMs: this.capabilityRetryDelayMs(intent.attemptCount),
        });
      }

      const attemptedBotIds = new Set<string>();
      let lastAccessFailure: DeleteErrorDetails | null = null;
      let unresolvedDeleteDispatch = this.hasDeleteMutationEvidence(intent);
      while (candidateBotIds.length > 0) {
        const botId = candidateBotIds.shift()!;
        if (attemptedBotIds.has(botId)) {
          continue;
        }
        attemptedBotIds.add(botId);
        if (!(await this.recordAttemptBot(intent.id, leaseToken, botId))) {
          return this.toAttemptResult(await this.loadRequiredIntent(intent.id));
        }

        if (unresolvedDeleteDispatch) {
          try {
            const presence = await this.getExactMessagePresence(intent, botId, heartbeat);
            if (presence === 'absent') {
              if (
                intent.remoteDeleteSucceededAt &&
                intent.remoteDeleteSucceededBotId &&
                this.isBotMessageAutoDeleteOnlyReason(intent)
              ) {
                const completed = await this.completeSucceeded(
                  intent.id,
                  leaseToken,
                  botId,
                  'post_success_exact_absence',
                );
                return this.toAttemptResult(completed);
              }
              const completed = await this.completeAlreadyAbsent(
                intent.id,
                leaseToken,
                botId,
                'retry_predelete_exact_presence',
              );
              return this.toAttemptResult(completed);
            }
            if (this.isBotMessageAutoDeleteOnlyReason(intent)) {
              if (!(await this.clearBotMessageAutoDeleteMutationEvidence(intent.id, leaseToken))) {
                return this.toAttemptResult(await this.loadRequiredIntent(intent.id));
              }
              intent.deleteDispatchStartedAt = null;
              intent.deleteDispatchStartedBotId = null;
              intent.remoteDeleteSucceededAt = null;
              intent.remoteDeleteSucceededBotId = null;
              if (intent.attemptCount > BOT_MESSAGE_AUTO_DELETE_MAX_EXTERNAL_ATTEMPTS) {
                const retryLimitOutcome = await this.enforceBotMessageAutoDeleteRetryLimit(
                  intent,
                  leaseToken,
                  true,
                );
                if (retryLimitOutcome.kind === 'terminal') {
                  return this.toAttemptResult(retryLimitOutcome.intent);
                }
                if (retryLimitOutcome.kind === 'lease_lost') {
                  return this.toAttemptResult(await this.loadRequiredIntent(intent.id));
                }
                Object.assign(intent, retryLimitOutcome.intent);
              }
            }
            unresolvedDeleteDispatch = false;
          } catch (error: unknown) {
            if (error instanceof MaxModerationApiBudgetError) throw error;
            if (error instanceof ModerationDeleteIntentLeaseLostError) {
              throw error;
            }
            const details = this.describeError(error, 'predelete_presence_unknown');
            const waitingForCapability =
              details.statusCode === 404 ||
              this.isDeleteAccessFailure(details) ||
              this.isDeleteMessageNotFoundFailure(details);
            const localRetryDelayMs = waitingForCapability
              ? this.capabilityRetryDelayMs(intent.attemptCount)
              : this.retryDelayMs(intent.attemptCount);
            lastAccessFailure = {
              ...details,
              status: waitingForCapability ? 'WAITING_CAPABILITY' : 'AMBIGUOUS',
              errorCode: 'predelete_presence_unknown',
              retryDelayMs: Math.max(details.retryDelayMs ?? 0, localRetryDelayMs),
            };
            if (
              details.statusCode === 429 ||
              error instanceof MaxApiInternalRateLimitError ||
              (details.statusCode !== null && details.statusCode >= 500)
            ) {
              // FLAG: Quota/server failures prove neither absence nor capability loss. Keep
              // the dispatch marker and retry floor without more access or peer probes.
              return this.finishRetryableAttempt(
                { ...intent, lastBotId: botId },
                leaseToken,
                lastAccessFailure,
              );
            }
            await this.refreshCandidateAccess(intent, botId, heartbeat);
            await this.recordCandidateFailure(
              intent.id,
              leaseToken,
              botId,
              intent.attemptCount,
              lastAccessFailure,
            );
            route = await this.maxBotLinkService.resolveDeleteMessageBotRoute({
              chatId: intent.chatId,
              existingMessage: intent.originBotId
                ? { messageId: intent.messageId, botId: intent.originBotId }
                : undefined,
              expectedEntityType: intent.entityType,
              requireFreshSnapshot: true,
            });
            for (const nextBotId of this.filterAndOrderRouteCandidates(intent, route)) {
              if (!attemptedBotIds.has(nextBotId) && !candidateBotIds.includes(nextBotId)) {
                candidateBotIds.push(nextBotId);
              }
            }
            continue;
          }
        }

        let dispatchMarkerPersisted = false;
        let profanityVerified = false;
        let commercialVerifiedReasonKeys: string[] = [];
        let verifiedReasonKeys: string[] = [];
        try {
          await this.assertLeaseForExternalCall(heartbeat);
          const suggestionProof = intent.suggestionSubscriptionId
            ? await this.suggestionSubscriptions?.prepareDeletion(
                intent.suggestionSubscriptionId,
                botId,
              )
            : null;
          if (intent.suggestionSubscriptionId && !suggestionProof)
            throw new Error('Suggestion subscription guard unavailable');
          if (
            suggestionProof &&
            (suggestionProof.chatId !== intent.chatId ||
              suggestionProof.messageId !== intent.messageId)
          ) {
            throw new Error('Suggestion subscription intent identity changed');
          }
          const beforeImmediateDeleteMutation = async (
            beforeFinalAuthority?: () => Promise<void>,
          ) => {
            await this.assertLeaseForExternalCall(heartbeat);
            if (suggestionProof)
              await this.suggestionSubscriptions!.assertDeletionAllowed(suggestionProof);
            const protectedIntent = await this.finishProtectedManagedBotMessageAutoDelete(
              intent,
              leaseToken,
            );
            if (protectedIntent) {
              throw new ModerationDeleteProtectedMessageError(protectedIntent);
            }
            await this.runDeletePreDispatchGuards(intent, botId, options);
            if (!(await this.markDeleteDispatchStarted(intent.id, leaseToken, botId))) {
              throw new ModerationDeleteIntentLeaseLostError();
            }
            dispatchMarkerPersisted = true;
            intent.deleteDispatchStartedAt = new Date();
            intent.deleteDispatchStartedBotId = botId;
            unresolvedDeleteDispatch = true;
            // FLAG: Admission waits and preparation may consume the lease. SQL
            // ownership must be checked before the final policy guards; the
            // duplicate authority permit must remain the final awaited check.
            await this.assertLeaseForExternalCall(heartbeat, this.deleteTimeoutMs + 1_000);
            let textProof = await this.runDeletePreDispatchGuards(
              intent,
              botId,
              options,
              leaseToken,
              'dispatch',
              async () => {
                try {
                  await beforeFinalAuthority?.();
                } catch (error) {
                  throw new ModerationDeletePreDispatchGuardError(error);
                }
              },
            );
            profanityVerified = textProof.profanityVerified;
            commercialVerifiedReasonKeys = textProof.commercialVerifiedReasonKeys;
            verifiedReasonKeys = textProof.verifiedReasonKeys ?? [];
            if (suggestionProof)
              await this.suggestionSubscriptions!.assertDeletionAllowed(suggestionProof);
            // FLAG: The prepared composition has reserved the sole DELETE slot and
            // supplied fresh local authority for each surviving reason.
            let verifiedReasonAuthorityAtMs = await this.assertVerifiedReasonDeadlineFence(
              intent,
              leaseToken,
              botId,
              textProof,
            );
            if (this.messageDuplicateDeleteGuard && textProof.messageDuplicateVerified) {
              try {
                await this.messageDuplicateDeleteGuard.assertIntentStillActionable({
                  intentId: intent.id,
                  chatId: intent.chatId,
                  messageId: intent.messageId,
                  subjectUserId: intent.subjectUserId,
                  botId,
                  authorityOnly: true,
                });
              } catch (error) {
                if (!this.isTerminalDeleteGuardRejection(error))
                  throw new ModerationDeletePreDispatchGuardError(error);
                // FLAG: The last duplicate await may revoke an independent reason too.
                // Recheck its cached evidence locally once, without MAX reads or another quota.
                if (!textProof.independentVerified || !textProof.independentRecheck)
                  throw new ModerationDeletePreDispatchGuardError(error);
                try {
                  textProof = await finalizeDeleteAuthority(textProof.independentRecheck);
                } catch (recheckError) {
                  throw new ModerationDeletePreDispatchGuardError(recheckError);
                }
                profanityVerified = textProof.profanityVerified;
                commercialVerifiedReasonKeys = textProof.commercialVerifiedReasonKeys;
                verifiedReasonKeys = textProof.verifiedReasonKeys ?? [];
                verifiedReasonAuthorityAtMs = await this.assertVerifiedReasonDeadlineFence(
                  intent,
                  leaseToken,
                  botId,
                  textProof,
                );
              }
            }
            // FLAG: Later asynchronous guards cannot extend a short-lived traffic/OCR
            // permit. Check its original absolute expiry synchronously at the mutation boundary.
            if (
              !textProof.messageDuplicateVerified &&
              textProof.independentAuthorityDeadlineAtMs != null &&
              !verifiedReasonAuthorityAtMs
            ) {
              const changed = await this.prisma.$executeRaw(Prisma.sql`
                  UPDATE "moderation_delete_intents" SET "updated_at" = CURRENT_TIMESTAMP
                  WHERE "id" = ${intent.id}
                    AND "status" = CAST('IN_PROGRESS' AS "ModerationDeleteIntentStatus")
                    AND "lease_token" = ${leaseToken}
                    AND "lease_expires_at" > (clock_timestamp() AT TIME ZONE 'UTC')
                    AND "delete_dispatch_started_bot_id" = ${botId}
                    AND ${new Date(textProof.independentAuthorityDeadlineAtMs)} > (clock_timestamp() AT TIME ZONE 'UTC')
                `);
              if (changed !== 1)
                throw new ModerationDeletePreDispatchGuardError(
                  new ModerationDeleteReasonsRejectedError(textProof.guardedReasonFingerprint!),
                );
            }
            const finalAuthorityAtMs = Math.max(Date.now(), verifiedReasonAuthorityAtMs);
            if (
              !textProof.messageDuplicateVerified &&
              textProof.independentAuthorityDeadlineAtMs != null &&
              finalAuthorityAtMs >= textProof.independentAuthorityDeadlineAtMs
            ) {
              throw new ModerationDeletePreDispatchGuardError(
                new ModerationDeleteReasonsRejectedError(textProof.guardedReasonFingerprint!),
              );
            }
            // FLAG: A longer independent permit authorizes the shared DELETE only. It cannot
            // grant an expired rule its own durable receipt, audit event, strike or sanction.
            const reasonDeadlines = new Map(
              (textProof.verifiedReasonDeadlines ?? []).map((permit) => [
                permit.reasonKey,
                permit.deadlineAtMs,
              ]),
            );
            verifiedReasonKeys = verifiedReasonKeys.filter((reasonKey) => {
              const deadline = reasonDeadlines.get(reasonKey);
              return deadline === undefined || finalAuthorityAtMs < deadline;
            });
            if (!heartbeat.hasRemainingBudget(this.deleteTimeoutMs + 1_000))
              throw new ModerationDeleteIntentLeaseLostError();
          };
          // FLAG: Retention's remote checks must finish before reserving the DELETE
          // transport slot. Final guards may only revalidate cached evidence and DB authority.
          if (intent.retentionOwned)
            await this.runDeletePreDispatchGuards(intent, botId, options, undefined, 'prepare');
          // FLAG: Observe only typed duplicate-owned intents; transport admission and final
          // authority guards remain inside deleteMessage in their original order.
          await measureDuplicatePhase(
            intent.messageDuplicateOwned ? this.duplicateMetrics : undefined,
            'delete_dispatch',
            () =>
              this.maxClient.deleteMessage(intent.chatId, intent.messageId, {
                immediate: true,
                beforeImmediateDeleteMutation: withMaxFinalAuthorityCheckpoint(
                  beforeImmediateDeleteMutation,
                ),
                botId,
                timeoutMs: this.deleteTimeoutMs,
                trafficClass:
                  intent.retentionOwned ||
                  intent.suggestionSubscriptionId ||
                  intent.reportHistoryOnly
                    ? 'background'
                    : 'critical',
                actionHealthLane:
                  intent.retentionOwned ||
                  intent.suggestionSubscriptionId ||
                  intent.reportHistoryOnly
                    ? 'background'
                    : 'critical',
                sourceTag: intent.retentionOwned
                  ? MAX_API_SOURCE_TAGS.MESSAGE_RETENTION
                  : intent.suggestionSubscriptionId
                    ? MAX_API_SOURCE_TAGS.SUGGESTION_DELIVERY
                    : MAX_API_SOURCE_TAGS.MODERATION_DELETE,
                ignoreFailureMetricStatuses:
                  MODERATION_CHAT_ACTION_TERMINAL_FAILURE_METRIC_STATUSES,
                idempotencyKey: `moderation-delete-intent-${intent.id}-attempt-${intent.attemptCount}`,
              }),
          );
        } catch (error: unknown) {
          if (error instanceof MaxModerationApiBudgetError) {
            // FLAG: Only this attempt's proven pre-HTTP rejection clears its new dispatch marker.
            // Retained unknown outcomes and unmarked errors keep their reconciliation fence.
            if (dispatchMarkerPersisted && wasMaxPreDispatchGuardRejected(error)) {
              if (!(await this.clearDeleteDispatchStarted(intent.id, leaseToken, botId))) {
                throw new ModerationDeleteIntentLeaseLostError();
              }
              intent.deleteDispatchStartedAt = null;
              intent.deleteDispatchStartedBotId = null;
              unresolvedDeleteDispatch = false;
            }
            throw error;
          }
          if (error instanceof ModerationDeleteProtectedMessageError) {
            return this.toAttemptResult(error.protectedIntent);
          }
          if (error instanceof ModerationDeleteGuardedMessageAbsentError) {
            if (dispatchMarkerPersisted) {
              if (!(await this.clearDeleteDispatchStarted(intent.id, leaseToken, botId))) {
                throw new ModerationDeleteIntentLeaseLostError();
              }
              intent.deleteDispatchStartedAt = null;
              intent.deleteDispatchStartedBotId = null;
              unresolvedDeleteDispatch = false;
            }
            const completed = await this.completeAlreadyAbsent(
              intent.id,
              leaseToken,
              botId,
              error.verificationCode,
            );
            return this.toAttemptResult(completed);
          }
          if (error instanceof ModerationDeletePreDispatchGuardError) {
            if (dispatchMarkerPersisted) {
              if (!(await this.clearDeleteDispatchStarted(intent.id, leaseToken, botId))) {
                throw new ModerationDeleteIntentLeaseLostError();
              }
              intent.deleteDispatchStartedAt = null;
              intent.deleteDispatchStartedBotId = null;
              unresolvedDeleteDispatch = false;
            }
            if (error.guardError instanceof MaxModerationApiBudgetError) throw error.guardError;
            const details = this.describeError(
              error.guardError,
              'delete_pre_dispatch_guard_rejected',
            );
            if (
              error.guardError instanceof MessageDuplicateInitialSourceUnavailableError &&
              !dispatchMarkerPersisted &&
              !this.hasDeleteMutationEvidence(intent) &&
              intent.attemptCount === 1
            ) {
              // FLAG: An unavailable first source read may end only this inline action.
              // Commit the exact unattempted owner's retry before returning; preserve its
              // claim, reasons and deadline. A lost lease or failed write still propagates.
              try {
                const deferred = await this.finishRetryableAttempt(
                  intent,
                  leaseToken,
                  {
                    ...details,
                    status: 'RETRYABLE',
                    retryDelayMs: Math.max(
                      details.retryDelayMs ?? 0,
                      this.retryDelayMs(intent.attemptCount),
                    ),
                  },
                  true,
                );
                if (deferred.status !== 'RETRYABLE' && deferred.status !== 'EXPIRED')
                  throw error.guardError;
                return {
                  kind: 'inline_declined',
                  confirmed: false,
                  intentId: intent.id,
                  status: deferred.status,
                };
              } catch (persistenceError) {
                throw new ModerationDeletePreDispatchGuardError(persistenceError);
              }
            }
            const terminalGuardRejection = this.isTerminalDeleteGuardRejection(error.guardError);
            // FLAG: A final read can reveal revoked bot access while its saved proof is
            // still fresh. No DELETE ran. Switch only after a fresh own-member probe
            // confirms capability loss; a policy/storage error or unknown probe cannot
            // authorize a peer. Keep this same intent, lease, reasons and deadline.
            const definiteAccessRejection =
              details.statusCode === 401 ||
              details.statusCode === 403 ||
              (details.statusCode === 404 &&
                ['chat.denied', 'chat.not.found'].includes(details.errorCode.toLowerCase()));
            if (!terminalGuardRejection && definiteAccessRejection) {
              const refreshed = await this.refreshCandidateAccess(intent, botId, heartbeat);
              route = await this.maxBotLinkService.resolveDeleteMessageBotRoute({
                chatId: intent.chatId,
                existingMessage: intent.originBotId
                  ? { messageId: intent.messageId, botId: intent.originBotId }
                  : undefined,
                expectedEntityType: intent.entityType,
                requireFreshSnapshot: true,
              });
              const current = route.candidateCapabilities.find(
                (candidate) => candidate.botId === botId,
              );
              const state =
                refreshed !== 'unknown' && current?.state === 'explicitly_incapable'
                  ? await this.maxBotLinkService.loadChatExecutionOwnerState(intent.chatId)
                  : null;
              const membership = state?.candidates.find((candidate) => candidate.botId === botId);
              const snapshot = normalizeMembershipAccessSnapshot(membership?.permissionsSnapshot);
              const confirmedCapabilityLoss =
                current?.checkedAt === membership?.botAccessCheckedAt?.toISOString() &&
                (current?.reason === 'access_denied' ||
                  (snapshot !== null &&
                    ((!snapshot.isAdmin && !snapshot.isOwner) ||
                      (snapshot.permissionsKnown === true &&
                        !hasConfirmedDeleteMessageAccess(snapshot, intent.entityType)))));
              if (
                refreshed !== 'unknown' &&
                current?.state === 'explicitly_incapable' &&
                confirmedCapabilityLoss
              ) {
                lastAccessFailure = {
                  ...details,
                  status: 'WAITING_CAPABILITY',
                  certifiedCapabilityLoss: true,
                  retryDelayMs: this.capabilityRetryDelayMs(intent.attemptCount),
                };
                await this.recordCandidateFailure(
                  intent.id,
                  leaseToken,
                  botId,
                  intent.attemptCount,
                  lastAccessFailure,
                );
                for (const nextBotId of this.filterAndOrderRouteCandidates(intent, route)) {
                  if (!attemptedBotIds.has(nextBotId) && !candidateBotIds.includes(nextBotId))
                    candidateBotIds.push(nextBotId);
                }
                continue;
              }
            }
            const internalQuotaDeferral =
              !intent.retentionOwned && error.guardError instanceof MaxApiInternalRateLimitError;
            // FLAG: A guard GET's HTTP 429 keeps its validated retry floor in either
            // durable path. This delay grants no handoff authority or renewed deadline.
            const guardRetryDelayMs = Math.max(
              this.retryDelayMs(intent.attemptCount),
              internalQuotaDeferral
                ? (details.retryDelayMs ?? 0)
                : details.statusCode === 429
                  ? readMaxRetryAfterMs(error.guardError, Date.now())
                  : 0,
            );
            if (
              !terminalGuardRejection &&
              !internalQuotaDeferral &&
              options?.deferGuardFailure === true &&
              intent.durableUserDeleteReason === true &&
              !intent.messageDuplicateOwned &&
              !intent.retentionOwned &&
              error.origin === 'guard' &&
              !(error.guardError instanceof ModerationDeleteIntentLeaseLostError)
            ) {
              // FLAG: Only built-in pre-dispatch guards may transfer this retry. Commit
              // the exact live lease without mutation evidence first; caller ownership,
              // storage/CAS failures and unknown DELETE results never use this exception.
              try {
                return await this.finishRetryableAttempt(
                  intent,
                  leaseToken,
                  {
                    ...details,
                    status: 'RETRYABLE',
                    retryDelayMs: guardRetryDelayMs,
                  },
                  'guarded',
                );
              } catch (persistenceError) {
                throw new ModerationDeletePreDispatchGuardError(persistenceError);
              }
            }
            const outcome = terminalGuardRejection
              ? await this.finishTerminalPreDispatchGuardRejection(
                  intent,
                  leaseToken,
                  {
                    ...details,
                    status: 'FAILED_TERMINAL',
                    errorCode: details.errorCode,
                    retryDelayMs: null,
                  },
                  error.guardError,
                )
              : await this.finishRetryableAttempt(intent, leaseToken, {
                  ...details,
                  status: 'RETRYABLE',
                  errorCode: details.errorCode,
                  retryDelayMs: guardRetryDelayMs,
                });
            // FLAG: Internal quota rejection proves no DELETE happened. Its durable retry
            // may continue independently while the original engine finishes its other rules.
            if (terminalGuardRejection || internalQuotaDeferral) {
              return outcome;
            }
            throw error;
          }
          if (error instanceof ModerationDeleteIntentLeaseLostError) {
            throw error;
          }
          const details = this.classifyDeleteError(
            error,
            intent.attemptCount,
            dispatchMarkerPersisted ||
              unresolvedDeleteDispatch ||
              this.hasDeleteMutationEvidence(intent),
          );
          // FLAG: An unknown outcome after dispatch retains its fence. Error text cannot
          // authorize a peer DELETE or an access probe that would clear that evidence.
          if (details.status === 'AMBIGUOUS') {
            return this.finishRetryableAttempt(
              { ...intent, lastBotId: botId },
              leaseToken,
              details,
            );
          }
          if (details.errorCode === 'unverified_message_not_found') {
            const absence = await this.verifyMessageAbsence(intent, botId, heartbeat);
            if (absence === 'verified_absent') {
              const completed = await this.completeAlreadyAbsent(
                intent.id,
                leaseToken,
                botId,
                'postdelete_exact_presence',
              );
              return this.toAttemptResult(completed);
            }
            if (absence === 'message_present') {
              if (!(await this.clearDeleteDispatchStarted(intent.id, leaseToken, botId))) {
                return this.toAttemptResult(await this.loadRequiredIntent(intent.id));
              }
              intent.deleteDispatchStartedAt = null;
              intent.deleteDispatchStartedBotId = null;
              unresolvedDeleteDispatch = false;
              lastAccessFailure = {
                ...details,
                status: 'WAITING_CAPABILITY',
                errorCode: 'delete_404_message_still_present',
                message: 'MAX still returns the exact message after DELETE returned 404',
                retryDelayMs: this.capabilityRetryDelayMs(intent.attemptCount),
              };
            } else {
              return this.finishRetryableAttempt(
                { ...intent, lastBotId: botId },
                leaseToken,
                details,
              );
            }
          } else if (
            this.isDeleteAccessFailure(details) ||
            (details.status === 'WAITING_CAPABILITY' &&
              details.errorCode === 'max_action_executor_proof_rejected')
          ) {
            if (
              this.hasDeleteDispatchMarker(intent) &&
              !(await this.clearDeleteDispatchStarted(intent.id, leaseToken, botId))
            ) {
              return this.toAttemptResult(await this.loadRequiredIntent(intent.id));
            }
            intent.deleteDispatchStartedAt = null;
            intent.deleteDispatchStartedBotId = null;
            unresolvedDeleteDispatch = false;
            lastAccessFailure = details;
            await this.refreshCandidateAccess(intent, botId, heartbeat);
          } else if (details.status === 'FAILED_TERMINAL') {
            if (!(await this.clearDeleteDispatchStarted(intent.id, leaseToken, botId))) {
              return this.toAttemptResult(await this.loadRequiredIntent(intent.id));
            }
            intent.deleteDispatchStartedAt = null;
            intent.deleteDispatchStartedBotId = null;
            return this.finishRetryableAttempt(
              { ...intent, lastBotId: botId },
              leaseToken,
              details,
            );
          } else {
            return this.finishRetryableAttempt(
              { ...intent, lastBotId: botId },
              leaseToken,
              details,
            );
          }

          await this.recordCandidateFailure(
            intent.id,
            leaseToken,
            botId,
            intent.attemptCount,
            lastAccessFailure ?? details,
          );
          route = await this.maxBotLinkService.resolveDeleteMessageBotRoute({
            chatId: intent.chatId,
            existingMessage: intent.originBotId
              ? { messageId: intent.messageId, botId: intent.originBotId }
              : undefined,
            expectedEntityType: intent.entityType,
            requireFreshSnapshot: true,
          });
          for (const nextBotId of this.filterAndOrderRouteCandidates(intent, route)) {
            if (!attemptedBotIds.has(nextBotId) && !candidateBotIds.includes(nextBotId)) {
              candidateBotIds.push(nextBotId);
            }
          }
          continue;
        }

        const outcome = await measureDuplicatePhase(
          intent.messageDuplicateOwned ? this.duplicateMetrics : undefined,
          'delete_receipt',
          () =>
            this.recordRemoteSuccessAndFinalize(
              intent,
              leaseToken,
              botId,
              profanityVerified,
              commercialVerifiedReasonKeys,
              verifiedReasonKeys,
            ),
        );
        return outcome.kind === 'confirmed'
          ? {
              ...outcome,
              ...(verifiedReasonKeys.length ? { verifiedReasonKeys } : {}),
              ...(profanityVerified ? { profanityVerified: true as const } : {}),
              ...(commercialVerifiedReasonKeys.length
                ? { commercialVerified: true as const, commercialVerifiedReasonKeys }
                : {}),
            }
          : outcome;
      }

      return this.finishRetryableAttempt(
        intent,
        leaseToken,
        lastAccessFailure ?? {
          status: 'WAITING_CAPABILITY',
          statusCode: null,
          errorCode: 'delete_candidates_exhausted',
          message: 'All fresh delete-capable bot candidates were exhausted',
          retryDelayMs: this.capabilityRetryDelayMs(intent.attemptCount),
        },
      );
    };
    try {
      if (
        intent.remoteDeleteSucceededAt &&
        intent.remoteDeleteSucceededBotId &&
        !this.isBotMessageAutoDeleteOnlyReason(intent)
      ) {
        return this.finalizeRecordedRemoteSuccess(
          intent,
          leaseToken,
          intent.remoteDeleteSucceededBotId,
        );
      }

      // FLAG: Exact positive receipts settle above. Held legacy sources never spend
      // access/presence quota or acquire fresh DELETE authority; unknown markers stay intact.
      if (await this.isLegacyIntentHeld(intent)) {
        return this.finishRetryableAttempt(intent, leaseToken, {
          status: 'FAILED_TERMINAL',
          statusCode: null,
          errorCode: 'webhook_legacy_effect_held',
          message: 'Permanent legacy source or participant hold denies a new delete effect',
          retryDelayMs: 60_000,
        });
      }

      if (intent.entityType === 'CHAT' && intent.subjectUserId && intent.activeMuteDeleteReason) {
        return await this.maxClient.runWithMuteApiBudget(
          {
            chatId: intent.chatId,
            subjectUserId: intent.subjectUserId,
            intentId: intent.id,
            attemptCount: intent.attemptCount,
            // FLAG: Expired sources gain no new effect authority. Retained unknown outcomes
            // still need bounded exact-presence reconciliation under the original final guards.
            deadlineAtMs: this.hasDeleteMutationEvidence(intent)
              ? Math.max(intent.retryUntilAt.getTime(), Date.now() + 60_000)
              : intent.retryUntilAt.getTime(),
          },
          execute,
        );
      }
      return await execute();
    } catch (error: unknown) {
      if (error instanceof MaxModerationApiBudgetError) {
        return this.finishRetryableAttempt(intent, leaseToken, {
          status: this.hasDeleteMutationEvidence(intent) ? 'AMBIGUOUS' : 'RETRYABLE',
          statusCode: null,
          errorCode: `mute_api_budget_${error.reason}`,
          message: error.message,
          retryDelayMs: error.retryAfterMs,
        });
      }
      if (error instanceof ModerationDeletePreDispatchGuardError) {
        throw error.guardError;
      }
      if (error instanceof ModerationDeleteIntentLeaseLostError) {
        if (options?.deferGuardFailure) throw error;
        return this.toAttemptResult(await this.loadRequiredIntent(intent.id));
      }
      try {
        return await this.finishPersistenceFailure(
          intent,
          leaseToken,
          'delete_intent_execution_failed',
          error,
        );
      } catch (recoveryError: unknown) {
        this.logger.error(
          {
            intentId: intent.id,
            err: this.errorMessage(error),
            recoveryErr: this.errorMessage(recoveryError),
          },
          'Failed to release moderation delete intent lease after execution error',
        );
        throw error;
      }
    } finally {
      heartbeat.stop();
    }
  }

  async sweepDueIntents(): Promise<number> {
    const metrics = this.dueSweepMetrics;
    metrics.calls = addDueSweepCount(metrics.calls);
    try {
      await this.measureDueSweepStage(
        'expire',
        () => this.expireDueIntents(),
        (count) => count,
      );
      if (!this.hasAnyExecutionScope()) {
        metrics.executionDisabled = addDueSweepCount(metrics.executionDisabled);
        metrics.completed = addDueSweepCount(metrics.completed);
        return 0;
      }

      const dueIntents = await this.measureDueSweepStage(
        'select',
        () => this.selectDueIntentIds(),
        (intents) => intents.length,
      );
      metrics.selectedCount = addDueSweepCount(metrics.selectedCount, dueIntents.length);
      await this.measureDueSweepStage(
        'handoff',
        async () => {
          let acknowledged = 0;
          await Promise.all(
            dueIntents.map(async (intent) => {
              metrics.handoffAttemptedCount = addDueSweepCount(metrics.handoffAttemptedCount);
              try {
                await this.enqueueIntentJob(intent.id);
                acknowledged++;
                metrics.handoffAcknowledgedCount = addDueSweepCount(
                  metrics.handoffAcknowledgedCount,
                );
                // FLAG: BullMQ add acknowledges both new and duplicate deterministic jobs.
                // A receipt is not proof of insertion, pending work, or a completed delete.
                metrics.handoffInsertionUnknownCount = addDueSweepCount(
                  metrics.handoffInsertionUnknownCount,
                );
              } catch (error: unknown) {
                metrics.handoffErrorCount = addDueSweepCount(metrics.handoffErrorCount);
                this.logger.warn(
                  { intentId: intent.id, err: this.errorMessage(error) },
                  'Failed to enqueue due moderation delete intent; DB state remains retryable',
                );
              }
            }),
          );
          return acknowledged;
        },
        (count) => count,
      );
      metrics.completed = addDueSweepCount(metrics.completed);
      // FLAG: Preserve the historical selected-row return contract. Actual Redis
      // acknowledgements/errors are independent scalars; failed handoffs remain DB-retryable.
      return dueIntents.length;
    } catch (error: unknown) {
      metrics.errors = addDueSweepCount(metrics.errors);
      throw error;
    }
  }

  getDueSweepRuntimeSnapshot() {
    return {
      ...this.dueSweepMetrics,
      stages: Object.fromEntries(
        STORAGE_DELETE_DUE_SWEEP_STAGES.map((stage) => {
          const counters = this.dueSweepMetrics.stages[stage];
          return [stage, { ...counters, durationBuckets: { ...counters.durationBuckets } }];
        }),
      ),
    };
  }

  private async measureDueSweepStage<T>(
    stage: DeleteDueSweepStage,
    operation: () => Promise<T>,
    returnedCount: (result: T) => number,
  ): Promise<T> {
    const counters = this.dueSweepMetrics.stages[stage];
    counters.calls = addDueSweepCount(counters.calls);
    const startedAt = performance.now();
    try {
      const result = await operation();
      counters.succeeded = addDueSweepCount(counters.succeeded);
      const count = returnedCount(result);
      if (Number.isSafeInteger(count) && count >= 0)
        counters.returnedCount = addDueSweepCount(counters.returnedCount, count);
      return result;
    } catch (error: unknown) {
      counters.errors = addDueSweepCount(counters.errors);
      throw error;
    } finally {
      const elapsedMs = Math.max(0, performance.now() - startedAt);
      const durationMs = Math.min(Number.MAX_SAFE_INTEGER, Math.ceil(elapsedMs));
      counters.totalDurationMs = addDueSweepCount(counters.totalDurationMs, durationMs);
      counters.maxDurationMs = Math.max(counters.maxDurationMs, durationMs);
      const bucket =
        elapsedMs < 100
          ? 'under100Ms'
          : elapsedMs < 500
            ? 'under500Ms'
            : elapsedMs < 2_000
              ? 'under2000Ms'
              : 'atLeast2000Ms';
      counters.durationBuckets[bucket] = addDueSweepCount(counters.durationBuckets[bucket]);
    }
  }

  async recoverReplacementCleanupSources(): Promise<number> {
    if (!this.hasAnyExecutionScope()) {
      return 0;
    }
    const cutoff = new Date(Date.now() - this.retentionDays * 24 * 60 * 60_000);
    const markerRolloutFilter = this.buildRecoveryRolloutFilter(Prisma.sql`marker."chat_id"`);
    const rulesRolloutFilter = this.buildRecoveryRolloutFilter(Prisma.sql`rules."chat_id"`);
    const auditRolloutFilter = this.buildRecoveryRolloutFilter(Prisma.sql`audit."chat_id"`);
    const candidates = await this.prisma.$queryRaw<ReplacementCleanupRecoveryCandidate[]>(
      Prisma.sql`
        WITH recovery_candidates AS (
          SELECT
            marker."id" AS "sourceId",
            'channel_auto_post'::text AS "source",
            marker."chat_id" AS "chatId",
            marker."message_id" AS "messageId",
            COALESCE(marker."bot_id", intent."origin_bot_id") AS "originBotId",
            'CHANNEL'::text AS "entityType",
            'user'::text AS "messageAuthorKind",
            'origin_only'::text AS "routingPolicy",
            intent."id" AS "existingIntentId",
            intent."status" AS "existingIntentStatus",
            marker."updated_at" AS "createdAt"
          FROM "channel_auto_post_attach_markers" marker
          INNER JOIN "chats" channel_chat
            ON channel_chat."id" = marker."chat_id"
            AND channel_chat."entity_type" = CAST('CHANNEL' AS "ChatEntityType")
          LEFT JOIN "moderation_delete_intents" intent
            ON intent."chat_id" = marker."chat_id"
            AND intent."message_id" = marker."message_id"
          WHERE marker."status" IN (
              CAST('IN_PROGRESS' AS "ChannelAutoPostAttachStatus"),
              CAST('SUCCEEDED' AS "ChannelAutoPostAttachStatus")
            )
            AND ${markerRolloutFilter}
            AND marker."delivery_mode" = 'replace_with_bot_message'
            AND marker."replacement_message_id" IS NOT NULL
            AND (
              marker."bot_id" IS NOT NULL
              OR intent."origin_bot_id" IS NOT NULL
              OR intent."status" IN (
                CAST('SUCCEEDED' AS "ModerationDeleteIntentStatus"),
                CAST('ALREADY_ABSENT' AS "ModerationDeleteIntentStatus")
              )
            )
            AND marker."original_deleted" = false
            AND marker."updated_at" >= ${cutoff}
            AND (
              marker."status" = CAST('IN_PROGRESS' AS "ChannelAutoPostAttachStatus")
              OR marker."cleanup_intent_id" IS NULL
              OR intent."status" IN (
                CAST('OBSERVED' AS "ModerationDeleteIntentStatus"),
                CAST('SUCCEEDED' AS "ModerationDeleteIntentStatus"),
                CAST('ALREADY_ABSENT' AS "ModerationDeleteIntentStatus")
              )
              OR (
                intent."status" = CAST('EXPIRED' AS "ModerationDeleteIntentStatus")
                AND NOT EXISTS (
                  SELECT 1
                  FROM "moderation_delete_intent_reasons" recovery_reason
                  WHERE recovery_reason."intent_id" = intent."id"
                    AND recovery_reason."reason_key" =
                      'replacement-cleanup-recovery:channel_auto_post:' || marker."id"
                )
              )
            )

          UNION ALL

          SELECT
            rules."id" AS "sourceId",
            'chat_rules_state'::text AS "source",
            rules."chat_id" AS "chatId",
            rules."pending_cleanup_message_id" AS "messageId",
            COALESCE(rules."pending_cleanup_bot_id", intent."origin_bot_id") AS "originBotId",
            'CHAT'::text AS "entityType",
            'bot'::text AS "messageAuthorKind",
            'origin_only'::text AS "routingPolicy",
            intent."id" AS "existingIntentId",
            intent."status" AS "existingIntentStatus",
            rules."updated_at" AS "createdAt"
          FROM "chat_rules" rules
          LEFT JOIN "moderation_delete_intents" intent
            ON intent."chat_id" = rules."chat_id"
            AND intent."message_id" = rules."pending_cleanup_message_id"
          WHERE rules."pending_cleanup_message_id" IS NOT NULL
            AND ${rulesRolloutFilter}
            AND (
              rules."pending_cleanup_bot_id" IS NOT NULL
              OR intent."origin_bot_id" IS NOT NULL
              OR intent."status" IN (
                CAST('SUCCEEDED' AS "ModerationDeleteIntentStatus"),
                CAST('ALREADY_ABSENT' AS "ModerationDeleteIntentStatus")
              )
            )
            AND rules."updated_at" >= ${cutoff}
            AND (
              rules."pending_cleanup_intent_id" IS NULL
              OR intent."status" IN (
                CAST('OBSERVED' AS "ModerationDeleteIntentStatus"),
                CAST('SUCCEEDED' AS "ModerationDeleteIntentStatus"),
                CAST('ALREADY_ABSENT' AS "ModerationDeleteIntentStatus")
              )
              OR (
                intent."status" = CAST('EXPIRED' AS "ModerationDeleteIntentStatus")
                AND NOT EXISTS (
                  SELECT 1
                  FROM "moderation_delete_intent_reasons" recovery_reason
                  WHERE recovery_reason."intent_id" = intent."id"
                    AND recovery_reason."reason_key" =
                      'replacement-cleanup-recovery:chat_rules_state:' || rules."id"
                )
              )
            )

          UNION ALL

          SELECT
            marker."id" AS "sourceId",
            'chat_auto_comment'::text AS "source",
            marker."chat_id" AS "chatId",
            marker."message_id" AS "messageId",
            COALESCE(marker."bot_id", intent."origin_bot_id") AS "originBotId",
            'CHAT'::text AS "entityType",
            'user'::text AS "messageAuthorKind",
            'origin_first'::text AS "routingPolicy",
            intent."id" AS "existingIntentId",
            intent."status" AS "existingIntentStatus",
            marker."updated_at" AS "createdAt"
          FROM "chat_auto_comment_attach_markers" marker
          LEFT JOIN "moderation_delete_intents" intent
            ON intent."chat_id" = marker."chat_id"
            AND intent."message_id" = marker."message_id"
          WHERE marker."status" IN (
              CAST('IN_PROGRESS' AS "ChatAutoCommentAttachStatus"),
              CAST('SUCCEEDED' AS "ChatAutoCommentAttachStatus")
            )
            AND ${markerRolloutFilter}
            AND marker."delivery_mode" = 'replace_with_bot_message'
            AND marker."replacement_message_id" IS NOT NULL
            AND (
              marker."bot_id" IS NOT NULL
              OR intent."origin_bot_id" IS NOT NULL
              OR intent."status" IN (
                CAST('SUCCEEDED' AS "ModerationDeleteIntentStatus"),
                CAST('ALREADY_ABSENT' AS "ModerationDeleteIntentStatus")
              )
            )
            AND marker."original_deleted" = false
            AND marker."updated_at" >= ${cutoff}
            AND (
              marker."status" = CAST('IN_PROGRESS' AS "ChatAutoCommentAttachStatus")
              OR marker."cleanup_intent_id" IS NULL
              OR intent."status" IN (
                CAST('OBSERVED' AS "ModerationDeleteIntentStatus"),
                CAST('SUCCEEDED' AS "ModerationDeleteIntentStatus"),
                CAST('ALREADY_ABSENT' AS "ModerationDeleteIntentStatus")
              )
              OR (
                intent."status" = CAST('EXPIRED' AS "ModerationDeleteIntentStatus")
                AND NOT EXISTS (
                  SELECT 1
                  FROM "moderation_delete_intent_reasons" recovery_reason
                  WHERE recovery_reason."intent_id" = intent."id"
                    AND recovery_reason."reason_key" =
                      'replacement-cleanup-recovery:chat_auto_comment:' || marker."id"
                )
              )
            )

          UNION ALL

          SELECT
            audit."id" AS "sourceId",
            'chat_rules_republish'::text AS "source",
            audit."chat_id" AS "chatId",
            NULLIF(BTRIM(audit."payload"->>'previousPublishedMessageId'), '') AS "messageId",
            COALESCE(
              NULLIF(BTRIM(audit."payload"->>'previousPublishedBotId'), ''),
              NULLIF(BTRIM(audit."payload"->>'botId'), ''),
              intent."origin_bot_id"
            ) AS "originBotId",
            'CHAT'::text AS "entityType",
            'bot'::text AS "messageAuthorKind",
            'origin_only'::text AS "routingPolicy",
            intent."id" AS "existingIntentId",
            intent."status" AS "existingIntentStatus",
            audit."created_at" AS "createdAt"
          FROM "audit_logs" audit
          LEFT JOIN "moderation_delete_intents" intent
            ON intent."chat_id" = audit."chat_id"
            AND intent."message_id" = NULLIF(
              BTRIM(audit."payload"->>'previousPublishedMessageId'),
              ''
            )
          WHERE audit."action" = 'PUBLISH_CHAT_RULES'
            AND ${auditRolloutFilter}
            AND audit."payload"->>'previousCleanupOutcome' IN ('failed', 'accepted', 'owned')
            AND NULLIF(BTRIM(audit."payload"->>'previousPublishedMessageId'), '') IS NOT NULL
            AND (
              COALESCE(
                NULLIF(BTRIM(audit."payload"->>'previousPublishedBotId'), ''),
                NULLIF(BTRIM(audit."payload"->>'botId'), ''),
                intent."origin_bot_id"
              ) IS NOT NULL
              OR intent."status" IN (
                CAST('SUCCEEDED' AS "ModerationDeleteIntentStatus"),
                CAST('ALREADY_ABSENT' AS "ModerationDeleteIntentStatus")
              )
            )
            AND audit."created_at" >= ${cutoff}
            AND (
              intent."id" IS NULL
              OR intent."status" IN (
                CAST('OBSERVED' AS "ModerationDeleteIntentStatus"),
                CAST('SUCCEEDED' AS "ModerationDeleteIntentStatus"),
                CAST('ALREADY_ABSENT' AS "ModerationDeleteIntentStatus")
              )
              OR (
                intent."status" = CAST('EXPIRED' AS "ModerationDeleteIntentStatus")
                AND NOT EXISTS (
                  SELECT 1
                  FROM "moderation_delete_intent_reasons" recovery_reason
                  WHERE recovery_reason."intent_id" = intent."id"
                    AND recovery_reason."reason_key" =
                      'replacement-cleanup-recovery:chat_rules_republish:' || audit."id"
                )
              )
            )
        )
        SELECT *
        FROM recovery_candidates
        ORDER BY "createdAt" ASC, "sourceId" ASC
        LIMIT ${this.recoveryBatchSize}
      `,
    );

    let recovered = 0;
    for (const candidate of candidates) {
      const cleanupRuleCode = this.replacementCleanupRuleCode(candidate.source);
      if (this.getRolloutForRule(candidate.chatId, cleanupRuleCode) !== 'execute') {
        continue;
      }
      try {
        if (
          candidate.existingIntentId &&
          (candidate.existingIntentStatus === 'SUCCEEDED' ||
            candidate.existingIntentStatus === 'ALREADY_ABSENT')
        ) {
          await this.markReplacementCleanupConfirmed({
            id: candidate.existingIntentId,
            chatId: candidate.chatId,
            messageId: candidate.messageId,
          });
          recovered += 1;
          continue;
        }

        if (!candidate.originBotId) {
          continue;
        }

        const ensured = await this.persistIntent(
          {
            chatId: candidate.chatId,
            messageId: candidate.messageId,
            reasonKey: this.replacementCleanupReasonKey(candidate),
            ruleCode: cleanupRuleCode,
            entityType: candidate.entityType,
            messageAuthorKind: candidate.messageAuthorKind,
            originBotId: candidate.originBotId,
            routingPolicy: candidate.routingPolicy,
            event: {
              eventType: null,
              metadata: {
                source: candidate.source,
                sourceId: candidate.sourceId,
                recoveredBy: 'moderation_delete_intent_reconciler',
              },
            },
          },
          false,
        );
        const intentId = ensured.intentId;
        if (intentId) {
          await this.markRecoveredReplacementOwned(candidate, intentId);
          await this.enqueueCurrentWakeup(intentId);
        }
        recovered += 1;
      } catch (error: unknown) {
        this.logger.warn(
          {
            source: candidate.source,
            sourceId: candidate.sourceId,
            chatId: candidate.chatId,
            messageId: candidate.messageId,
            err: this.errorMessage(error),
          },
          'Failed to recover replacement cleanup into a durable delete intent',
        );
      }
    }
    return recovered;
  }

  async quarantineStaleReplacementSendFences(): Promise<number> {
    const staleBefore = new Date(Date.now() - MAX_SEND_FENCE_STALE_MS);
    const lastError = `${MAX_SEND_AMBIGUOUS_ERROR_PREFIX} Replacement send started, but no remote message id was persisted before worker recovery.`;
    const recoveredChannelReplies = await this.prisma.channelAutoPostAttachMarker.updateMany({
      where: {
        status: 'IN_PROGRESS',
        deliveryMode: 'reply_message',
        replyMessageId: { not: null },
        replacementSendStartedAt: null,
        OR: [{ lockedAt: null }, { lockedAt: { lte: staleBefore } }],
      },
      data: {
        status: 'SUCCEEDED',
        lockToken: null,
        lockedAt: null,
        lastError: null,
        lastStatusCode: null,
      },
    });
    const recoveredChatReplies = await this.prisma.chatAutoCommentAttachMarker.updateMany({
      where: {
        status: 'IN_PROGRESS',
        deliveryMode: 'reply_message',
        replyMessageId: { not: null },
        replacementSendStartedAt: null,
        OR: [{ lockedAt: null }, { lockedAt: { lte: staleBefore } }],
      },
      data: {
        status: 'SUCCEEDED',
        lockToken: null,
        lockedAt: null,
        lastError: null,
        lastStatusCode: null,
      },
    });
    const channel = await this.prisma.channelAutoPostAttachMarker.updateMany({
      where: {
        status: 'IN_PROGRESS',
        replacementSendStartedAt: { lte: staleBefore },
        replacementMessageId: null,
      },
      data: {
        status: 'SKIPPED',
        lockToken: null,
        lockedAt: null,
        lastError,
        lastStatusCode: null,
      },
    });
    const chat = await this.prisma.chatAutoCommentAttachMarker.updateMany({
      where: {
        status: 'IN_PROGRESS',
        replacementSendStartedAt: { lte: staleBefore },
        replacementMessageId: null,
      },
      data: {
        status: 'SKIPPED',
        lockToken: null,
        lockedAt: null,
        lastError,
        lastStatusCode: null,
      },
    });
    const quarantined = channel.count + chat.count;
    if (quarantined > 0) {
      this.logger.error(
        {
          channelMarkers: channel.count,
          chatMarkers: chat.count,
          staleBefore: staleBefore.toISOString(),
        },
        'Quarantined stale ambiguous replacement sends without retrying MAX',
      );
    }
    if (recoveredChannelReplies.count > 0 || recoveredChatReplies.count > 0) {
      this.logger.warn(
        {
          recoveredChannelReplies: recoveredChannelReplies.count,
          recoveredChatReplies: recoveredChatReplies.count,
          staleBefore: staleBefore.toISOString(),
        },
        'Finalized stale fallback replies with a persisted remote message id',
      );
    }
    return recoveredChannelReplies.count + recoveredChatReplies.count + quarantined;
  }

  private async markRecoveredReplacementOwned(
    candidate: ReplacementCleanupRecoveryCandidate,
    intentId: string,
  ): Promise<void> {
    if (candidate.source === 'chat_rules_republish') {
      return;
    }
    if (candidate.source === 'chat_rules_state') {
      await this.prisma.$executeRaw(Prisma.sql`
        UPDATE "chat_rules"
        SET
          "pending_cleanup_intent_id" = ${intentId},
          "updated_at" = CURRENT_TIMESTAMP
        WHERE "id" = ${candidate.sourceId}
          AND "pending_cleanup_message_id" = ${candidate.messageId}
      `);
      return;
    }
    if (candidate.source === 'channel_auto_post') {
      await this.prisma.$executeRaw(Prisma.sql`
        UPDATE "channel_auto_post_attach_markers"
        SET
          "status" = CAST('SUCCEEDED' AS "ChannelAutoPostAttachStatus"),
          "lock_token" = NULL,
          "locked_at" = NULL,
          "cleanup_intent_id" = ${intentId},
          "updated_at" = CURRENT_TIMESTAMP
        WHERE "id" = ${candidate.sourceId}
          AND "replacement_message_id" IS NOT NULL
          AND "original_deleted" = false
      `);
      return;
    }
    await this.prisma.$executeRaw(Prisma.sql`
      UPDATE "chat_auto_comment_attach_markers"
      SET
        "status" = CAST('SUCCEEDED' AS "ChatAutoCommentAttachStatus"),
        "lock_token" = NULL,
        "locked_at" = NULL,
        "cleanup_intent_id" = ${intentId},
        "updated_at" = CURRENT_TIMESTAMP
      WHERE "id" = ${candidate.sourceId}
        AND "replacement_message_id" IS NOT NULL
        AND "original_deleted" = false
    `);
  }

  async purgeRetainedIntents(): Promise<number> {
    const cutoff = new Date(Date.now() - this.retentionDays * 24 * 60 * 60_000);
    let total = 0;
    for (let batch = 0; batch < this.purgeMaxBatches; batch += 1) {
      const purged = await this.prisma.$executeRaw(Prisma.sql`
        WITH retained AS (
          SELECT intent."id", intent."status", intent."updated_at"
          FROM "moderation_delete_intents" intent
          WHERE intent."updated_at" < ${cutoff}
            AND intent."retention_owned" = FALSE
            AND (NOT EXISTS (SELECT 1 FROM "webhook_source_abandonments" held
              WHERE held."chat_id" = intent."chat_id" AND held."message_id" = intent."message_id") AND NOT EXISTS (SELECT 1 FROM "webhook_backlog_receipts" cancelled
              WHERE cancelled."chat_id" = intent."chat_id" AND cancelled."message_id" = intent."message_id"))
            AND intent."status" IN (
              CAST('OBSERVED' AS "ModerationDeleteIntentStatus"),
              CAST('SUCCEEDED' AS "ModerationDeleteIntentStatus"),
              CAST('ALREADY_ABSENT' AS "ModerationDeleteIntentStatus"),
              CAST('EXPIRED' AS "ModerationDeleteIntentStatus"),
              CAST('FAILED_TERMINAL' AS "ModerationDeleteIntentStatus")
            )
            -- FLAG: Cascade cleanup cannot erase pending continuation or unknown-effect fences.
            AND NOT EXISTS (
              SELECT 1 FROM "moderation_rule_followups" followup
              WHERE followup."intent_id" = intent."id"
                AND (followup."status" NOT IN ('COMPLETED', 'CANCELLED', 'EXPIRED')
                  OR followup."effects"->>'phase' IN ('BAN_STARTED', 'UNKNOWN'))
            )
            AND NOT EXISTS (
              SELECT 1
              FROM "channel_auto_post_attach_markers" marker
              WHERE marker."chat_id" = intent."chat_id"
                AND marker."message_id" = intent."message_id"
                AND marker."delivery_mode" = 'replace_with_bot_message'
                AND marker."replacement_message_id" IS NOT NULL
                AND marker."original_deleted" = false
                AND marker."status" IN (
                  CAST('IN_PROGRESS' AS "ChannelAutoPostAttachStatus"),
                  CAST('SUCCEEDED' AS "ChannelAutoPostAttachStatus")
                )
            )
            AND NOT EXISTS (
              SELECT 1
              FROM "chat_auto_comment_attach_markers" marker
              WHERE marker."chat_id" = intent."chat_id"
                AND marker."message_id" = intent."message_id"
                AND marker."delivery_mode" = 'replace_with_bot_message'
                AND marker."replacement_message_id" IS NOT NULL
                AND marker."original_deleted" = false
                AND marker."status" IN (
                  CAST('IN_PROGRESS' AS "ChatAutoCommentAttachStatus"),
                  CAST('SUCCEEDED' AS "ChatAutoCommentAttachStatus")
                )
            )
            AND NOT EXISTS (
              SELECT 1
              FROM "chat_rules" rules
              WHERE rules."chat_id" = intent."chat_id"
                AND rules."pending_cleanup_message_id" = intent."message_id"
            )
          ORDER BY intent."updated_at" ASC
          LIMIT ${this.sweepBatchSize}
          FOR UPDATE SKIP LOCKED
        ), report_receipts AS (
          -- FLAG: Journal receipts survive queue-ledger retention in the same transaction.
          UPDATE "chat_report_actions" action
          SET "receipt_status" = retained."status"::text,
            "receipt_updated_at" = GREATEST(action."receipt_updated_at", retained."updated_at")
          FROM retained
          WHERE action."intent_id" = retained."id"
          RETURNING action."id"
        )
        DELETE FROM "moderation_delete_intents" intent
        USING retained
        WHERE intent."id" = retained."id"
      `);
      total += purged;
      if (purged < this.sweepBatchSize) {
        break;
      }
    }
    return total;
  }

  private async isLegacyIntentHeld(intent: IntentRow): Promise<boolean> {
    if (!this.legacyHolds) return false;
    if (await this.legacyHolds.isMessageHeld(intent.chatId, intent.messageId)) return true;
    if (intent.botMessageAutoDeleteReason === true || intent.botMessageAutoDeleteOnly === true) {
      // FLAG: Legacy source_message_at may contain the webhook delivery clock.
      // Only explicit original-message evidence can prove post-seal cleanup; a
      // missing/old reason is held at preparation and again at the MAX boundary.
      const reason = await this.prisma.moderationDeleteIntentReason.findUnique({
        where: {
          intentId_reasonKey: { intentId: intent.id, reasonKey: BOT_MESSAGE_AUTO_DELETE_RULE_CODE },
        },
        select: { ruleCode: true, metadata: true },
      });
      const sourceAt =
        reason?.ruleCode === BOT_MESSAGE_AUTO_DELETE_RULE_CODE
          ? readLegacyBotCleanupSourceAt(reason.metadata)
          : null;
      if (await this.legacyHolds.isLegacyChatSendHeld(intent.chatId, sourceAt ?? new Date(NaN)))
        return true;
    }
    return (
      !!intent.subjectUserId && this.legacyHolds.isMemberHeld(intent.chatId, intent.subjectUserId)
    );
  }

  private async runDeletePreDispatchGuards(
    intent: IntentRow,
    botId: string,
    options?: ModerationDeleteIntentAttemptOptions,
    finalDispatchLeaseToken?: string,
    retentionPhase: 'prepare' | 'dispatch' = 'dispatch',
    beforeFinalAuthority?: () => Promise<void>,
  ): Promise<{
    profanityVerified: boolean;
    commercialVerifiedReasonKeys: string[];
    verifiedReasonKeys?: string[];
    verifiedReasonDeadlines?: VerifiedDeleteReasonDeadline[];
    messageDuplicateVerified?: boolean;
    independentVerified?: boolean;
    independentAuthorityDeadlineAtMs?: number | null;
    guardedReasonFingerprint?: string;
    independentRecheck?: PreparedDeleteAuthority<GuardedDeleteAuthorityProof>;
  }> {
    try {
      if (await this.isLegacyIntentHeld(intent)) throw new WebhookLegacyHoldRejectedError();
      let profanityVerified = false;
      let commercialVerifiedReasonKeys: string[] = [];
      let messageDuplicateVerified = false;
      let independentVerified = false;
      let independentAuthorityDeadlineAtMs: number | null = null;
      let guardedReasonFingerprint: string | undefined;
      let independentRecheck: PreparedDeleteAuthority<GuardedDeleteAuthorityProof> | undefined;
      let verifiedReasonKeys: string[] = [];
      let verifiedReasonDeadlines: VerifiedDeleteReasonDeadline[] = [];
      if (intent.retentionOwned) {
        if (!this.messageRetentionGuard) throw new Error('Retention delete guard unavailable');
        await beforeFinalAuthority?.();
        await this.messageRetentionGuard.assertAllowed(intent.id, botId, retentionPhase);
        return { profanityVerified, commercialVerifiedReasonKeys };
      }
      // FLAG: A remote DELETE must always have a durable reason at the exact dispatch boundary.
      // Derived rule classifiers cannot represent a reasonless intent and therefore cannot fence it.
      // FLAG: A channel replacement cleanup must never cross an entity reclassification boundary.
      await this.assertChannelAutoPostCleanupStillAuthorized(intent, botId);
      // FLAG: A delayed close-notice cleanup is bound to the exact open session, settings
      // generation and persisted notice event. Re-check all three at the transport-final boundary.
      await this.assertNightModeCloseNoticeCleanupStillAuthorized(intent);
      const commercialOcrGuardRequired = await this.resolveDeleteIntentCommercialOcrGuard(intent);
      // FLAG: A durable photo-only retry must regain authorization from current chat settings and
      // a fresh shared runtime control immediately before every remote DELETE mutation.
      await this.assertPhotoDuplicateDeleteIntentStillActionable(intent);
      const imageTextPreparation = finalDispatchLeaseToken
        ? await this.prepareImageTextStopListDeleteAuthority(intent, botId)
        : await this.assertImageTextStopListDeleteIntentStillActionable(intent, botId);
      let imageTextStopListGuard = isPreparedDeleteAuthority(imageTextPreparation)
        ? undefined
        : imageTextPreparation;
      if (imageTextStopListGuard === 'absent') {
        throw new ModerationDeleteGuardedMessageAbsentError(
          'guarded_image_text_stop_list_predispatch_exact_absence',
        );
      }
      if (commercialOcrGuardRequired && !finalDispatchLeaseToken) {
        // FLAG: OCR is asynchronous. Bind every OCR-only DELETE to the current exact message,
        // author immunity, filter setting, runtime rollout and behavior versions at dispatch time.
        const result = await this.commercialOcrDeleteGuard.assertIntentStillActionable({
          intentId: intent.id,
          chatId: intent.chatId,
          messageId: intent.messageId,
          subjectUserId: intent.subjectUserId,
          sourceMessageAt: intent.sourceMessageAt,
          botId,
        });
        if (result === 'absent') {
          throw new ModerationDeleteGuardedMessageAbsentError(
            'guarded_commercial_ocr_predispatch_exact_absence',
          );
        }
        if (result !== 'allowed') throw new Error('Required OCR guard did not supply authority');
      }
      if (intent.linkFamilyDeleteOnly === true && !finalDispatchLeaseToken) {
        const result = await this.linkHistoryDeleteGuard.assertIntentStillActionable({
          intentId: intent.id,
          chatId: intent.chatId,
          messageId: intent.messageId,
          subjectUserId: intent.subjectUserId,
          botId,
        });
        if (result === 'absent') {
          throw new ModerationDeleteGuardedMessageAbsentError(
            'guarded_link_predispatch_exact_absence',
          );
        }
        if (result !== 'allowed') {
          throw new Error('Guarded link delete intent lost its required reason metadata');
        }
      }
      try {
        await options?.beforeDeleteMutation?.(
          !finalDispatchLeaseToken &&
            intent.attemptCount === 1 &&
            !this.hasDeleteMutationEvidence(intent)
            ? 'initial_unattempted'
            : 'recheck',
        );
      } catch (error) {
        if (error instanceof ModerationDeleteGuardedMessageAbsentError) throw error;
        throw new ModerationDeletePreDispatchGuardError(error, 'caller');
      }
      let reportPreparation: DeleteAuthorityPreparation<unknown>;
      if (finalDispatchLeaseToken) {
        const reportReasons = await this.prisma.moderationDeleteIntentReason.findMany({
          where: { intentId: intent.id },
          select: { ruleCode: true },
        });
        const hasReportReason = reportReasons.some((r) => REPORT_GUARDED_RULES.has(r.ruleCode));
        if (!this.reportDeleteGuard && hasReportReason)
          throw new Error('Participant report delete guard unavailable');
        if (this.reportDeleteGuard && !hasReportReason)
          reportPreparation = await this.reportDeleteGuard.prepareForDispatch({
            intentId: intent.id,
            chatId: intent.chatId,
            messageId: intent.messageId,
            subjectUserId: intent.subjectUserId,
            botId,
            trafficClass: intent.reportHistoryOnly ? 'background' : 'critical',
            isIndependentReasonExecutable: (reasons) =>
              this.hasExecutableIndependentReportReason(intent.chatId, reasons),
          });
      }
      if (finalDispatchLeaseToken) {
        // FLAG: Independent user rules share one DELETE, not each other's authorization.
        // A stale binding may yield only to a freshly verified reason on this exact attempt.
        const proof = await this.authorizeGuardedUserDeleteReasons(
          intent,
          botId,
          finalDispatchLeaseToken,
          async () => {
            await beforeFinalAuthority?.();
            imageTextStopListGuard = await finalizeDeleteAuthority(imageTextPreparation);
            const report = await finalizeDeleteAuthority(reportPreparation);
            if (report === 'absent')
              throw new ModerationDeleteGuardedMessageAbsentError('guarded_report_absence');
            await this.assertChannelAutoPostCleanupLocalAuthority(intent);
            await this.assertNightModeCloseNoticeCleanupStillAuthorized(intent);
          },
        );
        independentVerified = proof.independentVerified;
        profanityVerified = proof.profanityVerified;
        commercialVerifiedReasonKeys = proof.commercialVerifiedReasonKeys;
        messageDuplicateVerified = proof.messageDuplicateVerified;
        independentAuthorityDeadlineAtMs = proof.independentAuthorityDeadlineAtMs;
        guardedReasonFingerprint = proof.guardedReasonFingerprint;
        independentRecheck = proof.independentRecheck;
        verifiedReasonKeys = proof.verifiedReasonKeys;
        verifiedReasonDeadlines = proof.verifiedReasonDeadlines;
      }
      if (typeof imageTextStopListGuard === 'object' && finalDispatchLeaseToken) {
        await this.assertImageTextStopListDispatchDeadline(
          intent.id,
          finalDispatchLeaseToken,
          botId,
        );
        // FLAG: Only these freshly authorized OCR reasons may receive the confirmed DELETE
        // receipt. Keep each original expiry through all later awaited guards and mixed reasons.
        verifiedReasonKeys.push(
          ...imageTextStopListGuard.reasonDeadlines.map((permit) => permit.reasonKey),
        );
        verifiedReasonDeadlines.push(...imageTextStopListGuard.reasonDeadlines);
        independentAuthorityDeadlineAtMs = Math.min(
          ...imageTextStopListGuard.reasonDeadlines.map((permit) => permit.deadlineAtMs),
        );
      }
      return {
        profanityVerified,
        commercialVerifiedReasonKeys,
        messageDuplicateVerified,
        independentVerified,
        independentAuthorityDeadlineAtMs,
        guardedReasonFingerprint,
        independentRecheck,
        verifiedReasonKeys,
        verifiedReasonDeadlines,
      };
    } catch (error: unknown) {
      if (error instanceof ModerationDeleteGuardedMessageAbsentError) {
        throw error;
      }
      if (error instanceof ModerationDeletePreDispatchGuardError) throw error;
      throw new ModerationDeletePreDispatchGuardError(error);
    }
  }

  private async assertVerifiedReasonDeadlineFence(
    intent: IntentRow,
    leaseToken: string,
    botId: string,
    proof: {
      verifiedReasonDeadlines?: readonly VerifiedDeleteReasonDeadline[];
      independentAuthorityDeadlineAtMs?: number | null;
      messageDuplicateVerified?: boolean;
      guardedReasonFingerprint?: string;
    },
  ): Promise<number> {
    if (!proof.verifiedReasonDeadlines?.length) return 0;
    const deadline = proof.messageDuplicateVerified ? null : proof.independentAuthorityDeadlineAtMs;
    // FLAG: Capture the database clock before duplicate's final awaited authority check.
    // Even with unbounded content authority, every bounded receipt keeps its own expiry.
    const rows = await this.prisma.$queryRaw<
      { verifiedReasonAuthorityAt: Date; verifiedReasonLeaseExpiresAt: Date }[]
    >(Prisma.sql`
      UPDATE "moderation_delete_intents" SET "updated_at" = CURRENT_TIMESTAMP
      WHERE "id" = ${intent.id}
        AND "status" = CAST('IN_PROGRESS' AS "ModerationDeleteIntentStatus")
        AND "lease_token" = ${leaseToken}
        AND "lease_expires_at" > (clock_timestamp() AT TIME ZONE 'UTC')
        AND "delete_dispatch_started_bot_id" = ${botId}
        AND ${deadline == null ? Prisma.sql`TRUE` : Prisma.sql`${new Date(deadline)} > (clock_timestamp() AT TIME ZONE 'UTC')`}
      RETURNING (clock_timestamp() AT TIME ZONE 'UTC') AS "verifiedReasonAuthorityAt",
        "lease_expires_at" AS "verifiedReasonLeaseExpiresAt"
    `);
    const clockAtMs = rows[0]?.verifiedReasonAuthorityAt?.getTime();
    const leaseExpiresAtMs = rows[0]?.verifiedReasonLeaseExpiresAt?.getTime();
    if (
      !clockAtMs ||
      !Number.isSafeInteger(clockAtMs) ||
      !leaseExpiresAtMs ||
      clockAtMs >= leaseExpiresAtMs
    )
      throw new ModerationDeletePreDispatchGuardError(
        new ModerationDeleteReasonsRejectedError(proof.guardedReasonFingerprint!),
      );
    return clockAtMs;
  }

  private async authorizeGuardedUserDeleteReasons(
    intent: IntentRow,
    botId: string,
    finalDispatchLeaseToken?: string,
    beforeFinalAuthority?: () => Promise<void>,
  ): Promise<GuardedDeleteAuthorityProof> {
    const reasons = await this.prisma.moderationDeleteIntentReason.findMany({
      where: { intentId: intent.id },
      select: { ruleCode: true, reasonKey: true, score: true, metadata: true },
      orderBy: { reasonKey: 'asc' },
      take: 65,
    });
    if (!reasons.length) throw new ModerationDeleteReasonMissingError();
    if (reasons.length > 64) throw new Error('Moderation delete reason validation limit exceeded');
    const fingerprint = fingerprintGuardedDeleteReasons(reasons);
    const params = {
      intentId: intent.id,
      chatId: intent.chatId,
      messageId: intent.messageId,
      subjectUserId: intent.subjectUserId,
      botId,
      ownedReasonsOnly: true,
      sourceMessageAt: intent.sourceMessageAt,
    };
    const deferred = beforeFinalAuthority !== undefined;
    type Candidate = {
      tag: 'ordinary' | 'profanity' | 'commercial' | 'duplicate' | 'ocr' | 'traffic';
      keys: string[];
      preparation: DeleteAuthorityPreparation<unknown>;
      fixedDeadlines?: VerifiedDeleteReasonDeadline[];
      authoritySnapshot?: {
        keys: string[];
        deadlineAtMs: number | null;
        deadlines: VerifiedDeleteReasonDeadline[];
      };
    };
    const candidates: Candidate[] = [];
    let recognized = false;
    let stopWordsRejectionReason: StopWordsGuardRejectionReason | undefined;
    const rejected = (error: unknown) => {
      // FLAG: Unknown remote/storage state stops this attempt; only a definite
      // policy/content rejection may yield to another independently prepared reason.
      if (!this.isTerminalDeleteGuardRejection(error)) throw error;
      if (error instanceof StopWordsDeleteGuardRejectedError)
        stopWordsRejectionReason = error.rejectionReason;
    };
    const prepare = async (
      run: () => Promise<DeleteAuthorityPreparation<unknown>>,
      keys: string[] = [],
      tag: Candidate['tag'] = 'ordinary',
      fixedDeadlines?: VerifiedDeleteReasonDeadline[],
    ) => {
      recognized = true;
      try {
        const preparation = await run();
        if (preparation === 'absent')
          throw new ModerationDeleteGuardedMessageAbsentError('guarded_current_message_absence');
        candidates.push({ preparation, keys, tag, fixedDeadlines });
      } catch (error) {
        rejected(error);
      }
    };
    const keysFor = (matches: (rule: string) => boolean) =>
      reasons.filter((r) => matches(r.ruleCode)).map((r) => r.reasonKey);
    if (reasons.some((r) => MESSAGE_LIMITS_GUARDED_RULES.has(r.ruleCode))) {
      if (!this.messageLimitsDeleteGuard)
        throw new Error('Message limits delete guard unavailable');
      await prepare(() =>
        deferred
          ? this.messageLimitsDeleteGuard!.prepareForDispatch({ ...params, reasons })
          : this.messageLimitsDeleteGuard!.authorize({ ...params, reasons }),
      );
    }
    if (reasons.some((r) => STOP_WORDS_DELETE_RULE_CODES.has(r.ruleCode))) {
      if (!this.stopWordsDeleteGuard) throw new Error('Stop-list delete guard unavailable');
      await prepare(() =>
        deferred
          ? this.stopWordsDeleteGuard!.prepareForDispatch(params)
          : this.stopWordsDeleteGuard!.authorizeIntent(params),
      );
    }
    if (reasons.some((r) => r.ruleCode === PROFANITY_DELETE_RULE_CODE)) {
      await prepare(
        () =>
          deferred
            ? this.profanityDeleteGuard.prepareForDispatch(params)
            : this.profanityDeleteGuard.assertIntentStillActionable(params),
        keysFor((r) => r === PROFANITY_DELETE_RULE_CODE),
        'profanity',
      );
    }
    if (reasons.some((r) => r.ruleCode === COMMERCIAL_LLM_DELETE_RULE_CODE)) {
      if (!this.commercialLlmGuard) throw new Error('Commercial AI guard unavailable');
      await prepare(() =>
        deferred
          ? this.commercialLlmGuard!.prepareForDispatch({ ...params, reasons })
          : this.commercialLlmGuard!.authorize({ ...params, reasons }),
      );
    }
    if (reasons.some((r) => r.ruleCode === COMMERCIAL_TEXT_DELETE_RULE_CODE)) {
      if (!this.commercialDeleteGuard) throw new Error('Commercial delete guard unavailable');
      await prepare(
        () =>
          deferred
            ? this.commercialDeleteGuard!.prepareForDispatch(params)
            : this.commercialDeleteGuard!.assertIntentStillActionable(params),
        [],
        'commercial',
      );
    }
    if (
      reasons.some(
        (r) =>
          r.ruleCode === LINK_BLOCKED_DELETE_RULE_CODE ||
          r.ruleCode === LINK_HISTORY_RECOVERY_RULE_CODE,
      )
    ) {
      await prepare(
        () =>
          deferred
            ? this.linkHistoryDeleteGuard.prepareForDispatch(params)
            : this.linkHistoryDeleteGuard.assertIntentStillActionable(params),
        keysFor(
          (r) => r === LINK_BLOCKED_DELETE_RULE_CODE || r === LINK_HISTORY_RECOVERY_RULE_CODE,
        ),
      );
    }
    if (reasons.some((r) => REPORT_GUARDED_RULES.has(r.ruleCode))) {
      if (!this.reportDeleteGuard) throw new Error('Participant report delete guard unavailable');
      const reportParams = {
        ...params,
        trafficClass: intent.reportHistoryOnly ? ('background' as const) : ('critical' as const),
        isIndependentReasonExecutable: () => false,
      };
      await prepare(() =>
        deferred
          ? this.reportDeleteGuard!.prepareForDispatch(reportParams)
          : this.reportDeleteGuard!.assertIntentStillActionable(reportParams),
      );
    }
    if (reasons.some((r) => MODERATION_STATE_DELETE_RULES.has(r.ruleCode))) {
      if (!this.moderationStateDeleteGuard)
        throw new Error('Moderation state delete guard unavailable');
      await prepare(() =>
        deferred
          ? this.moderationStateDeleteGuard!.prepareForDispatch({ ...params, reasons })
          : this.moderationStateDeleteGuard!.authorize({ ...params, reasons }),
      );
    }
    if (reasons.some((r) => CLOSED_CHAT_DELETE_RULE_CODES.has(r.ruleCode))) {
      if (!this.closedChatDeleteGuard) throw new Error('Closed chat delete guard unavailable');
      await prepare(() =>
        deferred
          ? this.closedChatDeleteGuard!.prepareForDispatch({ ...params, reasons })
          : this.closedChatDeleteGuard!.authorize({ ...params, reasons }),
      );
    }
    if (reasons.some((r) => r.ruleCode === REQUIRED_SUBSCRIPTION_DELETE_RULE_CODE)) {
      if (!this.requiredSubscriptionExecutionGuard)
        throw new Error('Required subscription execution guard unavailable');
      await prepare(() =>
        deferred
          ? this.requiredSubscriptionExecutionGuard!.prepareForDispatch({ ...params, reasons })
          : this.requiredSubscriptionExecutionGuard!.authorize({ ...params, reasons }),
      );
    }
    if (reasons.some((r) => TRAFFIC_PROTECTION_DELETE_RULE_CODES.has(r.ruleCode))) {
      if (!this.trafficProtectionDeleteGuard)
        throw new Error('Traffic protection delete guard unavailable');
      const trafficParams = { ...params, includeDeadlinePermit: true };
      await prepare(
        () =>
          deferred
            ? this.trafficProtectionDeleteGuard!.prepareForDispatch(trafficParams)
            : this.trafficProtectionDeleteGuard!.assertIntentStillActionable(trafficParams),
        [],
        'traffic',
      );
    }
    const standardOcr = reasons.filter(
      (r) =>
        r.ruleCode === COMMERCIAL_OCR_DELETE_RULE_CODE &&
        this.asRecord(r.metadata)?.source !== 'image_text_ocr',
    );
    if (standardOcr.length) {
      await prepare(
        () =>
          deferred
            ? this.commercialOcrDeleteGuard.prepareForDispatch(params)
            : this.commercialOcrDeleteGuard.assertIntentStillActionable(params),
        [],
        'ocr',
      );
    }

    if (
      reasons.some(
        (r) =>
          r.reasonKey.startsWith('MESSAGE_DUPLICATE:') ||
          this.asRecord(r.metadata)?.duplicateSource === MESSAGE_DUPLICATE_SOURCE,
      )
    ) {
      if (!this.messageDuplicateDeleteGuard)
        throw new Error('Message duplicate delete guard unavailable');
      const receipts = reasons.flatMap((r) => {
        const binding =
          r.ruleCode === 'DUPLICATE_DELETE' ? parseMessageDuplicateBinding(r.metadata) : null;
        return binding?.version === 3 && binding.original && binding.authorization
          ? [
              {
                reasonKey: r.reasonKey,
                deadlineAtMs: Math.min(
                  binding.authorization.deadlineAtMs,
                  binding.original.expiresAtMs,
                ),
              },
            ]
          : [];
      });
      await prepare(
        () => this.messageDuplicateDeleteGuard!.assertIntentStillActionable(params),
        receipts.map((r) => r.reasonKey),
        'duplicate',
        receipts,
      );
    }
    // FLAG: All MAX evidence is prepared before the sole transport reservation. Only
    // local/SQL/Redis feature finalizers may run after it; each reason keeps its own result.
    if (recognized && !candidates.length)
      throw new ModerationDeleteReasonsRejectedError(fingerprint, stopWordsRejectionReason);
    await beforeFinalAuthority?.();
    const finalizeCandidates = async (
      activeCandidates: readonly Candidate[],
      allowIndependentRecheck: boolean,
    ): Promise<GuardedDeleteAuthorityProof> => {
      if (deferred && (await this.isLegacyIntentHeld(intent)))
        throw new WebhookLegacyHoldRejectedError();
      let allowed = false;
      let independentVerified = false;
      let unboundedIndependent = false;
      let independentDeadline = 0;
      let profanityVerified = false;
      let messageDuplicateVerified = false;
      let commercialVerifiedReasonKeys: string[] = [];
      const verifiedReasonKeys = new Set<string>();
      const verifiedReasonDeadlines = new Map<string, number>();
      const independentCandidates: Candidate[] = [];
      for (const candidate of activeCandidates) {
        try {
          const result = await finalizeDeleteAuthority(candidate.preparation);
          if (result === 'absent')
            throw new ModerationDeleteGuardedMessageAbsentError('guarded_current_message_absence');
          if (result !== 'allowed' && (typeof result !== 'object' || result === null))
            throw new Error('Required moderation reason guard did not supply authority');
          const proof =
            typeof result === 'object' && result !== null
              ? (result as {
                  reasonKeys?: string[];
                  deadlineAtMs?: number;
                  reasonDeadlines?: VerifiedDeleteReasonDeadline[];
                })
              : null;
          if (
            candidate.tag === 'traffic' &&
            (!Number.isSafeInteger(proof?.deadlineAtMs) || proof!.deadlineAtMs! <= 0)
          )
            throw new Error('Verified traffic reason lost its deadline permit');
          if (candidate.tag === 'ocr') {
            const bindings = standardOcr.map((r) => parseCommercialOcrDeleteBinding(r.metadata));
            if (bindings.some((binding) => !binding))
              throw new Error('Verified OCR reason lost its deadline binding');
            candidate.fixedDeadlines = standardOcr.map((r, index) => ({
              reasonKey: r.reasonKey,
              deadlineAtMs: Math.min(
                Date.parse(bindings[index]!.ocrDeadlineAt),
                ...(bindings[index]!.authority.kind === 'CERTIFIED'
                  ? [Date.parse(bindings[index]!.authority.controlExpiresAt)]
                  : []),
              ),
            }));
          }
          const preparedKeys = proof?.reasonKeys ?? candidate.keys;
          const keys = candidate.authoritySnapshot
            ? preparedKeys.filter((key) => candidate.authoritySnapshot!.keys.includes(key))
            : preparedKeys;
          if (candidate.authoritySnapshot?.keys.length && !keys.length)
            throw new ModerationDeleteReasonsRejectedError(fingerprint);
          const currentPermits =
            proof?.reasonDeadlines ??
            (proof?.deadlineAtMs !== undefined
              ? preparedKeys.map((reasonKey) => ({ reasonKey, deadlineAtMs: proof.deadlineAtMs! }))
              : candidate.tag === 'duplicate'
                ? (candidate.fixedDeadlines ?? [])
                : []);
          const boundedDeadlines = new Map<string, number>();
          for (const permit of currentPermits) {
            if (
              !preparedKeys.includes(permit.reasonKey) ||
              !Number.isSafeInteger(permit.deadlineAtMs) ||
              permit.deadlineAtMs <= 0
            )
              throw new Error('Verified moderation reason lost its exact deadline permit');
            if (keys.includes(permit.reasonKey))
              boundedDeadlines.set(
                permit.reasonKey,
                Math.min(boundedDeadlines.get(permit.reasonKey) ?? Infinity, permit.deadlineAtMs),
              );
          }
          // FLAG: Local fallback can revoke authority but cannot renew an earlier reason
          // deadline or attach a newly eligible reason to another reason's old preparation.
          for (const permit of candidate.authoritySnapshot?.deadlines ?? []) {
            if (keys.includes(permit.reasonKey))
              boundedDeadlines.set(
                permit.reasonKey,
                Math.min(boundedDeadlines.get(permit.reasonKey) ?? Infinity, permit.deadlineAtMs),
              );
          }
          const permits = [...boundedDeadlines].map(([reasonKey, deadlineAtMs]) => ({
            reasonKey,
            deadlineAtMs,
          }));
          for (const permit of permits) {
            verifiedReasonDeadlines.set(
              permit.reasonKey,
              Math.min(
                verifiedReasonDeadlines.get(permit.reasonKey) ?? Infinity,
                permit.deadlineAtMs,
              ),
            );
          }
          if (candidate.tag === 'ocr' && finalDispatchLeaseToken)
            await this.assertCommercialOcrDispatchDeadline(
              intent.id,
              finalDispatchLeaseToken,
              botId,
            );
          allowed = true;
          for (const key of keys) verifiedReasonKeys.add(key);
          if (candidate.tag === 'duplicate') messageDuplicateVerified = true;
          else {
            independentVerified = true;
            let deadline =
              keys.length && keys.every((key) => boundedDeadlines.has(key))
                ? Math.max(...keys.map((key) => boundedDeadlines.get(key)!))
                : (proof?.deadlineAtMs ??
                  (candidate.tag === 'ocr'
                    ? Math.min(...candidate.fixedDeadlines!.map((r) => r.deadlineAtMs))
                    : null));
            if (candidate.authoritySnapshot?.deadlineAtMs != null)
              deadline = Math.min(deadline ?? Infinity, candidate.authoritySnapshot.deadlineAtMs);
            independentCandidates.push({
              ...candidate,
              authoritySnapshot: { keys, deadlineAtMs: deadline, deadlines: permits },
            });
            if (deadline === null) unboundedIndependent = true;
            else independentDeadline = Math.max(independentDeadline, deadline);
          }
          if (candidate.tag === 'profanity') profanityVerified = result === 'allowed';
          if (candidate.tag === 'commercial') commercialVerifiedReasonKeys = keys;
        } catch (error) {
          rejected(error);
        }
      }
      if (recognized && !allowed)
        throw new ModerationDeleteReasonsRejectedError(fingerprint, stopWordsRejectionReason);
      if (deferred && allowed && intent.subjectUserId && intent.messageAuthorKind !== 'bot') {
        if (!this.participantImmunity)
          throw new Error('Final participant immunity guard unavailable');
        const settings = await this.prisma.chatSettings.findUnique({
          where: { chatId: intent.chatId },
          select: { nightModeTimezone: true },
        });
        if (
          (await this.participantImmunity.consumeForMessage({
            chatId: intent.chatId,
            userId: intent.subjectUserId,
            messageId: intent.messageId,
            scope: 'moderation-delete-final:v1',
            nightModeTimezone: settings?.nightModeTimezone ?? null,
          })) === 'granted'
        )
          throw new ModerationDeleteReasonsRejectedError(fingerprint);
      }
      return {
        profanityVerified,
        commercialVerifiedReasonKeys,
        messageDuplicateVerified,
        independentVerified,
        independentAuthorityDeadlineAtMs: unboundedIndependent ? null : independentDeadline || null,
        guardedReasonFingerprint: fingerprint,
        verifiedReasonKeys: [...verifiedReasonKeys],
        verifiedReasonDeadlines: [...verifiedReasonDeadlines].map(([reasonKey, deadlineAtMs]) => ({
          reasonKey,
          deadlineAtMs,
        })),
        // FLAG: Only independently finalized evidence may survive a failed duplicate permit.
        // Its new capsule re-reads local authority and retains every original absolute deadline.
        ...(deferred &&
        allowIndependentRecheck &&
        messageDuplicateVerified &&
        independentCandidates.length
          ? {
              independentRecheck: prepareDeleteAuthority(async () =>
                finalizeCandidates(
                  independentCandidates.map((candidate) => ({
                    ...candidate,
                    preparation: prepareDeleteAuthorityRecheck(candidate.preparation),
                  })),
                  false,
                ),
              ),
            }
          : {}),
      };
    };
    return finalizeCandidates(candidates, true);
  }

  private async assertCommercialOcrDispatchDeadline(
    intentId: string,
    leaseToken: string,
    botId: string,
  ): Promise<void> {
    // FLAG: This database-clock fence runs after fresh OCR network/immunity checks. Mixed
    // reasons also retain a synchronous absolute-expiry check after their final awaited guards.
    const changed = await this.prisma.$executeRaw(Prisma.sql`
      UPDATE "moderation_delete_intents" intent
      SET "updated_at" = CURRENT_TIMESTAMP
      WHERE intent."id" = ${intentId}
        AND intent."status" = CAST('IN_PROGRESS' AS "ModerationDeleteIntentStatus")
        AND intent."lease_token" = ${leaseToken}
        AND intent."lease_expires_at" > CURRENT_TIMESTAMP
        AND intent."delete_dispatch_started_at" IS NOT NULL
        AND intent."delete_dispatch_started_bot_id" = ${botId}
        AND (
          intent."commercial_ocr_guard_required"
          OR EXISTS (
            SELECT 1
              FROM "moderation_delete_intent_reasons" ocr_reason
              WHERE ocr_reason."intent_id" = intent."id"
                AND ocr_reason."rule_code" = ${COMMERCIAL_OCR_DELETE_RULE_CODE}
                AND COALESCE(ocr_reason."metadata"->>'source', '') <> 'image_text_ocr'
          )
        )
        AND COALESCE(intent."commercial_ocr_deadline_at", intent."retry_until_at")
          > CURRENT_TIMESTAMP
    `);
    if (changed === 0) {
      throw new CommercialOcrDeleteGuardRejectedError(
        'commercial_ocr_deadline_expired',
        'Commercial OCR deletion deadline expired before dispatch',
      );
    }
  }

  private isTerminalDeleteGuardRejection(error: unknown): boolean {
    if (error instanceof WebhookLegacyHoldRejectedError) return true;
    if (error instanceof LinkHistoryDeleteGuardRejectedError)
      return !['live_author_access_unknown', 'history_author_access_unknown'].includes(error.code);
    if (error instanceof MessageRetentionGuardError) return error.disposition === 'skip';
    if (
      error instanceof ProfanityDeleteGuardRejectedError ||
      error instanceof CommercialDeleteGuardRejectedError ||
      error instanceof CommercialLlmGuardRejectedError ||
      error instanceof StopWordsDeleteGuardRejectedError ||
      error instanceof TrafficProtectionGuardRejectedError ||
      error instanceof ReportRejectedError ||
      error instanceof MessageDuplicateGuardRejectedError ||
      error instanceof MessageLimitsDeleteGuardRejectedError ||
      error instanceof ClosedChatDeleteGuardRejectedError ||
      error instanceof ModerationStateDeleteRejectedError ||
      error instanceof RequiredSubscriptionExecutionRejectedError ||
      error instanceof ModerationDeleteReasonsRejectedError
    ) {
      return true;
    }
    const code = this.firstString(this.asRecord(error)?.code);
    if (
      code === 'moderation_delete_reason_missing' ||
      code === 'photo_duplicate_legacy_evidence_retired' ||
      code === CHANNEL_AUTO_POST_CLEANUP_ENTITY_MISMATCH_ERROR_CODE ||
      code === CHANNEL_AUTO_POST_CLEANUP_SENDER_REJECTED_ERROR_CODE ||
      code === NIGHT_MODE_CLOSE_NOTICE_CLEANUP_STALE_ERROR_CODE
    ) {
      return true;
    }
    return (
      code === 'commercial_ocr_runtime_disabled' ||
      code === 'commercial_ocr_runtime_revoked' ||
      code === 'commercial_ocr_runtime_control_changed' ||
      code === 'commercial_ocr_runtime_control_expired' ||
      code === 'commercial_ocr_deadline_expired' ||
      code === 'commercial_ocr_version_changed' ||
      code === 'commercial_ocr_binding_invalid' ||
      code === 'commercial_ocr_binding_ambiguous' ||
      code === 'commercial_ocr_reason_missing' ||
      code === 'commercial_ocr_author_immune' ||
      code === 'commercial_ocr_source_timestamp_changed' ||
      code === 'commercial_ocr_filter_disabled' ||
      code === 'commercial_ocr_policy_changed' ||
      code === 'commercial_ocr_admin_immune' ||
      code === 'commercial_ocr_message_changed' ||
      code === 'commercial_ocr_participant_immune' ||
      code === 'image_text_stop_list_runtime_disabled' ||
      code === 'image_text_stop_list_binding_invalid' ||
      code === 'image_text_stop_list_binding_stale' ||
      code === 'image_text_stop_list_settings_disabled' ||
      code === 'image_text_stop_list_bot_immune' ||
      code === 'image_text_stop_list_admin_immune' ||
      code === 'image_text_stop_list_message_changed' ||
      code === 'image_text_stop_list_participant_immune' ||
      code === 'image_text_stop_list_policy_changed' ||
      code === 'image_text_stop_list_deadline_expired'
    );
  }

  private async assertNightModeCloseNoticeCleanupStillAuthorized(intent: IntentRow): Promise<void> {
    if (
      intent.nightModeCloseNoticeCleanupReason !== true ||
      intent.nightModeCloseNoticeCleanupOnly !== true
    ) {
      return;
    }
    let binding = parseNightModeCloseNoticeCleanupBinding(
      intent.nightModeCloseNoticeCleanupBinding,
    );
    if (intent.nightModeCloseNoticeCleanupBinding != null && !binding) {
      throw new NightModeCloseNoticeCleanupGuardRejectedError(
        'Night mode close notice cleanup lost its exact persisted binding',
      );
    }

    const settings = await this.prisma.chatSettings.findUnique({
      where: { chatId: intent.chatId },
      include: {
        chat: {
          select: {
            entityType: true,
            rules: {
              select: {
                publishedUrl: true,
                publishedMessageId: true,
              },
            },
          },
        },
      },
    });
    const snapshot = settings ? resolveNightModeTransitionSnapshot(settings) : null;
    if (
      !settings?.nightModeEnabled ||
      settings.chat?.entityType !== 'CHAT' ||
      intent.entityType !== 'CHAT' ||
      !snapshot ||
      snapshot.status !== 'open'
    ) {
      throw new NightModeCloseNoticeCleanupGuardRejectedError(
        'Night mode close notice cleanup became stale after disable or reschedule',
      );
    }
    // FLAG: A manual closure can begin after the opening worker hands off cleanup. Check
    // its current lifetime at DELETE dispatch without changing existing binding fingerprints.
    if (resolveManualChatClosure(settings).active) {
      throw new NightModeCloseNoticeCleanupGuardRejectedError(
        'Night mode close notice cleanup is blocked while manual closure remains active',
      );
    }

    if (!binding) {
      binding = await this.reconstructLegacyNightModeCloseNoticeCleanupBinding(
        intent,
        settings,
        snapshot.sessionKey,
      );
    }
    if (
      binding.event.messageId !== intent.messageId ||
      snapshot.sessionKey !== binding.sessionKey ||
      buildNightModeTransitionScheduleFingerprint(settings) !== binding.scheduleFingerprint ||
      buildNightModeTransitionSideEffectFingerprint(settings) !== binding.sideEffectFingerprint
    ) {
      throw new NightModeCloseNoticeCleanupGuardRejectedError(
        'Night mode close notice cleanup became stale after disable or reschedule',
      );
    }

    const boundEvent = await this.prisma.moderationEvent.findFirst({
      where: {
        id: binding.event.id,
        chatId: intent.chatId,
        messageId: intent.messageId,
        botId: intent.originBotId,
        ruleCode: binding.event.ruleCode,
        metadata: {
          path: ['sessionKey'],
          equals: binding.sessionKey,
        } satisfies Prisma.JsonFilter,
      },
      select: { id: true },
    });
    if (!boundEvent) {
      throw new NightModeCloseNoticeCleanupGuardRejectedError(
        'Night mode close notice cleanup event binding no longer matches',
      );
    }
  }

  private async reconstructLegacyNightModeCloseNoticeCleanupBinding(
    intent: IntentRow,
    settings: Parameters<typeof buildNightModeTransitionSideEffectFingerprint>[0],
    currentSessionKey: string,
  ): Promise<NightModeCloseNoticeCleanupBinding> {
    const originBotId = intent.originBotId?.trim() ?? '';
    if (!originBotId || typeof this.prisma.moderationEvent?.findMany !== 'function') {
      throw new NightModeCloseNoticeCleanupGuardRejectedError(
        'Legacy night mode close notice cleanup has no exact event proof',
      );
    }
    const candidates = await this.prisma.moderationEvent.findMany({
      where: {
        chatId: intent.chatId,
        messageId: intent.messageId,
        botId: originBotId,
        ruleCode: 'NIGHT_MODE_CLOSE_NOTICE',
        metadata: {
          path: ['sessionKey'],
          equals: currentSessionKey,
        } satisfies Prisma.JsonFilter,
      },
      select: {
        id: true,
        messageId: true,
        botId: true,
        metadata: true,
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 2,
    });
    const matching = candidates.filter((event) => {
      const metadata = this.asRecord(event.metadata);
      return (
        event.messageId === intent.messageId &&
        event.botId === originBotId &&
        this.firstString(metadata?.sessionKey) === currentSessionKey
      );
    });
    if (matching.length !== 1) {
      throw new NightModeCloseNoticeCleanupGuardRejectedError(
        'Legacy night mode close notice cleanup event proof is missing or ambiguous',
      );
    }

    let binding: NightModeCloseNoticeCleanupBinding = {
      version: 1,
      sessionKey: currentSessionKey,
      scheduleFingerprint: buildNightModeTransitionScheduleFingerprint(settings),
      sideEffectFingerprint: buildNightModeTransitionSideEffectFingerprint(settings),
      event: {
        id: matching[0]!.id,
        ruleCode: 'NIGHT_MODE_CLOSE_NOTICE',
        messageId: intent.messageId,
      },
    };
    const persisted = await this.prisma.$executeRaw(Prisma.sql`
      UPDATE "moderation_delete_intent_reasons" reason
      SET
        "metadata" = jsonb_set(
          COALESCE(reason."metadata", CAST('{}' AS JSONB)),
          CAST(ARRAY['nightModeCloseNoticeCleanup'] AS TEXT[]),
          CAST(${JSON.stringify(binding)} AS JSONB),
          TRUE
        ),
        "updated_at" = CURRENT_TIMESTAMP
      WHERE reason."intent_id" = ${intent.id}
        AND reason."rule_code" = ${NIGHT_MODE_CLOSE_NOTICE_CLEANUP_RULE_CODE}
        AND reason."metadata"->'nightModeCloseNoticeCleanup' IS NULL
        AND EXISTS (
          SELECT 1
          FROM "moderation_delete_intents" parent
          WHERE parent."id" = reason."intent_id"
            AND parent."status" = CAST('IN_PROGRESS' AS "ModerationDeleteIntentStatus")
            AND parent."lease_token" = ${intent.leaseToken}
            AND parent."lease_expires_at" > CURRENT_TIMESTAMP
        )
    `);
    if (persisted !== 1) {
      const existingReason = await this.prisma.moderationDeleteIntentReason.findFirst({
        where: {
          intentId: intent.id,
          ruleCode: NIGHT_MODE_CLOSE_NOTICE_CLEANUP_RULE_CODE,
        },
        select: { metadata: true },
      });
      const existingBinding = parseNightModeCloseNoticeCleanupBinding(
        this.asRecord(existingReason?.metadata)?.nightModeCloseNoticeCleanup,
      );
      if (JSON.stringify(existingBinding) !== JSON.stringify(binding)) {
        throw new NightModeCloseNoticeCleanupGuardRejectedError(
          'Legacy night mode close notice cleanup binding changed before backfill',
        );
      }
      binding = existingBinding!;
    }
    intent.nightModeCloseNoticeCleanupBinding = binding;
    return binding;
  }

  private async assertChannelAutoPostCleanupLocalAuthority(intent: IntentRow): Promise<void> {
    if (
      intent.channelAutoPostCleanupReason !== true ||
      this.hasExecutableReasonIgnoringChannelAutoPostCleanup(intent)
    )
      return;
    const chat = await this.prisma.chat.findUnique({
      where: { id: intent.chatId },
      select: { entityType: true },
    });
    if (chat?.entityType !== 'CHANNEL') {
      throw new ChannelAutoPostCleanupEntityGuardRejectedError(
        intent.chatId,
        chat?.entityType ?? null,
      );
    }
  }

  private async assertChannelAutoPostCleanupStillAuthorized(
    intent: IntentRow,
    botId: string,
  ): Promise<void> {
    if (
      intent.channelAutoPostCleanupReason !== true ||
      this.hasExecutableReasonIgnoringChannelAutoPostCleanup(intent)
    ) {
      return;
    }
    await this.assertChannelAutoPostCleanupLocalAuthority(intent);

    const snapshot = await this.maxClient.getChatSnapshot(intent.chatId, {
      botId,
      bypassCache: true,
      trafficClass: 'critical',
      actionHealthLane: 'critical',
      sourceTag: MAX_API_SOURCE_TAGS.MODERATION_DELETE,
      ignoreFailureMetricStatuses: MODERATION_CHAT_ACTION_TERMINAL_FAILURE_METRIC_STATUSES,
      timeoutMs: this.deleteTimeoutMs,
    });
    if (snapshot.entityType !== 'channel') {
      throw new ChannelAutoPostCleanupEntityGuardRejectedError(intent.chatId, snapshot.entityType);
    }

    const senderId = intent.subjectUserId?.trim() || null;
    if (!senderId) {
      throw new ChannelAutoPostCleanupSenderGuardRejectedError(intent.chatId, null);
    }
    const senderAccess = await this.maxClient.getChatMemberAccess(intent.chatId, senderId, {
      botId,
      bypassCache: true,
      trafficClass: 'critical',
      actionHealthLane: 'critical',
      sourceTag: MAX_API_SOURCE_TAGS.MODERATION_DELETE,
      ignoreFailureMetricStatuses: MODERATION_CHAT_ACTION_TERMINAL_FAILURE_METRIC_STATUSES,
      timeoutMs: this.deleteTimeoutMs,
    });
    if (senderAccess?.isAdmin !== true && senderAccess?.isOwner !== true) {
      throw new ChannelAutoPostCleanupSenderGuardRejectedError(intent.chatId, senderId);
    }
  }

  private async resolveDeleteIntentCommercialOcrGuard(intent: IntentRow): Promise<boolean> {
    // An old writer may finish after the additive migration and rely on the column default. The
    // durable reason remains authoritative, so dispatch must discover it even when the row flag is
    // false. Invalid legacy bindings then fail closed in the OCR guard.
    const reason = await this.prisma.moderationDeleteIntentReason.findFirst({
      where: { intentId: intent.id },
      select: { id: true },
    });
    if (!reason) {
      throw new ModerationDeleteReasonMissingError();
    }
    if (
      intent.imageTextStopListDeleteReason === true &&
      this.getImageTextStopListRollout() === 'execute'
    ) {
      return false;
    }
    if (this.hasExecutableNonCommercialOcrReason(intent)) {
      return false;
    }
    if (intent.commercialOcrGuardRequired === true) {
      return true;
    }
    if (intent.standardCommercialOcrDeleteReason === false) {
      return false;
    }
    const commercialOcrReason = await this.prisma.moderationDeleteIntentReason.findFirst({
      where: { intentId: intent.id, ruleCode: COMMERCIAL_OCR_DELETE_RULE_CODE },
      select: { id: true },
    });
    return commercialOcrReason !== null;
  }

  private async assertImageTextStopListDeleteIntentStillActionable(
    intent: IntentRow,
    botId: string,
  ): Promise<'not_applicable' | 'absent' | { reasonDeadlines: VerifiedDeleteReasonDeadline[] }> {
    return finalizeDeleteAuthority(
      await this.prepareImageTextStopListDeleteAuthority(intent, botId),
    );
  }

  private async prepareImageTextStopListDeleteAuthority(
    intent: IntentRow,
    botId: string,
  ): Promise<
    DeleteAuthorityPreparation<
      'not_applicable' | 'absent' | { reasonDeadlines: VerifiedDeleteReasonDeadline[] }
    >
  > {
    if (
      intent.imageTextStopListDeleteReason !== true ||
      this.hasExecutableNonCommercialOcrReason(intent)
    ) {
      return 'not_applicable';
    }
    if (this.getImageTextStopListRollout() !== 'execute') {
      if (intent.standardCommercialOcrDeleteReason === true) {
        return 'not_applicable';
      }
      throw new ImageTextStopListDeleteIntentGuardRejectedError(
        'image_text_stop_list_runtime_disabled',
        'Image text stop-list deletion is no longer enabled',
      );
    }

    const reasons = await this.prisma.moderationDeleteIntentReason.findMany({
      where: { intentId: intent.id },
      select: { ruleCode: true, reasonKey: true, metadata: true },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: 65,
    });
    const bindings = reasons.map((reason) => parseImageTextStopListBinding(reason.metadata));
    if (
      reasons.length === 0 ||
      reasons.length > 64 ||
      reasons.some(
        (reason, index) =>
          reason.ruleCode !== COMMERCIAL_OCR_DELETE_RULE_CODE ||
          this.asRecord(reason.metadata)?.source !== 'image_text_ocr' ||
          this.asRecord(reason.metadata)?.enforcementScope !== 'delete_only' ||
          this.asRecord(reason.metadata)?.matchedRuleCode !== bindings[index]?.ruleCode,
      ) ||
      bindings.some((binding) => binding === null)
    ) {
      throw new ImageTextStopListDeleteIntentGuardRejectedError(
        'image_text_stop_list_binding_invalid',
        'Image text stop-list delete intent has an invalid durable binding',
      );
    }
    const validBindings = bindings as ImageTextStopListBinding[];
    const primaryBinding = validBindings[0]!;
    const expectedNativeBehavior = this.expectedImageOcrNativeBehavior;
    if (
      primaryBinding.ocrVersion !== COMMERCIAL_OCR_DEFAULT_VERSION ||
      !expectedNativeBehavior.complete ||
      primaryBinding.nativeBehaviorFingerprintSha256 !== expectedNativeBehavior.fingerprintSha256 ||
      primaryBinding.senderId !== intent.subjectUserId ||
      primaryBinding.sourceCreatedAt !== intent.sourceMessageAt?.toISOString() ||
      primaryBinding.deleteDeadlineAt !== intent.commercialOcrDeadlineAt?.toISOString() ||
      primaryBinding.deleteDeadlineAt !== intent.retryUntilAt.toISOString() ||
      Date.parse(primaryBinding.deleteDeadlineAt) <= Date.now() ||
      validBindings.some(
        (binding) =>
          binding.senderId !== primaryBinding.senderId ||
          binding.sourceCreatedAt !== primaryBinding.sourceCreatedAt ||
          binding.deleteDeadlineAt !== primaryBinding.deleteDeadlineAt ||
          binding.policyFingerprint !== primaryBinding.policyFingerprint ||
          binding.nativeBehaviorFingerprintSha256 !==
            primaryBinding.nativeBehaviorFingerprintSha256 ||
          binding.ocrVersion !== primaryBinding.ocrVersion,
      )
    ) {
      throw new ImageTextStopListDeleteIntentGuardRejectedError(
        'image_text_stop_list_binding_stale',
        'Image text stop-list delete binding no longer matches its intent',
      );
    }

    const context = await this.loadImageTextStopListGuardContext(intent.chatId);
    this.assertImageTextStopListContext(context, validBindings, primaryBinding.senderId);
    if (this.maxBotLinkService.isKnownBotUserId(primaryBinding.senderId)) {
      throw new ImageTextStopListDeleteIntentGuardRejectedError(
        'image_text_stop_list_bot_immune',
        'Image text stop-list message author is a configured bot',
      );
    }

    const access = await this.maxClient.getChatMemberAccess(
      intent.chatId,
      primaryBinding.senderId,
      {
        botId,
        bypassCache: true,
        trafficClass: 'critical',
        actionHealthLane: 'critical',
        sourceTag: MAX_API_SOURCE_TAGS.MODERATION_DELETE,
        ignoreFailureMetricStatuses: MODERATION_CHAT_ACTION_TERMINAL_FAILURE_METRIC_STATUSES,
        timeoutMs: this.deleteTimeoutMs,
      },
    );
    if (!access || (access.userId !== null && access.userId !== primaryBinding.senderId)) {
      throw new Error('Image text stop-list author access is unavailable');
    }
    if (access.isAdmin || access.isOwner) {
      throw new ImageTextStopListDeleteIntentGuardRejectedError(
        'image_text_stop_list_admin_immune',
        'Image text stop-list message author is now exempt from moderation',
      );
    }

    const exactRow = await this.maxClient.getExactMessageRow(intent.chatId, intent.messageId, {
      botId,
      bypassCache: true,
      trafficClass: 'critical',
      actionHealthLane: 'critical',
      sourceTag: MAX_API_SOURCE_TAGS.MODERATION_DELETE,
      ignoreFailureMetricStatuses: MODERATION_CHAT_ACTION_TERMINAL_FAILURE_METRIC_STATUSES,
      timeoutMs: this.deleteTimeoutMs,
    });
    if (!exactRow) {
      return 'absent';
    }
    const exact = extractCommercialOcrExactMessageSource(exactRow);
    if (
      !exact ||
      exact.authorKind !== 'user' ||
      exact.source.chatId !== intent.chatId ||
      exact.source.messageId !== intent.messageId ||
      validBindings.some((binding) => !imageTextStopListSourceMatchesBinding(binding, exact.source))
    ) {
      throw new ImageTextStopListDeleteIntentGuardRejectedError(
        'image_text_stop_list_message_changed',
        'Image text stop-list source message changed after analysis',
      );
    }

    if (!this.participantImmunity) {
      throw new Error('Image text stop-list participant immunity guard is unavailable');
    }
    const immunity = await this.participantImmunity.consumeForMessage({
      chatId: intent.chatId,
      userId: primaryBinding.senderId,
      messageId: intent.messageId,
      scope: IMAGE_TEXT_STOP_LIST_PARTICIPANT_IMMUNITY_SCOPE,
      nightModeTimezone: context!.settings!.nightModeTimezone,
    });
    if (immunity === 'granted') {
      throw new ImageTextStopListDeleteIntentGuardRejectedError(
        'image_text_stop_list_participant_immune',
        'Image text stop-list message author has active participant immunity',
      );
    }

    return prepareDeleteAuthority(async () => {
      const protectionContext = await this.loadImageTextStopListGuardContext(intent.chatId);
      this.assertImageTextStopListContext(
        protectionContext,
        validBindings,
        primaryBinding.senderId,
      );
      if (
        (await this.participantImmunity!.consumeForMessage({
          chatId: intent.chatId,
          userId: primaryBinding.senderId,
          messageId: intent.messageId,
          scope: IMAGE_TEXT_STOP_LIST_PARTICIPANT_IMMUNITY_SCOPE,
          nightModeTimezone: protectionContext!.settings!.nightModeTimezone,
        })) === 'granted'
      )
        throw new ImageTextStopListDeleteIntentGuardRejectedError(
          'image_text_stop_list_participant_immune',
          'Current participant protection prevents image text deletion',
        );
      const finalContext = await this.loadImageTextStopListGuardContext(intent.chatId);
      this.assertImageTextStopListContext(finalContext, validBindings, primaryBinding.senderId);
      if (
        this.getImageTextStopListRollout() !== 'execute' ||
        Date.parse(primaryBinding.deleteDeadlineAt) <= Date.now()
      ) {
        throw new ImageTextStopListDeleteIntentGuardRejectedError(
          'image_text_stop_list_runtime_disabled',
          'Image text stop-list authorization expired before delete dispatch',
        );
      }
      return {
        reasonDeadlines: reasons.map((reason, index) => ({
          reasonKey: reason.reasonKey,
          deadlineAtMs: Date.parse(validBindings[index]!.deleteDeadlineAt),
        })),
      };
    });
  }

  private async loadImageTextStopListGuardContext(
    chatId: string,
  ): Promise<ImageTextStopListGuardContext | null> {
    return this.prisma.chat.findUnique({
      where: { id: chatId },
      select: {
        entityType: true,
        settings: {
          select: {
            messageLimitsImageTextScanEnabled: true,
            stopWordsPolicy: true,
            stopWordsRevision: true,
            messageLimitsBlockedWords: true,
            messageLimitsBlockedDomains: true,
            nightModeTimezone: true,
          },
        },
        admins: { select: { userId: true } },
        domains: {
          where: {
            OR: [{ removeAfterAt: null }, { removeAfterAt: { gt: new Date() } }],
          },
          select: { domain: true },
        },
      },
    });
  }

  private assertImageTextStopListContext(
    context: ImageTextStopListGuardContext | null,
    bindings: readonly ImageTextStopListBinding[],
    senderId: string,
  ): void {
    if (
      !context ||
      context.entityType !== 'CHAT' ||
      !isStopWordsImageScanEnabled(context.settings) ||
      !context.settings ||
      context.admins.some((admin) => admin.userId === senderId)
    ) {
      throw new ImageTextStopListDeleteIntentGuardRejectedError(
        'image_text_stop_list_settings_disabled',
        'Image text stop-list moderation is no longer enabled for this author',
      );
    }
    const policyFingerprint = fingerprintImageTextStopListPolicy({
      settings: context.settings,
      domainAllowlist: context.domains.map((entry) => entry.domain),
    });
    if (
      bindings.some(
        (binding) =>
          binding.policyFingerprint !== policyFingerprint ||
          !isStopWordsDecisionConfigured(context.settings!, binding),
      )
    ) {
      throw new ImageTextStopListDeleteIntentGuardRejectedError(
        'image_text_stop_list_policy_changed',
        'Image text stop-list policy changed after analysis',
      );
    }
  }

  private async assertImageTextStopListDispatchDeadline(
    intentId: string,
    leaseToken: string,
    botId: string,
  ): Promise<void> {
    const changed = await this.prisma.$executeRaw(Prisma.sql`
      UPDATE "moderation_delete_intents" intent
      SET "updated_at" = CURRENT_TIMESTAMP
      WHERE intent."id" = ${intentId}
        AND intent."status" = CAST('IN_PROGRESS' AS "ModerationDeleteIntentStatus")
        AND intent."lease_token" = ${leaseToken}
        AND intent."lease_expires_at" > CURRENT_TIMESTAMP
        AND intent."delete_dispatch_started_at" IS NOT NULL
        AND intent."delete_dispatch_started_bot_id" = ${botId}
        AND intent."commercial_ocr_deadline_at" > CURRENT_TIMESTAMP
        AND EXISTS (
          SELECT 1
          FROM "moderation_delete_intent_reasons" image_text_reason
          WHERE image_text_reason."intent_id" = intent."id"
            AND image_text_reason."rule_code" = ${COMMERCIAL_OCR_DELETE_RULE_CODE}
            AND COALESCE(image_text_reason."metadata"->>'source', '') = 'image_text_ocr'
            AND COALESCE(image_text_reason."metadata"->>'enforcementScope', '') = 'delete_only'
        )
    `);
    if (changed === 0) {
      throw new ImageTextStopListDeleteIntentGuardRejectedError(
        'image_text_stop_list_deadline_expired',
        'Image text stop-list deadline expired before delete dispatch',
      );
    }
  }

  private async assertPhotoDuplicateDeleteIntentStillActionable(intent: IntentRow): Promise<void> {
    if (intent.photoDuplicateDeleteOnly !== true) {
      return;
    }

    const reasons = await this.prisma.moderationDeleteIntentReason.findMany({
      where: { intentId: intent.id },
      select: { ruleCode: true, metadata: true },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    if (reasons.length === 0) {
      throw new PhotoDuplicateDeleteIntentGuardRejectedError(
        'photo_duplicate_reason_missing',
        'Photo duplicate delete intent lost its required reason metadata',
      );
    }

    const fences: PhotoDuplicateDeleteReasonFence[] = [];
    for (const reason of reasons) {
      if (reason.ruleCode === COMMERCIAL_OCR_DELETE_RULE_CODE) {
        continue;
      }
      const metadata = this.asRecord(reason.metadata);
      if (
        reason.ruleCode !== 'DUPLICATE_DELETE' ||
        this.firstString(metadata?.duplicateSource) !== 'photo'
      ) {
        // An independent reason still owns the same deletion, so photo rollout controls must not
        // suppress it.
        return;
      }
      const fence = this.parsePhotoDuplicateDeleteReasonFence(metadata);
      if (!fence) {
        throw new PhotoDuplicateDeleteIntentGuardRejectedError(
          'photo_duplicate_reason_invalid',
          'Photo duplicate delete intent has no valid preset, scope and match-kind fence',
        );
      }
      fences.push(fence);
    }
    if (fences.length === 0) {
      throw new PhotoDuplicateDeleteIntentGuardRejectedError(
        'photo_duplicate_reason_missing',
        'Photo duplicate delete intent lost its required reason metadata',
      );
    }

    const settings = await this.prisma.chatSettings.findUnique({
      where: { chatId: intent.chatId },
      select: {
        antiDuplicateEnabled: true,
        duplicatePhotoEnabled: true,
        duplicatePhotoMatchPreset: true,
        duplicatePhotoScope: true,
      },
    });
    if (!settings?.antiDuplicateEnabled || !settings.duplicatePhotoEnabled) {
      throw new PhotoDuplicateDeleteIntentGuardRejectedError(
        'photo_duplicate_settings_disabled',
        'Photo duplicate deletion is no longer enabled for this chat',
      );
    }
    if (
      fences.some(
        (fence) =>
          fence.preset !== settings.duplicatePhotoMatchPreset ||
          fence.scope !== settings.duplicatePhotoScope,
      )
    ) {
      throw new PhotoDuplicateDeleteIntentGuardRejectedError(
        'photo_duplicate_settings_changed',
        'Photo duplicate preset or scope changed after the delete intent was recorded',
      );
    }

    const policy = await this.photoDuplicateRuntimePolicy.resolveEffectivePolicy({
      chatId: intent.chatId,
      preset: settings.duplicatePhotoMatchPreset,
      scope: settings.duplicatePhotoScope,
    });
    if (!policy.enforce) {
      throw new PhotoDuplicateDeleteIntentGuardRejectedError(
        'photo_duplicate_runtime_downgraded',
        'Photo duplicate runtime control no longer authorizes deletion',
      );
    }
    if (fences.some((fence) => !isPhotoDuplicateMatchKindAllowed(policy, fence.matchKind))) {
      throw new PhotoDuplicateDeleteIntentGuardRejectedError(
        'photo_duplicate_match_kind_disabled',
        'Photo duplicate match kind is no longer authorized by runtime control',
      );
    }
    // FLAG: The retired photo queue has no producer or executor. Its saved reasons do not
    // identify the original author/message and cannot prove that an abandoned source was
    // excluded. Settings or a live rollout must never revive that legacy authority. Exact
    // remote success settles before guards; independent reasons return above and keep theirs.
    throw new PhotoDuplicateDeleteIntentGuardRejectedError(
      'photo_duplicate_legacy_evidence_retired',
      'Retired photo evidence cannot authorize a new deletion',
    );
  }

  private parsePhotoDuplicateDeleteReasonFence(
    metadata: Record<string, unknown> | null,
  ): PhotoDuplicateDeleteReasonFence | null {
    const matchKind = this.firstString(metadata?.matchKind);
    const preset = this.firstString(metadata?.preset);
    const scope = this.firstString(metadata?.scope);
    if (
      !PHOTO_DUPLICATE_MATCH_KINDS.includes(matchKind as PhotoDuplicateMatchKind) ||
      (preset !== 'SAME_IMAGE' && preset !== 'MINOR_EDITS') ||
      (scope !== 'SAME_AUTHOR' && scope !== 'CHAT')
    ) {
      return null;
    }
    return {
      matchKind: matchKind as PhotoDuplicateMatchKind,
      preset,
      scope,
    };
  }

  private async persistIntent(
    input: EnsureModerationDeleteIntentInput,
    enqueue: boolean,
    transactionClient?: Prisma.TransactionClient,
    enqueuePriority = DELETE_QUEUE_PRIORITY_INTERACTIVE,
  ): Promise<EnsureModerationDeleteIntentResult> {
    const normalized = this.normalizeInput(input);
    // FLAG: A later ensure must not promote OBSERVED or extend this abandoned source.
    if (
      await this.legacyHolds?.isSourceAbandoned?.(
        normalized.chatId,
        normalized.messageId,
        transactionClient,
      )
    )
      throw new WebhookLegacyHoldRejectedError();
    const rollout = this.getRolloutForInput(input);
    if (rollout === 'off') {
      return { intentId: null, rollout, status: null };
    }

    const initialStatus: ModerationDeleteIntentStatus =
      rollout === 'observed'
        ? 'OBSERVED'
        : normalized.retryUntilAt.getTime() <= Date.now()
          ? 'EXPIRED'
          : 'PENDING';
    const intentId = randomUUID();
    const reasonId = randomUUID();
    const sourceOrigin =
      normalized.ruleCode === COMMERCIAL_LLM_DELETE_RULE_CODE
        ? readCommercialLlmEffectOrigin(
            normalized.chatId,
            normalized.messageId,
            normalized.ruleCode,
          )
        : readExactDeleteOrigin(normalized.chatId, normalized.messageId);
    if (normalized.ruleCode === COMMERCIAL_LLM_DELETE_RULE_CODE && !sourceOrigin)
      throw new CommercialLlmGuardRejectedError();
    // FLAG: Receipt attribution is written only after this executor's guarded MAX success.
    // Supplied reason metadata cannot manufacture a confirmed commercial execution.
    const initialMetadata = this.asRecord(normalized.event.metadata);
    const reasonMetadata =
      initialMetadata &&
      ('commercialReviewReceipt' in initialMetadata ||
        'moderationDeleteVerified' in initialMetadata)
        ? { ...initialMetadata }
        : normalized.event.metadata;
    if (reasonMetadata && typeof reasonMetadata === 'object' && !Array.isArray(reasonMetadata)) {
      delete (reasonMetadata as Record<string, unknown>).commercialReviewReceipt;
      delete (reasonMetadata as Record<string, unknown>).moderationDeleteVerified;
    }
    const metadataJson = this.serializeMetadata(reasonMetadata);
    const shouldAdoptReplacementRouting =
      this.isReplacementCleanupRuleCode(normalized.ruleCode) &&
      normalized.entityType === 'CHAT' &&
      normalized.messageAuthorKind === 'user' &&
      normalized.routingPolicy !== 'origin_only';
    // Historical BOT_MESSAGE_AUTO_DELETE rows were shadow observations. They must never become
    // executable merely because the rollout policy changed and the same webhook is replayed.
    const shouldPromoteObserved =
      normalized.ruleCode === BOT_MESSAGE_AUTO_DELETE_RULE_CODE
        ? Prisma.sql`FALSE`
        : Prisma.sql`
            "moderation_delete_intents"."status" = CAST(
              'OBSERVED' AS "ModerationDeleteIntentStatus"
            )
            AND EXCLUDED."status" <> CAST('OBSERVED' AS "ModerationDeleteIntentStatus")
          `;
    const hasStoredCommercialOcrReason = Prisma.sql`
      EXISTS (
        SELECT 1
        FROM "moderation_delete_intent_reasons" existing_ocr_reason
        WHERE existing_ocr_reason."intent_id" = "moderation_delete_intents"."id"
          AND existing_ocr_reason."rule_code" = ${COMMERCIAL_OCR_DELETE_RULE_CODE}
      )
    `;
    const resultingHasCommercialOcrReason = Prisma.sql`(
      "moderation_delete_intents"."commercial_ocr_guard_required"
      OR EXCLUDED."commercial_ocr_guard_required"
      OR ${hasStoredCommercialOcrReason}
    )`;
    const shouldAdoptIndependentChannelCleanupContext = Prisma.sql`(
      ${normalized.ruleCode !== CHANNEL_AUTO_POST_FORWARD_REPLACEMENT_CLEANUP_RULE_CODE}
      AND ${normalized.entityType !== null}
      AND EXISTS (
        SELECT 1
        FROM "moderation_delete_intent_reasons" stored_channel_cleanup_reason
        WHERE stored_channel_cleanup_reason."intent_id" = "moderation_delete_intents"."id"
          AND stored_channel_cleanup_reason."rule_code" =
            ${CHANNEL_AUTO_POST_FORWARD_REPLACEMENT_CLEANUP_RULE_CODE}
      )
      AND EXISTS (
        SELECT 1
        FROM "chats" current_entity
        WHERE current_entity."id" = "moderation_delete_intents"."chat_id"
          AND current_entity."entity_type" = EXCLUDED."entity_type"
      )
    )`;

    let retainedExpiredConflict = false;
    const persist = async (tx: Prisma.TransactionClient) => {
      const rows = await tx.$queryRaw<IntentRow[]>(Prisma.sql`
        INSERT INTO "moderation_delete_intents" (
          "id", "chat_id", "message_id", "subject_user_id", "source_message_at", "suggestion_subscription_id",
          "entity_type", "message_author_kind", "origin_bot_id", "routing_policy",
          "commercial_ocr_guard_required", "commercial_ocr_deadline_at", "status",
          "execute_at", "next_attempt_at",
          "retry_until_at", "completed_at", "created_at", "updated_at"
        ) VALUES (
          ${intentId}, ${normalized.chatId}, ${normalized.messageId}, ${normalized.subjectUserId},
          ${normalized.sourceMessageAt}, ${normalized.suggestionSubscriptionId}, CAST(${normalized.entityType} AS "ChatEntityType"),
          ${normalized.messageAuthorKind}, ${normalized.originBotId}, ${normalized.routingPolicy},
          ${normalized.ruleCode === COMMERCIAL_OCR_DELETE_RULE_CODE},
          ${normalized.commercialOcrDeadlineAt},
          CAST(${initialStatus} AS "ModerationDeleteIntentStatus"), ${normalized.executeAt},
          ${normalized.executeAt}, ${normalized.retryUntilAt},
          ${initialStatus === 'EXPIRED' ? new Date() : null}, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
        )
        ON CONFLICT ("chat_id", "message_id") DO UPDATE SET
          "suggestion_subscription_id" = COALESCE("moderation_delete_intents"."suggestion_subscription_id", EXCLUDED."suggestion_subscription_id"),
          "retention_owned" = FALSE,
          "status" = CASE
            WHEN "moderation_delete_intents"."retention_owned"
              AND "moderation_delete_intents"."status" IN ('FAILED_TERMINAL', 'EXPIRED', 'OBSERVED')
              AND "moderation_delete_intents"."delete_dispatch_started_at" IS NULL
              AND "moderation_delete_intents"."remote_delete_succeeded_at" IS NULL
            THEN EXCLUDED."status"
            WHEN ${shouldPromoteObserved}
            THEN EXCLUDED."status"
            ELSE "moderation_delete_intents"."status"
          END,
          "subject_user_id" = COALESCE(
            "moderation_delete_intents"."subject_user_id",
            EXCLUDED."subject_user_id"
          ),
          "source_message_at" = CASE
            WHEN ${normalized.ruleCode === LINK_BLOCKED_DELETE_RULE_CODE}
              AND "moderation_delete_intents"."status" NOT IN (
                CAST('EXPIRED' AS "ModerationDeleteIntentStatus"),
                CAST('FAILED_TERMINAL' AS "ModerationDeleteIntentStatus")
              )
              AND EXCLUDED."source_message_at" IS NOT NULL
              AND (
                "moderation_delete_intents"."source_message_at" IS NULL
                OR "moderation_delete_intents"."source_message_at" < EXCLUDED."source_message_at"
              )
            THEN EXCLUDED."source_message_at"
            ELSE COALESCE(
              "moderation_delete_intents"."source_message_at",
              EXCLUDED."source_message_at"
            )
          END,
          "origin_bot_id" = CASE
            WHEN ${shouldPromoteObserved} OR ${shouldAdoptIndependentChannelCleanupContext}
            THEN COALESCE(EXCLUDED."origin_bot_id", "moderation_delete_intents"."origin_bot_id")
            ELSE COALESCE("moderation_delete_intents"."origin_bot_id", EXCLUDED."origin_bot_id")
          END,
          "entity_type" = CASE
            WHEN ${shouldPromoteObserved} OR ${shouldAdoptIndependentChannelCleanupContext}
            THEN COALESCE(EXCLUDED."entity_type", "moderation_delete_intents"."entity_type")
            ELSE COALESCE("moderation_delete_intents"."entity_type", EXCLUDED."entity_type")
          END,
          "message_author_kind" = CASE
            WHEN ${shouldPromoteObserved} OR ${shouldAdoptIndependentChannelCleanupContext}
            THEN COALESCE(
              EXCLUDED."message_author_kind",
              "moderation_delete_intents"."message_author_kind"
            )
            ELSE COALESCE(
              "moderation_delete_intents"."message_author_kind",
              EXCLUDED."message_author_kind"
            )
          END,
          "routing_policy" = CASE
            WHEN ${shouldPromoteObserved} OR ${shouldAdoptIndependentChannelCleanupContext}
            THEN EXCLUDED."routing_policy"
            WHEN ${shouldAdoptReplacementRouting}
              AND EXCLUDED."routing_policy" = 'delete_capable'
            THEN EXCLUDED."routing_policy"
            WHEN ${shouldAdoptReplacementRouting}
              AND EXCLUDED."routing_policy" = 'origin_first'
              AND "moderation_delete_intents"."routing_policy" = 'origin_only'
            THEN EXCLUDED."routing_policy"
            ELSE "moderation_delete_intents"."routing_policy"
          END,
          "commercial_ocr_guard_required" = (
            ${resultingHasCommercialOcrReason}
          ),
          "commercial_ocr_deadline_at" = CASE
            WHEN ${resultingHasCommercialOcrReason}
            THEN COALESCE(
              "moderation_delete_intents"."commercial_ocr_deadline_at",
              EXCLUDED."commercial_ocr_deadline_at",
              "moderation_delete_intents"."retry_until_at"
            )
            ELSE "moderation_delete_intents"."commercial_ocr_deadline_at"
          END,
          "execute_at" = CASE
            WHEN ${shouldPromoteObserved}
            THEN EXCLUDED."execute_at"
            ELSE "moderation_delete_intents"."execute_at"
          END,
          "next_attempt_at" = CASE
            WHEN "moderation_delete_intents"."retention_owned" THEN EXCLUDED."next_attempt_at"
            WHEN ${shouldPromoteObserved}
            THEN EXCLUDED."next_attempt_at"
            ELSE "moderation_delete_intents"."next_attempt_at"
          END,
          "retry_until_at" = CASE
            WHEN "moderation_delete_intents"."retention_owned" THEN EXCLUDED."retry_until_at"
            WHEN ${resultingHasCommercialOcrReason} AND ${shouldPromoteObserved}
            THEN GREATEST(
              "moderation_delete_intents"."retry_until_at",
              EXCLUDED."retry_until_at"
            )
            WHEN ${shouldPromoteObserved}
            THEN EXCLUDED."retry_until_at"
            ELSE "moderation_delete_intents"."retry_until_at"
          END,
          "completed_at" = CASE
            WHEN ${shouldPromoteObserved}
            THEN EXCLUDED."completed_at"
            ELSE "moderation_delete_intents"."completed_at"
          END,
          "updated_at" = CURRENT_TIMESTAMP
        WHERE ${!normalized.expiredImmediateSchedule}
        RETURNING
          "id",
          "chat_id" AS "chatId",
          "message_id" AS "messageId",
          "subject_user_id" AS "subjectUserId",
          "source_message_at" AS "sourceMessageAt",
          "entity_type" AS "entityType",
          "message_author_kind" AS "messageAuthorKind",
          "origin_bot_id" AS "originBotId",
          "routing_policy" AS "routingPolicy",
          "commercial_ocr_guard_required" AS "commercialOcrGuardRequired",
          "commercial_ocr_deadline_at" AS "commercialOcrDeadlineAt",
          "status",
          "execute_at" AS "executeAt",
          "next_attempt_at" AS "nextAttemptAt",
          "retry_until_at" AS "retryUntilAt",
          "attempt_count" AS "attemptCount",
          "last_bot_id" AS "lastBotId",
          "succeeded_bot_id" AS "succeededBotId",
          "delete_dispatch_started_at" AS "deleteDispatchStartedAt",
          "delete_dispatch_started_bot_id" AS "deleteDispatchStartedBotId",
          "remote_delete_succeeded_at" AS "remoteDeleteSucceededAt",
          "remote_delete_succeeded_bot_id" AS "remoteDeleteSucceededBotId",
          "candidate_failures" AS "candidateFailures",
          "last_status_code" AS "lastStatusCode",
          "last_error_code" AS "lastErrorCode",
          "last_error" AS "lastError",
          "lease_token" AS "leaseToken",
          "lease_expires_at" AS "leaseExpiresAt",
          "leased_from_status" AS "leasedFromStatus"
      `);
      const intent = rows[0];
      if (!intent && normalized.expiredImmediateSchedule) {
        // FLAG: The rejected upsert retains the conflicting row lock. Expired new
        // authority cannot move another schedule, retire retention or append a reason.
        const [existing] = await tx.$queryRaw<IntentRow[]>(Prisma.sql`
          SELECT ${this.intentSelectSql('intent')}
          FROM "moderation_delete_intents" intent
          WHERE intent."chat_id" = ${normalized.chatId} AND intent."message_id" = ${normalized.messageId}
        `);
        if (!existing) throw new Error('Expired delete conflict disappeared');
        retainedExpiredConflict = true;
        return existing;
      }
      if (!intent) {
        throw new Error('Failed to persist moderation delete intent');
      }

      const conflictReasonChanged = await tx.$executeRaw(Prisma.sql`
        WITH changed_reason AS (
          INSERT INTO "moderation_delete_intent_reasons" (
            "id", "intent_id", "reason_key", "user_id", "event_type", "rule_code",
            "masked_excerpt", "score", "metadata", "created_at", "updated_at"
          ) VALUES (
            ${reasonId}, ${intent.id}, ${normalized.reasonKey}, ${normalized.event.userId},
            CAST(${normalized.event.eventType} AS "EventType"), ${normalized.ruleCode},
            ${normalized.event.maskedExcerpt}, ${normalized.event.score},
            CAST(${metadataJson} AS JSONB), CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
          )
          ON CONFLICT ("intent_id", "reason_key") DO UPDATE SET
            "rule_code" = EXCLUDED."rule_code",
            "updated_at" = CURRENT_TIMESTAMP
          WHERE "moderation_delete_intent_reasons"."rule_code" <> EXCLUDED."rule_code"
            AND EXCLUDED."rule_code" IN (${Prisma.join([
              ...MODERATION_DELETE_INTENT_REPLACEMENT_CLEANUP_RULE_CODES,
            ])})
          RETURNING "id"
        ), recorded_origin AS (
          -- FLAG: Only the newly inserted reason owns this provenance. A later
          -- duplicate or rule promotion cannot backfill or replace its source.
          INSERT INTO "moderation_delete_reason_origins" (
            "reason_id", "source_webhook_event_id", "source_receiving_bot_id",
            "source_execution_bot_id", "source_event_at", "source_observed_at", "source_evidence_version"
          ) SELECT changed_reason."id", ${sourceOrigin?.sourceWebhookEventId ?? null},
            ${sourceOrigin?.sourceReceivingBotId ?? null}, ${sourceOrigin?.sourceExecutionBotId ?? null},
            ${sourceOrigin?.sourceEventAt ?? null}, CURRENT_TIMESTAMP, ${sourceOrigin?.sourceEvidenceVersion ?? null}
          FROM changed_reason
          WHERE changed_reason."id" = ${reasonId} AND ${sourceOrigin !== null}
        ), retired_retention_reason AS (
          DELETE FROM "moderation_delete_intent_reasons"
          WHERE "intent_id" = ${intent.id} AND "rule_code" = ${MESSAGE_RETENTION_RULE}
        )
        UPDATE "moderation_delete_intents" schedule
        SET
          "execute_at" = LEAST(schedule."execute_at", ${normalized.executeAt}),
          "next_attempt_at" = LEAST(schedule."next_attempt_at", ${normalized.executeAt}),
          "retry_until_at" = GREATEST(schedule."retry_until_at", ${normalized.retryUntilAt}),
          "updated_at" = CURRENT_TIMESTAMP
        WHERE schedule."id" = ${intent.id}
          AND schedule."id" <> ${intentId}
          AND EXISTS (SELECT 1 FROM changed_reason)
      `);
      const reasonChanged = intent.id === intentId ? 1 : conflictReasonChanged;
      if (reasonChanged === 1 && intent.id !== intentId) {
        intent.executeAt = new Date(
          Math.min(intent.executeAt.getTime(), normalized.executeAt.getTime()),
        );
        intent.nextAttemptAt = new Date(
          Math.min(intent.nextAttemptAt.getTime(), normalized.executeAt.getTime()),
        );
        intent.retryUntilAt = new Date(
          Math.max(intent.retryUntilAt.getTime(), normalized.retryUntilAt.getTime()),
        );
      }
      let storedNonCommercialOcrDeleteReason: boolean | undefined;
      let storedDurableUserDeleteReason: boolean | undefined;
      let storedReplacementCleanup: boolean | undefined;
      let storedNonChannelReplacementCleanup: boolean | undefined;
      let storedChannelAutoPostCleanupReason: boolean | undefined;
      let storedBotMessageAutoDeleteReason: boolean | undefined;
      let storedRequiredSubscriptionDeleteReason: boolean | undefined;
      let storedImageTextStopListDeleteReason: boolean | undefined;
      let storedImageTextStopListDeleteOnly: boolean | undefined;
      let storedStandardCommercialOcrDeleteReason: boolean | undefined;
      if (intent.id !== intentId && normalized.ruleCode === COMMERCIAL_OCR_DELETE_RULE_CODE) {
        const reasonState = await tx.$queryRaw<
          Array<{
            nonCommercialOcrDeleteReason: boolean;
            durableUserDeleteReason: boolean;
            replacementCleanup: boolean;
            nonChannelReplacementCleanup: boolean;
            channelAutoPostCleanupReason: boolean;
            botMessageAutoDeleteReason: boolean;
            requiredSubscriptionDeleteReason: boolean;
            imageTextStopListDeleteReason: boolean;
            imageTextStopListDeleteOnly: boolean;
            standardCommercialOcrDeleteReason: boolean;
          }>
        >(Prisma.sql`
          SELECT EXISTS (
            SELECT 1
            FROM "moderation_delete_intent_reasons" existing_non_ocr_reason
            WHERE existing_non_ocr_reason."intent_id" = ${intent.id}
              AND existing_non_ocr_reason."rule_code" <> ${COMMERCIAL_OCR_DELETE_RULE_CODE}
              AND existing_non_ocr_reason."rule_code" <>
                ${CHANNEL_AUTO_POST_FORWARD_REPLACEMENT_CLEANUP_RULE_CODE}
          ) AS "nonCommercialOcrDeleteReason",
          ${this.durableUserDeleteReasonSql(Prisma.sql`${intent.id}`)} AS "durableUserDeleteReason",
          EXISTS (
            SELECT 1
            FROM "moderation_delete_intent_reasons" existing_replacement_reason
            WHERE existing_replacement_reason."intent_id" = ${intent.id}
              AND existing_replacement_reason."rule_code" IN (${Prisma.join([
                ...MODERATION_DELETE_INTENT_REPLACEMENT_CLEANUP_RULE_CODES,
              ])})
          ) AS "replacementCleanup",
          EXISTS (
            SELECT 1
            FROM "moderation_delete_intent_reasons" existing_non_channel_replacement_reason
            WHERE existing_non_channel_replacement_reason."intent_id" = ${intent.id}
              AND existing_non_channel_replacement_reason."rule_code" IN (${Prisma.join([
                ...MODERATION_DELETE_INTENT_REPLACEMENT_CLEANUP_RULE_CODES.filter(
                  (ruleCode) =>
                    ruleCode !== CHANNEL_AUTO_POST_FORWARD_REPLACEMENT_CLEANUP_RULE_CODE,
                ),
              ])})
          ) AS "nonChannelReplacementCleanup",
          EXISTS (
            SELECT 1
            FROM "moderation_delete_intent_reasons" existing_channel_cleanup_reason
            WHERE existing_channel_cleanup_reason."intent_id" = ${intent.id}
              AND existing_channel_cleanup_reason."rule_code" =
                ${CHANNEL_AUTO_POST_FORWARD_REPLACEMENT_CLEANUP_RULE_CODE}
          ) AS "channelAutoPostCleanupReason",
          EXISTS (
            SELECT 1
            FROM "moderation_delete_intent_reasons" existing_auto_delete_reason
            WHERE existing_auto_delete_reason."intent_id" = ${intent.id}
              AND existing_auto_delete_reason."rule_code" = ${BOT_MESSAGE_AUTO_DELETE_RULE_CODE}
          ) AS "botMessageAutoDeleteReason",
          EXISTS (
            SELECT 1
            FROM "moderation_delete_intent_reasons" existing_required_subscription_reason
            WHERE existing_required_subscription_reason."intent_id" = ${intent.id}
              AND existing_required_subscription_reason."rule_code" =
                ${REQUIRED_SUBSCRIPTION_DELETE_RULE_CODE}
          ) AS "requiredSubscriptionDeleteReason",
          EXISTS (
            SELECT 1
            FROM "moderation_delete_intent_reasons" image_text_reason
            WHERE image_text_reason."intent_id" = ${intent.id}
              AND image_text_reason."rule_code" = ${COMMERCIAL_OCR_DELETE_RULE_CODE}
              AND COALESCE(image_text_reason."metadata"->>'source', '') = 'image_text_ocr'
              AND COALESCE(image_text_reason."metadata"->>'enforcementScope', '') = 'delete_only'
          ) AS "imageTextStopListDeleteReason",
          EXISTS (
            SELECT 1
            FROM "moderation_delete_intent_reasons" commercial_reason
            WHERE commercial_reason."intent_id" = ${intent.id}
              AND commercial_reason."rule_code" = ${COMMERCIAL_OCR_DELETE_RULE_CODE}
              AND COALESCE(commercial_reason."metadata"->>'source', '') <> 'image_text_ocr'
          ) AS "standardCommercialOcrDeleteReason",
          NOT EXISTS (
            SELECT 1
            FROM "moderation_delete_intent_reasons" independent_reason
            WHERE independent_reason."intent_id" = ${intent.id}
              AND NOT (
                independent_reason."rule_code" = ${COMMERCIAL_OCR_DELETE_RULE_CODE}
                AND COALESCE(independent_reason."metadata"->>'source', '') = 'image_text_ocr'
                AND COALESCE(independent_reason."metadata"->>'enforcementScope', '') = 'delete_only'
              )
          ) AS "imageTextStopListDeleteOnly"
        `);
        storedNonCommercialOcrDeleteReason = reasonState[0]?.nonCommercialOcrDeleteReason === true;
        storedDurableUserDeleteReason = reasonState[0]?.durableUserDeleteReason === true;
        storedReplacementCleanup = reasonState[0]?.replacementCleanup === true;
        storedNonChannelReplacementCleanup =
          typeof reasonState[0]?.nonChannelReplacementCleanup === 'boolean'
            ? reasonState[0].nonChannelReplacementCleanup
            : undefined;
        storedChannelAutoPostCleanupReason =
          typeof reasonState[0]?.channelAutoPostCleanupReason === 'boolean'
            ? reasonState[0].channelAutoPostCleanupReason
            : undefined;
        storedBotMessageAutoDeleteReason = reasonState[0]?.botMessageAutoDeleteReason === true;
        storedRequiredSubscriptionDeleteReason =
          reasonState[0]?.requiredSubscriptionDeleteReason === true;
        storedImageTextStopListDeleteReason =
          reasonState[0]?.imageTextStopListDeleteReason === true;
        storedImageTextStopListDeleteOnly =
          storedImageTextStopListDeleteReason &&
          reasonState[0]?.imageTextStopListDeleteOnly === true;
        storedStandardCommercialOcrDeleteReason =
          reasonState[0]?.standardCommercialOcrDeleteReason === true;
      } else if (
        intent.id !== intentId &&
        this.requiredSubscriptionDeleteEnabled &&
        normalized.ruleCode !== REQUIRED_SUBSCRIPTION_DELETE_RULE_CODE
      ) {
        const reasonState = await tx.$queryRaw<
          Array<{ requiredSubscriptionDeleteReason: boolean }>
        >(Prisma.sql`
          SELECT EXISTS (
            SELECT 1
            FROM "moderation_delete_intent_reasons" existing_required_subscription_reason
            WHERE existing_required_subscription_reason."intent_id" = ${intent.id}
              AND existing_required_subscription_reason."rule_code" =
                ${REQUIRED_SUBSCRIPTION_DELETE_RULE_CODE}
          ) AS "requiredSubscriptionDeleteReason"
        `);
        storedRequiredSubscriptionDeleteReason =
          reasonState[0]?.requiredSubscriptionDeleteReason === true;
      }
      let effectiveIntent = intent;
      if (
        reasonChanged === 1 &&
        initialStatus === 'PENDING' &&
        normalized.ruleCode !== 'BOT_MESSAGE_AUTO_DELETE' &&
        this.isReplacementCleanupRuleCode(normalized.ruleCode) &&
        intent.status === 'FAILED_TERMINAL' &&
        intent.lastErrorCode === 'managed_output_auto_delete_blocked'
      ) {
        const reopenedRows = await tx.$queryRaw<IntentRow[]>(Prisma.sql`
          UPDATE "moderation_delete_intents"
          SET
            "status" = CASE
              WHEN "remote_delete_succeeded_at" IS NOT NULL
                OR "remote_delete_succeeded_bot_id" IS NOT NULL
                OR "delete_dispatch_started_at" IS NOT NULL
                OR "delete_dispatch_started_bot_id" IS NOT NULL
              THEN CAST('AMBIGUOUS' AS "ModerationDeleteIntentStatus")
              ELSE CAST('PENDING' AS "ModerationDeleteIntentStatus")
            END,
            "execute_at" = LEAST("execute_at", ${normalized.executeAt}),
            "next_attempt_at" = ${normalized.executeAt},
            "retry_until_at" = GREATEST("retry_until_at", ${normalized.retryUntilAt}),
            "last_status_code" = NULL,
            "last_error_code" = NULL,
            "last_error" = NULL,
            "completed_at" = NULL,
            "lease_token" = NULL,
            "lease_expires_at" = NULL,
            "leased_from_status" = NULL,
            "updated_at" = CURRENT_TIMESTAMP
          WHERE "id" = ${intent.id}
            AND "status" = CAST('FAILED_TERMINAL' AS "ModerationDeleteIntentStatus")
            AND "last_error_code" = 'managed_output_auto_delete_blocked'
          RETURNING ${this.intentReturningSql()}
        `);
        effectiveIntent = reopenedRows[0] ?? intent;
      }
      if (
        reasonChanged === 1 &&
        effectiveIntent === intent &&
        initialStatus === 'PENDING' &&
        normalized.ruleCode !== BOT_MESSAGE_AUTO_DELETE_RULE_CODE &&
        intent.status === 'FAILED_TERMINAL' &&
        intent.lastErrorCode === BOT_MESSAGE_AUTO_DELETE_RETRY_LIMIT_ERROR_CODE
      ) {
        // FLAG: Any later executable reason owns an independent deletion and must not remain
        // hidden behind the bounded best-effort bot-message cleanup decision.
        const reopenedRows = await tx.$queryRaw<IntentRow[]>(Prisma.sql`
          UPDATE "moderation_delete_intents"
          SET
            "status" = CAST('PENDING' AS "ModerationDeleteIntentStatus"),
            "execute_at" = LEAST("execute_at", ${normalized.executeAt}),
            "next_attempt_at" = ${normalized.executeAt},
            "retry_until_at" = GREATEST("retry_until_at", ${normalized.retryUntilAt}),
            "last_status_code" = NULL,
            "last_error_code" = NULL,
            "last_error" = NULL,
            "completed_at" = NULL,
            "lease_token" = NULL,
            "lease_expires_at" = NULL,
            "leased_from_status" = NULL,
            "updated_at" = CURRENT_TIMESTAMP
          WHERE "id" = ${intent.id}
            AND "status" = CAST('FAILED_TERMINAL' AS "ModerationDeleteIntentStatus")
            AND "last_error_code" = ${BOT_MESSAGE_AUTO_DELETE_RETRY_LIMIT_ERROR_CODE}
            AND "remote_delete_succeeded_at" IS NULL
            AND "remote_delete_succeeded_bot_id" IS NULL
            AND "delete_dispatch_started_at" IS NULL
            AND "delete_dispatch_started_bot_id" IS NULL
          RETURNING ${this.intentReturningSql()}
        `);
        effectiveIntent = reopenedRows[0] ?? intent;
      }
      if (
        effectiveIntent === intent &&
        initialStatus === 'PENDING' &&
        normalized.ruleCode === LINK_BLOCKED_DELETE_RULE_CODE &&
        normalized.messageAuthorKind === 'user' &&
        normalized.sourceMessageAt &&
        (intent.status === 'EXPIRED' || intent.status === 'FAILED_TERMINAL') &&
        (!intent.sourceMessageAt || normalized.sourceMessageAt > intent.sourceMessageAt)
      ) {
        const reopenedRows = await tx.$queryRaw<IntentRow[]>(Prisma.sql`
          UPDATE "moderation_delete_intents"
          SET
            "status" = CASE
              WHEN "remote_delete_succeeded_at" IS NOT NULL
                OR "remote_delete_succeeded_bot_id" IS NOT NULL
                OR "delete_dispatch_started_at" IS NOT NULL
                OR "delete_dispatch_started_bot_id" IS NOT NULL
              THEN CAST('AMBIGUOUS' AS "ModerationDeleteIntentStatus")
              ELSE CAST('PENDING' AS "ModerationDeleteIntentStatus")
            END,
            "source_message_at" = ${normalized.sourceMessageAt},
            "attempt_count" = 0,
            "first_attempt_at" = NULL,
            "last_attempt_at" = NULL,
            "execute_at" = LEAST("execute_at", ${normalized.executeAt}),
            "next_attempt_at" = ${normalized.executeAt},
            "retry_until_at" = GREATEST("retry_until_at", ${normalized.retryUntilAt}),
            "last_status_code" = NULL,
            "last_error_code" = NULL,
            "last_error" = NULL,
            "completed_at" = NULL,
            "lease_token" = NULL,
            "lease_expires_at" = NULL,
            "leased_from_status" = NULL,
            "updated_at" = CURRENT_TIMESTAMP
          WHERE "id" = ${intent.id}
            AND "status" IN (
              CAST('EXPIRED' AS "ModerationDeleteIntentStatus"),
              CAST('FAILED_TERMINAL' AS "ModerationDeleteIntentStatus")
            )
            AND (
              "source_message_at" IS NULL
              OR "source_message_at" < ${normalized.sourceMessageAt}
            )
          RETURNING ${this.intentReturningSql()}
        `);
        effectiveIntent = reopenedRows[0] ?? intent;
      }
      if (
        reasonChanged === 1 &&
        effectiveIntent === intent &&
        intent.status === 'EXPIRED' &&
        initialStatus === 'PENDING' &&
        this.isReplacementCleanupRecoveryReason(normalized.reasonKey) &&
        this.isReplacementCleanupRuleCode(normalized.ruleCode)
      ) {
        const reopenedRows = await tx.$queryRaw<IntentRow[]>(Prisma.sql`
          UPDATE "moderation_delete_intents"
          SET
            "status" = CASE
              WHEN "remote_delete_succeeded_at" IS NOT NULL
                OR "remote_delete_succeeded_bot_id" IS NOT NULL
                OR "delete_dispatch_started_at" IS NOT NULL
                OR "delete_dispatch_started_bot_id" IS NOT NULL
              THEN CAST('AMBIGUOUS' AS "ModerationDeleteIntentStatus")
              ELSE CAST('PENDING' AS "ModerationDeleteIntentStatus")
            END,
            "execute_at" = LEAST("execute_at", ${normalized.executeAt}),
            "next_attempt_at" = ${normalized.executeAt},
            "retry_until_at" = GREATEST("retry_until_at", ${normalized.retryUntilAt}),
            "completed_at" = NULL,
            "lease_token" = NULL,
            "lease_expires_at" = NULL,
            "leased_from_status" = NULL,
            "updated_at" = CURRENT_TIMESTAMP
          WHERE "id" = ${intent.id}
            AND "status" = CAST('EXPIRED' AS "ModerationDeleteIntentStatus")
          RETURNING ${this.intentReturningSql()}
        `);
        effectiveIntent = reopenedRows[0] ?? intent;
      }
      if (
        reasonChanged === 1 &&
        effectiveIntent === intent &&
        initialStatus === 'PENDING' &&
        normalized.ruleCode !== COMMERCIAL_OCR_DELETE_RULE_CODE &&
        intent.commercialOcrGuardRequired === true &&
        (intent.status === 'EXPIRED' || intent.status === 'FAILED_TERMINAL')
      ) {
        // FLAG: A newly committed independent reason must not remain hidden behind an earlier
        // terminal OCR-only decision. Concurrent IN_PROGRESS merges are handled by the locked
        // terminal guard boundary below.
        const reopenedRows = await tx.$queryRaw<IntentRow[]>(Prisma.sql`
          UPDATE "moderation_delete_intents"
          SET
            "status" = CASE
              WHEN "remote_delete_succeeded_at" IS NOT NULL
                OR "remote_delete_succeeded_bot_id" IS NOT NULL
                OR "delete_dispatch_started_at" IS NOT NULL
                OR "delete_dispatch_started_bot_id" IS NOT NULL
              THEN CAST('AMBIGUOUS' AS "ModerationDeleteIntentStatus")
              ELSE CAST('PENDING' AS "ModerationDeleteIntentStatus")
            END,
            "execute_at" = LEAST("execute_at", ${normalized.executeAt}),
            "next_attempt_at" = ${normalized.executeAt},
            "retry_until_at" = GREATEST("retry_until_at", ${normalized.retryUntilAt}),
            "last_status_code" = NULL,
            "last_error_code" = NULL,
            "last_error" = NULL,
            "completed_at" = NULL,
            "lease_token" = NULL,
            "lease_expires_at" = NULL,
            "leased_from_status" = NULL,
            "updated_at" = CURRENT_TIMESTAMP
          WHERE "id" = ${intent.id}
            AND "commercial_ocr_guard_required" = TRUE
            AND "remote_delete_succeeded_at" IS NULL
            AND "remote_delete_succeeded_bot_id" IS NULL
            AND "delete_dispatch_started_at" IS NULL
            AND "delete_dispatch_started_bot_id" IS NULL
            AND (
              "status" = CAST('EXPIRED' AS "ModerationDeleteIntentStatus")
              OR (
                "status" = CAST('FAILED_TERMINAL' AS "ModerationDeleteIntentStatus")
                AND (
                  "last_error_code" LIKE 'commercial_ocr_%'
                  OR "last_error_code" LIKE 'image_text_stop_list_%'
                  OR "last_error_code" = 'moderation_delete_reason_missing'
                )
              )
            )
          RETURNING ${this.intentReturningSql()}
        `);
        effectiveIntent = reopenedRows[0] ?? intent;
      }
      const independentProfanityReason =
        normalized.ruleCode !== PROFANITY_DELETE_RULE_CODE &&
        intent.lastErrorCode?.startsWith('profanity_') === true;
      const freshStopWordsReason =
        intent.lastErrorCode === 'stop_words_delete_no_longer_authorized';
      const freshCommercialReason = intent.lastErrorCode?.startsWith('commercial_text_') === true;
      const incomingCommercialBinding =
        normalized.ruleCode === COMMERCIAL_TEXT_DELETE_RULE_CODE
          ? readCommercialTextDeleteBinding(
              this.asRecord(normalized.event.metadata)?.commercialTextBinding,
            )
          : null;
      const freshCommercialExpiredReason =
        intent.status === 'EXPIRED' &&
        incomingCommercialBinding !== null &&
        incomingCommercialBinding.deadlineAtMs > Date.now();
      if (
        reasonChanged === 1 &&
        effectiveIntent === intent &&
        initialStatus === 'PENDING' &&
        normalized.entityType !== null &&
        (intent.status === 'FAILED_TERMINAL' || freshCommercialExpiredReason) &&
        (independentProfanityReason ||
          freshCommercialReason ||
          freshCommercialExpiredReason ||
          freshStopWordsReason ||
          (normalized.ruleCode !== CHANNEL_AUTO_POST_FORWARD_REPLACEMENT_CLEANUP_RULE_CODE &&
            normalized.ruleCode !== NIGHT_MODE_CLOSE_NOTICE_CLEANUP_RULE_CODE &&
            (intent.lastErrorCode === CHANNEL_AUTO_POST_CLEANUP_ENTITY_MISMATCH_ERROR_CODE ||
              intent.lastErrorCode === CHANNEL_AUTO_POST_CLEANUP_SENDER_REJECTED_ERROR_CODE ||
              intent.lastErrorCode === NIGHT_MODE_CLOSE_NOTICE_CLEANUP_STALE_ERROR_CODE)))
      ) {
        // FLAG: Fresh reasons cannot inherit a stale text/cleanup rejection. Reopened commercial
        // and stop-list revisions still have to pass their current-source guards before dispatch.
        const reopenedRows = await tx.$queryRaw<IntentRow[]>(Prisma.sql`
          UPDATE "moderation_delete_intents"
          SET
            "status" = CASE
              WHEN "remote_delete_succeeded_at" IS NOT NULL
                OR "remote_delete_succeeded_bot_id" IS NOT NULL
                OR "delete_dispatch_started_at" IS NOT NULL
                OR "delete_dispatch_started_bot_id" IS NOT NULL
              THEN CAST('AMBIGUOUS' AS "ModerationDeleteIntentStatus")
              ELSE CAST('PENDING' AS "ModerationDeleteIntentStatus")
            END,
            "execute_at" = LEAST("execute_at", ${normalized.executeAt}),
            "next_attempt_at" = ${normalized.executeAt},
            "retry_until_at" = GREATEST("retry_until_at", ${normalized.retryUntilAt}),
            "entity_type" = CAST(${normalized.entityType} AS "ChatEntityType"),
            "message_author_kind" = COALESCE(
              ${normalized.messageAuthorKind},
              "message_author_kind"
            ),
            "origin_bot_id" = COALESCE(${normalized.originBotId}, "origin_bot_id"),
            "routing_policy" = ${normalized.routingPolicy},
            "last_status_code" = NULL,
            "last_error_code" = NULL,
            "last_error" = NULL,
            "completed_at" = NULL,
            "lease_token" = NULL,
            "lease_expires_at" = NULL,
            "leased_from_status" = NULL,
            "updated_at" = CURRENT_TIMESTAMP
          WHERE "id" = ${intent.id}
            AND (("status" = CAST('FAILED_TERMINAL' AS "ModerationDeleteIntentStatus") AND (
              "last_error_code" IN (
                ${CHANNEL_AUTO_POST_CLEANUP_ENTITY_MISMATCH_ERROR_CODE},
                ${CHANNEL_AUTO_POST_CLEANUP_SENDER_REJECTED_ERROR_CODE},
                ${NIGHT_MODE_CLOSE_NOTICE_CLEANUP_STALE_ERROR_CODE}
              )
              OR (${independentProfanityReason} AND "last_error_code" LIKE 'profanity_%')
              OR (${freshStopWordsReason} AND "last_error_code" = 'stop_words_delete_no_longer_authorized')
              OR (${freshCommercialReason} AND "last_error_code" LIKE 'commercial_text_%')
            )) OR (${freshCommercialExpiredReason} AND "status" = CAST('EXPIRED' AS "ModerationDeleteIntentStatus")))
            AND "remote_delete_succeeded_at" IS NULL
            AND "remote_delete_succeeded_bot_id" IS NULL
            AND "delete_dispatch_started_at" IS NULL
            AND "delete_dispatch_started_bot_id" IS NULL
            AND EXISTS (
              SELECT 1
              FROM "chats" current_entity
              WHERE current_entity."id" = "moderation_delete_intents"."chat_id"
                AND current_entity."entity_type" =
                  CAST(${normalized.entityType} AS "ChatEntityType")
            )
          RETURNING ${this.intentReturningSql()}
        `);
        effectiveIntent = reopenedRows[0] ?? intent;
      }
      await this.linkReplacementCleanupIntent(tx, normalized, effectiveIntent.id);
      if (effectiveIntent.status === 'SUCCEEDED') {
        await this.materializeModerationEventsForIntent(tx, effectiveIntent.id);
      }
      if (storedDurableUserDeleteReason !== undefined) {
        effectiveIntent.durableUserDeleteReason = storedDurableUserDeleteReason;
      }
      if (storedNonCommercialOcrDeleteReason !== undefined) {
        effectiveIntent.nonCommercialOcrDeleteReason = storedNonCommercialOcrDeleteReason;
      }
      if (storedReplacementCleanup !== undefined) {
        effectiveIntent.replacementCleanup = storedReplacementCleanup;
      }
      if (storedNonChannelReplacementCleanup !== undefined) {
        effectiveIntent.nonChannelReplacementCleanup = storedNonChannelReplacementCleanup;
      }
      if (storedChannelAutoPostCleanupReason !== undefined) {
        effectiveIntent.channelAutoPostCleanupReason = storedChannelAutoPostCleanupReason;
      }
      if (storedBotMessageAutoDeleteReason !== undefined) {
        effectiveIntent.botMessageAutoDeleteReason = storedBotMessageAutoDeleteReason;
      }
      if (storedRequiredSubscriptionDeleteReason !== undefined) {
        effectiveIntent.requiredSubscriptionDeleteReason = storedRequiredSubscriptionDeleteReason;
      }
      if (storedImageTextStopListDeleteReason !== undefined) {
        effectiveIntent.imageTextStopListDeleteReason = storedImageTextStopListDeleteReason;
      }
      if (storedImageTextStopListDeleteOnly !== undefined) {
        effectiveIntent.imageTextStopListDeleteOnly = storedImageTextStopListDeleteOnly;
      }
      if (storedStandardCommercialOcrDeleteReason !== undefined) {
        effectiveIntent.standardCommercialOcrDeleteReason = storedStandardCommercialOcrDeleteReason;
      }
      if (intent.id !== intentId && REPORT_GUARDED_RULES.has(normalized.ruleCode)) {
        // FLAG: A report merged into an existing urgent reason retains that reason's queue priority.
        const [reportClassifiers] = await tx.$queryRaw<
          Array<
            Pick<
              IntentRow,
              'reportDeleteReason' | 'reportCounterCleanupReason' | 'reportHistoryOnly'
            >
          >
        >(Prisma.sql`
          SELECT EXISTS (
            SELECT 1 FROM moderation_delete_intent_reasons reason
            WHERE reason.intent_id = ${intent.id} AND reason.rule_code IN (${REPORT_DELETE_RULE}, ${REPORT_COMMAND_RULE})
          ) AS "reportDeleteReason", EXISTS (
            SELECT 1 FROM moderation_delete_intent_reasons reason
            WHERE reason.intent_id = ${intent.id} AND reason.rule_code = ${REPORT_COUNTER_RULE}
          ) AS "reportCounterCleanupReason", NOT EXISTS (
            SELECT 1 FROM moderation_delete_intent_reasons reason
            WHERE reason.intent_id = ${intent.id} AND (
              reason.rule_code <> ${REPORT_DELETE_RULE}
              OR reason.metadata->>'reportTargetMessageId' IS NULL
              OR reason.metadata->>'reportTargetMessageId' = ${normalized.messageId}
            )
          ) AS "reportHistoryOnly"
        `);
        if (reportClassifiers) Object.assign(effectiveIntent, reportClassifiers);
      }
      return effectiveIntent;
    };
    const persisted = transactionClient
      ? await persist(transactionClient)
      : await this.prisma.$transaction(persist);
    if (retainedExpiredConflict)
      return {
        intentId: persisted.id,
        rollout:
          persisted.status !== 'OBSERVED' && this.isExecutionEnabledForIntent(persisted)
            ? 'execute'
            : 'observed',
        status: persisted.status,
      };
    persisted.replacementCleanup =
      persisted.replacementCleanup === true ||
      this.isReplacementCleanupRuleCode(normalized.ruleCode);
    const normalizedNonChannelReplacementCleanup =
      this.isReplacementCleanupRuleCode(normalized.ruleCode) &&
      normalized.ruleCode !== CHANNEL_AUTO_POST_FORWARD_REPLACEMENT_CLEANUP_RULE_CODE;
    if (
      persisted.nonChannelReplacementCleanup !== undefined ||
      normalizedNonChannelReplacementCleanup
    ) {
      persisted.nonChannelReplacementCleanup =
        persisted.nonChannelReplacementCleanup === true || normalizedNonChannelReplacementCleanup;
    }
    if (
      persisted.channelAutoPostCleanupReason !== undefined ||
      normalized.ruleCode === CHANNEL_AUTO_POST_FORWARD_REPLACEMENT_CLEANUP_RULE_CODE
    ) {
      persisted.channelAutoPostCleanupReason =
        persisted.channelAutoPostCleanupReason === true ||
        normalized.ruleCode === CHANNEL_AUTO_POST_FORWARD_REPLACEMENT_CLEANUP_RULE_CODE;
    }
    persisted.botMessageAutoDeleteReason =
      persisted.botMessageAutoDeleteReason === true ||
      normalized.ruleCode === BOT_MESSAGE_AUTO_DELETE_RULE_CODE;
    persisted.requiredSubscriptionDeleteReason =
      persisted.requiredSubscriptionDeleteReason === true ||
      normalized.ruleCode === REQUIRED_SUBSCRIPTION_DELETE_RULE_CODE;
    persisted.commercialOcrDeleteReason =
      persisted.commercialOcrGuardRequired ||
      normalized.ruleCode === COMMERCIAL_OCR_DELETE_RULE_CODE;
    const normalizedImageTextBinding = parseImageTextStopListBinding(normalized.event.metadata);
    if (normalized.ruleCode === COMMERCIAL_OCR_DELETE_RULE_CODE) {
      persisted.standardCommercialOcrDeleteReason = normalizedImageTextBinding
        ? (persisted.standardCommercialOcrDeleteReason ?? false)
        : true;
    }
    persisted.durableUserDeleteReason =
      persisted.durableUserDeleteReason === true ||
      DURABLE_USER_DELETE_RULES.has(normalized.ruleCode);
    persisted.nonCommercialOcrDeleteReason =
      persisted.nonCommercialOcrDeleteReason === true ||
      (normalized.ruleCode !== COMMERCIAL_OCR_DELETE_RULE_CODE &&
        !REPORT_GUARDED_RULES.has(normalized.ruleCode));
    if (normalizedImageTextBinding) {
      persisted.imageTextStopListDeleteReason = true;
      if (persisted.id === intentId) {
        persisted.imageTextStopListDeleteOnly = true;
      }
    }

    if (REPORT_GUARDED_RULES.has(normalized.ruleCode)) {
      persisted.reportDeleteReason =
        persisted.reportDeleteReason === true || normalized.ruleCode !== REPORT_COUNTER_RULE;
      persisted.reportCounterCleanupReason =
        persisted.reportCounterCleanupReason === true ||
        normalized.ruleCode === REPORT_COUNTER_RULE;
      const metadata = this.asRecord(normalized.event.metadata);
      persisted.reportHistoryOnly ??=
        normalized.ruleCode === REPORT_DELETE_RULE &&
        typeof metadata?.reportTargetMessageId === 'string' &&
        metadata.reportTargetMessageId !== normalized.messageId;
    }
    if (isBoundMessageDuplicateDelete(input)) persisted.messageDuplicateOwned = true;
    const effectiveRollout =
      persisted.status !== 'OBSERVED' && this.isExecutionEnabledForIntent(persisted)
        ? 'execute'
        : 'observed';
    if (enqueue && effectiveRollout === 'execute') {
      try {
        await this.enqueueWakeup(
          persisted,
          normalized.ruleCode === REPORT_DELETE_RULE && persisted.reportHistoryOnly === false
            ? DELETE_QUEUE_PRIORITY_INTERACTIVE
            : enqueuePriority,
        );
      } catch (error: unknown) {
        this.logger.warn(
          { intentId: persisted.id, err: this.errorMessage(error) },
          'Failed to enqueue persisted moderation delete intent; DB sweeper will retry',
        );
      }
    }
    return { intentId: persisted.id, rollout: effectiveRollout, status: persisted.status };
  }

  private async claimOne(
    intentId: string,
    retentionOnly = false,
    receiptOnly = false,
  ): Promise<IntentRow | null> {
    const now = new Date();
    const leaseToken = randomUUID();
    const leaseExpiresAt = new Date(now.getTime() + this.leaseMs);
    const rows = await this.prisma.$queryRaw<IntentRow[]>(Prisma.sql`
      UPDATE "moderation_delete_intents"
      SET
        "status" = CAST('IN_PROGRESS' AS "ModerationDeleteIntentStatus"),
        "lease_token" = ${leaseToken},
        "lease_expires_at" = ${leaseExpiresAt},
        "leased_from_status" = COALESCE("leased_from_status", "status"),
        "attempt_count" = "attempt_count" + 1,
        "first_attempt_at" = COALESCE("first_attempt_at", ${now}),
        "last_attempt_at" = ${now},
        "updated_at" = CURRENT_TIMESTAMP
      WHERE "id" = ${intentId}
        AND "execute_at" <= ${now}
        AND (("remote_delete_succeeded_at" IS NOT NULL AND "remote_delete_succeeded_bot_id" IS NOT NULL)
          OR (NOT EXISTS (SELECT 1 FROM "webhook_source_abandonments" held
            WHERE held."chat_id" = "moderation_delete_intents"."chat_id"
              AND held."message_id" = "moderation_delete_intents"."message_id") AND NOT EXISTS (SELECT 1 FROM "webhook_backlog_receipts" cancelled
            WHERE cancelled."chat_id" = "moderation_delete_intents"."chat_id"
              AND cancelled."message_id" = "moderation_delete_intents"."message_id")))
        AND (${getAppRole() === 'all'} OR "retention_owned" = ${getAppRole() === 'message-retention'})
        AND (${!retentionOnly} OR "retention_owned" = TRUE)
        AND "next_attempt_at" <= ${now}
        AND (
          "retry_until_at" > ${now}
          OR "remote_delete_succeeded_at" IS NOT NULL
          OR "remote_delete_succeeded_bot_id" IS NOT NULL
          OR "delete_dispatch_started_at" IS NOT NULL
          OR "delete_dispatch_started_bot_id" IS NOT NULL
        )
        AND (
          "status" IN (
            CAST('PENDING' AS "ModerationDeleteIntentStatus"),
            CAST('RETRYABLE' AS "ModerationDeleteIntentStatus"),
            CAST('WAITING_CAPABILITY' AS "ModerationDeleteIntentStatus"),
            CAST('AMBIGUOUS' AS "ModerationDeleteIntentStatus")
          )
          OR (
            "status" = CAST('IN_PROGRESS' AS "ModerationDeleteIntentStatus")
            AND "lease_expires_at" < ${now}
          )
          OR (
            ${receiptOnly} AND "retention_owned" = TRUE
            AND "status" IN (
              CAST('FAILED_TERMINAL' AS "ModerationDeleteIntentStatus"),
              CAST('EXPIRED' AS "ModerationDeleteIntentStatus"),
              CAST('OBSERVED' AS "ModerationDeleteIntentStatus")
            )
            AND ("remote_delete_succeeded_at" IS NOT NULL
              OR "remote_delete_succeeded_bot_id" IS NOT NULL
              OR "delete_dispatch_started_at" IS NOT NULL
              OR "delete_dispatch_started_bot_id" IS NOT NULL)
          )
        )
      RETURNING ${this.intentReturningSql()}
    `);
    return rows[0] ?? null;
  }

  private async selectDueIntentIds(): Promise<Array<{ id: string }>> {
    const now = new Date();
    const rolloutFilter = this.buildSweepRolloutFilter();
    const selectStatus = (status: Prisma.Sql, leaseFilter = Prisma.empty) => Prisma.sql`
        SELECT intent."id", intent."next_attempt_at", intent."created_at"
        FROM "moderation_delete_intents" intent
        WHERE intent."status" = ${status}
          AND ((intent."remote_delete_succeeded_at" IS NOT NULL AND intent."remote_delete_succeeded_bot_id" IS NOT NULL)
            OR (NOT EXISTS (SELECT 1 FROM "webhook_source_abandonments" held
              WHERE held."chat_id" = intent."chat_id" AND held."message_id" = intent."message_id") AND NOT EXISTS (SELECT 1 FROM "webhook_backlog_receipts" cancelled
              WHERE cancelled."chat_id" = intent."chat_id" AND cancelled."message_id" = intent."message_id")))
          AND intent."execute_at" <= ${now}
          AND intent."retention_owned" = FALSE
          AND intent."next_attempt_at" <= ${now}
          AND (
            intent."retry_until_at" > ${now}
            OR intent."remote_delete_succeeded_at" IS NOT NULL
            OR intent."remote_delete_succeeded_bot_id" IS NOT NULL
            OR intent."delete_dispatch_started_at" IS NOT NULL
            OR intent."delete_dispatch_started_bot_id" IS NOT NULL
          )
          AND ${rolloutFilter}
          ${leaseFilter}
        ORDER BY intent."next_attempt_at" ASC, intent."created_at" ASC
        LIMIT ${this.sweepBatchSize}
        FOR UPDATE SKIP LOCKED
    `;
    // FLAG: A fixed status lets the existing (status, next_attempt_at, execute_at)
    // index find each ordered prefix without sorting the whole mixed-status population.
    // Every lane keeps all eligibility/authority predicates. Locks are statement-local,
    // at most five batch prefixes; only the original total batch is handed to workers.
    // FLAG: Interleave those bounded status prefixes so retained ambiguous effects
    // cannot occupy every slot ahead of new PENDING/RETRYABLE moderation deletes.
    // This schedules existing authority only; workers retain every claim and effect guard.
    return this.prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      WITH pending AS MATERIALIZED (
        ${selectStatus(Prisma.sql`CAST('PENDING' AS "ModerationDeleteIntentStatus")`)}
      ), retryable AS MATERIALIZED (
        ${selectStatus(Prisma.sql`CAST('RETRYABLE' AS "ModerationDeleteIntentStatus")`)}
      ), waiting AS MATERIALIZED (
        ${selectStatus(Prisma.sql`CAST('WAITING_CAPABILITY' AS "ModerationDeleteIntentStatus")`)}
      ), ambiguous AS MATERIALIZED (
        ${selectStatus(Prisma.sql`CAST('AMBIGUOUS' AS "ModerationDeleteIntentStatus")`)}
      ), in_progress AS MATERIALIZED (
        ${selectStatus(
          Prisma.sql`CAST('IN_PROGRESS' AS "ModerationDeleteIntentStatus")`,
          Prisma.sql`AND intent."lease_expires_at" < ${now}`,
        )}
      ), candidates AS (
        SELECT *, 0 AS lane FROM pending
        UNION ALL SELECT *, 1 AS lane FROM retryable
        UNION ALL SELECT *, 2 AS lane FROM waiting
        UNION ALL SELECT *, 3 AS lane FROM ambiguous
        UNION ALL SELECT *, 4 AS lane FROM in_progress
      ), ranked AS (
        SELECT *, row_number() OVER (
          PARTITION BY lane ORDER BY next_attempt_at, created_at, id
        ) AS lane_position
        FROM candidates
      )
      SELECT ranked."id"
      FROM ranked
      ORDER BY ranked.lane_position, ranked."next_attempt_at", ranked."created_at", ranked."id"
      LIMIT ${this.sweepBatchSize}
    `);
  }

  private async finishRetryableAttempt(
    intent: IntentRow,
    leaseToken: string,
    details: DeleteErrorDetails,
    requireInitialUnattempted: boolean | 'guarded' = false,
  ): Promise<ModerationDeleteAttemptResult> {
    const retryLimitReached =
      details.status !== 'FAILED_TERMINAL' &&
      details.status !== 'EXPIRED' &&
      this.isBotMessageAutoDeleteRetryLimitApplicable(intent) &&
      intent.attemptCount >= BOT_MESSAGE_AUTO_DELETE_MAX_EXTERNAL_ATTEMPTS;
    if (retryLimitReached) {
      const retryLimitOutcome = await this.enforceBotMessageAutoDeleteRetryLimit(
        intent,
        leaseToken,
        false,
      );
      if (retryLimitOutcome.kind === 'terminal') {
        return this.toAttemptResult(retryLimitOutcome.intent);
      }
      if (retryLimitOutcome.kind === 'lease_lost') {
        return this.toAttemptResult(await this.loadRequiredIntent(intent.id));
      }
      intent = retryLimitOutcome.intent;
    }

    const persistRetry = async (
      currentIntent: IntentRow,
      executor: Pick<Prisma.TransactionClient, '$executeRaw'>,
      allowSlowVerification = false,
    ): Promise<number> => {
      const now = Date.now();
      // FLAG: Acknowledged cleanup still needs exact absence proof. An expired auto-delete-only
      // obligation retains its markers and polls no sooner than hourly, preserving longer hints.
      const expiredAutoDeleteVerification =
        allowSlowVerification && this.isExpiredAutoDeleteVerification(currentIntent, now);
      const requestedNextAt = new Date(
        now +
          Math.max(
            1_000,
            details.retryDelayMs ?? 1_000,
            expiredAutoDeleteVerification
              ? BOT_MESSAGE_AUTO_DELETE_EXPIRED_VERIFICATION_RETRY_MS
              : 0,
          ),
      );
      const hasRemoteSuccessMarker = this.hasRemoteSuccessMarker(currentIntent);
      const hasUnresolvedDispatch = this.hasDeleteDispatchMarker(currentIntent);
      const hasDefinitiveFollowupPending = hasRemoteSuccessMarker || hasUnresolvedDispatch;
      const waitingForCapability =
        !hasDefinitiveFollowupPending && details.status === 'WAITING_CAPABILITY';
      const expires =
        !hasDefinitiveFollowupPending &&
        (details.status === 'EXPIRED' ||
          (!waitingForCapability && requestedNextAt >= currentIntent.retryUntilAt));
      const terminal = !hasDefinitiveFollowupPending && details.status === 'FAILED_TERMINAL';
      const status: ModerationDeleteIntentStatus = hasDefinitiveFollowupPending
        ? 'AMBIGUOUS'
        : expires
          ? 'EXPIRED'
          : details.status;
      const nextAttemptAt = expires ? currentIntent.retryUntilAt : requestedNextAt;

      return executor.$executeRaw(Prisma.sql`
        UPDATE "moderation_delete_intents"
        SET
          "status" = CAST(${status} AS "ModerationDeleteIntentStatus"),
          "next_attempt_at" = CASE
            WHEN ${waitingForCapability}
            THEN CASE
              WHEN "next_attempt_at" > "last_attempt_at"
                AND "retry_until_at" > CURRENT_TIMESTAMP
              THEN CURRENT_TIMESTAMP
              ELSE LEAST(${requestedNextAt}, "retry_until_at")
            END
            ELSE ${nextAttemptAt}
          END,
          "last_status_code" = ${details.statusCode},
          "last_error_code" = ${details.errorCode},
          "last_error" = ${details.message.slice(0, 2_000)},
          "completed_at" = ${expires || terminal ? new Date() : null},
          "lease_token" = NULL,
          "lease_expires_at" = NULL,
          "leased_from_status" = NULL,
          "updated_at" = CURRENT_TIMESTAMP
        WHERE "id" = ${currentIntent.id}
          AND "status" = CAST('IN_PROGRESS' AS "ModerationDeleteIntentStatus")
          AND "lease_token" = ${leaseToken}
          AND (${!requireInitialUnattempted} OR (
            (${requireInitialUnattempted !== true} OR "attempt_count" = 1)
            AND "lease_expires_at" > (clock_timestamp() AT TIME ZONE 'UTC')
            AND "delete_dispatch_started_at" IS NULL
            AND "delete_dispatch_started_bot_id" IS NULL
            AND "remote_delete_succeeded_at" IS NULL
            AND "remote_delete_succeeded_bot_id" IS NULL
          ))
      `);
    };
    const changed = this.isExpiredAutoDeleteVerification(intent, Date.now())
      ? await this.prisma.$transaction(
          async (tx) => {
            // FLAG: A concurrent reason writer locks this parent before inserting its reason.
            // Lock first, then classify in a fresh READ COMMITTED statement; the loaded snapshot
            // cannot postpone an independent obligation behind historical cleanup verification.
            const locked = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
              SELECT "id" FROM "moderation_delete_intents"
              WHERE "id" = ${intent.id}
                AND "status" = CAST('IN_PROGRESS' AS "ModerationDeleteIntentStatus")
                AND "lease_token" = ${leaseToken}
              FOR UPDATE
            `);
            if (!locked[0]) return 0;
            const latestRows = await tx.$queryRaw<IntentRow[]>(Prisma.sql`
              SELECT ${this.intentSelectSql('intent')}
              FROM "moderation_delete_intents" intent
              WHERE intent."id" = ${intent.id}
              LIMIT 1
            `);
            return latestRows[0] ? persistRetry(latestRows[0], tx, true) : 0;
          },
          { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
        )
      : details.certifiedCapabilityLoss &&
          details.status === 'WAITING_CAPABILITY' &&
          !this.hasDeleteMutationEvidence(intent)
        ? await this.prisma.$transaction(async (tx) => {
            const updated = await persistRetry(intent, tx);
            if (updated === 1)
              await this.persistStopWordsGuardDiagnostic(
                tx,
                intent.id,
                'permission_changed',
                'CAPABILITY_DEFERRED',
                'all',
              );
            return updated;
          })
        : await persistRetry(intent, this.prisma);
    if (changed === 0) {
      if (requireInitialUnattempted === 'guarded') throw new ModerationDeleteIntentLeaseLostError();
      if (requireInitialUnattempted)
        throw new Error('Initial duplicate source deferral lost unattempted ownership');
      return this.toAttemptResult(await this.loadRequiredIntent(intent.id));
    }

    const current = await this.loadRequiredIntent(intent.id);
    if (!TERMINAL_STATUSES.has(current.status)) {
      await this.enqueueWakeup(current);
    }
    return this.toAttemptResult(current);
  }

  private async finishTerminalPreDispatchGuardRejection(
    intent: IntentRow,
    leaseToken: string,
    details: DeleteErrorDetails,
    guardError?: unknown,
  ): Promise<ModerationDeleteAttemptResult> {
    const current = await this.prisma.$transaction(
      async (tx) => {
        // FLAG: Lock first, then read reason classifiers in a new READ COMMITTED statement. If a
        // concurrent writer owns the row, this waits for its reason insert before terminalizing.
        const locked = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
          SELECT "id"
          FROM "moderation_delete_intents"
          WHERE "id" = ${intent.id}
            AND "status" = CAST('IN_PROGRESS' AS "ModerationDeleteIntentStatus")
            AND "lease_token" = ${leaseToken}
          FOR UPDATE
        `);
        if (!locked[0]) {
          return null;
        }

        const latestRows = await tx.$queryRaw<IntentRow[]>(Prisma.sql`
          SELECT ${this.intentSelectSql('intent')}
          FROM "moderation_delete_intents" intent
          WHERE intent."id" = ${intent.id}
          LIMIT 1
        `);
        const latest = latestRows[0];
        if (!latest) {
          return null;
        }

        const channelCleanupGuardRejected =
          details.errorCode === CHANNEL_AUTO_POST_CLEANUP_ENTITY_MISMATCH_ERROR_CODE ||
          details.errorCode === CHANNEL_AUTO_POST_CLEANUP_SENDER_REJECTED_ERROR_CODE;
        const nightModeCleanupGuardRejected =
          details.errorCode === NIGHT_MODE_CLOSE_NOTICE_CLEANUP_STALE_ERROR_CODE;
        // FLAG: A rejected complete reason set can retry only if a concurrent writer changed
        // that exact set. The next attempt must freshly authorize it before any DELETE.
        const independentReportReasons =
          guardError instanceof ReportRejectedError
            ? await tx.moderationDeleteIntentReason.findMany({
                where: { intentId: intent.id, ruleCode: { notIn: [...REPORT_GUARDED_RULES] } },
                select: { ruleCode: true, reasonKey: true, metadata: true },
              })
            : null;
        const guardedReasonSetChanged =
          guardError instanceof ModerationDeleteReasonsRejectedError ||
          guardError instanceof LinkHistoryDeleteGuardRejectedError
            ? typeof guardError.reasonFingerprint === 'string' &&
              guardError.reasonFingerprint !==
                (guardError instanceof LinkHistoryDeleteGuardRejectedError
                  ? fingerprintLinkDeleteReasons
                  : fingerprintGuardedDeleteReasons)(
                  await tx.moderationDeleteIntentReason.findMany({
                    where: { intentId: intent.id },
                    select: { ruleCode: true, reasonKey: true, score: true, metadata: true },
                    orderBy: { reasonKey: 'asc' },
                    take: 65,
                  }),
                )
            : null;
        const independentReasonExecutable =
          // FLAG: A sole retention reason is not independent moderation authority.
          // A concurrent normal writer atomically clears retention_owned before adding its reason.
          !(guardError instanceof MessageRetentionGuardError && latest.retentionOwned) &&
          (guardedReasonSetChanged !== null
            ? guardedReasonSetChanged
            : independentReportReasons !== null
              ? this.hasExecutableIndependentReportReason(latest.chatId, independentReportReasons)
              : !details.errorCode.startsWith('message_duplicate_') &&
                (details.errorCode.startsWith('commercial_text_')
                  ? (await tx.moderationDeleteIntentReason.findFirst({
                      where: {
                        intentId: intent.id,
                        ruleCode: { not: COMMERCIAL_TEXT_DELETE_RULE_CODE },
                      },
                      select: { id: true },
                    })) !== null ||
                    (guardError instanceof CommercialDeleteGuardRejectedError &&
                      typeof guardError.reasonFingerprint === 'string' &&
                      guardError.reasonFingerprint !==
                        fingerprintCommercialDeleteReasons(
                          await tx.moderationDeleteIntentReason.findMany({
                            where: { intentId: intent.id },
                            select: {
                              ruleCode: true,
                              reasonKey: true,
                              score: true,
                              metadata: true,
                            },
                            orderBy: { reasonKey: 'asc' },
                            take: COMMERCIAL_TEXT_MAX_INTENT_REASONS + 1,
                          }),
                        ))
                  : details.errorCode.startsWith('profanity_')
                    ? (await tx.moderationDeleteIntentReason.findFirst({
                        where: {
                          intentId: intent.id,
                          ruleCode: { not: PROFANITY_DELETE_RULE_CODE },
                        },
                        select: { id: true },
                      })) !== null
                    : channelCleanupGuardRejected
                      ? this.hasExecutableReasonIgnoringChannelAutoPostCleanup(latest)
                      : nightModeCleanupGuardRejected
                        ? latest.nightModeCloseNoticeCleanupReason === true &&
                          latest.nightModeCloseNoticeCleanupOnly !== true
                        : details.errorCode === 'photo_duplicate_legacy_evidence_retired'
                          ? latest.photoDuplicateDeleteOnly !== true &&
                            this.hasExecutableNonCommercialOcrReason(latest)
                          : this.hasExecutableNonCommercialOcrReason(latest)));
        const now = Date.now();
        // A fresh independent reason does not inherit the obsolete OCR guard failure or its
        // backoff. Requeue it immediately; the next attempt reloads the mixed durable classifiers.
        const requestedNextAt = independentReasonExecutable ? new Date(now) : new Date(now + 1_000);
        const hasDefinitiveFollowupPending =
          this.hasRemoteSuccessMarker(latest) || this.hasDeleteDispatchMarker(latest);
        const expires =
          independentReasonExecutable &&
          !hasDefinitiveFollowupPending &&
          requestedNextAt >= latest.retryUntilAt;
        const status: ModerationDeleteIntentStatus = hasDefinitiveFollowupPending
          ? 'AMBIGUOUS'
          : expires
            ? 'EXPIRED'
            : independentReasonExecutable
              ? 'RETRYABLE'
              : 'FAILED_TERMINAL';
        const nextAttemptAt = expires ? latest.retryUntilAt : requestedNextAt;
        const terminal = status === 'EXPIRED' || status === 'FAILED_TERMINAL';

        const changed = await tx.$executeRaw(Prisma.sql`
          UPDATE "moderation_delete_intents"
          SET
            "status" = CAST(${status} AS "ModerationDeleteIntentStatus"),
            "next_attempt_at" = ${nextAttemptAt},
            "last_status_code" = ${details.statusCode},
            "last_error_code" = ${details.errorCode},
            "last_error" = ${details.message.slice(0, 2_000)},
            "completed_at" = ${terminal ? new Date() : null},
            "lease_token" = NULL,
            "lease_expires_at" = NULL,
            "leased_from_status" = NULL,
            "updated_at" = CURRENT_TIMESTAMP
          WHERE "id" = ${intent.id}
            AND "status" = CAST('IN_PROGRESS' AS "ModerationDeleteIntentStatus")
            AND "lease_token" = ${leaseToken}
        `);
        if (changed === 0) {
          return null;
        }

        const stopWordsRejectionReason = this.readStopWordsGuardRejection(guardError);
        if (status === 'FAILED_TERMINAL' && stopWordsRejectionReason) {
          // FLAG: Diagnostic NONE events share the owned terminal transition transaction.
          // Retried/concurrently changed reasons and uncertain effects never become rejections.
          await this.persistStopWordsGuardDiagnostic(
            tx,
            latest.id,
            stopWordsRejectionReason,
            'GUARD_REJECTED',
            guardError instanceof ImageTextStopListDeleteIntentGuardRejectedError ? 'ocr' : 'text',
          );
        }

        return {
          ...latest,
          status,
          nextAttemptAt,
          lastStatusCode: details.statusCode,
          lastErrorCode: details.errorCode,
          lastError: details.message.slice(0, 2_000),
          leaseToken: null,
          leaseExpiresAt: null,
          leasedFromStatus: null,
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
    );

    const resolved = current ?? (await this.loadRequiredIntent(intent.id));
    if (!TERMINAL_STATUSES.has(resolved.status)) {
      await this.enqueueWakeup(resolved);
    }
    return this.toAttemptResult(resolved);
  }

  private async persistStopWordsGuardDiagnostic(
    tx: Pick<Prisma.TransactionClient, '$executeRaw'>,
    intentId: string,
    rejectionReason: StopWordsGuardRejectionReason,
    event: 'GUARD_REJECTED' | 'CAPABILITY_DEFERRED',
    scope: 'text' | 'ocr' | 'all',
  ): Promise<void> {
    // FLAG: This collector-only event is not a violation, sanction or success receipt.
    // Read one owned intent and at most 65 reasons through the existing keyset index.
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "moderation_events" (
        "id", "chat_id", "bot_id", "user_id", "message_id", "event_type",
        "rule_code", "action", "metadata", "created_at"
      )
      SELECT DISTINCT
        'swgr-' || intent."id" || '-' || intent."attempt_count"::text || '-' || diagnostic."ruleCode",
        intent."chat_id", intent."last_bot_id", diagnostic."userId", intent."message_id",
        CAST('MESSAGE' AS "EventType"), diagnostic."ruleCode", CAST('NONE' AS "SanctionAction"),
        jsonb_build_object('stopWordsRejectionReason', CAST(${rejectionReason} AS text)),
        CURRENT_TIMESTAMP
      FROM "moderation_delete_intents" intent
      CROSS JOIN LATERAL (
        SELECT
          CASE
            WHEN reason."rule_code" = 'MESSAGE_BLOCKED_WORD_DELETE' THEN 'STOP_WORD_' || ${event}
            WHEN reason."rule_code" = 'MESSAGE_BLOCKED_DOMAIN_DELETE' THEN 'STOP_DOMAIN_' || ${event}
            ELSE 'STOP_OCR_' || ${event}
          END AS "ruleCode",
          COALESCE(intent."subject_user_id", reason."user_id") AS "userId"
        FROM (
          SELECT "rule_code", "metadata", "user_id"
          FROM "moderation_delete_intent_reasons"
          WHERE "intent_id" = intent."id"
          ORDER BY "reason_key" ASC
          LIMIT 65
        ) reason
        WHERE (
          ${scope !== 'text'}
          AND reason."rule_code" = ${COMMERCIAL_OCR_DELETE_RULE_CODE}
          AND reason."metadata"->>'source' = 'image_text_ocr'
        ) OR (
          ${scope !== 'ocr'}
          AND reason."rule_code" IN ('MESSAGE_BLOCKED_WORD_DELETE', 'MESSAGE_BLOCKED_DOMAIN_DELETE')
        )
      ) diagnostic
      WHERE intent."id" = ${intentId}
        AND intent."status" = CAST(${event === 'GUARD_REJECTED' ? 'FAILED_TERMINAL' : 'WAITING_CAPABILITY'} AS "ModerationDeleteIntentStatus")
        AND intent."delete_dispatch_started_at" IS NULL
        AND intent."delete_dispatch_started_bot_id" IS NULL
        AND intent."remote_delete_succeeded_at" IS NULL
        AND intent."remote_delete_succeeded_bot_id" IS NULL
        AND diagnostic."userId" IS NOT NULL
      ON CONFLICT ("id") DO NOTHING
    `);
  }

  private async recordRemoteSuccessAndFinalize(
    intent: IntentRow,
    leaseToken: string,
    botId: string,
    profanityVerified = false,
    commercialVerifiedReasonKeys: string[] = [],
    verifiedReasonKeys: string[] = [],
  ): Promise<ModerationDeleteAttemptResult> {
    if (this.isBotMessageAutoDeleteOnlyReason(intent)) {
      return this.recordRemoteSuccessPendingVerification(intent, leaseToken, botId);
    }

    let marked: boolean;
    try {
      marked = await this.recordRemoteDeleteSucceeded(
        intent.id,
        leaseToken,
        botId,
        commercialVerifiedReasonKeys,
        verifiedReasonKeys,
      );
    } catch (error: unknown) {
      return this.persistRemoteSuccessFallback(
        intent,
        leaseToken,
        botId,
        error,
        commercialVerifiedReasonKeys,
        verifiedReasonKeys,
      );
    }
    if (!marked) {
      return this.toAttemptResult(await this.loadRequiredIntent(intent.id));
    }
    return this.finalizeRecordedRemoteSuccess(
      {
        ...intent,
        lastBotId: botId,
        remoteDeleteSucceededAt: new Date(),
        remoteDeleteSucceededBotId: botId,
      },
      leaseToken,
      botId,
      profanityVerified,
      commercialVerifiedReasonKeys,
    );
  }

  private async recordRemoteSuccessPendingVerification(
    intent: IntentRow,
    leaseToken: string,
    botId: string,
  ): Promise<ModerationDeleteAttemptResult> {
    const nextAttemptAt = new Date(Date.now() + this.retryDelayMs(intent.attemptCount));
    const changed = await this.prisma.$executeRaw(Prisma.sql`
      UPDATE "moderation_delete_intents"
      SET
        "status" = CAST('AMBIGUOUS' AS "ModerationDeleteIntentStatus"),
        "next_attempt_at" = ${nextAttemptAt},
        "last_bot_id" = ${botId},
        "delete_dispatch_started_at" = NULL,
        "delete_dispatch_started_bot_id" = NULL,
        "remote_delete_succeeded_at" = COALESCE(
          "remote_delete_succeeded_at",
          CURRENT_TIMESTAMP
        ),
        "remote_delete_succeeded_bot_id" = COALESCE(
          "remote_delete_succeeded_bot_id",
          ${botId}
        ),
        "last_status_code" = NULL,
        "last_error_code" = ${BOT_MESSAGE_AUTO_DELETE_SUCCESS_VERIFICATION_PENDING_ERROR_CODE},
        "last_error" = 'MAX acknowledged DELETE; exact absence verification is pending',
        "completed_at" = NULL,
        "absence_verified_at" = NULL,
        "absence_verified_bot_id" = NULL,
        "absence_verification_code" = NULL,
        "lease_token" = NULL,
        "lease_expires_at" = NULL,
        "leased_from_status" = NULL,
        "updated_at" = CURRENT_TIMESTAMP
      WHERE "id" = ${intent.id}
        AND "status" = CAST('IN_PROGRESS' AS "ModerationDeleteIntentStatus")
        AND "lease_token" = ${leaseToken}
    `);
    if (changed === 0) {
      return this.toAttemptResult(await this.loadRequiredIntent(intent.id));
    }

    const current = await this.loadRequiredIntent(intent.id);
    await this.enqueueWakeup(current);
    return this.toAttemptResult(current);
  }

  private async finalizeRecordedRemoteSuccess(
    intent: IntentRow,
    leaseToken: string,
    botId: string,
    profanityVerified = false,
    commercialVerifiedReasonKeys: string[] = [],
  ): Promise<ModerationDeleteAttemptResult> {
    try {
      const completed = await this.completeSucceeded(
        intent.id,
        leaseToken,
        botId,
        null,
        profanityVerified,
        commercialVerifiedReasonKeys,
      );
      return this.toAttemptResult(completed);
    } catch (error: unknown) {
      return this.finishPersistenceFailure(
        intent,
        leaseToken,
        'remote_success_finalize_failed',
        error,
      );
    }
  }

  private async persistCommercialReviewReceipt(
    tx: Pick<Prisma.TransactionClient, '$executeRaw'>,
    intentId: string,
    verifiedReasonKeys: readonly string[],
  ): Promise<void> {
    if (!verifiedReasonKeys.length) return;
    // FLAG: These keys are proof from this dispatch's fresh guard, not candidate metadata.
    // Commit attribution with the remote success marker so receipt-first recovery retains it.
    await tx.$executeRaw(Prisma.sql`
      UPDATE "moderation_delete_intent_reasons" reason
      SET "metadata" = jsonb_set(COALESCE(reason."metadata", '{}'::jsonb), '{commercialReviewReceipt}',
        jsonb_build_object('schemaVersion', 1, 'outcome', 'CONFIRMED_DELETE',
          'evidenceHash', reason."metadata"->'commercialReviewBinding'->>'evidenceHash',
          'botId', intent."remote_delete_succeeded_bot_id")),
        "updated_at" = CURRENT_TIMESTAMP
      FROM "moderation_delete_intents" intent
      WHERE reason."intent_id" = ${intentId}
        AND intent."id" = reason."intent_id"
        AND intent."remote_delete_succeeded_at" IS NOT NULL
        AND intent."remote_delete_succeeded_bot_id" IS NOT NULL
        AND reason."rule_code" = ${COMMERCIAL_TEXT_DELETE_RULE_CODE}
        AND reason."reason_key" IN (${Prisma.join(verifiedReasonKeys)})
        AND reason."metadata"->'commercialReviewBinding'->>'schemaVersion' = '1'
        AND reason."metadata"->'commercialReviewBinding'->>'source' = 'TEXT'
        AND reason."metadata"->'commercialReviewBinding'->>'evidenceHash' ~ '^[a-f0-9]{64}$'
    `);
  }

  private async enrichCommercialReviewReceipts(
    tx: Prisma.TransactionClient,
    intentId: string,
  ): Promise<void> {
    if (!this.commercialReview) return;
    const receipts = await tx.$queryRaw<
      Array<{
        ruleCode: string;
        metadata: unknown;
        chatId: string;
        messageId: string;
        botId: string;
      }>
    >(Prisma.sql`
      WITH bounded_reasons AS MATERIALIZED (
        SELECT "rule_code", "metadata", "reason_key"
        FROM "moderation_delete_intent_reasons"
        WHERE "intent_id" = ${intentId}
        ORDER BY "reason_key" ASC
        LIMIT ${COMMERCIAL_TEXT_MAX_INTENT_REASONS + 1}
      )
      SELECT reason."rule_code" AS "ruleCode", reason."metadata", intent."chat_id" AS "chatId", intent."message_id" AS "messageId",
        intent."remote_delete_succeeded_bot_id" AS "botId"
      FROM bounded_reasons reason
      JOIN "moderation_delete_intents" intent ON intent."id" = ${intentId}
      WHERE
        intent."status" = CAST('SUCCEEDED' AS "ModerationDeleteIntentStatus")
        AND intent."remote_delete_succeeded_at" IS NOT NULL
        AND intent."remote_delete_succeeded_bot_id" IS NOT NULL
      ORDER BY reason."reason_key" ASC
    `);
    if (receipts.length > COMMERCIAL_TEXT_MAX_INTENT_REASONS) {
      this.logger.warn(
        { stage: 'commercial-review-receipt', outcome: 'reason_cap_exceeded' },
        'Commercial receipt observation omitted: reason cap exceeded',
      );
      return;
    }
    for (const row of receipts) {
      if (
        row.ruleCode !== COMMERCIAL_TEXT_DELETE_RULE_CODE ||
        !this.asRecord(row.metadata)?.commercialReviewReceipt
      )
        continue;
      const binding = readCommercialReviewExecutionBinding(row.metadata);
      const policyBinding = readCommercialTextDeleteBinding(
        this.asRecord(row.metadata)?.commercialTextBinding,
      );
      const receipt = this.asRecord(this.asRecord(row.metadata)?.commercialReviewReceipt);
      if (
        !binding ||
        !policyBinding ||
        policyBinding.decisionVersion !== binding.detectorVersion ||
        policyBinding.detectorSourceSha256 !== binding.detectorSourceSha256 ||
        receipt?.schemaVersion !== 1 ||
        receipt.outcome !== 'CONFIRMED_DELETE' ||
        receipt.evidenceHash !== binding.evidenceHash ||
        receipt.botId !== row.botId
      ) {
        this.logger.warn(
          { stage: 'commercial-review-receipt', outcome: 'binding_unavailable' },
          'Commercial receipt observation binding unavailable',
        );
        continue;
      }
      await this.commercialReview.recordExecution(
        {
          chatId: row.chatId,
          messageId: row.messageId,
          binding,
          executionOutcome: 'CONFIRMED_DELETE',
        },
        tx,
      );
    }
  }

  private async recordRemoteDeleteSucceeded(
    intentId: string,
    leaseToken: string,
    botId: string,
    commercialVerifiedReasonKeys: string[] = [],
    verifiedReasonKeys: string[] = [],
  ): Promise<boolean> {
    const write = async (tx: Pick<Prisma.TransactionClient, '$executeRaw'>) => {
      const changed = await tx.$executeRaw(Prisma.sql`
      UPDATE "moderation_delete_intents"
      SET
        "last_bot_id" = ${botId},
        "delete_dispatch_started_at" = NULL,
        "delete_dispatch_started_bot_id" = NULL,
        "remote_delete_succeeded_at" = COALESCE(
          "remote_delete_succeeded_at",
          CURRENT_TIMESTAMP
        ),
        "remote_delete_succeeded_bot_id" = COALESCE(
          "remote_delete_succeeded_bot_id",
          ${botId}
        ),
        "updated_at" = CURRENT_TIMESTAMP
      WHERE "id" = ${intentId}
        AND "status" = CAST('IN_PROGRESS' AS "ModerationDeleteIntentStatus")
        AND "lease_token" = ${leaseToken}
    `);
      if (changed > 0) {
        await this.persistVerifiedReasonReceipt(tx, intentId, verifiedReasonKeys);
        await this.persistCommercialReviewReceipt(tx, intentId, commercialVerifiedReasonKeys);
      }
      return changed > 0;
    };
    return commercialVerifiedReasonKeys.length || verifiedReasonKeys.length
      ? this.prisma.$transaction(write)
      : write(this.prisma);
  }

  private async persistRemoteSuccessFallback(
    intent: IntentRow,
    leaseToken: string,
    botId: string,
    error: unknown,
    commercialVerifiedReasonKeys: string[] = [],
    verifiedReasonKeys: string[] = [],
  ): Promise<ModerationDeleteAttemptResult> {
    const nextAttemptAt = new Date(Date.now() + this.retryDelayMs(intent.attemptCount));
    const details = this.describeError(error, 'remote_success_marker_persist_failed');
    const write = async (tx: Pick<Prisma.TransactionClient, '$executeRaw'>) => {
      const changed = await tx.$executeRaw(Prisma.sql`
      UPDATE "moderation_delete_intents"
      SET
        "status" = CAST('AMBIGUOUS' AS "ModerationDeleteIntentStatus"),
        "next_attempt_at" = ${nextAttemptAt},
        "last_bot_id" = ${botId},
        "delete_dispatch_started_at" = NULL,
        "delete_dispatch_started_bot_id" = NULL,
        "remote_delete_succeeded_at" = COALESCE(
          "remote_delete_succeeded_at",
          CURRENT_TIMESTAMP
        ),
        "remote_delete_succeeded_bot_id" = COALESCE(
          "remote_delete_succeeded_bot_id",
          ${botId}
        ),
        "last_status_code" = ${details.statusCode},
        "last_error_code" = 'remote_success_marker_persist_failed',
        "last_error" = ${details.message.slice(0, 2_000)},
        "lease_token" = NULL,
        "lease_expires_at" = NULL,
        "leased_from_status" = NULL,
        "updated_at" = CURRENT_TIMESTAMP
      WHERE "id" = ${intent.id}
        AND "status" = CAST('IN_PROGRESS' AS "ModerationDeleteIntentStatus")
        AND "lease_token" = ${leaseToken}
    `);
      if (changed > 0) {
        await this.persistVerifiedReasonReceipt(tx, intent.id, verifiedReasonKeys);
        await this.persistCommercialReviewReceipt(tx, intent.id, commercialVerifiedReasonKeys);
      }
      return changed;
    };
    const changed =
      commercialVerifiedReasonKeys.length || verifiedReasonKeys.length
        ? await this.prisma.$transaction(write)
        : await write(this.prisma);
    if (changed === 0) {
      return this.toAttemptResult(await this.loadRequiredIntent(intent.id));
    }
    return this.toAttemptResult(await this.loadRequiredIntent(intent.id));
  }

  private async finishPersistenceFailure(
    intent: IntentRow,
    leaseToken: string,
    errorCode: string,
    error: unknown,
  ): Promise<ModerationDeleteAttemptResult> {
    const details = this.describeError(error, errorCode);
    return this.finishRetryableAttempt(intent, leaseToken, {
      ...details,
      status: 'AMBIGUOUS',
      errorCode,
      retryDelayMs: this.retryDelayMs(intent.attemptCount),
    });
  }

  private async completeSucceeded(
    intentId: string,
    leaseToken: string,
    botId: string,
    absenceVerificationCode: 'post_success_exact_absence' | null = null,
    profanityVerified = false,
    commercialVerifiedReasonKeys: string[] = [],
  ): Promise<IntentRow> {
    const absenceVerifiedAt = absenceVerificationCode ? new Date() : null;
    await this.prisma.$transaction(async (tx) => {
      const changed = await tx.$executeRaw(Prisma.sql`
        UPDATE "moderation_delete_intents"
        SET
          "status" = CAST('SUCCEEDED' AS "ModerationDeleteIntentStatus"),
          "last_bot_id" = ${botId},
          "succeeded_bot_id" = COALESCE("remote_delete_succeeded_bot_id", ${botId}),
          "last_status_code" = NULL,
          "last_error_code" = NULL,
          "last_error" = NULL,
          "delete_dispatch_started_at" = NULL,
          "delete_dispatch_started_bot_id" = NULL,
          "absence_verified_at" = COALESCE(${absenceVerifiedAt}, "absence_verified_at"),
          "absence_verified_bot_id" = COALESCE(${absenceVerificationCode ? botId : null}, "absence_verified_bot_id"),
          "absence_verification_code" = COALESCE(${absenceVerificationCode}, "absence_verification_code"),
          "completed_at" = CURRENT_TIMESTAMP,
          "lease_token" = NULL,
          "lease_expires_at" = NULL,
          "leased_from_status" = NULL,
          "updated_at" = CURRENT_TIMESTAMP
        WHERE "id" = ${intentId}
          AND "status" = CAST('IN_PROGRESS' AS "ModerationDeleteIntentStatus")
          AND "lease_token" = ${leaseToken}
          AND "remote_delete_succeeded_at" IS NOT NULL
          AND "remote_delete_succeeded_bot_id" IS NOT NULL
      `);
      if (changed === 0) {
        return;
      }

      await this.enrichCommercialReviewReceipts(tx, intentId);

      await this.materializeModerationEventsForIntent(
        tx,
        intentId,
        profanityVerified,
        commercialVerifiedReasonKeys,
      );
      await activateOwnedRuleFollowups(tx, intentId);
    });
    const completed = await this.loadRequiredIntent(intentId);
    if (completed.status === 'SUCCEEDED') {
      await this.markReplacementCleanupConfirmed(completed);
    }
    return completed;
  }

  private async persistVerifiedReasonReceipt(
    tx: Pick<Prisma.TransactionClient, '$executeRaw'>,
    intentId: string,
    reasonKeys: string[],
  ) {
    if (!reasonKeys.length) return;
    // FLAG: This internal receipt is written only in the same transaction as a confirmed
    // remote DELETE. Newly appended or rejected reasons never inherit another rule's success.
    await tx.$executeRaw(Prisma.sql`
      UPDATE "moderation_delete_intent_reasons"
      SET "metadata" = COALESCE("metadata", '{}'::jsonb) || jsonb_build_object('moderationDeleteVerified', true), "updated_at" = CURRENT_TIMESTAMP
      WHERE "intent_id" = ${intentId} AND "reason_key" IN (${Prisma.join(reasonKeys)})
    `);
  }

  private async materializeModerationEventsForIntent(
    tx: Prisma.TransactionClient,
    intentId: string,
    profanityVerified = false,
    commercialVerifiedReasonKeys: string[] = [],
  ): Promise<void> {
    // FLAG: A successful DELETE under another reason or a recovered success is not proof of
    // a text violation. Preserve historical events, never add unverified reason attribution.
    const commercialAttribution =
      commercialVerifiedReasonKeys.length > 0
        ? Prisma.sql`reason."reason_key" IN (${Prisma.join(commercialVerifiedReasonKeys)})`
        : Prisma.sql`FALSE`;
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "moderation_events" (
        "id", "chat_id", "bot_id", "user_id", "message_id", "event_type",
        "rule_code", "action", "masked_excerpt", "score", "operator", "metadata",
        "created_at"
      )
      SELECT
        'mdi-' || reason."id",
        intent."chat_id",
        COALESCE(intent."succeeded_bot_id", intent."last_bot_id"),
        COALESCE(reason."user_id", intent."subject_user_id"),
        intent."message_id",
        reason."event_type",
        reason."rule_code",
        CAST('DELETE_MESSAGE' AS "SanctionAction"),
        reason."masked_excerpt",
        reason."score",
        CAST('BOT' AS "Operator"),
        COALESCE(reason."metadata", '{}'::jsonb) || jsonb_build_object(
          'moderationDeleteIntentId', intent."id",
          'moderationDeleteReasonKey', reason."reason_key"
        ),
        CURRENT_TIMESTAMP
      FROM "moderation_delete_intent_reasons" reason
      JOIN "moderation_delete_intents" intent ON intent."id" = reason."intent_id"
      WHERE reason."intent_id" = ${intentId}
        AND intent."status" = CAST('SUCCEEDED' AS "ModerationDeleteIntentStatus")
        AND reason."moderation_event_id" IS NULL
        AND reason."event_type" IS NOT NULL
        AND COALESCE(reason."user_id", intent."subject_user_id") IS NOT NULL
        AND (reason."rule_code" NOT IN (${Prisma.join([...MESSAGE_LIMITS_GUARDED_RULES, ...STOP_WORDS_DELETE_RULE_CODES, ...MODERATION_STATE_DELETE_RULES, ...CLOSED_CHAT_DELETE_RULE_CODES, REQUIRED_SUBSCRIPTION_DELETE_RULE_CODE, COMMERCIAL_LLM_DELETE_RULE_CODE])}) OR reason."metadata"->'moderationDeleteVerified' = 'true'::jsonb)
        AND (${profanityVerified} OR reason."rule_code" <> ${PROFANITY_DELETE_RULE_CODE})
        AND (reason."rule_code" <> ${COMMERCIAL_TEXT_DELETE_RULE_CODE} OR ${commercialAttribution})
      ON CONFLICT ("id") DO NOTHING
    `);

    await tx.$executeRaw(Prisma.sql`
      UPDATE "moderation_delete_intent_reasons" reason
      SET
        "moderation_event_id" = 'mdi-' || reason."id",
        "updated_at" = CURRENT_TIMESTAMP
      FROM "moderation_delete_intents" intent
      WHERE reason."intent_id" = ${intentId}
        AND intent."id" = reason."intent_id"
        AND intent."status" = CAST('SUCCEEDED' AS "ModerationDeleteIntentStatus")
        AND reason."moderation_event_id" IS NULL
        AND reason."event_type" IS NOT NULL
        AND COALESCE(reason."user_id", intent."subject_user_id") IS NOT NULL
        AND (reason."rule_code" NOT IN (${Prisma.join([...MESSAGE_LIMITS_GUARDED_RULES, ...STOP_WORDS_DELETE_RULE_CODES, ...MODERATION_STATE_DELETE_RULES, ...CLOSED_CHAT_DELETE_RULE_CODES, REQUIRED_SUBSCRIPTION_DELETE_RULE_CODE, COMMERCIAL_LLM_DELETE_RULE_CODE])}) OR reason."metadata"->'moderationDeleteVerified' = 'true'::jsonb)
        AND (${profanityVerified} OR reason."rule_code" <> ${PROFANITY_DELETE_RULE_CODE})
        AND (reason."rule_code" <> ${COMMERCIAL_TEXT_DELETE_RULE_CODE} OR ${commercialAttribution})
    `);
  }

  private async recordAttemptBot(
    intentId: string,
    leaseToken: string,
    botId: string,
  ): Promise<boolean> {
    const changed = await this.prisma.$executeRaw(Prisma.sql`
      UPDATE "moderation_delete_intents"
      SET "last_bot_id" = ${botId}, "updated_at" = CURRENT_TIMESTAMP
      WHERE "id" = ${intentId}
        AND "status" = CAST('IN_PROGRESS' AS "ModerationDeleteIntentStatus")
        AND "lease_token" = ${leaseToken}
        AND "lease_expires_at" > CURRENT_TIMESTAMP
    `);
    return changed > 0;
  }

  private async markDeleteDispatchStarted(
    intentId: string,
    leaseToken: string,
    botId: string,
  ): Promise<boolean> {
    const changed = await this.prisma.$executeRaw(Prisma.sql`
      UPDATE "moderation_delete_intents"
      SET
        "delete_dispatch_started_at" = CURRENT_TIMESTAMP,
        "delete_dispatch_started_bot_id" = ${botId},
        "updated_at" = CURRENT_TIMESTAMP
      WHERE "id" = ${intentId}
        AND "status" = CAST('IN_PROGRESS' AS "ModerationDeleteIntentStatus")
        AND "lease_token" = ${leaseToken}
        AND "lease_expires_at" > CURRENT_TIMESTAMP
    `);
    return changed > 0;
  }

  private async clearDeleteDispatchStarted(
    intentId: string,
    leaseToken: string,
    botId: string,
  ): Promise<boolean> {
    const changed = await this.prisma.$executeRaw(Prisma.sql`
      UPDATE "moderation_delete_intents"
      SET
        "delete_dispatch_started_at" = NULL,
        "delete_dispatch_started_bot_id" = NULL,
        "updated_at" = CURRENT_TIMESTAMP
      WHERE "id" = ${intentId}
        AND "status" = CAST('IN_PROGRESS' AS "ModerationDeleteIntentStatus")
        AND "lease_token" = ${leaseToken}
        AND "lease_expires_at" > CURRENT_TIMESTAMP
        AND "delete_dispatch_started_at" IS NOT NULL
        AND "delete_dispatch_started_bot_id" = ${botId}
    `);
    return changed > 0;
  }

  private async clearBotMessageAutoDeleteMutationEvidence(
    intentId: string,
    leaseToken: string,
  ): Promise<boolean> {
    const changed = await this.prisma.$executeRaw(Prisma.sql`
      UPDATE "moderation_delete_intents"
      SET
        "delete_dispatch_started_at" = NULL,
        "delete_dispatch_started_bot_id" = NULL,
        "remote_delete_succeeded_at" = NULL,
        "remote_delete_succeeded_bot_id" = NULL,
        "last_status_code" = NULL,
        "last_error_code" = ${BOT_MESSAGE_AUTO_DELETE_SUCCESS_STILL_PRESENT_ERROR_CODE},
        "last_error" = 'MAX still returns the exact message after acknowledging DELETE',
        "updated_at" = CURRENT_TIMESTAMP
      WHERE "id" = ${intentId}
        AND "status" = CAST('IN_PROGRESS' AS "ModerationDeleteIntentStatus")
        AND "lease_token" = ${leaseToken}
        AND "lease_expires_at" > CURRENT_TIMESTAMP
        AND (
          "delete_dispatch_started_at" IS NOT NULL
          OR "delete_dispatch_started_bot_id" IS NOT NULL
          OR "remote_delete_succeeded_at" IS NOT NULL
          OR "remote_delete_succeeded_bot_id" IS NOT NULL
        )
    `);
    return changed > 0;
  }

  private startLeaseHeartbeat(intentId: string, leaseToken: string): IntentLeaseHeartbeat {
    let stopped = false;
    let lost = false;
    let inFlight: Promise<boolean> | null = null;
    let inFlightMinimumRemainingMs = 0;
    let proofUntilMonotonicMs = 0;
    const renew = async (minimumRemainingMs = 0): Promise<boolean> => {
      if (stopped || lost) {
        return false;
      }
      if (inFlight) {
        if (minimumRemainingMs <= inFlightMinimumRemainingMs) return inFlight;
        if (!(await inFlight)) return false;
        return renew(minimumRemainingMs);
      }
      inFlightMinimumRemainingMs = minimumRemainingMs;
      inFlight = this.renewLease(intentId, leaseToken, minimumRemainingMs)
        .catch((error: unknown) => {
          this.storageRuntimeMetrics?.increment('deleteLeaseErrors');
          this.logger.warn(
            { intentId, err: this.errorMessage(error) },
            'Failed to renew moderation delete intent lease; outbound work is fenced',
          );
          return { owned: false, renewed: false, remainingBudgetMs: 0, proofUntilMonotonicMs: 0 };
        })
        .then((result) => {
          proofUntilMonotonicMs = result.proofUntilMonotonicMs;
          if (!result.owned) {
            lost = true;
          }
          return result.owned;
        })
        .finally(() => {
          inFlight = null;
        });
      return inFlight;
    };
    const intervalMs = Math.max(25, Math.floor(this.leaseMs / 3));
    const timer = setInterval(() => void renew(), intervalMs);
    timer.unref();
    return {
      renew,
      hasRemainingBudget: (minimumRemainingMs) =>
        !stopped && !lost && proofUntilMonotonicMs - performance.now() > minimumRemainingMs,
      stop: () => {
        stopped = true;
        clearInterval(timer);
      },
    };
  }

  private async renewLease(intentId: string, leaseToken: string, minimumRemainingMs = 0) {
    this.storageRuntimeMetrics?.increment('deleteLeaseChecks');
    const result = await checkOrRenewDeleteIntentLease(this.prisma, {
      intentId,
      leaseToken,
      leaseMs: this.leaseMs,
      minimumRemainingMs,
    });
    this.storageRuntimeMetrics?.increment(
      result.renewed ? 'deleteLeaseRenewals' : 'deleteLeaseReads',
    );
    if (!result.owned) this.storageRuntimeMetrics?.increment('deleteLeaseLost');
    return result;
  }

  private async assertLeaseForExternalCall(
    heartbeat: IntentLeaseHeartbeat,
    minimumRemainingMs = 0,
  ): Promise<void> {
    if (!(await heartbeat.renew(minimumRemainingMs))) {
      throw new ModerationDeleteIntentLeaseLostError();
    }
  }

  private async releasePausedLease(intentId: string, leaseToken: string): Promise<void> {
    await this.prisma.$executeRaw(Prisma.sql`
      UPDATE "moderation_delete_intents"
      SET
        "status" = COALESCE(
          "leased_from_status",
          CAST('PENDING' AS "ModerationDeleteIntentStatus")
        ),
        "lease_token" = NULL,
        "lease_expires_at" = NULL,
        "leased_from_status" = NULL,
        "updated_at" = CURRENT_TIMESTAMP
      WHERE "id" = ${intentId}
        AND "status" = CAST('IN_PROGRESS' AS "ModerationDeleteIntentStatus")
        AND "lease_token" = ${leaseToken}
    `);
  }

  private async expireDueIntents(): Promise<number> {
    return this.prisma.$executeRaw(Prisma.sql`
      WITH candidates AS (
        SELECT intent."id"
        FROM "moderation_delete_intents" intent
        WHERE intent."retry_until_at" <= CURRENT_TIMESTAMP
          AND (NOT EXISTS (SELECT 1 FROM "webhook_source_abandonments" held
            WHERE held."chat_id" = intent."chat_id" AND held."message_id" = intent."message_id") AND NOT EXISTS (SELECT 1 FROM "webhook_backlog_receipts" cancelled
            WHERE cancelled."chat_id" = intent."chat_id" AND cancelled."message_id" = intent."message_id"))
          AND intent."retention_owned" = FALSE
          AND intent."remote_delete_succeeded_at" IS NULL
          AND intent."remote_delete_succeeded_bot_id" IS NULL
          AND intent."delete_dispatch_started_at" IS NULL
          AND intent."delete_dispatch_started_bot_id" IS NULL
          AND intent."status" IN (
            CAST('PENDING' AS "ModerationDeleteIntentStatus"),
            CAST('RETRYABLE' AS "ModerationDeleteIntentStatus"),
            CAST('WAITING_CAPABILITY' AS "ModerationDeleteIntentStatus"),
            CAST('AMBIGUOUS' AS "ModerationDeleteIntentStatus"),
            CAST('IN_PROGRESS' AS "ModerationDeleteIntentStatus")
          )
          AND (
            intent."status" <> CAST('IN_PROGRESS' AS "ModerationDeleteIntentStatus")
            OR intent."lease_expires_at" IS NULL
            OR intent."lease_expires_at" <= CURRENT_TIMESTAMP
          )
        ORDER BY intent."retry_until_at" ASC, intent."created_at" ASC, intent."id" ASC
        LIMIT ${this.sweepBatchSize}
        FOR UPDATE SKIP LOCKED
      )
      UPDATE "moderation_delete_intents" intent
      SET
        "status" = CAST('EXPIRED' AS "ModerationDeleteIntentStatus"),
        "completed_at" = CURRENT_TIMESTAMP,
        "lease_token" = NULL,
        "lease_expires_at" = NULL,
        "leased_from_status" = NULL,
        "updated_at" = CURRENT_TIMESTAMP
      FROM candidates
      WHERE intent."id" = candidates."id"
    `);
  }

  private async expireIntentIfDue(intentId: string): Promise<void> {
    await this.prisma.$executeRaw(Prisma.sql`
      UPDATE "moderation_delete_intents"
      SET
        "status" = CAST('EXPIRED' AS "ModerationDeleteIntentStatus"),
        "completed_at" = CURRENT_TIMESTAMP,
        "lease_token" = NULL,
        "lease_expires_at" = NULL,
        "leased_from_status" = NULL,
        "updated_at" = CURRENT_TIMESTAMP
      WHERE "id" = ${intentId}
        AND "retry_until_at" <= CURRENT_TIMESTAMP
        AND (NOT EXISTS (SELECT 1 FROM "webhook_source_abandonments" held
          WHERE held."chat_id" = "moderation_delete_intents"."chat_id"
            AND held."message_id" = "moderation_delete_intents"."message_id") AND NOT EXISTS (SELECT 1 FROM "webhook_backlog_receipts" cancelled
          WHERE cancelled."chat_id" = "moderation_delete_intents"."chat_id"
            AND cancelled."message_id" = "moderation_delete_intents"."message_id"))
        AND "retention_owned" = FALSE
        AND "remote_delete_succeeded_at" IS NULL
        AND "remote_delete_succeeded_bot_id" IS NULL
        AND "delete_dispatch_started_at" IS NULL
        AND "delete_dispatch_started_bot_id" IS NULL
        AND "status" IN (
          CAST('PENDING' AS "ModerationDeleteIntentStatus"),
          CAST('RETRYABLE' AS "ModerationDeleteIntentStatus"),
          CAST('WAITING_CAPABILITY' AS "ModerationDeleteIntentStatus"),
          CAST('AMBIGUOUS' AS "ModerationDeleteIntentStatus")
        )
    `);
  }

  private async enqueueCurrentWakeup(
    intentId: string,
    priority = DELETE_QUEUE_PRIORITY_BACKGROUND,
  ): Promise<void> {
    const intent = await this.loadIntent(intentId);
    if (intent) {
      await this.enqueueWakeup(intent, priority);
    }
  }

  private async enqueueWakeup(
    intent: IntentRow,
    priority = DELETE_QUEUE_PRIORITY_BACKGROUND,
  ): Promise<void> {
    if (intent.retentionOwned || (await this.isAbandonedIntentWithoutReceipt(intent))) return;
    if (this.classifyIntentWakeupEligibility(intent) !== 'eligible') {
      return;
    }
    try {
      await this.enqueueIntentJob(
        intent.id,
        intent.reportHistoryOnly ? DELETE_QUEUE_PRIORITY_BACKGROUND : priority,
      );
    } catch (error: unknown) {
      this.logger.warn(
        { intentId: intent.id, err: this.errorMessage(error) },
        'Failed to enqueue moderation delete intent wakeup; DB sweeper will recover it',
      );
    }
  }

  private async isAbandonedIntentWithoutReceipt(intent: IntentRow): Promise<boolean> {
    return (
      !(intent.remoteDeleteSucceededAt && intent.remoteDeleteSucceededBotId) &&
      Boolean(await this.legacyHolds?.isSourceAbandoned?.(intent.chatId, intent.messageId))
    );
  }

  private classifyIntentWakeupEligibility(
    intent: IntentRow,
  ):
    | 'eligible'
    | 'settled_or_in_progress'
    | 'execution_disabled'
    | 'retry_window_exhausted'
    | 'not_due' {
    if (TERMINAL_STATUSES.has(intent.status) || intent.status === 'IN_PROGRESS') {
      return 'settled_or_in_progress';
    }
    if (!this.isExecutionEnabledForIntent(intent)) {
      return 'execution_disabled';
    }
    const wakeAtMs = Math.max(intent.executeAt.getTime(), intent.nextAttemptAt.getTime());
    if (
      !this.hasRemoteSuccessMarker(intent) &&
      !this.hasDeleteDispatchMarker(intent) &&
      wakeAtMs >= intent.retryUntilAt.getTime()
    ) {
      return 'retry_window_exhausted';
    }
    return wakeAtMs <= Date.now() ? 'eligible' : 'not_due';
  }

  private async enqueueIntentJob(
    intentId: string,
    priority = DELETE_QUEUE_PRIORITY_BACKGROUND,
  ): Promise<void> {
    const job = await this.queue.add(
      'execute-moderation-delete-intent',
      { intentId },
      {
        jobId: `mdi-${intentId}`,
        priority,
        attempts: 1,
        removeOnComplete: true,
        removeOnFail: true,
      },
    );
    if (
      job &&
      priority === DELETE_QUEUE_PRIORITY_INTERACTIVE &&
      job.opts.priority !== DELETE_QUEUE_PRIORITY_INTERACTIVE
    ) {
      try {
        await job.changePriority({ priority: DELETE_QUEUE_PRIORITY_INTERACTIVE });
      } catch (error: unknown) {
        this.logger.warn(
          { intentId, err: this.errorMessage(error) },
          'Failed to promote an existing moderation delete intent job priority',
        );
      }
    }
  }

  private async loadRequiredIntent(intentId: string): Promise<IntentRow> {
    const intent = await this.loadIntent(intentId);
    if (!intent) {
      throw new Error(`Moderation delete intent ${intentId} does not exist`);
    }
    return intent;
  }

  private async loadIntent(intentId: string): Promise<IntentRow | null> {
    const rows = await this.prisma.$queryRaw<IntentRow[]>(Prisma.sql`
      SELECT ${this.intentSelectSql('intent')}
      FROM "moderation_delete_intents" intent
      WHERE intent."id" = ${intentId}
      LIMIT 1
    `);
    return rows[0] ?? null;
  }

  private async finishProtectedManagedBotMessageAutoDelete(
    intent: IntentRow,
    leaseToken: string,
  ): Promise<IntentRow | null> {
    if (intent.botMessageAutoDeleteOnly !== true) {
      return null;
    }

    const owner = await this.findManagedBotMessageOwner(intent);
    if (!owner) {
      return null;
    }

    const lastError =
      `BOT_MESSAGE_AUTO_DELETE blocked because ${owner.kind} ${owner.id} owns ` +
      `message ${intent.messageId}`;
    const updated = await this.prisma.$executeRaw(Prisma.sql`
      UPDATE "moderation_delete_intents" guarded_intent
      SET
        "status" = CAST('FAILED_TERMINAL' AS "ModerationDeleteIntentStatus"),
        "last_status_code" = NULL,
        "last_error_code" = 'managed_output_auto_delete_blocked',
        "last_error" = ${lastError.slice(0, 2_000)},
        "delete_dispatch_started_at" = NULL,
        "delete_dispatch_started_bot_id" = NULL,
        "completed_at" = CURRENT_TIMESTAMP,
        "lease_token" = NULL,
        "lease_expires_at" = NULL,
        "leased_from_status" = NULL,
        "updated_at" = CURRENT_TIMESTAMP
      WHERE guarded_intent."id" = ${intent.id}
        AND guarded_intent."status" = CAST('IN_PROGRESS' AS "ModerationDeleteIntentStatus")
        AND guarded_intent."lease_token" = ${leaseToken}
        AND guarded_intent."remote_delete_succeeded_at" IS NULL
        AND guarded_intent."remote_delete_succeeded_bot_id" IS NULL
        AND EXISTS (
          SELECT 1
          FROM "moderation_delete_intent_reasons" guarded_reason
          WHERE guarded_reason."intent_id" = guarded_intent."id"
            AND guarded_reason."rule_code" = ${BOT_MESSAGE_AUTO_DELETE_RULE_CODE}
        )
        AND NOT EXISTS (
          SELECT 1
          FROM "moderation_delete_intent_reasons" other_reason
          WHERE other_reason."intent_id" = guarded_intent."id"
            AND other_reason."rule_code" NOT IN (
              ${BOT_MESSAGE_AUTO_DELETE_RULE_CODE},
              ${COMMERCIAL_OCR_DELETE_RULE_CODE}
            )
        )
    `);
    return updated > 0 ? this.loadRequiredIntent(intent.id) : null;
  }

  private async findManagedBotMessageOwner(
    intent: Pick<
      IntentRow,
      'chatId' | 'messageId' | 'sourceMessageAt' | 'entityType' | 'originBotId'
    >,
  ): Promise<ManagedBotMessageOwner | null> {
    const { chatId, messageId } = intent;
    const handshake = await findManagedHandshakeAutoDeleteOwner(this.prisma.maxActionLedgerEntry, {
      chatId,
      messageId,
      originBotId: intent.originBotId,
      sourceMessageAt: intent.sourceMessageAt,
      allowInFlight: true,
    });
    if (handshake) return handshake;

    const delivery = await this.prisma.managedBroadcastDelivery.findFirst({
      where: {
        targetChatId: chatId,
        remoteMessageId: messageId,
      },
      select: { id: true },
    });
    if (delivery) {
      return { id: delivery.id, kind: 'managed_publication' };
    }

    const originBotId = intent.originBotId?.trim() ?? '';
    const entityType = intent.entityType;
    if (originBotId && entityType) {
      // FLAG: Keep this final destructive-action fence exact-first, then cover the brief window
      // before a managed publication persists its remote message id. The exact-id recheck and
      // source-time bound close SENDING/SENT/AMBIGUOUS transitions without a generic stale fence.
      const sendFence = await this.prisma.managedBroadcastDelivery.findFirst({
        where: buildManagedPublicationAutoDeleteFenceWhere({
          targetChatId: chatId,
          messageId,
          originBotId,
          entityType,
          sourceMessageAt: intent.sourceMessageAt,
        }),
        select: {
          id: true,
          remoteMessageId: true,
        },
      });
      if (sendFence) {
        return {
          id: sendFence.id,
          kind:
            sendFence.remoteMessageId === messageId
              ? 'managed_publication'
              : 'managed_publication_in_flight',
        };
      }
    }

    const giveaway = await this.prisma.managedGiveaway.findFirst({
      where: {
        sourceChatId: chatId,
        OR: [{ publicationMessageId: messageId }, { resultsMessageId: messageId }],
      },
      select: {
        id: true,
        publicationMessageId: true,
        resultsMessageId: true,
      },
    });
    if (giveaway) {
      return {
        id: giveaway.id,
        kind:
          giveaway.publicationMessageId === messageId
            ? 'managed_giveaway_publication'
            : 'managed_giveaway_results',
      };
    }

    const vkPost = await this.prisma.vkParsingPost.findFirst({
      where: {
        chatId,
        publishedMessageId: messageId,
      },
      select: { id: true },
    });
    if (vkPost) {
      return { id: vkPost.id, kind: 'vk_parsing_post' };
    }

    const chatRules = await this.prisma.chatRules.findUnique({
      where: { chatId },
      select: { id: true, publishedMessageId: true },
    });
    if (chatRules?.publishedMessageId === messageId) {
      return { id: chatRules.id, kind: 'published_chat_rules' };
    }

    const chatAutoCommentReplacement = await this.prisma.chatAutoCommentAttachMarker.findFirst({
      where: {
        chatId,
        OR: [{ replacementMessageId: messageId }, { replyMessageId: messageId }],
      },
      select: { id: true, replacementMessageId: true, replyMessageId: true },
    });
    if (chatAutoCommentReplacement) {
      return {
        id: chatAutoCommentReplacement.id,
        kind:
          chatAutoCommentReplacement.replacementMessageId === messageId
            ? 'chat_auto_comment_replacement'
            : 'chat_auto_comment_reply',
      };
    }

    const transitionEvent = await this.prisma.moderationEvent.findFirst({
      where: {
        chatId,
        messageId,
        ruleCode: { in: [...NIGHT_MODE_TRANSITION_NOTICE_RULE_CODES] },
      },
      select: { id: true },
    });
    return transitionEvent
      ? { id: transitionEvent.id, kind: 'night_mode_transition_notice' }
      : null;
  }

  private async resolveDeleteRouteWithRefresh(
    intent: IntentRow,
    heartbeat: IntentLeaseHeartbeat,
    canRead?: () => Promise<boolean>,
  ): Promise<MaxDeleteMessageBotRoute> {
    let route = await this.maxBotLinkService.resolveDeleteMessageBotRoute({
      chatId: intent.chatId,
      existingMessage: intent.originBotId
        ? { messageId: intent.messageId, botId: intent.originBotId }
        : undefined,
      expectedEntityType: intent.entityType,
      requireFreshSnapshot: true,
    });
    if (this.filterAndOrderRouteCandidates(intent, route).length > 0) {
      return route;
    }

    const originRecoveryBotId =
      this.resolveEffectiveRoutingPolicy(intent) === 'origin_only'
        ? intent.originBotId?.trim() || null
        : null;
    if (
      originRecoveryBotId &&
      !route.candidateCapabilities.some((candidate) => candidate.botId === originRecoveryBotId) &&
      Boolean(this.maxBotLinkService.getExecutableBotById(originRecoveryBotId)) &&
      !this.isCandidateBackedOff(intent, originRecoveryBotId, null)
    ) {
      await this.refreshCandidateAccess(intent, originRecoveryBotId, heartbeat, canRead);
      route = await this.maxBotLinkService.resolveDeleteMessageBotRoute({
        chatId: intent.chatId,
        existingMessage: intent.originBotId
          ? { messageId: intent.messageId, botId: intent.originBotId }
          : undefined,
        expectedEntityType: intent.entityType,
        requireFreshSnapshot: true,
      });
      if (this.filterAndOrderRouteCandidates(intent, route).length > 0) {
        return route;
      }
    }

    const nowMs = Date.now();
    // FLAG: Fresh negative proofs observe the existing capability backoff. Rotate the
    // bounded probe window using the durable attempt count, so unknown responses and
    // process restarts cannot keep every later standby behind the same first four.
    const probePool = route.candidateCapabilities
      .filter(
        (candidate) =>
          (candidate.state === 'stale_or_unknown' || candidate.state === 'explicitly_incapable') &&
          candidate.reason !== 'bot_not_actionable' &&
          Boolean(this.maxBotLinkService.getExecutableBotById(candidate.botId)) &&
          this.isBotAllowedByRoutingPolicy(intent, candidate.botId),
      )
      .sort((left, right) => (left.botId < right.botId ? -1 : left.botId > right.botId ? 1 : 0));
    const probeLimit = 4;
    const probeOffset =
      ((Math.max(1, intent.attemptCount) - 1) * probeLimit) % Math.max(1, probePool.length);
    const probeCandidates = [...probePool.slice(probeOffset), ...probePool.slice(0, probeOffset)]
      .filter(
        (candidate) => !this.isCandidateBackedOff(intent, candidate.botId, candidate.checkedAt),
      )
      .filter((candidate) => {
        if (candidate.state !== 'explicitly_incapable') return true;
        const checkedAtMs = candidate.checkedAt ? Date.parse(candidate.checkedAt) : Number.NaN;
        return (
          !Number.isFinite(checkedAtMs) ||
          checkedAtMs > nowMs ||
          checkedAtMs + this.capabilityRetryMs <= nowMs
        );
      })
      .slice(0, probeLimit);
    for (const candidate of probeCandidates) {
      await this.refreshCandidateAccess(intent, candidate.botId, heartbeat, canRead);
    }
    if (probeCandidates.length > 0) {
      route = await this.maxBotLinkService.resolveDeleteMessageBotRoute({
        chatId: intent.chatId,
        existingMessage: intent.originBotId
          ? { messageId: intent.messageId, botId: intent.originBotId }
          : undefined,
        expectedEntityType: intent.entityType,
        requireFreshSnapshot: true,
      });
    }
    return route;
  }

  private async refreshCandidateAccess(
    intent: IntentRow,
    botId: string,
    heartbeat: IntentLeaseHeartbeat,
    canRead?: () => Promise<boolean>,
  ): Promise<'refreshed' | 'denied' | 'unknown'> {
    let accessProbeStartedAt: Date | null = null;
    let membershipLookupPending = false;
    try {
      await this.assertLeaseForExternalCall(heartbeat);
      if (canRead && !(await canRead())) return 'unknown';
      // FLAG: A persisted exact-bot denial already proves no execution authority.
      // Retain that epoch for peer continuation without spending another MAX probe.
      if (
        await this.maxBotLinkService.isChatBotExecutionActivationRequired?.(
          intent.chatId,
          botId,
          'delete_message',
        )
      )
        return 'denied';
      accessProbeStartedAt = new Date();
      membershipLookupPending = true;
      const access = await this.maxClient.getCurrentChatMemberAccess(intent.chatId, {
        botId,
        bypassCache: true,
        trafficClass: intent.retentionOwned ? 'background' : 'critical',
        actionHealthLane: intent.retentionOwned ? 'background' : 'critical',
        sourceTag: intent.retentionOwned
          ? MAX_API_SOURCE_TAGS.MESSAGE_RETENTION
          : MAX_API_SOURCE_TAGS.MODERATION_DELETE,
        timeoutMs: this.deleteTimeoutMs,
        ignoreFailureMetricStatuses: [403, 404],
      });
      membershipLookupPending = false;
      const persisted = await this.maxBotLinkService.recordBotAccessProbe({
        chatId: intent.chatId,
        botId,
        access,
        source: 'moderation_delete_intent_probe',
        checkedAt: accessProbeStartedAt,
        allowMembershipRecovery:
          this.resolveEffectiveRoutingPolicy(intent) === 'origin_only' &&
          intent.originBotId === botId,
      });
      return persisted ? 'refreshed' : 'unknown';
    } catch (error: unknown) {
      if (error instanceof MaxModerationApiBudgetError) throw error;
      if (error instanceof ModerationDeleteIntentLeaseLostError) {
        throw error;
      }
      if (membershipLookupPending && resolveExplicitMembershipAccessDenial(error) !== null) {
        if (!accessProbeStartedAt) {
          return 'unknown';
        }
        const persisted = await this.maxBotLinkService.recordBotAccessProbe({
          chatId: intent.chatId,
          botId,
          access: null,
          source: 'moderation_delete_intent_probe_denied',
          checkedAt: accessProbeStartedAt,
        });
        return persisted ? 'denied' : 'unknown';
      }
      return 'unknown';
    }
  }

  private async verifyMessageAbsence(
    intent: IntentRow,
    botId: string,
    heartbeat: IntentLeaseHeartbeat,
    canRead?: () => Promise<boolean>,
  ): Promise<'verified_absent' | 'message_present' | 'unknown'> {
    if ((await this.refreshCandidateAccess(intent, botId, heartbeat, canRead)) !== 'refreshed') {
      return 'unknown';
    }
    const route = await this.maxBotLinkService.resolveDeleteMessageBotRoute({
      chatId: intent.chatId,
      existingMessage: intent.originBotId
        ? { messageId: intent.messageId, botId: intent.originBotId }
        : undefined,
      expectedEntityType: intent.entityType,
      requireFreshSnapshot: true,
    });
    const exactCapability = route.candidateCapabilities.find(
      (candidate) => candidate.botId === botId && candidate.state === 'confirmed_capable',
    );
    if (!exactCapability) {
      return 'unknown';
    }

    try {
      const presence = await this.getExactMessagePresence(intent, botId, heartbeat, canRead);
      return presence === 'present' ? 'message_present' : 'verified_absent';
    } catch (error: unknown) {
      if (error instanceof MaxModerationApiBudgetError) throw error;
      if (error instanceof ModerationDeleteIntentLeaseLostError) {
        throw error;
      }
      return 'unknown';
    }
  }

  private async getExactMessagePresence(
    intent: IntentRow,
    botId: string,
    heartbeat: IntentLeaseHeartbeat,
    canRead?: () => Promise<boolean>,
  ): Promise<'present' | 'absent'> {
    await this.assertLeaseForExternalCall(heartbeat);
    // FLAG: Each recovery read rechecks the current kill switch and governor after lease renewal.
    if (canRead && !(await canRead()))
      throw new MessageRetentionGuardError(
        'retry',
        'Retention reconciliation paused',
        'runtime_disabled',
      );
    return this.maxClient.getExactMessagePresence(intent.chatId, intent.messageId, {
      botId,
      bypassCache: true,
      trafficClass: intent.retentionOwned ? 'background' : 'critical',
      actionHealthLane: intent.retentionOwned ? 'background' : 'critical',
      sourceTag: intent.retentionOwned
        ? MAX_API_SOURCE_TAGS.MESSAGE_RETENTION
        : MAX_API_SOURCE_TAGS.MODERATION_DELETE,
      timeoutMs: this.deleteTimeoutMs,
      ignoreFailureMetricStatuses: MODERATION_CHAT_ACTION_TERMINAL_FAILURE_METRIC_STATUSES,
    });
  }

  private async recordCandidateFailure(
    intentId: string,
    leaseToken: string,
    botId: string,
    attemptCount: number,
    details: DeleteErrorDetails,
  ): Promise<void> {
    const failedAt = new Date();
    const retryAt = new Date(
      failedAt.getTime() +
        Math.max(this.capabilityRetryDelayMs(attemptCount), details.retryDelayMs ?? 0),
    );
    await this.prisma.$executeRaw(Prisma.sql`
      UPDATE "moderation_delete_intents"
      SET
        "candidate_failures" = COALESCE("candidate_failures", '{}'::jsonb) ||
          jsonb_build_object(
            CAST(${botId} AS text),
            jsonb_build_object(
              'failedAt', CAST(${failedAt.toISOString()} AS text),
              'retryAt', CAST(${retryAt.toISOString()} AS text),
              'errorCode', CAST(${details.errorCode} AS text),
              'statusCode', CAST(${details.statusCode} AS integer)
            )
          ),
        "updated_at" = CURRENT_TIMESTAMP
      WHERE "id" = ${intentId}
        AND "status" = CAST('IN_PROGRESS' AS "ModerationDeleteIntentStatus")
        AND "lease_token" = ${leaseToken}
    `);
  }

  private async completeAlreadyAbsent(
    intentId: string,
    leaseToken: string,
    botId: string,
    verificationCode:
      | 'guarded_current_message_absence'
      | 'guarded_traffic_protection_absence'
      | 'guarded_report_absence'
      | 'guarded_stop_words_absence'
      | 'retry_predelete_exact_presence'
      | 'postdelete_exact_presence'
      | 'guarded_link_predispatch_exact_absence'
      | 'guarded_commercial_ocr_predispatch_exact_absence'
      | 'guarded_profanity_predispatch_exact_absence'
      | 'guarded_commercial_text_absence'
      | 'guarded_message_duplicate_absence'
      | 'guarded_image_text_stop_list_predispatch_exact_absence'
      | 'retention_reconciliation_absence',
  ): Promise<IntentRow> {
    await this.prisma.$executeRaw(Prisma.sql`
      UPDATE "moderation_delete_intents"
      SET
        "status" = CAST('ALREADY_ABSENT' AS "ModerationDeleteIntentStatus"),
        "last_bot_id" = ${botId},
        "last_status_code" = 404,
        "last_error_code" = 'verified_message_absent',
        "last_error" = NULL,
        "delete_dispatch_started_at" = NULL,
        "delete_dispatch_started_bot_id" = NULL,
        "completed_at" = CURRENT_TIMESTAMP,
        "absence_verified_at" = CURRENT_TIMESTAMP,
        "absence_verified_bot_id" = ${botId},
        "absence_verification_code" = ${verificationCode},
        "lease_token" = NULL,
        "lease_expires_at" = NULL,
        "leased_from_status" = NULL,
        "updated_at" = CURRENT_TIMESTAMP
      WHERE "id" = ${intentId}
        AND "status" = CAST('IN_PROGRESS' AS "ModerationDeleteIntentStatus")
        AND "lease_token" = ${leaseToken}
    `);
    const completed = await this.loadRequiredIntent(intentId);
    if (completed.status === 'ALREADY_ABSENT') {
      await this.markReplacementCleanupConfirmed(completed);
    }
    return completed;
  }

  private async markReplacementCleanupConfirmed(
    intent: Pick<IntentRow, 'id' | 'chatId' | 'messageId'>,
  ): Promise<void> {
    try {
      await this.prisma.$executeRaw(Prisma.sql`
        WITH channel_cleanup AS (
          UPDATE "channel_auto_post_attach_markers"
          SET
            "status" = CAST('SUCCEEDED' AS "ChannelAutoPostAttachStatus"),
            "lock_token" = NULL,
            "locked_at" = NULL,
            "original_deleted" = true,
            "cleanup_intent_id" = ${intent.id},
            "last_error" = NULL,
            "last_status_code" = NULL,
            "updated_at" = CURRENT_TIMESTAMP
          WHERE "chat_id" = ${intent.chatId}
            AND "message_id" = ${intent.messageId}
            AND "delivery_mode" = 'replace_with_bot_message'
            AND "replacement_message_id" IS NOT NULL
            AND "status" IN (
              CAST('IN_PROGRESS' AS "ChannelAutoPostAttachStatus"),
              CAST('SUCCEEDED' AS "ChannelAutoPostAttachStatus")
            )
          RETURNING "id"
        ),
        chat_cleanup AS (
          UPDATE "chat_auto_comment_attach_markers"
          SET
            "status" = CAST('SUCCEEDED' AS "ChatAutoCommentAttachStatus"),
            "lock_token" = NULL,
            "locked_at" = NULL,
            "original_deleted" = true,
            "cleanup_intent_id" = ${intent.id},
            "last_error" = NULL,
            "last_status_code" = NULL,
            "updated_at" = CURRENT_TIMESTAMP
          WHERE "chat_id" = ${intent.chatId}
            AND "message_id" = ${intent.messageId}
            AND "delivery_mode" = 'replace_with_bot_message'
            AND "replacement_message_id" IS NOT NULL
            AND "status" IN (
              CAST('IN_PROGRESS' AS "ChatAutoCommentAttachStatus"),
              CAST('SUCCEEDED' AS "ChatAutoCommentAttachStatus")
            )
          RETURNING "id"
        ),
        rules_cleanup AS (
          UPDATE "chat_rules"
          SET
            "published_message_id" = CASE
              WHEN "pending_cleanup_kind" = 'reset_current'
                AND "published_message_id" = ${intent.messageId}
              THEN NULL
              ELSE "published_message_id"
            END,
            "published_bot_id" = CASE
              WHEN "pending_cleanup_kind" = 'reset_current'
                AND "published_message_id" = ${intent.messageId}
              THEN NULL
              ELSE "published_bot_id"
            END,
            "published_url" = CASE
              WHEN "pending_cleanup_kind" = 'reset_current'
                AND "published_message_id" = ${intent.messageId}
              THEN NULL
              ELSE "published_url"
            END,
            "published_at" = CASE
              WHEN "pending_cleanup_kind" = 'reset_current'
                AND "published_message_id" = ${intent.messageId}
              THEN NULL
              ELSE "published_at"
            END,
            "pending_cleanup_message_id" = NULL,
            "pending_cleanup_bot_id" = NULL,
            "pending_cleanup_intent_id" = NULL,
            "pending_cleanup_kind" = NULL,
            "updated_at" = CURRENT_TIMESTAMP
          WHERE "chat_id" = ${intent.chatId}
            AND "pending_cleanup_message_id" = ${intent.messageId}
          RETURNING "id"
        )
        UPDATE "audit_logs"
        SET "payload" = jsonb_set(
          "payload",
          '{previousCleanupOutcome}',
          '"confirmed"'::jsonb,
          true
        ) - 'previousCleanupError'
        WHERE "chat_id" = ${intent.chatId}
          AND "action" = 'PUBLISH_CHAT_RULES'
          AND "payload"->>'previousPublishedMessageId' = ${intent.messageId}
      `);
    } catch (error: unknown) {
      this.logger.warn(
        { intentId: intent.id, err: this.errorMessage(error) },
        'Failed to synchronize confirmed replacement cleanup marker',
      );
    }
  }

  private async linkReplacementCleanupIntent(
    tx: Prisma.TransactionClient,
    input: { chatId: string; messageId: string; ruleCode: string },
    intentId: string,
  ): Promise<void> {
    switch (input.ruleCode) {
      case 'CHANNEL_AUTO_POST_FORWARD_REPLACEMENT_CLEANUP':
        await tx.$executeRaw(Prisma.sql`
          UPDATE "channel_auto_post_attach_markers"
          SET
            "cleanup_intent_id" = ${intentId},
            "updated_at" = CURRENT_TIMESTAMP
          WHERE "chat_id" = ${input.chatId}
            AND "message_id" = ${input.messageId}
            AND "delivery_mode" = 'replace_with_bot_message'
            AND "replacement_message_id" IS NOT NULL
            AND "original_deleted" = false
            AND "status" IN (
              CAST('IN_PROGRESS' AS "ChannelAutoPostAttachStatus"),
              CAST('SUCCEEDED' AS "ChannelAutoPostAttachStatus")
            )
        `);
        return;
      case 'CHAT_AUTO_COMMENT_ADMIN_MESSAGE_REPLACEMENT_CLEANUP':
        await tx.$executeRaw(Prisma.sql`
          UPDATE "chat_auto_comment_attach_markers"
          SET
            "cleanup_intent_id" = ${intentId},
            "updated_at" = CURRENT_TIMESTAMP
          WHERE "chat_id" = ${input.chatId}
            AND "message_id" = ${input.messageId}
            AND "delivery_mode" = 'replace_with_bot_message'
            AND "replacement_message_id" IS NOT NULL
            AND "original_deleted" = false
            AND "status" IN (
              CAST('IN_PROGRESS' AS "ChatAutoCommentAttachStatus"),
              CAST('SUCCEEDED' AS "ChatAutoCommentAttachStatus")
            )
        `);
        return;
      case 'CHAT_RULES_REPUBLISH_PREVIOUS_MESSAGE_CLEANUP':
        await tx.$executeRaw(Prisma.sql`
          UPDATE "chat_rules"
          SET
            "pending_cleanup_intent_id" = ${intentId},
            "updated_at" = CURRENT_TIMESTAMP
          WHERE "chat_id" = ${input.chatId}
            AND "pending_cleanup_message_id" = ${input.messageId}
        `);
        return;
      default:
        return;
    }
  }

  private buildSweepRolloutFilter(): Prisma.Sql {
    // FLAG: Keep EXISTS probes correlated to this intent. OFFSET 0 prevents PostgreSQL
    // from hashing whole reason inventories once per status despite the outer LIMIT.
    // It changes no eligibility condition and uses the existing intent/reason index.
    const baseFilter = this.buildBaseRolloutFilter(Prisma.sql`intent."chat_id"`);
    const commercialOcrFilter = this.buildCommercialOcrRolloutFilter(Prisma.sql`intent."chat_id"`);
    const imageTextStopListFilter =
      this.getImageTextStopListRollout() === 'execute'
        ? Prisma.sql`
          OR (
            EXISTS (
              SELECT 1
              FROM "moderation_delete_intent_reasons" image_text_reason
              WHERE image_text_reason."intent_id" = intent."id"
                AND image_text_reason."rule_code" = ${COMMERCIAL_OCR_DELETE_RULE_CODE}
                AND COALESCE(image_text_reason."metadata"->>'source', '') = 'image_text_ocr'
                AND COALESCE(image_text_reason."metadata"->>'enforcementScope', '') = 'delete_only'
              OFFSET 0
            )
          )
        `
        : Prisma.empty;
    const replacementCleanupFilter = this.replacementCleanupEnabled
      ? Prisma.sql`
          OR EXISTS (
            SELECT 1
            FROM "moderation_delete_intent_reasons" execution_reason
            WHERE execution_reason."intent_id" = intent."id"
              AND execution_reason."rule_code" IN (${Prisma.join([
                ...MODERATION_DELETE_INTENT_REPLACEMENT_CLEANUP_RULE_CODES,
              ])})
            OFFSET 0
          )
        `
      : Prisma.empty;
    const requiredSubscriptionDeleteFilter = this.requiredSubscriptionDeleteEnabled
      ? Prisma.sql`
          OR EXISTS (
            SELECT 1
            FROM "moderation_delete_intent_reasons" required_subscription_reason
            WHERE required_subscription_reason."intent_id" = intent."id"
              AND required_subscription_reason."rule_code" =
                ${REQUIRED_SUBSCRIPTION_DELETE_RULE_CODE}
            OFFSET 0
          )
        `
      : Prisma.empty;
    const executableRolloutFilter = Prisma.sql`(
      (
        ${baseFilter}
        AND EXISTS (
          SELECT 1
          FROM "moderation_delete_intent_reasons" base_reason
          WHERE base_reason."intent_id" = intent."id"
            AND base_reason."rule_code" <> ${COMMERCIAL_OCR_DELETE_RULE_CODE}
            AND base_reason."rule_code" NOT IN (${Prisma.join([...REPORT_GUARDED_RULES])})
          OFFSET 0
        )
      )
      OR (
        ${commercialOcrFilter}
        AND EXISTS (
          SELECT 1
          FROM "moderation_delete_intent_reasons" ocr_reason
          WHERE ocr_reason."intent_id" = intent."id"
            AND ocr_reason."rule_code" = ${COMMERCIAL_OCR_DELETE_RULE_CODE}
            AND COALESCE(ocr_reason."metadata"->>'source', '') <> 'image_text_ocr'
          OFFSET 0
        )
      )
      OR EXISTS (
        SELECT 1 FROM "moderation_delete_intent_reasons" report_reason
        WHERE report_reason."intent_id" = intent."id" AND (
          report_reason."rule_code" = ${REPORT_COUNTER_RULE}
          OR report_reason."rule_code" IN (${REPORT_DELETE_RULE}, ${REPORT_COMMAND_RULE})
        )
        OFFSET 0
      )
      OR ${this.durableUserDeleteReasonSql(Prisma.sql`intent."id"`)}
      ${replacementCleanupFilter}
      ${requiredSubscriptionDeleteFilter}
      ${imageTextStopListFilter}
      OR ${this.messageDuplicateOwnedSql(Prisma.sql`intent."id"`, true)}
      OR intent."suggestion_subscription_id" IS NOT NULL
      OR (
        EXISTS (
          SELECT 1
          FROM "moderation_delete_intent_reasons" auto_delete_reason
          WHERE auto_delete_reason."intent_id" = intent."id"
            AND auto_delete_reason."rule_code" = ${BOT_MESSAGE_AUTO_DELETE_RULE_CODE}
          OFFSET 0
        )
      )
    )`;
    const botMessageAutoDeleteRetryLimitApplicable =
      this.botMessageAutoDeleteRetryLimitApplicableSql(
        Prisma.sql`intent."id"`,
        Prisma.sql`intent."commercial_ocr_guard_required"`,
      );
    // FLAG: Keep the fifth attempt selectable, but never requeue an auto-delete-only row after it.
    // Mutation evidence must still be reconciled regardless of the cap.
    return Prisma.sql`(
      ${executableRolloutFilter}
      AND (
        NOT ${botMessageAutoDeleteRetryLimitApplicable}
        OR intent."attempt_count" < ${BOT_MESSAGE_AUTO_DELETE_MAX_EXTERNAL_ATTEMPTS}
        OR intent."delete_dispatch_started_at" IS NOT NULL
        OR intent."delete_dispatch_started_bot_id" IS NOT NULL
        OR intent."remote_delete_succeeded_at" IS NOT NULL
        OR intent."remote_delete_succeeded_bot_id" IS NOT NULL
      )
    )`;
  }

  private durableUserDeleteReasonSql(intentIdColumn: Prisma.Sql): Prisma.Sql {
    // FLAG: Preserve the per-intent indexed probe even in due-status queries with retained history.
    return Prisma.sql`EXISTS (
      SELECT 1 FROM "moderation_delete_intent_reasons" durable_user_reason
      WHERE durable_user_reason."intent_id" = ${intentIdColumn}
        AND durable_user_reason."rule_code" IN (${Prisma.join([...DURABLE_USER_DELETE_RULES])})
      OFFSET 0
    )`;
  }

  private buildRecoveryRolloutFilter(chatIdColumn: Prisma.Sql): Prisma.Sql {
    return this.replacementCleanupEnabled
      ? Prisma.sql`TRUE`
      : this.buildBaseRolloutFilter(chatIdColumn);
  }

  private buildBaseRolloutFilter(chatIdColumn: Prisma.Sql): Prisma.Sql {
    if (this.mode === 'on' || this.canaryChatIds.has('*')) {
      return Prisma.sql`TRUE`;
    }
    if (this.mode !== 'canary') {
      return Prisma.sql`FALSE`;
    }
    const ids = [...this.canaryChatIds];
    return ids.length > 0
      ? Prisma.sql`${chatIdColumn} IN (${Prisma.join(ids)})`
      : Prisma.sql`FALSE`;
  }

  private buildCommercialOcrRolloutFilter(chatIdColumn: Prisma.Sql): Prisma.Sql {
    if (this.commercialOcrMode === 'on') {
      return Prisma.sql`TRUE`;
    }
    if (this.commercialOcrMode !== 'canary') {
      return Prisma.sql`FALSE`;
    }
    const ids = [...this.commercialOcrCanaryChatIds];
    return ids.length > 0
      ? Prisma.sql`${chatIdColumn} IN (${Prisma.join(ids)})`
      : Prisma.sql`FALSE`;
  }

  private replacementCleanupRuleCode(
    source: ReplacementCleanupRecoveryCandidate['source'],
  ): string {
    switch (source) {
      case 'channel_auto_post':
        return 'CHANNEL_AUTO_POST_FORWARD_REPLACEMENT_CLEANUP';
      case 'chat_auto_comment':
        return 'CHAT_AUTO_COMMENT_ADMIN_MESSAGE_REPLACEMENT_CLEANUP';
      case 'chat_rules_state':
      case 'chat_rules_republish':
        return 'CHAT_RULES_REPUBLISH_PREVIOUS_MESSAGE_CLEANUP';
    }
  }

  private replacementCleanupReasonKey(candidate: ReplacementCleanupRecoveryCandidate): string {
    return `replacement-cleanup-recovery:${candidate.source}:${candidate.sourceId}`;
  }

  private isReplacementCleanupRecoveryReason(reasonKey: string): boolean {
    return reasonKey.startsWith('replacement-cleanup-recovery:');
  }

  private isReplacementCleanupRuleCode(ruleCode: string): boolean {
    return REPLACEMENT_CLEANUP_RULE_CODE_SET.has(ruleCode.trim());
  }

  private isExecutionEnabledForIntent(
    intent: Pick<
      IntentRow,
      | 'chatId'
      | 'retentionOwned'
      | 'suggestionSubscriptionId'
      | 'reportDeleteReason'
      | 'reportCounterCleanupReason'
      | 'replacementCleanup'
      | 'nonChannelReplacementCleanup'
      | 'channelAutoPostCleanupReason'
      | 'botMessageAutoDeleteReason'
      | 'botMessageAutoDeleteOnly'
      | 'requiredSubscriptionDeleteReason'
      | 'commercialOcrGuardRequired'
      | 'commercialOcrDeleteReason'
      | 'standardCommercialOcrDeleteReason'
      | 'nonCommercialOcrDeleteReason'
      | 'durableUserDeleteReason'
      | 'imageTextStopListDeleteReason'
      | 'imageTextStopListDeleteOnly'
      | 'messageDuplicateOwned'
    >,
  ): boolean {
    if (intent.retentionOwned) {
      return (
        (getAppRole() === 'message-retention' || getAppRole() === 'all') &&
        retentionModeAllows(
          this.configService.get('MESSAGE_RETENTION_MODE'),
          this.configService.get('MESSAGE_RETENTION_CANARY_CHAT_IDS'),
          intent.chatId,
          true,
        )
      );
    }
    if (getAppRole() === 'message-retention') return false;
    if (intent.suggestionSubscriptionId) return true;
    if (intent.reportCounterCleanupReason === true) return true;
    // FLAG: Persisted report work must reach its final guard even after disable, to settle revocation.
    if (intent.reportDeleteReason === true) return true;
    if (this.hasExecutableNonCommercialOcrReason(intent)) {
      return true;
    }
    if (
      intent.imageTextStopListDeleteReason === true &&
      this.getImageTextStopListRollout() === 'execute'
    ) {
      return true;
    }
    if (this.replacementCleanupEnabled && intent.channelAutoPostCleanupReason === true) {
      return true;
    }
    const hasCommercialOcrReason =
      intent.standardCommercialOcrDeleteReason === true ||
      (intent.standardCommercialOcrDeleteReason === undefined &&
        intent.imageTextStopListDeleteReason !== true &&
        (intent.commercialOcrDeleteReason === true || intent.commercialOcrGuardRequired === true));
    if (
      hasCommercialOcrReason &&
      this.getCommercialOcrRolloutForChat(intent.chatId) === 'execute'
    ) {
      return true;
    }
    if (hasCommercialOcrReason && intent.nonCommercialOcrDeleteReason !== true) {
      return false;
    }
    return this.getRolloutForChat(intent.chatId) === 'execute';
  }

  private hasExecutableNonCommercialOcrReason(
    intent: Pick<
      IntentRow,
      | 'chatId'
      | 'reportDeleteReason'
      | 'reportCounterCleanupReason'
      | 'replacementCleanup'
      | 'nonChannelReplacementCleanup'
      | 'channelAutoPostCleanupReason'
      | 'botMessageAutoDeleteReason'
      | 'botMessageAutoDeleteOnly'
      | 'requiredSubscriptionDeleteReason'
      | 'nonCommercialOcrDeleteReason'
      | 'durableUserDeleteReason'
      | 'messageDuplicateOwned'
    >,
  ): boolean {
    if (intent.messageDuplicateOwned === true || intent.durableUserDeleteReason === true)
      return true;
    if (
      intent.reportCounterCleanupReason === true ||
      (intent.reportDeleteReason === true && this.reportsEnabled(intent.chatId))
    )
      return true;
    if (
      (this.requiredSubscriptionDeleteEnabled &&
        intent.requiredSubscriptionDeleteReason === true) ||
      intent.botMessageAutoDeleteReason === true ||
      intent.botMessageAutoDeleteOnly === true ||
      (this.replacementCleanupEnabled &&
        (intent.nonChannelReplacementCleanup === true ||
          (intent.nonChannelReplacementCleanup === undefined &&
            intent.channelAutoPostCleanupReason === undefined &&
            intent.replacementCleanup === true)))
    ) {
      return true;
    }
    return (
      intent.nonCommercialOcrDeleteReason === true &&
      this.getRolloutForChat(intent.chatId) === 'execute'
    );
  }

  private hasExecutableReasonIgnoringChannelAutoPostCleanup(
    intent: Pick<
      IntentRow,
      | 'chatId'
      | 'replacementCleanup'
      | 'nonChannelReplacementCleanup'
      | 'channelAutoPostCleanupReason'
      | 'botMessageAutoDeleteReason'
      | 'botMessageAutoDeleteOnly'
      | 'requiredSubscriptionDeleteReason'
      | 'commercialOcrGuardRequired'
      | 'commercialOcrDeleteReason'
      | 'nonCommercialOcrDeleteReason'
      | 'durableUserDeleteReason'
      | 'messageDuplicateOwned'
    >,
  ): boolean {
    if (this.hasExecutableNonCommercialOcrReason(intent)) {
      return true;
    }
    return (
      (intent.commercialOcrDeleteReason === true || intent.commercialOcrGuardRequired === true) &&
      this.getCommercialOcrRolloutForChat(intent.chatId) === 'execute'
    );
  }

  private getCommercialOcrRolloutForChat(chatId: string): ModerationDeleteIntentRollout {
    return resolveModerationDeleteIntentRollout({
      mode: this.commercialOcrMode,
      canaryChatIds: this.commercialOcrCanaryChatIds,
      chatId,
    });
  }

  private reportsEnabled(chatId: string): boolean {
    const mode = this.configService.get<string>('PARTICIPANT_REPORTS_MODE') ?? 'off';
    return (
      mode === 'on' ||
      (mode === 'canary' &&
        (this.configService.get<string>('PARTICIPANT_REPORTS_CANARY_CHAT_IDS') ?? '')
          .split(',')
          .map((id) => id.trim())
          .filter(Boolean)
          .includes(chatId))
    );
  }

  private hasExecutableIndependentReportReason(
    chatId: string,
    reasons: readonly { ruleCode: string; reasonKey?: string; metadata: unknown }[],
  ): boolean {
    // FLAG: Keep metadata-bound independent policies executable under their own rollout ceiling.
    return reasons.some(
      (reason) =>
        this.getRolloutForInput({
          chatId,
          ruleCode: reason.ruleCode,
          reasonKey: reason.reasonKey ?? reason.ruleCode,
          event: { metadata: reason.metadata },
        }) === 'execute',
    );
  }

  private hasAnyExecutionScope(): boolean {
    return true;
  }

  private orderCandidateBotIds(intent: IntentRow, values: readonly string[]): string[] {
    const unique = [...new Set(values.map((value) => value.trim()).filter(Boolean))];
    const routingPolicy = this.resolveEffectiveRoutingPolicy(intent);
    if (routingPolicy === 'origin_only') {
      return intent.originBotId && unique.includes(intent.originBotId) ? [intent.originBotId] : [];
    }
    if (routingPolicy !== 'origin_first' || !intent.originBotId) {
      return unique;
    }
    return unique.includes(intent.originBotId)
      ? [intent.originBotId, ...unique.filter((botId) => botId !== intent.originBotId)]
      : unique;
  }

  private isBotAllowedByRoutingPolicy(intent: IntentRow, botId: string): boolean {
    if (this.resolveEffectiveRoutingPolicy(intent) === 'origin_only') {
      return Boolean(intent.originBotId && botId === intent.originBotId);
    }
    return true;
  }

  private filterAndOrderRouteCandidates(
    intent: IntentRow,
    route: MaxDeleteMessageBotRoute,
  ): string[] {
    const capabilities = new Map(
      route.candidateCapabilities.map((candidate) => [candidate.botId, candidate]),
    );
    return this.orderCandidateBotIds(intent, route.candidateBotIds).filter((botId) => {
      const candidate = capabilities.get(botId);
      return (
        candidate?.state === 'confirmed_capable' &&
        !this.isCandidateBackedOff(intent, botId, candidate.checkedAt)
      );
    });
  }

  private isCandidateBackedOff(
    intent: IntentRow,
    botId: string,
    capabilityCheckedAt: string | null,
  ): boolean {
    const failure = this.readCandidateFailures(intent.candidateFailures).get(botId);
    if (!failure) {
      return false;
    }
    const failedAtMs = new Date(failure.failedAt).getTime();
    const checkedAtMs = capabilityCheckedAt ? new Date(capabilityCheckedAt).getTime() : Number.NaN;
    if (Number.isFinite(checkedAtMs) && checkedAtMs > failedAtMs) {
      return false;
    }
    return new Date(failure.retryAt).getTime() > Date.now();
  }

  private readCandidateFailures(value: unknown): Map<string, CandidateFailure> {
    const result = new Map<string, CandidateFailure>();
    const row = this.asRecord(value);
    if (!row) {
      return result;
    }
    for (const [botId, rawFailure] of Object.entries(row)) {
      const failure = this.asRecord(rawFailure);
      if (!failure) {
        continue;
      }
      const failedAt = this.firstString(failure.failedAt);
      const retryAt = this.firstString(failure.retryAt);
      if (!failedAt || !retryAt) {
        continue;
      }
      const rawStatusCode = failure.statusCode;
      const parsedStatusCode =
        (typeof rawStatusCode === 'number' ||
          (typeof rawStatusCode === 'string' && rawStatusCode.trim().length > 0)) &&
        Number.isFinite(Number(rawStatusCode))
          ? Number(rawStatusCode)
          : null;
      result.set(botId, {
        failedAt,
        retryAt,
        errorCode: this.firstString(failure.errorCode),
        statusCode: parsedStatusCode,
      });
    }
    return result;
  }

  private classifyDeleteError(
    error: unknown,
    attemptCount: number,
    dispatchMarkerPersisted = false,
  ): DeleteErrorDetails {
    const details = this.describeError(error, 'delete_failed');
    // FLAG: A dispatched timeout/server/unknown failure does not prove rejection,
    // even when the response text resembles access denial or message absence.
    if (
      dispatchMarkerPersisted &&
      (details.statusCode === null ||
        details.statusCode === 408 ||
        (details.statusCode !== null && details.statusCode >= 500) ||
        this.isAmbiguousTransportError(error))
    ) {
      return {
        ...details,
        status: 'AMBIGUOUS',
        retryDelayMs: Math.max(details.retryDelayMs ?? 0, this.retryDelayMs(attemptCount)),
      };
    }
    if (isMaxApiCircuitOpenError(error)) {
      return {
        ...details,
        status: 'RETRYABLE',
        errorCode: 'max_circuit_open',
        retryDelayMs: Math.max(error.retryAfterMs, this.retryDelayMs(attemptCount)),
      };
    }
    // FLAG: Only the transport's genuine pre-dispatch quota rejection supplies this
    // wait. Retained mutation evidence takes precedence; the original retry deadline
    // is still enforced by finishRetryableAttempt, including expiry before the hint.
    const errorRecord = this.asRecord(error);
    if (
      !dispatchMarkerPersisted &&
      error instanceof MaxApiInternalRateLimitError &&
      error.preDispatch === true &&
      wasMaxPreDispatchGuardRejected(error) &&
      details.statusCode === null &&
      errorRecord?.response === undefined &&
      errorRecord?.request === undefined &&
      errorRecord?.config === undefined &&
      !this.isAmbiguousTransportError(error) &&
      Number.isSafeInteger(error.retryAfterMs) &&
      error.retryAfterMs > 0 &&
      Number.isFinite(new Date(Date.now() + error.retryAfterMs).getTime())
    ) {
      return {
        ...details,
        status: 'RETRYABLE',
        retryDelayMs: Math.max(error.retryAfterMs, this.retryDelayMs(attemptCount)),
      };
    }
    // FLAG: This exact local admission rejection happens before the mutation callback.
    // A surviving peer may execute only while no dispatch marker exists; any unknown
    // failure after that marker keeps the existing ambiguity fence above.
    if (
      !dispatchMarkerPersisted &&
      wasMaxPreDispatchGuardRejected(error) &&
      this.asRecord(error)?.code === 'max_action_executor_proof_rejected'
    )
      return {
        ...details,
        status: 'WAITING_CAPABILITY',
        errorCode: 'max_action_executor_proof_rejected',
        retryDelayMs: this.capabilityRetryDelayMs(attemptCount),
      };
    if (this.isDeleteMessageNotFoundFailure(details)) {
      return {
        ...details,
        status: 'WAITING_CAPABILITY',
        errorCode: 'unverified_message_not_found',
        retryDelayMs: this.capabilityRetryDelayMs(attemptCount),
      };
    }
    if (this.isDeleteAccessFailure(details)) {
      return {
        ...details,
        status: 'WAITING_CAPABILITY',
        retryDelayMs: this.capabilityRetryDelayMs(attemptCount),
      };
    }
    if (details.statusCode === 404) {
      return {
        ...details,
        status: 'WAITING_CAPABILITY',
        errorCode: 'unverified_message_not_found',
        retryDelayMs: this.capabilityRetryDelayMs(attemptCount),
      };
    }
    if (details.statusCode === 400 || details.statusCode === 422) {
      return { ...details, status: 'FAILED_TERMINAL', retryDelayMs: null };
    }
    if (details.statusCode === 429 || (details.statusCode !== null && details.statusCode >= 500)) {
      return {
        ...details,
        status: 'RETRYABLE',
        retryDelayMs: Math.max(details.retryDelayMs ?? 0, this.retryDelayMs(attemptCount)),
      };
    }
    if (this.isAmbiguousTransportError(error)) {
      return {
        ...details,
        status: 'AMBIGUOUS',
        retryDelayMs: this.retryDelayMs(attemptCount),
      };
    }
    return {
      ...details,
      status: 'RETRYABLE',
      retryDelayMs: this.retryDelayMs(attemptCount),
    };
  }

  private isDeleteMessageNotFoundFailure(
    details: Pick<DeleteErrorDetails, 'errorCode' | 'message'>,
  ): boolean {
    const code = details.errorCode.trim().toLowerCase();
    const message = details.message.trim().toLowerCase();
    return (
      code === 'message.not.found' ||
      code === 'message_not_found' ||
      code === 'message.not_found' ||
      message.includes('message not found') ||
      message.includes('message.not.found')
    );
  }

  private isDeleteAccessFailure(
    details: Pick<DeleteErrorDetails, 'statusCode' | 'errorCode' | 'message'>,
  ): boolean {
    if (details.statusCode === 401 || details.statusCode === 403) {
      return true;
    }
    const code = details.errorCode.trim().toLowerCase();
    const message = details.message.trim().toLowerCase();
    return (
      code === 'access.denied' ||
      code === 'chat.denied' ||
      code === 'chat.not.found' ||
      code === 'permission.denied' ||
      message.includes('access denied') ||
      message.includes('permission denied') ||
      message.includes('not enough permission') ||
      message.includes('forbidden')
    );
  }

  private describeError(error: unknown, fallbackCode: string): DeleteErrorDetails {
    const row = this.asRecord(error);
    const response = this.asRecord(row?.response);
    const data = this.asRecord(response?.data);
    const nestedError = this.asRecord(data?.error);
    const rawStatus = response?.status ?? row?.statusCode ?? row?.status;
    const statusCode = Number.isFinite(Number(rawStatus)) ? Number(rawStatus) : null;
    const errorCode =
      error instanceof MessageRetentionGuardError && error.reasonCode
        ? `message_retention_guard:${error.reasonCode}`
        : this.firstString(nestedError?.code, data?.code, row?.code, fallbackCode);
    const stopWordsRejectionReason = this.readStopWordsGuardRejection(error);
    const message = stopWordsRejectionReason
      ? JSON.stringify({
          type: 'stop_words_guard_rejection',
          rejectionReason: stopWordsRejectionReason,
        })
      : this.firstString(
          nestedError?.message,
          data?.message,
          row?.message,
          'Unknown moderation delete error',
        );
    return {
      status: 'RETRYABLE',
      statusCode,
      errorCode,
      message,
      retryDelayMs: readMaxRetryAfterMs(error, Date.now()) || null,
    };
  }

  private readStopWordsGuardRejection(error: unknown): StopWordsGuardRejectionReason | undefined {
    if (error instanceof StopWordsDeleteGuardRejectedError) return error.rejectionReason;
    if (error instanceof ModerationDeleteReasonsRejectedError)
      return error.stopWordsRejectionReason;
    if (!(error instanceof ImageTextStopListDeleteIntentGuardRejectedError)) return undefined;
    const reasons: Readonly<Record<string, StopWordsGuardRejectionReason>> = {
      image_text_stop_list_runtime_disabled: 'runtime_disabled',
      image_text_stop_list_binding_invalid: 'binding_invalid',
      image_text_stop_list_binding_stale: 'binding_stale',
      image_text_stop_list_settings_disabled: 'policy_disabled',
      image_text_stop_list_bot_immune: 'author_protected',
      image_text_stop_list_admin_immune: 'author_protected',
      image_text_stop_list_message_changed: 'source_changed',
      image_text_stop_list_participant_immune: 'participant_immune',
      image_text_stop_list_policy_changed: 'policy_changed',
      image_text_stop_list_deadline_expired: 'deadline_expired',
    };
    return reasons[error.code];
  }

  private isAmbiguousTransportError(error: unknown): boolean {
    const row = this.asRecord(error);
    const code = this.firstString(row?.code).toUpperCase();
    if (['ECONNABORTED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE'].includes(code)) {
      return true;
    }
    const message = this.firstString(row?.message).toLowerCase();
    return (
      message.includes('timeout') ||
      message.includes('timed out') ||
      message.includes('socket hang up') ||
      message.includes('network error')
    );
  }

  private retryDelayMs(attemptCount: number): number {
    const exponent = Math.max(0, Math.min(10, attemptCount - 1));
    const base = Math.min(this.retryMaxMs, this.retryBaseMs * 2 ** exponent);
    const jitter = 0.8 + Math.random() * 0.4;
    return Math.max(1_000, Math.round(base * jitter));
  }

  private capabilityRetryDelayMs(attemptCount: number): number {
    return Math.max(this.capabilityRetryMs, this.retryDelayMs(attemptCount));
  }

  private isExpiredAutoDeleteVerification(intent: IntentRow, nowMs: number): boolean {
    const acknowledgedAtMs = intent.remoteDeleteSucceededAt?.getTime() ?? Number.NaN;
    const retryUntilAtMs = intent.retryUntilAt.getTime();
    return (
      this.isBotMessageAutoDeleteOnlyReason(intent) &&
      Number.isFinite(acknowledgedAtMs) &&
      acknowledgedAtMs <= nowMs &&
      typeof intent.remoteDeleteSucceededBotId === 'string' &&
      intent.remoteDeleteSucceededBotId.trim().length > 0 &&
      Number.isFinite(retryUntilAtMs) &&
      retryUntilAtMs <= nowMs
    );
  }

  private isBotMessageAutoDeleteRetryLimitApplicable(
    intent: Pick<
      IntentRow,
      | 'botMessageAutoDeleteOnly'
      | 'requiredSubscriptionDeleteReason'
      | 'replacementCleanup'
      | 'commercialOcrGuardRequired'
      | 'commercialOcrDeleteReason'
      | 'remoteDeleteSucceededAt'
      | 'remoteDeleteSucceededBotId'
      | 'deleteDispatchStartedAt'
      | 'deleteDispatchStartedBotId'
    >,
  ): boolean {
    return this.isBotMessageAutoDeleteOnlyReason(intent) && !this.hasDeleteMutationEvidence(intent);
  }

  private isBotMessageAutoDeleteOnlyReason(
    intent: Pick<
      IntentRow,
      | 'botMessageAutoDeleteOnly'
      | 'requiredSubscriptionDeleteReason'
      | 'replacementCleanup'
      | 'commercialOcrGuardRequired'
      | 'commercialOcrDeleteReason'
    >,
  ): boolean {
    return (
      intent.botMessageAutoDeleteOnly === true &&
      intent.requiredSubscriptionDeleteReason !== true &&
      intent.replacementCleanup !== true &&
      intent.commercialOcrGuardRequired !== true &&
      intent.commercialOcrDeleteReason !== true
    );
  }

  private botMessageAutoDeleteRetryLimitDetails(): DeleteErrorDetails {
    return {
      status: 'FAILED_TERMINAL',
      statusCode: null,
      errorCode: BOT_MESSAGE_AUTO_DELETE_RETRY_LIMIT_ERROR_CODE,
      message:
        `BOT_MESSAGE_AUTO_DELETE reached its limit of ` +
        `${BOT_MESSAGE_AUTO_DELETE_MAX_EXTERNAL_ATTEMPTS} external attempts before dispatch`,
      retryDelayMs: null,
    };
  }

  private async enforceBotMessageAutoDeleteRetryLimit(
    intent: IntentRow,
    leaseToken: string,
    exceededOnly: boolean,
  ): Promise<BotMessageAutoDeleteRetryLimitOutcome> {
    return this.prisma.$transaction(
      async (tx) => {
        // FLAG: Lock first, then classify reasons in a new READ COMMITTED statement. This prevents
        // a concurrent independent reason from inheriting an auto-delete-only terminal.
        const locked = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
          SELECT "id"
          FROM "moderation_delete_intents"
          WHERE "id" = ${intent.id}
            AND "status" = CAST('IN_PROGRESS' AS "ModerationDeleteIntentStatus")
            AND "lease_token" = ${leaseToken}
          FOR UPDATE
        `);
        if (!locked[0]) {
          return { kind: 'lease_lost' } as const;
        }

        const latestRows = await tx.$queryRaw<IntentRow[]>(Prisma.sql`
          SELECT ${this.intentSelectSql('intent')}
          FROM "moderation_delete_intents" intent
          WHERE intent."id" = ${intent.id}
          LIMIT 1
        `);
        const latest = latestRows[0];
        if (!latest) {
          return { kind: 'lease_lost' } as const;
        }
        const attemptLimitReached = exceededOnly
          ? latest.attemptCount > BOT_MESSAGE_AUTO_DELETE_MAX_EXTERNAL_ATTEMPTS
          : latest.attemptCount >= BOT_MESSAGE_AUTO_DELETE_MAX_EXTERNAL_ATTEMPTS;
        if (!attemptLimitReached || !this.isBotMessageAutoDeleteRetryLimitApplicable(latest)) {
          return { kind: 'continue', intent: latest } as const;
        }

        const details = this.botMessageAutoDeleteRetryLimitDetails();
        const completedRows = await tx.$queryRaw<IntentRow[]>(Prisma.sql`
          UPDATE "moderation_delete_intents"
          SET
            "status" = CAST('FAILED_TERMINAL' AS "ModerationDeleteIntentStatus"),
            "next_attempt_at" = CURRENT_TIMESTAMP,
            "last_status_code" = ${details.statusCode},
            "last_error_code" = ${details.errorCode},
            "last_error" = ${details.message.slice(0, 2_000)},
            "completed_at" = CURRENT_TIMESTAMP,
            "lease_token" = NULL,
            "lease_expires_at" = NULL,
            "leased_from_status" = NULL,
            "updated_at" = CURRENT_TIMESTAMP
          WHERE "id" = ${intent.id}
            AND "status" = CAST('IN_PROGRESS' AS "ModerationDeleteIntentStatus")
            AND "lease_token" = ${leaseToken}
            AND "remote_delete_succeeded_at" IS NULL
            AND "remote_delete_succeeded_bot_id" IS NULL
            AND "delete_dispatch_started_at" IS NULL
            AND "delete_dispatch_started_bot_id" IS NULL
          RETURNING ${this.intentReturningSql()}
        `);
        const completed = completedRows[0];
        return completed
          ? ({ kind: 'terminal', intent: completed } as const)
          : ({ kind: 'lease_lost' } as const);
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
    );
  }

  private hasRemoteSuccessMarker(
    intent: Pick<IntentRow, 'remoteDeleteSucceededAt' | 'remoteDeleteSucceededBotId'>,
  ): boolean {
    return Boolean(intent.remoteDeleteSucceededAt || intent.remoteDeleteSucceededBotId);
  }

  private hasDeleteDispatchMarker(
    intent: Pick<IntentRow, 'deleteDispatchStartedAt' | 'deleteDispatchStartedBotId'>,
  ): boolean {
    return Boolean(intent.deleteDispatchStartedAt || intent.deleteDispatchStartedBotId);
  }

  private hasDeleteMutationEvidence(
    intent: Pick<
      IntentRow,
      | 'remoteDeleteSucceededAt'
      | 'remoteDeleteSucceededBotId'
      | 'deleteDispatchStartedAt'
      | 'deleteDispatchStartedBotId'
    >,
  ): boolean {
    return this.hasRemoteSuccessMarker(intent) || this.hasDeleteDispatchMarker(intent);
  }

  private toSnapshot(intent: IntentRow): ModerationDeleteIntentSnapshot {
    return {
      id: intent.id,
      chatId: intent.chatId,
      messageId: intent.messageId,
      status: intent.status,
      executeAt: intent.executeAt,
      nextAttemptAt: intent.nextAttemptAt,
      retryUntilAt: intent.retryUntilAt,
      attemptCount: intent.attemptCount,
      lastBotId: intent.lastBotId,
      succeededBotId: intent.succeededBotId,
      deleteDispatchStartedAt: intent.deleteDispatchStartedAt,
      deleteDispatchStartedBotId: intent.deleteDispatchStartedBotId,
      remoteDeleteSucceededAt: intent.remoteDeleteSucceededAt,
      remoteDeleteSucceededBotId: intent.remoteDeleteSucceededBotId,
      lastStatusCode: intent.lastStatusCode,
      lastErrorCode: intent.lastErrorCode,
      lastError: intent.lastError,
    };
  }

  private toAttemptResult(
    intent: Pick<IntentRow, 'id' | 'status' | 'succeededBotId'>,
  ): ModerationDeleteAttemptResult {
    const base = { intentId: intent.id } as const;
    switch (intent.status) {
      case 'OBSERVED':
        return { ...base, kind: 'observed', confirmed: false, status: intent.status };
      case 'SUCCEEDED':
        return {
          ...base,
          kind: 'confirmed',
          confirmed: true,
          status: intent.status,
          botId: intent.succeededBotId,
        };
      case 'ALREADY_ABSENT':
        return {
          ...base,
          kind: 'already_absent',
          confirmed: true,
          status: intent.status,
          botId: null,
        };
      case 'WAITING_CAPABILITY':
        return { ...base, kind: 'waiting_capability', confirmed: false, status: intent.status };
      case 'AMBIGUOUS':
        return { ...base, kind: 'ambiguous', confirmed: false, status: intent.status };
      case 'EXPIRED':
        return { ...base, kind: 'expired', confirmed: false, status: intent.status };
      case 'FAILED_TERMINAL':
        return { ...base, kind: 'terminal', confirmed: false, status: intent.status };
      case 'PENDING':
      case 'RETRYABLE':
      case 'IN_PROGRESS':
        return { ...base, kind: 'pending', confirmed: false, status: intent.status };
    }
  }

  private normalizeInput(input: EnsureModerationDeleteIntentInput) {
    const chatId = input.chatId.trim();
    const messageId = input.messageId.trim();
    const reasonKey = input.reasonKey.trim();
    const ruleCode = (input.ruleCode ?? reasonKey).trim();
    if (!chatId || !messageId || !reasonKey || !ruleCode) {
      throw new Error('chatId, messageId, reasonKey, and ruleCode must be non-empty');
    }

    const now = new Date();
    let executeAt = this.toDate(input.executeAt, now);
    const sourceMessageAt = this.toNullableDate(input.sourceMessageAt);
    const defaultRetryBaseMs = Math.max(
      executeAt.getTime(),
      sourceMessageAt?.getTime() ?? now.getTime(),
    );
    const retryUntilAt = this.toDate(
      input.retryUntilAt,
      new Date(defaultRetryBaseMs + this.retryHorizonMs),
    );
    const expiredImmediateSchedule =
      input.executeAt == null && input.retryUntilAt != null && retryUntilAt <= now;
    if (retryUntilAt < executeAt) {
      // FLAG: An omitted immediate schedule can arrive after its original deadline.
      // Persist it EXPIRED without extending authority; explicit inverted schedules still fail.
      if (expiredImmediateSchedule) executeAt = retryUntilAt;
      else throw new Error('retryUntilAt must not be earlier than executeAt');
    }
    const commercialOcrDeadlineAt = this.toNullableDate(input.commercialOcrDeadlineAt);
    if (
      ruleCode === COMMERCIAL_OCR_DELETE_RULE_CODE &&
      (!commercialOcrDeadlineAt || commercialOcrDeadlineAt.getTime() !== retryUntilAt.getTime())
    ) {
      throw new Error('commercial OCR intent deadline must equal retryUntilAt');
    }

    const subjectUserId = this.optionalString(input.subjectUserId);
    const eventUserId = this.optionalString(input.event?.userId) ?? subjectUserId;
    const eventType =
      input.event?.eventType === undefined
        ? eventUserId
          ? 'MESSAGE'
          : null
        : input.event.eventType;
    const entityType =
      input.entityType === 'CHAT' || input.entityType === 'CHANNEL' ? input.entityType : null;
    const messageAuthorKind =
      input.messageAuthorKind === 'user' || input.messageAuthorKind === 'bot'
        ? input.messageAuthorKind
        : null;
    const originBotId = this.optionalString(input.originBotId);
    const routingPolicy = this.resolveRoutingPolicy(input, chatId);
    const suggestionSubscriptionId = this.optionalString(input.suggestionSubscriptionId);
    if (
      ruleCode === SUGGESTION_SUBSCRIPTION_DELETE_RULE &&
      (!suggestionSubscriptionId ||
        entityType !== 'CHANNEL' ||
        messageAuthorKind !== 'bot' ||
        routingPolicy !== 'origin_only')
    ) {
      throw new Error('Suggestion subscription delete requires exact publication binding');
    }
    if (suggestionSubscriptionId && ruleCode !== SUGGESTION_SUBSCRIPTION_DELETE_RULE)
      throw new Error('Invalid subscription delete rule');
    if (
      (isBoundMessageDuplicateDelete(input) ||
        this.getRolloutForRule(chatId, ruleCode) === 'execute') &&
      routingPolicy === 'origin_only' &&
      !originBotId
    ) {
      throw new Error('originBotId is required for executable origin-only delete intent');
    }
    return {
      chatId,
      messageId,
      reasonKey,
      ruleCode,
      subjectUserId,
      sourceMessageAt,
      entityType,
      messageAuthorKind,
      originBotId,
      routingPolicy,
      executeAt,
      expiredImmediateSchedule,
      suggestionSubscriptionId,
      retryUntilAt,
      commercialOcrDeadlineAt,
      event: {
        userId: eventUserId,
        eventType,
        maskedExcerpt: this.optionalString(input.event?.maskedExcerpt),
        score:
          typeof input.event?.score === 'number' && Number.isFinite(input.event.score)
            ? input.event.score
            : 1,
        metadata: input.event?.metadata,
      },
    };
  }

  private assertClaimMatchesIntent(
    claim: ModerationMessageActionClaimData,
    intent: EnsureModerationDeleteIntentInput,
  ): void {
    const metadata = this.asRecord(intent.event?.metadata);
    if (
      metadata?.duplicateSource === MESSAGE_DUPLICATE_SOURCE ||
      intent.reasonKey.startsWith('MESSAGE_DUPLICATE:')
    ) {
      const binding = parseMessageDuplicateBinding(metadata);
      const until = this.toNullableDate(intent.retryUntilAt);
      if (
        !binding ||
        !until ||
        claim.updateType !== 'message_action' ||
        claim.ruleCode !== 'DUPLICATE_MESSAGE_ACTION' ||
        intent.ruleCode !== 'DUPLICATE_DELETE' ||
        metadata?.enforcementScope !== messageDuplicateEnforcementScope(binding) ||
        claim.chatId !== intent.chatId ||
        claim.userId !== binding.senderId ||
        claim.messageId !== binding.messageId ||
        intent.messageId !== binding.messageId ||
        intent.subjectUserId !== binding.senderId ||
        intent.messageAuthorKind !== 'user' ||
        intent.entityType !== 'CHAT' ||
        claim.messageActionKey !==
          buildMessageScopedModerationActionClaimKey(intent.chatId, intent.messageId) ||
        claim.dedupeKey !==
          `${MESSAGE_DUPLICATE_CLAIM_PREFIX}${digestDuplicateContent([intent.chatId, binding.senderId, binding.messageId])}` ||
        until.getTime() > binding.eventTimestampMs + binding.windowSeconds * 1000 ||
        (binding.version === 3 &&
          (!binding.authorization || until.getTime() > binding.authorization.deadlineAtMs))
      ) {
        throw new Error('Message duplicate claim does not match its delete binding');
      }
      return;
    }
    const imageTextBinding = parseImageTextStopListBinding(intent.event?.metadata);
    const retryUntilAt = this.toNullableDate(intent.retryUntilAt);
    if (imageTextBinding) {
      const metadata = this.asRecord(intent.event?.metadata);
      if (
        claim.updateType !== 'message_action' ||
        claim.ruleCode !== IMAGE_TEXT_STOP_LIST_MESSAGE_ACTION_RULE_CODE ||
        claim.messageActionKey !==
          buildMessageScopedModerationActionClaimKey(intent.chatId, intent.messageId) ||
        !claim.dedupeKey.startsWith(IMAGE_TEXT_STOP_LIST_ACTION_DEDUPE_PREFIX) ||
        !/^[a-f0-9]{64}$/u.test(
          claim.dedupeKey.slice(IMAGE_TEXT_STOP_LIST_ACTION_DEDUPE_PREFIX.length),
        ) ||
        claim.chatId.trim() !== intent.chatId.trim() ||
        claim.messageId.trim() !== intent.messageId.trim() ||
        claim.userId.trim() !== imageTextBinding.senderId ||
        claim.userId.trim() !== this.optionalString(intent.subjectUserId) ||
        (intent.ruleCode ?? intent.reasonKey).trim() !== COMMERCIAL_OCR_DELETE_RULE_CODE ||
        metadata?.source !== 'image_text_ocr' ||
        metadata?.enforcementScope !== 'delete_only' ||
        metadata?.matchedRuleCode !== imageTextBinding.ruleCode ||
        !retryUntilAt ||
        retryUntilAt.toISOString() !== imageTextBinding.deleteDeadlineAt ||
        this.toNullableDate(intent.sourceMessageAt)?.toISOString() !==
          imageTextBinding.sourceCreatedAt
      ) {
        throw new Error(
          'Moderation message action claim does not match its image text stop-list delete intent',
        );
      }
      return;
    }

    const binding = parseCommercialOcrDeleteBinding(intent.event?.metadata);
    if (
      claim.updateType !== 'message_action' ||
      claim.ruleCode !== COMMERCIAL_OCR_MESSAGE_ACTION_RULE_CODE ||
      claim.messageActionKey !==
        buildMessageScopedModerationActionClaimKey(intent.chatId, intent.messageId) ||
      !claim.dedupeKey.startsWith('commercial-ocr-action:v1:') ||
      claim.chatId.trim() !== intent.chatId.trim() ||
      claim.messageId.trim() !== intent.messageId.trim() ||
      claim.userId.trim() !== this.optionalString(intent.subjectUserId) ||
      (intent.ruleCode ?? intent.reasonKey).trim() !== COMMERCIAL_OCR_DELETE_RULE_CODE ||
      !binding ||
      !retryUntilAt ||
      retryUntilAt.toISOString() !== binding.ocrDeadlineAt ||
      this.toNullableDate(intent.sourceMessageAt)?.toISOString() !== binding.sourceCreatedAt
    ) {
      throw new Error('Moderation message action claim does not match its OCR delete intent');
    }
  }

  private async runSerializableTransaction<T>(
    operation: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    const maxAttempts = 3;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        return await this.prisma.$transaction(operation, {
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        });
      } catch (error: unknown) {
        if (attempt >= maxAttempts || !this.isPrismaSerializationFailure(error)) {
          throw error;
        }
      }
    }
    throw new Error('Serializable moderation delete intent transaction did not complete');
  }

  private isPrismaSerializationFailure(error: unknown): boolean {
    const code =
      error && typeof error === 'object' && 'code' in error
        ? String((error as { code?: unknown }).code)
        : '';
    if (code === 'P2034') {
      return true;
    }
    // FLAG: Prisma's pg adapter can expose a typed conflict directly at COMMIT,
    // after the callback completed. Retry the whole transaction, never a partial write
    // or an ambiguous connection failure, under the existing three-attempt bound.
    if (
      error instanceof Error &&
      error.name === 'DriverAdapterError' &&
      error.cause !== null &&
      typeof error.cause === 'object' &&
      'kind' in error.cause &&
      error.cause.kind === 'TransactionWriteConflict'
    )
      return true;
    return this.errorMessage(error).toLowerCase().includes('could not serialize access');
  }

  private intentReturningSql(alias?: string): Prisma.Sql {
    return this.intentColumnsSql(alias);
  }

  private messageDuplicateOwnedSql(
    intentIdColumn: Prisma.Sql,
    preserveCorrelation = false,
  ): Prisma.Sql {
    return Prisma.sql`EXISTS (
      SELECT 1 FROM "moderation_delete_intent_reasons" message_duplicate_reason
      WHERE message_duplicate_reason."intent_id" = ${intentIdColumn}
        AND (message_duplicate_reason."reason_key" LIKE 'MESSAGE_DUPLICATE:%'
          OR message_duplicate_reason."metadata"->>'duplicateSource' = 'message_v1')
      ${preserveCorrelation ? Prisma.sql`OFFSET 0` : Prisma.empty}
    )`;
  }

  private intentSelectSql(alias: string): Prisma.Sql {
    const intentIdColumn = Prisma.raw(`"${alias}"."id"`);
    const intentMessageIdColumn = Prisma.raw(`"${alias}"."message_id"`);
    return Prisma.sql`
      ${this.intentColumnsSql(alias)},
      ${this.messageDuplicateOwnedSql(intentIdColumn)} AS "messageDuplicateOwned",
      EXISTS (
        SELECT 1
        FROM "moderation_delete_intent_reasons" execution_reason
        WHERE execution_reason."intent_id" = ${intentIdColumn}
          AND execution_reason."rule_code" IN (${Prisma.join([
            ...MODERATION_DELETE_INTENT_REPLACEMENT_CLEANUP_RULE_CODES,
          ])})
      ) AS "replacementCleanup",
      EXISTS (
        SELECT 1
        FROM "moderation_delete_intent_reasons" non_channel_replacement_reason
        WHERE non_channel_replacement_reason."intent_id" = ${intentIdColumn}
          AND non_channel_replacement_reason."rule_code" IN (${Prisma.join([
            ...MODERATION_DELETE_INTENT_REPLACEMENT_CLEANUP_RULE_CODES.filter(
              (ruleCode) => ruleCode !== CHANNEL_AUTO_POST_FORWARD_REPLACEMENT_CLEANUP_RULE_CODE,
            ),
          ])})
      ) AS "nonChannelReplacementCleanup",
      EXISTS (
        SELECT 1
        FROM "moderation_delete_intent_reasons" channel_cleanup_reason
        WHERE channel_cleanup_reason."intent_id" = ${intentIdColumn}
          AND channel_cleanup_reason."rule_code" =
            ${CHANNEL_AUTO_POST_FORWARD_REPLACEMENT_CLEANUP_RULE_CODE}
      ) AS "channelAutoPostCleanupReason",
      (
        EXISTS (
          SELECT 1
          FROM "moderation_delete_intent_reasons" channel_cleanup_reason
          WHERE channel_cleanup_reason."intent_id" = ${intentIdColumn}
            AND channel_cleanup_reason."rule_code" =
              ${CHANNEL_AUTO_POST_FORWARD_REPLACEMENT_CLEANUP_RULE_CODE}
        )
        AND NOT EXISTS (
          SELECT 1
          FROM "moderation_delete_intent_reasons" independent_reason
          WHERE independent_reason."intent_id" = ${intentIdColumn}
            AND independent_reason."rule_code" <>
              ${CHANNEL_AUTO_POST_FORWARD_REPLACEMENT_CLEANUP_RULE_CODE}
        )
      ) AS "channelAutoPostCleanupOnly",
      EXISTS (
        SELECT 1
        FROM "moderation_delete_intent_reasons" auto_delete_reason
        WHERE auto_delete_reason."intent_id" = ${intentIdColumn}
          AND auto_delete_reason."rule_code" = ${BOT_MESSAGE_AUTO_DELETE_RULE_CODE}
      ) AS "botMessageAutoDeleteReason",
      EXISTS (
        SELECT 1
        FROM "moderation_delete_intent_reasons" required_subscription_reason
        WHERE required_subscription_reason."intent_id" = ${intentIdColumn}
          AND required_subscription_reason."rule_code" =
            ${REQUIRED_SUBSCRIPTION_DELETE_RULE_CODE}
      ) AS "requiredSubscriptionDeleteReason",
      EXISTS (
        SELECT 1
        FROM "moderation_delete_intent_reasons" mute_reason
        WHERE mute_reason."intent_id" = ${intentIdColumn}
          AND mute_reason."rule_code" = 'MUTE_ACTIVE_DELETE'
      ) AS "activeMuteDeleteReason",
      ${this.botMessageAutoDeleteOnlySql(intentIdColumn)} AS "botMessageAutoDeleteOnly",
      EXISTS (
        SELECT 1
        FROM "moderation_delete_intent_reasons" ocr_reason
        WHERE ocr_reason."intent_id" = ${intentIdColumn}
          AND ocr_reason."rule_code" = ${COMMERCIAL_OCR_DELETE_RULE_CODE}
      ) AS "commercialOcrDeleteReason",
      EXISTS (
        SELECT 1
        FROM "moderation_delete_intent_reasons" commercial_reason
        WHERE commercial_reason."intent_id" = ${intentIdColumn}
          AND commercial_reason."rule_code" = ${COMMERCIAL_OCR_DELETE_RULE_CODE}
          AND COALESCE(commercial_reason."metadata"->>'source', '') <> 'image_text_ocr'
      ) AS "standardCommercialOcrDeleteReason",
      ${this.durableUserDeleteReasonSql(intentIdColumn)} AS "durableUserDeleteReason",
      EXISTS (
        SELECT 1
        FROM "moderation_delete_intent_reasons" non_ocr_reason
        WHERE non_ocr_reason."intent_id" = ${intentIdColumn}
          AND non_ocr_reason."rule_code" <> ${COMMERCIAL_OCR_DELETE_RULE_CODE}
          AND non_ocr_reason."rule_code" NOT IN (${Prisma.join([...REPORT_GUARDED_RULES])})
          AND non_ocr_reason."rule_code" <>
            ${CHANNEL_AUTO_POST_FORWARD_REPLACEMENT_CLEANUP_RULE_CODE}
      ) AS "nonCommercialOcrDeleteReason",
      EXISTS (
        SELECT 1 FROM "moderation_delete_intent_reasons" report_reason
        WHERE report_reason."intent_id" = ${intentIdColumn}
          AND report_reason."rule_code" IN (${REPORT_DELETE_RULE}, ${REPORT_COMMAND_RULE})
      ) AS "reportDeleteReason",
      EXISTS (
        SELECT 1 FROM "moderation_delete_intent_reasons" report_reason
        WHERE report_reason."intent_id" = ${intentIdColumn}
          AND report_reason."rule_code" = ${REPORT_COUNTER_RULE}
      ) AS "reportCounterCleanupReason",
      (EXISTS (
        SELECT 1 FROM "moderation_delete_intent_reasons" history_reason
        WHERE history_reason."intent_id" = ${intentIdColumn}
          AND history_reason."rule_code" = ${REPORT_DELETE_RULE}
          AND history_reason."metadata"->>'reportTargetMessageId' <> ${intentMessageIdColumn}
      ) AND NOT EXISTS (
        SELECT 1 FROM "moderation_delete_intent_reasons" urgent_reason
        WHERE urgent_reason."intent_id" = ${intentIdColumn} AND (
          urgent_reason."rule_code" <> ${REPORT_DELETE_RULE}
          OR urgent_reason."metadata"->>'reportTargetMessageId' IS NULL
          OR urgent_reason."metadata"->>'reportTargetMessageId' = ${intentMessageIdColumn}
        )
      )) AS "reportHistoryOnly",
      EXISTS (
        SELECT 1
        FROM "moderation_delete_intent_reasons" image_text_reason
        WHERE image_text_reason."intent_id" = ${intentIdColumn}
          AND image_text_reason."rule_code" = ${COMMERCIAL_OCR_DELETE_RULE_CODE}
          AND COALESCE(image_text_reason."metadata"->>'source', '') = 'image_text_ocr'
          AND COALESCE(image_text_reason."metadata"->>'enforcementScope', '') = 'delete_only'
      ) AS "imageTextStopListDeleteReason",
      (
        EXISTS (
          SELECT 1
          FROM "moderation_delete_intent_reasons" image_text_reason
          WHERE image_text_reason."intent_id" = ${intentIdColumn}
            AND image_text_reason."rule_code" = ${COMMERCIAL_OCR_DELETE_RULE_CODE}
            AND COALESCE(image_text_reason."metadata"->>'source', '') = 'image_text_ocr'
            AND COALESCE(image_text_reason."metadata"->>'enforcementScope', '') = 'delete_only'
        )
        AND NOT EXISTS (
          SELECT 1
          FROM "moderation_delete_intent_reasons" independent_reason
          WHERE independent_reason."intent_id" = ${intentIdColumn}
            AND NOT (
              independent_reason."rule_code" = ${COMMERCIAL_OCR_DELETE_RULE_CODE}
              AND COALESCE(independent_reason."metadata"->>'source', '') = 'image_text_ocr'
              AND COALESCE(independent_reason."metadata"->>'enforcementScope', '') = 'delete_only'
            )
        )
      ) AS "imageTextStopListDeleteOnly",
      (
        EXISTS (
          SELECT 1
          FROM "moderation_delete_intent_reasons" link_reason
          WHERE link_reason."intent_id" = ${intentIdColumn}
            AND link_reason."rule_code" IN (${Prisma.join([
              LINK_BLOCKED_DELETE_RULE_CODE,
              LINK_HISTORY_RECOVERY_RULE_CODE,
            ])})
        )
        AND NOT EXISTS (
          SELECT 1
          FROM "moderation_delete_intent_reasons" non_link_reason
          WHERE non_link_reason."intent_id" = ${intentIdColumn}
            AND non_link_reason."rule_code" NOT IN (${Prisma.join([
              LINK_BLOCKED_DELETE_RULE_CODE,
              LINK_HISTORY_RECOVERY_RULE_CODE,
              COMMERCIAL_OCR_DELETE_RULE_CODE,
              CHANNEL_AUTO_POST_FORWARD_REPLACEMENT_CLEANUP_RULE_CODE,
            ])})
        )
      ) AS "linkFamilyDeleteOnly"
      ,
      (
        EXISTS (
          SELECT 1
          FROM "moderation_delete_intent_reasons" photo_reason
          WHERE photo_reason."intent_id" = ${intentIdColumn}
            AND photo_reason."rule_code" = 'DUPLICATE_DELETE'
            AND COALESCE(photo_reason."metadata"->>'duplicateSource', '') = 'photo'
        )
        AND NOT EXISTS (
          SELECT 1
          FROM "moderation_delete_intent_reasons" independent_reason
          WHERE independent_reason."intent_id" = ${intentIdColumn}
            AND independent_reason."rule_code" <> ${COMMERCIAL_OCR_DELETE_RULE_CODE}
            AND independent_reason."rule_code" <>
              ${CHANNEL_AUTO_POST_FORWARD_REPLACEMENT_CLEANUP_RULE_CODE}
            AND (
              independent_reason."rule_code" <> 'DUPLICATE_DELETE'
              OR COALESCE(independent_reason."metadata"->>'duplicateSource', '') <> 'photo'
            )
        )
      ) AS "photoDuplicateDeleteOnly"
      ,
      EXISTS (
        SELECT 1
        FROM "moderation_delete_intent_reasons" night_cleanup_reason
        WHERE night_cleanup_reason."intent_id" = ${intentIdColumn}
          AND night_cleanup_reason."rule_code" = ${NIGHT_MODE_CLOSE_NOTICE_CLEANUP_RULE_CODE}
      ) AS "nightModeCloseNoticeCleanupReason"
      ,
      (
        EXISTS (
          SELECT 1
          FROM "moderation_delete_intent_reasons" night_cleanup_reason
          WHERE night_cleanup_reason."intent_id" = ${intentIdColumn}
            AND night_cleanup_reason."rule_code" = ${NIGHT_MODE_CLOSE_NOTICE_CLEANUP_RULE_CODE}
        )
        AND NOT EXISTS (
          SELECT 1
          FROM "moderation_delete_intent_reasons" independent_reason
          WHERE independent_reason."intent_id" = ${intentIdColumn}
            AND independent_reason."rule_code" <> ${NIGHT_MODE_CLOSE_NOTICE_CLEANUP_RULE_CODE}
        )
      ) AS "nightModeCloseNoticeCleanupOnly"
      ,
      (
        SELECT night_cleanup_reason."metadata"->'nightModeCloseNoticeCleanup'
        FROM "moderation_delete_intent_reasons" night_cleanup_reason
        WHERE night_cleanup_reason."intent_id" = ${intentIdColumn}
          AND night_cleanup_reason."rule_code" = ${NIGHT_MODE_CLOSE_NOTICE_CLEANUP_RULE_CODE}
        ORDER BY night_cleanup_reason."created_at" ASC, night_cleanup_reason."id" ASC
        LIMIT 1
      ) AS "nightModeCloseNoticeCleanupBinding"
    `;
  }

  private botMessageAutoDeleteOnlySql(intentIdColumn: Prisma.Sql): Prisma.Sql {
    return Prisma.sql`(
      EXISTS (
        SELECT 1
        FROM "moderation_delete_intent_reasons" auto_delete_reason
        WHERE auto_delete_reason."intent_id" = ${intentIdColumn}
          AND auto_delete_reason."rule_code" = ${BOT_MESSAGE_AUTO_DELETE_RULE_CODE}
      )
      AND NOT EXISTS (
        SELECT 1
        FROM "moderation_delete_intent_reasons" other_reason
        WHERE other_reason."intent_id" = ${intentIdColumn}
          AND other_reason."rule_code" NOT IN (
            ${BOT_MESSAGE_AUTO_DELETE_RULE_CODE},
            ${COMMERCIAL_OCR_DELETE_RULE_CODE},
            ${CHANNEL_AUTO_POST_FORWARD_REPLACEMENT_CLEANUP_RULE_CODE}
          )
      )
    )`;
  }

  private botMessageAutoDeleteRetryLimitApplicableSql(
    intentIdColumn: Prisma.Sql,
    commercialOcrGuardRequiredColumn: Prisma.Sql,
  ): Prisma.Sql {
    return Prisma.sql`(
      ${commercialOcrGuardRequiredColumn} = FALSE
      AND EXISTS (
        SELECT 1
        FROM "moderation_delete_intent_reasons" retry_cap_auto_delete_reason
        WHERE retry_cap_auto_delete_reason."intent_id" = ${intentIdColumn}
          AND retry_cap_auto_delete_reason."rule_code" = ${BOT_MESSAGE_AUTO_DELETE_RULE_CODE}
        OFFSET 0
      )
      AND NOT EXISTS (
        SELECT 1
        FROM "moderation_delete_intent_reasons" retry_cap_other_reason
        WHERE retry_cap_other_reason."intent_id" = ${intentIdColumn}
          AND retry_cap_other_reason."rule_code" <> ${BOT_MESSAGE_AUTO_DELETE_RULE_CODE}
        OFFSET 0
      )
    )`;
  }

  private intentColumnsSql(alias?: string): Prisma.Sql {
    const column = (name: string) =>
      alias ? Prisma.raw(`"${alias}"."${name}"`) : Prisma.raw(`"${name}"`);
    return Prisma.sql`
      ${column('id')} AS "id",
      ${column('chat_id')} AS "chatId",
      ${column('message_id')} AS "messageId",
      ${column('subject_user_id')} AS "subjectUserId",
      ${column('source_message_at')} AS "sourceMessageAt",
      ${column('entity_type')} AS "entityType",
      ${column('message_author_kind')} AS "messageAuthorKind",
      ${column('origin_bot_id')} AS "originBotId",
      ${column('routing_policy')} AS "routingPolicy",
      ${column('retention_owned')} AS "retentionOwned",
      ${column('suggestion_subscription_id')} AS "suggestionSubscriptionId",
      ${column('commercial_ocr_guard_required')} AS "commercialOcrGuardRequired",
      ${column('commercial_ocr_deadline_at')} AS "commercialOcrDeadlineAt",
      ${column('status')} AS "status",
      ${column('execute_at')} AS "executeAt",
      ${column('next_attempt_at')} AS "nextAttemptAt",
      ${column('retry_until_at')} AS "retryUntilAt",
      ${column('attempt_count')} AS "attemptCount",
      ${column('last_bot_id')} AS "lastBotId",
      ${column('succeeded_bot_id')} AS "succeededBotId",
      ${column('delete_dispatch_started_at')} AS "deleteDispatchStartedAt",
      ${column('delete_dispatch_started_bot_id')} AS "deleteDispatchStartedBotId",
      ${column('remote_delete_succeeded_at')} AS "remoteDeleteSucceededAt",
      ${column('remote_delete_succeeded_bot_id')} AS "remoteDeleteSucceededBotId",
      ${column('candidate_failures')} AS "candidateFailures",
      ${column('last_status_code')} AS "lastStatusCode",
      ${column('last_error_code')} AS "lastErrorCode",
      ${column('last_error')} AS "lastError",
      ${column('lease_token')} AS "leaseToken",
      ${column('lease_expires_at')} AS "leaseExpiresAt",
      ${column('leased_from_status')} AS "leasedFromStatus"
    `;
  }

  private serializeMetadata(value: unknown): string | null {
    if (value === undefined || value === null) {
      return null;
    }
    try {
      return JSON.stringify(value);
    } catch {
      return JSON.stringify({ serializationError: 'metadata_not_serializable' });
    }
  }

  private resolveRoutingPolicy(
    input: EnsureModerationDeleteIntentInput,
    chatId: string,
  ): 'delete_capable' | 'origin_first' | 'origin_only' {
    const userAuthoredChat = input.entityType === 'CHAT' && input.messageAuthorKind === 'user';
    const replacementCleanupRoutingRequested = this.isReplacementCleanupRuleCode(
      input.ruleCode ?? input.reasonKey,
    );
    const crossBotEnabled =
      replacementCleanupRoutingRequested ||
      this.crossBotCanaryChatIds.has('*') ||
      this.crossBotCanaryChatIds.has(chatId);
    if (!userAuthoredChat || !crossBotEnabled) {
      return 'origin_only';
    }
    if (input.routingPolicy === 'origin_first') {
      return 'origin_first';
    }
    return input.routingPolicy === 'delete_capable' ? 'delete_capable' : 'origin_only';
  }

  private toDate(value: Date | string | null | undefined, fallback: Date): Date {
    if (value === undefined || value === null) {
      return fallback;
    }
    const parsed = value instanceof Date ? new Date(value) : new Date(value);
    if (Number.isNaN(parsed.getTime())) {
      throw new Error(`Invalid date: ${String(value)}`);
    }
    return parsed;
  }

  private toNullableDate(value: Date | string | null | undefined): Date | null {
    return value === undefined || value === null ? null : this.toDate(value, new Date());
  }

  private optionalString(value: string | null | undefined): string | null {
    if (typeof value !== 'string') {
      return null;
    }
    const normalized = value.trim();
    return normalized || null;
  }

  private readPositiveInt(value: unknown, fallback: number): number {
    const numeric = Number(value);
    return Number.isInteger(numeric) && numeric > 0 ? numeric : fallback;
  }

  private readBoolean(value: unknown, fallback: boolean): boolean {
    if (typeof value === 'boolean') {
      return value;
    }
    if (typeof value === 'string') {
      const normalized = value.trim().toLowerCase();
      if (['1', 'true', 'yes', 'on'].includes(normalized)) {
        return true;
      }
      if (['0', 'false', 'no', 'off'].includes(normalized)) {
        return false;
      }
    }
    return fallback;
  }

  private asRecord(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
  }

  private firstString(...values: unknown[]): string {
    for (const value of values) {
      if (typeof value === 'string' && value.trim()) {
        return value.trim();
      }
    }
    return '';
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}

export type {
  EnsureModerationDeleteIntentInput,
  EnsureModerationDeleteIntentResult,
  ModerationDeleteAttemptResult,
  ModerationDeleteIntentSnapshot,
};
