import {
  channelSettingsForSource,
  marketplacePostIsEligible,
} from './channel-marketplace-decoration';
import { withMarketplaceModerationMessage } from '../max/marketplace-publication-button';
import { needsAutomaticMuteCleanup, persistAutomaticMuteCleanup } from './automatic-mute-cleanup';
import { runCanonicalWebhookHandler } from './canonical-webhook-handler';
import { verifyFreshHeldCommandAccess } from '../webhook/webhook-legacy-fresh-command';
import { bindVoiceSourceEvidence, captureVoiceSourceInput } from './voice-webhook-source';
import {
  buildActiveMuteDeleteIntent,
  type ActiveMuteMessageInput,
} from './active-mute-delete-intent';
import {
  describeWebhookExecutionFailure,
  logWebhookExecutionFailure,
  type WebhookExecutionFailureStage,
} from './webhook-execution-diagnostic';
import {
  resolveConfiguredRuleEscalation,
  resolveMessageLimitsRuleEscalation,
} from './moderation-rule-escalation';
import { ModerationRuleFollowupService } from './moderation-rule-followup.service';
import { RequiredSubscriptionCandidateStore } from './required-subscription-candidate.store';
import type { RequiredSubscriptionCandidateAttempt } from './required-subscription-candidate.contract';
import {
  executeRequiredSubscriptionCandidate,
  nominateRequiredSubscriptionCandidate,
} from './required-subscription-candidate-adapter';
import { legacyBotCleanupSourceAt } from './legacy-bot-message-cleanup-source';
import {
  WebhookLegacyHoldService,
  type WebhookLegacyHoldDatabase,
} from '../webhook/webhook-legacy-hold.service';
import {
  DURABLE_RULE_FOLLOWUP_RULES,
  ModerationRuleFollowupSourceExpiredError,
  readRuleFollowupEnvelope,
} from './moderation-rule-followup-persistence';
import {
  executeRuleFollowupSanction,
  type RuleFollowupBanOutcome,
} from './moderation-rule-followup-sanction';
import type {
  ModerationRuleFollowup,
  ModerationRuleFollowupPlan,
  ModerationRuleFollowupJournal,
} from './moderation-rule-followup.contract';
import { ModerationRuleSanctionRejectedError } from './moderation-rule-sanction-authority';
import { fingerprintModerationSettings } from './moderation-settings-fingerprint';
import { STOP_WORDS_DELETE_RULE_CODES } from './stop-words/stop-words-delete-guard.service';
import { MAX_MEMBER_ACTION_PRE_DISPATCH_RETRY_ERROR_CODES } from '../max/max-action-ledger.service';
import { executeModerationRuleFollowUp } from './moderation-rule-followup-execution';
import type { RuleFollowupExecutionContext } from './moderation-rule-followup.contract';
import { ModerationRuleSanctionGuardService } from './moderation-rule-sanction-guard.service';
import { ModerationStateDeleteGuardService } from './moderation-state-delete-guard.service';
import {
  RequiredSubscriptionExecutionGuardService,
  RequiredSubscriptionExecutionRejectedError,
  RequiredSubscriptionInitialSourceUnavailableError,
  RequiredSubscriptionMembershipUnavailableError,
} from './required-subscription-execution-guard.service';
import { handoffRequiredSubscriptionDelete } from './required-subscription-delete-handoff';
import { MESSAGE_LIMITS_STATEFUL_RULES } from './message-limits-delete-guard.service';
import {
  bindModerationExecutionPolicy,
  buildModerationNoticeDispatchOptions,
  createBotAccountKickOptions,
  createModerationNoticeGuard,
  createRequiredSubscriptionAssertion,
  createRequiredSubscriptionEvidence,
  createRequiredSubscriptionNoticeHandoff,
  createRequiredSubscriptionSanctionCallbacks,
  createRuleSanctionGuards,
  createDuplicateSanctionNoticeDispatchOptions,
  runRuleFollowUpWhileAuthorized,
  createSpammerKickOptions,
  resolveModerationMuteDurationHours,
} from './moderation-execution-guard-callbacks';
import { isMaxMutationOutcomeAmbiguous } from '../max/max-mutation-outcome.util';
import { resolveExplicitMembershipAccessDenial } from '../max/max-membership-access-error';
import {
  ClosedChatMessageModerationService,
  type NightClosedChatMessage,
  type ManuallyClosedChatMessage,
} from './closed-chat-message-moderation.service';
import { resolveModerationSanctionExpiry } from './moderation-sanction-expiry.util';
import { CommercialReviewService } from './commercial/commercial-review.service';
import { buildCommercialTextQualityObservation } from './commercial/commercial-quality-observation';
import { CommercialLlmEnforcementService } from './commercial/commercial-llm-enforcement.service';
import {
  prepareCommercialQualityDelete,
  recordCommercialQualityExecution,
} from './commercial/commercial-quality-capture';
import { extractCommercialOcrSourceCreatedAt } from './commercial-ocr/commercial-ocr-source-time';
import { collectCommercialCampaignContextFromRedis } from './commercial/commercial-campaign-context';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  Optional,
  type Type,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ReportSubmissionService } from './reports/report-submission.service';
import { isTrafficProtectionViolation } from './traffic-protection';
import {
  executeGuardedModerationDelete,
  prepareModerationDeleteIntentInput,
  type ModerationDeleteExecutionOptions,
} from './moderation-delete-execution';
import { isCommercialMessageDeleteEligible } from './commercial';
import {
  ADMIN_BAN_ALL_COMMAND_NAME_DEFAULT,
  ADMIN_BAN_COMMAND_NAME_DEFAULT,
  ADMIN_MUTE_COMMAND_NAME_DEFAULT,
  ADMIN_PERMANENT_MUTE_COMMAND_NAME_DEFAULT,
  ADMIN_RULES_COMMAND_NAME_DEFAULT,
  DEFAULT_BROADCAST_BUTTON_TEXT,
  INVITATION_ACCESS_REQUIRED_COUNT_MAX,
  INVITATION_ACCESS_REQUIRED_COUNT_MIN,
  MAX_BROADCAST_LINK_BUTTONS_PER_ROW,
  REQUIRED_SUBSCRIPTION_MAX_CHANNELS,
  normalizeDeleteBotMessagesDelayMinutes,
  resolveCommercialSanctionAction,
  type MaxUpdate,
} from '@maxim/contracts';
import {
  getBotSpeechEditableTemplate,
  getBotSpeechSystemTemplate,
  type BotSpeechEditableFieldKey,
  type BotSpeechMediaFieldKey,
  type BotSpeechStyle,
  type BotSpeechSystemTemplateKey,
} from '@maxim/contracts/bot-speech';
import {
  ChatBotMembershipStatus,
  ChatCatalogKind,
  ChatEntityType,
  EventType,
  Operator,
  Prisma,
  SanctionAction,
  WebhookStatus,
  type ChannelSettings as PersistedChannelSettings,
  type ChatSettings,
} from '../prisma/prisma-client';
import { UnrecoverableError, type Job } from 'bullmq';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import {
  MAX_API_SOURCE_TAGS,
  MaxClientService,
  wasMaxMessageSendAttempted,
  type MaxActionDispatchOptions,
  type MaxActionLedgerContext,
  type MaxChatMemberAccess,
  type MaxLinkButton,
  type MaxMessageButton,
  type MaxSendMessageOptions,
} from '../max/max-client.service';
import {
  isAmbiguousMaxMutationError,
  isAmbiguousMaxSendError,
  MAX_SEND_AMBIGUOUS_ERROR_PREFIX,
} from '../max/max-send-ambiguity.util';
import { MaxBotContextService } from '../max/max-bot-context.service';
import { MaxActionLedgerService } from '../max/max-action-ledger.service';
import {
  wasMaxPreDispatchGuardRejected,
  withMaxFinalAuthorityCheckpoint,
} from '../max/max-action-pre-dispatch-guard';
import { wasMaxMemberMutationAttempted } from '../max/max-member-error.util';
import { MaxChatAdminRosterSyncService } from '../max/max-chat-admin-roster-sync.service';
import {
  isValidMaxBotStartPayload,
  isValidMaxMiniappStartPayload,
} from '../max/max-deep-link.util';
import {
  MaxBotLinkService,
  type ChatBotExecutionBinding,
  type MaxBotRoute,
  type MaxBotRouteRequest,
} from '../max/max-bot-link.service';
import {
  classifyMaxTerminalChatActionError,
  ManagedEntityAccessLossService,
} from '../max/managed-entity-access-loss.service';
import {
  isMaxMembershipLookupLocalQuotaResolution,
  MaxMembershipLookupService,
  type MaxMembershipLookupResolution,
} from '../max/max-membership-lookup.service';
import { hasConfirmedDeleteMessageAccess } from '../max/max-delete-message-access.util';
import { hasMaxInsufficientRightsMessage } from '../max/max-member-error.util';
import { AdminDialogLinkService } from '../admin/admin-dialog-link.service';
import { ChannelPostSignatureService } from '../admin/channel-post-signature.service';
import { ManualModerationService } from '../admin/manual-moderation.service';
import { ManagedPollService } from '../admin/managed-poll.service';
import type { AuthUser } from '../common/decorators/current-user.decorator';
import {
  appendAdminContactMarkdownLink as appendAdminContactMarkdownLinkText,
  resolveAdminContactMentionTarget,
} from '../common/admin-contact-link.util';
import {
  MAX_MESSAGE_TEXT_LENGTH,
  prepareFormattedTextForMaxDelivery,
} from '../common/max-markdown.util';
import {
  normalizeMaxUserDisplayName,
  resolveMaxUserDisplayName,
} from '../common/max-user-display-name.util';
import {
  BOT_PRIVATE_MENU_APP_LINE,
  buildBotStartQuickActionText,
} from '../common/bot-start-greeting';
import { raceWithTimeout } from '../common/promise-timeout.util';
import { buildUserAgreementShortNotice } from '../common/user-agreement-notice';
import { PrismaService } from '../prisma/prisma.service';
import { getAppRole, roleRunsModeration } from '../runtime/app-role';
import { moderationBackgroundTasksEnabled } from '../runtime/moderation-runtime';
import { QueueMetricsService } from '../system/queue-metrics.service';
import { BackgroundRuntimeGovernorService } from '../system/background-runtime-governor.service';
import { RuntimeDiagnosticsService } from '../system/runtime-diagnostics.service';
import { buildWebhookSemanticEventKey } from '../webhook/webhook-semantic-event-key';
import {
  WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINE_MAX_LIFETIME_MS,
  WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINE_PERSIST_RETRY_MS,
  WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINE_PREFIX,
} from '../webhook/webhook-timeout-quarantine';
import {
  SystemModeService,
  isSystemModeRecoveryWindow,
  type SystemModeSnapshot,
} from '../system/system-mode.service';
import { ChatContextCacheService } from '../chat-context/chat-context-cache.service';
import * as rulesFence from './chat-rules-own-bot-message-classifier';
import * as protectedEventFence from './own-bot-protected-event-classifier';
import { ModerationExecutionService } from './moderation-execution.service';
import { buildManagedPublicationAutoDeleteFenceWhere } from './managed-publication-auto-delete-fence';
import { findManagedHandshakeAutoDeleteOwner } from './managed-handshake-auto-delete-fence';
import { isManagedHandshakeConfirmationText } from '../max/managed-handshake-confirmation';
import {
  createDuplicateDeleteAuthorizationGuard,
  createDuplicateSanctionAuthorization,
  createDuplicateMemberMutationGuard,
} from './duplicate-execution-guards';
import * as duplicateSafety from './duplicate-enforcement-safety';
import { resolveDuplicateRuleEligibility } from './moderation-rule-competition';
import {
  buildModerationMessageViolationProcessingClaimKey,
  resolveDuplicateMessageActionClaim,
  type DurableModerationMessageActionClaimResult,
  type TerminalDuplicateSanctionEventModel,
} from './moderation-message-action-claim';
import {
  claimAndPersistModerationMessageViolation,
  claimPersistedMessageViolationProcessing,
} from './moderation-violation-persistence';
import { ModerationDeleteIntentService } from './moderation-delete-intent.service';
import { ProfanityDeleteGuardService } from './profanity/profanity-delete-guard.service';
import {
  CommercialDeleteGuardService,
  type CommercialSanctionPermit,
} from './commercial/commercial-delete-guard.service';
import { bindCommercialTextDeleteIntent } from './commercial/commercial-delete-binding';
import {
  type ModerationDeleteExecutionResult,
  type ProfanityDeleteMutationHooks,
} from './profanity/profanity-delete-execution';
import type {
  EnsureModerationDeleteIntentInput,
  ModerationDeletePreDispatchPhase,
} from './moderation-delete-intent.types';
import { resolveTrustedDuplicateStateRevision } from './duplicate-message-revision';
import {
  CommercialOcrEnqueueService,
  type CommercialOcrPendingActivation,
} from './commercial-ocr/commercial-ocr-enqueue.service';
import {
  hasActionableCompetingViolation,
  resolveCommercialOcrEnqueueCandidate,
} from './commercial-ocr/commercial-ocr-enqueue-candidate';
import {
  consumeLegacyParticipantModerationImmunity,
  ParticipantModerationImmunityService,
} from './participant-moderation-immunity.service';
import { PhotoDuplicateEnqueueService } from './photo-duplicate/photo-duplicate-enqueue.service';
import { MessageDuplicateService } from './message-duplicate/message-duplicate.service';
import {
  executeDuplicateModerationAction,
  duplicateExplanationIdempotencyKey,
  duplicateSanctionNoticeIdempotencyKey,
  type DuplicateModerationActionRequest,
} from './duplicate-moderation.actions';
import type { PhotoDuplicateModerationActionRequest } from './photo-duplicate/photo-duplicate-moderation.actions';
import { buildMessageDuplicateNoticeContext } from './message-duplicate/message-duplicate-notice-proof';
import type { LogicalPhotoAlbum } from './photo-duplicate/photo-attachment-extractor';
import {
  buildChatAutoCommentAuditId,
  CHANNEL_AUTO_POST_ATTACH_STATUS,
  persistChannelAutoPostPreDispatchFailureEvidence,
  ReplacementAttachMarkerStore,
} from './replacement-attach-marker.store';
import {
  buildMessageLimitsExplanationReplacements,
  buildLegacyDuplicatePassiveSanctionLabel,
  buildLegacyDuplicateSanctionLabel,
  hasCustomBotSpeechTemplate,
  resolveBotSpeechDuplicateContext,
  resolveBotSpeechMessageStatus,
  resolveBotSpeechPlaceholder,
  resolveMessageLimitsSanctionReason,
  resolveTextFilterExplanationReason,
} from './bot-speech-custom-override.util';
import { PrivateControlService } from './private-control.service';
import { ModerationAccessService } from './moderation-access.service';
import {
  ACTIVE_MUTE_CACHE_SLACK_SEC,
  ACTIVE_MUTE_NEGATIVE_CACHE_TTL_SEC,
  PERMANENT_ACTIVE_MUTE_CACHE_TTL_SEC,
  buildActiveMuteStateKey,
  type CachedActiveMuteState,
} from './moderation-state.util';
import {
  deliverSanctionNotice,
  type SanctionNoticeParams,
  type ModerationNoticeImmediateOptions,
} from './moderation-sanction-notice-delivery';
import {
  RequiredSubscriptionNoticePlanStore,
  buildRequiredSubscriptionNoticePlan,
  withRequiredSubscriptionHtmlMessageOptions,
  type RequiredSubscriptionNoticeAction,
  type RequiredSubscriptionPersistedDecision,
} from './required-subscription-notice-plan';
import {
  RequiredSubscriptionMediaNoticeCoordinator,
  bindRequiredSubscriptionMediaNoticeScope,
  resolveRequiredSubscriptionMediaNoticeScope,
  type RequiredSubscriptionMediaNoticeScope,
} from './required-subscription-media-notice';
import { ModerationReleaseCallbackService } from './moderation-release-callback.service';
import {
  ModerationSanctionStateFenceService,
  type ModerationSanctionStateFence,
} from './moderation-sanction-state-fence.service';
import {
  ModerationSanctionStateLockError,
  ModerationSanctionStateLockLeaseLostError,
  ModerationSanctionStateLockService,
  type ModerationSanctionStateLeaseGuard,
} from './moderation-sanction-state-lock.service';
import {
  extractMaxCallbackId,
  extractMaxCallbackPayload,
  extractMaxCallbackPayloadRaw,
  extractMaxCallbackUserId,
} from './max-callback-update.util';
import {
  DEVELOPER_FORCED_GLOBAL_SPAMMER_CACHE_TTL_SEC,
  DEVELOPER_FORCED_GLOBAL_SPAMMER_MEMORY_CACHE_TTL_MS,
  DEVELOPER_FORCED_GLOBAL_SPAMMER_WARM_MARKER_TTL_SEC,
  buildDeveloperForcedGlobalSpammerCacheKey,
  buildDeveloperForcedGlobalSpammerWarmMarkerKey,
} from './developer-forced-global-spammer-cache';
import { RedisCounterService } from './redis-counter.service';
import type {
  DuplicateAction,
  DuplicateDecision,
  DuplicateHit,
  RuleViolation,
} from './rule-engine.contract';
import { selectTopModerationViolation } from './moderation-violation-selection';
import { RuleEngineService } from './rule-engine.service';
import { StopWordsDeleteGuardService } from './stop-words/stop-words-delete-guard.service';
import { extractStopWordsTextSegments } from './stop-words/stop-words.detection';
import {
  isStopWordsImageScanEnabled,
  readStopWordsPolicy,
  withStopWordsSanctions,
} from './stop-words/stop-words.policy';
import {
  needsFreshLinkAllowlistRecheck,
  recalculateFreshLinkAllowlistViolations,
  serializeLinkPolicyEffectiveAt,
  suppressUnverifiedAllowlistDependentViolations,
} from './link-allowlist-recheck.util';
import { LINK_BLOCKED_DELETE_RULE_CODE } from './link-history-recovery.util';
import {
  extractEnabledWebhookNavigationTargets,
  resolveEnabledNavigationTargetOptions,
  type EnabledNavigationTargetOptions,
} from './navigation/enabled-navigation-targets';
import type { NavigationTargetEvidence } from './navigation/navigation-evidence.types';
import { MessageLimitsBlockedDomainDetector } from './rule-engine-blocked-domains.detector';
import { SanctionService } from './sanction.service';
import { maskText } from './text-mask.util';
import {
  calculateEffectiveMessageLength,
  collectForwardedNodes,
  detectMediaFlags,
  extractDirectMediaBatchId,
  extractRawMessageNode,
  hasForwardedMessage,
  shouldSkipAntiSpamBurstForForward,
} from './moderation-update-extractors';
import {
  dedupeForwardedModerationTargets,
  dedupeForwardedRulesSources,
  extractDirectIncomingMessageText,
  extractForwardedModerationTargets,
  extractForwardedRulesSources,
  getAdminCommandName,
  parseAdminForwardedModerationCommand,
  recognizesAdminForwardedModerationCommand,
} from './admin-forwarded-command.util';
import {
  readExecutionOwnerBotId as readExecutionOwnerBotIdFromUpdate,
  resolveAutoAttachBotId as resolveAutoAttachBotIdForModeration,
  resolveChatReadBotId as resolveChatReadBotIdForModeration,
  resolveModerationActionBotIds as resolveModerationActionBotIdsForModeration,
  resolveNightModeTransitionBotId as resolveNightModeTransitionBotIdForModeration,
  resolveUnifiedBotRoute as resolveUnifiedBotRouteForModeration,
} from './moderation-bot-routing.util';
import type { CommercialCampaignContext } from './commercial-campaign.util';
import {
  GlobalSpammerIntelligenceService,
  type GlobalSpammerObservationSource,
} from './global-spammer-intelligence.service';
import { extractHttpStatusCode } from '../common/http-error.util';
import {
  buildChannelAutoPostButtons,
  buildChannelAutoPostGovernorRequest,
  ChannelAutoPostScanManager,
  extractChannelAutoPostDialogButtons,
  extractChannelAutoPostMessageLinkType,
  isChannelAutoPostMessage,
  isChannelAutoPostKeyboardOnly,
  prepareChannelAutoPostDecoration,
  buildChannelAutoPostTextMutationOptions,
  resolveChannelAutoPostButtonVisibility,
  resolveChannelAutoPostEventTimestampMs,
  resolveChannelAutoPostMessageText,
  type ChannelAutoPostAttachOutcome,
  type ChannelAutoPostScanState,
} from './channel-auto-post-runtime';
import {
  ChannelAutoPostScanRuntime,
  processChannelAutoPostListedMessages,
  type ChannelAutoPostAttachParams,
} from './channel-auto-post-scan-runtime';
import {
  ChannelAutoPostMutationGuard,
  resolveInitialChannelMutationRoute,
} from './channel-auto-post-mutation-guard';
import { loadManagedChannelAutoPostContext } from './channel-auto-post-context';
import { ChannelAutoPostLegacyRecovery } from './channel-auto-post-legacy-recovery';
import { ChannelPostDemandRuntime } from './channel-post-demand-runtime';
import {
  buildMaxMessageFallbackUrl,
  recordChannelAutoPostTerminalSkip,
} from './channel-auto-post-reply-fallback';
import {
  DEFAULT_WEBHOOK_QUEUE_NAMES,
  JOIN_WEBHOOK_QUEUE_NAMES,
  LEGACY_WEBHOOK_QUEUE,
  type AnyWebhookQueueName,
  type ProcessWebhookJob,
  WEBHOOK_QUEUE_BACKGROUND,
  WEBHOOK_QUEUE_CRITICAL,
} from '../webhook/webhook-queues';

import {
  CALLBACK_TERMINAL_FAILURE_METRIC_STATUSES,
  PRIVATE_DIALOG_TERMINAL_FAILURE_METRIC_STATUSES,
  CHAT_DELETE_MESSAGE_PERMISSION_ALIASES,
  DEFAULT_MUTE_DURATION_HOURS,
  MAX_ACTIVE_MUTE_DURATION_HOURS,
  DELETE_MESSAGE_PERMISSION_ALIASES,
  MODERATE_MEMBER_PERMISSION_ALIASES,
  DEFAULT_BOT_BUTTON_TEXT,
  RULES_BOT_BUTTON_TEXT,
  RULES_CALLBACK_PAYLOAD,
  DEFAULT_NIGHT_MODE_TIMEZONE,
  LINK_ESCALATION_WINDOW_HOURS,
  TEXT_FILTER_ESCALATION_WINDOW_HOURS,
  PROFANITY_AUTOMATIC_ESCALATION_MIN_SCORE,
  MESSAGE_LIMITS_ESCALATION_WINDOW_HOURS,
  REQUIRED_SUBSCRIPTION_ESCALATION_WINDOW_HOURS,
  REQUIRED_SUBSCRIPTION_MEMBER_PRESENT_TTL_SEC,
  REQUIRED_SUBSCRIPTION_MEMBER_MISSING_TTL_SEC,
  REQUIRED_SUBSCRIPTION_LOOKUP_BACKOFF_MS,
  REQUIRED_SUBSCRIPTION_CHANNEL_METADATA_CACHE_TTL_MS,
  REQUIRED_SUBSCRIPTION_RULE_CODE,
  INVITATION_ACCESS_ESCALATION_WINDOW_HOURS,
  INVITATION_ACCESS_NOTICE_COOLDOWN_SEC,
  INVITATION_ACCESS_RULE_CODE,
  MODERATION_ACTION_PERMISSION_SKIP_LOG_INTERVAL_MS,
  MODERATION_ACTION_PERMISSION_BACKOFF_MS,
  MODERATION_ACTION_PERMISSION_REFRESH_TIMEOUT_MS,
  MODERATION_ACTION_PERMISSION_REFRESH_MIN_INTERVAL_MS,
  REQUIRED_SUBSCRIPTION_UNRESOLVED_LOG_INTERVAL_MS,
  WEBHOOK_HOT_CHAT_BACKOFF_MS,
  WEBHOOK_HOT_CHAT_SKIP_LOG_INTERVAL_MS,
  WEBHOOK_HOT_TIMEOUT_BACKOFF_SUPPRESSED_STAGES,
  REQUIRED_SUBSCRIPTION_PRESSURE_SKIP_QUEUE_LAG_SEC,
  BOT_NOTICE_TOKEN_BUCKET_TTL_SEC,
  DEFAULT_BOT_NOTICE_TOKEN_BUCKET_LIMIT,
  CHAT_ADMIN_NONCRITICAL_LOOKUP_SOFT_TIMEOUT_MS,
  DESTRUCTIVE_ADMIN_ROSTER_REFRESH_THROTTLE_MS,
  BACKGROUND_WORK_PAUSE_LOG_INTERVAL_MS,
  LEGACY_MODERATION_CONCURRENCY,
  CRITICAL_MODERATION_CONCURRENCY,
  JOIN_MODERATION_SHARD_CONCURRENCIES,
  DEFAULT_MODERATION_SHARD_CONCURRENCIES,
  BACKGROUND_MODERATION_CONCURRENCY,
  SUPPORT_CHAT_URL,
  MINIAPP_ROUTE_START_PARAM_PREFIX,
  PRIVATE_MENU_CALLBACK_MENU,
  PRIVATE_MENU_CALLBACK_CHATS,
  PRIVATE_MENU_CALLBACK_CHANNELS,
  PRIVATE_MENU_CALLBACK_HELP,
  PRIVATE_BOT_CHATS_PREVIEW_LIMIT,
  MAX_FORWARD_SCAN_DEPTH,
  DEFAULT_CHANNEL_AUTO_POST_SCAN_INTERVAL_MS,
  DEFAULT_CHANNEL_AUTO_POST_SCAN_MAX_CHANNELS,
  DEFAULT_CHANNEL_AUTO_POST_INTER_CHANNEL_DELAY_MS,
  DEFAULT_CHANNEL_AUTO_POST_IDLE_BACKOFF_MAX_MS,
  DEFAULT_CHANNEL_AUTO_POST_STARTUP_DELAY_MS,
  DEFAULT_CHANNEL_AUTO_POST_STARTUP_JITTER_MS,
  DEFAULT_CHANNEL_AUTO_POST_MAX_NEW_MESSAGES_PER_SCAN,
  DEFAULT_CHANNEL_AUTO_POST_REPAIR_SWEEP_MS,
  CHANNEL_AUTO_POST_GOVERNOR_UNAVAILABLE_BACKOFF_MS,
  CHANNEL_AUTO_POST_SLOW_BATCH_DIVISOR,
  CHANNEL_AUTO_POST_SLOW_INTER_CHANNEL_DELAY_MS,
  CHANNEL_AUTO_POST_SLOW_MAX_NEW_MESSAGES_PER_SCAN,
  CHANNEL_AUTO_POST_RATE_LIMIT_BACKOFF_MS,
  DEFAULT_CHANNEL_AUTO_POST_THROTTLE_BACKOFF_MAX_MS,
  DEFAULT_BACKGROUND_WORK_SOFT_PAUSE_QUEUE_LAG_SEC,
  DEFAULT_BACKGROUND_WORK_SOFT_PAUSE_WORKER_SHARE,
  DEFAULT_BACKGROUND_WORK_SOFT_PAUSE_WORKER_PRESSURE,
  CHANNEL_DIALOG_START_PARAM_PREFIX,
  CHANNEL_DIALOG_TOKEN_PREFIX,
  SHARED_CHAT_EXECUTION_LOCK_TTL_MS,
  SHARED_CHAT_EXECUTION_LOCK_AMBIGUOUS_RETRY_AFTER_MS,
  DEFAULT_SHARED_CHAT_EXECUTION_LOOKUP_TIMEOUT_MS,
  DEFAULT_SHARED_CHAT_EXECUTION_LOCK_TIMEOUT_MS,
  DEFAULT_WEBHOOK_USER_FACING_TIMEOUT_MS,
  WEBHOOK_USER_FACING_SLOW_LOG_THRESHOLD_MS,
  WEBHOOK_OPTIONAL_STAGE_MIN_REMAINING_MS,
  REQUIRED_SUBSCRIPTION_NOTICE_MIN_REMAINING_MS,
  REQUIRED_SUBSCRIPTION_MEMBERSHIP_HOT_PATH_TIMEOUT_MS,
  REQUIRED_SUBSCRIPTION_MEMBERSHIP_MIN_REMAINING_MS,
  VIOLATION_ADMIN_RECHECK_RESERVE_MS,
  VIOLATION_FOLLOW_UP_HOT_PATH_TIMEOUT_MS,
  DUPLICATE_FOLLOW_UP_DETACH_MIN_REMAINING_MS,
  DUPLICATE_FOLLOW_UP_HOT_PATH_TIMEOUT_MS,
  CHANNEL_DIALOG_AUTO_ATTACH_ACTION,
  CHAT_DIALOG_AUTO_ATTACH_ACTION,
  GLOBAL_SPAMMER_WINDOW_SEC,
  GLOBAL_SPAMMER_REDIS_TTL_SEC,
  GLOBAL_SPAMMER_LOCAL_CHAT_OBSERVATION_TTL_MS,
  GLOBAL_SPAMMER_EXEMPTION_CACHE_TTL_MS,
  GLOBAL_SPAMMER_EXEMPTION_HOT_PATH_TIMEOUT_MS,
  GLOBAL_SPAMMER_EXEMPTION_HOT_PATH_MAX_ADMIN_IDS,
  GLOBAL_SPAMMER_TRACK_HOT_PATH_TIMEOUT_MS,
  DEVELOPER_FORCED_GLOBAL_SPAMMER_HOT_PATH_TIMEOUT_MS,
  MODERATION_ACTION_ACCESS_LOSS_HOT_PATH_TIMEOUT_MS,
  MODERATION_ACTION_DISPATCH_TIMEOUT_MS,
  MODERATION_CHAT_ACTION_TERMINAL_FAILURE_METRIC_STATUSES,
  GLOBAL_SPAMMER_HIGH_FANOUT_MIN_CHATS,
  GLOBAL_SPAMMER_EPISODE_LOCK_TTL_SEC,
  GLOBAL_SPAMMER_FANOUT_EPISODE_WINDOW_SEC,
  GLOBAL_SPAMMER_MEDIUM_FANOUT_EPISODE_THRESHOLD,
  GLOBAL_SPAMMER_STRONG_FANOUT_EPISODE_THRESHOLD,
  GLOBAL_SPAMMER_CONFIRMED_FANOUT_EPISODE_THRESHOLD,
  GLOBAL_SPAMMER_CRITICAL_FANOUT_MIN_CHATS,
  CROSS_CHAT_SPAM_ALWAYS_IGNORED_KEYS,
  NON_SANCTION_RULE_CODES,
  MESSAGE_LIMITS_RULE_CODES,
  TEXT_FILTER_RULE_CODES,
  isRequiredSubscriptionCurrentlyActive,
  isInvitationAccessCurrentlyActive,
  type ActiveMute,
  type ActiveMuteCacheReadResult,
  type ChatAdminCheckSource,
  type ChatAdminCheckResult,
  type RequiredSubscriptionChannelMetadata,
  type SharedChatExecutionGuard,
  type RemoteChatAdminAccessState,
  type ManagedChannelContext,
  type ChannelAutoPostExecutionPlan,
  type LocalGlobalSpammerAdminDecision,
  type PendingGlobalSpammerExemptionLookupBatch,
  type WebhookHotPathProfile,
  type RulesButtonReference,
  type RequiredSubscriptionMembershipLookupOptions,
  type InvitationAccessProgressSnapshot,
  type InvitationAccessProgressUpdateResult,
  type InvitationAccessProgressDelegate,
  type ChannelDialogType,
  type ModerationActionAttemptResult,
  type ModerationActionExecutionResult,
  type AdminForwardedModerationCommand,
  type GlobalSpammerTrackingResult,
  type PrivateControlCommand,
  type ActiveBotSpeechProfile,
} from './moderation.service.support';
import type {
  NightModeTransitionJob,
  NightModeTransitionProcessResult,
} from './night-mode-transition.queue';
import {
  resolveEffectiveChatClosure,
  type NightModeTransitionSnapshot,
} from './night-mode-transition-time.util';
import {
  NightModeTransitionRuntimeService,
  type NightModeTransitionRuntimeSettings,
} from './night-mode-transition-runtime.service';
import { NightModeTransitionDeliveryService } from './night-mode-transition-delivery.service';
import { NightModeTransitionSchedulerService } from './night-mode-transition-scheduler.service';
import {
  buildNightModeClosedNotice as buildNightModeClosedNoticeText,
  buildNightModeOpenedNotice as buildNightModeOpenedNoticeText,
  formatNightModeMinutesAsTime,
  isNightModeNoticeMessage as isNightModeNoticeTextMessage,
  normalizeNightModeDayMinutes,
} from './night-mode-transition-notice.util';
import {
  buildNightModeClosedNoticeOptions as composeNightModeClosedNoticeOptions,
  buildNightModeCommentsButton,
} from './night-mode-transition-closed-notice-options.util';
import {
  BotSpeechMediaService,
  type BotSpeechMediaUploadOptions,
  type BotSpeechResolvedMedia,
} from './bot-speech-media.service';
import { NightModeTransitionEventService } from './night-mode-transition-event.service';
import {
  KARAVAN_STOREFRONT_RELAY_AUDIT_ACTION,
  isKaravanStorefrontRelayCompanionText,
  KaravanStorefrontRelayService,
  type RelayContext,
} from '../integrations/karavan-storefront/karavan-storefront-relay.service';
import {
  WebhookCanonicalExecutionService,
  WebhookFinishPersistenceError,
  type WebhookCanonicalExecutionContext,
  type WebhookTimeoutQuarantineLease,
} from './webhook-canonical-execution.service';
import {
  deferWebhookOrderedPredecessorJob,
  WebhookOrderedPredecessorPendingError,
} from './webhook-ordered-predecessor-fence';
import { WebhookPreparationDeferredError } from '../common/webhook-preparation-deferred.error';
import {
  deferWebhookPreparationJob,
  WebhookPreparationRetryError,
} from './webhook-preparation-retry';
import { ModerationDisplayNameResolver } from './moderation-display-name-resolver';
import {
  persistModerationDecisionWithoutAppliedSanction,
  persistSanctionEventForNotice,
  type PersistModerationEvent,
} from './moderation-sanction-event.util';

import {
  GroupCommandAuthorityService,
  GroupCommandNoticeDeliveryError,
  runGroupCommandWithAuthority,
  type GroupCommandPermit,
} from '../common/group-command-authority.service';
import { deliverGroupCommandNotice } from '../common/group-command-notice-delivery';
import {
  recordGroupCommandNoticeRecovery,
  recoverGroupCommandNotice,
} from '../common/group-command-notice-recovery';
import { MaxExecutionOwnerReadinessService } from '../max/max-execution-owner-readiness.service';

type ManualModerationCommandBridge = Pick<
  ManualModerationService,
  | 'adoptChatRulesFromMessage'
  | 'applyManualModerationAction'
  | 'applyManualChatSilenceCommand'
  | 'applyManualOpenChatCommand'
  | 'enqueueDeveloperSuperBanCommand'
  | 'enqueueManualGroupModerationCommand'
  | 'isSuperBanDeveloperUserId'
>;

type ApplySanctionActionParams = {
  chatId: string;
  userId: string;
  action: SanctionAction;
  userLabel: string;
  messageId: string;
  muteDurationHours: number;
  deleteBotMessagesEnabled: boolean;
  deleteBotMessagesDelayMinutes: number;
  botMessageOptions?: MaxSendMessageOptions;
  sanctionNoticeText?: string;
  bypassNoticeBucket?: boolean;
  noticeIdempotencyKey?: string;
  rethrowNoticeFailure?: boolean;
  activeMuteRuleCode?: string;
  routeNoticeDynamically?: boolean;
  deferNotice?: boolean;
  onSanctionEventPersisted?: (eventId: string | null) => void;
  noticeBeforeSend?: () => Promise<void>;
  noticeLedgerContext?: MaxActionLedgerContext;
  noticeDispatchOptions?: ModerationNoticeImmediateOptions;
  botSpeechStyle: BotSpeechStyle | null;
  trackAsGlobalSpammer?: boolean;
  deferGlobalSpammerTrackingUntilConfirmedBan?: boolean;
  persistModerationEvent: PersistModerationEvent;
  assertActiveLease?: () => void | Promise<void>;
  authorizeSanction?: () => Promise<boolean>;
  beforeSanctionMutation?: (beforeFinalAuthority?: () => Promise<void>) => Promise<void>;
  rethrowPreDispatchFailure?: boolean;
};

type AutomaticSanctionStateFenceOutcome =
  | 'ABORTED'
  | 'COMMITTED'
  | 'REMOTE_CONFIRMED_EVENT_MISSING';

type RequiredSubscriptionMembershipResolution = {
  membership: boolean | null;
  fresh: boolean;
  terminal: boolean;
  localQuotaResolution?: MaxMembershipLookupResolution;
};

type WebhookUpdateGuardResult =
  | {
      kind: 'completed';
    }
  | {
      kind: 'timed_out';
      detachedTask: Promise<void>;
      timeoutError: Error;
    };

type WebhookTimeoutSettlementWatchdog = {
  deadlineAtMs: number;
  isExpired: () => boolean;
  stop: () => void;
};

type RequiredSubscriptionMembershipLookupResult = {
  membership: boolean | null;
  terminal: boolean;
};

type RequiredSubscriptionMembershipResult = {
  missingChannelIds: string[];
  unresolvedChannelIds: string[];
  terminalChannelIds: string[];
  localQuotaResolution?: MaxMembershipLookupResolution;
};

const VIOLATION_MESSAGE_PROCESSING_TTL_SEC = 8 * 24 * 60 * 60;
const SERVICE_MEMBER_ACTION_TIMESTAMP_GRANULARITY_MS = 1_000;
const SERVICE_MEMBER_ACTION_DEDUPE_WINDOW_MS = 30_000;
const GREETING_MESSAGE_DEDUPE_WINDOW_MS = 10 * 60_000;
const SHARED_CHAT_OWNER_EVENT_LOOKUP_WINDOW_MS = 15 * 60_000;
const SHARED_CHAT_OWNER_EVENT_LOOKUP_LIMIT = 100;
const WEBHOOK_TIMEOUT_SETTLEMENT_PERSIST_RETRY_MAX_MS = 30_000;
const WEBHOOK_TIMEOUT_PERSISTENCE_LOG_INTERVAL_MS = 30_000;
const DUPLICATE_MESSAGE_ACTION_CLAIM_RULE_CODE = 'DUPLICATE_MESSAGE_ACTION';
@Injectable()
export class ModerationService implements OnModuleInit, OnModuleDestroy {
  private readonly blockedDomainDetector = new MessageLimitsBlockedDomainDetector();
  private readonly logger = new Logger(ModerationService.name);
  private readonly closedChatMessageModeration = new ClosedChatMessageModerationService({
    ensureIntent: (input) => this.ensureModerationDeleteIntent(input),
    claimAction: (input) => this.claimMessageScopedModerationAction(input),
    executeDelete: (input) => this.executeModerationDelete(input),
    createEvent: (input) => this.createBotModerationEvent(input),
    warn: (context, message) => this.logger.warn(context, message),
  });
  private readonly replacementAttachMarkerStore: ReplacementAttachMarkerStore;
  private readonly channelAutoPostLegacyRecovery: ChannelAutoPostLegacyRecovery;
  private readonly channelPostDemand: ChannelPostDemandRuntime;
  private readonly channelAutoPostScanRuntime = new ChannelAutoPostScanRuntime();
  private readonly channelAutoPostMutationGuard: ChannelAutoPostMutationGuard;
  private readonly destructiveAdminRosterRefreshScheduledAtMs = new Map<string, number>();
  private readonly requiredSubscriptionMembershipCache = new Map<
    string,
    {
      expiresAt: number;
      fresh: boolean;
      isMember: boolean;
    }
  >();
  private readonly requiredSubscriptionMembershipInFlight = new Map<
    string,
    Promise<RequiredSubscriptionMembershipLookupResult>
  >();
  private readonly requiredSubscriptionMembershipBackoffUntilMs = new Map<string, number>();
  private readonly requiredSubscriptionUnresolvedLogAtMs = new Map<string, number>();
  private readonly requiredSubscriptionChannelMetadataCache = new Map<
    string,
    {
      expiresAt: number;
      metadata: RequiredSubscriptionChannelMetadata;
    }
  >();
  private readonly requiredSubscriptionNoticePlans: RequiredSubscriptionNoticePlanStore;
  private readonly requiredSubscriptionMediaNoticeCoordinator: RequiredSubscriptionMediaNoticeCoordinator;
  private readonly moderationActionPermissionSkipLogAtMs = new Map<string, number>();
  private readonly moderationActionBotBackoffUntilMs = new Map<string, number>();
  private readonly moderationActionSnapshotRefreshUntilMs = new Map<string, number>();
  private readonly moderationActionSnapshotRefreshInFlight = new Map<
    string,
    Promise<Set<string>>
  >();
  private readonly globalSpammerLocalChatObservations = new Map<string, number>();
  private readonly developerForcedGlobalSpammerMemoryCache = new Map<string, number>();
  private developerForcedGlobalSpammerWarmUntilMs = 0;
  private developerForcedGlobalSpammerWarmInFlight: Promise<void> | null = null;
  private readonly globalSpammerRegistryTtlMs = 30 * 24 * 60 * 60 * 1000;
  private readonly globalSpammerExemptionCache = new Map<
    string,
    {
      expiresAtMs: number;
      decision: LocalGlobalSpammerAdminDecision | null;
    }
  >();
  private readonly globalSpammerExemptionLookupInFlight = new Map<
    string,
    Promise<LocalGlobalSpammerAdminDecision | null>
  >();
  private readonly pendingGlobalSpammerExemptionLookupBatches = new Map<
    string,
    PendingGlobalSpammerExemptionLookupBatch
  >();
  private readonly webhookHotTimeoutChatBackoffUntilMs = new Map<string, number>();
  private webhookHotChatSkipLogAtMs = 0;
  private readonly ownBotUserId: string | null;
  private readonly ownBotUserIdVariants: Set<string>;
  private readonly moderationDisplayNameResolver: ModerationDisplayNameResolver;
  private channelAutoPostTimer: NodeJS.Timeout | null = null;
  private channelAutoPostStartupTimer: NodeJS.Timeout | null = null;
  private readonly channelAutoPostScanState = new Map<string, ChannelAutoPostScanState>();
  private channelAutoPostInFlight = false;
  private channelAutoPostBackoffUntilMs = 0;
  private channelAutoPostPausedLogAtMs = 0;
  private readonly channelAutoPostScanManager: ChannelAutoPostScanManager;
  private readonly appBaseUrl: string | null;
  private readonly blockedJoinChatIds: Set<string>;
  private readonly explicitBotContactId: string | null;
  private readonly maxBotToken: string | null;
  private readonly channelAutoPostScanIntervalMs: number;
  private readonly channelAutoPostScanMaxChannels: number;
  private readonly channelAutoPostInterChannelDelayMs: number;
  private readonly channelAutoPostIdleBackoffMaxMs: number;
  private readonly channelAutoPostStartupDelayMs: number;
  private readonly channelAutoPostStartupJitterMs: number;
  private readonly channelAutoPostMaxNewMessagesPerScan: number;
  private readonly channelAutoPostRepairSweepMs: number;
  private readonly channelAutoPostThrottleBackoffMaxMs: number;
  private readonly requiredSubscriptionLookupConcurrency: number;
  private readonly botNoticeTokenBucketLimit: number;
  private readonly sharedChatExecutionLookupTimeoutMs: number;
  private readonly sharedChatExecutionLockTimeoutMs: number;
  private readonly webhookUserFacingTimeoutMs: number;
  private readonly backgroundTasksEnabled: boolean;
  private readonly navigationTargetOptions: EnabledNavigationTargetOptions;
  private readonly backgroundWorkSoftPauseQueueLagSec: number;
  private readonly backgroundWorkSoftPauseWorkerShare: number;
  private readonly backgroundWorkSoftPauseWorkerPressure: number;
  private readonly sharedChatExecutionMemoryLocks = new Map<string, string>();
  private moderationReleaseCallbackServiceInstance: ModerationReleaseCallbackService | null = null;
  private moderationSanctionStateLockServiceInstance: ModerationSanctionStateLockService | null =
    null;
  private moderationSanctionStateFenceServiceInstance: ModerationSanctionStateFenceService | null =
    null;
  private moderationAccessServiceInstance: ModerationAccessService | null = null;
  private nightModeTransitionRuntimeInstance: NightModeTransitionRuntimeService | null = null;
  private nightModeTransitionDeliveryInstance: NightModeTransitionDeliveryService | null = null;
  private botSpeechMediaServiceInstance: BotSpeechMediaService | null = null;
  private nightModeTransitionEventServiceInstance: NightModeTransitionEventService | null = null;
  private webhookCanonicalExecutionServiceInstance: WebhookCanonicalExecutionService | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly ruleEngine: RuleEngineService,
    private readonly sanctionService: SanctionService,
    private readonly maxClient: MaxClientService,
    @Optional() private readonly chatContextCache?: ChatContextCacheService,
    @Optional() private readonly systemModeService?: SystemModeService,
    @Optional() private readonly configService?: ConfigService,
    @Optional() private readonly redisCounter?: RedisCounterService,
    @Optional() private readonly privateControlService?: PrivateControlService,
    @Optional() private readonly adminDialogLinkService?: AdminDialogLinkService,
    @Optional() private readonly membershipLookupService?: MaxMembershipLookupService,
    @Optional() private readonly maxBotLinkService?: MaxBotLinkService,
    @Optional() private readonly maxBotContextService?: MaxBotContextService,
    @Optional() private readonly queueMetricsService?: QueueMetricsService,
    @Optional()
    private readonly backgroundRuntimeGovernorService?: BackgroundRuntimeGovernorService,
    @Optional()
    private readonly runtimeDiagnosticsService?: RuntimeDiagnosticsService,
    @Optional()
    private readonly maxChatAdminRosterSyncService?: MaxChatAdminRosterSyncService,
    @Optional()
    private readonly globalSpammerIntelligence?: GlobalSpammerIntelligenceService,
    @Optional()
    private readonly managedEntityAccessLossService?: ManagedEntityAccessLossService,
    @Optional()
    private readonly injectedModerationAccessService?: ModerationAccessService,
    @Optional()
    private readonly injectedNightModeTransitionRuntime?: NightModeTransitionRuntimeService,
    @Optional()
    private readonly injectedManualModerationService?: ManualModerationService,
    @Optional()
    private readonly injectedNightModeTransitionDelivery?: NightModeTransitionDeliveryService,
    @Optional()
    private readonly injectedBotSpeechMediaService?: BotSpeechMediaService,
    @Optional()
    private readonly injectedNightModeTransitionEventService?: NightModeTransitionEventService,
    @Optional()
    private readonly karavanStorefrontRelayService?: KaravanStorefrontRelayService,
    @Optional()
    private readonly managedPollService?: ManagedPollService,
    @Optional()
    private readonly injectedWebhookCanonicalExecutionService?: WebhookCanonicalExecutionService,
    @Optional()
    private readonly moderationDeleteIntentService?: ModerationDeleteIntentService,
    @Optional()
    private readonly maxActionLedgerService?: MaxActionLedgerService,
    @Optional()
    private readonly channelPostSignatureService?: ChannelPostSignatureService,
    @Optional()
    private readonly injectedModerationSanctionStateLock?: ModerationSanctionStateLockService,
    @Optional()
    private readonly injectedModerationSanctionStateFence?: ModerationSanctionStateFenceService,
    @Optional()
    private readonly photoDuplicateEnqueueService?: PhotoDuplicateEnqueueService,
    @Optional()
    private readonly commercialOcrEnqueueService?: CommercialOcrEnqueueService,
    @Optional()
    private readonly profanityDeleteGuard?: ProfanityDeleteGuardService,
    @Optional() private readonly messageDuplicateService?: MessageDuplicateService,
    @Optional() private readonly stopWordsDeleteGuard?: StopWordsDeleteGuardService,
    @Optional() private readonly commercialDeleteGuard?: CommercialDeleteGuardService,
    @Optional() private readonly reportSubmission?: ReportSubmissionService,
    @Optional() private readonly participantImmunity?: ParticipantModerationImmunityService,
    @Optional() private readonly commercialReview?: CommercialReviewService,
    @Optional() private readonly injectedGroupCommandAuthority?: GroupCommandAuthorityService,
    @Optional()
    private readonly injectedExecutionOwnerReadiness?: MaxExecutionOwnerReadinessService,
    @Optional() private readonly moderationRuleSanctionGuard?: ModerationRuleSanctionGuardService,
    @Optional() private readonly moderationStateDeleteGuard?: ModerationStateDeleteGuardService,
    @Optional()
    private readonly requiredSubscriptionExecutionGuard?: RequiredSubscriptionExecutionGuardService,
    @Optional() private readonly moderationRuleFollowupService?: ModerationRuleFollowupService,
    @Optional() private readonly legacyHolds?: WebhookLegacyHoldService,
    @Optional() private readonly commercialAi?: CommercialLlmEnforcementService,
    @Optional() private readonly nightModeTransitionScheduler?: NightModeTransitionSchedulerService,
    @Optional()
    private readonly requiredSubscriptionCandidateStore?: RequiredSubscriptionCandidateStore,
  ) {
    this.requiredSubscriptionNoticePlans = new RequiredSubscriptionNoticePlanStore(
      prisma.moderationEvent,
    );
    this.requiredSubscriptionMediaNoticeCoordinator =
      new RequiredSubscriptionMediaNoticeCoordinator(prisma.moderationEvent, redisCounter);
    this.replacementAttachMarkerStore = new ReplacementAttachMarkerStore(prisma);
    this.channelPostDemand = new ChannelPostDemandRuntime({
      prisma,
      maxClient,
      resolveBotId: (chatId) => this.resolveAutoAttachBotId(chatId, 'poll'),
      isMessageHeld: async (chatId, messageId) =>
        (await this.legacyHolds?.isMessageHeld(chatId, messageId)) ?? false,
      attach: (managedChannel, message) =>
        this.tryAutoAttachChannelMessageButtons({
          ...message,
          chatId: managedChannel.channelSettings.chatId,
          managedChannel,
          source: 'poll',
          schedulingOrigin: 'durable_demand',
          sourceMessageAt: new Date(message.timestampMs).toISOString(),
          senderAdminVerified:
            message.senderId !== null && managedChannel.adminUserIds.includes(message.senderId),
          allowSenderlessEngagement: true,
        }),
    });
    this.channelAutoPostMutationGuard = new ChannelAutoPostMutationGuard({
      maxClient,
      isCurrentChannelEntity: (chatId) => this.isCurrentChannelEntity(chatId),
      resolveActionCandidateBotIds: async ({ chatId, action }) =>
        action === 'delete_message'
          ? ((
              await this.maxBotLinkService?.resolveDeleteMessageBotRoute?.({
                chatId,
                expectedEntityType: ChatEntityType.CHANNEL,
                requireFreshSnapshot: true,
              })
            )?.candidateBotIds ?? [])
          : this.resolveModerationActionBotIds({ chatId, action }),
      resolveExecutableBotIdentity: (botId) =>
        this.maxBotLinkService?.getExecutableBotById?.(botId) ?? null,
    });
    this.channelAutoPostLegacyRecovery = new ChannelAutoPostLegacyRecovery({
      prisma,
      markerStore: this.replacementAttachMarkerStore,
      isMessageHeld: async (chatId, messageId) =>
        (await this.legacyHolds?.isMessageHeld(chatId, messageId)) ?? false,
      lookupExactButtonIdentities: (chatId, messageId, options) =>
        maxClient.getExactChannelDialogButtonIdentities(chatId, messageId, options),
      resolveUnifiedLookupBotId: ({ chatId }) => this.resolveAutoAttachBotId(chatId, 'poll'),
      attach: (params) => this.tryAutoAttachChannelMessageButtons(params),
      logger: this.logger,
    });
    this.moderationDisplayNameResolver = new ModerationDisplayNameResolver(
      prisma,
      maxClient,
      this.logger,
    );
    this.maxBotToken = this.normalizeSecret(configService?.get<string>('MAX_BOT_TOKEN'));
    this.ownBotUserId = this.normalizeOwnBotUserId(configService?.get<string>('MAX_BOT_ID'));
    this.ownBotUserIdVariants = this.buildBotIdVariants(this.ownBotUserId);
    this.appBaseUrl = this.normalizeAppBaseUrl(configService?.get<string>('APP_BASE_URL'));
    this.blockedJoinChatIds = this.parseChatIdSet(
      configService?.get<string>('MAX_JOIN_DENY_CHAT_IDS'),
    );
    this.explicitBotContactId = this.normalizeBotContactId(
      configService?.get<string>('MAX_BOT_CONTACT_ID'),
    );
    this.channelAutoPostScanIntervalMs = this.readPositiveConfigInt(
      configService?.get<number>('CHANNEL_AUTO_POST_SCAN_INTERVAL_MS'),
      DEFAULT_CHANNEL_AUTO_POST_SCAN_INTERVAL_MS,
      1_000,
    );
    this.channelAutoPostScanMaxChannels = this.readNonNegativeConfigInt(
      configService?.get<number>('CHANNEL_AUTO_POST_SCAN_MAX_CHANNELS'),
      DEFAULT_CHANNEL_AUTO_POST_SCAN_MAX_CHANNELS,
    );
    this.channelAutoPostInterChannelDelayMs = this.readNonNegativeConfigInt(
      configService?.get<number>('CHANNEL_AUTO_POST_INTER_CHANNEL_DELAY_MS'),
      DEFAULT_CHANNEL_AUTO_POST_INTER_CHANNEL_DELAY_MS,
    );
    this.channelAutoPostIdleBackoffMaxMs = this.readPositiveConfigInt(
      configService?.get<number>('CHANNEL_AUTO_POST_IDLE_BACKOFF_MAX_MS'),
      DEFAULT_CHANNEL_AUTO_POST_IDLE_BACKOFF_MAX_MS,
      this.channelAutoPostScanIntervalMs,
    );
    this.channelAutoPostStartupDelayMs = this.readNonNegativeConfigInt(
      configService?.get<number>('CHANNEL_AUTO_POST_STARTUP_DELAY_MS'),
      DEFAULT_CHANNEL_AUTO_POST_STARTUP_DELAY_MS,
    );
    this.channelAutoPostStartupJitterMs = this.readNonNegativeConfigInt(
      configService?.get<number>('CHANNEL_AUTO_POST_STARTUP_JITTER_MS'),
      DEFAULT_CHANNEL_AUTO_POST_STARTUP_JITTER_MS,
    );
    this.channelAutoPostMaxNewMessagesPerScan = this.readPositiveConfigInt(
      configService?.get<number>('CHANNEL_AUTO_POST_MAX_NEW_MESSAGES_PER_SCAN'),
      DEFAULT_CHANNEL_AUTO_POST_MAX_NEW_MESSAGES_PER_SCAN,
    );
    this.channelAutoPostRepairSweepMs = this.readPositiveConfigInt(
      configService?.get<number>('CHANNEL_AUTO_POST_REPAIR_SWEEP_MS'),
      DEFAULT_CHANNEL_AUTO_POST_REPAIR_SWEEP_MS,
      this.channelAutoPostScanIntervalMs,
    );
    this.channelAutoPostThrottleBackoffMaxMs = this.readPositiveConfigInt(
      configService?.get<number>('CHANNEL_AUTO_POST_THROTTLE_BACKOFF_MAX_MS'),
      DEFAULT_CHANNEL_AUTO_POST_THROTTLE_BACKOFF_MAX_MS,
      CHANNEL_AUTO_POST_RATE_LIMIT_BACKOFF_MS,
    );
    this.channelAutoPostScanManager = new ChannelAutoPostScanManager(
      {
        scanIntervalMs: this.channelAutoPostScanIntervalMs,
        scanMaxChannels: this.channelAutoPostScanMaxChannels,
        idleBackoffMaxMs: this.channelAutoPostIdleBackoffMaxMs,
        repairSweepMs: this.channelAutoPostRepairSweepMs,
        rateLimitBackoffMs: CHANNEL_AUTO_POST_RATE_LIMIT_BACKOFF_MS,
        throttleBackoffMaxMs: this.channelAutoPostThrottleBackoffMaxMs,
      },
      this.channelAutoPostScanState,
    );
    this.requiredSubscriptionLookupConcurrency = this.readPositiveConfigInt(
      configService?.get<number>('REQUIRED_SUBSCRIPTION_LOOKUP_CONCURRENCY'),
      2,
    );
    this.botNoticeTokenBucketLimit = this.readPositiveConfigInt(
      configService?.get<number>('BOT_NOTICE_TOKEN_BUCKET_LIMIT'),
      DEFAULT_BOT_NOTICE_TOKEN_BUCKET_LIMIT,
      1,
    );
    this.sharedChatExecutionLookupTimeoutMs = this.readPositiveConfigInt(
      configService?.get<number>('SHARED_CHAT_EXECUTION_LOOKUP_TIMEOUT_MS'),
      DEFAULT_SHARED_CHAT_EXECUTION_LOOKUP_TIMEOUT_MS,
      100,
    );
    this.sharedChatExecutionLockTimeoutMs = this.readPositiveConfigInt(
      configService?.get<number>('SHARED_CHAT_EXECUTION_LOCK_TIMEOUT_MS'),
      DEFAULT_SHARED_CHAT_EXECUTION_LOCK_TIMEOUT_MS,
      100,
    );
    this.webhookUserFacingTimeoutMs = this.readPositiveConfigInt(
      configService?.get<number>('WEBHOOK_USER_FACING_TIMEOUT_MS'),
      DEFAULT_WEBHOOK_USER_FACING_TIMEOUT_MS,
      1_000,
    );
    this.backgroundTasksEnabled = moderationBackgroundTasksEnabled(
      configService?.get<boolean | string>('MODERATION_BACKGROUND_TASKS_ENABLED'),
    );
    this.navigationTargetOptions = resolveEnabledNavigationTargetOptions(configService);
    this.backgroundWorkSoftPauseQueueLagSec = this.readPositiveConfigInt(
      configService?.get<number>('BACKGROUND_WORK_SOFT_PAUSE_QUEUE_LAG_SEC'),
      DEFAULT_BACKGROUND_WORK_SOFT_PAUSE_QUEUE_LAG_SEC,
      1,
    );
    this.backgroundWorkSoftPauseWorkerPressure = this.readPositiveConfigInt(
      configService?.get<number>('BACKGROUND_WORK_SOFT_PAUSE_WORKER_PRESSURE'),
      DEFAULT_BACKGROUND_WORK_SOFT_PAUSE_WORKER_PRESSURE,
      1,
    );
    this.backgroundWorkSoftPauseWorkerShare = this.readFractionConfig(
      configService?.get<number>('BACKGROUND_WORK_SOFT_PAUSE_WORKER_SHARE'),
      DEFAULT_BACKGROUND_WORK_SOFT_PAUSE_WORKER_SHARE,
    );
  }

  private get moderationAccessService(): ModerationAccessService {
    if (this.injectedModerationAccessService) {
      return this.injectedModerationAccessService;
    }
    if (!this.moderationAccessServiceInstance) {
      this.moderationAccessServiceInstance = new ModerationAccessService(
        this.prisma,
        this.maxClient,
        this.chatContextCache,
        this.configService,
        this.maxBotLinkService,
        this.runtimeDiagnosticsService,
      );
    }
    return this.moderationAccessServiceInstance;
  }

  private get nightModeTransitionRuntime(): NightModeTransitionRuntimeService {
    if (this.injectedNightModeTransitionRuntime) {
      return this.injectedNightModeTransitionRuntime;
    }
    if (!this.nightModeTransitionRuntimeInstance) {
      this.nightModeTransitionRuntimeInstance = new NightModeTransitionRuntimeService(
        this.prisma,
        this.redisCounter,
      );
    }
    return this.nightModeTransitionRuntimeInstance;
  }

  private get nightModeTransitionDelivery(): NightModeTransitionDeliveryService {
    if (this.injectedNightModeTransitionDelivery) {
      return this.injectedNightModeTransitionDelivery;
    }
    if (!this.nightModeTransitionDeliveryInstance) {
      this.nightModeTransitionDeliveryInstance = new NightModeTransitionDeliveryService(
        this.maxClient,
        this.botSpeechMediaService,
        this.nightModeTransitionEventService,
        this.managedEntityAccessLossService,
        undefined,
        undefined,
        this.maxActionLedgerService ?? new MaxActionLedgerService(this.prisma),
        undefined,
        this.nightModeTransitionScheduler,
      );
    }
    return this.nightModeTransitionDeliveryInstance;
  }

  private get nightModeTransitionEventService(): NightModeTransitionEventService {
    if (this.injectedNightModeTransitionEventService) {
      return this.injectedNightModeTransitionEventService;
    }
    if (!this.nightModeTransitionEventServiceInstance) {
      this.nightModeTransitionEventServiceInstance = new NightModeTransitionEventService(
        this.prisma,
        this.configService,
        this.maxBotContextService,
      );
    }
    return this.nightModeTransitionEventServiceInstance;
  }

  private get botSpeechMediaService(): BotSpeechMediaService {
    if (this.injectedBotSpeechMediaService) {
      return this.injectedBotSpeechMediaService;
    }
    if (!this.botSpeechMediaServiceInstance) {
      this.botSpeechMediaServiceInstance = new BotSpeechMediaService(this.maxClient);
    }
    return this.botSpeechMediaServiceInstance;
  }

  private get manualModerationCommandBridge(): ManualModerationCommandBridge | null {
    return this.injectedManualModerationService ?? null;
  }

  private get moderationReleaseCallbackService(): ModerationReleaseCallbackService {
    if (!this.moderationReleaseCallbackServiceInstance) {
      this.moderationReleaseCallbackServiceInstance = new ModerationReleaseCallbackService(
        this.prisma,
        this.maxClient,
        this.manualModerationCommandBridge,
        this.moderationSanctionStateFenceService,
      );
    }
    return this.moderationReleaseCallbackServiceInstance;
  }

  private get moderationSanctionStateLockService(): ModerationSanctionStateLockService {
    if (this.injectedModerationSanctionStateLock) {
      return this.injectedModerationSanctionStateLock;
    }
    if (!this.moderationSanctionStateLockServiceInstance) {
      this.moderationSanctionStateLockServiceInstance = new ModerationSanctionStateLockService(
        this.redisCounter,
      );
    }
    return this.moderationSanctionStateLockServiceInstance;
  }

  private get moderationSanctionStateFenceService(): ModerationSanctionStateFenceService {
    if (this.injectedModerationSanctionStateFence) {
      return this.injectedModerationSanctionStateFence;
    }
    if (!this.moderationSanctionStateFenceServiceInstance) {
      this.moderationSanctionStateFenceServiceInstance = new ModerationSanctionStateFenceService(
        this.prisma,
      );
    }
    return this.moderationSanctionStateFenceServiceInstance;
  }

  private get webhookCanonicalExecutionService(): WebhookCanonicalExecutionService {
    if (this.injectedWebhookCanonicalExecutionService) {
      return this.injectedWebhookCanonicalExecutionService;
    }
    if (!this.webhookCanonicalExecutionServiceInstance) {
      this.webhookCanonicalExecutionServiceInstance = new WebhookCanonicalExecutionService(
        this.prisma,
      );
    }
    return this.webhookCanonicalExecutionServiceInstance;
  }

  private isSuperBanDeveloperUserId(userId: string | null | undefined): boolean {
    const bridge = this.manualModerationCommandBridge;
    return (
      typeof bridge?.isSuperBanDeveloperUserId === 'function' &&
      bridge.isSuperBanDeveloperUserId(userId) === true
    );
  }

  private createNightModeTransitionHooks() {
    return this.nightModeTransitionDelivery.createHooks({
      getBotSpeechProfile: (botId) => this.resolveBotSpeechProfile(botId),
      buildClosedNoticeOptions: (settings) =>
        this.buildNightModeClosedNoticeOptions({
          chatId: settings.chatId,
          commentsEnabled: settings.commentsEnabled,
          nightModeCommentsEnabled: settings.nightModeCommentsEnabled,
          nightModeBotButtons: settings.nightModeBotButtons,
          nightModeBotButtonEnabled: settings.nightModeBotButtonEnabled,
          nightModeBotButtonUrl: settings.nightModeBotButtonUrl,
          nightModeBotButtonText: settings.nightModeBotButtonText,
          nightModeRulesButtonEnabled: settings.nightModeRulesButtonEnabled,
          rulesPublishedUrl: settings.chat?.rules?.publishedUrl ?? null,
          rulesPublishedMessageId: settings.chat?.rules?.publishedMessageId ?? null,
        }),
      resolveBotId: (chatId) => this.resolveNightModeTransitionBotId(chatId),
    });
  }

  private withBotModerationEventData(
    data: Prisma.ModerationEventUncheckedCreateInput,
  ): Prisma.ModerationEventUncheckedCreateInput {
    if (data.operator !== Operator.BOT) {
      return data;
    }

    const activeBotId = this.maxBotContextService?.getActiveBotId() ?? null;
    if (!activeBotId || typeof data.botId === 'string') {
      return data;
    }

    return {
      ...data,
      botId: activeBotId,
    };
  }

  private async createBotModerationEvent(params: {
    data: Prisma.ModerationEventUncheckedCreateInput;
  }) {
    await this.assertLegacyModerationAllowed(
      params.data.chatId,
      params.data.userId,
      params.data.messageId,
    );
    const data = this.withBotModerationEventData(params.data);
    if (!needsAutomaticMuteCleanup(data)) return this.prisma.moderationEvent.create({ data });
    return this.prisma.$transaction(async (tx) => {
      await this.assertLegacyModerationAllowed(data.chatId, data.userId, data.messageId, tx);
      const event = await tx.moderationEvent.create({ data });
      await persistAutomaticMuteCleanup(tx, event);
      return event;
    });
  }

  private async isLegacyModerationHeld(
    chatId: string,
    userId?: string | null,
    messageId?: string | null,
    tx?: WebhookLegacyHoldDatabase,
  ): Promise<boolean> {
    if (!this.legacyHolds) return false;
    if (messageId && (await this.legacyHolds.isMessageHeld(chatId, messageId, tx))) return true;
    return (
      !!userId &&
      ((await this.legacyHolds.isMemberHeld(chatId, userId, tx)) ||
        (await this.legacyHolds.isGlobalUserHeld(userId, tx)))
    );
  }

  private async assertLegacyModerationAllowed(
    chatId: string,
    userId?: string | null,
    messageId?: string | null,
    tx?: WebhookLegacyHoldDatabase,
  ): Promise<void> {
    if (await this.isLegacyModerationHeld(chatId, userId, messageId, tx))
      throw new ModerationRuleSanctionRejectedError();
  }

  onModuleInit() {
    if (!roleRunsModeration(getAppRole())) {
      return;
    }
    if (!this.backgroundTasksEnabled) {
      return;
    }

    this.logger.log(
      {
        channelAutoPostScanIntervalMs: this.channelAutoPostScanIntervalMs,
        channelAutoPostScanMaxChannels: this.channelAutoPostScanMaxChannels,
        channelAutoPostIdleBackoffMaxMs: this.channelAutoPostIdleBackoffMaxMs,
        channelAutoPostStartupDelayMs: this.channelAutoPostStartupDelayMs,
        channelAutoPostStartupJitterMs: this.channelAutoPostStartupJitterMs,
        channelAutoPostMaxNewMessagesPerScan: this.channelAutoPostMaxNewMessagesPerScan,
        channelAutoPostRepairSweepMs: this.channelAutoPostRepairSweepMs,
      },
      'Moderation background polling is enabled',
    );

    if (this.channelAutoPostScanMaxChannels > 0) {
      this.channelAutoPostTimer = setInterval(() => {
        void this.processChannelAutoPostButtons();
      }, this.channelAutoPostScanIntervalMs);
      this.channelAutoPostTimer.unref();
      this.scheduleChannelAutoPostStartupScan();
    }
  }

  onModuleDestroy() {
    if (this.channelAutoPostTimer) {
      clearInterval(this.channelAutoPostTimer);
      this.channelAutoPostTimer = null;
    }
    if (this.channelAutoPostStartupTimer) {
      clearTimeout(this.channelAutoPostStartupTimer);
      this.channelAutoPostStartupTimer = null;
    }
  }

  async processWebhookEvent(webhookEventId: string) {
    if (
      await recoverGroupCommandNotice(
        this.prisma,
        this.maxClient,
        this.injectedGroupCommandAuthority ?? new GroupCommandAuthorityService(this.prisma),
        webhookEventId,
        { readiness: this.injectedExecutionOwnerReadiness, links: this.maxBotLinkService },
      )
    )
      return;
    let execution: WebhookCanonicalExecutionContext | null;
    try {
      execution = await this.webhookCanonicalExecutionService.prepareExecution(
        webhookEventId,
        this.maxBotLinkService?.getDefaultBotId?.(),
      );
    } catch (error: unknown) {
      // FLAG: Mark only typed preparation deferrals before entering the handler.
      // Handler failures retain their existing durable effects and recovery path.
      if (error instanceof WebhookPreparationDeferredError)
        throw new WebhookPreparationRetryError(webhookEventId, error);
      if (error instanceof WebhookOrderedPredecessorPendingError) throw error;
      logWebhookExecutionFailure(this.logger, 'preparation', error, undefined, webhookEventId);
      throw error;
    }
    if (!execution) {
      return;
    }

    const { webhookEvent, update, activeBotId } = execution;
    const normalizedUpdateType = this.readLowerString(update.type);
    if (
      (normalizedUpdateType === 'message_created' || normalizedUpdateType === 'message_edited') &&
      update.message?.chatId
    ) {
      void this.runtimeDiagnosticsService?.recordHotChatMessage({
        chatId: update.message.chatId,
        botId: update.botId,
        eventType: normalizedUpdateType,
      });
    }

    const commercialOcrPendingActivations: CommercialOcrPendingActivation[] = [];
    let failureStage: WebhookExecutionFailureStage = 'handler';
    let hotPathProfile: WebhookHotPathProfile | null = null;
    try {
      const guardResult = await this.executeWebhookUpdateWithGuard(
        webhookEvent.id,
        update,
        activeBotId,
        async () => {
          hotPathProfile = this.createWebhookHotPathProfile();
          await runCanonicalWebhookHandler(execution, this.maxBotContextService, () =>
            this.handleUpdate(
              update,
              hotPathProfile!,
              webhookEvent.id,
              commercialOcrPendingActivations,
            ),
          );
        },
        () => this.readWebhookHotPathProfileSnapshot(hotPathProfile),
      );

      if (guardResult.kind === 'timed_out') {
        const timeoutErrorMessage = this.formatWebhookProcessingErrorMessage(
          guardResult.timeoutError,
        );
        const settlementWatchdog = this.startWebhookTimeoutSettlementWatchdog(
          execution.webhookEvent.id,
        );
        let quarantineLease: WebhookTimeoutQuarantineLease;
        try {
          quarantineLease = await this.webhookCanonicalExecutionService.quarantineTimedOutExecution(
            execution,
            {
              errorMessage: timeoutErrorMessage,
            },
          );
        } catch (error: unknown) {
          try {
            quarantineLease = await this.persistTimedOutWebhookFallback({
              execution,
              timeoutError: guardResult.timeoutError,
              timeoutErrorMessage,
              persistenceError: error,
            });
          } catch (fallbackError: unknown) {
            const recoveredLease = await this.recoverTimedOutWebhookWithoutDurableQuarantine({
              execution,
              detachedTask: guardResult.detachedTask,
              timeoutErrorMessage,
              persistenceError: fallbackError,
              commercialOcrPendingActivations,
              settlementWatchdog,
            });
            if (!recoveredLease) {
              return;
            }
            quarantineLease = recoveredLease;
          }
        }
        this.observeTimedOutWebhookExecution({
          execution,
          detachedTask: guardResult.detachedTask,
          quarantineLease,
          commercialOcrPendingActivations,
          settlementWatchdog,
        });
        return;
      }

      failureStage = 'completion';
      await this.webhookCanonicalExecutionService.completeExecution(execution);
      failureStage = 'ocr_activation';
      await this.commercialOcrEnqueueService?.activatePendingBatch(commercialOcrPendingActivations);
    } catch (error: unknown) {
      logWebhookExecutionFailure(
        this.logger,
        failureStage,
        error,
        this.readWebhookHotPathProfileSnapshot(hotPathProfile)?.latestStage,
        webhookEventId,
      );
      // FLAG: A returned handler with unresolved database finalization must retain its exact
      // owner lease and replay fence; this is neither handler failure nor preparation retry.
      if (failureStage === 'completion' && error instanceof WebhookFinishPersistenceError)
        throw error;
      await recordGroupCommandNoticeRecovery(this.prisma, execution, error);
      await this.commercialOcrEnqueueService?.suppressPendingBatch(commercialOcrPendingActivations);
      if (!this.isWebhookHotPathTimeoutError(error)) {
        await this.webhookCanonicalExecutionService.failExecution(execution, {
          errorMessage: this.formatWebhookProcessingErrorMessage(error),
          terminal: this.isTerminalWebhookProcessingError(error),
          retryAfterMs: this.readWebhookProcessingRetryAfterMs(error),
        });
      }
      throw error;
    }
  }

  isPhotoDuplicateMessageAuthorImmune(params: {
    update: MaxUpdate;
    album: LogicalPhotoAlbum;
  }): boolean {
    return (
      !params.update.message ||
      this.isPrivateDirectChat(params.album.chatId) ||
      this.isServiceAuthoredMessage(params.update) ||
      this.isBotAuthoredMessage(params.update) ||
      this.isKnownRuntimeBotUserId(params.album.senderId)
    );
  }

  async consumePhotoDuplicateParticipantImmunity(params: {
    chatId: string;
    userId: string;
    messageId: string;
    nightModeTimezone: string | null;
  }): Promise<boolean> {
    return this.consumeChatParticipantModerationImmunity(params);
  }

  async executePhotoDuplicateAction(params: PhotoDuplicateModerationActionRequest): Promise<void> {
    return this.executeDuplicateAction({
      ...params,
      backgroundExecution: true,
      assertActiveLease: params.lease.assertOwned,
    });
  }

  async executeDuplicateAction(
    params: DuplicateModerationActionRequest,
    hotPathProfile?: WebhookHotPathProfile,
  ): Promise<void> {
    return executeDuplicateModerationAction(params, {
      hotPathProfile,
      formatUserLabel: (senderName, userId) => this.formatUserLabel(senderName, userId),
      handleDecision: (action) => this.handleDuplicateDecision(action),
      handleHit: (action) => this.handleDuplicateHit(action),
    });
  }

  async handleUpdate(
    update: MaxUpdate,
    hotPathProfile?: WebhookHotPathProfile,
    webhookEventId?: string,
    commercialOcrPendingActivations?: CommercialOcrPendingActivation[],
  ) {
    if (!update.message) {
      const callbackId = extractMaxCallbackId(update);
      if (
        this.readLowerString(update.type) === 'message_callback' &&
        callbackId &&
        this.readString(update.botId)
      ) {
        await this.answerCallbackSafe(
          callbackId,
          'Кнопка устарела',
          undefined,
          this.readString(update.botId) ?? undefined,
        );
      }
      return;
    }

    // FLAG: A legacy disposition denies the whole source family across late edits and bots.
    // This check precedes duplicate evidence, callbacks and every whole-engine state mutation.
    if (await this.legacyHolds?.isMessageHeld(update.message.chatId, update.message.messageId))
      return;

    // FLAG: A held author's new explicit command has an independent current authority.
    // It never enters lifecycle/evidence/immunity or any ordinary moderation path.
    if (await this.legacyHolds?.isUpdateHeld(update)) {
      if (webhookEventId) await this.handleFreshHeldCommand(update, webhookEventId);
      return;
    }

    // FLAG: bot_added is pending connection evidence, never a moderation or callback
    // source. Its prepared receiving-bot authority permits only the explicit join denylist.
    if (this.isBotAddedUpdate(update)) {
      await this.handleBlockedBotJoin(update, update.message.chatId);
      return;
    }

    // FLAG: Edits/removals revoke duplicate evidence even when later moderation exits early.
    await this.messageDuplicateService?.observeLifecycle?.(update);

    if (this.isLifecycleNoopUpdate(update)) {
      return;
    }

    const serviceAuthored = this.isServiceAuthoredMessage(update);
    const serviceMemberUserIds = this.extractServiceMemberUserIds(update);
    const membershipInvalidationUserIds = Array.from(
      new Set(
        (update.membership?.memberUserIds ?? serviceMemberUserIds)
          .map((userId) => userId.trim())
          .filter(Boolean),
      ),
    );
    const serviceMembersEvent = serviceMemberUserIds.length > 0;

    const { chatId, chatTitle, senderId, senderName, text, createdAt, messageId } = update.message;
    if (this.managedPollService && (await this.managedPollService.tryHandleCallback(update))) {
      return;
    }
    const sharedChatExecutionGuard = await this.resolveSharedChatExecutionGuard(update, chatId);
    if (sharedChatExecutionGuard.mode === 'blocked-join-check-only') {
      if (await this.handleBlockedBotJoin(update, chatId)) {
        return;
      }

      this.logSharedChatExecutionSkip(update, chatId, sharedChatExecutionGuard);
      return;
    }
    if (sharedChatExecutionGuard.mode === 'skip') {
      this.logSharedChatExecutionSkip(update, chatId, sharedChatExecutionGuard);
      return;
    }

    const sharedChatExecutionAllowGuard =
      sharedChatExecutionGuard.mode === 'allow' ? sharedChatExecutionGuard : null;
    const sharedChatExecutionLock = sharedChatExecutionAllowGuard?.requiresExecutionLock
      ? await this.acquireSharedChatExecutionLock(update, chatId, sharedChatExecutionAllowGuard)
      : null;
    if (sharedChatExecutionAllowGuard?.requiresExecutionLock && !sharedChatExecutionLock) {
      this.logger.debug(
        {
          chatId,
          updateId: update.updateId,
          updateType: this.readLowerString(update.type),
          activeBotId: sharedChatExecutionAllowGuard.activeBotId,
          primaryBotId: sharedChatExecutionAllowGuard.primaryBotId,
        },
        'Skipped duplicate shared chat execution because another bot runtime already owns the update',
      );
      return;
    }

    try {
      if (membershipInvalidationUserIds.length > 0 && this.membershipLookupService) {
        await this.membershipLookupService.invalidateMemberships(
          chatId,
          membershipInvalidationUserIds,
        );
      }

      if (this.isBotStartedUpdate(update)) {
        await this.handleBotStartedInstruction(update, chatId);
        return;
      }

      if (this.isMembershipLeaveUpdate(update)) {
        return;
      }

      if (this.isPrivateDirectChat(chatId)) {
        if (this.privateControlService) {
          await this.privateControlService.handleUpdate(update);
          return;
        }
        await this.handlePrivateChatControl(update);
        return;
      }

      const callbackId = extractMaxCallbackId(update);
      if (await this.moderationReleaseCallbackService.tryHandle(update)) {
        return;
      }
      const rawCallbackPayload = extractMaxCallbackPayloadRaw(update);
      const callbackPayload = rawCallbackPayload?.toLowerCase() ?? null;
      const suggestionPayload =
        rawCallbackPayload && this.adminDialogLinkService
          ? this.adminDialogLinkService.parseChannelSuggestionStartPayload(rawCallbackPayload)
          : null;
      if (callbackId && suggestionPayload && this.privateControlService) {
        const callbackUserId = extractMaxCallbackUserId(update) ?? senderId;
        const delivered = await this.privateControlService.openChannelSuggestionFromCallback({
          userId: callbackUserId,
          chatId: suggestionPayload.chatId,
          token: suggestionPayload.token,
          botId: this.readString(update.botId) ?? undefined,
        });
        await this.answerCallbackSafe(
          callbackId,
          delivered ? 'Бот написал в личку' : 'Не удалось открыть личку бота',
          chatId,
        );
        return;
      }
      const channelMessage = this.isChannelMessage(update);
      const managedChannel = channelMessage
        ? await this.loadManagedChannelContext(chatId, chatTitle)
        : null;
      if (channelMessage || managedChannel) {
        await this.handleChannelUpdate(update, managedChannel);
        return;
      }

      if (callbackPayload === RULES_CALLBACK_PAYLOAD) {
        await this.handleRulesCallback(
          chatId,
          callbackId,
          update.message?.messageId ?? null,
          this.readString(update.botId) ?? undefined,
        );
        return;
      }

      if (serviceAuthored || serviceMembersEvent) {
        const chat = await this.loadChatContext(chatId, chatTitle);
        this.markWebhookHotPathStage(hotPathProfile, 'chat-context');
        const updateType = this.readLowerString(update.type);
        const senderIsOwnBotInMessage =
          updateType === 'message_created' && senderId
            ? this.isCurrentBotSender(senderId, update)
            : false;
        if (senderIsOwnBotInMessage) {
          await this.handleOwnBotMessageAutoDelete({
            chatId,
            userId: senderId,
            messageId,
            text,
            createdAt,
            settings: chat.settings,
            raw: update.raw,
          });
          return;
        }

        await this.handleServiceMembershipUpdate({
          chatId,
          messageId,
          text,
          update,
          settings: chat.settings,
          adminUserIds: chat.adminUserIds,
          rulesPublishedUrl: chat.rulesPublishedUrl,
          rulesPublishedMessageId: chat.rulesPublishedMessageId,
        });
        return;
      }

      const userLabel = this.formatUserLabel(senderName, senderId);
      const mode = await this.resolveSystemModeSnapshot();
      this.markWebhookHotPathStage(hotPathProfile, 'system-mode');
      const degradeMode = mode.mode === 'degrade';
      const hotChatBackoffActive = this.isWebhookHotTimeoutChatBackoffActive(chatId);
      const chat = await this.loadChatContext(chatId, chatTitle);
      this.markWebhookHotPathStage(hotPathProfile, 'chat-context');
      let settings = this.applyDegradeSettings(chat.settings, degradeMode);
      const closure = resolveEffectiveChatClosure(settings);
      const manualGroupCloseActiveNow = closure.manual.active;
      const nightModeActiveNow = !manualGroupCloseActiveNow && closure.night?.status === 'closed';
      const destructiveAccessGateActive = manualGroupCloseActiveNow || nightModeActiveNow;
      const forceSynchronousRemoteAdminLookup = this.shouldForceSynchronousRemoteAdminLookup(
        update,
        settings,
      );
      const keepDestructiveAdminCheckOnHotPath =
        destructiveAccessGateActive && !forceSynchronousRemoteAdminLookup;
      const rulesPublishedUrl = chat.rulesPublishedUrl;
      const rulesPublishedMessageId = chat.rulesPublishedMessageId;

      const updateType = this.readLowerString(update.type);
      if (settings.reportsEnabled && updateType === 'message_edited')
        await this.reportSubmission?.observeEdit(update);
      const { duplicateStateEventType, duplicateStateEventTimestampMs } =
        resolveTrustedDuplicateStateRevision(updateType, createdAt, update.eventTimestampSource);
      const senderIsOwnBotInMessage =
        updateType === 'message_created' && senderId
          ? this.isCurrentBotSender(senderId, update)
          : false;
      if (senderIsOwnBotInMessage) {
        await this.handleOwnBotMessageAutoDelete({
          chatId,
          userId: senderId,
          messageId,
          text,
          createdAt,
          settings,
          raw: update.raw,
        });
        return;
      }

      if (!senderId) {
        return;
      }

      if (
        messageId &&
        (await this.tryRecoverChatMessageCommentsAudit({
          chatId,
          messageId,
          senderId,
        }))
      ) {
        return;
      }

      const senderIsCurrentBot = this.isCurrentBotSender(senderId, update);
      if (this.isKnownRuntimeBotUserId(senderId) && !senderIsCurrentBot) {
        this.logger.debug(
          {
            chatId,
            senderId,
            updateId: update.updateId,
          },
          'Skipped moderation for configured MAX bot user',
        );
        return;
      }

      const senderIsOwnBot = this.isOwnBotSender(senderId);
      const senderIsBot = senderIsOwnBot || senderIsCurrentBot || this.isBotAuthoredMessage(update);
      if (senderIsBot) {
        const senderUsesOwnBotCleanup = senderIsOwnBot || senderIsCurrentBot;
        const mayModerateOtherBotContent =
          (!senderUsesOwnBotCleanup && settings.removeBotsFromGroupEnabled) ||
          (senderUsesOwnBotCleanup && !senderIsCurrentBot && settings.deleteBotMessagesEnabled);
        if (
          !senderIsCurrentBot &&
          mayModerateOtherBotContent &&
          (await this.isOtherBotAdminModerationBypass({
            chatId,
            localAdminUserIds: chat.adminUserIds,
            senderId,
            degradeMode,
            hotChatBackoffActive,
          }))
        ) {
          return;
        }

        if (settings.removeBotsFromGroupEnabled && !senderUsesOwnBotCleanup) {
          await this.handleBotMessage({
            chatId,
            userId: senderId,
            messageId,
            text,
            createdAt,
          });
        } else if (senderUsesOwnBotCleanup) {
          await this.handleOwnBotMessageAutoDelete({
            chatId,
            userId: senderId,
            messageId,
            text,
            createdAt,
            settings,
            raw: update.raw,
          });
        }
        return;
      }

      // FLAG: Old sender-scoped strikes/duplicate evidence cannot authorize another
      // automatic effect while the original participant remains unreconciled.
      if (
        (await this.legacyHolds?.isMessageHeld(chatId, messageId)) ||
        (await this.legacyHolds?.isMemberHeld(chatId, senderId))
      )
        return;

      const mediaFlags = detectMediaFlags(update);
      const requiredSubscriptionMediaNoticeScope = resolveRequiredSubscriptionMediaNoticeScope({
        chatId,
        userId: senderId,
        sourceCreatedAt: createdAt,
        mediaGroupId: extractDirectMediaBatchId(update),
        mediaEligible:
          updateType === 'message_created' &&
          (mediaFlags.hasPhotoAttachment ||
            mediaFlags.hasStickerAttachment ||
            mediaFlags.hasVideoAttachment ||
            mediaFlags.hasFileAttachment ||
            mediaFlags.hasVoiceAttachment ||
            mediaFlags.hasMediaBatch),
      });
      const commercialOcrEnqueueBase = resolveCommercialOcrEnqueueCandidate({
        update,
        webhookEventId,
        updateType,
        imageTextScanEnabled: isStopWordsImageScanEnabled(settings),
        hasImageTextStopList: isStopWordsImageScanEnabled(settings),
        hasPhotoAttachment: mediaFlags.hasPhotoAttachment,
        chatId,
        messageId,
        sourceCreatedAt: createdAt,
      });
      const enqueueCommercialOcr = async (actionEligible: boolean): Promise<void> => {
        if (!commercialOcrEnqueueBase) return;
        await this.commercialOcrEnqueueService?.enqueue({
          ...commercialOcrEnqueueBase,
          actionEligible,
          ...(commercialOcrPendingActivations
            ? {
                registerPendingActivation: (activation: CommercialOcrPendingActivation) => {
                  commercialOcrPendingActivations.push(activation);
                },
              }
            : {}),
        });
      };
      const suppressDeferredPhotoAnalysisActions = async (): Promise<void> => {
        await this.messageDuplicateService?.revokeActions?.(update);
        await enqueueCommercialOcr(false);
      };

      if (
        messageId &&
        this.isSuperBanDeveloperUserId(senderId) &&
        (await this.handleAdminForwardedModerationCommand({
          update,
          chatId,
          senderId,
          messageId,
          settings,
          superBanOnly: true,
          ...(chatTitle !== undefined ? { chatTitle } : {}),
          ...(senderName !== undefined ? { senderName } : {}),
        }))
      ) {
        await suppressDeferredPhotoAnalysisActions();
        return;
      }

      this.markWebhookHotPathStage(hotPathProfile, 'developer-forced-global-spammer');
      if (
        settings.deleteSpammersEnabled &&
        (await this.isDeveloperForcedGlobalSpammerCachedWithHotPathBudget(senderId, {
          chatId,
          messageId,
        }))
      ) {
        await this.messageDuplicateService?.revokeActions?.(update);
        if (commercialOcrEnqueueBase) {
          const photoSenderAdminCheck = await this.resolveSenderChatAdminCheck(
            chatId,
            chat.adminUserIds,
            senderId,
            { allowRemoteLookup: true, skipRemoteLookupWhenLocalAdminsKnown: false },
          );
          if (!photoSenderAdminCheck.isAdmin && photoSenderAdminCheck.source !== 'local_fallback') {
            await suppressDeferredPhotoAnalysisActions();
          }
        }
        const handled = await this.deleteAndKickDetectedGlobalSpammer({
          chatId,
          userId: senderId,
          messageId,
          text,
          createdAt,
          reason: 'Developer-forced global blacklist',
        });
        if (!handled) {
          throw new Error('Developer-forced spammer message deletion was not accepted');
        }
        return;
      }

      this.markWebhookHotPathStage(hotPathProfile, 'admin-check');
      const senderChatAdminCheck = await this.resolveSenderChatAdminCheck(
        chatId,
        chat.adminUserIds,
        senderId,
        {
          allowRemoteLookup:
            !degradeMode && !hotChatBackoffActive && !keepDestructiveAdminCheckOnHotPath,
          skipRemoteLookupWhenLocalAdminsKnown:
            hotChatBackoffActive ||
            degradeMode ||
            keepDestructiveAdminCheckOnHotPath ||
            (!destructiveAccessGateActive && !forceSynchronousRemoteAdminLookup),
          remoteLookupSoftTimeoutMs:
            !hotChatBackoffActive &&
            !degradeMode &&
            !keepDestructiveAdminCheckOnHotPath &&
            !forceSynchronousRemoteAdminLookup
              ? CHAT_ADMIN_NONCRITICAL_LOOKUP_SOFT_TIMEOUT_MS
              : undefined,
          prefetchRemoteLookupWhenLocalAdminsKnown:
            !hotChatBackoffActive &&
            !degradeMode &&
            !destructiveAccessGateActive &&
            !this.moderationAccessService.syncRemoteLookupWhenLocalAdminsKnown,
        },
      );
      if (senderChatAdminCheck.isAdmin) {
        await suppressDeferredPhotoAnalysisActions();
        if (
          await this.tryHandleKaravanStorefrontRelay({
            update,
            updateType,
            chatId,
            messageId,
            senderId,
            senderName,
            text,
            karavanStorefrontEnabled: settings.karavanStorefrontEnabled,
            storefrontTexts: settings,
            karavanStorefrontAdminsOnly: this.readKaravanStorefrontAdminsOnly(settings),
            storefrontOwnerUserId: this.readKaravanStorefrontOwnerUserId(update, senderId),
          })
        ) {
          return;
        }

        this.markWebhookHotPathStage(hotPathProfile, 'admin-command');
        await this.handleChatAdminModerationBypass({
          update,
          chatId,
          chatTitle,
          senderId,
          senderName,
          messageId,
          text,
          settings,
          source: senderChatAdminCheck.source,
        });
        return;
      }

      // FLAG: A hold in another chat denies fresh automatic moderation before
      // immunity/evidence mutation. Explicit admin commands and callbacks remain separate.
      if (await this.legacyHolds?.isGlobalUserHeld(senderId)) return;

      const latestSenderChatAdminCheck = senderChatAdminCheck;
      const ensureDestructiveModerationAllowed = async (stage: string): Promise<boolean> => {
        if (latestSenderChatAdminCheck.source === 'local_fallback') {
          this.scheduleDestructiveAdminRosterRefresh({
            chatId,
            chatTitle,
            botId: update.botId ?? null,
            entityType: update.message?.entityType ?? null,
            stage,
          });
        }

        if (latestSenderChatAdminCheck.isAdmin) {
          if (
            await this.tryHandleKaravanStorefrontRelay({
              update,
              updateType,
              chatId,
              messageId,
              senderId,
              senderName,
              text,
              karavanStorefrontEnabled: settings.karavanStorefrontEnabled,
              storefrontTexts: settings,
              karavanStorefrontAdminsOnly: this.readKaravanStorefrontAdminsOnly(settings),
              storefrontOwnerUserId: this.readKaravanStorefrontOwnerUserId(update, senderId),
            })
          ) {
            return false;
          }

          this.markWebhookHotPathStage(hotPathProfile, 'admin-command');
          await this.handleChatAdminModerationBypass({
            update,
            chatId,
            chatTitle,
            senderId,
            senderName,
            messageId,
            text,
            settings,
            source: latestSenderChatAdminCheck.source,
          });
          return false;
        }

        return true;
      };

      this.markWebhookHotPathStage(hotPathProfile, 'active-mute');
      const activeMute = await this.getActiveMute(chatId, senderId, settings.muteDurationHours);
      const voiceSource =
        webhookEventId && (activeMute || destructiveAccessGateActive)
          ? captureVoiceSourceInput(update)
          : null;
      if (activeMute) {
        if (!(await ensureDestructiveModerationAllowed('active-mute'))) {
          return;
        }
        await suppressDeferredPhotoAnalysisActions();
        if (activeMute.ruleCode === REQUIRED_SUBSCRIPTION_RULE_CODE) {
          this.markWebhookHotPathStage(hotPathProfile, 'required-subscription');
          const requiredSubscriptionHandled = await this.handleRequiredSubscriptionMessage({
            sourceUpdateType: updateType,
            chatId,
            userId: senderId,
            userLabel,
            messageId,
            text,
            createdAt,
            settings,
            rulesPublishedUrl,
            rulesPublishedMessageId,
            hotPathProfile,
            suppressEscalation: true,
            knownAppliedSanctionAction: SanctionAction.MUTE,
            knownAppliedMuteDurationHours: activeMute.durationHours,
            mediaNoticeScope: requiredSubscriptionMediaNoticeScope,
          });
          if (requiredSubscriptionHandled) {
            return;
          }
        }
        await this.handleActiveMuteMessage({
          chatId,
          userId: senderId,
          messageId,
          text,
          createdAt,
          mute: activeMute,
          voiceSource,
        });
        return;
      }

      if (manualGroupCloseActiveNow) {
        if (!(await ensureDestructiveModerationAllowed('manual-group-close'))) {
          return;
        }
        await suppressDeferredPhotoAnalysisActions();
        await this.handleNightModeForceCloseMessage({
          chatId,
          userId: senderId,
          messageId,
          text,
          createdAt,
          voiceSource,
          nightModeForceCloseForever: settings.nightModeForceCloseForever,
          nightModeForceCloseUntil: settings.nightModeForceCloseUntil,
        });
        return;
      }

      if (nightModeActiveNow) {
        if (!(await ensureDestructiveModerationAllowed('night-mode'))) {
          return;
        }
        await suppressDeferredPhotoAnalysisActions();
        await this.handleNightModeMessage({
          chatId,
          userId: senderId,
          messageId,
          text,
          createdAt,
          voiceSource,
          nightModeStartTimeMinutes: settings.nightModeStartTimeMinutes,
          nightModeEndTimeMinutes: settings.nightModeEndTimeMinutes,
          nightModeTimezone: settings.nightModeTimezone,
        });
        return;
      }

      const skipOptionalHotChatStages = this.shouldSkipOptionalHotChatStages(
        mode,
        hotChatBackoffActive,
      );
      if (skipOptionalHotChatStages) {
        this.logOptionalHotChatStageSkip(chatId, senderId, mode);
      }

      const skipAntiSpamBurstLimit = shouldSkipAntiSpamBurstForForward(update);
      this.markWebhookHotPathStage(hotPathProfile, 'global-spammer-exempt');
      const globalSpammerAdminDecisions = settings.deleteSpammersEnabled
        ? await this.resolveGlobalSpammerAdminDecisionsWithHotPathBudget(
            [senderId],
            chat.adminUserIds,
            {
              chatId,
              userId: senderId,
              messageId,
            },
          )
        : new Map<string, LocalGlobalSpammerAdminDecision>();
      const globalSpammerAdminDecision = globalSpammerAdminDecisions.get(senderId) ?? null;
      if (globalSpammerAdminDecision === 'BLOCK') {
        const handled = await this.handleLocalAdminBlockedSenderMessage({
          chatId,
          userId: senderId,
          messageId,
          text,
          createdAt,
        });
        if (handled) {
          await suppressDeferredPhotoAnalysisActions();
          return;
        }
      }
      const isGlobalSpammerExempt = globalSpammerAdminDecision === 'ALLOW';
      let skipKnownSpammerCheck = false;
      if (!skipOptionalHotChatStages) {
        this.markWebhookHotPathStage(hotPathProfile, 'global-spammer-track');
        const globalSpammerTracking = await this.trackAndRegisterGlobalSpammerWithHotPathBudget({
          chatId,
          userId: senderId,
          messageId,
          text,
          createdAt,
          deleteSpammersEnabled: settings.deleteSpammersEnabled,
          exemptFromEnforcement: isGlobalSpammerExempt,
        });
        if (globalSpammerTracking.handled) {
          await suppressDeferredPhotoAnalysisActions();
          return;
        }
        skipKnownSpammerCheck = globalSpammerTracking.skipKnownSpammerCheck;
      }

      if (settings.deleteSpammersEnabled && !skipKnownSpammerCheck && !isGlobalSpammerExempt) {
        const handled = await this.handleKnownSpammerSenderMessage({
          chatId,
          userId: senderId,
          messageId,
          text,
          createdAt,
        });
        this.markWebhookHotPathStage(hotPathProfile, 'known-spammer-check');
        if (handled) {
          await suppressDeferredPhotoAnalysisActions();
          return;
        }
      }

      this.markWebhookHotPathStage(hotPathProfile, 'required-subscription');
      const requiredSubscriptionHandled = await this.handleRequiredSubscriptionMessage({
        sourceUpdateType: updateType,
        chatId,
        userId: senderId,
        userLabel,
        messageId,
        text,
        createdAt,
        settings,
        rulesPublishedUrl,
        rulesPublishedMessageId,
        hotPathProfile,
        mediaNoticeScope: requiredSubscriptionMediaNoticeScope,
      });
      if (requiredSubscriptionHandled) {
        await suppressDeferredPhotoAnalysisActions();
        return;
      }

      this.markWebhookHotPathStage(hotPathProfile, 'invitation-access');
      const invitationAccessHandled = await this.handleInvitationAccessMessage({
        chatId,
        userId: senderId,
        userLabel,
        messageId,
        text,
        createdAt,
        systemMode: mode,
        hotChatBackoffActive,
        settings,
        rulesPublishedUrl,
        rulesPublishedMessageId,
        hotPathProfile,
      });
      if (invitationAccessHandled) {
        await suppressDeferredPhotoAnalysisActions();
        return;
      }

      const reportCommand = this.reportSubmission?.isCommand(update, settings) === true;
      const effectiveMessageLength = calculateEffectiveMessageLength(update);
      const duplicateEventTimeSkipReason = settings.antiDuplicateEnabled
        ? duplicateSafety.resolveEventTimeSkipReason(settings, duplicateStateEventTimestampMs)
        : null;
      if (duplicateEventTimeSkipReason) {
        this.recordOptionalWebhookStageSkip({
          stage: 'rule-engine.duplicate-state.event-time',
          reason: duplicateEventTimeSkipReason,
          failOpen: true,
        });
      }
      const commercialCampaignSkipReason = settings.commercialAdsFilterEnabled
        ? this.resolveOptionalWebhookStageSkipReason({
            stage: 'rule-engine.commercial-campaign',
            hotPathProfile,
            systemMode: mode,
            hotChatBackoffActive,
          })
        : null;
      if (commercialCampaignSkipReason) {
        this.recordOptionalWebhookStageSkip({
          stage: 'rule-engine.commercial-campaign',
          reason: commercialCampaignSkipReason,
          failOpen: true,
        });
      }
      const commercialCampaignContext =
        settings.commercialAdsFilterEnabled && !commercialCampaignSkipReason
          ? await this.collectCommercialCampaignContext({
              chatId,
              senderId,
              text,
              eventTimestampMs: duplicateStateEventTimestampMs,
            })
          : null;
      if (settings.commercialAdsFilterEnabled) {
        this.markWebhookHotPathStage(hotPathProfile, 'rule-engine.commercial-campaign');
      }
      const navigationTargets = extractEnabledWebhookNavigationTargets(
        update.raw,
        this.navigationTargetOptions,
      );
      const fullMessageDuplicates =
        settings.antiDuplicateEnabled &&
        (await this.messageDuplicateService?.isAuthoritative(chatId)) === true;
      this.markWebhookHotPathStage(hotPathProfile, 'rule-engine.detect');
      const detection = await this.ruleEngine.detect({
        chatId,
        userId: senderId,
        messageId,
        duplicateStateEventType,
        duplicateStateEventTimestampMs,
        text,
        settings,
        domainAllowlist: chat.domainAllowlist,
        ...(navigationTargets ? { navigationTargets } : {}),
        stopWordsTextSegments: extractStopWordsTextSegments(update.raw, text),
        effectiveLength: effectiveMessageLength,
        hasPhotoAttachment: mediaFlags.hasPhotoAttachment,
        hasStickerAttachment: mediaFlags.hasStickerAttachment,
        hasVideoAttachment: mediaFlags.hasVideoAttachment,
        hasFileAttachment: mediaFlags.hasFileAttachment,
        hasVoiceAttachment: mediaFlags.hasVoiceAttachment,
        hasForwardedMessage: hasForwardedMessage(update),
        hasMediaBatch: mediaFlags.hasMediaBatch,
        mediaGroupId: extractDirectMediaBatchId(update),
        skipAntiSpamBurstLimit,
        skipContentFiltersForReport: reportCommand,
        skipDuplicateState:
          duplicateEventTimeSkipReason !== null ||
          fullMessageDuplicates ||
          reportCommand ||
          mediaFlags.hasPhotoAttachment,
        skipStatefulMessageLimits: updateType === 'message_edited',
        commercialCampaignContext,
      });
      this.markWebhookHotPathStage(hotPathProfile, 'rule-engine');
      if (detection.violations.length === 0 && this.reportSubmission) {
        this.markWebhookHotPathStage(hotPathProfile, 'report-submission');
        const reportHandled = await this.reportSubmission.handle(update, settings);
        this.markWebhookHotPathStage(hotPathProfile, 'report-submission.complete');
        if (reportHandled) {
          await suppressDeferredPhotoAnalysisActions();
          return;
        }
      }
      const detectedViolations = (
        await this.reconcileLinkAllowlistViolations({
          chatId,
          text,
          settings,
          navigationTargets,
          cachedDomainAllowlist: chat.domainAllowlist,
          violations: detection.violations,
        })
      ).filter((violation) => violation.ruleCode !== 'TOPIC_FILTER_MISMATCH');
      // FLAG: Capture precedes competing-rule exits; this immutable revision grants no sanction.
      let commercialQualityObservation: ReturnType<typeof buildCommercialTextQualityObservation> =
        null;
      if (
        this.commercialReview &&
        settings.commercialAdsFilterEnabled &&
        !reportCommand &&
        !latestSenderChatAdminCheck.isAdmin &&
        !this.isKnownRuntimeBotUserId(senderId)
      ) {
        try {
          commercialQualityObservation = buildCommercialTextQualityObservation({
            secret: this.configService?.get<string>('MAX_WEBHOOK_SECRET_PATH'),
            chatId,
            userId: senderId,
            messageId,
            text,
            settings,
            messageCreatedAt: extractCommercialOcrSourceCreatedAt(update.raw),
            violation: detectedViolations.find((item) => item.ruleCode === 'COMMERCIAL_AD'),
            activeAiEnforcement: this.commercialAi?.enabled() === true,
            commercialCampaignContext,
          });
          if (commercialQualityObservation) {
            const observation = commercialQualityObservation;
            this.runGlobalSpammerSideEffect({ stage: 'commercial-quality-observation' }, () =>
              this.commercialReview!.recordCandidate(observation),
            );
          }
        } catch {
          this.logger.warn(
            { stage: 'commercial-quality-observation' },
            'Commercial quality observation unavailable',
          );
        }
      }
      const violations =
        this.commercialAi?.evaluate(
          detectedViolations,
          update,
          settings,
          !!reportCommand ||
            latestSenderChatAdminCheck.isAdmin ||
            this.isKnownRuntimeBotUserId(senderId),
          commercialQualityObservation,
        ) ?? detectedViolations;
      const hasCompetingViolation = violations.length > 0;
      const duplicateEligibility = resolveDuplicateRuleEligibility(violations, detection);
      const latestManualReleaseAt =
        detection.duplicateDecision || detection.duplicateHit
          ? await this.resolveLatestManualReleaseCreatedAt(chatId, senderId)
          : null;
      const duplicateDecisionSuppressed =
        detection.duplicateDecision && latestManualReleaseAt
          ? this.isWithinWindowFromDate(
              latestManualReleaseAt,
              detection.duplicateDecision.windowSec,
            )
          : false;
      const duplicateHitSuppressed =
        detection.duplicateHit && latestManualReleaseAt
          ? this.isWithinWindowFromDate(latestManualReleaseAt, detection.duplicateHit.windowSec)
          : false;
      const hasUnsuppressedDuplicateOutcome =
        !hasCompetingViolation &&
        ((detection.duplicateDecision && !duplicateDecisionSuppressed) ||
          (detection.duplicateHit && !duplicateHitSuppressed));
      let duplicateSenderAdminCheck = latestSenderChatAdminCheck;
      const shouldRecheckDuplicateAdmin =
        hasUnsuppressedDuplicateOutcome &&
        duplicateSenderAdminCheck.source === 'local_fallback' &&
        duplicateSafety.canResolveAdminAccess(this.maxClient);
      if (shouldRecheckDuplicateAdmin) {
        this.markWebhookHotPathStage(hotPathProfile, 'duplicate-admin-recheck');
        const duplicateAdminRecheckMaxWaitMs = this.resolveWebhookHotPathStageWaitBudgetMs({
          hotPathProfile,
          systemMode: mode,
          hotChatBackoffActive,
          defaultWaitMs: CHAT_ADMIN_NONCRITICAL_LOOKUP_SOFT_TIMEOUT_MS,
          reserveMs: VIOLATION_ADMIN_RECHECK_RESERVE_MS,
        });
        if (duplicateAdminRecheckMaxWaitMs > 0) {
          duplicateSenderAdminCheck = await this.resolveSenderChatAdminCheck(
            chatId,
            chat.adminUserIds,
            senderId,
            {
              allowRemoteLookup: true,
              skipRemoteLookupWhenLocalAdminsKnown: false,
              remoteLookupSoftTimeoutMs: duplicateAdminRecheckMaxWaitMs,
            },
          );
        }
      }
      if (hasUnsuppressedDuplicateOutcome && duplicateSenderAdminCheck.isAdmin) {
        await enqueueCommercialOcr(false);
        if (
          await this.tryHandleKaravanStorefrontRelay({
            update,
            updateType,
            chatId,
            messageId,
            senderId,
            senderName,
            text,
            karavanStorefrontEnabled: settings.karavanStorefrontEnabled,
            storefrontTexts: settings,
            karavanStorefrontAdminsOnly: this.readKaravanStorefrontAdminsOnly(settings),
            storefrontOwnerUserId: this.readKaravanStorefrontOwnerUserId(update, senderId),
          })
        ) {
          return;
        }

        this.markWebhookHotPathStage(hotPathProfile, 'admin-command');
        await this.handleChatAdminModerationBypass({
          update,
          chatId,
          chatTitle,
          senderId,
          senderName,
          messageId,
          text,
          settings,
          source: duplicateSenderAdminCheck.source,
        });
        return;
      }
      if (shouldRecheckDuplicateAdmin && duplicateSenderAdminCheck.source === 'local_fallback') {
        await enqueueCommercialOcr(false);
        this.scheduleDestructiveAdminRosterRefresh({
          chatId,
          chatTitle,
          botId: update.botId ?? null,
          entityType: update.message?.entityType ?? null,
          stage: 'duplicate-enforcement',
        });
        this.recordOptionalWebhookStageSkip({
          stage: 'duplicate-enforcement.admin-recheck',
          reason: 'text duplicate enforcement skipped because sender admin access is unresolved',
          failOpen: true,
        });
        return;
      }
      if (
        !hasCompetingViolation &&
        !hasUnsuppressedDuplicateOutcome &&
        (await this.tryHandleKaravanStorefrontRelay({
          update,
          updateType,
          chatId,
          messageId,
          senderId,
          senderName,
          text,
          karavanStorefrontEnabled: settings.karavanStorefrontEnabled,
          storefrontTexts: settings,
          karavanStorefrontAdminsOnly: this.readKaravanStorefrontAdminsOnly(settings),
          storefrontOwnerUserId: this.readKaravanStorefrontOwnerUserId(update, senderId),
        }))
      ) {
        await suppressDeferredPhotoAnalysisActions();
        return;
      }
      // FLAG: Receiver provenance must not override the selected execution token.
      const messageDuplicateBotId = this.messageDuplicateService
        ? (this.maxBotContextService?.getActiveBotId() ??
          this.readExecutionOwnerBotId(update) ??
          update.botId ??
          this.maxBotLinkService?.getDefaultBotId?.())
        : null;
      if (messageDuplicateBotId) {
        this.markWebhookHotPathStage(hotPathProfile, 'message-duplicate.observe');
        await this.messageDuplicateService?.observe({
          update,
          webhookEventId,
          eventTimestampMs: duplicateStateEventTimestampMs,
          settings,
          botId: messageDuplicateBotId,
          readSelectedBotId: () =>
            this.maxBotContextService?.getActiveBotId() ?? messageDuplicateBotId,
          ...duplicateEligibility,
          executeFullAction: (request) =>
            this.executeDuplicateAction(
              { ...request, rulesPublishedUrl, rulesPublishedMessageId },
              hotPathProfile,
            ),
        });
        this.markWebhookHotPathStage(hotPathProfile, 'message-duplicate.complete');
      }
      const commercialOcrActionEligible =
        !hasActionableCompetingViolation(violations) && !hasUnsuppressedDuplicateOutcome;
      if (
        hasUnsuppressedDuplicateOutcome &&
        (await this.consumeChatParticipantModerationImmunity({
          chatId,
          userId: senderId,
          messageId,
          nightModeTimezone: settings.nightModeTimezone,
        }))
      ) {
        await enqueueCommercialOcr(false);
        this.logger.debug(
          { chatId, userId: senderId },
          'Duplicate moderation bypassed for participant immunity',
        );
        return;
      }
      if (hasUnsuppressedDuplicateOutcome) {
        await enqueueCommercialOcr(false);
      }
      if (!hasCompetingViolation && detection.duplicateDecision && !duplicateDecisionSuppressed) {
        await this.handleDuplicateDecision({
          chatId,
          userId: senderId,
          messageId,
          text,
          createdAt,
          decision: detection.duplicateDecision,
          userLabel,
          muteDurationHours: settings.duplicateMuteDurationHours,
          botSpeechStyle: settings.botSpeechStyle,
          botSpeechMedia: settings.botSpeechMedia,
          duplicateBotMessageEnabled: settings.duplicateBotMessageEnabled,
          duplicateBotMessageText: settings.duplicateBotMessageText,
          duplicateBotButtons: settings.duplicateBotButtons,
          duplicateBotButtonEnabled: settings.duplicateBotButtonEnabled,
          duplicateBotButtonUrl: settings.duplicateBotButtonUrl,
          duplicateBotButtonText: settings.duplicateBotButtonText,
          duplicateAdminContactButtonEnabled: settings.duplicateAdminContactButtonEnabled,
          duplicateAdminContactButtonUrl: settings.duplicateAdminContactButtonUrl,
          rulesAttachViolationsEnabled: settings.rulesAttachViolationsEnabled,
          rulesPublishedUrl,
          rulesPublishedMessageId,
          deleteBotMessagesEnabled: settings.deleteBotMessagesEnabled,
          deleteBotMessagesDelayMinutes: settings.deleteBotMessagesDelayMinutes,
          suppressNonEssentialMessages: hotChatBackoffActive,
          hotPathProfile,
        });
        return;
      }
      if (!hasCompetingViolation && detection.duplicateHit && !duplicateHitSuppressed) {
        await this.handleDuplicateHit({
          chatId,
          userId: senderId,
          messageId,
          text,
          createdAt,
          hit: detection.duplicateHit,
          userLabel,
          botSpeechStyle: settings.botSpeechStyle,
          botSpeechMedia: settings.botSpeechMedia,
          duplicateBotMessageEnabled: settings.duplicateBotMessageEnabled,
          duplicateBotMessageText: settings.duplicateBotMessageText,
          duplicateBotButtons: settings.duplicateBotButtons,
          duplicateBotButtonEnabled: settings.duplicateBotButtonEnabled,
          duplicateBotButtonUrl: settings.duplicateBotButtonUrl,
          duplicateBotButtonText: settings.duplicateBotButtonText,
          duplicateAdminContactButtonEnabled: settings.duplicateAdminContactButtonEnabled,
          duplicateAdminContactButtonUrl: settings.duplicateAdminContactButtonUrl,
          rulesAttachViolationsEnabled: settings.rulesAttachViolationsEnabled,
          rulesPublishedUrl,
          rulesPublishedMessageId,
          deleteBotMessagesEnabled: settings.deleteBotMessagesEnabled,
          deleteBotMessagesDelayMinutes: settings.deleteBotMessagesDelayMinutes,
          suppressNonEssentialMessages: hotChatBackoffActive,
          hotPathProfile,
        });
        return;
      }
      if (violations.length === 0) {
        await enqueueCommercialOcr(commercialOcrActionEligible);
        return;
      }

      this.markWebhookHotPathStage(hotPathProfile, 'violation-admin-recheck');
      const violationAdminRecheckMaxWaitMs = this.resolveWebhookHotPathStageWaitBudgetMs({
        hotPathProfile,
        systemMode: mode,
        hotChatBackoffActive,
        defaultWaitMs: CHAT_ADMIN_NONCRITICAL_LOOKUP_SOFT_TIMEOUT_MS,
        reserveMs: VIOLATION_ADMIN_RECHECK_RESERVE_MS,
      });
      let violationSenderAdminCheck = latestSenderChatAdminCheck;
      if (violationAdminRecheckMaxWaitMs > 0) {
        violationSenderAdminCheck = await this.recheckSenderChatAdminBeforeModeration(
          chatId,
          chat.adminUserIds,
          senderId,
          senderChatAdminCheck,
          {
            maxWaitMs: violationAdminRecheckMaxWaitMs,
          },
        );
      } else {
        const skipReason = this.resolveOptionalWebhookStageSkipReason({
          stage: 'admin-check.violation-recheck',
          hotPathProfile,
          systemMode: mode,
          hotChatBackoffActive,
          minRemainingMs: VIOLATION_ADMIN_RECHECK_RESERVE_MS,
        });
        if (skipReason) {
          this.recordOptionalWebhookStageSkip({
            stage: 'admin-check.violation-recheck',
            reason: skipReason,
          });
        }
      }
      if (violationSenderAdminCheck.isAdmin) {
        await enqueueCommercialOcr(false);
        if (
          await this.tryHandleKaravanStorefrontRelay({
            update,
            updateType,
            chatId,
            messageId,
            senderId,
            senderName,
            text,
            karavanStorefrontEnabled: settings.karavanStorefrontEnabled,
            storefrontTexts: settings,
            karavanStorefrontAdminsOnly: this.readKaravanStorefrontAdminsOnly(settings),
            storefrontOwnerUserId: this.readKaravanStorefrontOwnerUserId(update, senderId),
          })
        ) {
          return;
        }

        this.markWebhookHotPathStage(hotPathProfile, 'admin-command');
        await this.handleChatAdminModerationBypass({
          update,
          chatId,
          chatTitle,
          senderId,
          senderName,
          messageId,
          text,
          settings,
          source: violationSenderAdminCheck.source,
        });
        return;
      }

      const topViolation = selectTopModerationViolation(violations);
      if (!topViolation) return;
      const selectedMetadata = this.asRecord(topViolation.metadata);
      const consumesImmunity =
        topViolation.ruleCode !== 'COMMERCIAL_AD' ||
        isCommercialMessageDeleteEligible(
          this.readString(selectedMetadata?.actionBand),
          this.readBoolean(selectedMetadata?.actionable) ??
            !['ALLOW', 'REVIEW_ONLY'].includes(
              this.readString(selectedMetadata?.actionBand) ?? 'ALLOW',
            ),
          selectedMetadata?.messageDisposition,
        );
      if (
        consumesImmunity &&
        (await this.consumeChatParticipantModerationImmunity({
          chatId,
          userId: senderId,
          messageId,
          nightModeTimezone: settings.nightModeTimezone,
        }))
      ) {
        await enqueueCommercialOcr(false);
        return;
      }
      await enqueueCommercialOcr(commercialOcrActionEligible);

      const moderationExecutionPolicySha256 = bindModerationExecutionPolicy(
        settings,
        topViolation,
        duplicateStateEventTimestampMs ?? Date.parse(createdAt),
        this.configService?.get<string>('PROFANITY_V2_ROLLOUT_MODE') === 'legacy' ? 'legacy' : 'on',
      );
      if (
        topViolation.ruleCode === 'MESSAGE_BLOCKED_WORD' ||
        topViolation.ruleCode === 'MESSAGE_BLOCKED_DOMAIN'
      ) {
        const stopWordsPolicy = readStopWordsPolicy(settings);
        if (stopWordsPolicy) settings = withStopWordsSanctions(settings, stopWordsPolicy);
      }
      const commercialActionBand =
        topViolation.ruleCode === 'COMMERCIAL_AD'
          ? this.readString(this.asRecord(topViolation.metadata)?.actionBand)
          : null;
      const commercialMetadata =
        topViolation.ruleCode === 'COMMERCIAL_AD' ? this.asRecord(topViolation.metadata) : null;
      const commercialDispositionAllowsEnforcement =
        commercialMetadata?.messageDisposition === undefined ||
        commercialMetadata.messageDisposition === 'DELETE';
      const commercialRecordable =
        topViolation.ruleCode === 'COMMERCIAL_AD'
          ? commercialDispositionAllowsEnforcement &&
            (this.readBoolean(commercialMetadata?.recordable) ??
              (commercialActionBand !== null &&
                commercialActionBand !== 'ALLOW' &&
                commercialActionBand !== 'REVIEW_ONLY'))
          : true;
      const commercialActionable =
        topViolation.ruleCode === 'COMMERCIAL_AD'
          ? commercialDispositionAllowsEnforcement &&
            (this.readBoolean(commercialMetadata?.actionable) ??
              (commercialActionBand !== null &&
                commercialActionBand !== 'ALLOW' &&
                commercialActionBand !== 'REVIEW_ONLY'))
          : true;
      const isCommercialReviewOnly =
        topViolation.ruleCode === 'COMMERCIAL_AD' && !commercialRecordable;
      const shouldDeleteByCommercialPolicy =
        topViolation.ruleCode !== 'COMMERCIAL_AD' ||
        isCommercialMessageDeleteEligible(
          commercialActionBand,
          commercialActionable,
          commercialMetadata?.messageDisposition,
        );
      const isLinkBlockedDelete = topViolation.ruleCode === 'LINK_BLOCKED';
      let violationDeleteIntent: EnsureModerationDeleteIntentInput | null =
        shouldDeleteByCommercialPolicy
          ? {
              chatId,
              messageId,
              reasonKey: isTrafficProtectionViolation(topViolation.ruleCode)
                ? `${topViolation.ruleCode}:violation-delete:r${topViolation.metadata?.trafficPolicyRevision}:e${topViolation.metadata?.trafficEventTimestampMs}`
                : isLinkBlockedDelete
                  ? `${topViolation.ruleCode}:violation-delete:r${settings.linkPolicyRevision}`
                  : `${topViolation.ruleCode}:violation-delete`,
              ruleCode: isLinkBlockedDelete
                ? LINK_BLOCKED_DELETE_RULE_CODE
                : `${topViolation.ruleCode}_DELETE`,
              subjectUserId: senderId,
              sourceMessageAt: createdAt,
              ...(isTrafficProtectionViolation(topViolation.ruleCode) &&
              typeof topViolation.metadata?.trafficDeadlineAtMs === 'number'
                ? { retryUntilAt: new Date(topViolation.metadata.trafficDeadlineAtMs) }
                : {}),
              ...(MESSAGE_LIMITS_STATEFUL_RULES.has(`${topViolation.ruleCode}_DELETE`) &&
              typeof topViolation.metadata?.messageLimitDeadlineAtMs === 'number'
                ? { retryUntilAt: new Date(topViolation.metadata.messageLimitDeadlineAtMs) }
                : {}),
              entityType: 'CHAT',
              messageAuthorKind: 'user',
              event: {
                userId: senderId,
                eventType: 'MESSAGE',
                maskedExcerpt: maskText(text),
                score: topViolation.score,
                metadata: {
                  reason: topViolation.reason,
                  ...(topViolation.metadata && typeof topViolation.metadata === 'object'
                    ? topViolation.metadata
                    : {}),
                  ...(isLinkBlockedDelete
                    ? {
                        linkPolicyRevision: settings.linkPolicyRevision,
                        linkPolicyEffectiveAt: serializeLinkPolicyEffectiveAt(
                          settings.linkPolicyEffectiveAt,
                        ),
                      }
                    : {}),
                },
              },
            }
          : null;
      let durableRuleFollowupId: string | null = null;
      if (violationDeleteIntent) {
        violationDeleteIntent = bindVoiceSourceEvidence(
          violationDeleteIntent,
          update,
          settings,
          webhookEventId,
        );
        violationDeleteIntent = bindCommercialTextDeleteIntent(violationDeleteIntent, {
          text,
          settings,
          campaignContext: commercialCampaignContext ?? null,
        });
        violationDeleteIntent = await prepareCommercialQualityDelete(
          this.commercialReview,
          commercialQualityObservation,
          violationDeleteIntent,
        );
        if (
          this.moderationRuleFollowupService &&
          this.moderationDeleteIntentService &&
          DURABLE_RULE_FOLLOWUP_RULES.has(violationDeleteIntent.ruleCode ?? '') &&
          (updateType === 'message_created' || updateType === 'message_edited')
        ) {
          this.markWebhookHotPathStage(hotPathProfile, 'violation-rule-followup.persist');
          let registered: { followupId: string | null };
          try {
            registered = await this.moderationDeleteIntentService.ensureIntentWithRuleFollowup(
              {
                ...violationDeleteIntent,
                originBotId: update.botId ?? null,
                routingPolicy: 'delete_capable',
              },
              moderationExecutionPolicySha256,
              {
                version: 1,
                updateType,
                originBotId: update.botId ?? null,
                userLabel,
                effectiveMessageLength,
                rulesPublishedUrl,
                rulesPublishedMessageId,
              },
            );
          } catch (error) {
            // FLAG: This typed expiry is emitted inside the registration transaction before
            // effects, or after rolling its new intent back. Invalid bindings remain failures.
            if (error instanceof ModerationRuleFollowupSourceExpiredError) return;
            throw error;
          }
          this.markWebhookHotPathStage(hotPathProfile, 'violation-rule-followup.complete');
          durableRuleFollowupId = registered.followupId;
        } else await this.ensureModerationDeleteIntent(violationDeleteIntent, undefined, false);
      }
      // FLAG: Traffic policies are delete-only. They must never add strikes, feed
      // global reputation, or enter the existing configurable sanction ladders.
      if (isTrafficProtectionViolation(topViolation.ruleCode)) {
        if (violationDeleteIntent) await this.executeModerationDelete(violationDeleteIntent);
        this.markWebhookHotPathSuccessBoundary(hotPathProfile, 'traffic-protection');
        return;
      }
      const isProfanityViolation = topViolation.ruleCode === 'PROFANITY';
      const requiresOwnedRuleDelete = !!this.moderationRuleSanctionGuard && !isCommercialReviewOnly;
      const requiresConfirmedTextDelete =
        requiresOwnedRuleDelete ||
        isProfanityViolation ||
        (topViolation.ruleCode === 'COMMERCIAL_AD' && !isCommercialReviewOnly);
      let commercialSanctionPermit: CommercialSanctionPermit | null = null;
      let ownRuleDeleteBotId: string | undefined;
      const ownRuleGuards = createRuleSanctionGuards(
        requiresOwnedRuleDelete && topViolation.ruleCode !== 'COMMERCIAL_AD'
          ? (proof, options) => this.moderationRuleSanctionGuard!.assertAllowed(proof, options)
          : undefined,
        violationDeleteIntent,
        moderationExecutionPolicySha256,
        () => ownRuleDeleteBotId ?? update.botId,
        () => this.maxBotContextService?.getActiveBotId() ?? ownRuleDeleteBotId ?? update.botId,
      );
      const claimViolation = async () => {
        if (!isCommercialReviewOnly) {
          this.markWebhookHotPathStage(hotPathProfile, 'violation-record');
        }
        return isCommercialReviewOnly
          ? this.claimMessageViolationProcessing({
              chatId,
              userId: senderId,
              messageId,
              ruleCode: topViolation.ruleCode,
              updateType,
            })
          : claimAndPersistModerationMessageViolation(
              this.prisma,
              {
                chatId,
                userId: senderId,
                messageId,
                ruleCode: topViolation.ruleCode,
                updateType,
                score: topViolation.score,
              },
              (input) => this.claimMessageViolationProcessing(input),
              (context) => this.logSkippedDuplicateMessageViolation(context),
              (claimKey, context) => this.markRedisMessageViolationProcessing(claimKey, context),
            );
      };
      if (!requiresConfirmedTextDelete && !(await claimViolation())) {
        this.markWebhookHotPathSuccessBoundary(hotPathProfile, 'violation-dedup');
        return;
      }

      const recordCommercialObservations = () => {
        if (this.globalSpammerIntelligence && !isCommercialReviewOnly) {
          this.runGlobalSpammerSideEffect(
            {
              chatId,
              userId: senderId,
              messageId,
              action: 'record-commercial-spammer-observations',
            },
            async () => {
              await this.globalSpammerIntelligence!.recordCommercialObservations({
                chatId,
                userId: senderId,
                messageId,
                text,
                userLabel,
                topViolation,
                commercialCampaignContext,
              });
            },
          );
        }
      };
      if (!requiresConfirmedTextDelete) recordCommercialObservations();

      let messageDeleted = false;

      if (violationDeleteIntent) {
        this.markWebhookHotPathStage(hotPathProfile, 'violation-delete');
        const deleteResult = await this.executeModerationDelete(violationDeleteIntent);
        if (topViolation.ruleCode === 'COMMERCIAL_AD') {
          this.runGlobalSpammerSideEffect({ stage: 'commercial-quality-execution' }, () =>
            recordCommercialQualityExecution(
              this.commercialReview,
              commercialQualityObservation,
              deleteResult,
            ),
          );
        }
        messageDeleted = deleteResult.gone;
        // FLAG: New v1 envelopes continue only the saved own rule through its outbox.
        // Late workers never replay the engine or mint authority for historical reasons.
        if (durableRuleFollowupId) {
          await this.moderationRuleFollowupService!.attempt(durableRuleFollowupId);
          this.markWebhookHotPathSuccessBoundary(hotPathProfile, 'violation-delete');
          return;
        }
        // FLAG: Only a fresh text-policy check followed by this attempt's confirmed DELETE may
        // create a violation or escalate. Absence, independent reasons and background retries do not.
        if (requiresConfirmedTextDelete) {
          if (
            !deleteResult.deleted ||
            !(isProfanityViolation
              ? deleteResult.profanityVerified
              : topViolation.ruleCode === 'COMMERCIAL_AD'
                ? deleteResult.commercialVerified
                : deleteResult.ownReasonVerified)
          ) {
            return;
          }
          if (topViolation.ruleCode === 'COMMERCIAL_AD') {
            commercialSanctionPermit =
              this.commercialDeleteGuard?.createSanctionPermit({
                chatId,
                messageId,
                subjectUserId: senderId,
                botId: deleteResult.botId ?? update.botId,
                deleted: deleteResult.deleted,
                commercialVerified: deleteResult.commercialVerified === true,
                evidence: [
                  {
                    reasonKey: violationDeleteIntent.reasonKey,
                    score: topViolation.score,
                    metadata: violationDeleteIntent.event?.metadata,
                  },
                ],
              }) ?? null;
            if (
              !commercialSanctionPermit ||
              !(await this.commercialDeleteGuard!.authorizeSanction(commercialSanctionPermit))
            )
              return;
          }
          ownRuleDeleteBotId = deleteResult.botId ?? update.botId;
          if (ownRuleGuards && !(await ownRuleGuards.authorizeSanction())) return;
          if (!(await claimViolation())) {
            this.markWebhookHotPathSuccessBoundary(hotPathProfile, 'violation-dedup');
            return;
          }
          recordCommercialObservations();
        }
        if (deleteResult.deleted && !deleteResult.eventPersistedByIntent) {
          await this.createBotModerationEvent({
            data: {
              chatId,
              userId: senderId,
              messageId,
              eventType: EventType.MESSAGE,
              ruleCode: `${topViolation.ruleCode}_DELETE`,
              action: SanctionAction.DELETE_MESSAGE,
              maskedExcerpt: maskText(text),
              score: topViolation.score,
              operator: Operator.BOT,
              metadata: {
                reason: topViolation.reason,
                ...(topViolation.metadata && typeof topViolation.metadata === 'object'
                  ? topViolation.metadata
                  : {}),
              },
            },
          });
        }
        if (messageDeleted) {
          this.markWebhookHotPathSuccessBoundary(hotPathProfile, 'violation-delete');
        }
      }

      this.markWebhookHotPathStage(hotPathProfile, 'violation-follow-up');
      const authorizeCommercialSanction =
        topViolation.ruleCode === 'COMMERCIAL_AD' && !isCommercialReviewOnly
          ? async () =>
              !!commercialSanctionPermit &&
              (await this.commercialDeleteGuard!.authorizeSanction(commercialSanctionPermit))
          : undefined;
      const beforeNoticeSend = createModerationNoticeGuard(
        authorizeCommercialSanction,
        ownRuleGuards?.assertBeforeFollowUp,
      );
      const authorizeCommercialFinal = authorizeCommercialSanction
        ? async (beforeFinalAuthority?: () => Promise<void>) =>
            !!commercialSanctionPermit &&
            this.commercialDeleteGuard!.authorizeSanction(commercialSanctionPermit, {
              botId: this.maxBotContextService?.getActiveBotId() ?? undefined,
              beforeFinalAuthority,
            })
        : undefined;
      const runViolationFollowUp = () =>
        executeModerationRuleFollowUp(this.getRuleFollowupHost(), {
          chatId,
          senderId,
          messageId,
          userLabel,
          topViolation,
          settings,
          updateType,
          maskedExcerpt: maskText(text),
          effectiveMessageLength,
          rulesPublishedUrl,
          rulesPublishedMessageId,
          messageDeleted,
          isCommercialReviewOnly,
          ownRuleGuards,
          authorizeCommercialSanction,
          authorizeCommercialFinal,
          beforeNoticeSend,
        });

      await this.runWebhookFollowUpWithBudget({
        stage: 'violation-follow-up',
        hotPathProfile,
        chatId,
        userId: senderId,
        messageId,
        maxWaitMs: VIOLATION_FOLLOW_UP_HOT_PATH_TIMEOUT_MS,
        task: () => runRuleFollowUpWhileAuthorized(runViolationFollowUp),
      });
    } finally {
      if (sharedChatExecutionLock) {
        await this.releaseSharedChatExecutionLock(sharedChatExecutionLock);
      }
    }
  }

  private async runWebhookFollowUpWithBudget(params: {
    stage: string;
    hotPathProfile?: WebhookHotPathProfile | null;
    chatId: string;
    userId?: string | null;
    messageId?: string | null;
    maxWaitMs: number;
    minRemainingMs?: number;
    task: () => Promise<void>;
  }): Promise<void> {
    if (
      this.shouldDetachFollowUpForBudget(params.hotPathProfile, params.stage, params.minRemainingMs)
    ) {
      this.scheduleDetachedWebhookFollowUp({
        stage: params.stage,
        chatId: params.chatId,
        userId: params.userId,
        messageId: params.messageId,
        task: params.task,
      });
      return;
    }

    const waitMs = this.resolveWebhookFollowUpWaitBudgetMs({
      hotPathProfile: params.hotPathProfile,
      maxWaitMs: params.maxWaitMs,
      minRemainingMs: params.minRemainingMs,
    });
    if (waitMs <= 0) {
      void this.runtimeDiagnosticsService?.recordHotPathStageOutcome({
        stage: `${params.stage}.deferred`,
        outcome: 'skip',
        failOpen: true,
      });
      this.scheduleDetachedWebhookFollowUp({
        stage: params.stage,
        chatId: params.chatId,
        userId: params.userId,
        messageId: params.messageId,
        task: params.task,
      });
      return;
    }

    let detached = false;
    const operation = Promise.resolve().then(params.task);
    operation.catch((error: unknown) => {
      if (!detached) {
        return;
      }
      void this.runtimeDiagnosticsService?.recordHotPathStageOutcome({
        stage: 'follow_up_failed',
        outcome: 'timeout',
        failOpen: true,
      });
      void this.runtimeDiagnosticsService?.recordHotPathStageOutcome({
        stage: `${params.stage}.failed`,
        outcome: 'timeout',
        failOpen: true,
      });
      this.logger.warn(
        {
          stage: params.stage,
          chatId: params.chatId,
          userId: params.userId ?? null,
          messageId: params.messageId ?? null,
          err: error instanceof Error ? error.message : String(error),
        },
        'Deferred webhook follow-up failed after the user-facing budget window',
      );
    });

    let timedOut = false;
    try {
      await raceWithTimeout({
        operation,
        timeoutMs: waitMs,
        onTimeout: () => {
          timedOut = true;
          detached = true;
        },
      });
    } catch (error: unknown) {
      // FLAG: Only the optional duplicate explanation may fail after completed deletion.
      // Violation follow-ups can still owe sanctions. Never retry this settled task or its effects.
      if (
        params.stage !== 'duplicate-follow-up' ||
        params.hotPathProfile?.successBoundaryReached !== true
      )
        throw error;
      void this.runtimeDiagnosticsService?.recordHotPathStageOutcome({
        stage: 'follow_up_failed',
        outcome: 'skip',
        failOpen: true,
      });
      void this.runtimeDiagnosticsService?.recordHotPathStageOutcome({
        stage: `${params.stage}.failed`,
        outcome: 'skip',
        failOpen: true,
      });
      this.logger.warn(
        { stage: params.stage, ...describeWebhookExecutionFailure(error) },
        'Webhook follow-up failed after the user-facing success boundary',
      );
      return;
    }
    if (!timedOut) {
      return;
    }

    void this.runtimeDiagnosticsService?.recordHotPathStageOutcome({
      stage: `${params.stage}.deferred`,
      outcome: 'skip',
      failOpen: true,
    });
    void this.runtimeDiagnosticsService?.recordHotPathStageOutcome({
      stage: 'follow_up_deferred',
      outcome: 'skip',
      failOpen: true,
    });
    this.logger.debug(
      {
        stage: params.stage,
        chatId: params.chatId,
        userId: params.userId ?? null,
        messageId: params.messageId ?? null,
        timeoutMs: waitMs,
      },
      'Detached webhook follow-up after hot-path budget window',
    );
  }

  private resolveWebhookFollowUpWaitBudgetMs(params: {
    hotPathProfile?: WebhookHotPathProfile | null;
    maxWaitMs: number;
    minRemainingMs?: number;
  }): number {
    const maxWaitMs = Math.max(1, Math.ceil(params.maxWaitMs));
    const snapshot = this.readWebhookHotPathProfileSnapshot(params.hotPathProfile);
    const elapsedMs =
      typeof snapshot?.elapsedMs === 'number' && Number.isFinite(snapshot.elapsedMs)
        ? snapshot.elapsedMs
        : null;
    if (elapsedMs === null) {
      return maxWaitMs;
    }

    const minRemainingMs = Math.max(1, Math.ceil(params.minRemainingMs ?? 500));
    const remainingMs = Math.max(0, this.webhookUserFacingTimeoutMs - elapsedMs);
    if (remainingMs <= minRemainingMs) {
      return 0;
    }

    return Math.min(maxWaitMs, Math.max(0, remainingMs - minRemainingMs));
  }

  private async handleDuplicateDecision(params: {
    chatId: string;
    userId: string;
    messageId: string;
    text: string;
    createdAt: string;
    decision: DuplicateDecision;
    userLabel: string;
    muteDurationHours: number;
    botSpeechStyle: BotSpeechStyle | null;
    botSpeechMedia: ChatSettings['botSpeechMedia'];
    duplicateBotMessageEnabled: boolean;
    duplicateBotMessageText: string;
    duplicateBotButtons: unknown;
    duplicateBotButtonEnabled: boolean;
    duplicateBotButtonUrl: string;
    duplicateBotButtonText: string;
    duplicateAdminContactButtonEnabled: boolean;
    duplicateAdminContactButtonUrl: string;
    rulesAttachViolationsEnabled: boolean;
    rulesPublishedUrl: string | null;
    rulesPublishedMessageId: string | null;
    deleteBotMessagesEnabled: boolean;
    deleteBotMessagesDelayMinutes: number;
    suppressNonEssentialMessages: boolean;
    hotPathProfile?: WebhookHotPathProfile | null;
    actionClaimed?: boolean;
    backgroundExecution?: boolean;
    assertActiveLease?: () => void;
    trackAsGlobalSpammer?: boolean;
    authorizeDelete?: (phase?: ModerationDeletePreDispatchPhase) => Promise<boolean>;
    authorizeSanction?: () => Promise<boolean>;
    beforeSanctionMutation?: (beforeFinalAuthority?: () => Promise<void>) => Promise<void>;
    deleteIntent?: EnsureModerationDeleteIntentInput;
    duplicateNoticePolicySha256?: string;
  }) {
    const {
      chatId,
      userId,
      messageId,
      text,
      createdAt,
      decision,
      userLabel,
      muteDurationHours,
      botSpeechStyle,
      botSpeechMedia,
      duplicateBotMessageEnabled,
      duplicateBotMessageText,
      duplicateBotButtons,
      duplicateBotButtonEnabled,
      duplicateBotButtonUrl,
      duplicateBotButtonText,
      duplicateAdminContactButtonEnabled,
      duplicateAdminContactButtonUrl,
      rulesAttachViolationsEnabled,
      rulesPublishedUrl,
      rulesPublishedMessageId,
      deleteBotMessagesEnabled,
      deleteBotMessagesDelayMinutes,
      suppressNonEssentialMessages,
      hotPathProfile,
      actionClaimed = false,
      backgroundExecution = false,
      assertActiveLease,
      trackAsGlobalSpammer = true,
      authorizeDelete,
      authorizeSanction,
    } = params;
    let messageDeleted = false;
    const deleteIntent: EnsureModerationDeleteIntentInput = params.deleteIntent ?? {
      chatId,
      messageId,
      reasonKey: 'DUPLICATE:decision-delete',
      ruleCode: 'DUPLICATE_DELETE',
      subjectUserId: userId,
      sourceMessageAt: createdAt,
      entityType: 'CHAT',
      messageAuthorKind: 'user',
      event: {
        userId,
        eventType: 'MESSAGE',
        maskedExcerpt: maskText(text),
        score: 0.8,
        metadata: {
          ...decision.metadata,
          windowSec: decision.windowSec,
          count: decision.count,
          threshold: decision.threshold,
          fingerprintType: decision.fingerprintType,
          reason: this.resolveDuplicateRemovalReason(decision.fingerprintType),
        },
      },
    };
    assertActiveLease?.();
    await this.ensureModerationDeleteIntent(deleteIntent);
    assertActiveLease?.();

    assertActiveLease?.();
    const actionClaim = actionClaimed
      ? 'claimed'
      : await this.claimDuplicateMessageAction({ chatId, userId, messageId });
    if (actionClaim === 'blocked') {
      return;
    }
    assertActiveLease?.();

    const deleteAuthorization = createDuplicateDeleteAuthorizationGuard({
      assertActiveLease,
      authorizeDelete,
    });
    assertActiveLease?.();
    try {
      this.markWebhookHotPathStage(hotPathProfile, 'duplicate-delete');
      const deleteResult = await this.executeModerationDelete(deleteIntent, {
        beforeImmediateDeleteMutation: deleteAuthorization.beforeImmediateDeleteMutation,
      });
      if (deleteResult.inlineDeclined || deleteAuthorization.wasRejected()) {
        return;
      }
      assertActiveLease?.();
      messageDeleted = deleteResult.gone;
      if (deleteResult.deleted && !deleteResult.eventPersistedByIntent) {
        assertActiveLease?.();
        await this.createBotModerationEvent({
          data: {
            chatId,
            userId,
            messageId,
            eventType: EventType.MESSAGE,
            ruleCode: 'DUPLICATE_DELETE',
            action: SanctionAction.DELETE_MESSAGE,
            maskedExcerpt: maskText(text),
            score: 0.8,
            operator: Operator.BOT,
            metadata: {
              ...decision.metadata,
              windowSec: decision.windowSec,
              count: decision.count,
              threshold: decision.threshold,
              fingerprintType: decision.fingerprintType,
              reason: this.resolveDuplicateRemovalReason(decision.fingerprintType),
            },
          },
        });
        assertActiveLease?.();
      }
      if (messageDeleted) {
        this.markWebhookHotPathSuccessBoundary(hotPathProfile, 'duplicate-delete');
      }
    } catch (error: unknown) {
      if (deleteAuthorization.wasRejected()) {
        return;
      }
      if (deleteAuthorization.verificationFailed()) {
        throw error;
      }
      assertActiveLease?.();
      this.logger.warn(
        {
          chatId,
          userId,
          messageId,
          error: error instanceof Error ? error.message : 'Unknown error',
        },
        'Failed to delete duplicate message',
      );
    }

    assertActiveLease?.();
    this.markWebhookHotPathStage(hotPathProfile, 'duplicate-sanction');
    const duplicateMessageOptions = this.buildBotMessageOptions(
      chatId,
      duplicateBotButtons,
      duplicateBotButtonEnabled,
      duplicateBotButtonUrl,
      duplicateBotButtonText,
      rulesAttachViolationsEnabled,
      rulesPublishedUrl,
      rulesPublishedMessageId,
    );
    const action = this.toSanctionAction(decision.action);
    const sanctionUserLabel =
      action === SanctionAction.MUTE || action === SanctionAction.BAN
        ? await this.resolveSanctionUserLabel(chatId, userId, userLabel)
        : userLabel;
    const persistModerationEvent = (
      metadataPatch: Record<string, unknown> = {},
      actionOverride: SanctionAction = action,
    ) => {
      assertActiveLease?.();
      return this.createBotModerationEvent({
        data: {
          chatId,
          userId,
          messageId,
          eventType: EventType.MESSAGE,
          ruleCode: `DUPLICATE_${decision.action}`,
          action: actionOverride,
          maskedExcerpt: maskText(text),
          score: 0.8,
          operator: Operator.BOT,
          metadata: {
            ...decision.metadata,
            windowSec: decision.windowSec,
            count: decision.count,
            threshold: decision.threshold,
            nextStep: decision.nextAction,
            fingerprintType: decision.fingerprintType,
            ...metadataPatch,
          },
        },
      });
    };
    const sanctionAuthorization = createDuplicateSanctionAuthorization({
      model: this.prisma.moderationEvent as unknown as TerminalDuplicateSanctionEventModel,
      chatId,
      userId,
      messageId,
      authorizeSanction,
    });
    const sanctionEventPersisted = await this.applySanctionAction({
      chatId,
      userId,
      action,
      userLabel: sanctionUserLabel,
      messageId,
      muteDurationHours,
      deleteBotMessagesEnabled,
      deleteBotMessagesDelayMinutes,
      botMessageOptions: withMarketplaceModerationMessage(
        duplicateMessageOptions,
        chatId,
        'MODERATION_NOTICE',
        'DUPLICATES',
      ),
      botSpeechStyle,
      persistModerationEvent,
      assertActiveLease,
      trackAsGlobalSpammer,
      authorizeSanction: sanctionAuthorization.authorize,
      beforeSanctionMutation: params.beforeSanctionMutation,
      noticeIdempotencyKey: duplicateSanctionNoticeIdempotencyKey(
        decision.metadata,
        chatId,
        messageId,
        decision.action,
      ),
      noticeDispatchOptions: createDuplicateSanctionNoticeDispatchOptions(
        params.beforeSanctionMutation,
      ),
      rethrowPreDispatchFailure: true,
    });
    assertActiveLease?.();
    if (sanctionAuthorization.wasRejected()) {
      return;
    }
    duplicateSafety.throwIfDuplicateMuteNotApplied(decision.action, sanctionEventPersisted);

    if (!sanctionEventPersisted) {
      assertActiveLease?.();
      await persistModerationDecisionWithoutAppliedSanction(persistModerationEvent, action);
      assertActiveLease?.();
    }

    if (suppressNonEssentialMessages || !duplicateBotMessageEnabled || decision.action === 'BAN') {
      return;
    }

    this.markWebhookHotPathStage(hotPathProfile, 'duplicate-follow-up');
    const runDuplicateExplanation = async () => {
      try {
        assertActiveLease?.();
        const explanationText = this.buildDuplicateExplanation(
          sanctionUserLabel,
          decision,
          muteDurationHours,
          messageDeleted,
          duplicateBotMessageText,
          botSpeechStyle,
          decision.fingerprintType,
        );
        const explanationWithContact =
          decision.action === 'WARN'
            ? await this.appendAdminContactMarkdownLink(
                chatId,
                explanationText,
                duplicateAdminContactButtonEnabled,
                duplicateAdminContactButtonUrl,
              )
            : explanationText;
        assertActiveLease?.();
        await this.sendBotMessageWithOptionalAutoDelete({
          chatId,
          text: explanationWithContact,
          messageOptions: withMarketplaceModerationMessage(
            duplicateMessageOptions,
            chatId,
            'MODERATION_NOTICE',
            'DUPLICATES',
          ),
          media: this.resolveBotSpeechMedia({ botSpeechMedia }, 'duplicateBotMessageText'),
          deleteBotMessagesEnabled,
          deleteBotMessagesDelayMinutes,
          idempotencyKey: duplicateExplanationIdempotencyKey(decision.metadata, chatId, messageId),
          beforeSend: assertActiveLease ? async () => assertActiveLease() : undefined,
          ledgerContext: await buildMessageDuplicateNoticeContext(
            this.prisma,
            deleteIntent,
            params.duplicateNoticePolicySha256,
            decision,
          ),
        });
        assertActiveLease?.();
      } catch (error: unknown) {
        assertActiveLease?.();
        this.logger.warn(
          {
            chatId,
            userId,
            messageId,
            error: error instanceof Error ? error.message : 'Unknown error',
          },
          'Failed to send duplicate explanation message',
        );
      }
      assertActiveLease?.();
    };

    if (backgroundExecution) {
      assertActiveLease?.();
      await runDuplicateExplanation();
      assertActiveLease?.();
    } else {
      await this.runWebhookFollowUpWithBudget({
        stage: 'duplicate-follow-up',
        hotPathProfile,
        chatId,
        userId,
        messageId,
        maxWaitMs: DUPLICATE_FOLLOW_UP_HOT_PATH_TIMEOUT_MS,
        minRemainingMs: DUPLICATE_FOLLOW_UP_DETACH_MIN_REMAINING_MS,
        task: runDuplicateExplanation,
      });
    }
  }

  private async handleDuplicateHit(params: {
    chatId: string;
    userId: string;
    messageId: string;
    text: string;
    createdAt: string;
    hit: DuplicateHit;
    userLabel: string;
    botSpeechStyle: BotSpeechStyle | null;
    botSpeechMedia: ChatSettings['botSpeechMedia'];
    duplicateBotMessageEnabled: boolean;
    duplicateBotMessageText: string;
    duplicateBotButtons: unknown;
    duplicateBotButtonEnabled: boolean;
    duplicateBotButtonUrl: string;
    duplicateBotButtonText: string;
    duplicateAdminContactButtonEnabled: boolean;
    duplicateAdminContactButtonUrl: string;
    rulesAttachViolationsEnabled: boolean;
    rulesPublishedUrl: string | null;
    rulesPublishedMessageId: string | null;
    deleteBotMessagesEnabled: boolean;
    deleteBotMessagesDelayMinutes: number;
    suppressNonEssentialMessages: boolean;
    hotPathProfile?: WebhookHotPathProfile | null;
    actionClaimed?: boolean;
    backgroundExecution?: boolean;
    assertActiveLease?: () => void;
    authorizeDelete?: (phase?: ModerationDeletePreDispatchPhase) => Promise<boolean>;
    deleteIntent?: EnsureModerationDeleteIntentInput;
    duplicateNoticePolicySha256?: string;
  }) {
    const {
      chatId,
      userId,
      messageId,
      text,
      createdAt,
      hit,
      userLabel,
      botSpeechStyle,
      botSpeechMedia,
      duplicateBotMessageEnabled,
      duplicateBotMessageText,
      duplicateBotButtons,
      duplicateBotButtonEnabled,
      duplicateBotButtonUrl,
      duplicateBotButtonText,
      duplicateAdminContactButtonEnabled,
      duplicateAdminContactButtonUrl,
      rulesAttachViolationsEnabled,
      rulesPublishedUrl,
      rulesPublishedMessageId,
      deleteBotMessagesEnabled,
      deleteBotMessagesDelayMinutes,
      suppressNonEssentialMessages,
      hotPathProfile,
      actionClaimed = false,
      backgroundExecution = false,
      assertActiveLease,
      authorizeDelete,
    } = params;
    let messageDeleted = false;
    const deleteIntent: EnsureModerationDeleteIntentInput = params.deleteIntent ?? {
      chatId,
      messageId,
      reasonKey: 'DUPLICATE:hit-delete',
      ruleCode: 'DUPLICATE_DELETE',
      subjectUserId: userId,
      sourceMessageAt: createdAt,
      entityType: 'CHAT',
      messageAuthorKind: 'user',
      event: {
        userId,
        eventType: 'MESSAGE',
        maskedExcerpt: maskText(text),
        score: 0.8,
        metadata: {
          ...hit.metadata,
          windowSec: hit.windowSec,
          count: hit.count,
          fingerprintType: hit.fingerprintType,
          reason: this.resolveDuplicateRemovalReason(hit.fingerprintType),
        },
      },
    };
    assertActiveLease?.();
    await this.ensureModerationDeleteIntent(deleteIntent);
    assertActiveLease?.();

    if (!actionClaimed) {
      assertActiveLease?.();
      const claimed = await this.claimMessageScopedModerationAction({
        chatId,
        userId,
        messageId,
        ruleCode: DUPLICATE_MESSAGE_ACTION_CLAIM_RULE_CODE,
      });
      if (!claimed) {
        return;
      }
      assertActiveLease?.();
    }

    const deleteAuthorization = createDuplicateDeleteAuthorizationGuard({
      assertActiveLease,
      authorizeDelete,
    });
    assertActiveLease?.();
    try {
      this.markWebhookHotPathStage(hotPathProfile, 'duplicate-delete');
      const deleteResult = await this.executeModerationDelete(deleteIntent, {
        beforeImmediateDeleteMutation: deleteAuthorization.beforeImmediateDeleteMutation,
      });
      if (deleteResult.inlineDeclined || deleteAuthorization.wasRejected()) {
        return;
      }
      assertActiveLease?.();
      messageDeleted = deleteResult.gone;
      if (deleteResult.deleted && !deleteResult.eventPersistedByIntent) {
        assertActiveLease?.();
        await this.createBotModerationEvent({
          data: {
            chatId,
            userId,
            messageId,
            eventType: EventType.MESSAGE,
            ruleCode: 'DUPLICATE_DELETE',
            action: SanctionAction.DELETE_MESSAGE,
            maskedExcerpt: maskText(text),
            score: 0.8,
            operator: Operator.BOT,
            metadata: {
              ...hit.metadata,
              windowSec: hit.windowSec,
              count: hit.count,
              fingerprintType: hit.fingerprintType,
              reason: this.resolveDuplicateRemovalReason(hit.fingerprintType),
            },
          },
        });
        assertActiveLease?.();
      }
      if (messageDeleted) {
        this.markWebhookHotPathSuccessBoundary(hotPathProfile, 'duplicate-delete');
      }
    } catch (error: unknown) {
      if (deleteAuthorization.wasRejected()) {
        return;
      }
      if (deleteAuthorization.verificationFailed()) {
        throw error;
      }
      assertActiveLease?.();
      this.logger.warn(
        {
          chatId,
          userId,
          messageId,
          error: error instanceof Error ? error.message : 'Unknown error',
        },
        'Failed to delete duplicate message',
      );
    }

    assertActiveLease?.();
    this.markWebhookHotPathStage(hotPathProfile, 'duplicate-follow-up');
    const runDuplicateFollowUp = async () => {
      assertActiveLease?.();
      const duplicateMessageOptions = this.buildBotMessageOptions(
        chatId,
        duplicateBotButtons,
        duplicateBotButtonEnabled,
        duplicateBotButtonUrl,
        duplicateBotButtonText,
        rulesAttachViolationsEnabled,
        rulesPublishedUrl,
        rulesPublishedMessageId,
      );

      if (!suppressNonEssentialMessages && duplicateBotMessageEnabled) {
        try {
          assertActiveLease?.();
          const explanationText = await this.appendAdminContactMarkdownLink(
            chatId,
            this.buildDuplicateHitExplanation(
              userLabel,
              messageDeleted,
              duplicateBotMessageText,
              botSpeechStyle,
              hit.fingerprintType,
            ),
            duplicateAdminContactButtonEnabled,
            duplicateAdminContactButtonUrl,
          );
          assertActiveLease?.();
          await this.sendBotMessageWithOptionalAutoDelete({
            chatId,
            text: explanationText,
            messageOptions: withMarketplaceModerationMessage(
              duplicateMessageOptions,
              chatId,
              'MODERATION_NOTICE',
              'DUPLICATES',
            ),
            media: this.resolveBotSpeechMedia({ botSpeechMedia }, 'duplicateBotMessageText'),
            deleteBotMessagesEnabled,
            deleteBotMessagesDelayMinutes,
            idempotencyKey: duplicateExplanationIdempotencyKey(hit.metadata, chatId, messageId),
            beforeSend: assertActiveLease ? async () => assertActiveLease() : undefined,
            ledgerContext: await buildMessageDuplicateNoticeContext(
              this.prisma,
              deleteIntent,
              params.duplicateNoticePolicySha256,
              hit,
            ),
          });
          assertActiveLease?.();
        } catch (error: unknown) {
          assertActiveLease?.();
          this.logger.warn(
            {
              chatId,
              userId,
              messageId,
              error: error instanceof Error ? error.message : 'Unknown error',
            },
            'Failed to send duplicate explanation message',
          );
        }
      }
      assertActiveLease?.();
    };

    if (backgroundExecution) {
      assertActiveLease?.();
      await runDuplicateFollowUp();
      assertActiveLease?.();
    } else {
      await this.runWebhookFollowUpWithBudget({
        stage: 'duplicate-follow-up',
        hotPathProfile,
        chatId,
        userId,
        messageId,
        maxWaitMs: DUPLICATE_FOLLOW_UP_HOT_PATH_TIMEOUT_MS,
        minRemainingMs: DUPLICATE_FOLLOW_UP_DETACH_MIN_REMAINING_MS,
        task: runDuplicateFollowUp,
      });
    }
  }

  private resolveDuplicateRemovalReason(fingerprintType: DuplicateHit['fingerprintType']): string {
    if (fingerprintType === 'image') {
      return 'Duplicate photo removed';
    }
    if (fingerprintType === 'image_set') {
      return 'Duplicate photo album removed';
    }
    return 'Duplicate message removed';
  }

  private toSanctionAction(action: DuplicateAction): SanctionAction {
    if (action === 'WARN') {
      return SanctionAction.WARN;
    }
    if (action === 'MUTE') {
      return SanctionAction.MUTE;
    }
    return SanctionAction.BAN;
  }

  private async tryHandleKaravanStorefrontRelay(
    params: RelayContext & { update: MaxUpdate },
  ): Promise<boolean> {
    if (!params.messageId || !this.karavanStorefrontRelayService) {
      return false;
    }

    const { update, karavanStorefrontAdminsOnly, storefrontOwnerUserId, ...context } = params;
    const result = await this.karavanStorefrontRelayService.handleMessageCreated({
      ...context,
      raw: update.raw,
      botId: update.botId ?? null,
      ...(karavanStorefrontAdminsOnly ? { karavanStorefrontAdminsOnly: true } : {}),
      ...(storefrontOwnerUserId ? { storefrontOwnerUserId } : {}),
    });

    return result === 'handled' || result === 'duplicate';
  }

  private readKaravanStorefrontAdminsOnly(settings: unknown): boolean {
    if (!settings || typeof settings !== 'object') {
      return false;
    }
    return (
      (settings as { karavanStorefrontAdminsOnly?: unknown }).karavanStorefrontAdminsOnly === true
    );
  }

  private readKaravanStorefrontOwnerUserId(update: MaxUpdate, actorUserId: string): string | null {
    const raw = this.asRecord(update.raw);
    const message = this.findKaravanRawMessage(raw);
    const body = this.asRecord(message?.body);
    const directText =
      this.readString(body?.text) ??
      this.readString(body?.caption) ??
      this.readString(message?.text) ??
      this.readString(message?.caption);
    if (directText?.trim()) return null;
    const link = this.asRecord(message?.link);
    if (this.readString(link?.type)?.toLowerCase() !== 'forward') return null;
    const sender = this.asRecord(link?.sender);
    const forwardedUserId = this.readString(
      link?.sender_id ?? link?.senderId ?? sender?.user_id ?? sender?.userId ?? sender?.id,
    );
    return forwardedUserId && forwardedUserId !== actorUserId.trim() ? forwardedUserId : null;
  }

  private findKaravanRawMessage(
    raw: Record<string, unknown> | null,
  ): Record<string, unknown> | null {
    if (!raw) {
      return null;
    }
    const direct = this.asRecord(raw.message);
    if (direct) {
      return direct;
    }
    for (const key of ['message_created', 'data', 'event', raw.update_type, raw.type]) {
      if (typeof key !== 'string' || !key) {
        continue;
      }
      const envelope = this.asRecord(raw[key]);
      const nested = this.asRecord(envelope?.message);
      if (nested) {
        return nested;
      }
      const data = this.asRecord(envelope?.data);
      const nestedData = this.asRecord(data?.message);
      if (nestedData) {
        return nestedData;
      }
    }
    return null;
  }

  private buildLinkExplanation(
    userLabel: string,
    canDeleteMessage: boolean,
    templateText: string,
    botSpeechStyle: BotSpeechStyle | null,
    editedMessage = false,
  ): string {
    const hasTemplateOverride = hasCustomBotSpeechTemplate(templateText);
    const reason = resolveBotSpeechPlaceholder(
      templateText,
      editedMessage
        ? 'ссылка появилась после тихой правки; в этом чате ссылки не проходят'
        : 'в этом чате ссылки не проходят, без ссылок',
      editedMessage
        ? 'добавленная при редактировании ссылка запрещена настройками чата'
        : 'эта ссылка запрещена настройками чата',
    );
    const messageStatus = resolveBotSpeechMessageStatus(templateText, canDeleteMessage);
    if (editedMessage && !hasTemplateOverride) {
      return this.renderSystemBotSpeechTemplate({
        style: botSpeechStyle,
        templateKey: 'linkEdited',
        replacements: {
          user: userLabel,
          message_status: messageStatus,
          reason,
        },
      });
    }

    return this.renderEditableBotSpeechTemplate({
      style: botSpeechStyle,
      fieldKey: 'linkBotMessageText',
      overrideText: templateText,
      replacements: {
        user: userLabel,
        message_status: messageStatus,
        reason,
      },
    });
  }

  private buildRequiredSubscriptionExplanation(
    userLabel: string,
    canDeleteMessage: boolean | null,
    channelTitles: readonly string[],
    templateText: string,
    botSpeechStyle: BotSpeechStyle | null,
  ): string {
    const channelsLabel = this.formatRequiredSubscriptionChannels(channelTitles);

    return this.renderEditableBotSpeechTemplate({
      style: botSpeechStyle,
      fieldKey: 'requiredSubscriptionBotMessageText',
      overrideText: templateText,
      replacements: {
        user: userLabel,
        channels: channelsLabel,
        message_status:
          canDeleteMessage === null
            ? resolveBotSpeechPlaceholder(templateText, 'ждёт снятия с линии', 'ожидает удаления')
            : resolveBotSpeechMessageStatus(templateText, canDeleteMessage),
      },
    });
  }

  private buildRequiredSubscriptionWarnExplanation(
    userLabel: string,
    channelTitles: readonly string[],
    templateText: string,
    botSpeechStyle: BotSpeechStyle | null,
  ): string {
    const channelsLabel = this.formatRequiredSubscriptionChannels(channelTitles);
    const reason = resolveBotSpeechPlaceholder(
      templateText,
      'для сообщений нужна подписка на обязательные чаты или каналы',
      'обязательная подписка ещё не подтверждена',
    );
    const warning = resolveBotSpeechPlaceholder(
      templateText,
      'вынесено предупреждение за отсутствие обязательной подписки',
      'предупреждение за сообщение без обязательной подписки',
    );

    return this.renderEditableBotSpeechTemplate({
      style: botSpeechStyle,
      fieldKey: 'requiredSubscriptionWarnMessageText',
      overrideText: templateText,
      replacements: {
        user: userLabel,
        channels: channelsLabel,
        reason,
        warning,
      },
    });
  }

  private buildInvitationAccessExplanation(
    userLabel: string,
    canDeleteMessage: boolean,
    requiredCount: number,
    invitedCount: number,
    templateText: string,
    botSpeechStyle: BotSpeechStyle | null,
  ): string {
    return this.renderEditableBotSpeechTemplate({
      style: botSpeechStyle,
      fieldKey: 'invitationAccessBotMessageText',
      overrideText: templateText,
      replacements: {
        user: userLabel,
        message_status: resolveBotSpeechMessageStatus(templateText, canDeleteMessage),
        ...this.buildInvitationAccessTemplateReplacements(requiredCount, invitedCount),
      },
    });
  }

  private buildInvitationAccessWarnExplanation(
    userLabel: string,
    requiredCount: number,
    invitedCount: number,
    templateText: string,
    botSpeechStyle: BotSpeechStyle | null,
  ): string {
    const reason = resolveBotSpeechPlaceholder(
      templateText,
      'для сообщений нужно пригласить друзей в чат',
      'условие по приглашениям ещё не выполнено',
    );
    const warning = resolveBotSpeechPlaceholder(
      templateText,
      'вынесено предупреждение за доступ без приглашений',
      'предупреждение за сообщение до выполнения условия по приглашениям',
    );

    return this.renderEditableBotSpeechTemplate({
      style: botSpeechStyle,
      fieldKey: 'invitationAccessWarnMessageText',
      overrideText: templateText,
      replacements: {
        user: userLabel,
        reason,
        warning,
        ...this.buildInvitationAccessTemplateReplacements(requiredCount, invitedCount),
      },
    });
  }

  private buildLinkWarnExplanation(
    userLabel: string,
    templateText: string,
    botSpeechStyle: BotSpeechStyle | null,
    editedMessage = false,
  ): string {
    const hasTemplateOverride = hasCustomBotSpeechTemplate(templateText);
    const reason = resolveBotSpeechPlaceholder(
      templateText,
      editedMessage
        ? 'ссылка появилась после тихой правки; в этом чате ссылки всё ещё нельзя'
        : 'в этом чате ссылки не проходят, без ссылок',
      editedMessage
        ? 'добавленная при редактировании ссылка запрещена настройками чата'
        : 'эта ссылка запрещена настройками чата',
    );
    const warning = resolveBotSpeechPlaceholder(
      templateText,
      editedMessage
        ? 'вынесено предупреждение за ссылку после редактирования'
        : 'вынесено предупреждение за ссылку',
      editedMessage
        ? 'предупреждение за ссылку, добавленную при редактировании'
        : 'предупреждение за запрещённую ссылку',
    );
    if (editedMessage && !hasTemplateOverride) {
      return this.renderSystemBotSpeechTemplate({
        style: botSpeechStyle,
        templateKey: 'linkEditedWarn',
        replacements: {
          user: userLabel,
          reason,
          warning,
        },
      });
    }

    return this.renderEditableBotSpeechTemplate({
      style: botSpeechStyle,
      fieldKey: 'linkWarnMessageText',
      overrideText: templateText,
      replacements: {
        user: userLabel,
        reason,
        warning,
      },
    });
  }

  private formatRequiredSubscriptionChannels(channelTitles: readonly string[]): string {
    const normalizedTitles = channelTitles
      .map((item) => item.replace(/\s+/g, ' ').trim())
      .filter((item) => item.length > 0)
      .map((item) => this.escapeMaxMarkdownText(item));

    if (normalizedTitles.length === 0) {
      return 'обязательные чаты или каналы';
    }

    return normalizedTitles.join(', ');
  }

  private buildInvitationAccessTemplateReplacements(
    requiredCount: number,
    invitedCount: number,
  ): Record<string, string> {
    const normalizedRequiredCount = this.normalizeInvitationAccessRequiredCount(requiredCount);
    const normalizedInvitedCount = Math.max(0, Math.trunc(invitedCount));
    const visibleInvitedCount = Math.min(normalizedRequiredCount, normalizedInvitedCount);
    const remainingCount = Math.max(0, normalizedRequiredCount - normalizedInvitedCount);

    return {
      required_invites: this.formatInvitationAccessInviteCount(normalizedRequiredCount),
      required_invites_count: String(normalizedRequiredCount),
      invited_count: String(visibleInvitedCount),
      remaining_invites: this.formatInvitationAccessInviteCount(remainingCount),
    };
  }

  private formatInvitationAccessInviteCount(count: number): string {
    const normalizedCount = Math.max(0, Math.trunc(count));
    if (normalizedCount === 1) {
      return '1 друга';
    }

    return `${normalizedCount} друзей`;
  }

  private buildInvitationAccessMuteExplanation(
    userLabel: string,
    requiredCount: number,
    invitedCount: number,
    botSpeechStyle: BotSpeechStyle | null,
  ): string {
    return this.renderSystemBotSpeechTemplate({
      style: botSpeechStyle,
      templateKey: 'invitationAccessMute',
      replacements: {
        user: userLabel,
        ...this.buildInvitationAccessTemplateReplacements(requiredCount, invitedCount),
      },
    });
  }

  private buildInvitationAccessBanExplanation(
    userLabel: string,
    requiredCount: number,
    invitedCount: number,
    _muteDurationHours: number,
    botSpeechStyle: BotSpeechStyle | null,
  ): string {
    return this.renderSystemBotSpeechTemplate({
      style: botSpeechStyle,
      templateKey: 'invitationAccessBan',
      replacements: {
        user: userLabel,
        ...this.buildInvitationAccessTemplateReplacements(requiredCount, invitedCount),
      },
    });
  }

  private buildRequiredSubscriptionMuteExplanation(
    userLabel: string,
    channelTitles: readonly string[],
    botSpeechStyle: BotSpeechStyle | null,
    muteDurationHours: number,
  ): string {
    return this.renderSystemBotSpeechTemplate({
      style: botSpeechStyle,
      templateKey: 'requiredSubscriptionMute',
      replacements: {
        user: userLabel,
        channels: this.formatRequiredSubscriptionChannels(channelTitles),
        mute_duration: this.formatMuteDurationLabel(muteDurationHours),
      },
    });
  }

  private buildRequiredSubscriptionBanExplanation(
    userLabel: string,
    channelTitles: readonly string[],
    _muteDurationHours: number,
    botSpeechStyle: BotSpeechStyle | null,
  ): string {
    return this.renderSystemBotSpeechTemplate({
      style: botSpeechStyle,
      templateKey: 'requiredSubscriptionBan',
      replacements: {
        user: userLabel,
        channels: this.formatRequiredSubscriptionChannels(channelTitles),
      },
    });
  }

  private buildLinkMuteExplanation(
    userLabel: string,
    botSpeechStyle: BotSpeechStyle | null,
  ): string {
    return this.renderSystemBotSpeechTemplate({
      style: botSpeechStyle,
      templateKey: 'linkMute',
      replacements: {
        user: userLabel,
      },
    });
  }

  private buildTextFilterWarnExplanation(
    userLabel: string,
    ruleCode: string,
    templateText: string,
    botSpeechStyle: BotSpeechStyle | null,
  ): string {
    const hasTemplateOverride = hasCustomBotSpeechTemplate(templateText);
    const legacyReason =
      ruleCode === 'COMMERCIAL_AD'
        ? 'коммерческую рекламу'
        : ruleCode === 'PROFANITY'
          ? 'грубую лексику'
          : 'нарушение текстовых правил';
    const reason = hasTemplateOverride
      ? legacyReason
      : ruleCode === 'COMMERCIAL_AD'
        ? 'коммерческая реклама запрещена правилами чата'
        : ruleCode === 'PROFANITY'
          ? 'грубая лексика запрещена правилами чата'
          : 'текст нарушает правила чата';
    const warning = hasTemplateOverride
      ? `вынесено предупреждение за ${legacyReason}`
      : ruleCode === 'COMMERCIAL_AD'
        ? 'предупреждение за коммерческую рекламу'
        : ruleCode === 'PROFANITY'
          ? 'предупреждение за грубую лексику'
          : 'предупреждение за нарушение текстовых правил';

    return this.renderEditableBotSpeechTemplate({
      style: botSpeechStyle,
      fieldKey:
        ruleCode === 'PROFANITY' ? 'profanityWarnMessageText' : 'textFiltersWarnMessageText',
      overrideText: templateText,
      replacements: {
        user: userLabel,
        reason,
        warning,
      },
    });
  }

  private buildTextFilterMuteExplanation(
    userLabel: string,
    ruleCode: string,
    botSpeechStyle: BotSpeechStyle | null,
  ): string {
    const templateKey =
      ruleCode === 'COMMERCIAL_AD'
        ? 'textFiltersMuteCommercial'
        : ruleCode === 'PROFANITY'
          ? 'textFiltersMuteProfanity'
          : 'textFiltersMuteGeneric';

    return this.renderSystemBotSpeechTemplate({
      style: botSpeechStyle,
      templateKey,
      replacements: {
        user: userLabel,
      },
    });
  }

  private buildDuplicateExplanation(
    userLabel: string,
    decision: DuplicateDecision,
    muteDurationHours: number,
    messageDeleted: boolean,
    templateText: string,
    botSpeechStyle: BotSpeechStyle | null,
    fingerprintType: DuplicateHit['fingerprintType'] = 'exact',
  ): string {
    const hasTemplateOverride = hasCustomBotSpeechTemplate(templateText);
    const banDurationLabel = this.formatMuteDurationLabel(muteDurationHours);
    const baseContext = resolveBotSpeechDuplicateContext(templateText, messageDeleted);
    const sanction = hasTemplateOverride
      ? buildLegacyDuplicateSanctionLabel({
          style: botSpeechStyle,
          persona: this.resolveActiveBotSpeechProfile().persona,
          action: decision.action,
          muteDurationLabel: banDurationLabel,
        })
      : this.buildDuplicateSanctionLabel(botSpeechStyle, decision.action, banDurationLabel);
    if (!hasTemplateOverride && this.isPhotoDuplicateFingerprintType(fingerprintType)) {
      return this.renderSystemBotSpeechTemplate({
        style: botSpeechStyle,
        templateKey: fingerprintType === 'image_set' ? 'duplicateAlbum' : 'duplicatePhoto',
        replacements: { user: userLabel, sanction },
      });
    }

    return this.renderEditableBotSpeechTemplate({
      style: botSpeechStyle,
      fieldKey: 'duplicateBotMessageText',
      overrideText: templateText,
      replacements: {
        user: userLabel,
        message_status: resolveBotSpeechMessageStatus(templateText, messageDeleted),
        reason: this.resolveDuplicateExplanationReason(fingerprintType, hasTemplateOverride),
        duplicate_context: baseContext,
        sanction,
        mute_duration: banDurationLabel,
        ban_duration: banDurationLabel,
      },
    });
  }

  private buildDuplicateHitExplanation(
    userLabel: string,
    messageDeleted: boolean,
    templateText: string,
    botSpeechStyle: BotSpeechStyle | null,
    fingerprintType: DuplicateHit['fingerprintType'] = 'exact',
  ): string {
    const hasTemplateOverride = hasCustomBotSpeechTemplate(templateText);
    const duplicateContext = resolveBotSpeechDuplicateContext(templateText, messageDeleted);
    const messageStatus = resolveBotSpeechMessageStatus(templateText, messageDeleted);
    const sanction = hasTemplateOverride
      ? buildLegacyDuplicatePassiveSanctionLabel({
          style: botSpeechStyle,
          persona: this.resolveActiveBotSpeechProfile().persona,
          messageDeleted,
        })
      : this.buildDuplicatePassiveSanctionLabel(botSpeechStyle, messageDeleted);
    if (!hasTemplateOverride && this.isPhotoDuplicateFingerprintType(fingerprintType)) {
      return this.renderSystemBotSpeechTemplate({
        style: botSpeechStyle,
        templateKey: fingerprintType === 'image_set' ? 'duplicateAlbum' : 'duplicatePhoto',
        replacements: { user: userLabel, sanction },
      });
    }

    return this.renderEditableBotSpeechTemplate({
      style: botSpeechStyle,
      fieldKey: 'duplicateBotMessageText',
      overrideText: templateText,
      replacements: {
        user: userLabel,
        message_status: messageStatus,
        reason: this.resolveDuplicateExplanationReason(fingerprintType, hasTemplateOverride),
        duplicate_context: duplicateContext,
        sanction,
      },
    });
  }

  private isPhotoDuplicateFingerprintType(
    fingerprintType: DuplicateHit['fingerprintType'],
  ): fingerprintType is 'image' | 'image_set' {
    return fingerprintType === 'image' || fingerprintType === 'image_set';
  }

  private resolveDuplicateExplanationReason(
    fingerprintType: DuplicateHit['fingerprintType'],
    legacyWording: boolean,
  ): string {
    if (fingerprintType === 'image') {
      return legacyWording
        ? 'в этом чате повторы фото не проходят'
        : 'повторные фото ограничены настройками чата';
    }
    if (fingerprintType === 'image_set') {
      return legacyWording
        ? 'в этом чате повторы альбомов не проходят'
        : 'повторные альбомы ограничены настройками чата';
    }
    return legacyWording
      ? 'в этом чате серийные повторы не проходят'
      : 'повторные сообщения ограничены настройками чата';
  }

  private resolveEditableBotSpeechText(
    style: BotSpeechStyle | null,
    fieldKey: BotSpeechEditableFieldKey,
    overrideText: string,
  ): string {
    // FLAG: Empty means inherited. Every non-empty value is user-owned, even if it matches an old default.
    return typeof overrideText === 'string' && overrideText.length > 0
      ? overrideText
      : getBotSpeechEditableTemplate(style, fieldKey, this.resolveActiveBotSpeechProfile().persona);
  }

  private renderEditableBotSpeechTemplate(params: {
    style: BotSpeechStyle | null;
    fieldKey: BotSpeechEditableFieldKey;
    overrideText: string;
    replacements: Record<string, string>;
  }): string {
    const activeBotSpeechProfile = this.resolveActiveBotSpeechProfile();
    const fallback = getBotSpeechEditableTemplate(
      params.style,
      params.fieldKey,
      activeBotSpeechProfile.persona,
    );

    return this.renderBotMessageTemplate(
      this.resolveEditableBotSpeechText(params.style, params.fieldKey, params.overrideText),
      fallback,
      {
        ...this.buildBotSpeechTemplateReplacements(activeBotSpeechProfile),
        ...params.replacements,
      },
    );
  }

  private renderSystemBotSpeechTemplate(params: {
    style: BotSpeechStyle | null;
    templateKey: BotSpeechSystemTemplateKey;
    replacements: Record<string, string>;
  }): string {
    const activeBotSpeechProfile = this.resolveActiveBotSpeechProfile();
    const template = getBotSpeechSystemTemplate(
      params.style,
      params.templateKey,
      activeBotSpeechProfile.persona,
    );

    return this.renderBotMessageTemplate(template, template, {
      ...this.buildBotSpeechTemplateReplacements(activeBotSpeechProfile),
      ...params.replacements,
    });
  }

  private buildBotSpeechTemplateReplacements(
    activeBotSpeechProfile: ActiveBotSpeechProfile,
  ): Record<string, string> {
    return {
      bot_character_name: activeBotSpeechProfile.characterName,
    };
  }

  private renderBotMessageTemplate(
    templateText: string,
    fallbackText: string,
    replacements: Record<string, string>,
  ): string {
    if (typeof templateText !== 'string' || templateText.length === 0) {
      return fallbackText;
    }

    let rendered = templateText;
    for (const [key, value] of Object.entries(replacements)) {
      rendered = rendered.split(`{${key}}`).join(value);
    }

    return rendered;
  }

  private buildMessageStatusLabel(canDeleteMessage: boolean): string {
    return canDeleteMessage ? 'удалено' : 'не удалено';
  }

  private buildDuplicateContextLabel(canDeleteMessage: boolean): string {
    return canDeleteMessage ? 'удалено как повтор' : 'отмечено как повтор';
  }

  private buildDuplicateSanctionLabel(
    style: BotSpeechStyle | null,
    action: SanctionAction,
    muteDurationLabel: string,
  ): string {
    const templateKey =
      action === SanctionAction.WARN
        ? 'duplicateWarn'
        : action === SanctionAction.MUTE
          ? 'duplicateMute'
          : 'duplicateBan';

    return this.renderSystemBotSpeechTemplate({
      style,
      templateKey,
      replacements: {
        mute_duration: muteDurationLabel,
        ban_duration: muteDurationLabel,
      },
    });
  }

  private buildDuplicatePassiveSanctionLabel(
    style: BotSpeechStyle | null,
    messageDeleted: boolean,
  ): string {
    return this.renderSystemBotSpeechTemplate({
      style,
      templateKey: messageDeleted ? 'duplicatePassiveDeleted' : 'duplicatePassiveKept',
      replacements: {},
    });
  }

  private escapeMaxMarkdownText(value: string): string {
    return value.replace(/\\/g, '\\\\').replace(/([*_`[\]()~+])/g, '\\$1');
  }

  private async appendAdminContactMarkdownLink(
    chatId: string,
    text: string,
    enabled: boolean,
    url: string | null | undefined,
  ): Promise<string> {
    const fallbackDisplayName = enabled
      ? await this.resolveAdminContactFallbackDisplayName(chatId, url)
      : null;
    return appendAdminContactMarkdownLinkText(text, {
      enabled,
      url,
      botTokens: this.getAdminContactValidationTokens(),
      fallbackDisplayName,
    });
  }

  private async resolveAdminContactFallbackDisplayName(
    chatId: string,
    url: string | null | undefined,
  ): Promise<string | null> {
    const target = resolveAdminContactMentionTarget(url, this.getAdminContactValidationTokens());
    if (!target?.userId || target.displayName) {
      return null;
    }

    return this.moderationDisplayNameResolver.resolve(chatId, target.userId);
  }

  private getAdminContactValidationTokens(): readonly string[] {
    const tokens = this.maxBotLinkService?.getValidationTokens?.() ?? [this.getCurrentBotToken()];
    return tokens
      .map((token) => (typeof token === 'string' ? token.trim() : ''))
      .filter((token) => token.length > 0);
  }

  private formatUserLabel(senderName?: string, userId?: string): string {
    const normalized = normalizeMaxUserDisplayName(senderName, userId);
    const safe = normalized ? this.escapeMaxMarkdownText(normalized) : 'Пользователь';
    if (typeof userId === 'string' && userId.trim().length > 0) {
      return `[${safe}](max://user/${encodeURIComponent(userId)})`;
    }
    return `**${safe}**`;
  }

  private async resolveSanctionUserLabel(
    chatId: string,
    userId: string,
    currentLabel: string,
  ): Promise<string> {
    if (currentLabel !== this.formatUserLabel(undefined, userId)) {
      return currentLabel;
    }

    const displayName = await this.moderationDisplayNameResolver.resolve(chatId, userId);
    return this.formatUserLabel(displayName ?? undefined, userId);
  }

  private async applySanctionAction(params: ApplySanctionActionParams): Promise<boolean> {
    await this.assertLegacyModerationAllowed(params.chatId, params.userId, params.messageId);
    await params.assertActiveLease?.();
    if (
      params.action !== SanctionAction.BAN &&
      params.action !== SanctionAction.MUTE &&
      !(params.action === SanctionAction.WARN && params.authorizeSanction)
    ) {
      return this.applySanctionActionUnderLock(
        params,
        this.combineModerationLeaseGuards(undefined, params.assertActiveLease),
      );
    }

    let resolvedOutcome: boolean | undefined;
    try {
      return await this.moderationSanctionStateLockService.runExclusive(
        { chatId: params.chatId, userId: params.userId },
        async (leaseGuard) => {
          const activeLeaseGuard = this.combineModerationLeaseGuards(
            leaseGuard,
            params.assertActiveLease,
          );
          await activeLeaseGuard?.assertOwned();
          await this.assertLegacyModerationAllowed(params.chatId, params.userId, params.messageId);
          if (params.authorizeSanction) {
            if (!(await params.authorizeSanction())) {
              resolvedOutcome = false;
              return false;
            }
            await activeLeaseGuard?.assertOwned();
          }
          let outcome: boolean;
          if (this.isKnownRuntimeBotUserId(params.userId)) {
            outcome = await this.applySanctionActionUnderLock(params, activeLeaseGuard);
          } else if (params.action === SanctionAction.WARN) {
            await params.beforeSanctionMutation?.();
            await persistModerationDecisionWithoutAppliedSanction(
              params.persistModerationEvent,
              params.action,
            );
            await activeLeaseGuard?.assertOwned();
            outcome = true;
          } else {
            await activeLeaseGuard?.assertOwned();
            const fence = await this.moderationSanctionStateFenceService.prepare({
              chatId: params.chatId,
              userId: params.userId,
              intendedAction: params.action === SanctionAction.BAN ? 'BAN' : 'MUTE',
              operator: Operator.BOT,
              source: 'automatic_moderation',
            });
            outcome = await this.applySanctionActionUnderLock(params, activeLeaseGuard, fence);
          }
          resolvedOutcome = outcome;
          return outcome;
        },
      );
    } catch (error: unknown) {
      if (
        error instanceof ModerationSanctionStateLockLeaseLostError &&
        resolvedOutcome !== undefined
      ) {
        return resolvedOutcome;
      }
      throw error;
    }
  }

  private combineModerationLeaseGuards(
    leaseGuard: ModerationSanctionStateLeaseGuard | undefined,
    assertActiveLease: (() => void | Promise<void>) | undefined,
  ): ModerationSanctionStateLeaseGuard | undefined {
    if (!assertActiveLease) {
      return leaseGuard;
    }
    return {
      assertOwned: async () => {
        await assertActiveLease();
        await leaseGuard?.assertOwned();
        await assertActiveLease();
      },
    };
  }

  private async applySanctionActionUnderLock(
    params: ApplySanctionActionParams,
    leaseGuard?: ModerationSanctionStateLeaseGuard,
    fence?: ModerationSanctionStateFence,
  ): Promise<boolean> {
    const {
      chatId,
      userId,
      action,
      userLabel,
      messageId,
      muteDurationHours,
      deleteBotMessagesEnabled,
      deleteBotMessagesDelayMinutes,
      botMessageOptions,
      sanctionNoticeText,
      bypassNoticeBucket,
      noticeIdempotencyKey,
      rethrowNoticeFailure,
      activeMuteRuleCode,
      routeNoticeDynamically,
      deferNotice,
      onSanctionEventPersisted,
      noticeBeforeSend,
      noticeLedgerContext,
      botSpeechStyle,
      trackAsGlobalSpammer = true,
      deferGlobalSpammerTrackingUntilConfirmedBan = false,
      persistModerationEvent,
    } = params;
    if (this.isKnownRuntimeBotUserId(userId)) {
      this.logger.warn(
        {
          chatId,
          userId,
          messageId,
          action,
        },
        'Skipped sanction for configured MAX bot user',
      );
      return false;
    }

    await this.assertLegacyModerationAllowed(chatId, userId, messageId);

    if (action === SanctionAction.MUTE) {
      const effectiveMuteDurationHours = this.readMuteDurationHoursFromMetadata(
        null,
        muteDurationHours,
      );
      const issuedAt = new Date();
      const expiresAt = new Date(issuedAt.getTime() + effectiveMuteDurationHours * 60 * 60 * 1000);
      let eventPersistence: { eventId: string | null; persisted: boolean } = {
        eventId: null,
        persisted: false,
      };
      let fenceSettled = false;
      try {
        await leaseGuard?.assertOwned();
        await params.beforeSanctionMutation?.();
        eventPersistence = await persistSanctionEventForNotice({
          persistModerationEvent,
          metadata: {
            muteDurationHours: effectiveMuteDurationHours,
            muteExpiresAt: expiresAt.toISOString(),
            mutePermanent: false,
            sanctionApplied: true,
          },
          actionLabel: 'mute',
          chatId,
          userId,
          messageId,
          logger: this.logger,
        });
        // FLAG: A runtime-only mute would lose its cleanup obligation after a crash.
        if (!eventPersistence.persisted || !eventPersistence.eventId)
          throw new Error('Automatic mute requires a durable sanction event');
        onSanctionEventPersisted?.(eventPersistence.eventId);
        await leaseGuard?.assertOwned();
        await this.rememberActiveMuteState(chatId, userId, {
          eventId: eventPersistence.eventId,
          issuedAt,
          expiresAt,
          durationHours: effectiveMuteDurationHours,
          permanent: false,
          ruleCode: activeMuteRuleCode ?? null,
        });
        await leaseGuard?.assertOwned();
        await this.settleAutomaticSanctionStateFence(fence, 'COMMITTED', eventPersistence.eventId);
        fenceSettled = true;
        if (deferNotice) {
          return true;
        }
        await leaseGuard?.assertOwned();
        await this.sendMuteNotice({
          chatId,
          userId,
          messageId,
          userLabel,
          muteDurationHours: effectiveMuteDurationHours,
          deleteBotMessagesEnabled,
          deleteBotMessagesDelayMinutes,
          botMessageOptions,
          sanctionNoticeText,
          bypassNoticeBucket,
          idempotencyKey: noticeIdempotencyKey,
          rethrowOnFailure: rethrowNoticeFailure,
          botSpeechStyle,
          sanctionEventId: eventPersistence.eventId,
          ledgerContext: noticeLedgerContext,
          noticeDispatchOptions: params.noticeDispatchOptions,
          beforeSend:
            leaseGuard || noticeBeforeSend
              ? async () => {
                  await leaseGuard?.assertOwned();
                  await noticeBeforeSend?.();
                }
              : undefined,
        });
        return true;
      } catch (error: unknown) {
        if (!fenceSettled) {
          await this.settleAutomaticSanctionStateFence(
            fence,
            eventPersistence.persisted ? 'COMMITTED' : 'ABORTED',
            eventPersistence.eventId,
          );
        }
        throw error;
      }
    }

    if (action !== SanctionAction.BAN) {
      return false;
    }

    let remoteActionConfirmed = false;
    let remoteActionAmbiguous = false;
    let fenceSettled = false;
    let eventPersistence: { eventId: string | null; persisted: boolean } = {
      eventId: null,
      persisted: false,
    };
    let banResult: ModerationActionExecutionResult = { ok: false, botId: null };
    try {
      const trackBanReputation = async () => {
        await leaseGuard?.assertOwned();
        await this.upsertGlobalSpammerEntry({
          userId,
          sourceChatId: chatId,
          reason: 'SANCTION_BAN',
          evidence: {
            action: 'BAN',
            source: 'sanction',
          },
        });
      };
      if (trackAsGlobalSpammer && !deferGlobalSpammerTrackingUntilConfirmedBan)
        await trackBanReputation();

      try {
        banResult = await this.banMemberImmediatelyWithResult(
          chatId,
          userId,
          params.beforeSanctionMutation
            ? { beforeImmediateMemberMutation: params.beforeSanctionMutation }
            : undefined,
          leaseGuard,
        );
      } catch (error: unknown) {
        if (error instanceof ModerationSanctionStateLockError) {
          throw error;
        }
        this.logger.warn(
          {
            chatId,
            userId,
            messageId,
            error: error instanceof Error ? error.message : 'Unknown error',
          },
          'Failed to ban member',
        );
        remoteActionAmbiguous = duplicateSafety.resolveBanFailureAmbiguity(
          error,
          this.isTerminalModerationActionPermissionError(error),
          params.rethrowPreDispatchFailure,
        );
      }

      if (!banResult.ok) {
        if (!remoteActionAmbiguous) {
          await leaseGuard?.assertOwned();
          await this.settleAutomaticSanctionStateFence(fence, 'ABORTED');
          fenceSettled = true;
        }
        return false;
      }
      remoteActionConfirmed = true;
      // FLAG: A rejected commercial BAN never creates reputation; only a guarded,
      // confirmed remote mutation may contribute its sanction evidence.
      if (trackAsGlobalSpammer && deferGlobalSpammerTrackingUntilConfirmedBan)
        await trackBanReputation();

      await leaseGuard?.assertOwned();
      await this.rememberInactiveActiveMuteState(chatId, userId);

      await leaseGuard?.assertOwned();
      eventPersistence = await persistSanctionEventForNotice({
        persistModerationEvent,
        metadata: { sanctionApplied: true },
        actionLabel: 'ban',
        chatId,
        userId,
        messageId,
        logger: this.logger,
      });
      onSanctionEventPersisted?.(eventPersistence.eventId);
      await leaseGuard?.assertOwned();
      await this.settleAutomaticSanctionStateFence(
        fence,
        eventPersistence.persisted ? 'COMMITTED' : 'REMOTE_CONFIRMED_EVENT_MISSING',
        eventPersistence.eventId,
      );
      fenceSettled = true;
      if (deferNotice) {
        return true;
      }
      await leaseGuard?.assertOwned();
      await this.sendBanNoticeMessage({
        chatId,
        userId,
        messageId,
        userLabel,
        deleteBotMessagesEnabled,
        deleteBotMessagesDelayMinutes,
        botMessageOptions,
        sanctionNoticeText,
        bypassNoticeBucket,
        idempotencyKey: noticeIdempotencyKey,
        rethrowOnFailure: rethrowNoticeFailure,
        botSpeechStyle,
        botId: routeNoticeDynamically ? undefined : (banResult.botId ?? undefined),
        sanctionEventId: eventPersistence.eventId,
        ledgerContext: noticeLedgerContext,
        noticeDispatchOptions: params.noticeDispatchOptions,
        beforeSend:
          leaseGuard || noticeBeforeSend
            ? async () => {
                await leaseGuard?.assertOwned();
                await noticeBeforeSend?.();
              }
            : undefined,
      });
      return true;
    } catch (error: unknown) {
      if (!fenceSettled) {
        await this.settleAutomaticSanctionStateFence(
          fence,
          remoteActionConfirmed
            ? eventPersistence.persisted
              ? 'COMMITTED'
              : 'REMOTE_CONFIRMED_EVENT_MISSING'
            : 'ABORTED',
          eventPersistence.eventId,
        );
      }
      throw error;
    }
  }

  private async settleAutomaticSanctionStateFence(
    fence: ModerationSanctionStateFence | undefined,
    outcome: AutomaticSanctionStateFenceOutcome,
    eventId: string | null = null,
  ): Promise<void> {
    if (!fence) {
      return;
    }

    try {
      if (outcome === 'COMMITTED') {
        await this.moderationSanctionStateFenceService.commit(fence, eventId ?? undefined);
      } else if (outcome === 'REMOTE_CONFIRMED_EVENT_MISSING') {
        await this.moderationSanctionStateFenceService.markRemoteConfirmedEventMissing(fence);
      } else {
        await this.moderationSanctionStateFenceService.abort(fence);
      }
    } catch (error: unknown) {
      this.logger.warn(
        {
          chatId: fence.chatId,
          userId: fence.userId,
          transitionId: fence.transitionId,
          error: error instanceof Error ? error.message : 'Unknown error',
        },
        'Failed to append automatic moderation sanction fence outcome',
      );
    }
  }

  private async executeModerationDelete(
    input: EnsureModerationDeleteIntentInput,
    options?: ModerationDeleteExecutionOptions,
  ): Promise<ModerationDeleteExecutionResult> {
    return executeGuardedModerationDelete({
      input: this.prepareModerationDeleteIntentInput(input, options),
      service: this.moderationDeleteIntentService,
      options,
      logger: this.logger,
      profanityGuard: this.profanityDeleteGuard,
      commercialGuard: this.commercialDeleteGuard,
      legacyExecute: (hooks, legacyOptions) =>
        this.deleteMessageImmediatelyLegacy(input.chatId, input.messageId, legacyOptions, hooks),
    });
  }

  private async ensureModerationDeleteIntent(
    input: EnsureModerationDeleteIntentInput,
    options?: Omit<MaxActionDispatchOptions, 'immediate'>,
    enqueue = true,
  ): Promise<void> {
    if (!this.moderationDeleteIntentService) {
      return;
    }
    try {
      const prepared = this.prepareModerationDeleteIntentInput(input, options);
      if (enqueue) await this.moderationDeleteIntentService.ensureIntent(prepared);
      else await this.moderationDeleteIntentService.ensureIntent(prepared, { enqueue: false });
    } catch (error: unknown) {
      if (this.moderationDeleteIntentService.getRolloutForInput(input) === 'execute') {
        throw error;
      }
      this.logger.warn(
        {
          chatId: input.chatId,
          messageId: input.messageId,
          ruleCode: input.ruleCode ?? input.reasonKey,
          error: error instanceof Error ? error.message : 'Unknown error',
        },
        'Failed to persist shadow moderation delete intent before semantic claim',
      );
    }
  }

  private prepareModerationDeleteIntentInput(
    input: EnsureModerationDeleteIntentInput,
    options?: Pick<MaxActionDispatchOptions, 'delayMs'>,
  ): EnsureModerationDeleteIntentInput {
    const activeBotId = this.maxBotContextService?.getActiveBotId() ?? null;
    return prepareModerationDeleteIntentInput(input, activeBotId, options);
  }

  private async deleteMessageImmediatelyLegacy(
    chatId: string,
    messageId: string,
    options?: Omit<MaxActionDispatchOptions, 'immediate'>,
    profanityHooks?: ProfanityDeleteMutationHooks,
  ): Promise<ModerationActionExecutionResult> {
    await this.assertLegacyModerationAllowed(chatId, undefined, messageId);
    return this.executeModerationActionWithFallbackResult({
      chatId,
      action: 'delete_message',
      messageId,
      explicitBotId: options?.botId,
      operation: async (botId) => {
        profanityHooks?.beforeAttempt();
        await this.maxClient.deleteMessage(chatId, messageId, {
          trafficClass: 'critical',
          actionHealthLane: 'critical',
          sourceTag: MAX_API_SOURCE_TAGS.MODERATION_DELETE,
          timeoutMs: MODERATION_ACTION_DISPATCH_TIMEOUT_MS,
          ...(options ?? {}),
          ...(profanityHooks
            ? {
                beforeImmediateDeleteMutation: withMaxFinalAuthorityCheckpoint(
                  async (beforeFinalAuthority) => {
                    await options?.beforeImmediateDeleteMutation?.();
                    await profanityHooks.beforeDeleteMutation(botId, beforeFinalAuthority);
                  },
                ),
              }
            : {}),
          ignoreFailureMetricStatuses: MODERATION_CHAT_ACTION_TERMINAL_FAILURE_METRIC_STATUSES,
          ...(botId ? { botId } : {}),
          ...(options?.delayMs ? {} : { immediate: true }),
        });
      },
    });
  }

  private async kickMemberImmediately(
    chatId: string,
    userId: string,
    options?: Omit<MaxActionDispatchOptions, 'immediate'>,
  ): Promise<boolean> {
    if (this.isKnownRuntimeBotUserId(userId)) {
      this.logger.warn(
        {
          chatId,
          userId,
        },
        'Skipped kick for configured MAX bot user',
      );
      return false;
    }

    return this.executeModerationActionWithFallback({
      chatId,
      action: 'moderate_member',
      userId,
      explicitBotId: options?.botId,
      operation: async (botId) => {
        await this.maxClient.kickMember(chatId, userId, {
          trafficClass: 'critical',
          actionHealthLane: 'critical',
          sourceTag: MAX_API_SOURCE_TAGS.MODERATION_SANCTION,
          timeoutMs: MODERATION_ACTION_DISPATCH_TIMEOUT_MS,
          ...(options ?? {}),
          ...(botId ? { botId } : {}),
          immediate: true,
        });
      },
    });
  }

  private async banMemberImmediately(
    chatId: string,
    userId: string,
    options?: Omit<MaxActionDispatchOptions, 'immediate'>,
  ): Promise<boolean> {
    return (await this.banMemberImmediatelyWithResult(chatId, userId, options)).ok;
  }

  private async banMemberImmediatelyWithResult(
    chatId: string,
    userId: string,
    options?: Omit<MaxActionDispatchOptions, 'immediate'>,
    leaseGuard?: ModerationSanctionStateLeaseGuard,
  ): Promise<ModerationActionExecutionResult> {
    if (this.isKnownRuntimeBotUserId(userId)) {
      this.logger.warn(
        {
          chatId,
          userId,
        },
        'Skipped ban for configured MAX bot user',
      );
      return { ok: false, botId: null };
    }

    return this.executeModerationActionWithFallbackResult({
      chatId,
      action: 'moderate_member',
      userId,
      explicitBotId: options?.botId,
      operation: async (botId) => {
        await leaseGuard?.assertOwned();
        await this.maxClient.banMember(chatId, userId, {
          trafficClass: 'critical',
          actionHealthLane: 'critical',
          sourceTag: MAX_API_SOURCE_TAGS.MODERATION_SANCTION,
          timeoutMs: MODERATION_ACTION_DISPATCH_TIMEOUT_MS,
          ...(options ?? {}),
          ...(botId ? { botId } : {}),
          immediate: true,
          ...(leaseGuard || options?.beforeImmediateMemberMutation
            ? {
                beforeImmediateMemberMutation: createDuplicateMemberMutationGuard(
                  leaseGuard,
                  options?.beforeImmediateMemberMutation,
                ),
              }
            : {}),
        });
      },
    });
  }

  private async sendMuteNotice(params: SanctionNoticeParams & { muteDurationHours: number }) {
    return deliverSanctionNotice({
      notice: params,
      action: 'UNMUTE',
      text:
        params.sanctionNoticeText ??
        this.buildMuteNotice(params.userLabel, params.muteDurationHours, params.botSpeechStyle),
      send: (input) => this.sendBotMessageWithOptionalAutoDelete(input),
      logger: this.logger,
    });
  }

  private async sendBanNoticeMessage(params: SanctionNoticeParams) {
    return deliverSanctionNotice({
      notice: params,
      action: 'UNBAN',
      text:
        params.sanctionNoticeText ??
        this.buildPermanentBanNotice(params.userLabel, params.botSpeechStyle),
      send: (input) => this.sendBotMessageWithOptionalAutoDelete(input),
      logger: this.logger,
    });
  }

  private buildMuteNotice(
    userLabel: string,
    muteDurationHours: number,
    botSpeechStyle: BotSpeechStyle | null,
  ): string {
    return this.renderSystemBotSpeechTemplate({
      style: botSpeechStyle,
      templateKey: 'muteNotice',
      replacements: {
        user: userLabel,
        mute_duration: this.formatMuteDurationLabel(muteDurationHours),
        ban_duration: this.formatMuteDurationLabel(muteDurationHours),
      },
    });
  }

  private buildPermanentBanNotice(
    userLabel: string,
    botSpeechStyle: BotSpeechStyle | null,
  ): string {
    return this.renderSystemBotSpeechTemplate({
      style: botSpeechStyle,
      templateKey: 'permanentBanNotice',
      replacements: {
        user: userLabel,
      },
    });
  }

  private resolveActiveBotSpeechProfile(): ActiveBotSpeechProfile {
    return this.resolveBotSpeechProfile(this.maxBotContextService?.getActiveBotId() ?? null);
  }

  private resolveBotSpeechProfile(botId?: string | null): ActiveBotSpeechProfile {
    const normalizedBotId = botId?.trim() || null;
    const bot = this.maxBotLinkService?.getResolvedBotSync?.(normalizedBotId);
    const characterName = bot?.characterName?.trim() || bot?.label?.trim() || 'Майор Максимов';

    return {
      persona: bot?.speechPersona ?? 'male',
      characterName,
    };
  }

  private buildPrivateMenuPromptText(): string {
    const profile = this.resolveActiveBotSpeechProfile();
    return [
      profile.characterName,
      BOT_PRIVATE_MENU_APP_LINE,
      buildUserAgreementShortNotice(this.appBaseUrl),
      buildBotStartQuickActionText(profile),
    ].join('\n');
  }

  private shouldResolveSanction(ruleCode: string): boolean {
    return !NON_SANCTION_RULE_CODES.has(ruleCode);
  }

  private resolveLinkEscalationAction(
    linkViolationCount24h: number,
    settings: {
      warnEnabled: boolean;
      banEnabled: boolean;
      muteEnabled: boolean;
      warnMaxCount?: number;
      muteMaxCount?: number;
      banMaxCount?: number;
    },
  ): RequiredSubscriptionNoticeAction {
    const warnMaxCount = settings.warnMaxCount ?? 2;
    const muteMaxCount = settings.muteMaxCount ?? (settings.warnEnabled ? warnMaxCount + 1 : 2);
    const banMaxCount =
      settings.banMaxCount ??
      (settings.muteEnabled ? muteMaxCount + 1 : settings.warnEnabled ? warnMaxCount + 1 : 2);

    return this.resolveConfiguredEscalationAction(linkViolationCount24h, {
      ...settings,
      warnMaxCount,
      muteMaxCount,
      banMaxCount,
    });
  }

  private resolveRequiredSubscriptionEscalationAction(
    requiredSubscriptionViolationCount24h: number,
    settings: { warnEnabled: boolean; banEnabled: boolean; muteEnabled: boolean },
  ): RequiredSubscriptionNoticeAction {
    return this.resolveLinkEscalationAction(requiredSubscriptionViolationCount24h, settings);
  }

  private resolveTextFilterEscalationAction(
    textFilterViolationCount24h: number,
    settings: { warnEnabled: boolean; banEnabled: boolean; muteEnabled: boolean },
  ): SanctionAction {
    return resolveCommercialSanctionAction(textFilterViolationCount24h, settings) as SanctionAction;
  }

  private resolveConfiguredEscalationAction(
    violationCount: number,
    settings: {
      warnEnabled: boolean;
      banEnabled: boolean;
      muteEnabled: boolean;
      warnMaxCount: number;
      muteMaxCount: number;
      banMaxCount: number;
    },
  ): RequiredSubscriptionNoticeAction {
    return resolveConfiguredRuleEscalation(violationCount, settings);
  }

  private resolveMessageLimitsEscalationAction(
    violationCount12h: number,
    settings: { warnEnabled: boolean; banEnabled: boolean; muteEnabled: boolean },
  ): SanctionAction {
    return resolveMessageLimitsRuleEscalation(violationCount12h, settings);
  }

  private resolveTextFilterEscalationSettings(
    ruleCode: string,
    settings: ChatSettings,
  ): {
    botMessageEnabled: boolean;
    botMessageText: string;
    warnEnabled: boolean;
    warnMessageText: string;
    banEnabled: boolean;
    muteEnabled: boolean;
    adminContactButtonEnabled: boolean;
    adminContactButtonUrl: string;
  } {
    if (ruleCode === 'PROFANITY') {
      return {
        botMessageEnabled: settings.profanityBotMessageEnabled,
        botMessageText: settings.profanityBotMessageText,
        warnEnabled: settings.profanityWarnEnabled,
        warnMessageText: settings.profanityWarnMessageText,
        banEnabled: settings.profanityBanEnabled,
        muteEnabled: settings.profanityMuteEnabled,
        adminContactButtonEnabled: settings.profanityAdminContactButtonEnabled,
        adminContactButtonUrl: settings.profanityAdminContactButtonUrl,
      };
    }

    return {
      botMessageEnabled: settings.textFiltersBotMessageEnabled,
      botMessageText: settings.textFiltersBotMessageText,
      warnEnabled: settings.textFiltersWarnEnabled,
      warnMessageText: settings.textFiltersWarnMessageText,
      banEnabled: settings.textFiltersBanEnabled,
      muteEnabled: settings.textFiltersMuteEnabled,
      adminContactButtonEnabled: settings.textFiltersAdminContactButtonEnabled,
      adminContactButtonUrl: settings.textFiltersAdminContactButtonUrl,
    };
  }

  private resolveAutomaticMuteDurationHours(ruleCode: string, settings: ChatSettings): number {
    return resolveModerationMuteDurationHours(ruleCode, settings);
  }

  private isMessageLimitsViolation(ruleCode: string): boolean {
    return MESSAGE_LIMITS_RULE_CODES.has(ruleCode);
  }

  private isTextFilterViolation(ruleCode: string): boolean {
    return TEXT_FILTER_RULE_CODES.has(ruleCode);
  }

  private buildTextFilterExplanation(
    userLabel: string,
    ruleCode: string,
    canDeleteMessage: boolean,
    templateText: string,
    botSpeechStyle: BotSpeechStyle | null,
  ): string {
    return this.renderEditableBotSpeechTemplate({
      style: botSpeechStyle,
      fieldKey: ruleCode === 'PROFANITY' ? 'profanityBotMessageText' : 'textFiltersBotMessageText',
      overrideText: templateText,
      replacements: {
        user: userLabel,
        message_status: resolveBotSpeechMessageStatus(templateText, canDeleteMessage),
        reason: resolveTextFilterExplanationReason(ruleCode, templateText),
      },
    });
  }

  private buildMessageLimitsExplanation(
    userLabel: string,
    ruleCode: string,
    canDeleteMessage: boolean,
    messageCountLimitMessages: number,
    messageCountLimitWindowHours: number,
    photoCooldownHours: number,
    stickerCooldownMinutes: number,
    messageLength?: number,
    maxMessageLength?: number,
    blockedWord?: string | null,
    templateText?: string,
    botSpeechStyle?: BotSpeechStyle | null,
  ): string {
    return this.renderEditableBotSpeechTemplate({
      style: botSpeechStyle ?? null,
      fieldKey: 'messageLimitsBotMessageText',
      overrideText: templateText ?? '',
      replacements: {
        user: userLabel,
        ...buildMessageLimitsExplanationReplacements({
          templateText,
          ruleCode,
          messageDeleted: canDeleteMessage,
          messageCountLimitMessages,
          messageCountLimitWindowHours,
          photoCooldownHours,
          stickerCooldownMinutes,
          messageLength,
          maxMessageLength,
          blockedWord,
        }),
      },
    });
  }

  private buildPhoneNumbersExplanation(
    userLabel: string,
    canDeleteMessage: boolean,
    templateText: string,
    botSpeechStyle: BotSpeechStyle | null,
  ): string {
    return this.renderEditableBotSpeechTemplate({
      style: botSpeechStyle ?? null,
      fieldKey: 'phoneNumbersBotMessageText',
      overrideText: templateText,
      replacements: {
        user: userLabel,
        message_status: resolveBotSpeechMessageStatus(templateText, canDeleteMessage),
        reason: resolveBotSpeechPlaceholder(
          templateText,
          'телефонные номера в этом чате запрещены',
          'номера телефонов в сообщениях запрещены',
        ),
      },
    });
  }

  private buildMessageLimitsMuteExplanation(
    userLabel: string,
    ruleCode: string,
    blockedWord: string | null | undefined,
    botSpeechStyle: BotSpeechStyle | null,
  ): string {
    return this.renderSystemBotSpeechTemplate({
      style: botSpeechStyle,
      templateKey: 'messageLimitsMute',
      replacements: {
        user: userLabel,
        reason: resolveMessageLimitsSanctionReason(ruleCode, blockedWord),
      },
    });
  }

  private buildMessageLimitsWarnExplanation(
    userLabel: string,
    ruleCode: string,
    blockedWord: string | null | undefined,
    botSpeechStyle: BotSpeechStyle | null,
    templateText = '',
  ): string {
    return this.renderEditableBotSpeechTemplate({
      style: botSpeechStyle,
      fieldKey: 'messageLimitsWarnMessageText',
      overrideText: templateText,
      replacements: {
        user: userLabel,
        reason: resolveMessageLimitsSanctionReason(ruleCode, blockedWord, templateText),
      },
    });
  }

  private buildMessageLimitsBanExplanation(
    userLabel: string,
    ruleCode: string,
    _muteDurationHours: number,
    blockedWord: string | null | undefined,
    botSpeechStyle: BotSpeechStyle | null,
  ): string {
    return this.renderSystemBotSpeechTemplate({
      style: botSpeechStyle,
      templateKey: 'messageLimitsBan',
      replacements: {
        user: userLabel,
        reason: resolveMessageLimitsSanctionReason(ruleCode, blockedWord),
      },
    });
  }

  private buildBotMessageOptions(
    chatId: string,
    rawButtons: unknown,
    buttonEnabled: boolean,
    buttonUrl: string,
    buttonText: string,
    rulesButtonEnabled = false,
    rulesPublishedUrl: string | null = null,
    rulesPublishedMessageId: string | null = null,
  ): MaxSendMessageOptions | null {
    const buttons: MaxMessageButton[] = [];
    const rulesMessageLink = this.buildRulesMessageLink(
      rulesButtonEnabled,
      rulesPublishedUrl,
      rulesPublishedMessageId,
    );

    if (buttonEnabled) {
      buttons.push(
        ...this.normalizeConfiguredLinkButtons(rawButtons, {
          buttonUrl,
          buttonText,
        }),
      );
    }

    const rulesButton = this.buildRulesButton(
      chatId,
      rulesButtonEnabled,
      rulesPublishedUrl,
      rulesPublishedMessageId,
    );
    if (rulesButton) {
      buttons.push(rulesButton);
    }

    if (buttons.length === 0 && !rulesMessageLink) {
      return null;
    }

    const buttonRows = this.buildMessageButtonRows(buttons);
    if (
      buttonRows.length === 1 &&
      buttonRows[0].length === 1 &&
      this.isLinkButton(buttonRows[0][0])
    ) {
      return {
        button: buttonRows[0][0],
        ...(rulesMessageLink ? { messageLink: rulesMessageLink } : {}),
      };
    }

    return buttonRows.length > 0
      ? {
          buttons: buttonRows,
          ...(rulesMessageLink ? { messageLink: rulesMessageLink } : {}),
        }
      : {
          messageLink: rulesMessageLink,
        };
  }

  private normalizeConfiguredLinkButtons(
    rawButtons: unknown,
    legacy?: {
      buttonUrl?: string | null;
      buttonText?: string | null;
    },
  ): MaxLinkButton[] {
    const buttons: MaxLinkButton[] = [];

    if (Array.isArray(rawButtons)) {
      for (const item of rawButtons) {
        if (!item || typeof item !== 'object') {
          continue;
        }

        const row = item as { text?: unknown; url?: unknown };
        const button = this.buildLinkButton(
          true,
          typeof row.url === 'string' ? row.url : '',
          typeof row.text === 'string' ? row.text : DEFAULT_BROADCAST_BUTTON_TEXT,
        );
        if (!button) {
          continue;
        }

        buttons.push(button);
      }
    }

    if (buttons.length > 0) {
      return buttons;
    }

    const legacyButton = this.buildLinkButton(
      true,
      legacy?.buttonUrl ?? '',
      legacy?.buttonText ?? DEFAULT_BROADCAST_BUTTON_TEXT,
    );
    return legacyButton ? [legacyButton] : [];
  }

  private buildMessageButtonRows(buttons: readonly MaxMessageButton[]): MaxMessageButton[][] {
    const rows: MaxMessageButton[][] = [];

    for (let index = 0; index < buttons.length; index += MAX_BROADCAST_LINK_BUTTONS_PER_ROW) {
      rows.push(buttons.slice(index, index + MAX_BROADCAST_LINK_BUTTONS_PER_ROW));
    }

    return rows;
  }

  private buildRequiredSubscriptionMessageOptions(
    channels: ReadonlyArray<{ id: string; title: string; link: string | null }>,
    buttonText: string | null | undefined,
    rulesButtonEnabled: boolean,
    rulesPublishedUrl: string | null,
    rulesPublishedMessageId: string | null,
  ): MaxSendMessageOptions | null {
    const normalizedButtonText =
      typeof buttonText === 'string' && buttonText.trim().length > 0 ? buttonText.trim() : null;
    const buttons = channels
      .map((channel) => {
        const normalizedUrl = this.normalizeBotButtonUrl(channel.link ?? '');
        if (!normalizedUrl) {
          return null;
        }

        return {
          text: this.normalizeBotButtonText(normalizedButtonText ?? channel.title),
          url: normalizedUrl,
        } satisfies MaxLinkButton;
      })
      .filter((button): button is MaxLinkButton => button !== null);
    const rulesMessageLink = this.buildRulesMessageLink(
      rulesButtonEnabled,
      rulesPublishedUrl,
      rulesPublishedMessageId,
    );

    if (buttons.length === 0 && !rulesMessageLink) {
      return null;
    }

    return buttons.length > 0
      ? {
          buttons: buttons.map((button) => [button]),
          ...(rulesMessageLink ? { messageLink: rulesMessageLink } : {}),
          debugContext: {
            screen: 'moderation',
            action: 'required-subscription-notice',
          },
        }
      : {
          messageLink: rulesMessageLink,
          debugContext: {
            screen: 'moderation',
            action: 'required-subscription-notice',
          },
        };
  }

  private buildLinkButton(
    buttonEnabled: boolean,
    buttonUrl: string,
    buttonText: string,
  ): MaxLinkButton | null {
    if (!buttonEnabled) {
      return null;
    }

    const normalizedUrl = this.normalizeBotButtonUrl(buttonUrl);
    if (!normalizedUrl) {
      return null;
    }

    return {
      text: this.normalizeBotButtonText(buttonText),
      url: normalizedUrl,
    };
  }

  private buildRulesButton(
    chatId: string,
    buttonEnabled: boolean,
    publishedUrl: string | null,
    publishedMessageId: string | null,
  ): MaxMessageButton | null {
    if (!buttonEnabled) {
      return null;
    }

    const directLinkButton = this.buildLinkButton(
      Boolean(publishedUrl),
      publishedUrl ?? '',
      RULES_BOT_BUTTON_TEXT,
    );
    if (directLinkButton) {
      return directLinkButton;
    }

    if (!chatId.trim() || !publishedMessageId?.trim()) {
      return null;
    }

    return null;
  }

  private buildRulesMessageLink(
    buttonEnabled: boolean,
    publishedUrl: string | null,
    publishedMessageId: string | null,
  ): { type: 'reply'; mid: string } | null {
    if (!buttonEnabled || this.normalizeBotButtonUrl(publishedUrl ?? '')) {
      return null;
    }

    const normalizedMessageId = publishedMessageId?.trim() ?? '';
    if (!normalizedMessageId) {
      return null;
    }

    return {
      type: 'reply',
      mid: normalizedMessageId,
    };
  }

  private isLinkButton(button: MaxMessageButton): button is MaxLinkButton {
    return !('type' in button) || button.type === 'link';
  }

  private normalizeBotButtonUrl(value: string): string | null {
    const normalized = typeof value === 'string' ? value.trim() : '';
    if (!normalized) {
      return null;
    }

    try {
      const parsed = new URL(normalized);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return null;
      }

      return parsed.toString();
    } catch {
      return null;
    }
  }

  private normalizeBotButtonText(value: string): string {
    const normalized = typeof value === 'string' ? value.trim() : '';
    if (!normalized) {
      return DEFAULT_BOT_BUTTON_TEXT;
    }

    return normalized.slice(0, 32);
  }

  private async countRecentViolationsWithEscalationCounter(params: {
    chatId: string;
    userId: string;
    ruleKey: string;
    windowMs: number;
    messageId?: string | null;
    updateType?: string | null;
    loadCount: () => Promise<number>;
  }): Promise<number> {
    // FLAG: A scalar Redis TTL cannot represent a sliding window or the manual-release
    // boundary. Durable message claims deduplicate writes; indexed SQL owns sanction counts.
    return this.normalizeRecentViolationCount(await params.loadCount());
  }

  private async claimMessageViolationProcessing(params: {
    chatId: string;
    userId: string;
    messageId?: string | null;
    ruleCode: string;
    updateType?: string | null;
  }): Promise<boolean> {
    if (await this.isLegacyModerationHeld(params.chatId, params.userId, params.messageId))
      return false;
    const messageId = params.messageId?.trim();
    if (!messageId) {
      return true;
    }

    const updateType = params.updateType?.trim().toLowerCase() || 'message';
    const claimKey = buildModerationMessageViolationProcessingClaimKey({
      chatId: params.chatId,
      userId: params.userId,
      messageId,
      ruleCode: params.ruleCode,
      updateType,
    });

    const persistedClaim = await claimPersistedMessageViolationProcessing(this.prisma, {
      ...params,
      messageId,
      updateType,
      dedupeKey: claimKey.dedupeKey,
    });
    if (persistedClaim === 'duplicate') {
      this.logSkippedDuplicateMessageViolation({
        chatId: params.chatId,
        userId: params.userId,
        messageId,
        ruleCode: params.ruleCode,
        updateType,
      });
      return false;
    }
    if (persistedClaim === 'claimed') {
      if (updateType !== 'message_action') {
        void this.markRedisMessageViolationProcessing(claimKey, {
          chatId: params.chatId,
          userId: params.userId,
          messageId,
          ruleCode: params.ruleCode,
          updateType,
        });
      }
      return true;
    }

    if (updateType === 'message_action') {
      return persistedClaim === 'unsupported'
        ? !(await this.hasPersistedBotModerationEventForMessageViolation({
            chatId: params.chatId,
            userId: params.userId,
            messageId,
            ruleCode: params.ruleCode,
          }))
        : false;
    }

    const redisClaim = await this.markRedisMessageViolationProcessing(claimKey, {
      chatId: params.chatId,
      userId: params.userId,
      messageId,
      ruleCode: params.ruleCode,
      updateType,
    });
    if (redisClaim !== null) {
      return redisClaim;
    }
    if (persistedClaim === 'unavailable') {
      this.logger.warn(
        {
          chatId: params.chatId,
          userId: params.userId,
          messageId,
          ruleCode: params.ruleCode,
          updateType,
        },
        'Skipped moderation violation follow-up because message claim storage is unavailable',
      );
      return false;
    }

    return !(await this.hasPersistedBotModerationEventForMessageViolation({
      chatId: params.chatId,
      userId: params.userId,
      messageId,
      ruleCode: params.ruleCode,
    }));
  }

  private async claimMessageScopedModerationAction(params: {
    chatId: string;
    userId: string;
    messageId?: string | null;
    ruleCode: string;
  }): Promise<boolean> {
    return this.claimMessageViolationProcessing({
      ...params,
      updateType: 'message_action',
    });
  }

  async executeRuleFollowup(
    row: ModerationRuleFollowup,
    plan: ModerationRuleFollowupPlan,
    journal: ModerationRuleFollowupJournal,
  ): Promise<void> {
    const envelope = readRuleFollowupEnvelope(row.envelope);
    if (!envelope || !this.moderationRuleSanctionGuard)
      throw new ModerationRuleSanctionRejectedError();
    let settings = await this.prisma.chatSettings.findUniqueOrThrow({
      where: { chatId: row.chatId },
    });
    if (STOP_WORDS_DELETE_RULE_CODES.has(row.ruleCode)) {
      const policy = readStopWordsPolicy(settings);
      if (policy) settings = withStopWordsSanctions(settings, policy);
    }
    const reason = await this.prisma.moderationDeleteIntentReason.findUniqueOrThrow({
      where: { intentId_reasonKey: { intentId: row.intentId, reasonKey: row.reasonKey } },
    });
    const route = await this.maxBotLinkService!.resolveBotRoute({
      purpose: 'member_access',
      chatId: row.chatId,
    });
    const botId = route.botId ?? envelope.originBotId ?? undefined;
    const phase = (await journal.readState()).phase;
    const recoveringOwnEffect = phase !== 'UNSTARTED';
    if (!botId && !recoveringOwnEffect) throw new Error('Rule follow-up has no capable executor');
    const guards = createRuleSanctionGuards(
      async (proof, options) => {
        await this.assertLegacyModerationAllowed(proof.chatId, proof.userId, proof.messageId);
        await this.moderationRuleSanctionGuard!.assertAllowed(proof, options);
      },
      {
        chatId: row.chatId,
        messageId: row.messageId,
        subjectUserId: row.userId,
        sourceMessageAt: row.sourceAt,
        reasonKey: row.reasonKey,
        ruleCode: row.ruleCode,
      },
      row.policySha256,
      () => botId,
      () => this.maxBotContextService?.getActiveBotId() ?? botId,
    );
    if (guards)
      guards.noticeLedgerContext.moderationRuleFollowup = {
        version: 1,
        id: row.id,
        issuedAtMs: plan.issuedAtMs,
      };
    const beforeNoticeSend = async () => {
      await journal.assertLease();
      const manual = await this.resolveLatestManualReleaseCreatedAt(row.chatId, row.userId);
      if (manual && manual.getTime() >= plan.issuedAtMs)
        throw new ModerationRuleSanctionRejectedError();
      await guards?.assertBeforeFollowUp();
    };
    const task = () =>
      executeModerationRuleFollowUp(this.getRuleFollowupHost(), {
        chatId: row.chatId,
        senderId: row.userId,
        messageId: row.messageId,
        userLabel: envelope.userLabel,
        settings,
        updateType: envelope.updateType,
        maskedExcerpt: reason.maskedExcerpt ?? '',
        effectiveMessageLength: envelope.effectiveMessageLength,
        rulesPublishedUrl: envelope.rulesPublishedUrl,
        rulesPublishedMessageId: envelope.rulesPublishedMessageId,
        messageDeleted: true,
        isCommercialReviewOnly: false,
        topViolation: {
          ruleCode: row.ruleCode.replace(/_DELETE$/u, ''),
          score: reason.score,
          reason: String(this.asRecord(reason.metadata)?.reason ?? ''),
          metadata: this.asRecord(reason.metadata) ?? undefined,
        },
        ownRuleGuards: guards,
        beforeNoticeSend,
        recoveringOwnEffect,
        durable: { row, plan, journal },
      });
    if (botId && this.maxBotContextService) await this.maxBotContextService.runWithBot(botId, task);
    else await task();
  }

  private async persistRuleFollowupEvent(
    durable: RuleFollowupExecutionContext['durable'],
    input: { data: Prisma.ModerationEventUncheckedCreateInput },
  ) {
    if (!durable) return this.createBotModerationEvent(input);
    const { row, plan, journal } = durable;
    await journal.assertLease();
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw(
        Prisma.sql`SELECT "id" FROM "moderation_rule_followups" WHERE "id" = ${row.id} FOR UPDATE`,
      );
      const current = await tx.moderationRuleFollowup.findUniqueOrThrow({ where: { id: row.id } });
      const clocks = await tx.$queryRaw<Array<{ now: Date }>>(
        Prisma.sql`SELECT clock_timestamp() AT TIME ZONE 'UTC' AS now`,
      );
      const now = clocks[0]!.now;
      if (
        current.leaseToken !== row.leaseToken ||
        current.status !== 'IN_PROGRESS' ||
        !current.leaseExpiresAt ||
        current.leaseExpiresAt <= now
      )
        throw new Error('Rule follow-up event lease lost');
      const existing = await tx.moderationEvent.findUnique({ where: { id: plan.eventId } });
      if (existing) {
        if (
          existing.chatId !== row.chatId ||
          existing.userId !== row.userId ||
          existing.messageId !== row.messageId ||
          existing.ruleCode !== input.data.ruleCode ||
          existing.action !== input.data.action ||
          existing.createdAt.getTime() !== plan.issuedAtMs ||
          this.asRecord(existing.metadata)?.moderationRuleFollowupId !== row.id
        )
          throw new Error('Rule follow-up event identity changed');
        return existing;
      }
      const effects = this.asRecord(current.effects);
      const confirmedBan = plan.action === 'BAN' && effects?.phase === 'BAN_CONFIRMED';
      // FLAG: Exact confirmed BAN permits receipt-only SQL settlement after expiry. New
      // WARN/MUTE effects require current policy and no newer manual release after locks.
      if (!confirmedBan) {
        await this.assertLegacyModerationAllowed(row.chatId, row.userId, row.messageId, tx);
        await tx.$queryRaw(
          Prisma.sql`SELECT "id" FROM "chats" WHERE "id" = ${row.chatId} FOR SHARE`,
        );
        await tx.$queryRaw(
          Prisma.sql`SELECT "chat_id" FROM "chat_settings" WHERE "chat_id" = ${row.chatId} FOR SHARE`,
        );
        const settings = await tx.chatSettings.findUniqueOrThrow({
          where: { chatId: row.chatId },
          include: {
            chat: {
              select: {
                entityType: true,
                admins: { where: { userId: row.userId }, select: { userId: true } },
              },
            },
          },
        });
        const manual = await tx.moderationEvent.findFirst({
          where: {
            chatId: row.chatId,
            userId: row.userId,
            ruleCode: { in: ['MANUAL_UNMUTE', 'MANUAL_UNBAN'] },
            createdAt: { gte: new Date(plan.issuedAtMs) },
          },
          select: { id: true },
        });
        const reason = await tx.moderationDeleteIntentReason.findUniqueOrThrow({
          where: { intentId_reasonKey: { intentId: row.intentId, reasonKey: row.reasonKey } },
          select: { metadata: true },
        });
        const reasonDeadline = this.asRecord(reason.metadata)?.messageLimitDeadlineAtMs;
        const finalClock = await tx.$queryRaw<Array<{ now: Date }>>(
          Prisma.sql`SELECT clock_timestamp() AT TIME ZONE 'UTC' AS now`,
        );
        if (
          finalClock[0]!.now >= row.deadlineAt ||
          (reasonDeadline !== undefined &&
            (!Number.isSafeInteger(reasonDeadline) ||
              finalClock[0]!.now.getTime() >= Number(reasonDeadline))) ||
          settings.chat.entityType !== 'CHAT' ||
          settings.chat.admins.length ||
          fingerprintModerationSettings(settings, row.ruleCode) !== row.policySha256 ||
          manual
        )
          throw new ModerationRuleSanctionRejectedError();
      }
      const event = await tx.moderationEvent.create({
        data: {
          ...input.data,
          id: plan.eventId,
          createdAt: new Date(plan.issuedAtMs),
          metadata: {
            ...(this.asRecord(input.data.metadata) ?? {}),
            moderationRuleFollowupId: row.id,
          } as Prisma.InputJsonObject,
        },
      });
      await persistAutomaticMuteCleanup(tx, event);
      // FLAG: The event and checkpoint commit together; a crash cannot leave a committed
      // mute/warning behind an unstarted checkpoint or extend its immutable expiry.
      const checkpoint = await tx.$executeRaw(Prisma.sql`
        UPDATE "moderation_rule_followups" SET "effects" = ${JSON.stringify({ ...(effects ?? {}), phase: 'SQL_COMMITTED', eventId: plan.eventId })}::jsonb,
          "updated_at" = clock_timestamp() AT TIME ZONE 'UTC'
        WHERE "id" = ${row.id} AND "status" = 'IN_PROGRESS' AND "lease_token" = ${row.leaseToken}
          AND "lease_expires_at" > (clock_timestamp() AT TIME ZONE 'UTC')
      `);
      if (!checkpoint) throw new Error('Rule follow-up event checkpoint lease lost');
      return event;
    });
  }

  private async applyRuleFollowupSanction(
    durable: RuleFollowupExecutionContext['durable'],
    params: ApplySanctionActionParams,
  ): Promise<boolean> {
    if (!durable) return this.applySanctionAction(params);
    const { row, plan, journal } = durable;
    const memberKey = `${row.id}:sanction-ban`;
    const recoverBanReceipt = async (): Promise<RuleFollowupBanOutcome> => {
      const ledger = await this.prisma.maxActionLedgerEntry.findUnique({
        where: { jobId: this.maxClient.getExplicitActionJobId('BAN_MEMBER', memberKey) },
      });
      if (
        !ledger ||
        ledger.actionType !== 'BAN_MEMBER' ||
        ledger.chatId !== row.chatId ||
        ledger.userId !== row.userId
      )
        return { kind: 'unknown' };
      if (ledger.status === 'SUCCEEDED' && !ledger.ambiguous && ledger.completedAt)
        return { kind: 'confirmed', botId: ledger.dispatchBotId ?? ledger.botId };
      if (
        !ledger.ambiguous &&
        !ledger.dispatchStartedAt &&
        ledger.lastErrorCode &&
        MAX_MEMBER_ACTION_PRE_DISPATCH_RETRY_ERROR_CODES.includes(ledger.lastErrorCode as never)
      )
        return { kind: 'no_effect' };
      return { kind: 'unknown' };
    };
    return this.moderationSanctionStateLockService.runExclusive(
      { chatId: row.chatId, userId: row.userId },
      async (lock) => {
        const active = {
          ...journal,
          assertLease: async () => {
            await journal.assertLease();
            await lock.assertOwned();
          },
        };
        const freshReputation =
          !journal.receiptOnly && (await active.readState()).phase === 'UNSTARTED';
        return executeRuleFollowupSanction(plan, active, {
          authorize: async () => {
            await active.assertLease();
            if (await this.isLegacyModerationHeld(row.chatId, row.userId, row.messageId))
              return false;
            const manual = await this.resolveLatestManualReleaseCreatedAt(row.chatId, row.userId);
            if (manual && manual.getTime() >= plan.issuedAtMs) return false;
            return (await params.authorizeSanction?.()) !== false;
          },
          ban: async ({ actionKey, beforeMutation }) => {
            try {
              const result = await this.banMemberImmediatelyWithResult(
                row.chatId,
                row.userId,
                {
                  idempotencyKey: actionKey,
                  beforeImmediateMemberMutation: withMaxFinalAuthorityCheckpoint(
                    async (beforeFinalAuthority) => {
                      await beforeMutation();
                      await this.moderationRuleSanctionGuard!.assertAllowed(
                        {
                          chatId: row.chatId,
                          messageId: row.messageId,
                          userId: row.userId,
                          ruleCode: row.ruleCode,
                          reasonKey: row.reasonKey,
                          policySha256: row.policySha256,
                          deadlineAtMs: row.deadlineAt.getTime(),
                          botId: this.maxBotContextService?.getActiveBotId() ?? undefined,
                        },
                        {
                          beforeFinalAuthority,
                          assertFinalOwnership: async () => {
                            await lock.assertOwned();
                            await journal.assertLease();
                          },
                        },
                      );
                    },
                  ),
                },
                { assertOwned: active.assertLease },
              );
              return result.ok ? { kind: 'confirmed', botId: result.botId } : recoverBanReceipt();
            } catch (error) {
              if (wasMaxPreDispatchGuardRejected(error)) return { kind: 'no_effect' };
              return recoverBanReceipt();
            }
          },
          recoverBanReceipt,
          persistDeterministicEvent: async ({ action, muteExpiresAtMs, muteDurationHours }) => {
            const event = await params.persistModerationEvent(
              {
                sanctionApplied: action === 'MUTE' || action === 'BAN',
                ...(action === 'MUTE'
                  ? {
                      muteDurationHours,
                      muteExpiresAt: new Date(muteExpiresAtMs!).toISOString(),
                      mutePermanent: false,
                    }
                  : {}),
              },
              action as SanctionAction,
            );
            const eventId = this.readString(this.asRecord(event)?.id);
            if (!eventId) throw new Error('Rule follow-up event missing');
            return eventId;
          },
          // FLAG: Replay derives current effective SQL state under the shared sanction lock,
          // rather than restoring an old event over a newer mute, ban or manual release.
          rememberActiveMute: async () => {
            if (await this.isLegacyModerationHeld(row.chatId, row.userId, row.messageId)) return;
            await this.getActiveMute(row.chatId, row.userId, plan.muteDurationHours, {
              bypassCache: true,
            });
          },
          rememberInactiveMute: async () => {
            await this.getActiveMute(row.chatId, row.userId, plan.muteDurationHours, {
              bypassCache: true,
            });
          },
          recordReputation: async ({ effectKey, observedAtMs }) => {
            // FLAG: Late receipt settlement records historical SQL only. It must not revive
            // old global evidence under the intelligence sink's current-time registry TTL.
            if (!freshReputation || Date.now() >= row.deadlineAt.getTime()) return;
            await this.upsertGlobalSpammerEntry({
              userId: row.userId,
              sourceChatId: row.chatId,
              reason: 'SANCTION_BAN',
              evidenceHash: effectKey,
              evidence: {
                action: 'BAN',
                source: 'sanction',
                moderationRuleFollowupEffectKey: effectKey,
                observedAtMs,
              },
            });
          },
          sendNotice: async ({ idempotencyKey, sanctionEventId }) => {
            if (journal.receiptOnly || (plan.action !== 'MUTE' && plan.action !== 'BAN')) return;
            const notice = {
              ...params,
              idempotencyKey,
              sanctionEventId,
              rethrowOnFailure: true,
              beforeSend: async () => {
                await active.assertLease();
                const manual = await this.resolveLatestManualReleaseCreatedAt(
                  row.chatId,
                  row.userId,
                );
                if (manual && manual.getTime() >= plan.issuedAtMs)
                  throw new ModerationRuleSanctionRejectedError();
                await params.noticeBeforeSend?.();
              },
              ledgerContext: params.noticeLedgerContext,
              bypassNoticeBucket: true,
              botId: undefined,
            };
            if (plan.action === 'MUTE') await this.sendMuteNotice(notice);
            else await this.sendBanNoticeMessage(notice);
          },
        });
      },
    );
  }

  getRuleFollowupHost() {
    return {
      appendAdminContactMarkdownLink: this.appendAdminContactMarkdownLink.bind(this),
      buildBotMessageOptions: this.buildBotMessageOptions.bind(this),
      buildLinkExplanation: this.buildLinkExplanation.bind(this),
      buildLinkMuteExplanation: this.buildLinkMuteExplanation.bind(this),
      buildLinkWarnExplanation: this.buildLinkWarnExplanation.bind(this),
      buildMessageLimitsBanExplanation: this.buildMessageLimitsBanExplanation.bind(this),
      buildMessageLimitsExplanation: this.buildMessageLimitsExplanation.bind(this),
      buildMessageLimitsMuteExplanation: this.buildMessageLimitsMuteExplanation.bind(this),
      buildMessageLimitsWarnExplanation: this.buildMessageLimitsWarnExplanation.bind(this),
      buildPhoneNumbersExplanation: this.buildPhoneNumbersExplanation.bind(this),
      buildTextFilterExplanation: this.buildTextFilterExplanation.bind(this),
      buildTextFilterMuteExplanation: this.buildTextFilterMuteExplanation.bind(this),
      buildTextFilterWarnExplanation: this.buildTextFilterWarnExplanation.bind(this),
      countRecentLinkViolations: this.countRecentLinkViolations.bind(this),
      countRecentMessageLimitsViolations: this.countRecentMessageLimitsViolations.bind(this),
      countRecentPhoneNumberViolations: this.countRecentPhoneNumberViolations.bind(this),
      countRecentTextFilterViolations: this.countRecentTextFilterViolations.bind(this),
      isMessageLimitsViolation: this.isMessageLimitsViolation.bind(this),
      isTextFilterViolation: this.isTextFilterViolation.bind(this),
      logger: this.logger,
      resolveAutomaticMuteDurationHours: this.resolveAutomaticMuteDurationHours.bind(this),
      resolveBotSpeechMedia: this.resolveBotSpeechMedia.bind(this),
      resolveConfiguredEscalationAction: this.resolveConfiguredEscalationAction.bind(this),
      resolveLinkEscalationAction: this.resolveLinkEscalationAction.bind(this),
      resolveMessageLimitsEscalationAction: this.resolveMessageLimitsEscalationAction.bind(this),
      resolveSanctionUserLabel: this.resolveSanctionUserLabel.bind(this),
      resolveTextFilterEscalationAction: this.resolveTextFilterEscalationAction.bind(this),
      resolveTextFilterEscalationSettings: this.resolveTextFilterEscalationSettings.bind(this),
      sanctionService: this.sanctionService,
      sendBotMessageWithOptionalAutoDelete: this.sendBotMessageWithOptionalAutoDelete.bind(this),
      shouldResolveSanction: this.shouldResolveSanction.bind(this),
      stopWordsDeleteGuard: this.stopWordsDeleteGuard,
      persistRuleFollowupEvent: this.persistRuleFollowupEvent.bind(this),
      applyRuleFollowupSanction: this.applyRuleFollowupSanction.bind(this),
    };
  }

  private async claimAndPersistMessageScopedModerationViolation(params: {
    chatId: string;
    userId: string;
    messageId: string;
    ruleCode: string;
    score: number;
  }): Promise<boolean> {
    if (await this.isLegacyModerationHeld(params.chatId, params.userId, params.messageId))
      return false;
    return claimAndPersistModerationMessageViolation(
      this.prisma,
      {
        ...params,
        updateType: 'message_action',
      },
      (input) => this.claimMessageScopedModerationAction(input),
      (context) => this.logSkippedDuplicateMessageViolation(context),
      (claimKey, context) => this.markRedisMessageViolationProcessing(claimKey, context),
    );
  }

  private async claimDuplicateMessageAction(params: {
    chatId: string;
    userId: string;
    messageId: string;
  }): Promise<DurableModerationMessageActionClaimResult> {
    if (await this.isLegacyModerationHeld(params.chatId, params.userId, params.messageId))
      return 'blocked';
    const ruleCode = DUPLICATE_MESSAGE_ACTION_CLAIM_RULE_CODE;
    return resolveDuplicateMessageActionClaim({
      ...params,
      ruleCode,
      claimPersisted: (input) => claimPersistedMessageViolationProcessing(this.prisma, input),
      hasLegacyEvent: () =>
        this.hasPersistedBotModerationEventForMessageViolation({ ...params, ruleCode }),
    });
  }

  private async markRedisMessageViolationProcessing(
    claimKey: { counterKey: string; memberKey: string },
    context: {
      chatId: string;
      userId: string;
      messageId: string;
      ruleCode: string;
      updateType: string;
    },
  ): Promise<boolean | null> {
    const incrementOncePerMemberWithTtl = (
      this.redisCounter as Partial<RedisCounterService> | undefined
    )?.incrementOncePerMemberWithTtl;

    if (!this.redisCounter || !incrementOncePerMemberWithTtl) {
      return null;
    }

    try {
      const result = await incrementOncePerMemberWithTtl.call(
        this.redisCounter,
        claimKey.counterKey,
        claimKey.memberKey,
        VIOLATION_MESSAGE_PROCESSING_TTL_SEC,
      );
      if (!result.inserted) {
        this.logSkippedDuplicateMessageViolation(context);
      }
      return result.inserted;
    } catch (error: unknown) {
      this.logger.debug(
        {
          ...context,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to claim Redis moderation violation message marker',
      );
      return null;
    }
  }

  private logSkippedDuplicateMessageViolation(params: {
    chatId: string;
    userId: string;
    messageId: string;
    ruleCode: string;
    updateType: string;
  }) {
    this.logger.debug(
      params,
      'Skipped duplicate moderation violation follow-up for already processed message',
    );
  }

  private async hasPersistedBotModerationEventForMessageViolation(params: {
    chatId: string;
    userId: string;
    messageId: string;
    ruleCode: string;
  }): Promise<boolean> {
    const moderationEventModel = this.prisma.moderationEvent as unknown as {
      findFirst?: (args: {
        where: {
          chatId: string;
          userId: string;
          messageId: string;
          ruleCode: string;
          operator: Operator;
        };
        select: { id: true; userId: true; messageId: true; ruleCode: true };
      }) => Promise<{ id: string; userId?: string; messageId?: string; ruleCode?: string } | null>;
    };

    if (typeof moderationEventModel.findFirst !== 'function') {
      return false;
    }

    try {
      const existing = await moderationEventModel.findFirst({
        where: {
          chatId: params.chatId,
          userId: params.userId,
          messageId: params.messageId,
          ruleCode: params.ruleCode,
          operator: Operator.BOT,
        },
        select: { id: true, userId: true, messageId: true, ruleCode: true },
      });
      if (!existing) {
        return false;
      }

      return (
        (existing.userId === undefined || existing.userId === params.userId) &&
        (existing.messageId === undefined || existing.messageId === params.messageId) &&
        (existing.ruleCode === undefined || existing.ruleCode === params.ruleCode)
      );
    } catch (error: unknown) {
      this.logger.debug(
        {
          chatId: params.chatId,
          userId: params.userId,
          messageId: params.messageId,
          ruleCode: params.ruleCode,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to inspect persisted moderation event for duplicate violation message',
      );
      return false;
    }
  }

  private normalizeRecentViolationCount(value: number): number {
    return Number.isInteger(value) && value > 0 ? value : 1;
  }

  private async countRecentLinkViolations(
    chatId: string,
    userId: string,
    windowHours: number,
    context: { messageId?: string | null; updateType?: string | null } = {},
  ): Promise<number> {
    const windowMs =
      this.normalizeEscalationWindowHours(windowHours, LINK_ESCALATION_WINDOW_HOURS) *
      60 *
      60 *
      1000;
    return this.countRecentViolationsWithEscalationCounter({
      chatId,
      userId,
      ruleKey: 'LINK_BLOCKED',
      windowMs,
      messageId: context.messageId,
      updateType: context.updateType,
      loadCount: async () => {
        const violationModel = this.prisma.violation as unknown as {
          count?: (args: {
            where: {
              chatId: string;
              userId: string;
              ruleCode: string;
              createdAt: { gte: Date; lte: Date };
            };
          }) => Promise<number>;
        };

        if (typeof violationModel.count !== 'function') {
          return 1;
        }

        const since = await this.resolveViolationResetSince(chatId, userId, windowMs);
        const count = await violationModel.count({
          where: {
            chatId,
            userId,
            ruleCode: 'LINK_BLOCKED',
            createdAt: { gte: since, lte: new Date(Date.now()) },
          },
        });

        return Number.isInteger(count) && count > 0 ? count : 1;
      },
    });
  }

  private async countRecentPhoneNumberViolations(
    chatId: string,
    userId: string,
    windowHours: number,
    context: { messageId?: string | null; updateType?: string | null } = {},
  ): Promise<number> {
    const windowMs =
      this.normalizeEscalationWindowHours(windowHours, MESSAGE_LIMITS_ESCALATION_WINDOW_HOURS) *
      60 *
      60 *
      1000;
    return this.countRecentViolationsWithEscalationCounter({
      chatId,
      userId,
      ruleKey: 'PHONE_NUMBER_BLOCKED',
      windowMs,
      messageId: context.messageId,
      updateType: context.updateType,
      loadCount: async () => {
        const violationModel = this.prisma.violation as unknown as {
          count?: (args: {
            where: {
              chatId: string;
              userId: string;
              ruleCode: string;
              createdAt: { gte: Date; lte: Date };
            };
          }) => Promise<number>;
        };

        if (typeof violationModel.count !== 'function') {
          return 1;
        }

        const since = await this.resolveViolationResetSince(chatId, userId, windowMs);
        const count = await violationModel.count({
          where: {
            chatId,
            userId,
            ruleCode: 'PHONE_NUMBER_BLOCKED',
            createdAt: { gte: since, lte: new Date(Date.now()) },
          },
        });

        return Number.isInteger(count) && count > 0 ? count : 1;
      },
    });
  }

  private normalizeEscalationWindowHours(value: number, fallback: number): number {
    return Number.isInteger(value) ? Math.min(168, Math.max(1, value)) : fallback;
  }

  private async countRecentRequiredSubscriptionViolations(
    chatId: string,
    userId: string,
    options: { persistedOnly?: boolean } = {},
  ): Promise<number> {
    const windowMs = REQUIRED_SUBSCRIPTION_ESCALATION_WINDOW_HOURS * 60 * 60 * 1000;
    const loadCount = async () => {
      const violationModel = this.prisma.violation as unknown as {
        count?: (args: {
          where: {
            chatId: string;
            userId: string;
            ruleCode: string;
            createdAt: { gte: Date; lte: Date };
          };
        }) => Promise<number>;
      };

      if (typeof violationModel.count !== 'function') {
        return 1;
      }

      const since = await this.resolveViolationResetSince(chatId, userId, windowMs);
      const count = await violationModel.count({
        where: {
          chatId,
          userId,
          ruleCode: REQUIRED_SUBSCRIPTION_RULE_CODE,
          createdAt: { gte: since, lte: new Date(Date.now()) },
        },
      });

      return Number.isInteger(count) && count > 0 ? count : 1;
    };
    if (options.persistedOnly) {
      return this.normalizeRecentViolationCount(await loadCount());
    }

    return this.countRecentViolationsWithEscalationCounter({
      chatId,
      userId,
      ruleKey: REQUIRED_SUBSCRIPTION_RULE_CODE,
      windowMs,
      loadCount,
    });
  }

  private async countRecentInvitationAccessViolations(
    chatId: string,
    userId: string,
  ): Promise<number> {
    const windowMs = INVITATION_ACCESS_ESCALATION_WINDOW_HOURS * 60 * 60 * 1000;
    return this.countRecentViolationsWithEscalationCounter({
      chatId,
      userId,
      ruleKey: INVITATION_ACCESS_RULE_CODE,
      windowMs,
      loadCount: async () => {
        const violationModel = this.prisma.violation as unknown as {
          count?: (args: {
            where: {
              chatId: string;
              userId: string;
              ruleCode: string;
              createdAt: { gte: Date; lte: Date };
            };
          }) => Promise<number>;
        };

        if (typeof violationModel.count !== 'function') {
          return 1;
        }

        const since = await this.resolveViolationResetSince(chatId, userId, windowMs);
        const count = await violationModel.count({
          where: {
            chatId,
            userId,
            ruleCode: INVITATION_ACCESS_RULE_CODE,
            createdAt: { gte: since, lte: new Date(Date.now()) },
          },
        });

        return Number.isInteger(count) && count > 0 ? count : 1;
      },
    });
  }

  private async countRecentTextFilterViolations(
    chatId: string,
    userId: string,
    ruleCode: string,
    context: { messageId?: string | null; updateType?: string | null } = {},
  ): Promise<number> {
    const windowMs = TEXT_FILTER_ESCALATION_WINDOW_HOURS * 60 * 60 * 1000;
    const ruleCodeFilter =
      ruleCode === 'PROFANITY' || ruleCode === 'COMMERCIAL_AD'
        ? ruleCode
        : { in: ['PROFANITY', 'COMMERCIAL_AD'] };
    const ruleKey =
      typeof ruleCodeFilter === 'string' ? ruleCodeFilter : ruleCodeFilter.in.join('|');
    return this.countRecentViolationsWithEscalationCounter({
      chatId,
      userId,
      ruleKey,
      windowMs,
      messageId: context.messageId,
      updateType: context.updateType,
      loadCount: async () => {
        const violationModel = this.prisma.violation as unknown as {
          count?: (args: { where: Record<string, unknown> }) => Promise<number>;
        };

        if (typeof violationModel.count !== 'function') {
          return 1;
        }

        const since = await this.resolveViolationResetSince(chatId, userId, windowMs);
        const count = await violationModel.count({
          where: {
            chatId,
            userId,
            ruleCode: ruleCodeFilter,
            ...(ruleCode === 'PROFANITY'
              ? { score: { gte: PROFANITY_AUTOMATIC_ESCALATION_MIN_SCORE } }
              : {}),
            createdAt: { gte: since, lte: new Date(Date.now()) },
          },
        });

        return Number.isInteger(count) && count > 0 ? count : 1;
      },
    });
  }

  private async countRecentMessageLimitsViolations(
    chatId: string,
    userId: string,
    ruleCode: string,
    context: { messageId?: string | null; updateType?: string | null } = {},
  ): Promise<number> {
    const windowMs = MESSAGE_LIMITS_ESCALATION_WINDOW_HOURS * 60 * 60 * 1000;
    return this.countRecentViolationsWithEscalationCounter({
      chatId,
      userId,
      ruleKey: ruleCode,
      windowMs,
      messageId: context.messageId,
      updateType: context.updateType,
      loadCount: async () => {
        const violationModel = this.prisma.violation as unknown as {
          count?: (args: {
            where: {
              chatId: string;
              userId: string;
              ruleCode: string;
              createdAt: { gte: Date; lte: Date };
            };
          }) => Promise<number>;
        };

        if (typeof violationModel.count !== 'function') {
          return 1;
        }

        const since = await this.resolveViolationResetSince(chatId, userId, windowMs);
        const count = await violationModel.count({
          where: {
            chatId,
            userId,
            ruleCode,
            createdAt: { gte: since, lte: new Date(Date.now()) },
          },
        });

        return Number.isInteger(count) && count > 0 ? count : 1;
      },
    });
  }

  private async resolveViolationResetSince(
    chatId: string,
    userId: string,
    windowMs: number,
  ): Promise<Date> {
    const baseSince = new Date(Date.now() - windowMs);
    const latestManualRelease = await this.resolveLatestManualReleaseCreatedAt(chatId, userId);

    if (latestManualRelease && latestManualRelease.getTime() > baseSince.getTime()) {
      return latestManualRelease;
    }

    return baseSince;
  }

  private async resolveLatestManualReleaseCreatedAt(
    chatId: string,
    userId: string,
  ): Promise<Date | null> {
    const latestManualRelease = await this.prisma.moderationEvent.findFirst({
      where: {
        chatId,
        userId,
        createdAt: { lte: new Date(Date.now()) },
        ruleCode: {
          in: ['MANUAL_UNMUTE', 'MANUAL_UNBAN'],
        },
      },
      orderBy: {
        createdAt: 'desc',
      },
      select: {
        createdAt: true,
      },
    });

    return latestManualRelease?.createdAt ?? null;
  }

  private isWithinWindowFromDate(createdAt: Date, windowSec: number): boolean {
    if (!Number.isFinite(windowSec) || windowSec <= 0) {
      return false;
    }

    return createdAt.getTime() + windowSec * 1000 > Date.now();
  }

  private async getActiveMute(
    chatId: string,
    userId: string,
    fallbackMuteDurationHours: number,
    options?: { bypassCache?: boolean },
  ): Promise<ActiveMute | null> {
    const cachedState = options?.bypassCache
      ? { status: 'unknown' as const }
      : await this.readCachedActiveMute(chatId, userId);
    if (cachedState.status === 'active') {
      return cachedState.mute;
    }
    if (cachedState.status === 'inactive') {
      return null;
    }

    const now = new Date(Date.now());
    const [latestSanctionEvent, latestManualLiftEvent] = await Promise.all([
      this.prisma.moderationEvent.findFirst({
        where: {
          chatId,
          userId,
          createdAt: { lte: now },
          action: {
            in: [SanctionAction.MUTE, SanctionAction.BAN],
          },
        },
        orderBy: options?.bypassCache
          ? [{ createdAt: 'desc' }, { id: 'desc' }]
          : {
              createdAt: 'desc',
            },
        select: {
          id: true,
          createdAt: true,
          metadata: true,
          action: true,
          ruleCode: true,
        },
      }),
      this.prisma.moderationEvent.findFirst({
        where: {
          chatId,
          userId,
          createdAt: { lte: now },
          ruleCode: {
            in: ['MANUAL_UNMUTE', 'MANUAL_UNBAN'],
          },
        },
        orderBy: options?.bypassCache
          ? [{ createdAt: 'desc' }, { id: 'desc' }]
          : {
              createdAt: 'desc',
            },
        select: {
          createdAt: true,
        },
      }),
    ]);

    if (!latestSanctionEvent) {
      await this.rememberInactiveActiveMuteState(chatId, userId);
      return null;
    }

    if (
      options?.bypassCache &&
      (await this.moderationSanctionStateFenceService.isSanctionEventInvalidated({
        chatId,
        userId,
        sanctionEventId: latestSanctionEvent.id,
        eventCreatedAt: latestSanctionEvent.createdAt,
      }))
    ) {
      await this.rememberInactiveActiveMuteState(chatId, userId);
      return null;
    }

    if (
      latestManualLiftEvent &&
      (options?.bypassCache
        ? latestManualLiftEvent.createdAt.getTime() >= latestSanctionEvent.createdAt.getTime()
        : latestManualLiftEvent.createdAt.getTime() > latestSanctionEvent.createdAt.getTime())
    ) {
      await this.rememberInactiveActiveMuteState(chatId, userId);
      return null;
    }

    const latestAction = latestSanctionEvent.action ?? SanctionAction.BAN;
    const expiry = resolveModerationSanctionExpiry(
      latestAction,
      latestSanctionEvent.metadata,
      latestSanctionEvent.createdAt,
      fallbackMuteDurationHours,
    );
    const isPermanentMute = expiry.permanent;
    const storedDurationHours = this.readStoredMuteDurationHoursFromMetadata(
      latestSanctionEvent.metadata,
    );
    if (latestAction === SanctionAction.MUTE && isPermanentMute) {
      const activeMute = {
        eventId: latestSanctionEvent.id,
        issuedAt: latestSanctionEvent.createdAt,
        expiresAt: null,
        durationHours: null,
        permanent: true,
        ruleCode: latestSanctionEvent.ruleCode ?? null,
      };
      await this.rememberActiveMuteState(chatId, userId, activeMute);
      return activeMute;
    }

    const isTimedMute =
      latestAction === SanctionAction.MUTE ||
      (latestAction === SanctionAction.BAN && storedDurationHours !== null);

    if (!isTimedMute) {
      await this.rememberInactiveActiveMuteState(chatId, userId);
      return null;
    }

    const durationHours = storedDurationHours ?? fallbackMuteDurationHours;
    const expiresAt = expiry.expiresAt;
    if (!expiresAt || expiresAt.getTime() <= Date.now()) {
      await this.rememberInactiveActiveMuteState(chatId, userId);
      return null;
    }

    const activeMute = {
      eventId: latestSanctionEvent.id,
      issuedAt: latestSanctionEvent.createdAt,
      expiresAt,
      durationHours,
      permanent: false,
      ruleCode: latestSanctionEvent.ruleCode ?? null,
    };
    await this.rememberActiveMuteState(chatId, userId, activeMute);
    return activeMute;
  }

  private async handleFreshHeldCommand(update: MaxUpdate, webhookEventId: string): Promise<void> {
    const proof = await this.legacyHolds!.readFreshCommandReceipt(webhookEventId, update);
    if (!proof || proof.deadlineAt.getTime() <= Date.now() || proof.kind === 'START') return;
    const botId =
      this.readExecutionOwnerBotId(update) ?? this.maxBotContextService?.getActiveBotId();
    if (!botId || !(await verifyFreshHeldCommandAccess(this.maxClient, proof, botId))) return;
    const settings = await this.prisma.chatSettings.findUnique({ where: { chatId: proof.chatId } });
    if (!settings || proof.deadlineAt.getTime() <= Date.now()) return;
    await this.handleAdminForwardedModerationCommand({
      update,
      chatId: proof.chatId,
      senderId: proof.userId,
      messageId: proof.messageId,
      settings,
      ...(update.message?.chatTitle !== undefined ? { chatTitle: update.message.chatTitle } : {}),
      ...(update.message?.senderName !== undefined
        ? { senderName: update.message.senderName }
        : {}),
    });
  }

  private async handleAdminForwardedModerationCommand(params: {
    update: MaxUpdate;
    chatId: string;
    chatTitle?: string;
    senderId: string;
    senderName?: string;
    messageId: string;
    settings: ChatSettings;
    superBanOnly?: boolean;
  }): Promise<boolean> {
    if (
      !recognizesAdminForwardedModerationCommand(
        params.update,
        params.settings,
        params.superBanOnly,
      )
    )
      return false;
    const authority =
      this.injectedGroupCommandAuthority ?? new GroupCommandAuthorityService(this.prisma);
    const botId =
      this.readExecutionOwnerBotId(params.update) ??
      this.maxBotContextService?.getActiveBotId() ??
      params.update.botId ??
      (
        await this.maxBotLinkService?.resolveBotRoute({
          purpose: 'send_message',
          chatId: params.chatId,
          fallbackToPrimary: true,
        })
      )?.botId;
    if (!botId) throw new Error('Group command has no proven bot route');
    return runGroupCommandWithAuthority(authority, params.update, botId, {
      resume: async (permit) => {
        if (permit.result?.noticeText)
          await deliverGroupCommandNotice({
            max: this.maxClient,
            settings: params.settings,
            permit,
            authority,
          });
      },
      execute: (permit) =>
        this.handleOwnedAdminForwardedModerationCommand({ ...params, permit, authority }),
    });
  }

  private async handleOwnedAdminForwardedModerationCommand(params: {
    update: MaxUpdate;
    chatId: string;
    chatTitle?: string;
    senderId: string;
    senderName?: string;
    messageId: string;
    settings: ChatSettings;
    superBanOnly?: boolean;
    permit: GroupCommandPermit;
    authority: GroupCommandAuthorityService;
  }): Promise<boolean> {
    const { update, chatId, chatTitle, senderId, senderName, messageId, settings, superBanOnly } =
      params;
    if (update.type !== 'message_created') {
      return false;
    }
    const commandBotId = params.permit.executionBotId;
    if (!(await params.authority.isFreshHeldCommandAccessAllowed(params.permit, this.maxClient)))
      return true;
    const sendNotice = (notice: { chatId: string; settings: ChatSettings; text: string }) =>
      deliverGroupCommandNotice({
        max: this.maxClient,
        settings: notice.settings,
        text: notice.text,
        permit: params.permit,
        authority: params.authority,
      });
    const directText = extractDirectIncomingMessageText(update);
    let command: AdminForwardedModerationCommand | null;
    try {
      command = parseAdminForwardedModerationCommand(directText, settings);
    } catch (error: unknown) {
      await sendNotice({
        chatId,
        settings,
        text: this.extractGroupAdminCommandErrorMessage(error),
      });
      return true;
    }
    if (!command) {
      return false;
    }
    if (superBanOnly === true && command.action !== 'SUPER_BAN') {
      return false;
    }

    const actor: AuthUser = {
      userId: senderId,
      username: null,
      displayName: senderName?.trim() || null,
      chatId,
      chatTitle: chatTitle?.trim() || null,
    };
    const manualBridge = this.manualModerationCommandBridge;
    if (!manualBridge) {
      this.logger.warn(
        {
          chatId,
          actorUserId: senderId,
          action: command.action,
        },
        'Admin forwarded command ignored: manual moderation service is unavailable',
      );
      return false;
    }

    if (command.action === 'SUPER_BAN' && !manualBridge.isSuperBanDeveloperUserId(senderId)) {
      await sendNotice({
        chatId,
        settings,
        text: 'Недостаточно прав: команду `супер бан` может запускать только разработчик бота.',
      });
      return true;
    }

    if (command.action === 'RULES') {
      const rulesCommandHelpText = `\`${getAdminCommandName(
        settings.adminRulesCommandName,
        ADMIN_RULES_COMMAND_NAME_DEFAULT,
      )}\``;
      const sources = extractForwardedRulesSources(update);
      if (sources.length === 0) {
        return false;
      }

      const uniqueSources = dedupeForwardedRulesSources(sources);
      if (uniqueSources.length !== 1) {
        await sendNotice({
          chatId,
          settings,
          text: `Перешлите или ответьте на одно сообщение из этого чата и добавьте команду ${rulesCommandHelpText}.`,
        });
        return true;
      }

      const sourceMessage = uniqueSources[0];
      if (sourceMessage.chatId !== chatId) {
        await sendNotice({
          chatId,
          settings,
          text: `Команда ${rulesCommandHelpText} работает только для сообщений из этого чата.`,
        });
        return true;
      }

      try {
        const adopted = await manualBridge.adoptChatRulesFromMessage(
          chatId,
          actor,
          {
            sourceMessageId: sourceMessage.messageId,
            sourceMessageUrl: sourceMessage.url,
            text: sourceMessage.text,
          },
          'group_command',
          params.permit,
        );

        if (adopted?.commandSkipped) return true;
        if (!(await this.legacyHolds?.isUpdateHeld(update)))
          await this.deleteAdminCommandMessage(
            chatId,
            messageId,
            update.message?.createdAt ?? null,
          );
        await sendNotice({
          chatId,
          settings,
          text: 'Правила привязаны к этому сообщению. Кнопка «Правила» в нарушениях включена.',
        });
      } catch (error: unknown) {
        if (error instanceof GroupCommandNoticeDeliveryError) throw error;
        this.logger.warn(
          {
            chatId,
            actorUserId: senderId,
            sourceMessageId: sourceMessage.messageId,
            error: error instanceof Error ? error.message : 'Unknown error',
          },
          'Failed to adopt forwarded chat rules message',
        );

        await sendNotice({
          chatId,
          settings,
          text: `Не удалось сохранить правила: ${this.escapeMaxMarkdownText(
            this.extractGroupAdminCommandErrorMessage(error),
          )}`,
        });
      }

      return true;
    }

    if (command.action === 'SILENCE' || command.action === 'OPEN_CHAT') {
      try {
        const result =
          command.action === 'SILENCE'
            ? await manualBridge.applyManualChatSilenceCommand(
                chatId,
                actor,
                {
                  durationHours: command.silenceDurationHours,
                },
                'group_command',
                params.permit,
              )
            : await manualBridge.applyManualOpenChatCommand(
                chatId,
                actor,
                'group_command',
                params.permit,
              );

        if (result.skipped) return true;
        if (!(await this.legacyHolds?.isUpdateHeld(update)))
          await this.deleteAdminCommandMessage(
            chatId,
            messageId,
            update.message?.createdAt ?? null,
          );
        await sendNotice({
          chatId,
          settings,
          text: result.message,
        });
      } catch (error: unknown) {
        if (error instanceof GroupCommandNoticeDeliveryError) throw error;
        this.logger.warn(
          {
            chatId,
            actorUserId: senderId,
            action: command.action,
            error: error instanceof Error ? error.message : 'Unknown error',
          },
          'Failed to apply manual chat silence command',
        );

        await sendNotice({
          chatId,
          settings,
          text: `Команда не выполнена: ${this.escapeMaxMarkdownText(
            this.extractGroupAdminCommandErrorMessage(error),
          )}`,
        });
      }

      return true;
    }

    const targets = extractForwardedModerationTargets(update, chatId);
    const commandHelpText =
      command.action === 'SUPER_BAN'
        ? '`супер бан`'
        : command.action === 'MUTE'
          ? command.fanoutAllChats === true
            ? '`Мут!`'
            : `\`${getAdminCommandName(
                command.mutePermanent
                  ? settings.adminPermanentMuteCommandName
                  : settings.adminMuteCommandName,
                command.mutePermanent
                  ? ADMIN_PERMANENT_MUTE_COMMAND_NAME_DEFAULT
                  : ADMIN_MUTE_COMMAND_NAME_DEFAULT,
              )}\``
          : `\`${getAdminCommandName(
              command.fanoutAllChats
                ? settings.adminBanAllCommandName
                : settings.adminBanCommandName,
              command.fanoutAllChats
                ? ADMIN_BAN_ALL_COMMAND_NAME_DEFAULT
                : ADMIN_BAN_COMMAND_NAME_DEFAULT,
            )}\``;
    if (targets.length === 0) {
      await sendNotice({
        chatId,
        settings,
        text: `Нужна цель: ответьте на сообщение из этого чата командой ${commandHelpText} или перешлите одно сообщение и добавьте команду.`,
      });
      return true;
    }

    const uniqueTargets = dedupeForwardedModerationTargets(targets);
    if (uniqueTargets.length !== 1) {
      await sendNotice({
        chatId,
        settings,
        text: `Для команды ${commandHelpText} выберите одно сообщение: ответьте на него или перешлите только его.`,
      });
      return true;
    }

    const target = uniqueTargets[0];
    if (target.chatId !== chatId) {
      await sendNotice({
        chatId,
        settings,
        text: `Команда ${commandHelpText} применима только к участнику этого чата. Выберите сообщение отсюда.`,
      });
      return true;
    }

    let queued = false;
    try {
      queued =
        command.action === 'SUPER_BAN'
          ? await manualBridge.enqueueDeveloperSuperBanCommand({
              sourceChatId: chatId,
              commandBotId,
              targetUserId: target.userId,
              targetSenderName: target.senderName ?? null,
              targetMessageId: target.messageId ?? null,
              commandMessageId: messageId,
              actor,
              deleteBotMessagesEnabled: settings.deleteBotMessagesEnabled,
              deleteBotMessagesDelayMinutes: settings.deleteBotMessagesDelayMinutes,
            })
          : await manualBridge.enqueueManualGroupModerationCommand({
              sourceChatId: chatId,
              commandBotId,
              targetUserId: target.userId,
              targetSenderName: target.senderName ?? null,
              targetMessageId: target.messageId ?? null,
              commandMessageId: messageId,
              actor,
              action: command.action,
              ...(command.action === 'BAN'
                ? { fanoutAllChats: command.fanoutAllChats === true }
                : {}),
              ...(command.action === 'MUTE'
                ? {
                    fanoutAllChats: command.fanoutAllChats === true,
                    ...(command.mutePermanent
                      ? { mutePermanent: true }
                      : { muteDurationHours: command.muteDurationHours }),
                  }
                : {}),
              deleteBotMessagesEnabled: settings.deleteBotMessagesEnabled,
              deleteBotMessagesDelayMinutes: settings.deleteBotMessagesDelayMinutes,
            });
      if (!queued) {
        this.logger.warn(
          {
            chatId,
            actorUserId: senderId,
            targetUserId: target.userId,
            action: command.action,
          },
          'Failed to enqueue forwarded admin moderation command',
        );
        await sendNotice({
          chatId,
          settings,
          text:
            command.action === 'SUPER_BAN'
              ? 'Команда `супер бан` не запущена. Повторите через несколько секунд.'
              : 'Команда не запущена. Повторите через несколько секунд.',
        });
      }
    } catch (error: unknown) {
      if (error instanceof GroupCommandNoticeDeliveryError) throw error;
      this.logger.warn(
        {
          chatId,
          actorUserId: senderId,
          targetUserId: target.userId,
          error: error instanceof Error ? error.message : 'Unknown error',
        },
        'Failed to enqueue forwarded admin moderation command',
      );

      if (command.action === 'SUPER_BAN') {
        await sendNotice({
          chatId,
          settings,
          text: `Команда \`супер бан\` не запущена: ${this.escapeMaxMarkdownText(
            this.extractGroupAdminCommandErrorMessage(error),
          )}`,
        });
      }

      return true;
    }
    if (queued) await params.authority.prepareQueuedResult(params.permit, command.action);
    return true;
  }

  private async deleteAdminCommandMessage(
    chatId: string,
    messageId: string,
    sourceMessageAt: string | null,
  ): Promise<void> {
    try {
      await this.executeModerationDelete({
        chatId,
        messageId,
        reasonKey: 'ADMIN_COMMAND_CLEANUP',
        ruleCode: 'ADMIN_COMMAND_CLEANUP',
        sourceMessageAt,
        entityType: 'CHAT',
        messageAuthorKind: 'user',
      });
    } catch (error: unknown) {
      this.logger.debug(
        {
          chatId,
          messageId,
          error: error instanceof Error ? error.message : 'Unknown error',
        },
        'Failed to delete handled admin command message',
      );
    }
  }

  private extractGroupAdminCommandErrorMessage(error: unknown): string {
    if (error instanceof BadRequestException || error instanceof ForbiddenException) {
      const response = error.getResponse();
      if (typeof response === 'string' && response.trim().length > 0) {
        const normalized = response.trim();
        return normalized.length <= 1_000 && /[А-Яа-яЁё]/u.test(normalized)
          ? normalized
          : 'Попробуйте ещё раз через несколько секунд.';
      }

      if (response && typeof response === 'object') {
        const message = (response as { message?: unknown }).message;
        if (typeof message === 'string' && message.trim().length > 0) {
          const normalized = message.trim();
          return normalized.length <= 1_000 && /[А-Яа-яЁё]/u.test(normalized)
            ? normalized
            : 'Попробуйте ещё раз через несколько секунд.';
        }
      }
    }
    return 'Попробуйте ещё раз через несколько секунд.';
  }

  private async handleActiveMuteMessage(params: ActiveMuteMessageInput) {
    const { chatId, userId, messageId, text, mute } = params;
    const deleteIntent = buildActiveMuteDeleteIntent(params);
    await this.ensureModerationDeleteIntent(deleteIntent);

    const claimed = await this.claimMessageScopedModerationAction({
      chatId,
      userId,
      messageId,
      ruleCode: 'MUTE_ACTIVE_DELETE',
    });
    if (!claimed) {
      return;
    }

    try {
      const deleteResult = await this.executeModerationDelete(deleteIntent);
      if (deleteResult.deleted && !deleteResult.eventPersistedByIntent) {
        await this.createBotModerationEvent({
          data: {
            chatId,
            userId,
            messageId,
            eventType: EventType.MESSAGE,
            ruleCode: 'MUTE_ACTIVE_DELETE',
            action: SanctionAction.DELETE_MESSAGE,
            maskedExcerpt: maskText(text),
            score: 1,
            operator: Operator.BOT,
            metadata: {
              reason: 'Message removed during active mute window',
              muteEventId: mute.eventId,
              muteIssuedAt: mute.issuedAt.toISOString(),
              mutePermanent: mute.permanent,
              ...(mute.expiresAt ? { muteExpiresAt: mute.expiresAt.toISOString() } : {}),
              ...(mute.durationHours !== null ? { muteDurationHours: mute.durationHours } : {}),
            },
          },
        });
      }
    } catch (error: unknown) {
      this.logger.warn(
        {
          chatId,
          userId,
          messageId,
          error: error instanceof Error ? error.message : 'Unknown error',
        },
        'Failed to delete message during active mute',
      );
    }
  }

  private async handleBotMessage(params: {
    chatId: string;
    userId: string;
    messageId: string;
    text: string;
    createdAt: string;
  }) {
    const { chatId, userId, messageId, text, createdAt } = params;
    if (this.isKnownRuntimeBotUserId(userId)) {
      this.logger.debug(
        {
          chatId,
          userId,
          messageId,
        },
        'Skipped bot-account moderation for configured MAX bot user',
      );
      return;
    }

    const deleteIntent: EnsureModerationDeleteIntentInput = {
      chatId,
      messageId,
      reasonKey: 'BOT_ACCOUNT_MESSAGE_DELETE',
      ruleCode: 'BOT_ACCOUNT_MESSAGE_DELETE',
      subjectUserId: userId,
      sourceMessageAt: createdAt,
      entityType: 'CHAT',
      messageAuthorKind: 'bot',
      originBotId:
        this.maxBotLinkService?.resolveBotIdFromUserId(userId) ??
        this.maxBotContextService?.getActiveBotId() ??
        null,
      routingPolicy: 'origin_only',
      event: { userId, eventType: null, metadata: { botAccountAuthorVerified: true } },
    };
    await this.ensureModerationDeleteIntent(deleteIntent);

    const claimed = await this.claimMessageScopedModerationAction({
      chatId,
      userId,
      messageId,
      ruleCode: 'BOT_ACCOUNT_KICK',
    });
    if (!claimed) {
      return;
    }

    try {
      await this.executeModerationDelete(deleteIntent);
    } catch (error: unknown) {
      this.logger.warn(
        {
          chatId,
          userId,
          messageId,
          error: error instanceof Error ? error.message : 'Unknown error',
        },
        'Failed to delete bot-authored message before kick',
      );
    }

    try {
      if (
        await this.kickMemberImmediately(
          chatId,
          userId,
          createBotAccountKickOptions(
            this.moderationStateDeleteGuard,
            () => this.maxBotContextService?.getActiveBotId() ?? undefined,
            { chatId, userId, messageId, createdAt },
          ),
        )
      ) {
        await this.createBotModerationEvent({
          data: {
            chatId,
            userId,
            messageId,
            eventType: EventType.MEMBER_ACTION,
            ruleCode: 'BOT_ACCOUNT_KICK',
            action: SanctionAction.KICK,
            maskedExcerpt: maskText(text),
            score: 0.7,
            operator: Operator.BOT,
            metadata: {
              reason: 'Bot account removed because bot accounts are disallowed by chat settings',
            },
          },
        });
      }
    } catch (error: unknown) {
      this.logger.warn(
        {
          chatId,
          userId,
          messageId,
          error: error instanceof Error ? error.message : 'Unknown error',
        },
        'Failed to kick bot-authored account',
      );
    }
  }

  private async handleBotMessageAutoDelete(params: {
    chatId: string;
    userId: string;
    messageId: string;
    text: string;
    createdAt: string;
    delayMinutes: number;
    raw?: unknown;
  }) {
    const { chatId, userId, messageId, text, createdAt, delayMinutes } = params;
    const originalSourceAt = legacyBotCleanupSourceAt(params);
    // FLAG: The notice's own webhook may arrive after sealing. Its new delivery
    // clock cannot authorize cleanup of an old or unattributed original SEND.
    if (await this.legacyHolds?.isLegacyChatSendHeld(chatId, originalSourceAt ?? new Date(NaN)))
      return;
    const safeDelayMinutes = normalizeDeleteBotMessagesDelayMinutes(delayMinutes);
    const delayMs = safeDelayMinutes * 60 * 1000;
    const deleteOptions = { delayMs };
    const deleteIntent: EnsureModerationDeleteIntentInput = {
      chatId,
      messageId,
      reasonKey: 'BOT_MESSAGE_AUTO_DELETE',
      ruleCode: 'BOT_MESSAGE_AUTO_DELETE',
      subjectUserId: userId,
      sourceMessageAt: originalSourceAt ?? createdAt,
      entityType: 'CHAT',
      messageAuthorKind: 'bot',
      originBotId:
        this.maxBotLinkService?.resolveBotIdFromUserId(userId) ??
        this.maxBotContextService?.getActiveBotId() ??
        null,
      routingPolicy: 'origin_only',
      executeAt: new Date(Date.now() + delayMs),
      event: {
        userId,
        eventType: 'MESSAGE',
        maskedExcerpt: maskText(text),
        score: 0.5,
        metadata: {
          reason: 'Bot-authored message deleted after configured delay',
          delayMinutes: safeDelayMinutes,
          ...(originalSourceAt
            ? {
                botMessageOriginalCreatedAt: originalSourceAt.toISOString(),
                botMessageOriginalCreatedAtSource: 'max_message_timestamp_v1',
              }
            : {}),
        },
      },
    };
    await this.ensureModerationDeleteIntent(deleteIntent, deleteOptions);

    const claimed = await this.claimMessageScopedModerationAction({
      chatId,
      userId,
      messageId,
      ruleCode: 'BOT_MESSAGE_AUTO_DELETE',
    });
    if (!claimed) {
      return;
    }

    try {
      const deleteResult = await this.executeModerationDelete(deleteIntent, deleteOptions);
      if (!deleteResult.accepted) {
        return;
      }
      if (deleteResult.deleted && !deleteResult.eventPersistedByIntent) {
        await this.createBotModerationEvent({
          data: {
            chatId,
            userId,
            messageId,
            eventType: EventType.MESSAGE,
            ruleCode: 'BOT_MESSAGE_AUTO_DELETE',
            action: SanctionAction.DELETE_MESSAGE,
            maskedExcerpt: maskText(text),
            score: 0.5,
            operator: Operator.BOT,
            metadata: {
              reason: 'Bot-authored message deleted after configured delay',
              delayMinutes: safeDelayMinutes,
            },
          },
        });
      }
    } catch (error: unknown) {
      this.logger.warn(
        {
          chatId,
          userId,
          messageId,
          delayMinutes: safeDelayMinutes,
          error: error instanceof Error ? error.message : 'Unknown error',
        },
        'Failed to schedule bot-authored message auto-delete',
      );
    }
  }

  private async handleOwnBotMessageAutoDelete(params: {
    chatId: string;
    userId: string;
    messageId: string;
    text: string;
    createdAt: string;
    settings: ChatSettings;
    raw?: unknown;
  }) {
    const { chatId, userId, messageId, text, createdAt, settings, raw } = params;

    // FLAG: Counter ownership survives disabled admission and delayed mirrored webhooks.
    if (
      await this.reportSubmission?.ownsCounter(
        chatId,
        messageId,
        text,
        this.maxBotContextService?.getActiveBotId() ?? '',
        raw,
      )
    )
      return;

    if (!settings.deleteBotMessagesEnabled) {
      return;
    }

    const skipReason = await this.resolveOwnBotAutoDeleteSkipReason({
      chatId,
      userId,
      messageId,
      text,
      createdAt,
      settings,
      raw,
    });
    if (skipReason) {
      this.logger.debug(
        {
          chatId,
          messageId,
          skipReason,
        },
        'Skipped auto-delete for own bot message',
      );
      return;
    }

    if (await this.sendSideOwnBotAutoDeleteAlreadyOwned(chatId, messageId)) {
      this.logger.debug(
        {
          chatId,
          messageId,
        },
        'Skipped duplicate webhook auto-delete for sent bot message',
      );
      return;
    }

    await this.handleBotMessageAutoDelete({
      chatId,
      userId,
      messageId,
      text,
      createdAt,
      delayMinutes: settings.deleteBotMessagesDelayMinutes,
      raw,
    });
  }

  private async sendSideOwnBotAutoDeleteAlreadyOwned(
    chatId: string,
    messageId: string,
  ): Promise<boolean> {
    if (
      !this.moderationDeleteIntentService ||
      this.moderationDeleteIntentService.getRolloutForChat(chatId) !== 'execute' ||
      !this.maxActionLedgerService
    ) {
      return false;
    }

    try {
      return await this.maxActionLedgerService.hasSucceededDelete(chatId, messageId);
    } catch (error: unknown) {
      this.logger.warn(
        {
          chatId,
          messageId,
          error: error instanceof Error ? error.message : 'Unknown error',
        },
        'Failed to verify send-side bot auto-delete ownership; keeping durable webhook cleanup',
      );
      return false;
    }
  }

  private async resolveOwnBotAutoDeleteSkipReason(params: {
    chatId: string;
    userId: string;
    messageId: string;
    text: string;
    createdAt: string;
    settings: ChatSettings;
    raw?: unknown;
  }) {
    if (isManagedHandshakeConfirmationText(params.text)) {
      const owner = await findManagedHandshakeAutoDeleteOwner(this.prisma.maxActionLedgerEntry, {
        chatId: params.chatId,
        messageId: params.messageId,
        originBotId:
          this.maxBotLinkService?.resolveBotIdFromUserId(params.userId) ??
          this.maxBotContextService?.getActiveBotId(),
        sourceMessageAt: params.createdAt,
        allowInFlight: true,
      });
      if (owner) return owner.kind;
    }

    const rulesSkipReason = await rulesFence.classify(this.prisma.chatRules, params);
    if (rulesSkipReason) return rulesSkipReason;

    if (
      this.isNightModeNoticeMessage({
        text: params.text,
        settings: params.settings,
      })
    ) {
      return 'night_mode_notice';
    }

    const protectedEventSkipReason = await protectedEventFence.classify(
      this.prisma.moderationEvent,
      params,
    );
    if (protectedEventSkipReason) return protectedEventSkipReason;

    if (
      isKaravanStorefrontRelayCompanionText(params.text) ||
      this.karavanStorefrontRelayService?.isCompanionMessageCandidate?.(params.text, params.raw)
    ) {
      if (
        this.karavanStorefrontRelayService &&
        (await this.karavanStorefrontRelayService.recognizeCompanionMessage({
          chatId: params.chatId,
          messageId: params.messageId,
          text: params.text,
          raw: params.raw,
        }))
      ) {
        return 'karavan_storefront_relay';
      }

      const storefrontRelayAudit = await this.prisma.auditLog?.findFirst?.({
        where: {
          chatId: params.chatId,
          action: KARAVAN_STOREFRONT_RELAY_AUDIT_ACTION,
          payload: {
            path: ['companionMessageId'],
            equals: params.messageId,
          },
        },
        select: {
          id: true,
        },
      });
      if (storefrontRelayAudit) {
        return 'karavan_storefront_relay';
      }
    }

    const managedBroadcastDelivery = await this.prisma.managedBroadcastDelivery?.findFirst?.({
      where: {
        targetChatId: params.chatId,
        remoteMessageId: params.messageId,
      },
      select: {
        id: true,
      },
    });
    if (managedBroadcastDelivery) {
      return 'managed_broadcast';
    }

    const originBotId =
      this.maxBotLinkService?.resolveBotIdFromUserId(params.userId) ??
      this.maxBotContextService?.getActiveBotId() ??
      null;
    if (originBotId) {
      // FLAG: A managed publication webhook can beat persistence of its remote message id.
      // Recheck the exact id in the fallback query so state transitions have no protection gap.
      const managedBroadcastSendFence = await this.prisma.managedBroadcastDelivery?.findFirst?.({
        where: buildManagedPublicationAutoDeleteFenceWhere({
          targetChatId: params.chatId,
          messageId: params.messageId,
          originBotId,
          entityType: ChatEntityType.CHAT,
          sourceMessageAt: params.createdAt,
        }),
        select: {
          id: true,
          remoteMessageId: true,
        },
      });
      if (managedBroadcastSendFence) {
        return managedBroadcastSendFence.remoteMessageId === params.messageId
          ? 'managed_broadcast'
          : 'managed_broadcast_in_flight';
      }
    }

    const chatAutoCommentAttachMarker = await this.prisma.chatAutoCommentAttachMarker?.findFirst?.({
      where: {
        chatId: params.chatId,
        OR: [{ replacementMessageId: params.messageId }, { replyMessageId: params.messageId }],
      },
      select: {
        id: true,
      },
    });
    if (chatAutoCommentAttachMarker) {
      return 'chat_auto_comment_replacement';
    }

    return null;
  }

  private async handleServiceBotEvent(params: {
    chatId: string;
    messageId: string;
    text: string;
    update: MaxUpdate;
  }): Promise<string[]> {
    const { chatId, messageId, text, update } = params;
    const botUserIds = this.extractBotUserIdsFromServiceEvent(update);
    const kickedUserIds = new Set<string>();

    for (const userId of botUserIds) {
      if (this.isKnownRuntimeBotUserId(userId)) {
        continue;
      }

      const claimed = await this.claimServiceMemberActionDelivery({
        chatId,
        userId,
        update,
        ruleCode: 'BOT_ACCOUNT_KICK',
      });
      if (!claimed) {
        continue;
      }

      try {
        if (await this.kickMemberImmediately(chatId, userId)) {
          kickedUserIds.add(userId);
          await this.createBotModerationEvent({
            data: {
              chatId,
              userId,
              messageId,
              eventType: EventType.MEMBER_ACTION,
              ruleCode: 'BOT_ACCOUNT_KICK',
              action: SanctionAction.KICK,
              maskedExcerpt: maskText(text),
              score: 0.7,
              operator: Operator.BOT,
              metadata: {
                reason:
                  'Bot account removed from service event because bot accounts are disallowed by chat settings',
              },
            },
          });
        }
      } catch (error: unknown) {
        this.logger.warn(
          {
            chatId,
            userId,
            messageId,
            error: error instanceof Error ? error.message : 'Unknown error',
          },
          'Failed to kick bot account detected in service message',
        );
      }
    }

    return [...kickedUserIds];
  }

  private async claimServiceMemberActionDelivery(params: {
    chatId: string;
    userId: string;
    update: MaxUpdate;
    ruleCode: string;
    updateType?: string | null;
    dedupeWindowMs?: number;
    eventScopedDedupe?: boolean;
  }): Promise<boolean> {
    const updateType =
      params.updateType ??
      (this.resolveServiceMemberActionUserIds(params.update).length > 0
        ? 'service_member'
        : this.readLowerString(params.update.type)) ??
      'service_member';
    const eventIdentity =
      params.eventScopedDedupe === false
        ? null
        : this.resolveServiceMemberActionEventIdentity(params.update);
    const windowClaim = await this.claimServiceMemberActionWindow({
      chatId: params.chatId,
      userId: params.userId,
      ruleCode: params.ruleCode,
      updateType,
      dedupeWindowMs: params.dedupeWindowMs ?? SERVICE_MEMBER_ACTION_DEDUPE_WINDOW_MS,
      eventIdentity,
    });
    if (windowClaim === false) {
      return false;
    }

    return this.claimMessageViolationProcessing({
      chatId: params.chatId,
      userId: params.userId,
      messageId: this.buildServiceMemberActionClaimMessageId(params, eventIdentity),
      ruleCode: params.ruleCode,
      updateType,
    });
  }

  private async claimServiceMemberActionWindow(params: {
    chatId: string;
    userId: string;
    ruleCode: string;
    updateType: string;
    dedupeWindowMs: number;
    eventIdentity: string | null;
  }): Promise<boolean | null> {
    if (!Number.isFinite(params.dedupeWindowMs) || params.dedupeWindowMs <= 0) {
      return null;
    }

    const incrementOncePerMemberWithTtl = (
      this.redisCounter as Partial<RedisCounterService> | undefined
    )?.incrementOncePerMemberWithTtl;
    if (!this.redisCounter || !incrementOncePerMemberWithTtl) {
      return null;
    }

    const semanticHash = createHash('sha256')
      .update(
        [
          params.chatId,
          params.userId,
          params.ruleCode,
          params.updateType,
          params.eventIdentity ?? 'member-window',
        ].join(':'),
      )
      .digest('hex')
      .slice(0, 32);
    const counterKey = `moderation:service-member-action-window:v1:${params.ruleCode}:${params.updateType}`;
    const memberKey = `${counterKey}:${semanticHash}`;
    const ttlSec = Math.max(1, Math.ceil(params.dedupeWindowMs / 1_000));

    try {
      const result = await incrementOncePerMemberWithTtl.call(
        this.redisCounter,
        counterKey,
        memberKey,
        ttlSec,
      );
      if (!result.inserted) {
        this.logger.debug(
          {
            chatId: params.chatId,
            userId: params.userId,
            ruleCode: params.ruleCode,
            updateType: params.updateType,
          },
          'Skipped duplicate service member action within dedupe window',
        );
      }
      return result.inserted;
    } catch (error: unknown) {
      this.logger.debug(
        {
          chatId: params.chatId,
          userId: params.userId,
          ruleCode: params.ruleCode,
          updateType: params.updateType,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to claim Redis service member action dedupe window',
      );
      return null;
    }
  }

  private resolveServiceMemberActionUserIds(update: MaxUpdate): string[] {
    const userIds = new Set<string>();
    for (const userId of update.membership?.memberUserIds ?? []) {
      const normalized = userId.trim();
      if (normalized) {
        userIds.add(normalized);
      }
    }
    for (const userId of this.extractServiceMemberUserIds(update)) {
      userIds.add(userId);
    }
    return [...userIds].sort();
  }

  private buildServiceMemberActionClaimMessageId(
    params: {
      chatId: string;
      userId: string;
      update: MaxUpdate;
      ruleCode: string;
    },
    eventIdentity: string | null,
  ): string {
    const eventAtIso = this.resolveServiceMemberActionEventIso(params.update);
    const semanticHash = createHash('sha256')
      .update(`${params.chatId}:${params.userId}:${params.ruleCode}:${eventIdentity ?? eventAtIso}`)
      .digest('hex')
      .slice(0, 32);
    return eventIdentity
      ? `service-member:${semanticHash}:update`
      : `service-member:${semanticHash}:${eventAtIso}`;
  }

  private resolveServiceMemberActionEventIdentity(update: MaxUpdate): string | null {
    if (this.readLowerString(update.eventTimestampSource) === 'ingress') {
      return null;
    }

    const timestampMs = this.resolveServiceMemberActionTimestampMs(update);
    return `event-at:${new Date(timestampMs).toISOString()}`;
  }

  private resolveServiceMemberActionEventIso(update: MaxUpdate): string {
    const timestampMs = this.resolveServiceMemberActionTimestampMs(update);
    return new Date(
      Math.floor(timestampMs / SERVICE_MEMBER_ACTION_TIMESTAMP_GRANULARITY_MS) *
        SERVICE_MEMBER_ACTION_TIMESTAMP_GRANULARITY_MS,
    ).toISOString();
  }

  private resolveServiceMemberActionTimestampMs(update: MaxUpdate): number {
    const raw = this.asRecord(update.raw);
    const rawMessage = this.asRecord(raw?.message);
    const data = this.asRecord(raw?.data);
    const dataMessage = this.asRecord(data?.message);
    const event = this.asRecord(raw?.event);
    const eventMessage = this.asRecord(event?.message);
    const candidates = [
      update.message?.createdAt,
      rawMessage?.timestamp,
      rawMessage?.created_at,
      rawMessage?.createdAt,
      dataMessage?.timestamp,
      dataMessage?.created_at,
      dataMessage?.createdAt,
      eventMessage?.timestamp,
      eventMessage?.created_at,
      eventMessage?.createdAt,
      raw?.timestamp,
      raw?.created_at,
      raw?.createdAt,
      data?.timestamp,
      data?.created_at,
      data?.createdAt,
      event?.timestamp,
      event?.created_at,
      event?.createdAt,
    ];

    for (const candidate of candidates) {
      const timestampMs = this.parseServiceMemberActionTimestampMs(candidate);
      if (timestampMs !== null) {
        return timestampMs;
      }
    }

    return Date.now();
  }

  private parseServiceMemberActionTimestampMs(value: unknown): number | null {
    const parsed =
      value instanceof Date
        ? value.getTime()
        : typeof value === 'number'
          ? value
          : typeof value === 'string' && value.trim().length > 0
            ? Date.parse(value)
            : Number.NaN;
    if (!Number.isFinite(parsed) || parsed <= 0) {
      return null;
    }

    const timestampMs = parsed < 10_000_000_000 ? parsed * 1000 : parsed;
    return Math.trunc(timestampMs);
  }

  private async handleServiceGreetingEvent(params: {
    chatId: string;
    messageId: string;
    update: MaxUpdate;
    greetingBotMessageEnabled: boolean;
    greetingDeleteBotMessageEnabled: boolean;
    greetingDeleteBotMessageDelayMinutes: number;
    greetingBotMessageText: string;
    botSpeechStyle: BotSpeechStyle | null;
    botSpeechMedia: ChatSettings['botSpeechMedia'];
    greetingBotButtons: unknown;
    greetingBotButtonEnabled: boolean;
    greetingBotButtonUrl: string;
    greetingBotButtonText: string;
    greetingRulesButtonEnabled: boolean;
    rulesPublishedUrl: string | null;
    rulesPublishedMessageId: string | null;
    deleteBotMessagesEnabled: boolean;
    deleteBotMessagesDelayMinutes: number;
    excludedUserIds: ReadonlySet<string>;
  }) {
    const {
      chatId,
      messageId,
      update,
      greetingBotMessageEnabled,
      greetingDeleteBotMessageEnabled,
      greetingDeleteBotMessageDelayMinutes,
      greetingBotMessageText,
      botSpeechStyle,
      botSpeechMedia,
      greetingBotButtons,
      greetingBotButtonEnabled,
      greetingBotButtonUrl,
      greetingBotButtonText,
      greetingRulesButtonEnabled,
      rulesPublishedUrl,
      rulesPublishedMessageId,
      deleteBotMessagesEnabled,
      deleteBotMessagesDelayMinutes,
      excludedUserIds,
    } = params;

    if (!greetingBotMessageEnabled) {
      return;
    }

    const joinedMembers = this.extractHumanServiceMembers(update).filter(
      (member) => !excludedUserIds.has(member.userId),
    );
    if (joinedMembers.length === 0) {
      return;
    }

    const greetingMessageOptions = this.buildBotMessageOptions(
      chatId,
      greetingBotButtons,
      greetingBotButtonEnabled,
      greetingBotButtonUrl,
      greetingBotButtonText,
      greetingRulesButtonEnabled,
      rulesPublishedUrl,
      rulesPublishedMessageId,
    );

    for (const member of joinedMembers) {
      if (
        !(await this.claimServiceMemberActionDelivery({
          chatId,
          userId: member.userId,
          update,
          ruleCode: 'GREETING_MESSAGE',
          updateType: 'user_added',
          dedupeWindowMs: GREETING_MESSAGE_DEDUPE_WINDOW_MS,
          eventScopedDedupe: false,
        }))
      ) {
        continue;
      }

      const greetingMessage = this.buildGreetingMessage(
        member.userLabel,
        greetingBotMessageText,
        botSpeechStyle,
      );
      const shouldDeleteGreetingMessage =
        greetingDeleteBotMessageEnabled || deleteBotMessagesEnabled;
      const greetingDeleteDelayMinutes = greetingDeleteBotMessageEnabled
        ? greetingDeleteBotMessageDelayMinutes
        : deleteBotMessagesDelayMinutes;
      try {
        await this.sendBotMessageWithOptionalAutoDelete({
          chatId,
          text: greetingMessage,
          messageOptions: withMarketplaceModerationMessage(
            greetingMessageOptions,
            chatId,
            'GREETING',
          ),
          media: this.resolveBotSpeechMedia({ botSpeechMedia }, 'greetingBotMessageText'),
          deleteBotMessagesEnabled: shouldDeleteGreetingMessage,
          deleteBotMessagesDelayMinutes: greetingDeleteDelayMinutes,
          bypassNoticeBucket: true,
        });
        await this.createBotModerationEvent({
          data: {
            chatId,
            userId: member.userId,
            messageId,
            eventType: EventType.SYSTEM,
            ruleCode: 'GREETING_MESSAGE',
            action: SanctionAction.NONE,
            maskedExcerpt: null,
            score: 0.2,
            operator: Operator.BOT,
            metadata: {
              reason: 'Greeting message accepted for delivery',
              deliveryStatus: 'accepted_for_delivery',
            },
          },
        });
      } catch (error: unknown) {
        this.logger.warn(
          {
            chatId,
            userId: member.userId,
            messageId,
            error: error instanceof Error ? error.message : 'Unknown error',
          },
          'Failed to send greeting message',
        );
      }
    }
  }

  private async handleServiceMembershipUpdate(params: {
    chatId: string;
    messageId: string;
    text: string;
    update: MaxUpdate;
    settings: ChatSettings;
    adminUserIds: string[];
    rulesPublishedUrl: string | null;
    rulesPublishedMessageId: string | null;
  }): Promise<void> {
    const {
      chatId,
      messageId,
      text,
      update,
      settings,
      adminUserIds,
      rulesPublishedUrl,
      rulesPublishedMessageId,
    } = params;

    const excludedGreetingUserIds = new Set<string>();

    if (settings.deleteSpammersEnabled) {
      const kickedUserIds = await this.handleServiceKnownSpammerMembersEvent({
        chatId,
        adminUserIds,
        messageId,
        text,
        update,
      });
      for (const userId of kickedUserIds) {
        excludedGreetingUserIds.add(userId);
      }
    }

    if (settings.removeBotsFromGroupEnabled) {
      const kickedUserIds = await this.handleServiceBotEvent({
        chatId,
        messageId,
        text,
        update,
      });
      for (const userId of kickedUserIds) {
        excludedGreetingUserIds.add(userId);
      }
    }

    await this.handleInvitationAccessMembershipUpdate({
      chatId,
      messageId,
      update,
      settings,
    });

    if (resolveEffectiveChatClosure(settings).closed) {
      return;
    }

    if (!settings.greetingEnabled) {
      return;
    }

    await this.handleServiceGreetingEvent({
      chatId,
      messageId,
      update,
      greetingBotMessageEnabled: settings.greetingBotMessageEnabled,
      greetingDeleteBotMessageEnabled: settings.greetingDeleteBotMessageEnabled,
      greetingDeleteBotMessageDelayMinutes: settings.greetingDeleteBotMessageDelayMinutes,
      greetingBotMessageText: settings.greetingBotMessageText,
      botSpeechStyle: settings.botSpeechStyle,
      botSpeechMedia: settings.botSpeechMedia,
      greetingBotButtons: settings.greetingBotButtons,
      greetingBotButtonEnabled: settings.greetingBotButtonEnabled,
      greetingBotButtonUrl: settings.greetingBotButtonUrl,
      greetingBotButtonText: settings.greetingBotButtonText,
      greetingRulesButtonEnabled: settings.greetingRulesButtonEnabled,
      rulesPublishedUrl,
      rulesPublishedMessageId,
      deleteBotMessagesEnabled: settings.deleteBotMessagesEnabled,
      deleteBotMessagesDelayMinutes: settings.deleteBotMessagesDelayMinutes,
      excludedUserIds: excludedGreetingUserIds,
    });
  }

  private extractHumanServiceMembers(
    update: MaxUpdate,
  ): Array<{ userId: string; userLabel: string }> {
    const memberRows = this.extractServiceMemberRows(update);
    const members = new Map<string, { userId: string; userLabel: string }>();

    for (const row of memberRows) {
      const userId = this.readUserIdFromEntity(row);
      if (!userId || this.isBotEntity(row) || members.has(userId)) {
        continue;
      }

      const userLabel = this.formatUserLabel(
        this.readDisplayNameFromEntity(row) ?? undefined,
        userId,
      );
      members.set(userId, { userId, userLabel });
    }

    return [...members.values()];
  }

  private readDisplayNameFromEntity(node: Record<string, unknown>): string | null {
    return resolveMaxUserDisplayName(node) ?? this.readString(node.username);
  }

  private buildGreetingMessage(
    userLabel: string,
    templateText: string,
    botSpeechStyle: BotSpeechStyle | null,
  ): string {
    return this.renderEditableBotSpeechTemplate({
      style: botSpeechStyle,
      fieldKey: 'greetingBotMessageText',
      overrideText: templateText,
      replacements: {
        user: userLabel,
        greeting: 'добро пожаловать в чат',
      },
    });
  }

  private async handleKnownSpammerSenderMessage(params: {
    chatId: string;
    userId: string;
    messageId: string;
    text: string;
    createdAt: string;
  }): Promise<boolean> {
    const { chatId, userId, messageId, text, createdAt } = params;
    if (this.isKnownRuntimeBotUserId(userId)) {
      return false;
    }

    const isKnownSpammer = await this.isUserKnownGlobalSpammer(userId, {
      chatId,
      messageId,
      trigger: 'message',
    });
    if (!isKnownSpammer) {
      return false;
    }

    const deleteIntent: EnsureModerationDeleteIntentInput = {
      chatId,
      messageId,
      reasonKey: 'GLOBAL_SPAMMER:known-message-delete',
      ruleCode: 'GLOBAL_SPAMMER_MESSAGE_DELETE',
      subjectUserId: userId,
      sourceMessageAt: createdAt,
      entityType: 'CHAT',
      messageAuthorKind: 'user',
      event: {
        userId,
        eventType: null,
        metadata: { reason: 'Sender exists in global spammer registry' },
      },
    };
    await this.ensureModerationDeleteIntent(deleteIntent);

    const deleteAccepted = await this.attemptSpammerMessageDelete(deleteIntent);
    const claimed = await this.claimMessageScopedModerationAction({
      chatId,
      userId,
      messageId,
      ruleCode: 'GLOBAL_SPAMMER_KICK',
    });
    if (!claimed) {
      return deleteAccepted;
    }

    await this.kickAndLogKnownSpammerEvent({
      chatId,
      userId,
      messageId,
      text,
      reason: 'Sender exists in global spammer registry',
      claimAlreadyAcquired: true,
    });
    return deleteAccepted;
  }

  private async attemptSpammerMessageDelete(
    input: EnsureModerationDeleteIntentInput,
  ): Promise<boolean> {
    // FLAG: A sanction claim or a successful kick is not proof of message removal.
    // Retry deletion independently; only confirmed removal or durable acceptance handles it.
    try {
      const result = await this.executeModerationDelete(input);
      return result.accepted;
    } catch (error: unknown) {
      this.logger.warn(
        {
          chatId: input.chatId,
          userId: input.subjectUserId,
          messageId: input.messageId,
          ruleCode: input.ruleCode,
          error: error instanceof Error ? error.message : 'Unknown error',
        },
        'Spammer message deletion failed; continuing independent message moderation',
      );
      return false;
    }
  }

  private async handleLocalAdminBlockedSenderMessage(params: {
    chatId: string;
    userId: string;
    messageId: string;
    text: string;
    createdAt: string;
  }): Promise<boolean> {
    const { chatId, userId, messageId, text, createdAt } = params;
    if (this.isKnownRuntimeBotUserId(userId)) {
      return false;
    }

    const deleteIntent: EnsureModerationDeleteIntentInput = {
      chatId,
      messageId,
      reasonKey: 'LOCAL_ADMIN_BLOCK:message-delete',
      ruleCode: 'LOCAL_ADMIN_BLOCK_MESSAGE_DELETE',
      subjectUserId: userId,
      sourceMessageAt: createdAt,
      entityType: 'CHAT',
      messageAuthorKind: 'user',
      event: {
        userId,
        eventType: null,
        metadata: { reason: 'Local admin block for this admin scope' },
      },
    };
    await this.ensureModerationDeleteIntent(deleteIntent);

    const deleteAccepted = await this.attemptSpammerMessageDelete(deleteIntent);
    const claimed = await this.claimMessageScopedModerationAction({
      chatId,
      userId,
      messageId,
      ruleCode: 'LOCAL_ADMIN_BLOCK',
    });
    if (!claimed) {
      return deleteAccepted;
    }

    await this.kickAndLogKnownSpammerEvent({
      chatId,
      userId,
      messageId,
      text,
      reason: 'Local admin block for this admin scope',
      ruleCode: 'LOCAL_ADMIN_BLOCK',
      claimAlreadyAcquired: true,
    });
    return deleteAccepted;
  }

  private async handleServiceKnownSpammerMembersEvent(params: {
    chatId: string;
    adminUserIds: string[];
    messageId: string;
    text: string;
    update: MaxUpdate;
  }): Promise<string[]> {
    const { chatId, adminUserIds, messageId, text, update } = params;
    const serviceMemberUserIds = this.extractServiceMemberUserIds(update);
    if (serviceMemberUserIds.length === 0) {
      return [];
    }

    const localAdminDecisions = await this.resolveGlobalSpammerAdminDecisions(
      serviceMemberUserIds,
      adminUserIds,
      {
        chatId,
      },
    );
    const kickedUserIds: string[] = [];
    for (const userId of serviceMemberUserIds) {
      if (this.isKnownRuntimeBotUserId(userId)) {
        continue;
      }
      if (localAdminDecisions.get(userId) !== 'BLOCK') {
        continue;
      }
      const claimed = await this.claimServiceMemberActionDelivery({
        chatId,
        userId,
        update,
        ruleCode: 'LOCAL_ADMIN_BLOCK',
      });
      if (!claimed) {
        kickedUserIds.push(userId);
        continue;
      }
      const enforced = await this.kickAndLogKnownSpammerEvent({
        chatId,
        userId,
        messageId,
        text,
        reason: 'Member joined via service event and has a local admin block',
        ruleCode: 'LOCAL_ADMIN_BLOCK',
        claimAlreadyAcquired: true,
      });
      if (enforced) {
        kickedUserIds.push(userId);
      }
    }

    const rows = await this.prisma.globalSpammer.findMany({
      where: {
        userId: {
          in: serviceMemberUserIds,
        },
        expiresAt: {
          gt: new Date(),
        },
      },
      select: {
        userId: true,
      },
    });
    if (rows.length === 0) {
      return kickedUserIds;
    }

    for (const row of rows) {
      if (this.isKnownRuntimeBotUserId(row.userId)) {
        continue;
      }
      if (kickedUserIds.includes(row.userId)) {
        continue;
      }
      const adminExempt = localAdminDecisions.get(row.userId) === 'ALLOW';
      const claimed = await this.claimServiceMemberActionDelivery({
        chatId,
        userId: row.userId,
        update,
        ruleCode: 'GLOBAL_SPAMMER_KICK',
      });
      if (!claimed) {
        kickedUserIds.push(row.userId);
        continue;
      }
      if (this.globalSpammerIntelligence) {
        const decision = await this.globalSpammerIntelligence.evaluatePolicy({
          chatId,
          userId: row.userId,
          messageId,
          trigger: 'member_join',
          deleteSpammersEnabled: true,
          adminExempt,
          recordDecision: true,
        });
        if (decision.action !== 'DELETE_AND_KICK') {
          continue;
        }
      } else if (adminExempt) {
        continue;
      }
      const enforced = await this.kickAndLogKnownSpammerEvent({
        chatId,
        userId: row.userId,
        messageId,
        text,
        reason: 'Member joined via service event and exists in global spammer registry',
        ruleCode: 'GLOBAL_SPAMMER_KICK',
        claimAlreadyAcquired: true,
      });
      if (enforced) {
        kickedUserIds.push(row.userId);
      }
    }

    return kickedUserIds;
  }

  private async kickAndLogKnownSpammerEvent(params: {
    chatId: string;
    userId: string;
    messageId: string;
    text: string;
    reason: string;
    ruleCode?: string;
    claimAlreadyAcquired?: boolean;
  }): Promise<boolean> {
    const {
      chatId,
      userId,
      messageId,
      text,
      reason,
      ruleCode = 'GLOBAL_SPAMMER_KICK',
      claimAlreadyAcquired = false,
    } = params;
    if (this.isKnownRuntimeBotUserId(userId)) {
      return false;
    }

    if (
      (await this.isLegacyModerationHeld(chatId, userId, messageId)) ||
      (await this.legacyHolds?.isGlobalUserHeld(userId))
    )
      return false;

    if (!claimAlreadyAcquired) {
      const claimed = await this.claimMessageScopedModerationAction({
        chatId,
        userId,
        messageId,
        ruleCode,
      });
      if (!claimed) {
        return true;
      }
    }

    try {
      if (
        await this.kickMemberImmediately(
          chatId,
          userId,
          createSpammerKickOptions(
            this.moderationStateDeleteGuard,
            () => this.maxBotContextService?.getActiveBotId() ?? undefined,
            { chatId, userId, messageId, localBlock: ruleCode === 'LOCAL_ADMIN_BLOCK' },
          ),
        )
      ) {
        await this.createBotModerationEvent({
          data: {
            chatId,
            userId,
            messageId,
            eventType: EventType.MEMBER_ACTION,
            ruleCode,
            action: SanctionAction.KICK,
            maskedExcerpt: maskText(text),
            score: 0.95,
            operator: Operator.BOT,
            metadata: {
              reason,
            },
          },
        });
        return true;
      }
    } catch (error: unknown) {
      this.logger.warn(
        {
          chatId,
          userId,
          messageId,
          error: error instanceof Error ? error.message : 'Unknown error',
        },
        'Failed to kick known global spammer',
      );
    }
    return false;
  }

  private async trackAndRegisterGlobalSpammer(params: {
    chatId: string;
    userId: string;
    messageId: string;
    text: string;
    createdAt: string;
    deleteSpammersEnabled: boolean;
    exemptFromEnforcement: boolean;
    allowDestructiveSideEffects?: () => boolean;
  }): Promise<GlobalSpammerTrackingResult> {
    const baseResult: GlobalSpammerTrackingResult = {
      handled: false,
      skipKnownSpammerCheck: false,
    };
    if (!this.redisCounter) {
      return baseResult;
    }
    if (await this.legacyHolds?.isGlobalUserHeld(params.userId)) return baseResult;

    const {
      chatId,
      userId,
      messageId,
      deleteSpammersEnabled,
      exemptFromEnforcement,
      allowDestructiveSideEffects,
    } = params;
    if (this.isKnownRuntimeBotUserId(userId)) {
      return baseResult;
    }

    if (this.hasRecentLocalGlobalSpammerChatObservation(chatId, userId)) {
      return baseResult;
    }

    try {
      const uniqueChatsState = await this.redisCounter.addToSetWithTtl(
        this.buildGlobalSpammerAnyRedisKey(userId),
        chatId,
        GLOBAL_SPAMMER_REDIS_TTL_SEC,
      );
      this.markLocalGlobalSpammerChatObservation(chatId, userId);

      if (!uniqueChatsState.added) {
        return baseResult;
      }

      if (uniqueChatsState.size >= GLOBAL_SPAMMER_HIGH_FANOUT_MIN_CHATS) {
        const episodeLockKey = this.buildGlobalSpammerFanoutEpisodeLockRedisKey(userId);
        const lockState = await this.redisCounter.addToSetWithTtl(
          episodeLockKey,
          'active',
          GLOBAL_SPAMMER_EPISODE_LOCK_TTL_SEC,
        );
        if (!lockState.added && uniqueChatsState.size < GLOBAL_SPAMMER_CRITICAL_FANOUT_MIN_CHATS) {
          return baseResult;
        }

        const episodeCounterKey = this.buildGlobalSpammerFanoutEpisodeRedisKey(userId);
        const fanoutEpisodeCount = lockState.added
          ? await this.redisCounter.incrementWithTtl(
              episodeCounterKey,
              GLOBAL_SPAMMER_FANOUT_EPISODE_WINDOW_SEC,
            )
          : await this.readGlobalSpammerFanoutEpisodeCount(episodeCounterKey);
        const fanoutReason = this.resolveGlobalSpammerFanoutEpisodeReason({
          uniqueChats: uniqueChatsState.size,
          fanoutEpisodeCount,
        });
        await this.upsertGlobalSpammerEntry({
          userId,
          sourceChatId: chatId,
          reason: fanoutReason,
          evidence: {
            uniqueChats: uniqueChatsState.size,
            windowSec: GLOBAL_SPAMMER_WINDOW_SEC,
            fanoutEpisodeCount,
            fanoutEpisodeWindowSec: GLOBAL_SPAMMER_FANOUT_EPISODE_WINDOW_SEC,
          },
        });
        const shouldCheckKnownSpammer =
          fanoutReason === 'FANOUT_EPISODE_CONFIRMED' || fanoutReason === 'FANOUT_EPISODE_CRITICAL';
        if (
          deleteSpammersEnabled &&
          !exemptFromEnforcement &&
          shouldCheckKnownSpammer &&
          (!this.globalSpammerIntelligence ||
            (await this.isUserKnownGlobalSpammer(userId, { chatId, messageId, trigger: 'fanout' })))
        ) {
          if (allowDestructiveSideEffects && !allowDestructiveSideEffects()) {
            void this.runtimeDiagnosticsService?.recordHotPathStageOutcome({
              stage: 'global-spammer-track.side-effect.skipped-after-timeout',
              outcome: 'skip',
              failOpen: true,
            });
            this.logger.debug(
              {
                chatId,
                userId,
                messageId,
              },
              'Skipped detected global spammer destructive side effect after hot-path budget expired',
            );
            return {
              handled: false,
              skipKnownSpammerCheck: true,
            };
          }

          return {
            handled: false,
            skipKnownSpammerCheck: true,
            enforcementReady: true,
          };
        }

        return {
          handled: false,
          skipKnownSpammerCheck: deleteSpammersEnabled && shouldCheckKnownSpammer,
        };
      }

      return {
        handled: false,
        skipKnownSpammerCheck: false,
      };
    } catch (error: unknown) {
      this.logger.warn(
        {
          chatId,
          userId,
          error: error instanceof Error ? error.message : 'Unknown error',
        },
        'Failed to track global spammer state',
      );
      return baseResult;
    }
  }

  private async trackAndRegisterGlobalSpammerWithHotPathBudget(params: {
    chatId: string;
    userId: string;
    messageId: string;
    text: string;
    createdAt: string;
    deleteSpammersEnabled: boolean;
    exemptFromEnforcement: boolean;
  }): Promise<GlobalSpammerTrackingResult> {
    let timedOut = false;
    const result = await raceWithTimeout<GlobalSpammerTrackingResult>({
      operation: () =>
        this.trackAndRegisterGlobalSpammer({
          ...params,
          allowDestructiveSideEffects: () => !timedOut,
        }),
      timeoutMs: GLOBAL_SPAMMER_TRACK_HOT_PATH_TIMEOUT_MS,
      onTimeout: () => {
        timedOut = true;
        return {
          handled: false,
          skipKnownSpammerCheck: false,
        };
      },
    });
    if (timedOut) {
      void this.runtimeDiagnosticsService?.recordHotPathStageOutcome({
        stage: 'global-spammer-track.budget',
        outcome: 'timeout',
        failOpen: true,
      });
      this.logger.debug(
        {
          chatId: params.chatId,
          userId: params.userId,
          messageId: params.messageId,
          timeoutMs: GLOBAL_SPAMMER_TRACK_HOT_PATH_TIMEOUT_MS,
        },
        'Global spammer tracking exceeded hot-path budget; continuing fail-open',
      );
    }

    // FLAG: Only observation/policy work may outlive the tracking budget. Enforcement
    // stays awaited by the webhook so persistence failures reach queue recovery.
    if (result.enforcementReady) {
      const handled = await this.deleteAndKickDetectedGlobalSpammer({
        ...params,
        reason: 'Detected in 6 unique chats within 2 minutes',
      });
      return { handled, skipKnownSpammerCheck: true };
    }
    return result;
  }

  private async resolveGlobalSpammerAdminDecisionsWithHotPathBudget(
    userIds: readonly string[],
    adminUserIds: readonly string[] | undefined,
    options: {
      chatId?: string;
      userId?: string | null;
      messageId?: string | null;
    } = {},
  ): Promise<Map<string, LocalGlobalSpammerAdminDecision>> {
    const normalizedAdminUserIds = Array.isArray(adminUserIds)
      ? [...new Set(adminUserIds.map((item) => item.trim()).filter(Boolean))].sort()
      : [];
    const cachedDecisions = new Map<string, LocalGlobalSpammerAdminDecision>();
    if (normalizedAdminUserIds.length > 0) {
      const cacheScopeKey = this.buildGlobalSpammerExemptionCacheScopeKey(
        options.chatId ?? null,
        normalizedAdminUserIds,
      );
      for (const rawUserId of userIds) {
        const userId = rawUserId.trim();
        if (!userId) {
          continue;
        }
        const cached = this.readGlobalSpammerExemptionCache(cacheScopeKey, userId);
        if (cached) {
          cachedDecisions.set(userId, cached);
        }
      }
    }
    if (normalizedAdminUserIds.length > GLOBAL_SPAMMER_EXEMPTION_HOT_PATH_MAX_ADMIN_IDS) {
      void this.runtimeDiagnosticsService?.recordHotPathStageOutcome({
        stage: 'global-spammer-exempt.budget',
        outcome: 'skip',
        failOpen: true,
      });
      this.logger.debug(
        {
          chatId: options.chatId ?? null,
          userId: options.userId ?? null,
          messageId: options.messageId ?? null,
          adminCount: normalizedAdminUserIds.length,
          maxAdminCount: GLOBAL_SPAMMER_EXEMPTION_HOT_PATH_MAX_ADMIN_IDS,
        },
        'Skipped global spammer admin exemption lookup because the admin roster is too large for the hot path',
      );
      return cachedDecisions;
    }

    let timedOut = false;
    const result = await raceWithTimeout({
      operation: () =>
        this.resolveGlobalSpammerAdminDecisions(userIds, adminUserIds, {
          chatId: options.chatId,
        }),
      timeoutMs: GLOBAL_SPAMMER_EXEMPTION_HOT_PATH_TIMEOUT_MS,
      onTimeout: () => {
        timedOut = true;
        return cachedDecisions;
      },
    });
    if (timedOut) {
      void this.runtimeDiagnosticsService?.recordHotPathStageOutcome({
        stage: 'global-spammer-exempt.budget',
        outcome: 'timeout',
        failOpen: true,
      });
      this.logger.debug(
        {
          chatId: options.chatId ?? null,
          userId: options.userId ?? null,
          messageId: options.messageId ?? null,
          timeoutMs: GLOBAL_SPAMMER_EXEMPTION_HOT_PATH_TIMEOUT_MS,
        },
        'Global spammer admin exemption lookup exceeded hot-path budget; continuing fail-open',
      );
    }

    return result;
  }

  private runGlobalSpammerSideEffect(
    context: Record<string, unknown>,
    operation: () => Promise<void>,
  ): void {
    void operation().catch((error: unknown) => {
      this.logger.warn(
        {
          ...context,
          error: error instanceof Error ? error.message : 'Unknown error',
        },
        'Global spammer background side effect failed',
      );
    });
  }

  private async deleteAndKickDetectedGlobalSpammer(params: {
    chatId: string;
    userId: string;
    messageId: string;
    text: string;
    createdAt: string;
    reason: string;
  }): Promise<boolean> {
    const { chatId, userId, messageId, text, createdAt, reason } = params;
    if (await this.legacyHolds?.isGlobalUserHeld(userId)) return false;
    if (this.isKnownRuntimeBotUserId(userId)) {
      return false;
    }

    const deleteIntent: EnsureModerationDeleteIntentInput = {
      chatId,
      messageId,
      reasonKey: 'GLOBAL_SPAMMER:detected-message-delete',
      ruleCode: 'GLOBAL_SPAMMER_MESSAGE_DELETE',
      subjectUserId: userId,
      sourceMessageAt: createdAt,
      entityType: 'CHAT',
      messageAuthorKind: 'user',
      event: {
        userId,
        eventType: null,
        metadata: { reason },
      },
    };
    await this.ensureModerationDeleteIntent(deleteIntent);

    const deleteAccepted = await this.attemptSpammerMessageDelete(deleteIntent);
    const claimed = await this.claimMessageScopedModerationAction({
      chatId,
      userId,
      messageId,
      ruleCode: 'GLOBAL_SPAMMER_KICK',
    });
    if (!claimed) {
      return deleteAccepted;
    }

    await this.kickAndLogKnownSpammerEvent({
      chatId,
      userId,
      messageId,
      text,
      reason,
      claimAlreadyAcquired: true,
    });
    return deleteAccepted;
  }

  private buildGlobalSpammerSignature(params: {
    text: string;
    update: MaxUpdate;
    mediaFlags: {
      hasPhotoAttachment: boolean;
      hasVideoAttachment: boolean;
      hasFileAttachment: boolean;
      hasVoiceAttachment: boolean;
    };
  }): { kind: 'text' | 'photo' | 'forwarded'; hash: string } | null {
    const { text, update, mediaFlags } = params;
    const normalizedText = this.normalizeSpamText(text);
    const rawRecord = this.asRecord(update.raw);
    const messageNode = rawRecord ? (extractRawMessageNode(rawRecord) ?? rawRecord) : null;
    const forwardedNodes = messageNode ? collectForwardedNodes(messageNode) : [];

    if (forwardedNodes.length > 0) {
      const forwardedTokens = new Set<string>();
      for (const node of forwardedNodes) {
        this.collectSignatureTokens(node, forwardedTokens, {
          mediaOnly: false,
        });
      }
      if (normalizedText.length > 0) {
        forwardedTokens.add(`message_text:${normalizedText}`);
      }
      const hash = this.hashSpamSignature(forwardedTokens);
      if (hash) {
        return { kind: 'forwarded', hash };
      }
    }

    if (mediaFlags.hasPhotoAttachment && messageNode) {
      const photoTokens = new Set<string>();
      this.collectSignatureTokens(messageNode, photoTokens, {
        mediaOnly: true,
      });
      if (normalizedText.length > 0) {
        photoTokens.add(`caption:${normalizedText}`);
      }
      const hash = this.hashSpamSignature(photoTokens);
      if (hash) {
        return { kind: 'photo', hash };
      }
    }

    if (normalizedText.length === 0) {
      return null;
    }

    return {
      kind: 'text',
      hash: createHash('sha256').update(normalizedText).digest('hex').slice(0, 24),
    };
  }

  private hashSpamSignature(tokens: Set<string>): string | null {
    if (tokens.size === 0) {
      return null;
    }

    const normalized = [...tokens]
      .map((value) => value.trim())
      .filter((value) => value.length > 0)
      .sort();
    if (normalized.length === 0) {
      return null;
    }

    return createHash('sha256').update(normalized.join('\n')).digest('hex').slice(0, 24);
  }

  private normalizeSpamText(value: string): string {
    return value.replace(/\s+/g, ' ').trim().toLowerCase();
  }

  private collectSignatureTokens(
    node: unknown,
    tokens: Set<string>,
    options: {
      mediaOnly: boolean;
    },
    depth = 0,
    mediaContext = false,
  ) {
    if (
      depth > MAX_FORWARD_SCAN_DEPTH ||
      node === null ||
      node === undefined ||
      tokens.size >= 120
    ) {
      return;
    }

    if (Array.isArray(node)) {
      for (const item of node) {
        this.collectSignatureTokens(item, tokens, options, depth + 1, mediaContext);
        if (tokens.size >= 120) {
          return;
        }
      }
      return;
    }

    if (typeof node === 'string' || typeof node === 'number' || typeof node === 'boolean') {
      if (options.mediaOnly && !mediaContext) {
        return;
      }
      const normalizedValue = this.normalizeSignatureValue(String(node));
      if (!normalizedValue) {
        return;
      }
      tokens.add(`value:${normalizedValue}`);
      return;
    }

    if (typeof node !== 'object') {
      return;
    }

    const row = node as Record<string, unknown>;
    for (const [key, value] of Object.entries(row)) {
      const keyLower = key.toLowerCase();
      const nextMediaContext = mediaContext || this.isStableMediaSignatureKey(keyLower);

      if (value && (typeof value === 'object' || Array.isArray(value))) {
        this.collectSignatureTokens(value, tokens, options, depth + 1, nextMediaContext);
        if (tokens.size >= 120) {
          return;
        }
        continue;
      }

      if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
        continue;
      }

      if (this.shouldSkipSignatureKey(keyLower, nextMediaContext)) {
        continue;
      }

      if (options.mediaOnly && !nextMediaContext) {
        continue;
      }

      const normalizedValue = this.normalizeSignatureValue(String(value));
      if (!normalizedValue) {
        continue;
      }

      tokens.add(`${keyLower}:${normalizedValue}`);
      if (tokens.size >= 120) {
        return;
      }
    }
  }

  private normalizeSignatureValue(value: string): string {
    const normalized = value.replace(/\s+/g, ' ').trim().toLowerCase();
    if (!normalized) {
      return '';
    }

    if (normalized.startsWith('http://') || normalized.startsWith('https://')) {
      try {
        const parsed = new URL(normalized);
        parsed.search = '';
        parsed.hash = '';
        const safeUrl = parsed.toString();
        return safeUrl.slice(0, 512);
      } catch {
        return normalized.slice(0, 512);
      }
    }

    return normalized.slice(0, 512);
  }

  private shouldSkipSignatureKey(key: string, mediaContext: boolean): boolean {
    if (CROSS_CHAT_SPAM_ALWAYS_IGNORED_KEYS.has(key)) {
      return true;
    }

    if ((key === 'id' || key.endsWith('_id')) && !mediaContext) {
      return true;
    }

    return false;
  }

  private isStableMediaSignatureKey(key: string): boolean {
    return (
      key.includes('photo') ||
      key.includes('image') ||
      key.includes('picture') ||
      key.includes('sticker') ||
      key.includes('attachment') ||
      key.includes('media') ||
      key.includes('file') ||
      key.includes('video') ||
      key.includes('voice') ||
      key.includes('audio') ||
      key.includes('url') ||
      key.includes('uri') ||
      key.includes('token') ||
      key.includes('hash') ||
      key.includes('checksum') ||
      key.includes('mime') ||
      key.includes('payload')
    );
  }

  private buildGlobalSpammerSignatureRedisKey(
    userId: string,
    signature: { kind: 'text' | 'photo' | 'forwarded'; hash: string },
  ): string {
    return `global-spammer:sig:v1:${userId}:${signature.kind}:${signature.hash}`;
  }

  private buildGlobalSpammerAnyRedisKey(userId: string): string {
    return `global-spammer:any:v1:${userId}`;
  }

  private buildGlobalSpammerFanoutEpisodeRedisKey(userId: string): string {
    return `global-spammer:fanout-episodes:v2:${userId}`;
  }

  private buildGlobalSpammerFanoutEpisodeLockRedisKey(userId: string): string {
    return `global-spammer:fanout-episode-lock:v2:${userId}`;
  }

  private async readGlobalSpammerFanoutEpisodeCount(key: string): Promise<number> {
    const getString = (this.redisCounter as Partial<RedisCounterService> | undefined)?.getString;
    if (!getString || !this.redisCounter) {
      return 1;
    }
    const raw = await getString.call(this.redisCounter, key);
    const parsed = Number.parseInt(raw ?? '', 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
  }

  private resolveGlobalSpammerFanoutEpisodeReason(params: {
    uniqueChats: number;
    fanoutEpisodeCount: number;
  }): string {
    if (params.uniqueChats >= GLOBAL_SPAMMER_CRITICAL_FANOUT_MIN_CHATS) {
      return 'FANOUT_EPISODE_CRITICAL';
    }
    if (params.fanoutEpisodeCount >= GLOBAL_SPAMMER_CONFIRMED_FANOUT_EPISODE_THRESHOLD) {
      return 'FANOUT_EPISODE_CONFIRMED';
    }
    if (params.fanoutEpisodeCount >= GLOBAL_SPAMMER_STRONG_FANOUT_EPISODE_THRESHOLD) {
      return 'FANOUT_EPISODE_STRONG';
    }
    if (params.fanoutEpisodeCount >= GLOBAL_SPAMMER_MEDIUM_FANOUT_EPISODE_THRESHOLD) {
      return 'FANOUT_EPISODE_MEDIUM';
    }
    return 'FANOUT_EPISODE_OBSERVED';
  }

  private buildLocalGlobalSpammerChatObservationKey(chatId: string, userId: string): string {
    return `${userId}:${chatId}`;
  }

  private hasRecentLocalGlobalSpammerChatObservation(chatId: string, userId: string): boolean {
    const cacheKey = this.buildLocalGlobalSpammerChatObservationKey(chatId, userId);
    const expiresAtMs = this.globalSpammerLocalChatObservations.get(cacheKey) ?? 0;
    if (expiresAtMs <= Date.now()) {
      this.globalSpammerLocalChatObservations.delete(cacheKey);
      return false;
    }

    return true;
  }

  private markLocalGlobalSpammerChatObservation(chatId: string, userId: string): void {
    this.globalSpammerLocalChatObservations.set(
      this.buildLocalGlobalSpammerChatObservationKey(chatId, userId),
      Date.now() + GLOBAL_SPAMMER_LOCAL_CHAT_OBSERVATION_TTL_MS,
    );
  }

  private async resolveGlobalSpammerExemptUserIds(
    userIds: readonly string[],
    adminUserIds: readonly string[] | undefined,
    options: {
      chatId?: string;
    } = {},
  ): Promise<Set<string>> {
    const decisions = await this.resolveGlobalSpammerAdminDecisions(userIds, adminUserIds, options);
    const exemptUserIds = new Set<string>();
    for (const [userId, decision] of decisions.entries()) {
      if (decision === 'ALLOW') {
        exemptUserIds.add(userId);
      }
    }
    return exemptUserIds;
  }

  private async resolveGlobalSpammerAdminDecisions(
    userIds: readonly string[],
    adminUserIds: readonly string[] | undefined,
    options: {
      chatId?: string;
    } = {},
  ): Promise<Map<string, LocalGlobalSpammerAdminDecision>> {
    if (!Array.isArray(adminUserIds) || adminUserIds.length === 0 || userIds.length === 0) {
      return new Map();
    }

    const normalizedAdminUserIds = [
      ...new Set(adminUserIds.map((item) => item.trim()).filter(Boolean)),
    ].sort();
    const cacheScopeKey = this.buildGlobalSpammerExemptionCacheScopeKey(
      options.chatId ?? null,
      normalizedAdminUserIds,
    );
    const cachedDecisions = new Map<string, LocalGlobalSpammerAdminDecision>();
    const unresolvedUserIds: string[] = [];
    for (const rawUserId of userIds) {
      const normalizedUserId = rawUserId.trim();
      if (!normalizedUserId) {
        continue;
      }

      const cached = this.readGlobalSpammerExemptionCache(cacheScopeKey, normalizedUserId);
      if (cached === null) {
        unresolvedUserIds.push(normalizedUserId);
        continue;
      }
      cachedDecisions.set(normalizedUserId, cached);
    }

    if (unresolvedUserIds.length === 0) {
      return cachedDecisions;
    }

    const decisions = new Map(cachedDecisions);
    const unresolvedLookups = await Promise.all(
      [...new Set(unresolvedUserIds)].map(async (normalizedUserId) => ({
        userId: normalizedUserId,
        decision: await this.enqueueGlobalSpammerExemptionLookupBatch(
          cacheScopeKey,
          normalizedAdminUserIds,
          normalizedUserId,
        ),
      })),
    );

    for (const lookup of unresolvedLookups) {
      if (lookup.decision) {
        decisions.set(lookup.userId, lookup.decision);
      }
    }

    return decisions;
  }

  private enqueueGlobalSpammerExemptionLookupBatch(
    scopeKey: string,
    adminUserIds: readonly string[],
    userId: string,
  ): Promise<LocalGlobalSpammerAdminDecision | null> {
    const cacheKey = `${scopeKey}|${userId}`;
    const inFlight = this.globalSpammerExemptionLookupInFlight.get(cacheKey);
    if (inFlight) {
      return inFlight;
    }

    let batch = this.pendingGlobalSpammerExemptionLookupBatches.get(scopeKey);
    if (!batch) {
      batch = {
        scopeKey,
        adminUserIds: [...adminUserIds],
        lookups: new Map(),
        scheduled: false,
      };
      this.pendingGlobalSpammerExemptionLookupBatches.set(scopeKey, batch);
    }

    const lookupPromise = new Promise<LocalGlobalSpammerAdminDecision | null>((resolve, reject) => {
      batch!.lookups.set(cacheKey, {
        userId,
        resolve,
        reject,
      });
    });

    const trackedLookupPromise = lookupPromise.finally(() => {
      if (this.globalSpammerExemptionLookupInFlight.get(cacheKey) === trackedLookupPromise) {
        this.globalSpammerExemptionLookupInFlight.delete(cacheKey);
      }
    });

    this.globalSpammerExemptionLookupInFlight.set(cacheKey, trackedLookupPromise);

    if (!batch.scheduled) {
      batch.scheduled = true;
      void Promise.resolve().then(() =>
        this.flushPendingGlobalSpammerExemptionLookupBatch(scopeKey),
      );
    }

    return trackedLookupPromise;
  }

  private async flushPendingGlobalSpammerExemptionLookupBatch(scopeKey: string): Promise<void> {
    const batch = this.pendingGlobalSpammerExemptionLookupBatches.get(scopeKey);
    if (!batch) {
      return;
    }

    this.pendingGlobalSpammerExemptionLookupBatches.delete(scopeKey);
    const lookups = [...batch.lookups.values()];
    if (lookups.length === 0) {
      return;
    }

    try {
      const decisions = await this.loadGlobalSpammerExemptionBatch(
        batch.adminUserIds,
        lookups.map((lookup) => lookup.userId),
      );

      for (const lookup of lookups) {
        const decision = decisions.get(lookup.userId) ?? null;
        this.writeGlobalSpammerExemptionCache(scopeKey, lookup.userId, decision);
        lookup.resolve(decision);
      }
    } catch (error: unknown) {
      for (const lookup of lookups) {
        lookup.reject(error);
      }
    }
  }

  private async loadGlobalSpammerExemptionBatch(
    adminUserIds: readonly string[],
    userIds: readonly string[],
  ): Promise<Map<string, LocalGlobalSpammerAdminDecision>> {
    const normalizedAdminUserIds = [
      ...new Set(adminUserIds.map((item) => item.trim()).filter(Boolean)),
    ].sort();
    const normalizedUserIds = [...new Set(userIds.map((item) => item.trim()).filter(Boolean))];
    const decisions = new Map<string, LocalGlobalSpammerAdminDecision>();
    if (normalizedAdminUserIds.length === 0 || normalizedUserIds.length === 0) {
      return decisions;
    }

    const adminUserVariants = new Set<string>();
    for (const adminUserId of normalizedAdminUserIds) {
      for (const variant of this.buildUserIdVariants(adminUserId)) {
        adminUserVariants.add(variant);
      }
    }
    if (adminUserVariants.size === 0) {
      return decisions;
    }

    const userIdVariants = new Set<string>();
    const variantToUserIds = new Map<string, Set<string>>();
    for (const normalizedUserId of normalizedUserIds) {
      for (const variant of this.buildUserIdVariants(normalizedUserId)) {
        userIdVariants.add(variant);
        const matchingUserIds = variantToUserIds.get(variant) ?? new Set<string>();
        matchingUserIds.add(normalizedUserId);
        variantToUserIds.set(variant, matchingUserIds);
      }
    }
    if (userIdVariants.size === 0) {
      return decisions;
    }

    const prismaWithAdminGlobalSpammerExemption = this.prisma as unknown as {
      adminGlobalSpammerExemption?: {
        findMany?: (args: {
          where: {
            adminUserId: { in: string[] };
            userId: { in: string[] };
          };
          select: { userId: true; decision: true; updatedAt: true };
        }) => Promise<Array<{ userId: string; decision?: string | null; updatedAt?: Date }>>;
      };
    };
    const adminGlobalSpammerExemptionModel =
      prismaWithAdminGlobalSpammerExemption.adminGlobalSpammerExemption ?? {};
    if (typeof adminGlobalSpammerExemptionModel.findMany !== 'function') {
      return decisions;
    }

    const rows = await adminGlobalSpammerExemptionModel.findMany({
      where: {
        adminUserId: {
          in: [...adminUserVariants],
        },
        userId: {
          in: [...userIdVariants],
        },
      },
      select: {
        userId: true,
        decision: true,
        updatedAt: true,
      },
    });

    for (const row of rows) {
      const matchingUserIds = variantToUserIds.get(row.userId);
      if (!matchingUserIds) {
        continue;
      }

      const decision = this.normalizeLocalGlobalSpammerAdminDecision(row.decision) ?? 'ALLOW';
      for (const matchingUserId of matchingUserIds) {
        const currentDecision = decisions.get(matchingUserId);
        decisions.set(
          matchingUserId,
          this.resolveLocalGlobalSpammerAdminDecisionPrecedence(currentDecision, decision),
        );
      }
    }

    return decisions;
  }

  private buildGlobalSpammerExemptionCacheScopeKey(
    chatId: string | null,
    adminUserIds: readonly string[],
  ): string {
    return `${chatId?.trim() || 'global'}|${adminUserIds.join(',')}`;
  }

  private readGlobalSpammerExemptionCache(
    scopeKey: string,
    userId: string,
  ): LocalGlobalSpammerAdminDecision | null {
    const cacheKey = `${scopeKey}|${userId}`;
    const cached = this.globalSpammerExemptionCache.get(cacheKey);
    if (!cached) {
      return null;
    }
    if (cached.expiresAtMs <= Date.now()) {
      this.globalSpammerExemptionCache.delete(cacheKey);
      return null;
    }

    return cached.decision;
  }

  private writeGlobalSpammerExemptionCache(
    scopeKey: string,
    userId: string,
    decision: LocalGlobalSpammerAdminDecision | null,
  ): void {
    this.globalSpammerExemptionCache.set(`${scopeKey}|${userId}`, {
      expiresAtMs: Date.now() + GLOBAL_SPAMMER_EXEMPTION_CACHE_TTL_MS,
      decision,
    });
  }

  private normalizeLocalGlobalSpammerAdminDecision(
    value: string | null | undefined,
  ): LocalGlobalSpammerAdminDecision | null {
    const normalized = value?.trim().toUpperCase();
    if (normalized === 'ALLOW' || normalized === 'BLOCK' || normalized === 'REVIEW') {
      return normalized;
    }
    return null;
  }

  private resolveLocalGlobalSpammerAdminDecisionPrecedence(
    current: LocalGlobalSpammerAdminDecision | undefined,
    next: LocalGlobalSpammerAdminDecision,
  ): LocalGlobalSpammerAdminDecision {
    if (!current || current === 'REVIEW') {
      return next;
    }
    if (current === 'ALLOW' || next === 'ALLOW') {
      return 'ALLOW';
    }
    return 'BLOCK';
  }

  private async isUserKnownGlobalSpammer(
    userId: string,
    context?: { chatId?: string; messageId?: string; trigger?: string },
  ): Promise<boolean> {
    if (await this.legacyHolds?.isGlobalUserHeld(userId)) return false;
    if (this.isKnownRuntimeBotUserId(userId)) {
      return false;
    }

    if (this.globalSpammerIntelligence) {
      const decision = await this.globalSpammerIntelligence.evaluatePolicy({
        chatId: context?.chatId,
        userId,
        messageId: context?.messageId,
        trigger: context?.trigger ?? 'message',
        deleteSpammersEnabled: true,
        recordDecision: Boolean(context),
      });
      return decision.action === 'DELETE_AND_KICK';
    }

    const globalSpammerModel = this.prisma.globalSpammer as unknown as {
      findFirst?: (args: unknown) => Promise<{ userId: string; expiresAt?: Date | null } | null>;
      findUnique?: (args: unknown) => Promise<{ userId: string; expiresAt?: Date | null } | null>;
    };
    const now = new Date();
    const row =
      typeof globalSpammerModel.findFirst === 'function'
        ? await globalSpammerModel.findFirst({
            where: {
              userId,
              expiresAt: {
                gt: now,
              },
            },
            select: {
              userId: true,
            },
          })
        : await globalSpammerModel.findUnique?.({
            where: {
              userId,
            },
            select: {
              userId: true,
              expiresAt: true,
            },
          });
    if (!row) {
      return false;
    }
    if ('expiresAt' in row) {
      return row.expiresAt instanceof Date && row.expiresAt.getTime() > now.getTime();
    }
    return true;
  }

  private async isDeveloperForcedGlobalSpammerCached(userId: string): Promise<boolean> {
    if (await this.legacyHolds?.isGlobalUserHeld(userId)) return false;
    if (this.isKnownRuntimeBotUserId(userId)) {
      return false;
    }
    const normalizedUserId = userId.trim();
    if (!normalizedUserId) {
      return false;
    }

    const getString = (this.redisCounter as Partial<RedisCounterService> | undefined)?.getString;
    if (typeof getString === 'function') {
      try {
        if (
          (await getString.call(
            this.redisCounter,
            buildDeveloperForcedGlobalSpammerCacheKey(normalizedUserId),
          )) === '1'
        ) {
          return true;
        }
      } catch (error: unknown) {
        this.logger.debug(
          {
            userId: normalizedUserId,
            err: error instanceof Error ? error.message : String(error),
          },
          'Failed to read developer-forced global spammer cache',
        );
      }
    }

    if (this.hasDeveloperForcedGlobalSpammerMemoryCache(normalizedUserId)) {
      return true;
    }

    if (this.developerForcedGlobalSpammerWarmUntilMs > Date.now()) {
      return false;
    }

    if (typeof getString === 'function') {
      try {
        if (
          (await getString.call(
            this.redisCounter,
            buildDeveloperForcedGlobalSpammerWarmMarkerKey(),
          )) === '1'
        ) {
          this.developerForcedGlobalSpammerWarmUntilMs =
            Date.now() + DEVELOPER_FORCED_GLOBAL_SPAMMER_MEMORY_CACHE_TTL_MS;
          return false;
        }
      } catch (error: unknown) {
        this.logger.debug(
          {
            userId: normalizedUserId,
            err: error instanceof Error ? error.message : String(error),
          },
          'Failed to read developer-forced global spammer warm marker',
        );
      }
    }

    await this.warmDeveloperForcedGlobalSpammerCache();
    return this.hasDeveloperForcedGlobalSpammerMemoryCache(normalizedUserId);
  }

  private async isDeveloperForcedGlobalSpammerCachedWithHotPathBudget(
    userId: string,
    context: {
      chatId?: string | null;
      messageId?: string | null;
    } = {},
  ): Promise<boolean> {
    let timedOut = false;
    const result = await raceWithTimeout({
      operation: () => this.isDeveloperForcedGlobalSpammerCached(userId),
      timeoutMs: DEVELOPER_FORCED_GLOBAL_SPAMMER_HOT_PATH_TIMEOUT_MS,
      onTimeout: () => {
        timedOut = true;
        return false;
      },
    });
    if (timedOut) {
      void this.runtimeDiagnosticsService?.recordHotPathStageOutcome({
        stage: 'developer-forced-global-spammer.budget',
        outcome: 'timeout',
        failOpen: true,
      });
      this.logger.debug(
        {
          chatId: context.chatId ?? null,
          userId,
          messageId: context.messageId ?? null,
          timeoutMs: DEVELOPER_FORCED_GLOBAL_SPAMMER_HOT_PATH_TIMEOUT_MS,
        },
        'Developer-forced global spammer lookup exceeded hot-path budget; continuing fail-open',
      );
    }

    return result;
  }

  private hasDeveloperForcedGlobalSpammerMemoryCache(userId: string): boolean {
    const expiresAtMs = this.developerForcedGlobalSpammerMemoryCache.get(userId);
    if (!expiresAtMs) {
      return false;
    }
    if (expiresAtMs <= Date.now()) {
      this.developerForcedGlobalSpammerMemoryCache.delete(userId);
      return false;
    }
    return true;
  }

  private async warmDeveloperForcedGlobalSpammerCache(): Promise<void> {
    if (this.developerForcedGlobalSpammerWarmUntilMs > Date.now()) {
      return;
    }
    if (this.developerForcedGlobalSpammerWarmInFlight) {
      await this.developerForcedGlobalSpammerWarmInFlight;
      return;
    }

    const warm = this.loadDeveloperForcedGlobalSpammerCacheFromRegistry();
    this.developerForcedGlobalSpammerWarmInFlight = warm;
    try {
      await warm;
    } finally {
      this.developerForcedGlobalSpammerWarmInFlight = null;
    }
  }

  private async loadDeveloperForcedGlobalSpammerCacheFromRegistry(): Promise<void> {
    const globalSpammerModel = this.prisma.globalSpammer as unknown as {
      findMany?: (args: unknown) => Promise<
        Array<{
          userId: string;
          expiresAt?: Date | null;
          sourceBreakdown?: Prisma.JsonValue | null;
        }>
      >;
    } | null;
    const now = new Date();
    if (typeof globalSpammerModel?.findMany !== 'function') {
      this.developerForcedGlobalSpammerWarmUntilMs =
        Date.now() + DEVELOPER_FORCED_GLOBAL_SPAMMER_MEMORY_CACHE_TTL_MS;
      return;
    }

    try {
      const rows = await globalSpammerModel.findMany({
        where: {
          expiresAt: {
            gt: now,
          },
          sourceBreakdown: {
            path: ['DEVELOPER_FORCED'],
            not: Prisma.JsonNull,
          },
        },
        select: {
          userId: true,
          expiresAt: true,
          sourceBreakdown: true,
        },
      });

      const restoreTasks: Array<Promise<void>> = [];
      for (const row of rows) {
        const normalizedUserId = row.userId.trim();
        if (
          !normalizedUserId ||
          this.isKnownRuntimeBotUserId(normalizedUserId) ||
          !(row.expiresAt instanceof Date) ||
          row.expiresAt.getTime() <= now.getTime() ||
          !this.hasDeveloperForcedGlobalSpammerSource(row.sourceBreakdown)
        ) {
          continue;
        }

        this.developerForcedGlobalSpammerMemoryCache.set(
          normalizedUserId,
          Math.min(
            row.expiresAt.getTime(),
            Date.now() + DEVELOPER_FORCED_GLOBAL_SPAMMER_MEMORY_CACHE_TTL_MS,
          ),
        );
        restoreTasks.push(
          this.rememberDeveloperForcedGlobalSpammer(normalizedUserId, row.expiresAt),
        );
      }

      restoreTasks.push(this.rememberDeveloperForcedGlobalSpammerWarmMarker());
      await Promise.all(restoreTasks);
      this.developerForcedGlobalSpammerWarmUntilMs =
        Date.now() + DEVELOPER_FORCED_GLOBAL_SPAMMER_MEMORY_CACHE_TTL_MS;
    } catch (error: unknown) {
      this.logger.debug(
        {
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to warm developer-forced global spammer cache',
      );
      this.developerForcedGlobalSpammerWarmUntilMs =
        Date.now() + Math.min(30_000, DEVELOPER_FORCED_GLOBAL_SPAMMER_MEMORY_CACHE_TTL_MS);
    }
  }

  private async rememberDeveloperForcedGlobalSpammer(
    userId: string,
    expiresAt?: Date | null,
  ): Promise<void> {
    const setStringWithTtl = (this.redisCounter as Partial<RedisCounterService> | undefined)
      ?.setStringWithTtl;
    if (typeof setStringWithTtl !== 'function') {
      return;
    }

    const ttlSec =
      expiresAt instanceof Date
        ? Math.max(1, Math.ceil((expiresAt.getTime() - Date.now()) / 1_000))
        : DEVELOPER_FORCED_GLOBAL_SPAMMER_CACHE_TTL_SEC;
    try {
      await setStringWithTtl.call(
        this.redisCounter,
        buildDeveloperForcedGlobalSpammerCacheKey(userId),
        '1',
        Math.min(DEVELOPER_FORCED_GLOBAL_SPAMMER_CACHE_TTL_SEC, ttlSec),
      );
    } catch (error: unknown) {
      this.logger.debug(
        {
          userId,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to restore developer-forced global spammer cache',
      );
    }
  }

  private async rememberDeveloperForcedGlobalSpammerWarmMarker(): Promise<void> {
    const setStringWithTtl = (this.redisCounter as Partial<RedisCounterService> | undefined)
      ?.setStringWithTtl;
    if (typeof setStringWithTtl !== 'function') {
      return;
    }

    try {
      await setStringWithTtl.call(
        this.redisCounter,
        buildDeveloperForcedGlobalSpammerWarmMarkerKey(),
        '1',
        DEVELOPER_FORCED_GLOBAL_SPAMMER_WARM_MARKER_TTL_SEC,
      );
    } catch (error: unknown) {
      this.logger.debug(
        {
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to write developer-forced global spammer warm marker',
      );
    }
  }

  private hasDeveloperForcedGlobalSpammerSource(
    sourceBreakdown: Prisma.JsonValue | null | undefined,
  ): boolean {
    return (
      typeof sourceBreakdown === 'object' &&
      sourceBreakdown !== null &&
      !Array.isArray(sourceBreakdown) &&
      Boolean((sourceBreakdown as Prisma.JsonObject).DEVELOPER_FORCED)
    );
  }

  private async upsertGlobalSpammerEntry(params: {
    userId: string;
    sourceChatId: string;
    reason: string;
    evidence?: Prisma.InputJsonValue;
    evidenceHash?: string;
  }) {
    const { userId, sourceChatId, reason, evidence } = params;
    if (await this.legacyHolds?.isGlobalUserHeld(userId)) return;
    if (this.isKnownRuntimeBotUserId(userId)) {
      return;
    }

    try {
      if (this.globalSpammerIntelligence) {
        const observation = this.resolveGlobalSpammerObservation(params);
        await this.globalSpammerIntelligence.recordObservation(observation);
        return;
      }

      if (
        reason === 'HIGH_FANOUT_5_CHATS_REPEAT' ||
        reason === 'HIGH_FANOUT_6_CHATS_2M' ||
        reason === 'FANOUT_EPISODE_OBSERVED' ||
        reason === 'FANOUT_EPISODE_MEDIUM' ||
        reason === 'FANOUT_EPISODE_STRONG'
      ) {
        return;
      }

      const now = new Date();
      const expiresAt = new Date(now.getTime() + this.globalSpammerRegistryTtlMs);
      const sourceBreakdown: Prisma.InputJsonObject = {
        LEGACY_FALLBACK: {
          score: 1,
          rawScore: 1,
          count: 1,
          latestAt: now.toISOString(),
          reasons: [reason],
        },
      };

      await this.prisma.globalSpammer.upsert({
        where: {
          userId,
        },
        create: {
          userId,
          lastReason: reason,
          lastChatId: sourceChatId,
          lastEvidence: evidence ?? Prisma.JsonNull,
          confidenceScore: 1,
          confirmedAt: now,
          expiresAt,
          sourceBreakdown,
        },
        update: {
          detectionsCount: {
            increment: 1,
          },
          lastReason: reason,
          lastChatId: sourceChatId,
          lastEvidence: evidence ?? Prisma.JsonNull,
          confidenceScore: 1,
          confirmedAt: now,
          expiresAt,
          sourceBreakdown,
        },
      });
    } catch (error: unknown) {
      this.logger.warn(
        {
          userId,
          sourceChatId,
          reason,
          error: error instanceof Error ? error.message : 'Unknown error',
        },
        'Failed to upsert global spammer entry',
      );
    }
  }

  private resolveGlobalSpammerObservation(params: {
    userId: string;
    sourceChatId: string;
    reason: string;
    evidence?: Prisma.InputJsonValue;
    evidenceHash?: string;
  }) {
    const sourceAndScore = this.resolveGlobalSpammerObservationSource(params.reason);
    return {
      userId: params.userId,
      source: sourceAndScore.source,
      score: sourceAndScore.score,
      reason: params.reason,
      chatId: params.sourceChatId,
      evidence: params.evidence,
      ...(params.evidenceHash ? { evidenceHash: params.evidenceHash } : {}),
      forceRegistry: sourceAndScore.forceRegistry,
      ttlDays: sourceAndScore.ttlDays,
    };
  }

  private resolveGlobalSpammerObservationSource(reason: string): {
    source: GlobalSpammerObservationSource;
    score: number;
    forceRegistry: boolean;
    ttlDays?: number;
  } {
    if (reason === 'FANOUT_EPISODE_CRITICAL') {
      return { source: 'FANOUT_HIGH', score: 0.97, forceRegistry: true, ttlDays: 21 };
    }
    if (reason === 'FANOUT_EPISODE_CONFIRMED') {
      return { source: 'FANOUT_HIGH', score: 0.94, forceRegistry: true, ttlDays: 21 };
    }
    if (reason === 'FANOUT_EPISODE_STRONG') {
      return { source: 'FANOUT_HIGH', score: 0.82, forceRegistry: false, ttlDays: 21 };
    }
    if (reason === 'FANOUT_EPISODE_MEDIUM') {
      return { source: 'FANOUT_REPEAT', score: 0.68, forceRegistry: false, ttlDays: 14 };
    }
    if (reason === 'FANOUT_EPISODE_OBSERVED' || reason === 'HIGH_FANOUT_6_CHATS_2M') {
      return { source: 'FANOUT_HIGH', score: 0.48, forceRegistry: false, ttlDays: 7 };
    }
    if (reason === 'HIGH_FANOUT_5_CHATS_REPEAT') {
      return { source: 'FANOUT_REPEAT', score: 0.68, forceRegistry: false, ttlDays: 14 };
    }
    if (reason === 'SANCTION_BAN' || reason === 'SANCTION_KICK') {
      return { source: 'SANCTION_BAN', score: 0.74, forceRegistry: false, ttlDays: 21 };
    }
    return { source: 'SANCTION_BAN', score: 0.62, forceRegistry: false, ttlDays: 14 };
  }

  private handleNightModeMessage(params: NightClosedChatMessage) {
    return this.closedChatMessageModeration.handleNightModeMessage(params);
  }

  private handleNightModeForceCloseMessage(params: ManuallyClosedChatMessage) {
    return this.closedChatMessageModeration.handleNightModeForceCloseMessage(params);
  }

  async executeRequiredSubscriptionCandidate(
    attempt: RequiredSubscriptionCandidateAttempt,
  ): Promise<void> {
    await executeRequiredSubscriptionCandidate(
      this.getRequiredSubscriptionCandidateHost(),
      attempt,
    );
  }

  getRequiredSubscriptionCandidateHost() {
    return {
      prisma: this.prisma,
      guard: this.requiredSubscriptionExecutionGuard,
      store: this.requiredSubscriptionCandidateStore,
      deleteIntents: this.moderationDeleteIntentService,
      max: this.maxClient,
      botContext: this.maxBotContextService,
      coordinator: this.requiredSubscriptionMediaNoticeCoordinator,
      noticePlans: this.requiredSubscriptionNoticePlans,
      sanctionLock: this.moderationSanctionStateLockService,
      membership: this.getRequiredSubscriptionMembershipResolution.bind(this),
      channels: this.resolveRequiredSubscriptionChannels.bind(this),
      channelTitle: this.readRequiredSubscriptionChannelTitle.bind(this),
      readChannelIds: this.readRequiredSubscriptionChannelIds.bind(this),
      options: this.buildRequiredSubscriptionMessageOptions.bind(this),
      escalation: this.resolveRequiredSubscriptionEscalationAction.bind(this),
      explanation: this.buildRequiredSubscriptionExplanation.bind(this),
      warning: this.buildRequiredSubscriptionWarnExplanation.bind(this),
      mute: this.buildRequiredSubscriptionMuteExplanation.bind(this),
      ban: this.buildRequiredSubscriptionBanExplanation.bind(this),
      adminContact: this.appendAdminContactMarkdownLink.bind(this),
      userLabel: this.resolveSanctionUserLabel.bind(this),
      send: this.sendBotMessageWithOptionalAutoDelete.bind(this),
      media: this.resolveBotSpeechMedia.bind(this),
      prepareDelete: this.prepareModerationDeleteIntentInput.bind(this),
      banImmediately: this.banMemberImmediatelyWithResult.bind(this),
      activeMute: this.getActiveMute.bind(this),
      manualRelease: this.resolveLatestManualReleaseCreatedAt.bind(this),
      held: this.isLegacyModerationHeld.bind(this),
    };
  }

  private async handleRequiredSubscriptionMessage(params: {
    sourceUpdateType?: string | null;
    chatId: string;
    userId: string;
    userLabel: string;
    messageId: string;
    text: string;
    createdAt: string;
    settings: Pick<
      ChatSettings,
      | 'requiredSubscriptionEnabled'
      | 'requiredSubscriptionChannelIds'
      | 'requiredSubscriptionBotMessageText'
      | 'requiredSubscriptionButtonText'
      | 'requiredSubscriptionAdminContactButtonEnabled'
      | 'requiredSubscriptionAdminContactButtonUrl'
      | 'requiredSubscriptionWarnEnabled'
      | 'requiredSubscriptionWarnMessageText'
      | 'requiredSubscriptionBanEnabled'
      | 'requiredSubscriptionMuteEnabled'
      | 'requiredSubscriptionMuteDurationHours'
      | 'botSpeechStyle'
      | 'botSpeechMedia'
      | 'rulesAttachViolationsEnabled'
      | 'deleteBotMessagesEnabled'
      | 'deleteBotMessagesDelayMinutes'
      | 'muteDurationHours'
    >;
    rulesPublishedUrl: string | null;
    rulesPublishedMessageId: string | null;
    hotPathProfile?: WebhookHotPathProfile | null;
    suppressEscalation?: boolean;
    knownAppliedSanctionAction?: typeof SanctionAction.MUTE;
    knownAppliedMuteDurationHours?: number | null;
    mediaNoticeScope?: RequiredSubscriptionMediaNoticeScope | null;
  }): Promise<boolean> {
    if (!isRequiredSubscriptionCurrentlyActive(params.settings)) {
      return false;
    }

    const requiredChannelIds = this.readRequiredSubscriptionChannelIds(
      params.settings.requiredSubscriptionChannelIds,
    );
    if (requiredChannelIds.length === 0) {
      return false;
    }

    const allowInitialRequiredSubscriptionMetadataFetch = !this.chatContextCache;
    const resolvedRequiredChannels = await this.resolveRequiredSubscriptionChannels(
      requiredChannelIds,
      { allowRemoteFetch: allowInitialRequiredSubscriptionMetadataFetch },
    );
    const requiredMembershipChannelIds = resolvedRequiredChannels
      .filter((channel) => channel.checkMembership)
      .map((channel) => channel.id);
    if (requiredMembershipChannelIds.length === 0) {
      return false;
    }

    const resolvedRequiredChannelsById = new Map(
      resolvedRequiredChannels.map((channel) => [channel.id, channel] as const),
    );

    this.markWebhookHotPathStage(params.hotPathProfile, 'required-subscription.membership');
    const membership = await this.resolveRequiredSubscriptionMembershipWithHotPathBudget({
      chatId: params.chatId,
      userId: params.userId,
      requiredChannelIds: requiredMembershipChannelIds,
      hotPathProfile: params.hotPathProfile,
    });
    if (!membership) {
      return false;
    }
    await nominateRequiredSubscriptionCandidate(this.getRequiredSubscriptionCandidateHost(), {
      ...params,
      localQuotaResolution: membership.localQuotaResolution,
    });
    if (membership.missingChannelIds.length === 0) return false;

    const missingChannelIdsNeedingRefresh = allowInitialRequiredSubscriptionMetadataFetch
      ? []
      : membership.missingChannelIds.filter((channelId) => {
          const metadata = resolvedRequiredChannelsById.get(channelId) ?? null;
          return !metadata || !metadata.usable;
        });
    const mediaNoticeScope =
      this.requiredSubscriptionMediaNoticeCoordinator.canCoordinateMediaNotice() &&
      params.mediaNoticeScope
        ? bindRequiredSubscriptionMediaNoticeScope({
            scope: params.mediaNoticeScope,
            requiredChannelIds: requiredMembershipChannelIds,
            missingChannelIds: membership.missingChannelIds,
          })
        : null;
    const missingChannels = membership.missingChannelIds
      .map((channelId) => resolvedRequiredChannelsById.get(channelId) ?? null)
      .filter((channel): channel is RequiredSubscriptionChannelMetadata => channel !== null);
    const missingChannelTitles = missingChannels
      .map((channel) => this.readRequiredSubscriptionChannelTitle(channel.id, channel.title))
      .filter((title) => title.length > 0);
    const {
      metadata: requiredSubscriptionChannelMetadata,
      deleteIntent,
      executionProof,
    } = createRequiredSubscriptionEvidence(
      params,
      requiredChannelIds,
      membership,
      mediaNoticeScope,
      missingChannelTitles,
    );
    const subscriptionAssertionParams = {
      ...params,
      reasonKey: deleteIntent.reasonKey,
      metadata: requiredSubscriptionChannelMetadata,
    };
    const assertRequiredSubscriptionCurrent = createRequiredSubscriptionAssertion(
      this.requiredSubscriptionExecutionGuard,
      () => this.maxBotContextService?.getActiveBotId() ?? undefined,
      subscriptionAssertionParams,
    );
    const assertRequiredSubscriptionInitiallyCurrent = createRequiredSubscriptionAssertion(
      this.requiredSubscriptionExecutionGuard,
      () => this.maxBotContextService?.getActiveBotId() ?? undefined,
      subscriptionAssertionParams,
      { initialQualification: true },
    );
    const assertRequiredSubscriptionDeleteHandoffCurrent = createRequiredSubscriptionAssertion(
      this.requiredSubscriptionExecutionGuard,
      () => this.maxBotContextService?.getActiveBotId() ?? undefined,
      subscriptionAssertionParams,
      { deleteHandoffQualification: true },
    );
    return this.requiredSubscriptionMediaNoticeCoordinator.run({
      chatId: params.chatId,
      userId: params.userId,
      messageId: params.messageId,
      botId: this.maxBotContextService?.getActiveBotId() ?? null,
      mediaScope: mediaNoticeScope,
      readNoticePlan: (messageId) =>
        this.requiredSubscriptionNoticePlans.read(params.chatId, messageId),
      handoffNoticePlan: createRequiredSubscriptionNoticeHandoff(
        this.requiredSubscriptionExecutionGuard,
        () => this.maxBotContextService?.getActiveBotId() ?? undefined,
        params,
        async ({ mediaFieldKey, ...notice }) =>
          this.sendBotMessageWithOptionalAutoDelete({
            ...notice,
            messageOptions: withMarketplaceModerationMessage(
              notice.messageOptions,
              params.chatId,
              'MODERATION_NOTICE',
              'REQUIRED_SUBSCRIPTION',
            ),
            media: this.resolveBotSpeechMedia(params.settings, mediaFieldKey ?? undefined),
          }),
      ),
      executeDelete: async (assertNoticeLeaseOwned) => {
        await assertNoticeLeaseOwned();
        this.markWebhookHotPathStage(
          params.hotPathProfile,
          'required-subscription.delete-authority',
        );
        if (
          await handoffRequiredSubscriptionDelete({
            assertAuthority: assertRequiredSubscriptionDeleteHandoffCurrent,
            assertLeaseOwned: assertNoticeLeaseOwned,
            persist: this.moderationDeleteIntentService
              ? () =>
                  this.moderationDeleteIntentService!.ensureIntent(
                    this.prepareModerationDeleteIntentInput(deleteIntent),
                  )
              : undefined,
          })
        )
          return;
        await this.ensureModerationDeleteIntent(deleteIntent);
        await assertNoticeLeaseOwned();
        const deleteResult = await this.executeModerationDelete(deleteIntent);
        this.markWebhookHotPathStage(params.hotPathProfile, 'required-subscription.delete');
        if (deleteResult.gone) {
          this.markWebhookHotPathSuccessBoundary(
            params.hotPathProfile,
            'required-subscription.delete',
          );
        }
        if (deleteResult.deleted && !deleteResult.eventPersistedByIntent) {
          await this.createBotModerationEvent({
            data: {
              chatId: params.chatId,
              userId: params.userId,
              messageId: params.messageId,
              eventType: EventType.MESSAGE,
              ruleCode: `${REQUIRED_SUBSCRIPTION_RULE_CODE}_DELETE`,
              action: SanctionAction.DELETE_MESSAGE,
              maskedExcerpt: maskText(params.text),
              score: 1,
              operator: Operator.BOT,
              metadata: {
                action: SanctionAction.DELETE_MESSAGE,
                ...requiredSubscriptionChannelMetadata,
                missingChannelTitles,
              },
            },
          });
        }
      },
      lead: async ({
        assertOwned: assertNoticeLeaseOwned,
        noticeIdempotencyKey,
        settleNoticePlan,
      }) => {
        await assertNoticeLeaseOwned();
        // FLAG: This fresh leader has not claimed a violation or begun any sanction.
        // A certified initial GET refusal keeps a durable no-effect read obligation;
        // other unavailable evidence never waives later or unknown effects.
        this.markWebhookHotPathStage(
          params.hotPathProfile,
          'required-subscription.initial-authority',
        );
        try {
          await assertRequiredSubscriptionInitiallyCurrent();
        } catch (error: unknown) {
          if (
            error instanceof RequiredSubscriptionExecutionRejectedError ||
            error instanceof RequiredSubscriptionInitialSourceUnavailableError ||
            error instanceof RequiredSubscriptionMembershipUnavailableError
          ) {
            const retained = await nominateRequiredSubscriptionCandidate(
              this.getRequiredSubscriptionCandidateHost(),
              {
                ...params,
                mediaNoticeScope,
                sourceReadFailure: error,
                assertLeaseOwned: assertNoticeLeaseOwned,
              },
            );
            void this.runtimeDiagnosticsService?.recordHotPathStageOutcome({
              stage: 'required-subscription.initial-authority',
              outcome: 'skip',
              failOpen: !retained && !(error instanceof RequiredSubscriptionExecutionRejectedError),
            });
            return true;
          }
          throw error;
        }
        const claimed = await this.claimAndPersistMessageScopedModerationViolation({
          chatId: params.chatId,
          userId: params.userId,
          messageId: params.messageId,
          ruleCode: REQUIRED_SUBSCRIPTION_RULE_CODE,
          score: 1,
        });

        this.markWebhookHotPathStage(params.hotPathProfile, 'required-subscription.follow-up');
        const persistedDecision = !claimed
          ? await this.requiredSubscriptionNoticePlans.readDecision({
              chatId: params.chatId,
              userId: params.userId,
              messageId: params.messageId,
            })
          : null;
        const recoveredAppliedMuteDecision =
          !persistedDecision && params.knownAppliedSanctionAction === SanctionAction.MUTE
            ? ({
                action: SanctionAction.MUTE,
                eventId: null,
                violationCount24h: null,
                muteDurationHours: params.knownAppliedMuteDurationHours ?? null,
              } satisfies RequiredSubscriptionPersistedDecision)
            : null;
        const recoveredDecision = persistedDecision ?? recoveredAppliedMuteDecision;
        const noticeMuteDurationHours = this.readMuteDurationHoursFromMetadata(
          {
            muteDurationHours:
              recoveredDecision?.muteDurationHours ?? params.knownAppliedMuteDurationHours,
          },
          params.settings.requiredSubscriptionMuteDurationHours,
        );
        const requiredSubscriptionViolationCount24h =
          recoveredDecision?.violationCount24h ??
          (await this.countRecentRequiredSubscriptionViolations(params.chatId, params.userId, {
            persistedOnly: !claimed,
          }));
        const intendedAction: RequiredSubscriptionNoticeAction =
          recoveredDecision?.action ??
          (params.suppressEscalation
            ? SanctionAction.NONE
            : this.resolveRequiredSubscriptionEscalationAction(
                requiredSubscriptionViolationCount24h,
                {
                  warnEnabled: params.settings.requiredSubscriptionWarnEnabled,
                  banEnabled: params.settings.requiredSubscriptionBanEnabled,
                  muteEnabled: params.settings.requiredSubscriptionMuteEnabled,
                },
              ));
        const followUpMissingChannels = await this.resolveRequiredSubscriptionNoticeChannels({
          channels: missingChannels,
          channelIdsNeedingRefresh: missingChannelIdsNeedingRefresh,
        });
        const followUpMissingChannelTitles = followUpMissingChannels
          .map((channel) => this.readRequiredSubscriptionChannelTitle(channel.id, channel.title))
          .filter((title) => title.length > 0);
        const requiredSubscriptionMessageOptions =
          this.buildRequiredSubscriptionMessageOptions(
            followUpMissingChannels,
            params.settings.requiredSubscriptionButtonText,
            params.settings.rulesAttachViolationsEnabled,
            params.rulesPublishedUrl,
            params.rulesPublishedMessageId,
          ) ?? undefined;
        const persistModerationEvent = (
          metadataPatch: Record<string, unknown> = {},
          actionOverride: SanctionAction = intendedAction,
        ) =>
          this.createBotModerationEvent({
            data: {
              chatId: params.chatId,
              userId: params.userId,
              messageId: params.messageId,
              eventType: EventType.MESSAGE,
              ruleCode: REQUIRED_SUBSCRIPTION_RULE_CODE,
              action: actionOverride,
              maskedExcerpt: maskText(params.text),
              score: 1,
              operator: Operator.BOT,
              metadata: {
                action: actionOverride,
                ...requiredSubscriptionChannelMetadata,
                missingChannelTitles: followUpMissingChannelTitles,
                requiredSubscriptionViolationCount24h,
                requiredSubscriptionEscalationWindowHours:
                  REQUIRED_SUBSCRIPTION_ESCALATION_WINDOW_HOURS,
                ...metadataPatch,
              },
            },
          });
        let effectiveNoticeAction = intendedAction;
        let sanctionEventId = recoveredDecision?.eventId ?? null;
        const sanctionUserLabel =
          intendedAction === SanctionAction.MUTE || intendedAction === SanctionAction.BAN
            ? await this.resolveSanctionUserLabel(params.chatId, params.userId, params.userLabel)
            : params.userLabel;

        if (!recoveredDecision) {
          await assertNoticeLeaseOwned();
          if (intendedAction === SanctionAction.NONE || intendedAction === SanctionAction.WARN) {
            const event = await persistModerationDecisionWithoutAppliedSanction(
              persistModerationEvent,
              intendedAction,
            );
            sanctionEventId = this.readString(this.asRecord(event)?.id);
          } else {
            let persistedSanctionEventId: string | null = null;
            this.markWebhookHotPathStage(params.hotPathProfile, 'required-subscription.sanction');
            const sanctionApplied = await this.applySanctionAction({
              chatId: params.chatId,
              userId: params.userId,
              action: intendedAction,
              userLabel: sanctionUserLabel,
              messageId: params.messageId,
              muteDurationHours: params.settings.requiredSubscriptionMuteDurationHours,
              deleteBotMessagesEnabled: params.settings.deleteBotMessagesEnabled,
              deleteBotMessagesDelayMinutes: params.settings.deleteBotMessagesDelayMinutes,
              botMessageOptions: withMarketplaceModerationMessage(
                withRequiredSubscriptionHtmlMessageOptions(requiredSubscriptionMessageOptions),
                params.chatId,
                'MODERATION_NOTICE',
                'REQUIRED_SUBSCRIPTION',
              ),
              bypassNoticeBucket: true,
              noticeIdempotencyKey,
              rethrowNoticeFailure: true,
              activeMuteRuleCode: REQUIRED_SUBSCRIPTION_RULE_CODE,
              routeNoticeDynamically: true,
              deferNotice: true,
              onSanctionEventPersisted: (eventId) => {
                persistedSanctionEventId = eventId;
              },
              ...createRequiredSubscriptionSanctionCallbacks(
                assertNoticeLeaseOwned,
                assertRequiredSubscriptionCurrent,
              ),
              botSpeechStyle: params.settings.botSpeechStyle,
              trackAsGlobalSpammer: false,
              persistModerationEvent,
              assertActiveLease: assertNoticeLeaseOwned,
            });
            if (sanctionApplied) {
              sanctionEventId = persistedSanctionEventId;
            } else {
              effectiveNoticeAction = SanctionAction.NONE;
              await assertNoticeLeaseOwned();
              await persistModerationDecisionWithoutAppliedSanction(
                persistModerationEvent,
                intendedAction,
              );
              sanctionEventId = null;
            }
          }
        }

        this.markWebhookHotPathStage(params.hotPathProfile, 'required-subscription.notice-plan');
        const candidateNoticePlan = await buildRequiredSubscriptionNoticePlan({
          action: effectiveNoticeAction,
          executionProof,
          baseMessageOptions: requiredSubscriptionMessageOptions,
          sanctionEventId,
          deleteBotMessagesEnabled: params.settings.deleteBotMessagesEnabled,
          deleteBotMessagesDelayMinutes: params.settings.deleteBotMessagesDelayMinutes,
          copy: {
            explanation: () =>
              this.appendAdminContactMarkdownLink(
                params.chatId,
                this.buildRequiredSubscriptionExplanation(
                  params.userLabel,
                  null,
                  followUpMissingChannelTitles,
                  params.settings.requiredSubscriptionBotMessageText,
                  params.settings.botSpeechStyle,
                ),
                params.settings.requiredSubscriptionAdminContactButtonEnabled,
                params.settings.requiredSubscriptionAdminContactButtonUrl,
              ),
            warning: () =>
              this.appendAdminContactMarkdownLink(
                params.chatId,
                this.buildRequiredSubscriptionWarnExplanation(
                  params.userLabel,
                  followUpMissingChannelTitles,
                  params.settings.requiredSubscriptionWarnMessageText,
                  params.settings.botSpeechStyle,
                ),
                params.settings.requiredSubscriptionAdminContactButtonEnabled,
                params.settings.requiredSubscriptionAdminContactButtonUrl,
              ),
            mute: () =>
              this.buildRequiredSubscriptionMuteExplanation(
                sanctionUserLabel,
                followUpMissingChannelTitles,
                params.settings.botSpeechStyle,
                noticeMuteDurationHours,
              ),
            ban: () =>
              this.buildRequiredSubscriptionBanExplanation(
                sanctionUserLabel,
                followUpMissingChannelTitles,
                params.settings.requiredSubscriptionMuteDurationHours,
                params.settings.botSpeechStyle,
              ),
          },
        });
        await assertNoticeLeaseOwned();
        const durableNoticePlan = await this.requiredSubscriptionNoticePlans.persist({
          chatId: params.chatId,
          userId: params.userId,
          messageId: params.messageId,
          botId: this.maxBotContextService?.getActiveBotId() ?? null,
          plan: candidateNoticePlan,
        });
        this.markWebhookHotPathStage(params.hotPathProfile, 'required-subscription.notice-handoff');
        await settleNoticePlan(durableNoticePlan);

        return true;
      },
    });
  }

  private async handleInvitationAccessMembershipUpdate(params: {
    chatId: string;
    messageId: string;
    update: MaxUpdate;
    settings: Pick<ChatSettings, 'invitationAccessEnabled' | 'invitationAccessRequiredCount'>;
  }): Promise<void> {
    if (!isInvitationAccessCurrentlyActive(params.settings)) {
      return;
    }

    if (params.update.membership?.action !== 'added') {
      return;
    }

    const inviterId = this.extractInvitationAccessInviterId(params.update);
    if (!inviterId) {
      return;
    }

    const invitedUserIds = this.extractInvitationAccessJoinedUserIds(params.update, inviterId);
    if (invitedUserIds.length === 0) {
      return;
    }

    const requiredCount = this.normalizeInvitationAccessRequiredCount(
      params.settings.invitationAccessRequiredCount,
    );
    const progress = await this.addInvitationAccessInvites({
      chatId: params.chatId,
      userId: inviterId,
      invitedUserIds,
      requiredCount,
    });

    if (progress.addedInviteeUserIds.length === 0) {
      return;
    }

    await this.createBotModerationEvent({
      data: {
        chatId: params.chatId,
        userId: inviterId,
        messageId: params.messageId,
        eventType: EventType.SYSTEM,
        ruleCode: `${INVITATION_ACCESS_RULE_CODE}_PROGRESS`,
        action: SanctionAction.NONE,
        maskedExcerpt: null,
        score: progress.completed ? 0 : 0.1,
        operator: Operator.BOT,
        metadata: {
          reason: 'Invitation access progress updated',
          addedInviteeUserIds: progress.addedInviteeUserIds,
          invitedUserIds: progress.invitedUserIds,
          invitedCount: progress.invitedCount,
          requiredCount,
          completed: progress.completed,
          completedAt: progress.completedAt?.toISOString() ?? null,
        },
      },
    });
  }

  private async handleInvitationAccessMessage(params: {
    chatId: string;
    userId: string;
    userLabel: string;
    messageId: string;
    text: string;
    createdAt: string;
    hotChatBackoffActive: boolean;
    systemMode: SystemModeSnapshot;
    settings: Pick<
      ChatSettings,
      | 'invitationAccessEnabled'
      | 'invitationAccessRequiredCount'
      | 'invitationAccessBotMessageEnabled'
      | 'invitationAccessBotMessageText'
      | 'invitationAccessAdminContactButtonEnabled'
      | 'invitationAccessAdminContactButtonUrl'
      | 'invitationAccessWarnEnabled'
      | 'invitationAccessWarnMessageText'
      | 'invitationAccessBanEnabled'
      | 'invitationAccessMuteEnabled'
      | 'invitationAccessMuteDurationHours'
      | 'botSpeechStyle'
      | 'botSpeechMedia'
      | 'rulesAttachViolationsEnabled'
      | 'deleteBotMessagesEnabled'
      | 'deleteBotMessagesDelayMinutes'
    >;
    rulesPublishedUrl: string | null;
    rulesPublishedMessageId: string | null;
    hotPathProfile?: WebhookHotPathProfile | null;
  }): Promise<boolean> {
    if (!isInvitationAccessCurrentlyActive(params.settings)) {
      return false;
    }

    const requiredCount = this.normalizeInvitationAccessRequiredCount(
      params.settings.invitationAccessRequiredCount,
    );
    const progress = await this.getInvitationAccessProgress(params.chatId, params.userId);
    if (progress.invitedCount >= requiredCount) {
      return false;
    }

    const deleteIntent: EnsureModerationDeleteIntentInput = {
      chatId: params.chatId,
      messageId: params.messageId,
      reasonKey: `${INVITATION_ACCESS_RULE_CODE}:message-delete`,
      ruleCode: `${INVITATION_ACCESS_RULE_CODE}_DELETE`,
      subjectUserId: params.userId,
      sourceMessageAt: params.createdAt,
      entityType: 'CHAT',
      messageAuthorKind: 'user',
      event: {
        userId: params.userId,
        eventType: 'MESSAGE',
        maskedExcerpt: maskText(params.text),
        score: 1,
        metadata: {
          action: SanctionAction.DELETE_MESSAGE,
          invitedCount: progress.invitedCount,
          requiredCount,
          remainingInvites: Math.max(0, requiredCount - progress.invitedCount),
        },
      },
    };
    await this.ensureModerationDeleteIntent(deleteIntent);

    const claimed = await this.claimAndPersistMessageScopedModerationViolation({
      chatId: params.chatId,
      userId: params.userId,
      messageId: params.messageId,
      ruleCode: INVITATION_ACCESS_RULE_CODE,
      score: 1,
    });
    if (!claimed) {
      return true;
    }

    const deleteResult = await this.executeModerationDelete(deleteIntent);
    const messageDeleted = deleteResult.gone;
    this.markWebhookHotPathStage(params.hotPathProfile, 'invitation-access.delete');

    const invitationAccessViolationCount24h = await this.countRecentInvitationAccessViolations(
      params.chatId,
      params.userId,
    );
    const action = this.resolveRequiredSubscriptionEscalationAction(
      invitationAccessViolationCount24h,
      {
        warnEnabled: params.settings.invitationAccessWarnEnabled,
        banEnabled: params.settings.invitationAccessBanEnabled,
        muteEnabled: params.settings.invitationAccessMuteEnabled,
      },
    );
    const isFirstInvitationAccessViolation = invitationAccessViolationCount24h === 1;

    if (deleteResult.deleted && !deleteResult.eventPersistedByIntent) {
      await this.createBotModerationEvent({
        data: {
          chatId: params.chatId,
          userId: params.userId,
          messageId: params.messageId,
          eventType: EventType.MESSAGE,
          ruleCode: `${INVITATION_ACCESS_RULE_CODE}_DELETE`,
          action: SanctionAction.DELETE_MESSAGE,
          maskedExcerpt: maskText(params.text),
          score: 1,
          operator: Operator.BOT,
          metadata: {
            action: SanctionAction.DELETE_MESSAGE,
            invitedCount: progress.invitedCount,
            requiredCount,
            remainingInvites: Math.max(0, requiredCount - progress.invitedCount),
          },
        },
      });
    }

    const invitationAccessMessageOptions =
      this.buildBotMessageOptions(
        params.chatId,
        [],
        false,
        '',
        DEFAULT_BOT_BUTTON_TEXT,
        params.settings.rulesAttachViolationsEnabled,
        params.rulesPublishedUrl,
        params.rulesPublishedMessageId,
      ) ?? undefined;

    const sendInvitationAccessBotMessage = async (
      textValue: string,
      mediaFieldKey?: BotSpeechMediaFieldKey,
    ) =>
      this.sendBotMessageWithOptionalAutoDelete({
        chatId: params.chatId,
        text: textValue,
        messageOptions: withMarketplaceModerationMessage(
          invitationAccessMessageOptions,
          params.chatId,
          'MODERATION_NOTICE',
          'INVITATION_ACCESS',
        ),
        media: this.resolveBotSpeechMedia(params.settings, mediaFieldKey),
        deleteBotMessagesEnabled: params.settings.deleteBotMessagesEnabled,
        deleteBotMessagesDelayMinutes: params.settings.deleteBotMessagesDelayMinutes,
      });
    const invitationAccessNoticeSkipReason = this.resolveOptionalWebhookStageSkipReason({
      stage: 'invitation-access.notice',
      hotPathProfile: params.hotPathProfile,
      systemMode: params.systemMode,
      hotChatBackoffActive: params.hotChatBackoffActive,
      minRemainingMs: REQUIRED_SUBSCRIPTION_NOTICE_MIN_REMAINING_MS,
    });
    const canSendInvitationAccessNotice = !invitationAccessNoticeSkipReason;
    if (invitationAccessNoticeSkipReason) {
      this.recordOptionalWebhookStageSkip({
        stage: 'invitation-access.notice',
        reason: invitationAccessNoticeSkipReason,
      });
    }

    if (action === SanctionAction.NONE) {
      if (
        isFirstInvitationAccessViolation &&
        params.settings.invitationAccessBotMessageEnabled &&
        canSendInvitationAccessNotice
      ) {
        const noticeOnCooldown = await this.hasInvitationAccessNoticeCooldown(
          params.chatId,
          params.userId,
        );
        if (!noticeOnCooldown) {
          try {
            const sent = await sendInvitationAccessBotMessage(
              await this.appendAdminContactMarkdownLink(
                params.chatId,
                this.buildInvitationAccessExplanation(
                  params.userLabel,
                  messageDeleted,
                  requiredCount,
                  progress.invitedCount,
                  params.settings.invitationAccessBotMessageText,
                  params.settings.botSpeechStyle,
                ),
                params.settings.invitationAccessAdminContactButtonEnabled,
                params.settings.invitationAccessAdminContactButtonUrl,
              ),
              'invitationAccessBotMessageText',
            );
            if (sent) {
              await this.markInvitationAccessNoticeSent(params.chatId, params.userId);
            }
          } catch (error: unknown) {
            this.logger.warn(
              {
                chatId: params.chatId,
                userId: params.userId,
                messageId: params.messageId,
                error: error instanceof Error ? error.message : 'Unknown error',
              },
              'Failed to send invitation access explanation message',
            );
          }
        }
      }
    } else if (action === SanctionAction.WARN && canSendInvitationAccessNotice) {
      try {
        await sendInvitationAccessBotMessage(
          await this.appendAdminContactMarkdownLink(
            params.chatId,
            this.buildInvitationAccessWarnExplanation(
              params.userLabel,
              requiredCount,
              progress.invitedCount,
              params.settings.invitationAccessWarnMessageText,
              params.settings.botSpeechStyle,
            ),
            params.settings.invitationAccessAdminContactButtonEnabled,
            params.settings.invitationAccessAdminContactButtonUrl,
          ),
          'invitationAccessWarnMessageText',
        );
      } catch (error: unknown) {
        this.logger.warn(
          {
            chatId: params.chatId,
            userId: params.userId,
            messageId: params.messageId,
            error: error instanceof Error ? error.message : 'Unknown error',
          },
          'Failed to send invitation access warning message',
        );
      }
    }

    const sanctionUserLabel =
      action === SanctionAction.MUTE || action === SanctionAction.BAN
        ? await this.resolveSanctionUserLabel(params.chatId, params.userId, params.userLabel)
        : params.userLabel;
    const persistModerationEvent = (
      metadataPatch: Record<string, unknown> = {},
      actionOverride: SanctionAction = action,
    ) =>
      this.createBotModerationEvent({
        data: {
          chatId: params.chatId,
          userId: params.userId,
          messageId: params.messageId,
          eventType: EventType.MESSAGE,
          ruleCode: INVITATION_ACCESS_RULE_CODE,
          action: actionOverride,
          maskedExcerpt: maskText(params.text),
          score: 1,
          operator: Operator.BOT,
          metadata: {
            action: actionOverride,
            invitedCount: progress.invitedCount,
            requiredCount,
            remainingInvites: Math.max(0, requiredCount - progress.invitedCount),
            invitationAccessViolationCount24h,
            invitationAccessEscalationWindowHours: INVITATION_ACCESS_ESCALATION_WINDOW_HOURS,
            ...metadataPatch,
          },
        },
      });
    let sanctionEventPersisted = false;

    if (action !== SanctionAction.NONE) {
      sanctionEventPersisted = await this.applySanctionAction({
        chatId: params.chatId,
        userId: params.userId,
        action,
        userLabel: sanctionUserLabel,
        messageId: params.messageId,
        muteDurationHours: params.settings.invitationAccessMuteDurationHours,
        deleteBotMessagesEnabled: params.settings.deleteBotMessagesEnabled,
        deleteBotMessagesDelayMinutes: params.settings.deleteBotMessagesDelayMinutes,
        botMessageOptions: withMarketplaceModerationMessage(
          invitationAccessMessageOptions,
          params.chatId,
          'MODERATION_NOTICE',
          'INVITATION_ACCESS',
        ),
        sanctionNoticeText:
          action === SanctionAction.BAN
            ? this.buildInvitationAccessBanExplanation(
                sanctionUserLabel,
                requiredCount,
                progress.invitedCount,
                params.settings.invitationAccessMuteDurationHours,
                params.settings.botSpeechStyle,
              )
            : undefined,
        botSpeechStyle: params.settings.botSpeechStyle,
        trackAsGlobalSpammer: false,
        persistModerationEvent,
      });

      if (action === SanctionAction.MUTE && canSendInvitationAccessNotice) {
        try {
          await sendInvitationAccessBotMessage(
            this.buildInvitationAccessMuteExplanation(
              sanctionUserLabel,
              requiredCount,
              progress.invitedCount,
              params.settings.botSpeechStyle,
            ),
          );
        } catch (error: unknown) {
          this.logger.warn(
            {
              chatId: params.chatId,
              userId: params.userId,
              messageId: params.messageId,
              error: error instanceof Error ? error.message : 'Unknown error',
            },
            'Failed to send invitation access mute message',
          );
        }
      }
    }

    if (!sanctionEventPersisted) {
      await persistModerationDecisionWithoutAppliedSanction(persistModerationEvent, action);
    }

    return true;
  }

  private extractInvitationAccessInviterId(update: MaxUpdate): string {
    const membershipInviterId =
      typeof update.membership?.inviterId === 'string' ? update.membership.inviterId.trim() : '';
    if (membershipInviterId) {
      return membershipInviterId;
    }

    const raw = this.asRecord(update.raw);
    if (!raw) {
      return '';
    }

    const data = this.asRecord(raw.data);
    const event = this.asRecord(raw.event);
    const typePayload = typeof update.type === 'string' ? this.asRecord(raw[update.type]) : null;
    const candidates = [
      raw,
      typePayload,
      data,
      data ? this.asRecord(data[update.type]) : null,
      event,
      event ? this.asRecord(event[update.type]) : null,
    ];

    for (const candidate of candidates) {
      if (!candidate) {
        continue;
      }

      const actor =
        this.asRecord(candidate.inviter) ??
        this.asRecord(candidate.invited_by) ??
        this.asRecord(candidate.actor) ??
        this.asRecord(candidate.initiator);
      const values = [
        candidate.inviter_id,
        candidate.inviterId,
        candidate.invited_by_id,
        candidate.invitedById,
        candidate.actor_id,
        candidate.actorId,
        candidate.initiator_id,
        candidate.initiatorId,
        actor?.id,
        actor?.user_id,
        actor?.userId,
      ];

      for (const value of values) {
        const userId = this.readScalarId(value);
        if (userId) {
          return userId;
        }
      }
    }

    return '';
  }

  private extractInvitationAccessJoinedUserIds(update: MaxUpdate, inviterId: string): string[] {
    const humanUserIds = this.extractHumanServiceMembers(update).map((member) => member.userId);
    const fallbackUserIds =
      update.membership?.action === 'added' ? (update.membership.memberUserIds ?? []) : [];

    return this.normalizeInvitationAccessInviteeUserIds(
      humanUserIds.length > 0 ? humanUserIds : fallbackUserIds,
      inviterId,
    );
  }

  private normalizeInvitationAccessInviteeUserIds(
    userIds: readonly string[],
    inviterId: string,
  ): string[] {
    const normalizedInviterId = inviterId.trim();
    const uniqueUserIds = new Set<string>();

    for (const value of userIds) {
      const userId = typeof value === 'string' ? value.trim() : '';
      if (!userId || userId === normalizedInviterId) {
        continue;
      }
      uniqueUserIds.add(userId);
    }

    return [...uniqueUserIds];
  }

  private readScalarId(value: unknown): string {
    if (typeof value !== 'string' && typeof value !== 'number') {
      return '';
    }

    return String(value).trim();
  }

  private normalizeInvitationAccessRequiredCount(value: number): number {
    const numericValue = Number.isFinite(value)
      ? Math.trunc(value)
      : INVITATION_ACCESS_REQUIRED_COUNT_MIN;
    return Math.min(
      INVITATION_ACCESS_REQUIRED_COUNT_MAX,
      Math.max(INVITATION_ACCESS_REQUIRED_COUNT_MIN, numericValue),
    );
  }

  private async getInvitationAccessProgress(
    chatId: string,
    userId: string,
  ): Promise<InvitationAccessProgressSnapshot> {
    const delegate = this.getInvitationAccessProgressDelegate(this.prisma);
    if (!delegate?.findUnique) {
      return {
        invitedUserIds: [],
        invitedCount: 0,
        completedAt: null,
      };
    }

    const row = await delegate.findUnique({
      where: { chatId_userId: { chatId, userId } },
      select: { invitedUserIds: true, completedAt: true },
    });

    return this.normalizeInvitationAccessProgressSnapshot(row);
  }

  private async addInvitationAccessInvites(params: {
    chatId: string;
    userId: string;
    invitedUserIds: readonly string[];
    requiredCount: number;
  }): Promise<InvitationAccessProgressUpdateResult> {
    const normalizedInviteeUserIds = this.normalizeInvitationAccessInviteeUserIds(
      params.invitedUserIds,
      params.userId,
    );

    if (normalizedInviteeUserIds.length === 0) {
      const current = await this.getInvitationAccessProgress(params.chatId, params.userId);
      return {
        ...current,
        addedInviteeUserIds: [],
        completed: current.invitedCount >= params.requiredCount,
      };
    }

    return this.runInvitationAccessProgressTransaction(async (client) => {
      const delegate = this.getInvitationAccessProgressDelegate(client);
      if (!delegate?.findUnique || !delegate.create || !delegate.update) {
        return {
          invitedUserIds: [],
          invitedCount: 0,
          completedAt: null,
          addedInviteeUserIds: [],
          completed: false,
        };
      }

      const existing = await delegate.findUnique({
        where: { chatId_userId: { chatId: params.chatId, userId: params.userId } },
        select: { invitedUserIds: true, completedAt: true },
      });
      const existingSnapshot = this.normalizeInvitationAccessProgressSnapshot(existing);
      const existingInviteeUserIds = new Set(existingSnapshot.invitedUserIds);
      const addedInviteeUserIds = normalizedInviteeUserIds.filter(
        (inviteeUserId) => !existingInviteeUserIds.has(inviteeUserId),
      );
      const nextInvitedUserIds = Array.from(
        new Set([...existingSnapshot.invitedUserIds, ...normalizedInviteeUserIds]),
      );
      const completed = nextInvitedUserIds.length >= params.requiredCount;
      const shouldMarkCompleted = completed && !existingSnapshot.completedAt;
      const completedAt = shouldMarkCompleted ? new Date() : existingSnapshot.completedAt;

      const select = { invitedUserIds: true, completedAt: true } as const;
      const row = existing
        ? await delegate.update({
            where: { chatId_userId: { chatId: params.chatId, userId: params.userId } },
            data: {
              invitedUserIds: { set: nextInvitedUserIds },
              ...(shouldMarkCompleted ? { completedAt: completedAt ?? new Date() } : {}),
            },
            select,
          })
        : await delegate.create({
            data: {
              chatId: params.chatId,
              userId: params.userId,
              invitedUserIds: nextInvitedUserIds,
              ...(completedAt ? { completedAt } : {}),
            },
            select,
          });
      const snapshot = this.normalizeInvitationAccessProgressSnapshot(row);

      return {
        ...snapshot,
        addedInviteeUserIds,
        completed: snapshot.invitedCount >= params.requiredCount,
      };
    });
  }

  private async runInvitationAccessProgressTransaction<T>(
    operation: (client: unknown) => Promise<T>,
  ): Promise<T> {
    const prisma = this.prisma as unknown as {
      $transaction?: <R>(
        callback: (client: unknown) => Promise<R>,
        options?: { isolationLevel?: Prisma.TransactionIsolationLevel },
      ) => Promise<R>;
    };

    if (typeof prisma.$transaction !== 'function') {
      return operation(this.prisma);
    }

    const maxAttempts = 3;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        return await prisma.$transaction(operation, {
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        });
      } catch (error: unknown) {
        if (attempt >= maxAttempts || !this.isPrismaSerializationFailure(error)) {
          throw error;
        }
      }
    }

    return operation(this.prisma);
  }

  private isPrismaSerializationFailure(error: unknown): boolean {
    const code =
      error && typeof error === 'object' && 'code' in error
        ? String((error as { code?: unknown }).code)
        : '';
    if (code === 'P2034') {
      return true;
    }

    const message = error instanceof Error ? error.message : '';
    return message.toLowerCase().includes('could not serialize access');
  }

  private getInvitationAccessProgressDelegate(
    client: unknown,
  ): InvitationAccessProgressDelegate | null {
    const delegate =
      client && typeof client === 'object'
        ? (client as { chatInvitationAccessProgress?: unknown }).chatInvitationAccessProgress
        : null;
    if (!delegate || typeof delegate !== 'object') {
      return null;
    }

    return delegate as InvitationAccessProgressDelegate;
  }

  private normalizeInvitationAccessProgressSnapshot(
    row: { invitedUserIds: string[]; completedAt: Date | null } | null,
  ): InvitationAccessProgressSnapshot {
    const invitedUserIds = Array.from(
      new Set(
        (Array.isArray(row?.invitedUserIds) ? row.invitedUserIds : [])
          .map((item) => (typeof item === 'string' ? item.trim() : ''))
          .filter((item) => item.length > 0),
      ),
    );

    return {
      invitedUserIds,
      invitedCount: invitedUserIds.length,
      completedAt: row?.completedAt ?? null,
    };
  }

  private readRequiredSubscriptionChannelIds(value: Prisma.JsonValue): string[] {
    if (!Array.isArray(value)) {
      return [];
    }

    return Array.from(
      new Set(
        value
          .map((item) => (typeof item === 'string' ? item.trim() : ''))
          .filter((item) => item.length > 0),
      ),
    ).slice(0, REQUIRED_SUBSCRIPTION_MAX_CHANNELS);
  }

  private async resolveRequiredSubscriptionMembershipWithHotPathBudget(params: {
    chatId: string;
    userId: string;
    requiredChannelIds: readonly string[];
    hotPathProfile?: WebhookHotPathProfile | null;
  }): Promise<RequiredSubscriptionMembershipResult | null> {
    const waitMs = this.resolveWebhookFollowUpWaitBudgetMs({
      hotPathProfile: params.hotPathProfile,
      maxWaitMs: REQUIRED_SUBSCRIPTION_MEMBERSHIP_HOT_PATH_TIMEOUT_MS,
      minRemainingMs: REQUIRED_SUBSCRIPTION_MEMBERSHIP_MIN_REMAINING_MS,
    });
    if (waitMs <= 0) {
      void this.runtimeDiagnosticsService?.recordHotPathStageOutcome({
        stage: 'required-subscription.membership.deferred',
        outcome: 'skip',
        failOpen: true,
      });
      return null;
    }

    let timedOut = false;
    const result = await raceWithTimeout({
      operation: () =>
        this.resolveRequiredSubscriptionMembership(
          params.chatId,
          params.userId,
          params.requiredChannelIds,
        ),
      timeoutMs: waitMs,
      onTimeout: () => {
        timedOut = true;
        return null;
      },
    });
    if (timedOut) {
      void this.runtimeDiagnosticsService?.recordHotPathStageOutcome({
        stage: 'required-subscription.membership.deferred',
        outcome: 'skip',
        failOpen: true,
      });
      this.logger.debug(
        {
          chatId: params.chatId,
          userId: params.userId,
          channelCount: params.requiredChannelIds.length,
          timeoutMs: waitMs,
        },
        'Required subscription membership checks exceeded hot-path budget; continuing fail-open',
      );
    }

    return result;
  }

  private async resolveRequiredSubscriptionMembership(
    chatId: string,
    userId: string,
    requiredChannelIds: readonly string[],
  ): Promise<RequiredSubscriptionMembershipResult> {
    const membershipChecks = await this.mapWithConcurrency(
      requiredChannelIds,
      this.requiredSubscriptionLookupConcurrency,
      async (channelId) => ({
        channelId,
        resolution: await this.getRequiredSubscriptionMembershipResolution(channelId, userId),
      }),
    );
    const membershipsByChannelId = new Map(
      membershipChecks.map((item) => [item.channelId, item.resolution.membership] as const),
    );
    const resolutionsByChannelId = new Map(
      membershipChecks.map((item) => [item.channelId, item.resolution] as const),
    );
    const terminalChannelIds = new Set(
      membershipChecks.filter((item) => item.resolution.terminal).map((item) => item.channelId),
    );
    const unconfirmedChannelIds = membershipChecks
      .filter((item) => item.resolution.membership !== true && !item.resolution.fresh)
      .map((item) => item.channelId);
    if (unconfirmedChannelIds.length > 0) {
      const retriedChecks = await this.mapWithConcurrency(
        unconfirmedChannelIds,
        this.requiredSubscriptionLookupConcurrency,
        async (channelId) => ({
          channelId,
          resolution: await this.getRequiredSubscriptionMembershipResolution(channelId, userId, {
            forceFresh: true,
            allowStaleOnError: false,
          }),
        }),
      );
      for (const retriedCheck of retriedChecks) {
        resolutionsByChannelId.set(retriedCheck.channelId, retriedCheck.resolution);
        membershipsByChannelId.set(retriedCheck.channelId, retriedCheck.resolution.membership);
        if (retriedCheck.resolution.terminal) {
          terminalChannelIds.add(retriedCheck.channelId);
        } else {
          terminalChannelIds.delete(retriedCheck.channelId);
        }
      }
    }

    const unresolvedChannelIds = requiredChannelIds.filter(
      (channelId) => membershipsByChannelId.get(channelId) === null,
    );
    for (const channelId of this.resolveRequiredSubscriptionTerminalChannelIds(
      unresolvedChannelIds,
    )) {
      terminalChannelIds.add(channelId);
    }
    const unresolvedNonTerminalChannelIds = unresolvedChannelIds.filter(
      (channelId) => !terminalChannelIds.has(channelId),
    );
    if (unresolvedNonTerminalChannelIds.length > 0) {
      this.logRequiredSubscriptionUnresolved({
        chatId,
        userId,
        unresolvedChannelIds: unresolvedNonTerminalChannelIds,
        terminalChannelIds: [...terminalChannelIds],
        checkedChannelCount: requiredChannelIds.length,
      });
    }
    const unresolvedTerminalChannelIds = unresolvedChannelIds.filter((channelId) =>
      terminalChannelIds.has(channelId),
    );
    if (unresolvedTerminalChannelIds.length > 0) {
      this.logRequiredSubscriptionUnresolved({
        chatId,
        userId,
        unresolvedChannelIds: unresolvedTerminalChannelIds,
        terminalChannelIds: [...terminalChannelIds],
        checkedChannelCount: requiredChannelIds.length,
      });
    }

    const missingChannelIds = requiredChannelIds.filter(
      (channelId) => membershipsByChannelId.get(channelId) === false,
    );

    const localQuotaResolution = unresolvedNonTerminalChannelIds
      .map((channelId) => resolutionsByChannelId.get(channelId)?.localQuotaResolution)
      .find(isMaxMembershipLookupLocalQuotaResolution);
    return {
      missingChannelIds,
      unresolvedChannelIds,
      terminalChannelIds: [...terminalChannelIds],
      ...(localQuotaResolution ? { localQuotaResolution } : {}),
    };
  }

  private resolveRequiredSubscriptionTerminalChannelIds(channelIds: readonly string[]): string[] {
    if (!this.membershipLookupService || channelIds.length === 0) {
      return [];
    }

    const lookupService = this.membershipLookupService as Partial<
      Pick<MaxMembershipLookupService, 'getLookupIssue'>
    >;
    if (typeof lookupService.getLookupIssue !== 'function') {
      return [];
    }

    return channelIds.filter(
      (channelId) =>
        lookupService.getLookupIssue?.(channelId, 'moderation_required_subscription')?.kind ===
        'terminal',
    );
  }

  private async resolveRequiredSubscriptionNoticeChannels(params: {
    channels: readonly RequiredSubscriptionChannelMetadata[];
    channelIdsNeedingRefresh: readonly string[];
  }): Promise<RequiredSubscriptionChannelMetadata[]> {
    const channelIdsNeedingRefresh = Array.from(
      new Set(params.channelIdsNeedingRefresh.map((channelId) => channelId.trim()).filter(Boolean)),
    );
    if (channelIdsNeedingRefresh.length === 0) {
      return [...params.channels];
    }

    const refreshedChannels = await this.resolveRequiredSubscriptionChannels(
      channelIdsNeedingRefresh,
      { allowRemoteFetch: true },
    );
    const refreshedChannelsById = new Map(
      refreshedChannels.map((channel) => [channel.id, channel] as const),
    );

    return params.channels.map((channel) => refreshedChannelsById.get(channel.id) ?? channel);
  }

  private logRequiredSubscriptionUnresolved(params: {
    chatId: string;
    userId: string;
    unresolvedChannelIds: string[];
    terminalChannelIds: string[];
    checkedChannelCount: number;
  }): void {
    const cacheKey = [
      params.chatId,
      params.userId,
      ...params.unresolvedChannelIds.slice().sort(),
    ].join(':');
    const now = Date.now();
    const lastLoggedAtMs = this.requiredSubscriptionUnresolvedLogAtMs.get(cacheKey) ?? 0;
    if (now - lastLoggedAtMs < REQUIRED_SUBSCRIPTION_UNRESOLVED_LOG_INTERVAL_MS) {
      return;
    }

    this.requiredSubscriptionUnresolvedLogAtMs.set(cacheKey, now);
    this.logger.warn(
      {
        chatId: params.chatId,
        userId: params.userId,
        unresolvedChannelIds: params.unresolvedChannelIds,
        terminalChannelIds: params.terminalChannelIds,
        checkedChannelCount: params.checkedChannelCount,
      },
      'Required subscription checks remained unresolved after strict retry; failing open for unresolved targets',
    );
  }

  private async getRequiredSubscriptionMembership(
    channelId: string,
    userId: string,
    options: RequiredSubscriptionMembershipLookupOptions = {},
  ): Promise<boolean | null> {
    const resolution = await this.getRequiredSubscriptionMembershipResolution(
      channelId,
      userId,
      options,
    );
    return resolution.membership;
  }

  private async getRequiredSubscriptionMembershipResolution(
    channelId: string,
    userId: string,
    options: RequiredSubscriptionMembershipLookupOptions = {},
  ): Promise<RequiredSubscriptionMembershipResolution> {
    if (this.membershipLookupService) {
      const lookupOptions = {
        ...(options.forceFresh ? { forceRefresh: true } : {}),
        ...(options.allowStaleOnError !== undefined
          ? { allowStaleOnError: options.allowStaleOnError }
          : {}),
      };
      const lookupService = this.membershipLookupService as Partial<
        Pick<MaxMembershipLookupService, 'getMembership' | 'getMembershipResolution'>
      >;
      if (typeof lookupService.getMembershipResolution === 'function') {
        const resolution = await lookupService.getMembershipResolution(
          channelId,
          userId,
          'moderation_required_subscription',
          lookupOptions,
        );
        return {
          membership: resolution.membership,
          fresh: resolution.fresh,
          ...(isMaxMembershipLookupLocalQuotaResolution(resolution)
            ? { localQuotaResolution: resolution }
            : {}),
          terminal:
            resolution.membership === null &&
            this.isRequiredSubscriptionTerminalLookupIssue(channelId),
        };
      }

      let membership: boolean | null;
      if (options.forceFresh || options.allowStaleOnError !== undefined) {
        membership = await this.membershipLookupService.getMembership(
          channelId,
          userId,
          'moderation_required_subscription',
          lookupOptions,
        );
      } else {
        membership = await this.membershipLookupService.getMembership(
          channelId,
          userId,
          'moderation_required_subscription',
        );
      }
      return {
        membership,
        fresh: options.forceFresh === true && membership !== null,
        terminal: membership === null && this.isRequiredSubscriptionTerminalLookupIssue(channelId),
      };
    }

    const allowStaleOnError = options.allowStaleOnError === true;
    const cacheKey = this.buildRequiredSubscriptionMembershipCacheKey(channelId, userId);
    const now = Date.now();
    const memoryCached = this.requiredSubscriptionMembershipCache.get(cacheKey);
    if (options.forceFresh) {
      const lookup = await this.performRequiredSubscriptionMembershipLookup(channelId, userId, {
        allowStaleOnError,
        cachedMembership: memoryCached?.isMember ?? null,
      });
      return {
        membership: lookup.membership,
        fresh: lookup.membership !== null,
        terminal: lookup.terminal,
      };
    }
    if (memoryCached && memoryCached.expiresAt > now) {
      return {
        membership: memoryCached.isMember,
        fresh: memoryCached.fresh,
        terminal: false,
      };
    }

    const cached = await this.redisCounter?.getString(cacheKey);
    if (cached === '1') {
      this.requiredSubscriptionMembershipCache.set(cacheKey, {
        isMember: true,
        fresh: false,
        expiresAt: now + REQUIRED_SUBSCRIPTION_MEMBER_PRESENT_TTL_SEC * 1_000,
      });
      return {
        membership: true,
        fresh: false,
        terminal: false,
      };
    }
    if (cached === '0') {
      this.requiredSubscriptionMembershipCache.set(cacheKey, {
        isMember: false,
        fresh: false,
        expiresAt: now + REQUIRED_SUBSCRIPTION_MEMBER_MISSING_TTL_SEC * 1_000,
      });
      return {
        membership: false,
        fresh: false,
        terminal: false,
      };
    }

    const backoffUntilMs = this.requiredSubscriptionMembershipBackoffUntilMs.get(cacheKey) ?? 0;
    if (backoffUntilMs > now) {
      return {
        membership: allowStaleOnError ? (memoryCached?.isMember ?? null) : null,
        fresh: false,
        terminal: false,
      };
    }

    const inFlight = this.requiredSubscriptionMembershipInFlight.get(cacheKey);
    if (inFlight) {
      const lookup = await inFlight;
      return {
        membership: lookup.membership,
        fresh: lookup.membership !== null,
        terminal: lookup.terminal,
      };
    }

    const lookupPromise = (async () => {
      try {
        const isMember = await this.maxClient.hasChatMember(channelId, userId, {
          trafficClass: 'critical',
          timeoutMs: 2_000,
          sourceTag: MAX_API_SOURCE_TAGS.REQUIRED_SUBSCRIPTION_MEMBERSHIP,
        });
        const ttlSec = isMember
          ? REQUIRED_SUBSCRIPTION_MEMBER_PRESENT_TTL_SEC
          : REQUIRED_SUBSCRIPTION_MEMBER_MISSING_TTL_SEC;
        this.requiredSubscriptionMembershipCache.set(cacheKey, {
          isMember,
          fresh: true,
          expiresAt: Date.now() + ttlSec * 1_000,
        });
        this.requiredSubscriptionMembershipBackoffUntilMs.delete(cacheKey);
        await this.redisCounter?.setStringWithTtl(cacheKey, isMember ? '1' : '0', ttlSec);
        return {
          membership: isMember,
          terminal: false,
        };
      } catch (error: unknown) {
        const transient = this.isTransientMaxApiLookupError(error);
        if (transient) {
          this.requiredSubscriptionMembershipBackoffUntilMs.set(
            cacheKey,
            Date.now() + REQUIRED_SUBSCRIPTION_LOOKUP_BACKOFF_MS,
          );
        }
        this.logger.warn(
          {
            channelId,
            userId,
            backoffMs: transient ? REQUIRED_SUBSCRIPTION_LOOKUP_BACKOFF_MS : 0,
            statusCode: this.extractStatusCode(error),
            code: this.extractMaxErrorCode(error),
            error: error instanceof Error ? error.message : 'Unknown error',
          },
          'Failed to resolve required subscription membership',
        );
        return {
          membership: allowStaleOnError ? (memoryCached?.isMember ?? null) : null,
          terminal: !transient && this.isTerminalRequiredSubscriptionLookupError(error),
        };
      }
    })();
    const trackedLookupPromise = lookupPromise.finally(() => {
      if (this.requiredSubscriptionMembershipInFlight.get(cacheKey) === trackedLookupPromise) {
        this.requiredSubscriptionMembershipInFlight.delete(cacheKey);
      }
    });

    this.requiredSubscriptionMembershipInFlight.set(cacheKey, trackedLookupPromise);
    const lookup = await trackedLookupPromise;
    return {
      membership: lookup.membership,
      fresh: lookup.membership !== null,
      terminal: lookup.terminal,
    };
  }

  private async performRequiredSubscriptionMembershipLookup(
    channelId: string,
    userId: string,
    options: {
      allowStaleOnError?: boolean;
      cachedMembership?: boolean | null;
    } = {},
  ): Promise<RequiredSubscriptionMembershipLookupResult> {
    const normalizedChannelId = channelId.trim();
    const normalizedUserId = userId.trim();
    if (!normalizedChannelId || !normalizedUserId) {
      return { membership: null, terminal: false };
    }

    const cacheKey = this.buildRequiredSubscriptionMembershipCacheKey(
      normalizedChannelId,
      normalizedUserId,
    );
    const cachedMembership =
      typeof options.cachedMembership === 'boolean' ? options.cachedMembership : null;
    try {
      const memberAccessRoute = await this.resolveUnifiedBotRoute({
        purpose: 'member_access',
        chatId: normalizedChannelId,
      });
      const botId =
        memberAccessRoute?.botId ??
        (typeof this.maxBotLinkService?.resolveBotIdForMemberAccess === 'function'
          ? await this.maxBotLinkService.resolveBotIdForMemberAccess({
              chatId: normalizedChannelId,
            })
          : await this.resolveChatReadBotId(normalizedChannelId)) ??
        null;
      const lookupOptions = {
        trafficClass: 'critical' as const,
        timeoutMs: 2_000,
        sourceTag: MAX_API_SOURCE_TAGS.REQUIRED_SUBSCRIPTION_MEMBERSHIP,
        ...(botId ? { botId } : {}),
      };
      const isMember = await this.maxClient.hasChatMember(
        normalizedChannelId,
        normalizedUserId,
        lookupOptions,
      );
      const ttlSec = isMember
        ? REQUIRED_SUBSCRIPTION_MEMBER_PRESENT_TTL_SEC
        : REQUIRED_SUBSCRIPTION_MEMBER_MISSING_TTL_SEC;
      this.requiredSubscriptionMembershipCache.set(cacheKey, {
        isMember,
        fresh: true,
        expiresAt: Date.now() + ttlSec * 1_000,
      });
      this.requiredSubscriptionMembershipBackoffUntilMs.delete(cacheKey);
      await this.redisCounter?.setStringWithTtl(cacheKey, isMember ? '1' : '0', ttlSec);
      return {
        membership: isMember,
        terminal: false,
      };
    } catch (error: unknown) {
      const transient = this.isTransientMaxApiLookupError(error);
      if (transient) {
        this.requiredSubscriptionMembershipBackoffUntilMs.set(
          cacheKey,
          Date.now() + REQUIRED_SUBSCRIPTION_LOOKUP_BACKOFF_MS,
        );
      }
      this.logger.warn(
        {
          channelId: normalizedChannelId,
          userId: normalizedUserId,
          backoffMs: transient ? REQUIRED_SUBSCRIPTION_LOOKUP_BACKOFF_MS : 0,
          statusCode: this.extractStatusCode(error),
          code: this.extractMaxErrorCode(error),
          error: error instanceof Error ? error.message : 'Unknown error',
        },
        'Failed to resolve required subscription membership',
      );
      return {
        membership: options.allowStaleOnError === true ? cachedMembership : null,
        terminal: !transient && this.isTerminalRequiredSubscriptionLookupError(error),
      };
    }
  }

  private isRequiredSubscriptionTerminalLookupIssue(channelId: string): boolean {
    if (!this.membershipLookupService) {
      return false;
    }

    const lookupService = this.membershipLookupService as Partial<
      Pick<MaxMembershipLookupService, 'getLookupIssue'>
    >;
    if (typeof lookupService.getLookupIssue !== 'function') {
      return false;
    }

    return (
      lookupService.getLookupIssue(channelId, 'moderation_required_subscription')?.kind ===
      'terminal'
    );
  }

  private isTerminalRequiredSubscriptionLookupError(error: unknown): boolean {
    const status = this.extractStatusCode(error);
    if (status === 403 || status === 404) {
      return true;
    }

    const code = this.extractMaxErrorCode(error);
    if (code === 'chat.denied' || code === 'chat.not.found') {
      return true;
    }

    const message = this.extractMaxErrorMessage(error);
    return message.includes('bot is not a chat member') || message.includes('chat not found');
  }

  private async resolveRequiredSubscriptionChannels(
    channelIds: readonly string[],
    options: {
      allowRemoteFetch?: boolean;
    } = {},
  ): Promise<RequiredSubscriptionChannelMetadata[]> {
    const allowRemoteFetch = options.allowRemoteFetch === true;
    const resolvedMetadataById = new Map<string, RequiredSubscriptionChannelMetadata>();
    const unresolvedChannelIds: string[] = [];
    for (const channelId of channelIds) {
      const cachedMetadata = this.readCachedRequiredSubscriptionChannelMetadata(
        channelId,
        allowRemoteFetch,
      );
      if (cachedMetadata) {
        resolvedMetadataById.set(channelId, cachedMetadata);
        continue;
      }

      unresolvedChannelIds.push(channelId);
    }

    const persistedChats =
      unresolvedChannelIds.length > 0 && typeof this.prisma.chat.findMany === 'function'
        ? await this.prisma.chat.findMany({
            where: {
              id: {
                in: unresolvedChannelIds,
              },
            },
            select: {
              id: true,
              title: true,
              entityType: true,
            },
          })
        : [];
    const persistedChatsById = new Map(persistedChats.map((chat) => [chat.id, chat] as const));
    const resolvedFreshMetadata = await this.mapWithConcurrency(
      unresolvedChannelIds,
      2,
      async (channelId) => {
        const persistedChat = persistedChatsById.get(channelId) ?? null;
        const cachedChannelHeader = await this.chatContextCache?.getManagedEntityHeader(
          channelId,
          'channel',
        );
        const cachedChatHeader =
          cachedChannelHeader ??
          (await this.chatContextCache?.getManagedEntityHeader(channelId, 'chat'));
        const cached = cachedChannelHeader ?? cachedChatHeader;
        const cachedEntityType = this.readLowerString(cached?.entityType ?? '');
        const cachedTitle = this.readRequiredSubscriptionChannelTitle(
          channelId,
          cached?.title ?? '',
        );
        const cachedLink = this.normalizeBotButtonUrl(cached?.link ?? '');
        const persistedChatLooksLikeChat = persistedChat?.entityType === ChatEntityType.CHAT;
        const cachedLooksLikeChat = cachedEntityType === 'chat';
        const cachedLooksLikeChannel = cachedEntityType === 'channel';
        const fallbackLooksLikeChat =
          cachedLooksLikeChat || (!cachedLooksLikeChannel && persistedChatLooksLikeChat);
        const fallbackTitle =
          cachedTitle ||
          persistedChat?.title?.trim() ||
          (fallbackLooksLikeChat ? `Чат ${channelId}` : `Канал ${channelId}`);
        if (this.isUsableRequiredSubscriptionChannelMetadata(channelId, cachedTitle, cachedLink)) {
          return this.rememberRequiredSubscriptionChannelMetadata({
            id: channelId,
            title: cachedTitle,
            link: cachedLink,
            usable: true,
            checkMembership: true,
          });
        }

        if (!allowRemoteFetch) {
          return this.rememberRequiredSubscriptionChannelMetadata({
            id: channelId,
            title: fallbackTitle,
            link: cachedLink,
            usable: false,
            checkMembership: true,
          });
        }

        try {
          const metadataBotId =
            (typeof cached?.primaryBotId === 'string' && cached.primaryBotId.trim().length > 0
              ? cached.primaryBotId.trim()
              : await this.resolveChatReadBotId(channelId)) ?? null;
          const snapshot = metadataBotId
            ? await this.maxClient.getChatSnapshot(channelId, {
                trafficClass: 'background',
                timeoutMs: 2_500,
                sourceTag: MAX_API_SOURCE_TAGS.REQUIRED_SUBSCRIPTION_METADATA,
                botId: metadataBotId,
              })
            : await this.maxClient.getChatSnapshot(channelId, {
                trafficClass: 'background',
                timeoutMs: 2_500,
                sourceTag: MAX_API_SOURCE_TAGS.REQUIRED_SUBSCRIPTION_METADATA,
              });
          const title =
            this.readRequiredSubscriptionChannelTitle(channelId, snapshot.title ?? '') ||
            fallbackTitle;
          const link = this.normalizeBotButtonUrl(snapshot.link ?? '');
          await this.chatContextCache?.setManagedEntityHeader({
            id: channelId,
            title,
            entityType: snapshot.entityType,
            link,
            participantsCount: snapshot.participantsCount,
            primaryBotId: metadataBotId,
            assignedBots: [],
            sharedMode: 'owned',
            accessDiagnostics: {
              state: 'ok',
              lastDetectedAt: null,
              lastCheckedAt: null,
              freshUntil: null,
              source: 'unknown',
              activeBotCount: 0,
              lostBots: [],
            },
            viewerAccess: {
              state: 'checking',
              reason: null,
              checkedAt: null,
              canEdit: false,
            },
          });
          return this.rememberRequiredSubscriptionChannelMetadata({
            id: channelId,
            title,
            link,
            usable: this.isUsableRequiredSubscriptionChannelMetadata(channelId, title, link),
            checkMembership: true,
          });
        } catch (error: unknown) {
          this.logger.warn(
            {
              channelId,
              error: error instanceof Error ? error.message : 'Unknown error',
            },
            'Failed to resolve required subscription channel metadata',
          );
          return this.rememberRequiredSubscriptionChannelMetadata({
            id: channelId,
            title: fallbackTitle,
            link: cachedLink,
            usable: false,
            checkMembership: true,
          });
        }
      },
    );
    for (const metadata of resolvedFreshMetadata) {
      resolvedMetadataById.set(metadata.id, metadata);
    }

    return channelIds
      .map((channelId) => resolvedMetadataById.get(channelId))
      .filter((channel): channel is RequiredSubscriptionChannelMetadata => channel !== undefined);
  }

  private readCachedRequiredSubscriptionChannelMetadata(
    channelId: string,
    allowRemoteFetch: boolean,
  ): RequiredSubscriptionChannelMetadata | null {
    const cached = this.requiredSubscriptionChannelMetadataCache.get(channelId);
    if (!cached) {
      return null;
    }

    if (cached.expiresAt <= Date.now()) {
      this.requiredSubscriptionChannelMetadataCache.delete(channelId);
      return null;
    }

    if (allowRemoteFetch && !cached.metadata.usable && cached.metadata.checkMembership) {
      return null;
    }

    return cached.metadata;
  }

  private rememberRequiredSubscriptionChannelMetadata(
    metadata: RequiredSubscriptionChannelMetadata,
  ): RequiredSubscriptionChannelMetadata {
    this.requiredSubscriptionChannelMetadataCache.set(metadata.id, {
      expiresAt: Date.now() + REQUIRED_SUBSCRIPTION_CHANNEL_METADATA_CACHE_TTL_MS,
      metadata,
    });
    return metadata;
  }

  private readRequiredSubscriptionChannelTitle(channelId: string, value: string): string {
    const normalized = value.trim();
    if (!normalized || this.isRequiredSubscriptionFallbackTitle(channelId, normalized)) {
      return '';
    }

    return normalized;
  }

  private isRequiredSubscriptionFallbackTitle(channelId: string, title: string): boolean {
    return (
      title === channelId ||
      title === `Канал ${channelId}` ||
      title === `Чат ${channelId}` ||
      title === `Channel ${channelId}` ||
      title === `Chat ${channelId}`
    );
  }

  private isUsableRequiredSubscriptionChannelMetadata(
    channelId: string,
    title: string,
    link: string | null,
  ): boolean {
    return (
      title.trim().length > 0 &&
      !this.isRequiredSubscriptionFallbackTitle(channelId, title.trim()) &&
      typeof link === 'string' &&
      link.trim().length > 0
    );
  }

  private async hasInvitationAccessNoticeCooldown(
    chatId: string,
    userId: string,
  ): Promise<boolean> {
    const cacheKey = this.buildInvitationAccessNoticeCooldownKey(chatId, userId);
    const cached = await this.redisCounter?.getString(cacheKey);
    return cached === '1';
  }

  private async markInvitationAccessNoticeSent(chatId: string, userId: string): Promise<void> {
    const cacheKey = this.buildInvitationAccessNoticeCooldownKey(chatId, userId);
    await this.redisCounter?.setStringWithTtl(cacheKey, '1', INVITATION_ACCESS_NOTICE_COOLDOWN_SEC);
  }

  private buildRequiredSubscriptionMembershipCacheKey(channelId: string, userId: string): string {
    return `required-subscription:member:v1:${channelId}:${userId}`;
  }

  private buildInvitationAccessNoticeCooldownKey(chatId: string, userId: string): string {
    return `invitation-access:notice:v1:${chatId}:${userId}`;
  }

  private isBotStartedUpdate(update: MaxUpdate): boolean {
    return this.readLowerString(update.type) === 'bot_started';
  }

  private isLifecycleNoopUpdate(update: MaxUpdate): boolean {
    const normalizedType = this.readLowerString(update.type);
    return (
      normalizedType === 'chat_title_changed' ||
      normalizedType === 'bot_stopped' ||
      normalizedType === 'dialog_removed' ||
      normalizedType === 'message_removed'
    );
  }

  private isMembershipLeaveUpdate(update: MaxUpdate): boolean {
    const normalizedType = this.readLowerString(update.type);
    return normalizedType === 'user_removed' || normalizedType === 'bot_removed';
  }

  private isBotAddedUpdate(update: MaxUpdate): boolean {
    return this.readLowerString(update.type) === 'bot_added';
  }

  private async handleBlockedBotJoin(update: MaxUpdate, chatId: string): Promise<boolean> {
    if (!this.isBotAddedUpdate(update) || !this.blockedJoinChatIds.has(chatId)) {
      return false;
    }

    await this.maxClient.leaveCurrentChat(chatId, { botId: update.botId });
    await this.prisma.chatAdminAllowlist.deleteMany({
      where: {
        chatId,
      },
    });
    await this.chatContextCache?.invalidate(chatId);

    this.logger.warn(
      {
        chatId,
        updateId: update.updateId,
      },
      'Bot left chat from join denylist after bot_added event',
    );
    return true;
  }

  private async handleBotStartedInstruction(update: MaxUpdate, chatId: string) {
    if (!this.shouldSendBotStartedInstruction(update, chatId)) {
      return;
    }

    try {
      if (this.privateControlService) {
        await this.privateControlService.handleBotStarted(update);
      } else {
        await this.sendPrivateMenu(chatId, this.buildPrivateMenuPromptText());
      }
    } catch (error: unknown) {
      const payload = {
        chatId,
        updateId: update.updateId,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
      if (this.isTerminalWebhookProcessingError(error)) {
        this.logger.debug(
          payload,
          'Skipped bot_started instruction after terminal private dialog error',
        );
        return;
      }

      this.logger.warn(
        {
          ...payload,
        },
        'Failed to send bot_started instruction',
      );
    }
  }

  private shouldSendBotStartedInstruction(update: MaxUpdate, chatId: string): boolean {
    const chatType = this.extractBotStartedChatType(update);
    if (chatType === 'chat') {
      return false;
    }

    const numericChatId = this.parseChatIdAsBigInt(chatId);
    if (numericChatId === null) {
      return false;
    }

    return numericChatId > 0n;
  }

  private extractBotStartedChatType(update: MaxUpdate): string | null {
    const raw = this.asRecord(update.raw);
    if (!raw) {
      return null;
    }

    const data = this.asRecord(raw.data);
    const event = this.asRecord(raw.event);
    const candidates = [
      raw,
      this.asRecord(raw.bot_started),
      data,
      data ? this.asRecord(data.bot_started) : null,
      event,
      event ? this.asRecord(event.bot_started) : null,
    ];

    for (const candidate of candidates) {
      if (!candidate) {
        continue;
      }

      const chat = this.asRecord(candidate.chat);
      const type = this.readLowerString(
        candidate.chat_type ??
          candidate.chatType ??
          chat?.type ??
          chat?.chat_type ??
          chat?.chatType,
      );
      if (type) {
        return type;
      }
    }

    return null;
  }

  private extractBotStartedStartPayload(update: MaxUpdate): string | null {
    const raw = this.asRecord(update.raw);
    if (!raw) {
      return null;
    }

    const data = this.asRecord(raw.data);
    const event = this.asRecord(raw.event);
    const candidates = [
      raw,
      this.asRecord(raw.bot_started),
      data,
      data ? this.asRecord(data.bot_started) : null,
      event,
      event ? this.asRecord(event.bot_started) : null,
    ];

    for (const candidate of candidates) {
      if (!candidate) {
        continue;
      }

      const value =
        candidate.start_payload ?? candidate.startPayload ?? candidate.payload ?? candidate.start;

      if (typeof value === 'string' && value.trim().length > 0) {
        return value.trim();
      }
    }

    return null;
  }

  private parseChatIdAsBigInt(chatId: string): bigint | null {
    if (typeof chatId !== 'string') {
      return null;
    }

    const normalized = chatId.trim();
    if (!/^-?\d+$/.test(normalized)) {
      return null;
    }

    try {
      return BigInt(normalized);
    } catch {
      return null;
    }
  }

  private isPrivateDirectChat(chatId: string): boolean {
    const numericChatId = this.parseChatIdAsBigInt(chatId);
    return numericChatId !== null && numericChatId > 0n;
  }

  private async resolveSharedChatExecutionGuard(
    update: MaxUpdate,
    chatId: string,
  ): Promise<SharedChatExecutionGuard> {
    if (!chatId.trim() || this.isPrivateDirectChat(chatId)) {
      return {
        mode: 'allow',
        activeBotId: this.maxBotContextService?.getActiveBotId() ?? null,
        primaryBotId: null,
        assignedBotIds: [],
        requiresExecutionLock: false,
        lockScope: 'owner',
      };
    }

    const activeBotId = this.maxBotContextService?.getActiveBotId() ?? null;
    if (!activeBotId || !this.maxBotLinkService) {
      return {
        mode: 'allow',
        activeBotId,
        primaryBotId: null,
        assignedBotIds: [],
        requiresExecutionLock: false,
        lockScope: 'owner',
      };
    }

    const executionOwnerBotId = this.readExecutionOwnerBotId(update);
    if (executionOwnerBotId) {
      if (executionOwnerBotId === activeBotId) {
        return {
          mode: 'allow',
          activeBotId,
          primaryBotId: executionOwnerBotId,
          assignedBotIds: [executionOwnerBotId],
          requiresExecutionLock: false,
          lockScope: 'owner',
        };
      }

      if (
        await this.shouldProcessStandbySharedChatUpdateAsRecovery(
          update,
          activeBotId,
          executionOwnerBotId,
        )
      ) {
        return {
          mode: 'allow',
          activeBotId,
          primaryBotId: executionOwnerBotId,
          assignedBotIds: Array.from(new Set([executionOwnerBotId, activeBotId])),
          requiresExecutionLock: true,
          lockScope: 'chat',
        };
      }

      const updateType = this.readLowerString(update.type);
      if (updateType === 'bot_added' && this.blockedJoinChatIds.has(chatId)) {
        return {
          mode: 'blocked-join-check-only',
          activeBotId,
          primaryBotId: executionOwnerBotId,
          assignedBotIds: [executionOwnerBotId],
          reason: 'non-primary-bot',
        };
      }

      return {
        mode: 'skip',
        activeBotId,
        primaryBotId: executionOwnerBotId,
        assignedBotIds: [executionOwnerBotId],
        reason: 'non-primary-bot',
      };
    }

    let executionBinding: ChatBotExecutionBinding;
    try {
      executionBinding = await this.executeSharedChatOperationWithGuard(
        () =>
          this.maxBotLinkService!.getChatExecutionBinding({
            chatId,
            activeBotId,
          }),
        this.sharedChatExecutionLookupTimeoutMs,
        {
          operation: 'binding',
          chatId,
          activeBotId,
          updateId: update.updateId,
        },
      );
    } catch (error: unknown) {
      this.logger.warn(
        {
          chatId,
          activeBotId,
          updateId: update.updateId,
          error: error instanceof Error ? error.message : 'Unknown error',
        },
        'Shared chat execution binding lookup stalled; falling back to a conservative chat-scoped execution lock',
      );
      return {
        mode: 'allow',
        activeBotId,
        primaryBotId: null,
        assignedBotIds: activeBotId ? [activeBotId] : [],
        requiresExecutionLock: true,
        lockScope: 'chat',
      };
    }
    if (executionBinding.shouldHandleGroupUpdate) {
      return {
        mode: 'allow',
        activeBotId: executionBinding.activeBotId,
        primaryBotId: executionBinding.primaryBotId,
        assignedBotIds: executionBinding.assignedBotIds,
        requiresExecutionLock: executionBinding.assignedBotIds.length > 1,
        lockScope: 'owner',
      };
    }

    const updateType = this.readLowerString(update.type);
    const reason =
      executionBinding.activeMembershipStatus === ChatBotMembershipStatus.REMOVED
        ? 'removed-membership'
        : 'non-primary-bot';
    if (updateType === 'bot_added' && this.blockedJoinChatIds.has(chatId)) {
      return {
        mode: 'blocked-join-check-only',
        activeBotId: executionBinding.activeBotId,
        primaryBotId: executionBinding.primaryBotId,
        assignedBotIds: executionBinding.assignedBotIds,
        reason,
      };
    }

    return {
      mode: 'skip',
      activeBotId: executionBinding.activeBotId,
      primaryBotId: executionBinding.primaryBotId,
      assignedBotIds: executionBinding.assignedBotIds,
      reason,
    };
  }

  private async shouldProcessStandbySharedChatUpdateAsRecovery(
    update: MaxUpdate,
    activeBotId: string,
    executionOwnerBotId: string,
  ): Promise<boolean> {
    const updateId = this.readString(update.updateId);
    if (!updateId) {
      return false;
    }

    const webhookEventClient = (
      this.prisma as unknown as {
        webhookEvent?: {
          findFirst?: PrismaService['webhookEvent']['findFirst'];
          findMany?: PrismaService['webhookEvent']['findMany'];
        };
      }
    ).webhookEvent;
    if (typeof webhookEventClient?.findFirst !== 'function') {
      return false;
    }

    const ownerEvent = await webhookEventClient.findFirst({
      where: {
        dedupKey: `${executionOwnerBotId}:${updateId}`,
        botId: executionOwnerBotId,
        OR: [
          {
            status: { in: [WebhookStatus.RECEIVED, WebhookStatus.QUEUED, WebhookStatus.PROCESSED] },
          },
          {
            status: WebhookStatus.FAILED,
            OR: [
              { nextEnqueueAt: { not: null } },
              {
                errorMessage: {
                  startsWith: `${WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINE_PREFIX}:`,
                },
              },
            ],
          },
        ],
      },
      select: {
        id: true,
      },
    });
    if (ownerEvent) {
      return false;
    }

    const semanticKey = buildWebhookSemanticEventKey(update);
    if (semanticKey && typeof webhookEventClient.findMany === 'function') {
      const currentEvent = await webhookEventClient.findFirst({
        where: {
          dedupKey: this.buildWebhookDedupKeyForActiveBot(update, activeBotId),
          botId: activeBotId,
        },
        select: {
          createdAt: true,
        },
      });
      const currentCreatedAt =
        currentEvent && 'createdAt' in currentEvent && currentEvent.createdAt instanceof Date
          ? currentEvent.createdAt
          : new Date();
      const ownerEvents = await webhookEventClient.findMany({
        where: {
          botId: executionOwnerBotId,
          createdAt: {
            gte: new Date(currentCreatedAt.getTime() - SHARED_CHAT_OWNER_EVENT_LOOKUP_WINDOW_MS),
            lte: new Date(currentCreatedAt.getTime() + SHARED_CHAT_OWNER_EVENT_LOOKUP_WINDOW_MS),
          },
          OR: [
            {
              status: {
                in: [WebhookStatus.RECEIVED, WebhookStatus.QUEUED, WebhookStatus.PROCESSED],
              },
            },
            {
              status: WebhookStatus.FAILED,
              OR: [
                { nextEnqueueAt: { not: null } },
                {
                  errorMessage: {
                    startsWith: `${WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINE_PREFIX}:`,
                  },
                },
              ],
            },
          ],
        },
        orderBy: { createdAt: 'desc' },
        take: SHARED_CHAT_OWNER_EVENT_LOOKUP_LIMIT,
        select: {
          normalizedPayload: true,
        },
      });
      if (
        ownerEvents.some(
          (event) => buildWebhookSemanticEventKey(event.normalizedPayload) === semanticKey,
        )
      ) {
        return false;
      }
    }

    this.logger.debug(
      {
        updateId,
        updateType: this.readLowerString(update.type),
        activeBotId,
        executionOwnerBotId,
      },
      'Processing standby shared chat webhook event because owner delivery is absent or terminal',
    );
    return true;
  }

  private buildWebhookDedupKeyForActiveBot(update: MaxUpdate, activeBotId: string): string {
    const updateId = String(update.updateId ?? '').trim();
    return activeBotId ? `${activeBotId}:${updateId}` : updateId;
  }

  private logSharedChatExecutionSkip(
    update: MaxUpdate,
    chatId: string,
    guard: Extract<SharedChatExecutionGuard, { mode: 'skip' | 'blocked-join-check-only' }>,
  ): void {
    this.logger.debug(
      {
        chatId,
        updateId: update.updateId,
        updateType: this.readLowerString(update.type),
        activeBotId: guard.activeBotId,
        primaryBotId: guard.primaryBotId,
        assignedBotIds: guard.assignedBotIds,
        reason: guard.reason,
      },
      'Skipped shared chat update for non-primary bot runtime',
    );
  }

  private buildSharedChatExecutionLockKey(
    update: MaxUpdate,
    chatId: string,
    guard: Extract<SharedChatExecutionGuard, { mode: 'allow' }>,
  ): string {
    const updateId =
      typeof update.updateId === 'string' && update.updateId.trim().length > 0
        ? update.updateId.trim()
        : String(update.updateId ?? '').trim();
    const messageId = update.message?.messageId?.trim() ?? '';
    const callbackId = extractMaxCallbackId(update)?.trim() ?? '';
    const updateType = this.readLowerString(update.type);
    const semanticKey = buildWebhookSemanticEventKey(update);
    const discriminator =
      semanticKey ??
      ((updateType === 'message_created' || updateType === 'message_edited') && messageId
        ? `${updateType}:${messageId}`
        : updateId || callbackId || messageId || `${updateType}:${chatId}`);
    if (guard.lockScope === 'chat') {
      return `shared-chat-execution:v2:chat:${chatId}:${discriminator}`;
    }

    const ownerBotId = guard.primaryBotId ?? guard.activeBotId ?? 'unknown';
    return `shared-chat-execution:v1:${ownerBotId}:${chatId}:${discriminator}`;
  }

  // FLAG: This is the cross-process fence for mirrored webhooks. A Redis timeout must retry after
  // the maximum orphan lifetime; never replace it with a process-local lock or a reentrant token.
  private async acquireSharedChatExecutionLock(
    update: MaxUpdate,
    chatId: string,
    guard: Extract<SharedChatExecutionGuard, { mode: 'allow' }>,
  ): Promise<{ key: string; token: string; mode: 'redis' | 'memory' } | null> {
    const key = this.buildSharedChatExecutionLockKey(update, chatId, guard);
    const acquireLockBeforeDeadline = (
      this.redisCounter as Partial<RedisCounterService> | undefined
    )?.acquireLockBeforeDeadline;

    if (acquireLockBeforeDeadline && this.redisCounter) {
      const token = randomUUID();
      const deadlineAtMs = Date.now() + this.sharedChatExecutionLockTimeoutMs;
      try {
        const acquisition = await this.executeSharedChatOperationWithGuard(
          () =>
            acquireLockBeforeDeadline.call(
              this.redisCounter,
              key,
              token,
              SHARED_CHAT_EXECUTION_LOCK_TTL_MS,
              deadlineAtMs,
            ),
          this.sharedChatExecutionLockTimeoutMs,
          {
            operation: 'lock',
            chatId,
            activeBotId: guard.activeBotId,
            updateId: update.updateId,
            lockKey: key,
          },
        );
        if (acquisition.kind === 'busy') {
          return null;
        }
        if (acquisition.kind === 'deadline_exceeded') {
          throw this.createSharedChatExecutionTimeoutError(
            {
              operation: 'lock',
              chatId,
              activeBotId: guard.activeBotId,
              updateId: update.updateId,
              lockKey: key,
            },
            this.sharedChatExecutionLockTimeoutMs,
          );
        }

        return {
          key,
          token,
          mode: 'redis',
        };
      } catch (error: unknown) {
        void this.releaseSharedChatExecutionLock({ key, token, mode: 'redis' });
        const retryError = this.createSharedChatExecutionLockRetryError(error);
        this.logger.warn(
          {
            key,
            chatId,
            updateId: update.updateId,
            activeBotId: guard.activeBotId,
            retryAfterMs: retryError.retryAfterMs,
            error: retryError.message,
          },
          'Failed to acquire redis shared chat execution lock safely; deferring webhook retry',
        );
        throw retryError;
      }
    }

    if (this.sharedChatExecutionMemoryLocks.has(key)) {
      return null;
    }

    const token = randomUUID();
    this.sharedChatExecutionMemoryLocks.set(key, token);
    return {
      key,
      token,
      mode: 'memory',
    };
  }

  private createSharedChatExecutionLockRetryError(error: unknown): Error & {
    retryAfterMs: number;
    sharedChatExecutionLockRetryable: true;
  } {
    const sourceError = error instanceof Error ? error : new Error('Unknown error');
    const retryError = new Error(sourceError.message, { cause: error }) as Error & {
      code?: string;
      retryAfterMs: number;
      sharedChatExecutionLockRetryable?: boolean;
    };
    const sourceDetails = sourceError as Error & {
      code?: unknown;
      retryAfterMs?: unknown;
    };
    if (typeof sourceDetails.code === 'string') {
      retryError.code = sourceDetails.code;
    }
    retryError.retryAfterMs = Math.max(
      typeof sourceDetails.retryAfterMs === 'number' && Number.isFinite(sourceDetails.retryAfterMs)
        ? Math.trunc(sourceDetails.retryAfterMs)
        : 0,
      SHARED_CHAT_EXECUTION_LOCK_AMBIGUOUS_RETRY_AFTER_MS,
    );
    retryError.sharedChatExecutionLockRetryable = true;
    return retryError as Error & {
      retryAfterMs: number;
      sharedChatExecutionLockRetryable: true;
    };
  }

  private async executeSharedChatOperationWithGuard<T>(
    operation: () => Promise<T>,
    timeoutMs: number,
    context: {
      operation: 'binding' | 'lock';
      chatId: string;
      activeBotId?: string | null;
      updateId?: string | null;
      lockKey?: string;
    },
  ): Promise<T> {
    const operationPromise = operation();
    operationPromise.catch(() => undefined);

    let timeout: NodeJS.Timeout | null = null;
    const timeoutPromise = new Promise<T>((_, reject) => {
      timeout = setTimeout(() => {
        reject(this.createSharedChatExecutionTimeoutError(context, timeoutMs));
      }, timeoutMs);
      timeout.unref?.();
    });

    try {
      return await Promise.race([operationPromise, timeoutPromise]);
    } finally {
      if (timeout) {
        clearTimeout(timeout);
      }
    }
  }

  private createSharedChatExecutionTimeoutError(
    context: {
      operation: 'binding' | 'lock';
      chatId: string;
      activeBotId?: string | null;
      updateId?: string | null;
      lockKey?: string;
    },
    timeoutMs: number,
  ): Error {
    const details =
      context.operation === 'lock'
        ? `lock ${context.lockKey ?? 'unknown'}`
        : `binding ${context.chatId}`;
    const error = new Error(
      `Shared chat execution ${details} timed out after ${timeoutMs}ms`,
    ) as Error & { code?: string };
    error.code = 'ECONNABORTED';
    return error;
  }

  private async releaseSharedChatExecutionLock(lock: {
    key: string;
    token: string;
    mode: 'redis' | 'memory';
  }): Promise<void> {
    if (lock.mode === 'memory') {
      if (this.sharedChatExecutionMemoryLocks.get(lock.key) === lock.token) {
        this.sharedChatExecutionMemoryLocks.delete(lock.key);
      }
      return;
    }

    const releaseLock = (this.redisCounter as Partial<RedisCounterService> | undefined)
      ?.releaseLock;
    if (!releaseLock || !this.redisCounter) {
      return;
    }

    try {
      const releasePromise = Promise.resolve(
        releaseLock.call(this.redisCounter, lock.key, lock.token),
      );
      releasePromise.catch(() => undefined);

      let timeout: NodeJS.Timeout | null = null;
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          reject(
            new Error(
              `Shared chat execution release ${lock.key} timed out after ${this.sharedChatExecutionLockTimeoutMs}ms`,
            ),
          );
        }, this.sharedChatExecutionLockTimeoutMs);
        timeout.unref?.();
      });

      try {
        await Promise.race([releasePromise, timeoutPromise]);
      } finally {
        if (timeout) {
          clearTimeout(timeout);
        }
      }
    } catch (error: unknown) {
      this.logger.warn(
        {
          key: lock.key,
          timeoutMs: this.sharedChatExecutionLockTimeoutMs,
          error: error instanceof Error ? error.message : 'Unknown error',
        },
        'Failed to release redis shared chat execution lock',
      );
    }
  }

  private readExecutionOwnerBotId(update: MaxUpdate): string | null {
    return readExecutionOwnerBotIdFromUpdate(update);
  }

  private async handlePrivateChatControl(update: MaxUpdate): Promise<void> {
    if (!update.message) {
      return;
    }

    const callbackId = extractMaxCallbackId(update);
    const callbackCommand = this.resolvePrivateCallbackCommand(extractMaxCallbackPayload(update));
    if (callbackId) {
      await this.answerCallbackSafe(
        callbackId,
        this.buildPrivateCallbackNotification(callbackCommand),
        update.message.chatId,
      );
    }

    const { chatId, text, senderId } = update.message;

    if (callbackCommand) {
      await this.executePrivateCommand(chatId, callbackCommand);
      return;
    }

    if (senderId && this.isOwnBotSender(senderId)) {
      return;
    }

    const textCommand = this.resolvePrivateTextCommand(text);
    if (textCommand) {
      await this.executePrivateCommand(chatId, textCommand);
      return;
    }

    if (this.looksLikeSlashCommand(text)) {
      await this.sendPrivateMenu(chatId, 'Управление через кнопки ниже.');
      return;
    }

    await this.sendPrivateMenu(chatId, this.buildPrivateMenuPromptText());
  }

  private buildPrivateCallbackNotification(command: PrivateControlCommand | null): string {
    if (command === 'chats') {
      return 'Собираю список чатов';
    }
    if (command === 'channels') {
      return 'Собираю список каналов';
    }
    if (command === 'help') {
      return 'Открываю меню';
    }
    return 'Открываю меню';
  }

  private async answerCallbackSafe(
    callbackId: string,
    notification: string,
    rateLimitEntityId?: string,
    botId?: string,
  ): Promise<void> {
    try {
      await this.maxClient.answerCallback(callbackId, notification, undefined, {
        ignoreFailureMetricStatuses: CALLBACK_TERMINAL_FAILURE_METRIC_STATUSES,
        ...(rateLimitEntityId?.trim() ? { rateLimitEntityId: rateLimitEntityId.trim() } : {}),
        ...(botId?.trim() ? { botId: botId.trim() } : {}),
      });
    } catch (error: unknown) {
      this.logger.debug(
        {
          callbackId,
          error: error instanceof Error ? error.message : 'Unknown error',
        },
        'Failed to answer callback',
      );
    }
  }

  private async handleRulesCallback(
    chatId: string,
    callbackId: string | null,
    sourceMessageId: string | null,
    botId?: string,
  ): Promise<void> {
    const publishedRules = await this.prisma.chatRules?.findUnique?.({
      where: { chatId },
      select: {
        publishedUrl: true,
        publishedMessageId: true,
      },
    });

    const resolvedUrl = await this.resolveRulesPublishedUrl(
      chatId,
      publishedRules?.publishedUrl ?? null,
      publishedRules?.publishedMessageId ?? null,
      botId,
    );
    if (!resolvedUrl) {
      if (callbackId) {
        await this.answerCallbackSafe(callbackId, 'Ссылка на правила пока недоступна', chatId);
      }
      return;
    }

    try {
      if (sourceMessageId?.trim()) {
        await this.maxClient.editMessageInlineKeyboard(
          chatId,
          sourceMessageId,
          null,
          {
            button: {
              text: RULES_BOT_BUTTON_TEXT,
              url: resolvedUrl,
            },
          },
          botId ? { botId } : {},
        );
      }
    } catch (error: unknown) {
      this.logger.warn(
        {
          chatId,
          sourceMessageId,
          error: error instanceof Error ? error.message : 'Unknown error',
        },
        'Failed to convert legacy rules callback button into direct link',
      );
    }

    if (callbackId) {
      await this.answerCallbackSafe(callbackId, 'Кнопка обновлена. Нажмите ещё раз', chatId);
    }
  }

  private resolvePrivateCallbackCommand(payload: string | null): PrivateControlCommand | null {
    if (!payload) {
      return null;
    }

    if (payload === PRIVATE_MENU_CALLBACK_CHATS) {
      return 'chats';
    }
    if (payload === PRIVATE_MENU_CALLBACK_CHANNELS) {
      return 'channels';
    }
    if (payload === PRIVATE_MENU_CALLBACK_HELP) {
      return 'help';
    }
    if (payload === PRIVATE_MENU_CALLBACK_MENU) {
      return 'menu';
    }

    return null;
  }

  private resolvePrivateTextCommand(text: string): PrivateControlCommand | null {
    const normalized = this.readLowerString(text);
    if (!normalized) {
      return null;
    }

    if (
      normalized === '/start' ||
      normalized === '/menu' ||
      normalized === 'menu' ||
      normalized === 'меню' ||
      normalized === 'кнопки'
    ) {
      return 'menu';
    }

    if (
      normalized === '/chats' ||
      normalized === '/chat' ||
      normalized === 'чаты' ||
      normalized === 'мои чаты'
    ) {
      return 'chats';
    }

    if (
      normalized === '/channels' ||
      normalized === '/channel' ||
      normalized === 'каналы' ||
      normalized === 'мои каналы'
    ) {
      return 'channels';
    }

    if (
      normalized === '/help' ||
      normalized === 'help' ||
      normalized === 'помощь' ||
      normalized === 'что умеешь'
    ) {
      return 'help';
    }

    return null;
  }

  private looksLikeSlashCommand(text: string): boolean {
    return typeof text === 'string' && text.trim().startsWith('/');
  }

  private async executePrivateCommand(
    chatId: string,
    command: PrivateControlCommand,
  ): Promise<void> {
    if (command === 'help') {
      await this.sendPrivateMenu(chatId, this.buildPrivateMenuPromptText());
      return;
    }

    if (command === 'chats') {
      await this.sendPrivateEntityList(chatId, 'chat');
      return;
    }

    if (command === 'channels') {
      await this.sendPrivateEntityList(chatId, 'channel');
      return;
    }

    await this.sendPrivateMenu(chatId, this.buildPrivateMenuPromptText());
  }

  private async sendPrivateEntityList(
    chatId: string,
    entityType: 'chat' | 'channel',
  ): Promise<void> {
    try {
      const entities = await this.loadPrivateMenuManagedEntities(entityType);

      if (entities.length === 0) {
        await this.sendPrivateMenu(
          chatId,
          entityType === 'channel'
            ? 'Пока нет каналов с ботом. Добавьте бота в канал и выдайте ему права администратора.'
            : 'Пока нет групповых чатов с ботом. Добавьте бота в чат и выдайте права администратора.',
        );
        return;
      }

      const preview = entities.slice(0, PRIVATE_BOT_CHATS_PREVIEW_LIMIT);
      const lines = preview.map((chat, index) => {
        const title = (chat.title ?? `Чат ${chat.id}`).replace(/\s+/g, ' ').trim();
        return `${index + 1}. ${title}`;
      });

      const moreCount = entities.length - preview.length;
      const message = [
        entityType === 'channel'
          ? `Каналы с ботом: ${entities.length}`
          : `Чаты с ботом: ${entities.length}`,
        '',
        ...lines,
        ...(moreCount > 0
          ? [
              '',
              entityType === 'channel'
                ? `... и ещё ${moreCount} каналов.`
                : `... и ещё ${moreCount} чатов.`,
            ]
          : []),
        '',
        'Для настройки откройте приложение.',
      ].join('\n');

      await this.sendPrivateMenu(chatId, message);
    } catch (error: unknown) {
      this.logger.warn(
        {
          chatId,
          error: error instanceof Error ? error.message : 'Unknown error',
        },
        'Failed to load private chats list',
      );
      await this.sendPrivateMenu(
        chatId,
        'Не удалось получить список чатов. Повторите запрос через несколько секунд.',
      );
    }
  }

  private async loadPrivateMenuManagedEntities(
    entityType: 'chat' | 'channel',
  ): Promise<Array<{ id: string; title: string | null }>> {
    if (typeof this.prisma.chat?.findMany !== 'function') {
      return [];
    }

    const chats = await this.prisma.chat.findMany({
      where: {
        catalogKind: ChatCatalogKind.MANAGED,
        entityType: entityType === 'channel' ? ChatEntityType.CHANNEL : ChatEntityType.CHAT,
        ...(entityType === 'chat' ? { id: { startsWith: '-' } } : {}),
        botMemberships: {
          some: {
            status: ChatBotMembershipStatus.ACTIVE,
          },
        },
      },
      select: {
        id: true,
        title: true,
      },
      orderBy: [{ updatedAt: 'desc' }, { title: 'asc' }],
      take: PRIVATE_BOT_CHATS_PREVIEW_LIMIT + 1,
    });

    return chats.filter((chat) => {
      if (entityType === 'channel') {
        return true;
      }

      const numericChatId = this.parseChatIdAsBigInt(chat.id);
      return numericChatId !== null && numericChatId < 0n;
    });
  }

  private async sendPrivateMenu(chatId: string, text: string): Promise<void> {
    try {
      await this.maxClient.sendMessage(chatId, text, this.buildPrivateMenuOptions(), {
        ignoreFailureMetricStatuses: PRIVATE_DIALOG_TERMINAL_FAILURE_METRIC_STATUSES,
      });
    } catch (error: unknown) {
      if (this.isTerminalPrivateDialogDeliveryError(error)) {
        this.logger.debug(
          {
            chatId,
            error: error instanceof Error ? error.message : 'Unknown error',
          },
          'Skipped private menu delivery after terminal private dialog error',
        );
        return;
      }

      throw error;
    }
  }

  private buildPrivateMenuOptions(): MaxSendMessageOptions {
    const miniappUrl = this.resolveMiniappUrl();
    const miniappButton = this.buildMiniappLaunchButton('Открыть приложение', '/', miniappUrl);

    const buttons: MaxSendMessageOptions['buttons'] = [
      [
        {
          type: 'callback',
          text: 'Чаты',
          payload: PRIVATE_MENU_CALLBACK_CHATS,
        },
        {
          type: 'callback',
          text: 'Каналы',
          payload: PRIVATE_MENU_CALLBACK_CHANNELS,
        },
      ],
      [
        miniappButton,
        {
          type: 'link',
          text: 'Поддержка',
          url: SUPPORT_CHAT_URL,
        },
      ],
    ];

    return {
      buttons,
      textFormat: 'markdown',
    };
  }

  private normalizeAppBaseUrl(value: string | undefined): string | null {
    if (typeof value !== 'string') {
      return null;
    }

    const normalized = value.trim().replace(/\/+$/, '');
    if (!normalized) {
      return null;
    }

    if (!/^https?:\/\//i.test(normalized)) {
      return null;
    }

    return normalized;
  }

  private resolveMiniappUrl(): string | null {
    if (!this.appBaseUrl) {
      return null;
    }

    return `${this.appBaseUrl}/app/`;
  }

  private buildMiniappLaunchButton(
    text: string,
    route: string,
    fallbackWebAppUrl: string | null,
  ): MaxMessageButton {
    const launchUrl = this.buildMiniappRouteLaunchUrl(route);
    if (launchUrl) {
      return {
        type: 'link',
        text,
        url: launchUrl,
      };
    }

    const botContactId = this.resolveBotContactId();
    if (fallbackWebAppUrl && botContactId) {
      return {
        type: 'open_app',
        text,
        webApp: fallbackWebAppUrl,
        contactId: botContactId,
      };
    }

    return {
      type: 'link',
      text,
      url: fallbackWebAppUrl ?? 'https://major-maksimov.ru/app/',
    };
  }

  private buildMiniappRouteLaunchUrl(route: string, _botId?: string | null): string | null {
    return this.buildEntryMiniappStartUrl(this.buildMiniappRouteStartParam(route));
  }

  private buildMiniappRouteStartParam(route: string): string {
    const payload = JSON.stringify({
      v: 1,
      k: 'route',
      r: route,
    });
    const encoded = Buffer.from(payload, 'utf8').toString('base64url');
    return `${MINIAPP_ROUTE_START_PARAM_PREFIX}${encoded}`;
  }

  private async resolveUnifiedBotRoute(request: MaxBotRouteRequest): Promise<MaxBotRoute | null> {
    return resolveUnifiedBotRouteForModeration(
      {
        maxBotLinkService: this.maxBotLinkService,
      },
      request,
    );
  }

  private async resolveChatReadBotId(chatId: string): Promise<string | null> {
    return resolveChatReadBotIdForModeration(
      {
        maxBotLinkService: this.maxBotLinkService,
      },
      chatId,
    );
  }

  private async resolveAutoAttachBotId(
    chatId: string,
    source: 'webhook' | 'poll',
  ): Promise<string | null> {
    return resolveAutoAttachBotIdForModeration(
      {
        maxBotLinkService: this.maxBotLinkService,
        maxBotContextService: this.maxBotContextService,
      },
      chatId,
      source,
    );
  }

  private resolveAutoAttachMutationBotId(params: {
    chatId: string;
    action: 'delete_message' | 'edit_message';
    requiredAuthorUserId?: string | null;
  }): Promise<{ botId: string | null; requiredAuthorVerified: boolean }> {
    return this.channelAutoPostMutationGuard.resolveMutationBotRoute(params);
  }

  private async recordChannelAutoPostAccessLossIfTerminal(params: {
    chatId: string;
    botId: string | null;
    source: string;
    operation: 'send' | 'edit' | 'read';
    lifecycleEventAt: Date;
    error: unknown;
  }): Promise<boolean> {
    try {
      const result = await this.managedEntityAccessLossService?.recordIfManagedEntityAccessLost?.({
        chatId: params.chatId,
        botId: params.botId,
        entityType: ChatEntityType.CHANNEL,
        source: params.source,
        operation: params.operation,
        error: params.error,
        lifecycleEventAt: params.lifecycleEventAt,
        lifecycleEventType: 'live_probe',
        lifecycleSource: 'live_probe',
      });
      if (!result?.recorded) {
        return false;
      }

      this.logger.warn(
        {
          chatId: params.chatId,
          botId: params.botId,
          source: params.source,
          operation: params.operation,
          reason: result.reason,
        },
        'Channel auto-post background work stopped after managed channel lost MAX access',
      );
      return true;
    } catch (accessLossError: unknown) {
      this.logger.debug(
        {
          chatId: params.chatId,
          source: params.source,
          err: accessLossError instanceof Error ? accessLossError.message : String(accessLossError),
        },
        'Failed to record channel auto-post MAX access loss',
      );
      return false;
    }
  }

  private async executeModerationActionWithFallback(params: {
    chatId: string;
    action: 'delete_message' | 'moderate_member';
    explicitBotId?: string | null;
    messageId?: string;
    userId?: string;
    operation: (botId?: string) => Promise<void>;
  }): Promise<boolean> {
    return (await this.executeModerationActionWithFallbackResult(params)).ok;
  }

  private async executeModerationActionWithFallbackResult(params: {
    chatId: string;
    action: 'delete_message' | 'moderate_member';
    explicitBotId?: string | null;
    messageId?: string;
    userId?: string;
    operation: (botId?: string) => Promise<void>;
  }): Promise<ModerationActionExecutionResult> {
    let attempt = await this.attemptModerationActionWithCandidateBots(
      params,
      await this.resolveModerationActionBotIds(params),
    );
    if (attempt.status === 'success') {
      return { ok: true, botId: attempt.botId };
    }

    if (!params.explicitBotId && attempt.status === 'no_candidates') {
      const refreshedCandidateBotIds = await this.refreshModerationActionCandidateBotIds({
        chatId: params.chatId,
        action: params.action,
      });
      if (refreshedCandidateBotIds.length > 0) {
        attempt = await this.attemptModerationActionWithCandidateBots(
          params,
          refreshedCandidateBotIds,
        );
        if (attempt.status === 'success') {
          return { ok: true, botId: attempt.botId };
        }
      }
    }

    if (
      !params.explicitBotId &&
      attempt.status === 'terminal_error' &&
      this.isTerminalModerationActionAccessError(attempt.error)
    ) {
      const initialTerminalAttempt = attempt;
      const refreshedCandidateBotIds = await this.refreshModerationActionCandidateBotIds({
        chatId: params.chatId,
        action: params.action,
        force: true,
        skipBackoffClearBotIds: initialTerminalAttempt.attemptedBotIds,
      });
      if (refreshedCandidateBotIds.length > 0) {
        const retryAttempt = await this.attemptModerationActionWithCandidateBots(
          params,
          refreshedCandidateBotIds,
        );
        if (retryAttempt.status === 'success') {
          return { ok: true, botId: retryAttempt.botId };
        }
        if (retryAttempt.status === 'terminal_error') {
          attempt = {
            status: 'terminal_error',
            attemptedBotIds: Array.from(
              new Set([...initialTerminalAttempt.attemptedBotIds, ...retryAttempt.attemptedBotIds]),
            ),
            error: retryAttempt.error,
          };
        }
      }
    }

    if (attempt.status === 'executor_rejected') {
      // FLAG: Every candidate stopped before DELETE. This is a declined action, not
      // deletion success or a confirmed loss of permissions. Keep following events live.
      void this.runtimeDiagnosticsService?.recordHotPathStageOutcome({
        stage: 'moderation-delete.executor-proof',
        outcome: 'skip',
        failOpen: true,
      });
      return { ok: false, botId: null };
    }

    if (attempt.status === 'terminal_error') {
      this.scheduleModerationActionAccessRecheck(params.chatId, params.action);
      this.logSkippedModerationActionAfterTerminalError({
        chatId: params.chatId,
        action: params.action,
        messageId: params.messageId,
        userId: params.userId,
        attemptedBotIds: attempt.attemptedBotIds,
        error: attempt.error,
      });
      return { ok: false, botId: null };
    }

    if (attempt.status === 'backoff_blocked') {
      this.scheduleModerationActionAccessRecheck(params.chatId, params.action);
    }

    await this.recordModerationActionNoCandidateProblemChat({
      chatId: params.chatId,
      action: params.action,
      reason:
        attempt.status === 'backoff_blocked'
          ? 'all candidate bots are temporarily backed off after permission failures'
          : 'no active bot has the required MAX permissions in this chat',
    });
    this.logSkippedModerationActionDueToPermissions({
      chatId: params.chatId,
      action: params.action,
      messageId: params.messageId,
      userId: params.userId,
    });
    return { ok: false, botId: null };
  }

  private async attemptModerationActionWithCandidateBots(
    params: {
      chatId: string;
      action: 'delete_message' | 'moderate_member';
      explicitBotId?: string | null;
      messageId?: string;
      userId?: string;
      operation: (botId?: string) => Promise<void>;
    },
    candidateBotIds: Array<string | null>,
  ): Promise<ModerationActionAttemptResult> {
    if (candidateBotIds.length === 0) {
      return { status: 'no_candidates' };
    }

    let terminalError: unknown = null;
    let executorRejected = false;
    let skippedDueToBackoff = false;
    const attemptedBotIds: string[] = [];

    for (const candidateBotId of candidateBotIds) {
      if (
        candidateBotId &&
        (await this.isModerationActionBotBackoffActive(
          params.chatId,
          params.action,
          candidateBotId,
        ))
      ) {
        skippedDueToBackoff = true;
        continue;
      }

      if (candidateBotId) {
        attemptedBotIds.push(candidateBotId);
      }

      const actionStartedAt = new Date();
      try {
        await params.operation(candidateBotId ?? undefined);
        if (candidateBotId) {
          await this.clearModerationActionBotBackoff(params.chatId, params.action, candidateBotId);
        }
        return { status: 'success', botId: candidateBotId ?? null };
      } catch (error: unknown) {
        // FLAG: Only the genuine final executor fence proves this DELETE never reached
        // HTTP. Try each existing candidate once; do not back off/demote a bot from a
        // superseded proof, retry member mutations, or swallow uncertain remote effects.
        if (
          params.action === 'delete_message' &&
          wasMaxPreDispatchGuardRejected(error) &&
          (error as { code?: unknown }).code === 'max_action_executor_proof_rejected' &&
          !wasMaxMessageSendAttempted(error) &&
          !wasMaxMemberMutationAttempted(error) &&
          !isMaxMutationOutcomeAmbiguous(error)
        ) {
          executorRejected = true;
          continue;
        }
        if (!this.isTerminalModerationActionPermissionError(error)) {
          throw error;
        }

        terminalError = error;
        if (candidateBotId) {
          if (this.isTerminalModerationActionAccessError(error)) {
            await this.rememberModerationActionBotBackoff(
              params.chatId,
              params.action,
              candidateBotId,
            );
            await this.recordModerationActionAccessLossIfTerminal({
              chatId: params.chatId,
              action: params.action,
              botId: candidateBotId,
              actionStartedAt,
              error,
            });
          }
          await this.recordModerationActionProblemChat({
            chatId: params.chatId,
            action: params.action,
            botId: candidateBotId,
            error,
          });
        }
      }
    }

    if (executorRejected) return { status: 'executor_rejected' };

    if (terminalError) {
      return {
        status: 'terminal_error',
        attemptedBotIds,
        error: terminalError,
      };
    }

    return skippedDueToBackoff ? { status: 'backoff_blocked' } : { status: 'no_candidates' };
  }

  private async recordModerationActionAccessLossIfTerminal(params: {
    chatId: string;
    action: 'delete_message' | 'moderate_member';
    botId: string;
    actionStartedAt: Date;
    error: unknown;
  }): Promise<void> {
    // FLAG: Target/capability rejection does not prove that the bot lost chat membership.
    const accessDenial = resolveExplicitMembershipAccessDenial(params.error);
    if (accessDenial !== 'chat.denied' && accessDenial !== 'chat.not.found') {
      return;
    }
    let detached = false;
    const operation = Promise.resolve().then(async () => {
      try {
        await this.managedEntityAccessLossService?.recordIfManagedEntityAccessLost?.({
          chatId: params.chatId,
          botId: params.botId,
          entityType: null,
          source: `moderation_action:${params.action}`,
          operation: params.action === 'delete_message' ? 'delete' : 'member_moderation',
          error: params.error,
          lifecycleEventAt: params.actionStartedAt,
          lifecycleEventType: 'live_probe',
          lifecycleSource: 'live_probe',
        });
      } finally {
        await this.persistModerationActionBotAccessSnapshot(
          params.chatId,
          params.botId,
          null,
          params.actionStartedAt,
          params.action,
        );
      }
    });
    operation.catch((error: unknown) => {
      if (!detached) {
        return;
      }
      this.logger.debug(
        {
          chatId: params.chatId,
          botId: params.botId,
          action: params.action,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to record moderation action MAX access loss after hot-path budget',
      );
    });

    try {
      await raceWithTimeout({
        operation,
        timeoutMs: MODERATION_ACTION_ACCESS_LOSS_HOT_PATH_TIMEOUT_MS,
        onTimeout: () => {
          detached = true;
        },
      });
    } catch (error: unknown) {
      this.logger.debug(
        {
          chatId: params.chatId,
          botId: params.botId,
          action: params.action,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to record moderation action MAX access loss',
      );
      return;
    }

    if (detached) {
      void this.runtimeDiagnosticsService?.recordHotPathStageOutcome({
        stage: 'moderation-action-access-loss.deferred',
        outcome: 'skip',
        failOpen: true,
      });
      this.logger.debug(
        {
          chatId: params.chatId,
          botId: params.botId,
          action: params.action,
          timeoutMs: MODERATION_ACTION_ACCESS_LOSS_HOT_PATH_TIMEOUT_MS,
        },
        'Moderation action access-loss recording exceeded hot-path budget; continuing detached',
      );
    }
  }

  private async resolveModerationActionBotIds(params: {
    chatId: string;
    action: 'delete_message' | 'edit_message' | 'moderate_member';
    explicitBotId?: string | null;
  }): Promise<Array<string | null>> {
    return resolveModerationActionBotIdsForModeration(
      {
        maxBotLinkService: this.maxBotLinkService,
      },
      params,
    );
  }

  private async refreshModerationActionCandidateBotIds(params: {
    chatId: string;
    action: 'delete_message' | 'moderate_member';
    force?: boolean;
    skipBackoffClearBotIds?: readonly string[];
  }): Promise<string[]> {
    const confirmedBotIds = await this.refreshModerationActionBotSnapshots(params);
    const candidateBotIds = (
      await this.resolveModerationActionBotIds({
        chatId: params.chatId,
        action: params.action,
      })
    ).filter((botId): botId is string => typeof botId === 'string' && botId.trim().length > 0);
    const skippedBackoffClearBotIds = new Set(
      (params.skipBackoffClearBotIds ?? [])
        .map((botId) => botId.trim())
        .filter((botId) => botId.length > 0),
    );
    for (const botId of candidateBotIds) {
      if (!confirmedBotIds.has(botId)) {
        continue;
      }
      if (skippedBackoffClearBotIds.has(botId)) {
        continue;
      }
      await this.clearModerationActionBotBackoff(params.chatId, params.action, botId);
    }
    return candidateBotIds.filter((botId) => confirmedBotIds.has(botId));
  }

  private async refreshModerationActionBotSnapshots(params: {
    chatId: string;
    action: 'delete_message' | 'moderate_member';
    force?: boolean;
  }): Promise<Set<string>> {
    const refreshKey = this.buildModerationActionSnapshotRefreshKey(params.chatId, params.action);
    const inFlightRefresh = this.moderationActionSnapshotRefreshInFlight.get(refreshKey);
    if (inFlightRefresh) {
      return await inFlightRefresh;
    }

    const refreshAllowedAtMs = this.moderationActionSnapshotRefreshUntilMs.get(refreshKey) ?? 0;
    if (!params.force && refreshAllowedAtMs > Date.now()) {
      return new Set();
    }

    const refreshPromise = this.refreshModerationActionBotSnapshotsInternal(
      params.chatId,
      params.action,
    ).finally(() => {
      this.moderationActionSnapshotRefreshInFlight.delete(refreshKey);
      this.moderationActionSnapshotRefreshUntilMs.set(
        refreshKey,
        Date.now() + MODERATION_ACTION_PERMISSION_REFRESH_MIN_INTERVAL_MS,
      );
    });
    this.moderationActionSnapshotRefreshInFlight.set(refreshKey, refreshPromise);
    return await refreshPromise;
  }

  private async refreshModerationActionBotSnapshotsInternal(
    chatId: string,
    action: 'delete_message' | 'moderate_member',
  ): Promise<Set<string>> {
    const { botIds, entityType } = await this.loadModerationActionSnapshotRefreshState(chatId);
    const confirmedBotIds = new Set<string>();
    if (botIds.length === 0) {
      return confirmedBotIds;
    }

    await Promise.all(
      botIds.map(async (botId) => {
        const probeStartedAt = new Date();
        let accessProbeCompleted = false;
        try {
          const access = await this.maxClient.getCurrentChatMemberAccess(chatId, {
            botId,
            bypassCache: true,
            trafficClass: 'background',
            actionHealthLane: 'background',
            timeoutMs: MODERATION_ACTION_PERMISSION_REFRESH_TIMEOUT_MS,
          });
          accessProbeCompleted = true;
          const persisted = await this.persistModerationActionBotAccessSnapshot(
            chatId,
            botId,
            access,
            probeStartedAt,
            action,
          );
          if (
            persisted &&
            this.hasModerationActionAccess(access, action, {
              requireExplicitPermission: true,
              entityType,
            })
          ) {
            confirmedBotIds.add(botId);
          }
        } catch (error: unknown) {
          if (!accessProbeCompleted && resolveExplicitMembershipAccessDenial(error) !== null) {
            await this.persistModerationActionBotAccessSnapshot(
              chatId,
              botId,
              null,
              probeStartedAt,
              action,
            );
            await this.recordModerationActionProblemChat({
              chatId,
              action,
              botId,
              error,
            });
            return;
          }

          this.logger.debug(
            {
              chatId,
              botId,
              err: error instanceof Error ? error.message : String(error),
            },
            'Failed to refresh bot self access snapshot for moderation action fallback',
          );
        }
      }),
    );
    return confirmedBotIds;
  }

  private async loadModerationActionSnapshotRefreshState(chatId: string): Promise<{
    botIds: string[];
    entityType: ChatEntityType | null;
  }> {
    if (typeof this.prisma.chat?.findUnique !== 'function') {
      return { botIds: [], entityType: null };
    }

    try {
      const chat = await this.prisma.chat.findUnique({
        where: { id: chatId },
        select: {
          entityType: true,
          primaryBotId: true,
          botId: true,
          botMemberships: {
            select: {
              botId: true,
              status: true,
            },
            orderBy: [{ updatedAt: 'desc' }, { createdAt: 'asc' }],
          },
        },
      });
      const candidateBotIds: string[] = [];
      const getResolvedBotSync = this.maxBotLinkService?.getResolvedBotSync;
      const trackedBotIds = new Set<string>();
      for (const rawBotId of [
        typeof chat?.primaryBotId === 'string' ? chat.primaryBotId : null,
        typeof chat?.botId === 'string' ? chat.botId : null,
        ...((chat?.botMemberships ?? [])
          .filter((membership) => membership.status === ChatBotMembershipStatus.ACTIVE)
          .map((membership) => membership.botId) as string[]),
      ]) {
        const normalizedBotId = typeof rawBotId === 'string' ? rawBotId.trim() : '';
        if (!normalizedBotId || trackedBotIds.has(normalizedBotId)) {
          continue;
        }
        trackedBotIds.add(normalizedBotId);
        if (candidateBotIds.includes(normalizedBotId)) {
          continue;
        }

        if (typeof getResolvedBotSync === 'function') {
          const resolvedBotId =
            getResolvedBotSync.call(this.maxBotLinkService, normalizedBotId)?.id ?? null;
          if (resolvedBotId !== normalizedBotId) {
            continue;
          }
        }

        candidateBotIds.push(normalizedBotId);
      }
      return {
        botIds: candidateBotIds,
        entityType: chat?.entityType ?? null,
      };
    } catch (error: unknown) {
      this.logger.debug(
        {
          chatId,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to load bot memberships for moderation action snapshot refresh',
      );
      return { botIds: [], entityType: null };
    }
  }

  private async persistModerationActionBotAccessSnapshot(
    chatId: string,
    botId: string,
    access: Pick<MaxChatMemberAccess, 'isAdmin' | 'isOwner' | 'permissions'> | null,
    probeStartedAt: Date,
    action: 'delete_message' | 'moderate_member',
  ): Promise<boolean> {
    const recordBotAccessProbe = this.maxBotLinkService?.recordBotAccessProbe;
    if (typeof recordBotAccessProbe !== 'function') {
      return false;
    }

    try {
      return await recordBotAccessProbe.call(this.maxBotLinkService, {
        chatId,
        botId,
        access,
        source: `moderation_action_${action}`,
        checkedAt: probeStartedAt,
        allowMembershipRecovery: false,
      });
    } catch (error: unknown) {
      this.logger.debug(
        {
          chatId,
          botId,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to persist bot self access snapshot for moderation action fallback',
      );
      return false;
    }
  }

  private hasModerationActionAccess(
    access: Pick<MaxChatMemberAccess, 'isAdmin' | 'isOwner' | 'permissions'> | null,
    action: 'delete_message' | 'moderate_member',
    options?: { requireExplicitPermission?: boolean; entityType?: ChatEntityType | null },
  ): boolean {
    if (!access) {
      return false;
    }

    if (action === 'delete_message') {
      return hasConfirmedDeleteMessageAccess(
        {
          checkedAt: null,
          isAdmin: access.isAdmin,
          isOwner: access.isOwner,
          permissions: [...access.permissions],
        },
        options?.entityType ?? null,
      );
    }

    if (access.isOwner === true) {
      return true;
    }

    const permissions = this.normalizeModerationActionPermissions(access.permissions);
    if (permissions.length > 0) {
      return permissions.some((permission) =>
        this.isModerationActionPermission(permission, action, options?.entityType ?? null),
      );
    }

    if (options?.requireExplicitPermission) {
      return false;
    }

    return access.isAdmin === true;
  }

  private normalizeModerationActionPermissions(
    value: readonly string[] | null | undefined,
  ): string[] {
    if (!Array.isArray(value)) {
      return [];
    }

    return Array.from(
      new Set(
        value
          .map((permission) => this.normalizeModerationActionPermissionName(permission))
          .filter((permission): permission is string => permission.length > 0),
      ),
    );
  }

  private normalizeModerationActionPermissionName(permission: unknown): string {
    if (typeof permission !== 'string') {
      return '';
    }

    return permission
      .trim()
      .toLowerCase()
      .replace(/[-\s]+/gu, '_');
  }

  private isModerationActionPermission(
    permission: string,
    action: 'delete_message' | 'moderate_member',
    entityType?: ChatEntityType | null,
  ): boolean {
    if (action === 'delete_message') {
      const aliases =
        entityType === ChatEntityType.CHAT
          ? CHAT_DELETE_MESSAGE_PERMISSION_ALIASES
          : DELETE_MESSAGE_PERMISSION_ALIASES;
      return aliases.has(permission);
    }

    return MODERATE_MEMBER_PERMISSION_ALIASES.has(permission);
  }

  private buildModerationActionBotBackoffKey(
    chatId: string,
    action: 'delete_message' | 'moderate_member',
    botId: string,
  ): string {
    return `${chatId}:${action}:${botId}`;
  }

  private buildModerationActionBotSharedBackoffKey(
    chatId: string,
    action: 'delete_message' | 'moderate_member',
    botId: string,
  ): string {
    return `moderation-action-terminal-backoff:v1:${chatId}:${action}:${botId}`;
  }

  private buildModerationActionSnapshotRefreshKey(
    chatId: string,
    action: 'delete_message' | 'moderate_member',
  ): string {
    return `${chatId}:${action}`;
  }

  private async isModerationActionBotBackoffActive(
    chatId: string,
    action: 'delete_message' | 'moderate_member',
    botId: string,
  ): Promise<boolean> {
    const cacheKey = this.buildModerationActionBotBackoffKey(chatId, action, botId);
    const backoffUntilMs = this.moderationActionBotBackoffUntilMs.get(cacheKey) ?? 0;
    if (backoffUntilMs > Date.now()) {
      return true;
    }

    if (backoffUntilMs > 0) {
      this.moderationActionBotBackoffUntilMs.delete(cacheKey);
    }

    const getString = (this.redisCounter as Partial<RedisCounterService> | undefined)?.getString;
    if (!getString || !this.redisCounter) {
      return false;
    }

    try {
      const sharedMarker = await getString.call(
        this.redisCounter,
        this.buildModerationActionBotSharedBackoffKey(chatId, action, botId),
      );
      if (sharedMarker === '1') {
        this.moderationActionBotBackoffUntilMs.set(
          cacheKey,
          Date.now() + MODERATION_ACTION_PERMISSION_BACKOFF_MS,
        );
        return true;
      }
    } catch (error: unknown) {
      this.logger.debug(
        {
          chatId,
          action,
          botId,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to read shared moderation action terminal backoff marker',
      );
    }

    return false;
  }

  private async rememberModerationActionBotBackoff(
    chatId: string,
    action: 'delete_message' | 'moderate_member',
    botId: string,
  ): Promise<void> {
    const localKey = this.buildModerationActionBotBackoffKey(chatId, action, botId);
    this.moderationActionBotBackoffUntilMs.set(
      localKey,
      Date.now() + MODERATION_ACTION_PERMISSION_BACKOFF_MS,
    );

    const setStringWithTtl = (this.redisCounter as Partial<RedisCounterService> | undefined)
      ?.setStringWithTtl;
    if (!setStringWithTtl || !this.redisCounter) {
      return;
    }

    try {
      await setStringWithTtl.call(
        this.redisCounter,
        this.buildModerationActionBotSharedBackoffKey(chatId, action, botId),
        '1',
        Math.ceil(MODERATION_ACTION_PERMISSION_BACKOFF_MS / 1_000),
      );
    } catch (error: unknown) {
      this.logger.debug(
        {
          chatId,
          action,
          botId,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to write shared moderation action terminal backoff marker',
      );
    }
  }

  private async clearModerationActionBotBackoff(
    chatId: string,
    action: 'delete_message' | 'moderate_member',
    botId: string,
  ): Promise<void> {
    this.moderationActionBotBackoffUntilMs.delete(
      this.buildModerationActionBotBackoffKey(chatId, action, botId),
    );

    const deleteKey = (this.redisCounter as Partial<RedisCounterService> | undefined)?.deleteKey;
    if (!deleteKey || !this.redisCounter) {
      return;
    }

    try {
      await deleteKey.call(
        this.redisCounter,
        this.buildModerationActionBotSharedBackoffKey(chatId, action, botId),
      );
    } catch (error: unknown) {
      this.logger.debug(
        {
          chatId,
          action,
          botId,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to clear shared moderation action terminal backoff marker',
      );
    }
  }

  private async recordModerationActionProblemChat(params: {
    chatId: string;
    action: 'delete_message' | 'moderate_member';
    botId: string;
    error: unknown;
  }): Promise<void> {
    await this.runtimeDiagnosticsService?.recordProblemChat({
      chatId: params.chatId,
      botId: params.botId,
      category: 'moderation_action_terminal',
      severity: this.extractStatusCode(params.error) === 404 ? 'warning' : 'critical',
      action: params.action,
      statusCode: this.extractStatusCode(params.error),
      reason: this.extractMaxErrorMessage(params.error) || 'terminal moderation action error',
    });
  }

  private async recordModerationActionNoCandidateProblemChat(params: {
    chatId: string;
    action: 'delete_message' | 'moderate_member';
    reason: string;
  }): Promise<void> {
    await this.runtimeDiagnosticsService?.recordProblemChat({
      chatId: params.chatId,
      botId: null,
      category: 'moderation_action_no_candidate',
      severity: 'warning',
      action: params.action,
      statusCode: null,
      reason: params.reason,
    });
  }

  /*
   * Legacy sync wrappers are intentionally not kept here: all moderation action
   * permission backoff now goes through Redis when available, so every worker
   * sees the same short suppression window.
   */

  private isTerminalModerationActionPermissionError(error: unknown): boolean {
    if (isMaxMutationOutcomeAmbiguous(error)) return false;
    const status = this.extractStatusCode(error);
    if (status === 403 || status === 404) {
      return true;
    }

    const code = this.extractMaxErrorCode(error);
    if (
      code === 'chat.denied' ||
      code === 'chat.not.found' ||
      code === 'message.not.found' ||
      code === 'member.not.found'
    ) {
      return true;
    }

    const message = this.extractMaxErrorMessage(error);
    return (
      message.includes('bot is not a chat member') ||
      message.includes('not accessible') ||
      message.includes('chat not found') ||
      message.includes('message not found') ||
      hasMaxInsufficientRightsMessage(message) ||
      message.includes('already been deleted') ||
      message.includes('already deleted')
    );
  }

  private isTerminalModerationActionAccessError(error: unknown): boolean {
    if (isMaxMutationOutcomeAmbiguous(error)) return false;
    const status = this.extractStatusCode(error);
    if (status === 403) {
      return true;
    }

    const code = this.extractMaxErrorCode(error);
    if (code === 'chat.denied' || code === 'chat.not.found') {
      return true;
    }

    const message = this.extractMaxErrorMessage(error);
    return (
      message.includes('bot is not a chat member') ||
      message.includes('not accessible') ||
      message.includes('chat not found') ||
      hasMaxInsufficientRightsMessage(message)
    );
  }

  private logSkippedModerationActionAfterTerminalError(params: {
    chatId: string;
    action: 'delete_message' | 'moderate_member';
    messageId?: string;
    userId?: string;
    attemptedBotIds: string[];
    error: unknown;
  }): void {
    const cacheKey = `${params.chatId}:${params.action}`;
    const now = Date.now();
    const lastLoggedAtMs = this.moderationActionPermissionSkipLogAtMs.get(cacheKey) ?? 0;
    if (now - lastLoggedAtMs < MODERATION_ACTION_PERMISSION_SKIP_LOG_INTERVAL_MS) {
      return;
    }

    this.moderationActionPermissionSkipLogAtMs.set(cacheKey, now);
    this.logger.warn(
      {
        chatId: params.chatId,
        action: params.action,
        messageId: params.messageId,
        userId: params.userId,
        attemptedBotIds: params.attemptedBotIds,
        status: this.extractStatusCode(params.error),
        code: this.extractMaxErrorCode(params.error),
        error: params.error instanceof Error ? params.error.message : 'Unknown error',
      },
      'Skipped moderation action after terminal MAX API error',
    );
  }

  private logSkippedModerationActionDueToPermissions(params: {
    chatId: string;
    action: 'delete_message' | 'moderate_member';
    messageId?: string;
    userId?: string;
  }): void {
    const cacheKey = `${params.chatId}:${params.action}`;
    const now = Date.now();
    const lastLoggedAtMs = this.moderationActionPermissionSkipLogAtMs.get(cacheKey) ?? 0;
    if (now - lastLoggedAtMs < MODERATION_ACTION_PERMISSION_SKIP_LOG_INTERVAL_MS) {
      return;
    }

    this.moderationActionPermissionSkipLogAtMs.set(cacheKey, now);
    this.logger.warn(
      {
        chatId: params.chatId,
        action: params.action,
        messageId: params.messageId,
        userId: params.userId,
      },
      'Skipped moderation action because no active bot has the required MAX permissions in this chat',
    );
  }

  private resolveBotContactId(botId?: string | null): string | null {
    const contextAwareContactId = this.maxBotLinkService?.resolveContactIdSync?.(botId);
    if (contextAwareContactId) {
      return contextAwareContactId;
    }

    if (this.explicitBotContactId) {
      return this.explicitBotContactId;
    }

    if (!this.ownBotUserId) {
      return null;
    }

    const normalized = this.ownBotUserId.trim().replace(/^id/i, '').replace(/_bot$/i, '');
    const [primary] = normalized.split('_');
    return /^\d+$/.test(primary) ? primary : null;
  }

  private normalizeBotContactId(value: string | undefined): string | null {
    if (typeof value !== 'string') {
      return null;
    }
    const normalized = value.trim();
    if (!normalized || !/^\d+$/.test(normalized)) {
      return null;
    }
    return normalized;
  }

  private async resolveSenderChatAdminCheck(
    chatId: string,
    localAdminUserIds: string[] | undefined,
    userId: string,
    options?: {
      allowRemoteLookup?: boolean;
      skipRemoteLookupWhenLocalAdminsKnown?: boolean;
      remoteLookupSoftTimeoutMs?: number;
      prefetchRemoteLookupWhenLocalAdminsKnown?: boolean;
    },
  ): Promise<ChatAdminCheckResult> {
    return this.moderationAccessService.resolveSenderChatAdminCheck(
      chatId,
      localAdminUserIds,
      userId,
      options,
    );
  }

  private async recheckSenderChatAdminBeforeModeration(
    chatId: string,
    localAdminUserIds: string[] | undefined,
    userId: string,
    initialResult: ChatAdminCheckResult,
    options?: {
      maxWaitMs?: number;
    },
  ): Promise<ChatAdminCheckResult> {
    return this.moderationAccessService.recheckSenderChatAdminBeforeModeration(
      chatId,
      localAdminUserIds,
      userId,
      initialResult,
      options,
    );
  }

  private async handleChatAdminModerationBypass(params: {
    update: MaxUpdate;
    chatId: string;
    chatTitle: string | undefined;
    senderId: string;
    senderName: string | undefined;
    messageId: string | undefined;
    text: string | undefined;
    settings: ChatSettings;
    source: ChatAdminCheckSource;
  }): Promise<void> {
    const { update, chatId, chatTitle, senderId, senderName, messageId, settings, source } = params;
    if (await this.reportSubmission?.handle(update, settings)) return;

    if (messageId) {
      const handledAdminCommand = await this.handleAdminForwardedModerationCommand({
        update,
        chatId,
        senderId,
        messageId,
        settings,
        ...(chatTitle !== undefined ? { chatTitle } : {}),
        ...(senderName !== undefined ? { senderName } : {}),
      });
      if (handledAdminCommand) {
        return;
      }
    }

    this.logger.debug(
      {
        chatId,
        userId: senderId,
        source,
      },
      'Moderation bypassed for chat admin',
    );
  }

  private scheduleDestructiveAdminRosterRefresh(params: {
    chatId: string;
    chatTitle: string | undefined;
    botId: string | null;
    entityType: string | null;
    stage: string;
  }): void {
    if (typeof this.maxChatAdminRosterSyncService?.scheduleChatAdminRosterSync !== 'function') {
      return;
    }

    const chatId = params.chatId.trim();
    if (!chatId) {
      return;
    }

    const now = Date.now();
    const lastScheduledAt = this.destructiveAdminRosterRefreshScheduledAtMs.get(chatId) ?? 0;
    if (now - lastScheduledAt < DESTRUCTIVE_ADMIN_ROSTER_REFRESH_THROTTLE_MS) {
      return;
    }
    this.destructiveAdminRosterRefreshScheduledAtMs.set(chatId, now);

    void this.maxChatAdminRosterSyncService
      .scheduleChatAdminRosterSync({
        chatId,
        botIds: params.botId ? [params.botId] : [],
        title: params.chatTitle ?? null,
        entityType: params.entityType === 'channel' ? 'channel' : 'chat',
        source: 'moderation_destructive_path',
        retryUntilMs: null,
      })
      .catch((error: unknown) => {
        this.destructiveAdminRosterRefreshScheduledAtMs.delete(chatId);
        this.logger.warn(
          {
            chatId,
            stage: params.stage,
            err: error instanceof Error ? error.message : String(error),
          },
          'Failed to schedule destructive moderation admin roster refresh',
        );
      });
  }

  private scheduleModerationActionAccessRecheck(
    chatId: string,
    action: 'delete_message' | 'moderate_member',
  ): void {
    if (typeof this.maxChatAdminRosterSyncService?.scheduleChatAdminRosterSync !== 'function') {
      return;
    }

    const normalizedChatId = chatId.trim();
    if (!normalizedChatId) {
      return;
    }

    const cacheKey = `${normalizedChatId}:${action}`;
    const now = Date.now();
    const lastScheduledAt = this.destructiveAdminRosterRefreshScheduledAtMs.get(cacheKey) ?? 0;
    if (now - lastScheduledAt < DESTRUCTIVE_ADMIN_ROSTER_REFRESH_THROTTLE_MS) {
      return;
    }
    this.destructiveAdminRosterRefreshScheduledAtMs.set(cacheKey, now);

    void this.maxChatAdminRosterSyncService
      .scheduleChatAdminRosterSync({
        chatId: normalizedChatId,
        botIds: [],
        title: null,
        entityType: null,
        source: 'moderation_destructive_path',
        retryUntilMs: null,
      })
      .catch((error: unknown) => {
        this.destructiveAdminRosterRefreshScheduledAtMs.delete(cacheKey);
        this.logger.warn(
          {
            chatId: normalizedChatId,
            action,
            err: error instanceof Error ? error.message : String(error),
          },
          'Failed to schedule moderation action access recheck',
        );
      });
  }

  private async isOtherBotAdminModerationBypass(params: {
    chatId: string;
    localAdminUserIds: string[] | undefined;
    senderId: string;
    degradeMode: boolean;
    hotChatBackoffActive: boolean;
  }): Promise<boolean> {
    return this.moderationAccessService.isOtherBotAdminModerationBypass(params);
  }

  private isSenderChatAdmin(adminUserIds: string[] | undefined, userId: string): boolean {
    return this.moderationAccessService.isSenderChatAdmin(adminUserIds, userId);
  }

  private buildChatAdminAccessLookupKey(chatId: string, userId: string): string {
    return this.moderationAccessService.buildChatAdminAccessLookupKey(chatId, userId);
  }

  private async getRemoteChatAdminAccess(
    chatId: string,
    userId: string,
    options: {
      allowLookup?: boolean;
    } = {},
  ): Promise<RemoteChatAdminAccessState | null> {
    return this.moderationAccessService.getRemoteChatAdminAccess(chatId, userId, options);
  }

  private async getRemoteChatAdminAccessWithin(
    chatId: string,
    userId: string,
    options: {
      maxWaitMs: number;
    },
  ): Promise<RemoteChatAdminAccessState | null> {
    return this.moderationAccessService.getRemoteChatAdminAccessWithin(chatId, userId, options);
  }

  private async loadRemoteChatAdminAccessBatch(
    chatId: string,
    userIds: readonly string[],
    options: {
      trafficClass?: 'interactive' | 'background';
      sourceTag?: string;
      timeoutMs?: number;
    } = {},
  ): Promise<Map<string, RemoteChatAdminAccessState>> {
    return this.moderationAccessService.loadRemoteChatAdminAccessBatch(chatId, userIds, options);
  }

  private shouldForceSynchronousRemoteAdminLookup(
    update: MaxUpdate,
    settings?: Pick<
      ChatSettings,
      | 'adminBanCommandName'
      | 'adminBanAllCommandName'
      | 'adminMuteCommandName'
      | 'adminPermanentMuteCommandName'
      | 'adminRulesCommandName'
      | 'adminSilenceCommandName'
      | 'adminOpenChatCommandName'
    >,
  ): boolean {
    return this.moderationAccessService.shouldForceSynchronousRemoteAdminLookup(update, settings);
  }

  private prefetchRemoteChatAdminAccess(chatId: string, userId: string): void {
    this.moderationAccessService.prefetchRemoteChatAdminAccess(chatId, userId);
  }

  private async executeRemoteChatAdminLookupWithGuard<T>(
    operation: () => Promise<T>,
    context: {
      chatId: string;
      userIds: readonly string[];
      botId?: string | null;
    },
  ): Promise<T> {
    return this.moderationAccessService.executeRemoteChatAdminLookupWithGuard(operation, context);
  }

  private async persistRemoteAdminGrant(chatId: string, userId: string): Promise<void> {
    return this.moderationAccessService.persistRemoteAdminGrant(chatId, userId);
  }

  private normalizeNightModeTimezone(value: string): string {
    const normalized = typeof value === 'string' ? value.trim() : '';
    if (!normalized) {
      return DEFAULT_NIGHT_MODE_TIMEZONE;
    }

    try {
      Intl.DateTimeFormat('ru-RU', { timeZone: normalized }).format(new Date());
      return normalized;
    } catch {
      return DEFAULT_NIGHT_MODE_TIMEZONE;
    }
  }

  private async consumeChatParticipantModerationImmunity(params: {
    chatId: string;
    userId: string;
    messageId?: string;
    nightModeTimezone: string | null;
  }): Promise<boolean> {
    // FLAG: A held source bypasses automatic moderation without spending immunity.
    if (await this.isLegacyModerationHeld(params.chatId, params.userId, params.messageId))
      return true;
    if (params.messageId && this.participantImmunity) {
      return (
        (await this.participantImmunity.consumeForMessage({
          ...params,
          messageId: params.messageId,
          scope: 'message-moderation:v2',
        })) === 'granted'
      );
    }
    return consumeLegacyParticipantModerationImmunity(this.prisma, params);
  }

  private normalizeDayMinutes(value: number, fallback: number): number {
    return normalizeNightModeDayMinutes(value, fallback);
  }

  private formatMinutesAsTime(value: number): string {
    return formatNightModeMinutesAsTime(value);
  }

  private buildNightModeClosedNotice(
    startMinutes: number,
    endMinutes: number,
    timezone: string,
    templateText: string,
    botSpeechStyle: BotSpeechStyle | null,
  ): string {
    return buildNightModeClosedNoticeText({
      startMinutes,
      endMinutes,
      timezone,
      templateText,
      botSpeechStyle,
      activeBotSpeechProfile: this.resolveActiveBotSpeechProfile(),
    });
  }

  private buildNightModeOpenedNotice(
    startMinutes: number,
    endMinutes: number,
    timezone: string,
    templateText: string,
    botSpeechStyle: BotSpeechStyle | null,
  ): string {
    return buildNightModeOpenedNoticeText({
      startMinutes,
      endMinutes,
      timezone,
      templateText,
      botSpeechStyle,
      activeBotSpeechProfile: this.resolveActiveBotSpeechProfile(),
    });
  }

  private isServiceAuthoredMessage(update: MaxUpdate): boolean {
    for (const sender of this.extractSenderEntities(update)) {
      const type = this.readLowerString(sender.type) ?? this.readLowerString(sender.kind);
      if (type === 'service') {
        return true;
      }

      if (sender.is_service === true || sender.isService === true) {
        return true;
      }
    }

    return false;
  }

  private isBotAuthoredMessage(update: MaxUpdate): boolean {
    for (const sender of this.extractSenderEntities(update)) {
      if (this.isBotEntity(sender)) {
        return true;
      }
    }

    return false;
  }

  private extractSenderEntities(update: MaxUpdate): Array<Record<string, unknown>> {
    const raw = this.asRecord(update.raw);
    if (!raw) {
      return [];
    }

    const messageNode = extractRawMessageNode(raw);
    return [
      this.asRecord(messageNode?.sender),
      this.asRecord(messageNode?.from),
      this.asRecord(raw.sender),
      this.asRecord(raw.from),
    ].filter((item): item is Record<string, unknown> => item !== null);
  }

  private extractBotUserIdsFromServiceEvent(update: MaxUpdate): string[] {
    const memberRows = this.extractServiceMemberRows(update);
    const botUserIds = new Set<string>();

    for (const row of memberRows) {
      if (!this.isBotEntity(row)) {
        continue;
      }

      const userId = this.readUserIdFromEntity(row);
      if (userId) {
        botUserIds.add(userId);
      }
    }

    return [...botUserIds];
  }

  private extractServiceMemberUserIds(update: MaxUpdate): string[] {
    const memberRows = this.extractServiceMemberRows(update);
    const userIds = new Set<string>();

    for (const row of memberRows) {
      const userId = this.readUserIdFromEntity(row);
      if (userId) {
        userIds.add(userId);
      }
    }

    return [...userIds];
  }

  private extractServiceMemberRows(update: MaxUpdate): Array<Record<string, unknown>> {
    const raw = this.asRecord(update.raw);
    if (!raw) {
      return [];
    }

    const rows: Array<Record<string, unknown>> = [];
    const directMembershipEntity = this.extractDirectMembershipEntity(raw);
    if (directMembershipEntity) {
      rows.push(directMembershipEntity);
    }

    const messageNode = extractRawMessageNode(raw) ?? raw;
    this.collectServiceMemberRows(messageNode, rows);
    return rows;
  }

  private collectServiceMemberRows(node: unknown, acc: Array<Record<string, unknown>>, depth = 0) {
    if (depth > MAX_FORWARD_SCAN_DEPTH || node === null || node === undefined) {
      return;
    }

    if (Array.isArray(node)) {
      for (const item of node) {
        this.collectServiceMemberRows(item, acc, depth + 1);
      }
      return;
    }

    if (typeof node !== 'object') {
      return;
    }

    const row = node as Record<string, unknown>;
    for (const [key, value] of Object.entries(row)) {
      const keyLower = key.toLowerCase();
      if (this.isServiceMembersCollectionKey(keyLower)) {
        this.collectMemberEntities(value, acc, depth + 1);
        continue;
      }

      if (value && (typeof value === 'object' || Array.isArray(value))) {
        this.collectServiceMemberRows(value, acc, depth + 1);
      }
    }
  }

  private isServiceMembersCollectionKey(key: string): boolean {
    return (
      key === 'new_members' ||
      key === 'new_member' ||
      key === 'members_added' ||
      key === 'member_added' ||
      key === 'added_members' ||
      key === 'added_member' ||
      key === 'joined_members' ||
      key === 'joined_member' ||
      key === 'invited_members' ||
      key === 'invited_member' ||
      key === 'new_users' ||
      key === 'new_user'
    );
  }

  private extractDirectMembershipEntity(
    raw: Record<string, unknown>,
  ): Record<string, unknown> | null {
    const updateType = this.readLowerString(raw.update_type) ?? this.readLowerString(raw.type);
    // FLAG: In bot_added, MAX `user` is the human actor who added this bot, not the joined member.
    if (updateType !== 'user_added') {
      return null;
    }

    const data = this.asRecord(raw.data);
    const event = this.asRecord(raw.event);
    const candidates = [
      raw,
      this.asRecord(raw[updateType]),
      data,
      data ? this.asRecord(data[updateType]) : null,
      event,
      event ? this.asRecord(event[updateType]) : null,
    ];

    for (const candidate of candidates) {
      if (!candidate) {
        continue;
      }

      const userEntity = this.asRecord(candidate.user) ?? this.asRecord(candidate.member);
      if (userEntity && this.readUserIdFromEntity(userEntity)) {
        return userEntity;
      }
    }

    return null;
  }

  private collectMemberEntities(node: unknown, acc: Array<Record<string, unknown>>, depth = 0) {
    if (depth > MAX_FORWARD_SCAN_DEPTH || node === null || node === undefined) {
      return;
    }

    if (Array.isArray(node)) {
      for (const item of node) {
        this.collectMemberEntities(item, acc, depth + 1);
      }
      return;
    }

    if (typeof node !== 'object') {
      return;
    }

    const row = node as Record<string, unknown>;
    if (this.readUserIdFromEntity(row)) {
      acc.push(row);
    }

    for (const value of Object.values(row)) {
      if (value && (typeof value === 'object' || Array.isArray(value))) {
        this.collectMemberEntities(value, acc, depth + 1);
      }
    }
  }

  private readUserIdFromEntity(node: Record<string, unknown>): string | null {
    const explicitCandidates = [node.user_id, node.userId, node.member_id, node.memberId];
    for (const value of explicitCandidates) {
      if (typeof value === 'string' || typeof value === 'number') {
        return String(value);
      }
    }

    const idCandidate = node.id;
    if (
      (typeof idCandidate === 'string' || typeof idCandidate === 'number') &&
      this.looksLikeUserEntity(node)
    ) {
      return String(idCandidate);
    }

    return null;
  }

  private looksLikeUserEntity(node: Record<string, unknown>): boolean {
    return (
      node.type !== undefined ||
      node.kind !== undefined ||
      node.username !== undefined ||
      node.display_name !== undefined ||
      node.displayName !== undefined ||
      node.name !== undefined ||
      node.is_bot !== undefined ||
      node.isBot !== undefined ||
      node.bot !== undefined
    );
  }

  private isBotEntity(node: Record<string, unknown>): boolean {
    const type = this.readLowerString(node.type) ?? this.readLowerString(node.kind);
    if (type === 'bot') {
      return true;
    }

    return node.is_bot === true || node.isBot === true || node.bot === true;
  }

  private asRecord(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  }

  private async handleChannelUpdate(
    update: MaxUpdate,
    managedChannel: ManagedChannelContext | null,
  ): Promise<void> {
    if (!managedChannel || update.type !== 'message_created' || !update.message) {
      return;
    }

    const { chatId, senderId, messageId, text, createdAt } = update.message;
    if (!messageId) {
      return;
    }

    const senderIsOwnBot = senderId ? this.isOwnBotSender(senderId) : false;
    if (this.isServiceAuthoredMessage(update)) {
      return;
    }

    const eventTimestampMs = resolveChannelAutoPostEventTimestampMs(update);
    const marketplaceAt =
      (await this.maxClient.getMarketplaceChannelPostActivation?.(chatId)) ?? null;
    const sourceChannelSettings = marketplacePostIsEligible(createdAt, marketplaceAt)
      ? channelSettingsForSource(managedChannel.channelSettings, createdAt)
      : managedChannel.channelSettings;
    const linkType = extractChannelAutoPostMessageLinkType(update);
    const raw = this.asRecord(update.raw);
    const rawMessage = raw ? (extractRawMessageNode(raw) ?? raw) : null;
    const messageText = resolveChannelAutoPostMessageText(
      rawMessage,
      typeof text === 'string' ? text : null,
      managedChannel.channelSettings.quickButtonsEnabled === true &&
        eventTimestampMs >= managedChannel.channelSettings.updatedAt.getTime(),
    );
    const requiresForwardReplacement =
      linkType === 'forward' &&
      !isChannelAutoPostKeyboardOnly(sourceChannelSettings, messageText.quickButtons);
    let senderAdminVerified = false;

    if (requiresForwardReplacement && senderIsOwnBot) {
      senderAdminVerified = true;
    } else if (requiresForwardReplacement && senderId) {
      const mode = await this.resolveSystemModeSnapshot();
      const senderAdminCheck = await this.resolveSenderChatAdminCheck(
        chatId,
        managedChannel.adminUserIds,
        senderId,
        {
          allowRemoteLookup: mode.mode !== 'degrade',
          skipRemoteLookupWhenLocalAdminsKnown: true,
          remoteLookupSoftTimeoutMs: CHAT_ADMIN_NONCRITICAL_LOOKUP_SOFT_TIMEOUT_MS,
        },
      );
      if (!senderAdminCheck.isAdmin) {
        this.channelAutoPostScanManager.markWebhookSeen(chatId, messageId, eventTimestampMs);
        return;
      }
      senderAdminVerified = true;
    }

    const existingDialogButtons = extractChannelAutoPostDialogButtons(rawMessage, chatId);

    const outcome = await this.tryAutoAttachChannelMessageButtons({
      chatId,
      messageId,
      text: messageText.text,
      textFormat: messageText.textFormat,
      quickButtons: messageText.quickButtons,
      linkType,
      existingDialogButtonKinds: existingDialogButtons.kinds,
      existingDialogThreadId: existingDialogButtons.threadId,
      managedChannel,
      source: 'webhook',
      senderId,
      senderAdminVerified,
      allowSenderlessEngagement: true,
      sourceMessageAt: createdAt,
      marketplaceAt,
    });
    if (outcome !== 'in_progress') {
      this.channelAutoPostScanManager.markWebhookSeen(chatId, messageId, eventTimestampMs);
    }
  }

  private async processChannelAutoPostButtons(): Promise<void> {
    if (this.channelAutoPostInFlight || !this.backgroundTasksEnabled) {
      return;
    }
    if (Date.now() < this.channelAutoPostBackoffUntilMs) {
      return;
    }
    if (this.channelAutoPostScanMaxChannels === 0) {
      return;
    }
    if (typeof this.prisma.channelSettings?.findMany !== 'function') {
      return;
    }

    const executionPlan = await this.resolveChannelAutoPostExecutionPlan();
    if (!executionPlan) {
      return;
    }

    this.channelAutoPostInFlight = true;
    try {
      await this.channelAutoPostScanRuntime.run({
        prisma: this.prisma,
        maxClient: this.maxClient,
        plan: executionPlan,
        manager: this.channelAutoPostScanManager,
        demand: this.channelPostDemand,
        recovery: this.channelAutoPostLegacyRecovery,
        scanIntervalMs: this.channelAutoPostScanIntervalMs,
        rateLimitBackoffMs: CHANNEL_AUTO_POST_RATE_LIMIT_BACKOFF_MS,
        processChannel: (channel, options) =>
          this.processManagedChannelAutoPostButtons(channel, options),
        sleep: (ms) => this.sleep(ms),
        isTransientLookupError: (error) => this.isTransientMaxApiLookupError(error),
        onGlobalBackoff: (ms) => {
          this.channelAutoPostBackoffUntilMs = Date.now() + ms;
        },
        onFailure: (chatId, error) =>
          this.logger.warn(
            { chatId, error: error instanceof Error ? error.message : 'Unknown error' },
            'Failed channel auto post buttons scan',
          ),
      });
    } finally {
      this.channelAutoPostInFlight = false;
    }
  }

  private async processManagedChannelAutoPostButtons(
    managedChannel: ManagedChannelContext,
    options: {
      maxNewMessagesPerScan?: number;
    } = {},
  ): Promise<void> {
    const maxNewMessagesPerScan = Math.max(
      1,
      options.maxNewMessagesPerScan ?? this.channelAutoPostMaxNewMessagesPerScan,
    );
    const chatId = managedChannel.channelSettings.chatId;
    if (!this.channelAutoPostScanManager.isDue(chatId)) {
      return;
    }

    const scanBotId =
      (
        await this.resolveUnifiedBotRoute({
          purpose: 'capability',
          chatId,
          capability: 'background_scans',
          fallbackToPrimary: true,
        })
      )?.botId ??
      (await this.maxBotLinkService?.resolveBotIdForCapability?.({
        chatId,
        capability: 'background_scans',
      })) ??
      undefined;
    let messages: Awaited<ReturnType<MaxClientService['listMessages']>>;
    const readAttemptStartedAt = new Date();
    try {
      messages = await this.maxClient.listMessages(chatId, {
        count: 10,
        trafficClass: 'background',
        sourceTag: MAX_API_SOURCE_TAGS.CHANNEL_AUTO_POST,
        ...(scanBotId ? { botId: scanBotId } : {}),
      });
    } catch (error: unknown) {
      if (
        await this.recordChannelAutoPostAccessLossIfTerminal({
          chatId,
          botId: scanBotId ?? null,
          source: 'channel_auto_post:scan',
          operation: 'read',
          lifecycleEventAt: readAttemptStartedAt,
          error,
        })
      ) {
        return;
      }
      throw error;
    }
    await processChannelAutoPostListedMessages({
      managedChannel,
      messages,
      maxNewMessagesPerScan,
      maxClient: this.maxClient,
      manager: this.channelAutoPostScanManager,
      attach: (params) => this.tryAutoAttachChannelMessageButtons(params),
    });
  }

  private async resolveChannelAutoPostExecutionPlan(): Promise<ChannelAutoPostExecutionPlan | null> {
    const basePlan: ChannelAutoPostExecutionPlan = {
      batchSize: this.channelAutoPostScanManager.resolveBatchSize(),
      interChannelDelayMs: this.channelAutoPostInterChannelDelayMs,
      maxNewMessagesPerScan: this.channelAutoPostMaxNewMessagesPerScan,
    };

    if (this.backgroundRuntimeGovernorService) {
      const now = Date.now();
      const decision = await this.backgroundRuntimeGovernorService
        .decide(buildChannelAutoPostGovernorRequest(this.backgroundWorkSoftPauseQueueLagSec))
        .catch((error: unknown) => {
          if (now - this.channelAutoPostPausedLogAtMs >= BACKGROUND_WORK_PAUSE_LOG_INTERVAL_MS) {
            this.channelAutoPostPausedLogAtMs = now;
            this.logger.warn(
              {
                task: 'channel-auto-post-buttons',
                retryAfterMs: CHANNEL_AUTO_POST_GOVERNOR_UNAVAILABLE_BACKOFF_MS,
                err: error instanceof Error ? error.message : String(error),
              },
              'Paused moderation background work because the runtime governor is unavailable',
            );
          }
          this.channelAutoPostBackoffUntilMs = Math.max(
            this.channelAutoPostBackoffUntilMs,
            now + CHANNEL_AUTO_POST_GOVERNOR_UNAVAILABLE_BACKOFF_MS,
          );
          return null;
        });
      if (!decision) {
        return null;
      }
      if (decision.action === 'run') {
        return basePlan;
      }

      if (decision.action === 'slow') {
        if (now - this.channelAutoPostPausedLogAtMs >= BACKGROUND_WORK_PAUSE_LOG_INTERVAL_MS) {
          this.channelAutoPostPausedLogAtMs = now;
          this.logger.log(
            {
              task: 'channel-auto-post-buttons',
              action: decision.action,
              reason: decision.reason,
              retryAfterMs: decision.retryAfterMs,
              batchSize: Math.max(
                1,
                Math.ceil(basePlan.batchSize / CHANNEL_AUTO_POST_SLOW_BATCH_DIVISOR),
              ),
              maxNewMessagesPerScan: Math.max(
                1,
                Math.min(
                  basePlan.maxNewMessagesPerScan,
                  CHANNEL_AUTO_POST_SLOW_MAX_NEW_MESSAGES_PER_SCAN,
                ),
              ),
            },
            'Throttled moderation background work because the runtime governor detected pressure',
          );
        }

        return {
          batchSize: Math.max(
            1,
            Math.ceil(basePlan.batchSize / CHANNEL_AUTO_POST_SLOW_BATCH_DIVISOR),
          ),
          interChannelDelayMs: Math.max(
            basePlan.interChannelDelayMs,
            CHANNEL_AUTO_POST_SLOW_INTER_CHANNEL_DELAY_MS,
          ),
          maxNewMessagesPerScan: Math.max(
            1,
            Math.min(
              basePlan.maxNewMessagesPerScan,
              CHANNEL_AUTO_POST_SLOW_MAX_NEW_MESSAGES_PER_SCAN,
            ),
          ),
        };
      }

      if (now - this.channelAutoPostPausedLogAtMs >= BACKGROUND_WORK_PAUSE_LOG_INTERVAL_MS) {
        this.channelAutoPostPausedLogAtMs = now;
        this.logger.log(
          {
            task: 'channel-auto-post-buttons',
            action: decision.action,
            reason: decision.reason,
            retryAfterMs: this.channelAutoPostScanIntervalMs,
          },
          'Paused moderation background work because the runtime governor detected pressure',
        );
      }
      // FLAG: Recheck local pressure on the existing scan cadence. Transport quota
      // backoff stays at the scheduler entry; this decision never waives MAX admission.
      return null;
    }

    const mode = await this.resolveSystemModeSnapshot();
    let pauseReason: string | null = null;
    if (mode.mode !== 'degrade' || isSystemModeRecoveryWindow(mode)) {
      pauseReason = await this.resolveBackgroundPressurePauseReason();
      if (!pauseReason) {
        return basePlan;
      }
    } else {
      pauseReason = mode.reason;
    }

    const now = Date.now();
    if (now - this.channelAutoPostPausedLogAtMs >= BACKGROUND_WORK_PAUSE_LOG_INTERVAL_MS) {
      this.channelAutoPostPausedLogAtMs = now;
      this.logger.log(
        {
          task: 'channel-auto-post-buttons',
          mode: mode.mode,
          source: mode.source,
          reason: pauseReason,
        },
        'Paused moderation background work because the system is under pressure',
      );
    }

    return null;
  }

  private async assertChannelQuickButtonsEnabled(chatId: string): Promise<void> {
    const settings = await this.prisma.channelSettings.findUnique({
      where: { chatId },
      select: { quickButtonsEnabled: true },
    });
    if (settings?.quickButtonsEnabled !== true) {
      throw new BadRequestException('Channel quick buttons are disabled.');
    }
  }

  private async tryAutoAttachChannelMessageButtons(
    params: ChannelAutoPostAttachParams,
  ): Promise<ChannelAutoPostAttachOutcome> {
    const {
      chatId,
      messageId,
      text,
      textFormat,
      linkType,
      managedChannel,
      source,
      senderId,
      senderAdminVerified,
      sourceMessageAt,
    } = params;
    // FLAG: Polling and legacy recovery bypass webhook admission. Check the exact
    // source before claiming or changing any persistent channel marker.
    if (await this.legacyHolds?.isMessageHeld(chatId, messageId)) return 'skipped';
    const marketplaceAt =
      params.marketplaceAt !== undefined
        ? params.marketplaceAt
        : ((await this.maxClient.getMarketplaceChannelPostActivation?.(chatId)) ?? null);
    const includeMarketplaceButton = marketplacePostIsEligible(sourceMessageAt, marketplaceAt);
    const channelSettings = includeMarketplaceButton
      ? channelSettingsForSource(managedChannel.channelSettings, sourceMessageAt)
      : managedChannel.channelSettings;
    const quickButtons = includeMarketplaceButton
      ? channelSettings.quickButtonsEnabled
        ? params.quickButtons
        : undefined
      : params.quickButtons;
    const normalizedSenderId = senderId?.trim() || null;
    const editForwardInPlace =
      linkType === 'forward' &&
      params.allowSenderlessEngagement === true &&
      isChannelAutoPostKeyboardOnly(channelSettings, quickButtons);
    const replaceForward = linkType === 'forward' && !editForwardInPlace;
    // FLAG: Only fresh webhook/poll callers opt anonymous forwards into keyboard-only edits.
    // Text replacement and legacy recovery still require a verified admin before send/delete.
    if (replaceForward && (!normalizedSenderId || !senderAdminVerified)) {
      return 'skipped';
    }
    if (linkType === 'forward' && !(await this.isCurrentChannelEntity(chatId))) {
      return 'skipped';
    }
    const configuredButtonVisibility = resolveChannelAutoPostButtonVisibility(channelSettings);
    const senderlessEngagementAllowed =
      !normalizedSenderId && !replaceForward && params.allowSenderlessEngagement;
    const buttonVisibility =
      normalizedSenderId || senderlessEngagementAllowed
        ? configuredButtonVisibility
        : { includeCommentsButton: false, includeSuggestButton: false };
    const existingButtonKinds = new Set(params.existingDialogButtonKinds ?? []);
    const includeCommentsButton =
      buttonVisibility.includeCommentsButton && !existingButtonKinds.has('comments');
    const includeSuggestButton =
      buttonVisibility.includeSuggestButton && !existingButtonKinds.has('suggest');
    const postSignatureEnabled = channelSettings.postSignatureEnabled === true;
    if (!normalizedSenderId && !senderlessEngagementAllowed && !postSignatureEnabled) {
      return 'skipped';
    }
    if (
      !includeCommentsButton &&
      !includeSuggestButton &&
      !postSignatureEnabled &&
      !quickButtons &&
      !includeMarketplaceButton
    ) {
      return 'noop';
    }
    if (postSignatureEnabled && !this.channelPostSignatureService) {
      this.logger.error(
        { chatId, messageId, source },
        'Channel post signature service is unavailable for post decoration',
      );
      throw new Error('Channel post signature service is unavailable.');
    }

    const { routeReadFailure, ...autoAttachRoute } = await resolveInitialChannelMutationRoute(
      () =>
        this.resolveAutoAttachMutationBotId({
          chatId,
          action: replaceForward ? 'delete_message' : 'edit_message',
        }),
      params,
    );
    if (!autoAttachRoute.botId || !autoAttachRoute.requiredAuthorVerified) {
      return 'skipped';
    }
    const autoAttachBotId = autoAttachRoute.botId;
    const mutationRequestOptions = {
      trafficClass: 'background',
      actionHealthLane: 'background',
      sourceTag: MAX_API_SOURCE_TAGS.CHANNEL_AUTO_POST,
      ...(autoAttachBotId ? { botId: autoAttachBotId } : {}),
    } as const;

    const claim = await this.replacementAttachMarkerStore.claimChannelAutoPost({
      chatId,
      messageId,
      source,
      botId: autoAttachBotId,
      linkType,
      hasEngagementButtons:
        buttonVisibility.includeCommentsButton || buttonVisibility.includeSuggestButton,
      replaySafeEdit: linkType !== 'forward' && !quickButtons,
    });
    if (routeReadFailure && claim.status !== 'claimed') throw routeReadFailure;
    if (claim.status === 'done') {
      return 'skipped';
    }
    if (claim.status === 'in_progress') {
      return 'in_progress';
    }
    if (claim.status !== 'claimed') {
      return 'skipped';
    }

    if (routeReadFailure) {
      if (
        await this.replacementAttachMarkerStore.deferChannelRouteBeforeDispatch(
          { ...params, lockToken: claim.lockToken, botId: autoAttachBotId },
          routeReadFailure,
        )
      )
        return 'in_progress';
      throw routeReadFailure;
    }

    const threadId = params.existingDialogThreadId?.trim() || randomUUID();
    let ctaButton: MaxMessageButton | null = null;
    let deliveryMode: 'edit_message' | 'replace_with_bot_message' = 'edit_message';
    let replacementMessageId: string | null = null;
    let publishedUrl: string | null = replaceForward
      ? null
      : buildMaxMessageFallbackUrl(chatId, messageId);
    let originalDeleted = false;
    let originalCleanupError: string | null = null;
    let originalCleanupStatusCode: number | null = null;
    let replacementSendStarted = false;
    let signatureApplied = false;
    let maxMutationAttemptStartedAt: Date | null = null;
    let editAttempts = 0;
    let mutationApplied = true;

    try {
      ctaButton =
        postSignatureEnabled && this.channelPostSignatureService
          ? ((await this.channelPostSignatureService.buildPostButton?.(chatId, {
              entityType: 'channel',
              trafficClass: 'background',
              sourceTag: MAX_API_SOURCE_TAGS.CHANNEL_AUTO_POST,
              botId: autoAttachBotId,
            })) ?? null)
          : null;
      const buttons = buildChannelAutoPostButtons(
        managedChannel.channelSettings,
        quickButtons ? { includeCommentsButton, includeSuggestButton } : buttonVisibility,
        (type, buttonText, suggestionEntryMode) =>
          this.buildChannelDialogButton(
            chatId,
            type,
            threadId,
            buttonText,
            autoAttachBotId,
            suggestionEntryMode,
          ),
        ctaButton,
      );
      buttons.push(...(quickButtons?.buttons ?? []));
      const decoration = {
        chatId,
        text,
        textFormat,
        postSignatureEnabled,
        signatureService: this.channelPostSignatureService,
        sourceTag: MAX_API_SOURCE_TAGS.CHANNEL_AUTO_POST,
        botId: autoAttachBotId,
      };
      const preparedText =
        replaceForward || quickButtons
          ? await prepareChannelAutoPostDecoration(decoration)
          : { text, textFormat: textFormat ?? undefined, signatureApplied: false };
      signatureApplied = preparedText.signatureApplied;
      if (
        buttons.length === 0 &&
        !preparedText.signatureApplied &&
        (replaceForward || !postSignatureEnabled) &&
        !includeMarketplaceButton
      ) {
        await this.replacementAttachMarkerStore.completeChannelAutoPost({
          chatId,
          messageId,
          lockToken: claim.lockToken,
          status: CHANNEL_AUTO_POST_ATTACH_STATUS.SKIPPED,
          source,
          botId: autoAttachBotId,
          linkType,
          deliveryMode: null,
          lastError: 'No channel post decoration to apply.',
          lastStatusCode: null,
        });
        return 'noop';
      }
      const preserveExistingInlineKeyboard = buttons.length === 0;
      const mutationTextOptions = buildChannelAutoPostTextMutationOptions({
        ...decoration,
        quickButtons,
        preserveText: Boolean(ctaButton) || editForwardInPlace,
        allowForwardCopy: replaceForward,
        onSignatureApplied: (applied) => {
          signatureApplied = applied;
        },
      });
      const marketplaceChannelPost =
        includeMarketplaceButton && sourceMessageAt && !replaceForward
          ? {
              entityId: chatId,
              sourceAt: sourceMessageAt,
              only:
                !includeCommentsButton &&
                !includeSuggestButton &&
                !postSignatureEnabled &&
                !quickButtons,
            }
          : undefined;
      const beforeEditMutation = withMaxFinalAuthorityCheckpoint(async (beforeFinalAuthority) => {
        await this.channelAutoPostMutationGuard.assertEditAuthorized(chatId, autoAttachBotId);
        // FLAG: Finish remote authorization before admission; settings and the owned
        // marker must still authorize the edit after any quota or route wait.
        await beforeFinalAuthority?.();
        if (quickButtons) await this.assertChannelQuickButtonsEnabled(chatId);
        if (linkType !== 'forward' && !quickButtons) {
          await this.replacementAttachMarkerStore.assertChannelEditClaimCurrent({
            chatId,
            messageId,
            lockToken: claim.lockToken,
          });
        }
      });

      if (replaceForward) {
        maxMutationAttemptStartedAt = new Date();
        const sent = await this.maxClient.sendMessageCopyWithInlineKeyboard(
          chatId,
          messageId,
          preparedText.text,
          {
            buttons,
            ...mutationTextOptions,
            appendNewInlineKeyboardRows: true,
            mergeExistingInlineKeyboard: true,
            ...(preparedText.textFormat ? { textFormat: preparedText.textFormat } : {}),
            ...(preserveExistingInlineKeyboard ? { preserveExistingInlineKeyboard: true } : {}),
            beforeSend: async () => {
              if (quickButtons) {
                await this.assertChannelQuickButtonsEnabled(chatId);
              }
              // FLAG: Re-read MAX and local authorization in the final callback before publishing.
              await this.channelAutoPostMutationGuard.assertForwardSendAuthorized(
                chatId,
                normalizedSenderId,
                autoAttachBotId,
              );
              await this.replacementAttachMarkerStore.recordChannelReplacementSendStarted({
                chatId,
                messageId,
                lockToken: claim.lockToken,
              });
              replacementSendStarted = true;
            },
            debugContext: {
              screen: 'channel-auto-post',
              action:
                source === 'poll'
                  ? 'scan-replace-forward-with-bot-copy'
                  : 'replace-forward-with-bot-copy',
            },
          },
          mutationRequestOptions,
        );
        replacementMessageId = sent.messageId;
        publishedUrl = sent.url ?? buildMaxMessageFallbackUrl(chatId, sent.messageId);
        deliveryMode = 'replace_with_bot_message';

        // FLAG: Persist the delivered copy before cleanup so recovery never republishes it.
        await this.replacementAttachMarkerStore.recordChannelReplacementMessage({
          chatId,
          messageId,
          lockToken: claim.lockToken,
          replacementMessageId,
          publishedUrl,
        });

        try {
          const cleanupInput: EnsureModerationDeleteIntentInput = {
            chatId,
            messageId,
            reasonKey: 'channel_auto_post_forward_replacement_cleanup',
            ruleCode: 'CHANNEL_AUTO_POST_FORWARD_REPLACEMENT_CLEANUP',
            subjectUserId: normalizedSenderId,
            ...(sourceMessageAt ? { sourceMessageAt } : {}),
            entityType: 'CHANNEL',
            messageAuthorKind: 'user',
            originBotId: autoAttachBotId,
            routingPolicy: 'origin_only',
            event: {
              eventType: null,
              metadata: {
                source,
                cleanupKind: 'channel_auto_post_forward_replacement',
                replacementMessageId,
              },
            },
          };
          const cleanupRequestOptions = {
            ...mutationRequestOptions,
            beforeImmediateDeleteMutation: () =>
              this.channelAutoPostMutationGuard.assertForwardDeleteAuthorized(
                chatId,
                normalizedSenderId,
                autoAttachBotId,
              ),
          };
          await this.ensureModerationDeleteIntent(cleanupInput, cleanupRequestOptions);
          const cleanup = await this.executeModerationDelete(cleanupInput, cleanupRequestOptions);
          originalDeleted = cleanup.gone;
          if (!cleanup.accepted) {
            originalCleanupError = 'Durable cleanup reached a terminal state';
            this.logger.warn(
              { chatId, messageId, replacementMessageId },
              'Durable cleanup could not accept original forwarded channel post deletion',
            );
          }
        } catch (deleteError: unknown) {
          originalCleanupError = this.extractErrorSummary(deleteError);
          originalCleanupStatusCode = this.extractStatusCode(deleteError);
          this.logger.warn(
            {
              chatId,
              messageId,
              status: this.extractStatusCode(deleteError),
              error: deleteError instanceof Error ? deleteError.message : 'Unknown error',
              replacementMessageId,
            },
            'Failed to delete original forwarded channel post after bot copy publish',
          );
        }
      } else {
        try {
          maxMutationAttemptStartedAt = new Date();
          editAttempts += 1;
          mutationApplied =
            (await this.maxClient.editMessageInlineKeyboard(
              chatId,
              messageId,
              editForwardInPlace ? null : preparedText.text,
              {
                buttons,
                ...mutationTextOptions,
                mergeExistingInlineKeyboard: true,
                preserveExistingChannelDialogButtons: true,
                requireAllAttachmentsPreserved: true,
                ...(preparedText.textFormat ? { textFormat: preparedText.textFormat } : {}),
                ...(preserveExistingInlineKeyboard ? { preserveExistingInlineKeyboard: true } : {}),
                beforeEditMutation,
                marketplaceChannelPost,
                debugContext: {
                  screen: 'channel-auto-post',
                  action: source === 'poll' ? 'scan-attach-buttons' : 'attach-buttons',
                },
              },
              mutationRequestOptions,
            )) !== false;
        } catch (mergedEditError: unknown) {
          const mergedEditStatus = this.extractStatusCode(mergedEditError);
          const mergedEditFailure = classifyMaxTerminalChatActionError(mergedEditError);
          const canRetryWithPreservedKeyboard =
            !quickButtons &&
            buttons.length > 0 &&
            mergedEditStatus !== null &&
            mergedEditStatus < 500 &&
            mergedEditStatus !== 429 &&
            !wasMaxPreDispatchGuardRejected(mergedEditError) &&
            !isAmbiguousMaxMutationError(mergedEditError) &&
            mergedEditFailure === null;
          if (!canRetryWithPreservedKeyboard) {
            throw mergedEditError;
          }

          this.logger.warn(
            {
              chatId,
              messageId,
              status: mergedEditStatus,
              error: this.extractErrorSummary(mergedEditError),
            },
            'Failed to merge channel post buttons; retrying with preserved actions first',
          );
          maxMutationAttemptStartedAt = new Date();
          editAttempts += 1;
          mutationApplied =
            (await this.maxClient.editMessageInlineKeyboard(
              chatId,
              messageId,
              editForwardInPlace ? null : preparedText.text,
              {
                // FLAG: A rejected merge never authorizes dropping Publisher discussions,
                // custom links, or media. Re-read and preserve the source under the edit lock.
                buttons,
                ...mutationTextOptions,
                mergeExistingInlineKeyboard: true,
                appendNewInlineKeyboardRows: true,
                preserveExistingChannelDialogButtons: true,
                requireAllAttachmentsPreserved: true,
                ...(preparedText.textFormat ? { textFormat: preparedText.textFormat } : {}),
                beforeEditMutation,
                marketplaceChannelPost,
                debugContext: {
                  screen: 'channel-auto-post',
                  action:
                    source === 'poll'
                      ? 'scan-attach-buttons-preserve-keyboard'
                      : 'attach-buttons-preserve-keyboard',
                },
              },
              mutationRequestOptions,
            )) !== false;
        }
      }
    } catch (error: unknown) {
      const status = this.extractStatusCode(error);
      if (
        await this.replacementAttachMarkerStore.deferChannelEditBeforeDispatch(
          { ...params, lockToken: claim.lockToken, botId: autoAttachBotId },
          error,
          editAttempts,
        )
      )
        return 'in_progress';
      if (replaceForward && replacementMessageId) {
        this.logger.error(
          {
            chatId,
            messageId,
            replacementMessageId,
            status,
            error: error instanceof Error ? error.message : String(error),
          },
          'Quarantined delivered channel replacement after marker persistence failure',
        );
        await this.replacementAttachMarkerStore.completeChannelAutoPost({
          chatId,
          messageId,
          lockToken: claim.lockToken,
          status: CHANNEL_AUTO_POST_ATTACH_STATUS.SUCCEEDED,
          source,
          botId: autoAttachBotId,
          linkType,
          deliveryMode: 'replace_with_bot_message',
          replacementMessageId,
          publishedUrl,
          lastError: `Delivered replacement marker persistence failed: ${this.extractErrorSummary(error)}`,
          lastStatusCode: status,
        });
        return 'attached';
      }
      if (
        replaceForward &&
        (replacementSendStarted || wasMaxMessageSendAttempted(error)) &&
        isAmbiguousMaxSendError(error)
      ) {
        await recordChannelAutoPostTerminalSkip(this.prisma, this.logger, {
          chatId,
          messageId,
          senderId: normalizedSenderId,
          botId: autoAttachBotId,
          linkType,
          source,
          deliveryMode: 'replace_with_bot_message',
          status,
          error,
        });
        await this.replacementAttachMarkerStore.completeChannelAutoPost({
          chatId,
          messageId,
          lockToken: claim.lockToken,
          status: CHANNEL_AUTO_POST_ATTACH_STATUS.SKIPPED,
          source,
          botId: autoAttachBotId,
          linkType,
          deliveryMode: 'replace_with_bot_message',
          lastError: `${MAX_SEND_AMBIGUOUS_ERROR_PREFIX} Ambiguous replacement send: ${this.extractErrorSummary(error)}`,
          lastStatusCode: status,
        });
        return 'skipped';
      }
      if (
        source === 'poll' &&
        maxMutationAttemptStartedAt &&
        (await this.recordChannelAutoPostAccessLossIfTerminal({
          chatId,
          botId: autoAttachBotId,
          source: 'channel_auto_post:poll_attach',
          operation: replaceForward ? 'send' : 'edit',
          lifecycleEventAt: maxMutationAttemptStartedAt,
          error,
        }))
      ) {
        await this.replacementAttachMarkerStore.completeChannelAutoPost({
          chatId,
          messageId,
          lockToken: claim.lockToken,
          status: CHANNEL_AUTO_POST_ATTACH_STATUS.SKIPPED,
          source,
          botId: autoAttachBotId,
          linkType,
          deliveryMode: replaceForward ? 'replace_with_bot_message' : 'edit_message',
          lastError: this.extractErrorSummary(error),
          lastStatusCode: status,
        });
        return 'skipped';
      }
      if (status && status < 500 && status !== 429 && !isAmbiguousMaxMutationError(error)) {
        this.logger.warn(
          {
            chatId,
            messageId,
            status,
            error: error instanceof Error ? error.message : 'Unknown error',
          },
          replaceForward
            ? 'Failed to replace forwarded channel post with bot copy; skipping retry'
            : 'Failed to edit channel post with managed buttons; skipping retry',
        );
        const failedDeliveryMode = replaceForward ? 'replace_with_bot_message' : 'edit_message';
        const terminalEditAttemptExhausted = failedDeliveryMode === 'edit_message';
        await recordChannelAutoPostTerminalSkip(this.prisma, this.logger, {
          chatId,
          messageId,
          senderId: normalizedSenderId,
          botId: autoAttachBotId,
          linkType,
          source,
          deliveryMode: failedDeliveryMode,
          ...(terminalEditAttemptExhausted ? { terminalEditAttemptExhausted: true } : {}),
          status,
          error,
        });
        await this.replacementAttachMarkerStore.completeChannelAutoPost({
          chatId,
          messageId,
          lockToken: claim.lockToken,
          status: CHANNEL_AUTO_POST_ATTACH_STATUS.SKIPPED,
          source,
          botId: autoAttachBotId,
          linkType,
          deliveryMode: failedDeliveryMode,
          ...(terminalEditAttemptExhausted ? { terminalEditAttemptExhausted: true } : {}),
          lastError: this.extractErrorSummary(error),
          lastStatusCode: status,
        });
        return 'skipped';
      }
      await this.replacementAttachMarkerStore.releaseChannelAutoPost({
        chatId,
        messageId,
        lockToken: claim.lockToken,
        source,
        botId: autoAttachBotId,
        linkType,
        lastError: persistChannelAutoPostPreDispatchFailureEvidence(
          error,
          this.extractErrorSummary(error),
        ),
        lastStatusCode: status,
      });
      throw error;
    }

    if (!mutationApplied) {
      await this.replacementAttachMarkerStore.completeChannelAutoPost({
        chatId,
        messageId,
        lockToken: claim.lockToken,
        status: CHANNEL_AUTO_POST_ATTACH_STATUS.SKIPPED,
        source,
        botId: autoAttachBotId,
        linkType,
        deliveryMode: null,
        lastError: 'Optional profile button is unavailable or already present.',
        lastStatusCode: null,
      });
      return 'noop';
    }
    await this.replacementAttachMarkerStore.completeChannelAutoPost({
      chatId,
      messageId,
      lockToken: claim.lockToken,
      status: CHANNEL_AUTO_POST_ATTACH_STATUS.SUCCEEDED,
      source,
      botId: autoAttachBotId,
      linkType,
      deliveryMode,
      replacementMessageId,
      publishedUrl,
      originalDeleted,
      lastError: originalCleanupError,
      lastStatusCode: originalCleanupStatusCode,
    });
    const auditIncludesCommentsButton =
      includeCommentsButton || existingButtonKinds.has('comments');
    const auditIncludesSuggestButton = includeSuggestButton || existingButtonKinds.has('suggest');
    const frozenButtonRows = buildChannelAutoPostButtons(
      managedChannel.channelSettings,
      {
        includeCommentsButton: auditIncludesCommentsButton,
        includeSuggestButton: auditIncludesSuggestButton,
      },
      (type, buttonText, suggestionEntryMode) =>
        this.buildChannelDialogButton(
          chatId,
          type,
          threadId,
          buttonText,
          autoAttachBotId,
          suggestionEntryMode,
        ),
      ctaButton,
    );
    try {
      await this.prisma.auditLog.create({
        data: {
          chatId,
          actorUserId: normalizedSenderId ?? 'system',
          action: CHANNEL_DIALOG_AUTO_ATTACH_ACTION,
          payload: {
            messageId,
            threadId,
            includeCommentsButton: auditIncludesCommentsButton,
            includeSuggestButton: auditIncludesSuggestButton,
            buttonRows: frozenButtonRows,
            commentsButton: auditIncludesCommentsButton
              ? { rowIndex: 0, columnIndex: 0, baseText: '💬 Комментарии' }
              : null,
            suggestButtonText:
              managedChannel.channelSettings.postSuggestionsButtonText.trim() ||
              '📰 Предложить пост',
            signatureApplied,
            suggestionEntryMode: managedChannel.channelSettings.postSuggestionsEntryMode,
            deliveryMode,
            linkType,
            replacementMessageId,
            ...(publishedUrl ? { publishedUrl } : {}),
            ...(text?.trim() ? { text } : {}),
            originalDeleted,
            cleanupState: originalDeleted ? 'confirmed' : originalCleanupError ? 'failed' : 'owned',
            ...(originalCleanupError ? { cleanupError: originalCleanupError } : {}),
            source,
            ...(params.schedulingOrigin ? { schedulingOrigin: params.schedulingOrigin } : {}),
            ...(autoAttachBotId ? { botId: autoAttachBotId } : {}),
          },
        },
      });
    } catch (error: unknown) {
      this.logger.warn(
        {
          chatId,
          messageId,
          replacementMessageId,
          error: this.extractErrorSummary(error),
        },
        'Failed to persist channel auto-post attach audit after durable completion',
      );
    }
    return 'attached';
  }

  private async isCurrentChannelEntity(chatId: string): Promise<boolean> {
    if (typeof this.prisma.chat?.findUnique !== 'function') {
      return false;
    }
    const chat = await this.prisma.chat.findUnique({
      where: { id: chatId },
      select: { entityType: true },
    });
    return chat?.entityType === ChatEntityType.CHANNEL;
  }

  private async loadManagedChannelContext(
    chatId: string,
    chatTitle?: string,
  ): Promise<ManagedChannelContext | null> {
    return loadManagedChannelAutoPostContext(this.prisma, chatId, chatTitle);
  }

  private isChannelMessage(update: MaxUpdate): boolean {
    return isChannelAutoPostMessage(update);
  }

  private async tryRecoverChatMessageCommentsAudit(params: {
    chatId: string;
    messageId: string;
    senderId: string;
  }): Promise<boolean> {
    const pendingAuditRecovery =
      await this.replacementAttachMarkerStore.probeChatAutoCommentAuditRecovery({
        chatId: params.chatId,
        messageId: params.messageId,
      });
    if (pendingAuditRecovery?.status === 'recovered_audit') {
      return true;
    }
    if (pendingAuditRecovery?.status !== 'recover_audit') {
      return false;
    }

    await this.recoverChatAutoCommentAudit({
      recovery: pendingAuditRecovery,
      chatId: params.chatId,
      messageId: params.messageId,
      senderId: params.senderId,
      fallbackBotId: null,
    });
    return true;
  }

  private async recoverChatAutoCommentAudit(params: {
    recovery: {
      markerId: string;
      replyMessageId: string;
      botId: string | null;
    };
    chatId: string;
    messageId: string;
    senderId: string;
    fallbackBotId: string | null;
  }): Promise<void> {
    const publisherBotId = this.configService?.get<string>('MAX_PUBLISHER_BOT_ID')?.trim() ?? '';
    if (publisherBotId && params.recovery.botId?.trim() === publisherBotId) {
      // The durable publisher job owns recovery because only its envelope retains dialogBotId.
      return;
    }
    await this.persistChatAutoCommentAudit({
      markerId: params.recovery.markerId,
      chatId: params.chatId,
      messageId: params.messageId,
      senderId: params.senderId,
      replyMessageId: params.recovery.replyMessageId,
      botId: params.recovery.botId?.trim() || params.fallbackBotId?.trim() || null,
    });
    await this.replacementAttachMarkerStore.completeChatAutoCommentAuditRecovery({
      markerId: params.recovery.markerId,
      chatId: params.chatId,
      messageId: params.messageId,
      replyMessageId: params.recovery.replyMessageId,
    });
  }

  private async persistChatAutoCommentAudit(params: {
    markerId: string;
    chatId: string;
    messageId: string;
    senderId: string;
    replyMessageId: string;
    botId: string | null;
  }): Promise<void> {
    const auditId = buildChatAutoCommentAuditId(params.markerId);
    if (!auditId) {
      throw new Error('Cannot persist chat auto-comment audit for an invalid marker id');
    }

    try {
      await this.prisma.auditLog.create({
        data: {
          id: auditId,
          chatId: params.chatId,
          actorUserId: params.senderId,
          action: CHAT_DIALOG_AUTO_ATTACH_ACTION,
          payload: {
            messageId: params.messageId,
            threadId: params.markerId,
            source: 'webhook',
            deliveryMode: 'reply_message',
            replyMessageId: params.replyMessageId,
            originalDeleted: false,
            ...(params.botId ? { botId: params.botId } : {}),
          },
        },
      });
    } catch (error: unknown) {
      if (!this.isPrismaKnownError(error, 'P2002')) {
        throw error;
      }
    }
  }

  private buildChannelDialogButton(
    chatId: string,
    type: ChannelDialogType,
    threadId: string,
    text: string,
    botId?: string | null,
    suggestionEntryMode: PersistedChannelSettings['postSuggestionsEntryMode'] = 'BOT',
  ): MaxMessageButton {
    if (type === 'suggest' && suggestionEntryMode !== 'MINIAPP') {
      const startPayload =
        this.adminDialogLinkService?.buildChannelSuggestionStartPayload(chatId, threadId, botId) ??
        this.buildChannelDialogStartParam(chatId, 'suggest', threadId);
      const botStartUrl = this.buildBotStartUrl(startPayload, botId);
      if (botStartUrl) {
        return {
          type: 'link',
          text,
          url: botStartUrl,
        };
      }
    }

    const launchUrl = this.buildChannelDialogLaunchUrl(chatId, type, threadId, botId);
    const webAppUrl = this.buildChannelDialogDirectWebAppUrl(chatId, type, threadId);
    const botContactId = this.resolveBotContactId(botId);

    if (launchUrl) {
      return {
        type: 'link',
        text,
        url: launchUrl,
      };
    }

    if (webAppUrl && botContactId) {
      return {
        type: 'open_app',
        text,
        webApp: webAppUrl,
        contactId: botContactId,
      };
    }

    return {
      type: 'link',
      text,
      url: webAppUrl ?? `${this.appBaseUrl ?? 'https://major-maksimov.ru'}/app/`,
    };
  }

  private buildChatDialogButton(
    chatId: string,
    type: ChannelDialogType,
    threadId: string,
    text: string,
    botId?: string | null,
  ): MaxMessageButton {
    const launchUrl = this.buildChatDialogLaunchUrl(chatId, type, threadId, botId);
    const webAppUrl = this.buildChatDialogDirectWebAppUrl(chatId, type, threadId);
    const botContactId = this.resolveBotContactId(botId);

    if (launchUrl) {
      return {
        type: 'link',
        text,
        url: launchUrl,
      };
    }

    if (webAppUrl && botContactId) {
      return {
        type: 'open_app',
        text,
        webApp: webAppUrl,
        contactId: botContactId,
      };
    }

    return {
      type: 'link',
      text,
      url: webAppUrl ?? `${this.appBaseUrl ?? 'https://major-maksimov.ru'}/app/`,
    };
  }

  private buildChannelDialogLaunchUrl(
    chatId: string,
    type: ChannelDialogType,
    threadId: string,
    _botId?: string | null,
  ): string | null {
    const startParam = this.buildChannelDialogStartParam(chatId, type, threadId);
    return this.buildEntryMiniappStartUrl(startParam);
  }

  private buildChatDialogLaunchUrl(
    chatId: string,
    type: ChannelDialogType,
    threadId: string,
    _botId?: string | null,
  ): string | null {
    const startParam = this.buildChatDialogStartParam(chatId, type, threadId);
    return this.buildEntryMiniappStartUrl(startParam);
  }

  private buildChannelDialogDirectWebAppUrl(
    chatId: string,
    type: ChannelDialogType,
    threadId: string,
  ): string | null {
    if (!this.appBaseUrl) {
      return null;
    }

    const token = this.buildChannelDialogToken(chatId, type, threadId);
    return `${this.appBaseUrl}/app/channel/${encodeURIComponent(chatId)}/dialog/${type}?token=${token}`;
  }

  private buildChatDialogDirectWebAppUrl(
    chatId: string,
    type: ChannelDialogType,
    threadId: string,
  ): string | null {
    if (!this.appBaseUrl) {
      return null;
    }

    const token = this.buildChatDialogToken(chatId, type, threadId);
    return `${this.appBaseUrl}/app/chat/${encodeURIComponent(chatId)}/dialog/${type}?token=${token}`;
  }

  private buildChannelDialogStartParam(
    chatId: string,
    type: ChannelDialogType,
    threadId: string,
  ): string {
    const token = this.buildChannelDialogToken(chatId, type, threadId);
    const payload = JSON.stringify({
      v: 1,
      k: 'channel-dialog',
      c: chatId,
      m: type,
      t: token,
    });
    const encoded = Buffer.from(payload, 'utf8').toString('base64url');
    return `${CHANNEL_DIALOG_START_PARAM_PREFIX}${encoded}`;
  }

  private buildChatDialogStartParam(
    chatId: string,
    type: ChannelDialogType,
    threadId: string,
  ): string {
    const token = this.buildChatDialogToken(chatId, type, threadId);
    const payload = JSON.stringify({
      v: 1,
      k: 'chat-dialog',
      c: chatId,
      m: type,
      t: token,
    });
    const encoded = Buffer.from(payload, 'utf8').toString('base64url');
    return `${CHANNEL_DIALOG_START_PARAM_PREFIX}${encoded}`;
  }

  private buildEntryMiniappStartUrl(startParam: string): string | null {
    if (!isValidMaxMiniappStartPayload(startParam)) {
      return null;
    }

    return (
      this.maxBotLinkService?.buildEntryMiniappStartUrlSync?.(startParam) ??
      this.maxBotLinkService?.buildMiniappStartUrlSync?.(startParam) ??
      (this.ownBotUserId
        ? `https://max.ru/${encodeURIComponent(this.ownBotUserId)}?startapp=${encodeURIComponent(startParam)}`
        : null)
    );
  }

  private buildBotStartUrl(startPayload: string, botId?: string | null): string | null {
    if (!isValidMaxBotStartPayload(startPayload)) {
      return null;
    }

    const fallbackBotId = botId?.trim() || this.ownBotUserId;
    return (
      this.maxBotLinkService?.buildBotStartUrlSync?.(startPayload, botId) ??
      (fallbackBotId
        ? `https://max.ru/${encodeURIComponent(fallbackBotId)}?start=${encodeURIComponent(startPayload)}`
        : null)
    );
  }

  private buildChannelDialogToken(
    chatId: string,
    type: ChannelDialogType,
    threadId: string,
  ): string {
    const payload = JSON.stringify({
      v: 1,
      d: threadId,
      s: this.buildChannelDialogTokenSignature(chatId, type, threadId),
    });
    const encoded = Buffer.from(payload, 'utf8').toString('base64url');
    return `${CHANNEL_DIALOG_TOKEN_PREFIX}${encoded}`;
  }

  private buildChatDialogToken(chatId: string, type: ChannelDialogType, threadId: string): string {
    const payload = JSON.stringify({
      v: 1,
      d: threadId,
      s: this.buildChatDialogTokenSignature(chatId, type, threadId),
    });
    const encoded = Buffer.from(payload, 'utf8').toString('base64url');
    return `${CHANNEL_DIALOG_TOKEN_PREFIX}${encoded}`;
  }

  private buildChannelDialogTokenSignature(
    chatId: string,
    type: ChannelDialogType,
    threadId: string,
  ): string {
    const scope = `dialog:${chatId}:${type}:${threadId}`;
    return createHmac('sha256', this.getCurrentBotToken()).update(scope).digest('hex');
  }

  private buildChatDialogTokenSignature(
    chatId: string,
    type: ChannelDialogType,
    threadId: string,
  ): string {
    const scope = `dialog:chat:${chatId}:${type}:${threadId}`;
    return createHmac('sha256', this.getCurrentBotToken()).update(scope).digest('hex');
  }

  private getCurrentBotToken(): string {
    return this.maxBotLinkService?.getBotTokenSync?.() ?? this.maxBotToken ?? '';
  }

  private async reconcileLinkAllowlistViolations(params: {
    chatId: string;
    text: string;
    settings: ChatSettings;
    navigationTargets?: readonly NavigationTargetEvidence[];
    cachedDomainAllowlist: string[];
    violations: RuleViolation[];
  }): Promise<RuleViolation[]> {
    if (
      !needsFreshLinkAllowlistRecheck(
        params.settings.linkPolicy,
        params.violations,
        params.navigationTargets,
      )
    ) {
      return params.violations;
    }

    let freshDomainAllowlist: string[] | null = null;
    try {
      freshDomainAllowlist = await this.loadFreshDomainAllowlistForLinkRecheck(params.chatId);
    } catch (error) {
      this.logger.warn(
        {
          chatId: params.chatId,
          error: error instanceof Error ? error.message : 'Unknown error',
        },
        'Fresh allowlist link recheck failed',
      );
      return suppressUnverifiedAllowlistDependentViolations(
        params.settings.linkPolicy,
        params.violations,
      );
    }

    if (!freshDomainAllowlist) {
      return params.violations;
    }

    const recalculatedViolations = recalculateFreshLinkAllowlistViolations({
      text: params.text,
      settings: params.settings,
      freshDomainAllowlist,
      navigationTargets: params.navigationTargets,
      violations: params.violations,
      blockedDomainDetector: this.blockedDomainDetector,
    });

    if (
      recalculatedViolations.some(
        (violation) =>
          violation.ruleCode === 'LINK_BLOCKED' || violation.ruleCode === 'MESSAGE_BLOCKED_DOMAIN',
      )
    ) {
      return recalculatedViolations;
    }

    this.logger.debug(
      {
        chatId: params.chatId,
        cachedAllowlistSize: params.cachedDomainAllowlist.length,
        freshAllowlistSize: freshDomainAllowlist.length,
      },
      'Suppressed link-family violations after fresh allowlist recheck',
    );
    void this.chatContextCache?.invalidate(params.chatId).catch((error: unknown) => {
      this.logger.debug(
        {
          chatId: params.chatId,
          error: error instanceof Error ? error.message : 'Unknown error',
        },
        'Failed to invalidate chat context after fresh allowlist recheck',
      );
    });

    return recalculatedViolations;
  }

  private async loadFreshDomainAllowlistForLinkRecheck(chatId: string): Promise<string[] | null> {
    const domainAllowlistDelegate = (
      this.prisma as unknown as {
        domainAllowlist?: {
          findMany?: (args: {
            where: {
              chatId: string;
              OR: Array<{ removeAfterAt: null } | { removeAfterAt: { gt: Date } }>;
            };
            select: { domain: true };
          }) => Promise<Array<{ domain: string }>>;
        };
      }
    ).domainAllowlist;

    if (typeof domainAllowlistDelegate?.findMany !== 'function') {
      return null;
    }

    const rows = await domainAllowlistDelegate.findMany({
      where: {
        chatId,
        OR: [{ removeAfterAt: null }, { removeAfterAt: { gt: new Date() } }],
      },
      select: {
        domain: true,
      },
    });

    return rows.map((row) => row.domain);
  }

  private async loadChatContext(
    chatId: string,
    chatTitle?: string,
  ): Promise<{
    settings: ChatSettings;
    domainAllowlist: string[];
    adminUserIds: string[];
    rulesPublishedUrl: string | null;
    rulesPublishedMessageId: string | null;
  }> {
    const startedAtMs = Date.now();
    if (this.chatContextCache) {
      const cached = await this.chatContextCache.getChatContext(chatId, chatTitle);
      this.recordRuntimeStageObservation('chat-context.cache', Date.now() - startedAtMs);
      return {
        settings: cached.settings,
        domainAllowlist: cached.domainAllowlist,
        adminUserIds: cached.adminUserIds,
        rulesPublishedUrl: cached.rulesPublishedUrl ?? null,
        rulesPublishedMessageId: cached.rulesPublishedMessageId ?? null,
      };
    }

    const fallbackTitle = `Chat ${chatId}`;
    const resolvedTitle = chatTitle?.trim() || fallbackTitle;
    const chat = await this.prisma.chat.upsert({
      where: { id: chatId },
      create: {
        id: chatId,
        title: resolvedTitle,
        settings: {
          create: {},
        },
      },
      update: {
        ...(chatTitle?.trim()
          ? {
              title: chatTitle.trim(),
            }
          : {}),
      },
      include: {
        settings: true,
        rules: {
          select: {
            publishedUrl: true,
            publishedMessageId: true,
          },
        },
        domains: {
          where: {
            OR: [{ removeAfterAt: null }, { removeAfterAt: { gt: new Date() } }],
          },
          select: {
            domain: true,
          },
        },
        admins: {
          select: {
            userId: true,
          },
        },
      },
    });

    if (!chat.settings) {
      throw new Error(`Chat settings missing for chat ${chatId}`);
    }

    this.recordRuntimeStageObservation('chat-context.db', Date.now() - startedAtMs);

    return {
      settings: chat.settings,
      domainAllowlist: (chat.domains ?? []).map((item) => item.domain),
      adminUserIds: (chat.admins ?? []).map((item) => item.userId),
      rulesPublishedUrl: chat.rules?.publishedUrl ?? null,
      rulesPublishedMessageId: chat.rules?.publishedMessageId ?? null,
    };
  }

  private async loadRulesButtonReferenceMap(
    chatIds: readonly string[],
  ): Promise<Map<string, RulesButtonReference>> {
    const normalizedChatIds = Array.from(
      new Set(chatIds.map((item) => item.trim()).filter(Boolean)),
    );
    if (normalizedChatIds.length === 0 || !this.prisma.chatRules?.findMany) {
      return new Map();
    }

    const rows = await this.prisma.chatRules.findMany({
      where: {
        chatId: {
          in: normalizedChatIds,
        },
        OR: [{ publishedUrl: { not: null } }, { publishedMessageId: { not: null } }],
      },
      select: {
        chatId: true,
        publishedUrl: true,
        publishedMessageId: true,
      },
    });

    const hydratedRows = await Promise.all(
      rows.map(async (row) => {
        const resolvedUrl = await this.resolveRulesPublishedUrl(
          row.chatId,
          row.publishedUrl ?? null,
          row.publishedMessageId ?? null,
        );
        const publishedMessageId = row.publishedMessageId ?? null;
        if (!resolvedUrl && !publishedMessageId) {
          return null;
        }

        return [
          row.chatId,
          {
            publishedUrl: resolvedUrl,
            publishedMessageId,
          },
        ] as const;
      }),
    );
    const entries: Array<[string, RulesButtonReference]> = [];
    for (const row of hydratedRows) {
      if (!row) {
        continue;
      }
      entries.push([row[0], row[1]]);
    }

    return new Map(entries);
  }

  private async resolveRulesPublishedUrl(
    chatId: string,
    publishedUrl: string | null,
    publishedMessageId: string | null,
    botId?: string,
  ): Promise<string | null> {
    const normalizedPublishedUrl = this.normalizeBotButtonUrl(publishedUrl ?? '');
    if (normalizedPublishedUrl) {
      return normalizedPublishedUrl;
    }

    const normalizedMessageId = publishedMessageId?.trim() ?? '';
    if (!normalizedMessageId) {
      return null;
    }

    let resolvedUrl: string | null = null;
    try {
      resolvedUrl = this.normalizeBotButtonUrl(
        (botId
          ? await this.maxClient.resolveMessageLink(normalizedMessageId, { botId })
          : await this.maxClient.resolveMessageLink(normalizedMessageId)) ?? '',
      );
    } catch (error: unknown) {
      this.logger.warn(
        {
          chatId,
          messageId: normalizedMessageId,
          error: error instanceof Error ? error.message : 'Unknown error',
        },
        'Failed to recover published rules url',
      );
      return null;
    }

    if (!resolvedUrl) {
      return null;
    }

    try {
      if (this.prisma.chatRules?.update) {
        await this.prisma.chatRules.update({
          where: { chatId },
          data: {
            publishedUrl: resolvedUrl,
          },
        });
      }
      await this.chatContextCache?.invalidate(chatId);
    } catch (error: unknown) {
      this.logger.warn(
        {
          chatId,
          messageId: normalizedMessageId,
          error: error instanceof Error ? error.message : 'Unknown error',
        },
        'Failed to persist recovered published rules url',
      );
    }

    return resolvedUrl;
  }

  private applyDegradeSettings(settings: ChatSettings, _degradeMode: boolean): ChatSettings {
    return settings;
  }

  private readLowerString(value: unknown): string | null {
    return typeof value === 'string' && value.trim().length > 0 ? value.trim().toLowerCase() : null;
  }

  private readString(value: unknown): string | null {
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
  }

  private readBoolean(value: unknown): boolean | null {
    return typeof value === 'boolean' ? value : null;
  }

  private extractStatusCode(error: unknown): number | null {
    return extractHttpStatusCode(error);
  }

  private extractErrorSummary(error: unknown): string {
    const message =
      error instanceof Error && error.message.trim().length > 0
        ? error.message.trim()
        : typeof (error as { message?: unknown } | null)?.message === 'string'
          ? (error as { message: string }).message.trim() || 'Unknown error'
          : String(error ?? 'Unknown error');
    return message.slice(0, 500);
  }

  private isPrismaKnownError(error: unknown, code: string): boolean {
    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      return error.code === code;
    }

    return (error as { code?: string } | null)?.code === code;
  }

  private extractMaxErrorCode(error: unknown): string | null {
    const maybeCode = (error as { response?: { data?: { code?: unknown } } })?.response?.data?.code;
    return typeof maybeCode === 'string' && maybeCode.trim().length > 0
      ? maybeCode.trim().toLowerCase()
      : null;
  }

  private extractMaxErrorMessage(error: unknown): string {
    const responseMessage = (error as { response?: { data?: { message?: unknown } } })?.response
      ?.data?.message;
    if (typeof responseMessage === 'string' && responseMessage.trim().length > 0) {
      return responseMessage.trim().toLowerCase();
    }

    return error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  }

  private isTerminalPrivateDialogDeliveryError(error: unknown): boolean {
    const status = this.extractStatusCode(error);
    if (status === 403 || status === 404) {
      return true;
    }

    const code = this.extractMaxErrorCode(error);
    if (code === 'chat.denied' || code === 'chat.not.found' || code === 'message.not.found') {
      return true;
    }

    const message = this.extractMaxErrorMessage(error);
    return (
      message.includes('bot is not a chat member') ||
      message.includes('not accessible') ||
      message.includes('chat not found')
    );
  }

  private isTerminalCallbackError(error: unknown): boolean {
    const status = this.extractStatusCode(error);
    if (status === 400 || status === 404) {
      return true;
    }

    const code = this.extractMaxErrorCode(error);
    if (code === 'callback.not.found' || code === 'message_callback.not_found') {
      return true;
    }

    const message = this.extractMaxErrorMessage(error);
    return (
      message.includes('callback') &&
      (message.includes('expired') || message.includes('not found') || message.includes('invalid'))
    );
  }

  private isTerminalWebhookProcessingError(error: unknown): boolean {
    if (
      rulesFence.isRetryable(error) ||
      (error as { sharedChatExecutionLockRetryable?: unknown } | null)
        ?.sharedChatExecutionLockRetryable === true
    ) {
      return false;
    }

    if (error instanceof UnrecoverableError) {
      return true;
    }

    if (this.isWebhookHotPathTimeoutError(error)) {
      return false;
    }

    const status = this.extractStatusCode(error);
    if (status === 403 || status === 404) {
      return true;
    }

    const code = this.extractMaxErrorCode(error);
    if (code === 'chat.denied' || code === 'chat.not.found' || code === 'message.not.found') {
      return true;
    }

    const message = this.extractMaxErrorMessage(error);
    return (
      message.includes('bot is not a chat member') ||
      message.includes('not accessible') ||
      message.includes('chat not found')
    );
  }

  private readWebhookProcessingRetryAfterMs(error: unknown): number | undefined {
    const retryError = error as {
      retryAfterMs?: unknown;
      sharedChatExecutionLockRetryable?: unknown;
    } | null;
    if (!rulesFence.isRetryable(error) && retryError?.sharedChatExecutionLockRetryable !== true) {
      return undefined;
    }
    const retryAfterMs = retryError?.retryAfterMs;
    if (typeof retryAfterMs !== 'number' || !Number.isFinite(retryAfterMs) || retryAfterMs <= 0) {
      return undefined;
    }
    return Math.trunc(retryAfterMs);
  }

  private isWebhookHotPathTimeoutError(error: unknown): boolean {
    return (error as { webhookHotPathTimeout?: unknown })?.webhookHotPathTimeout === true;
  }

  private createWebhookHotPathTimeoutPersistenceError(params: {
    timeoutError: Error;
    persistenceError: unknown;
  }): Error {
    const timeout = params.timeoutError as Error & {
      code?: string;
      chatId?: string | null;
      activeBotId?: string | null;
      webhookHotPathContext?: Record<string, unknown> | null;
    };
    const error = new Error(
      `Webhook timeout quarantine persistence failed: ${this.formatWebhookProcessingErrorMessage(
        params.persistenceError,
      )}`,
    ) as Error & {
      code?: string;
      webhookHotPathTimeout?: boolean;
      chatId?: string | null;
      activeBotId?: string | null;
      webhookHotPathContext?: Record<string, unknown> | null;
    };
    error.code = timeout.code;
    error.webhookHotPathTimeout = true;
    error.chatId = timeout.chatId;
    error.activeBotId = timeout.activeBotId;
    error.webhookHotPathContext = timeout.webhookHotPathContext;
    return error;
  }

  private async executeWebhookUpdateWithGuard(
    webhookEventId: string,
    update: MaxUpdate,
    activeBotId: string | null,
    task: () => Promise<void>,
    getTimeoutContext?: () => Record<string, unknown> | null,
  ): Promise<WebhookUpdateGuardResult> {
    const timeoutMs = this.resolveWebhookHotPathTimeoutMs(update);
    if (timeoutMs === null) {
      await task();
      return { kind: 'completed' };
    }

    const startedAtMs = Date.now();
    const taskPromise = Promise.resolve().then(task);
    taskPromise.catch(() => undefined);

    let timeout: NodeJS.Timeout | null = null;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeout = setTimeout(() => {
        const timeoutContext = getTimeoutContext?.() ?? null;
        reject(
          this.createWebhookHotPathTimeoutError({
            webhookEventId,
            update,
            activeBotId,
            timeoutMs,
            timeoutContext,
          }),
        );
      }, timeoutMs);
      timeout.unref?.();
    });

    try {
      await Promise.race([taskPromise, timeoutPromise]);
      const durationMs = Date.now() - startedAtMs;
      const timeoutContext = getTimeoutContext?.() ?? null;
      if (timeoutContext) {
        void this.runtimeDiagnosticsService?.recordHotPathProfile({
          snapshot: timeoutContext,
        });
      }
      if (durationMs >= WEBHOOK_USER_FACING_SLOW_LOG_THRESHOLD_MS) {
        void this.runtimeDiagnosticsService?.recordHotPathProfile({
          snapshot: {
            latestStage: 'user-facing-total',
            stageDurations: {
              'user-facing-total': durationMs,
            },
          },
        });
        this.logger.warn(
          {
            webhookEventId,
            updateType: this.readLowerString(update.type),
            chatId: this.extractWebhookHotPathChatId(update),
            activeBotId,
            durationMs,
            timeoutMs,
            ...(timeoutContext ?? {}),
          },
          'Slow webhook user-facing hot path completed close to the watchdog deadline',
        );
      }
      return { kind: 'completed' };
    } catch (error: unknown) {
      if ((error as { code?: unknown })?.code === 'WEBHOOK_USER_FACING_TIMEOUT') {
        const timeoutContext = getTimeoutContext?.() ?? null;
        const latestStage =
          timeoutContext && typeof timeoutContext.latestStage === 'string'
            ? timeoutContext.latestStage
            : 'unknown';
        if (timeoutContext) {
          void this.runtimeDiagnosticsService?.recordHotPathProfile({
            snapshot: timeoutContext,
          });
        }
        void this.runtimeDiagnosticsService?.recordHotPathStageOutcome({
          stage: latestStage,
          outcome: 'timeout',
          failOpen: false,
        });
        const successBoundaryReached = timeoutContext?.successBoundaryReached === true;
        this.logger.warn(
          {
            webhookEventId,
            updateType: this.readLowerString(update.type),
            chatId: this.extractWebhookHotPathChatId(update),
            activeBotId,
            latestStage,
            successBoundaryReached,
            timeoutMs,
          },
          'Detached webhook hot path after the watchdog timeout; quarantining until it settles',
        );
        return {
          kind: 'timed_out',
          detachedTask: taskPromise,
          timeoutError: error instanceof Error ? error : new Error(String(error)),
        };
      }
      throw error;
    } finally {
      if (timeout) {
        clearTimeout(timeout);
      }
    }
  }

  private startWebhookTimeoutSettlementWatchdog(
    webhookEventId: string,
  ): WebhookTimeoutSettlementWatchdog {
    const deadlineAtMs = Date.now() + WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINE_MAX_LIFETIME_MS;
    let expired = false;
    let stopped = false;
    const timer = setTimeout(() => {
      if (stopped) {
        return;
      }
      expired = true;
      this.logger.error(
        { webhookEventId },
        'Terminating a worker process whose webhook timeout did not settle durably',
      );
      process.exit(1);
    }, WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINE_MAX_LIFETIME_MS);

    return {
      deadlineAtMs,
      isExpired: () => expired,
      stop: () => {
        if (stopped) {
          return;
        }
        stopped = true;
        clearTimeout(timer);
      },
    };
  }

  private observeTimedOutWebhookExecution(params: {
    execution: WebhookCanonicalExecutionContext;
    detachedTask: Promise<void>;
    quarantineLease: WebhookTimeoutQuarantineLease;
    commercialOcrPendingActivations: CommercialOcrPendingActivation[];
    settlementWatchdog: WebhookTimeoutSettlementWatchdog;
  }): void {
    const webhookEventId = params.execution.webhookEvent.id;
    const heartbeat = this.webhookCanonicalExecutionService.startTimedOutExecutionHeartbeat(
      params.execution,
      params.quarantineLease,
    );
    void (async () => {
      const outcome = await params.detachedTask.then(
        () => ({ kind: 'completed' as const }),
        (error: unknown) => ({ kind: 'failed' as const, error }),
      );
      const durableSettlement = await this.persistWebhookTimeoutSettlementWithRetry({
        webhookEventId,
        outcome: outcome.kind,
        settlementWatchdog: params.settlementWatchdog,
        persist: async () => {
          const quarantineLease = await heartbeat.stop();
          if (outcome.kind === 'completed') {
            return this.webhookCanonicalExecutionService.completeTimedOutExecution(
              params.execution,
              quarantineLease,
            );
          }
          return this.webhookCanonicalExecutionService.failTimedOutExecution(
            params.execution,
            quarantineLease,
            { errorMessage: this.formatWebhookProcessingErrorMessage(outcome.error) },
          );
        },
        isDurable: (settled) => settled !== 'retry',
        logMessage: 'Could not persist detached webhook settlement; the hard fence remains active',
      });
      if (durableSettlement === null) return;
      params.settlementWatchdog.stop();
      if (durableSettlement === 'duplicate') {
        this.logger.warn(
          { webhookEventId },
          'Converged a timed-out shadow mirror on its completed semantic owner',
        );
        return;
      }
      const failed = outcome.kind === 'failed';
      if (durableSettlement === 'quarantined' || failed) {
        await this.commercialOcrEnqueueService?.suppressPendingBatch(
          params.commercialOcrPendingActivations,
        );
        this.logger[failed ? 'warn' : 'error'](
          failed
            ? { webhookEventId, err: this.formatWebhookProcessingErrorMessage(outcome.error) }
            : { webhookEventId },
          failed
            ? 'Detached webhook execution failed after timeout'
            : 'Retained a durable webhook timeout quarantine after exact claim settlement was unavailable',
        );
        return;
      }
      await this.commercialOcrEnqueueService?.activatePendingBatch(
        params.commercialOcrPendingActivations,
      );
      this.logger.log(
        { webhookEventId },
        'Detached webhook execution completed after timeout quarantine',
      );
    })().catch((error: unknown) => {
      this.logger.error(
        {
          webhookEventId,
          err: this.formatWebhookProcessingErrorMessage(error),
        },
        'Detached webhook timeout observer failed before durable settlement',
      );
    });
  }

  private async persistTimedOutWebhookFallback(params: {
    execution: WebhookCanonicalExecutionContext;
    timeoutError: Error;
    timeoutErrorMessage: string;
    persistenceError: unknown;
  }): Promise<WebhookTimeoutQuarantineLease> {
    let quarantineLease: WebhookTimeoutQuarantineLease;
    try {
      quarantineLease = await this.webhookCanonicalExecutionService.quarantineTimedOutExecution(
        params.execution,
        {
          errorMessage: `${params.timeoutErrorMessage}; initial timeout quarantine persistence failed: ${this.formatWebhookProcessingErrorMessage(params.persistenceError)}`,
        },
      );
    } catch (fallbackError: unknown) {
      throw this.createWebhookHotPathTimeoutPersistenceError({
        timeoutError: params.timeoutError,
        persistenceError: fallbackError,
      });
    }

    this.logger.error(
      {
        webhookEventId: params.execution.webhookEvent.id,
        err:
          params.persistenceError instanceof Error
            ? params.persistenceError.message
            : String(params.persistenceError),
      },
      'Initial webhook timeout quarantine write failed; persisted fenced fallback quarantine',
    );
    return quarantineLease;
  }

  // FLAG: Without a durable timeout marker, returning from the BullMQ processor would permit a
  // retry while the original task is live or its settlement is not persisted. Keep the job lock,
  // retry quarantine or settlement persistence, and terminate at the maximum orphan lifetime.
  private async recoverTimedOutWebhookWithoutDurableQuarantine(params: {
    execution: WebhookCanonicalExecutionContext;
    detachedTask: Promise<void>;
    timeoutErrorMessage: string;
    persistenceError: unknown;
    commercialOcrPendingActivations: CommercialOcrPendingActivation[];
    settlementWatchdog: WebhookTimeoutSettlementWatchdog;
  }): Promise<WebhookTimeoutQuarantineLease | null> {
    type DetachedOutcome = { kind: 'completed' } | { kind: 'failed'; error: unknown };

    let lastPersistenceLogAtMs = Date.now();
    let outcome: DetachedOutcome | null = null;
    const settlement = params.detachedTask.then(
      () => {
        outcome = { kind: 'completed' };
      },
      (error: unknown) => {
        outcome = { kind: 'failed', error };
      },
    );
    this.logger.error(
      {
        webhookEventId: params.execution.webhookEvent.id,
        err:
          params.persistenceError instanceof Error
            ? params.persistenceError.message
            : String(params.persistenceError),
      },
      'Webhook timeout quarantine is unavailable; retaining the BullMQ job until fenced or settled',
    );

    while (outcome === null && !params.settlementWatchdog.isExpired()) {
      await Promise.race([
        settlement,
        this.waitForWebhookTimeoutPersistenceRetry(
          WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINE_PERSIST_RETRY_MS,
        ),
      ]);
      if (outcome !== null) {
        break;
      }

      try {
        const lease = await this.webhookCanonicalExecutionService.quarantineTimedOutExecution(
          params.execution,
          {
            errorMessage: `${params.timeoutErrorMessage}; recovered after repeated timeout quarantine persistence failures`,
          },
        );
        this.logger.error(
          { webhookEventId: params.execution.webhookEvent.id },
          'Recovered durable webhook timeout quarantine while retaining the BullMQ job',
        );
        return lease;
      } catch (error: unknown) {
        const nowMs = Date.now();
        if (nowMs - lastPersistenceLogAtMs >= WEBHOOK_TIMEOUT_PERSISTENCE_LOG_INTERVAL_MS) {
          lastPersistenceLogAtMs = nowMs;
          this.logger.error(
            {
              webhookEventId: params.execution.webhookEvent.id,
              err: error instanceof Error ? error.message : String(error),
            },
            'Could not recover durable webhook timeout quarantine; the BullMQ job remains active',
          );
        }
      }
    }

    if (outcome === null) {
      return null;
    }

    const settledOutcome = outcome as DetachedOutcome;
    const durableSettlement = await this.persistWebhookTimeoutSettlementWithRetry({
      webhookEventId: params.execution.webhookEvent.id,
      outcome: settledOutcome.kind,
      settlementWatchdog: params.settlementWatchdog,
      persist: () =>
        this.webhookCanonicalExecutionService.settleUnquarantinedTimedOutExecution(
          params.execution,
          settledOutcome.kind === 'failed'
            ? {
                kind: 'failed',
                error: this.formatWebhookProcessingErrorMessage(settledOutcome.error),
              }
            : {
                kind: 'completed',
                timeoutErrorMessage: params.timeoutErrorMessage,
              },
        ),
      isDurable: () => true,
      logMessage: 'Could not persist unfenced webhook settlement; the BullMQ job remains active',
    });
    if (durableSettlement === null) {
      return null;
    }

    params.settlementWatchdog.stop();
    if (settledOutcome.kind === 'failed' || durableSettlement === 'quarantined') {
      await this.commercialOcrEnqueueService?.suppressPendingBatch(
        params.commercialOcrPendingActivations,
      );
    } else {
      await this.commercialOcrEnqueueService?.activatePendingBatch(
        params.commercialOcrPendingActivations,
      );
    }
    return null;
  }

  private async persistWebhookTimeoutSettlementWithRetry<T>(params: {
    webhookEventId: string;
    outcome: 'completed' | 'failed';
    settlementWatchdog: WebhookTimeoutSettlementWatchdog;
    persist: () => Promise<T>;
    isDurable: (result: T) => boolean;
    logMessage: string;
  }): Promise<T | null> {
    let persistenceAttempt = 0;
    let lastPersistenceLogAtMs = 0;

    while (!params.settlementWatchdog.isExpired()) {
      let persistenceError: unknown;
      try {
        const result = await params.persist();
        if (params.isDurable(result)) {
          return result;
        }
        persistenceError = new Error('Webhook timeout settlement CAS was not owned');
      } catch (error: unknown) {
        persistenceError = error;
      }

      persistenceAttempt += 1;
      const nowMs = Date.now();
      const retryDelayMs = Math.min(
        WEBHOOK_TIMEOUT_SETTLEMENT_PERSIST_RETRY_MAX_MS,
        WEBHOOK_HOT_PATH_TIMEOUT_QUARANTINE_PERSIST_RETRY_MS *
          2 ** Math.min(persistenceAttempt - 1, 10),
      );
      if (
        persistenceAttempt === 1 ||
        nowMs - lastPersistenceLogAtMs >= WEBHOOK_TIMEOUT_PERSISTENCE_LOG_INTERVAL_MS
      ) {
        lastPersistenceLogAtMs = nowMs;
        this.logger.error(
          {
            webhookEventId: params.webhookEventId,
            outcome: params.outcome,
            persistenceAttempt,
            retryDelayMs,
            err: this.formatWebhookProcessingErrorMessage(persistenceError),
          },
          params.logMessage,
        );
      }

      const remainingLifetimeMs = Math.max(1, params.settlementWatchdog.deadlineAtMs - nowMs);
      await this.waitForWebhookTimeoutPersistenceRetry(Math.min(retryDelayMs, remainingLifetimeMs));
    }

    return null;
  }

  private waitForWebhookTimeoutPersistenceRetry(delayMs: number): Promise<void> {
    return delay(delayMs, undefined, { ref: false });
  }

  private resolveWebhookHotPathTimeoutMs(update: MaxUpdate): number | null {
    const updateType = this.readLowerString(update.type);
    if (updateType === 'message_callback') {
      return this.webhookUserFacingTimeoutMs;
    }

    const chatId = this.extractWebhookHotPathChatId(update);
    if (
      (updateType === 'message_created' || updateType === 'message_edited') &&
      chatId &&
      chatId.startsWith('-')
    ) {
      return this.webhookUserFacingTimeoutMs;
    }

    return null;
  }

  private isWebhookHotTimeoutChatBackoffActive(chatId: string): boolean {
    const backoffUntilMs = this.webhookHotTimeoutChatBackoffUntilMs.get(chatId) ?? 0;
    if (backoffUntilMs <= Date.now()) {
      if (backoffUntilMs > 0) {
        this.webhookHotTimeoutChatBackoffUntilMs.delete(chatId);
      }
      return false;
    }

    return true;
  }

  private rememberWebhookHotTimeoutChat(chatId: string | null): void {
    if (!chatId || !chatId.startsWith('-')) {
      return;
    }

    this.webhookHotTimeoutChatBackoffUntilMs.set(chatId, Date.now() + WEBHOOK_HOT_CHAT_BACKOFF_MS);
  }

  private shouldRememberWebhookHotTimeoutChat(
    timeoutContext?: Record<string, unknown> | null,
  ): boolean {
    const latestStage = timeoutContext ? this.readString(timeoutContext.latestStage) : null;
    return !latestStage || !WEBHOOK_HOT_TIMEOUT_BACKOFF_SUPPRESSED_STAGES.has(latestStage);
  }

  private shouldSkipOptionalHotChatStages(
    mode: SystemModeSnapshot,
    hotChatBackoffActive: boolean,
  ): boolean {
    if (!hotChatBackoffActive) {
      return false;
    }

    if (mode.mode === 'degrade' && !isSystemModeRecoveryWindow(mode)) {
      return true;
    }

    return (
      (mode.operationalQueueLagSec ?? mode.queueLagSec) >=
      REQUIRED_SUBSCRIPTION_PRESSURE_SKIP_QUEUE_LAG_SEC
    );
  }

  private logOptionalHotChatStageSkip(
    chatId: string,
    userId: string,
    mode: SystemModeSnapshot,
  ): void {
    const now = Date.now();
    if (now - this.webhookHotChatSkipLogAtMs < WEBHOOK_HOT_CHAT_SKIP_LOG_INTERVAL_MS) {
      return;
    }

    this.webhookHotChatSkipLogAtMs = now;
    this.logger.warn(
      {
        chatId,
        userId,
        queueLagSec: mode.queueLagSec,
        mode: mode.mode,
        reason: mode.reason || 'system pressure',
      },
      'Skipped optional remote moderation stages because the chat is in hot-timeout backoff',
    );
  }

  private extractWebhookHotPathChatId(update: MaxUpdate): string | null {
    return typeof update.message?.chatId === 'string' && update.message.chatId.trim().length > 0
      ? update.message.chatId.trim()
      : null;
  }

  private createWebhookHotPathTimeoutError(params: {
    webhookEventId: string;
    update: MaxUpdate;
    activeBotId: string | null;
    timeoutMs: number;
    timeoutContext?: Record<string, unknown> | null;
  }): Error {
    const error = new Error(
      `Webhook user-facing hot path timed out after ${params.timeoutMs}ms for ${
        this.readLowerString(params.update.type) ?? 'unknown'
      }`,
    ) as Error & {
      code?: string;
      webhookHotPathTimeout?: boolean;
      webhookEventId?: string;
      chatId?: string | null;
      activeBotId?: string | null;
      webhookHotPathContext?: Record<string, unknown> | null;
    };
    error.code = 'WEBHOOK_USER_FACING_TIMEOUT';
    error.webhookHotPathTimeout = true;
    error.webhookEventId = params.webhookEventId;
    error.chatId = this.extractWebhookHotPathChatId(params.update);
    error.activeBotId = params.activeBotId;
    error.webhookHotPathContext = params.timeoutContext ?? null;
    const hotChatBackoffSuppressed = !this.shouldRememberWebhookHotTimeoutChat(
      params.timeoutContext,
    );
    if (!hotChatBackoffSuppressed) {
      this.rememberWebhookHotTimeoutChat(error.chatId);
    }
    this.logger.warn(
      {
        webhookEventId: params.webhookEventId,
        updateType: this.readLowerString(params.update.type),
        chatId: error.chatId,
        activeBotId: params.activeBotId,
        timeoutMs: params.timeoutMs,
        hotChatBackoffSuppressed,
        ...(params.timeoutContext ?? {}),
      },
      'Webhook user-facing hot path timed out; quarantining the event to keep the shard responsive',
    );
    return error;
  }

  private formatWebhookProcessingErrorMessage(error: unknown): string {
    const baseMessage = error instanceof Error ? error.message : 'Unknown error';
    if (!(error instanceof Error)) {
      return baseMessage;
    }

    const timeoutError = error as Error & {
      code?: string;
      chatId?: string | null;
      activeBotId?: string | null;
      webhookHotPathContext?: Record<string, unknown> | null;
    };
    if (
      timeoutError.code !== 'WEBHOOK_USER_FACING_TIMEOUT' ||
      !timeoutError.webhookHotPathContext
    ) {
      return baseMessage;
    }

    const details: string[] = [];
    const latestStage = this.readString(timeoutError.webhookHotPathContext.latestStage);
    if (latestStage) {
      details.push(`latestStage=${latestStage}`);
    }

    const elapsedMs = timeoutError.webhookHotPathContext.elapsedMs;
    if (typeof elapsedMs === 'number' && Number.isFinite(elapsedMs) && elapsedMs >= 0) {
      details.push(`elapsedMs=${Math.trunc(elapsedMs)}`);
    }

    const chatId =
      this.readString(timeoutError.chatId) ??
      this.readString(timeoutError.webhookHotPathContext.chatId);
    if (chatId) {
      details.push(`chatId=${chatId}`);
    }

    const activeBotId =
      this.readString(timeoutError.activeBotId) ??
      this.readString(timeoutError.webhookHotPathContext.activeBotId);
    if (activeBotId) {
      details.push(`activeBotId=${activeBotId}`);
    }

    if (details.length === 0) {
      return baseMessage;
    }

    return `${baseMessage} [${details.join(', ')}]`;
  }

  private resolveOptionalWebhookStageSkipReason(params: {
    stage: string;
    hotPathProfile?: WebhookHotPathProfile | null;
    systemMode: SystemModeSnapshot;
    hotChatBackoffActive?: boolean;
    minRemainingMs?: number;
  }): string | null {
    const snapshot = this.readWebhookHotPathProfileSnapshot(params.hotPathProfile);
    const elapsedMs =
      typeof snapshot?.elapsedMs === 'number' && Number.isFinite(snapshot.elapsedMs)
        ? snapshot.elapsedMs
        : null;
    if (elapsedMs === null) {
      return null;
    }

    const remainingMs = Math.max(0, this.webhookUserFacingTimeoutMs - elapsedMs);
    const pressureActive = this.isWebhookHotPathPressureActive(
      params.systemMode,
      params.hotChatBackoffActive,
    );
    if (!pressureActive) {
      return null;
    }

    const minRemainingMs = Math.max(
      1,
      Math.ceil(params.minRemainingMs ?? WEBHOOK_OPTIONAL_STAGE_MIN_REMAINING_MS),
    );
    if (remainingMs > minRemainingMs) {
      return null;
    }

    if (params.hotChatBackoffActive) {
      return `${params.stage} skipped with ${remainingMs}ms remaining in hot-chat backoff`;
    }
    if (params.systemMode.mode === 'degrade') {
      return `${params.stage} skipped with ${remainingMs}ms remaining during ${params.systemMode.reason || 'degrade'}`;
    }
    const queueLagSec = params.systemMode.operationalQueueLagSec ?? params.systemMode.queueLagSec;
    return `${params.stage} skipped with ${remainingMs}ms remaining at queue lag ${queueLagSec.toFixed(1)}s`;
  }

  private isWebhookHotPathPressureActive(
    systemMode: SystemModeSnapshot,
    hotChatBackoffActive = false,
  ): boolean {
    return (
      hotChatBackoffActive ||
      systemMode.mode === 'degrade' ||
      (systemMode.operationalQueueLagSec ?? systemMode.queueLagSec) >=
        REQUIRED_SUBSCRIPTION_PRESSURE_SKIP_QUEUE_LAG_SEC / 2
    );
  }

  private resolveWebhookHotPathStageWaitBudgetMs(params: {
    hotPathProfile?: WebhookHotPathProfile | null;
    systemMode: SystemModeSnapshot;
    hotChatBackoffActive?: boolean;
    defaultWaitMs: number;
    reserveMs?: number;
  }): number {
    const defaultWaitMs = Math.max(1, Math.ceil(params.defaultWaitMs));
    const snapshot = this.readWebhookHotPathProfileSnapshot(params.hotPathProfile);
    const elapsedMs =
      typeof snapshot?.elapsedMs === 'number' && Number.isFinite(snapshot.elapsedMs)
        ? snapshot.elapsedMs
        : null;
    if (elapsedMs === null) {
      return defaultWaitMs;
    }

    if (!this.isWebhookHotPathPressureActive(params.systemMode, params.hotChatBackoffActive)) {
      return defaultWaitMs;
    }

    const reserveMs = Math.max(0, Math.ceil(params.reserveMs ?? 0));
    const remainingMs = Math.max(0, this.webhookUserFacingTimeoutMs - elapsedMs - reserveMs);
    return Math.min(defaultWaitMs, remainingMs);
  }

  private recordOptionalWebhookStageSkip(params: {
    stage: string;
    reason: string;
    failOpen?: boolean;
  }): void {
    this.logger.warn(
      {
        stage: params.stage,
        reason: params.reason,
      },
      'Skipped optional moderation stage because the hot-path budget is almost exhausted',
    );
    void this.runtimeDiagnosticsService?.recordHotPathStageOutcome({
      stage: params.stage,
      outcome: 'skip',
      failOpen: params.failOpen,
    });
  }

  private shouldDetachFollowUpForBudget(
    hotPathProfile: WebhookHotPathProfile | null | undefined,
    stage: string,
    minRemainingMs = 2_000,
  ): boolean {
    const snapshot = this.readWebhookHotPathProfileSnapshot(hotPathProfile);
    if (snapshot?.successBoundaryReached !== true) {
      return false;
    }

    const elapsedMs =
      typeof snapshot.elapsedMs === 'number' && Number.isFinite(snapshot.elapsedMs)
        ? snapshot.elapsedMs
        : null;
    if (elapsedMs === null) {
      return false;
    }

    const remainingMs = Math.max(0, this.webhookUserFacingTimeoutMs - elapsedMs);
    if (remainingMs >= Math.max(1, Math.ceil(minRemainingMs))) {
      return false;
    }

    this.recordOptionalWebhookStageSkip({
      stage: `${stage}.deferred`,
      reason: `${stage} detached with ${remainingMs}ms remaining after the destructive action boundary`,
      failOpen: true,
    });
    return true;
  }

  private scheduleDetachedWebhookFollowUp(params: {
    stage: string;
    chatId: string;
    userId?: string | null;
    messageId?: string | null;
    task: () => Promise<void>;
  }): void {
    const stage = params.stage.trim() || 'follow-up';
    void this.runtimeDiagnosticsService?.recordHotPathStageOutcome({
      stage: 'follow_up_deferred',
      outcome: 'skip',
      failOpen: true,
    });

    const immediate = setImmediate(() => {
      void Promise.resolve()
        .then(params.task)
        .catch((error: unknown) => {
          void this.runtimeDiagnosticsService?.recordHotPathStageOutcome({
            stage: 'follow_up_failed',
            outcome: 'timeout',
            failOpen: true,
          });
          void this.runtimeDiagnosticsService?.recordHotPathStageOutcome({
            stage: `${stage}.failed`,
            outcome: 'timeout',
            failOpen: true,
          });
          this.logger.warn(
            {
              stage,
              chatId: params.chatId,
              userId: params.userId ?? null,
              messageId: params.messageId ?? null,
              err: error instanceof Error ? error.message : String(error),
            },
            'Deferred webhook follow-up failed after the user-facing success boundary',
          );
        });
    });
    immediate.unref?.();
  }

  private recordRuntimeStageObservation(stage: string, elapsedMs: number): void {
    if (!stage.trim()) {
      return;
    }

    void this.runtimeDiagnosticsService?.recordHotPathProfile({
      snapshot: {
        stageDurations: {
          [stage]: Math.max(0, Math.trunc(elapsedMs)),
        },
      },
    });
  }

  private createWebhookHotPathProfile(): WebhookHotPathProfile {
    const now = Date.now();
    return {
      startedAtMs: now,
      lastMarkedAtMs: now,
      latestStage: 'start',
      stages: new Map(),
      stageTimelineMs: new Map(),
      successBoundaryReached: false,
      successBoundaryStage: null,
    };
  }

  private markWebhookHotPathStage(
    profile: WebhookHotPathProfile | null | undefined,
    stage: string,
  ): void {
    if (!profile) {
      return;
    }

    const now = Date.now();
    profile.latestStage = stage;
    profile.stages.set(stage, Math.max(0, now - profile.lastMarkedAtMs));
    profile.stageTimelineMs.set(stage, Math.max(0, now - profile.startedAtMs));
    profile.lastMarkedAtMs = now;
  }

  private markWebhookHotPathSuccessBoundary(
    profile: WebhookHotPathProfile | null | undefined,
    stage: string,
  ): void {
    if (!profile) {
      return;
    }

    profile.successBoundaryReached = true;
    profile.successBoundaryStage = stage;
  }

  private readWebhookHotPathProfileSnapshot(
    profile: WebhookHotPathProfile | null | undefined,
  ): Record<string, unknown> | null {
    if (!profile) {
      return null;
    }

    const stageDurations = Object.fromEntries(profile.stages.entries());
    const stageTimelineMs = Object.fromEntries(profile.stageTimelineMs.entries());
    return {
      latestStage: profile.latestStage,
      successBoundaryReached: profile.successBoundaryReached,
      successBoundaryStage: profile.successBoundaryStage,
      elapsedMs: Date.now() - profile.startedAtMs,
      stageDurations,
      stageTimelineMs,
    };
  }

  private isNightModeTerminalDeleteError(error: unknown): boolean {
    const status = this.extractStatusCode(error);
    if (status === 403) {
      return true;
    }

    const code = this.extractMaxErrorCode(error);
    if (code === 'chat.denied' || code === 'chat.not.found') {
      return true;
    }

    const message = this.extractMaxErrorMessage(error);
    return message.includes('bot is not a chat member') || message.includes('not accessible');
  }

  private isMaxApiThrottleError(error: unknown): boolean {
    const status = this.extractStatusCode(error);
    if (status === 429) {
      return true;
    }

    const message = this.extractMaxErrorMessage(error);
    return (
      message.includes('rate limit exceeded') ||
      message.includes('source limit exceeded') ||
      message.includes('circuit breaker')
    );
  }

  private isMaxApiTimeoutError(error: unknown): boolean {
    const code = (error as { code?: unknown })?.code;
    if (typeof code === 'string' && code.trim().toUpperCase() === 'ECONNABORTED') {
      return true;
    }

    return this.extractMaxErrorMessage(error).includes('timeout');
  }

  private isTransientMaxApiLookupError(error: unknown): boolean {
    if (this.isMaxApiThrottleError(error) || this.isMaxApiTimeoutError(error)) {
      return true;
    }

    const status = this.extractStatusCode(error);
    if (status !== null && status >= 500) {
      return true;
    }

    const code = (error as { code?: unknown } | null)?.code;
    return (
      typeof code === 'string' &&
      ['ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT'].includes(
        code.trim().toUpperCase(),
      )
    );
  }

  private normalizeSecret(value: string | undefined): string | null {
    if (typeof value !== 'string') {
      return null;
    }

    const normalized = value.trim();
    return normalized.length > 0 ? normalized : null;
  }

  private normalizeOwnBotUserId(value: string | undefined): string | null {
    if (typeof value !== 'string') {
      return null;
    }
    const normalized = value.trim();
    return normalized.length > 0 ? normalized : null;
  }

  private parseChatIdSet(value: string | undefined): Set<string> {
    if (typeof value !== 'string') {
      return new Set();
    }

    return new Set(
      value
        .split(/[,\s;]+/u)
        .map((item) => item.trim())
        .filter((item) => item.length > 0),
    );
  }

  private isOwnBotSender(userId: string): boolean {
    if (this.maxBotLinkService?.isKnownBotUserId?.(userId)) {
      return true;
    }

    if (this.ownBotUserIdVariants.size === 0) {
      return false;
    }

    for (const variant of this.buildBotIdVariants(userId)) {
      if (this.ownBotUserIdVariants.has(variant)) {
        return true;
      }
    }

    return false;
  }

  private isKnownRuntimeBotUserId(userId: string | null | undefined): boolean {
    if (typeof userId !== 'string' || userId.trim().length === 0) {
      return false;
    }

    if (this.maxBotLinkService?.isKnownBotUserId?.(userId)) {
      return true;
    }

    if (this.ownBotUserIdVariants.size === 0) {
      return false;
    }

    for (const variant of this.buildBotIdVariants(userId)) {
      if (this.ownBotUserIdVariants.has(variant)) {
        return true;
      }
    }

    return false;
  }

  private isCurrentBotSender(userId: string, update: MaxUpdate): boolean {
    const senderVariants = this.buildStrictBotIdVariants(userId);
    if (senderVariants.size === 0) {
      return false;
    }

    const explicitCurrentBotIds = [
      this.maxBotContextService?.getActiveBotId?.(),
      this.readString(update.botId),
    ]
      .map((item) => (typeof item === 'string' ? item.trim() : ''))
      .filter((item) => item.length > 0);

    if (explicitCurrentBotIds.length > 0) {
      const currentBotIdentities = new Set(
        explicitCurrentBotIds
          .flatMap((botId) => [
            botId,
            this.readString(this.maxBotLinkService?.resolveContactIdSync?.(botId)),
          ])
          .filter((botId): botId is string => typeof botId === 'string' && botId.length > 0),
      );
      return [...currentBotIdentities].some((botId) =>
        this.hasBotIdVariantOverlap(senderVariants, this.buildStrictBotIdVariants(botId)),
      );
    }

    return this.hasBotIdVariantOverlap(this.buildBotIdVariants(userId), this.ownBotUserIdVariants);
  }

  private hasBotIdVariantOverlap(left: Set<string>, right: Set<string>): boolean {
    if (left.size === 0 || right.size === 0) {
      return false;
    }

    for (const variant of left) {
      if (right.has(variant)) {
        return true;
      }
    }

    return false;
  }

  private buildStrictBotIdVariants(value: string | null | undefined): Set<string> {
    if (typeof value !== 'string') {
      return new Set<string>();
    }

    const normalized = value.trim().toLowerCase();
    if (normalized.length === 0) {
      return new Set<string>();
    }

    const variants = new Set<string>([normalized]);
    if (normalized.startsWith('id') && normalized.length > 2) {
      variants.add(normalized.slice(2));
    }
    if (normalized.endsWith('_bot') && normalized.length > 4) {
      variants.add(normalized.slice(0, -4));
    }
    if (normalized.startsWith('id') && normalized.endsWith('_bot') && normalized.length > 6) {
      variants.add(normalized.slice(2, -4));
    }

    return variants;
  }

  private buildBotIdVariants(value: string | null | undefined): Set<string> {
    if (typeof value !== 'string') {
      return new Set<string>();
    }

    const normalized = value.trim().toLowerCase();
    if (normalized.length === 0) {
      return new Set<string>();
    }

    const variants = new Set<string>([normalized]);

    if (normalized.startsWith('id') && normalized.length > 2) {
      variants.add(normalized.slice(2));
    }

    if (normalized.endsWith('_bot') && normalized.length > 4) {
      variants.add(normalized.slice(0, -4));
    }

    if (normalized.startsWith('id') && normalized.endsWith('_bot') && normalized.length > 6) {
      variants.add(normalized.slice(2, -4));
    }

    for (const variant of [...variants]) {
      const primary = variant.split('_')[0];
      if (/^\d+$/.test(primary)) {
        variants.add(primary);
      }
    }

    return variants;
  }

  private buildUserIdVariants(value: string | null | undefined): Set<string> {
    if (typeof value !== 'string') {
      return new Set<string>();
    }

    const normalized = value.trim().toLowerCase();
    if (normalized.length === 0) {
      return new Set<string>();
    }

    const variants = new Set<string>([normalized]);

    if (normalized.startsWith('id') && normalized.length > 2) {
      variants.add(normalized.slice(2));
    } else {
      variants.add(`id${normalized}`);
    }

    return variants;
  }

  private async collectCommercialCampaignContext(params: {
    chatId: string;
    senderId: string;
    text: string;
    eventTimestampMs?: number;
  }): Promise<CommercialCampaignContext | null> {
    return collectCommercialCampaignContextFromRedis(params, {
      redisCounter: this.redisCounter,
      onLookupError: (error) => {
        this.logger.warn(
          {
            chatId: params.chatId,
            userId: params.senderId,
            error: error instanceof Error ? error.message : String(error),
          },
          'Commercial campaign lookup failed; continuing without cross-chat signals',
        );
      },
    });
  }

  private isNightModeNoticeMessage(params: {
    text: string;
    settings: Pick<
      ChatSettings,
      | 'nightModeEnabled'
      | 'nightModeBotMessageEnabled'
      | 'nightModeOpenMessageEnabled'
      | 'nightModeStartTimeMinutes'
      | 'nightModeEndTimeMinutes'
      | 'nightModeTimezone'
      | 'nightModeBotMessageText'
      | 'nightModeOpenMessageText'
      | 'botSpeechStyle'
    >;
  }): boolean {
    return isNightModeNoticeTextMessage({
      text: params.text,
      settings: params.settings,
      activeBotSpeechProfile: this.resolveActiveBotSpeechProfile(),
    });
  }

  private async sendBotMessageWithOptionalAutoDelete(params: {
    chatId: string;
    botId?: string;
    text: string;
    messageOptions?: MaxSendMessageOptions;
    media?: BotSpeechResolvedMedia | null;
    deleteBotMessagesEnabled: boolean;
    deleteBotMessagesDelayMinutes: number;
    immediate?: boolean;
    /** Route a user-visible sanction notice through the interactive lane without blocking this worker. */
    userFacing?: boolean;
    bypassNoticeBucket?: boolean;
    idempotencyKey?: string;
    /** Final guard before the durable send handoff; queued delivery may outlive the caller lease. */
    beforeSend?: () => Promise<void>;
    ledgerContext?: MaxActionLedgerContext;
    beforeImmediateSendMutation?: ModerationNoticeImmediateOptions['beforeImmediateSendMutation'];
  }): Promise<boolean> {
    const {
      chatId,
      botId,
      text,
      messageOptions,
      media,
      deleteBotMessagesEnabled,
      deleteBotMessagesDelayMinutes,
      immediate,
      userFacing,
      bypassNoticeBucket,
      idempotencyKey,
      beforeSend,
      ledgerContext,
    } = params;

    if (
      immediate !== true &&
      userFacing !== true &&
      bypassNoticeBucket !== true &&
      !(await this.shouldSendBotNotice(chatId))
    ) {
      return false;
    }

    const resolvedMessageOptions = await this.withBotSpeechMediaOptions(messageOptions, media, {
      trafficClass: immediate === true || userFacing === true ? 'interactive' : 'background',
      actionHealthLane: immediate === true || userFacing === true ? 'interactive' : 'background',
      sourceTag: MAX_API_SOURCE_TAGS.MODERATION_NOTICE,
      ...(botId ? { botId } : {}),
    });
    const sourceTextFormat = resolvedMessageOptions?.textFormat ?? 'markdown';
    const preparedMessage = prepareFormattedTextForMaxDelivery(text, sourceTextFormat);
    if (!preparedMessage) {
      throw new UnrecoverableError(
        `MAX moderation notice exceeds ${MAX_MESSAGE_TEXT_LENGTH} characters after formatting`,
      );
    }
    await beforeSend?.();
    await this.maxClient.sendMessage(
      chatId,
      preparedMessage.text,
      {
        ...(resolvedMessageOptions ?? {}),
        textFormat: preparedMessage.textFormat,
      },
      buildModerationNoticeDispatchOptions(
        {
          deleteBotMessagesEnabled,
          deleteBotMessagesDelayMinutes,
          immediate,
          userFacing,
          botId,
          idempotencyKey,
          ledgerContext,
          beforeImmediateSendMutation: params.beforeImmediateSendMutation,
        },
        MAX_API_SOURCE_TAGS.MODERATION_NOTICE,
        MODERATION_CHAT_ACTION_TERMINAL_FAILURE_METRIC_STATUSES,
      ),
    );
    return true;
  }

  private resolveBotSpeechMedia(
    settings: { botSpeechMedia?: unknown },
    fieldKey?: BotSpeechMediaFieldKey,
  ): BotSpeechResolvedMedia | null {
    return this.botSpeechMediaService.resolveMedia(settings, fieldKey);
  }

  private async withBotSpeechMediaOptions(
    options: MaxSendMessageOptions | undefined,
    media?: BotSpeechResolvedMedia | null,
    uploadOptions: BotSpeechMediaUploadOptions = {},
  ): Promise<MaxSendMessageOptions | undefined> {
    return this.botSpeechMediaService.withMediaOptions(options, media, uploadOptions);
  }

  private async uploadBotSpeechImage(
    media: BotSpeechResolvedMedia,
    options: BotSpeechMediaUploadOptions = {},
  ): Promise<Record<string, unknown>> {
    return this.botSpeechMediaService.uploadImage(media, options);
  }

  private async shouldSendBotNotice(chatId: string): Promise<boolean> {
    const normalizedChatId = chatId.trim();
    const incrementWithTtl = (this.redisCounter as Partial<RedisCounterService> | undefined)
      ?.incrementWithTtl;
    if (!normalizedChatId || !this.redisCounter || typeof incrementWithTtl !== 'function') {
      return true;
    }

    try {
      const count = await incrementWithTtl.call(
        this.redisCounter,
        `moderation:bot-notice-bucket:v1:${normalizedChatId}`,
        BOT_NOTICE_TOKEN_BUCKET_TTL_SEC,
      );
      if (count <= this.botNoticeTokenBucketLimit) {
        return true;
      }

      void this.runtimeDiagnosticsService?.recordHotPathStageOutcome({
        stage: 'bot-notice-token-bucket',
        outcome: 'skip',
        failOpen: false,
      });
      return false;
    } catch (error: unknown) {
      this.logger.debug(
        {
          chatId: normalizedChatId,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to apply bot notice token bucket',
      );
      return true;
    }
  }

  async processNightModeTransitionJob(
    job: NightModeTransitionJob,
  ): Promise<NightModeTransitionProcessResult> {
    return this.nightModeTransitionRuntime.processNightModeTransitionJob(
      job,
      this.createNightModeTransitionHooks(),
    );
  }

  private async processNightModeTransitionForChat(
    settings: NightModeTransitionRuntimeSettings,
    providedSnapshot?: NightModeTransitionSnapshot,
  ): Promise<NightModeTransitionProcessResult> {
    return this.nightModeTransitionRuntime.processNightModeTransitionForChat(
      settings,
      this.createNightModeTransitionHooks(),
      providedSnapshot,
    );
  }

  private resolveNightModeTransitionSnapshot(
    settings: Pick<
      ChatSettings,
      | 'nightModeEnabled'
      | 'nightModeStartTimeMinutes'
      | 'nightModeEndTimeMinutes'
      | 'nightModeTimezone'
    >,
    now = new Date(),
  ): NightModeTransitionSnapshot | null {
    return this.nightModeTransitionRuntime.resolveNightModeTransitionSnapshot(settings, now);
  }

  private buildNightModeClosedNoticeOptions(params: {
    chatId: string;
    commentsEnabled: boolean;
    nightModeCommentsEnabled: boolean;
    nightModeBotButtons: unknown;
    nightModeBotButtonEnabled: boolean;
    nightModeBotButtonUrl: string;
    nightModeBotButtonText: string;
    nightModeRulesButtonEnabled?: boolean;
    rulesPublishedUrl?: string | null;
    rulesPublishedMessageId?: string | null;
  }): MaxSendMessageOptions | null {
    const baseOptions = this.buildBotMessageOptions(
      params.chatId,
      params.nightModeBotButtons,
      params.nightModeBotButtonEnabled,
      params.nightModeBotButtonUrl,
      params.nightModeBotButtonText,
      params.nightModeRulesButtonEnabled ?? false,
      params.rulesPublishedUrl ?? null,
      params.rulesPublishedMessageId ?? null,
    );
    const commentsButton = buildNightModeCommentsButton({
      chatId: params.chatId,
      commentsEnabled: params.commentsEnabled,
      nightModeCommentsEnabled: params.nightModeCommentsEnabled,
      buildButton: ({ chatId, threadId, text }) =>
        this.buildChatDialogButton(chatId, 'comments', threadId, text),
    });

    return composeNightModeClosedNoticeOptions({
      baseOptions,
      commentsButton,
    });
  }

  private async resolveNightModeTransitionBotId(chatId: string): Promise<string | null> {
    return resolveNightModeTransitionBotIdForModeration(
      {
        maxBotLinkService: this.maxBotLinkService,
      },
      chatId,
    );
  }

  private scheduleChannelAutoPostStartupScan() {
    const startupDelayMs =
      this.channelAutoPostStartupDelayMs +
      (this.channelAutoPostStartupJitterMs > 0
        ? Math.floor(Math.random() * (this.channelAutoPostStartupJitterMs + 1))
        : 0);
    this.channelAutoPostStartupTimer = setTimeout(() => {
      this.channelAutoPostStartupTimer = null;
      void this.processChannelAutoPostButtons();
    }, startupDelayMs);
    this.channelAutoPostStartupTimer.unref();
  }

  private readPositiveConfigInt(value: unknown, fallback: number, min = 1): number {
    const numericValue =
      typeof value === 'number'
        ? value
        : typeof value === 'string' && value.trim().length > 0
          ? Number(value)
          : Number.NaN;
    if (Number.isFinite(numericValue) && numericValue >= min) {
      return Math.trunc(numericValue);
    }

    return fallback;
  }

  private readNonNegativeConfigInt(value: unknown, fallback: number): number {
    const numericValue =
      typeof value === 'number'
        ? value
        : typeof value === 'string' && value.trim().length > 0
          ? Number(value)
          : Number.NaN;
    if (Number.isFinite(numericValue) && numericValue >= 0) {
      return Math.trunc(numericValue);
    }

    return fallback;
  }

  private readFractionConfig(value: unknown, fallback: number): number {
    const numericValue =
      typeof value === 'number'
        ? value
        : typeof value === 'string' && value.trim().length > 0
          ? Number(value)
          : Number.NaN;
    if (Number.isFinite(numericValue) && numericValue > 0 && numericValue <= 1) {
      return numericValue;
    }

    return fallback;
  }

  private readBooleanConfig(value: unknown, fallback: boolean): boolean {
    if (typeof value === 'boolean') {
      return value;
    }
    if (typeof value === 'number') {
      return value !== 0;
    }
    if (typeof value === 'string') {
      const normalized = value.trim().toLowerCase();
      if (
        normalized === 'true' ||
        normalized === '1' ||
        normalized === 'yes' ||
        normalized === 'on'
      ) {
        return true;
      }
      if (
        normalized === 'false' ||
        normalized === '0' ||
        normalized === 'no' ||
        normalized === 'off'
      ) {
        return false;
      }
    }

    return fallback;
  }

  private async mapWithConcurrency<T, R>(
    items: readonly T[],
    requestedConcurrency: number,
    mapper: (item: T, index: number) => Promise<R>,
  ): Promise<R[]> {
    if (items.length === 0) {
      return [];
    }

    const results = new Array<R>(items.length);
    const concurrency = Math.min(items.length, Math.max(1, Math.trunc(requestedConcurrency)));
    let nextIndex = 0;

    const workers = Array.from({ length: concurrency }, async () => {
      while (nextIndex < items.length) {
        const currentIndex = nextIndex;
        nextIndex += 1;
        results[currentIndex] = await mapper(items[currentIndex]!, currentIndex);
      }
    });

    await Promise.all(workers);
    return results;
  }

  private async sleep(ms: number): Promise<void> {
    if (ms <= 0) {
      return;
    }

    await new Promise<void>((resolve) => {
      setTimeout(resolve, ms);
    });
  }

  private readStoredMuteDurationHoursFromMetadata(metadata: unknown): number | null {
    if (metadata && typeof metadata === 'object' && !Array.isArray(metadata)) {
      const normalizedMetadata = metadata as Record<string, unknown>;
      const value =
        typeof normalizedMetadata.muteDurationHours === 'number'
          ? normalizedMetadata.muteDurationHours
          : normalizedMetadata.banDurationHours;
      if (
        typeof value === 'number' &&
        Number.isInteger(value) &&
        value >= 1 &&
        value <= MAX_ACTIVE_MUTE_DURATION_HOURS
      ) {
        return value;
      }
    }

    return null;
  }

  private readPermanentMuteFromMetadata(metadata: unknown): boolean {
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
      return false;
    }

    return (metadata as Record<string, unknown>).mutePermanent === true;
  }

  private readMuteDurationHoursFromMetadata(metadata: unknown, fallback: number): number {
    const storedValue = this.readStoredMuteDurationHoursFromMetadata(metadata);
    if (storedValue !== null) {
      return storedValue;
    }

    if (Number.isInteger(fallback) && fallback >= 1 && fallback <= MAX_ACTIVE_MUTE_DURATION_HOURS) {
      return fallback;
    }

    return DEFAULT_MUTE_DURATION_HOURS;
  }

  private formatMuteDurationLabel(hours: number): string {
    const safeHours =
      Number.isInteger(hours) && hours >= 1 && hours <= 36 ? hours : DEFAULT_MUTE_DURATION_HOURS;
    return `${safeHours}ч`;
  }

  private async readCachedActiveMute(
    chatId: string,
    userId: string,
  ): Promise<ActiveMuteCacheReadResult> {
    const getString = (this.redisCounter as Partial<RedisCounterService> | undefined)?.getString;
    if (typeof getString !== 'function') {
      return { status: 'miss' };
    }

    try {
      const raw = await getString.call(this.redisCounter, buildActiveMuteStateKey(chatId, userId));
      if (raw === null) {
        return { status: 'miss' };
      }
      if (raw === '0') {
        return { status: 'inactive' };
      }

      const parsed = JSON.parse(raw) as Partial<CachedActiveMuteState>;
      const eventId = typeof parsed.eventId === 'string' ? parsed.eventId.trim() : '';
      const ruleCode =
        parsed.ruleCode === null
          ? null
          : typeof parsed.ruleCode === 'string' && parsed.ruleCode.trim().length > 0
            ? parsed.ruleCode.trim()
            : undefined;
      const permanent = parsed.permanent === true;
      const durationHours =
        typeof parsed.durationHours === 'number' && Number.isFinite(parsed.durationHours)
          ? Math.trunc(parsed.durationHours)
          : Number.NaN;
      const issuedAtMs =
        typeof parsed.issuedAt === 'string' ? Date.parse(parsed.issuedAt) : Number.NaN;
      const expiresAtMs =
        typeof parsed.expiresAt === 'string' ? Date.parse(parsed.expiresAt) : Number.NaN;
      if (!eventId || !Number.isFinite(issuedAtMs) || ruleCode === undefined) {
        return { status: 'miss' };
      }

      if (permanent) {
        return {
          status: 'active',
          mute: {
            eventId,
            issuedAt: new Date(issuedAtMs),
            expiresAt: null,
            durationHours: null,
            permanent: true,
            ruleCode,
          },
        };
      }

      if (
        !Number.isInteger(durationHours) ||
        durationHours < 1 ||
        durationHours > MAX_ACTIVE_MUTE_DURATION_HOURS ||
        !Number.isFinite(expiresAtMs)
      ) {
        return { status: 'miss' };
      }

      const mute: ActiveMute = {
        eventId,
        issuedAt: new Date(issuedAtMs),
        expiresAt: new Date(expiresAtMs),
        durationHours,
        permanent: false,
        ruleCode,
      };
      if (expiresAtMs <= Date.now()) {
        await this.rememberInactiveActiveMuteState(chatId, userId);
        return { status: 'miss' };
      }

      return {
        status: 'active',
        mute,
      };
    } catch (error: unknown) {
      this.logger.debug(
        {
          chatId,
          userId,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to read cached active mute state',
      );
      return { status: 'miss' };
    }
  }

  private async rememberActiveMuteState(
    chatId: string,
    userId: string,
    mute: ActiveMute,
  ): Promise<boolean> {
    if (await this.isLegacyModerationHeld(chatId, userId)) return false;
    const setStringWithTtl = (this.redisCounter as Partial<RedisCounterService> | undefined)
      ?.setStringWithTtl;
    if (typeof setStringWithTtl !== 'function') {
      return false;
    }

    const ttlSec = mute.permanent
      ? PERMANENT_ACTIVE_MUTE_CACHE_TTL_SEC
      : mute.expiresAt
        ? Math.ceil((mute.expiresAt.getTime() - Date.now()) / 1_000) + ACTIVE_MUTE_CACHE_SLACK_SEC
        : 0;
    if (!Number.isFinite(ttlSec) || ttlSec <= 0) {
      return false;
    }

    try {
      await setStringWithTtl.call(
        this.redisCounter,
        buildActiveMuteStateKey(chatId, userId),
        JSON.stringify({
          eventId: mute.eventId,
          issuedAt: mute.issuedAt.toISOString(),
          expiresAt: mute.expiresAt ? mute.expiresAt.toISOString() : null,
          durationHours: mute.durationHours,
          permanent: mute.permanent,
          ruleCode: mute.ruleCode ?? null,
        } satisfies CachedActiveMuteState),
        ttlSec,
      );
      return true;
    } catch (error: unknown) {
      this.logger.debug(
        {
          chatId,
          userId,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to cache active mute state',
      );
      return false;
    }
  }

  private async rememberInactiveActiveMuteState(chatId: string, userId: string): Promise<void> {
    const setStringWithTtl = (this.redisCounter as Partial<RedisCounterService> | undefined)
      ?.setStringWithTtl;
    if (typeof setStringWithTtl !== 'function') {
      return;
    }

    try {
      await setStringWithTtl.call(
        this.redisCounter,
        buildActiveMuteStateKey(chatId, userId),
        '0',
        ACTIVE_MUTE_NEGATIVE_CACHE_TTL_SEC,
      );
    } catch (error: unknown) {
      this.logger.debug(
        {
          chatId,
          userId,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to cache inactive active mute state',
      );
    }
  }

  private async resolveSystemModeSnapshot(): Promise<SystemModeSnapshot> {
    if (!this.systemModeService) {
      return this.createFallbackSystemModeSnapshot();
    }

    const systemModeService = this.systemModeService as SystemModeService & {
      peekCachedSnapshot?: (maxAgeMs?: number) => SystemModeSnapshot | null;
      getEffectiveSnapshot?: () => Promise<SystemModeSnapshot>;
      getSnapshot?: () => SystemModeSnapshot;
    };
    if (typeof systemModeService.peekCachedSnapshot === 'function') {
      const cachedSnapshot = systemModeService.peekCachedSnapshot(30_000);
      if (cachedSnapshot) {
        return cachedSnapshot;
      }
    }
    if (typeof systemModeService.getEffectiveSnapshot === 'function') {
      return systemModeService.getEffectiveSnapshot();
    }
    if (typeof systemModeService.getSnapshot === 'function') {
      return systemModeService.getSnapshot();
    }

    return this.createFallbackSystemModeSnapshot();
  }

  private createFallbackSystemModeSnapshot(): SystemModeSnapshot {
    return {
      mode: 'normal',
      source: 'auto',
      reason: 'fallback',
      updatedAt: new Date().toISOString(),
      manualMode: null,
      queueLagSec: 0,
      action: {
        windowSec: 60,
        total: 0,
        success: 0,
        failure: 0,
        critical: 0,
        errorRate: 0,
        criticalRate: 0,
      },
    };
  }

  private async resolveBackgroundPressurePauseReason(): Promise<string | null> {
    if (!this.queueMetricsService) {
      return null;
    }

    try {
      const snapshot = await this.queueMetricsService.getOperationalSnapshot({ maxAgeMs: 1_500 });
      const queueLagSec = snapshot.operationalLagSec ?? snapshot.effectiveLagSec;
      if (queueLagSec >= this.backgroundWorkSoftPauseQueueLagSec) {
        return `queue lag ${queueLagSec.toFixed(1)}s`;
      }

      const workerGroups = Object.entries(snapshot.webhookDefaultWorkerGroups).map(
        ([groupName, metrics]) => ({
          groupName,
          pressure:
            metrics.counters.waiting +
            (metrics.counters.prioritized ?? 0) +
            metrics.counters.active * 3,
        }),
      );
      const totalPressure = workerGroups.reduce((sum, item) => sum + item.pressure, 0);
      const primary = workerGroups.reduce(
        (best, current) => (current.pressure > best.pressure ? current : best),
        { groupName: 'n/a', pressure: 0 },
      );
      const share = totalPressure > 0 ? primary.pressure / totalPressure : 0;
      if (
        totalPressure >= this.backgroundWorkSoftPauseWorkerPressure &&
        share >= this.backgroundWorkSoftPauseWorkerShare
      ) {
        return `default worker skew ${primary.groupName} ${primary.pressure}/${totalPressure}`;
      }
    } catch (error: unknown) {
      this.logger.debug(
        { err: error instanceof Error ? error.message : String(error) },
        'Failed to read background pressure snapshot',
      );
    }

    return null;
  }
}

function createWebhookProcessor(
  queueName: AnyWebhookQueueName,
  concurrency: number,
  className: string,
): Type<WorkerHost> {
  @Processor(queueName, {
    concurrency,
  })
  class QueueWebhookProcessor extends WorkerHost {
    constructor(private readonly moderationExecutionService: ModerationExecutionService) {
      super();
    }

    async process(job: Job<ProcessWebhookJob>, token?: string) {
      if (!roleRunsModeration(getAppRole())) {
        return;
      }
      try {
        await this.moderationExecutionService.processWebhookEvent(job.data.webhookEventId);
      } catch (error: unknown) {
        if (error instanceof WebhookOrderedPredecessorPendingError) {
          await deferWebhookOrderedPredecessorJob(job, token, error);
        }
        if (error instanceof WebhookPreparationRetryError) {
          await deferWebhookPreparationJob(job, token, error);
        }
        throw error;
      }
    }
  }
  Object.defineProperty(QueueWebhookProcessor, 'name', {
    value: className,
  });

  return QueueWebhookProcessor as Type<WorkerHost>;
}

export const LegacyModerationProcessor = createWebhookProcessor(
  LEGACY_WEBHOOK_QUEUE,
  LEGACY_MODERATION_CONCURRENCY,
  'LegacyModerationProcessor',
);

export const CriticalWebhookProcessor = createWebhookProcessor(
  WEBHOOK_QUEUE_CRITICAL,
  CRITICAL_MODERATION_CONCURRENCY,
  'CriticalWebhookProcessor',
);

export const JOIN_WEBHOOK_SHARD_PROCESSORS = JOIN_WEBHOOK_QUEUE_NAMES.map((queueName, index) =>
  createWebhookProcessor(
    queueName,
    JOIN_MODERATION_SHARD_CONCURRENCIES[index] ?? 1,
    `JoinWebhookShard${index}Processor`,
  ),
);

export const DEFAULT_WEBHOOK_SHARD_PROCESSORS = DEFAULT_WEBHOOK_QUEUE_NAMES.map(
  (queueName, index) =>
    createWebhookProcessor(
      queueName,
      DEFAULT_MODERATION_SHARD_CONCURRENCIES[index] ?? 1,
      `DefaultWebhookShard${index}Processor`,
    ),
);

export const BackgroundWebhookProcessor = createWebhookProcessor(
  WEBHOOK_QUEUE_BACKGROUND,
  BACKGROUND_MODERATION_CONCURRENCY,
  'BackgroundWebhookProcessor',
);
